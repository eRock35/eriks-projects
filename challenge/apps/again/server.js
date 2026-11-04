// Again - remember what you loved, and order it again. See CLAUDE.md.
//
// EVERYTHING STAYS ON THE DEVICE UNLESS THE PERSON SAYS OTHERWISE. The
// places, the dishes with their verdicts, notes, prices and who was there,
// the Want to try list, "I'm here", browsing, the stats, the share card and
// the exports are worked out in the browser by public/again-core.js and kept
// in localStorage; dish photos live in IndexedDB on the phone and never
// reach this server. What the server does:
//
//   - serves the page and its service worker;
//   - signed in (free), and only when the person turns it on: keeps a copy
//     of the LIST (places, dishes, verdicts, notes, prices, days, first
//     names, the Want to try list - never a photo) so a phone and a laptop
//     agree, filed under an HMAC of the account id, with a version and a 409
//     when another device saved first. Everything in it is cleaned and
//     capped here;
//   - signed in (free): a read-only share link of one city's "Order again"
//     list - place names, neighbourhoods, cuisines, dish names, verdicts and
//     the one-line notes, nothing else - that friends open with no account.
//     The code is never stored; expired, closed and unknown links answer the
//     same 404;
//   - ONE metered, signed-in model call: "Read the menu", told the photo
//     and - only for "What should I order?" - the person's own dish names,
//     cuisines and verdicts;
//   - the shared account (sign-in, credit) at /api/auth.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/again-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.AGAIN_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('AGAIN_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both read an image and take a
// forced tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const LIMITS = {
  listWrites: 120,                    // list saves per account...
  listWindowMs: 10 * 60 * 1000,       // ...in 10 minutes
  listBytes: Core.LIMITS.listBytes,
  shareCreates: 20,                   // new links per account...
  shareCreateWindowMs: 60 * 60 * 1000, // ...an hour
  sharesOpen: Core.LIMITS.sharesOpen, // open links per account
  shareBytes: Core.LIMITS.shareBytes,
  shareReadsPerIp: 300,               // friend reads per address...
  shareReadWindowMs: 10 * 60 * 1000,  // ...in 10 minutes
  shareMissesPerIp: 30,               // DISTINCT wrong codes one address may try...
  shareMissWindowMs: 15 * 60 * 1000,  // ...in 15 minutes, then even a real one waits
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

// The routes that take more than a few KB mount their own parser AFTER the
// sign-in check (and, for the model call, after budget and the daily cap),
// so a stranger's body is never read. A 1 MB photo is ~1.34 MB as base64,
// plus up to 120 dish names. Everything else: 16 KB.
const aiJson = express.json({ limit: '1500kb' });
const listJson = express.json({ limit: '1100kb' });
const shareJson = express.json({ limit: '64kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(ai\/menu|list|shares)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (sync, share links and the menu reader need it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'again',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Again',
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
 * body or an image: where someone eats is nobody's business - and answered
 * with the route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - adding dishes by hand always works.' : fallback), ...(mine && err.code ? { code: err.code } : {}), ...(mine && err.problems ? { problems: err.problems } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/** The server's own idea of today (UTC), for checking days it is sent. The
 *  core allows a day past it, which covers every time zone. */
function serverDay() { return new Date().toISOString().slice(0, 10); }
const ctx = () => ({ today: serverDay(), nowMs: Date.now() });

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
const listWrites = lim(LIMITS.listWrites, LIMITS.listWindowMs);
const shareCreates = lim(LIMITS.shareCreates, LIMITS.shareCreateWindowMs);
const shareReads = lim(LIMITS.shareReadsPerIp, LIMITS.shareReadWindowMs);

// A wrong code counts once per DISTINCT value: a friend's phone left open on
// a closed link asks for the same code again, and that is not guessing.
// Guessing needs many different codes.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > LIMITS.shareMissWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free, opt-in: the list follows the person to another device.
 *
 *   lists/<tag> = {owner: tag, list: {places, dishes, wants, deleted}, version, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret - never the id or the email. Whole-document writes in a
 * transaction: PUT saves only if `base` is still the account copy's version,
 * else 409 with the account's copy, and the page asks "use theirs / keep
 * mine / merge by item". A device that never synced cannot overwrite one.
 * ------------------------------------------------------------------ */

function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('again owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, what) {
  if (!SECRET()) throw httpError(503, what === 'share' ? 'Share links aren’t available right now. Everything else works on this device.' : 'Sync isn’t available right now. Your list is safe on this device.');
  return ownerTag(req.user.id, SECRET());
}
function listOut(doc) {
  if (!doc || !doc.list) return null;
  return Core.cleanList(doc.list, ctx()).list;
}

app.get('/api/list', identity.requireUser, route('Could not load your list.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await store.get('lists', tagOf(req));
  res.json({ list: listOut(doc), version: doc ? Number(doc.version) || 0 : null });
}));

app.put('/api/list', identity.requireUser, listJson, route('Could not save that. It is still on this device.', async (req, res) => {
  const tag = tagOf(req);
  if (!listWrites.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - your list is still on this device.');
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'list' && k !== 'base')) throw httpError(400, 'Send the list and nothing else.');
  if (!b.list || typeof b.list !== 'object' || Array.isArray(b.list)) throw httpError(400, 'Send the list.');
  const { list, errors } = Core.cleanList(b.list, ctx(), true);
  if (errors.some((e) => /^At most/.test(e))) throw httpError(413, `That’s more than an account copy can hold (${Core.LIMITS.places} places, ${Core.LIMITS.dishes} dishes, ${Core.LIMITS.wants} recommendations). Remove a few old ones first.`);
  if (errors.length) throw httpError(400, 'That list was not saved: ' + errors[0], { problems: errors.slice(0, 10) });
  if (Core.listBytes(list) > LIMITS.listBytes) throw httpError(413, 'That list is too big to keep in one account. Remove a few old places or shorten long notes.');
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('lists', tag, (cur) => {
    if (cur && Number(cur.version) !== base) { conflict = cur; return undefined; }
    const version = (cur ? Number(cur.version) || 0 : 0) + 1;
    saved = { owner: tag, list, version, updatedAt: Date.now() };
    return saved;
  });
  res.set('Cache-Control', 'no-store');
  if (conflict) return res.status(409).json({ error: 'Your list changed on another device.', code: 'conflict', list: listOut(conflict), version: Number(conflict.version) || 0 });
  res.json({ list: saved.list, version: saved.version });
}));

app.delete('/api/list', identity.requireUser, route('Could not remove it.', async (req, res) => {
  await store.remove('lists', tagOf(req));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Read-only share links: one city's "Order again" list.
 *
 *   shares/<sha256 of the code> = {owner: tag, city, from, places, createdAt, expiresAt, opens}
 *
 * The code (16 random bytes, 22 characters) is the link; it is never
 * stored, so reading the database cannot open a link. The document holds
 * only what AgainCore.shareRequest allows - place names, neighbourhoods,
 * cuisines, dish names, verdicts and the one-line notes - and a request
 * that carries anything else (a price, a day, a companion, a photo) is a
 * 400. Closing a link deletes it; an expired one is deleted by the read
 * that finds it (no timer: billed per request). Expired, closed and unknown
 * links answer the same 404, word for word.
 * ------------------------------------------------------------------ */

const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const newCode = () => crypto.randomBytes(16).toString('base64url');
const shareId = (code) => crypto.createHash('sha256').update(`again share v1:${code}`).digest('base64url').slice(0, 32);
const expired = (doc, now) => !doc || !doc.expiresAt || Date.parse(doc.expiresAt) <= now;
const GONE = 'This list isn’t open any more. It may have been closed, or it expired - ask whoever sent it for a new link.';
function linkView(doc) {
  const places = Array.isArray(doc.places) ? doc.places : [];
  return { id: doc.id, city: doc.city, places: places.length, dishes: places.reduce((n, p) => n + (Array.isArray(p.dishes) ? p.dishes.length : 0), 0), createdAt: doc.createdAt, expiresAt: doc.expiresAt, opens: Number(doc.opens) || 0 };
}
async function openLinks(tag, now) {
  const rows = await store.list('shares', { where: [['owner', '==', tag]], limit: LIMITS.sharesOpen * 10 });
  const live = [];
  for (const r of rows) { if (expired(r, now)) await store.remove('shares', r.id); else live.push(r); }
  return live;
}

app.post('/api/shares', identity.requireUser, shareJson, route('Could not make that link.', async (req, res) => {
  const tag = tagOf(req, 'share');
  if (shareCreates.blocked(tag)) throw httpError(429, `That’s ${LIMITS.shareCreates} links this hour. Try again later.`);
  const s = Core.shareRequest(req.body);
  if (!s) throw httpError(400, `A link holds one city’s list - place names, neighbourhoods, cuisines, dishes, verdicts and notes, nothing else - and lasts ${Core.LIMITS.shareDaysMin} to ${Core.LIMITS.shareDaysMax} days.`);
  const now = Date.now();
  if ((await openLinks(tag, now)).length >= LIMITS.sharesOpen) throw httpError(429, `You have ${LIMITS.sharesOpen} open links. Close one first.`);
  const code = newCode();
  const id = shareId(code);
  const row = { owner: tag, city: s.city, from: s.from, places: s.places, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + s.days * 86400000).toISOString(), opens: 0 };
  if (Buffer.byteLength(JSON.stringify(row)) > LIMITS.shareBytes) throw httpError(413, 'That list is too long for one link. Untick “what to skip”, or share fewer places.');
  await store.transact('shares', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return row; });
  shareCreates.hit(tag);
  res.set('Cache-Control', 'no-store');
  res.json({ code, path: `s/${code}`, link: linkView({ id, ...row }) });
}));

app.get('/api/shares', identity.requireUser, route('Could not load your links.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const links = (await openLinks(tagOf(req, 'share'), Date.now())).map(linkView).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ links, max: LIMITS.sharesOpen });
}));

/** Close a link: it is deleted, so it answers the same 404 as one that
 *  never existed. */
app.delete('/api/shares/:id', identity.requireUser, route('Could not close that link.', async (req, res) => {
  const tag = tagOf(req, 'share');
  const id = String(req.params.id || '');
  const doc = ID_RE.test(id) ? await store.get('shares', id) : null;
  if (!doc || doc.owner !== tag) throw httpError(404, 'That link isn’t one of yours.');
  await store.remove('shares', id);
  res.json({ ok: true });
}));

/** A friend opens a link: no account needed. Wrong codes are counted per
 *  address, once per distinct code. */
app.get('/api/s/:code', route('Could not open that list.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex');
  const ip = ipKey(req);
  if (missState(ip).seen.size >= LIMITS.shareMissesPerIp) throw httpError(429, 'Too many wrong links from here. Try again in a few minutes.');
  if (!shareReads.hit(ip)) throw httpError(429, 'Too many tries from here. Wait a few minutes.');
  const code = String(req.params.code || '');
  const id = CODE_RE.test(code) ? shareId(code) : null;
  const doc = id ? await store.get('shares', id) : null;
  const now = Date.now();
  if (doc && expired(doc, now)) await store.remove('shares', doc.id);
  const share = doc && !expired(doc, now) ? Core.shareView(doc) : null;
  if (!share) { missed(ip, code.slice(0, 24)); throw httpError(404, GONE); }
  await store.bump('shares', doc.id, { opens: 1 }, { mustExist: true });
  res.json({ share, expiresAt: doc.expiresAt });
}));
app.all('/api/s/:code', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'A shared list is read-only.' }));

/* ------------------------------------------------------------------ *
 * Metered: "Read the menu" (and "What should I order?")
 * ------------------------------------------------------------------ */

/** Gates, then the parser, then the request rebuilt (the photo checked by
 *  its bytes, the history checked field by field - a 400 costs nothing),
 *  then one forced tool, then the answer checked. Nothing here writes to
 *  any store, and nothing logged carries a byte of the photo. */
app.post('/api/ai/menu', ...spend, aiJson, route('Reading a menu isn’t available right now. Try again in a minute - adding dishes by hand always works.', async (req, res) => {
  const b = ai.brief(req.body);
  const raw = await ai.ask(await clientFor(req), modelFor(req), b);
  res.set('Cache-Control', 'no-store');
  res.json(ai.answer(raw, b));
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A friend's link (s/<code>) is the same single-page app served one level
// down; <base href="../"> resolves every relative asset and API path against
// the app root, mounted or not. Its code must not ride out in a Referer
// header, and a shared list should never be indexed.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/s/:code', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex');
  res.type('html').send(deepIndex());
});
app.all('/s/:code', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'A shared list is read-only.' }));

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
  // AGAIN_DEV_MOUNT=/again runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.AGAIN_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`again listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, ownerTag, shareId, LIMITS };
