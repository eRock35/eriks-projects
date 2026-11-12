// A shared table: started by the scorer's browser with NO account, watched
// by anyone with the six-character code and a first name - also with no
// account.
//
// Pure helpers, no store: the server reads the document, decides inside a
// transaction, and writes what comes back.
//
// What a table holds - and nothing else:
//   tables/<id>  {code, game (PencilCore.shareGame: names, emoji, numbers),
//                 v (the game's version), mv (who is at the table's
//                 version), members: {<mid>: {name, role: scorer|watcher,
//                 keyHash, joinedAt, at}}, createdAt, updatedAt}
//
// - ONE versioned document. Only one member writes the game - whoever holds
//   the pencil - so a single document is enough; every write names the
//   version it was based on, and a stale one is a 409 with the current
//   table, never a silent overwrite (a phone that was handed the pencil
//   back, two tabs on one phone). Someone joining or leaving moves `mv`,
//   not `v`, so a watcher arriving mid-hand never makes the scorer's next
//   write stale; handing the pencil over moves both.
// - `keyHash` is sha256 of the browser's key and the table id. The key lives
//   in an HttpOnly cookie and is never stored; the hash differs per table,
//   so two tables cannot be linked to one phone.
// - A table nobody has changed or joined for 24 hours is deleted by the
//   read that finds it (there is no timer).

const crypto = require('crypto');
const Core = require('../public/pencil-core');

const LIMITS = {
  idleMs: Core.LIMITS.idleHours * 60 * 60 * 1000, // a day with nothing new: gone
  tablesPerIp: 10,                    // new shared tables one address may start...
  tablesWindowMs: 60 * 60 * 1000,     // ...an hour
  newWatchersPerIp: 30,               // new watchers one address may add...
  newWatchersWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                    // DISTINCT wrong codes or ids one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes, then even the right one waits
  writesPerIp: 900,                   // any writes, per address (a long game night)...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  writesPerMember: 400,               // any writes, per member of a table...
  writesMemberWindowMs: 10 * 60 * 1000,
  bodyBytes: 96 * 1024,               // a 12-player, 200-round game is well under this
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
const newTableId = () => crypto.randomBytes(12).toString('base64url'); // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');     // 22 characters
const rand = (n) => crypto.randomInt(n);

function keyHash(key, id) { return crypto.createHash('sha256').update(`pencil member v1:${key}:${id}`).digest('base64url').slice(0, 32); }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The last write or join. Watching alone does not keep a table alive. */
function lastActive(doc) { return Date.parse((doc && doc.updatedAt) || '') || 0; }
function idle(doc, now) { return !doc || lastActive(doc) + LIMITS.idleMs <= now; }
/** The keys a write adds to bump the game's version with it. */
function touchKeys(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }
/** The keys a change of who is at the table adds. */
function touchMembers(cur, now) { return { mv: (cur.mv || 0) + 1, updatedAt: new Date(now).toISOString() }; }

/** Which member this browser is, if any. */
function actorOf(doc, key) {
  if (!key || !doc) return null;
  const h = keyHash(key, doc.id);
  const members = doc.members || {};
  for (const mid of Object.keys(members)) if (same(members[mid].keyHash, h)) return mid;
  return null;
}
function isScorer(doc, mid) { return Boolean(doc && doc.members && doc.members[mid] && doc.members[mid].role === 'scorer'); }
function memberCount(doc) { return Object.keys((doc && doc.members) || {}).length; }
function watcherCount(doc) { return Object.values((doc && doc.members) || {}).filter((m) => m.role !== 'scorer').length; }
/** A name already at the table gets a number: "Sam 2". */
function uniqueName(doc, name) {
  const taken = new Set(Object.values(doc.members || {}).map((m) => Core.norm(m.name)));
  if (!taken.has(Core.norm(name))) return name;
  for (let i = 2; i < 100; i++) { const n = `${name.slice(0, Core.LIMITS.name - 3)} ${i}`; if (!taken.has(Core.norm(n))) return n; }
  return name;
}

module.exports = {
  LIMITS, httpError, newCode, newTableId, newKey, rand, keyHash, same,
  lastActive, idle, touchKeys, touchMembers, actorOf, isScorer, memberCount, watcherCount, uniqueName,
};
