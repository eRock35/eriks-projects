// A room: one drill run live, a facilitator and up to 24 people who joined by
// link, QR code or a six-character code - none of them needs an account.
//
// Pure rules, no store: the server reads the document, runs one of these
// inside a transaction, and writes what comes back. Every change bumps `v`,
// so a phone polling with `?since=v` gets a one-line "nothing new" answer.
//
// What a room document holds - and nothing else:
//   {code, scenarioId | custom (a validated scenario), createdAt, updatedAt,
//    expiresAt, v, hostHash, creator, timerSec, phase, current, deadline,
//    votes: {personId: choiceId}, decisions: [{inject, choice, by, votes, at}],
//    people: [{id, name, role, keyHash, host, joinedAt}]}
//
// - `hostHash` is sha256(the facilitator's key + the code). The key is a
//   22-character secret handed only to the browser that made the room and
//   sent back in an X-Drill-Key header (never in a URL), so the join link
//   cannot run the room.
// - `keyHash` is sha256(the browser's key + the code). The key lives in an
//   HttpOnly cookie and is never stored; the hash differs per room, so two
//   rooms cannot be linked to one phone.
// - `creator` is the tag the open-room cap counts by: an HMAC of the account
//   id when signed in, else a hash of the device key. Never shown to anyone.
// - Person ids are random per room. That is all anyone learns about anyone
//   else: a first name they typed, the role they picked, a random id.

const crypto = require('crypto');
const Core = require('../public/drill-core');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 6;                                         // 32^6 ≈ 1.07 billion
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const PID_RE = /^p[a-z0-9]{9}$/;

const LIMITS = {
  ttlMs: 48 * 60 * 60 * 1000,         // a room lasts 48 hours
  people: Core.LIMITS.people,         // 24 in one room, the facilitator included
  timers: [0, 60, 120, 180, 300],     // seconds to decide; 0 = the facilitator's tap
  roomsPerIp: 20,                     // new rooms one address may open...
  roomsWindowMs: 60 * 60 * 1000,      // ...an hour
  roomsPerInstance: 2000,             // and all addresses together
  openPerCreator: 10,                 // open rooms per account or device
  newPeoplePerIp: 40,                 // new people one address may add...
  newPeopleWindowMs: 60 * 60 * 1000,  // ...an hour
  missesPerIp: 30,                    // distinct wrong codes one address may try...
  missWindowMs: 15 * 60 * 1000,       // ...in 15 minutes
  writesPerIp: 600,                   // any room writes, per address...
  writesWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
};

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}
const need = (cond, status, message) => { if (!cond) throw httpError(status, message); };

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
/** A fresh code: 6 characters, each uniform over the 32 (rejection sampling). */
const newCode = () => randomFrom(CODE_ALPHABET, CODE_LEN);
const newKey = () => crypto.randomBytes(16).toString('base64url'); // 128 bits, 22 characters
const newPid = () => `p${randomFrom('abcdefghijkmnpqrstuvwxyz23456789', 9)}`;
const newScenarioId = () => `c${randomFrom('abcdefghijkmnpqrstuvwxyz23456789', 11)}`;

/** What someone typed or scanned -> a code: case, spaces and dashes don't matter. */
function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function isCode(v) { return CODE_RE.test(String(v || '')); }
function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? `${s.slice(0, 3)}-${s.slice(3)}` : s; }
const isKey = (v) => typeof v === 'string' && KEY_RE.test(v);

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const keyHash = (key, code) => sha(`drill person v1:${key}:${code}`).slice(0, 32);
const hostHash = (key, code) => sha(`drill host v1:${key}:${code}`).slice(0, 32);
const deviceTag = (key) => `d:${sha(`drill device v1:${key}`).slice(0, 27)}`;
function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
/** The account, as Drill stores it: an HMAC under a key derived from the
 *  session secret. Never the id, never the email. */
function accountTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'drill account v1')).update(String(uid)).digest('base64url').slice(0, 27);
}
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function expired(doc, now) { return !doc || !doc.expiresAt || Date.parse(doc.expiresAt) <= now; }
/** The scenario a room runs: a built-in by id, or its own validated copy. */
function scenarioOf(doc) {
  if (doc && doc.custom) return doc.custom;
  return Core.scenarioById(doc && doc.scenarioId) || null;
}
function touch(doc, now) { doc.v = (doc.v || 0) + 1; doc.updatedAt = new Date(now).toISOString(); return doc; }
const iso = (ms) => new Date(ms).toISOString();

function cleanRole(v) { return Core.ROLE_IDS.includes(v) ? v : null; }
function cleanTimer(v) { const n = Number(v); return LIMITS.timers.includes(n) ? n : 0; }

/** A new room, in the lobby. The facilitator is its first person. */
function create({ code, scenario, scenarioId, name, role, timerSec, hostKey, deviceKey, creator, now }) {
  const n = Core.cleanName(name);
  need(n, 400, 'Add your first name - it’s what the room sees.');
  const r = cleanRole(role);
  need(r, 400, 'Pick the role you’ll play.');
  need(scenario, 400, 'Pick a scenario.');
  const at = iso(now);
  return {
    code,
    scenarioId: scenario.custom ? null : scenarioId,
    custom: scenario.custom ? scenario : null,
    createdAt: at, updatedAt: at, expiresAt: iso(now + LIMITS.ttlMs), v: 1,
    hostHash: hostHash(hostKey, code), creator,
    timerSec: cleanTimer(timerSec),
    phase: 'lobby', current: null, deadline: null, votes: {}, decisions: [],
    people: [{ id: newPid(), name: n, role: r, keyHash: keyHash(deviceKey, code), host: true, joinedAt: at }],
  };
}

function nameTaken(doc, name, except) {
  const k = Core.fold(name);
  return doc.people.some((p) => p.id !== except && Core.fold(p.name) === k);
}

/** Join, or get your own seat back: a browser that already joined is never
 *  given a second one. Returns {pid, isNew}. */
function join(doc, { hash, name, role }, now) {
  const mine = doc.people.find((p) => p.keyHash === hash);
  if (mine) return { pid: mine.id, isNew: false };
  need(doc.phase !== 'done', 409, 'This drill has finished. Ask the facilitator for the report.');
  need(doc.people.length < LIMITS.people, 409, `This room is full - ${LIMITS.people} people at most.`);
  const n = Core.cleanName(name);
  need(n, 400, 'Add your first name.');
  need(!nameTaken(doc, n), 409, `Someone here is already called ${n} - add an initial.`);
  const r = cleanRole(role);
  need(r, 400, 'Pick the role you’ll play.');
  const p = { id: newPid(), name: n, role: r, keyHash: hash, host: false, joinedAt: iso(now) };
  doc.people.push(p);
  touch(doc, now);
  return { pid: p.id, isNew: true };
}

function editMe(doc, pid, { name, role }, now) {
  const me = doc.people.find((p) => p.id === pid);
  need(me, 403, 'Join the room first.');
  if (name !== undefined) {
    const n = Core.cleanName(name);
    need(n, 400, 'Add your first name.');
    need(!nameTaken(doc, n, me.id), 409, `Someone here is already called ${n}.`);
    me.name = n;
  }
  if (role !== undefined) { const r = cleanRole(role); need(r, 400, 'Pick one of the roles.'); me.role = r; }
  return touch(doc, now);
}

function removePerson(doc, pid, now) {
  const p = doc.people.find((x) => x.id === pid);
  need(p, 404, 'That person isn’t in this room.');
  need(!p.host, 409, 'You can’t remove yourself - end the drill instead.');
  doc.people = doc.people.filter((x) => x.id !== pid);
  delete doc.votes[pid];
  return touch(doc, now);
}

function deadlineFor(doc, now) { return doc.timerSec ? iso(now + doc.timerSec * 1000) : null; }
function open(doc, scn, injectId, now) {
  doc.current = injectId;
  doc.phase = 'deciding';
  doc.votes = {};
  doc.deadline = deadlineFor(doc, now);
}

function start(doc, now) {
  need(doc.phase === 'lobby', 409, 'The drill has already started.');
  const scn = scenarioOf(doc);
  open(doc, scn, scn.injects[0].id, now);
  return touch(doc, now);
}

/** Anyone in the room votes on the current inject; a second vote replaces
 *  the first, and null takes it back. */
function vote(doc, pid, choice, now) {
  need(doc.people.some((p) => p.id === pid), 403, 'Join the room first.');
  need(doc.phase === 'deciding', 409, doc.phase === 'lobby' ? 'The drill hasn’t started yet.' : 'This one is decided - wait for the next inject.');
  const inj = Core.injectOf(scenarioOf(doc), doc.current);
  if (choice === null) delete doc.votes[pid];
  else { need(Core.choiceOf(inj, choice), 400, 'That isn’t one of the choices.'); doc.votes[pid] = choice; }
  return touch(doc, now);
}

/** The facilitator locks a choice - the one they name, or the leading vote. */
function lock(doc, choice, by, now) {
  need(doc.phase === 'deciding', 409, 'There’s nothing to lock right now.');
  const inj = Core.injectOf(scenarioOf(doc), doc.current);
  const pick = choice ? Core.choiceOf(inj, choice) : Core.choiceOf(inj, Core.leading(inj, doc.votes));
  need(pick, 400, 'That isn’t one of the choices.');
  doc.decisions.push({ inject: inj.id, choice: pick.id, by, votes: Core.tally(inj, doc.votes), at: iso(now) });
  doc.phase = 'locked';
  doc.deadline = null;
  return touch(doc, now);
}

/** On to the next inject, or the report. */
function next(doc, now) {
  need(doc.phase === 'locked', 409, 'Lock a choice first.');
  const last = doc.decisions[doc.decisions.length - 1];
  const to = Core.nextOf(scenarioOf(doc), last.inject, last.choice);
  if (to === 'end') { doc.phase = 'done'; doc.current = null; doc.votes = {}; }
  else open(doc, scenarioOf(doc), to, now);
  return touch(doc, now);
}

/** Stop early: the report covers what was decided. */
function finish(doc, now) {
  need(doc.phase !== 'done', 409, 'This drill has already finished.');
  doc.phase = 'done';
  doc.current = null;
  doc.deadline = null;
  doc.votes = {};
  return touch(doc, now);
}

function setTimer(doc, sec, now) {
  need(LIMITS.timers.includes(Number(sec)), 400, 'Pick one of the timers.');
  doc.timerSec = Number(sec);
  if (doc.phase === 'deciding') doc.deadline = deadlineFor(doc, now);
  return touch(doc, now);
}

/** The decision clock ran out: the leading vote is locked (no votes: the
 *  team froze). There is no server timer - whichever read finds the
 *  deadline passed does it (billed per request). True if it changed. */
function resolveTimer(doc, now) {
  if (doc.phase !== 'deciding' || !doc.deadline || Date.parse(doc.deadline) > now) return false;
  lock(doc, null, 'timer', now);
  return true;
}

function peopleView(doc) {
  return doc.people.map((p) => ({ id: p.id, name: p.name, role: p.role, host: Boolean(p.host) }));
}
function injectPublic(scn, inj) {
  const k = Core.clock(scn, inj.at);
  return { id: inj.id, at: inj.at, wall: k.wall, since: k.since, to: inj.to, title: inj.title, text: inj.text, choices: inj.choices.map((ch) => ({ id: ch.id, text: ch.text })) };
}
/** The facilitator's notes for the current inject: what each choice leads
 *  to and what it scores. Never sent to anyone else. */
function guideOf(scn, inj) {
  return inj.choices.map((ch) => ({ id: ch.id, then: ch.then, end: ch.next === 'end', points: Object.values(ch.hits).reduce((s, p) => s + p, 0), of: inj.tests.length * 2 }));
}

/** The room as one viewer sees it. Never a key hash, a host hash, a creator
 *  tag, a future inject or an unchosen consequence (the facilitator's notes
 *  aside). */
function view(doc, me, host, now) {
  const scn = scenarioOf(doc);
  const inj = doc.current ? Core.injectOf(scn, doc.current) : null;
  const last = doc.decisions[doc.decisions.length - 1];
  const result = doc.phase === 'locked' && last ? Core.outcome(Core.injectOf(scn, last.inject), last.choice) : null;
  const votes = {};
  if (inj && (doc.phase === 'deciding' || doc.phase === 'locked')) {
    inj.choices.forEach((ch) => { votes[ch.id] = []; });
    for (const [pid, ch] of Object.entries(doc.votes || {})) if (votes[ch] && doc.people.some((p) => p.id === pid)) votes[ch].push(pid);
  }
  const people = doc.people.map((p) => ({ name: p.name, role: p.role }));
  const rep = Core.report(scn, doc.decisions, { mode: 'room', date: doc.createdAt.slice(0, 10), people });
  const out = {
    code: doc.code,
    display: formatCode(doc.code),
    v: doc.v || 0,
    phase: doc.phase,
    expiresAt: doc.expiresAt,
    timerSec: doc.timerSec || 0,
    deadline: doc.deadline || null,
    now: iso(now),
    scenario: { id: scn.id, title: scn.title, emoji: scn.emoji, blurb: scn.blurb, custom: Boolean(scn.custom), injects: scn.injects.length },
    step: doc.decisions.length + (doc.phase === 'deciding' ? 1 : 0),
    inject: inj ? injectPublic(scn, inj) : (doc.phase === 'locked' && last ? injectPublic(scn, Core.injectOf(scn, last.inject)) : null),
    result,
    votes,
    timeline: rep.timeline,
    people: peopleView(doc),
    me: me || null,
    host: Boolean(host),
    report: doc.phase === 'done' ? rep : null,
  };
  if (host && inj && doc.phase === 'deciding') out.guide = guideOf(scn, inj);
  return out;
}

module.exports = {
  CODE_ALPHABET, CODE_LEN, LIMITS, PID_RE, httpError,
  newCode, newKey, newPid, newScenarioId, normalizeCode, isCode, formatCode, isKey,
  keyHash, hostHash, deviceTag, accountTag, sameHash, expired, scenarioOf, cleanTimer,
  create, join, editMe, removePerson, start, vote, lock, next, finish, setTimer, resolveTimer, view,
};
