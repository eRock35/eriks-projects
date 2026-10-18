// Receipt links ("handshakes"): made by a browser with no account, opened by
// a friend with no account.
//
// What a handshake document holds - and nothing else:
//   handshakes/<tokenHash> = {item, emoji, dir, lender, borrower, on, due,
//     note, state, steps: {sent, confirmed, returning, closed}, createdAt,
//     expiresAt, ownerHash, creator}
//
// - The document id is sha256(token): the link's token is never stored, so
//   someone reading the database (or a backup) cannot open or change a
//   receipt. Tokens are 16 random bytes (128 bits), base64url, 22 characters.
// - `ownerHash` is sha256(owner key + token hash). The owner key is a second
//   22-character secret handed only to the browser that made the link (kept
//   with the loan on that phone, and in the account shelf when signed in), so
//   the friend's link cannot revoke or act as the owner.
// - `creator` is the tag the open-receipt cap counts by: an HMAC of the
//   account id when signed in, else a hash of this browser's HttpOnly device
//   key. Neither is shown to anyone, and neither is an id or an email.
// - Names are whatever was typed. No account id, no email, no address.

const crypto = require('crypto');
const Core = require('../public/boomerang-core');

const LIMITS = {
  createsPerIp: 20,                   // new receipt links one address may make...
  createsWindowMs: 60 * 60 * 1000,    // ...an hour
  createsPerInstance: 2000,           // and all addresses together, per instance
  missesPerIp: 30,                    // distinct wrong tokens one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes
  writesPerIp: 300,                   // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  openPerCreator: Core.LIMITS.openReceipts, // open receipt links per account or device
  savesPerAccount: 240,               // shelf writes per account...
  savesWindowMs: 10 * 60 * 1000,      // ...in 10 minutes
};

const httpError = Core.fail;
const TOKEN_RE = Core.TOKEN_RE;

const newToken = () => crypto.randomBytes(16).toString('base64url'); // 128 bits, 22 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');
const rand = (n) => crypto.randomInt(n);
const isToken = (v) => typeof v === 'string' && TOKEN_RE.test(v);
const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
/** The document id for a token. */
const docId = (token) => sha(`boomerang handshake v1:${token}`).slice(0, 32);
const ownerHash = (key, id) => sha(`${key}:${id}`).slice(0, 32);
/** A browser's device key as the cap counts it. */
const deviceTag = (key) => `d:${sha(`boomerang device v1:${key}`).slice(0, 27)}`;

function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
/** The account, as Boomerang stores it: an HMAC of the account id under a
 *  key derived from the session secret. Never the id, never the email. */
function accountTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'boomerang shelf owner v1')).update(String(uid)).digest('base64url').slice(0, 27);
}

function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = {
  LIMITS, httpError, newToken, newKey, rand, isToken, docId, ownerHash, deviceTag, accountTag, sameHash,
};
