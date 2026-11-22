// Punch - walk the job, pin every fix on a photo, close it out with a
// before-and-after the client signs. A REBUILD of the 2026-11-17 drop. See
// CLAUDE.md.
//
// THE PAGE DOES THE WORK, ON THE PHONE. Jobs, areas, the numbered pins on
// each photo, open -> fixed -> verified, the lists by trade, the signing pad
// and the printable closeout are all worked out in the browser by
// public/punch-core.js and kept there (public/punch-store.js). EVERY PHOTO
// AND SIGNATURE STAYS ON THE PHONE. What the server does:
//
//   - serves the page and its service worker;
//   - signed in (free): keeps the punch lists' TEXT in the account so two
//     phones on one job stay in step - filed under an HMAC of the account
//     id, saved only against the version the phone last saw (a 409 carries
//     the account's copy, and the phone merges it pin by pin), and refused
//     whole if anything in it has an unknown field, an @, nine digits in a
//     row, a link, markup, an invisible character, a picture, or too much;
//   - the shared account (sign-in) at /api/auth.
//
// NO MODEL CALL. Nothing here a model would do better than the person
// walking the job: they see the fix, they type it. No location either.

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/punch-core');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
// Punch makes no model call, but the lab host sets <SLUG>_FAKE_AI=1 for
// every app on a local run; like every sibling, it is refused on Cloud Run.
const FAKE_AI = process.env.PUNCH_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('PUNCH_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

const LIMITS = {
  writes: 120,                       // saves per account...
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

// The sync mounts its own parser AFTER the sign-in check, so a stranger's
// body is never read. Everything else: 16 KB.
const syncJson = express.json({ limit: '2mb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (req.path === '/api/sync' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (only the sync needs it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'punch',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Punch',
  mountPath: '/api/auth',
});
identity.mount(app);

/* ------------------------------------------------------------------ *
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body - and answered with the route's fallback.
 * ------------------------------------------------------------------ */

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status; e.expose = true;
  if (extra) Object.assign(e, extra);
  return e;
}
function fail(res, err, fallback = 'Something went wrong.') {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error');
  const body = { error: mine ? err.message : fallback };
  if (mine && err.code) body.code = err.code;
  if (mine && err.problems) body.problems = err.problems;
  res.status(mine ? err.status : 500).json(body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, states: Core.STATES, priorities: Core.PRIS, trades: Core.TRADES });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free: the punch lists follow the account.
 *
 *   books/<tag> = {owner: tag, book, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret ("punch owner v1") - never the id or the email. A body is refused
 * whole (400, nothing saved) for an unknown field anywhere, a string with an
 * @ (any width), nine digits in a row (any script), a link, markup, an
 * invisible character, a data URL or base64 (a photo or a signature has no
 * business here), a phone number in a note, anything out of range or out of
 * shape; about 900 KB as stored. The merge is the phone's: a 409 hands it
 * the account's copy, and PunchCore.merge joins the two pin by pin.
 * ------------------------------------------------------------------ */

const writes = identityLib.createLimiter({ max: LIMITS.writes, windowMs: LIMITS.writesWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('punch owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Keeping your jobs in the account isn’t available right now. Everything is still on this phone.');
  if (write && !writes.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - everything is still on this phone.');
  return ownerTag(req.user.id, SECRET());
}
function out(doc) {
  if (!doc || !doc.book) return { data: null, updatedAt: null };
  return { data: Core.cleanBook(doc.book).book, updatedAt: Number(doc.updatedAt) || 0 };
}

app.get('/api/sync', identity.requireUser, route('Could not load your jobs.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(out(await store.get('books', tagOf(req, false))));
}));

/** Save the book. `base` is the account copy's updatedAt this phone last
 *  saw (null for one it has never saved): if the account has moved on since,
 *  the answer is 409 with the account's copy, and the phone merges the two
 *  and saves again. */
app.put('/api/sync', identity.requireUser, syncJson, route('Could not save your jobs. They are still on this phone.', async (req, res) => {
  const tag = tagOf(req, true);
  const b = req.body || {};
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'data' && k !== 'base')) throw httpError(400, 'Send the jobs and their base, nothing else.');
  const raw = b.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the jobs.');
  const problem = Core.bodyProblem(raw);
  if (problem) throw httpError(400, 'That was not saved: ' + problem.charAt(0).toLowerCase() + problem.slice(1), { code: 'personal' });
  const { book, errors } = Core.cleanBook(raw, true);
  if (errors.length) throw httpError(400, 'That was not saved: ' + errors[0], { problems: errors.slice(0, 10) });
  if (Buffer.byteLength(JSON.stringify(book)) > Core.LIMITS.storedBytes) throw httpError(413, 'That is more than Punch keeps in an account (about 900 KB). Remove an old job - everything is still on this phone.');
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
  if (conflict && conflict.removed) return res.status(409).json({ error: 'Your jobs were removed from the account on another phone.', code: 'removed', data: null, updatedAt: null });
  if (conflict) return res.status(409).json({ error: 'Your other phone changed a job.', code: 'conflict', ...out(conflict.doc) });
  res.json(out(saved));
}));

app.delete('/api/sync', identity.requireUser, route('Could not remove it.', async (req, res) => {
  const tag = tagOf(req, true);
  await store.transact('books', tag, () => null);
  res.json({ ok: true });
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
  // PUNCH_DEV_MOUNT=/punch runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.PUNCH_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`punch listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}`));
}

module.exports = { app, identity, identityStore, store, ownerTag, LIMITS };
