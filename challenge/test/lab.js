// The lab host: mounts apps, votes change rather than stack, notes are private.
process.env.LAB_MEMORY = '1';
const assert = require('assert');
const http = require('http');
const { host, mounted } = require('../server');

(async () => {
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('lab_vid')) cookie = sc.split(';')[0];
    return { status: r.status, headers: r.headers, data: await r.json().catch(() => null) };
  };
  let n = 0;
  const ok = (name) => { n++; console.log('  ok  ' + name); };

  assert.ok(mounted.includes('spar')); ok('spar is mounted');
  const cors = await fetch(base + '/api/lab', { headers: { Origin: 'https://www.strongtechnicalconsulting.com', 'Sec-Fetch-Site': 'same-site' } });
  assert.strictEqual(cors.headers.get('access-control-allow-origin'), 'https://www.strongtechnicalconsulting.com');
  const evil = await fetch(base + '/api/lab', { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(evil.headers.get('access-control-allow-origin'), null); ok('only the main site may read the lab cross-origin');
  assert.strictEqual(cors.headers.get('set-cookie'), null); assert.strictEqual(evil.headers.get('set-cookie'), null);
  ok('a cross-origin read (the landing banner) mints no visitor id');
  assert.ok((await cors.json()).apps.every((a) => a.myVote === null)); ok('a visitor with no id has no votes');
  const lab = await call('GET', '/api/lab');
  assert.strictEqual(lab.status, 200); assert.ok(lab.data.apps.length >= 1); ok('lab lists the apps');
  assert.ok(cookie.startsWith('lab_vid=')); ok('the lab page\'s own read mints the visitor id, before anything can be tapped');
  // Two taps before the first reply: both votes must carry one id, or the
  // second Set-Cookie replaces the first and one browser holds two votes.
  const race = await Promise.all([1, 2].map(() => fetch(base + '/api/lab/spar/vote', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ v: 'keep' }),
  })));
  const ids = race.map((x) => (x.headers.get('set-cookie') || cookie).split(';')[0]);
  assert.ok(ids[0].startsWith('lab_vid=')); assert.strictEqual(ids[0], ids[1]); ok('two votes fired at once carry the same lab_vid');
  assert.deepStrictEqual((await call('GET', '/api/lab')).data.apps.find((a) => a.slug === 'spar').votes, { keep: 1, kill: 0 });
  ok('...and count once');
  const r = await call('GET', '/spar');
  assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.get('location'), '/spar/'); ok('/spar redirects to /spar/ so relative assets resolve');
  assert.strictEqual((await call('GET', '/spar/')).status, 200); ok('/spar/ serves the app, not another redirect');
  assert.strictEqual((await call('GET', '/spar?x=1')).headers.get('location'), '/spar/?x=1'); ok('the query survives the redirect');
  assert.strictEqual((await call('GET', '/spar/api/library')).status, 200); ok('an app answers under its mount');
  assert.strictEqual((await call('GET', '/spar/api/health')).data.ok, true); ok('an app health check works under its mount');
  const again = await call('GET', '/api/lab');
  assert.strictEqual(again.data.apps.find((a) => a.slug === 'spar').myVote, 'keep'); ok('a returning voter reads their own vote back');
  assert.deepStrictEqual(again.data.apps.find((a) => a.slug === 'spar').votes, { keep: 1, kill: 0 }); ok('...and the tally');
  let v = await call('POST', '/api/lab/spar/vote', { v: 'keep' });
  assert.deepStrictEqual(v.data.votes, { keep: 1, kill: 0 }); ok('one browser, one vote');
  v = await call('POST', '/api/lab/spar/vote', { v: 'kill' });
  assert.deepStrictEqual(v.data.votes, { keep: 0, kill: 1 }); ok('changing a vote moves it');
  v = await call('POST', '/api/lab/spar/vote', { v: null });
  assert.deepStrictEqual(v.data.votes, { keep: 0, kill: 0 }); ok('a vote can be withdrawn');
  const fresh = await fetch(base + '/api/lab/spar/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: null }) });
  assert.ok(String(fresh.headers.get('set-cookie')).startsWith('lab_vid=')); ok('a vote with no id still mints one');
  assert.strictEqual((await call('POST', '/api/lab/nope/vote', { v: 'keep' })).status, 404); ok('unknown apps 404');
  assert.strictEqual((await call('POST', '/api/lab/spar/vote', { v: 'maybe' })).status, 400); ok('only keep or kill');
  assert.strictEqual((await call('POST', '/api/lab/spar/note', { text: 'zebra-note-4471 please' })).status, 200); ok('notes are accepted');
  assert.ok(!JSON.stringify((await call('GET', '/api/lab')).data).includes('zebra-note-4471')); ok('notes are never published');
  server.close();
  console.log(`\n${n}/${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
