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

import { fault } from '../../lib/faults.mjs';

export const PARSE_LIMIT_BYTES = 64 * 1024 * 1024;

// Splits a byte stream into complete lines. Kept separate from the connection so
// the framing can be tested without a process.
export class LineSplitter {
  constructor(limit = PARSE_LIMIT_BYTES) {
    this.buffer = '';
    this.limit = limit;
  }

  // Returns the complete lines in `chunk`, keeping any partial tail for the next
  // call. Empty lines are dropped: the protocol has no meaning for them.
  push(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > this.limit) {
      throw new Error(`a single protocol line exceeded ${this.limit} bytes with no newline`);
    }
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop();
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  }
}

export function encode(message) {
  return JSON.stringify(message) + '\n';
}

// One JSON-RPC message, classified. The connection dispatches on `kind` and the
// test asserts on it, so the classification is a function and not a branch buried
// in the read loop.
export function classify(message) {
  if (typeof message !== 'object' || message === null) return { kind: 'malformed', message };
  const hasId = 'id' in message && message.id !== null;
  if (typeof message.method === 'string') {
    return hasId
      ? { kind: 'server-request', id: message.id, method: message.method, params: message.params }
      : { kind: 'server-notification', method: message.method, params: message.params };
  }
  if (hasId && 'error' in message) return { kind: 'error', id: message.id, error: message.error };
  if (hasId) return { kind: 'response', id: message.id, result: message.result };
  return { kind: 'malformed', message };
}

export class RpcError extends Error {
  constructor(method, error) {
    super(`${method} failed: ${error?.message ?? JSON.stringify(error)}`);
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
  constructor({ input, output, onNotification, onServerRequest, onUnparsable, onWire }) {
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

  #read(chunk) {
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

  #dispatch(event) {
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

  #fail(error) {
    this.closed = error;
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(error);
    }
  }

  send(message) {
    const line = encode({ jsonrpc: '2.0', ...message });
    this.onWire('out', line.trimEnd());
    this.output.write(line);
  }

  notify(method, params) {
    this.send({ method, params });
  }

  request(method, params) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ id, method, params });
    });
  }
}
