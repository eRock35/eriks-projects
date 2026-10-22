// Kindly - never miss the people who matter, and always know what to give.
// See CLAUDE.md.
//
// The circle - people, their dates, the notes, the gift ideas, what was given
// and when, the budgets - lives on the phone (localStorage) and is worked out
// there by public/kindly-core.js: Coming up, the countdowns, ages and
// milestones, the no-repeat check, the calendar file. Nothing about it
// reaches this server unless:
//
//   - you make a wishlist link for someone: their first name is stored under
//     a hash of the link's token, so they can open it with no account and
//     add ideas of their own, which wait there until your phone collects them;
//   - you are signed in (free): the circle is kept in your account, so it
//     follows you to another phone;
//   - you tap "Gift ideas for them": the one model call, metered and signed
//     in. It is told the relationship, an age, the occasion, a budget and the
//     notes - never the name.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/kindly-core');
const W = require('./lib/wishlists');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.KINDLY_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('KINDLY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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
  // A wishlist link's token is a key. It must not ride out in a Referer
  // header, and a wishlist should never be indexed.
  if (/^\/w\//.test(req.path) || /^\/api\/w(\/|$)/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The metered route mounts its own 8 KB parser AFTER sign-in, budget and the
// daily cap, so a stranger's body is never read; bringing a whole circle into
// an account mounts 512 KB after sign-in. Everything else 16 KB.
const ideasJson = express.json({ limit: '8kb' });
const mergeJson = express.json({ limit: '512kb' });
const personJson = express.json({ limit: '64kb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => {
  if (req.path === '/api/ideas' || req.path === '/api/people/merge' || /^\/api\/people\/[^/]+$/.test(req.path)) return next();
  return smallJson(req, res, next);
});

/* ------------------------------------------------------------------ *
 * The shared account (sync and "Gift ideas for them" need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'kindly',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Kindly',
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
 * body: who someone loves and what they want is nobody's business - and
 * answered with the route's fallback. A provider error is a 502, or 503 when
 * busy.
 * ------------------------------------------------------------------ */

const httpError = Core.fail;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - your own ideas still work.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits (per instance, in memory - they slow a script, they do not stop a
 * determined one)
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
const creates = identityLib.createLimiter({ max: W.LIMITS.createsPerIp, windowMs: W.LIMITS.createsWindowMs });
const createsAll = identityLib.createLimiter({ max: W.LIMITS.createsPerInstance, windowMs: W.LIMITS.createsWindowMs });
const writes = identityLib.createLimiter({ max: W.LIMITS.writesPerIp, windowMs: W.LIMITS.writesWindowMs });
const adds = identityLib.createLimiter({ max: W.LIMITS.addsPerIp, windowMs: W.LIMITS.addsWindowMs });
const saves = identityLib.createLimiter({ max: W.LIMITS.savesPerAccount, windowMs: W.LIMITS.savesWindowMs });

// A wrong token counts once per DISTINCT value: a phone left open on a
// revoked link asks for the same dead token again, and that is not guessing.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > W.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= W.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong links from here. Try again in a few minutes.');
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

// This browser's device key: an HttpOnly cookie scoped to the app, minted the
// first time it makes a link, used only to count its live links. Stored only
// as a hash.
const DEVICE_COOKIE = 'kindly_k';
function readDevice(req) {
  const m = /(?:^|;\s*)kindly_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintDevice(req, res) {
  const have = readDevice(req);
  if (have) return have;
  const key = W.newKey();
  res.append('Set-Cookie', `${DEVICE_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
/** The owner key rides in a header, never in the URL. */
function ownerKey(req) {
  const k = req.get('X-Kindly-Key');
  return typeof k === 'string' && Core.TOKEN_RE.test(k) ? k : null;
}
function actorOf(doc, req) {
  const k = ownerKey(req);
  return k && W.sameHash(W.ownerHash(k, doc.id), doc.ownerHash) ? 'owner' : 'friend';
}

/** A wishlist, if the token names a live one. One past its expiry is deleted
 *  by the read that finds it (there is no timer). Unknown, revoked and
 *  expired all answer the same 404. */
const GONE = 'This wishlist link isn’t open any more. It may have been closed, or it expired - ask for a new one.';
async function loadWishlist(req) {
  checkMisses(req);
  const token = String(req.params.token || '');
  const id = W.isToken(token) ? W.docId(token) : null;
  const doc = id ? await store.get('wishlists', id) : null;
  if (!doc) { missed(ipKey(req), token.slice(0, 24)); throw httpError(404, GONE); }
  if (W.expired(doc, Date.now())) { await store.remove('wishlists', doc.id); throw httpError(404, GONE); }
  return doc;
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, relationships: Core.RELATIONSHIPS });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Wishlist links: no account to make one, none to open one
 * ------------------------------------------------------------------ */

async function openCount(tag, now) {
  const rows = await store.list('wishlists', { where: [['creator', '==', tag]], limit: W.LIMITS.openPerCreator * 4 });
  return rows.filter((r) => !W.expired(r, now)).length;
}

app.post('/api/w', route('Could not make that link.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (creates.blocked(ip)) throw httpError(429, `That’s ${W.LIMITS.createsPerIp} links from here this hour. Try again later.`);
  if (createsAll.blocked('all')) throw httpError(429, 'Lots of people are making links right now. Try again in a few minutes.');
  const now = Date.now();
  const doc = W.newWishlist(req.body, now);
  const signedTag = req.user && SECRET() ? `a:${W.accountTag(req.user.id, SECRET())}` : null;
  const creator = signedTag || W.deviceTag(mintDevice(req, res));
  if (await openCount(creator, now) >= W.LIMITS.openPerCreator) throw httpError(429, `You have ${W.LIMITS.openPerCreator} open wishlist links. Close a few first.`);
  const token = W.newToken();
  const key = W.newKey();
  const id = W.docId(token);
  const full = { ...doc, ownerHash: W.ownerHash(key, id), creator };
  await store.transact('wishlists', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return full; });
  creates.hit(ip);
  createsAll.hit('all');
  res.set('Cache-Control', 'no-store');
  res.json({ token, key, w: W.view(full, 'owner') });
}));

app.get('/api/w/:token', route('Could not open that link.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await loadWishlist(req);
  res.json({ w: W.view(doc, actorOf(doc, req)) });
}));

/** The friend adds an idea. Read inside a transaction, so two at once both
 *  land and the cap holds. */
app.post('/api/w/:token/add', route('Could not add that.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (adds.blocked(ip)) throw httpError(429, 'That’s a lot of ideas from here this hour. Try again later.');
  const doc = await loadWishlist(req);
  const add = W.cleanAdd(req.body, Date.now());
  let next = null;
  await store.transact('wishlists', doc.id, (cur) => {
    if (!cur || W.expired(cur, Date.now())) throw httpError(404, GONE);
    const list = Array.isArray(cur.adds) ? cur.adds : [];
    if (list.length >= W.LIMITS.pending) throw httpError(409, `That’s ${W.LIMITS.pending} ideas waiting - plenty to choose from. Thank you!`);
    next = { ...cur, adds: [...list, add] };
    return next;
  });
  adds.hit(ip);
  res.set('Cache-Control', 'no-store');
  res.json({ added: { id: add.id, text: add.text, link: add.link, price: add.price }, w: W.view(next, 'friend') });
}));

/** The owner's phone collects ideas onto its list; the server drops them. */
app.post('/api/w/:token/collect', route('Could not collect those.', async (req, res) => {
  countWrite(req);
  const doc = await loadWishlist(req);
  if (actorOf(doc, req) !== 'owner') throw httpError(404, GONE);
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 100) : [];
  let next = null;
  await store.transact('wishlists', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE);
    next = { ...cur, adds: (cur.adds || []).filter((a) => !ids.includes(a.id)) };
    return next;
  });
  res.set('Cache-Control', 'no-store');
  res.json({ w: W.view(next, 'owner') });
}));

/** The owner closes the link: deleted, and from then on the same 404 as a
 *  link that never existed. Anyone else gets that 404 now. */
app.delete('/api/w/:token', route('Could not close that link.', async (req, res) => {
  countWrite(req);
  const doc = await loadWishlist(req);
  if (actorOf(doc, req) !== 'owner') throw httpError(404, GONE);
  await store.remove('wishlists', doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Signed in, free: the circle follows you to another phone
 * ------------------------------------------------------------------ */

function circleTag(req) {
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Your circle is safe on this phone.');
  if (!saves.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - it’s all still on this phone.');
  return W.accountTag(req.user.id, SECRET());
}
/** A stored circle, cleaned on the way out too. */
function circleView(doc, today) {
  const people = Object.values((doc && doc.people) || {}).map((p) => Core.cleanPerson(p, today)).filter(Boolean).map(Core.toSaved);
  people.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
  return { people, updatedAt: (doc && doc.updatedAt) || null };
}
const isSampleId = (id) => /^sample/.test(id);
function savedPerson(raw, today, now) {
  const p = Core.cleanPerson(raw, today);
  if (!p) throw httpError(400, 'A person needs a name.');
  if (isSampleId(p.id)) throw httpError(400, 'The sample circle stays on this phone.');
  return { ...Core.toSaved(p), updatedAt: Number(raw.updatedAt) > 0 && Number(raw.updatedAt) <= now + 60000 ? Math.round(Number(raw.updatedAt)) : now };
}

app.get('/api/people', identity.requireUser, route('Could not load your circle.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Your circle is safe on this phone.');
  const doc = await store.get('circles', W.accountTag(req.user.id, SECRET()));
  res.json({ ...circleView(doc, todayOf(req)), limit: Core.LIMITS.people });
}));

/** Save one person. Only their own fields are kept: the sample flag or
 *  anything else a request carries is dropped here. */
app.put('/api/people/:id', identity.requireUser, personJson, route('Could not save that. It is still on this phone.', async (req, res) => {
  const tag = circleTag(req);
  const now = Date.now();
  const raw = (req.body || {}).person;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the person.');
  const person = savedPerson({ ...raw, id: req.params.id }, todayOf(req), now);
  let out = null;
  await store.transact('circles', tag, (cur) => {
    const people = { ...((cur && cur.people) || {}) };
    if (!people[person.id] && Object.keys(people).length >= Core.LIMITS.people) throw httpError(400, `A circle keeps up to ${Core.LIMITS.people} people.`);
    people[person.id] = person;
    out = { people, createdAt: (cur && cur.createdAt) || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    return out;
  });
  res.json({ person, updatedAt: out.updatedAt });
}));

app.delete('/api/people/:id', identity.requireUser, personJson, route('Could not delete that.', async (req, res) => {
  const tag = circleTag(req);
  const id = String(req.params.id || '');
  if (!Core.ID_RE.test(id)) throw httpError(400, 'That isn’t someone in your circle.');
  await store.transact('circles', tag, (cur) => {
    if (!cur || !cur.people || !cur.people[id]) return undefined;
    const people = { ...cur.people };
    delete people[id];
    return { ...cur, people, updatedAt: new Date().toISOString() };
  });
  res.json({ ok: true });
}));

/** Bring this phone's circle into the account on sign-in: a person the
 *  account lacks is added; one it has is replaced only when this phone's copy
 *  is newer. The sample never comes along. */
app.post('/api/people/merge', identity.requireUser, mergeJson, route('Could not bring your circle across. It is still on this phone.', async (req, res) => {
  const tag = circleTag(req);
  const b = req.body || {};
  if (!Array.isArray(b.people)) throw httpError(400, 'Send the people.');
  const today = todayOf(req);
  const now = Date.now();
  const incoming = [];
  for (const raw of b.people.slice(0, Core.LIMITS.people * 2)) {
    if (!raw || typeof raw !== 'object' || raw.sample === true) continue;
    try { incoming.push(savedPerson(raw, today, now)); } catch (e) { /* no name, or the sample: left on the phone */ }
  }
  let out = null;
  await store.transact('circles', tag, (cur) => {
    const people = { ...((cur && cur.people) || {}) };
    for (const p of incoming) {
      const have = people[p.id];
      if (have && Number(have.updatedAt || 0) >= p.updatedAt) continue;
      if (!have && Object.keys(people).length >= Core.LIMITS.people) continue;
      people[p.id] = p;
    }
    out = { people, createdAt: (cur && cur.createdAt) || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    return out;
  });
  res.json({ ...circleView(out, today), limit: Core.LIMITS.people });
}));

/** Forget the account's copy (this phone keeps its own). */
app.delete('/api/people', identity.requireUser, route('Could not clear it.', async (req, res) => {
  const tag = circleTag(req);
  await store.remove('circles', tag);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Gift ideas for them"
 * ------------------------------------------------------------------ */

/** Gates, then the 8 KB parser, then the brief checked (a 400 costs
 *  nothing), then one forced tool. Nothing here writes to the store, and
 *  nothing logged carries a word of the brief. Not streamed: five ideas come
 *  back in seconds. */
app.post('/api/ideas', ...spend, ideasJson, route('Ideas aren’t available right now. Try again in a minute - your own list still works.', async (req, res) => {
  const b = ai.brief(req.body);
  const ideas = ai.cleanSuggestions(await ai.suggest(await clientFor(req), modelFor(req), b));
  if (!ideas.length) throw httpError(422, 'No usable ideas came back. Add a like or two to their notes and try again.');
  res.set('Cache-Control', 'no-store');
  res.json({ ideas });
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A wishlist link (w/<token>) is the same single-page app served one level
// down; <base href="../"> resolves every relative asset and API path against
// the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/w/:token', (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(deepIndex()); });
app.all('/w/:token', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

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
  // KINDLY_DEV_MOUNT=/kindly runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.KINDLY_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`kindly listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient };
