// Photos of a receipt: checked on the way in, read once by the model,
// dropped.
//
// Never written anywhere - not to the store, not to a bucket, not to a log.
// They arrive as base64 in one request (the page shrinks each to about
// 1600px first), are validated here BEFORE anything is spent (a PDF renamed
// .jpg is a 400, not a model call that fails), go to the model as image
// blocks, and are garbage when the request ends. What survives is the list
// of lines the person reviews on their own phone - nothing is written.

const MAX_BYTES = 4 * 1024 * 1024;       // one photo, decoded
const MAX_TOTAL = 8 * 1024 * 1024;       // every photo together, decoded (fits the 12 MB parser as base64)
const MAX_PHOTOS = 2;                    // a long receipt in two halves
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
  if (!raw || typeof raw !== 'object') throw httpError(400, 'Add a photo of the receipt.');
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

/** Up to two photos, in order. The total is checked from the base64
 *  lengths before any is decoded. */
function validateAll(list) {
  if (!Array.isArray(list) || !list.length) throw httpError(400, 'Add a photo of the receipt.');
  if (list.length > MAX_PHOTOS) throw httpError(400, `Up to ${MAX_PHOTOS} photos at a time.`);
  const approx = list.reduce((n, p) => n + Math.floor(String((p && p.data) || '').length * 3 / 4), 0);
  if (approx > MAX_TOTAL + 64) throw httpError(400, 'Those photos are too large together (8 MB max). Try fewer.');
  return list.map(validate);
}

module.exports = { validate, validateAll, sniff, MAX_BYTES, MAX_TOTAL, MAX_PHOTOS, TYPES };
