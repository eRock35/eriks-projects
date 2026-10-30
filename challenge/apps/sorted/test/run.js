// Pure rules first (the emoji, cleaning, money, the deck and undo, sprints,
// the tally, the piles, the Maybe box and its .ics, up-for-grabs payloads,
// the estimate's payload and answer, thumbnails by their bytes), then the
// page's own promises, then end to end against the memory store and the fake
// model:
//   SORTED_MEMORY=1 SORTED_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /sorted, the way
// the lab mounts it, so the auth cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every name and thing here is made up.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.SORTED_MEMORY !== '1' || process.env.SORTED_FAKE_AI !== '1') {
  console.error('run with SORTED_MEMORY=1 SORTED_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient, LIMITS } = require('../server');
const C = require('../public/sorted-core');
const G = require('../lib/grabs');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TODAY = '2026-10-30';
const NOW = Date.parse('2026-10-30T15:00:00Z');
const O = { nowMs: NOW, today: TODAY };

/* ---------------- helpers ---------------- */

let n = 0;
function item(name, extra) { return C.cleanItem(Object.assign({ id: `t${++n}`, name, room: 'closet', createdAt: NOW - 100000 + n }, extra || {}), O); }
function decided(name, decision, day, extra) { return item(name, Object.assign({ decision, decidedAt: NOW, decidedDay: day || TODAY }, extra || {})); }

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
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude 51.5074 GPSLongitude -0.1278', 'latin1')),
    seg(0xfe, Buffer.from('taken at 12 Acacia Avenue', 'latin1')),
    seg(0xc0, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])),
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(pad || 200, 0x55), Buffer.from([0xff, 0xd9]),
  ]);
}
/** A small PNG with a text chunk, w x h. */
function png(w, h) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0GPS 51.5 home address', 'latin1')), chunk('IDAT', Buffer.alloc(40, 1)), chunk('IEND', Buffer.alloc(0))]);
}

/* ================================================================== *
 * The emoji, text and money
 * ================================================================== */

test('the emoji: about eighty household pictures, each with a kind; a name finds its head noun, phrases first, containers defer to what they hold', () => {
  assert.ok(C.EMOJI.length >= 78 && C.EMOJI.length <= 90, `${C.EMOJI.length} emoji`);
  assert.strictEqual(new Set(C.EMOJI.map((e) => e[0])).size, C.EMOJI.length, 'no emoji twice');
  for (const [e, label, kind, words] of C.EMOJI) {
    assert.ok(label && kind && words.split(',').length >= 1, e);
    assert.ok(!/\u200d/.test(e), `${e}: no joined sequences`);
  }
  const cases = {
    'running shoes': '👟', 'Winter coat': '🧥', 'box of cables': '🔌', 'Lego Duplo box': '🧱', 'Train set': '🧸', 'sleeping bag': '⛺', 'school bag': '🎒',
    'bag of socks': '🧦', Bag: '👜', 'wine glasses': '🥂', 'tins of paint': '🎨', iPad: '📱', 'Mixing bowls': '🥣', 'T-shirt': '👕', 'hiking boots': '🥾',
    'old bike helmet': '🚲', 'Kids books': '📚', 'Stack of magazines': '📰', 'baby clothes': '👶', 'something odd': '📦', '': '📦',
  };
  for (const [name, e] of Object.entries(cases)) assert.strictEqual(C.emojiFor(name), e, name);
  assert.strictEqual(C.guessEmoji('zzz qqq'), null);
  assert.strictEqual(C.emojiOf('🛋'), '🛋️', 'a missing variation selector is accepted');
  assert.strictEqual(C.emojiOf('🎃'), null, 'nothing outside the set');
  assert.strictEqual(C.kindOf('🔋'), 'hazard');
  assert.strictEqual(C.kindOf('👗'), 'clothes');
});

test('text: one plain line, invisible and bidi characters removed, markup stripped where others read it, cut on a whole character; escaping covers quotes', () => {
  assert.strictEqual(C.line('  a\n\tb\u202Ec\u200Bd  ', 60), 'a bcd');
  assert.strictEqual(C.line('😀'.repeat(70), 60), '😀'.repeat(60));
  assert.strictEqual(C.plain('<img src=x onerror=alert(1)>Sam <b>J</b>', 30), 'Sam J');
  assert.strictEqual(C.plain('a < b', 30), 'a b');
  assert.strictEqual(C.plain('x'.repeat(100000), 30).length, 30);
  assert.strictEqual(C.esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  assert.strictEqual(C.cleanName('<b>Sam</b>'), 'Sam');
  assert.strictEqual(C.cleanName('\u202eSam\u2066'), 'Sam');
  assert.strictEqual(C.cleanName('🎉🎉'), '', 'a name needs a letter or a digit');
  assert.strictEqual(C.cleanName('   '), '');
  assert.strictEqual(C.cleanName('Zoë-Anne O’Brien the Third of Many Names'), 'Zoë-Anne O’Brien the Third of'.slice(0, 30).trim());
  assert.strictEqual(C.plainOut('Visit https://evil.example/x or www.evil.example and evil.example now', 200), 'Visit or and now');
});

test('money: whole cents in the person\u2019s currency; "free" and a negative are no price; the locale picks the currency', () => {
  assert.strictEqual(C.readMoney('$1,240.50'), 124050);
  assert.strictEqual(C.readMoney('12,50'), 1250);
  assert.strictEqual(C.readMoney('12'), 1200);
  assert.strictEqual(C.readMoney('£5'), 500);
  for (const v of ['free', '', '-4', '(12.00)', 'lots', '12.345', null, undefined, '99999999999']) assert.strictEqual(C.readMoney(v), null, String(v));
  assert.strictEqual(C.money(8500, 'USD', 'en-US'), '$85');
  assert.strictEqual(C.money(1250, 'GBP', 'en-GB'), '£12.50');
  assert.strictEqual(C.currencyFor('en-GB'), 'GBP');
  assert.strictEqual(C.currencyFor('de-DE'), 'EUR');
  assert.strictEqual(C.currencyFor('en'), 'USD');
  assert.strictEqual(C.currencyFor('ja-JP'), 'USD', 'only two-decimal currencies; anything else is USD');
});

test('an item: one door for typed, stored and hostile input - bounded, unknown fields dropped, a bad emoji re-guessed, no prototype pollution', () => {
  const raw = JSON.parse('{"id":"abc","name":"<b>Coat</b>\u202e' + 'x'.repeat(100) + '","emoji":"🎃","room":"attic","paid":-5,"cond":"mint","note":"' + 'n'.repeat(500) + '","photo":"yes","createdAt":99999999999999,"decision":"burn","sell":{"ask":"lots","url":"javascript:alert(1)","status":"gone","where":"darkweb"},"__proto__":{"polluted":1},"extra":"x"}');
  const it = C.cleanItem(raw, O);
  assert.strictEqual(it.name.length, 60);
  assert.ok(!/\u202e/.test(it.name));
  assert.strictEqual(it.emoji, '🧥', 'an emoji outside the set is guessed again from the name');
  assert.deepStrictEqual([it.room, it.paid, it.cond, it.note.length, it.photo, it.decision], ['other', null, '', 200, false, null]);
  assert.strictEqual(it.createdAt, NOW, 'a creation time from the future is not believed');
  assert.deepStrictEqual(it.sell, { ask: null, where: '', url: '', status: 'to-list', listedDay: null, droppedDay: null, sold: null, soldDay: null });
  assert.ok(!('extra' in it) && ({}).polluted === undefined);
  assert.strictEqual(C.cleanItem({ id: 'x', name: '   ' }, O), null, 'a name is required');
  assert.strictEqual(C.cleanItem({ id: 'BAD ID', name: 'x' }, O), null);
  assert.strictEqual(C.cleanUrl('https://www.ebay.com/itm/123'), 'https://www.ebay.com/itm/123');
  for (const u of ['http://ebay.com', 'javascript:alert(1)', 'https://user:pw@ebay.com/', 'https://localhost/', 'data:text/html,x', 'https://' + 'a'.repeat(400) + '.com']) assert.strictEqual(C.cleanUrl(u), '', u);
});

/* ================================================================== *
 * The deck and the sprint
 * ================================================================== */

test('the deck: oldest first; a decision is pure and goes on the undo stack; undo puts the item back exactly; the stack is bounded', () => {
  const a = item('Coat'), b = item('Mug'), c = item('Lamp', { sprint: 's1' });
  const d0 = C.deckOf([c, b, a]);
  assert.deepStrictEqual(C.queue(d0).map((x) => x.name), ['Coat', 'Mug', 'Lamp']);
  assert.deepStrictEqual(C.queue(d0, 's1').map((x) => x.name), ['Lamp'], 'a sprint sorts only its own things');
  const d1 = C.decide(d0, a.id, 'sell', Object.assign({ ask: 2500 }, O));
  assert.strictEqual(d0.items[a.id].decision, null, 'the deck passed in is untouched');
  assert.deepStrictEqual([d1.items[a.id].decision, d1.items[a.id].sell.ask, d1.items[a.id].sell.status, d1.items[a.id].decidedDay], ['sell', 2500, 'to-list', TODAY]);
  const d2 = C.decide(d1, b.id, 'maybe', O);
  assert.deepStrictEqual(d2.items[b.id].maybe, { from: TODAY, until: '2026-11-29' }, 'the Maybe box is thirty days out');
  assert.deepStrictEqual(C.queue(d2).map((x) => x.name), ['Lamp']);
  const u1 = C.undo(d2);
  assert.strictEqual(u1.id, b.id);
  assert.deepStrictEqual(u1.deck.items[b.id], d0.items[b.id], 'undo restores the item as it was');
  const u2 = C.undo(u1.deck);
  assert.deepStrictEqual(u2.deck.items[a.id], d0.items[a.id]);
  assert.strictEqual(C.undo(u2.deck).id, null, 'nothing more to undo');
  assert.strictEqual(C.decide(d0, a.id, 'burn', O), d0, 'an unknown decision changes nothing');
  let big = C.deckOf(Array.from({ length: 40 }, (_, i) => item(`T${i}`)));
  for (const it of C.queue(big)) big = C.decide(big, it.id, 'toss', O);
  assert.strictEqual(big.history.length, C.LIMITS.undo);
  // A new pile starts over: out of the house is decided again there.
  const out = C.withDecision(Object.assign({}, d1.items[a.id], { outAt: NOW, outDay: TODAY }), 'donate', O);
  assert.deepStrictEqual([out.decision, out.outAt], ['donate', null]);
});

test('swiping: right keep, left toss, up sell, down donate; past the threshold or a quick flick; the label strengthens as it is dragged', () => {
  const t = { threshold: 110 };
  assert.strictEqual(C.dragDecision(120, 10, t), 'keep');
  assert.strictEqual(C.dragDecision(-130, 40, t), 'toss');
  assert.strictEqual(C.dragDecision(20, -115, t), 'sell');
  assert.strictEqual(C.dragDecision(-5, 140, t), 'donate');
  assert.strictEqual(C.dragDecision(60, 20, t), null, 'not far enough');
  assert.strictEqual(C.dragDecision(45, 5, { threshold: 110, vx: 0.9 }), 'keep', 'a quick flick counts');
  assert.strictEqual(C.dragDecision(20, 5, { threshold: 110, vx: 2 }), null, 'a twitch does not');
  assert.deepStrictEqual(C.dragHint(3, 2), { decision: null, strength: 0 });
  assert.deepStrictEqual(C.dragHint(55, 10, 110), { decision: 'keep', strength: 0.5 });
  assert.deepStrictEqual(C.dragHint(0, -220, 110), { decision: 'sell', strength: 1 });
});

test('the sprint: ten minutes, pauses not counted, five more on request, an end that cannot outrun the clock; the recap line', () => {
  let s = C.newSprint('kids', Object.assign({ id: 's1' }, O));
  assert.strictEqual(C.sprintLeft(s, NOW), 600000);
  assert.strictEqual(C.clock(C.sprintLeft(s, NOW + 2000)), '9:58');
  s = C.pauseSprint(s, NOW + 60000);
  assert.strictEqual(C.sprintLeft(s, NOW + 300000), 540000, 'the clock waits while paused');
  s = C.resumeSprint(s, NOW + 300000);
  assert.strictEqual(s.pausedMs, 240000);
  assert.strictEqual(C.sprintLeft(s, NOW + 360000), 480000);
  assert.strictEqual(C.sprintOver(s, NOW + 840000), true);
  const more = C.extendSprint(s, NOW + 900000);
  assert.strictEqual(C.sprintLeft(more, NOW + 900000), 300000, 'five more minutes from now when time had run out');
  const ended = C.endSprint(s, NOW + 3600000);
  assert.strictEqual(C.sprintElapsed(ended, NOW + 9999999), 600000, 'finishing an hour later still records ten minutes');
  assert.strictEqual(C.minutesWord(600000), '10 minutes');
  assert.strictEqual(C.minutesWord(20000), 'under a minute');
  const list = [
    ...['a', 'b', 'c', 'd', 'e'].map((x) => decided(x, 'donate')),
    decided('f', 'sell', TODAY, { sell: { ask: 4500 } }), decided('g', 'sell', TODAY, { sell: { ask: 2500 } }), decided('h', 'sell', TODAY, { sell: { ask: 1500 } }),
    decided('i', 'toss'), decided('j', 'toss'), decided('k', 'toss'), decided('l', 'keep'), item('waiting'),
  ];
  const r = C.recap(list, 600000, { currency: 'USD', locale: 'en-US' });
  assert.strictEqual(r.line, '12 things in 10 minutes - 5 to donate, 3 to sell (about $85), 3 to toss, 1 kept');
  assert.deepStrictEqual([r.count, r.leaving, r.sellCents], [12, 11, 8500]);
  assert.strictEqual(C.recap([], 30000).line, '0 things in under a minute');
});

test('the streak: days in a row with a sprint, alive through the day after, a gap starts over; the best run kept', () => {
  assert.deepStrictEqual(C.streak(['2026-10-28', '2026-10-29', '2026-10-30'], TODAY), { current: 3, best: 3, today: true, pending: false });
  assert.deepStrictEqual(C.streak(['2026-10-28', '2026-10-29'], TODAY), { current: 2, best: 2, today: false, pending: true });
  assert.deepStrictEqual(C.streak(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-28'], TODAY), { current: 0, best: 3, today: false, pending: false });
  assert.deepStrictEqual(C.streak(['nope', '2026-02-30'], TODAY), { current: 0, best: 0, today: false, pending: false });
});

/* ================================================================== *
 * The piles and the tally
 * ================================================================== */

test('rooms and weeks: "Kids\u2019 room: 31 sorted, 22 leaving"; the tally headline; decisions bucketed by the week they were made', () => {
  const kids = [];
  for (let i = 0; i < 22; i++) kids.push(decided(`k${i}`, ['toss', 'sell', 'donate'][i % 3], TODAY, { room: 'kids' }));
  for (let i = 0; i < 9; i++) kids.push(decided(`kk${i}`, 'keep', TODAY, { room: 'kids' }));
  kids.push(item('waiting', { room: 'kids' }));
  const r = C.roomStats(kids).find((x) => x.room === 'kids');
  assert.strictEqual(r.line, 'Kids\u2019 room: 31 sorted, 22 leaving');
  assert.deepStrictEqual([r.total, r.waiting], [32, 1]);
  assert.deepStrictEqual(C.roomStats(kids).map((x) => x.room), ['kids'], 'only rooms with something in them');
  const list = [];
  for (let i = 0; i < 47; i++) list.push(decided(`o${i}`, 'toss', '2026-10-20', { outAt: NOW, outDay: '2026-10-21' }));
  list.push(decided('sold1', 'sell', '2026-10-12', { sell: { ask: 30000, status: 'sold', sold: 31200 }, outAt: NOW, outDay: '2026-10-13' }));
  list[47].outAt = null; // a sold thing that was never marked out still counts its money
  const bags = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, n: i + 1, droppedDay: i < 6 ? '2026-10-25' : null }));
  const t = C.tally(list, bags, { today: TODAY, currency: 'USD', locale: 'en-US' });
  assert.strictEqual(t.headline, '47 things out of the house · $312 made · 6 bags donated');
  assert.deepStrictEqual([t.bagsDonated, t.bagsOpen, t.sold], [6, 1, 1]);
  assert.strictEqual(t.byWeek.length, 8);
  assert.strictEqual(t.byWeek[7].week, '2026-10-26', 'weeks start on Monday');
  const w19 = t.byWeek.find((w) => w.week === '2026-10-19');
  assert.deepStrictEqual([w19.toss, w19.total, w19.out], [47, 47, 47]);
  assert.strictEqual(t.byWeek.find((w) => w.week === '2026-10-12').sell, 1);
});

test('the sell pile: a 15% drop after a week listed (or a week after the last drop); money made; the listing text', () => {
  const listed = (days, ask, extra) => decided('Lego Duplo box', 'sell', TODAY, { cond: 'good', sell: Object.assign({ ask, status: 'listed', listedDay: C.addDays(TODAY, -days) }, extra || {}) });
  assert.deepStrictEqual(C.priceDrops([listed(8, 3000)], TODAY).map((d) => [d.days, d.from, d.to]), [[8, 3000, 2500]]);
  assert.deepStrictEqual(C.priceDrops([listed(7, 3000)], TODAY), [], 'a week exactly is not yet');
  assert.deepStrictEqual(C.priceDrops([listed(20, 3000, { droppedDay: C.addDays(TODAY, -3) })], TODAY), [], 'a recent drop waits another week');
  assert.deepStrictEqual(C.priceDrops([listed(20, 3000, { status: 'sold' })], TODAY), []);
  assert.strictEqual(C.dropPrice(10000), 8500);
  assert.strictEqual(C.dropPrice(1999), 1600);
  assert.strictEqual(C.dropPrice(150), null, 'nothing sensible to take off');
  const it = decided('Leather handbag', 'sell', TODAY, { cond: 'like-new', note: 'Gift, used twice', sell: { ask: 2500 } });
  assert.strictEqual(C.listingText(it, { currency: 'USD', locale: 'en-US' }), 'Leather handbag\nCondition: Like new\nPrice: $25\n\nGift, used twice\n\nPick up from me, or I can meet nearby. Message me if you\u2019re interested.');
  assert.match(C.listingText(decided('Mug', 'sell'), { currency: 'GBP', locale: 'en-GB' }), /^Mug\nPrice: make me an offer\n/);
  const s = C.sellSummary([it, decided('x', 'sell', TODAY, { sell: { status: 'sold', sold: 4000 } }), decided('y', 'sell', TODAY, { sell: { status: 'listed', ask: 1000 } })]);
  assert.deepStrictEqual(s, { made: 4000, sold: 1, listed: 1, toList: 1, asking: 3500 });
});

test('the donate pile: bags with their counts; the itemised list says the values are the person\u2019s own; the CSV defuses formulas', () => {
  const bags = [{ id: 'b1', n: 1, droppedDay: '2026-10-21', where: '' }, { id: 'b2', n: 2, droppedDay: null, where: '' }];
  const list = [
    decided('Winter coat', 'donate', TODAY, { cond: 'good', donate: { bag: 'b1', value: 4000 } }),
    decided('=HYPERLINK("http://x","click")', 'donate', TODAY, { donate: { bag: 'b2', value: 150 } }),
    decided('Mugs', 'donate'),
  ];
  assert.deepStrictEqual(C.bagRows(list, bags).map((b) => b.line), ['Bag 1: 1 item - dropped off', 'Bag 2: 1 item']);
  const text = C.donationText(list, bags, { currency: 'USD', locale: 'en-US' });
  assert.match(text, /^Donated items\nKeep your donation receipt; values are your own estimates\.\n/);
  assert.match(text, /- Winter coat \(Good\) - Bag 1, dropped off Oct 21 - est\. \$40/);
  assert.match(text, /3 items · your estimated total \$41\.50$/);
  const csv = C.donationCsv(list, bags, { currency: 'USD' });
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""click"")"`), 'a formula is defused and quoted');
  assert.ok(/\r\n$/.test(csv) && csv.split('\r\n')[0].startsWith('Item,Condition,Room,Bag'));
});

test('the toss pile: generic hints grouped by kind, and one line saying to check local rules - never a claim about them', () => {
  const groups = C.tossGroups([decided('Old paint tins', 'toss'), decided('Box of cables', 'toss'), decided('Running shoes', 'toss'), decided('Chipped plates', 'toss'), decided('Keep me', 'keep')]);
  assert.deepStrictEqual(groups.map((g) => [g.tip, g.items.length]), [['textiles', 1], ['tech', 1], ['hazard', 1], ['kitchen', 1]]);
  assert.match(C.TOSS_RULES_LINE, /check your council\u2019s or city\u2019s rules/);
  for (const t of Object.values(C.TOSS_TIPS)) assert.ok(!/\b(must by law|is illegal|fine of|\$\d)/i.test(t.text), t.title);
});

test('the Maybe box: a date thirty days out, due on the day, the next date; the .ics is floating local time, escaped, folded, CRLF', () => {
  const a = C.withDecision(item('Bread maker'), 'maybe', { nowMs: NOW, today: '2026-10-01' });
  assert.strictEqual(a.maybe.until, '2026-10-31');
  assert.deepStrictEqual(C.maybeState(a, TODAY), { until: '2026-10-31', left: 1, due: false, line: 'Opens tomorrow, Oct 31' });
  assert.strictEqual(C.maybeState(a, '2026-10-31').line, 'Due today');
  assert.strictEqual(C.maybeState(a, '2026-11-03').line, 'Due since Oct 31');
  assert.strictEqual(C.maybeState(item('x'), TODAY), null);
  const b = C.withDecision(item('Sun hat, straw; "big"\\one'), 'maybe', O);
  assert.deepStrictEqual(C.maybeDue([a, b], '2026-10-31').map((x) => x.name), ['Bread maker']);
  assert.strictEqual(C.maybeNext([a, b], TODAY).day, '2026-10-31');
  const ics = C.maybeIcs('2026-11-29', [b.name, 'x'.repeat(90), 'Café crème \u202Eunder\u0007'], O);
  assert.ok(ics.includes('DTSTART:20261129T100000\r\n'), 'floating: no TZID, no Z');
  assert.ok(!/DTSTART[^:]*TZID|DTSTART:\d{8}T\d{6}Z/.test(ics));
  assert.ok(/\r\n$/.test(ics) && !/[^\r]\n/.test(ics), 'CRLF throughout');
  assert.ok(ics.includes('Sun hat\\, straw\\; "big"\\\\one'), 'text escaped');
  assert.ok(!/[\u202e\u0007]/.test(ics), 'control and bidi characters removed');
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, `folded: ${l}`);
  assert.ok(ics.includes('BEGIN:VALARM') && ics.includes('SUMMARY:Open the Maybe box (3 things)'));
});

/* ================================================================== *
 * Up for grabs and the estimate: what may be sent
 * ================================================================== */

test('up for grabs: a link\u2019s body rebuilt field by field - 1 to 40 things, 1 to 14 days, names and notes without markup, a price only as cents', () => {
  const ok = { title: '<b>Before</b> Saturday', from: '<i>Jo</i>', days: 7, currency: 'GBP', items: [{ name: '<img src=x>Coat', note: 'Warm \u202e', emoji: '🧥', price: null, photo: true }, { name: 'Mug', price: 500 }] };
  const g = C.grabRequest(ok);
  assert.deepStrictEqual(g, { title: 'Before Saturday', from: 'Jo', days: 7, currency: 'GBP', items: [{ name: 'Coat', note: 'Warm', emoji: '🧥', price: null, photo: true }, { name: 'Mug', note: '', emoji: '☕', price: 500, photo: false }] });
  assert.strictEqual(C.grabRequest({ items: [{ name: 'x' }] }).from, 'A friend', 'no name chosen: "A friend"');
  assert.strictEqual(C.grabRequest({ items: [{ name: 'x' }] }).title, C.GRAB_TITLE_DEFAULT);
  const bad = [
    {}, [], { items: [] }, { items: Array.from({ length: 41 }, () => ({ name: 'x' })) }, { items: [{ name: 'x' }], days: 0 }, { items: [{ name: 'x' }], days: 15 },
    { items: [{ name: 'x' }], owner: 'me' }, { items: [{ name: 'x', room: 'closet' }] }, { items: [{ name: 'x', paid: 12000 }] }, { items: [{ name: '' }] },
    { items: [{ name: 'x', price: -1 }] }, { items: [{ name: 'x', price: 'free' }] }, { items: ['x'] },
  ];
  for (const b of bad) assert.strictEqual(C.grabRequest(b), null, JSON.stringify(b).slice(0, 80));
});

test('the estimate: the request is the one item\u2019s name, condition, currency and photo - nothing else; the answer is checked', () => {
  const it = decided('Wedding guest dress', 'sell', TODAY, { cond: 'like-new', note: 'From Aunt Sue', paid: 12000, room: 'closet' });
  const payload = C.estimatePayload(it, { type: 'image/jpeg', data: 'AAAA' }, 'GBP');
  assert.deepStrictEqual(payload, { name: 'Wedding guest dress', cond: 'like-new', currency: 'GBP', image: { type: 'image/jpeg', data: 'AAAA' } }, 'no note, no price paid, no room');
  assert.deepStrictEqual(C.estimateRequest(payload), { name: 'Wedding guest dress', cond: 'like-new', currency: 'GBP', image: { type: 'image/jpeg', data: 'AAAA' } });
  assert.deepStrictEqual(C.estimateRequest({ name: 'Mug' }), { name: 'Mug', cond: '', currency: 'USD', image: null });
  for (const b of [{ name: 'x', note: 'n' }, { name: 'x', paid: 1 }, { name: 'x', cond: 'mint' }, { name: 'x', currency: 'XYZ' }, { name: '' }, { name: 'x', image: { type: 'image/gif', data: 'AAAA' } }, { name: 'x', image: { type: 'image/jpeg', data: 'not base64!' } }, { name: 'x', image: { type: 'image/jpeg', data: 'A'.repeat(800000) } }, { name: 'x', image: { type: 'image/jpeg', data: 'AAAA', exif: 1 } }]) {
    assert.strictEqual(C.estimateRequest(b), null, JSON.stringify(b).slice(0, 80));
  }
  const req = { name: 'Coat', cond: '', currency: 'USD', image: null };
  const e = C.cleanEstimate({ low: 90, high: 25.4, confidence: 'high', reason: '<b>Good</b> coat - see https://x.example', title: 'Coat <script>', tips: ['A', 'a', 'B', 'C', 'D'] }, req);
  assert.deepStrictEqual([e.low, e.high, e.confidence], [2500, 9000, 'medium'], 'high below low is put right; "high" needs a photo');
  assert.strictEqual(e.reason, 'Good coat - see');
  assert.strictEqual(e.title, 'Coat');
  assert.deepStrictEqual(e.tips, ['A', 'B', 'C'], 'three, no repeats');
  for (const raw of [null, {}, { low: -1, high: 5 }, { low: 'lots', high: 5 }, { low: 1, high: 1e12 }]) assert.strictEqual(C.cleanEstimate(raw, req), null, JSON.stringify(raw));
  assert.strictEqual(C.cleanEstimate({ low: 0, high: 0, confidence: 'certain' }, req).confidence, 'low');
});

test('thumbnails are checked by their bytes: JPEG or PNG only, 60 KB and 320 px at most, metadata (location included) dropped', () => {
  const j = G.thumbnail(jpeg(240, 180).toString('base64'));
  const back = Buffer.from(j.data, 'base64');
  assert.deepStrictEqual([j.type, j.width, j.height], ['image/jpeg', 240, 180]);
  assert.ok(!back.includes(Buffer.from('GPSLatitude')) && !back.includes(Buffer.from('Acacia')), 'EXIF and comments gone');
  assert.ok(back.includes(Buffer.from('JFIF')), 'JFIF kept');
  const p = G.thumbnail('data:image/png;base64,' + png(200, 200).toString('base64'));
  assert.ok(p.type === 'image/png' && !Buffer.from(p.data, 'base64').includes(Buffer.from('home address')), 'PNG text chunks gone');
  const refuse = (raw, status) => { try { G.thumbnail(raw); assert.fail('accepted'); } catch (e) { assert.strictEqual(e.status, status, e.message); } };
  refuse(Buffer.from('GIF89a' + 'x'.repeat(50)).toString('base64'), 400);
  refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'), 400);
  refuse(jpeg(400, 200).toString('base64'), 400);
  refuse(jpeg(200, 200, 70 * 1024).toString('base64'), 413);
  refuse('not base64 at all!', 400);
  refuse('', 400);
  refuse(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x99]).toString('base64'), 400);
});

test('the sample closet for "Try it": twelve made-up things, all valid, never decided, never saved', () => {
  const s = C.sampleCloset(O);
  assert.strictEqual(s.length, 12);
  for (const it of s) {
    assert.ok(it && it.sample === true && it.decision === null && it.room === 'closet' && C.emojiOk(it.emoji) && it.tryAsk > 0, it && it.name);
    assert.ok(/^sample-\d+$/.test(it.id));
  }
  assert.ok(/MADE-UP|made-up/i.test(read('public/app.js').match(/Made-up example closet/)[0]));
});

/* ================================================================== *
 * The page's own promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the hero, the mock deck and the lab card too; 44px targets; nothing scrolls sideways', () => {
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
    for (const k of ['keep', 'toss', 'sell', 'donate', 'maybe', 'ok', 'warn']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); for (const bg of ['card', 'face', 'bg']) ok(k, bg); }
    for (const k of ['keep', 'toss', 'sell', 'donate', 'maybe']) ok('muted', `${k}-bg`);
    for (const fg of ['hero-ink', 'hero-soft']) for (const bg of ['hero-1', 'hero-2']) ok(fg, bg);
    ok('bg', 'text');
    ok('accent', 'track', 3);
  }
  // Colours written as literals: the hero's white buttons, the mock deck, the recap image.
  for (const [fg, bg] of [['#0b4f3d', '#ffffff'], ['#17211c', '#fffdf8'], ['#9b2c1c', '#ffffff'], ['#19663f', '#ffffff'], ['#7a4f00', '#ffffff'], ['#7a2f8f', '#ffffff'], ['#ffffff', '#0b4f3d'], ['#ffffff', '#4f2163'], ['#e2f3ea', '#0b4f3d'], ['#e2f3ea', '#4f2163'], ['#4c5852', '#f5f6f1'], ['#17211c', '#f5f6f1']]) {
    assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  }
  const lab = require('../../../lab').get('sorted');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.btn.small', '.link-btn', '.seg button, .chip', '.input, select.input, textarea.input', '.check', '.pile-tabs button', '.room-btn', '.choice', '.addemo', '.emoji-grid button', '.toast button']) {
    assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  }
  assert.ok(/\.choice \{[^}]*min-height: 66px/.test(css) && /\.tabbar button \{[^}]*min-height: 60px/.test(css) && /\.icon-btn \{ width: 44px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/prefers-reduced-motion: reduce[\s\S]*animation: none !important; transition: none !important/.test(css), 'reduced motion stops the wobble, the fly-out and the confetti');
  assert.ok(/\.scard \{[^}]*touch-action: none/.test(css), 'a drag never scrolls the page');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, photos shrunk on the device, every typed or received string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(/try \{\n\s*var r = indexedDB\.open\('sorted', 1\)/.test(js) && (js.match(/indexedDB\./g) || []).length === 1, 'IndexedDB opened once, inside try');
  assert.ok(!/sessionStorage|document\.cookie/.test(js));
  assert.ok(/redraw\(img, 1200, 0\.82\)/.test(js) && /redraw\(img, 240, 0\.74\)/.test(js), 'photos redrawn at 1200 and 240 px through a canvas');
  assert.match(js, /shrunk on this phone and their location is removed/);
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/estimate', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/g/', 'api/grabs', 'api/grabs/', 'api/me'].sort(), 'the page asks for nothing else - no route takes the things, the piles or the photos');
  assert.match(js, /items: chosen\.map\(function \(it\) \{ return \{ name: it\.name, note: notes\[it\.id\] \|\| '', emoji: it\.emoji, price: [^}]*photo: Boolean\(it\.photo && withPhoto\[it\.id\]\) \}; \}\)/, 'a link carries only what is ticked');
  assert.match(js, /C\.estimatePayload\(it, img/, 'the estimate sends the payload the core built, which is shown first');
  assert.match(js, /An estimate - check sold listings/);
  for (const f of ['public/index.html', 'public/app.js', 'public/sorted-core.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'lib/grabs.js', 'CLAUDE.md']) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  const core = read('public/sorted-core.js');
  assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.|indexedDB|WebSocket/.test(core), 'the core touches no network or storage');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  assert.ok(!/\(\?<[=!]/.test(core + js), 'no lookbehind (older iPhones cannot parse it)');
  assert.ok(!/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(core + js), 'no invisible characters of their own');
  // Every interpolation of something a person, a friend, the server or a model wrote goes through esc().
  const unesc = (src) => { let out = '', i = 0; for (;;) { const at = src.indexOf('esc(', i); if (at < 0) return out + src.slice(i); out += src.slice(i, at) + 'ESC'; let depth = 0, j = at + 3; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; } };
  const risky = unesc(js).split('\n').filter((l) => !/toast\(|say\(|confirm\(|copy\(|download\(|textContent|\.value = |fillText|fit\(g/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(it\.name|it\.note|it\.emoji|i\.name|i\.note|i\.emoji|i\.claimName|i\.claim\.name|g\.title|g\.from|l\.title|l\.from|e\.reason|e\.title|x|err\.message|e\.message|me\.email|d\.name|r\.label|t\.headline|prefs\.claimName|prefs\.from)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bname\b|\bbody\b|\bpayload)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js') + read('lib/grabs.js')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /sorted-shell-v1/.test(sw) && sw.includes("'sorted-core.js'") && /rel\.indexOf\('g\/'\) === 0/.test(sw) && /This list needs the internet/.test(sw), 'the service worker never answers api/, and a friend\u2019s page offline says it needs the network');
});

test('the copy: neutral wording (no he/she/his/her), and nothing Halloween about it', () => {
  const strings = (src) => [...src.matchAll(/'([^'\\\n]|\\.){3,}'|`[^`]{3,}`|"[^"\n]{3,}"/g)].map((m) => m[0]).join('\n');
  const all = strings(read('public/app.js')) + strings(read('public/sorted-core.js')) + read('public/index.html') + strings(read('server.js')) + strings(read('lib/grabs.js'));
  const gendered = all.match(/\b(he|she|his|hers|him|himself|herself)\b|\bher\b/gi);
  assert.strictEqual(gendered, null, `gendered: ${gendered}`);
  assert.ok(!/halloween|pumpkin|spooky|trick.or.treat|🎃|👻|🦇/i.test(all + read('public/app.css') + read('public/icon.svg')), 'not Halloween-themed');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; one equality query', () => {
  for (const [mod, env] of [['./lib/store', { SORTED_MEMORY: '1' }], ['./lib/fakeai', { SORTED_FAKE_AI: '1' }], ['./server', { SORTED_FAKE_AI: '1', SORTED_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, SORTED_MEMORY: '', SORTED_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, SORTED_MEMORY: '', SORTED_COLLECTION_PREFIX: 'sorted_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'sorted_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual(server.match(/store\.list\([^)]*\)/g), ["store.list('grabs', { where: [['owner', '==', tag]], limit: 60 })"], 'one single-field equality query, no composite index');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('grabs'", "store.get('thumbs'", "store.list('grabs'", "store.remove('grabs'", "store.remove('thumbs'", "store.set('thumbs'", "store.transact('grabs'"]);
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
    const t = /json|text|html/.test(ct) ? buf.toString('utf8') : '';
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, buf, headers: res.headers };
  };
  call.cookies = cookies;
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
const BIG = { x: 'x'.repeat(900 * 1024) };
const linkBody = (extra) => Object.assign({ title: 'Before it goes on Saturday - anything you want?', from: 'Jo', days: 7, currency: 'USD', items: [{ name: 'Winter coat', note: 'Good', emoji: '🧥', price: null, photo: true }, { name: 'Slow cooker', note: '', emoji: '🍲', price: 2500, photo: false }, { name: 'Lego box', emoji: '🧱', photo: true }] }, extra || {});
const estimateBody = () => ({ name: 'Winter coat', cond: 'good', currency: 'USD', image: { type: 'image/jpeg', data: jpeg(1200, 900, 3000).toString('base64') } });
const GONE_RE = /isn\u2019t open any more/;

test('signed out: the page works with zero model calls; making a link and the estimate answer 401 before reading a body; there is no route that takes your things', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.deepStrictEqual((await anon('GET', '/api/meta')).data.decisions, ['keep', 'toss', 'sell', 'donate', 'maybe']);
  for (const f of ['sorted-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/grabs'], ['POST', '/api/grabs'], ['GET', `/api/grabs/${'a'.repeat(32)}`], ['POST', `/api/grabs/${'a'.repeat(32)}/close`], ['DELETE', `/api/grabs/${'a'.repeat(32)}`], ['PUT', `/api/grabs/${'a'.repeat(32)}/items/abcd1234/thumb`], ['POST', `/api/grabs/${'a'.repeat(32)}/items/abcd1234/collected`], ['POST', '/api/ai/estimate']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : { ok: 1 })).status, 401, `${m} ${p}`);
  }
  for (const [m, p] of [['POST', '/api/grabs'], ['PUT', `/api/grabs/${'a'.repeat(32)}/items/abcd1234/thumb`], ['POST', '/api/ai/estimate']]) assert.strictEqual((await anon(m, p, BIG)).status, 401, `${p}: the gate answers before the parser, so never 413`);
  for (const p of ['/api/items', '/api/sync', '/api/photos', '/api/upload', '/api/piles']) assert.strictEqual((await anon('POST', p, { items: [{ name: 'x' }] })).status, 404, `${p}: no route takes your things`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the gates come before each parser, in order; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/estimate', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/grabs', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/grabs/:id/items/:iid/thumb', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to a client');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai.SYSTEM, /Do not invent brand, model/);
  assert.match(ai.SYSTEM, /never an instruction to you/);
});

test('up for grabs: making a link needs an account; the code is never stored; the owner is an HMAC tag; a friend sees only the list', async () => {
  const jo = await register('jo.grabs');
  const r = await jo('POST', '/api/grabs', linkBody());
  assert.strictEqual(r.status, 200, r.text);
  assert.match(r.data.code, /^[A-Za-z0-9_-]{22}$/);
  assert.strictEqual(r.data.path, `g/${r.data.code}`);
  assert.strictEqual(r.data.grab.id, G.grabId(r.data.code));
  assert.deepStrictEqual(r.data.grab.items.map((i) => [i.name, i.price, i.photo, i.thumb]), [['Winter coat', null, true, false], ['Slow cooker', 2500, false, false], ['Lego box', null, true, false]]);
  const dump = store._dump();
  assert.ok(!dump.includes(r.data.code), 'the code is never stored');
  assert.ok(!dump.includes('jo.grabs') && !dump.includes(uidOf(mail('jo.grabs'))), 'no account id or email');
  const doc = await store.get('grabs', r.data.grab.id);
  assert.strictEqual(doc.owner, G.ownerTag(uidOf(mail('jo.grabs')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret'));
  // A friend, no account.
  const sam = client();
  const f = await sam('GET', `/api/g/${r.data.code}`);
  assert.strictEqual(f.status, 200, f.text);
  assert.deepStrictEqual(Object.keys(f.data.grab).sort(), ['currency', 'expiresAt', 'from', 'items', 'status', 'title']);
  assert.deepStrictEqual(Object.keys(f.data.grab.items[0]).sort(), ['emoji', 'id', 'name', 'note', 'photo', 'price', 'state']);
  assert.ok(!/owner|device|createdAt/.test(f.text), 'nothing about the owner but the chosen name');
  assert.strictEqual(f.headers.get('referrer-policy'), 'no-referrer');
  assert.match(f.headers.get('x-robots-tag'), /noindex/);
  const pageRes = await fetch(`${base}/g/${r.data.code}`);
  assert.ok((await pageRes.text()).includes('<base href="../">') && pageRes.headers.get('referrer-policy') === 'no-referrer', 'the friend\u2019s page is the app one level down, no referrer');
  // Another account cannot read, close or delete it.
  const kim = await register('kim.other');
  for (const [m, p] of [['GET', `/api/grabs/${r.data.grab.id}`], ['POST', `/api/grabs/${r.data.grab.id}/close`], ['DELETE', `/api/grabs/${r.data.grab.id}`]]) assert.strictEqual((await kim(m, p, m === 'GET' ? undefined : {})).status, 404, `${m} ${p}`);
  assert.deepStrictEqual((await kim('GET', '/api/grabs')).data.links, []);
  for (const bad of [{}, linkBody({ days: 15 }), linkBody({ items: [] }), linkBody({ items: [{ name: 'x', room: 'garage' }] }), linkBody({ secret: 1 })]) assert.strictEqual((await jo('POST', '/api/grabs', bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.strictEqual((await jo('POST', '/api/grabs', BIG)).status, 413, 'a signed-in body past 48 KB is refused');
});

test('thumbnails: only for items published with "include photo", checked by their bytes, served to friends, gone with the link', async () => {
  const ann = await register('ann.thumbs');
  const { data } = await ann('POST', '/api/grabs', linkBody());
  const [coat, cooker, lego] = data.grab.items;
  const put = (iid, thumb) => ann('PUT', `/api/grabs/${data.grab.id}/items/${iid}/thumb`, { thumb });
  assert.strictEqual((await put(coat.id, jpeg(240, 180).toString('base64'))).status, 200);
  assert.strictEqual((await put(lego.id, png(200, 160).toString('base64'))).status, 200);
  assert.strictEqual((await put(cooker.id, jpeg(240, 180).toString('base64'))).status, 400, 'shared without its photo');
  assert.strictEqual((await put(coat.id, Buffer.from('GIF89a' + 'x'.repeat(60)).toString('base64'))).status, 400);
  assert.strictEqual((await put(coat.id, jpeg(640, 480).toString('base64'))).status, 400);
  assert.strictEqual((await put(coat.id, jpeg(200, 200, 70 * 1024).toString('base64'))).status, 413);
  assert.strictEqual((await put('zzzzzzzz', jpeg(200, 200).toString('base64'))).status, 404);
  const other = await register('ann.stranger');
  assert.strictEqual((await other('PUT', `/api/grabs/${data.grab.id}/items/${coat.id}/thumb`, { thumb: jpeg(200, 200).toString('base64') })).status, 404);
  assert.ok(!store._dump().includes('GPSLatitude') && !store._dump().includes(Buffer.from('GPSLatitude').toString('base64').slice(0, 12)), 'no location in what is stored');
  const friend = client();
  const view = await friend('GET', `/api/g/${data.code}`);
  assert.deepStrictEqual(view.data.grab.items.map((i) => i.photo), [true, false, true]);
  const img = await friend('GET', `/api/g/${data.code}/thumb/${coat.id}`);
  assert.deepStrictEqual([img.status, img.headers.get('content-type'), img.buf[0], img.buf[1]], [200, 'image/jpeg', 0xff, 0xd8]);
  assert.strictEqual(img.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await friend('GET', `/api/g/${data.code}/thumb/${cooker.id}`)).status, 404);
  assert.ok((await store.get('thumbs', G.thumbId(data.grab.id, coat.id))), 'stored in its own document');
  assert.strictEqual((await ann('DELETE', `/api/grabs/${data.grab.id}`)).status, 200);
  assert.strictEqual(await store.get('grabs', data.grab.id), null);
  assert.strictEqual(await store.get('thumbs', G.thumbId(data.grab.id, coat.id)), null, 'deleting the link deletes its thumbnails');
  assert.strictEqual(await store.get('thumbs', G.thumbId(data.grab.id, lego.id)), null);
  assert.strictEqual((await friend('GET', `/api/g/${data.code}/thumb/${coat.id}`)).status, 404);
});

test('claims: first come first served in a transaction - six friends tap one thing at once and exactly one wins; the others are told kindly', async () => {
  const lee = await register('lee.claims');
  const { data } = await lee('POST', '/api/grabs', linkBody());
  const coat = data.grab.items[0];
  const friends = Array.from({ length: 6 }, () => client());
  const results = await Promise.all(friends.map((f, i) => f('POST', `/api/g/${data.code}/items/${coat.id}/claim`, { name: `Friend ${i}` })));
  const wins = results.filter((x) => x.status === 200);
  assert.strictEqual(wins.length, 1, results.map((x) => x.status).join(','));
  for (const x of results.filter((y) => y.status !== 200)) {
    assert.strictEqual(x.status, 409);
    assert.match(x.data.error, /Someone got there first/);
    assert.strictEqual(x.data.code, 'taken');
  }
  const winner = friends[results.indexOf(wins[0])];
  assert.match(winner.cookies.sorted_d || '', /^[A-Za-z0-9_-]{22}$/, 'a device cookie, minted on the first claim');
  const mine = (await winner('GET', `/api/g/${data.code}`)).data.grab.items[0];
  assert.deepStrictEqual([mine.state, mine.claimName], ['mine', wins[0].data.grab.items[0].claimName]);
  const theirs = (await friends.find((f) => f !== winner)('GET', `/api/g/${data.code}`));
  assert.strictEqual(theirs.data.grab.items[0].state, 'taken');
  assert.ok(!/Friend \d/.test(theirs.text), 'other friends never see who claimed it');
  assert.strictEqual((await winner('POST', `/api/g/${data.code}/items/${coat.id}/claim`, { name: 'Again' })).status, 200, 'claiming your own again is fine');
  const doc = await store.get('grabs', data.grab.id);
  assert.ok(doc.items[0].claim && !JSON.stringify(doc).includes(winner.cookies.sorted_d), 'only a hash of the device key is kept');
  // The owner sees the name, never the device.
  const own = await lee('GET', '/api/grabs');
  const claim = own.data.links[0].items[0].claim;
  assert.deepStrictEqual(Object.keys(claim).sort(), ['at', 'collected', 'name']);
  assert.ok(!own.text.includes(doc.items[0].claim.device));
  // Releasing: only the claimer's device, or the owner.
  const stranger = friends.find((f) => f !== winner);
  assert.strictEqual((await stranger('DELETE', `/api/g/${data.code}/items/${coat.id}/claim`)).status, 404);
  assert.strictEqual((await client()('DELETE', `/api/g/${data.code}/items/${coat.id}/claim`)).status, 404, 'no cookie, no release');
  const rel = await winner('DELETE', `/api/g/${data.code}/items/${coat.id}/claim`);
  assert.deepStrictEqual([rel.status, rel.data.grab.items[0].state], [200, 'free']);
  assert.strictEqual((await stranger('POST', `/api/g/${data.code}/items/${coat.id}/claim`, { name: 'Pat' })).status, 200, 'free again for someone else');
  const byOwner = await lee('DELETE', `/api/grabs/${data.grab.id}/items/${coat.id}/claim`);
  assert.strictEqual(byOwner.data.grab.items[0].claim, null, 'the owner can release anyone\u2019s claim');
  // Collected: handed over, so the friend can no longer let it go.
  await stranger('POST', `/api/g/${data.code}/items/${coat.id}/claim`, { name: 'Pat' });
  assert.strictEqual((await lee('POST', `/api/grabs/${data.grab.id}/items/${coat.id}/collected`, { collected: true })).data.grab.items[0].claim.collected, true);
  assert.strictEqual((await stranger('DELETE', `/api/g/${data.code}/items/${coat.id}/claim`)).status, 409);
  assert.strictEqual((await lee('POST', `/api/grabs/${data.grab.id}/items/${data.grab.items[1].id}/collected`, {})).status, 409, 'nothing claimed, nothing to collect');
  // Names: cleaned, required, bounded.
  const cooker = data.grab.items[1];
  const n1 = await client()('POST', `/api/g/${data.code}/items/${cooker.id}/claim`, { name: '<img src=x onerror=alert(1)>Al\u202Eex ' + 'y'.repeat(60) });
  assert.strictEqual(n1.status, 200);
  const stored = (await store.get('grabs', data.grab.id)).items[1].claim.name;
  assert.ok(!/[<>\u202e]/.test(stored) && stored.length <= 30 && /^Al/.test(stored), stored);
  for (const bad of ['', '   ', '🎉', '<b></b>']) assert.strictEqual((await client()('POST', `/api/g/${data.code}/items/${data.grab.items[2].id}/claim`, { name: bad })).status, 400, bad);
  assert.strictEqual((await client()('POST', `/api/g/${data.code}/items/zzzzzzzz/claim`, { name: 'Al' })).status, 404);
});

test('expired, closed, unknown and malformed links all answer the same 404; the owner keeps a closed one for a while, then it is deleted on read', async () => {
  const max = await register('max.expiry');
  const a = (await max('POST', '/api/grabs', linkBody({ days: 1 }))).data;
  const b = (await max('POST', '/api/grabs', linkBody({ days: 14 }))).data;
  await max('PUT', `/api/grabs/${b.grab.id}/items/${b.grab.items[0].id}/thumb`, { thumb: jpeg(200, 200).toString('base64') });
  const friend = client();
  assert.strictEqual((await friend('GET', `/api/g/${a.code}`)).status, 200);
  await store.transact('grabs', a.grab.id, (cur) => Object.assign(cur, { expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.strictEqual((await max('POST', `/api/grabs/${b.grab.id}/close`, {})).data.grab.status, 'closed');
  const bodies = [];
  for (const p of [`/api/g/${a.code}`, `/api/g/${b.code}`, `/api/g/${G.newCode()}`, '/api/g/short', `/api/g/${a.code}/thumb/${a.grab.items[0].id}`]) {
    const r = await friend('GET', p);
    assert.strictEqual(r.status, 404, p);
    bodies.push(r.text);
  }
  assert.strictEqual(new Set(bodies).size, 1, 'word for word the same');
  assert.match(bodies[0], GONE_RE);
  assert.strictEqual((await friend('POST', `/api/g/${b.code}/items/${b.grab.items[0].id}/claim`, { name: 'Al' })).status, 404, 'a closed link takes no claims');
  const links = (await max('GET', '/api/grabs')).data.links;
  assert.deepStrictEqual(links.map((l) => l.status).sort(), ['closed', 'expired'], 'the owner still sees who claimed what');
  // Past the owner's keep, the next read deletes it and its thumbnails.
  const old = new Date(Date.now() - (C.LIMITS.grabKeepDays + 1) * 86400000).toISOString();
  await store.transact('grabs', b.grab.id, (cur) => Object.assign(cur, { closedAt: old }));
  await store.transact('grabs', a.grab.id, (cur) => Object.assign(cur, { expiresAt: old }));
  assert.deepStrictEqual((await max('GET', '/api/grabs')).data.links, []);
  assert.strictEqual(await store.get('grabs', b.grab.id), null);
  assert.strictEqual(await store.get('thumbs', G.thumbId(b.grab.id, b.grab.items[0].id)), null);
});

test('limits: three open links an account; distinct wrong codes per address, then even a real one waits; claims per address', async () => {
  const pia = await register('pia.limits');
  const made = [];
  for (let i = 0; i < 3; i++) { const r = await pia('POST', '/api/grabs', linkBody()); assert.strictEqual(r.status, 200); made.push(r.data); }
  const fourth = await pia('POST', '/api/grabs', linkBody());
  assert.deepStrictEqual([fourth.status, /3 open links/.test(fourth.data.error)], [429, true]);
  await pia('POST', `/api/grabs/${made[0].grab.id}/close`, {});
  assert.strictEqual((await pia('POST', '/api/grabs', linkBody())).status, 200, 'closing one makes room');
  // One dead code polled again and again counts once...
  const poller = client();
  for (let i = 0; i < 40; i++) assert.strictEqual((await poller('GET', `/api/g/${made[0].code}`)).status, 404);
  assert.strictEqual((await poller('GET', `/api/g/${made[1].code}`)).status, 200, 'a closed link polled 40 times is not guessing');
  // ...but thirty different wrong codes lock the address out.
  const guesser = client();
  for (let i = 0; i < G.LIMITS.missesPerIp; i++) assert.strictEqual((await guesser('GET', `/api/g/${G.newCode()}`)).status, 404);
  const locked = await guesser('GET', `/api/g/${made[1].code}`);
  assert.deepStrictEqual([locked.status, /Too many wrong links/.test(locked.data.error)], [429, true]);
  assert.strictEqual((await client()('GET', `/api/g/${made[1].code}`)).status, 200, 'another address is not held up');
  // Claims and releases per address.
  const tapper = client('203.0.113.77');
  const it = made[1].grab.items[0];
  let last = null;
  for (let i = 0; i < G.LIMITS.claimsPerIp + 1; i++) last = await tapper(i % 2 ? 'DELETE' : 'POST', `/api/g/${made[1].code}/items/${it.id}/claim`, i % 2 ? undefined : { name: 'Tap' });
  assert.strictEqual(last.status, 429);
  assert.strictEqual(LIMITS.claimsPerIp, G.LIMITS.claimsPerIp);
});

test('the estimate over HTTP: anything but the name, condition, currency and photo is a 400 with no model call; the model sees the photo and the fenced name; the answer is cleaned', async () => {
  const eva = await register('eva.estimate');
  const calls = await modelCalls();
  const okImg = estimateBody().image;
  const pngAsJpeg = { type: 'image/jpeg', data: png(200, 200).toString('base64') };
  for (const bad of [{}, { name: 'x', note: 'From Aunt Sue' }, { name: 'x', paid: 12000 }, { name: 'x', room: 'closet' }, { name: 'x', cond: 'mint' }, { name: 'x', currency: 'XYZ' }, { name: 'x', image: { type: 'image/gif', data: 'R0lG' } }, { name: 'x', image: pngAsJpeg }, { name: 'x', image: { type: 'image/jpeg', data: jpeg(2400, 1800).toString('base64') } }, { name: 'x', image: { ...okImg, extra: 1 } }, []]) {
    assert.strictEqual((await eva('POST', '/api/ai/estimate', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await eva('POST', '/api/ai/estimate', estimateBody());
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeClient.calls[n0];
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'estimate_price' });
  const content = req.messages[0].content;
  assert.deepStrictEqual(content.map((b) => b.type), ['image', 'text']);
  assert.ok(!Buffer.from(content[0].source.data, 'base64').includes(Buffer.from('GPSLatitude')), 'the model\u2019s copy has no location in it');
  assert.match(content[1].text, /<<<ITEM\nWinter coat\nITEM>>>/);
  assert.match(content[1].text, /Currency: USD/);
  assert.deepStrictEqual(Object.keys(r.data.estimate).sort(), ['confidence', 'currency', 'high', 'low', 'reason', 'tips', 'title']);
  assert.ok(r.data.estimate.high >= r.data.estimate.low && r.data.estimate.low >= 0);
  assert.ok(!store._dump().includes('Winter coat - good condition'), 'nothing stored');
  const inj = await eva('POST', '/api/ai/estimate', { name: 'INJECT coat' });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]|\u202e|javascript:|https?:|www\.|evil\.example/i.test(inj.text), inj.text.slice(0, 300));
  const e = inj.data.estimate;
  assert.ok(e.high >= e.low && e.confidence === 'low' && e.tips.length <= 3 && e.reason.length <= C.LIMITS.aiReason && !('extra' in e));
  assert.strictEqual((await eva('POST', '/api/ai/estimate', { name: 'BLANK coat' })).status, 422);
  assert.match((await eva('POST', '/api/ai/estimate', { name: 'MAXTOKENS coat' })).data.error, /ran long/);
  const up = await eva('POST', '/api/ai/estimate', { name: 'UPSTREAM401 coat' });
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await eva('POST', '/api/ai/estimate', { name: 'UPSTREAM529 coat' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  const nameOnly = fakeClient.calls[fakeClient.calls.length - 1];
  assert.deepStrictEqual(nameOnly.messages[0].content.map((b) => b.type), ['text'], 'no photo, no image block');
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call', async () => {
  const una = await register('una.unconfirmed');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await una('POST', '/api/ai/estimate', estimateBody());
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/sorted/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await una('POST', '/api/ai/estimate', BIG)).status, 403, '403 before the big body is read');
    assert.strictEqual((await una('POST', '/api/grabs', linkBody())).status, 200, 'up for grabs is free and needs no confirmed address');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/estimate', estimateBody())).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/estimate', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-sorted-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/estimate', estimateBody());
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/estimate', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-sorted-${day}`); }
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/sorted', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/sorted`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
