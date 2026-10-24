// A shared household on the server: one document, opened by its owner with
// no account, and opaque links for everyone else - Firstday's and Rota's
// anonymous-link pattern, for a household that lives as long as it is used.
//
// What is stored, beyond the rules' own fields (pawlog-core.js):
//
//   homes/<CODE>  {code, ownerHash, creator, link, sitters: {<CODE>: {name,
//                  until, expiresAt}}, expiresAt, ...household}
//   links/<CODE>  {home, role: 'member'|'sitter'}  - nothing else
//
// - `ownerHash` is sha256(the owner's key + the code). The key is a
//   22-character secret handed only to the browser that shared the home,
//   sent back in an X-Pawlog-Key header (never in a URL the server sees).
// - The household link and each sitter link are separate opaque codes; none
//   of them is the home's own code, and a sitter link cannot be turned into
//   the household link. The owner can replace the household link (the old
//   one dies at once) and close a sitter link early.
// - `creator` is what the live-homes cap counts by: a hash of the owner's
//   device key (an HttpOnly cookie). Never shown to anyone.

const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 10;                                        // 32^10 ≈ 10^15: a link, not something typed
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const DAY = 86400000;

const LIMITS = {
  idleMs: 180 * DAY,                 // a home nobody has touched for half a year is deleted
  homesPerIp: 10,                    // new shared homes one address may open...
  homesWindowMs: 60 * 60 * 1000,     // ...an hour
  homesPerInstance: 500,             // and all addresses together
  openPerCreator: 5,                 // live shared homes per owner's phone
  missesPerIp: 30,                   // distinct wrong codes per address...
  missWindowMs: 15 * 60 * 1000,      // ...in 15 minutes
  writesPerIp: 600,                  // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,    // ...in 10 minutes
  joinsPerIp: 30,                    // new names one address may add...
  joinsWindowMs: 60 * 60 * 1000,     // ...an hour
  savesPerAccount: 240,              // account writes...
  savesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
};

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}
function randomFrom(alphabet, len) {
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}
const newCode = () => randomFrom(CODE_ALPHABET, CODE_LEN);
const newKey = () => crypto.randomBytes(16).toString('base64url');
/** Fresh ids for the rules: random, in the shape pawlog-core.js checks. */
const ids = (k) => k + randomFrom('abcdefghijkmnpqrstuvwxyz23456789', 11);

function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16); }
const isCode = (v) => CODE_RE.test(String(v || ''));
const isKey = (v) => typeof v === 'string' && KEY_RE.test(v);

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const ownerHash = (key, code) => sha(`pawlog owner v1:${key}:${code}`).slice(0, 32);
const deviceTag = (key) => `d:${sha(`pawlog device v1:${key}`).slice(0, 27)}`;
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
/** The account, as Pawlog stores it: an HMAC of the account id under a key
 *  derived from the session secret. Never the id, never the email. */
function accountTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'pawlog account v1')).update(String(uid)).digest('base64url').slice(0, 27);
}
const expired = (doc, now) => !doc || !doc.expiresAt || Date.parse(doc.expiresAt) <= now;
/** Every write pushes the expiry out. */
function extend(doc, now) {
  doc.expiresAt = new Date(now + LIMITS.idleMs).toISOString();
  return doc;
}

module.exports = {
  CODE_ALPHABET, CODE_LEN, LIMITS, httpError, newCode, newKey, ids, normalizeCode, isCode, isKey,
  ownerHash, deviceTag, sameHash, accountTag, expired, extend,
};
