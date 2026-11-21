// The one photo "Read the order slip" sends, checked by its BYTES - never
// by what the request claims - and stripped of its metadata before the
// model sees it. The page already redrew it through a canvas at about
// 1600 px (which drops EXIF, location included); this is the server's own
// check, so a request that skipped the page gets the same treatment.
//
// sniff / cleanJpeg / cleanPng are Sorted's (challenge/apps/sorted/lib/grabs.js),
// by way of Takeback, Whichbox and Pencil; WebP is new here.

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf.length >= 16 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
/** A JPEG without its metadata segments (APP1-APP13, APP15, comments), and
 *  its size from the first frame header. APP0 (JFIF) and APP14 (Adobe
 *  colour) stay: they change how it looks. */
function cleanJpeg(buf) {
  const parts = [buf.subarray(0, 2)];
  let size = null;
  let i = 2;
  const bad = () => httpError(400, 'That photo isn’t a JPEG the page made. Try choosing it again.');
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw bad();
    const marker = buf[i + 1];
    if (marker === 0xda) { parts.push(buf.subarray(i)); return { buf: Buffer.concat(parts), size }; }
    if (marker === 0xd9) { parts.push(buf.subarray(i, i + 2)); return { buf: Buffer.concat(parts), size }; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw bad();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && len >= 7) {
      size = { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const drop = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!drop) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  throw bad();
}
/** A PNG with only the chunks that draw it (text, EXIF and time dropped),
 *  and its size from IHDR. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs']);
function cleanPng(buf) {
  const parts = [PNG_SIG];
  let i = 8;
  let size = null;
  const bad = () => httpError(400, 'That photo isn’t a PNG the page made. Try choosing it again.');
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type) || i + 12 + len > buf.length) throw bad();
    if (type === 'IHDR') size = { width: buf.readUInt32BE(i + 8), height: buf.readUInt32BE(i + 12) };
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') return { buf: Buffer.concat(parts), size };
  }
  throw bad();
}
/** A still WebP with only the chunks that draw it (EXIF and XMP dropped, and
 *  their flags cleared), its size from VP8X, VP8 or VP8L. An animation is
 *  refused: an order slip is one picture. */
const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ICCP']);
function cleanWebp(buf) {
  const bad = () => httpError(400, 'That photo isn’t a WebP the page made. Try choosing it again.');
  if (buf.length < 20 || buf.readUInt32LE(4) + 8 > buf.length) throw bad();
  const end = buf.readUInt32LE(4) + 8;
  const parts = [];
  let i = 12;
  let size = null;
  while (i + 8 <= end) {
    const type = buf.subarray(i, i + 4).toString('latin1');
    const len = buf.readUInt32LE(i + 4);
    if (!/^[A-Z0-9 ]{4}$/.test(type) || i + 8 + len > end) throw bad();
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'ANIM' || type === 'ANMF') throw httpError(400, 'That is a moving picture. Send a photo of the slip.');
    if (type === 'VP8X' && len >= 10) {
      if (data[0] & 0x02) throw httpError(400, 'That is a moving picture. Send a photo of the slip.');
      size = { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
    }
    if (type === 'VP8 ' && len >= 10 && !size) size = { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
    if (type === 'VP8L' && len >= 5 && data[0] === 0x2f && !size) { const b = data.readUInt32LE(1); size = { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 }; }
    if (WEBP_KEEP.has(type)) {
      const chunk = Buffer.from(buf.subarray(i, i + 8 + len + (len % 2)));
      if (type === 'VP8X') chunk[8] &= ~0x0c;          // no EXIF, no XMP
      parts.push(chunk);
    }
    i += 8 + len + (len % 2);
  }
  if (!parts.some((p) => /^VP8[ L]$/.test(p.subarray(0, 4).toString('latin1')))) throw bad();
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return { buf: Buffer.concat([head, body]), size };
}

module.exports = { httpError, sniff, cleanJpeg, cleanPng, cleanWebp };
