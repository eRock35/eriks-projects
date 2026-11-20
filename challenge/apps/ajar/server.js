// Ajar - one little door a day to the big day, planned around your real
// week. See CLAUDE.md.
//
// THE PAGE DOES THE WORK, ON THE PHONE. Setting up a countdown, choosing
// from the deck, the plan and its reasons, the shopping list, the doors,
// kid mode, the printed cards and the recap are all worked out in the
// browser by public/ajar-core.js and kept there (public/ajar-store.js).
// Photos of done doors never leave the phone that took them - there is no
// route that takes one. What the server does:
//
//   - serves the page and its service worker;
//   - signed in (free): keeps up to three countdowns in the account so two
//     grown-ups' phones stay in step - filed under an HMAC of the account
//     id, saved only against the version the phone last saw (a 409 carries
//     the account's copy for the phone to merge), and refused whole if
//     anything in it has an unknown field, an @, nine digits in a row, a
//     link, markup or too much of anything;
//   - ONE metered, signed-in model call: "More ideas for us", sent the
//     theme, the month, the kids' AGES, the chips picked, the budget word,
//     how many, and the built-in deck ids already chosen - never a name and
//     never a title the family typed - and refused before any call if the
//     body carries anything else;
//   - the shared account (sign-in, credit) at /api/auth.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/ajar-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.AJAR_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('AJAR_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. The call forces its tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const LIMITS = {
  writes: 120,                       // countdown saves per account...
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
const countdownJson = express.json({ limit: Core.LIMITS.bodyBytes });
const aiJson = express.json({ limit: '16kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(countdowns\/[^/]+|ai\/ideas)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (sync and the AI need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'ajar',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Ajar',
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
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the built-in deck is free.' : fallback), ...(mine && err.code ? { code: err.code } : {}), ...(mine && err.problems ? { problems: err.problems } : {}) } };
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
  res.json({ limits: Core.LIMITS, themes: Core.THEMES, likes: Core.LIKES, times: Core.TIMES, costs: Core.COSTS, wheres: Core.WHERES, messes: Core.MESSES, deck: Core.DECK.length });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free: the countdowns follow the account.
 *
 *   calendars/<tag> = {owner: tag, countdowns: {<id>: countdown}, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret - never the id or the email. Up to three countdowns. A body is
 * refused whole (400, nothing saved) for an unknown field anywhere, a
 * string with an @ (any width), nine digits in a row, a link or markup, or
 * anything over its limit. Photos are never here: no route takes one.
 * ------------------------------------------------------------------ */

const writes = identityLib.createLimiter({ max: LIMITS.writes, windowMs: LIMITS.writesWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('ajar owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Keeping countdowns in the account isn’t available right now. Yours is still on this phone.');
  if (write && !writes.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - everything is still on this phone.');
  return ownerTag(req.user.id, SECRET());
}
function out(cd) {
  if (!cd) return null;
  const c = Core.cleanCountdown(cd).countdown;
  c.updatedAt = Number(cd.updatedAt) || 0;
  return c;
}
const idOk = (id) => Core.ID.cd.test(String(id || ''));

app.get('/api/countdowns', identity.requireUser, route('Could not load your countdowns.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await store.get('calendars', tagOf(req, false));
  const all = doc && doc.countdowns && typeof doc.countdowns === 'object' ? Object.values(doc.countdowns) : [];
  res.json({ countdowns: all.map(out).filter((c) => c && c.id).sort((a, b) => b.updatedAt - a.updatedAt), max: Core.LIMITS.countdowns });
}));

/** Save one countdown. `base` is the account copy's updatedAt this phone
 *  last saw (null for one it has never saved): if the account has moved on
 *  since, the answer is 409 with the account's copy, and the phone merges
 *  the two and saves again. */
app.put('/api/countdowns/:id', identity.requireUser, countdownJson, route('Could not save your countdown. It is still on this phone.', async (req, res) => {
  const tag = tagOf(req, true);
  const id = req.params.id;
  if (!idOk(id)) throw httpError(404, 'Not found.');
  const b = req.body || {};
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'countdown' && k !== 'base')) throw httpError(400, 'Send the countdown and its base, nothing else.');
  if (Buffer.byteLength(JSON.stringify(b)) > Core.LIMITS.bodyBytes) throw httpError(413, 'That is too much to send at once.');
  const raw = b.countdown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the countdown.');
  const problem = Core.bodyProblem(raw);
  if (problem) throw httpError(400, 'That was not saved: ' + problem.charAt(0).toLowerCase() + problem.slice(1), { code: 'personal' });
  const { countdown, errors } = Core.cleanCountdown(raw, true);
  if (errors.length) throw httpError(400, 'That was not saved: ' + errors[0], { problems: errors.slice(0, 10) });
  if (countdown.id !== id) throw httpError(400, 'That countdown’s id does not match.');
  delete countdown.updatedAt;
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('calendars', tag, (cur) => {
    const all = cur && cur.countdowns && typeof cur.countdowns === 'object' ? cur.countdowns : {};
    const have = all[id];
    if (have && Number(have.updatedAt) !== base) { conflict = { countdown: have }; return undefined; }
    if (!have && base !== null) { conflict = { countdown: null, removed: true }; return undefined; }
    if (!have && Object.keys(all).length >= Core.LIMITS.countdowns) { conflict = { full: true }; return undefined; }
    const now = Math.max(Date.now(), (have && Number(have.updatedAt) + 1) || 0, (cur && Number(cur.updatedAt) + 1) || 0);
    saved = { ...countdown, updatedAt: now };
    return { owner: tag, countdowns: { ...all, [id]: saved }, updatedAt: now };
  });
  res.set('Cache-Control', 'no-store');
  if (conflict && conflict.full) return res.status(409).json({ error: `Your account keeps up to ${Core.LIMITS.countdowns} countdowns. Remove one to keep this one there too - it stays on this phone either way.`, code: 'full' });
  if (conflict && conflict.removed) return res.status(409).json({ error: 'This countdown was removed from your account on another phone.', code: 'removed', countdown: null });
  if (conflict) return res.status(409).json({ error: 'Your other phone changed this countdown.', code: 'conflict', countdown: out(conflict.countdown) });
  res.json({ countdown: out(saved) });
}));

app.delete('/api/countdowns/:id', identity.requireUser, route('Could not remove it.', async (req, res) => {
  const tag = tagOf(req, true);
  const id = req.params.id;
  if (!idOk(id)) throw httpError(404, 'Not found.');
  await store.transact('calendars', tag, (cur) => {
    if (!cur || !cur.countdowns || !cur.countdowns[id]) return undefined;
    const rest = { ...cur.countdowns };
    delete rest[id];
    if (!Object.keys(rest).length) return null;
    return { ...cur, countdowns: rest, updatedAt: Math.max(Date.now(), Number(cur.updatedAt) + 1 || 0) };
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "More ideas for us"
 *
 * Gates, then the route's own small parser, then the request rebuilt to
 * exactly {theme, month, ages, likes, budget, count, avoid} (a 400 costs
 * nothing - including a name where an age goes or an id that is not the
 * deck's), then one forced tool, then the answer checked. Nothing here
 * writes to the store, and nothing logged carries a word of it.
 * ------------------------------------------------------------------ */

app.post('/api/ai/ideas', ...spend, aiJson, route('Ideas aren’t available right now. The built-in deck is free.', async (req, res) => {
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
  // AJAR_DEV_MOUNT=/ajar runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.AJAR_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`ajar listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, ownerTag, LIMITS };
