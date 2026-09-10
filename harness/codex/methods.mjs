// Every app-server method carbon's Codex harness sends or listens for, named once
// here so a version bump has one place to fail. `assertMethodsExist` reads the
// pinned protocol schema and refuses any name the schema does not carry; the test
// runs it against the checked-in copy and install runs it against the schema the
// pinned binary generates.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fault } from '../../lib/faults.mjs';

export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const PINNED_SCHEMA_DIR = path.join(HERE, 'schema');
export const PINNED_SCHEMA_DOCUMENT = path.join(PINNED_SCHEMA_DIR, 'codex_app_server_protocol.schemas.json');
export const PINNED_SCHEMA_PIN = path.join(PINNED_SCHEMA_DIR, 'schema-pin.json');

// Requests carbon sends. Grouped by the operation that sends them so a reader can
// see which of the six operations owns each name.
export const REQUESTS = {
  start: ['initialize', 'thread/start', 'thread/name/set', 'thread/resume'],
  turn: ['turn/start', 'turn/steer', 'turn/interrupt'],
  tools: ['mcpServerStatus/list'],
  // Its own group rather than a name added to `tools`, because it asks a different
  // question. `tools` is about the servers carbon rendered from the declaration;
  // this reads back what the harness itself found in the working directory it was
  // given, by its own conventions, and carbon neither renders nor names it.
  skills: ['skills/list']
};

// Notifications carbon listens for. Anything else the app-server sends is logged
// by method name and dropped, which is what `events` does.
export const NOTIFICATIONS = [
  'thread/started',
  'thread/name/updated',
  'turn/started',
  'turn/completed',
  // What a turn cost, on the wire rather than estimated afterwards. It is one of
  // the two reasons the plan chose this protocol, and a notification carbon does
  // not listen for is a cost nobody can report.
  'thread/tokenUsage/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'mcpServer/startupStatus/updated',
  'error'
];

// The one notification carbon sends, after initialize.
export const CLIENT_NOTIFICATIONS = ['initialized'];

export function allSentRequests() {
  return [...new Set(Object.values(REQUESTS).flat())].sort();
}

export function allListenedNotifications() {
  return [...NOTIFICATIONS].sort();
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// The digest of a generated schema bundle. `codex app-server generate-json-schema`
// writes a directory, so the digest is taken over a manifest of every file in it:
// one "<sha256>  <relative path>" line per file, sorted by path. One hex string
// covers the whole bundle, and the manifest itself says which file moved.
export function bundleManifest(dir) {
  const lines = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) lines.push(`${sha256(fs.readFileSync(full))}  ${path.relative(dir, full)}`);
    }
  };
  walk(dir);
  lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  return lines.join('\n') + '\n';
}

export function bundleSha256(dir) {
  return sha256(Buffer.from(bundleManifest(dir), 'utf8'));
}

// Reads the method names out of a generated protocol schema document. The document
// is draft-07 with every request shape under definitions.ClientRequest.oneOf, each
// carrying its method as a one-value enum.
export function methodsInSchema(document) {
  const read = (name) => (document?.definitions?.[name]?.oneOf ?? [])
    .map((shape) => shape?.properties?.method?.enum?.[0])
    .filter((method) => typeof method === 'string');
  return {
    clientRequests: new Set(read('ClientRequest')),
    clientNotifications: new Set(read('ClientNotification')),
    serverNotifications: new Set(read('ServerNotification')),
    serverRequests: new Set(read('ServerRequest'))
  };
}

export function readPinnedSchema() {
  return JSON.parse(fs.readFileSync(PINNED_SCHEMA_DOCUMENT, 'utf8'));
}

export function readSchemaPin() {
  return JSON.parse(fs.readFileSync(PINNED_SCHEMA_PIN, 'utf8'));
}

// Returns a fault for every name carbon uses that the schema does not carry.
// `subject` names where the schema came from, so a fault from install and a fault
// from the test read differently.
export function assertMethodsExist(document, subject) {
  const present = methodsInSchema(document);
  const faults = [];
  const check = (names, set, kind) => {
    for (const name of names) {
      if (!set.has(name)) {
        faults.push(fault('HARNESS_METHOD_ABSENT', `${subject}:${name}`,
          `carbon's Codex harness sends or listens for the ${kind} ${name}, and this protocol schema does not carry it`,
          'stop at this version, read the schema diff, and change harness/codex before bumping the pin'));
      }
    }
  };
  check(allSentRequests(), present.clientRequests, 'request');
  check(CLIENT_NOTIFICATIONS, present.clientNotifications, 'client notification');
  check(allListenedNotifications(), present.serverNotifications, 'server notification');
  return faults;
}
