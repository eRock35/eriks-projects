// Pure rules first (the candy, cleaning, counting and undo, categories,
// titles, the card, fair trade and the swap, the ration plan with a fixed
// clock, the buyback sums, set-aside, the photo's payload and answer), then
// the page's own promises, then end to end against the memory identity store
// and the fake model:
//   HAUL_MEMORY=1 HAUL_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /haul, the way the
// lab mounts it, so the auth cookie, the budget gate and the route's parser
// order are exercised as deployed. Model calls are counted from the identity
// usage rows, and what reached "the model" is read from the fake's own log.
//
// Every name and haul here is made up.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.HAUL_MEMORY !== '1' || process.env.HAUL_FAKE_AI !== '1') {
  console.error('run with HAUL_MEMORY=1 HAUL_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, fakeClient } = require('../server');
const C = require('../public/haul-core');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TODAY = '2026-10-31'; // a Saturday

/* ---------------- helpers ---------------- */

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

const u16 = (v) => Buffer.from([(v >> 8) & 255, v & 255]);
/** A small JPEG with an EXIF (location) segment and a comment, w x h. */
function jpeg(w, h, pad) {
  const seg = (m, payload) => Buffer.concat([Buffer.from([0xff, m]), u16(payload.length + 2), payload]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude 40.7128 GPSLongitude -74.0060', 'latin1')),
    seg(0xfe, Buffer.from('taken at 12 Elm Street', 'latin1')),
    seg(0xc0, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])),
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(pad || 200, 0x55), Buffer.from([0xff, 0xd9]),
  ]);
}
function png(w, h) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0GPS 40.7 home address', 'latin1')), chunk('IDAT', Buffer.alloc(40, 1)), chunk('IEND', Buffer.alloc(0))]);
}
/** A family of made-up children with these counts. */
function family(kids, extra) {
  return C.cleanFamily(Object.assign({ kids: kids.map((k, i) => Object.assign({ id: `kid${i}aaaa`, name: '', avatar: '🧛' }, k)) }, extra || {}));
}
let idn = 0;
const newId = () => `x${String(++idn).padStart(8, '0')}`;

/* ================================================================== *
 * The candy, text and the family
 * ================================================================== */

test('the candy: about forty-eight common treats in six categories, each with a picture and sentence words; brand names are plain text', () => {
  assert.ok(C.CANDY.length >= 40 && C.CANDY.length <= 56, `${C.CANDY.length} candies`);
  assert.strictEqual(new Set(C.CANDY_IDS).size, C.CANDY.length, 'no id twice');
  assert.deepStrictEqual(C.CAT_IDS, ['choc', 'fruity', 'gummy', 'hard', 'full', 'not']);
  for (const x of C.CANDY) {
    assert.ok(/^[a-z]{2,16}$/.test(x.id) && x.name && x.emoji && x.one && x.many && C.CAT_IDS.includes(x.cat) && x.rare >= 1 && x.rare <= 5, x.id);
    assert.ok(!/[™®©<>]/.test(x.name + x.one + x.many), `${x.id}: no marks or markup`);
  }
  for (const cat of C.CAT_IDS) assert.ok(C.CANDY.some((x) => x.cat === cat), cat);
  assert.deepStrictEqual(C.DEFAULT_VALUES, { choc: 3, fruity: 2, gummy: 2, hard: 1, full: 5, not: 0.5 }, 'the tier: full-size 5, chocolate 3, gummies and sour 2, hard candy 1, not candy 0.5');
  assert.strictEqual(C.candyOf('candycorn').cat, 'hard', 'candy corn is a 1');
  assert.strictEqual(C.candyOf('raisins').cat, 'not', 'raisins are a 0.5');
  assert.ok(C.candyOf('raisins').eat && !C.candyOf('pencil').eat && !C.candyOf('toothbrush').eat, 'raisins are eaten, a pencil is not');
  assert.strictEqual(C.candyOf('__proto__'), null);
  assert.strictEqual(C.candyOf('constructor'), null);
  // Search
  const find = (q) => C.CANDY.filter((x) => C.matches(x, q)).map((x) => x.id);
  assert.ok(find('kit kat').includes('wafer') && find('KitKat').includes('wafer'));
  assert.ok(find('reeses').includes('pbcups') && find('Reese’s').includes('pbcups'));
  assert.ok(find('sour').includes('sourpatch') && find('sour').includes('warheads'));
  assert.deepStrictEqual(find('zzqx'), []);
  assert.strictEqual(find('').length, C.CANDY.length);
});

test('text: names are plain, bounded, with no markup, bidi or invisible characters, and need a letter or digit; esc covers quotes', () => {
  assert.strictEqual(C.cleanName('<img src=x onerror=alert(1)>Leo'), 'Leo');
  assert.strictEqual(C.cleanName('Ma\u202eya\u200b'), 'Maya');
  assert.strictEqual(C.cleanName('🎃🎃'), '', 'emoji only is no name');
  assert.strictEqual(C.cleanName('   '), '');
  assert.strictEqual(Array.from(C.cleanName('Bartholomew-Maximilian the Third')).length, C.LIMITS.name);
  assert.strictEqual(C.cleanName('Zoë'), 'Zoë');
  assert.strictEqual(C.esc('<b a="1">\'&'), '&lt;b a=&quot;1&quot;&gt;&#39;&amp;');
  assert.strictEqual(C.modelText('Visit https://evil.example/x or www.evil.example now <b>ok</b>', 160), 'Visit or now ok');
  assert.strictEqual(C.modelText('javascript:alert(1)', 40), '');
});

test('a hostile family read from storage comes back clean: known candy only, whole counts 1..999, six children, no prototype tricks', () => {
  const raw = JSON.parse(JSON.stringify({
    kids: [
      { id: 'goodkid01', name: '<b>Leo</b>\u202e', avatar: '🦖', counts: { pbcups: 3, nope: 9, chocbar: -2, wafer: 2.5, lollipop: 5000, twix: '4' }, aside: ['pbcups', 'nope', 'pbcups'], plan: { perDay: 99, days: [true], eaten: { '2026-10-31': 2, 'not-a-day': 3, '2026-02-30': 1 } } },
      { id: 'goodkid01', name: 'Dup' },
      { id: 'BAD ID', name: 'Bad' },
      { id: 'kid2aaaaaa', avatar: '<b>' },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `more${i}aaaa` })),
    ],
    custom: [{ id: 'xabcdefgh', name: 'Candy necklace', cat: 'hard' }, { id: 'bad', name: 'Nope', cat: 'hard' }, { id: 'xzzzzzzzz', name: '<i></i>', cat: 'hard' }, { id: 'xyyyyyyyy', name: 'Rock', cat: 'stone' }],
    values: { choc: 99, fruity: -1, gummy: 'x', hard: 1.3 },
    trades: [{ id: 'trade0001', a: 'goodkid01', b: 'ghostkid1', ga: {}, gb: {} }],
    buyback: { mode: 'gold', cents: 1e9, prize: '<b>A bike</b>', pieces: 0 },
  }).replace('"aside"', '"__proto__":{"polluted":true},"aside"'));
  const f = C.cleanFamily(raw);
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(f.kids.length, C.LIMITS.kids);
  const leo = f.kids[0];
  assert.deepStrictEqual(leo.counts, { pbcups: 3 }, 'unknown, negative, fractional, too-big and string counts dropped');
  assert.strictEqual(leo.name, 'Leo');
  assert.deepStrictEqual(leo.aside, ['pbcups']);
  assert.strictEqual(leo.plan.perDay, 2, 'an impossible plan falls back to 2 a day');
  assert.deepStrictEqual(leo.plan.days, [true, true, true, true, true, true, true]);
  assert.deepStrictEqual(leo.plan.eaten, { '2026-10-31': 2 });
  assert.strictEqual(f.kids[1].avatar, C.AVATARS[0][0], 'an unknown avatar becomes the first');
  assert.deepStrictEqual(f.custom.map((x) => x.id), ['xabcdefgh']);
  assert.deepStrictEqual(f.values, { choc: 3, fruity: 2, gummy: 2, hard: 1.5, full: 5, not: 0.5 });
  assert.deepStrictEqual(f.trades, [], 'a trade with a child who is not here is dropped');
  assert.deepStrictEqual(f.buyback, { mode: 'cents', cents: 10, prize: 'A bike', pieces: 30 });
  assert.deepStrictEqual(C.cleanFamily(null), C.emptyFamily());
  assert.deepStrictEqual(C.cleanFamily('nope'), C.emptyFamily());
  // What to call a child with no name: their costume, numbered when shared.
  const g = family([{ avatar: '👻' }, { avatar: '👻' }, { avatar: '🦖', name: 'Riley' }]);
  assert.deepStrictEqual(g.kids.map((k) => C.displayName(k, g.kids)), ['Ghost 1', 'Ghost 2', 'Riley']);
});

/* ================================================================== *
 * Counting
 * ================================================================== */

test('counting: +1 and -1, nothing below zero or above 999, undo puts it back exactly, the undo stack is bounded', () => {
  let f = family([{ counts: {} }]);
  const id = f.kids[0].id;
  let r = C.adjust(f, id, { pbcups: 1 });
  assert.deepStrictEqual(r.applied, { pbcups: 1 }); f = r.fam;
  r = C.adjust(f, id, { pbcups: 1 }); f = r.fam;
  assert.strictEqual(f.kids[0].counts.pbcups, 2);
  let stack = [];
  r = C.adjust(f, id, { lollipop: 1 }); f = r.fam; stack = C.pushUndo(stack, { kid: id, applied: r.applied });
  r = C.adjust(f, id, { pbcups: -1 }); f = r.fam; stack = C.pushUndo(stack, { kid: id, applied: r.applied });
  assert.deepStrictEqual(f.kids[0].counts, { pbcups: 1, lollipop: 1 });
  f = C.undoStep(f, stack.pop());
  f = C.undoStep(f, stack.pop());
  assert.deepStrictEqual(f.kids[0].counts, { pbcups: 2 }, 'two undos back to where it was');
  const zero = C.adjust(f, id, { twix: -1 });
  assert.deepStrictEqual(zero.applied, {}, 'a minus at zero applies nothing');
  assert.strictEqual(zero.fam, f, '...and changes nothing');
  stack = C.pushUndo([], { kid: id, applied: {} });
  assert.deepStrictEqual(stack, [], 'an empty step is not an undo step');
  r = C.adjust(f, id, { chocbar: 5000 });
  assert.strictEqual(r.fam.kids[0].counts.chocbar, C.LIMITS.perCandy);
  assert.deepStrictEqual(C.adjust(f, id, { evil: 3, __proto__: 1 }).applied, {}, 'unknown candy is never counted');
  assert.deepStrictEqual(C.adjust(f, 'nobody', { pbcups: 1 }).applied, {});
  for (let i = 0; i < 100; i++) stack = C.pushUndo(stack, { kid: id, applied: { pbcups: 1 } });
  assert.strictEqual(stack.length, C.LIMITS.undo);
  // The family object passed in is never changed.
  const before = JSON.stringify(f);
  C.adjust(f, id, { pbcups: 4 });
  assert.strictEqual(JSON.stringify(f), before, 'adjust is pure');
});

test('categories and totals: per category, eaten vs set aside vs not for eating; the bar adds up', () => {
  const f = family([{ counts: { pbcups: 4, chocbar: 6, skittles: 3, gummybears: 2, lollipop: 5, candycorn: 2, fullbar: 1, raisins: 2, pencil: 1, stickers: 2 }, aside: ['pbcups'] }]);
  const t = C.totals(f.kids[0], f);
  assert.deepStrictEqual(t.by, { choc: 10, fruity: 3, gummy: 2, hard: 7, full: 1, not: 5 });
  assert.deepStrictEqual([t.total, t.kinds, t.aside, t.nonFood, t.edible, t.full], [28, 10, 4, 3, 21, 1]);
  const bar = C.catBar(t);
  assert.deepStrictEqual(bar.map((b) => b.cat), C.CAT_IDS);
  assert.ok(Math.abs(bar.reduce((s, b) => s + b.pct, 0) - 100) < 0.5);
  assert.deepStrictEqual(C.top(f.kids[0], f, 3).map((x) => [x.id, x.n]), [['chocbar', 6], ['lollipop', 5], ['pbcups', 4]]);
  assert.strictEqual(C.rarest(f.kids[0], f).id, 'fullbar');
  const fam = C.familyKid(family([{ counts: { pbcups: 2 } }, { counts: { pbcups: 3, twix: 1 } }]));
  assert.deepStrictEqual(fam.counts, { pbcups: 5, twix: 1 });
});

test('titles: computed from the mix, fun and never mean', () => {
  const title = (counts) => { const f = family([{ counts }]); return C.titleFor(C.totals(f.kids[0], f)).title; };
  assert.strictEqual(title({ chocbar: 10, pbcups: 6, lollipop: 4 }), 'The Chocolate Baron');
  assert.strictEqual(title({ skittles: 8, warheads: 4, lollipop: 6, chocbar: 4 }), 'Sour Specialist');
  assert.strictEqual(title({ fullbar: 2, kingsize: 1, chocbar: 5, lollipop: 5 }), 'Full-Size Hunter');
  assert.strictEqual(title({ gummybears: 6, gummyworms: 4, chocbar: 5, lollipop: 6 }), 'Gummy Guru');
  assert.strictEqual(title({ lollipop: 8, candycorn: 6, chocbar: 4, skittles: 4 }), 'Lollipop Legend');
  assert.strictEqual(title({ stickers: 4, pencil: 3, chocbar: 6, lollipop: 6, skittles: 5 }), 'Treasure Collector');
  assert.strictEqual(title({ chocbar: 160, lollipop: 40, skittles: 100 }), 'Mega Hauler');
  assert.strictEqual(title({ chocbar: 2, lollipop: 2, skittles: 2, gummybears: 1 }), 'Small but Mighty');
  assert.strictEqual(title({}), 'Ready for the haul');
  const variety = {}; C.CANDY.filter((x) => x.cat !== 'full').slice(0, 16).forEach((x, i) => { variety[x.id] = 1 + (i % 2); });
  assert.ok(['Variety Champion', 'The Chocolate Baron', 'Sour Specialist'].includes(title(variety)));
  // Never mean: no title or line runs anyone's haul down.
  const all = [];
  for (let i = 0; i < 400; i++) {
    const counts = {}; C.CANDY.forEach((x, j) => { if ((i * 7 + j * 13) % 5 === 0) counts[x.id] = 1 + ((i + j) % 9); });
    const f = family([{ counts }]); const tt = C.titleFor(C.totals(f.kids[0], f)); all.push(`${tt.title} ${tt.line}`);
  }
  assert.ok(!/\b(only|poor|sad|loser|lame|worst|meh|tiny|pathetic|boring|small haul|not much|disappoint)/i.test(all.join(' ')), 'no mean words');
});

test('the haul card: total, full-size, top three, rarest, a title; names only when ticked, and on by default only if one was given', () => {
  const f = family([{ name: 'Leo', avatar: '🦖', counts: { chocbar: 9, lollipop: 7, pbcups: 6, kingsize: 1, raisins: 2 } }, { avatar: '👻', counts: { skittles: 6, warheads: 3 } }]);
  const [leo, ghost] = f.kids;
  assert.strictEqual(C.cardNamesDefault(f, leo.id), true);
  assert.strictEqual(C.cardNamesDefault(f, ghost.id), false, 'no name given, so off');
  assert.strictEqual(C.cardNamesDefault(f, 'family'), true);
  const on = C.cardData(f, leo.id, { names: true });
  assert.deepStrictEqual([on.kind, on.name, on.heading, on.total, on.full, on.kinds], ['kid', 'Leo', 'Leo’s haul', 25, 1, 5]);
  assert.deepStrictEqual(on.top.map((x) => x.id), ['chocbar', 'lollipop', 'pbcups']);
  assert.strictEqual(on.rarest.id, 'kingsize');
  assert.ok(on.title && on.line);
  const off = C.cardData(f, leo.id, { names: false });
  assert.ok(!JSON.stringify(off).includes('Leo'), 'names off: the name is nowhere in the card');
  assert.strictEqual(off.heading, 'My Halloween haul');
  const fam = C.cardData(f, 'family', { names: false });
  assert.strictEqual(fam.total, 34);
  assert.deepStrictEqual(fam.kids.map((k) => [k.name, k.total]), [['Dinosaur', 25], ['Ghost', 9]], 'names off: children are their costumes');
  assert.ok(!JSON.stringify(fam).includes('Leo'));
  assert.deepStrictEqual(C.cardData(f, 'family', { names: true }).kids.map((k) => k.name), ['Leo', 'Ghost']);
  assert.strictEqual(C.cardData(f, 'nobody', {}), null);
});

/* ================================================================== *
 * Fair trade
 * ================================================================== */

const twoKids = () => family([
  { id: 'leo0000001', name: 'Leo', avatar: '🦖', counts: { pbcups: 4, lollipop: 2, snickers: 2, fullbar: 1, candycorn: 5, raisins: 2 } },
  { id: 'maya000001', name: 'Maya', avatar: '🧙', counts: { lollipop: 8, skittles: 4, chocbar: 3, candycorn: 2, pbcups: 2 }, aside: ['pbcups', 'snickers'] },
]);

test('fair trade: the points, the plain words, the hint; a set-aside kind can be given away but never received', () => {
  const f = family([{ id: 'leo0000001', name: 'Leo', counts: { pbcups: 4, chocbar: 1, fullbar: 1, candycorn: 5, skittles: 2 } }, { id: 'maya000001', name: 'Maya', counts: { lollipop: 8, chocbar: 3 } }]);
  let r = C.tradeCheck(f, 'leo0000001', 'maya000001', { pbcups: 2 }, { lollipop: 6 });
  assert.deepStrictEqual([r.state, r.va, r.vb], ['fair', 6, 6]);
  assert.strictEqual(r.words, 'Leo’s 2 peanut butter cups for Maya’s 6 lollipops is fair.');
  r = C.tradeCheck(f, 'leo0000001', 'maya000001', { chocbar: 1 }, { lollipop: 2 });
  assert.deepStrictEqual([r.state, r.giver], ['leans', 'a']);
  assert.strictEqual(r.words, 'Leo’s 1 mini chocolate bar for Maya’s 2 lollipops: Leo gives a bit more.');
  assert.match(r.hint, /Maya could add 1 point - like 1 lollipop/);
  r = C.tradeCheck(f, 'leo0000001', 'maya000001', { fullbar: 1 }, { lollipop: 1 });
  assert.match(r.words, /Leo gives a lot more/);
  assert.match(r.hint, /Maya could add 4 points - like 4 lollipops|Maya could add 4 points - like/);
  r = C.tradeCheck(f, 'maya000001', 'leo0000001', { lollipop: 1 }, { fullbar: 1 });
  assert.match(r.hint, /Maya could add 4 points - like 1 mini chocolate bar|Maya could add 4 points/);
  r = C.tradeCheck(f, 'leo0000001', 'maya000001', {}, {});
  assert.deepStrictEqual([r.state, r.words], ['empty', 'Pick what Leo and Maya each offer.']);
  r = C.tradeCheck(f, 'leo0000001', 'maya000001', { pbcups: 1 }, {});
  assert.deepStrictEqual([r.state, r.words], ['half', 'Leo offers 1 peanut butter cup. What will Maya give?']);
  // Within 10% is fair; a 6 against a 5 is not.
  assert.strictEqual(C.tradeCheck(f, 'leo0000001', 'maya000001', { pbcups: 2 }, { lollipop: 5 }).state, 'leans');
  // Offers are clamped to what each child has.
  r = C.tradeCheck(f, 'leo0000001', 'maya000001', { pbcups: 40, nope: 2 }, { lollipop: 1 });
  assert.deepStrictEqual(r.ga, { pbcups: 4 });
  // Edited points change the verdict.
  const g = C.setValues(f, { choc: 1 });
  assert.strictEqual(C.tradeCheck(g, 'leo0000001', 'maya000001', { pbcups: 2 }, { lollipop: 2 }).state, 'fair');
  // Set aside: Maya can trade her own set-aside peanut butter cups away...
  const t = twoKids();
  r = C.tradeCheck(t, 'maya000001', 'leo0000001', { pbcups: 2 }, { lollipop: 2, candycorn: 4 });
  assert.strictEqual(r.state, 'fair', r.words);
  // ...but nobody can hand Maya something she sets aside.
  r = C.tradeCheck(t, 'leo0000001', 'maya000001', { snickers: 1 }, { lollipop: 3 });
  assert.deepStrictEqual([r.state, r.words], ['blocked', 'Maya sets Snickers aside - pick something else.']);
  // ...and the hint never suggests one.
  r = C.tradeCheck(t, 'maya000001', 'leo0000001', { chocbar: 3 }, { candycorn: 1 });
  assert.ok(!/Snickers|peanut butter/.test(r.hint), r.hint);
});

test('the swap moves the pieces both ways, keeps the totals, logs the words, and undoes only the latest while the pieces are still there', () => {
  let f = twoKids();
  const sum = (g) => g.kids.reduce((s, k) => s + C.totals(k, g).total, 0);
  const before = sum(f);
  assert.strictEqual(C.applyTrade(f, 'leo0000001', 'maya000001', {}, {}, 1, 'trade00001'), null, 'nothing offered: no swap');
  assert.strictEqual(C.applyTrade(f, 'leo0000001', 'maya000001', { snickers: 1 }, { lollipop: 3 }, 1, 'trade00001'), null, 'blocked: no swap');
  assert.strictEqual(C.applyTrade(f, 'leo0000001', 'leo0000001', { pbcups: 1 }, { pbcups: 1 }, 1, 'trade00001'), null, 'not with yourself');
  const r = C.applyTrade(f, 'maya000001', 'leo0000001', { pbcups: 2 }, { lollipop: 2, candycorn: 4 }, Date.parse('2026-10-31T20:00:00Z'), 'trade00001');
  f = r.fam;
  assert.deepStrictEqual(f.kids[1].counts, { lollipop: 10, skittles: 4, chocbar: 3, candycorn: 6 }, 'Maya gave her set-aside cups away');
  assert.deepStrictEqual(f.kids[0].counts, { pbcups: 6, snickers: 2, fullbar: 1, candycorn: 1, raisins: 2 });
  assert.strictEqual(sum(f), before, 'no candy appears or vanishes');
  assert.deepStrictEqual([f.trades.length, f.trades[0].fair, f.trades[0].words], [1, true, 'Maya’s 2 peanut butter cups for Leo’s 4 candy corn and 2 lollipops is fair.']);
  // A gift (unfair, both agree) is allowed and logged as not fair.
  const gift = C.applyTrade(f, 'leo0000001', 'maya000001', { fullbar: 1 }, { candycorn: 1 }, 2, 'trade00002');
  assert.ok(gift && gift.trade.fair === false);
  assert.strictEqual(C.undoTrade(gift.fam, 'trade00001'), null, 'only the latest can be undone');
  const back = C.undoTrade(gift.fam, 'trade00002');
  assert.deepStrictEqual(back.kids.map((k) => k.counts), f.kids.map((k) => k.counts));
  // Undo refused once the pieces have moved on (Maya ate the full-size bar).
  const ate = C.adjust(gift.fam, 'maya000001', { fullbar: -1 }).fam;
  assert.strictEqual(C.undoTrade(ate, 'trade00002'), null);
  let many = f;
  for (let i = 0; i < 80; i++) many = C.applyTrade(many, 'leo0000001', 'maya000001', { candycorn: 1 }, { candycorn: 1 }, i, `trade1${String(i).padStart(4, '0')}`).fam;
  assert.strictEqual(many.trades.length, C.LIMITS.trades, 'the log is bounded');
});

/* ================================================================== *
 * Make it last
 * ================================================================== */

test('the ration plan with a fixed clock: when the stash runs out, today\u2019s pieces, which days, set-aside and non-food left out', () => {
  assert.strictEqual(C.dayLabel(C.dayNum('2026-10-31')), 'Sat Oct 31');
  assert.strictEqual(C.weekdayOf(C.dayNum('2026-10-31')), 6);
  assert.strictEqual(C.dayNum('2026-02-30'), null);
  assert.strictEqual(C.dayNum('31/10/2026'), null);
  // 46 pieces at 2 a day from Sat Oct 31: 23 days, the last Sun Nov 22.
  const counts = { chocbar: 20, lollipop: 20, skittles: 6, pencil: 3, pbcups: 4 };
  let f = family([{ counts, aside: ['pbcups'] }]);
  let k = f.kids[0];
  let p = C.plan(k, f, TODAY);
  assert.deepStrictEqual([p.edible, p.aside, p.nonFood], [46, 4, 3], 'set-aside and pencils are not rationed');
  assert.strictEqual(p.words, 'The stash lasts until Sun Nov 22');
  assert.deepStrictEqual([p.lastDay, p.candyDays, p.leftToday], ['2026-11-22', 23, 2]);
  assert.strictEqual(p.todayWords, 'Today: 2 pieces - 2 left today');
  assert.deepStrictEqual(p.upcoming.map((u) => [u.label, u.n]), [['Sat', 2], ['Sun', 2], ['Mon', 2], ['Tue', 2], ['Wed', 2], ['Thu', 2], ['Fri', 2]]);
  // Eat one: today's count moves and the end date holds.
  f = C.eatOne(f, k.id, 'chocbar', TODAY);
  k = f.kids[0];
  p = C.plan(k, f, TODAY);
  assert.deepStrictEqual([p.edible, p.eatenToday, p.leftToday, p.todayWords], [45, 1, 1, 'Today: 2 pieces - 1 left today']);
  assert.strictEqual(p.lastDay, '2026-11-22');
  f = C.eatOne(f, k.id, 'lollipop', TODAY);
  p = C.plan(f.kids[0], f, TODAY);
  assert.deepStrictEqual([p.leftToday, p.over], [0, true]);
  assert.strictEqual(p.upcoming[0].n, 0);
  // A third today (a grown-up said yes) is allowed and counted; the plan holds.
  f = C.eatOne(f, k.id, 'lollipop', TODAY);
  assert.strictEqual(f.kids[0].plan.eaten[TODAY], 3);
  f = C.uneat(f, k.id, 'lollipop', TODAY);
  assert.deepStrictEqual([f.kids[0].plan.eaten[TODAY], f.kids[0].counts.lollipop], [2, 19]);
  // Not eaten: set aside, a pencil, nothing left, or a bad day.
  assert.strictEqual(C.eatOne(f, k.id, 'pbcups', TODAY), null, 'set aside is never eaten from the plan');
  assert.strictEqual(C.eatOne(f, k.id, 'pencil', TODAY), null);
  assert.strictEqual(C.eatOne(f, k.id, 'twix', TODAY), null);
  assert.strictEqual(C.eatOne(f, k.id, 'chocbar', 'yesterday'), null);
  // Weekends only, 3 a day, 10 pieces from Sat Oct 31: Sat 3, Sun 3, Sat 3, Sun 1 -> Sun Nov 8.
  let w = family([{ counts: { chocbar: 10 } }]);
  w = C.setPlan(w, w.kids[0].id, { perDay: 3, days: [true, false, false, false, false, false, true] });
  p = C.plan(w.kids[0], w, TODAY);
  assert.deepStrictEqual([p.words, p.candyDays], ['The stash lasts until Sun Nov 8', 4]);
  assert.deepStrictEqual(p.upcoming.map((u) => u.n), [3, 3, 0, 0, 0, 0, 0]);
  p = C.plan(w.kids[0], w, '2026-11-02');
  assert.strictEqual(p.todayWords, 'Today is a day off from the stash.');
  // No plan, and an empty stash.
  w = C.setPlan(w, w.kids[0].id, { perDay: 0 });
  assert.strictEqual(C.plan(w.kids[0], w, TODAY).words, 'Pick at least one piece a day and one day of the week.');
  const empty = family([{ counts: {} }]);
  assert.strictEqual(C.plan(empty.kids[0], empty, TODAY).words, 'The stash is all gone. What a Halloween!');
  const aside = family([{ counts: { pbcups: 3, pencil: 1 }, aside: ['pbcups'] }]);
  assert.match(C.plan(aside.kids[0], aside, TODAY).words, /set aside or not for eating/);
  // Across a month end and a clock change (US clocks go back on Nov 1): days, not hours.
  const big = family([{ counts: { chocbar: 200 } }]);
  assert.strictEqual(C.plan(big.kids[0], big, '2026-10-31').lastDay, '2027-02-07', '100 days from Oct 31');
});

test('buyback ("Switch Witch") sums: cents or a prize, and the lowest-points pieces go first - favourites, set-aside and non-food stay', () => {
  assert.deepStrictEqual([C.money(0), C.money(60), C.money(150), C.money(2000)], ['0¢', '60¢', '$1.50', '$20.00']);
  let f = family([{ counts: { candycorn: 4, raisins: 2, lollipop: 3, chocbar: 5, fullbar: 1, pencil: 2, pbcups: 3 }, aside: ['pbcups'] }]);
  assert.strictEqual(C.buybackWords(f.buyback, 20), 'Trading in 20 pieces is worth $2.00.');
  assert.strictEqual(C.buybackWords(C.setBuyback(f, { cents: 5 }).buyback, 1), 'Trading in 1 piece is worth 5¢.');
  const prize = C.setBuyback(f, { mode: 'prize', prize: 'a new book', pieces: 30 }).buyback;
  assert.strictEqual(C.buybackWords(prize, 12), '12 of 30 pieces for a new book - 18 to go.');
  assert.strictEqual(C.buybackWords(prize, 30), '30 pieces - enough for a new book!');
  const k = f.kids[0];
  assert.deepStrictEqual(C.tradeInPick(k, f, 8), { raisins: 2, candycorn: 4, lollipop: 2 }, 'raisins (0.5), then hard candy (1), most plentiful first');
  assert.deepStrictEqual(C.tradeInPick(k, f, 100), { raisins: 2, candycorn: 4, lollipop: 3, chocbar: 5, fullbar: 1 }, 'never the pencil or the set-aside cups');
  const r = C.tradeIn(f, k.id, 6);
  assert.deepStrictEqual([r.n, r.removed], [6, { raisins: 2, candycorn: 4 }]);
  assert.strictEqual(r.fam.kids[0].tradedIn, 6);
  f = C.giveBack(r.fam, k.id, r.removed, 'tradedIn');
  assert.deepStrictEqual([f.kids[0].counts.candycorn, f.kids[0].counts.raisins, f.kids[0].tradedIn], [4, 2, 0], 'undo puts them back');
  assert.strictEqual(C.tradeIn(family([{ counts: { pencil: 2 } }]), 'kid0aaaa', 3), null);
});

test('set aside: the family\u2019s own flags per child, copied to everyone on request, handed to a grown-up and back', () => {
  let f = family([{ counts: { pbcups: 3, snickers: 2, lollipop: 4 } }, { counts: { pbcups: 1 } }]);
  const [a, b] = f.kids.map((k) => k.id);
  f = C.toggleAside(f, a, 'pbcups'); f = C.toggleAside(f, a, 'snickers');
  assert.deepStrictEqual(f.kids[0].aside, ['pbcups', 'snickers']);
  assert.deepStrictEqual(f.kids[1].aside, [], 'per child');
  f = C.toggleAside(f, a, 'snickers');
  assert.deepStrictEqual(f.kids[0].aside, ['pbcups']);
  assert.strictEqual(C.toggleAside(f, a, 'nope'), f);
  const all = C.asideForAll(f, a);
  assert.deepStrictEqual(all.kids.map((k) => k.aside), [['pbcups'], ['pbcups']]);
  assert.deepStrictEqual(C.asidePile(f.kids[0], f).map((r) => [r.id, r.n]), [['pbcups', 3]]);
  const h = C.handOver(f, a);
  assert.deepStrictEqual([h.n, h.fam.kids[0].counts.pbcups, h.fam.kids[0].handed], [3, undefined, 3]);
  assert.strictEqual(C.handOver(h.fam, a), null, 'nothing left to hand over');
  const back = C.giveBack(h.fam, a, h.removed, 'handed');
  assert.deepStrictEqual([back.kids[0].counts.pbcups, back.kids[0].handed], [3, 0]);
  // Haul makes no allergen claims of its own: no ingredient words in the candy data.
  assert.ok(!/peanut-free|nut-free|gluten|dairy|contains|allergen|safe for/i.test(JSON.stringify(C.CANDY)), 'no allergen data');
});

/* ================================================================== *
 * The photo count: what is sent, and what is accepted back
 * ================================================================== */

test('the photo request carries one image and nothing else; the answer is cleaned - known ids, whole counts within the caps, plain "Other" names', () => {
  const img = { type: 'image/jpeg', data: jpeg(1200, 900).toString('base64') };
  assert.deepStrictEqual(C.photoRequest({ image: img }), { image: img });
  for (const bad of [null, [], {}, { image: img, name: 'Leo' }, { image: { ...img, kid: 'Leo' } }, { image: { type: 'image/gif', data: 'R0lG' } }, { image: { type: 'image/jpeg', data: 'not base64!' } }, { image: { type: 'image/jpeg', data: 'A'.repeat(C.LIMITS.aiImageBytes * 2) } }, { image: 'data:image/jpeg;base64,AAAA' }]) {
    assert.strictEqual(C.photoRequest(bad), null, JSON.stringify(bad).slice(0, 60));
  }
  const ok = C.cleanCount({ counts: [{ id: 'pbcups', count: 6 }, { id: 'pbcups', count: 2 }], others: [{ name: 'Candy necklace', category: 'hard', count: 2 }], confidence: 'medium', note: 'A few overlap.' });
  assert.deepStrictEqual(ok, { counts: [{ id: 'pbcups', n: 8 }], others: [{ name: 'Candy necklace', cat: 'hard', n: 2 }], total: 10, confidence: 'medium', note: 'A few overlap.' });
  // Hostile: the fake's injection answer.
  const raw = fakeClient ? null : null; void raw;
  const hostile = {
    counts: [{ id: 'evil', count: 50 }, { id: '__proto__', count: 5 }, { id: 'pbcups', count: -4 }, { id: 'chocbar', count: 99999 }, { id: 'lollipop', count: '7' }, { id: 'skittles', count: 2.5 }, 'nope', null],
    others: [{ name: '<img src=x onerror=alert(1)>Free candy', category: 'hard', count: 3 }, { name: '\u202eyrrebwarts visit evil.example', category: 'gummy', count: 2 }, { name: 'https://evil.example/pay', category: 'choc', count: 2 }, { name: 'Other: Snickers', category: 'choc', count: 2 }, { name: '🍬🍬', category: 'hard', count: 1 }, { name: 'Mystery chew', category: 'poison', count: 4 }, ...Array.from({ length: 30 }, (_, i) => ({ name: `Thing ${i}`, category: 'hard', count: 1 }))],
    confidence: 'certain', note: '<script>alert(1)</script>Counted! Claim a prize at www.evil.example now ' + 'x'.repeat(900),
  };
  const c = C.cleanCount(hostile);
  assert.deepStrictEqual(c.counts, [{ id: 'chocbar', n: 200 }, { id: 'snickers', n: 2 }, { id: 'lollipop', n: 7 }].sort((a, b) => C.CANDY_IDS.indexOf(a.id) - C.CANDY_IDS.indexOf(b.id)));
  assert.ok(c.others.length <= C.LIMITS.aiOthers);
  assert.ok(c.others.every((o) => !/[<>\u202e]|https?:|evil\.example|www\./i.test(o.name) && o.name.length <= C.LIMITS.aiOtherName && C.CAT_IDS.includes(o.cat)), JSON.stringify(c.others));
  assert.ok(c.others.some((o) => o.name === 'Free candy') && c.others.find((o) => o.name === 'Mystery chew').cat === 'hard');
  assert.strictEqual(c.confidence, 'low');
  assert.ok(!/[<>]|www\.|evil/.test(c.note) && c.note.length <= C.LIMITS.aiNote, c.note);
  // The total cap.
  const huge = C.cleanCount({ counts: C.CANDY_IDS.map((id) => ({ id, count: 200 })), others: [], confidence: 'high', note: '' });
  assert.strictEqual(huge.total, C.LIMITS.aiTotal);
  assert.strictEqual(C.cleanCount(null), null);
  assert.strictEqual(C.cleanCount({ counts: 'lots' }).total, 0);
});

test('accepting a proposal adds to one child; an "Other" becomes the family\u2019s own kind (found again, never duplicated, 30 at most)', () => {
  let f = family([{ counts: { pbcups: 1 } }]);
  const id = f.kids[0].id;
  let r = C.applyProposal(f, id, [{ id: 'pbcups', n: 5 }, { other: true, name: 'Candy necklace', cat: 'hard', n: 2 }, { id: 'nope', n: 3 }, { id: 'twix', n: 0 }], newId);
  f = r.fam;
  assert.strictEqual(f.kids[0].counts.pbcups, 6);
  assert.strictEqual(f.custom.length, 1);
  assert.strictEqual(f.kids[0].counts[f.custom[0].id], 2);
  r = C.applyProposal(f, id, [{ other: true, name: 'candy NECKLACE', cat: 'hard', n: 1 }], newId);
  assert.strictEqual(r.fam.custom.length, 1, 'found again by name and group');
  assert.strictEqual(r.fam.kids[0].counts[f.custom[0].id], 3);
  let g = family([{ counts: {} }]);
  for (let i = 0; i < 35; i++) g = C.applyProposal(g, g.kids[0].id, [{ other: true, name: `Kind ${i}`, cat: 'gummy', n: 1 }], newId).fam;
  assert.strictEqual(g.custom.length, C.LIMITS.custom);
  assert.strictEqual(C.applyProposal(g, g.kids[0].id, [{ other: true, name: 'One more', cat: 'gummy', n: 4 }], newId).skipped, 4);
});

test('the made-up sample haul for "Try it": two children, a set-aside example, and no clock or dice anywhere in the rules', () => {
  const s = C.sample();
  assert.deepStrictEqual(s.kids.map((k) => k.name), ['Leo', 'Maya']);
  assert.ok(s.kids.every((k) => C.totals(k, s).total > 40));
  assert.deepStrictEqual(s.kids[1].aside, ['pbcups', 'snickers']);
  assert.strictEqual(C.tradeCheck(s, 'samplemaya', 'sampleleo', { pbcups: 2 }, { lollipop: 6 }).state, 'fair', 'the classic swap works in the sample');
  const core = read('public/haul-core.js');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.|indexedDB|WebSocket/.test(core), 'the core touches no network or storage');
});

/* ================================================================== *
 * The page's own promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the hero, the card and the lab card too; 44px targets; nothing scrolls sideways', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'bar-bg', 'face']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    ok('accent-ink', 'accent'); for (const fg of ['text', 'link', 'muted']) ok(fg, 'accent-soft');
    for (const k of ['ok', 'warn', 'bad', 'teal', 'violet']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok('muted', `${k}-bg`); for (const bg of ['card', 'face', 'bg']) ok(k, bg); }
    ok('link', 'warn-bg'); ok('link', 'card2');
    for (const fg of ['hero-ink', 'hero-soft']) for (const bg of ['hero-1', 'hero-2']) ok(fg, bg);
    ok('bg', 'text');
    ok('accent', 'track', 2.2);
    for (const c of C.CAT_IDS) ok(`c-${c}`, 'card', 3);
  }
  // Colours written as literals: the hero's white buttons, the card preview and the drawn card.
  for (const [fg, bg] of [['#8d2f08', '#ffffff'], ['#ffffff', '#3a0d63'], ['#ffffff', '#8d2f08'], ['#ffb35c', '#2a0b4c'], ['#ffe2c9', '#2a0b4c'], ['#ffb35c', '#140726'], ['#ffe2c9', '#3a0d63'], ['#ffb35c', '#3a0d63'], ['#ffffff', '#1f0a3a']]) {
    assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  }
  const lab = require('../../../lab').get('haul');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.btn.small', '.link-btn', '.seg button, .chip', '.input, select.input, textarea.input', '.check', '.tile-minus', '.offer-minus', '.days button', '.eat-grid button', '.aside-grid button', '.ochip', '.avatars button', '.kids button', '.toast button', '.stepper button', 'input[type="range"]']) {
    assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|[5-9]\\d|1\\d\\d)px').test(css), `${sel}: 44px`);
  }
  assert.ok(/\.tile-main \{[^}]*min-height: 104px/.test(css), 'candy tiles are big enough for small fingers');
  assert.ok(/\.btn\.big \{[^}]*min-height: 58px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/prefers-reduced-motion: reduce[\s\S]*animation: none !important; transition: none !important/.test(css), 'reduced motion stops the bobbing pumpkin, the bat and the confetti');
  assert.ok(/@keyframes bob/.test(css) && /@keyframes fly/.test(css) && /@keyframes flap/.test(css), 'the hero moves by CSS alone');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, the photo shrunk on the device, every typed or received string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  assert.ok(!/https?:\/\/(?!challenge\.strongtechnicalconsulting\.com)/.test(html.replace(/<!-- lab:og[\s\S]*?<!-- \/lab:og -->/, '')), 'no third-party script, font or image');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|document\.cookie|indexedDB/.test(js));
  assert.ok(/redraw\(img, 1200, 0\.82\)/.test(js), 'the photo is redrawn at 1200 px through a canvas (EXIF and location dropped)');
  assert.match(js, /this one photo, shrunk on this phone and with its location removed\. Nothing else - not /);
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/count', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/me'].sort(), 'the page asks for nothing else - no route takes the haul');
  assert.match(js, /api\('POST', 'api\/ai\/count', \{ image: \{ type: 'image\/jpeg', data: state\.photo\.data \} \}\)/, 'the count sends the photo and nothing else');
  assert.match(js, /Nothing changes until you tap Add/);
  assert.match(js, /navigator\.share\(\{ files: \[file\]/, 'the card is shared as a file');
  assert.ok(!/upload|XMLHttpRequest/.test(js.replace(/never uploaded|it’s never uploaded|Nothing is uploaded|never uploaded anywhere/gi, '')), 'the card is never uploaded');
  for (const f of ['public/index.html', 'public/app.js', 'public/haul-core.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'lib/image.js', 'CLAUDE.md']) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  const core = read('public/haul-core.js');
  assert.ok(!/\(\?<[=!]/.test(core + js), 'no lookbehind (older iPhones cannot parse it)');
  assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(core + js), 'no invisible characters of their own');
  // Every interpolation of something a person, the server or a model wrote goes through esc().
  const unesc = (src) => { let out = '', i = 0; for (;;) { const at = src.indexOf('esc(', i); if (at < 0) return out + src.slice(i); out += src.slice(i, at) + 'ESC'; let depth = 0, j = at + 3; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; } };
  const risky = unesc(js).split('\n').filter((l) => !/toast\(|say\(|confirm\(|textContent|fillText|fit\(g|wrap\(g|shrink\(g|setAttribute\('aria-label'/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(nameOf\([^)]*\)|k\.name|kid\.name|cd\.name|cd\.one|cd\.emoji|x\.name|x\.emoji|r\.name|r\.emoji|label|emo|d\.heading|d\.title|d\.line|d\.avatar|k\.avatar|kid\.avatar|pr\.note|pr\.confidence|chk\.words|chk\.hint|x\.words|p\.words|p\.todayWords|err\.message|e\.message|me\.email|b\.prize|state\.q)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbody\b|\bimage\b|\bdata\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js') + read('lib/ai.js')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /haul-shell-v1/.test(sw) && sw.includes("'haul-core.js'"), 'the service worker never answers api/');
});

test('the copy: neutral wording (no he/she/his/her), no health claims, no allergen claims, and the label line is there', () => {
  const strings = (src) => [...src.matchAll(/'([^'\\\n]|\\.){3,}'|`[^`]{3,}`|"[^"\n]{3,}"/g)].map((m) => m[0]).join('\n');
  const all = strings(read('public/app.js')) + strings(read('public/haul-core.js')) + read('public/index.html') + strings(read('server.js')) + strings(read('lib/ai.js'));
  const gendered = all.match(/\b(he|she|his|hers|him|himself|herself)\b|\bher\b/gi);
  assert.strictEqual(gendered, null, `gendered: ${gendered}`);
  assert.ok(!/\b(healthy|unhealthy|sugar rush|cavities|calories|diabetes|obes|junk food|bad for you|good for you)\b/i.test(all), 'no health claims');
  assert.ok(!/contains (peanuts|nuts|milk|gluten)|nut-free|peanut-free|allergy-safe|safe for allergies/i.test(all), 'no allergen claims');
  assert.match(all, /Always read the label - recipes and sizes change\./);
  assert.match(all, /teal pumpkin/i);
});

test('local-only switches throw on Cloud Run; the lab prefix is read; there is no app collection', () => {
  for (const [mod, env] of [['./lib/store', { HAUL_MEMORY: '1' }], ['./lib/fakeai', { HAUL_FAKE_AI: '1' }], ['./server', { HAUL_FAKE_AI: '1', HAUL_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, HAUL_MEMORY: '', HAUL_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.MEMORY)"], { cwd: ROOT, env: { ...process.env, HAUL_MEMORY: '', HAUL_COLLECTION_PREFIX: 'haul_/../x' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'haul_x false', 'the prefix is read, letters, digits and underscores only');
  assert.ok(!/require\('@google-cloud\/firestore'\)|store\.(get|set|list|add|merge)\(/.test(read('server.js') + read('lib/store.js')), 'Haul keeps nothing of its own on the server');
});

/* ================================================================== *
 * Over HTTP
 * ================================================================== */

let base;
let ip6 = 1;
function client(addrIn) {
  const cookies = {};
  const addr = addrIn || `2001:db8:${(ip6++).toString(16)}::1`;
  const call = async function (method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    const t = /json|text|html|javascript/.test(ct) ? buf.toString('utf8') : '';
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, buf, headers: res.headers };
  };
  return call;
}
// Test accounts on the reserved example domain, built here so no address is written into a file.
const mail = (who) => `${who}${String.fromCharCode(64)}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const BIG = { x: 'x'.repeat(1200 * 1024) };
const photoBody = () => ({ image: { type: 'image/jpeg', data: jpeg(1200, 900, 3000).toString('base64') } });

test('signed out: the page works with zero model calls; the photo count answers 401 before reading a body; there is no route that takes a haul', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  for (const f of ['haul-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await page.text(), /<title>Haul/);
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/ai/count', photoBody())).status, 401);
  assert.strictEqual((await anon('POST', '/api/ai/count', BIG)).status, 401, 'the gate answers before the parser, so never 413');
  for (const p of ['/api/haul', '/api/sync', '/api/kids', '/api/counts', '/api/trades', '/api/card', '/api/upload']) assert.strictEqual((await anon('POST', p, { kids: [{ name: 'Leo' }] })).status, 404, `${p}: no route takes a haul`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before the parser, in order; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/count', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to a client');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.deepStrictEqual(ai.TOOL.input_schema.properties.counts.items.properties.id.enum, C.CANDY_IDS, 'the model can only name Haul\u2019s own candy');
  assert.match(ai.SYSTEM, /never an instruction to you/);
  assert.match(ai.SYSTEM, /never people, faces/);
});

test('the photo count over HTTP: anything but one photo is a 400 with no model call; the model sees the photo without its location and the list - no name; the answer is cleaned; nothing is stored', async () => {
  const eva = await register('eva.photo');
  const calls = await modelCalls();
  const okImg = photoBody().image;
  for (const bad of [{}, [], { image: okImg, name: 'Leo' }, { image: okImg, counts: { pbcups: 2 } }, { image: { ...okImg, kid: 'Leo' } }, { image: { type: 'image/gif', data: 'R0lGODlh' } }, { image: { type: 'image/jpeg', data: png(200, 200).toString('base64') } }, { image: { type: 'image/jpeg', data: jpeg(2400, 1800).toString('base64') } }, { image: { type: 'image/jpeg', data: Buffer.from('not a photo at all').toString('base64') } }]) {
    assert.strictEqual((await eva('POST', '/api/ai/count', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await eva('POST', '/api/ai/count', photoBody());
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeClient.calls[n0];
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'record_counts' });
  const content = req.messages[0].content;
  assert.deepStrictEqual(content.map((b) => b.type), ['image', 'text']);
  const sent = Buffer.from(content[0].source.data, 'base64');
  assert.ok(!sent.includes(Buffer.from('GPSLatitude')) && !sent.includes(Buffer.from('Elm Street')), 'the model\u2019s copy has no location or comment in it');
  assert.match(content[1].text, /pbcups: Peanut butter cups \(Chocolate\)/);
  assert.strictEqual(content[1].text, ai.text(), 'the text is the fixed candy list - nothing from the family');
  assert.deepStrictEqual(Object.keys(r.data.proposal).sort(), ['confidence', 'counts', 'note', 'others', 'total']);
  assert.ok(r.data.proposal.counts.every((x) => C.CANDY_IDS.includes(x.id) && Number.isInteger(x.n)));
  assert.deepStrictEqual(r.data.proposal.others, [{ name: 'Candy necklace', cat: 'hard', n: 2 }]);
  assert.strictEqual((await eva('POST', '/api/ai/count', { image: { type: 'image/png', data: png(800, 600).toString('base64') } })).status, 200, 'a PNG by its bytes is fine');
  // Hostile output.
  fakeClient.mode = 'inject';
  const inj = await eva('POST', '/api/ai/count', photoBody());
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]|\u202e|javascript:|https?:|www\.|evil\.example/i.test(inj.text), inj.text.slice(0, 300));
  const p = inj.data.proposal;
  assert.ok(p.counts.every((x) => C.CANDY_IDS.includes(x.id) && x.n >= 1 && x.n <= C.LIMITS.aiPerCandy) && p.total <= C.LIMITS.aiTotal && p.others.length <= C.LIMITS.aiOthers && p.confidence === 'low' && !('extra' in p));
  fakeClient.mode = 'blank';
  assert.strictEqual((await eva('POST', '/api/ai/count', photoBody())).status, 422);
  fakeClient.mode = 'maxtokens';
  assert.match((await eva('POST', '/api/ai/count', photoBody())).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await eva('POST', '/api/ai/count', photoBody());
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await eva('POST', '/api/ai/count', photoBody());
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  const dump = identityStore._dump();
  assert.ok(!dump.includes('Candy necklace') && !dump.includes(okImg.data.slice(40, 120)), 'no count and no photo stored');
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const una = await register('una.unconfirmed');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await una('POST', '/api/ai/count', photoBody());
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/haul/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await una('POST', '/api/ai/count', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/count', photoBody())).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/count', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-haul-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/count', photoBody());
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/count', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-haul-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/haul', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/haul`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
