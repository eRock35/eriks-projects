// Whichbox - which box is the kettle in? Label it, scan it, find it. See
// CLAUDE.md.
//
// EVERYTHING STAYS ON THE PHONE UNLESS ITS OWNER SHARES A MOVE. Boxes,
// contents, rooms, labels, search, moving day and storage are worked out in
// the browser by public/whichbox-core.js and kept in localStorage; photos of
// open boxes live in IndexedDB on the phone and never reach this server.
// What the server does:
//
//   - serves the page and its service worker;
//   - holds a SHARED move, only when its owner shares one: the move's name,
//     where it is going, its rooms and its boxes as TEXT (number, room,
//     contents, flags, note, status) - never a photo. Helpers join with a
//     six-character code and a first name, no account; the browser is
//     recognised by an HttpOnly key, stored only as a hash per move. Helpers
//     see and search everything and change a box's status; only the owner
//     edits, deletes and removes helpers. One document per box, so two
//     helpers ticking off two boxes at once both stick;
//   - ONE metered, signed-in model call: "List what's in this box", told
//     the one photo (shrunk on the phone, location removed) and nothing
//     else;
//   - the shared account (sign-in, credit) at /api/auth.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/whichbox-core');
const K = require('./lib/moves');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.WHICHBOX_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('WHICHBOX_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling. Both read a photo and take a
// forced tool.
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
  if (/^\/api\/(m|moves|join)(\/|$)/.test(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Writes come from this app's own page: a JSON body, and never a request a
// browser marks as coming from another site. (The shared account's routes
// check the same for themselves.)
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

// The routes that take more than a few KB mount their own parser AFTER the
// checks that decide whether the body is worth reading: the model call
// after sign-in, budget and the daily cap (a 1 MB photo is ~1.34 MB as
// base64); a batch of boxes after the owner check. Everything else 16 KB.
const aiJson = express.json({ limit: '1400kb' });
const batchJson = express.json({ limit: '256kb' });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(ai\/contents|m\/[A-Za-z0-9_-]{16}\/boxes)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (only the photo reader needs it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'whichbox',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Whichbox',
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
 * body or a photo: what is in somebody's boxes is nobody's business - and
 * answered with the route's fallback. A provider error is a 502, or 503
 * when it is busy.
 * ------------------------------------------------------------------ */

const httpError = K.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - typing the list always works.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
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
const L = K.LIMITS;
const newMoves = lim(L.movesPerIp, L.movesWindowMs);
const newHelpers = lim(L.newHelpersPerIp, L.newHelpersWindowMs);
const ipWrites = lim(L.writesPerIp, L.writesWindowMs);
const memberWrites = lim(L.writesPerMember, L.writesMemberWindowMs);

// A wrong code or id counts once per DISTINCT value: a phone left open on a
// move that stopped being shared polls the same dead id every few seconds,
// and that is not guessing. Guessing needs many different codes.
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

/** Photos stay on the phone that took them: any request carrying one -
 *  a photo field, a data: URL, a long base64 run - is refused whole. */
function noPhotos(body) {
  if (Core.carriesPhoto(body)) throw httpError(400, 'Photos stay on the phone that took them - send the boxes as text.', { code: 'photo' });
}

/* ------------------------------------------------------------------ *
 * Who is asking: this browser's key (an HttpOnly cookie, 22 characters,
 * stored only as sha256(key + move id)).
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'whichbox_k';
function readKey(req) {
  const m = /(?:^|;\s*)whichbox_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function mintKey(req, res) {
  const have = readKey(req);
  if (have) return have;
  const key = K.newKey();
  res.append('Set-Cookie', `${KEY_COOKIE}=${key}; Path=${req.baseUrl || ''}/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  req.headers.cookie = `${req.headers.cookie ? `${req.headers.cookie}; ` : ''}${KEY_COOKIE}=${key}`;
  return key;
}

// Unknown, expired and never-yours all read the same, word for word, so
// nobody learns whether a move id is real.
const GONE = 'This move isn’t shared here. Sharing may have been stopped, or it closed after 90 days with nobody opening it.';
const NO_CODE = 'No move has that code. Check it with whoever shared the move - it’s on their More page.';

/** Every document of a shared move: its boxes, then itself. */
async function purge(sid) {
  const boxes = await store.list('boxes', { where: [['move', '==', sid]] });
  await store.removeMany('boxes', boxes.map((b) => b.id));
  await store.remove('moves', sid);
}
/** The move, if the id names a live one. One nobody has opened or changed
 *  in 90 days is deleted by the read that finds it (there is no timer). */
async function loadMove(req, sidIn) {
  checkMisses(req);
  const sid = String(sidIn === undefined ? req.params.id || '' : sidIn);
  const doc = Core.isSid(sid) ? await store.get('moves', sid) : null;
  if (!doc) { missed(req, `m:${sid.slice(0, 20)}`); throw httpError(404, GONE, { code: 'gone' }); }
  if (K.idle(doc, Date.now())) { await purge(doc.id); throw httpError(404, GONE, { code: 'gone' }); }
  return doc;
}
/** The move and which member is asking - a stranger gets the same 404 a
 *  move that does not exist gets. */
async function memberMove(req) {
  const doc = await loadMove(req);
  const mid = K.actorOf(doc, readKey(req));
  if (!mid) throw httpError(404, GONE, { code: 'gone' });
  return { doc, mid };
}
async function boxesOf(sid) { return store.list('boxes', { where: [['move', '==', sid]] }); }
const OWNER_ONLY = 'Only whoever shared the move can do that. Helpers change a box’s status.';

/** Bump the version (and stamp the member's last activity) after a box
 *  changed, so phones polling with ?since=v notice. Returns {v, was}. */
async function touch(sid, mid) {
  let out = { v: 0, was: 0 };
  await store.transactKeys('moves', sid, (cur) => {
    if (!cur) return undefined;
    const t = K.touchKeys(cur, Date.now());
    out = { v: t.v, was: cur.v || 0 };
    const set = { ...t };
    if (mid && cur.members && cur.members[mid]) set[`members.${mid}.at`] = t.updatedAt;
    return { set, del: [] };
  });
  return out;
}
/** A box as members see it, with who last changed its status. */
function boxOut(doc, d) {
  const view = Core.sharedView(doc, [d], null, { now: Date.now() });
  return view.boxes[0] || null;
}
/** Opening a move counts as activity, so a household's shared loft does not
 *  expire while people still look at it - written at most every 6 hours. */
async function noteActive(doc) {
  if (Date.now() - K.lastActive(doc) < L.activeEveryMs) return;
  await store.transactKeys('moves', doc.id, (cur) => (cur ? { set: { activeAt: new Date().toISOString() }, del: [] } : undefined)).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier });
});

/* ------------------------------------------------------------------ *
 * Metered: "List what's in this box"
 * ------------------------------------------------------------------ */

/** Gates, then the parser, then the request rebuilt (only the photo,
 *  checked by its bytes - a 400 costs nothing), then one forced tool, then
 *  the answer checked. Nothing here writes to any store, and nothing logged
 *  carries a byte of the photo. */
app.post('/api/ai/contents', ...spend, aiJson, route('Listing a box from a photo isn’t available right now. Try again in a minute - typing the list always works.', async (req, res) => {
  const b = ai.brief(req.body);
  const raw = await ai.ask(await clientFor(req), modelFor(req), b);
  res.set('Cache-Control', 'no-store');
  res.json(ai.answer(raw));
}));

/* ------------------------------------------------------------------ *
 * Sharing a move: no account. The owner's phone sends the move's name,
 * rooms and (in batches) its boxes as text.
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = K.newCode();
    if (!(await store.list('moves', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

app.post('/api/moves', route('Could not share that move.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (newMoves.blocked(ip)) throw httpError(429, `That’s ${L.movesPerIp} shared moves from here this hour. Try again later.`);
  const b = req.body || {};
  noPhotos(b);
  const kind = Core.kindOf(b.kind);
  const rooms = Core.cleanRooms(b.rooms);
  if (!rooms.length) throw httpError(400, 'A move needs at least one room.');
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const key = mintKey(req, res);
  const sid = K.newMoveId();
  const mid = Core.newId(K.rand, 8);
  const doc = {
    name: Core.plain(b.name, Core.LIMITS.name) || Core.defaultName(kind, b.from, b.to),
    kind,
    from: kind === 'move' ? Core.plain(b.from, Core.LIMITS.place) : '',
    to: kind === 'move' ? Core.plain(b.to, Core.LIMITS.place) : '',
    rooms,
    code: await freshCode(),
    members: { [mid]: { name: Core.cleanName(b.you && b.you.name) || 'Owner', role: 'owner', keyHash: K.keyHash(key, sid), joinedAt: stamp, at: stamp } },
    nos: {},
    nextNo: 1,
    v: 1,
    createdAt: stamp, updatedAt: stamp, activeAt: stamp,
  };
  await store.transact('moves', sid, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  newMoves.hit(ip);
  res.set('Cache-Control', 'no-store');
  res.json({ id: sid, move: Core.sharedView({ ...doc, id: sid }, [], mid, { now }) });
}));

/** The owner's boxes, up to 50 a request, keeping their ids and numbers (a
 *  number already used is skipped and counted). The owner check runs
 *  before the 256 KB parser, so a stranger's body is never read. */
async function ownerGate(req, res, next) {
  try {
    countWrite(req);
    const { doc, mid } = await memberMove(req);
    if (!K.isOwner(doc, mid)) throw httpError(403, OWNER_ONLY);
    req.move = { doc, mid };
    next();
  } catch (err) { fail(res, err, 'Could not add those boxes.'); }
}
app.post('/api/m/:id/boxes', ownerGate, batchJson, route('Could not add those boxes.', async (req, res) => {
  const { doc, mid } = req.move;
  const b = req.body || {};
  noPhotos(b);
  if (!Array.isArray(b.boxes) || !b.boxes.length || b.boxes.length > Core.LIMITS.batch) throw httpError(400, `Send between 1 and ${Core.LIMITS.batch} boxes at a time.`);
  if (!memberWrites.hit(`${doc.id}:${mid}`)) throw httpError(429, 'That’s a lot of changes. Wait a few minutes and try again.');
  const now = Date.now();
  let added = [], skipped = 0;
  await store.transactKeys('moves', doc.id, (cur) => {
    if (!cur || !K.isOwner(cur, K.actorOf(cur, readKey(req)))) throw httpError(404, GONE, { code: 'gone' });
    added = []; skipped = 0;
    const nos = { ...(cur.nos || {}) };
    let move = K.asMove(cur, Object.keys(nos).map((k) => ({ id: nos[k], no: Number(k.slice(1)) })));
    const set = {};
    for (const raw of b.boxes) {
      const i = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      if (i.no === undefined || Core.noTaken(move, Core.intIn(i.no, 1, Core.LIMITS.boxNo)) || move.boxes.length >= Core.LIMITS.boxes) { skipped++; continue; }
      let box;
      try { box = Core.newBox(move, { id: i.id, no: i.no, room: i.room, items: i.items, flags: i.flags, note: i.note, status: i.status, location: i.location, tags: i.tags }, { now, rand: K.rand }).box; } catch (e) { skipped++; continue; }
      move.boxes.push({ id: box.id, no: box.no });
      set[`nos.${K.noKey(box.no)}`] = box.id;
      added.push(box);
    }
    if (!added.length) return undefined;
    set.nextNo = Math.max(cur.nextNo || 1, ...added.map((x) => x.no + 1));
    return { set, del: [] };
  });
  for (const box of added) await store.set('boxes', K.boxDocId(doc.id, box.id), K.toDoc(doc.id, box, ''));
  const t = added.length ? await touch(doc.id, mid) : { v: doc.v || 0, was: doc.v || 0 };
  res.json({ added: added.length, skipped, v: t.v });
}));

/* ------------------------------------------------------------------ *
 * Joining: no account
 * ------------------------------------------------------------------ */

async function byCode(req) {
  checkMisses(req);
  const code = Core.normalizeCode(req.params.code);
  const rows = Core.isCode(code) ? await store.list('moves', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(req, `j:${code}`); throw httpError(404, NO_CODE); }
  if (K.idle(doc, Date.now())) { await purge(doc.id); throw httpError(404, NO_CODE); }
  return doc;
}

/** What a code opens before joining: the move's name, whose it is, how
 *  many boxes and helpers - not who, and nothing in any box. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await byCode(req);
  const mid = K.actorOf(doc, readKey(req));
  const owner = Object.values(doc.members || {}).find((m) => m.role === 'owner');
  res.json({ name: doc.name, kind: Core.kindOf(doc.kind), by: owner ? owner.name : '', boxes: Object.keys(doc.nos || {}).length, helpers: K.helperCount(doc), full: K.memberCount(doc) >= Core.LIMITS.members, already: mid ? doc.id : null });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await byCode(req);
  const pre = K.actorOf(doc, readKey(req));
  if (pre) return res.json({ id: doc.id, me: pre, isNew: false });
  const name = Core.cleanName(b.name);
  if (!name) throw httpError(400, 'Type your first name, so everyone can see who moved which box.');
  if (newHelpers.blocked(ip)) throw httpError(429, 'Too many new helpers from here. Try again later.');
  const key = mintKey(req, res);
  const hash = K.keyHash(key, doc.id);
  const mid = Core.newId(K.rand, 8);
  let mine = null;
  await store.transactKeys('moves', doc.id, (cur) => {
    if (!cur) throw httpError(404, NO_CODE);
    const already = K.actorOf(cur, key);
    if (already) { mine = already; return undefined; }
    if (K.memberCount(cur) >= Core.LIMITS.members) throw httpError(409, `This move has ${Core.LIMITS.members - 1} helpers - that’s the most one move can have.`);
    const stamp = new Date().toISOString();
    mine = mid;
    return { set: { [`members.${mid}`]: { name: K.uniqueName(cur, name), role: 'helper', keyHash: hash, joinedAt: stamp, at: stamp }, ...K.touchKeys(cur, Date.now()) }, del: [] };
  });
  if (mine === mid) newHelpers.hit(ip);
  res.json({ id: doc.id, me: mine, isNew: mine === mid });
}));

/* ------------------------------------------------------------------ *
 * A shared move, as its members see it
 * ------------------------------------------------------------------ */

/** Poll: `?since=<v>` answers {same: true} when nothing moved, so an idle
 *  move costs one read. */
app.get('/api/m/:id', route('Could not load the move.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, mid } = await memberMove(req);
  await noteActive(doc);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (doc.v || 0)) return res.json({ same: true, v: doc.v || 0 });
  res.json({ move: Core.sharedView(doc, await boxesOf(doc.id), mid, { now: Date.now() }) });
}));

/** The box this request names, in this move, or a 404. */
async function boxDoc(doc, bidIn) {
  const bid = String(bidIn || '');
  const d = Core.isId(bid) ? await store.get('boxes', K.boxDocId(doc.id, bid)) : null;
  if (!d || d.move !== doc.id) throw httpError(404, 'That box isn’t in this move any more.');
  return d;
}
function writeGate(req, doc, mid) {
  if (!memberWrites.hit(`${doc.id}:${mid}`)) throw httpError(429, 'That’s a lot of changes. Wait a few minutes and try again.');
}

/** A new box (owner): the number is decided inside a transaction on the
 *  move, so two at once never share one; the box is written before the
 *  version moves, so a phone polling in between never misses it. */
app.post('/api/m/:id/box', route('Could not add that box.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberMove(req);
  if (!K.isOwner(doc, mid)) throw httpError(403, OWNER_ONLY);
  writeGate(req, doc, mid);
  const b = req.body || {};
  noPhotos(b);
  const now = Date.now();
  let box = null;
  await store.transactKeys('moves', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE, { code: 'gone' });
    const nos = cur.nos || {};
    const move = K.asMove(cur, Object.keys(nos).map((k) => ({ id: nos[k], no: Number(k.slice(1)) })));
    move.nextNo = cur.nextNo || 1;
    box = Core.newBox(move, { no: b.no, room: b.room, items: b.items, flags: b.flags, note: b.note, location: b.location, tags: b.tags, id: b.id }, { now, rand: K.rand }).box;
    return { set: { [`nos.${K.noKey(box.no)}`]: box.id, nextNo: Math.max(cur.nextNo || 1, box.no + 1) }, del: [] };
  });
  const d = K.toDoc(doc.id, box, '');
  await store.set('boxes', K.boxDocId(doc.id, box.id), d);
  const t = await touch(doc.id, mid);
  res.json({ box: boxOut(doc, d), v: t.v, was: t.was });
}));

/** Edit a box (owner): only the fields that changed are written, so a
 *  helper marking it Delivered at the same moment is not undone. A new
 *  number is checked against the move's numbers in a transaction. */
app.patch('/api/m/:id/box/:bid', route('Could not save that box.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberMove(req);
  if (!K.isOwner(doc, mid)) throw httpError(403, OWNER_ONLY);
  writeGate(req, doc, mid);
  const b = req.body || {};
  noPhotos(b);
  const d0 = await boxDoc(doc, req.params.bid);
  const input = {};
  for (const f of Core.EDIT_FIELDS) if (f !== 'photo' && b[f] !== undefined) input[f] = b[f];
  const now = Date.now();
  if (input.no !== undefined) {
    const no = Core.intIn(input.no, 1, Core.LIMITS.boxNo);
    if (!no) throw httpError(400, `A box number is a whole number from 1 to ${Core.LIMITS.boxNo}.`);
    if (no !== d0.no) {
      await store.transactKeys('moves', doc.id, (cur) => {
        if (!cur) throw httpError(404, GONE, { code: 'gone' });
        const nos = cur.nos || {};
        if (nos[K.noKey(no)] && nos[K.noKey(no)] !== d0.bid) throw httpError(409, `Box ${no} is already used.`, { code: 'taken' });
        return { set: { [`nos.${K.noKey(no)}`]: d0.bid, nextNo: Math.max(cur.nextNo || 1, no + 1) }, del: nos[K.noKey(d0.no)] === d0.bid ? [`nos.${K.noKey(d0.no)}`] : [] };
      });
    }
    input.no = no;
  }
  let after = null;
  await store.transactKeys('boxes', d0.id, (cur) => {
    if (!cur) throw httpError(404, 'That box isn’t in this move any more.');
    const move = K.asMove(doc, []);
    const before = K.fromDoc(cur, move);
    const next = Core.editBox({ ...move, boxes: [before] }, before, input, { now });
    const set = Core.boxPatch(before, next, Core.EDIT_FIELDS.filter((f) => f !== 'photo'));
    if (!Object.keys(set).length) { after = cur; return undefined; }
    set.updatedAt = next.updatedAt;
    after = { ...cur, ...set };
    return { set, del: [] };
  });
  const t = await touch(doc.id, mid);
  res.json({ box: boxOut(doc, after), v: t.v, was: t.was });
}));

/** A box's status (any member): Loaded, Delivered, Unpacked... with who
 *  did it. Only the status keys are written. */
app.put('/api/m/:id/box/:bid/status', route('Could not change that box.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberMove(req);
  writeGate(req, doc, mid);
  const status = String((req.body || {}).status || '');
  const kind = Core.kindOf(doc.kind);
  if (Core.STATUS[kind].indexOf(status) < 0) throw httpError(400, 'That isn’t a status this box can have.');
  const d0 = await boxDoc(doc, req.params.bid);
  const stamp = new Date().toISOString();
  let after = null;
  await store.transactKeys('boxes', d0.id, (cur) => {
    if (!cur) throw httpError(404, 'That box isn’t in this move any more.');
    const set = { status, statusAt: stamp, statusBy: mid, updatedAt: stamp };
    after = { ...cur, ...set };
    return { set, del: [] };
  });
  const t = await touch(doc.id, mid);
  res.json({ box: boxOut(doc, after), v: t.v, was: t.was });
}));

/** Delete a box (owner). Its number is free again. */
app.delete('/api/m/:id/box/:bid', route('Could not remove that box.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberMove(req);
  if (!K.isOwner(doc, mid)) throw httpError(403, OWNER_ONLY);
  writeGate(req, doc, mid);
  const d0 = await boxDoc(doc, req.params.bid);
  await store.remove('boxes', d0.id);
  await store.transactKeys('moves', doc.id, (cur) => (cur && cur.nos && cur.nos[K.noKey(d0.no)] === d0.bid ? { set: {}, del: [`nos.${K.noKey(d0.no)}`] } : undefined));
  const t = await touch(doc.id, mid);
  res.json({ ok: true, v: t.v, was: t.was });
}));

/** The move's name, where it is going and its rooms (owner). A room that
 *  boxes still go to cannot be taken away. */
app.patch('/api/m/:id', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberMove(req);
  if (!K.isOwner(doc, mid)) throw httpError(403, OWNER_ONLY);
  writeGate(req, doc, mid);
  const b = req.body || {};
  noPhotos(b);
  const set = {};
  if (b.name !== undefined) set.name = Core.plain(b.name, Core.LIMITS.name) || doc.name;
  if (Core.kindOf(doc.kind) === 'move') {
    if (b.from !== undefined) set.from = Core.plain(b.from, Core.LIMITS.place);
    if (b.to !== undefined) set.to = Core.plain(b.to, Core.LIMITS.place);
  }
  if (b.rooms !== undefined) {
    const rooms = Core.cleanRooms(b.rooms);
    if (!rooms.length) throw httpError(400, 'A move needs at least one room.');
    const gone = Core.cleanRooms(doc.rooms).filter((r) => !rooms.some((x) => x.id === r.id)).map((r) => r.id);
    if (gone.length && (await boxesOf(doc.id)).some((x) => gone.indexOf(x.room) >= 0)) throw httpError(409, 'Boxes still go to that room. Move them to another room first.');
    set.rooms = rooms;
  }
  await store.transactKeys('moves', doc.id, (cur) => (cur ? { set: { ...set, ...K.touchKeys(cur, Date.now()) }, del: [] } : undefined));
  const fresh = await store.get('moves', doc.id);
  res.json({ move: Core.sharedView(fresh, await boxesOf(doc.id), mid, { now: Date.now() }) });
}));

/** Remove a helper (owner). Their changes stay; they can no longer open it. */
app.delete('/api/m/:id/members/:mid', route('Could not remove them.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberMove(req);
  if (!K.isOwner(doc, mid)) throw httpError(403, OWNER_ONLY);
  const who = String(req.params.mid || '');
  if (who === mid) throw httpError(409, 'To stop sharing, use Stop sharing.');
  if (!doc.members || !doc.members[who]) throw httpError(404, 'They aren’t helping with this move any more.');
  await store.transactKeys('moves', doc.id, (cur) => (cur && cur.members && cur.members[who] ? { set: K.touchKeys(cur, Date.now()), del: [`members.${who}`] } : undefined));
  const fresh = await store.get('moves', doc.id);
  res.json({ move: Core.sharedView(fresh, await boxesOf(doc.id), mid, { now: Date.now() }) });
}));

/** A new join code (owner): the old one stops working at once; helpers
 *  already in are unaffected. */
app.post('/api/m/:id/code', route('Could not change the code.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberMove(req);
  if (!K.isOwner(doc, mid)) throw httpError(403, OWNER_ONLY);
  const code = await freshCode();
  await store.transactKeys('moves', doc.id, (cur) => (cur ? { set: { code, ...K.touchKeys(cur, Date.now()) }, del: [] } : undefined));
  res.json({ code, msg: 'New code. The old one no longer works.' });
}));

/** Leave (a helper). The owner stops sharing instead. */
app.delete('/api/m/:id/me', route('Could not leave.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberMove(req);
  if (K.isOwner(doc, mid)) throw httpError(409, 'You shared this move. To end it for everyone, use Stop sharing.');
  await store.transactKeys('moves', doc.id, (cur) => (cur && cur.members && cur.members[mid] ? { set: K.touchKeys(cur, Date.now()), del: [`members.${mid}`] } : undefined));
  res.json({ ok: true });
}));

/** Stop sharing (owner): the server copy and every box in it are deleted.
 *  The owner's phone keeps its own copy. */
app.delete('/api/m/:id', route('Could not stop sharing.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberMove(req);
  if (!K.isOwner(doc, mid)) throw httpError(403, OWNER_ONLY);
  await purge(doc.id);
  res.json({ ok: true });
}));

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
  // WHICHBOX_DEV_MOUNT=/whichbox runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.WHICHBOX_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`whichbox listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, LIMITS: K.LIMITS };
