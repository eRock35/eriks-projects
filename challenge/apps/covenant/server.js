// Covenant - know what your business loan expects of you, before the bank
// tells you.
//
// Small businesses sign term loans and lines of credit full of covenants -
// a minimum debt service coverage, a maximum leverage, statements due 120
// days after year end, "no additional debt without consent" - and often find
// them only when they are already in breach. Covenant reads the agreement
// (pasted, or photos of its pages) into a plain checklist, with each
// covenant's own words checked against the document; a health check works
// out each financial test from the owner's numbers and says, in dollars, how
// much room is left; the reporting covenants become dated deadlines and an
// .ics file; and every covenant carries the explanation a lender's support
// person could give a customer. See CLAUDE.md.
//
// A model is used for ONE thing: reading the agreement. The health check,
// the headroom, the deadlines, the calendar and the example are
// public/covenant-core.js and free, with or without an account.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/covenant-core');
const L = require('./lib/loans');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.COVENANT_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('COVENANT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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

// Two routes carry more than 128 KB, and each mounts its own parser AFTER its
// gates, so a stranger's body is never read: the read (up to 60,000
// characters of text, or six page photos) behind sign-in, budget and the
// daily cap; and saving a loan (40 covenants) behind sign-in.
const READ_ROUTE = /^\/api\/read$/;
const SAVE_ROUTE = /^\/api\/loans$/;
const readJson = express.json({ limit: '17mb' });
const saveJson = express.json({ limit: '600kb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => ((READ_ROUTE.test(req.path) || (SAVE_ROUTE.test(req.path) && req.method === 'POST')) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'covenant',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Covenant',
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
const httpError = L.httpError;

// Only the app's own errors (marked `expose`) reach the client with their
// status and words. Anything else is logged - its stack only, never a body:
// an agreement names a business, its owners and its numbers - and answered
// with the route's fallback. An upstream failure (the Anthropic SDK's errors
// carry a `.status` and a raw body of their own) is a 502, or 503 when the
// provider is overloaded or rate-limited.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : fallback, ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/* ------------------------------------------------------------------ *
 * Saved loans live under their owner's uid: nobody else's id can name
 * them, so every route is a 404 for anyone else's.
 * ------------------------------------------------------------------ */

const loansOf = (uid) => `loans/${uid}/items`;

async function loadLoan(req) {
  const id = String(req.params.id || '');
  const doc = L.ID_RE.test(id) ? await store.get(loansOf(req.user.id), id) : null;
  if (!doc) throw httpError(404, 'No such loan.');
  return doc;
}

/**
 * One read-modify-write at a time per key on this instance, queued rather
 * than refused: a double-tapped Save must not store a loan twice or lose a
 * period typed a second later.
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

/** Replace a loan document whole: a merge would keep a deleted period. */
async function rewrite(uid, doc, patch) {
  const { id, ...rest } = doc;
  const next = { ...rest, ...patch, updatedAt: now() };
  await store.set(loansOf(uid), id, next);
  return { id, ...next };
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: L.LIMITS, fields: Core.FIELDS, kinds: Core.KIND_LABEL });
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
 * Metered: read a loan agreement
 * ------------------------------------------------------------------ */

/** What was sent to read, checked before anything is spent: a 400 here
 *  costs nothing. {text} or {photos: [{type, data}]}. */
function readInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (Array.isArray(b.photos) && b.photos.length) return { photos: photo.validateAll(b.photos) };
  if (typeof b.text !== 'string') throw httpError(400, 'Paste the loan agreement, or add photos of its pages.');
  // Keep line breaks and tabs; drop other control characters.
  const text = b.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (text.length > Core.LIMITS.text) {
    throw httpError(400, `That is ${text.length.toLocaleString('en-US')} characters - Covenant reads up to ${Core.LIMITS.text.toLocaleString('en-US')} at a time. Paste the definitions, covenants and reporting sections.`);
  }
  if (text.length < Core.LIMITS.minText) throw httpError(400, 'That is too short to be a loan agreement. Paste at least the covenants section.');
  return { text };
}

/**
 * Gates, then the parser, then the 400s - and only then the whitespace
 * stream (a long agreement takes a minute or more, which drops an idle phone
 * connection), after which a failure is a 200 {error}. The text and photos
 * are read once and dropped; nothing here writes to the store.
 */
app.post('/api/read', ...spend, readJson, async (req, res) => {
  let input;
  try { input = readInput(req.body); } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const raw = await ai.readAgreement(await clientFor(req), modelFor(req), input);
    const from = input.photos ? 'photo' : 'text';
    const reading = ai.cleanReading(raw, input.photos ? (typeof raw.transcript === 'string' ? raw.transcript : '') : input.text, from);
    if (!reading) {
      throw httpError(422, raw && raw.readable === false
        ? (input.photos ? 'Those photos don’t look like pages of a loan agreement, or they can’t be read. Try closer, flatter, well-lit shots - or paste the text.' : 'That doesn’t read like a loan agreement. Paste the agreement itself - the covenants are usually in articles called “Covenants” or “Financial Covenants”.')
        : 'No covenants were found in that. Check it includes the covenants section - often “Affirmative”, “Negative” and “Financial” covenants.');
    }
    send({ reading });
  } catch (err) { send(failure(err, 'The reading did not finish. Try again in a minute.').body); }
});

/* ------------------------------------------------------------------ *
 * Saved loans
 * ------------------------------------------------------------------ */

app.get('/api/loans', user, async (req, res) => {
  try {
    const rows = await store.list(loansOf(req.user.id), { limit: L.LIMITS.loans + 5 });
    res.set('Cache-Control', 'no-store');
    res.json({ loans: rows.map(L.summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) });
  } catch (err) { fail(res, err); }
});

app.post('/api/loans', user, saveJson, async (req, res) => {
  try {
    const at = now();
    const data = L.fromBody(req.body, at);
    const out = await exclusive(`loans/${req.user.id}`, async () => {
      const have = await store.list(loansOf(req.user.id), { limit: L.LIMITS.loans + 1 });
      if (have.length >= L.LIMITS.loans) throw httpError(409, `You can keep up to ${L.LIMITS.loans} loans. Delete one first.`);
      const id = L.newId();
      await store.set(loansOf(req.user.id), id, { ...data, createdAt: at, updatedAt: at });
      return { id, ...data, createdAt: at, updatedAt: at };
    });
    res.json({ loan: L.view(out) });
  } catch (err) { fail(res, err, 'Could not save that loan.'); }
});

app.get('/api/loans/:id', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ loan: L.view(await loadLoan(req)) });
  } catch (err) { fail(res, err); }
});

/** Rename, or change the fiscal year end. */
app.patch('/api/loans/:id', user, async (req, res) => {
  try {
    const b = req.body || {};
    const out = await exclusive(`loan/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadLoan(req);
      const patch = {};
      if (b.name !== undefined) {
        const name = Core.clean(b.name, L.LIMITS.name);
        if (!name) throw httpError(400, 'Give the loan a name.');
        patch.name = name;
      }
      if (b.fye !== undefined) {
        const n = Number(b.fye);
        if (!Number.isInteger(n) || n < 1 || n > 12) throw httpError(400, 'The fiscal year end is a month, 1 to 12.');
        patch.fye = n;
      }
      if (!Object.keys(patch).length) throw httpError(400, 'Nothing to change.');
      return rewrite(req.user.id, doc, patch);
    });
    res.json({ loan: L.view(out) });
  } catch (err) { fail(res, err); }
});

/** Delete a loan: it is one document, so this removes everything. */
app.delete('/api/loans/:id', user, async (req, res) => {
  try {
    await exclusive(`loan/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadLoan(req);
      await store.remove(loansOf(req.user.id), doc.id);
    });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** Save one period's health-check numbers ("2026 Q3", "2025 FY"). */
app.put('/api/loans/:id/periods/:period', user, async (req, res) => {
  try {
    const period = Core.cleanPeriod(req.params.period);
    if (!period) throw httpError(400, 'A period is a year and a quarter, like “2026 Q3”, or a fiscal year, like “2025 FY”.');
    const inputs = L.periodInputs((req.body || {}).inputs);
    if (!Object.keys(inputs).length) throw httpError(400, 'Enter at least one number to save.');
    const out = await exclusive(`loan/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadLoan(req);
      const periods = { ...(doc.periods || {}) };
      if (!periods[period] && Object.keys(periods).length >= L.LIMITS.periods) throw httpError(409, `A loan keeps up to ${L.LIMITS.periods} periods. Delete an old one first.`);
      periods[period] = { inputs, savedAt: now() };
      return rewrite(req.user.id, doc, { periods });
    });
    res.json({ loan: L.view(out) });
  } catch (err) { fail(res, err); }
});

app.delete('/api/loans/:id/periods/:period', user, async (req, res) => {
  try {
    const period = Core.cleanPeriod(req.params.period);
    const out = await exclusive(`loan/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadLoan(req);
      const periods = { ...(doc.periods || {}) };
      if (!period || !periods[period]) throw httpError(404, 'No such period.');
      delete periods[period];
      return rewrite(req.user.id, doc, { periods });
    });
    res.json({ loan: L.view(out) });
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Try fewer or smaller photos, or paste the covenants section only.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // COVENANT_DEV_MOUNT=/covenant runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.COVENANT_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`covenant listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
