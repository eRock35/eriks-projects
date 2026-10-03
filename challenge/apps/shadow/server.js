// Shadow - find the software your team signed up for without asking.
//
// Staff sign up for free trials with a work email or the company card; the
// trial converts, the tool fills with customer, staff or student data, and
// nobody approved it, owns it, or has a contract or data agreement for it.
// Shadow finds those tools - from the card statement and the sign-in export
// an admin can already download, read IN THE BROWSER and never uploaded -
// scores the risk, lists the fixes that lower it most, watches trials and
// renewals, and gives staff a front door to ask "can I use this?". See
// CLAUDE.md.
//
// THE CSV FILES NEVER REACH THIS SERVER. They are read in the browser by
// public/shadow-core.js; there is no route here that accepts one. What the
// server does:
//   - serves the page;
//   - keeps up to three inventories per account (tools only: never a
//     transaction, a statement or an export), and each one's request link;
//   - takes staff requests through that link, with no account, and lets the
//     owner approve or decline them;
//   - ONE metered, signed-in model call: reading a vendor's terms. The text
//     is read once and dropped.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/shadow-core');
const O = require('./lib/orgs');
const ai = require('./lib/ai');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.SHADOW_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('SHADOW_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  // No inline script anywhere in these pages: every app in the lab shares
  // one origin, so one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Two kinds of route carry more than 128 KB, and each mounts its own parser
// AFTER its gates, so a stranger's body is never read: reading a vendor's
// terms (up to 60,000 characters) behind sign-in, budget and the daily cap;
// and saving an inventory (500 tools) behind sign-in.
const TERMS_ROUTE = /^\/api\/terms$/;
const SAVE_ROUTE = /^\/api\/orgs(\/o[0-9a-f]{12})?$/;
const termsJson = express.json({ limit: '512kb' });
const saveJson = express.json({ limit: '1mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => ((TERMS_ROUTE.test(req.path) || (SAVE_ROUTE.test(req.path) && (req.method === 'POST' || req.method === 'PUT'))) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'shadow',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Shadow',
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
const user = identity.requireUser;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

const httpError = O.httpError;

// Only the app's own errors (marked `expose`) reach the client with their
// status and words. Anything else is logged - its stack's first lines only,
// never a body: an inventory names an organisation's tools, and pasted terms
// are nobody's business - and answered with the route's fallback. An
// upstream failure (the SDK's errors carry a `.status` and a raw body of
// their own) is a 502, or 503 when the provider is overloaded.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, ...O.LIMITS }, statuses: Core.STATUSES, data: Core.DATA, categories: Core.CAT_IDS, kinds: O.KINDS });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({
    signedIn: true,
    email: req.user.email,
    budget: identityLib.budgetFor(req.user),
    tier: identityLib.planFor(req.user, MODELS).tier,
  });
});

/* ------------------------------------------------------------------ *
 * Metered: read a vendor's terms
 * ------------------------------------------------------------------ */

/**
 * Gates, then the 512 KB parser, then the text checks (400s cost nothing) -
 * and only then the whitespace stream, after which a failure is a 200
 * {error}. The text is read once and dropped; nothing here writes to the
 * store, and nothing logged carries a word of it.
 */
app.post('/api/terms', ...spend, termsJson, async (req, res) => {
  const b = req.body || {};
  const text = typeof b.text === 'string' ? b.text.replace(/\u0000/g, '') : '';
  if (text.trim().length < Core.LIMITS.termsMin) return fail(res, httpError(400, 'Paste the vendor’s privacy policy, terms or DPA - at least a few paragraphs.'));
  if (text.length > Core.LIMITS.termsText) return fail(res, httpError(400, `That is more than ${Core.LIMITS.termsText.toLocaleString('en-US')} characters. Paste the privacy, data and renewal sections.`));
  const vendor = Core.clean(b.vendor, Core.LIMITS.name);
  const send = streamedJson(res);
  try {
    const raw = await ai.reviewTerms(await clientFor(req), modelFor(req), text, vendor);
    const out = Core.cleanTerms(raw, text);
    if (!out) throw httpError(422, 'That doesn’t read like a vendor’s terms or privacy policy. Paste the text from their legal page.');
    send({ review: out });
  } catch (err) { send(failure(err, 'The terms could not be read. Try again in a minute.').body); }
});

/* ------------------------------------------------------------------ *
 * Signed in, free: up to three inventories per account
 * ------------------------------------------------------------------ */

/**
 * One read-modify-write at a time per key on this instance, queued: a
 * double-tapped Save must not race itself, and a decision on a request must
 * not lose an edit made a second earlier.
 */
const locks = new Map();
async function exclusive(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}
const saves = identityLib.createLimiter({ max: O.LIMITS.savesPerUser, windowMs: O.LIMITS.savesWindowMs });
const orgsOf = (uid) => `orgs/${uid}/items`;

/** An org under its owner's uid: nobody else's id can name it, so every
 *  route is a 404 for anyone else's. */
async function loadOrg(req) {
  const id = String(req.params.id || '');
  const doc = O.ORG_ID_RE.test(id) ? await store.get(orgsOf(req.user.id), id) : null;
  if (!doc) throw httpError(404, 'No such inventory.');
  return doc;
}
async function openCount(rid) {
  if (!rid) return 0;
  return (await store.list(`requests/${rid}/items`, { where: [['status', '==', 'open']] })).length;
}
async function orgOut(id, doc) {
  const link = doc.rid ? await store.get('links', doc.rid) : null;
  return { org: O.viewOrg(id, doc), link: link ? { rid: doc.rid, accepting: link.accepting !== false } : null, open: await openCount(doc.rid) };
}

app.get('/api/orgs', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const rows = await store.list(orgsOf(req.user.id));
    res.json({ orgs: rows.map((d) => O.summary(d.id, d)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), limit: O.LIMITS.orgs });
  } catch (err) { fail(res, err, 'Could not load your inventories.'); }
});

/** A new inventory, with its request link. Only tool fields are kept -
 *  whatever else a request carries is dropped here. */
app.post('/api/orgs', user, saveJson, async (req, res) => {
  try {
    if (!saves.hit(req.user.id)) throw httpError(429, 'That’s a lot of saves. Wait a few minutes and try again.');
    const clean = O.cleanOrg(req.body, today());
    const out = await exclusive(`orgs/${req.user.id}`, async () => {
      const have = await store.list(orgsOf(req.user.id));
      if (have.length >= O.LIMITS.orgs) throw httpError(409, `An account keeps up to ${O.LIMITS.orgs} inventories. Delete one first.`);
      const id = O.newOrgId();
      const rid = O.newRid();
      const doc = { ...clean, rid, createdAt: now(), updatedAt: now() };
      await store.set('links', rid, { orgName: clean.name, accepting: true, createdAt: now() });
      await store.set(orgsOf(req.user.id), id, doc);
      return { id, doc };
    });
    res.status(201).json(await orgOut(out.id, out.doc));
  } catch (err) { fail(res, err, 'Could not save it. It is still on this device.'); }
});

app.get('/api/orgs/:id', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const doc = await loadOrg(req);
    res.json(await orgOut(req.params.id, doc));
  } catch (err) { fail(res, err); }
});

/** Save the whole inventory: tools (Core.toSaved), the fixes applied, the
 *  name. The request link and its requests are untouched. */
app.put('/api/orgs/:id', user, saveJson, async (req, res) => {
  try {
    if (!saves.hit(req.user.id)) throw httpError(429, 'That’s a lot of saves. Wait a few minutes and try again.');
    const clean = O.cleanOrg(req.body, today());
    const saved = await exclusive(`org/${req.user.id}/${req.params.id}`, async () => {
      const cur = await loadOrg(req);
      const doc = { ...clean, rid: cur.rid, createdAt: cur.createdAt || now(), updatedAt: now() };
      await store.set(orgsOf(req.user.id), req.params.id, doc);
      if (cur.rid && cur.name !== clean.name) await store.merge('links', cur.rid, { orgName: clean.name });
      return doc;
    });
    res.json(await orgOut(req.params.id, saved));
  } catch (err) { fail(res, err, 'Could not save it. It is still on this device.'); }
});

app.delete('/api/orgs/:id', user, async (req, res) => {
  try {
    await exclusive(`org/${req.user.id}/${req.params.id}`, async () => {
      const cur = await loadOrg(req);
      if (cur.rid) {
        const reqs = await store.list(`requests/${cur.rid}/items`);
        for (const r of reqs) await store.remove(`requests/${cur.rid}/items`, r.id);
        await store.remove('links', cur.rid);
      }
      await store.remove(orgsOf(req.user.id), req.params.id);
    });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** Pause or reopen the request link. */
app.patch('/api/orgs/:id/link', user, async (req, res) => {
  try {
    const cur = await loadOrg(req);
    if (!cur.rid) throw httpError(404, 'This inventory has no request link.');
    await store.merge('links', cur.rid, { accepting: (req.body || {}).accepting !== false });
    res.json(await orgOut(req.params.id, cur));
  } catch (err) { fail(res, err); }
});

/** The owner's queue: open first, then the most recently decided. */
app.get('/api/orgs/:id/requests', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const cur = await loadOrg(req);
    const rows = cur.rid ? await store.list(`requests/${cur.rid}/items`) : [];
    const list = rows.map((r) => O.ownerView(r.id, r)).filter((r) => r.status !== 'withdrawn')
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(b.decidedAt || b.at).localeCompare(String(a.decidedAt || a.at)));
    res.json({ requests: list.slice(0, O.LIMITS.openRequests + 50), open: list.filter((r) => r.status === 'open').length });
  } catch (err) { fail(res, err); }
});

/**
 * Approve or decline one request. The request is marked in a transaction
 * (so two taps decide once), then the decision is folded into the
 * inventory (Core.applyDecision) under the inventory's lock.
 */
app.post('/api/orgs/:id/requests/:qid', user, async (req, res) => {
  try {
    const b = req.body || {};
    const decision = b.decision === 'approve' ? 'approve' : b.decision === 'decline' ? 'decline' : null;
    if (!decision) throw httpError(400, 'Approve or decline?');
    const conditions = Core.clean(b.conditions, Core.LIMITS.conditions);
    const qid = String(req.params.qid || '');
    const out = await exclusive(`org/${req.user.id}/${req.params.id}`, async () => {
      const cur = await loadOrg(req);
      if (!cur.rid || !O.QID_RE.test(qid)) throw httpError(404, 'No such request.');
      let decided = null;
      await store.transact(`requests/${cur.rid}/items`, qid, (r) => {
        if (!r || r.status === 'withdrawn') throw httpError(404, 'No such request.');
        if (r.status !== 'open') throw httpError(409, 'That request was already decided.');
        decided = { ...r, status: decision === 'approve' ? 'approved' : 'declined', conditions, decidedAt: now() };
        return decided;
      });
      const day = today();
      const fold = Core.applyDecision(cur.tools, O.ownerView(qid, decided), decision, conditions, day);
      const doc = { ...cur, tools: fold.tools.map(Core.toSaved), updatedAt: now() };
      delete doc.id;
      await store.set(orgsOf(req.user.id), req.params.id, doc);
      return { doc, toolId: fold.toolId, request: O.ownerView(qid, decided) };
    });
    res.json({ ...(await orgOut(req.params.id, out.doc)), request: out.request, toolId: out.toolId });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * "Can I use this?": staff need no account
 * ------------------------------------------------------------------ */

/** IPv6 counts by its /64: one phone on a carrier owns the whole block. */
function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':');
  return ip;
}
const newRequests = identityLib.createLimiter({ max: O.LIMITS.newRequestsPerIp, windowMs: O.LIMITS.newRequestsWindowMs });

// A wrong link is counted once per DISTINCT link: a page left open on a
// deleted inventory asks for the same dead link again and again, and that is
// not guessing. Guessing needs many different links.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > O.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, rid) {
  const e = missState(ip);
  e.seen.add(rid);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
const blockedByMisses = (ip) => missState(ip).seen.size >= O.LIMITS.missesPerIp;

/** The staff member's key: one random value per browser, HttpOnly, scoped
 *  to this app's path. Never stored - each request keeps sha256(key + rid). */
const KEY_COOKIE = 'shadow_k';
function readKey(req) {
  const m = /(?:^|;\s*)shadow_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = O.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 180}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}

async function loadLink(req) {
  const ip = ipKey(req);
  if (blockedByMisses(ip)) throw httpError(429, 'Too many wrong links from here. Try again in a few minutes.');
  const rid = String(req.params.rid || '');
  const link = O.RID_RE.test(rid) ? await store.get('links', rid) : null;
  if (!link) {
    missed(ip, rid);
    throw httpError(404, 'This request link doesn’t work any more. Ask whoever sent it for the current one.');
  }
  return { rid, link };
}
async function mine(rid, key) {
  if (!key) return [];
  const rows = await store.list(`requests/${rid}/items`, { where: [['keyHash', '==', O.keyHash(key, rid)]] });
  return rows.filter((r) => r.status !== 'withdrawn').map((r) => O.guestView(r.id, r)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** What a staff member's link shows: whose it is, and their own requests.
 *  Nothing from the inventory, nobody else's request. A GET never sets a
 *  cookie. */
app.get('/api/r/:rid', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { rid, link } = await loadLink(req);
    res.json({ org: { name: Core.clean(link.orgName, 80) }, accepting: link.accepting !== false, mine: await mine(rid, readKey(req)) });
  } catch (err) { fail(res, err); }
});

app.post('/api/r/:rid', async (req, res) => {
  try {
    const { rid, link } = await loadLink(req);
    if (link.accepting === false) throw httpError(409, 'This link isn’t taking requests right now. Ask your IT or operations lead directly.');
    const c = Core.cleanRequest(req.body);
    if (c.error) throw httpError(400, c.error);
    const ip = ipKey(req);
    if (newRequests.blocked(ip)) throw httpError(429, 'That’s a lot of requests from here. Try again in an hour.');
    const open = await store.list(`requests/${rid}/items`, { where: [['status', '==', 'open']] });
    if (open.length >= O.LIMITS.openRequests) throw httpError(429, 'This organisation has a lot of requests waiting. Ask your IT or operations lead directly.');
    const key = mintKey(req, res);
    const hash = O.keyHash(key, rid);
    if (open.filter((r) => r.keyHash === hash).length >= O.LIMITS.openPerGuest) throw httpError(429, `You have ${O.LIMITS.openPerGuest} requests waiting already. Wait for an answer first.`);
    newRequests.hit(ip);
    const qid = O.newQid();
    // The staff member asks as themselves: status, decision and conditions
    // are never taken from the body.
    await store.set(`requests/${rid}/items`, qid, { ...c.request, status: 'open', conditions: '', keyHash: hash, at: now(), decidedAt: null });
    res.status(201).json({ request: O.guestView(qid, { ...c.request, status: 'open', at: now() }), mine: await mine(rid, key) });
  } catch (err) { fail(res, err); }
});

/** Withdraw your own open request. Anyone else's is the 404 a wrong id gets. */
app.delete('/api/r/:rid/:qid', async (req, res) => {
  try {
    const { rid } = await loadLink(req);
    const key = readKey(req);
    const qid = String(req.params.qid || '');
    if (!key || !O.QID_RE.test(qid)) throw httpError(404, 'No such request.');
    await store.transact(`requests/${rid}/items`, qid, (r) => {
      if (!r || r.keyHash !== O.keyHash(key, rid) || r.status === 'withdrawn') throw httpError(404, 'No such request.');
      if (r.status !== 'open') throw httpError(409, 'That request was already decided.');
      return { ...r, status: 'withdrawn', decidedAt: now() };
    });
    res.json({ ok: true, mine: await mine(rid, key) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A request link (r/<rid>) is the same single-page app served one level
// down. <base href="../"> makes every relative asset and API path in it
// resolve against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function linkIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/r/:rid', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(linkIndex());
});
app.all('/r/:rid', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
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
  // SHADOW_DEV_MOUNT=/shadow runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.SHADOW_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`shadow listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
