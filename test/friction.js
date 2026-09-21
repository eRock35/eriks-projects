const h = require('./harness.js');
h.install();
const SECRET = 'identity-secret-abcdefghijklmn';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = 'friction-secret-abcdefghijklm';
process.env.APP_PASSWORD = 'friction-password-1';
process.env.FIRESTORE_DATABASE_ID = 'friction';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.PORT = '9201';
require(require('path').join(__dirname, '..', 'apps', 'friction', 'server.js'));

const B = 'http://127.0.0.1:9201';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const get = (p, cookie, accept = 'text/html') => fetch(B + p, { headers: cookie ? { cookie, accept } : { accept }, redirect: 'manual' });

(async () => {
  await new Promise((r) => setTimeout(r, 800));

  // register a plain account through identity, on this app
  let r = await fetch(B + '/api/id/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com', password: 'a-long-password-1' }) });
  ok('anyone can register (identity is open)', r.status === 200, String(r.status));
  const plain = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

  // anonymous
  r = await get('/');
  ok('anonymous is sent to the login page', r.status === 302 && r.headers.get('location') === '/login', r.status + ' ' + r.headers.get('location'));

  // signed in but NOT entitled - the case that matters
  r = await get('/', plain);
  ok('a registered account with no grant is refused 403', r.status === 403, String(r.status));
  const body = await r.text();
  ok('it explains rather than bouncing to login', /invite-only/i.test(body) && /ask for access/i.test(body), body.slice(0, 160));
  ok('it names who is signed in', /nobody@example\.com/.test(body));
  r = await fetch(B + '/api/board', { headers: { cookie: plain, accept: 'application/json' } });
  ok('the API refuses it too, as JSON', r.status === 403, String(r.status));

  // grant access, then retry
  const users = h.bag('identity');
  const uid = Buffer.from('nobody@example.com').toString('base64url');
  const rec = users.get('users/' + uid);
  users.set('users/' + uid, { ...rec, access: { friction: 'member' } });
  r = await get('/', plain);
  ok('once granted, the same session walks in', r.status === 200, String(r.status));

  // the grant is per app: it must not imply anything elsewhere
  users.set('users/' + uid, { ...rec, access: { dataviz: 'pro' } });
  r = await get('/', plain);
  ok('a grant for a DIFFERENT app does not open this one', r.status === 403, String(r.status));

  // the app password still works as the second door
  r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'friction-password-1' }) });
  const appCookie = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  ok('the app password still signs in', r.status === 200, String(r.status));
  r = await get('/', appCookie);
  ok('the app-password session still opens the app', r.status === 200, String(r.status));

  // analytics stays reachable for everyone
  r = await fetch(B + '/analytics.js');
  ok('/analytics.js is still ungated', r.status === 200);

  // the denial is recorded
  const events = [...h.bag('identity').entries()].filter(([k]) => k.startsWith('events/')).map(([, v]) => v);
  ok('the refusal is in the audit log', events.some((e) => e.kind === 'access.denied' && e.ok === false), JSON.stringify(events.map((e) => e.kind)));

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})();
