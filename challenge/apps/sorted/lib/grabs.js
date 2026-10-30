// "Up for grabs": a link the owner (signed in) makes from their Donate and
// Sell piles, that friends open with no account and claim things from.
//
//   grabs/<id> = {owner, title, from, currency, createdAt, expiresAt,
//     closedAt, items: [{id, name, note, emoji, price, photo, thumb,
//     claim: null | {name, device, at, collected}}]}
//   thumbs/<id>-<item id> = {grab: id, type, data, bytes}
//
// - The link's code is 16 random bytes (128 bits), base64url, 22 characters.
//   The document id is a hash of it, so the code is never stored and
//   someone reading the database (or a backup) cannot open a link.
// - `owner` is an HMAC of the account id under a key derived from the
//   session secret ("sorted owner v1") - never the id, never the email.
// - A claim's `device` is a hash of the claimer's HttpOnly device cookie,
//   so only that browser (or the owner) can release it. Its `name` is a
//   first name as typed, cleaned (no markup, no bidi, 30 characters).
// - Thumbnails are checked by their bytes (JPEG or PNG magic numbers, never
//   what the request claims), 60 KB at most and 320 px a side, and their
//   metadata (EXIF, XMP, comments, text chunks) is dropped before storing.

const crypto = require('crypto');
const Core = require('../public/sorted-core');

const LIMITS = {
  createsPerAccount: 10,            // new links per account...
  createsWindowMs: 60 * 60 * 1000,  // ...an hour
  open: Core.LIMITS.grabsOpen,      // open links per account
  thumbsPerAccount: 200,            // thumbnails uploaded per account...
  thumbsWindowMs: 60 * 60 * 1000,   // ...an hour
  ownerReadsPerAccount: 600,        // owner reads (the screen re-asks every 30 s)...
  ownerReadsWindowMs: 10 * 60 * 1000,
  claimsPerIp: 40,                  // claims and releases per address...
  claimsWindowMs: 10 * 60 * 1000,   // ...in 10 minutes
  claimsPerInstance: 4000,          // and all addresses together
  readsPerIp: 600,                  // friend reads per address...
  readsWindowMs: 10 * 60 * 1000,
  missesPerIp: 30,                  // DISTINCT wrong codes one address may try...
  missWindowMs: 15 * 60 * 1000,     // ...in 15 minutes, then even a real one waits
  keepMs: Core.LIMITS.grabKeepDays * 86400000, // closed or expired: kept this long for the owner
};

const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const GRAB_ID_RE = /^[A-Za-z0-9_-]{32}$/;
const ITEM_ID_RE = /^[a-z0-9]{8}$/;

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const newCode = () => crypto.randomBytes(16).toString('base64url');
const newDeviceKey = () => crypto.randomBytes(16).toString('base64url');
function newItemId() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
/** The document id for a code. */
const grabId = (code) => sha(`sorted grab v1:${code}`).slice(0, 32);
const isCode = (v) => typeof v === 'string' && CODE_RE.test(v);
/** A browser's device key as a claim records it. */
const deviceHash = (key) => sha(`sorted device v1:${key}`).slice(0, 27);
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('sorted owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function same(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** open | closed | expired. Expiry is worked out on read: there is no timer. */
function statusOf(doc, now) {
  if (doc.closedAt) return 'closed';
  if (!doc.expiresAt || Date.parse(doc.expiresAt) <= now) return 'expired';
  return 'open';
}
/** A closed or expired link the owner no longer needs: past the keep. */
function stale(doc, now) {
  const s = statusOf(doc, now);
  if (s === 'open') return false;
  const since = s === 'closed' ? Date.parse(doc.closedAt) : Date.parse(doc.expiresAt);
  return !Number.isFinite(since) || now - since > LIMITS.keepMs;
}
const thumbId = (gid, iid) => `${gid}-${iid}`;

/* ------------------------------------------------------------------ *
 * Thumbnails: checked by their bytes
 * ------------------------------------------------------------------ */

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
  const bad = () => httpError(400, 'That photo isn’t a JPEG the page made. Try adding it again.');
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
  const bad = () => httpError(400, 'That photo isn’t a PNG the page made. Try adding it again.');
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
/** The stored thumbnail: a JPEG or PNG by its bytes, at most 60 KB and
 *  320 px a side, its metadata gone. Sizes are checked from the base64
 *  length before anything is decoded. */
function thumbnail(raw) {
  let data = typeof raw === 'string' ? raw : '';
  const m = /^data:image\/(?:jpeg|png);base64,/i.exec(data);
  if (m) data = data.slice(m[0].length);
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw httpError(400, 'That photo couldn’t be read. Try adding it again.');
  if (Math.floor(data.length * 3 / 4) > Core.LIMITS.thumbBytes + 3) throw httpError(413, `A thumbnail can be ${Math.round(Core.LIMITS.thumbBytes / 1024)} KB at most. The page shrinks photos first - try again from the page.`);
  const buf = Buffer.from(data, 'base64');
  if (!buf.length || buf.length > Core.LIMITS.thumbBytes) throw httpError(413, `A thumbnail can be ${Math.round(Core.LIMITS.thumbBytes / 1024)} KB at most.`);
  const type = sniff(buf);
  if (!type) throw httpError(400, 'A thumbnail must be a JPEG or PNG photo.');
  const out = type === 'image/jpeg' ? cleanJpeg(buf) : cleanPng(buf);
  const s = out.size;
  if (!s || !s.width || !s.height || s.width > Core.LIMITS.thumbSide || s.height > Core.LIMITS.thumbSide) throw httpError(400, `A thumbnail must be at most ${Core.LIMITS.thumbSide} pixels a side.`);
  return { type, data: out.buf.toString('base64'), bytes: out.buf.length, width: s.width, height: s.height };
}

/* ------------------------------------------------------------------ *
 * What each side sees
 * ------------------------------------------------------------------ */

/** A friend's view: the title, the owner's chosen name, the expiry and the
 *  items. Of a claim, only whether it is theirs (their name back to them)
 *  or someone else's - never who. */
function friendView(doc, device, now) {
  const mine = (c) => Boolean(c && device && same(c.device, device));
  return {
    title: doc.title,
    from: doc.from,
    currency: doc.currency,
    expiresAt: doc.expiresAt,
    status: statusOf(doc, now),
    items: doc.items.map((it) => ({
      id: it.id, name: it.name, note: it.note, emoji: it.emoji, price: it.price, photo: Boolean(it.thumb),
      state: !it.claim ? 'free' : mine(it.claim) ? 'mine' : 'taken',
      ...(mine(it.claim) ? { claimName: it.claim.name, collected: Boolean(it.claim.collected) } : {}),
    })),
  };
}
/** The owner's view: everything, with each claim's first name and whether
 *  it has been collected. No device hash ever leaves the server. */
function ownerView(doc, now) {
  return {
    id: doc.id,
    title: doc.title,
    from: doc.from,
    currency: doc.currency,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    closedAt: doc.closedAt || null,
    status: statusOf(doc, now),
    items: doc.items.map((it) => ({
      id: it.id, name: it.name, note: it.note, emoji: it.emoji, price: it.price, photo: Boolean(it.photo), thumb: Boolean(it.thumb),
      claim: it.claim ? { name: it.claim.name, at: it.claim.at, collected: Boolean(it.claim.collected) } : null,
    })),
  };
}

module.exports = {
  LIMITS, CODE_RE, GRAB_ID_RE, ITEM_ID_RE, httpError, newCode, newDeviceKey, newItemId, grabId, isCode, deviceHash, ownerTag, same,
  statusOf, stale, thumbId, sniff, thumbnail, cleanJpeg, cleanPng, friendView, ownerView,
};
