// One account, five apps: does a session minted once open all of them?
//
// The complaint this suite was written for was "the owner still cannot run
// Claude features across all apps", and the honest answer was that nobody
// could say which app was refusing him. Each app carries its own gate - a
// research allowlist here, an aiAccess flag there - and they are wired to the
// shared record by different routes. So assert it directly: mint ONE session
// the way a sign-in on any sibling does, then knock on every app's most
// expensive door with it.
//
// Every app is booted in this one process, sequentially, because each reads
// its database id and port from the environment AT REQUIRE TIME. Swapping the
// environment between requires is what lets four servers with four databases
// share a process - and the shared in-memory Firestore underneath is exactly
// what makes the cross-app claim testable at all.
const path = require('path');
const h = require('./harness.js');
h.install();

const SECRET = 'identity-secret-abcdefghijklmn';
const OWNER = 'owner@example.com';
const uid = Buffer.from(OWNER).toString('base64url');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };

/** The owner's record, shaped exactly like the live one: admin true, and the
 *  per-app grants the domain admin panel writes. */
h.bag('identity').set('users/' + uid, {
  email: OWNER,
  admin: true,
  access: { 'trip-planner': 'member', dataviz: 'pro', friction: 'member', football: 'research' },
  createdAt: new Date().toISOString(),
});

const cookie = h.session(SECRET, OWNER);

/** Boot one app with its own environment, and wait for its port. */
async function boot(file, env) {
  Object.assign(process.env, {
    IDENTITY_SESSION_SECRET: SECRET,
    IDENTITY_DATABASE_ID: 'identity',
    GOOGLE_CLOUD_PROJECT: 'test',
    PASSKEY_RP_ID: 'strongtechnicalconsulting.com',
    ...env,
  });
  require(file);
  const base = 'http://127.0.0.1:' + env.PORT;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/health'); return base; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return base;
}

/** A gate refuses with 401 (who are you) or 403 (not you). Anything else -
 *  including the 400s and 404s a deliberately empty body earns - means the
 *  gate let the request through, which is all this suite is asking. */
const passedTheGate = (status) => status !== 401 && status !== 403;

(async () => {
  /* ---------- trip planner: chat on a trip ---------- */
  let base = await boot(path.join('/home/user/trip-planner', 'server.js'), {
    PORT: '9401', FIRESTORE_DATABASE_ID: 'trip-planner', SESSION_SECRET: 'trip-secret-abcdefghijk',
    ADMIN_EMAIL: 'someone-else@example.com',   // deliberately NOT the owner
  });

  let r = await fetch(base + '/api/auth/me', { headers: { cookie } });
  let me = await r.json();
  ok('trip planner knows the shared session', me.signedIn !== false && me.email === OWNER, JSON.stringify(me).slice(0, 120));
  ok('...and reads AI access off the shared record, not its own ADMIN_EMAIL',
     me.aiAccess === 'approved', JSON.stringify(me.aiAccess));

  h.bag('trip-planner').set('trips/t1', { name: 'T', ownerId: uid, status: 'planning' });
  r = await fetch(base + '/api/trips/t1/chat', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ question: 'hi' }) });
  ok('trip chat is not refused to the owner', passedTheGate(r.status), String(r.status));

  /* ---------- football: research ---------- */
  base = await boot(path.join('/home/user/college-football-app', 'server.js'), {
    PORT: '9402', FIRESTORE_DATABASE_ID: 'college-football-app', SESSION_SECRET: 'cfb-secret-abcdefghijk',
    SITE_LOGIN_USERNAME: 'x', SITE_LOGIN_PASSWORD: 'y',
    RESEARCH_ALLOWED_EMAILS: '',   // deliberately empty: the shared grant must carry it
  });
  r = await fetch(base + '/api/chat', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ message: 'hi' }) });
  ok('football research is not refused to the owner', passedTheGate(r.status), String(r.status));

  /* ---------- friction: the scan ---------- */
  base = await boot(path.join(__dirname, '..', 'apps', 'friction', 'server.js'), {
    PORT: '9403', FIRESTORE_DATABASE_ID: 'friction', SESSION_SECRET: 'friction-secret-abcdefghijk',
  });
  r = await fetch(base + '/api/cron/scan', { method: 'POST', headers: { ...J, cookie }, body: '{}' });
  ok('friction scan is not refused to the owner', passedTheGate(r.status), String(r.status));

  /* ---------- dataviz: own data rather than the samples ---------- */
  base = await boot(path.join(__dirname, '..', 'apps', 'dataviz', 'server.js'), {
    PORT: '9404', FIRESTORE_DATABASE_ID: 'dataviz', SESSION_SECRET: 'dataviz-secret-abcdefghijk',
    STRIPE_SECRET_KEY: 'sk_test_dummy_not_called', STRIPE_MEMBER_PRICE_ID: 'price_member_dummy',
  });
  r = await fetch(base + '/api/auth/me', { headers: { cookie } });
  me = await r.json();
  ok('dataviz treats the owner as paid', me.paid === true, JSON.stringify(me).slice(0, 140));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
