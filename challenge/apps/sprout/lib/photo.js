// A photo of a plant for "What plant is this? / What's wrong with it?":
// checked on the way in, read once by the model, dropped. (Shelf Life's,
// Chorus's and Flight's photo checks, unchanged in substance.)
//
// Never written anywhere - not to the store, not to a bucket, not to a log.
// It arrives as base64 in one request (the page shrinks it to about 1600px
// first), is validated here BEFORE anything is spent (a PDF renamed .jpg is a
// 400, not a model call that fails), goes to the model as an image block,
// and is garbage when the request ends. What survives is the cleaned answer
// (a name, a confidence, a few issues), which the person chooses to keep on
// their own phone or not.

const MAX_BYTES = 4 * 1024 * 1024;       // one photo, decoded
const MAX_TOTAL = 4 * 1024 * 1024;       // every photo together, decoded (fits the 6 MB parser as base64)
const MAX_PHOTOS = 1;                    // one plant
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/** The real type from the first bytes. A declared type is a claim. */
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * @param raw  { type, data } where data is base64 or a data: URL
 * @returns    { mediaType, data } ready to become an image content block
 */
function validate(raw) {
  if (!raw || typeof raw !== 'object') throw httpError(400, 'Add a photo of the plant.');
  let data = String(raw.data || '');
  let declared = String(raw.type || '').toLowerCase();
  const m = data.match(/^data:([a-z/+.-]+);base64,/i);
  if (m) { declared = declared || m[1].toLowerCase(); data = data.slice(m[0].length); }
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw httpError(400, 'That image could not be read. Try a JPEG or PNG photo.');
  // Size from the base64 length first, so a huge string is refused without
  // being decoded.
  if (Math.floor(data.replace(/\s/g, '').length * 3 / 4) > MAX_BYTES + 3) {
    throw httpError(400, 'A photo is too large (4 MB max). The app shrinks photos before sending - try again from the page.');
  }
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw httpError(400, 'That image is empty.');
  if (buf.length > MAX_BYTES) throw httpError(400, 'A photo is too large (4 MB max).');
  const actual = sniff(buf);
  if (!actual) throw httpError(400, 'The photo must be a JPEG, PNG or WebP image.');
  if (declared && !TYPES.includes(declared)) throw httpError(400, 'The photo must be a JPEG, PNG or WebP image.');
  return { mediaType: actual, data: buf.toString('base64') };
}

/** One photo (the list shape is Flight's). The total is checked from the base64
 *  lengths before any is decoded. */
function validateAll(list) {
  if (!Array.isArray(list) || !list.length) throw httpError(400, 'Add a photo of the plant.');
  if (list.length > MAX_PHOTOS) throw httpError(400, 'One photo at a time.');
  const approx = list.reduce((n, p) => n + Math.floor(String((p && p.data) || '').length * 3 / 4), 0);
  if (approx > MAX_TOTAL + 64) throw httpError(400, 'That photo is too large (4 MB max).');
  return list.map(validate);
}

module.exports = { validate, validateAll, sniff, MAX_BYTES, MAX_TOTAL, MAX_PHOTOS, TYPES };
