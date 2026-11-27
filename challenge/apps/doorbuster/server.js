// Doorbuster - will this deal make money? The small shop's sale, turned
// into numbers before the sign goes up, then counted at the counter on the
// day. See CLAUDE.md.
//
// What the server does:
//
//   - serves the page (and its service worker, so the page opens with the
//     network off once it has loaded);
//   - holds a SHARED sale: one versioned document with the shop's and the
//     sale's names, its days, the items (price, unit cost, usual sales,
//     stock), the deals and the tally. The owner starts it with no account;
//     staff join with a six-character code and a first name; a browser is
//     recognised by an HttpOnly key, stored only as a hash per sale. Every
//     change goes through one door (DoorbusterCore.act) inside a
//     transaction, so every phone's +1 lands. A sale goes 30 days after its
//     last day, on read;
//   - sends each phone only what it may see: STAFF NEVER RECEIVE a unit
//     cost, a usual-sales figure, a margin, a break-even or a profit - the
//     view is cut down here (DoorbusterCore.view), not on the page;
//   - signed in (free): a member may keep a sale on their account, so it
//     opens on their other phone - filed under HMACs of the account id,
//     never the id or the email;
//   - signed in, metered: "Fill from a price list" - ONE model call that
//     reads a pasted price list or supplier invoice, or a photo of one,
//     into draft items the owner checks before saving. Nothing of the list
//     is kept;
//   - the shared account (sign-in) at /api/auth.
//
// NO SUM IS STORED AND NONE IS A MODEL'S: the break-even, the verdict, the
// safer shapes and the sign's words are DoorbusterCore's rules, worked out
// from the items and deals on every draw, the same on every phone.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/doorbuster-core');
const G = require('./lib/sales');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.DOORBUSTER_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('DOORBUSTER_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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
  // Join codes travel in the address's #fragment, which is never sent
  // anywhere - and nothing here needs a Referer either.
  res.set('Referrer-Policy', 'no-referrer');
  if (/^\/api\/(s|sales|join|mine|read)(\/|$)/.test(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Writes come from this app's own page: a JSON body, and never a request a
// browser marks as coming from another site.
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

// The metered route mounts its own 9 MB parser (one photo, shrunk on
// the phone, fits in well under it) AFTER sign-in, budget and the daily
// cap, so a stranger's body is never read. Everything else is a few bytes.
const readJson = express.json({ limit: '9mb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (req.path === '/api/read' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (keeping a sale across phones, and the one
 * metered route, need it; nothing else does)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'doorbuster',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Doorbuster',
  mountPath: '/api/auth',
});
identity.mount(app);

const fakeClient = FAKE_AI ? require('./lib/fakeai').create() : null;
const sharedClient = identity.meter(FAKE_AI ? fakeClient : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
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
 * body - and answered with the route's fallback. A provider error is a
 * 502, or 503 when busy; its own words never reach the page.
 * ------------------------------------------------------------------ */

const httpError = G.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n').replace(/\{.*$/gm, '') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  const body = { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - typing the items in still works.' : fallback) };
  if (mine && err.code) body.code = err.code;
  return { status, body };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address or member, in memory (per instance: they slow a
 * script, they do not stop a determined one - CLAUDE.md says so)
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
const lim = (max, windowMs) => identityLib.createLimiter({ max, windowMs });
const L = G.LIMITS;
const newSales = lim(L.salesPerIp, L.salesWindowMs);
const newMembers = lim(L.newMembersPerIp, L.newMembersWindowMs);
const ipWrites = lim(L.writesPerIp, L.writesWindowMs);
const memberWrites = lim(L.writesPerMember, L.writesMemberWindowMs);

// A wrong code or id counts once per DISTINCT value: a phone left open on a
// sale that closed polls the same dead id, and that is not guessing.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > L.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(req, what) {
  const ip = ipKey(req);
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= L.missesPerIp) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!ipWrites.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
}
function writeGate(doc, mid) {
  if (!memberWrites.hit(`${doc.id}:${mid}`)) throw httpError(429, 'That’s a lot of taps. Wait a few minutes and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking: this browser's key (an HttpOnly cookie, 22 characters,
 * stored only as sha256(key + sale id)) - or, signed in, the seat
 * they kept on their account.
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'doorbuster_k';
function readKey(req) {
  const m = /(?:^|;\s*)doorbuster_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = G.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  req.headers.cookie = `${req.headers.cookie ? `${req.headers.cookie}; ` : ''}${KEY_COOKIE}=${key}`;
  return key;
}
const seatOf = (req, gid) => (req.user && SECRET() ? G.seatTag(req.user.id, gid, SECRET()) : null);
const actor = (req, doc) => G.actorOf(doc, readKey(req), seatOf(req, doc.id));

// Unknown, expired and never-yours all read the same, word for word, so
// nobody learns whether a sale id is real.
const GONE = 'This sale isn’t here any more. It may have been deleted, or it closed a month after its last day.';
const NO_CODE = 'No sale has that code. Check it with the owner - it’s on their screen under Team.';
const HOST_ONLY = 'Only the owner of this sale can do that.';
const today = () => Core.utcDay(Date.now());

/** The sale, if the id names a live one. One past its keep-by day is
 *  deleted by the read that finds it (there is no timer). */
async function loadSale(req) {
  checkMisses(req);
  const gid = String(req.params.id || '');
  const doc = Core.isGid(gid) ? await store.get('sales', gid) : null;
  if (!doc) { missed(req, `g:${gid.slice(0, 20)}`); throw httpError(404, GONE, { code: 'gone' }); }
  if (Core.expired(doc, today())) { await store.remove('sales', doc.id); throw httpError(404, GONE, { code: 'gone' }); }
  return doc;
}
/** The sale and which member is asking - a stranger gets the same 404 a
 *  sale that does not exist gets. A member who left is a stranger. */
async function memberSale(req) {
  const doc = await loadSale(req);
  const mid = actor(req, doc);
  if (!mid || doc.members[mid].left) throw httpError(404, GONE, { code: 'gone' });
  return { doc, mid };
}
// What this phone may see: the owner everything, staff no cost, no usual
// figure, no margin. Every answer that carries a sale goes through here.
const viewOf = (doc, mid) => Core.view(doc, mid);
const fresh = async (id) => store.get('sales', id);

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), keep: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * A sale: no account
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = G.newCode();
    if (!(await store.list('sales', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}
const newIds = (prefix, n) => Array.from({ length: n }, () => Core.newId(G.rand, 8, prefix));

/** Start a sale: the owner's first name, the shop, the sale's days, the
 *  currency symbol and the usual margin - and, if sent, the first items
 *  (each cleaned like any other; one bad item refuses the lot). */
app.post('/api/sales', route('Could not start the sale.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (newSales.blocked(ip)) throw httpError(429, `That’s ${L.salesPerIp} sales from here this hour. Try again later.`);
  const b = req.body || {};
  const name = Core.cleanName(b.name);
  if (!name) throw httpError(400, 'Type your first name, so your staff know who the owner is.');
  const g = Core.cleanSale(b, today());
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const gid = G.newGid();
  const mid = Core.newId(G.rand, 8, 'm');
  const list = Array.isArray(b.items) ? b.items : [];
  if (list.length > Core.LIMITS.items) throw httpError(400, `A sale holds up to ${Core.LIMITS.items} items.`);
  const items = {};
  list.forEach((raw, i) => { const it = Core.cleanItem(raw); it.ts = now + i; items[Core.newId(G.rand, 8, 'i')] = it; });
  const key = mintKey(req, res);
  const doc = {
    code: await freshCode(), ...g, v: 1,
    members: { [mid]: { name, c: 0, keyHash: G.keyHash(key, gid), joinedAt: stamp, host: true } },
    items, deals: {}, tally: {}, taps: {}, createdAt: stamp, updatedAt: stamp,
  };
  await store.transact('sales', gid, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  newSales.hit(ip);
  res.set('Cache-Control', 'no-store');
  res.json({ id: gid, g: viewOf({ ...doc, id: gid }, mid) });
}));

async function byCode(req) {
  checkMisses(req);
  const code = Core.normalizeCode(req.params.code);
  const rows = Core.isCode(code) ? await store.list('sales', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(req, `j:${code}`); throw httpError(404, NO_CODE); }
  if (Core.expired(doc, today())) { await store.remove('sales', doc.id); throw httpError(404, NO_CODE); }
  return doc;
}

/** What a code opens before joining: the shop, the sale's name, its days
 *  and how many are in - no item, no deal, no other name. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await byCode(req);
  const mid = actor(req, doc);
  res.json({ shop: doc.shop, title: doc.title, when: Core.dateRange(doc.from, doc.to), members: G.memberCount(doc), full: G.memberCount(doc) >= Core.LIMITS.members, already: mid && !doc.members[mid].left ? doc.id : null });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await byCode(req);
  const pre = actor(req, doc);
  if (pre && !doc.members[pre].left) return res.json({ id: doc.id, isNew: false });
  const name = Core.cleanName(b.name);
  if (!name) throw httpError(400, 'Type your first name, so the shop knows who is who.');
  if (newMembers.blocked(ip)) throw httpError(429, 'Too many new people from here. Try again later.');
  const key = mintKey(req, res);
  const hash = G.keyHash(key, doc.id);
  const seat = seatOf(req, doc.id);
  const mid = Core.newId(G.rand, 8, 'm');
  let mine = null;
  await store.transactKeys('sales', doc.id, (cur) => {
    if (!cur) throw httpError(404, NO_CODE);
    const already = G.actorOf(cur, key, seat);
    if (already && !cur.members[already].left) { mine = already; return undefined; }
    const now = Date.now();
    if (already) { mine = already; return { set: { [`members.${already}.left`]: false, ...G.touch(cur, now) }, del: [] }; }
    if (G.memberCount(cur) >= Core.LIMITS.members) throw httpError(409, `This sale has ${Core.LIMITS.members} people - that’s the most one can have.`);
    mine = mid;
    return { set: { [`members.${mid}`]: { name: G.uniqueName(cur, name), c: G.freeColor(cur), keyHash: hash, joinedAt: new Date(now).toISOString() }, ...G.touch(cur, now) }, del: [] };
  });
  if (mine === mid) newMembers.hit(ip);
  res.json({ id: doc.id, isNew: mine === mid });
}));

/** Poll: `?since=<v>` answers {same: true} when nothing moved. */
app.get('/api/s/:id', route('Could not load the sale.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, mid } = await memberSale(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (doc.v || 0)) return res.json({ same: true, v: doc.v || 0 });
  res.json({ g: viewOf(doc, mid) });
}));

/** Every change: an item, a deal, its goal, a kinder shape and its undo,
 *  the sale's details (the owner) - and the tally (anyone on the sale: +1,
 *  or -1 to undo a tap of their own). One door (DoorbusterCore.act), run
 *  inside a transaction on the current document, writing only the keys it
 *  names - so every phone's tap lands, and a tally can never pass the
 *  stock. */
app.post('/api/s/:id/act', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberSale(req);
  writeGate(doc, mid);
  const action = (req.body || {}).action;
  const t = action && typeof action === 'object' ? action.t : '';
  const ids = newIds(t === 'adddeal' ? 'd' : 'i', t === 'additems' ? Core.LIMITS.batch : 1);
  await store.transactKeys('sales', doc.id, (cur) => {
    if (!cur || !cur.members[mid] || cur.members[mid].left) throw httpError(404, GONE, { code: 'gone' });
    const now = Date.now();
    const change = Core.act(cur, mid, action, { now, ids, today: today() });
    return { set: { ...change.set, ...G.touch(cur, now) }, del: change.del };
  });
  res.set('Cache-Control', 'no-store');
  const out = await fresh(doc.id);
  res.json({ g: viewOf(out, mid), ...(t === 'additem' || t === 'adddeal' ? { id: ids[0] } : {}) });
}));

/** Remove a member (the owner). Their taps stay counted - the sales
 *  happened. */
app.delete('/api/s/:id/members/:mid', route('Could not remove them.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberSale(req);
  if (!G.isHost(doc, mid)) throw httpError(403, HOST_ONLY, { code: 'not-owner' });
  const who = String(req.params.mid || '');
  if (who === mid) throw httpError(409, 'To stop, delete the sale.');
  if (!Core.own(doc.members, who)) throw httpError(404, 'They aren’t on this sale any more.');
  await store.transactKeys('sales', doc.id, (cur) => (cur && Core.own(cur.members, who) ? { set: G.touch(cur, Date.now()), del: [`members.${who}`, `taps.${who}`] } : undefined));
  res.json({ g: viewOf(await fresh(doc.id), mid) });
}));

/** Leave (staff). */
app.delete('/api/s/:id/me', route('Could not leave.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberSale(req);
  if (G.isHost(doc, mid)) throw httpError(409, 'You own this sale - delete it instead.');
  await store.transactKeys('sales', doc.id, (cur) => (cur && cur.members && cur.members[mid] ? { set: { [`members.${mid}.left`]: true, ...G.touch(cur, Date.now()) }, del: [] } : undefined));
  await forget(req, doc.id);
  res.json({ ok: true });
}));

/** Delete the sale now (the owner): everything in it is gone. */
app.delete('/api/s/:id', route('Could not delete the sale.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberSale(req);
  if (!G.isHost(doc, mid)) throw httpError(403, HOST_ONLY, { code: 'not-owner' });
  await store.remove('sales', doc.id);
  await forget(req, doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Signed in, free: keep a sale on the account
 *
 *   sales/<id>.members.<mid>.owner = HMAC(account id + sale id)
 *   mine/<tag> = {s: {<sale id>: {shop, title, from, to, at}}}
 *
 * The tag is an HMAC of the account id under a key derived from the
 * session secret - never the id or the email. With both in place the same
 * person on another phone, signed in, is the same member (the owner is
 * still the owner).
 * ------------------------------------------------------------------ */

const keepWrites = lim(60, 10 * 60 * 1000);
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Keeping sales on an account isn’t available right now. This phone still has them.');
  if (write && !keepWrites.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes.');
  return G.ownerTag(req.user.id, SECRET());
}
async function forget(req, gid) {
  if (!req.user || !SECRET()) return;
  try {
    await store.transact('mine', G.ownerTag(req.user.id, SECRET()), (cur) => {
      if (!cur || !cur.s || !Core.own(cur.s, gid)) return undefined;
      const s = { ...cur.s }; delete s[gid];
      return { ...cur, s };
    });
  } catch (e) { console.error('forget failed'); }
}

app.get('/api/mine', identity.requireUser, route('Could not load your sales.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await store.get('mine', tagOf(req, false));
  const s = (doc && doc.s) || {};
  res.json({ list: Object.keys(s).filter(Core.isGid).map((id) => ({ id, shop: Core.line(s[id].shop, Core.LIMITS.shop), title: Core.line(s[id].title, Core.LIMITS.title), from: Core.isDay(s[id].from) ? s[id].from : '', to: Core.isDay(s[id].to) ? s[id].to : '', at: Number(s[id].at) || 0 })).sort((a, b) => b.at - a.at) });
}));

app.post('/api/s/:id/keep', identity.requireUser, route('Could not keep it on your account. This phone still has it.', async (req, res) => {
  const tag = tagOf(req, true);
  const { doc, mid } = await memberSale(req);
  const seat = seatOf(req, doc.id);
  if (!G.same(doc.members[mid].owner, seat)) {
    // No `v` bump: nothing anyone is shown changed.
    await store.transactKeys('sales', doc.id, (cur) => (cur && cur.members && cur.members[mid] ? { set: { [`members.${mid}.owner`]: seat }, del: [] } : undefined));
  }
  const now = Date.now();
  await store.transact('mine', tag, (cur) => {
    const s = { ...((cur && cur.s) || {}) };
    s[doc.id] = { shop: doc.shop, title: doc.title, from: doc.from, to: doc.to, at: now };
    const ids = Object.keys(s).sort((a, b) => (Number(s[b].at) || 0) - (Number(s[a].at) || 0));
    for (const id of ids.slice(L.kept)) delete s[id];
    return { owner: tag, s, updatedAt: now };
  });
  res.json({ ok: true });
}));

app.delete('/api/mine/:id', identity.requireUser, route('Could not remove it.', async (req, res) => {
  tagOf(req, true);
  const gid = String(req.params.id || '');
  if (!Core.isGid(gid)) throw httpError(400, 'That is not a sale.');
  await forget(req, gid);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Fill from a price list"
 *
 * Gates (sign-in, budget, the free tier's daily ceiling), then the 9 MB
 * parser, then the request checked (a 400 costs nothing), then the lab's
 * AI guard (the month's cap for Claude and the burst limits, when the host
 * has one), then ONE call with a forced tool. Nothing here writes to the
 * store, and nothing logged carries a byte of the list. Not streamed: one
 * page reads in seconds.
 * ------------------------------------------------------------------ */

const READ_FALLBACK = 'The list could not be read right now. Try again in a minute - or type the items in.';
const NOTHING = 'No items could be read from that. Try a sharper photo, or paste the part with the items and the prices - or type them in.';

async function guardAllow(req) {
  const guard = global.LAB_AI_GUARD;
  if (!guard) return;
  const a = await guard.allow({ provider: 'claude', req, app: 'doorbuster' });
  if (!a || !a.ok) throw httpError((a && a.status) || 503, `${(a && a.message) || 'AI is resting for now.'} Typing the items in still works.`, { code: (a && a.code) || 'ai-guard' });
}
/** Tell the guard what a call cost. Never fails the answer it measured. */
async function guardRecord(model, usage) {
  const guard = global.LAB_AI_GUARD;
  if (!guard || !usage) return;
  try { await guard.record({ provider: 'claude', app: 'doorbuster', usd: guard.priceUsd({ provider: 'claude', model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) }); } catch (e) { console.error('ai guard: record failed'); }
}

app.post('/api/read', ...spend, readJson, route(READ_FALLBACK, async (req, res) => {
  const b = ai.brief(req.body, photo);
  await guardAllow(req);
  const client = await clientFor(req);
  const model = modelFor(req);
  let used = null;
  let drafts;
  try {
    drafts = ai.cleanDrafts(await ai.read(client, model, b, (u) => { used = u; }));
  } finally {
    // A member's own key paid for theirs; the lab's cap counts the lab's key.
    if (!client.__byok) await guardRecord(model, used);
  }
  if (!drafts) throw httpError(422, NOTHING, { code: 'nothing' });
  res.set('Cache-Control', 'no-store');
  res.json({ drafts });
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const INDEX = path.join(__dirname, 'public', 'index.html');
// The service worker is always re-checked, so a new deploy's worker is
// picked up on the next visit.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
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
  // DOORBUSTER_DEV_MOUNT=/doorbuster runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.DOORBUSTER_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`doorbuster listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, misses, fakeClient, LIMITS: G.LIMITS, MODELS };
