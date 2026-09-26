// Roles in mapping JSON are not checked by either mapping validator. Payloads
// must expose that uncertainty until the store validates the complete record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, StreamFault } from '../stream/store.ts';
import { mappingFaults, readMapping, roleFor, normaliseRow } from '../import/ledger-mapping.ts';
import { outboundFaults, itemFrom } from '../import/outbound-mapping.ts';
import * as ledger from '../import/carbon-ledger-sqlite.ts';
import * as outbound from '../import/carbon-ledger-outbound.ts';
import type { LedgerMapping, OutboundMapping } from '../import/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('unchecked mapping roles and payload roles cannot be used as strings before store validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-import-role-types-'));
  const probe = path.join(dir, 'probe.ts');
  const config = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(config, JSON.stringify({
    extends: path.join(ROOT, 'tsconfig.json'),
    compilerOptions: { typeRoots: [path.join(ROOT, 'node_modules', '@types')] },
    files: [probe], include: []
  }));
  const imports = [
    `import { readMapping, roleFor } from ${JSON.stringify(path.join(ROOT, 'import/ledger-mapping.ts'))};`,
    `import * as ledger from ${JSON.stringify(path.join(ROOT, 'import/carbon-ledger-sqlite.ts'))};`,
    `import * as outbound from ${JSON.stringify(path.join(ROOT, 'import/carbon-ledger-outbound.ts'))};`,
    `import type { RoleMapping, OutboundMapping } from ${JSON.stringify(path.join(ROOT, 'import/types.ts'))};`,
    'declare const mappingFile: string;',
    'declare const outboundMapping: OutboundMapping;'
  ];
  const check = (lines: string[]) => {
    fs.writeFileSync(probe, [...imports, ...lines].join('\n'));
    return spawnSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'),
      '--project', config, '--pretty', 'false'], { encoding: 'utf8' });
  };
  try {
    // These source strings are checked, never executed; the candidate casts
    // inspect the exported payload types without constructing runtime records.
    const unsafe = [
      'roleFor(readMapping(mappingFile), { from_me: true }).toUpperCase();',
      'roleFor(readMapping(mappingFile), { from_me: false }).toUpperCase();',
      'roleFor(outboundMapping, { from_me: true }).toUpperCase();',
      'roleFor(outboundMapping, { from_me: false }).toUpperCase();',
      "({} as ReturnType<typeof ledger.payload>).entries[0].record.role.toUpperCase();",
      "({} as ReturnType<typeof outbound.payload>).entries[0].record.role.toUpperCase();"
    ];
    const rejected = check(unsafe);
    assert.notEqual(rejected.status, 0, 'unsafe role string operations passed the checker');
    for (let i = 0; i < unsafe.length; i++) {
      assert.match(rejected.stdout, new RegExp(`probe\\.ts\\(${imports.length + i + 1},\\d+\\): error TS(?:2339|2571|18046):`),
        `the checker did not reject ${unsafe[i]}\n${rejected.stdout}${rejected.stderr}`);
    }
    const accepted = check([
      'const numericRoles: RoleMapping = { roles: { from_me: 7, default: 8 } };',
      'const fromMapping: unknown = roleFor(readMapping(mappingFile), { from_me: true });',
      'const fromOutbound: unknown = roleFor(outboundMapping, { from_me: true });'
    ]);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('numeric mapping roles remain unchanged in payloads and receive the existing store fault', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-import-numeric-roles-'));
  try {
    const mapping: LedgerMapping & OutboundMapping = {
      roles: { from_me: 7, default: 8 },
      messages: { table: 'messages', columns: {
        platform_message_id: 'id', chat_key: 'chat', timestamp: 'at'
      } },
      outbound: { events: { fields: {
        platform_message_id: 'id', chat_key: 'chat', timestamp: 'at', body: 'text'
      } } }
    };
    const file = path.join(dir, 'mapping.json');
    fs.writeFileSync(file, JSON.stringify(mapping));
    assert.deepEqual(mappingFaults(mapping), []);
    assert.deepEqual(outboundFaults(mapping), []);
    const parsed = readMapping(file);
    assert.equal(roleFor(parsed, { from_me: true }), 7);
    assert.equal(roleFor(parsed, { from_me: false }), 8);
    const context = {
      store: Store.open(path.join(dir, 'store')), agent: 'agent-01',
      account: '15550009999@s.whatsapp.net', mapping,
      lid_map: { phone_to_lid: {}, lid_to_phone: {} }
    };
    const row = { platform_message_id: 'm1', chat_key: '15550001111@s.whatsapp.net',
      timestamp: 1735689600, body: 'history', from_me: 1 };
    const sent = normaliseRow(parsed, row);
    const received = normaliseRow(parsed, { ...row, from_me: 0 });
    assert.equal(ledger.payload(context, [sent]).entries[0].record.role, 7);
    assert.equal(ledger.payload(context, [received]).entries[0].record.role, 8);
    const mark = itemFrom('event', { fields: { platform_message_id: 'id', chat_key: 'chat',
      timestamp: 'at', body: 'text' } },
    { id: 'm2', chat: row.chat_key, at: row.timestamp, text: 'reply' });
    assert.equal(outbound.payload(context, [mark]).entries[0].record.role, 7);
    for (const write of [() => ledger.writeBatch(context, [sent]),
      () => ledger.writeBatch(context, [received]), () => outbound.writeBatch(context, [mark])]) {
      assert.throws(write, (error: unknown) => error instanceof StreamFault
        && error.faults.some((one) => one.code === 'VALUE_NOT_IN_ENUM' && one.subject.includes('$.role')));
    }
    assert.deepEqual(context.store.rebuild(), [], 'a malformed role wrote a record');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
