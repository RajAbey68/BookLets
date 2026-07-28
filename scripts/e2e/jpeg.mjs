/**
 * Minimal, GENUINELY VALID baseline JPEG builder — no image libraries.
 *
 * Why this exists: the receipt-import path checks real magic bytes
 * (src/lib/upload-guard.ts assertImageMagicBytes), the browser-side reader in
 * PR #133 hands the bytes to the platform as a File, and a harness that
 * uploads `Buffer.alloc(200_000)` renamed to .jpg would prove nothing about
 * what happens with a real WhatsApp photo. So the harness builds real JPEGs.
 *
 * WHAT IS REAL AND WHAT IS NOT — stated plainly, because a test fixture that
 * overstates itself is how you get green tests on a broken feature:
 *
 *   REAL  — SOI/APP0-JFIF/DQT/SOF0/DHT/SOS/EOI structure, the standard
 *           (ITU T.81 Annex K) luminance quantisation and Huffman tables, a
 *           correctly Huffman-coded entropy segment, and correct magic bytes.
 *           Chromium decodes the output (the harness verifies this in its
 *           browser leg). It is a decodable, solid mid-grey image.
 *   NOT   — the picture is flat grey, not a photograph of a receipt. Bulk is
 *           added as COM (comment) segments carrying seeded pseudo-random
 *           bytes, which every decoder skips. That gives files with realistic
 *           SIZE and realistic INCOMPRESSIBILITY (a real JPEG barely deflates,
 *           and so does this) without shipping binary fixtures in the repo.
 *
 * Consequence, and it matters: OCR run against these would read nothing. The
 * harness therefore stubs the OCR microservice (scripts/e2e/stubs.mjs). If you
 * point the harness at a live OCR service, use --media-dir to supply real
 * photographs instead.
 */

/** ITU T.81 Annex K.1 — standard luminance quantisation table, zig-zag order. */
const STD_LUMINANCE_QUANT = [
  16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40, 26, 24, 22, 22, 24, 49, 35, 37,
  29, 40, 58, 51, 61, 60, 57, 51, 56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87,
  95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99,
];

/** ITU T.81 Annex K.3.3.1 — standard DC luminance Huffman table. */
const STD_DC_LUM_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const STD_DC_LUM_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** ITU T.81 Annex K.3.3.2 — standard AC luminance Huffman table. */
const STD_AC_LUM_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const STD_AC_LUM_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** Largest payload a JPEG marker segment can carry (65535 minus the length field). */
const MAX_SEGMENT_PAYLOAD = 65533;

/** Deterministic 32-bit PRNG (mulberry32) — same seed always gives same bytes. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `length` pseudo-random bytes from `seed`. Incompressible, like photo data. */
export function randomBytes(seed, length) {
  const rng = makeRng(seed);
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(rng() * 256) & 0xff;
  return out;
}

function segment(marker, payload) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(marker, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/**
 * Huffman-coded entropy segment for a flat image: every block is
 * "DC difference 0" followed by End-Of-Block.
 *
 * With the standard luminance tables the DC symbol 0 is the 2-bit code 00 and
 * the AC EOB symbol 0x00 is the 4-bit code 1010, so each 8x8 block costs
 * exactly 6 bits. The resulting byte stream never contains 0xFF, so no
 * byte-stuffing is required — verified by the assertion below rather than
 * assumed.
 */
function flatEntropyData(blockCount) {
  const bits = [];
  for (let i = 0; i < blockCount; i += 1) {
    bits.push(0, 0); // DC category 0 → code "00"
    bits.push(1, 0, 1, 0); // AC EOB → code "1010"
  }
  while (bits.length % 8 !== 0) bits.push(1); // JPEG pads with 1-bits
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  if (out.includes(0xff)) {
    throw new Error('jpeg: entropy stream contains 0xFF and would need byte-stuffing');
  }
  return out;
}

/**
 * Build a valid baseline JPEG of approximately `targetBytes`.
 *
 * @param {object} options
 * @param {number} options.targetBytes  desired file size in bytes
 * @param {number} options.seed         PRNG seed — same seed ⇒ identical bytes
 * @param {number} [options.width]      image width in pixels (multiple of 8)
 * @param {number} [options.height]     image height in pixels (multiple of 8)
 * @returns {Buffer} a decodable JPEG
 */
export function buildJpeg({ targetBytes, seed, width = 640, height = 480 }) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = segment(
    0xffe0,
    Buffer.concat([
      Buffer.from('JFIF\0', 'latin1'),
      Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    ]),
  );
  const dqt = segment(0xffdb, Buffer.from([0x00, ...STD_LUMINANCE_QUANT]));

  const sof0 = segment(
    0xffc0,
    Buffer.from([
      0x08, // 8-bit precision
      (height >> 8) & 0xff,
      height & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
      0x01, // one component (greyscale)
      0x01, // component id
      0x11, // 1x1 sampling
      0x00, // quant table 0
    ]),
  );

  const dhtDc = segment(0xffc4, Buffer.from([0x00, ...STD_DC_LUM_BITS, ...STD_DC_LUM_VALUES]));
  const dhtAc = segment(0xffc4, Buffer.from([0x10, ...STD_AC_LUM_BITS, ...STD_AC_LUM_VALUES]));
  const sos = segment(0xffda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));

  const blockCount = Math.ceil(width / 8) * Math.ceil(height / 8);
  const entropy = flatEntropyData(blockCount);
  const eoi = Buffer.from([0xff, 0xd9]);

  const fixed =
    soi.length +
    app0.length +
    dqt.length +
    sof0.length +
    dhtDc.length +
    dhtAc.length +
    sos.length +
    entropy.length +
    eoi.length;

  // Bulk goes in COM segments: decoders skip them, so the image stays valid,
  // and pseudo-random content makes the file as incompressible as a real photo.
  const padTotal = Math.max(0, targetBytes - fixed);
  const comments = [];
  let remaining = padTotal;
  let chunkSeed = seed;
  while (remaining > 0) {
    // Each segment costs 4 bytes of framing (marker + length).
    const payload = Math.max(1, Math.min(MAX_SEGMENT_PAYLOAD, remaining - 4));
    comments.push(segment(0xfffe, randomBytes(chunkSeed, payload)));
    remaining -= payload + 4;
    // Math.imul, not `*`: the plain multiply goes through a double and loses
    // low bits above 2^53, so successive chunk seeds could collide and repeat
    // the same "random" padding — which would make the file compressible and
    // stop it behaving like a real photo.
    chunkSeed = (Math.imul(chunkSeed, 2654435761) + 1) >>> 0;
  }

  return Buffer.concat([soi, app0, ...comments, dqt, sof0, dhtDc, dhtAc, sos, entropy, eoi]);
}

/** True when `buffer` starts with the JPEG SOI+marker signature FF D8 FF. */
export function looksLikeJpeg(buffer) {
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}
