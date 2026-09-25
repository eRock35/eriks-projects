// Receipt - every meeting gets a receipt.
//
// Meetings are the most expensive thing on a team's calendar that nobody
// sees a bill for: eight people in a weekly hour cost about $40k a year.
// Receipt puts a live price on the meeting while it runs (a ticker from role
// bands, never salaries), timeboxes the agenda with rings that show an
// overrun in dollars, logs decisions, actions and parking-lot items with one
// tap, lets the room vote from their phones with no account ("could have
// been an email", then the classic ROTI 0-4), and ends in a thermal-paper
// receipt with TIME GIVEN BACK when it finishes early. Then an audit of the
// recurring meetings - Keep, Shrink or Kill - and a scoreboard. See CLAUDE.md.
//
// A model is used for two things only: sharpening a vague invite into a
// timeboxed agenda, and writing the recap from what was logged (plus notes
// or one whiteboard photo). Everything else - the meter, the rings, the
// receipt, the room, bingo, the audit, the scoreboard - is public/rules.js
// and lib/meetings.js, and free.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const R = require('./public/rules');
const M = require('./lib/meetings');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { demo } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.RECEIPT_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('RECEIPT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A share link and a room code are credentials. They must not ride out in
  // a Referer header, and neither page should be indexed under Receipt's name.
  if (/^\/(s|r)\//.test(req.path) || /^\/api\/(shared|room)\//.test(req.path)) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// One whiteboard photo rides in the recap request as base64. Only that route
// gets the big limit, and it mounts its own parser AFTER the sign-in, budget
// and ownership checks, so a stranger's 6 MB is never read. Everything else
// stays small.
const RECAP_ROUTE = /^\/api\/meetings\/[^/]+\/recap$/;
const bigJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (RECAP_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'receipt',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Receipt',
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

// Never put a model call behind a sign-in alone: every one of these goes
// through the budget and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];
const user = identity.requireUser;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
const httpError = M.httpError;
const todayOf = (req) => M.todayFrom(req.get('x-local-date') || req.query.today);
// Only the app's own errors (M.httpError, marked `expose`) reach the client
// with their status and words. Anything else is logged and answered with the
// route's fallback - including the Anthropic SDK's errors, which carry a
// `.status` and a raw JSON body of their own: an upstream 401 passed through
// told a signed-in member to sign in, and a 529 showed them the provider's
// error JSON. An upstream failure is a 502 (503 when it is overloaded or
// rate-limited, so "try again" is the honest advice). Never a request body in
// the log: notes and whiteboards hold whatever the meeting said.
const fail = (res, err, fallback = 'Something went wrong.') => {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  const body = { error: mine ? err.message : fallback };
  if (mine) for (const k of ['field', 'current']) if (err[k] !== undefined) body[k] = err[k];
  res.status(status).json(body);
};

// A person's meetings live under their own uid: nobody else's id can name one.
const meetingsOf = (uid) => `meetings/${uid}/items`;
const logOf = (uid, mid) => `meetings/${uid}/items/${mid}/log`;
const votesOf = (uid, mid) => `meetings/${uid}/items/${mid}/votes`;
const recurringOf = (uid) => `recurring/${uid}/items`;

/** The meeting, if it is the signed-in person's. 404 - never 403 - for
 *  anyone else's id, so an id is not confirmed to exist. */
async function loadMeeting(req) {
  const id = String(req.params.id || '');
  const m = M.ID_RE.test(id) ? await store.get(meetingsOf(req.user.id), id) : null;
  if (!m) throw httpError(404, 'No such meeting.');
  return m;
}

/** loadMeeting as middleware, for the recap route: the ownership 404 comes
 *  before its big body parser, so a stranger's upload is never read. */
function ownerOnly(req, res, next) {
  loadMeeting(req).then((m) => { req.meeting = m; next(); }, (err) => fail(res, err));
}

const loadLog = (uid, mid) => store.list(logOf(uid, mid), { limit: M.LIMITS.log + 5 });
const loadVotes = (uid, mid) => store.list(votesOf(uid, mid), { limit: M.LIMITS.voters + 5 });
const loadAll = (uid) => store.list(meetingsOf(uid), { limit: M.LIMITS.meetings + 5 });
const loadRecurring = (uid) => store.list(recurringOf(uid), { limit: M.LIMITS.recurring + 5 });

/**
 * One read-modify-write at a time per key on this instance, queued rather
 * than refused. Votes and log items are one document each, so two people
 * writing at once write two documents; this only keeps a double-tapped Next
 * from closing two items, and one voter's change from counting twice.
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

async function freshCode() {
  let code = M.newCode();
  for (let i = 0; i < 5 && (await store.get('codes', code)); i++) code = M.newCode();
  return code;
}

/* ------------------------------------------------------------------ *
 * Public: health, meta, the sample meeting
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    bands: R.BANDS, blended: R.BLENDED, loaded: R.LOADED, cadences: R.CADENCES, kinds: R.KINDS, roti: R.ROTI,
    heat: R.HEAT, badges: R.BADGES, handles: R.HANDLES, templates: R.TEMPLATES, milestones: R.MILESTONES, limits: M.LIMITS,
  });
});

// An invented meeting played by the page through the real rules. No model
// call and no write for a signed-out visitor, ever.
app.get('/api/demo', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(demo(Date.now(), todayOf(req)));
});

/* ------------------------------------------------------------------ *
 * Me and my meetings
 * ------------------------------------------------------------------ */

const ORDER = { live: 0, paused: 0, waiting: 1, ended: 2 };
function listOf(rows, t) {
  return rows.map((m) => M.summaryOf(m, t)).sort((a, b) => (ORDER[a.status] - ORDER[b.status])
    || String(b.endedAt || b.startedAt || b.createdAt).localeCompare(String(a.endedAt || a.startedAt || a.createdAt)));
}

app.get('/api/me', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.json({ signedIn: false });
    const rows = await loadAll(req.user.id);
    const last = rows.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    res.json({
      signedIn: true,
      email: req.user.email,
      name: M.nameFromEmail(req.user.email),
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      meetings: rows.length,
      live: listOf(rows.filter((m) => R.started(m) && !R.ended(m)), Date.now()),
      lastSetup: last ? { mode: last.mode, people: last.people, loaded: Boolean(last.loaded), labels: last.labels || [] } : null,
    });
  } catch (err) { fail(res, err); }
});

app.get('/api/meetings', user, async (req, res) => {
  try {
    const t = Date.now();
    res.set('Cache-Control', 'no-store');
    res.json({ now: new Date(t).toISOString(), meetings: listOf(await loadAll(req.user.id), t), limit: M.LIMITS.meetings });
  } catch (err) { fail(res, err); }
});

/**
 * A new meeting - or, with `repeatOf`, the next occurrence of one: the same
 * room, rates, agenda and labels, in the same series, so last time's open
 * actions come back as loose ends.
 */
app.post('/api/meetings', user, async (req, res) => {
  try {
    const b = req.body || {};
    let base = {};
    let seriesKey = null;
    if (b.repeatOf !== undefined) {
      const src = await loadMeeting({ params: { id: b.repeatOf }, user: req.user });
      base = M.pickSetup(src);
      seriesKey = src.seriesKey || src.id;
    }
    const raw = { ...base, ...b };
    delete raw.repeatOf;
    const r = R.validateSetup(raw);
    if (r.error) throw httpError(400, r.error, { field: r.field });
    const all = await loadAll(req.user.id);
    if (all.length >= M.LIMITS.meetings) throw httpError(409, `You have ${M.LIMITS.meetings} meetings - the most Receipt keeps. Delete an old one first.`);
    const id = M.newId();
    const code = await freshCode();
    const at = now();
    const doc = { ...r.setup, seriesKey: seriesKey || id, code, pauses: [], marks: [], nDecision: 0, nAction: 0, nParking: 0, rotiSum: 0, rotiN: 0, emailN: 0, voterN: 0, createdAt: at, updatedAt: at };
    await store.set(meetingsOf(req.user.id), id, doc);
    await store.set('codes', code, { uid: req.user.id, mid: id, createdAt: at });
    res.json({ meeting: M.meetingView({ id, ...doc }) });
  } catch (err) { fail(res, err); }
});

/** Open actions from earlier meetings of the same series, hottest first -
 *  "past due" by the browser's own calendar day. */
async function looseEnds(uid, m, t, today) {
  const series = m.seriesKey || m.id;
  const earlier = (await store.list(meetingsOf(uid), { where: [['seriesKey', '==', series]], limit: M.LIMITS.meetings + 5 }))
    .filter((x) => x.id !== m.id && String(x.createdAt) < String(m.createdAt))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, M.LIMITS.seriesLookback);
  const out = [];
  for (const e of earlier) {
    for (const l of await loadLog(uid, e.id)) {
      if (l.kind === 'action' && !l.doneAt) out.push({ ...M.logView(l), meetingId: e.id, meetingTitle: e.title, meetingDay: e.day || null });
    }
  }
  return R.byHeat(out, t, today).slice(0, 20).map((r) => ({ ...r.action, heat: r.heat }));
}

app.get('/api/meetings/:id', user, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    const t = Date.now();
    const [log, votes] = await Promise.all([loadLog(req.user.id, m.id), loadVotes(req.user.id, m.id)]);
    res.set('Cache-Control', 'no-store');
    res.json({
      now: new Date(t).toISOString(),
      meeting: M.meetingView(m),
      log: log.map(M.logView),
      votes: votes.map(M.voteView),
      looseEnds: await looseEnds(req.user.id, m, t, todayOf(req)),
    });
  } catch (err) { fail(res, err); }
});

/**
 * Edit the setup. Before the start, everything; once the clock is running,
 * the room, the rates, the booking and the agenda are what the receipt is
 * computed from, so only the title, labels, outcome and bingo can change.
 */
app.put('/api/meetings/:id', user, async (req, res) => {
  try {
    const out = await exclusive(`m/${req.user.id}/${req.params.id}`, async () => {
      const m = await loadMeeting(req);
      const b = req.body || {};
      if (R.started(m)) {
        for (const k of ['people', 'mode', 'loaded', 'bookedMinutes', 'agenda']) {
          if (b[k] !== undefined && JSON.stringify(b[k]) !== JSON.stringify(m[k])) throw httpError(409, 'The meeting has started - the room, the rates, the booking and the agenda are locked so the receipt stays honest.');
        }
      }
      const r = R.validateSetup(b, m);
      if (r.error) throw httpError(400, r.error, { field: r.field });
      await store.merge(meetingsOf(req.user.id), m.id, { ...r.setup, updatedAt: now() });
      return { ...m, ...r.setup };
    });
    res.json({ meeting: M.meetingView(out) });
  } catch (err) { fail(res, err); }
});

app.delete('/api/meetings/:id', user, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    for (const l of await store.list(logOf(req.user.id, m.id))) await store.remove(logOf(req.user.id, m.id), l.id);
    for (const v of await store.list(votesOf(req.user.id, m.id))) await store.remove(votesOf(req.user.id, m.id), v.id);
    if (m.code) await store.remove('codes', m.code);
    if (m.shareToken) await store.remove('shares', m.shareToken);
    await store.remove(meetingsOf(req.user.id), m.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** A fresh room code. The old one stops working at once - for when it was
 *  pasted somewhere it should not have been. */
app.post('/api/meetings/:id/code', user, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    const code = await freshCode();
    await store.set('codes', code, { uid: req.user.id, mid: m.id, createdAt: now() });
    await store.merge(meetingsOf(req.user.id), m.id, { code, updatedAt: now() });
    if (m.code) await store.remove('codes', m.code);
    res.json({ code: R.formatCode(code) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The clock. Timestamps only - the server never runs a timer.
 * ------------------------------------------------------------------ */

/**
 * start / pause / resume / next / end. Each is one merge of timestamps on
 * the meeting; the ticker, the rings and the receipt are computed from them
 * on every read. Next closes the current item at the meeting time it is now;
 * End closes the current item too, and closes any open pause.
 *
 * End may say WHEN, for a meeting nobody ended: `{ at }` in meeting-time ms
 * ("at the booked time", "at the last logged item"). It is clamped between
 * the last closed item and now, so it can only shorten the meter, never run
 * it past what happened; endedAt becomes the wall-clock moment the meeting
 * had run that long. Without it, a laptop closed mid-meeting and ended the
 * next morning printed a 16-hour receipt nobody could correct.
 */
app.post('/api/meetings/:id/:verb(start|pause|resume|next|end)', user, async (req, res) => {
  try {
    const out = await exclusive(`m/${req.user.id}/${req.params.id}`, async () => {
      const m = await loadMeeting(req);
      const verb = req.params.verb;
      const t = Date.now();
      let at = new Date(t).toISOString();
      const want = verb === 'end' && req.body && req.body.at !== undefined && req.body.at !== null ? Number(req.body.at) : null;
      if (want !== null && !Number.isFinite(want)) throw httpError(400, 'Say when it ended, in minutes of meeting time.', { field: 'at' });
      const st = R.status(m);
      const patch = {};
      const pauses = (m.pauses || []).map((p) => ({ ...p }));
      const marks = (m.marks || []).slice();
      if (verb === 'start') {
        if (st !== 'waiting') throw httpError(409, 'This meeting has already started.');
        Object.assign(patch, { startedAt: at, day: todayOf(req), pauses: [], marks: [] });
      } else if (st === 'waiting') {
        throw httpError(409, 'Start the meeting first.');
      } else if (st === 'ended') {
        throw httpError(409, 'This meeting has ended.');
      } else if (verb === 'pause') {
        if (st === 'paused') throw httpError(409, 'Already paused.');
        pauses.push({ at, until: null });
        patch.pauses = pauses;
      } else if (verb === 'resume') {
        if (st !== 'paused') throw httpError(409, 'The meeting is not paused.');
        pauses[pauses.length - 1].until = at;
        patch.pauses = pauses;
      } else if (verb === 'next') {
        if (marks.length >= (m.agenda || []).length) throw httpError(409, 'That was the last item.');
        marks.push(R.elapsed(m, t));
        patch.marks = marks;
      } else if (verb === 'end') {
        if (st === 'paused') { pauses[pauses.length - 1].until = at; patch.pauses = pauses; }
        const running = { ...m, pauses };
        const el = R.elapsed(running, t);
        let endMs = el;
        if (want !== null) {
          endMs = Math.max(marks.length ? marks[marks.length - 1] : 0, Math.min(el, Math.round(want)));
          if (endMs < el) {
            const wall = R.wallAt(running, endMs);
            at = new Date(wall).toISOString();
            // Pauses after the new end never happened; one it falls in ends there.
            patch.pauses = pauses.filter((p) => Date.parse(p.at) < wall).map((p) => (p.until && Date.parse(p.until) <= wall ? p : { ...p, until: at }));
          }
        }
        if (marks.length < (m.agenda || []).length) { marks.push(endMs); patch.marks = marks; }
        patch.endedAt = at;
      }
      patch.updatedAt = new Date(t).toISOString();
      await store.merge(meetingsOf(req.user.id), m.id, patch);
      return { ...m, ...patch };
    });
    res.json({ now: new Date().toISOString(), meeting: M.meetingView(out) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The log: decisions, actions, parking lot. One document each.
 * ------------------------------------------------------------------ */

function logError(r) { return httpError(400, r.error, { field: r.field }); }

app.post('/api/meetings/:id/log', user, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    const r = R.validateLog(req.body || {}, m.labels || []);
    if (r.error) throw logError(r);
    const out = await exclusive(`log/${req.user.id}/${m.id}`, async () => {
      const count = (await loadLog(req.user.id, m.id)).length;
      if (count >= M.LIMITS.log) throw httpError(409, `A meeting holds up to ${M.LIMITS.log} logged items.`);
      const id = M.newId();
      const doc = { ...r.item, at: R.elapsed(m, Date.now()), createdAt: now(), doneAt: null };
      await store.set(logOf(req.user.id, m.id), id, doc);
      await store.bump(meetingsOf(req.user.id), m.id, { [M.COUNTER[r.item.kind]]: 1 });
      return { id, ...doc };
    });
    res.json({ item: M.logView(out) });
  } catch (err) { fail(res, err); }
});

/** Edit an item, or tick an action done (`done: true`) - from the meeting
 *  itself, or from the loose ends of the next one. */
app.put('/api/meetings/:id/log/:lid', user, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    const out = await exclusive(`log/${req.user.id}/${m.id}/${req.params.lid}`, async () => {
      const lid = String(req.params.lid || '');
      const l = M.ID_RE.test(lid) ? await store.get(logOf(req.user.id, m.id), lid) : null;
      if (!l) throw httpError(404, 'No such item.');
      const b = req.body || {};
      const raw = { kind: l.kind, text: b.text !== undefined ? b.text : l.text, owner: b.owner !== undefined ? b.owner : undefined, due: b.due !== undefined ? b.due : l.due };
      const r = R.validateLog(raw, m.labels || []);
      if (r.error) throw logError(r);
      const patch = { text: r.item.text, due: r.item.due };
      if (b.owner !== undefined) patch.owner = r.item.owner;
      if (b.done !== undefined) patch.doneAt = b.done === true ? (l.doneAt || now()) : null;
      await store.merge(logOf(req.user.id, m.id), l.id, patch);
      return { ...l, ...patch };
    });
    res.json({ item: M.logView(out) });
  } catch (err) { fail(res, err); }
});

// Under the same per-item lock as the edit, and read again inside it: a
// double tap (or two tabs) used to remove one document and decrement its
// counter twice, and the list and the receipt disagreed from then on.
app.delete('/api/meetings/:id/log/:lid', user, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    await exclusive(`log/${req.user.id}/${m.id}/${req.params.lid}`, async () => {
      const lid = String(req.params.lid || '');
      const l = M.ID_RE.test(lid) ? await store.get(logOf(req.user.id, m.id), lid) : null;
      if (!l) throw httpError(404, 'No such item.');
      await store.remove(logOf(req.user.id, m.id), l.id);
      await store.bump(meetingsOf(req.user.id), m.id, { [M.COUNTER[l.kind]]: -1 });
    });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** What the room is saying, for the facilitator's page to poll while the
 *  meeting runs. Anonymous: no browser id leaves the server. */
app.get('/api/meetings/:id/pulse', user, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    const votes = (await loadVotes(req.user.id, m.id)).map(M.voteView);
    const r = R.receipt(m, [], votes, Date.now());
    res.set('Cache-Control', 'no-store');
    res.json({ now: now(), status: R.status(m), votes, voters: r.voters, emailVotes: r.emailVotes, roti: r.roti, bingo: r.bingo });
  } catch (err) { fail(res, err); }
});

async function receiptOf(uid, m, t) {
  const [log, votes] = await Promise.all([loadLog(uid, m.id), loadVotes(uid, m.id)]);
  return R.receipt(m, log, votes.map(M.voteView), t);
}

app.get('/api/meetings/:id/receipt', user, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    const r = await receiptOf(req.user.id, m, Date.now());
    res.set('Cache-Control', 'no-store');
    res.json({ receipt: r, text: R.receiptText(r), share: M.meetingView(m).share });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The shared receipt: a frozen, public, numbers-only card
 * ------------------------------------------------------------------ */

/**
 * Publish or refresh. It freezes the numbers as they are now - later votes
 * change nothing until the owner taps Update, which re-freezes the same link.
 * No title, no agenda names, no decision text, no labels, no notes.
 */
app.post('/api/meetings/:id/share', user, async (req, res) => {
  try {
    const out = await exclusive(`share/${req.user.id}/${req.params.id}`, async () => {
      const m = await loadMeeting(req);
      if (!R.ended(m)) throw httpError(409, 'Finish the meeting first - a receipt is printed at the end.');
      const at = now();
      const card = M.shareCard(await receiptOf(req.user.id, m, Date.now()), at);
      let token = m.shareToken;
      if (!token) {
        token = M.newToken();
        while (await store.get('shares', token)) token = M.newToken();
      }
      await store.set('shares', token, { uid: req.user.id, mid: m.id, createdAt: at, card });
      await store.merge(meetingsOf(req.user.id), m.id, { shareToken: token, sharedAt: at });
      return { token, url: `s/${token}`, sharedAt: at, card };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.delete('/api/meetings/:id/share', user, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    if (m.shareToken) await store.remove('shares', m.shareToken);
    await store.merge(meetingsOf(req.user.id), m.id, { shareToken: null, sharedAt: null });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// The public receipt. No account, no model call, read-only.
app.get('/api/shared/:token', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = String(req.params.token || '');
    if (!M.TOKEN_RE.test(token)) throw httpError(404, 'This link is not valid.');
    const s = await store.get('shares', token);
    if (!s || !s.card) throw httpError(404, 'This receipt is not shared any more.');
    res.json({ ...s.card, preview: Boolean(req.user && req.user.id === s.uid) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Metered: sharpen an invite, write a recap
 * ------------------------------------------------------------------ */

/**
 * A vague invite in, a timeboxed agenda out - with an honest verdict on
 * whether it could be an email, and the written update if so. A proposal
 * only: the page's Apply saves it through the ordinary edit route.
 */
app.post('/api/meetings/:id/sharpen', ...spend, async (req, res) => {
  try {
    const m = await loadMeeting(req);
    if (R.started(m)) throw httpError(409, 'The meeting has started - sharpen the next one.');
    const b = req.body || {};
    const ctx = ai.sharpenContext(m, b.invite !== undefined ? b.invite : m.invite);
    if (!ctx.invite && m.title.length < 4) throw httpError(400, 'Paste the invite first.', { field: 'invite' });
    const client = await clientFor(req);
    const raw = await ai.sharpen(client, modelFor(req), ctx);
    const p = ai.validateSharpen(raw, ctx);
    if (!p) throw httpError(422, 'Nothing usable came back. Try again - or start from a template.');
    res.json({ invite: ctx.invite, proposal: p });
  } catch (err) { fail(res, err, 'Could not sharpen that. Try again, or start from a template.'); }
});

/**
 * The recap: from the log, plus optional notes or a transcript, plus
 * optionally one whiteboard photo. The notes and the photo are read once and
 * dropped with the request - nothing here is written anywhere. Every item
 * must cite its source; owners and dates must be earned (lib/ai.js).
 */
app.post('/api/meetings/:id/recap', ...spend, ownerOnly, bigJson, async (req, res) => {
  try {
    const m = req.meeting;
    const b = req.body || {};
    // The 6 MB parser is for the photo. Notes that big are refused before any
    // cleaning runs (and before any spend) - the page caps them at 20,000.
    if (typeof b.notes === 'string' && b.notes.length > M.LIMITS.notes * 2) throw httpError(400, 'Those notes are too long - paste up to 20,000 characters.', { field: 'notes' });
    const image = b.image !== undefined && b.image !== null ? photo.validate(b.image) : null;
    const notes = R.cleanText(b.notes, M.LIMITS.notes);
    const log = await loadLog(req.user.id, m.id);
    if (!log.length && !notes && !image) throw httpError(400, 'Log a decision or an action, or paste your notes, first.', { field: 'notes' });
    const ctx = ai.recapContext(m, log, notes, Boolean(image));
    const client = await clientFor(req);
    const raw = await ai.recap(client, modelFor(req), ctx, image);
    const rec = ai.validateRecap(raw, ctx);
    if (!rec) {
      throw httpError(422, image && raw && raw.readable === false
        ? 'We couldn’t read that whiteboard. Try a closer, straighter photo - or type the notes in.'
        : 'Nothing in that could be recapped. Log a decision, or paste fuller notes.');
    }
    res.json(rec);
  } catch (err) { fail(res, err, 'Could not write the recap. Try again, or use the free template.'); }
});

/* ------------------------------------------------------------------ *
 * The room: no account, one voice per browser
 * ------------------------------------------------------------------ */

// An opaque random id per browser, first-party, so a vote can be changed but
// not stuffed from one browser. No IP stored, no user agent, no account.
const VID = 'receipt_vid';
function visitor(req, res) {
  const m = /(?:^|;\s*)receipt_vid=([A-Za-z0-9_-]{22,40})/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const id = M.newToken();
  res.append('Set-Cookie', `${VID}=${id}; Path=/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax; HttpOnly${req.secure ? '; Secure' : ''}`);
  return id;
}

// Wrong codes and brand-new voters are counted per address, in memory. A room
// code is 8 of 32 characters, so guessing is hopeless anyway; this keeps a
// script from trying, and caps how many new "browsers" one address can mint
// in a window (M.LIMITS.newVotersPerIp, well under a room's 300) - it slows
// stuffing a vote, it cannot stop it: one vote per browser is gameable, and
// CLAUDE.md says so.
//
// A miss is counted once per DISTINCT wrong code. After a code reset, every
// phone still open on the old one polls it every 10 s; counted per request,
// a room on one office address locked itself out of the new code in under a
// minute. Guessing needs many different codes; a dead one polled is one.
const ipBook = new Map();
function ipCount(kind, ip) {
  const key = `${kind}:${ip}`;
  const e = ipBook.get(key);
  if (!e || Date.now() - e.since > M.LIMITS.roomWindowMs) return { count: 0, since: Date.now(), key };
  return { ...e, key };
}
function ipBump(kind, ip, distinct) {
  const e = ipCount(kind, ip);
  const seen = distinct === undefined ? null : new Set(e.seen || []);
  if (seen) {
    if (seen.has(distinct)) return;
    seen.add(distinct);
  }
  ipBook.set(e.key, { count: e.count + 1, since: e.since, ...(seen ? { seen } : {}) });
  if (ipBook.size > 10000) ipBook.delete(ipBook.keys().next().value);
}

async function loadRoom(req) {
  if (ipCount('miss', req.ip).count >= M.LIMITS.roomMissesPerIp) throw httpError(429, 'Too many wrong codes. Try again in a few minutes.');
  const code = R.normalizeCode(req.params.code);
  const link = R.isCode(code) ? await store.get('codes', code) : null;
  const m = link && await store.get(meetingsOf(link.uid), link.mid);
  if (!m || m.code !== code) {
    ipBump('miss', req.ip, code);
    throw httpError(404, 'That room code didn’t match a meeting. Check it with whoever is running it - codes change when they reset them.');
  }
  m.uid = link.uid;
  return m;
}

const votingOpen = (m, t) => R.started(m) && (!R.ended(m) || t - Date.parse(m.endedAt) < R.LIMITS.voteWindowMs);

/** What the room sees: enough to run the ticker and vote. No attendee label,
 *  no agenda owner, no log. */
function roomView(m, vote, vid, t) {
  return {
    code: R.formatCode(m.code),
    now: new Date(t).toISOString(),
    status: R.status(m),
    votingOpen: votingOpen(m, t),
    meeting: {
      title: m.title, people: m.people, mode: m.mode, loaded: Boolean(m.loaded), bookedMinutes: m.bookedMinutes,
      agenda: (m.agenda || []).map((it) => ({ title: it.title, minutes: it.minutes })),
      startedAt: m.startedAt || null, endedAt: m.endedAt || null, pauses: m.pauses || [], marks: m.marks || [],
    },
    room: { voters: Math.max(0, m.voterN || 0), emailVotes: Math.max(0, m.emailN || 0), rotiN: Math.max(0, m.rotiN || 0) },
    me: { roti: vote && typeof vote.roti === 'number' ? vote.roti : null, email: Boolean(vote && vote.email), handle: (vote && vote.handle) || null, bingoAt: (vote && vote.bingoAt) || null },
    bingo: m.bingo ? { card: R.deal(`${m.id}:${vid}`), winner: m.bingoFirst ? m.bingoFirst.handle : null } : null,
  };
}

app.get('/api/room/:code', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const m = await loadRoom(req);
    const vid = visitor(req, res);
    const vote = await store.get(votesOf(m.uid, m.id), vid);
    res.json(roomView(m, vote, vid, Date.now()));
  } catch (err) { fail(res, err); }
});

/**
 * One voter's change, applied to their own document; the meeting's counters
 * move by the difference, so a changed vote never counts twice.
 */
async function withVote(req, res, fn) {
  const m = await loadRoom(req);
  const t = Date.now();
  if (!votingOpen(m, t)) throw httpError(409, R.started(m) ? 'Voting has closed for this meeting.' : 'The meeting hasn’t started yet.');
  const vid = visitor(req, res);
  return exclusive(`vote/${m.id}/${vid}`, async () => {
    const prev = await store.get(votesOf(m.uid, m.id), vid);
    if (!prev) {
      if ((m.voterN || 0) >= M.LIMITS.voters) throw httpError(409, 'This room is full.');
      if (ipCount('voter', req.ip).count >= M.LIMITS.newVotersPerIp) throw httpError(429, 'Too many new voters from here. Try again later.');
    }
    const cur = prev ? { ...prev } : { roti: null, email: false, handle: null, bingoAt: null, createdAt: new Date(t).toISOString() };
    delete cur.id;
    const next = await fn(cur, m, vid, t);
    next.updatedAt = new Date(t).toISOString();
    await store.set(votesOf(m.uid, m.id), vid, next);
    const d = { voterN: prev ? 0 : 1 };
    const was = typeof cur.roti === 'number' ? cur.roti : null;
    const now2 = typeof next.roti === 'number' ? next.roti : null;
    d.rotiSum = (now2 || 0) - (was || 0);
    d.rotiN = (now2 === null ? 0 : 1) - (was === null ? 0 : 1);
    d.emailN = (next.email ? 1 : 0) - (cur.email ? 1 : 0);
    for (const k of Object.keys(d)) if (!d[k]) delete d[k];
    if (Object.keys(d).length) await store.bump(meetingsOf(m.uid), m.id, d);
    if (!prev) ipBump('voter', req.ip);
    const fresh = await store.get(meetingsOf(m.uid), m.id);
    fresh.uid = m.uid;
    return roomView(fresh, next, vid, t);
  });
}

app.post('/api/room/:code/vote', async (req, res) => {
  try {
    const raw = (req.body || {}).roti;
    const v = raw === null ? null : R.validRoti(raw);
    if (raw !== null && v === null) throw httpError(400, 'Vote 0 to 4.');
    res.json(await withVote(req, res, async (cur) => ({ ...cur, roti: v })));
  } catch (err) { fail(res, err); }
});

app.post('/api/room/:code/email', async (req, res) => {
  try {
    const on = (req.body || {}).on !== false;
    res.json(await withVote(req, res, async (cur) => ({ ...cur, email: on })));
  } catch (err) { fail(res, err); }
});

/**
 * A bingo claim. The claim sends the marked positions, and the server checks
 * them for a line with the same `bingoLine` the page uses. The card itself is
 * dealt from `meetingId:browserId` only for display: nobody can verify what
 * was said in the room, so the check is the shape, not the squares. The first
 * confirmed bingo is the one the receipt credits.
 */
app.post('/api/room/:code/bingo', async (req, res) => {
  try {
    const b = req.body || {};
    const handle = R.HANDLES.includes(b.handle) ? b.handle : null;
    if (!handle) throw httpError(400, 'Pick an emoji to play as.');
    const out = await withVote(req, res, async (cur, m) => {
      if (!m.bingo) throw httpError(409, 'Bingo is off for this meeting.');
      if (R.ended(m)) throw httpError(409, 'The meeting is over - no more bingo.');
      const line = R.bingoLine(b.marks);
      if (!line) throw httpError(400, 'Not a line yet - keep listening.');
      const next = { ...cur, handle, bingoAt: cur.bingoAt || new Date().toISOString(), line };
      await exclusive(`bingo/${m.id}`, async () => {
        const fresh = await store.get(meetingsOf(m.uid), m.id);
        if (!fresh.bingoFirst) await store.merge(meetingsOf(m.uid), m.id, { bingoFirst: { handle, at: next.bingoAt } });
      });
      return next;
    });
    res.json({ ...out, line: R.bingoLine(b.marks) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The recurring-meeting audit
 * ------------------------------------------------------------------ */

async function auditOf(uid) {
  const rows = (await loadRecurring(uid)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const a = R.audit(rows);
  return { ...a, rows: a.rows.map((x) => ({ ...x.r, annual: x.annual, saved: x.saved, hours: x.hours, suggestion: R.shrinkSuggestion(x.r) })), limit: M.LIMITS.recurring };
}

app.get('/api/recurring', user, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await auditOf(req.user.id));
  } catch (err) { fail(res, err); }
});

app.post('/api/recurring', user, async (req, res) => {
  try {
    const r = R.validateRecurring(req.body || {});
    if (r.error) throw httpError(400, r.error, { field: r.field });
    const n = (await loadRecurring(req.user.id)).length;
    if (n >= M.LIMITS.recurring) throw httpError(409, `The audit holds up to ${M.LIMITS.recurring} recurring meetings.`);
    const at = now();
    await store.set(recurringOf(req.user.id), M.newId(), { ...r.recurring, createdAt: at, updatedAt: at });
    res.json(await auditOf(req.user.id));
  } catch (err) { fail(res, err); }
});

/** Edit a row, or decide it: `decision` keep | shrink | kill | null, and for
 *  shrink the minutes, cadence and bands to send the recap instead. */
app.put('/api/recurring/:rid', user, async (req, res) => {
  try {
    const rid = String(req.params.rid || '');
    const prev = M.ID_RE.test(rid) ? await store.get(recurringOf(req.user.id), rid) : null;
    if (!prev) throw httpError(404, 'No such recurring meeting.');
    const r = R.validateRecurring(req.body || {}, prev);
    if (r.error) throw httpError(400, r.error, { field: r.field });
    await store.set(recurringOf(req.user.id), rid, { ...r.recurring, createdAt: prev.createdAt, updatedAt: now() });
    res.json(await auditOf(req.user.id));
  } catch (err) { fail(res, err); }
});

app.delete('/api/recurring/:rid', user, async (req, res) => {
  try {
    const rid = String(req.params.rid || '');
    const prev = M.ID_RE.test(rid) ? await store.get(recurringOf(req.user.id), rid) : null;
    if (!prev) throw httpError(404, 'No such recurring meeting.');
    await store.remove(recurringOf(req.user.id), rid);
    res.json(await auditOf(req.user.id));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The scoreboard. No model call anywhere below this line either.
 * ------------------------------------------------------------------ */

app.get('/api/scoreboard', user, async (req, res) => {
  try {
    const t = Date.now();
    const all = await loadAll(req.user.id);
    const rows = all.map((m) => M.summaryOf(m, t));
    const recent = all.filter(R.started).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, M.LIMITS.scoreboardLogs);
    const actions = [];
    for (const m of recent) {
      for (const l of await loadLog(req.user.id, m.id)) if (l.kind === 'action') actions.push({ ...M.logView(l), meetingId: m.id, meetingTitle: m.title, meetingDay: m.day || null });
    }
    const today = todayOf(req);
    const heats = actions.map((a) => R.heat(a, t, today).state);
    const counts = { open: heats.filter((h) => h !== 'done' && h !== 'dropped').length, done: heats.filter((h) => h === 'done').length, dropped: heats.filter((h) => h === 'dropped').length };
    res.set('Cache-Control', 'no-store');
    res.json({
      now: new Date(t).toISOString(),
      today,
      scoreboard: R.scoreboard(rows, await loadRecurring(req.user.id), today, { actions: counts }),
      openActions: R.byHeat(actions, t, today).slice(0, 15).map((r) => ({ ...r.action, heat: r.heat })),
    });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// The shared receipt (s/<token>) and the room (r/<code>) are the same
// single-page app served one level down. <base href="../"> makes every
// relative asset and API path in it resolve against the app root, mounted
// or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function publicIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get(['/s/:token', '/r/:code'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(publicIndex());
});
// GET is the only verb the public pages and the shared card answer.
app.all(['/s/:token', '/r/:code', '/api/shared/:token'], (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once - try a smaller photo or shorter notes.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // RECEIPT_DEV_MOUNT=/receipt runs it the way the lab host does: mounted
  // under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.RECEIPT_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`receipt listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
