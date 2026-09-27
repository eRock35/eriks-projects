// The lab host: mounts apps, votes change rather than stack, notes are private.
process.env.LAB_MEMORY = '1';
const assert = require('assert');
const http = require('http');
const { host, mounted, store } = require('../server');

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
  // The split is not public any more; read the stored tally itself.
  const tallyOf = async (slug) => { const t = (await store.get('lab_votes', slug)) || {}; return { keep: Math.max(0, t.keep || 0), kill: Math.max(0, t.kill || 0) }; };
  assert.deepStrictEqual((await call('GET', '/api/lab')).data.apps.find((a) => a.slug === 'spar').votes, { total: 1 });
  assert.deepStrictEqual(await tallyOf('spar'), { keep: 1, kill: 0 });
  ok('...and count once');
  const r = await call('GET', '/spar');
  assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.get('location'), '/spar/'); ok('/spar redirects to /spar/ so relative assets resolve');
  assert.strictEqual((await call('GET', '/spar/')).status, 200); ok('/spar/ serves the app, not another redirect');
  assert.strictEqual((await call('GET', '/spar?x=1')).headers.get('location'), '/spar/?x=1'); ok('the query survives the redirect');
  assert.strictEqual((await call('GET', '/spar/api/library')).status, 200); ok('an app answers under its mount');
  assert.strictEqual((await call('GET', '/spar/api/health')).data.ok, true); ok('an app health check works under its mount');
  const again = await call('GET', '/api/lab');
  assert.strictEqual(again.data.apps.find((a) => a.slug === 'spar').myVote, 'keep'); ok('a returning voter reads their own vote back');
  assert.deepStrictEqual(again.data.apps.find((a) => a.slug === 'spar').votes, { total: 1 }); ok('...and the count');
  let v = await call('POST', '/api/lab/spar/vote', { v: 'keep' });
  assert.deepStrictEqual(v.data.votes, { total: 1 }); assert.deepStrictEqual(await tallyOf('spar'), { keep: 1, kill: 0 }); ok('one browser, one vote');
  v = await call('POST', '/api/lab/spar/vote', { v: 'kill' });
  assert.deepStrictEqual(await tallyOf('spar'), { keep: 0, kill: 1 }); ok('changing a vote moves it');
  v = await call('POST', '/api/lab/spar/vote', { v: null });
  assert.deepStrictEqual(v.data.votes, { total: 0 }); assert.deepStrictEqual(await tallyOf('spar'), { keep: 0, kill: 0 }); ok('a vote can be withdrawn');
  assert.strictEqual((await call('POST', '/api/lab/nope/vote', { v: 'keep' })).status, 404); ok('unknown apps 404');
  assert.strictEqual((await call('POST', '/api/lab/spar/vote', { v: 'maybe' })).status, 400); ok('only keep or kill');
  assert.strictEqual((await call('POST', '/api/lab/spar/note', { text: 'zebra-note-4471 please' })).status, 200); ok('notes are accepted');
  assert.ok(!JSON.stringify((await call('GET', '/api/lab')).data).includes('zebra-note-4471')); ok('notes are never published');
  // Every app shares this origin, so every page carries a script CSP (2026-09-27).
  for (const p of ['/', ...mounted.map((s) => `/${s}/`)]) {
    const csp = String((await fetch(base + p)).headers.get('content-security-policy'));
    assert.match(csp, /script-src 'self'/, p); assert.match(csp, /object-src 'none'/, p); assert.match(csp, /base-uri 'self'/, p);
    assert.match(csp, /frame-ancestors 'self' https:\/\/strongtechnicalconsulting\.com/, p);
    assert.ok(!/script-src[^;]*unsafe/.test(csp), `${p}: no unsafe script source`);
  }
  ok(`the lab and all ${mounted.length} apps send script-src 'self', object-src 'none' and base-uri 'self'`);
  // ...and none of their pages has an inline script or handler for it to block.
  const fs = require('fs'); const path = require('path');
  for (const f of [path.join(__dirname, '..', 'public', 'index.html'), ...mounted.map((s) => path.join(__dirname, '..', 'apps', s, 'public', 'index.html'))]) {
    const html = fs.readFileSync(f, 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${f}: inline <script>`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${f}: inline event handler`);
  }
  ok('no page has an inline <script> or an on*= handler');

  // --- the leaderboard: counts only, never a cookie, CORS for the main site ---
  const { standings } = require('../server');
  for (const o of ['https://www.strongtechnicalconsulting.com', 'https://strongtechnicalconsulting.com']) {
    const r = await fetch(base + '/api/lab/leaderboard', { headers: { Origin: o, 'Sec-Fetch-Site': 'same-site' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('access-control-allow-origin'), o);
    assert.strictEqual(r.headers.get('set-cookie'), null);
  }
  ok('leaderboard: the apex and www may read it cross-origin, and are handed no cookie');
  const lbEvil = await fetch(base + '/api/lab/leaderboard', { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(lbEvil.headers.get('access-control-allow-origin'), null); ok('leaderboard: no other origin is allowed');
  const lbSame = await fetch(base + '/api/lab/leaderboard');
  assert.strictEqual(lbSame.headers.get('set-cookie'), null); ok('leaderboard: even a same-origin read mints no visitor id');
  assert.match(String(lbSame.headers.get('cache-control')), /max-age=15/); ok('leaderboard: cached for 15 s');
  const lb = await lbSame.json();
  assert.ok(Array.isArray(lb.apps) && lb.apps.length >= 1);
  const allowed = ['slug', 'name', 'emoji', 'color', 'color2', 'drop', 'dropped', 'status', 'live', 'votes', 'rank'];
  lb.apps.forEach((a) => Object.keys(a).forEach((k) => assert.ok(allowed.includes(k), 'unexpected field ' + k)));
  assert.ok(!/myVote|vid|voter|note|zebra/i.test(JSON.stringify(lb))); ok('leaderboard: counts and names only - no voter, no vote of yours, no notes');
  assert.ok(!/"keep"|"kill"|keepPct|"score"|"split"/.test(JSON.stringify(lb))); ok('leaderboard: no split - no keep, kill, keep % or score for anyone');
  assert.deepStrictEqual(lb.apps.map((a) => a.rank), lb.apps.map((_, i) => i + 1)); ok('leaderboard: ranks run 1..n');
  await call('POST', '/api/lab/spar/vote', { v: 'keep' });
  const after = await (await fetch(base + '/api/lab/leaderboard')).json();
  assert.strictEqual(after.apps.find((a) => a.slug === 'spar').votes, 1); ok('leaderboard: a vote shows at once (the vote clears the cache)');
  assert.strictEqual(after.leader, null); ok('leaderboard: one vote makes nobody the leader');

  const reg = [
    { slug: 'a', name: 'A', status: 'testing' }, { slug: 'b', name: 'B', status: 'testing' },
    { slug: 'c', name: 'C', status: 'testing' }, { slug: 'dead', name: 'Dead', status: 'retired' },
  ];
  let st = standings(reg, { a: { keep: 1 }, b: { keep: 9, kill: 1 }, c: {}, dead: { keep: 99 } });
  assert.deepStrictEqual(st.apps.map((a) => a.slug), ['b', 'a', 'c']); ok('standings: 9 of 10 outranks a lone keep (Wilson, not raw %)');
  assert.strictEqual(st.leader, 'b'); ok('standings: a clear leader with enough votes is named');
  assert.ok(!st.apps.some((a) => a.slug === 'dead')); ok('standings: retired apps are left out');
  assert.deepStrictEqual(st.apps.map((a) => a.drop), [2, 1, 3]); ok('standings: each app keeps its drop number, whatever its rank');
  assert.deepStrictEqual(st.apps.map((a) => a.votes), [10, 1, 0]);
  st.apps.forEach((a) => ['keep', 'kill', 'keepPct', 'score', 'order'].forEach((k) => assert.ok(!(k in a), k)));
  ok('standings: total votes per app, and no keep, kill, keep % or score');
  st = standings(reg, { a: { keep: 3, kill: 1 }, b: { keep: 3, kill: 1 } });
  assert.strictEqual(st.leader, null); ok('standings: a tie at the top names no leader');
  st = standings(reg, { a: { kill: 5 }, b: { kill: 2 } });
  assert.strictEqual(st.leader, null); ok('standings: all kills names no leader');
  st = standings(reg, { a: { keep: -4, kill: 'x' } });
  assert.strictEqual(st.apps.find((a) => a.slug === 'a').votes, 0); ok('standings: a bad tally reads as zero');

  // --- stuffing (2026-09-27): a vote needs an id the page's own read minted ---
  const { LIMITS, ipKey } = require('../server');
  const raw = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  const before = await tallyOf('spar');
  const fresh = await raw('/api/lab/spar/vote', { v: 'keep' });
  assert.strictEqual(fresh.status, 400); assert.strictEqual(fresh.headers.get('set-cookie'), null);
  assert.deepStrictEqual(await tallyOf('spar'), before); ok('a vote with no id is refused, counts nothing and mints no id');
  const noteBare = await raw('/api/lab/spar/note', { text: 'no cookie here' });
  assert.strictEqual(noteBare.status, 400); ok('a note with no id is refused too');
  // A script inventing a new id per request, from one address.
  const from = { 'X-Forwarded-For': '203.0.113.7' };
  const invented = () => ({ Cookie: `lab_vid=${require('crypto').randomBytes(16).toString('base64url')}`, ...from });
  const loop = [];
  for (let i = 0; i < LIMITS.votersPerIp + 5; i++) loop.push((await raw('/api/lab/tally/vote', { v: 'keep' }, invented())).status);
  assert.strictEqual(loop.filter((x) => x === 200).length, LIMITS.votersPerIp);
  assert.ok(loop.slice(LIMITS.votersPerIp).every((x) => x === 429));
  assert.deepStrictEqual(await tallyOf('tally'), { keep: LIMITS.votersPerIp, kill: 0 });
  ok(`an address brings at most ${LIMITS.votersPerIp} ids to the vote route an hour; the rest are 429 and count nothing`);
  const par = await Promise.all([1, 2, 3, 4].map(() => raw('/api/lab/tally/vote', { v: 'kill' }, { ...invented(), 'X-Forwarded-For': '203.0.113.8' })));
  assert.ok(par.every((x) => x.status === 200)); ok('another address is not held up by it');
  // One browser that is already counted keeps voting, on any drop.
  const known = invented();
  const seed = await raw('/api/lab/spar/vote', { v: 'keep' }, { ...known, 'X-Forwarded-For': '203.0.113.9' });
  assert.strictEqual(seed.status, 200);
  for (let i = 0; i < LIMITS.votersPerIp - 1; i++) await raw('/api/lab/spar/vote', { v: 'keep' }, { ...invented(), 'X-Forwarded-For': '203.0.113.9' });
  assert.strictEqual((await raw('/api/lab/rave/vote', { v: 'keep' }, { ...known, 'X-Forwarded-For': '203.0.113.9' })).status, 200);
  assert.strictEqual((await raw('/api/lab/rave/vote', { v: 'keep' }, { ...invented(), 'X-Forwarded-For': '203.0.113.9' })).status, 429);
  ok('a browser already counted from a full address still votes and changes votes; a new one does not');
  // IPv6: one customer's /64 is one address.
  assert.strictEqual(ipKey('2001:db8:1:2:aaaa::1'), ipKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  assert.notStrictEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
  assert.strictEqual(ipKey('::ffff:192.0.2.1'), '192.0.2.1'); ok('IPv6 addresses count by their /64');
  const v6 = []; for (let i = 0; i < LIMITS.votersPerIp + 2; i++) v6.push((await raw('/api/lab/tally/vote', { v: 'kill' }, { ...invented(), 'X-Forwarded-For': `2001:db8:9:9:${i.toString(16)}::1` })).status);
  assert.strictEqual(v6.filter((x) => x === 429).length, 2); ok('...so rotating inside a /64 does not buy more votes');
  // Withdrawing a vote never cast writes nothing.
  const ghost = invented();
  const w = await raw('/api/lab/spar/vote', { v: null }, { ...ghost, 'X-Forwarded-For': '203.0.113.10' });
  assert.strictEqual(w.status, 200); assert.strictEqual(await store.get('lab_voters', `spar:${ghost.Cookie.split('=')[1]}`), null);
  ok('withdrawing a vote that was never cast stores nothing');
  const nf = { ...invented(), 'X-Forwarded-For': '203.0.113.20' };
  const notes = [];
  for (let i = 0; i < LIMITS.notesPerIp + 3; i++) notes.push((await raw('/api/lab/spar/note', { text: `flood ${i} `.padEnd(600, 'x') }, nf)).status);
  assert.strictEqual(notes.filter((x) => x === 200).length, LIMITS.notesPerIp); assert.ok(notes.slice(LIMITS.notesPerIp).every((x) => x === 429));
  ok(`notes: at most ${LIMITS.notesPerIp} an hour from one address`);

  // Email verification (2026-09-27). Each app's own suite runs with
  // REQUIRE_VERIFIED_FOR_FREE_AI=0 (the gate itself is tested at the root,
  // test/verify.js); this holds it once for a real lab app under its mount.
  {
    let c = '';
    const u = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(c ? { Cookie: c } : {}) }, body: b ? JSON.stringify(b) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('stc_session=')) c = sc.split(';')[0];
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    assert.strictEqual((await u('POST', '/spar/api/auth/register', { email: 'lab-verify@example.com', password: 'a-long-password-1' })).status, 200);
    assert.strictEqual((await u('GET', '/spar/api/auth/me')).data.emailVerified, false); ok('a new account reads emailVerified: false in a lab app');
    const refused = await u('POST', '/spar/api/custom', { text: 'anything' });
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.data.code, 'verify-email');
    assert.strictEqual(refused.data.resend, '/spar/api/auth/verify/send');
    ok('...its free credit waits on a confirmed address, and the refusal points at the app\'s own mount');
    assert.strictEqual((await u('POST', '/spar/api/auth/verify/send', {})).status, 200); ok('...where "send again" answers');
    for (const slug of mounted) {
      const page = await (await fetch(`${base}/${slug}/`)).text();
      assert.ok(page.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'), slug + ' page lacks the banner');
      const js = await fetch(`${base}/${slug}/verify-banner.js`);
      assert.strictEqual(js.status, 200, slug + ' does not serve verify-banner.js');
    }
    ok(`every mounted app (${mounted.length}) loads the shared banner from its own base`);
  }

  server.close();
  console.log(`\n${n}/${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
