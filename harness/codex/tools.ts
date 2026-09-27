// tools — the fifth of the six operations. Renders the declaration's tool_servers
// into the `config.toml` the app-server reads out of CODEX_HOME, then reads the
// startup status back over the protocol and stays subscribed to it.
//
// The split the plan rules is carried in the renderer: a stdio server is started by
// the harness as the agent user and may hold no secret, so a stdio entry with a
// secret_ref is refused here rather than rendered; a server that holds a secret is
// http on loopback, started by the runtime as the tools user, so its entry carries
// a url and nothing else and the secret never enters this file.
//
// Every rendered server also carries `default_tools_approval_mode = "approve"`,
// and that line is what makes a client agent able to act at all. Verified on
// 0.153.4 (harness/codex/verifications/20260910-mcp-tool-approval.md): a tool
// whose MCP annotation says it is not read-only is refused outright under
// `approvalPolicy: "never"`, with "MCP tool call requires approval, but approval
// policy is never", and there is nobody at the keyboard to ask. The alternative
// is annotating a tool that writes as read-only, which is a lie told to every
// harness that reads the hint. So the declaration's own list is the grant: a
// server carbon rendered is a server a person put in the declaration, and what
// its writes may touch is the declaration's write_gate, checked inside the tool.

import fs from 'node:fs';
import { fault } from '../../lib/faults.ts';

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

// The declaration is the grant. See the note above and the verification record.
export const APPROVAL_MODE = 'approve';

// Untrusted declaration and tool-status JSON. The indexer is not a validator.
function fields(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

function tomlKey(name: unknown) {
  return BARE_KEY.test(name as string) ? name as string : JSON.stringify(name);
}

function tomlString(value: unknown) {
  return JSON.stringify(String(value));
}

type ToolServer = {
  name?: unknown;
  secret_refs?: unknown;
  transport?: unknown;
  command?: unknown;
  cwd?: unknown;
  url?: unknown;
  required?: unknown;
  runtimeStatus?: unknown;
};

type FaultRecord = { code: string; subject: string; problem: string; fix: string };

type SessionRequest = { request: (method: string, params?: unknown) => Promise<unknown> };

// Returns { toml, faults }. Every fault in the declaration's tool_servers is
// collected, so one render tells the caller everything that is wrong.
export function renderConfigToml(declaration: unknown, { header = true }: { header?: boolean } = {}) {
  const faults: FaultRecord[] = [];
  const rec = fields(declaration);
  const servers = rec?.tool_servers ?? [];
  const declaredSecrets = new Set(((rec?.secrets ?? []) as { name?: unknown }[]).map((s) => s.name));
  const lines = [];

  if (header) {
    lines.push('# Rendered by carbon from the agent declaration. Every value here comes from');
    lines.push('# carbon.agent.json; nothing is hand-edited on the box, because the next install');
    lines.push('# overwrites this file. Model, effort, sandbox and approval policy are not here:');
    lines.push('# they are sent over the app-server protocol at thread/start and on every turn.');
    lines.push('');
  }

  const seen = new Set();
  for (const server of servers as ToolServer[]) {
    const name = server?.name;
    if (!name) {
      faults.push(fault('TOOL_SERVER_UNNAMED', 'tool_servers[]',
        'a tool server has no name, and the name is how startup status is reported',
        'give every tool server a name'));
      continue;
    }
    if (seen.has(name)) {
      faults.push(fault('TOOL_SERVER_NAME_REPEATED', `tool_servers.${name}`,
        'two tool servers carry one name, and the second would silently replace the first',
        'give each tool server its own name'));
      continue;
    }
    seen.add(name);

    for (const ref of (server.secret_refs ?? []) as unknown[]) {
      if (!declaredSecrets.has(ref)) {
        faults.push(fault('TOOL_SERVER_SECRET_UNDECLARED', `tool_servers.${name}.secret_refs`,
          `the server names the secret ${JSON.stringify(ref)} and the declaration does not declare it`,
          'add the secret to secrets with its absolute path, or drop the reference'));
      }
    }

    if (server.transport === 'stdio') {
      if (!server.command) {
        faults.push(fault('TOOL_SERVER_COMMAND_ABSENT', `tool_servers.${name}`,
          'a stdio tool server was declared with no command',
          'give the absolute path of the command that starts the server'));
        continue;
      }
      // command was truthy; startsWith is the runtime relative-path check.
      if (!(server.command as string).startsWith('/')) {
        faults.push(fault('TOOL_SERVER_COMMAND_RELATIVE', `tool_servers.${name}.command`,
          `${tomlString(server.command)} is relative, and what a relative command resolves to depends on who started the harness`,
          'give the absolute path'));
        continue;
      }
      if (((server.secret_refs ?? []) as unknown[]).length > 0) {
        faults.push(fault('TOOL_SERVER_STDIO_HOLDS_SECRET', `tool_servers.${name}`,
          'a stdio server runs as the agent user, which the model\'s own shell also runs as, so a secret it holds is a secret the model can read',
          'make this server transport http on loopback, started by the runtime as the tools user'));
        continue;
      }
      lines.push(`[mcp_servers.${tomlKey(name)}]`);
      lines.push(`command = ${tomlString(server.command)}`);
      if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`);
      lines.push('enabled = true');
      lines.push(`default_tools_approval_mode = ${tomlString(APPROVAL_MODE)}`);
      // The environment of a stdio server is built from empty. An empty table says
      // so on the page, rather than leaving the reader to infer it from silence.
      lines.push('');
      lines.push(`[mcp_servers.${tomlKey(name)}.env]`);
      lines.push('');
      continue;
    }

    if (server.transport === 'http') {
      if (!server.url) {
        faults.push(fault('TOOL_SERVER_URL_ABSENT', `tool_servers.${name}`,
          'an http tool server was declared with no url',
          'give the loopback url the runtime starts the server on'));
        continue;
      }
      lines.push(`[mcp_servers.${tomlKey(name)}]`);
      lines.push(`url = ${tomlString(server.url)}`);
      lines.push('enabled = true');
      lines.push(`default_tools_approval_mode = ${tomlString(APPROVAL_MODE)}`);
      lines.push('');
      continue;
    }

    faults.push(fault('TOOL_SERVER_TRANSPORT_UNKNOWN', `tool_servers.${name}.transport`,
      `${JSON.stringify(server.transport)} is neither stdio nor http, and carbon targets the lowest common denominator only`,
      'declare transport as stdio or http'));
  }

  return { toml: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', faults };
}

export function writeConfigToml(declaration: unknown, destination: fs.PathOrFileDescriptor) {
  const { toml, faults } = renderConfigToml(declaration);
  if (faults.length) return { written: false, faults };
  fs.writeFileSync(destination, toml, { mode: 0o600 });
  return { written: true, faults: [], toml };
}

// Reads every page of mcpServerStatus/list. The protocol pages this list, and a
// single page read as the whole list is how a required server goes missing.
export async function listToolServerStatus(session: unknown, { threadId }: { threadId?: unknown } = {}) {
  const servers: unknown[] = [];
  let cursor = null;
  do {
    const params: Record<string, unknown> = {};
    if (threadId) params.threadId = threadId;
    if (cursor) params.cursor = cursor;
    // Live sessions expose request(); the runtime Harness Session type does not name it.
    const page = await (session as SessionRequest).request('mcpServerStatus/list', params);
    const rec = fields(page);
    servers.push(...((rec?.data ?? []) as unknown[]));
    cursor = rec?.nextCursor ?? null;
  } while (cursor);
  // Untrusted list pages; Status is the caller-read shape, not a name-was-string check.
  return servers as { name: string; runtimeStatus?: string | null }[];
}

// A required server that is not connected holds release, named. The runtime calls
// this after initialize and again on every mcpServer/startupStatus/updated event,
// so a server that dies at hour three re-raises the hold.
//
// Verified on 0.153.4 (harness/codex/verifications/20260910-tool-servers.md):
// `runtimeStatus` is null when the list is read with no thread id, because the
// runtime connection belongs to a thread. A null is therefore "not known", not
// "down", and it gets its own fault: reading it as down would hold every release
// on a box whose servers are all healthy.
export function holdsRelease(declaration: unknown, statuses: unknown) {
  const required = new Set(((fields(declaration)?.tool_servers ?? []) as ToolServer[]).filter((s) => s.required).map((s) => s.name));
  const byName = new Map((statuses as ToolServer[]).map((s) => [s.name, s]));
  const faults: FaultRecord[] = [];
  for (const name of [...required].sort()) {
    const status = byName.get(name);
    if (!status) {
      faults.push(fault('TOOL_SERVER_REQUIRED_ABSENT', `tool_servers.${name}`,
        'the declaration marks this server required and the app-server does not list it at all',
        'check that install rendered this server into config.toml, and that the name matches'));
      continue;
    }
    const state = status.runtimeStatus ?? null;
    if (state === null) {
      faults.push(fault('TOOL_SERVER_STATE_UNAVAILABLE', `tool_servers.${name}`,
        'the app-server reports no runtime state for this server, which is what it does when the list is read without a thread id',
        'read mcpServerStatus/list with the unit\'s threadId; the runtime connection belongs to a thread'));
      continue;
    }
    if (state !== 'connected') {
      faults.push(fault('TOOL_SERVER_REQUIRED_DOWN', `tool_servers.${name}`,
        `the declaration marks this server required and it reports ${JSON.stringify(state)}`,
        'start the server, or drop required in the declaration if the agent can work without it'));
    }
  }
  return faults;
}

type StatusStream = {
  onEvent: (event: { kind?: unknown; [key: string]: unknown }) => unknown;
};

// The subscription. mcpServer/startupStatus/updated is a notification, so there is
// nothing to subscribe to beyond listening; this names the listening so the caller
// does not reach into the event stream by method name.
export function onToolServerStatus(session: unknown, handler: (event?: { kind?: unknown; [key: string]: unknown }) => unknown) {
  const current = session as { stream: StatusStream };
  const previous = current.stream.onEvent;
  current.stream.onEvent = (event) => {
    previous(event);
    if (event.kind === 'tool_server.status') handler(event);
  };
  return () => { current.stream.onEvent = previous; };
}
