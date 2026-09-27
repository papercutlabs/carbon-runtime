// The MCP server scaffold, implementing exactly the lowest common denominator the
// harness research pinned and nothing beyond it:
//
//   transports   stdio, and streamable http on loopback only
//   handshake    advertise 2025-06-18, accept down to 2024-11-05
//   methods      initialize, notifications/initialized, tools/list, tools/call
//   results      one text content block with a JSON copy in structuredContent
//   annotations  readOnlyHint, and no other
//
// What is lost is accepted on purpose: typed results, destructive and idempotent
// hints, resource templates, roots, progress and completion. A tool written to a
// richer surface silently loses those on a harness that does not carry them, and
// a dropped safety hint reads as safe.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import readline from 'node:readline';
import { asFaults, faultText } from './fault.ts';
import { parseArguments } from './args.ts';
import { checkManifest, shapeReturn } from './manifest.ts';

export const ADVERTISED_PROTOCOL = '2025-06-18';
export const ACCEPTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// JSON-RPC request fields as they arrive. Presence is not a protocol check.
type RpcMessage = {
  jsonrpc?: unknown;
  method?: unknown;
  id?: unknown;
  params?: unknown;
};
type RpcParams = {
  protocolVersion?: unknown;
  name?: unknown;
  arguments?: unknown;
};
// Fields createServer reads after checkManifest. This is not a second validator.
type ManifestTool = {
  name: string;
  description: unknown;
  arguments: unknown;
  returns: { what: unknown; fields: Array<{ name: unknown; what: unknown }> };
  readOnlyHint: unknown;
};
type ServableManifest = {
  name: unknown;
  version: unknown;
  tools: ManifestTool[];
};
// parseArguments returns leftover named values as Record<string, unknown>.
// createServer passes its context argument through as unknown. This is the
// unvalidated call boundary: a handler may treat both as unknown, and a
// handler that requires a narrower args or context object is not assignable
// under strictFunctionTypes, because this server never proves those shapes.
type RegisteredHandler = (args: Record<string, unknown>, context: unknown) => unknown;
type CreateServerOptions = {
  manifest: unknown;
  handlers: Record<string, RegisteredHandler>;
  context?: unknown;
};
type Produced = { data?: unknown; text?: unknown };
type Handle = (message: unknown) => Promise<unknown>;
type StdioOptions = { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream };
type HttpOptions = { host?: string; port?: number; path?: string };

// handlers is {<tool name>: async (args, context) => object | {data, text}}.
export function createServer({ manifest, handlers, context = {} }: CreateServerOptions) {
  const manifestFaults = checkManifest(manifest);
  if (manifestFaults.length > 0) {
    throw new Error(`the manifest is not servable:\n${faultText(manifestFaults)}`);
  }
  // Remaining field reads follow the check above; they do not re-validate JSON.
  const servable = manifest as ServableManifest;
  for (const tool of servable.tools) {
    if (typeof handlers[tool.name] !== 'function') {
      throw new Error(`the manifest declares ${tool.name} and no handler implements it`);
    }
  }
  for (const name of Object.keys(handlers)) {
    if (!servable.tools.some((t) => t.name === name)) {
      throw new Error(`${name} is implemented and not declared in the manifest`);
    }
  }

  const byName = new Map(servable.tools.map((t) => [t.name, t]));

  async function handle(message: unknown) {
    const req = message as RpcMessage | null | undefined;
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return error(req && req.id !== undefined ? req.id : null, -32600,
        'not a JSON-RPC 2.0 request');
    }
    const { id, method, params } = req;
    const isNotification = id === undefined;
    const rpcParams = params as RpcParams | null | undefined;

    if (method === 'initialize') {
      const asked = rpcParams && typeof rpcParams.protocolVersion === 'string' ? rpcParams.protocolVersion : null;
      return ok(id, {
        protocolVersion: ACCEPTED_PROTOCOLS.includes(asked as string) ? asked : ADVERTISED_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: servable.name, version: servable.version }
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return isNotification ? null : ok(id, {});

    if (method === 'tools/list') {
      return ok(id, {
        tools: servable.tools.map((tool) => ({
          name: tool.name,
          description: describe(tool),
          inputSchema: tool.arguments,
          annotations: { readOnlyHint: tool.readOnlyHint }
        }))
      });
    }

    if (method === 'tools/call') {
      const name = rpcParams && rpcParams.name;
      const tool = byName.get(name as string);
      // An unknown tool is a bad call, so it fails at the protocol. A bad
      // argument is something the model can correct, so it comes back as content.
      if (!tool) {
        return error(id, -32602, `no tool named ${JSON.stringify(name ?? null)}; call tools/list`);
      }
      try {
        const args = parseArguments(tool.arguments, rpcParams!.arguments, `${tool.name} arguments`);
        // args is the leftover Record from parseArguments; context is still unknown.
        const produced = await (handlers[tool.name])(args, context);
        const producedRec = produced as Produced | null | undefined;
        const raw = producedRec && typeof producedRec === 'object' && 'data' in producedRec ? producedRec.data : produced;
        const data = shapeReturn(tool, raw);
        const text = producedRec && typeof producedRec === 'object' && typeof producedRec.text === 'string'
          ? producedRec.text
          : renderText(tool, data);
        return ok(id, {
          content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data, null, 2)}` }],
          structuredContent: data,
          isError: false
        });
      } catch (thrown) {
        const faults = asFaults(thrown);
        return ok(id, {
          content: [{ type: 'text', text: `${tool.name} refused.\n\n${faultText(faults)}\n\n${JSON.stringify({ faults }, null, 2)}` }],
          structuredContent: { faults },
          isError: true
        });
      }
    }

    if (isNotification) return null;
    return error(id, -32601, `${method} is not implemented; this server carries tools/list and tools/call only`);
  }

  return { manifest, handle, serveStdio: () => serveStdio(handle), serveHttp: (o?: HttpOptions) => serveHttp(handle, o) };
}

function describe(tool: ManifestTool) {
  const fields = tool.returns.fields.map((f) => `${f.name} (${f.what})`).join('; ');
  return `${tool.description}\n\nReturns ${tool.returns.what} Fields: ${fields}.`;
}

function renderText(tool: ManifestTool, data: Record<string, unknown>) {
  const lines = [`${tool.name}: ${tool.returns.what}`];
  for (const field of tool.returns.fields) {
    const value = data[field.name as string];
    lines.push(`  ${field.name}: ${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`);
  }
  return lines.join('\n');
}

function ok(id: unknown, result: unknown) { return { jsonrpc: '2.0', id, result }; }
function error(id: unknown, code: number, message: string) { return { jsonrpc: '2.0', id, error: { code, message } }; }

// stdio: one JSON-RPC message per line, in and out. No framing header, which is
// what every harness on this transport reads today.
export function serveStdio(handle: Handle, { input = process.stdin, output = process.stdout }: StdioOptions = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    queue = queue.then(async () => {
      let message = null;
      try { message = JSON.parse(line); } catch {
        output.write(JSON.stringify(error(null, -32700, 'the line is not JSON')) + '\n');
        return;
      }
      const response = await handle(message);
      if (response !== null) output.write(JSON.stringify(response) + '\n');
    });
  });
  return new Promise((resolve) => lines.on('close', () => queue.then(resolve)));
}

// Streamable http, the loopback half only: one POST carries one JSON-RPC message
// and the response comes back as JSON. There is no SSE stream and no session
// resumption, because a client tool server has nothing to stream. The bind
// address is loopback and a request from anywhere else never arrives.
export function serveHttp(handle: Handle, { host = '127.0.0.1', port, path = '/mcp' }: HttpOptions = {}) {
  if (!LOOPBACK.has(host)) {
    throw new Error(`a tool server binds loopback only, and ${host} is not loopback`);
  }
  // port is optional at the type boundary; the runtime still refuses a missing one.
  if (!Number.isInteger(port as number)) throw new Error('serveHttp needs an explicit port');

  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url as string, `http://${host}`);
    if (url.pathname !== path) return send(response, 404, { error: 'no such path' });
    // DNS rebinding: a browser on the box could otherwise post here.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      let originHost: string | null = null;
      try { originHost = new URL(origin as string).hostname; } catch { originHost = null; }
      if (!LOOPBACK.has(originHost as string)) return send(response, 403, { error: 'origin refused' });
    }
    if (request.method === 'GET') {
      return send(response, 405, { error: 'this server carries POST only; there is no event stream' });
    }
    if (request.method !== 'POST') return send(response, 405, { error: 'POST only' });

    let body = '';
    let tooBig = false;
    request.on('data', (chunk) => {
      // data chunks still concatenate through +=; Buffer is stringified at runtime as before.
      body += chunk as unknown as string;
      if (body.length > 4 * 1024 * 1024 && !tooBig) { tooBig = true; request.destroy(); }
    });
    request.on('end', async () => {
      if (tooBig) return;
      let message = null;
      try { message = JSON.parse(body); } catch {
        return send(response, 400, error(null, -32700, 'the body is not JSON'));
      }
      const result = await handle(message);
      if (result === null) { response.writeHead(202).end(); return; }
      send(response, 200, result);
    });
  });

  return new Promise<{ server: http.Server; url: string }>((resolve) => {
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${port}${path}` }));
  });
}

function send(response: ServerResponse, status: number, payload: unknown) {
  const text = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}
