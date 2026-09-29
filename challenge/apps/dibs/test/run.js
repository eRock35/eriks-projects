// Pure rules first, then end to end against the memory store and the fake
// model:
//   DIBS_MEMORY=1 DIBS_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /dibs, the way the
// lab mounts it, so the auth cookie, the budget gate, the guest cookie's
// path, per-table rights and the big-body route are exercised as deployed.
// Model calls are counted from the identity's usage rows - the same rows
// that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.DIBS_MEMORY !== '1' || process.env.DIBS_FAKE_AI !== '1') {
  console.error('run with DIBS_MEMORY=1 DIBS_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/dibs-core');
const S = require('../public/sample');
const QR = require('../public/qr');
const ai = require('../lib/ai');
const T = require('../lib/tables');
const fakeai = require('../lib/fakeai');

let base;
let ipSeq = 10;
const freshIp = () => `203.0.113.${ipSeq++}`;
function client(ip) {
  const cookies = {};
  const addr = ip || freshIp();
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
const MARK = 'PHOTOBYTESMARKER';
const jpeg = (s = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(MARK + s), Buffer.alloc(2000, 7)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const bill = (items, extra = {}) => C.cleanBill({ items: items.map((it, i) => ({ id: `it${i}x`, name: it[0], unit: it[1], qty: it[2] || 1 })), ...extra });
const ppl = (...names) => names.map((n, i) => ({ id: `p${n.toLowerCase()}x`, name: n, color: C.COLOR_IDS[i] }));
const sumTotals = (r) => r.people.reduce((s, p) => s + p.total, 0) + r.unclaimed.total;

/* ---------------- pure: money ---------------- */

test('money is read from its digits; anything without a digit is no figure; negatives only for discounts', () => {
  const cases = { '$1,240.50': 124050, '12.5': 1250, '12': 1200, '12.50': 1250, '12,50': 1250, '£3': 300, '€ 2.75': 275, '45¢': 45, 'USD 12': 1200, '12.345': 1235, '.5': 50, '0.10': 10 };
  for (const [v, want] of Object.entries(cases)) assert.strictEqual(C.toCents(v), want, v);
  assert.strictEqual(C.toCents(0.1 + 0.2), 30, 'a float is read through its digits');
  for (const bad of ['free', '', 'twelve', '$', '1e5', NaN, Infinity, {}, null, undefined, '-4.00', '(4.00)', '4.00-', '999999999']) assert.strictEqual(C.toCents(bad), null, String(bad));
  assert.deepStrictEqual(['-4.00', '(4.00)', '4.00-', '−$4.00', '$-4.00'].map((v) => C.toCents(v, { negative: true })), [-400, -400, -400, -400, -400]);
  assert.deepStrictEqual(['20', '20%', '18.5 %', 20, '0'].map(C.toBp), [2000, 2000, 1850, 2000, 0]);
  assert.deepStrictEqual([C.money(124050), C.money(-200), C.money(5, 'GBP'), C.money(99, 'EUR')], ['$1,240.50', '−$2.00', '£0.05', '€0.99']);
  assert.deepStrictEqual([C.plain(2347), C.plain(5), C.plain(100000)], ['23.47', '0.05', '1000.00']);
  assert.deepStrictEqual([C.bpText(2000), C.bpText(1850), C.bpText(1250), C.bpText(887)], ['20%', '18.5%', '12.5%', '8.87%']);
});

test('allocate: the parts add up exactly, the biggest remainders take the spare cents, ties are deterministic', () => {
  assert.deepStrictEqual(C.allocate(100, [1, 1, 1]), [34, 33, 33], 'a tie goes to the earlier position');
  assert.deepStrictEqual(C.allocate(100, [1, 2]), [33, 67]);
  assert.deepStrictEqual(C.allocate(1000, [0, 0]), [500, 500], 'all-zero weights split evenly');
  assert.deepStrictEqual(C.allocate(-100, [1, 1, 1]), [-34, -33, -33], 'a discount is split as its size');
  assert.deepStrictEqual(C.allocate(0, [1, 2]), [0, 0]);
  assert.deepStrictEqual(C.allocate(5, [1, 0, 1]), [3, 0, 2], 'a zero weight never gets a spare cent');
  assert.deepStrictEqual(C.allocate(1, [2, 3]), [0, 1], 'the larger remainder');
  const big = C.allocate(9999999, [3333, 1, 7777777, 5]);
  assert.strictEqual(big.reduce((a, b) => a + b, 0), 9999999);
  assert.strictEqual(C.mulDiv(21350, 2000, 10000), 4270);
  assert.strictEqual(C.mulDiv(125, 1, 2), 63, 'half up');
});

/* ---------------- pure: reading receipts ---------------- */

test('parseReceipt reads the example receipt exactly, and says what it skipped and why', () => {
  const p = C.parseReceipt(S.RECEIPT);
  assert.strictEqual(p.title, 'Luigi\'s Trattoria');
  assert.deepStrictEqual(p.items.map((i) => [i.name, i.unit, i.qty]), S.ITEMS.map((r) => [r[1], r[2], r[3]]));
  assert.deepStrictEqual([p.subtotal, p.tax, p.total, p.tip, p.fees, p.discounts], [21350, 1895, 23245, null, [], []]);
  const why = Object.fromEntries(p.skipped.map((s) => [s.line, s.why]));
  assert.strictEqual(why['(212) 555-0143'], 'phone number');
  assert.strictEqual(why['Server: Maria Table 12'], 'staff');
  assert.strictEqual(why['Guests: 4'], 'order details');
  assert.strictEqual(why['09/28/2026 8:47 PM'], 'date or time');
  assert.strictEqual(why['VISA ************4242'], 'card or payment');
  assert.strictEqual(why['20% ..... 42.70'], 'suggested tip', 'a suggested-tip table is never read as a tip');
  assert.strictEqual(why['Thank you! Grazie!'], 'website or message');
  const b = C.billFromParsed(p);
  assert.strictEqual(C.check(b).status, 'ok');
  assert.deepStrictEqual([b.tip.mode, b.tip.bp], ['percent', 2000], 'no printed tip: 20% is offered');
});

test('parseReceipt: a bar tab with @ prices, a happy-hour discount and a service charge', () => {
  const p = C.parseReceipt(['THE COPPER KETTLE', 'Tab #2231   Bartender: Jo', '2 IPA @ 7.00          14.00', 'Nachos                12.50', 'Wings (12)            16.00', 'Happy Hour           -3.00', 'Subtotal              39.50', 'Tax                    3.16', 'Service charge 18%     7.65', 'Total                 50.31', 'VISA ****1881'].join('\n'));
  assert.strictEqual(p.title, 'The Copper Kettle');
  assert.deepStrictEqual(p.items.map((i) => [i.name, i.unit, i.qty]), [['IPA', 700, 2], ['Nachos', 1250, 1], ['Wings (12)', 1600, 1]]);
  assert.deepStrictEqual(p.discounts.map((d) => [d.name, d.cents]), [['Happy Hour', 300]]);
  assert.deepStrictEqual(p.fees.map((f) => [f.name, f.cents, f.service, f.rateBp]), [['Service charge 18%', 765, true, 1800]]);
  const b = C.billFromParsed(p);
  assert.deepStrictEqual([b.tip.mode, b.tip.cents], ['amount', 0], 'a service charge on the bill sets the tip to nothing');
  assert.strictEqual(C.serviceNote(b), 'A 18% service charge is already on this bill, so the tip starts at nothing.');
  assert.strictEqual(C.check(b).status, 'ok', '42.50 + 3.16 + 7.65 - 3.00 = 50.31');
});

test('parseReceipt: many real formats - POS columns, qty prefixes and suffixes, tax flags, commas, pounds, typed lists', () => {
  const rows = (t) => C.parseReceipt(t).items.map((i) => [i.name, i.unit, i.qty]);
  assert.deepStrictEqual(rows('Margarita   2   12.00   24.00\nMargarita 12.00 24.00\nCoke 2 5.00\nMojito x3 27.00\nx2 Beer 14.00\n2x Taco 9.00\n3 Tacos 10.00'),
    [['Margarita', 1200, 2], ['Margarita', 1200, 2], ['Coke', 250, 2], ['Mojito', 900, 3], ['Beer', 700, 2], ['Taco', 450, 2], ['Tacos (3)', 1000, 1]]);
  assert.deepStrictEqual(rows('12 Wings 15.00\n16 oz Ribeye 38.00\n1/2 Chicken 14.00\n1 Burger 15.00 T\nFries 4.50T\nSoda 2.00 *'),
    [['12 Wings', 1500, 1], ['16 oz Ribeye', 3800, 1], ['1/2 Chicken', 1400, 1], ['Burger', 1500, 1], ['Fries', 450, 1], ['Soda', 200, 1]], 'a pack size is not a count; tax flags are dropped');
  // A typed list: bare whole dollars count on the end of a named line.
  assert.deepStrictEqual(rows('Pizza 18\nBeer x2 14\nSalad $9'), [['Pizza', 1800, 1], ['Beer', 700, 2], ['Salad', 900, 1]]);
  // A UK pub: pounds, VAT "included" is not added, a discretionary service charge is a fee.
  const uk = C.parseReceipt('THE RED LION\nFish & Chips £14.50\n2 x Pint of Bitter £10.80\nSubtotal £25.30\nService 12.5% £3.16\nTotal £28.46\nVAT included £4.74');
  assert.strictEqual(uk.currency, 'GBP');
  assert.deepStrictEqual(uk.items.map((i) => [i.name, i.unit, i.qty]), [['Fish & Chips', 1450, 1], ['Pint of Bitter', 540, 2]]);
  assert.deepStrictEqual([uk.tax, uk.fees[0].cents, uk.fees[0].service, uk.fees[0].rateBp, uk.total], [0, 316, true, 1250, 2846]);
  assert.strictEqual(uk.skipped.find((s) => /VAT/.test(s.line)).why, 'tax already included');
  assert.strictEqual(C.check(C.billFromParsed(uk)).status, 'ok');
  // Decimal commas, euros.
  const eu = C.parseReceipt('Trattoria\nPizza Margherita 9,50\nVino rosso 1/4 l 6,00\nCoperto 2,00\nTotale €17,50');
  assert.strictEqual(eu.currency, 'EUR');
  assert.deepStrictEqual(eu.items.map((i) => [i.name, i.unit]), [['Pizza Margherita', 950], ['Vino rosso 1/4 l', 600], ['Coperto', 200]]);
  assert.strictEqual(eu.total, 1750);
  // Delivery: fees and three ways of printing a negative.
  const d = C.parseReceipt('Pad Thai 14.00\nSpring rolls 6.00\nDelivery fee 3.99\nService fee 2.50\nPromo code SAVE5 -5.00\nCredit applied (2.00)\nLoyalty 1.00-\nTip 4.00\nTotal 22.49');
  assert.deepStrictEqual(d.fees.map((f) => [f.name, f.cents, f.service]), [['Delivery fee', 399, false], ['Service fee', 250, true]]);
  assert.deepStrictEqual(d.discounts.map((x) => x.cents), [500, 200, 100]);
  assert.strictEqual(d.tip, 400);
  const db = C.billFromParsed(d);
  assert.deepStrictEqual([db.tip.mode, db.tip.cents, db.tip.onReceipt], ['amount', 400, true]);
  assert.strictEqual(C.check(db).status, 'ok', 'a printed tip counts toward the printed total');
});

test('parseReceipt: junk, zero-price modifiers and hostile text', () => {
  const j = C.parseReceipt('Thank you for dining!\nwww.example.com\nOrder #4471\nCheck 12 Guests 3\nAUTH CODE 004411\nCHANGE DUE 0.00\nCASH 50.00\n  no onions\n  + extra cheese 0.00\n------');
  assert.deepStrictEqual(j.items, []);
  assert.ok(j.skipped.length >= 7, JSON.stringify(j.skipped));
  const h = C.parseReceipt('<img src=x onerror=alert(1)>Burger 15.00\nWine\u202e\u0000 flight 18.00\n' + '<'.repeat(30000));
  assert.deepStrictEqual(h.items.map((i) => i.name), ['Burger', 'Wine flight']);
  const t0 = Date.now();
  C.parseReceipt('<'.repeat(200000) + '\n' + 'A 1.00\n'.repeat(3000));
  assert.ok(Date.now() - t0 < 1500, 'hostile input costs linear time');
  const many = C.parseReceipt(Array.from({ length: 130 }, (_, i) => `Item ${i + 1} 2.00`).join('\n'));
  assert.strictEqual(many.items.length, 120);
  assert.ok(many.skipped.some((s) => s.why === 'too many lines'));
  assert.strictEqual(C.parseReceipt('').items.length, 0);
  assert.strictEqual(C.parseReceipt(null).items.length, 0);
});

test('the check against the printed total is named, never fudged', () => {
  const b = bill([['Pasta', 1800], ['Wine', 2400]], { tax: 336, printed: { subtotal: null, total: 4886 } });
  const short = C.check(b);
  assert.deepStrictEqual([short.status, short.diff], ['short', -350]);
  assert.strictEqual(short.text, 'Items add up to $3.50 less than the receipt - a line may be missing.');
  b.printed.total = 4536 - 100;
  assert.strictEqual(C.check(b).text, 'Items add up to $1.00 more than the receipt - a line may be in twice, or a discount missing.');
  b.printed = { subtotal: 4200, total: 4600 };
  assert.match(C.check(b).text, /^The items match, but tax, fees and discounts add up to \$0\.64 less/);
  b.printed = { subtotal: 4000, total: null };
  assert.strictEqual(C.check(b).text, 'Items add up to $2.00 more than the receipt’s subtotal - a line may be in twice, or a discount missing.');
  b.printed = { subtotal: null, total: null };
  assert.strictEqual(C.check(b).status, 'none');
  const t = C.totals(b);
  assert.strictEqual(t.grand, 4200 + 336 + 840, 'the tip (20% of the food) is not changed by any check');
});

/* ---------------- pure: the split ---------------- */

test('tax, tip, fees and discounts are shared in proportion to what each person had', () => {
  const b = bill([['Steak', 4000], ['Salad', 1000]], { tax: 500, fees: [{ name: 'Kitchen fee', cents: 250 }], discounts: [{ name: 'Promo', cents: 500 }] });
  const people = ppl('Ben', 'Ana');
  const r = C.split(b, people, { it0x: { pbenx: 1 }, it1x: { panax: 1 } }, {});
  const [ben, ana] = r.people;
  assert.deepStrictEqual([ben.items, ben.tax, ben.fees, ben.discounts, ben.tip], [4000, 400, 200, 400, 800]);
  assert.deepStrictEqual([ana.items, ana.tax, ana.fees, ana.discounts, ana.tip], [1000, 100, 50, 100, 200]);
  assert.deepStrictEqual([ben.total, ana.total], [5000, 1250]);
  assert.strictEqual(sumTotals(r), r.grand);
  assert.strictEqual(r.grand, 5000 + 500 + 250 - 500 + 1000);
});

test('the tip: percent of the food by default, or of the total, or a typed amount; split evenly if chosen', () => {
  const b = bill([['Steak', 4000], ['Salad', 1000]], { tax: 500, tip: { mode: 'percent', bp: 1800 } });
  assert.strictEqual(C.totals(b).tip, 900);
  b.tip.base = 'total';
  assert.strictEqual(C.totals(b).tip, 990, '18% of $55.00');
  b.tip = { ...b.tip, mode: 'amount', cents: 1001 };
  assert.strictEqual(C.totals(b).tip, 1001);
  b.tip.even = true;
  const r = C.split(b, ppl('Ben', 'Ana'), { it0x: { pbenx: 1 }, it1x: { panax: 1 } }, {});
  assert.deepStrictEqual(r.people.map((p) => p.tip), [501, 500], 'an even tip, to the cent');
  assert.strictEqual(sumTotals(r), r.grand);
  const r2 = C.split({ ...b, tip: { ...b.tip, even: false } }, ppl('Ben', 'Ana'), { it0x: { pbenx: 1 }, it1x: { panax: 1 } }, {});
  assert.deepStrictEqual(r2.people.map((p) => p.tip), [801, 200]);
});

test('shared plates, uneven shares, units of a multi-quantity line and "among everyone"', () => {
  const b = bill([['Burrata', 1650], ['Margarita', 1200, 3], ['Pizza', 1800], ['Tiramisu', 1000]], { tip: { mode: 'amount', cents: 0 } });
  const people = ppl('Sam', 'Ana', 'Ben');
  const line = (r, pid, iid) => (r.people.find((p) => p.id === pid).lines.find((l) => l.itemId === iid) || {}).cents || 0;
  // Three ways: 550 each. Uneven 2:1 on the pizza: 1200 / 600.
  let r = C.split(b, people, { it0x: { psamx: 1, panax: 1, pbenx: 1 }, it2x: { psamx: 2, pbenx: 1 } }, {});
  assert.deepStrictEqual([line(r, 'psamx', 'it0x'), line(r, 'panax', 'it0x'), line(r, 'pbenx', 'it0x')], [550, 550, 550]);
  assert.deepStrictEqual([line(r, 'psamx', 'it2x'), line(r, 'pbenx', 'it2x')], [1200, 600]);
  // A unit at a time: one margarita of three claimed leaves two open.
  r = C.split(b, people, { it1x: { panax: 1 } }, {});
  assert.strictEqual(line(r, 'panax', 'it1x'), 1200);
  assert.deepStrictEqual(r.unclaimed.open.find((o) => o.itemId === 'it1x'), { itemId: 'it1x', cents: 2400, units: 2, whole: false });
  r = C.split(b, people, { it1x: { panax: 2, pbenx: 1 } }, {});
  assert.deepStrictEqual([line(r, 'panax', 'it1x'), line(r, 'pbenx', 'it1x')], [2400, 1200]);
  // More taps than units: the whole line is shared by weight.
  r = C.split(b, people, { it1x: { panax: 2, pbenx: 1, psamx: 1 } }, {});
  assert.deepStrictEqual([line(r, 'panax', 'it1x'), line(r, 'pbenx', 'it1x'), line(r, 'psamx', 'it1x')], [1800, 900, 900]);
  // Among everyone: the rest of the line, evenly, to the cent.
  r = C.split(b, people, { it1x: { panax: 1 } }, { it1x: true, it3x: true });
  assert.deepStrictEqual([line(r, 'panax', 'it1x'), line(r, 'pbenx', 'it1x'), line(r, 'psamx', 'it1x')], [2000, 800, 800]);
  assert.deepStrictEqual(['psamx', 'panax', 'pbenx'].map((p) => line(r, p, 'it3x')), [334, 333, 333]);
  assert.ok(!r.unclaimed.open.some((o) => o.itemId === 'it1x' || o.itemId === 'it3x'));
  // Unclaimed carries its own tax and tip, so claiming it later moves them.
  const bt = bill([['A', 1000], ['B', 1000]], { tax: 200 });
  const half = C.split(bt, ppl('X'), { it0x: { pxx: 1 } }, {});
  assert.deepStrictEqual([half.people[0].total, half.unclaimed.total], [1300, 1300]);
});

test('property: over thousands of random bills, every cent is paid exactly once', () => {
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 3000; k++) {
    const nItems = 1 + rnd(12);
    const items = Array.from({ length: nItems }, (_, i) => [`I${i}`, 1 + rnd(9000), 1 + rnd(4)]);
    const b = bill(items, {
      tax: rnd(3000),
      tip: rnd(2) ? { mode: 'percent', bp: rnd(3000), base: rnd(2) ? 'total' : 'subtotal', even: rnd(2) === 1 } : { mode: 'amount', cents: rnd(5000), even: rnd(2) === 1 },
      fees: rnd(2) ? [{ name: 'Fee', cents: 1 + rnd(900) }] : [],
      discounts: rnd(3) ? [] : [{ name: 'Promo', cents: 1 + rnd(900) }],
    });
    const people = ppl(...Array.from({ length: 1 + rnd(8) }, (_, i) => `P${i}`));
    const claims = {};
    const everyone = {};
    b.items.forEach((it) => {
      const row = {};
      people.forEach((p) => { if (rnd(3) === 0) row[p.id] = 1 + rnd(3); });
      if (Object.keys(row).length) claims[it.id] = row;
      if (rnd(5) === 0) everyone[it.id] = true;
    });
    const r = C.split(b, people, claims, everyone);
    assert.strictEqual(sumTotals(r), r.grand, `bill ${k}`);
    for (const key of ['items', 'tax', 'fees', 'discounts', 'tip']) {
      assert.strictEqual(r.people.reduce((s, p) => s + p[key], 0) + r.unclaimed[key], r.totals[key], `bill ${k}: ${key}`);
    }
    for (const p of r.people) {
      assert.ok(Number.isInteger(p.total), `bill ${k}: whole cents`);
      assert.ok(p.items >= 0 && p.tax >= 0 && p.tip >= 0 && p.fees >= 0 && p.discounts >= 0, `bill ${k}: no negative part`);
      assert.ok(p.discounts <= p.items + p.tax + p.fees + p.tip + 1, `bill ${k}: a discount never makes a share negative`);
    }
    assert.deepStrictEqual(C.split(b, people, claims, everyone), r, 'the same bill gives the same split, every time');
  }
});

test('fairness: who an even split would have overcharged, over what has been claimed', () => {
  const st = S.state();
  const r = C.split(C.cleanBill(st.bill), st.people, st.claims, st.everyone);
  const f = C.fairness(r, 'USD');
  assert.strictEqual(f.name, 'Ana', 'the salad person');
  assert.strictEqual(f.text, `Splitting evenly would have cost Ana ${C.money(f.cents)} more (so far).`);
  const even = C.split(bill([['A', 1000], ['B', 1000]]), ppl('X', 'Y'), { it0x: { pxx: 1 }, it1x: { pyx: 1 } }, {});
  assert.ok(C.fairness(even, 'USD').even);
  assert.strictEqual(C.fairness(C.split(bill([['A', 1000]]), ppl('X'), {}, {}), 'USD'), null);
});

test('the example tells the story the page says it does', () => {
  const st = S.state();
  const b = C.cleanBill(st.bill);
  const r = C.split(b, st.people, st.claims, st.everyone);
  assert.strictEqual(b.items.length, 10);
  assert.strictEqual(b.items.find((i) => i.name === 'Margarita').qty, 2, 'a qty-2 cocktail');
  assert.strictEqual(Object.keys(st.claims.iburrata).length, 3, 'a shared appetizer three ways');
  assert.strictEqual(Object.keys(st.claims.iwine).length, 4, 'a bottle of wine four ways');
  assert.deepStrictEqual(r.unclaimed.open.map((o) => o.itemId), ['itira'], 'exactly one unclaimed item');
  assert.deepStrictEqual([b.payerId, C.totals(b).tip, b.tip.bp], ['psam', 4270, 2000]);
  assert.strictEqual(C.check(b).status, 'ok');
  assert.strictEqual(sumTotals(r), r.grand);
  assert.match(C.summary(b, r), /^Dinner at Luigi’s - Sam paid \$275\.15\. Owes Sam: Ana \$\d+\.\d\d, Ben \$\d+\.\d\d, Cleo \$\d+\.\d\d\. \(Sam’s own share \$\d+\.\d\d\.\) Still unclaimed: \$12\.89\./);
});

/* ---------------- pure: paying ---------------- */

test('pay links: https to venmo.com, cash.app and paypal.me only, amounts and notes encoded, strict handles', () => {
  const links = C.payLinks({ venmo: '@sam-lee', cashapp: '$samlee', paypal: 'samlee' }, 2347, 'Dinner at Luigi’s & co? #1', 'USD');
  assert.deepStrictEqual(links.map((l) => l.url), [
    'https://venmo.com/sam-lee?txn=pay&amount=23.47&note=Dinner%20at%20Luigi%E2%80%99s%20%26%20co%3F%20%231',
    'https://cash.app/$samlee/23.47',
    'https://paypal.me/samlee/23.47',
  ]);
  for (const l of links) assert.strictEqual(C.safePayUrl(l.url), l.url);
  assert.deepStrictEqual(C.payLinks({ venmo: 'sam-lee', cashapp: 'samlee', paypal: 'samlee' }, 1000, 'x', 'EUR').map((l) => l.url), ['https://paypal.me/samlee/10.00EUR'], 'Venmo and Cash App are dollars only');
  assert.deepStrictEqual(C.payLinks({ venmo: 'sam-lee' }, 0, 'x', 'USD'), [], 'nothing to pay, no button');
  // Pasted profile links are read down to the handle.
  assert.deepStrictEqual([C.handleOf('venmo', 'https://venmo.com/u/Sam-Lee'), C.handleOf('venmo', 'venmo.com/sam_lee?x=1'), C.handleOf('cashapp', 'https://cash.app/$SamLee'), C.handleOf('paypal', 'paypal.me/samlee/20')], ['Sam-Lee', 'sam_lee', 'SamLee', 'samlee']);
  for (const [svc, bad] of [['venmo', 'sam'], ['venmo', 'sam lee'], ['venmo', 'x'.repeat(31)], ['venmo', '../evil'], ['venmo', 'javascript:alert(1)'], ['cashapp', '1234'], ['cashapp', 'sam-lee'], ['cashapp', 'a'.repeat(21)], ['paypal', 'sam.lee'], ['paypal', 'evil.com/x'], ['paypal', ''], ['nope', 'samlee']]) {
    assert.strictEqual(C.handleOf(svc, bad), null, `${svc}: ${bad}`);
  }
  for (const u of ['http://venmo.com/x', 'https://evil.com/venmo.com', 'https://venmo.com.evil.com/x', 'javascript:alert(1)', 'https://user:pw@paypal.me/x', 'https://cash.app:444/$x', 'data:text/html,x', 'not a url']) assert.strictEqual(C.safePayUrl(u), null, u);
  // A bill's handles are cleaned like everything else.
  assert.deepStrictEqual(C.cleanBill({ handles: { venmo: '<b>x</b>', cashapp: '$ok1', paypal: 'https://paypal.me/ok' } }).handles, { venmo: '', cashapp: 'ok1', paypal: 'ok' });
});

/* ---------------- pure: cleaning ---------------- */

test('a bill, people and claims from anywhere are cleaned: markup, bidi, bounds, ids, weights', () => {
  const b = C.cleanBill({
    title: '<script>x</script>Dinner\u202e', currency: 'XYZ',
    items: [{ id: '../x', name: '<img onerror=1>Steak', unit: '42', qty: '2' }, { name: 'Free', unit: 0 }, { name: 'Words', unit: 'lots' }, { name: '', unit: 100 }, { name: 'Huge', unit: 10000001 }, { id: 'same1', name: 'A', unit: 100, qty: 500 }, { id: 'same1', name: 'B', unit: 100, qty: 1.5 }, 'junk', null],
    tax: -5, tip: { mode: 'weird', bp: 999999, base: 'x', even: 'yes' }, fees: [{ name: 'Fee', cents: -1 }, { name: 'Svc', cents: 100, service: true, rateBp: 2000 }], payerId: 'Robert\'); DROP',
  });
  assert.strictEqual(b.title, 'x Dinner', 'tags go; the words between them are only text, drawn escaped');
  assert.strictEqual(b.currency, 'USD');
  assert.deepStrictEqual(b.items.map((i) => [i.name, i.unit, i.qty]), [['Steak', 4200, 2], ['A', 100, 99], ['B', 100, 1]]);
  assert.ok(b.items.every((i) => C.ID_RE.test(i.id)) && new Set(b.items.map((i) => i.id)).size === 3, 'ids are ids, and unique');
  assert.deepStrictEqual([b.tax, b.tip.mode, b.tip.bp, b.tip.base, b.tip.even, b.payerId], [0, 'percent', 10000, 'subtotal', false, null]);
  assert.deepStrictEqual(b.fees.map((f) => [f.name, f.cents, f.service, f.rateBp]), [['Svc', 100, true, 2000]]);
  const people = C.cleanPeople([{ name: '‮Sam\u0000', color: 'nope' }, { name: '🌮', color: 'teal' }, { name: '👩‍👩‍👧 Fam' }, { name: '<>' }, { name: 'x'.repeat(50) }]);
  assert.deepStrictEqual(people.map((p) => p.name), ['Sam', '🌮', '👩‍👩‍👧 Fam', `${'x'.repeat(19)}…`], 'emoji (and the joiner inside family emoji) survive; bidi and control characters do not');
  assert.strictEqual(people[0].color, C.COLOR_IDS[0]);
  const claims = C.cleanClaims({ [b.items[0].id]: { [people[0].id]: 2.7, nobody: 1, [people[1].id]: -1 }, ghost: { [people[0].id]: 1 }, [b.items[1].id]: { [people[1].id]: 1000 } }, b, people);
  assert.deepStrictEqual(claims, { [b.items[0].id]: { [people[0].id]: 2 }, [b.items[1].id]: { [people[1].id]: 99 } });
  assert.strictEqual(C.cleanName('   '), '');
  assert.strictEqual(C.cleanName('!!!'), '');
});

test('snap validation: hostile model output is cleaned, bounded and never invents a price', async () => {
  const client = fakeai.create();
  const raw = await ai.readReceipt(client, 'm', [{ mediaType: 'image/jpeg', data: Buffer.from('INJECT').toString('base64') }]);
  const out = ai.cleanReceipt(raw);
  const json = JSON.stringify(out);
  assert.ok(!/<[a-z/!]/i.test(json) && !json.includes('\u202e') && !json.includes('\u0000'), 'no markup, no bidi, no control characters');
  const names = out.bill.items.map((i) => i.name);
  assert.strictEqual(names[0], 'Burger');
  assert.strictEqual(names[1], `${'A'.repeat(59)}…`);
  assert.ok(!names.includes('Fifteen dollar steak'), 'a price in words is no price');
  assert.ok(!names.some((n) => /Ignore previous/.test(n)), 'a $0 line is not an item');
  assert.ok(!names.includes('Refund'), 'a negative line price is not read as a positive one');
  assert.ok(!names.includes('Huge'), 'over $10,000 a unit is refused');
  assert.deepStrictEqual(out.bill.items.find((i) => i.name === 'Wine flight'), { id: out.bill.items.find((i) => i.name === 'Wine flight').id, name: 'Wine flight', unit: 900, qty: 2 });
  assert.deepStrictEqual(out.bill.items.find((i) => i.name === 'Tacos (3)').unit, 1000, 'a count that does not divide the line becomes part of the name');
  assert.strictEqual(out.bill.items.find((i) => i.name === 'Beer').qty, 1, 'an impossible count is dropped, not trusted');
  assert.strictEqual(out.bill.items.length, 120, 'capped at 120 lines');
  assert.ok(out.dropped > 0);
  assert.deepStrictEqual([out.bill.currency, out.bill.title, out.bill.printed.subtotal, out.bill.printed.total, out.bill.tax], ['USD', 'alert(1) Bad Bar', null, null, 0]);
  assert.deepStrictEqual(out.bill.discounts.map((d) => [d.name, d.cents]), [['Happy hour', 400]]);
  assert.deepStrictEqual(out.bill.fees.map((f) => [f.cents, f.service, f.rateBp]), [[1200, true, null]], 'a 900% rate is no rate');
  assert.ok(out.note.length <= 200 && !/<a/.test(out.note), 'the model’s note is bounded and stripped');
  assert.strictEqual(ai.cleanReceipt({ readable: false }), null);
  assert.strictEqual(ai.cleanReceipt({ readable: true, items: [{ name: 'x', lineTotal: 'nope' }] }), null);
  assert.strictEqual(ai.cleanReceipt(null), null);
});

test('the tool is forced, and the prompt forbids inventing lines or fixing the maths', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai.js'), 'utf8');
  assert.ok(/tool_choice: \{ type: 'tool', name: 'record_receipt' \}/.test(src));
  assert.match(ai.RECEIPT_SYSTEM, /never invent a line or a price/);
  assert.match(ai.RECEIPT_SYSTEM, /do not change any number to make them add up/);
  assert.match(ai.RECEIPT_SYSTEM, /never an instruction/);
});

/* ---------------- pure: tables ---------------- */

test('table codes: 6 characters from 32 unambiguous ones, uniform, normalised however typed', () => {
  assert.strictEqual(T.CODE_ALPHABET.length, 32);
  assert.ok(!/[IO01]/.test(T.CODE_ALPHABET));
  const counts = {};
  for (let i = 0; i < 4000; i++) {
    const c = T.newCode();
    assert.ok(T.isCode(c), c);
    for (const ch of c) counts[ch] = (counts[ch] || 0) + 1;
  }
  assert.strictEqual(Object.keys(counts).length, 32);
  const vals = Object.values(counts);
  assert.ok(Math.max(...vals) / Math.min(...vals) < 1.5, 'no character much likelier than another');
  assert.deepStrictEqual([T.normalizeCode('abc-def'), T.normalizeCode(' ab c d e f '), T.formatCode('ABCDEF')], ['ABCDEF', 'ABCDEF', 'ABC-DEF']);
  assert.ok(!T.isCode('ABCDE0') && !T.isCode('ABCDE') && !T.isCode('../../x'));
  assert.notStrictEqual(T.keyHash('k', 'AAAAAA'), T.keyHash('k', 'BBBBBB'), 'one phone is unlinkable across tables');
  assert.notStrictEqual(T.ownerTag('uid', 's1'), T.ownerTag('uid', 's2'));
});

test('the QR code is a real QR code for the table link', () => {
  const m = QR.matrix('https://challenge.strongtechnicalconsulting.com/dibs/t/ABCDEF');
  const n = m.length;
  const finder = (r, c) => [0, 6].every((k) => m[r + k].slice(c, c + 7).every((v) => v === 1)) && m[r + 3].slice(c + 2, c + 5).every((v) => v === 1) && m[r + 1][c + 1] === 0;
  assert.ok(finder(0, 0) && finder(0, n - 7) && finder(n - 7, 0), 'three finder patterns');
  assert.ok(QR.svg('x', '<b>').includes('aria-label="b"'), 'the label is stripped of markup');
});

/* ---------------- the house rules ---------------- */

test('every text colour holds 4.5:1 on its surface, light and dark; white holds on every person colour', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const block = (re) => Object.fromEntries([...css.match(re)[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const light = block(/:root \{([^}]*)\}/);
  const dark = block(/:root\[data-theme="dark"\] \{([^}]*)\}/);
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg'], ['text', 'card'], ['text', 'card2'], ['muted', 'card'], ['muted', 'bg'], ['muted', 'card2'], ['link', 'card'], ['link', 'bg'], ['link', 'card2'], ['link', 'accent-soft'],
    ['accent-ink', 'accent'], ['pass', 'pass-bg'], ['pass', 'card'], ['breach', 'breach-bg'], ['breach', 'card'], ['warn', 'warn-bg'], ['warn', 'card'], ['text', 'warn-bg'], ['text', 'accent-soft'], ['strip-ink', 'strip'], ['muted', 'accent-soft']];
  for (const [name, t] of [['light', light], ['dark', { ...light, ...dark }]]) {
    for (const [fg, bg] of pairs) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name}: --${fg} on --${bg} is ${ratio(t[fg], t[bg]).toFixed(2)}:1`);
  }
  for (const c of C.COLORS) assert.ok(ratio('#ffffff', c.hex) >= 4.5, `white on ${c.id} is ${ratio('#ffffff', c.hex).toFixed(2)}:1`);
  for (const hex of ['#0b5fae', '#00692e', '#102a73']) assert.ok(ratio('#ffffff', hex) >= 4.5, `pay button ${hex}`);
  assert.ok(ratio('#111111', '#ffffff') >= 4.5, 'the QR code');
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { DIBS_MEMORY: '1' }], ['./lib/fakeai', { DIBS_FAKE_AI: '1' }], ['./server', { DIBS_FAKE_AI: '1', DIBS_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, DIBS_MEMORY: '', DIBS_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, DIBS_MEMORY: '', DIBS_COLLECTION_PREFIX: 'dibs_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.ok(/DIBS_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 9, 'every Firestore path is prefixed');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, nothing logged from a body', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js.replace(/\.on[a-z]+ =/g, '')), 'no handler written into markup');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.ok(!/<script/i.test(js.replace(/'<script/g, '')), 'no script written into markup');
  for (const f of ['server.js', 'lib/ai.js', 'lib/tables.js', 'lib/photo.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|photos|bill|name|items|raw)/.test(src), `${f} logs a body`);
  }
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const tableBody = () => { const s = S.state(); return { bill: s.bill, people: s.people, claims: s.claims, everyone: s.everyone, hostPid: 'psam' }; };

test('signed out: the page, the example and its files work with zero model calls; nothing private does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.limits.items, meta.limits.people, meta.limits.photos, meta.colors.length], [120, 20, 2, 12]);
  for (const f of ['dibs-core.js', 'sample.js', 'qr.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/snap'], ['POST', '/api/tables'], ['GET', '/api/tables'], ['PUT', '/api/tables/ABCDEF'], ['POST', '/api/tables/ABCDEF/lock'], ['DELETE', '/api/tables/ABCDEF'], ['POST', '/api/tables/ABCDEF/people'], ['POST', '/api/tables/ABCDEF/everyone']]) {
    assert.strictEqual((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  assert.strictEqual((await anon('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg() }] })).status, 401);
  // A stranger's 11 MB body is turned away at the door, unread...
  assert.strictEqual((await anon('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: 'A'.repeat(11 * 1024 * 1024) }] })).status, 401, 'the gate answers before the big parser');
  // ...and every other route keeps the small limit.
  assert.strictEqual((await anon('POST', '/api/tables', { x: 'x'.repeat(100 * 1024) })).status, 413);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the snap route’s gates come before its 12 MB parser, in order', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/snap', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  for (const [p, m] of [['/api/tables', 'get'], ['/api/tables', 'post'], ['/api/tables/:code', 'put'], ['/api/tables/:code', 'delete'], ['/api/tables/:code/lock', 'post']]) assert.strictEqual(layer(p, m).route.stack[0].handle.name, 'requireUser', `${m} ${p}`);
  // No guest route can reach a model: nothing but /api/snap holds a client.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1);
});

let sam;

test('snap the receipt: photos checked before any spend, one metered call, a proposal, nothing stored', async () => {
  sam = await register('sam.host@example.com');
  const dump = store._dump();
  let calls = await modelCalls();
  assert.strictEqual((await sam('POST', '/api/snap', {})).status, 400);
  assert.strictEqual((await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: Buffer.from('%PDF-1.4 not a photo').toString('base64') }] })).status, 400);
  assert.strictEqual((await sam('POST', '/api/snap', { photos: Array.from({ length: 3 }, () => ({ type: 'image/jpeg', data: jpeg() })) })).status, 400, 'three photos');
  assert.strictEqual((await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: 'A'.repeat(6 * 1024 * 1024) }] })).status, 400, 'one photo over 4 MB');
  assert.strictEqual((await sam('POST', '/api/snap', { photos: [{ type: 'image/gif', data: jpeg() }] })).status, 400);
  assert.strictEqual((await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: 'A'.repeat(13 * 1024 * 1024) }] })).status, 413, 'over the 12 MB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const r = await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg('top') }, { type: 'image/jpeg', data: jpeg('bottom') }] });
  assert.strictEqual(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.text.startsWith(' '), 'the answer streams whitespace first');
  assert.strictEqual(r.data.bill.items.length, 10);
  assert.deepStrictEqual(r.data.bill.items.slice(0, 2).map((i) => [i.name, i.unit, i.qty]), [['Burrata', 1650, 1], ['Margarita', 1200, 2]]);
  assert.deepStrictEqual([r.data.bill.title, r.data.check.status, r.data.bill.printed.total], ['Luigi\'s Trattoria', 'ok', 23245]);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const mm = await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg('MISMATCH') }] });
  assert.deepStrictEqual([mm.data.check.status, mm.data.check.text], ['short', 'Items add up to $42.00 less than the receipt - a line may be missing.']);
  assert.match(mm.data.note, /printed subtotal/);
  const svc = await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg('SERVICE') }] });
  assert.deepStrictEqual([svc.data.bill.tip.cents, svc.data.bill.tip.mode], [0, 'amount']);
  assert.match(svc.data.serviceNote, /^A 20% service charge is already on this bill/);
  const inj = await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg('INJECT') }] });
  assert.ok(!/<[a-z/!]/i.test(inj.text), 'no markup reaches the page');
  assert.strictEqual(inj.data.bill.items.length, 120);
  const blank = await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg('BLANK') }] });
  assert.deepStrictEqual([blank.status, /No lines with prices/.test(blank.data.error)], [200, true], 'after the stream starts, a failure is a 200 {error}');
  assert.match((await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg('MAXTOKENS') }] })).data.error, /ran longer than one reading/);
  const up = await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg('UPSTREAM401') }] });
  assert.ok(up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  assert.match((await sam('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg('UPSTREAM529') }] })).data.error, /AI is busy/);
  const after = store._dump();
  assert.strictEqual(after, dump, 'snapping stores nothing');
  assert.ok(!after.includes(MARK), 'no photo bytes anywhere');
});

test('an unconfirmed free account gets the verify-email 403, before any model call or big body', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg() }] });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.match(r.data.error, /Confirm your email/);
    assert.strictEqual(r.data.resend, '/dibs/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: 'A'.repeat(14 * 1024 * 1024) }] })).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/tables', tableBody())).status, 200, 'sharing needs no AI and no confirmed address');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
});

test('out of credit: 402 before any model call - and before the big body is read', async () => {
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  const r = await cal('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: jpeg() }] });
  assert.strictEqual(r.status, 402);
  assert.match(r.data.detail, /Top up/, 'the 402 says how to keep going');
  assert.strictEqual((await cal('POST', '/api/snap', { photos: [{ type: 'image/jpeg', data: 'A'.repeat(14 * 1024 * 1024) }] })).status, 402, '402, not 413');
  assert.strictEqual((await cal('POST', '/api/tables', tableBody())).status, 200, 'sharing is free');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call was made');
});

let CODE;

test('a host shares a bill; a guest with no account sees it, joins by name, and gets an opaque id', async () => {
  const r = await sam('POST', '/api/tables', tableBody());
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  CODE = r.data.code;
  assert.ok(T.isCode(CODE));
  assert.strictEqual(r.data.display, `${CODE.slice(0, 3)}-${CODE.slice(3)}`);
  assert.deepStrictEqual(r.data.people.map((p) => [p.name, p.host, p.joined]), [['Sam', true, true], ['Ana', false, false], ['Ben', false, false], ['Cleo', false, false]]);
  assert.strictEqual(r.data.me, r.data.people[0].id);
  assert.ok(r.data.people.every((p) => !['psam', 'pana', 'pben', 'pcleo'].includes(p.id)), 'fresh ids for the table');
  assert.strictEqual(r.data.bill.payerId, r.data.me);
  assert.strictEqual(Object.keys(r.data.claims).length, 9, 'the host’s dibs so far came with the bill');
  const guest = client();
  const v = await guest('GET', `/api/table/${CODE.toLowerCase().replace(/(...)/, '$1-')}`);
  assert.strictEqual(v.status, 200, 'the code is read however it is typed');
  assert.deepStrictEqual([v.data.me, v.data.host], [null, false]);
  assert.strictEqual(v.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(v.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.strictEqual(v.headers.get('cache-control'), 'no-store');
  assert.ok(!/ownerTag|keyHash|sam\.host|example\.com/.test(v.text), 'no owner tag, key hash or email reaches a guest');
  assert.strictEqual(guest.cookies.dibs_k, undefined, 'looking mints nothing');
  const ana = v.data.people.find((p) => p.name === 'Ana');
  const j = await guest('POST', `/api/table/${CODE}/join`, { pid: ana.id });
  assert.strictEqual(j.status, 200, JSON.stringify(j.data));
  assert.strictEqual(j.data.me, ana.id);
  const ck = j.setCookie.find((c) => c.startsWith('dibs_k='));
  assert.match(ck, /^dibs_k=[A-Za-z0-9_-]{22}; Path=\/dibs\/; Max-Age=\d+; SameSite=Lax; HttpOnly/, 'HttpOnly, scoped to the app path');
  assert.strictEqual((await guest('GET', `/api/table/${CODE}`)).data.me, ana.id, 'the same browser is the same person');
  const again = await guest('POST', `/api/table/${CODE}/join`, { name: 'Someone else' });
  assert.strictEqual(again.data.me, ana.id, 'a browser that joined gets itself back, not a second person');
  const other = client();
  const taken = await other('POST', `/api/table/${CODE}/join`, { pid: ana.id });
  assert.deepStrictEqual([taken.status, /already joined on another phone/.test(taken.data.error)], [409, true]);
  const kai = await other('POST', `/api/table/${CODE}/join`, { name: '<b>Kai</b> 🌮\u202e', color: 'teal' });
  assert.strictEqual(kai.status, 200);
  const me = kai.data.people.find((p) => p.id === kai.data.me);
  assert.deepStrictEqual([me.name, me.color, me.joined], ['Kai 🌮', 'teal', true]);
  assert.strictEqual((await client()('POST', `/api/table/${CODE}/join`, { name: '  ' })).status, 400);
  assert.strictEqual((await sam('POST', `/api/table/${CODE}/join`, { name: 'Sam again' })).status, 409, 'the host is already at their own table');
});

test('a guest changes only their own dibs, name and paid mark; the host can change anyone’s', async () => {
  const ana = client();
  let v = (await ana('GET', `/api/table/${CODE}`)).data;
  const ben = v.people.find((p) => p.name === 'Ben');
  const cleo = v.people.find((p) => p.name === 'Cleo');
  v = (await ana('POST', `/api/table/${CODE}/join`, { pid: ben.id })).data;
  const tira = v.bill.items.find((i) => i.name === 'Tiramisu').id;
  const marg = v.bill.items.find((i) => i.name === 'Margarita').id;
  let r = await ana('POST', `/api/table/${CODE}/claim`, { itemId: tira, weight: 1 });
  assert.deepStrictEqual(r.data.claims[tira], { [ben.id]: 1 });
  r = await ana('POST', `/api/table/${CODE}/claim`, { itemId: marg, weight: 2 });
  assert.strictEqual(r.data.claims[marg][ben.id], 2, 'units on a multi-quantity line');
  assert.strictEqual((await ana('POST', `/api/table/${CODE}/claim`, { itemId: tira, pid: cleo.id, weight: 1 })).status, 403, 'not someone else’s dibs');
  assert.strictEqual((await ana('POST', `/api/table/${CODE}/claim`, { itemId: 'nope', weight: 1 })).status, 404);
  assert.strictEqual((await ana('POST', `/api/table/${CODE}/claim`, { itemId: tira, weight: 1.5 })).status, 400);
  assert.strictEqual((await ana('POST', `/api/table/${CODE}/claim`, { itemId: tira, weight: 100 })).status, 400);
  assert.strictEqual((await ana('POST', `/api/table/${CODE}/person`, { pid: cleo.id, name: 'Hacked' })).status, 403);
  assert.strictEqual((await ana('POST', `/api/table/${CODE}/person`, { name: 'Benji', color: 'plum' })).data.people.find((p) => p.id === ben.id).name, 'Benji');
  assert.strictEqual((await ana('POST', `/api/table/${CODE}/person`, { color: 'nope' })).status, 400);
  assert.strictEqual((await ana('POST', `/api/table/${CODE}/paid`, { pid: cleo.id, paid: true })).status, 403);
  r = await ana('POST', `/api/table/${CODE}/paid`, { paid: true, confirmed: true });
  assert.deepStrictEqual([r.status, r.data.paid[ben.id].confirmed], [200, false], 'a guest cannot confirm their own payment');
  // Host-only routes: a guest has no account (401); the everyone flag is the host's.
  assert.strictEqual((await ana('PUT', `/api/tables/${CODE}`, { bill: v.bill })).status, 401);
  assert.strictEqual((await ana('POST', `/api/tables/${CODE}/everyone`, { itemId: tira, on: true })).status, 401);
  // The host: anyone's dibs, confirm, the everyone flag, add and remove people, rename anyone.
  r = await sam('POST', `/api/table/${CODE}/claim`, { itemId: tira, pid: cleo.id, weight: 1 });
  assert.deepStrictEqual(r.data.claims[tira], { [ben.id]: 1, [cleo.id]: 1 });
  r = await sam('POST', `/api/table/${CODE}/paid`, { pid: ben.id, paid: true, confirmed: true });
  assert.strictEqual(r.data.paid[ben.id].confirmed, true);
  assert.strictEqual((await sam('POST', `/api/table/${CODE}/paid`, { pid: r.data.me, paid: true })).status, 400, 'the payer does not owe themselves');
  r = await sam('POST', `/api/tables/${CODE}/everyone`, { itemId: tira, on: true });
  assert.strictEqual(r.data.everyone[tira], true);
  r = await sam('POST', `/api/tables/${CODE}/people`, { name: 'Dee' });
  const dee = r.data.added;
  assert.ok(r.data.people.some((p) => p.id === dee && !p.joined));
  r = await sam('POST', `/api/table/${CODE}/person`, { pid: cleo.id, name: 'Cleo P' });
  assert.strictEqual(r.data.people.find((p) => p.id === cleo.id).name, 'Cleo P');
  r = await sam('DELETE', `/api/tables/${CODE}/people/${dee}`);
  assert.ok(!r.data.people.some((p) => p.id === dee));
  assert.strictEqual((await sam('DELETE', `/api/tables/${CODE}/people/${r.data.me}`)).status, 409, 'the host cannot remove themselves');
  // Freeing a name lets another phone take it; the old phone is no longer it.
  r = await sam('DELETE', `/api/tables/${CODE}/people/${ben.id}?release=1`);
  assert.strictEqual(r.data.people.find((p) => p.id === ben.id).joined, false);
  assert.strictEqual((await ana('GET', `/api/table/${CODE}`)).data.me, null);
  assert.strictEqual((await ana('POST', `/api/table/${CODE}/claim`, { itemId: tira, weight: 0 })).status, 403);
});

test('the host edits the bill: dibs on removed lines go, the payer and handles are cleaned; locking stops guests', async () => {
  const guest = client();
  let v = (await guest('GET', `/api/table/${CODE}`)).data;
  const cleo = v.people.find((p) => p.name === 'Cleo P');
  await guest('POST', `/api/table/${CODE}/join`, { pid: cleo.id });
  const b = v.bill;
  const water = b.items.find((i) => i.name === 'Sparkling Water');
  b.items = b.items.filter((i) => i !== water);
  b.handles = { venmo: '@sam-lee', cashapp: 'bad tag!', paypal: '' };
  b.tip = { ...b.tip, bp: 1800 };
  b.payerId = 'pnobody';
  let r = await sam('PUT', `/api/tables/${CODE}`, { bill: b });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.bill.items.length, 9);
  assert.strictEqual(r.data.claims[water.id], undefined, 'dibs on a removed line are dropped');
  assert.deepStrictEqual(r.data.bill.handles, { venmo: 'sam-lee', cashapp: '', paypal: '' });
  assert.strictEqual(r.data.bill.payerId, r.data.me, 'an unknown payer falls back to the one before');
  assert.strictEqual(r.data.bill.tip.bp, 1800);
  assert.strictEqual((await sam('PUT', `/api/tables/${CODE}`, { bill: { items: [] } })).status, 400);
  r = await sam('POST', `/api/tables/${CODE}/lock`, { locked: true });
  assert.strictEqual(r.data.locked, true);
  const burrata = r.data.bill.items.find((i) => i.name === 'Burrata').id;
  const locked = await guest('POST', `/api/table/${CODE}/claim`, { itemId: burrata, weight: 1 });
  assert.deepStrictEqual([locked.status, /locked/.test(locked.data.error)], [409, true]);
  assert.strictEqual((await guest('POST', `/api/table/${CODE}/paid`, { paid: true })).status, 200, 'paying up still works on a locked bill');
  assert.strictEqual((await sam('POST', `/api/table/${CODE}/claim`, { itemId: burrata, pid: cleo.id, weight: 2 })).status, 200, 'the host can still fix a locked bill');
  assert.strictEqual((await sam('POST', `/api/tables/${CODE}/lock`, { locked: false })).data.locked, false);
});

test('two phones calling dibs at the same moment both stick', async () => {
  const r = await sam('POST', '/api/tables', tableBody());
  const code = r.data.code;
  const phones = [];
  for (let i = 0; i < 6; i++) {
    const p = client();
    await p('POST', `/api/table/${code}/join`, { name: `Guest ${i}` });
    phones.push(p);
  }
  const items = r.data.bill.items.map((i) => i.id);
  // Every phone claims three lines at once, all fired together.
  const calls = [];
  phones.forEach((p, k) => { for (let j = 0; j < 3; j++) calls.push(p('POST', `/api/table/${code}/claim`, { itemId: items[(k + j) % items.length], weight: 1 })); });
  const results = await Promise.all(calls);
  assert.ok(results.every((x) => x.status === 200), results.map((x) => x.status).join(','));
  const final = (await sam('GET', `/api/table/${code}`)).data;
  const mine = {};
  for (const p of final.people) mine[p.name] = Object.values(final.claims).filter((row) => row[p.id]).length;
  for (let i = 0; i < 6; i++) assert.ok(mine[`Guest ${i}`] >= 3, `Guest ${i} kept all three dibs: ${JSON.stringify(mine)}`);
  assert.strictEqual(final.v, 1 + 6 + 18, 'every write moved the version once');
  // The queue is what keeps them: the same two writes without it lose one.
  await store.set('race', 'doc', { claims: {} });
  const naive = (who) => store._unsafeUpdate('race', 'doc', (cur) => ({ claims: { ...cur.claims, [who]: 1 } }));
  await Promise.all([naive('a'), naive('b')]);
  assert.strictEqual(Object.keys((await store.get('race', 'doc')).claims).length, 1, 'without the transaction one claim is lost');
  await store.set('race', 'doc', { claims: {} });
  const safe = (who) => store.transact('race', 'doc', (cur) => ({ claims: { ...cur.claims, [who]: 1 } }));
  await Promise.all([safe('a'), safe('b'), safe('c')]);
  assert.deepStrictEqual(Object.keys((await store.get('race', 'doc')).claims).sort(), ['a', 'b', 'c']);
  await store.remove('race', 'doc');
});

test('polling is cheap: ?since=<v> answers "same" until something moves', async () => {
  const g = client();
  const v = (await g('GET', `/api/table/${CODE}`)).data;
  const same = await g('GET', `/api/table/${CODE}?since=${v.v}`);
  assert.deepStrictEqual(same.data, { same: true, v: v.v, me: null, host: false });
  await sam('POST', `/api/tables/${CODE}/lock`, { locked: false });
  const moved = await g('GET', `/api/table/${CODE}?since=${v.v}`);
  assert.strictEqual(moved.data.v, v.v + 1);
  assert.ok(moved.data.bill);
});

test('limits: 20 people a table, new guests per address, wrong codes per address', async () => {
  const r = await sam('POST', '/api/tables', tableBody());
  const code = r.data.code;
  const ip = freshIp();
  for (let i = 0; i < 16; i++) assert.strictEqual((await client(ip)('POST', `/api/table/${code}/join`, { name: `P${i}` })).status, 200, `guest ${i}`);
  const full = await client(freshIp())('POST', `/api/table/${code}/join`, { name: 'One too many' });
  assert.deepStrictEqual([full.status, /full - 20 people/.test(full.data.error)], [409, true]);
  // The same address has now added 16 new guests; 14 more pass, then 429.
  const r2 = await sam('POST', '/api/tables', tableBody());
  for (let i = 0; i < 14; i++) assert.strictEqual((await client(ip)('POST', `/api/table/${r2.data.code}/join`, { name: `Q${i}` })).status, 200, `new guest ${i}`);
  const limited = await client(ip)('POST', `/api/table/${r2.data.code}/join`, { name: 'Q14' });
  assert.deepStrictEqual([limited.status, /Too many new guests/.test(limited.data.error)], [429, true]);
  assert.strictEqual((await client()('POST', `/api/table/${r2.data.code}/join`, { name: 'From elsewhere' })).status, 200, 'another address is unaffected');
  // Wrong codes: the same dead code polled again counts once...
  const guesser = client();
  for (let i = 0; i < 40; i++) assert.strictEqual((await guesser('GET', '/api/table/ZZZZZZ')).status, 404);
  assert.strictEqual((await guesser('GET', `/api/table/${CODE}`)).status, 200, 'a dead code polled is not guessing');
  // ...but 30 different ones lock the address out, the right code included.
  const alpha = T.CODE_ALPHABET;
  let n = 0;
  for (let i = 0; n < 30; i++) {
    const c = `Z${alpha[i % 32]}${alpha[Math.floor(i / 32) % 32]}ZZZ`;
    if (c === CODE) continue;
    await guesser('GET', `/api/table/${c}`);
    n++;
  }
  const blocked = await guesser('GET', `/api/table/${CODE}`);
  assert.deepStrictEqual([blocked.status, /Too many wrong codes/.test(blocked.data.error)], [429, true]);
  assert.strictEqual((await client()('GET', `/api/table/${CODE}`)).status, 200, 'another address is unaffected');
});

test('a host has at most 20 open tables; the list shows theirs only', async () => {
  const hana = await register('hana.host@example.com');
  for (let i = 0; i < 20; i++) assert.strictEqual((await hana('POST', '/api/tables', tableBody())).status, 200, `table ${i}`);
  const r = await hana('POST', '/api/tables', tableBody());
  assert.deepStrictEqual([r.status, /20 tables open/.test(r.data.error)], [409, true]);
  const list = (await hana('GET', '/api/tables')).data;
  assert.strictEqual(list.tables.length, 20);
  assert.deepStrictEqual(Object.keys(list.tables[0]).sort(), ['code', 'createdAt', 'currency', 'display', 'expiresAt', 'grand', 'locked', 'people', 'title', 'unclaimed'].sort());
  assert.ok(!(await hana('GET', '/api/tables')).data.tables.some((t) => t.code === CODE), 'not another host’s');
});

test('another host’s table is a 404 on every host route; a guest page and link work', async () => {
  const other = await register('olly.other@example.com');
  for (const [m, p, b] of [['PUT', `/api/tables/${CODE}`, { bill: tableBody().bill }], ['POST', `/api/tables/${CODE}/lock`, {}], ['DELETE', `/api/tables/${CODE}`], ['POST', `/api/tables/${CODE}/people`, { name: 'x' }], ['DELETE', `/api/tables/${CODE}/people/pxxxx`], ['POST', `/api/tables/${CODE}/everyone`, { itemId: 'x', on: true }]]) {
    const r = await other(m, p, b);
    assert.strictEqual(r.status, 404, `${m} ${p}`);
    assert.strictEqual(r.data.error, 'No table has that code.', 'the same answer as a code that does not exist');
  }
  const v = (await other('GET', `/api/table/${CODE}`)).data;
  assert.deepStrictEqual([v.host, v.me], [false, null], 'a signed-in stranger is just a guest');
  const page = await fetch(`${base}/t/${CODE}`);
  const html = await page.text();
  assert.ok(html.includes('<base href="../">'), 'the table page resolves assets from the app root');
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await fetch(`${base}/t/${CODE}`, { method: 'POST' })).status, 405);
});

test('tables expire after 14 days, checked and deleted on read; a deleted table is gone for everyone', async () => {
  const r = await sam('POST', '/api/tables', tableBody());
  const code = r.data.code;
  const doc = await store.get('tables', code);
  assert.strictEqual(Date.parse(doc.expiresAt) - Date.parse(doc.createdAt), 14 * 24 * 3600 * 1000);
  await store.merge('tables', code, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const g = await client()('GET', `/api/table/${code}`);
  assert.deepStrictEqual([g.status, g.data.code, /closed - tables last 14 days/.test(g.data.error)], [404, 'expired', true]);
  assert.strictEqual(await store.get('tables', code), null, 'deleted on the read that found it');
  const r2 = await sam('POST', '/api/tables', tableBody());
  const guest = client();
  await guest('POST', `/api/table/${r2.data.code}/join`, { name: 'Zed' });
  assert.strictEqual((await sam('DELETE', `/api/tables/${r2.data.code}`)).status, 200);
  assert.strictEqual((await guest('GET', `/api/table/${r2.data.code}`)).status, 404);
  assert.strictEqual((await guest('POST', `/api/table/${r2.data.code}/claim`, { itemId: 'x', weight: 1 })).status, 404);
  assert.strictEqual(await store.get('tables', r2.data.code), null);
});

test('a table stores the bill, names, colours, claims and paid marks - no email, no account id, no key, no photo', async () => {
  const doc = await store.get('tables', CODE);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['bill', 'claims', 'code', 'createdAt', 'everyone', 'expiresAt', 'id', 'locked', 'ownerTag', 'paid', 'people', 'updatedAt', 'v'].sort());
  for (const p of doc.people) assert.deepStrictEqual(Object.keys(p).sort(), ['color', 'host', 'id', 'keyHash', 'name'].sort());
  const dump = store._dump();
  for (const email of ['sam.host@example.com', 'hana.host@example.com', 'olly.other@example.com', 'eve.unconfirmed@example.com']) {
    assert.ok(!dump.includes(email), `no email: ${email}`);
    assert.ok(!dump.includes(uidOf(email)), `no account id: ${email}`);
  }
  assert.ok(!dump.includes(MARK) && !dump.includes('/9j/'), 'no photo bytes');
  const g = client();
  await g('POST', `/api/table/${CODE}/join`, { name: 'Keyholder' });
  assert.ok(g.cookies.dibs_k && !store._dump().includes(g.cookies.dibs_k), 'the guest key itself is never stored');
  assert.strictEqual(doc.ownerTag, T.ownerTag(uidOf('sam.host@example.com'), 'local-dev-secret'));
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.set('trust proxy', 1);
  host.use('/dibs', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/dibs`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
