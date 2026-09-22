// The commercial model: a flat monthly fee, credit sold at cost, and a
// bring-your-own-key path that costs us nothing to serve.
//
// The expensive mistake this suite exists to prevent is one substitution: a
// $5/month membership read as an unlimited Pro plan. Both arrive from Stripe
// as `mode: subscription` and only the metadata tells them apart, so it is
// worth a test in both directions and on the renewal a year later.
const h = require('./harness.js');
h.install();
const SECRET = 'identity-secret-abcdefghijklmn';
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: SECRET,
  SESSION_SECRET: 'dataviz-secret-abcdefghijklmn',
  FIRESTORE_DATABASE_ID: 'dataviz',
  IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test',
  STRIPE_SECRET_KEY: 'sk_test_dummy_not_called',
  // Deliberately set, and deliberately garbage: the retired Pro price is
  // still mounted on at least one deployment, and nothing may read it.
  STRIPE_PRICE_ID: 'price_dummy_not_called',
  STRIPE_MEMBER_PRICE_ID: 'price_member_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_signing_secret',
  PORT: '9212',
});
require(require('path').join(__dirname, '..', 'apps', 'dataviz', 'server.js'));
const identity = require(require('path').join(__dirname, '..', 'shared', 'identity.js'));
const stripe = require(require('path').join(__dirname, '..', 'apps', 'dataviz', 'lib', 'stripe.js'));

const B = 'http://127.0.0.1:9212';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const TIERS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };
const crypto = require('crypto');
const uidOfEmail = (e) => Buffer.from(e.toLowerCase()).toString('base64url');

/** Post a webhook the way Stripe does: signed, over HTTP, raw body. Driving
 *  the real route rather than the handler keeps the signature check and the
 *  raw-body parser in the test. */
async function webhook(event) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test_signing_secret').update(`${t}.${raw}`).digest('hex');
  return fetch(B + '/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` },
    body: raw,
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  let r = await post('/api/auth/register', { email: 'member@example.com', password: 'a-long-password-1' });
  const cookie = jar(r);
  ok('an account registers', r.status === 200, String(r.status));

  // --- what membership is, and is not -------------------------------------
  const member = { plan: 'member', email: 'm@x.co', toppedUpUsd: 20, spentUsd: 1 };
  const budget = identity.budgetFor(member);
  ok('a member is NOT unlimited - that is the whole model', budget.unlimited === false, JSON.stringify(budget));
  ok('...they spend their own credit, 1:1', budget.remainingUsd === 21, String(budget.remainingUsd));
  ok('...and they are on the paid tier anyway', identity.planFor(member, TIERS).model === 'claude-sonnet-5');
  ok('...with the bigger search budget', identity.planFor(member, TIERS).maxUses >= 10);

  const broke = identity.budgetFor({ plan: 'member', toppedUpUsd: 0, spentUsd: 99 });
  ok('a member who spends their balance is stopped like anyone else', broke.remainingUsd === 0, String(broke.remainingUsd));

  ok('a lapsed membership stops at the end of the paid period',
     identity.isMember({ plan: 'member', currentPeriodEnd: '2020-01-01T00:00:00Z' }) === false);
  ok('...but runs to the end of a period already paid for',
     identity.isMember({ plan: 'member', currentPeriodEnd: '2099-01-01T00:00:00Z' }) === true);

  // Pro is gone. A stale `plan: 'pro'` row must fall back to the free
  // allowance rather than unlimited spend on the owner's key - the retired
  // plan is not a back door.
  const stale = identity.budgetFor({ plan: 'pro' });
  ok('a retired Pro plan is not unlimited', stale.unlimited === false, String(stale.reason));
  ok('...it just gets the free allowance', stale.reason === 'allowance', String(stale.reason));
  // BYOK costs us nothing in tokens - but it is not free of the platform.
  // The fee buys the apps, the account and the hosting; the key buys the
  // tokens. A key on its own is not a membership.
  ok('a key without a membership is NOT unlimited',
     identity.budgetFor({ byok: { blob: 'x' } }).unlimited === false,
     JSON.stringify(identity.budgetFor({ byok: { blob: 'x' } })));
  ok('...and with one, it is billed to nobody here',
     identity.budgetFor({ plan: 'member', byok: { blob: 'x' } }).reason === 'byok');
  ok('...as it is for the owner, whose platform it is',
     identity.budgetFor({ admin: true, byok: { blob: 'x' } }).unlimited === true);
  ok('a lapsed membership takes the key with it',
     identity.budgetFor({ plan: 'member', currentPeriodEnd: '2020-01-01T00:00:00Z', byok: { blob: 'x' } }).unlimited === false);

  // --- the checkout session that gets built --------------------------------
  const seen = [];
  const realCall = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('api.stripe.com')) {
      seen.push(decodeURIComponent(String(init.body)));
      return { ok: true, status: 200, json: async () => ({ url: 'https://stripe.test/session' }) };
    }
    return realCall(url, init);
  };

  r = await post('/api/auth/billing/membership', {}, cookie);
  ok('a member checkout starts', r.status === 200, String(r.status));
  const body = seen.join('\n');
  ok('...as a subscription', /mode=subscription/.test(body));
  ok('...on the membership price, not the Pro one', /price_member_dummy/.test(body), body.slice(0, 200));
  ok('...carrying kind=membership on the SESSION', /metadata\[kind\]=membership/.test(body));
  ok('...and on the SUBSCRIPTION, so a renewal still knows what it is',
     /subscription_data\[metadata\]\[kind\]=membership/.test(body));

  // Credit is sold at cost, so the membership is what pays for everything
  // around it. Buying tokens without one would run the platform at exactly
  // break-even on the tokens and nothing on the rest.
  seen.length = 0;
  let topUp = await post('/api/auth/billing/credit', { usd: 25 }, cookie);
  ok('credit cannot be bought without a membership', topUp.status === 402, String(topUp.status));
  ok('...and says why', /membership/i.test(JSON.stringify(await topUp.json())));
  ok('...and no checkout was built', seen.length === 0, String(seen.length));

  // A SECOND account becomes a member and may buy. Second on purpose: the
  // first one is asserted further down to be a non-member, and quietly
  // upgrading it here would make that assertion pass for the wrong reason.
  const buyer = jar(await post('/api/auth/register', { email: 'buyer@example.com', password: 'a-long-password-2' }));
  const buyerUid = Buffer.from('buyer@example.com').toString('base64url');
  const before = h.bag('identity').get('users/' + buyerUid) || {};
  h.bag('identity').set('users/' + buyerUid, { ...before, plan: 'member' });

  seen.length = 0;
  await post('/api/auth/billing/credit', { usd: 25 }, buyer);
  const credit = seen.join('\n');
  ok('a top-up is a one-off payment, never a subscription', /mode=payment/.test(credit) && !/mode=subscription/.test(credit));
  ok('...and is tagged as credit so it cannot grant a plan', /metadata\[kind\]=credit/.test(credit));
  global.fetch = realCall;

  // --- top-up amounts ------------------------------------------------------
  ok('the $5 top-up is gone - Stripe took 8.9% of it',
     !stripe.TOP_UPS.some((t) => t.usd === 5), JSON.stringify(stripe.TOP_UPS.map((t) => t.usd)));
  ok('...and $50 is offered, where the fee is 3.5%', stripe.TOP_UPS.some((t) => t.usd === 50));
  ok('every top-up is at least $10', stripe.TOP_UPS.every((t) => t.usd >= 10));

  // --- what the account page is told ---------------------------------------
  r = await fetch(B + '/api/auth/billing', { headers: { cookie } });
  const view = await r.json();
  ok('the membership view reports the fee', view.monthlyUsd === 5, String(view.monthlyUsd));
  ok('...that this account is not yet a member', view.member === false);
  ok('...and offers the bring-your-own-key path', view.byok !== undefined);

  // --- the bug this suite exists for ---------------------------------------
  // A membership bought on DataViz has to be visible to every other app. They
  // load their user from the SHARED identity record and have never heard of
  // DataViz's own users collection, so writing the plan locally would have
  // served the free tier to a paying member in four of the five apps. The
  // assertion is deliberately made from identity's point of view rather than
  // by asking DataViz, because DataViz merges its own row onto req.user and
  // would agree with itself either way.
  const uid = Buffer.from('member@example.com').toString('base64url');
  let hook = await webhook({ id: 'evt_1', type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', customer: 'cus_test_1', subscription: 'sub_test_1',
                      metadata: { uid, kind: 'membership' } } } });
  ok('a signed webhook is accepted', hook.status === 200, String(hook.status));

  const shared = h.bag('identity').get('users/' + uid);
  ok('the plan lands on the SHARED identity record', shared && shared.plan === 'member',
     JSON.stringify(shared && shared.plan));
  ok('...so another app sees a member', identity.isMember(shared) === true);
  ok('...and gives them the paid model tier', identity.planFor(shared, TIERS).model === 'claude-sonnet-5');
  ok('...with the bigger search budget', identity.planFor(shared, TIERS).maxUses >= 10);
  ok('...while still being metered, not unlimited', identity.budgetFor(shared).unlimited === false);

  // The $9 Pro plan is retired. A subscription that still carries its
  // metadata - sold before the plan went away, or a replayed old event - must
  // land as a MEMBERSHIP, which is metered. Reading an ambiguous subscription
  // generously is how someone ends up with unlimited spend for $5.
  const proUid = Buffer.from('pro@example.com').toString('base64url');
  await webhook({ id: 'evt_2', type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', customer: 'cus_test_2', subscription: 'sub_test_2',
                      metadata: { uid: proUid, kind: 'pro' } } } });
  const proShared = h.bag('identity').get('users/' + proUid);
  ok('a retired-Pro subscription lands as a member, not as unlimited',
     proShared && proShared.plan === 'member', JSON.stringify(proShared && proShared.plan));
  ok('...and is therefore metered', identity.budgetFor(proShared).unlimited === false);

  // Nothing offers the old plan any more.
  const gone = await post('/api/checkout', {}, cookie);
  ok('the retired Pro checkout is gone, not quietly selling', gone.status === 410, String(gone.status));

  // Cancellation has to reach identity too, or a lapsed member keeps the tier.
  await webhook({ id: 'evt_3', type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_test_1', customer: 'cus_test_1', status: 'canceled',
                      metadata: { uid, kind: 'membership' } } } });
  const after = h.bag('identity').get('users/' + uid);
  ok('cancelling reaches identity, so the tier actually drops', after.plan === 'free', JSON.stringify(after.plan));
  ok('...and they are no longer a member', identity.isMember(after) === false);

  // --- where the period end lives -------------------------------------------
  // Stripe's basil release moved current_period_end OFF the Subscription and
  // onto its items. This webhook endpoint has api_version null, so it renders
  // in whatever the account's default version is - reading only the old place
  // writes null forever and silently retires isMember's expiry check, which is
  // the only thing covering a `deleted` event that never arrives.
  const laterUid = uidOfEmail('member@example.com');
  const soon = Math.floor(Date.now() / 1000) + 86400;
  await webhook({ id: 'evt_4', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_test_1', customer: 'cus_test_1', status: 'active',
                      metadata: { uid: laterUid, kind: 'membership' },
                      items: { data: [{ current_period_end: soon }] } } } });
  const itemised = h.bag('identity').get('users/' + laterUid);
  ok('a period end carried on the ITEM is still recorded',
     itemised.currentPeriodEnd === new Date(soon * 1000).toISOString(),
     JSON.stringify(itemised.currentPeriodEnd));
  ok('...and they are a member while it is in the future', identity.isMember(itemised) === true);

  // The pre-basil shape still works, since the account may render either.
  await webhook({ id: 'evt_5', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_test_1', customer: 'cus_test_1', status: 'active',
                      metadata: { uid: laterUid, kind: 'membership' },
                      current_period_end: soon } } });
  ok('...as is one carried on the subscription itself',
     h.bag('identity').get('users/' + laterUid).currentPeriodEnd
       === new Date(soon * 1000).toISOString());

  // And the expiry it exists for actually bites.
  const lapsed = { plan: 'member', currentPeriodEnd: new Date(Date.now() - 1000).toISOString() };
  ok('a member whose paid period has passed is not a member',
     identity.isMember(lapsed) === false);

  // --- an unauthenticated stranger cannot start either ----------------------
  ok('membership checkout needs an account', (await post('/api/auth/billing/membership', {})).status === 401);

  // An unsigned webhook is how someone would grant themselves a plan for free.
  const forged = await fetch(B + '/api/stripe/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', metadata: { uid, kind: 'pro' } } } }),
  });
  ok('an unsigned webhook is refused', forged.status >= 400, String(forged.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
