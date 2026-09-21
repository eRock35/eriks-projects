// The public preview shows the tool's own output and nothing that is private.
const h = require('./harness.js');
h.install();
process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'friction-secret-abcdefghijklmn'; process.env.APP_PASSWORD = 'friction-pass-12345';
process.env.FIRESTORE_DATABASE_ID = 'friction'; process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test'; process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; process.env.PORT = '9212';
const bag = h.bag('friction');
const mk = (i, extra) => Object.assign({ lensId: 'data-eng', title: 'Problem ' + i, summary: 'Summary ' + i, who: 'Data teams',
  score: 9 - i * 0.5, seenCount: 4 - (i % 3), status: 'new', notes: 'PRIVATE NOTE ' + i,
  evidence: [{ quote: 'VERBATIM QUOTE ' + i, source: 'reddit', url: 'https://x' }], lastSeenAt: '2026-09-20T00:00:00Z' }, extra || {});
for (let i = 0; i < 15; i++) bag.set('signals/data-eng:p' + i, mk(i));
bag.set('signals/data-eng:passed', mk(99, { score: 10, status: 'passed', title: 'PASSED ONE' }));
require(require('path').join(__dirname, '..', 'apps', 'friction', 'server.js'));
const B = 'http://127.0.0.1:9212';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
(async () => {
  await new Promise((r) => setTimeout(r, 900));
  let r = await fetch(B + '/preview', { headers: { accept: 'text/html' }, redirect: 'manual' });
  const html = await r.text();
  ok('/preview is served without a session', r.status === 200 && /What keeps coming back/.test(html), String(r.status));
  r = await fetch(B + '/api/public/board'); const d = await r.json(); const body = JSON.stringify(d);
  ok('the public board answers without a session', r.status === 200 && Array.isArray(d.signals), String(r.status));
  ok('it is capped', d.signals.length === 12, String(d.signals.length));
  ok('strongest first', d.signals[0].score >= d.signals[1].score);
  ok('no evidence quotes leak', !/VERBATIM QUOTE/.test(body));
  ok('no private notes leak', !/PRIVATE NOTE/.test(body));
  ok('no status leaks', !d.signals.some((s) => 'status' in s));
  ok('passed problems are left out', !/PASSED ONE/.test(body));
  ok('lens ids are turned into labels', d.signals[0].lens === 'Data & analytics', d.signals[0].lens);
  ok('it is cacheable', /max-age/.test(r.headers.get('cache-control') || ''));
  r = await fetch(B + '/api/signals');
  ok('the real board is still gated', r.status === 401, String(r.status));
  r = await fetch(B + '/', { headers: { accept: 'text/html' }, redirect: 'manual' });
  ok('the app itself still bounces to login', r.status === 302 && /login/.test(r.headers.get('location') || ''), String(r.status));
  ok('frame-ancestors is set', /frame-ancestors[^;]*strongtechnicalconsulting\.com/.test(r.headers.get('content-security-policy') || ''));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
