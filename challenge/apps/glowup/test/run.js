// Pure rules first, then end to end against the memory store and the fake
// model:
//   GLOWUP_MEMORY=1 GLOWUP_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /glowup, the way
// the lab mounts it, so the auth cookie, the budget gate, per-user paths and
// the share link are exercised as deployed. Model calls are counted from the
// identity's usage rows - the same rows that bill a real account.

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.GLOWUP_MEMORY !== '1' || process.env.GLOWUP_FAKE_AI !== '1') {
  console.error('run with GLOWUP_MEMORY=1 GLOWUP_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const R = require('../public/rules');
const L = require('../lib/listings');
const ai = require('../lib/ai');
const { demo, LOON_V1, LOON_GLOW, PINE_HOLLOW } = require('../lib/demo');

let base;
function client() {
  let cookie = '';
  return async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Local-Date': TODAY, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, headers: res.headers };
  };
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15)); // the meter writes usage rows fire-and-forget
const TODAY = L.utcToday();

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString('base64');
const BLANK = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('BLANK screen'), Buffer.alloc(500, 3)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A listing that should score 100: every rule satisfied. */
const PERFECT = {
  type: 'stay',
  platform: 'airbnb',
  title: 'Lake cabin with hot tub, dock and 2 kayaks',
  description: [
    'Lake cabin 40 steps from the water, with a hot tub under the pines.',
    '• Sleeps 4: a queen bed and 2 twin bunks',
    '• Self check-in from 4pm with a keypad',
    '• Parking for 2 cars in the driveway',
    '• Wi-Fi 150 Mbps, with a desk by the window',
    '• Dog friendly, with a fenced yard',
    '• 10 min drive to the Pine Falls trailhead',
    'Tap Reserve to check your dates.',
  ].join('\n'),
  tags: ['hot tub', 'kayaks', 'dock', 'dog friendly'],
  keywords: ['lake cabin', 'hot tub', 'dog friendly'],
  price: '$189 / night',
  photoCount: 24,
  shots: ['hero', 'bedrooms', 'bathroom', 'kitchen', 'outside'],
};
const check = (l, id) => R.score(l).checks.find((c) => c.id === id);
const lost = (l, id) => check(l, id).lost;

/* ---------------- pure: the rules ---------------- */

test('platform limits are data, and a platform must belong to its type', () => {
  const p = (k) => R.platformInfo(k);
  assert.deepStrictEqual([p('airbnb').titleMax, p('airbnb').descMax, p('airbnb').hard], [50, 500, true]);
  assert.deepStrictEqual([p('etsy').titleMax, p('etsy').tagsMax, p('etsy').tagMax], [140, 13, 20]);
  assert.strictEqual(p('ebay').titleMax, 80);
  assert.deepStrictEqual([p('google').descMax, p('google').titleLocked], [750, true]);
  assert.ok(R.PLATFORMS.every((x) => R.TYPE_KEYS.includes(x.type) && x.titleMax > 0 && x.note));
  assert.strictEqual(R.platformOf('product', 'airbnb').key, 'etsy', 'a stay platform on a product falls back to the product default');
  assert.strictEqual(R.platformOf('stay', 'vrbo').key, 'vrbo');
});

test('each type has its own five essentials and five shots', () => {
  for (const t of R.TYPE_KEYS) {
    assert.strictEqual(R.ESSENTIALS[t].length, 5, t);
    assert.strictEqual(R.SHOTS[t].length, 5, t);
  }
  const has = (type, text) => R.ESSENTIALS[type].filter((e) => e.re.test(text)).map((e) => e.key);
  assert.deepStrictEqual(has('stay', 'Self check-in with a keypad. Parking in the driveway. Wi-Fi 300 Mbps. Sleeps 4. 5 min to the beach.').sort(), ['beds', 'checkin', 'distance', 'parking', 'wifi']);
  assert.deepStrictEqual(has('stay', 'Fast wifi!'), [], '"fast wifi" is not a Wi-Fi speed');
  assert.deepStrictEqual(has('product', 'Soy wax, 8 oz jar. Trim the wick. Ships in 2 days. A gift for her.').sort(), ['care', 'materials', 'occasion', 'shipping', 'size']);
  assert.deepStrictEqual(has('resale', 'Gently worn condition, no stains. Pit to pit 22 in. Size M. Ships next day.').sort(), ['condition', 'flaws', 'measurements', 'shipping', 'size']);
  assert.deepStrictEqual(has('service', 'Serving Oak County. We reply within 2 hours. Licensed and insured. Free estimates. Open Mon-Sat.').sort(), ['area', 'hours', 'license', 'pricing', 'response']);
});

test('a listing that does everything scores 100, and the rings add up', () => {
  const s = R.score(PERFECT);
  assert.deepStrictEqual(s.fixes.map((f) => `${f.id}: ${f.fix}`), []);
  assert.strictEqual(s.score, 100);
  assert.strictEqual(s.grade.key, 'glowing');
  for (const c of R.CATS) assert.deepStrictEqual([s.cats[c.key].score, s.cats[c.key].pct], [20, 100]);
  const bad = R.score(LOON_V1);
  assert.strictEqual(R.CATS.reduce((sum, c) => sum + bad.cats[c.key].score, 0), bad.score, 'the score is the rings summed');
  for (const c of R.CATS) {
    const lostHere = bad.checks.filter((x) => x.cat === c.key).reduce((sum, x) => sum + x.lost, 0);
    assert.strictEqual(bad.cats[c.key].score, 20 - lostHere, c.key);
    assert.strictEqual(bad.checks.filter((x) => x.cat === c.key).reduce((sum, x) => sum + x.max, 0), 20, `${c.key} is worth 20`);
  }
  assert.ok(bad.fixes.every((f) => f.fix && f.lost > 0), 'every deduction says what to fix');
  assert.ok(bad.fixes.every((f, i, a) => !i || a[i - 1].lost >= f.lost), 'biggest fixes first');
  assert.deepStrictEqual(R.summary(LOON_V1), { score: bad.score, cats: Object.fromEntries(R.CATS.map((c) => [c.key, bad.cats[c.key].score])) });
  assert.deepStrictEqual(['dim', 'okay', 'good', 'great', 'glowing'].map((k, i) => R.gradeOf([10, 45, 65, 80, 95][i]).key), ['dim', 'okay', 'good', 'great', 'glowing']);
});

test('title rules: length against the platform, search words, no shouting', () => {
  const t = (title, extra = {}) => ({ ...PERFECT, title, ...extra });
  assert.strictEqual(lost(t('Lake cabin with hot tub, dock, 2 kayaks and a big fire pit'), 't_len'), 7, 'over Airbnb’s 50');
  assert.match(check(t('Lake cabin with hot tub, dock, 2 kayaks and a big fire pit'), 't_len').fix, /Airbnb stops titles at 50 characters - cut 8 characters/);
  assert.strictEqual(lost(t('Lake cabin with hot tub, dock, 2 kayaks and a big fire pit', { platform: 'vrbo' }), 't_len'), 0, 'Vrbo allows more');
  assert.strictEqual(lost(t('Lake cabin'), 't_len'), 4, 'too short for the space');
  assert.strictEqual(lost(t(''), 't_len'), 7);
  assert.strictEqual(lost(t('Pine cottage with a dock and 2 kayaks'), 't_kw'), 6, 'no search word in the title');
  assert.strictEqual(lost(t('Hot tub cottage with a dock and 2 kayaks'), 't_kw'), 2, 'has one, but not the first one listed');
  assert.strictEqual(lost(t('Lake cabins with a hot tub and 2 kayaks'), 't_kw'), 0, 'plurals count');
  assert.strictEqual(lost({ ...PERFECT, keywords: [], tags: [] }, 't_kw'), 4, 'no search words at all');
  assert.strictEqual(lost(t('Lake cabin - PERFECT GETAWAY'), 't_style'), 4, 'capitals (2) and a vague word (2)');
  assert.strictEqual(lost(t('Lake cabin with hot tub!!'), 't_style'), 1);
  assert.strictEqual(lost(t('Cozy lake cabin, 2 kayaks'), 't_style'), 0, 'an adjective next to a number is fine');
  assert.strictEqual(lost(t('Lake cabin with WIFI and a BBQ, 2 kayaks'), 't_style'), 0, 'acronyms are not shouting');
});

test('tags: Etsy wants all 13, each 20 characters or less', () => {
  const candle = { type: 'product', platform: 'etsy', title: 'Cedar candle with wood wick', description: 'x', tags: ['a1', 'b2', 'c3'] };
  assert.strictEqual(lost(candle, 't_tags'), 2);
  assert.strictEqual(lost({ ...candle, tags: Array.from({ length: 8 }, (_, i) => `tag ${i}`) }, 't_tags'), 1);
  assert.strictEqual(lost({ ...candle, tags: Array.from({ length: 13 }, (_, i) => `tag ${i}`) }, 't_tags'), 0);
  const long = check({ ...candle, tags: [...Array.from({ length: 12 }, (_, i) => `tag ${i}`), 'a tag that is far too long'] }, 't_tags');
  assert.strictEqual(long.lost, 2);
  assert.match(long.fix, /stop at 20 characters/);
});

test('Google: the business name is never keyword-scored, and stuffing is caught', () => {
  const svc = { type: 'service', platform: 'google', title: 'Riverside Plumbing', description: 'Serving Oak County.', keywords: ['emergency plumber'] };
  assert.strictEqual(lost(svc, 't_len'), 0);
  assert.strictEqual(lost(svc, 't_kw'), 0, 'no keyword demand on a real name');
  assert.strictEqual(lost({ ...svc, title: 'Riverside Plumbing | Best Emergency Plumber Near Me' }, 't_len'), 7);
  assert.match(check({ ...svc, title: 'Riverside Plumbing | Best Emergency Plumber Near Me' }, 't_len').fix, /real business name/);
  assert.strictEqual(lost({ ...svc, description: 'x'.repeat(800) }, 'r_length'), 3, 'over Google’s 750');
});

test('hook rules: no greeting, a fact up front, a sensible length, a next step', () => {
  const d = (description) => ({ ...PERFECT, description });
  assert.strictEqual(lost(d('Welcome to our lake cabin, 40 steps from the water. Tap Reserve.'), 'h_filler'), 6);
  assert.strictEqual(lost(d('• Lake cabin 40 steps from the water. Tap Reserve.'), 'h_filler'), 0, 'a bullet mark is not a greeting');
  assert.strictEqual(lost(d('A quiet place in the woods to unwind. Tap Reserve.'), 'h_specific'), 5);
  assert.strictEqual(lost(d('Our place has 3 bedrooms. Tap Reserve.'), 'h_specific'), 0);
  assert.strictEqual(lost(d('A lake cabin in the pines. Tap Reserve.'), 'h_specific'), 0, 'a search word is a fact');
  assert.strictEqual(lost(d(`${'Lake cabin '.repeat(20)}. Book now.`), 'h_length'), 3);
  assert.strictEqual(lost(d('Lake cabin. Book now.'), 'h_length'), 2);
  assert.strictEqual(lost(d('Lake cabin 40 steps from the water.'), 'h_cta'), 6);
  assert.match(check(d('Lake cabin 40 steps from the water.'), 'h_cta').fix, /Tap Reserve/);
  assert.strictEqual(lost(d('Lake cabin 40 steps from the water. Message us with questions.'), 'h_cta'), 0);
  assert.strictEqual(R.score(d('')).cats.hook.score, 0, 'no description, no hook');
});

test('details rules: essentials, search words in the text, specifics over adjectives, numbers', () => {
  const d = (description, extra = {}) => ({ ...PERFECT, description, ...extra });
  const ess = check(d('Lake cabin by the water. Book now.', { tags: [] }), 'd_essentials');
  assert.strictEqual(ess.lost, 10);
  assert.match(ess.fix, /check-in time.*parking.*Wi-Fi speed.*beds.*far/);
  assert.strictEqual(lost(d('Lake cabin. Self check-in, parking for 2, 150 Mbps Wi-Fi, sleeps 4. Book now.', { tags: [] }), 'd_essentials'), 2, 'only the distance missing');
  assert.strictEqual(lost(d('Lake cabin. Book now.', { tags: ['hot tub'] }), 'd_keywords'), 2, '2 of 3 search words, counting tags');
  assert.strictEqual(lost(d('A cabin. Book now.', { tags: [] }), 'd_keywords'), 4);
  assert.strictEqual(lost(d('It is a really cozy and nice place. Such a great view. Book now.'), 'd_vague'), 4, 'two vague sentences, capped at 4');
  assert.strictEqual(lost(d('Cozy: a wood stove and 2 wool blankets. Book now.'), 'd_vague'), 0, 'an adjective with the fact behind it is fine');
  assert.match(check(d('It is a really cozy place. Book now.'), 'd_vague').fix, /“cozy”/);
  assert.strictEqual(lost(d('word '.repeat(60)), 'd_numbers'), 2);
  assert.strictEqual(lost(d(`${'word '.repeat(60)} 3 beds and 2 baths`), 'd_numbers'), 0);
});

test('trust rules: typos, shouting, exclamations, walls, bullets, length, price, gaps', () => {
  const d = (description, extra = {}) => ({ ...PERFECT, description, ...extra });
  assert.strictEqual(lost(d('Lake cabin by the the lake. Book now.'), 'r_repeat'), 2);
  assert.deepStrictEqual(R.repeatedWords('had had that that the the'), ['the the']);
  assert.strictEqual(lost(d('Lake cabin with a HUGE DECK. Book now.'), 'r_caps'), 3);
  assert.strictEqual(lost(d('Lake cabin with a HUGE deck. Book now.'), 'r_caps'), 0, 'one capitalised word is emphasis, not shouting');
  assert.strictEqual(lost(d('Lake cabin!! Book now.'), 'r_exclaim'), 2);
  assert.strictEqual(lost(d('Lake! Cabin! Hot tub! Dock! Book now.'), 'r_exclaim'), 1);
  assert.strictEqual(lost(d(`Lake cabin. ${'x'.repeat(360)}`), 'r_wall'), 4);
  assert.strictEqual(lost(d(`Lake cabin. ${'word '.repeat(80)}`), 'r_bullets'), 2);
  assert.strictEqual(lost(PERFECT, 'r_bullets'), 0);
  assert.strictEqual(lost(d('Short. Book now.'), 'r_length'), 3);
  assert.strictEqual(lost(d(`${'Lake cabin. '.repeat(20)}`), 'r_length'), 2, 'under 300 but over half');
  assert.match(check(d(`• ${'Lake cabin line\n• '.repeat(40)}`), 'r_length').fix, /Airbnb stops the description at 500/);
  assert.strictEqual(lost({ ...PERFECT, price: '' }, 'r_price'), 2);
  assert.strictEqual(lost({ ...PERFECT, type: 'service', platform: 'site', price: 'Free quotes' }, 'r_price'), 0);
  const gaps = check(d(`${PERFECT.description}\nPool: [add: pool hours] and [add: pool size]`), 'r_gaps');
  assert.strictEqual(gaps.lost, 2);
  assert.match(gaps.fix, /Fill in 2 gaps/);
});

test('a label in front of a gap earns nothing; the gap is not the fact', () => {
  assert.strictEqual(R.stripPlaceholders('• Parking: [add: where, how many cars]'), '');
  assert.strictEqual(R.stripPlaceholders('Wi-Fi 150 Mbps [add: router brand] and a desk by the window'), 'Wi-Fi 150 Mbps and a desk by the window');
  const gap = { ...PERFECT, description: PERFECT.description.replace('• Parking for 2 cars in the driveway', '• Parking: [add: where, and for how many cars]') };
  assert.strictEqual(lost(gap, 'd_essentials'), 2, 'the parking point is not earned by the label');
  assert.deepStrictEqual(R.placeholdersIn(gap.description), ['where, and for how many cars']);
});

test('photo rules: count against the type, and the shot list', () => {
  assert.strictEqual(lost({ ...PERFECT, photoCount: 0 }, 'p_count'), 10);
  assert.strictEqual(lost({ ...PERFECT, photoCount: 10 }, 'p_count'), 5);
  assert.strictEqual(lost({ ...PERFECT, type: 'resale', platform: 'ebay', photoCount: 8 }, 'p_count'), 0, 'resale needs fewer');
  assert.strictEqual(lost({ ...PERFECT, shots: ['hero'] }, 'p_shots'), 8);
  assert.match(check({ ...PERFECT, shots: ['hero'] }, 'p_shots').fix, /every bedroom/);
});

test('versions: sparkline points, the improvement streak and the day streak', () => {
  assert.deepStrictEqual(R.sparkline([], 100, 40), []);
  const one = R.sparkline([50], 100, 40, 0);
  assert.strictEqual(one.length, 2);
  assert.strictEqual(one[0][1], one[1][1], 'one score is a flat line');
  const pts = R.sparkline([41, 74, 88], 100, 40, 0);
  assert.deepStrictEqual(pts.map((p) => p[0]), [0, 50, 100]);
  assert.ok(pts[0][1] > pts[1][1] && pts[1][1] > pts[2][1], 'higher scores sit higher (smaller y)');
  assert.ok(pts.every((p) => p[1] >= 0 && p[1] <= 40));
  assert.strictEqual(R.improvementStreak([41, 38, 60, 72]), 2);
  assert.strictEqual(R.improvementStreak([41, 74, 74]), 0, 'a save that scored the same breaks the run');
  assert.strictEqual(R.improvementStreak([41]), 0);
  const d = '2026-09-25';
  assert.deepStrictEqual(R.dayStreak(['2026-09-23', '2026-09-24', d], d), { days: 3, atRisk: false, today: true });
  assert.deepStrictEqual(R.dayStreak(['2026-09-23', '2026-09-24'], d), { days: 2, atRisk: true, today: false });
  assert.strictEqual(R.dayStreak(['2026-09-20'], d).days, 0);
});

/* ---------------- pure: model output ---------------- */

test('glow-up validation: markup out, titles held to the platform, nothing invented', () => {
  const src = { ...LOON_V1, tags: [...LOON_V1.tags, 'wifi'] }; // Wi-Fi is theirs; a speed is not
  const raw = {
    titles: [
      { text: '<b>Lake cabin</b> with hot tub, wood stove, kayaks, a dock and a lot more words', angle: '<i>Long</i>' },
      { text: 'Lake cabin with a private sauna', angle: 'Invented' },
      { text: 'Lake cabin, 500 Mbps Wi-Fi', angle: 'Invented number' },
      { text: 'Supercalifragilisticexpialidociousandthensomemorewordswithoutspaces', angle: 'Stub' },
      { text: 'Hot tub lake cabin with kayaks', angle: 'Fine' },
      { text: 'hot tub lake cabin with kayaks', angle: 'Duplicate' },
    ],
    description: '**Lake cabin on the water** <script>alert(1)</script>\n## Highlights\n• A private sauna by the dock.\n• Wi-Fi at 500 Mbps\n• Kayaks for 4 people. Tap Reserve.',
    tags: ['lake cabin', '<img src=x onerror=1>hot tub', 'sauna', 'x'.repeat(45), '#dock', 'Lake Cabin'],
    shots: [{ shot: 'The sauna at dusk', why: 'Invented' }, { shot: 'Kayaks on the dock', why: '<b>Real</b>' }],
    gaps: ['something'],
    summary: '<b>Better</b>',
  };
  const v = ai.validateGlow(raw, src);
  const all = JSON.stringify(v);
  assert.ok(!/[<>]/.test(all), 'no markup anywhere');
  assert.ok(!all.includes('**') && !/^#/m.test(v.description), 'no markdown');
  assert.ok(v.titles.every((t) => t.text.length <= 50), 'every title within Airbnb’s 50');
  assert.deepStrictEqual(v.titles[0], { text: 'Lake cabin with hot tub, wood stove, kayaks, a', angle: 'Long', trimmed: true });
  assert.ok(!v.titles.some((t) => /sauna|500|Supercal/i.test(t.text)), JSON.stringify(v.titles));
  assert.strictEqual(v.titles.length, 2, 'the duplicate is dropped');
  assert.ok(!/sauna/i.test(v.description), v.description);
  assert.match(v.description, /\[add: Wi-Fi speed in Mbps\]/, 'a made-up speed becomes a gap');
  assert.match(v.description, /\[add: how many people\]/);
  assert.ok(!/500|\b4\b/.test(v.description));
  assert.ok(!v.tags.some((t) => /sauna|x{40}/i.test(t)), JSON.stringify(v.tags));
  assert.deepStrictEqual(v.tags, ['lake cabin', 'hot tub', 'dock']);
  assert.deepStrictEqual(v.shots.map((s) => s.shot), ['Kayaks on the dock']);
  assert.ok(v.removed.some((r) => r.what === 'sauna' && r.where === 'description'));
  assert.ok(v.removed.some((r) => r.where === 'title' && r.what === 'too long'));
  assert.deepStrictEqual(v.gaps, ['Wi-Fi speed in Mbps', 'how many people'], 'the gaps are the ones marked in the text');
  assert.strictEqual(v.summary, 'Better');
});

test('glow-up validation: Google names are locked, limits trim, empty is nothing', () => {
  const svc = { type: 'service', platform: 'google', title: 'Riverside Plumbing', description: 'We fix pipes in Oak County. Call us.', tags: [] };
  const v = ai.validateGlow({ titles: [{ text: 'Best Emergency Plumber Near Me', angle: 'x' }], description: `We fix pipes in Oak County.\n${'Call us. '.repeat(120)}`, tags: [], shots: [], gaps: [], summary: '' }, svc);
  assert.deepStrictEqual(v.titles.map((t) => t.text), ['Riverside Plumbing'], 'Google’s name is never rewritten');
  assert.ok(v.description.length <= 750 && v.trimmed, 'trimmed to Google’s 750');
  assert.strictEqual(ai.validateGlow({ titles: [], description: '[add: everything]', tags: [], shots: [], gaps: [] }, svc), null);
  assert.strictEqual(ai.validateGlow(null, svc), null);
  const etsy = ai.validateGlow({ titles: [{ text: 'Candle', angle: 'a' }], description: 'A cedar candle in a jar. Add it to your cart.', tags: ['cedar candle', 'a candle tag longer than twenty', ...Array.from({ length: 20 }, (_, i) => `candle ${i}`)], shots: [], gaps: [] }, { type: 'product', platform: 'etsy', title: 'Candle', description: 'cedar candle, candle 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19', tags: [] });
  assert.strictEqual(etsy.tags.length, 13, 'at most 13 tags on Etsy');
  assert.ok(etsy.tags.every((t) => t.length <= 20));
  assert.deepStrictEqual(ai.fitTitle('Short one', 50), { text: 'Short one', trimmed: false });
  assert.strictEqual(ai.fitTitle('Lake cabin, with | everything', 14).text, 'Lake cabin');
});

test('compare and read validation: cleaned, bounded, refused when empty', () => {
  const c = ai.validateCompare({ theyDoBetter: [{ point: '<b>Bold</b> first line', move: '<script>x</script>Do it' }, { point: '' }], youDoBetter: ['Dogs welcome'], verdict: '<i>Do one thing</i>' });
  assert.deepStrictEqual(c, { theyDoBetter: [{ point: 'Bold first line', move: 'Do it' }], youDoBetter: [{ point: 'Dogs welcome' }], verdict: 'Do one thing' });
  assert.strictEqual(ai.validateCompare({ theyDoBetter: [], youDoBetter: [] }), null);
  assert.strictEqual(ai.validateRead({ readable: false }), null);
  assert.strictEqual(ai.validateRead({ readable: true, type: 'stay', title: '', description: 'short' }), null);
  const r = ai.validateRead({ readable: true, type: 'resale', platform: 'airbnb', title: '<b>Jacket</b>', description: 'Worn once.', photoCount: 7.8 });
  assert.deepStrictEqual([r.type, r.platform, r.title, r.photoCount], ['resale', 'ebay', 'Jacket', 7]);
});

test('the demo: The Loon’s Nest goes 41 → 88, every rewrite passes the validators, no model involved', () => {
  const d = demo('2026-09-25');
  const loon = d.items['loons-nest'];
  assert.deepStrictEqual([loon.trail[0], loon.trail[loon.trail.length - 1]], [41, 88]);
  assert.strictEqual(loon.result.score, 88);
  assert.strictEqual(d.glows['loons-nest'].before.score, 41);
  assert.ok(d.glows['loons-nest'].after.score > 41);
  for (const id of Object.keys(d.glows)) {
    const g = d.glows[id];
    assert.deepStrictEqual(g.removed, [], `${id}: the hand-written rewrite invents nothing`);
    assert.strictEqual(g.titles.length, 3, id);
    assert.ok(d.items[id].trail.every((s, i, a) => !i || s > a[i - 1]), `${id} climbs`);
    assert.strictEqual(d.items[id].history.length, d.items[id].versions.length);
  }
  assert.deepStrictEqual(Object.keys(d.items).sort(), ['loons-nest', 'northfield', 'wick-ember']);
  assert.strictEqual(loon.compare.them.title, PINE_HOLLOW.title);
  assert.ok(!JSON.stringify(loon.compare).includes('20-foot wall of windows.\n'), 'the competitor’s full text is not carried');
  assert.ok(loon.card && loon.card.text === null, 'the sample card shows no private text');
  assert.deepStrictEqual(demo('2026-09-25').items['loons-nest'].result, loon.result, 'the same every time');
  assert.ok(ai.validateGlow(LOON_GLOW, LOON_V1).gaps.length >= 5);
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { GLOWUP_MEMORY: '1' }], ['./lib/fakeai', { GLOWUP_FAKE_AI: '1' }], ['./server', { GLOWUP_FAKE_AI: '1', GLOWUP_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, GLOWUP_MEMORY: '', GLOWUP_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

/* ---------------- over HTTP ---------------- */

test('signed out: health, meta, the demo and rules.js work with zero model calls; nothing else does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = await anon('GET', '/api/meta');
  assert.deepStrictEqual(meta.data.types.map((t) => t.key), ['stay', 'product', 'resale', 'service']);
  assert.strictEqual(meta.data.platforms.find((p) => p.key === 'etsy').titleMax, 140);
  const d = await anon('GET', '/api/demo');
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.demo, true);
  assert.strictEqual(d.data.items['loons-nest'].result.score, 88);
  const js = await fetch(`${base}/rules.js`);
  assert.ok((await js.text()).includes('GlowRules'), 'the page runs the same rules the server does');
  const page = await fetch(`${base}/`);
  assert.ok((await page.text()).includes('src="app.js"'), 'relative asset links');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/listings'], ['POST', '/api/listings'], ['GET', '/api/listings/abcdef'], ['PUT', '/api/listings/abcdef'], ['DELETE', '/api/listings/abcdef'],
    ['POST', '/api/listings/abcdef/glowup'], ['POST', '/api/listings/abcdef/compare'], ['POST', '/api/listings/read'], ['POST', '/api/listings/abcdef/revert'],
    ['POST', '/api/listings/abcdef/share'], ['DELETE', '/api/listings/abcdef/share'], ['GET', '/api/wins']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  // A stranger's 5 MB screenshot is turned away at the door, unread.
  const big = await anon('POST', '/api/listings/read', { image: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } });
  assert.strictEqual(big.status, 401);
  // ...and every other route keeps the small limit.
  const fat = await anon('POST', '/api/listings', { title: 'x'.repeat(200 * 1024) });
  assert.strictEqual(fat.status, 413);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

let ana, eve;
const L1 = {};

async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

test('a seller signs up and adds a listing: validated, scored, version 1', async () => {
  ana = await register('ana@example.com');
  assert.strictEqual((await ana('POST', '/api/listings', { ...LOON_V1, type: 'boat' })).status, 400);
  assert.strictEqual((await ana('POST', '/api/listings', { type: 'stay', title: ' ', description: '' })).status, 400);
  const r = await ana('POST', '/api/listings', { ...LOON_V1, title: `<b>${LOON_V1.title}</b>`, platform: 'etsy', photoCount: 400, shots: ['hero', 'outside', 'nonsense', 'hero'], tags: [...LOON_V1.tags, 'Hot Tub'] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  L1.id = r.data.id;
  assert.strictEqual(r.data.title, LOON_V1.title, 'markup stripped');
  assert.strictEqual(r.data.platform, 'airbnb', 'an Etsy platform on a rental falls back');
  assert.strictEqual(r.data.photoCount, 100, 'photo count capped');
  assert.deepStrictEqual(r.data.shots, ['hero', 'outside']);
  assert.strictEqual(r.data.tags.length, LOON_V1.tags.length, 'tags de-duplicated regardless of case');
  assert.strictEqual(r.data.versions.length, 1);
  assert.strictEqual(r.data.versions[0].source, 'paste');
  assert.strictEqual(r.data.result.score, R.score({ ...LOON_V1, photoCount: 100 }).score, 'the server scores with the same rules');
  // Back to the sample's own numbers for the rest.
  const put = await ana('PUT', `/api/listings/${L1.id}`, { photoCount: 8 });
  assert.strictEqual(put.data.result.score, 41);
  const list = await ana('GET', '/api/listings');
  assert.deepStrictEqual(list.data.listings.map((l) => [l.id, l.score]), [[L1.id, 41]]);
});

test('saving: a change is a new version, the same content is not; a better score starts the streak', async () => {
  const before = (await ana('GET', `/api/listings/${L1.id}`)).data;
  const same = await ana('PUT', `/api/listings/${L1.id}`, { title: before.title });
  assert.strictEqual(same.data.unchanged, true);
  assert.strictEqual(same.data.versions.length, before.versions.length, 'no new version for no change');
  const r = await ana('PUT', `/api/listings/${L1.id}`, { title: 'Lake cabin with hot tub, wood stove & kayaks' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.improved > 0);
  assert.strictEqual(r.data.versions.length, before.versions.length + 1);
  assert.strictEqual(r.data.versions[0].source, 'edit');
  assert.deepStrictEqual(r.data.trail.slice(-2), [41, r.data.result.score]);
  const me = await ana('GET', '/api/me');
  assert.deepStrictEqual([me.data.streak.days, me.data.streak.today], [1, true]);
  assert.strictEqual((await ana('PUT', `/api/listings/${L1.id}`, { type: 'rocket' })).status, 400);
});

test('glow it up: metered, forced tool, a proposal scored by the rules - and nothing stored', async () => {
  const calls = await modelCalls();
  const dump = store._dump();
  const r = await ana('POST', `/api/listings/${L1.id}/glowup`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one metered model call');
  assert.strictEqual(store._dump(), dump, 'a glow-up saves nothing');
  const cur = (await ana('GET', `/api/listings/${L1.id}`)).data;
  assert.strictEqual(r.data.before.score, cur.result.score);
  assert.strictEqual(r.data.titles.length, 3);
  assert.ok(r.data.titles.every((t) => t.text.length <= 50 && typeof t.score === 'number'));
  const applied = { ...L.fieldsOf(cur), ...r.data.fields };
  assert.strictEqual(r.data.after.score, R.score(applied).score, 'the after is the rules’ number, not the model’s');
  assert.ok(r.data.after.score > r.data.before.score, `${r.data.before.score} -> ${r.data.after.score}`);
  assert.ok(r.data.gaps.length > 0 && r.data.fields.description.includes('[add:'), 'what the listing lacks comes back as gaps');
  assert.ok(r.data.shots.length > 0);
  // Apply it: an ordinary save, marked as a glow-up.
  const put = await ana('PUT', `/api/listings/${L1.id}`, { ...r.data.fields, source: 'glowup' });
  assert.strictEqual(put.data.versions[0].source, 'glowup');
  assert.strictEqual(put.data.result.score, r.data.after.score);
});

test('glow it up: markup, over-length titles and invented facts never reach the page', async () => {
  const inj = await ana('POST', '/api/listings', { ...LOON_V1, title: 'INJECT lake cabin', description: `${LOON_V1.description} INJECT` });
  const r = await ana('POST', `/api/listings/${inj.data.id}/glowup`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const all = JSON.stringify(r.data);
  assert.ok(!/[<>]/.test(all), 'no markup');
  assert.ok(!r.data.fields.description.includes('**'), 'no markdown');
  assert.ok(r.data.titles.every((t) => t.text.length <= 50), 'titles within the platform limit');
  assert.ok(!/900/.test(JSON.stringify([r.data.titles, r.data.fields, r.data.shots])), 'a made-up Wi-Fi speed is gone');
  assert.ok(r.data.removed.some((x) => /900|wi-fi/i.test(`${x.what} ${x.text}`)), '...and the page is told it was taken out');
  assert.match(r.data.fields.description, /\[add: Wi-Fi speed in Mbps\]/);
  assert.ok(r.data.titles.some((t) => t.trimmed) || r.data.removed.some((x) => x.where === 'title'), 'the over-length title was trimmed or dropped');
  assert.ok(!r.data.fields.tags.some((t) => t.length > 40));
  const empty = await ana('POST', '/api/listings', { ...LOON_V1, description: 'EMPTY please' });
  assert.strictEqual((await ana('POST', `/api/listings/${empty.data.id}/glowup`)).status, 422);
  // The hot tub IS in this listing, so the guard lets it stand - it only
  // removes what the seller never said.
  const noTub = await ana('POST', '/api/listings', { type: 'stay', platform: 'airbnb', title: 'INJECT pine cabin', description: 'A pine cabin by the lake with kayaks. Message us.', tags: ['kayaks'] });
  const g = await ana('POST', `/api/listings/${noTub.data.id}/glowup`);
  assert.ok(!/hot tub/i.test(JSON.stringify([g.data.titles, g.data.fields, g.data.shots])), 'an invented hot tub is removed everywhere');
  assert.ok(g.data.removed.some((x) => x.what === 'hot tub'));
  for (const id of [inj.data.id, empty.data.id, noTub.data.id]) await ana('DELETE', `/api/listings/${id}`);
});

test('compare: both scored by the rules, the model’s view validated, only their title kept', async () => {
  const calls = await modelCalls();
  assert.strictEqual((await ana('POST', `/api/listings/${L1.id}/compare`, { title: 'Too short' })).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'refused before anything was spent');
  const r = await ana('POST', `/api/listings/${L1.id}/compare`, PINE_HOLLOW);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1);
  const mine = (await ana('GET', `/api/listings/${L1.id}`)).data;
  assert.strictEqual(r.data.me.score, mine.result.score);
  const theirs = L.cleanCompetitor(PINE_HOLLOW, mine);
  assert.strictEqual(r.data.them.score, R.score(theirs).score, 'their score is the same rules');
  assert.ok(r.data.theyDoBetter.length && r.data.youDoBetter.length && r.data.verdict);
  assert.deepStrictEqual(mine.compare.them.title, PINE_HOLLOW.title, 'the comparison is kept on the listing');
  assert.ok(!store._dump().includes('summer weekends go fast'), 'their description is not stored');
  const inj = await ana('POST', `/api/listings/${L1.id}/compare`, { ...PINE_HOLLOW, description: `${PINE_HOLLOW.description} INJECT` });
  assert.ok(!/[<>]/.test(JSON.stringify(inj.data)), 'markup stripped');
});

test('versions: read one, go back as a new version, and the original is always kept', async () => {
  const d = (await ana('GET', `/api/listings/${L1.id}`)).data;
  const first = d.versions[d.versions.length - 1];
  const v = await ana('GET', `/api/listings/${L1.id}/versions/${first.id}`);
  assert.deepStrictEqual([v.data.n, v.data.fields.title, v.data.result.score], [1, LOON_V1.title, R.score({ ...LOON_V1, photoCount: 100 }).score]);
  assert.strictEqual((await ana('GET', `/api/listings/${L1.id}/versions/nope-nope`)).status, 404);
  const back = await ana('POST', `/api/listings/${L1.id}/revert`, { versionId: d.versions[1].id });
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.data.versions[0].source, 'revert');
  assert.strictEqual(back.data.versions.length, d.versions.length + 1, 'going back adds, never deletes');
  assert.strictEqual(back.data.title, (await ana('GET', `/api/listings/${L1.id}/versions/${d.versions[1].id}`)).data.fields.title);
  // Fill the history past the cap: the oldest go, version 1 stays.
  const cap = await ana('POST', '/api/listings', { ...LOON_V1 });
  for (let i = 0; i < L.LIMITS.versions + 3; i++) await ana('PUT', `/api/listings/${cap.data.id}`, { price: `$${100 + i}` });
  const full = (await ana('GET', `/api/listings/${cap.data.id}`)).data;
  assert.strictEqual(full.versions.length, L.LIMITS.versions);
  assert.strictEqual(full.versions[full.versions.length - 1].n, 1, 'the original survives');
  assert.strictEqual(full.versions[0].n, L.LIMITS.versions + 4);
  await ana('DELETE', `/api/listings/${cap.data.id}`);
});

test('out of credit: 402 before any model call, while scoring, editing and sharing still work', async () => {
  await identityStore.merge('users', uidOf('ana@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  for (const [p, body] of [[`/api/listings/${L1.id}/glowup`, {}], [`/api/listings/${L1.id}/compare`, PINE_HOLLOW], ['/api/listings/read', { image: { type: 'image/jpeg', data: JPEG } }]]) {
    const r = await ana('POST', p, body);
    assert.strictEqual(r.status, 402, p);
    assert.ok('topUpUrl' in r.data);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
  const edit = await ana('PUT', `/api/listings/${L1.id}`, { price: '$199 / night' });
  assert.strictEqual(edit.status, 200, 'editing is free');
  assert.ok(edit.data.result.score >= 0, 'scoring is free');
  assert.strictEqual((await ana('GET', `/api/listings/${L1.id}/versions/${edit.data.versions[0].id}`)).status, 200);
  assert.strictEqual((await ana('GET', '/api/wins')).status, 200);
  await identityStore.merge('users', uidOf('ana@example.com'), { spentUsd: 0 });
});

test('snap a screenshot: non-image 400 before the model, unreadable 422, a proposal and nothing stored', async () => {
  const calls = await modelCalls();
  assert.strictEqual((await ana('POST', '/api/listings/read', { image: { type: 'image/jpeg', data: Buffer.from('%PDF-1.7 not an image').toString('base64') } })).status, 400);
  assert.strictEqual((await ana('POST', '/api/listings/read', { image: { type: 'application/pdf', data: JPEG } })).status, 400);
  assert.strictEqual((await ana('POST', '/api/listings/read', {})).status, 400);
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'refused before anything was spent');
  const dump = store._dump();
  assert.strictEqual((await ana('POST', '/api/listings/read', { image: { type: 'image/jpeg', data: BLANK } })).status, 422);
  const r = await ana('POST', '/api/listings/read', { image: { type: 'image/jpeg', data: JPEG } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual([r.data.type, r.data.platform, r.data.title, r.data.photoCount], ['stay', 'airbnb', 'Charming Cottage by the Sea', 11]);
  const big = await ana('POST', '/api/listings/read', { image: { type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024)]).toString('base64') } });
  assert.strictEqual(big.status, 200, 'the snap route takes a real screenshot');
  await settle();
  assert.strictEqual(await modelCalls(), calls + 3);
  assert.strictEqual(store._dump(), dump, 'reading a screenshot saves nothing');
  assert.ok(!store._dump().includes(JPEG.slice(0, 60)), 'the image is nowhere in the store');
});

test('the share card: frozen, public, read-only, no private text unless ticked, revocable', async () => {
  const d = (await ana('GET', `/api/listings/${L1.id}`)).data;
  const s = await ana('POST', `/api/listings/${L1.id}/share`, {});
  assert.strictEqual(s.status, 200);
  assert.ok(s.data.token.length >= 22 && L.TOKEN_RE.test(s.data.token));
  const anon = client();
  const pub = await anon('GET', `/api/shared/${s.data.token}`);
  assert.strictEqual(pub.status, 200);
  assert.deepStrictEqual([pub.data.title, pub.data.after.score, pub.data.before.score, pub.data.text, pub.data.preview], [d.title, d.result.score, d.trail[0], null, false]);
  const text = JSON.stringify(pub.data);
  assert.ok(!text.includes(d.description.slice(0, 40)), 'no description');
  assert.ok(!text.includes(LOON_V1.title), 'not the original title');
  assert.ok(!text.includes('lake cabin, hot tub') && !text.includes(uidOf('ana@example.com')) && !text.includes('ana@'), 'no keywords, no account');
  assert.strictEqual(pub.headers.get('referrer-policy'), 'no-referrer');
  assert.match(pub.headers.get('x-robots-tag'), /noindex/);
  const page = await fetch(`${base}/s/${s.data.token}`);
  assert.ok((await page.text()).includes('<base href="../">'));
  assert.strictEqual((await anon('POST', `/api/shared/${s.data.token}`, {})).status, 405, 'GET only');
  assert.strictEqual((await anon('DELETE', `/api/shared/${s.data.token}`)).status, 405);
  // Frozen: an edit changes nothing until Update.
  await ana('PUT', `/api/listings/${L1.id}`, { title: 'Lake cabin retitled after sharing' });
  assert.strictEqual((await anon('GET', `/api/shared/${s.data.token}`)).data.title, d.title);
  const up = await ana('POST', `/api/listings/${L1.id}/share`, { includeText: true });
  assert.strictEqual(up.data.token, s.data.token, 'Update re-freezes the same link');
  const withText = (await anon('GET', `/api/shared/${s.data.token}`)).data;
  assert.strictEqual(withText.title, 'Lake cabin retitled after sharing');
  assert.ok(withText.text && withText.text.description.length > 20, 'the text only when ticked');
  assert.strictEqual((await ana('GET', `/api/shared/${s.data.token}`)).data.preview, true, 'the owner sees a preview banner');
  assert.strictEqual((await ana('DELETE', `/api/listings/${L1.id}/share`)).status, 200);
  assert.strictEqual((await anon('GET', `/api/shared/${s.data.token}`)).status, 404, 'revoked for good');
  assert.strictEqual((await anon('GET', '/api/shared/short')).status, 404);
});

test('another user gets 404 everywhere, before any model call', async () => {
  eve = await register('eve@example.com');
  const calls = await modelCalls();
  const d = (await ana('GET', `/api/listings/${L1.id}`)).data;
  const vid = d.versions[0].id;
  for (const [m, p, b] of [['GET', `/api/listings/${L1.id}`], ['PUT', `/api/listings/${L1.id}`, { title: 'mine now' }], ['DELETE', `/api/listings/${L1.id}`],
    ['GET', `/api/listings/${L1.id}/versions/${vid}`], ['POST', `/api/listings/${L1.id}/revert`, { versionId: vid }],
    ['POST', `/api/listings/${L1.id}/share`, {}], ['DELETE', `/api/listings/${L1.id}/share`],
    ['POST', `/api/listings/${L1.id}/glowup`, {}], ['POST', `/api/listings/${L1.id}/compare`, PINE_HOLLOW]]) {
    assert.strictEqual((await eve(m, p, b)).status, 404, `${m} ${p}`);
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'a stranger’s id costs nothing');
  assert.deepStrictEqual((await eve('GET', '/api/listings')).data.listings, []);
  assert.strictEqual((await ana('GET', `/api/listings/${L1.id}`)).data.title, d.title, 'untouched');
});

test('caps: 200 listings a person', async () => {
  const uid = uidOf('eve@example.com');
  for (let i = 0; i < L.LIMITS.listings; i++) await store.set(`listings/${uid}/items`, `fill${i}`, { ...LOON_V1, score: 41, cats: {}, versionCount: 1, updatedAt: `x${i}` });
  const r = await eve('POST', '/api/listings', { ...LOON_V1 });
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /200/);
});

test('deleting a listing takes its versions and its share link with it', async () => {
  const s = await ana('POST', `/api/listings/${L1.id}/share`, {});
  assert.strictEqual((await ana('DELETE', `/api/listings/${L1.id}`)).status, 200);
  assert.strictEqual((await ana('GET', `/api/listings/${L1.id}`)).status, 404);
  assert.deepStrictEqual(await store.list(`listings/${uidOf('ana@example.com')}/items/${L1.id}/versions`), []);
  assert.strictEqual(await store.get('shares', s.data.token), null);
  const wins = await ana('GET', '/api/wins');
  assert.strictEqual(wins.data.listings, 0);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use('/glowup', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/glowup`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
