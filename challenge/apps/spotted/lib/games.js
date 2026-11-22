// A shared car game: started by one phone with NO account, joined by anyone
// in the car with the six-character code and a first name - also with no
// account. Pencil's table pattern (apps/pencil/lib/tables.js), for a game
// where EVERY phone writes.
//
// Pure helpers, no store: the server reads the document, decides inside a
// transaction, and writes what comes back.
//
// What a game holds - and nothing else:
//   games/<id>  {code, title, scoring, v, members: {<mid>: {name, c,
//                keyHash, joinedAt, at, host?, left?}}, spots: {XX: {by:
//                mid, at}}, ended (ISO or null), createdAt, updatedAt}
//
// - ONE versioned document. Every change - a plate spotted or taken back,
//   someone joining or leaving, the end - moves `v`, so a phone polling
//   with `?since=v` learns "nothing new" for one read.
// - A plate is spotted inside a transaction that adds only `spots.XX` and
//   only when it is not there yet: the first tap to reach the server wins,
//   and the second is told who got there first (409). Never two winners.
// - `keyHash` is sha256 of the browser's key and the game id. The key lives
//   in an HttpOnly cookie and is never stored; the hash differs per game,
//   so two games cannot be linked to one phone.
// - A game nobody has changed or joined for 24 hours is deleted by the read
//   that finds it (there is no timer).

const crypto = require('crypto');
const Core = require('../public/spotted-core');

const LIMITS = {
  idleMs: Core.LIMITS.idleHours * 60 * 60 * 1000, // a day with nothing new: gone
  undoMs: Core.LIMITS.undoMinutes * 60 * 1000,    // a spotter takes back their own tap
  gamesPerIp: 10,                     // new games one address may start...
  gamesWindowMs: 60 * 60 * 1000,      // ...an hour
  newPlayersPerIp: 30,                // new players one address may add...
  newPlayersWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                    // DISTINCT wrong codes or ids one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes, then even the right one waits
  writesPerIp: 900,                   // any writes, per address (a whole car on one hotspot)...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  writesPerMember: 300,               // any writes, per player...
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
const newGameId = () => crypto.randomBytes(12).toString('base64url'); // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');    // 22 characters
const rand = (n) => crypto.randomInt(n);

function keyHash(key, id) { return crypto.createHash('sha256').update(`spotted member v1:${key}:${id}`).digest('base64url').slice(0, 32); }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The last change or join. Polling alone does not keep a game alive. */
function lastActive(doc) { return Date.parse((doc && doc.updatedAt) || '') || 0; }
function idle(doc, now) { return !doc || lastActive(doc) + LIMITS.idleMs <= now; }
/** The keys every change adds. */
function touch(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }

/** Which member this browser is, if any. */
function actorOf(doc, key) {
  if (!key || !doc) return null;
  const h = keyHash(key, doc.id);
  const members = doc.members || {};
  for (const mid of Object.keys(members)) if (same(members[mid].keyHash, h)) return mid;
  return null;
}
function isHost(doc, mid) { return Boolean(doc && doc.members && doc.members[mid] && doc.members[mid].host); }
function playerCount(doc) { return Object.keys((doc && doc.members) || {}).length; }
/** A name already in the car gets a number: "Sam 2". */
function uniqueName(doc, name) {
  const taken = new Set(Object.values(doc.members || {}).map((m) => Core.norm(m.name)));
  if (!taken.has(Core.norm(name))) return name;
  for (let i = 2; i < 100; i++) { const n = `${name.slice(0, Core.LIMITS.name - 3)} ${i}`; if (!taken.has(Core.norm(n))) return n; }
  return name;
}
/** The lowest colour nobody in the car has. */
function freeColor(doc) {
  const used = new Set(Object.values(doc.members || {}).map((m) => m.c));
  for (let c = 0; c < Core.COLORS.length; c++) if (!used.has(c)) return c;
  return 0;
}

module.exports = {
  LIMITS, httpError, newCode, newGameId, newKey, rand, keyHash, same,
  lastActive, idle, touch, actorOf, isHost, playerCount, uniqueName, freeColor,
};
