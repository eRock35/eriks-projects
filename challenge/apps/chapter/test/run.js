// Pure rules first (text and hostile input, codes, the book and progress,
// the board and its nudges with a fixed clock, THE SPOILER RULE, approval
// voting and its tie-break, the shelf, meetups and the .ics, the member's
// view, the AI's request and answer, the made-up club), then the page's own
// promises, then end to end against the memory store and the fake model:
//   CHAPTER_MEMORY=1 CHAPTER_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /chapter, the way
// the lab mounts it, so the key cookie, the budget gate and each route's
// parser order are exercised as deployed. Model calls are counted from the
// identity usage rows, and what reached "the model" is read from the fake's
// own log.
//
// Every club, reader and note here is made up.

process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.CHAPTER_MEMORY !== '1' || process.env.CHAPTER_FAKE_AI !== '1') {
  console.error('run with CHAPTER_MEMORY=1 CHAPTER_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store, fakeClient } = require('../server');
const C = require('../public/chapter-core');
const K = require('../lib/clubs');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TODAY = '2026-11-06'; // a Friday
const NOW = Date.parse('2026-11-06T18:00:00Z');
let seq = 0;
const dice = () => { const s = [7, 3, 31, 12, 0, 25, 18, 9, 4, 33, 21, 14]; return (n) => s[(seq++) % s.length] % n; };
const rand = dice();

function lum(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/** A small club built through the core, as the server would build it. */
function club(o) {
  const x = Object.assign({ chapters: 20, pages: null }, o || {});
  const c = C.newClub({ name: 'Elm Street Readers', you: { name: 'Ana', emoji: '\u{1F989}' }, book: { title: 'Frankenstein', author: 'Mary Shelley', chapters: x.chapters, pages: x.pages } }, { now: NOW - 10 * 86400000, today: C.addDays(TODAY, -10), hostId: 'mana', bookId: 'bfrank', tz: 'America/New_York' });
  c.id = 'clubAAAAAAAAAAAA';
  let cur = c;
  for (const [mid, name, emoji] of [['mbo', 'Bo', '\u{1F41D}'], ['mcy', 'Cy', '\u{1F98A}'], ['mdee', 'Dee', '\u{1F422}']]) cur = C.applyPatch(cur, C.join(cur, { mid, name, emoji, keyHash: 'h' + mid }, NOW - 9 * 86400000).patch);
  return cur;
}
const at = (c, mid, pos) => C.applyPatch(c, C.setProgress(c, mid, typeof pos === 'object' ? pos : { pos }, NOW).patch);
const note = (c, mid, n, text, kind) => Object.assign({ id: 'n' + (++seq) + 'x' }, C.newNote(c, mid, { kind: kind || 'note', text, at: n }, { now: NOW }));

/* ================================================================== *
 * Text and hostile input
 * ================================================================== */

test('text: one plain line, invisible and bidi characters removed, markup stripped, cut on a whole character; a note keeps a few line breaks; escaping covers quotes', () => {
  assert.strictEqual(C.line('  a\n\tb\u202Ec\u200Bd  ', 60), 'a bcd');
  assert.strictEqual(C.line('\u{1F4DA}'.repeat(70), 60), '\u{1F4DA}'.repeat(60));
  assert.strictEqual(C.plain('<img src=x onerror=alert(1)>Pride <b>and</b> Prejudice', 80), 'Pride and Prejudice');
  assert.strictEqual(C.plain('x'.repeat(100000), 30).length, 30);
  assert.strictEqual(C.esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  assert.strictEqual(C.para('one\r\n\r\n\r\ntwo\nthree\u2066x\u2069', 500), 'one\n\ntwo\nthreex');
  assert.strictEqual(C.para('a\nb\nc\nd\ne\nf\ng\nh', 500).split('\n').length, 6, 'at most six lines');
  assert.strictEqual(Array.from(C.para('é'.repeat(900), 500)).length, 500);
  assert.strictEqual(C.cleanName('Priya'), 'Priya');
  assert.strictEqual(C.cleanName('Anne-Marie O\u2019Neil'), 'Anne-Marie O\u2019Neil');
  assert.strictEqual(C.cleanName('Zo\u00eb'), 'Zo\u00eb');
  assert.strictEqual(C.cleanName('<b>Sam</b>; DROP 555-0100'), 'Sam DROP');
  assert.strictEqual(C.cleanName('\u202Enimda'), 'nimda');
  assert.strictEqual(C.cleanName('x'.repeat(200)).length, 24);
  for (const bad of ['', '1234', '<>', '   ', null, {}, '\u200B\u200B']) assert.strictEqual(C.cleanName(bad), '', String(bad));
  assert.strictEqual(C.cleanEmoji('<script>'), C.EMOJI[0]);
  assert.strictEqual(C.cleanEmoji('\u{1F98A}'), '\u{1F98A}');
  assert.strictEqual(C.cleanLink('https://meet.example.org/abc-def'), 'https://meet.example.org/abc-def');
  for (const bad of ['http://meet.example.org/x', 'javascript:alert(1)', 'https://user:pw@example.org/', 'https://localhost/x', 'ftp://x.org', 'https://ex ample.org', 'data:text/html,hi']) assert.strictEqual(C.cleanLink(bad), '', bad);
});

test('codes: six characters from an alphabet with no I, O, 0 or 1; typed however; the server draws only from it', () => {
  assert.ok(!/[IO01]/.test(C.CODE_ALPHABET) && C.CODE_ALPHABET.length === 32);
  assert.strictEqual(C.normalizeCode(' abc-def '), 'ABCDEF');
  assert.strictEqual(C.formatCode('abcdef'), 'ABC-DEF');
  assert.ok(C.isCode('PAGE42') && !C.isCode('PAGE4O') && !C.isCode('ABCDE') && !C.isCode('ABCDEFG') && !C.isCode('abcdef'));
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const c = K.newCode(); assert.ok(C.isCode(c), c); seen.add(c); }
  assert.ok(seen.size > 1990, 'codes do not repeat');
  assert.ok(K.isClubId(K.newClubId()) && K.newKey().length === 22 && K.isSecret(K.newSecret()));
});

/* ================================================================== *
 * The book, progress and the board
 * ================================================================== */

test('the book: chapters are the unit when given (the same in every edition), else pages; bad counts are refused', () => {
  assert.deepStrictEqual(C.cleanBook({ title: ' <i>Middlemarch</i> ', author: 'George Eliot', chapters: '86' }), { title: 'Middlemarch', author: 'George Eliot', chapters: 86, pages: null });
  assert.strictEqual(C.unitOf({ chapters: 12, pages: 300 }), 'ch');
  assert.strictEqual(C.unitOf({ chapters: null, pages: 300 }), 'pg');
  assert.strictEqual(C.totalOf({ chapters: null, pages: 300 }), 300);
  for (const bad of [{}, { title: 'X' }, { title: 'X', chapters: 0 }, { title: 'X', chapters: 401 }, { title: 'X', chapters: 'lots' }, { title: 'X', pages: -3 }, { title: '<>', chapters: 3 }]) assert.throws(() => C.cleanBook(bad), (e) => e.status === 400, JSON.stringify(bad));
  assert.strictEqual(C.posOf({ pos: 99 }, { chapters: 20 }), 20, 'clamped to the book');
  assert.strictEqual(C.posOf({ pos: -4 }, { chapters: 20 }), 0);
  assert.strictEqual(C.posOf({ done: true, pos: 3 }, { chapters: 20 }), 20);
  assert.ok(C.isDone({ pos: 20 }, { chapters: 20 }) && !C.isDone({ pos: 19 }, { chapters: 20 }));
});

test('progress: a patch of three keys for one member; the last chapter is finishing; the board puts everyone along the book with "Maya is 3 chapters ahead of you"', () => {
  let c = club();
  const p = C.setProgress(c, 'mbo', { pos: 7 }, NOW);
  assert.deepStrictEqual(Object.keys(p.patch.set).sort(), ['members.mbo.at', 'members.mbo.done', 'members.mbo.pos']);
  assert.deepStrictEqual(p.patch.del, []);
  assert.throws(() => C.setProgress(c, 'mbo', { pos: 21 }, NOW), /from 0 to 20/);
  assert.throws(() => C.setProgress(c, 'nobody', { pos: 1 }, NOW), (e) => e.status === 404);
  c = at(at(at(c, 'mana', 8), 'mbo', 11), 'mcy', { done: true });
  assert.strictEqual(at(c, 'mdee', 20).members.mdee.done, true, 'reaching the last chapter is finishing');
  const b = C.board(c, 'mana', TODAY, 'en-US');
  assert.deepStrictEqual(b.rows.map((r) => r.name), ['Cy', 'Bo', 'Ana', 'Dee']);
  assert.deepStrictEqual(b.rows.map((r) => r.line), ['Cy has finished', 'Bo is 3 chapters ahead of you', 'You’re at chapter 8', 'Dee is 8 chapters behind you']);
  assert.strictEqual(C.relLine(at(c, 'mdee', 8), 'mdee', 'mana'), 'Dee is on the same chapter as you');
  assert.strictEqual(C.relLine(at(c, 'mana', { done: true }), 'mcy', 'mana'), 'Cy has finished too');
  assert.strictEqual(b.finished, 1);
  assert.strictEqual(b.allDone, false);
  let all = c; for (const m of ['mana', 'mbo', 'mdee']) all = at(all, m, { done: true });
  assert.strictEqual(C.board(all, 'mana', TODAY).allDone, true, 'the moment everyone has finished');
  const pages = C.applyPatch(club({ chapters: null, pages: 320 }), C.setProgress(club({ chapters: null, pages: 320 }), 'mbo', { pos: 45 }, NOW).patch);
  assert.strictEqual(C.relLine(pages, 'mbo', 'mana'), 'Bo is 45 pages ahead of you');
});

test('the nudge with a fixed clock: behind, on track, ready, late, done and no meeting - "read 2 chapters a day to finish by Thu"', () => {
  // The book started on Oct 27; the meeting is Thu Nov 12, ten chapters
  // in, so the straight line says chapter 6 by today (Fri Nov 6).
  let c = club();
  c = C.applyPatch(c, C.addMeeting(c, 'mana', { date: '2026-11-12', time: '19:00', upTo: 10 }, 'tmeet', { now: NOW, today: TODAY }).patch);
  const n = (pos) => C.nudge(at(c, 'mana', pos), 'mana', TODAY, 'en-US');
  assert.deepStrictEqual([n(2).kind, n(2).perDay, n(2).line], ['behind', 2, 'Behind schedule - read 2 chapters a day to reach chapter 10 by Thu']);
  assert.deepStrictEqual([n(7).kind, n(7).line], ['on-track', 'On track - 1 chapter a day gets you to chapter 10 by Thu']);
  assert.deepStrictEqual([n(10).kind, n(10).line], ['ready', 'You’re ready for the meeting on Thu.']);
  assert.strictEqual(C.nudge(at(c, 'mana', 4), 'mana', '2026-11-12', 'en-US').line, 'The meeting is today - 6 chapters to go to reach chapter 10.');
  assert.strictEqual(C.nudge(at(c, 'mana', 4), 'mana', '2026-11-11', 'en-US').line, 'Behind schedule - read 6 chapters a day to reach chapter 10 tomorrow');
  assert.strictEqual(n({ done: true }).kind, 'done');
  // The whole book: "to finish".
  let w = club();
  w = C.applyPatch(w, C.addMeeting(w, 'mana', { date: '2026-11-19', time: '' }, 'tw', { now: NOW, today: TODAY }).patch);
  assert.strictEqual(C.nudge(at(w, 'mana', 3), 'mana', TODAY, 'en-US').line, 'Behind schedule - read 2 chapters a day to finish by Thu, Nov 19');
  assert.strictEqual(C.nudge(club(), 'mana', TODAY).kind, 'none');
  // Across the clock change (Nov 1 in New York): days, not hours.
  assert.strictEqual(C.dayDiff('2026-10-31', '2026-11-02'), 2);
  assert.strictEqual(C.dayDiff('2026-03-07', '2026-03-09'), 2);
  const b = C.board(at(c, 'mana', 2), 'mana', TODAY, 'en-US');
  assert.deepStrictEqual([b.finish.at, b.finish.pct, b.finish.label], [10, 50, 'Thu'], 'the meeting is the finish line');
  assert.strictEqual(b.ready, 0);
});

/* ================================================================== *
 * THE SPOILER RULE
 * ================================================================== */

test('the spoiler rule: a note is read only by its author, a finisher, or someone at or past its chapter - everyone else gets a count by chapter and nothing more', () => {
  let c = at(at(at(club(), 'mana', 12), 'mbo', 4), 'mcy', { done: true });
  const ns = [note(c, 'mana', 3, 'The storm scene'), note(c, 'mana', 12, 'Big reveal here', 'question'), note(c, 'mcy', 18, 'The ending wrecked me'), note(c, 'mcy', 5, 'Early thought')];
  const forBo = C.splitNotes(ns, 'mbo', c.members.mbo, c.book);
  assert.deepStrictEqual(forBo.visible.map((n) => n.at), [3]);
  assert.deepStrictEqual(forBo.locked, { total: 3, chapters: [[5, 1], [12, 1], [18, 1]], after: 4 });
  assert.strictEqual(C.lockedLine(forBo.locked, c.book), '3 notes waiting past chapter 4');
  assert.deepStrictEqual(C.splitNotes(ns, 'mana', c.members.mana, c.book).visible.map((n) => n.at).sort((a, b) => a - b), [3, 5, 12], 'up to chapter 12 - not 18');
  assert.strictEqual(C.splitNotes(ns, 'mcy', c.members.mcy, c.book).visible.length, 4, 'finished: everything');
  const back = at(c, 'mana', 1);
  assert.ok(C.canSee(ns[1], 'mana', back.members.mana, back.book), 'your own note stays yours even if you move back');
  assert.strictEqual(C.splitNotes(ns, 'mdee', c.members.mdee, c.book).locked.after, 0);
  const view = C.memberView(c, ns, 'mbo', { today: TODAY, locale: 'en-US' });
  const json = JSON.stringify(view);
  for (const t of ['Big reveal here', 'The ending wrecked me', 'Early thought']) assert.ok(!json.includes(t), `${t} reached a reader who is not there yet`);
  assert.ok(json.includes('The storm scene'));
  // A note is tagged no further than its author has read.
  assert.throws(() => C.newNote(c, 'mbo', { text: 'Guessing ahead', at: 9 }, { now: NOW }), /only tag up to where you are/);
  assert.throws(() => C.newNote(club(), 'mbo', { text: 'Before starting', at: 1 }, { now: NOW }), /Set your bookmark first/);
  assert.throws(() => C.newNote(at(club(), 'mbo', 2), 'mbo', { text: '!!!', at: 1 }, { now: NOW }), /Write the note first/);
  assert.strictEqual(C.newNote(c, 'mcy', { text: 'fine', at: 20 }, { now: NOW }).at, 20, 'a finisher can tag the last chapter');
  assert.strictEqual(C.newNote(c, 'mana', { text: '<b>x</b>'.repeat(200), at: 2 }, { now: NOW }).text.length <= 500, true);
  assert.strictEqual(C.newNote(c, 'mana', { kind: 'question', text: 'q'.repeat(400), at: 2 }, { now: NOW }).text.length, 300, 'a question is shorter');
  assert.strictEqual(C.newNote(c, 'mana', { kind: 'nonsense', text: 'hello', at: 2, ai: true }, { now: NOW }).kind, 'note');
  assert.strictEqual(C.newNote(c, 'mana', { kind: 'note', text: 'hello', at: 2, ai: true }, { now: NOW }).ai, false, 'only a question can be marked AI-written');
});

test('reactions: one per member per note from a closed set, written as one key; counts only', () => {
  const c = at(club(), 'mana', 5);
  let n = note(c, 'mana', 2, 'Hello');
  n = C.applyPatch(n, C.react(n, 'mbo', '\u{1F602}').patch);
  n = C.applyPatch(n, C.react(n, 'mcy', '\u{1F602}').patch);
  n = C.applyPatch(n, C.react(n, 'mbo', '\u{2764}\u{FE0F}').patch);
  assert.deepStrictEqual(C.reactionCounts(n), [['\u{2764}\u{FE0F}', 1], ['\u{1F602}', 1]]);
  assert.deepStrictEqual(C.react(n, 'mbo', null).patch, { set: {}, del: ['reactions.mbo'] });
  assert.throws(() => C.react(n, 'mbo', '<img>'), (e) => e.status === 400);
});

/* ================================================================== *
 * What's next: approval voting
 * ================================================================== */

test('approval voting: one ballot per member, every book they would read; most approvals wins; a tie goes to the book nominated first - and says so', () => {
  let c = club();
  const nom = (cur, mid, title, nid, ms) => C.applyPatch(cur, C.nominate(cur, mid, { title, author: 'X' }, nid, NOW + ms).patch);
  c = nom(c, 'mbo', 'Frankenstein', 'nfra', 1);
  c = nom(c, 'mcy', 'Middlemarch', 'nmid', 2);
  c = nom(c, 'mdee', 'The Moonstone', 'nmoo', 3);
  assert.throws(() => nom(c, 'mana', 'the  moonstone', 'nx', 4), /already on the list/);
  assert.throws(() => C.nominate(nom(c, 'mbo', 'Persuasion', 'nper', 5), 'mbo', { title: 'Emma' }, 'nem', NOW), /nominated 2/);
  const vote = (cur, mid, picks) => C.applyPatch(cur, C.approve(cur, mid, picks).patch);
  assert.strictEqual(C.tally(c).line, 'No votes yet.');
  c = vote(c, 'mana', ['nmoo', 'nfra', 'nfra', 'bogus']);
  assert.deepStrictEqual(c.vote.ballots.mana, ['nmoo', 'nfra'], 'repeats and unknown ids dropped');
  c = vote(c, 'mbo', ['nmid', 'nmoo']);
  c = vote(c, 'mcy', ['nfra']);
  let t = C.tally(c);
  assert.deepStrictEqual(t.rows.map((r) => [r.id, r.votes]), [['nfra', 2], ['nmoo', 2], ['nmid', 1]]);
  assert.strictEqual(t.line, 'Frankenstein and The Moonstone tied on 2 votes - Frankenstein wins the tie because it was nominated first.');
  assert.deepStrictEqual([t.winner, t.tied, t.voters], ['nfra', ['nfra', 'nmoo'], 3]);
  c = vote(c, 'mdee', ['nmoo']);
  t = C.tally(c);
  assert.deepStrictEqual([t.winner, t.line], ['nmoo', 'The Moonstone wins with 3 votes from 4 voters.']);
  // A ballot from someone no longer in the club does not count.
  const gone = C.applyPatch(c, { set: {}, del: ['members.mdee'] });
  assert.strictEqual(C.tally(gone).winner, 'nfra');
  // Taking a book off takes it off every ballot.
  const off = C.unnominate(c, 'mdee', 'nmoo');
  assert.deepStrictEqual(off.patch.set, { 'vote.ballots.mana': ['nfra'], 'vote.ballots.mbo': ['nmid'], 'vote.ballots.mdee': [] });
  assert.throws(() => C.unnominate(c, 'mbo', 'nmoo'), (e) => e.status === 403, 'only its nominator or the host');
  assert.doesNotThrow(() => C.unnominate(c, 'mana', 'nmoo'), 'the host can');
  // Closing freezes the count; the view hides others' ballots until then.
  const open = C.memberView(c, [], 'mbo', { today: TODAY });
  assert.deepStrictEqual(open.vote.mine, ['nmid', 'nmoo']);
  assert.ok(open.vote.noms.every((n) => n.votes === null), 'no counts while the vote is open');
  assert.ok(!JSON.stringify(open).includes('"ballots"'));
  assert.deepStrictEqual([open.vote.voted, open.vote.of], [4, 4]);
  c = C.applyPatch(c, C.closeVote(c, NOW).patch);
  const shut = C.memberView(c, [], 'mbo', { today: TODAY });
  assert.deepStrictEqual(shut.vote.noms.map((n) => n.votes), [2, 1, 3]);
  assert.strictEqual(shut.vote.closed.line, 'The Moonstone wins with 3 votes from 4 voters.');
  assert.throws(() => C.approve(c, 'mbo', ['nfra']), (e) => e.status === 409, 'no votes after the close');
  assert.throws(() => C.closeVote(club(), NOW), /Nobody has voted/);
});

test('the shelf: the winner becomes the book, the old one is shelved with its ratings and where everyone got to; bookmarks and the vote start again; the oldest past 40 drops', () => {
  let c = at(at(club(), 'mana', { done: true }), 'mbo', 14);
  c = C.applyPatch(c, C.rate(c, 'mana', 'bfrank', 5).patch);
  c = C.applyPatch(c, C.rate(c, 'mbo', 'bfrank', 4).patch);
  c = C.applyPatch(c, C.rate(c, 'mcy', 'bfrank', 4).patch);
  assert.deepStrictEqual(C.average(c.book.ratings), { avg: 4.3, n: 3 });
  assert.deepStrictEqual(C.average({ a: 5, b: 4, c: 4, d: 3, e: 5, f: 4 }), { avg: 4.2, n: 6 });
  assert.deepStrictEqual(C.average({}), { avg: null, n: 0 });
  assert.throws(() => C.rate(c, 'mana', 'bfrank', 6), /1 to 5/);
  assert.throws(() => C.rate(c, 'mana', 'nope', 3), (e) => e.status === 404);
  c = C.applyPatch(c, C.addMeeting(c, 'mana', { date: '2026-11-20', upTo: 12 }, 'tm1', { now: NOW, today: TODAY }).patch);
  c = C.applyPatch(c, C.nominate(c, 'mbo', { title: 'Middlemarch', author: 'George Eliot', chapters: 86 }, 'nmid', NOW).patch);
  c = C.applyPatch(c, C.approve(c, 'mcy', ['nmid']).patch);
  assert.throws(() => C.startNext(c, {}, { today: TODAY, bookId: 'bnext' }), /Close the vote first/);
  c = C.applyPatch(c, C.closeVote(c, NOW).patch);
  const r = C.startNext(c, {}, { today: TODAY, bookId: 'bmid' });
  const n = C.applyPatch(c, r.patch);
  assert.deepStrictEqual([n.book.id, n.book.title, n.book.chapters, n.book.started], ['bmid', 'Middlemarch', 86, TODAY]);
  assert.deepStrictEqual(n.shelf.bfrank.ratings, { mana: 5, mbo: 4, mcy: 4 });
  assert.deepStrictEqual(n.shelf.bfrank.final, { mana: 20, mbo: 14, mcy: 0, mdee: 0 });
  assert.ok(Object.values(n.members).every((m) => m.pos === 0 && m.done === false));
  assert.deepStrictEqual(n.vote, { noms: {}, ballots: {}, closed: null });
  assert.strictEqual(n.meetings.tm1.upTo, null, 'a planned meeting stays; its "read to" is cleared');
  const sv = C.memberView(n, [], 'mbo', { today: TODAY }).shelf[0];
  assert.deepStrictEqual([sv.title, sv.avg, sv.rated, sv.myRating, sv.readers], ['Frankenstein', 4.3, 3, 4, 1]);
  // The shelf keeps 40.
  let big = club();
  const shelf = {};
  for (let i = 1; i <= 40; i++) shelf['bold' + i] = { title: 'Old ' + i, order: i, ratings: {}, final: {}, chapters: 10 };
  big = C.applyPatch(big, { set: { shelf }, del: [] });
  const r2 = C.startNext(big, { book: { title: 'New one', chapters: 9 } }, { today: TODAY, bookId: 'bnew' });
  assert.deepStrictEqual(r2.dropped, ['bold1']);
  const after = C.applyPatch(big, r2.patch);
  assert.strictEqual(Object.keys(after.shelf).length, 40);
  assert.ok(!after.shelf.bold1 && after.shelf.bfrank);
});

test('members: joining numbers a repeated name; a full club refuses; leaving or being removed takes the seat, ballot, nominations, RSVPs and ratings; the host hands over', () => {
  let c = club();
  const j = C.join(c, { mid: 'mbo2', name: 'bo', emoji: 'nope' }, NOW);
  assert.strictEqual(j.name, 'bo 2');
  assert.strictEqual(j.patch.set['members.mbo2'].emoji, C.EMOJI[0]);
  assert.throws(() => C.join(c, { mid: 'mx', name: '1234' }, NOW), /first name/);
  let full = c;
  for (let i = C.memberCount(c); i < C.LIMITS.members; i++) full = C.applyPatch(full, C.join(full, { mid: 'mz' + i, name: 'Reader', emoji: C.EMOJI[1] }, NOW).patch);
  assert.strictEqual(C.memberCount(full), 30);
  assert.throws(() => C.join(full, { mid: 'mlast', name: 'Late' }, NOW), (e) => e.status === 409);
  c = C.applyPatch(c, C.nominate(c, 'mbo', { title: 'Emma' }, 'nemma', NOW).patch);
  c = C.applyPatch(c, C.nominate(c, 'mbo', { title: 'Persuasion' }, 'npers', NOW + 1).patch);
  c = C.applyPatch(c, C.approve(c, 'mcy', ['nemma', 'npers']).patch);
  c = C.applyPatch(c, C.approve(c, 'mbo', ['nemma']).patch);
  c = C.applyPatch(c, C.addMeeting(c, 'mana', { date: '2026-11-20' }, 'tm', { now: NOW, today: TODAY }).patch);
  c = C.applyPatch(c, C.rsvp(c, 'mbo', 'tm', 'yes').patch);
  c = C.applyPatch(c, C.rate(c, 'mbo', 'bfrank', 3).patch);
  const r = C.removeMember(c, 'mbo');
  assert.deepStrictEqual(r.patch.del.sort(), ['book.ratings.mbo', 'meetings.tm.rsvps.mbo', 'members.mbo', 'vote.ballots.mbo', 'vote.noms.nemma', 'vote.noms.npers'].sort());
  assert.deepStrictEqual(r.patch.set, { 'vote.ballots.mcy': [] }, 'both nominations leave the other ballots at once');
  const out = C.applyPatch(c, r.patch);
  assert.ok(!JSON.stringify(out).includes('mbo'), 'nothing of theirs is left in the club');
  assert.throws(() => C.handOver(c, 'mbo', 'mcy'), (e) => e.status === 403);
  const h = C.applyPatch(c, C.handOver(c, 'mana', 'mcy').patch);
  assert.deepStrictEqual([C.isHost(h, 'mana'), C.isHost(h, 'mcy'), C.hostId(h)], [false, true, 'mcy']);
  assert.throws(() => C.rename(c, 'mbo', { name: 'Cy' }), /already goes by/);
});

/* ================================================================== *
 * Meetups and the .ics
 * ================================================================== */

test('meetups: a day not in the past, a time, a place, an https call link only, "read to" inside the book; RSVP yes / maybe / no; eight kept', () => {
  const c = club();
  assert.throws(() => C.cleanMeeting({ date: '2026-11-05' }, c, TODAY), /passed/);
  assert.throws(() => C.cleanMeeting({ date: '2026-02-30' }, c, TODAY), /Pick a day/);
  assert.throws(() => C.cleanMeeting({ date: '2026-11-12', time: '7pm' }, c, TODAY), /19:30/);
  assert.throws(() => C.cleanMeeting({ date: '2026-11-12', link: 'http://call.example.org/x' }, c, TODAY), /https/);
  assert.throws(() => C.cleanMeeting({ date: '2026-11-12', upTo: 21 }, c, TODAY), /1 to 20/);
  assert.deepStrictEqual(C.cleanMeeting({ date: '2026-11-12', time: '19:30', place: '<b>Bo’s</b> kitchen', link: 'https://call.example.org/x', upTo: 20 }, c, TODAY), { date: '2026-11-12', time: '19:30', place: 'Bo’s kitchen', link: 'https://call.example.org/x', upTo: null });
  let m = c;
  for (let i = 0; i < 8; i++) m = C.applyPatch(m, C.addMeeting(m, 'mana', { date: C.addDays(TODAY, i + 1) }, 'tm' + i, { now: NOW, today: TODAY }).patch);
  assert.throws(() => C.addMeeting(m, 'mana', { date: '2026-12-30' }, 'tx', { now: NOW, today: TODAY }), /8 meetings/);
  assert.strictEqual(C.addMeeting(m, 'mana', { date: '2026-12-30' }, 'tx', { now: NOW, today: C.addDays(TODAY, 3) }).patch.del[0], 'meetings.tm0', 'past ones make room');
  assert.deepStrictEqual(C.rsvp(m, 'mbo', 'tm1', 'maybe').patch.set, { 'meetings.tm1.rsvps.mbo': 'maybe' });
  assert.throws(() => C.rsvp(m, 'mbo', 'tm1', 'sure'), (e) => e.status === 400);
  assert.strictEqual(C.nextMeeting(m, C.addDays(TODAY, 2)).id, 'tm1');
  assert.strictEqual(C.mapLink('Bo’s kitchen, Elm St'), 'https://www.google.com/maps/search/?api=1&query=Bo%E2%80%99s%20kitchen%2C%20Elm%20St');
});

test('the .ics: floating local time (no TZID, no Z), or the exact instant in UTC for someone in another zone - DST-safe; escaped, folded, CRLF, a stable UID', () => {
  const c = club();
  const m = { id: 'tmeet', date: '2026-11-12', time: '19:00', place: 'Bo’s kitchen; back door, ring twice', link: 'https://call.example.org/abc', upTo: 10 };
  const ics = C.meetingIcs(c, m, { nowMs: NOW, viewerTz: 'America/New_York' });
  assert.ok(ics.includes('\r\nDTSTART:20261112T190000\r\n'), 'floating');
  assert.ok(!/TZID|DTSTART:[0-9T]+Z/.test(ics));
  assert.ok(ics.includes('UID:chapter-clubAAAAAAAAAAAA-tmeet@chapter'));
  assert.ok(ics.includes('LOCATION:Bo’s kitchen\\; back door\\, ring twice'));
  assert.ok(ics.replace(/\r\n /g, '').includes('DESCRIPTION:Read to chapter 10 of Frankenstein by Mary Shelley.\\nCall: https://call.example.org/abc\\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n') && !/[^\r]\n/.test(ics), 'CRLF only');
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, `folded: ${l}`);
  // Someone in Denver saving a New York club's 7 PM call: 7 PM EST = 00:00 UTC (after the clock change)...
  assert.ok(C.meetingIcs(c, m, { nowMs: NOW, viewerTz: 'America/Denver' }).includes('DTSTART:20261113T000000Z'));
  // ...and 7 PM EDT in July = 23:00 UTC.
  assert.ok(C.meetingIcs(c, Object.assign({}, m, { date: '2026-07-09' }), { nowMs: NOW, viewerTz: 'Europe/London' }).includes('DTSTART:20260709T230000Z'));
  assert.strictEqual(new Date(C.zonedMs('2026-03-08', '02:30', 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z', 'a skipped hour lands an hour later');
  assert.strictEqual(C.localDay(Date.parse('2026-11-07T03:30:00Z'), 'America/Los_Angeles'), '2026-11-06');
  const allDay = C.meetingIcs(c, { id: 'tx', date: '2026-12-31', time: '' }, { nowMs: NOW });
  assert.ok(allDay.includes('DTSTART;VALUE=DATE:20261231') && allDay.includes('DTEND;VALUE=DATE:20270101'));
  const hostile = C.meetingIcs(Object.assign({}, c, { name: 'A\r\nBEGIN:VEVENT\u202E' }), { id: 'x', date: '2026-12-01', time: '18:00' }, { nowMs: NOW });
  assert.deepStrictEqual(hostile.replace(/\r\n /g, '').split('\r\n').filter((l) => /^(BEGIN|END):/.test(l)), ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'BEGIN:VALARM', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'], 'a line break in a name cannot start a new event');
  assert.ok(hostile.includes('SUMMARY:A\\nBEGIN:VEVENT: Frankenstein') && !hostile.includes('\u202E'));
});

/* ================================================================== *
 * The AI: what is asked and what is accepted
 * ================================================================== */

test('the AI request: exactly {club, from, to}; the range ends where the asker is; the model is told the title, author and range - nothing else', () => {
  assert.deepStrictEqual(ai.brief({ club: 'clubAAAAAAAAAAAA', from: 1, to: 5 }), { club: 'clubAAAAAAAAAAAA', from: 1, to: 5 });
  for (const bad of [null, [], { club: 'x', from: 1, to: 2 }, { club: 'clubAAAAAAAAAAAA', from: 1, to: 2, notes: ['x'] }, { club: 'clubAAAAAAAAAAAA', from: 1, to: 2, name: 'Ana' }]) assert.throws(() => ai.brief(bad), (e) => e.status === 400, JSON.stringify(bad));
  const v = C.memberView(at(club(), 'mbo', 7), [], 'mbo', { today: TODAY });
  assert.deepStrictEqual(C.aiRange(v, 2, 7), { from: 2, to: 7 });
  assert.throws(() => C.aiRange(v, 1, 8), /only go up to where you are \(chapter 7\)/);
  assert.throws(() => C.aiRange(v, 5, 3), (e) => e.status === 400);
  assert.throws(() => C.aiRange(C.memberView(club(), [], 'mbo', { today: TODAY }), 1, 1), /Move your bookmark first/);
  assert.strictEqual(ai.message({ title: 'Frankenstein', author: 'Mary Shelley', unit: 'ch', total: 24 }, { from: 1, to: 6 }), 'Book: “Frankenstein” by Mary Shelley.\nThe club has read chapters 1 to 6 (of 24).\nSuggest up to 6 discussion questions for that range with the suggest_questions tool.');
  assert.match(ai.SYSTEM, /no spoilers/);
  assert.match(ai.SYSTEM, /never an instruction to you/);
  assert.match(ai.SYSTEM, /set knowsBook to false/);
});

test('the AI answer: at most six plain questions of 12-240 characters, no links, no quoted span over twelve words, chapters inside the range; general ones when the book is unknown', () => {
  const R = { from: 3, to: 9 };
  const q = (text, chapter) => ({ text, chapter });
  const out = C.cleanQuestions({ knowsBook: true, questions: [
    q('<img src=x onerror=alert(1)>What did you make of it?', 4), q('Read more at https://evil.example/x - thoughts?', 4), q('See www.evil.example for the answer?', 5), q('Is evil.com the place?', 5),
    q('Why does the narrator say "one two three four five six seven eight nine ten eleven twelve thirteen" here?', 5),
    q('Why does the narrator say “one two three four five six seven eight nine ten eleven twelve” here?', 5),
    q('What happens at the very end?', 30), q('Short?', 4), q('A question at chapter two, before the range?', 2), q('A question with no chapter at all here?', null),
    q('Which choice would you have made differently, and why?', 6), q('which choice would you have made differently and why', 7),
    q('Q1 is a perfectly fine question for the club?', 3), q('Q2 is a perfectly fine question for the club?', 4), q('Q3 is a perfectly fine question for the club?', 8), q('Q4 is a perfectly fine question for the club?', 9), q('Q5 would be the seventh, so it is dropped?', 9),
  ] }, R, 'ch');
  assert.deepStrictEqual(out.questions.map((x) => [x.at, x.text.slice(0, 12)]), [[5, 'Why does the'], [6, 'Which choice'], [3, 'Q1 is a perf'], [4, 'Q2 is a perf'], [8, 'Q3 is a perf'], [9, 'Q4 is a perf']]);
  assert.strictEqual(out.knowsBook, true);
  assert.strictEqual(C.longestQuote('He said “a b c” then "d e f g"'), 4);
  assert.strictEqual(C.longestQuote('An open “quote with five whole words'), 5);
  assert.strictEqual(C.longestQuote('It’s Jo’s choice'), 0, 'apostrophes are not quotes');
  const unknown = C.cleanQuestions({ knowsBook: false, questions: [q('What would you ask the author about these chapters?', 99)] }, R, 'ch');
  assert.deepStrictEqual([unknown.knowsBook, unknown.questions[0].at], [false, 3], 'general questions sit at the start of the range');
  assert.strictEqual(C.cleanQuestions({ knowsBook: true, questions: [q('A question about the first hundred pages?', 1)] }, { from: 1, to: 120 }, 'pg').questions[0].at, 120, 'a page book: at the end of the range');
  assert.deepStrictEqual(C.cleanQuestions({ knowsBook: 'yes', questions: 'lots' }, R, 'ch'), { knowsBook: false, questions: [] });
  assert.deepStrictEqual(C.cleanQuestions(null, R, 'ch').questions, []);
});

/* ================================================================== *
 * The made-up club
 * ================================================================== */

test('the made-up club: Pride and Prejudice (public domain), six invented readers at different places, four notes locked past chapter 18, a vote that ties when you vote, a shelf averaging 4.2', () => {
  const d = C.demo(TODAY);
  const v = C.memberView(d.club, d.notes, d.you, { today: TODAY, locale: 'en-US' });
  assert.deepStrictEqual([v.book.title, v.book.author, v.book.total], ['Pride and Prejudice', 'Jane Austen', 61]);
  assert.deepStrictEqual(v.members.map((m) => m.name).sort(), ['Alex', 'Jordan', 'Maya', 'Priya', 'Sam', 'Theo']);
  assert.strictEqual(new Set(v.board.rows.map((r) => r.pos)).size, 6, 'everyone at a different place');
  assert.ok(v.board.rows.some((r) => r.line === 'Maya is 3 chapters ahead of you'));
  assert.strictEqual(C.lockedLine(v.locked, d.club.book), '4 notes waiting past chapter 18');
  assert.strictEqual(v.board.nudge.kind, 'behind');
  assert.strictEqual(v.meetings.length, 1);
  assert.strictEqual(C.dayDiff(TODAY, v.meetings[0].date) >= 5 && new Date(v.meetings[0].date + 'T00:00:00Z').getUTCDay(), 4, 'a Thursday at least five days out');
  assert.strictEqual(v.shelf[0].title, 'Jane Eyre');
  assert.strictEqual(v.shelf[0].avg, 4.2);
  assert.strictEqual(v.vote.voted, 5);
  const tied = C.tally(C.applyPatch(d.club, C.approve(d.club, d.you, ['nmoon']).patch));
  assert.match(tied.line, /wins the tie because it was nominated first/);
  // Everything in it is already clean, and no note quotes the book.
  for (const m of Object.values(d.club.members)) assert.strictEqual(C.cleanName(m.name), m.name);
  for (const n of d.notes) {
    assert.strictEqual(C.para(n.text, 500), n.text);
    assert.ok(C.longestQuote(n.text) === 0 && !/["\u201c\u201d]/.test(n.text), `a note quotes something: ${n.text}`);
    assert.ok(n.at >= 1 && n.at <= 61);
  }
  for (const nm of Object.values(d.club.vote.noms)) assert.strictEqual(C.plain(nm.why, 120), nm.why);
  assert.ok(Object.values(d.club.vote.noms).every((n) => ['Frankenstein', 'Middlemarch', 'The Moonstone', 'Little Women'].includes(n.title)), 'public-domain classics only');
  assert.ok(Object.values(d.club.shelf).every((s) => ['Jane Eyre', 'The Hound of the Baskervilles', 'The Picture of Dorian Gray'].includes(s.title)));
  assert.deepStrictEqual(C.demo(TODAY), C.demo(TODAY), 'the same every time - no dice');
});

/* ================================================================== *
 * The page's own promises
 * ================================================================== */

test('every text colour holds 4.5:1 on its surface in both themes; the hero, the mock, the share card and the lab card too; 44px targets; nothing scrolls sideways', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2', 'bar-bg', 'face']) for (const fg of ['text', 'muted', 'link', 'star']) ok(fg, bg);
    ok('accent-ink', 'accent'); for (const fg of ['text', 'link', 'muted']) ok(fg, 'accent-soft');
    for (const k of ['ok', 'warn', 'lock', 'q']) { ok(k, `${k}-bg`); ok('text', `${k}-bg`); ok('muted', `${k}-bg`); }
    for (const fg of ['hero-ink', 'hero-soft']) for (const bg of ['hero-1', 'hero-2']) ok(fg, bg);
    ok('accent', 'card'); ok('accent', 'bg'); ok('q', 'card'); ok('lock', 'card'); ok('warn', 'warn-bg');
  }
  // Colours written as literals: the hero's buttons, the mock card, the share card.
  for (const [fg, bg] of [['#5b2a6e', '#ffffff'], ['#ffffff', '#5b2a6e'], ['#ffffff', '#7a4a1c'], ['#f6e9f7', '#5b2a6e'], ['#f6e9f7', '#7a4a1c'], ['#1f1a16', '#f3e6f5'], ['#5c5246', '#f3e6f5'], ['#1f1a16', '#ffffff'], ['#3f3a52', '#e9e6f0'], ['#7c4a03', '#fdf0cf']]) {
    assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}: ${ratio(fg, bg).toFixed(2)}`);
  }
  const lab = require('../../../lab').get('chapter');
  assert.ok(lab && ratio('#ffffff', lab.color) >= 4.5 && ratio('#ffffff', lab.color2) >= 4.5, 'the lab card colours hold white text');
  assert.ok(lab.dropped === '2026-11-06' && lab.status === 'testing' && lab.features.length === 4);
  for (const sel of ['.btn', '.btn.small', '.link-btn', '.seg button, .chip', '.input, select.input, textarea.input', '.check', 'details.more > summary', '.approve', '.crow', '.emojis button', '.stepper button', '.rsvp button']) {
    assert.ok(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*(min-height|height): (4[4-9]|[5-9]\\d)px').test(css), `${sel}: 44px`);
  }
  assert.ok(/\.tabbar button \{[^}]*min-height: 60px/.test(css) && /\.rate button \{ width: 44px; height: 44px/.test(css) && /\.reacts button \{[^}]*min-height: 44px; min-width: 44px/.test(css));
  assert.ok(/body \{[^}]*overflow-x: hidden/.test(css));
  assert.ok(/prefers-reduced-motion: reduce[\s\S]*animation: none !important; transition: none !important/.test(css));
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, every received string escaped, only the listed API paths, what the AI sheet sends', () => {
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
  assert.ok(!/sessionStorage|indexedDB|document\.cookie/.test(js), 'the member key is an HttpOnly cookie the page never reads');
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  const calls = [...new Set([...js.matchAll(/api\('(GET|POST|PUT|PATCH|DELETE)', '([^']+)'/g)].map((m) => m[2]))].sort();
  assert.deepStrictEqual(calls, ['api/account/clubs', 'api/account/clubs/', 'api/ai/questions', 'api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/c/', 'api/clubs', 'api/join/', 'api/me', 'api/move'].sort(), 'the page asks for nothing else');
  assert.match(js, /api\('POST', 'api\/ai\/questions', \{ club: v\.id, from: r\.from, to: r\.to \}\)/, 'the AI request is the club and a range');
  assert.match(js, /<b>Nothing else<\/b> - no names, no notes, nothing anyone in the club wrote\./, 'the AI sheet says what is never sent');
  assert.match(js, /AI-written - check before the meeting/);
  assert.match(js, /'#join=' \+ v\.code/, 'join links carry the code in the fragment, never sent to a server');
  assert.match(js, /'#move=' \+ d\.token/);
  assert.match(js, /You’re offline - this is the club as of/, 'offline, it says so and that writes need the network');
  assert.match(js, /Moving your bookmark, notes and votes need the internet\./);
  for (const f of ['public/index.html', 'public/app.js', 'public/chapter-core.js', 'server.js', 'lib/ai.js', 'lib/fakeai.js', 'lib/clubs.js', 'lib/store.js', 'CLAUDE.md']) assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read(f)), `no email address in ${f}`);
  const core = read('public/chapter-core.js');
  assert.ok(!/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.|indexedDB|WebSocket/.test(core), 'the core touches no network or storage');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  assert.ok(!/\(\?<[=!]/.test(core + js), 'no lookbehind (older iPhones cannot parse it)');
  // Every interpolation of something a member, the server or a model wrote goes through esc().
  const unesc = (src) => { let out = '', i = 0; for (;;) { const at2 = src.indexOf('esc(', i); if (at2 < 0) return out + src.slice(i); out += src.slice(i, at2) + 'ESC'; let depth = 0, j = at2 + 3; for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; } i = j + 1; } };
  const risky = unesc(js).split('\n').filter((l) => !/toast\(|say\(|confirm\(|copy\(|download\(|textContent|\.value = |fillText|fit\(g|wrap\(g|shareText\(|title: /.test(l)).join('\n')
    .match(/['"]\s*\+\s*(v\.name|v\.display|v\.book\.title|v\.book\.author|book\.title|book\.author|n\.text|n\.name|n\.by|n\.title|n\.author|n\.why|m\.name|m\.place|m\.link|r\.name|r\.line|q\.text|s\.title|s\.author|w\.title|p\.name|p\.book\.title|c\.name|name|sub|e\.message|err\.message|me\.email|me\.name|d\.msg|link|K\.url|when)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|\bbody\b|\btext\b|\bnote\b)/.test(read(f).replace(/`[^`]*`|'[^'\n]*'/g, "''")), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js') + read('lib/ai.js') + read('lib/clubs.js') + read('lib/store.js').replace(/setImmediate/g, '')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /chapter-shell-v1/.test(sw) && sw.includes("'chapter-core.js'") && /k\.indexOf\('chapter-'\) === 0/.test(sw), 'the service worker never answers api/ and only clears its own caches');
  assert.match(js, /navigator\.serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
  assert.match(js, /Intl\.getCanonicalLocales\(navigator\.language \|\| 'en-US'\)\[0\] \|\| 'en-US'; \} catch \(e\) \{ return 'en-US'; \}/, 'a locale Intl refuses (en-US@posix) falls back to en-US');
  assert.match(js, /var vb = document\.getElementById\('stc-verify-banner'\)/, 'sheets clear the confirm-your-email banner');
  assert.match(js, /setInterval\(function \(\) \{ if \(document\.visibilityState === 'visible'/, 'it re-asks while on screen');
  assert.match(js, /addEventListener\('visibilitychange'/, 'and when it comes back to the foreground');
});

test('the copy: neutral wording (no he/she/his/her), no invisible characters in any source file, no key-shaped strings', () => {
  const strings = (src) => [...src.matchAll(/'([^'\\\n]|\\.){3,}'|`[^`]{3,}`|"[^"\n]{3,}"/g)].map((m) => m[0]).join('\n');
  const all = strings(read('public/app.js')) + strings(read('public/chapter-core.js')) + read('public/index.html') + strings(read('server.js')) + strings(read('lib/ai.js')) + read('CLAUDE.md');
  const gendered = all.match(/\b(he|she|his|hers|him|himself|herself)\b|\bher\b/gi);
  assert.strictEqual(gendered, null, `gendered: ${gendered}`);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.name === 'node_modules' ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const f of walk(ROOT).filter((x) => /\.(js|css|html|md|json|svg|webmanifest)$/.test(x) && !/package-lock/.test(x))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(src), `${path.relative(ROOT, f)} carries an invisible character`);
    if (!/lib\/(identity|stripe|byok|webauthn)/.test(f)) assert.ok(!/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}|\bsk-ant-[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}/.test(src), `${path.relative(ROOT, f)} carries a key-shaped string`);
  }
});

test('local-only switches throw on Cloud Run; the lab prefix is read; every query is one equality filter', () => {
  for (const [mod, env] of [['./lib/store', { CHAPTER_MEMORY: '1' }], ['./lib/fakeai', { CHAPTER_FAKE_AI: '1' }], ['./server', { CHAPTER_FAKE_AI: '1', CHAPTER_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, CHAPTER_MEMORY: '', CHAPTER_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  const p = spawnSync(process.execPath, ['-e', "const s=require('./lib/store'); console.log(s.PREFIX, s.store.kind)"], { cwd: ROOT, env: { ...process.env, CHAPTER_MEMORY: '', CHAPTER_COLLECTION_PREFIX: 'chapter_' }, encoding: 'utf8' });
  assert.strictEqual(p.stdout.trim(), 'chapter_ firestore');
  assert.ok((read('lib/store.js').match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual([...new Set(server.match(/store\.list\([^)]*\)/g))].sort(), [
    "store.list('clubs', { where: [['code', '==', c]], limit: 1 })",
    "store.list('clubs', { where: [['code', '==', code]], limit: 1 })",
    "store.list('notes', { where: [['club', '==', clubId]] })",
    "store.list('notes', { where: [['club', '==', id]] })",
  ], 'single-field equality only: no composite index');
  assert.deepStrictEqual([...new Set(server.match(/store\.\w+\('(\w+)'/g).map((s) => s.replace(/store\.\w+\(/, '')))].sort(), ["'accounts'", "'clubs'", "'notes'"], 'three collections');
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
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, 'X-Today': realToday(), ...(cookie ? { Cookie: cookie } : {}), ...headers },
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
const realToday = () => new Date().toISOString().slice(0, 10);
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
const BIG = { x: 'x'.repeat(64 * 1024) };
const BOOK = { title: 'Frankenstein', author: 'Mary Shelley', chapters: 24 };
async function newClub(host, extra) {
  const r = await host('POST', '/api/clubs', Object.assign({ name: 'Elm Street Readers', you: { name: 'Ana', emoji: '\u{1F989}' }, book: BOOK, tz: 'America/New_York' }, extra || {}));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function joinAs(c, code, name, emoji) {
  const r = await c('POST', `/api/join/${code}`, { name, emoji: emoji || '\u{1F41D}' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

test('signed out: the page works with zero model calls; strict headers; the AI route answers 401 before reading a body; there is no route that takes anything else', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  for (const f of ['chapter-core.js', 'app.js', 'app.css', 'qr.js', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/ai/questions', { club: 'a'.repeat(16), from: 1, to: 2 })).status, 401);
  assert.strictEqual((await anon('POST', '/api/ai/questions', BIG)).status, 401, 'the gate answers before the parser, so never 413');
  assert.strictEqual((await anon('GET', '/api/account/clubs')).status, 401);
  assert.strictEqual((await anon('POST', '/api/clubs', BIG)).status, 413, 'everything else keeps a small limit');
  for (const p of ['/api/notes', '/api/clubs/list', '/api/upload', '/api/sync']) assert.strictEqual((await anon('POST', p, {})).status, 404, p);
  // A whole club with no account at all.
  const made = await newClub(anon);
  assert.strictEqual((await anon('PUT', `/api/c/${made.id}/progress`, { pos: 3 })).status, 200);
  assert.strictEqual((await anon('POST', `/api/c/${made.id}/notes`, { text: 'Lovely start', at: 2 })).status, 200);
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('writes come from this page: another site, another origin or a non-JSON body is refused before anything happens', async () => {
  const a = client();
  const made = await newClub(a);
  assert.strictEqual((await a('PUT', `/api/c/${made.id}/progress`, { pos: 2 }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await a('PUT', `/api/c/${made.id}/progress`, { pos: 2 }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await a('PUT', `/api/c/${made.id}/progress`, 'pos=2', { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await a('PUT', `/api/c/${made.id}/progress`, { pos: 2 }, { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
});

test('the gates come before the AI route\u2019s parser, in order; one model call site; one door; Haiku free, Sonnet members via planFor', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/ai/questions', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  for (const [p, m] of [['/api/account/clubs', 'get'], ['/api/account/clubs/:id', 'put'], ['/api/account/clubs/:id', 'delete']]) assert.strictEqual(layer(p, m).route.stack[0].handle.name, 'requireUser', `${m} ${p}`);
  const src = read('server.js');
  assert.strictEqual((src.match(/ai\.ask\(/g) || []).length, 1, 'one place the server asks a model');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to a client');
  assert.strictEqual((read('lib/ai.js').match(/\.messages\.create\(/g) || []).length, 1, 'one client call site');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  assert.match(src, /req\.path === '\/api\/ai\/questions' \? next\(\) : smallJson/, 'the global parser skips the AI route');
});

test('start, join and the member key: an HttpOnly cookie on the app\u2019s path, stored only as a per-club hash; joining twice is the same seat; a name twice gets a number', async () => {
  const a = client(), b = client();
  const made = await newClub(a);
  const set = a.raw.find((c) => c.startsWith('chapter_k='));
  assert.ok(set && /HttpOnly/.test(set) && /SameSite=Lax/.test(set) && /Path=\/chapter\//.test(set), set);
  assert.ok(C.isCode(made.club.code) && made.club.display === C.formatCode(made.club.code));
  const pre = await b('GET', `/api/join/${made.club.code.toLowerCase().replace(/(...)/, '$1-')}`);
  assert.deepStrictEqual([pre.status, pre.data.name, pre.data.members, pre.data.already], [200, 'Elm Street Readers', 1, null], 'typed however');
  assert.ok(!JSON.stringify(pre.data).includes('Ana'), 'a code shows the club, not who is in it');
  const j1 = await joinAs(b, made.club.code, 'Ana');
  const j2 = await joinAs(b, made.club.code, 'Someone else');
  assert.deepStrictEqual([j1.isNew, j2.isNew, j2.me], [true, false, j1.me], 'the same browser is the same seat');
  const v = (await b('GET', `/api/c/${made.id}`)).data.club;
  assert.deepStrictEqual(v.members.map((m) => m.name), ['Ana', 'Ana 2']);
  assert.strictEqual(v.you, j1.me);
  const doc = await store.get('clubs', made.id);
  const keyA = a.cookies.chapter_k;
  assert.ok(!JSON.stringify(doc).includes(keyA), 'the raw key is never stored');
  assert.strictEqual(Object.values(doc.members).find((m) => m.host).keyHash, K.keyHash(keyA, made.id));
  const other = await newClub(a);
  const doc2 = await store.get('clubs', other.id);
  assert.notStrictEqual(Object.values(doc2.members)[0].keyHash, Object.values(doc.members).find((m) => m.host).keyHash, 'one phone cannot be linked across clubs');
  for (const r of [made.club, v]) assert.ok(!/keyHash|acct|"move"|"hash"/.test(JSON.stringify(r)), 'the view never carries a key hash, an account tag or a move secret');
});

test('the server never sends a locked note\u2019s text: not in the club, not in a poll, not to react to or remove - until that reader gets there', async () => {
  const a = client(), b = client();
  const made = await newClub(a);
  await joinAs(b, made.club.code, 'Bo');
  await a('PUT', `/api/c/${made.id}/progress`, { pos: 12 });
  const posted = await a('POST', `/api/c/${made.id}/notes`, { text: 'SECRET-TWIST at the lake', at: 11 });
  await a('POST', `/api/c/${made.id}/notes`, { kind: 'question', text: 'SECRET-QUESTION about the letter?', at: 12 });
  await a('POST', `/api/c/${made.id}/notes`, { text: 'Opening thought', at: 1 });
  assert.strictEqual(posted.status, 200);
  assert.strictEqual((await a('POST', `/api/c/${made.id}/notes`, { text: 'Too far ahead', at: 13 })).status, 400, 'no tag past your own bookmark');
  await b('PUT', `/api/c/${made.id}/progress`, { pos: 3 });
  for (const r of [await b('GET', `/api/c/${made.id}`), await b('GET', `/api/c/${made.id}?since=0`), await b('PUT', `/api/c/${made.id}/progress`, { pos: 3 })]) {
    assert.ok(!/SECRET/.test(r.text), 'a locked note reached a reader before its chapter');
    assert.deepStrictEqual(r.data.club.locked, { total: 2, chapters: [[11, 1], [12, 1]], after: 3 });
    assert.deepStrictEqual(r.data.club.notes.map((n) => n.text), ['Opening thought']);
  }
  const nid = posted.data.id;
  assert.strictEqual((await b('PUT', `/api/c/${made.id}/notes/${nid}/react`, { emoji: '\u{1F62E}' })).status, 404, 'a locked note cannot be reacted to');
  assert.strictEqual((await b('DELETE', `/api/c/${made.id}/notes/${nid}`)).status, 404);
  const up = await b('PUT', `/api/c/${made.id}/progress`, { pos: 11 });
  assert.ok(up.text.includes('SECRET-TWIST') && !up.text.includes('SECRET-QUESTION'), 'moving the bookmark opens exactly what it reaches');
  assert.strictEqual((await b('PUT', `/api/c/${made.id}/notes/${nid}/react`, { emoji: '\u{1F62E}' })).status, 200);
  assert.strictEqual((await b('DELETE', `/api/c/${made.id}/notes/${nid}`)).status, 403, 'only the author or the host removes a note');
  const done = await b('PUT', `/api/c/${made.id}/progress`, { done: true });
  assert.ok(done.text.includes('SECRET-QUESTION'));
  // The shelf keeps the rule, against where each reader had got to.
  await b('PUT', `/api/c/${made.id}/progress`, { pos: 2 });
  assert.strictEqual((await a('POST', `/api/c/${made.id}/next`, { book: { title: 'Persuasion', chapters: 24 } })).status, 200);
  const bid = (await a('GET', `/api/c/${made.id}`)).data.club.shelf[0].id;
  const sb = await b('GET', `/api/c/${made.id}/shelf/${bid}/notes`);
  assert.ok(!/SECRET/.test(sb.text) && sb.data.locked.total === 2 && sb.data.notes.length === 1, 'Bo stopped at chapter 2');
  assert.ok(/SECRET-TWIST/.test((await a('GET', `/api/c/${made.id}/shelf/${bid}/notes`)).text));
});

test('two phones, one club: ten bookmarks moved at once all stick, ten ballots at once all count, two reactions on one note both stick - and a plain read-change-write would lose one', async () => {
  const host = client();
  const made = await newClub(host);
  const ms = [];
  for (let i = 0; i < 10; i++) { const c = client(); await joinAs(c, made.club.code, `Reader ${String.fromCharCode(65 + i)}`); ms.push(c); }
  const rs = await Promise.all(ms.map((c, i) => c('PUT', `/api/c/${made.id}/progress`, { pos: i + 1 })));
  assert.ok(rs.every((r) => r.status === 200));
  const doc = await store.get('clubs', made.id);
  assert.deepStrictEqual(Object.values(doc.members).map((m) => m.pos).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await host('POST', `/api/c/${made.id}/noms`, { title: 'Middlemarch' });
  await ms[0]('POST', `/api/c/${made.id}/noms`, { title: 'Little Women' });
  const noms = (await host('GET', `/api/c/${made.id}`)).data.club.vote.noms;
  const votes = await Promise.all(ms.map((c, i) => c('PUT', `/api/c/${made.id}/ballot`, { picks: i % 3 ? [noms[0].id] : [noms[0].id, noms[1].id] })));
  assert.ok(votes.every((r) => r.status === 200));
  assert.strictEqual((await host('GET', `/api/c/${made.id}`)).data.club.vote.voted, 10);
  const closed = await host('POST', `/api/c/${made.id}/vote/close`, {});
  assert.strictEqual(closed.data.club.vote.closed.line, 'Middlemarch wins with 10 votes from 10 voters.');
  // Two reactions on one note at once.
  await host('PUT', `/api/c/${made.id}/progress`, { pos: 5 });
  const n = await host('POST', `/api/c/${made.id}/notes`, { text: 'A note to react to', at: 1 });
  await Promise.all([ms[3]('PUT', `/api/c/${made.id}/notes/${n.data.id}/react`, { emoji: '\u{1F602}' }), ms[4]('PUT', `/api/c/${made.id}/notes/${n.data.id}/react`, { emoji: '\u{1F914}' })]);
  assert.strictEqual(Object.keys((await store.get('notes', n.data.id)).reactions).length, 2);
  // Ten notes at once: one document each.
  const posts = await Promise.all(ms.map((c, i) => c('POST', `/api/c/${made.id}/notes`, { text: `Note number ${i}`, at: 1 })));
  assert.ok(posts.every((r) => r.status === 200));
  assert.strictEqual((await store.list('notes', { where: [['club', '==', made.id]] })).length, 11);
  // The same two writes without the transaction: one is lost.
  await Promise.all(['mA', 'mB'].map((mid) => store._unsafeUpdate('clubs', made.id, (cur) => { cur.members[Object.keys(cur.members)[mid === 'mA' ? 1 : 2]].pos = 99; delete cur.id; return cur; })));
  const lost = Object.values((await store.get('clubs', made.id)).members).filter((m) => m.pos === 99).length;
  assert.strictEqual(lost, 1, 'a plain read-change-write loses one of two');
});

test('host powers: only the host plans, edits, closes, starts the next book, removes, rotates the code or deletes; hosting can be handed over; a host must hand over before leaving', async () => {
  const a = client(), b = client(), c = client();
  const made = await newClub(a);
  const jb = await joinAs(b, made.club.code, 'Bo');
  const jc = await joinAs(c, made.club.code, 'Cy');
  const id = made.id;
  const meet = { date: C.addDays(realToday(), 7), time: '19:00', upTo: 12 };
  for (const [m, p, body] of [['POST', '/meetings', meet], ['PATCH', '/book', { chapters: 30 }], ['POST', '/vote/close', {}], ['POST', '/next', { book: { title: 'X', chapters: 3 } }], ['DELETE', `/members/${jc.me}`], ['POST', '/code', {}], ['DELETE', '']]) {
    assert.strictEqual((await b(m, `/api/c/${id}${p}`, body)).status, 403, `${m} ${p} by a reader`);
  }
  const planned = await a('POST', `/api/c/${id}/meetings`, meet);
  assert.strictEqual(planned.status, 200);
  const mt = planned.data.club.meetings[0].id;
  assert.strictEqual((await b('PUT', `/api/c/${id}/meetings/${mt}/rsvp`, { a: 'yes' })).data.club.meetings[0].rsvps.yes[0], 'Bo', 'anyone can RSVP');
  assert.strictEqual(planned.data.club.board.finish.at, 12, 'the meeting is the finish line');
  const oldCode = made.club.code;
  const rot = await a('POST', `/api/c/${id}/code`, {});
  assert.notStrictEqual(rot.data.club.code, oldCode);
  assert.strictEqual((await client()('GET', `/api/join/${oldCode}`)).status, 404, 'the old code is dead at once');
  assert.strictEqual((await b('GET', `/api/c/${id}`)).status, 200, 'members are unaffected');
  assert.strictEqual((await a('DELETE', `/api/c/${id}/me`)).status, 409, 'the host hands over first');
  const ho = await a('POST', `/api/c/${id}/host`, { to: jb.me });
  assert.deepStrictEqual([ho.data.club.host, ho.data.msg], [false, 'Bo hosts the club now.']);
  assert.strictEqual((await b('POST', `/api/c/${id}/code`, {})).status, 200, 'the new host has the powers');
  // Removing a member takes their notes and reactions too.
  await c('PUT', `/api/c/${id}/progress`, { pos: 5 });
  const cn = await c('POST', `/api/c/${id}/notes`, { text: 'CY-NOTE here', at: 2 });
  await b('PUT', `/api/c/${id}/progress`, { pos: 5 });
  const bn = await b('POST', `/api/c/${id}/notes`, { text: 'Bo note', at: 2 });
  await c('PUT', `/api/c/${id}/notes/${bn.data.id}/react`, { emoji: '\u{1F602}' });
  assert.strictEqual((await b('DELETE', `/api/c/${id}/members/${jc.me}`)).status, 200);
  assert.strictEqual(await store.get('notes', cn.data.id), null);
  assert.deepStrictEqual((await store.get('notes', bn.data.id)).reactions, {});
  assert.strictEqual((await c('GET', `/api/c/${id}`)).status, 404, 'a removed member is a stranger now');
  // Leaving as a reader, then the last reader leaving deletes the club.
  assert.strictEqual((await a('DELETE', `/api/c/${id}/me`)).status, 200);
  const last = await b('DELETE', `/api/c/${id}/me`);
  assert.deepStrictEqual([last.status, last.data.deleted], [200, true]);
  assert.strictEqual(await store.get('clubs', id), null);
  assert.strictEqual((await store.list('notes', { where: [['club', '==', id]] })).length, 0);
});

test('moving to another phone: a one-time link - the new phone takes the seat, the old one is out, a second claim and an expired one fail, two claims at once give one seat', async () => {
  const a = client(), host = client();
  const made = await newClub(host);
  const ja = await joinAs(a, made.club.code, 'Ana');
  const mv = await a('POST', `/api/c/${made.id}/move`, {});
  assert.strictEqual(mv.status, 200);
  assert.match(mv.data.token, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/);
  const doc = await store.get('clubs', made.id);
  assert.ok(!JSON.stringify(doc).includes(mv.data.token.split('.')[1]), 'the secret itself is never stored');
  const p1 = client(), p2 = client();
  const [r1, r2] = await Promise.all([p1('POST', '/api/move', { token: mv.data.token }), p2('POST', '/api/move', { token: mv.data.token })]);
  assert.deepStrictEqual([r1.status, r2.status].sort(), [200, 404], 'one claim wins');
  const winner = r1.status === 200 ? p1 : p2;
  const loser = r1.status === 200 ? p2 : p1;
  assert.strictEqual((await winner('GET', `/api/c/${made.id}`)).data.club.you, ja.me, 'the same seat, on the new phone');
  assert.strictEqual((await a('GET', `/api/c/${made.id}`)).status, 404, 'the old phone is out');
  assert.strictEqual((await loser('POST', '/api/move', { token: mv.data.token })).status, 404, 'single use');
  // An expired link.
  const mv2 = await winner('POST', `/api/c/${made.id}/move`, {});
  await store.transactKeys('clubs', made.id, () => ({ set: { [`members.${ja.me}.move.exp`]: new Date(Date.now() - 1000).toISOString() }, del: [] }));
  const late = await client()('POST', '/api/move', { token: mv2.data.token });
  assert.strictEqual(late.status, 404);
  assert.match(late.data.error, /used or has expired/);
  assert.ok(!(await store.get('clubs', made.id)).members[ja.me].move, 'an expired link is cleared by the read that finds it');
  for (const bad of ['', 'nonsense', 'x'.repeat(39), `${made.id}.${'A'.repeat(22)}`]) assert.strictEqual((await client()('POST', '/api/move', { token: bad })).status, 404, bad);
});

test('the same 404, word for word, for an unknown club, an expired one and one that is not yours; a club nobody opens for 120 days is deleted by the read that finds it', async () => {
  const a = client(), stranger = client();
  const made = await newClub(a);
  await a('PUT', `/api/c/${made.id}/progress`, { pos: 4 });
  await a('POST', `/api/c/${made.id}/notes`, { text: 'Will be gone', at: 2 });
  const unknown = await stranger('GET', '/api/c/AAAAAAAAAAAAAAAA');
  const notMine = await stranger('GET', `/api/c/${made.id}`);
  const junk = await stranger('GET', '/api/c/not-an-id');
  for (const p of ['/progress', '/notes', '/ballot']) assert.strictEqual((await stranger(p === '/notes' ? 'POST' : 'PUT', `/api/c/${made.id}${p}`, { pos: 1, text: 'x', at: 1 })).status, 404);
  await store.merge('clubs', made.id, { updatedAt: new Date(Date.now() - 121 * 86400000).toISOString() });
  const expired = await a('GET', `/api/c/${made.id}`);
  for (const r of [unknown, notMine, junk, expired]) assert.strictEqual(r.status, 404);
  assert.strictEqual(new Set([unknown, notMine, junk, expired].map((r) => r.data.error)).size, 1, 'one sentence for all four');
  assert.strictEqual(await store.get('clubs', made.id), null);
  assert.strictEqual((await store.list('notes', { where: [['club', '==', made.id]] })).length, 0, 'and its notes with it');
  assert.strictEqual((await stranger('GET', `/api/join/${made.club.code}`)).status, 404);
  // 119 days is still alive.
  const b = client();
  const kept = await newClub(b);
  await store.merge('clubs', kept.id, { updatedAt: new Date(Date.now() - 119 * 86400000).toISOString() });
  assert.strictEqual((await b('GET', `/api/c/${kept.id}`)).status, 200);
});

test('limits: 30 distinct wrong codes then even the right one waits (a dead code polled counts once); 30 new readers an hour per address; 40 notes an hour per reader; 30 readers a club', async () => {
  const host = client();
  const made = await newClub(host);
  const g = client();
  for (let i = 0; i < 40; i++) await g('GET', '/api/join/ZZZZZZ');
  assert.strictEqual((await g('GET', `/api/join/${made.club.code}`)).status, 200, 'the same dead code is not guessing');
  let last;
  for (let i = 0; i < 31; i++) last = await g('GET', `/api/join/${C.CODE_ALPHABET[i % 32]}${C.CODE_ALPHABET[(i * 7) % 32]}ZZZZ`);
  assert.strictEqual(last.status, 429);
  assert.strictEqual((await g('GET', `/api/join/${made.club.code}`)).status, 429, 'then even the right code waits');
  assert.strictEqual((await client()('GET', `/api/join/${made.club.code}`)).status, 200, 'another address is not held up');
  // New readers per address: a full club, then the next join from the same address.
  const addr = '2001:db8:feed:1::1';
  const clubs = [made, await newClub(client())];
  let n = 0;
  for (; n < 29; n++) await joinAs(client(addr), clubs[0].club.code, `R${n}x`.replace(/\d/g, (d) => 'abcdefghij'[d]));
  assert.strictEqual((await client(addr)('POST', `/api/join/${clubs[0].club.code}`, { name: 'Overflow' })).status, 409, 'thirty readers is a full club');
  assert.strictEqual((await client(addr)('POST', `/api/join/${clubs[1].club.code}`, { name: 'Thirtieth' })).status, 200);
  assert.strictEqual((await client(addr)('POST', `/api/join/${clubs[1].club.code}`, { name: 'Thirtyfirst' })).status, 429, '30 new readers an hour from one address');
  // Notes per reader.
  const w = client();
  const wc = await newClub(w);
  await w('PUT', `/api/c/${wc.id}/progress`, { pos: 3 });
  for (let i = 0; i < 40; i++) assert.strictEqual((await w('POST', `/api/c/${wc.id}/notes`, { text: `Thought ${i}`, at: 1 })).status, 200);
  assert.strictEqual((await w('POST', `/api/c/${wc.id}/notes`, { text: 'One more', at: 1 })).status, 429);
  const long = await client()('POST', '/api/clubs', { name: 'x'.repeat(500), you: { name: 'y'.repeat(500) }, book: { title: 'z'.repeat(500), chapters: 5 } });
  assert.deepStrictEqual([long.data.club.name.length, long.data.club.members[0].name.length, long.data.club.book.title.length], [48, 24, 100]);
});

test('hostile input: markup, bidi and zero-width characters in names, notes, nominations and meetings are stripped before they are stored; a call link must be https', async () => {
  const a = client(), b = client();
  const made = await newClub(a, { name: '<img src=x onerror=alert(1)>Night\u202EOwls\u200B', you: { name: '<b>Ana</b>\u2066' } });
  await joinAs(b, made.club.code, '<script>alert(1)</script>Bo\u202E');
  await b('PUT', `/api/c/${made.id}/progress`, { pos: 5 });
  await a('PUT', `/api/c/${made.id}/progress`, { pos: 5 });
  await a('POST', `/api/c/${made.id}/notes`, { text: '<iframe src=javascript:alert(1)></iframe>Great\u202E chapter\u200B<b>!</b>', at: 2 });
  await a('POST', `/api/c/${made.id}/noms`, { title: '<svg onload=alert(1)>Emma', author: '\u202EAusten', why: '<a href="x">click</a> me' });
  assert.strictEqual((await a('POST', `/api/c/${made.id}/meetings`, { date: C.addDays(realToday(), 3), link: 'javascript:alert(1)' })).status, 400);
  await a('POST', `/api/c/${made.id}/meetings`, { date: C.addDays(realToday(), 3), place: '<b onmouseover=x>Bo’s</b>' });
  const dump = store._dump() + JSON.stringify((await a('GET', `/api/c/${made.id}`)).data);
  assert.ok(!/<|>|\u202E|\u200B|\u2066|onerror|onload/.test(dump.replace(/\\u003c|\\u003e/g, '')), 'nothing hostile is stored or sent');
  const v = (await b('GET', `/api/c/${made.id}`)).data.club;
  assert.deepStrictEqual([v.name, v.members.map((m) => m.name), v.notes[0].text, v.vote.noms[0].title, v.vote.noms[0].why], ['NightOwls', ['Ana', 'alert Bo'], 'Great chapter !', 'Emma', 'click me']);
});

test('the AI over HTTP: a reader in the club asks for a range up to where they are; the model sees the title, author and range and nothing else; its answer is checked; nothing is stored until a member adds one', async () => {
  const u = await register('ana.reader');
  const other = client();
  const made = await newClub(u, { name: 'ZEBRA-CLUB-NAME', you: { name: 'Quentin' } });
  await joinAs(other, made.club.code, 'Wilhelmina');
  await u('PUT', `/api/c/${made.id}/progress`, { pos: 8 });
  await u('POST', `/api/c/${made.id}/notes`, { text: 'ZEBRA-NOTE-TEXT', at: 3 });
  let calls = await modelCalls();
  for (const bad of [{ club: made.id, from: 1, to: 9 }, { club: made.id, from: 1, to: 8, extra: 1 }, { club: 'AAAAAAAAAAAAAAAA', from: 1, to: 2 }, { club: made.id }]) {
    const r = await u('POST', '/api/ai/questions', bad);
    assert.ok([400, 404].includes(r.status), `${JSON.stringify(bad)} -> ${r.status}`);
  }
  const stranger = await register('wil.stranger');
  assert.strictEqual((await stranger('POST', '/api/ai/questions', { club: made.id, from: 1, to: 2 })).status, 404, 'only members of the club');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for any of those');
  const before = store._dump();
  const r = await u('POST', '/api/ai/questions', { club: made.id, from: 2, to: 8 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.knowsBook, true);
  assert.strictEqual(r.data.questions.length, 6);
  assert.ok(r.data.questions.every((q) => q.at >= 2 && q.at <= 8));
  const sent = fakeClient.calls[fakeClient.calls.length - 1];
  assert.strictEqual(sent.messages.length, 1);
  assert.deepStrictEqual(sent.messages[0].content, [{ type: 'text', text: ai.message({ title: 'Frankenstein', author: 'Mary Shelley', unit: 'ch', total: 24 }, { from: 2, to: 8 }) }]);
  const wire = JSON.stringify(sent);
  for (const t of ['ZEBRA', 'Quentin', 'Wilhelmina', made.id, made.club.code]) assert.ok(!wire.includes(t), `${t} reached the model`);
  assert.deepStrictEqual([sent.tool_choice, sent.model], [{ type: 'tool', name: 'suggest_questions' }, 'claude-haiku-4-5']);
  assert.strictEqual(store._dump(), before, 'nothing was stored');
  // Adding one is an ordinary question, marked AI-written.
  const add = await u('POST', `/api/c/${made.id}/notes`, { kind: 'question', text: r.data.questions[2].text, at: r.data.questions[2].at, ai: true });
  assert.ok(add.data.club.notes.some((n) => n.ai && n.kind === 'question'));
  // Hostile, unknown, empty, too long and failing answers.
  fakeClient.mode = 'inject';
  const inj = await u('POST', '/api/ai/questions', { club: made.id, from: 1, to: 8 });
  assert.strictEqual(inj.status, 200);
  assert.deepStrictEqual(inj.data.questions, [{ text: 'Who would you cast as the lead in a film of these chapters?', at: 8 }], 'markup, links, a long quote, a control character, too short, out of range and a repeat are all dropped');
  fakeClient.mode = 'unknown';
  const unk = await u('POST', '/api/ai/questions', { club: made.id, from: 3, to: 8 });
  assert.deepStrictEqual([unk.data.knowsBook, unk.data.questions.every((q) => q.at === 3)], [false, true]);
  for (const [mode, status] of [['blank', 422], ['maxtokens', 502], ['upstream529', 503], ['upstream500', 502]]) {
    fakeClient.mode = mode;
    const f = await u('POST', '/api/ai/questions', { club: made.id, from: 1, to: 8 });
    assert.strictEqual(f.status, status, mode);
    assert.ok(!/fake_upstream_error|stand-in/.test(f.text), 'a provider error is never passed to the page');
  }
});

test('the gates: unconfirmed free account 403, out of credit 402, the day\u2019s free ceiling 503 - each before the parser, never a model call; the club stays free', async () => {
  const una = await register('una.unconfirmed');
  const made = await newClub(una);
  await una('PUT', `/api/c/${made.id}/progress`, { pos: 4 });
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await una('POST', '/api/ai/questions', { club: made.id, from: 1, to: 4 });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/chapter/api/auth/verify/send', 'the resend link is under this app\u2019s mount');
    assert.strictEqual((await una('POST', '/api/ai/questions', BIG)).status, 403, '403 before the big body is read');
    assert.strictEqual((await una('POST', `/api/c/${made.id}/notes`, { text: 'Still free', at: 2 })).status, 200);
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke');
  await identityStore.merge('users', uidOf(mail('cal.broke')), { spentUsd: 100 });
  let calls = await modelCalls();
  const r402 = await cal('POST', '/api/ai/questions', { club: made.id, from: 1, to: 4 });
  assert.strictEqual(r402.status, 402);
  assert.strictEqual((await cal('POST', '/api/ai/questions', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
  const dan = await register('dan.capped');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-chapter-${day}`, { usd: 5000 });
  try {
    calls = await modelCalls();
    const capped = await dan('POST', '/api/ai/questions', { club: made.id, from: 1, to: 4 });
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/ai/questions', BIG)).status, 503, 'the ceiling answers before the parser too');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { await identityStore.remove('control', `free-spend-chapter-${day}`); }
});

test('keep my clubs on my account (signed in, optional): another device signed in opens the club; only a tag, club ids and member ids are stored - never the email or the account id', async () => {
  const phone = await register('kim.keeper');
  const made = await newClub(phone, { you: { name: 'Kim' } });
  const kept = await phone('PUT', `/api/account/clubs/${made.id}`, {});
  assert.deepStrictEqual([kept.status, kept.data.club.kept], [200, true]);
  const email = mail('kim.keeper'), uid = uidOf(email);
  const dump = store._dump();
  assert.ok(!dump.includes(email) && !dump.includes(uid) && !dump.includes('kim.keeper'), 'no email or account id anywhere in the lab data');
  const tag = K.accountTag(uid, 'local-dev-secret');
  assert.deepStrictEqual((await store.get('accounts', tag)).clubs, { [made.id]: made.club.you });
  // A laptop: no key cookie, the same account.
  const laptop = client();
  await laptop('POST', '/api/auth/login', { email, password: 'a long enough password' });
  assert.strictEqual((await laptop('GET', `/api/c/${made.id}`)).status, 200);
  const list = await laptop('GET', '/api/account/clubs');
  assert.deepStrictEqual(list.data.clubs.map((c) => [c.id, c.name, c.you]), [[made.id, 'Elm Street Readers', 'Kim']]);
  // Signed out, the laptop is a stranger again.
  await laptop('POST', '/api/auth/logout', {});
  assert.strictEqual((await laptop('GET', `/api/c/${made.id}`)).status, 404);
  // Stop keeping it.
  const un = await phone('DELETE', `/api/account/clubs/${made.id}`);
  assert.strictEqual(un.data.club.kept, false);
  assert.deepStrictEqual((await phone('GET', '/api/account/clubs')).data.clubs, []);
  assert.strictEqual((await phone('GET', `/api/c/${made.id}`)).status, 200, 'this phone still has its key');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/chapter', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/chapter`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
