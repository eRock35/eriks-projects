// A stroll: started by the organizer's phone with NO account, joined by
// shoppers with a link (or the six-character code) and a first name - also
// with no account. Pencil's table pattern, changed in one way: a shopper's
// passport is a document of its own, so a street of a thousand shoppers
// never grows the stroll.
//
// Pure helpers, no store: the server reads the documents, decides with
// StrollCore, and writes what comes back.
//
//   strolls/<id>  {code, title, place, from, to, goal, bonus, prize, v,
//                  host: {name, keyHash, owner?},
//                  shops: {<sid>: {name, perk, k, ts}},
//                  winners: {<card tag>: {name, claim, at, given?}},
//                  createdAt, updatedAt}
//   cards/<id>_<tag>  {sid, name, stamps: {<shop id>: ms}, createdAt,
//                      removed?}
//   counts/<id>   {cards, stamps, done, s_<shop id>, d_<yyyymmdd>}
//
// - A browser is known by an HttpOnly key (22 random characters), never
//   stored: `tag` = sha256 of the key and the stroll id, different in every
//   stroll, so two passports cannot be linked to one phone. A card's
//   document id carries its tag; the organizer's is `host.keyHash`.
// - `host.owner`, only for an organizer who signed in and asked to keep the
//   passport: an HMAC of the account id AND the stroll id.
// - A shop's `k` is the code on its counter sign. It is sent to the
//   organizer only (StrollCore.view).
// - A stroll, its cards and its counts are deleted by the read that finds
//   them 30 days after the last day (there is no timer).

const crypto = require('crypto');
const Core = require('../public/stroll-core');

const LIMITS = {
  strollsPerIp: 10,                   // new passports one address may start...
  strollsWindowMs: 60 * 60 * 1000,    // ...an hour
  newCardsPerIp: 60,                  // new shoppers one address may add...
  newCardsWindowMs: 60 * 60 * 1000,   // ...an hour (a whole shop on one wifi)
  missesPerIp: 30,                    // DISTINCT wrong codes or ids one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes, then even the right one waits
  wrongPerCard: Core.LIMITS.wrong,    // DISTINCT wrong stamp codes one passport may try...
  wrongWindowMs: 15 * 60 * 1000,      // ...in 15 minutes
  writesPerIp: 900,                   // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  writesPerMember: 200,               // any writes, per browser in a stroll
  writesMemberWindowMs: 10 * 60 * 1000,
  listsPerHost: 30,                   // reads of every card (the list, the draw), per organizer in 10 minutes
  kept: 30,                           // passports one account keeps
  listed: 300,                        // cards the organizer's list shows
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
const newCode = () => randomFrom(Core.CODE_ALPHABET, Core.CODE_LEN);    // 32^6, about 1.07 billion
const newStamp = () => randomFrom(Core.CODE_ALPHABET, Core.STAMP_LEN);  // 32^4, about a million
const newGid = () => crypto.randomBytes(12).toString('base64url');      // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');      // 22 characters
const rand = (n) => crypto.randomInt(n);

function tagOf(key, id) { return crypto.createHash('sha256').update(`stroll browser v1:${key}:${id}`).digest('base64url').slice(0, 32); }
const cardId = (id, tag) => `${id}_${tag}`;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function hmacKey(secret, label) { return crypto.createHmac('sha256', String(secret)).update(label).digest(); }
/** The account's own list: one tag per account. */
function ownerTag(uid, secret) { return crypto.createHmac('sha256', hmacKey(secret, 'stroll owner v1')).update(String(uid)).digest('base64url').slice(0, 27); }
/** An organizer's link to an account, different in every stroll. */
function seatTag(uid, gid, secret) { return crypto.createHmac('sha256', hmacKey(secret, 'stroll seat v1')).update(`${uid}:${gid}`).digest('base64url').slice(0, 27); }

/** The keys every change to a stroll adds. */
function touch(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }

/** Is this browser (or, signed in, this account's seat) the organizer? */
function isHost(doc, key, seat) {
  const h = doc && doc.host;
  if (!h) return false;
  if (key && same(h.keyHash, tagOf(key, doc.id))) return true;
  return Boolean(seat && same(h.owner, seat));
}
/** A card as the draw and the list read it: its tag comes from its id. */
function cardRow(row) { return { tag: String(row.id || '').slice(-32), name: row.name, stamps: row.stamps || {}, removed: Boolean(row.removed), createdAt: row.createdAt || '' }; }
const dayKey = (ms) => `d_${Core.utcDay(ms).replace(/-/g, '')}`;

module.exports = {
  LIMITS, httpError, newCode, newStamp, newGid, newKey, rand, tagOf, cardId, same, ownerTag, seatTag, touch, isHost, cardRow, dayKey,
};
