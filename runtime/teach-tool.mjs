// The `teach` tools: what a client may teach their agent, and what has to come
// back to the people who build it.
//
// Three tools, served on loopback beside the reply tool, by this same process:
//
//   remember       record one standing instruction, so every later turn follows it
//   raise_change   record one the agent refused as too large, with which question failed
//   forget         stop following one the client has revoked
//
// None of them takes `taught_by`. The teacher is read from the capture the
// `source_message_id` names, in stream/teachings.mjs, so the model cannot
// attribute an instruction to someone who did not send it.
//
// **The boundary test lives in the tool descriptions and nowhere else.** The
// harness puts every enabled tool's description in front of the model on every
// turn, with no per-client copying, so one text — this server's manifest — is the
// rule every client agent reads. `remember` carries the four questions and the
// grant bound and says that a yes to any of them means `raise_change`;
// `raise_change` carries the same four, so the classification reads the same from
// either side. There is deliberately no second copy in a shelf, a skill or a
// client repository.
//
// The manifest is `runtime/teach-tool/tool-server.json` rather than an object in
// this file, which is where it differs from the reply tool: `carbon tool check`
// reads a directory holding `tool-server.json`, and the plan asks for this server
// to pass it. The directory holds the manifest and nothing else; the entry it
// names is this file, and `node runtime/teach-tool.mjs --help` renders the manual
// from that same manifest, so the manual and the descriptions the model reads are
// one text.
//
// The declaration is what bounds the path, and none of it is guessed here. The
// caps come from `teaching.max_active` and `teaching.max_chars`; who may teach
// comes from `teaching.teachers`; and `teaching.enabled` false is the whole path
// off — this server refuses to be built at all, and the runtime starts none.

import path from 'node:path';
import { createServer } from '../tools/lib/mcp.mjs';
import { readManifest } from '../tools/lib/manifest.mjs';
import { renderHelp } from '../tools/lib/help.mjs';
import { ToolFault, fault as toolFault } from '../tools/lib/fault.mjs';
import { StreamFault } from '../stream/store.mjs';
import { remember, raiseChange, forget } from '../stream/teachings.mjs';
import { fault, RuntimeFault } from './faults.mjs';

export const TEACH_SERVER_NAME = 'carbon-teach';
// The teaching tools listen here unless a caller names another port. It is a
// constant and not a guess, on the same rule as the reply tool's 8730: install
// renders the same number into the config.toml the harness reads, and the two
// have to agree before the process starts.
export const TEACH_PORT = 8731;

const MANIFEST_DIR = path.join(import.meta.dirname, 'teach-tool');
export const MANIFEST = readManifest(MANIFEST_DIR);

// The declaration's teaching block, or a refusal. Nothing here has a default:
// a cap this file chose would be a cap no client repository agreed to.
export function teachingOf(declaration) {
  const teaching = declaration?.teaching;
  if (!teaching || typeof teaching !== 'object') {
    throw new RuntimeFault(fault('TEACHING_BLOCK_ABSENT', 'teaching',
      'the declaration carries no teaching block, so nothing says whether this agent may be taught, how much, or by whom',
      'add the teaching block to carbon.agent.json; carbon declaration check names its fields'));
  }
  if (teaching.enabled !== true) {
    throw new RuntimeFault(fault('TEACHING_DISABLED', 'teaching.enabled',
      'this agent\'s declaration turns the teaching path off, and a server nobody may call is a tool in front of the model that refuses every call',
      'set teaching.enabled true in carbon.agent.json, or do not start this server'));
  }
  return teaching;
}

// Who may teach, checked against the capture the record cites rather than against
// anything the caller said. A standing instruction from a contractor in a group
// chat is not a client instruction, and the failure is silent: it looks like the
// agent behaving oddly, not like an unauthorised change.
export function teacherFaults(capture, teachers) {
  const roles = teachers?.roles ?? [];
  const senderIds = teachers?.sender_ids ?? [];
  if (roles.includes(capture.role) || senderIds.includes(capture.sender_id)) return [];
  const named = capture.sender_name ? `${capture.sender_name} (${capture.sender_id})` : capture.sender_id;
  return [toolFault('TEACHING_SENDER_NOT_A_TEACHER', String(capture.sender_id),
    `${named} sent that message with the role ${JSON.stringify(capture.role)}, and this agent's declaration lets ${describeTeachers(roles, senderIds)} teach it`,
    'nothing was written. Do not tell the client you have remembered anything. Answer on the channel as you would any other message, and if this needs to stand, it comes from someone the declaration names')];
}

function describeTeachers(roles, senderIds) {
  const parts = [];
  if (roles.length > 0) parts.push(`the ${roles.join(' and ')} role${roles.length > 1 ? 's' : ''}`);
  if (senderIds.length > 0) parts.push(`the senders ${senderIds.join(', ')}`);
  return parts.length > 0 ? parts.join(' and ') : 'nobody';
}

// The capture the call cites, as this store holds it. A message this store does
// not hold is not refused here: stream/teachings.mjs refuses it by name, with the
// one fault that matters, and this file does not write a second copy of it.
function citedCapture(store, conversation_id, source_message_id) {
  const held = store.recordsIn(conversation_id)
    .filter((r) => r.message_id === source_message_id && r.direction === 'inbound')
    .sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
  return held[0] ?? null;
}

// Everything below this line refuses in the tool fault shape, so the model reads
// what is wrong and what to do about it rather than a stack.
function asToolFault(thrown) {
  if (thrown instanceof StreamFault) return new ToolFault(thrown.faults);
  return thrown;
}

// The sender check, run before the store is touched, so an uncovered sender
// leaves nothing behind at all.
function refuseUncoveredSender(store, teachers, { conversation_id, source_message_id }) {
  const capture = citedCapture(store, conversation_id, source_message_id);
  if (capture === null) return;
  const faults = teacherFaults(capture, teachers);
  if (faults.length > 0) throw new ToolFault(faults);
}

function rememberHandler({ store, agent, teaching, now = () => new Date().toISOString() }) {
  return (args) => {
    refuseUncoveredSender(store, teaching.teachers, args);
    let written;
    try {
      written = remember(store, {
        agent,
        text: args.text,
        conversation_id: args.conversation_id,
        source_message_id: args.source_message_id,
        max_active: teaching.max_active,
        max_chars: teaching.max_chars,
        now: now()
      });
    } catch (thrown) {
      throw asToolFault(thrown);
    }
    return {
      data: { id: written.id, active: written.active },
      text: written.already
        ? `This was already standing, as ${written.id}, and nothing was written again. Say back to the client what you will now do.`
        : `Recorded as ${written.id}. It is in front of you on every turn from the next one. Say back to the client what you will now do, in your own words.`
    };
  };
}

function raiseChangeHandler({ store, agent, teaching, now = () => new Date().toISOString() }) {
  return (args) => {
    refuseUncoveredSender(store, teaching.teachers, args);
    let written;
    try {
      written = raiseChange(store, {
        agent,
        text: args.text,
        conversation_id: args.conversation_id,
        source_message_id: args.source_message_id,
        failed_question: args.failed_question,
        max_chars: teaching.max_chars,
        now: now()
      });
    } catch (thrown) {
      throw asToolFault(thrown);
    }
    return {
      data: { id: written.id },
      text: `Recorded as ${written.id} and the people who build you read it from outside this box. Tell the client which part you cannot do on your own, what you will keep doing meanwhile, and that it has been passed on; name no date, no price and no scope.`
    };
  };
}

// `forget` takes no teacher check. The client revoking something they were told
// the agent is doing is not a new grant, and a revocation the declaration refused
// would leave the agent following an instruction its own client has withdrawn.
function forgetHandler({ store, now = () => new Date().toISOString() }) {
  return (args) => {
    let written;
    try {
      written = forget(store, {
        id: args.id,
        conversation_id: args.conversation_id,
        source_message_id: args.source_message_id,
        now: now()
      });
    } catch (thrown) {
      throw asToolFault(thrown);
    }
    return {
      data: { id: written.id, active: written.active },
      text: `${written.id} is forgotten and is not in front of you from the next turn. The record is kept, with the message that revoked it.`
    };
  };
}

export function createTeachServer({ store, agent, declaration }) {
  const teaching = teachingOf(declaration);
  return createServer({
    manifest: MANIFEST,
    handlers: {
      remember: rememberHandler({ store, agent, teaching }),
      raise_change: raiseChangeHandler({ store, agent, teaching }),
      forget: forgetHandler({ store })
    }
  });
}

export async function serveTeachTool({ store, agent, declaration, host = '127.0.0.1', port = TEACH_PORT }) {
  const server = createTeachServer({ store, agent, declaration });
  const { server: http, url } = await server.serveHttp({ host, port });
  return { http, url, close: () => new Promise((resolve) => http.close(resolve)) };
}

// The manual, rendered from the manifest, so `carbon tool check` reads the same
// text the harness puts in front of the model.
if (process.argv[1] === import.meta.filename) {
  console.log(renderHelp(MANIFEST, {
    serverUsage: [
      'started by the carbon runtime on loopback; it is not run by hand',
      `node runtime/teach-tool.mjs --help    the manual (port ${TEACH_PORT})`
    ]
  }));
}
