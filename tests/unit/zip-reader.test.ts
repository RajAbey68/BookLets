/**
 * Client-side zip reader — the browser half of the per-item upload transport.
 *
 * Vercel's edge rejects request bodies over ~4.5 MB with 413 before the
 * function runs, so a real WhatsApp "Export Chat → Attach Media" archive (tens
 * of MB) can never reach POST /api/ingest/zip. The archive is therefore
 * expanded in the browser and each entry uploaded on its own sub-4 MB request.
 *
 * This module is the expander. It must keep enforcing — ON THE CLIENT, for the
 * client's own protection — the guards that used to run inside inspectZip:
 * entry count, total uncompressed size, path traversal, and the zip-bomb ratio.
 * The SERVER's copies of the type/size/name guards are tested in
 * ingest-item.test.ts; neither side trusts the other.
 */
import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  readZipDirectory,
  readZipEntry,
  planWhatsappImport,
  ZipReaderError,
  READER_MAX_ENTRIES,
  READER_MAX_TOTAL_UNCOMPRESSED_BYTES,
  READER_MAX_ENTRY_COMPRESSION_RATIO,
  READER_RATIO_GUARD_MIN_BYTES,
} from '../../src/lib/zip-reader';
import {
  MAX_ZIP_ENTRIES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ENTRY_COMPRESSION_RATIO,
  RATIO_GUARD_MIN_BYTES,
} from '../../src/lib/zip-ingest';

function jpeg(bytes = 256): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(bytes)]);
}

function blobOf(buf: Buffer): Blob {
  return new Blob([new Uint8Array(buf)]);
}

function whatsappZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile('_chat.txt', Buffer.from('12/07/2026, 10:15 - Kumar: Bought cement\n', 'utf8'));
  zip.addFile('IMG-20260712-WA0001.jpg', jpeg());
  zip.addFile('IMG-20260712-WA0002.jpg', jpeg());
  zip.addFile('PTT-20260712-WA0003.opus', randomBytes(64));
  return zip.toBuffer();
}

/** Rewrites every occurrence of `from` (same byte length as `to`) in a zip. */
function patchNames(buf: Buffer, from: string, to: string): Buffer {
  const needle = Buffer.from(from, 'utf8');
  const patch = Buffer.from(to, 'utf8');
  if (needle.length !== patch.length) throw new Error('patch lengths must match');
  let idx = buf.indexOf(needle);
  while (idx !== -1) {
    patch.copy(buf, idx);
    idx = buf.indexOf(needle, idx + patch.length);
  }
  return buf;
}

describe('zip-reader — guard constants mirror the server', () => {
  it('uses exactly the server-side limits from zip-ingest.ts', () => {
    // Drift here would mean the browser accepts an archive the server-side
    // contract considers hostile (or vice versa) — the constants are mirrored
    // rather than imported because zip-ingest.ts pulls in adm-zip/node:crypto
    // and must never enter the client bundle.
    expect(READER_MAX_ENTRIES).toBe(MAX_ZIP_ENTRIES);
    expect(READER_MAX_TOTAL_UNCOMPRESSED_BYTES).toBe(MAX_TOTAL_UNCOMPRESSED_BYTES);
    expect(READER_MAX_ENTRY_COMPRESSION_RATIO).toBe(MAX_ENTRY_COMPRESSION_RATIO);
    expect(READER_RATIO_GUARD_MIN_BYTES).toBe(RATIO_GUARD_MIN_BYTES);
  });
});

describe('readZipDirectory', () => {
  it('lists every entry from the central directory with real sizes', async () => {
    const entries = await readZipDirectory(blobOf(whatsappZip()));
    const names = entries.map((e) => e.name);
    expect(names).toEqual([
      '_chat.txt',
      'IMG-20260712-WA0001.jpg',
      'IMG-20260712-WA0002.jpg',
      'PTT-20260712-WA0003.opus',
    ]);
    const chat = entries[0];
    expect(chat.uncompressedSize).toBe(Buffer.byteLength('12/07/2026, 10:15 - Kumar: Bought cement\n'));
  });

  it('reads a zip whose end-of-central-directory carries a trailing comment', async () => {
    const zip = new AdmZip();
    zip.addFile('IMG-1.jpg', jpeg());
    const base = zip.toBuffer();
    const comment = Buffer.from('exported by whatsapp', 'utf8');
    const withComment = Buffer.concat([base, comment]);
    // Patch the EOCD comment-length field (last 2 bytes of the base EOCD).
    withComment.writeUInt16LE(comment.length, base.length - 2);
    const entries = await readZipDirectory(blobOf(withComment));
    expect(entries.map((e) => e.name)).toEqual(['IMG-1.jpg']);
  });

  it('rejects a payload that is not a zip at all', async () => {
    await expect(readZipDirectory(blobOf(Buffer.from('this is a plain text file')))).rejects.toMatchObject({
      code: 'INVALID_ZIP',
    });
  });

  it('rejects a path-traversal entry name (PATH_TRAVERSAL)', async () => {
    const zip = new AdmZip();
    zip.addFile('AA/evil.jpg', jpeg());
    const buf = patchNames(zip.toBuffer(), 'AA/evil.jpg', '../evil.jpg');
    await expect(readZipDirectory(blobOf(buf))).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
  });

  it('rejects more entries than the cap (TOO_MANY_ENTRIES)', async () => {
    const zip = new AdmZip();
    zip.addFile('a.jpg', jpeg(8));
    zip.addFile('b.jpg', jpeg(8));
    await expect(readZipDirectory(blobOf(zip.toBuffer()), { maxEntries: 1 })).rejects.toMatchObject({
      code: 'TOO_MANY_ENTRIES',
    });
  });

  it('rejects a declared uncompressed payload above the cap (TOTAL_SIZE_EXCEEDED)', async () => {
    const zip = new AdmZip();
    zip.addFile('a.jpg', jpeg(4096));
    zip.addFile('b.jpg', jpeg(4096));
    await expect(
      readZipDirectory(blobOf(zip.toBuffer()), { maxTotalUncompressedBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'TOTAL_SIZE_EXCEEDED' });
  });

  it('does not spend the size budget on entries the allowlist will never read', async () => {
    // A WhatsApp export is mostly voice notes and videos we never ingest; they
    // must not exhaust a budget they never consume (mirrors inspectZip pass 1).
    const zip = new AdmZip();
    zip.addFile('voice.opus', randomBytes(200_000));
    zip.addFile('_chat.txt', Buffer.from('hello', 'utf8'));
    const entries = await readZipDirectory(blobOf(zip.toBuffer()), {
      maxTotalUncompressedBytes: 100_000,
    });
    expect(entries.length).toBe(2);
  });

  it('rejects a highly compressible entry above the ratio guard (ZIP_BOMB)', async () => {
    const zip = new AdmZip();
    // 2 MB of zeroes deflates to a few KB — ratio far above 100x.
    zip.addFile('bomb.txt', Buffer.alloc(2 * 1024 * 1024, 0));
    await expect(readZipDirectory(blobOf(zip.toBuffer()))).rejects.toMatchObject({ code: 'ZIP_BOMB' });
  });

  it('allows a tiny highly-compressible entry below the ratio noise floor', async () => {
    const zip = new AdmZip();
    zip.addFile('_chat.txt', Buffer.alloc(1024, 0x20));
    const entries = await readZipDirectory(blobOf(zip.toBuffer()));
    expect(entries.map((e) => e.name)).toEqual(['_chat.txt']);
  });

  it('rejects an encrypted archive with a clear code', async () => {
    const zip = new AdmZip();
    zip.addFile('a.jpg', jpeg());
    const buf = zip.toBuffer();
    // Set the general-purpose bit 0 (encrypted) in the central directory record.
    const cdSig = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt16LE(buf.readUInt16LE(cdSig + 8) | 0x0001, cdSig + 8);
    await expect(readZipDirectory(blobOf(buf))).rejects.toMatchObject({ code: 'UNSUPPORTED_ZIP' });
  });
});

describe('readZipEntry', () => {
  it('round-trips a deflated entry back to its exact bytes', async () => {
    const payload = jpeg(50_000);
    const zip = new AdmZip();
    zip.addFile('IMG-1.jpg', payload);
    const blob = blobOf(zip.toBuffer());
    const [entry] = await readZipDirectory(blob);
    const bytes = await readZipEntry(blob, entry);
    expect(Buffer.from(bytes).equals(payload)).toBe(true);
  });

  it('round-trips a STORED (uncompressed) entry', async () => {
    const zip = new AdmZip();
    // Random bytes do not compress, so adm-zip stores them.
    const payload = randomBytes(2048);
    zip.addFile('IMG-1.jpg', payload, '', 0);
    const blob = blobOf(zip.toBuffer());
    const [entry] = await readZipDirectory(blob);
    const bytes = await readZipEntry(blob, entry);
    expect(Buffer.from(bytes).equals(payload)).toBe(true);
  });

  it('preserves UTF-8 entry names', async () => {
    const zip = new AdmZip();
    zip.addFile('reçu-café.jpg', jpeg());
    const blob = blobOf(zip.toBuffer());
    const [entry] = await readZipDirectory(blob);
    expect(entry.name).toBe('reçu-café.jpg');
    expect((await readZipEntry(blob, entry)).byteLength).toBeGreaterThan(0);
  });

  it('rejects an entry whose actual inflated size exceeds the declared size (lying header)', async () => {
    // A central directory that under-declares the uncompressed size must not
    // let a larger payload through: the guard re-checks ACTUAL inflated bytes.
    const real = Buffer.alloc(300_000, 0x41);
    const deflated = deflateRawSync(real);
    const name = Buffer.from('big.txt', 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(1024, 22); // LIES: claims 1 KB
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10); // deflate
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(1024, 24); // LIES: claims 1 KB
    cd.writeUInt16LE(name.length, 28);
    const localBlock = Buffer.concat([local, name, deflated]);
    const cdBlock = Buffer.concat([cd, name]);
    cdBlock.writeUInt32LE(0, 42); // local header offset
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdBlock.length, 12);
    eocd.writeUInt32LE(localBlock.length, 16);
    const buf = Buffer.concat([localBlock, cdBlock, eocd]);

    const blob = blobOf(buf);
    const [entry] = await readZipDirectory(blob, { maxEntryCompressionRatio: 1_000_000 });
    await expect(readZipEntry(blob, entry, { maxEntryCompressionRatio: 1_000_000 })).rejects.toMatchObject({
      code: 'INVALID_ZIP',
    });
  });
});

describe('planWhatsappImport', () => {
  it('splits images and chat text, and skips everything else with a reason', async () => {
    const entries = await readZipDirectory(blobOf(whatsappZip()));
    const plan = planWhatsappImport(entries);
    expect(plan.images.map((e) => e.name)).toEqual([
      'IMG-20260712-WA0001.jpg',
      'IMG-20260712-WA0002.jpg',
    ]);
    expect(plan.texts.map((e) => e.name)).toEqual(['_chat.txt']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].name).toBe('PTT-20260712-WA0003.opus');
    expect(plan.skipped[0].reason).toMatch(/\.opus/);
  });

  it('skips directory entries silently rather than listing them as rejects', async () => {
    const zip = new AdmZip();
    zip.addFile('media/', Buffer.alloc(0));
    zip.addFile('media/IMG-1.jpg', jpeg());
    const entries = await readZipDirectory(blobOf(zip.toBuffer()));
    const plan = planWhatsappImport(entries);
    expect(plan.images.map((e) => e.name)).toEqual(['media/IMG-1.jpg']);
    expect(plan.skipped).toHaveLength(0);
  });

  it('skips an entry whose bytes exceed the per-item upload cap, naming the file', async () => {
    const zip = new AdmZip();
    zip.addFile('huge.jpg', jpeg(64));
    const entries = await readZipDirectory(blobOf(zip.toBuffer()));
    const plan = planWhatsappImport(entries, { maxItemBytes: 32 });
    expect(plan.images).toHaveLength(0);
    expect(plan.skipped[0].name).toBe('huge.jpg');
    expect(plan.skipped[0].reason).toMatch(/too large/i);
  });

  it('gives an oversized photo and an oversized transcript different advice', async () => {
    const zip = new AdmZip();
    zip.addFile('huge.jpg', jpeg(64));
    zip.addFile('_chat.txt', Buffer.from('x'.repeat(4096), 'utf8'));
    const entries = await readZipDirectory(blobOf(zip.toBuffer()));
    const plan = planWhatsappImport(entries, { maxItemBytes: 32 });
    const byName = Object.fromEntries(plan.skipped.map((s) => [s.name, s.reason]));
    expect(byName['huge.jpg']).toMatch(/photo/i);
    expect(byName['_chat.txt']).toMatch(/date range/i);
    // "re-send it as a photo" is nonsense advice for a text transcript.
    expect(byName['_chat.txt']).not.toMatch(/photo/i);
  });
});

describe('ZipReaderError', () => {
  it('carries a machine-readable code and a human message', () => {
    const err = new ZipReaderError('ZIP_BOMB', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ZIP_BOMB');
    expect(err.message).toBe('boom');
  });
});
