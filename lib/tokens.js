// Signed, stateless tokens and cookies.
//
// Subscribe-confirm and unsubscribe links carry an HMAC of the subscriber id
// rather than a random token stored in the database. That keeps unsubscribe
// working forever with no extra document to look up, which matters because a
// broken unsubscribe link is both a legal problem and the fastest way to get
// a sending domain marked as spam.

const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || '';

function secret() {
  if (!SECRET) {
    // Never silently fall back to a fixed dev secret in production: a
    // predictable secret would let anyone mint an admin session cookie.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET is required in production');
    }
    return 'dev-only-insecure-secret';
  }
  return SECRET;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(value) {
  return b64url(crypto.createHmac('sha256', secret()).update(value).digest());
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** A purpose-scoped token: purpose ties it to one action so an unsubscribe
 *  link can never be replayed as a confirmation, or vice versa. */
function makeToken(purpose, subject, ttlSeconds) {
  const expires = ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : 0;
  const payload = `${purpose}.${subject}.${expires}`;
  return `${b64url(payload)}.${sign(payload)}`;
}

function readToken(purpose, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payload = fromB64url(token.slice(0, idx)).toString();
  const mac = token.slice(idx + 1);
  if (!safeEqual(sign(payload), mac)) return null;
  const parts = payload.split('.');
  if (parts.length !== 3) return null;
  const [tokenPurpose, subject, expires] = parts;
  if (tokenPurpose !== purpose) return null;
  const exp = Number(expires);
  if (exp && exp < Math.floor(Date.now() / 1000)) return null;
  return subject;
}

/** Deterministic subscriber id, so a duplicate signup overwrites rather than
 *  needing a uniqueness index Firestore does not have. */
function emailId(email) {
  return b64url(String(email).trim().toLowerCase());
}

function emailFromId(id) {
  try {
    return fromB64url(id).toString();
  } catch (e) {
    return '';
  }
}

/* ---------- cookies ---------- */

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function setSessionCookie(res, name, value, maxAgeSeconds) {
  const signed = `${b64url(value)}.${sign(value)}`;
  const bits = [
    `${name}=${encodeURIComponent(signed)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === 'production') bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readSessionCookie(req, name) {
  const raw = parseCookies(req)[name];
  if (!raw || !raw.includes('.')) return null;
  const idx = raw.lastIndexOf('.');
  const value = fromB64url(raw.slice(0, idx)).toString();
  if (!safeEqual(sign(value), raw.slice(idx + 1))) return null;
  return value;
}

module.exports = {
  b64url,
  makeToken,
  readToken,
  emailId,
  emailFromId,
  safeEqual,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
};
