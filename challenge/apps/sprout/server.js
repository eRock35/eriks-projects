// Sprout - know which plants need you today, and hand them to a plant-sitter
// in one link. See CLAUDE.md.
//
// NOTHING ABOUT ANYONE'S PLANTS IS STORED HERE. A jungle lives on the phone
// that made it (localStorage; diary photos in IndexedDB), and the page runs
// public/sprout-core.js itself: the board, the learning, the seasons, the
// streaks, the calendar file and the export are all worked out on the
// phone. A plant-sitter's care sheet travels inside its link's FRAGMENT
// (the part after '#'), which browsers never send to a server. What the
// server does:
//   - serves the page, the sitter's page and the service worker;
//   - ONE metered, signed-in model call: "What plant is this? / What's
//     wrong with it?" - a photo, read once and dropped;
//   - the shared account (sign-in, credit) at /api/auth.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/sprout-core');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.SPROUT_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('SPROUT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // The sitter's page: its plan is in the fragment, which never travels in
  // a Referer anyway - but the page itself should not be indexed either.
  if (/^\/sit(\.html)?$/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The metered route mounts its own 6 MB parser AFTER sign-in, budget and the
// daily cap, so a stranger's photo is never read. Everything else: 16 KB
// (nothing else here takes more than an account form).
const LOOK_ROUTE = /^\/api\/look$/;
const lookJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (LOOK_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'sprout',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Sprout',
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
 * body or a photo - and answered with the route's fallback. A provider
 * error is a 502, or 503 when busy; its own text never reaches the page.
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - everything else in Sprout is free and needs no AI.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
  res.json({ limits: Core.LIMITS, catalogue: Core.CATALOGUE.length, rooms: Core.ROOM_IDS });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: "What plant is this? / What's wrong with it?"
 * ------------------------------------------------------------------ */

/** Gates, then the 6 MB parser, then the photo checked by its bytes (a 400
 *  costs nothing), then one forced tool, then the answer cleaned. The photo
 *  is read once and dropped; nothing here writes anything anywhere. */
app.post('/api/look', ...spend, lookJson, async (req, res) => {
  try {
    const b = req.body || {};
    const p = photo.validateAll([b.photo])[0];
    const hint = Core.catalogue(b.hint) ? b.hint : null;
    const raw = await ai.lookAtPlant(await clientFor(req), modelFor(req), { photo: p, hint });
    const result = Core.cleanLook(raw);
    if (!result.relevant) throw httpError(422, 'That doesn’t look like a plant to the AI. Try again with the plant filling the photo, in daylight.');
    res.set('Cache-Control', 'no-store');
    res.json({ result });
  } catch (err) { fail(res, err, 'Could not look at that photo right now. Try again in a minute.'); }
});

/* ------------------------------------------------------------------ *
 * The page, the sitter's page and the service worker
 * ------------------------------------------------------------------ */

// The service worker must be re-checked on every load, or a fix would wait
// for its cache to expire. Its scope is this app's base, its own folder.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// The sitter's page. Its plan is everything after '#', which the browser
// keeps to itself: this route only ever sees "/sit".
app.get('/sit', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sit.html'));
});

const INDEX = path.join(__dirname, 'public', 'index.html');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That photo is too big to send. The page shrinks photos first - try again from there.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // SPROUT_DEV_MOUNT=/sprout runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.SPROUT_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`sprout listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, fakeCalls: fakeClient ? fakeClient.calls : null };
