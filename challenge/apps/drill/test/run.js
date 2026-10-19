// Pure rules first, then end to end against the memory store and the fake
// model:
//   DRILL_MEMORY=1 DRILL_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /drill, the way
// the lab mounts it, so the auth cookie, the budget gate, the device
// cookie's path, the facilitator key and the metered route's parser are
// exercised as deployed. Model calls are counted from the identity's usage
// rows - the same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.DRILL_MEMORY !== '1' || process.env.DRILL_FAKE_AI !== '1') {
  console.error('run with DRILL_MEMORY=1 DRILL_FAKE_AI=1');
  process.exit(1);
}
// A free-tier ceiling far above anything these tests spend, so the cap can be
// reached on purpose by writing the day's tally (and read fresh each time).
process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const { app, identityStore, store } = require('../server');
const C = require('../public/drill-core');
const R = require('../lib/rooms');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let base;
let ip6 = 1;
const freshIp6 = () => `2001:db8:${(ip6++).toString(16)}::1`;
function client(ip) {
  const cookies = {};
  const addr = ip || freshIp6();
  const call = async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, text, headers: res.headers, setCookie: set };
  };
  call.cookies = cookies;
  call.ip = addr;
  return call;
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const HOSTILE = ['<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', '\u202eAna\u202c', 'Dr\u2066ill\u2069 <script>x</script>'];
const totalHits = (ch) => Object.values(ch.hits).reduce((s, p) => s + p, 0);
/** Walk a scenario choosing by a rule; returns the decisions. */
function walk(scn, pickFn) {
  const out = [];
  let at = scn.injects[0].id;
  while (at !== 'end') {
    const inj = C.injectOf(scn, at);
    const ch = pickFn(inj);
    out.push({ inject: at, choice: ch.id, by: 'solo' });
    at = ch.next;
  }
  return out;
}
const best = (inj) => inj.choices.reduce((b, c) => (totalHits(c) > totalHits(b) ? c : b));
const worst = (inj) => inj.choices.reduce((b, c) => (totalHits(c) < totalHits(b) ? c : b));

/* ---------------- cleaning ---------------- */

test('typed strings go through one door: no markup, no control or bidi characters, bounded', () => {
  assert.strictEqual(C.cleanName('<b>Ana</b>\u0007'), 'Ana');
  assert.strictEqual(C.cleanName('<img src=x onerror=alert(1)>'), '', 'nothing left of pure markup');
  assert.strictEqual(C.cleanName('\u202eAna\u202c'), 'Ana');
  assert.strictEqual(C.cleanName({ toString: () => 'Ana' }), '', 'only strings');
  assert.strictEqual(Array.from(C.cleanName('x'.repeat(9000))).length, C.LIMITS.name);
  assert.strictEqual(Array.from(C.cleanOrg('y'.repeat(9000))).length, C.LIMITS.org);
  for (const h of HOSTILE) for (const f of [C.cleanName, C.cleanOrg]) assert.ok(!/[<>\u202a-\u202e\u2066-\u2069]/.test(f(h)), `${JSON.stringify(h)}`);
  assert.ok(C.clean('a'.repeat(5e6), 60).length <= 60, 'huge input is cut before any pattern runs');
});

/* ---------------- the scenarios ---------------- */

test('the built-ins: five team scenarios plus the demo, the Friction one by title, every one through the same door unchanged', () => {
  const titles = C.SCENARIOS.map((s) => s.title);
  for (const t of ['Ransomware on Monday morning', 'A leaked customer list', 'The AI agent that emailed the wrong people', 'The payroll email that wasn’t from the CEO', 'The website is down on launch day']) assert.ok(titles.includes(t), t);
  assert.strictEqual(C.SCENARIOS.filter((s) => !s.demo).length, 5);
  assert.strictEqual(C.scenarioById(C.DEMO_ID).demo, true);
  assert.strictEqual(new Set(C.SCENARIOS.map((s) => s.id)).size, C.SCENARIOS.length);
  for (const s of C.SCENARIOS) {
    const r = C.cleanScenario(s, { minInjects: s.demo ? 4 : 6 });
    assert.deepStrictEqual(r.problems, [], s.id);
    assert.deepStrictEqual(r.scenario, s, `${s.id} is already clean: the door changes nothing in it`);
    if (!s.demo) assert.ok(s.injects.length >= 6 && s.injects.length <= 9, `${s.id}: 6-9 injects`);
  }
  assert.strictEqual(C.scenarioById(C.DEMO_ID).injects.length, 4, 'the demo is four decisions');
});

test('every inject is reachable, every branch ends, time only moves forward, every inject lands on a role and has a right and a wrong answer', () => {
  for (const s of C.SCENARIOS) {
    const ps = C.paths(s);
    assert.ok(ps.length >= 1);
    const seen = new Set(ps.flat());
    for (const i of s.injects) assert.ok(seen.has(i.id), `${s.id}/${i.id} is reachable`);
    for (const p of ps) {
      assert.strictEqual(p[0], s.injects[0].id);
      assert.ok(s.demo ? p.length === 4 : p.length >= 5 && p.length <= 9, `${s.id}: a path of ${p.length}`);
      for (let k = 1; k < p.length; k++) assert.ok(C.injectOf(s, p[k]).at > C.injectOf(s, p[k - 1]).at, `${s.id}: ${p[k - 1]} -> ${p[k]} goes forward in time`);
      const last = C.injectOf(s, p[p.length - 1]);
      assert.ok(last.choices.some((c) => c.next === 'end'), `${s.id}: ${last.id} ends`);
    }
    if (!s.demo) assert.ok(ps.length >= 2, `${s.id} branches`);
    for (const i of s.injects) {
      assert.ok(C.ROLE_IDS.includes(i.to));
      assert.ok(i.choices.length >= 2 && i.choices.length <= 4);
      assert.ok(i.tests.every((t) => C.ITEMS[t]));
      assert.ok(i.choices.some((c) => Object.values(c.hits).includes(2)), `${s.id}/${i.id} has a good answer`);
      assert.ok(i.choices.some((c) => i.tests.some((t) => c.hits[t] !== 2)), `${s.id}/${i.id} has a weak one`);
      for (const c of i.choices) {
        assert.ok(c.then.length > 10, `${s.id}/${i.id}/${c.id} has a consequence`);
        assert.ok(Object.keys(c.hits).every((t) => i.tests.includes(t)), 'hits only on tested items');
      }
    }
  }
  const roles = new Set(C.SCENARIOS.flatMap((s) => s.injects.map((i) => i.to)));
  assert.deepStrictEqual([...roles].sort(), [...C.ROLE_IDS].sort(), 'every role gets an inject somewhere');
  const items = new Set(C.SCENARIOS.flatMap((s) => s.injects.flatMap((i) => i.tests)));
  assert.deepStrictEqual([...items].sort(), [...C.ITEM_IDS].sort(), 'every checklist item is tested somewhere');
});

test('regulator clocks are "check the rules where you operate", with examples - never legal advice', () => {
  const text = JSON.stringify(C.SCENARIOS) + JSON.stringify(C.ITEMS) + C.NOT_ADVICE;
  assert.ok(!/you must (report|notify)|legally required|required by law|you are required|is reportable/i.test(text));
  assert.match(C.ITEMS.r_clock.fix, /check them|where you and your customers are/);
  assert.match(text, /GDPR’s 72 hours/);
  assert.match(text, /US state breach law/);
  assert.match(C.NOT_ADVICE, /not legal advice/);
  const md = C.reportMarkdown(C.report(C.scenarioById('ransomware'), [], {}));
  assert.ok(md.includes(C.NOT_ADVICE.replace(/-/g, '-')), 'the report says so');
});

test('the clock: wall time and "45 minutes in", across days', () => {
  const s = C.scenarioById('ransomware');
  assert.deepStrictEqual(C.clock(s, 0), { wall: 'Mon 8:12 AM', since: 'The start' });
  assert.deepStrictEqual(C.clock(s, 45), { wall: 'Mon 8:57 AM', since: '45 minutes in' });
  assert.deepStrictEqual(C.clock(s, 90), { wall: 'Mon 9:42 AM', since: '1 hour 30 min in' });
  assert.deepStrictEqual(C.clock(s, 240), { wall: 'Mon 12:12 PM', since: '4 hours in' });
  assert.deepStrictEqual(C.clock(s, 1440), { wall: 'Tue 8:12 AM', since: '1 day in' });
  assert.strictEqual(C.clock(C.scenarioById('bec'), 7200).wall, 'Wed 4:20 PM', 'Friday plus five days wraps the week');
  assert.strictEqual(C.sinceLabel(1), '1 minute in');
});

/* ---------------- the door for custom scenarios ---------------- */

function customish() {
  return JSON.parse(JSON.stringify({ ...C.scenarioById('outage'), id: 'cabcdefghijk', custom: true }));
}
test('cleanScenario refuses what would break a drill: back in time, unreachable, unknown role, no consequence, too few, nothing ends', () => {
  const ok = C.cleanScenario(customish());
  assert.deepStrictEqual(ok.problems, []);
  assert.strictEqual(ok.scenario.custom, true);
  const bad = (mut, re) => { const s = customish(); mut(s); const r = C.cleanScenario(s); assert.strictEqual(r.scenario, null, String(re)); assert.ok(r.problems.some((p) => re.test(p)), `${re}: ${r.problems.join(' | ')}`); };
  bad((s) => { s.injects[3].choices[0].next = s.injects[0].id; }, /back in time/);
  bad((s) => { s.injects[2].choices[0].next = 'nope'; }, /does not exist/);
  bad((s) => { s.injects[1].to = 'ceo'; }, /known role/);
  bad((s) => { s.injects[1].choices[1].then = '<b></b>'; }, /consequence/);
  bad((s) => { s.injects = s.injects.slice(0, 3); }, /Between 6 and 9/);
  bad((s) => { s.injects.push(...customish().injects.map((i) => ({ ...i, id: `${i.id}x` }))); }, /Between 6 and 9/);
  bad((s) => { s.injects.forEach((i) => i.choices.forEach((c) => { if (c.next === 'end') c.next = 'w6'; })); s.injects[7].choices.forEach((c) => { c.next = 'w6'; }); }, /back in time|Nothing ends/);
  bad((s) => { s.injects[1].tests = ['made_up']; }, /checklist items/);
  bad((s) => { s.injects[1].choices[1].text = s.injects[1].choices[0].text.toUpperCase(); }, /same as another/);
  bad((s) => { s.injects[4].choices.forEach((c) => { c.hits = {}; }); }, /fully right/);
  bad((s) => { s.injects[0].at = 5; }, /minute 0/);
  bad((s) => { s.injects[5].at = 99999; }, /whole minutes/);
  bad((s) => { s.title = 'x'; }, /title/);
  // An inject nothing leads to.
  bad((s) => { s.injects[2].choices.forEach((c) => { c.next = 'w3'; }); s.injects[0].choices.forEach((c) => { c.next = 'w2'; }); }, /nothing leads to it/);
  // Hits on untested or made-up items, and points other than 1 or 2, are dropped, not trusted.
  const s = customish();
  s.injects[0].choices[1].hits = [{ item: 'made_up', points: 2 }, { item: 'v_rollback', points: 7 }, { item: 'v_rollback', points: 1 }, { item: 'p_staff', points: 2 }];
  assert.deepStrictEqual(C.cleanScenario(s).scenario.injects[0].choices[1].hits, { v_rollback: 1 });
  // Hostile text is cleaned, not refused.
  const h = customish();
  h.title = `<img src=x onerror=alert(1)>Launch \u202eday`;
  h.injects[0].text = `"><svg onload=alert(1)>${h.injects[0].text}${'z'.repeat(5000)}`;
  const hc = C.cleanScenario(h).scenario;
  assert.ok(!/[<>\u202e]/.test(JSON.stringify(hc)));
  assert.ok(hc.injects[0].text.length <= C.LIMITS.injectText);
  assert.strictEqual(C.cleanScenario(null).scenario, null);
  assert.strictEqual(C.cleanScenario([]).scenario, null);
});

/* ---------------- scoring and the report ---------------- */

test('scoring: the best walk scores high, the worst scores zero, and the report names gaps, owners and a timeline', () => {
  for (const s of C.SCENARIOS) {
    const hi = C.report(s, walk(s, best), { date: '2026-10-19' });
    const lo = C.report(s, walk(s, worst), { date: '2026-10-19' });
    assert.ok(hi.score >= 80, `${s.id} best walk ${hi.score}`);
    assert.strictEqual(lo.score, 0, `${s.id} worst walk`);
    assert.strictEqual(lo.band.id, 'gap');
    assert.ok(hi.complete && lo.complete);
    assert.strictEqual(lo.gaps.length, 3, 'three gaps');
    assert.ok(lo.gaps.every((g) => C.ROLE_IDS.includes(g.owner) && g.fix && g.ownerLabel));
    assert.strictEqual(lo.went.length, 0);
    assert.ok(lo.actions.length >= 2 && lo.actions.length <= 6 && /next drill/.test(lo.actions[lo.actions.length - 1].text));
    assert.strictEqual(lo.timeline.length, walk(s, worst).length);
    assert.ok(hi.areas.every((a) => a.pct === null || (a.pct >= 0 && a.pct <= 100)));
  }
  const s = C.scenarioById('ransomware');
  const r = C.report(s, [{ inject: 'r1', choice: 'a' }], { mode: 'room', people: [{ name: '<b>Ana</b>', role: 'it' }] });
  assert.deepStrictEqual(r.areas.find((a) => a.id === 'contain'), { id: 'contain', label: 'Contain it', blurb: C.AREAS[1].blurb, earned: 2, possible: 2, pct: 100, band: { id: 'ready', label: 'Ready' } });
  assert.strictEqual(r.areas.find((a) => a.id === 'insurer').pct, null, 'untested areas say so');
  assert.strictEqual(r.complete, false, 'stopped early');
  assert.deepStrictEqual(r.people, [{ name: 'Ana', role: 'IT' }]);
  assert.deepStrictEqual(C.bandOf(80), { id: 'ready', label: 'Ready' });
  assert.deepStrictEqual(C.bandOf(79), { id: 'partly', label: 'Partly ready' });
  assert.deepStrictEqual(C.bandOf(49), { id: 'gap', label: 'Gap' });
});

test('decisions must be a real walk: an inject out of order, a made-up choice or a forged vote count is cut off', () => {
  const s = C.scenarioById('ransomware');
  assert.deepStrictEqual(C.cleanDecisions(s, [{ inject: 'r2', choice: 'a' }]), [], 'must start at the first inject');
  assert.strictEqual(C.cleanDecisions(s, [{ inject: 'r1', choice: 'a' }, { inject: 'r1b', choice: 'a' }]).length, 1, 'r1/a leads to r2, not r1b');
  assert.strictEqual(C.cleanDecisions(s, [{ inject: 'r1', choice: 'z' }]).length, 0);
  assert.deepStrictEqual(C.cleanDecisions(s, [{ inject: 'r1', choice: 'a', by: 'hacker', votes: { a: 2, x: 9, b: -1, c: 1e9 } }])[0], { inject: 'r1', choice: 'a', by: 'solo', votes: { a: 2 }, late: false });
  assert.strictEqual(C.cleanDecisions(s, 'nope').length, 0);
  assert.strictEqual(C.finished(s, walk(s, best)), true);
});

test('votes: the leading choice wins, a tie goes to the first listed, no votes means the team froze', () => {
  const inj = C.injectOf(C.scenarioById('ransomware'), 'r1');
  assert.strictEqual(C.leading(inj, { p1: 'b', p2: 'b', p3: 'a' }), 'b');
  assert.strictEqual(C.leading(inj, { p1: 'c', p2: 'b' }), 'b', 'tie: first in the list');
  assert.strictEqual(C.leading(inj, {}), 'c', 'nobody voted: the choice that does least');
  assert.strictEqual(C.worstChoice(inj), 'c');
  assert.deepStrictEqual(C.tally(inj, { p1: 'a', p2: 'zzz', p3: '__proto__' }), { a: 1, b: 0, c: 0 });
});

test('Markdown and the printable page: every typed or custom string escaped, no script, the disclaimer on both', () => {
  const s = C.cleanScenario({ ...customish(), title: 'Launch day *bold* [link](x)' }).scenario;
  const rep = C.report(s, walk(s, worst), { mode: 'room', date: '2026-10-19', org: '<img src=x onerror=alert(1)>Acme & Co "quoted"', people: [{ name: '"><svg onload=alert(1)>Ana', role: 'it' }, { name: 'Bo', role: 'nope' }] });
  assert.strictEqual(rep.org, 'Acme & Co "quoted"');
  const md = C.reportMarkdown(rep);
  assert.ok(md.includes('Launch day \\*bold\\* \\[link\\](x)'), 'markdown punctuation escaped');
  assert.ok(!/<img|<svg/.test(md));
  assert.match(md, /## The three gaps to fix/);
  assert.match(md, /\| Action \| Owner \| Done \|/);
  const html = C.reportHtml(rep);
  assert.ok(!/<script/i.test(html) && !/\son[a-z]+=/i.test(html), 'no script, no handlers');
  assert.ok(html.includes('Acme &amp; Co &quot;quoted&quot;'));
  assert.ok(html.includes('&quot; Ana (IT)') && html.includes('Bo (Owner)'), 'names escaped; an unknown role reads as Owner');
  assert.ok(html.includes(C.NOT_ADVICE.replace(/’/g, '&#39;').replace(/’/g, "'")) || html.includes('not legal advice'));
  assert.strictEqual(C.slug('Ransomware on Monday morning!'), 'ransomware-on-monday-morning');
});

/* ---------------- the page and the code ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('link', 'accent-soft'); ok('accent-ink', 'accent'); ok('err', 'card'); ok('err', 'bg');
    for (const bg of ['board', 'board2']) for (const fg of ['board-ink', 'board-muted', 'signal']) ok(fg, bg);
    for (const b of ['ready', 'partly', 'gap', 'none']) { ok(b, `${b}-bg`); }
    ok('ready', 'card2'); ok('gap', 'card2'); ok('partly', 'card2');
    ok('text', 'card2'); ok('bg', 'text'); // the toast
    ok('accent', 'card', 3); ok('accent', 'bg', 3); // focus ring, meters
  }
  for (const c of ['#b4232a', '#1e2a44']) assert.ok(ratio('#ffffff', c) >= 4.5, `lab card colour ${c} holds white text`);
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { DRILL_MEMORY: '1' }], ['./lib/fakeai', { DRILL_FAKE_AI: '1' }], ['./server', { DRILL_FAKE_AI: '1', DRILL_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, DRILL_MEMORY: '', DRILL_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; single-field queries only, so no composite index', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: ROOT, env: { ...process.env, DRILL_MEMORY: '', DRILL_COLLECTION_PREFIX: 'drill_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = read('lib/store.js');
  assert.ok(/DRILL_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  const queries = [...server.matchAll(/where: \[(\[[^\]]*\](?:, )?)+\]/g)];
  assert.ok(queries.length >= 1);
  for (const m of queries) assert.strictEqual((m[0].match(/\['/g) || []).length, 1, `one equality filter per query: ${m[0]}`);
  assert.ok(!/orderBy/.test(server));
  assert.deepStrictEqual(Object.keys(require('../package.json').dependencies).sort(), ['@anthropic-ai/sdk', '@google-cloud/firestore', '@simplewebauthn/server', 'express'], 'only the host’s shared dependencies');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, everything escaped, nothing logged from a body', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/<script/i.test(js));
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js) && !/location\.href = ['"]\//.test(js), 'every browser URL is relative to BASE');
  // Every server- or user-sourced field drawn into markup goes through esc().
  for (const f of ['name', 'title', 'text', 'then', 'blurb', 'display', 'label', 'fix', 'message', 'org']) {
    const raw = new RegExp(`'\\s*\\+\\s*[a-zA-Z0-9_.]+\\.${f}\\s*\\+\\s*'`, 'g');
    const bad = (js.match(raw) || []).filter((m) => !/C\.LIMITS\./.test(m));
    assert.deepStrictEqual(bad, [], `.${f} drawn without esc(): ${bad.join(' ')}`);
  }
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + read('public/drill-core.js')), 'no email address in the page');
  assert.ok(!/Math\.random|Date\.now\(\)/.test(read('public/drill-core.js')), 'the core has no dice and no clock');
  assert.match(js, /prefers-reduced-motion/);
  for (const f of ['server.js', 'lib/ai.js', 'lib/rooms.js', 'public/drill-core.js']) {
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|about|tools|name)/.test(read(f)), `${f} logs a body`);
  }
  const sw = read('public/sw.js');
  assert.ok(/indexOf\('api\/'\) === 0 \|\| rel\.indexOf\('r\/'\) === 0/.test(sw), 'the service worker never caches the API or a room');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
async function openRoom(c, extra = {}) {
  const r = await c('POST', '/api/rooms', { scenario: 'ransomware', name: 'Maya', role: 'owner', timerSec: 0, ...extra });
  assert.strictEqual(r.status, 200, r.text);
  return { code: r.data.code, key: r.data.key, room: r.data.room, host: { 'X-Drill-Key': r.data.key } };
}
async function join(code, name, role, c = client()) {
  const r = await c('POST', `/api/rooms/${code}/join`, { name, role });
  assert.strictEqual(r.status, 200, r.text);
  return { c, room: r.data.room };
}

test('signed out: the demo, solo and rooms work with zero model calls; the metered route answers 401 before reading a big body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.roles.length, meta.areas.length, meta.limits.roomHours], [6, 7, 48]);
  for (const f of ['drill-core.js', 'app.js', 'app.css', 'qr.js', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/custom', { about: 'We sell candles online.' })).status, 401);
  assert.strictEqual((await anon('POST', '/api/custom', { about: 'x'.repeat(200 * 1024) })).status, 401, 'the gate answers before the 8 KB parser');
  assert.strictEqual((await anon('GET', '/api/library')).status, 401);
  assert.strictEqual((await anon('POST', '/api/rooms', { scenario: 'ransomware', name: 'x'.repeat(40 * 1024), role: 'it' })).status, 413, 'every other route keeps the small limit');
  const { code } = await openRoom(anon);
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  const deep = await fetch(`${base}/r/${code}`);
  assert.strictEqual(deep.status, 200);
  assert.ok((await deep.text()).includes('<base href="../">'), 'a join link resolves assets from the app root');
  assert.strictEqual(deep.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(deep.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.strictEqual((await fetch(`${base}/r/${code}`, { method: 'POST' })).status, 405);
  assert.strictEqual((await anon('POST', '/api/rooms', { custom: 'cabcdefghijk', name: 'Maya', role: 'owner' })).status, 401, 'a custom scenario needs its owner signed in');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route’s gates come before its parser, in order; one model client in the whole server', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/custom', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to one metered call');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('a room over HTTP: three phones join, vote, the facilitator locks and moves on, to the report', async () => {
  const hostC = client();
  const { code, host, room } = await openRoom(hostC);
  assert.deepStrictEqual([room.phase, room.host, room.people.length, room.display], ['lobby', true, 1, `${code.slice(0, 3)}-${code.slice(3)}`]);
  assert.match(hostC.cookies.drill_k || '', /^[A-Za-z0-9_-]{22}$/);
  const dev = await join(code, 'Dev', 'it');
  const pri = await join(code.toLowerCase().replace(/(...)/, '$1-'), 'Priya', 'finance');
  assert.strictEqual(pri.room.people.length, 3, 'codes are read however they are typed');
  assert.strictEqual((await join(code, 'Dev again', 'ops', dev.c)).room.people.length, 3, 'a phone that joined gets its own seat back');
  assert.strictEqual((await client()('POST', `/api/rooms/${code}/join`, { name: 'dev', role: 'it' })).status, 409, 'two Devs need an initial');
  assert.strictEqual((await client()('POST', `/api/rooms/${code}/join`, { name: 'Zed', role: 'ceo' })).status, 400, 'a known role');
  assert.strictEqual((await dev.c('POST', `/api/rooms/${code}/vote`, { choice: 'a' })).status, 409, 'nothing to vote on in the lobby');
  // Only the facilitator's key runs the room; anyone else gets the 404 a missing code gets.
  const missing = await client()('GET', '/api/rooms/ZZZZZZ');
  for (const h of [{}, { 'X-Drill-Key': R.newKey() }]) {
    const r = await dev.c('POST', `/api/rooms/${code}/host`, { action: 'start' }, h);
    assert.deepStrictEqual([r.status, r.data.error], [404, missing.data.error]);
  }
  assert.strictEqual((await hostC('POST', `/api/rooms/${code}/host`, { action: 'explode' }, host)).status, 400);
  let r = await hostC('POST', `/api/rooms/${code}/host`, { action: 'start' }, host);
  assert.deepStrictEqual([r.data.room.phase, r.data.room.inject.id, r.data.room.inject.to, r.data.room.inject.wall], ['deciding', 'r1', 'it', 'Mon 8:12 AM']);
  assert.ok(r.data.room.guide && r.data.room.guide.length === 3, 'the facilitator has notes');
  // Twelve votes at once from three phones: every one counted once, the last word per phone wins.
  await Promise.all([dev.c, pri.c, hostC, dev.c, pri.c, hostC].map((c, i) => c('POST', `/api/rooms/${code}/vote`, { choice: ['b', 'b', 'a', 'a', 'a', 'a'][i] })));
  r = await dev.c('GET', `/api/rooms/${code}`);
  const counted = Object.values(r.data.room.votes).reduce((s, v) => s + v.length, 0);
  assert.strictEqual(counted, 3, 'one vote per person');
  assert.strictEqual((await pri.c('POST', `/api/rooms/${code}/vote`, { choice: 'z' })).status, 400);
  await pri.c('POST', `/api/rooms/${code}/vote`, { choice: 'b' });
  await dev.c('POST', `/api/rooms/${code}/vote`, { choice: 'a' });
  await hostC('POST', `/api/rooms/${code}/vote`, { choice: 'a' });
  r = await hostC('POST', `/api/rooms/${code}/host`, { action: 'lock' }, host);
  assert.deepStrictEqual([r.data.room.phase, r.data.room.result.choice, r.data.room.timeline[0].votes], ['locked', 'a', 3], 'the leading vote locks');
  assert.deepStrictEqual(r.data.room.result.tested.map((t) => t.points), [2, 2]);
  const v = r.data.room.v;
  assert.deepStrictEqual((await dev.c('GET', `/api/rooms/${code}?since=${v}`)).data, { same: true, v }, 'a poll with nothing new is one line');
  // On to the end: lock whatever, next, until done.
  for (let i = 0; i < 20; i++) {
    const cur = (await hostC('GET', `/api/rooms/${code}`, undefined, host)).data.room;
    if (cur.phase === 'done') break;
    if (cur.phase === 'locked') await hostC('POST', `/api/rooms/${code}/host`, { action: 'next' }, host);
    else await hostC('POST', `/api/rooms/${code}/host`, { action: 'lock', choice: 'a' }, host);
  }
  const done = (await pri.c('GET', `/api/rooms/${code}`)).data.room;
  assert.strictEqual(done.phase, 'done');
  assert.ok(done.report.complete && done.report.score > 0);
  assert.deepStrictEqual(done.report.people, [{ name: 'Maya', role: 'Owner' }, { name: 'Dev', role: 'IT' }, { name: 'Priya', role: 'Finance' }]);
  assert.strictEqual((await client()('POST', `/api/rooms/${code}/join`, { name: 'Late', role: 'it' })).status, 409, 'a finished drill takes nobody new');
  // Delete: the facilitator only.
  assert.strictEqual((await dev.c('DELETE', `/api/rooms/${code}`)).status, 404);
  assert.strictEqual((await hostC('DELETE', `/api/rooms/${code}`, undefined, host)).status, 200);
  assert.strictEqual((await dev.c('GET', `/api/rooms/${code}`)).status, 404);
});

test('the decision clock: no server timer - the read that finds it run out locks the leading vote, or the team froze', async () => {
  const hostC = client();
  const { code, host } = await openRoom(hostC, { timerSec: 60 });
  const a = await join(code, 'Ana', 'it');
  let r = await hostC('POST', `/api/rooms/${code}/host`, { action: 'start' }, host);
  assert.ok(Date.parse(r.data.room.deadline) > Date.now() + 55000);
  await a.c('POST', `/api/rooms/${code}/vote`, { choice: 'b' });
  await store.merge('rooms', code, { deadline: new Date(Date.now() - 1000).toISOString() });
  r = await a.c('GET', `/api/rooms/${code}`);
  assert.deepStrictEqual([r.data.room.phase, r.data.room.result.choice, r.data.room.timeline[0].by], ['locked', 'b', 'timer']);
  await hostC('POST', `/api/rooms/${code}/host`, { action: 'next' }, host);
  await store.merge('rooms', code, { deadline: new Date(Date.now() - 1000).toISOString() });
  r = await a.c('GET', `/api/rooms/${code}`);
  const inj = C.injectOf(C.scenarioById('ransomware'), r.data.room.timeline[1].inject);
  assert.strictEqual(r.data.room.result.choice, C.worstChoice(inj), 'nobody voted: the team froze');
  r = await hostC('POST', `/api/rooms/${code}/host`, { action: 'timer', sec: 0 }, host);
  assert.strictEqual(r.data.room.timerSec, 0);
  assert.strictEqual((await hostC('POST', `/api/rooms/${code}/host`, { action: 'timer', sec: 7 }, host)).status, 400);
  r = await hostC('POST', `/api/rooms/${code}/host`, { action: 'finish' }, host);
  assert.deepStrictEqual([r.data.room.phase, r.data.room.report.complete], ['done', false], 'ended early, the report covers what was decided');
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
});

test('what a room reveals: names and roles as typed, the current inject - never a key, a hash, a tag, a future inject or an unchosen consequence', async () => {
  const me = await register('maya.facilitator@example.com');
  const { code, host, key } = await openRoom(me, { name: '<img src=x onerror=alert(1)>Maya' });
  const a = await join(code, '"><svg onload=alert(1)>Ana', 'it');
  await join(code, '\u202eBo', 'comms');
  await me('POST', `/api/rooms/${code}/host`, { action: 'start' }, host);
  const guest = await a.c('GET', `/api/rooms/${code}`);
  const g = guest.data.room;
  assert.deepStrictEqual(Object.keys(g).sort(), ['code', 'deadline', 'display', 'expiresAt', 'host', 'inject', 'me', 'now', 'people', 'phase', 'report', 'result', 'scenario', 'step', 'timeline', 'timerSec', 'v', 'votes'].sort());
  assert.deepStrictEqual(Object.keys(g.inject).sort(), ['at', 'choices', 'id', 'since', 'text', 'title', 'to', 'wall']);
  assert.ok(g.inject.choices.every((c) => Object.keys(c).sort().join() === 'id,text'), 'choices without consequences or scores');
  assert.ok(g.people.every((p) => Object.keys(p).sort().join() === 'host,id,name,role'));
  assert.deepStrictEqual(g.people.map((p) => p.name), ['Maya', '" Ana', 'Bo']);
  assert.ok(!('guide' in g), 'no facilitator notes for a guest');
  const doc = await store.get('rooms', code);
  const leaks = [key, doc.hostHash, doc.creator, ...doc.people.map((p) => p.keyHash), a.c.cookies.drill_k, 'maya.facilitator', uidOf('maya.facilitator@example.com')];
  for (const s of leaks) assert.ok(!guest.text.includes(s), `the room view leaks ${s}`);
  const unchosen = C.scenarioById('ransomware').injects.filter((i) => i.id !== 'r1').map((i) => i.text);
  for (const t of unchosen) assert.ok(!guest.text.includes(t.slice(0, 40)), 'no future inject');
  for (const c of C.injectOf(C.scenarioById('ransomware'), 'r1').choices) assert.ok(!guest.text.includes(c.then.slice(0, 40)), 'no consequence before the lock');
  assert.ok(!/[<>\u202e]/.test(guest.text), 'no markup or bidi in what a phone is sent');
  assert.deepStrictEqual(Object.keys(doc).sort(), ['code', 'createdAt', 'creator', 'current', 'custom', 'deadline', 'decisions', 'expiresAt', 'hostHash', 'id', 'people', 'phase', 'scenarioId', 'timerSec', 'updatedAt', 'v', 'votes'].sort(), 'exactly what is stored');
  assert.match(doc.creator, /^a:[A-Za-z0-9_-]{27}$/, 'a signed-in facilitator is an HMAC tag');
  assert.ok(!store._dump().includes('maya.facilitator') && !store._dump().includes(uidOf('maya.facilitator@example.com')), 'no account id or email stored');
  assert.ok(!store._dump().includes(key), 'the facilitator key is not stored');
});

test('codes and expiry: unknown, malformed and expired read the same 404, and the read that finds an expired room deletes it', async () => {
  const codes = new Set();
  for (let i = 0; i < 300; i++) codes.add(R.newCode());
  assert.ok(codes.size >= 299);
  for (const c of codes) assert.ok(R.isCode(c) && !/[IO01]/.test(c));
  assert.deepStrictEqual([R.normalizeCode(' abc-def '), R.formatCode('abcdef')], ['ABCDEF', 'ABC-DEF']);
  const anon = client();
  const unknown = await anon('GET', '/api/rooms/ZZZZZZ');
  const bad = await anon('GET', '/api/rooms/not-a-code!!');
  assert.deepStrictEqual([unknown.status, bad.status, bad.data.error], [404, 404, unknown.data.error]);
  const { code } = await openRoom(client());
  await store.merge('rooms', code, { expiresAt: '2026-01-01T00:00:00.000Z' });
  const ex = await anon('GET', `/api/rooms/${code}`);
  assert.deepStrictEqual([ex.status, ex.data], [unknown.status, unknown.data]);
  assert.strictEqual(await store.get('rooms', code), null, 'deleted by the read that found it');
  const fresh = await openRoom(client());
  assert.ok(Date.parse(fresh.room.expiresAt) - Date.now() > 47.9 * 3600 * 1000, 'a room lasts 48 hours');
});

test('anonymous limits: 20 rooms per address an hour (IPv6 by its /64), 10 open per device, 24 people, distinct wrong codes', async () => {
  const net = '2001:db8:bbbb:1';
  for (let i = 0; i < R.LIMITS.roomsPerIp; i++) {
    const c = client(`${net}::${i + 1}`);
    assert.strictEqual((await c('POST', '/api/rooms', { scenario: 'leak', name: 'A', role: 'it' })).status, 200, `room ${i + 1}`);
  }
  const over = await client(`${net}::99`)('POST', '/api/rooms', { scenario: 'leak', name: 'A', role: 'it' });
  assert.deepStrictEqual([over.status, /20 rooms/.test(over.data.error)], [429, true]);
  // One device, many addresses: the open-room cap follows the device key.
  const phone = client();
  await openRoom(phone);
  const set = (await client()('POST', '/api/rooms', { scenario: 'leak', name: 'A', role: 'it' })).setCookie.join(';');
  assert.ok(/drill_k=[^;]+; Path=\/drill\/; Max-Age=\d+; SameSite=Lax; HttpOnly/.test(set), set);
  for (let i = 1; i < R.LIMITS.openPerCreator; i++) { const c = client(); Object.assign(c.cookies, phone.cookies); assert.strictEqual((await c('POST', '/api/rooms', { scenario: 'bec', name: 'A', role: 'it' })).status, 200); }
  const c11 = client(); Object.assign(c11.cookies, phone.cookies);
  const capped = await c11('POST', '/api/rooms', { scenario: 'bec', name: 'A', role: 'it' });
  assert.deepStrictEqual([capped.status, /10 drills open/.test(capped.data.error)], [429, true]);
  // 24 people a room.
  const { code } = await openRoom(client());
  for (let i = 1; i < R.LIMITS.people; i++) await join(code, `Person${i}`, 'ops');
  assert.strictEqual((await client()('POST', `/api/rooms/${code}/join`, { name: 'One more', role: 'ops' })).status, 409);
  // Distinct wrong codes: guessing stops; one dead code polled is not guessing.
  const guess = client();
  for (let i = 0; i < 40; i++) assert.strictEqual((await guess('GET', '/api/rooms/ZZZZZZ')).status, 404, 'the same dead code, again and again');
  for (let i = 0; i < R.LIMITS.missesPerIp - 1; i++) await guess('GET', `/api/rooms/${R.newCode()}`);
  assert.strictEqual((await guess('GET', `/api/rooms/${code}`)).status, 429, 'then even a real one waits');
  assert.strictEqual((await client()('GET', `/api/rooms/${code}`)).status, 200, 'for that address only');
  assert.match(read('server.js'), /opensAll\.blocked\('all'\)/, 'and a ceiling across the instance');
});

test('make it about us: input checked before any spend, one forced tool, validated before it is offered, saved to the account, playable in a room', async () => {
  const me = await register('ana.custom@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await me('POST', '/api/custom', { about: 'short' })).status, 400, 'say something about the business');
  assert.strictEqual((await me('POST', '/api/custom', { about: 'x'.repeat(2000) })).status, 400, 'over the limit');
  assert.strictEqual((await me('POST', '/api/custom', { about: 'x'.repeat(20 * 1024) })).status, 413, 'its own 8 KB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  assert.strictEqual(store._dump(), dump);
  const r = await me('POST', '/api/custom', { about: 'We sell handmade candles online, 9 people.', tools: 'Shopify, QuickBooks, Google Workspace', focus: 'outage' });
  assert.strictEqual(r.status, 200, r.text);
  const s = r.data.scenario;
  assert.ok(s && s.custom && /^c[a-z0-9]{11}$/.test(s.id));
  assert.match(s.title, /Shopify/);
  assert.deepStrictEqual(C.cleanScenario(s).problems, [], 'what is offered passes the door');
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const lib = (await me('GET', '/api/library')).data;
  assert.deepStrictEqual(lib.scenarios.map((x) => x.id), [s.id]);
  // A room runs it from the library, never from the request.
  const room = await me('POST', '/api/rooms', { custom: s.id, name: 'Ana', role: 'owner' });
  assert.strictEqual(room.status, 200, room.text);
  assert.strictEqual(room.data.room.scenario.title, s.title);
  assert.strictEqual((await me('POST', '/api/rooms', { custom: 'cnotmine0000', name: 'Ana', role: 'owner' })).status, 404);
  const other = await register('kim.other@example.com');
  assert.strictEqual((await other('POST', '/api/rooms', { custom: s.id, name: 'Kim', role: 'owner' })).status, 404, 'nobody else’s scenario');
  assert.deepStrictEqual((await other('GET', '/api/library')).data.scenarios, []);
  // Hostile output is cleaned; broken output is refused and nothing is saved.
  const inj = await me('POST', '/api/custom', { about: 'INJECT a small bakery with a website', tools: 'Squarespace' });
  assert.ok(inj.data.scenario, inj.text);
  assert.ok(!/[<>\u202e]/.test(JSON.stringify(inj.data.scenario)), 'no markup or bidi survives');
  assert.ok(inj.data.scenario.injects.every((i) => i.tests.every((t) => C.ITEMS[t]) && i.choices.every((c) => Object.values(c.hits).every((p) => p === 1 || p === 2))));
  const before = (await me('GET', '/api/library')).data.scenarios.length;
  for (const [trigger, re] of [['BLANK', /didn’t hold together/], ['BACKWARDS', /didn’t hold together/], ['MAXTOKENS', /ran long/]]) {
    const b = await me('POST', '/api/custom', { about: `${trigger} an accounting firm with 20 people` });
    assert.strictEqual(b.status, 200, 'streamed: the outcome is in the body');
    assert.ok(re.test(b.data.error), `${trigger}: ${b.text}`);
    assert.strictEqual(b.data.status, trigger === 'MAXTOKENS' ? 502 : 422);
  }
  const up = await me('POST', '/api/custom', { about: 'UPSTREAM401 a dental practice with two sites' });
  assert.ok(up.data.error && up.data.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await me('POST', '/api/custom', { about: 'UPSTREAM529 a dental practice with two sites' });
  assert.deepStrictEqual([busy.data.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual((await me('GET', '/api/library')).data.scenarios.length, before, 'nothing saved from a failure');
  // The library is bounded, and refused before anything is spent.
  for (let i = (await me('GET', '/api/library')).data.scenarios.length; i < C.LIMITS.library; i++) await me('POST', '/api/custom', { about: 'A florist with a delivery van and a website.' });
  const n = await modelCalls();
  const full = await me('POST', '/api/custom', { about: 'A florist with a delivery van and a website.' });
  assert.deepStrictEqual([full.status, /12 saved/.test(full.data.error)], [409, true]);
  await settle();
  assert.strictEqual(await modelCalls(), n, 'a full library spends nothing');
  assert.strictEqual((await me('DELETE', `/api/library/${s.id}`)).status, 200);
  assert.ok(!(await me('GET', '/api/library')).data.scenarios.some((x) => x.id === s.id));
  assert.ok(!store._dump().includes('handmade candles'), 'the description is never stored');
});

test('the model sees only the description, the tools and the kind of bad day - one forced tool, and its output goes through the door', async () => {
  const seen = [];
  const spy = { messages: { create: async (p) => { seen.push(p); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_scenario', input: { title: 'x' } }] }; } } };
  const b = ai.brief({ about: 'We run three cafés. <script>x</script>', tools: 'Square, Xero', focus: 'fraud', secret: 'SECRET-FIELD', name: 'SECRET-NAME' });
  assert.deepStrictEqual(Object.keys(b).sort(), ['about', 'focus', 'tools']);
  assert.strictEqual(ai.brief({ about: 'We run three cafés downtown.', focus: 'nonsense' }).focus, 'surprise');
  const raw = await ai.write(spy, 'claude-haiku-4-5', b);
  const p = seen[0];
  assert.deepStrictEqual(p.tool_choice, { type: 'tool', name: 'record_scenario' }, 'one forced tool');
  assert.ok(p.max_tokens <= 8000);
  const text = JSON.stringify(p.messages);
  assert.ok(!/SECRET|<script/.test(text));
  assert.ok(/three cafés/.test(text) && /Square, Xero/.test(text) && /payment fraud/.test(text));
  assert.match(p.system, /check the rules where you operate/);
  assert.match(p.system, /not legal advice/);
  assert.throws(() => ai.toScenario(raw, 'cabcdefghijk'), (e) => e.status === 422);
  assert.deepStrictEqual(ai.TOOL.input_schema.properties.injects.items.properties.to.enum, C.ROLE_IDS, 'the tool knows the roles');
  assert.deepStrictEqual(ai.TOOL.input_schema.properties.injects.items.properties.tests.items.enum, C.ITEM_IDS, 'and the checklist');
});

test('the gates: an unconfirmed free account gets verify-email 403, out of credit 402, the day’s free ceiling 503 - never a 413, never a model call', async () => {
  const ASK = { about: 'We sell bikes and repair them, 12 people.' };
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/custom', ASK);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/drill/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/custom', { about: 'x'.repeat(200 * 1024) })).status, 403, '403 before the body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/rooms', { scenario: 'agent', name: 'Eve', role: 'ops' })).status, 200, 'rooms need no AI and no confirmation');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/custom', ASK)).status, 402);
  assert.strictEqual((await cal('POST', '/api/custom', { about: 'x'.repeat(200 * 1024) })).status, 402, '402, not 413');
  const dan = await register('dan.capped@example.com');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-drill-${day}`, { usd: 5000 });
  try {
    const capped = await dan('POST', '/api/custom', ASK);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/custom', { about: 'x'.repeat(200 * 1024) })).status, 503, 'the ceiling answers before the parser too');
  } finally { await identityStore.remove('control', `free-spend-drill-${day}`); }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call behind any gate');
  assert.strictEqual((await dan('POST', '/api/custom', ASK)).status, 200, 'and it lifts when the day’s tally is under it');
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/drill' ? res.redirect(301, '/drill/') : next()));
  host.use('/drill', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/drill`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
