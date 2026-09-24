// Job photos: checked on the way in, handed to the model, then dropped.
//
// Photos are never written anywhere. They arrive as base64 in the draft
// request, are validated here, go to the model as image blocks, and are
// garbage the moment the request ends. What is stored is the quote the model
// helped write. A contractor's photos are of a customer's house - the inside of
// it, often - and there is no feature here that needs them kept.
//
// Validation happens BEFORE anything is spent: a wrong file type or an
// oversized image is a 400, not a model call that fails.

const MAX_PHOTOS = 4;
const MAX_BYTES = 1.5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** The real type from the first bytes. A declared type is a claim; the magic
 *  number is what the file is. */
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * @param raw  [{ type, data }] where data is base64 or a data: URL.
 * @returns    [{ mediaType, data }] ready to become image content blocks.
 */
function validate(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw httpError(400, 'Photos must be a list.');
  if (raw.length > MAX_PHOTOS) throw httpError(400, `Up to ${MAX_PHOTOS} photos per quote.`);
  return raw.map((p, i) => {
    let data = String((p && p.data) || '');
    let declared = String((p && p.type) || '').toLowerCase();
    const m = data.match(/^data:([a-z/+.-]+);base64,/i);
    if (m) { declared = declared || m[1].toLowerCase(); data = data.slice(m[0].length); }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) throw httpError(400, `Photo ${i + 1} is not a readable image.`);
    // Size from the base64 length first, so a 40MB string is refused without
    // being decoded into a 30MB buffer.
    if (Math.floor(data.replace(/\s/g, '').length * 3 / 4) > MAX_BYTES + 3) {
      throw httpError(400, `Photo ${i + 1} is too large (1.5 MB max). The app shrinks photos before sending - try again from the page.`);
    }
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) throw httpError(400, `Photo ${i + 1} is empty.`);
    if (buf.length > MAX_BYTES) throw httpError(400, `Photo ${i + 1} is too large (1.5 MB max).`);
    const actual = sniff(buf);
    if (!actual || !TYPES.includes(actual)) throw httpError(400, `Photo ${i + 1} must be a JPEG, PNG or WebP image.`);
    if (declared && TYPES.includes(declared) === false) throw httpError(400, `Photo ${i + 1} must be a JPEG, PNG or WebP image.`);
    return { mediaType: actual, data: buf.toString('base64') };
  });
}

module.exports = { validate, sniff, MAX_PHOTOS, MAX_BYTES, TYPES };
