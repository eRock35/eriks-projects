// A team on the server: one document, opened by a manager with no account,
// joined by staff from one link - Drill's anonymous-room pattern, for a
// rota that lives for weeks rather than an hour.
//
// What a team document holds, beyond the rules' own fields (rota-core.js):
//   {code, ownerHash, creator, expiresAt, ...doc}
//
// - `ownerHash` is sha256(the manager's key + the code). The key is a
//   22-character secret handed only to the browser that made the team, sent
//   back in an X-Rota-Key header (never in a URL), so the team link cannot
//   run the rota.
// - Each person's `keyHash` is sha256(the phone's key + the code). The key
//   lives in an HttpOnly cookie and is never stored; the hash differs per
//   team, so two teams cannot be linked to one phone.
// - `creator` is the tag the open-team cap counts by: a hash of the
//   manager's device key. Never shown to anyone.

const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 10;                                        // 32^10 ≈ 10^15: a link, not something typed
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;

const LIMITS = {
  ttlMs: 90 * 24 * 60 * 60 * 1000,   // a team lasts 90 days after its last change
  teamsPerIp: 10,                    // new teams one address may open...
  teamsWindowMs: 60 * 60 * 1000,     // ...an hour
  teamsPerInstance: 500,             // and all addresses together
  openPerCreator: 5,                 // live teams per manager's phone
  newPeoplePerIp: 40,                // names added from the link, per address...
  newPeopleWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                   // distinct wrong codes per address...
  missWindowMs: 15 * 60 * 1000,      // ...in 15 minutes
  writesPerIp: 600,                  // any team writes, per address...
  writesWindowMs: 10 * 60 * 1000,    // ...in 10 minutes
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
/** Fresh ids for the rules: random, in the shape rota-core.js checks. */
const ids = (k) => k + randomFrom('abcdefghijkmnpqrstuvwxyz23456789', 9);

function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16); }
const isCode = (v) => CODE_RE.test(String(v || ''));
const isKey = (v) => typeof v === 'string' && KEY_RE.test(v);

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const keyHash = (key, code) => sha(`rota person v1:${key}:${code}`).slice(0, 32);
const ownerHash = (key, code) => sha(`rota owner v1:${key}:${code}`).slice(0, 32);
const deviceTag = (key) => `d:${sha(`rota device v1:${key}`).slice(0, 27)}`;
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const expired = (doc, now) => !doc || !doc.expiresAt || Date.parse(doc.expiresAt) <= now;
const extend = (doc, now) => { doc.expiresAt = new Date(now + LIMITS.ttlMs).toISOString(); return doc; };

module.exports = {
  CODE_ALPHABET, CODE_LEN, LIMITS, httpError, newCode, newKey, ids, normalizeCode, isCode, isKey,
  keyHash, ownerHash, deviceTag, sameHash, expired, extend,
};
