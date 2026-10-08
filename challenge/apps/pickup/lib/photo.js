// A screenshot of the group chat for "Paste the group chat": checked on the
// way in, read once by the model, dropped. (Shelf Life's photo check, sized
// for the 4 MB parser this route mounts.)
//
// Never written anywhere - not to the store, not to a bucket, not to a log.
// It arrives as base64 in one request (the page shrinks it first, keeping the
// long side of a tall chat screenshot readable), is validated here BEFORE
// anything is spent (a PDF renamed .jpg is a 400, not a model call that
// fails), goes to the model as an image block, and is garbage when the
// request ends. What survives is a proposed list of answers, which the host
// ticks through before any of it is applied.

const MAX_BYTES = Math.floor(2.9 * 1024 * 1024); // decoded; as base64 it fits the 4 MB parser
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
  if (!raw || typeof raw !== 'object') throw httpError(400, 'Add a screenshot of the group chat.');
  let data = String(raw.data || '');
  let declared = String(raw.type || '').toLowerCase();
  const m = data.match(/^data:([a-z/+.-]+);base64,/i);
  if (m) { declared = declared || m[1].toLowerCase(); data = data.slice(m[0].length); }
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw httpError(400, 'That image could not be read. Try a PNG or JPEG screenshot.');
  // Size from the base64 length first, so a huge string is refused without
  // being decoded.
  if (Math.floor(data.replace(/\s/g, '').length * 3 / 4) > MAX_BYTES + 3) {
    throw httpError(400, 'That screenshot is too large. The app shrinks it before sending - try again from the page.');
  }
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw httpError(400, 'That image is empty.');
  if (buf.length > MAX_BYTES) throw httpError(400, 'That screenshot is too large.');
  const actual = sniff(buf);
  if (!actual) throw httpError(400, 'The screenshot must be a PNG, JPEG or WebP image.');
  if (declared && !TYPES.includes(declared)) throw httpError(400, 'The screenshot must be a PNG, JPEG or WebP image.');
  return { mediaType: actual, data: buf.toString('base64') };
}

module.exports = { validate, sniff, MAX_BYTES, TYPES };
