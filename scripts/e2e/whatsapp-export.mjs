/**
 * Realistic WhatsApp "Export Chat → Attach Media" archive generator.
 *
 * This is the foundation of the end-to-end harness: nothing downstream is
 * worth anything unless the thing being uploaded looks like what the operator
 * actually exports off his phone.
 *
 * What it reproduces:
 *   • a transcript file in WhatsApp's real line format (Android and iOS
 *     variants), including the "(file attached)" / "<attached: …>" lines that
 *     tie a message to a photo, the encryption notice, and multi-line messages
 *   • N photos with WhatsApp's real naming (IMG-20260712-WA0031.jpg on
 *     Android, 00000031-PHOTO-2026-07-12-09-16-31.jpg on iOS)
 *   • realistic per-photo sizes — WhatsApp re-compresses in-chat photos to
 *     roughly 100–500 KB — and realistic incompressibility, so the .zip is
 *     about the same size as the photos it holds (real exports barely deflate)
 *   • the archive stored the way WhatsApp stores it: DEFLATE, flat, no
 *     directory entries
 *
 * DETERMINISTIC: the same --seed always produces byte-identical photos. That
 * is what makes the dedup scenarios meaningful — "the same receipt" has to be
 * literally the same bytes, because the product dedupes on content hash.
 *
 * CLI:
 *   node scripts/e2e/whatsapp-export.mjs --out /tmp/export.zip --images 120 \
 *        --total-mb 28.5 --seed 1
 *
 * Options:
 *   --out <path>        output .zip path (required)
 *   --images <n>        number of photos (default 120)
 *   --total-mb <n>      target total photo payload in MB (default 28.5)
 *   --min-kb/--max-kb   per-photo size band (default 100/500, ignored when
 *                       --total-mb is set — the band is scaled to hit it)
 *   --seed <n>          PRNG seed (default 1)
 *   --format android|ios   transcript/naming convention (default android)
 *   --chat-name <name>  transcript filename (default _chat.txt)
 *   --start-index <n>   first photo sequence number (default 1) — use this to
 *                       build an OVERLAPPING archive that shares some photos
 *                       with an earlier one and adds new ones
 *   --media-dir <dir>   use REAL photographs from this directory instead of
 *                       synthetic ones. Needed only when pointing the harness
 *                       at a live OCR service, which has to see actual receipts
 *   --extra <spec>      add a non-photo entry, repeatable. Specs:
 *                         voice        → PTT-20260712-WA0004.opus (skipped type)
 *                         video        → VID-20260712-WA0009.mp4  (skipped type)
 *                         fake-jpeg    → a .jpg that is not an image at all
 *                         huge-jpeg    → a single photo over the per-file cap
 *                         traversal    → an entry named ../escape.jpg
 */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildJpeg, makeRng, randomBytes } from './jpeg.mjs';

const SENDERS = ['Raj Abeysinghe', 'Nadeesha', 'Sunil (Caretaker)', 'Ko Lake Ops'];
const VENDORS = [
  'Ceylon Hardware',
  'Koggala Fuel',
  'Ahangama Fish Market',
  'Cargills Food City',
  'Lanka Electricals',
  'Galle Plumbing Supplies',
  'Kumar Transport',
];

/** WhatsApp's own in-chat photo size band, in bytes. */
export const WHATSAPP_MIN_PHOTO_BYTES = 100 * 1024;
export const WHATSAPP_MAX_PHOTO_BYTES = 500 * 1024;

const pad = (n, width) => String(n).padStart(width, '0');

/**
 * Photo filename in WhatsApp's real convention.
 * Android: IMG-20260712-WA0031.jpg   iOS: 00000031-PHOTO-2026-07-12-09-16-31.jpg
 */
export function photoName(format, index, date) {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1, 2);
  const d = pad(date.getUTCDate(), 2);
  if (format === 'ios') {
    const hh = pad(date.getUTCHours(), 2);
    const mm = pad(date.getUTCMinutes(), 2);
    const ss = pad(date.getUTCSeconds(), 2);
    return `${pad(index, 8)}-PHOTO-${y}-${m}-${d}-${hh}-${mm}-${ss}.jpg`;
  }
  return `IMG-${y}${m}${d}-WA${pad(index, 4)}.jpg`;
}

function transcriptLine(format, date, sender, body) {
  const d = pad(date.getUTCDate(), 2);
  const m = pad(date.getUTCMonth() + 1, 2);
  const y = date.getUTCFullYear();
  const hh = pad(date.getUTCHours(), 2);
  const mm = pad(date.getUTCMinutes(), 2);
  const ss = pad(date.getUTCSeconds(), 2);
  if (format === 'ios') {
    // iOS wraps the timestamp in brackets and prefixes the line with U+200E.
    return `‎[${d}/${m}/${y}, ${hh}:${mm}:${ss}] ${sender}: ${body}`;
  }
  return `${d}/${m}/${y}, ${hh}:${mm} - ${sender}: ${body}`;
}

function attachmentBody(format, name) {
  return format === 'ios' ? `‎<attached: ${name}>` : `${name} (file attached)`;
}

/**
 * Size and timestamp of one photo, as a pure function of (seed, SEQUENCE).
 *
 * Keyed on the sequence number and nothing else about the archive, because
 * the whole dedup story depends on it: "photo 31" has to be byte-identical in
 * every archive that contains photo 31, or an "overlapping export" is not
 * overlapping at all and the dedup scenarios silently test nothing.
 *
 * (This was a real bug in the first version of this generator, caught by the
 * overlap scenario itself: sizes were spread across whatever the archive's
 * total happened to be, so the same photo differed between archives and every
 * entry looked new.)
 */
export function photoPlanFor({ seed, sequence, meanBytes, minBytes, maxBytes }) {
  // Golden-ratio low-discrepancy sequence rather than a plain PRNG: it is still
  // a pure function of the sequence number, but its average converges on 0.5
  // far faster, so an archive asked for 28.5 MB actually lands near 28.5 MB
  // instead of a few percent under.
  const phase = ((seed * 0.7548776662466927 + sequence * 0.6180339887498949) % 1 + 1) % 1;
  const spread = 0.55 + phase * 0.9;
  const bytes = Math.max(minBytes, Math.min(maxBytes, Math.round(meanBytes * spread)));
  // Monotonic, deterministic clock: photos arrive a few minutes apart.
  const jitter = makeRng((seed * 2654435761 + sequence * 40503) >>> 0)();
  const offsetMs = sequence * 6 * 60_000 + Math.round(jitter * 4 * 60_000);
  return { bytes, offsetMs };
}

/** A zip entry: name + raw bytes, stored with DEFLATE like WhatsApp does. */
function zipEntry(name, data) {
  return { name, data };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Write a real zip archive (local headers + central directory + EOCD),
 * DEFLATE-compressed, matching how a phone exports a chat.
 *
 * Hand-rolled rather than pulled from adm-zip on purpose: adm-zip is the
 * library the SERVER uses to read these archives, and a fixture written by the
 * same library that reads it can hide a whole class of interoperability bug.
 */
export function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, compressed);
    central.push(centralHeader, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * Build a complete WhatsApp export in memory.
 *
 * @returns {{ zip: Buffer, manifest: object }} the archive plus a manifest
 *   describing exactly what is inside it, so a test can assert against the
 *   truth rather than against the application's own report.
 */
export function buildWhatsappExport(options = {}) {
  const {
    images = 120,
    totalBytes = Math.round(28.5 * 1024 * 1024),
    minBytes = WHATSAPP_MIN_PHOTO_BYTES,
    maxBytes = WHATSAPP_MAX_PHOTO_BYTES,
    seed = 1,
    format = 'android',
    chatName = '_chat.txt',
    startIndex = 1,
    extras = [],
    /** Real photograph buffers to use instead of synthetic ones — see below. */
    media = null,
  } = options;

  // The mean is the archive-level knob; each photo's own size comes from its
  // sequence number, so shared photos are identical across archives. Pass
  // meanBytes explicitly when building an overlapping archive of a different
  // length, or the shared photos will not be the same bytes.
  const meanBytes = options.meanBytes ?? Math.round(totalBytes / Math.max(1, images));
  const entries = [];
  const photos = [];
  const lines = [];

  const day = new Date(Date.UTC(2026, 6, 12, 8, 30, 0));
  lines.push(
    transcriptLine(
      format,
      day,
      'Ko Lake Ops',
      'Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
    ),
  );

  let lastStamp = day;
  for (let i = 0; i < images; i += 1) {
    const sequence = startIndex + i;
    const plan = photoPlanFor({ seed, sequence, meanBytes, minBytes, maxBytes });
    const stamp = new Date(day.getTime() + plan.offsetMs);
    lastStamp = stamp;
    const name = photoName(format, sequence, stamp);
    // Seeded off the SEQUENCE, not the loop index, so photo #31 is the same
    // bytes in every archive that contains photo #31 — that is what makes an
    // overlapping archive genuinely overlapping.
    //
    // `media` (from --media-dir) replaces the synthetic photo with a real
    // photograph, cycled by sequence so the same slot always gets the same
    // file. Use it when the OCR service is real rather than stubbed.
    const data =
      media && media.length > 0
        ? media[sequence % media.length]
        : buildJpeg({ targetBytes: plan.bytes, seed: (seed * 1_000_003 + sequence) >>> 0 });
    const sender = SENDERS[sequence % SENDERS.length];
    const vendor = VENDORS[sequence % VENDORS.length];
    const amount = (500 + ((sequence * 337) % 12_000)) / 100;

    lines.push(transcriptLine(format, stamp, sender, attachmentBody(format, name)));
    lines.push(transcriptLine(format, stamp, sender, `${vendor} — LKR ${amount.toFixed(2)}`));
    if (sequence % 17 === 0) {
      // Real transcripts contain multi-line messages; the continuation line has
      // no timestamp and must not be counted as a message.
      lines.push('Paid cash from the petty tin,');
      lines.push('receipt attached above.');
    }

    entries.push(zipEntry(name, data));
    photos.push({
      name,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      sequence,
    });
  }

  for (const extra of extras) {
    if (extra === 'voice') {
      entries.push(zipEntry('PTT-20260712-WA0004.opus', randomBytes(seed ^ 0xa1, 24_000)));
      lines.push(
        transcriptLine(format, lastStamp, SENDERS[1], attachmentBody(format, 'PTT-20260712-WA0004.opus')),
      );
    } else if (extra === 'video') {
      entries.push(zipEntry('VID-20260712-WA0009.mp4', randomBytes(seed ^ 0xb2, 1_400_000)));
      lines.push(
        transcriptLine(format, lastStamp, SENDERS[2], attachmentBody(format, 'VID-20260712-WA0009.mp4')),
      );
    } else if (extra === 'fake-jpeg') {
      // .jpg extension, not an image — the magic-byte guard must catch this.
      entries.push(zipEntry('IMG-20260712-WA9001.jpg', Buffer.from('This is a text file pretending to be a photo.\n'.repeat(40))));
    } else if (extra === 'huge-jpeg') {
      // Deliberately over the per-file transport cap (4 MB).
      entries.push(
        zipEntry('IMG-20260712-WA9002.jpg', buildJpeg({ targetBytes: 6 * 1024 * 1024, seed: seed ^ 0xc3 })),
      );
    } else if (extra === 'traversal') {
      entries.push(zipEntry('../escape.jpg', buildJpeg({ targetBytes: 120 * 1024, seed: seed ^ 0xd4 })));
    } else {
      throw new Error(`unknown --extra "${extra}"`);
    }
  }

  const chatText = `${lines.join('\r\n')}\r\n`;
  const chatData = Buffer.from(chatText, 'utf8');
  // WhatsApp puts the transcript first in the archive.
  entries.unshift(zipEntry(chatName, chatData));

  const zip = buildZip(entries);
  return {
    zip,
    manifest: {
      format,
      seed,
      // Pass this back into buildWhatsappExport as `meanBytes` when building an
      // overlapping archive, or the shared photos will not be identical bytes.
      meanBytes,
      chatName,
      chatBytes: chatData.length,
      chatSha256: createHash('sha256').update(chatData).digest('hex'),
      photos,
      photoCount: photos.length,
      photoBytes: photos.reduce((a, p) => a + p.bytes, 0),
      extras,
      entryCount: entries.length,
      zipBytes: zip.length,
      zipSha256: createHash('sha256').update(zip).digest('hex'),
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { extras: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (key === 'extra') {
      out.extras.push(value);
      i += 1;
    } else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

/**
 * Load real photographs from a directory, sorted so runs are reproducible.
 *
 * JPEG only, deliberately. `photoName` always emits a `.jpg` name, so a PNG or
 * HEIC picked up here would be written into the archive under a `.jpg`
 * extension — bytes and extension disagreeing. The server would then reject it
 * on magic bytes and the harness would "discover" a bug it had manufactured
 * itself. Anything else in the directory is skipped with a clear message.
 */
export async function loadMediaDir(dir) {
  const all = await readdir(dir);
  const names = all.filter((name) => /\.jpe?g$/i.test(name)).sort();
  const ignored = all.filter((name) => /\.(png|webp|heic|heif)$/i.test(name));
  if (ignored.length > 0) {
    console.warn(
      `[media-dir] ignoring ${ignored.length} non-JPEG image(s): archive entries are named .jpg, so ` +
        'only JPEG source files can be used. Convert them first if you need them.',
    );
  }
  if (names.length === 0) throw new Error(`--media-dir ${dir} contains no JPEG images`);
  return Promise.all(names.map((name) => readFile(path.join(dir, name))));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error('usage: node scripts/e2e/whatsapp-export.mjs --out <file.zip> [--images N] [--total-mb N] [--seed N]');
    process.exit(2);
  }
  const options = {
    media: args['media-dir'] ? await loadMediaDir(args['media-dir']) : null,
    images: args.images ? Number(args.images) : 120,
    totalBytes: Math.round((args['total-mb'] ? Number(args['total-mb']) : 28.5) * 1024 * 1024),
    minBytes: args['min-kb'] ? Number(args['min-kb']) * 1024 : WHATSAPP_MIN_PHOTO_BYTES,
    maxBytes: args['max-kb'] ? Number(args['max-kb']) * 1024 : WHATSAPP_MAX_PHOTO_BYTES,
    seed: args.seed ? Number(args.seed) : 1,
    format: args.format ?? 'android',
    chatName: args['chat-name'] ?? '_chat.txt',
    startIndex: args['start-index'] ? Number(args['start-index']) : 1,
    extras: args.extras,
  };

  const { zip, manifest } = buildWhatsappExport(options);
  await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await writeFile(args.out, zip);
  if (args.manifest) await writeFile(args.manifest, JSON.stringify(manifest, null, 2));

  const mb = (n) => (n / (1024 * 1024)).toFixed(2);
  console.log(
    `wrote ${args.out}: ${manifest.entryCount} entries, ${manifest.photoCount} photos, ` +
      `${mb(manifest.photoBytes)} MB of photos, ${mb(manifest.zipBytes)} MB archive ` +
      `(compression ${(manifest.zipBytes / Math.max(1, manifest.photoBytes)).toFixed(3)}x — real exports are ~1.0x)`,
  );
}

// pathToFileURL rather than string-concatenating "file://": the naive form
// breaks for paths with spaces or non-ASCII characters, silently turning the
// CLI into a no-op when someone runs it from such a directory.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
