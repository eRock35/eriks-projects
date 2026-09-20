// Accounts exist only so work can be saved. Making a visual needs no account
// at all - that is the point of the app being open to anyone, and a sign-up
// wall in front of "try it" is the fastest way to have nobody try it.

const crypto = require('crypto');
const db = require('./db');

const COOKIE = 'kin_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 10;

function secret() { return process.env.SESSION_SECRET || ''; }
function sign(v) { return crypto.createHmac('sha256', secret()).update(v).digest('base64url'); }

/** Deterministic id from the email, so a duplicate signup collides on write
 *  rather than needing a uniqueness index Firestore does not have. */
function uidFor(email) {
  return Buffer.from(String(email).trim().toLowerCase()).toString('base64url');
}

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('base64');
}

function newHash(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  return { salt, hash: hash(password, salt) };
}

function verify(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  const a = Buffer.from(hash(password, stored.salt));
  const b = Buffer.from(stored.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issue(res, uid) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const body = `${uid}.${exp}`;
  res.cookie(COOKIE, `${body}.${sign(body)}`, {
    httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_DAYS * 86400000, path: '/',
  });
}

function clear(res) { res.clearCookie(COOKIE, { path: '/' }); }

function uidFromRequest(req) {
  if (!secret()) return null;
  const raw = (req.cookies || {})[COOKIE];
  if (!raw) return null;
  const parts = String(raw).split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, mac] = parts;
  const expected = sign(`${uid}.${exp}`);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now()) return null;
  return uid;
}

async function register(email, password) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw Object.assign(new Error('That does not look like an email address.'), { status: 400 });
  if (String(password || '').length < MIN_PASSWORD) {
    throw Object.assign(new Error(`Use at least ${MIN_PASSWORD} characters.`), { status: 400 });
  }
  const uid = uidFor(clean);
  if (await db.get('users', uid)) {
    throw Object.assign(new Error('There is already an account with that email.'), { status: 409 });
  }
  const pw = newHash(password);
  await db.set('users', uid, {
    email: clean, salt: pw.salt, hash: pw.hash,
    createdAt: new Date().toISOString(), projectCount: 0,
  });
  return uid;
}

async function signIn(email, password) {
  const uid = uidFor(String(email || '').trim().toLowerCase());
  const user = await db.get('users', uid);
  // Same answer and roughly the same cost either way, so this cannot be used
  // to discover which addresses have accounts.
  if (!user || !verify(String(password || ''), user)) {
    await new Promise((r) => setTimeout(r, 350));
    throw Object.assign(new Error('That email and password do not match.'), { status: 401 });
  }
  return uid;
}

/** Attaches req.user when there is a valid session. Never rejects - most of
 *  this app works signed out. */
async function attachUser(req, _res, next) {
  const uid = uidFromRequest(req);
  req.user = uid ? await db.get('users', uid) : null;
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: 'Sign in to save work.' });
}

module.exports = {
  COOKIE, MIN_PASSWORD, uidFor, issue, clear, uidFromRequest,
  register, signIn, attachUser, requireUser,
};
