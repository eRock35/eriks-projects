// The one photo "Count it from a photo" sends, checked by its BYTES - never
// by what the request claims - and stripped of its metadata before the model
// sees it. The page already redrew it through a canvas at about 1200 px
// (which drops EXIF, location included); this is the server's own check, so
// a request that skipped the page gets the same treatment.
//
// sniff / cleanJpeg / cleanPng are Sorted's (challenge/apps/sorted/lib/grabs.js).

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
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

module.exports = { httpError, sniff, cleanJpeg, cleanPng };
