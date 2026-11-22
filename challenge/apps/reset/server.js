// Reset - every rate reset worked out from the note: new rate, new payment,
// which cap bit. A REBUILD of the 2026-11-13 drop. See CLAUDE.md.
//
// THE PAGE DOES THE WORK, ON THE PHONE. The new rate (index + margin,
// rounding, the first-change, periodic and lifetime caps, floor and
// ceiling), the payment amortised in exact cents, the working, future
// resets under a what-if index, the batch from a CSV and the draft notice
// are all worked out in the browser by public/reset-core.js and kept there
// (public/reset-store.js). Loans go by a NICKNAME only. What the server does:
//
//   - serves the page and its service worker;
//   - signed in (free): keeps one book of loans in the account so two
//     phones stay in step - filed under an HMAC of the account id, saved
//     only against the version the phone last saw (a 409 carries the
//     account's copy for the phone to merge), and refused whole if anything
//     in it has an unknown field, an @, nine digits in a row, an
//     account-like number, a person's name, a link, markup, or too much;
//   - ONE metered, signed-in model call: "Read the note", sent one or two
//     photos of the note's rate-change section (shrunk on the phone, checked
//     here by their bytes) or that section pasted - and nothing else;
//   - the shared account (sign-in, credit) at /api/auth.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/reset-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.RESET_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('RESET_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. The call forces its tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const LIMITS = {
  writes: 120,                       // book saves per account...
  writesWindowMs: 10 * 60 * 1000,    // ...in 10 minutes
};

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

// Writes come from this app's own page: a JSON body, and never a request a
// browser marks as coming from another site. (The shared account's routes
// check the same for themselves.)
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth/')) return next();
  const site = String(req.get('sec-fetch-site') || '');
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'That came from another site.' });
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch (e) { ok = false; }
    if (!ok) return res.status(403).json({ error: 'That came from another site.' });
  }
  if (req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  return next();
});

// The routes that take a body mount their own parser AFTER the sign-in check
// (and, for the model call, after budget and the daily cap), so a stranger's
// body is never read. Everything else: 16 KB.
const syncJson = express.json({ limit: '1mb' });
const termsJson = express.json({ limit: '5mb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(sync|ai\/terms)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (sync and the AI need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'reset',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Reset',
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
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - typing the terms in always works.' : fallback), ...(mine && err.code ? { code: err.code } : {}), ...(mine && err.problems ? { problems: err.problems } : {}) } };
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
  res.json({ limits: Core.LIMITS, rounding: Core.ROUNDS, rules: Core.RULES });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free: one book of loans follows the account.
 *
 *   books/<tag> = {owner: tag, book, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret ("reset owner v1") - never the id or the email. A body is refused
 * whole (400, nothing saved) for an unknown field anywhere, a string with an
 * @ (any width), nine digits in a row (any script), a link, markup, an
 * invisible character, a nickname with an account-like digit run or what
 * reads as a person's name, a rate or an amount that is not a whole number
 * of units, anything out of range, more than 500 loans; about 400 KB as
 * stored. Photos and pasted note text never come here.
 * ------------------------------------------------------------------ */

const writes = identityLib.createLimiter({ max: LIMITS.writes, windowMs: LIMITS.writesWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('reset owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Keeping your loans in the account isn’t available right now. Everything is still on this phone.');
  if (write && !writes.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - everything is still on this phone.');
  return ownerTag(req.user.id, SECRET());
}
function out(doc) {
  if (!doc || !doc.book) return { data: null, updatedAt: null };
  return { data: Core.cleanBook(doc.book).book, updatedAt: Number(doc.updatedAt) || 0 };
}

app.get('/api/sync', identity.requireUser, route('Could not load your loans.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(out(await store.get('books', tagOf(req, false))));
}));

/** Save the book. `base` is the account copy's updatedAt this phone last
 *  saw (null for one it has never saved): if the account has moved on since,
 *  the answer is 409 with the account's copy, and the phone merges the two
 *  and saves again. */
app.put('/api/sync', identity.requireUser, syncJson, route('Could not save your loans. They are still on this phone.', async (req, res) => {
  const tag = tagOf(req, true);
  const b = req.body || {};
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'data' && k !== 'base')) throw httpError(400, 'Send the book of loans and its base, nothing else.');
  const raw = b.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the book of loans.');
  const problem = Core.bodyProblem(raw);
  if (problem) throw httpError(400, 'That was not saved: ' + problem.charAt(0).toLowerCase() + problem.slice(1), { code: 'personal' });
  const { book, errors } = Core.cleanBook(raw, true);
  if (errors.length) throw httpError(400, 'That was not saved: ' + errors[0], { problems: errors.slice(0, 10) });
  if (Buffer.byteLength(JSON.stringify(book)) > Core.LIMITS.storedBytes) throw httpError(413, 'That is more than Reset keeps in an account (about 400 KB). Everything is still on this phone.');
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('books', tag, (cur) => {
    if (cur && Number(cur.updatedAt) !== base) { conflict = { doc: cur }; return undefined; }
    if (!cur && base !== null) { conflict = { removed: true }; return undefined; }
    const now = Math.max(Date.now(), (cur && Number(cur.updatedAt) + 1) || 0);
    saved = { owner: tag, book, updatedAt: now };
    return saved;
  });
  res.set('Cache-Control', 'no-store');
  if (conflict && conflict.removed) return res.status(409).json({ error: 'Your loans were removed from the account on another phone.', code: 'removed', data: null, updatedAt: null });
  if (conflict) return res.status(409).json({ error: 'Your other phone changed the loans.', code: 'conflict', ...out(conflict.doc) });
  res.json(out(saved));
}));

app.delete('/api/sync', identity.requireUser, route('Could not remove it.', async (req, res) => {
  const tag = tagOf(req, true);
  await store.transact('books', tag, () => null);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Read the note"
 *
 * Gates, then the route's own parser, then the request rebuilt to the
 * photos alone or the pasted section alone (each photo checked by its
 * bytes, the text by the same door as a nickname's and more; a 400 costs
 * nothing), then one forced tool with no field for a person, a loan number
 * or an amount, then the answer checked. Nothing here writes to the store,
 * and nothing logged carries a word of it.
 * ------------------------------------------------------------------ */

app.post('/api/ai/terms', ...spend, termsJson, route('Reading a note isn’t available right now. Typing the terms in always works.', async (req, res) => {
  const brief = ai.brief(req.body);
  const raw = await ai.ask(await clientFor(req), modelFor(req), brief);
  res.set('Cache-Control', 'no-store');
  res.json(ai.answer(raw));
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
  // RESET_DEV_MOUNT=/reset runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.RESET_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`reset listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, ownerTag, LIMITS };
