const h = require('./harness.js');
h.install();
const SECRET = 'identity-secret-abcdefghijklmn';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = 'dataviz-secret-abcdefghijklmn';
process.env.FIRESTORE_DATABASE_ID = 'dataviz';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
// Without these, stripe.enabled() is false and isPro() short-circuits to true
// so the app is usable on a deployment with no billing. Production HAS
// billing, so set them and test what production actually does.
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_not_called';
process.env.STRIPE_PRICE_ID = 'price_dummy_not_called';
process.env.PORT = '9202';
require(require('path').join(__dirname, '..', 'apps', 'dataviz', 'server.js'));

const B = 'http://127.0.0.1:9202';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

(async () => {
  await new Promise((r) => setTimeout(r, 800));

  // The UI's own URLs must still work after moving auth to identity.
  let r = await post('/api/auth/register', { email: 'Viz@Example.com', password: 'a-long-password-1' });
  ok('register at the UI\'s existing URL', r.status === 200, String(r.status));
  const cookie = jar(r);
  ok('it sets the SHARED cookie, not a dataviz-only one', /stc_session=/.test(cookie), cookie.slice(0, 40));

  r = await fetch(B + '/api/auth/me', { headers: { cookie } });
  let me = await r.json();
  ok('/api/auth/me still reports plan (this app\'s business)', me.plan === 'free', JSON.stringify(me));
  ok('and reports the signed-in address', me.email === 'viz@example.com');

  // Saving a project - the thing an account exists for
  r = await post('/api/projects', { title: 'T', viz: { type: 'bars' } }, cookie);
  ok('a signed-in user can save a project', r.status === 200 || r.status === 201, String(r.status));
  const uid = Buffer.from('viz@example.com').toString('base64url');
  const projects = [...h.bag('dataviz').entries()].filter(([k]) => k.startsWith('projects/')).map(([, v]) => v);
  ok('the project is owned by the identity uid', projects.length === 1 && projects[0].ownerId === uid, JSON.stringify(projects.map(p => p.ownerId)));

  r = await fetch(B + '/api/projects', { headers: { cookie } });
  const mine = await r.json();
  ok('and it reads back as theirs', Array.isArray(mine.projects ? mine.projects : mine) && JSON.stringify(mine).includes('"T"'), JSON.stringify(mine).slice(0, 120));
  r = await fetch(B + '/api/projects');
  ok('anonymous cannot list projects', r.status === 401, String(r.status));

  // THE POINT: a session minted on another app opens this one
  const fromFriction = h.session(SECRET, 'viz@example.com');
  r = await fetch(B + '/api/projects', { headers: { cookie: fromFriction } });
  ok('a session from a SIBLING app is accepted here', r.status === 200, String(r.status));

  // Pro can be granted by the admin, not only bought
  const users = h.bag('identity');
  const rec = users.get('users/' + uid);
  r = await fetch(B + '/api/auth/me', { headers: { cookie } });
  ok('plan is free before any grant', (await r.json()).plan === 'free');
  users.set('users/' + uid, { ...rec, access: { dataviz: 'pro' } });
  r = await fetch(B + '/api/auth/me', { headers: { cookie } });
  ok('an admin grant makes them pro without Stripe', (await r.json()).plan === 'pro');
  // and Stripe's own flag still works independently
  users.set('users/' + uid, rec);
  h.bag('dataviz').set('users/' + uid, { plan: 'pro', stripeCustomerId: 'cus_x' });
  r = await fetch(B + '/api/auth/me', { headers: { cookie } });
  ok('a Stripe subscription still makes them pro', (await r.json()).plan === 'pro');
  h.bag('dataviz').delete('users/' + uid);

  // password change at the UI's URL
  r = await post('/api/auth/password', { current: 'wrong-one-here', next: 'brand-new-password' }, cookie);
  ok('a wrong current password is refused', r.status === 401, String(r.status));
  r = await post('/api/auth/password', { current: 'a-long-password-1', next: 'brand-new-password' }, cookie);
  ok('the right one changes it', r.status === 200, String(r.status));
  r = await post('/api/auth/login', { email: 'viz@example.com', password: 'a-long-password-1' });
  ok('the old password stops working', r.status === 401);
  r = await post('/api/auth/login', { email: 'viz@example.com', password: 'brand-new-password' });
  ok('the new one works', r.status === 200);

  // the reset flow must read the identity record, not this app's billing record
  const reset = require('/home/user/eriks-projects/apps/dataviz/lib/reset.js');
  const cur = users.get('users/' + uid);
  const token = reset.makeToken(uid, cur.password.hash);
  r = await post('/api/auth/reset/complete', { token, password: 'reset-password-here' });
  ok('a valid reset token sets the password', r.status === 200, JSON.stringify(await r.json().catch(() => ({}))));
  r = await post('/api/auth/login', { email: 'viz@example.com', password: 'reset-password-here' });
  ok('the reset password signs in', r.status === 200);
  r = await post('/api/auth/reset/complete', { token, password: 'again-another-one' });
  ok('the SAME token cannot be replayed', r.status === 400, String(r.status));

  // samples still cost nothing and need no account
  r = await fetch(B + '/api/datasets');
  ok('the sample datasets are still open to anyone', r.status === 200);

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})();
