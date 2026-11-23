// Tally - close the day in a minute; know every card sale got paid.
//
// Small shops, cafés, restaurants and salons: every day the card terminal
// says "we took $1,284", and a day or three later the processor puts a
// smaller number in the bank - minus fees, holds and refunds. Nobody checks,
// so a short deposit, a batch that never settled or a rate that crept up 0.3
// points slips through. Tally is the check: type (or snap) the day's four
// numbers, paste the bank's CSV, and every day comes back matched, short,
// pending or missing - with the reason in plain words. See CLAUDE.md.
//
// A model is used for ONE thing: reading the numbers off a photo of the
// terminal's end-of-day report. Everything else - the fee model, the
// settlement calendar, the matching, the month, the CSV import and export -
// is public/rules.js, and free. There is no bank connection and never a bank
// login: deposits come from a CSV the owner downloads themselves.

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const R = require('./public/rules');
const B = require('./lib/books');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const gemini = require('./lib/gemini');
const { demo } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.TALLY_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('TALLY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

// Which model reads a snapped report. TALLY_AI_PROVIDER=gemini moves it to
// Gemini on Vertex AI (lib/gemini.js), which reads a Z-report OR a
// processor's payout report, figure by figure with a confidence each.
// Anything else - unset included - is Claude, exactly as before, so merging
// the code changes nothing until the switch is set. Read per request.
// TALLY_AI_PROVIDER=claude-first (2026-11-23): a photo goes to Claude first,
// Gemini when Claude fails; pasted text (Gemini only) is on.
const providerNow = () => (process.env.TALLY_AI_PROVIDER === 'claude-first' ? 'claude-first' : process.env.TALLY_AI_PROVIDER === 'gemini' ? 'gemini' : 'claude');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere in these pages (2026-09-27): every app shares
  // one origin, so one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Two routes carry a file. The Z-report photo (≤6 MB, base64) mounts its
// parser AFTER the sign-in, budget and daily-cap gates; the bank CSV (≤2.5 MB,
// no model) AFTER the sign-in. A stranger's upload is never read. Everything
// else stays at 128 KB.
const SNAP_ROUTE = /^\/api\/days\/snap$/;
const CSV_ROUTE = /^\/api\/deposits\/csv$/;
const snapJson = express.json({ limit: '6mb' });
const csvJson = express.json({ limit: '2.5mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (SNAP_ROUTE.test(req.path) || CSV_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'tally',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Tally',
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
const httpError = B.httpError;
const todayOf = (req) => B.todayFrom(req.get('x-local-date') || req.query.today);

// Only the app's own errors (B.httpError, marked `expose`) reach the client
// with their status and words. Anything else is logged and answered with the
// route's fallback - including the Anthropic SDK's errors, which carry a
// `.status` and a raw JSON body of their own. An upstream failure is a 502
// (503 when it is overloaded or rate-limited). Never a request body in the
// log: a Z-report and a bank statement are somebody's business.
const fail = (res, err, fallback = 'Something went wrong.') => {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  const body = { error: mine ? err.message : fallback };
  if (mine) for (const k of ['field', 'code']) if (err[k] !== undefined) body[k] = err[k];
  res.status(status).json(body);
};

// A person's books live under their own uid: nobody else's date or id can
// name them, so every route is a 404 for anyone else's.
const daysOf = (uid) => `days/${uid}/items`;
const depositsOf = (uid) => `deposits/${uid}/items`;
const SETTINGS = 'settings';

const loadDays = (uid) => store.list(daysOf(uid), { limit: B.LIMITS.days + 5 });
const loadDeposits = (uid) => store.list(depositsOf(uid), { limit: B.LIMITS.deposits + 5 });
const loadSettings = async (uid) => R.settingsOf(await store.get(SETTINGS, uid));

/**
 * One read-modify-write at a time per person on this instance, queued rather
 * than refused: two imports at once must not both pass the 2,000 cap or both
 * add the same statement line.
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

/* ------------------------------------------------------------------ *
 * Public: health, meta, the sample café
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ presets: R.PRESETS, keywords: R.DEFAULT_KEYWORDS, defaults: R.DEFAULTS, statuses: R.STATUS, limits: B.LIMITS });
});

// An invented café reconciled by the page through the real rules. No model
// call and no write for a signed-out visitor, ever.
app.get('/api/demo', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(demo());
});

/* ------------------------------------------------------------------ *
 * Me and my books
 * ------------------------------------------------------------------ */

app.get('/api/me', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // Which reader a snap gets: 'report' (Gemini: figures with a confidence
    // each, checked by rules.checkReport) or 'zreport' (Claude, as before).
    const reader = providerNow() !== 'claude' ? 'report' : 'zreport';
    if (!req.user) return res.json({ signedIn: false, reader });
    const s = await loadSettings(req.user.id);
    res.json({
      signedIn: true,
      reader,
      email: req.user.email,
      name: B.nameFromEmail(req.user.email),
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      business: s.business,
      configured: s.configured,
    });
  } catch (err) { fail(res, err); }
});

/** Everything the page reconciles: settings, every closed day and every
 *  deposit (both capped), and "today" as the browser sees it. The matching
 *  itself runs in the page with the same rules the export uses. */
app.get('/api/books', user, async (req, res) => {
  try {
    const [settings, days, deposits] = await Promise.all([loadSettings(req.user.id), loadDays(req.user.id), loadDeposits(req.user.id)]);
    res.set('Cache-Control', 'no-store');
    res.json({ today: todayOf(req), settings, days: days.map(B.dayView), deposits: deposits.map(B.depositView), limits: B.LIMITS });
  } catch (err) { fail(res, err); }
});

app.put('/api/settings', user, async (req, res) => {
  try {
    const out = await exclusive(`s/${req.user.id}`, async () => {
      const prev = await store.get(SETTINGS, req.user.id);
      const r = R.validateSettings(req.body || {}, prev);
      if (r.error) throw httpError(400, r.error, { field: r.field });
      await store.set(SETTINGS, req.user.id, { ...r.settings, updatedAt: now() });
      return r.settings;
    });
    res.json({ settings: out });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Closing a day. One document per day, keyed by its date.
 * ------------------------------------------------------------------ */

function dateParam(req) {
  const d = R.isoDay(req.params.date);
  if (!d) throw httpError(404, 'No such day.');
  return d;
}

/** Close a day - or correct one already closed: the date is the document's
 *  id, so saving the same day again replaces it rather than adding a twin. */
app.put('/api/days/:date', user, async (req, res) => {
  try {
    const date = R.isoDay(req.params.date);
    if (!date) throw httpError(400, 'Which day is this? Pick a date.', { field: 'date' });
    const r = R.validateDay({ ...(req.body || {}), date }, todayOf(req));
    if (r.error) throw httpError(400, r.error, { field: r.field });
    const out = await exclusive(`d/${req.user.id}`, async () => {
      const prev = await store.get(daysOf(req.user.id), date);
      if (!prev && (await loadDays(req.user.id)).length >= B.LIMITS.days) {
        throw httpError(409, `Tally keeps ${B.LIMITS.days} closed days. Delete an old one first.`);
      }
      const at = now();
      const doc = { ...r.day, createdAt: prev ? prev.createdAt : at, updatedAt: at };
      await store.set(daysOf(req.user.id), date, doc);
      return { day: B.dayView(doc), replaced: Boolean(prev) };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.get('/api/days/:date', user, async (req, res) => {
  try {
    const d = await store.get(daysOf(req.user.id), dateParam(req));
    if (!d) throw httpError(404, 'No such day.');
    res.set('Cache-Control', 'no-store');
    res.json({ day: B.dayView(d) });
  } catch (err) { fail(res, err); }
});

app.delete('/api/days/:date', user, async (req, res) => {
  try {
    const date = dateParam(req);
    const d = await store.get(daysOf(req.user.id), date);
    if (!d) throw httpError(404, 'No such day.');
    await store.remove(daysOf(req.user.id), date);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/**
 * Snap the report: one photo (or, on Gemini, pasted text), read once by the
 * model, never stored. It proposes the day's numbers; the owner checks them
 * and presses Save, which is the ordinary PUT above. The photo is checked by
 * its bytes before any spend (400); nothing readable is a 422.
 *
 * Gates, in order: sign-in, budget and the daily cap (`spend`), the body
 * parser, the input check, the lab's AI guard (`allow`), then ONE schema'd
 * call - a forced tool on Claude, a responseSchema on Gemini - then `record`.
 * Every sum and verdict about the figures is rules.js, never the model.
 */
const NOT_A_REPORT = 'We couldn’t read an end-of-day report in that photo. Try a closer, flatter, well-lit shot - or type the four numbers.';
const NO_CARD_TOTAL = 'We couldn’t find a card-sales total on that report. Type the numbers in - it takes a minute.';
const NO_FIGURES = 'We couldn’t read a card-sales total or a payout on that. Try a closer, flatter, well-lit shot - or type the numbers in.';
const SNAP_FALLBACK = 'Could not read that photo. Try again, or type the numbers in.';

async function guardAllow(provider, req) {
  const guard = global.LAB_AI_GUARD;
  if (!guard) return;
  const a = await guard.allow({ provider, req, app: 'tally' });
  if (!a || !a.ok) throw httpError((a && a.status) || 503, (a && a.message) || 'AI is resting for now. Typing the numbers in still works.', { code: (a && a.code) || 'ai-guard' });
}
/** Tell the guard what a call cost. Never fails the answer it measured. */
async function guardRecord(provider, model, usage) {
  const guard = global.LAB_AI_GUARD;
  if (!guard || !usage) return;
  try { await guard.record({ provider, app: 'tally', usd: guard.priceUsd({ provider, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) }); } catch (e) { console.error('ai guard: record failed'); }
}

/** Claude, as it has always been: the identity meter charges the person. */
async function snapWithClaude(req, image, today) {
  const client = await clientFor(req);
  const model = modelFor(req);
  let used = null;
  let raw;
  try {
    raw = await ai.readReport(client, model, image, today, (u) => { used = u; });
  } finally {
    // A member's own key paid for theirs; the lab's cap counts the lab's key.
    if (!client.__byok) await guardRecord('claude', model, used);
  }
  const reading = ai.cleanReading(raw, today);
  if (!reading) throw httpError(422, raw && raw.readable === false ? NOT_A_REPORT : NO_CARD_TOTAL);
  return reading;
}

/** Gemini, through the guard's Vertex helper. With no guard (the app on its
 *  own) only the local stand-in can answer; a real call needs the lab. */
async function snapWithGemini(req, input, today) {
  const guard = global.LAB_AI_GUARD;
  const request = gemini.request(input, today);
  const fake = FAKE_AI ? require('./lib/fakeai').gemini : undefined;
  let generate = guard && guard.gemini && guard.gemini.generate;
  if (!generate && fake) generate = async (r) => ({ json: await fake({ contents: r.contents }), usage: { inputTokens: 1900, outputTokens: 260 } });
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
  const reading = gemini.cleanReading(out && out.json, today);
  if (!reading) throw httpError(422, out && out.json && out.json.reportType === 'not_a_report' ? NOT_A_REPORT : NO_FIGURES);
  return reading;
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
  console.log(`[tally] gemini failed (${code}); used claude`);
  return viaClaude();
}

/** Claude first (TALLY_AI_PROVIDER=claude-first): the same two paths in the
 *  other order. If Claude's own path fails for any reason but a burst
 *  refusal - a thrown SDK error, a reading the validator rejects (a 422), the
 *  month's Claude cap, no key - Gemini's own path answers the same photo. */
async function claudeElseGemini(viaClaude, viaGemini) {
  let code;
  try {
    const out = await viaClaude();
    if (out) return out;
    code = 'unusable';
  } catch (err) {
    if (err && BURSTS.has(err.code)) throw err;
    code = String((err && (err.status === 422 ? 'unusable' : (err.code || err.status))) || 'error').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'error';
  }
  console.log(`[tally] claude failed (${code}); used gemini`);
  return viaGemini();
}

app.post('/api/days/snap', ...spend, snapJson, async (req, res) => {
  try {
    const b = req.body || {};
    const mode = providerNow();
    const viaGemini = mode !== 'claude';
    const today = todayOf(req);
    let input;
    if (viaGemini && b.image === undefined && typeof b.text === 'string') {
      // Pasted text, on Gemini only: scrubbed here as well as on the phone,
      // so nothing with a full card, account or merchant number is sent.
      const text = R.scrubReportText(b.text);
      if (text.replace(/[^0-9]/g, '').length < 3) throw httpError(400, 'Paste the report’s text - the lines with the totals on them.', { field: 'text' });
      input = { text };
    } else {
      input = { image: photo.validate(b.image) };
    }
    const viaClaude = async () => { await guardAllow('claude', req); return snapWithClaude(req, input.image, today); };
    if (!viaGemini) return res.json(await viaClaude());
    const viaGeminiNow = async () => { await guardAllow('gemini', req); return snapWithGemini(req, input, today); };
    // Pasted text is Gemini's alone: no Claude path to fall back to. A photo
    // falls back to the Z-report reader, and says so (`reader: 'zreport'`).
    // Claude first: the Z-report reader, then Gemini's report reader if it fails.
    const viaZ = async () => ({ reader: 'zreport', ...(await viaClaude()) });
    if (input.text !== undefined) return res.json(await viaGeminiNow());
    res.json(mode === 'claude-first' ? await claudeElseGemini(viaZ, viaGeminiNow) : await geminiElseClaude(viaGeminiNow, viaZ));
  } catch (err) { fail(res, err, SNAP_FALLBACK); }
});

/* ------------------------------------------------------------------ *
 * Deposits. One document each.
 * ------------------------------------------------------------------ */

/**
 * Add deposits: one ({date, amount, description}) or many ({deposits: [...]},
 * from the import). All-or-nothing validation; lines already in the books
 * (same date, amount and description) are skipped, not doubled.
 */
app.post('/api/deposits', user, async (req, res) => {
  try {
    const b = req.body || {};
    const list = Array.isArray(b.deposits) ? b.deposits : [b];
    if (!list.length) throw httpError(400, 'Nothing to add.');
    if (list.length > B.LIMITS.importRows) throw httpError(400, `Add up to ${B.LIMITS.importRows} deposits at a time.`);
    const today = todayOf(req);
    const clean = list.map((raw, i) => {
      const r = R.validateDeposit(raw, today);
      if (r.error) throw httpError(400, list.length > 1 ? `Line ${i + 1}: ${r.error}` : r.error, { field: r.field });
      return r.deposit;
    });
    const out = await exclusive(`dep/${req.user.id}`, async () => {
      const have = await loadDeposits(req.user.id);
      const keys = new Set(have.map((d) => R.depositKey(d)));
      const fresh = [];
      for (const d of clean) {
        const k = R.depositKey(d);
        if (keys.has(k)) continue;
        keys.add(k);
        fresh.push(d);
      }
      if (have.length + fresh.length > B.LIMITS.deposits) {
        throw httpError(409, `Tally keeps ${B.LIMITS.deposits} deposits and you have ${have.length}. Delete old ones, or import a shorter date range.`);
      }
      const at = now();
      const added = [];
      for (const d of fresh) {
        const id = B.newId();
        const doc = { ...d, createdAt: at };
        await store.set(depositsOf(req.user.id), id, doc);
        added.push(B.depositView({ id, ...doc }));
      }
      return { added, skipped: clean.length - fresh.length };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

async function loadDeposit(req) {
  const id = String(req.params.id || '');
  const d = B.ID_RE.test(id) ? await store.get(depositsOf(req.user.id), id) : null;
  if (!d) throw httpError(404, 'No such deposit.');
  return d;
}

app.put('/api/deposits/:id', user, async (req, res) => {
  try {
    const d = await loadDeposit(req);
    const b = req.body || {};
    const r = R.validateDeposit({
      date: b.date !== undefined ? b.date : d.date,
      amount: b.amount !== undefined ? b.amount : R.plain(d.amountCents),
      description: b.description !== undefined ? b.description : d.description,
      source: d.source,
    }, todayOf(req));
    if (r.error) throw httpError(400, r.error, { field: r.field });
    await store.merge(depositsOf(req.user.id), d.id, { ...r.deposit, updatedAt: now() });
    res.json({ deposit: B.depositView({ ...d, ...r.deposit }) });
  } catch (err) { fail(res, err); }
});

app.delete('/api/deposits/:id', user, async (req, res) => {
  try {
    const d = await loadDeposit(req);
    await store.remove(depositsOf(req.user.id), d.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/**
 * Read a bank's CSV into the money that came in, each line marked when its
 * description names a card processor (the keywords in settings) and when it
 * is already in the books. Saves NOTHING: the page lists the lines ticked and
 * adds the ones still ticked through POST /api/deposits. The file is parsed
 * in the request and dropped - no bank connection, no login, no copy.
 */
app.post('/api/deposits/csv', user, csvJson, async (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.csv !== 'string' || !b.csv.trim()) throw httpError(400, 'Paste the CSV, or choose the file your bank gave you.', { field: 'csv' });
    const [settings, have] = await Promise.all([loadSettings(req.user.id), loadDeposits(req.user.id)]);
    const r = R.parseBankCsv(b.csv, settings.keywords);
    if (r.error) throw httpError(400, r.error, { field: 'csv' });
    const keys = new Set(have.map((d) => R.depositKey(d)));
    res.json({ rows: r.rows.map((x) => ({ ...x, have: keys.has(x.key) })), skipped: r.skipped, cards: r.cards });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The month's reconciliation as a spreadsheet
 * ------------------------------------------------------------------ */

app.get('/api/export', user, async (req, res) => {
  try {
    const m = R.isoMonth(req.query.month);
    if (!m) throw httpError(400, 'Which month? Use YYYY-MM.');
    const [settings, days, deposits] = await Promise.all([loadSettings(req.user.id), loadDays(req.user.id), loadDeposits(req.user.id)]);
    const result = R.reconcile(days, deposits, settings, todayOf(req));
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="tally-${m}.csv"`);
    res.send(R.exportCsv(result, m));
  } catch (err) { fail(res, err); }
});

/** Start over: every day, deposit and setting of this person's, gone. */
app.delete('/api/books', user, async (req, res) => {
  try {
    if ((req.body || {}).confirm !== 'DELETE') throw httpError(400, 'Type DELETE to confirm.', { field: 'confirm' });
    await exclusive(`dep/${req.user.id}`, async () => {
      for (const d of await loadDays(req.user.id)) await store.remove(daysOf(req.user.id), d.id);
      for (const d of await loadDeposits(req.user.id)) await store.remove(depositsOf(req.user.id), d.id);
      await store.remove(SETTINGS, req.user.id);
    });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const INDEX = path.join(__dirname, 'public', 'index.html');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once - try a smaller photo or a shorter date range.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // TALLY_DEV_MOUNT=/tally runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.TALLY_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`tally listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
