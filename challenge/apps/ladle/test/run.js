// The rules first (the text door, real fractions, units, reading an
// ingredient line, scaling and converting, temperatures and timers, the
// shopping list, the editor's door, the one door for a whole box, the
// two-phone merge, the card request and its answer), then the demo's
// planted story, the storage module, the look, the page's promises and the
// copy, then end to end against the memory store and the fake model:
//   LADLE_MEMORY=1 LADLE_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /ladle, the way
// the lab mounts it, so the auth cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every recipe and name here is made up. Phone and card numbers and brand
// names are built from pieces, so no file carries any of them.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.LADLE_MEMORY !== '1' || process.env.LADLE_FAKE_AI !== '1') {
  console.error('run with LADLE_MEMORY=1 LADLE_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, ownerTag } = require('../server');
const C = require('../public/ladle-core');
const D = require('../public/demo');
const RS = require('../public/ladle-store');
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
const Q = C.Q;

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
const scaled = (line, k, mode) => C.scaleIngredient(C.parseIngredient(line), k, mode || 'written').amount;
function rec(fields, t) { const r = C.recipeFrom(Object.assign({ title: 'Test', from: '', serves: '4', ingredients: '1 cup flour', steps: 'Mix.', notes: '' }, fields), t || 1); assert.deepStrictEqual(r.errors, []); return r.recipe; }

/* ================================================================== *
 * Fractions, units, lines
 * ================================================================== */

test('real fractions: exact arithmetic, reduced; shown as cooks write them (1 ½, ⅔, 2 ⅛); "about" only when no cook’s fraction is exact, and a small amount never rounds to nothing', () => {
  assert.deepStrictEqual(C.qadd(Q(1, 3), Q(1, 6)), [1, 2]);
  assert.deepStrictEqual(C.qmul(Q(3, 4), Q(14, 8)), [21, 16]);
  assert.deepStrictEqual(C.qdiv(Q(3), Q(3, 4)), [4, 1]);
  assert.deepStrictEqual([Q(3, 2), Q(2, 3), Q(17, 8), Q(4), Q(5, 16)].map(C.fracText), ['1 ½', '⅔', '2 ⅛', '4', '5/16']);
  assert.deepStrictEqual(C.nearest(Q(21, 16)), { q: [4, 3], about: true }, '1 5/16 is nearer 1 ⅓ than 1 ¼');
  assert.deepStrictEqual(C.nearest(Q(9, 8)), { q: [9, 8], about: false });
  assert.deepStrictEqual(C.nearest(Q(1, 40)), { q: [1, 8], about: true });
  for (const [s, q] of [['1', [1, 1]], ['3/4', [3, 4]], ['1 1/2', [3, 2]], ['1-1/2', [3, 2]], ['1½', [3, 2]], ['½', [1, 2]], ['0.75', [3, 4]], ['.5', [1, 2]], ['2 ⅓', [7, 3]]]) assert.deepStrictEqual(C.parseAmount(s), q, s);
  for (const s of ['', 'a', '1/0', '3/2/1', '1 5/4']) assert.strictEqual(C.parseAmount(s), null, s);
  assert.ok(C.isQ([3, 4]) && !C.isQ([3, 0]) && !C.isQ([-1, 2]) && !C.isQ([1.5, 2]) && !C.isQ('3/4'));
});

test('an ingredient line as a card writes it: "1 1/2 c. flour", "2 T butter" (a tablespoon), "1 t salt" (a teaspoon), ranges, cans with their size, a dash bullet, "salt to taste" - and the rest kept word for word', () => {
  const p = (l) => { const i = C.parseIngredient(l); return [i.q, i.q2, i.unit, i.item]; };
  assert.deepStrictEqual(p('1 1/2 c. flour'), [[3, 2], null, 'cup', 'flour']);
  assert.deepStrictEqual(p('2 T butter, melted'), [[2, 1], null, 'tbsp', 'butter, melted']);
  assert.deepStrictEqual(p('1 t salt'), [[1, 1], null, 'tsp', 'salt']);
  assert.deepStrictEqual(p('2 Tbsp. sugar'), [[2, 1], null, 'tbsp', 'sugar']);
  assert.deepStrictEqual(p('2-3 apples'), [[2, 1], [3, 1], '', 'apples']);
  assert.deepStrictEqual(p('2 to 3 cups of broth'), [[2, 1], [3, 1], 'cup', 'broth']);
  assert.deepStrictEqual(p('1 (15 oz) can pumpkin'), [[1, 1], null, 'can', 'pumpkin (15 oz)']);
  assert.deepStrictEqual(p('8 fl oz cream'), [[8, 1], null, 'floz', 'cream']);
  assert.deepStrictEqual(p('1 lb. ground beef'), [[1, 1], null, 'lb', 'ground beef']);
  assert.deepStrictEqual(p('250 g flour'), [[250, 1], null, 'g', 'flour']);
  assert.deepStrictEqual(p('- 2 cups sugar'), [[2, 1], null, 'cup', 'sugar']);
  assert.deepStrictEqual(p('salt to taste'), [null, null, '', 'salt to taste']);
  assert.deepStrictEqual(p('2 large eggs'), [[2, 1], null, '', 'large eggs']);
  assert.deepStrictEqual(p('3 cloves garlic'), [[3, 1], null, 'clove', 'garlic']);
  assert.deepStrictEqual(p('3-inch cinnamon stick'), [null, null, '', '3-inch cinnamon stick'], 'a size is not an amount');
  assert.deepStrictEqual(p('3 to taste'), [[3, 1], null, '', 'to taste']);
  // Written back the way it was read, and read again the same.
  for (const l of ['1 ½ cups flour', '2 tbsp butter, melted', '1 can pumpkin (15 oz)', '2-3 apples', 'salt to taste']) {
    const i = C.parseIngredient(l);
    assert.strictEqual(C.ingredientText(i), l);
    assert.deepStrictEqual(C.parseIngredient(C.ingredientText(i)), i);
  }
});

test('scaling: the card’s unit kept, real fractions, tidied the way a cook says it (4 tbsp is ¼ cup, ⅛ cup is 2 tbsp, 3 tsp is 1 tbsp); as written stays as written; ranges and counts scale; "about" when rounded', () => {
  assert.strictEqual(scaled('3/4 c. sugar', Q(2)), '1 ½ cups');
  assert.strictEqual(scaled('3/4 c. sugar', Q(1, 4)), '3 tbsp');
  assert.strictEqual(scaled('2 T butter', Q(2)), '¼ cup');
  assert.strictEqual(scaled('1/2 cup milk', Q(1, 4)), '2 tbsp');
  assert.strictEqual(scaled('1 1/2 tsp cinnamon', Q(2)), '1 tbsp');
  assert.strictEqual(scaled('1 T vanilla', Q(1, 4)), '¾ tsp');
  assert.strictEqual(scaled('1/3 cup oil', Q(3, 2)), '½ cup');
  assert.strictEqual(scaled('2 T butter', Q(1)), '2 tbsp', 'as written is as written');
  assert.strictEqual(scaled('5 tsp sugar', Q(1)), '5 tsp');
  assert.strictEqual(scaled('2-3 apples', Q(2)), '4-6');
  assert.strictEqual(scaled('2 eggs', Q(3, 4)), '1 ½');
  assert.strictEqual(scaled('1 can pumpkin (15 oz)', Q(2)), '2 cans');
  const s = C.scaleIngredient(C.parseIngredient('3/4 cup sugar'), C.factor(8, 14), 'written');
  assert.deepStrictEqual([s.amount, s.about], ['1 cup + 5 tbsp', false], 'serves 8 to 14: ¾ cup is 21/16 cup - said exactly');
  const e = C.scaleIngredient(C.parseIngredient('2 eggs'), C.factor(8, 14), 'written');
  assert.deepStrictEqual([e.amount, e.about], ['3 ½', false]);
  const e3 = C.scaleIngredient(C.parseIngredient('3 eggs'), C.factor(8, 3), 'written');
  assert.deepStrictEqual([e3.amount, e3.about], ['1 ⅛', false]);
  const w = C.scaleIngredient(C.parseIngredient('1 egg'), C.factor(6, 5), 'written');
  assert.deepStrictEqual([w.amount, w.about], ['⅞', true], '5/6 of an egg rounds to the nearest eighth, marked');
  assert.deepStrictEqual(C.factor(8, 16), [2, 1]);
  assert.deepStrictEqual(C.factor(null, 4), [1, 1]);
});

test('units: US cups and spoons from metric, metric from US (rounded as a metric recipe would), weights in oz and lb; a count unit never converts', () => {
  assert.strictEqual(scaled('1 cup milk', Q(1), 'metric'), '235 ml');
  assert.strictEqual(scaled('1 1/2 cups flour', Q(1), 'metric'), '350 ml');
  assert.strictEqual(scaled('1 t salt', Q(1), 'metric'), '5 ml');
  assert.strictEqual(scaled('1/4 t cloves', Q(1), 'metric'), '1 ml');
  assert.strictEqual(scaled('4 quarts stock', Q(1), 'metric'), '3.79 l');
  assert.strictEqual(scaled('8 oz cream cheese', Q(1), 'metric'), '225 g');
  assert.strictEqual(scaled('2 lb beef', Q(1), 'metric'), '910 g');
  assert.strictEqual(scaled('3 lb turkey', Q(1), 'metric'), '1.36 kg');
  assert.strictEqual(scaled('250 ml milk', Q(1), 'us'), '1 cup');
  assert.strictEqual(scaled('1 L stock', Q(1), 'us'), '4 ¼ cups');
  assert.strictEqual(scaled('15 ml oil', Q(1), 'us'), '1 tbsp');
  assert.strictEqual(scaled('500 g flour', Q(1), 'us'), '1 ⅛ lb');
  assert.strictEqual(scaled('100 g butter', Q(1), 'us'), '3 ½ oz');
  assert.strictEqual(scaled('250 g flour', Q(1), 'written'), '250 g');
  assert.strictEqual(scaled('1 1/2 lb potatoes', Q(1), 'us'), '1 ½ lb');
  assert.strictEqual(scaled('24 oz potatoes', Q(1), 'us'), '1 ½ lb');
  assert.strictEqual(scaled('2 cans beans', Q(1), 'metric'), '2 cans');
  assert.strictEqual(scaled('12 tsp sugar', Q(1), 'us'), '¼ cup');
  assert.strictEqual(scaled('1 fl oz vanilla', Q(1), 'us'), '2 tbsp');
  assert.ok(C.scaleIngredient(C.parseIngredient('1 cup milk'), Q(1), 'metric').about, 'a conversion is marked as one');
});

test('steps: oven temperatures get the other scale (350°F -> 175°C), rounded to 5; timers found in the words - the low end of a range, hours and fractions of hours; clocks', () => {
  assert.strictEqual(C.withTemps('Bake at 350°F for 25 minutes.', 'metric'), 'Bake at 350°F (175°C) for 25 minutes.');
  assert.strictEqual(C.withTemps('Heat the oven to 425 degrees.', 'metric'), 'Heat the oven to 425 degrees (220°C).');
  assert.strictEqual(C.withTemps('Roast at 180°C.', 'us'), 'Roast at 180°C (355°F).');
  assert.strictEqual(C.withTemps('Bake at 350°F.', 'written'), 'Bake at 350°F.');
  assert.strictEqual(C.withTemps('Chill to 40°F.', 'metric'), 'Chill to 40°F.', 'not an oven');
  assert.strictEqual(C.withTemps('Bake at 350°F (175°C).', 'metric'), 'Bake at 350°F (175°C).', 'never twice');
  const t = (s) => C.timers(s).map((x) => x.mins);
  assert.deepStrictEqual(t('Bake 40-50 minutes, until set.'), [40]);
  assert.deepStrictEqual(t('Simmer, lid half on, 1 1/2 hours.'), [90]);
  assert.deepStrictEqual(t('Let rise 1 hour, then bake 15 to 18 mins.'), [60, 15]);
  assert.deepStrictEqual(t('Rest for an hour.'), [60]);
  assert.deepStrictEqual(t('Stir in the sugar.'), []);
  assert.deepStrictEqual(t('Bake 375° for 8-10 min.'), [8]);
  assert.deepStrictEqual([C.clockText(905), C.clockText(3729), C.clockText(0.2), C.clockText(-4)], ['15:05', '1:02:09', '0:01', '0:00']);
  assert.deepStrictEqual([C.minsText(45), C.minsText(60), C.minsText(90)], ['45 min', '1 hr', '1 hr 30 min']);
});

test('the shopping list: like lines added up exactly across recipes at their own scale (eggs, butter "melted" and "soft", sugar - not brown sugar), counts by unit, unmeasured lines once, metric and US apart, aisles in shop order, ticks and hand-typed items; as text', () => {
  let b = C.newBox(1);
  b = C.putRecipe(b, 'raaaaaa', rec({ title: 'A', ingredients: '2 eggs\n1/2 cup butter, melted\n1 cup sugar\nsalt to taste\n1 t salt\n200 g flour' }));
  b = C.putRecipe(b, 'rbbbbbb', rec({ title: 'B', ingredients: '3 eggs, beaten\n1/4 cup butter, soft\n1/2 cup brown sugar\n2 tbsp sugar\n1 cup flour\n1 can pumpkin (15 oz)' }));
  b = C.putRecipe(b, 'rcccccc', rec({ title: 'C', ingredients: '1 egg' }));
  b = C.planRecipe(b, 'raaaaaa', true, Q(2), 2);
  b = C.planRecipe(b, 'rbbbbbb', true, Q(1), 2);
  b = C.planRecipe(b, 'rcccccc', false, Q(1), 2);
  const sh = C.shopping(b, 'written');
  const row = (k) => sh.rows.find((r) => r.key === k);
  assert.strictEqual(row('egg|n:').amount, '7', '2 x 2 + 3; the recipe off the list is not counted');
  assert.deepStrictEqual(row('egg|n:').from, ['A', 'B']);
  assert.strictEqual(row('butter|vol').amount, '1 ¼ cups');
  assert.strictEqual(row('sugar|vol').amount, '2 ⅛ cups');
  assert.strictEqual(C.usVolume(Q(63)).parts.map((p) => C.fracText(p.q) + ' ' + p.unit).join(' + '), '1 cup + 5 tbsp');
  assert.strictEqual(row('brown sugar|vol').amount, '½ cup');
  assert.strictEqual(row('salt|vol').amount, '2 tsp');
  assert.ok(row('salt|vol').plus, 'salt "to taste" too: and a little more');
  assert.ok(!sh.rows.some((r) => r.key === 'salt|-'), 'an unmeasured line joins the measured one');
  assert.strictEqual(row('flour|mass').amount, '400 g', 'metric stays metric');
  assert.strictEqual(row('flour|vol').amount, '1 cup', 'a cup of flour and grams of flour are two lines - flour has no one density');
  assert.strictEqual(row('pumpkin|n:can').amount, '1 can');
  assert.strictEqual(row('pumpkin|n:can').aisle, 'pantry', 'a can of pumpkin is not fresh produce');
  assert.deepStrictEqual(sh.groups.map((g) => g.aisle), ['produce', 'dairy', 'baking', 'spices', 'pantry'].filter((a) => sh.groups.some((g) => g.aisle === a)));
  assert.deepStrictEqual(sh.groups.map((g) => g.aisle), ['dairy', 'baking', 'spices', 'pantry']);
  assert.strictEqual(C.shopping(b, 'metric').rows.find((r) => r.key === 'butter|vol').amount, '300 ml');
  assert.strictEqual(C.shopping(b, 'us').rows.find((r) => r.key === 'flour|mass').amount, '14 ⅛ oz');
  b = C.tick(b, 'egg|n:', true, 3);
  b = C.addExtra(b, 'xfoil01', 'Foil', 3);
  const sh2 = C.shopping(b);
  assert.deepStrictEqual([sh2.left, sh2.of], [sh.of, sh.of + 1]);
  const dairy = sh2.groups.find((g) => g.aisle === 'dairy');
  assert.strictEqual(dairy.rows[dairy.rows.length - 1].key, 'egg|n:', 'a ticked line sinks to the bottom of its aisle');
  const text = C.shoppingText(sh2, 'Shopping list');
  assert.ok(text.startsWith('Shopping list\n') && text.includes('- 1 ¼ cups butter') && text.includes('- Foil') && !/- \d+ egg/.test(text), JSON.stringify(text));
  b = C.removeExtra(b, 'xfoil01', 4);
  assert.strictEqual(C.shopping(b).of, sh.of);
  const cleared = C.clearList(b, 5);
  assert.deepStrictEqual([C.shopping(cleared).of], [0]);
  for (const k of Object.keys(b.shop.ticks)) assert.ok(C.KEY.test(k), k);
  for (const r of sh.rows) assert.ok(C.KEY.test(r.key), r.key);
  assert.deepStrictEqual([C.aisleOf('black pepper'), C.aisleOf('dried sage'), C.aisleOf('green peppers'), C.aisleOf('ground beef'), C.aisleOf('ground cinnamon'), C.aisleOf('evaporated milk'), C.aisleOf('frozen peas'), C.aisleOf('a ball of twine')], ['spices', 'spices', 'produce', 'meat', 'spices', 'baking', 'frozen', 'other']);
});

test('hostile text: markup, bidi and zero-width characters, an @ in any width, nine digits in any script, a phone number, a card, a link, a formula - refused, never cleaned; a recipe’s own numbers pass', () => {
  for (const s of ['<b>pie</b>', 'pie' + RLO, 'pie' + ch(0x200B), 'nana' + AT + 'x', 'nana' + FW_AT + 'x', 'ring ' + PHONE, CARD, ch(0x0663).repeat(9), 'see pies.example.com', 'www.pie', '=SUM(A1)', '@pie', '+cmd']) assert.notStrictEqual(C.refuse(s), '', s);
  for (const s of ['1 1/2 cups flour', '2 1/4 tsp yeast', 'Bake at 350°F for 45-50 minutes.', '9 x 13 inch dish', '- 2 cups sugar', '1 (15 oz) can', 'Nana’s pie, 1974', 'Step 3: 1 1/2 2 1/4 3 1/2 cups', 'Line 1\nLine 2', '-1 tsp?'.slice(1)]) assert.strictEqual(C.refuse(s), '', s);
  assert.strictEqual(C.refuse('x'.repeat(81), C.LIMITS.title), 'Up to 80 characters.');
});

test('the editor’s door: a name and a line needed; serves 1 to 48 or empty; each line checked and named; numbered steps unnumbered; the fields come back the same', () => {
  const ok = C.recipeFrom({ title: 'Pie', from: 'Nana', serves: '8', ingredients: '3/4 c. sugar\n\n2 eggs', steps: '1. Mix.\n2) Bake.\nStep 3: Cool.', notes: 'Two.\n\n\n\nAlways.' }, 5);
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.recipe.steps, ['Mix.', 'Bake.', 'Cool.']);
  assert.strictEqual(ok.recipe.notes, 'Two.\n\nAlways.');
  assert.strictEqual(ok.recipe.ingredients.length, 2);
  assert.deepStrictEqual(C.recipeFrom(C.fieldsOf(ok.recipe), 5).recipe, ok.recipe, 'edit and save again: the same recipe');
  const errs = (f) => C.recipeFrom(Object.assign({ title: 'Pie', ingredients: '1 egg', steps: '', serves: '' }, f), 1).errors;
  assert.match(errs({ title: '' })[0], /Give it a name/);
  assert.match(errs({ serves: '0' })[0], /Serves is a whole number/);
  assert.match(errs({ serves: '2.5' })[0], /Serves/);
  assert.match(errs({ ingredients: '', steps: '' })[0], /ingredients or the steps/);
  assert.match(errs({ ingredients: '1 egg\ncall ' + PHONE })[0], /^Ingredient 2: That looks like a phone number/);
  assert.match(errs({ steps: 'see pies.example.com' })[0], /^Step 1: That looks like a link/);
  assert.match(errs({ from: 'nana' + AT + 'x' })[0], /^Whose it is: That looks like an email/);
  assert.match(errs({ ingredients: Array(61).fill('1 egg').join('\n') })[0], /Up to 60 ingredient lines/);
});

test('the one door: strict refuses anything out of shape, whole; lenient (this phone’s own copy) mends and drops; bodyProblem first', () => {
  const b = D.box();
  assert.deepStrictEqual(C.cleanBox(b, true).errors, []);
  assert.deepStrictEqual(C.cleanBox(b).box, b, 'the example passes the door unchanged');
  const variants = [
    ['an unknown top field', (x) => { x.photos = {}; }],
    ['an unknown recipe field', (x) => { x.recipes.rpumpkin1.from_email = 'x'; }],
    ['a bad recipe id', (x) => { x.recipes.BAD = clone(x.recipes.rpumpkin1); }],
    ['an amount that is not a fraction', (x) => { x.recipes.rpumpkin1.ingredients[0].q = [1.5, 1]; }],
    ['a zero denominator', (x) => { x.recipes.rpumpkin1.ingredients[0].q = [1, 0]; }],
    ['an unknown unit', (x) => { x.recipes.rpumpkin1.ingredients[0].unit = 'bushel'; }],
    ['a range top with no amount', (x) => { x.recipes.rpumpkin1.ingredients[8].q = null; x.recipes.rpumpkin1.ingredients[8].q2 = [2, 1]; }],
    ['a phone number in a step', (x) => { x.recipes.rpumpkin1.steps[0] = 'Call ' + PHONE; }],
    ['serves 49', (x) => { x.recipes.rpumpkin1.serves = 49; }],
    ['a time as a string', (x) => { x.recipes.rpumpkin1.t = '1'; }],
    ['a plan scale of zero', (x) => { x.shop.plan.rpumpkin1.k = [0, 1]; }],
    ['a tick key that is not one', (x) => { x.shop.ticks['<b>'] = { on: true, t: 1 }; }],
    ['a card number as an extra item', (x) => { x.shop.extra.xbad0001 = { text: CARD, t: 1, del: false }; }],
    ['photos as 3', (x) => { x.recipes.rpumpkin1.photos = 3; }],
  ];
  for (const [what, f] of variants) {
    const x = clone(b); f(x);
    assert.ok(C.cleanBox(x, true).errors.length, what);
    const mended = C.cleanBox(x).box;
    assert.deepStrictEqual(C.cleanBox(mended, true).errors, [], `${what}: the lenient door mends`);
  }
  assert.match(C.bodyProblem({ a: ['x', { b: 'mail' + FW_AT + 'x' }] }), /@/);
  assert.match(C.bodyProblem({ ['k' + AT]: 1 }), /@/, 'keys too');
  assert.match(C.bodyProblem(ch(0x0967).repeat(9)), /nine digits/);
  assert.strictEqual(C.bodyProblem(b), '');
});

test('two phones: each recipe, list line, tick and hand-typed item by its own time; a removal is a change; a recipe both phones changed since they last agreed keeps both - the other as "(other phone)"; symmetric and idempotent', () => {
  const base = D.box();
  const T0 = D.T;
  let a = C.putRecipe(base, 'rpumpkin1', Object.assign(clone(base.recipes.rpumpkin1), { notes: 'Phone A note', t: T0 + 200 }));
  a = C.tick(a, 'egg|n:', true, T0 + 210);
  let b = C.putRecipe(base, 'rpumpkin1', Object.assign(clone(base.recipes.rpumpkin1), { notes: 'Phone B note', t: T0 + 300 }));
  b = C.removeRecipe(b, 'rraychili', T0 + 220);
  b = C.addExtra(b, 'xfoil01', 'Foil', T0 + 230);
  const m1 = C.merge(a, b, T0 + 100, C.copyIdOf), m2 = C.merge(b, a, T0 + 100, C.copyIdOf);
  assert.deepStrictEqual(m1.box, m2.box, 'symmetric');
  assert.deepStrictEqual(C.merge(m1.box, m1.box, T0 + 100, C.copyIdOf).box, m1.box, 'idempotent');
  const m = m1.box;
  assert.strictEqual(m.recipes.rpumpkin1.notes, 'Phone B note', 'the later change wins');
  assert.strictEqual(m.recipes[C.copyIdOf('rpumpkin1')].notes, 'Phone A note', 'the other is kept beside it');
  assert.strictEqual(m.recipes[C.copyIdOf('rpumpkin1')].title, 'Pumpkin pie (other phone)');
  assert.match(m1.notes[0], /Both phones changed “Pumpkin pie”/);
  assert.ok(m.recipes.rraychili.del && m.shop.ticks['egg|n:'].on && m.shop.extra.xfoil01.text === 'Foil');
  assert.deepStrictEqual(C.cleanBox(m, true).errors, [], 'the result passes the strict door');
  // Only one phone changed it since: no copy.
  const one = C.merge(a, base, T0 + 100, C.copyIdOf);
  assert.ok(!one.box.recipes[C.copyIdOf('rpumpkin1')] && !one.notes.length);
  // Property: random edits on two phones.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ids = Object.keys(base.recipes);
  const edit = (x, t) => {
    const k = rnd(5), id = ids[rnd(ids.length)];
    if (k === 0) return C.putRecipe(x, id, Object.assign(clone(x.recipes[id]), { notes: 'n' + rnd(9), t }));
    if (k === 1) return C.removeRecipe(x, id, t);
    if (k === 2) return C.planRecipe(x, id, Boolean(rnd(2)), Q(1 + rnd(3)), t);
    if (k === 3) return C.tick(x, ['egg|n:', 'sugar|vol', 'butter|vol'][rnd(3)], Boolean(rnd(2)), t);
    return C.addExtra(x, 'x' + String(rnd(1e6)).padStart(6, '0'), 'Thing ' + rnd(9), t);
  };
  for (let i = 0; i < 150; i++) {
    let x = clone(base), y = clone(base);
    for (let j = 0; j < 1 + rnd(5); j++) x = edit(x, D.T + 1000 + rnd(500));
    for (let j = 0; j < 1 + rnd(5); j++) y = edit(y, D.T + 1000 + rnd(500));
    const p = C.merge(x, y, D.T, C.copyIdOf).box, q = C.merge(y, x, D.T, C.copyIdOf).box;
    assert.deepStrictEqual(p, q, `pair ${i}: symmetric`);
    assert.deepStrictEqual(C.merge(p, p, D.T, C.copyIdOf).box, p, `pair ${i}: idempotent`);
    assert.deepStrictEqual(C.cleanBox(p, true).errors, [], `pair ${i}: strict door`);
    for (const k of Object.keys(x.shop.ticks).concat(Object.keys(y.shop.ticks))) assert.ok(p.shop.ticks[k], `pair ${i}: tick ${k} kept`);
  }
});

test('the card request is the photos alone - exactly {images: [{type, data}]}, one or two; anything else refused before a model call', () => {
  const im = { type: 'image/jpeg', data: 'A'.repeat(40) };
  assert.ok(C.cardRequest({ images: [im] }).req);
  assert.ok(C.cardRequest({ images: [im, im] }).req);
  for (const [body, code] of [[{}, 'image'], [{ images: [] }, 'image'], [{ images: [im, im, im] }, 'image'], [{ images: [im], from: 'Nana' }, 'extra-field'], [{ images: [im], recipe: {} }, 'extra-field'], [{ images: [Object.assign({ name: 'card.jpg' }, im)] }, 'image'], [{ images: [{ type: 'image/gif', data: im.data }] }, 'image'], [{ images: [{ type: 'image/jpeg', data: 'not base64!!!!!!!!' }] }, 'image'], [[], 'bad-request']]) {
    assert.strictEqual(C.cardRequest(body).code, code, JSON.stringify(body).slice(0, 60));
  }
});

test('the card answer checked: only a recipe’s fields; a name, calories, a price dropped and named; a line with an email, a phone number, a link, markup or a nutrition claim dropped and counted; amounts read by Ladle; nothing readable an error', () => {
  const ok = C.cleanAiCard(clone(require('../lib/fakeai').GOOD));
  assert.deepStrictEqual(ok.dropped, []);
  assert.strictEqual(ok.draft.title, 'Molasses cookies');
  assert.deepStrictEqual(ok.draft.ingredients[0], { q: [3, 4], q2: null, unit: 'cup', item: 'shortening' });
  assert.deepStrictEqual(ok.draft.ingredients[5], { q: [2, 1], q2: null, unit: 'tsp', item: 'baking soda' }, 'a small t is a teaspoon');
  assert.deepStrictEqual(ok.unclear, { ingredients: [5], steps: [2] });
  const ex = C.cleanAiCard(D.CARD_RAW);
  assert.deepStrictEqual(ex.dropped, ['from', 'calories', '1 line with an email, a phone number, a link or a nutrition claim']);
  assert.strictEqual(ex.draft.steps.length, 3);
  assert.strictEqual(C.draftFields(ex.draft, 'Aunt Lou').from, 'Aunt Lou', 'whose it is stays the person’s');
  assert.strictEqual(C.draftFields(ex.draft).from, '', 'and is never filled from a card');
  const r = C.recipeFrom(C.draftFields(ex.draft, 'Aunt Lou'), 1);
  assert.deepStrictEqual(r.errors, [], 'a reading passes the editor’s door');
  assert.strictEqual(C.cleanAiCard({ title: '', ingredients: [], steps: [] }).code, 'unreadable');
  assert.strictEqual(C.cleanAiCard(null).code, 'unreadable');
  assert.strictEqual(C.cleanAiCard({ title: 'Pie', serves: 500 }).dropped[0], 'serves');
  assert.strictEqual(C.cleanAiCard({ title: 'Pie', notes: 'Healthy and keto' }).draft.notes, '');
});

/* ================================================================== *
 * The demo, storage, the look, the page, the copy
 * ================================================================== */

test('the demo’s planted story: Nana Dot’s box - six cards; the pie doubles to 1 ½ cups sugar and 1 tsp salt; Thursday’s list is 24 lines and coffee: 8 eggs, 1 cup butter, 2 cups sugar, 2 tsp salt, 2 cans pumpkin; the pie’s timers 15 and 40 minutes; the example card read with its name, calories and nutrition line dropped', () => {
  const b = D.box();
  assert.deepStrictEqual(C.liveRecipes(b).map((r) => r.title), ['Butter rolls', 'Cornbread dressing', 'Cranberry sauce with orange', 'Pumpkin pie', 'Sweet potato casserole', 'Uncle Ray’s chili']);
  assert.deepStrictEqual(C.liveRecipes(b).map((r) => r.from), ['Grandpa Walt', 'Nana Dot', 'Mom', 'Nana Dot', 'Aunt Lou', 'Uncle Ray']);
  const pie = b.recipes.rpumpkin1;
  assert.strictEqual(pie.serves, 8);
  const x2 = pie.ingredients.map((i) => C.scaleIngredient(i, C.factor(8, 16), 'written').amount);
  assert.deepStrictEqual(x2, ['2 cans', '1 ½ cups', '2 tsp', '1 tsp', '½ tsp', '1 tsp', '4', '2 cans', '2']);
  assert.deepStrictEqual(pie.steps.map((s) => C.timers(s).map((t) => t.mins)), [[], [], [], [], [15], [40], [120]]);
  assert.strictEqual(C.withTemps(pie.steps[0], 'metric'), 'Heat the oven to 425°F (220°C).');
  const sh = C.shopping(b);
  assert.deepStrictEqual([sh.of, sh.left], [25, 25]);
  const row = (k) => sh.rows.find((r) => r.key === k).amount;
  assert.deepStrictEqual([row('egg|n:'), row('butter|vol'), row('sugar|vol'), row('salt|vol'), row('pumpkin|n:can'), row('brown sugar|vol'), row('cinnamon|vol')], ['8', '1 cup', '2 cups', '2 tsp', '2 cans', '1 cup', '2 tsp']);
  assert.deepStrictEqual(sh.rows.find((r) => r.key === 'egg|n:').from, ['Pumpkin pie', 'Cornbread dressing', 'Sweet potato casserole'].sort());
  assert.deepStrictEqual(C.search(b, 'nana').map((r) => r.id).sort(), ['rdressing', 'rpumpkin1']);
  assert.deepStrictEqual(C.search(b, 'pecans').map((r) => r.id), ['rsweetpot']);
  assert.deepStrictEqual(C.search(b, 'pie ginger').map((r) => r.id), ['rpumpkin1']);
  // Uncle Ray's card is written the old way: T and t.
  assert.deepStrictEqual(b.recipes.rraychili.ingredients.filter((i) => /chili powder|cumin/.test(i.item)).map((i) => i.unit), ['tbsp', 'tsp']);
  assert.match(D.cardSvg(), /^<svg class="cardsvg"[^>]*role="img"/);
  assert.ok(!/<script|on[a-z]+=/i.test(D.cardSvg()));
  assert.match(D.NOTICE, /^Made up/);
});

test('storage: one module; the box through the one door; photos only as JPEG data URLs the page made, under a known recipe and side, at most 120; IndexedDB wrapped - throwing, blocked or missing falls back to memory and says so', async () => {
  const s = RS.create(RS.memory());
  assert.strictEqual(await s.getBox(), null);
  const b = D.box();
  await s.putBox(b);
  assert.deepStrictEqual(await s.getBox(), b);
  const dirty = clone(b); dirty.recipes.rpumpkin1.notes = 'call ' + PHONE; dirty.junk = 1;
  await s.putBox(dirty);
  const back = await s.getBox();
  assert.ok(!back.recipes.rpumpkin1 && !('junk' in back), 'what fails the door is not kept');
  const jpg = 'data:image/jpeg;base64,' + 'A'.repeat(100);
  await s.putPhoto('rpumpkin1-1', jpg);
  assert.strictEqual(await s.getPhoto('rpumpkin1-1'), jpg);
  assert.deepStrictEqual(await s.photoRefs(), ['rpumpkin1-1']);
  await assert.rejects(s.putPhoto('rpumpkin1-3', jpg), /nowhere/);
  await assert.rejects(s.putPhoto('../x', jpg), /nowhere/);
  await assert.rejects(s.putPhoto('rpumpkin1-2', 'data:image/svg+xml;base64,AAAA'), /could not be kept/);
  await assert.rejects(s.putPhoto('rpumpkin1-2', 'data:image/jpeg;base64,' + 'A'.repeat(RS.PHOTO_MAX)), /could not be kept/);
  await s.delPhoto('rpumpkin1-1');
  assert.deepStrictEqual(await s.photoRefs(), []);
  assert.deepStrictEqual(RS.cleanDevice({ tour: 'yes', units: 'imperial', size: 'poster' }), { tour: false, units: 'written', size: '4x6' });
  assert.deepStrictEqual(RS.cleanDevice({ tour: true, units: 'metric', size: 'page' }), { tour: true, units: 'metric', size: 'page' });
  const many = RS.create(RS.memory());
  for (let i = 0; i < RS.PHOTOS_MAX; i++) await many.putPhoto('r' + String(i).padStart(6, '0') + '-1', jpg);
  await assert.rejects(many.putPhoto('rzzzzzz-1', jpg), /up to 120/);
  // Broken databases.
  for (const factory of [null, { open() { throw new Error('nope'); } }, { open() { const r = {}; setTimeout(() => r.onblocked && r.onblocked()); return r; } }]) {
    const st = RS.create(RS.idb('ladle-test', factory));
    await st.putBox(b);
    assert.deepStrictEqual(await st.getBox(), b, 'still works');
    assert.strictEqual(st.persistent(), false, 'and says it is not kept');
  }
});

test('every text colour holds 4.5:1 on its surface in both themes; the hero, the example card and the printed card too; the lab card; 44px targets; no sideways scroll; reduced motion; print shows #print only', () => {
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
    ok('muted', 'warn-bg'); ok('muted', 'info-bg'); ok('muted', 'ok-bg'); ok('link', 'warn-bg'); ok('link', 'info-bg');
    ok('accent-ink', 'accent'); ok('bg', 'ok'); ok('bg', 'text'); ok('accent', 'card'); ok('ok', 'card');
    for (const k of ['bad', 'warn', 'info', 'ok']) { ok(k, `${k}-bg`); ok(k, 'card'); ok(k, 'card2'); ok(k, 'bg'); }
    ok('ink', 'card', 3); ok('accent', 'bg', 3);
  }
  assert.match(css, /\.hero \{[^}]*linear-gradient\(150deg, #6f3420 0%, #8e452c 45%, #3d5f8a 100%\)/);
  for (const bg of ['#6f3420', '#8e452c', '#3d5f8a']) for (const fg of ['#ffffff', '#fff8f1']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}`);
  assert.ok(ratio('#5c2a17', '#fff8f1') >= 4.5);
  for (const [fg, bg] of [['#111111', '#ffffff'], ['#444444', '#ffffff'], ['#8a2d0a', '#ffffff'], ['#2b3a67', '#f3e9d2']]) assert.ok(ratio(fg, bg) >= 4.5, `print and card ${fg} on ${bg}`);
  assert.ok(D.cardSvg().includes('fill="#2b3a67"') && D.cardSvg().includes('fill="#f3e9d2"'));
  for (const sel of ['.btn', '.link-btn', '.seg button', '.chip', '.input, textarea.input, select.input', '.rrow', '.srow', '.photobtn']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  assert.ok(/\.cooknav \.btn \{ min-height: 64px;/.test(css) && /\.btn\.x \{ min-width: 44px;/.test(css) && /details\.more > summary \{[^}]*min-height: 44px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css) && /\.ings li \{ display: grid; grid-template-columns: minmax\(84px, 9\.5em\) minmax\(0, 1fr\)/.test(css));
  assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/.test(css));
  assert.ok(/@media print \{[\s\S]*body > \*:not\(#print\) \{ display: none !important; \}[\s\S]*#stc-verify-banner, #live \{ display: none !important; \}/.test(css), 'print shows #print only');
  const shared = new Set([...read('public/desktop.css').matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
  const mine = [...css.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).filter((k) => shared.has(k));
  assert.deepStrictEqual([...new Set(mine)].sort(), ['bar-bg', 'card']);
  // The lab card.
  const LAB = require('../../../lab');
  const lab = LAB.get('ladle');
  assert.ok(lab, 'Ladle is in lab.js');
  assert.deepStrictEqual([lab.color, lab.color2, lab.dropped, lab.status, lab.emoji, lab.audience], ['#644642', '#706ea0', '2026-11-21', 'testing', '\u{1F944}', 'Anyone with family recipes on index cards']);
  assert.strictEqual(lab.tagline, 'Save the family recipes before the cards fade - then scale, shop and cook from your phone.');
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const other of LAB.APPS.filter((x) => x.slug !== 'ladle')) {
    for (const c of [other.color, other.color2]) assert.ok(labDist(lab.color, c) >= 20 && labDist(lab.color2, c) >= 20, `away from ${other.slug} ${c}: ${labDist(lab.color, c).toFixed(1)} / ${labDist(lab.color2, c).toFixed(1)}`);
    assert.notStrictEqual(other.emoji, lab.emoji, `${other.slug} has the same emoji`);
  }
  assert.strictEqual(LAB.APPS.findIndex((x) => x.slug === 'ladle') + 1, 64, 'drop #64');
  assert.strictEqual(lab.features.length, 4);
});

test('the page: relative links, no inline script or handlers, the banner, the spoon with no variation selector, storage only through ladle-store.js, no clock or dice in the core or the demo, the requests it makes, the photos shown are the ones sent and nothing else, every received string escaped, the wake lock and timers, the tour', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  assert.ok(/<body[^>]*>[\s\S]*\n {2}<div class="print" id="print" aria-hidden="true"><\/div>\n/.test(html), 'the print view sits straight inside body');
  assert.ok(html.includes('\u{1F944}') && !html.includes('\u{1F944}\u{FE0F}'), 'the spoon, no variation selector');
  const js = read('public/app.js');
  assert.ok(!js.includes('\u{FE0F}'));
  assert.ok(!/[\u{FF0B}\u{2715}]/u.test(js), 'no glyph a phone’s font may lack (full-width plus, the ballot x)');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(js), 'the page touches no storage itself');
  assert.ok(!/\.backend\.(put|get|del)/.test(js), 'nor the store’s backend');
  for (const f of ['public/ladle-core.js', 'public/demo.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(/.test(src), `${f} has no dice and no clock`);
  }
  const all = js + read('public/ladle-core.js') + read('public/demo.js') + read('public/ladle-store.js');
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(all), 'no eval of any kind');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/card', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me', 'api/sync'], 'the page asks for nothing else');
  assert.strictEqual((js.match(/\bfetch\(/g) || []).length, 2, 'two fetches: api() and the verify resend');
  assert.match(js, /api\('PUT', 'api\/sync', \{ data: bodyOf\(state\.box\), base:/);
  assert.ok(!/photos/.test((js.match(/function bodyOf[^\n]*/) || [''])[0]), 'the synced body is the box alone');
  // The card: the JPEGs shown are the JPEGs sent, and nothing else goes with them.
  assert.match(js, /function cardBody\(photos\) \{ return \{ images: \[1, 2\]\.filter\(function \(s\) \{ return photos\[s\]; \}\)\.map\(function \(s\) \{ return \{ type: 'image\/jpeg', data: photos\[s\]\.split\(','\)\[1\] \}; \}\) \}; \}/);
  assert.match(js, /var sent = cardBody\(d\.photos\);\n\s*btn\.disabled = true;/);
  assert.match(js, /api\('POST', 'api\/ai\/card', sent\)/);
  assert.match(js, /<img class="labelimg" alt="The photo that will be sent" src="' \+ esc\(d\.photos\[s\]\) \+ '">/);
  assert.match(js, /What is sent: the card’s photos, shrunk on your phone - and nothing else\./);
  assert.match(js, /shrink\(file, C\.LIMITS\.aiImageSide, RS\.PHOTO_MAX\)/);
  assert.match(js, /var k = Math\.min\(1, side \/ Math\.max\(img\.naturalWidth, img\.naturalHeight\)\);/, 'redrawn through a canvas');
  assert.match(js, /cv\.toDataURL\('image\/jpeg', q\)/);
  assert.match(js, /real\.putPhoto\(ref, d\.photos\[s\]\)/, 'card photos kept through the store');
  assert.match(js, /d\.fields = C\.draftFields\(res\.draft, keep\);/, 'whose recipe it is stays what the person typed');
  assert.strictEqual((js.match(/type="email"/g) || []).length, 1, 'only the sign-in form asks for an email - the account holder’s own');
  assert.ok(!/type="tel"|autocomplete="(tel|street-address|address-line1|postal-code|cc-number)"/i.test(js + html));
  assert.ok(!/geolocation|getCurrentPosition|watchPosition/.test(all), 'never located');
  assert.ok(!/navigator\.share\(\{[^}]*url:/.test(js), 'nothing shared as a link');
  // Cook mode: the wake lock where there is one, said plainly where there is not; timers by their end time.
  assert.match(js, /navigator\.wakeLock\.request\('screen'\)/);
  assert.match(js, /if \(!\('wakeLock' in navigator\)\) \{ state\.wakeState = 'no'; return; \}/);
  assert.match(js, /This browser can’t keep the screen awake/);
  assert.match(js, /if \(state\.view === 'cook' && !state\.wake\) enterCook\(\);/, 'the lock comes back when the page does');
  assert.match(js, /state\.wake\.release\(\)/);
  assert.match(js, /end: Date\.now\(\) \+ mins \* 60000/);
  assert.match(js, /navigator\.vibrate/);
  // Printing a fresh card: the page size set by a style element, never inline script.
  assert.match(js, /st\.textContent = state\.device\.size === '4x6' \? '@page \{ size: 6in 4in;/);
  assert.ok((js.match(/state\.demo \? '<p class="pdemo">Made-up example<\/p>'/g) || []).length === 1, 'the printed card says so in the example');
  // Every interpolation of something a person, the server or a model wrote goes through esc().
  const strip = (src) => { let out = ''; let i = 0; const re = /\besc\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|textContent|say\(/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(?!SAFE\b)([a-zA-Z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*(?:\([^()]*\))?)\s*\+/g);
  const allowed = (r) => /\+\s*(?:[a-zA-Z]*Html(?:\([^()]*\))?|html|li|rows|steps|groups|sides|intro|unitSeg\(\)|C\.qeq\([^()]*\)|Boolean\([^()]*\)|r\.on|cardPane\([^()]*\)|guideHtml\([^()]*\)|demoRibbon\(\)|mergeNoteHtml\(\)|syncLine\(\)|D\.cardSvg\(\))\s*\+/.test(r);
  const bad = (risky || []).filter((r) => !allowed(r));
  assert.deepStrictEqual(bad, [], `unescaped: ${bad}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbrief\b|\bbox\b|\bimages?\b|\bdata\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /ladle-shell-v1/.test(sw) && ['ladle-core.js', 'ladle-store.js', 'demo.js', 'app.js'].every((f) => sw.includes(`'${f}'`)) && /k\.indexOf\('ladle-'\) === 0/.test(sw), 'the service worker caches only the app shell, never api/, and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  // The tour: five steps, in order, each with its view and words.
  const tour = /var TOUR = \[([\s\S]*?)\n {2}\];/.exec(js)[1];
  assert.deepStrictEqual([...tour.matchAll(/view: '(\w+)'/g)].map((m) => m[1]), ['box', 'recipe', 'shop', 'cook', 'edit']);
  for (const w of ['Open the pumpkin pie', 'Make it serve 16', 'Tick the eggs', 'Start the 15 min timer', 'Type up the example card', 'Save my first recipe', '¾ cup sugar becomes 1 ½ cups', '8 eggs from three cards', '1 cup of butter', '2 cups of sugar']) assert.ok(tour.includes(w), w);
  assert.match(js, /if \(n === 2\) \{ state\.scale\.rpumpkin1 = C\.Q\(2\);/);
  assert.match(js, /if \(n === 3\) \{ commit\(C\.tick\(box\(\), 'egg\|n:', true, stamp\(\)\)\);/);
  assert.match(js, /if \(n === 4\) \{ state\.cook = \{ rid: 'rpumpkin1', i: 4 \};/);
  assert.match(js, /function demoRibbon\(\) \{\n\s*return state\.demo \? '<p class="ribbon">' \+ esc\(D\.NOTICE\)/);
  for (const v of ['boxHtml', 'recipeHtml', 'editHtml', 'shopHtml', 'moreHtml']) assert.ok(new RegExp('function ' + v + '\\(\\) \\{[\\s\\S]{0,1500}?demoRibbon\\(\\)').test(js), `${v} carries the ribbon`);
  assert.match(js, /function photosHtml\(r\) \{\n[^\n]*\n\s*if \(state\.demo\) return '';/);
  assert.match(js, /document\.addEventListener\('visibilitychange'[\s\S]{0,400}if \(signedIn\(\)\) syncIn\(\);/);
});

test('the copy: no food, appliance or grocery brand in any file; no invisible characters, key-shaped strings, email addresses, phone numbers or session links; model names only in MODELS; CLAUDE.md says it is a rebuild', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x));
  assert.ok(files.length >= 20);
  const marks = [['Cris', 'co'], ['Ka', 'ro'], ['Jell', '-O'], ['Py', 'rex'], ['Cool ', 'Whip'], ['Lib', 'by'], ['Ocean ', 'Spray'], ['Car', 'nation'], ['Pills', 'bury'], ['Betty ', 'Crocker'], ['Gold ', 'Medal'], ['Domi', 'no'], ['Mc', 'Cormick'], ['Phila', 'delphia'], ['Hell', 'mann'], ['Camp', 'bell'], ['Hei', 'nz'], ['Kraf', 't'], ['Nest', 'lé'], ['Hersh', 'ey'], ['Kitchen', 'Aid'], ['Cuisin', 'art'], ['Insta', 'nt Pot'], ['Tup', 'perware'], ['Wal', 'mart'], ['Tar', 'get'], ['Kro', 'ger'], ['Cost', 'co'], ['Ama', 'zon'], ['Goo', 'gle'], ['All', 'recipes'], ['Stove', ' Top'], ['Ree', 'ses'], ['Gerb', 'er']].map((p) => p.join(''));
  const markRe = new RegExp('(^|[^A-Za-z])(' + marks.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z])');
  assert.ok(markRe.test('a ' + marks[0] + ' pie crust') && !markRe.test('the target temperature and a dominant flavour'), 'the check bites, and only where it should');
  const SESSION_LINK = new RegExp(['claude', 'ai/code'].join('\\.') + '|' + ['Claude', 'Session'].join('-'));
  const invisible = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [0x7F, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]].map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']');
  const phoneRe = /(^|[^\d.])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8'), rel = path.relative(ROOT, f);
    assert.ok(!invisible.test(src), `${rel} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bsk-ant-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(src), `${rel} carries a key-shaped string`);
    if (!/^public\/(passkey-client|verify-banner|desktop)\.|^lib\/(identity|stripe|byok|webauthn|identity-store)\.js$/.test(rel)) {
      assert.ok(!markRe.test(src), `${rel} names a brand: ${(markRe.exec(src) || [])[2]}`);
      assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(src), `no email address in ${rel}`);
      assert.ok(!phoneRe.test(src), `no phone number in ${rel}: ${(phoneRe.exec(src) || [])[0]}`);
      assert.ok(!SESSION_LINK.test(src), `no session link in ${rel}`);
    }
  }
  const strings = JSON.stringify([D.box(), D.CARD_RAW, D.cardSvg(), require('../lib/fakeai').GOOD]);
  assert.ok(!invisible.test(strings) && !markRe.test(strings), 'nor in what the demo and the fake make');
  const models = files.filter((f) => /claude-(haiku|sonnet|opus)/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)).filter((f) => !/^lib\/identity/.test(f));
  assert.deepStrictEqual(models, ['server.js'], 'model names only in the MODELS constant');
  assert.ok(read('server.js').includes(`const MODELS = { free: '${FREE_MODEL}', paid: '${PAID_MODEL}' };`));
  assert.strictEqual((read('server.js').match(/claude-[a-z]+-[0-9]/g) || []).length, 2, 'once each');
  const doc = read('CLAUDE.md').replace(/\s+/g, ' ');
  assert.match(doc, /a rebuild of the 2026-11-16 drop/i);
  assert.match(doc, /HANDOFF\.md/);
  for (const f of ['lib/identity.js', 'lib/identity-store.js', 'lib/byok.js', 'lib/stripe.js', 'lib/webauthn.js', 'public/desktop.css', 'public/passkey-client.js', 'public/verify-banner.js']) {
    assert.strictEqual(read(f), fs.readFileSync(path.join(ROOT, '..', 'snug', f), 'utf8'), `${f} is the shared copy`);
  }
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*\n/gm, '').replace(/'[^'\n]*'/g, "''");
  assert.strictEqual(code(read('lib/image.js')), code(fs.readFileSync(path.join(ROOT, '..', 'snug', 'lib', 'image.js'), 'utf8')), 'image.js is Snug’s but for words');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; one document per account, read by its id', () => {
  for (const [mod, env] of [['./lib/store', { LADLE_MEMORY: '1' }], ['./lib/fakeai', { LADLE_FAKE_AI: '1' }], ['./server', { LADLE_FAKE_AI: '1', LADLE_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, LADLE_MEMORY: '', LADLE_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, LADLE_MEMORY: '', LADLE_COLLECTION_PREFIX: 'ladle_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'ladle_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'no query: one document per account, by its id');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('boxes'", "store.transact('boxes'"]);
  assert.match(server, /update\('ladle owner v1'\)/);
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
const BIG = { x: 'x'.repeat(1700 * 1024) };
const HUGE = { x: 'x'.repeat(5.5 * 1024 * 1024) };
/** The example with its times moved to now: a real phone stamps with its clock. */
function restamp(b, t) {
  const x = clone(b);
  x.t = t;
  for (const id of Object.keys(x.recipes)) x.recipes[id].t = t;
  for (const k of ['plan', 'ticks', 'extra']) for (const id of Object.keys(x.shop[k])) x.shop[k][id].t = t;
  return x;
}

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
const cardOf = (...ims) => ({ images: ims });

test('images by their bytes: JPEG, PNG and WebP sniffed, their metadata (EXIF, text, location) stripped, their size read; each of two photos checked; anything else refused', () => {
  const j = img.cleanJpeg(jpegOf(1200, 900, 'GPS 51.5N'));
  assert.deepStrictEqual(j.size, { width: 1200, height: 900 });
  assert.ok(!j.buf.includes(Buffer.from('Exif')) && !j.buf.includes(Buffer.from('GPS')));
  const p = img.cleanPng(pngOf(800, 600, 'Comment\0taken at Nana’s'));
  assert.ok(!p.buf.includes(Buffer.from('taken at')));
  const w = img.cleanWebp(webpOf(640, 480, 'GPS 51.5N'));
  assert.ok(!w.buf.includes(Buffer.from('GPS')) && !(w.buf[20] & 0x08));
  const brief = aiLib.brief(cardOf(im(jpegOf(1600, 1200, 'GPS')), im(pngOf(900, 600, 'Comment\0back'), 'image/png')));
  assert.deepStrictEqual(Object.keys(brief), ['images'], 'the photos alone');
  assert.strictEqual(brief.images.length, 2);
  assert.ok(!Buffer.from(brief.images[0].data, 'base64').includes(Buffer.from('GPS')) && !Buffer.from(brief.images[1].data, 'base64').includes(Buffer.from('back')));
  assert.throws(() => aiLib.brief(cardOf(im(jpegOf(100, 100)), im(jpegOf(2400, 1200)))), /too large/, 'the second photo is checked too');
  assert.throws(() => aiLib.brief(cardOf(im(pngOf(10, 10), 'image/jpeg'))), /JPEG, PNG or WebP/);
});

test('signed out: the page and its files load with zero model calls; sync and the AI answer 401 before reading a body; no other route takes or hosts a recipe', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.ok(meta.units.includes('tbsp') && meta.aisles.includes('produce'));
  for (const f of ['ladle-core.js', 'ladle-store.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  const shell = await page.text();
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/sync'], ['PUT', '/api/sync'], ['DELETE', '/api/sync'], ['POST', '/api/ai/card']]) assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  for (const [m, p] of [['PUT', '/api/sync'], ['POST', '/api/ai/card']]) assert.strictEqual((await anon(m, p, HUGE)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/recipe', '/api/recipes', '/api/photos', '/api/photo', '/api/share', '/api/list', '/api/print', '/api/card']) {
    assert.strictEqual((await anon('POST', p, { x: 1 })).status, 404, `POST ${p}`);
    assert.strictEqual((await anon('GET', p)).status, 404, `GET ${p}`);
  }
  for (const p of ['/r/abc', '/recipe', '/list']) assert.strictEqual(await (await fetch(`${base}${p}`)).text(), shell, `${p} is only the app shell`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('writes come from this page: another site’s request (Sec-Fetch-Site or Origin) is 403 and a body that is not JSON 415, before anything else', async () => {
  const ana = await register('ana.sameorigin');
  const b = restamp(D.box(), Date.now());
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'same-site' })).status, 403, 'a sibling subdomain is another site here');
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await ana('POST', '/api/ai/card', cardOf(im(jpegOf(10, 10))), { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/sync', 'data=1', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await ana('DELETE', '/api/sync', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const same = await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'same-origin', Origin: base.replace(/\/ladle$/, '') });
  assert.strictEqual(same.status, 200, same.text);
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor; one forced tool with no field for a name; max_tokens 4400 with the arithmetic shown', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/card', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/sync', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js'), ai = read('lib/ai.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((ai.match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai, /tool_choice: \{ type: 'tool', name: TOOL\.name \}/);
  assert.match(ai, /max_tokens: 4400,/);
  assert.match(ai, /That is 4,255 for a card filled to every cap - real cards use a\n\s*\/\/ third of it - rounded up: 4,400\./, 'the arithmetic is shown');
  assert.strictEqual(51 * 40 + 85 * 24 + 20 + 5 + 75 + 15 + 60, 4255, 'and it adds up');
  const props = JSON.stringify(aiLib.TOOL.input_schema);
  assert.ok(!/"(from|author|name|by|signature|cook|person|email|phone)"/.test(props), 'no field for a person');
  assert.deepStrictEqual([aiLib.TOOL.input_schema.properties.ingredients.maxItems, aiLib.TOOL.input_schema.properties.steps.maxItems, aiLib.TOOL.input_schema.properties.steps.items.properties.text.maxLength], [40, 24, 300]);
  assert.match(src, /express\.json\(\{ limit: '1500kb' \}\)/);
  assert.match(src, /express\.json\(\{ limit: '5mb' \}\)/);
});

test('sync: the box follows the account to the other phone; a stale phone gets 409 with the account copy and merges - a recipe added on each phone both kept, a tick from each; bodies out of shape refused whole; ~600 KB; 120 saves in ten minutes; filed under an HMAC', async () => {
  const a = await register('phone.one');
  assert.deepStrictEqual((await a('GET', '/api/sync')).data, { data: null, updatedAt: null });
  const b0 = restamp(D.box(), Date.now() - 60000);
  const put = await a('PUT', '/api/sync', { data: b0, base: null });
  assert.strictEqual(put.status, 200, put.text);
  const v1 = put.data.updatedAt;
  assert.ok(C.same(put.data.data, b0), 'saved as sent');
  const b = client();
  assert.strictEqual((await b('POST', '/api/auth/login', { email: mail('phone.one'), password: 'a long enough password' })).status, 200);
  const onB = (await b('GET', '/api/sync')).data;
  assert.strictEqual(onB.updatedAt, v1);
  let bEdit = C.putRecipe(onB.data, 'rgravy0001', rec({ title: 'Gravy', ingredients: '1/4 cup flour\n2 cups stock' }, Date.now()));
  bEdit = C.tick(bEdit, 'egg|n:', true, Date.now());
  assert.strictEqual((await b('PUT', '/api/sync', { data: bEdit, base: v1 })).status, 200);
  let aEdit = C.putRecipe(b0, 'rstuff0001', rec({ title: 'Oyster stuffing' }, Date.now() + 5));
  aEdit = C.tick(aEdit, 'sugar|vol', true, Date.now() + 6);
  const stale = await a('PUT', '/api/sync', { data: aEdit, base: v1 });
  assert.deepStrictEqual([stale.status, stale.data.code], [409, 'conflict']);
  assert.ok(stale.data.data.recipes.rgravy0001, 'the 409 carries the account copy');
  const merged = C.merge(aEdit, stale.data.data, v1, C.copyIdOf).box;
  const again = await a('PUT', '/api/sync', { data: merged, base: stale.data.updatedAt });
  assert.strictEqual(again.status, 200, again.text);
  const final = (await b('GET', '/api/sync')).data.data;
  assert.ok(final.recipes.rgravy0001 && final.recipes.rstuff0001 && final.shop.ticks['egg|n:'].on && final.shop.ticks['sugar|vol'].on, 'both phones’ changes survived');
  assert.strictEqual((await a('PUT', '/api/sync', { data: merged, base: null })).status, 409, 'a phone that never synced cannot overwrite');
  const cur = (await a('GET', '/api/sync')).data;
  const variants = [
    ['an unknown field', (x) => { x.photos = { rpumpkin1: 'data:image/jpeg;base64,AAAA' }; }],
    ['a photo in a recipe', (x) => { x.recipes.rpumpkin1.photo = 'data:image/jpeg;base64,AAAA'; }],
    ['an @', (x) => { x.recipes.rpumpkin1.notes = 'ask ' + AT + 'nana'; }],
    ['a full-width @', (x) => { x.recipes.rpumpkin1.from = 'nana' + FW_AT + 'x'; }],
    ['nine Arabic-Indic digits', (x) => { x.recipes.rpumpkin1.steps[0] = ch(0x0662).repeat(9); }],
    ['a phone number', (x) => { x.recipes.rpumpkin1.notes = 'Call Nana ' + PHONE; }],
    ['a card number', (x) => { x.shop.extra.xcoffee1.text = CARD; }],
    ['a link', (x) => { x.recipes.rpumpkin1.notes = 'see pies.example.com'; }],
    ['a formula', (x) => { x.recipes.rpumpkin1.steps[0] = '=HYPERLINK("x")'; }],
    ['markup', (x) => { x.recipes.rpumpkin1.title = '<img src=x>'; }],
    ['an invisible character', (x) => { x.recipes.rpumpkin1.title = 'Pie' + RLO; }],
    ['an unknown unit', (x) => { x.recipes.rpumpkin1.ingredients[1].unit = 'bucket'; }],
    ['an amount that is not a fraction', (x) => { x.recipes.rpumpkin1.ingredients[1].q = 0.75; }],
    ['serves 100', (x) => { x.recipes.rpumpkin1.serves = 100; }],
    ['61 ingredient lines', (x) => { x.recipes.rpumpkin1.ingredients = Array(61).fill(x.recipes.rpumpkin1.ingredients[0]); }],
    ['a time as a string', (x) => { x.recipes.rpumpkin1.t = '12'; }],
    ['a bad recipe id', (x) => { x.recipes['../x'] = x.recipes.rpumpkin1; }],
  ];
  for (const [what, f] of variants) {
    const x = clone(cur.data); f(x);
    const r = await a('PUT', '/api/sync', { data: x, base: cur.updatedAt });
    assert.strictEqual(r.status, 400, `${what}: ${r.text.slice(0, 200)}`);
  }
  assert.strictEqual((await a('PUT', '/api/sync', { data: cur.data, base: cur.updatedAt, photo: 'x' })).status, 400, 'nothing beside the box and its base');
  // About 600 KB as stored, inside a 1.5 MB parser that runs after the sign-in.
  const big = clone(cur.data);
  for (let i = 0; i < 300; i++) big.recipes['rbig' + String(i).padStart(4, '0')] = rec({ title: 'Big ' + i, ingredients: Array(30).fill('1 1/2 cups flour sifted twice with care').join('\n'), steps: Array(10).fill('Stir it well and slowly for a good long while until it looks right.').join('\n') });
  const tooBig = await a('PUT', '/api/sync', { data: big, base: cur.updatedAt });
  assert.ok([400, 413].includes(tooBig.status), 'too many recipes, or too much');
  assert.strictEqual((await a('PUT', '/api/sync', BIG)).status, 413, 'over the parser, after the sign-in');
  assert.strictEqual((await a('GET', '/api/sync')).data.updatedAt, cur.updatedAt, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('phone.one') && !dump.includes(uidOf(mail('phone.one'))), 'filed under an HMAC, never the account id or address');
  assert.ok(dump.includes(ownerTag(uidOf(mail('phone.one')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'boxes')[1]).map(([, d]) => d).find((d) => d.box.recipes.rgravy0001);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['box', 'owner', 'updatedAt']);
  assert.deepStrictEqual(Object.keys(doc.box).sort(), ['recipes', 'shop', 't', 'v']);
  const other = await register('someone.else');
  assert.deepStrictEqual((await other('GET', '/api/sync')).data.data, null, 'another account sees nothing of it');
  assert.strictEqual((await a('DELETE', '/api/sync')).status, 200);
  const removed = await b('PUT', '/api/sync', { data: final, base: 5 });
  assert.deepStrictEqual([removed.status, removed.data.code], [409, 'removed'], 'removed on the other phone says so');
  const r = await register('busy.cook');
  const mini = C.newBox(Date.now());
  let at = null, last = 0;
  for (let i = 0; i < 121; i++) { const res = await r('PUT', '/api/sync', { data: mini, base: at }); last = res.status; if (res.status === 200) at = res.data.updatedAt; else break; }
  assert.strictEqual(last, 429, 'the 121st save in ten minutes waits');
});

test('the AI over HTTP: exactly {images} - non-images, extra fields and wrong types refused with no model call; the model saw the photos stripped and one fixed sentence - no recipe, no name; one forced tool; a name, calories, a price, an email, a phone, a link and markup dropped; 422, 502, 503, 413', async () => {
  const ana = await register('ana.card');
  const calls = await modelCalls();
  const good = cardOf(im(jpegOf(1600, 1200, 'GPS 51.5N kitchen')));
  const bad = [
    {}, [], { images: [] },
    Object.assign({}, good, { recipe: D.box().recipes.rpumpkin1 }),
    Object.assign({}, good, { from: 'Nana Dot' }),
    Object.assign({}, good, { question: 'Is it healthy?' }),
    cardOf(im(Buffer.from('not a photo at all'))),
    cardOf({ type: 'image/gif', data: good.images[0].data }),
    cardOf({ type: 'image/png', data: good.images[0].data }),
    cardOf(Object.assign({ name: 'card.jpg' }, good.images[0])),
    cardOf(im(jpegOf(2400, 1600))),
    cardOf(good.images[0], good.images[0], good.images[0]),
    cardOf(im(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))),
    cardOf({ type: 'image/jpeg', data: Buffer.alloc(1.6 * 1024 * 1024, 7).toString('base64') }),
  ];
  for (const x of bad) {
    const r = await ana('POST', '/api/ai/card', x);
    assert.strictEqual(r.status, 400, JSON.stringify(x).slice(0, 80) + ' ' + r.text.slice(0, 200));
  }
  assert.strictEqual((await ana('POST', '/api/ai/card', Object.assign({}, good, { from: 1 }))).data.code, 'extra-field');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  for (const [buf, type] of [[pngOf(900, 700, 'Comment\0secret'), 'image/png'], [webpOf(1000, 800, 'GPS 51.5N'), 'image/webp']]) {
    const ok = await ana('POST', '/api/ai/card', cardOf(im(buf, type)));
    assert.strictEqual(ok.status, 200, `${type}: ${ok.text.slice(0, 200)}`);
  }
  const n0 = fakeClient.calls.length;
  const r = await ana('POST', '/api/ai/card', good);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.draft.title, 'Molasses cookies');
  assert.deepStrictEqual(r.data.draft.ingredients[0], { q: [3, 4], q2: null, unit: 'cup', item: 'shortening' });
  assert.deepStrictEqual(r.data.dropped, []);
  const two = await ana('POST', '/api/ai/card', cardOf(good.images[0], im(jpegOf(1200, 900, 'GPS back'))));
  assert.strictEqual(two.status, 200);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 4, 'one call each, metered');
  const sent = fakeClient.calls[n0];
  assert.strictEqual(sent.model, FREE_MODEL);
  assert.deepStrictEqual(sent.tool_choice, { type: 'tool', name: 'record_recipe' });
  assert.strictEqual(sent.tools.length, 1);
  assert.strictEqual(sent.max_tokens, 4400);
  assert.strictEqual(sent.messages.length, 1);
  const content = sent.messages[0].content;
  assert.deepStrictEqual(content.map((x) => x.type), ['image', 'text']);
  assert.strictEqual(content[1].text, 'Type up this recipe card.', 'one fixed sentence');
  const two0 = fakeClient.calls[n0 + 1].messages[0].content;
  assert.deepStrictEqual([two0.map((x) => x.type), two0[2].text], [['image', 'image', 'text'], 'Type up this recipe card. The second photo is the back of the same card.']);
  for (const c of [content[0], two0[0], two0[1]]) { const photo = Buffer.from(c.source.data, 'base64'); assert.ok(!photo.includes(Buffer.from('Exif')) && !photo.includes(Buffer.from('GPS')), 'each photo’s metadata stripped'); }
  assert.ok(!/Nana|Pumpkin|ana\.card/.test(JSON.stringify(sent)), 'nothing of the box or the account');
  assert.ok(!store._dump().includes('Molasses'), 'nothing stored');
  fakeClient.mode = 'bad';
  const b = await ana('POST', '/api/ai/card', good);
  assert.strictEqual(b.status, 200, b.text);
  assert.ok(!/555|calories|Dorothy|\$4|family\.example|cookies\.example|<b>|Healthy/i.test(JSON.stringify(b.data.draft)) && !b.text.includes(AT), b.text.slice(0, 500));
  assert.strictEqual(b.data.draft.serves, null);
  assert.strictEqual(b.data.draft.ingredients.length, 8);
  assert.strictEqual(b.data.draft.steps.length, 3);
  assert.deepStrictEqual(b.data.dropped.slice().sort(), ['5 lines with an email, a phone number, a link or a nutrition claim', 'calories', 'from', 'notes', 'price', 'serves', 'signature'].sort(), b.data.dropped.join(' | '));
  fakeClient.mode = 'inject';
  const inj = await ana('POST', '/api/ai/card', good);
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<img|onerror|ignore your|\u202e/i.test(inj.text), inj.text.slice(0, 300));
  assert.deepStrictEqual(inj.data.dropped, ['admin', 'note', 'notes'], 'the extra fields and the marked-up notes named, never echoed');
  assert.strictEqual(inj.data.draft.title, 'Molasses cookies', 'a bidi override is mended out of a reading');
  fakeClient.mode = 'blank';
  const blank = await ana('POST', '/api/ai/card', good);
  assert.deepStrictEqual([blank.status, /Nothing on that card/.test(blank.data.error)], [422, true]);
  fakeClient.mode = 'maxtokens';
  const mt = await ana('POST', '/api/ai/card', good);
  assert.deepStrictEqual([mt.status, /ran long/.test(mt.data.error)], [502, true]);
  fakeClient.mode = 'upstream401';
  const up = await ana('POST', '/api/ai/card', good);
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await ana('POST', '/api/ai/card', good);
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  const big = await ana('POST', '/api/ai/card', HUGE);
  assert.deepStrictEqual([big.status, /too much/.test(big.data.error)], [413, true]);
});

test('the gates: an unconfirmed free account 403 verify-email with its resend link, out of credit 402, the day’s free ceiling 503 - each before the parser, never a model call', async () => {
  const eve = await register('eve.unconfirmed');
  const good = cardOf(im(jpegOf(100, 100)));
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/ai/card', good);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/ladle/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/ai/card', HUGE)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/card', good)).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/card', HUGE)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const today = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-ladle-${today}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/card', good);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/card', HUGE)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-ladle-${today}`); }
});

test('a hostile pass leaves nothing personal in the store: refused bodies, injected answers and the card photo never land; what is kept holds no email, phone, card, markup or account id', async () => {
  const h = await register('hostile.pass');
  const s = restamp(D.box(), Date.now());
  const tries = [
    (x) => { x.recipes.rpumpkin1.notes = 'Call ' + PHONE; },
    (x) => { x.recipes.rpumpkin1.from = 'mail me ' + mail('dana'); },
    (x) => { x.shop.extra.xcoffee1.text = 'Card ' + CARD; },
    (x) => { x.recipes.rpumpkin1.title = '<script>alert(1)</script>'; },
    (x) => { x.recipes.rpumpkin1.notes = 'Ring ' + ch(0x0967).repeat(9); },
  ];
  for (const f of tries) { const x = clone(s); f(x); assert.strictEqual((await h('PUT', '/api/sync', { data: x, base: null })).status, 400); }
  assert.strictEqual((await h('PUT', '/api/sync', { data: s, base: null })).status, 200);
  fakeClient.mode = 'bad';
  await h('POST', '/api/ai/card', cardOf(im(jpegOf(300, 200, 'GPS 51.5N'))));
  const dump = store._dump();
  assert.ok(!dump.includes(AT) && !dump.includes('example.com'), 'no email');
  assert.ok(![PHONE, CARD, '<script', 'Exif', 'GPS', 'base64', 'Dorothy', 'Molasses'].some((x) => dump.includes(x)), 'no phone, card, markup, name, reading or photo');
  assert.ok(!dump.includes(uidOf(mail('hostile.pass'))), 'no account id');
  for (const [, docs] of JSON.parse(dump)) for (const [, d] of docs) assert.deepStrictEqual(Object.keys(d).sort(), ['box', 'owner', 'updatedAt'], 'only boxes are kept');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/ladle', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/ladle`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
