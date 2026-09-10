// The submission connection: how the reply actually leaves the box.
//
// Nothing here touches a network. CARBON_EMAIL_CURL points at a shim that writes
// down the arguments it was given, so what is tested is the command the adapter
// builds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SMTP_SECURITY, sendMessage } from '../adapters/email/curl.mjs';
import { DEFAULTS } from '../adapters/email/index.mjs';

const SHIM = path.join(import.meta.dirname, 'fixtures', 'curl-shim', 'curl-args');

function sentWith(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbon-smtp-'));
  const file = path.join(dir, 'message.eml');
  fs.writeFileSync(file, 'Subject: x\r\n\r\nbody\r\n');
  process.env.CARBON_EMAIL_CURL = SHIM;
  process.env.CARBON_EMAIL_ARGS = path.join(dir, 'args.json');
  const result = sendMessage({
    netrc: path.join(dir, 'netrc'),
    host: 'smtp.example.test',
    from: 'agent@example.test',
    to: ['someone@example.test'],
    file,
    ...overrides
  });
  return { result, args: JSON.parse(fs.readFileSync(process.env.CARBON_EMAIL_ARGS, 'utf8')) };
}

test('implicit TLS is smtps on the declared port, and nothing upgrades', () => {
  const { result, args } = sentWith({ port: 465, security: 'implicit' });
  assert.equal(result.status, 'sent');
  assert.ok(args.includes('smtps://smtp.example.test:465'), args.join(' '));
  assert.equal(args.includes('--ssl-reqd'), false, 'an implicit connection asked to upgrade');
});

test('starttls is plain smtp on the declared port, and the upgrade is required', () => {
  const { result, args } = sentWith({ port: 587, security: 'starttls' });
  assert.equal(result.status, 'sent');
  assert.ok(args.includes('smtp://smtp.example.test:587'), args.join(' '));
  assert.ok(args.includes('--ssl-reqd'),
    'a server that cannot upgrade would have been given the credential in the clear');
});

test('a channel that names neither is refused, and no message is handed to curl', () => {
  assert.throws(() => sentWith({ port: 587, security: 'plain' }),
    (error) => error.faults.some((f) => f.code === 'SMTP_SECURITY_UNKNOWN'));
  assert.deepEqual(SMTP_SECURITY, ['implicit', 'starttls']);
});

test('a channel that says nothing gets TLS from the first byte, which is the safe half', () => {
  assert.equal(DEFAULTS.smtp_security, 'implicit');
  assert.equal(DEFAULTS.smtp_port, 465);
  const { args } = sentWith({});
  assert.ok(args.includes('smtps://smtp.example.test:465'), args.join(' '));
});
