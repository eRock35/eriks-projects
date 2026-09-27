// Pictures and video frames on the way in: checked by their bytes, read once,
// dropped.
//
// Never written anywhere - not the store, not a bucket, not a log. A picture
// arrives as base64 in one request, is checked here BEFORE anything is spent
// (a PDF renamed .jpg is a 400, not a model call that fails), and is garbage
// when the request ends.
//
// Two shapes:
//   - `preview`: what the model sees. The page and the extension draw it
//     themselves (~1024 px JPEG). JPEG, PNG, WebP or GIF, at most 3.75 MB
//     decoded (Anthropic's per-image limit is 5 MB of base64).
//   - `original`: the untouched file, only so its METADATA can be read here
//     (the Shortcut cannot run our scanner). Any image type the scanner
//     knows, at most 8 MB.
// Frames: 1 to 8 JPEG/PNG/WebP previews, at most 700 KB each.

const Meta = require('../public/tells-meta');

const PREVIEW_BYTES = Math.floor(3.75 * 1024 * 1024);
const ORIGINAL_BYTES = 8 * 1024 * 1024;
const FRAME_BYTES = 700 * 1024;
const MAX_FRAMES = 8;
const MODEL_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ORIGINAL_TYPES = [...MODEL_TYPES, 'image/heic', 'image/avif'];

function fail(status, message) { return Object.assign(new Error(message), { status, expose: true }); }

/** base64 (or a data: URL) -> Buffer, refusing oversize before decoding. */
function decode(raw, max, what) {
  let data = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? String(raw.data || '') : '');
  const m = data.match(/^data:[a-z/+.-]+;base64,/i);
  if (m) data = data.slice(m[0].length);
  data = data.replace(/\s/g, '');
  if (!data) throw fail(400, `Add ${what}.`);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(data)) throw fail(400, `${what[0].toUpperCase()}${what.slice(1)} could not be read.`);
  if (Math.floor(data.length * 3 / 4) > max + 3) throw fail(400, `${what[0].toUpperCase()}${what.slice(1)} is too large (${Math.round(max / 1024 / 1024 * 10) / 10} MB max).`);
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw fail(400, `${what[0].toUpperCase()}${what.slice(1)} is empty.`);
  if (buf.length > max) throw fail(400, `${what[0].toUpperCase()}${what.slice(1)} is too large.`);
  return buf;
}

function preview(raw) {
  const buf = decode(raw, PREVIEW_BYTES, 'a picture');
  const type = Meta.sniff(buf);
  if (!MODEL_TYPES.includes(type)) throw fail(400, 'The picture must be a JPEG, PNG, WebP or GIF.');
  return { mediaType: type, data: buf.toString('base64'), bytes: buf.length };
}

function original(raw) {
  const buf = decode(raw, ORIGINAL_BYTES, 'the original file');
  const type = Meta.sniff(buf);
  if (!ORIGINAL_TYPES.includes(type)) throw fail(400, 'The original must be a JPEG, PNG, WebP, GIF, HEIC or AVIF picture.');
  return { mediaType: type, buf };
}

/**
 * The same picture without its metadata segments, for the one case where an
 * original goes to the model (the Shortcut sent no separate preview): EXIF -
 * which can hold GPS - XMP, IPTC and comments are cut out of a JPEG, and the
 * text and EXIF chunks out of a PNG. The pixels are untouched. Other types
 * are not sent to the model as originals at all.
 */
function stripMeta(buf, type) {
  if (type === 'image/jpeg') {
    const keep = [buf.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= buf.length && buf[i] === 0xff) {
      const m = buf[i + 1];
      if (m === 0xda || m === 0xd9) break;
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { keep.push(buf.subarray(i, i + 2)); i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      // APP14 (Adobe) stays: a CMYK JPEG needs it to decode right.
      const drop = (m >= 0xe1 && m <= 0xef && m !== 0xee) || m === 0xfe;
      if (!drop) keep.push(buf.subarray(i, i + 2 + len));
      i += 2 + len;
    }
    keep.push(buf.subarray(i));
    return Buffer.concat(keep);
  }
  if (type === 'image/png') {
    const keep = [buf.subarray(0, 8)];
    let i = 8;
    while (i + 12 <= buf.length) {
      const len = buf.readUInt32BE(i), kind = buf.toString('latin1', i + 4, i + 8);
      const end = Math.min(buf.length, i + 12 + len);
      if (!['tEXt', 'iTXt', 'zTXt', 'eXIf', 'caBX'].includes(kind)) keep.push(buf.subarray(i, end));
      i = end;
      if (kind === 'IEND') break;
    }
    return Buffer.concat(keep);
  }
  return null;
}

function frames(list) {
  if (!Array.isArray(list) || !list.length) throw fail(400, 'Add the video frames.');
  if (list.length > MAX_FRAMES) throw fail(400, `At most ${MAX_FRAMES} frames.`);
  return list.map((f, i) => {
    const buf = decode(f, FRAME_BYTES, `frame ${i + 1}`);
    const type = Meta.sniff(buf);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw fail(400, `Frame ${i + 1} must be a JPEG, PNG or WebP.`);
    const t = f && typeof f === 'object' && Number.isFinite(Number(f.t)) ? Math.max(0, Math.round(Number(f.t) * 10) / 10) : null;
    return { mediaType: type, data: buf.toString('base64'), t };
  });
}

module.exports = { preview, original, frames, decode, stripMeta, PREVIEW_BYTES, ORIGINAL_BYTES, FRAME_BYTES, MAX_FRAMES, MODEL_TYPES };
