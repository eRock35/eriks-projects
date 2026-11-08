// A shared move: made by its owner's browser with NO account, joined by
// helpers with a six-character code and a first name - also with no
// account.
//
// Pure helpers, no store: the server reads a document, runs the core inside
// a transaction, and writes what comes back.
//
// What a shared move holds - and nothing else:
//   moves/<id>  {name, kind, from, to, rooms: [{id, name, color, kind}],
//                code, members: {<mid>: {name, role: owner|helper, keyHash,
//                joinedAt, at}}, nos: {n<number>: <box id>}, nextNo, v,
//                createdAt, updatedAt, activeAt}
//   boxes/<move id>_<box id>
//               {move, bid, no, room, items, flags, note, status, statusAt,
//                statusBy (a member id), location, tags, createdAt, updatedAt}
//
// - `keyHash` is sha256(the browser's key + the move id). The key lives in
//   an HttpOnly cookie and is never stored; the hash differs per move, so
//   two moves cannot be linked to one phone.
// - `nos` keeps the box numbers in use, so a new box gets a number nobody
//   else has inside one transaction on the move - two helpers adding at
//   once never both get Box 15.
// - No photo, ever: the share routes refuse any request that carries one.

const crypto = require('crypto');
const Core = require('../public/whichbox-core');

const LIMITS = {
  idleMs: Core.LIMITS.idleDays * 24 * 60 * 60 * 1000, // nobody opened or changed it in 90 days: gone
  activeEveryMs: 6 * 60 * 60 * 1000,  // opening a move counts as activity, written at most this often
  movesPerIp: 10,                     // new shared moves one address may start...
  movesWindowMs: 60 * 60 * 1000,      // ...an hour
  newHelpersPerIp: 30,                // new helpers one address may add...
  newHelpersWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                    // DISTINCT wrong codes or ids one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes, then even the right one waits
  writesPerIp: 900,                   // any writes, per address (a helper ticking off a truck)...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  writesPerMember: 400,               // any writes, per member of a move...
  writesMemberWindowMs: 10 * 60 * 1000,
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
const newCode = () => randomFrom(Core.CODE_ALPHABET, Core.CODE_LEN); // 32^6, about 1.07 billion
const newMoveId = () => crypto.randomBytes(12).toString('base64url'); // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');    // 22 characters
const rand = (n) => crypto.randomInt(n);

function keyHash(key, id) { return crypto.createHash('sha256').update(`whichbox member v1:${key}:${id}`).digest('base64url').slice(0, 32); }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const boxDocId = (sid, bid) => `${sid}_${bid}`;
const noKey = (no) => `n${no}`;

/** Last opened or changed. */
function lastActive(doc) { return Math.max(Date.parse(doc.updatedAt || '') || 0, Date.parse(doc.activeAt || '') || 0); }
function idle(doc, now) { return !doc || lastActive(doc) + LIMITS.idleMs <= now; }
/** The keys a write adds to bump the version with it. */
function touchKeys(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }

/** Which member this browser is, if any. */
function actorOf(doc, key) {
  if (!key || !doc) return null;
  const h = keyHash(key, doc.id);
  const members = doc.members || {};
  for (const mid of Object.keys(members)) if (same(members[mid].keyHash, h)) return mid;
  return null;
}
function isOwner(doc, mid) { return Boolean(doc && doc.members && doc.members[mid] && doc.members[mid].role === 'owner'); }
function memberCount(doc) { return Object.keys((doc && doc.members) || {}).length; }
function helperCount(doc) { return Object.values((doc && doc.members) || {}).filter((m) => m.role !== 'owner').length; }
/** A name already in the move gets a number: "Sam 2". */
function uniqueName(doc, name) {
  const taken = new Set(Object.values(doc.members || {}).map((m) => Core.norm(m.name)));
  if (!taken.has(Core.norm(name))) return name;
  for (let i = 2; i < 100; i++) { const n = `${name.slice(0, Core.LIMITS.helperName - 3)} ${i}`; if (!taken.has(Core.norm(n))) return n; }
  return name;
}
/** The move as a page-shaped move, for the core's box rules. */
function asMove(doc, boxes) {
  return { id: doc.id, kind: Core.kindOf(doc.kind), name: doc.name, rooms: Core.cleanRooms(doc.rooms), boxes: boxes || [], nextNo: doc.nextNo || 1 };
}
/** A stored box document as the core's box, and back. */
function fromDoc(d, move) { return Core.cleanBox({ id: d.bid, no: d.no, room: d.room, items: d.items, flags: d.flags, note: d.note, status: d.status, statusAt: d.statusAt, location: d.location, tags: d.tags, createdAt: d.createdAt, updatedAt: d.updatedAt }, move, { now: Date.now() }); }
function toDoc(sid, b, by) {
  return { move: sid, bid: b.id, no: b.no, room: b.room, items: b.items, flags: b.flags, note: b.note, status: b.status, statusAt: b.statusAt || '', statusBy: by || '', location: b.location || '', tags: b.tags || [], createdAt: b.createdAt, updatedAt: b.updatedAt };
}

module.exports = {
  LIMITS, httpError, newCode, newMoveId, newKey, rand, keyHash, same, boxDocId, noKey,
  lastActive, idle, touchKeys, actorOf, isOwner, memberCount, helperCount, uniqueName, asMove, fromDoc, toDoc,
};
