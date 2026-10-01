#!/usr/bin/env node
// A runtime process for the drain test (PA-322): the real run(), with its real
// loop, store, reply tool, locks and signal handling, in a process of its own so
// a test can send it a real SIGTERM. What stands in is the harness, which is the
// fake the other runtime tests use, and the channel, which is the fixture
// adapter; neither opens a network or a model.
//
//   node test/fixtures/drain-runner.ts <dir> idle   no item; the loop sleeps 60 s between passes
//   node test/fixtures/drain-runner.ts <dir> turn   one item, whose turn waits for <dir>/go to exist
//   node test/fixtures/drain-runner.ts <dir> two    two conversations, one item each, both eligible in
//                                                   the first pass; every turn waits for <dir>/go
//   node test/fixtures/drain-runner.ts <dir> telegram  the real Telegram adapter against a Bot API whose
//                                                   getUpdates holds for its whole 10 s long poll
//
// Every line on stdout is JSON: the runtime's own log lines, and this file's
// lines, which carry `fixture` rather than `event`, so the test can see when a
// pass asked for items, when a turn started and when it answered.

import type { Declaration } from '../../runtime/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../../runtime/index.ts';
import { sandboxDenyBody } from '../../runtime/loop.ts';
import { replyHandler } from '../../runtime/reply-tool.ts';
import { Store } from '../../stream/store.ts';
import { fakeHarness } from '../fake-harness.ts';
import * as fixture from '../../adapters/fixture/index.ts';
import * as telegram from '../../adapters/telegram/index.ts';

export const AGENT = 'test-agent';
export const ACCOUNT = 'account-1';
export const ITEM = { conversation: 'c1', id: '1', position: '0001', at: '2026-09-10T10:01:00.000Z', sender: 'contact-1', text: 'hello' };
export const SECOND = { conversation: 'c2', id: '2', position: '0002', at: '2026-09-10T10:02:00.000Z', sender: 'contact-2', text: 'hello too' };

// The model's answer to a release, through the reply tool's own handler, in the
// conversation the release was taken in, as a model calling the tool would.
export function answer(storeDir: string, releaseId: string) {
  const store = Store.open(storeDir);
  const released = store.rebuild().find((r) => r.direction === 'inbound' && r.release?.turn_id === releaseId);
  replyHandler({ store, agent: AGENT })({
    conversation_id: released?.conversation_id, request_id: releaseId, text: 'the answer'
  });
}

export function declarationFor(pollIntervalMs: number) {
  return {
    schema: 'carbon.agent-declaration.v1',
    agent: { id: AGENT, client: 'ExampleCorp' },
    harness: { kind: 'codex-app-server', version: '0.153.4' },
    model: 'fake-model',
    effort: 'low',
    sandbox: { mode: 'workspace-write', network: false },
    provider: { name: 'openai', auth: 'chatgpt' },
    secrets: [],
    tool_servers: [],
    channels: [{
      kind: 'fixture', account: ACCOUNT, release: 'quiet', quiet_ms: 0, poll_interval_ms: pollIntervalMs,
      conversations: [], default_conversation_kind: 'customer'
    }],
    unit_of_work: { kind: 'conversation', id_from: 'conversation_id', idle_close_ms: 1000 },
    limits: { max_turn_ms: 60000 }
  };
}

export const TELEGRAM_ACCOUNT = 'example_agent_bot';
export const LONG_POLL_S = 10;

// One Telegram channel, long-polling for LONG_POLL_S as the live agent does.
export function telegramDeclarationFor(botToken: string) {
  const declaration = declarationFor(100);
  return {
    ...declaration,
    secrets: [{ name: 'telegram_bot_token', path: botToken, purpose: 'the bot token' }],
    channels: [{
      kind: 'telegram', account: TELEGRAM_ACCOUNT, release: 'quiet', quiet_ms: 0, poll_interval_ms: 100,
      conversations: [], default_conversation_kind: 'customer',
      transport: { bot_token_ref: 'telegram_bot_token', long_poll_timeout_s: LONG_POLL_S, allowed_chat_ids: 'any' }
    }]
  };
}

// A Bot API whose getUpdates answers nothing and holds for the whole long poll,
// as the real one does when no message arrives, and gives up early only when
// the request is aborted, as fetch does. Every ask is reported with its offset.
export function holdingBotApi(onAsk: (offset: unknown) => void) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, options: RequestInit = {}) => {
    if (!url.includes('/getUpdates')) throw new Error(`unexpected fake request ${url}`);
    // The adapter JSON-encodes its request body.
    onAsk(JSON.parse(options.body as string).offset ?? null);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, LONG_POLL_S * 1000);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
    });
    return { status: 200, json: async () => ({ ok: true, result: [] }) };
  }) as unknown as typeof fetch; // Only the response fields the adapter reads on getUpdates: status and json.
  return () => { globalThis.fetch = previous; };
}

// What run() is given for a directory, the way runtime.process.test.ts builds it.
export function placed(dir: string, pollIntervalMs: number, declaration: Declaration = declarationFor(pollIntervalMs)) {
  const declarationPath = path.join(dir, 'carbon.agent.json');
  fs.writeFileSync(declarationPath, JSON.stringify(declaration, null, 2));
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  const denyFile = path.join(dir, 'requirements.toml');
  fs.writeFileSync(denyFile, sandboxDenyBody(dir));
  fs.chmodSync(denyFile, 0o644);
  return {
    declaration,
    declarationPath,
    storeDir: path.join(dir, 'store'),
    codexHome: path.join(dir, 'codex-home'),
    checkout: path.join(dir, 'repo'),
    work: path.join(dir, 'work'),
    harnessRoot: path.join(dir, 'harness'),
    binary: '/nowhere/codex',
    adapters: { fixture, telegram },
    sandboxDeny: { file: denyFile, root: dir, ownerUid: process.getuid ? process.getuid() : 0 }
  };
}

async function main(dir: string, mode: string) {
  const say = (line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + '\n');
  const turn = mode === 'turn' || mode === 'two';
  const where = mode === 'telegram'
    ? placed(dir, 100, telegramDeclarationFor(path.join(dir, 'bot-token')))
    : placed(dir, turn ? 10 : 60000);
  if (mode === 'telegram') holdingBotApi((offset) => say({ fixture: 'getUpdates', offset }));
  const go = path.join(dir, 'go');
  const harness = fakeHarness({
    statuses: () => [{ name: 'carbon-reply', runtimeStatus: 'connected' }],
    // The model's part: wait until the test says go, then answer.
    onTurn: async (_session, params) => {
      say({ fixture: 'turn.started', release_id: params.clientUserMessageId });
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(go) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      answer(where.storeDir, params.clientUserMessageId);
      say({ fixture: 'turn.answered', release_id: params.clientUserMessageId });
      return 'completed';
    }
  });
  const stopSession = harness.session.stop.bind(harness.session);
  harness.session.stop = async () => { await stopSession(); say({ fixture: 'session.stopped' }); };
  const code = await run({
    ...where,
    replyPort: 20000 + Math.floor(Math.random() * 20000),
    harness,
    items: () => { say({ fixture: 'items' }); return mode === 'two' ? [ITEM, SECOND] : turn ? [ITEM] : []; },
    log: say
  });
  say({ fixture: 'returned', code });
  return code;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = await main(process.argv[2], process.argv[3]);
}
