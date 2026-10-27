// Canon - one definition of every metric, and a check on every AI answer
// that uses it. See CLAUDE.md.
//
// The canon (metric definitions and schema notes) lives on the device
// (localStorage), and every check of a question + SQL against it is worked
// out there by public/canon-core.js - there is no route that takes SQL to
// check. What the server does:
//
//   - serves the page and its service worker;
//   - signed in (free): keeps the account's canon, filed under an HMAC of the
//     account id, so it follows them to another device;
//   - signed in (free): read-only share links for that canon - an opaque
//     code, an expiry, a cap - that anyone can open without an account;
//   - TWO metered, signed-in model calls: "Draft definitions from my schema"
//     (told only the parsed tables and columns and one sentence) and
//     "Explain this answer" (told the question, the SQL and only the matched
//     definitions);
//   - the shared account (sign-in, credit) at /api/auth.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/canon-core');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.CANON_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('CANON_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both take a forced tool.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const LIMITS = {
  canonWrites: 200,                  // canon saves per account...
  canonWindowMs: 10 * 60 * 1000,     // ...in 10 minutes
  shareCreates: 20,                  // new share links per account...
  shareCreateWindowMs: 60 * 60 * 1000, // ...an hour
  sharesOpen: Core.LIMITS.sharesOpen, // live links per account
  shareDays: Core.LIMITS.shareDays,  // how long a link may last
  shareMissesPerIp: 30,              // distinct wrong codes one address may try...
  shareMissWindowMs: 15 * 60 * 1000, // ...in 15 minutes
  shareReadsPerIp: 300,              // any share reads, per address...
  shareReadWindowMs: 10 * 60 * 1000, // ...in 10 minutes
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

// Each route that takes more than a few KB mounts its own parser AFTER the
// sign-in check (and, for the model calls, after budget and the daily cap),
// so a stranger's body is never read. Everything else: 16 KB.
const canonJson = express.json({ limit: '512kb' });
const draftJson = express.json({ limit: '256kb' });
const explainJson = express.json({ limit: '128kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(canon|draft|explain)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (sync, share links and the AI need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'canon',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Canon',
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
 * body: a company's SQL and schema are its own business - and answered with
 * the route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = ai.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - every check still works without it.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
  res.json({ limits: Core.LIMITS, verdicts: Core.VERDICTS, shareDays: LIMITS.shareDays, sharesOpen: LIMITS.sharesOpen });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free: the canon follows you to another device.
 *
 *   canons/<tag> = {owner: tag, canon, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret - never the id or the email.
 * ------------------------------------------------------------------ */

const canonWrites = identityLib.createLimiter({ max: LIMITS.canonWrites, windowMs: LIMITS.canonWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('canon owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Your canon is safe on this device.');
  if (write && !canonWrites.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - it’s all still on this device.');
  return ownerTag(req.user.id, SECRET());
}
/** What a stored canon looks like on the way out: cleaned again. */
function canonOut(doc) {
  if (!doc || !doc.canon) return null;
  const c = Core.cleanCanon(doc.canon);
  if (!c) return null;
  c.sample = false;
  c.updatedAt = Number(doc.updatedAt) || c.updatedAt;
  return c;
}

app.get('/api/canon', identity.requireUser, route('Could not load your canon.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await store.get('canons', tagOf(req, false));
  res.json({ canon: canonOut(doc) });
}));

/** Save the whole canon. `base` is the account copy's updatedAt this device
 *  last saw: if the account has moved on since (another device saved), the
 *  answer is 409 with the account's copy, and the page merges and retries. */
app.put('/api/canon', identity.requireUser, canonJson, route('Could not save that. It is still on this device.', async (req, res) => {
  const tag = tagOf(req, true);
  const b = req.body || {};
  const raw = b.canon;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the canon.');
  if (raw.sample === true) throw httpError(400, 'The made-up example stays on this device. Start your own canon to sync it.');
  const canon = Core.cleanCanon(raw);
  if (!canon) throw httpError(400, 'That canon could not be read.');
  canon.sample = false;
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('canons', tag, (cur) => {
    if (cur && Number(cur.updatedAt) !== base) { conflict = cur; return undefined; }
    const now = Math.max(Date.now(), (cur && Number(cur.updatedAt) + 1) || 0);
    saved = { owner: tag, canon: { ...canon, updatedAt: now }, updatedAt: now };
    return saved;
  });
  res.set('Cache-Control', 'no-store');
  if (conflict) return res.status(409).json({ error: 'Your canon changed on another device. Merging the two.', code: 'conflict', canon: canonOut(conflict) });
  res.json({ canon: canonOut(saved) });
}));

/** Forget the account's copy - and with it, every share link (this device
 *  keeps its own copy). */
app.delete('/api/canon', identity.requireUser, route('Could not clear it.', async (req, res) => {
  const tag = tagOf(req, true);
  const links = await store.list('shares', { where: [['owner', '==', tag]], limit: LIMITS.sharesOpen * 10 });
  for (const l of links) await store.remove('shares', l.id);
  await store.remove('canons', tag);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Read-only share links
 *
 *   shares/<sha256 of the code> = {owner: tag, createdAt, expiresAt, opens}
 *
 * The code (16 random bytes) is the link; it is never stored, so reading the
 * database cannot open a link. A link shows the account's canon AS IT IS NOW
 * (edits that sync show up), and only the canon: its name, its definitions
 * and its schema notes. Not the account, not the owner's other links, not
 * anything checked with it. Expired and closed links answer the same 404 as
 * one that never existed.
 * ------------------------------------------------------------------ */

const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const shareCreates = identityLib.createLimiter({ max: LIMITS.shareCreates, windowMs: LIMITS.shareCreateWindowMs });
const shareMisses = identityLib.createLimiter({ max: LIMITS.shareMissesPerIp, windowMs: LIMITS.shareMissWindowMs });
const shareReads = identityLib.createLimiter({ max: LIMITS.shareReadsPerIp, windowMs: LIMITS.shareReadWindowMs });
const newCode = () => crypto.randomBytes(16).toString('base64url');
const shareId = (code) => crypto.createHash('sha256').update(`canon share v1:${code}`).digest('base64url').slice(0, 32);
const expired = (doc, now) => !doc || !doc.expiresAt || Date.parse(doc.expiresAt) <= now;
const GONE = 'This link isn’t open any more. It may have been closed, or it expired - ask for a new one.';
function ipKey(req) {
  const ip = String(req.ip || '');
  if (ip.includes(':') && !ip.startsWith('::ffff:')) return ip.split(':').slice(0, 4).join(':'); // an IPv6 /64
  return ip;
}
function linkView(doc) {
  return { id: doc.id, createdAt: doc.createdAt, expiresAt: doc.expiresAt, opens: Number(doc.opens) || 0 };
}
async function openLinks(tag, now) {
  const rows = await store.list('shares', { where: [['owner', '==', tag]], limit: LIMITS.sharesOpen * 10 });
  const live = [];
  for (const r of rows) { if (expired(r, now)) await store.remove('shares', r.id); else live.push(r); }
  return live;
}

app.post('/api/shares', identity.requireUser, route('Could not make that link.', async (req, res) => {
  const tag = tagOf(req, false);
  const days = Number((req.body || {}).days);
  if (!LIMITS.shareDays.includes(days)) throw httpError(400, `Choose how long the link lasts: ${LIMITS.shareDays.join(', ')} days.`);
  if (shareCreates.blocked(req.user.id)) throw httpError(429, `That’s ${LIMITS.shareCreates} links this hour. Try again later.`);
  const doc = await store.get('canons', tag);
  if (!canonOut(doc)) throw httpError(409, 'Sync your canon to your account first - a link shows the account’s copy.');
  const now = Date.now();
  if ((await openLinks(tag, now)).length >= LIMITS.sharesOpen) throw httpError(429, `You have ${LIMITS.sharesOpen} open links. Close one first.`);
  const code = newCode();
  const id = shareId(code);
  const row = { owner: tag, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86400000).toISOString(), opens: 0 };
  await store.transact('shares', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return row; });
  shareCreates.hit(req.user.id);
  res.set('Cache-Control', 'no-store');
  res.json({ code, path: `s/${code}`, link: linkView({ id, ...row }) });
}));

app.get('/api/shares', identity.requireUser, route('Could not load your links.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const links = (await openLinks(tagOf(req, false), Date.now())).map(linkView).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ links, max: LIMITS.sharesOpen });
}));

app.delete('/api/shares/:id', identity.requireUser, route('Could not close that link.', async (req, res) => {
  const tag = tagOf(req, false);
  const id = String(req.params.id || '');
  const doc = /^[A-Za-z0-9_-]{32}$/.test(id) ? await store.get('shares', id) : null;
  if (!doc || doc.owner !== tag) throw httpError(404, 'That link isn’t one of yours.');
  await store.remove('shares', id);
  res.json({ ok: true });
}));

/** Open a link: no account needed. Wrong codes are counted per address. */
app.get('/api/s/:code', route('Could not open that link.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex');
  const ip = ipKey(req);
  if (shareMisses.blocked(ip) || !shareReads.hit(ip)) throw httpError(429, 'Too many tries from here. Wait a few minutes.');
  const code = String(req.params.code || '');
  const id = CODE_RE.test(code) ? shareId(code) : null;
  const doc = id ? await store.get('shares', id) : null;
  if (!doc) { shareMisses.hit(ip); throw httpError(404, GONE); }
  if (expired(doc, Date.now())) { await store.remove('shares', doc.id); throw httpError(404, GONE); }
  const canon = canonOut(await store.get('canons', doc.owner));
  if (!canon) throw httpError(404, GONE);
  await store.bump('shares', doc.id, { opens: 1 }, { mustExist: true });
  res.json({ canon: Core.shareView(canon), expiresAt: doc.expiresAt });
}));
app.all('/api/s/:code', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'A shared canon is read-only.' }));

/* ------------------------------------------------------------------ *
 * Metered: draft definitions, explain an answer
 * ------------------------------------------------------------------ */

/** Gates, then the parser, then the request rebuilt field by field (a 400
 *  costs nothing), then one forced tool, then the answer checked against
 *  what was sent. Nothing here writes to the store, and nothing logged
 *  carries a word of the schema or the SQL. Not streamed: both answer in
 *  well under a minute. */
app.post('/api/draft', ...spend, draftJson, route('Drafting isn’t available right now. Try again in a minute - writing definitions by hand still works.', async (req, res) => {
  const sent = ai.draftRequest(req.body);
  const raw = await ai.draft(await clientFor(req), modelFor(req), sent);
  const out = Core.cleanDraft(raw, sent);
  if (!out.metrics.length) throw httpError(422, out.dropped.length ? 'Every definition that came back named a column that isn’t in your schema, so none were kept. Try again, or add more of the schema.' : 'That answer had nothing usable in it. Try again - writing definitions by hand is free.');
  res.set('Cache-Control', 'no-store');
  res.json({ ...out, sent: { tables: sent.tables.length, columns: sent.tables.reduce((n, t) => n + t.columns.length, 0) } });
}));

app.post('/api/explain', ...spend, explainJson, route('Explanations aren’t available right now. Try again in a minute - the check itself is free.', async (req, res) => {
  const sent = ai.explainRequest(req.body);
  const raw = await ai.explain(await clientFor(req), modelFor(req), sent);
  const out = Core.cleanExplanation(raw, sent);
  if (!out) throw httpError(422, 'That answer had nothing usable in it. Try again - the check itself is free.');
  res.set('Cache-Control', 'no-store');
  res.json({ explanation: out });
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A share link (s/<code>) is the same single-page app served one level down;
// <base href="../"> resolves every relative asset and API path against the
// app root, mounted or not. Its code must not ride out in a Referer header,
// and a shared canon should never be indexed.
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
app.all('/s/:code', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'A shared canon is read-only.' }));

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
  // CANON_DEV_MOUNT=/canon runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.CANON_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`canon listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, ownerTag, shareId, LIMITS };
