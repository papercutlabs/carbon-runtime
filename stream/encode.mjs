// Path derivation for the store. A conversation id, a message id and a unit id
// are all attacker-controlled: a sender chooses their own Message-ID and a zip
// entry names its own file. So no identifier ever reaches the filesystem as it
// was written. Two rules do the work, in this order.
//
// 1. Refusal. An identifier carrying a path separator, a dot segment, a NUL or
//    any other control character is refused before any write happens. Encoding
//    alone would neutralise these, but an identifier shaped like an escape is a
//    fact worth reporting rather than quietly rewriting. A dot segment is read
//    as any ".." anywhere in the identifier, not only a component that is
//    exactly "..", because an adapter composes its identifiers and the hostile
//    part is rarely the whole string.
//
// 2. Encoding. Every remaining identifier is encoded byte by byte: a byte in
//    [A-Za-z0-9_-] is kept, and every other byte becomes "~" followed by two
//    uppercase hex digits. A "." is therefore always encoded, so no encoded
//    component can be a dot segment or carry a suffix that the store did not
//    add itself, and "~" encodes as "~7E" so the encoding is reversible:
//    decodeComponent() returns the original identifier byte for byte.
//
// The one lossy case is a very long identifier. When the encoded form would
// exceed 200 bytes the component becomes "~h" plus the sha256 of the raw
// identifier, which is not reversible; the record itself carries the raw
// conversation_id and message_id, so the identifier is never lost, only the
// path stops being a way to recover it. "~h" cannot collide with an ordinary
// encoding because "h" is not a hex digit.

import crypto from 'node:crypto';
import path from 'node:path';
import { fault } from './faults.mjs';

const MAX_ENCODED = 200;
const MAX_RAW = 1024;

function isSafeByte(byte) {
  return (byte >= 0x41 && byte <= 0x5a) // A-Z
    || (byte >= 0x61 && byte <= 0x7a) // a-z
    || (byte >= 0x30 && byte <= 0x39) // 0-9
    || byte === 0x5f // _
    || byte === 0x2d; // -
}

// Every reason this identifier may not become a path component, all at once.
export function componentFaults(subject, raw) {
  const faults = [];
  if (typeof raw !== 'string' || raw.length === 0) {
    faults.push(fault('IDENTIFIER_EMPTY', subject,
      'an identifier used as a path component must be a non-empty string',
      `give ${subject} a value`));
    return faults;
  }
  if (raw.includes('/') || raw.includes('\\')) {
    faults.push(fault('IDENTIFIER_HAS_SEPARATOR', subject,
      `${JSON.stringify(raw)} carries a path separator`,
      'strip the separator at the adapter, or key the record on an identifier that has none'));
  }
  if (raw === '.' || raw.includes('..')) {
    faults.push(fault('IDENTIFIER_HAS_DOT_SEGMENT', subject,
      `${JSON.stringify(raw)} carries a dot segment`,
      'key the record on an identifier that names something; a dot segment is shaped like an escape, so it is reported rather than quietly encoded'));
  }
  for (const byte of Buffer.from(raw, 'utf8')) {
    if (byte < 0x20 || byte === 0x7f) {
      faults.push(fault('IDENTIFIER_HAS_CONTROL_BYTE', subject,
        `${JSON.stringify(raw)} carries the control byte 0x${byte.toString(16).padStart(2, '0')}`,
        'strip control bytes at the adapter before the record is built'));
      break;
    }
  }
  if (raw.length > MAX_RAW) {
    faults.push(fault('IDENTIFIER_TOO_LONG', subject,
      `${raw.length} characters is beyond the ${MAX_RAW} an identifier may have`,
      'key the record on the channel identifier, not on its content'));
  }
  return faults;
}

export function encodeComponent(raw) {
  let encoded = '';
  for (const byte of Buffer.from(raw, 'utf8')) {
    encoded += isSafeByte(byte)
      ? String.fromCharCode(byte)
      : '~' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  if (encoded.length > MAX_ENCODED) {
    return '~h' + crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  }
  return encoded;
}

// The inverse of encodeComponent for every component it did not have to hash.
export function decodeComponent(encoded) {
  if (encoded.startsWith('~h')) {
    throw new Error(`${encoded} is the hashed form of an identifier too long to encode; read the raw id from the record`);
  }
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '~') {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Join encoded components under the store and refuse anything that lands
// outside it. This is the backstop, not the guard: the guard is componentFaults.
export function resolveUnderStore(storeDir, ...components) {
  const root = path.resolve(storeDir);
  const resolved = path.resolve(root, ...components);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${resolved} falls outside the store at ${root}`);
  }
  return resolved;
}
