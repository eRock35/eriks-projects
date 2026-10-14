// Pure rules first, then end to end against the memory store and the fake
// model:
//   SETTLE_MEMORY=1 SETTLE_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /settle, the way
// the lab mounts it, so the auth cookie, the budget gate, the browser key's
// cookie path, the per-decision rights and the metered route's parser are
// exercised as deployed. Model calls are counted from the identity's usage
// rows - the same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.SETTLE_MEMORY !== '1' || process.env.SETTLE_FAKE_AI !== '1') {
  console.error('run with SETTLE_MEMORY=1 SETTLE_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/settle-core');
const QR = require('../public/qr');
const ai = require('../lib/ai');
const D = require('../lib/decisions');

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

const NOW = Date.parse('2026-10-14T17:00:00Z');
const rand = (n) => require('crypto').randomInt(n);
const vid = (i) => `v${String(i).padStart(8, '0')}`;
/** A decision with these options and voters (v00000000 is the host). */
function world(labels, { voters = 3, mode = 'swipe', vetoes = true, named = true, max = null, deadline = null } = {}) {
  const doc = C.newDecision({ question: 'Where are we eating?', mode, options: labels, vetoes, named, max, deadline, name: 'Host' }, { now: NOW, hostVid: vid(0) });
  doc.id = 'AbCdEfGhIjKlMnOp';
  for (let i = 1; i < voters; i++) C.applyPatch(doc, C.join(doc, { vid: vid(i), name: `Friend${i}` }, NOW + i).patch);
  return doc;
}
const ids = (doc) => doc.opts.map((o) => o.id);
const idOf = (doc, label) => doc.opts.find((o) => o.label === label).id;
/** Everyone's swipes: rows[voter] = {label: vote}. */
function swipes(doc, rows, now = NOW + 100) {
  rows.forEach((row, i) => {
    for (const [label, v] of Object.entries(row)) C.applyPatch(doc, C.swipe(doc, vid(i), idOf(doc, label), v, now).patch);
  });
  return doc;
}
function ranked(doc, rows, now = NOW + 100) {
  rows.forEach((row, i) => C.applyPatch(doc, C.rank(doc, vid(i), row.map((l) => idOf(doc, l)), now).patch));
  return doc;
}
const label = (doc, id) => C.optionOf(doc, id).label;

/* ---------------- cleaning ---------------- */

test('questions, options and names are cleaned through one door', () => {
  assert.strictEqual(C.cleanQuestion('<b>Where</b> are we\u202e eating?\u0007'), 'Where are we eating?');
  assert.strictEqual(C.cleanQuestion('   '), '');
  assert.strictEqual(C.cleanQuestion('?!?!'), '', 'has to say something');
  assert.strictEqual(Array.from(C.cleanQuestion('x'.repeat(5000))).length, C.LIMITS.question);
  assert.strictEqual(C.cleanName({ toString: () => 'Sam' }), '', 'only strings');
  assert.strictEqual(C.cleanName('\u2066Sam\u2069 <script>'), 'Sam');
  assert.deepStrictEqual(C.cleanOption('🍜 Ramen'), { label: 'Ramen', emoji: '🍜', note: '' });
  assert.deepStrictEqual(C.cleanOption({ label: 'Ramen', emoji: '<img>', note: '<b>slurp</b>' }), { label: 'Ramen', emoji: '', note: 'slurp' });
  assert.deepStrictEqual(C.cleanOption('🍕'), { label: '🍕', emoji: '🍕', note: '' }, 'an emoji alone is its own label');
  assert.deepStrictEqual(C.cleanOption('👨‍👩‍👧 Family night'), { label: 'Family night', emoji: '👨‍👩‍👧', note: '' }, 'a ZWJ emoji stays whole');
  assert.deepStrictEqual(C.cleanOption('🇯🇵 Japan'), { label: 'Japan', emoji: '🇯🇵', note: '' }, 'a flag');
  assert.strictEqual(C.cleanOption({ label: 42 }), null);
  assert.strictEqual(C.cleanOption('   '), null);
  assert.strictEqual(C.cleanOption('<img src=x onerror=alert(1)>'), null, 'nothing left of pure markup');
  assert.strictEqual(Array.from(C.cleanOption('y'.repeat(9000)).label).length, C.LIMITS.label);
  assert.strictEqual(C.cleanEmoji('nope'), '');
  assert.strictEqual(C.cleanEmoji('🍕🍕🍕'), '🍕', 'one emoji');
  const big = C.cleanOptions(Array.from({ length: 50 }, (_, i) => `Option ${i}`));
  assert.deepStrictEqual([big.options.length, big.dropped, big.options[29].id], [30, 20, 'ot']);
  const dup = C.cleanOptions(['Thai', 'thai', ' THAI ', 'Thaï', 'Pizza']);
  assert.deepStrictEqual(dup.options.map((o) => o.label), ['Thai', 'Pizza'], 'repeats folded away, accents too');
  assert.deepStrictEqual(C.parseLines('🍜 Ramen\n- Thai\n3. Pizza\n\n• Sushi\r\n* Tacos').options.map((o) => o.emoji + o.label), ['🍜Ramen', 'Thai', 'Pizza', 'Sushi', 'Tacos']);
  assert.deepStrictEqual(C.parseLines('Pizza, Thai,  Ramen').options.map((o) => o.label), ['Pizza', 'Thai', 'Ramen'], 'one line with commas');
  assert.ok(C.parseLines('a\n'.repeat(1e6)).options.length <= 30, 'huge paste is bounded');
  assert.deepStrictEqual([C.cleanMax('4'), C.cleanMax(1), C.cleanMax(51), C.cleanMax(2.5), C.cleanMax(null)], [4, null, null, null, null]);
  assert.strictEqual(C.cleanDeadline(NOW + 3600e3, NOW), NOW + 3600e3);
  assert.strictEqual(C.cleanDeadline(NOW - 1, NOW), null, 'not in the past');
  assert.strictEqual(C.cleanDeadline(NOW + 8 * 86400e3, NOW), null, 'not more than a week away');
  assert.strictEqual(C.cleanDeadline('soon', NOW), null);
  assert.deepStrictEqual([C.cleanMode('rank'), C.cleanMode('chaos')], ['rank', 'swipe']);
  assert.deepStrictEqual([C.cleanVote('love'), C.cleanVote('LOVE'), C.cleanVote('maybe')], ['love', null, null]);
});

test('the decks: eight, 12-30 ideas each, every one clean, an emoji each, no repeats; food decks have vetoes on', () => {
  assert.strictEqual(C.DECKS.length, 8);
  assert.deepStrictEqual(C.DECKS.map((d) => d.id), ['cuisines', 'takeaway', 'date', 'weekend', 'games', 'movies', 'rainy', 'holiday']);
  for (const d of C.DECKS) {
    assert.ok(d.items.length >= 12 && d.items.length <= 30, `${d.id}: ${d.items.length}`);
    assert.strictEqual(C.cleanQuestion(d.question), d.question, d.id);
    assert.ok(d.name && d.emoji && C.cleanEmoji(d.emoji) === d.emoji, d.id);
    const clean = C.cleanOptions(d.items).options;
    assert.strictEqual(clean.length, d.items.length, `${d.id}: no item cleaned away or folded into another`);
    clean.forEach((o, i) => {
      assert.strictEqual(o.label, d.items[i].label, `${d.id}: ${d.items[i].label} survives cleaning`);
      assert.ok(o.emoji && o.emoji === d.items[i].emoji, `${d.id}: ${d.items[i].label} has a clean emoji`);
      assert.ok(o.label.length <= C.LIMITS.label);
    });
    assert.strictEqual(d.vetoes, d.id === 'cuisines' || d.id === 'takeaway', `${d.id}: vetoes on for food only`);
  }
});

/* ---------------- a decision ---------------- */

test('a new decision: a question and two options at least, the host as the first voter', () => {
  assert.throws(() => C.newDecision({ question: '', options: ['a', 'b'] }, { now: NOW, hostVid: vid(0) }), /Ask the group/);
  assert.throws(() => C.newDecision({ question: 'Q?', options: ['a', 'A'] }, { now: NOW, hostVid: vid(0) }), /at least two/);
  const d = C.newDecision({ question: 'Q?', text: 'Pizza\nThai', mode: 'nope', vetoes: 'yes', deadline: NOW + 1000, max: 99 }, { now: NOW, hostVid: vid(0) });
  assert.deepStrictEqual([d.mode, d.vetoes, d.named, d.live, d.deadline, d.max, d.round, d.active], ['swipe', false, false, false, null, null, 1, ['o0', 'o1']], 'only real booleans switch things on; a deadline under a minute away is none');
  assert.deepStrictEqual(d.voters[vid(0)].name, 'Host');
  assert.ok(!('code' in d) && !('hostHash' in d), 'the server adds those');
});

test('swipe: a match is the option everyone said Yes or Love to; the best-loved match wins', () => {
  const d = swipes(world(['Pizza', 'Ramen', 'Tacos', 'Sushi']), [
    { Pizza: 'yes', Ramen: 'yes', Tacos: 'love', Sushi: 'no' },
    { Pizza: 'love', Ramen: 'yes', Tacos: 'yes', Sushi: 'yes' },
    { Pizza: 'no', Ramen: 'yes', Tacos: 'love', Sushi: 'love' },
  ]);
  const r = C.results(d);
  assert.deepStrictEqual(r.matches.map((id) => label(d, id)).sort(), ['Ramen', 'Tacos']);
  assert.strictEqual(label(d, r.winner), 'Tacos', 'two loves beat three yeses among the matches');
  assert.strictEqual(r.how, 'match');
  assert.strictEqual(r.wheel, null);
  const t = r.rows.find((x) => x.label === 'Tacos');
  assert.deepStrictEqual([t.yes, t.love, t.no, t.score, t.place], [1, 2, 0, 5, 1]);
  assert.match(C.headline(d, r).eyebrow, /match/);
  assert.match(C.resultLine(d, r), /^Settled: Tacos for “Where are we eating\?” - it’s a match/);
});

test('swipe: Love counts double in the ranking; no match ranks by score with shared places; a top tie goes to the wheel', () => {
  const d = swipes(world(['A', 'B', 'C', 'D', 'E']), [
    { A: 'love', B: 'yes', C: 'yes', D: 'no', E: 'no' },
    { A: 'love', B: 'yes', C: 'no', D: 'yes', E: 'no' },
    { A: 'no', B: 'yes', C: 'yes', D: 'yes', E: 'no' },
  ]);
  let r = C.results(d);
  assert.deepStrictEqual(r.matches.map((id) => label(d, id)), ['B'], 'B is the only all-yes');
  assert.strictEqual(label(d, r.winner), 'B', 'a match beats a higher score without one');
  // Now someone says no to B: no match; A (2 loves = 4) beats B (2 yes = 2).
  C.applyPatch(d, C.swipe(d, vid(2), idOf(d, 'B'), 'no', NOW + 200).patch);
  r = C.results(d);
  assert.deepStrictEqual([r.how, label(d, r.winner), r.matches.length], ['score', 'A', 0]);
  assert.deepStrictEqual(r.rows.map((x) => `${x.label}${x.score}@${x.place}`), ['A4@1', 'B2@2', 'C2@2', 'D2@2', 'E0@5'], 'ties share a place: 1, 2, 2, 2, 5 (then fewer Nos, then the list’s order)');
  // A top tie: C and A level.
  C.applyPatch(d, C.swipe(d, vid(0), idOf(d, 'C'), 'love', NOW + 300).patch);
  C.applyPatch(d, C.swipe(d, vid(2), idOf(d, 'C'), 'love', NOW + 300).patch);
  r = C.results(d);
  assert.strictEqual(r.how, 'tie');
  assert.deepStrictEqual(r.wheel.ids.map((id) => label(d, id)), ['A', 'C']);
  assert.ok(['A', 'C'].includes(label(d, r.winner)) && r.winner === r.wheel.pick);
  assert.match(C.headline(d, r).eyebrow, /wheel/);
});

test('swipe: someone who stopped halfway has not said yes; nobody voting is no winner', () => {
  const d = world(['A', 'B', 'C']);
  assert.deepStrictEqual([C.results(d).winner, C.results(d).how], [null, 'none']);
  swipes(d, [{ A: 'yes', B: 'yes', C: 'yes' }, { A: 'yes', B: 'yes', C: 'yes' }, { A: 'yes' }]);
  const r = C.results(d);
  assert.deepStrictEqual(r.matches.map((id) => label(d, id)), ['A'], 'the halfway voter blocks B and C');
  assert.strictEqual(r.voters, 3);
  assert.deepStrictEqual([C.isDone(d, vid(1)), C.isDone(d, vid(2)), C.doneCount(d)], [true, false, 2]);
  const allNo = swipes(world(['A', 'B']), [{ A: 'no', B: 'no' }, { A: 'no', B: 'no' }, { A: 'no', B: 'no' }]);
  assert.deepStrictEqual([C.results(allNo).how, C.results(allNo).winner], ['none', null]);
  assert.match(C.headline(allNo, C.results(allNo)).line, /Not one Yes/);
});

test('swipe: only your own ballot, Yes / No / Love, takes back with null, only options in play', () => {
  const d = world(['A', 'B']);
  assert.throws(() => C.swipe(d, vid(1), 'o0', 'maybe', NOW), /Yes, No or Love/);
  assert.throws(() => C.swipe(d, vid(1), 'o9', 'yes', NOW), /isn’t in this round/);
  assert.throws(() => C.swipe(d, 'vnobody00', 'o0', 'yes', NOW), (e) => e.status === 404);
  assert.throws(() => C.rank(d, vid(1), ['o0'], NOW), /swipe/);
  const r = C.swipe(d, vid(1), 'o0', 'love', NOW);
  assert.deepStrictEqual(r.patch, { set: { [`ballots.${vid(1)}.o0`]: 'love' }, del: [] }, 'one key');
  C.applyPatch(d, r.patch);
  C.applyPatch(d, C.swipe(d, vid(1), 'o0', null, NOW).patch);
  assert.deepStrictEqual(d.ballots[vid(1)], {});
});

/* ---------------- ranked choice ---------------- */

test('rank: instant runoff, every round in words, votes moving to the next choice', () => {
  const d = ranked(world(['Thai', 'Pizza', 'Ramen'], { mode: 'rank', voters: 5 }), [['Thai', 'Pizza'], ['Pizza'], ['Pizza', 'Thai'], ['Ramen'], ['Ramen', 'Pizza']]);
  const r = C.results(d);
  assert.deepStrictEqual([r.how, label(d, r.winner), r.rounds.length, r.ballots], ['majority', 'Pizza', 2, 5]);
  assert.strictEqual(r.rounds[0].text, 'Round 1: Pizza (2) · Ramen (2) · Thai (1). Thai had the fewest, so Thai’s vote moved to Pizza.');
  assert.strictEqual(r.rounds[1].text, 'Round 2: Pizza (3) · Ramen (2). Pizza has more than half (3 of 5).');
  assert.deepStrictEqual(r.rounds[0].moved, [{ id: idOf(d, 'Pizza'), n: 1 }]);
  assert.strictEqual(C.headline(d, r).line, 'Won 3 of 5 ballots once the others dropped out.');
  assert.deepStrictEqual(r.rows.map((x) => `${x.label}:${x.firsts}:${x.points}:${x.place}`), ['Pizza:2:10:1', 'Ramen:2:6:2', 'Thai:1:5:3']);
  const s = ranked(world(['Tacos', 'Pizza', 'Ramen'], { mode: 'rank', voters: 5 }), [['Tacos', 'Pizza'], ['Pizza'], ['Pizza'], ['Ramen'], ['Ramen']]);
  assert.match(C.results(s).rounds[0].text, /Tacos’ vote moved to Pizza\./, 'a name ending in s takes an apostrophe');
  const one = ranked(world(['A', 'B'], { mode: 'rank', voters: 3 }), [['A'], ['A', 'B'], ['B']]);
  assert.deepStrictEqual([C.results(one).rounds.length, C.results(one).rounds[0].text], [1, 'Round 1: A (2) · B (1). A has more than half (2 of 3).']);
});

test('rank: a tie for fewest goes out by fewer 2nd and 3rd picks; exhausted ballots stop counting; level at the end spins', () => {
  let d = ranked(world(['A', 'B', 'C', 'D'], { mode: 'rank', voters: 5 }), [['A', 'B'], ['A', 'C'], ['B', 'A'], ['C', 'B'], ['D', 'C']]);
  let r = C.results(d);
  assert.strictEqual(r.rounds[0].text, 'Round 1: A (2) · B (1) · C (1) · D (1). B, C and D tied for fewest and D had fewer 2nd and 3rd picks, so D’s vote moved to C.');
  assert.deepStrictEqual([r.how, label(d, r.winner), r.rounds.length], ['majority', 'A', 3]);
  // Exhausted: B's only ballot has nothing else; A and C end level - the wheel.
  d = ranked(world(['A', 'B', 'C'], { mode: 'rank', voters: 5 }), [['A', 'B'], ['A'], ['B'], ['C'], ['C', 'B']]);
  r = C.results(d);
  assert.strictEqual(r.rounds[0].text, 'Round 1: A (2) · C (2) · B (1). B had the fewest, so it’s out - that ballot had no other picks.');
  assert.deepStrictEqual([r.rounds[0].ranOut, r.rounds[1].exhausted, r.rounds[1].counting], [1, 1, 4]);
  assert.strictEqual(r.rounds[1].text, 'Round 2: A (2) · C (2). A and C are level - the wheel decides.');
  assert.deepStrictEqual([r.how, r.wheel.ids.map((id) => label(d, id))], ['tie', ['A', 'C']]);
  // Majority is over ballots still counting: two exhausted, A wins 2 of 3.
  d = ranked(world(['A', 'B', 'C', 'D'], { mode: 'rank', voters: 5 }), [['A'], ['A'], ['B'], ['C'], ['D']]);
  r = C.results(d);
  assert.deepStrictEqual([r.how, label(d, r.winner), r.rounds.length], ['majority', 'A', 3]);
  assert.match(r.rounds[0].text, /tied for fewest, even counting 2nd and 3rd picks, and the draw picked [BCD], so it’s out/);
  assert.strictEqual(r.rounds[2].text, `Round 3: A (2) · ${label(d, r.rounds[2].counts[1].id)} (1). A has more than half (2 of 3).`);
  assert.strictEqual(JSON.stringify(C.results(d)), JSON.stringify(r), 'the draw is the same every time');
  // Three level in round 1 but split by points: no wheel needed.
  d = ranked(world(['A', 'B', 'C'], { mode: 'rank', voters: 3 }), [['A', 'B'], ['B', 'A'], ['C', 'A']]);
  r = C.results(d);
  assert.deepStrictEqual([r.how, label(d, r.winner)], ['majority', 'A']);
  // A top 3 is 1-3 different options in play.
  const w = world(['A', 'B', 'C', 'D'], { mode: 'rank' });
  assert.throws(() => C.rank(w, vid(1), ['o0', 'o0'], NOW), /once/);
  assert.throws(() => C.rank(w, vid(1), ['o0', 'o1', 'o2', 'o3'], NOW), /top 3/);
  assert.throws(() => C.swipe(w, vid(1), 'o0', 'yes', NOW), /ranked/);
  assert.deepStrictEqual(C.rank(w, vid(1), [], NOW).patch, { set: {}, del: [`ranks.${vid(1)}`] });
});

/* ---------------- vetoes ---------------- */

test('vetoes: one each, out for everyone; first come - a second veto of the same option keeps its voter’s veto', () => {
  const d = world(['Pizza', 'Sushi', 'Thai']);
  const s = idOf(d, 'Sushi');
  const a = C.veto(d, vid(1), s, NOW);
  assert.deepStrictEqual([a.status, a.patch.set], ['vetoed', { [`vetoed.${s}`]: vid(1) }]);
  C.applyPatch(d, a.patch);
  const b = C.veto(d, vid(2), s, NOW);
  assert.deepStrictEqual([b.status, b.patch.set, b.patch.del], ['already', {}, []], 'counts once');
  assert.match(b.msg, /still yours/);
  assert.strictEqual(C.vetoOf(d, vid(2)), null, 'the second voter keeps theirs');
  assert.deepStrictEqual(C.live(d).map((id) => label(d, id)), ['Pizza', 'Thai']);
  assert.throws(() => C.swipe(d, vid(2), s, 'yes', NOW), (e) => e.code === 'vetoed');
  // Moving a veto gives the first back; null takes it back.
  const m = C.veto(d, vid(1), idOf(d, 'Thai'), NOW);
  assert.deepStrictEqual(m.patch.del, [`vetoed.${s}`]);
  C.applyPatch(d, m.patch);
  assert.deepStrictEqual(C.live(d).map((id) => label(d, id)), ['Pizza', 'Sushi']);
  C.applyPatch(d, C.veto(d, vid(1), null, NOW).patch);
  assert.strictEqual(C.live(d).length, 3);
  // The last one standing cannot go.
  C.applyPatch(d, C.veto(d, vid(0), idOf(d, 'Pizza'), NOW).patch);
  C.applyPatch(d, C.veto(d, vid(1), idOf(d, 'Sushi'), NOW).patch);
  assert.throws(() => C.veto(d, vid(2), idOf(d, 'Thai'), NOW), /last one standing/);
  // Results leave vetoed options out, and say they were.
  swipes(d, [{ Thai: 'yes' }, { Thai: 'yes' }, { Thai: 'yes' }]);
  const r = C.results(d);
  assert.deepStrictEqual([label(d, r.winner), r.rows.length, r.vetoed.length], ['Thai', 1, 2]);
  assert.deepStrictEqual([C.isDone(d, vid(1)), C.doneCount(d)], [true, 3], 'a veto can finish someone');
  // Off, or in a second round: no vetoes.
  assert.throws(() => C.veto(world(['A', 'B'], { vetoes: false }), vid(1), 'o0', NOW), /off/);
  const r2 = world(['A', 'B', 'C']); r2.round = 2;
  assert.throws(() => C.veto(r2, vid(1), 'o0', NOW), /second round/);
});

/* ---------------- the wheel ---------------- */

test('the tie-break wheel is deterministic: the same pick on every call and every phone, whatever order it is asked in', () => {
  const a = C.spin('AbCdEfGhIjKlMnOp', 1, ['o1', 'o4', 'o7']);
  for (let i = 0; i < 20; i++) assert.deepStrictEqual(C.spin('AbCdEfGhIjKlMnOp', 1, ['o1', 'o4', 'o7']), a);
  assert.strictEqual(C.spin('AbCdEfGhIjKlMnOp', 1, ['o7', 'o1', 'o4']).pick, a.pick, 'the tied set decides, not its order');
  const picks = new Set();
  for (let i = 0; i < 200; i++) picks.add(C.spin(`id${i}`, 1, ['o1', 'o4', 'o7']).pick);
  assert.strictEqual(picks.size, 3, 'every slice can win');
  const rounds = new Set();
  for (let i = 1; i <= 40; i++) rounds.add(C.spin('AbCdEfGhIjKlMnOp', i, ['o1', 'o4']).pick);
  assert.strictEqual(rounds.size, 2, 'a new round can land differently');
  // Two phones with the same decision draw the same result.
  const mk = () => swipes(world(['A', 'B', 'C']), [{ A: 'yes', B: 'yes', C: 'no' }, { A: 'yes', B: 'yes', C: 'no' }, { A: 'love', B: 'love', C: 'no' }]);
  assert.deepStrictEqual(C.results(mk()).wheel, C.results(mk()).wheel);
  assert.strictEqual(C.results(mk()).how, 'match');
});

/* ---------------- closing ---------------- */

test('closing: the host, the deadline, or everyone expected having voted - worked out on read; nothing changes after', () => {
  const d = world(['A', 'B'], { max: 3, deadline: NOW + 3600e3 });
  assert.deepStrictEqual(C.status(d, NOW), { open: true, why: null, at: null, joined: 3, done: 0, expected: 3 });
  assert.throws(() => C.close(d, NOW), /Nobody has voted/);
  swipes(d, [{ A: 'yes', B: 'no' }, { A: 'yes', B: 'yes' }]);
  assert.strictEqual(C.status(d, NOW).open, true, 'two of three');
  assert.throws(() => C.join(d, { vid: vid(9), name: 'Late' }, NOW), /for 3 people/, 'max people caps the joins');
  const late = JSON.parse(JSON.stringify(d));
  assert.deepStrictEqual([C.status(late, NOW + 3600e3).open, C.status(late, NOW + 3600e3).why], [false, 'deadline']);
  assert.throws(() => C.swipe(late, vid(2), 'o0', 'yes', NOW + 3600e3), (e) => e.status === 409 && e.code === 'closed' && /deadline passed/.test(e.message));
  swipes(d, [{}, {}, { A: 'yes', B: 'love' }]);
  assert.deepStrictEqual([C.status(d, NOW).open, C.status(d, NOW).why], [false, 'all'], 'all three in: it reveals itself');
  assert.throws(() => C.veto(d, vid(1), 'o0', NOW), /closed/);
  const h = world(['A', 'B']);
  swipes(h, [{ A: 'yes' }]);
  const c = C.close(h, NOW);
  assert.deepStrictEqual(c.patch.set, { closed: { at: NOW, why: 'host' } });
  C.applyPatch(h, c.patch);
  assert.deepStrictEqual([C.status(h, NOW).why, C.closedText(C.status(h, NOW))], ['host', 'The host closed voting.']);
  assert.throws(() => C.join(h, { vid: vid(7), name: 'x' }, NOW), /closed/);
  assert.strictEqual(C.close(h, NOW).msg, 'Already closed.');
});

test('re-open with the top 3: a second round on the best three, votes cleared, vetoes spent, the first round kept as a line', () => {
  const d = swipes(world(['A', 'B', 'C', 'D', 'E']), [
    { A: 'love', B: 'yes', C: 'yes', D: 'no', E: 'yes' },
    { A: 'no', B: 'yes', C: 'love', D: 'no', E: 'yes' },
    { A: 'yes', B: 'no', C: 'yes', D: 'no', E: 'no' },
  ]);
  assert.throws(() => C.reopenTop(d, NOW), /Close voting first/);
  C.applyPatch(d, C.close(d, NOW).patch);
  const r = C.reopenTop(d, NOW);
  C.applyPatch(d, r.patch);
  assert.deepStrictEqual(d.active.map((id) => label(d, id)), ['A', 'B', 'C'], 'C (the match, 4), A (3), then B over E (level on 2, B listed first) - in the list’s order');
  assert.deepStrictEqual([d.round, d.ballots, d.ranks, d.vetoed, d.closed, C.status(d, NOW).open, C.vetoesOn(d)], [2, {}, {}, {}, null, true, false]);
  assert.strictEqual(d.past.length, 1);
  assert.match(d.past[0].line, /^Settled: C/);
  assert.match(r.msg, /^Round 2: /);
  const none = swipes(world(['A', 'B', 'C']), [{ A: 'yes', B: 'no', C: 'no' }]);
  C.applyPatch(none, C.close(none, NOW).patch);
  assert.throws(() => C.reopenTop(none, NOW), /Fewer than two/);
});

test('what a member sees: nobody else’s votes before the reveal; totals only with “show as we go”; names only when named', () => {
  const d = swipes(world(['A', 'B']), [{ A: 'love', B: 'no' }, { A: 'yes', B: 'yes' }, { A: 'yes' }]);
  const v1 = C.memberView(d, { vid: vid(1), host: false }, NOW);
  assert.deepStrictEqual(v1.mine.ballot, { o0: 'yes', o1: 'yes' });
  assert.ok(!('result' in v1), 'no result while open');
  const s = JSON.stringify(v1);
  assert.ok(!s.includes('love') && !s.includes(vid(0)) && !s.includes('ballots'), 'no other ballot, no voter id');
  assert.deepStrictEqual(v1.people.map((p) => [p.name, p.done, p.you]), [['Host', true, false], ['Friend1', true, true], ['Friend2', false, false]]);
  d.live = true;
  const lv = C.memberView(d, { vid: vid(1), host: false }, NOW);
  assert.ok(lv.result && lv.result.rows.every((r) => !('by' in r)), 'totals, not who');
  d.live = false;
  C.applyPatch(d, C.close(d, NOW).patch);
  const named = C.memberView(d, { vid: vid(2), host: false }, NOW);
  assert.deepStrictEqual(named.result.rows.find((r) => r.label === 'A').by, { yes: ['Friend1', 'Friend2'], love: ['Host'], no: [] });
  d.named = false;
  const anon = C.memberView(d, { vid: vid(2), host: false }, NOW);
  assert.ok(anon.result.rows.every((r) => !('by' in r)) && !JSON.stringify(anon.result).includes('Friend'), 'anonymous: counts only');
  // Vetoes: who vetoed shows only when named.
  const w = world(['A', 'B', 'C']);
  C.applyPatch(w, C.veto(w, vid(1), 'o0', NOW).patch);
  assert.deepStrictEqual(C.memberView(w, { vid: vid(2) }, NOW).vetoed, { o0: 'Friend1' });
  assert.deepStrictEqual(C.memberView(w, { vid: vid(1) }, NOW).vetoed, { o0: 'you' });
  w.named = false;
  assert.deepStrictEqual(C.memberView(w, { vid: vid(2) }, NOW).vetoed, { o0: 'someone' });
});

test('the share lines are ready to paste', () => {
  const d = world(['A', 'B']);
  assert.strictEqual(C.inviteText(d, 'https://x/j/ABCDEF'), 'Where are we eating? Swipe in 30 seconds: https://x/j/ABCDEF');
  assert.strictEqual(C.inviteText({ question: 'Movie tonight', mode: 'rank' }, 'L'), 'Movie tonight? Rank your top 3 in 30 seconds: L');
});

test('the demo: three made-up friends; your swipes decide a match, a tie for the wheel, or none', () => {
  const run = (mine) => {
    const d = C.demoDecision(NOW);
    C.DEMO.friends.forEach((_, i) => C.demoLand(d, i));
    d.opts.forEach((o, k) => C.applyPatch(d, C.swipe(d, 'vyou00000', o.id, mine[k], NOW).patch));
    return { d, r: C.results(d), st: C.status(d, NOW) };
  };
  let x = run(['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes']);
  assert.deepStrictEqual([x.st.open, x.st.why, x.r.how, label(x.d, x.r.winner)], [false, 'all', 'match', 'Thai'], 'all four in: it reveals itself, and Thai has two loves');
  x = run(['no', 'yes', 'yes', 'no', 'no', 'no', 'no', 'no']);
  assert.deepStrictEqual([x.r.how, x.r.wheel.ids.map((id) => label(x.d, id))], ['match', ['Ramen', 'Tacos']], 'two equal matches: the wheel');
  x = run(['yes', 'no', 'no', 'no', 'no', 'no', 'no', 'no']);
  assert.deepStrictEqual([x.r.how, x.r.matches.length], ['score', 0]);
  assert.strictEqual(JSON.stringify(C.demoDecision(NOW)), JSON.stringify(C.demoDecision(NOW)));
});

/* ---------------- the model's half ---------------- */

test('the fake model and the cleaning of hostile output', async () => {
  const fake = require('../lib/fakeai').create();
  await assert.rejects(fake.messages.create({ messages: [] }), /force a tool/);
  const raw = (await fake.messages.create({ tool_choice: { type: 'tool', name: 'suggest_options' }, messages: [{ content: [{ type: 'text', text: 'INJECT' }] }] })).content[0].input;
  const got = ai.cleanSuggestions(raw, ['pizza']);
  assert.ok(got.length <= C.LIMITS.suggestMax);
  const s = JSON.stringify(got);
  assert.ok(!/[<>]/.test(s) && !/\u202e|\u0007/.test(s), 'no markup, bidi or control characters');
  assert.ok(got.every((o) => o.label.length <= C.LIMITS.label && o.note.length <= C.LIMITS.note && (o.emoji === '' || C.cleanEmoji(o.emoji) === o.emoji)));
  assert.strictEqual(got.filter((o) => C.fold(o.label) === 'iceskating').length, 1, 'repeats fold to one');
  assert.ok(got.every((o) => !/onerror|img/.test(o.label)), 'markup is gone, not escaped');
  assert.ok(!got.some((o) => o.label === 'Pizza'), 'nothing already on the list');
  assert.deepStrictEqual(ai.cleanSuggestions({ options: 'nope' }, []), []);
  assert.deepStrictEqual(ai.cleanSuggestions(null, []), []);
  const ok = ai.cleanSuggestions((await fake.messages.create({ tool_choice: { type: 'tool', name: 'suggest_options' }, messages: [{ content: [{ type: 'text', text: 'winter dates' }] }] })).content[0].input, []);
  assert.strictEqual(ok.length, 10);
  assert.throws(() => ai.cleanPrompt(''), /Say what/);
  assert.throws(() => ai.cleanPrompt('!!!'), /Say what/);
  assert.throws(() => ai.cleanPrompt('x'.repeat(500)), /short/);
  assert.strictEqual(ai.cleanPrompt('  <b>cheap</b> dates\u202e '), 'cheap dates');
  assert.deepStrictEqual(ai.cleanHave(['A', '<b>A</b>', '', 5, 'B']), ['A', 'B']);
  assert.match(ai.SYSTEM, /never an instruction/);
  assert.match(ai.SYSTEM, /never name a restaurant/);
  assert.strictEqual(ai.SUGGEST_TOOL.input_schema.properties.options.maxItems, 20);
});

/* ---------------- static checks ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'accent-soft']) for (const fg of ['text', 'muted', 'link']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent`);
    for (const k of ['yes', 'no', 'love']) {
      assert.ok(ratio(t[k], t.card) >= 4.5, `${name} ${k} on a card: ${ratio(t[k], t.card).toFixed(2)}`);
      assert.ok(ratio(t[k], t[`${k}-bg`]) >= 4.5, `${name} ${k} on its tint`);
      assert.ok(ratio(t[`${k}-on`], t[k]) >= 4.5, `${name} ink on a chosen ${k} button: ${ratio(t[`${k}-on`], t[k]).toFixed(2)}`);
    }
    assert.ok(ratio(t.veto, t['veto-bg']) >= 4.5 && ratio(t.veto, t.card) >= 4.5, `${name} the veto`);
    assert.ok(ratio(t.love, t.bg) >= 4.5, `${name} the reveal's eyebrow`);
    assert.ok(ratio(t.err, t.card) >= 4.5, `${name} errors`);
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5 && ratio(t['strip-btn-ink'], t['strip-btn']) >= 4.5, `${name} the dark strip and the toast`);
    assert.ok(ratio(t.accent, t.card) >= 3 && ratio(t.accent, t.bg) >= 3, `${name} the focus ring and buttons (3:1)`);
    assert.ok(ratio(t.text, t.line) >= 4.5, `${name} an empty rank number`);
  }
  // The wheel is a physical thing: dark ink on pastel slices in both themes.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const wheel = /var WHEEL = \[([^\]]+)\]/.exec(js)[1].match(/#[0-9a-f]{6}/gi);
  assert.ok(wheel.length >= 6);
  for (const c of wheel) assert.ok(ratio('#1d1530', c) >= 4.5, `wheel label on ${c}`);
  assert.ok(ratio('#111111', '#ffffff') >= 4.5, 'the QR screen');
});

test('the QR encoder draws a join link', () => {
  const svg = QR.svg('https://challenge.strongtechnicalconsulting.com/settle/j/ABCDEF', 'Join "x" <decision>');
  assert.ok(svg.startsWith('<svg') && !/<decision>|"x"/.test(svg));
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { SETTLE_MEMORY: '1' }], ['./lib/fakeai', { SETTLE_FAKE_AI: '1' }], ['./server', { SETTLE_FAKE_AI: '1', SETTLE_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, SETTLE_MEMORY: '', SETTLE_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; single-field queries only', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, SETTLE_MEMORY: '', SETTLE_COLLECTION_PREFIX: 'settle_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.ok(/SETTLE_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const queries = [...server.matchAll(/where: \[(\[[^\]]*\](?:, )?)+\]/g)];
  assert.ok(queries.length >= 2);
  for (const m of queries) assert.strictEqual((m[0].match(/\['/g) || []).length, 1, `one equality filter per query: ${m[0]}`);
  assert.ok(!/orderBy/.test(server), 'no ordered query, so no composite index');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, nothing logged from a body', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown|pointerdown) =/.test(js), 'handlers by addEventListener, not properties');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB/.test(js));
  assert.ok(!/<script/i.test(js), 'no script written into markup');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js) && !/location\.href = ['"]\//.test(js), 'every browser URL is relative to BASE');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js), 'no email address in the page');
  assert.ok(!/Math\.random/.test(js + fs.readFileSync(path.join(__dirname, '..', 'public', 'settle-core.js'), 'utf8')), 'the wheel and the demo never roll dice');
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /ArrowRight/);
  assert.match(js, /not real places, prices or showtimes/, 'the AI sheet says what it is not');
  for (const f of ['server.js', 'lib/ai.js', 'lib/decisions.js', 'public/settle-core.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|prompt|name|question|label|ballot)/.test(src), `${f} logs a body`);
  }
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const OPTS = ['🍕 Pizza', '🍜 Ramen', '🌮 Tacos', '🍣 Sushi', '🍛 Indian', '🍔 Burgers', '🥗 Poke', '🌶️ Thai'];
async function start(c, extra = {}) {
  const r = await c('POST', '/api/decisions', { question: 'Where are we eating?', options: OPTS, name: 'Ana', vetoes: true, named: true, ...extra });
  assert.strictEqual(r.status, 200, r.text);
  return r.data;
}
async function joinAs(code, name, ip) {
  const c = client(ip);
  const r = await c('POST', `/api/join/${code}`, { name });
  assert.strictEqual(r.status, 200, r.text);
  c.vid = r.data.me; c.id = r.data.id;
  return c;
}

test('signed out: the page works with zero model calls; the metered route answers 401 before reading a big body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.limits.optionsMax, meta.limits.voters, meta.decks.length], [30, 50, 8]);
  for (const f of ['settle-core.js', 'qr.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/suggest', { prompt: 'dates' })).status, 401);
  assert.strictEqual((await anon('POST', '/api/suggest', { prompt: 'x'.repeat(200 * 1024) })).status, 401, 'the gate answers before the 16 KB parser');
  assert.strictEqual((await anon('POST', '/api/decisions', { question: 'x'.repeat(100 * 1024) })).status, 413, 'every other route keeps the small limit');
  for (const p of ['/d/AAAAAAAAAAAAAAAA', '/j/ABCDEF']) {
    const r = await fetch(`${base}${p}`);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('<base href="../">'), 'deep links resolve assets from the app root');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  for (const p of ['/api/d/AAAAAAAAAAAAAAAA', '/api/join/ABCDEF']) assert.strictEqual((await anon('GET', p)).headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await anon('POST', '/api/decisions', {})).headers.get('x-robots-tag'), 'noindex, nofollow');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route’s gates come before its parser, in order; one model client in the whole server', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/suggest', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to one metered call');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('fill the deck: input checked before any spend, one metered call, suggestions cleaned, nothing stored, provider errors not passed on', async () => {
  const me = await register('ana.fill@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await me('POST', '/api/suggest', {})).status, 400);
  assert.strictEqual((await me('POST', '/api/suggest', { prompt: '!!! ...' })).status, 400);
  assert.strictEqual((await me('POST', '/api/suggest', { prompt: 'x'.repeat(600) })).status, 400, 'over the prompt limit');
  assert.strictEqual((await me('POST', '/api/suggest', { prompt: 'x'.repeat(20 * 1024) })).status, 413, 'its own 16 KB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const SECRET = 'ZEBRA-ASK-4417 cheap date ideas in winter';
  const r = await me('POST', '/api/suggest', { prompt: SECRET, have: ['Board game café'] });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.options.length, 9, 'ten ideas less the one already on the list');
  assert.ok(r.data.options.every((o) => o.label && typeof o.emoji === 'string' && typeof o.note === 'string'));
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const inj = await me('POST', '/api/suggest', { prompt: 'INJECT please' });
  assert.strictEqual(inj.status, 200);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\\u202e|\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(inj.data.options.length <= 20);
  const blank = await me('POST', '/api/suggest', { prompt: 'BLANK please' });
  assert.deepStrictEqual([blank.status, /Nothing usable/.test(blank.data.error)], [422, true]);
  assert.match((await me('POST', '/api/suggest', { prompt: 'MAXTOKENS please' })).data.error, /ran long/);
  const up = await me('POST', '/api/suggest', { prompt: 'UPSTREAM401 dates' });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await me('POST', '/api/suggest', { prompt: 'UPSTREAM529 dates' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'asking stores nothing');
  assert.ok(!store._dump().includes('ZEBRA-ASK'));
});

test('an unconfirmed free account gets the verify-email 403 before any model call or body; out of credit is a 402, never a 413', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/suggest', { prompt: 'dates' });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/settle/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/suggest', { prompt: 'x'.repeat(200 * 1024) })).status, 403, '403 before the body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/decisions', { question: 'Q?', options: ['a', 'b'] })).status, 200, 'a decision needs no AI and no account');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/suggest', { prompt: 'dates' })).status, 402);
  assert.strictEqual((await cal('POST', '/api/suggest', { prompt: 'x'.repeat(200 * 1024) })).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

let HOST; let ID; let CODE;

test('start with no account; friends join by code with a name; the browser key is HttpOnly and scoped to the app', async () => {
  HOST = client();
  const made = await HOST('POST', '/api/decisions', { question: '<b>Where</b> are we eating?', options: OPTS, name: 'Ana', vetoes: true, named: true, mode: 'swipe' });
  assert.strictEqual(made.status, 200, made.text);
  ID = made.data.id; CODE = made.data.d.code;
  assert.ok(D.isId(ID) && D.isCode(CODE));
  const ck = made.setCookie.find((c) => c.startsWith('settle_k='));
  assert.match(ck, /^settle_k=[A-Za-z0-9_-]{22}; Path=\/settle\/; Max-Age=\d+; SameSite=Lax; HttpOnly/, 'HttpOnly, scoped to the app path');
  const d = made.data.d;
  assert.deepStrictEqual([d.question, d.host, d.opts.length, d.opts[0].emoji, d.people.length, d.people[0].name, d.display], ['Where are we eating?', true, 8, '🍕', 1, 'Ana', `${CODE.slice(0, 3)}-${CODE.slice(3)}`]);
  // A friend opens the link.
  const sam = client();
  const look = await sam('GET', `/api/join/${CODE.toLowerCase().replace(/(...)/, '$1-')}`);
  assert.strictEqual(look.status, 200, 'the code is read however it is typed');
  assert.deepStrictEqual([look.data.question, look.data.options, look.data.joined, look.data.open, look.data.already, look.data.preview.length], ['Where are we eating?', 8, 1, true, null, 4]);
  assert.ok(!/Ana|keyHash|hostHash|ballots/.test(look.text), 'a code shows the question and some options, not who or how');
  assert.strictEqual(sam.cookies.settle_k, undefined, 'looking mints nothing');
  const j = await sam('POST', `/api/join/${CODE}`, { name: '<i>Sam</i>\u202e' });
  assert.strictEqual(j.status, 200, j.text);
  assert.deepStrictEqual([j.data.id, j.data.isNew], [ID, true]);
  const again = await sam('POST', `/api/join/${CODE}`, { name: 'Someone else' });
  assert.deepStrictEqual([again.data.me, again.data.isNew], [j.data.me, false], 'a browser that joined gets itself back');
  assert.strictEqual((await sam('GET', `/api/join/${CODE}`)).data.already, ID);
  const v = await sam('GET', `/api/d/${ID}`);
  assert.strictEqual(v.status, 200);
  assert.deepStrictEqual([v.data.d.host, v.data.d.people.map((p) => p.name)], [false, ['Ana', 'Sam']]);
  assert.ok(!/keyHash|hostHash|settle_k|v[0-9a-z]{8}"/.test(v.text.replace(/"me":"v[0-9a-z]{8}"/, '')), 'no hash, key or other voter id reaches a member');
  const sam2 = await joinAs(CODE, 'sam');
  assert.strictEqual((await sam2('GET', `/api/d/${ID}`)).data.d.people[2].name, 'sam 2', 'names stay unique, case folded');
  const blank = await joinAs(CODE, '   ');
  assert.strictEqual((await blank('GET', `/api/d/${ID}`)).data.d.people[3].name, 'Friend 4');
  // Polling: an idle decision costs one read.
  const same = await sam('GET', `/api/d/${ID}?since=${v.data.d.v + 2}`);
  assert.strictEqual(same.data.same, true);
  // Bad input is a sentence, not a crash.
  assert.strictEqual((await client()('POST', '/api/decisions', { question: 'Q?', options: ['one'] })).status, 400);
  assert.strictEqual((await client()('POST', '/api/decisions', { options: ['a', 'b'] })).status, 400);
  assert.strictEqual((await client()('POST', '/api/decisions', 'not json')).status, 400);
});

test('votes stay hidden until the reveal: no other ballot and no tally reach another member’s phone', async () => {
  const host = client();
  const mk = await start(host);
  const a = await joinAs(mk.d.code, 'Ari'); const b = await joinAs(mk.d.code, 'Bo');
  const o = mk.d.opts;
  for (const x of o) assert.strictEqual((await a('PUT', `/api/d/${mk.id}/vote`, { oid: x.id, v: x.label === 'Sushi' ? 'love' : 'no' })).status, 200);
  const seen = await b('GET', `/api/d/${mk.id}`);
  assert.ok(!('result' in seen.data.d));
  assert.deepStrictEqual(seen.data.d.mine.ballot, {});
  assert.ok(!/"love"|"no"/.test(seen.text), 'Ari’s votes are nowhere in Bo’s view');
  assert.strictEqual(seen.data.d.people.find((p) => p.name === 'Ari').done, true, 'only that Ari finished');
  const hostSees = await host('GET', `/api/d/${mk.id}`);
  assert.ok(!('result' in hostSees.data.d) && !/"love"/.test(hostSees.text), 'not even the host');
  // The answer to a vote is the voter's own view too.
  const own = await b('PUT', `/api/d/${mk.id}/vote`, { oid: o[0].id, v: 'yes' });
  assert.ok(!/"love"/.test(own.text));
  // "Show as we go": totals, never who.
  const live = await start(client(), { live: true });
  const l1 = await joinAs(live.d.code, 'L1'); const l2 = await joinAs(live.d.code, 'L2');
  await l1('PUT', `/api/d/${live.id}/vote`, { oid: live.d.opts[0].id, v: 'love' });
  const lv = await l2('GET', `/api/d/${live.id}`);
  assert.strictEqual(lv.data.d.result.rows.find((r) => r.id === live.d.opts[0].id).love, 1);
  assert.ok(lv.data.d.result.rows.every((r) => !('by' in r)) && !/L1"\]/.test(lv.text), 'no names with the totals');
  // After the reveal: named shows who.
  assert.strictEqual((await a('POST', `/api/d/${mk.id}/close`, {})).status, 404, 'only the host reveals');
  const closed = await host('POST', `/api/d/${mk.id}/close`, {});
  assert.strictEqual(closed.status, 200, closed.text);
  const after = (await b('GET', `/api/d/${mk.id}`)).data.d;
  assert.strictEqual(after.status.why, 'host');
  assert.deepStrictEqual(after.result.rows.find((r) => r.label === 'Sushi').by.love, ['Ari']);
  assert.strictEqual((await b('PUT', `/api/d/${mk.id}/vote`, { oid: o[1].id, v: 'yes' })).status, 409, 'nothing changes after the reveal');
  // Anonymous: counts only, even after.
  const an = await start(client(), { named: false });
  const x = await joinAs(an.d.code, 'Xan');
  await x('PUT', `/api/d/${an.id}/vote`, { oid: an.d.opts[0].id, v: 'love' });
  const anHost = client(); void anHost;
  const doc = await store.get('decisions', an.id);
  doc.closed = { at: Date.now(), why: 'host' };
  await store.set('decisions', an.id, doc);
  const anv = await x('GET', `/api/d/${an.id}`);
  assert.ok(anv.data.d.result && anv.data.d.result.rows.every((r) => !('by' in r)) && !anv.text.includes('"Xan"]'), 'anonymous stays anonymous');
});

test('many phones voting at once all stick; the same writes without the transaction lose one', async () => {
  const host = client();
  const mk = await start(host);
  const phones = [];
  for (let i = 0; i < 12; i++) phones.push(await joinAs(mk.d.code, `Runner${i}`));
  const votes = ['yes', 'no', 'love'];
  const all = await Promise.all(phones.flatMap((p, i) => mk.d.opts.map((o, k) => p('PUT', `/api/d/${mk.id}/vote`, { oid: o.id, v: votes[(i + k) % 3] }))));
  assert.ok(all.every((r) => r.status === 200), all.map((r) => r.status).join());
  const doc = await store.get('decisions', mk.id);
  for (const p of phones) assert.strictEqual(Object.keys(doc.ballots[p.vid] || {}).length, 8, 'every swipe of every phone kept');
  assert.strictEqual(Object.values(doc.ballots).reduce((n, b) => n + Object.keys(b).length, 0), 96, 'ninety-six swipes at once, ninety-six kept');
  const v = (await phones[3]('GET', `/api/d/${mk.id}`)).data.d;
  assert.strictEqual(v.status.done, 12);
  // Without the queue, two at once lose one.
  const before = await store.get('decisions', mk.id);
  await Promise.all(['vaaaaaaaa', 'vbbbbbbbb'].map((k) => store._unsafeUpdate('decisions', mk.id, (cur) => { cur.ballots[k] = { o0: 'yes' }; return cur; })));
  const lost = await store.get('decisions', mk.id);
  assert.strictEqual(['vaaaaaaaa', 'vbbbbbbbb'].filter((k) => lost.ballots[k]).length, 1, 'a plain read-change-write loses one');
  await store.set('decisions', mk.id, before);
  // Rank mode: twelve top 3s at once.
  const rk = await start(client(), { mode: 'rank' });
  const rp = [];
  for (let i = 0; i < 12; i++) rp.push(await joinAs(rk.d.code, `R${i}`));
  const rr = await Promise.all(rp.map((p, i) => p('PUT', `/api/d/${rk.id}/rank`, { order: [rk.d.opts[i % 8].id, rk.d.opts[(i + 1) % 8].id] })));
  assert.ok(rr.every((r) => r.status === 200));
  assert.strictEqual(Object.keys((await store.get('decisions', rk.id)).ranks).length, 12);
});

test('two vetoes of the same option at once count once, and the second voter keeps theirs', async () => {
  const mk = await start(client());
  const a = await joinAs(mk.d.code, 'Ann'); const b = await joinAs(mk.d.code, 'Ben');
  const sushi = mk.d.opts.find((o) => o.label === 'Sushi').id;
  const [ra, rb] = await Promise.all([a('PUT', `/api/d/${mk.id}/veto`, { oid: sushi }), b('PUT', `/api/d/${mk.id}/veto`, { oid: sushi })]);
  assert.deepStrictEqual([ra.status, rb.status], [200, 200]);
  assert.deepStrictEqual([ra.data.status, rb.data.status].sort(), ['already', 'vetoed']);
  const doc = await store.get('decisions', mk.id);
  assert.deepStrictEqual(Object.keys(doc.vetoed), [sushi]);
  const loser = ra.data.status === 'already' ? a : b;
  const lv = (await loser('GET', `/api/d/${mk.id}`)).data.d;
  assert.strictEqual(lv.mine.veto, null, 'still has a veto');
  assert.strictEqual(lv.vetoed[sushi], ra.data.status === 'already' ? 'Ben' : 'Ann', 'named: who vetoed it');
  const second = await loser('PUT', `/api/d/${mk.id}/veto`, { oid: mk.d.opts[0].id });
  assert.strictEqual(second.data.status, 'vetoed', 'and can use it');
  // Many vetoes of many options at once: each voter's one stands.
  const mk2 = await start(client());
  const ps = [];
  for (let i = 0; i < 6; i++) ps.push(await joinAs(mk2.d.code, `V${i}`));
  await Promise.all(ps.map((p, i) => p('PUT', `/api/d/${mk2.id}/veto`, { oid: mk2.d.opts[i].id })));
  assert.strictEqual(Object.keys((await store.get('decisions', mk2.id)).vetoed).length, 6);
  // A vote for something just vetoed is refused with a reason.
  const late = await ps[0]('PUT', `/api/d/${mk2.id}/vote`, { oid: mk2.d.opts[1].id, v: 'yes' });
  assert.deepStrictEqual([late.status, late.data.code], [409, 'vetoed']);
  // Vetoes off: refused.
  const off = await start(client(), { vetoes: false });
  const z = await joinAs(off.d.code, 'Zed');
  assert.strictEqual((await z('PUT', `/api/d/${off.id}/veto`, { oid: off.d.opts[0].id })).status, 400);
});

test('strangers get the 404 a missing decision gets, on every route; host-only routes are the same 404 to members', async () => {
  const mk = await start(client());
  const member = await joinAs(mk.d.code, 'Mem');
  const stranger = client();
  const signedIn = await register('stranger@example.com');
  const routes = [['GET', `/api/d/${mk.id}`], ['PUT', `/api/d/${mk.id}/vote`, { oid: 'o0', v: 'yes' }], ['PUT', `/api/d/${mk.id}/rank`, { order: ['o0'] }], ['PUT', `/api/d/${mk.id}/veto`, { oid: 'o0' }], ['POST', `/api/d/${mk.id}/close`, {}], ['POST', `/api/d/${mk.id}/reopen`, {}], ['DELETE', `/api/d/${mk.id}`]];
  const missing = await stranger('GET', '/api/d/AAAAAAAAAAAAAAAA');
  for (const [m, p, b] of routes) for (const who of [stranger, signedIn]) {
    const x = await who(m, p, b);
    assert.deepStrictEqual([x.status, x.data.error], [404, missing.data.error], `${m} ${p}`);
  }
  for (const [m, p] of [['POST', `/api/d/${mk.id}/close`], ['POST', `/api/d/${mk.id}/reopen`], ['DELETE', `/api/d/${mk.id}`]]) assert.strictEqual((await member(m, p, {})).status, 404, `a member: ${m} ${p}`);
  assert.strictEqual((await stranger('GET', `/api/d/${mk.id.slice(0, 15)}!`)).status, 404, 'a malformed id');
  for (const m of ['POST', 'PUT', 'DELETE']) assert.strictEqual((await stranger(m, `/d/${mk.id}`, {})).status, 405);
});

test('the wrong-code limiter: distinct wrong codes are counted, then even the right one waits; one dead id polled is not guessing', async () => {
  const mk = await start(client());
  const guesser = client();
  for (let i = 0; i < D.LIMITS.missesPerIp; i++) assert.strictEqual((await guesser('GET', `/api/join/${'ABCDEFGHJK'[i % 10]}${'ABCDEFGHJK'[Math.floor(i / 10)]}ZZZZ`)).status, 404);
  assert.strictEqual((await guesser('GET', '/api/join/ZZZZZZ')).status, 429);
  assert.strictEqual((await guesser('GET', `/api/join/${mk.d.code}`)).status, 429, 'even the right code waits');
  assert.strictEqual((await guesser('GET', `/api/d/${mk.id}`)).status, 429, 'and ids count with codes');
  const poller = client();
  for (let i = 0; i < 40; i++) assert.strictEqual((await poller('GET', '/api/d/AAAAAAAAAAAAAAAA')).status, 404, 'the same dead id is not guessing');
});

test('creation limits: ten new decisions an hour per address (IPv6 by its /64); forty new voters; caps on options and people', async () => {
  const net = '2001:db8:aaaa:1';
  for (let i = 0; i < D.LIMITS.decisionsPerIp; i++) assert.strictEqual((await client(`${net}::${i + 1}`)('POST', '/api/decisions', { question: `Q${i}?`, options: ['a', 'b'] })).status, 200);
  const r = await client(`${net}::99`)('POST', '/api/decisions', { question: 'One more?', options: ['a', 'b'] });
  assert.strictEqual(r.status, 429, 'the same /64');
  assert.match(r.data.error, /10 new decisions/);
  assert.strictEqual((await client('2001:db8:aaaa:2::1')('POST', '/api/decisions', { question: 'Other net?', options: ['a', 'b'] })).status, 200, 'another /64');
  // Forty new voters an hour from one address.
  const mk = await start(client());
  const crowd = '2001:db8:bbbb:1';
  for (let i = 0; i < D.LIMITS.newVotersPerIp; i++) assert.strictEqual((await client(`${crowd}::${i + 1}`)('POST', `/api/join/${mk.d.code}`, { name: `P${i}` })).status, 200);
  assert.strictEqual((await client(`${crowd}::77`)('POST', `/api/join/${mk.d.code}`, { name: 'Over' })).status, 429);
  // Thirty options at most; fifty people at most; max people respected.
  const big = await client()('POST', '/api/decisions', { question: 'Big?', options: Array.from({ length: 60 }, (_, i) => `Thing ${i}`) });
  assert.strictEqual(big.data.d.opts.length, 30);
  const full = await start(client());
  const doc = await store.get('decisions', full.id);
  for (let i = 0; i < 49; i++) doc.voters[`vfull${String(i).padStart(4, '0')}`] = { name: `F${i}`, host: false, at: new Date().toISOString() };
  await store.set('decisions', full.id, doc);
  assert.strictEqual((await client()('GET', `/api/join/${full.d.code}`)).data.full, true);
  const no = await client()('POST', `/api/join/${full.d.code}`, { name: 'Fifty-one' });
  assert.deepStrictEqual([no.status, /50 people is the most/.test(no.data.error)], [409, true]);
  const two = await start(client(), { max: 2 });
  await joinAs(two.d.code, 'Second');
  assert.strictEqual((await client()('POST', `/api/join/${two.d.code}`, { name: 'Third' })).status, 409);
  // Labels and questions are bounded.
  const long = await client()('POST', '/api/decisions', { question: 'q'.repeat(400), options: ['x'.repeat(400), 'y'] });
  assert.deepStrictEqual([Array.from(long.data.d.question).length, Array.from(long.data.d.opts[0].label).length], [120, 60]);
});

test('closing over HTTP: everyone expected voting reveals it; a passed deadline reveals it on the next read; re-open with the top 3', async () => {
  const host = client();
  const mk = await start(host, { max: 3 });
  const a = await joinAs(mk.d.code, 'A1'); const b = await joinAs(mk.d.code, 'B1');
  const vote = (c, f) => Promise.all(mk.d.opts.map((o, k) => c('PUT', `/api/d/${mk.id}/vote`, { oid: o.id, v: f(k) })));
  await vote(host, (k) => (k < 3 ? 'yes' : 'no'));
  await vote(a, (k) => (k === 1 ? 'love' : k < 4 ? 'yes' : 'no'));
  let v = (await b('GET', `/api/d/${mk.id}`)).data.d;
  assert.strictEqual(v.status.open, true);
  await vote(b, (k) => (k < 3 ? 'yes' : 'no'));
  v = (await b('GET', `/api/d/${mk.id}`)).data.d;
  assert.deepStrictEqual([v.status.open, v.status.why, v.result.how, v.result.winner], [false, 'all', 'match', mk.d.opts[1].id], 'Ramen: a match, loved once');
  // Re-open with the top 3: host only.
  assert.strictEqual((await a('POST', `/api/d/${mk.id}/reopen`, {})).status, 404);
  const re = await host('POST', `/api/d/${mk.id}/reopen`, {});
  assert.strictEqual(re.status, 200, re.text);
  assert.deepStrictEqual([re.data.d.round, re.data.d.active.length, re.data.d.status.open, re.data.d.vetoes, re.data.d.past.length], [2, 3, true, false, 1]);
  assert.match(re.data.msg, /^Round 2: Pizza, Ramen and Tacos\.$/);
  assert.strictEqual((await a('PUT', `/api/d/${mk.id}/vote`, { oid: mk.d.opts[5].id, v: 'yes' })).status, 400, 'only the top 3 are in round 2');
  // A deadline that passes: the next read reveals it, even through ?since.
  const dl = await start(client(), { deadline: Date.now() + 5 * 60e3 });
  const p = await joinAs(dl.d.code, 'Dee');
  await p('PUT', `/api/d/${dl.id}/vote`, { oid: dl.d.opts[0].id, v: 'yes' });
  const vv = (await p('GET', `/api/d/${dl.id}`)).data.d.v;
  const doc = await store.get('decisions', dl.id);
  doc.deadline = Date.now() - 1000;
  await store.set('decisions', dl.id, doc);
  const after = await p('GET', `/api/d/${dl.id}?since=${vv}`);
  assert.ok(after.data.d, 'not "same" once the deadline has passed');
  assert.deepStrictEqual([after.data.d.status.open, after.data.d.status.why, after.data.d.result.winner], [false, 'deadline', dl.d.opts[0].id]);
  assert.strictEqual((await p('PUT', `/api/d/${dl.id}/vote`, { oid: dl.d.opts[1].id, v: 'yes' })).status, 409);
  assert.strictEqual((await client()('POST', `/api/join/${dl.d.code}`, { name: 'Late' })).status, 409, 'no joining a closed one');
});

test('settle another with the same people: the old reveal points at the new one; only its host can do that', async () => {
  const host = client();
  const mk = await start(host);
  const friend = await joinAs(mk.d.code, 'Fred');
  await friend('PUT', `/api/d/${mk.id}/vote`, { oid: mk.d.opts[0].id, v: 'yes' });
  await host('POST', `/api/d/${mk.id}/close`, {});
  const next = await host('POST', '/api/decisions', { question: 'Movie after?', options: ['Comedy', 'Horror'], after: mk.id });
  assert.strictEqual(next.status, 200);
  const old = (await friend('GET', `/api/d/${mk.id}`)).data.d;
  assert.deepStrictEqual(old.next, { code: next.data.d.code, question: 'Movie after?' });
  const hop = await friend('POST', `/api/join/${old.next.code}`, { name: 'Fred' });
  assert.strictEqual(hop.data.id, next.data.id);
  // A stranger cannot hang their decision off someone else's.
  const sneaky = await client()('POST', '/api/decisions', { question: 'Spam?', options: ['a', 'b'], after: next.data.id });
  assert.strictEqual(sneaky.status, 200);
  assert.strictEqual((await store.get('decisions', next.data.id)).next, null);
});

test('idle decisions are deleted by the read that finds them; the host deletes; nothing identifying is stored', async () => {
  const me = await register('host.person@example.com');
  const mk = await start(me);
  const f = await joinAs(mk.d.code, 'Fay');
  const raw = JSON.stringify(await store.get('decisions', mk.id));
  assert.ok(!/example\.com/.test(raw), 'no email');
  assert.ok(!raw.includes(uidOf('host.person@example.com')), 'no account id');
  assert.ok(!raw.includes(me.cookies.settle_k) && !raw.includes(f.cookies.settle_k), 'no browser key, only its hash');
  assert.ok(!/"ip"|2001:db8/.test(raw), 'no address');
  assert.deepStrictEqual(Object.keys(JSON.parse(raw)).filter((k) => k !== 'id').sort(), ['active', 'ballots', 'closed', 'code', 'createdAt', 'deadline', 'hostHash', 'live', 'max', 'mode', 'named', 'next', 'opts', 'past', 'question', 'ranks', 'round', 'updatedAt', 'v', 'vetoed', 'vetoes', 'voters']);
  for (const v of Object.values(JSON.parse(raw).voters)) assert.deepStrictEqual(Object.keys(v).sort(), ['at', 'host', 'keyHash', 'name']);
  // Idle: 14 days untouched.
  const doc = await store.get('decisions', mk.id);
  doc.updatedAt = new Date(Date.now() - 15 * 86400e3).toISOString();
  await store.set('decisions', mk.id, doc);
  assert.strictEqual((await f('GET', `/api/d/${mk.id}`)).status, 404);
  assert.strictEqual(await store.get('decisions', mk.id), null, 'deleted by the read that found it');
  const mk2 = await start(client());
  const d2 = await store.get('decisions', mk2.id);
  d2.updatedAt = new Date(Date.now() - 15 * 86400e3).toISOString();
  await store.set('decisions', mk2.id, d2);
  assert.strictEqual((await client()('GET', `/api/join/${mk2.d.code}`)).status, 404);
  assert.strictEqual(await store.get('decisions', mk2.id), null, 'by a code lookup too');
  // The host deletes; then it is gone for everyone.
  const h3 = client(); const mk3 = await start(h3); const g = await joinAs(mk3.d.code, 'Gus');
  assert.strictEqual((await g('DELETE', `/api/d/${mk3.id}`)).status, 404);
  assert.strictEqual((await h3('DELETE', `/api/d/${mk3.id}`)).status, 200);
  assert.strictEqual((await g('GET', `/api/d/${mk3.id}`)).status, 404);
});

test('rank mode over HTTP: top 3s, ranked choice at the reveal, rounds in words, named picks', async () => {
  const host = client();
  const mk = await start(host, { mode: 'rank', options: ['Thai', 'Pizza', 'Ramen'], vetoes: false });
  const o = Object.fromEntries(mk.d.opts.map((x) => [x.label, x.id]));
  const ps = [host];
  for (const n of ['B', 'C', 'D', 'E']) ps.push(await joinAs(mk.d.code, n));
  const ballots = [['Thai', 'Pizza'], ['Pizza'], ['Pizza', 'Thai'], ['Ramen'], ['Ramen', 'Pizza']];
  await Promise.all(ps.map((p, i) => p('PUT', `/api/d/${mk.id}/rank`, { order: ballots[i].map((l) => o[l]) })));
  assert.strictEqual((await ps[1]('PUT', `/api/d/${mk.id}/vote`, { oid: o.Thai, v: 'yes' })).status, 400);
  assert.strictEqual((await ps[1]('PUT', `/api/d/${mk.id}/rank`, { order: [o.Thai, o.Thai] })).status, 400);
  const r = await host('POST', `/api/d/${mk.id}/close`, {});
  const res = r.data.d.result;
  assert.deepStrictEqual([res.how, res.winner, res.rounds.length], ['majority', o.Pizza, 2]);
  assert.strictEqual(res.rounds[0].text, 'Round 1: Pizza (2) · Ramen (2) · Thai (1). Thai had the fewest, so Thai’s vote moved to Pizza.');
  assert.deepStrictEqual(res.picks.map((p) => p.name), ['Ana', 'B', 'C', 'D', 'E']);
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/settle' ? res.redirect(301, '/settle/') : next()));
  host.use('/settle', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/settle`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
