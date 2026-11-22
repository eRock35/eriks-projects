// Trek - a journey for your whole crew. A REBUILD of the 2026-11-14 drop.
// See CLAUDE.md.
//
// A TREK ON THIS PHONE NEVER LEAVES IT. The routes, the conversion to trail
// distance, the leaderboard, the streaks, the postcards and the recap card
// are worked out in the browser by public/trek-core.js and kept in
// localStorage. What the server does:
//
//   - serves the page and its service worker;
//   - holds a SHARED crew, only when someone starts one: one versioned
//     document with the members' first names, colours and every log of the
//     current leg. Members join with a six-character code and a first name,
//     no account; the browser is recognised by an HttpOnly key, stored only
//     as a hash per crew. Each log is its own key, added inside a
//     transaction, so nothing anyone logs is lost when phones log at once.
//     The trail distance is worked out here from what was logged. A crew
//     goes 30 days after the last change, on read;
//   - signed in (free): keeps the trek history in the account so two phones
//     stay in step - filed under an HMAC of the account id, saved only
//     against the version the phone last saw (a 409 carries the account's
//     copy for the phone to merge);
//   - the shared account (sign-in) at /api/auth.
//
// NO MODEL CALL, NO LOCATION. Nothing here a model would do better than
// the rules; no GPS, no health-app import - people type what they did.

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/trek-core');
const G = require('./lib/crews');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
// Trek makes no model call, but the lab host sets <SLUG>_FAKE_AI=1 for every
// app on a local run; like every sibling, it is refused on Cloud Run.
const FAKE_AI = process.env.TREK_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('TREK_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

const SYNC = {
  writes: 120,                       // history saves per account...
  writesWindowMs: 10 * 60 * 1000,    // ...in 10 minutes
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // Join codes travel in the address's #fragment, which is never sent
  // anywhere - and nothing here needs a Referer either.
  res.set('Referrer-Policy', 'no-referrer');
  if (/^\/api\/(c|crews|join)(\/|$)/.test(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Writes come from this app's own page: a JSON body, and never a request a
// browser marks as coming from another site.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth/')) return next();
  const site = String(req.get('sec-fetch-site') || '');
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'That came from another site.' });
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch (e) { ok = false; }
    if (!ok) return res.status(403).json({ error: 'That came from another site.' });
  }
  if (req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  return next();
});

// The trek history mounts its own parser AFTER the sign-in check, so a
// stranger's body is never read. Everything else is a few bytes: 16 KB.
const syncJson = express.json({ limit: '1mb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (req.path === '/api/sync' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (only the trek history's sync needs it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'trek',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Trek',
  mountPath: '/api/auth',
});
identity.mount(app);

/* ------------------------------------------------------------------ *
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body - and answered with the route's fallback.
 * ------------------------------------------------------------------ */

const httpError = G.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error');
  const body = { error: mine ? err.message : fallback };
  if (mine && err.code) body.code = err.code;
  if (mine && err.crew) body.crew = err.crew;
  if (mine && err.problems) body.problems = err.problems;
  return { status: mine ? err.status : 500, body };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address or member, in memory (per instance: they slow a
 * script, they do not stop a determined one - CLAUDE.md says so)
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
const lim = (max, windowMs) => identityLib.createLimiter({ max, windowMs });
const L = G.LIMITS;
const newCrews = lim(L.crewsPerIp, L.crewsWindowMs);
const newMembers = lim(L.newMembersPerIp, L.newMembersWindowMs);
const ipWrites = lim(L.writesPerIp, L.writesWindowMs);
const memberWrites = lim(L.writesPerMember, L.writesMemberWindowMs);

// A wrong code or id counts once per DISTINCT value: a phone left open on a
// crew that closed polls the same dead id, and that is not guessing.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > L.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(req, what) {
  const ip = ipKey(req);
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= L.missesPerIp) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!ipWrites.hit(ipKey(req))) throw httpError(429, 'That’s a lot of logging from here. Wait a minute and try again.');
}
function writeGate(doc, mid) {
  if (!memberWrites.hit(`${doc.id}:${mid}`)) throw httpError(429, 'That’s a lot of logging. Wait a few minutes and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking: this browser's key (an HttpOnly cookie, 22 characters,
 * stored only as sha256(key + crew id)).
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'trek_k';
function readKey(req) {
  const m = /(?:^|;\s*)trek_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = G.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  req.headers.cookie = `${req.headers.cookie ? `${req.headers.cookie}; ` : ''}${KEY_COOKIE}=${key}`;
  return key;
}

// Unknown, expired and never-yours all read the same, word for word, so
// nobody learns whether a crew id is real.
const GONE = 'This crew isn’t here any more. It may have been deleted, or it closed after 30 days with nobody logging.';
const NO_CODE = 'No crew has that code. Check it with whoever started the crew - it’s on their screen under Invite.';
const HOST_ONLY = 'Only whoever started the crew can do that.';

/** The crew, if the id names a live one. One with no change for 30 days is
 *  deleted by the read that finds it (there is no timer). */
async function loadCrew(req) {
  checkMisses(req);
  const cid = String(req.params.id || '');
  const doc = Core.isGid(cid) ? await store.get('crews', cid) : null;
  if (!doc) { missed(req, `c:${cid.slice(0, 20)}`); throw httpError(404, GONE, { code: 'gone' }); }
  if (G.idle(doc, Date.now())) { await store.remove('crews', doc.id); throw httpError(404, GONE, { code: 'gone' }); }
  return doc;
}
/** The crew and which member is asking - a stranger gets the same 404 a
 *  crew that does not exist gets. A member who left is a stranger. */
async function memberCrew(req) {
  const doc = await loadCrew(req);
  const mid = G.actorOf(doc, readKey(req));
  if (!mid || doc.members[mid].left) throw httpError(404, GONE, { code: 'gone' });
  return { doc, mid };
}
const viewOf = (doc, mid) => Core.crewView(doc, mid);
const fresh = async (id) => store.get('crews', id);

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * A crew: no account
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = G.newCode();
    if (!(await store.list('crews', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

app.post('/api/crews', route('Could not start the crew.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (newCrews.blocked(ip)) throw httpError(429, `That’s ${L.crewsPerIp} crews from here this hour. Try again later.`);
  const b = req.body || {};
  const name = Core.cleanName(b.name);
  if (!name) throw httpError(400, 'Type your first name, so the crew knows who walked what.');
  const why = Core.refuse(b.title);
  if (why) throw httpError(400, why);
  const title = Core.cleanTitle(b.title) || 'Our crew';
  if (!Core.isRoute(b.route)) throw httpError(400, 'Pick a route.');
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const key = mintKey(req, res);
  const cid = G.newCrewId();
  const mid = Core.newId(G.rand, 8, 'm');
  const doc = {
    code: await freshCode(), title, route: b.route, v: 1,
    members: { [mid]: { name, c: 0, keyHash: G.keyHash(key, cid), joinedAt: stamp, since: G.utcDay(now), at: stamp, host: true } },
    logs: {}, started: G.utcDay(now), finished: null, past: [], createdAt: stamp, updatedAt: stamp,
  };
  await store.transact('crews', cid, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  newCrews.hit(ip);
  res.set('Cache-Control', 'no-store');
  res.json({ id: cid, crew: viewOf({ ...doc, id: cid }, mid) });
}));

async function byCode(req) {
  checkMisses(req);
  const code = Core.normalizeCode(req.params.code);
  const rows = Core.isCode(code) ? await store.list('crews', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(req, `j:${code}`); throw httpError(404, NO_CODE); }
  if (G.idle(doc, Date.now())) { await store.remove('crews', doc.id); throw httpError(404, NO_CODE); }
  return doc;
}

/** What a code opens before joining: the crew's name, its route, who
 *  started it and how many are in - no other name, no distance. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await byCode(req);
  const mid = G.actorOf(doc, readKey(req));
  const host = Object.values(doc.members || {}).find((m) => m.host);
  const r = Core.routeOf(doc.route);
  res.json({ title: doc.title, route: r ? r.name : '', by: host ? host.name : '', members: G.memberCount(doc), full: G.memberCount(doc) >= Core.LIMITS.members, already: mid && !doc.members[mid].left ? doc.id : null });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await byCode(req);
  const pre = G.actorOf(doc, readKey(req));
  if (pre && !doc.members[pre].left) return res.json({ id: doc.id, isNew: false });
  const name = Core.cleanName(b.name);
  if (!name) throw httpError(400, 'Type your first name, so the crew knows who walked what.');
  if (newMembers.blocked(ip)) throw httpError(429, 'Too many new members from here. Try again later.');
  const key = mintKey(req, res);
  const hash = G.keyHash(key, doc.id);
  const mid = Core.newId(G.rand, 8, 'm');
  let mine = null;
  await store.transactKeys('crews', doc.id, (cur) => {
    if (!cur) throw httpError(404, NO_CODE);
    const already = G.actorOf(cur, key);
    if (already && !cur.members[already].left) { mine = already; return undefined; }
    const now = Date.now();
    if (already) { mine = already; return { set: { [`members.${already}.left`]: false, ...G.touch(cur, now) }, del: [] }; }
    if (G.memberCount(cur) >= Core.LIMITS.members) throw httpError(409, `This crew has ${Core.LIMITS.members} people - that’s the most one crew can have.`);
    const stamp = new Date(now).toISOString();
    mine = mid;
    return { set: { [`members.${mid}`]: { name: G.uniqueName(cur, name), c: G.freeColor(cur), keyHash: hash, joinedAt: stamp, since: G.utcDay(now), at: stamp }, ...G.touch(cur, now) }, del: [] };
  });
  if (mine === mid) newMembers.hit(ip);
  res.json({ id: doc.id, isNew: mine === mid });
}));

/** Poll: `?since=<v>` answers {same: true} when nothing moved. */
app.get('/api/c/:id', route('Could not load the crew.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, mid } = await memberCrew(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (doc.v || 0)) return res.json({ same: true, v: doc.v || 0 });
  res.json({ crew: viewOf(doc, mid) });
}));

/** Log a walk, run, ride, swim or roll. The trail distance is worked out
 *  here; the log is its own key, added in a transaction, so logs from many
 *  phones at once all land. Answers with the crew and any checkpoints this
 *  log carried the crew past (the postcards). */
app.post('/api/c/:id/logs', route('Could not log that.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberCrew(req);
  writeGate(doc, mid);
  const b = req.body || {};
  const kind = typeof b.kind === 'string' ? b.kind : '';
  const unit = typeof b.unit === 'string' ? b.unit : '';
  const day = typeof b.day === 'string' ? b.day : '';
  const amt = typeof b.amt === 'number' || typeof b.amt === 'string' ? b.amt : NaN;
  const m = Core.toTrail(kind, unit, amt);
  const now = Date.now();
  if (!Core.dayAllowed(day, G.utcDay(now))) throw httpError(400, `Log today or up to ${Core.LIMITS.backDays} days back.`);
  const lid = Core.newId(G.rand, 9, 'l');
  let before = 0, after = 0;
  await store.transactKeys('crews', doc.id, (cur) => {
    if (!cur || !cur.members[mid] || cur.members[mid].left) throw httpError(404, GONE, { code: 'gone' });
    const logs = cur.logs || {};
    if (Object.keys(logs).length >= Core.LIMITS.logs) throw httpError(409, `This leg has ${Core.LIMITS.logs} logs - the most one leg holds. Whoever started the crew can start the next route.`, { code: 'full' });
    if (Object.values(logs).filter((l) => l.by === mid && l.day === day).length >= Core.LIMITS.logsPerDay) throw httpError(409, `${Core.LIMITS.logsPerDay} logs in one day is the most.`);
    before = G.crewProgress(cur).m;
    const stamp = new Date(now).toISOString();
    const next = { ...cur, logs: { ...logs, [lid]: { by: mid, day, kind, unit, amt: Core.cleanAmount(kind, unit, amt), m, at: stamp } } };
    after = G.crewProgress(next).m;
    const set = { [`logs.${lid}`]: next.logs[lid], [`members.${mid}.at`]: stamp, ...G.touch(cur, now) };
    if (!cur.finished && after >= Core.routeOf(cur.route).m) set.finished = G.utcDay(now);
    return { set, del: [] };
  });
  const out = await fresh(doc.id);
  res.set('Cache-Control', 'no-store');
  res.json({ crew: viewOf(out, mid), m, crossed: Core.crossed(doc.route, before, after) });
}));

/** Take a log back: your own, any time in this leg; whoever started the
 *  crew, anyone's (the "I typed 300 instead of 30" fix). */
app.delete('/api/c/:id/logs/:lid', route('Could not take that back.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberCrew(req);
  writeGate(doc, mid);
  const lid = String(req.params.lid || '');
  if (!Core.isId(lid)) throw httpError(400, 'That is not a log.');
  await store.transactKeys('crews', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE, { code: 'gone' });
    const l = cur.logs && Object.prototype.hasOwnProperty.call(cur.logs, lid) ? cur.logs[lid] : null;
    if (!l) return undefined;
    if (l.by !== mid && !G.isHost(cur, mid)) throw httpError(403, 'Only whoever logged it, or whoever started the crew, can take it back.', { code: 'not-yours' });
    return { set: G.touch(cur, Date.now()), del: [`logs.${lid}`] };
  });
  res.json({ crew: viewOf(await fresh(doc.id), mid) });
}));

/** The next leg (the host): once the route is finished - or before anyone
 *  has logged - pick a route. The finished leg is kept as a line in `past`;
 *  its logs are cleared, so each leg's leaderboard starts fresh. */
app.post('/api/c/:id/route', route('Could not change the route.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberCrew(req);
  if (!G.isHost(doc, mid)) throw httpError(403, HOST_ONLY, { code: 'not-host' });
  const next = (req.body || {}).route;
  if (!Core.isRoute(next)) throw httpError(400, 'Pick a route.');
  await store.transactKeys('crews', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE, { code: 'gone' });
    const any = Object.keys(cur.logs || {}).length > 0;
    if (any && !cur.finished) throw httpError(409, 'Finish this route first - then pick the next one.', { code: 'not-finished' });
    const now = Date.now();
    if (!any) return { set: { route: next, ...G.touch(cur, now) }, del: [] };
    const past = [...(cur.past || []), { route: cur.route, m: G.crewProgress(cur).m, started: cur.started, finished: cur.finished }].slice(-Core.LIMITS.past);
    return { set: { route: next, logs: {}, past, started: G.utcDay(now), finished: null, ...G.touch(cur, now) }, del: [] };
  });
  res.json({ crew: viewOf(await fresh(doc.id), mid) });
}));

/** Remove a member (the host). Their logs go with them. */
app.delete('/api/c/:id/members/:mid', route('Could not remove them.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberCrew(req);
  if (!G.isHost(doc, mid)) throw httpError(403, HOST_ONLY, { code: 'not-host' });
  const who = String(req.params.mid || '');
  if (who === mid) throw httpError(409, 'To stop, delete the crew.');
  if (!doc.members || !Object.prototype.hasOwnProperty.call(doc.members, who)) throw httpError(404, 'They aren’t in this crew any more.');
  await store.transactKeys('crews', doc.id, (cur) => {
    if (!cur || !cur.members || !cur.members[who]) return undefined;
    const theirs = Object.keys(cur.logs || {}).filter((k) => cur.logs[k].by === who).map((k) => `logs.${k}`);
    return { set: G.touch(cur, Date.now()), del: [`members.${who}`, ...theirs] };
  });
  res.json({ crew: viewOf(await fresh(doc.id), mid) });
}));

/** Leave (a member). Their distance stays with the crew under their name. */
app.delete('/api/c/:id/me', route('Could not leave.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberCrew(req);
  if (G.isHost(doc, mid)) throw httpError(409, 'You started this crew - delete it instead, or keep walking.');
  await store.transactKeys('crews', doc.id, (cur) => (cur && cur.members && cur.members[mid] ? { set: { [`members.${mid}.left`]: true, ...G.touch(cur, Date.now()) }, del: [] } : undefined));
  res.json({ ok: true });
}));

/** Delete the crew now (the host). Every phone keeps what it has seen. */
app.delete('/api/c/:id', route('Could not delete the crew.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberCrew(req);
  if (!G.isHost(doc, mid)) throw httpError(403, HOST_ONLY, { code: 'not-host' });
  await store.remove('crews', doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Signed in, free: the trek history follows the account.
 *
 *   treks/<tag> = {owner: tag, treks, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret ("trek owner v1") - never the id or the email. A body is refused
 * whole (400, nothing saved) for an unknown field anywhere, a string with
 * an @, a link, seven digits in a row or markup, a name that is not a first
 * name, more than 100 treks, or about 600 KB as stored.
 * ------------------------------------------------------------------ */

const syncWrites = identityLib.createLimiter({ max: SYNC.writes, windowMs: SYNC.writesWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('trek owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Keeping your treks in the account isn’t available right now. Everything is still on this phone.');
  if (write && !syncWrites.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - everything is still on this phone.');
  return ownerTag(req.user.id, SECRET());
}
function out(doc) {
  if (!doc || !doc.treks) return { data: null, updatedAt: null };
  return { data: Core.cleanTreks(doc.treks).treks, updatedAt: Number(doc.updatedAt) || 0 };
}

app.get('/api/sync', identity.requireUser, route('Could not load your treks.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(out(await store.get('treks', tagOf(req, false))));
}));

app.put('/api/sync', identity.requireUser, syncJson, route('Could not save your treks. They are still on this phone.', async (req, res) => {
  const tag = tagOf(req, true);
  const b = req.body || {};
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'data' && k !== 'base')) throw httpError(400, 'Send the treks and their base, nothing else.');
  const raw = b.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the treks.');
  const problem = Core.bodyProblem(raw);
  if (problem) throw httpError(400, 'That was not saved: ' + problem.charAt(0).toLowerCase() + problem.slice(1), { code: 'personal' });
  const { treks, errors } = Core.cleanTreks(raw, true);
  if (errors.length) throw httpError(400, 'That was not saved: ' + errors[0], { problems: errors.slice(0, 10) });
  if (Buffer.byteLength(JSON.stringify(treks)) > Core.LIMITS.storedBytes) throw httpError(413, 'That is more than Trek keeps in an account (about 600 KB). Everything is still on this phone.');
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('treks', tag, (cur) => {
    if (cur && Number(cur.updatedAt) !== base) { conflict = { doc: cur }; return undefined; }
    if (!cur && base !== null) { conflict = { removed: true }; return undefined; }
    const now = Math.max(Date.now(), (cur && Number(cur.updatedAt) + 1) || 0);
    saved = { owner: tag, treks, updatedAt: now };
    return saved;
  });
  res.set('Cache-Control', 'no-store');
  if (conflict && conflict.removed) return res.status(409).json({ error: 'Your treks were removed from the account on another phone.', code: 'removed', data: null, updatedAt: null });
  if (conflict) return res.status(409).json({ error: 'Your other phone changed the treks.', code: 'conflict', ...out(conflict.doc) });
  res.json(out(saved));
}));

app.delete('/api/sync', identity.requireUser, route('Could not remove it.', async (req, res) => {
  const tag = tagOf(req, true);
  await store.transact('treks', tag, () => null);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const INDEX = path.join(__dirname, 'public', 'index.html');
// The service worker must be re-checked on every load, or a fix would wait
// for its cache to expire. Its scope is this app's base, its own folder.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // TREK_DEV_MOUNT=/trek runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.TREK_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`trek listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}`));
}

module.exports = { app, identity, identityStore, store, ownerTag, misses, LIMITS: G.LIMITS, SYNC };
