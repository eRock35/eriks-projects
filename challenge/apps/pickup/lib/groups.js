// A group online: a host with a free account, and up to forty regulars who
// joined by link, QR code or a six-character code - with no account.
//
// Pure rules, no store: the server reads the document, runs one of these
// inside a transaction, and writes what comes back. (Chorus's homes.js -
// seats included - with Shelf Life's maps keyed by id.)
//
// What a group document holds - and nothing else:
//   {name, code, tz, sport, perSide, usePos, cur, sched: {wd, time, place,
//    cap, cost}, collector, lines: [{a, b, k}], ownerTag, acctTags: [tag],
//    createdAt, updatedAt, v,
//    members: [{id, name, emoji, skill, adj, pos, host, keyHash|null,
//               acct|null, joinedAt}],
//    games: {<gid>: {id, date, time, place, cap, cost, rsvps: {<pid>: {a, t,
//            by}}, guests: {<xid>: {name, by, t, skill}}, log, teams,
//            matches, played, paid, votes, potwClosed, done, created}}}
//
// - `ownerTag` and a member's `acct` are an HMAC of an account id under a key
//   derived from the identity secret ("pickup account v1"): they prove an
//   account holds a seat without the group holding an account id or an
//   email. `acctTags` repeats them so "my groups" is one array-contains.
// - `keyHash` is sha256(the browser's key + the group id). The key lives in
//   an HttpOnly cookie and is never stored; the hash differs per group, so
//   two groups cannot be linked to one phone.
// - A seat with neither keyHash nor acct is open: a regular the host typed
//   in (who may never open the app - the host answers for them). Whoever
//   joins can say "that's me" and take it.
// - Games are a map keyed by id and every busy change (an answer, a +1, a
//   score, a Paid tick, a vote) is a write of a few keys.

const crypto = require('crypto');
const Core = require('../public/pickup-core');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 6;                                         // 32^6 ≈ 1.07 billion
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const GROUP_ID_RE = /^[A-Za-z0-9_-]{16}$/;

const LIMITS = {
  groupsPerHost: 5,
  members: Core.LIMITS.members,
  idleMs: 180 * 24 * 60 * 60 * 1000, // a group nobody has touched in 180 days goes
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
const newGroupId = () => crypto.randomBytes(12).toString('base64url'); // 96 bits, 16 characters
const newKey = () => crypto.randomBytes(16).toString('base64url');
const rand = (n) => crypto.randomInt(n);

function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function isCode(v) { return CODE_RE.test(String(v || '')); }
function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? `${s.slice(0, 3)}-${s.slice(3)}` : s; }
function isGroupId(v) { return GROUP_ID_RE.test(String(v || '')); }

function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
/** One account's tag - the same in every group, so "my groups" can find
 *  them; an HMAC, so the group never holds the account id. */
function acctTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'pickup account v1')).update(String(uid)).digest('base64url').slice(0, 27);
}
function keyHash(key, groupId) { return crypto.createHash('sha256').update(`${key}:${groupId}`).digest('base64url').slice(0, 32); }

function idle(doc, now) { return !doc || !doc.updatedAt || Date.parse(doc.updatedAt) + LIMITS.idleMs <= now; }
function touch(doc, now) { doc.updatedAt = new Date(now).toISOString(); doc.v = (doc.v || 0) + 1; }
/** The keys a one-key write adds to bump the version with it. */
function touchKeys(cur, now) { return { v: (cur.v || 0) + 1, updatedAt: new Date(now).toISOString() }; }
const isOpen = (m) => !m.keyHash && !m.acct && !m.host;

/**
 * A group online from a phone's own: the cleaned name, sport, schedule,
 * regulars and season, with the phone's host as the account's seat.
 */
function create({ group, tz, tag, now }) {
  const g = Core.cleanGroup(group, { tz, rand });
  const at = new Date(now).toISOString();
  const doc = {
    name: g.name, tz: g.tz, sport: g.sport, perSide: g.perSide, usePos: g.usePos, cur: g.cur, sched: g.sched,
    collector: g.collector, lines: g.lines,
    ownerTag: tag, acctTags: [tag], createdAt: at, updatedAt: at, v: 1,
    members: g.members.map((m) => ({ ...m, keyHash: null, acct: m.host ? tag : null, joinedAt: m.host ? at : null })),
    games: g.games,
  };
  const e = Core.ensureGame(doc, now);
  Core.applyPatch(doc, e.patch);
  return doc;
}

/**
 * Join: a browser (its key hash) and, when signed in, an account (its tag).
 * Someone already in the group gets their own seat back. Otherwise they
 * take an open seat ("I'm Sam") or join as someone new.
 */
function join(doc, { hash, tag, seat, name, emoji, skill }, now) {
  const already = doc.members.find((m) => (hash && m.keyHash === hash) || (tag && m.acct === tag));
  if (already) {
    if (hash && !already.keyHash) already.keyHash = hash;
    return { mid: already.id, isNew: false };
  }
  if (seat) {
    const m = doc.members.find((x) => x.id === seat);
    if (!m || !isOpen(m)) throw httpError(409, 'Someone already took that seat. Pick another, or join as someone new.');
    m.keyHash = hash || null;
    m.acct = tag || null;
    m.joinedAt = new Date(now).toISOString();
    if (emoji !== undefined && Core.cleanEmoji(emoji) && !doc.members.some((x) => x.id !== m.id && x.emoji === emoji)) m.emoji = emoji;
    if (skill !== undefined && Core.cleanSkill(skill)) m.skill = Core.cleanSkill(skill);
    if (tag && !doc.acctTags.includes(tag)) doc.acctTags.push(tag);
    touch(doc, now);
    return { mid: m.id, isNew: true };
  }
  if (doc.members.length >= LIMITS.members) throw httpError(409, `This group is full - ${LIMITS.members} regulars is the most.`);
  const n = Core.cleanName(name);
  if (!n) throw httpError(400, 'Add your name - a first name or a nickname.');
  if (Core.nameTaken(doc, n)) throw httpError(409, `Someone here is already called ${n}. If that’s you, tap your name above; otherwise add an initial.`);
  const m = { id: Core.newId('m', rand), name: n, emoji: Core.pickEmoji(doc, emoji), skill: Core.cleanSkill(skill), adj: null, pos: '', host: false, keyHash: hash || null, acct: tag || null, joinedAt: new Date(now).toISOString() };
  doc.members.push(m);
  if (tag && !doc.acctTags.includes(tag)) doc.acctTags.push(tag);
  touch(doc, now);
  return { mid: m.id, isNew: true };
}

/** The host adds regulars by name: open seats until someone takes them. */
function addSeats(doc, actor, names, now) {
  const r = Core.addMembers(doc, names, { actor, rand });
  for (const m of r.members) doc.members.push({ ...m, keyHash: null, acct: null, joinedAt: null });
  touch(doc, now);
  return r;
}

function remove(doc, actor, mid, now) {
  Core.removeMember(doc, mid, actor);
  doc.acctTags = doc.members.map((m) => m.acct).filter(Boolean);
  if (!doc.acctTags.includes(doc.ownerTag)) doc.acctTags.push(doc.ownerTag);
  touch(doc, now);
}

/** One game as one member sees it. Votes stay secret until voting closes
 *  (from the host too - only how many have voted, and your own); a +1's
 *  skill is for the host and whoever brought them. */
function viewGame(doc, g, me, host, now) {
  const out = JSON.parse(JSON.stringify(g));
  for (const xid of Object.keys(out.guests || {})) if (!host && out.guests[xid].by !== me) delete out.guests[xid].skill;
  const pw = Core.potw(doc, g, now, me);
  if (!pw.closed) {
    out.voteCount = pw.count;
    out.votes = me && g.votes && Object.prototype.hasOwnProperty.call(g.votes, me) ? { [me]: g.votes[me] } : {};
  }
  return out;
}

/**
 * The group as one member sees it: never a key hash or a tag. Skill numbers
 * are private: each regular sees their own, the host sees everyone's (and
 * their own quiet adjustments); nobody else sees anyone's. Split/together
 * lines are the host's alone.
 */
function view(doc, me, host, now) {
  const games = {};
  for (const gid of Object.keys(doc.games || {})) games[gid] = viewGame(doc, doc.games[gid], me, host, now);
  return {
    id: doc.id,
    name: doc.name,
    code: doc.code,
    display: formatCode(doc.code),
    tz: doc.tz,
    sport: doc.sport,
    perSide: doc.perSide,
    usePos: Boolean(doc.usePos),
    cur: doc.cur,
    sched: doc.sched,
    collector: doc.collector || null,
    v: doc.v || 0,
    members: (doc.members || []).map((m) => {
      const row = { id: m.id, name: m.name, emoji: m.emoji, pos: m.pos || '', host: Boolean(m.host), joined: Boolean(m.keyHash || m.acct) };
      if (host || m.id === me) row.skill = m.skill || null;
      if (host) row.adj = m.adj || null;
      return row;
    }),
    lines: host ? doc.lines || [] : [],
    games,
    me: me || null,
    host: Boolean(host),
    createdAt: doc.createdAt,
  };
}

module.exports = {
  LIMITS, CODE_ALPHABET, httpError, newCode, newGroupId, newKey, rand, normalizeCode, isCode, formatCode, isGroupId,
  acctTag, keyHash, idle, touch, touchKeys, isOpen, create, join, addSeats, remove, view, viewGame,
};
