// Drip - find every subscription quietly draining your account.
//
// Subscriptions creep: a streaming service you forgot, a free trial that
// turned paid, an app that raised its price twice, two music services, a gym
// you stopped going to. Banks show charges one by one, never "here is
// everything that bills you on repeat, and what it costs a year". Drip reads
// the statement people can already download and turns it into that list,
// then makes deciding fun. See CLAUDE.md.
//
// THE STATEMENT NEVER REACHES THIS SERVER. It is read in the browser by
// public/drip-core.js; there is no route here that accepts one. What the
// server does:
//   - serves the page;
//   - ONE metered, signed-in model call: reading the subscriptions off up to
//     three screenshots (a phone's Settings -> Subscriptions page). The
//     images are read once and dropped;
//   - keeps one saved list per account - the drips only (name, category,
//     amount, cadence, next date, decision, notes), never a transaction.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/drip-core');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.DRIP_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('DRIP_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read images.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere in these pages: every app in the lab shares
  // one origin, so one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// One route carries more than 128 KB - up to three screenshots - and it
// mounts its own 12 MB parser AFTER sign-in, budget and the daily cap, so a
// stranger's body is never read.
const SNAP_ROUTE = /^\/api\/snap$/;
const snapJson = express.json({ limit: '12mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (SNAP_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'drip',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Drip',
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
const user = identity.requireUser;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;

// Only the app's own errors (marked `expose`) reach the client with their
// status and words. Anything else is logged - its stack's first lines only,
// never a body: a merchant, an amount or an image is nobody's business - and
// answered with the route's fallback. An upstream failure (the SDK's errors
// carry a `.status` and a raw body of their own) is a 502, or 503 when the
// provider is overloaded or rate-limited.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - or add them by hand, which is free.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, cadences: Core.CADENCES, categories: Core.CAT_IDS });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({
    signedIn: true,
    email: req.user.email,
    budget: identityLib.budgetFor(req.user),
    tier: identityLib.planFor(req.user, MODELS).tier,
  });
});

/* ------------------------------------------------------------------ *
 * Metered: snap a subscriptions page
 * ------------------------------------------------------------------ */

/**
 * Gates, then the 12 MB parser, then the image checks (400s cost nothing) -
 * and only then the whitespace stream, after which a failure is a 200
 * {error}. The images are read once and dropped; nothing here writes to the
 * store, and nothing logged carries a name, a price or a byte of an image.
 */
app.post('/api/snap', ...spend, snapJson, async (req, res) => {
  let photos;
  try { photos = photo.validateAll((req.body || {}).photos); } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const day = today();
    const raw = await ai.readSubscriptions(await clientFor(req), modelFor(req), photos, day);
    const out = Core.cleanSnapItems(raw, day);
    if (!out.items.length) throw httpError(422, 'No subscriptions with a price could be read from that. Try a sharper screenshot of the list - or add them by hand.');
    send(out);
  } catch (err) { send(failure(err, 'The screenshots could not be read. Try again in a minute - or add them by hand.').body); }
});

/* ------------------------------------------------------------------ *
 * Signed in, free: one saved list per account - drips only
 * ------------------------------------------------------------------ */

/**
 * One read-modify-write at a time per account on this instance, queued: a
 * double-tapped Save must not race itself.
 */
const locks = new Map();
async function exclusive(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}
const saves = identityLib.createLimiter({ max: 60, windowMs: 10 * 60 * 1000 });

/** A stored list, cleaned on the way out too. */
function view(doc) {
  if (!doc) return null;
  return {
    drips: Core.cleanList(doc.drips).map(Core.toSaved),
    checkedOn: Core.isoDay(doc.checkedOn) ? doc.checkedOn : null,
    updatedAt: doc.updatedAt || null,
  };
}

app.get('/api/list', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ list: view(await store.get('lists', req.user.id)), limit: Core.LIMITS.drips });
  } catch (err) { fail(res, err, 'Could not load your list.'); }
});

/**
 * Save the whole list. Only the drip fields are kept - whatever else a
 * request carries (a charge history, a flag, a statement) is dropped here,
 * not trusted to the page to leave out.
 */
app.put('/api/list', user, async (req, res) => {
  try {
    if (!saves.hit(req.user.id)) throw httpError(429, 'That’s a lot of saves. Wait a few minutes and try again.');
    const b = req.body || {};
    if (!Array.isArray(b.drips)) throw httpError(400, 'Send the list as drips.');
    if (b.drips.length > Core.LIMITS.drips) throw httpError(400, `A list keeps up to ${Core.LIMITS.drips} drips. Remove a few first.`);
    const drips = Core.cleanList(b.drips).map(Core.toSaved);
    const checkedOn = Core.isoDay(b.checkedOn) && b.checkedOn <= today() ? b.checkedOn : today();
    const saved = await exclusive(`list/${req.user.id}`, async () => {
      const cur = await store.get('lists', req.user.id);
      const doc = { drips, checkedOn, createdAt: (cur && cur.createdAt) || now(), updatedAt: now() };
      await store.set('lists', req.user.id, doc);
      return doc;
    });
    res.json({ list: view(saved) });
  } catch (err) { fail(res, err, 'Could not save your list. It is still on this phone.'); }
});

app.delete('/api/list', user, async (req, res) => {
  try {
    await exclusive(`list/${req.user.id}`, () => store.remove('lists', req.user.id));
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const INDEX = path.join(__dirname, 'public', 'index.html');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Try fewer screenshots.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // DRIP_DEV_MOUNT=/drip runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.DRIP_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`drip listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
