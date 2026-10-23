// A plan on the server: one document, opened by a manager with no account,
// and three role links - Rota's anonymous-team pattern, for a plan that
// lives until the 90-day check-in is behind it.
//
// What is stored, beyond the rules' own fields (firstday-core.js):
//
//   plans/<CODE>  {code, ownerHash, creator, links: {hire, buddy, it},
//                  expiresAt, ...doc}
//   links/<CODE>  {plan, role}   - a role link names a plan and a role,
//                                  nothing else
//
// - `ownerHash` is sha256(the manager's key + the code). The key is a
//   22-character secret handed only to the browser that made the plan, sent
//   back in an X-Firstday-Key header (never in a URL the server sees), so
//   no role link can run the plan.
// - The three role links are separate opaque codes: the new hire's link
//   cannot be turned into the buddy's, and none of them names the plan's
//   own code. The manager can replace any of them (the old one dies).
// - `creator` is the tag the live-plan cap counts by: a hash of the
//   manager's device key (an HttpOnly cookie). Never shown to anyone.

const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 10;                                        // 32^10 ≈ 10^15: a link, not something typed
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const DAY = 86400000;

const LIMITS = {
  idleMs: 60 * DAY,                  // a plan lasts 60 days after its last change...
  afterStartMs: 120 * DAY,           // ...and never ends before 120 days after day 1 (the 90-day check-in)
  plansPerIp: 10,                    // new plans one address may open...
  plansWindowMs: 60 * 60 * 1000,     // ...an hour
  plansPerInstance: 500,             // and all addresses together
  openPerCreator: 8,                 // live plans per manager's phone
  missesPerIp: 30,                   // distinct wrong codes per address...
  missWindowMs: 15 * 60 * 1000,      // ...in 15 minutes
  writesPerIp: 600,                  // any plan writes, per address...
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
/** Fresh ids for the rules: random, in the shape firstday-core.js checks. */
const ids = (k) => k + randomFrom('abcdefghijkmnpqrstuvwxyz23456789', 9);

function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16); }
const isCode = (v) => CODE_RE.test(String(v || ''));
const isKey = (v) => typeof v === 'string' && KEY_RE.test(v);

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const ownerHash = (key, code) => sha(`firstday owner v1:${key}:${code}`).slice(0, 32);
const deviceTag = (key) => `d:${sha(`firstday device v1:${key}`).slice(0, 27)}`;
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const expired = (doc, now) => !doc || !doc.expiresAt || Date.parse(doc.expiresAt) <= now;
/** Every write pushes the expiry out: 60 days after the change, and never
 *  before 120 days after day 1, so the 90-day check-in always has a home. */
function extend(doc, now) {
  const start = doc.plan && doc.plan.start ? Date.parse(`${doc.plan.start}T00:00:00Z`) : now;
  doc.expiresAt = new Date(Math.max(now + LIMITS.idleMs, start + LIMITS.afterStartMs)).toISOString();
  return doc;
}

module.exports = {
  CODE_ALPHABET, CODE_LEN, LIMITS, httpError, newCode, newKey, ids, normalizeCode, isCode, isKey,
  ownerHash, deviceTag, sameHash, expired, extend,
};
