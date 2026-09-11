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
// caps come from `teaching.max_active` and `teaching.max_chars`; where teaching
// happens is the one conversation a channel declares with kind `management`; and
// `teaching.enabled` false is the whole path off — this server refuses to be
// built at all, and the runtime starts none.
//
// **Teaching happens in the management conversation and nowhere else**, ruled on
// 11 September. An agent sits in three kinds of room. In a customer chat a
// staff member's message is somebody taking the conversation over and the agent
// stops; in an ops chat the agent works beside staff and contractors; in the
// management conversation the client's people talk to the agent about how it
// works, every member of it is a teacher, and what is taught there applies to the
// agent everywhere. So there is no check here on who sent the message: the room
// is the authorisation. A call citing a message from any other conversation is
// refused as TEACHING_NOT_IN_MANAGEMENT_CONVERSATION and nothing is written.

import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../tools/lib/mcp.mjs';
import { readManifest } from '../tools/lib/manifest.mjs';
import { renderHelp } from '../tools/lib/help.mjs';
import { ToolFault, fault as toolFault } from '../tools/lib/fault.mjs';
import { Store, StreamFault } from '../stream/store.mjs';
import { remember, raiseChange, forget } from '../stream/teachings.mjs';
import { fault, report, RuntimeFault, EXIT } from './faults.mjs';
import { managementConversationOf } from './channel.mjs';

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

// Where the agent may be taught, checked against the conversation the call cites
// rather than against anything about who sent it. A standing instruction given in
// a work chat is not a standing instruction: the client's people direct the work
// there, and what they say is about the job in front of the agent rather than
// about how the agent operates. The failure is silent if it is not refused - it
// looks like the agent behaving oddly, not like something it was never told to
// stand on.
export function managementFaults(management, conversation_id) {
  if (management !== null && conversation_id === management) return [];
  return [toolFault('TEACHING_NOT_IN_MANAGEMENT_CONVERSATION', String(conversation_id),
    management === null
      ? 'this agent\'s declaration names no management conversation, so there is nowhere it may be taught'
      : `this conversation is not this agent's management conversation, and a standing instruction is taught there and nowhere else`,
    'nothing was written. Do not tell the client you have remembered anything. Answer here as you would any other message, and if this is meant to stand, it is said in the management conversation')];
}

// Everything below this line refuses in the tool fault shape, so the model reads
// what is wrong and what to do about it rather than a stack.
function asToolFault(thrown) {
  if (thrown instanceof StreamFault) return new ToolFault(thrown.faults);
  return thrown;
}

// The room check, run before the store is touched, so a call from a work chat
// leaves nothing behind at all. It is the conversation the call names that is
// checked; a source_message_id from another conversation is not in this
// conversation's captures and stream/teachings.mjs refuses it by name.
function refuseOutsideManagement(management, { conversation_id }) {
  const faults = managementFaults(management, conversation_id);
  if (faults.length > 0) throw new ToolFault(faults);
}

function rememberHandler({ store, agent, teaching, management, release = () => null, now = () => new Date().toISOString() }) {
  return (args) => {
    refuseOutsideManagement(management, args);
    let written;
    try {
      written = remember(store, {
        agent,
        text: args.text,
        conversation_id: args.conversation_id,
        source_message_id: args.source_message_id,
        max_active: teaching.max_active,
        max_chars: teaching.max_chars,
        release_id: release(),
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

function raiseChangeHandler({ store, agent, teaching, management, release = () => null, now = () => new Date().toISOString() }) {
  return (args) => {
    refuseOutsideManagement(management, args);
    let written;
    try {
      written = raiseChange(store, {
        agent,
        text: args.text,
        conversation_id: args.conversation_id,
        source_message_id: args.source_message_id,
        failed_question: args.failed_question,
        max_chars: teaching.max_chars,
        release_id: release(),
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

// `forget` is checked the same way as the other two. A revocation is a thing the
// client says about how the agent operates, so it is said where the instruction
// was said; a revocation taken from a work chat would let one sentence there drop
// a standing instruction the management conversation put up.
function forgetHandler({ store, management, now = () => new Date().toISOString() }) {
  return (args) => {
    refuseOutsideManagement(management, args);
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

// The release the turn being taken is under, which the record a call writes says
// it was written under. The server does not work it out: the release loop is what
// knows, and it says so before each turn and takes it back after. A caller that
// runs no release loop — a scored run, which hosts these tools for the length of
// one turn and has no release — names none, and the records it writes carry no
// release_id, which is the truth about them.
export function createTeachServer({ store, agent, declaration, release = () => null }) {
  const teaching = teachingOf(declaration);
  const management = managementConversationOf(declaration);
  return createServer({
    manifest: MANIFEST,
    handlers: {
      remember: rememberHandler({ store, agent, teaching, management, release }),
      raise_change: raiseChangeHandler({ store, agent, teaching, management, release }),
      forget: forgetHandler({ store, management })
    }
  });
}

export async function serveTeachTool({ store, agent, declaration, host = '127.0.0.1', port = TEACH_PORT }) {
  // One value, held here and read at the moment a call arrives, because turns are
  // taken one at a time in this process: two channels on one agent are two loops
  // that never take a turn at the same moment.
  let current = null;
  const server = createTeachServer({ store, agent, declaration, release: () => current });
  const { server: http, url } = await server.serveHttp({ host, port });
  return {
    http,
    url,
    setRelease: (release_id) => { current = release_id ?? null; },
    close: () => new Promise((resolve) => http.close(resolve))
  };
}

// ---- serving it as a process of its own -------------------------------------
//
// On a box this server is the runtime's own: the release loop holds the store
// open and serves these three tools beside the reply tool in the same process.
// That is still the live shape and nothing below changes it.
//
// What is below is how the same server is started by something that is not the
// release loop, which today is one caller: a scored `carbon run`, which starts a
// client agent from its own declaration on a machine that is not a box and hosts
// the declaration's agent-user http tool servers for the length of the turn. It
// starts them the way the box's launcher does — `--declaration`, `--host`,
// `--port` — so the module, its arguments and where it binds are the
// declaration's own and not the caller's.
//
// The store is named by `CARBON_TEACH_STORE`, an ordinary non-secret entry in
// the declaration's `runtime.env`, which is how any tool server on a box is told
// what to reach. It is not defaulted: a teaching server writing into a store
// nobody named is a client's standing instructions landing where nobody looks.
export function argumentFaults(args) {
  const faults = [];
  for (const name of ['declaration', 'host', 'port']) {
    if (args[name] === undefined || args[name] === '') {
      faults.push(fault('MISSING_ARGUMENT', `--${name}`,
        'the teaching server is told what it serves and where it binds, and nothing here has a default that guesses',
        `pass --${name}; node runtime/teach-tool.mjs --help says what each is`));
    }
  }
  if (args.store === undefined || args.store === '') {
    faults.push(fault('TEACH_STORE_UNNAMED', 'CARBON_TEACH_STORE',
      'nothing says which store this server writes what the client teaches into',
      'name it in the declaration\'s runtime.env as CARBON_TEACH_STORE, with the absolute path of the agent\'s store'));
  }
  return faults;
}

export function parseServeArgv(argv) {
  const args = { store: process.env.CARBON_TEACH_STORE };
  for (const name of ['declaration', 'host', 'port']) {
    const at = argv.indexOf(`--${name}`);
    if (at !== -1) args[name] = argv[at + 1];
  }
  return args;
}

// The manual, rendered from the manifest, so `carbon tool check` reads the same
// text the harness puts in front of the model.
async function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(renderHelp(MANIFEST, {
      serverUsage: [
        'served by the carbon runtime on loopback beside the reply tool, in the same process',
        `node runtime/teach-tool.mjs --declaration <file> --host <host> --port <n>    serve it as its own process, with CARBON_TEACH_STORE naming the store (the runtime's own port is ${TEACH_PORT})`,
        'node runtime/teach-tool.mjs --help    the manual'
      ]
    }));
    return 0;
  }
  const args = parseServeArgv(argv);
  const faults = argumentFaults(args);
  if (faults.length > 0) {
    report(faults);
    return EXIT.FAULT;
  }
  const declaration = JSON.parse(fs.readFileSync(args.declaration, 'utf8'));
  const { url } = await serveTeachTool({
    store: Store.open(args.store),
    agent: declaration.agent?.id,
    declaration,
    host: args.host,
    port: Number(args.port)
  });
  console.log(JSON.stringify({ event: 'teach_tool.listening', url, store: args.store }));
  return null;
}

if (process.argv[1] === import.meta.filename) {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
