// The rules first - hand-worked menus, each with its arithmetic written
// out: margins, the two lines and the quadrant edges (exactly on a line,
// one dish alone, zero sales, a negative margin), the price and the units
// that cross a line, the what-if - then the exact readers, the text doors,
// the suggestions, the sales CSV and its mapper, the report CSV, the one
// door for a menu, the two-phone merge, the menu request and its answer,
// the demo's planted story, the storage module, the look, the page's
// promises and the copy; then end to end against the memory store and the
// fake model:
//   STARS_MEMORY=1 STARS_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /stars, the way
// the lab mounts it, so the auth cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every restaurant, dish and name here is made up. Phone, card, tax-id and
// account numbers are built from pieces, so no file carries any of them.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.STARS_MEMORY !== '1' || process.env.STARS_FAKE_AI !== '1') {
  console.error('run with STARS_MEMORY=1 STARS_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/stars-core');
const D = require('../public/demo');
const RS = require('../public/stars-store');
const img = require('../lib/image');
const aiLib = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), FW_AT = ch(0xFF20);
const clone = (v) => JSON.parse(JSON.stringify(v));
// The models, from pieces: no file but server.js names one.
const FREE_MODEL = ['claude', 'haiku', '4', '5'].join('-'), PAID_MODEL = ['claude', 'sonnet', '5'].join('-');
const PHONE = ['555', '201', '3344'].join(' ');
const CARD = ['4111'].concat(Array(3).fill('1111')).join(' ');
const TAXID = ['123', '45', '6789'].join('-');

/* ---------------- helpers ---------------- */

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function cieLab(h) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16)));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const labDist = (a, b) => { const x = cieLab(a), y = cieLab(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

/** A dish in cents: [id, price, cost, sold]. */
const dish = (id, price, cost, sold, cat) => ({ id, name: 'Dish ' + id, cat: cat || 'Mains', price, cost, sold });
const quads = (g) => Object.fromEntries(g.items.map((x) => [x.id, x.quad]));

/* ================================================================== *
 * Hand-worked menus. Money in cents; every line compared exactly.
 * ================================================================== */

test('hand-worked 1 - one of each quadrant: four dishes, 100 sold, margin line $4.70, popularity line 17.5 units; food cost per dish and for the section', () => {
  //   A  $10.00 - $4.00 = $6.00 margin, 50 sold    earns $300.00
  //   B  $10.00 - $7.00 = $3.00 margin, 40 sold    earns $120.00
  //   C  $12.00 - $4.00 = $8.00 margin,  5 sold    earns  $40.00
  //   D   $8.00 - $6.00 = $2.00 margin,  5 sold    earns  $10.00
  //   T = 100, TCM = $470.00, margin line = 470 / 100 = $4.70
  //   popularity line = 0.7 x 100 / 4 = 17.5 units (17.5% of sales)
  //   A: 6.00 >= 4.70, 50 >= 17.5  STAR        B: 3.00 < 4.70, 40 >= 17.5  PLOWHORSE
  //   C: 8.00 >= 4.70,  5 < 17.5   PUZZLE      D: 2.00 < 4.70,  5 < 17.5   DOG
  //   food cost: A 4/10 = 40.0%, B 70.0%, C 4/12 = 33.33 -> 33.3%, D 6/8 = 75.0%
  //   section: plate costs 200 + 280 + 20 + 30 = $530 over sales 500 + 400 + 60 + 40 = $1,000 -> 53.0%
  const g = C.analyse([dish('A', 1000, 400, 50), dish('B', 1000, 700, 40), dish('C', 1200, 400, 5), dish('D', 800, 600, 5)]);
  assert.deepStrictEqual(quads(g), { A: 'star', B: 'plowhorse', C: 'puzzle', D: 'dog' });
  assert.deepStrictEqual([g.sold, g.tcm, g.avgCm, g.popUnits10, g.popShare, g.revenue, g.foodCost, g.foodPct], [100, 47000, 470, 175, 175, 100000, 53000, 530]);
  assert.deepStrictEqual(g.items.map((x) => [C.fmtPct(x.foodPct), C.fmtPct(x.mix), C.fmtMoney(x.cm)]), [['40.0%', '50.0%', '$6.00'], ['70.0%', '40.0%', '$3.00'], ['33.3%', '5.0%', '$8.00'], ['75.0%', '5.0%', '$2.00']]);
  assert.deepStrictEqual(g.counts, { star: 1, plowhorse: 1, puzzle: 1, dog: 1 });
});

test('hand-worked 2 - exactly on the margin line counts as high: margins $5, $7, $3, ten sold each -> line exactly $5.00; the $5 dish is a star, not a plowhorse', () => {
  //   X $10 - $5 = $5.00, Y $10 - $3 = $7.00, Z $10 - $7 = $3.00, 10 sold each
  //   TCM = 50 + 70 + 30 = $150.00, T = 30 -> line $5.00 exactly
  //   popularity line 0.7 x 30 / 3 = 7 units: every dish (10) is popular
  //   X: 500 x 30 = 15000 >= 15000 (on the line) -> high -> STAR
  const g = C.analyse([dish('X', 1000, 500, 10), dish('Y', 1000, 300, 10), dish('Z', 1000, 700, 10)]);
  assert.deepStrictEqual(quads(g), { X: 'star', Y: 'star', Z: 'plowhorse' });
  assert.strictEqual(g.avgCm, 500);
  assert.ok(C.find(g, 'X').onCmLine && !C.find(g, 'Y').onCmLine);
  // A cent under the line is low: X at $9.99 has $4.99; TCM 14970 / 30 = 499 -> on the line again!
  // (its own price moves the line), so take the cent off Y instead: line 14970/30 = $4.99, X $5.00 above.
  assert.strictEqual(C.find(C.analyse([dish('X', 1000, 500, 10), dish('Y', 999, 300, 10), dish('Z', 1000, 700, 10)]), 'X').hiCm, true);
  // and one cent below: X $4.99 against a line of (499 + 700 + 300) x 10 / 30 = $4.99666... -> low
  assert.strictEqual(C.find(C.analyse([dish('X', 999, 500, 10), dish('Y', 1000, 300, 10), dish('Z', 1000, 700, 10)]), 'X').hiCm, false);
});

test('hand-worked 3 - exactly on the popularity line counts as popular: five dishes, 100 sold, line 0.7 x 100 / 5 = 14 units; 14 sold is popular, 13 is not (10 x 5 x 14 = 700 >= 7 x 100 = 700; 650 < 700)', () => {
  //   sales 14, 13, 30, 20, 23 = 100; every price $10, cost $4 (same margin, all on the margin line -> high)
  //   14 -> STAR (on the line), 13 -> PUZZLE
  const g = C.analyse([dish('a', 1000, 400, 14), dish('b', 1000, 400, 13), dish('c', 1000, 400, 30), dish('d', 1000, 400, 20), dish('e', 1000, 400, 23)]);
  assert.deepStrictEqual(quads(g), { a: 'star', b: 'puzzle', c: 'star', d: 'star', e: 'star' });
  assert.deepStrictEqual([g.popUnits10, g.popShare, C.find(g, 'a').onPopLine], [140, 140, true]);
});

test('hand-worked 4 - one dish alone in a section is compared with itself: its margin is the line and its share is 100% >= 70% - a star by definition, flagged lone; the price that crosses a line does not exist', () => {
  //   Kids pasta $9.00 - $2.00 = $7.00, 85 sold: TCM 595.00 / 85 = $7.00 = its own margin; 0.7 x 85 / 1 = 59.5 <= 85
  const g = C.analyse([dish('k', 900, 200, 85, 'Kids')]);
  assert.deepStrictEqual([quads(g).k, g.lone, g.avgCm, g.popUnits10], ['star', true, 700, 595]);
  assert.strictEqual(C.linePrice(g, C.find(g, 'k')), null);
  assert.ok(C.suggestions(g, C.find(g, 'k')).some((s) => /compared with itself/.test(s.text)));
  // ...unless it sold nothing: then it is not popular - a puzzle of one.
  assert.strictEqual(quads(C.analyse([dish('k', 900, 200, 0)])).k, 'puzzle');
});

test('hand-worked 5 - zero sales: a dish with none is never popular; a section where nothing sold has no popular dish and its margin line falls back to the plain average of the margins; a dish missing its plate cost or units waits, unrated', () => {
  //   P $12 - $4 = $8 (60 sold), Q $12 - $5 = $7 (40 sold), R $12 - $2 = $10 (0 sold)
  //   T = 100, TCM = 480 + 280 + 0 = $760 -> line $7.60; popularity 0.7 x 100 / 3 = 23.3
  //   R: 10.00 >= 7.60 but 0 sold -> PUZZLE; P STAR; Q PLOWHORSE
  const g = C.analyse([dish('P', 1200, 400, 60), dish('Q', 1200, 500, 40), dish('R', 1200, 200, 0)]);
  assert.deepStrictEqual(quads(g), { P: 'star', Q: 'plowhorse', R: 'puzzle' });
  assert.ok(C.suggestions(g, C.find(g, 'R')).some((s) => s.text === 'Not one sold in this period.'));
  //   nothing sold: margins $8, $7, $10 -> plain average 25 / 3 = $8.333...; 0 popular
  //   P 8.00 < 8.33 DOG, Q DOG, R 10.00 >= 8.33 PUZZLE
  const none = C.analyse([dish('P', 1200, 400, 0), dish('Q', 1200, 500, 0), dish('R', 1200, 200, 0)]);
  assert.deepStrictEqual([quads(none), none.noSales, none.avgCm, none.foodPct], [{ P: 'dog', Q: 'dog', R: 'puzzle' }, true, 833, null]);
  //   waiting: no plate cost, no units
  const w = C.analyse([dish('P', 1200, 400, 60), { id: 'W', name: 'W', cat: 'Mains', price: 800, cost: null, sold: 10 }]);
  assert.deepStrictEqual([w.n, w.waiting], [1, ['W']]);
});

test('hand-worked 6 - a negative margin: $9.00 with an $11.50 plate loses $2.50 a plate (food cost 127.8%); it pulls the line down and is a dog, flagged, and the first suggestion is to reprice above the plate cost', () => {
  //   S $14 - $5 = $9.00 x 50 = $450.00;  N $9.00 - $11.50 = -$2.50 x 50 = -$125.00
  //   TCM = $325.00, T = 100 -> line $3.25; popularity 0.7 x 100 / 2 = 35 units: both popular
  //   N: -2.50 < 3.25 -> PLOWHORSE (popular!) that loses money; food cost 1150 / 900 = 1.27777 -> 127.8%
  const g = C.analyse([dish('S', 1400, 500, 50), dish('N', 900, 1150, 50)]);
  const n = C.find(g, 'N');
  assert.deepStrictEqual([n.quad, n.cm, n.loses, C.fmtPct(n.foodPct), C.fmtMoney(n.cm), g.avgCm], ['plowhorse', -250, true, '127.8%', '−$2.50', 325]);
  const s = C.suggestions(g, n);
  assert.match(s[0].text, /^It loses \$2\.50 on every plate: the price is under the plate cost of \$11\.50\./);
  //   and unpopular too it is a dog: N with 10 sold -> TCM 450 - 25 = $425 / 60; 10 < 0.7 x 60 / 2 = 21
  assert.strictEqual(quads(C.analyse([dish('S', 1400, 500, 50), dish('N', 900, 1150, 10)])).N, 'dog');
  assert.strictEqual(C.moneyField(-250), '-2.50');
});

test('hand-worked 7 - the price that reaches the margin line moves the line with it: B (case 1) needs Δ >= (47000 - 300 x 100) / (100 - 40) = 283.3 -> 284 cents, so $12.84 (a cent less stays under); the plate cost that does the same is $4.16', () => {
  //   at $12.84: CM 584, TCM 47000 + 284 x 40 = 58360, line 583.6 -> 584 >= 583.6 HIGH -> a star
  //   at $12.83: CM 583, TCM 58320, line 583.2 -> 583 < 583.2 low -> still a plowhorse
  const items = [dish('A', 1000, 400, 50), dish('B', 1000, 700, 40), dish('C', 1200, 400, 5), dish('D', 800, 600, 5)];
  const g = C.analyse(items), b = C.find(g, 'B');
  assert.deepStrictEqual([C.lineDelta(g, b), C.linePrice(g, b), C.lineCost(g, b), C.menuPrice(C.linePrice(g, b))], [284, 1284, 416, 1300]);
  assert.strictEqual(C.whatIf(items, 'B', 1284).after.quad, 'star');
  assert.strictEqual(C.whatIf(items, 'B', 1283).after.quad, 'plowhorse');
  const w = C.whatIf(items, 'B', 1300, 30);
  //   $13.00 and 30 sold: CM 600; T 90, TCM 30000 + 18000 + 4000 + 1000 = 53000 -> line 588.9; 600 high;
  //   popularity 0.7 x 90 / 4 = 15.75 -> 30 popular -> STAR; the before is unchanged
  assert.deepStrictEqual([w.after.quad, w.after.cm, w.groupAfter.avgCm, w.before.quad], ['star', 600, 589, 'plowhorse']);
  assert.strictEqual(C.linePrice(g, C.find(g, 'A')), null, 'a dish already over the line needs nothing');
  //   nothing sold: the plain average, (n - 1) in place of T - s: margins 8, 7, 10 -> P needs Δ >= (2500 - 800 x 3) / 2 = 50
  const none = C.analyse([dish('P', 1200, 400, 0), dish('Q', 1200, 500, 0), dish('R', 1200, 200, 0)]);
  assert.strictEqual(C.lineDelta(none, C.find(none, 'P')), 50);
  assert.strictEqual(C.find(C.analyse([dish('P', 1250, 400, 0), dish('Q', 1200, 500, 0), dish('R', 1200, 200, 0)]), 'P').hiCm, true, '8.50 vs (850 + 700 + 1000) / 3 = 8.50: on the line');
});

test('hand-worked 8 - the units a puzzle needs to be popular, the others selling the same: C (case 1) needs s >= 7 x (100 - 5) / (40 - 7) = 20.15 -> 21; at 21 the line is 0.7 x 116 / 4 = 20.3, at 20 it is 20.125', () => {
  const items = [dish('A', 1000, 400, 50), dish('B', 1000, 700, 40), dish('C', 1200, 400, 5), dish('D', 800, 600, 5)];
  const g = C.analyse(items);
  assert.strictEqual(C.popNeeded(g, C.find(g, 'C')), 21);
  assert.strictEqual(C.whatIf(items, 'C', null, 21).after.quad, 'star');
  assert.strictEqual(C.whatIf(items, 'C', null, 20).after.quad, 'puzzle');
  assert.match(C.suggestions(g, C.find(g, 'C'))[0].text, /About 21 sold \(16 more\) would make it popular/);
  assert.strictEqual(C.popNeeded(g, C.find(g, 'A')), null);
  // Saltmarrow's risotto: 7 x (875 - 70) / (60 - 7) = 5635 / 53 = 106.3 -> 107
  const s = C.sectionOf(D.book(), D.RISOTTO);
  assert.strictEqual(C.popNeeded(s.g, C.find(s.g, D.RISOTTO)), 107);
});

test('exact numbers: money read digit by digit into cents ($14, 13.5, 1,234.50, .5), never parseFloat; units whole; shares rounded once, a half up, in BigInt; big sums stay exact', () => {
  assert.deepStrictEqual(['$14', '13.5', '1,234.50', '.5', '0', '$ 9.99'].map((s) => C.parseMoney(s).v), [1400, 1350, 123450, 50, 0, 999]);
  for (const bad of ['', '14.555', '1,23', 'ten', '-3', '12345678']) assert.ok(C.parseMoney(bad).error, bad);
  assert.deepStrictEqual(['120', '1,012', '0'].map((s) => C.parseUnits(s).v), [120, 1012, 0]);
  for (const bad of ['1.5', '-2', '2o4', '1000000']) assert.ok(C.parseUnits(bad).error, bad);
  assert.deepStrictEqual([C.roundDiv(5, 2), C.roundDiv(-5, 2), C.roundDiv(-7, 2), C.roundDiv(1, 3), C.permille(1, 3), C.permille(2, 3), C.permille(1, 8)], [3, -2, -3, 0, 333, 667, 125]);
  assert.deepStrictEqual([C.fmtMoney(123456789), C.fmtMoney(-5), C.fmtPct(1048), C.fmtPct(5)], ['$1,234,567.89', '−$0.05', '104.8%', '0.5%']);
  // 400 dishes at the caps: 99,999 cents x 999,999 units each - sums past 2^53 if multiplied once more, so shares go through BigInt
  const big = Array.from({ length: 400 }, (_, i) => dish('b' + i, 99999, i % 2 ? 0 : 99998, 999999));
  const g = C.analyse(big);
  assert.strictEqual(g.revenue, 99999 * 999999 * 400);
  assert.strictEqual(g.foodPct, 500);
  assert.ok(!/parseFloat|Number\(s\)\s*\/|toFixed\(2\)/.test(read('public/stars-core.js').replace(/\/\*[\s\S]*?\*\//g, '')), 'no float reading of money');
});

test('the text doors: a dish name, a section and the period refuse an @, a link, a phone, nine digits, a card, markup, a formula and invisible characters; ordinary dish names (with numbers, accents, ampersands) pass; pasted menu text must lose its phone and web address', () => {
  for (const ok of ['Burrata & peaches', 'Crème brûlée', 'Oysters (6)', 'Half-dozen wings', 'Shirley Temple', '1/2 chicken', 'Pho #4']) assert.strictEqual(C.nameProblem(ok), '', ok);
  for (const bad of ['mail' + AT + 'x', 'x' + FW_AT + 'y', 'see menu.example.com', 'Call ' + PHONE, TAXID, CARD, '<b>x</b>', '=SUM(A1)', 'a' + RLO, '', 'x'.repeat(61), 'two\nlines']) assert.ok(C.nameProblem(bad), JSON.stringify(bad));
  assert.ok(C.catProblem('') && C.catProblem('x'.repeat(31)) && !C.catProblem('Small plates'));
  assert.ok(!C.periodProblem('') && !C.periodProblem('Four weeks to 30 March') && C.periodProblem('x'.repeat(41)));
  assert.match(C.pasteProblem(D.MENU_TEXT + '\nBook on ' + PHONE), /Take out the phone number/);
  assert.match(C.pasteProblem('www.example.com'), /Take out/);
  assert.strictEqual(C.pasteProblem(D.MENU_TEXT), '');
  assert.ok(C.pasteProblem('x'.repeat(8001)));
});

test('suggestions in plain words for every kind: a star kept and shown off, a plowhorse repriced to the exact line price or reworked to the exact plate cost, a puzzle repositioned with the units it needs, a dog cut', () => {
  const s = C.sectionOf(D.book(), D.FISH), g = s.g;
  const kinds = (id) => C.suggestions(g, C.find(g, id)).map((x) => x.kind);
  assert.deepStrictEqual(kinds('imain00001'), ['keep', 'reposition', 'reprice']);
  assert.deepStrictEqual(kinds(D.FISH), ['reprice', 'rework', 'reposition']);
  assert.deepStrictEqual(kinds(D.RISOTTO), ['reposition', 'reprice', 'cut']);
  assert.deepStrictEqual(kinds('imain00005'), ['cut', 'reprice', 'rework']);
  assert.deepStrictEqual(kinds(D.LINGUINE), ['reprice', 'cut', 'rework']);
  const fish = C.suggestions(g, C.find(g, D.FISH)).map((x) => x.text).join(' ');
  //   fish: Δ >= (1064500 - 1040 x 875) / (875 - 260) = 154500 / 615 = 251.2 -> 252 -> $21.52; cost 860 - 252 = $6.08
  assert.ok(fish.includes('At $21.52 or more') && fish.includes('try $21.75') && fish.includes('down to $6.08'), fish);
  for (const x of g.items) for (const o of C.suggestions(g, x)) assert.ok(!/[<>]/.test(o.text));
});

test('the sales CSV on the phone: the header guessed into a column map (any case and order), changeable; rows for one dish add their units; matched by name within the section, case ignored; a new dish needs a price; a refused name never echoed; applied with the page’s ids; the template', () => {
  const b = D.book();
  const plan = C.csvPlan(D.CSV);
  assert.deepStrictEqual(plan.map, { name: 0, cat: 1, price: 3, cost: -1, sold: 2 });
  const r = C.csvRows(plan, plan.map, b);
  assert.deepStrictEqual([r.ok, r.bad, r.adds, r.updates], [8, 3, 1, 7]);
  const rib = r.rows.find((x) => x.name === 'Braised short rib');
  assert.deepStrictEqual([rib.sold, rib.rows, rib.match], [202, [2, 3], 'imain00001'], '104 + 98');
  assert.strictEqual(r.rows.find((x) => x.name === 'Crispy squid').sold, 1012);
  assert.deepStrictEqual(r.rows.filter((x) => x.errors.length).map((x) => [x.name, x.errors[0]]), [
    ['Chef special', 'A new dish needs a price.'],
    ['(refused name)', C.WHY.phone],
    ['Grilled flatbread', 'Units sold should be a whole number, like 120.'],
  ]);
  assert.ok(!JSON.stringify(r).includes(PHONE.replace(/ /g, '')) && !JSON.stringify(r).includes('555 014'), 'the refused name is not echoed');
  let n = 0;
  const after = C.applyRows(b, r, D.T + 99, () => 'inewdish' + n++);
  assert.deepStrictEqual([after.items.imain00003.price, after.items.imain00003.sold, after.items.imain00003.cost, after.items.imain00003.t], [1750, 233, 610, D.T + 99], 'price and units updated, the plate cost kept');
  assert.deepStrictEqual(after.items.inewdish0, { name: 'Pickled eggs', cat: 'Bar snacks', price: 500, cost: null, sold: 30, t: D.T + 99 });
  assert.deepStrictEqual(C.cleanBook(after, true).errors, []);
  // Remapped by hand: the price column ignored -> the new dish has no price, the rest still update.
  const r2 = C.csvRows(plan, Object.assign({}, plan.map, { price: -1 }), b);
  assert.deepStrictEqual([r2.adds, r2.updates], [0, 7]);
  assert.match(C.csvRows(plan, Object.assign({}, plan.map, { name: -1 }), b).error, /dish names/);
  assert.match(C.csvRows(plan, { name: 0, cat: -1, price: -1, cost: -1, sold: -1 }, b).error, /at least one/);
  assert.deepStrictEqual(C.csvPlan('Item,Category,PRICE,Plate_Cost,Units Sold\nx,y,1,1,1').map, { name: 0, cat: 1, price: 2, cost: 3, sold: 4 });
  assert.match(C.csvPlan('only a header').error, /header row and at least one/);
  assert.match(C.csvPlan('a\n' + 'x\n'.repeat(2001)).error, /2000 rows/);
  assert.strictEqual(C.csvPlan('Item,=cmd|x,Sold\na,b,1').head[1], 'Column 2', 'a header that would be a formula is not shown');
  assert.strictEqual(C.TEMPLATE, 'item,category,price,plate cost,units sold\n');
});

test('the report as CSV: every section and dish, money as dollars, shares to a tenth, the lines; a formula-starting cell quoted, a negative margin left a number; unrated dishes listed', () => {
  const csv = C.reportCsv(D.book());
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines[0], 'section,dish,price,plate_cost,food_cost_pct,contribution_margin,units_sold,menu_mix_pct,margin,popularity,quadrant,section_margin_line,section_popularity_line_units');
  assert.ok(lines.includes('Mains,Lobster linguine,29.00,30.40,104.8,-1.40,55,6.3,low,low,Dog,12.17,102.1'), csv);
  assert.ok(lines.includes('Mains,Beer-battered fish,19.00,8.60,45.3,10.40,260,29.7,low,high,Plowhorse,12.17,102.1'));
  assert.ok(lines.includes('Sides,Truffle fries,8.00,,,,,,,,not rated,,'));
  assert.strictEqual(lines.length, 18);
  assert.strictEqual(C.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.strictEqual(C.csvCell('-1.40'), '-1.40');
});

test('the one door for a menu: strict refuses anything out of shape, whole (unknown fields, a float price, a bad id, a refused name, a price of zero, a plate cost out of range); lenient mends and drops; bodyProblem first', () => {
  const b = D.book();
  assert.deepStrictEqual(C.cleanBook(b, true).errors, []);
  const bad = [
    (x) => { x.extra = 1; }, (x) => { x.v = 2; }, (x) => { x.items.imain00001.price = 28.5; }, (x) => { x.items.imain00001.supplier = 'x'; },
    (x) => { x.items['../x'] = x.items.imain00001; }, (x) => { x.items.imain00001.name = 'Call ' + PHONE; }, (x) => { x.items.imain00001.price = 0; },
    (x) => { x.items.imain00001.cost = 100000; }, (x) => { x.items.imain00001.sold = -1; }, (x) => { x.items.imain00001 = { del: true, t: 5, name: 'x' }; },
    (x) => { x.items.imain00001.t = '1'; }, (x) => { x.period = { label: 'x', t: 1, who: 'x' }; }, (x) => { x.items.imain00001.cat = ''; },
  ];
  for (const f of bad) { const x = clone(b); f(x); assert.ok(C.cleanBook(x, true).errors.length, f.toString()); }
  const x = clone(b); x.items.imain00001.name = '<i>x</i>'; x.items.imain00002.supplier = 'x';
  const lenient = C.cleanBook(x, false);
  assert.ok(lenient.book.items.imain00001.name === 'x' && lenient.book.items.imain00002 && !('supplier' in lenient.book.items.imain00002), 'the markup mended away, the unknown field dropped');
  assert.ok(C.bodyProblem({ a: ['x' + AT + 'y'] }) && C.bodyProblem({ a: TAXID.replace(/-/g, '') }) && C.bodyProblem({ a: 'x.example.com' }) && C.bodyProblem({ a: '<i>' }) && C.bodyProblem({ a: 'a' + RLO }));
  assert.strictEqual(C.bodyProblem(b), '');
});

test('two phones: each dish by its own time, the period by its own; a removal is a change; a dish both phones changed since they last agreed keeps both - the other as "(other phone)"; symmetric and idempotent over 150 random pairs', () => {
  const base = D.book();
  const a = C.putItem(base, 'inewaaaa01', { name: 'Phone A dish', cat: 'Mains', price: 1000, cost: null, sold: null }, D.T + 10);
  const bb = C.removeItem(C.putItem(base, 'inewbbbb01', { name: 'Phone B dish', cat: 'Mains', price: 900, cost: 300, sold: 4 }, D.T + 11), 'idess00003', D.T + 12);
  const m = C.merge(C.setPeriod(a, 'March', D.T + 13), bb, D.T).book;
  assert.ok(m.items.inewaaaa01 && m.items.inewbbbb01 && m.items.idess00003.del && m.period.label === 'March');
  const ea = clone(base); ea.items.imain00005.price = 2500; ea.items.imain00005.t = D.T + 20;
  const eb = clone(base); eb.items.imain00005.cost = 1200; eb.items.imain00005.t = D.T + 30;
  const both = C.merge(ea, eb, D.T);
  assert.strictEqual(both.book.items.imain00005.cost, 1200, 'the later change wins');
  assert.strictEqual(both.book.items[C.copyIdOf('imain00005')].name, 'Confit duck leg (other phone)');
  assert.strictEqual(both.notes.length, 1);
  assert.ok(!C.merge(ea, eb, D.T + 25).book.items[C.copyIdOf('imain00005')], 'changed on one phone since the base: no copy');
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ids = Object.keys(base.items);
  const mutate = (b0) => {
    let b = clone(b0);
    for (let i = 0; i < 3; i++) {
      const id = ids[rnd(ids.length)], t = D.T + 1 + rnd(50);
      if (rnd(4) === 0) b = C.removeItem(b, id, t);
      else if (!b.items[id].del) { const it = clone(b.items[id]); it.price += 25 * (1 + rnd(8)); b = C.putItem(b, id, it, t); }
      if (rnd(5) === 0) b = C.setPeriod(b, 'P' + rnd(9), t);
    }
    return b;
  };
  for (let i = 0; i < 150; i++) {
    const x = mutate(base), y = mutate(base);
    const xy = C.merge(x, y, D.T).book, yx = C.merge(y, x, D.T).book;
    assert.strictEqual(C.canon(xy), C.canon(yx), 'symmetric');
    assert.strictEqual(C.canon(C.merge(xy, xy, D.T).book), C.canon(xy), 'idempotent');
    assert.deepStrictEqual(C.cleanBook(xy, true).errors, [], 'passes the strict door');
  }
});

test('the menu request is the photos alone or the pasted menu alone - exactly {images} or {text}; a plate cost, sales or the menu itself beside them refused before a model call', () => {
  const good = { images: [{ type: 'image/jpeg', data: 'A'.repeat(40) }] };
  assert.deepStrictEqual(C.menuRequest(good), { req: good });
  assert.deepStrictEqual(C.menuRequest({ text: ' ' + D.MENU_TEXT + '\r\n' }), { req: { text: D.MENU_TEXT } });
  for (const bad of [null, [], {}, { images: [] }, Object.assign({}, good, { costs: [1] }), Object.assign({}, good, { sold: 5 }), Object.assign({}, good, { text: 'x' }), { text: 5 }, { images: [{ type: 'image/gif', data: 'A'.repeat(40) }] }, { images: [{ type: 'image/jpeg', data: 'A'.repeat(40), name: 'm.jpg' }] }, { images: [good.images[0], good.images[0], good.images[0]] }, { text: 'Call ' + PHONE }]) {
    assert.ok(C.menuRequest(bad).error, JSON.stringify(bad));
  }
  assert.strictEqual(C.menuRequest(Object.assign({}, good, { costs: 1 })).code, 'extra-field');
});

test('the reading checked: only dishes, sections and prices; a plate cost, units sold, a phone-number "dish", advice and any other field dropped and named; prices read exactly and in range ("market price" left to check, a million dropped); form strings only; nothing readable an error', () => {
  const r = C.cleanAiMenu(D.MENU_RAW);
  assert.deepStrictEqual(r.items.map((x) => [x.name, x.cat, x.price, x.unsure]), [
    ['Charred leeks, romesco', 'Small plates', '11.00', false], ['Smoked trout rillettes', 'Small plates', '13.50', false], ['Market oysters (6)', 'Small plates', '', true],
    ['Hanger steak, chimichurri', 'Larger plates', '32.00', false], ['Roast cauliflower, tahini', 'Larger plates', '19.00', false], ['Pork chop, apple mostarda', 'Larger plates', '27.50', false],
  ]);
  assert.deepStrictEqual(r.dropped, ['restaurant_phone', 'plate_cost', 'units_sold', '1 dish name with a phone number, address or markup']);
  assert.ok(!JSON.stringify(r).includes('14.20') && !JSON.stringify(r).includes('80'), 'the plate cost and the units never come through');
  const big = C.cleanAiMenu({ items: [{ name: 'Gold sundae', section: '', price: '1,000,000', unsure: false }, { name: 'Gold sundae', section: '', price: '9', unsure: false }] });
  assert.deepStrictEqual(big.items, [{ name: 'Gold sundae', cat: 'Menu', price: '', unsure: true }], 'out of range left to check; a repeat dropped');
  assert.strictEqual(C.cleanAiMenu({ items: [] }).code, 'unreadable');
  assert.strictEqual(C.cleanAiMenu('x').code, 'unreadable');
  assert.strictEqual(C.cleanAiMenu({ items: Array.from({ length: 120 }, (_, i) => ({ name: 'Dish ' + i, section: 'A', price: '5', unsure: false })) }).items.length, 80);
});

test('the demo’s planted story: Saltmarrow Kitchen, seventeen dishes in five sections; Mains one of each kind with the line at $12.17 and 102.1 units, the linguine losing $1.40 a plate; Kids a lone star; Sides one dish waiting for its costs; the example CSV and the example menu', () => {
  const b = D.book();
  assert.strictEqual(D.NAME, 'Saltmarrow Kitchen');
  assert.strictEqual(C.liveItems(b).length, 17);
  const secs = C.sections(b);
  assert.deepStrictEqual(secs.map((s) => s.name), ['Starters', 'Mains', 'Sides', 'Kids', 'Desserts']);
  const mains = secs[1].g;
  //   T = 210 + 260 + 240 + 70 + 40 + 55 = 875; TCM = 3822 + 2704 + 2616 + 1176 + 404 - 77 = $10,645.00
  //   line 10645 / 875 = 12.1657 -> $12.17; popularity 0.7 x 875 / 6 = 102.08
  assert.deepStrictEqual([mains.sold, mains.tcm, mains.avgCm, mains.popUnits10], [875, 1064500, 1217, 1021]);
  assert.deepStrictEqual(quads(mains), { imain00002: 'plowhorse', imain00001: 'star', imain00005: 'dog', imain00006: 'dog', imain00003: 'plowhorse', imain00004: 'puzzle' });
  assert.ok(C.find(mains, D.LINGUINE).loses && C.find(mains, D.LINGUINE).cm === -140);
  assert.deepStrictEqual([secs[3].g.lone, quads(secs[3].g)], [true, { ikids00001: 'star' }]);
  assert.deepStrictEqual([secs[2].g.n, secs[2].g.waiting], [0, ['iside00001']]);
  for (const s of [secs[0], secs[4]]) assert.ok(['star', 'plowhorse', 'puzzle', 'dog'].every((q) => s.g.counts[q] >= 1), s.name + ' shows every kind');
  //   the tour's what-if: fish at $21.75 -> CM 13.15, TCM 1064500 + 275 x 260 = 1136000 / 875 = $12.98 -> STAR
  const w = C.whatIf(secs[1].items, D.FISH, 2175);
  assert.deepStrictEqual([w.after.quad, w.after.cm, w.groupAfter.avgCm], ['star', 1315, 1298]);
  assert.deepStrictEqual(C.cleanBook(b, true).errors, []);
});

test('storage: one module; the menu through the one door; this phone’s restaurant name refused if it carries an @ or a link; IndexedDB wrapped - throwing, blocked or missing falls back to memory and says so', async () => {
  const s = RS.create(RS.memory());
  assert.strictEqual(await s.getBook(), null);
  const b = D.book(); b.items.imain00001.supplier = 'x';
  await s.putBook(b);
  const back = await s.getBook();
  assert.ok(back.items.imain00001 && !('supplier' in back.items.imain00001), 'kept through the lenient door');
  await s.putDevice({ tour: true, place: D.NAME, extra: 1 });
  assert.deepStrictEqual(await s.getDevice(), { tour: true, place: D.NAME });
  await s.putDevice({ place: 'x' + AT + 'kitchen' });
  assert.strictEqual((await s.getDevice()).place, '');
  await s.putSync({ base: 'x', at: 5 });
  assert.deepStrictEqual(await s.getSync(), { base: null, at: 5 });
  const throwing = { open() { throw new Error('nope'); } };
  const t = RS.create(RS.idb('stars', throwing));
  await t.putBook(D.book());
  assert.ok((await t.getBook()).items.imain00001, 'falls back to memory');
  assert.strictEqual(t.persistent(), false);
  assert.strictEqual(RS.create(RS.idb('stars', null)).persistent(), false);
  const blocked = { open() { const req = {}; setTimeout(() => req.onblocked && req.onblocked(), 0); return req; } };
  const bl = RS.create(RS.idb('stars', blocked));
  await bl.putDevice({ tour: true });
  assert.strictEqual((await bl.getDevice()).tour, true);
  assert.strictEqual(bl.persistent(), false);
});

test('every text colour holds 4.5:1 on its surface in both themes; the quadrant marks 3:1 on the cards and their numbers 4.5:1; the hero; the lab card (white text, 20+ in CIE Lab from every card, drop #68, ⭐ shared only with Rave); 44px targets; tables scroll in their own box; no sideways scroll; reduced motion; a print sheet', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  assert.deepStrictEqual(Object.keys(dark).sort(), Object.keys(light).sort(), 'every token has a dark value');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'bar-bg', 'sticky', 'accent-soft', 'warn-bg', 'ok-bg', 'bad-bg', 'info-bg']) ok('text', bg);
    for (const bg of ['bg', 'card', 'card2', 'sticky', 'accent-soft']) { ok('muted', bg); ok('link', bg); ok('ink', bg); }
    ok('muted', 'info-bg'); ok('accent-ink', 'accent'); ok('bg', 'text'); ok('accent', 'card'); ok('ink', 'card2');
    for (const k of ['bad', 'warn', 'info', 'ok']) { ok(k, `${k}-bg`); ok(k, 'card'); ok(k, 'card2'); ok(k, 'bg'); }
    for (const q of ['q-star', 'q-plow', 'q-puzzle', 'q-dog']) { ok(q, 'card', 3); ok(q, 'card2', 3); ok('dot-ink', q); }
  }
  assert.match(css, /\.hero \{[^}]*linear-gradient\(150deg, #7d0f40 0%, #b0175c 45%, #5b3a29 100%\)/);
  for (const bg of ['#7d0f40', '#b0175c', '#5b3a29']) for (const fg of ['#ffffff', '#fff5f9']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}`);
  assert.ok(ratio('#7d0f40', '#fff5f9') >= 4.5 && ratio('#221a16', '#f6f0ec') >= 4.5 && ratio('#4f453f', '#f6f0ec') >= 4.5 && ratio('#8a1148', '#fbe8ef') >= 4.5, 'the quadrant card');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.chip', '.input, textarea.input, select.input', '.drow', '.photobtn', '.checkrow']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  assert.ok(/\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css) && /\.tablebox \{ overflow-x: auto; max-width: 100%;/.test(css));
  assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/.test(css));
  const print = /@media print \{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(print, /\.top, \.tabbar, \.guide, \.ribbon, \.btns, \.sheet/);
  const paper = {}; for (const [, k, v] of /:root, :root:not\(\[data-theme="light"\]\), :root\[data-theme="dark"\] \{([\s\S]*?)\}/.exec(print)[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) paper[k] = v;
  assert.deepStrictEqual(paper, light, 'paper is printed in the light tokens, whatever the phone’s theme (found rendering the report in dark mode)');
  const js = read('public/app.js');
  assert.strictEqual((js.match(/<table class="grid">/g) || []).length, 2);
  assert.strictEqual((js.match(/<div class="tablebox" tabindex="0" role="region"/g) || []).length, 2, 'every table in its own scrolling box');
  // The lab card.
  const LAB = require('../../../lab');
  const lab = LAB.get('stars');
  assert.ok(lab, 'Stars is in lab.js');
  assert.deepStrictEqual([lab.color, lab.color2, lab.dropped, lab.status, lab.emoji, lab.audience], ['#da0185', '#453702', '2026-11-22', 'testing', '\u2B50', 'Owners, chefs and managers of independent restaurants']);
  assert.strictEqual(lab.tagline, 'Find the stars on your menu - and the dogs eating your margin.');
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const other of LAB.APPS.filter((x) => x.slug !== 'stars')) {
    for (const c of [other.color, other.color2]) assert.ok(labDist(lab.color, c) >= 20 && labDist(lab.color2, c) >= 20, `away from ${other.slug} ${c}: ${labDist(lab.color, c).toFixed(1)} / ${labDist(lab.color2, c).toFixed(1)}`);
    if (other.slug !== 'rave') assert.notStrictEqual(other.emoji, lab.emoji, `${other.slug} has the same emoji`);
  }
  assert.ok(labDist(lab.color, lab.color2) >= 20);
  assert.strictEqual(LAB.APPS.findIndex((x) => x.slug === 'stars') + 1, 68, 'drop #68');
  assert.strictEqual(lab.features.length, 4);
});

test('the page: relative links, no inline script or handlers, the banner, the star with no variation selector, storage only through stars-store.js, no clock or dice in the core or the demo, the requests it makes, the body shown is the body sent, every received string escaped, the tour', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  assert.ok(html.includes('\u2B50') && !html.includes('\u2B50\uFE0F'), 'the star, no variation selector');
  const js = read('public/app.js');
  assert.ok(!js.includes('\uFE0F'));
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(js), 'the page touches no storage itself');
  for (const f of ['public/stars-core.js', 'public/demo.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(/.test(src), `${f} has no dice and no clock`);
  }
  const all = js + read('public/stars-core.js') + read('public/demo.js') + read('public/stars-store.js');
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(all), 'no eval of any kind');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/menu', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/sync'], 'the page asks for nothing else');
  assert.strictEqual((js.match(/\bfetch\(/g) || []).length, 2, 'two fetches: api() and the verify resend');
  assert.match(js, /api\('PUT', 'api\/sync', \{ data: bodyOf\(state\.book\), base:/);
  // "Read the menu": the body built from what the sheet shows, and nothing else - never a cost or a sale.
  assert.match(js, /if \(r\.mode === 'text'\) return \{ text: r\.text \};\n\s*return \{ images: \[1, 2\]\.filter\(function \(s\) \{ return r\.photos\[s\]; \}\)\.map\(function \(s\) \{ return \{ type: 'image\/jpeg', data: r\.photos\[s\]\.split\(','\)\[1\] \}; \}\) \};/);
  assert.match(js, /var sent = readBody\(\);\n\s*btn\.disabled = true;/);
  assert.match(js, /api\('POST', 'api\/ai\/menu', sent\)/);
  assert.match(js, /<img alt="The photo that will be sent" src="' \+ esc\(r\.photos\[s\]\) \+ '">/);
  assert.match(js, /Never your plate costs, your sales or anything else in Stars\./);
  assert.match(js, /var k = Math\.min\(1, side \/ Math\.max\(img\.naturalWidth, img\.naturalHeight\)\);/, 'redrawn through a canvas');
  assert.match(js, /C\.itemFrom\(\{ name: x\.name, cat: x\.cat, price: x\.price, cost: '', sold: '' \}, t\)/, 'a reading adds dishes with no cost or sales');
  assert.strictEqual((js.match(/type="email"/g) || []).length, 1, 'only the sign-in form asks for an email - the account holder’s own');
  assert.ok(!/type="tel"|autocomplete="(tel|street-address|address-line1|postal-code|cc-number|name|given-name|family-name)"/i.test(js + html));
  assert.ok(!/geolocation|getCurrentPosition|watchPosition/.test(all));
  assert.match(js, /download\('stars-menu-report\.csv', C\.reportCsv\(book\(\)\), 'text\/csv'\)/, 'the report exported from the phone');
  assert.match(js, /case 'print': window\.print\(\); break;/);
  assert.match(js, /rd\.readAsText\(f\)/, 'the CSV read on the phone');
  // Every interpolation of something a person, the server or a model wrote goes through esc().
  const strip = (src) => { let out = ''; let i = 0; const re = /\besc\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|textContent|say\(/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(?!SAFE\b)([a-zA-Z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*(?:\([^()]*\))?)\s*\+/g);
  const allowed = (r) => /\+\s*(?:[a-zA-Z]*Html(?:\([^()]*\))?|html|rows|body|seg|sug|why|mapper|cards|counts|parts|moves|dots|cats|acts|head|nm|opts\([^()]*\)|i|x\([^()]*\)|y\([^()]*\)|qx|qy|pl|pr|pt|pb|W|H|tx|ty|anchor|mode|corner\([^()]*\)|quadChip\([^()]*\)|waitChip\([^()]*\)|fieldHtml\([^()]*\)|guideHtml\([^()]*\)|chartSvg\([^()]*\)|chartTable\([^()]*\)|sectionNote\([^()]*\)|whatIfOut\([^()]*\)|whatIfHtml\([^()]*\)|demoRibbon\(\)|mergeNoteHtml\(\)|syncLine\(\)|legendHtml\(\)|csvHtml\(\)|readingHtml\(\)|D\.menuSvg\(\))\s*\+/.test(r);
  const bad = (risky || []).filter((r) => !allowed(r));
  assert.deepStrictEqual(bad, [], `unescaped: ${bad}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbrief\b|\bbook\b|\bimages?\b|\btext\b|\bdata\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /stars-shell-v1/.test(sw) && ['stars-core.js', 'stars-store.js', 'demo.js', 'app.js'].every((f) => sw.includes(`'${f}'`)) && /k\.indexOf\('stars-'\) === 0/.test(sw), 'the service worker caches only the app shell, never api/, and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  // The tour: six steps, in order, each with its view and words.
  const tour = /var TOUR = \[([\s\S]*?)\n {2}\];/.exec(js)[1];
  assert.deepStrictEqual([...tour.matchAll(/view: '(\w+)'/g)].map((m) => m[1]), ['menu', 'dish', 'chart', 'import', 'import', 'report']);
  for (const w of ['Open the beer-battered fish', 'Try $21.75 in the what-if', 'Show the whole menu', 'Read the example sales file', 'Read the example menu', 'Print the report', 'Start my own menu', '$12.17', '102.1 units', 'at $21.52 it reaches the line']) assert.ok(tour.includes(w), w);
  for (const v of ['menuHtml', 'dishHtml', 'editHtml', 'chartViewHtml', 'importHtml', 'reportHtml', 'moreHtml']) assert.ok(new RegExp('function ' + v + '\\(\\) \\{[\\s\\S]{0,3000}?demoRibbon\\(\\)').test(js), `${v} carries the ribbon`);
  // The chart is never colour alone: a number on every dot, a label, a table beside it.
  assert.match(js, /role="img" data-act="dot" data-tip="' \+ esc\(label\) \+ '" aria-label="' \+ esc\(label\) \+ '"><title>/);
  assert.match(js, /chartSvg\(cur, 'qc'\) \+ '<p class="tip" id="qtip" aria-live="polite">[^']*' \+\n\s*chartTable\(cur, true\)/);
  assert.match(js, /document\.addEventListener\('visibilitychange'[\s\S]{0,200}if \(signedIn\(\)\) syncIn\(\);/);
});

test('the copy: no restaurant, chain or brand name in any file; no invisible characters, key-shaped strings, email addresses, phone numbers or session links; model names only in MODELS; CLAUDE.md says it is a rebuild, documents the method and cites it without naming anyone', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x));
  assert.ok(files.length >= 20);
  const marks = [['Mc', 'Donald'], ['Star', 'bucks'], ['Chi', 'potle'], ['Toa', 'st'], ['Square', ' POS'], ['Light', 'speed'], ['Clo', 'ver POS'], ['Open', 'Table'], ['Re', 'sy'], ['Ye', 'lp'], ['Door', 'Dash'], ['Grub', 'hub'], ['Uber ', 'Eats'], ['Mich', 'elin'], ['Kas', 'avana'], ['Smi', 'th'], ['Pav', 'esic'], ['Exc', 'el'], ['Goo', 'gle'], ['Ama', 'zon'], ['Cor', 'nell']].map((p) => p.join(''));
  const markRe = new RegExp('(^|[^A-Za-z])(' + marks.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z])');
  assert.ok(markRe.test('a ' + marks[1] + ' latte') && !markRe.test('the stars on the menu'), 'the check bites, and only where it should');
  const SESSION_LINK = new RegExp(['claude', 'ai/code'].join('\\.') + '|' + ['Claude', 'Session'].join('-'));
  const invisible = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [0x7F, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]].map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']');
  const phoneRe = /(^|[^\d.])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8'), rel = path.relative(ROOT, f);
    assert.ok(!invisible.test(src), `${rel} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bsk-ant-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(src), `${rel} carries a key-shaped string`);
    if (!/^public\/(passkey-client|verify-banner|desktop)\.|^lib\/(identity|stripe|byok|webauthn|identity-store)\.js$|^test\//.test(rel)) {
      assert.ok(!markRe.test(src), `${rel} names a brand or a person: ${(markRe.exec(src) || [])[2]}`);
      assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(src), `no email address in ${rel}`);
      assert.ok(!phoneRe.test(src), `no phone number in ${rel}: ${(phoneRe.exec(src) || [])[0]}`);
      assert.ok(!SESSION_LINK.test(src), `no session link in ${rel}`);
    }
  }
  const strings = JSON.stringify([D.book(), D.MENU_RAW, D.MENU_TEXT, D.menuSvg(), D.CSV, require('../lib/fakeai').GOOD]);
  assert.ok(!invisible.test(strings) && !markRe.test(strings), 'nor in what the demo and the fake make');
  const models = files.filter((f) => /claude-(haiku|sonnet|opus)/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)).filter((f) => !/^lib\/identity/.test(f));
  assert.deepStrictEqual(models, ['server.js'], 'model names only in the MODELS constant');
  assert.ok(read('server.js').includes(`const MODELS = { free: '${FREE_MODEL}', paid: '${PAID_MODEL}' };`));
  assert.strictEqual((read('server.js').match(/claude-[a-z]+-[0-9]/g) || []).length, 2, 'once each');
  const doc = read('CLAUDE.md').replace(/\s+/g, ' ');
  assert.match(doc, /a rebuild of the 2026-11-15 drop/i);
  assert.match(doc, /HANDOFF\.md/);
  for (const w of ['classic menu-engineering method', '(1 / n) x 0.7', 'weighted by units sold', 'at or above', 'whole cents', 'never sent to the model']) assert.ok(doc.includes(w), `CLAUDE.md: ${w}`);
  for (const f of ['lib/identity.js', 'lib/identity-store.js', 'lib/byok.js', 'lib/stripe.js', 'lib/webauthn.js', 'public/desktop.css', 'public/passkey-client.js', 'public/verify-banner.js']) {
    assert.strictEqual(read(f), fs.readFileSync(path.join(ROOT, '..', 'reset', f), 'utf8'), `${f} is the shared copy`);
  }
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*\n/gm, '').replace(/'[^'\n]*'/g, "''");
  assert.strictEqual(code(read('lib/image.js')), code(fs.readFileSync(path.join(ROOT, '..', 'reset', 'lib', 'image.js'), 'utf8')), 'image.js is Reset’s but for words');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; one document per account, read by its id', () => {
  for (const [mod, env] of [['./lib/store', { STARS_MEMORY: '1' }], ['./lib/fakeai', { STARS_FAKE_AI: '1' }], ['./server', { STARS_FAKE_AI: '1', STARS_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, STARS_MEMORY: '', STARS_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, STARS_MEMORY: '', STARS_COLLECTION_PREFIX: 'stars_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'stars_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'no query: one document per account, by its id');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('books'", "store.transact('books'"]);
  assert.match(server, /update\('stars owner v1'\)/);
});

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

let base;
let ip6 = 1;
function client() {
  const cookies = {};
  const addr = `2001:db8:${(ip6++).toString(16)}::1`;
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
}
const mail = (who) => `${who}${AT}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const BIG = { x: 'x'.repeat(1100 * 1024) };
const HUGE = { x: 'x'.repeat(5.5 * 1024 * 1024) };
/** The example with its times moved to now: a real phone stamps with its clock. */
function restamp(b, t) {
  const x = clone(b);
  x.t = t; x.period.t = t;
  for (const id of Object.keys(x.items)) x.items[id].t = t;
  return x;
}
const newDish = (name) => ({ name, cat: 'Mains', price: 1500, cost: 500, sold: 10 });

/* ---- tiny images, by their bytes ---- */
function pngOf(w, h, extra) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), extra ? chunk('tEXt', Buffer.from(extra)) : Buffer.alloc(0), chunk('IDAT', Buffer.from('pixels')), chunk('IEND', Buffer.alloc(0))]);
}
function jpegOf(w, h, exif) {
  const seg = (m, data) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = m; b.writeUInt16BE(data.length + 2, 2); return Buffer.concat([b, data]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0')), exif ? seg(0xe1, Buffer.from('Exif\0\0' + exif)) : Buffer.alloc(0), seg(0xc0, sof), seg(0xda, Buffer.from([1, 2, 3])), Buffer.from('scan data'), Buffer.from([0xff, 0xd9])]);
}
function webpOf(w, h, exif) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(type, 'latin1'), len, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const vp8x = Buffer.alloc(10); vp8x[0] = exif ? 0x08 : 0; vp8x.writeUIntLE(w - 1, 4, 3); vp8x.writeUIntLE(h - 1, 7, 3);
  const vp8l = Buffer.alloc(9); vp8l[0] = 0x2f; vp8l.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8L', vp8l), exif ? chunk('EXIF', Buffer.from(exif)) : Buffer.alloc(0)]);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
const im = (buf, type) => ({ type: type || 'image/jpeg', data: buf.toString('base64') });
const pagesOf = (...ims) => ({ images: ims });

test('images by their bytes: JPEG, PNG and WebP sniffed, their metadata (EXIF, text, location) stripped, their size read; each of two photos checked; anything else refused', () => {
  const j = img.cleanJpeg(jpegOf(1200, 900, 'GPS 51.5N'));
  assert.deepStrictEqual(j.size, { width: 1200, height: 900 });
  assert.ok(!j.buf.includes(Buffer.from('Exif')) && !j.buf.includes(Buffer.from('GPS')));
  assert.ok(!img.cleanPng(pngOf(800, 600, 'Comment\0shot at the pass')).buf.includes(Buffer.from('shot at')));
  const w = img.cleanWebp(webpOf(640, 480, 'GPS 51.5N'));
  assert.ok(!w.buf.includes(Buffer.from('GPS')) && !(w.buf[20] & 0x08));
  const brief = aiLib.brief(pagesOf(im(jpegOf(1600, 1200, 'GPS')), im(pngOf(900, 600, 'Comment\0back'), 'image/png')));
  assert.deepStrictEqual(Object.keys(brief), ['images'], 'the photos alone');
  assert.ok(!Buffer.from(brief.images[0].data, 'base64').includes(Buffer.from('GPS')) && !Buffer.from(brief.images[1].data, 'base64').includes(Buffer.from('back')));
  assert.throws(() => aiLib.brief(pagesOf(im(jpegOf(100, 100)), im(jpegOf(2400, 1200)))), /too large/, 'the second photo is checked too');
  assert.throws(() => aiLib.brief(pagesOf(im(pngOf(10, 10), 'image/jpeg'))), /JPEG, PNG or WebP/);
  assert.deepStrictEqual(aiLib.brief({ text: D.MENU_TEXT }), { text: D.MENU_TEXT });
});

test('signed out: the page and its files load with zero model calls; sync and the AI answer 401 before reading a body; no other route takes or hosts a menu', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual(meta.quadrants, ['star', 'plowhorse', 'puzzle', 'dog']);
  assert.match(meta.method.popularity, /70%/);
  for (const f of ['stars-core.js', 'stars-store.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  const shell = await page.text();
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/sync'], ['PUT', '/api/sync'], ['DELETE', '/api/sync'], ['POST', '/api/ai/menu']]) assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/sync'], ['POST', '/api/ai/menu']]) assert.strictEqual((await anon(m, p, HUGE)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/menu', '/api/items', '/api/csv', '/api/report', '/api/costs', '/api/share', '/api/ai/costs', '/api/ai/terms']) {
    assert.strictEqual((await anon('POST', p, { x: 1 })).status, 404, `POST ${p}`);
    assert.strictEqual((await anon('GET', p)).status, 404, `GET ${p}`);
  }
  for (const p of ['/d/abc', '/menu', '/report']) assert.strictEqual(await (await fetch(`${base}${p}`)).text(), shell, `${p} is only the app shell`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('writes come from this page: another site’s request (Sec-Fetch-Site or Origin) is 403 and a body that is not JSON 415, before anything else', async () => {
  const ana = await register('ana.sameorigin');
  const b = restamp(D.book(), Date.now());
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'same-site' })).status, 403, 'a sibling subdomain is another site here');
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await ana('POST', '/api/ai/menu', { text: D.MENU_TEXT }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/sync', 'data=1', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await ana('DELETE', '/api/sync', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const same = await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'same-origin', Origin: base.replace(/\/stars$/, '') });
  assert.strictEqual(same.status, 200, same.text);
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor; one forced tool with no field for a plate cost, units sold, a person or a phone; max_tokens 4000 with the arithmetic shown', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/menu', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/sync', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js'), ai = read('lib/ai.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((ai.match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai, /tool_choice: \{ type: 'tool', name: TOOL\.name \}/);
  assert.match(ai, /max_tokens: 4000,/);
  assert.match(ai, /3,640 for a reading filled to every cap, rounded\n\s*\/\/ up: 4,000\./, 'the arithmetic is shown');
  assert.strictEqual(80 * (15 + 8 + 5 + 1 + 8 + 8) + 40, 3640, 'and it adds up');
  const top = Object.keys(aiLib.TOOL.input_schema.properties), each = Object.keys(aiLib.TOOL.input_schema.properties.items.items.properties);
  assert.deepStrictEqual([top, each], [['items'], ['name', 'section', 'price', 'unsure']], 'no field for a plate cost, units sold, a person or a phone number');
  assert.strictEqual(aiLib.TOOL.input_schema.properties.items.maxItems, 80);
  assert.match(src, /express\.json\(\{ limit: '1mb' \}\)/);
  assert.match(src, /express\.json\(\{ limit: '5mb' \}\)/);
});

test('sync: the menu follows the account to the other phone; a stale phone gets 409 with the account copy and merges - a dish added on each phone both kept; bodies out of shape or personal refused whole; ~400 KB; 120 saves in ten minutes; filed under an HMAC', async () => {
  const a = await register('phone.one');
  assert.deepStrictEqual((await a('GET', '/api/sync')).data, { data: null, updatedAt: null });
  const b0 = restamp(D.book(), Date.now() - 60000);
  const put = await a('PUT', '/api/sync', { data: b0, base: null });
  assert.strictEqual(put.status, 200, put.text);
  const v1 = put.data.updatedAt;
  assert.ok(C.same(put.data.data, b0), 'saved as sent');
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('phone.one'), password: 'a long enough password' })).status, 200);
  const onB = (await b('GET', '/api/sync')).data;
  assert.strictEqual(onB.updatedAt, v1);
  const bEdit = C.putItem(onB.data, 'ibbbbbbb01', newDish('Second phone dish'), Date.now());
  assert.strictEqual((await b('PUT', '/api/sync', { data: bEdit, base: v1 })).status, 200);
  const aEdit = C.putItem(b0, 'iaaaaaaa01', newDish('First phone dish'), Date.now() + 5);
  const stale = await a('PUT', '/api/sync', { data: aEdit, base: v1 });
  assert.deepStrictEqual([stale.status, stale.data.code], [409, 'conflict']);
  assert.ok(stale.data.data.items.ibbbbbbb01, 'the 409 carries the account copy');
  const merged = C.merge(aEdit, stale.data.data, v1).book;
  const again = await a('PUT', '/api/sync', { data: merged, base: stale.data.updatedAt });
  assert.strictEqual(again.status, 200, again.text);
  const final = (await b('GET', '/api/sync')).data.data;
  assert.ok(final.items.ibbbbbbb01 && final.items.iaaaaaaa01, 'both phones’ changes survived');
  assert.strictEqual((await a('PUT', '/api/sync', { data: merged, base: null })).status, 409, 'a phone that never synced cannot overwrite');
  const cur = (await a('GET', '/api/sync')).data;
  const variants = [
    ['an unknown field', (x) => { x.place = 'x'; }],
    ['a supplier field', (x) => { x.items.imain00001.supplier = 'x'; }],
    ['a phone number as a dish', (x) => { x.items.imain00001.name = 'Call ' + PHONE; }],
    ['a tax id', (x) => { x.items.imain00001.cat = TAXID; }],
    ['a card', (x) => { x.items.imain00001.name = CARD; }],
    ['an @', (x) => { x.items.imain00001.name = 'ask ' + AT + 'x'; }],
    ['a full-width @', (x) => { x.items.imain00001.name = 'x' + FW_AT + 'y'; }],
    ['nine Arabic-Indic digits', (x) => { x.items.imain00001.name = ch(0x0662).repeat(9); }],
    ['a link', (x) => { x.period.label = 'see menu.example.com'; }],
    ['a formula', (x) => { x.items.imain00001.name = '=HYPERLINK("x")'; }],
    ['markup', (x) => { x.items.imain00001.name = '<img src=x>'; }],
    ['an invisible character', (x) => { x.items.imain00001.name = 'Rib' + RLO; }],
    ['a float price', (x) => { x.items.imain00001.price = 28.5; }],
    ['a price out of range', (x) => { x.items.imain00001.price = 100000; }],
    ['negative units', (x) => { x.items.imain00001.sold = -3; }],
    ['a time as a string', (x) => { x.items.imain00001.t = '12'; }],
    ['a bad dish id', (x) => { x.items['../x'] = x.items.imain00001; }],
  ];
  for (const [what, f] of variants) {
    const x = clone(cur.data); f(x);
    const r = await a('PUT', '/api/sync', { data: x, base: cur.updatedAt });
    assert.strictEqual(r.status, 400, `${what}: ${r.text.slice(0, 200)}`);
  }
  assert.strictEqual((await a('PUT', '/api/sync', { data: cur.data, base: cur.updatedAt, photo: 'x' })).status, 400, 'nothing beside the menu and its base');
  const big = clone(cur.data);
  for (let i = 0; i < 450; i++) big.items['ibig' + String(i).padStart(4, '0')] = Object.assign(newDish('Big one ' + i + ' with a long and winding name'), { t: 1 });
  const tooBig = await a('PUT', '/api/sync', { data: big, base: cur.updatedAt });
  assert.ok([400, 413].includes(tooBig.status), 'too many dishes, or too much: ' + tooBig.status);
  assert.strictEqual((await a('PUT', '/api/sync', BIG)).status, 413, 'over the parser, after the sign-in');
  assert.strictEqual((await a('GET', '/api/sync')).data.updatedAt, cur.updatedAt, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('phone.one') && !dump.includes(uidOf(mail('phone.one'))), 'filed under an HMAC, never the account id or address');
  assert.ok(dump.includes(ownerTag(uidOf(mail('phone.one')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'books')[1]).map(([, d]) => d).find((d) => d.book.items.ibbbbbbb01);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['book', 'owner', 'updatedAt']);
  assert.deepStrictEqual(Object.keys(doc.book).sort(), ['items', 'period', 't', 'v']);
  const other = await register('someone.else');
  assert.deepStrictEqual((await other('GET', '/api/sync')).data.data, null, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/sync')).status, 200);
  const removed = await b('PUT', '/api/sync', { data: final, base: 5 });
  assert.deepStrictEqual([removed.status, removed.data.code], [409, 'removed'], 'removed on the other phone says so');
  const r = await register('busy.pass');
  const mini = C.newBook(Date.now());
  let at = null, last = 0;
  for (let i = 0; i < 121; i++) { const res = await r('PUT', '/api/sync', { data: mini, base: at }); last = res.status; if (res.status === 200) at = res.data.updatedAt; else break; }
  assert.strictEqual(last, 429, 'the 121st save in ten minutes waits');
});

test('the AI over HTTP: exactly {images} or {text} - anything else, costs or sales beside them, a pasted phone number and non-images refused with no model call; the model saw the photo stripped (or the pasted menu) and one fixed sentence - nothing of the menu in Stars; one forced tool; a plate cost, units, a phone "dish" and advice dropped; 422, 502, 503, 413', async () => {
  const ana = await register('ana.menu');
  const calls = await modelCalls();
  const good = pagesOf(im(jpegOf(1600, 1200, 'GPS 51.5N kitchen')));
  const bad = [
    {}, [], { images: [] },
    Object.assign({}, good, { items: D.book().items }),
    Object.assign({}, good, { costs: { imain00001: 980 } }),
    Object.assign({}, good, { sold: 260 }),
    Object.assign({}, good, { text: D.MENU_TEXT }),
    { text: D.MENU_TEXT + '\nBook on ' + PHONE }, { text: 'x' + AT + 'y' }, { text: 'order at www.example.com' }, { text: '' }, { text: 'x'.repeat(8001) },
    pagesOf(im(Buffer.from('not a photo at all'))),
    pagesOf({ type: 'image/gif', data: good.images[0].data }),
    pagesOf({ type: 'image/png', data: good.images[0].data }),
    pagesOf(Object.assign({ name: 'menu.jpg' }, good.images[0])),
    pagesOf(im(jpegOf(2400, 1600))),
    pagesOf(good.images[0], good.images[0], good.images[0]),
    pagesOf({ type: 'image/jpeg', data: Buffer.alloc(1.6 * 1024 * 1024, 7).toString('base64') }),
  ];
  for (const x of bad) {
    const r = await ana('POST', '/api/ai/menu', x);
    assert.strictEqual(r.status, 400, JSON.stringify(x).slice(0, 80) + ' ' + r.text.slice(0, 200));
  }
  assert.strictEqual((await ana('POST', '/api/ai/menu', Object.assign({}, good, { sold: 1 }))).data.code, 'extra-field');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  for (const [buf, type] of [[pngOf(900, 700, 'Comment\0secret'), 'image/png'], [webpOf(1000, 800, 'GPS 51.5N'), 'image/webp']]) {
    const ok = await ana('POST', '/api/ai/menu', pagesOf(im(buf, type)));
    assert.strictEqual(ok.status, 200, `${type}: ${ok.text.slice(0, 200)}`);
  }
  const n0 = fakeClient.calls.length;
  const dumpBefore = store._dump();
  const r = await ana('POST', '/api/ai/menu', good);
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.items.map((x) => [x.name, x.cat, x.price, x.unsure]), [['Charred leeks, romesco', 'Small plates', '11.00', false], ['Smoked trout rillettes', 'Small plates', '13.50', false], ['Hanger steak, chimichurri', 'Larger plates', '32.00', false], ['Market fish', 'Larger plates', '', true]]);
  const txt = await ana('POST', '/api/ai/menu', { text: D.MENU_TEXT });
  assert.strictEqual(txt.status, 200, txt.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 4, 'one call each, metered');
  const sent = fakeClient.calls[n0];
  assert.strictEqual(sent.model, FREE_MODEL);
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'record_menu_items' });
  assert.strictEqual(sent.tools.length, 1);
  assert.strictEqual(sent.max_tokens, 4000);
  assert.strictEqual(sent.messages.length, 1);
  const content = sent.messages[0].content;
  assert.deepStrictEqual(content.map((x) => x.type), ['image', 'text']);
  assert.strictEqual(content[1].text, 'Read the dishes and prices on this page of a restaurant menu.', 'one fixed sentence');
  assert.ok(!Buffer.from(content[0].source.data, 'base64').includes(Buffer.from('GPS')), 'the photo’s metadata stripped');
  const tsent = fakeClient.calls[n0 + 1].messages[0].content;
  assert.deepStrictEqual(tsent.map((x) => x.type), ['text']);
  assert.strictEqual(tsent[0].text, aiLib.TEXT.text + '\n\n----- MENU START -----\n' + D.MENU_TEXT + '\n----- MENU END -----', 'the fixed sentence and the pasted menu, nothing else');
  assert.ok(!/Saltmarrow|short rib|9\.80|plate cost|ana\.menu/i.test(JSON.stringify(sent.messages)), 'nothing of the menu in Stars, no cost, no account');
  assert.strictEqual(store._dump(), dumpBefore, 'nothing stored');
  fakeClient.mode = 'bad';
  const b = await ana('POST', '/api/ai/menu', good);
  assert.strictEqual(b.status, 200, b.text);
  assert.ok(!/3\.10|140|555|Raise every price|1,000,000/.test(b.text), b.text.slice(0, 500));
  assert.deepStrictEqual(b.data.dropped, ['advice', 'plate_cost', 'units_sold', '1 dish name with a phone number, address or markup']);
  assert.deepStrictEqual(b.data.items.map((x) => [x.name, x.price, x.unsure]), [['Charred leeks, romesco', '11.00', false], ['Gold-leaf sundae', '', true]]);
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/menu', good);
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<b>|ignore your|\u202e/i.test(inj.text), inj.text.slice(0, 300));
  assert.deepStrictEqual([inj.data.items[0].name, inj.data.dropped], ['Steak', ['note', 'admin']], 'markup and a bidi override mended out of a reading; the extra fields named, never echoed');
  fakeClient.mode = 'blank';
  const blank = await ana('POST', '/api/ai/menu', good);
  assert.deepStrictEqual([blank.status, /Nothing on that page/.test(blank.data.error)], [422, true]);
  fakeClient.mode = 'maxtokens';
  const mt = await ana('POST', '/api/ai/menu', good);
  assert.deepStrictEqual([mt.status, /ran long/.test(mt.data.error)], [502, true]);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/menu', good);
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/menu', good);
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  const big = await ana('POST', '/api/ai/menu', HUGE);
  assert.deepStrictEqual([big.status, /too much/.test(big.data.error)], [413, true]);
});

test('the gates: an unconfirmed free account 403 verify-email with its resend link, out of credit 402, the day’s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  const good = { text: D.MENU_TEXT };
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/menu', good);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/stars/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/ai/menu', HUGE)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/menu', good)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/menu', HUGE)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const today = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-stars-${today}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/menu', good);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/menu', HUGE)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-stars-${today}`); }
});

test('a hostile pass leaves nothing personal in the store: refused bodies, injected answers, the menu photo and the pasted text never land; what is kept holds no email, phone, tax id, card, markup or account id', async () => {
  const h = await register('hostile.pass');
  const s = restamp(D.book(), Date.now());
  const tries = [
    (x) => { x.items.imain00001.name = 'Call ' + PHONE; },
    (x) => { x.items.imain00001.name = 'mail ' + mail('dana'); },
    (x) => { x.items.imain00001.cat = 'Card ' + CARD; },
    (x) => { x.items.imain00001.name = '<script>alert(1)</script>'; },
    (x) => { x.items.imain00001.name = 'Ring ' + ch(0x0967).repeat(9); },
    (x) => { x.period.label = TAXID; },
  ];
  for (const f of tries) { const x = clone(s); f(x); assert.strictEqual((await h('PUT', '/api/sync', { data: x, base: null })).status, 400); }
  assert.strictEqual((await h('PUT', '/api/sync', { data: s, base: null })).status, 200);
  fakeClient.mode = 'bad';
  await h('POST', '/api/ai/menu', pagesOf(im(jpegOf(300, 200, 'GPS 51.5N'))));
  await h('POST', '/api/ai/menu', { text: D.MENU_TEXT });
  const dump = store._dump();
  assert.ok(!dump.includes(AT) && !dump.includes('example.com'), 'no email');
  assert.ok(![PHONE, CARD, TAXID, '<script', 'Exif', 'GPS', 'base64', 'MENU START', 'Charred leeks', 'Gold-leaf'].some((x) => dump.includes(x)), 'no phone, card, tax id, markup, reading, photo or pasted text');
  assert.ok(!dump.includes(uidOf(mail('hostile.pass'))), 'no account id');
  for (const [, docs] of JSON.parse(dump)) for (const [, d] of docs) assert.deepStrictEqual(Object.keys(d).sort(), ['book', 'owner', 'updatedAt'], 'only menus are kept');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/stars', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/stars`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
