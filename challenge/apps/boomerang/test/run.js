// Pure rules first, then end to end against the memory store and the fake
// model:
//   BOOMERANG_MEMORY=1 BOOMERANG_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /boomerang, the
// way the lab mounts it, so the auth cookie, the budget gate, the receipt
// links, the device cookie's path and the metered route's parser are
// exercised as deployed. Model calls are counted from the identity's usage
// rows - the same rows that bill a real account.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.BOOMERANG_MEMORY !== '1' || process.env.BOOMERANG_FAKE_AI !== '1') {
  console.error('run with BOOMERANG_MEMORY=1 BOOMERANG_FAKE_AI=1');
  process.exit(1);
}
// A free-tier ceiling far above anything these tests spend, so the cap can be
// reached on purpose by writing the day's tally (and read fresh each time).
process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const { app, identityStore, store } = require('../server');
const C = require('../public/boomerang-core');
const H = require('../lib/handshakes');
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

/* ---------------- a little world for the pure tests ---------------- */

const T = '2026-10-18';
const loan = (o) => C.cleanLoan({ id: 'loan0000aa', dir: 'lent', item: 'Cordless drill', who: 'Sam', on: T, ...o }, T);
const HOSTILE = ['<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', '\u202eSam\u202c', 'Dr\u2066ill\u2069 <script>x</script>'];

/* ---------------- cleaning and the emoji guess ---------------- */

test('typed strings go through one door: no markup, no control or bidi characters, bounded', () => {
  assert.strictEqual(C.cleanItem('<b>Cordless</b> drill\u0007'), 'Cordless drill');
  assert.strictEqual(C.cleanItem('<img src=x onerror=alert(1)>'), '', 'nothing left of pure markup');
  assert.strictEqual(C.cleanName('"><svg onload=alert(1)>'), '', 'a tag with nothing after it is nothing');
  assert.strictEqual(C.cleanName('\u202eSam\u202c'), 'Sam', 'bidi overrides gone');
  assert.strictEqual(C.cleanName('\u2066Sam\u2069'), 'Sam', 'isolates gone');
  assert.strictEqual(C.cleanItem({ toString: () => 'drill' }), '', 'only strings');
  assert.strictEqual(Array.from(C.cleanItem('x'.repeat(9000))).length, C.LIMITS.item);
  assert.strictEqual(Array.from(C.cleanNote('n'.repeat(9000))).length, C.LIMITS.note);
  assert.strictEqual(C.cleanName('   '), '');
  for (const h of HOSTILE) for (const f of [C.cleanItem, C.cleanName, C.cleanNote, C.cleanHint]) {
    const out = f(h);
    assert.ok(!/[<>\u202a-\u202e\u2066-\u2069]/.test(out), `${JSON.stringify(h)} -> ${JSON.stringify(out)}`);
  }
  assert.strictEqual(C.cleanEmoji('🔧🔧'), '🔧', 'one emoji');
  assert.strictEqual(C.cleanEmoji('<b>'), '');
  assert.ok(C.clean('a'.repeat(5e6), 60).length <= 60, 'huge input is cut before any pattern runs');
});

test('the emoji guess is a fixed keyword map, read from the head noun back', () => {
  const cases = {
    'Cordless drill': '🔧', 'Book': '📚', 'The Thursday Murder Club': '📦', 'Ladder': '🪜', 'Casserole dish': '🥘',
    'Board game': '🎲', 'Catan': '🎲', 'Rain jacket': '🧥', 'Camping chair': '🪑', 'Sleeping bags': '🛌', 'Plant pot': '🪴',
    'Two-person tent': '⛺', 'Cake tin': '🎂', 'Blue umbrella': '☂️', 'Power drills': '🔧', 'something odd': '📦',
  };
  for (const [k, v] of Object.entries(cases)) assert.strictEqual(C.suggestEmoji(k), v, k);
  assert.strictEqual(C.guessEmoji('xyzzy'), null);
  assert.strictEqual(C.suggestEmoji('__proto__'), '📦', 'no prototype keys');
  assert.strictEqual(C.PICKER.length, 24);
  for (const e of C.PICKER) assert.strictEqual(C.cleanEmoji(e), e, `picker ${e} is one clean emoji`);
  assert.deepStrictEqual(['Cordless drill', 'Catan', 'Book', 'The Thursday Murder Club', 'iPad', 'Blue rain jacket'].map(C.itemPhrase),
    ['cordless drill', 'Catan', 'book', 'Thursday Murder Club', 'iPad', 'blue rain jacket'], 'reads in a sentence, names kept');
});

/* ---------------- the loan and its dates ---------------- */

test('a loan: needs an item and a person; dates are bounded by today', () => {
  assert.strictEqual(loan({ item: '  ' }), null);
  assert.strictEqual(loan({ who: '<b></b>' }), null);
  assert.strictEqual(C.cleanLoan({ id: 'BAD!', item: 'x', who: 'y' }, T), null, 'ids are checked');
  assert.strictEqual(C.cleanLoan(['x'], T), null);
  const l = loan({ emoji: '', due: '2026-11-01', note: '<i>blue case</i>' });
  assert.deepStrictEqual([l.dir, l.emoji, l.due, l.note, l.back, l.share], ['lent', '🔧', '2026-11-01', 'blue case', null, null]);
  assert.strictEqual(loan({ on: '2026-12-01' }).on, T, 'cannot start in the future');
  assert.strictEqual(loan({ on: '2026-02-30' }).on, T, 'not a real day');
  assert.strictEqual(loan({ on: '2026-10-10', due: '2026-10-01' }).due, null, 'not due before it left');
  assert.strictEqual(loan({ on: '2026-10-10', back: '2026-10-01' }).back, '2026-10-10', 'not back before it left');
  assert.strictEqual(loan({ back: '2026-12-01' }).back, T, 'not back in the future');
  assert.strictEqual(loan({ dir: 'stolen' }).dir, 'lent');
  assert.strictEqual(loan({ share: { token: 'x', key: 'y' } }).share, null, 'a share needs a real token');
  assert.deepStrictEqual(loan({ share: { token: 'A'.repeat(22), state: 'weird' } }).share, { token: 'A'.repeat(22), key: null, state: 'sent' }, 'a friend-side share has no key');
  assert.deepStrictEqual(Object.keys(C.toSaved(loan({ photo: true, sample: true }))).sort(), [...C.SAVED_FIELDS].sort(), 'the account never keeps the photo flag or the sample marker');
});

test('overdue, due soon, out and back - and the words for each', () => {
  const st = (o) => C.status(loan({ on: '2026-09-01', ...o }), T);
  assert.strictEqual(st({ due: '2026-10-17' }), 'overdue');
  assert.strictEqual(st({ due: T }), 'soon', 'due today is not late yet');
  assert.strictEqual(st({ due: '2026-10-21' }), 'soon', 'three days ahead is soon');
  assert.strictEqual(st({ due: '2026-10-22' }), 'out', 'four is not');
  assert.strictEqual(st({}), 'out', 'no date is never overdue');
  assert.strictEqual(st({ due: '2026-10-01', back: '2026-10-05' }), 'back', 'back trumps late');
  const t = (o) => C.dueText(loan({ on: '2026-09-01', ...o }), T);
  assert.deepStrictEqual([t({ due: '2026-10-17' }), t({ due: '2026-10-08' }), t({ due: T }), t({ due: '2026-10-19' }), t({ due: '2026-10-21' }), t({ due: '2026-11-01' }), t({}), t({ back: '2026-10-02' })],
    ['1 day late', '10 days late', 'Due today', 'Due tomorrow', 'Due in 3 days', 'Back by Nov 1', 'No date set', 'Back Oct 2']);
  assert.strictEqual(C.dueText(loan({ on: '2026-09-01', due: '2027-01-03' }), T), 'Back by Jan 3, 2027', 'another year says so');
  assert.strictEqual(C.daysBetween('2026-12-31', '2027-01-01'), 1, 'across a year');
  assert.strictEqual(C.daysBetween('2026-03-28', '2026-03-30'), 2, 'across a clock change (days are UTC)');
  assert.strictEqual(C.whoLine(loan({ on: '2026-07-16' }), T), 'with Sam · 94 days');
  assert.strictEqual(C.whoLine(loan({ dir: 'borrowed', who: 'Mum', on: '2026-10-06' }), T), 'from Mum · 12 days');
  assert.strictEqual(C.whoLine(loan({ on: '2026-09-01', back: '2026-09-14' }), T), 'with Sam · back after 13 days');
  assert.strictEqual(C.localDay(new Date(2026, 9, 18, 23, 30)), T, 'the page’s today is the phone’s local day');
});

test('the shelf sorts each band the way it is read; the stats have personality', () => {
  const s = C.sample(T);
  assert.strictEqual(s.length, 8);
  assert.ok(s.every((l) => l && l.sample), 'every sample loan is clean and marked');
  const g = C.shelf(s, T);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((l) => l.item)])), {
    overdue: ['Cordless drill'],
    soon: ['The Thursday Murder Club', 'Two-person tent'],
    out: ['Ladder', 'Casserole dish'],
    back: ['Catan', 'Cake tin', 'Rain jacket'],
  });
  assert.deepStrictEqual(C.shelf(s, T, 'borrowed').out.map((l) => l.who), ['Mum']);
  const st = C.stats(s, T);
  assert.deepStrictEqual([st.lentOut, st.borrowedOut, st.overdue], [3, 2, 1]);
  assert.strictEqual(st.oldest.line, 'Your cordless drill has been on holiday for 94 days');
  assert.deepStrictEqual(st.returns, { back: 2, of: 5, pct: 40 });
  assert.deepStrictEqual([st.reliable.who, st.reliable.line], ['Jordan', '2 things back on time']);
  assert.deepStrictEqual([st.bestLender.who, st.bestLender.line], ['Mum', 'lent you 2 things']);
  const none = C.stats([], T);
  assert.deepStrictEqual([none.oldest, none.returns, none.reliable, none.bestLender], [null, null, null, null]);
  // On time beats more: someone with two late returns is not "most reliable".
  const mk = (id, who, due, back) => loan({ id, who, on: '2026-08-01', due, back });
  const r = C.stats([mk('aaaaaaaa1', 'Ana', '2026-08-10', '2026-08-20'), mk('aaaaaaaa2', 'Ana', '2026-08-10', '2026-08-25'), mk('aaaaaaaa3', 'Ben', '2026-08-10', '2026-08-09')], T);
  assert.strictEqual(r.reliable.who, 'Ben');
  for (const l of s) assert.strictEqual(C.holidayLine(l, T), C.holidayLine(l, T), 'the same line every time');
});

/* ---------------- the handshake state machine ---------------- */

function hs(dir = 'lent') {
  const now = Date.parse('2026-10-18T10:00:00Z');
  return { ...C.newHandshake({ item: 'Cordless drill', who: 'Sam', me: 'Erik', dir, on: T, due: '2026-11-01', note: 'blue case' }, { now, today: T }), id: 'x' };
}
const tryStep = (h, actor, what) => { try { return { ...h, ...C.step(h, actor, what, Date.parse('2026-10-20T10:00:00Z')) }; } catch (e) { return e.status; } };

test('handshake: sent -> confirmed -> returning -> closed, and only those', () => {
  const h = hs();
  assert.deepStrictEqual([h.lender, h.borrower, h.state], ['Erik', 'Sam', 'sent']);
  assert.deepStrictEqual([C.sideOf(h, 'owner'), C.sideOf(h, 'friend')], ['lender', 'borrower']);
  assert.deepStrictEqual(C.allowed(h, 'friend'), ['confirm']);
  assert.deepStrictEqual(C.allowed(h, 'owner'), ['back'], 'the lender can close at any time');
  assert.strictEqual(tryStep(h, 'friend', 'gave'), 409, 'Got it first');
  assert.strictEqual(tryStep(h, 'owner', 'confirm'), 403, 'the owner cannot confirm their own receipt');
  assert.strictEqual(tryStep(h, 'friend', 'back'), 403, 'the borrower cannot close it');
  assert.strictEqual(tryStep(h, 'friend', 'explode'), 400);
  assert.strictEqual(tryStep(h, 'stranger', 'confirm'), 403);
  const c = tryStep(h, 'friend', 'confirm');
  assert.strictEqual(c.state, 'confirmed');
  assert.ok(c.steps.sent && c.steps.confirmed && !c.steps.returning, 'each step is timestamped');
  assert.strictEqual(tryStep(c, 'friend', 'confirm'), 409, 'not twice');
  assert.strictEqual(tryStep(c, 'owner', 'gave'), 403, 'the lender does not give it back');
  const r = tryStep(c, 'friend', 'gave');
  assert.strictEqual(r.state, 'returning');
  assert.strictEqual(tryStep(r, 'friend', 'back'), 403, 'the borrower still cannot close it');
  assert.strictEqual(tryStep(r, 'friend', 'gave'), 409);
  const done = tryStep(r, 'owner', 'back');
  assert.strictEqual(done.state, 'closed');
  assert.strictEqual(done.expiresAt, '2026-11-19T10:00:00.000Z', '30 days after it closes');
  for (const a of ['owner', 'friend']) for (const w of ['confirm', 'gave', 'back']) assert.strictEqual(tryStep(done, a, w), 409, `closed is final (${a} ${w})`);
  assert.strictEqual(hs().expiresAt, '2027-10-18T10:00:00.000Z', 'a year at most');
});

test('handshake the other way: the borrower sends it, the friend is the lender', () => {
  const h = hs('borrowed');
  assert.deepStrictEqual([h.lender, h.borrower], ['Sam', 'Erik']);
  assert.deepStrictEqual(C.allowed(h, 'friend'), ['confirm', 'back']);
  assert.deepStrictEqual(C.allowed(h, 'owner'), []);
  assert.strictEqual(tryStep(h, 'owner', 'back'), 403, 'the borrower who sent it still cannot close it');
  const c = tryStep(h, 'friend', 'confirm');
  assert.deepStrictEqual(C.allowed(c, 'owner'), ['gave']);
  const r = tryStep(c, 'owner', 'gave');
  assert.strictEqual(tryStep(r, 'friend', 'back').state, 'closed');
  assert.ok(C.expired({ expiresAt: '2026-10-01T00:00:00Z' }, Date.parse('2026-10-18T00:00:00Z')));
  assert.ok(!C.expired(h, Date.parse('2026-10-19T00:00:00Z')));
});

test('what a receipt shows: the item, two first names, dates, state - nothing else', () => {
  const v = C.handshakeView({ ...hs(), ownerHash: 'secret-ish', creator: 'd:abc', id: 'docid' }, 'friend');
  assert.deepStrictEqual(Object.keys(v).sort(), ['borrower', 'can', 'due', 'emoji', 'expiresAt', 'item', 'lender', 'note', 'on', 'role', 'state', 'steps', 'you']);
  assert.strictEqual(C.handshakeLine(v, T), 'Erik lent you 🔧 cordless drill on Oct 18 - back by Nov 1');
  assert.strictEqual(C.handshakeLine(C.handshakeView(hs('borrowed'), 'friend'), T), 'Erik borrowed your 🔧 cordless drill on Oct 18 - back by Nov 1');
  assert.throws(() => C.newHandshake({ item: 'drill', who: 'Sam' }, { now: Date.now(), today: T }), /first name/);
  assert.throws(() => C.newHandshake({ item: '<b></b>', who: 'Sam', me: 'E' }, { now: Date.now(), today: T }), /Say what it is/);
});

/* ---------------- nudges ---------------- */

test('nudges: five tones, three messages each, both ways - every one filled in, deterministic', () => {
  assert.deepStrictEqual(C.TONE_IDS, ['polite', 'friendly', 'cheeky', 'dramatic', 'legal']);
  const lent = loan({ on: '2026-07-16', due: '2026-07-30' });
  const borrowed = loan({ dir: 'borrowed', who: 'Mum', item: 'Casserole dish', on: '2026-10-06', due: '2026-10-27' });
  const all = new Set();
  for (const l of [lent, borrowed]) {
    for (const tone of C.TONE_IDS) {
      assert.strictEqual(C.nudgeCount(l.dir, tone), 3);
      for (let i = 0; i < 3; i++) {
        const text = C.nudge(l, tone, i, T, null);
        assert.ok(!/[{}]/.test(text), `${l.dir}/${tone}/${i} left a placeholder: ${text}`);
        assert.ok(text.includes(l.who) || text.includes(l.who.toUpperCase()), `${tone}/${i} names them`);
        assert.ok(/cordless drill|casserole dish/.test(text), `${tone}/${i} names the thing: ${text}`);
        assert.ok(text.length < 400 && /^[A-Z]/.test(text));
        all.add(text);
      }
      assert.strictEqual(C.nudge(l, tone, null, T), C.nudge(l, tone, C.firstVariant(l, tone), T), 'the first message is fixed per loan');
    }
  }
  assert.strictEqual(all.size, 30, 'thirty different messages');
  assert.match(C.nudge(lent, 'legal', 0, T), /^NOTICE TO SAM: Re: one \(1\) cordless drill, on loan since Jul 16\. .*as soon as you can.*joke/);
  assert.match(C.nudge(lent, 'cheeky', 1, T), /94 days/);
  assert.match(C.nudge(borrowed, 'polite', 0, T), /by Oct 27/);
  assert.strictEqual(C.nudge(lent, 'friendly', 0, T, 'https://x/h/abc').split('\n').pop(), 'Our Boomerang receipt: https://x/h/abc');
  assert.strictEqual(C.nudge(lent, 'nonsense', 0, T), C.nudge(lent, 'friendly', 0, T), 'an unknown tone is friendly');
  assert.strictEqual(C.byWhen(loan({}), T), 'sometime this week');
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
    for (const bg of ['bg', 'card', 'card2', 'accent-soft']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent');
    ok('late', 'late-bg'); ok('late', 'card'); ok('soon', 'soon-bg'); ok('home', 'home-bg'); ok('home', 'card');
    ok('link', 'accent-soft'); ok('err', 'card'); ok('err', 'bg');
    ok('card', 'home'); // "It's back" button: card-coloured ink on the home green
    ok('strip-ink', 'strip'); ok('strip-btn-ink', 'strip-btn');
    ok('warm', 'bg'); // "Get it back." in the hero
    ok('accent', 'card', 3); ok('accent', 'bg', 3); // the focus ring and buttons (3:1)
  }
  assert.ok(ratio('#ffffff', '#0f6b66') >= 4.5, 'the lab card colours hold white text');
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { BOOMERANG_MEMORY: '1' }], ['./lib/fakeai', { BOOMERANG_FAKE_AI: '1' }], ['./server', { BOOMERANG_FAKE_AI: '1', BOOMERANG_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, BOOMERANG_MEMORY: '', BOOMERANG_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; single-field queries only, so no composite index', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: ROOT, env: { ...process.env, BOOMERANG_MEMORY: '', BOOMERANG_COLLECTION_PREFIX: 'boomerang_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = read('lib/store.js');
  assert.ok(/BOOMERANG_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  const queries = [...server.matchAll(/where: \[(\[[^\]]*\](?:, )?)+\]/g)];
  assert.ok(queries.length >= 1);
  for (const m of queries) assert.strictEqual((m[0].match(/\['/g) || []).length, 1, `one equality filter per query: ${m[0]}`);
  assert.ok(!/orderBy/.test(server));
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, nothing logged from a body', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|success|upgradeneeded)\s*=/.test(js), 'handlers by addEventListener, not properties');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(/indexedDB\.open[^\n]*/.test(js) && /try \{\n\s*var r = indexedDB\.open/.test(js), 'IndexedDB opened inside a try');
  assert.ok(!/sessionStorage/.test(js));
  assert.ok(!/<script/i.test(js), 'no script written into markup');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js) && !/location\.href = ['"]\//.test(js), 'every browser URL is relative to BASE');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + read('public/boomerang-core.js')), 'no email address in the page');
  assert.ok(!/Math\.random|Date\.now\(\)/.test(read('public/boomerang-core.js')), 'the core has no dice and no clock');
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /never sends anything itself/, 'the nudge sheet says Boomerang sends nothing');
  assert.ok(/toDataURL\('image\/jpeg'/.test(js) && !/api\/[a-z/]*photo/i.test(js), 'photos are shrunk on the phone and never uploaded');
  for (const f of ['server.js', 'lib/ai.js', 'lib/handshakes.js', 'public/boomerang-core.js']) {
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|hint|item|who|note|name)/.test(read(f)), `${f} logs a body`);
  }
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/indexOf\('api\/'\) === 0 \|\| rel\.indexOf\('h\/'\) === 0/.test(sw), 'the service worker never caches the API or a receipt');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const RECEIPT = { item: 'Cordless drill', emoji: '🔧', who: 'Sam', me: 'Erik', dir: 'lent', on: T, due: '2026-11-01', note: 'In the blue case', today: T };
async function makeReceipt(c, extra = {}) {
  const r = await c('POST', '/api/h', { ...RECEIPT, ...extra });
  assert.strictEqual(r.status, 200, r.text);
  return r.data;
}

test('signed out: everything works with zero model calls; the metered route answers 401 before reading a big body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.tones.length, meta.picker.length, meta.limits.loans], [5, 24, 200]);
  for (const f of ['boomerang-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/write', { tone: 'polite' })).status, 401);
  assert.strictEqual((await anon('POST', '/api/write', { hint: 'x'.repeat(200 * 1024) })).status, 401, 'the gate answers before the 8 KB parser');
  assert.strictEqual((await anon('GET', '/api/shelf')).status, 401, 'syncing needs an account');
  assert.strictEqual((await anon('POST', '/api/shelf/merge', { loans: 'x'.repeat(400 * 1024) })).status, 401, 'and is refused before its big parser');
  assert.strictEqual((await anon('POST', '/api/h', { ...RECEIPT, note: 'x'.repeat(40 * 1024) })).status, 413, 'every other route keeps the small limit');
  const made = await makeReceipt(anon);
  assert.ok(made.token && made.key, 'a receipt needs no account');
  const deep = await fetch(`${base}/h/${made.token}`);
  assert.strictEqual(deep.status, 200);
  assert.ok((await deep.text()).includes('<base href="../">'), 'a receipt link resolves assets from the app root');
  assert.strictEqual(deep.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(deep.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.strictEqual((await anon('GET', `/api/h/${made.token}`)).headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await fetch(`${base}/h/${made.token}`, { method: 'POST' })).status, 405);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route’s gates come before its parser, in order; one model client in the whole server', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/write', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/shelf/merge', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to one metered call');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('a receipt over HTTP: the friend confirms and gives back, only the lender closes it, every step timestamped', async () => {
  const me = client();
  const made = await makeReceipt(me);
  assert.strictEqual(made.h.role, 'owner');
  const owner = { 'X-Boomerang-Key': made.key };
  const friend = client();
  const seen = await friend('GET', `/api/h/${made.token}`);
  assert.deepStrictEqual([seen.data.h.role, seen.data.h.you, seen.data.h.lender, seen.data.h.borrower, seen.data.h.state], ['friend', 'borrower', 'Erik', 'Sam', 'sent']);
  assert.deepStrictEqual(seen.data.h.can, ['confirm']);
  assert.strictEqual((await friend('POST', `/api/h/${made.token}/step`, { step: 'back' })).status, 403, 'the borrower cannot close it');
  assert.strictEqual((await friend('POST', `/api/h/${made.token}/step`, { step: 'gave' })).status, 409, 'Got it comes first');
  assert.strictEqual((await friend('POST', `/api/h/${made.token}/step`, { step: 'confirm' }, { 'X-Boomerang-Key': 'A'.repeat(22) })).data.h.state, 'confirmed', 'a wrong key is just the friend');
  assert.strictEqual((await me('POST', `/api/h/${made.token}/step`, { step: 'gave' }, owner)).status, 403, 'the lender does not give it back');
  const r = await friend('POST', `/api/h/${made.token}/step`, { step: 'gave' });
  assert.strictEqual(r.data.h.state, 'returning');
  const view = (await me('GET', `/api/h/${made.token}`, undefined, owner)).data.h;
  assert.deepStrictEqual([view.role, view.can], ['owner', ['back']], 'the owner sees the same state and can close it');
  const closed = await me('POST', `/api/h/${made.token}/step`, { step: 'back' }, owner);
  assert.strictEqual(closed.data.h.state, 'closed');
  assert.ok(Object.values(closed.data.h.steps).every((s) => typeof s === 'string' && !Number.isNaN(Date.parse(s))), 'all four steps timestamped');
  assert.strictEqual((await friend('POST', `/api/h/${made.token}/step`, { step: 'confirm' })).status, 409, 'closed is final');
  // Two taps at once: one moves it, the other is told it is done.
  const m2 = await makeReceipt(me);
  const both = await Promise.all([client()('POST', `/api/h/${m2.token}/step`, { step: 'confirm' }), client()('POST', `/api/h/${m2.token}/step`, { step: 'confirm' })]);
  assert.deepStrictEqual(both.map((x) => x.status).sort(), [200, 409]);
});

test('tokens are 128 random bits; unknown, malformed, revoked and expired all 404 the same; only the owner revokes', async () => {
  const toks = new Set();
  for (let i = 0; i < 200; i++) toks.add(H.newToken());
  assert.strictEqual(toks.size, 200);
  for (const t of toks) { assert.ok(C.TOKEN_RE.test(t)); assert.strictEqual(Buffer.from(t, 'base64url').length, 16, '16 bytes = 128 bits'); }
  const me = client();
  const made = await makeReceipt(me);
  const dump = store._dump();
  assert.ok(!dump.includes(made.token) && !dump.includes(made.key), 'neither the link token nor the owner key is stored');
  assert.ok(await store.get('handshakes', H.docId(made.token)), 'the document is filed under a hash of the token');
  const anon = client();
  const unknown = await anon('GET', `/api/h/${H.newToken()}`);
  const bad = await anon('GET', '/api/h/not-a-token');
  assert.deepStrictEqual([unknown.status, bad.status, bad.data.error], [404, 404, unknown.data.error]);
  assert.strictEqual((await anon('DELETE', `/api/h/${made.token}`)).status, 404, 'a stranger’s revoke is the same 404');
  assert.strictEqual((await anon('DELETE', `/api/h/${made.token}`, undefined, { 'X-Boomerang-Key': H.newKey() })).status, 404, 'so is a wrong key');
  assert.strictEqual((await anon('GET', `/api/h/${made.token}`)).status, 200, 'and it is still there');
  assert.strictEqual((await me('DELETE', `/api/h/${made.token}`, undefined, { 'X-Boomerang-Key': made.key })).status, 200);
  const revoked = await anon('GET', `/api/h/${made.token}`);
  assert.deepStrictEqual([revoked.status, revoked.data], [unknown.status, unknown.data], 'revoked reads exactly like never-existed');
  const old = await makeReceipt(me);
  await store.merge('handshakes', H.docId(old.token), { expiresAt: '2026-01-01T00:00:00.000Z' });
  const ex = await anon('GET', `/api/h/${old.token}`);
  assert.deepStrictEqual([ex.status, ex.data], [unknown.status, unknown.data], 'expired reads the same too');
  assert.strictEqual(await store.get('handshakes', H.docId(old.token)), null, 'and the read that found it deleted it');
});

test('what a link reveals: the receipt fields only - no ids, no hashes, no account, no email, markup and bidi gone', async () => {
  const eve = await register('eve.lender@example.com');
  const made = await makeReceipt(eve, { item: '<img src=x onerror=alert(1)>Drill', who: '"><svg onload=alert(1)>Sam', me: '\u202eErik', note: '<script>alert(1)</script>blue case' });
  const r = await client()('GET', `/api/h/${made.token}`);
  assert.deepStrictEqual(Object.keys(r.data.h).sort(), ['borrower', 'can', 'due', 'emoji', 'expiresAt', 'item', 'lender', 'note', 'on', 'role', 'state', 'steps', 'you']);
  assert.deepStrictEqual([r.data.h.item, r.data.h.borrower, r.data.h.lender, r.data.h.note], ['Drill', '" Sam', 'Erik', 'alert(1) blue case']);
  assert.ok(!/[<>\u202a-\u202e]/.test(r.text), 'no markup or bidi in what the friend is sent');
  assert.ok(!r.text.includes('eve.lender') && !r.text.includes(uidOf('eve.lender@example.com')) && !r.text.includes(made.key) && !r.text.includes(H.docId(made.token)), 'no email, uid, key or document id');
  const doc = await store.get('handshakes', H.docId(made.token));
  assert.deepStrictEqual(Object.keys(doc).sort(), ['createdAt', 'creator', 'dir', 'due', 'emoji', 'expiresAt', 'id', 'item', 'lender', 'borrower', 'note', 'on', 'ownerHash', 'state', 'steps'].sort(), 'exactly what is stored');
  assert.ok(!store._dump().includes('eve.lender') && !store._dump().includes(uidOf('eve.lender@example.com')), 'no account id or email stored anywhere');
  assert.match(doc.creator, /^a:[A-Za-z0-9_-]{27}$/, 'a signed-in creator is an HMAC tag');
});

test('anonymous limits: 20 new receipts per address an hour (IPv6 by its /64), 50 open per device, distinct wrong tokens', async () => {
  const net = '2001:db8:aaaa:1';
  for (let i = 0; i < H.LIMITS.createsPerIp; i++) {
    const c = client(`${net}::${i + 1}`); // different addresses in one /64
    assert.strictEqual((await c('POST', '/api/h', RECEIPT)).status, 200, `receipt ${i + 1}`);
  }
  const over = await client(`${net}::99`)('POST', '/api/h', RECEIPT);
  assert.deepStrictEqual([over.status, /20 receipts/.test(over.data.error)], [429, true]);
  // One device, many addresses: the open-receipt cap follows the device key.
  const phone = client();
  await makeReceipt(phone);
  assert.match(phone.cookies.boomerang_k || '', /^[A-Za-z0-9_-]{22}$/);
  const set = (await client()('POST', '/api/h', RECEIPT)).setCookie.join(';');
  assert.ok(/boomerang_k=[^;]+; Path=\/boomerang\/; Max-Age=\d+; SameSite=Lax; HttpOnly/.test(set), set);
  let made = 1;
  while (made < H.LIMITS.openPerCreator) {
    const c = client(); Object.assign(c.cookies, phone.cookies);
    assert.strictEqual((await c('POST', '/api/h', RECEIPT)).status, 200);
    made++;
  }
  const c51 = client(); Object.assign(c51.cookies, phone.cookies);
  const capped = await c51('POST', '/api/h', RECEIPT);
  assert.deepStrictEqual([capped.status, /50 open receipts/.test(capped.data.error)], [429, true]);
  // Distinct wrong tokens: guessing stops; one dead token polled is not guessing.
  const guess = client();
  const real = await makeReceipt(client());
  const dead = H.newToken();
  for (let i = 0; i < 40; i++) assert.strictEqual((await guess('GET', `/api/h/${dead}`)).status, 404, 'the same dead token, again and again');
  for (let i = 0; i < H.LIMITS.missesPerIp - 1; i++) await guess('GET', `/api/h/${H.newToken()}`);
  assert.strictEqual((await guess('GET', `/api/h/${real.token}`)).status, 429, 'then even a real one waits');
  assert.strictEqual((await client()('GET', `/api/h/${real.token}`)).status, 200, 'for that address only');
  assert.match(read('server.js'), /createsAll\.blocked\('all'\)/, 'and a ceiling across the instance');
});

test('signed in, the shelf follows you: one loan at a time, newer wins on merge, two phones at once, nothing identifying stored', async () => {
  const phoneA = await register('sam.sync@example.com');
  const l1 = { id: 'abcdefgh01', dir: 'lent', item: 'Ladder', who: 'Dev', on: '2026-09-10', due: null, note: '', photo: true, sample: true, updatedAt: 5 };
  const put = await phoneA('PUT', '/api/shelf/abcdefgh01', { loan: l1, today: T });
  assert.strictEqual(put.status, 200, put.text);
  assert.ok(!('photo' in put.data.loan) && !('sample' in put.data.loan), 'no photo flag, no sample marker');
  assert.strictEqual((await phoneA('PUT', '/api/shelf/sample0drill', { loan: { ...l1, id: 'sample0drill' } })).status, 400, 'the sample stays on the phone');
  assert.strictEqual((await phoneA('PUT', '/api/shelf/abcdefgh02', { loan: { item: '', who: 'x' } })).status, 400);
  // The same account on another phone.
  const phoneB = client();
  assert.strictEqual((await phoneB('POST', '/api/auth/login', { email: 'sam.sync@example.com', password: 'a long enough password' })).status, 200);
  const got = await phoneB('GET', '/api/shelf');
  assert.deepStrictEqual(got.data.loans.map((l) => l.item), ['Ladder']);
  // Merge: phone B had an older copy of the ladder and one loan of its own.
  const m = await phoneB('POST', '/api/shelf/merge', { today: T, loans: [{ ...l1, item: 'Old ladder', updatedAt: 1 }, { id: 'abcdefgh03', dir: 'borrowed', item: 'Casserole dish', who: 'Mum', on: '2026-10-06', updatedAt: Date.now() }, { id: 'sample0book1', item: 'Book', who: 'P', sample: true }] });
  assert.deepStrictEqual(m.data.loans.map((l) => l.item).sort(), ['Casserole dish', 'Ladder'], 'the newer ladder kept, the sample left behind');
  const m2 = await phoneA('POST', '/api/shelf/merge', { today: T, loans: [{ ...l1, sample: false, item: 'Tall ladder', updatedAt: Date.now() + 1000 }] });
  assert.ok(m2.data.loans.some((l) => l.item === 'Tall ladder'), 'a newer copy replaces it');
  // Two phones saving different loans at the same moment: both stick.
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? phoneA : phoneB)('PUT', `/api/shelf/race${String(i).padStart(6, '0')}`, { loan: { dir: 'lent', item: `Thing ${i}`, who: 'Kim', on: T }, today: T })));
  assert.strictEqual((await phoneA('GET', '/api/shelf')).data.loans.length, 14, 'twelve at once, none lost');
  assert.strictEqual((await phoneB('DELETE', '/api/shelf/abcdefgh03')).status, 200);
  assert.strictEqual((await phoneA('GET', '/api/shelf')).data.loans.length, 13);
  const dump = store._dump();
  assert.ok(!dump.includes('sam.sync') && !dump.includes(uidOf('sam.sync@example.com')), 'the shelf is filed under an HMAC, never the account id or email');
  assert.strictEqual((await client()('GET', '/api/shelf')).status, 401, 'nobody else');
  const other = await register('kim.other@example.com');
  assert.deepStrictEqual((await other('GET', '/api/shelf')).data.loans, [], 'another account sees its own, empty shelf');
  assert.strictEqual((await phoneA('DELETE', '/api/shelf')).status, 200);
  assert.deepStrictEqual((await phoneB('GET', '/api/shelf')).data.loans, []);
});

test('write it for me: input checked before any spend, one forced tool, three cleaned options, nothing stored, provider errors not passed on', async () => {
  const me = await register('ana.write@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  const LOAN = { item: 'Cordless drill', who: 'Sam', dir: 'lent', on: '2026-07-16', due: '2026-07-30', note: 'NOTE-NEVER-SENT', share: { token: 'x' } };
  assert.strictEqual((await me('POST', '/api/write', { loan: LOAN })).status, 400, 'a tone first');
  assert.strictEqual((await me('POST', '/api/write', { loan: { item: '', who: 'Sam' }, tone: 'polite' })).status, 400);
  assert.strictEqual((await me('POST', '/api/write', { loan: LOAN, tone: 'polite', hint: 'x'.repeat(600) })).status, 400, 'over the hint limit');
  assert.strictEqual((await me('POST', '/api/write', { loan: LOAN, tone: 'polite', hint: 'x'.repeat(20 * 1024) })).status, 413, 'its own 8 KB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const SECRET = 'ZEBRA-HINT-4417 reference his birthday';
  const r = await me('POST', '/api/write', { loan: LOAN, tone: 'cheeky', hint: SECRET, today: T });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.options.length, 3);
  assert.ok(r.data.options.every((o) => o.tone === 'cheeky' && /Sam/.test(o.text) && /birthday/i.test(o.text)));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const inj = await me('POST', '/api/write', { loan: LOAN, tone: 'dramatic', hint: 'INJECT' });
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(inj.data.options.length === 3 && inj.data.options.every((o) => C.TONE_IDS.includes(o.tone) && o.text.length <= C.LIMITS.nudgeText));
  const blank = await me('POST', '/api/write', { loan: LOAN, tone: 'polite', hint: 'BLANK' });
  assert.deepStrictEqual([blank.status, /Nothing usable/.test(blank.data.error)], [422, true]);
  assert.match((await me('POST', '/api/write', { loan: LOAN, tone: 'polite', hint: 'MAXTOKENS' })).data.error, /ran long/);
  const up = await me('POST', '/api/write', { loan: LOAN, tone: 'polite', hint: 'UPSTREAM401' });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await me('POST', '/api/write', { loan: LOAN, tone: 'polite', hint: 'UPSTREAM529' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'writing stores nothing');
});

test('the model sees only that loan: item, first name, dates, tone and hint - and its output is cleaned', async () => {
  const seen = [];
  const spy = { messages: { create: async (p) => { seen.push(p); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'write_nudges', input: { options: [] } }] }; } } };
  const b = ai.brief({ loan: { item: 'Drill', who: 'Sam', dir: 'lent', on: '2026-10-01', due: '2026-10-10', note: 'SECRET-NOTE', share: { token: 'SECRET-TOKEN' } }, tone: 'legal', hint: 'his birthday' }, T);
  assert.deepStrictEqual(Object.keys(b).sort(), ['days', 'dir', 'due', 'hint', 'item', 'on', 'status', 'tone', 'who']);
  await ai.write(spy, 'claude-haiku-4-5', b, T);
  const p = seen[0];
  assert.deepStrictEqual(p.tool_choice, { type: 'tool', name: 'write_nudges' }, 'one forced tool');
  assert.ok(p.max_tokens <= 1000);
  const text = JSON.stringify(p.messages);
  assert.ok(!/SECRET/.test(text), 'no note, no token');
  assert.ok(/Drill|drill/.test(text) && /Sam/.test(text) && /his birthday/.test(text) && /legal/.test(text));
  assert.deepStrictEqual(ai.cleanOptions({ options: [{ text: 'Hi Sam!', tone: 'x' }, { text: 'hi   SAM!', tone: 'polite' }, { text: 7 }, { text: '<b>Yo</b> Sam', tone: 'cheeky' }] }, 'polite'),
    [{ text: 'Hi Sam!', tone: 'polite' }, { text: 'Yo Sam', tone: 'cheeky' }]);
  assert.deepStrictEqual(ai.cleanOptions(null, 'polite'), []);
});

test('the gates: an unconfirmed free account gets verify-email 403, out of credit 402, the day’s free ceiling 503 - never a 413, never a model call', async () => {
  const LOAN = { item: 'Drill', who: 'Sam', dir: 'lent', on: T };
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/write', { loan: LOAN, tone: 'polite' });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/boomerang/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/write', { hint: 'x'.repeat(200 * 1024) })).status, 403, '403 before the body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/h', RECEIPT)).status, 200, 'receipts need no AI and no confirmation');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/write', { loan: LOAN, tone: 'polite' })).status, 402);
  assert.strictEqual((await cal('POST', '/api/write', { hint: 'x'.repeat(200 * 1024) })).status, 402, '402, not 413');
  const dan = await register('dan.capped@example.com');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-boomerang-${day}`, { usd: 5000 });
  try {
    const capped = await dan('POST', '/api/write', { loan: LOAN, tone: 'polite' });
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/write', { hint: 'x'.repeat(200 * 1024) })).status, 503, 'the ceiling answers before the parser too');
  } finally { await identityStore.remove('control', `free-spend-boomerang-${day}`); }
  assert.strictEqual((await dan('POST', '/api/write', { loan: LOAN, tone: 'polite' })).status, 200, 'and lifts when the day’s tally is under it');
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
  calls = await modelCalls();
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/boomerang' ? res.redirect(301, '/boomerang/') : next()));
  host.use('/boomerang', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/boomerang`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
