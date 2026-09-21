const h = require('./harness.js');
h.install();
const SECRET = 'identity-secret-abcdefghijklmn';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = 'landing-secret-abcdefghijklm';
process.env.ADMIN_PASSWORD = 'admin-password-here-1';
process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.FIRESTORE_DATABASE_ID = 'eriks-projects';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.PORT = '9205';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9205';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  let r = await post('/api/id/register', { email: 'boss@example.com', password: 'a-long-password-1' });
  const admin = jar(r);
  r = await post('/api/id/register', { email: 'friend@example.com', password: 'a-long-password-2' });
  ok('two accounts exist', r.status === 200);
  const friend = jar(r);
  const friendUid = uidOf('friend@example.com');

  // only the admin may grant
  r = await post('/api/admin/access', { uid: friendUid, app: 'friction', level: 'member' });
  ok('an anonymous grant is refused (404, not advertised)', r.status === 404, String(r.status));
  r = await post('/api/admin/access', { uid: friendUid, app: 'friction', level: 'member' }, friend);
  ok('an ordinary account cannot grant itself access', r.status === 404, String(r.status));

  // the admin can
  r = await post('/api/admin/access', { uid: friendUid, app: 'friction', level: 'member' }, admin);
  ok('the admin can grant', r.status === 200, JSON.stringify(await r.json().catch(() => ({}))));
  let rec = h.bag('identity').get('users/' + friendUid);
  ok('the grant lands on the user record', rec.access && rec.access.friction === 'member', JSON.stringify(rec.access));

  // validation
  r = await post('/api/admin/access', { uid: friendUid, app: 'nonsense', level: 'member' }, admin);
  ok('an unknown app is refused', r.status === 400, String(r.status));
  r = await post('/api/admin/access', { uid: friendUid, app: 'football', level: 'pro' }, admin);
  ok('a level the app does not define is refused', r.status === 400, String(r.status));
  ok('...and explains which app', /football does not define/.test((await r.json()).error || ''));
  r = await post('/api/admin/access', { uid: 'no-such-uid', app: 'friction', level: 'member' }, admin);
  ok('granting to a missing account is a 404', r.status === 404, String(r.status));

  // revoke
  r = await post('/api/admin/access', { uid: friendUid, app: 'friction', level: null }, admin);
  ok('revoking works', r.status === 200);
  rec = h.bag('identity').get('users/' + friendUid);
  ok('and removes the key rather than storing a falsy one', !('friction' in (rec.access || {})), JSON.stringify(rec.access));

  // it shows up on the dashboard feed
  await post('/api/admin/access', { uid: friendUid, app: 'dataviz', level: 'pro' }, admin);
  r = await fetch(B + '/api/admin/insights', { headers: { cookie: admin } });
  const d = await r.json();
  const row = d.users.list.find((u) => u.email === 'friend@example.com');
  ok('the dashboard lists the account with its uid', row && row.uid === friendUid);
  ok('and shows the grant', row.access && row.access.dataviz === 'pro', JSON.stringify(row.access));
  ok('no password record reaches the dashboard', !JSON.stringify(d.users.list).includes('salt'));

  // every change is audited
  const events = [...h.bag('identity').entries()].filter(([k]) => k.startsWith('events/')).map(([, v]) => v);
  const changes = events.filter((e) => e.kind === 'access.changed');
  ok('grants and revokes are all audited', changes.length >= 3, String(changes.length));
  ok('the audit says what changed', changes.some((e) => /dataviz=pro/.test(e.detail || '')) && changes.some((e) => /friction=revoked/.test(e.detail || '')), JSON.stringify(changes.map((e) => e.detail)));

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})();
