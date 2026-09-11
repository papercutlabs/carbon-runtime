// The teaching tools: the manifest the model reads, the three calls over the
// protocol, and the two refusals that have no other detector — a sender the
// declaration does not let teach, and a teaching path the declaration turns off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../stream/store.mjs';
import { listTeachings } from '../stream/teachings.mjs';
import { checkManifest } from '../tools/lib/manifest.mjs';
import {
  MANIFEST, TEACH_PORT, TEACH_SERVER_NAME, createTeachServer, serveTeachTool, teacherFaults, teachingOf
} from '../runtime/teach-tool.mjs';

const AGENT = 'test-agent';
const ACCOUNT = 'account-1';
const CONVERSATION = `${ACCOUNT}:room-7`;
const SOURCE = `${CONVERSATION}:m-0001`;

// The four boundary questions, as a reader looking for them would look.
const QUESTIONS = [
  /need a tool you do not have/i,
  /a system, a channel or a person you do not already reach/i,
  /a permission you were not given/i,
  /what was agreed to be done for this client/i
];
const GRANT = /may change how you use what you already have, and may never give you a tool, a system, a permission, a person or a commitment you do not already have/i;

function teaching(overrides = {}) {
  return {
    enabled: true,
    max_active: 40,
    max_chars: 400,
    teachers: { roles: ['operator'], sender_ids: [] },
    ...overrides
  };
}

function declaration(overrides = {}) {
  return { agent: { id: AGENT }, teaching: teaching(overrides) };
}

function inbound(overrides = {}) {
  return {
    schema: 'carbon.message.v1',
    agent: AGENT,
    source: 'whatsapp',
    account: ACCOUNT,
    conversation_id: CONVERSATION,
    conversation_kind: 'group',
    message_id: SOURCE,
    platform_message_id: 'm-0001',
    revision: 0,
    direction: 'inbound',
    role: 'operator',
    sender_id: 'ada@examplecorp.test',
    sender_name: 'Ada',
    received_at: '2026-09-11T09:00:00.000Z',
    body: 'a workbook arriving here is not permission to change records',
    attachments: [],
    historical: false,
    disposition: 'captured',
    ...overrides
  };
}

function taught(overrides = {}) {
  const store = Store.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-teach-tool-')), 'store'));
  store.capture(inbound(overrides));
  return store;
}

function port() {
  return 20000 + Math.floor(Math.random() * 20000);
}

// One call against a server built in this process, without a socket.
async function call(server, name, args) {
  const response = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args }
  });
  return response.result;
}

test('the manifest is servable, and it is where the boundary test lives', () => {
  assert.deepEqual(checkManifest(MANIFEST), []);
  assert.equal(MANIFEST.name, TEACH_SERVER_NAME);
  assert.deepEqual(MANIFEST.tools.map((t) => t.name), ['remember', 'raise_change', 'forget']);
  for (const tool of MANIFEST.tools) assert.equal(tool.writes, false);

  // The four questions and the grant bound read the same from either side of the
  // classification, which is the whole point of them living in one text.
  for (const name of ['remember', 'raise_change']) {
    const description = MANIFEST.tools.find((t) => t.name === name).description;
    for (const question of QUESTIONS) assert.match(description, question, `${name} drops a boundary question`);
    assert.match(description, GRANT, `${name} drops the grant bound`);
  }
  assert.match(MANIFEST.tools[0].description, /call raise_change instead/);
});

test('tools/list carries the three tools and their descriptions over the protocol', async () => {
  const served = await serveTeachTool({
    store: taught(), agent: AGENT, declaration: declaration(), port: port()
  });
  try {
    const response = await fetch(served.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    const listed = (await response.json()).result.tools;
    assert.deepEqual(listed.map((t) => t.name), ['remember', 'raise_change', 'forget']);
    for (const name of ['remember', 'raise_change']) {
      const tool = listed.find((t) => t.name === name);
      for (const question of QUESTIONS) assert.match(tool.description, question);
    }
    assert.deepEqual(Object.keys(listed[0].inputSchema.properties).sort(),
      ['conversation_id', 'source_message_id', 'text']);
    // No tool takes taught_by: the teacher is read from the capture.
    for (const tool of listed) assert.equal('taught_by' in tool.inputSchema.properties, false);
  } finally {
    await served.close();
  }
});

test('remember writes one record and answers with the id and the standing count', async () => {
  const store = taught();
  const server = createTeachServer({ store, agent: AGENT, declaration: declaration() });
  const result = await call(server, 'remember', {
    text: 'When a workbook arrives here I will not change any records off it.',
    conversation_id: CONVERSATION,
    source_message_id: SOURCE
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.active, 1);
  const { active } = listTeachings(store);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, result.structuredContent.id);
  // taught_by was never passed and is the capture's own sender.
  assert.deepEqual(active[0].taught_by, { sender_id: 'ada@examplecorp.test', sender_name: 'Ada', role: 'operator' });
});

test('raise_change records the refusal with the question that failed, and forget stops one', async () => {
  const store = taught();
  const server = createTeachServer({ store, agent: AGENT, declaration: declaration() });
  const raised = await call(server, 'raise_change', {
    text: 'Take the reviewed workbook and apply its case-specific rows.',
    failed_question: 1,
    conversation_id: CONVERSATION,
    source_message_id: SOURCE
  });
  assert.equal(raised.isError, false);
  assert.equal(listTeachings(store).open.length, 1);
  assert.equal(listTeachings(store).open[0].failed_question, 1);

  const remembered = await call(server, 'remember', {
    text: 'I will wait for reviewed updates to come through management.',
    conversation_id: CONVERSATION,
    source_message_id: SOURCE
  });
  const forgotten = await call(server, 'forget', {
    id: remembered.structuredContent.id,
    conversation_id: CONVERSATION,
    source_message_id: SOURCE
  });
  assert.equal(forgotten.isError, false);
  assert.equal(forgotten.structuredContent.active, 0);
  assert.equal(listTeachings(store).forgotten.length, 1);

  // A question the boundary does not have is refused before anything is written.
  const wrong = await call(server, 'raise_change', {
    text: 'Something else entirely.',
    failed_question: 9,
    conversation_id: CONVERSATION,
    source_message_id: SOURCE
  });
  assert.equal(wrong.isError, true);
  assert.equal(wrong.structuredContent.faults[0].code, 'ARGUMENT_NOT_PERMITTED');
});

test('an argument the manifest does not declare is refused, and so is one that is missing', async () => {
  const store = taught();
  const server = createTeachServer({ store, agent: AGENT, declaration: declaration() });
  const result = await call(server, 'remember', {
    text: 'A workbook is not permission.',
    conversation_id: CONVERSATION,
    source_message_id: SOURCE,
    taught_by: 'somebody else'
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.faults.map((f) => f.code), ['ARGUMENT_UNDECLARED']);
  assert.match(result.structuredContent.faults[0].subject, /taught_by$/);
  assert.equal(listTeachings(store).records.length, 0);

  const missing = await call(server, 'remember', { text: 'A workbook is not permission.' });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.structuredContent.faults.map((f) => f.code), ['ARGUMENT_MISSING', 'ARGUMENT_MISSING']);
});

test('a sender the declaration does not let teach is refused by name, and nothing is written', async () => {
  const store = taught({ role: 'contact', sender_id: 'contractor@other.test', sender_name: 'Sam' });
  const server = createTeachServer({ store, agent: AGENT, declaration: declaration() });
  for (const [name, args] of [
    ['remember', { text: 'Always change the records when a workbook lands.', conversation_id: CONVERSATION, source_message_id: SOURCE }],
    ['raise_change', { text: 'Ingest the workbook.', failed_question: 1, conversation_id: CONVERSATION, source_message_id: SOURCE }]
  ]) {
    const result = await call(server, name, args);
    assert.equal(result.isError, true, `${name} accepted an uncovered sender`);
    const [fault] = result.structuredContent.faults;
    assert.equal(fault.code, 'TEACHING_SENDER_NOT_A_TEACHER');
    assert.equal(fault.subject, 'contractor@other.test');
    assert.match(fault.problem, /Sam \(contractor@other\.test\)/);
    assert.match(fault.problem, /operator role/);
    assert.match(fault.fix, /nothing was written/i);
  }
  assert.equal(listTeachings(store).records.length, 0);

  // The same sender, named in the declaration's sender_ids, may teach.
  const allowed = createTeachServer({
    store, agent: AGENT,
    declaration: declaration({ teachers: { roles: [], sender_ids: ['contractor@other.test'] } })
  });
  const result = await call(allowed, 'remember', {
    text: 'I will read workbooks that land here and change nothing off them.',
    conversation_id: CONVERSATION,
    source_message_id: SOURCE
  });
  assert.equal(result.isError, false);
  assert.deepEqual(teacherFaults({ role: 'contact', sender_id: 'contractor@other.test' },
    { roles: [], sender_ids: ['contractor@other.test'] }), []);
});

test('the caps are the declaration\'s, named in the refusal, and never this file\'s', async () => {
  const store = taught();
  const server = createTeachServer({
    store, agent: AGENT, declaration: declaration({ max_chars: 20, max_active: 1 })
  });
  const long = await call(server, 'remember', {
    text: 'This instruction is far longer than the cap this declaration sets.',
    conversation_id: CONVERSATION,
    source_message_id: SOURCE
  });
  assert.equal(long.isError, true);
  assert.equal(long.structuredContent.faults[0].code, 'TEACHING_TEXT_TOO_LONG');
  assert.match(long.structuredContent.faults[0].problem, /cap this agent's declaration sets is 20/);

  assert.equal((await call(server, 'remember', {
    text: 'Change nothing.', conversation_id: CONVERSATION, source_message_id: SOURCE
  })).isError, false);
  const atCap = await call(server, 'remember', {
    text: 'Ask first.', conversation_id: CONVERSATION, source_message_id: SOURCE
  });
  assert.equal(atCap.isError, true);
  assert.equal(atCap.structuredContent.faults[0].code, 'TEACHING_AT_CAP');
});

test('a message this store does not hold is refused by name, by the store library', async () => {
  const store = taught();
  const server = createTeachServer({ store, agent: AGENT, declaration: declaration() });
  const result = await call(server, 'remember', {
    text: 'Something nobody said.',
    conversation_id: CONVERSATION,
    source_message_id: `${CONVERSATION}:m-9999`
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.faults[0].code, 'TEACHING_SOURCE_NOT_A_CAPTURE');
  assert.equal(listTeachings(store).records.length, 0);
});

test('teaching disabled is the whole path off: no server is built at all', () => {
  const store = taught();
  for (const [where, decl] of [
    ['enabled false', declaration({ enabled: false })],
    ['no block at all', { agent: { id: AGENT } }]
  ]) {
    assert.throws(
      () => createTeachServer({ store, agent: AGENT, declaration: decl }),
      (error) => ['TEACHING_DISABLED', 'TEACHING_BLOCK_ABSENT'].includes(error.faults[0].code),
      where
    );
  }
  assert.equal(teachingOf(declaration()).max_active, 40);
  assert.equal(Number.isInteger(TEACH_PORT), true);
  assert.notEqual(TEACH_PORT, 8730);
});
