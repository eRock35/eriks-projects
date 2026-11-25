// A shared gathering: started by one phone with NO account, joined by the
// rest of the family with the six-character code and a first name - also
// with no account. Pencil's table pattern (apps/pencil/lib/tables.js), as
// Trek and Spotted use it.
//
// Pure helpers, no store: the server reads the document, decides inside a
// transaction (ArrivalsCore.act), and writes what comes back.
//
// What a gathering holds - and nothing else:
//   gatherings/<id>  {code, title, place, from, to, tz, v,
//                     members: {<mid>: {name, c, keyHash, owner?, joinedAt,
//                               host?, left?}},
//                     trips: {<tid>: {dir, who, mode, from, carrier, number,
//                             hub, local, tz, at, party, bags, seat, note,
//                             status, delay, ride: {k, mid?}, by, ts}},
//                     createdAt, updatedAt}
//
// - ONE versioned document. Every change moves `v`, so a phone polling with
//   `?since=v` learns "nothing new" for one read.
// - Each trip is its OWN key (`trips.<tid>`), and a status, a delay or a
//   ride is its own key under that, written inside a transaction: phones
//   updating different things at once all land.
// - `at` (the instant) is worked out by the server from the wall-clock time
//   and its zone - a phone never sends one.
// - `keyHash` is sha256 of the browser's key and the gathering id. The key
//   lives in an HttpOnly cookie and is never stored; the hash differs per
//   gathering, so two gatherings cannot be linked to one phone.
// - `owner`, only for a member who signed in and asked to keep the
//   gathering: an HMAC of the account id AND the gathering id, so it opens
//   on their other phone and still links nothing across gatherings.
// - A gathering is deleted by the read that finds it 14 days after its last
//   day (there is no timer).

const crypto = require('crypto');
const Core = require('../public/arrivals-core');

const LIMITS = {
  gatheringsPerIp: 10,                // new gatherings one address may start...
  gatheringsWindowMs: 60 * 60 * 1000, // ...an hour
  newMembersPerIp: 40,                // new members one address may add...
  newMembersWindowMs: 60 * 60 * 1000, // ...an hour (a whole family on one wifi)
  missesPerIp: 30,                    // DISTINCT wrong codes or ids one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes, then even the right one waits
  writesPerIp: 900,                   // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  writesPerMember: 150,               // any writes, per member...
  writesMemberWindowMs: 10 * 60 * 1000,
  kept: 30,                           // gatherings one account keeps
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
const newGid = () => crypto.randomBytes(12).toString('base64url');   // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');   // 22 characters
const rand = (n) => crypto.randomInt(n);

function keyHash(key, id) { return crypto.createHash('sha256').update(`arrivals member v1:${key}:${id}`).digest('base64url').slice(0, 32); }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function hmacKey(secret, label) { return crypto.createHmac('sha256', String(secret)).update(label).digest(); }
/** The account's own list: one tag per account. */
function ownerTag(uid, secret) { return crypto.createHmac('sha256', hmacKey(secret, 'arrivals owner v1')).update(String(uid)).digest('base64url').slice(0, 27); }
/** A member's link to an account, different in every gathering. */
function seatTag(uid, gid, secret) { return crypto.createHmac('sha256', hmacKey(secret, 'arrivals seat v1')).update(`${uid}:${gid}`).digest('base64url').slice(0, 27); }

/** The keys every change adds. */
function touch(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }

/** Which member is asking: by this browser's key, or - signed in - by the
 *  seat they kept on their account. */
function actorOf(doc, key, seat) {
  if (!doc) return null;
  const members = doc.members || {};
  const h = key ? keyHash(key, doc.id) : null;
  for (const mid of Object.keys(members)) {
    if (h && same(members[mid].keyHash, h)) return mid;
  }
  if (seat) for (const mid of Object.keys(members)) if (same(members[mid].owner, seat)) return mid;
  return null;
}
function isHost(doc, mid) { return Boolean(doc && doc.members && doc.members[mid] && doc.members[mid].host); }
function memberCount(doc) { return Object.keys((doc && doc.members) || {}).length; }
function uniqueName(doc, name) {
  const taken = new Set(Object.values(doc.members || {}).map((m) => Core.norm(m.name)));
  if (!taken.has(Core.norm(name))) return name;
  for (let i = 2; i < 100; i++) { const n = `${name.slice(0, Core.LIMITS.name - 3)} ${i}`; if (!taken.has(Core.norm(n))) return n; }
  return name;
}
/** The least-used colour in the gathering (ten, then they repeat). */
function freeColor(doc) {
  const used = Object.values(doc.members || {}).map((m) => m.c);
  let best = 0, bestN = Infinity;
  for (let c = 0; c < Core.COLORS.length; c++) { const n = used.filter((u) => u === c).length; if (n < bestN) { best = c; bestN = n; } }
  return best;
}

module.exports = {
  LIMITS, httpError, newCode, newGid, newKey, rand, keyHash, same, ownerTag, seatTag,
  touch, actorOf, isHost, memberCount, uniqueName, freeColor,
};
