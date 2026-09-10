// The runtime process: the one thing a unit starts.
//
// It spawns the pinned harness as its direct child and exits non-zero if that
// child exits, so systemd restarts the pair together in one cgroup. It starts the
// tool servers that hold secrets, as the tools user. It hosts the adapters in
// this process, takes one lock per adapter, and runs the release loop. It serves
// the `reply` tool on loopback. It refuses to start when the store is latched, and
// it latches and stops when it meets an ending a restart cannot help.
//
// It has no daemon of its own beyond that, no database, no orchestration, and no
// reload path: a change to what the agent does is a commit and an install.

import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../stream/store.mjs';
import { fault, report, RuntimeFault, EXIT } from './faults.mjs';
import { refuseIfLatched } from './latch.mjs';
import { takeLock, releaseLock } from './lock.mjs';
import { loadAdapter } from './registry.mjs';
import { startToolServers, stopToolServers } from './tool-servers.mjs';
import { serveReplyTool, REPLY_PORT } from './reply-tool.mjs';
import { ReleaseLoop } from './loop.mjs';

// Where each thing lives under an agent directory. Install renders the left-hand
// side; the runtime reads it and guesses none of it.
//
// The checkout is `current/repo`, and it is the thread's `cwd`. It is not the
// agent's scratch directory, and the two are deliberately different places: under
// `workspace-write` everything below `cwd` is writable whatever `writableRoots`
// says, so the only thing that holds a checkout still is its ownership and mode.
// Install unpacks it owned by the tools user at 0555 and 0444, which the agent
// user cannot change. `work/` stays beside it, agent-owned and writable, for the
// unit's log and for anything a tool server keeps between runs.
export function placesUnder(agentDir) {
  return {
    declaration: path.join(agentDir, 'current', 'carbon.agent.json'),
    store: path.join(agentDir, 'store'),
    codexHome: path.join(agentDir, 'codex-home'),
    checkout: path.join(agentDir, 'current', 'repo'),
    harnessRoot: path.join(agentDir, 'harness')
  };
}

export function readDeclaration(file) {
  if (!fs.existsSync(file)) {
    throw new RuntimeFault(fault('DECLARATION_ABSENT', file,
      'there is no declaration at this path, and the runtime reads every value it uses from one',
      'run carbon install, which renders the declaration into the agent directory'));
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new RuntimeFault(fault('DECLARATION_UNREADABLE', file, error.message,
      'the declaration is one JSON object; run carbon declaration check against it'));
  }
}

// The provider key reaches the app-server child and nothing else. The variable it
// arrives under is the provider's own, which is why the mapping is here and not
// in the declaration: a client repository does not get to name an environment
// variable in this process.
const PROVIDER_KEY_ENV = { openai: 'OPENAI_API_KEY' };

export function providerKey(declaration) {
  const provider = declaration.provider ?? {};
  const name = PROVIDER_KEY_ENV[provider.name];
  if (!name) {
    throw new RuntimeFault(fault('PROVIDER_UNKNOWN', String(provider.name),
      `this runtime knows how to pass a key to ${Object.keys(PROVIDER_KEY_ENV).join(', ')} and not to ${JSON.stringify(provider.name)}`,
      'name a provider this runtime carries, or add the provider to the runtime and pin a new release'));
  }
  const secret = (declaration.secrets ?? []).find((s) => s.name === provider.api_key_ref);
  if (!secret) {
    throw new RuntimeFault(fault('SECRET_REF_UNDECLARED', 'provider.api_key_ref',
      `no secret named ${JSON.stringify(provider.api_key_ref)} is declared`,
      'declare the provider key as a secret with its absolute path'));
  }
  return { path: secret.path, env: name };
}

export function harnessBinary(declaration, { harnessRoot, binary }) {
  if (binary) return binary;
  const version = declaration.harness?.version;
  const at = path.join(harnessRoot, String(version), 'codex');
  if (!fs.existsSync(at)) {
    throw new RuntimeFault(fault('HARNESS_BINARY_ABSENT', at,
      `the declaration pins harness version ${JSON.stringify(version)} and no binary is unpacked at that path`,
      'run carbon install, which fetches, verifies and unpacks the pinned release'));
  }
  return at;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The child dying mid-turn arrives as this fault rather than as a completion,
// which is the harness's rule: a process exit is never a turn's completion.
function isChildExit(error) {
  return error?.fault?.code === 'HARNESS_CHILD_EXITED_MID_TURN'
    || error?.faults?.some?.((f) => f.code === 'HARNESS_CHILD_EXITED_MID_TURN');
}

// Runs the agent. Returns an exit code; it does not call process.exit, so a test
// can run it and read the answer.
export async function run(options) {
  const {
    declaration, declarationPath, storeDir, codexHome, checkout, harnessRoot,
    binary = null, toolsUser = null, replyPort = REPLY_PORT,
    // A box always passes a provider key: the declaration names the secret and
    // the runtime reads it at start. A local run against a harness that already
    // holds its own authentication in CODEX_HOME passes false, and then no key
    // is read and none reaches the child.
    withProviderKey = true,
    harness, adapters = null, items = () => [],
    passes = Infinity, log = () => {}, now = () => Date.now()
  } = options;

  const store = Store.open(storeDir);
  refuseIfLatched(store);

  const channels = declaration.channels ?? [];
  if (channels.length === 0) {
    throw new RuntimeFault(fault('NO_CHANNEL_DECLARED', declaration.agent?.id ?? 'agent',
      'the declaration names no channel, so nothing would ever reach this agent',
      'declare the channel the agent works on, or do not start a runtime for it'));
  }

  const loaded = [];
  for (const channel of channels) {
    const adapter = adapters?.[channel.kind] ?? await loadAdapter(channel.kind);
    loaded.push({ channel, adapter });
  }

  const locks = [];
  const toolServers = [];
  let reply = null;
  let session = null;
  const stop = async () => {
    if (reply) await reply.close();
    stopToolServers(toolServers);
    for (const lock of locks) releaseLock(lock.file);
    if (session && typeof session.stop === 'function') await session.stop();
  };

  try {
    for (const { channel } of loaded) {
      const lock = takeLock(storeDir, `${channel.kind}:${channel.account}`);
      locks.push(lock);
      if (lock.taken_over) {
        log({ event: 'lock.taken_over', channel: channel.kind, account: channel.account, previous: lock.previous });
      }
    }

    toolServers.push(...startToolServers(declaration, { declarationPath, toolsUser }));
    for (const server of toolServers) log({ event: 'tool_server.started', name: server.name, url: server.url });

    reply = await serveReplyTool({ store, agent: declaration.agent?.id, port: replyPort });
    log({ event: 'reply_tool.listening', url: reply.url });

    const key = withProviderKey ? providerKey(declaration) : { path: undefined, env: undefined };
    session = await harness.connect({
      binary: harnessBinary(declaration, { harnessRoot, binary }),
      codexHome,
      providerKeyPath: key.path,
      providerKeyEnvName: key.env,
      onEvent: (event) => log({ event: 'harness', kind: event.kind, thread_id: event.threadId, turn_id: event.turnId }),
      onStderr: () => {}
    });

    // The child dying is the end of this process. The pair is one unit; systemd
    // restarts both, and the store says what the restart owes.
    let childExit = null;
    session.exit.then((exit) => { childExit = exit; });

    const loops = loaded.map(({ channel, adapter }) => {
      const loop = new ReleaseLoop({
        declaration, channel, store, storeDir, adapter, harness, session,
        agent: declaration.agent?.id, checkout, log, now
      });
      if (harness.onToolServerStatus) {
        harness.onToolServerStatus(session, () => { loop.toolStatusStale = true; });
      }
      return loop;
    });

    for (const loop of loops) loop.recovering = loop.recover();

    let done = 0;
    while (done < passes) {
      if (childExit) break;
      for (const loop of loops) {
        try {
          await loop.pass(items(loop.channel));
        } catch (error) {
          if (!isChildExit(error)) throw error;
          childExit = childExit ?? { code: null, signal: 'unknown' };
          break;
        }
        if (childExit) break;
      }
      done += 1;
      if (done < passes && !childExit) {
        await sleep(Math.max(...loaded.map(({ channel }) => channel.poll_interval_ms ?? 1000)));
      }
    }

    if (childExit) {
      report([fault('HARNESS_CHILD_EXITED', String(declaration.harness?.version),
        `the app-server exited with code ${childExit.code} signal ${childExit.signal}`,
        'the unit restarts the pair; the store says what the restart owes')]);
      return EXIT.HARNESS_EXITED;
    }
    return EXIT.OK;
  } finally {
    await stop();
  }
}
