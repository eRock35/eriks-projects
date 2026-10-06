// A kitchen online: a host with a free account, and up to twelve people who
// joined by link, QR code or a six-character code - with no account.
//
// Pure rules, no store: the server reads the document, runs one of these
// inside a transaction, and writes what comes back. (Chorus's homes.js,
// without seats or shares: in a kitchen everyone does everything.)
//
// What a kitchen document holds - and nothing else:
//   {name, code, tz, created, ownerTag, acctTags: [tag], createdAt, updatedAt, v,
//    members: [{id, name, emoji, host, keyHash|null, acct|null, joinedAt}],
//    items: {<itemId>: item}, history: {<eventId>: event}}
//
// - `ownerTag` and a member's `acct` are an HMAC of an account id under a key
//   derived from the identity secret ("shelflife account v1"): they prove an
//   account holds a seat without the kitchen holding an account id or an
//   email. `acctTags` repeats them so "my kitchens" is one array-contains.
// - `keyHash` is sha256(the browser's key + the kitchen id). The key lives in
//   an HttpOnly cookie and is never stored; the hash differs per kitchen, so
//   two kitchens cannot be linked to one phone.
// - Items and history are MAPS keyed by id, so every busy change (ate it,
//   binned it, froze it, added one) is a write of one or two keys.

const crypto = require('crypto');
const Core = require('../public/shelf-core');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 6;                                         // 32^6 ≈ 1.07 billion
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const KITCHEN_ID_RE = /^[A-Za-z0-9_-]{16}$/;

const LIMITS = {
  kitchensPerHost: 5,
  members: Core.LIMITS.members,
  items: Core.LIMITS.items,
  idleMs: 180 * 24 * 60 * 60 * 1000, // a kitchen nobody has touched in 180 days goes
  newMembersPerIp: 30,                // new people one address may add...
  newMembersWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                    // distinct wrong codes one address may try...
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
const newKitchenId = () => crypto.randomBytes(12).toString('base64url'); // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');
const rand = (n) => crypto.randomInt(n);

function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function isCode(v) { return CODE_RE.test(String(v || '')); }
function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? `${s.slice(0, 3)}-${s.slice(3)}` : s; }
function isKitchenId(v) { return KITCHEN_ID_RE.test(String(v || '')); }

function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
/** One account's tag - the same in every kitchen, so "my kitchens" can find
 *  them; an HMAC, so the kitchen never holds the account id. */
function acctTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'shelflife account v1')).update(String(uid)).digest('base64url').slice(0, 27);
}
function keyHash(key, kitchenId) { return crypto.createHash('sha256').update(`${key}:${kitchenId}`).digest('base64url').slice(0, 32); }

function idle(doc, now) { return !doc || !doc.updatedAt || Date.parse(doc.updatedAt) + LIMITS.idleMs <= now; }
function touch(doc, now) { doc.updatedAt = new Date(now).toISOString(); doc.v = (doc.v || 0) + 1; }
/** The keys a one-key write adds to bump the version with it. */
function touchKeys(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }

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
 * A new kitchen from a phone's own: its name, items and history, cleaned,
 * with the host's seat (a name and an emoji they choose).
 */
function create({ kitchen, me, tz, tag, now }) {
  const z = Core.cleanTz(tz);
  const today = Core.localDate(now, z);
  const k = Core.cleanKitchen(kitchen, { today, rand });
  const m = me && typeof me === 'object' ? me : {};
  const name = Core.cleanName(m.name);
  if (!name) throw httpError(400, 'Add your name - it’s how the others see who’s in the kitchen.');
  const at = new Date(now).toISOString();
  return {
    name: k.name,
    tz: z,
    created: k.created,
    ownerTag: tag,
    acctTags: [tag],
    createdAt: at,
    updatedAt: at,
    v: 1,
    members: [{ id: Core.newId('m', rand), name, emoji: Core.cleanEmoji(m.emoji) || Core.EMOJI[0], host: true, keyHash: null, acct: tag, joinedAt: at }],
    items: k.items,
    history: k.history,
  };
}

/**
 * Join: a browser (its key hash) and, when signed in, an account (its tag).
 * Someone already in the kitchen gets their own seat back.
 */
function join(doc, { hash, tag, name, emoji }, now) {
  const already = doc.members.find((m) => (hash && m.keyHash === hash) || (tag && m.acct === tag));
  if (already) {
    if (hash && !already.keyHash) already.keyHash = hash;
    return { mid: already.id, isNew: false };
  }
  if (doc.members.length >= LIMITS.members) throw httpError(409, `This kitchen is full - ${LIMITS.members} people is the most.`);
  const n = Core.cleanName(name);
  if (!n) throw httpError(400, 'Add your name - a first name or a nickname.');
  if (nameTaken(doc, n)) throw httpError(409, `Someone here is already called ${n}. Add an initial.`);
  const m = { id: Core.newId('m', rand), name: n, emoji: pickEmoji(doc, emoji), host: false, keyHash: hash || null, acct: tag || null, joinedAt: new Date(now).toISOString() };
  doc.members.push(m);
  if (tag && !doc.acctTags.includes(tag)) doc.acctTags.push(tag);
  touch(doc, now);
  return { mid: m.id, isNew: true };
}

/** Your own name and emoji (the host may change anyone's). */
function editMember(doc, actor, mid, b, now) {
  const m = doc.members.find((x) => x.id === mid);
  if (!m) throw httpError(404, 'No such person.');
  if (mid !== actor.mid && !actor.host) throw httpError(403, 'You can only change your own name.');
  if (b.name !== undefined) {
    const n = Core.cleanName(b.name);
    if (!n) throw httpError(400, 'Add a name.');
    if (nameTaken(doc, n, mid)) throw httpError(409, `Someone here is already called ${n}.`);
    m.name = n;
  }
  if (b.emoji !== undefined) {
    if (!Core.cleanEmoji(b.emoji)) throw httpError(400, 'Pick one of the emoji.');
    m.emoji = b.emoji;
  }
  touch(doc, now);
}

/** The host removes someone, or someone leaves. The host can't leave their
 *  own kitchen (delete it instead). */
function remove(doc, actor, mid, now) {
  const target = doc.members.find((m) => m.id === mid);
  if (!target) throw httpError(404, 'No such person.');
  if (mid !== actor.mid && !actor.host) throw httpError(403, 'Only the host can remove someone.');
  if (target.host) throw httpError(409, 'The host can’t leave - delete the kitchen instead.');
  doc.members = doc.members.filter((m) => m.id !== mid);
  doc.acctTags = doc.members.map((m) => m.acct).filter(Boolean);
  if (!doc.acctTags.includes(doc.ownerTag)) doc.acctTags.push(doc.ownerTag);
  touch(doc, now);
}

function rename(doc, actor, name, now) {
  if (!actor.host) throw httpError(404, 'No kitchen here.');
  const n = Core.cleanText(name, Core.LIMITS.kitchenName);
  if (!n) throw httpError(400, 'Give the kitchen a name.');
  doc.name = n;
  touch(doc, now);
}

/** The kitchen as one member sees it: never a key hash or a tag. */
function view(doc, me, host) {
  return {
    id: doc.id,
    name: doc.name,
    code: doc.code,
    display: formatCode(doc.code),
    tz: doc.tz,
    created: doc.created,
    v: doc.v || 0,
    members: (doc.members || []).map((m) => ({ id: m.id, name: m.name, emoji: m.emoji, host: Boolean(m.host) })),
    items: doc.items || {},
    history: doc.history || {},
    me: me || null,
    host: Boolean(host),
    createdAt: doc.createdAt,
  };
}

module.exports = {
  LIMITS, CODE_ALPHABET, httpError, newCode, newKitchenId, newKey, rand, normalizeCode, isCode, formatCode, isKitchenId,
  acctTag, keyHash, idle, touch, touchKeys, create, join, editMember, remove, rename, view,
};
