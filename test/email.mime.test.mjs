// The MIME reader, against the shapes a mailbox actually produces: headers
// folded over several lines, words encoded because a subject was not ASCII, a
// body inside a multipart, a message that carries only HTML, an attachment past
// the cap, and an encoding nobody can decode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MimeUnreadable, decodeWords, header, headerRaw, readMessage, stripHtml
} from '../adapters/email/mime.mjs';

const RECORDED = path.join(import.meta.dirname, 'fixtures', 'imap-recorded');
const lines = (text) => text.split(/\r?\n/);
const CAP = { maxAttachmentBytes: 1000 };

test('a header folded over three lines is one header', () => {
  const message = readMessage(lines(fs.readFileSync(path.join(RECORDED, 'fetch-1.txt'), 'latin1')), CAP);
  assert.match(headerRaw(message.headers, 'message-id'), /^<[^ ]+@mail\.example\.test>$/);
  assert.equal(header(message.headers, 'subject'), 'carbon-email smoke 20260910092517866');
  assert.equal(header(message.headers, 'x-carbon-origin'), 'probe');
});

test('a quoted-printable body comes back whole, soft line breaks and all', () => {
  const message = readMessage(lines(fs.readFileSync(path.join(RECORDED, 'fetch-1.txt'), 'latin1')), CAP);
  assert.equal(message.bodyKind, 'text/plain');
  assert.match(message.body, /^This is the probe mail of the email adapter smoke, run \d+\. It exists/);
  assert.doesNotMatch(message.body, /=\n/, 'a soft line break survived the decode');
});

test('an encoded word is decoded, in both encodings, and two of them join', () => {
  assert.equal(decodeWords('=?utf-8?B?w4TDpMOc?='), 'ÄäÜ');
  assert.equal(decodeWords('=?utf-8?Q?Fakturafr=C3=A5ga?='), 'Fakturafråga');
  assert.equal(decodeWords('=?utf-8?Q?one_?= =?utf-8?Q?word?='), 'one word');
  assert.equal(decodeWords('=?iso-8859-1?Q?Bj=F6rk?= and plain text'), 'Björk and plain text');
  assert.equal(decodeWords('nothing encoded here'), 'nothing encoded here');
});

test('the first text/plain part is the body, whichever part it sits in', () => {
  const message = readMessage([
    'From: ada@example.test',
    'Subject: =?utf-8?Q?Fakturafr=C3=A5ga?=',
    'Message-ID: <one@example.test>',
    'Content-Type: multipart/alternative; boundary="x"',
    '',
    '--x',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'the plain half',
    '--x',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>the html half</p>',
    '--x--'
  ], CAP);
  assert.equal(message.bodyKind, 'text/plain');
  assert.equal(message.body, 'the plain half');
  assert.equal(header(message.headers, 'subject'), 'Fakturafråga');
});

test('a message with only HTML falls back to the HTML, stripped', () => {
  const message = readMessage([
    'From: ada@example.test',
    'Message-ID: <two@example.test>',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><style>p{color:red}</style><body><p>Lines 14 &amp; 15</p><p>are the overage.</p></body></html>'
  ], CAP);
  assert.equal(message.bodyKind, 'text/html');
  assert.equal(message.body, 'Lines 14 & 15\nare the overage.');
  assert.doesNotMatch(message.body, /color:red/, 'the stylesheet reached the body');
});

test('stripHtml drops a script, keeps the line breaks and decodes the entities', () => {
  assert.equal(stripHtml('<script>alert(1)</script><div>a</div><div>b &lt;c&gt;</div>'), 'a\nb <c>');
});

function withAttachment(bytes) {
  return [
    'From: ada@example.test',
    'Message-ID: <three@example.test>',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'see attached',
    '--m',
    'Content-Type: application/pdf; name="note.pdf"',
    'Content-Disposition: attachment; filename="note.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    ...(Buffer.from(bytes).toString('base64').match(/.{1,76}/g) ?? ['']),
    '--m--'
  ];
}

test('stripHtml leaves no tag standing, even one its own removal splices together', () => {
  assert.equal(stripHtml('<scr<script>ipt>alert(1)</script><p>kept</p>'), 'kept');
  // What must not survive is a tag; a lone "<" left as text is text.
  assert.doesNotMatch(stripHtml('<scr<script>ipt>x</script>'), /<[a-z!/][^>]*>/i);
  assert.doesNotMatch(stripHtml('<!-<!-- - -->->text'), /<[a-z!/][^>]*>/i);
});

test('an attachment under the cap arrives with its bytes and its digest', () => {
  const message = readMessage(withAttachment('x'.repeat(100)), { maxAttachmentBytes: 1000 });
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].bytes.length, 100);
  assert.equal(message.attachments[0].filename, 'note.pdf');
  assert.equal(message.attachments[0].download_failed, undefined);
  assert.equal(message.body, 'see attached');
});

test('an attachment over the cap is recorded as download_failed, with no bytes', () => {
  const message = readMessage(withAttachment('x'.repeat(100)), { maxAttachmentBytes: 64 });
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].download_failed, true);
  assert.equal(message.attachments[0].bytes, 100, 'the true size is not recorded');
  assert.match(message.attachments[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(message.body, 'see attached', 'the text was lost with the attachment');
});

test('an encoding this reader does not decode is said out loud', () => {
  assert.throws(() => readMessage([
    'From: ada@example.test',
    'Message-ID: <four@example.test>',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: invented',
    '',
    'whatever this is'
  ], CAP), MimeUnreadable);
});

test('the reader guesses no attachment cap', () => {
  assert.throws(() => readMessage(['Message-ID: <five@example.test>', '', 'body'], {}), MimeUnreadable);
});
