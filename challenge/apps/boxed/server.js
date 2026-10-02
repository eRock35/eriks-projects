// Boxed - every K-1 box read, checked and rolled up, in minutes not hours.
//
// Every partnership investment produces a Schedule K-1 (Form 1065), and a
// client with a fund portfolio can have dozens. Preparers read each one and
// key its boxes, codes and footnotes into tax software by hand, then chase
// the ones that haven't arrived. Boxed reads them (one model call per K-1),
// checks them (Item L reconciles, Item L against the boxes, distributions
// against withdrawals, Item J, the flags, year over year), rolls them up
// across the client and tracks what is still missing. See CLAUDE.md.
//
// A model is used for ONE thing: reading a K-1. The checks, the roll-up,
// what's missing, the calendar, the CSVs, typing a K-1 in and the example
// are public/boxed-core.js and free, with or without an account.
//
// TAX DATA. The PDF or photos are read once by the model and never stored or
// logged. A partner's name, TIN and address are never stored, anywhere: the
// TIN reaches the page as its last four only, and a saved client file holds
// a label the person typed, the tax year, partnership names, the last four
// of their EINs, the box/code values, Items J/K/L, check results and stage.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/boxed-core');
const ai = require('./lib/ai');
const files = require('./lib/files');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.BOXED_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('BOXED_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read PDFs and photos.
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

// Two routes carry more than 128 KB, and each mounts its own parser AFTER
// its gates, so a stranger's body is never read: the read (one K-1: a PDF up
// to 10 MB, which is ~13.4 MB as base64, or six photos) behind sign-in,
// budget and the daily cap; and saving a client file (up to 150 K-1s) behind
// sign-in.
const READ_ROUTE = /^\/api\/read$/;
const SAVE_ROUTE = /^\/api\/clients(\/[a-z0-9]+)?$/;
const readJson = express.json({ limit: '25mb' });
const saveJson = express.json({ limit: '3mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => ((READ_ROUTE.test(req.path) || (SAVE_ROUTE.test(req.path) && (req.method === 'POST' || req.method === 'PUT'))) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'boxed',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Boxed',
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

const httpError = files.httpError;
const now = () => new Date().toISOString();

// Only the app's own errors (marked `expose`) reach the client with their
// status and words. Anything else is logged - its stack's first lines only,
// never a body: a K-1 carries a person's income, name and number - and
// answered with the route's fallback. An upstream failure (the SDK's errors
// carry a `.status` and a raw body of their own) is a 502, or 503 when the
// provider is overloaded or rate-limited.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - or type this K-1 in, which is free.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, minutesByHand: Core.MINUTES_BY_HAND, boxes: Core.BOXES.map((b) => b.box) });
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
 * Metered: read one K-1
 * ------------------------------------------------------------------ */

/**
 * One K-1 per request: {pdf: {data}} or {photos: [{type, data}]}, and the
 * client file's tax year (used only when the K-1 prints none). The page
 * sends each file of a batch as its own request and draws a progress list,
 * so one bad file stops nothing and no request waits on ten readings.
 *
 * Gates, then the 25 MB parser, then the file checks (400s cost nothing) -
 * and only then the whitespace stream (a 30-page PDF can take a minute,
 * which drops an idle phone connection), after which a failure is a 200
 * {error}. The file is read once and dropped; nothing here writes to the
 * store, and nothing logged carries a figure, a name or a byte of a file.
 */
app.post('/api/read', ...spend, readJson, async (req, res) => {
  let input;
  try { input = files.readInput(req.body); } catch (err) { return fail(res, err); }
  const taxYear = Core.cleanYear((req.body || {}).taxYear);
  const send = streamedJson(res);
  try {
    const raw = await ai.readK1(await clientFor(req), modelFor(req), input);
    if (raw && raw.form && raw.form !== '1065' && raw.readable !== false) {
      const which = raw.form === '1120S' ? 'Form 1120-S (an S corporation)' : raw.form === '1041' ? 'Form 1041 (a trust or estate)' : 'another form';
      throw httpError(422, `That’s a Schedule K-1 from ${which}. Boxed reads partnership K-1s (Form 1065) - type this one in by hand if you want it in the roll-up.`);
    }
    const out = Core.fromModel(raw, { src: input.kind, taxYear });
    if (!out) throw httpError(422, input.kind === 'pdf' ? 'That doesn’t look like a Schedule K-1 (Form 1065). Check it’s the K-1 itself, not a cover letter - or type it in.' : 'Those photos don’t look like a Schedule K-1 (Form 1065), or they can’t be read. Try flatter, well-lit shots - or type it in.');
    send({ k1: out.k1, partner: out.partner, notes: out.notes, dropped: out.dropped, note: out.note, checks: Core.sortChecks(Core.checkK1(out.k1)) });
  } catch (err) { send(failure(err, 'The reading did not finish. Try again in a minute - or type this K-1 in.').body); }
});

/* ------------------------------------------------------------------ *
 * Signed in, free: client files
 * ------------------------------------------------------------------ */

// Under the owner's uid, so nobody else's id can name one: every route is a
// 404 for anyone else's.
const filesOf = (uid) => `clients/${uid}/items`;
const ID_RE = /^c[a-z0-9]{12}$/;
const MAX_DOC_BYTES = 900 * 1024; // under Firestore's 1 MiB document limit

async function loadFile(req) {
  const id = String(req.params.id || '');
  const doc = ID_RE.test(id) ? await store.get(filesOf(req.user.id), id) : null;
  if (!doc) throw httpError(404, 'No such client file.');
  return doc;
}

/** A stored client file, cleaned on the way out too. */
function view(doc) {
  const f = Core.cleanFile({ label: doc.label, taxYear: doc.taxYear, k1s: doc.k1s, expected: doc.expected });
  return { id: doc.id, ...f, createdAt: doc.createdAt || null, updatedAt: doc.updatedAt || null };
}
function summary(doc) {
  const f = view(doc);
  const b = Core.board(f, now().slice(0, 10));
  return { id: f.id, label: f.label, taxYear: f.taxYear, k1s: b.received, checked: b.checked, missing: b.missing, fails: b.results.fail, updatedAt: f.updatedAt };
}
/** The body as a client file - only what may be stored - and its size. */
function fromBody(body) {
  const f = Core.cleanFile(body);
  const data = { label: f.label, taxYear: f.taxYear, k1s: f.k1s, expected: f.expected };
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_DOC_BYTES) throw httpError(413, 'That client file is too large to save. Split it into two files.');
  return data;
}
function newFileId() { return 'c' + Core.newId('').slice(0, 12); }

/** One read-modify-write at a time per key on this instance, queued. */
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
const writes = identityLib.createLimiter({ max: 120, windowMs: 10 * 60 * 1000 });
function limited(req) {
  if (!writes.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving in a few minutes - wait a moment and try again.');
}

async function create(uid, data) {
  return exclusive(`clients/${uid}`, async () => {
    const have = await store.list(filesOf(uid), { limit: Core.LIMITS.clients + 1 });
    if (have.length >= Core.LIMITS.clients) throw httpError(409, `You can keep up to ${Core.LIMITS.clients} client files. Delete one first.`);
    const at = now();
    const id = newFileId();
    await store.set(filesOf(uid), id, { ...data, createdAt: at, updatedAt: at });
    return { id, ...data, createdAt: at, updatedAt: at };
  });
}

app.get('/api/clients', user, async (req, res) => {
  try {
    const rows = await store.list(filesOf(req.user.id), { limit: Core.LIMITS.clients + 5 });
    res.set('Cache-Control', 'no-store');
    res.json({ clients: rows.map(summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), limit: Core.LIMITS.clients });
  } catch (err) { fail(res, err, 'Could not load your client files.'); }
});

app.post('/api/clients', user, saveJson, async (req, res) => {
  try {
    limited(req);
    const out = await create(req.user.id, fromBody(req.body));
    res.json({ client: view(out) });
  } catch (err) { fail(res, err, 'Could not save that client file.'); }
});

app.get('/api/clients/:id', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ client: view(await loadFile(req)) });
  } catch (err) { fail(res, err); }
});

/** Replace a client file's contents whole: a merge would keep a deleted K-1. */
app.put('/api/clients/:id', user, saveJson, async (req, res) => {
  try {
    limited(req);
    const data = fromBody(req.body);
    const out = await exclusive(`client/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadFile(req);
      const next = { ...data, createdAt: doc.createdAt || now(), updatedAt: now() };
      await store.set(filesOf(req.user.id), doc.id, next);
      return { id: doc.id, ...next };
    });
    res.json({ client: view(out) });
  } catch (err) { fail(res, err, 'Could not save that client file.'); }
});

/** Rename. */
app.patch('/api/clients/:id', user, async (req, res) => {
  try {
    limited(req);
    const label = Core.clean((req.body || {}).label, Core.LIMITS.label);
    if (!label) throw httpError(400, 'Give the client file a label.');
    const out = await exclusive(`client/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadFile(req);
      const { id, ...rest } = doc;
      const next = { ...rest, label, updatedAt: now() };
      await store.set(filesOf(req.user.id), id, next);
      return { id, ...next };
    });
    res.json({ client: view(out) });
  } catch (err) { fail(res, err); }
});

/** Duplicate to next year: this year's K-1s come along as last year's (so
 *  year over year works) and every partnership is expected again. */
app.post('/api/clients/:id/duplicate', user, async (req, res) => {
  try {
    limited(req);
    const doc = await loadFile(req);
    const next = Core.nextYear(view(doc));
    const out = await create(req.user.id, fromBody(next));
    res.json({ client: view(out) });
  } catch (err) { fail(res, err); }
});

app.delete('/api/clients/:id', user, async (req, res) => {
  try {
    await exclusive(`client/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadFile(req);
      await store.remove(filesOf(req.user.id), doc.id);
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Boxed reads one K-1 at a time: a PDF up to 10 MB, or up to six photos.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // BOXED_DEV_MOUNT=/boxed runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.BOXED_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`boxed listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
