/**
 * A minimal, dependency-free ZIP (STORE) writer.
 *
 * DOCX and XLSX are ZIP containers (the OPC package): a directory of XML parts
 * whose bytes must round-trip exactly. Rather than add a dependency for a
 * three-entry archive, the container is written by hand — STORE (uncompressed)
 * entries, local headers + central directory + end-of-central-directory.
 *
 * Determinism: file order is the caller's (parts are emitted in a fixed
 * sequence), and all timestamps are the fixed 1980-01-01 baseline, so the same
 * (claims, gaps) always produce byte-identical archives — the same
 * determinism the text renderers have (SD-06).
 */

/** The fixed DOS timestamp for every entry: 1980-01-01 00:00:00. */
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/** One file entry in the archive (a directory entry is a path ending in "/"). */
interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Build a ZIP archive (STORE method) from named entries, in the given order.
 * The output is deterministic for identical inputs.
 */
export function zipStore(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // general purpose flags (no utf-8 flag needed: names are ASCII)
    local.writeUInt16LE(0, 8); // compression method: STORE
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, entry.data);

    const centralRec = Buffer.alloc(46);
    centralRec.writeUInt32LE(0x02014b50, 0); // central directory header signature
    centralRec.writeUInt16LE(20, 4); // version made by
    centralRec.writeUInt16LE(20, 6); // version needed to extract
    centralRec.writeUInt16LE(0, 8); // flags
    centralRec.writeUInt16LE(0, 10); // compression method: STORE
    centralRec.writeUInt16LE(DOS_TIME, 12);
    centralRec.writeUInt16LE(DOS_DATE, 14);
    centralRec.writeUInt32LE(crc, 16);
    centralRec.writeUInt32LE(entry.data.length, 20); // compressed size
    centralRec.writeUInt32LE(entry.data.length, 24); // uncompressed size
    centralRec.writeUInt16LE(nameBuf.length, 28);
    centralRec.writeUInt16LE(0, 30); // extra field length
    centralRec.writeUInt16LE(0, 32); // comment length
    centralRec.writeUInt16LE(0, 34); // disk number start
    centralRec.writeUInt16LE(0, 36); // internal attributes
    centralRec.writeUInt32LE(0, 38); // external attributes
    centralRec.writeUInt32LE(offset, 42); // local header offset
    central.push(centralRec, nameBuf);

    offset += local.length + nameBuf.length + entry.data.length;
  }

  const centralDir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central directory size
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDir, eocd]);
}

/**
 * CRC-32 (IEEE 802.3, the polynomial ZIP uses), table-driven.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ (data[i] as number)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A convenience: a single named part as the sole archive entry. */
export function zipSingle(name: string, data: Buffer): Buffer {
  return zipStore([{ name, data }]);
}
