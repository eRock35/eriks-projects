// Sorted - keep, sell, donate or toss, one swipe at a time. See CLAUDE.md.
//
// EVERYTHING ABOUT YOUR THINGS STAYS ON YOUR DEVICE. The items, the piles,
// the sprints, the photos (IndexedDB), the tally and the recap image are
// worked out in the browser by public/sorted-core.js and never reach this
// server. What the server does:
//
//   - serves the page and its service worker;
//   - "Up for grabs" (signed in to make one; friends need no account): a
//     link with up to 40 things from the Donate and Sell piles - a name, a
//     short note, a price if it was for sale, and a small thumbnail only if
//     the owner left "include photo" ticked - that friends open and claim
//     things from, first come first served. The code is never stored; the
//     link expires after 1-14 days, can be closed at once, and deleting it
//     deletes its items and thumbnails;
//   - ONE metered, signed-in model call: "What could this sell for?", told
//     the one item's photo, name and condition;
//   - the shared account (sign-in, credit) at /api/auth.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/sorted-core');
const G = require('./lib/grabs');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.SORTED_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('SORTED_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. It takes a forced tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A link's code is a key: it must not ride out in a Referer header, and a
  // friend's claim page should never be indexed.
  if (/^\/g\//.test(req.path) || /^\/api\/g(\/|$)/.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// The routes that take more than a few KB mount their own parser AFTER the
// sign-in check (and, for the model call, after budget and the daily cap),
// so a stranger's body is never read. Everything else: 16 KB.
const aiJson = express.json({ limit: '768kb' });
const grabJson = express.json({ limit: '48kb' });
const thumbJson = express.json({ limit: '96kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(ai\/estimate|grabs|grabs\/[A-Za-z0-9_-]{32}\/items\/[a-z0-9]{8}\/thumb)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (making a link and the AI need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'sorted',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Sorted',
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
 * body: what someone is clearing out is nobody's business - and answered
 * with the route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = G.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - sorting still works without it.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address or account and per instance, in memory: they slow a
 * script, they do not stop a determined one - CLAUDE.md says so.
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
const lim = (max, windowMs) => identityLib.createLimiter({ max, windowMs });
const creates = lim(G.LIMITS.createsPerAccount, G.LIMITS.createsWindowMs);
const thumbUploads = lim(G.LIMITS.thumbsPerAccount, G.LIMITS.thumbsWindowMs);
const ownerReads = lim(G.LIMITS.ownerReadsPerAccount, G.LIMITS.ownerReadsWindowMs);
const claims = lim(G.LIMITS.claimsPerIp, G.LIMITS.claimsWindowMs);
const claimsAll = lim(G.LIMITS.claimsPerInstance, G.LIMITS.claimsWindowMs);
const reads = lim(G.LIMITS.readsPerIp, G.LIMITS.readsWindowMs);

// A wrong code counts once per DISTINCT value: a friend's phone left open on
// a closed link asks for the same code again, and that is not guessing.
// Guessing needs many different codes.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > G.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= G.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong links from here. Try again in a few minutes.');
}
function countClaim(req) {
  if (claimsAll.blocked('all')) throw httpError(429, 'Lots of people are claiming things right now. Try again in a minute.');
  if (!claims.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a few minutes and try again.');
  claimsAll.hit('all');
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, rooms: Core.ROOMS, decisions: Core.DECISIONS.map((d) => d.id), currencies: Core.CURRENCIES });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, grabs: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Up for grabs: the owner's side (signed in, free)
 * ------------------------------------------------------------------ */

const GONE = 'This list isn’t open any more. It may have been closed, or it expired - ask whoever sent it.';

function tagOf(req) {
  if (!SECRET()) throw httpError(503, 'Up for grabs isn’t available right now. Everything else works on your phone.');
  return G.ownerTag(req.user.id, SECRET());
}
/** Delete a link, its thumbnails first. */
async function dropGrab(doc) {
  for (const it of doc.items || []) if (it.thumb) await store.remove('thumbs', G.thumbId(doc.id, it.id));
  await store.remove('grabs', doc.id);
}
/** The account's links, with any long-closed or long-expired one deleted
 *  by the read that finds it (there is no timer: billed per request). */
async function myLinks(tag, now) {
  const rows = await store.list('grabs', { where: [['owner', '==', tag]], limit: 60 });
  const keep = [];
  for (const r of rows) { if (G.stale(r, now)) await dropGrab(r); else keep.push(r); }
  return keep.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
/** One of the account's links, by its id, or the same 404 as no link. */
async function ownGrab(req, tag) {
  const id = String(req.params.id || '');
  const doc = G.GRAB_ID_RE.test(id) ? await store.get('grabs', id) : null;
  if (!doc || !G.same(doc.owner, tag)) throw httpError(404, 'That link isn’t one of yours.');
  if (G.stale(doc, Date.now())) { await dropGrab(doc); throw httpError(404, 'That link isn’t one of yours.'); }
  return doc;
}
function itemOf(doc, iid) {
  const it = G.ITEM_ID_RE.test(String(iid || '')) ? doc.items.find((x) => x.id === iid) : null;
  if (!it) throw httpError(404, 'That isn’t on this list.');
  return it;
}
/** Change one item of a link in a transaction. */
async function changeItem(id, iid, fn) {
  let out = null;
  await store.transact('grabs', id, (cur) => {
    if (!cur) throw httpError(404, 'That link isn’t here any more.');
    const it = cur.items.find((x) => x.id === iid);
    if (!it) throw httpError(404, 'That isn’t on this list.');
    const r = fn(it, cur);
    if (r === false) { out = cur; return undefined; }
    out = cur;
    return cur;
  });
  return out;
}

app.post('/api/grabs', identity.requireUser, grabJson, route('Could not make that link.', async (req, res) => {
  const tag = tagOf(req);
  if (creates.blocked(tag)) throw httpError(429, `That’s ${G.LIMITS.createsPerAccount} links this hour. Try again later.`);
  const g = Core.grabRequest(req.body);
  if (!g) throw httpError(400, `A link needs 1 to ${Core.LIMITS.grabItems} things, each with a name, and lasts ${Core.LIMITS.grabDaysMin} to ${Core.LIMITS.grabDaysMax} days.`);
  const now = Date.now();
  const open = (await myLinks(tag, now)).filter((d) => G.statusOf(d, now) === 'open');
  if (open.length >= G.LIMITS.open) throw httpError(429, `You have ${G.LIMITS.open} open links. Close one first.`);
  const ids = new Set();
  const items = g.items.map((it) => {
    let id = G.newItemId();
    while (ids.has(id)) id = G.newItemId();
    ids.add(id);
    return { id, name: it.name, note: it.note, emoji: it.emoji, price: it.price, photo: it.photo, thumb: false, claim: null };
  });
  const code = G.newCode();
  const id = G.grabId(code);
  const doc = { owner: tag, title: g.title, from: g.from, currency: g.currency, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + g.days * 86400000).toISOString(), closedAt: null, items };
  await store.transact('grabs', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  creates.hit(tag);
  res.set('Cache-Control', 'no-store');
  res.json({ code, path: `g/${code}`, grab: G.ownerView({ id, ...doc }, now) });
}));

app.get('/api/grabs', identity.requireUser, route('Could not load your links.', async (req, res) => {
  const tag = tagOf(req);
  if (!ownerReads.hit(tag)) throw httpError(429, 'That’s a lot of checking. Wait a minute.');
  const now = Date.now();
  res.set('Cache-Control', 'no-store');
  const links = (await myLinks(tag, now)).map((d) => G.ownerView(d, now));
  res.json({ links, max: G.LIMITS.open, keepDays: Core.LIMITS.grabKeepDays });
}));

app.get('/api/grabs/:id', identity.requireUser, route('Could not load that link.', async (req, res) => {
  const tag = tagOf(req);
  if (!ownerReads.hit(tag)) throw httpError(429, 'That’s a lot of checking. Wait a minute.');
  res.set('Cache-Control', 'no-store');
  res.json({ grab: G.ownerView(await ownGrab(req, tag), Date.now()) });
}));

/** One thumbnail, after the link exists: only for an item published with
 *  "include photo" ticked, and only while the link is open. */
app.put('/api/grabs/:id/items/:iid/thumb', identity.requireUser, thumbJson, route('Could not add that photo.', async (req, res) => {
  const tag = tagOf(req);
  const doc = await ownGrab(req, tag);
  if (G.statusOf(doc, Date.now()) !== 'open') throw httpError(409, 'That link is closed.');
  const it = itemOf(doc, req.params.iid);
  if (!it.photo) throw httpError(400, 'That one was shared without its photo.');
  if (!thumbUploads.hit(tag)) throw httpError(429, 'That’s a lot of photos this hour. The link works without them.');
  const t = G.thumbnail(req.body && req.body.thumb);
  const tid = G.thumbId(doc.id, it.id);
  await store.set('thumbs', tid, { grab: doc.id, type: t.type, data: t.data, bytes: t.bytes, width: t.width, height: t.height });
  try {
    await changeItem(doc.id, it.id, (x) => { x.thumb = true; });
  } catch (err) { await store.remove('thumbs', tid); throw err; }
  res.json({ ok: true, bytes: t.bytes });
}));

app.post('/api/grabs/:id/close', identity.requireUser, route('Could not close that link.', async (req, res) => {
  const tag = tagOf(req);
  const doc = await ownGrab(req, tag);
  let out = doc;
  await store.transact('grabs', doc.id, (cur) => { if (!cur) throw httpError(404, 'That link isn’t one of yours.'); if (!cur.closedAt) cur.closedAt = new Date().toISOString(); out = cur; return cur; });
  res.json({ grab: G.ownerView({ ...out, id: doc.id }, Date.now()) });
}));

app.delete('/api/grabs/:id', identity.requireUser, route('Could not delete that link.', async (req, res) => {
  const tag = tagOf(req);
  await dropGrab(await ownGrab(req, tag));
  res.json({ ok: true });
}));

app.post('/api/grabs/:id/items/:iid/collected', identity.requireUser, route('Could not save that.', async (req, res) => {
  const tag = tagOf(req);
  const doc = await ownGrab(req, tag);
  const want = (req.body || {}).collected !== false;
  itemOf(doc, req.params.iid);
  const out = await changeItem(doc.id, req.params.iid, (it) => {
    if (!it.claim) throw httpError(409, 'Nobody has claimed that one.');
    it.claim.collected = want;
  });
  res.json({ grab: G.ownerView({ ...out, id: doc.id }, Date.now()) });
}));

/** The owner can release anyone's claim (a friend changed their mind by
 *  text, or never came). */
app.delete('/api/grabs/:id/items/:iid/claim', identity.requireUser, route('Could not release that.', async (req, res) => {
  const tag = tagOf(req);
  const doc = await ownGrab(req, tag);
  itemOf(doc, req.params.iid);
  const out = await changeItem(doc.id, req.params.iid, (it) => { if (!it.claim) return false; it.claim = null; return true; });
  res.json({ grab: G.ownerView({ ...out, id: doc.id }, Date.now()) });
}));

/* ------------------------------------------------------------------ *
 * Up for grabs: the friend's side (no account)
 * ------------------------------------------------------------------ */

// This browser's device key: an HttpOnly cookie scoped to the app, minted the
// first time it claims something, used only so it can release its own
// claims. Stored only as a hash.
const DEVICE_COOKIE = 'sorted_d';
function readDevice(req) {
  const m = /(?:^|;\s*)sorted_d=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintDevice(req, res) {
  const have = readDevice(req);
  if (have) return have;
  const key = G.newDeviceKey();
  res.append('Set-Cookie', `${DEVICE_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
const deviceOf = (req) => { const k = readDevice(req); return k ? G.deviceHash(k) : null; };

/** A link a friend may open. Unknown, closed and expired all answer the
 *  same 404, word for word. One past the owner's keep is deleted by the
 *  read that finds it. */
async function friendGrab(req) {
  const ip = ipKey(req);
  checkMisses(req);
  if (!reads.hit(ip)) throw httpError(429, 'Too many tries from here. Wait a few minutes.');
  const code = String(req.params.code || '');
  const id = G.isCode(code) ? G.grabId(code) : null;
  const doc = id ? await store.get('grabs', id) : null;
  const now = Date.now();
  if (doc && G.stale(doc, now)) await dropGrab(doc);
  if (!doc || G.statusOf(doc, now) !== 'open') { missed(ip, code.slice(0, 24)); throw httpError(404, GONE); }
  return doc;
}

app.get('/api/g/:code', route('Could not open that list.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await friendGrab(req);
  res.json({ grab: G.friendView(doc, deviceOf(req), Date.now()) });
}));

app.get('/api/g/:code/thumb/:iid', route('Could not load that photo.', async (req, res) => {
  const doc = await friendGrab(req);
  const it = itemOf(doc, req.params.iid);
  const t = it.thumb ? await store.get('thumbs', G.thumbId(doc.id, it.id)) : null;
  if (!t || !['image/jpeg', 'image/png'].includes(t.type)) throw httpError(404, 'That photo isn’t here.');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', t.type);
  res.set('Content-Disposition', 'inline');
  res.send(Buffer.from(t.data, 'base64'));
}));

/** "I'll take it": first come, first served, in a transaction - two people
 *  tapping at once get one yes and one kind no. */
app.post('/api/g/:code/items/:iid/claim', route('Could not save that. Try again.', async (req, res) => {
  countClaim(req);
  const doc = await friendGrab(req);
  itemOf(doc, req.params.iid);
  const name = Core.cleanName((req.body || {}).name, Core.LIMITS.claimName);
  if (!name) throw httpError(400, 'Add your first name, so they know who it’s for.');
  const dh = G.deviceHash(mintDevice(req, res));
  const now = Date.now();
  let next = null;
  await store.transact('grabs', doc.id, (cur) => {
    if (!cur || G.statusOf(cur, now) !== 'open') throw httpError(404, GONE);
    const it = cur.items.find((x) => x.id === req.params.iid);
    if (!it) throw httpError(404, 'That isn’t on this list any more.');
    next = cur;
    if (it.claim) {
      if (G.same(it.claim.device, dh)) return undefined;
      throw httpError(409, 'Someone got there first - that one’s been claimed. Have a look at the rest!', { code: 'taken' });
    }
    it.claim = { name, device: dh, at: new Date(now).toISOString(), collected: false };
    return cur;
  });
  res.set('Cache-Control', 'no-store');
  res.json({ grab: G.friendView(next, dh, now) });
}));

/** Changed your mind: only the browser that claimed it (or the owner, on
 *  their side) can let it go. */
app.delete('/api/g/:code/items/:iid/claim', route('Could not save that. Try again.', async (req, res) => {
  countClaim(req);
  const doc = await friendGrab(req);
  itemOf(doc, req.params.iid);
  const dh = deviceOf(req);
  const now = Date.now();
  let next = null;
  await store.transact('grabs', doc.id, (cur) => {
    if (!cur || G.statusOf(cur, now) !== 'open') throw httpError(404, GONE);
    const it = cur.items.find((x) => x.id === req.params.iid);
    if (!it || !it.claim || !dh || !G.same(it.claim.device, dh)) throw httpError(404, 'That isn’t one of your claims.');
    if (it.claim.collected) throw httpError(409, 'That’s been handed over already.');
    it.claim = null;
    next = cur;
    return cur;
  });
  res.set('Cache-Control', 'no-store');
  res.json({ grab: G.friendView(next, dh, now) });
}));

/* ------------------------------------------------------------------ *
 * Metered: "What could this sell for?"
 * ------------------------------------------------------------------ */

/** Gates, then the parser, then the request rebuilt field by field (a 400
 *  costs nothing), then one forced tool, then the answer checked. Nothing
 *  here writes to the store, and nothing logged carries a word of it. */
app.post('/api/ai/estimate', ...spend, aiJson, route('Estimates aren’t available right now. Try again in a minute - or check sold listings for something like it.', async (req, res) => {
  const b = ai.brief(req.body);
  const raw = await ai.ask(await clientFor(req), modelFor(req), b);
  res.set('Cache-Control', 'no-store');
  res.json(ai.answer(raw, b));
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A friend's link (g/<code>) is the same single-page app served one level
// down; <base href="../"> resolves every relative asset and API path against
// the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/g/:code', (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(deepIndex()); });
app.all('/g/:code', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

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
  // SORTED_DEV_MOUNT=/sorted runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.SORTED_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`sorted listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, LIMITS: G.LIMITS };
