// Pure rules first (text and hostile input, box numbering, rooms and their
// colours, flags, statuses and transitions, search with plurals, accents
// and typos, moving day, storage, the CSV, the QR payloads, the label and
// sign layout maths, sharing's text-only payload, the photo reader's
// request and answer, the made-up move), then the page's own promises, then
// end to end against the memory store and the fake model:
//   WHICHBOX_MEMORY=1 WHICHBOX_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /whichbox, the way
// the lab mounts it, so the key cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every move, street, room, box and person here is made up.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.WHICHBOX_MEMORY !== '1' || process.env.WHICHBOX_FAKE_AI !== '1') {
  console.error('run with WHICHBOX_MEMORY=1 WHICHBOX_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient } = require('../server');
const C = require('../public/whichbox-core');
const QR = require('../public/qr');
const K = require('../lib/moves');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NOW = Date.parse('2026-11-08T15:00:00Z');
let seq = 0;
// Fixed dice: the same ids on every run, never the same id twice in a row.
const dice = () => { let x = 2463534242; return (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; seq++; return x % n; }; };
const rand = dice();
const O = { now: NOW, rand };

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
/** The grey a black-and-white printer makes of a colour: same luminance. */
function grey(hex) {
  const l = lum(hex);
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  const h = Math.round(c * 255).toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/** A move built through the core, as the page would build it. */
function move(kind, n) {
  let m = C.newMove({ kind: kind || 'move', from: '7 Quillon Street', to: '22 Marrow Close' }, O);
  for (let i = 0; i < (n || 0); i++) m = C.putBox(m, C.newBox(m, { room: m.rooms[i % m.rooms.length].id, items: [`Thing ${i}`] }, O).box);
  return m;
}
const add = (m, input) => { const b = C.newBox(m, input, O).box; return { m: C.putBox(m, b), b }; };

const u16 = (v) => Buffer.from([(v >> 8) & 255, v & 255]);
/** A small JPEG with an EXIF (location) segment and a comment, w x h. */
function jpeg(w, h, pad) {
  const seg = (m, payload) => Buffer.concat([Buffer.from([0xff, m]), u16(payload.length + 2), payload]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude 51.5074 GPSLongitude -0.1278', 'latin1')),
    seg(0xfe, Buffer.from('taken at 22 Marrow Close', 'latin1')),
    seg(0xc0, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])),
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(pad || 200, 0x55), Buffer.from([0xff, 0xd9]),
  ]);
}
/** A small PNG with a text chunk, w x h. */
function png(w, h) {
  const chunk = (type, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), d, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0GPS 51.5 home address', 'latin1')), chunk('IDAT', Buffer.alloc(40, 1)), chunk('IEND', Buffer.alloc(0))]);
}

/* ================================================================== *
 * Text and hostile input
 * ================================================================== */

test('text: one plain line, invisible and bidi characters removed, markup stripped, cut on a whole character; objects are nothing; escaping covers quotes', () => {
  assert.strictEqual(C.line('  a\n\tb\u202Ec\u200Bd  ', 60), 'a bcd');
  assert.strictEqual(C.line('\u{1F4E6}'.repeat(70), 60), '\u{1F4E6}'.repeat(60));
  assert.strictEqual(C.plain('<img src=x onerror=alert(1)>Kettle <b>and</b> mugs', 60), 'Kettle and mugs');
  assert.strictEqual(C.plain('a < b', 30), 'a b');
  assert.strictEqual(C.plain('x'.repeat(100000), 30).length, 30);
  assert.strictEqual(C.para('line one\n\n\n\nline <i>two</i>\u202e', 300), 'line one\n\nline two');
  for (const v of [{}, [], { toString: () => 'boom' }, () => 1, null, undefined]) assert.strictEqual(C.plain(v, 20), '', String(v));
  assert.strictEqual(C.esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  assert.strictEqual(C.plainOut('Visit https://evil.example/x or www.evil.example and evil.example now', 200), 'Visit or and now');
  assert.strictEqual(C.cleanName('  <b>Noor</b>\u202e  '), 'Noor');
  assert.strictEqual(C.cleanName('Ezra 3000 <script>'), 'Ezra', 'markup and digits go');
  assert.strictEqual(C.cleanName('12345'), '', 'a name needs a letter');
  assert.strictEqual(C.cleanName('Jean-Luc O\u2019Neill'), 'Jean-Luc O\u2019Neill');
  assert.strictEqual(C.cleanItem('salt; pepper'), 'salt, pepper', 'a semicolon would split an item in the CSV');
  assert.deepStrictEqual(C.splitItems('kettle, mugs; tea\nplates \u2022 bowls,, ,'), ['Kettle', 'Mugs', 'Tea', 'Plates', 'Bowls'], 'typed things start with a capital');
  assert.deepStrictEqual(C.cleanItems(['Mugs', 'mug', 'MUGS', ' Plates ', '', '<b></b>', 'Knives', 'knife', 'Shelf', 'shelves', 'Gloves', 'glove', 'Batteries', 'battery', 'Boxes', 'box']), ['Mugs', 'Plates', 'Knives', 'Shelf', 'Gloves', 'Batteries', 'Boxes'], 'one thing however it is written');
  assert.ok(!C.carriesPhoto({ note: 'n'.repeat(2000) }), 'a long run of one key is not a photo');
  assert.strictEqual(C.cleanItems(Array.from({ length: 500 }, (_, i) => `Thing ${i}`)).length, C.LIMITS.items);
});

test('codes: six characters from an alphabet with no I, O, 0 or 1; typed however; the server draws only from it', () => {
  assert.ok(!/[IO01]/.test(C.CODE_ALPHABET) && C.CODE_ALPHABET.length === 32);
  assert.strictEqual(C.normalizeCode(' abc-234 '), 'ABC234');
  assert.ok(C.isCode('ABC234') && !C.isCode('ABC23O') && !C.isCode('ABC2345'));
  assert.strictEqual(C.formatCode('abc234'), 'ABC-234');
  for (let i = 0; i < 200; i++) assert.ok(C.isCode(K.newCode()));
  assert.ok(C.isSid(K.newMoveId()) && /^[A-Za-z0-9_-]{22}$/.test(K.newKey()));
  assert.notStrictEqual(K.keyHash('k'.repeat(22), 'a'.repeat(16)), K.keyHash('k'.repeat(22), 'b'.repeat(16)), 'one phone is unlinkable across moves');
});

/* ================================================================== *
 * Boxes, rooms, flags, statuses
 * ================================================================== */

test('box numbering: the next number each time; a number in use is refused and the next free one named; numbers are never handed out twice, even after a delete', () => {
  let m = move();
  const r1 = add(m, { room: m.rooms[0].id, items: ['Kettle'] }); m = r1.m;
  const r2 = add(m, { room: m.rooms[0].id }); m = r2.m;
  assert.deepStrictEqual([r1.b.no, r2.b.no, C.nextNo(m)], [1, 2, 3]);
  assert.throws(() => C.newBox(m, { no: 2, room: m.rooms[0].id }, O), (e) => e.status === 409 && /Box 2 is already used\. The next free number is 3\./.test(e.message));
  const r9 = add(m, { no: 9, room: m.rooms[1].id }); m = r9.m;
  assert.strictEqual(C.nextNo(m), 10, 'after a chosen number the count carries on from it');
  m = C.dropBox(m, r9.b.id);
  assert.strictEqual(C.nextNo(m), 10, 'box 9 was deleted, but its label may still be on a box - 9 is not handed out again');
  for (const bad of [0, -3, 10000, 1.5, 'twelve', '3e2']) assert.throws(() => C.newBox(m, { no: bad, room: m.rooms[0].id }, O), (e) => e.status === 400, String(bad));
  assert.strictEqual(C.newBox(m, { no: '12', room: m.rooms[0].id }, O).box.no, 12, 'a typed number is a number');
  assert.throws(() => C.editBox(m, r1.b, { no: 2 }, O), (e) => e.status === 409);
  assert.strictEqual(C.editBox(m, r1.b, { no: 40 }, O).no, 40);
  const full = Object.assign(C.clone(m), { boxes: Array.from({ length: 500 }, (_, i) => ({ ...r1.b, id: `bfull${i}x`, no: i + 1 })) });
  assert.throws(() => C.newBox(full, { room: m.rooms[0].id }, O), (e) => e.status === 409 && /500 boxes/.test(e.message));
  assert.strictEqual(C.newBox(m, { room: 'nope' }, O).box.room, m.rooms[0].id, 'an unknown room falls back to the first one');
  assert.strictEqual(r1.b.status, 'packed');
  const same = () => () => 0; // dice that always roll the same
  const once = C.newBox(m, { room: m.rooms[0].id }, { now: NOW, rand: same() }).box;
  assert.throws(() => C.newBox(C.putBox(m, once), { room: m.rooms[0].id }, { now: NOW, rand: same() }), (e) => e.status === 503, 'a drawn id already in the move is never reused');
});

test('rooms and colours: every colour keeps white words at 4.5:1 - in colour and in black and white; kinds are worked out from names; names are unique; a room in use cannot be removed', () => {
  assert.ok(C.PALETTE.length >= 12);
  for (const p of C.PALETTE) {
    assert.ok(ratio('#ffffff', p.hex) >= 4.5, `${p.name}: ${ratio('#ffffff', p.hex).toFixed(2)}`);
    assert.ok(ratio('#ffffff', grey(p.hex)) >= 4.5, `${p.name} printed in grey (${grey(p.hex)}): ${ratio('#ffffff', grey(p.hex)).toFixed(2)}`);
  }
  assert.strictEqual(new Set(C.PALETTE.map((p) => p.hex)).size, C.PALETTE.length, 'no two colours the same');
  const m = move();
  assert.deepStrictEqual(m.rooms.map((r) => r.name), ['Kitchen', 'Living room', 'Bedroom 1', 'Bedroom 2', 'Bathroom', 'Office', 'Kids\u2019 room', 'Garage', 'Storage']);
  assert.deepStrictEqual(m.rooms.map((r) => r.kind), ['kitchen', 'living', 'bedroom', 'bedroom', 'bathroom', 'office', 'kids', 'garage', 'storage']);
  assert.strictEqual(new Set(m.rooms.map((r) => r.color)).size, m.rooms.length, 'every starting room has its own colour');
  assert.deepStrictEqual(['Nursery', 'The shed', 'Loft', 'Spare room', 'Lounge', 'En suite', 'Utility', 'Patio', 'Music room', 'Holidays', 'Paperwork'].map(C.roomKind), ['kids', 'garage', 'storage', 'bedroom', 'living', 'bathroom', 'laundry', 'outdoor', 'other', 'storage', 'office']);
  assert.deepStrictEqual(C.suggestItems(move('storage'), '', [], C.defaultRooms('storage', rand)[0], 2), ['Holiday decorations', 'String lights'], 'a storage list\u2019s Holidays room offers holiday things');
  const a = C.addRoom(m, { name: 'Nursery' }, rand);
  assert.ok(a.move.rooms.length === 10 && a.room.kind === 'kids' && C.COLOR_IDS.includes(a.room.color));
  assert.strictEqual(C.addRoom(a.move, { name: ' nursery ' }, rand).move, a.move, 'a name already used is that room');
  assert.throws(() => C.addRoom(m, { name: '<b></b>' }, rand), (e) => e.status === 400);
  assert.throws(() => C.editRoom(m, m.rooms[0].id, { name: 'Office' }), (e) => e.status === 409);
  assert.strictEqual(C.editRoom(m, m.rooms[0].id, { color: 'teal' }).rooms[0].color, 'teal');
  const { m: m2 } = add(m, { room: m.rooms[0].id });
  assert.throws(() => C.removeRoom(m2, m.rooms[0].id), (e) => e.status === 409 && /1 box goes to that room/.test(e.message));
  assert.strictEqual(C.removeRoom(m2, m.rooms[1].id).rooms.length, 8);
  assert.deepStrictEqual(C.cleanRooms([{ id: 'raaaaa1', name: 'A', color: 'nope' }, { id: 'raaaaa1', name: 'B' }, { id: 'rbbbbb2', name: 'a' }, null, 'x', { id: 'BAD', name: 'C' }]), [{ id: 'raaaaa1', name: 'A', color: 'stone', kind: 'other' }], 'unknown colours, repeated ids and names, junk all dropped');
});

test('flags: a fixed set, printed as bold WORDS on the label - and Valuables never printed', () => {
  assert.deepStrictEqual(C.cleanFlags(['heavy', 'nope', 'fragile', 'fragile', 'valuables']), ['fragile', 'heavy', 'valuables']);
  assert.deepStrictEqual(C.printedFlags(['fragile', 'openfirst', 'heavy', 'upright', 'valuables']), ['FRAGILE', 'OPEN FIRST', 'HEAVY', 'THIS WAY UP']);
  const { m, b } = add(move(), { room: move().rooms[0].id, flags: ['valuables', 'fragile'] });
  const L = C.labelFor(m, b, C.labelGrid('letter', 6), {});
  assert.deepStrictEqual(L.flags, ['FRAGILE']);
  assert.ok(!/valuable/i.test(JSON.stringify(L)), 'nothing on the label says valuables');
});

test('statuses and transitions: Packed -> Loaded -> Delivered -> Unpacked; storage In storage <-> Taken out; any status can be set back; nothing else', () => {
  assert.deepStrictEqual(['packed', 'loaded', 'delivered', 'unpacked'].map((s) => C.nextStatus('move', s)), ['loaded', 'delivered', 'unpacked', null]);
  assert.deepStrictEqual(['stored', 'out'].map((s) => C.nextStatus('storage', s)), ['out', 'stored']);
  assert.deepStrictEqual([C.cleanStatus('move', 'out'), C.cleanStatus('storage', 'delivered'), C.cleanStatus('move', 'loaded')], ['packed', 'stored', 'loaded']);
  assert.ok(C.arrived('delivered') && C.arrived('unpacked') && !C.arrived('loaded'));
  const { m, b } = add(move(), { room: move().rooms[0].id });
  const d = C.setStatus(m, b, 'delivered', { now: NOW + 60000, by: 'Noor' });
  assert.deepStrictEqual([d.status, d.statusAt, d.by], ['delivered', C.iso(NOW + 60000), 'Noor']);
  assert.strictEqual(C.setStatus(m, d, 'packed', { now: NOW }).status, 'packed', 'a mis-tap is undone by tapping the right one');
  assert.throws(() => C.setStatus(m, b, 'out', O), (e) => e.status === 400, 'a move box is never "taken out"');
  assert.throws(() => C.setStatus(m, b, '__proto__', O), (e) => e.status === 400);
  const s = move('storage');
  assert.strictEqual(add(s, { room: s.rooms[0].id }).b.status, 'stored');
  assert.deepStrictEqual(Object.keys(C.boxPatch(b, C.editBox(m, b, { items: ['Kettle'] }, O), C.EDIT_FIELDS)), ['items'], 'an edit is a patch of the fields that changed');
});

/* ================================================================== *
 * Search
 * ================================================================== */

test('search forgives: plurals both ways, accents, small typos, a box number - and does not invent matches', () => {
  let m = move();
  const put = (no, room, items, note) => { m = C.putBox(m, C.newBox(m, { no, room: m.rooms[room].id, items, note }, O).box); };
  put(14, 0, ['Kettle', 'Mugs', 'Crème brûlée dish', 'Batteries', 'Café cups']);
  put(3, 0, ['Knife', 'Shelves', 'Glove'], 'Toolbox lid is cracked - too heavy for one');
  put(7, 7, ['Toolbox', 'Drill']);
  put(9, 2, []);
  const nos = (q) => C.search(m, q).map((r) => r.box.no);
  assert.deepStrictEqual(nos('kettle'), [14]);
  assert.deepStrictEqual(nos('KETTLE '), [14]);
  assert.deepStrictEqual(nos('mug'), [14], 'singular finds the plural');
  assert.deepStrictEqual(nos('knives'), [3], 'plural finds the singular');
  assert.deepStrictEqual(nos('shelf'), [3]);
  assert.deepStrictEqual(nos('gloves'), [3]);
  assert.deepStrictEqual(nos('battery'), [14]);
  assert.deepStrictEqual(nos('creme brulee'), [14], 'accents fold away');
  assert.deepStrictEqual(nos('cafe'), [14]);
  assert.deepStrictEqual(nos('ketle'), [14], 'a letter missing');
  assert.deepStrictEqual(nos('kettel'), [14], 'two letters swapped');
  assert.deepStrictEqual(nos('baterries'), [14], 'a long word allows two slips');
  assert.deepStrictEqual(nos('ket'), [14], 'the start of a word while typing');
  assert.deepStrictEqual(nos('tool'), [7, 3], '"tool" is the start of Toolbox - and never a typo of "too"');
  assert.deepStrictEqual(nos('14'), [14]);
  assert.deepStrictEqual(nos('#14'), [14]);
  assert.deepStrictEqual(nos('box 14'), [14]);
  assert.deepStrictEqual(nos('drill kitchen'), [], 'every word must match somewhere in one box');
  assert.deepStrictEqual(nos('kettle kitchen'), [14]);
  assert.deepStrictEqual(nos('zebra'), []);
  assert.deepStrictEqual(nos(''), []);
  assert.deepStrictEqual(nos('<script>'), []);
  const hit = C.search(m, 'kettle')[0];
  assert.deepStrictEqual(hit.hits, [{ field: 'item', text: 'Kettle' }]);
  assert.strictEqual(C.boxLine(m, hit.box), 'Box 14 · Kitchen · Packed');
  assert.deepStrictEqual(C.unlisted(m).map((b) => b.no), [9], 'where something unlisted might be');
  assert.ok(C.search(m, 'x'.repeat(5000)).length === 0, 'a huge query is cut, not a hang');
});

test('suggestions: what usually goes in this room first, then words this move already uses; never one already in the box', () => {
  let m = move();
  m = C.putBox(m, C.newBox(m, { room: m.rooms[0].id, items: ['Phone chargers', 'Mugs'] }, O).box);
  m = C.putBox(m, C.newBox(m, { room: m.rooms[1].id, items: ['Phone chargers'] }, O).box);
  const kitchen = m.rooms[0];
  assert.deepStrictEqual(C.suggestItems(m, '', ['Plates'], kitchen, 4), ['Bowls', 'Mugs', 'Glasses', 'Cutlery']);
  assert.deepStrictEqual(C.suggestItems(m, 'ch', [], kitchen), ['Phone chargers', 'Chargers']);
  assert.deepStrictEqual(C.suggestItems(m, 'mug', ['mug'], kitchen), [], 'already in the box');
  assert.deepStrictEqual(C.wordsUsed(m)[0], { text: 'Phone chargers', n: 2 });
});

/* ================================================================== *
 * Moving day and storage
 * ================================================================== */

test('moving day: per room "Kitchen: 3 of 4 delivered", the open-first boxes pinned (the ones not yet delivered first), loaded but not delivered, not loaded yet, and the overall line', () => {
  const m = C.sampleMove(O);
  const d = C.dayCounts(m);
  assert.strictEqual(d.line, '9 of 18 boxes in the new place');
  assert.deepStrictEqual(d.rooms.map((r) => r.line).slice(0, 3), ['Kitchen: 3 of 4 delivered', 'Living room: 3 of 4 delivered', 'Bedroom 1: 1 of 2 delivered']);
  assert.deepStrictEqual(d.openFirst.map((b) => b.no), [13, 7, 10, 14], 'still on the truck first');
  assert.deepStrictEqual(d.missing.map((b) => b.no), [3, 8, 11, 13, 15, 17, 18]);
  assert.deepStrictEqual(d.notLoaded.map((b) => b.no), [9, 16]);
  assert.ok(!d.done);
  let all = m;
  for (const b of m.boxes) all = C.putBox(all, C.setStatus(all, b, 'delivered', O));
  assert.ok(C.dayCounts(all).done && C.dayCounts(all).line === '18 of 18 boxes in the new place');
  assert.strictEqual(C.dayCounts(move()).line, 'No boxes yet');
  assert.strictEqual(C.summaryLine(m), '18 boxes · 9 in the new place');
});

test('storage: what\u2019s where groups by place however it is typed; seasonal tags counted; taken out listed; a move\u2019s boxes carry no place or tags', () => {
  const s = C.sampleStorage(O);
  const w = C.whereView(s);
  assert.deepStrictEqual(w.places.map((p) => [p.name, p.boxes.length]), [['Garage shelf 2', 2], ['Loft left', 3], ['Loft right', 2], ['Under the stairs', 1]]);
  assert.deepStrictEqual(w.tags.slice(0, 2), [{ tag: 'Holiday decorations', n: 3 }, { tag: 'Summer', n: 2 }]);
  assert.deepStrictEqual(w.out.map((b) => b.no), [3, 6]);
  let x = s;
  x = C.putBox(x, C.newBox(x, { room: x.rooms[0].id, location: '  loft LEFT ', tags: ['holiday decorations', 'Holiday Decorations', 'Winter'] }, O).box);
  assert.strictEqual(C.whereView(x).places.find((p) => p.name === 'Loft left').boxes.length, 4, 'one place however it is typed');
  assert.deepStrictEqual(x.boxes[x.boxes.length - 1].tags, ['holiday decorations', 'Winter']);
  assert.strictEqual(C.summaryLine(s), '8 boxes · 2 taken out');
  const m = move();
  const b = C.newBox(m, { room: m.rooms[0].id, location: 'Loft', tags: ['Summer'] }, O).box;
  assert.deepStrictEqual([b.location, b.tags], ['', []]);
});

/* ================================================================== *
 * CSV
 * ================================================================== */

test('CSV: out and back in is the same boxes; formulas are defused on the way out and restored on the way in; numbers already used are skipped; odd files read or refuse kindly', () => {
  const m = C.sampleMove(O);
  const csv = C.boxesCsv(m);
  assert.ok(csv.startsWith('box,room,room_colour,status,contents,flags,note,location,tags,updated\r\n'));
  const fresh = C.newMove({ kind: 'move' }, O);
  const back = C.fromCsv(csv, fresh, O);
  assert.deepStrictEqual([back.added, back.skipped, back.error], [18, 0, '']);
  const shape = (x) => x.boxes.map((b) => [b.no, C.roomOf(x, b.room).name, C.roomOf(x, b.room).color, b.items, b.flags, b.status, b.note]);
  assert.deepStrictEqual(shape(back.move), shape(m), 'numbers, rooms and colours, contents, flags, statuses and notes all survive');
  const again = C.fromCsv(csv, back.move, O);
  assert.deepStrictEqual([again.added, again.skipped], [0, 18], 'importing twice adds nothing');
  let evil = C.newMove({ kind: 'move' }, O);
  evil = C.putBox(evil, C.newBox(evil, { room: evil.rooms[0].id, items: ['=HYPERLINK("https://evil.example","x")', '+1', '@SUM(A1)'], note: '-2+3' }, O).box);
  const out = C.boxesCsv(evil);
  assert.ok(out.includes('"\'=HYPERLINK(""https://evil.example"",""x"")') && out.includes('\'-2+3'), 'a leading = + - @ never reaches a spreadsheet as a formula');
  const round = C.fromCsv(out, C.newMove({ kind: 'move' }, O), O).move.boxes[0];
  assert.strictEqual(round.note, '-2+3', 'our own defusing is undone on the way back');
  assert.ok(round.items.includes('+1'));
  const odd = C.fromCsv('\ufeffBox,Room,Contents,Status\r\n"#4","Den","Lamp; ""big"" rug\nwith fringe",Loaded\n', C.newMove({ kind: 'move' }, O), O);
  assert.deepStrictEqual([odd.added, odd.move.boxes[0].no, odd.move.boxes[0].items, odd.move.boxes[0].status, C.roomOf(odd.move, odd.move.boxes[0].room).name], [1, 4, ['Lamp', '"big" rug with fringe'], 'loaded', 'Den'], 'a BOM, quotes, a line break inside quotes, a new room');
  assert.strictEqual(C.fromCsv('', fresh, O).error, 'That file is empty.');
  assert.match(C.fromCsv('a,b\n1,2', fresh, O).error, /no box and contents columns/);
  assert.match(C.fromCsv('box,contents\nnope,x', fresh, O).error, /No boxes could be read/);
});

/* ================================================================== *
 * QR payloads and the routes they open
 * ================================================================== */

test('QR payloads: a box on this phone opens #box/<id>; a shared move\u2019s box #s/<move>/<box> - never with the join code in it; every hash is parsed strictly', () => {
  const m = C.sampleMove(O);
  const b = m.boxes[13];
  const base = '/whichbox/';
  assert.strictEqual(C.boxUrl('https://challenge.strongtechnicalconsulting.com', base, m, b), `https://challenge.strongtechnicalconsulting.com/whichbox/#box/${b.id}`);
  const s = Object.assign(C.clone(m), { shared: { id: 'AbCdEfGh_jKl-nOp', role: 'owner', code: 'ABC234' } });
  const url = C.boxUrl('https://challenge.strongtechnicalconsulting.com', base, s, b);
  assert.strictEqual(url, `https://challenge.strongtechnicalconsulting.com/whichbox/#s/AbCdEfGh_jKl-nOp/${b.id}`);
  assert.ok(!url.includes('ABC234'), 'a label never lets a stranger in');
  assert.strictEqual(C.joinUrl('https://x.test', base, 'abc-234'), 'https://x.test/whichbox/#join=ABC234');
  assert.deepStrictEqual(C.parseHash(`#box/${b.id}`), { view: 'box', id: b.id });
  assert.deepStrictEqual(C.parseHash('#s/AbCdEfGh_jKl-nOp/bdemo1xx'), { view: 'sbox', sid: 'AbCdEfGh_jKl-nOp', id: 'bdemo1xx' });
  assert.deepStrictEqual(C.parseHash('#join=abc-234'), { view: 'join', code: 'ABC234' });
  for (const h of ['#box/<img>', '#box/' + 'a'.repeat(40), '#s/short/b', '#javascript:alert(1)', '#constructor', '#__proto__', '#join=<x>']) assert.strictEqual(C.parseHash(h).view, '', h);
  const mx = QR.matrix(url);
  assert.ok(mx.length <= 41, `the label's QR stays at version 6 or less (${mx.length} modules), so 27 mm gives each module half a millimetre`);
  assert.ok(!/<script|onerror/i.test(QR.svg(url, '<script>alert(1)</script>')), 'the QR\u2019s label is stripped of markup');
});

/* ================================================================== *
 * Labels and signs
 * ================================================================== */

test('label layout: Letter and A4, two or six to a page - every label fits its share of the page, and every row fits its label; long room names squeeze, long numbers shrink, contents end in "+N more"', () => {
  for (const paper of ['letter', 'a4']) {
    for (const per of [2, 6]) {
      const g = C.labelGrid(paper, per);
      assert.ok(C.fits(g), `${paper} ${per}`);
      assert.ok(g.cols * g.w + (g.cols - 1) * g.gap <= g.page.w - 2 * g.margin && g.rows * g.h + (g.rows - 1) * g.gap <= g.page.h - 2 * g.margin, `${paper} ${per}: inside the margins`);
      assert.ok(C.labelHeight(g) <= g.h - 2 * g.pad, `${paper} ${per}: rows ${C.labelHeight(g).toFixed(1)} mm in ${(g.h - 2 * g.pad).toFixed(1)} mm`);
      assert.ok(g.qr >= 25, 'a QR code a phone reads from arm\u2019s length');
      assert.strictEqual(g.cols * g.rows, per);
    }
  }
  assert.deepStrictEqual(['letter', 'a4'].map((p) => [C.labelGrid(p, 6).w, C.labelGrid(p, 6).h]), [[94.9, 81.8], [92, 87.6]]);
  assert.deepStrictEqual([C.paperFor('en-US'), C.paperFor('en-CA'), C.paperFor('en-GB'), C.paperFor('de-DE'), C.paperFor('en-US@posix'), C.paperFor('')], ['letter', 'letter', 'a4', 'a4', 'letter', 'a4']);
  const g = C.labelGrid('letter', 6);
  const f1 = C.bandFit('KITCHEN', 86.9, 15);
  assert.ok(!f1.squeeze && f1.size === 9.3, JSON.stringify(f1));
  const f2 = C.bandFit('THE BIG UPSTAIRS GUEST BEDROOM AT THE BACK', 86.9, 15);
  assert.ok(f2.squeeze && f2.size >= 5, 'a long name is squeezed to the width, never cut or overflowing');
  let m = move();
  const big = C.newBox(m, { no: 1234, room: m.rooms[0].id, items: Array.from({ length: 30 }, (_, i) => `Thing number ${i}`) }, O).box;
  m = C.putBox(m, big);
  const L = C.labelFor(m, big, g, { url: 'https://x.test/#box/' + big.id });
  assert.ok(L.num < g.num && L.num * 0.62 * 4 <= g.w - 2 * g.pad - g.qr - 3 + 1e-9, 'four digits shrink to fit beside the QR');
  assert.match(L.items, /\+\d+ more$/);
  assert.strictEqual(L.roomText, 'KITCHEN');
  assert.strictEqual(C.labelFor(m, big, g, { contents: false }).items, '', 'contents can be left off');
  assert.strictEqual(C.fitItems(['A very long single thing that cannot possibly fit on two lines of a small label at all'], 20, 3.4, 1).slice(-1), '…');
  const sign = C.signFor(C.sampleMove(O), C.sampleMove(O).rooms[0], 'a4');
  assert.deepStrictEqual([sign.text, sign.nos, sign.w], ['KITCHEN', [1, 2, 3, 14], 190]);
  assert.strictEqual(C.rangeLine([14, 1, 2, 3, 7, 8]), '1\u20133, 7, 8, 14');
});

/* ================================================================== *
 * Cleaning what comes back from a phone, a file or a server
 * ================================================================== */

test('a move read back from storage: one door - bounded, unknown fields dropped, repeated ids and numbers dropped, no prototype pollution, shared members cleaned', () => {
  const raw = JSON.parse(JSON.stringify(C.sampleMove(O)));
  raw.evil = '<script>'; raw.boxes[0].evil = 1; raw.boxes[0].photo = 'yes';
  raw.boxes.push({ ...raw.boxes[1] }, { ...raw.boxes[2], id: 'bnewid99' }, { id: 'x', no: 1 }, null, 'nope');
  raw.boxes.push(JSON.parse('{"id":"bproto01","no":77,"__proto__":{"polluted":true},"items":["a"]}'));
  raw.shared = { id: 'AbCdEfGh_jKl-nOp', role: 'owner', code: 'ABC234', v: 4, at: 1, members: [{ id: 'mabcdef1', name: '<b>Noor</b>', role: 'helper', keyHash: 'secret' }, { id: 'BAD', name: 'X' }] };
  const m = C.cleanMove(raw, O);
  assert.ok(!('evil' in m) && !('evil' in m.boxes[0]) && m.boxes[0].photo === false);
  assert.strictEqual(m.boxes.length, 19, 'the repeated id and the repeated number are dropped; the new number stays');
  assert.ok(!({}).polluted && !Object.prototype.polluted);
  assert.deepStrictEqual(m.shared.members, [{ id: 'mabcdef1', name: 'Noor', role: 'helper', you: false }], 'no key hash survives');
  assert.strictEqual(C.cleanMove({ id: 'mxxxxxx1', rooms: [] }, O), null, 'a move with no rooms is not a move');
  assert.strictEqual(C.cleanMove('nope', O), null);
});

test('sharing is text only: what leaves the phone is name, places, rooms and box text; anything that looks like a photo is spotted wherever it hides', () => {
  const m = C.sampleMove(O);
  m.boxes[0].photo = true;
  assert.deepStrictEqual(Object.keys(C.shareBox(m.boxes[0])), C.SHARE_BOX_FIELDS);
  assert.ok(!JSON.stringify(m.boxes.map(C.shareBox)).includes('photo'));
  assert.deepStrictEqual(Object.keys(C.shareMeta(m)).sort(), ['from', 'kind', 'name', 'rooms', 'to']);
  assert.ok(!C.carriesPhoto({ boxes: m.boxes.map(C.shareBox), ...C.shareMeta(m) }), 'a real share carries none');
  for (const bad of [{ photo: true }, { boxes: [{ items: ['x'], thumb: 'a' }] }, { note: 'data:image/jpeg;base64,AAAA' }, { items: [jpeg(60, 60, 600).toString('base64')] }, { a: { b: { c: { Image: 1 } } } }, { boxes: [{ blob: 1 }] }]) {
    assert.ok(C.carriesPhoto(bad), JSON.stringify(bad).slice(0, 60));
  }
});

test('the server\u2019s view of a shared move: page-shaped, who changed what by first name, the code for the owner only - never a key hash', () => {
  const rooms = C.sampleMove(O).rooms;
  const doc = { name: 'Larkfield \u2192 Harbour', kind: 'move', rooms, code: 'ABC234', v: 7, members: { mown001: { name: 'Robin', role: 'owner', keyHash: 'h1', joinedAt: 'a' }, mhelp001: { name: 'Noor', role: 'helper', keyHash: 'h2', joinedAt: 'b' } } };
  const boxes = [{ bid: 'bxxxxxx1', no: 2, room: rooms[0].id, items: ['Pots'], status: 'delivered', statusBy: 'mhelp001' }, { bid: 'bxxxxxx2', no: 1, room: rooms[1].id, items: ['Books'] }, { bid: 'bxxxxxx3', no: 1, room: rooms[1].id }];
  const owner = C.sharedView(doc, boxes, 'mown001', O);
  const helper = C.sharedView(doc, boxes, 'mhelp001', O);
  assert.deepStrictEqual(owner.boxes.map((b) => [b.no, b.by || '']), [[1, ''], [2, 'Noor']], 'sorted, a repeated number dropped');
  assert.deepStrictEqual([owner.role, owner.code, helper.role, helper.code], ['owner', 'ABC234', 'helper', '']);
  assert.deepStrictEqual(helper.members.map((x) => [x.name, x.role, x.you]), [['Robin', 'owner', false], ['Noor', 'helper', true]]);
  assert.ok(!/keyHash|h1|h2/.test(JSON.stringify(owner)));
});

/* ================================================================== *
 * "List what's in this box"
 * ================================================================== */

test('the photo reader\u2019s request: exactly one JPEG or PNG and nothing else', () => {
  const data = jpeg(800, 600).toString('base64');
  assert.ok(C.aiRequest({ image: { type: 'image/jpeg', data } }));
  for (const bad of [null, [], {}, { image: { type: 'image/jpeg', data }, rooms: ['Kitchen'] }, { image: { type: 'image/gif', data } }, { image: { type: 'image/jpeg', data, name: 'x' } }, { image: { type: 'image/jpeg', data: 'not base64!' } }, { image: { type: 'image/jpeg', data: 'A'.repeat(2000000) } }, { image: 'data:image/jpeg;base64,' + data }]) {
    assert.strictEqual(C.aiRequest(bad), null, JSON.stringify(bad).slice(0, 60));
  }
});

test('the photo reader\u2019s answer: at most 40 short plain names, no links or long numbers, a room KIND from the fixed list or unsure, flags only fragile or heavy', () => {
  const ok = C.cleanAiAnswer({ items: ['Kettle', 'Mugs', 'mug', '  Tea towels '], room: 'kitchen', room_confidence: 'high', flags: [{ flag: 'fragile', confidence: 'medium' }], confidence: 'high', note: 'Fine.' });
  assert.deepStrictEqual(ok, { items: ['Kettle', 'Mugs', 'Tea towels'], room: 'kitchen', roomConfidence: 'high', flags: [{ id: 'fragile', confidence: 'medium' }], confidence: 'high', note: 'Fine.' });
  const many = Array.from({ length: 70 }, (_, i) => `Thing ${i}`);
  const bad = C.cleanAiAnswer({ items: ['<img src=x onerror=alert(1)>Lamp', 'Visit https://evil.example/claim', '\u202eselttek', 'Serial 99887766554433', 'www.evil.example', 42, null, 'x'.repeat(300), ...many], room: 'Robin\u2019s bedroom', room_confidence: 'certain', flags: [{ flag: 'valuables', confidence: 'high' }, { flag: 'heavy', confidence: 'sure' }, 'fragile'], confidence: 'certain', note: '<script>x</script> see evil.example' });
  assert.ok(bad.items.length <= 40 && bad.items.every((t) => t.length <= 40));
  assert.ok(!/[<>]|https?:|www\.|evil|\u202e|\d{6}/.test(JSON.stringify(bad.items)), JSON.stringify(bad.items).slice(0, 200));
  assert.deepStrictEqual([bad.items[0], bad.room, bad.roomConfidence, bad.confidence], ['Lamp', 'unsure', 'low', 'low']);
  assert.deepStrictEqual(bad.flags, [{ id: 'heavy', confidence: 'low' }, { id: 'fragile', confidence: 'low' }], 'valuables is never the model\u2019s to say');
  assert.ok(!/evil|script/.test(bad.note));
  assert.strictEqual(C.cleanAiAnswer({ items: [], room: 'unsure' }), null);
  assert.strictEqual(C.cleanAiAnswer('nope'), null);
  const m = move();
  assert.deepStrictEqual([C.roomForKind(m, 'kitchen').name, C.roomForKind(m, 'bedroom').name, C.roomForKind(m, 'laundry'), C.roomForKind(m, 'unsure')], ['Kitchen', 'Bedroom 1', null, null]);
});

test('the made-up move: 18 boxes from 12 Larkfield Lane to 4 Harbour Row, halfway through moving day; the kettle is in Box 14, Kitchen, Delivered; invented helpers only', () => {
  const m = C.sampleMove(O);
  assert.deepStrictEqual([m.name, m.from, m.to, m.boxes.length, m.sample], ['Larkfield \u2192 Harbour', '12 Larkfield Lane', '4 Harbour Row', 18, true]);
  const k = C.search(m, 'kettle');
  assert.strictEqual(C.boxLine(m, k[0].box), 'Box 14 · Kitchen · Delivered');
  assert.ok(k[0].box.flags.includes('openfirst'));
  assert.deepStrictEqual(m.helpers, ['Noor', 'Ezra', 'Juno']);
  assert.ok(m.boxes.some((b) => !b.items.length), 'one box packed in a hurry, nothing listed - so "not found" has somewhere to point');
  assert.ok(m.boxes.some((b) => b.flags.includes('valuables')));
  assert.deepStrictEqual(C.sampleMove(O), C.sampleMove(O), 'no dice: the same every time');
  const loft = C.sampleStorage(O);
  assert.deepStrictEqual([loft.kind, loft.boxes.length, C.search(loft, 'lights')[0].box.location], ['storage', 8, 'Loft left']);
});

/* ================================================================== *
 * The page's own promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the hero, the mock label, the labels and the lab card too; 44px targets; nothing scrolls sideways', () => {
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
    for (const k of ['ok', 'warn', 'bad', 'info']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); for (const bg of ['card', 'bg']) ok(k, bg); }
    for (const fg of ['hero-ink', 'hero-soft']) for (const bg of ['hero-1', 'hero-2']) ok(fg, bg);
    ok('text', 'card2'); ok('bg', 'text');
    ok('accent', 'card', 3); ok('accent', 'track', 3);
  }
  // Colours written as literals: the hero's buttons, the cardboard mock, every printed label and sign.
  for (const [fg, bg] of [['#3a3196', '#ffffff'], ['#ffffff', '#c2410c'], ['#111111', '#ffffff'], ['#4b4136', '#ffffff'], ['#333333', '#ffffff'], ['#166534', '#ffffff'], ['#ffffff', '#8a5300'], ['#ffffff', '#3a3196']]) {
    assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  }
  const lab = require('../../../lab').get('whichbox');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.btn.small', '.link-btn', '.seg button, .chip', '.input, select.input, textarea.input', '.check', 'details.more > summary', '.statusbar button', '.movepill', '.sugg button']) {
    assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*(min-height|height): (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  }
  assert.ok(/\.tabbar button \{[^}]*min-height: 60px/.test(css) && /\.itemchip button \{ min-width: 44px; min-height: 44px/.test(css) && /\.swatches button \{ width: 44px; height: 44px/.test(css) && /\.roomrow \.sw \{ width: 44px; height: 44px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/prefers-reduced-motion: reduce[\s\S]*animation: none !important; transition: none !important/.test(css));
  assert.ok(/@media print \{[\s\S]*body > \*:not\(#print\) \{ display: none !important; \}[\s\S]*print-color-adjust: exact/.test(css), 'print shows only the labels, in their colours');
  assert.ok(/\.lbl \{[^}]*break-inside: avoid/.test(css) && /\.sheetp \{[^}]*break-after: page/.test(css));
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, photos shrunk on the phone, every received string escaped, only the listed API paths, what the AI sheet says', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && html.includes('<script src="qr.js"></script>') && /<body class="dk">/.test(html) && html.includes('class="tabbar dk-tabbar"'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|message)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js) && /localStorage\.removeItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(/try \{\n\s*var r = indexedDB\.open\('whichbox', 1\)/.test(js) && (js.match(/indexedDB\./g) || []).length === 1, 'IndexedDB opened once, inside try');
  assert.ok(!/sessionStorage|document\.cookie/.test(js));
  assert.ok(/redraw\(img, 1200, 0\.8\)/.test(js) && /redraw\(img, 240, 0\.72\)/.test(js), 'photos redrawn at 1200 and 240 px through a canvas');
  assert.match(js, /The photo is shrunk on this phone, its location is removed, and it stays here - it is never shared\./);
  assert.match(js, /<b>What is sent:<\/b> this one photo, shrunk on this phone with its location removed\. Nothing else - not your move’s name or address, your rooms, or what’s already listed\./);
  assert.match(js, /<b>Never photos<\/b> - they stay on this phone\./);
  assert.match(js, /Photos stay on the phone that took them/);
  assert.match(js, /never printed on the label/);
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|PATCH|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/contents', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/join/', 'api/m/', 'api/me', 'api/moves'].sort(), 'the page asks for nothing else');
  assert.match(js, /api\('POST', 'api\/ai\/contents', \{ image: \{ type: 'image\/jpeg', data: b64 \} \}\)/, 'the reader sends the one photo and nothing else');
  assert.match(js, /chunks\.push\(boxes\.slice\(i, i \+ C\.LIMITS\.batch\)\.map\(C\.shareBox\)\)/, 'sharing sends boxes through shareBox - no photo flag');
  assert.match(js, /api\('POST', 'api\/moves', Object\.assign\(C\.shareMeta\(m\)/);
  assert.match(js, /Intl\.getCanonicalLocales\(navigator\.language \|\| 'en-US'\)\[0\] \|\| 'en-US'; \} catch \(e\) \{ return 'en-US'; \}/, 'a locale Intl refuses ("en-US@posix") falls back');
  for (const f of ['public/index.html', 'public/app.js', 'public/whichbox-core.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'lib/moves.js', 'CLAUDE.md']) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  const core = read('public/whichbox-core.js');
  assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.|indexedDB|WebSocket/.test(core), 'the core touches no network or storage');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  assert.ok(!/\(\?<[=!]/.test(core + js), 'no lookbehind (older iPhones cannot parse it)');
  // Every interpolation of something a person, a file, the server or a model wrote goes through esc().
  const unesc = (src) => { let out = '', i = 0; for (;;) { const at = src.indexOf('esc(', i); if (at < 0) return out + src.slice(i); out += src.slice(i, at) + 'ESC'; let depth = 0, j = at + 3; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; } };
  const risky = unesc(js).split('\n').filter((l) => !/toast\(|say\(|confirm\(|prompt\(|copy\(|download\(|textContent|\.value = |shareText\(/.test(l)).join('\n')
    .match(/['"]\s*\+\s*(m\.name|m\.to|m\.from|b\.note|b\.location|b\.by|t|r\.name|x\.name|i\.name|i\.by|p\.note|s\.name|s\.move|L\.items|L\.move|L\.room|L\.roomText|err\.message|e\.message|me\.email|w\.text|h\.text|text|name|room|label|C\.boxLine\([^)]*\)|C\.itemsLine\([^)]*\)|roomName\([^)]*\))\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbody\b|\bimage\b|\bitems\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js') + read('lib/ai.js') + read('lib/moves.js') + read('lib/store.js').replace(/setImmediate/g, '')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /whichbox-shell-v1/.test(sw) && sw.includes("'whichbox-core.js'") && sw.includes("'qr.js'") && /k\.indexOf\('whichbox-'\) === 0/.test(sw), 'the service worker never answers api/ and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  assert.match(js, /You’re offline - this is the move as of ' \+ esc\(timeOf\(m\.shared\.at \|\| now\(\)\)\) \+ '\. Changing a box needs the internet\./, 'a shared move offline shows the last copy and says writes need the network');
});

test('the copy: neutral wording (no he/she/his/her), no invisible characters in any source file, no key-shaped strings, no real person', () => {
  const strings = (src) => [...src.matchAll(/'([^'\\\n]|\\.){3,}'|`[^`]{3,}`|"[^"\n]{3,}"/g)].map((m) => m[0]).join('\n');
  const all = strings(read('public/app.js')) + strings(read('public/whichbox-core.js')) + read('public/index.html') + strings(read('server.js')) + strings(read('lib/ai.js')) + read('CLAUDE.md');
  const gendered = all.match(/\b(he|she|his|hers|him|himself|herself)\b|\bher\b/gi);
  assert.strictEqual(gendered, null, `gendered: ${gendered}`);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const f of walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(src), `${path.relative(ROOT, f)} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bsk-ant-[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}/.test(src), `${path.relative(ROOT, f)} carries a key-shaped string`);
  }
  const demo = read('public/whichbox-core.js') + read('lib/fakeai.js');
  assert.ok(!/\bErik\b/.test(demo), 'no real person in the made-up data');
});

test('local-only switches throw on Cloud Run; the lab prefix is read; every query is one equality filter', () => {
  for (const [mod, env] of [['./lib/store', { WHICHBOX_MEMORY: '1' }], ['./lib/fakeai', { WHICHBOX_FAKE_AI: '1' }], ['./server', { WHICHBOX_FAKE_AI: '1', WHICHBOX_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, WHICHBOX_MEMORY: '', WHICHBOX_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, WHICHBOX_MEMORY: '', WHICHBOX_COLLECTION_PREFIX: 'whichbox_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'whichbox_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual([...new Set(server.match(/store\.list\([^)]*\)/g))].sort(), [
    "store.list('boxes', { where: [['move', '==', sid]] })",
    "store.list('moves', { where: [['code', '==', c]], limit: 1 })",
    "store.list('moves', { where: [['code', '==', code]], limit: 1 })",
  ], 'single-field equality only: no composite index');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g).map((s) => s.replace(/store\.\w+\(/, '')))].sort(), ["'boxes'", "'moves'"], 'two collections');
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
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); call.raw.push(c); }
    const t = await res.text();
    let data = {}; try { data = JSON.parse(t); } catch (e) { data = { text: t }; }
    return { status: res.status, data, text: t, headers: res.headers };
  };
  call.cookies = cookies;
  call.raw = [];
  call.addr = addr;
  return call;
}
// Test accounts on the reserved example domain, built here so no address is written into a file.
const mail = (who) => `${who}${String.fromCharCode(64)}example.com`;
const uidOf = (email) => Buffer.from(email).toString('base64url');
async function register(who, c) {
  const u = c || client();
  const r = await u('POST', '/api/auth/register', { email: mail(who), password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return u;
}
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const BIG = { x: 'x'.repeat(1600 * 1024) };
const photoBody = () => ({ image: { type: 'image/jpeg', data: jpeg(1200, 900, 3000).toString('base64') } });
const GONE = 'This move isn\u2019t shared here. Sharing may have been stopped, or it closed after 90 days with nobody opening it.';
/** A move shared the way the page shares one: meta, then its boxes in batches. */
async function share(owner, n, extra) {
  const m = C.sampleMove(O);
  const r = await owner('POST', '/api/moves', Object.assign(C.shareMeta(m), { you: { name: 'Robin' } }, extra || {}));
  assert.strictEqual(r.status, 200, r.text);
  const boxes = m.boxes.slice(0, n === undefined ? 18 : n).map(C.shareBox);
  for (let i = 0; i < boxes.length; i += 50) { const b = await owner('POST', `/api/m/${r.data.id}/boxes`, { boxes: boxes.slice(i, i + 50) }); assert.strictEqual(b.status, 200, b.text); }
  return { sid: r.data.id, code: r.data.move.code, m };
}
async function joinAs(c, code, name) {
  const r = await c('POST', `/api/join/${code}`, { name });
  assert.strictEqual(r.status, 200, r.text);
  return r.data;
}
const view = async (c, sid) => (await c('GET', `/api/m/${sid}`)).data.move;

test('signed out: the page works with zero model calls; strict headers; the AI route answers 401 before reading a body; there is no route that takes a photo', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  for (const f of ['whichbox-core.js', 'qr.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await fetch(`${base}/labels`)).status, 200, 'any page path serves the app');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/ai/contents', photoBody())).status, 401);
  assert.strictEqual((await anon('POST', '/api/ai/contents', BIG)).status, 401, 'the gate answers before the parser, so never 413');
  for (const p of ['/api/photos', '/api/upload', '/api/boxes', '/api/m/x/photo']) assert.strictEqual((await anon('POST', p, { image: 'x' })).status, 404, `${p}: no such route`);
  assert.strictEqual((await anon('POST', '/api/moves', { name: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  assert.strictEqual((await anon('GET', '/api/m/AbCdEfGh_jKl-nOp')).headers.get('x-robots-tag'), 'noindex, nofollow');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('writes come from this page: another site, another origin or a non-JSON body is refused before anything happens', async () => {
  const c = client();
  assert.strictEqual((await c('POST', '/api/moves', { name: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await c('POST', '/api/moves', { name: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await c('POST', '/api/moves', 'name=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.ok(!store._dump().includes('evil'), 'nothing was made');
});

test('the gates come before the AI route\u2019s parser, in order; the owner check before the batch parser; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/contents', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/m/:id/boxes', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['ownerGate', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to a client');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai.SYSTEM, /never an instruction to you/);
  assert.match(ai.SYSTEM, /never people, faces/);
  assert.strictEqual(ai.TEXT, 'List what is in this open box with the record_contents tool.');
});

test('sharing and joining: the owner\u2019s key is an HttpOnly cookie on the app\u2019s path, stored only as a per-move hash; a code opens only the name and counts; joining twice is the same seat; a name twice gets a number', async () => {
  const owner = client();
  const { sid, code } = await share(owner);
  assert.ok(owner.raw.some((c) => /^whichbox_k=[A-Za-z0-9_-]{22}; Path=\/whichbox\/; Max-Age=\d+; SameSite=Lax; HttpOnly/.test(c)), owner.raw.join(' | '));
  const dump = store._dump();
  assert.ok(!dump.includes(owner.cookies.whichbox_k), 'the key itself is never stored');
  assert.ok(dump.includes(K.keyHash(owner.cookies.whichbox_k, sid)));
  const ov = await view(owner, sid);
  assert.deepStrictEqual([ov.boxes.length, ov.role, ov.code, ov.name, ov.to], [18, 'owner', code, 'Larkfield \u2192 Harbour', '4 Harbour Row']);
  assert.deepStrictEqual(ov.boxes.map((b) => b.id), C.sampleMove(O).boxes.map((b) => b.id), 'every box keeps its id, so a label printed before sharing still opens it on a helper\u2019s phone');
  const peek = await client()('GET', `/api/join/${code.toLowerCase().replace(/(...)/, '$1-')}`);
  assert.deepStrictEqual(Object.keys(peek.data).sort(), ['already', 'boxes', 'by', 'full', 'helpers', 'kind', 'name']);
  assert.deepStrictEqual([peek.data.boxes, peek.data.helpers, peek.data.by], [18, 0, 'Robin']);
  assert.ok(!/Kettle|Harbour Row/.test(peek.text), 'nothing in any box, and not the address');
  const noor = client();
  const j1 = await joinAs(noor, code, 'Noor');
  const j2 = await joinAs(noor, code, 'Somebody else');
  assert.deepStrictEqual([j1.isNew, j2.isNew, j2.me], [true, false, j1.me], 'the same seat');
  const other = client();
  await joinAs(other, code, '<b>Noor</b>');
  const hv = await view(noor, sid);
  assert.deepStrictEqual(hv.members.map((x) => x.name), ['Robin', 'Noor', 'Noor 2']);
  assert.deepStrictEqual([hv.role, hv.code], ['helper', ''], 'helpers are not shown the code');
  assert.ok(!/keyHash/.test(JSON.stringify(hv)));
  assert.strictEqual((await client()('POST', `/api/join/${code}`, { name: '123' })).status, 400, 'a first name needs a letter');
  const since = await noor('GET', `/api/m/${sid}?since=${hv.v}`);
  assert.deepStrictEqual(since.data, { same: true, v: hv.v }, 'an idle move costs one read');
});

test('helpers change a box\u2019s status and nothing else; the owner can do everything - edit, add, delete, rooms, remove a helper, a new code, stop sharing', async () => {
  const owner = client();
  const { sid, code, m } = await share(owner);
  const ezra = client();
  await joinAs(ezra, code, 'Ezra');
  const b3 = m.boxes[2];
  const st = await ezra('PUT', `/api/m/${sid}/box/${b3.id}/status`, { status: 'delivered' });
  assert.deepStrictEqual([st.status, st.data.box.status, st.data.box.by, st.data.v - st.data.was], [200, 'delivered', 'Ezra', 1]);
  assert.strictEqual((await ezra('PUT', `/api/m/${sid}/box/${b3.id}/status`, { status: 'out' })).status, 400, 'not a status a move\u2019s box can have');
  for (const [mt, p, body] of [['POST', '/box', { room: m.rooms[0].id }], ['PATCH', `/box/${b3.id}`, { items: ['Nothing'] }], ['DELETE', `/box/${b3.id}`], ['PATCH', '', { name: 'Mine now' }], ['POST', '/code', {}], ['DELETE', ''], ['POST', '/boxes', { boxes: [{ no: 99, room: m.rooms[0].id }] }]]) {
    const r = await ezra(mt, `/api/m/${sid}${p}`, body);
    assert.strictEqual(r.status, 403, `${mt} ${p}: ${r.text}`);
  }
  assert.strictEqual((await ezra('DELETE', `/api/m/${sid}/members/${(await view(owner, sid)).members[0].id}`)).status, 403);
  // The owner.
  const added = await owner('POST', `/api/m/${sid}/box`, { room: m.rooms[0].id, items: ['Toaster', 'Bread bin'], flags: ['openfirst'] });
  assert.deepStrictEqual([added.status, added.data.box.no, added.data.box.items], [200, 19, ['Toaster', 'Bread bin']]);
  const ed = await owner('PATCH', `/api/m/${sid}/box/${b3.id}`, { items: ['Cookbooks', 'Recipe box'], no: 30 });
  assert.deepStrictEqual([ed.status, ed.data.box.no, ed.data.box.status], [200, 30, 'delivered'], 'the edit kept the helper\u2019s Delivered');
  assert.strictEqual((await owner('PATCH', `/api/m/${sid}/box/${b3.id}`, { no: 1 })).status, 409, 'a number in use');
  const again = await owner('POST', `/api/m/${sid}/box`, { no: 3, room: m.rooms[0].id });
  assert.strictEqual(again.data.box.no, 3, 'the old number is free once renumbered');
  assert.strictEqual((await owner('DELETE', `/api/m/${sid}/box/${again.data.box.id}`)).status, 200);
  const rooms = (await view(owner, sid)).rooms;
  assert.strictEqual((await owner('PATCH', `/api/m/${sid}`, { rooms: rooms.slice(1) })).status, 409, 'boxes still go to the kitchen');
  const nr = await owner('PATCH', `/api/m/${sid}`, { rooms: rooms.concat([{ id: 'rnursery1', name: 'Nursery', color: 'pink' }]), name: 'Our move' });
  assert.deepStrictEqual([nr.status, nr.data.move.rooms.length, nr.data.move.name], [200, 10, 'Our move']);
  const ezraId = nr.data.move.members.find((x) => x.name === 'Ezra').id;
  assert.strictEqual((await owner('DELETE', `/api/m/${sid}/members/${ezraId}`)).status, 200);
  const out = await ezra('GET', `/api/m/${sid}`);
  assert.deepStrictEqual([out.status, out.data.error], [404, GONE], 'a removed helper gets the stranger\u2019s 404');
  const nc = await owner('POST', `/api/m/${sid}/code`, {});
  assert.notStrictEqual(nc.data.code, code);
  assert.strictEqual((await client()('GET', `/api/join/${code}`)).status, 404, 'the old code stops at once');
  const juno = client(); await joinAs(juno, nc.data.code, 'Juno');
  assert.strictEqual((await juno('DELETE', `/api/m/${sid}/me`)).status, 200, 'a helper can leave');
  assert.strictEqual((await owner('DELETE', `/api/m/${sid}/me`)).status, 409, 'the owner stops sharing instead');
  assert.strictEqual((await owner('DELETE', `/api/m/${sid}`)).status, 200);
  assert.ok(!store._dump().includes(sid), 'the move and every box in it are gone');
  assert.deepStrictEqual((await owner('GET', `/api/m/${sid}`)).data.error, GONE);
});

test('two helpers, one truck: ten helpers mark ten boxes Delivered at once and all stick; the owner editing a box while a helper marks it Delivered both stick; ten boxes added at once get ten numbers', async () => {
  const owner = client();
  const { sid, code, m } = await share(owner);
  const helpers = [];
  for (let i = 0; i < 10; i++) { const h = client(); await joinAs(h, code, `Helper ${'ABCDEFGHIJ'[i]}`); helpers.push(h); }
  const rs = await Promise.all(helpers.map((h, i) => h('PUT', `/api/m/${sid}/box/${m.boxes[i].id}/status`, { status: 'delivered' })));
  assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join());
  const v = await view(owner, sid);
  assert.deepStrictEqual(v.boxes.slice(0, 10).map((b) => b.status), Array(10).fill('delivered'));
  assert.strictEqual(new Set(v.boxes.slice(0, 10).map((b) => b.by)).size, 10, 'each with who did it');
  const target = m.boxes[12];
  const [a, b] = await Promise.all([
    owner('PATCH', `/api/m/${sid}/box/${target.id}`, { items: ['Building blocks', 'Night light', 'Rocket lamp'] }),
    helpers[0]('PUT', `/api/m/${sid}/box/${target.id}/status`, { status: 'delivered' }),
  ]);
  assert.deepStrictEqual([a.status, b.status], [200, 200]);
  const t = (await view(owner, sid)).boxes.find((x) => x.id === target.id);
  assert.deepStrictEqual([t.status, t.items], ['delivered', ['Building blocks', 'Night light', 'Rocket lamp']], 'different keys of one box - neither undoes the other');
  const adds = await Promise.all(Array.from({ length: 10 }, (_, i) => owner('POST', `/api/m/${sid}/box`, { room: m.rooms[i % 9].id, items: [`Late box ${i}`] })));
  const nos = adds.map((r) => r.data.box.no).sort((x, y) => x - y);
  assert.deepStrictEqual(nos, [19, 20, 21, 22, 23, 24, 25, 26, 27, 28], 'numbers decided inside a transaction');
  // And why one document per box: the same two writes as a read-change-write of one list lose one.
  await store.set('demo_list', 'one', { boxes: [{ no: 1, status: 'loaded' }, { no: 2, status: 'loaded' }] });
  await Promise.all([1, 2].map((no) => store._unsafeUpdate('demo_list', 'one', (cur) => ({ boxes: cur.boxes.map((x) => (x.no === no ? { ...x, status: 'delivered' } : x)) }))));
  const lost = await store.get('demo_list', 'one');
  assert.strictEqual(lost.boxes.filter((x) => x.status === 'delivered').length, 1, 'one list in one document loses a write');
  await store.remove('demo_list', 'one');
});

test('the same 404, word for word, for an unknown move, a malformed id, one that is not yours, and one nobody opened for 90 days - which the read that finds it deletes', async () => {
  const owner = client();
  const { sid, code, m } = await share(owner, 3);
  const stranger = client();
  for (const p of [`/api/m/${sid}`, '/api/m/AbCdEfGh_jKl-nOp', '/api/m/short', `/api/m/${sid}/box/${m.boxes[0].id}/status`]) {
    const r = await stranger(p.endsWith('status') ? 'PUT' : 'GET', p, p.endsWith('status') ? { status: 'delivered' } : undefined);
    assert.deepStrictEqual([r.status, r.data.error, r.data.code], [404, GONE, 'gone'], p);
  }
  const helper = client(); await joinAs(helper, code, 'Noor');
  assert.strictEqual((await helper('GET', `/api/m/${sid}`)).status, 200);
  const old = new Date(Date.now() - 91 * 86400000).toISOString();
  await store.transactKeys('moves', sid, () => ({ set: { updatedAt: old, activeAt: old }, del: [] }));
  const r = await helper('GET', `/api/m/${sid}`);
  assert.deepStrictEqual([r.status, r.data.error], [404, GONE]);
  assert.ok(!store._dump().includes(sid), 'deleted on read, boxes and all - no timer');
  assert.strictEqual((await client()('GET', `/api/join/${code}`)).status, 404);
  // Opening a move counts as activity.
  const o2 = client();
  const s2 = await share(o2, 1);
  const quiet = new Date(Date.now() - 80 * 86400000).toISOString();
  await store.transactKeys('moves', s2.sid, () => ({ set: { updatedAt: quiet, activeAt: quiet }, del: [] }));
  assert.strictEqual((await o2('GET', `/api/m/${s2.sid}`)).status, 200);
  const doc = await store.get('moves', s2.sid);
  assert.ok(Date.now() - Date.parse(doc.activeAt) < 60000 && doc.updatedAt === quiet, 'opening it moved activeAt, not the version');
});

test('limits: 30 distinct wrong codes, then even the right one waits (a dead id polled counts once); 30 new helpers an hour per address; 50 helpers a move; 500 boxes; 50 a batch; long fields cut', async () => {
  const owner = client();
  const { sid, code } = await share(owner, 2);
  const guesser = client();
  for (let i = 0; i < 40; i++) await guesser('GET', `/api/m/${sid.slice(0, 15)}Z`);
  assert.strictEqual((await guesser('GET', `/api/join/${code}`)).status, 200, 'one dead id polled forty times is one miss');
  const codes = [];
  while (codes.length < 29) { const c = K.newCode(); if (c !== code && !codes.includes(c)) codes.push(c); }
  for (const c of codes) assert.strictEqual((await guesser('GET', `/api/join/${c}`)).status, 404);
  const locked = await guesser('GET', `/api/join/${code}`);
  assert.deepStrictEqual([locked.status, /Too many wrong codes/.test(locked.data.error)], [429, true], 'then even the right code waits');
  const ip = '198.51.100.7';
  for (let i = 0; i < 30; i++) assert.strictEqual((await client(ip)('POST', `/api/join/${code}`, { name: `Pal ${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcd'[i]}` })).status, 200);
  assert.strictEqual((await client(ip)('POST', `/api/join/${code}`, { name: 'One more' })).status, 429);
  for (let i = 0; i < 20; i++) assert.strictEqual((await client()('POST', `/api/join/${code}`, { name: `Late ${'ABCDEFGHIJKLMNOPQRST'[i]}` })).status, 200);
  const full = await client()('POST', `/api/join/${code}`, { name: 'Fifty one' });
  assert.deepStrictEqual([full.status, /50 helpers/.test(full.data.error)], [409, true]);
  assert.strictEqual((await client()('GET', `/api/join/${code}`)).data.full, true);
  // Boxes.
  const o2 = client();
  const s2 = await share(o2, 0);
  const rooms = (await view(o2, s2.sid)).rooms;
  assert.strictEqual((await o2('POST', `/api/m/${s2.sid}/boxes`, { boxes: Array.from({ length: 51 }, (_, i) => ({ no: i + 1, room: rooms[0].id })) })).status, 400);
  for (let k = 0; k < 10; k++) {
    const r = await o2('POST', `/api/m/${s2.sid}/boxes`, { boxes: Array.from({ length: 50 }, (_, i) => ({ no: k * 50 + i + 1, room: rooms[i % rooms.length].id, items: [`Thing ${i}`] })) });
    assert.deepStrictEqual([r.status, r.data.added], [200, 50]);
  }
  const over = await o2('POST', `/api/m/${s2.sid}/box`, { room: rooms[0].id });
  assert.deepStrictEqual([over.status, /500 boxes/.test(over.data.error)], [409, true]);
  const dup = await o2('POST', `/api/m/${s2.sid}/boxes`, { boxes: [{ no: 3, room: rooms[0].id }] });
  assert.deepStrictEqual([dup.data.added, dup.data.skipped], [0, 1]);
  const o3 = client();
  const s3 = await share(o3, 0);
  const long = await o3('POST', `/api/m/${s3.sid}/box`, { room: rooms[0].id, items: ['x'.repeat(500)], note: 'n'.repeat(2000), flags: ['fragile', 'nope'] });
  assert.deepStrictEqual([long.data.box.items[0].length, long.data.box.note.length, long.data.box.flags], [60, 300, ['fragile']]);
});

test('hostile input end to end: markup, bidi and zero-width characters in names, rooms, contents and notes are stripped before they are stored', async () => {
  const owner = client();
  const r = await owner('POST', '/api/moves', { name: '<img src=x onerror=alert(1)>Move\u202e', kind: 'move', to: '<b>4</b> Harbour\u200b Row', rooms: [{ id: 'rxxxxx01', name: '<script>alert(1)</script>Kitchen', color: 'red' }], you: { name: '<i>Robin</i>' } });
  assert.strictEqual(r.status, 200, r.text);
  const sid = r.data.id;
  await owner('POST', `/api/m/${sid}/box`, { room: 'rxxxxx01', items: ['<img src=x onerror=alert(1)>Kettle\u202e', 'javascript:alert(1)'], note: '<a href="javascript:alert(1)">x</a>\u2066' });
  const helper = client();
  await helper('POST', `/api/join/${r.data.move.code}`, { name: '\u202eroon<svg onload=alert(1)>' });
  const v = (await owner('GET', `/api/m/${sid}`)).text;
  assert.ok(!/<[a-z/!]|\u202e|\u200b|\u2066/i.test(v), v.slice(0, 300));
  assert.ok(!/<[a-z/!]|\u202e|\u200b/i.test(store._dump()), 'only the cleaned copy is stored');
});

test('photos never reach the server: a share, a batch, a box or an edit that carries one is refused whole and nothing is stored', async () => {
  const owner = client();
  const tiny = jpeg(40, 40).toString('base64');
  const refused = await owner('POST', '/api/moves', { name: 'x', kind: 'move', rooms: C.sampleMove(O).rooms, photo: `data:image/jpeg;base64,${tiny}` });
  assert.deepStrictEqual([refused.status, refused.data.code], [400, 'photo']);
  const { sid, m } = await share(owner, 1);
  for (const [mt, p, body] of [
    ['POST', '/boxes', { boxes: [{ ...C.shareBox(m.boxes[5]), photo: true }] }],
    ['POST', '/boxes', { boxes: [{ ...C.shareBox(m.boxes[6]), items: [`data:image/jpeg;base64,${tiny}`] }] }],
    ['POST', '/box', { room: m.rooms[0].id, thumb: tiny }],
    ['POST', '/box', { room: m.rooms[0].id, note: jpeg(60, 60, 600).toString('base64') }],
    ['PATCH', `/box/${m.boxes[0].id}`, { items: ['Kettle'], image: { type: 'image/jpeg', data: tiny } }],
    ['PATCH', '', { rooms: m.rooms, picture: 'x' }],
  ]) {
    const r = await owner(mt, `/api/m/${sid}${p}`, body);
    assert.deepStrictEqual([r.status, r.data.code], [400, 'photo'], `${mt} ${p}`);
  }
  const dump = store._dump();
  assert.ok(!dump.includes('data:image') && !dump.includes(tiny.slice(0, 40)) && !/"photo"/.test(dump), 'no photo, no photo flag');
});

test('the photo reader over HTTP: anything but one photo is a 400 with no model call; the model sees the photo without its location and nothing about the person; the answer is checked; nothing is stored', async () => {
  const eva = await register('eva.reader');
  const calls = await modelCalls();
  const okImg = photoBody().image;
  const pngAsJpeg = { type: 'image/jpeg', data: png(200, 200).toString('base64') };
  for (const bad of [{}, [], { image: okImg, rooms: ['Kitchen'] }, { image: okImg, move: 'Larkfield' }, { image: { type: 'image/gif', data: 'R0lGODlhAQABAAAAACw=' } }, { image: pngAsJpeg }, { image: { type: 'image/jpeg', data: jpeg(2400, 1800).toString('base64') } }, { image: { type: 'image/jpeg', data: jpeg(1000, 1000, 1020000).toString('base64') } }, { image: { ...okImg, extra: 1 } }, { image: { type: 'image/jpeg', data: Buffer.from('not a picture at all').toString('base64') } }]) {
    assert.strictEqual((await eva('POST', '/api/ai/contents', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await eva('POST', '/api/ai/contents', photoBody());
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeClient.calls[n0];
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'record_contents' });
  const content = req.messages[0].content;
  assert.deepStrictEqual(content.map((b) => b.type), ['image', 'text']);
  const sent = Buffer.from(content[0].source.data, 'base64');
  assert.ok(!sent.includes(Buffer.from('GPSLatitude')) && !sent.includes(Buffer.from('Marrow')), 'the model\u2019s copy has no location or comment in it');
  assert.strictEqual(content[1].text, ai.TEXT, 'the only words: the instruction');
  const pr = r.data.proposal;
  assert.deepStrictEqual(Object.keys(pr).sort(), ['confidence', 'flags', 'items', 'note', 'room', 'roomConfidence']);
  assert.deepStrictEqual([pr.items.length, pr.items.includes('Mug'), pr.room, pr.flags], [7, false, 'kitchen', [{ id: 'fragile', confidence: 'medium' }]], '"Mug" folded into "Mugs"');
  assert.ok(!store._dump().includes('Wooden spoons'), 'nothing stored');
  const png1 = await eva('POST', '/api/ai/contents', { image: { type: 'image/png', data: png(800, 1200).toString('base64') } });
  assert.strictEqual(png1.status, 200);
  assert.ok(!Buffer.from(fakeClient.calls[fakeClient.calls.length - 1].messages[0].content[0].source.data, 'base64').includes(Buffer.from('home address')), 'PNG text dropped too');
  fakeClient.mode = 'inject';
  const inj = await eva('POST', '/api/ai/contents', photoBody());
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]|\u202e|javascript:|https?:|www\.|evil\.example|valuables|Robin/i.test(inj.text), inj.text.slice(0, 300));
  const ip = inj.data.proposal;
  assert.ok(ip.items.length <= 40 && ip.room === 'unsure' && ip.confidence === 'low' && !('extra' in ip));
  fakeClient.mode = 'unsure';
  assert.strictEqual((await eva('POST', '/api/ai/contents', photoBody())).data.proposal.room, 'unsure');
  fakeClient.mode = 'blank';
  assert.strictEqual((await eva('POST', '/api/ai/contents', photoBody())).status, 422);
  fakeClient.mode = 'maxtokens';
  assert.match((await eva('POST', '/api/ai/contents', photoBody())).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await eva('POST', '/api/ai/contents', photoBody());
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await eva('POST', '/api/ai/contents', photoBody());
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call; sharing stays free', async () => {
  const una = await register('una.unconfirmed');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await una('POST', '/api/ai/contents', photoBody());
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/whichbox/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await una('POST', '/api/ai/contents', BIG)).status, 403, '403 before the big body is read');
    await share(una, 2);
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/contents', photoBody())).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/contents', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-whichbox-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/contents', photoBody());
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/contents', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-whichbox-${day}`); }
});

test('nothing identifying in the shared store: no email, no account id, no browser key, no photo - only first names, rooms and box text', async () => {
  const signed = await register('sam.owner');
  await share(signed, 4);
  const dump = store._dump();
  assert.ok(!dump.includes(mail('sam.owner')) && !dump.includes(uidOf(mail('sam.owner'))) && !dump.includes('sam.owner'));
  assert.ok(!dump.includes(signed.cookies.whichbox_k));
  assert.ok(!/@|data:image/.test(dump));
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/whichbox', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/whichbox`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
