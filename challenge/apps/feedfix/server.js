// Feedfix - your bank file imported zero rows? Find out why, and fix it.
// See CLAUDE.md.
//
// THE SERVER NEVER SEES A TRANSACTION. Statement files - CSV, TSV, OFX, QFX,
// QIF - are read, diagnosed, fixed, re-checked and exported in the browser
// by public/feedfix-core.js (in a worker for big files). There is no route
// that takes a file, a row, an amount or a payee - /api/upload, /api/fix,
// /api/diagnose, /api/convert, /api/statement and friends are 404s, tested.
// What the server does:
//
//   - serves the page, its worker and its service worker;
//   - signed in (free): keeps the account's SETTINGS - the default target,
//     a date format per target, named sources with their day/month order,
//     extra summary-row words, a currency - filed under an HMAC of the
//     account id, and refuses settings that carry anything else
//     (FeedfixCore.cleanSettings, strict: unknown fields, oversize lists,
//     anything shaped like an amount, a date, an account number or an
//     address);
//   - ONE metered, signed-in model call: "Help me read these columns", sent
//     each column's header name and SHAPE codes from a fixed list - never a
//     value - and refused if a header holds an @ or a run of 5+ digits;
//   - the shared account (sign-in, credit) at /api/auth.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/feedfix-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.FEEDFIX_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('FEEDFIX_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. The call forces its tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const LIMITS = {
  settingsWrites: 120,               // settings saves per account...
  settingsWindowMs: 10 * 60 * 1000,  // ...in 10 minutes
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others. The worker is a
  // same-origin file, which script-src 'self' allows.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// The routes that take a body mount their own parser AFTER the sign-in check
// (and, for the model call, after budget and the daily cap), so a stranger's
// body is never read. Everything else: 16 KB.
const settingsJson = express.json({ limit: '16kb' });
const aiJson = express.json({ limit: '8kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(settings|ai\/columns)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (settings sync and the AI need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'feedfix',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Feedfix',
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
 * body - and answered with the route's fallback. A provider error is a 502,
 * or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - choosing the columns by hand is free.' : fallback), ...(mine && err.code ? { code: err.code } : {}), ...(mine && err.problems ? { problems: err.problems } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, profiles: Core.PROFILE_KEYS, fields: Core.FIELDS, shapes: Object.keys(Core.SHAPES), currencies: Core.CURRENCIES });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free: the settings follow you.
 *
 *   settings/<tag> = {owner: tag, settings, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret - never the id or the email. The settings hold preferences, never
 * a transaction: cleanSettings(strict) refuses unknown fields (rows, amounts,
 * payees, a file), and any label or word shaped like an amount, a date, an
 * account number or an address.
 * ------------------------------------------------------------------ */

const settingsWrites = identityLib.createLimiter({ max: LIMITS.settingsWrites, windowMs: LIMITS.settingsWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('feedfix owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Saving settings to the account isn’t available right now. They are still on this device.');
  if (write && !settingsWrites.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - your settings are still on this device.');
  return ownerTag(req.user.id, SECRET());
}
function settingsOut(doc) {
  if (!doc || !doc.settings) return null;
  const s = Core.cleanSettings(doc.settings).settings;
  s.updatedAt = Number(doc.updatedAt) || 0;
  return s;
}

app.get('/api/settings', identity.requireUser, route('Could not load your settings.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ settings: settingsOut(await store.get('settings', tagOf(req, false))) });
}));

/** Save the settings. `base` is the account copy's updatedAt this device last
 *  saw: if the account has moved on since (another device saved), the answer
 *  is 409 with the account's copy, and the page offers to merge, take that
 *  copy, or keep this one. */
app.put('/api/settings', identity.requireUser, settingsJson, route('Could not save your settings. They are still on this device.', async (req, res) => {
  const tag = tagOf(req, true);
  const b = req.body || {};
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'settings' && k !== 'base')) throw httpError(400, 'Send the settings and nothing else - never a transaction.');
  const raw = b.settings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the settings.');
  const { settings, errors } = Core.cleanSettings(raw, true);
  if (errors.length) throw httpError(400, 'Those settings were not saved: ' + errors[0], { problems: errors.slice(0, 10) });
  delete settings.updatedAt;
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('settings', tag, (cur) => {
    if (cur && Number(cur.updatedAt) !== base) { conflict = cur; return undefined; }
    const now = Math.max(Date.now(), (cur && Number(cur.updatedAt) + 1) || 0);
    saved = { owner: tag, settings, updatedAt: now };
    return saved;
  });
  res.set('Cache-Control', 'no-store');
  if (conflict) return res.status(409).json({ error: 'Your settings changed on another device.', code: 'conflict', settings: settingsOut(conflict) });
  res.json({ settings: settingsOut(saved) });
}));

app.delete('/api/settings', identity.requireUser, route('Could not remove them.', async (req, res) => {
  await store.remove('settings', tagOf(req, true));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Help me read these columns"
 *
 * Gates, then the parser, then the request rebuilt field by field (a 400
 * costs nothing - including a header that still looks like a value), then
 * one forced tool, then the answer checked. Nothing here writes to the
 * store, and nothing logged carries a word of it.
 * ------------------------------------------------------------------ */

app.post('/api/ai/columns', ...spend, aiJson, route('The column helper isn’t available right now. Choose the columns by hand - it’s free.', async (req, res) => {
  const brief = ai.brief(req.body);
  const raw = await ai.ask(await clientFor(req), modelFor(req), brief);
  res.set('Cache-Control', 'no-store');
  res.json(ai.answer(raw, brief));
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
  // FEEDFIX_DEV_MOUNT=/feedfix runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.FEEDFIX_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`feedfix listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, ownerTag, LIMITS };
