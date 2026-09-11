// Adapters are hosted in this process, not spawned. The registry is the only
// place a channel kind becomes a module, so a declaration naming a channel this
// build does not carry is one named fault at start rather than a crash on the
// first message.
//
// Registering by name and loading later is deliberate. `email` and `whatsapp`
// are built as separate pieces of work; a build that does not carry one of them
// yet says so by name and refuses to start, which is a better answer than an
// agent that runs and silently answers nothing on that channel.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fault, RuntimeFault } from './faults.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

export const REGISTRY = {
  // the adapter with no channel, so the release loop can be run and proved
  // without a network and without a credential
  fixture: 'adapters/fixture/index.mjs',
  email: 'adapters/email/index.mjs',
  whatsapp: 'adapters/whatsapp/index.mjs',
  telegram: 'adapters/telegram/index.mjs'
};

export function registeredKinds() {
  return Object.keys(REGISTRY).sort();
}

// Returns the module. Throws a named fault when the kind is not registered, or
// is registered and its module is not in this build.
export async function loadAdapter(kind, { root = ROOT, registry = REGISTRY } = {}) {
  const relative = registry[kind];
  if (relative === undefined) {
    throw new RuntimeFault(fault('CHANNEL_KIND_UNREGISTERED', kind,
      `no adapter is registered for a channel of kind ${JSON.stringify(kind)}`,
      `declare a channel whose kind is one of: ${Object.keys(registry).sort().join(', ')}`));
  }
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    throw new RuntimeFault(fault('ADAPTER_MODULE_ABSENT', kind,
      `the ${kind} adapter is registered at ${relative} and this build does not carry that file`,
      `install a carbon-runtime release that carries the ${kind} adapter, or remove the channel from the declaration`));
  }
  const module = await import(pathToFileURL(file).href);
  const missing = ['capabilities', 'listPending', 'consume', 'payload', 'send']
    .filter((name) => module[name] === undefined);
  if (missing.length > 0) {
    throw new RuntimeFault(fault('ADAPTER_INCOMPLETE', kind,
      `${relative} does not export ${missing.join(', ')}`,
      'an adapter exports capabilities and the five operations stream/adapter.md names'));
  }
  return module;
}
