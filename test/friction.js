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

  // ---- the pulse: pure maths first, with a fixed clock ----
  const P = require('../apps/friction/lib/pulse.js');
  const NOW = new Date('2026-09-24T15:00:00Z');               // a Thursday
  ok('weeks start on Monday, UTC', P.weekStart(NOW) === '2026-09-21' && P.weekStart('2026-09-21T00:00:00Z') === '2026-09-21' && P.weekStart('2026-09-20T23:59:59Z') === '2026-09-14');
  ok('a bad date has no week', P.weekStart('nonsense') === null && P.weekStart(null) === null);
  let wk = P.bumpWeekly([], NOW, 2);
  wk = P.bumpWeekly(wk, '2026-09-25T06:15:00Z', 3);
  wk = P.bumpWeekly(wk, '2026-09-14T06:15:00Z', 1);
  ok('bumps add up within a week and sort by week', JSON.stringify(wk) === JSON.stringify([{ week: '2026-09-14', n: 1 }, { week: '2026-09-21', n: 5 }]), JSON.stringify(wk));
  let many = [];
  for (let i = 0; i < 20; i++) many = P.bumpWeekly(many, new Date(Date.UTC(2026, 0, 5 + 7 * i)), 1);
  ok('the rollup keeps only the newest weeks', many.length === P.WEEKS_KEPT && many[many.length - 1].week === '2026-05-18', JSON.stringify(many.slice(-1)));
  ok('bumping by nothing adds no week', P.bumpWeekly([], NOW, 0).length === 0);
  ok('the series is zero-filled, oldest first, ending this week', JSON.stringify(P.seriesOf(wk, NOW)) === JSON.stringify([0, 0, 0, 0, 0, 0, 1, 5]));
  ok('legacy rows get a lower-bound history', JSON.stringify(P.weeklyOf({ firstSeenAt: '2026-09-01T00:00:00Z', lastSeenAt: '2026-09-22T00:00:00Z', seenCount: 6 })) === JSON.stringify([{ week: '2026-08-31', n: 1 }, { week: '2026-09-21', n: 1 }]));
  ok('...and one week when first and last share it', P.weeklyOf({ firstSeenAt: '2026-09-22T00:00:00Z', lastSeenAt: '2026-09-23T00:00:00Z' }).length === 1);

  const T = (series, firstSeenAt) => P.trend(series, { firstSeenAt, now: NOW });
  ok('up by a percentage once the base is real', T([0, 4, 6]).dir === 'up' && T([0, 4, 6]).label === '+50%' && T([0, 4, 6]).pct === 50, JSON.stringify(T([0, 4, 6])));
  ok('down by a percentage', T([5, 4, 3]).dir === 'down' && T([5, 4, 3]).label === '−25%');
  ok('1 -> 5 is "+4", never "+400%"', T([0, 1, 5]).label === '+4' && T([0, 1, 5]).pct === null, JSON.stringify(T([0, 1, 5])));
  ok('from nothing, a problem first seen this week is "new"', T([0, 0, 5], '2026-09-22T06:15:00Z').label === 'new');
  ok('from nothing, an older problem is "back"', T([2, 0, 3], '2026-08-01T00:00:00Z').label === 'back');
  ok('equal weeks are steady', T([1, 3, 3]).dir === 'flat');
  ok('two quiet weeks draw no arrow', T([4, 0, 0]).dir === 'none' && T([4, 0, 0]).label === '');

  let sp = P.spikeOf([1, 1, 1, 1, 6]);
  ok('6 against 1 a week is a spike at 6x', sp.spiking && sp.ratio === 6 && sp.baseline === 1 && sp.sightingsThisWeek === 6, JSON.stringify(sp));
  sp = P.spikeOf([2, 2, 2, 2, 5]);
  ok('5 against 2 a week (2.5x) is not', !sp.spiking && sp.ratio === 2.5, JSON.stringify(sp));
  sp = P.spikeOf([0, 0, 0, 0, 3]);
  ok('3 from nothing is under the floor', !sp.spiking && sp.ratio === 3, JSON.stringify(sp));
  sp = P.spikeOf([0, 0, 0, 0, 7]);
  ok('7 from nothing is a spike with a finite ratio', sp.spiking && sp.ratio === 7 && Number.isFinite(sp.ratio));
  sp = P.spikeOf([9]);
  ok('a short series counts the missing weeks as zeros', sp.spiking && sp.baseline === 0);
  ok('annotate puts it together', (() => { const a = P.annotate({ weekly: [{ week: '2026-09-14', n: 1 }, { week: '2026-09-21', n: 8 }], firstSeenAt: '2026-09-15T00:00:00Z' }, NOW); return a.spike.spiking && a.trend.label === '+7' && a.series.length === P.SERIES_WEEKS; })());

  const hint = P.appHint({ title: 'Reconciling three payment processors by hand every month', who: 'Finance ops at mid-size merchants.' });
  ok('the app hint names a kind of tool, who, and the problem', /^Could be an app: a reconciliation tool for finance ops at mid-size merchants that takes on “reconciling three payment processors/.test(hint), hint);
  ok('the hint has a sane fallback and length', /a focused tool/.test(P.appHint({ title: 'Nobody likes Mondays' })) && P.appHint({ title: 'x'.repeat(500), who: 'y'.repeat(500) }).length <= 200);
  ok('"information" does not make it a converter', !/converter/.test(P.appHint({ title: 'Information overload in standups' })));

  const sights = P.sightingsFrom({ signalId: 'l:s', title: 'T', lensId: 'l', lensLabel: 'L', when: NOW.toISOString(),
    evidence: [{ itemId: 'hn:1', quote: 'a' }, { itemId: 'hn:1', quote: 'b' }, { itemId: 'as:9', quote: 'c'.repeat(400) }],
    itemsById: new Map([['hn:1', { permalink: 'https://news.ycombinator.com/item?id=1' }], ['as:9', { url: 'javascript:alert(1)' }]]) });
  ok('one sighting per distinct source item', sights.length === 2 && sights[0].source === 'hackernews' && sights[1].source === 'appstore');
  ok('excerpts are trimmed', sights[1].excerpt.length <= P.EXCERPT_MAX);
  ok('only https links survive', sights[0].url.startsWith('https://') && sights[1].url === '');
  const merged = P.mergePulse([{ at: '2026-09-01T00:00:00Z' }], sights, 2);
  ok('the feed is newest first and capped', merged.length === 2 && merged[0].at === NOW.toISOString());

  // ---- a scan writes the rollup and the feed, inside its own request ----
  const fbag = h.bag('friction');
  const sources = require('../apps/friction/lib/sources.js');
  const scoreLib = require('../apps/friction/lib/score.js');
  const scanLib = require('../apps/friction/lib/scan.js');
  const origHarvest = sources.harvest, origScore = scoreLib.scoreItems;
  sources.harvest = async () => ({ errors: [], probes: [], items: [
    { id: 'hn:101', source: 'hackernews', url: 'https://example.com/a', permalink: 'https://news.ycombinator.com/item?id=101', title: 't', text: 'x' },
    { id: 'gh:202', source: 'github', url: 'https://github.com/o/r/issues/1', permalink: 'https://github.com/o/r/issues/1', title: 't', text: 'x' },
  ] });
  scoreLib.scoreItems = async (items) => ({ errors: [], examined: items.length, skipped: 0, problems: [{
    slug: 'pulse-test', title: 'Reconciling <b>processors</b> by hand', summary: 's', who: 'Finance ops', existingTools: 'none named', angle: 'a',
    scores: { frequency: 5, intensity: 5, budget: 5, feasibility: 5, whitespace: 5 }, score: 5,
    evidence: [{ itemId: 'hn:101', quote: 'We reconcile <script>x</script> by hand' }, { itemId: 'gh:202', quote: 'Every month, by hand' }] }] });
  const sum = await scanLib.runScan({ scope: 'data-eng' });
  let doc = fbag.get('signals/data-eng:pulse-test');
  ok('a new problem starts its weekly rollup at its sightings', doc && JSON.stringify(doc.weekly) === JSON.stringify([{ week: P.weekStart(new Date()), n: 2 }]), JSON.stringify(doc && doc.weekly));
  let feed = fbag.get('control/pulse');
  ok('the scan writes the pulse feed, one entry per item', feed && feed.items.length === 2 && sum.sightings === 2, JSON.stringify(feed).slice(0, 200));
  ok('each entry links back to its post', feed.items.some((e) => e.url === 'https://news.ycombinator.com/item?id=101'));
  // run again with new items: the rollup adds, the feed prepends
  sources.harvest = async () => ({ errors: [], probes: [], items: [{ id: 'hn:303', source: 'hackernews', url: 'https://example.com/b', permalink: 'https://news.ycombinator.com/item?id=303', title: 't', text: 'x' }] });
  scoreLib.scoreItems = async (items) => ({ errors: [], examined: 1, skipped: 0, problems: [{
    slug: 'pulse-test', title: 'x', summary: 's', who: 'w', existingTools: 'e', angle: 'a',
    scores: { frequency: 5, intensity: 5, budget: 5, feasibility: 5, whitespace: 5 }, score: 5,
    evidence: [{ itemId: 'hn:303', quote: 'Again, by hand' }] }] });
  await scanLib.runScan({ scope: 'data-eng' });
  doc = fbag.get('signals/data-eng:pulse-test'); feed = fbag.get('control/pulse');
  ok('a second sighting adds to this week', doc.weekly.length === 1 && doc.weekly[0].n === 3 && doc.seenCount === 2, JSON.stringify(doc.weekly));
  ok('and lands first in the feed', feed.items.length === 3 && feed.items[0].itemId === 'hn:303');
  // a legacy row with no rollup keeps its reconstructed history
  fbag.set('signals/data-eng:legacy', { lensId: 'data-eng', slug: 'legacy', title: 'Legacy', status: 'new', notes: 'keep me', seenCount: 4,
    firstSeenAt: '2026-06-01T00:00:00Z', lastSeenAt: '2026-06-20T00:00:00Z', evidence: [] });
  await scanLib.upsertSignal({ id: 'data-eng', label: 'Data' }, { slug: 'legacy', title: 'Legacy', summary: 's', who: 'w', existingTools: 'e', angle: 'a',
    scores: {}, score: 4, evidence: [{ itemId: 'hn:404', quote: 'q' }] }, 'run-x');
  doc = fbag.get('signals/data-eng:legacy');
  ok('a legacy row gains a rollup without losing its first weeks', doc.weekly.length === 3 && doc.weekly[0].week === '2026-06-01' && doc.notes === 'keep me', JSON.stringify(doc.weekly));
  sources.harvest = origHarvest; scoreLib.scoreItems = origScore;

  // ---- the board draws it ----
  fbag.set('signals/data-eng:spiky', { lensId: 'data-eng', lensLabel: 'Data', title: 'Spiky one', who: 'w', summary: 'Tracking approvals by hand', status: 'digging', score: 3, seenCount: 5,
    firstSeenAt: '2026-07-01T00:00:00Z', lastSeenAt: new Date().toISOString(),
    weekly: [1, 1, 0, 1, 9].map((n, i) => ({ week: P.addWeeks(P.weekStart(new Date()), i - 4), n })) });
  r = await fetch(B + '/api/signals', { headers: { cookie: appCookie } });
  let board = await r.json();
  ok('every board row carries its trend', board.signals.every((x) => x.pulse && x.pulse.trend && Array.isArray(x.pulse.series)));
  ok('the board lists what is spiking, with a hint', board.spiking.length === 1 && board.spiking[0].id === 'data-eng:spiky' && /^Could be an app/.test(board.spiking[0].hint), JSON.stringify(board.spiking));
  r = await fetch(B + '/api/signals?status=new', { headers: { cookie: appCookie } }); board = await r.json();
  ok('the Spiking list does not depend on the status filter', board.spiking.length === 1 && !board.signals.some((x) => x.id === 'data-eng:spiky'));
  r = await fetch(B + '/api/pulse', { headers: { cookie: appCookie } }); let pl = await r.json();
  ok('the board\'s pulse carries excerpts', r.status === 200 && pl.items[0].excerpt === 'Again, by hand' && !pl.fallback, JSON.stringify(pl).slice(0, 200));
  ok('and is never cached', /no-store/.test(r.headers.get('cache-control') || ''));
  fbag.delete('control/pulse');
  r = await fetch(B + '/api/pulse', { headers: { cookie: appCookie } }); pl = await r.json();
  ok('before any scan writes it, the newest quote per problem stands in', pl.fallback === true && pl.items.length >= 1 && pl.items[0].signalId, JSON.stringify(pl).slice(0, 200));
  r = await fetch(B + '/api/spikes', { headers: { cookie: appCookie } }); const spk = await r.json();
  ok('a signed-in /api/spikes sees the whole board', spk.some((x) => x.id === 'data-eng:spiky'), JSON.stringify(spk).slice(0, 200));
  r = await get('/', appCookie); const page = await r.text();
  ok('the board page has the pulse strip and Spiking section', /id="pulseStrip"/.test(page) && /id="spiking"/.test(page));
  ok('it stops polling while hidden', /visibilitychange/.test(page) && /stopPulse/.test(page));

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})();
