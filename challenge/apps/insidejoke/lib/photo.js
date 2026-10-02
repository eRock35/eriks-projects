// Photos for questions: checked on the way in; the larger copy is read once
// by the model and dropped, the thumbnail is kept.
//
// The page redraws every photo through a canvas before anything is sent,
// which leaves no EXIF behind - no GPS, no camera serial. The server does
// not take that on trust: the thumbnail's JPEG segments are walked and any
// metadata segment (APP1 Exif/XMP, APP13 IPTC, comments) is dropped before
// it is stored. Types are sniffed from the bytes, never from what the
// request claims, and sizes are checked from the base64 length before
// anything is decoded.

const THUMB_MAX = 120 * 1024;            // a stored thumbnail, decoded
const THUMB_SIDE = 800;                  // px, either side
const IMAGE_MAX = 2 * 1024 * 1024;       // the model's copy, decoded
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function decode(raw, max, what) {
  let data = typeof raw === 'string' ? raw : String((raw && raw.data) || '');
  const m = data.match(/^data:([a-z/+.-]+);base64,/i);
  if (m) data = data.slice(m[0].length);
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw httpError(400, `The ${what} could not be read. Try a JPEG or PNG photo.`);
  if (Math.floor(data.replace(/\s/g, '').length * 3 / 4) > max + 3) throw httpError(400, `The ${what} is too large. The page shrinks photos before sending - try again from the page.`);
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw httpError(400, `The ${what} is empty.`);
  if (buf.length > max) throw httpError(400, `The ${what} is too large.`);
  return buf;
}

/** A JPEG's size from its first frame header, or null. */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** The JPEG without its metadata segments (APP1-APP13, APP15, comments).
 *  APP0 (JFIF) and APP14 (Adobe colour) stay: they change how it looks. */
function stripJpegMeta(buf) {
  const parts = [buf.slice(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw httpError(400, 'That thumbnail is not a JPEG the page made.');
    const marker = buf[i + 1];
    if (marker === 0xda) { parts.push(buf.slice(i)); return Buffer.concat(parts); }
    if (marker === 0xd9) { parts.push(buf.slice(i, i + 2)); return Buffer.concat(parts); }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw httpError(400, 'That thumbnail is not a JPEG the page made.');
    const drop = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!drop) parts.push(buf.slice(i, i + 2 + len));
    i += 2 + len;
  }
  throw httpError(400, 'That thumbnail is not a JPEG the page made.');
}

/** The stored thumbnail: a JPEG, at most 800px a side and 120 KB. */
function thumbnail(raw) {
  const buf = decode(raw, THUMB_MAX, 'thumbnail');
  if (sniff(buf) !== 'image/jpeg') throw httpError(400, 'The thumbnail must be a JPEG.');
  const size = jpegSize(buf);
  if (!size || !size.width || !size.height || size.width > THUMB_SIDE || size.height > THUMB_SIDE) throw httpError(400, 'The thumbnail must be at most 800 pixels a side.');
  const clean = stripJpegMeta(buf);
  return { data: clean.toString('base64'), bytes: clean.length, width: size.width, height: size.height };
}

/** The model's copy: read once and dropped. */
function forModel(raw) {
  if (!raw || typeof raw !== 'object') throw httpError(400, 'Add a photo.');
  const buf = decode(raw, IMAGE_MAX, 'photo');
  const actual = sniff(buf);
  if (!actual) throw httpError(400, 'The photo must be a JPEG, PNG or WebP image.');
  const declared = String(raw.type || '').toLowerCase();
  if (declared && !TYPES.includes(declared)) throw httpError(400, 'The photo must be a JPEG, PNG or WebP image.');
  return { mediaType: actual, data: buf.toString('base64') };
}

module.exports = { thumbnail, forModel, sniff, jpegSize, stripJpegMeta, THUMB_MAX, IMAGE_MAX, THUMB_SIDE };
