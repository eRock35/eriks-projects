// A shared crew: started by one phone with NO account, joined by anyone in
// the crew with the six-character code and a first name - also with no
// account. Pencil's table pattern (apps/pencil/lib/tables.js), as Spotted
// uses it, for a group that lives for weeks rather than one car ride.
//
// Pure helpers, no store: the server reads the document, decides inside a
// transaction, and writes what comes back.
//
// What a crew holds - and nothing else:
//   crews/<id>  {code, title, route, v, members: {<mid>: {name, c, keyHash,
//                joinedAt, since, at, host?, left?}}, logs: {<lid>: {by, day,
//                kind, unit, amt, m, at}}, started, finished, past: [{route,
//                m, started, finished}], createdAt, updatedAt}
//
// - ONE versioned document. Every change - a log or its removal, someone
//   joining or leaving, a new leg - moves `v`, so a phone polling with
//   `?since=v` learns "nothing new" for one read.
// - Each log is its OWN key (`logs.<lid>`), added inside a transaction:
//   twelve phones logging at once each add a key, and nothing anyone logged
//   is ever lost. Totals are worked out from the logs, never stored, so
//   there is no running sum for two writes to race on.
// - `m` (trail metres) is worked out HERE from what was logged, by
//   TrekCore.toTrail - a phone never sends a distance of its own.
// - `keyHash` is sha256 of the browser's key and the crew id. The key lives
//   in an HttpOnly cookie and is never stored; the hash differs per crew,
//   so two crews cannot be linked to one phone.
// - A crew nobody has logged in, joined or changed for 30 days is deleted
//   by the read that finds it (there is no timer). A crew is a habit, so it
//   lives far longer than Spotted's one-day car game - but a month of
//   silence means the group has stopped, and nothing about it is kept.

const crypto = require('crypto');
const Core = require('../public/trek-core');

const LIMITS = {
  idleMs: Core.LIMITS.idleDays * 24 * 60 * 60 * 1000, // 30 days with nothing new: gone
  crewsPerIp: 10,                     // new crews one address may start...
  crewsWindowMs: 60 * 60 * 1000,      // ...an hour
  newMembersPerIp: 30,                // new members one address may add...
  newMembersWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                    // DISTINCT wrong codes or ids one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes, then even the right one waits
  writesPerIp: 900,                   // any writes, per address (an office on one network)...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  writesPerMember: 120,               // any writes, per member...
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
const newCrewId = () => crypto.randomBytes(12).toString('base64url'); // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');    // 22 characters
const rand = (n) => crypto.randomInt(n);

function keyHash(key, id) { return crypto.createHash('sha256').update(`trek member v1:${key}:${id}`).digest('base64url').slice(0, 32); }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The last change or join. Polling alone does not keep a crew alive. */
function lastActive(doc) { return Date.parse((doc && doc.updatedAt) || '') || 0; }
function idle(doc, now) { return !doc || lastActive(doc) + LIMITS.idleMs <= now; }
/** The keys every change adds. */
function touch(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }
/** The server's own date (UTC), which a log's day must sit near. */
function utcDay(now) { return new Date(now).toISOString().slice(0, 10); }

function actorOf(doc, key) {
  if (!key || !doc) return null;
  const h = keyHash(key, doc.id);
  const members = doc.members || {};
  for (const mid of Object.keys(members)) if (same(members[mid].keyHash, h)) return mid;
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
/** The least-used colour in the crew (twelve, then they repeat). */
function freeColor(doc) {
  const used = Object.values(doc.members || {}).map((m) => m.c);
  let best = 0, bestN = Infinity;
  for (let c = 0; c < Core.COLORS.length; c++) { const n = used.filter((u) => u === c).length; if (n < bestN) { best = c; bestN = n; } }
  return best;
}
/** Each member's metres by day, in join order, from the stored logs. */
function crewDays(doc) {
  const ids = Core.memberIds(doc);
  const plogs = {};
  for (const [k, l] of Object.entries(doc.logs || {})) { const p = ids.indexOf(l.by); if (p >= 0) plogs[k] = { p, day: l.day, m: l.m }; }
  return Core.dayTotals(plogs, ids.length);
}
function crewProgress(doc) { return Core.progress(doc.route, crewDays(doc)); }

module.exports = {
  LIMITS, httpError, newCode, newCrewId, newKey, rand, keyHash, same,
  lastActive, idle, touch, utcDay, actorOf, isHost, memberCount, uniqueName, freeColor, crewDays, crewProgress,
};
