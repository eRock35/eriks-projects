// A club online: made by a browser with no account, joined by a link, a QR
// code or a six-character code - also with no account.
//
// Pure helpers, no store: the server reads the document, runs the core
// inside a transaction, and writes what comes back.
//
// What a club document holds - and nothing else:
//   {name, code, tz, createdAt, updatedAt, v,
//    book: {id, title, author, chapters, pages, started, ratings: {<mid>: 1-5}},
//    members: {<mid>: {name, emoji, host, joinedAt, pos, done, at,
//                      keyHash, acct?, move?: {hash, exp}}},
//    meetings: {<id>: {date, time, place, link, upTo, rsvps: {<mid>: yes|maybe|no}, by, at}},
//    vote: {noms: {<nid>: {title, author, why, chapters, pages, by, at}},
//           ballots: {<mid>: [nid]}, closed: {at, winner, line, counts, voters, tied} | null},
//    shelf: {<bid>: {title, author, chapters, pages, started, finished, ratings, final: {<mid>: pos}, order}}}
//
// - `keyHash` is sha256(the browser's key + the club id). The key lives in
//   an HttpOnly cookie and is never stored; the hash differs per club, so
//   two clubs cannot be linked to one phone.
// - `acct` (only when a signed-in member asks to keep the club on their
//   account) is an HMAC of the account id under a key derived from the
//   session secret - never the id, never the email.
// - `move` is a pending "move to another phone": the hash of a one-time
//   secret and when it expires. Claiming it deletes it, in a transaction.
//
// Notes and questions are documents of their own: notes/<id> =
//   {club, book, mid, kind, text, at, ai, reactions: {<mid>: emoji}, createdAt}

const crypto = require('crypto');
const Core = require('../public/chapter-core');

const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;

const LIMITS = {
  idleMs: Core.LIMITS.idleDays * 24 * 60 * 60 * 1000, // a club nobody has opened in 120 days goes
  clubsPerIp: 10,                     // new clubs one address may start...
  clubsWindowMs: 60 * 60 * 1000,      // ...an hour
  newMembersPerIp: 30,                // new members one address may add...
  newMembersWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                    // DISTINCT wrong codes, ids or move links one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes, then even the right one waits
  writesPerIp: 600,                   // any writes, per address...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  writesPerMember: 240,               // any writes, per member of a club...
  writesMemberWindowMs: 10 * 60 * 1000,
  notesPerMember: 40,                 // notes and questions, per member...
  notesWindowMs: 60 * 60 * 1000,      // ...an hour
  movesPerMember: 5,                  // move links one member may make...
  movesWindowMs: 60 * 60 * 1000,      // ...an hour
  accountClubs: 30,                   // clubs one account may keep
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
const newCode = () => randomFrom(Core.CODE_ALPHABET, Core.CODE_LEN);  // 32^6, about 1.07 billion
const newClubId = () => crypto.randomBytes(12).toString('base64url');  // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');     // 22 characters
const newSecret = () => crypto.randomBytes(16).toString('base64url');  // 22 characters
const rand = (n) => crypto.randomInt(n);
const isClubId = (v) => ID_RE.test(String(v || ''));
const isSecret = (v) => SECRET_RE.test(String(v || ''));

function keyHash(key, id) { return crypto.createHash('sha256').update(`${key}:${id}`).digest('base64url').slice(0, 32); }
function secretHash(secret) { return crypto.createHash('sha256').update(`chapter move v1:${secret}`).digest('base64url').slice(0, 32); }
/** The account's tag: an HMAC of the account id under a key derived from
 *  the session secret. Never the id or the email. */
function accountTag(uid, secret) {
  const k = crypto.createHmac('sha256', String(secret)).update('chapter account v1').digest();
  return crypto.createHmac('sha256', k).update(String(uid)).digest('base64url').slice(0, 27);
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function idle(doc, now) { return !doc || !doc.updatedAt || Date.parse(doc.updatedAt) + LIMITS.idleMs <= now; }
/** The keys a write adds to bump the version with it. */
function touchKeys(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }

/** Which member this browser (or signed-in account) is, if any. */
function actorOf(doc, key, tag) {
  const members = (doc && doc.members) || {};
  const h = key ? keyHash(key, doc.id) : null;
  for (const mid of Object.keys(members)) {
    const m = members[mid];
    if (h && same(m.keyHash, h)) return mid;
  }
  if (tag) for (const mid of Object.keys(members)) if (same(members[mid].acct, tag)) return mid;
  return null;
}

module.exports = {
  LIMITS, httpError, newCode, newClubId, newKey, newSecret, rand, isClubId, isSecret,
  keyHash, secretHash, accountTag, same, idle, touchKeys, actorOf,
};
