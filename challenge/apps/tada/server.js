// Tada - morning and bedtime routines a child taps through. See CLAUDE.md.
//
// Everything a family does with Tada happens on the device: the children,
// their routines, kid mode, the stickers, the clocks-change plan, the
// printed chart and the calendar file. Signed out, nothing is sent here at
// all. What the server does:
//
//   - serves the page and its service worker;
//   - signed in (free): keeps the family (children, routines and
//     settings) under an HMAC of the account id, so a parent's phone and the
//     family tablet share it - whole-document writes with a version, and a
//     409 when another device saved first;
//   - signed in (free): today's taps, ONE KEY per (child, day, step) merged
//     in, so two devices tapping at once both stick; 14 days kept;
//   - TWO metered, signed-in model calls: "Build my routine from a
//     sentence" and "Make this step a game" - told no child's name;
//   - the shared account (sign-in, credit) at /api/auth.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, DELETE, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/tada-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.TADA_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('TADA_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both take a forced tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const LIMITS = {
  familyWrites: 120,                 // family saves per account...
  familyWindowMs: 10 * 60 * 1000,    // ...in 10 minutes
  progressWrites: 600,               // tap batches per account...
  progressWindowMs: 10 * 60 * 1000,  // ...in 10 minutes
  familyBytes: Core.LIMITS.familyBytes,
  tapsPerRequest: Core.LIMITS.tapsPerRequest,
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

// Each route that takes a body of its own mounts its parser AFTER the sign-in
// check (and, for the model calls, after budget and the daily cap), so a
// stranger's body is never read. Everything else: 16 KB.
const familyJson = express.json({ limit: '96kb' });
const progressJson = express.json({ limit: '32kb' });
const aiJson = express.json({ limit: '8kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(family|progress|ai\/routine|ai\/game)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (sync and the AI need it; nothing else does)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'tada',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Tada',
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
 * body: a family's routines and children are their own business - and
 * answered with the route's fallback. A provider error is a 502, or 503
 * when busy.
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the templates and the editor still work without it.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
  res.json({ limits: Core.LIMITS, templates: Core.TEMPLATES.map((t) => ({ id: t.id, name: t.name, kind: t.kind })) });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free: the family follows the account to the family tablet.
 *
 *   families/<tag> = {owner: tag, family, version, updatedAt}
 *   progress/<tag> = {owner: tag, steps: {<day>: {<c_r_s>: ms}}, fin: {...}}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret - never the id or the email.
 * ------------------------------------------------------------------ */

const familyWrites = identityLib.createLimiter({ max: LIMITS.familyWrites, windowMs: LIMITS.familyWindowMs });
const progressWrites = identityLib.createLimiter({ max: LIMITS.progressWrites, windowMs: LIMITS.progressWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('tada family owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, limiter) {
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Everything is still on this device.');
  if (limiter && !limiter.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - it’s all still on this device.');
  return ownerTag(req.user.id, SECRET());
}
/** The server's own idea of today (UTC), to bound the day a device sends. */
function serverDay() { return new Date().toISOString().slice(0, 10); }
function todayFrom(v) {
  const d = String(v || '');
  if (!Core.isDay(d) || Math.abs(Core.daysBetween(serverDay(), d)) > 1) throw httpError(400, 'Send today’s date as YYYY-MM-DD.');
  return d;
}
function familyOut(doc) {
  if (!doc || !doc.family) return null;
  return Core.cleanFamily(doc.family);
}

app.get('/api/family', identity.requireUser, route('Could not load your family.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await store.get('families', tagOf(req));
  res.json({ family: familyOut(doc), version: doc ? Number(doc.version) || 0 : null });
}));

/** Save the whole family. `base` is the account copy's version this device
 *  last saw: if another device saved since, the answer is 409 with the
 *  account's copy, and the page asks "use theirs / keep mine". */
app.put('/api/family', identity.requireUser, familyJson, route('Could not save that. It is still on this device.', async (req, res) => {
  const tag = tagOf(req, familyWrites);
  const b = req.body || {};
  if (!b.family || typeof b.family !== 'object' || Array.isArray(b.family)) throw httpError(400, 'Send the family.');
  const family = Core.cleanFamily(b.family);
  if (!family || !family.children.length) throw httpError(400, 'Add a child first.');
  if (Core.familyBytes(family) > LIMITS.familyBytes) throw httpError(413, 'That is too much to keep in one family. Remove a routine or two.');
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('families', tag, (cur) => {
    if (cur && Number(cur.version) !== base) { conflict = cur; return undefined; }
    const version = (cur ? Number(cur.version) || 0 : 0) + 1;
    const now = Date.now();
    saved = { owner: tag, family: { ...family, updatedAt: now }, version, updatedAt: now };
    return saved;
  });
  res.set('Cache-Control', 'no-store');
  if (conflict) return res.status(409).json({ error: 'Your family changed on another device.', code: 'conflict', family: familyOut(conflict), version: Number(conflict.version) || 0 });
  res.json({ family: familyOut(saved), version: saved.version });
}));

/** Forget the account's copy (this device keeps its own). */
app.delete('/api/family', identity.requireUser, route('Could not clear it.', async (req, res) => {
  const tag = tagOf(req, familyWrites);
  await store.remove('families', tag);
  await store.remove('progress', tag);
  res.json({ ok: true });
}));

app.get('/api/progress', identity.requireUser, route('Could not load today.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const today = todayFrom(req.query.today);
  const doc = await store.get('progress', tagOf(req));
  res.json({ progress: Core.cleanProgress(doc, today) });
}));

/**
 * Taps, merged in one key at a time: {today, taps: [{day, c, r, s, v}] or
 * [{day, c, r, fin}]}. Never a read-and-write of the whole document, so a
 * tablet and a phone tapping at the same moment both stick. Days outside
 * the window (14 days of taps, 400 of stickers) are deleted in the same
 * write.
 */
app.post('/api/progress', identity.requireUser, progressJson, route('Could not save that tap. It is still on this device.', async (req, res) => {
  const tag = tagOf(req, progressWrites);
  const b = req.body || {};
  const today = todayFrom(b.today);
  if (!Array.isArray(b.taps) || !b.taps.length) throw httpError(400, 'Send at least one tap.');
  if (b.taps.length > LIMITS.tapsPerRequest) throw httpError(400, `At most ${LIMITS.tapsPerRequest} taps at a time.`);
  const latest = Date.now() + 86400000;
  const taps = b.taps.map((t) => Core.cleanTap(t, today)).filter((t) => t && Math.abs(t.fin !== undefined ? t.fin : t.v) <= latest);
  if (!taps.length) throw httpError(400, 'None of those taps could be read.');
  const patch = { owner: tag, steps: {}, fin: {}, updatedAt: Date.now() };
  for (const t of taps) {
    if (t.fin !== undefined) (patch.fin[t.day] = patch.fin[t.day] || {})[Core.finKey(t.c, t.r)] = t.fin;
    else (patch.steps[t.day] = patch.steps[t.day] || {})[Core.tapKey(t.c, t.r, t.s)] = t.v;
  }
  // Which old days to drop: a plain read (not a transaction - deleting a
  // stale day twice is harmless, and the new keys never depend on it).
  const cur = await store.get('progress', tag);
  const lo = Core.addDays(today, -(Core.LIMITS.progressDays - 1));
  const loFin = Core.addDays(today, -(Core.LIMITS.finDays - 1));
  for (const day of Object.keys((cur && cur.steps) || {})) if (day < lo && !patch.steps[day]) patch.steps[day] = DELETE;
  for (const day of Object.keys((cur && cur.fin) || {})) if (day < loFin && !patch.fin[day]) patch.fin[day] = DELETE;
  await store.mergeDeep('progress', tag, patch);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, applied: taps.length });
}));

/* ------------------------------------------------------------------ *
 * Metered: build a routine from a sentence, make a step a game
 * ------------------------------------------------------------------ */

/** The family's own names, when the account has synced them: taken out of
 *  anything sent to a model, on top of what the page already replaced. */
async function familyNames(req) {
  if (!SECRET()) return [];
  const doc = await store.get('families', ownerTag(req.user.id, SECRET()));
  const f = familyOut(doc);
  return f ? f.children.map((c) => c.name).filter(Boolean) : [];
}

/** Gates, then the parser, then the request rebuilt field by field (a 400
 *  costs nothing), then one forced tool, then the answer checked. Nothing
 *  here writes to the store, and nothing logged carries a word of it. */
function metered(kind, fallback) {
  return route(fallback, async (req, res) => {
    const b = ai.brief(kind, req.body, await familyNames(req));
    const raw = await ai.ask(await clientFor(req), modelFor(req), kind, b);
    res.set('Cache-Control', 'no-store');
    res.json({ ...ai.answer(kind, raw, b), stripped: b.stripped });
  });
}
app.post('/api/ai/routine', ...spend, aiJson, metered('routine', 'Building a routine isn’t available right now. Try again in a minute - the templates are free.'));
app.post('/api/ai/game', ...spend, aiJson, metered('game', 'Game ideas aren’t available right now. Try again in a minute.'));

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
  // TADA_DEV_MOUNT=/tada runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.TADA_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`tada listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, ownerTag, LIMITS };
