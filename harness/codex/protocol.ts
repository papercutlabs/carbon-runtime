// Newline-delimited JSON-RPC over a pair of streams, which is what
// `codex app-server` speaks on stdio. Nothing here knows about Codex methods; it
// knows about framing, request correlation, notifications and the requests the
// server sends back to us.
//
// Two facts shape this file. A JSON-RPC response is matched to its request by id
// and never by arrival order, because the app-server answers out of order. And a
// request the server sends us that we do not answer stalls the turn, so every
// unhandled server request is answered with a method-not-found error rather than
// dropped.

import { fault } from '../../lib/faults.ts';
import type { Readable, Writable } from 'node:stream';

export const PARSE_LIMIT_BYTES = 64 * 1024 * 1024;

// Splits a byte stream into complete lines. Kept separate from the connection so
// the framing can be tested without a process.
export class LineSplitter {
  buffer: string;
  limit: number;
  constructor(limit = PARSE_LIMIT_BYTES) {
    this.buffer = '';
    this.limit = limit;
  }

  // Returns the complete lines in `chunk`, keeping any partial tail for the next
  // call. Empty lines are dropped: the protocol has no meaning for them.
  push(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > this.limit) {
      throw new Error(`a single protocol line exceeded ${this.limit} bytes with no newline`);
    }
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  }
}

export function encode(message: unknown) {
  return JSON.stringify(message) + '\n';
}

// One JSON-RPC message, classified. The connection dispatches on `kind` and the
// test asserts on it, so the classification is a function and not a branch buried
// in the read loop.
export type Classified =
  | { kind: 'malformed'; message: unknown }
  | { kind: 'server-request'; id: unknown; method: string; params: unknown }
  | { kind: 'server-notification'; method: string; params: unknown }
  | { kind: 'error'; id: unknown; error: unknown }
  | { kind: 'response'; id: unknown; result: unknown };

export function classify(message: unknown): Classified {
  if (typeof message !== 'object' || message === null) return { kind: 'malformed', message };
  // A JSON object remains untrusted; these reads classify its existing fields only.
  const fields = message as Record<string, unknown>;
  const hasId = 'id' in fields && fields.id !== null;
  if (typeof fields.method === 'string') {
    return hasId
      ? { kind: 'server-request', id: fields.id, method: fields.method, params: fields.params }
      : { kind: 'server-notification', method: fields.method, params: fields.params };
  }
  if (hasId && 'error' in fields) return { kind: 'error', id: fields.id, error: fields.error };
  if (hasId) return { kind: 'response', id: fields.id, result: fields.result };
  return { kind: 'malformed', message };
}

export class RpcError extends Error {
  method: string;
  rpcError: unknown;
  fault: ReturnType<typeof fault>;
  constructor(method: string, error: unknown) {
    super(`${method} failed: ${error && typeof error === 'object' && 'message' in error ? error.message : JSON.stringify(error)}`);
    this.name = 'RpcError';
    this.method = method;
    this.rpcError = error;
    this.fault = fault('HARNESS_RPC_ERROR', method,
      `the app-server answered ${method} with ${JSON.stringify(error)}`,
      'read the app-server stderr this run recorded; a protocol mismatch means the pinned version moved');
  }
}

// A connection over any duplex pair. `output` is what we write to (the child's
// stdin) and `input` is what we read from (the child's stdout).
export class Connection {
  output: Writable;
  onWire: (direction: string, line: string) => void;
  nextId: number;
  pending: Map<unknown, { method: string; resolve: (value: unknown) => void; reject: (reason: unknown) => void }>;
  splitter: LineSplitter;
  onNotification: (method: string, params: unknown) => void;
  onServerRequest: (method: string, params: unknown) => unknown;
  onUnparsable: (line: string) => void;
  closed: unknown;
  constructor({ input, output, onNotification, onServerRequest, onUnparsable, onWire }: {
    input: Readable; output: Writable;
    onNotification?: (method: string, params: unknown) => void;
    onServerRequest?: (method: string, params: unknown) => unknown;
    onUnparsable?: (line: string) => void;
    onWire?: (direction: string, line: string) => void;
  }) {
    this.output = output;
    // Every line in both directions, when a caller wants the wire itself. This is
    // how a verification record gets exact request and response text rather than a
    // re-serialised summary of it.
    this.onWire = onWire ?? (() => {});
    this.nextId = 1;
    this.pending = new Map();
    this.splitter = new LineSplitter();
    this.onNotification = onNotification ?? (() => {});
    // Returns a result to answer with, or undefined to refuse the request.
    this.onServerRequest = onServerRequest ?? (() => undefined);
    this.onUnparsable = onUnparsable ?? (() => {});
    this.closed = null;

    input.setEncoding('utf8');
    input.on('data', (chunk) => this.#read(chunk));
    input.on('close', () => this.#fail(new Error('the app-server closed its output stream')));
  }

  #read(chunk: string) {
    let lines;
    try {
      lines = this.splitter.push(chunk);
    } catch (error) {
      this.#fail(error);
      return;
    }
    for (const line of lines) {
      this.onWire('in', line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.onUnparsable(line);
        continue;
      }
      this.#dispatch(classify(message));
    }
  }

  #dispatch(event: Classified) {
    if (event.kind === 'response' || event.kind === 'error') {
      const waiter = this.pending.get(event.id);
      if (!waiter) return;
      this.pending.delete(event.id);
      if (event.kind === 'error') waiter.reject(new RpcError(waiter.method, event.error));
      else waiter.resolve(event.result);
      return;
    }
    if (event.kind === 'server-notification') {
      this.onNotification(event.method, event.params);
      return;
    }
    if (event.kind === 'server-request') {
      let result;
      try {
        result = this.onServerRequest(event.method, event.params);
      } catch {
        result = undefined;
      }
      if (result === undefined) {
        this.send({
          id: event.id,
          error: { code: -32601, message: `carbon's Codex harness does not answer ${event.method}` }
        });
      } else {
        this.send({ id: event.id, result });
      }
      return;
    }
    this.onUnparsable(JSON.stringify(event.message));
  }

  #fail(error: unknown) {
    this.closed = error;
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(error);
    }
  }

  send(message: Record<string, unknown>) {
    const line = encode({ jsonrpc: '2.0', ...message });
    this.onWire('out', line.trimEnd());
    this.output.write(line);
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ id, method, params });
    });
  }
}
