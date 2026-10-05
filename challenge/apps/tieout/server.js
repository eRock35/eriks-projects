// Tieout - any bank statement PDF to a clean CSV, proven to tie out to the
// penny. See CLAUDE.md.
//
// A model is used for ONE thing: reading a statement (and, when one page came
// out wrong, reading that page again). Everything else - the tie-out checks
// that name the wrong row, the review table, the fixes, reading a bank CSV,
// the merged export and its four formats, the two examples - is
// public/tieout-core.js in the browser: free, with or without an account.
//
// NOTHING IS STORED. The PDF or photos are read once by the model inside one
// request and dropped; the rows go back to the page and live in that browser
// only. No collection of Tieout's own exists. Nothing logged carries a
// figure, a description or a byte of a file.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/tieout-core');
const ai = require('./lib/ai');
const files = require('./lib/files');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.TIEOUT_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('TIEOUT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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

// Two routes carry a file, and each mounts its own 30 MB parser AFTER its
// gates (sign-in, budget, the daily cap), so a stranger's body is never read.
// Everything else keeps a 64 KB limit.
const FILE_ROUTE = /^\/api\/(read|reread)$/;
const fileJson = express.json({ limit: '30mb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => (FILE_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'tieout',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Tieout',
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
 * Errors
 * ------------------------------------------------------------------ */

const httpError = files.httpError;

// Only the app's own errors (marked `expose`) reach the client with their
// status and words. Anything else is logged - its stack's first lines only,
// never a body: a statement carries someone's money - and answered with the
// route's fallback. An upstream failure (the SDK's errors carry a `.status`
// and a raw body of their own) is a 502, or 503 when the provider is
// overloaded or rate-limited.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - your statement was not kept, so send it again.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, stores: 'nothing' }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, types: Core.TYPES, currencies: Core.CURRENCIES, formats: Object.keys(Core.FORMATS) });
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
 * Metered: read a statement, or one page of it again
 * ------------------------------------------------------------------ */

/**
 * {pdf: {data}} or {photos: [{type, data}]}, plus `name` (the file's name,
 * shown as a label). Gates, then the 30 MB parser, then the file checks
 * (400s cost nothing) - and only then the whitespace stream (a 15-page
 * statement can take a minute or two, which drops an idle phone connection),
 * after which a failure is a 200 {error}. The file is read once and dropped.
 */
app.post('/api/read', ...spend, fileJson, async (req, res) => {
  let input;
  try { input = files.readInput(req.body); } catch (err) { return fail(res, err); }
  const name = Core.text((req.body || {}).name, Core.LIMITS.name);
  const send = streamedJson(res);
  try {
    const raw = await ai.readStatement(await clientFor(req), modelFor(req), input);
    const out = Core.fromModel(raw, { src: input.kind, name, at: new Date().toISOString() });
    if (!out) throw httpError(422, input.kind === 'pdf' ? 'That doesn’t look like a bank or card statement - or it can’t be read. Check it’s the statement itself, not a cover letter or a check image.' : 'Those photos don’t look like a statement, or they can’t be read. Try flatter, well-lit shots, one page each.');
    const r = Core.check(out.statement);
    send({ statement: out.statement, notes: out.notes, pages: input.pages || null, result: { status: r.status, headline: r.headline, sub: r.sub } });
  } catch (err) { send(failure(err, 'The reading did not finish. Try again in a minute.').body); }
});

/**
 * The same file again, plus `page` (1-15) and what the page knows that
 * helps: the account type, the year, and the running balance just before
 * the page (all numbers - no text from the browser reaches the prompt).
 * Answers that page's rows; the page puts them in place of the old ones.
 */
app.post('/api/reread', ...spend, fileJson, async (req, res) => {
  let input; let hint;
  try {
    const b = req.body || {};
    const page = Number(b.page);
    if (!Number.isInteger(page) || page < 1 || page > Core.LIMITS.pages) throw httpError(400, `Pick a page from 1 to ${Core.LIMITS.pages}.`);
    input = files.readInput(b);
    if (input.kind === 'pdf' && input.pages && page > input.pages) throw httpError(400, `That PDF has ${input.pages} page${input.pages === 1 ? '' : 's'}.`);
    if (input.kind === 'photo' && input.photos.length > 1 && page > input.photos.length) throw httpError(400, `There ${input.photos.length === 1 ? 'is 1 photo' : `are ${input.photos.length} photos`}.`);
    const before = Number.isInteger(b.before) && Math.abs(b.before) <= Core.LIMITS.maxCents ? b.before : null;
    const year = Number.isInteger(b.year) && b.year >= 1990 && b.year <= 2100 ? b.year : null;
    hint = { page, type: Core.TYPES.includes(b.type) ? b.type : 'checking', year, before, currency: Core.CURRENCIES.includes(b.currency) ? b.currency : 'USD' };
  } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const raw = await ai.readPage(await clientFor(req), modelFor(req), input, hint);
    if (!raw || raw.readable === false) throw httpError(422, `Page ${hint.page} couldn’t be read. Try a photo of just that page - or type the rows in.`);
    const out = Core.pageFromModel(raw, hint.page);
    if (!out) throw httpError(422, `No rows came back from page ${hint.page}. Try a photo of just that page - or type the rows in.`);
    send({ page: hint.page, rows: out.rows, pageTotals: out.pageTotals, notes: out.notes });
  } catch (err) { send(failure(err, 'The re-read did not finish. Try again in a minute.').body); }
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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Tieout reads one statement at a time: a PDF up to 10 MB, or up to 15 photos.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // TIEOUT_DEV_MOUNT=/tieout runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.TIEOUT_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`tieout listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, fake: FAKE_AI ? sharedClient : null };
