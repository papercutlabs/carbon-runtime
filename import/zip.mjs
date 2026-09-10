// A zip reader, written here rather than taken from anywhere.
//
// The one dependency this repository has is the WhatsApp library. A history
// export is a zip file, and reading a zip is a hundred lines of buffer
// arithmetic against a format that has not changed since the nineties, so it is
// a hundred lines here rather than a package, its transitive packages, and their
// updates on a client's box.
//
// It reads what the export tool actually writes: entries stored or deflated,
// with the central directory at the end. It does not implement encryption, split
// archives, or any compression method beyond those two, and it says so rather
// than guessing when it meets one.
//
// The name of every entry is chosen by whoever made the zip. So no entry name is
// ever used to build a path here: the messages file is read by its exact name,
// media is read into memory and written into the store under its own sha256, and
// any entry that is neither the messages file nor something under `media/` is
// refused before it is read. That refusal is the belt: the braces are that
// nothing in this file writes a file at all.

import zlib from 'node:zlib';
import { fault } from '../stream/faults.mjs';

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export const MESSAGES_ENTRY = 'messages.json';
export const MEDIA_PREFIX = 'media/';

export class ZipFault extends Error {
  constructor(faults) {
    super(faults.map((f) => `${f.code} ${f.subject}: ${f.problem}`).join('\n'));
    this.name = 'ZipFault';
    this.faults = faults;
  }
}

// Whether an entry may be read at all. `messages.json` is the export's own
// index and is named exactly. Everything else must sit under `media/`. A name
// carrying a backslash, a drive letter, a leading slash, a dot segment or a
// control byte is refused whatever it looks like afterwards, because those are
// the shapes that walk out of a directory.
export function entryKind(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name.includes('\\')) return null;
  if (name.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(name)) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  if (name.split('/').some((part) => part === '.' || part === '..')) return null;
  if (name === MESSAGES_ENTRY) return 'messages';
  if (name === MEDIA_PREFIX) return 'directory';
  if (name.endsWith('/')) return null;
  if (name.startsWith(MEDIA_PREFIX) && name.length > MEDIA_PREFIX.length) return 'media';
  return null;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 66_000);
  for (let at = buffer.length - 22; at >= earliest; at--) {
    if (buffer.readUInt32LE(at) === EOCD) return at;
  }
  return -1;
}

// The archive's directory: how many entries there are and where they start.
// A zip that has outgrown the sixteen-bit fields says so with a second record,
// and this reads that too, because an export of a long history can carry more
// than sixty-five thousand pictures.
function directoryOf(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw new ZipFault([fault('ZIP_UNREADABLE', 'the export',
      'the file does not end with a zip central directory',
      'pass the zip the export tool produced, not an extracted directory or a part of one')]);
  }
  let count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== EOCD64_LOCATOR) {
      throw new ZipFault([fault('ZIP_UNREADABLE', 'the export',
        'the archive claims more entries than its directory can name and carries no 64-bit directory',
        'produce the export again with a tool that writes a 64-bit central directory')]);
    }
    const at = Number(buffer.readBigUInt64LE(locator + 8));
    if (buffer.readUInt32LE(at) !== EOCD64) {
      throw new ZipFault([fault('ZIP_UNREADABLE', 'the export',
        'the 64-bit directory the archive points at is not there',
        'produce the export again')]);
    }
    count = Number(buffer.readBigUInt64LE(at + 32));
    offset = Number(buffer.readBigUInt64LE(at + 48));
  }
  return { count, offset };
}

// Every entry the archive names, with where its data is. Nothing is decompressed
// here: an export carrying a thousand pictures is read one picture at a time.
export function entries(buffer) {
  const { count, offset } = directoryOf(buffer);
  const found = [];
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== CENTRAL) {
      throw new ZipFault([fault('ZIP_UNREADABLE', `entry ${i + 1}`,
        'the central directory ends before it names every entry it claims',
        'the export is truncated; produce it again')]);
    }
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    found.push({
      name: buffer.toString('utf8', at + 46, at + 46 + nameLength),
      method: buffer.readUInt16LE(at + 10),
      crc: buffer.readUInt32LE(at + 16),
      compressed_size: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      local_offset: buffer.readUInt32LE(at + 42)
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

export function readEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.local_offset) !== LOCAL) {
    throw new ZipFault([fault('ZIP_UNREADABLE', entry.name,
      'the entry does not begin where the directory says it does',
      'the export is damaged; produce it again')]);
  }
  const nameLength = buffer.readUInt16LE(entry.local_offset + 26);
  const extraLength = buffer.readUInt16LE(entry.local_offset + 28);
  const start = entry.local_offset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressed_size);

  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else {
    throw new ZipFault([fault('ZIP_METHOD_UNSUPPORTED', entry.name,
      `the entry is compressed with method ${entry.method}, and this reader knows stored and deflated`,
      'produce the export with the export tool, which writes both')]);
  }

  if (entry.crc !== 0 && crc32(data) !== entry.crc) {
    throw new ZipFault([fault('ZIP_ENTRY_CORRUPT', entry.name,
      'the entry does not match the checksum the archive recorded for it',
      'the export is damaged in transit; copy it again')]);
  }
  return data;
}

// Open an export: refuse every entry that is neither the messages file nor
// media, before anything is read, and report all of them at once.
export function open(buffer) {
  const all = entries(buffer);
  const refused = [];
  const media = new Map();
  let messages = null;

  for (const entry of all) {
    const kind = entryKind(entry.name);
    if (kind === null) {
      refused.push(fault('ZIP_ENTRY_OUTSIDE_MEDIA', entry.name,
        'the entry is neither the export\'s messages file nor a file under media/',
        'an export holds messages.json and media/; an entry naming anything else is not read'));
      continue;
    }
    if (kind === 'messages') messages = entry;
    else if (kind === 'media') media.set(entry.name, entry);
  }
  if (refused.length > 0) throw new ZipFault(refused);
  if (!messages) {
    throw new ZipFault([fault('ZIP_MESSAGES_MISSING', MESSAGES_ENTRY,
      'the export carries no messages file',
      'export again with media included; an export without media is a plain JSON file and not a zip')]);
  }

  return {
    messages: () => JSON.parse(readEntry(buffer, messages).toString('utf8')),
    media: (name) => (media.has(name) ? readEntry(buffer, media.get(name)) : null),
    mediaNames: () => [...media.keys()]
  };
}
