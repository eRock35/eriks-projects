// Build stats: what each app cost to make, served on /api/lab from
// build-stats.json (written by scripts/token-ledger.py --stats).
process.env.LAB_MEMORY = '1';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };

async function boot(file) {
  // A fresh server per file: the stats are read once, at startup.
  for (const k of Object.keys(require.cache)) if (!k.includes('node_modules')) delete require.cache[k];
  if (file === undefined) delete process.env.BUILD_STATS_FILE; else process.env.BUILD_STATS_FILE = file;
  const { host } = require('../server');
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, get: async (p, h) => (await fetch(base + p, { headers: h || {} })).json() };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-stats-'));

  // --- the committed file, as the lab serves it ---
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build-stats.json'), 'utf8'));
  let s = await boot();
  let lab = await s.get('/api/lab');
  const withBuild = lab.apps.filter((a) => a.build);
  assert.ok(withBuild.length >= 1); ok('the committed build-stats.json is served on /api/lab');
  for (const a of withBuild) {
    for (const k of ['in', 'out', 'agents', 'agentMs', 'wallMs']) assert.ok(Number.isInteger(a.build[k]) && a.build[k] >= 0, `${a.slug}.${k}`);
    assert.strictEqual(typeof a.build.exact, 'boolean');
    assert.ok(a.build.cached === null || a.build.cached <= a.build.in, `${a.slug} cached <= in`);
    assert.ok(a.build.wallMs <= a.build.agentMs || a.build.agents === 1, `${a.slug} wall <= agent time`);
  }
  ok('every row has whole, non-negative counts and cached never exceeds in');
  const t = lab.buildTotals;
  assert.ok(t); ok('buildTotals is served');
  for (const k of ['in', 'out', 'agents', 'agentMs']) {
    assert.strictEqual(t[k], Object.values(real.apps).reduce((x, r) => x + (r[k] || 0), 0), 'totals.' + k);
  }
  ok('totals are the sum of the apps, nothing else');
  assert.strictEqual(t.apps, Object.keys(real.apps).length);
  assert.strictEqual(t.estimated, Object.values(real.apps).filter((r) => !r.exact).length); ok('totals count the apps and the estimates');
  assert.ok(t.cachedShare > 0.5 && t.cachedShare < 1); ok('the cached share is taken over the rows that know theirs');
  assert.deepStrictEqual(Object.keys(real.totals).sort(), ['agentMs', 'agents', 'apps', 'cached', 'cachedShare', 'estimated', 'in', 'out', 'wallMs'].sort());
  for (const k of ['in', 'out', 'agents', 'agentMs', 'wallMs', 'apps', 'estimated']) assert.strictEqual(real.totals[k], t[k], 'file totals.' + k);
  ok('the file\'s own totals agree with what the lab computes');
  const cross = await s.get('/api/lab', { Origin: 'https://www.strongtechnicalconsulting.com', 'Sec-Fetch-Site': 'same-site' });
  assert.deepStrictEqual(cross.buildTotals, t); ok('the main site\'s teaser gets the same totals cross-origin');
  s.server.close();

  // --- missing: omitted, not broken ---
  s = await boot(path.join(tmp, 'nope.json'));
  lab = await s.get('/api/lab');
  assert.ok(lab.apps.length >= 1); assert.ok(!('buildTotals' in lab)); assert.ok(lab.apps.every((a) => !('build' in a)));
  ok('no file: the lab still answers, with no build fields at all');
  s.server.close();

  // --- malformed: omitted, not broken ---
  fs.writeFileSync(path.join(tmp, 'bad.json'), '{not json');
  s = await boot(path.join(tmp, 'bad.json'));
  lab = await s.get('/api/lab');
  assert.ok(lab.apps.length >= 1 && !('buildTotals' in lab)); ok('a malformed file is ignored');
  s.server.close();

  // --- hostile rows are cleaned ---
  const { readBuildStats } = require('../server');
  const r = readBuildStats({
    updated: '<script>',
    apps: {
      spar: { in: 10.4, cached: -3, out: 2, agents: 1, agentMs: 60000, wallMs: 60000, exact: 'yes', note: '<img src=x onerror=alert(1)>' },
      'Bad Slug': { in: 1, out: 1 },
      snapquote: { in: 'lots', out: 1 },
      chaser: { in: 5, cached: 4, out: 1, agents: 2, agentMs: 10, wallMs: 5, exact: true },
    },
  });
  assert.deepStrictEqual(Object.keys(r.apps).sort(), ['chaser', 'spar']); ok('rows with a bad slug or no token counts are dropped');
  assert.strictEqual(r.apps.spar.in, 10); assert.strictEqual(r.apps.spar.cached, null); assert.strictEqual(r.apps.spar.exact, false);
  ok('counts are rounded, a negative is unknown, and only true is exact');
  assert.ok(!/[<>]/.test(r.apps.spar.note)); assert.strictEqual(r.updated, null); ok('notes lose their angle brackets; a bad date is dropped');
  assert.strictEqual(r.totals.in, 15); assert.strictEqual(r.totals.cachedShare, 0.8); assert.strictEqual(r.totals.estimated, 1);
  ok('totals and the cached share skip what is unknown');
  assert.strictEqual(readBuildStats(null), null); assert.strictEqual(readBuildStats({ apps: [] }), null); assert.strictEqual(readBuildStats({ apps: {} }), null);
  ok('nothing usable reads as null');

  // --- the ledger script: exact counts from a transcript, idempotent ---
  let py = null;
  try { execFileSync('python3', ['--version']); py = 'python3'; } catch (_) { /* no python here */ }
  if (py) {
    const script = path.join(__dirname, '..', '..', 'scripts', 'token-ledger.py');
    const jsonl = path.join(tmp, 'agent-x.jsonl');
    const line = (o) => JSON.stringify(o) + '\n';
    fs.writeFileSync(jsonl,
      line({ type: 'user', timestamp: '2026-09-25T10:00:00.000Z', message: { role: 'user', content: 'go' } }) +
      // a streamed message appears twice with the same id: counted once
      line({ type: 'assistant', timestamp: '2026-09-25T10:01:00.000Z', message: { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 7 } } }) +
      line({ type: 'assistant', timestamp: '2026-09-25T10:01:01.000Z', message: { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 7 } } }) +
      'not json\n' +
      line({ type: 'assistant', timestamp: '2026-09-25T10:30:00.000Z', message: { id: 'm2', usage: { input_tokens: 5, cache_read_input_tokens: 2000, output_tokens: 3 } } }));
    const file = path.join(tmp, 'stats.json');
    execFileSync(py, [script, '--stats', 'demo', jsonl, '--exact', '--file', file]);
    const first = fs.readFileSync(file, 'utf8');
    const d = JSON.parse(first);
    assert.deepStrictEqual(d.apps.demo, { in: 3115, cached: 3000, out: 10, agents: 1, agentMs: 1800000, wallMs: 1800000, exact: true, note: '' });
    ok('ledger: a transcript becomes in / cached / out / agents / time, each message once');
    execFileSync(py, [script, '--stats', 'demo', jsonl, '--exact', '--file', file]);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), first); ok('ledger: running it twice changes nothing');
    execFileSync(py, [script, '--stats', 'est', '--estimate', '--in', '30e6', '--out', '200e3', '--agents', '1', '--agent-min', '45', '--file', file]);
    const e = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(e.apps.est, { in: 30000000, cached: null, out: 200000, agents: 1, agentMs: 2700000, wallMs: 2700000, exact: false, note: '' });
    assert.strictEqual(e.totals.in, 30003115); assert.strictEqual(e.totals.estimated, 1); assert.strictEqual(e.totals.cachedShare, Math.round(3000 / 3115 * 1e4) / 1e4);
    ok('ledger: an estimate is labelled, and totals add it without faking its cache split');
  } else {
    console.log('  --  python3 not available; ledger script checks skipped');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n}/${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
