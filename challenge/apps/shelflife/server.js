// Shelf Life - eat what's about to go off first, and stop binning food.
// See CLAUDE.md.
//
// A kitchen on one phone needs nothing from this server: the page keeps it in
// localStorage and runs public/shelf-core.js itself. The server is for a
// kitchen ONLINE, shared across phones: the host has a free account (so the
// kitchen is theirs to run and delete); everyone else joins by link, QR or a
// six-character code with a name and an emoji and no account.
//
// A model is used for TWO things, metered and signed in: reading a photo of
// the fridge or a receipt into a list of food, and a new recipe idea from
// what is going off. Everything else - the board, the dates, the recipes,
// the stats, the shopping nudge - is the core file and costs nothing.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/shelf-core');
const K = require('./lib/kitchens');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.SHELFLIFE_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('SHELFLIFE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A join code and a kitchen id are keys. They must not ride out in a
  // Referer header, and a kitchen page should never be indexed.
  if (/^\/(k|j)\//.test(req.path) || /^\/api\/(kitchens|join)\//.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// Two routes are metered and mount their own parser AFTER sign-in, budget
// and the daily cap, so a stranger's body is never read: Snap (a photo, 6 MB)
// and Chef's idea (a list of names, 64 KB). Putting a kitchen online carries
// its items and history, so that route gets 512 KB - also after its sign-in.
// Everything else 64 KB.
const OWN_PARSER = /^\/api\/(snap|idea)$/;
const bigJson = express.json({ limit: '6mb' });
const ideaJson = express.json({ limit: '64kb' });
const kitchenJson = express.json({ limit: '512kb' });
const smallJson = express.json({ limit: '64kb' });
app.use((req, res, next) => {
  if (OWN_PARSER.test(req.path)) return next();
  if (req.method === 'POST' && req.path === '/api/kitchens') return next();
  return smallJson(req, res, next);
});

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'shelflife',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Shelf Life',
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
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body: what is in someone's fridge is nobody's business - and answered
 * with the route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = K.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - adding by hand is free.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address, in memory (per instance: they slow a script, they
 * do not stop a determined one - CLAUDE.md says so)
 * ------------------------------------------------------------------ */

function ipKey(req) {
  const ip = identityLib.clientIp(req);
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 4).join(':'); // IPv6 by its /64
  return ip;
}
const newMembers = identityLib.createLimiter({ max: K.LIMITS.newMembersPerIp, windowMs: K.LIMITS.newMembersWindowMs });
const writes = identityLib.createLimiter({ max: K.LIMITS.writesPerIp, windowMs: K.LIMITS.writesWindowMs });

// A wrong code or kitchen id counts once per DISTINCT value: a phone left
// open on a deleted kitchen polls the same dead id every few seconds, and
// that is not guessing. Guessing needs many different codes.
const misses = new Map();
function missState(ip) {
  const e = misses.get(ip);
  if (!e || Date.now() - e.since > K.LIMITS.missWindowMs) return { since: Date.now(), seen: new Set() };
  return e;
}
function missed(ip, what) {
  const e = missState(ip);
  e.seen.add(what);
  misses.set(ip, e);
  if (misses.size > 10000) misses.delete(misses.keys().next().value);
}
function checkMisses(req) {
  if (missState(ipKey(req)).seen.size >= K.LIMITS.missesPerIp) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!writes.hit(ipKey(req))) throw httpError(429, 'That’s a lot of taps from here. Wait a minute and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking. A member is this browser (an HttpOnly key, stored only as
 * sha256(key + kitchen id)) or a signed-in account that holds a seat (an
 * HMAC tag). The host is the account that made the kitchen.
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'shelf_k';
function readKey(req) {
  const m = /(?:^|;\s*)shelf_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = K.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return key;
}
function tagOf(req) {
  if (!req.user) return null;
  const secret = SECRET();
  return secret ? K.acctTag(req.user.id, secret) : null;
}
function tagFor(req) {
  const tag = tagOf(req);
  if (!tag) throw httpError(503, 'Sharing a kitchen is switched off on this server right now.');
  return tag;
}

/** {mid, host} for this request in this kitchen. */
function actorOf(req, doc) {
  const tag = tagOf(req);
  const key = readKey(req);
  const hash = key ? K.keyHash(key, doc.id) : null;
  const m = (hash && doc.members.find((x) => x.keyHash === hash)) || (tag && doc.members.find((x) => x.acct === tag)) || null;
  return { mid: m ? m.id : null, host: Boolean(m && m.host && tag && doc.ownerTag === tag && m.acct === tag) };
}

/** The kitchen, if the id names a live one. One nobody has touched in 180
 *  days is deleted by the read that finds it (there is no timer). */
async function loadKitchen(req) {
  checkMisses(req);
  const id = String(req.params.kid || '');
  const doc = K.isKitchenId(id) ? await store.get('kitchens', id) : null;
  if (!doc) { missed(ipKey(req), `k:${id.slice(0, 20)}`); throw httpError(404, 'No kitchen here.'); }
  if (K.idle(doc, Date.now())) { await store.remove('kitchens', doc.id); throw httpError(404, 'This kitchen closed after six months with nothing new.', { code: 'expired' }); }
  return doc;
}
/** The kitchen and who is asking - and a stranger gets the same 404 a
 *  kitchen that does not exist gets, so nobody learns an id is real. */
async function memberKitchen(req) {
  const doc = await loadKitchen(req);
  const actor = actorOf(req, doc);
  if (!actor.mid) throw httpError(404, 'No kitchen here.');
  return { doc, actor };
}
const bundle = (doc, actor, extra) => ({ kitchen: K.view(doc, actor.mid, actor.host), ...(extra || {}) });

/** A change to the members or the name: a whole-document transaction (rare). */
async function kitchenChange(req, fn) {
  countWrite(req);
  const { doc } = await memberKitchen(req);
  let actor = null;
  const saved = await store.transact('kitchens', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'No kitchen here.');
    const d = JSON.parse(JSON.stringify(cur));
    actor = actorOf(req, d);
    if (!actor.mid) throw httpError(404, 'No kitchen here.');
    fn(d, actor);
    return d;
  });
  return { doc: saved, actor };
}

/** The busy writes - ate it, binned it, froze it, added, edited, cooked,
 *  undone: read the kitchen inside a transaction, let the core decide, then
 *  write ONLY the keys it changed (and the version). Two phones at once
 *  never write back a copy missing the other's change. */
async function kitchenWrite(req, fn) {
  countWrite(req);
  const { doc } = await memberKitchen(req);
  const now = Date.now();
  let out = null;
  let actor = null;
  await store.transactKeys('kitchens', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'No kitchen here.');
    actor = actorOf(req, cur);
    if (!actor.mid) throw httpError(404, 'No kitchen here.');
    out = fn(cur, { today: Core.localDate(now, cur.tz), now, rand: K.rand, by: actor.mid });
    return { set: { ...out.patch.set, ...K.touchKeys(cur, now) }, del: out.patch.del };
  });
  const fresh = await store.get('kitchens', doc.id);
  return bundle(fresh, actor, { msg: out.msg, ...(out.event ? { eid: out.event.id } : {}), ...(out.added ? { added: out.added } : {}) });
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: { ...Core.LIMITS, kitchensPerHost: K.LIMITS.kitchensPerHost }, catalogue: Core.CATALOGUE.length, recipes: Core.RECIPES.length, places: Core.PLACE_IDS });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: Snap, and Chef's idea
 * ------------------------------------------------------------------ */

/** Gates, then the 6 MB parser, then the photo checked (a 400 costs
 *  nothing), then one forced tool. The photo is read once and dropped;
 *  nothing here writes to the store. */
app.post('/api/snap', ...spend, bigJson, route('Snap is not available right now. Try again in a minute - adding by hand is free.', async (req, res) => {
  const b = req.body || {};
  const p = photo.validateAll([b.photo])[0];
  const today = Core.localDate(Date.now(), Core.cleanTz(b.tz));
  const raw = await ai.readFood(await clientFor(req), modelFor(req), { photo: p });
  const items = ai.cleanItems(raw, today);
  if (!items.length) throw httpError(422, 'No food came out of that photo. Try the open fridge in good light, or a receipt laid flat.');
  res.set('Cache-Control', 'no-store');
  res.json({ items });
}));

/** Gates, then a 64 KB parser, then the list checked, then one forced tool.
 *  The page sends what is in the kitchen (ids, names, days left) - for a
 *  kitchen on a phone there is nothing on the server to read. */
app.post('/api/idea', ...spend, ideaJson, route('No idea right now. Try again in a minute - the recipes on this page are free.', async (req, res) => {
  const b = req.body || {};
  const items = ai.cleanIdeaItems(b.items);
  if (!items.length) throw httpError(400, 'Add some food first - the idea is built from what you have.');
  const raw = await ai.proposeRecipe(await clientFor(req), modelFor(req), { items, avoid: ai.cleanAvoid(b.avoid) });
  const recipe = ai.cleanRecipe(raw, items);
  if (!recipe) throw httpError(422, 'That idea didn’t use anything in your kitchen. Try again.');
  res.set('Cache-Control', 'no-store');
  res.json({ recipe });
}));

/* ------------------------------------------------------------------ *
 * Kitchens: the host (a free account; no model call)
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = K.newCode();
    if (!(await store.list('kitchens', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

/** Put a phone's kitchen online: its name, items and history, and the
 *  host's own name and emoji. */
app.post('/api/kitchens', user, kitchenJson, route('Could not put the kitchen online.', async (req, res) => {
  countWrite(req);
  const tag = tagFor(req);
  const b = req.body || {};
  const mine = await store.list('kitchens', { where: [['ownerTag', '==', tag]], limit: K.LIMITS.kitchensPerHost * 2 });
  if (mine.length >= K.LIMITS.kitchensPerHost) throw httpError(409, `You can host ${K.LIMITS.kitchensPerHost} kitchens at once. Delete an old one first.`);
  const now = Date.now();
  const doc = K.create({ kitchen: b.kitchen, me: b.me, tz: b.tz, tag, now });
  doc.code = await freshCode();
  const id = K.newKitchenId();
  await store.transact('kitchens', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  const me = doc.members[0].id;
  res.json({ id, ...bundle({ ...doc, id }, { mid: me, host: true }) });
}));

/** Every kitchen this account hosts or holds a seat in. */
app.get('/api/kitchens', user, route('Could not load your kitchens.', async (req, res) => {
  const tag = tagFor(req);
  const now = Date.now();
  const rows = [];
  for (const d of await store.list('kitchens', { where: [['acctTags', 'array-contains', tag]], limit: 40 })) {
    if (K.idle(d, now)) { await store.remove('kitchens', d.id); continue; }
    rows.push({ id: d.id, name: d.name, members: d.members.length, items: Object.keys(d.items || {}).length, host: d.ownerTag === tag, updatedAt: d.updatedAt });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ kitchens: rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) });
}));

/** A host-only change: the host is recognised by account, so these need a
 *  sign-in - and anyone else gets the 404 a missing kitchen gets. */
const hostChange = (req, fn) => kitchenChange(req, (d, a) => { if (!a.host) throw httpError(404, 'No kitchen here.'); fn(d, a); });

app.patch('/api/kitchens/:kid', user, route('Could not rename the kitchen.', async (req, res) => {
  const { doc, actor } = await hostChange(req, (d, a) => { K.rename(d, a, (req.body || {}).name, Date.now()); });
  res.json(bundle(doc, actor));
}));

/** A new join code: the old link and QR stop working; nobody already in the
 *  kitchen is affected. */
app.post('/api/kitchens/:kid/code', user, route('Could not change the code.', async (req, res) => {
  const code = await freshCode();
  const { doc, actor } = await hostChange(req, (d) => { d.code = code; K.touch(d, Date.now()); });
  res.json(bundle(doc, actor));
}));

app.delete('/api/kitchens/:kid', user, route('Could not delete the kitchen.', async (req, res) => {
  countWrite(req);
  const { doc, actor } = await memberKitchen(req);
  if (!actor.host) throw httpError(404, 'No kitchen here.');
  await store.remove('kitchens', doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Joining: no account
 * ------------------------------------------------------------------ */

async function kitchenByCode(req) {
  checkMisses(req);
  const code = K.normalizeCode(req.params.code);
  const rows = K.isCode(code) ? await store.list('kitchens', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(ipKey(req), `j:${code}`); throw httpError(404, 'No kitchen has that code. Check it with whoever invited you - it’s under their QR code.'); }
  if (K.idle(doc, Date.now())) { await store.remove('kitchens', doc.id); throw httpError(404, 'That kitchen has closed.'); }
  return doc;
}

/** What a code opens: the kitchen's name and size. Not who is in it, and
 *  not what is in the fridge - that is for members. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await kitchenByCode(req);
  const a = actorOf(req, doc);
  res.json({ name: doc.name, members: doc.members.length, full: doc.members.length >= K.LIMITS.members, already: a.mid ? doc.id : null, takenEmoji: doc.members.map((m) => m.emoji) });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await kitchenByCode(req);
  const pre = actorOf(req, doc);
  if (!pre.mid && newMembers.blocked(ip)) throw httpError(429, 'Too many new people from here. Try again later.');
  const key = mintKey(req, res);
  const hash = K.keyHash(key, doc.id);
  const tag = tagOf(req);
  let r = null;
  await store.transact('kitchens', doc.id, (cur) => {
    if (!cur) throw httpError(404, 'That kitchen has closed.');
    const d = JSON.parse(JSON.stringify(cur));
    r = K.join(d, { hash, tag, name: b.name, emoji: b.emoji }, Date.now());
    return d;
  });
  if (r.isNew) newMembers.hit(ip);
  res.json({ kitchenId: doc.id, me: r.mid, isNew: r.isNew });
}));

/* ------------------------------------------------------------------ *
 * A kitchen, as its members see it
 * ------------------------------------------------------------------ */

/** Poll: `?since=<v>` answers {same: true} when nothing moved, so an idle
 *  kitchen costs one read. "Today" is worked out by each phone in the
 *  kitchen's time zone, so a new day needs no write. */
app.get('/api/kitchens/:kid', route('Could not load the kitchen.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, actor } = await memberKitchen(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (doc.v || 0)) return res.json({ same: true, v: doc.v || 0 });
  res.json(bundle(doc, actor));
}));

app.patch('/api/kitchens/:kid/members/:mid', route('Could not save that.', async (req, res) => {
  const { doc, actor } = await kitchenChange(req, (d, a) => { K.editMember(d, a, String(req.params.mid), req.body || {}, Date.now()); });
  res.json(bundle(doc, actor));
}));
/** The host removes someone, or someone leaves. What they did stays in the
 *  history (as an id the page shows as "someone who left"). */
app.delete('/api/kitchens/:kid/members/:mid', route('Could not remove them.', async (req, res) => {
  const mid = String(req.params.mid || '');
  const { doc, actor } = await kitchenChange(req, (d, a) => { K.remove(d, a, mid, Date.now()); });
  if (mid === actor.mid) return res.json({ ok: true, left: true });
  res.json(bundle(doc, actor));
}));

/* ------------------------------------------------------------------ *
 * Food: one or two keys per write, in a transaction
 * ------------------------------------------------------------------ */

const iidOf = (req) => String(req.params.iid || '');
const ACTIONS = ['open', 'freeze', 'thaw', 'extend'];

app.post('/api/kitchens/:kid/items', route('Could not add that.', async (req, res) => {
  const b = req.body || {};
  const list = Array.isArray(b.items) ? b.items : [b];
  res.json(await kitchenWrite(req, (cur, ctx) => Core.addItems(cur, list, ctx)));
}));

/** {action: open|freeze|thaw|extend, days?} or an edit {name, emoji, qty,
 *  place, use}. */
app.patch('/api/kitchens/:kid/items/:iid', route('Could not save that.', async (req, res) => {
  const b = req.body || {};
  if (b.action !== undefined && !ACTIONS.includes(b.action)) throw httpError(400, 'Open, freeze, thaw or extend.');
  res.json(await kitchenWrite(req, (cur, ctx) => {
    const iid = iidOf(req);
    if (b.action === 'open') return Core.open(cur, iid, ctx);
    if (b.action === 'freeze') return Core.freeze(cur, iid, ctx);
    if (b.action === 'thaw') return Core.thaw(cur, iid, ctx);
    if (b.action === 'extend') return Core.extend(cur, iid, b.days, ctx);
    return Core.editItem(cur, iid, b, ctx);
  }));
}));

/** Taken off by mistake: no history. */
app.delete('/api/kitchens/:kid/items/:iid', route('Could not take that off.', async (req, res) => {
  res.json(await kitchenWrite(req, (cur) => Core.removeItem(cur, iidOf(req))));
}));

/** Ate it / Binned it. */
app.post('/api/kitchens/:kid/items/:iid/done', route('Could not save that.', async (req, res) => {
  const outcome = String((req.body || {}).outcome || '');
  if (outcome !== 'ate' && outcome !== 'binned') throw httpError(400, 'Ate it or binned it.');
  res.json(await kitchenWrite(req, (cur, ctx) => Core.done(cur, iidOf(req), outcome, ctx)));
}));

/** Cook this: one of each chosen item eaten, under the dish's name. */
app.post('/api/kitchens/:kid/cook', route('Could not save that.', async (req, res) => {
  const b = req.body || {};
  res.json(await kitchenWrite(req, (cur, ctx) => Core.cook(cur, b.ids, b.title, ctx)));
}));

/** Undo an Ate it / Binned it. */
app.post('/api/kitchens/:kid/undo/:eid', route('Could not undo that.', async (req, res) => {
  const eid = String(req.params.eid || '');
  if (!Core.isEventId(eid)) throw httpError(404, 'Nothing to undo.');
  res.json(await kitchenWrite(req, (cur, ctx) => Core.undo(cur, eid, ctx)));
}));

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A kitchen link (k/<id>) and a join link (j/<code>) are the same
// single-page app served one level down; <base href="../"> resolves every
// relative asset and API path against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function deepIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
for (const p of ['/k/:id', '/j/:code']) {
  app.get(p, (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(deepIndex()); });
  app.all(p, (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));
}

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // Never log a parse error's message: V8 quotes the start of the body in it.
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once. Try a smaller photo.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 2).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // SHELFLIFE_DEV_MOUNT=/shelflife runs it the way the lab host does:
  // mounted under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.SHELFLIFE_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`shelflife listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
