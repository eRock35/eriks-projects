// Stroll - a shop-local passport for a street's shops: a stamp at every
// counter, a prize draw at the end. See CLAUDE.md.
//
// What the server does:
//
//   - serves the page (and its service worker, so the passport opens with
//     the network off once it has loaded);
//   - holds a STROLL: one versioned document with the passport's name, the
//     street, its days, the goal, the prize, the shops (each with the code
//     on its counter sign) and the winners. The organizer starts it with no
//     account; a browser is recognised by an HttpOnly key, stored only as a
//     hash per stroll;
//   - holds each shopper's CARD as its own document (a first name and the
//     shops stamped), and flat COUNTS moved by increment - so a thousand
//     shoppers never grow, or fight over, one document;
//   - stamps a card when its phone sends a counter's code: once per shop,
//     only while the stroll is on, with wrong codes counted;
//   - draws the winner with the server's own dice (crypto.randomInt), every
//     entry the same chance, and gives the winner a claim code only their
//     phone and the organizer see;
//   - sends each phone only what it may see: A SHOPPER IS NEVER SENT a stamp
//     code, a count, or another shopper's name (StrollCore.view);
//   - signed in (free): the organizer may keep a passport on their account,
//     so it opens on their other phone - filed under HMACs of the account
//     id, never the id or the email;
//   - the shared account (sign-in) at /api/auth.
//
// NO MODEL IS CALLED ANYWHERE IN STROLL. Every rule is StrollCore's, the
// same on every phone.

const path = require('path');
const express = require('express');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/stroll-core');
const G = require('./lib/strolls');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // Join and stamp codes travel in the address's #fragment, which is never
  // sent anywhere - and nothing here needs a Referer either.
  res.set('Referrer-Policy', 'no-referrer');
  if (/^\/api\/(s|strolls|join|mine)(\/|$)/.test(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow');
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
app.use(express.json({ limit: '16kb' }));

/* ------------------------------------------------------------------ *
 * The shared account (keeping a passport across the organizer's phones
 * needs it; nothing else does)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'stroll',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Stroll',
  mountPath: '/api/auth',
});
identity.mount(app);

/* ------------------------------------------------------------------ *
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body - and answered with the route's fallback.
 * ------------------------------------------------------------------ */

const httpError = G.httpError;
function fail(res, err, fallback = 'Something went wrong.') {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n').replace(/\{.*$/gm, '') : 'error');
  const body = { error: mine ? err.message : fallback };
  if (mine && err.code) body.code = err.code;
  res.status(mine ? err.status : 500).json(body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address or browser, in memory (per instance: they slow a
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
const newStrolls = lim(L.strollsPerIp, L.strollsWindowMs);
const newCards = lim(L.newCardsPerIp, L.newCardsWindowMs);
const ipWrites = lim(L.writesPerIp, L.writesWindowMs);
const memberWrites = lim(L.writesPerMember, L.writesMemberWindowMs);
const hostLists = lim(L.listsPerHost, 10 * 60 * 1000);

// A wrong code or id counts once per DISTINCT value: a phone left open on a
// passport that closed asks for the same dead id, and that is not guessing.
function distinct(max, windowMs) {
  const m = new Map();
  const state = (k) => { const e = m.get(k); return !e || Date.now() - e.since > windowMs ? { since: Date.now(), seen: new Set() } : e; };
  return {
    map: m,
    add(k, what) { const e = state(k); e.seen.add(what); m.set(k, e); if (m.size > 10000) m.delete(m.keys().next().value); },
    blocked(k) { return state(k).seen.size >= max; },
  };
}
const misses = distinct(L.missesPerIp, L.missWindowMs);
const wrongStamps = distinct(L.wrongPerCard, L.wrongWindowMs);
function checkMisses(req) {
  if (misses.blocked(ipKey(req))) throw httpError(429, 'Too many wrong codes from here. Try again in a few minutes.');
}
function countWrite(req) {
  if (!ipWrites.hit(ipKey(req))) throw httpError(429, 'That’s a lot from here. Wait a minute and try again.');
}
function writeGate(doc, who) {
  if (!memberWrites.hit(`${doc.id}:${who.tag}`)) throw httpError(429, 'That’s a lot of taps. Wait a few minutes and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking: this browser's key (an HttpOnly cookie, 22 characters,
 * stored only as sha256(key + stroll id)) - or, signed in, the seat an
 * organizer kept on their account.
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'stroll_k';
function readKey(req) {
  const m = /(?:^|;\s*)stroll_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
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

/** {role: 'host', tag} | {role: 'card', card, tag} | null */
async function whoIs(req, doc) {
  const key = readKey(req);
  const tag = key ? G.tagOf(key, doc.id) : '';
  if (G.isHost(doc, key, seatOf(req, doc.id))) return { role: 'host', tag: tag || 'seat' };
  if (!key) return null;
  const card = await store.get('cards', G.cardId(doc.id, tag));
  return card ? { role: 'card', card, tag } : null;
}

// Unknown, expired and never-yours all read the same, word for word, so
// nobody learns whether a stroll id is real.
const GONE = 'This passport isn’t here any more. It may have been deleted, or it closed a month after its last day.';
const NO_CODE = 'No passport has that code. Check the poster, or ask at the counter.';
const today = () => Core.utcDay(Date.now());

/** Everything a stroll holds, gone: its cards, its counts, itself. */
async function purge(id) {
  const rows = await store.list('cards', { where: [['sid', '==', id]] });
  await store.removeMany('cards', rows.map((r) => r.id));
  await store.remove('counts', id);
  await store.remove('strolls', id);
}
/** The stroll, if the id names a live one. One past its keep-by day is
 *  deleted by the read that finds it (there is no timer). */
async function loadStroll(req) {
  checkMisses(req);
  const gid = String(req.params.id || '');
  const doc = Core.isGid(gid) ? await store.get('strolls', gid) : null;
  if (!doc) { misses.add(ipKey(req), `g:${gid.slice(0, 20)}`); throw httpError(404, GONE, { code: 'gone' }); }
  if (Core.expired(doc, today())) { await purge(doc.id); throw httpError(404, GONE, { code: 'gone' }); }
  return doc;
}
/** The stroll and who is asking - a stranger gets the same 404 a stroll
 *  that does not exist gets. */
async function memberStroll(req, role) {
  const doc = await loadStroll(req);
  const who = await whoIs(req, doc);
  if (!who) throw httpError(404, GONE, { code: 'gone' });
  if (role === 'host' && who.role !== 'host') throw httpError(403, Core.HOST_ONLY, { code: 'not-organizer' });
  return { doc, who };
}
// What this phone may see. Every answer that carries a stroll goes through
// here; only the organizer's reads the counts.
async function viewOf(doc, who) {
  const counts = who.role === 'host' ? await store.get('counts', doc.id) : null;
  return Core.view(doc, who, { today: today(), counts });
}
const stampCodes = (n) => Array.from({ length: n * 3 + 8 }, G.newStamp);

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, keep: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * A stroll: no account
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = G.newCode();
    if (!(await store.list('strolls', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

/** Start a passport: the organizer's first name, its details and, if sent,
 *  the first shops (each cleaned like any other; one bad name refuses the
 *  lot). */
app.post('/api/strolls', route('Could not start the passport.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (newStrolls.blocked(ip)) throw httpError(429, `That’s ${L.strollsPerIp} passports from here this hour. Try again later.`);
  const b = req.body || {};
  const name = Core.cleanName(b.name);
  if (!name) throw httpError(400, 'Type your first name, so the shops know who is organizing.');
  const g = Core.cleanStroll(b, today());
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const gid = G.newGid();
  let doc = { id: gid, code: '', ...g, v: 1, host: { name }, shops: {}, winners: {}, createdAt: stamp, updatedAt: stamp };
  const list = Array.isArray(b.shops) ? b.shops : [];
  if (list.length) {
    doc = Core.patch(doc, Core.act(doc, { t: 'addshops', shops: list }, { now, today: today(), ids: list.map(() => Core.newId(G.rand, 8, 's')), codes: stampCodes(list.length) }));
  }
  // Only now - everything typed was accepted - is this browser given a key.
  doc.code = await freshCode();
  doc.host.keyHash = G.tagOf(mintKey(req, res), gid);
  await store.transact('strolls', gid, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  newStrolls.hit(ip);
  res.set('Cache-Control', 'no-store');
  res.json({ id: gid, g: Core.view(doc, { role: 'host' }, { today: today(), counts: null }) });
}));

async function byCode(req) {
  checkMisses(req);
  const code = Core.normalizeCode(req.params.code);
  const rows = Core.isCode(code) ? await store.list('strolls', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { misses.add(ipKey(req), `j:${code}`); throw httpError(404, NO_CODE); }
  if (Core.expired(doc, today())) { await purge(doc.id); throw httpError(404, NO_CODE); }
  return doc;
}
const ended = (doc) => today() > Core.addDays(doc.to, 1);

/** What a code opens before joining: the passport's name, the street, its
 *  days, how many shops and stamps, the prize - no shop, no name. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await byCode(req);
  const who = await whoIs(req, doc);
  res.json({ title: doc.title, place: doc.place || '', when: Core.dateRange(doc.from, doc.to), shops: Core.shopIds(doc).length, goal: Core.goalOf(doc), prize: doc.prize || '', ended: ended(doc), already: who ? doc.id : null, role: who ? who.role : null });
}));

/** Start a passport card: a first name, and nothing else. */
app.post('/api/join/:code', route('Could not start your passport.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  const doc = await byCode(req);
  const pre = await whoIs(req, doc);
  if (pre) return res.json({ id: doc.id, isNew: false, role: pre.role });
  const name = Core.cleanName((req.body || {}).name);
  if (!name) throw httpError(400, 'Type your first name - it’s what the organizer calls out if you win.');
  if (ended(doc)) throw httpError(409, 'This passport has ended.', { code: 'closed' });
  if (newCards.blocked(ip)) throw httpError(429, 'Too many new passports from here. Try again later.');
  const counts = await store.get('counts', doc.id);
  if (counts && Number(counts.cards) >= Core.LIMITS.cards) throw httpError(409, `This passport has ${Core.LIMITS.cards} shoppers - that’s the most one can have.`);
  const key = mintKey(req, res);
  const id = G.cardId(doc.id, G.tagOf(key, doc.id));
  let made = false;
  await store.transact('cards', id, (cur) => { if (cur) return undefined; made = true; return { sid: doc.id, name, stamps: {}, createdAt: new Date().toISOString() }; });
  if (made) { newCards.hit(ip); await store.bump('counts', doc.id, { cards: 1 }); }
  res.json({ id: doc.id, isNew: made, role: 'card' });
}));

/** Read: `?since=<t>` answers {same: true} when nothing this phone is
 *  shown has moved. */
app.get('/api/s/:id', route('Could not load the passport.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, who } = await memberStroll(req);
  const g = await viewOf(doc, who);
  if (typeof req.query.since === 'string' && req.query.since === g.t) return res.json({ same: true, t: g.t });
  res.json({ g });
}));

/** A stamp: the code from a counter's sign, scanned or typed. Once per
 *  shop, only while the stroll is on. Every wrong code reads the same, and
 *  a passport that keeps guessing waits. */
app.post('/api/s/:id/stamp', route('Could not stamp your passport.', async (req, res) => {
  countWrite(req);
  const { doc, who } = await memberStroll(req);
  if (who.role === 'host') throw httpError(409, 'You’re the organizer - stamps are for shoppers’ passports.', { code: 'organizer' });
  writeGate(doc, who);
  const wk = `${doc.id}:${who.tag}`;
  if (wrongStamps.blocked(wk)) throw httpError(429, 'Too many wrong codes. Wait a few minutes - or scan the square on the sign instead.');
  const code = Core.normalizeCode((req.body || {}).code);
  const now = Date.now();
  const ctx = { now, today: today() };
  let out = null;
  let justDone = false;
  try {
    await store.transactKeys('cards', G.cardId(doc.id, who.tag), (cur) => {
      if (!cur) throw httpError(404, GONE, { code: 'gone' });
      out = Core.stamp(doc, cur, code, ctx);
      if (!out.isNew) return undefined;
      const after = { ...cur, stamps: { ...(cur.stamps || {}), [out.shop]: now } };
      justDone = !Core.progress(doc, cur).done && Core.progress(doc, after).done;
      return { set: out.set, del: [] };
    });
  } catch (err) {
    if (err && err.code === 'wrong') wrongStamps.add(wk, code.slice(0, 12));
    throw err;
  }
  if (out.isNew) await store.bump('counts', doc.id, { stamps: 1, [`s_${out.shop}`]: 1, [G.dayKey(now)]: 1, ...(justDone ? { done: 1 } : {}) });
  const card = await store.get('cards', G.cardId(doc.id, who.tag));
  res.set('Cache-Control', 'no-store');
  res.json({ g: Core.view(doc, { role: 'card', card, tag: who.tag }, { today: today() }), shop: out.shop, isNew: out.isNew, justDone });
}));

/** Every change the organizer makes: the details, a shop added, renamed or
 *  removed, a new counter code, a prize marked handed over. One door
 *  (StrollCore.act), run inside a transaction on the current document. */
app.post('/api/s/:id/act', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const { doc, who } = await memberStroll(req, 'host');
  writeGate(doc, who);
  const action = (req.body || {}).action;
  const n = action && Array.isArray(action.shops) ? Math.min(action.shops.length, Core.LIMITS.batch) : 1;
  const ids = Array.from({ length: n }, () => Core.newId(G.rand, 8, 's'));
  await store.transactKeys('strolls', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE, { code: 'gone' });
    const now = Date.now();
    const change = Core.act(cur, action, { now, today: today(), ids, codes: stampCodes(n) });
    return { set: { ...change.set, ...G.touch(cur, now) }, del: change.del };
  });
  res.set('Cache-Control', 'no-store');
  res.json({ g: await viewOf(await store.get('strolls', doc.id), who) });
}));

/** Every card of a stroll, as the draw and the list read them - and the
 *  counts put right from them (they are tallied as stamps happen, and a
 *  shop removed or a goal changed afterwards moves "finished"). */
async function allCards(req, doc) {
  if (!hostLists.hit(`${doc.id}`)) throw httpError(429, 'That’s a lot of counting. Wait a few minutes.');
  const rows = (await store.list('cards', { where: [['sid', '==', doc.id]] })).map(G.cardRow);
  const live = rows.filter((c) => !c.removed);
  await store.merge('counts', doc.id, { cards: live.length, done: live.filter((c) => Core.progress(doc, c).done).length });
  return rows;
}

/** The passports (the organizer): first names and how far each has got -
 *  to spot one person with a dozen, and remove them. */
app.get('/api/s/:id/cards', route('Could not load the passports.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc } = await memberStroll(req, 'host');
  const rows = await allCards(req, doc);
  const list = rows.map((c) => { const p = Core.progress(doc, c); return { tag: c.tag, name: Core.cleanName(c.name) || 'A shopper', n: p.n, done: p.done, entries: p.entries, removed: c.removed }; })
    .sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.tag < b.tag ? -1 : 1));
  res.json({ total: list.length, list: list.slice(0, L.listed) });
}));

/** Remove a passport from the draw (the organizer). Its stamps stay
 *  counted - the visits happened. */
app.delete('/api/s/:id/cards/:tag', route('Could not remove it.', async (req, res) => {
  countWrite(req);
  const { doc } = await memberStroll(req, 'host');
  const tag = String(req.params.tag || '');
  if (!Core.isTag(tag)) throw httpError(404, 'That passport isn’t here any more.');
  let was = null;
  await store.transactKeys('cards', G.cardId(doc.id, tag), (cur) => {
    if (!cur || cur.sid !== doc.id) throw httpError(404, 'That passport isn’t here any more.');
    if (cur.removed) return undefined;
    was = cur;
    return { set: { removed: true }, del: [] };
  });
  if (was) await store.bump('counts', doc.id, { cards: -1, ...(Core.progress(doc, was).done ? { done: -1 } : {}) });
  res.json({ ok: true });
}));

/** Draw a winner (the organizer): every entry of every finished passport
 *  has the same chance, by the server's dice. The winner gets a claim code
 *  that only their phone and the organizer are shown. */
app.post('/api/s/:id/draw', route('Could not draw.', async (req, res) => {
  countWrite(req);
  const { doc, who } = await memberStroll(req, 'host');
  const rows = await allCards(req, doc);
  let winner = null;
  await store.transactKeys('strolls', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE, { code: 'gone' });
    const now = Date.now();
    winner = Core.draw(cur, rows, G.rand);
    return { set: { [`winners.${winner.tag}`]: { name: winner.name, claim: G.newCode(), at: now }, ...G.touch(cur, now) }, del: [] };
  });
  res.set('Cache-Control', 'no-store');
  res.json({ g: await viewOf(await store.get('strolls', doc.id), who), winner: { name: winner.name, entries: winner.entries, of: winner.of, people: winner.people } });
}));

/** Tear up your own passport (a shopper). The stamps stay counted. */
app.delete('/api/s/:id/me', route('Could not do that.', async (req, res) => {
  countWrite(req);
  const { doc, who } = await memberStroll(req);
  if (who.role === 'host') throw httpError(409, 'You’re the organizer - delete the passport instead.');
  await store.remove('cards', G.cardId(doc.id, who.tag));
  if (!who.card.removed) await store.bump('counts', doc.id, { cards: -1, ...(Core.progress(doc, who.card).done ? { done: -1 } : {}) }, { mustExist: true });
  res.json({ ok: true });
}));

/** Delete the passport now (the organizer): every card and count with it. */
app.delete('/api/s/:id', route('Could not delete the passport.', async (req, res) => {
  countWrite(req);
  const { doc } = await memberStroll(req, 'host');
  await purge(doc.id);
  await forget(req, doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Signed in, free: the organizer keeps a passport on the account
 *
 *   strolls/<id>.host.owner = HMAC(account id + stroll id)
 *   mine/<tag> = {s: {<stroll id>: {title, place, from, to, at}}}
 *
 * The tag is an HMAC of the account id under a key derived from the
 * session secret - never the id or the email.
 * ------------------------------------------------------------------ */

const keepWrites = lim(60, 10 * 60 * 1000);
function mineTag(req, write) {
  if (!SECRET()) throw httpError(503, 'Keeping passports on an account isn’t available right now. This phone still has them.');
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

app.get('/api/mine', identity.requireUser, route('Could not load your passports.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await store.get('mine', mineTag(req, false));
  const s = (doc && doc.s) || {};
  res.json({ list: Object.keys(s).filter(Core.isGid).map((id) => ({ id, title: Core.line(s[id].title, Core.LIMITS.title), place: Core.line(s[id].place, Core.LIMITS.place), from: Core.isDay(s[id].from) ? s[id].from : '', to: Core.isDay(s[id].to) ? s[id].to : '', role: 'host', at: Number(s[id].at) || 0 })).sort((a, b) => b.at - a.at) });
}));

app.post('/api/s/:id/keep', identity.requireUser, route('Could not keep it on your account. This phone still has it.', async (req, res) => {
  const tag = mineTag(req, true);
  const { doc } = await memberStroll(req, 'host');
  const seat = seatOf(req, doc.id);
  if (!G.same(doc.host.owner, seat)) {
    // No `v` bump: nothing anyone is shown changed.
    await store.transactKeys('strolls', doc.id, (cur) => (cur && cur.host ? { set: { 'host.owner': seat }, del: [] } : undefined));
  }
  const now = Date.now();
  await store.transact('mine', tag, (cur) => {
    const s = { ...((cur && cur.s) || {}) };
    s[doc.id] = { title: doc.title, place: doc.place || '', from: doc.from, to: doc.to, at: now };
    const ids = Object.keys(s).sort((a, b) => (Number(s[b].at) || 0) - (Number(s[a].at) || 0));
    for (const id of ids.slice(L.kept)) delete s[id];
    return { owner: tag, s, updatedAt: now };
  });
  res.json({ ok: true });
}));

app.delete('/api/mine/:id', identity.requireUser, route('Could not remove it.', async (req, res) => {
  mineTag(req, true);
  const gid = String(req.params.id || '');
  if (!Core.isGid(gid)) throw httpError(400, 'That is not a passport.');
  await forget(req, gid);
  res.json({ ok: true });
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
  // STROLL_DEV_MOUNT=/stroll runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.STROLL_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`stroll listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}`));
}

module.exports = { app, identity, identityStore, store, misses, wrongStamps, LIMITS: G.LIMITS };
