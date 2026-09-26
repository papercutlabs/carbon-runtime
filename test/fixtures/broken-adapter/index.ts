// An adapter that is broken on purpose, so the check is shown to be able to
// fail. It is the fixture adapter with one thing wrong: it mints a fresh
// message_id every time it sees an item, so the same inbound twice writes two
// records and case 1 fails by name. It declares inbound alone, so the outbound
// and import cases never run against it.

import * as fixture from '../../../adapters/fixture/index.ts';

export const capabilities = ['inbound'];

export const listPending = fixture.listPending;
export const consume = fixture.consume;
export const matchesDelivery = fixture.matchesDelivery;
export const send = fixture.send;

let seen = 0;

export function payload(
  context: Parameters<typeof fixture.payload>[0],
  items: Parameters<typeof fixture.payload>[1]
): ReturnType<typeof fixture.payload> {
  const built = fixture.payload(context, items);
  for (const entry of built.entries) {
    // FixtureRecord leaves message_id unknown until the store checks it; String
    // keeps the original template coercion without inventing a typed guarantee.
    entry.record.message_id = `${String(entry.record.message_id)}-${++seen}`;
  }
  return built;
}
