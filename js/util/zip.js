/**
 * zip.js — dependency-free ZIP writer + reader for archive export/import.
 *
 * Writer uses the "store" method (no compression): the archive is WebP/JPEG
 * photos that are already compressed, so deflating them again wastes time.
 * Reader supports both stored and deflated entries (deflate via the native
 * DecompressionStream) so archives from other tools also import fine.
 */

/* ---------- CRC-32 ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* ---------- Writer ---------- */

/**
 * zipFiles([{path, blob}], onProgress?) → Blob (application/zip)
 * Entry names are stored as UTF-8 (general-purpose bit 11).
 */
export async function zipFiles(files, onProgress) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;

  const u16 = (dv, p, v) => dv.setUint16(p, v, true);
  const u32 = (dv, p, v) => dv.setUint32(p, v, true);

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = enc.encode(f.path);
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    u32(lh, 0, 0x04034b50); // local file header
    u16(lh, 4, 20);         // version needed
    u16(lh, 6, 0x0800);     // UTF-8 names
    u16(lh, 8, 0);          // method: store
    u16(lh, 10, time);
    u16(lh, 12, date);
    u32(lh, 14, crc);
    u32(lh, 18, data.length);
    u32(lh, 22, data.length);
    u16(lh, 26, name.length);
    u16(lh, 28, 0);
    parts.push(lh.buffer, name, data);

    central.push({ name, crc, size: data.length, offset });
    offset += 30 + name.length + data.length;
    onProgress?.(i + 1, files.length);
    if (i % 8 === 7) await new Promise((r) => setTimeout(r)); // keep UI responsive
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const e of central) {
    const ch = new DataView(new ArrayBuffer(46));
    u32(ch, 0, 0x02014b50); // central directory header
    u16(ch, 4, 20);
    u16(ch, 6, 20);
    u16(ch, 8, 0x0800);
    u16(ch, 10, 0);
    u16(ch, 12, time);
    u16(ch, 14, date);
    u32(ch, 16, e.crc);
    u32(ch, 20, e.size);
    u32(ch, 24, e.size);
    u16(ch, 28, e.name.length);
    u32(ch, 42, e.offset);
    parts.push(ch.buffer, e.name);
    cdSize += 46 + e.name.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  u32(eocd, 0, 0x06054b50);
  u16(eocd, 8, central.length);
  u16(eocd, 10, central.length);
  u32(eocd, 12, cdSize);
  u32(eocd, 16, cdStart);
  parts.push(eocd.buffer);

  return new Blob(parts, { type: 'application/zip' });
}

/* ---------- Reader ---------- */

/**
 * readZip(file) → [{path, size, getBlob(): Promise<Blob>}]
 * Lazy: entry bytes are only pulled from disk when getBlob() is called.
 */
export async function readZip(file) {
  // End-of-central-directory record lives in the last 22–65557 bytes.
  const tailStart = Math.max(0, file.size - 65558);
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');

  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();

  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const compSize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOffset = cd.getUint32(p + 42, true);
    const path = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (path.endsWith('/')) continue; // directory marker
    entries.push({
      path,
      size,
      async getBlob() {
        const lh = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('Corrupt ZIP entry');
        const nl = lh.getUint16(26, true);
        const el = lh.getUint16(28, true);
        const start = localOffset + 30 + nl + el;
        const raw = file.slice(start, start + compSize);
        if (method === 0) return raw;
        if (method === 8) {
          const ds = new DecompressionStream('deflate-raw');
          return new Response(raw.stream().pipeThrough(ds)).blob();
        }
        throw new Error(`Unsupported compression method ${method}`);
      },
    });
  }
  return entries;
}
