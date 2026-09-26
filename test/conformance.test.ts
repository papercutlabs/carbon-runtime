import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHECK = path.join(ROOT, 'bin', 'carbon-stream');
const FIXTURE_ADAPTER = path.join(ROOT, 'adapters', 'fixture');
const FIXTURES = path.join(FIXTURE_ADAPTER, 'fixtures');
const BROKEN = path.join(ROOT, 'test', 'fixtures', 'broken-adapter');

function check(args: string[]) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' }) };
  } catch (error) {
    // execFileSync supplies these fields on command failure; absent fields retain the original fallback.
    return { code: (error as { status?: number }).status, out: ((error as { stdout?: string }).stdout ?? '') + ((error as { stderr?: string }).stderr ?? '') };
  }
}

test('the fixture adapter passes all twenty-four cases', () => {
  const result = check(['check', '--adapter', FIXTURE_ADAPTER, '--fixtures', FIXTURES]);
  assert.equal(result.code, 0, result.out);
  const passes = result.out.split('\n').filter((line) => / pass /.test(line));
  assert.equal(passes.length, 24, result.out);
  for (let number = 1; number <= 24; number++) {
    assert.match(result.out, new RegExp(`case\\s+${number}\\s+pass`), `case ${number} did not pass`);
  }
});

test('a deliberately broken adapter fails the case its break belongs to', () => {
  const result = check(['check', '--adapter', BROKEN, '--fixtures', FIXTURES]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /case\s+1\s+FAIL\s+the same inbound twice writes one record/);
  // It declares inbound alone, so the outbound and import cases never run.
  assert.doesNotMatch(result.out, /case\s+7\s/);
  assert.doesNotMatch(result.out, /case\s+6\s/);
});

test('the check runs only the cases the adapter declared a capability for', () => {
  const result = check(['check', '--adapter', BROKEN, '--fixtures', FIXTURES]);
  assert.match(result.out, /of 24 cases apply to \[inbound\]/);
});

test('every command carries its manual and refuses a guess', () => {
  const help = check(['check', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--adapter/);
  assert.match(help.out, /The twenty-four cases:/);

  const missing = check(['check', '--adapter', FIXTURE_ADAPTER]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /MISSING_ARGUMENT/);
  for (const line of missing.out.split('\n').filter(Boolean)) {
    const fault: unknown = JSON.parse(line);
    // Object.keys examines the parsed value as it is, including its existing null failure.
    assert.deepEqual(Object.keys(fault as object).sort(), ['code', 'fix', 'problem', 'subject']);
  }
});

test('--store runs the rebuild against the index on a live store', () => {
  const result = check(['check', '--store', path.join(ROOT, 'test', 'fixtures', 'store-that-is-not-there')]);
  assert.equal(result.code, 1);
  assert.match(result.out, /STORE_MISSING/);
});

test('ingest guarantees the common schema, not a store specialization', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-conformance-types-'));
  const probe = path.join(dir, 'probe.ts');
  const config = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(config, JSON.stringify({
    extends: path.join(ROOT, 'tsconfig.json'),
    compilerOptions: { typeRoots: [path.join(ROOT, 'node_modules', '@types')] },
    files: [probe], include: []
  }));
  const declarations = [
    `import { ingest } from ${JSON.stringify(path.join(ROOT, 'conformance/cases.ts'))};`,
    `import type { Store, MessageRecord } from ${JSON.stringify(path.join(ROOT, 'stream/store.ts'))};`,
    'declare const store: Store<MessageRecord & { review_required: string; body: "specialized" }>;',
    'declare const candidate: MessageRecord;',
    'const adapter = { payload(_context: { account: string }, items: MessageRecord[]) {',
    '  return { entries: items.map(record => ({ record })), parked: [] };',
    '} };',
    'const context = { store, adapter, account: "fixture" };',
    'const parking = { ...context, adapter: { payload(_context: { account: string }, items: MessageRecord[]) {',
    '  return { entries: [], parked: items.map(record => ({ record, reason: "fixture" })) };',
    '} } };'
  ];
  const check = (lines: string[]) => {
    fs.writeFileSync(probe, [...declarations, ...lines].join('\n'));
    return spawnSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'),
      '--project', config, '--pretty', 'false'], { encoding: 'utf8' });
  };
  try {
    // These probes are compiled only. Neither capture nor park checks a store's
    // additional required property or its narrower body type.
    const unsafe = [
      'const inventedCapture: string = ingest(context, [candidate])[0].record.review_required;',
      'const inventedPark: string = ingest(parking, [candidate])[0].record.review_required;',
      'const inventedRefinement: "specialized" = ingest(context, [candidate])[0].record.body;',
      'ingest({ ...context, account: 7 }, [candidate]);',
      'ingest(context, [7]);'
    ];
    const rejected = check(unsafe);
    assert.notEqual(rejected.status, 0, 'an unsafe ingest contract passed the checker');
    for (let i = 0; i < unsafe.length; i++) {
      assert.match(rejected.stdout, new RegExp(`probe\\.ts\\(${declarations.length + i + 1},\\d+\\): error TS(?:2322|2345):`),
        `the checker did not reject ${unsafe[i]}\n${rejected.stdout}${rejected.stderr}`);
    }
    const accepted = check([
      'const captured = ingest(context, [candidate])[0].record;',
      'const parked = ingest(parking, [candidate])[0].record;',
      'const capturedExtra: unknown = captured.review_required;',
      'const parkedExtra: unknown = parked.review_required;',
      'const commonBody: string = captured.body;',
      'if (typeof captured.review_required === "string") { const checked: string = captured.review_required; }'
    ]);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
