// The terminal latch, for the runtime as a whole.
//
// Some endings are not worth restarting into. The WhatsApp adapter already has
// one of them: the server decides the linked device is gone, answers 401, and
// every reconnection from that moment asks the same question. A turn the model
// reports `failed` is another: the same input will fail again. `Restart=on-failure`
// would sit in either loop for days.
//
// So the runtime writes one file, stops with a code the unit is configured not to
// restart on, and refuses to start again while the file is there:
//
//   RestartPreventExitStatus=78
//
// The file's path and shape are the ones adapters/whatsapp/latch.mjs already
// writes, `channels/<account>/<kind>.latch.json` under the store, so install has
// one rule for clearing a latch whoever wrote it, and so this module's start
// check finds an adapter's own latch as well as its own.
//
// Nothing here removes a latch. It is cleared by the next `carbon install`, which
// is a person deciding the cause is fixed. Whatever state the adapter was using —
// an authentication directory in particular — is left byte for byte as it was,
// because a person diagnosing a revocation needs it.

import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic, StreamFault } from '../stream/store.mjs';
import { componentFaults, encodeComponent, decodeComponent } from '../stream/encode.mjs';
import { fault, RuntimeFault, EXIT } from './faults.mjs';

export const EXIT_LATCHED = EXIT.LATCHED;

export function latchFile(store, account, kind) {
  const faults = [...componentFaults('account', account), ...componentFaults('channel kind', kind)];
  if (faults.length > 0) throw new StreamFault(faults);
  const dir = store.under('channels', encodeComponent(account));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${encodeComponent(kind)}.latch.json`);
}

// Every latch under the store, whoever wrote it. A runtime hosts more than one
// adapter, and one latched channel stops the process, so the start check reads
// them all and reports them together rather than the first one it meets.
export function latchesUnder(store) {
  const dir = store.under('channels');
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const account of fs.readdirSync(dir).sort()) {
    const at = path.join(dir, account);
    if (!fs.statSync(at).isDirectory()) continue;
    for (const name of fs.readdirSync(at).sort()) {
      if (!name.endsWith('.latch.json')) continue;
      let content = null;
      try { content = JSON.parse(fs.readFileSync(path.join(at, name), 'utf8')); } catch { content = null; }
      found.push({
        account: decodeComponent(account),
        kind: decodeComponent(name.slice(0, -'.latch.json'.length)),
        file: path.join(at, name),
        latch: content
      });
    }
  }
  return found;
}

export function latchFaults(store) {
  return latchesUnder(store).map(({ account, kind, latch: content }) => fault(
    content?.code ? `CHANNEL_LATCHED_${content.code}` : 'CHANNEL_LATCHED',
    `${kind}:${account}`,
    content?.reason ?? content?.problem ?? 'this channel is latched and the reason was not readable',
    content?.what_now ?? content?.fix ?? 'a person decides what happened, fixes it, and the next carbon install clears the latch'
  ));
}

// A latched agent does not start. This is what makes the latch a stop rather than
// a note: the process refuses before it opens a socket or a thread, so a unit
// restarted by hand stops again with the same code and the same reason.
export function refuseIfLatched(store) {
  const faults = latchFaults(store);
  if (faults.length > 0) throw new RuntimeFault(faults, EXIT.LATCHED);
}

// Write the latch and return the fault to stop on. The first cause is the one
// that matters: a latch already on disk is left as it is, because the second
// cause is usually the first one seen again.
export function latch(store, account, kind, cause) {
  const file = latchFile(store, account, kind);
  if (!fs.existsSync(file)) {
    writeAtomic(file, JSON.stringify({
      account,
      kind,
      latched_at: new Date().toISOString(),
      code: cause.code,
      subject: cause.subject,
      reason: cause.problem,
      what_now: cause.fix
    }, null, 2) + '\n');
  }
  return new RuntimeFault(fault(cause.code, cause.subject, cause.problem,
    `${cause.fix} The agent is latched and refuses to start until carbon install clears it.`), EXIT.LATCHED);
}
