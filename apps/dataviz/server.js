const crypto = require('crypto');
const path = require('path');
const express = require('express');

const db = require('./lib/db');
const accounts = require('./lib/accounts');
const extract = require('./lib/extract');
const shape = require('./lib/shape');
const builder = require('./lib/build');
const quota = require('./lib/quota');
const stripe = require('./lib/stripe');
const datasets = require('./lib/datasets');
const analytics = require('./lib/analytics');
const webauthn = require('./lib/webauthn');
const identityLib = require('./lib/identity');
const identityStore = require('./lib/identity-store');
const mail = require('./lib/mail');
const reset = require('./lib/reset');

const app = express();
const PORT = process.env.PORT || 8080;
const MAX_PROJECTS = 60;

app.set('trust proxy', 1);

/* ---------- Stripe webhook: raw body, mounted FIRST ----------
 * express.json() parses and re-serialises, which changes the bytes and makes
 * every signature fail for a reason that is not obvious from the error. This
 * route must stay above the JSON parser. */
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  let event;
  try {
    event = stripe.verifyWebhook(req.body, req.get('Stripe-Signature'));
  } catch (err) {
    console.error('stripe webhook rejected:', err.message);
    return res.status(err.status || 400).json({ error: err.message });
  }
  try {
    // Stripe's own guidance: an endpoint can receive the same event more than
    // once, and in some cases two distinct Event objects for one change. Both
    // handlers here are writes, so replaying one would re-grant or re-revoke
    // access. Record the id first and skip anything already applied.
    const seen = await db.get('billing-events', event.id);
    if (seen) return res.json({ received: true, duplicate: true });
    await applyBillingEvent(event);
    await db.set('billing-events', event.id, {
      type: event.type, appliedAt: new Date().toISOString(),
    });
    res.json({ received: true });
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want when our own write
    // failed. Never 200 an event that was not applied.
    console.error('stripe webhook handling failed:', event.type, err.message);
    res.status(500).json({ error: 'Could not apply that event.' });
  }
});

app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  next();
});
// The shared account. Mounted at /api/auth, which is where this app's UI
// already posts - so register, login, logout and the Face ID routes all keep
// their URLs and the frontend needs no change.
//
// This app keeps its OWN users/<uid> record for billing (plan,
// stripeCustomerId) and still owns every project by that uid. The uid is
// unchanged: both this app and identity derive it as base64url of the
// lowercased email, so nothing is orphaned by the move.
const identity = identityLib.create({
  store: identityStore.store,
  secret: () => process.env.IDENTITY_SESSION_SECRET || '',
  app: 'dataviz',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'DataViz',
  mountPath: '/api/auth',
});

/** Merge this app's own record onto the identity it belongs to, so routes can
 *  keep reading req.user.plan and req.user.stripeCustomerId as before. */
async function attachProfile(req, _res, next) {
  if (req.user) {
    const own = await db.get('users', req.user.id).catch(() => null);
    // This app's record carries billing, never identity. Pin the fields that
    // say WHO they are so a stale local row cannot demote the owner.
    if (own) Object.assign(req.user, own, {
      id: req.user.id, email: req.user.email, admin: req.user.admin, access: req.user.access,
    });
  }
  next();
}

app.get('/api/auth/me', identity.attachUser, attachProfile, async (req, res) => {
  res.json({
    signedIn: Boolean(req.user),
    email: req.user ? req.user.email : null,
    via: req.user ? req.user.via : null,
    plan: planOf(req.user),
    pro: isPro(req.user),
    billing: stripe.enabled(),
    // So the sheet can say "your request is in" rather than offering the
    // button again to someone who already pressed it.
    askedPro: Boolean(identityLib.pendingRequest(req.user, 'dataviz')),
    // The shared credit balance, so the sheet can show the meter.
    budget: identityLib.budgetFor(req.user),
    remaining: await quota.remaining(req).catch(() => null),
  });
});

identity.mount(app);
app.use(attachProfile);
// Price and record every model call this app makes.
shape.useMeter(identity.meter);

/** One source of truth for the plan. isPro is the real test; this is its name
 *  for the wire. Keeping two independent definitions is what let an admin be
 *  Pro by one and free by the other. */
function planOf(user) {
  return isPro(user) ? 'pro' : 'free';
}

const fail = (res, err, fallback = 'Something went wrong.') =>
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });

/** With no Stripe keys configured the app is entirely free, so it keeps
 *  working before billing exists and if the keys are ever removed. */
function isPro(user) {
  if (!stripe.enabled()) return true;
  if (!user) return false;
  // Two ways to be Pro without paying: you own the place, or the admin comped
  // you. Checked before the subscription so neither depends on Stripe state.
  if (user.admin === true) return true;
  if (identityLib.hasAccess(user, 'dataviz', 'pro')) return true;
  if (user.plan !== 'pro') return false;
  // A cancelled subscription keeps access to the end of the paid period.
  if (user.currentPeriodEnd && Date.parse(user.currentPeriodEnd) < Date.now()) return false;
  return true;
}

/** Fold one Stripe event into the account it belongs to. Only the events that
 *  change whether someone has paid are handled; the rest are acknowledged. */
async function applyBillingEvent(event) {
  const obj = (event.data && event.data.object) || {};
  const uid = (obj.metadata && obj.metadata.uid) || obj.client_reference_id || null;

  if (event.type === 'checkout.session.completed') {
    if (!uid) return;

    // A credit top-up is NOT a subscription. Without this branch it would fall
    // into the code below and hand someone Pro for a one-off $5 payment.
    if ((obj.metadata && obj.metadata.kind) === 'credit' || obj.mode === 'payment') {
      const usd = Number((obj.metadata && obj.metadata.creditUsd) || 0);
      if (usd > 0) {
        // Credit lands on the SHARED account, because it is spendable in every
        // app - not in this app's own billing record.
        await identityStore.store.bump('users', uid, { toppedUpUsd: usd });
        await identity.log('credit.purchased', null, { uid, detail: `$${usd}` });
      }
      return;
    }

    await db.merge('users', uid, {
      plan: 'pro',
      stripeCustomerId: obj.customer || null,
      stripeSubscriptionId: obj.subscription || null,
      proSince: new Date().toISOString(),
    });
    return;
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    // The uid rides on subscription_data.metadata, set when checkout started.
    let target = uid;
    if (!target && obj.customer) {
      const rows = await db.list('users', { where: [['stripeCustomerId', '==', obj.customer]], limit: 1 });
      target = rows.length ? rows[0].id : null;
    }
    if (!target) return;
    const active = event.type !== 'customer.subscription.deleted'
      && ['active', 'trialing', 'past_due'].includes(obj.status);
    await db.merge('users', target, {
      plan: active ? 'pro' : 'free',
      stripeSubscriptionId: obj.id || null,
      currentPeriodEnd: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
      subscriptionStatus: obj.status || null,
    });
  }
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ---------- accounts (only ever needed to SAVE) ---------- */


/* ---------- forgotten passwords ---------- */

app.post('/api/auth/reset/request', async (req, res) => {
  const address = String((req.body || {}).email || '').trim().toLowerCase();
  // One answer for every input. Anything else turns this into a way of
  // asking which addresses have accounts here.
  const same = { ok: true, message: 'If that address has an account, a reset link is on its way.' };
  try {
    // The password lives in the shared identity record now, not in this
    // app's own users/<uid> (which holds billing only).
    const uid = identityLib.uidFor(address);
    const user = await identityStore.store.get('users', uid);
    if (user && user.password && mail.enabled()) {
      const origin = `${req.protocol}://${req.get('host')}`;
      // The token carries the CURRENT hash, which is what makes it single-use:
      // setting a new password changes the hash and the old link stops
      // verifying, with nothing stored to expire.
      const link = `${origin}/reset?t=${encodeURIComponent(reset.makeToken(uid, user.password.hash))}`;
      const body = reset.emailBody({ link, origin });
      await mail.send({ to: user.email, subject: body.subject, html: body.html, text: body.text });
    }
  } catch (err) {
    // A send failure must not change the answer either, or the timing and
    // the wording become the oracle the identical answer was protecting.
    console.error('reset/request', err.message);
  }
  res.json(same);
});

app.post('/api/auth/reset/complete', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const raw = String(token || '');
    const uid = raw.includes('.') ? Buffer.from(raw.slice(0, raw.indexOf('.')), 'base64url').toString().split('.')[0] : '';
    const user = uid ? await identityStore.store.get('users', uid) : null;
    if (!user || !user.password || reset.readToken(raw, user.password.hash) !== uid) {
      return res.status(400).json({ error: 'That link has expired or has already been used.' });
    }
    const next = String(password || '');
    if (next.length < identityLib.MIN_PASSWORD) {
      return res.status(400).json({ error: `Use at least ${identityLib.MIN_PASSWORD} characters.` });
    }
    await identityStore.store.set('users', uid, {
      ...user,
      password: identityLib.makeHash(next),
      passwordChangedAt: new Date().toISOString(),
    });
    identity.issueSession(res, req, uid, 'password');
    await identity.log('password.reset', req, { uid, email: user.email });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Could not set that password.');
  }
});


app.get('/reset', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));



/* ---------- billing ---------- */

app.get('/api/datasets', (_req, res) => res.json({ datasets: datasets.list() }));

app.post('/api/checkout', accounts.requireUser, async (req, res) => {
  try {
    if (!stripe.enabled()) return res.status(503).json({ error: 'Billing is not set up on this deployment.' });
    const origin = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.createCheckout({
      uid: req.user.id,
      email: req.user.email,
      customerId: req.user.stripeCustomerId || null,
      successUrl: `${origin}/?upgraded=1`,
      cancelUrl: `${origin}/`,
    });
    res.json({ url: session.url });
  } catch (err) { fail(res, err, 'Could not start checkout.'); }
});

// Nothing in the build container can reach api.stripe.com, and nothing can
// reach this app over HTTP either, so "the key is mounted" and "the key works"
// are separate claims. This route settles the second one from inside the
// running service: it makes one real, read-only call to Stripe and reports
// what came back.
//
// It never echoes a key - only whether each is present, and what Stripe said
// about the price. Signed-in only, because an open endpoint that reports which
// billing config is missing is a map for someone probing the service.
app.get('/api/stripe/health', accounts.requireUser, async (req, res) => {
  const out = {
    secretKey: Boolean(process.env.STRIPE_SECRET_KEY),
    priceId: stripe.priceId() || null,
    webhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    enabled: stripe.enabled(),
  };
  if (!out.enabled) return res.json({ ...out, price: null, error: 'Billing is not configured.' });
  try {
    const price = await stripe.call(`/prices/${encodeURIComponent(stripe.priceId())}`, null, 'GET');
    out.price = {
      id: price.id,
      active: price.active,
      // livemode false means this is the test key and test price, which is
      // what a test-mode key should report. A mismatch here is the failure
      // worth catching before a real customer meets it.
      livemode: price.livemode,
      currency: price.currency,
      unitAmount: price.unit_amount,
      interval: price.recurring ? price.recurring.interval : null,
    };
    out.ok = true;
  } catch (err) {
    out.ok = false;
    out.error = err.message;
  }
  res.json(out);
});

// Buying credit. Hosted here because this is the service holding the Stripe
// keys and the verified webhook, but what it buys is account-level: the
// balance is on the shared identity record and spends in every app.
app.get('/api/credit', accounts.requireUser, (req, res) => {
  res.json({
    budget: identityLib.budgetFor(req.user),
    options: stripe.TOP_UPS,
    billing: stripe.enabled(),
  });
});

app.post('/api/credit/checkout', accounts.requireUser, async (req, res) => {
  try {
    if (!stripe.enabled()) return res.status(503).json({ error: 'Billing is not set up on this deployment.' });
    const origin = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.createTopUp({
      uid: req.user.id,
      email: req.user.email,
      usd: Number((req.body || {}).usd),
      customerId: req.user.stripeCustomerId || null,
      successUrl: `${origin}/?credited=1`,
      cancelUrl: `${origin}/`,
    });
    res.json({ url: session.url });
  } catch (err) { fail(res, err, 'Could not start that purchase.'); }
});

app.post('/api/billing-portal', accounts.requireUser, async (req, res) => {
  try {
    if (!req.user.stripeCustomerId) return res.status(400).json({ error: 'No subscription to manage yet.' });
    const origin = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.createPortal({ customerId: req.user.stripeCustomerId, returnUrl: `${origin}/` });
    res.json({ url: session.url });
  } catch (err) { fail(res, err, 'Could not open the billing page.'); }
});

/* ---------- the one route that costs money ---------- */

// This route is reachable WITHOUT an account - a sample with no baked spec
// falls through to the model - so its default model is the one that matters
// most for the bill. Free and anonymous use runs on Haiku; Pro, the owner and
// anyone on their own key still get Opus, which is what they are paying for.
const MODEL_TIERS = { free: 'claude-haiku-4-5', paid: shape.MODEL };

app.post('/api/viz', identity.requireBudget, async (req, res) => {
  try {
    const { url, text, hint, datasetId } = req.body || {};
    let source, usedHint = hint;
    const plan = identityLib.planFor(req.user, MODEL_TIERS);

    // A sample with a baked spec costs nothing to serve: fixed data, fixed
    // mapping, no model call. So it is answered before the quota is touched
    // and never counts against it. Anything else goes through the quota,
    // because anything else is an Opus call on Erik's key.
    if (datasetId) {
      const ds = datasets.get(String(datasetId));
      if (!ds) return res.status(404).json({ error: 'No such sample.' });
      const table = extract.fromText(ds.csv).tables[0];
      if (datasets.isFree(ds) && table) {
        const viz = builder.build(table, ds.spec);
        return res.json({
          viz,
          title: ds.spec.title || ds.title,
          subtitle: ds.spec.subtitle || '',
          note: ds.spec.note || '',
          fromProse: false,
          sample: ds.title,
          free: true,
          sourceUrl: null,
          rowCount: table.length - 1,
          columns: table[0],
          remaining: await quota.remaining(req).catch(() => null),
        });
      }
      // A sample without a baked spec falls back to the model, and then it
      // costs the same as anything else and is metered the same way.
      await quota.check(req);
      source = Object.assign({ sourceUrl: null, sample: ds.title }, extract.fromText(ds.csv));
      if (!usedHint) usedHint = ds.hint;
    } else if ((url && String(url).trim()) || (text && String(text).trim())) {
      if (!isPro(req.user)) {
        return res.status(402).json({
          error: req.user
            ? 'Your own data is part of the paid plan. The samples are free and always will be.'
            : 'Make an account and upgrade to use your own data. The samples are free without one.',
          upgrade: true,
        });
      }
      await quota.check(req);
      source = url && String(url).trim()
        ? await extract.fromUrl(String(url).trim())
        : Object.assign({ sourceUrl: null }, extract.fromText(String(text)));
    } else {
      return res.status(400).json({ error: 'Pick a sample, paste some data, or give me a link.' });
    }

    let table = source.tables && source.tables[0];
    let fromProse = false;
    if (!table) {
      if (!source.prose || source.prose.length < 40) {
        return res.status(422).json({ error: "I couldn't find any data in that. Try a page with a table, or paste CSV." });
      }
      table = await shape.tableFromProse(source.prose, hint, plan.model);
      fromProse = true;
    }

    const spec = await shape.design(table, usedHint, plan.model);
    const viz = builder.build(table, spec);

    await quota.record(req);
    res.json({
      viz,
      title: spec.title,
      subtitle: spec.subtitle,
      note: spec.note,
      fromProse,
      sample: source.sample || null,
      sourceUrl: source.sourceUrl || null,
      rowCount: table.length - 1,
      columns: table[0],
      remaining: await quota.remaining(req).catch(() => null),
    });
  } catch (err) {
    console.error('POST /api/viz', err.message);
    fail(res, err, 'Could not build a visual from that.');
  }
});

/* ---------- saving (this is what an account is for) ---------- */

app.get('/api/projects', accounts.requireUser, async (req, res) => {
  try {
    const rows = await db.list('projects', { where: [['ownerId', '==', req.user.id]] });
    rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    res.json({ projects: rows.map((p) => ({
      id: p.id, title: p.title, type: p.viz && p.viz.type, updatedAt: p.updatedAt, shareId: p.shareId,
    })) });
  } catch (err) { fail(res, err, 'Could not load your work.'); }
});

app.post('/api/projects', accounts.requireUser, async (req, res) => {
  try {
    const { title, subtitle, note, viz, sourceUrl } = req.body || {};
    if (!viz || !viz.type) return res.status(400).json({ error: 'Nothing to save yet.' });
    const mine = await db.list('projects', { where: [['ownerId', '==', req.user.id]] });
    if (mine.length >= MAX_PROJECTS) {
      return res.status(409).json({ error: `You can keep ${MAX_PROJECTS} saved visuals. Delete one to make room.` });
    }
    const id = crypto.randomBytes(9).toString('base64url');
    const now = new Date().toISOString();
    const doc = {
      ownerId: req.user.id,
      title: String(title || 'Untitled').slice(0, 140),
      subtitle: String(subtitle || '').slice(0, 200),
      note: String(note || '').slice(0, 500),
      sourceUrl: sourceUrl || null,
      viz,
      shareId: crypto.randomBytes(9).toString('base64url'),
      createdAt: now,
      updatedAt: now,
    };
    await db.set('projects', id, doc);
    res.json({ id, shareId: doc.shareId });
  } catch (err) { fail(res, err, 'Could not save that.'); }
});

app.get('/api/projects/:id', accounts.requireUser, async (req, res) => {
  const p = await db.get('projects', req.params.id);
  // 404 rather than 403 on someone else's project, so the API will not
  // confirm that an id exists.
  if (!p || p.ownerId !== req.user.id) return res.status(404).json({ error: 'Not found.' });
  res.json(p);
});

app.delete('/api/projects/:id', accounts.requireUser, async (req, res) => {
  const p = await db.get('projects', req.params.id);
  if (!p || p.ownerId !== req.user.id) return res.status(404).json({ error: 'Not found.' });
  await db.remove('projects', req.params.id);
  res.json({ ok: true });
});

/** A share link is read-only and needs no account. It is a separate random id
 *  from the project id, so a shared link can be revoked later by rotating it
 *  without breaking the owner's own reference. */
app.get('/api/shared/:shareId', async (req, res) => {
  const rows = await db.list('projects', { where: [['shareId', '==', req.params.shareId]], limit: 1 });
  if (!rows.length) return res.status(404).json({ error: 'Not found.' });
  const p = rows[0];
  res.json({ title: p.title, subtitle: p.subtitle, note: p.note, viz: p.viz, sourceUrl: p.sourceUrl });
});

// Analytics. Serves an inert file unless GA_MEASUREMENT_ID is set.
analytics.mount(app, 'dataviz');

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`DataViz listening on :${PORT}`));
