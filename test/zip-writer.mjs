// A zip writer, for the tests only.
//
// The reader in import/zip.mjs has to be fed zips, including zips no honest tool
// would produce: an entry naming a path outside the archive, an entry compressed
// with a method nobody uses, an entry whose bytes do not match its checksum. So
// the tests build their own, here, rather than checking a binary fixture into a
// public repository where nobody can read what is in it.
//
// This ships with the tests and never with the runtime.

import zlib from 'node:zlib';
import { crc32 } from '../import/zip.mjs';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

// entries: [{ name, data (Buffer|string), method: 0 | 8, crc?: number }]
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? 8;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const checksum = entry.crc ?? crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

// The export the capture extension produces: messages.json plus media/.
export function buildExport(rows, media = {}) {
  return buildZip([
    { name: 'messages.json', data: JSON.stringify(rows, null, 2) },
    ...Object.entries(media).map(([name, data]) => ({ name, data }))
  ]);
}
