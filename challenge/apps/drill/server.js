// Drill - rehearse the bad day before it happens. See CLAUDE.md.
//
// The scenarios, the scoring and the after-action report live in
// public/drill-core.js and run on the phone: solo drills and the 5-minute
// demo never reach this server at all. It holds only:
//
//   - rooms: a facilitator opens one (no account needed for a built-in
//     scenario) and everyone joins from their own phone by code, with a
//     first name and a role. The room keeps who joined, the votes on the
//     current inject and the decisions, for 48 hours;
//   - a signed-in facilitator's custom scenarios ("Make it about us"), the
//     one model call, metered.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/drill-core');
const R = require('./lib/rooms');
const ai = require('./lib/ai');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.DRILL_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('DRILL_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A room code is a key to the room. It must not ride out in a Referer
  // header, and a room should never be indexed.
  if (/^\/r\//.test(req.path) || /^\/api\/rooms(\/|$)/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The metered route mounts its own 8 KB parser AFTER sign-in, budget and
// the daily cap, so a stranger's body is never read. Everything else 16 KB.
const customJson = express.json({ limit: '8kb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (req.path === '/api/custom' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (custom scenarios need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'drill',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Drill',
  mountPath: '/api/auth',
});
identity.mount(app);

const sharedClient = FAKE_AI
  ? identity.meter(require('./lib/fakeai').create())
  : identity.meter(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

function clientFor(req) {
  if (FAKE_AI) return Promise.resolve(sharedClient);
  return identity.clientFor(req.user, sharedClient, (apiKey) => new Anthropic({ apiKey }));
}
const modelFor = (req) => identityLib.planFor(req.user, MODELS).model;

// Never put a model call behind a sign-in alone: it goes through the budget
// and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];

/* ------------------------------------------------------------------ *
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body: what a business says about itself is nobody else's - and answered
 * with the route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = R.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the built-in scenarios still work.' : fallback), ...(mine && err.code ? { code: err.code } : {}), ...(mine && err.problems ? { problems: err.problems } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address and per instance, in memory: they slow a script,
 * they do not stop a determined one - CLAUDE.md says so.
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
const opens = identityLib.createLimiter({ max: R.LIMITS.roomsPerIp, windowMs: R.LIMITS.roomsWindowMs });
const opensAll = identityLib.createLimiter({ max: R.LIMITS.roomsPerInstance, windowMs: R.LIMITS.roomsWindowMs });
const newPeople = identityLib.createLimiter({ max: R.LIMITS.newPeoplePerIp, windowMs: R.LIMITS.newPeopleWindowMs });
const writes = identityLib.createLimiter({ max: R.LIMITS.writesPerIp, windowMs: R.LIMITS.writesWindowMs });

// A wrong code counts once per DISTINCT value: a phone left open on a room
// that expired asks for the same dead code again, and that is not guessing.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > R.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= R.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking
 * ------------------------------------------------------------------ */

// This browser's key: an HttpOnly cookie scoped to the app, minted the first
// time it opens or joins a room. A room keeps only sha256(key + code).
const DEVICE_COOKIE = 'drill_k';
function readDevice(req) {
  const m = /(?:^|;\s*)drill_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintDevice(req, res) {
  const have = readDevice(req);
  if (have) return have;
  const key = R.newKey();
  res.append('Set-Cookie', `${DEVICE_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
/** The facilitator's key rides in a header, never in the URL. */
function hostKey(req) {
  const k = req.get('X-Drill-Key');
  return R.isKey(k) ? k : null;
}
function isHost(doc, req) {
  const k = hostKey(req);
  return Boolean(k) && R.sameHash(R.hostHash(k, doc.code), doc.hostHash);
}
function meIn(doc, req) {
  const key = readDevice(req);
  if (!key) return null;
  const h = R.keyHash(key, doc.code);
  const p = doc.people.find((x) => x.keyHash === h);
  return p ? p.id : null;
}

const GONE = 'There’s no drill with that code. It may have finished more than two days ago - check the code and try again.';
/** A room, if the code names a live one. One past its expiry is deleted by
 *  the read that finds it (there is no timer). Unknown, malformed and
 *  expired all answer the same 404. */
async function loadRoom(req) {
  checkMisses(req);
  const code = R.normalizeCode(req.params.code);
  const doc = R.isCode(code) ? await store.get('rooms', code) : null;
  if (!doc) { missed(ipKey(req), code || String(req.params.code || '').slice(0, 12)); throw httpError(404, GONE); }
  if (R.expired(doc, Date.now())) { await store.remove('rooms', code); throw httpError(404, GONE); }
  return doc;
}
/** Change a room inside a transaction: read, run the rules, write. */
async function change(code, fn) {
  let out = null;
  await store.transact('rooms', code, (cur) => {
    if (!cur || R.expired(cur, Date.now())) throw httpError(404, GONE);
    const doc = { ...cur };
    delete doc.id;
    fn(doc);
    out = doc;
    return doc;
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, timers: R.LIMITS.timers, roomHours: R.LIMITS.ttlMs / 3600000 }, roles: Core.ROLES, areas: Core.AREAS, focus: ai.FOCUS_IDS });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, library: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Rooms: no account to open one with a built-in scenario, none to join
 * ------------------------------------------------------------------ */

function libraryTag(req) {
  if (!SECRET()) throw httpError(503, 'Saved scenarios aren’t available right now. The built-in ones still work.');
  return R.accountTag(req.user.id, SECRET());
}

async function openCount(tag, now) {
  const rows = await store.list('rooms', { where: [['creator', '==', tag]], limit: R.LIMITS.openPerCreator * 4 });
  return rows.filter((r) => r.phase !== 'done' && !R.expired(r, now)).length;
}

app.post('/api/rooms', route('Could not open that room.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (opens.blocked(ip)) throw httpError(429, `That’s ${R.LIMITS.roomsPerIp} rooms from here this hour. Try again later.`);
  if (opensAll.blocked('all')) throw httpError(429, 'Lots of drills are starting right now. Try again in a few minutes.');
  const b = req.body || {};
  let scenario = null;
  let scenarioId = null;
  if (typeof b.custom === 'string') {
    // A custom scenario comes from the facilitator's own saved list, never
    // from the request: what a room runs has always been through the door.
    if (!req.user) throw httpError(401, 'Sign in to run one of your own scenarios.');
    const lib = await store.get('libraries', libraryTag(req));
    const saved = lib && lib.scenarios && Object.prototype.hasOwnProperty.call(lib.scenarios, b.custom) ? lib.scenarios[b.custom] : null;
    const clean = saved ? Core.cleanScenario(saved).scenario : null;
    if (!clean) throw httpError(404, 'That scenario isn’t in your list any more.');
    scenario = clean;
  } else {
    const s = Core.scenarioById(b.scenario);
    if (!s) throw httpError(400, 'Pick one of the scenarios.');
    scenario = s;
    scenarioId = s.id;
  }
  const now = Date.now();
  const device = mintDevice(req, res);
  const creator = req.user && SECRET() ? `a:${R.accountTag(req.user.id, SECRET())}` : R.deviceTag(device);
  if (await openCount(creator, now) >= R.LIMITS.openPerCreator) throw httpError(429, `You have ${R.LIMITS.openPerCreator} drills open. Finish or delete one first.`);
  const key = R.newKey();
  let doc = null;
  for (let i = 0; i < 5 && !doc; i++) {
    const code = R.newCode();
    const fresh = R.create({ code, scenario, scenarioId, name: b.name, role: b.role, timerSec: b.timerSec, hostKey: key, deviceKey: device, creator, now });
    try {
      await store.transact('rooms', code, (cur) => { if (cur) throw Object.assign(new Error('taken'), { taken: true }); return fresh; });
      doc = fresh;
    } catch (e) { if (!e.taken) throw e; }
  }
  if (!doc) throw httpError(503, 'Could not find a free code. Try again.');
  opens.hit(ip);
  opensAll.hit('all');
  res.set('Cache-Control', 'no-store');
  res.json({ code: doc.code, key, room: R.view(doc, doc.people[0].id, true, now) });
}));

/** The room as this viewer sees it; `?since=v` answers {same:true} when
 *  nothing moved. A decision clock that ran out is resolved here. */
app.get('/api/rooms/:code', route('Could not load that drill.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let doc = await loadRoom(req);
  const now = Date.now();
  if (doc.phase === 'deciding' && doc.deadline && Date.parse(doc.deadline) <= now) {
    doc = await change(doc.code, (d) => R.resolveTimer(d, Date.now()));
  }
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === doc.v) return res.json({ same: true, v: doc.v });
  res.json({ room: R.view(doc, meIn(doc, req), isHost(doc, req), now) });
}));

app.post('/api/rooms/:code/join', route('Could not join.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadRoom(req);
  const ip = ipKey(req);
  const key = mintDevice(req, res);
  const hash = R.keyHash(key, doc0.code);
  const already = doc0.people.some((p) => p.keyHash === hash);
  if (!already && newPeople.blocked(ip)) throw httpError(429, 'That’s a lot of new people from here this hour. Try again later.');
  let joined = null;
  const doc = await change(doc0.code, (d) => { joined = R.join(d, { hash, name: (req.body || {}).name, role: (req.body || {}).role }, Date.now()); });
  if (joined.isNew) newPeople.hit(ip);
  res.set('Cache-Control', 'no-store');
  res.json({ room: R.view(doc, joined.pid, isHost(doc, req), Date.now()) });
}));

app.post('/api/rooms/:code/me', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadRoom(req);
  const me = meIn(doc0, req);
  if (!me) throw httpError(403, 'Join the room first.');
  const b = req.body || {};
  const doc = await change(doc0.code, (d) => R.editMe(d, me, { name: b.name, role: b.role }, Date.now()));
  res.json({ room: R.view(doc, me, isHost(doc, req), Date.now()) });
}));

app.post('/api/rooms/:code/vote', route('Could not save your vote.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadRoom(req);
  const me = meIn(doc0, req);
  if (!me) throw httpError(403, 'Join the room first.');
  const choice = (req.body || {}).choice;
  const doc = await change(doc0.code, (d) => {
    R.resolveTimer(d, Date.now());
    R.vote(d, me, choice === null ? null : String(choice || ''), Date.now());
  });
  res.json({ room: R.view(doc, me, isHost(doc, req), Date.now()) });
}));

/** The facilitator's controls. Anyone else gets the 404 a missing code gets. */
const HOST_ACTIONS = ['start', 'lock', 'next', 'finish', 'timer', 'remove'];
app.post('/api/rooms/:code/host', route('Could not do that.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadRoom(req);
  if (!isHost(doc0, req)) throw httpError(404, GONE);
  const b = req.body || {};
  if (!HOST_ACTIONS.includes(b.action)) throw httpError(400, 'Unknown action.');
  const doc = await change(doc0.code, (d) => {
    const now = Date.now();
    if (b.action !== 'timer' && b.action !== 'remove') R.resolveTimer(d, now);
    if (b.action === 'start') R.start(d, now);
    else if (b.action === 'lock') R.lock(d, b.choice ? String(b.choice) : null, 'facilitator', now);
    else if (b.action === 'next') R.next(d, now);
    else if (b.action === 'finish') R.finish(d, now);
    else if (b.action === 'timer') R.setTimer(d, b.sec, now);
    else if (b.action === 'remove') R.removePerson(d, String(b.pid || ''), now);
  });
  res.json({ room: R.view(doc, meIn(doc, req), true, Date.now()) });
}));

app.delete('/api/rooms/:code', route('Could not delete that.', async (req, res) => {
  countWrite(req);
  const doc = await loadRoom(req);
  if (!isHost(doc, req)) throw httpError(404, GONE);
  await store.remove('rooms', doc.code);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Signed in, free: your saved scenarios
 * ------------------------------------------------------------------ */

function libraryView(doc) {
  return Object.values((doc && doc.scenarios) || {})
    .map((s) => { const clean = Core.cleanScenario(s).scenario; return clean ? { ...clean, createdAt: typeof s.createdAt === 'string' ? s.createdAt : null } : null; })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

app.get('/api/library', identity.requireUser, route('Could not load your scenarios.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await store.get('libraries', libraryTag(req));
  res.json({ scenarios: libraryView(doc), limit: Core.LIMITS.library });
}));

app.delete('/api/library/:id', identity.requireUser, route('Could not delete that.', async (req, res) => {
  const tag = libraryTag(req);
  const id = String(req.params.id || '');
  if (!/^c[a-z0-9]{11}$/.test(id)) throw httpError(400, 'That isn’t one of your scenarios.');
  await store.transact('libraries', tag, (cur) => {
    if (!cur || !cur.scenarios || !cur.scenarios[id]) return undefined;
    const scenarios = { ...cur.scenarios };
    delete scenarios[id];
    return { ...cur, scenarios, updatedAt: new Date().toISOString() };
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Make it about us"
 * ------------------------------------------------------------------ */

/** Gates, then an 8 KB parser, then the ask checked (a 400 costs nothing),
 *  then a full library refused (still nothing spent), then whitespace
 *  streams while one forced tool writes the scenario. Failures after the
 *  stream starts are 200 with {error} (lib/stream.js). */
app.post('/api/custom', ...spend, customJson, async (req, res) => {
  let tag;
  let b;
  try {
    b = ai.brief(req.body);
    tag = libraryTag(req);
    const lib = await store.get('libraries', tag);
    if (lib && lib.scenarios && Object.keys(lib.scenarios).length >= Core.LIMITS.library) throw httpError(409, `You have ${Core.LIMITS.library} saved scenarios. Delete one first.`);
  } catch (err) { return fail(res, err, 'Could not start that.'); }
  const send = streamedJson(res);
  try {
    const raw = await ai.write(await clientFor(req), modelFor(req), b);
    const id = R.newScenarioId();
    const scenario = ai.toScenario(raw, id);
    const createdAt = new Date().toISOString();
    await store.transact('libraries', tag, (cur) => {
      const scenarios = { ...((cur && cur.scenarios) || {}) };
      if (Object.keys(scenarios).length >= Core.LIMITS.library) throw httpError(409, `You have ${Core.LIMITS.library} saved scenarios. Delete one first.`);
      scenarios[id] = { ...scenario, createdAt };
      return { scenarios, createdAt: (cur && cur.createdAt) || createdAt, updatedAt: createdAt };
    });
    send({ scenario: { ...scenario, createdAt } });
  } catch (err) {
    const f = failure(err, 'Writing a scenario isn’t available right now. Try again in a minute - the built-in ones still work.');
    send({ ...f.body, status: f.status });
  }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A join link (r/<CODE>) is the same single-page app served one level down;
// <base href="../"> resolves every relative asset and API path against the
// app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/r/:code', (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(deepIndex()); });
app.all('/r/:code', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

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
  // DRILL_DEV_MOUNT=/drill runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.DRILL_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`drill listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
