// Snapquote - turn a few photos and a voice note into a professional quote.
//
// A tradesperson snaps the job, talks through it, and gets an itemized quote
// with their own rates, markup and tax applied - then sends a branded link the
// customer can accept with a typed signature. The contractor who quotes first
// usually wins the job. See CLAUDE.md for the decisions that matter.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const Q = require('./lib/quote');
const ai = require('./lib/ai');
const photos = require('./lib/photos');
const { demo } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.SNAPQUOTE_FAKE_AI === '1';

// Free tier on Haiku, paid tier on Sonnet - the same split every sibling app
// uses, decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const MAX_QUOTES_LISTED = 500;
const MAX_TEMPLATES = 50;
const MAX_CUSTOMER_MESSAGES = 20;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A quote link IS the credential for that quote. It must not ride out to
  // another site in a Referer header, and it must not be indexed.
  if (req.path.startsWith('/q/') || req.path.startsWith('/api/public/')) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// Photos ride in the draft request as base64: four at 1.5 MB is ~8 MB of JSON.
// Only that one route gets the big limit; everything else stays small.
const bigJson = express.json({ limit: '9mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (req.path === '/api/quotes/draft' ? bigJson : smallJson)(req, res, next));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'snapquote',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Snapquote',
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

function modelFor(req) {
  return identityLib.planFor(req.user, MODELS).model;
}

// Never put a model call behind a sign-in alone: every one of these goes
// through the budget and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
const fail = (res, err, fallback = 'Something went wrong.') => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });
};
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** 22 url-safe characters from 16 random bytes: 128 bits. A quote link is the
 *  only thing standing between a stranger and someone's address and price, so
 *  it is not something to be able to guess or count through. */
const newToken = () => crypto.randomBytes(16).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,40}$/;

const quotesOf = (uid) => `pros/${uid}/quotes`;
const templatesOf = (uid) => `pros/${uid}/templates`;

async function loadProfile(user) {
  const p = await store.get('pros', user.id);
  if (p) return { ...Q.PROFILE_DEFAULTS, ...p };
  const fresh = { ...Q.PROFILE_DEFAULTS, quoteSeq: 0, createdAt: now() };
  await store.set('pros', user.id, fresh);
  return { id: user.id, ...fresh };
}

function profileView(p) {
  const out = Q.cleanProfile(p, Q.PROFILE_DEFAULTS);
  return { ...out, setUp: Boolean(p.name) };
}

async function nextNumber(uid) {
  await store.bump('pros', uid, { quoteSeq: 1 });
  const p = await store.get('pros', uid);
  return `Q-${1000 + Number((p && p.quoteSeq) || 1)}`;
}

async function loadQuote(req) {
  const q = await store.get(quotesOf(req.user.id), String(req.params.id).slice(0, 64));
  // 404, never 403: another pro's quote id is not confirmed to exist.
  if (!q) throw httpError(404, 'No such quote.');
  return q;
}

async function saveQuote(uid, q) {
  const { id, ...data } = q;
  data.updatedAt = now();
  data.totals = Q.computeTotals(data);
  await store.set(quotesOf(uid), id, data);
  return { id, ...data };
}

/** A quote as its owner sees it: everything, plus what is derived. */
function ownerView(q) {
  const status = Q.statusOf(q);
  return {
    ...q,
    status,
    storedStatus: q.status,
    value: Q.valueOf(q),
    // RELATIVE to wherever the app is mounted (`/` alone, `/snapquote/` in the
    // combined host). The page prefixes its own base; the server never guesses.
    publicUrl: q.publicId ? `q/${q.publicId}` : null,
    locked: q.status === 'accepted',
  };
}

function summary(q) {
  return {
    id: q.id,
    number: q.number,
    title: q.title,
    customer: (q.customer || {}).name || '',
    trade: q.trade,
    status: Q.statusOf(q),
    value: Q.valueOf(q),
    tiers: q.tiers ? q.tiers.length : 0,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    sentAt: q.sentAt || null,
    viewedAt: q.viewedAt || null,
    validUntil: q.validUntil || null,
    respondedAt: (q.response && q.response.at) || null,
    unread: (q.messages || []).some((m) => m.from === 'customer' && !m.seen),
  };
}

function hasLines(q) {
  return (q.items || []).length > 0 || (q.tiers || []).some((t) => t.items.length > 0);
}

// One write at a time per quote. A customer double-tapping Accept would
// otherwise read "open" twice and write two acceptances.
const busy = new Set();
async function exclusive(key, fn) {
  if (busy.has(key)) throw httpError(409, 'Still working on the last request.');
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

function blankQuote(profile, extra = {}) {
  return {
    status: 'draft',
    source: 'blank',
    trade: profile.trade,
    customer: { name: '', contact: '', address: '' },
    title: 'New quote',
    description: '',
    scope: '',
    items: [],
    tiers: null,
    assumptions: [],
    exclusions: [],
    timeline: '',
    terms: profile.terms,
    notes: '',
    markupPct: profile.markupPct,
    taxPct: profile.taxPct,
    discount: 0,
    validDays: profile.validDays,
    messages: [],
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  };
}

function cleanCustomer(c) {
  const x = c && typeof c === 'object' ? c : {};
  return { name: Q.clean(x.name, 80), contact: Q.clean(x.contact, 120), address: Q.clean(x.address, 160) };
}

/* ------------------------------------------------------------------ *
 * Public: health, meta, the sample
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ trades: Q.TRADES, categories: Q.CATEGORIES, units: Q.UNITS, tiers: Q.TIER_LABELS, maxPhotos: photos.MAX_PHOTOS });
});

// The sample is hand-written and drawn by the customer page's own renderer.
// No model call for a signed-out visitor, ever.
app.get('/api/demo', (_req, res) => res.json(demo()));

/* ------------------------------------------------------------------ *
 * Me and the business profile
 * ------------------------------------------------------------------ */

app.get('/api/me', async (req, res) => {
  try {
    if (!req.user) return res.json({ signedIn: false });
    const p = await loadProfile(req.user);
    res.json({
      signedIn: true,
      email: req.user.email,
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      profile: profileView(p),
    });
  } catch (err) { fail(res, err); }
});

app.put('/api/profile', identity.requireUser, async (req, res) => {
  try {
    const prev = await loadProfile(req.user);
    const next = Q.cleanProfile(req.body, prev);
    await store.merge('pros', req.user.id, { ...next, updatedAt: now() });
    res.json(profileView({ ...prev, ...next }));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Quotes
 * ------------------------------------------------------------------ */

app.get('/api/quotes', identity.requireUser, async (req, res) => {
  try {
    const rows = await store.list(quotesOf(req.user.id), { orderBy: 'updatedAt', dir: 'desc', limit: MAX_QUOTES_LISTED });
    res.json({ quotes: rows.map(summary) });
  } catch (err) { fail(res, err); }
});

/**
 * The snap. Photos and a description in, a draft quote out.
 *
 * Photos are validated before anything is spent, handed to the model as image
 * blocks, and never written anywhere: only the quote is stored.
 */
app.post('/api/quotes/draft', ...spend, async (req, res) => {
  try {
    const b = req.body || {};
    const pics = photos.validate(b.photos);
    const description = Q.cleanText(b.description, 3000);
    if (description.length < 8 && !pics.length) {
      throw httpError(400, 'Add a photo or say a sentence about the job first.');
    }
    const profile = await loadProfile(req.user);
    const job = {
      title: Q.clean(b.title, 90),
      description,
      trade: Q.TRADES[b.trade] ? b.trade : profile.trade,
      customer: cleanCustomer(b.customer),
      tiers: b.tiers === true,
    };
    const client = await clientFor(req);
    const d = await ai.draft(client, modelFor(req), profile, job, pics);
    const number = await nextNumber(req.user.id);
    const q = blankQuote(profile, {
      number,
      source: 'ai',
      trade: job.trade,
      customer: job.customer,
      title: job.title || d.title || 'New quote',
      // What they dictated stays with the owner. It is often notes-to-self
      // ("customer seemed cheap, pad the materials") and never reaches the
      // customer page.
      description,
      scope: d.scope,
      items: d.items,
      tiers: d.tiers,
      assumptions: d.assumptions,
      exclusions: d.exclusions,
      timeline: d.timeline,
      photoCount: pics.length,
    });
    q.totals = Q.computeTotals(q);
    const id = await store.add(quotesOf(req.user.id), q);
    res.json(ownerView({ id, ...q }));
  } catch (err) { fail(res, err, 'Could not draft that quote. Try again.'); }
});

/** A blank quote, or one started from a template. No model call, so free. */
app.post('/api/quotes', identity.requireUser, async (req, res) => {
  try {
    const b = req.body || {};
    const profile = await loadProfile(req.user);
    let extra = {};
    if (b.templateId) {
      const t = await store.get(templatesOf(req.user.id), String(b.templateId).slice(0, 64));
      if (!t) throw httpError(404, 'No such template.');
      extra = {
        source: 'template',
        templateId: t.id,
        title: t.title,
        trade: t.trade,
        scope: t.scope,
        items: Q.cleanItems(t.items),
        tiers: Q.cleanTiers(t.tiers),
        assumptions: t.assumptions || [],
        exclusions: t.exclusions || [],
        timeline: t.timeline || '',
        markupPct: t.markupPct ?? profile.markupPct,
      };
    }
    const q = blankQuote(profile, { ...extra, number: await nextNumber(req.user.id), customer: cleanCustomer(b.customer) });
    q.totals = Q.computeTotals(q);
    const id = await store.add(quotesOf(req.user.id), q);
    res.json(ownerView({ id, ...q }));
  } catch (err) { fail(res, err); }
});

app.get('/api/quotes/:id', identity.requireUser, async (req, res) => {
  try {
    const q = await loadQuote(req);
    // Opening a quote marks the customer's messages on it as seen.
    if ((q.messages || []).some((m) => m.from === 'customer' && !m.seen)) {
      q.messages = q.messages.map((m) => ({ ...m, seen: true }));
      await store.merge(quotesOf(req.user.id), q.id, { messages: q.messages });
    }
    res.json(ownerView(q));
  } catch (err) { fail(res, err); }
});

/** Save the editor. Totals are recomputed here whatever the page sent. */
app.put('/api/quotes/:id', identity.requireUser, async (req, res) => {
  try {
    const out = await exclusive(`q/${req.user.id}/${req.params.id}`, async () => {
      const q = await loadQuote(req);
      if (q.status === 'accepted') throw httpError(409, 'This quote was accepted and is locked. Duplicate it to make changes.');
      const next = Q.applyEdit(q, req.body);
      return ownerView(await saveQuote(req.user.id, next));
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.delete('/api/quotes/:id', identity.requireUser, async (req, res) => {
  try {
    const q = await loadQuote(req);
    if (q.publicId) await store.remove('links', q.publicId);
    await store.remove(quotesOf(req.user.id), q.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

app.post('/api/quotes/:id/duplicate', identity.requireUser, async (req, res) => {
  try {
    const q = await loadQuote(req);
    const profile = await loadProfile(req.user);
    const copy = blankQuote(profile, {
      number: await nextNumber(req.user.id),
      source: 'duplicate',
      duplicateOf: q.id,
      trade: q.trade,
      customer: { ...q.customer },
      title: `${q.title} (copy)`.slice(0, 90),
      description: q.description || '',
      scope: q.scope,
      items: q.items,
      tiers: q.tiers,
      assumptions: q.assumptions,
      exclusions: q.exclusions,
      timeline: q.timeline,
      terms: q.terms,
      notes: q.notes,
      markupPct: q.markupPct,
      taxPct: q.taxPct,
      discount: q.discount,
      validDays: q.validDays,
    });
    copy.totals = Q.computeTotals(copy);
    const id = await store.add(quotesOf(req.user.id), copy);
    res.json(ownerView({ id, ...copy }));
  } catch (err) { fail(res, err); }
});

/** Send: mint the link (once) and start the validity clock. Sending again
 *  after edits keeps the same link and restarts the clock. */
app.post('/api/quotes/:id/send', identity.requireUser, async (req, res) => {
  try {
    const out = await exclusive(`q/${req.user.id}/${req.params.id}`, async () => {
      const q = await loadQuote(req);
      if (q.status === 'accepted') throw httpError(409, 'This quote was already accepted.');
      if (!hasLines(q)) throw httpError(400, 'Add at least one line item before sending.');
      if (!q.publicId) {
        let token = newToken();
        while (await store.get('links', token)) token = newToken();
        await store.set('links', token, { uid: req.user.id, quoteId: q.id, createdAt: now() });
        q.publicId = token;
      }
      const t = now();
      // A revised quote goes back out as "sent": the customer has not seen
      // THIS version yet. viewedAt is kept, so the first open still counts.
      if (['draft', 'changes', 'declined'].includes(q.status) || Q.isExpired(q)) q.status = 'sent';
      if (!q.sentAt) q.sentAt = t;
      if (q.response && q.response.kind === 'declined') q.response = null;
      q.lastSentAt = t;
      q.validUntil = new Date(Date.now() + (q.validDays || 30) * 86400000).toISOString();
      return ownerView(await saveQuote(req.user.id, q));
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

/** The owner records an outcome that happened off the page - "they said yes
 *  on the phone" - or reopens a declined quote. */
app.post('/api/quotes/:id/mark', identity.requireUser, async (req, res) => {
  try {
    const out = await exclusive(`q/${req.user.id}/${req.params.id}`, async () => {
      const q = await loadQuote(req);
      const to = (req.body || {}).status;
      const st = Q.statusOf(q);
      if (to === 'accepted' || to === 'declined') {
        if (!q.sentAt) throw httpError(409, 'Send the quote first.');
        if (q.status === 'accepted') throw httpError(409, 'Already accepted.');
        const tier = q.tiers ? (q.tiers.some((t) => t.key === (req.body || {}).tier) ? req.body.tier : Q.headlineTier(q)) : null;
        q.status = to;
        q.response = to === 'accepted'
          ? { kind: 'accepted', name: 'Recorded by you', tier, at: now(), manual: true }
          : { kind: 'declined', at: now(), manual: true };
        if (to === 'accepted') q.acceptedAt = q.response.at;
      } else if (to === 'sent') {
        if (st !== 'declined') throw httpError(409, 'Only a declined quote can be reopened.');
        q.status = 'sent';
        q.response = null;
      } else {
        throw httpError(400, 'Unknown status.');
      }
      return ownerView(await saveQuote(req.user.id, q));
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

/** Rewrite the scope. Returns a suggestion; nothing is saved until the owner
 *  taps "Use this" and saves - the same confirm-before-save shape as every
 *  sibling app. */
app.post('/api/quotes/:id/polish', ...spend, async (req, res) => {
  try {
    const q = await loadQuote(req);
    const b = req.body || {};
    // The editor may hold unsaved changes; polish what they are looking at.
    if (typeof b.scope === 'string') q.scope = Q.cleanText(b.scope, 1500);
    if (!q.scope && !hasLines(q)) throw httpError(400, 'Write a line or two of scope first.');
    const client = await clientFor(req);
    res.json(await ai.polish(client, modelFor(req), q, b.tone === 'friendly' ? 'friendly' : 'professional'));
  } catch (err) { fail(res, err, 'Could not polish that. Try again.'); }
});

app.post('/api/quotes/:id/follow-up', ...spend, async (req, res) => {
  try {
    const q = await loadQuote(req);
    if (!q.sentAt) throw httpError(409, 'Send the quote first - there is nothing to follow up on yet.');
    if (q.status === 'accepted') throw httpError(409, 'They already said yes.');
    const profile = await loadProfile(req.user);
    const client = await clientFor(req);
    const f = await ai.followUp(client, modelFor(req), q, profile, {
      daysSince: Math.max(0, Math.round((Date.now() - Date.parse(q.lastSentAt || q.sentAt)) / 86400000)),
      viewed: Boolean(q.viewedAt),
      total: Q.valueOf(q),
    });
    const followUp = { ...f, at: now() };
    await store.merge(quotesOf(req.user.id), q.id, { followUp });
    res.json(followUp);
  } catch (err) { fail(res, err, 'Could not write that follow-up. Try again.'); }
});

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

app.get('/api/templates', identity.requireUser, async (req, res) => {
  try {
    const rows = await store.list(templatesOf(req.user.id), { orderBy: 'createdAt', dir: 'desc', limit: MAX_TEMPLATES });
    res.json({
      templates: rows.map((t) => ({
        id: t.id, name: t.name, title: t.title, trade: t.trade, createdAt: t.createdAt,
        lines: (t.items || []).length, tiers: (t.tiers || []).length,
        value: Q.valueOf({ ...t, taxPct: 0, discount: 0 }),
      })),
    });
  } catch (err) { fail(res, err); }
});

app.post('/api/quotes/:id/template', identity.requireUser, async (req, res) => {
  try {
    const q = await loadQuote(req);
    if (!hasLines(q)) throw httpError(400, 'Add some line items first - a template of nothing is not much help.');
    const existing = await store.list(templatesOf(req.user.id), { limit: MAX_TEMPLATES + 1 });
    if (existing.length >= MAX_TEMPLATES) throw httpError(409, `You have ${MAX_TEMPLATES} templates. Delete one first.`);
    // A template is the reusable part of a quote: never the customer, never
    // the private notes, never anything the customer said.
    const t = {
      name: Q.clean((req.body || {}).name, 60) || q.title,
      title: q.title,
      trade: q.trade,
      scope: q.scope,
      items: q.items,
      tiers: q.tiers,
      assumptions: q.assumptions || [],
      exclusions: q.exclusions || [],
      timeline: q.timeline || '',
      markupPct: q.markupPct,
      createdAt: now(),
    };
    const id = await store.add(templatesOf(req.user.id), t);
    res.json({ id, name: t.name });
  } catch (err) { fail(res, err); }
});

app.delete('/api/templates/:id', identity.requireUser, async (req, res) => {
  try {
    const t = await store.get(templatesOf(req.user.id), String(req.params.id).slice(0, 64));
    if (!t) throw httpError(404, 'No such template.');
    await store.remove(templatesOf(req.user.id), t.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The scoreboard
 * ------------------------------------------------------------------ */

app.get('/api/stats', identity.requireUser, async (req, res) => {
  try {
    const rows = await store.list(quotesOf(req.user.id), { orderBy: 'updatedAt', dir: 'desc', limit: MAX_QUOTES_LISTED });
    res.json(Q.stats(rows));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The customer's side: /q/<token>
 *
 * No account, no model call. The link is the credential, so it is long and
 * random, and what it returns is built by Q.publicView() field by field.
 * ------------------------------------------------------------------ */

async function loadLink(req) {
  const token = String(req.params.token || '');
  if (!TOKEN_RE.test(token)) throw httpError(404, 'This quote link is not valid.');
  const link = await store.get('links', token);
  if (!link) throw httpError(404, 'This quote link is not valid any more.');
  const q = await store.get(quotesOf(link.uid), link.quoteId);
  if (!q) throw httpError(404, 'This quote link is not valid any more.');
  const profile = await store.get('pros', link.uid);
  return { token, link, q, profile: { ...Q.PROFILE_DEFAULTS, ...(profile || {}) } };
}

function isOwner(req, link) {
  return Boolean(req.user && req.user.id === link.uid);
}

app.get('/api/public/:token', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const { link, q, profile } = await loadLink(req);
    // The owner previewing their own link is not the customer opening it.
    if (!isOwner(req, link)) {
      const patch = { views: Number(q.views || 0) + 1, lastViewedAt: now() };
      if (!q.viewedAt) patch.viewedAt = patch.lastViewedAt;
      if (q.status === 'sent') patch.status = 'viewed';
      await store.merge(quotesOf(link.uid), q.id, patch);
      Object.assign(q, patch);
    }
    res.json({ ...Q.publicView(q, profile), preview: isOwner(req, link) });
  } catch (err) { fail(res, err); }
});

function assertRespondable(q) {
  const st = Q.statusOf(q);
  if (st === 'accepted') throw httpError(409, 'This quote has already been accepted.');
  if (st === 'declined') throw httpError(409, 'This quote was declined. Ask for a fresh one.');
  if (st === 'expired') throw httpError(410, 'This quote has expired. Ask for an updated one - prices may have changed.');
  if (!Q.OPEN.includes(q.status)) throw httpError(409, 'This quote is not open for a response.');
}

app.post('/api/public/:token/accept', async (req, res) => {
  try {
    const out = await exclusive(`pub/${req.params.token}`, async () => {
      const { link, q, profile } = await loadLink(req);
      if (isOwner(req, link)) throw httpError(403, 'This is your own quote - the customer accepts it from their link.');
      assertRespondable(q);
      const b = req.body || {};
      const name = Q.clean(b.name, 80).replace(/\s+/g, ' ');
      if (!/\p{L}\S*\s+\p{L}/u.test(name)) throw httpError(400, 'Type your full name - first and last - to sign.');
      let tier = null;
      if (q.tiers) {
        tier = q.tiers.some((t) => t.key === b.tier) ? b.tier : null;
        if (!tier) throw httpError(400, 'Choose an option first.');
      }
      const at = now();
      const patch = {
        status: 'accepted',
        response: { kind: 'accepted', name, tier, at },
        acceptedAt: at,
        updatedAt: at,
      };
      await store.merge(quotesOf(link.uid), q.id, patch);
      return Q.publicView({ ...q, ...patch }, profile);
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.post('/api/public/:token/changes', async (req, res) => {
  try {
    const out = await exclusive(`pub/${req.params.token}`, async () => {
      const { link, q, profile } = await loadLink(req);
      if (isOwner(req, link)) throw httpError(403, 'This is your own quote.');
      assertRespondable(q);
      const text = Q.cleanText((req.body || {}).message, 1000);
      if (text.length < 3) throw httpError(400, 'Say what you would like changed.');
      const fromCustomer = (q.messages || []).filter((m) => m.from === 'customer').length;
      if (fromCustomer >= MAX_CUSTOMER_MESSAGES) throw httpError(429, 'That is a lot of changes - give them a call instead.');
      const at = now();
      const patch = {
        status: 'changes',
        messages: [...(q.messages || []), { from: 'customer', text, at, seen: false }],
        updatedAt: at,
      };
      await store.merge(quotesOf(link.uid), q.id, patch);
      return Q.publicView({ ...q, ...patch }, profile);
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.post('/api/public/:token/decline', async (req, res) => {
  try {
    const out = await exclusive(`pub/${req.params.token}`, async () => {
      const { link, q, profile } = await loadLink(req);
      if (isOwner(req, link)) throw httpError(403, 'This is your own quote.');
      assertRespondable(q);
      const reason = Q.cleanText((req.body || {}).message, 600);
      const at = now();
      const patch = {
        status: 'declined',
        response: { kind: 'declined', at, reason },
        messages: reason ? [...(q.messages || []), { from: 'customer', text: `Declined: ${reason}`, at, seen: false }] : (q.messages || []),
        updatedAt: at,
      };
      await store.merge(quotesOf(link.uid), q.id, patch);
      return Q.publicView({ ...q, ...patch }, profile);
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// The customer's page is the same single-page app, served one level down at
// q/<token>. A <base href="../"> makes every relative asset and API path in
// it resolve against the app's root, so it works at `/q/x` on its own and at
// `/snapquote/q/x` inside the combined host without knowing which.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function publicIndex() {
  if (!indexHtml || MEMORY) indexHtml = require('fs').readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/q/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(publicIndex());
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// A body over the limit, or JSON that does not parse, is the caller's mistake.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once - try fewer or smaller photos.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // SNAPQUOTE_DEV_MOUNT=/snapquote runs it the way the combined host does:
  // mounted under a prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.SNAPQUOTE_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`snapquote listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
