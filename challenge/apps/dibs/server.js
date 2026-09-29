// Dibs - split the bill by what everyone actually had.
//
// One person pays; then either everyone splits evenly (and the salad person
// subsidises the steak-and-cocktails person) or someone squints at the
// receipt doing tax-and-tip maths while the table waits. Dibs: paste or snap
// the receipt, share a QR code, everyone taps what they had on their own
// phone, and tax, tip and shared plates are split fairly to the cent, with a
// pay link to whoever paid. See CLAUDE.md.
//
// A model is used for ONE thing, metered and signed in: reading the lines off
// a photo of the receipt. Everything else is public/dibs-core.js and free.
// A bill on one phone needs no account at all (it lives in the browser);
// sharing it with the table needs a free account for the host, and none for
// the guests, who never trigger a model call.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/dibs-core');
const T = require('./lib/tables');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { streamedJson } = require('./lib/stream');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.DIBS_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('DIBS_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere in these pages: every app in the lab shares
  // one origin, so one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A table code is a key to the table. It must not ride out in a Referer
  // header, and a table page should never be indexed.
  if (/^\/t\//.test(req.path) || /^\/api\/table\//.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// One route carries more than 64 KB - snapping up to two receipt photos - and
// it mounts its own 12 MB parser AFTER sign-in, budget and the daily cap, so
// a stranger's body is never read.
const SNAP_ROUTE = /^\/api\/snap$/;
const snapJson = express.json({ limit: '12mb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => (SNAP_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'dibs',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Dibs',
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

const httpError = T.httpError;

// Only the app's own errors (marked `expose`) reach the client with their
// status and words. Anything else is logged - its stack's first lines only,
// never a body: a bill, a name or a photo is nobody's business - and
// answered with the route's fallback. An upstream failure (the SDK's errors
// carry a `.status` and a raw body of their own) is a 502, or 503 when the
// provider is overloaded or rate-limited.
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - or type or paste the receipt, which is free.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}

/* ------------------------------------------------------------------ *
 * Limits, per address, in memory (per instance: they slow a script, they
 * do not stop a determined one - CLAUDE.md says so)
 * ------------------------------------------------------------------ */

/** IPv6 counts by its /64: one phone on a carrier owns the whole block. */
function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':');
  return ip;
}
const newGuests = identityLib.createLimiter({ max: T.LIMITS.newGuestsPerIp, windowMs: T.LIMITS.newGuestsWindowMs });
const writes = identityLib.createLimiter({ max: T.LIMITS.writesPerIp, windowMs: T.LIMITS.writesWindowMs });

// A wrong code is counted once per DISTINCT code: a phone left open on a
// deleted table polls the same dead code every few seconds, and that is not
// guessing. Guessing needs many different codes.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > T.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, code) {
  const e = missState(ip);
  e.seen.add(code);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
const blockedByMisses = (ip) => missState(ip).seen.size >= T.LIMITS.missesPerIp;

/* ------------------------------------------------------------------ *
 * The guest's key: one random value per browser, HttpOnly, scoped to this
 * app's path. It is never stored - each table keeps sha256(key + code) -
 * and never shown to anyone.
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'dibs_k';
function readKey(req) {
  const m = /(?:^|;\s*)dibs_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = T.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}

function tagFor(req) {
  const secret = SECRET();
  if (!secret) throw httpError(503, 'Sharing is switched off on this server right now. Your bill still works on this phone.');
  return T.ownerTag(req.user.id, secret);
}
const isHost = (req, doc) => Boolean(req.user && SECRET() && doc.ownerTag === T.ownerTag(req.user.id, SECRET()));

/** The table, if the code names a live one. Expired tables are deleted on
 *  the read that finds them (there is no timer to do it). */
async function loadTable(req) {
  const ip = ipKey(req);
  if (blockedByMisses(ip)) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
  const code = T.normalizeCode(req.params.code);
  const doc = T.isCode(code) ? await store.get('tables', code) : null;
  if (!doc) {
    missed(ip, code);
    throw httpError(404, 'No table has that code. Check it with whoever paid - it’s on their screen under the QR code.');
  }
  if (T.expired(doc, Date.now())) {
    await store.remove('tables', code);
    throw httpError(404, 'This table has closed - tables last 14 days.', { code: 'expired' });
  }
  return doc;
}

/** Who is asking: {pid, host}. */
function actorOf(req, doc) {
  const host = isHost(req, doc);
  const key = readKey(req);
  const hash = key ? T.keyHash(key, doc.code) : null;
  const guest = hash ? doc.people.find((p) => p.keyHash === hash) : null;
  const hostPerson = host ? doc.people.find((p) => p.host) : null;
  return { host, pid: (hostPerson && hostPerson.id) || (guest && guest.id) || null };
}

/**
 * One change to one table, as a transaction: loaded fresh inside it, so two
 * phones calling dibs at once both stick. `fn(doc, actor)` changes the doc
 * in place (the rules in lib/tables.js) and may return extra fields for the
 * answer.
 */
async function change(req, fn) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
  await loadTable(req); // counts wrong codes, clears an expired table
  const code = T.normalizeCode(req.params.code);
  let extra = {};
  let actor = null;
  const saved = await store.transact('tables', code, (cur) => {
    if (!cur || T.expired(cur, Date.now())) throw httpError(404, 'This table has closed.');
    const doc = { ...cur };
    delete doc.id;
    actor = actorOf(req, doc);
    extra = fn(doc, actor) || {};
    return doc;
  });
  const me = extra.pid || actor.pid;
  return { ...T.view(saved, me, actor.host), ...(extra.out || {}) };
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, tablesPerHost: T.LIMITS.tablesPerHost, tableDays: 14 }, colors: Core.COLORS, currencies: Object.keys(Core.CURRENCIES) });
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
 * Metered: snap the receipt
 * ------------------------------------------------------------------ */

/**
 * Gates, then the 12 MB parser, then the photo checks (400s cost nothing) -
 * and only then the whitespace stream, after which a failure is a 200
 * {error}. The photos are read once and dropped; nothing here writes to the
 * store, and nothing logged carries a price or a byte of a photo.
 */
app.post('/api/snap', ...spend, snapJson, async (req, res) => {
  let photos;
  try { photos = photo.validateAll((req.body || {}).photos); } catch (err) { return fail(res, err); }
  const send = streamedJson(res);
  try {
    const raw = await ai.readReceipt(await clientFor(req), modelFor(req), photos);
    const out = ai.cleanReceipt(raw);
    if (!out) throw httpError(422, 'No lines with prices could be read from that. Try a flatter, closer, well-lit photo - or type or paste the receipt.');
    send({ ...out, check: Core.check(out.bill), serviceNote: Core.serviceNote(out.bill) });
  } catch (err) { send(failure(err, 'The photo could not be read. Try again in a minute - or type or paste the receipt.').body); }
});

/* ------------------------------------------------------------------ *
 * Host: share a bill with the table (a free account; no model call)
 * ------------------------------------------------------------------ */

app.post('/api/tables', user, async (req, res) => {
  try {
    const tag = tagFor(req);
    const b = req.body || {};
    const mine = await store.list('tables', { where: [['ownerTag', '==', tag]], limit: T.LIMITS.tablesPerHost * 3 });
    const now = Date.now();
    const live = [];
    for (const d of mine) { if (T.expired(d, now)) await store.remove('tables', d.id); else live.push(d); }
    if (live.length >= T.LIMITS.tablesPerHost) throw httpError(409, `You can have ${T.LIMITS.tablesPerHost} tables open at once. Delete an old one first.`);
    let code = null;
    for (let i = 0; i < 8 && !code; i++) {
      const c = T.newCode();
      if (!(await store.get('tables', c))) code = c;
    }
    if (!code) throw httpError(503, 'Could not make a table code. Try again.');
    const doc = T.create({ code, tag, bill: b.bill, people: b.people, claims: b.claims, everyone: b.everyone, hostPid: typeof b.hostPid === 'string' ? b.hostPid : null, now });
    await store.transact('tables', code, (cur) => { if (cur) throw httpError(409, 'That code was just taken. Try again.'); return doc; });
    res.json(T.view(doc, doc.people.find((p) => p.host).id, true));
  } catch (err) { fail(res, err, 'Could not share the bill. It is still on this phone.'); }
});

app.get('/api/tables', user, async (req, res) => {
  try {
    const tag = tagFor(req);
    const now = Date.now();
    const rows = [];
    for (const d of await store.list('tables', { where: [['ownerTag', '==', tag]], limit: T.LIMITS.tablesPerHost * 3 })) {
      if (T.expired(d, now)) { await store.remove('tables', d.id); continue; }
      rows.push(T.summaryOf(d));
    }
    res.set('Cache-Control', 'no-store');
    res.json({ tables: rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), limit: T.LIMITS.tablesPerHost });
  } catch (err) { fail(res, err); }
});

/** A host route: the table, if this account runs it - else the 404 a
 *  missing code gets, so nobody learns another host's table exists. */
async function hostChange(req, res, fn) {
  const doc = await loadTable(req);
  if (!isHost(req, doc)) throw httpError(404, 'No table has that code.');
  return change(req, (d, actor) => { if (!actor.host) throw httpError(404, 'No table has that code.'); return fn(d, actor); });
}

app.put('/api/tables/:code', user, async (req, res) => {
  try { res.json(await hostChange(req, res, (d, a) => { T.replaceBill(d, a, (req.body || {}).bill, Date.now()); })); } catch (err) { fail(res, err, 'Could not save the bill.'); }
});
app.post('/api/tables/:code/lock', user, async (req, res) => {
  try { res.json(await hostChange(req, res, (d, a) => { T.lock(d, a, (req.body || {}).locked !== false, Date.now()); })); } catch (err) { fail(res, err); }
});
app.post('/api/tables/:code/people', user, async (req, res) => {
  try {
    res.json(await hostChange(req, res, (d, a) => { const r = T.addPerson(d, a, req.body || {}, Date.now()); return { out: { added: r.pid } }; }));
  } catch (err) { fail(res, err); }
});
app.delete('/api/tables/:code/people/:pid', user, async (req, res) => {
  try { res.json(await hostChange(req, res, (d, a) => { T.removePerson(d, a, { pid: req.params.pid, release: req.query.release === '1' }, Date.now()); })); } catch (err) { fail(res, err); }
});
app.post('/api/tables/:code/everyone', user, async (req, res) => {
  try { res.json(await hostChange(req, res, (d, a) => { T.everyone(d, a, req.body || {}, Date.now()); })); } catch (err) { fail(res, err); }
});
app.delete('/api/tables/:code', user, async (req, res) => {
  try {
    const doc = await loadTable(req);
    if (!isHost(req, doc)) throw httpError(404, 'No table has that code.');
    await store.remove('tables', doc.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The table: guests need no account
 * ------------------------------------------------------------------ */

/** Poll: the table as this browser sees it. `?since=<v>` answers
 *  {same: true} when nothing moved, so an idle table costs one small read. */
app.get('/api/table/:code', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const doc = await loadTable(req);
    const since = Number(req.query.since);
    const actor = actorOf(req, doc);
    if (Number.isInteger(since) && since === (doc.v || 0)) return res.json({ same: true, v: doc.v || 0, me: actor.pid, host: actor.host });
    res.json(T.view(doc, actor.pid, actor.host));
  } catch (err) { fail(res, err); }
});

app.post('/api/table/:code/join', async (req, res) => {
  try {
    const b = req.body || {};
    const ip = ipKey(req);
    // Refuse before anything is written when this address has added too
    // many new guests; a browser re-joining as itself costs nothing.
    const doc = await loadTable(req);
    const key = readKey(req);
    const already = key && doc.people.some((p) => p.keyHash === T.keyHash(key, doc.code));
    if (!already && isHost(req, doc)) throw httpError(409, 'You’re running this table - you’re already at it.');
    if (!already && newGuests.blocked(ip)) throw httpError(429, 'Too many new guests from here. Try again later.');
    const k = mintKey(req, res);
    const hash = T.keyHash(k, doc.code);
    let isNew = false;
    const out = await change(req, (d) => {
      const r = T.join(d, { hash, pid: typeof b.pid === 'string' ? b.pid : null, name: b.name, color: b.color }, Date.now());
      isNew = r.isNew;
      return { pid: r.pid };
    });
    if (isNew) newGuests.hit(ip);
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.post('/api/table/:code/claim', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await change(req, (d, a) => { T.claim(d, a, { itemId: String(b.itemId || ''), pid: typeof b.pid === 'string' ? b.pid : null, weight: b.weight }, Date.now()); }));
  } catch (err) { fail(res, err); }
});

app.post('/api/table/:code/person', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await change(req, (d, a) => { T.person(d, a, { pid: typeof b.pid === 'string' ? b.pid : null, name: b.name, color: b.color }, Date.now()); }));
  } catch (err) { fail(res, err); }
});

app.post('/api/table/:code/paid', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await change(req, (d, a) => { T.paid(d, a, { pid: typeof b.pid === 'string' ? b.pid : null, paid: b.paid !== false, confirmed: b.confirmed }, Date.now()); }));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A table link (t/<code>) is the same single-page app served one level down.
// <base href="../"> makes every relative asset and API path in it resolve
// against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function tableIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/t/:code', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(tableIndex());
});
app.all('/t/:code', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Try one photo, or a smaller one.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // DIBS_DEV_MOUNT=/dibs runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.DIBS_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`dibs listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
