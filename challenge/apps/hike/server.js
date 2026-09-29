// Hike - raise your prices without losing your regulars.
//
// Small businesses sit on prices for years because raising them feels risky:
// they fear losing regulars, they don't know how many they can afford to
// lose, they round badly ($4.50 -> $4.86), and they dread writing the
// announcement and answering "why did prices go up?" at the counter. Hike
// turns it into a number (the break-even: "you could lose 1 in 6 customers
// and still make more"), a plan (a price list rounded like a pro and held
// under $10, dates and a calendar file), the words (an email, a door sign, a
// post, a text and a counter script) and, afterwards, a verdict ("sales are
// down 4% - your break-even was 17%. You're ahead"). See CLAUDE.md.
//
// A model is used for TWO things, both metered and both signed in: reading
// the prices off photos of a menu, and writing the announcement in the
// owner's voice. Everything else is public/hike-core.js and free, with or
// without an account - including plain templates of every announcement
// piece.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/hike-core');
const P = require('./lib/plans');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.HIKE_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('HIKE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  // No inline script anywhere in these pages: every app in the lab shares
  // one origin, so one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// One route carries more than 128 KB - snapping up to four menu photos - and
// it mounts its own 12 MB parser AFTER sign-in, budget and the daily cap, so
// a stranger's body is never read.
const SNAP_ROUTE = /^\/api\/snap$/;
const snapJson = express.json({ limit: '12mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (SNAP_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'hike',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Hike',
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

const now = () => new Date().toISOString();
const httpError = P.httpError;

// Only the app's own errors (marked `expose`) reach the client with their
// status and words. Anything else is logged - its stack's first lines only,
// never a body: prices, costs and photos are a business's own - and
// answered with the route's fallback. An upstream failure (the SDK's errors
// carry a `.status` and a raw body of their own) is a 502, or 503 when the
// provider is overloaded or rate-limited.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the free templates below still work.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/* ------------------------------------------------------------------ *
 * Saved plans live under their owner's uid: nobody else's id can name
 * them, so every route is a 404 for anyone else's.
 * ------------------------------------------------------------------ */

const plansOf = (uid) => `plans/${uid}/items`;

async function loadPlan(req) {
  const id = String(req.params.id || '');
  const doc = P.ID_RE.test(id) ? await store.get(plansOf(req.user.id), id) : null;
  if (!doc) throw httpError(404, 'No such plan.');
  return doc;
}

/**
 * One read-modify-write at a time per key on this instance, queued rather
 * than refused: a double-tapped Save must not store a plan twice, and two
 * saves at once must not make an eleventh.
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

async function createPlan(uid, plan) {
  return exclusive(`plans/${uid}`, async () => {
    const have = await store.list(plansOf(uid), { limit: P.LIMITS.plans + 1 });
    if (have.length >= P.LIMITS.plans) throw httpError(409, `You can keep up to ${P.LIMITS.plans} plans. Delete one first.`);
    const at = now();
    const id = P.newId();
    const doc = { ...plan, createdAt: at, updatedAt: at };
    await store.set(plansOf(uid), id, doc);
    return { id, ...doc };
  });
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: P.LIMITS, styles: Core.STYLES, reasons: Core.REASONS.map((r) => ({ id: r.id, label: r.label })), tones: Core.TONES, types: Core.BUSINESS_TYPES });
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
 * Metered: snap the menu
 * ------------------------------------------------------------------ */

/**
 * Gates, then the 12 MB parser, then the photo checks (400s cost nothing) -
 * and only then the whitespace stream, after which a failure is a 200
 * {error}. The photos are read once and dropped; nothing here writes to the
 * store, and nothing logged carries a price or a byte of a photo.
 */
app.post('/api/snap', ...spend, snapJson, async (req, res) => {
  let photos;
  try { photos = photo.validateAll((req.body || {}).photos); } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const raw = await ai.readMenu(await clientFor(req), modelFor(req), photos);
    const out = ai.cleanPrices(raw);
    if (!out) throw httpError(422, 'No prices could be read from that. Try a closer, straighter, well-lit photo - or paste the list as text.');
    send(out);
  } catch (err) { send(failure(err, 'The photo could not be read. Try again in a minute.').body); }
});

/* ------------------------------------------------------------------ *
 * Metered: write the announcement
 * ------------------------------------------------------------------ */

/**
 * The announcement is worked out from what the owner typed AND from the
 * price list, repriced here from its cleaned lines - so the figures a draft
 * may use are the server's, not the page's say-so.
 */
function announceFacts(body) {
  const b = body && typeof body === 'object' ? body : {};
  const input = Core.cleanAnnounce(b.announce);
  const lines = Core.cleanLines(b.lines);
  const settings = Core.cleanSettings(b.settings);
  const roll = Core.cleanRollout(b.rollout, P.today());
  const pl = Core.priceList(lines, settings);
  const sym = Core.symbolOf(settings.currency);
  const fmt = Core.priceFormat(pl.rows, sym);
  if (!input.summary && pl.rows.length) input.summary = Core.changeSummary(pl, sym);
  if (!input.business && !input.summary && !input.reasons.length && !input.other) throw httpError(400, 'Add your business name and what is changing first.');
  return {
    input,
    facts: {
      rows: pl.rows, blendedBp: pl.blended ? pl.blended.bp : null, targetBp: settings.target, effective: roll.effective, sym,
      kept: pl.rows.filter((r) => r.locked).map((r) => ({ name: r.name, price: fmt(r.old) })),
    },
  };
}

app.post('/api/announce', ...spend, async (req, res) => {
  let job;
  try { job = announceFacts(req.body); } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const out = await ai.writeAnnouncement(await clientFor(req), modelFor(req), job.input, job.facts);
    send(out);
  } catch (err) { send(failure(err, 'The draft did not finish. The free templates below still work - or try again in a minute.').body); }
});

/* ------------------------------------------------------------------ *
 * Saved plans
 * ------------------------------------------------------------------ */

app.get('/api/plans', user, async (req, res) => {
  try {
    const rows = await store.list(plansOf(req.user.id), { limit: P.LIMITS.plans + 5 });
    res.set('Cache-Control', 'no-store');
    res.json({ plans: rows.map(P.summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), limit: P.LIMITS.plans });
  } catch (err) { fail(res, err); }
});

app.post('/api/plans', user, async (req, res) => {
  try {
    const plan = P.fromBody(req.body);
    res.json({ plan: P.view(await createPlan(req.user.id, plan)) });
  } catch (err) { fail(res, err, 'Could not save that plan.'); }
});

app.get('/api/plans/:id', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ plan: P.view(await loadPlan(req)) });
  } catch (err) { fail(res, err); }
});

/** Save the plan's content: everything but its id and createdAt. Written
 *  whole, so a removed line or tracker week stays removed. */
app.put('/api/plans/:id', user, async (req, res) => {
  try {
    const plan = P.fromBody(req.body);
    const out = await exclusive(`plan/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadPlan(req);
      const next = { ...plan, createdAt: doc.createdAt || now(), updatedAt: now() };
      await store.set(plansOf(req.user.id), doc.id, next);
      return { id: doc.id, ...next };
    });
    res.json({ plan: P.view(out) });
  } catch (err) { fail(res, err, 'Could not save that plan.'); }
});

/** Rename. */
app.patch('/api/plans/:id', user, async (req, res) => {
  try {
    const name = Core.clean((req.body || {}).name, P.LIMITS.planName);
    if (!name) throw httpError(400, 'Give the plan a name.');
    const out = await exclusive(`plan/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadPlan(req);
      const { id, ...rest } = doc;
      const next = { ...rest, name, updatedAt: now() };
      await store.set(plansOf(req.user.id), id, next);
      return { id, ...next };
    });
    res.json({ plan: P.view(out) });
  } catch (err) { fail(res, err); }
});

app.post('/api/plans/:id/duplicate', user, async (req, res) => {
  try {
    const doc = await loadPlan(req);
    const copy = P.fromBody({ ...P.view(doc), name: Core.clean(`${P.view(doc).name} (copy)`, P.LIMITS.planName) });
    res.json({ plan: P.view(await createPlan(req.user.id, copy)) });
  } catch (err) { fail(res, err); }
});

/** Delete a plan: it is one document, so this removes everything. */
app.delete('/api/plans/:id', user, async (req, res) => {
  try {
    await exclusive(`plan/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadPlan(req);
      await store.remove(plansOf(req.user.id), doc.id);
    });
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Try fewer or smaller photos.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // HIKE_DEV_MOUNT=/hike runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.HIKE_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`hike listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
