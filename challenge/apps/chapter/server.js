// Chapter - a book club that keeps up, and never spoils the ending. See
// CLAUDE.md.
//
// A club is made by a browser with NO account: the creator types the club's
// name, their first name and the book, shares a link, a QR code or a
// six-character code, and everyone joins with a first name and an emoji -
// also with no account. The browser is recognised by an HttpOnly key, stored
// only as a hash per club.
//
// THE SPOILER RULE IS ENFORCED HERE: a note's or question's text, author and
// reactions are sent only to a member who has read up to its chapter
// (ChapterCore.memberView / canSee). Everyone else gets a count.
//
// A model is used for ONE thing, metered and signed in: "Suggest discussion
// questions" - told the book's title, author and a chapter range, and
// nothing else. Everything else - the board, the nudges, notes, the vote and
// its tie-break, the shelf, meetups and the .ics - is the core file and
// costs nothing.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/chapter-core');
const K = require('./lib/clubs');
const ai = require('./lib/ai');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.CHAPTER_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('CHAPTER_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

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
  // Join codes and move links travel in the address's #fragment, which is
  // never sent anywhere - and nothing here needs a Referer either.
  res.set('Referrer-Policy', 'no-referrer');
  if (/^\/api\/(c|clubs|join|move|account|library|isbn)(\/|$)/.test(req.path)) res.set('X-Robots-Tag', 'noindex, nofollow');
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

// The metered route mounts its own small parser AFTER sign-in, budget and
// the daily cap, so a stranger's body is never read. Everything else 16 KB
// (a 500-character note is a few hundred bytes).
const aiJson = express.json({ limit: '4kb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => (req.path === '/api/ai/questions' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account (only "keep my clubs" and the AI need it)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'chapter',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Chapter',
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
 * body: what a club is reading and what anyone wrote are nobody's business -
 * and answered with the route's fallback. A provider error is a 502, or
 * 503 when it is busy.
 * ------------------------------------------------------------------ */

const httpError = K.httpError;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - writing your own questions always works.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

/** The reader's day and locale, from the page (checked: a day within one of
 *  the server's, a locale Intl accepts) - for "by Thu" and "today". */
function ctxOf(req) {
  const server = new Date().toISOString().slice(0, 10);
  let today = String(req.get('x-today') || '');
  if (!Core.isDay(today) || Math.abs(Core.dayDiff(server, today)) > 1) today = server;
  let locale = 'en-US';
  try { locale = Intl.getCanonicalLocales(String(req.get('x-locale') || 'en-US').slice(0, 35))[0] || 'en-US'; } catch (e) { locale = 'en-US'; }
  return { today, locale, now: Date.now() };
}

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
const newClubs = lim(L.clubsPerIp, L.clubsWindowMs);
const newMembers = lim(L.newMembersPerIp, L.newMembersWindowMs);
const ipWrites = lim(L.writesPerIp, L.writesWindowMs);
const memberWrites = lim(L.writesPerMember, L.writesMemberWindowMs);
const memberNotes = lim(L.notesPerMember, L.notesWindowMs);
const memberMoves = lim(L.movesPerMember, L.movesWindowMs);

// A wrong code, id or move link counts once per DISTINCT value: a phone left
// open on a deleted club polls the same dead id every few seconds, and that
// is not guessing. Guessing needs many different codes.
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

/* ------------------------------------------------------------------ *
 * Who is asking: this browser's key (an HttpOnly cookie, 22 characters,
 * stored only as sha256(key + club id)) - or, for a member who kept the
 * club on their account, the account's tag.
 * ------------------------------------------------------------------ */

const KEY_COOKIE = 'chapter_k';
function readKey(req) {
  const m = /(?:^|;\s*)chapter_k=([A-Za-z0-9_-]{22})(?:;|$)/.exec(req.headers.cookie || '');
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
function tagOf(req) { return req.user && SECRET() ? K.accountTag(req.user.id, SECRET()) : null; }

// Unknown, expired and never-yours all read the same, word for word, so
// nobody learns whether a club id is real.
const GONE = 'This club isn’t here. It may have been deleted, or it closed after 120 days with nobody opening it.';

/** Every document of a club: its notes, then itself. */
async function purge(id) {
  const notes = await store.list('notes', { where: [['club', '==', id]] });
  await store.removeMany('notes', notes.map((n) => n.id));
  await store.remove('clubs', id);
}
/** The club, if the id names a live one. One nobody has touched in 120
 *  days is deleted by the read that finds it (there is no timer). */
async function loadClub(req, idIn) {
  checkMisses(req);
  const id = String(idIn === undefined ? req.params.id || '' : idIn);
  const doc = K.isClubId(id) ? await store.get('clubs', id) : null;
  if (!doc) { missed(req, `c:${id.slice(0, 20)}`); throw httpError(404, GONE); }
  if (K.idle(doc, Date.now())) { await purge(doc.id); throw httpError(404, GONE); }
  return doc;
}
/** The club and which member is asking - a stranger gets the same 404 a
 *  club that does not exist gets. */
async function memberClub(req, idIn) {
  const doc = await loadClub(req, idIn);
  const mid = K.actorOf(doc, readKey(req), tagOf(req));
  if (!mid) throw httpError(404, GONE);
  return { doc, mid };
}
async function notesOf(clubId) { return store.list('notes', { where: [['club', '==', clubId]] }); }

/** The club as one member sees it (ChapterCore.memberView - the same
 *  function the made-up club is drawn with), plus whether it is kept on the
 *  signed-in account. Never a key hash, an account tag or a move secret. */
async function viewOf(req, doc, mid, ctx, notes) {
  const v = Core.memberView(doc, notes || await notesOf(doc.id), mid, ctx);
  const tag = tagOf(req);
  v.kept = Boolean(tag && doc.members[mid] && doc.members[mid].acct === tag);
  v.account = Boolean(SECRET());
  return v;
}

/** Every club write: read the club inside a transaction, let the core
 *  decide, then write ONLY the keys it changed (and the version). Two
 *  members writing at once never write back a copy missing the other's. */
async function clubWrite(req, fn, opts) {
  countWrite(req);
  const { doc, mid: first } = await memberClub(req);
  if (!memberWrites.hit(`${doc.id}:${first}`)) throw httpError(429, 'That’s a lot of changes. Wait a few minutes and try again.');
  const ctx = ctxOf(req);
  const key = readKey(req), tag = tagOf(req);
  let out = null, mid = null;
  await store.transactKeys('clubs', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE);
    mid = K.actorOf(cur, key, tag);
    if (!mid) throw httpError(404, GONE);
    out = fn(cur, mid, ctx);
    return { set: { ...out.patch.set, ...K.touchKeys(cur, ctx.now) }, del: out.patch.del };
  });
  if (opts && opts.after) await opts.after(out, mid, doc);
  const fresh = await store.get('clubs', doc.id);
  return { club: await viewOf(req, fresh, mid, ctx), msg: out.msg || '' };
}
const hostOnly = (fn) => (cur, mid, ctx) => { if (!Core.isHost(cur, mid)) throw httpError(403, 'Only the host can do that.'); return fn(cur, mid, ctx); };
/** Bump the club's version after a note changes, so phones polling with
 *  ?since=v notice. */
async function touch(clubId) {
  await store.transactKeys('clubs', clubId, (cur) => (cur ? { set: K.touchKeys(cur, Date.now()), del: [] } : undefined));
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false, account: Boolean(SECRET()) });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, account: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Metered: suggest discussion questions
 * ------------------------------------------------------------------ */

/** Gates, then a 4 KB parser, then the request rebuilt (exactly {club,
 *  from, to}; a 400 costs nothing), then membership and the range (never
 *  past where the asker is), then one forced tool told the title, author
 *  and range - nothing else - then the answer checked. Nothing is stored:
 *  a member adds the questions they tap, as their own. */
app.post('/api/ai/questions', ...spend, aiJson, route('Suggestions aren’t available right now. Try again in a minute - writing your own always works.', async (req, res) => {
  const b = ai.brief(req.body);
  const { doc, mid } = await memberClub(req, b.club);
  const view = Core.memberView(doc, [], mid, ctxOf(req));
  const range = Core.aiRange(view, b.from, b.to);
  const book = { title: view.book.title, author: view.book.author, unit: view.book.unit, total: view.book.total };
  const raw = await ai.ask(await clientFor(req), modelFor(req), book, range);
  res.set('Cache-Control', 'no-store');
  res.json({ ...ai.answer(raw, range, book.unit), range });
}));

/* ------------------------------------------------------------------ *
 * Starting a club: no account
 * ------------------------------------------------------------------ */

async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = K.newCode();
    if (!(await store.list('clubs', { where: [['code', '==', c]], limit: 1 })).length) return c;
  }
  throw httpError(503, 'Could not make a code. Try again.');
}

app.post('/api/clubs', route('Could not start that club.', async (req, res) => {
  countWrite(req);
  const ip = ipKey(req);
  if (newClubs.blocked(ip)) throw httpError(429, `That’s ${L.clubsPerIp} new clubs from here this hour. Try again later.`);
  const b = req.body || {};
  const ctx = ctxOf(req);
  const hostId = Core.newId('m', K.rand);
  const doc = Core.newClub(b, { now: ctx.now, today: ctx.today, hostId, bookId: Core.newId('b', K.rand), tz: b.tz });
  const key = mintKey(req, res);
  const id = K.newClubId();
  doc.code = await freshCode();
  doc.members[hostId].keyHash = K.keyHash(key, id);
  await store.transact('clubs', id, (cur) => { if (cur) throw httpError(409, 'Try again.'); return doc; });
  newClubs.hit(ip);
  res.json({ id, club: await viewOf(req, { ...doc, id }, hostId, ctx, []) });
}));

/* ------------------------------------------------------------------ *
 * Joining: no account
 * ------------------------------------------------------------------ */

async function byCode(req) {
  checkMisses(req);
  const code = Core.normalizeCode(req.params.code);
  const rows = Core.isCode(code) ? await store.list('clubs', { where: [['code', '==', code]], limit: 1 }) : [];
  const doc = rows[0];
  if (!doc) { missed(req, `j:${code}`); throw httpError(404, 'No club has that code. Check it with whoever sent it - it’s on their Club page.'); }
  if (K.idle(doc, Date.now())) { await purge(doc.id); throw httpError(404, 'No club has that code. Check it with whoever sent it - it’s on their Club page.'); }
  return doc;
}

/** What a code opens: the club's name, the book and how many read it - not
 *  who, not anything anyone wrote. */
app.get('/api/join/:code', route('Could not look that up.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const doc = await byCode(req);
  const mid = K.actorOf(doc, readKey(req), tagOf(req));
  const n = Core.memberCount(doc);
  res.json({ name: doc.name, book: { title: doc.book.title, author: doc.book.author || '' }, members: n, full: n >= Core.LIMITS.members, already: mid ? doc.id : null, taken: Core.EMOJI.filter((e) => Core.memberIds(doc).some((id) => doc.members[id].emoji === e)) });
}));

app.post('/api/join/:code', route('Could not join.', async (req, res) => {
  countWrite(req);
  const b = req.body || {};
  const ip = ipKey(req);
  const doc = await byCode(req);
  const pre = K.actorOf(doc, readKey(req), tagOf(req));
  if (pre) return res.json({ id: doc.id, me: pre, isNew: false });
  if (newMembers.blocked(ip)) throw httpError(429, 'Too many new readers from here. Try again later.');
  const key = mintKey(req, res);
  const hash = K.keyHash(key, doc.id);
  const mid = Core.newId('m', K.rand);
  let mine = null;
  await store.transactKeys('clubs', doc.id, (cur) => {
    if (!cur) throw httpError(404, GONE);
    const already = K.actorOf(cur, key, null);
    if (already) { mine = already; return undefined; }
    const r = Core.join(cur, { mid, name: b.name, emoji: b.emoji, keyHash: hash }, Date.now());
    mine = mid;
    return { set: { ...r.patch.set, ...K.touchKeys(cur, Date.now()) }, del: [] };
  });
  if (mine === mid) newMembers.hit(ip);
  res.json({ id: doc.id, me: mine, isNew: mine === mid });
}));

/* ------------------------------------------------------------------ *
 * A club, as its members see it
 * ------------------------------------------------------------------ */

/** Poll: `?since=<v>` answers {same: true} when nothing moved, so an idle
 *  club costs one read. */
app.get('/api/c/:id', route('Could not load the club.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, mid } = await memberClub(req);
  const since = Number(req.query.since);
  if (Number.isInteger(since) && since === (doc.v || 0)) return res.json({ same: true, v: doc.v || 0 });
  res.json({ club: await viewOf(req, doc, mid, ctxOf(req)) });
}));

/** Where I am: {pos} or {done: true}. */
app.put('/api/c/:id/progress', route('Could not move your bookmark.', async (req, res) => {
  const b = req.body || {};
  res.json(await clubWrite(req, (cur, mid, ctx) => Core.setProgress(cur, mid, { pos: b.pos, done: b.done === true }, ctx.now)));
}));

/** My name and emoji. */
app.patch('/api/c/:id/me', route('Could not save that.', async (req, res) => {
  const b = req.body || {};
  res.json(await clubWrite(req, (cur, mid) => Core.rename(cur, mid, { name: b.name, emoji: b.emoji })));
}));

/* Notes and questions: one document each. */
app.post('/api/c/:id/notes', route('Could not post that.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberClub(req);
  if (!memberNotes.hit(`${doc.id}:${mid}`)) throw httpError(429, `That’s ${L.notesPerMember} notes this hour. Save some thoughts for the meeting.`);
  const ctx = ctxOf(req);
  const note = Core.newNote(doc, mid, req.body || {}, { now: ctx.now });
  const all = await notesOf(doc.id);
  if (all.filter((n) => n.book === doc.book.id).length >= Core.LIMITS.notesPerBook) throw httpError(409, `This book has ${Core.LIMITS.notesPerBook} notes - that’s the most one book can hold.`);
  const nid = Core.newId('n', K.rand, 15);
  await store.set('notes', nid, note);
  await touch(doc.id);
  const fresh = await store.get('clubs', doc.id);
  res.json({ club: await viewOf(req, fresh, mid, ctx, [...all, { id: nid, ...note }]), id: nid });
}));

/** A note the member can see, or the 404 a missing one gets. */
async function visibleNote(req, doc, mid) {
  const nid = String(req.params.nid || '');
  const n = Core.isId(nid) ? await store.get('notes', nid) : null;
  if (!n || n.club !== doc.id || n.book !== doc.book.id || !Core.canSee(n, mid, doc.members[mid], doc.book)) throw httpError(404, 'That note isn’t here any more.');
  return n;
}
app.delete('/api/c/:id/notes/:nid', route('Could not remove that.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberClub(req);
  const n = await visibleNote(req, doc, mid);
  if (n.mid !== mid && !Core.isHost(doc, mid)) throw httpError(403, 'Only whoever wrote it, or the host, can remove a note.');
  await store.remove('notes', n.id);
  await touch(doc.id);
  const fresh = await store.get('clubs', doc.id);
  res.json({ club: await viewOf(req, fresh, mid, ctxOf(req)) });
}));
app.put('/api/c/:id/notes/:nid/react', route('Could not save that.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberClub(req);
  if (!memberWrites.hit(`${doc.id}:${mid}`)) throw httpError(429, 'That’s a lot of changes. Wait a few minutes and try again.');
  const n = await visibleNote(req, doc, mid);
  const e = (req.body || {}).emoji;
  const r = Core.react(n, mid, e === null || e === undefined ? null : String(e));
  await store.transactKeys('notes', n.id, (cur) => (cur ? r.patch : undefined));
  await touch(doc.id);
  const fresh = await store.get('clubs', doc.id);
  res.json({ club: await viewOf(req, fresh, mid, ctxOf(req)) });
}));

/* The book (host). */
app.patch('/api/c/:id/book', route('Could not change the book.', async (req, res) => {
  res.json(await clubWrite(req, hostOnly((cur) => Core.editBook(cur, req.body || {}))));
}));

/* Meetups. */
app.post('/api/c/:id/meetings', route('Could not plan that meeting.', async (req, res) => {
  res.json(await clubWrite(req, hostOnly((cur, mid, ctx) => Core.addMeeting(cur, mid, req.body || {}, Core.newId('t', K.rand), ctx))));
}));
app.patch('/api/c/:id/meetings/:mt', route('Could not change that meeting.', async (req, res) => {
  const mt = String(req.params.mt);
  res.json(await clubWrite(req, hostOnly((cur, _mid, ctx) => Core.editMeeting(cur, mt, req.body || {}, ctx.today))));
}));
app.delete('/api/c/:id/meetings/:mt', route('Could not remove that meeting.', async (req, res) => {
  const mt = String(req.params.mt);
  res.json(await clubWrite(req, hostOnly((cur) => {
    if (!cur.meetings || !cur.meetings[mt]) throw httpError(404, 'That meeting isn’t planned any more.');
    const p = Core.patch(); p.del.push(`meetings.${mt}`); return { patch: p };
  })));
}));
app.put('/api/c/:id/meetings/:mt/rsvp', route('Could not save that.', async (req, res) => {
  const mt = String(req.params.mt);
  const a = (req.body || {}).a;
  res.json(await clubWrite(req, (cur, mid) => Core.rsvp(cur, mid, mt, a === null ? null : String(a || ''))));
}));

/* What's next: nominations, approval votes, the winner. */
app.post('/api/c/:id/noms', route('Could not add that book.', async (req, res) => {
  res.json(await clubWrite(req, (cur, mid, ctx) => Core.nominate(cur, mid, req.body || {}, Core.newId('n', K.rand), ctx.now)));
}));
app.delete('/api/c/:id/noms/:nid', route('Could not take that off.', async (req, res) => {
  const nid = String(req.params.nid);
  res.json(await clubWrite(req, (cur, mid) => Core.unnominate(cur, mid, nid)));
}));
app.put('/api/c/:id/ballot', route('Could not save your vote.', async (req, res) => {
  const picks = (req.body || {}).picks;
  res.json(await clubWrite(req, (cur, mid) => Core.approve(cur, mid, picks)));
}));
app.post('/api/c/:id/vote/close', route('Could not close the vote.', async (req, res) => {
  res.json(await clubWrite(req, hostOnly((cur, _mid, ctx) => Core.closeVote(cur, ctx.now))));
}));
app.post('/api/c/:id/vote/reopen', route('Could not re-open the vote.', async (req, res) => {
  res.json(await clubWrite(req, hostOnly(() => Core.reopenVote())));
}));
/** The winner (or a book the host types) becomes the current book; the
 *  old one goes to the shelf. A shelf past its 40 books drops its oldest,
 *  and that book's notes go with it. */
app.post('/api/c/:id/next', route('Could not start the next book.', async (req, res) => {
  const b = req.body || {};
  res.json(await clubWrite(req, hostOnly((cur, _mid, ctx) => Core.startNext(cur, b, { today: ctx.today, bookId: Core.newId('b', K.rand) })), {
    after: async (out, _mid, doc) => {
      if (!out.dropped || !out.dropped.length) return;
      const gone = (await notesOf(doc.id)).filter((n) => out.dropped.includes(n.book));
      await store.removeMany('notes', gone.map((n) => n.id));
    },
  }));
}));
app.put('/api/c/:id/rating', route('Could not save that rating.', async (req, res) => {
  const b = req.body || {};
  res.json(await clubWrite(req, (cur, mid) => Core.rate(cur, mid, String(b.book || ''), b.stars === null ? null : b.stars)));
}));
/** A shelf book's notes, by the same rule, against where this member had
 *  got to when the club moved on. */
app.get('/api/c/:id/shelf/:bid/notes', route('Could not load those notes.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { doc, mid } = await memberClub(req);
  res.json(Core.shelfNotes(doc, String(req.params.bid), await notesOf(doc.id), mid));
}));

/* Members and the host. */
app.post('/api/c/:id/host', route('Could not hand hosting over.', async (req, res) => {
  const to = String((req.body || {}).to || '');
  res.json(await clubWrite(req, (cur, mid) => Core.handOver(cur, mid, to)));
}));
/** Everything of a member's: their seat, ballot, nominations, RSVPs,
 *  ratings (Core.removeMember), their notes and their reactions. */
async function dropMemberNotes(clubId, mid) {
  const notes = await notesOf(clubId);
  await store.removeMany('notes', notes.filter((n) => n.mid === mid).map((n) => n.id));
  for (const n of notes) {
    if (n.mid !== mid && n.reactions && Object.prototype.hasOwnProperty.call(n.reactions, mid)) {
      await store.transactKeys('notes', n.id, (cur) => (cur ? { set: {}, del: [`reactions.${mid}`] } : undefined));
    }
  }
}
app.delete('/api/c/:id/members/:mid', route('Could not remove them.', async (req, res) => {
  const who = String(req.params.mid);
  res.json(await clubWrite(req, hostOnly((cur, mid) => {
    if (who === mid) throw httpError(409, 'To leave, use Leave club.');
    return Core.removeMember(cur, who);
  }), { after: async (_out, _mid, doc) => dropMemberNotes(doc.id, who) }));
}));
/** Leave: a host hands over first, unless they are the last reader - then
 *  the club goes with them. */
app.delete('/api/c/:id/me', route('Could not leave.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberClub(req);
  if (Core.memberCount(doc) <= 1) { await purge(doc.id); return res.json({ ok: true, deleted: true }); }
  if (Core.isHost(doc, mid)) throw httpError(409, 'You’re the host. Hand hosting to someone first - on the Club page - then leave.');
  await store.transactKeys('clubs', doc.id, (cur) => {
    if (!cur || !cur.members[mid]) return undefined;
    const r = Core.removeMember(cur, mid);
    return { set: { ...r.patch.set, ...K.touchKeys(cur, Date.now()) }, del: r.patch.del };
  });
  await dropMemberNotes(doc.id, mid);
  res.json({ ok: true });
}));
/** A new join code (host): the old one stops working at once; members are
 *  unaffected. */
app.post('/api/c/:id/code', route('Could not change the code.', async (req, res) => {
  const code = await freshCode();
  res.json(await clubWrite(req, hostOnly(() => { const p = Core.patch(); p.set.code = code; return { patch: p, msg: 'New code. The old one no longer works.' }; })));
}));
/** Delete the club (host): every note, question, vote and rating with it. */
app.delete('/api/c/:id', route('Could not delete the club.', async (req, res) => {
  countWrite(req);
  const { doc, mid } = await memberClub(req);
  if (!Core.isHost(doc, mid)) throw httpError(403, 'Only the host can delete the club.');
  await purge(doc.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Moving to another phone: a one-time link
 *
 * The member's seat gets `move: {hash, exp}` - the hash of a 22-character
 * secret, for 30 minutes. The link is `#move=<club id>.<secret>` (a
 * fragment: it is never sent to a server, never in a Referer). The new
 * phone claims it in a transaction that deletes it, so it works once; the
 * seat then answers to the new phone's key, and the old phone is out.
 * ------------------------------------------------------------------ */

app.post('/api/c/:id/move', route('Could not make a move link.', async (req, res) => {
  const ctx = ctxOf(req);
  const secret = K.newSecret();
  const { doc, mid: who } = await memberClub(req);
  if (!memberMoves.hit(`${doc.id}:${who}`)) throw httpError(429, 'That’s a few move links this hour. Use the last one, or wait a while.');
  const out = await clubWrite(req, (cur, mid) => {
    const p = Core.patch();
    p.set[`members.${mid}.move`] = { hash: K.secretHash(secret), exp: new Date(ctx.now + Core.LIMITS.moveMinutes * 60000).toISOString() };
    return { patch: p };
  });
  res.set('Cache-Control', 'no-store');
  res.json({ token: `${out.club.id}.${secret}`, minutes: Core.LIMITS.moveMinutes, club: out.club });
}));

app.post('/api/move', route('Could not move that seat.', async (req, res) => {
  countWrite(req);
  checkMisses(req);
  const token = String((req.body || {}).token || '');
  const m = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})$/.exec(token);
  const NOPE = 'That move link has been used or has expired. Make a new one on the old phone (Club → Move to another phone).';
  if (!m) { missed(req, `m:${token.slice(0, 40)}`); throw httpError(404, NOPE); }
  const doc = await loadClub(req, m[1]);
  const h = K.secretHash(m[2]);
  const key = mintKey(req, res);
  const now = Date.now();
  let moved = null;
  await store.transactKeys('clubs', doc.id, (cur) => {
    if (!cur) throw httpError(404, NOPE);
    const mid = Object.keys(cur.members || {}).find((x) => cur.members[x].move && K.same(cur.members[x].move.hash, h));
    if (!mid) return undefined;
    const p = { set: {}, del: [`members.${mid}.move`] };
    if (Date.parse(cur.members[mid].move.exp) > now) {
      const here = K.actorOf(cur, key, null);
      if (here && here !== mid) throw httpError(409, `This phone is already in that club as ${cur.members[here].name}.`);
      p.set[`members.${mid}.keyHash`] = K.keyHash(key, cur.id);
      moved = mid;
    }
    return { set: { ...p.set, ...K.touchKeys(cur, now) }, del: p.del };
  });
  if (!moved) { missed(req, `m:${token.slice(0, 40)}`); throw httpError(404, NOPE); }
  res.json({ id: doc.id, me: moved });
}));

/* ------------------------------------------------------------------ *
 * Signed in (free, optional): keep my clubs on my account
 *
 *   accounts/<tag> = {clubs: {<club id>: <member id>}, updatedAt}
 *
 * and the member's seat carries `acct: <tag>`, so a signed-in device with
 * no key is that member. Only club ids and member ids are kept, under the
 * tag - never the email in a club, never a browser key.
 * ------------------------------------------------------------------ */

function accountOrFail(req) {
  const tag = tagOf(req);
  if (!tag) throw httpError(503, 'Keeping clubs on an account isn’t available right now. Your clubs are safe on this phone.');
  return tag;
}
app.get('/api/account/clubs', identity.requireUser, route('Could not load your clubs.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const tag = accountOrFail(req);
  const acct = await store.get('accounts', tag);
  const out = [], stale = [];
  for (const id of Object.keys((acct && acct.clubs) || {}).slice(0, L.accountClubs)) {
    const doc = K.isClubId(id) ? await store.get('clubs', id) : null;
    const mid = doc && !K.idle(doc, Date.now()) ? Object.keys(doc.members || {}).find((x) => doc.members[x].acct === tag) : null;
    if (!mid) { stale.push(id); continue; }
    out.push({ id, name: doc.name, book: doc.book.title, you: doc.members[mid].name, emoji: doc.members[mid].emoji });
  }
  if (stale.length) await store.transactKeys('accounts', tag, (cur) => (cur ? { set: {}, del: stale.map((id) => `clubs.${id}`) } : undefined));
  res.json({ clubs: out });
}));
app.put('/api/account/clubs/:id', identity.requireUser, route('Could not keep that club.', async (req, res) => {
  const tag = accountOrFail(req);
  const acct = await store.get('accounts', tag);
  if (acct && Object.keys(acct.clubs || {}).length >= L.accountClubs && !(acct.clubs || {})[req.params.id]) throw httpError(409, `An account keeps up to ${L.accountClubs} clubs.`);
  const out = await clubWrite(req, (cur, mid) => { const p = Core.patch(); p.set[`members.${mid}.acct`] = tag; return { patch: p }; });
  await store.merge('accounts', tag, { clubs: { [out.club.id]: out.club.you }, updatedAt: new Date().toISOString() });
  out.club.kept = true;
  res.json(out);
}));
app.delete('/api/account/clubs/:id', identity.requireUser, route('Could not do that.', async (req, res) => {
  const tag = accountOrFail(req);
  const id = String(req.params.id);
  let out = null;
  try {
    out = await clubWrite(req, (cur, mid) => { const p = Core.patch(); if (cur.members[mid].acct) p.del.push(`members.${mid}.acct`); return { patch: p }; });
  } catch (e) { if (e.status !== 404) throw e; }
  await store.transactKeys('accounts', tag, (cur) => (cur ? { set: {}, del: [`clubs.${id.replace(/[^A-Za-z0-9_-]/g, '')}`] } : undefined));
  res.json(out || { ok: true });
}));

/* ------------------------------------------------------------------ *
 * The personal library: per person, across clubs, seen by nobody else
 *
 *   libraries/<id> = {books: {<bid>: {isbn, title, author, pages, cover,
 *                     source, special, signed, note, addedAt}}, createdAt,
 *                     updatedAt, v}
 *
 * Whose: signed in, the account's (`a<tag>`); signed out, this phone's
 * (`p<hash of the key>`, made on the first book). A signed-in member with
 * books on the phone is offered "Keep them on my account", which moves them
 * across. Nobody else can name another's library: the id comes from the
 * request's own cookie or session, never from the URL or the body, so there
 * is no other reader's library to ask for. A phone's library nobody opens in
 * 400 days (as long as the key cookie lasts) is deleted by the read that
 * finds it.
 *
 * Looking up an ISBN asks Open Library (lib/openlibrary.js) - the one
 * outbound request in Chapter that is not the shared account's - inside the
 * request, with one time budget; a miss or a failure is still a 200 that
 * says which, and the page opens manual entry.
 * ------------------------------------------------------------------ */

const Lib = require('./public/library-core');
const books = require('./lib/openlibrary').create();
const lookups = lim(L.lookupsPerIp, L.lookupsWindowMs);
const libWrites = lim(L.libraryWrites, L.libraryWritesWindowMs);

/** Which library this request is: the account's when signed in, else the
 *  phone's (null if this browser has no key yet). */
function libOf(req) {
  const tag = tagOf(req);
  if (tag) return { id: K.accountLibId(tag), where: 'account' };
  const key = readKey(req);
  return { id: key ? K.phoneLibId(key) : null, where: 'phone' };
}
async function loadLib(id, where) {
  if (!id) return null;
  const doc = await store.get('libraries', id);
  if (doc && where === 'phone' && K.libraryIdle(doc, Date.now())) { await store.remove('libraries', id); return null; }
  return doc;
}
/** The library as its owner sees it, plus where it lives, and - signed in -
 *  how many books are still only on this phone. */
async function libView(req) {
  const { id, where } = libOf(req);
  const v = Lib.view(await loadLib(id, where));
  v.where = where;
  v.account = Boolean(SECRET());
  v.phone = 0;
  if (where === 'account') { const key = readKey(req); v.phone = key ? Lib.count(await loadLib(K.phoneLibId(key), 'phone')) : 0; }
  return v;
}
/** Every library write: read it inside a transaction, let the rules decide,
 *  write only the keys they changed. Only adding a book makes a library. */
async function libWrite(req, res, fn, opts) {
  countWrite(req);
  let { id } = libOf(req);
  if (!id) {
    if (!(opts && opts.create)) throw httpError(404, 'That book isn’t in your library any more.');
    id = K.phoneLibId(mintKey(req, res));
  }
  if (!libWrites.hit(id)) throw httpError(429, 'That’s a lot of changes. Wait a few minutes and try again.');
  const now = Date.now();
  if (opts && opts.create) {
    const at = new Date(now).toISOString();
    await store.transact('libraries', id, (cur) => (cur ? undefined : { books: {}, createdAt: at, updatedAt: at, v: 0 }));
  }
  let out = null;
  await store.transactKeys('libraries', id, (cur) => {
    if (!cur) throw httpError(404, 'That book isn’t in your library any more.');
    out = fn(cur, now);
    return { set: { ...out.patch.set, ...K.touchKeys(cur, now) }, del: out.patch.del };
  });
  return out;
}
const bookId = () => Core.newId('l', K.rand, 10);

/** Title, author, pages and cover for an ISBN (ISBN-10 or 13, typed however),
 *  and how many copies the asker already has. Not found or unavailable is a
 *  200 that says which - the page opens manual entry with the ISBN filled in. */
app.get('/api/isbn/:isbn', route('Could not look that up. You can type the book in instead.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const isbn = Lib.toIsbn13(req.params.isbn);
  if (!isbn) throw httpError(400, Lib.isbnProblem(req.params.isbn));
  if (!lookups.hit(ipKey(req))) throw httpError(429, 'That’s a lot of lookups from here. Type the book in instead, or try again later.');
  const r = await books.lookup(isbn);
  const { id, where } = libOf(req);
  const have = Lib.copiesOf(await loadLib(id, where), isbn);
  if (r.found) return res.json({ isbn, found: true, book: r.book, have });
  res.json({ isbn, found: false, reason: r.reason, book: { isbn, title: '', author: '', pages: null, cover: '' }, have });
}));

app.get('/api/library', route('Could not load your library.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ library: await libView(req) });
}));
/** Add a book (looked up or typed in) with its edition tags. */
app.post('/api/library/books', route('Could not add that book.', async (req, res) => {
  const b = req.body || {};
  const out = await libWrite(req, res, (cur, now) => Lib.addBook(cur, b, { id: bookId(), now }), { create: true });
  res.json({ library: await libView(req), id: out.id });
}));
/** Special edition, signed, and a note about the edition. */
app.patch('/api/library/books/:bid', route('Could not save that.', async (req, res) => {
  const bid = String(req.params.bid);
  await libWrite(req, res, (cur) => Lib.setTags(cur, bid, req.body || {}));
  res.json({ library: await libView(req) });
}));
app.delete('/api/library/books/:bid', route('Could not remove that.', async (req, res) => {
  const bid = String(req.params.bid);
  await libWrite(req, res, (cur) => Lib.removeBook(cur, bid));
  res.json({ library: await libView(req) });
}));
/** Delete the whole library (this account's, or this phone's). */
app.delete('/api/library', route('Could not delete your library.', async (req, res) => {
  countWrite(req);
  const { id } = libOf(req);
  if (id) await store.remove('libraries', id);
  res.json({ library: await libView(req) });
}));
/** Signed in: move the books on this phone onto the account (new ids where
 *  two would clash), then the phone's library goes. */
app.post('/api/library/keep', identity.requireUser, route('Could not move your books.', async (req, res) => {
  countWrite(req);
  const tag = tagOf(req);
  if (!tag) throw httpError(503, 'Keeping your library on an account isn’t available right now. Your books are safe on this phone.');
  const key = readKey(req);
  const pid = key ? K.phoneLibId(key) : null;
  const phone = await loadLib(pid, 'phone');
  if (!Lib.count(phone)) return res.json({ library: await libView(req), moved: 0 });
  const aid = K.accountLibId(tag);
  const now = Date.now(), at = new Date(now).toISOString();
  await store.transact('libraries', aid, (cur) => (cur ? undefined : { books: {}, createdAt: at, updatedAt: at, v: 0 }));
  let moved = 0;
  await store.transactKeys('libraries', aid, (cur) => {
    const r = Lib.mergeInto(cur, phone, bookId);
    moved = r.moved;
    return { set: { ...r.patch.set, ...K.touchKeys(cur, now) }, del: [] };
  });
  await store.remove('libraries', pid);
  res.json({ library: await libView(req), moved });
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
  if (!fs.existsSync(INDEX)) return next();
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
  // CHAPTER_DEV_MOUNT=/chapter runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.CHAPTER_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`chapter listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, fakeClient, books, LIMITS: K.LIMITS };
