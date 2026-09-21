// What the long poll hands over when the server's answers do not agree with one
// another.
//
// An album arrives as several updates, and a `getUpdates` answer is only what
// the server chose to say this time: it can carry part of the album, repeat the
// last answer, reorder it or carry nothing at all. Reading the last answer as
// the batch is what splits an album: six photographs the worker was holding
// became one turn and then five. So these tests run the real worker against a
// scripted server and assert the one rule that removes the whole class: the
// batch is everything retained and unconfirmed, in update-id order.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TelegramFault } from '../adapters/telegram/api.mjs';
import { arrivals, forget, IDLE_MS, stop } from '../adapters/telegram/live.mjs';
import { nextOffset } from '../adapters/telegram/cursors.mjs';
import * as adapter from '../adapters/telegram/index.mjs';
import {
  captureBatch, idsOf, liveContext, photoUpdate, scriptedServerOf, sleep, update, waitForBatch
} from './telegram-fixtures.mjs';

test('a response that omits photos the worker has already seen still hands over the whole album', async () => {
  forget();
  const context = liveContext('carbon-telegram-shrinking-', { album_quiet_ms: 300 });
  const album = Array.from({ length: 6 }, (_, index) =>
    photoUpdate(920001 + index, 301 + index, 'shrinking-album'));
  // No single answer carries the whole album: two, then two more, then the last
  // two out of order, then one already-seen photo on its own, then nothing.
  const script = [album.slice(0, 2), album.slice(2, 4), [album[5], album[4]], [album[1]]];
  const server = scriptedServerOf({ respond: ({ call }) => script[call - 1] ?? [] });

  try {
    await arrivals(context);
    const { items } = await waitForBatch(context);
    assert.deepEqual(idsOf(items), album.map((one) => one.update_id),
      'the handed batch is not the whole album in update-id order');
    assert.ok(server.asked.every((one) => one.ids.length < 6),
      `one answer carried the whole album: ${JSON.stringify(server.asked)}`);
    assert.equal(server.asked.at(-1).ids.length, 0,
      'the batch did not settle on an answer that named none of it');
    assert.deepEqual([...new Set(server.asked.map((one) => one.offset))], [null],
      'an offset moved while nothing had been consumed');
    // First sight is the answer that first showed the photo, and a later answer
    // that repeats or omits it changes nothing.
    assert.ok(Date.parse(items[0].received_at) < Date.parse(items[2].received_at));
    assert.ok(Date.parse(items[2].received_at) < Date.parse(items[4].received_at));
    assert.ok(Date.parse(items[1].received_at) < server.asked[3].at,
      'the repeated photo was given the time of the answer that repeated it');
    assert.equal(server.fetched.size, 6);
    assert.deepEqual([...new Set(server.fetched.values())], [1], 'a photo was fetched twice');
  } finally {
    server.restore();
    forget();
  }
});

test('a duplicated identifier and a repeated member are one item and do not extend the window', async () => {
  forget();
  const context = liveContext('carbon-telegram-growing-', { album_quiet_ms: 300 });
  const album = Array.from({ length: 4 }, (_, index) =>
    photoUpdate(921001 + index, 311 + index, 'growing-album'));
  const script = [
    [album[0], album[1], album[1]],           // the same identifier twice in one answer
    [album[0], album[1], album[2], album[3]], // the tail, inside the window
    [album[0], album[1], album[2], album[3]]  // the same four again: nothing new
  ];
  const server = scriptedServerOf({ respond: ({ call }) => script[call - 1] ?? [] });

  try {
    await arrivals(context);
    const { items } = await waitForBatch(context);
    assert.deepEqual(idsOf(items), album.map((one) => one.update_id));
    assert.equal(server.asked[0].ids.length, 3, 'the first answer did not carry the duplicate');
    assert.ok(Date.parse(items[0].received_at) < Date.parse(items[2].received_at),
      'the tail was not seen after the head');
    assert.ok(Date.parse(items[2].received_at) < server.asked[2].at,
      'the repeat reset the tail\'s first-sight time, which would hold the window open');
    assert.equal(server.fetched.size, 4);
    assert.deepEqual([...new Set(server.fetched.values())], [1]);
  } finally {
    server.restore();
    forget();
  }
});

test('a failed repeat ask loses no retained photo and fetches nothing before the album settles', async () => {
  forget();
  const context = liveContext('carbon-telegram-retained-retry-');
  const album = Array.from({ length: 6 }, (_, index) =>
    photoUpdate(922001 + index, 321 + index, 'retry-album'));
  const server = scriptedServerOf({
    failCall: 2,
    respond: ({ call }) => (call === 1 ? album : (call === 3 ? [album[5]] : []))
  });

  try {
    await arrivals(context);
    const { items, fault } = await waitForBatch(context, { acceptFault: true });
    assert.ok(fault instanceof TelegramFault, 'the failed repeat ask was not exposed as a channel fault');
    assert.deepEqual(idsOf(items), album.map((one) => one.update_id));
    for (const item of items) {
      assert.ok(Date.parse(item.received_at) < server.asked[1].at,
        'a photo was rebuilt with a time after the failed ask');
    }
    assert.deepEqual([...new Set(server.asked.map((one) => one.offset))], [null],
      'an offset moved while the poll was failing');
    const settledAt = server.asked.at(-1).at;
    assert.ok(server.media.length > 0);
    assert.ok(Math.min(...server.media.map((one) => one.at)) >= settledAt,
      'media was fetched before the membership settled');
    assert.equal(server.fetched.size, 6);
    assert.deepEqual([...new Set(server.fetched.values())], [1]);
  } finally {
    server.restore();
    forget();
  }
});

test('the next ask is one past what was handed over, and only once the whole batch is consumed', async () => {
  forget();
  const context = liveContext('carbon-telegram-partial-consume-');
  // Observed out of order, and a photo of a second album arrives only after the
  // first batch is confirmed; the server replays the confirmed updates anyway.
  const first = [update(940003, 403, 'third'), update(940001, 401, 'first'), update(940002, 402, 'second')];
  const later = photoUpdate(940004, 404, 'second-album');
  const server = scriptedServerOf({
    filtered: false,
    respond: ({ offset }) => (offset === null ? first : [...first, later])
  });

  try {
    await arrivals(context);
    const { items } = await waitForBatch(context);
    assert.deepEqual(idsOf(items), [940001, 940002, 940003], 'the batch was not handed over in update-id order');

    // Real capture, and nothing consumed: the records are on disk and the offset
    // has not moved.
    const pending = captureBatch(context, items);
    assert.equal(pending.length, 3);
    assert.equal(context.store.rebuild().filter((one) => one.direction === 'inbound').length, 3);
    assert.equal(nextOffset(context.store, context.account), null);

    adapter.consume({ ...context, items }, items[0]);
    assert.equal(nextOffset(context.store, context.account), 940002);
    const asksSoFar = server.asked.length;
    await sleep(IDLE_MS * 4);
    assert.equal(server.asked.length, asksSoFar,
      'the worker asked again while the handed batch was only partly consumed');

    for (const item of items.slice(1)) adapter.consume({ ...context, items }, item);
    assert.equal(nextOffset(context.store, context.account), 940004);

    const { items: second } = await waitForBatch(context);
    assert.deepEqual(idsOf(second), [940004],
      'the later batch carried updates the store had already confirmed');
    assert.ok(server.asked.slice(asksSoFar).every((one) => one.offset === 940004),
      `the next ask was not one past the handed maximum: ${JSON.stringify(server.asked)}`);
  } finally {
    server.restore();
    forget();
  }
});

test('a restart before the handoff loses nothing, and a restart after consumption repeats nothing', async () => {
  forget();
  const context = liveContext('carbon-telegram-restart-', { album_quiet_ms: 400 });
  const album = Array.from({ length: 6 }, (_, index) =>
    photoUpdate(950001 + index, 331 + index, 'restart-album'));
  const fresh = photoUpdate(950010, 341, null);
  const server = scriptedServerOf({
    respond: ({ offset }) => (offset === null ? album : [fresh])
  });

  try {
    // The process dies while the album is still settling: nothing was handed
    // over, so nothing was captured and no offset moved.
    await arrivals(context);
    await sleep(IDLE_MS);
    await stop(context);
    assert.equal(context.store.rebuild().length, 0, 'a record was written before the handoff');
    assert.equal(nextOffset(context.store, context.account), null);

    // The same store, a new worker, and a server still holding what it never
    // confirmed.
    await arrivals(context);
    const { items } = await waitForBatch(context);
    assert.deepEqual(idsOf(items), album.map((one) => one.update_id));
    const pending = captureBatch(context, items);
    for (const item of pending) adapter.consume({ ...context, items }, item);
    const inbound = context.store.rebuild().filter((one) => one.direction === 'inbound');
    assert.equal(inbound.length, 6, 'the album was captured more than once');
    assert.equal(new Set(inbound.map((one) => one.message_id)).size, 6);
    assert.equal(nextOffset(context.store, context.account), 950007);

    // And a restart after all of it was consumed asks past it and takes the next
    // upload on its own.
    await stop(context);
    await arrivals(context);
    const { items: after } = await waitForBatch(context);
    assert.deepEqual(idsOf(after), [950010], 'the confirmed album came back after the restart');
  } finally {
    server.restore();
    forget();
  }
});

test('retained ordinary messages and two chats survive a changing set of answers', async () => {
  forget();
  const context = liveContext('carbon-telegram-mixed-', { album_quiet_ms: 300 });
  const other = 998877665;
  const mixed = [
    update(960001, 351, 'a question', other),
    photoUpdate(960002, 352, 'mixed-album'),
    update(960003, 353, 'a second question'),
    photoUpdate(960004, 354, 'mixed-album'),
    update(960005, 355, 'a third question', other),
    photoUpdate(960006, 356, 'other-album', other)
  ];
  const script = [mixed.slice(0, 2), mixed.slice(2, 4), mixed.slice(4, 6), [mixed[1]]];
  const server = scriptedServerOf({ respond: ({ call }) => script[call - 1] ?? [] });

  try {
    await arrivals(context);
    const { items } = await waitForBatch(context);
    assert.deepEqual(idsOf(items), mixed.map((one) => one.update_id),
      'a retained update was dropped or collapsed by its media group');
    assert.deepEqual(items.map((one) => one.conversation),
      [String(other), '887766554', '887766554', '887766554', String(other), String(other)]);

    captureBatch(context, items);
    const inbound = context.store.rebuild().filter((one) => one.direction === 'inbound');
    assert.equal(inbound.length, 6);
    assert.equal(new Set(inbound.map((one) => one.conversation_id)).size, 2, 'the two chats were joined');
    assert.deepEqual(inbound.filter((one) => one.adapter_fields?.media_group_id === 'mixed-album')
      .map((one) => one.platform_message_id).sort(), ['352', '354']);
    assert.deepEqual(inbound.filter((one) => one.adapter_fields?.media_group_id === 'other-album')
      .map((one) => one.platform_message_id), ['356']);
  } finally {
    server.restore();
    forget();
  }
});

test('photographs sent one at a time stay in separate batches and wait for no album', async () => {
  forget();
  const context = liveContext('carbon-telegram-individual-');
  const singles = Array.from({ length: 6 }, (_, index) => photoUpdate(970001 + index, 361 + index, null));
  const server = scriptedServerOf({
    respond: ({ call }) => (call <= singles.length ? [singles[call - 1]] : [])
  });

  try {
    await arrivals(context);
    const handed = [];
    for (let i = 0; i < singles.length; i++) {
      const { items } = await waitForBatch(context);
      handed.push(idsOf(items));
      const pending = captureBatch(context, items);
      for (const item of pending) adapter.consume({ ...context, items }, item);
    }
    assert.deepEqual(handed, singles.map((one) => [one.update_id]),
      'uploads that arrived in separate answers were joined into one batch');
    assert.equal(server.asked.length, singles.length,
      `a photo with no album waited for one: ${JSON.stringify(server.asked.map((one) => one.ids))}`);
    const inbound = context.store.rebuild().filter((one) => one.direction === 'inbound');
    assert.equal(inbound.length, 6);
    assert.equal(inbound.filter((one) => one.adapter_fields?.media_group_id !== undefined).length, 0);
  } finally {
    server.restore();
    forget();
  }
});
