import test from 'node:test';import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { indexEvidenceRepresentation, resolveEvidenceFragment } from '../runtime/browser-evidence-representation.ts';
test('actual varied immutable bytes resolve text/comment fields/quoted rows/full image and derived chart without semantic claims', () => {
 const log=Buffer.from(Array.from({length:40000},(_,i)=>`line-${i+1}: observed-value-${i}`).join('\n'));
 const text=indexEvidenceRepresentation(log,'text/plain','incident.log');const fragment=resolveEvidenceFragment(text,{kind:'lines',start:31999,end:32001},2,2,10);assert.equal(fragment.kind,'text');assert.equal(fragment.lines![2].text,'line-31999: observed-value-31998');assert.equal(fragment.total,40000);
 const comments=Buffer.from(JSON.stringify({startAt:1,total:3,comments:[{id:'comment-v2',body:{type:'doc',content:[{type:'paragraph',text:'Original body retained'}]},updated:'2026-10-07T01:02:03Z'}]}));
 const json=indexEvidenceRepresentation(comments,'application/json','comments.json'),field=resolveEvidenceFragment(json,{kind:'field',pointer:'/comments/0/body/content/0/text'},0,0,4);assert.equal(field.value,'Original body retained');assert.equal(json.fields && typeof json.fields==='object' && !Array.isArray(json.fields) ? json.fields.total : null,3);
 const csv=indexEvidenceRepresentation(Buffer.from('id,unit,value\r\nalpha,seconds,58\r\n"beta,quoted",minutes,27\r\n'),'text/csv','observations.csv');assert.deepEqual(resolveEvidenceFragment(csv,{kind:'rows',start:2,end:2},1,0,2).rows![1].cells,['beta,quoted','minutes','27']);
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8kAAAAASUVORK5CYII=','base64');
 const full=indexEvidenceRepresentation(image,'image/png','screenshot.png'),region=resolveEvidenceFragment(full,{kind:'region',x:0,y:0,width:.5,height:.5},0,0,1);assert.equal(region.kind,'image');assert.equal(region.width,1);assert.equal(full.sha256,indexEvidenceRepresentation(image,'image/png','derived-chart.png').sha256,'representation indexes exact bytes; origin is trusted custody, never inferred from filename');
 assert.throws(()=>resolveEvidenceFragment(text,{kind:'lines',start:40000,end:40001},0,0,10),/outside/);assert.throws(()=>resolveEvidenceFragment(json,{kind:'field',pointer:'/comments/9/body'},0,0,10),/no such/);assert.throws(()=>resolveEvidenceFragment(full,{kind:'region',x:.8,y:0,width:.5,height:.5},0,0,1),/normalized/);
 const active=indexEvidenceRepresentation(Buffer.from('<script>throw 1</script>'),'text/html','analysis.html');assert.equal(active.kind,'file');assert.match(active.limitation!,/download/);
});

test('selected result mutations cannot poison reused representation indexes',()=>{
 const rep=indexEvidenceRepresentation(Buffer.from('id,value\nsource,7\n'),'text/csv','original.csv'),first=resolveEvidenceFragment(rep,{kind:'rows',start:1,end:1},0,0,1);first.rows![0].cells[1]='forged';first.columns![0]='forged';const next=resolveEvidenceFragment(rep,{kind:'rows',start:1,end:1},0,0,1);assert.deepEqual(next.rows![0].cells,['source','7']);assert.equal(next.columns![0],'id');
 const json=indexEvidenceRepresentation(Buffer.from('{"record":{"value":7}}'),'application/json','original.json'),field=resolveEvidenceFragment(json,{kind:'field',pointer:'/record'},0,0,1);(field.value as {value:number}).value=99;assert.equal((resolveEvidenceFragment(json,{kind:'field',pointer:'/record'},0,0,1).value as {value:number}).value,7);
});

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8kAAAAASUVORK5CYII=', 'base64');
function jpegBytes(width: number, height: number): Buffer {
 return Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x0B, 0x08, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xD9]);
}
function hex(bytes: Uint8Array): string { return Buffer.from(bytes).toString('hex'); }
function snapshot(bytes: Uint8Array, mime: string, filename: string) {
 const before = hex(bytes);
 let value: unknown, error: { name: string; message: string } | null = null;
 try { value = indexEvidenceRepresentation(bytes, mime, filename); }
 catch (e) { const err = e as Error; error = { name: err.name, message: err.message }; }
 assert.equal(hex(bytes), before, 'indexEvidenceRepresentation must leave caller bytes unchanged');
 return { value, error };
}
function accountPayloadCopies(bytes: Uint8Array, mime: string, filename: string) {
 const orig = Buffer.from;
 let copies = 0, bytesCopied = 0, otherBytes = 0;
 function patched(value: unknown, encodingOrOffset?: unknown, length?: unknown) {
  if (value === bytes) { copies += 1; bytesCopied += bytes.byteLength; }
  else if (Array.isArray(value)) otherBytes += value.length;
  else if (value instanceof Uint8Array) otherBytes += value.byteLength;
  return orig.call(Buffer, value as never, encodingOrOffset as never, length as never);
 }
 Object.defineProperty(Buffer, 'from', { value: patched, configurable: true, writable: true });
 try { return { result: indexEvidenceRepresentation(bytes, mime, filename), copies, bytesCopied, otherBytes }; }
 finally { Object.defineProperty(Buffer, 'from', { value: orig, configurable: true, writable: true }); }
}
function mulberry32(seed: number) {
 return function () {
  let t = seed += 0x6D2B79F5;
  t = Math.imul(t ^ t >>> 15, t | 1);
  t ^= t + Math.imul(t ^ t >>> 7, t | 61);
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
 };
}

test('non-image MIME paths keep original kinds, limitations, hashes and refuse active formats', () => {
 const cases: Array<{ bytes: Uint8Array; mime: string; filename: string; kind: string; limitation: string | null; extra?: (rep: ReturnType<typeof indexEvidenceRepresentation>) => void }> = [
  { bytes: Buffer.from('hello\nworld'), mime: 'text/plain', filename: 'a.txt', kind: 'text', limitation: null, extra: (rep) => assert.deepEqual(rep.lines, ['hello', 'world']) },
  { bytes: Buffer.from('{"a":1}'), mime: 'application/json', filename: 'a.json', kind: 'json', limitation: null, extra: (rep) => assert.deepEqual(rep.fields, { a: 1 }) },
  { bytes: Buffer.from('{'), mime: 'application/json', filename: 'a.json', kind: 'file', limitation: 'The received JSON is malformed; the unchanged original remains available.' },
  { bytes: Buffer.from('a,b\n1,2\n'), mime: 'text/csv', filename: 'a.csv', kind: 'table', limitation: null, extra: (rep) => { assert.deepEqual(rep.columns, ['a', 'b']); assert.deepEqual(rep.rows, [['1', '2']]); } },
  { bytes: Buffer.from('"unclosed'), mime: 'text/csv', filename: 'a.csv', kind: 'file', limitation: 'CSV quoting is unsupported or malformed; the unchanged original remains available.' },
  { bytes: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'), mime: 'application/pdf', filename: 'a.pdf', kind: 'file', limitation: 'No safe representation is selected for this media type; use the immutable original.' },
  { bytes: Buffer.from('<script>throw 1</script>'), mime: 'text/html', filename: 'analysis.html', kind: 'file', limitation: 'Active format is available only as an authenticated original download.' },
  { bytes: Buffer.from('<script>throw 1</script>'), mime: 'text/plain', filename: 'analysis.html', kind: 'file', limitation: 'Active format is available only as an authenticated original download.' },
  { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), mime: 'image/svg+xml', filename: 'a.svg', kind: 'file', limitation: 'Active format is available only as an authenticated original download.' },
  { bytes: Buffer.from('<root/>'), mime: 'application/xml', filename: 'a.xml', kind: 'file', limitation: 'Active format is available only as an authenticated original download.' },
  { bytes: Buffer.from('throw 1'), mime: 'application/javascript', filename: 'a.js', kind: 'file', limitation: 'Active format is available only as an authenticated original download.' },
  { bytes: Buffer.from('throw 1'), mime: 'text/javascript', filename: 'a.js', kind: 'file', limitation: 'Active format is available only as an authenticated original download.' },
  { bytes: Buffer.from('hello\0world'), mime: 'text/plain', filename: 'a.bin', kind: 'file', limitation: 'Binary content has no supported safe representation; use the immutable original.' },
  { bytes: Buffer.from([0xff, 0xfe, 0xfd]), mime: 'text/plain', filename: 'a.txt', kind: 'file', limitation: 'No safe text/image representation is supported; use the immutable original.' },
  { bytes: Buffer.from('{"z":9}'), mime: 'text/plain', filename: 'x.json', kind: 'json', limitation: null, extra: (rep) => assert.deepEqual(rep.fields, { z: 9 }) },
  { bytes: Buffer.from('a,b\n1,2\n'), mime: 'text/plain', filename: 'x.csv', kind: 'table', limitation: null },
  { bytes: Buffer.from('# title'), mime: 'application/octet-stream', filename: 'readme.md', kind: 'text', limitation: null, extra: (rep) => assert.deepEqual(rep.lines, ['# title']) },
  { bytes: Buffer.from('line'), mime: 'application/octet-stream', filename: 'a.log', kind: 'text', limitation: null },
  { bytes: Buffer.from('<root/>'), mime: 'text/plain', filename: 'a.xml', kind: 'text', limitation: null, extra: (rep) => assert.deepEqual(rep.lines, ['<root/>']) },
  { bytes: Buffer.from('<html></html>'), mime: 'application/octet-stream', filename: 'x.html', kind: 'file', limitation: 'Active format is available only as an authenticated original download.' },
  { bytes: Buffer.from('throw 1'), mime: 'application/octet-stream', filename: 'x.js', kind: 'file', limitation: 'Active format is available only as an authenticated original download.' },
  { bytes: Buffer.from('<svg/>'), mime: 'application/octet-stream', filename: 'x.svg', kind: 'file', limitation: 'Active format is available only as an authenticated original download.' },
  { bytes: Buffer.from(''), mime: 'text/plain', filename: 'a.txt', kind: 'text', limitation: null, extra: (rep) => assert.deepEqual(rep.lines, ['']) },
  { bytes: Buffer.from(''), mime: 'image/png', filename: 'e.png', kind: 'file', limitation: 'No safe representation is selected for this media type; use the immutable original.' },
  { bytes: Buffer.from(''), mime: 'image/jpeg', filename: 'e.jpg', kind: 'file', limitation: 'No safe representation is selected for this media type; use the immutable original.' }
 ];
 for (const c of cases) {
  const { value, error } = snapshot(c.bytes, c.mime, c.filename);
  assert.equal(error, null, c.filename + ' ' + c.mime);
  const rep = value as ReturnType<typeof indexEvidenceRepresentation>;
  assert.equal(rep.kind, c.kind, `${c.mime} ${c.filename}`);
  assert.equal(rep.limitation, c.limitation, `${c.mime} ${c.filename}`);
  assert.equal(rep.version, 'carbon.evidence.v1');
  assert.equal(rep.sha256, crypto.createHash('sha256').update(c.bytes).digest('hex'));
  assert.equal(rep.id, 'representation-' + crypto.createHash('sha256').update('carbon.evidence.v1:' + rep.sha256).digest('hex'));
  c.extra?.(rep);
 }
});

test('PNG and JPEG snapshots parse only on exact image/png or image/jpeg MIME', () => {
 const png = Buffer.from(PNG_1X1);
 const jpeg = jpegBytes(3, 2);
 const pngOk = indexEvidenceRepresentation(png, 'image/png', 'screenshot.png');
 assert.equal(pngOk.kind, 'image');
 assert.equal(pngOk.width, 1);
 assert.equal(pngOk.height, 1);
 assert.equal(pngOk.limitation, null);
 assert.equal(pngOk.sha256, indexEvidenceRepresentation(png, 'image/png', 'derived-chart.png').sha256);
 const region = resolveEvidenceFragment(pngOk, { kind: 'region', x: 0, y: 0, width: 0.5, height: 0.5 }, 0, 0, 1);
 assert.equal(region.kind, 'image');
 assert.equal(region.width, 1);
 assert.equal(region.height, 1);
 const jpegOk = indexEvidenceRepresentation(jpeg, 'image/jpeg', 'photo.jpg');
 assert.equal(jpegOk.kind, 'image');
 assert.equal(jpegOk.width, 3);
 assert.equal(jpegOk.height, 2);
 const imageFromHtmlName = indexEvidenceRepresentation(png, 'image/png', 'analysis.html');
 assert.equal(imageFromHtmlName.kind, 'image', 'image MIME is decided before active-format filename refusal');
 const refused = [
  ['IMAGE/PNG', 'screenshot.png'],
  ['image/PNG', 'screenshot.png'],
  ['image/png; charset=binary', 'screenshot.png'],
  ['text/plain', 'screenshot.png'],
  ['image/jpeg', 'screenshot.png'],
  ['IMAGE/JPEG', 'photo.jpg'],
  ['image/jpg', 'photo.jpg'],
  ['image/png', 'photo.jpg']
 ] as const;
 for (const [mime, filename] of refused) {
  const bytes = filename.endsWith('.png') && mime !== 'image/png' ? png : filename.endsWith('.jpg') ? jpeg : png;
  const payload = mime === 'image/png' && filename === 'photo.jpg' ? jpeg : bytes;
  const rep = indexEvidenceRepresentation(payload, mime, filename);
  assert.notEqual(rep.kind, 'image', `${mime} ${filename}`);
 }
 const trunc = indexEvidenceRepresentation(png.subarray(0, 10), 'image/png', 't.png');
 assert.equal(trunc.kind, 'file');
 assert.match(trunc.limitation!, /No safe text\/image/);
 const badMagic = Buffer.concat([Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), png.subarray(8)]);
 assert.equal(indexEvidenceRepresentation(badMagic, 'image/png', 't.png').kind, 'file');
 const zero = Buffer.from(png); zero.writeUInt32BE(0, 16); zero.writeUInt32BE(0, 20);
 assert.equal(indexEvidenceRepresentation(zero, 'image/png', 'z.png').kind, 'file');
 assert.equal(indexEvidenceRepresentation(Buffer.from([0xFF, 0xD8, 0xFF]), 'image/jpeg', 't.jpg').kind, 'file');
 const noSoi = indexEvidenceRepresentation(Buffer.alloc(12), 'image/jpeg', 't.jpg');
 assert.equal(noSoi.kind, 'file');
 assert.match(noSoi.limitation!, /Binary content/);
 const invalidPngHtmlName = indexEvidenceRepresentation(png.subarray(0, 10), 'image/png', 'analysis.html');
 assert.equal(invalidPngHtmlName.kind, 'file');
 assert.match(invalidPngHtmlName.limitation!, /download/);
 assert.throws(() => resolveEvidenceFragment(pngOk, { kind: 'region', x: 0.8, y: 0, width: 0.5, height: 0.5 }, 0, 0, 1), /normalized/);
});

test('nonzero byteOffset views hash and parse only the viewed bytes', () => {
 const textBack = Buffer.concat([Buffer.from('XXXX'), Buffer.from('hello\n'), Buffer.from('YYYY')]);
 const textView = textBack.subarray(4, 10);
 const textRep = indexEvidenceRepresentation(textView, 'text/plain', 'v.txt');
 assert.equal(textRep.kind, 'text');
 assert.deepEqual(textRep.lines, ['hello', '']);
 assert.equal(textRep.sha256, crypto.createHash('sha256').update(Buffer.from('hello\n')).digest('hex'));
 assert.equal(textBack.toString(), 'XXXXhello\nYYYY');
 const pngBack = Buffer.concat([Buffer.from('PRE'), PNG_1X1, Buffer.from('POST')]);
 const pngView = pngBack.subarray(3, 3 + PNG_1X1.length);
 const pngRep = indexEvidenceRepresentation(pngView, 'image/png', 'v.png');
 assert.equal(pngRep.kind, 'image');
 assert.equal(pngRep.width, 1);
 assert.equal(pngRep.sha256, indexEvidenceRepresentation(PNG_1X1, 'image/png', 'screenshot.png').sha256);
 const jpeg = jpegBytes(4, 5);
 const jpegBack = Buffer.concat([Buffer.from([1, 2, 3]), jpeg, Buffer.from([9, 9])]);
 const jpegView = jpegBack.subarray(3, 3 + jpeg.length);
 const jpegRep = indexEvidenceRepresentation(jpegView, 'image/jpeg', 'v.jpg');
 assert.equal(jpegRep.kind, 'image');
 assert.equal(jpegRep.width, 4);
 assert.equal(jpegRep.height, 5);
});

test('non-image path skips payload Buffer.from; image path still copies payload bytes', () => {
 const text = Buffer.from('hello world\n'.repeat(32));
 const textAcc = accountPayloadCopies(text, 'text/plain', 'a.txt');
 assert.equal(textAcc.result.kind, 'text');
 assert.equal(textAcc.copies, 0);
 assert.equal(textAcc.bytesCopied, 0);
 const html = Buffer.from('<script>throw 1</script>');
 const htmlAcc = accountPayloadCopies(html, 'text/html', 'analysis.html');
 assert.equal(htmlAcc.result.kind, 'file');
 assert.equal(htmlAcc.copies, 0);
 const pngAcc = accountPayloadCopies(PNG_1X1, 'image/png', 'screenshot.png');
 assert.equal(pngAcc.result.kind, 'image');
 assert.equal(pngAcc.copies, 1);
 assert.equal(pngAcc.bytesCopied, PNG_1X1.byteLength);
 const jpeg = jpegBytes(3, 2);
 const jpegAcc = accountPayloadCopies(jpeg, 'image/jpeg', 'photo.jpg');
 assert.equal(jpegAcc.result.kind, 'image');
 assert.equal(jpegAcc.copies, 1);
 assert.equal(jpegAcc.bytesCopied, jpeg.byteLength);
 const cased = accountPayloadCopies(PNG_1X1, 'IMAGE/PNG', 'screenshot.png');
 assert.notEqual(cased.result.kind, 'image');
 assert.equal(cased.copies, 0);
 const big = new Uint8Array(4 * 1024 * 1024);
 big.fill(0x41);
 const bigAcc = accountPayloadCopies(big, 'application/pdf', 'bulk.pdf');
 assert.equal(bigAcc.result.kind, 'file');
 assert.equal(bigAcc.copies, 0);
 assert.equal(bigAcc.bytesCopied, 0);
});

test('negative control: exact PNG/JPEG MIME still parses; skipping image parse would fail this guard', () => {
 const png = indexEvidenceRepresentation(PNG_1X1, 'image/png', 'screenshot.png');
 assert.equal(png.kind, 'image');
 assert.equal(png.width, 1);
 assert.equal(png.height, 1);
 const jpeg = indexEvidenceRepresentation(jpegBytes(8, 9), 'image/jpeg', 'photo.jpg');
 assert.equal(jpeg.kind, 'image');
 assert.equal(jpeg.width, 8);
 assert.equal(jpeg.height, 9);
 const html = indexEvidenceRepresentation(Buffer.from('<html></html>'), 'text/html', 'a.html');
 assert.equal(html.kind, 'file');
 assert.equal(html.limitation, 'Active format is available only as an authenticated original download.');
});

test('seeded varied inputs never classify non-exact image MIME as image and preserve bytes', () => {
 const rand = mulberry32(20261007);
 const mimes = ['text/plain', 'application/json', 'text/csv', 'application/pdf', 'text/html', 'image/svg+xml', 'application/xml', 'application/javascript', 'image/png', 'image/jpeg', 'IMAGE/PNG', 'image/PNG', 'image/jpg', 'application/octet-stream'];
 const names = ['a.txt', 'a.json', 'a.csv', 'a.pdf', 'a.html', 'a.svg', 'a.xml', 'a.js', 'a.png', 'a.jpg', 'derived-chart.png', 'analysis.html'];
 const payloads = [Buffer.from('hello'), Buffer.from('{"n":1}'), Buffer.from('a,b\n1,2\n'), Buffer.from('%PDF-1.4\n'), Buffer.from('<x/>'), PNG_1X1, jpegBytes(2, 2), Buffer.from([0xff, 0x00, 0xfe]), Buffer.from('nul\0byte'), Buffer.from('')];
 for (let i = 0; i < 80; i++) {
  const bytes = payloads[Math.floor(rand() * payloads.length)]!;
  const mime = mimes[Math.floor(rand() * mimes.length)]!;
  const filename = names[Math.floor(rand() * names.length)]!;
  const copy = Buffer.from(bytes);
  const { value, error } = snapshot(bytes, mime, filename);
  assert.equal(error, null);
  const rep = value as ReturnType<typeof indexEvidenceRepresentation>;
  assert.equal(hex(bytes), hex(copy));
  if (mime !== 'image/png' && mime !== 'image/jpeg') assert.notEqual(rep.kind, 'image', `${mime} ${filename}`);
  if (rep.kind === 'image') {
   assert.ok(mime === 'image/png' || mime === 'image/jpeg');
   assert.equal(typeof rep.width, 'number');
   assert.equal(typeof rep.height, 'number');
  }
 }
});
