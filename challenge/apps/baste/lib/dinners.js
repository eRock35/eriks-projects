// A shared dinner: started by one phone with NO account, joined by the
// helpers with the six-character code and a first name - also with no
// account. Pencil's table pattern (apps/pencil/lib/tables.js), as Arrivals,
// Trek and Spotted use it.
//
// Pure helpers, no store: the server reads the document, decides inside a
// transaction (BasteCore.act), and writes what comes back.
//
// What a dinner holds - and nothing else:
//   dinners/<id>  {code, title, eatLocal, tz, eatAt, ovens, fit, unit, v,
//                  members: {<mid>: {name, c, keyHash, owner?, joinedAt,
//                            host?, left?}},
//                  dishes: {<did>: {kind, name, method, prep, cook, temp,
//                           rest, big, canAhead, ahead, reheat, note, guest,
//                           arrive, weight, stuffed, who, fix, late, by, ts}},
//                  done: {<step key>: {at, by}}, claims: {<step key>: mid},
//                  createdAt, updatedAt}
//
// - ONE versioned document. Every change moves `v`, so a phone polling with
//   `?since=v` learns "nothing new" for one read.
// - Each dish is its OWN key (`dishes.<did>`), and a tick, a claim, a fix
//   or a "late" is its own key under the document, written inside a
//   transaction: phones updating different things at once all land.
// - `eatAt` (the instant) is worked out by the server from the wall-clock
//   time and its zone - a phone never sends one. The plan itself is never
//   stored: it is worked out from the dishes on every draw.
// - `keyHash` is sha256 of the browser's key and the dinner id. The key
//   lives in an HttpOnly cookie and is never stored; the hash differs per
//   dinner, so two dinners cannot be linked to one phone.
// - `owner`, only for a member who signed in and asked to keep the dinner:
//   an HMAC of the account id AND the dinner id, so it opens on their other
//   phone and still links nothing across dinners.
// - A dinner is deleted by the read that finds it 7 days after its day
//   (there is no timer).

const crypto = require('crypto');
const Core = require('../public/baste-core');

const LIMITS = {
  dinnersPerIp: 10,                   // new dinners one address may start...
  dinnersWindowMs: 60 * 60 * 1000,    // ...an hour
  newMembersPerIp: 40,                // new members one address may add...
  newMembersWindowMs: 60 * 60 * 1000, // ...an hour (a whole kitchen on one wifi)
  missesPerIp: 30,                    // DISTINCT wrong codes or ids one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes, then even the right one waits
  writesPerIp: 900,                   // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  writesPerMember: 150,               // any writes, per member...
  writesMemberWindowMs: 10 * 60 * 1000,
  kept: 30,                           // dinners one account keeps
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

function keyHash(key, id) { return crypto.createHash('sha256').update(`baste member v1:${key}:${id}`).digest('base64url').slice(0, 32); }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function hmacKey(secret, label) { return crypto.createHmac('sha256', String(secret)).update(label).digest(); }
/** The account's own list: one tag per account. */
function ownerTag(uid, secret) { return crypto.createHmac('sha256', hmacKey(secret, 'baste owner v1')).update(String(uid)).digest('base64url').slice(0, 27); }
/** A member's link to an account, different in every dinner. */
function seatTag(uid, gid, secret) { return crypto.createHmac('sha256', hmacKey(secret, 'baste seat v1')).update(`${uid}:${gid}`).digest('base64url').slice(0, 27); }

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
/** The least-used colour in the dinner (ten, then they repeat). */
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
