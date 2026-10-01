import type { Fault } from '../../stream/faults.ts';
import type { Fields, Transport } from './types.ts';
// The Bot API, over https, with no library.
//
// The Bot API is JSON over HTTPS with no handshake, no session and no streaming:
// a call is one POST to `https://api.telegram.org/bot<token>/<method>` with a
// JSON body, and an answer is `{ok: true, result}` or `{ok: false, error_code,
// description}`. Node 22 has `fetch`, so a client library would add a dependency
// and a version to pin in exchange for nothing this adapter needs. That is the
// whole reason there is no dependency here, and it is not a preference: the API
// is small enough that the wrapper would be larger than the thing wrapped, and
// this repository's one-dependency rule exists because every dependency on a
// client box is a thing somebody has to keep pinned.
//
// Two rules hold this file apart from the rest of the adapter.
//
// 1. **The token never reaches a log and never reaches a fault.** It is in the
//    path of every URL built here, so anything that could carry a URL goes
//    through `scrub` first: an error from fetch, a description from the server,
//    a message from the URL parser. A token in the unit's journal is readable by
//    anyone who can read the box, and a bot token is the whole credential —
//    there is no second factor and no per-device pairing to unlink.
// 2. **This is the only file in the adapter that touches a network.** index.ts
//    turns updates into records and a reply into chunks, and every rule it holds
//    is tested against recorded updates with no network in the test.

// Property-view assertions below do not validate thrown or JSON fields: every
// accessed value remains unknown and follows the original optional reads.
import fs from 'node:fs';
import { fault } from '../../stream/faults.ts';
import { StreamFault } from '../../stream/store.ts';

export const DEFAULT_API_HOST = 'api.telegram.org';

// How long a call that is not a long poll may take. The Bot API answers a plain
// method well under a second; a minute is the point past which the network, and
// not the server, is what is wrong.
export const CALL_TIMEOUT_MS = 60000;

// The update types this adapter asks for. Naming them is not an optimisation:
// with no `allowed_updates` the server sends every type it has, and a type this
// adapter has no reading for is parked on arrival — one parked record for every
// reaction somebody adds to a message.
export const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post'];

// A fault a caller may log or put on a record, with no token in it. It carries
// the server's own error code where there was one, because "the token is
// revoked" and "the server is busy" are different days' work.
export class TelegramFault extends StreamFault<unknown> {
  declare errorCode: unknown;
  declare retryAfter: unknown;

  constructor(faults: Fault<unknown>[], { errorCode = null, retryAfter = null }: { errorCode?: unknown; retryAfter?: unknown } = {}) {
    super(faults);
    this.name = 'TelegramFault';
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
  }
}

// Replace the token wherever it appears in a string that is about to be shown.
export function scrub(text: unknown, token: unknown) {
  const said = String(text ?? '');
  if (typeof token !== 'string' || token.length === 0) return said;
  return said.split(token).join('<bot token>');
}

// A token is `<bot id>:<secret>`, so the digits before the colon are the bot's
// own user id and can be read without a call. That matters for one rule: a
// message whose sender is this bot is the agent's own, not a person's.
export function botIdOf(token: unknown) {
  const match = /^([0-9]+):[A-Za-z0-9_-]+$/.exec(String(token ?? '').trim());
  return match === null ? null : Number(match[1]);
}

// The token, read at the moment it is used. It is never held on the channel,
// never put in this process's environment and never written anywhere. The file
// is placed by its owner through `carbon-apply secret place`, mode 0600, owned
// by the account that reads it, which for a channel is the agent user.
export function readToken(file: unknown) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TelegramFault([fault('CHANNEL_TOKEN_PATH_ABSENT', 'transport.bot_token_ref',
      'this channel names no declared secret holding its bot token, and the adapter guesses no path for a credential',
      'declare transport.bot_token_ref as the name of a secret this declaration declares')]);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new TelegramFault([fault('CHANNEL_TOKEN_UNREADABLE', file,
      // A failed file read may carry errno and message; these optional reads leave arbitrary throws unvalidated.
      (error as Fields | null | undefined)?.code === 'ENOENT'
        ? 'there is no file at this path'
        : `this account cannot read the file: ${(error as Fields | null | undefined)?.code ?? (error as Fields | null | undefined)?.message}`,
      'the box owner places the token at this path, mode 0600, owned by the account the runtime runs as')]);
  }
  const token = text.trim();
  if (botIdOf(token) === null) {
    throw new TelegramFault([fault('BOT_TOKEN_MALFORMED', file,
      'the file does not hold a bot token: a token is the bot\'s numeric id, a colon, then its secret, on one line',
      'place the token BotFather gave, with no quotes and nothing around it')]);
  }
  return token;
}

// One call. `timeoutMs` covers the whole call, and a long poll passes its own: a
// getUpdates holding open for twenty-five seconds must not be cut off by a
// timeout meant for a method that answers at once. `signal` lets the caller end
// the call early, which is how a stop ends a long poll without waiting it out.
export async function call(transport: Transport, method: string, params: Fields = {}, { timeoutMs = CALL_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
  const { token, apiHost = DEFAULT_API_HOST } = transport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let status: number | null = null;
  let body: unknown = null;
  try {
    const response = await fetch(`https://${apiHost}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    });
    status = response.status;
    body = await response.json();
  } catch (error) {
    throw new TelegramFault([fault('BOT_API_UNREACHABLE', method,
      // A failed fetch may throw any value; the optional message is scrubbed before it reaches the fault.
      scrub((error as Fields | null | undefined)?.message ?? String(error), token),
      `check that ${apiHost} is reachable from this box; it is the host the declaration names in outbound_hosts`)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  // The Bot API JSON remains untrusted; these optional reads preserve the refusal and retry fields as received.
  if ((body as Fields | null)?.ok !== true) {
    const code = (body as Fields | null)?.error_code ?? status;
    throw new TelegramFault([fault('BOT_API_REFUSED', method,
      `the Bot API answered ${code}: ${scrub((body as Fields | null)?.description ?? 'no description', token)}`,
      code === 401
        ? 'the token is wrong or has been revoked; place the token again and restart the unit'
        : 'read the description; it is the server\'s own words for what it refused')],
    { errorCode: code, retryAfter: ((body as Fields | null)?.parameters as Fields | null)?.retry_after ?? null });
  }
  // A true ok flag selects the result field; the Bot API payload is not schema validated here.
  return (body as Fields).result;
}

// The bytes of a file, by the path getFile answered with. The download URL
// carries the token the way a method call does, so the same scrubbing applies.
export async function download(transport: Transport, filePath: string, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const { token, apiHost = DEFAULT_API_HOST } = transport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://${apiHost}/file/bot${token}/${filePath}`, { signal: controller.signal });
    if (!response.ok) {
      throw new TelegramFault([fault('ATTACHMENT_DOWNLOAD_REFUSED', filePath,
        `the file endpoint answered ${response.status} ${response.statusText}`,
        'the record keeps the attachment as download_failed and is released anyway')], { errorCode: response.status });
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof TelegramFault) throw error;
    throw new TelegramFault([fault('ATTACHMENT_DOWNLOAD_FAILED', filePath,
      // A failed download may throw any value; the optional message is scrubbed before reporting it.
      scrub((error as Fields | null | undefined)?.message ?? String(error), token),
      'the record keeps the attachment as download_failed and is released anyway')]);
  } finally {
    clearTimeout(timer);
  }
}
