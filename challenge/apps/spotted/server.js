// Spotted - the license plate game for the whole car. A REBUILD of the
// 2026-11-12 drop. See CLAUDE.md.
//
// A SOLO TRIP NEVER LEAVES THE PHONE. The board, the scoring, the drawn map,
// pass-the-phone players, the trip history and the recap card are worked
// out in the browser by public/spotted-core.js and kept in localStorage.
// What the server does:
//
//   - serves the page and its service worker;
//   - holds a SHARED car game, only when someone starts one: one versioned
//     document with the players' first names, colours and the plates each
//     spotted. Players join with a six-character code and a first name, no
//     account; the browser is recognised by an HttpOnly key, stored only as
//     a hash per game. The first tap on a plate to reach the server scores
//     it, inside a transaction, and the second is told who got there first.
//     A game goes 24 hours after the last change, on read;
//   - signed in (free): keeps the trip history in the account so two phones
//     stay in step - filed under an HMAC of the account id, saved only
//     against the version the phone last saw (a 409 carries the account's
//     copy for the phone to merge);
//   - the shared account (sign-in) at /api/auth.
//
// NO MODEL CALL. There is nothing here a model would do better than the
// rules, and no photo of anyone's car is ever taken, sent or read.

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/spotted-core');
const G = require('./lib/games');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
// Spotted makes no model call, but the lab host sets <SLUG>_FAKE_AI=1 for
// every app on a local run; like every sibling, it is refused on Cloud Run.
const FAKE_AI = process.env.SPOTTED_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('SPOTTED_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

const SYNC = {
  writes: 120,                       // history saves per account...
  writesWindowMs: 10 * 60 * 1000,    // ...in 10 minutes
};

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
  if (/^\/api\/(g|games|join)(\/|$)/.test(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow');
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

// The trip history mounts its own parser AFTER the sign-in check, so a
// stranger's body is never read. Everything else - a name, a code, a plate -
// is a few bytes: 16 KB.
const syncJson = express.json({ limit: '1mb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (req.path === '/api/sync' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (only the trip history's sync needs it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'spotted',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Spotted',
  mountPath: '/api/auth',
});
identity.mount(app);

/* ------------------------------------------------------------------ *
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body - and answered with the route's fallback.
 * ------------------------------------------------------------------ */

const httpError = G.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error');
  const body = { error: mine ? err.message : fallback };
  if (mine && err.code) body.code = err.code;
  if (mine && err.by) body.by = err.by;
  if (mine && err.game) body.game = err.game;
  if (mine && err.problems) body.problems = err.problems;
  return { status: mine ? err.status : 500, body };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/* ------------------------------------------------------------------ *
 * Limits, per address or player, in memory (per instance: they slow a
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
const newGames = lim(L.gamesPerIp, L.gamesWindowMs);
const newPlayers = lim(L.newPlayersPerIp, L.newPlayersWindowMs);
const ipWrites = lim(L.writesPerIp, L.writesWindowMs);
const memberWrites = lim(L.writesPerMember, L.writesMemberWindowMs);

// A wrong code or id counts once per DISTINCT value: a phone left open on a
// game that closed polls the same dead id every few seconds, and that is
// not guessing. Guessing needs many different codes.
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
 * stored only as sha256(key + game id)).
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'spotted_k';
function readKey(req) {
  const m = /(?:^|;\s*)spotted_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
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

// Unknown, expired and never-yours all read the same, word for word, so
// nobody learns whether a game id is real.
const GONE = 'This car game isn’t running here any more. It may have been ended, or it closed after a day with no new plates.';
const NO_CODE = 'No car game has that code. Check it with whoever started the game - it’s at the top of their screen.';
const HOST_ONLY = 'Only whoever started the game can do that.';

/** The game, if the id names a live one. One with no change for 24 hours
 *  is deleted by the read that finds it (there is no timer). */
async function loadGame(req) {
  checkMisses(req);
  const gid = String(req.params.id || '');
  const doc = Core.isGid(gid) ? await store.get('games', gid) : null;
  if (!doc) { missed(req, `g:${gid.slice(0, 20)}`); throw httpError(404, GONE, { code: 'gone' }); }
  if (G.idle(doc, Date.now())) { await store.remove('games', doc.id); throw httpError(404, GONE, { code: 'gone' }); }
  return doc;
}
/** The game and which player is asking - a stranger gets the same 404 a
 *  game that does not exist gets. A player who left is a stranger. */
async function memberGame(req) {
  const doc = await loadGame(req);
  const mid = G.actorOf(doc, readKey(req));
  if (!mid || doc.members[mid].left) throw httpError(404, GONE, { code: 'gone' });
  return { doc, mid };
}
const viewOf = (doc, mid) => Core.gameView(doc, mid);

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * A car game: no account
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = G.newCode();
    if (!(await store.list('games', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

app.post('/api/games', route('Could not start the game.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (newGames.blocked(ip)) throw httpError(429, `That’s ${L.gamesPerIp} car games from here this hour. Try again later.`);
  const b = req.body || {};
  const name = Core.cleanName(b.name);
  if (!name) throw httpError(400, 'Type your first name, so the car knows who spotted what.');
  const why = Core.refuse(b.title);
  if (why) throw httpError(400, why);
  const title = Core.cleanTitle(b.title) || 'Car game';
  const scoring = Core.SCORINGS.includes(b.scoring) ? b.scoring : 'rarity';
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const key = mintKey(req, res);
  const gid = G.newGameId();
  const mid = Core.newId(G.rand, 8, 'm');
  const doc = {
    code: await freshCode(), title, scoring, v: 1,
    members: { [mid]: { name, c: 0, keyHash: G.keyHash(key, gid), joinedAt: stamp, at: stamp, host: true } },
    spots: {}, ended: null, createdAt: stamp, updatedAt: stamp,
  };
  await store.transact('games', gid, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  newGames.hit(ip);
  res.set('Cache-Control', 'no-store');
  res.json({ id: gid, game: viewOf({ ...doc, id: gid }, mid) });
}));

async function byCode(req) {
  checkMisses(req);
  const code = Core.normalizeCode(req.params.code);
  const rows = Core.isCode(code) ? await store.list('games', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(req, `j:${code}`); throw httpError(404, NO_CODE); }
  if (G.idle(doc, Date.now())) { await store.remove('games', doc.id); throw httpError(404, NO_CODE); }
  return doc;
}

/** What a code opens before joining: the game's name, who started it and
 *  how many are playing - no other name, no score. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await byCode(req);
  const mid = G.actorOf(doc, readKey(req));
  const host = Object.values(doc.members || {}).find((m) => m.host);
  res.json({ title: doc.title, by: host ? host.name : '', players: G.playerCount(doc), full: G.playerCount(doc) >= Core.LIMITS.players, ended: Boolean(doc.ended), already: mid && !doc.members[mid].left ? doc.id : null });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await byCode(req);
  const pre = G.actorOf(doc, readKey(req));
  if (pre && !doc.members[pre].left) return res.json({ id: doc.id, isNew: false });
  if (doc.ended) throw httpError(409, 'That game is over. Start a new one - it takes a second.', { code: 'ended' });
  const name = Core.cleanName(b.name);
  if (!name) throw httpError(400, 'Type your first name, so the car knows who spotted what.');
  if (newPlayers.blocked(ip)) throw httpError(429, 'Too many new players from here. Try again later.');
  const key = mintKey(req, res);
  const hash = G.keyHash(key, doc.id);
  const mid = Core.newId(G.rand, 8, 'm');
  let mine = null;
  await store.transactKeys('games', doc.id, (cur) => {
    if (!cur) throw httpError(404, NO_CODE);
    const already = G.actorOf(cur, key);
    if (already && !cur.members[already].left) { mine = already; return undefined; }
    const now = Date.now();
    if (already) { mine = already; return { set: { [`members.${already}.left`]: false, ...G.touch(cur, now) }, del: [] }; }
    if (G.playerCount(cur) >= Core.LIMITS.players) throw httpError(409, `This car has ${Core.LIMITS.players} players - that’s the most one game can have.`);
    const stamp = new Date(now).toISOString();
    mine = mid;
    return { set: { [`members.${mid}`]: { name: G.uniqueName(cur, name), c: G.freeColor(cur), keyHash: hash, joinedAt: stamp, at: stamp }, ...G.touch(cur, now) }, del: [] };
  });
  if (mine === mid) newPlayers.hit(ip);
  res.json({ id: doc.id, isNew: mine === mid });
}));

/** Poll: `?since=<v>` answers {same: true} when nothing moved, so watching a
 *  quiet stretch of highway costs one read. */
app.get('/api/g/:id', route('Could not load the game.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, mid } = await memberGame(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (doc.v || 0)) return res.json({ same: true, v: doc.v || 0 });
  res.json({ game: viewOf(doc, mid) });
}));

/** Spot a plate. The first tap to reach here wins it: inside one
 *  transaction, `spots.XX` is added only if it is not there yet. The second
 *  phone gets 409 `taken` with who got there first and the game as it is. */
app.post('/api/g/:id/spots', route('Could not score that plate.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberGame(req);
  writeGate(doc, mid);
  const raw = (req.body || {}).state;
  const code = typeof raw === 'string' ? raw : '';
  if (!Core.isState(code)) throw httpError(400, 'That is not a plate on the board.');
  let taken = null;
  let ended = false;
  const after = await store.transactKeys('games', doc.id, (cur) => {
    if (!cur || !cur.members[mid] || cur.members[mid].left) throw httpError(404, GONE, { code: 'gone' });
    if (cur.ended) { ended = true; return undefined; }
    if (cur.spots && cur.spots[code]) { taken = cur.spots[code].by; return undefined; }
    const now = Date.now();
    return { set: { [`spots.${code}`]: { by: mid, at: new Date(now).toISOString() }, [`members.${mid}.at`]: new Date(now).toISOString(), ...G.touch(cur, now) }, del: [] };
  });
  const fresh = after && after.spots && after.spots[code] && !taken && !ended ? after : await store.get('games', doc.id);
  if (ended) throw httpError(409, 'This game is over - the scores are final.', { code: 'ended', game: viewOf(fresh, mid) });
  if (taken) {
    const st = Core.stateOf(code);
    if (taken === mid) throw httpError(409, `You already have ${st.n}.`, { code: 'taken', by: fresh.members[mid].name, game: viewOf(fresh, mid) });
    const by = fresh.members[taken] ? fresh.members[taken].name : 'Someone';
    throw httpError(409, `${by} spotted ${st.n} first.`, { code: 'taken', by, game: viewOf(fresh, mid) });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ game: viewOf(fresh, mid), pts: Core.pointsFor(code, fresh.scoring) });
}));

/** Take a plate back: the spotter within five minutes (a mis-tap), or the
 *  host any time (settling an argument). The plate is open again. */
app.delete('/api/g/:id/spots/:state', route('Could not take that back.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberGame(req);
  writeGate(doc, mid);
  const code = String(req.params.state || '');
  if (!Core.isState(code)) throw httpError(400, 'That is not a plate on the board.');
  await store.transactKeys('games', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE, { code: 'gone' });
    const s = cur.spots && cur.spots[code];
    if (!s) return undefined;
    if (cur.ended) throw httpError(409, 'This game is over - the scores are final.', { code: 'ended' });
    const mineRecent = s.by === mid && Date.now() - (Date.parse(s.at) || 0) <= L.undoMs;
    if (!mineRecent && !G.isHost(cur, mid)) throw httpError(403, s.by === mid ? `Only the first ${Core.LIMITS.undoMinutes} minutes - ask whoever started the game.` : HOST_ONLY, { code: 'not-yours' });
    return { set: G.touch(cur, Date.now()), del: [`spots.${code}`] };
  });
  res.json({ game: viewOf(await store.get('games', doc.id), mid) });
}));

/** End the game (the host): the scores are final, and every phone keeps it
 *  in its trip history on its next look. */
app.post('/api/g/:id/end', route('Could not end the game.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberGame(req);
  if (!G.isHost(doc, mid)) throw httpError(403, HOST_ONLY, { code: 'not-host' });
  await store.transactKeys('games', doc.id, (cur) => (cur && !cur.ended ? { set: { ended: new Date().toISOString(), ...G.touch(cur, Date.now()) }, del: [] } : undefined));
  res.json({ game: viewOf(await store.get('games', doc.id), mid) });
}));

/** Remove a player (the host). Their plates are open again - this is for
 *  the cousin who joined from the other car. */
app.delete('/api/g/:id/players/:mid', route('Could not remove them.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberGame(req);
  if (!G.isHost(doc, mid)) throw httpError(403, HOST_ONLY, { code: 'not-host' });
  const who = String(req.params.mid || '');
  if (who === mid) throw httpError(409, 'To stop, end the game.');
  if (!doc.members || !doc.members[who]) throw httpError(404, 'They aren’t in this game any more.');
  await store.transactKeys('games', doc.id, (cur) => {
    if (!cur || !cur.members || !cur.members[who]) return undefined;
    const freed = Object.keys(cur.spots || {}).filter((c) => cur.spots[c].by === who).map((c) => `spots.${c}`);
    return { set: G.touch(cur, Date.now()), del: [`members.${who}`, ...freed] };
  });
  res.json({ game: viewOf(await store.get('games', doc.id), mid) });
}));

/** Leave (a player). Their plates and points stay on the board under their
 *  name; the host ends the game instead of leaving. */
app.delete('/api/g/:id/me', route('Could not leave.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberGame(req);
  if (G.isHost(doc, mid)) throw httpError(409, 'You started this game - end it instead, and everyone keeps the scores.');
  await store.transactKeys('games', doc.id, (cur) => (cur && cur.members && cur.members[mid] ? { set: { [`members.${mid}.left`]: true, ...G.touch(cur, Date.now()) }, del: [] } : undefined));
  res.json({ ok: true });
}));

/** Delete the game now (the host). Every phone keeps what it has seen. */
app.delete('/api/g/:id', route('Could not delete the game.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberGame(req);
  if (!G.isHost(doc, mid)) throw httpError(403, HOST_ONLY, { code: 'not-host' });
  await store.remove('games', doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Signed in, free: the trip history follows the account.
 *
 *   trips/<tag> = {owner: tag, trips, updatedAt}
 *
 * The tag is an HMAC of the account id under a key derived from the session
 * secret ("spotted owner v1") - never the id or the email. A body is
 * refused whole (400, nothing saved) for an unknown field anywhere, a
 * string with an @, a link, seven digits in a row or markup, a name that is
 * not a first name, more than 300 trips, or about 600 KB as stored.
 * ------------------------------------------------------------------ */

const syncWrites = identityLib.createLimiter({ max: SYNC.writes, windowMs: SYNC.writesWindowMs });
function ownerTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('spotted owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function tagOf(req, write) {
  if (!SECRET()) throw httpError(503, 'Keeping your trips in the account isn’t available right now. Everything is still on this phone.');
  if (write && !syncWrites.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - everything is still on this phone.');
  return ownerTag(req.user.id, SECRET());
}
function out(doc) {
  if (!doc || !doc.trips) return { data: null, updatedAt: null };
  return { data: Core.cleanTrips(doc.trips).trips, updatedAt: Number(doc.updatedAt) || 0 };
}

app.get('/api/sync', identity.requireUser, route('Could not load your trips.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(out(await store.get('trips', tagOf(req, false))));
}));

/** Save the history. `base` is the account copy's updatedAt this phone last
 *  saw (null for one it has never saved): if the account has moved on
 *  since, the answer is 409 with the account's copy, and the phone merges
 *  the two and saves again. */
app.put('/api/sync', identity.requireUser, syncJson, route('Could not save your trips. They are still on this phone.', async (req, res) => {
  const tag = tagOf(req, true);
  const b = req.body || {};
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'data' && k !== 'base')) throw httpError(400, 'Send the trips and their base, nothing else.');
  const raw = b.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the trips.');
  const problem = Core.bodyProblem(raw);
  if (problem) throw httpError(400, 'That was not saved: ' + problem.charAt(0).toLowerCase() + problem.slice(1), { code: 'personal' });
  const { trips, errors } = Core.cleanTrips(raw, true);
  if (errors.length) throw httpError(400, 'That was not saved: ' + errors[0], { problems: errors.slice(0, 10) });
  if (Buffer.byteLength(JSON.stringify(trips)) > Core.LIMITS.storedBytes) throw httpError(413, 'That is more than Spotted keeps in an account (about 600 KB). Everything is still on this phone.');
  const base = b.base === null || b.base === undefined ? null : Number(b.base);
  let conflict = null;
  let saved = null;
  await store.transact('trips', tag, (cur) => {
    if (cur && Number(cur.updatedAt) !== base) { conflict = { doc: cur }; return undefined; }
    if (!cur && base !== null) { conflict = { removed: true }; return undefined; }
    const now = Math.max(Date.now(), (cur && Number(cur.updatedAt) + 1) || 0);
    saved = { owner: tag, trips, updatedAt: now };
    return saved;
  });
  res.set('Cache-Control', 'no-store');
  if (conflict && conflict.removed) return res.status(409).json({ error: 'Your trips were removed from the account on another phone.', code: 'removed', data: null, updatedAt: null });
  if (conflict) return res.status(409).json({ error: 'Your other phone changed the trips.', code: 'conflict', ...out(conflict.doc) });
  res.json(out(saved));
}));

app.delete('/api/sync', identity.requireUser, route('Could not remove it.', async (req, res) => {
  const tag = tagOf(req, true);
  await store.transact('trips', tag, () => null);
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
  // SPOTTED_DEV_MOUNT=/spotted runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.SPOTTED_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`spotted listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}`));
}

module.exports = { app, identity, identityStore, store, ownerTag, misses, LIMITS: G.LIMITS, SYNC };
