// The picture a shared chart unfolds into when its link is pasted somewhere.
//
// The OWNER's browser draws it (public/render.js already knows how, and a
// Node canvas would be a native dependency for one picture), and this module
// decides whether what arrived is actually that picture: a PNG or a JPEG by
// its own bytes, exactly 1200x630 by its own header, small, and complete.
// Nothing about the request - its Content-Type, a filename, a claimed size -
// is believed on its own.
//
// Kept pure and synchronous so the tests can throw hostile bytes at it
// without a server.

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_BYTES = 400 * 1024;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Width and height from a PNG's IHDR, which the format requires to be the
 *  very first chunk. Also insists the file ENDS with IEND: a truncated upload
 *  or something appended after the image is refused, not stored. */
function pngInfo(buf) {
  if (buf.length < 8 + 25 + 12) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  // IEND chunk: length 0, type, CRC - the last twelve bytes.
  const tail = buf.subarray(buf.length - 12);
  if (tail.readUInt32BE(0) !== 0 || tail.toString('latin1', 4, 8) !== 'IEND') return null;
  return { type: 'image/png', ext: 'png', width, height };
}

/** Width and height from a JPEG's start-of-frame, found by walking the
 *  segment chain from the top (never by searching for bytes that might occur
 *  inside other data). Must end with the EOI marker. */
function jpegInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return null;
  let i = 2;
  for (let guard = 0; guard < 500 && i + 4 <= buf.length; guard++) {
    if (buf[i] !== 0xff) return null;
    while (i < buf.length && buf[i] === 0xff) i++;       // fill bytes
    if (i >= buf.length) return null;
    const marker = buf[i++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;  // image data before a frame header
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 7) return null;
      return { type: 'image/jpeg', ext: 'jpg', height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5) };
    }
    i += len;
  }
  return null;
}

/** What the bytes are, or null. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  return pngInfo(buf) || jpegInfo(buf);
}

/**
 * Accept a still or throw with a status and a sentence.
 *   413  too big (the route's body limit catches most of these first)
 *   415  not a complete PNG or JPEG, or not what the request said it was
 *   422  a real image of the wrong size
 */
function validate(buf, declaredType) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw fail(415, 'Send the picture as a PNG or JPEG.');
  if (buf.length > MAX_BYTES) throw fail(413, `That picture is over ${MAX_BYTES / 1024} KB.`);
  const info = sniff(buf);
  if (!info) throw fail(415, 'That is not a complete PNG or JPEG.');
  const declared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (declared && declared !== info.type) throw fail(415, 'The picture is not the type it says it is.');
  if (info.width !== WIDTH || info.height !== HEIGHT) {
    throw fail(422, `The picture must be exactly ${WIDTH}x${HEIGHT}.`);
  }
  return Object.assign({ bytes: buf.length }, info);
}

/** Whatever Firestore handed back for a bytes field, as a Buffer. The real
 *  client returns a Buffer; a JSON round trip (the test harness) returns
 *  {type:'Buffer', data:[...]}. Anything else is not an image. */
function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  return null;
}

module.exports = { WIDTH, HEIGHT, MAX_BYTES, sniff, validate, toBuffer };
