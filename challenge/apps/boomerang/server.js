// Boomerang - lend it, get it back. See CLAUDE.md.
//
// The shelf - what you lent, what you borrowed, when it is due, the nudges,
// the stats, the sample - lives on the phone (localStorage, photos in
// IndexedDB) and is worked out there by public/boomerang-core.js. Nothing
// about it reaches this server unless:
//
//   - you send someone a receipt link (a "handshake"): the item, the two
//     first names as typed, the dates and an optional note are stored under a
//     hash of the link's token, so the friend can open it with no account and
//     tap Got it / I've given it back, and you can tap It's back. No account
//     is needed to make one either;
//   - you are signed in: the shelf is kept in your account so it follows you
//     to another phone (photos never leave the phone that took them);
//   - you tap "Write it for me": the one model call, metered and signed in.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/boomerang-core');
const H = require('./lib/handshakes');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.BOOMERANG_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('BOOMERANG_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A receipt link's token is a key. It must not ride out in a Referer
  // header, and a receipt should never be indexed.
  if (/^\/h\//.test(req.path) || /^\/api\/h(\/|$)/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The metered route mounts its own 8 KB parser AFTER sign-in, budget and the
// daily cap, so a stranger's body is never read; bringing a whole shelf into
// an account mounts 256 KB after sign-in. Everything else 16 KB.
const writeJson = express.json({ limit: '8kb' });
const mergeJson = express.json({ limit: '256kb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => {
  if (req.path === '/api/write' || req.path === '/api/shelf/merge') return next();
  return smallJson(req, res, next);
});

/* ------------------------------------------------------------------ *
 * The shared account (sync and "Write it for me" need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'boomerang',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Boomerang',
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
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body: what someone lent and to whom is nobody's business - and answered
 * with the route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = H.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - the ready-made nudges still work.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address and per instance, in memory: they slow a script,
 * they do not stop a determined one - CLAUDE.md says so.
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
const creates = identityLib.createLimiter({ max: H.LIMITS.createsPerIp, windowMs: H.LIMITS.createsWindowMs });
const createsAll = identityLib.createLimiter({ max: H.LIMITS.createsPerInstance, windowMs: H.LIMITS.createsWindowMs });
const writes = identityLib.createLimiter({ max: H.LIMITS.writesPerIp, windowMs: H.LIMITS.writesWindowMs });
const saves = identityLib.createLimiter({ max: H.LIMITS.savesPerAccount, windowMs: H.LIMITS.savesWindowMs });

// A wrong token counts once per DISTINCT value: a phone left open on a
// revoked receipt asks for the same dead token again, and that is not
// guessing. Guessing needs many different tokens.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > H.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= H.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong links from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
}

/** The viewer's "today" (their phone's day), if it is a real day within a
 *  day of the server's; otherwise the server's own UTC day. */
function todayOf(req) {
  const server = new Date().toISOString().slice(0, 10);
  const t = (req.body && req.body.today) || req.query.today;
  return Core.isDay(t) && Math.abs(Core.daysBetween(server, t)) <= 1 ? t : server;
}

/* ------------------------------------------------------------------ *
 * Who is asking
 * ------------------------------------------------------------------ */

// This browser's device key: an HttpOnly cookie scoped to the app, minted
// the first time it makes a receipt, used only to count its open receipts.
// Stored only as a hash.
const DEVICE_COOKIE = 'boomerang_k';
function readDevice(req) {
  const m = /(?:^|;\s*)boomerang_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintDevice(req, res) {
  const have = readDevice(req);
  if (have) return have;
  const key = H.newKey();
  res.append('Set-Cookie', `${DEVICE_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
/** The owner key of a receipt rides in a header, never in the URL. */
function ownerKey(req) {
  const k = req.get('X-Boomerang-Key');
  return typeof k === 'string' && Core.TOKEN_RE.test(k) ? k : null;
}
function actorOf(doc, req) {
  const k = ownerKey(req);
  return k && H.sameHash(H.ownerHash(k, doc.id), doc.ownerHash) ? 'owner' : 'friend';
}

/** A receipt, if the token names a live one. One past its expiry is
 *  deleted by the read that finds it (there is no timer). Unknown, revoked
 *  and expired all answer the same 404. */
const GONE = 'This receipt isn’t here any more. It may have been taken back, or it expired.';
async function loadHandshake(req) {
  checkMisses(req);
  const token = String(req.params.token || '');
  const id = H.isToken(token) ? H.docId(token) : null;
  const doc = id ? await store.get('handshakes', id) : null;
  if (!doc) { missed(ipKey(req), token.slice(0, 24)); throw httpError(404, GONE); }
  if (Core.expired(doc, Date.now())) { await store.remove('handshakes', doc.id); throw httpError(404, GONE); }
  return doc;
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, tones: Core.TONES, picker: Core.PICKER });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Receipt links: no account to make one, none to open one
 * ------------------------------------------------------------------ */

async function openCount(tag, now) {
  const rows = await store.list('handshakes', { where: [['creator', '==', tag]], limit: H.LIMITS.openPerCreator * 4 });
  return rows.filter((r) => r.state !== 'closed' && !Core.expired(r, now)).length;
}

app.post('/api/h', route('Could not make that receipt.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (creates.blocked(ip)) throw httpError(429, `That’s ${H.LIMITS.createsPerIp} receipts from here this hour. Try again later.`);
  if (createsAll.blocked('all')) throw httpError(429, 'Lots of people are sending receipts right now. Try again in a few minutes.');
  const now = Date.now();
  const doc = Core.newHandshake(req.body, { now, today: todayOf(req) });
  const signedTag = req.user && SECRET() ? `a:${H.accountTag(req.user.id, SECRET())}` : null;
  const creator = signedTag || H.deviceTag(mintDevice(req, res));
  if (await openCount(creator, now) >= H.LIMITS.openPerCreator) throw httpError(429, `You have ${H.LIMITS.openPerCreator} open receipts. Close or take one back first.`);
  const token = H.newToken();
  const key = H.newKey();
  const id = H.docId(token);
  const full = { ...doc, ownerHash: H.ownerHash(key, id), creator };
  await store.transact('handshakes', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return full; });
  creates.hit(ip);
  createsAll.hit('all');
  res.set('Cache-Control', 'no-store');
  res.json({ token, key, h: Core.handshakeView({ ...full, id }, 'owner') });
}));

app.get('/api/h/:token', route('Could not load that receipt.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await loadHandshake(req);
  res.json({ h: Core.handshakeView(doc, actorOf(doc, req)) });
}));

/** One step: confirm (the friend), gave (the borrower), back (the lender).
 *  Read inside a transaction, the core decides, then write - so two taps
 *  at once cannot both move it. */
app.post('/api/h/:token/step', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const doc = await loadHandshake(req);
  const actor = actorOf(doc, req);
  const what = String((req.body || {}).step || '');
  let next = null;
  await store.transact('handshakes', doc.id, (cur) => {
    if (!cur || Core.expired(cur, Date.now())) throw httpError(404, GONE);
    const patch = Core.step(cur, actor, what, Date.now());
    next = { ...cur, ...patch };
    return next;
  });
  res.set('Cache-Control', 'no-store');
  res.json({ h: Core.handshakeView(next, actor) });
}));

/** The owner takes the link back: deleted, and from then on the same 404
 *  as a link that never existed. Anyone else gets that 404 now. */
app.delete('/api/h/:token', route('Could not take that back.', async (req, res) => {
  countWrite(req);
  const doc = await loadHandshake(req);
  if (actorOf(doc, req) !== 'owner') throw httpError(404, GONE);
  await store.remove('handshakes', doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Signed in, free: the shelf follows you to another phone
 * ------------------------------------------------------------------ */

function shelfTag(req) {
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Your shelf is safe on this phone.');
  if (!saves.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - it’s all still on this phone.');
  return H.accountTag(req.user.id, SECRET());
}
/** A stored shelf, cleaned on the way out too. */
function shelfView(doc, today) {
  const loans = Object.values((doc && doc.loans) || {}).map((l) => Core.cleanLoan(l, today)).filter(Boolean).map(Core.toSaved);
  return { loans, updatedAt: (doc && doc.updatedAt) || null };
}
const isSampleId = (id) => /^sample/.test(id);
function savedLoan(raw, today, now) {
  const l = Core.cleanLoan(raw, today);
  if (!l) throw httpError(400, 'A loan needs what it is and who has it.');
  if (isSampleId(l.id)) throw httpError(400, 'The sample shelf stays on this phone.');
  return { ...Core.toSaved(l), updatedAt: now };
}

app.get('/api/shelf', identity.requireUser, route('Could not load your shelf.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Your shelf is safe on this phone.');
  const doc = await store.get('shelves', H.accountTag(req.user.id, SECRET()));
  res.json({ ...shelfView(doc, todayOf(req)), limit: Core.LIMITS.loans });
}));

/** Save one loan. Only the loan's own fields are kept: a photo, the sample
 *  flag or anything else a request carries is dropped here. */
app.put('/api/shelf/:id', identity.requireUser, route('Could not save that. It is still on this phone.', async (req, res) => {
  const tag = shelfTag(req);
  const now = Date.now();
  const today = todayOf(req);
  const loan = savedLoan({ ...((req.body || {}).loan || {}), id: req.params.id }, today, now);
  let out = null;
  await store.transact('shelves', tag, (cur) => {
    const loans = { ...((cur && cur.loans) || {}) };
    if (!loans[loan.id] && Object.keys(loans).length >= Core.LIMITS.loans) throw httpError(400, `A shelf keeps up to ${Core.LIMITS.loans} loans. Delete a few old ones first.`);
    loans[loan.id] = loan;
    out = { loans, createdAt: (cur && cur.createdAt) || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    return out;
  });
  res.json({ loan, updatedAt: out.updatedAt });
}));

app.delete('/api/shelf/:id', identity.requireUser, route('Could not delete that.', async (req, res) => {
  const tag = shelfTag(req);
  const id = String(req.params.id || '');
  if (!Core.ID_RE.test(id)) throw httpError(400, 'That isn’t a loan.');
  await store.transact('shelves', tag, (cur) => {
    if (!cur || !cur.loans || !cur.loans[id]) return undefined;
    const loans = { ...cur.loans };
    delete loans[id];
    return { ...cur, loans, updatedAt: new Date().toISOString() };
  });
  res.json({ ok: true });
}));

/** Bring this phone's shelf into the account on sign-in: a loan the
 *  account does not have is added; one it has is replaced only when this
 *  phone's copy is newer. The sample never comes along. */
app.post('/api/shelf/merge', identity.requireUser, mergeJson, route('Could not bring your shelf across. It is still on this phone.', async (req, res) => {
  const tag = shelfTag(req);
  const b = req.body || {};
  if (!Array.isArray(b.loans)) throw httpError(400, 'Send the loans.');
  const today = todayOf(req);
  const now = Date.now();
  const incoming = b.loans.slice(0, Core.LIMITS.loans * 2).map((l) => Core.cleanLoan(l, today)).filter((l) => l && !isSampleId(l.id) && !l.sample);
  let out = null;
  await store.transact('shelves', tag, (cur) => {
    const loans = { ...((cur && cur.loans) || {}) };
    for (const l of incoming) {
      const have = loans[l.id];
      if (have && Number(have.updatedAt || 0) >= l.updatedAt) continue;
      if (!have && Object.keys(loans).length >= Core.LIMITS.loans) continue;
      loans[l.id] = { ...Core.toSaved(l), updatedAt: l.updatedAt || now };
    }
    out = { loans, createdAt: (cur && cur.createdAt) || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    return out;
  });
  res.json({ ...shelfView(out, today), limit: Core.LIMITS.loans });
}));

/** Forget the account's copy (this phone keeps its own). */
app.delete('/api/shelf', identity.requireUser, route('Could not clear it.', async (req, res) => {
  const tag = shelfTag(req);
  await store.remove('shelves', tag);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Write it for me"
 * ------------------------------------------------------------------ */

/** Gates, then an 8 KB parser, then the ask checked (a 400 costs nothing),
 *  then one forced tool. Nothing here writes to the store. */
app.post('/api/write', ...spend, writeJson, route('Writing isn’t available right now. Try again in a minute - the ready-made nudges still work.', async (req, res) => {
  const today = todayOf(req);
  const b = ai.brief(req.body, today);
  const options = ai.cleanOptions(await ai.write(await clientFor(req), modelFor(req), b, today), b.tone);
  if (!options.length) throw httpError(422, 'Nothing usable came back. Try again, or try another hint.');
  res.set('Cache-Control', 'no-store');
  res.json({ options });
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A receipt link (h/<token>) is the same single-page app served one level
// down; <base href="../"> resolves every relative asset and API path against
// the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/h/:token', (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(deepIndex()); });
app.all('/h/:token', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

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
  // BOOMERANG_DEV_MOUNT=/boomerang runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.BOOMERANG_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`boomerang listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
