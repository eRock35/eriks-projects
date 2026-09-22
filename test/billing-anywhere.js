// Checkout belongs to the account, not to DataViz.
//
// Every app's "you are out of credit" used to be a link to DataViz, because
// DataViz held the Stripe keys. Pressing "AI credit" in the trip planner
// dropped you into a chart app you were not using, wearing a different
// product's styling, to buy something that was never DataViz's to sell.
//
// The routes moved into the shared account module, so this suite drives them
// on a service that is NOT DataViz - the landing site - and asserts the two
// things that actually make the move worth doing: the route exists there at
// all, and Stripe sends the buyer back to the host they started on.
const h = require('./harness.js');
h.install();
process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'landing-secret-abcdefghijklm';
process.env.ADMIN_PASSWORD = 'admin-password-here-1';
process.env.FIRESTORE_DATABASE_ID = 'eriks-projects';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.PASSKEY_RP_ID = 'strongtechnicalconsulting.com';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_not_called';
process.env.STRIPE_MEMBER_PRICE_ID = 'price_member_dummy';
process.env.PORT = '9216';
require(require('path').join(__dirname, '..', 'server.js'));
const identity = require(require('path').join(__dirname, '..', 'shared', 'identity.js'));

const PORT = 9216;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');

/** POST with an arbitrary Host header, which is the whole point here: the
 *  success_url has to follow the host the request arrived on. fetch() refuses
 *  to set Host, so this is raw http. */
function raw(method, path, body, cookie, host) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: host || `127.0.0.1:${PORT}`, 'content-type': 'application/json' };
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    if (cookie) headers.cookie = cookie;
    const req = require('http').request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        cookies: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; '),
        json: (() => { try { return JSON.parse(b); } catch { return null; } })(),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// The API versions the real Stripe accepts. A stub that takes any string is
// how `2026-08-27.basil` - not a version, never was - shipped and made every
// call this code has ever made fail with `Invalid Stripe API version`. It
// survived because nothing here could reach Stripe and nothing here looked at
// the header, so the fake agreed with whatever it was handed.
const REAL_API_VERSIONS = new Set(['2026-08-26.dahlia']);

/** Swap fetch for one that records the form Stripe would have received - and
 *  rejects a request Stripe itself would reject. */
function captureStripe() {
  const seen = [];
  const real = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.stripe.com')) {
      const headers = (init && init.headers) || {};
      const version = headers['Stripe-Version'];
      // Absent is fine and is the default: Stripe then uses the account's own
      // version. Present and unknown is a 400, exactly as it is in production.
      if (version !== undefined && !REAL_API_VERSIONS.has(version)) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: `Invalid Stripe API version: ${version}` } }),
        };
      }
      seen.push(String(init && init.body) || '');
      return { ok: true, status: 200, json: async () => ({ url: 'https://stripe.test/session' }) };
    }
    return real(url, init);
  };
  return { seen, restore: () => { global.fetch = real; } };
}

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  // --- the link a 402 carries ---------------------------------------------
  // Relative, so it opens the sheet of whichever app served the 402. An
  // absolute dataviz URL here is the whole bug: identity is mounted on six
  // hostnames and must not decide that one of them is where money lives.
  const budget = identity.budgetFor({ spentUsd: 99 });
  ok('a spent-out account has nothing left', budget.remainingUsd === 0 && !budget.unlimited, JSON.stringify(budget));

  const reg = await raw('POST', '/api/id/register',
    { email: 'billing@example.com', password: 'a-long-password-9' });
  ok('an account registers on the landing service', reg.status === 200, String(reg.status));
  const cookie = reg.cookies;

  // --- the route exists away from DataViz ----------------------------------
  const view = await raw('GET', '/api/id/billing', undefined, cookie);
  ok('billing answers on a service that is not DataViz', view.status === 200, String(view.status));
  ok('...and reports the monthly fee', view.json && view.json.monthlyUsd === 5, JSON.stringify(view.json));
  ok('...and the top-up amounts', Array.isArray(view.json.topUps) && view.json.topUps.length === 3);
  ok('...and that this account has not paid', view.json.member === false);

  // --- Stripe returns the buyer to the app they started in -----------------
  let cap = captureStripe();
  let r = await raw('POST', '/api/id/billing/membership', { returnTo: '/writing' }, cookie,
                    'footballapp.strongtechnicalconsulting.com');
  cap.restore();
  ok('a membership checkout starts here', r.status === 200, JSON.stringify(r.json));
  const form = decodeURIComponent(cap.seen.join('\n'));
  ok('...and Stripe sends them back to the app they were in, not DataViz',
     /success_url=https:\/\/footballapp\.strongtechnicalconsulting\.com\/writing\?member=1/.test(form)
     && !/dataviz/.test(form), form.slice(0, 300));
  ok('...and cancelling lands on the same app',
     /cancel_url=https:\/\/footballapp\.strongtechnicalconsulting\.com\/writing/.test(form));
  ok('...over https, because Cloud Run terminates TLS at the edge',
     !/success_url=http:\/\/footballapp/.test(form));

  // --- returnTo is a path, never a URL -------------------------------------
  // Stripe will follow success_url after a real payment. An absolute one here
  // would be an open redirect with a card charge attached to it.
  cap = captureStripe();
  await raw('POST', '/api/id/billing/membership', { returnTo: 'https://evil.example/steal' }, cookie,
            'footballapp.strongtechnicalconsulting.com');
  cap.restore();
  ok('an absolute returnTo is refused, not followed',
     !/evil\.example/.test(decodeURIComponent(cap.seen.join('\n'))), cap.seen.join('\n').slice(0, 200));

  cap = captureStripe();
  await raw('POST', '/api/id/billing/membership', { returnTo: '//evil.example/steal' }, cookie,
            'footballapp.strongtechnicalconsulting.com');
  cap.restore();
  ok('...and so is a protocol-relative one wearing a path’s clothes',
     !/evil\.example/.test(decodeURIComponent(cap.seen.join('\n'))), cap.seen.join('\n').slice(0, 200));

  // --- the membership still gates credit -----------------------------------
  cap = captureStripe();
  const topUp = await raw('POST', '/api/id/billing/credit', { usd: 25 }, cookie);
  cap.restore();
  ok('credit still cannot be bought without a membership', topUp.status === 402, String(topUp.status));
  ok('...and no checkout was built for it', cap.seen.length === 0, String(cap.seen.length));

  // A member may buy, on this service as much as on DataViz.
  const uid = uidOf('billing@example.com');
  const bag = h.bag('identity');
  bag.set('users/' + uid, { ...(bag.get('users/' + uid) || {}), plan: 'member' });
  cap = captureStripe();
  const bought = await raw('POST', '/api/id/billing/credit', { usd: 25 }, cookie,
                           'trip.strongtechnicalconsulting.com');
  cap.restore();
  ok('a member buys credit here', bought.status === 200, JSON.stringify(bought.json));
  const credit = decodeURIComponent(cap.seen.join('\n'));
  ok('...as a one-off payment, never a subscription',
     /mode=payment/.test(credit) && !/mode=subscription/.test(credit));
  ok('...tagged as credit so the webhook cannot read it as a plan',
     /metadata\[kind\]=credit/.test(credit));
  ok('...returning to the trip planner, because that is where they pressed it',
     /success_url=https:\/\/trip\.strongtechnicalconsulting\.com\/\?credited=1/.test(credit), credit.slice(0, 300));

  // --- the API version --------------------------------------------------------
  // The bug this guards: a hardcoded version string that only the real Stripe
  // can judge, in a file nothing here can point at the real Stripe.
  const stripeLib = require(require('path').join(__dirname, '..', 'shared', 'stripe.js'));
  ok('no API version is pinned unless someone set one',
     stripeLib.apiVersion() === '', stripeLib.apiVersion());

  process.env.STRIPE_API_VERSION = '2026-08-27.basil';
  cap = captureStripe();
  const bogus = await raw('POST', '/api/id/billing/credit', { usd: 25 }, cookie);
  cap.restore();
  delete process.env.STRIPE_API_VERSION;
  ok('a version Stripe does not know fails loudly rather than silently',
     bogus.status >= 400 && /Invalid Stripe API version/.test(JSON.stringify(bogus.json)),
     JSON.stringify(bogus.json));

  process.env.STRIPE_API_VERSION = '2026-08-26.dahlia';
  cap = captureStripe();
  const pinned = await raw('POST', '/api/id/billing/credit', { usd: 25 }, cookie);
  cap.restore();
  delete process.env.STRIPE_API_VERSION;
  ok('...and a real one is accepted, so pinning stays possible',
     pinned.status === 200, JSON.stringify(pinned.json));

  // --- signed out ----------------------------------------------------------
  const out = await raw('POST', '/api/id/billing/membership', {});
  ok('checkout needs an account', out.status === 401, String(out.status));
  const open = await raw('GET', '/api/id/billing');
  ok('...but what it costs is readable signed out', open.status === 200 && open.json.signedIn === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
