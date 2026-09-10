// Reading an export's zip.
//
// The archive comes from a client's own browser and its entry names were chosen
// by whatever made it. So the first thing proved here is refusal: an entry that
// is neither the messages file nor something under media/ never gets read, and
// the archive is refused before a single byte of it is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { crc32, entries, entryKind, open, readEntry, ZipFault } from '../import/zip.mjs';
import { buildExport, buildZip } from './zip-writer.mjs';

function faultCodes(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ZipFault, `expected a ZipFault, got ${error}`);
    return error.faults.map((f) => f.code);
  }
  throw new assert.AssertionError({ message: 'nothing was refused' });
}

test('an entry that is not the messages file and not media is refused', () => {
  for (const name of [
    '../outside.json',
    'media/../../etc/passwd',
    'media/../secrets',
    '/etc/passwd',
    'C:\\windows\\system32\\drivers',
    'media\\..\\escape.jpg',
    'notes.txt',
    'MEDIA/one.jpg',
    'mediaeval/one.jpg',
    './media/one.jpg'
  ]) {
    assert.equal(entryKind(name), null, `${name} was not refused`);
  }
});

test('the messages file and media under it are what an export holds', () => {
  assert.equal(entryKind('messages.json'), 'messages');
  assert.equal(entryKind('media/false_15550001111_c_us_9001.jpg'), 'media');
  assert.equal(entryKind('media/nested/one.jpg'), 'media');
  assert.equal(entryKind('media/'), 'directory');
});

test('an archive carrying an entry outside media is refused whole, before anything is read', () => {
  const zip = buildZip([
    { name: 'messages.json', data: '[]' },
    { name: 'media/one.jpg', data: 'a picture' },
    { name: '../../etc/passwd', data: 'not yours' },
    { name: 'media/../escape', data: 'nor this' }
  ]);
  const codes = faultCodes(() => open(zip));
  assert.deepEqual(codes, ['ZIP_ENTRY_OUTSIDE_MEDIA', 'ZIP_ENTRY_OUTSIDE_MEDIA'],
    'the refusals were not reported together');
});

test('a stored entry and a deflated entry both read back exactly', () => {
  const picture = Buffer.from('a'.repeat(5000), 'utf8');
  const zip = buildZip([
    { name: 'messages.json', data: '[{"message_id":"one"}]', method: 0 },
    { name: 'media/one.txt', data: picture, method: 8 },
    { name: 'media/two.txt', data: picture, method: 0 }
  ]);
  const archive = open(zip);
  assert.deepEqual(archive.messages(), [{ message_id: 'one' }]);
  assert.deepEqual(archive.media('media/one.txt'), picture);
  assert.deepEqual(archive.media('media/two.txt'), picture);
  assert.equal(archive.media('media/nothing.txt'), null);
});

test('an entry whose bytes do not match its checksum is refused', () => {
  const zip = buildZip([
    { name: 'messages.json', data: '[]' },
    { name: 'media/one.txt', data: 'the picture', crc: 0x12345678 }
  ]);
  assert.deepEqual(faultCodes(() => open(zip).media('media/one.txt')), ['ZIP_ENTRY_CORRUPT']);
});

test('a compression method this reader does not know is named, not guessed at', () => {
  const zip = buildZip([
    { name: 'messages.json', data: '[]' },
    { name: 'media/one.txt', data: 'the picture', method: 14 }
  ]);
  assert.deepEqual(faultCodes(() => open(zip).media('media/one.txt')), ['ZIP_METHOD_UNSUPPORTED']);
});

test('an export with no messages file is refused', () => {
  assert.deepEqual(faultCodes(() => open(buildZip([{ name: 'media/one.txt', data: 'x' }]))),
    ['ZIP_MESSAGES_MISSING']);
});

test('something that is not a zip is refused rather than half read', () => {
  assert.deepEqual(faultCodes(() => open(Buffer.from('this is a json file, not a zip'))), ['ZIP_UNREADABLE']);
});

test('the checksum this reader computes is the one the format defines', () => {
  // The published check value for the nine bytes "123456789".
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
});

test('an export the tool produced reads back as the rows it wrote', () => {
  const rows = [{ chat_jid: '15550001111@s.whatsapp.net', message_id: 'one', text: 'hello' }];
  const archive = open(buildExport(rows, { 'media/one.txt': 'a picture' }));
  assert.deepEqual(archive.messages(), rows);
  assert.deepEqual(archive.mediaNames(), ['media/one.txt']);
});

test('an entry is read from where its own local header says the bytes start', () => {
  const zip = buildZip([
    { name: 'media/one.txt', data: 'first' },
    { name: 'messages.json', data: '[]' }
  ]);
  const found = entries(zip).find((entry) => entry.name === 'media/one.txt');
  assert.equal(readEntry(zip, found).toString('utf8'), 'first');
  assert.equal(zlib.inflateRawSync(zlib.deflateRawSync(Buffer.from('first'))).toString('utf8'), 'first');
});
