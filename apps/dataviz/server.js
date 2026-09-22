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
const Anthropic = require('@anthropic-ai/sdk');
const identityLib = require('./lib/identity');
const identityStore = require('./lib/identity-store');
const mail = require('./lib/mail');
const reset = require('./lib/reset');

const app = express();

// Only the landing page may put this app in a frame - it shows a live
// preview you can swipe through. Nothing else should be able to: a gated app
// inside a hostile page is the setup for clickjacking a signed-in session.
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  next();
});
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
/** What the shared identity record alone may say. A copy of any of these on
 *  DataViz's own row is a stale echo of a Stripe webhook, never the truth. */
const ENTITLEMENT_FIELDS = [
  'plan', 'currentPeriodEnd', 'subscriptionStatus', 'memberSince',
  'toppedUpUsd', 'spentUsd', 'byok',
];

async function attachProfile(req, _res, next) {
  if (req.user) {
    const own = await db.get('users', req.user.id).catch(() => null);
    // This app's record carries billing, never identity. Pin the fields that
    // say WHO they are so a stale local row cannot demote the owner...
    //
    // ...and drop the ones that say what they PAID for. The membership buys
    // all five apps, so it lives on the shared identity record; the local row
    // is a stripeCustomerId index the subscription webhook looks accounts up
    // by, nothing more. Letting its `plan` back in is precisely how this app
    // came to agree with itself while the other four served a paying member
    // the free tier: the disagreement was invisible from the only place that
    // merged both. Identity decides who has paid, here as everywhere.
    if (own) {
      const local = { ...own };
      for (const key of ENTITLEMENT_FIELDS) delete local[key];
      Object.assign(req.user, local, {
        id: req.user.id, email: req.user.email, admin: req.user.admin, access: req.user.access,
      });
    }
  }
  next();
}

app.get('/api/auth/me', identity.attachUser, attachProfile, async (req, res) => {
  res.json({
    signedIn: Boolean(req.user),
    email: req.user ? req.user.email : null,
    via: req.user ? req.user.via : null,
    plan: planOf(req.user),
    paid: isPaid(req.user),
    billing: stripe.enabled(),
    // So the sheet can say "your request is in" rather than offering the
    // button again to someone who already pressed it.
    askedPro: Boolean(identityLib.pendingRequest(req.user, 'dataviz')),
    // The shared credit balance, so the sheet can show the meter.
    budget: identityLib.budgetFor(req.user),
    // The flat monthly fee: whether it is on sale here, what it costs, and
    // whether this person already pays it.
    membership: {
      available: stripe.membershipEnabled(),
      monthlyUsd: stripe.MEMBERSHIP_USD,
      active: identityLib.isMember(req.user),
    },
    // Their own key: whether the deployment supports it, and if they have one,
    // the last four characters. Never the key.
    byok: {
      supported: identity.byokEnabled(),
      present: Boolean(req.user && req.user.byok && req.user.byok.blob),
      last4: (req.user && req.user.byok && req.user.byok.last4) || null,
      addedAt: (req.user && req.user.byok && req.user.byok.addedAt) || null,
    },
    remaining: await quota.remaining(req).catch(() => null),
  });
});

identity.mount(app);
app.use(attachProfile);
// Price and record every model call this app makes.
shape.useMeter(identity.meter);

/** One source of truth for the plan, for the wire. Keeping two independent
 *  definitions is what let an admin be paid by one and free by the other. */
function planOf(user) {
  return isPaid(user) ? 'member' : 'free';
}

const fail = (res, err, fallback = 'Something went wrong.') =>
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });

/** Who may use their own data rather than only the samples.
 *
 *  There is one paid tier now - the $5 membership - and this is part of it.
 *  The separate $9 "DataViz Pro" subscription is gone: two products for one
 *  person to choose between, where one is a strict subset of the other, is a
 *  decision nobody wanted to make. A membership buys all five apps, and using
 *  your own data here is one of the things it buys.
 *
 *  With no Stripe keys configured the app is entirely free, so it keeps
 *  working before billing exists and if the keys are ever removed. */
function isPaid(user) {
  if (!stripe.enabled()) return true;
  if (!user) return false;
  // Free without paying: you own the place, or the admin comped you. Checked
  // first so neither depends on Stripe being reachable.
  if (user.admin === true) return true;
  // Any grant at all, not the exact level 'pro'. The levels in `access` are
  // per-app strings and this app now defines exactly one thing to grant, so
  // demanding a particular word only means a comp written as 'member' - the
  // natural thing for the admin to type now - would quietly do nothing.
  if (identityLib.hasAccess(user, 'dataviz')) return true;
  // Running on their own Anthropic key: they are already paying for the
  // expensive part themselves - and for the platform, since a key only counts
  // while the membership does. identityLib.paysPlatformFee is the one place
  // that decides it, so this cannot drift from what actually routes the call.
  if (user.byok && user.byok.blob && identityLib.paysPlatformFee(user)) return true;
  // The membership. isMember already honours the end of a cancelled period.
  return identityLib.isMember(user);
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

    // There is one subscription to sell now, so there is nothing to tell
    // apart. A `kind` other than membership can only be a Pro subscription
    // sold before that plan was retired; it still gets a membership, which is
    // the metered tier - the generous reading of an ambiguous event is how
    // someone ends up with unlimited spend for $5.
    await writePlan(uid, { plan: 'member', memberSince: new Date().toISOString() },
                    obj.customer || null, obj.subscription || null);
    await identity.log('membership.started', null, { uid });
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
    // Where the period end lives depends on the API version rendering the
    // event. Stripe's basil release MOVED current_period_end off the
    // Subscription and onto its items, and this endpoint has api_version null
    // - it renders in the account's default version, whatever that becomes.
    // Reading only the old place would have written null forever and quietly
    // retired isMember's expiry check, which is the safety net for the case
    // where the `deleted` event never arrives.
    const periodEnd = obj.current_period_end
      || (obj.items && obj.items.data && obj.items.data[0]
          && obj.items.data[0].current_period_end)
      || null;
    await writePlan(target, {
      plan: active ? 'member' : 'free',
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      subscriptionStatus: obj.status || null,
    }, null, obj.id || null);
  }
}

/**
 * Write an entitlement to the SHARED identity record, not this app's own.
 *
 * This is the bug that made it worth writing down. Credit already landed on
 * the shared record - there is an explicit comment above saying so, because
 * it is spendable in every app - but the PLAN was being written to DataViz's
 * own database. Every other app loads its user from identity and has never
 * heard of DataViz's `users` collection, so a $5 membership bought here would
 * have been invisible in Trip Planner, Football, Friction and Hopscotch:
 * budgetFor() would see no `plan`, isMember() would return false, and a
 * paying member would have been served the free tier - Haiku and four
 * searches - in four of the five apps they had just paid for.
 *
 * It did not show up in testing because every test asks DataViz, which merges
 * its own record onto req.user in attachProfile and therefore always agreed
 * with itself.
 *
 * The local row is still written, and only because the subscription.updated
 * handler looks an account up by stripeCustomerId - the shared store has no
 * query-by-field. Identity is what any app reads; the local row is an index.
 */
async function writePlan(uid, fields, customerId, subscriptionId) {
  if (!uid) return;
  const record = { ...fields };
  if (customerId) record.stripeCustomerId = customerId;
  if (subscriptionId) record.stripeSubscriptionId = subscriptionId;
  await identityStore.store.merge('users', uid, record).catch((e) => {
    console.error('[billing] could not write the plan to identity', e);
    throw e;   // a paid subscription that does not land is not a silent failure
  });
  await db.merge('users', uid, record).catch(() => {});
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));
// Cloud Run's edge swallows /healthz: in production it returns a 404 with no
// Server header, on the run.app URL and the custom domain alike, while every
// other path - including ones the app does not define - reaches the app. It
// works locally, which is why it went unnoticed: CI and boot checks were
// testing a route no external monitor could ever reach. /api/health is the
// same handler on a path the edge leaves alone.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

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

// `free` says whether a sample has a baked spec - the ones that render with
// no model call. The tour only ever taps those, so a landing-page visit
// costs nothing; the page can use it too.
app.get('/api/datasets', (_req, res) => res.json({
  datasets: datasets.list().map((d) => Object.assign({}, d, { free: datasets.isFree(datasets.get(d.id)) })),
}));

// The old $9 Pro checkout stood here. It is gone rather than hidden: a route
// that still mints a subscription nobody is offered is how a stale button in
// a cached page sells something that no longer exists. Anyone who somehow
// reaches it gets the membership instead.
app.post('/api/checkout', accounts.requireUser, (req, res) =>
  res.status(410).json({ error: 'That plan is gone - the membership replaced it.', membership: true }));

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
    priceId: stripe.memberPriceId() || null,
    webhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    enabled: stripe.enabled(),
  };
  if (!out.enabled) return res.json({ ...out, price: null, error: 'Billing is not configured.' });
  try {
    const price = await stripe.call(`/prices/${encodeURIComponent(stripe.memberPriceId())}`, null, 'GET');
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

// Buying credit and the membership used to be five routes right here, because
// this was the only service holding the Stripe keys. They now live in the
// shared account module and every app mounts them, so pressing "AI credit" in
// the trip planner opens the trip planner rather than landing the reader in a
// chart app they were not using. This app reaches them at
// /api/auth/billing* - its own identity mount path - like any other app.
//
// What did NOT move is the webhook at the top of this file. Stripe delivers to
// one endpoint, and STRIPE_WEBHOOK_SECRET has no reason to exist on five
// services to serve one of them.

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
    // Their own key if they have one on file; null means the app's own.
    const client = await identity.clientFor(req.user, null, (apiKey) => new Anthropic({ apiKey }));

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
      if (!isPaid(req.user)) {
        return res.status(402).json({
          error: req.user
            ? 'Your own data is part of the membership. The samples are free and always will be.'
            : 'Make an account and join to use your own data. The samples are free without one.',
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

    // Nothing reaches a model for someone we cannot charge. Both branches
    // above already refuse an anonymous visitor - own data with a 402, and a
    // sample by being answered from its baked spec without a model call at
    // all - so this is the backstop for the path between them: a sample with
    // NO baked spec falls through to the model, and would spend on the shared
    // key for a visitor with no account and no ledger. Every sample has a
    // spec today, which is exactly why this is worth having: the day someone
    // adds one without, the failure should be a sign-in prompt and not a
    // silent, untracked bill.
    if (!req.user) {
      return res.status(401).json({
        error: 'Make an account to build this one. The samples are free without one.',
        signUp: true,
      });
    }

    let table = source.tables && source.tables[0];
    let fromProse = false;
    if (!table) {
      if (!source.prose || source.prose.length < 40) {
        return res.status(422).json({ error: "I couldn't find any data in that. Try a page with a table, or paste CSV." });
      }
      table = await shape.tableFromProse(source.prose, hint, plan.model, client);
      fromProse = true;
    }

    const spec = await shape.design(table, usedHint, plan.model, client);
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
