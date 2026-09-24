// Chaser - get paid without the awkward part.
//
// Freelancers, agencies and small service businesses add what they are owed;
// Chaser says who to chase today, writes the chase in their own voice, and
// makes getting paid feel like a win. There is no mail server: "Send" opens
// the person's own mail or messages app, so every chase comes from them.
// See CLAUDE.md for the decisions that matter.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const B = require('./lib/book');
const L = require('./lib/ladder');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { demo } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.CHASER_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('CHASER_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A statement link IS the credential for that statement. It must not ride
  // out in a Referer header, and it must not be indexed.
  if (req.path.startsWith('/s/') || req.path.startsWith('/api/shared/')) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// One photo rides in the snap request as base64. Only that route gets the
// big limit, and it mounts its own parser AFTER the sign-in and budget
// checks, so a stranger's 6 MB is never read. Everything else stays small.
const bigJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (req.path === '/api/invoices/read' ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'chaser',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Chaser',
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
const httpError = B.httpError;
const fail = (res, err, fallback = 'Something went wrong.') => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });
};

/** The page sends its own local date so "late" means late where the person
 *  is; anything implausible falls back to UTC. */
const todayOf = (req) => B.todayFrom(req.get('x-local-date') || req.query.today);

/** 22 url-safe characters from 16 random bytes. A statement link shows a
 *  client's balance to whoever holds it; it is not something to guess. */
const newToken = () => crypto.randomBytes(16).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,40}$/;
const newId = () => crypto.randomBytes(6).toString('base64url');

const invoicesOf = (uid) => `invoices/${uid}/items`;
const clientsOf = (uid) => `clients/${uid}/items`;

async function loadSettings(uid) {
  const s = (await store.get('settings', uid)) || {};
  return { ...B.cleanSettings(s, B.SETTINGS_DEFAULTS), badges: s.badges || {}, invoiceSeq: s.invoiceSeq || 0 };
}
function settingsView(s) {
  const { badges, invoiceSeq, ...rest } = s; // eslint-disable-line no-unused-vars
  return { ...rest, setUp: Boolean(s.businessName || s.yourName) };
}

async function loadBook(uid) {
  const [invoices, clients] = await Promise.all([
    store.list(invoicesOf(uid), { limit: B.LIMITS.invoices + 1 }),
    store.list(clientsOf(uid), { limit: B.LIMITS.clients + 1 }),
  ]);
  return { invoices, clients };
}

async function loadInvoice(req) {
  const inv = await store.get(invoicesOf(req.user.id), String(req.params.id).slice(0, 64));
  // 404, never 403: another person's invoice id is not confirmed to exist.
  if (!inv) throw httpError(404, 'No such invoice.');
  return inv;
}
async function loadClient(req, id = req.params.id) {
  const c = await store.get(clientsOf(req.user.id), String(id || '').slice(0, 64));
  if (!c) throw httpError(404, 'No such client.');
  return c;
}

async function saveInvoice(uid, inv) {
  const { id, ...data } = inv;
  data.updatedAt = now();
  await store.set(invoicesOf(uid), id, data);
  return { id, ...data };
}

/** One write at a time per invoice: a double-tapped "Mark paid" must not log
 *  the payment twice. */
const busy = new Set();
async function exclusive(key, fn) {
  if (busy.has(key)) throw httpError(409, 'Still working on the last change.');
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

/** An invoice as its owner sees it: every stored fact plus everything
 *  derived, the late fee the policy would add, and the client. */
function invoiceView(inv, client, settings, today) {
  const d = B.derive(inv, today);
  const byId = client ? { [client.id]: client } : {};
  return {
    ...B.row(d, byId),
    notes: d.notes || '',
    terms: d.terms || '',
    source: d.source || 'manual',
    payments: [...(d.payments || [])].sort((a, b) => (a.date < b.date ? 1 : -1)),
    chases: [...(d.chases || [])].reverse(),
    promises: [...(d.promises || [])].reverse(),
    writtenOff: Boolean(d.writtenOff),
    keptPromises: d.keptPromises,
    lateFee: B.lateFee(d, settings.lateFee, today),
    clientInfo: client ? { id: client.id, name: client.name, contactName: client.contactName || '', email: client.email || '', phone: client.phone || '' } : null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/**
 * Badges are earned once and kept. The set is computed from the book on every
 * write that could earn one, and any not already recorded is stamped with the
 * day - so "Clean slate" stays earned after the next invoice goes late.
 */
async function syncBadges(uid, invoices, settings, today) {
  const ds = B.deriveAll(invoices, today);
  const got = B.earnedBadges(ds, today);
  const fresh = [...got].filter((k) => !settings.badges[k]);
  if (fresh.length) {
    const patch = {};
    for (const k of fresh) patch[k] = today;
    await store.merge('settings', uid, { badges: patch });
    Object.assign(settings.badges, patch);
  }
  return B.BADGES.filter((b) => fresh.includes(b.key));
}

async function afterWrite(req, today) {
  const settings = await loadSettings(req.user.id);
  const { invoices } = await loadBook(req.user.id);
  const newBadges = await syncBadges(req.user.id, invoices, settings, today);
  return { settings, invoices, newBadges };
}

/** Find a client by name (case-insensitive), or create one within the cap. */
async function clientFromBody(uid, b) {
  if (b.clientId) {
    const c = await store.get(clientsOf(uid), String(b.clientId).slice(0, 64));
    if (!c) throw httpError(404, 'No such client.');
    return c;
  }
  const clean = B.cleanClient(b.client || {});
  const all = await store.list(clientsOf(uid), { limit: B.LIMITS.clients + 1 });
  const same = all.find((c) => c.name.toLowerCase() === clean.name.toLowerCase());
  if (same) {
    // Fill in what the existing record lacks; never overwrite what is there.
    const patch = {};
    for (const k of ['email', 'phone', 'contactName']) if (clean[k] && !same[k]) patch[k] = clean[k];
    if (Object.keys(patch).length) { await store.merge(clientsOf(uid), same.id, patch); Object.assign(same, patch); }
    return same;
  }
  if (all.length >= B.LIMITS.clients) throw httpError(409, `You have ${B.LIMITS.clients} clients - the most a book holds. Delete one first.`);
  const data = { ...clean, createdAt: now(), updatedAt: now() };
  const id = await store.add(clientsOf(uid), data);
  return { id, ...data };
}

/* ------------------------------------------------------------------ *
 * Public: health, meta, the sample
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ stages: B.STAGES, side: B.SIDE, currencies: B.CURRENCIES, badges: B.BADGES, limits: B.LIMITS });
});

// A hand-made book run through the real arithmetic. No model call for a
// signed-out visitor, ever.
app.get('/api/demo', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(demo(todayOf(req)));
});

/* ------------------------------------------------------------------ *
 * Me and settings
 * ------------------------------------------------------------------ */

app.get('/api/me', async (req, res) => {
  try {
    if (!req.user) return res.json({ signedIn: false });
    const s = await loadSettings(req.user.id);
    res.json({
      signedIn: true,
      email: req.user.email,
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      settings: settingsView(s),
    });
  } catch (err) { fail(res, err); }
});

app.get('/api/settings', user, async (req, res) => {
  try { res.json(settingsView(await loadSettings(req.user.id))); } catch (err) { fail(res, err); }
});

app.put('/api/settings', user, async (req, res) => {
  try {
    const prev = await loadSettings(req.user.id);
    const next = B.cleanSettings(req.body, prev);
    await store.merge('settings', req.user.id, { ...next, updatedAt: now() });
    res.json(settingsView({ ...prev, ...next }));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Today
 * ------------------------------------------------------------------ */

app.get('/api/today', user, async (req, res) => {
  try {
    const today = todayOf(req);
    const settings = await loadSettings(req.user.id);
    const { invoices, clients } = await loadBook(req.user.id);
    await syncBadges(req.user.id, invoices, settings, today);
    res.set('Cache-Control', 'no-store');
    res.json({ ...B.todayView(invoices, clients, settings, today), setUp: Boolean(settings.businessName || settings.yourName) });
  } catch (err) { fail(res, err); }
});

app.get('/api/wins', user, async (req, res) => {
  try {
    const today = todayOf(req);
    const settings = await loadSettings(req.user.id);
    const { invoices } = await loadBook(req.user.id);
    await syncBadges(req.user.id, invoices, settings, today);
    const ds = B.deriveAll(invoices, today).filter((d) => d.currency === settings.currency);
    const paid = ds.filter((d) => d.status === 'paid');
    const month = today.slice(0, 7);
    let collectedMonthCents = 0;
    let collectedCents = 0;
    for (const d of ds) for (const p of d.payments || []) { collectedCents += p.cents; if (p.date.slice(0, 7) === month) collectedMonthCents += p.cents; }
    const hardest = paid.filter((d) => d.paidAt).sort((a, b) => B.daysBetween(b.due, b.paidAt) - B.daysBetween(a.due, a.paidAt))[0];
    res.json({
      currency: settings.currency,
      streakWeeks: B.collectedStreak(B.deriveAll(invoices, today), today),
      collectedMonthCents,
      collectedCents,
      paidCount: paid.length,
      chasesSent: invoices.reduce((a, i) => a + (i.chases || []).length, 0),
      hardest: hardest && B.daysBetween(hardest.due, hardest.paidAt) > 0
        ? { id: hardest.id, number: hardest.number, cents: hardest.amountCents, daysLate: B.daysBetween(hardest.due, hardest.paidAt) } : null,
      badges: B.BADGES.map((b) => ({ ...b, earnedAt: settings.badges[b.key] || null })),
    });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Clients
 * ------------------------------------------------------------------ */

app.get('/api/clients', user, async (req, res) => {
  try {
    const today = todayOf(req);
    const settings = await loadSettings(req.user.id);
    const { invoices, clients } = await loadBook(req.user.id);
    res.json({ clients: B.scorecards(clients, B.deriveAll(invoices, today), settings.currency) });
  } catch (err) { fail(res, err); }
});

app.post('/api/clients', user, async (req, res) => {
  try {
    const clean = B.cleanClient(req.body);
    const all = await store.list(clientsOf(req.user.id), { limit: B.LIMITS.clients + 1 });
    if (all.some((c) => c.name.toLowerCase() === clean.name.toLowerCase())) throw httpError(409, `You already have a client called ${clean.name}.`);
    if (all.length >= B.LIMITS.clients) throw httpError(409, `You have ${B.LIMITS.clients} clients - the most a book holds. Delete one first.`);
    const data = { ...clean, createdAt: now(), updatedAt: now() };
    const id = await store.add(clientsOf(req.user.id), data);
    res.json(B.scorecard({ id, ...data }, [], 'USD'));
  } catch (err) { fail(res, err); }
});

async function clientDetail(req, c) {
  const today = todayOf(req);
  const settings = await loadSettings(req.user.id);
  const invoices = (await store.list(invoicesOf(req.user.id), { limit: B.LIMITS.invoices + 1 })).filter((i) => i.clientId === c.id);
  const ds = B.deriveAll(invoices, today);
  const byId = { [c.id]: c };
  return {
    ...B.scorecard(c, ds, settings.currency),
    shareToken: c.shareToken || null,
    sharedAt: c.sharedAt || null,
    rows: ds.map((d) => B.row(d, byId)).sort((a, b) => (a.issued < b.issued ? 1 : -1)),
  };
}

app.get('/api/clients/:id', user, async (req, res) => {
  try { res.json(await clientDetail(req, await loadClient(req))); } catch (err) { fail(res, err); }
});

app.put('/api/clients/:id', user, async (req, res) => {
  try {
    const c = await loadClient(req);
    const next = B.cleanClient(req.body, c);
    if (next.name.toLowerCase() !== c.name.toLowerCase()) {
      const all = await store.list(clientsOf(req.user.id), { limit: B.LIMITS.clients + 1 });
      if (all.some((x) => x.id !== c.id && x.name.toLowerCase() === next.name.toLowerCase())) throw httpError(409, `You already have a client called ${next.name}.`);
    }
    await store.merge(clientsOf(req.user.id), c.id, { ...next, updatedAt: now() });
    res.json(await clientDetail(req, { ...c, ...next }));
  } catch (err) { fail(res, err); }
});

app.delete('/api/clients/:id', user, async (req, res) => {
  try {
    const c = await loadClient(req);
    const invoices = await store.list(invoicesOf(req.user.id), { limit: B.LIMITS.invoices + 1 });
    if (invoices.some((i) => i.clientId === c.id)) throw httpError(409, 'This client still has invoices. Delete those first - their history is what the scorecard is made of.');
    if (c.shareToken) await store.remove('shares', c.shareToken);
    await store.remove(clientsOf(req.user.id), c.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Statements and their share links
 * ------------------------------------------------------------------ */

/**
 * A statement of account, built field by field - never by copying a record
 * and deleting fields, so a private field added next month cannot leak by
 * default. What a client sees: the business name and the contact line the
 * person typed for statements, how to pay, their own open invoices and
 * recent payments, and the balance. Never the account email, internal notes,
 * chase history, promises, grades, or late fees (a fee is only ever shown
 * where the person chose to show it).
 */
function statementOf(client, invoices, settings, today) {
  const ds = B.deriveAll(invoices.filter((i) => i.clientId === client.id), today);
  const since = B.addDays(today, -90);
  const groups = {};
  const g = (cur) => (groups[cur] = groups[cur] || { currency: cur, invoices: [], payments: [], balanceCents: 0, overdueCents: 0 });
  for (const d of ds) {
    if (d.status === 'written_off') continue;
    const live = d.status === 'open' || d.status === 'promised';
    if (live) {
      const x = g(d.currency);
      x.invoices.push({ number: d.number, issued: d.issued, due: d.due, amountCents: d.amountCents, paidCents: d.paidCents, balanceCents: d.balanceCents, daysLate: Math.max(0, d.daysLate) });
      x.balanceCents += d.balanceCents;
      if (d.daysLate > 0) x.overdueCents += d.balanceCents;
    }
    for (const p of d.payments || []) {
      if (live || p.date >= since) g(d.currency).payments.push({ date: p.date, cents: p.cents, number: d.number });
    }
  }
  const list = Object.values(groups).map((x) => ({
    ...x,
    invoices: x.invoices.sort((a, b) => (a.due < b.due ? -1 : 1)),
    payments: x.payments.sort((a, b) => (a.date < b.date ? 1 : -1)),
  })).sort((a, b) => (a.currency === settings.currency ? -1 : b.currency === settings.currency ? 1 : 0));
  return {
    asOf: today,
    business: {
      name: settings.businessName || settings.yourName || '',
      contact: settings.contact || '',
      paymentLink: settings.paymentLink || '',
      paymentInstructions: settings.paymentInstructions || '',
    },
    client: { name: client.name, contactName: client.contactName || '' },
    groups: list,
  };
}

app.get('/api/clients/:id/statement', user, async (req, res) => {
  try {
    const c = await loadClient(req);
    const settings = await loadSettings(req.user.id);
    const { invoices } = await loadBook(req.user.id);
    res.json({ ...statementOf(c, invoices, settings, todayOf(req)), share: c.shareToken ? { token: c.shareToken, url: `s/${c.shareToken}`, sharedAt: c.sharedAt || null } : null });
  } catch (err) { fail(res, err); }
});

/**
 * Share: freeze a copy. The link shows the statement as it was when it was
 * shared - a payment logged later does not change what the client already
 * has, and nothing about the live book is readable through it. Sharing again
 * re-freezes the same link (so a link already sent shows the latest when the
 * person chooses); revoking deletes the copy and the link is dead.
 */
app.post('/api/clients/:id/share', user, async (req, res) => {
  try {
    const out = await exclusive(`share/${req.user.id}/${req.params.id}`, async () => {
      const c = await loadClient(req);
      const settings = await loadSettings(req.user.id);
      const { invoices } = await loadBook(req.user.id);
      const statement = statementOf(c, invoices, settings, todayOf(req));
      let token = c.shareToken;
      if (!token) {
        token = newToken();
        while (await store.get('shares', token)) token = newToken();
      }
      const at = now();
      await store.set('shares', token, { uid: req.user.id, clientId: c.id, createdAt: at, statement });
      await store.merge(clientsOf(req.user.id), c.id, { shareToken: token, sharedAt: at });
      return { token, url: `s/${token}`, sharedAt: at };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.delete('/api/clients/:id/share', user, async (req, res) => {
  try {
    const c = await loadClient(req);
    if (c.shareToken) await store.remove('shares', c.shareToken);
    await store.merge(clientsOf(req.user.id), c.id, { shareToken: null, sharedAt: null });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// The client's view. No account, no model call, read-only: GET is the only
// verb this path answers.
app.get('/api/shared/:token', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) throw httpError(404, 'This statement link is not valid.');
    const s = await store.get('shares', token);
    if (!s || !s.statement) throw httpError(404, 'This statement link is not valid any more.');
    res.json({ ...s.statement, preview: Boolean(req.user && req.user.id === s.uid) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Invoices
 * ------------------------------------------------------------------ */

app.get('/api/invoices', user, async (req, res) => {
  try {
    const today = todayOf(req);
    const { invoices, clients } = await loadBook(req.user.id);
    const byId = B.indexClients(clients);
    // Unpaid first, soonest due first; then paid and written off, newest first.
    const rank = { open: 0, promised: 0, paid: 1, written_off: 2 };
    const rows = B.deriveAll(invoices, today).map((d) => B.row(d, byId))
      .sort((a, b) => rank[a.status] - rank[b.status] || (rank[a.status] ? b.due.localeCompare(a.due) : a.due.localeCompare(b.due)));
    res.json({ invoices: rows, clients: clients.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) });
  } catch (err) { fail(res, err); }
});

app.post('/api/invoices', user, async (req, res) => {
  try {
    const b = req.body || {};
    const today = todayOf(req);
    const settings = await loadSettings(req.user.id);
    const facts = B.cleanInvoice(b, null, settings, today);
    const existing = await store.list(invoicesOf(req.user.id), { limit: B.LIMITS.invoices + 1 });
    if (existing.length >= B.LIMITS.invoices) throw httpError(409, `You have ${B.LIMITS.invoices} invoices - the most a book holds. Delete some paid ones first.`);
    const client = await clientFromBody(req.user.id, b);
    if (!facts.number) {
      await store.bump('settings', req.user.id, { invoiceSeq: 1 });
      const s = await store.get('settings', req.user.id);
      facts.number = `INV-${1000 + Number((s && s.invoiceSeq) || 1)}`;
    }
    const inv = {
      ...facts,
      clientId: client.id,
      source: b.source === 'snap' ? 'snap' : 'manual',
      payments: [],
      chases: [],
      promises: [],
      stage: 0,
      paused: false,
      writtenOff: false,
      lastChasedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    const id = await store.add(invoicesOf(req.user.id), inv);
    res.json(invoiceView({ id, ...inv }, client, settings, today));
  } catch (err) { fail(res, err); }
});

/**
 * Snap an invoice: one photo in, proposed fields out. Nothing is saved - the
 * page draws an editable card and only its Save (an ordinary POST
 * /api/invoices) stores anything. The photo is validated before anything is
 * spent, read once, and dropped with the request.
 */
app.post('/api/invoices/read', ...spend, bigJson, async (req, res) => {
  try {
    const image = photo.validate((req.body || {}).image);
    const settings = await loadSettings(req.user.id);
    const client = await clientFor(req);
    const proposal = await ai.readInvoice(client, modelFor(req), image, { currency: settings.currency });
    if (!proposal) throw httpError(422, 'That doesn’t look like an invoice we can read. Try a flatter, closer photo - or type it in.');
    const clients = await store.list(clientsOf(req.user.id), { limit: B.LIMITS.clients + 1 });
    const match = proposal.client.name && clients.find((c) => c.name.toLowerCase() === proposal.client.name.toLowerCase());
    res.json({ ...proposal, matchedClientId: match ? match.id : null });
  } catch (err) { fail(res, err, 'Could not read that photo. Try again, or type it in.'); }
});

app.get('/api/invoices/:id', user, async (req, res) => {
  try {
    const inv = await loadInvoice(req);
    const settings = await loadSettings(req.user.id);
    const client = await store.get(clientsOf(req.user.id), inv.clientId);
    res.json(invoiceView(inv, client, settings, todayOf(req)));
  } catch (err) { fail(res, err); }
});

app.put('/api/invoices/:id', user, async (req, res) => {
  try {
    const out = await exclusive(`i/${req.user.id}/${req.params.id}`, async () => {
      const inv = await loadInvoice(req);
      const today = todayOf(req);
      const settings = await loadSettings(req.user.id);
      const facts = B.cleanInvoice(req.body, inv, settings, today);
      let client = await store.get(clientsOf(req.user.id), inv.clientId);
      const b = req.body || {};
      if (b.clientId && b.clientId !== inv.clientId) client = await loadClient(req, b.clientId);
      const saved = await saveInvoice(req.user.id, { ...inv, ...facts, clientId: client ? client.id : inv.clientId });
      return invoiceView(saved, client, settings, today);
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.delete('/api/invoices/:id', user, async (req, res) => {
  try {
    const inv = await loadInvoice(req);
    await store.remove(invoicesOf(req.user.id), inv.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** A change to one invoice, done exclusively, answered with its fresh view
 *  plus any badge it earned. */
async function mutate(req, res, fn) {
  try {
    const out = await exclusive(`i/${req.user.id}/${req.params.id}`, async () => {
      const inv = await loadInvoice(req);
      const today = todayOf(req);
      const before = B.derive(inv, today);
      const extra = (await fn(inv, before, today)) || {};
      const saved = await saveInvoice(req.user.id, inv);
      const { settings, newBadges } = await afterWrite(req, today);
      const client = await store.get(clientsOf(req.user.id), inv.clientId);
      return { ...invoiceView(saved, client, settings, today), newBadges, ...extra };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
}

const live = (d) => d.status === 'open' || d.status === 'promised';

/** Log money in. "Mark paid" is this with `full: true`. */
app.post('/api/invoices/:id/payments', user, (req, res) => mutate(req, res, async (inv, before, today) => {
  const b = req.body || {};
  if (!live(before)) throw httpError(409, before.status === 'paid' ? 'This invoice is already paid in full.' : 'This invoice was written off. Reopen it first.');
  const cents = b.full === true ? before.balanceCents : B.centsFrom(b, 'cents', 'amount');
  if (!cents) throw httpError(400, 'How much came in? Add an amount.');
  if (cents > before.balanceCents) throw httpError(400, `That is more than the ${B.fmtMoney(before.balanceCents, inv.currency)} still owed.`);
  const date = b.date ? B.isoDay(b.date) : today;
  if (!date) throw httpError(400, 'That payment date is not a real date.');
  if (date > today) throw httpError(400, 'A payment cannot be dated in the future.');
  if ((inv.payments || []).length >= B.LIMITS.payments) throw httpError(409, 'That is a lot of payments on one invoice - the log is full.');
  inv.payments = [...(inv.payments || []), { id: newId(), cents, date, note: B.clean(b.note, 120), at: now() }];
  const after = B.derive(inv, today);
  if (after.status !== 'paid') return { win: null };
  inv.paused = false;
  const { invoices } = await loadBook(req.user.id);
  const all = invoices.map((x) => (x.id === inv.id ? inv : x));
  return {
    win: {
      cleared: true,
      cents: inv.amountCents,
      currency: inv.currency,
      daysLate: Math.max(0, B.daysBetween(inv.due, after.paidAt)),
      streakWeeks: B.collectedStreak(B.deriveAll(all, today), today),
    },
  };
}));

app.delete('/api/invoices/:id/payments/:pid', user, (req, res) => mutate(req, res, async (inv) => {
  const before = (inv.payments || []).length;
  inv.payments = (inv.payments || []).filter((p) => p.id !== req.params.pid);
  if (inv.payments.length === before) throw httpError(404, 'No such payment.');
}));

/** "They promised to pay by Friday." */
app.post('/api/invoices/:id/promise', user, (req, res) => mutate(req, res, async (inv, before, today) => {
  const b = req.body || {};
  if (!live(before)) throw httpError(409, 'Only an unpaid invoice can have a promise.');
  const date = B.isoDay(b.date);
  if (!date) throw httpError(400, 'Pick the day they promised to pay by.');
  if (date < today) throw httpError(400, 'A promise has to be for today or later.');
  if (B.daysBetween(today, date) > 180) throw httpError(400, 'That is more than six months away - log it as a payment plan note instead.');
  if ((inv.promises || []).length >= B.LIMITS.promises) throw httpError(409, 'That is a lot of promises. Maybe time for the final notice.');
  inv.promises = [...(inv.promises || []), { date, note: B.clean(b.note, 140), at: now() }];
}));

/** Take back a promise logged by mistake. Only a promise whose day has not
 *  come yet - a promise that broke is history, and history is the scorecard. */
app.delete('/api/invoices/:id/promise', user, (req, res) => mutate(req, res, async (inv, before, today) => {
  const ps = inv.promises || [];
  const last = ps[ps.length - 1];
  if (!last || last.date < today) throw httpError(409, 'There is no upcoming promise to remove.');
  inv.promises = ps.slice(0, -1);
}));

/** Log that a chase went out. This is what climbs the ladder - drafting does
 *  not, because a draft nobody sent is not a chase. */
app.post('/api/invoices/:id/chases', user, (req, res) => mutate(req, res, async (inv, before) => {
  const b = req.body || {};
  if (!live(before)) throw httpError(409, 'This invoice is not open.');
  const kind = B.KINDS.includes(b.kind) ? b.kind : before.nextKind;
  const channel = ['email', 'sms', 'copy', 'call', 'other'].includes(b.channel) ? b.channel : 'other';
  if ((inv.chases || []).length >= B.LIMITS.chases) throw httpError(409, 'That is a lot of chases on one invoice - the timeline is full.');
  const at = now();
  inv.chases = [...(inv.chases || []), {
    kind,
    channel,
    source: ['ai', 'template', 'own'].includes(b.source) ? b.source : 'own',
    subject: B.clean(b.subject, 120),
    body: B.cleanText(b.body, 2400),
    at,
  }];
  const idx = B.STAGES.findIndex((s) => s.key === kind);
  if (idx >= 0) inv.stage = Math.max(Number(inv.stage) || 0, idx + 1);
  inv.lastChasedAt = at;
  inv.paused = false;
}));

app.post('/api/invoices/:id/pause', user, (req, res) => mutate(req, res, async (inv, before) => {
  if (!live(before)) throw httpError(409, 'This invoice is not open.');
  inv.paused = (req.body || {}).paused !== false;
}));

app.post('/api/invoices/:id/write-off', user, (req, res) => mutate(req, res, async (inv, before) => {
  const off = (req.body || {}).writtenOff !== false;
  if (off && before.status === 'paid') throw httpError(409, 'This invoice is paid - nothing to write off.');
  inv.writtenOff = off;
  if (off) inv.paused = false;
}));

/* ------------------------------------------------------------------ *
 * Drafting a chase: the model, or the template
 * ------------------------------------------------------------------ */

async function draftContext(req) {
  const inv = await loadInvoice(req);
  const today = todayOf(req);
  const settings = await loadSettings(req.user.id);
  const client = await store.get(clientsOf(req.user.id), inv.clientId);
  const d = B.derive(inv, today);
  if (!live(d)) throw httpError(409, d.status === 'paid' ? 'This one is paid - nothing to chase.' : 'This invoice was written off.');
  const b = req.body || {};
  const f = L.factsFor(d, client, settings, today, { kind: b.kind, includeFee: b.includeFee === true });
  const to = { email: (client && client.email) || '', phone: (client && client.phone) || '' };
  return { f, to, d, settings, today };
}

const draftOut = (text, f, to, source) => ({
  ...text,
  kind: f.kind,
  kindLabel: f.kindLabel,
  source,
  to,
  fee: f.fee,
});

app.post('/api/invoices/:id/draft', ...spend, async (req, res) => {
  try {
    const { f, to } = await draftContext(req);
    const client = await clientFor(req);
    const text = await ai.chase(client, modelFor(req), f);
    res.json(draftOut(text, f, to, 'ai'));
  } catch (err) { fail(res, err, 'Could not write that chase. Try again, or use the template.'); }
});

/** Free, always: the no-model draft from the same facts and voice. */
app.post('/api/invoices/:id/template', user, async (req, res) => {
  try {
    const { f, to } = await draftContext(req);
    res.json(draftOut(L.template(f), f, to, 'template'));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// The shared statement is the same single-page app served one level down at
// s/<token>. <base href="../"> makes every relative asset and API path in it
// resolve against the app root, mounted or not.
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
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // CHASER_DEV_MOUNT=/chaser runs it the way the lab host does: mounted under
  // a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.CHASER_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`chaser listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
