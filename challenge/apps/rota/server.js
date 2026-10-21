// Rota - next week's shifts, fair and filled. See CLAUDE.md.
//
// The rules - shifts, availability, the solver, fairness, swaps, the views
// and the calendar file - live in public/rota-core.js and run on the phone
// too: the sample cafe never reaches this server at all. This holds:
//
//   - teams: a manager opens one (no account) and shares one link; each
//     person opens it on their phone (no account), picks their name or adds
//     it, and marks availability. The manager plans, fills, publishes; staff
//     see their shifts, add them to a calendar, offer and claim swaps.
//   - "Read their texts", the one model call, metered.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/rota-core');
const T = require('./lib/teams');
const ai = require('./lib/ai');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.ROTA_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('ROTA_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A team code is a key to the team's names and shifts. It must not ride
  // out in a Referer header, and a team page should never be indexed.
  if (/^\/t\//.test(req.path) || /^\/api\/teams(\/|$)/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The metered route mounts its own 16 KB parser AFTER sign-in, budget and
// the daily cap, so a stranger's body is never read. Everything else 32 KB.
const textsJson = express.json({ limit: '16kb' });
const smallJson = express.json({ limit: '32kb' });
app.use((req, res, next) => (req.path === '/api/read-texts' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account ("Read their texts" needs it; nothing else does)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'rota',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Rota',
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
 * body: who can work when is nobody else's business - and answered with
 * the route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = T.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - you can still mark availability by hand.' : fallback), ...(mine && err.code ? { code: err.code } : {}), ...(mine && err.unclear ? { unclear: err.unclear } : {}) } };
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
const opens = identityLib.createLimiter({ max: T.LIMITS.teamsPerIp, windowMs: T.LIMITS.teamsWindowMs });
const opensAll = identityLib.createLimiter({ max: T.LIMITS.teamsPerInstance, windowMs: T.LIMITS.teamsWindowMs });
const newPeople = identityLib.createLimiter({ max: T.LIMITS.newPeoplePerIp, windowMs: T.LIMITS.newPeopleWindowMs });
const writes = identityLib.createLimiter({ max: T.LIMITS.writesPerIp, windowMs: T.LIMITS.writesWindowMs });

// A wrong code counts once per DISTINCT value: a phone left open on a team
// that expired asks for the same dead code again, and that is not guessing.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > T.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= T.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong team links from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of changes from here. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking
 * ------------------------------------------------------------------ */

// This phone's key: an HttpOnly cookie scoped to the app, minted the first
// time it opens or joins a team. A team keeps only sha256(key + code).
const DEVICE_COOKIE = 'rota_k';
function readDevice(req) {
  const m = /(?:^|;\s*)rota_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintDevice(req, res) {
  const have = readDevice(req);
  if (have) return have;
  const key = T.newKey();
  res.append('Set-Cookie', `${DEVICE_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
/** The manager's key rides in a header, never in the URL. */
function ownerKey(req) {
  const k = req.get('X-Rota-Key');
  return T.isKey(k) ? k : null;
}
function isOwner(doc, req) {
  const k = ownerKey(req);
  return Boolean(k) && T.sameHash(T.ownerHash(k, doc.code), doc.ownerHash);
}
function meIn(doc, req) {
  const key = readDevice(req);
  if (!key) return null;
  const h = T.keyHash(key, doc.code);
  const p = doc.people.find((x) => x.keyHash === h);
  return p ? p.id : null;
}

const GONE = 'There’s no team at that link. It may have been deleted, or not used for 90 days - ask your manager for the current link.';
/** A team, if the code names a live one. One past its expiry is deleted by
 *  the read that finds it (there is no timer). Unknown, malformed and
 *  expired all answer the same 404. */
async function loadTeam(req) {
  checkMisses(req);
  const code = T.normalizeCode(req.params.code);
  const doc = T.isCode(code) ? await store.get('teams', code) : null;
  if (!doc) { missed(ipKey(req), code || String(req.params.code || '').slice(0, 16)); throw httpError(404, GONE); }
  if (T.expired(doc, Date.now())) { await store.remove('teams', code); throw httpError(404, GONE); }
  return doc;
}
/** Change a team inside a transaction: read, run the rules, write. Every
 *  write pushes the expiry out again. */
async function change(code, fn) {
  let out = null;
  let result = null;
  await store.transact('teams', code, (cur) => {
    if (!cur || T.expired(cur, Date.now())) throw httpError(404, GONE);
    const doc = { ...cur };
    delete doc.id;
    result = fn(doc);
    T.extend(doc, Date.now());
    out = doc;
    return doc;
  });
  return { doc: out, result };
}
function managerOut(doc) { return { role: 'manager', code: doc.code, expiresAt: doc.expiresAt, team: Core.managerView(doc) }; }
function staffOut(doc, pid) { return { role: 'staff', code: doc.code, team: Core.staffView(doc, pid, Date.now()) }; }

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, teamDays: T.LIMITS.ttlMs / 86400000, openPerDevice: T.LIMITS.openPerCreator }, templates: Object.entries(Core.TEMPLATES).map(([id, t]) => ({ id, label: t.label, roles: t.roles })) });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Teams: no account to open one, none to join
 * ------------------------------------------------------------------ */

async function openCount(tag, now) {
  const rows = await store.list('teams', { where: [['creator', '==', tag]], limit: T.LIMITS.openPerCreator * 4 });
  return rows.filter((r) => !T.expired(r, now)).length;
}

/** Open a team. {name, zone, template?} - or {sample: true} to start from
 *  the sample cafe for real (its made-up people included, to try a link). */
app.post('/api/teams', route('Could not set up that team.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (opens.blocked(ip)) throw httpError(429, `That’s ${T.LIMITS.teamsPerIp} new teams from here this hour. Try again later.`);
  if (opensAll.blocked('all')) throw httpError(429, 'Lots of teams are being set up right now. Try again in a few minutes.');
  const b = req.body || {};
  const now = Date.now();
  const zone = Core.zoneOk(b.zone) ? b.zone : 'UTC';
  let doc;
  let week = Core.nextWeekOf(Core.todayIn(zone, now));
  if (b.sample === true) {
    const s = Core.sample(Core.todayIn(zone, now), zone);
    doc = s.doc;
    doc.team.name = 'Fernhill Cafe (sample)';
    week = s.week;
    doc.createdAt = new Date(now).toISOString();
    doc.updatedAt = doc.createdAt;
  } else {
    if (!Core.clean(b.name, Core.LIMITS.team)) throw httpError(400, 'Give the team a name - the business, or the site.');
    doc = Core.newDoc({ name: b.name, zone, roles: b.roles, minRest: b.minRest }, now);
    if (b.template) Core.manage(doc, 'template', { week, kind: b.template }, now, T.ids);
  }
  const device = mintDevice(req, res);
  const creator = T.deviceTag(device);
  if (await openCount(creator, now) >= T.LIMITS.openPerCreator) throw httpError(429, `This phone runs ${T.LIMITS.openPerCreator} teams already. Delete one first.`);
  const key = T.newKey();
  let saved = null;
  for (let i = 0; i < 5 && !saved; i++) {
    const code = T.newCode();
    const fresh = T.extend({ ...doc, code, ownerHash: T.ownerHash(key, code), creator }, now);
    try {
      await store.transact('teams', code, (cur) => { if (cur) throw Object.assign(new Error('taken'), { taken: true }); return fresh; });
      saved = fresh;
    } catch (e) { if (!e.taken) throw e; }
  }
  if (!saved) throw httpError(503, 'Could not find a free code. Try again.');
  opens.hit(ip);
  opensAll.hit('all');
  res.set('Cache-Control', 'no-store');
  res.json({ key, week, ...managerOut(saved) });
}));

/** The team as this viewer sees it: the manager (by key) everything, a
 *  phone its own view. `?since=v` answers {same: true} when nothing moved. */
app.get('/api/teams/:code', route('Could not load that team.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await loadTeam(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === doc.v) return res.json({ same: true, v: doc.v });
  res.json(isOwner(doc, req) ? managerOut(doc) : staffOut(doc, meIn(doc, req)));
}));

/** The manager's changes. Anyone else gets the 404 a missing code gets. */
app.post('/api/teams/:code/manage', route('Could not save that change.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadTeam(req);
  if (!isOwner(doc0, req)) throw httpError(404, GONE);
  const b = req.body || {};
  if (typeof b.action !== 'string') throw httpError(400, 'Unknown change.');
  const { doc, result } = await change(doc0.code, (d) => Core.manage(d, b.action, b, Date.now(), T.ids));
  res.json({ result, ...managerOut(doc) });
}));

/** A phone joins: claims a name that no other phone holds, or adds its own.
 *  A phone that already holds a name keeps it. */
app.post('/api/teams/:code/join', route('Could not join.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadTeam(req);
  const ip = ipKey(req);
  const key = mintDevice(req, res);
  const hash = T.keyHash(key, doc0.code);
  const b = req.body || {};
  const mine = doc0.people.find((p) => p.keyHash === hash);
  if (mine) return res.json(staffOut(doc0, mine.id));
  const adding = typeof b.pid !== 'string';
  if (adding && newPeople.blocked(ip)) throw httpError(429, 'That’s a lot of new names from here this hour. Try again later.');
  const { doc, result } = await change(doc0.code, (d) => {
    if (d.people.some((p) => p.keyHash === hash)) return d.people.find((p) => p.keyHash === hash).id;
    if (!adding) {
      const p = d.people.find((x) => x.id === b.pid);
      if (!p) throw httpError(404, 'That name isn’t on the team any more.');
      if (p.keyHash) throw httpError(409, `${p.name} is already set up on another phone. If that’s you on a new phone, ask your manager to free your name.`);
      p.keyHash = hash;
      d.v = (d.v || 0) + 1;
      return p.id;
    }
    const p = Core.addPerson(d, { name: b.name }, T.ids('p'), Date.now(), { keyHash: hash });
    d.log = (d.log || []).concat([{ at: new Date().toISOString(), text: `${p.name} joined from the team link` }]).slice(-Core.LIMITS.log);
    d.v = (d.v || 0) + 1;
    return p.id;
  });
  if (adding) newPeople.hit(ip);
  res.set('Cache-Control', 'no-store');
  res.json(staffOut(doc, result));
}));

/** "Not me": this phone lets go of its name. */
app.post('/api/teams/:code/leave', route('Could not do that.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadTeam(req);
  const me = meIn(doc0, req);
  if (!me) return res.json(staffOut(doc0, null));
  const { doc } = await change(doc0.code, (d) => { const p = d.people.find((x) => x.id === me); if (p) p.keyHash = null; d.v = (d.v || 0) + 1; });
  res.json(staffOut(doc, null));
}));

/** A phone's own changes: availability, roles and hours, swaps. */
app.post('/api/teams/:code/staff', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const doc0 = await loadTeam(req);
  const me = meIn(doc0, req);
  if (!me) throw httpError(403, 'Pick your name first.');
  const b = req.body || {};
  if (typeof b.action !== 'string') throw httpError(400, 'Unknown change.');
  const { doc, result } = await change(doc0.code, (d) => Core.staff(d, me, b.action, b, Date.now(), T.ids));
  res.json({ result, ...staffOut(doc, me) });
}));

/** This phone's published shifts as a calendar file. */
app.get('/api/teams/:code/calendar.ics', route('Could not make the calendar file.', async (req, res) => {
  const doc = await loadTeam(req);
  const me = meIn(doc, req);
  if (!me) throw httpError(403, 'Pick your name first.');
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="my-shifts.ics"');
  res.send(Core.buildIcs(doc, me, Date.now()));
}));

app.delete('/api/teams/:code', route('Could not delete that.', async (req, res) => {
  countWrite(req);
  const doc = await loadTeam(req);
  if (!isOwner(doc, req)) throw httpError(404, GONE);
  await store.remove('teams', doc.code);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Read their texts"
 * ------------------------------------------------------------------ */

/** Gates, then a 16 KB parser, then the ask checked (a 400 costs nothing),
 *  then whitespace streams while one forced tool reads the messages. The
 *  answer is a proposal, validated against the names and the week; nothing
 *  is applied here. Failures after the stream starts are 200 with {error}. */
app.post('/api/read-texts', ...spend, textsJson, async (req, res) => {
  let b;
  try { b = ai.brief(req.body); } catch (err) { return fail(res, err, 'Could not start that.'); }
  const send = streamedJson(res);
  try {
    const raw = await ai.read(await clientFor(req), modelFor(req), b);
    send({ proposal: ai.toProposal(raw, b.names), week: b.week });
  } catch (err) {
    const f = failure(err, 'Reading the texts isn’t available right now. Try again in a minute - you can still mark availability by hand.');
    send({ ...f.body, status: f.status });
  }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A team link (t/<CODE>) is the same single-page app served one level down;
// <base href="../"> resolves every relative asset and API path against the
// app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/t/:code', (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(deepIndex()); });
app.all('/t/:code', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

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
  // ROTA_DEV_MOUNT=/rota runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.ROTA_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`rota listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
