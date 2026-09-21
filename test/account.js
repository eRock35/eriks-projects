// The account page's own surface: your profile, and leaving.
//
// Deleting an account is the one irreversible thing a signed-in person can do
// here, so the proof standard and the blast radius both get asserted rather
// than described.
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
process.env.PASSKEY_RP_ID = 'strongtechnicalconsulting.com';
process.env.PORT = '9206';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9206';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const send = (method, p, b, c) => fetch(B + p, { method, headers: c ? { ...J, cookie: c } : J, body: b === undefined ? undefined : JSON.stringify(b) });
const post = (p, b, c) => send('POST', p, b, c);
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');

/** GET a path with an arbitrary Host header. */
function rawGet(path, host) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port: 9206, path, method: 'GET', headers: { Host: host, Accept: 'text/html' } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); },
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  /* ---------- the page ---------- */
  let r = await fetch(B + '/account', { headers: { Accept: 'text/html' } });
  ok('the account page is served', r.status === 200, String(r.status));
  let html = await r.text();
  ok('...and it is the account page', /Your account/i.test(html), html.slice(0, 80));

  // On the account subdomain the page IS the site, so acct.<domain>/ is not
  // the landing page. Host-scoped, so the apex is untouched - which is the
  // half worth asserting, since getting it wrong replaces the marketing site
  // with an account form.
  // Raw http, because fetch refuses to let a caller set Host - and Host is
  // the entire thing under test.
  html = await rawGet('/', 'acct.strongtechnicalconsulting.com');
  ok('acct.<domain>/ serves the account page', /Your account/i.test(html), html.slice(0, 80));
  html = await (await fetch(B + '/', { headers: { Accept: 'text/html' } })).text();
  ok('...and the apex still serves the landing page', !/Your account/i.test(html), html.slice(0, 80));

  /* ---------- profile ---------- */
  r = await post('/api/id/register', { email: 'leaver@example.com', password: 'a-long-password-1' });
  ok('an account registers', r.status === 200, String(r.status));
  const cookie = jar(r);
  const uid = uidOf('leaver@example.com');

  r = await post('/api/id/profile', { displayName: '  Dana Q  ' }, cookie);
  ok('a display name saves', r.status === 200, String(r.status));
  let me = await (await fetch(B + '/api/id/me', { headers: { cookie } })).json();
  ok('...trimmed, and reported back', me.displayName === 'Dana Q', JSON.stringify(me.displayName));

  r = await post('/api/id/profile', { displayName: 'x' });
  ok('a stranger cannot rename someone', r.status === 401, String(r.status));

  /* ---------- deleting ---------- */
  r = await send('DELETE', '/api/id/account', {}, cookie);
  ok('deleting without the password is refused', r.status === 403, String(r.status));
  ok('...and the account is still there', Boolean(h.bag('identity').get('users/' + uid)));

  r = await send('DELETE', '/api/id/account', { password: 'not-the-password' }, cookie);
  ok('a wrong password is refused too', r.status === 403, String(r.status));

  // A passkey belonging to this account, and one belonging to someone else.
  h.bag('identity').set('webauthn-credentials/c1', { id: 'c1', ownerId: uid, label: 'Face ID' });
  h.bag('identity').set('webauthn-credentials/c2', { id: 'c2', ownerId: 'someone-else', label: 'Theirs' });

  r = await send('DELETE', '/api/id/account', { password: 'a-long-password-1' }, cookie);
  const body = await r.json();
  ok('the right password deletes it', r.status === 200, String(r.status));
  ok('...and says how many passkeys went with it', body.passkeysRemoved === 1, JSON.stringify(body));
  ok('the record is gone', !h.bag('identity').get('users/' + uid));
  ok('...their passkey is gone', !h.bag('identity').get('webauthn-credentials/c1'));
  ok("...and nobody else's was touched", Boolean(h.bag('identity').get('webauthn-credentials/c2')));

  // The session cookie is cleared, and there is no record behind it anyway.
  me = await (await fetch(B + '/api/id/me', { headers: { cookie } })).json();
  ok('the old session no longer signs anyone in', me.signedIn === false, JSON.stringify(me));

  // Leaving must not lock the address out - the record is removed rather than
  // tombstoned exactly so this works.
  r = await post('/api/id/register', { email: 'leaver@example.com', password: 'a-different-one-2' });
  ok('the address can register again afterwards', r.status === 200, String(r.status));

  /* ---------- a passkey session may leave without a password ---------- */
  const passkeyCookie = h.session(SECRET, 'leaver@example.com', 'passkey');
  r = await send('DELETE', '/api/id/account', {}, passkeyCookie);
  ok('a Face ID session is proof enough on its own', r.status === 200, String(r.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
