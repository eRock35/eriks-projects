// Duly - every bill on time, without paying them yourself. See CLAUDE.md.
//
// Duly never pays a bill, never signs in to a bank, card or utility, and
// never holds a password or an account number. The bill list - payees, the
// usual amounts, the due days, how each is paid, what each cycle came to -
// lives on the phone (localStorage) and is worked out there by
// public/duly-core.js: the month, AutoPay health, the "higher than usual"
// flags, the calendar file. Nothing about it reaches this server unless:
//
//   - you are signed in (free): the bill list is kept in your account, so it
//     follows you to another phone - the same fields as on the phone, and the
//     same refusal of anything shaped like an account number;
//   - you tap "Read a statement": the one model call, metered and signed in.
//     The pasted text (stripped of account-shaped numbers first) or the photo
//     is read once and dropped; what comes back is a proposal the page shows.

const path = require('path');
const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Core = require('./public/duly-core');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.DULY_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('DULY_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, like every sibling.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const LIMITS = {
  savesPerAccount: 240,            // bill-list writes per account...
  savesWindowMs: 10 * 60 * 1000,   // ...in 10 minutes
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No inline script anywhere: every app in the lab shares one origin, so
  // one app's injection must not run script as the others.
  res.set('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// The metered route mounts its own 9 MB parser (one photo, shrunk on the
// phone, fits in well under it) AFTER sign-in, budget and the daily cap, so
// a stranger's body is never read; bringing a whole list into an account
// mounts 256 KB after sign-in. Everything else 16 KB.
const readJson = express.json({ limit: '9mb' });
const mergeJson = express.json({ limit: '256kb' });
const smallJson = express.json({ limit: '16kb' });
app.use((req, res, next) => {
  if (req.path === '/api/read' || req.path === '/api/bills/merge') return next();
  return smallJson(req, res, next);
});

/* ------------------------------------------------------------------ *
 * The shared account (sync and "Read a statement" need it; nothing else)
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const SECRET = () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : '');
const identity = identityLib.create({
  store: identityStore,
  secret: SECRET,
  app: 'duly',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Duly',
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

/* ------------------------------------------------------------------ *
 * Errors: only the app's own (marked `expose`) reach the page in their own
 * words. Anything else is logged - the first lines of its stack, never a
 * body: a household's bills are nobody's business - and answered with the
 * route's fallback. A provider error is a 502, or 503 when busy.
 * ------------------------------------------------------------------ */

const httpError = Core.fail;
function failure(err, fallback) {
  const mine = Boolean(err && err.expose && err.status);
  if (!mine) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error', err && err.status ? `(upstream ${err.status})` : '');
  const upstream = !mine && err && Number.isInteger(err.status);
  const status = mine ? err.status : upstream ? ([429, 503, 529].includes(err.status) ? 503 : 502) : 500;
  return { status, body: { error: mine ? err.message : (upstream && status === 503 ? 'The AI is busy right now. Try again in a minute - adding a bill by hand still works.' : fallback), ...(mine && err.code ? { code: err.code } : {}) } };
}
function fail(res, err, fallback = 'Something went wrong.') {
  const f = failure(err, fallback);
  res.status(f.status).json(f.body);
}
const route = (fallback, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, fallback); } };

const saves = identityLib.createLimiter({ max: LIMITS.savesPerAccount, windowMs: LIMITS.savesWindowMs });

/** The viewer's "today" (their phone's day), if it is a real day within a
 *  day of the server's; otherwise the server's own UTC day. */
function todayOf(req) {
  const server = new Date().toISOString().slice(0, 10);
  const t = (req.body && req.body.today) || req.query.today;
  return Core.isDay(t) && Math.abs(Core.daysBetween(server, t)) <= 1 ? t : server;
}

/* ------------------------------------------------------------------ *
 * Public
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ limits: Core.LIMITS, categories: Core.CATEGORIES, pay: Core.PAY_LABEL });
});

app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: req.user.email, budget: identityLib.budgetFor(req.user), tier: identityLib.planFor(req.user, MODELS).tier, sync: Boolean(SECRET()) });
});

/* ------------------------------------------------------------------ *
 * Signed in, free: the bill list follows you to another phone
 * ------------------------------------------------------------------ */

/** The account, as Duly stores it: an HMAC of the account id under a key
 *  derived from the session secret. Never the id, never the email. */
function accountTag(uid, secret) {
  const key = crypto.createHmac('sha256', String(secret)).update('duly bills owner v1').digest();
  return crypto.createHmac('sha256', key).update(String(uid)).digest('base64url').slice(0, 27);
}
function listTag(req) {
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Your bills are safe on this phone.');
  if (!saves.hit(req.user.id)) throw httpError(429, 'That’s a lot of saving. Wait a few minutes - it’s all still on this phone.');
  return accountTag(req.user.id, SECRET());
}
/** A stored list, cleaned on the way out too. A stored bill that would now be
 *  refused is simply left out. */
function listView(doc, today) {
  const bills = [];
  for (const b of Object.values((doc && doc.bills) || {})) {
    try { const c = Core.cleanBill(b, today); if (c) bills.push(Core.toSaved(c)); } catch (e) { /* refused: not served */ }
  }
  bills.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
  return { bills, updatedAt: (doc && doc.updatedAt) || null };
}
const isSampleId = (id) => /^sample/.test(id);
/** One bill as an account keeps it. Throws the account-number refusal (400)
 *  before anything is written. */
function savedBill(raw, today, now) {
  const b = Core.cleanBill(raw, today);
  if (!b) throw httpError(400, 'A bill needs who it’s from and when it’s due.');
  if (isSampleId(b.id)) throw httpError(400, 'The sample household stays on this phone.');
  return { ...Core.toSaved(b), updatedAt: Number(raw.updatedAt) > 0 && Number(raw.updatedAt) <= now + 60000 ? Math.round(Number(raw.updatedAt)) : now };
}

app.get('/api/bills', identity.requireUser, route('Could not load your bills.', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!SECRET()) throw httpError(503, 'Syncing isn’t available right now. Your bills are safe on this phone.');
  const doc = await store.get('bills', accountTag(req.user.id, SECRET()));
  res.json({ ...listView(doc, todayOf(req)), limit: Core.LIMITS.bills });
}));

/** Save one bill. Only the bill's own fields are kept: the sample flag or
 *  anything else a request carries is dropped here, and a field named or
 *  shaped like an account number is refused with a sentence. */
app.put('/api/bills/:id', identity.requireUser, route('Could not save that. It is still on this phone.', async (req, res) => {
  const tag = listTag(req);
  const now = Date.now();
  const today = todayOf(req);
  const raw = (req.body || {}).bill;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Send the bill.');
  const bill = savedBill({ ...raw, id: req.params.id }, today, now);
  let out = null;
  await store.transact('bills', tag, (cur) => {
    const bills = { ...((cur && cur.bills) || {}) };
    if (!bills[bill.id] && Object.keys(bills).length >= Core.LIMITS.bills) throw httpError(400, `A household keeps up to ${Core.LIMITS.bills} bills. Delete a few old ones first.`);
    bills[bill.id] = bill;
    out = { bills, createdAt: (cur && cur.createdAt) || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    return out;
  });
  res.json({ bill, updatedAt: out.updatedAt });
}));

app.delete('/api/bills/:id', identity.requireUser, route('Could not delete that.', async (req, res) => {
  const tag = listTag(req);
  const id = String(req.params.id || '');
  if (!Core.ID_RE.test(id)) throw httpError(400, 'That isn’t a bill.');
  await store.transact('bills', tag, (cur) => {
    if (!cur || !cur.bills || !cur.bills[id]) return undefined;
    const bills = { ...cur.bills };
    delete bills[id];
    return { ...cur, bills, updatedAt: new Date().toISOString() };
  });
  res.json({ ok: true });
}));

/** Bring this phone's bills into the account on sign-in: a bill the account
 *  does not have is added; one it has is replaced only when this phone's copy
 *  is newer. The sample never comes along, and a bill carrying an account
 *  number is left behind (counted in `refused`). */
app.post('/api/bills/merge', identity.requireUser, mergeJson, route('Could not bring your bills across. They are still on this phone.', async (req, res) => {
  const tag = listTag(req);
  const b = req.body || {};
  if (!Array.isArray(b.bills)) throw httpError(400, 'Send the bills.');
  const today = todayOf(req);
  const now = Date.now();
  let refused = 0;
  const incoming = [];
  for (const raw of b.bills.slice(0, Core.LIMITS.bills * 2)) {
    try {
      if (!raw || typeof raw !== 'object' || raw.sample === true) continue;
      const bill = savedBill(raw, today, now);
      incoming.push(bill);
    } catch (e) {
      if (e && e.code === 'account-number') refused++;
    }
  }
  let out = null;
  await store.transact('bills', tag, (cur) => {
    const bills = { ...((cur && cur.bills) || {}) };
    for (const l of incoming) {
      const have = bills[l.id];
      if (have && Number(have.updatedAt || 0) >= l.updatedAt) continue;
      if (!have && Object.keys(bills).length >= Core.LIMITS.bills) continue;
      bills[l.id] = l;
    }
    out = { bills, createdAt: (cur && cur.createdAt) || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    return out;
  });
  res.json({ ...listView(out, today), refused, limit: Core.LIMITS.bills });
}));

/** Forget the account's copy (this phone keeps its own). */
app.delete('/api/bills', identity.requireUser, route('Could not clear it.', async (req, res) => {
  const tag = listTag(req);
  await store.remove('bills', tag);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 * Metered: "Read a statement"
 * ------------------------------------------------------------------ */

/** Gates, then the 9 MB parser, then the request checked (a 400 costs
 *  nothing), then one forced tool. Nothing here writes to the store, and
 *  nothing logged carries a byte of the bill. Not streamed: one bill reads
 *  in seconds, far short of the silence that drops a phone. */
app.post('/api/read', ...spend, readJson, route('The bill could not be read right now. Try again in a minute - or add it by hand.', async (req, res) => {
  const today = todayOf(req);
  const b = ai.brief(req.body, photo);
  const proposal = ai.cleanProposal(await ai.read(await clientFor(req), modelFor(req), b, today), today);
  if (!proposal.payee && proposal.amount === null) throw httpError(422, 'Nothing like a bill could be read from that. Try a sharper photo, or paste the part with the amount and due date - or add it by hand.');
  proposal.stripped = proposal.stripped || b.stripped;
  res.set('Cache-Control', 'no-store');
  res.json({ proposal });
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
  // DULY_DEV_MOUNT=/duly runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.DULY_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`duly listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store, accountTag };
