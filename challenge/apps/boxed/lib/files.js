// What a read is sent - one K-1 as a PDF, or up to six photos of one K-1 -
// checked on the way in, read once by the model, dropped.
//
// Never written anywhere: not to the store, not to a bucket, not to a log.
// It arrives as base64 in one request, is checked here BEFORE anything is
// spent (a Word file renamed .pdf, a 40-page PDF or a password-protected one
// is a 400, not a model call that fails), goes to the model as a `document`
// or `image` block, and is garbage when the request ends.

const Core = require('../public/boxed-core');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

/** The base64 of a {data} that may be a data: URL; null if it is not base64. */
function base64Of(raw) {
  let data = String((raw && raw.data) || '');
  const m = data.match(/^data:([a-z/+.-]+);base64,/i);
  if (m) data = data.slice(m[0].length);
  data = data.replace(/\s/g, '');
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return data;
}
const approxBytes = (b64) => Math.floor(b64.length * 3 / 4);

/** The real image type from the first bytes. A declared type is a claim. */
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Pages in a PDF, from its own structure: page objects (`/Type /Page`, not
 * `/Pages`) counted, else the largest `/Count` of a page tree. null when the
 * page tree is compressed out of sight - the model's own 100-page limit
 * still stands behind this.
 */
function pdfPages(buf) {
  const s = buf.toString('latin1');
  const pages = (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  if (pages) return pages;
  let max = 0;
  for (const m of s.matchAll(/\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max || null;
}

function validatePdf(raw) {
  const data = base64Of(raw);
  if (!data) throw httpError(400, 'That PDF could not be read. Try saving it again, or take photos of the K-1.');
  if (approxBytes(data) > Core.LIMITS.pdfBytes + 3) throw httpError(400, 'That PDF is over 10 MB. Save just the K-1 and its statements as their own PDF, and try again.');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw httpError(400, 'That PDF is empty.');
  if (buf.slice(0, 1024).indexOf('%PDF-') < 0) throw httpError(400, 'That file isn’t a PDF. Boxed reads K-1s as PDFs or photos.');
  if (/\/Encrypt\s/.test(buf.toString('latin1'))) throw httpError(400, 'That PDF is password-protected. Open it, print it to a new PDF, and try that one.');
  const pages = pdfPages(buf);
  if (pages && pages > Core.LIMITS.pdfPages) {
    throw httpError(400, `That PDF has ${pages} pages - Boxed reads up to ${Core.LIMITS.pdfPages} pages for one K-1. Save the K-1 and its statements on their own and try again.`);
  }
  return { kind: 'pdf', data: buf.toString('base64'), pages };
}

function validatePhoto(raw) {
  if (!raw || typeof raw !== 'object') throw httpError(400, 'Add a photo of the K-1.');
  const data = base64Of(raw);
  if (!data) throw httpError(400, 'That photo could not be read. Try a JPEG or PNG.');
  if (approxBytes(data) > Core.LIMITS.photoBytes + 3) throw httpError(400, 'A photo is over 3 MB. The page shrinks photos before sending - try again from the page.');
  const buf = Buffer.from(data, 'base64');
  const actual = sniffImage(buf);
  const declared = String(raw.type || '').toLowerCase();
  if (!actual || (declared && !IMAGE_TYPES.includes(declared))) throw httpError(400, 'Photos must be JPEG, PNG or WebP images.');
  return { mediaType: actual, data: buf.toString('base64') };
}

/** {pdf: {data}} or {photos: [{type, data}]} -> what the model is sent. */
function readInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.pdf && typeof b.pdf === 'object') return validatePdf(b.pdf);
  if (Array.isArray(b.photos) && b.photos.length) {
    if (b.photos.length > Core.LIMITS.photos) throw httpError(400, `Up to ${Core.LIMITS.photos} photos of one K-1 at a time.`);
    const approx = b.photos.reduce((n, p) => n + approxBytes(String((p && p.data) || '')), 0);
    if (approx > Core.LIMITS.photoTotal + 64) throw httpError(400, 'Those photos are too large together (12 MB). Try fewer.');
    return { kind: 'photo', photos: b.photos.map(validatePhoto) };
  }
  throw httpError(400, 'Add a K-1 as a PDF, or photos of its pages.');
}

module.exports = { readInput, validatePdf, validatePhoto, pdfPages, sniffImage, IMAGE_TYPES, httpError };
