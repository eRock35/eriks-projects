// Pencil - keep score at game night. See CLAUDE.md.
//
// EVERY GAME STAYS ON THE PHONE THAT KEEPS THE SCORE unless its scorer
// shows the table. The scoring engines, the history, the stats, the CSV and
// the recap card are worked out in the browser by public/pencil-core.js and
// kept in localStorage. What the server does:
//
//   - serves the page and its service worker;
//   - holds a SHARED table, only when its scorer shares one: the game as
//     text (names, emoji and numbers) in ONE versioned document. Watchers
//     join with a six-character code and a first name, no account; the
//     browser is recognised by an HttpOnly key, stored only as a hash per
//     table. Only whoever holds the pencil writes the game, and a write
//     based on an old version is refused (409). The pencil can be handed to
//     a watcher. A table goes 24 hours after the last change, on read;
//   - ONE metered, signed-in model call: "Read a paper score sheet", told
//     the one photo (shrunk on the phone, location removed) and nothing
//     else;
//   - the shared account (sign-in, credit) at /api/auth.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/pencil-core');
const K = require('./lib/tables');
const ai = require('./lib/ai');
const gemini = require('./lib/gemini');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.PENCIL_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('PENCIL_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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
  if (/^\/api\/(t|tables|join)(\/|$)/.test(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow');
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
// base64); a game after the address's limits (a new table) or the pencil
// check (a write). Everything else 16 KB.
const aiJson = express.json({ limit: '1400kb' });
const gameJson = express.json({ limit: K.LIMITS.bodyBytes });
const smallJson = express.json({ limit: '16kb' });
const OWN_PARSER = /^\/api\/(ai\/sheet|tables|t\/[A-Za-z0-9_-]{16}\/game)$/;
app.use((req, res, next) => (OWN_PARSER.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (only the sheet reader needs it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'pencil',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Pencil',
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
 * body or a photo - and answered with the route's fallback. A provider
 * error is a 502, or 503 when it is busy.
 * ------------------------------------------------------------------ */

const httpError = K.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  const body = { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - typing the scores always works.' : fallback) };
  if (mine && err.code) body.code = err.code;
  if (mine && err.table) body.table = err.table;
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
const L = K.LIMITS;
const newTables = lim(L.tablesPerIp, L.tablesWindowMs);
const newWatchers = lim(L.newWatchersPerIp, L.newWatchersWindowMs);
const ipWrites = lim(L.writesPerIp, L.writesWindowMs);
const memberWrites = lim(L.writesPerMember, L.writesMemberWindowMs);

// A wrong code or id counts once per DISTINCT value: a phone left open on a
// table that stopped being shared polls the same dead id every few seconds,
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
function writeGate(doc, mid) {
  if (!memberWrites.hit(`${doc.id}:${mid}`)) throw httpError(429, 'That’s a lot of changes. Wait a few minutes and try again.');
}

/* ------------------------------------------------------------------ *
 * Who is asking: this browser's key (an HttpOnly cookie, 22 characters,
 * stored only as sha256(key + table id)).
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'pencil_k';
function readKey(req) {
  const m = /(?:^|;\s*)pencil_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
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
// nobody learns whether a table id is real.
const GONE = 'This table isn’t shared here. The scorer may have stopped sharing it, or it closed after a day with no new scores.';
const NO_CODE = 'No table has that code. Check it with whoever is keeping score - it’s on their screen under Show the table.';
const SCORER_ONLY = 'Only whoever holds the pencil can do that.';

/** The table, if the id names a live one. One with no change for 24 hours
 *  is deleted by the read that finds it (there is no timer). */
async function loadTable(req) {
  checkMisses(req);
  const tid = String(req.params.id || '');
  const doc = Core.isTid(tid) ? await store.get('tables', tid) : null;
  if (!doc) { missed(req, `t:${tid.slice(0, 20)}`); throw httpError(404, GONE, { code: 'gone' }); }
  if (K.idle(doc, Date.now())) { await store.remove('tables', doc.id); throw httpError(404, GONE, { code: 'gone' }); }
  return doc;
}
/** The table and which member is asking - a stranger gets the same 404 a
 *  table that does not exist gets. */
async function memberTable(req) {
  const doc = await loadTable(req);
  const mid = K.actorOf(doc, readKey(req));
  if (!mid) throw httpError(404, GONE, { code: 'gone' });
  return { doc, mid };
}
const viewOf = (doc, mid) => Core.tableView(doc, mid);
/** The game a scorer sent, checked: within the limits (refused, not cut)
 *  and through the same door every game on a phone goes through. */
function gameFrom(body) {
  const raw = body && body.game;
  const too = Core.overLimits(raw);
  if (too) throw httpError(400, too);
  const g = Core.shareGame(raw && typeof raw === 'object' ? raw : {});
  if (!g) throw httpError(400, 'That game could not be read. Try again from the page.');
  return g;
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
 * Metered: "Read a paper score sheet"
 * ------------------------------------------------------------------ */

/** Which model reads the sheet. PENCIL_AI_PROVIDER=gemini moves it to
 *  Gemini on Vertex AI (through the lab's AI guard); claude-first keeps
 *  Claude first with Gemini as its fallback; anything else - unset
 *  included - is Claude, as it has been since the app shipped. */
const PROVIDER = process.env.PENCIL_AI_PROVIDER === 'claude-first' ? 'claude-first' : process.env.PENCIL_AI_PROVIDER === 'gemini' ? 'gemini' : 'claude';
const fakeGemini = FAKE_AI ? require('./lib/fakeai').createGemini() : null;

/** The lab's monthly cap and burst limits, when the host has a guard. An
 *  app run on its own has none. A guard that throws is logged and allows:
 *  the identity gates have already passed. */
async function guardAllow(req, provider) {
  const guard = global.LAB_AI_GUARD;
  if (!guard) return null;
  let a;
  try { a = await guard.allow({ provider, req, app: 'pencil' }); } catch (e) { console.error('[pencil] ai guard: allow failed'); return null; }
  if (a && a.ok) return null;
  return ai.httpError((a && a.status) || 503, (a && a.message) || 'Reading a score sheet is resting for now. Typing the scores always works.', { code: (a && a.code) || 'ai-guard' });
}
/** What a call cost, to the lab's month. Never fails the answer. */
async function guardRecord(provider, model, usage) {
  const guard = global.LAB_AI_GUARD;
  if (!guard || !usage) return;
  try { await guard.record({ provider, app: 'pencil', usd: guard.priceUsd({ provider, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) }); } catch (e) { console.error('[pencil] ai guard: record failed'); }
}
/** A Gemini call on the person's own ledger. The shared account's meter
 *  wraps an Anthropic client and prices Claude models only, so the same two
 *  writes it makes are made here: one usage row, and the cost added to the
 *  person's spend by increment. Never fails the answer. */
async function chargeGemini(req, model, usage) {
  const guard = global.LAB_AI_GUARD;
  let usd = null;
  try { usd = guard ? guard.priceUsd({ provider: 'gemini', model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) : gemini.priceUsd(usage); } catch (e) { usd = gemini.priceUsd(usage); }
  const cols = identity.collections;
  const uid = req.user && req.user.id;
  try { await identityStore.add(cols.USAGE, { at: new Date().toISOString(), app: 'pencil', provider: 'gemini', model, route: 'sheet', uid: uid || null, calls: 1, batch: false, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: usd, byok: false }); } catch (e) { /* never break the call it measured */ }
  if (uid && usd > 0 && identityStore.bump) { try { await identityStore.bump(cols.USERS, uid, { spentUsd: usd, callCount: 1 }); } catch (e) { /* same */ } }
}

/** One sheet on Gemini. Resolves the raw answer for `ai.answer` to check. */
async function readWithGemini(req, b) {
  try {
    const out = await gemini.ask(global.LAB_AI_GUARD, b, fakeGemini && fakeGemini.generate);
    await Promise.all([guardRecord('gemini', out.model, out.usage), chargeGemini(req, out.model, out.usage)]);
    return out.raw;
  } catch (err) {
    // Billed although it failed (an answer that could not be parsed).
    if (err && err.usage) await Promise.all([guardRecord('gemini', gemini.MODEL, err.usage), chargeGemini(req, gemini.MODEL, err.usage)]);
    if (err && err.name === 'VertexError' && !Number.isInteger(err.status)) err.status = err.code === 'timeout' ? 503 : 502;
    throw err;
  }
}
/** One sheet on Claude, as it has been since the app shipped. */
async function readWithClaude(req, b) {
  const model = modelFor(req);
  const out = await ai.ask(await clientFor(req), model, b);
  await guardRecord('claude', model, out.usage);
  return out.input;
}
/** A short, fixed reason for the fallback log line - never provider text. */
function failCode(err) {
  if (err && typeof err.code === 'string' && /^[a-z-]{1,20}$/.test(err.code)) return err.code;
  if (err && (err.status === 422 || err.status === 502)) return 'unusable';
  return err && err.status === 503 ? 'no-helper' : 'error';
}

/** Gates, then the parser, then the request rebuilt (only the photo,
 *  checked by its bytes - a 400 costs nothing), then the lab's AI guard,
 *  then one forced tool (Claude) or one schema (Gemini), then the answer
 *  checked. Nothing here writes a photo or a score to any store, and
 *  nothing logged carries a byte of the photo. */
app.post('/api/ai/sheet', ...spend, aiJson, route('Reading a score sheet isn’t available right now. Try again in a minute - typing the scores always works.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const b = ai.brief(req.body);
  // Gemini first when it is switched on. If it fails for any reason but a
  // burst refusal (which is per person across both providers), Claude reads
  // the same photo exactly as it always has: its own guard, meter, record.
  if (PROVIDER === 'gemini') {
    const no = await guardAllow(req, 'gemini');
    if (no && no.code !== 'monthly-cap') throw no;
    let why = no ? 'monthly-cap' : null;
    if (!no) {
      try { return res.json(ai.answer(await readWithGemini(req, b))); } catch (err) { why = failCode(err); }
    }
    console.warn(`[pencil] gemini failed (${why}); used claude`);
  }
  // Claude first when claude-first is set; if it fails for any reason but a
  // burst refusal, Gemini reads the same photo down its own path.
  if (PROVIDER === 'claude-first') {
    const no = await guardAllow(req, 'claude');
    if (no && no.code !== 'monthly-cap') throw no;
    let why = no ? 'monthly-cap' : null;
    if (!no) {
      try { return res.json(ai.answer(await readWithClaude(req, b))); } catch (err) { why = claudeFailCode(err); }
    }
    console.warn(`[pencil] claude failed (${why}); used gemini`);
    const gno = await guardAllow(req, 'gemini');
    if (gno) throw gno;
    return res.json(ai.answer(await readWithGemini(req, b)));
  }
  const no = await guardAllow(req, 'claude');
  if (no) throw no;
  res.json(ai.answer(await readWithClaude(req, b)));
}));
/** The same for a Claude failure: an answer the app refused is "unusable",
 *  a provider error "http". */
function claudeFailCode(err) {
  if (err && err.expose && (err.status === 422 || err.status === 502)) return 'unusable';
  return err && Number.isInteger(err.status) ? 'http' : 'error';
}

/* ------------------------------------------------------------------ *
 * Showing the table: no account. The scorer's phone sends the game.
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = K.newCode();
    if (!(await store.list('tables', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

/** The address's limits run before the game is read. */
function createGate(req, res, next) {
  try {
    countWrite(req);
    if (newTables.blocked(ipKey(req))) throw httpError(429, `That’s ${L.tablesPerIp} shared tables from here this hour. Try again later.`);
    next();
  } catch (err) { fail(res, err, 'Could not share that table.'); }
}
app.post('/api/tables', createGate, gameJson, route('Could not share that table.', async (req, res) => {
  const b = req.body || {};
  const game = gameFrom(b);
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const key = mintKey(req, res);
  const tid = K.newTableId();
  const mid = Core.newId(K.rand, 8, 'm');
  const doc = {
    code: await freshCode(),
    game,
    v: 1,
    mv: 1,
    members: { [mid]: { name: Core.cleanName(b.you && b.you.name) || 'Scorer', role: 'scorer', keyHash: K.keyHash(key, tid), joinedAt: stamp, at: stamp } },
    createdAt: stamp, updatedAt: stamp,
  };
  await store.transact('tables', tid, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  newTables.hit(ipKey(req));
  res.set('Cache-Control', 'no-store');
  res.json({ id: tid, table: viewOf({ ...doc, id: tid }, mid) });
}));

/** The pencil check runs before the game is read, so a stranger's body is
 *  never parsed. */
async function scorerGate(req, res, next) {
  try {
    countWrite(req);
    const { doc, mid } = await memberTable(req);
    if (!K.isScorer(doc, mid)) throw httpError(403, SCORER_ONLY, { code: 'not-scorer' });
    writeGate(doc, mid);
    req.table = { doc, mid };
    next();
  } catch (err) { fail(res, err, 'Could not save the score.'); }
}
/** The scorer's game, written only when it is based on the version on the
 *  server. Anything else is a 409 carrying the table as it is, so the
 *  phone can show the latest instead of overwriting it. */
app.put('/api/t/:id/game', scorerGate, gameJson, route('Could not save the score.', async (req, res) => {
  const { doc, mid } = req.table;
  const b = req.body || {};
  const v = Number.isInteger(b.v) ? b.v : -1;
  const game = gameFrom(b);
  let out = null;
  await store.transact('tables', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE, { code: 'gone' });
    if (!K.isScorer(cur, mid)) throw httpError(403, SCORER_ONLY, { code: 'not-scorer', table: viewOf(cur, mid) });
    if ((cur.v || 0) !== v) throw httpError(409, 'The table changed since this phone last saw it - here is the latest.', { code: 'stale', table: viewOf(cur, mid) });
    const t = K.touchKeys(cur, Date.now());
    const members = { ...cur.members, [mid]: { ...cur.members[mid], at: t.updatedAt } };
    out = { ...cur, game, members, ...t };
    return out;
  });
  res.set('Cache-Control', 'no-store');
  res.json({ v: out.v, at: out.updatedAt });
}));

/* ------------------------------------------------------------------ *
 * Joining: no account
 * ------------------------------------------------------------------ */

async function byCode(req) {
  checkMisses(req);
  const code = Core.normalizeCode(req.params.code);
  const rows = Core.isCode(code) ? await store.list('tables', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(req, `j:${code}`); throw httpError(404, NO_CODE); }
  if (K.idle(doc, Date.now())) { await store.remove('tables', doc.id); throw httpError(404, NO_CODE); }
  return doc;
}

/** What a code opens before joining: the game's name, who keeps score, how
 *  many play and watch - not who, and not a score. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await byCode(req);
  const mid = K.actorOf(doc, readKey(req));
  const scorer = Object.values(doc.members || {}).find((m) => m.role === 'scorer');
  res.json({ name: doc.game && doc.game.name ? doc.game.name : 'A game', by: scorer ? scorer.name : '', players: doc.game && Array.isArray(doc.game.sides) ? doc.game.sides.length : 0, watchers: K.watcherCount(doc), full: K.watcherCount(doc) >= Core.LIMITS.watchers, already: mid ? doc.id : null });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await byCode(req);
  const pre = K.actorOf(doc, readKey(req));
  if (pre) return res.json({ id: doc.id, me: pre, isNew: false });
  const name = Core.cleanName(b.name);
  if (!name) throw httpError(400, 'Type your first name, so the table knows who is watching.');
  if (newWatchers.blocked(ip)) throw httpError(429, 'Too many new watchers from here. Try again later.');
  const key = mintKey(req, res);
  const hash = K.keyHash(key, doc.id);
  const mid = Core.newId(K.rand, 8, 'm');
  let mine = null;
  await store.transactKeys('tables', doc.id, (cur) => {
    if (!cur) throw httpError(404, NO_CODE);
    const already = K.actorOf(cur, key);
    if (already) { mine = already; return undefined; }
    if (K.watcherCount(cur) >= Core.LIMITS.watchers) throw httpError(409, `This table has ${Core.LIMITS.watchers} watchers - that’s the most one table can have.`);
    const stamp = new Date().toISOString();
    mine = mid;
    return { set: { [`members.${mid}`]: { name: K.uniqueName(cur, name), role: 'watcher', keyHash: hash, joinedAt: stamp, at: stamp }, ...K.touchMembers(cur, Date.now()) }, del: [] };
  });
  if (mine === mid) newWatchers.hit(ip);
  res.json({ id: doc.id, me: mine, isNew: mine === mid });
}));

/* ------------------------------------------------------------------ *
 * A shared table, as its members see it
 * ------------------------------------------------------------------ */

/** Poll: `?since=<v>&m=<mv>` answers {same: true} when neither the game
 *  nor who is at the table moved, so watching an idle table costs one
 *  read. */
app.get('/api/t/:id', route('Could not load the table.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, mid } = await memberTable(req);
  const since = Number(req.query.since), m = Number(req.query.m);
  if (Number.isInteger(since) && since === (doc.v || 0) && Number.isInteger(m) && m === (doc.mv || 0)) return res.json({ same: true, v: doc.v || 0, mv: doc.mv || 0 });
  res.json({ table: viewOf(doc, mid) });
}));

/** Hand the pencil to a watcher: they keep score from now on, and the old
 *  scorer watches. */
app.post('/api/t/:id/pencil', route('Could not hand the pencil over.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberTable(req);
  if (!K.isScorer(doc, mid)) throw httpError(403, SCORER_ONLY, { code: 'not-scorer' });
  writeGate(doc, mid);
  const to = String((req.body || {}).to || '');
  let out = null;
  await store.transact('tables', doc.id, (cur) => {
    if (!cur || !K.isScorer(cur, mid)) throw httpError(403, SCORER_ONLY, { code: 'not-scorer' });
    if (to === mid || !cur.members[to]) throw httpError(404, 'They aren’t watching this table any more.');
    const members = { ...cur.members };
    members[mid] = { ...members[mid], role: 'watcher' };
    members[to] = { ...members[to], role: 'scorer' };
    out = { ...cur, members, ...K.touchKeys(cur, Date.now()), mv: (cur.mv || 0) + 1 };
    return out;
  });
  res.json({ table: viewOf({ ...out, id: doc.id }, mid) });
}));

/** Remove a watcher (the scorer). They can no longer open the table. */
app.delete('/api/t/:id/members/:mid', route('Could not remove them.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberTable(req);
  if (!K.isScorer(doc, mid)) throw httpError(403, SCORER_ONLY, { code: 'not-scorer' });
  const who = String(req.params.mid || '');
  if (who === mid) throw httpError(409, 'To stop, use Stop sharing - or hand the pencil to someone first.');
  if (!doc.members || !doc.members[who]) throw httpError(404, 'They aren’t watching this table any more.');
  await store.transactKeys('tables', doc.id, (cur) => (cur && cur.members && cur.members[who] ? { set: K.touchMembers(cur, Date.now()), del: [`members.${who}`] } : undefined));
  const fresh = await store.get('tables', doc.id);
  res.json({ table: viewOf(fresh, mid) });
}));

/** Leave (a watcher). Whoever holds the pencil hands it on or stops. */
app.delete('/api/t/:id/me', route('Could not leave.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberTable(req);
  if (K.isScorer(doc, mid)) throw httpError(409, 'You hold the pencil. Hand it to someone first - or stop sharing the table.');
  await store.transactKeys('tables', doc.id, (cur) => (cur && cur.members && cur.members[mid] ? { set: K.touchMembers(cur, Date.now()), del: [`members.${mid}`] } : undefined));
  res.json({ ok: true });
}));

/** Stop sharing (the scorer): the table is deleted. The game stays on the
 *  scorer's phone. */
app.delete('/api/t/:id', route('Could not stop sharing.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberTable(req);
  if (!K.isScorer(doc, mid)) throw httpError(403, SCORER_ONLY, { code: 'not-scorer' });
  await store.remove('tables', doc.id);
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
  // PENCIL_DEV_MOUNT=/pencil runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.PENCIL_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`pencil listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''} (reader: ${PROVIDER})`));
}

module.exports = { app, identity, identityStore, store, fakeClient, fakeGemini, PROVIDER, LIMITS: K.LIMITS };
