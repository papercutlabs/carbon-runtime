import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN = path.join(ROOT, 'tools', 'scan-identifiers.ts');

function scan(dir: string) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCAN, dir], { encoding: 'utf8' }) };
  } catch (error) {
    assert.ok(typeof error === 'object' && error !== null && 'status' in error && 'stdout' in error);
    const out = error.stdout ?? '';
    assert.ok(typeof out === 'string');
    return { code: error.status, out };
  }
}

test('this tree names no client, no internal system, no machine and no person', () => {
  const result = scan(ROOT);
  assert.equal(result.code, 0, result.out);
});

test('the scan matches a whole word and not a fragment of one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-scan-'));
  fs.writeFileSync(path.join(dir, 'innocent.md'), 'git archive builds the tarball, and the hivemind is elsewhere\n');
  assert.equal(scan(dir).code, 0, 'a word that merely contains a denied word was treated as a hit');

  // The denied word is built from pieces, so this test file does not itself
  // carry the word the scan refuses.
  const denied = 'stu' + 'dio';
  fs.writeFileSync(path.join(dir, 'guilty.md'), `this page was written on the ${denied}\n`);
  const guilty = scan(dir);
  assert.equal(guilty.code, 1);
  assert.match(guilty.out, /guilty\.md:1/);
  assert.doesNotMatch(guilty.out, new RegExp(denied), 'the fault repeated the word it refuses');
});

test('nothing in this tree can take a client\'s records away', () => {
  for (const dir of ['stream', 'adapters', 'import', 'conformance', 'bin']) {
    const walk = (at: string): void => {
      for (const name of fs.readdirSync(at)) {
        const full = path.join(at, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /prune|retention/i, `${full} carries a path that drops records`);
      }
    };
    walk(path.join(ROOT, dir));
  }
});

test('the scan refuses walks with no candidate files after exclusions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-scan-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cases = [
    [],
    ['.git/ignored.txt', 'node_modules/ignored.txt', 'dist/ignored.txt'],
    ['image.PNG', 'nested/archive.zip'],
    ['schema/carbon.message.v1.json', 'schema/carbon.teaching.v1.json']
  ];
  for (const [index, files] of cases.entries()) {
    const dir = path.join(root, String(index));
    fs.mkdirSync(dir);
    for (const file of files) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
    const empty = scan(dir);
    assert.equal(empty.code, 1, `walk ${index} passed without reading a candidate file`);
    assert.deepEqual(JSON.parse(empty.out), {
      code: 'IDENTIFIER_SCAN_EMPTY', subject: dir,
      problem: 'the identifier scan read no candidate files after exclusions',
      fix: 'point the scan at a tree containing at least one text file outside the exclusions'
    });
    fs.writeFileSync(path.join(dir, 'empty.txt'), '');
    assert.deepEqual(scan(dir), { code: 0, out: '' }, 'an empty text file counts as a file read');
  }
});

 test('exact published interface names are classified without exempting lines or lookalikes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'carbon-published-token-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'interface.txt');
  const tokens=['@pcl/routes','@pcl/routes/cli','@pcl/routes/mcp','@pcl/routes/generate','node_modules/@pcl/routes','vendor/pcl-routes-0.1.2.tgz','pcl.routes.v1','PCL_API_TOKEN','PCL_API_URL','PCL_API_SCOPES'];
  fs.writeFileSync(file,tokens.map(token=>JSON.stringify(token)).join('\n'));assert.equal(scan(dir).code,0);fs.writeFileSync(file,'Schema pcl.routes.v1. Application version 0.1.0.');assert.equal(scan(dir).code,0);
  const denied='stu'+'dio';fs.writeFileSync(file,'PCL_API_TOKEN '+denied);assert.equal(scan(dir).code,1,'published token does not exempt a nearby private name');
  for(const token of tokens){for(const lookalike of ['prefix/'+token,token+'.unqualified']){fs.writeFileSync(file,lookalike);assert.equal(scan(dir).code,1,'unqualified published lookalike passed');}}
  fs.writeFileSync(file,denied);assert.equal(scan(dir).code,1);
 });
