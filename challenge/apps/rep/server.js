// Rep - lift, log, beat last time. See CLAUDE.md.
//
// The training log - workouts, sets, routines, custom exercises, settings -
// lives on the phone (localStorage) and is worked out there by
// public/rep-core.js: "beat last time", PRs, the charts, the streak, the
// rest timer and the plate calculator. Nothing about it reaches this server
// unless:
//
//   - you are signed in (free): your workouts, routines and custom exercises
//     are kept in your account, filed under an HMAC of the account id, so
//     they follow you to another phone;
//   - you tap "Plan my next 4 weeks": the one model call, metered and signed
//     in. It is told the goal, days a week, equipment and a compact summary
//     of recent lifts - never a name or a note.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/rep-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.REP_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('REP_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Each route that takes more than a few KB mounts its own parser AFTER the
// sign-in check (and, for the model call, after budget and the daily cap),
// so a stranger's body is never read. Everything else: 16 KB.
const planJson = express.json({ limit: '16kb' });
const workoutJson = express.json({ limit: '64kb' });
const itemJson = express.json({ limit: '32kb' });
const mergeJson = express.json({ limit: '512kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(plan|log\/merge|workouts\/[^/]+|routines\/[^/]+|exercises\/[^/]+)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (sync and "Plan my next 4 weeks" need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'rep',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Rep',
  mountPath: '/api/auth',
});
identity.mount(app);

// The fake (local runs and tests only) is kept so a test can read what it
// was sent.
const fakeClient = FAKE_AI ? require('./lib/fakeai').create() : null;
const sharedClient = FAKE_AI
  ? identity.meter(fakeClient)
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
 * body: someone's training is nobody's business - and answered with the
 * route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = Core.fail;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - your log and routines still work.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/** The lifter's "today" (their phone's day), if it is a real day within a
 *  day of the server's; otherwise the server's own UTC day. */
function todayOf(req) {
  const server = new Date().toISOString().slice(0, 10);
  const t = (req.body && req.body.today) || req.query.today;
  return Core.isDay(t) && Math.abs(Core.daysBetween(server, t)) <= 1 ? t : server;
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, library: Core.LIBRARY.length, starters: Core.STARTERS.map((s) => ({ id: s.id, name: s.name })) });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free: the log follows you to another phone.
 *
 *   months/<tag>_<YYYY-MM> = {owner: tag, month, workouts: {<id>: workout}}
 *   profiles/<tag>         = {routines: {<id>: routine}, exercises: {<id>: exercise}}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret - never the id or the email. Every write is a transaction.
 * ------------------------------------------------------------------ */

const saves = identityLib.createLimiter({ max: 300, windowMs: 10 * 60 * 1000 });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('rep log owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Your log is safe on this phone.');
  if (write && !saves.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - it’s all still on this phone.');
  return ownerTag(req.user.id, SECRET());
}
const monthId = (tag, day) => `${tag}_${Core.monthOf(day)}`;
const isSampleId = (id) => /^sample/.test(id);
const stamp = (v, now) => (Number(v) > 0 && Number(v) <= now + 60000 ? Math.round(Number(v)) : now);

/** Everything the account holds, cleaned on the way out too. */
async function readLog(tag, today) {
  const [months, profile] = await Promise.all([
    store.list('months', { where: [['owner', '==', tag]], limit: 600 }),
    store.get('profiles', tag),
  ]);
  const exercises = Object.values((profile && profile.exercises) || {}).map(Core.cleanExercise).filter(Boolean);
  const custom = {};
  exercises.forEach((e) => { custom[e.id] = e; });
  const workouts = [];
  months.forEach((m) => Object.values(m.workouts || {}).forEach((w) => { const c = Core.cleanWorkout(w, { custom }); if (c) workouts.push(c); }));
  workouts.sort(Core.byTime);
  const routines = Object.values((profile && profile.routines) || {}).map((r) => Core.cleanRoutine(r, custom)).filter(Boolean);
  return { workouts, routines, exercises, today };
}

app.get('/api/log', identity.requireUser, route('Could not load your log.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await readLog(tagOf(req, false), todayOf(req)));
}));

/** Save one workout (a finished one, or an edit). Only its own fields are
 *  kept: the sample flag or anything else a request carries is dropped. */
app.put('/api/workouts/:id', identity.requireUser, workoutJson, route('Could not save that. It is still on this phone.', async (req, res) => {
  const tag = tagOf(req, true);
  const now = Date.now();
  const raw = (req.body || {}).workout;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the workout.');
  if (isSampleId(String(req.params.id))) throw httpError(400, 'The sample stays on this phone.');
  const w = Core.cleanWorkout({ ...raw, id: req.params.id }, { today: todayOf(req) });
  if (!w) throw httpError(400, 'That workout has no sets in it, or its date is not a real day.');
  const saved = { ...Core.toSaved(w), updatedAt: stamp(raw.updatedAt, now) };
  await store.transact('months', monthId(tag, w.day), (cur) => {
    const workouts = { ...((cur && cur.workouts) || {}) };
    if (!workouts[w.id] && Object.keys(workouts).length >= Core.LIMITS.monthWorkouts) throw httpError(400, `A month keeps up to ${Core.LIMITS.monthWorkouts} workouts.`);
    workouts[w.id] = saved;
    return { owner: tag, month: Core.monthOf(w.day), workouts, updatedAt: now };
  });
  res.json({ workout: saved });
}));

app.delete('/api/workouts/:id', identity.requireUser, route('Could not delete that.', async (req, res) => {
  const tag = tagOf(req, true);
  const id = String(req.params.id || '');
  const day = String(req.query.day || '');
  if (!Core.ID_RE.test(id) || !Core.isDay(day)) throw httpError(400, 'Say which workout, and its day.');
  await store.transact('months', monthId(tag, day), (cur) => {
    if (!cur || !cur.workouts || !cur.workouts[id]) return undefined;
    const workouts = { ...cur.workouts };
    delete workouts[id];
    return Object.keys(workouts).length ? { ...cur, workouts, updatedAt: Date.now() } : null;
  });
  res.json({ ok: true });
}));

/** One routine or one custom exercise, into the profile. */
function profileRoute(kind) {
  return route('Could not save that. It is still on this phone.', async (req, res) => {
    const tag = tagOf(req, true);
    const now = Date.now();
    const raw = (req.body || {})[kind === 'routines' ? 'routine' : 'exercise'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send it first.');
    const item = kind === 'routines' ? Core.cleanRoutine({ ...raw, id: req.params.id }) : Core.cleanExercise({ ...raw, id: req.params.id });
    if (!item) throw httpError(400, kind === 'routines' ? 'A routine needs a name and at least one exercise.' : 'An exercise needs a name.');
    item.updatedAt = stamp(raw.updatedAt, now);
    const cap = kind === 'routines' ? Core.LIMITS.routines : Core.LIMITS.exercises;
    await store.transact('profiles', tag, (cur) => {
      const map = { ...((cur && cur[kind]) || {}) };
      if (!map[item.id] && Object.keys(map).length >= cap) throw httpError(400, `You can keep up to ${cap} of those.`);
      map[item.id] = item;
      return { routines: {}, exercises: {}, ...(cur || {}), [kind]: map, updatedAt: now };
    });
    res.json({ [kind === 'routines' ? 'routine' : 'exercise']: item });
  });
}
app.put('/api/routines/:id', identity.requireUser, itemJson, profileRoute('routines'));
app.put('/api/exercises/:id', identity.requireUser, itemJson, profileRoute('exercises'));

app.delete('/api/routines/:id', identity.requireUser, route('Could not delete that.', async (req, res) => {
  const tag = tagOf(req, true);
  const id = String(req.params.id || '');
  if (!Core.ID_RE.test(id)) throw httpError(400, 'That isn’t one of your routines.');
  await store.transact('profiles', tag, (cur) => {
    if (!cur || !cur.routines || !cur.routines[id]) return undefined;
    const routines = { ...cur.routines };
    delete routines[id];
    return { ...cur, routines, updatedAt: Date.now() };
  });
  res.json({ ok: true });
}));

/** Bring this phone's log into the account on sign-in (and an import, in
 *  batches): what the account lacks is added, what it has is replaced only
 *  by a newer copy. The sample never comes along. */
app.post('/api/log/merge', identity.requireUser, mergeJson, route('Could not bring your log across. It is still on this phone.', async (req, res) => {
  const tag = tagOf(req, true);
  const b = req.body || {};
  if (!Array.isArray(b.workouts)) throw httpError(400, 'Send the workouts.');
  if (b.workouts.length > Core.LIMITS.mergeBatch) throw httpError(400, `Send at most ${Core.LIMITS.mergeBatch} workouts at a time.`);
  const today = todayOf(req);
  const now = Date.now();
  const exercises = (Array.isArray(b.exercises) ? b.exercises.slice(0, Core.LIMITS.exercises) : []).map((x) => (x && !isSampleId(String(x.id)) ? Core.cleanExercise(x) : null)).filter(Boolean);
  const routines = (Array.isArray(b.routines) ? b.routines.slice(0, Core.LIMITS.routines) : []).map((x) => Core.cleanRoutine(x)).filter(Boolean);
  let refused = 0;
  if (exercises.length || routines.length) {
    await store.transact('profiles', tag, (cur) => {
      const next = { routines: {}, exercises: {}, ...(cur || {}) };
      [['exercises', exercises, Core.LIMITS.exercises], ['routines', routines, Core.LIMITS.routines]].forEach(([k, list, cap]) => {
        const map = { ...next[k] };
        list.forEach((x) => {
          const item = { ...x, updatedAt: stamp(x.updatedAt, now) };
          const have = map[x.id];
          if (have && Number(have.updatedAt || 0) >= item.updatedAt) return;
          if (!have && Object.keys(map).length >= cap) { refused++; return; }
          map[x.id] = item;
        });
        next[k] = map;
      });
      return { ...next, updatedAt: now };
    });
  }
  const byMonth = {};
  b.workouts.forEach((raw) => {
    if (!raw || typeof raw !== 'object' || raw.sample === true || isSampleId(String(raw.id))) return;
    const w = Core.cleanWorkout(raw, { today });
    if (!w) { refused++; return; }
    (byMonth[Core.monthOf(w.day)] = byMonth[Core.monthOf(w.day)] || []).push({ ...Core.toSaved(w), updatedAt: stamp(raw.updatedAt, now) });
  });
  for (const [month, list] of Object.entries(byMonth)) {
    await store.transact('months', `${tag}_${month}`, (cur) => {
      const workouts = { ...((cur && cur.workouts) || {}) };
      list.forEach((w) => {
        const have = workouts[w.id];
        if (have && Number(have.updatedAt || 0) >= w.updatedAt) return;
        if (!have && Object.keys(workouts).length >= Core.LIMITS.monthWorkouts) { refused++; return; }
        workouts[w.id] = w;
      });
      return { owner: tag, month, workouts, updatedAt: now };
    });
  }
  if (b.read === false) return res.json({ ok: true, refused });
  res.json({ ...(await readLog(tag, today)), refused });
}));

/** Forget the account's copy (this phone keeps its own). */
app.delete('/api/log', identity.requireUser, route('Could not clear it.', async (req, res) => {
  const tag = tagOf(req, true);
  const months = await store.list('months', { where: [['owner', '==', tag]], limit: 600 });
  for (const m of months) await store.remove('months', m.id);
  await store.remove('profiles', tag);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Plan my next 4 weeks"
 * ------------------------------------------------------------------ */

/** Gates, then the 16 KB parser, then the brief checked (a 400 costs
 *  nothing), then one forced tool, then the plan cleaned. Nothing here
 *  writes to the store, and nothing logged carries a word of the brief. Not
 *  streamed: a plan comes back in well under a minute. */
app.post('/api/plan', ...spend, planJson, route('Plans aren’t available right now. Try again in a minute - your log and routines still work.', async (req, res) => {
  const b = ai.brief(req.body);
  const plan = ai.cleanPlan(await ai.plan(await clientFor(req), modelFor(req), b), b);
  res.set('Cache-Control', 'no-store');
  res.json({ plan });
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
  // REP_DEV_MOUNT=/rep runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.REP_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`rep listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, ownerTag };
