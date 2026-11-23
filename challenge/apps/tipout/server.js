// Tipout - split the tip pool at close, to the cent, and show your working.
//
// Restaurants, bars and coffee shops pool tips and split them at the end of
// every shift - on the back of a receipt or in a fragile spreadsheet, at 1
// a.m., and staff can't see how their number was worked out, which is where
// the arguments start. Tipout is the shift lead's calculator for it: set the
// pool rules once (by hours, by points, or tip-outs to other roles first),
// then at close tick who worked, tap in hours, type card and cash tips, and
// every share comes back in dollars and cents with the arithmetic written
// out; the cash envelopes are built from the bills actually in the drawer;
// and each person can open a receipt link that shows how their share was
// worked out. See CLAUDE.md.
//
// A model is used for ONE thing: reading card tips, cash tips and food sales
// off a photo of the POS report. Everything else - the split, the rounding,
// the envelopes, the receipts, the week, the CSV - is public/rules.js, and
// free, and works without an account.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const R = require('./public/rules');
const S = require('./lib/shifts');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const gemini = require('./lib/gemini');
const { demo } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.TIPOUT_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('TIPOUT_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

// Which model reads a snapped POS report. TIPOUT_AI_PROVIDER=gemini moves it
// to Gemini on Vertex AI (through the lab's guard), which transcribes the
// whole report - totals, who worked, hours - for the shift lead to confirm;
// anything else, unset included, is Claude reading three totals, as it has
// always been. Read per request, so the switch is a Cloud Run setting and
// never a code change.
const providerNow = () => (process.env.TIPOUT_AI_PROVIDER === 'gemini' ? 'gemini' : 'claude');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere in these pages (2026-09-27): every app shares
  // one origin, so one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A receipt link is the credential for that receipt. It must not ride out
  // in a Referer header, and it must not be indexed under Tipout's name.
  if (req.path.startsWith('/s/') || req.path.startsWith('/api/shared/')) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// One route carries a file: the POS report photo (≤6 MB, base64). It mounts
// its parser AFTER the sign-in, budget and daily-cap gates, so a stranger's
// upload is never read. Everything else stays at 128 KB.
const SNAP_ROUTE = /^\/api\/snap$/;
const snapJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (SNAP_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'tipout',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Tipout',
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
 * Helpers
 * ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
const httpError = S.httpError;
const todayOf = (req) => S.todayFrom(req.get('x-local-date') || req.query.today);

// Only the app's own errors (S.httpError, marked `expose`) reach the client
// with their status and words. Anything else is logged and answered with the
// route's fallback - including the Anthropic SDK's errors, which carry a
// `.status` and a raw JSON body of their own. An upstream failure is a 502
// (503 when it is overloaded or rate-limited). Never a request body in the
// log: a POS report and a crew list are somebody's business.
const fail = (res, err, fallback = 'Something went wrong.') => {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  const body = { error: mine ? err.message : fallback };
  if (mine) for (const k of ['field', 'code']) if (err[k] !== undefined) body[k] = err[k];
  res.status(status).json(body);
};

// A manager's pool and shifts live under their own uid: nobody else's id can
// name them, so every route is a 404 for anyone else's.
const SETUPS = 'setups';
const shiftsOf = (uid) => `shifts/${uid}/items`;
const SHARES = 'shares';

async function loadSetup(uid) {
  const raw = await store.get(SETUPS, uid);
  if (!raw || !raw.roles) return null;
  const v = R.validateSetup(raw);
  return v.error ? null : v.setup;
}

async function loadShift(req) {
  const id = String(req.params.id || '');
  const doc = S.ID_RE.test(id) ? await store.get(shiftsOf(req.user.id), id) : null;
  if (!doc) throw httpError(404, 'No such shift.');
  return doc;
}

/**
 * One read-modify-write at a time per key on this instance, queued rather
 * than refused: a double-tapped Save must not store the shift twice, and two
 * Share taps must not mint two sets of links.
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

/** Validate a posted shift and work it out; a shift that cannot be split is
 *  a 400 with the reason, never a saved row that errors on every read. */
function checkShift(body, today) {
  const v = R.validateShift(body || {}, today);
  if (v.error) throw httpError(400, v.error, { field: v.field });
  const result = R.split(v.shift);
  if (result.error) throw httpError(400, result.error, { field: result.field });
  return { shift: v.shift, result };
}

/** A computed shift for the page: inputs, split, envelopes and links. */
function shiftView(c) {
  if (c.error) return { id: c.id, error: c.error };
  const share = c.share && c.share.token ? {
    token: c.share.token,
    url: `s/${c.share.token}`,
    at: c.share.at || null,
    people: c.result.people.filter((p) => c.share.people && c.share.people[p.pid]).map((p) => ({ pid: p.pid, name: p.name, token: c.share.people[p.pid], url: `s/${c.share.people[p.pid]}` })),
  } : null;
  return {
    id: c.id, shift: c.shift, result: c.result, envelopes: R.envelopesFor(c.result, c.shift.drawer),
    text: R.receiptText(c.shift, c.result), share, createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

/**
 * Freeze the receipts for a shift: one link for the whole shift, one per
 * person. Tokens already issued are kept (a staff member's saved link keeps
 * working after an edit); a person no longer on the shift loses theirs.
 */
async function freezeShares(uid, id, c, prev) {
  const at = now();
  const fresh = async () => { let t = S.newToken(); while (await store.get(SHARES, t)) t = S.newToken(); return t; };
  const token = (prev && prev.token) || await fresh();
  await store.set(SHARES, token, { uid, sid: id, pid: null, createdAt: at, card: R.shareCard(c.shift, c.result, null, at) });
  const people = {};
  for (const p of c.result.people) {
    const t = (prev && prev.people && prev.people[p.pid]) || await fresh();
    people[p.pid] = t;
    await store.set(SHARES, t, { uid, sid: id, pid: p.pid, createdAt: at, card: R.shareCard(c.shift, c.result, p.pid, at) });
  }
  for (const [pid, t] of Object.entries((prev && prev.people) || {})) if (!people[pid]) await store.remove(SHARES, t);
  const share = { token, people, at };
  // Replace the map whole: a merge would keep a removed person's token.
  const { id: _id, ...rest } = await store.get(shiftsOf(uid), id);
  await store.set(shiftsOf(uid), id, { ...rest, share });
  return share;
}

async function dropShares(uid, id, prev) {
  if (!prev) return;
  if (prev.token) await store.remove(SHARES, prev.token);
  for (const t of Object.values(prev.people || {})) await store.remove(SHARES, t);
  await store.merge(shiftsOf(uid), id, { share: null });
}

/* ------------------------------------------------------------------ *
 * Public: health, meta, the sample bar
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ methods: R.METHODS, templates: R.TEMPLATES, parts: R.PARTS, denoms: R.DENOMS, limits: S.LIMITS });
});

// An invented bar's Friday, run through the real rules. No account, no
// write and no model call for a signed-out visitor, ever.
app.get('/api/demo', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(demo(todayOf(req)));
});

/* ------------------------------------------------------------------ *
 * Me and my pool rules
 * ------------------------------------------------------------------ */

app.get('/api/me', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.json({ signedIn: false });
    res.json({
      signedIn: true,
      email: req.user.email,
      name: S.nameFromEmail(req.user.email),
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      // What a snap reads: 'totals' (three numbers) or 'report' (totals,
      // who worked and hours).
      snap: providerNow() === 'gemini' ? 'report' : 'totals',
      setup: await loadSetup(req.user.id),
    });
  } catch (err) { fail(res, err); }
});

/** The pool rules and the roster, replaced whole. */
app.put('/api/setup', user, async (req, res) => {
  try {
    const v = R.validateSetup(req.body || {});
    if (v.error) throw httpError(400, v.error, { field: v.field });
    await store.merge(SETUPS, req.user.id, { ...v.setup, updatedAt: now() });
    res.json({ setup: v.setup });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Shifts. One document each, under the manager's uid.
 * ------------------------------------------------------------------ */

/** Shifts dated from..to (inclusive), oldest first, at most `limit`. */
async function shiftsBetween(uid, from, to, limit) {
  const rows = await store.list(shiftsOf(uid), { where: [['date', '>=', from]], orderBy: 'date', dir: 'asc', limit });
  return rows.filter((d) => d.date <= to);
}

function range(req, days) {
  const today = todayOf(req);
  const to = R.isoDay(req.query.to) || today;
  const from = R.isoDay(req.query.from) || R.addDays(to, -(days - 1));
  if (from > to) throw httpError(400, 'The start date is after the end date.');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > S.LIMITS.exportDays) throw httpError(400, `Up to ${S.LIMITS.exportDays} days at a time.`);
  return { from, to };
}

app.get('/api/shifts', user, async (req, res) => {
  try {
    const { from, to } = range(req, 60);
    const rows = await shiftsBetween(req.user.id, from, to, S.LIMITS.shifts);
    res.set('Cache-Control', 'no-store');
    res.json({ from, to, shifts: rows.map((d) => S.summary(S.computed(d))).reverse() });
  } catch (err) { fail(res, err); }
});

app.post('/api/shifts', user, async (req, res) => {
  try {
    const { shift } = checkShift(req.body, todayOf(req));
    const out = await exclusive(`save/${req.user.id}`, async () => {
      const counts = (await store.get(SETUPS, req.user.id)) || {};
      if ((counts.shiftCount || 0) >= S.LIMITS.shifts) throw httpError(409, `You can keep up to ${S.LIMITS.shifts} shifts - export and delete old ones first.`);
      const sameDay = await store.list(shiftsOf(req.user.id), { where: [['date', '==', shift.date]], limit: 10 });
      if (sameDay.length >= 8) throw httpError(409, 'That day already has 8 shifts saved.');
      const id = S.newId();
      const at = now();
      await store.set(shiftsOf(req.user.id), id, { ...S.toStore(shift), createdAt: at, updatedAt: at });
      await store.bump(SETUPS, req.user.id, { shiftCount: 1 });
      return S.computed({ id, ...S.toStore(shift), createdAt: at, updatedAt: at });
    });
    res.json(shiftView(out));
  } catch (err) { fail(res, err); }
});

app.get('/api/shifts/:id', user, async (req, res) => {
  try {
    const doc = await loadShift(req);
    res.set('Cache-Control', 'no-store');
    res.json(shiftView(S.computed(doc)));
  } catch (err) { fail(res, err); }
});

/** Correct a saved shift. If its receipts were shared, the links show the
 *  corrected numbers at once - a stale receipt is worse than none. */
app.put('/api/shifts/:id', user, async (req, res) => {
  try {
    const out = await exclusive(`shift/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadShift(req);
      const { shift } = checkShift(req.body, todayOf(req));
      const patch = { ...S.toStore(shift), updatedAt: now() };
      // Replaced whole, not merged: a merge would keep a bill count or a
      // tip-out the correction took out.
      const { id: _id, ...rest } = doc;
      await store.set(shiftsOf(req.user.id), doc.id, { ...rest, ...patch });
      const c = S.computed({ ...doc, ...patch });
      if (doc.share && doc.share.token) c.share = await freezeShares(req.user.id, doc.id, c, doc.share);
      return c;
    });
    res.json(shiftView(out));
  } catch (err) { fail(res, err); }
});

app.delete('/api/shifts/:id', user, async (req, res) => {
  try {
    await exclusive(`shift/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadShift(req);
      await dropShares(req.user.id, doc.id, doc.share);
      await store.remove(shiftsOf(req.user.id), doc.id);
      await store.bump(SETUPS, req.user.id, { shiftCount: -1 });
    });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** Publish (or refresh) the receipt links: the whole shift and each person. */
app.post('/api/shifts/:id/share', user, async (req, res) => {
  try {
    const out = await exclusive(`shift/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadShift(req);
      const c = S.computed(doc);
      if (c.error) throw httpError(409, c.error);
      c.share = await freezeShares(req.user.id, doc.id, c, doc.share);
      return c;
    });
    res.json(shiftView(out));
  } catch (err) { fail(res, err); }
});

/** Revoke every link for this shift. They die at once. */
app.delete('/api/shifts/:id/share', user, async (req, res) => {
  try {
    await exclusive(`shift/${req.user.id}/${req.params.id}`, async () => {
      const doc = await loadShift(req);
      await dropShares(req.user.id, doc.id, doc.share);
    });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * History: the week, and the spreadsheet
 * ------------------------------------------------------------------ */

app.get('/api/week', user, async (req, res) => {
  try {
    const start = R.weekStart(R.isoDay(req.query.start) || todayOf(req));
    const end = R.addDays(start, 6);
    const items = (await shiftsBetween(req.user.id, start, end, S.LIMITS.weekShifts)).map(S.computed);
    res.set('Cache-Control', 'no-store');
    res.json({ week: R.week(items.filter((c) => !c.error), start), shifts: items.map(S.summary).reverse() });
  } catch (err) { fail(res, err); }
});

app.get('/api/export.csv', user, async (req, res) => {
  try {
    const { from, to } = range(req, 7);
    const items = (await shiftsBetween(req.user.id, from, to, S.LIMITS.shifts)).map(S.computed).filter((c) => !c.error);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${S.csvFilename(from, to)}"`);
    res.send(R.exportCsv(items));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Metered: snap the POS report
 * ------------------------------------------------------------------ */

/**
 * One photo, read once by the model, never stored. The gates run first, then
 * the 6 MB parser, then the photo is checked by its bytes (400, nothing
 * spent), then the lab's AI guard (the month's cap per provider and the
 * burst limits, when the host has one; its refusal is a 429/503 with its own
 * words) - and only then ONE call: a forced tool on Claude, or a
 * responseSchema on Gemini. Either way the answer is a proposal the shift
 * lead confirms on the page; every split, percentage and total is
 * public/rules.js. Nothing readable is a 422.
 */
const UNREADABLE = 'We couldn’t read a POS report in that photo. Try a closer, flatter, well-lit shot - or type the tips in.';
const NO_TOTALS = 'We couldn’t find card or cash tip totals on that report. Type them in - it takes a few seconds.';
const NOTHING = 'We couldn’t find tips or hours on that report. Type them in - it takes a few seconds.';

async function guardAllow(provider, req) {
  const guard = global.LAB_AI_GUARD;
  if (!guard) return;
  const a = await guard.allow({ provider, req, app: 'tipout' });
  if (!a || !a.ok) throw httpError((a && a.status) || 503, (a && a.message) || 'Reading photos is resting for now. Typing the tips in always works.', { code: (a && a.code) || 'ai-guard' });
}
/** Tell the guard what a call cost. Never fails the answer it measured. */
async function guardRecord(provider, model, usage) {
  const guard = global.LAB_AI_GUARD;
  if (!guard || !usage) return;
  try { await guard.record({ provider, app: 'tipout', usd: guard.priceUsd({ provider, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) }); } catch (e) { console.error('ai guard: record failed'); }
}

/** Claude, as it has always been: three totals, and the identity meter
 *  charges the person. */
async function snapWithClaude(req, image) {
  const client = await clientFor(req);
  const model = modelFor(req);
  let used = null;
  let raw;
  try {
    raw = await ai.readReport(client, model, image, (u) => { used = u; });
  } finally {
    // A member's own key paid for theirs; the lab's cap counts the lab's key.
    if (!client.__byok) await guardRecord('claude', model, used);
  }
  const reading = ai.cleanReading(raw);
  if (!reading) throw httpError(422, raw && raw.readable === false ? UNREADABLE : NO_TOTALS);
  return reading;
}

/** Gemini, through the guard's Vertex helper. With no guard (the app on its
 *  own) only the local stand-in can answer; a real call needs the lab. */
async function snapWithGemini(req, image) {
  const guard = global.LAB_AI_GUARD;
  const today = todayOf(req);
  const request = gemini.request(image, today);
  const fake = FAKE_AI ? require('./lib/fakeai').gemini : undefined;
  let generate = guard && guard.gemini && guard.gemini.generate;
  if (!generate && fake) generate = async (r) => ({ json: await fake({ contents: r.contents }), usage: { inputTokens: 1900, outputTokens: 700 } });
  if (!generate) throw Object.assign(new Error('no gemini helper'), { status: 503, gemini: 'no-helper' });
  let out = null;
  let usage = null;
  try {
    out = await generate({ ...request, ...(fake ? { fake } : {}) });
    usage = out && out.usage;
  } catch (err) {
    // A call that failed after the model billed it is still paid for. The
    // provider's own words never reach the page: a status only.
    usage = err && err.usage;
    throw Object.assign(new Error('gemini call failed'), { status: Number.isInteger(err && err.status) ? err.status : (err && err.code === 'timeout' ? 503 : 502), gemini: (err && err.code) || 'error' });
  } finally {
    if (usage) {
      await guardRecord('gemini', gemini.MODEL, usage);
      await chargeGemini(req, usage);
    }
  }
  const report = gemini.cleanReading(out && out.json, today);
  if (!report) throw httpError(422, UNREADABLE);
  // Tipout's own arithmetic on the transcription: what the figures come to
  // and which need a second look. The page runs the same function.
  const check = R.reportCheck(report);
  const hasTips = check.card.cents !== null || check.cash.cents !== null;
  if (!hasTips && !report.staff.length) throw httpError(422, NOTHING);
  const proposal = { card: '', cash: '', sales: '' };
  const filled = [];
  const dropped = [];
  let low = 1;
  for (const [k, label] of [['card', 'card tips'], ['cash', 'cash tips'], ['sales', 'food sales']]) {
    if (check[k].cents !== null) { proposal[k] = R.plain(check[k].cents); filled.push(k); if (check[k].flag) low = Math.min(low, check[k].source === 'printed' ? report.totals[k].confidence : 0.5); } else dropped.push(label);
  }
  return { reader: 'report', proposal, filled, dropped, confidence: low >= R.UNCLEAR ? 'high' : low >= 0.5 ? 'medium' : 'low', note: '', report };
}

/** The person's own ledger (their credit, and the free tier's daily
 *  ceiling) is the identity's, and its price table is Claude's. A Gemini
 *  call is charged there at its real dollars, written as the Haiku input
 *  tokens that cost the same, with the route saying what really ran. */
async function chargeGemini(req, usage) {
  try {
    const guard = global.LAB_AI_GUARD;
    const usd = guard ? guard.priceUsd({ provider: 'gemini', model: gemini.MODEL, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) : gemini.priceUsd(usage);
    const perToken = identityLib.PRICES[MODELS.free].input / 1e6;
    await identity.recordUsage({ model: MODELS.free, usage: { input_tokens: Math.ceil(usd / perToken), output_tokens: 0 }, route: `snap:${gemini.MODEL}`, uid: req.user.id });
  } catch (e) { console.error('usage: gemini charge failed'); }
}

/** Gemini first, for a feature Claude also has. If the Gemini step fails for
 *  any reason but a burst refusal - a thrown call, output the validator
 *  rejects (a 422, or `viaGemini()` resolving falsy), the month's Gemini cap,
 *  no helper - Claude's own path answers the same request, unchanged (its own
 *  guard, gates and meter). A burst is per person across both providers: its
 *  refusal goes out as it is. One log line, no user data. */
const BURSTS = new Set(['burst-minute', 'burst-day']);
async function geminiElseClaude(viaGemini, viaClaude) {
  let code;
  try {
    const out = await viaGemini();
    if (out) return out;
    code = 'unusable';
  } catch (err) {
    if (err && BURSTS.has(err.code)) throw err;
    code = String((err && (err.gemini || (err.status === 422 ? 'unusable' : err.code))) || 'error').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'error';
  }
  console.log(`[tipout] gemini failed (${code}); used claude`);
  return viaClaude();
}

app.post('/api/snap', ...spend, snapJson, async (req, res) => {
  try {
    const image = photo.validate((req.body || {}).image);
    const viaClaude = async () => { await guardAllow('claude', req); return { reader: 'totals', ...(await snapWithClaude(req, image)) }; };
    res.json(providerNow() === 'gemini'
      ? await geminiElseClaude(async () => { await guardAllow('gemini', req); return snapWithGemini(req, image); }, viaClaude)
      : await viaClaude());
  } catch (err) { fail(res, err, 'Could not read that photo. Try again, or type the tips in.'); }
});

/* ------------------------------------------------------------------ *
 * The receipt links: frozen, public, read-only
 * ------------------------------------------------------------------ */

app.get('/api/shared/:token', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = String(req.params.token || '');
    if (!S.TOKEN_RE.test(token)) throw httpError(404, 'This link is not valid.');
    const s = await store.get(SHARES, token);
    if (!s || !s.card) throw httpError(404, 'This link is not valid any more. Ask your shift lead for a new one.');
    res.json({ ...s.card, preview: Boolean(req.user && req.user.id === s.uid) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// A receipt is the same single-page app served one level down at s/<token>.
// <base href="../"> makes every relative asset and API path in it resolve
// against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function publicIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/s/:token', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(publicIndex());
});
// GET is the only verb the public paths answer.
app.all(['/s/:token', '/api/shared/:token'], (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once - try a smaller photo.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // TIPOUT_DEV_MOUNT=/tipout runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.TIPOUT_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`tipout listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
