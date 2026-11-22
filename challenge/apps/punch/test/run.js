// The rules first - pins and their states, numbering, the text doors, the
// one door for a book, the lists by trade, the closeout and the close-up
// crop - then THE MERGE, hard: two phones on one job editing different
// pins, the same pin's different parts, the same part, a removed pin
// against an edited one (both orders), two new pins with one number, a
// removed area or job against a pin changed later, the sign-off; then
// hundreds of random pairs and triples (symmetric, idempotent, convergent,
// always through the strict door, never two live pins with one number).
// Then the demo's story, the storage module, the look, the page's promises
// and the copy; then end to end against the memory store:
//   PUNCH_MEMORY=1 PUNCH_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /punch, the way
// the lab mounts it, so the auth cookie and each route's parser order are
// exercised as deployed. Punch makes no model call: the suite checks no
// usage row is ever written.
//
// Every job, client and name here is made up. Phone, card, tax-id and
// account numbers are built from pieces, so no file carries any of them.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.PUNCH_MEMORY !== '1' || process.env.PUNCH_FAKE_AI !== '1') {
  console.error('run with PUNCH_MEMORY=1 PUNCH_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, ownerTag } = require('../server');
const C = require('../public/punch-core');
const D = require('../public/demo');
const RS = require('../public/punch-store');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = String.fromCharCode(64);
const ch = (n) => String.fromCharCode(n);
const RLO = ch(0x202E), FW_AT = ch(0xFF20);
const clone = (v) => JSON.parse(JSON.stringify(v));
const PHONE = ['555', '201', '3344'].join(' ');
const CARD = ['4111'].concat(Array(3).fill('1111')).join(' ');
const TAXID = ['123', '45', '6789'].join('-');
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('not really a jpeg').toString('base64');

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

const J = 'jjob000001', A1 = 'aarea00001', A2 = 'aarea00002';
const pid = (n) => 'ppin' + String(n).padStart(6, '0');
const f = (o) => Object.assign({ area: A1, x: 500, y: 500, trade: 'Paint', pri: 'normal', due: '', note: 'Touch up the wall' }, o);
/** A job with two areas and three pins, all at times under 100. */
function start0() {
  let b = C.newBook(1);
  b = C.putJob(b, J, 'Unit 4 turnover', 'Rowan Ilves', 10);
  b = C.putArea(b, A1, J, 'Kitchen', 1333, 11);
  b = C.putArea(b, A2, J, 'Bath', 750, 12);
  b = C.addItem(b, pid(1), f({ note: 'Scuffed wall by the door', x: 100, y: 200 }), 20);
  b = C.addItem(b, pid(2), f({ trade: 'Tile', note: 'Cracked tile at the tub', area: A2 }), 21);
  b = C.addItem(b, pid(3), f({ trade: 'Electrical', note: 'Outlet cover missing', pri: 'high', due: '2026-11-25' }), 22);
  return b;
}
const both = (a, b, since) => { const x = C.merge(a, b, since), y = C.merge(b, a, since); assert.ok(C.same(x.book, y.book), 'symmetric'); return x; };
const strictOk = (b) => assert.deepStrictEqual(C.cleanBook(b, true).errors, [], 'through the strict door');
function noDupes(b) {
  const seen = {};
  for (const [id, it] of Object.entries(b.items)) {
    if (it.del) continue;
    const k = it.job + '#' + it.n;
    assert.ok(!seen[k], `two live pins numbered ${k}: ${seen[k]} and ${id}`);
    seen[k] = id;
  }
}

/* ================================================================== *
 * The rules
 * ================================================================== */

test('a pin: numbered next on its job, open, with its trade, priority, due and note; fixed and verified carry the day; reopening clears it; numbers never reused after a removal', () => {
  let b = start0();
  const it = b.items[pid(3)];
  assert.deepStrictEqual([it.n, it.state, it.sd, it.pri, it.due, it.x, it.y, it.c, it.tp, it.tw, it.ts], [3, 'open', '', 'high', '2026-11-25', 500, 500, 22, 22, 22, 22]);
  b = C.setState(b, pid(3), 'fixed', '2026-11-22', 30);
  assert.deepStrictEqual([b.items[pid(3)].state, b.items[pid(3)].sd, b.items[pid(3)].ts, b.items[pid(3)].tw], ['fixed', '2026-11-22', 30, 22], 'only the state part moved');
  b = C.setState(b, pid(3), 'verified', '2026-11-23', 31);
  b = C.setState(b, pid(3), 'open', '2026-11-24', 32);
  assert.deepStrictEqual([b.items[pid(3)].state, b.items[pid(3)].sd], ['open', '']);
  b = C.removeItem(b, pid(3), 33);
  assert.deepStrictEqual(b.items[pid(3)], { del: true, t: 33 });
  b = C.addItem(b, pid(4), f({}), 34);
  assert.strictEqual(b.items[pid(4)].n, 3, 'the highest live number is 2, so the next is 3 - a removed number is free again only when it was the last');
  b = C.moveItem(b, pid(4), 1200, -5, 35);
  assert.deepStrictEqual([b.items[pid(4)].x, b.items[pid(4)].y, b.items[pid(4)].tp, b.items[pid(4)].tw], [1000, 0, 35, 34], 'clamped onto the photo; only the place part moved');
  assert.deepStrictEqual(C.counts(C.itemsOf(b, J)), { open: 3, fixed: 0, verified: 0, total: 3 });
  assert.deepStrictEqual(C.itemsOf(b, J, A2).map((x) => x.n), [2]);
  strictOk(b);
});

test('the text door: a job, client, area, trade, note and signer refuse an @, a link, a phone, nine digits, a card, markup, a formula and invisible characters; ordinary site words (Unit 4B, 2x4, 1/2 inch, a date) pass', () => {
  for (const bad of ['call ' + PHONE, 'mail me' + AT + 'x', 'x' + FW_AT + 'y', 'see www.example.com', 'tile.house', CARD, TAXID, '<b>x</b>', '=SUM(A1)', 'Paint' + RLO, ch(0x0663).repeat(9)]) {
    for (const fn of [C.noteProblem, C.jobNameProblem, C.areaNameProblem, C.tradeProblem, C.signerProblem]) assert.ok(fn(bad), `${fn.name} refuses ${JSON.stringify(bad)}`);
  }
  for (const good of ['Unit 4B turnover', 'Replace 2x4 blocking - 1/2 inch gap', 'Due 2026-11-25 per the GC', 'Re-caulk tub & shower', 'Café counter']) assert.strictEqual(C.noteProblem(good), '', good);
  assert.ok(C.noteProblem(''), 'a note is needed');
  assert.ok(C.noteProblem('x'.repeat(241)));
  assert.strictEqual(C.clientProblem(''), '', 'the client is optional');
  assert.ok(C.jobNameProblem('two\nlines'));
});

test('days: real calendar dates only; overdue is an open pin past its due date (a fixed one is not); the pretty forms', () => {
  assert.ok(C.isDay('2028-02-29') && !C.isDay('2027-02-29') && !C.isDay('2026-13-01') && !C.isDay('2026-1-1') && !C.isDay(''));
  const it = { state: 'open', due: '2026-11-21' };
  assert.ok(C.overdue(it, '2026-11-22') && !C.overdue(it, '2026-11-21') && !C.overdue({ ...it, state: 'fixed' }, '2026-11-30') && !C.overdue({ state: 'open', due: '' }, '2026-11-30'));
  assert.deepStrictEqual([C.fmtDay('2026-11-22'), C.shortDay('2026-01-05')], ['Nov 22, 2026', 'Jan 5']);
});

test('the one door: strict refuses anything out of shape, whole (unknown fields, a photo field, a float place, a bad state or priority, a pin whose area is missing, a bad id, a refused note, a sign-off with a picture); lenient mends and drops; bodyProblem refuses anything that looks like a picture first', () => {
  const b = start0();
  strictOk(b);
  const variants = [
    ['an unknown top field', (x) => { x.photos = {}; }],
    ['a photo on a pin', (x) => { x.items[pid(1)].photo = 'x'; }],
    ['a float x', (x) => { x.items[pid(1)].x = 10.5; }],
    ['a y off the photo', (x) => { x.items[pid(1)].y = 1001; }],
    ['a state', (x) => { x.items[pid(1)].state = 'done'; }],
    ['a priority', (x) => { x.items[pid(1)].pri = 'urgent'; }],
    ['a due date', (x) => { x.items[pid(1)].due = '2026-02-30'; }],
    ['a pin in a missing area', (x) => { x.items[pid(1)].area = 'anothere01'; }],
    ['a pin whose job is not its area’s', (x) => { x.items[pid(1)].job = 'jother0001'; }],
    ['a bad id', (x) => { x.items['../x'] = x.items[pid(1)]; }],
    ['a phone in a note', (x) => { x.items[pid(1)].note = 'call ' + PHONE; }],
    ['a time as a string', (x) => { x.items[pid(1)].tw = '5'; }],
    ['a sign-off with a picture field', (x) => { x.signs[J] = { name: 'Rowan Ilves', date: '2026-11-22', open: 1, fixed: 0, verified: 0, t: 5, img: 'x' }; }],
    ['a sign-off with no job', (x) => { x.signs.jnojob0001 = { name: 'Rowan Ilves', date: '2026-11-22', open: 1, fixed: 0, verified: 0, t: 5 }; }],
    ['an area with no shape', (x) => { x.areas[A1].ar = 99999; }],
    ['a removed pin with leftovers', (x) => { x.items[pid(1)] = { del: true, t: 5, note: 'x' }; }],
  ];
  for (const [what, fn] of variants) { const x = clone(b); fn(x); assert.ok(C.cleanBook(x, true).errors.length, what); }
  const lenient = clone(b); lenient.items[pid(1)].photo = 'x'; lenient.items[pid(2)].note = 'call ' + PHONE;
  const kept = C.cleanBook(lenient).book;
  assert.ok(kept.items[pid(1)] && !('photo' in kept.items[pid(1)]) && !kept.items[pid(2)], 'lenient: the extra field gone, the refused pin dropped');
  assert.match(C.bodyProblem({ a: JPEG }), /picture/);
  assert.match(C.bodyProblem({ a: 'iVBOR base64 stuff' }), /picture/);
  assert.match(C.bodyProblem({ a: ['x' + AT + 'y'] }), /@/);
  assert.match(C.bodyProblem({ ['k' + RLO]: 1 }), /invisible/, 'keys are checked too');
  assert.strictEqual(C.bodyProblem(b), '');
});

test('lists by trade: open fixes only by default, A-Z by trade, high priority first then the soonest due; as text with the room, priority and due, "(overdue)" past it; "to check" lists the fixed ones; a trade with nothing is not listed', () => {
  let b = start0();
  b = C.addItem(b, pid(4), f({ note: 'Second coat on the closet door', pri: 'high', due: '2026-11-24' }), 23);
  b = C.addItem(b, pid(5), f({ note: 'Patch the nail pops', trade: 'paint', due: '2026-11-20' }), 24);
  b = C.setState(b, pid(3), 'fixed', '2026-11-22', 30);
  const g = C.byTrade(b, J);
  assert.deepStrictEqual(g.map((x) => [x.trade, x.items.map((i) => i.n)]), [['Paint', [4, 5, 1]], ['Tile', [2]]], 'Electrical is fixed, so not open; "paint" and "Paint" are one trade');
  assert.strictEqual(C.tradeText(b, J, 'PAINT', '2026-11-22'), 'Unit 4 turnover - Paint (3 items)\n[ ] #4 - Kitchen - Second coat on the closet door - High priority - due Nov 24\n[ ] #5 - Kitchen - Patch the nail pops - due Nov 20 (overdue)\n[ ] #1 - Kitchen - Scuffed wall by the door\n');
  assert.strictEqual(C.tradeText(b, J, 'Electrical', '2026-11-22', 'fixed'), 'Unit 4 turnover - Electrical (1 item to check)\n[ ] #3 - Kitchen - Outlet cover missing - High priority - due Nov 25 - fixed\n');
  assert.strictEqual(C.tradeText(b, J, 'Electrical', '2026-11-22'), '', 'nothing open for the electrician');
  assert.strictEqual(C.byTrade(b, J, 'all').reduce((n, x) => n + x.items.length, 0), 5);
});

test('the closeout and the sign-off: areas with their pins, the before/after pairs (every pin past open), the counts the client signed against, and how many pins changed after; cleared, it is gone', () => {
  let b = start0();
  b = C.setState(b, pid(1), 'fixed', '2026-11-22', 30);
  b = C.setState(b, pid(2), 'verified', '2026-11-22', 31);
  b = C.sign(b, J, 'Rowan Ilves', '2026-11-22', 40);
  let co = C.closeout(b, J);
  assert.deepStrictEqual(co.areas.map((a) => [a.area.name, a.items.map((i) => i.n)]), [['Kitchen', [1, 3]], ['Bath', [2]]]);
  assert.deepStrictEqual(co.pairs.map((i) => i.n), [1, 2]);
  assert.deepStrictEqual(co.sign, { name: 'Rowan Ilves', date: '2026-11-22', open: 1, fixed: 1, verified: 1, t: 40, changed: 0 });
  b = C.setState(b, pid(3), 'fixed', '2026-11-23', 50);
  assert.strictEqual(C.closeout(b, J).sign.changed, 1, 'a pin changed after signing is counted');
  b = C.unsign(b, J, 60);
  assert.strictEqual(C.signOf(b, J), null);
  strictOk(b);
});

test('the close-up crop: the pin in the middle of a 4:3 box when it can be, pushed to the edge when the photo ends; a photo shorter than the box centred; the marker always on the pin', () => {
  const mid = C.crop(500, 500, 1333, 2.5);
  assert.deepStrictEqual([mid.px, mid.py, mid.width], [50, 50, 250]);
  const corner = C.crop(0, 0, 1333, 2.5);
  assert.deepStrictEqual([corner.left, corner.top, corner.px, corner.py], [0, 0, 0, 0]);
  const far = C.crop(1000, 1000, 1333, 2.5);
  assert.ok(Math.abs(far.left - (100 - far.width)) < 0.01 && Math.abs(far.px - 100) < 0.01 && Math.abs(far.py - 100) < 0.02);
  const wide = C.crop(500, 500, 4000, 1);
  assert.ok(wide.height < 100 && Math.abs(wide.top - (100 - wide.height) / 2) < 0.01, 'a wide photo, unzoomed, is centred top to bottom');
});

/* ================================================================== *
 * Two phones, one job: the merge
 * ================================================================== */

test('merge 1 - different pins on two phones: phone A marks #1 fixed and adds a pin, phone B rewrites #2 and moves #3; everything from both is kept, no note (nothing clashed)', () => {
  const o = start0();
  let a = C.setState(o, pid(1), 'fixed', '2026-11-22', 100);
  a = C.addItem(a, pid(10), f({ note: 'Loose cabinet pull' }), 101);
  let b = C.editItem(o, pid(2), { trade: 'Tile', pri: 'high', due: '', note: 'Cracked tile and loose grout at the tub' }, 102);
  b = C.moveItem(b, pid(3), 640, 410, 103);
  const m = both(a, b, 30);
  const it = m.book.items;
  assert.deepStrictEqual([it[pid(1)].state, it[pid(2)].note, it[pid(2)].pri, it[pid(3)].x, it[pid(10)].n], ['fixed', 'Cracked tile and loose grout at the tub', 'high', 640, 4]);
  assert.deepStrictEqual(m.notes, []);
  strictOk(m.book); noDupes(m.book);
});

test('merge 2 - the SAME pin, different parts: A marks #3 fixed while B rewrites its note and C moves it; all three survive, part by part - not whole-pin last-write-wins', () => {
  const o = start0();
  const a = C.setState(o, pid(3), 'fixed', '2026-11-22', 200);
  const b = C.editItem(o, pid(3), { trade: 'Electrical', pri: 'low', due: '2026-11-30', note: 'Outlet cover missing - and the box is loose' }, 300);
  const c = C.moveItem(o, pid(3), 900, 120, 250);
  const ab = both(a, b, 30).book;
  assert.deepStrictEqual([ab.items[pid(3)].state, ab.items[pid(3)].sd, ab.items[pid(3)].note, ab.items[pid(3)].pri, ab.items[pid(3)].due], ['fixed', '2026-11-22', 'Outlet cover missing - and the box is loose', 'low', '2026-11-30'], 'the earlier state change is not lost to the later note edit');
  const abc = both(ab, c, 30).book;
  assert.deepStrictEqual([abc.items[pid(3)].x, abc.items[pid(3)].y, abc.items[pid(3)].state, abc.items[pid(3)].pri], [900, 120, 'fixed', 'low']);
  assert.deepStrictEqual(both(a, b, 30).notes, [], 'different parts do not clash');
});

test('merge 3 - the SAME part of the same pin on both phones: the later change wins, the other is named in a note; at the very same time both phones pick the same one; changes before the last agreement are not news', () => {
  const o = start0();
  const a = C.editItem(o, pid(1), { trade: 'Paint', pri: 'normal', due: '', note: 'Scuffed wall - two coats' }, 100);
  const b = C.editItem(o, pid(1), { trade: 'Drywall', pri: 'high', due: '', note: 'Dent in the wall by the door' }, 120);
  const m = both(a, b, 30);
  assert.deepStrictEqual([m.book.items[pid(1)].trade, m.book.items[pid(1)].note], ['Drywall', 'Dent in the wall by the door']);
  assert.deepStrictEqual(m.notes, ['Both phones changed the work on pin #1 - the later change is kept.']);
  const s1 = C.setState(o, pid(1), 'fixed', '2026-11-22', 150), s2 = C.setState(o, pid(1), 'verified', '2026-11-22', 150);
  const tie = both(s1, s2, 30);
  assert.strictEqual(tie.book.items[pid(1)].state, 'verified', 'a tie is broken canonically - the same pick on both phones');
  assert.deepStrictEqual(both(a, b, 130).notes, [], 'both changes before `since`: no note');
  const st = both(C.setState(o, pid(1), 'fixed', '2026-11-22', 140), C.setState(o, pid(1), 'open', '', 160), 30);
  assert.strictEqual(st.book.items[pid(1)].state, 'open', 'a reopen after a fix wins when it came later');
});

test('merge 4 - a removed pin against an edited one, both orders: edited AFTER the removal, it is kept (and said so); edited before it, it stays removed; removed on both, the later removal', () => {
  const o = start0();
  const del = C.removeItem(o, pid(2), 100);
  const editLater = C.setState(o, pid(2), 'fixed', '2026-11-22', 110);
  const editEarlier = C.editItem(o, pid(2), { trade: 'Tile', pri: 'high', due: '', note: 'Cracked tile at the tub - two tiles' }, 90);
  const kept = both(del, editLater, 30);
  assert.ok(!kept.book.items[pid(2)].del && kept.book.items[pid(2)].state === 'fixed', 'the fix made after the removal is kept');
  assert.deepStrictEqual(kept.notes, ['Pin #2 was removed on one phone but changed on the other after that - it is kept.']);
  const gone = both(del, editEarlier, 30);
  assert.deepStrictEqual(gone.book.items[pid(2)], { del: true, t: 100 });
  assert.deepStrictEqual(gone.notes, []);
  assert.deepStrictEqual(both(C.removeItem(o, pid(2), 100), C.removeItem(o, pid(2), 105), 30).book.items[pid(2)], { del: true, t: 105 });
  const tie = both(C.removeItem(o, pid(2), 110), editLater, 30);
  assert.ok(tie.book.items[pid(2)].del, 'at the same moment, the removal stands');
  strictOk(kept.book); strictOk(gone.book);
});

test('merge 5 - two new pins with one number: both phones add a #4 offline; the older keeps #4, the newer becomes #5 (and it is said); a third phone that still has the old numbering cannot undo it - numbers only go up', () => {
  const o = start0();
  const a = C.addItem(o, pid(20), f({ note: 'Door stop missing' }), 100);
  const b = C.addItem(o, pid(21), f({ note: 'Light bulb out in the hood' }), 105);
  assert.ok(a.items[pid(20)].n === 4 && b.items[pid(21)].n === 4);
  const m = both(a, b, 30);
  assert.deepStrictEqual([m.book.items[pid(20)].n, m.book.items[pid(21)].n], [4, 5]);
  assert.deepStrictEqual(m.notes, ['Both phones made a pin #4 - the newer one is now #5.']);
  const again = both(m.book, b, 30);
  assert.deepStrictEqual([again.book.items[pid(20)].n, again.book.items[pid(21)].n], [4, 5], 'B’s stale #4 does not come back');
  assert.deepStrictEqual(again.notes, []);
  const c = C.addItem(b, pid(22), f({ note: 'Toe-kick loose' }), 106);
  const m3 = both(m.book, c, 30).book;
  noDupes(m3);
  assert.deepStrictEqual([m3.items[pid(20)].n, m3.items[pid(21)].n, m3.items[pid(22)].n], [4, 5, 6]);
});

test('merge 6 - a removed area or job against a pin changed later: the pin is kept and its area (and job) come back; pins that did not change after the removal stay removed with it', () => {
  const o = start0();
  const delArea = C.removeArea(o, A2, 100);
  assert.ok(delArea.areas[A2].del && delArea.items[pid(2)].del);
  const fixedLater = C.setState(o, pid(2), 'fixed', '2026-11-22', 110);
  const m = both(delArea, fixedLater, 30);
  assert.ok(!m.book.areas[A2].del && !m.book.items[pid(2)].del, 'the bath and its fixed tile are back');
  assert.ok(m.notes.some((n) => /pin #2 was removed on one phone/i.test(n)));
  strictOk(m.book);
  const addedEarlier = C.addItem(o, pid(30), f({ area: A2, note: 'Mirror clips loose' }), 90);
  const m2 = both(delArea, addedEarlier, 30);
  assert.ok(m2.book.areas[A2].del && m2.book.items[pid(30)].del, 'a pin from before the removal goes with the area');
  const delJob = C.removeJob(o, J, 100);
  assert.ok(delJob.jobs[J].del && Object.values(delJob.areas).every((x) => x.del) && Object.values(delJob.items).every((x) => x.del));
  const m3 = both(delJob, C.editItem(o, pid(1), { trade: 'Paint', pri: 'high', due: '', note: 'Scuffed wall - client asked' }, 120), 30);
  assert.ok(!m3.book.jobs[J].del && !m3.book.areas[A1].del && m3.book.items[pid(1)].note === 'Scuffed wall - client asked', 'the job comes back with the changed pin');
  assert.ok(m3.book.items[pid(3)].del && m3.book.areas[A2].del, 'what did not change stays removed');
  strictOk(m3.book);
  const renamed = C.putArea(o, A2, J, 'Hall bath', 750, 130);
  assert.ok(!both(delArea, renamed, 30).book.areas[A2].del, 'renaming an area after the other phone removed it keeps the area');
});

test('merge 7 - the sign-off: the later one wins; a sign-off cleared later stays cleared; a job removed takes its sign-off with it', () => {
  const o = start0();
  const a = C.sign(o, J, 'Rowan Ilves', '2026-11-22', 100);
  const b = C.sign(C.setState(o, pid(1), 'verified', '2026-11-22', 90), J, 'Rowan Ilves', '2026-11-23', 110);
  assert.strictEqual(both(a, b, 30).book.signs[J].date, '2026-11-23');
  assert.ok(both(a, C.unsign(a, J, 120), 30).book.signs[J].del);
  assert.ok(both(a, C.removeJob(o, J, 130), 30).book.signs[J].del);
});

/** A deterministic shuffle: no dice in the suite either. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function randomEdits(b0, r, t0, tag) {
  let b = clone(b0), t = t0;
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    t += 1 + Math.floor(r() * 3);
    const live = Object.keys(b.items).filter((k) => !b.items[k].del);
    const areas = Object.keys(b.areas).filter((k) => !b.areas[k].del);
    const op = Math.floor(r() * 9);
    const any = live[Math.floor(r() * live.length)];
    if (op === 0 && areas.length) b = C.addItem(b, pid(tag * 1000 + i + Math.floor(r() * 3)), f({ area: areas[Math.floor(r() * areas.length)], note: 'New fix ' + tag + i }), t);
    else if (op === 1 && any) b = C.setState(b, any, C.STATES[Math.floor(r() * 3)], '2026-11-22', t);
    else if (op === 2 && any) b = C.editItem(b, any, { trade: ['Paint', 'Tile', 'Drywall'][Math.floor(r() * 3)], pri: C.PRIS[Math.floor(r() * 3)], due: '', note: 'Edit ' + tag + i }, t);
    else if (op === 3 && any) b = C.moveItem(b, any, Math.floor(r() * 1000), Math.floor(r() * 1000), t);
    else if (op === 4 && any) b = C.removeItem(b, any, t);
    else if (op === 5 && areas.length && r() < 0.3) b = C.removeArea(b, areas[Math.floor(r() * areas.length)], t);
    else if (op === 6) b = C.sign(b, J, 'Rowan Ilves', '2026-11-22', t);
    else if (op === 7 && r() < 0.1) b = C.removeJob(b, J, t);
    else if (op === 8) b = C.putArea(b, 'anew' + String(tag).padStart(6, '0'), J, 'Porch', 1333, t);
  }
  return b;
}

test('merge 8 - 400 random pairs and 150 random triples of phones editing one job from a shared start: symmetric, idempotent, absorbing (merging an input again changes nothing), convergent in any order, always through the strict door, and never two live pins with one number', () => {
  const r = rng(20261117);
  for (let i = 0; i < 400; i++) {
    const o = randomEdits(start0(), r, 30, 1);
    const a = randomEdits(o, r, 60 + Math.floor(r() * 20), 2), b = randomEdits(o, r, 60 + Math.floor(r() * 20), 3);
    const m = both(a, b, 30).book;
    strictOk(m); noDupes(m);
    assert.ok(C.same(C.merge(m, m).book, m), 'idempotent');
    assert.ok(C.same(C.merge(m, a).book, m) && C.same(C.merge(b, m).book, m), `absorbing (pair ${i})`);
  }
  for (let i = 0; i < 150; i++) {
    const o = randomEdits(start0(), r, 30, 1);
    const [a, b, c] = [2, 3, 4].map((tag) => randomEdits(o, r, 60 + Math.floor(r() * 20), tag));
    const x = C.merge(C.merge(a, b).book, c).book, y = C.merge(a, C.merge(c, b).book).book;
    const z1 = C.merge(x, y).book, z2 = C.merge(y, x).book;
    assert.ok(C.same(z1, z2), 'two phones that synced in different orders agree once they meet');
    strictOk(z1); noDupes(z1);
    for (const p of [a, b, c, x, y]) assert.ok(C.same(C.merge(z1, p).book, z1), `converged: nothing older changes it (triple ${i})`);
  }
});

/* ================================================================== *
 * The demo, the storage, the look, the page and the copy
 * ================================================================== */

test('the demo’s planted story: a made-up kitchen and bath refresh, twelve pins in three rooms; 7 open, 3 fixed, 2 verified; #2 overdue on the demo’s day; the tile sub has #6 then #4; every fixed pin has an after picture; through the strict door', () => {
  const b = D.book();
  strictOk(b);
  const its = C.itemsOf(b, D.JOB);
  assert.deepStrictEqual(C.counts(its), { open: 7, fixed: 3, verified: 2, total: 12 });
  assert.deepStrictEqual(its.filter((x) => C.overdue(x, D.TODAY)).map((x) => x.n), [2]);
  assert.deepStrictEqual(C.byTrade(b, D.JOB).find((g) => g.trade === 'Tile').items.map((x) => x.n), [6, 4]);
  assert.strictEqual(b.items[D.OUTLET].state, 'fixed');
  for (const it of its) assert.strictEqual(Boolean(D.after(it.id)), it.state !== 'open', `#${it.n}`);
  for (const aid of Object.keys(D.AREAS)) assert.match(D.photo(aid), /^data:image\/svg\+xml;charset=utf-8,/);
  assert.ok(C.same(D.book(), D.book()), 'the same every time - no clock, no dice');
  assert.strictEqual(C.signOf(b, D.JOB), null, 'nobody has signed yet');
  assert.ok(D.SIGN.length >= 3 && D.SIGN.every((s) => s.every(([x, y]) => x >= 0 && x <= 1000 && y >= 0 && y <= 1000)));
});

test('storage: one module; the book through the one door; photos only as JPEG data URLs and signatures only as PNG, by a known ref, never in the book; the "prepared by" name refused with an @; IndexedDB wrapped - throwing, blocked or missing falls back to memory and says so', async () => {
  const s = RS.create(RS.memory());
  assert.strictEqual(await s.getBook(), null);
  const b = D.book(); b.items.pdemo00001.photo = JPEG;
  await s.putBook(b);
  assert.ok(!('photo' in (await s.getBook()).items.pdemo00001), 'kept through the lenient door - no picture in the book');
  await s.putPic('photo:aarea00001', JPEG);
  await s.putPic('sign:jjob000001', 'data:image/png;base64,iVBORw0KGgo=');
  assert.strictEqual(await s.getPic('photo:aarea00001'), JPEG);
  await assert.rejects(s.putPic('sign:jjob000001', JPEG), /signature/);
  await assert.rejects(s.putPic('photo:aarea00001', 'data:image/svg+xml,<svg/>'), /photo/);
  await assert.rejects(s.putPic('book', JPEG), /nowhere/);
  await assert.rejects(s.putPic('photo:aarea00001', 'data:image/jpeg;base64,' + 'A'.repeat(RS.PHOTO_MAX)), /photo/);
  assert.deepStrictEqual(await s.refs(), ['photo:aarea00001', 'sign:jjob000001']);
  await s.delPic('photo:aarea00001');
  assert.deepStrictEqual([await s.getPic('photo:aarea00001'), await s.refs()], [null, ['sign:jjob000001']]);
  await s.putDevice({ tour: true, by: 'Fernwood Renovations', extra: 1 });
  assert.deepStrictEqual(await s.getDevice(), { tour: true, by: 'Fernwood Renovations' });
  await s.putDevice({ by: 'x' + AT + 'y' });
  assert.strictEqual((await s.getDevice()).by, '');
  await s.putSync({ base: 'x', at: 5 });
  assert.deepStrictEqual(await s.getSync(), { base: null, at: 5 });
  const throwing = { open() { throw new Error('nope'); } };
  const t = RS.create(RS.idb('punch', throwing));
  await t.putBook(D.book());
  assert.ok((await t.getBook()).items.pdemo00001, 'falls back to memory');
  assert.strictEqual(t.persistent(), false);
  assert.strictEqual(RS.create(RS.idb('punch', null)).persistent(), false);
  const blocked = { open() { const req = {}; setTimeout(() => req.onblocked && req.onblocked(), 0); return req; } };
  const bl = RS.create(RS.idb('punch', blocked));
  await bl.putDevice({ tour: true });
  assert.strictEqual((await bl.getDevice()).tour, true);
  assert.strictEqual(bl.persistent(), false);
});

test('every text colour holds 4.5:1 on its surface in both themes; the pin colours 3:1 on the cards and their numbers 4.5:1; the hero; the signing pad; the lab card (white text, 20+ in CIE Lab from every card, drop #69, 📌 on no other card); 44px targets, pins included; tables scroll in their own box; no sideways scroll; reduced motion; a print sheet in the light tokens', () => {
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
    ok('muted', 'info-bg'); ok('accent-ink', 'accent'); ok('bg', 'text'); ok('accent', 'card');
    for (const k of ['bad', 'warn', 'info', 'ok']) { ok(k, `${k}-bg`); ok(k, 'card'); ok(k, 'card2'); ok(k, 'bg'); }
    for (const p of ['pin-open', 'pin-fixed', 'pin-verified']) { ok(p, 'card', 3); ok(p, 'card2', 3); ok('pin-ink', p); }
  }
  assert.match(css, /\.hero \{[^}]*linear-gradient\(150deg, #9a0000 0%, #c40000 45%, #0036a8 100%\)/);
  for (const bg of ['#9a0000', '#c40000', '#0036a8']) for (const fg of ['#ffffff', '#fff6f4']) assert.ok(ratio(fg, bg) >= 4.5, `hero ${fg} on ${bg}`);
  assert.ok(ratio('#9a0000', '#fff6f4') >= 4.5, 'the hero’s primary button');
  for (const bg of ['#c40000', '#a85300', '#17783a']) assert.ok(ratio('#ffffff', bg) >= 4.5, `the hero board's pins ${bg}`);
  assert.ok(ratio('#4b5361', '#ffffff') >= 4.5 && ratio('#10131a', '#ffffff') >= 4.5, 'the pad is paper in both themes: its line label and the ink');
  for (const sel of ['.btn', '.link-btn', '.seg button', '.chip', '.input, textarea.input, select.input', '.photobtn', '.checkrow', '.irow', '.jrow, .acard']) assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*min-height: (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  assert.match(css, /\.pin \{ position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px;/, 'a pin is a 44px target centred on its spot');
  assert.ok(/\.tabbar button \{[^}]*min-height: 60px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css) && /\.tablebox \{ overflow-x: auto; max-width: 100%;/.test(css));
  assert.ok(/\.pad \{[^}]*touch-action: none/.test(css), 'the pad takes the finger, not the page scroll');
  assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/.test(css));
  const print = /@media print \{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(print, /\.top, \.tabbar, \.guide, \.ribbon, \.btns, \.sheet/);
  const paper = {}; for (const [, k, v] of /:root, :root:not\(\[data-theme="light"\]\), :root\[data-theme="dark"\] \{([\s\S]*?)\}/.exec(print)[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) paper[k] = v;
  assert.deepStrictEqual(paper, light, 'paper is printed in the light tokens, whatever the phone’s theme');
  const js = read('public/app.js');
  assert.strictEqual((js.match(/<table class="grid">/g) || []).length, 2);
  assert.strictEqual((js.match(/<div class="tablebox" tabindex="0" role="region"/g) || []).length, 2, 'every table in its own scrolling box');
  // The lab card.
  const LAB = require('../../../lab');
  const lab = LAB.get('punch');
  assert.ok(lab, 'Punch is in lab.js');
  assert.deepStrictEqual([lab.color, lab.color2, lab.dropped, lab.status, lab.emoji, lab.audience], ['#ae5887', '#003dff', '2026-11-22', 'testing', '\u{1F4CC}', 'Contractors, remodelers, builders and handymen']);
  assert.strictEqual(lab.tagline, 'Walk the job, pin every fix on a photo, close it out with a before-and-after the client signs.');
  assert.ok(ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const other of LAB.APPS.filter((x) => x.slug !== 'punch')) {
    for (const c of [other.color, other.color2]) assert.ok(labDist(lab.color, c) >= 20 && labDist(lab.color2, c) >= 20, `away from ${other.slug} ${c}: ${labDist(lab.color, c).toFixed(1)} / ${labDist(lab.color2, c).toFixed(1)}`);
    assert.notStrictEqual(other.emoji, lab.emoji, `${other.slug} has the same emoji`);
  }
  assert.ok(labDist(lab.color, lab.color2) >= 20);
  assert.strictEqual(LAB.APPS.findIndex((x) => x.slug === 'punch') + 1, 69, 'drop #69');
  assert.strictEqual(lab.features.length, 4);
});

test('the page: relative links, no inline script or handlers, the banner, the pin with no variation selector, storage only through punch-store.js, no clock or dice in the core or the demo, the requests it makes, only the text sent, photos redrawn through a canvas, the signature kept on the phone, every received string escaped, the tour', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  assert.ok(html.includes('\u{1F4CC}') && !html.includes('\u{1F4CC}\uFE0F'), 'the pin, no variation selector');
  const js = read('public/app.js');
  assert.ok(!js.includes('\uFE0F'));
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message|pointerdown|pointermove)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(js), 'the page touches no storage itself');
  for (const f of ['public/punch-core.js', 'public/demo.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon|indexedDB|WebSocket/.test(src), `${f} touches no network or storage`);
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(/.test(src), `${f} has no dice and no clock`);
  }
  const all = js + read('public/punch-core.js') + read('public/demo.js') + read('public/punch-store.js');
  assert.ok(!/eval\(|new Function|setTimeout\(['"]/.test(all), 'no eval of any kind');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/auth/', 'api/auth/logout', 'api/me', 'api/sync'], 'the page asks for nothing else - no photo, no signature, no model');
  assert.strictEqual((js.match(/\bfetch\(/g) || []).length, 1, 'one fetch: api()');
  assert.match(js, /api\('PUT', 'api\/sync', \{ data: bodyOf\(state\.book\), base:/);
  assert.match(js, /function bodyOf\(b\) \{ return C\.cleanBook\(b\)\.book; \}/, 'the body is the book through its door - text only');
  assert.ok(!/api\([^)]*(pic\(|pics|photo|sign:|toDataURL)/.test(js), 'no picture goes near a request');
  assert.match(js, /var k = Math\.min\(1, side \/ Math\.max\(img\.naturalWidth, img\.naturalHeight\)\);[\s\S]{0,400}g\.drawImage\(img, 0, 0, w, h\);[\s\S]{0,80}cv\.toDataURL\('image\/jpeg', q\)/, 'every photo redrawn through a canvas as a JPEG');
  assert.match(js, /keepPic\('sign:' \+ jid, cv\.toDataURL\('image\/png'\)\)/, 'the signature kept on this phone');
  assert.match(js, /commit\(C\.sign\(book\(\), jid, name, date, stamp\(\)\), true\)/, 'only its name, date and counts go in the book');
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) assert.ok(js.includes(`cv.addEventListener('${ev}'`), ev);
  assert.strictEqual((js.match(/type="email"/g) || []).length, 1, 'only the sign-in form asks for an email - the account holder’s own');
  assert.ok(!/type="tel"|autocomplete="(tel|street-address|address-line1|postal-code|cc-number|name|given-name|family-name)"/i.test(js + html));
  assert.ok(!/geolocation|getCurrentPosition|watchPosition/.test(all), 'no location');
  assert.match(js, /case 'print': window\.print\(\); break;/);
  // Every interpolation of something a person or the server wrote goes through esc().
  const strip = (src) => { let out = ''; let i = 0; const re = /\besc\(/g; let m; while ((m = re.exec(src))) { if (m.index < i) continue; out += src.slice(i, m.index) + 'SAFE'; let depth = 0, j = m.index + m[0].length - 1; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; re.lastIndex = i; } return out + src.slice(i); };
  const risky = strip(js).split('\n').filter((l) => /</.test(l) && !/toast\(|confirm\(|prompt\(|copy\(|textContent|say\(/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(?!SAFE\b)([a-zA-Z_$][\w$]*(?:\.[\w$]+|\[[^\]]+\])*(?:\([^()]*\))?)\s*\+/g);
  const allowed = (r) => /\+\s*(?:[a-zA-Z]*Html(?:\([^()]*\))?|html|rows|seg|cards|parts|pairs|pins|img|mark|pos|ratio|acts|steps|signed|head|tools|w\([^()]*\)|c\.(?:left|top|width|height|px|py)|it\.(?:x|y) \/ 10|stateChip\([^()]*\)|priChip\([^()]*\)|dueChip\([^()]*\)|bar\([^()]*\)|countsHtml\([^()]*\)|boardHtml\([^()]*\)|beforeHtml\([^()]*\)|afterHtml\([^()]*\)|pairHtml\([^()]*\)|rowHtml\([^()]*\)|formHtml\([^()]*\)|guideHtml\([^()]*\)|demoRibbon\(\)|mergeNoteHtml\(\)|syncLine\(\)|jobHead\(\)|a\.ar)\s*\+/.test(r);
  const bad = (risky || []).filter((r) => !allowed(r));
  assert.deepStrictEqual(bad, [], `unescaped: ${bad}`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbook\b|\bdata\b)/.test(read('server.js').replace(/`[^`]*`|'[^'\n]*'/g, "''")), 'server.js logs no body');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /punch-shell-v1/.test(sw) && ['punch-core.js', 'punch-store.js', 'demo.js', 'app.js'].every((x) => sw.includes(`'${x}'`)) && /k\.indexOf\('punch-'\) === 0/.test(sw), 'the service worker caches only the app shell, never api/, and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  // The tour: six steps, in order, each with its view and words.
  const tour = /var TOUR = \[([\s\S]*?)\n {2}\];/.exec(js)[1];
  assert.deepStrictEqual([...tour.matchAll(/view: '(\w+)'/g)].map((m) => m[1]), ['job', 'area', 'item', 'trades', 'closeout', 'print']);
  for (const w of ['Open the kitchen', 'Drop a pin by the window', 'Verify #3', 'Copy the tile list', 'Sign as the client', 'Print the closeout', 'Start my own job', 'Seven are open, three fixed', '#2, the sagging cabinet door, was due yesterday']) assert.ok(tour.includes(w), w);
  for (const v of ['jobsHtml', 'jobHtml', 'areaHtml', 'itemHtml', 'tradesHtml', 'closeoutHtml', 'printHtml', 'moreHtml']) assert.ok(new RegExp('function ' + v + '\\(\\) \\{[\\s\\S]{0,4000}?demoRibbon\\(\\)').test(js), `${v} carries the ribbon`);
  // Pins are never colour alone: each carries its number, and a label in words.
  assert.match(js, /aria-label="' \+ esc\(pinLabel\(it\)\) \+ '">' \+ mark \+ '<\/button>'/);
  assert.match(js, /function pinLabel\(it\) \{ return 'Pin ' \+ it\.n \+ ': ' \+ it\.trade \+ ' - ' \+ it\.note \+ ' \(' \+ C\.STATE\[it\.state\]\.label\.toLowerCase\(\) \+ '\)'; \}/);
  assert.match(js, /document\.addEventListener\('visibilitychange'[\s\S]{0,200}if \(signedIn\(\)\) syncIn\(\);/);
});

test('the copy: no real company, brand or product in any file; no invisible characters, key-shaped strings, email addresses, phone numbers or session links; no model named anywhere; CLAUDE.md says it is a rebuild and documents the merge rules; the shared files are the shared copies', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const files = walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x));
  assert.ok(files.length >= 20);
  const marks = [['Home ', 'Depot'], ['Low', 'e’s'], ['Low', 'es'], ['Pro', 'core'], ['Builder', 'trend'], ['Field', 'wire'], ['Plan', 'Grid'], ['Co', 'Construct'], ['Bluebeam'], ['Crafts', 'man'], ['De', 'Walt'], ['Mil', 'waukee'], ['Sher', 'win'], ['Ben', 'jamin Moore'], ['Ko', 'hler'], ['Mo', 'en'], ['Del', 'ta Faucet'], ['Ange', 'li'], ['Thumb', 'tack'], ['Hou', 'zz'], ['Task', 'Rabbit'], ['Goo', 'gle'], ['Ama', 'zon'], ['Docu', 'Sign']].map((p) => p.join(''));
  const markRe = new RegExp('(^|[^A-Za-z])(' + marks.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z])');
  assert.ok(markRe.test('a ' + marks[0] + ' run') && !markRe.test('home depot of tools') && !markRe.test('the pins on the photo'), 'the check bites, and only where it should');
  const SESSION_LINK = new RegExp(['claude', 'ai/code'].join('\\.') + '|' + ['Claude', 'Session'].join('-'));
  const invisible = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [0x7F, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2069], [0xFEFF, 0xFEFF]].map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']');
  const phoneRe = /(^|[^\d.])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8'), rel = path.relative(ROOT, file);
    assert.ok(!invisible.test(src), `${rel} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(file)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bsk-ant-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(src), `${rel} carries a key-shaped string`);
    if (!/^public\/(passkey-client|verify-banner|desktop)\.|^lib\/(identity|stripe|byok|webauthn|identity-store)\.js$|^test\//.test(rel)) {
      assert.ok(!markRe.test(src), `${rel} names a brand: ${(markRe.exec(src) || [])[2]}`);
      assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(src), `no email address in ${rel}`);
      assert.ok(!phoneRe.test(src), `no phone number in ${rel}: ${(phoneRe.exec(src) || [])[0]}`);
      assert.ok(!SESSION_LINK.test(src), `no session link in ${rel}`);
      assert.ok(!/claude-(haiku|sonnet|opus)/.test(src), `no model named in ${rel}: Punch makes no model call`);
    }
  }
  const strings = JSON.stringify([D.book(), D.ROWS, Object.keys(D.AREAS).map(D.photo)]);
  assert.ok(!invisible.test(strings) && !markRe.test(strings), 'nor in what the demo makes');
  const doc = read('CLAUDE.md').replace(/\s+/g, ' ');
  assert.match(doc, /a rebuild of the 2026-11-17 drop/i);
  assert.match(doc, /HANDOFF\.md/);
  for (const w of ['pin by pin', 'the later change wins', 'after the removal', 'the next free number', 'photos never leave the phone', 'PUNCH_FAKE_AI', 'no model call']) assert.ok(doc.toLowerCase().includes(w.toLowerCase()), `CLAUDE.md: ${w}`);
  for (const file of ['lib/identity.js', 'lib/identity-store.js', 'lib/byok.js', 'lib/stripe.js', 'lib/webauthn.js', 'public/desktop.css', 'public/passkey-client.js', 'public/verify-banner.js']) {
    assert.strictEqual(read(file), fs.readFileSync(path.join(ROOT, '..', 'stars', file), 'utf8'), `${file} is the shared copy`);
  }
  assert.deepStrictEqual(JSON.parse(read('package.json')).dependencies, JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'stars', 'package.json'), 'utf8')).dependencies, 'the same dependencies and ranges as its siblings');
  assert.match(JSON.parse(read('package.json')).scripts.test, /^REQUIRE_VERIFIED_FOR_FREE_AI=0 PUNCH_MEMORY=1 PUNCH_FAKE_AI=1 node test\/run\.js$/);
  const sync = fs.readFileSync(path.join(ROOT, '..', '..', '..', 'scripts', 'sync-shared.js'), 'utf8');
  assert.ok(sync.includes("['eriks-projects/challenge/apps/punch/lib',") && sync.includes("['eriks-projects/challenge/apps/punch/public',['desktop.css', 'passkey-client.js', 'verify-banner.js']]"), 'its two lines in sync-shared.js');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; one document per account, read by its id; no model client at all', () => {
  for (const [mod, env] of [['./lib/store', { PUNCH_MEMORY: '1' }], ['./server', { PUNCH_FAKE_AI: '1', PUNCH_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, PUNCH_MEMORY: '', PUNCH_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, PUNCH_MEMORY: '', PUNCH_COLLECTION_PREFIX: 'punch_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'punch_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.ok(!/store\.list\(|orderBy/.test(server), 'no query: one document per account, by its id');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g))].sort(), ["store.get('books'", "store.transact('books'"]);
  assert.match(server, /update\('punch owner v1'\)/);
  assert.ok(!/anthropic|requireBudget|requireDailyCap|\/api\/ai/i.test(server.replace(/\/\/.*$/gm, '')), 'no model client, no metered route');
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
async function login(who) {
  const c = client();
  assert.strictEqual((await c('POST', '/api/auth/login', { email: mail(who), password: 'a long enough password' })).status, 200);
  return c;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const BIG = { x: 'x'.repeat(2.2 * 1024 * 1024) };
/** The example with its times moved to `t`: a real phone stamps with its clock. */
function restamp(b, t) {
  const x = clone(b);
  x.t = t;
  for (const part of ['jobs', 'areas', 'signs']) for (const id of Object.keys(x[part])) x[part][id].t = t;
  for (const id of Object.keys(x.items)) { const it = x.items[id]; if (it.del) it.t = t; else { it.c = t; it.tp = t; it.tw = t; it.ts = t; } }
  return x;
}

test('signed out: the page and its files load; the sync answers 401 before reading a body; no route takes or hosts a photo, a signature or a job; no model call ever', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.states, meta.priorities], [['open', 'fixed', 'verified'], ['high', 'normal', 'low']]);
  for (const x of ['punch-core.js', 'punch-store.js', 'demo.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${x}`)).status, 200, x);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  const shell = await page.text();
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['GET', '/api/sync'], ['PUT', '/api/sync'], ['DELETE', '/api/sync']]) assert.strictEqual((await anon(m, p, m === 'PUT' ? { ok: 1 } : undefined)).status, 401, `${m} ${p}`);
  assert.strictEqual((await anon('PUT', '/api/sync', BIG)).status, 401, 'the gate answers before the parser, so never 413');
  for (const p of ['/api/photo', '/api/photos', '/api/sign', '/api/signature', '/api/jobs', '/api/share', '/api/ai/read', '/api/closeout']) {
    assert.strictEqual((await anon('POST', p, { x: 1 })).status, 404, `POST ${p}`);
    assert.strictEqual((await anon('GET', p)).status, 404, `GET ${p}`);
  }
  for (const p of ['/j/abc', '/job', '/closeout']) assert.strictEqual(await (await fetch(`${base}${p}`)).text(), shell, `${p} is only the app shell`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call');
});

test('writes come from this page: another site’s request (Sec-Fetch-Site or Origin) is 403 and a body that is not JSON 415, before anything else', async () => {
  const ana = await register('ana.sameorigin');
  const b = restamp(D.book(), Date.now());
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'same-site' })).status, 403, 'a sibling subdomain is another site here');
  assert.strictEqual((await ana('PUT', '/api/sync', { data: b, base: null }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await ana('PUT', '/api/sync', 'data=1', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await ana('DELETE', '/api/sync', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const same = await ana('PUT', '/api/sync', { data: b, base: null }, { 'Sec-Fetch-Site': 'same-origin', Origin: base.replace(/\/punch$/, '') });
  assert.strictEqual(same.status, 200, same.text);
});

test('two phones on one job over HTTP: the job follows the account; each phone edits offline - different pins, the same pin’s different parts, a removal against a later fix, two new pins both #13 - the stale phone gets 409 with the account copy, merges pin by pin and saves; both end with every change', async () => {
  const A = await register('site.lead');
  const t0 = Date.now() - 600000;
  const start = restamp(D.book(), t0);
  const put = await A('PUT', '/api/sync', { data: start, base: null });
  assert.strictEqual(put.status, 200, put.text);
  const v1 = put.data.updatedAt;
  const B = await login('site.lead');
  const onB = (await B('GET', '/api/sync')).data;
  assert.strictEqual(onB.updatedAt, v1);
  assert.ok(C.same(onB.data, start));
  // Phone B (the super), offline for a while: fixes #3, rewrites #5's note,
  // removes #8, adds a pin by the window.
  const tE = Date.now() + 10;   // both phones edit after they last agreed
  let b = onB.data;
  b = C.setState(b, 'pdemo00003', 'verified', '2026-11-22', tE + 1000);
  b = C.editItem(b, 'pdemo00005', { trade: 'Plumbing', pri: 'high', due: '2026-11-23', note: 'Faucet drips - cartridge needs replacing' }, tE + 2000);
  b = C.removeItem(b, 'pdemo00008', tE + 3000);
  b = C.addItem(b, 'pphoneb001', { area: 'akitch0001', x: 700, y: 300, trade: 'Paint', pri: 'normal', due: '', note: 'Caulk along the window trim' }, tE + 4000);
  const putB = await B('PUT', '/api/sync', { data: b, base: v1 });
  assert.strictEqual(putB.status, 200, putB.text);
  // Phone A (the owner) meanwhile: moves #5's pin, fixes #8 AFTER B removed
  // it, edits #2, and adds its own pin - also #13.
  let a = start;
  a = C.moveItem(a, 'pdemo00005', 520, 650, tE + 1500);
  a = C.setState(a, 'pdemo00008', 'fixed', '2026-11-22', tE + 3500);
  a = C.editItem(a, 'pdemo00002', { trade: 'Carpentry', pri: 'high', due: '2026-11-23', note: 'Cabinet door sags - new hinges ordered' }, tE + 2500);
  a = C.addItem(a, 'pphonea001', { area: 'abath00001', x: 300, y: 300, trade: 'Electrical', pri: 'low', due: '', note: 'GFCI does not reset' }, tE + 4500);
  const stale = await A('PUT', '/api/sync', { data: a, base: v1 });
  assert.deepStrictEqual([stale.status, stale.data.code], [409, 'conflict']);
  assert.ok(stale.data.data.items.pphoneb001, 'the 409 carries the account copy');
  const m = C.merge(a, stale.data.data, v1);
  const again = await A('PUT', '/api/sync', { data: m.book, base: stale.data.updatedAt });
  assert.strictEqual(again.status, 200, again.text);
  const final = (await B('GET', '/api/sync')).data.data;
  const it = final.items;
  assert.strictEqual(it.pdemo00003.state, 'verified', 'B’s verify');
  assert.deepStrictEqual([it.pdemo00005.note, it.pdemo00005.pri, it.pdemo00005.x, it.pdemo00005.y], ['Faucet drips - cartridge needs replacing', 'high', 520, 650], 'B’s note and A’s move on the same pin');
  assert.ok(!it.pdemo00008.del && it.pdemo00008.state === 'fixed', 'A fixed #8 after B removed it: kept');
  assert.strictEqual(it.pdemo00002.note, 'Cabinet door sags - new hinges ordered');
  assert.deepStrictEqual([it.pphoneb001.n, it.pphonea001.n], [13, 14], 'both new pins kept; the newer renumbered');
  assert.ok(m.notes.some((n) => /pin #8 was removed/i.test(n)) && m.notes.some((n) => /pin #13 - the newer one is now #14/.test(n)), m.notes.join(' | '));
  noDupes(final); strictOk(final);
  assert.strictEqual((await A('PUT', '/api/sync', { data: m.book, base: null })).status, 409, 'a phone that never synced cannot overwrite');
});

test('sync refuses whole anything out of shape or personal - a photo or signature in the body, a phone number in a note, an @, a tax id, a card, a link, markup, an invisible character, a pin off the photo, an unknown state; ~900 KB; 120 saves in ten minutes; filed under an HMAC; another account sees nothing; removed on the other phone says so', async () => {
  const a = await register('phone.one');
  const b0 = restamp(D.book(), Date.now() - 1000);
  const first = await a('PUT', '/api/sync', { data: b0, base: null });
  assert.strictEqual(first.status, 200, first.text);
  const cur = (await a('GET', '/api/sync')).data;
  const P = 'pdemo00001', S = { name: D.CLIENT, date: '2026-11-22', open: 7, fixed: 3, verified: 2, t: 5 };
  const variants = [
    ['an unknown field', (x) => { x.photos = {}; }],
    ['a photo on a pin', (x) => { x.items[P].after = JPEG; }],
    ['a photo as a note', (x) => { x.items[P].note = JPEG; }],
    ['a signature on the sign-off', (x) => { x.signs[D.JOB] = { ...S, img: 'data:image/png;base64,iVBORw0KGgo=' }; }],
    ['base64 in a name', (x) => { x.areas.akitch0001.name = 'Kitchen base64'; }],
    ['a phone in a note', (x) => { x.items[P].note = 'Call ' + PHONE; }],
    ['a tax id', (x) => { x.jobs[D.JOB].client = TAXID; }],
    ['a card', (x) => { x.items[P].note = CARD; }],
    ['an @', (x) => { x.jobs[D.JOB].client = 'odalys' + AT + 'x'; }],
    ['a full-width @', (x) => { x.items[P].trade = 'x' + FW_AT + 'y'; }],
    ['nine Arabic-Indic digits', (x) => { x.items[P].note = ch(0x0662).repeat(9); }],
    ['a link', (x) => { x.jobs[D.JOB].name = 'see punch.example.com'; }],
    ['a formula', (x) => { x.items[P].trade = '=HYPERLINK("x")'; }],
    ['markup', (x) => { x.items[P].note = '<img src=x>'; }],
    ['an invisible character', (x) => { x.items[P].note = 'Wall' + RLO; }],
    ['a pin off the photo', (x) => { x.items[P].x = 1500; }],
    ['an unknown state', (x) => { x.items[P].state = 'done'; }],
    ['a time as a string', (x) => { x.items[P].tw = '12'; }],
    ['a bad pin id', (x) => { x.items['../x'] = x.items[P]; }],
  ];
  for (const [what, fn] of variants) {
    const x = clone(cur.data); fn(x);
    const r = await a('PUT', '/api/sync', { data: x, base: cur.updatedAt });
    assert.strictEqual(r.status, 400, `${what}: ${r.text.slice(0, 200)}`);
  }
  assert.strictEqual((await a('PUT', '/api/sync', { data: cur.data, base: cur.updatedAt, photo: 'x' })).status, 400, 'nothing beside the book and its base');
  const big = clone(cur.data);
  for (let i = 0; i < 3100; i++) big.items['pbig' + String(i).padStart(5, '0')] = { ...big.items[P], n: 100 + i, note: 'A long and winding note about fix number ' + i + ' that needs doing before the walk' };
  const tooBig = await a('PUT', '/api/sync', { data: big, base: cur.updatedAt });
  assert.ok([400, 413].includes(tooBig.status), 'too many pins, or too much: ' + tooBig.status);
  assert.strictEqual((await a('PUT', '/api/sync', BIG)).status, 413, 'over the parser, after the sign-in');
  assert.strictEqual((await a('GET', '/api/sync')).data.updatedAt, cur.updatedAt, 'nothing was saved');
  const dump = store._dump();
  assert.ok(!dump.includes('phone.one') && !dump.includes(uidOf(mail('phone.one'))), 'filed under an HMAC, never the account id or address');
  assert.ok(dump.includes(ownerTag(uidOf(mail('phone.one')), process.env.IDENTITY_SESSION_SECRET || 'local-dev-secret')));
  const doc = Object.values(JSON.parse(dump).find(([p]) => p === 'books')[1]).map(([, d]) => d).find((d) => d.owner === ownerTag(uidOf(mail('phone.one')), 'local-dev-secret'));
  assert.deepStrictEqual(Object.keys(doc).sort(), ['book', 'owner', 'updatedAt']);
  assert.deepStrictEqual(Object.keys(doc.book).sort(), ['areas', 'items', 'jobs', 'signs', 't', 'v']);
  const other = await register('someone.else');
  assert.deepStrictEqual((await other('GET', '/api/sync')).data.data, null, 'another account sees nothing of it');
  const twin = await login('phone.one');
  assert.strictEqual((await a('DELETE', '/api/sync')).status, 200);
  const removed = await twin('PUT', '/api/sync', { data: cur.data, base: cur.updatedAt });
  assert.deepStrictEqual([removed.status, removed.data.code], [409, 'removed'], 'removed on the other phone says so');
  const r = await register('busy.pass');
  const mini = C.newBook(Date.now());
  let at = null, last = 0;
  for (let i = 0; i < 121; i++) { const res = await r('PUT', '/api/sync', { data: mini, base: at }); last = res.status; if (res.status === 200) at = res.data.updatedAt; else break; }
  assert.strictEqual(last, 429, 'the 121st save in ten minutes waits');
});

test('a hostile pass leaves nothing personal in the store: refused bodies never land; what is kept holds no email, phone, tax id, card, markup, picture or account id; no model call was ever made', async () => {
  const h = await register('hostile.pass');
  const s = restamp(D.book(), Date.now());
  const tries = [
    (x) => { x.items.pdemo00001.note = 'Call ' + PHONE; },
    (x) => { x.jobs[D.JOB].client = 'mail ' + mail('dana'); },
    (x) => { x.items.pdemo00002.note = 'Card ' + CARD; },
    (x) => { x.items.pdemo00002.note = '<script>alert(1)</script>'; },
    (x) => { x.areas.abath00001.name = 'Bath ' + ch(0x0967).repeat(9); },
    (x) => { x.jobs[D.JOB].name = TAXID; },
    (x) => { x.items.pdemo00003.note = JPEG; },
  ];
  for (const fn of tries) { const x = clone(s); fn(x); assert.strictEqual((await h('PUT', '/api/sync', { data: x, base: null })).status, 400); }
  assert.strictEqual((await h('PUT', '/api/sync', { data: s, base: null })).status, 200);
  const dump = store._dump();
  assert.ok(!dump.includes(AT) && !dump.includes('example.com'), 'no email');
  assert.ok(![PHONE, CARD, TAXID, '<script', 'data:image', 'base64', 'Exif', 'GPS'].some((x) => dump.includes(x)), 'no phone, card, tax id, markup or picture');
  assert.ok(!dump.includes(uidOf(mail('hostile.pass'))), 'no account id');
  for (const [, docs] of JSON.parse(dump)) for (const [, d] of docs) assert.deepStrictEqual(Object.keys(d).sort(), ['book', 'owner', 'updatedAt'], 'only books are kept');
  assert.strictEqual(await modelCalls(), 0, 'Punch never calls a model');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/punch', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/punch`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
