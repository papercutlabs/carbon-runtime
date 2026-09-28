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

// Untrusted JSON fields this module reads by name. Not a passed-validation type.
type Thrown = { message?: unknown };
type ReturnField = { name?: unknown; what?: unknown };
type ReturnsSection = { what?: unknown; fields?: unknown };
// Public shapeReturn walks tool.returns.fields as the original property path.
// Presence is not checked; a missing returns or fields still throws at that read.
type ShapeTool = { returns: { fields: Iterable<{ name?: unknown }> } };

export function manifestPath(serverDir: string) {
  return path.join(serverDir, MANIFEST_FILE);
}

export function readManifest(serverDir: string) {
  const file = manifestPath(serverDir);
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // Catch binding is unknown. .message is read as the original field access;
    // it is not a string check. A non-string or missing message still reaches
    // fault(), which refuses a non-string problem; a throwing getter still throws.
    refuseAll([fault('MANIFEST_UNREADABLE', file, (error as Thrown).message as string,
      `write ${MANIFEST_FILE} beside the server; carbon-core/tools/client-tool-reference.md section 3 gives its shape`)]);
  }
  try {
    // Unreadable files already refused, so text is the file body when parse runs.
    return JSON.parse(text as string);
  } catch (error) {
    // Same catch as above: .message is untrusted and uncoerced; fault() still
    // type-checks the problem at runtime the way the original call did.
    refuseAll([fault('MANIFEST_UNPARSEABLE', file, (error as Thrown).message as string, 'write valid JSON')]);
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
  // The preceding object guard permits these named manifest reads; every field is checked below.
  const rec = manifest as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!MANIFEST_KEYS.has(key)) {
      faults.push(fault('MANIFEST_KEY_UNDECLARED', `${at}.${key}`,
        `${key} is not a field of ${SCHEMA_ID}; an undeclared field is a field nobody reads`,
        `use only ${[...MANIFEST_KEYS].join(', ')}`));
    }
  }
  if (rec.schema !== SCHEMA_ID) {
    faults.push(fault('MANIFEST_SCHEMA_WRONG', `${at}.schema`,
      `the manifest declares ${JSON.stringify(rec.schema ?? null)} and this is ${SCHEMA_ID}`,
      `set "schema": "${SCHEMA_ID}"`));
  }
  for (const key of ['name', 'version', 'entry']) {
    if (typeof rec[key] !== 'string' || rec[key].trim() === '') {
      faults.push(fault('MANIFEST_FIELD_MISSING', `${at}.${key}`,
        `${key} is required and nothing sensible can be guessed for it`,
        key === 'entry' ? 'name the file the harness starts, relative to the server directory' : `set ${key}`));
    }
  }
  if (rec.transport !== 'stdio' && rec.transport !== 'http') {
    faults.push(fault('MANIFEST_TRANSPORT_WRONG', `${at}.transport`,
      'the lowest common denominator is stdio or streamable http on loopback, and nothing else',
      'set "transport" to "stdio" or "http"'));
  }
  const secrets = rec.secrets;
  if (secrets !== undefined && !(Array.isArray(secrets) && secrets.every((s) => typeof s === 'string'))) {
    faults.push(fault('MANIFEST_SECRETS_WRONG', `${at}.secrets`,
      'secrets is the list of secret names this server holds, as declared in the client declaration',
      'write ["<secret name>"], or [] when the server holds none'));
  } else if (Array.isArray(secrets) && secrets.length > 0 && rec.transport === 'stdio') {
    faults.push(fault('STDIO_SERVER_HOLDS_SECRET', `${at}.secrets`,
      "a stdio server is started by the harness as the agent user, so a secret it holds is readable by the model's own shell",
      'set "transport": "http"; the runtime starts a secret-holding server as the tools user on loopback'));
  }

  const tools = rec.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    faults.push(fault('MANIFEST_NO_TOOLS', `${at}.tools`,
      'a tool server declares at least one tool',
      'declare each tool as {name, description, arguments, returns, readOnlyHint, writes}'));
    return faults;
  }

  const seen = new Set();
  // Array.isArray above permits iteration; each tool remains untrusted until the object and field checks below.
  for (const [i, tool] of (tools as unknown[]).entries()) {
    const where = `${at}.tools[${i}]`;
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      faults.push(fault('TOOL_NOT_AN_OBJECT', where, 'each tool is one JSON object', 'see the reference'));
      continue;
    }
    const spec = tool as Record<string, unknown>;
    for (const key of Object.keys(spec)) {
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
    if (typeof spec.name !== 'string' || !NAME.test(spec.name)) {
      faults.push(fault('TOOL_NAME_WRONG', `${where}.name`,
        'a tool name is lower case with underscores, so it is the same word in every harness',
        'name it like read_account'));
    } else if (seen.has(spec.name)) {
      faults.push(fault('TOOL_NAME_REPEATED', `${where}.name`,
        `two tools are named ${spec.name}`, 'give each tool one name'));
    } else {
      seen.add(spec.name);
    }
    if (typeof spec.description !== 'string' || spec.description.trim().length < 20) {
      faults.push(fault('TOOL_UNDESCRIBED', `${where}.description`,
        'the description is what a caller reads to decide whether this is the tool; a name is not a description',
        'say what it does, what it returns, and when not to use it'));
    }
    if (typeof spec.readOnlyHint !== 'boolean') {
      faults.push(fault('READ_ONLY_HINT_MISSING', `${where}.readOnlyHint`,
        'every tool says whether it only reads; it is the one annotation that survives every harness',
        'set readOnlyHint true or false'));
    }
    if (typeof spec.writes !== 'boolean') {
      faults.push(fault('WRITES_MISSING', `${where}.writes`,
        'every tool says whether it writes to the client system, because a write goes through the declaration write gate',
        'set writes true or false'));
    }
    if (spec.readOnlyHint === true && spec.writes === true) {
      faults.push(fault('READ_ONLY_HINT_CONTRADICTED', `${where}.readOnlyHint`,
        'this tool is declared read only and declared to write',
        'set readOnlyHint false on a tool that writes'));
    }
    faults.push(...checkSchema(spec.arguments, `${where}.arguments`));
    faults.push(...checkReturns(spec.returns, `${where}.returns`));
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
  // The object check above permits named reads; return fields are still checked individually.
  const rec = returns as ReturnsSection;
  if (typeof rec.what !== 'string' || rec.what.trim() === '') {
    faults.push(fault('RETURNS_UNDESCRIBED', `${at}.what`,
      'one sentence says what the caller is holding after this call',
      'write it'));
  }
  if (!Array.isArray(rec.fields) || rec.fields.length === 0) {
    faults.push(fault('OVER_WIDE_RETURN', `${at}.fields`,
      'the fields the caller gets are not named, so the return is whatever the upstream object happened to hold',
      'name each field as {"name": "...", "what": "..."} and build the return with shapeReturn'));
    return faults;
  }
  // Array.isArray above permits iteration; each return field is checked after this read.
  for (const [i, field] of (rec.fields as unknown[]).entries()) {
    const item = field as ReturnField;
    if (!field || typeof field !== 'object' || typeof item.name !== 'string'
        || typeof item.what !== 'string' || item.what.trim() === '') {
      faults.push(fault('RETURNS_FIELD_WRONG', `${at}.fields[${i}]`,
        'each returned field is {"name": "...", "what": "..."}',
        'name the field and say what it means'));
    }
  }
  return faults;
}

// The only sanctioned way to build a return: exactly the fields the manifest
// names, and nothing else. A raw upstream object is never the return.
export function shapeReturn(tool: unknown, source: unknown) {
  const out: Record<string, unknown> = {};
  // Untrusted public argument. The original walk is tool.returns.fields; this
  // assertion names that path for the checker and does not default, skip, or
  // re-validate. Missing returns or fields still throw at the property read.
  for (const field of (tool as ShapeTool).returns.fields) {
    // The output key is the field's name as originally read; `in` uses the
    // ordinary property-key conversion. The name is not checked to be a string.
    const name = field.name as string;
    if (source && typeof source === 'object' && name in source) out[name] = (source as Record<string, unknown>)[name];
    else out[name] = null;
  }
  return out;
}

export function loadManifest(serverDir: string) {
  const manifest = readManifest(serverDir);
  refuseAll(checkManifest(manifest));
  return manifest;
}
