// The public preview shows the tool's own output and nothing that is private.
const h = require('./harness.js');
h.install();
process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'friction-secret-abcdefghijklmn'; process.env.APP_PASSWORD = 'friction-pass-12345';
process.env.FIRESTORE_DATABASE_ID = 'friction'; process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test'; process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; process.env.PORT = '9212';
process.env.CRON_SECRET = 'friction-cron-key-123456';
const bag = h.bag('friction');
const P = require('../apps/friction/lib/pulse.js');
const W0 = P.weekStart(new Date());
const weeks = (arr) => arr.map((n, i) => ({ week: P.addWeeks(W0, i - arr.length + 1), n })).filter((w) => w.n);
const mk = (i, extra) => Object.assign({ lensId: 'data-eng', title: 'Problem ' + i, summary: 'Summary ' + i, who: 'Data teams',
  score: 9 - i * 0.5, seenCount: 4 - (i % 3), status: 'new', notes: 'PRIVATE NOTE ' + i,
  evidence: [{ quote: 'VERBATIM QUOTE ' + i, source: 'reddit', url: 'https://x' }], lastSeenAt: '2026-09-20T00:00:00Z' }, extra || {});
for (let i = 0; i < 15; i++) bag.set('signals/data-eng:p' + i, mk(i));
bag.set('signals/data-eng:passed', mk(99, { score: 10, status: 'passed', title: 'PASSED ONE' }));
// The pulse: p0 is spiking (8 this week against about one a week), p1 is
// steady, a weak problem outside the preview's dozen spikes too, and so does
// the passed one. Neither of those two may surface without credentials.
bag.set('signals/data-eng:p0', mk(0, { id: 'data-eng:p0', weekly: weeks([1, 0, 1, 1, 8]), sources: ['hackernews', 'github'], firstSeenAt: '2026-08-01T00:00:00Z' }));
bag.set('signals/data-eng:p1', mk(1, { weekly: weeks([2, 2, 3, 3]) }));
bag.set('signals/data-eng:lowspike', mk(40, { score: 1, title: 'HIDDEN SPIKE', weekly: weeks([0, 0, 0, 0, 9]) }));
bag.set('signals/data-eng:passed', mk(99, { score: 10, status: 'passed', title: 'PASSED ONE', weekly: weeks([0, 0, 0, 0, 9]) }));
const at = new Date(Date.now() - 12 * 60000).toISOString();
bag.set('control/pulse', { updatedAt: at, items: [
  { at, signalId: 'data-eng:p0', title: 'Problem 0', lensId: 'data-eng', itemId: 'hn:1', source: 'hackernews', excerpt: 'PULSE EXCERPT 0', url: 'https://news.ycombinator.com/item?id=1' },
  { at, signalId: 'data-eng:lowspike', title: 'HIDDEN SPIKE', lensId: 'data-eng', itemId: 'gh:2', source: 'github', excerpt: 'PULSE EXCERPT HIDDEN', url: 'https://github.com/x/y/issues/2' },
  { at, signalId: 'data-eng:passed', title: 'PASSED ONE', lensId: 'data-eng', itemId: 'as:3', source: 'appstore', excerpt: 'PULSE EXCERPT PASSED', url: '' },
] });
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

  // ---- the pulse, in public ----
  const p0 = d.signals.find((x) => x.title === 'Problem 0');
  ok('public cards carry a weekly series', p0 && Array.isArray(p0.pulse.series) && p0.pulse.series.length === P.SERIES_WEEKS, JSON.stringify(p0 && p0.pulse));
  ok('and the spike, with its numbers', p0 && p0.pulse.spike && p0.pulse.spike.sightingsThisWeek === 8 && p0.pulse.spike.ratio >= 3, JSON.stringify(p0 && p0.pulse.spike));
  const p1 = d.signals.find((x) => x.title === 'Problem 1');
  ok('a steady problem is not a spike', p1 && !p1.pulse.spike && p1.pulse.trend.dir === 'flat', JSON.stringify(p1 && p1.pulse));
  ok('the spiking problem outside the dozen is still not on the preview', !/HIDDEN SPIKE/.test(body));

  r = await fetch(B + '/api/public/pulse'); const pp = await r.json(); const ppBody = JSON.stringify(pp);
  ok('the public pulse answers without a session', r.status === 200 && Array.isArray(pp.items), String(r.status));
  ok('it names the preview\'s own problem, with source and time', pp.items.length === 1 && pp.items[0].title === 'Problem 0' && pp.items[0].source === 'hackernews' && pp.items[0].at === at, ppBody);
  ok('no excerpt reaches the public pulse', !/PULSE EXCERPT/.test(ppBody));
  ok('no link to anyone\'s post either', !/ycombinator|github\.com/.test(ppBody));
  ok('no problem outside the preview, and nothing passed', !/HIDDEN SPIKE|PASSED ONE/.test(ppBody));
  ok('the public pulse is cacheable', /max-age/.test(r.headers.get('cache-control') || ''));

  r = await fetch(B + '/api/pulse');
  ok('the full pulse is gated', r.status === 401, String(r.status));

  r = await fetch(B + '/api/spikes'); let sp = await r.json(); let spBody = JSON.stringify(sp);
  ok('/api/spikes answers without a session', r.status === 200 && Array.isArray(sp), String(r.status));
  ok('in public it lists only the preview\'s spiking problem', sp.length === 1 && sp[0].title === 'Problem 0', spBody);
  const keys = sp[0] ? Object.keys(sp[0]).sort().join(',') : '';
  ok('in the agreed shape', keys === 'baseline,firstSeen,hint,id,ratio,sightingsThisWeek,sources,summary,title,url', keys);
  ok('with a baseline, ratio and a hint that needs no model', sp[0] && sp[0].sightingsThisWeek === 8 && sp[0].baseline === 0.75 && sp[0].ratio === 8 && /^Could be an app: /.test(sp[0].hint), spBody);
  ok('its link lands on the preview card', sp[0] && /\/preview#data-eng%3Ap0$/.test(sp[0].url), sp[0] && sp[0].url);
  ok('no quotes, notes or status in it', !/VERBATIM QUOTE|PRIVATE NOTE|PULSE EXCERPT|"status"/.test(spBody));
  ok('the public answer may be cached', /public/.test(r.headers.get('cache-control') || ''));

  r = await fetch(B + '/api/spikes', { headers: { 'X-Cron-Key': 'friction-cron-key-123456' } }); sp = await r.json(); spBody = JSON.stringify(sp);
  ok('with the cron key it reads the whole board', sp.length === 2 && /HIDDEN SPIKE/.test(spBody), spBody.slice(0, 200));
  ok('biggest ratio first', sp[0].ratio >= sp[1].ratio);
  ok('a problem off the preview links to the board, not the preview', /\/#signal=data-eng%3Alowspike$/.test(sp.find((x) => x.title === 'HIDDEN SPIKE').url));
  ok('what Erik passed on is left out even then', !/PASSED ONE/.test(spBody));
  ok('the full answer is never cached', /no-store/.test(r.headers.get('cache-control') || ''));
  r = await fetch(B + '/api/spikes', { headers: { 'X-Cron-Key': 'wrong-key-wrong-key-1234' } }); sp = await r.json();
  ok('a wrong key gets the public answer, not an error', r.status === 200 && sp.length === 1, JSON.stringify(sp).slice(0, 120));

  r = await fetch(B + '/preview', { headers: { accept: 'text/html' } }); const ph = await r.text();
  ok('the preview page has the pulse strip and spiking section', /id="pulseStrip"/.test(ph) && /id="spiking"/.test(ph));
  ok('the preview polls only while visible', /visibilitychange/.test(ph) && /document\.hidden/.test(ph));

  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
