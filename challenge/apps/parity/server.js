// Parity - prove the migrated data matches, without it leaving your machine.
// See CLAUDE.md.
//
// NO TABLE EVER REACHES THIS SERVER. Both files are read in the browser, in a
// Web Worker, by public/parity-core.js, and there is no route here that
// accepts a row, a value or a file. What the server does:
//   - serves the page, its worker and its service worker (so the app loads
//     with the network off once it has loaded once);
//   - ONE metered, signed-in model call: "Suggest the mapping and rules",
//     which receives the two tables' shapes only (column names, inferred
//     types, null/empty/distinct counts) and answers with a proposed mapping;
//   - the shared account (sign-in, credit) at /api/auth.
// It stores nothing of its own: no file, no result, no recipe, no answer.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/parity-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.PARITY_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('PARITY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both take a forced tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others. The parse worker
  // and the service worker are files on this origin, which script-src 'self'
  // (and worker-src, which falls back to it) allows.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// The metered route mounts its own 64 KB parser AFTER sign-in, budget and
// the daily cap, so a stranger's body is never read. Everything else: 16 KB
// (nothing here takes more than an account form).
const SUGGEST_ROUTE = /^\/api\/suggest$/;
const suggestJson = express.json({ limit: '64kb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (SUGGEST_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'parity',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Parity',
  mountPath: '/api/auth',
});
identity.mount(app);

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
 * body - and answered with the route's fallback. A provider error is a 502,
 * or 503 when busy; its own text never reaches the page.
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the auto-map is free and needs no AI.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
  res.json({ limits: Core.LIMITS, rules: Core.RULES, dateFormats: Core.DATE_FORMATS, types: Core.TYPES });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: Suggest the mapping and rules
 * ------------------------------------------------------------------ */

/** Gates, then the 64 KB parser, then the shapes rebuilt field by field (a
 *  400 costs nothing), then one forced tool, then the answer checked against
 *  the real column names. Nothing is stored and nothing from the body is
 *  logged. */
app.post('/api/suggest', ...spend, suggestJson, async (req, res) => {
  try {
    const request = ai.cleanRequest((req.body || {}).summary);
    if (!request) throw httpError(400, 'Load both tables first - the suggestion needs both sides\' column names.');
    const raw = await ai.proposeMapping(await clientFor(req), modelFor(req), request);
    const proposal = Core.cleanProposal(raw, request.before.columns.map((c) => c.name), request.after.columns.map((c) => c.name));
    if (!proposal) throw httpError(422, 'That answer had nothing usable in it. Try again - the auto-map is free.');
    res.set('Cache-Control', 'no-store');
    res.json({ proposal, sent: request });
  } catch (err) { fail(res, err, 'Could not suggest a mapping right now. Try again in a minute - the auto-map is free.'); }
});

/* ------------------------------------------------------------------ *
 * The page, its worker and its service worker
 * ------------------------------------------------------------------ */

// The service worker must be re-checked on every load, or a fix would wait
// for its cache to expire. Its scope is this app's base, its own folder.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

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
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // PARITY_DEV_MOUNT=/parity runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.PARITY_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`parity listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, fakeCalls: fakeClient ? fakeClient.calls : null };
