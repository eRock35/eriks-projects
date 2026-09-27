// The crowd reveal, the voting streak and its badges (2026-09-26).
process.env.LAB_MEMORY = '1';
const assert = require('assert');
const http = require('http');
const lab = require('../lab');
const { host, store, reveal, streakOf, progress, dropDays, weekDrops, BADGES, MIN_SPLIT } = require('../server');

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };

/* ---------------- pure ---------------- */

assert.strictEqual(MIN_SPLIT, 5);
assert.deepStrictEqual(reveal({ keep: 9, kill: 3 }, null), { votes: { total: 12 }, split: null, splitAt: 5 });
ok('reveal: no vote of yours, no split - only how many voted');
assert.strictEqual(reveal({ keep: 3, kill: 1 }, 'keep').split, null); ok('reveal: 4 votes is under the threshold, even after voting');
assert.deepStrictEqual(reveal({ keep: 4, kill: 1 }, 'kill').split, { keep: 4, kill: 1, keepPct: 80 }); ok('reveal: 5 votes and your vote -> the split');
assert.deepStrictEqual(reveal({ keep: '<b>', kill: -3 }, 'keep'), { votes: { total: 0 }, split: null, splitAt: 5 });
assert.strictEqual(reveal({ keep: 9 }, '<script>').split, null); ok('reveal: a bad tally or a bad vote reveals nothing');

// A registry with a missed day: drops on the 20th, 21st, 22nd, 24th and 25th.
const reg = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-24', '2026-09-25']
  .map((d, i) => ({ slug: `a${i}`, name: `A${i}`, dropped: d, status: 'testing' }));
assert.deepStrictEqual(dropDays([...reg, { dropped: 'soon' }, { dropped: '2026-09-25' }]), ['2026-09-25', '2026-09-24', '2026-09-22', '2026-09-21', '2026-09-20']);
ok('dropDays: newest first, one per date, junk dates ignored');
// Two drops on one date (Tipout and Tells both dropped 2026-09-27): one drop
// day, a vote on either one credits it, and both are "today".
const twin = [...reg, { slug: 'a5', name: 'A5', dropped: '2026-09-25', status: 'testing' }];
assert.deepStrictEqual(dropDays(twin), dropDays(reg));
assert.deepStrictEqual(streakOf(['2026-09-24', '2026-09-25'], twin), { current: 2, best: 2, pending: false });
assert.deepStrictEqual(progress({ days: ['2026-09-25'] }, twin, { a5: 'keep' }).today, ['a4', 'a5']);
assert.strictEqual(progress({ days: ['2026-09-25'] }, twin, { a5: 'keep' }).streak, 1);
ok('two drops on one date: one drop day, either vote credits it, both are today');
assert.deepStrictEqual(streakOf([], reg), { current: 0, best: 0, pending: false }); ok('streak: nothing voted, no streak');
assert.deepStrictEqual(streakOf(['2026-09-25'], reg), { current: 1, best: 1, pending: false }); ok('streak: today\'s drop voted -> 1');
assert.deepStrictEqual(streakOf(['2026-09-24'], reg), { current: 1, best: 1, pending: true });
ok('streak: yesterday voted, today not yet -> still 1, pending (alive until the next drop)');
assert.deepStrictEqual(streakOf(['2026-09-22', '2026-09-24', '2026-09-25'], reg), { current: 3, best: 3, pending: false });
ok('streak: a day with no drop (the 23rd) neither counts nor breaks it');
assert.deepStrictEqual(streakOf(['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-25'], reg), { current: 1, best: 3, pending: false });
ok('streak: a missed drop day (the 24th) resets it; best remembers 3');
assert.deepStrictEqual(streakOf(['2026-09-20', '2026-09-21', '2026-09-22'], reg), { current: 0, best: 3, pending: false });
ok('streak: two drops missed -> over');
assert.deepStrictEqual(streakOf(['<x>', 5, null, '2026-09-25'], reg), { current: 1, best: 1, pending: false });
assert.deepStrictEqual(streakOf('nope', reg), { current: 0, best: 0, pending: false }); ok('streak: hostile stored values are ignored');

assert.deepStrictEqual(weekDrops(reg).map((a) => a.slug), ['a0', 'a1', 'a2', 'a3', 'a4']);
assert.deepStrictEqual(weekDrops([{ slug: 'old', dropped: '2026-09-01', status: 'testing' }, ...reg]).map((a) => a.slug).includes('old'), false);
ok('weekDrops: the seven days ending at the newest drop');
const got = (me) => me.badges.filter((b) => b.earned).map((b) => b.id);
const none = Object.fromEntries(reg.map((a) => [a.slug, null]));
assert.deepStrictEqual(got(progress(null, reg, none)), []); ok('badges: a new browser has none, and sees every one locked');
assert.strictEqual(progress(null, reg, none).badges.length, BADGES.length);
assert.deepStrictEqual(got(progress({ earned: ['first'], days: ['2026-09-21', '2026-09-22', '2026-09-24'] }, reg, none)), ['first', 'streak3']);
ok('badges: a 3-day streak, once reached, stays earned after it ends');
const all = Object.fromEntries(reg.map((a) => [a.slug, 'keep']));
assert.ok(got(progress({ earned: ['first'] }, reg, all)).includes('fullweek')); ok('badges: a vote on every drop of the week earns Full week');
assert.ok(!got(progress({ earned: ['first'] }, reg, { ...all, a2: null })).includes('fullweek')); ok('badges: ...one missed, not');
const hostile = progress({ earned: ['<img src=x onerror=alert(1)>', 'first'], days: [{ $gt: '' }] }, reg, all);
assert.ok(!JSON.stringify(hostile).includes('<img')); assert.deepStrictEqual(hostile.badges.map((b) => b.id), BADGES.map((b) => b.id));
ok('badges: only the known set is ever returned, whatever is stored');
assert.deepStrictEqual([progress(null, reg, { ...none, a4: 'kill', a1: 'keep' }).voted, progress(null, reg, none).of], [2, 5]); ok('progress: voted N of M');

/* ---------------- over HTTP ---------------- */

(async () => {
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const visitor = () => {
    let cookie = '';
    const go = async (m, p, b) => {
      // The page reads /api/lab (which mints the id) before anything can be
      // tapped; a vote never mints one (2026-09-27).
      if (!cookie && m === 'POST') await go('GET', '/api/lab');
      const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc && sc.startsWith('lab_vid')) cookie = sc.split(';')[0];
      return { status: r.status, data: await r.json().catch(() => null), vid: () => cookie.split('=')[1] };
    };
    return go;
  };
  const appIn = (d, slug) => d.apps.find((a) => a.slug === slug);

  // Four keeps: nobody sees a split yet, voters included.
  const early = [visitor(), visitor(), visitor(), visitor()];
  for (const v of early) {
    const r = await v('POST', '/api/lab/rave/vote', { v: 'keep' });
    assert.strictEqual(r.data.split, null);
  }
  ok('reveal: under 5 votes, even a voter gets no split');
  const fifth = visitor();
  let r = await fifth('POST', '/api/lab/rave/vote', { v: 'keep' });
  assert.deepStrictEqual(r.data.split, { keep: 5, kill: 0, keepPct: 100 }); assert.deepStrictEqual(r.data.votes, { total: 5 });
  ok('reveal: the fifth vote reveals the split to the one who cast it');
  const lurker = visitor();
  r = await lurker('GET', '/api/lab');
  const raveLurk = appIn(r.data, 'rave');
  assert.strictEqual(raveLurk.split, null); assert.deepStrictEqual(raveLurk.votes, { total: 5 }); assert.strictEqual(raveLurk.myVote, null);
  assert.ok(!/"keep":|"kill":|keepPct/.test(JSON.stringify(raveLurk))); ok('reveal: before voting, /api/lab sends the count and not a keep or kill number');
  r = await early[0]('GET', '/api/lab');
  assert.deepStrictEqual(appIn(r.data, 'rave').split, { keep: 5, kill: 0, keepPct: 100 }); ok('reveal: an earlier voter sees it on their next visit, once there are 5');
  r = await lurker('POST', '/api/lab/rave/vote', { v: 'kill' });
  assert.deepStrictEqual(r.data.split, { keep: 5, kill: 1, keepPct: 83 }); ok('reveal: voting shows the split including your own vote');
  assert.ok(r.data.newBadges.includes('contrarian') && r.data.newBadges.includes('first')); ok('badges: siding with 17% of 6 earns Contrarian, and a first vote earns First vote');
  r = await lurker('POST', '/api/lab/rave/vote', { v: null });
  assert.strictEqual(r.data.split, null); ok('reveal: withdrawing hides it again');
  r = await lurker('GET', '/api/lab');
  assert.ok(got(r.data.me).includes('contrarian')); ok('badges: an earned badge survives withdrawing the vote that earned it');

  // Voting on an old drop is a vote, not a streak day.
  const old = visitor();
  r = await old('POST', '/api/lab/spar/vote', { v: 'keep' });
  assert.strictEqual(r.data.me.streak, 0); assert.deepStrictEqual(r.data.newBadges, ['first']); ok('streak: a vote on an old drop earns First vote but no streak day');

  // Full week: every drop of the past seven days.
  const keen = visitor();
  const week = weekDrops(lab.APPS);
  for (const [i, a] of week.entries()) {
    r = await keen('POST', `/api/lab/${a.slug}/vote`, { v: 'keep' });
    assert.strictEqual(r.data.newBadges.includes('fullweek'), i === week.length - 1);
  }
  ok(`badges: Full week lands on the last of this week's ${week.length} drops, not before`);
  r = await keen('GET', '/api/lab');
  assert.strictEqual(r.data.me.voted, week.length); assert.strictEqual(r.data.me.of, lab.APPS.filter((a) => a.status !== 'retired').length); ok('progress: /api/lab says how many drops you have voted on');

  // Across days: each new drop is a deploy that adds one to the registry.
  const newest = dropDays(lab.APPS)[0];
  const day = (k) => new Date(Date.parse(`${newest}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10);
  const added = [];
  const ship = (k) => { const a = { slug: `zz${k}`, name: `Zz${k}`, emoji: '🧪', color: '#111111', color2: '#222222', dropped: day(k), tagline: 't', blurb: 'b', features: [], audience: 'a', status: 'testing' }; lab.APPS.push(a); added.push(a); return a; };
  const todays = lab.APPS.filter((a) => a.dropped === newest)[0];
  const daily = visitor(), lapsed = visitor();
  r = await daily('POST', `/api/lab/${todays.slug}/vote`, { v: 'keep' });
  assert.strictEqual(r.data.me.streak, 1); assert.deepStrictEqual(r.data.me.today, lab.APPS.filter((a) => a.dropped === newest).map((a) => a.slug));
  await lapsed('POST', `/api/lab/${todays.slug}/vote`, { v: 'kill' });
  ok('streak: day 1 - a vote on today\'s drop starts it');
  const twins = lab.APPS.filter((a) => a.dropped === newest && a.status === 'testing');
  if (twins.length > 1) {
    r = await daily('POST', `/api/lab/${twins[1].slug}/vote`, { v: 'keep' });
    assert.strictEqual(r.data.me.streak, 1); ok('streak: a second drop on the same day counts that day once');
  }
  const d2 = ship(1);
  r = await daily('GET', '/api/lab');
  assert.deepStrictEqual([r.data.me.streak, r.data.me.pending], [1, true]); ok('streak: the next drop lands - still 1, pending');
  r = await daily('POST', `/api/lab/${d2.slug}/vote`, { v: 'kill' });
  assert.strictEqual(r.data.me.streak, 2); ok('streak: day 2 voted -> 2');
  r = await daily('POST', `/api/lab/${d2.slug}/vote`, { v: 'keep' });
  assert.strictEqual(r.data.me.streak, 2); assert.deepStrictEqual(r.data.newBadges, []); ok('streak: changing a vote the same day counts once and earns nothing new');
  const d3 = ship(2);
  r = await daily('POST', `/api/lab/${d3.slug}/vote`, { v: 'keep' });
  assert.strictEqual(r.data.me.streak, 3); assert.ok(r.data.newBadges.includes('streak3')); ok('streak: day 3 -> 3, and the 3-day badge is new');
  r = await lapsed('POST', `/api/lab/${d3.slug}/vote`, { v: 'keep' });
  assert.deepStrictEqual([r.data.me.streak, r.data.me.best], [1, 1]); ok('streak: skipping day 2 resets it - day 3 alone is 1');
  r = await lapsed('POST', `/api/lab/${d2.slug}/vote`, { v: 'keep' });
  assert.strictEqual(r.data.me.streak, 1); ok('streak: voting on yesterday\'s drop today does not backfill the missed day');
  ship(3); ship(4);
  r = await daily('GET', '/api/lab');
  assert.deepStrictEqual([r.data.me.streak, r.data.me.best, got(r.data.me).includes('streak3')], [0, 3, true]); ok('streak: two drops missed -> 0; best 3 and its badge stay');

  // What is stored: drop dates and badge ids, keyed by the opaque id. Nothing else.
  const rec = await store.get('lab_streaks', (await daily('GET', '/api/lab')).vid());
  assert.deepStrictEqual(Object.keys(rec).sort(), ['days', 'earned']);
  assert.ok(rec.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))); assert.ok(!/\d{2}:\d{2}|127\.0\.0\.1|node|undici/i.test(JSON.stringify(rec)));
  ok('stored: lab_streaks/<vid> holds drop dates and badge ids only - no time, IP or agent');
  const cross = await fetch(base + '/api/lab', { headers: { Origin: 'https://www.strongtechnicalconsulting.com', 'Sec-Fetch-Site': 'same-site' } });
  assert.strictEqual((await cross.json()).me, undefined); ok('the main site\'s cross-origin read carries no `me`');
  const bad = await visitor()('POST', '/api/lab/rave/vote', { v: '<img src=x onerror=alert(1)>' });
  assert.strictEqual(bad.status, 400); ok('hostile vote values are refused');

  added.forEach((a) => lab.APPS.splice(lab.APPS.indexOf(a), 1));
  server.close();
  console.log(`\n${n}/${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
