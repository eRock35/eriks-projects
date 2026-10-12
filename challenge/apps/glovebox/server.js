// Glovebox - know what your car needs next, and what that warning light
// means. See CLAUDE.md.
//
// NOTHING ABOUT ANYONE'S CAR IS STORED HERE. A garage lives on the phone
// that made it (localStorage; receipt photos in IndexedDB), and the page
// runs public/glovebox-core.js itself: the plan, the driving pace, the board,
// the costs, the calendar file and the export are all worked out on the
// phone, and the warning-light finder is a catalogue in the page. A service
// history shared with a buyer travels inside its link's FRAGMENT (the part
// after '#'), which browsers never send to a server. What the server does:
//   - serves the page, the buyer's history page and the service worker;
//   - ONE metered, signed-in model call: "Read my dashboard" or "Read a
//     receipt" - a photo, read once and dropped;
//   - the shared account (sign-in, credit) at /api/auth.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/glovebox-core');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.GLOVEBOX_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('GLOVEBOX_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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
  // The buyer's page: its report is in the fragment, which never travels in
  // a Referer anyway - but the page itself should not be indexed either.
  if (/^\/history(\.html)?$/.test(req.path)) {
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
const READ_ROUTE = /^\/api\/read$/;
const readJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (READ_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'glovebox',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Glovebox',
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
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the warning-light finder and everything else in Glovebox is free and needs no AI.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
  res.json({ limits: Core.LIMITS, items: Core.ITEM_IDS, lights: Core.Lights.LIGHTS.length });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: read a dashboard photo, or a receipt
 * ------------------------------------------------------------------ */

const NOT = {
  dash: 'That doesn’t look like a dashboard to the AI. Try again with the instrument panel filling the photo, engine on so the lights show.',
  receipt: 'That doesn’t look like a car service receipt to the AI. Try again with the whole receipt flat and in focus.',
};

/** Gates, then the 6 MB parser, then the kind and the photo checked (by its
 *  bytes - a 400 costs nothing), then one forced tool, then the answer
 *  cleaned. The photo is read once and dropped; nothing here writes
 *  anything anywhere. */
app.post('/api/read', ...spend, readJson, async (req, res) => {
  try {
    const b = req.body || {};
    const kind = b.kind === 'dash' || b.kind === 'receipt' ? b.kind : null;
    if (!kind) throw httpError(400, 'Read a dashboard or a receipt.');
    const p = photo.validateAll([b.photo])[0];
    const raw = await ai.readPhoto(await clientFor(req), modelFor(req), { kind, photo: p });
    // The phone's date (for "not in the future"), within a day of ours.
    const server = new Date().toISOString().slice(0, 10);
    const today = Core.isDate(b.today) && Math.abs(Core.daysBetween(server, b.today)) <= 1 ? b.today : server;
    const result = kind === 'dash' ? Core.cleanDash(raw) : Core.cleanReceipt(raw, { today });
    if (!result.relevant) throw httpError(422, NOT[kind]);
    res.set('Cache-Control', 'no-store');
    res.json({ kind, result });
  } catch (err) { fail(res, err, 'Could not read that photo right now. Try again in a minute.'); }
});

/* ------------------------------------------------------------------ *
 * The page, the buyer's page and the service worker
 * ------------------------------------------------------------------ */

// The service worker must be re-checked on every load, or a fix would wait
// for its cache to expire. Its scope is this app's base, its own folder.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// The buyer's page. The report is everything after '#', which the browser
// keeps to itself: this route only ever sees "/history".
app.get('/history', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
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
  // GLOVEBOX_DEV_MOUNT=/glovebox runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.GLOVEBOX_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`glovebox listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, fakeCalls: fakeClient ? fakeClient.calls : null };
