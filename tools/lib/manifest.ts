// `tool-server.json`, the manifest beside a client tool server. It is what
// `carbon tool check` reads, what `--help` renders from, and what the MCP
// handshake advertises, so there is one description of a tool and not three.
//
//   {
//     "schema": "carbon.tool-server.v1",
//     "name": "examplecorp-crm",
//     "version": "1",
//     "entry": "server.mjs",
//     "transport": "stdio" | "http",
//     "secrets": ["examplecorp_api_credentials"],
//     "tools": [{
//       "name": "read_account",
//       "description": "...",
//       "arguments": {"type": "object", "properties": {...}, "required": [...],
//                     "additionalProperties": false},
//       "returns": {"what": "...", "fields": [{"name": "id", "what": "..."}]},
//       "readOnlyHint": true,
//       "writes": false
//     }]
//   }

import fs from 'node:fs';
import path from 'node:path';
import { fault, refuseAll } from './fault.ts';
import { checkSchema } from './args.ts';

export const MANIFEST_FILE = 'tool-server.json';
export const SCHEMA_ID = 'carbon.tool-server.v1';

const MANIFEST_KEYS = new Set(['schema', 'name', 'version', 'entry', 'transport', 'secrets', 'tools']);
const TOOL_KEYS = new Set(['name', 'description', 'arguments', 'returns', 'readOnlyHint', 'writes']);
const NAME = /^[a-z][a-z0-9_]*$/;
export type ToolSpec = {
  name: string; description: string; arguments: unknown;
  returns: { what: string; fields: { name: string; what: string }[] };
  readOnlyHint: boolean; writes: boolean;
};
export type ManifestSpec = {
  name: string; version: string; entry: string; transport: string; tools: ToolSpec[];
};

export function manifestPath(serverDir: string) {
  return path.join(serverDir, MANIFEST_FILE);
}

// This function only parses JSON. Existing callers inspect its unchecked
// fields before checkManifest runs, so the dynamic boundary stays `any` here.
export function readManifest(serverDir: string): any {
  const file = manifestPath(serverDir);
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // fs errors normally carry message; retain the old property read for other thrown values.
    const detail = error as { message?: string };
    refuseAll([fault('MANIFEST_UNREADABLE', file, detail.message,
      `write ${MANIFEST_FILE} beside the server; carbon-core/tools/client-tool-reference.md section 3 gives its shape`)]);
  }
  try {
    // The catch above always throws its single fault, so text is assigned here.
    return JSON.parse(text!);
  } catch (error) {
    // JSON.parse normally throws SyntaxError; retain the original message read.
    const detail = error as { message?: string };
    refuseAll([fault('MANIFEST_UNPARSEABLE', file, detail.message, 'write valid JSON')]);
  }
  return null;
}

// Every fault the manifest carries, together. Returns a list; the caller decides
// whether to throw (a server at startup) or print (`carbon tool check`).
export function checkManifest(manifest: unknown, at = MANIFEST_FILE) {
  const faults = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [fault('MANIFEST_NOT_AN_OBJECT', at, 'the manifest is one JSON object', 'see the reference')];
  }
  const document = manifest as Record<string, unknown>; // The guard proves object access only.
  for (const key of Object.keys(document)) {
    if (!MANIFEST_KEYS.has(key)) {
      faults.push(fault('MANIFEST_KEY_UNDECLARED', `${at}.${key}`,
        `${key} is not a field of ${SCHEMA_ID}; an undeclared field is a field nobody reads`,
        `use only ${[...MANIFEST_KEYS].join(', ')}`));
    }
  }
  if (document.schema !== SCHEMA_ID) {
    faults.push(fault('MANIFEST_SCHEMA_WRONG', `${at}.schema`,
      `the manifest declares ${JSON.stringify(document.schema ?? null)} and this is ${SCHEMA_ID}`,
      `set "schema": "${SCHEMA_ID}"`));
  }
  for (const key of ['name', 'version', 'entry']) {
    if (typeof document[key] !== 'string' || document[key].trim() === '') {
      faults.push(fault('MANIFEST_FIELD_MISSING', `${at}.${key}`,
        `${key} is required and nothing sensible can be guessed for it`,
        key === 'entry' ? 'name the file the harness starts, relative to the server directory' : `set ${key}`));
    }
  }
  if (document.transport !== 'stdio' && document.transport !== 'http') {
    faults.push(fault('MANIFEST_TRANSPORT_WRONG', `${at}.transport`,
      'the lowest common denominator is stdio or streamable http on loopback, and nothing else',
      'set "transport" to "stdio" or "http"'));
  }
  const secrets = document.secrets;
  if (secrets !== undefined && !(Array.isArray(secrets) && secrets.every((s) => typeof s === 'string'))) {
    faults.push(fault('MANIFEST_SECRETS_WRONG', `${at}.secrets`,
      'secrets is the list of secret names this server holds, as declared in the client declaration',
      'write ["<secret name>"], or [] when the server holds none'));
  } else if (Array.isArray(secrets) && secrets.length > 0 && document.transport === 'stdio') {
    faults.push(fault('STDIO_SERVER_HOLDS_SECRET', `${at}.secrets`,
      "a stdio server is started by the harness as the agent user, so a secret it holds is readable by the model's own shell",
      'set "transport": "http"; the runtime starts a secret-holding server as the tools user on loopback'));
  }

  const tools = document.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    faults.push(fault('MANIFEST_NO_TOOLS', `${at}.tools`,
      'a tool server declares at least one tool',
      'declare each tool as {name, description, arguments, returns, readOnlyHint, writes}'));
    return faults;
  }

  const seen = new Set();
  for (const [i, tool] of tools.entries()) {
    const where = `${at}.tools[${i}]`;
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      faults.push(fault('TOOL_NOT_AN_OBJECT', where, 'each tool is one JSON object', 'see the reference'));
      continue;
    }
    const entry = tool as Record<string, unknown>; // The guard proves only keyed access.
    for (const key of Object.keys(entry)) {
      if (!TOOL_KEYS.has(key)) {
        if (key === 'annotations') {
          faults.push(fault('ANNOTATION_BEYOND_READ_ONLY_HINT', `${where}.annotations`,
            'readOnlyHint is the only annotation the lowest common denominator carries; destructiveHint, idempotentHint and openWorldHint are dropped by a harness that does not read them, and a dropped safety hint reads as safe',
            'declare readOnlyHint on the tool and put safety classification in the declaration, not in an annotation'));
        } else {
          faults.push(fault('TOOL_KEY_UNDECLARED', `${where}.${key}`,
            `${key} is not a field of a ${SCHEMA_ID} tool`,
            `use only ${[...TOOL_KEYS].join(', ')}`));
        }
      }
    }
    if (typeof entry.name !== 'string' || !NAME.test(entry.name)) {
      faults.push(fault('TOOL_NAME_WRONG', `${where}.name`,
        'a tool name is lower case with underscores, so it is the same word in every harness',
        'name it like read_account'));
    } else if (seen.has(entry.name)) {
      faults.push(fault('TOOL_NAME_REPEATED', `${where}.name`,
        `two tools are named ${entry.name}`, 'give each tool one name'));
    } else {
      seen.add(entry.name);
    }
    if (typeof entry.description !== 'string' || entry.description.trim().length < 20) {
      faults.push(fault('TOOL_UNDESCRIBED', `${where}.description`,
        'the description is what a caller reads to decide whether this is the tool; a name is not a description',
        'say what it does, what it returns, and when not to use it'));
    }
    if (typeof entry.readOnlyHint !== 'boolean') {
      faults.push(fault('READ_ONLY_HINT_MISSING', `${where}.readOnlyHint`,
        'every tool says whether it only reads; it is the one annotation that survives every harness',
        'set readOnlyHint true or false'));
    }
    if (typeof entry.writes !== 'boolean') {
      faults.push(fault('WRITES_MISSING', `${where}.writes`,
        'every tool says whether it writes to the client system, because a write goes through the declaration write gate',
        'set writes true or false'));
    }
    if (entry.readOnlyHint === true && entry.writes === true) {
      faults.push(fault('READ_ONLY_HINT_CONTRADICTED', `${where}.readOnlyHint`,
        'this tool is declared read only and declared to write',
        'set readOnlyHint false on a tool that writes'));
    }
    faults.push(...checkSchema(entry.arguments, `${where}.arguments`));
    faults.push(...checkReturns(entry.returns, `${where}.returns`));
  }
  return faults;
}

function checkReturns(returns: unknown, at: string) {
  const faults = [];
  if (!returns || typeof returns !== 'object' || Array.isArray(returns)) {
    return [fault('OVER_WIDE_RETURN', at,
      'no returns section, so nothing says what this tool gives back and the caller is handed whatever the upstream system said',
      'declare {"what": "...", "fields": [{"name": "...", "what": "..."}]} and build the return with shapeReturn')];
  }
  const result = returns as Record<string, unknown>; // The guard proves only keyed access.
  if (typeof result.what !== 'string' || result.what.trim() === '') {
    faults.push(fault('RETURNS_UNDESCRIBED', `${at}.what`,
      'one sentence says what the caller is holding after this call',
      'write it'));
  }
  if (!Array.isArray(result.fields) || result.fields.length === 0) {
    faults.push(fault('OVER_WIDE_RETURN', `${at}.fields`,
      'the fields the caller gets are not named, so the return is whatever the upstream object happened to hold',
      'name each field as {"name": "...", "what": "..."} and build the return with shapeReturn'));
    return faults;
  }
  for (const [i, field] of result.fields.entries()) {
    if (!field || typeof field !== 'object' || typeof field.name !== 'string'
        || typeof field.what !== 'string' || field.what.trim() === '') {
      faults.push(fault('RETURNS_FIELD_WRONG', `${at}.fields[${i}]`,
        'each returned field is {"name": "...", "what": "..."}',
        'name the field and say what it means'));
    }
  }
  return faults;
}

// The only sanctioned way to build a return: exactly the fields the manifest
// names, and nothing else. A raw upstream object is never the return.
export function shapeReturn(tool: ToolSpec, source: unknown) {
  const out: Record<string, unknown> = {};
  for (const field of tool.returns.fields) {
    if (source && typeof source === 'object' && field.name in source) out[field.name] = (source as Record<string, unknown>)[field.name]; // The object and `in` checks prove keyed access.
    else out[field.name] = null;
  }
  return out;
}

export function loadManifest(serverDir: string) {
  const manifest = readManifest(serverDir);
  refuseAll(checkManifest(manifest));
  return manifest;
}
