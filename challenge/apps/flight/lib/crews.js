// A crew: a host with a free account, and up to twenty members who joined by
// link, QR code or a six-character code - with no account.
//
// Pure rules, no store: the server reads the document, runs one of these
// inside a transaction, and writes what comes back.
//
// What a crew document holds - and nothing else:
//   {name, code, ownerTag, acctTags: [tag], createdAt, updatedAt, v,
//    members: [{id, name, emoji, host, keyHash|null, acct|null, joinedAt}]}
//
// - `ownerTag` and each member's `acct` are an HMAC of an account id under a
//   key derived from the identity secret ("flight account v1"): they prove
//   an account holds a seat without the crew holding an account id or an
//   email. `acctTags` repeats them so "my crews" is one array-contains query.
// - `keyHash` is sha256(the browser's key + the crew id). The key lives in an
//   HttpOnly cookie and is never stored; the hash differs per crew, so two
//   crews cannot be linked to one phone.
// - Member ids are random per crew. That is all any member learns about
//   another: a name they typed, an emoji from a fixed set, a random id.

const crypto = require('crypto');
const Core = require('../public/flight-core');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 6;                                         // 32^6 ≈ 1.07 billion
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const CREW_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const ID_RE = /^[a-z][a-z0-9]{6,15}$/;

const LIMITS = {
  crewsPerHost: 10,
  members: Core.LIMITS.members,
  idleMs: 180 * 24 * 60 * 60 * 1000, // a crew nobody has touched in 180 days goes
  newMembersPerIp: 30,               // new members one address may add...
  newMembersWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                   // distinct wrong codes one address may try...
  missWindowMs: 15 * 60 * 1000,      // ...in 15 minutes
  writesPerIp: 600,                  // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,    // ...in 10 minutes
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
const newCrewId = () => crypto.randomBytes(12).toString('base64url'); // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');
function newId(prefix) { return prefix + randomFrom('abcdefghijkmnpqrstuvwxyz23456789', 9); }
const randInt = (n) => crypto.randomInt(n);

function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function isCode(v) { return CODE_RE.test(String(v || '')); }
function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? `${s.slice(0, 3)}-${s.slice(3)}` : s; }
function isCrewId(v) { return CREW_ID_RE.test(String(v || '')); }
function isId(v) { return ID_RE.test(String(v || '')); }

function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
/** One account's tag - the same in every crew, so "my crews" can find them;
 *  an HMAC, so the crew never holds the account id. */
function acctTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'flight account v1')).update(String(uid)).digest('base64url').slice(0, 27);
}
function keyHash(key, crewId) { return crypto.createHash('sha256').update(`${key}:${crewId}`).digest('base64url').slice(0, 32); }

function idle(doc, now) { return !doc || !doc.updatedAt || Date.parse(doc.updatedAt) + LIMITS.idleMs <= now; }

function memberIds(doc) { return (doc.members || []).map((m) => m.id); }

/** Members as another member may see them: never a key hash or a tag. */
function membersView(doc) {
  return (doc.members || []).map((m) => ({ id: m.id, name: m.name, emoji: m.emoji, host: Boolean(m.host), seat: Boolean(m.acct) }));
}

function create({ name, hostName, emoji, tag, now }) {
  const crewName = Core.clean(name, Core.LIMITS.crewName);
  if (!crewName) throw httpError(400, 'Give the crew a name.');
  const hn = Core.cleanName(hostName);
  if (!hn) throw httpError(400, 'Add your name - it’s what the crew sees.');
  const at = new Date(now).toISOString();
  return {
    name: crewName,
    ownerTag: tag,
    acctTags: [tag],
    createdAt: at,
    updatedAt: at,
    v: 1,
    members: [{ id: newId('m'), name: hn, emoji: Core.cleanEmoji(emoji) || Core.EMOJI[0], host: true, keyHash: null, acct: tag, joinedAt: at }],
  };
}

function touch(doc, now) { doc.updatedAt = new Date(now).toISOString(); doc.v = (doc.v || 0) + 1; }

function pickEmoji(doc, wanted) {
  const taken = new Set((doc.members || []).map((m) => m.emoji));
  if (Core.cleanEmoji(wanted) && !taken.has(wanted)) return wanted;
  return Core.EMOJI.find((e) => !taken.has(e)) || Core.cleanEmoji(wanted) || Core.EMOJI[0];
}
function nameTaken(doc, name, except) {
  const k = name.toLocaleLowerCase();
  return (doc.members || []).some((m) => m.id !== except && m.name.toLocaleLowerCase() === k);
}

/**
 * Join: a browser (its key hash) and, when signed in, an account (its tag).
 * A browser or account already in the crew gets its own seat back, never a
 * second one.
 */
function join(doc, { hash, tag, name, emoji }, now) {
  const already = doc.members.find((m) => (hash && m.keyHash === hash) || (tag && m.acct === tag));
  if (already) {
    if (hash && !already.keyHash) already.keyHash = hash;
    return { mid: already.id, isNew: false };
  }
  if (doc.members.length >= LIMITS.members) throw httpError(409, `This crew is full - ${LIMITS.members} is the most.`);
  const n = Core.cleanName(name);
  if (!n) throw httpError(400, 'Add your name - a first name or a nickname.');
  if (nameTaken(doc, n)) throw httpError(409, `Someone in the crew is already called ${n} - add an initial.`);
  const m = { id: newId('m'), name: n, emoji: pickEmoji(doc, emoji), host: false, keyHash: hash || null, acct: tag || null, joinedAt: new Date(now).toISOString() };
  doc.members.push(m);
  if (tag && !doc.acctTags.includes(tag)) doc.acctTags.push(tag);
  touch(doc, now);
  return { mid: m.id, isNew: true };
}

/** Keep my seat: tie the member this browser is to the signed-in account,
 *  so they can come back on any device. One seat per account per crew. */
function keepSeat(doc, actor, tag, now) {
  if (!actor.mid) throw httpError(403, 'Join the crew first.');
  const other = doc.members.find((m) => m.acct === tag && m.id !== actor.mid);
  if (other) throw httpError(409, 'Your account already has a seat in this crew.');
  const me = doc.members.find((m) => m.id === actor.mid);
  me.acct = tag;
  if (!doc.acctTags.includes(tag)) doc.acctTags.push(tag);
  touch(doc, now);
}

function editMe(doc, actor, { name, emoji }, now) {
  if (!actor.mid) throw httpError(403, 'Join the crew first.');
  const me = doc.members.find((m) => m.id === actor.mid);
  if (name !== undefined) {
    const n = Core.cleanName(name);
    if (!n) throw httpError(400, 'Add your name.');
    if (nameTaken(doc, n, me.id)) throw httpError(409, `Someone in the crew is already called ${n}.`);
    me.name = n;
  }
  if (emoji !== undefined) {
    if (!Core.cleanEmoji(emoji)) throw httpError(400, 'Pick one of the emoji.');
    me.emoji = emoji;
  }
  touch(doc, now);
}

function rename(doc, actor, name, now) {
  if (!actor.host) throw httpError(404, 'No crew here.');
  const n = Core.clean(name, Core.LIMITS.crewName);
  if (!n) throw httpError(400, 'Give the crew a name.');
  doc.name = n;
  touch(doc, now);
}

/** The host removes someone, or a member leaves. The host can't leave their
 *  own crew (delete it instead). Returns the removed member's id. */
function remove(doc, actor, mid, now) {
  const target = doc.members.find((m) => m.id === mid);
  if (!target) throw httpError(404, 'No such member.');
  if (mid !== actor.mid && !actor.host) throw httpError(403, 'Only the host can remove someone.');
  if (target.host) throw httpError(409, 'The host can’t leave - delete the crew instead.');
  doc.members = doc.members.filter((m) => m.id !== mid);
  doc.acctTags = doc.members.map((m) => m.acct).filter(Boolean);
  if (!doc.acctTags.includes(doc.ownerTag)) doc.acctTags.push(doc.ownerTag);
  touch(doc, now);
  return mid;
}

/** The crew as one member sees it. */
function view(doc, me, host) {
  return {
    id: doc.id,
    name: doc.name,
    code: doc.code,
    display: formatCode(doc.code),
    v: doc.v || 0,
    members: membersView(doc),
    me: me || null,
    host: Boolean(host),
    createdAt: doc.createdAt,
  };
}

module.exports = {
  LIMITS, CODE_ALPHABET, httpError, newCode, newCrewId, newKey, newId, randInt,
  normalizeCode, isCode, formatCode, isCrewId, isId, acctTag, keyHash, idle, memberIds, membersView,
  create, join, keepSeat, editMe, rename, remove, view,
};
