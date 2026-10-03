// The iPhone apps' association file on the apex (mobile/README.md). The apex
// is the shared account's passkey relying party, so this is what lets Face ID
// sign-in work inside each app's web view. Apple fetches it with no cookie and
// follows no redirect, so:
//  - no APPLE_TEAM_ID, or a malformed one: 404, so nothing wrong is published;
//  - set: 200 application/json on the apex, on www (no 301 - /.well-known/ is
//    exempt from the canonical-host redirect) and on the account host;
//  - webcredentials for all five apps, and no applinks: the landing is not an app;
//  - the Team ID is read per request, so a revision's env is all it takes.
// Raw http so the Host header can be chosen and a redirect is not followed.
const h = require('./harness.js');
h.install();
const http = require('http');

const PORT = 9261;
const APEX = 'strongtechnicalconsulting.com';
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'landing-secret-abcdefghijklm',
  ADMIN_PASSWORD: 'admin-password-here-1', FIRESTORE_DATABASE_ID: 'eriks-projects', IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test', PASSKEY_RP_ID: APEX, PORT: String(PORT), SITE_ORIGIN: 'https://www.' + APEX,
});
delete process.env.APPLE_TEAM_ID;
require(require('path').join(__dirname, '..', 'server.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const PATH = '/.well-known/apple-app-site-association';

function get(path, host = APEX) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { Host: host, 'X-Forwarded-Proto': 'https' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  for (let i = 0; i < 50; i++) {
    try { if ((await get('/api/health')).status === 200) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  let r = await get(PATH);
  ok('no APPLE_TEAM_ID: 404', r.status === 404, r.status);
  for (const bad of ['abcde12345', 'ABCDE1234', 'ABCDE12345X', 'ABCDE-1234']) {
    process.env.APPLE_TEAM_ID = bad;
    r = await get(PATH);
    ok(`a malformed Team ID (${bad}): 404`, r.status === 404, r.status);
  }

  process.env.APPLE_TEAM_ID = 'ABCDE12345';
  const apps = ['trip', 'hopscotch', 'flight', 'insidejoke', 'football'].map((a) => `ABCDE12345.com.strongtechnicalconsulting.${a}`);
  for (const host of [APEX, 'www.' + APEX, 'acct.' + APEX]) {
    r = await get(PATH, host);
    ok(`${host}: 200, not a redirect`, r.status === 200, `${r.status} ${r.headers.location || ''}`);
    ok(`${host}: application/json`, /^application\/json\b/.test(r.headers['content-type'] || ''), r.headers['content-type']);
    ok(`${host}: no cookie`, !r.headers['set-cookie'], r.headers['set-cookie']);
    let body = null;
    try { body = JSON.parse(r.text); } catch (e) { /* reported below */ }
    ok(`${host}: webcredentials for all five apps`, body && JSON.stringify(body.webcredentials) === JSON.stringify({ apps }), r.text);
    ok(`${host}: no applinks - the landing is not an app`, body && !('applinks' in body), r.text);
  }

  process.env.APPLE_TEAM_ID = 'ZZZZZ99999';
  r = await get(PATH);
  ok('read per request', r.text.includes('ZZZZZ99999.com.strongtechnicalconsulting.trip'), r.text);

  // The landing's iPhone apps list (shared/get-app.js, list mode).
  const LINK = 'https://testflight.apple.com/join/AbCd1234';
  for (const k of ['TRIP', 'HOPSCOTCH', 'FLIGHT', 'INSIDEJOKE', 'FOOTBALL']) delete process.env['TESTFLIGHT_URL_' + k];
  r = await get('/ios-apps.json');
  ok('no TestFlight links set: 200 with an empty list', r.status === 200 && JSON.parse(r.text).apps.length === 0, r.text);
  process.env.TESTFLIGHT_URL_TRIP = LINK;
  process.env.TESTFLIGHT_URL_HOPSCOTCH = 'https://evil.example/join/AbCd1234';
  process.env.TESTFLIGHT_URL_FLIGHT = 'http://testflight.apple.com/join/AbCd1234';
  process.env.TESTFLIGHT_URL_INSIDEJOKE = LINK + '?x=<b>';
  r = await get('/ios-apps.json');
  const listed = JSON.parse(r.text).apps;
  ok('only an exact TestFlight public link is listed', listed.length === 1 && listed[0].name === 'Trip Planner' && listed[0].url === LINK, r.text);
  ok('the list carries no cookie', !r.headers['set-cookie'], r.headers['set-cookie']);
  for (const k of ['TRIP', 'HOPSCOTCH', 'FLIGHT', 'INSIDEJOKE', 'FOOTBALL']) delete process.env['TESTFLIGHT_URL_' + k];
  r = await get('/');
  ok('the landing page loads get-app.js in list mode, hidden until filled',
    r.text.includes('src="/get-app.js" data-src="/ios-apps.json" data-list="#iphoneApps"') && /id="iphoneApps" hidden/.test(r.text));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
