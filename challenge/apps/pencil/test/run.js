// Pure rules first (text and hostile input, codes, every scoring engine
// against hand-worked cases, winners and ties, undo and redo, late players,
// the history and its stats, the CSV and JSON, the one door every game
// comes through, a shared table's view, the recap card's text fitting, the
// sheet reader's request and answer, the made-up game night), then the
// page's own promises, then end to end against the memory store and the
// fake model:
//   PENCIL_MEMORY=1 PENCIL_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /pencil, the way
// the lab mounts it, so the key cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every person, game and table here is made up.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.PENCIL_MEMORY !== '1' || process.env.PENCIL_FAKE_AI !== '1') {
  console.error('run with PENCIL_MEMORY=1 PENCIL_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient } = require('../server');
const C = require('../public/pencil-core');
const QR = require('../public/qr');
const K = require('../lib/tables');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NOW = Date.parse('2026-11-10T20:00:00Z');
// Fixed dice: the same ids on every run.
const dice = () => { let x = 2463534242; return (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; }; };
const rand = dice();
const O = { now: NOW, rand };

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

let pseq = 0;
const person = (name, emoji) => ({ id: `ptest${String(pseq++).padStart(3, '0')}`, name, emoji: emoji || C.EMOJI[pseq % C.EMOJI.length] });
const ANN = person('Ann'), BO = person('Bo'), CY = person('Cy'), DEE = person('Dee'), EVE = person('Eve');
/** A game started the way the page starts one. */
const game = (id, players, settings, extra) => C.newGame(Object.assign({ game: id, players: players || [ANN, BO, CY], settings }, extra || {}), O);
/** A change the way the page makes one: through change(), undo-able. */
const step = (g, fn) => C.change(g, fn, O).game;
const sids = (g) => g.sides.map((s) => s.id);
function anyRounds(g, rows) { for (const row of rows) { const r = g.data.rounds.length; g = step(g, (x) => row.forEach((v, i) => { if (v !== null) C.setCell(x, r, x.sides[i].id, v); })); } return g; }
function heartsHands(g, rows) { for (const row of rows) g = step(g, (x) => { if (typeof row === 'string') return C.addHand(x, { moon: x.sides[Number(row.slice(4))].id }); const s = {}; row.forEach((v, i) => { s[x.sides[i].id] = v; }); return C.addHand(x, { s }); }); return g; }
const totalsOf = (g) => sids(g).map((id) => C.totals(g)[id]);

/* ================================================================== *
 * Text and codes
 * ================================================================== */

test('text: one plain line, invisible and bidi characters removed, markup stripped, cut on a whole character; names are letters; escaping covers quotes', () => {
  assert.strictEqual(C.line('  a\n\tb\u202ec\u200bd  ', 60), 'a bcd');
  assert.strictEqual(C.line('\u{1F3B2}'.repeat(70), 60), '\u{1F3B2}'.repeat(60));
  assert.strictEqual(C.plain('<img src=x onerror=alert(1)>Spades <b>night</b>', 60), 'Spades night');
  assert.strictEqual(C.plain('x'.repeat(100000), 30).length, 30);
  for (const v of [{}, [], { toString: () => 'boom' }, () => 1, null, undefined]) assert.strictEqual(C.plain(v, 20), '', String(v));
  assert.strictEqual(C.esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  assert.strictEqual(C.plainOut('Visit https://evil.example/x or www.evil.example and evil.example now', 200), 'Visit or and now');
  assert.strictEqual(C.cleanName('  <b>Noor</b>\u202e  '), 'Noor');
  assert.strictEqual(C.cleanName('Ezra 3000 <script>'), 'Ezra', 'markup and digits go');
  assert.strictEqual(C.cleanName('12345'), '', 'a name needs a letter');
  assert.strictEqual(C.cleanName('Jean-Luc O’Neill'), 'Jean-Luc O’Neill');
  assert.strictEqual(C.cleanName('Zoë'), 'Zoë');
  assert.strictEqual(C.cleanName('A'.repeat(300)).length, C.LIMITS.name);
  assert.strictEqual(C.cleanNote('<i>misdeal</i>\u2066 '.repeat(40)).length <= C.LIMITS.note, true);
  assert.strictEqual(C.possessive('Marcus'), 'Marcus’s');
});

test('codes: six characters from an alphabet with no I, O, 0 or 1; typed however; the server draws only from it; a key is unlinkable across tables', () => {
  assert.ok(!/[IO01]/.test(C.CODE_ALPHABET) && C.CODE_ALPHABET.length === 32);
  assert.strictEqual(C.normalizeCode(' abc-234 '), 'ABC234');
  assert.ok(C.isCode('ABC234') && !C.isCode('ABC23O') && !C.isCode('ABC2345'));
  assert.strictEqual(C.formatCode('abc234'), 'ABC-234');
  for (let i = 0; i < 200; i++) assert.ok(C.isCode(K.newCode()));
  assert.ok(C.isTid(K.newTableId()) && /^[A-Za-z0-9_-]{22}$/.test(K.newKey()));
  assert.notStrictEqual(K.keyHash('k'.repeat(22), 'a'.repeat(16)), K.keyHash('k'.repeat(22), 'b'.repeat(16)));
  assert.deepStrictEqual(C.parseHash('#join=abc-234'), { view: 'join', code: 'ABC234' });
  assert.deepStrictEqual(C.parseHash('#g/gabcdefghij'), { view: 'game', id: 'gabcdefghij' });
  assert.deepStrictEqual(C.parseHash('#new/hearts'), { view: 'setup', game: 'hearts' });
  for (const h of ['#g/<img>', '#new/yahtzee', '#javascript:alert(1)', '#__proto__', '#join=<x>', '#g/' + 'a'.repeat(40)]) assert.strictEqual(C.parseHash(h).view, '', h);
  assert.strictEqual(C.joinUrl('https://x.test', '/pencil/', 'abc-234'), 'https://x.test/pencil/#join=ABC234');
  assert.ok(QR.matrix(C.joinUrl('https://challenge.strongtechnicalconsulting.com', '/pencil/', 'ABC234')).length <= 37, 'the join QR stays small enough to scan across a table');
});

/* ================================================================== *
 * The engines
 * ================================================================== */

test('any game: high or low, to a target, after N rounds or open; negative scores; teams with the other team filled with 0; the dealer moves round', () => {
  // Rummy: highest, first to 500, decided at the end of a round.
  let g = game('rummy');
  g = anyRounds(g, [[120, 45, -30], [200, 160, 90], [190, 300, 150]]);
  assert.deepStrictEqual(totalsOf(g), [510, 505, 210]);
  assert.strictEqual(C.result(g).line, 'Ann wins with 510.');
  assert.strictEqual(g.status, 'done');
  // Reaching the target mid-round does not end it: the round is finished first.
  let h = anyRounds(game('rummy'), [[520, null, null]]);
  assert.strictEqual(C.result(h).over, false, 'the round is not complete yet');
  // Card golf: lowest after nine.
  let cg = game('cardgolf');
  cg = anyRounds(cg, Array.from({ length: 9 }, (_, i) => [i, 5, -2]));
  assert.deepStrictEqual(totalsOf(cg), [36, 45, -18]);
  assert.strictEqual(C.result(cg).line, 'Cy wins with -18.');
  assert.ok(C.result(anyRounds(game('cardgolf'), [[1, 2, 3]])).over === false);
  // Open: only "finish now" ends it, and a tie is said plainly.
  let w = anyRounds(game('word'), [[12, 30, 12], [30, 12, 30]]);
  assert.strictEqual(C.result(w).over, false);
  w = step(w, (x) => C.endNow(x));
  assert.deepStrictEqual([C.result(w).tie, C.result(w).line], [true, 'Bo and Cy tie for the win on 42.'].map((v, i) => (i ? 'Ann, Bo and Cy tie for the win on 42.' : v)));
  // Euchre: two teams, partners opposite, the other team gets 0, to 10.
  let e = C.newGame({ game: 'euchre', players: [ANN, BO, CY, DEE] }, O);
  assert.deepStrictEqual(e.sides.map((s) => s.name), ['Ann and Cy', 'Bo and Dee']);
  assert.deepStrictEqual(C.seatsOf(e).map((s) => s.person.name), ['Ann', 'Bo', 'Cy', 'Dee']);
  e = step(e, (x) => C.setCell(x, 0, x.sides[1].id, 2));
  assert.deepStrictEqual(e.data.rounds[0].s, { [e.sides[1].id]: 2, [e.sides[0].id]: 0 }, 'only one team scores a hand');
  for (const [i, v] of [[0, 4], [0, 1], [1, 1], [0, 4]]) { const r = e.data.rounds.length; e = step(e, (x) => C.setCell(x, r, x.sides[i].id, v)); }
  assert.deepStrictEqual(totalsOf(e), [9, 3]);
  assert.ok(!C.result(e).over);
  e = step(e, (x) => C.setCell(x, x.data.rounds.length, x.sides[0].id, 1));
  assert.strictEqual(C.result(e).line, 'Ann and Cy win with 10.');
  assert.deepStrictEqual([0, 1, 2, 3, 4].map((r) => C.dealerFor(e, r).person.name), ['Ann', 'Bo', 'Cy', 'Dee', 'Ann']);
  // Bounds and refusals.
  assert.throws(() => C.setCell(game('any'), 0, 'snope00', 5), (x) => x.status === 400);
  assert.throws(() => C.setCell(game('any'), 3, game('any').sides[0].id, 5), (x) => x.status === 400, 'no skipping rounds');
  assert.throws(() => C.setCell(game('any'), 0, game('any').sides[0].id, 100000), (x) => x.status === 400);
  assert.throws(() => C.setCell(game('any'), 0, game('any').sides[0].id, 1.5), (x) => x.status === 400);
  const one = game('any', [ANN], { end: 'rounds', rounds: 1 });
  assert.strictEqual(C.result(anyRounds(one, [[-7]])).line, 'Finished on -7.', 'solo: a score, not a win');
  assert.throws(() => game('rummy', [ANN]), (x) => x.status === 400 && /at least 2 players/.test(x.message));
  assert.throws(() => game('hearts', [ANN, BO, CY, DEE, EVE, person('Fay'), person('Gus')]), (x) => /at most 6/.test(x.message));
});

test('five dice: every box from the dice, the impossible refused, the 63 bonus, how far from it, the extra five of a kind with its joker, a finished sheet', () => {
  const S = (dice2, box, b) => C.diceScore(box, dice2, { b: b || {}, x: 0 });
  const d = [3, 3, 3, 5, 5];
  assert.deepStrictEqual(C.BOX_IDS.map((b) => S(d, b)), [0, 0, 9, 0, 10, 0, 19, 0, 25, 0, 0, 0, 19]);
  assert.deepStrictEqual(['three', 'four', 'chance'].map((b) => S([4, 4, 4, 4, 2], b)), [18, 18, 18]);
  assert.deepStrictEqual(['small', 'large'].map((b) => S([1, 2, 3, 4, 6], b)), [30, 0]);
  assert.deepStrictEqual(['small', 'large'].map((b) => S([6, 2, 3, 4, 5], b)), [30, 40]);
  assert.deepStrictEqual(['small', 'large'].map((b) => S([1, 2, 2, 4, 5], b)), [0, 0]);
  assert.deepStrictEqual(['five', 'four', 'three', 'sixes', 'full'].map((b) => S([6, 6, 6, 6, 6], b)), [50, 30, 30, 30, 0]);
  assert.deepStrictEqual(['full', 'small', 'large'].map((b) => S([2, 2, 2, 2, 2], b, { five: 50 })), [25, 30, 40], 'a joker');
  assert.strictEqual(S([1, 2, 3], 'chance'), null);
  // What a box can hold.
  assert.deepStrictEqual([0, 2, 4, 6, 8, 10].map((n) => C.dicePossible('twos', n)), [true, true, true, true, true, true]);
  assert.deepStrictEqual([1, 3, 12, -2].map((n) => C.dicePossible('twos', n)), [false, false, false, false]);
  assert.deepStrictEqual([0, 4, 5, 30, 31].map((n) => C.dicePossible('three', n)), [true, false, true, true, false]);
  assert.deepStrictEqual([0, 25, 24].map((n) => C.dicePossible('full', n)), [true, true, false]);
  assert.deepStrictEqual([0, 4, 5].map((n) => C.dicePossible('chance', n)), [false, false, true]);
  assert.strictEqual(C.possibleLine('twos'), 'Twos can only be 0, 2, 4, 6, 8 or 10.');
  let g = game('dice', [ANN, BO]);
  const [a, b] = sids(g);
  assert.throws(() => C.diceSet(C.clone(g), a, 'twos', 7), (x) => x.status === 400 && /0, 2, 4/.test(x.message), 'the sheet refuses an impossible score');
  // Exactly 63 earns the bonus; how far is said along the way.
  g = step(g, (x) => { C.diceSet(x, a, 'ones', 3); C.diceSet(x, a, 'twos', 6); C.diceSet(x, a, 'threes', 9); });
  assert.strictEqual(C.diceSums(g.data.sheets[a]).bonusLine, '45 to go for +35 · on pace');
  g = step(g, (x) => { C.diceSet(x, a, 'fours', 12); C.diceSet(x, a, 'fives', 15); });
  assert.strictEqual(C.diceSums(g.data.sheets[a]).toBonus, 18);
  g = step(g, (x) => C.diceSet(x, a, 'sixes', 18));
  assert.deepStrictEqual([C.diceSums(g.data.sheets[a]).upper, C.diceSums(g.data.sheets[a]).bonus], [63, 35]);
  g = step(g, (x) => { C.diceSet(x, b, 'ones', 0); C.diceSet(x, b, 'twos', 2); C.diceSet(x, b, 'threes', 3); });
  assert.strictEqual(C.diceSums(g.data.sheets[b]).bonusLine, '58 to go for +35 \u00B7 13 behind pace');
  g = step(g, (x) => C.diceSet(x, b, 'fours', 0));
  assert.strictEqual(C.diceSums(g.data.sheets[b]).bonusLine, 'No bonus this game', 'even five fives and five sixes would not reach 63 now');
  assert.throws(() => C.diceSet(C.clone(g), a, 'ones', 2), (x) => x.status === 409, 'a filled box is not refilled');
  // Five of a kind, then another: the extra 100 and a joker full house.
  g = step(g, (x) => C.diceSet(x, a, 'five', null, [4, 4, 4, 4, 4]));
  const r1 = C.change(g, (x) => C.diceSet(x, a, 'full', null, [5, 5, 5, 5, 5]), O);
  g = r1.game;
  assert.deepStrictEqual([r1.out.score, r1.out.bonus, g.data.sheets[a].x], [25, true, 1]);
  assert.throws(() => C.diceExtra(C.clone(g), b), (x) => /50 in Five of a kind/.test(x.message));
  const off = step(game('dice', [ANN], { extra: false }), (x) => C.diceSet(x, x.sides[0].id, 'five', 50));
  assert.throws(() => C.diceExtra(C.clone(off), off.sides[0].id), (x) => /switched off/.test(x.message));
  // Fill the rest; the game ends when every sheet is full.
  g = step(g, (x) => { for (const k of ['three', 'four', 'small', 'large', 'chance']) C.diceSet(x, a, k, k === 'small' ? 30 : k === 'large' ? 0 : 20); });
  assert.strictEqual(C.diceSums(g.data.sheets[a]).total, 63 + 35 + 50 + 25 + 20 + 20 + 30 + 0 + 20 + 100);
  assert.ok(!C.result(g).over);
  g = step(g, (x) => { for (const k of ['fives', 'sixes', 'three', 'four', 'full', 'small', 'large', 'five', 'chance']) C.diceSet(x, b, k, k === 'chance' ? 5 : 0); });
  assert.strictEqual(C.result(g).line, 'Ann wins with 363.');
});

test('bowling: a perfect 300, all spares with a tenth-frame strike, a gutter game, the Dutch 200, a worked game of 167, the tenth frame’s balls, and a keypad that never offers more pins than are standing', () => {
  const T = (r) => C.bowlFrames(r).total;
  assert.deepStrictEqual([T(Array(12).fill(10)), C.bowlFrames(Array(12).fill(10)).complete], [300, true]);
  const spares = []; for (let i = 0; i < 9; i++) spares.push(5, 5); spares.push(5, 5, 10);
  assert.deepStrictEqual([T(spares), C.bowlFrames(spares).frames[9].marks], [155, ['5', '/', 'X']]);
  assert.deepStrictEqual([T(Array(20).fill(0)), C.bowlFrames(Array(20).fill(0)).complete, C.bowlFrames(Array(20).fill(0)).frames[0].marks], [0, true, ['-', '-']]);
  const dutch = [10, 5, 5, 10, 5, 5, 10, 5, 5, 10, 5, 5, 10, 5, 5, 10];
  assert.deepStrictEqual(C.bowlFrames(dutch).frames.map((f) => f.score), [20, 40, 60, 80, 100, 120, 140, 160, 180, 200], 'strike, spare, strike, spare: 20 a frame');
  const worked = [10, 7, 3, 9, 0, 10, 0, 8, 8, 2, 0, 6, 10, 10, 10, 8, 1];
  assert.deepStrictEqual(C.bowlFrames(worked).frames.map((f) => f.score), [20, 39, 48, 66, 74, 84, 90, 120, 148, 167]);
  assert.deepStrictEqual(C.bowlFrames(worked).frames.map((f) => f.marks.join('')), ['X', '7/', '9-', 'X', '-8', '8/', '-6', 'X', 'X', 'X81']);
  // Bonuses wait for their balls.
  assert.deepStrictEqual(C.bowlFrames([10, 3]).frames.map((f) => f.score), [null, null]);
  assert.deepStrictEqual(C.bowlFrames([5, 5]).frames[0].score, null);
  // The tenth: open is two balls, a spare earns one more, a strike two.
  const nine = Array(18).fill(1);
  assert.strictEqual(C.bowlNext(nine.concat([3, 4])), null);
  assert.deepStrictEqual(C.bowlNext(nine.concat([3, 7])), { frame: 10, ball: 3, max: 10, strike: true, spare: false });
  assert.deepStrictEqual(C.bowlNext(nine.concat([10])), { frame: 10, ball: 2, max: 10, strike: true, spare: false });
  assert.deepStrictEqual(C.bowlNext(nine.concat([10, 6])), { frame: 10, ball: 3, max: 4, strike: false, spare: true });
  assert.deepStrictEqual(C.bowlFrames(nine.concat([10, 0, 10])).frames[9].marks, ['X', '-', '/']);
  assert.deepStrictEqual(C.bowlFrames(nine.concat([0, 10, 10])).frames[9].marks, ['-', '/', 'X']);
  // Every reachable state: the keypad offers 0..standing, and one more is refused.
  const seen = new Set();
  const walk = (rolls) => {
    const nx = C.bowlNext(rolls);
    if (!nx) return;
    const key = rolls.length + ':' + nx.frame + ':' + nx.ball + ':' + nx.max;
    if (seen.has(key)) return; seen.add(key);
    const f = C.bowlFrames(rolls).frames[nx.frame - 1];
    const before = f ? f.rolls : [];
    let standing = 10;
    if (nx.ball === 2 && (nx.frame < 10 || before[0] !== 10)) standing = 10 - before[0];
    if (nx.frame === 10 && nx.ball === 3) standing = before[1] === 10 || before[0] + before[1] === 10 && before[0] !== 10 ? 10 : before[0] === 10 ? 10 - before[1] : 0;
    assert.strictEqual(nx.max, standing, JSON.stringify(rolls));
    assert.throws(() => C.bowlAdd(rolls, nx.max + 1), (x) => x.status === 400);
    for (const p of [0, nx.max, Math.floor(nx.max / 2)]) walk(C.bowlAdd(rolls, p));
  };
  walk([]);
  assert.ok(seen.size > 50);
  assert.throws(() => C.bowlAdd(Array(12).fill(10), 0), (x) => x.status === 409);
  assert.strictEqual(C.bowlMax([10, 10, 10, 9, 1, 8, 1, 10]), 256, '"can still reach" assumes strikes from here');
  assert.strictEqual(C.strikeRun(worked), 3, 'the last three frames');
});

test('darts 501/301: bust below zero, on 1, and on zero without a double; the checkout question; three darts can’t make 179; every checkout from 2 to 170 adds up and ends on a double; the impossible ones are none', () => {
  const imp = []; for (let n = 0; n <= 180; n++) if (!C.dartsPossible(n)) imp.push(n);
  assert.deepStrictEqual(imp, [163, 166, 169, 172, 173, 175, 176, 178, 179]);
  assert.deepStrictEqual(C.dartsCheck(40, 45, true), { bust: true, why: 'Bust - that goes below zero.' });
  assert.deepStrictEqual(C.dartsCheck(33, 32, true), { bust: true, why: 'Bust - 1 can’t be finished on a double.' });
  assert.deepStrictEqual(C.dartsCheck(33, 32, false), { ok: true }, 'without double-out, 1 is fine');
  assert.deepStrictEqual(C.dartsCheck(32, 32, true), { ask: true });
  assert.deepStrictEqual(C.dartsCheck(32, 32, true, true), { finish: true });
  assert.deepStrictEqual(C.dartsCheck(32, 32, true, false), { bust: true, why: 'Bust - the last dart has to be a double.' });
  assert.deepStrictEqual(C.dartsCheck(30, 30, false), { finish: true });
  assert.match(C.dartsCheck(168, 168, true).error, /168 can\u2019t be checked out with a double/);
  assert.match(C.dartsCheck(169, 169, true).error, /Three darts can\u2019t make 169/);
  assert.match(C.dartsCheck(400, 179, true).error, /can’t make 179/);
  assert.match(C.dartsCheck(400, 181, true).error, /0 to 180/);
  const none = [];
  for (let n = 2; n <= 170; n++) {
    const c = C.checkout(n, true);
    if (!c) { none.push(n); continue; }
    assert.ok(c.length >= 1 && c.length <= 3, n);
    assert.strictEqual(c.reduce((s, d) => s + C.dartValue(d).v, 0), n, `${n}: ${c.join(' ')}`);
    assert.ok(C.dartValue(c[c.length - 1]).dbl, `${n} ends on ${c[c.length - 1]}`);
  }
  assert.deepStrictEqual(none, [159, 162, 163, 165, 166, 168, 169]);
  assert.strictEqual(C.checkout(1, true), null);
  assert.strictEqual(C.checkout(171, true), null);
  assert.deepStrictEqual([170, 160, 100, 50, 40, 2, 3].map((n) => C.checkout(n, true).join(' ')), ['T20 T20 Bull', 'T20 T20 D20', 'T20 D20', 'Bull', 'D20', 'D1', '1 D1']);
  assert.deepStrictEqual(C.checkout(180, false), ['T20', 'T20', 'T20']);
  for (let n = 1; n <= 180; n++) { const c = C.checkout(n, false); if (C.dartsPossible(n) && n) assert.ok(c && c.reduce((s, d) => s + C.dartValue(d).v, 0) === n, n); }
  // A leg, start to finish.
  let g = game('darts', [ANN, BO], { start: 301 });
  const [a, b] = sids(g);
  for (const [who, s] of [[a, 140], [b, 60], [a, 100], [b, 180]]) g = step(g, (x) => C.dartsTurn(x, who, s));
  assert.deepStrictEqual(totalsOf(g), [61, 61]);
  g = step(g, (x) => C.dartsTurn(x, a, 60));
  assert.strictEqual(g.data.turns[a][2].b, true, 'bust on 1');
  assert.strictEqual(C.dartsLeft(g, a), 61, 'a bust scores nothing');
  const ask = C.change(g, (x) => C.dartsTurn(x, b, 61), O);
  assert.deepStrictEqual([ask.out, ask.game], [{ ask: true }, g], 'zero asks, and nothing is written until it is answered');
  g = step(g, (x) => C.dartsTurn(x, b, 61, true));
  assert.deepStrictEqual([C.result(g).line, C.dartsAverage(g, a), C.dartsAverage(g, b)], ['Bo checks out 61 to win.', 80, 100.3]);
  assert.throws(() => C.dartsTurn(C.clone(g), a, 20), (x) => x.status === 409);
  assert.deepStrictEqual(C.highlights(g), ['Bo hit 180', 'Bo checked out 61']);
});

test('hearts: each hand checked against 26, the moon in one tap both ways, the end at 100, lowest wins, a tie at the bottom keeps playing (or is shared), passing by hand', () => {
  let g = game('hearts', [ANN, BO, CY, DEE]);
  const h = C.heartsHand(g, { s: Object.fromEntries(sids(g).map((id, i) => [id, [5, 8, 10, 2][i]])) });
  assert.deepStrictEqual([h.sum, h.ok, C.heartsCheckLine(h.sum)], [25, false, 'These add up to 25, not 26. Saved anyway - check for a misdeal.']);
  assert.throws(() => C.heartsHand(g, { s: { [sids(g)[0]]: 27 } }), (x) => x.status === 400);
  g = heartsHands(g, [[3, 13, 6, 4], 'moon0']);
  assert.deepStrictEqual(totalsOf(g), [3, 39, 32, 30], 'the shooter 0, everyone else +26');
  const sub = heartsHands(game('hearts', [ANN, BO, CY, DEE], { moon: 'subtract' }), [[3, 13, 6, 4], 'moon0']);
  assert.deepStrictEqual(totalsOf(sub), [-23, 13, 6, 4], 'or the shooter -26');
  assert.deepStrictEqual([0, 1, 2, 3, 4].map((r) => C.passFor(g, r)), ['Pass left', 'Pass right', 'Pass across', 'Keep your cards', 'Pass left']);
  assert.deepStrictEqual([0, 1, 2, 3].map((r) => C.passFor(game('hearts'), r)), ['Pass left', 'Pass right', 'Keep your cards', 'Pass left']);
  g = heartsHands(g, [[0, 26, 0, 0], [0, 26, 0, 0]]);
  assert.deepStrictEqual(totalsOf(g), [3, 91, 32, 30]);
  assert.ok(!C.result(g).over);
  g = heartsHands(g, [[1, 13, 6, 6]]);
  assert.deepStrictEqual([C.result(g).over, C.result(g).line, C.moonsOf(g, sids(g)[0])], [true, 'Ann wins with 4.', 1]);
  // A tie at the bottom.
  let t = heartsHands(game('hearts', [ANN, BO, CY]), [[13, 13, 0], [13, 13, 0], [0, 0, 26], [26, 0, 0], [0, 26, 0], [0, 26, 0], [0, 13, 13], [13, 0, 13], [0, 0, 26]]);
  assert.deepStrictEqual(totalsOf(t), [65, 91, 78]);
  t = heartsHands(t, [[13, 0, 13]]);
  assert.deepStrictEqual(totalsOf(t), [78, 91, 91]);
  t = heartsHands(t, [[13, 13, 0]]);
  assert.deepStrictEqual(totalsOf(t), [91, 104, 91]);
  let r = C.result(t);
  assert.deepStrictEqual([r.over, r.wait], [false, 'Ann and Cy are tied at the bottom on 91 - keep playing until it breaks.']);
  t = heartsHands(t, [[0, 13, 13]]);
  assert.deepStrictEqual([C.result(t).over, C.result(t).line], [true, 'Ann wins with 91.']);
  const share = heartsHands(game('hearts', [ANN, BO, CY], { tie: 'share' }), [[0, 13, 13], [0, 13, 13], [26, 0, 0], [13, 0, 13], [26, 13, 0], [26, 0, 13], [0, 26, 0], [0, 26, 0]]);
  r = C.result(share);
  assert.deepStrictEqual(totalsOf(share), [91, 91, 52].map((v, i) => [91, 91, 52][i]));
  assert.deepStrictEqual([r.over, r.tie, r.line], [false, false, 'Cy leads with 52.']);
  const sh2 = heartsHands(share, [[13, 0, 13]]);
  assert.deepStrictEqual(totalsOf(sh2), [104, 91, 65]);
  assert.strictEqual(C.result(sh2).line, 'Cy wins with 65.');
  const tieShare = heartsHands(game('hearts', [ANN, BO, CY], { tie: 'share' }), [[26, 0, 0], [26, 0, 0], [26, 0, 0], [26, 0, 0]]);
  assert.deepStrictEqual([C.result(tieShare).tie, C.result(tieShare).line], [true, 'Bo and Cy tie for the win on 0.']);
  // Editing a past hand re-checks it.
  const ed = step(g, (x) => C.editHand(x, 0, { s: Object.fromEntries(sids(x).map((id, i) => [id, [26, 0, 0, 0][i]])) }));
  assert.strictEqual(totalsOf(ed)[0], 27);
});

test('cribbage: hands counted in order - pegging, the hands from the dealer’s left, then the crib - so the first to 121 wins on the spot; no five cards make 19, 25, 26 or 27; skunks called', () => {
  let g = game('cribbage', [ANN, BO]);
  const [a, b] = sids(g);
  for (const n of [19, 25, 26, 27, 30, -1]) assert.throws(() => C.cribHand(g, { peg: {}, hand: { [a]: n }, crib: 0 }), (x) => x.status === 400, n);
  assert.throws(() => C.cribHand(g, { peg: { [a]: 62 }, hand: {}, crib: 0 }), (x) => x.status === 400);
  assert.match((() => { try { C.cribHand(g, { peg: {}, hand: {}, crib: 19 }); return ''; } catch (e) { return e.message; } })(), /19 can’t be counted from five cards - check the crib/);
  g = step(g, (x) => C.addCribHand(x, { peg: { [a]: 2, [b]: 4 }, hand: { [a]: 8, [b]: 6 }, crib: 4 }));
  assert.deepStrictEqual(totalsOf(g), [14, 10], 'Ann dealt first: the crib is Ann’s');
  g = step(g, (x) => C.addCribHand(x, { peg: { [a]: 3, [b]: 1 }, hand: { [a]: 12, [b]: 8 }, crib: 2 }));
  assert.deepStrictEqual(totalsOf(g), [29, 21], 'then Bo deals and the crib is Bo’s');
  // The non-dealer counts first: 115 + 6 reaches 121 before the dealer's 118 + 8.
  const close = C.clone(g); close.data.hands = []; close.sides[0].start = 115; close.sides[1].start = 118; close.dealer = 1;
  const fin = step(close, (x) => C.addCribHand(x, { peg: {}, hand: { [a]: 6, [b]: 8 }, crib: 12 }));
  assert.deepStrictEqual([C.result(fin).line, C.cribBoard(fin).at.step], ['Ann wins with 121.', 'hand']);
  assert.strictEqual(C.cribBoard(fin).totals[b], 118, 'what came after never happened');
  // Pegging comes before every hand.
  const peg = C.clone(close); peg.dealer = 0;
  const pfin = step(peg, (x) => C.addCribHand(x, { peg: { [b]: 3 }, hand: { [a]: 29 }, crib: 0 }));
  assert.strictEqual(C.result(pfin).line, 'Bo wins with 121.');
  // Skunks.
  const sk = C.clone(close); sk.sides[0].start = 115; sk.sides[1].start = 85;
  assert.strictEqual(C.result(step(sk, (x) => C.addCribHand(x, { peg: {}, hand: { [a]: 6 }, crib: 0 }))).extra, 'Bo is skunked.');
  sk.sides[1].start = 60;
  const dbl = step(sk, (x) => C.addCribHand(x, { peg: {}, hand: { [a]: 6 }, crib: 0 }));
  assert.deepStrictEqual([C.result(dbl).extra, C.highlights(dbl)[0]], ['Bo is double skunked.', 'Ann double skunked Bo']);
  sk.sides[1].start = 91;
  assert.strictEqual(C.result(step(sk, (x) => C.addCribHand(x, { peg: {}, hand: { [a]: 6 }, crib: 0 }))).extra, '', '91 is safe');
  // Teams: four players, two teams, the crib to the dealer's team.
  const t = C.newGame({ game: 'cribbage', players: [ANN, BO, CY, DEE], settings: { teams: true } }, O);
  assert.deepStrictEqual([t.sides.length, t.sides[0].name, C.dealerFor(t, 1).person.name], [2, 'Ann and Cy', 'Bo']);
  assert.throws(() => C.addSide(C.clone(g), EVE, O), (x) => x.status === 409);
});

test('mini golf: 9 or 18 holes, par and strokes against it, a stroke limit per hole, lowest wins, a hole in one is a moment', () => {
  let g = game('golf', [ANN, BO]);
  assert.strictEqual(g.data.holes.length, 9);
  assert.strictEqual(game('golf', [ANN], { holes: 18 }).data.holes.length, 18);
  const [a, b] = sids(g);
  assert.throws(() => C.setStroke(C.clone(g), 0, a, 7), (x) => /1 to 6 strokes/.test(x.message), 'the most is 6 by default');
  assert.throws(() => C.setStroke(C.clone(g), 0, a, 0), (x) => x.status === 400);
  assert.throws(() => C.setStroke(C.clone(g), 9, a, 2), (x) => x.status === 400);
  const pars = [2, 3, 2, 4, 3, 2, 3, 3, 2];
  g = step(g, (x) => pars.forEach((p, i) => C.setPar(x, i, p)));
  const as = [2, 3, 1, 4, 3, 3, 3, 3, 2], bs = [3, 3, 2, 6, 4, 2, 3, 4, 2];
  g = step(g, (x) => as.forEach((v, i) => { C.setStroke(x, i, a, v); }));
  assert.ok(!C.result(g).over);
  g = step(g, (x) => bs.forEach((v, i) => { C.setStroke(x, i, b, v); }));
  assert.deepStrictEqual(totalsOf(g), [24, 29]);
  assert.deepStrictEqual([C.parLine(C.toPar(g, a)), C.parLine(C.toPar(g, b))], ['E', '+5']);
  assert.deepStrictEqual([C.result(g).line, C.highlights(g)[0]], ['Ann wins with 24 (E).', 'Ann got a hole in one on hole 3']);
  assert.strictEqual(C.parLine(-2), '−2');
  assert.strictEqual(game('golf', [ANN], { max: 8 }).settings.max, 8);
});

test('undo and redo: every change is one step; redo is cleared by a new change; a finish can be undone and the game plays on', () => {
  let g = game('rummy');
  g = anyRounds(g, [[200, 100, 50], [200, 100, 50]]);
  assert.strictEqual(g.past.length, 2);
  g = anyRounds(g, [[150, 0, 0]]);
  assert.strictEqual(g.status, 'done');
  g = C.undo(g, O);
  assert.deepStrictEqual([g.status, g.finishedAt, totalsOf(g), C.canRedo(g)], ['playing', '', [400, 200, 100], true]);
  g = C.redo(g, O);
  assert.deepStrictEqual([g.status, totalsOf(g)], ['done', [550, 200, 100]]);
  g = C.undo(C.undo(g, O), O);
  g = anyRounds(g, [[1, 1, 1]]);
  assert.deepStrictEqual([C.canRedo(g), totalsOf(g)], [false, [201, 101, 51]], 'a new change clears redo');
  const same = C.change(g, () => {}, O);
  assert.strictEqual(same.game, g, 'nothing changed: no undo step');
  let long = game('word');
  for (let i = 0; i < C.LIMITS.undo + 10; i++) long = anyRounds(long, [[1, 1, 1]]);
  assert.strictEqual(long.past.length, C.LIMITS.undo);
  assert.strictEqual(C.undo(game('word'), O).past.length, 0);
});

test('the table: a late player catches up at last place’s score (or zero) and sits out what was played; rename, reorder, take out, the next dealer', () => {
  let g = anyRounds(game('rummy'), [[50, 20, 80], [30, 40, 10]]);
  const L = person('Lu');
  g = step(g, (x) => C.addSide(x, L, O));
  const lu = g.sides[3];
  assert.deepStrictEqual([lu.start, lu.from, C.totals(g)[lu.id]], [60, 2, 60], 'Bo is last on 60');
  assert.throws(() => C.setCell(C.clone(g), 0, lu.id, 5), (x) => /joined after that round/.test(x.message));
  g = anyRounds(g, [[10, 10, 10, 10]]);
  assert.ok(C.roundDone(g, g.data.rounds, 2) && C.roundDone(g, g.data.rounds, 0), 'earlier rounds are complete without them');
  const z = step(anyRounds(game('rummy', null, { late: 'zero' }), [[50, 20, 80]]), (x) => C.addSide(x, person('Mo'), O));
  assert.strictEqual(z.sides[3].start, 0);
  const hz = step(heartsHands(game('hearts', [ANN, BO, CY]), [[10, 6, 10]]), (x) => C.addSide(x, person('Ny'), O));
  assert.strictEqual(hz.sides[3].start, 10, 'in a low game, last place is the highest score');
  assert.throws(() => C.addSide(C.clone(g), { id: 'pxxxxxx1', name: 'ann', emoji: C.EMOJI[0] }, O), (x) => /already playing/.test(x.message));
  const dg = step(step(game('dice', [ANN, BO]), (x) => C.diceSet(x, x.sides[0].id, 'ones', 3)), (x) => C.addSide(x, person('Oz'), O));
  assert.deepStrictEqual(dg.data.sheets[dg.sides[2].id], { b: {}, x: 0 }, 'a fresh sheet');
  g = step(g, (x) => C.renameSide(x, lu.id, '<b>Lulu</b>'));
  assert.strictEqual(C.sideOf(g, lu.id).name, 'Lulu');
  assert.throws(() => C.renameSide(C.clone(g), lu.id, 'Ann'), (x) => x.status === 409);
  g = step(g, (x) => C.moveSide(x, lu.id, -1));
  assert.deepStrictEqual(g.sides.map((s) => s.name), ['Ann', 'Bo', 'Lulu', 'Cy']);
  assert.throws(() => C.dropSide(C.clone(g), g.sides[0].id), (x) => /already has scores/.test(x.message));
  const fresh = game('rummy', [ANN, BO, CY]);
  assert.strictEqual(step(fresh, (x) => C.dropSide(x, x.sides[2].id)).sides.length, 2);
  const d = step(anyRounds(game('rummy'), [[1, 1, 1]]), (x) => C.setDealer(x, 2));
  assert.strictEqual(C.dealerFor(d, 1).person.name, 'Cy', 'the next round is dealt by the chosen seat');
  assert.strictEqual(C.dealerFor(d, 0).person.name, 'Bo', '...and the deal before moves with it');
  assert.ok(C.usesDealer(game('hearts')) && !C.usesDealer(game('word')) && C.usesDealer(game('cribbage', [ANN, BO])));
  const noted = step(g, (x) => C.setNote(x, 0, '<i>Misdeal</i>'));
  assert.strictEqual(noted.data.rounds[0].note, 'Misdeal');
});

/* ================================================================== *
 * History, stats, files
 * ================================================================== */

/** A finished game's summary, built through real games. */
function finishedRummy(at, rows, players) {
  let g = game('rummy', players);
  g = anyRounds(g, rows);
  g.finishedAt = new Date(at).toISOString();
  return C.summarize(g);
}
test('history: wins, win rate, the current streak, ties, records and who holds them, "Next to beat", head to head, a group’s own table; a game with one player counts for records only', () => {
  const h = [];
  const day = (n) => NOW - n * 86400000;
  h.push(finishedRummy(day(9), [[500, 100, 50]]));
  h.push(finishedRummy(day(8), [[100, 500, 50]]));
  h.push(finishedRummy(day(7), [[100, 500, 50]]));
  h.push(finishedRummy(day(6), [[100, 500, 600]]));
  h.push(finishedRummy(day(5), [[100, 600, 50]]));
  h.push(finishedRummy(day(4), [[100, 600, 50]]));
  let bowl = game('bowling', [ANN, BO]);
  bowl = step(bowl, (x) => { x.data.rolls[x.sides[0].id] = [10, 7, 3, 9, 0, 10, 0, 8, 8, 2, 0, 6, 10, 10, 10, 8, 1]; x.data.rolls[x.sides[1].id] = Array(12).fill(10); });
  bowl.finishedAt = new Date(day(3)).toISOString();
  h.push(C.summarize(bowl));
  let solo = game('bowling', [CY]);
  solo = step(solo, (x) => { x.data.rolls[x.sides[0].id] = Array(20).fill(4); });
  solo.finishedAt = new Date(day(2)).toISOString();
  h.push(C.summarize(solo));
  const tie = finishedRummy(day(1), [[600, 600, 0]]);
  h.push(tie);
  const s = C.stats(h, {});
  const rummy = s.byGame.find((x) => x.key === 'rummy');
  assert.deepStrictEqual(rummy.rows.map((r) => [r.name, r.wins, r.played, r.rate, r.streak, r.ties]), [['Bo', 4, 7, 57, 0, 1], ['Ann', 1, 7, 14, 0, 1], ['Cy', 1, 7, 14, 0, 0]], 'a tie breaks a streak and is not a win');
  const s6 = C.stats(h.slice(0, 6), {});
  assert.strictEqual(s6.byGame.find((x) => x.key === 'rummy').rows[0].streak, 2, 'Bo’s current run');
  const bw = s.byGame.find((x) => x.key === 'bowling');
  assert.deepStrictEqual([bw.played, bw.record.value, bw.record.name, bw.next], [2, 300, 'Bo', 'Next to beat: Bo’s 300 in Bowling']);
  assert.ok(!bw.rows.some((r) => r.name === 'Cy'), 'a game alone is not a win or a loss');
  assert.deepStrictEqual(s.overall.map((r) => r.name).slice(0, 1), ['Bo']);
  const hh = C.headToHead(h, ANN.id, BO.id);
  assert.deepStrictEqual([hh.games, hh.a, hh.b, hh.ties], [8, 1, 6, 1]);
  assert.strictEqual(C.h2hLine(hh, 'Ann', 'Bo'), 'Ann 1 – 6 Bo (1 tie)');
  assert.strictEqual(C.h2hLine(C.headToHead(h, ANN.id, 'pnobody1'), 'Ann', 'Zed'), 'Ann and Zed haven’t played each other yet.');
  // Groups.
  const gh = h.map((x, i) => Object.assign({}, x, { group: i % 2 ? 'rgroupaa1' : '' }));
  assert.strictEqual(C.stats(gh, { group: 'rgroupaa1' }).games, 4);
  // Records for the other games, built through their engines.
  const d = game('darts', [ANN, BO]);
  let dd = step(d, (x) => { const [a, b] = sids(x); C.dartsTurn(x, a, 180); C.dartsTurn(x, b, 100); C.dartsTurn(x, a, 180); C.dartsTurn(x, b, 100); C.dartsTurn(x, a, 141, true); });
  assert.deepStrictEqual([C.summarize(dd).sides[0].rec, C.summarize(dd).key], [141, 'darts501']);
  const st = C.stats([C.summarize(dd)], {});
  assert.strictEqual(st.byGame[0].next, 'Next to beat: Ann’s 141 checkout');
});

test('CSV: out and back in is the same history; a formula is defused on the way out and restored on the way in; odd files refuse kindly. JSON merges by id, matching people by name', () => {
  let g = C.newGame({ game: 'any', players: [ANN, BO], name: '=SUM(A1)+cmd|calc', settings: { end: 'rounds', rounds: 1 } }, O);
  g = anyRounds(g, [[-12, 40]]);
  const t = C.newGame({ game: 'euchre', players: [ANN, BO, CY, DEE] }, O);
  let e = anyRounds(t, [[10, 0]]);
  const hist = [C.summarize(g), C.summarize(e)];
  const csv = C.historyCsv(hist);
  assert.ok(csv.startsWith('game_id,date,game,key,kind,player,emoji,side,total,place,won,tie,record,highlight\r\n'));
  assert.ok(csv.includes(",'=SUM(A1)+cmd|calc,") && csv.includes(",'-12,"), 'a leading = + - @ never reaches a spreadsheet as a formula');
  assert.strictEqual(C.historyFromCsv(csv).history.find((x) => x.key !== 'euchre').name, '=SUM(A1)+cmd|calc', 'our own defusing is undone on the way back');
  const back = C.historyFromCsv(csv);
  assert.strictEqual(back.error, '');
  const byId = (x, y) => (x.id < y.id ? -1 : 1);
  assert.deepStrictEqual(back.history.slice().sort(byId).map((x) => [x.id, x.name, x.key, x.sides.map((s) => [s.name, s.total, s.place, s.won, s.people.map((p) => p.name)])]), hist.slice().sort(byId).map((x) => [x.id, x.name, x.key, x.sides.map((s) => [s.name, s.total, s.place, s.won, s.people.map((p) => p.name)])]), 'teams, totals, places and names survive');
  const merged = C.mergeImport({ people: [{ id: ANN.id, name: 'Ann', emoji: ANN.emoji }], groups: [], history: [] }, back, O);
  assert.deepStrictEqual([merged.added, merged.skipped, merged.people.length], [2, 0, 4], 'Ann matched by name; Bo, Cy and Dee added');
  assert.ok(merged.history.every((h) => h.sides.every((s) => s.people.every((p) => C.isId(p.id)))));
  assert.strictEqual(C.mergeImport(merged, back, O).added, 0, 'importing twice adds nothing');
  assert.strictEqual(C.historyFromCsv('').error, 'That file is empty.');
  assert.match(C.historyFromCsv('a,b\n1,2').error, /no game_id, player and total columns/);
  assert.match(C.historyFromCsv('game_id,player,total\nnope,x,1').error, /No games could be read/);
  const json = JSON.parse(C.exportJson({ people: merged.people, groups: [{ id: 'rgroupaa1', name: 'Family', people: [ANN.id] }], history: merged.history }));
  assert.strictEqual(json.app, 'pencil');
  const into = C.mergeImport({ people: [], groups: [], history: [] }, json, O);
  assert.deepStrictEqual([into.added, into.groups.map((x) => x.name), into.groups[0].people.length], [2, ['Family'], 1]);
  const evil = C.mergeImport({ people: [], groups: [], history: [] }, { history: [{ id: 'g<script>', key: 'rummy', kind: 'any', sides: [] }, { id: 'gokokok1', key: 'rummy', kind: 'any', sides: [{ name: '<b></b>', people: [{ name: '123' }] }] }] }, O);
  assert.deepStrictEqual([evil.added, evil.skipped], [0, 2]);
});

test('one door: a game read back from a phone, a file or a server is rebuilt - bounded, unknown fields dropped, scores re-checked by the rules, darts replayed, no prototype pollution; sharing leaves out what only the phone keeps', () => {
  const night = C.sampleNight(O);
  for (const g of night.games) {
    const c = C.cleanGame(JSON.parse(JSON.stringify(g)), O);
    assert.deepStrictEqual([c.status, JSON.stringify(C.totals(c))], [g.status, JSON.stringify(C.totals(g))], g.name);
  }
  const raw = JSON.parse(JSON.stringify(night.games[2]));
  raw.evil = '<script>'; raw.sides[0].evil = 1; raw.sides[0].name = '<img src=x onerror=alert(1)>Noor\u202e';
  raw.data.turns[raw.sides[0].id].push({ s: 179 }, { s: 60 });
  raw.data.turns[raw.sides[1].id][0] = { s: 60, b: true, f: true };
  raw.past = ['{"x":1}', 5, 'nope'];
  const c = C.cleanGame(raw, O);
  assert.ok(!('evil' in c) && !('evil' in c.sides[0]) && c.sides[0].name === 'Noor');
  assert.strictEqual(c.data.turns[c.sides[0].id].length, 4, 'an impossible turn ends the replay');
  assert.deepStrictEqual(c.data.turns[c.sides[1].id][0], { s: 60, b: false, f: false }, 'a claimed bust or finish is the rules’ to say');
  assert.deepStrictEqual(c.past, ['{"x":1}']);
  const bad = JSON.parse(JSON.stringify(night.games[1]));
  bad.data.rolls[bad.sides[0].id] = [10, 10, 7, 5, 3];
  assert.deepStrictEqual(C.cleanGame(bad, O).data.rolls[bad.sides[0].id], [10, 10, 7], '7 then 5 is not a frame');
  const dz = JSON.parse(JSON.stringify(night.games[4]));
  dz.data.sheets[dz.sides[0].id].b.twos = 7; dz.data.sheets[dz.sides[0].id].x = 9;
  const dc = C.cleanGame(dz, O);
  assert.deepStrictEqual([dc.data.sheets[dc.sides[0].id].b.twos, dc.data.sheets[dc.sides[0].id].x, dc.status], [undefined, 0, 'playing']);
  const polluted = JSON.parse('{"id":"gabcdefghij","kind":"any","__proto__":{"polluted":true},"sides":[{"id":"saaaaaa","name":"Ann","people":[{"id":"paaaaaa1","name":"Ann"}]}],"data":{"rounds":[{"s":{"saaaaaa":5,"__proto__":{"x":1}}}]}}');
  const pc = C.cleanGame(polluted, O);
  assert.ok(pc && !({}).polluted && !Object.prototype.polluted && C.totals(pc).saaaaaa === 5);
  for (const v of [null, 'x', [], { id: 'gabcdefghij', kind: 'chess', sides: [] }, { id: 'BAD', kind: 'any' }, { id: 'gabcdefghij', kind: 'any', sides: [] }]) assert.strictEqual(C.cleanGame(v, O), null, JSON.stringify(v));
  const mine = Object.assign(C.clone(night.games[0]), { group: 'rfamily1', shared: { id: 'AbCdEfGh_jKl-nOp', role: 'scorer', code: 'ABC234', v: 3, members: [] }, foreign: true, past: ['{}'] });
  const shared = C.shareGame(mine);
  assert.ok(!('past' in shared) && !('future' in shared) && !('shared' in shared) && !('foreign' in shared) && shared.group === '');
  const kept = C.cleanGame(mine, O);
  assert.deepStrictEqual([kept.shared.code, kept.foreign, kept.group], ['ABC234', true, 'rfamily1']);
  assert.strictEqual(C.overLimits({ sides: Array(13).fill({}) }), '12 players is the most one table takes.');
  assert.strictEqual(C.overLimits({ sides: [], data: { rounds: Array(201).fill({}) } }), '200 rounds is the most one table keeps.');
  assert.strictEqual(C.overLimits({ sides: [], data: { turns: { s1: Array(201).fill({}) } } }), '200 turns is the most one table keeps.');
  assert.strictEqual(C.overLimits(C.shareGame(night.games[0])), '');
  assert.ok(C.cleanPeople([{ id: 'pxxxxxx1', name: 'Ann' }, { id: 'pxxxxxx2', name: 'ANN' }, { id: 'pxxxxxx1', name: 'Bo' }, { id: 'BAD', name: 'Cy' }]).length === 1);
  assert.deepStrictEqual(C.cleanGroups([{ id: 'rgroupaa1', name: '<b>Family</b>', people: ['pxxxxxx1', 'BAD'] }, { id: 'rgroupaa1', name: 'Again' }, { name: '' }]), [{ id: 'rgroupaa1', name: 'Family', people: ['pxxxxxx1'] }]);
});

test('a shared table as members see it: the game, first names and roles - the code for the scorer only, never a key hash', () => {
  const g = C.shareGame(C.sampleNight(O).games[0]);
  const doc = { id: 'AbCdEfGh_jKl-nOp', code: 'ABC234', v: 4, mv: 2, game: g, updatedAt: C.iso(NOW), members: { mscorer1: { name: 'Robin', role: 'scorer', keyHash: 'h1', joinedAt: 'a' }, mwatch01: { name: 'Noor', role: 'watcher', keyHash: 'h2', joinedAt: 'b' } } };
  const s = C.tableView(doc, 'mscorer1'), w = C.tableView(doc, 'mwatch01');
  assert.deepStrictEqual([s.role, s.code, w.role, w.code, s.v, s.mv], ['scorer', 'ABC234', 'watcher', '', 4, 2]);
  assert.deepStrictEqual(w.members.map((m) => [m.name, m.role, m.you]), [['Robin', 'scorer', false], ['Noor', 'watcher', true]]);
  assert.ok(!/keyHash|h1|h2/.test(JSON.stringify([s, w])));
});

/* ================================================================== *
 * The recap card, the sheet reader, the made-up night
 * ================================================================== */

test('the recap card’s words: cut to fit with an ellipsis, wrapped into lines, eight rows then "+N more", the winner and the best moment', () => {
  const m = (s) => s.length * 10;
  assert.strictEqual(C.fitText(m, 'Priya', 100), 'Priya');
  assert.strictEqual(C.fitText(m, 'Bartholomew-Featherstonehaugh', 100), 'Bartholom\u2026');
  assert.ok(m(C.fitText(m, 'x'.repeat(500), 120)) <= 120);
  assert.deepStrictEqual(C.wrapText(m, 'Priya wins with 30 and shot the moon twice', 200, 2), ['Priya wins with 30', 'and shot the moon…']);
  assert.deepStrictEqual(C.wrapText(m, 'Short', 200, 2), ['Short']);
  assert.ok(C.wrapText(m, 'Supercalifragilisticexpialidocious', 100, 2).every((l) => m(l) <= 100));
  const g = C.sampleNight(O).games[4];
  const d = C.recapData(g, 'Tue, Nov 10');
  assert.deepStrictEqual([d.title, d.headline, d.rows.map((r) => [r.place, r.name, r.total, r.win]), d.highlight], ['Five dice', 'Ines wins with 268.', [[1, 'Ines', '268', true], [2, 'Theo', '259', false], [3, 'Kai', '162', false]], 'Theo rolled five of a kind']);
  const big = C.newGame({ game: 'any', players: Array.from({ length: 11 }, (_, i) => person('P' + 'abcdefghijk'[i])) }, O);
  assert.deepStrictEqual([C.recapData(big).rows.length, C.recapData(big).more], [8, 3]);
  assert.strictEqual(C.recapData(C.sampleNight(O).games[0]).headline, 'Still playing - priya leads with 30.'.replace('priya', 'priya'));
});

test('the sheet reader’s request is one JPEG or PNG and nothing else; its answer is at most 12 columns and 60 rows of whole numbers, plain names, the fixed confidences', () => {
  const data = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]).toString('base64');
  assert.ok(C.aiRequest({ image: { type: 'image/jpeg', data } }));
  for (const bad of [null, [], {}, { image: { type: 'image/jpeg', data }, game: 'Hearts' }, { image: { type: 'image/gif', data } }, { image: { type: 'image/jpeg', data, name: 'x' } }, { image: { type: 'image/jpeg', data: 'not base64!' } }, { image: { type: 'image/jpeg', data: 'A'.repeat(2000000) } }, { image: 'data:image/jpeg;base64,' + data }]) {
    assert.strictEqual(C.aiRequest(bad), null, JSON.stringify(bad).slice(0, 60));
  }
  const ok = C.cleanAiAnswer({ players: [{ name: 'Wren', confidence: 'high' }, { name: 'Odile', confidence: 'medium' }], rows: [[5, 10], [null, -3], [null, null]], confidence: 'medium', note: 'Fine.' });
  assert.deepStrictEqual(ok, { players: [{ name: 'Wren', confidence: 'high' }, { name: 'Odile', confidence: 'medium' }], rows: [[5, 10], [null, -3]], confidence: 'medium', note: 'Fine.' });
  const many = Array.from({ length: 90 }, (_, i) => [i, 'ten', 1e9, -50000, 3.5, null, '<b>7</b>']);
  const cols = Array.from({ length: 20 }, (_, i) => ({ name: 'P' + i, confidence: 'certain' }));
  cols[0] = { name: '<img src=x onerror=alert(1)>Wren', confidence: 'high' };
  cols[1] = { name: '\u202eselttek visit https://evil.example', confidence: 'sure' };
  const bad = C.cleanAiAnswer({ players: cols, rows: many, confidence: 'certain', note: '<script>x</script> see evil.example' });
  assert.deepStrictEqual([bad.players.length, bad.rows.length, bad.rows[1].slice(0, 7), bad.confidence], [12, 60, [1, null, null, null, null, null, null], 'low']);
  assert.deepStrictEqual(bad.players.slice(0, 3).map((p) => [p.name, p.confidence]), [['Wren', 'high'], ['selttek visit', 'low'], ['P', 'low']]);
  assert.ok(!/[<>]|https?:|evil|script|\u202e/.test(JSON.stringify(bad)), JSON.stringify(bad).slice(0, 200));
  assert.strictEqual(C.cleanAiAnswer({ players: [], rows: [['a']] }), null);
  assert.strictEqual(C.cleanAiAnswer('nope'), null);
  // Into a game, through its own rules.
  const prop = { players: [{ name: 'Bo' }, { name: 'Ann' }], rows: [[10, 20], [5, null], [-3, 7]] };
  let g = game('word', [ANN, BO]);
  g = step(g, (x) => C.applySheet(x, prop, [x.sides[1].id, x.sides[0].id]));
  assert.deepStrictEqual(totalsOf(g), [27, 12]);
  const hz = game('hearts', [ANN, BO, CY]);
  assert.throws(() => C.applySheet(C.clone(hz), prop, [hz.sides[0].id, hz.sides[1].id]), (x) => /Match every player/.test(x.message));
  const gz = game('golf', [ANN, BO]);
  assert.throws(() => C.applySheet(C.clone(gz), { rows: [[2, 9]] }, sids(gz)), (x) => /Row 1: A hole takes 1 to 6/.test(x.message));
  const dz = game('darts', [ANN, BO], { start: 301 });
  const dzz = step(dz, (x) => C.applySheet(x, { rows: [[140, 100], [100, 100], [61, 50]] }, sids(x)));
  assert.strictEqual(C.result(dzz).line, 'Ann checks out 61 to win.');
  assert.throws(() => C.applySheet(C.clone(game('dice', [ANN])), prop, ['x']), (x) => /Any game, Hearts, Mini golf or Darts/.test(x.message));
});

test('the made-up night: the Larkfield-Osei family mid-way - Hearts where a moon shot ends it, a finished Five dice game, Bowling in frame 7, a Darts checkout, Cribbage on the board - and two months of stories; the same every time; invented names only', () => {
  const n = C.sampleNight(O);
  const [hearts, bowl, darts, crib, dice2] = n.games;
  assert.deepStrictEqual(n.games.map((g) => g.name), ['Hearts', 'Bowling', 'Darts 501', 'Cribbage', 'Five dice']);
  assert.deepStrictEqual(totalsOf(hearts), [30, 80, 64, 60]);
  const moon = step(hearts, (x) => C.addHand(x, { moon: x.sides[0].id }));
  assert.deepStrictEqual([C.result(moon).line, C.highlights(moon)[0]], ['Priya wins with 30.', 'Priya shot the moon twice']);
  assert.strictEqual(dice2.status, 'done');
  assert.deepStrictEqual(C.bowlNext(bowl.data.rolls[bowl.sides[0].id]), { frame: 7, ball: 1, max: 10, strike: true, spare: false });
  assert.strictEqual(C.nextUp(bowl).line, 'Marcus’s turn');
  assert.deepStrictEqual([C.dartsLeft(darts, darts.sides[0].id), C.checkout(121, true).join(' '), C.nextUp(darts).line], [121, 'T20 T7 D20', 'Noor’s turn']);
  assert.deepStrictEqual(totalsOf(crib), [96, 81]);
  assert.ok(n.history.length >= 19 && n.history[0].at < C.iso(NOW - 60 * 86400000));
  const st = C.stats(n.history, {});
  assert.strictEqual(st.byGame.find((x) => x.key === 'bowling').next, 'Next to beat: Marcus’s 287 in Bowling');
  assert.strictEqual(st.byGame.find((x) => x.key === 'hearts').rows[0].streak, 3, 'Priya’s Hearts run');
  assert.deepStrictEqual(C.sampleNight(O), C.sampleNight(O), 'no dice: the same every time');
  assert.deepStrictEqual(n.groups.map((g) => g.name), ['Larkfield-Osei family', 'Thursday crew']);
  assert.deepStrictEqual(n.people.map((p) => p.name), ['Priya', 'Marcus', 'Noor', 'Kai', 'Ines', 'Theo']);
});

/* ================================================================== *
 * The page's own promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the pad, the recap card, the peg board and the lab card too; 44px targets and a bigger keypad; nothing scrolls sideways', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'bar-bg', 'face']) for (const fg of ['text', 'muted', 'link', 'red', 'lead']) ok(fg, bg);
    ok('accent-ink', 'accent'); for (const fg of ['text', 'link', 'muted']) ok(fg, 'accent-soft');
    for (const k of ['ok', 'warn', 'bad', 'info']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); for (const bg of ['card', 'bg']) ok(k, bg); }
    ok('lead', 'lead-bg'); ok('text', 'lead-bg');
    for (const fg of ['hero-ink', 'hero-soft']) for (const bg of ['hero-1', 'hero-2']) ok(fg, bg);
    ok('bg', 'text');
    ok('accent', 'card', 3); ok('accent', 'track', 3);
  }
  // Colours written as literals: the hero and winner buttons, the paper pad, the tab badge, the peg board's labels, every colour on the recap card.
  for (const [fg, bg] of [['#0f5f48', '#ffffff'], ['#0f5f48', '#fffdf6'], ['#a3222f', '#fffdf6'], ['#555049', '#fffdf6'], ['#1b1d1a', '#fffdf6'], ['#6b4a00', '#ffffff'], ['#166534', '#dcfce7'], ['#ffffff', '#a3222f'], ['#f6efe3', '#6b4423'], ['#f6efe3', '#5a3a1c'],
    ['#ffffff', '#0f5f48'], ['#ffffff', '#8f1d2a'], ['#f6efe3', '#0f5f48'], ['#f6efe3', '#8f1d2a'], ['#6b4a00', '#fff3d1'], ['#1b1d1a', '#f4b73a'], ['#1b1d1a', '#e5e7eb'], ['#1b1d1a', '#e0a370'], ['#1b1d1a', '#7fd6b3'], ['#1b1d1a', '#ff9aa5'], ['#1b1d1a', '#a5b4fc']]) {
    assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  }
  const lab = require('../../../lab').get('pencil');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  for (const sel of ['.btn', '.btn.small', '.link-btn', '.seg button, .chip', '.input, select.input, textarea.input', '.check', 'details.more > summary', '.gamepill', '.tb', '.pchip', '.iconbtn', '.moonbtn', '.kp-quick button']) {
    assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*(min-height|height): (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  }
  assert.ok(/\.kp button \{[^}]*min-height: 64px/.test(css) && /\.pins button \{[^}]*min-height: 64px/.test(css) && /\.strokes button \{[^}]*min-height: 72px/.test(css), 'the keypads are bigger still');
  assert.ok(/\.tabbar button \{[^}]*min-height: 60px/.test(css) && /\.cell \{[^}]*min-height: 52px/.test(css) && /\.emogrid button \{[^}]*min-height: 52px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/\.sbox \{[^}]*overflow-x: auto/.test(css) && /\.sgrid \.nm \{[^}]*position: sticky; left: 0/.test(css), 'a wide sheet scrolls in its own box with the names held still');
  assert.ok(/prefers-reduced-motion: reduce[\s\S]*animation: none !important; transition: none !important/.test(css));
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, every received string escaped, only the listed API paths, what the sheet reader and the share sheet say, confetti only with motion, the offline line', () => {
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
  assert.ok(!/sessionStorage|indexedDB|document\.cookie/.test(js));
  assert.ok(/redraw\(img, 1600, 0\.82\)/.test(js), 'the sheet photo is redrawn through a canvas at 1600 px');
  assert.match(js, /<b>What is sent:<\/b> this one photo, shrunk on this phone with its location removed\. Nothing else - not this game, the players’ names or your history\./);
  assert.match(js, /<b>What goes to the table:<\/b> this game - its name, the players’ first names and emoji, and the scores\. Nothing else/);
  assert.match(js, /AI-written - check every number against the paper\. Nothing is added until you tap Add\./);
  assert.match(js, /drawn on this phone, never uploaded, never a link/);
  assert.match(js, /navigator\.share\(\{ files: \[file\]/);
  assert.match(js, /if \(reducedMotion\(\)\) return;/, 'confetti only without reduced motion');
  assert.match(js, /You’re offline - this is the table as of ' \+ esc\(timeOf\(g\.shared\.at \|\| now\(\)\)\) \+ '\. Live updates need the network\./);
  assert.match(js, /setInterval\(poll, 4000\)/);
  assert.match(js, /document\.visibilityState !== 'visible'\) return;/, 'polling only while the page is visible');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|PATCH|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/ai/sheet', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/join/', 'api/me', 'api/t/', 'api/tables'].sort(), 'the page asks for nothing else');
  assert.match(js, /api\('POST', 'api\/ai\/sheet', \{ image: \{ type: 'image\/jpeg', data: b64 \} \}\)/, 'the reader sends the one photo and nothing else');
  assert.match(js, /api\('POST', 'api\/tables', \{ game: C\.shareGame\(live\), you: \{ name: name \} \}\)/);
  assert.match(js, /Intl\.getCanonicalLocales\(navigator\.language \|\| 'en-US'\)\[0\] \|\| 'en-US'; \} catch \(e\) \{ return 'en-US'; \}/, 'a locale Intl refuses ("en-US@posix") falls back');
  for (const f of ['public/index.html', 'public/app.js', 'public/pencil-core.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/store.js', 'lib/tables.js', 'CLAUDE.md']) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  const core = read('public/pencil-core.js');
  assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.|indexedDB|WebSocket|document\./.test(core), 'the core touches no network, storage or page');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  assert.ok(!/\(\?<[=!]/.test(core + js), 'no lookbehind (older iPhones cannot parse it)');
  // Every interpolation of something a person, a file, the server or a model wrote goes through esc().
  const unesc = (src) => { let out = '', i = 0; for (;;) { const at = src.indexOf('esc(', i); if (at < 0) return out + src.slice(i); out += src.slice(i, at) + 'ESC'; let depth = 0, j = at + 3; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; } };
  // Keypad titles and story lines are plain text, escaped where they are drawn (checked below).
  assert.match(js, /'<h2>' \+ esc\(sp\.title\) \+ '<\/h2>'/);
  assert.match(js, /'<p class="story" style="margin:0">' \+ esc\(s\.t\) \+ '<\/p>'/);
  const risky = unesc(js).split('\n').filter((l) => !/toast\(|say\(|confirm\(|prompt\(|promptName\(|copy\(|download\(|textContent|\.value = |shareText\(|fitText\(|wrapText\(|fillText\(|title: |stories\.push\(/.test(l)).join('\n')
    .match(/['"]\s*\+\s*([a-z0-9]+\.name|[a-z0-9]+\.emoji|[a-z0-9]+\.note|[a-z0-9]+\.highlight|[a-z0-9]+\.line|[a-z0-9]+\.wait|[a-z0-9]+\.extra|[a-z0-9]+\.label|[a-z0-9]+\.code|[a-z0-9]+\.by|err\.message|e\.message|me\.email|name|text|label|d\.title|h\.key|C\.gameLine\([^)]*\)|C\.listNames\([^)]*\)|C\.possessive\([^)]*\)|placeLine\([^)]*\)|rulesLine\([^)]*\))\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbody\b|\bimage\b|\bgame\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js') + read('lib/ai.js') + read('lib/tables.js') + read('lib/store.js').replace(/setImmediate/g, '')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /pencil-shell-v1/.test(sw) && sw.includes("'pencil-core.js'") && sw.includes("'qr.js'") && /k\.indexOf\('pencil-'\) === 0/.test(sw), 'the service worker never answers api/ and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
});

test('the copy: neutral wording, no trademarked game names anywhere, no invisible characters in any source file, no key-shaped strings, no real person', () => {
  const strings = (src) => [...src.matchAll(/'([^'\\\n]|\\.){3,}'|`[^`]{3,}`|"[^"\n]{3,}"/g)].map((m) => m[0]).join('\n');
  const all = strings(read('public/app.js')) + strings(read('public/pencil-core.js')) + read('public/index.html') + strings(read('server.js')) + strings(read('lib/ai.js')) + read('CLAUDE.md');
  const gendered = all.match(/\b(he|she|his|hers|him|himself|herself)\b|\bher\b/gi);
  assert.strictEqual(gendered, null, `gendered: ${gendered}`);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  // Built from pieces, so this file does not carry the words it looks for.
  const marks = [['Yaht', 'zee'], ['Scrab', 'ble'], ['U', 'no'], ['Cat', 'an'], ['Monop', 'oly'], ['Phase', ' 10'], ['Skip', '-Bo'], ['Bog', 'gle'], ['Far', 'kle'], ['Rummi', 'kub'], ['Sorr', 'y!'], ['Bananagr', 'ams'], ['Word', 'le'], ['Jen', 'ga'], ['Dut', 'ch Blitz'], ['Pictio', 'nary'], ['Tic', 'ket to Ride']].map((p) => p.join(''));
  const markRe = new RegExp('\\b(' + marks.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b');
  for (const f of walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(src), `${rel} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bsk-ant-[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}/.test(src), `${rel} carries a key-shaped string`);
    if (!/^public\/(qr|passkey-client|verify-banner)\.js$|^lib\/(identity|stripe|byok|webauthn|identity-store)\.js$/.test(rel)) assert.ok(!markRe.test(src), `${rel} names a trademarked game: ${(markRe.exec(src) || [])[0]}`);
  }
  assert.ok(markRe.test('a game of ' + marks[0]) && !markRe.test('Five dice, Word game, Hearts'), 'the check bites');
  const demo = read('public/pencil-core.js') + read('lib/fakeai.js');
  assert.ok(!/\bErik\b/.test(demo), 'no real person in the made-up data');
  for (const n of C.sampleNight(O).people) assert.ok(['Priya', 'Marcus', 'Noor', 'Kai', 'Ines', 'Theo'].includes(n.name));
});

test('local-only switches throw on Cloud Run; the lab prefix is read; every query is one equality filter; one collection', () => {
  for (const [mod, env] of [['./lib/store', { PENCIL_MEMORY: '1' }], ['./lib/fakeai', { PENCIL_FAKE_AI: '1' }], ['./server', { PENCIL_FAKE_AI: '1', PENCIL_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, PENCIL_MEMORY: '', PENCIL_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, PENCIL_MEMORY: '', PENCIL_COLLECTION_PREFIX: 'pencil_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'pencil_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual([...new Set(server.match(/store\.list\([^)]*\)/g))].sort(), [
    "store.list('tables', { where: [['code', '==', c]], limit: 1 })",
    "store.list('tables', { where: [['code', '==', code]], limit: 1 })",
  ], 'single-field equality only: no composite index');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g).map((s) => s.replace(/store\.\w+\(/, '')))], ["'tables'"], 'one collection');
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
const GONE = 'This table isn\u2019t shared here. The scorer may have stopped sharing it, or it closed after a day with no new scores.';
const u16 = (v) => Buffer.from([(v >> 8) & 255, v & 255]);
/** A small JPEG with an EXIF (location) segment and a comment, w x h. */
function jpeg(w, h, pad) {
  const seg = (m, payload) => Buffer.concat([Buffer.from([0xff, m]), u16(payload.length + 2), payload]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude 51.5074 GPSLongitude -0.1278', 'latin1')),
    seg(0xfe, Buffer.from('game night at 22 Marrow Close', 'latin1')),
    seg(0xc0, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0])),
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(pad || 200, 0x55), Buffer.from([0xff, 0xd9]),
  ]);
}
function png(w, h) {
  const chunk = (type, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), d, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0GPS 51.5 home address', 'latin1')), chunk('IDAT', Buffer.alloc(40, 1)), chunk('IEND', Buffer.alloc(0))]);
}
const photoBody = () => ({ image: { type: 'image/jpeg', data: jpeg(1200, 900, 3000).toString('base64') } });
const liveGame = () => C.shareGame(C.sampleNight(O).games[0]);
async function shareTable(scorer, game2) {
  const r = await scorer('POST', '/api/tables', { game: game2 || liveGame(), you: { name: 'Robin' } });
  assert.strictEqual(r.status, 200, r.text);
  return { tid: r.data.id, code: r.data.table.code, table: r.data.table };
}
async function joinAs(c, code, name) {
  const r = await c('POST', `/api/join/${code}`, { name });
  assert.strictEqual(r.status, 200, r.text);
  return r.data;
}
const view = async (c, tid) => (await c('GET', `/api/t/${tid}`)).data.table;

test('signed out: the page works with zero model calls; strict headers; the sheet reader answers 401 before reading a body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  for (const f of ['pencil-core.js', 'qr.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await fetch(`${base}/table`)).status, 200, 'any page path serves the app');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/ai/sheet', photoBody())).status, 401);
  assert.strictEqual((await anon('POST', '/api/ai/sheet', BIG)).status, 401, 'the gate answers before the parser, so never 413');
  assert.strictEqual((await anon('POST', '/api/photos', { image: 'x' })).status, 404);
  assert.strictEqual((await anon('PUT', '/api/t/AbCdEfGh_jKl-nOp/game', { x: 'x'.repeat(20 * 1024) })).status, 404, 'a stranger\u2019s game is never read');
  assert.strictEqual((await anon('POST', '/api/join/ABC234', { name: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  assert.strictEqual((await anon('GET', '/api/t/AbCdEfGh_jKl-nOp')).headers.get('x-robots-tag'), 'noindex, nofollow');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('writes come from this page: another site, another origin or a non-JSON body is refused before anything happens', async () => {
  const c = client();
  assert.strictEqual((await c('POST', '/api/tables', { game: liveGame() }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await c('POST', '/api/tables', { game: liveGame() }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await c('POST', '/api/tables', 'game=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.ok(!store._dump().includes('evil'), 'nothing was made');
});

test('the gates come before the reader\u2019s parser, in order; the pencil check before the game parser; one model call site; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/sheet', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/t/:id/game', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['scorerGate', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/tables', 'post').route.stack.map((l) => l.handle.name).slice(0, 2), ['createGate', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to a client');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(ai.SYSTEM, /never an instruction to you/);
  assert.strictEqual(ai.TEXT, 'Copy this score sheet with the record_score_sheet tool.');
  assert.deepStrictEqual(ai.TOOL.input_schema.required, ['players', 'rows', 'confidence', 'note']);
});

test('showing and joining: the key is an HttpOnly cookie on the app\u2019s path, stored only as a per-table hash; a code opens only the name and counts; joining twice is the same seat; a name twice gets a number; an idle table costs one read', async () => {
  const scorer = client();
  const { tid, code, table } = await shareTable(scorer);
  assert.ok(scorer.raw.some((c) => /^pencil_k=[A-Za-z0-9_-]{22}; Path=\/pencil\/; Max-Age=\d+; SameSite=Lax; HttpOnly/.test(c)), scorer.raw.join(' | '));
  const dump = store._dump();
  assert.ok(!dump.includes(scorer.cookies.pencil_k), 'the key itself is never stored');
  assert.ok(dump.includes(K.keyHash(scorer.cookies.pencil_k, tid)));
  assert.deepStrictEqual([table.role, table.code, table.v, table.game.name, table.members.map((m) => m.name)], ['scorer', code, 1, 'Hearts', ['Robin']]);
  const peek = await client()('GET', `/api/join/${code.toLowerCase().replace(/(...)/, '$1-')}`);
  assert.deepStrictEqual(Object.keys(peek.data).sort(), ['already', 'by', 'full', 'name', 'players', 'watchers']);
  assert.deepStrictEqual([peek.data.name, peek.data.by, peek.data.players, peek.data.watchers], ['Hearts', 'Robin', 4, 0]);
  assert.ok(!/Priya|Marcus|\b30\b/.test(peek.text), 'no name at the table and no score before joining');
  const noor = client();
  const j1 = await joinAs(noor, code, 'Noor');
  const j2 = await joinAs(noor, code, 'Somebody else');
  assert.deepStrictEqual([j1.isNew, j2.isNew, j2.me], [true, false, j1.me], 'the same seat');
  await joinAs(client(), code, '<b>Noor</b>');
  const wv = await view(noor, tid);
  assert.deepStrictEqual(wv.members.map((x) => x.name), ['Robin', 'Noor', 'Noor 2']);
  assert.deepStrictEqual([wv.role, wv.code, wv.game.sides.map((s) => s.name)], ['watcher', '', ['Priya', 'Marcus', 'Noor', 'Kai']], 'watchers see the game, never the code');
  assert.ok(!/keyHash/.test(JSON.stringify(wv)));
  assert.strictEqual((await client()('POST', `/api/join/${code}`, { name: '123' })).status, 400, 'a first name needs a letter');
  const since = await noor('GET', `/api/t/${tid}?since=${wv.v}&m=${wv.mv}`);
  assert.deepStrictEqual(since.data, { same: true, v: wv.v, mv: wv.mv }, 'an idle table costs one read');
});

test('only the scorer writes: watchers are refused before the game is read; a write moves the version and watchers see the score land; a stale version is refused with the table; a watcher joining never makes the scorer stale', async () => {
  const scorer = client();
  let g = C.sampleNight(O).games[0];
  const { tid, code } = await shareTable(scorer, C.shareGame(g));
  const kai = client();
  await joinAs(kai, code, 'Kai');
  const big = { game: Object.assign(C.shareGame(g), { name: 'x'.repeat(200 * 1024) }), v: 1 };
  for (const [mt, p, body] of [['PUT', '/game', { game: C.shareGame(g), v: 1 }], ['PUT', '/game', big], ['POST', '/pencil', { to: 'mxxxxxxx' }], ['DELETE', '']]) {
    const r = await kai(mt, `/api/t/${tid}${p}`, body);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'not-scorer'], `${mt} ${p}: ${r.text.slice(0, 120)}`);
  }
  g = C.change(g, (x) => C.addHand(x, { moon: x.sides[0].id }), O).game;
  const w = await scorer('PUT', `/api/t/${tid}/game`, { game: C.shareGame(g), v: 1 });
  assert.deepStrictEqual([w.status, w.data.v], [200, 2]);
  const seen = await view(kai, tid);
  assert.deepStrictEqual([seen.v, C.result(C.cleanGame(seen.game, O)).line, C.highlights(C.cleanGame(seen.game, O))[0]], [2, 'Priya wins with 30.', 'Priya shot the moon twice'], 'the watcher sees the score land');
  const stale = await scorer('PUT', `/api/t/${tid}/game`, { game: C.shareGame(g), v: 1 });
  assert.deepStrictEqual([stale.status, stale.data.code, stale.data.table.v, stale.data.table.role], [409, 'stale', 2, 'scorer'], 'a stale write is refused with the table as it is');
  await joinAs(client(), code, 'Ines');
  const after = await scorer('PUT', `/api/t/${tid}/game`, { game: C.shareGame(g), v: 2 });
  assert.deepStrictEqual([after.status, after.data.v], [200, 3], 'someone joining moved who is watching, not the game');
  const tooMany = C.shareGame(g); tooMany.data.hands = Array(201).fill(tooMany.data.hands[0]);
  assert.deepStrictEqual([(await scorer('PUT', `/api/t/${tid}/game`, { game: tooMany, v: 3 })).status], [400]);
  const tooWide = C.shareGame(g); tooWide.sides = Array(13).fill(tooWide.sides[0]);
  assert.match((await scorer('PUT', `/api/t/${tid}/game`, { game: tooWide, v: 3 })).data.error, /12 players/);
  assert.strictEqual((await scorer('PUT', `/api/t/${tid}/game`, { game: { id: 'nope' }, v: 3 })).status, 400);
});

test('handing the pencil: the roles swap, the old scorer\u2019s next write is refused and the new scorer\u2019s lands; the scorer removes a watcher (who then gets the stranger\u2019s 404); a watcher leaves; stopping deletes the table', async () => {
  const robin = client();
  const g = C.sampleNight(O).games[2];
  const { tid, code } = await shareTable(robin, C.shareGame(g));
  const noor = client(), kai = client();
  await joinAs(noor, code, 'Noor');
  await joinAs(kai, code, 'Kai');
  const t0 = await view(robin, tid);
  const noorId = t0.members.find((m) => m.name === 'Noor').id;
  const handed = await robin('POST', `/api/t/${tid}/pencil`, { to: noorId });
  assert.deepStrictEqual([handed.status, handed.data.table.role, handed.data.table.code, handed.data.table.members.map((m) => [m.name, m.role])], [200, 'watcher', '', [['Noor', 'scorer'], ['Robin', 'watcher'], ['Kai', 'watcher']]]);
  const nv = await view(noor, tid);
  assert.deepStrictEqual([nv.role, nv.code], ['scorer', code], 'the new scorer sees the code');
  const ng = C.change(C.cleanGame(nv.game, O), (x) => C.dartsTurn(x, x.sides[0].id, 121, true), O).game;
  assert.deepStrictEqual((await robin('PUT', `/api/t/${tid}/game`, { game: C.shareGame(ng), v: nv.v })).data.code, 'not-scorer');
  const ok = await noor('PUT', `/api/t/${tid}/game`, { game: C.shareGame(ng), v: nv.v });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(C.result(C.cleanGame((await view(robin, tid)).game, O)).line, 'Noor checks out 121 to win.');
  assert.strictEqual((await noor('POST', `/api/t/${tid}/pencil`, { to: 'mnobody1' })).status, 404);
  const kaiId = nv.members.find((m) => m.name === 'Kai').id;
  assert.strictEqual((await noor('DELETE', `/api/t/${tid}/members/${kaiId}`)).status, 200);
  const out = await kai('GET', `/api/t/${tid}`);
  assert.deepStrictEqual([out.status, out.data.error], [404, GONE], 'a removed watcher gets the stranger\u2019s 404');
  assert.strictEqual((await noor('DELETE', `/api/t/${tid}/me`)).status, 409, 'whoever holds the pencil hands it on or stops');
  assert.strictEqual((await robin('DELETE', `/api/t/${tid}/me`)).status, 200, 'a watcher can leave');
  assert.strictEqual((await robin('GET', `/api/t/${tid}`)).status, 404);
  assert.strictEqual((await noor('DELETE', `/api/t/${tid}`)).status, 200);
  assert.ok(!store._dump().includes(tid), 'the table is gone');
  assert.strictEqual((await client()('GET', `/api/join/${code}`)).status, 404);
});

test('the same 404, word for word, for an unknown table, a malformed id, one that is not yours, and one with no change for 24 hours - which the read that finds it deletes', async () => {
  const scorer = client();
  const { tid, code } = await shareTable(scorer);
  const stranger = client();
  for (const p of [`/api/t/${tid}`, '/api/t/AbCdEfGh_jKl-nOp', '/api/t/short']) {
    const r = await stranger('GET', p);
    assert.deepStrictEqual([r.status, r.data.error, r.data.code], [404, GONE, 'gone'], p);
  }
  const w = client(); await joinAs(w, code, 'Noor');
  assert.strictEqual((await w('GET', `/api/t/${tid}`)).status, 200);
  const old = new Date(Date.now() - 25 * 3600000).toISOString();
  await store.transactKeys('tables', tid, () => ({ set: { updatedAt: old }, del: [] }));
  const r = await w('GET', `/api/t/${tid}`);
  assert.deepStrictEqual([r.status, r.data.error], [404, GONE]);
  assert.ok(!store._dump().includes(tid), 'deleted on read - no timer');
  assert.strictEqual((await client()('GET', `/api/join/${code}`)).status, 404);
  // A day is counted from the last change, not the last look.
  const s2 = await shareTable(client());
  const quiet = new Date(Date.now() - 23 * 3600000).toISOString();
  await store.transactKeys('tables', s2.tid, () => ({ set: { updatedAt: quiet }, del: [] }));
  const late = client(); await joinAs(late, s2.code, 'Theo');
  assert.ok(Date.now() - Date.parse((await store.get('tables', s2.tid)).updatedAt) < 60000, 'a join is activity');
});

test('limits: 30 distinct wrong codes, then even the right one waits (a dead id polled counts once); 20 watchers a table; 10 new tables an hour from one address; long names cut', async () => {
  const scorer = client();
  const { tid, code } = await shareTable(scorer);
  const guesser = client();
  for (let i = 0; i < 40; i++) await guesser('GET', `/api/t/${tid.slice(0, 15)}Z`);
  assert.strictEqual((await guesser('GET', `/api/join/${code}`)).status, 200, 'one dead id polled forty times is one miss');
  const codes = [];
  while (codes.length < 29) { const c = K.newCode(); if (c !== code && !codes.includes(c)) codes.push(c); }
  for (const c of codes) assert.strictEqual((await guesser('GET', `/api/join/${c}`)).status, 404);
  const locked = await guesser('GET', `/api/join/${code}`);
  assert.deepStrictEqual([locked.status, /Too many wrong codes/.test(locked.data.error)], [429, true], 'then even the right code waits');
  for (let i = 0; i < 20; i++) assert.strictEqual((await client()('POST', `/api/join/${code}`, { name: `Pal ${'ABCDEFGHIJKLMNOPQRST'[i]}` })).status, 200);
  const full = await client()('POST', `/api/join/${code}`, { name: 'One more' });
  assert.deepStrictEqual([full.status, /20 watchers/.test(full.data.error)], [409, true]);
  assert.strictEqual((await client()('GET', `/api/join/${code}`)).data.full, true);
  const ip = '198.51.100.9';
  for (let i = 0; i < 10; i++) assert.strictEqual((await client(ip)('POST', '/api/tables', { game: liveGame(), you: { name: 'Sam' } })).status, 200);
  assert.strictEqual((await client(ip)('POST', '/api/tables', { game: liveGame(), you: { name: 'Sam' } })).status, 429);
  const long = await client()('POST', `/api/join/${(await shareTable(client())).code}`, { name: 'Bartholomew'.repeat(10) });
  assert.strictEqual(long.status, 200);
  assert.ok(!store._dump().includes('Bartholomew'.repeat(3)), 'a name is cut to 20 characters');
});

test('hostile input end to end: markup, bidi and zero-width characters in names and the game are stripped before they are stored', async () => {
  const scorer = client();
  const raw = C.shareGame(C.sampleNight(O).games[0]);
  raw.sides[0].name = '<img src=x onerror=alert(1)>Priya\u202e';
  raw.sides[0].people[0].name = '<script>alert(1)</script>Priya';
  raw.data.hands[0].note = '<a href="javascript:alert(1)">x</a>\u2066';
  raw.sides[1].emoji = '<b>';
  const r = await scorer('POST', '/api/tables', { game: raw, you: { name: '\u202eRobin<svg onload=alert(1)>' } });
  assert.strictEqual(r.status, 200, r.text);
  await joinAs(client(), r.data.table.code, '<i>Noor</i>\u200b');
  const v = (await scorer('GET', `/api/t/${r.data.id}`)).text;
  assert.ok(!/<[a-z/!]|\u202e|\u200b|\u2066|javascript:/i.test(v), v.slice(0, 300));
  assert.ok(!/<[a-z/!]|\u202e|\u200b/i.test(store._dump()), 'only the cleaned copy is stored');
});

test('the sheet reader over HTTP: anything but one photo is a 400 with no model call; the model sees the photo without its location and nothing about the game; the answer is checked; nothing is stored', async () => {
  const eva = await register('eva.reader');
  const calls = await modelCalls();
  const okImg = photoBody().image;
  const pngAsJpeg = { type: 'image/jpeg', data: png(200, 200).toString('base64') };
  for (const bad of [{}, [], { image: okImg, game: 'Hearts' }, { image: okImg, players: ['Priya'] }, { image: { type: 'image/gif', data: 'R0lGODlhAQABAAAAACw=' } }, { image: pngAsJpeg }, { image: { type: 'image/jpeg', data: jpeg(2400, 1800).toString('base64') } }, { image: { type: 'image/jpeg', data: jpeg(1000, 1000, 1060000).toString('base64') } }, { image: { ...okImg, extra: 1 } }, { image: { type: 'image/jpeg', data: Buffer.from('not a picture at all').toString('base64') } }]) {
    assert.strictEqual((await eva('POST', '/api/ai/sheet', bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const n0 = fakeClient.calls.length;
  const r = await eva('POST', '/api/ai/sheet', photoBody());
  assert.strictEqual(r.status, 200, r.text);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeClient.calls[n0];
  assert.strictEqual(req.model, 'claude-haiku-4-5');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'record_score_sheet' });
  const content = req.messages[0].content;
  assert.deepStrictEqual(content.map((b) => b.type), ['image', 'text']);
  const sent = Buffer.from(content[0].source.data, 'base64');
  assert.ok(!sent.includes(Buffer.from('GPSLatitude')) && !sent.includes(Buffer.from('Marrow')), 'the model\u2019s copy has no location or comment in it');
  assert.strictEqual(content[1].text, ai.TEXT, 'the only words: the instruction');
  const pr = r.data.proposal;
  assert.deepStrictEqual([pr.players.map((p) => p.name), pr.rows.length, pr.rows[2]], [['Wren', 'Odile', 'Jules'], 5, [null, 35, 60]]);
  assert.ok(!store._dump().includes('Odile'), 'nothing stored');
  const png1 = await eva('POST', '/api/ai/sheet', { image: { type: 'image/png', data: png(800, 1200).toString('base64') } });
  assert.strictEqual(png1.status, 200);
  assert.ok(!Buffer.from(fakeClient.calls[fakeClient.calls.length - 1].messages[0].content[0].source.data, 'base64').includes(Buffer.from('home address')), 'PNG text dropped too');
  fakeClient.mode = 'inject';
  const inj = await eva('POST', '/api/ai/sheet', photoBody());
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]|\u202e|javascript:|https?:|www\.|evil\.example/i.test(inj.text), inj.text.slice(0, 300));
  assert.ok(inj.data.proposal.players.length === 12 && inj.data.proposal.rows.length === 60 && !('extra' in inj.data.proposal));
  fakeClient.mode = 'blank';
  assert.strictEqual((await eva('POST', '/api/ai/sheet', photoBody())).status, 422);
  fakeClient.mode = 'maxtokens';
  assert.match((await eva('POST', '/api/ai/sheet', photoBody())).data.error, /ran long/);
  fakeClient.mode = 'upstream401';
  const up = await eva('POST', '/api/ai/sheet', photoBody());
  assert.ok(up.status === 502 && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  fakeClient.mode = 'upstream529';
  const busy = await eva('POST', '/api/ai/sheet', photoBody());
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call; showing a table stays free', async () => {
  const una = await register('una.unconfirmed');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await una('POST', '/api/ai/sheet', photoBody());
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/pencil/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await una('POST', '/api/ai/sheet', BIG)).status, 403, '403 before the big body is read');
    await shareTable(una);
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/ai/sheet', photoBody())).status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/sheet', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-pencil-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/sheet', photoBody());
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/sheet', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-pencil-${day}`); }
});

test('nothing identifying in the shared store: no email, no account id, no browser key - only first names, emoji and scores', async () => {
  const signed = await register('sam.scorer');
  await shareTable(signed);
  const dump = store._dump();
  assert.ok(!dump.includes(mail('sam.scorer')) && !dump.includes(uidOf(mail('sam.scorer'))) && !dump.includes('sam.scorer'));
  assert.ok(!dump.includes(signed.cookies.pencil_k));
  assert.ok(!/@|data:image/.test(dump));
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/pencil', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/pencil`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
