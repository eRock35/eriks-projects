// A decision online: made by a browser with no account, joined by link, QR
// code or a six-character code - also with no account.
//
// Pure rules, no store: the server reads the document, runs the core (or one
// of these) inside a transaction, and writes what comes back.
//
// What a decision document holds - and nothing else:
//   {question, mode, opts: [{id, label, emoji, note}], active: [oid],
//    vetoes, named, live, deadline, max, round, past, closed, next,
//    code, hostHash, createdAt, updatedAt, v,
//    voters: {<vid>: {name, host, at, keyHash}},
//    ballots: {<vid>: {<oid>: 'yes'|'no'|'love'}},
//    ranks: {<vid>: [oid, oid, oid]},
//    vetoed: {<oid>: <vid>}}
//
// - `keyHash` and `hostHash` are sha256(the browser's key + the decision
//   id). The key lives in an HttpOnly cookie and is never stored; the hash
//   differs per decision, so two decisions cannot be linked to one phone.
// - A voter's name is whatever they typed. There is no account id, no email
//   and no address anywhere in it.

const crypto = require('crypto');
const Core = require('../public/settle-core');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 6;                                         // 32^6 ≈ 1.07 billion
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const ID_RE = /^[A-Za-z0-9_-]{16}$/;

const LIMITS = {
  idleMs: 14 * 24 * 60 * 60 * 1000,   // a decision nobody has touched in 14 days goes
  decisionsPerIp: 10,                 // new decisions one address may start...
  decisionsWindowMs: 60 * 60 * 1000,  // ...an hour
  newVotersPerIp: 40,                 // new voters one address may add...
  newVotersWindowMs: 60 * 60 * 1000,  // ...an hour
  missesPerIp: 30,                    // distinct wrong codes or ids one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes
  writesPerIp: 600,                   // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
};

const httpError = Core.fail;

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
const newId = () => crypto.randomBytes(12).toString('base64url'); // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url'); // 22 characters
const rand = (n) => crypto.randomInt(n);

function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function isCode(v) { return CODE_RE.test(String(v || '')); }
function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? `${s.slice(0, 3)}-${s.slice(3)}` : s; }
function isId(v) { return ID_RE.test(String(v || '')); }
function keyHash(key, id) { return crypto.createHash('sha256').update(`${key}:${id}`).digest('base64url').slice(0, 32); }

function idle(doc, now) { return !doc || !doc.updatedAt || Date.parse(doc.updatedAt) + LIMITS.idleMs <= now; }
/** The keys a one-key write adds to bump the version with it. */
function touchKeys(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }

/** Which voter this browser is, if any; and whether it is the host. */
function actorOf(doc, key) {
  if (!key) return { vid: null, host: false };
  const h = keyHash(key, doc.id);
  const vid = Object.keys(doc.voters || {}).find((v) => doc.voters[v].keyHash === h) || null;
  return { vid, host: Boolean(doc.hostHash && doc.hostHash === h) };
}

/** The decision as one member sees it (SettleCore.memberView - the same
 *  function the demo draws with), plus its code. Never a key hash. */
function view(doc, actor, now) {
  return { ...Core.memberView(doc, actor, now), code: doc.code, display: formatCode(doc.code) };
}

module.exports = {
  LIMITS, CODE_ALPHABET, httpError, newCode, newId, newKey, rand, normalizeCode, isCode, formatCode, isId,
  keyHash, idle, touchKeys, actorOf, view,
};
