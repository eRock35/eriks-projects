// Lab Pulse (/pulse, /api/pulse): pulse.json from a git branch is untrusted,
// so every field is validated; the lab rows come from this host; nothing
// secret ever comes out. pulse.json is faked at fetch (the sandbox cannot
// reach raw.githubusercontent.com, and the tests must not depend on it).
process.env.LAB_MEMORY = '1';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const pulse = require('../pulse');
const lab = require('../lab');

const ROOT = path.join(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pulse.json'), 'utf8'));
const NOW = Date.parse('2026-11-08T12:41:12Z');
const clone = (o) => JSON.parse(JSON.stringify(o));
let n = 0;
const ok = (name) => { n++; console.log('  ok  ' + name); };

// Built here rather than written out: no file in this public repo carries an
// address, a token, a Team ID or an App Store Connect id, even a fake one.
const ADDRESS = 'holder' + '@' + 'example.com';
const TOKEN = ['eyJ' + 'hbGciOiJFUzI1NiJ9', 'eyJ' + 'pc3MiOiJmYWtlIn0', 'c2ln'].join('.');
const TEAM = 'Z'.repeat(10);
const ASC_ID = '9'.repeat(10);
const SECRETS = [ADDRESS, TOKEN, TEAM, ASC_ID, 'BEGIN PRIVATE KEY', '<script', 'javascript:', 'onerror'];
const assertClean = (text, where, { page = false } = {}) => {
  // A page has its own <script src>; data never has any markup.
  for (const s of SECRETS.filter((x) => !page || !['<script'].includes(x))) assert.ok(!text.includes(s), `${where}: carries ${s}`);
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text), `${where}: an email address`);
  assert.ok(!/eyJ[A-Za-z0-9_-]{8,}/.test(text), `${where}: a token`);
  assert.ok(!/\b[A-Z0-9]{10}\.com\.strongtechnicalconsulting\./.test(text), `${where}: a Team ID`);
};
const respond = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'text/plain' }, ...init });

(async () => {
  /* ---------------- validation ---------------- */
  {
    const v = pulse.validate(clone(FIXTURE));
    assert.deepStrictEqual(v.rejected, []);
    assert.strictEqual(v.doc.iphone.apps.length, 5);
    assert.strictEqual(v.doc.generatedAt, FIXTURE.generatedAt);
    ok('the shared fixture (also checked by mobile/scripts/test_pulse.py) validates with nothing dropped');

    for (const bad of [null, [], 'x', 42, { ...clone(FIXTURE), schema: 2 }, { ...clone(FIXTURE), generatedAt: 'today' }, { ...clone(FIXTURE), generatedAt: undefined }]) {
      assert.strictEqual(pulse.validate(bad).doc, null, JSON.stringify(bad).slice(0, 40));
    }
    ok('not an object, another schema or no readable date: the whole file is treated as missing');

    // Hostile values in every field: each one is dropped, the rest kept.
    const h = clone(FIXTURE);
    const a0 = h.iphone.apps[0];
    const a1 = h.iphone.apps[1];
    h.teamId = TEAM;
    h.github.token = TOKEN;
    h.asc = { ok: true, issuer: ADDRESS };
    a0.latest.url = 'javascript:alert(1)';
    a0.latest.failedStep = '<img src=x onerror=alert(1)>';
    a0.latest.failure = 'PLA Update available for ' + ADDRESS;
    a0.latest.at = '2026-11-01';
    a0.latest.extra = TOKEN;
    a0.lastUpload.url = 'https://appstoreconnect.apple.com/apps/' + ASC_ID + '/testflight';
    a0.asc.build.number = ASC_ID;
    a0.asc.build.version = '1.0<script>';
    a0.asc.build.external = 'HACKED';
    a0.asc.build.appId = ASC_ID;
    a0.asc.build.expiresAt = 'soon';
    a1.latest.url = 'http://github.com/eRock35/eriks-projects/actions/runs/1';
    a1.lastUpload.url = 'https://github.com.evil.example/eRock35/eriks-projects/actions/runs/1';
    a1.latest.run = '7';
    h.iphone.apps[2].latest.url = 'https://github.com/someone/else/actions/runs/1';
    h.iphone.apps[3].bundleId = 'com.example.' + TEAM;
    h.iphone.apps.push(clone(h.iphone.apps[4]));               // a second football
    h.iphone.apps.push({ ...clone(h.iphone.apps[4]), slug: 'evil', bundleId: 'com.strongtechnicalconsulting.evil' });
    h.iphone.lastRun.event = '<b>';
    h.ci.jobs.push({ name: 'x'.repeat(200), conclusion: 'success', failedStep: null }, { name: 'deploy ' + ADDRESS, conclusion: 'success', failedStep: null });
    h.ci.jobs[0].failedStep = ADDRESS;
    h.ci.url = 'https://github.com/eRock35/eriks-projects/actions/runs/1?x=' + TOKEN;
    const v2 = pulse.validate(JSON.parse(JSON.stringify(h).replace('"schema":1', '"schema":1,"__proto__":{"polluted":1}')));
    assert.strictEqual({}.polluted, undefined);
    const d = v2.doc;
    assert.ok(d, 'one bad field must not sink the file');
    const t0 = d.iphone.apps.find((a) => a.slug === 'trip');
    assert.strictEqual(t0.latest.url, null); assert.strictEqual(t0.latest.failedStep, null); assert.strictEqual(t0.latest.failure, null); assert.strictEqual(t0.latest.at, null);
    assert.strictEqual(t0.latest.run, 7); assert.strictEqual(t0.latest.conclusion, 'failure');
    assert.ok(!('extra' in t0.latest));
    assert.strictEqual(t0.lastUpload.url, null);
    assert.strictEqual(t0.asc.build.number, null); assert.strictEqual(t0.asc.build.version, null); assert.strictEqual(t0.asc.build.external, null);
    assert.strictEqual(t0.asc.build.expiresAt, null); assert.ok(!('appId' in t0.asc.build));
    assert.strictEqual(t0.asc.build.processingState, 'VALID');
    ok('trip: the bad URL, step, failure word, date, build number, version, state and expiry are dropped; its run, result and processing state stay');
    const h1 = d.iphone.apps.find((a) => a.slug === 'hopscotch');
    assert.strictEqual(h1.latest, null, 'a run number that is not a number drops the reference');
    assert.strictEqual(h1.lastUpload.url, null);
    assert.strictEqual(d.iphone.apps.find((a) => a.slug === 'flight').latest.url, null);
    ok('only https://github.com/eRock35/eriks-projects/actions/... URLs pass: not http, not a look-alike host, not another repo, not App Store Connect');
    assert.deepStrictEqual(d.iphone.apps.map((a) => a.slug), ['trip', 'hopscotch', 'flight', 'football']);
    ok('an app whose bundle ID does not match, a duplicate and an unknown app are dropped');
    assert.strictEqual(d.iphone.lastRun.event, 'unknown');
    assert.deepStrictEqual(d.ci.jobs.map((j) => j.name), ['test']);
    assert.strictEqual(d.ci.jobs[0].failedStep, null); assert.strictEqual(d.ci.url, null);
    ok('CI: an over-long or address-bearing job name, a bad step and a URL with a query are dropped');
    assert.deepStrictEqual(d.asc, { ok: true });
    for (const p of ['doc.teamId', 'github.token', 'asc.issuer', 'iphone.apps[0].latest.url', 'iphone.apps[0].latest.extra', 'iphone.apps[0].asc.build.appId', 'iphone.apps[3].slug', 'iphone.apps[5].slug', 'iphone.apps[6].slug']) {
      assert.ok(v2.rejected.includes(p), 'not reported: ' + p);
    }
    ok(`every dropped field is reported by path (${v2.rejected.length} here)`);
    const shown = JSON.stringify(pulse.view({ got: { status: 'ok', doc: d, rejected: v2.rejected.length }, apps: lab.APPS, mounted: lab.slugs(), buildStats: null, now: NOW }));
    assertClean(shown, 'view of hostile data');
    ok('nothing hostile, secret or identifying reaches the page: no address, token, Team ID, App Store Connect id or markup');

    const asc = clone(FIXTURE); asc.asc = { ok: false, reason: 'the key is ' + TEAM }; asc.iphone.apps[0].asc = { ok: false, reason: 'agreement', detail: ADDRESS };
    const va = pulse.validate(asc).doc;
    assert.deepStrictEqual(va.asc, { ok: false, reason: 'error' });
    assert.deepStrictEqual(va.iphone.apps[0].asc, { ok: false, reason: 'agreement' });
    ok('an App Store Connect failure keeps only its one-word reason');
  }

  /* ---------------- the view ---------------- */
  {
    const stats = { apps: { spar: { in: 30e6, out: 200e3, agents: 1, agentMs: 2.7e6, exact: false } }, totals: { in: 30e6, out: 200e3, agents: 1, agentMs: 2.7e6, estimated: 1 } };
    const doc = pulse.validate(clone(FIXTURE)).doc;
    const mounted = lab.slugs().filter((s) => s !== 'tally');
    const v = pulse.view({ got: { status: 'ok', doc }, apps: lab.APPS, mounted, buildStats: stats, now: NOW });
    assert.strictEqual(v.lab.apps.length, lab.APPS.length);
    // Every drop adds one, so the count comes from lab.js rather than a
    // number to bump each day (it was 57 when Pulse shipped).
    assert.ok(lab.APPS.length >= 57);
    v.lab.apps.forEach((a, i) => {
      const src = lab.APPS[i];
      assert.strictEqual(a.drop, i + 1); assert.strictEqual(a.slug, src.slug); assert.strictEqual(a.name, src.name);
      assert.strictEqual(a.emoji, src.emoji); assert.strictEqual(a.dropped, src.dropped); assert.strictEqual(a.status, src.status);
    });
    ok('all ' + lab.APPS.length + ' lab rows come from lab.js: drop number, emoji, name, date and status, in drop order');
    assert.strictEqual(v.lab.apps.find((a) => a.slug === 'tally').mounted, false);
    assert.strictEqual(v.lab.apps.find((a) => a.slug === 'tally').href, null);
    assert.strictEqual(v.lab.apps.find((a) => a.slug === 'spar').href, '/spar/');
    assert.strictEqual(v.lab.counts.mounted, mounted.length);
    ok('"live here" is whether this instance mounted the app; only a mounted app gets a link');
    assert.deepStrictEqual(v.lab.apps.find((a) => a.slug === 'spar').build, { in: 30e6, out: 200e3, agents: 1, agentMs: 2.7e6, exact: false });
    assert.strictEqual(v.lab.apps.find((a) => a.slug === 'chaser').build, null);
    ok('build stats come from build-stats.json, per app, and an app with no row has none');
    assert.ok(!v.lab.apps.some((a) => 'tests' in a || 'ci' in a));
    assert.strictEqual(v.ci.run, 112); assert.strictEqual(v.ci.result, 'ok');
    ok('one CI line for the repo; no per-app test result is invented');

    assert.deepStrictEqual(v.banners.map((b) => b.kind), ['agreement']);
    assert.strictEqual(v.banners[0].text, "Accept the updated Apple Developer Program License Agreement at developer.apple.com (Account Holder), then re-run 'iPhone apps to TestFlight'.");
    ok('the agreement banner, word for word, when the latest builds failed on it');
    assert.deepStrictEqual(v.iphone.apps.map((a) => a.testflight.text), [
      'In beta testing · expires in 54 days', 'Waiting for beta review · expires in 54 days',
      'Approved for beta testing · expires in 54 days', 'In beta testing · expires in 54 days',
      'Internal testing only, not sent for beta review · expires in 54 days',
    ]);
    assert.deepStrictEqual(v.iphone.apps.map((a) => a.name), ['Trip Planner', 'Hopscotch', 'Flight', 'Inside Joke', 'Football']);
    assert.ok(v.iphone.apps.every((a) => a.latest.result === 'bad' && a.latest.why === 'Apple agreement not accepted' && a.latest.run === 7));
    assert.ok(v.iphone.apps.every((a) => a.build.number === '5' && a.lastUpload.run === 5));
    ok('five iPhone rows: result with the run, build number, TestFlight state in words, last upload');
    assert.strictEqual(v.iphone.nextScheduled, '2026-12-01T09:23:00Z');
    assert.strictEqual(v.source.ageMinutes, 120); assert.strictEqual(v.source.stale, false);

    // The agreement read straight from App Store Connect, with green builds.
    const d2 = clone(FIXTURE);
    d2.asc = { ok: false, reason: 'agreement' };
    d2.iphone.apps.forEach((a) => { a.asc = { ok: false, reason: 'agreement' }; a.latest.conclusion = 'success'; a.latest.failure = null; a.latest.failedStep = null; });
    const v2 = pulse.view({ got: { status: 'ok', doc: pulse.validate(d2).doc }, apps: lab.APPS, mounted, buildStats: null, now: NOW });
    assert.strictEqual(v2.banners[0].kind, 'agreement');
    assert.ok(v2.iphone.apps.every((a) => a.testflight.text === 'App Store Connect: agreement not accepted'));
    assert.strictEqual(v2.source.appStoreConnect, 'agreement');
    ok('...and when App Store Connect itself answers with the agreement 403');

    // Builds that run out before the next scheduled build.
    const d3 = clone(FIXTURE);
    d3.iphone.apps.forEach((a, i) => { a.latest.failure = null; if (i < 2) a.asc.build.expiresAt = '2026-11-20T10:00:00Z'; });
    d3.iphone.apps[4].asc.build.expiresAt = '2026-11-01T10:00:00Z';
    const v3 = pulse.view({ got: { status: 'ok', doc: pulse.validate(d3).doc }, apps: lab.APPS, mounted, buildStats: null, now: NOW });
    assert.deepStrictEqual(v3.banners.map((b) => b.kind), ['expiry']);
    assert.strictEqual(v3.banners[0].text, "The newest TestFlight build of Football has expired. The newest TestFlight build of Trip Planner and Hopscotch expires on Fri, Nov 20, before the next scheduled build on Tue, Dec 1. Run 'iPhone apps to TestFlight' to send a new one.");
    assert.strictEqual(v3.iphone.apps[4].testflight.text, 'Expired Nov 1, 2026');
    assert.strictEqual(v3.iphone.apps[0].testflight.text, 'In beta testing · expires in 11 days');
    assert.strictEqual(v3.iphone.apps[0].testflight.tone, 'warn');
    ok('the expiry banner names the apps whose newest build expires before the next scheduled build, or has expired');

    const words = (asc) => pulse.testflightWords(asc, NOW).text;
    assert.strictEqual(words({ ok: true, found: false, build: null }), 'Not in App Store Connect yet');
    assert.strictEqual(words({ ok: true, found: true, build: null }), 'No build uploaded yet');
    assert.strictEqual(words({ ok: true, found: true, build: { processingState: 'PROCESSING' } }), 'Processing');
    assert.strictEqual(words({ ok: false, reason: 'unset' }), 'App Store Connect not checked');
    assert.strictEqual(words({ ok: true, found: true, build: { processingState: 'VALID', external: 'BETA_REJECTED', expiresAt: '2027-01-01T00:00:00Z' } }), 'Rejected in beta review · expires in 53 days');
    ok('TestFlight in words: not there yet, no build, processing, not checked, rejected');

    const dm = pulse.view({ got: { status: 'missing' }, apps: lab.APPS, mounted, buildStats: stats, now: NOW });
    assert.strictEqual(dm.source.ok, false); assert.strictEqual(dm.source.status, 'missing');
    assert.strictEqual(dm.lab.apps.length, lab.APPS.length); assert.deepStrictEqual(dm.banners, []); assert.strictEqual(dm.ci, null);
    assert.ok(dm.iphone.apps.every((a) => a.latest === null && a.testflight.text === 'Unknown right now'));
    ok('pulse.json missing: degraded, the five iPhone rows say unknown, every lab row still drawn');
    const old = clone(FIXTURE); old.generatedAt = '2026-11-08T01:00:00Z';
    assert.strictEqual(pulse.view({ got: { status: 'ok', doc: pulse.validate(old).doc }, apps: lab.APPS, mounted, buildStats: null, now: NOW }).source.stale, true);
    ok('a file more than nine hours old is marked stale');

    // ios.yml's schedule is what the host assumes.
    const ios = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'ios.yml'), 'utf8');
    assert.ok(ios.includes("- cron: '23 9 1 * *'"), 'ios.yml schedule moved: change nextScheduledBuild too');
    assert.strictEqual(pulse.nextScheduledBuild(Date.parse('2026-11-01T09:22:00Z')).toISOString(), '2026-11-01T09:23:00.000Z');
    assert.strictEqual(pulse.nextScheduledBuild(Date.parse('2026-12-31T23:00:00Z')).toISOString(), '2027-01-01T09:23:00.000Z');
    ok('the next scheduled build is the 1st at 09:23 UTC, as ios.yml says');
  }

  /* ---------------- the source: in the request, capped, cached, timed out ---------------- */
  {
    let clock = NOW;
    let calls = 0;
    let answer = () => respond(FIXTURE);
    const src = pulse.source({ fetch: async (url, opts) => { calls++; assert.strictEqual(url, pulse.PULSE_URL); assert.strictEqual(opts.redirect, 'error'); return answer(opts); }, now: () => clock, timeoutMs: 80 });
    const a = await src.get();
    assert.strictEqual(a.status, 'ok'); assert.strictEqual(calls, 1);
    await src.get(); clock += pulse.TTL_MS - 1; await src.get();
    assert.strictEqual(calls, 1); ok('cached in memory for five minutes: one fetch');
    clock += 2; await src.get(); assert.strictEqual(calls, 2); ok('...and fetched again after that');
    src.clear(); clock += 1;
    await Promise.all([src.get(), src.get(), src.get()]); assert.strictEqual(calls, 3); ok('requests that arrive together share one fetch');

    const cases = [
      ['missing', () => respond('404: Not Found', { status: 404 })],
      ['unreachable', () => respond('oops', { status: 500 })],
      ['invalid', () => respond('{not json')],
      ['invalid', () => respond({ ...FIXTURE, schema: 9 })],
      ['invalid', () => respond('{"a":"' + 'x'.repeat(pulse.MAX_BYTES) + '"}')],
      ['invalid', () => respond('{}', { headers: { 'content-length': String(pulse.MAX_BYTES + 1) } })],
      ['unreachable', () => { throw new TypeError('fetch failed'); }],
    ];
    for (const [want, fn] of cases) {
      const s = pulse.source({ fetch: async () => fn(), now: () => clock });
      assert.strictEqual((await s.get()).status, want, want);
    }
    ok('404 is missing; a 500 or a network error is unreachable; bad JSON, another schema or over 256 KB is invalid');

    const slow = pulse.source({
      fetch: (url, opts) => new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(new Error('aborted'))); }),
      now: () => clock, timeoutMs: 60,
    });
    const t0 = Date.now();
    assert.strictEqual((await slow.get()).status, 'timeout');
    assert.ok(Date.now() - t0 < 1000, 'the timeout did not cut the request short');
    ok('a fetch that hangs is cut off at the timeout');
    const stalled = pulse.source({
      fetch: async (url, opts) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"schema":')); opts.signal.addEventListener('abort', () => c.error(new Error('aborted'))); } })),
      now: () => clock, timeoutMs: 60,
    });
    assert.strictEqual((await stalled.get()).status, 'timeout'); ok('...and so is a body that stops half way');

    let up = true;
    const flaky = pulse.source({ fetch: async () => (up ? respond(FIXTURE) : respond('', { status: 503 })), now: () => clock });
    await flaky.get(); up = false; clock += pulse.TTL_MS + 1;
    const kept = await flaky.get();
    assert.strictEqual(kept.status, 'ok'); assert.strictEqual(kept.refreshFailed, 'unreachable');
    ok('a failed refresh keeps showing the last good copy, and says so');
  }

  /* ---------------- the routes ---------------- */
  const realFetch = global.fetch;
  let served = () => respond(FIXTURE);
  let rawFetches = 0;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://raw.githubusercontent.com/')) { rawFetches++; return served(); }
    return realFetch(url, opts);
  };
  const { host, mounted, pulseSource } = require('../server');
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.ok(!lab.APPS.some((a) => a.slug === 'pulse' || a.slug === 'pulse-page'), 'no app may take /pulse');
    ok('no app is called "pulse" (apps mount ahead of the host\'s own routes)');

    for (const p of ['/pulse', '/pulse/']) {
      const r = await fetch(base + p, { redirect: 'manual' });
      assert.strictEqual(r.status, 200, p);
      assert.match(r.headers.get('content-type') || '', /text\/html/);
      const csp = String(r.headers.get('content-security-policy'));
      assert.match(csp, /script-src 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'self'/);
      assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(r.headers.get('set-cookie'), null);
      const html = await r.text();
      assert.ok(html.includes('<script src="/pulse-page.js" defer></script>'));
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>');
      assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline handler');
      assertClean(html, p, { page: true });
    }
    ok('/pulse and /pulse/ serve the page with the lab\'s script CSP, no cookie, no inline script or handler');
    for (const [p, type] of [['/pulse-page.js', /javascript/], ['/pulse.css', /css/]]) {
      const r = await fetch(base + p);
      assert.strictEqual(r.status, 200, p); assert.match(r.headers.get('content-type') || '', type);
    }
    const js = fs.readFileSync(path.join(ROOT, 'public', 'pulse-page.js'), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), 'the page builds markup from strings');
    ok('the page script draws with textContent only: no innerHTML, no eval');

    pulseSource.clear();
    let r = await fetch(base + '/api/pulse');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('cache-control') || '', /max-age=60/);
    assert.strictEqual(r.headers.get('set-cookie'), null);
    let text = await r.text();
    let body = JSON.parse(text);
    assert.strictEqual(body.source.ok, true);
    assert.strictEqual(body.lab.apps.length, lab.APPS.length);
    assert.deepStrictEqual(body.lab.apps.filter((a) => a.mounted).map((a) => a.slug), mounted.slice().sort((x, y) => lab.slugs().indexOf(x) - lab.slugs().indexOf(y)));
    assert.strictEqual(body.lab.counts.mounted, mounted.length);
    assert.ok(body.lab.apps.some((a) => a.build), 'build-stats.json rows are attached');
    assert.strictEqual(body.banners[0].kind, 'agreement');
    assert.strictEqual(body.iphone.apps.length, 5);
    assertClean(text, '/api/pulse');
    ok(`GET /api/pulse: the five iPhone rows, ${body.lab.apps.length} lab rows with this instance's ${mounted.length} mounted apps, build stats, the banner`);
    const fetchesBefore = rawFetches;
    await fetch(base + '/api/pulse'); await fetch(base + '/api/pulse');
    assert.strictEqual(rawFetches, fetchesBefore); ok('...cached: three reads, one fetch of pulse.json');

    // Hostile file end to end.
    const hostile = clone(FIXTURE);
    hostile.iphone.apps[0].latest.failedStep = `<script>alert('${ADDRESS}')</script>`;
    hostile.iphone.apps[0].latest.url = 'javascript:alert(1)';
    hostile.iphone.apps[1].asc.build.number = ASC_ID;
    hostile.secret = TOKEN; hostile.asc.team = TEAM;
    served = () => respond(hostile);
    pulseSource.clear();
    text = await (await fetch(base + '/api/pulse')).text();
    body = JSON.parse(text);
    assert.strictEqual(body.source.ok, true); assert.ok(body.source.rejected >= 5);
    assertClean(text, '/api/pulse (hostile)');
    ok('a hostile pulse.json: the bad fields are dropped, the rest is served, nothing of it leaks');

    served = () => respond('404: Not Found', { status: 404 });
    pulseSource.clear();
    body = await (await fetch(base + '/api/pulse')).json();
    assert.strictEqual(body.source.ok, false); assert.strictEqual(body.source.status, 'missing');
    assert.strictEqual(body.lab.apps.length, lab.APPS.length); assert.ok(body.lab.apps.some((a) => a.mounted));
    ok('pulse.json missing (before the first workflow run): degraded, and the lab rows still render');

    served = () => { throw new TypeError('fetch failed'); };
    pulseSource.clear();
    r = await fetch(base + '/api/pulse');
    assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).source.status, 'unreachable');
    ok('GitHub unreachable: still a 200 with the lab rows, never a 500');
  } finally {
    server.close();
    global.fetch = realFetch;
  }

  /* ---------------- contrast, both themes ---------------- */
  {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'pulse.css'), 'utf8');
    const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
    const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
    const darkMedia = tokens(css.slice(css.indexOf(':root:not([data-theme="light"])'), css.indexOf('}', css.indexOf(':root:not([data-theme="light"])'))));
    const darkAttr = tokens(css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('}', css.indexOf(':root[data-theme="dark"]'))));
    assert.deepStrictEqual(darkAttr, darkMedia, 'the two dark blocks differ');
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const PAIRS = [
      ['ink', 'bg'], ['ink', 'card'], ['ink', 'stripe'], ['ink', 'alert-bg'], ['ink', 'notice-bg'],
      ['muted', 'bg'], ['muted', 'card'], ['muted', 'stripe'],
      ['link', 'bg'], ['link', 'card'],
      ['chip-ink', 'chip'], ['ok-ink', 'ok-bg'], ['bad-ink', 'bad-bg'], ['warn-ink', 'warn-bg'], ['run-ink', 'run-bg'],
    ];
    let worst = 99;
    for (const [name, theme] of [['light', light], ['dark', { ...light, ...darkMedia }]]) {
      for (const [fg, bg] of PAIRS) {
        assert.ok(theme[fg] && theme[bg], `${name}: --${fg} or --${bg} is not a solid colour`);
        const r = ratio(theme[fg], theme[bg]);
        worst = Math.min(worst, r);
        assert.ok(r >= 4.5, `${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      }
    }
    ok(`every text colour on its surface is 4.5:1 or better in light and dark (lowest ${worst.toFixed(2)}:1)`);
    const colours = [...css.replace(/color-scheme:[^;]+;/g, '').matchAll(/(?:^|[^-])color:\s*([^;]+);/gm)].map((m) => m[1].trim());
    assert.ok(colours.length > 20);
    const stray = colours.filter((c) => !/^var\(--(ink|muted|link|chip-ink|ok-ink|bad-ink|warn-ink|run-ink)\)$/.test(c));
    assert.deepStrictEqual(stray, [], 'a text colour outside the measured tokens');
    ok('no text colour is set outside the measured tokens');
  }

  /* ---------------- linked from the lab ---------------- */
  {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const foot = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    assert.ok(/<a [^>]*href="\/pulse"[^>]*>Lab(?: |&nbsp;)Pulse<\/a>/.test(foot), 'the landing footer links to /pulse');
    ok('the lab landing page\'s footer links to "Lab Pulse"');
  }

  console.log(`\n${n}/${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
