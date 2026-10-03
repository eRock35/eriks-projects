// Pure rules first, then end to end against the memory store and the fake
// model:
//   FLIGHT_MEMORY=1 FLIGHT_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /flight, the way
// the lab mounts it, so the auth cookie, the budget gate, the member
// cookie's path, per-crew rights and the big-body route are exercised as
// deployed. Model calls are counted from the identity's usage rows - the
// same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.FLIGHT_MEMORY !== '1' || process.env.FLIGHT_FAKE_AI !== '1') {
  console.error('run with FLIGHT_MEMORY=1 FLIGHT_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, store } = require('../server');
const C = require('../public/flight-core');
const S = require('../public/sample');
const QR = require('../public/qr');
const ai = require('../lib/ai');
const K = require('../lib/crews');
const hop = require('../lib/hopscotch');

let base;
let ipSeq = 10;
const freshIp = () => `203.0.113.${ipSeq++ % 250}`;
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
const MARK = 'LABELBYTESMARKER';
const jpeg = (s = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(MARK + s), Buffer.alloc(2000, 7)]).toString('base64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------- helpers for pure session tests ---------------- */

let seq = 0;
const ids = { beer: () => `b${++seq}`, option: () => `o${++seq}` };
const T0 = Date.parse('2026-10-02T19:00:00Z');
const A = (mid, host) => ({ mid, host: Boolean(host) });
/** A blind session in the tasting stage: beers [{name, style, abv, by}]. */
function blind(beers, runner = 'm1') {
  const s = C.newSession({ kind: 'blind', title: 'Test night' }, A(runner), T0, ids);
  const memberIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  // A beer brought by nobody in the crew (a house pick) is added by whoever runs it.
  for (const b of beers) C.addBeer(s, A(b.by || runner), { name: b.name, style: b.style, abv: b.abv, ...(b.by === null ? { broughtBy: null } : {}) }, T0, ids, memberIds);
  C.startTasting(s, A(runner), T0, (n) => 0);
  return s;
}
const beerByName = (s, name) => s.beers.find((b) => b.name === name);
function score(s, mid, name, sc) { C.setScore(s, A(mid), beerByName(s, name).id, sc, T0 + 1000); }

/* ---------------- pure: styles and text ---------------- */

test('styles: a fixed list of about forty in families, non-alcoholic a family of its own; exact 3, family 1, miss 0', () => {
  assert.ok(C.STYLES.length >= 38 && C.STYLES.length <= 48, `${C.STYLES.length} styles`);
  const fams = new Set(C.FAMILIES.map((f) => f.id));
  for (const s of C.STYLES) assert.ok(fams.has(s.family), `${s.id} has a family`);
  for (const f of C.FAMILIES) assert.ok(C.STYLES.filter((s) => s.family === f.id).length >= 3, `${f.id} has styles`);
  assert.deepStrictEqual(C.STYLES.filter((s) => s.family === 'na').map((s) => s.id), ['na-lager', 'na-ipa', 'na-wheat', 'na-dark']);
  assert.strictEqual(new Set(C.STYLE_IDS).size, C.STYLE_IDS.length, 'ids are unique');
  assert.strictEqual(C.stylePoints('hazy', 'hazy'), 3);
  assert.strictEqual(C.stylePoints('west-coast', 'hazy'), 1, 'same family');
  assert.strictEqual(C.stylePoints('stout', 'hazy'), 0, 'a miss');
  assert.strictEqual(C.stylePoints('na-ipa', 'hazy'), 0, 'an NA IPA is the NA family, not the IPA family');
  assert.strictEqual(C.stylePoints('other', 'other'), 0, '"something else" scores nobody');
  assert.strictEqual(C.stylePoints('hazy', null), 0);
  assert.strictEqual(C.stylePoints(null, 'hazy'), 0);
  assert.strictEqual(C.stylePoints('made-up', 'hazy'), 0);
  assert.ok(C.HOPPY.hazy && C.HOPPY['na-ipa'] && !C.HOPPY.pilsner);
});

test('typed text is bounded and stripped of markup, control and bidi characters; stars and ABV read strictly', () => {
  assert.strictEqual(C.clean('<b>Fog</b>\u202e Lan\u0000tern\u200b', 60), 'Fog Lan tern');
  assert.strictEqual(C.clean('A'.repeat(500), 10).length, 10);
  assert.ok(C.clean('A'.repeat(500), 10).endsWith('…'));
  assert.strictEqual(C.cleanName('  \u202e  '), '');
  assert.strictEqual(C.cleanName('🦊'), '🦊');
  assert.strictEqual(C.cleanName('<script>'), '');
  const t0 = Date.now(); C.clean('<'.repeat(400000), 60); assert.ok(Date.now() - t0 < 500, 'linear on hostile input');
  assert.deepStrictEqual([0.5, 1, 3.5, 5, '4.5'].map(C.cleanStars), [0.5, 1, 3.5, 5, 4.5]);
  for (const bad of [0, 0.25, 5.5, -1, 3.3, 'four', null, NaN, Infinity, {}]) assert.strictEqual(C.cleanStars(bad), null, String(bad));
  assert.deepStrictEqual(['6.8', '6.8%', '6,8', 6.84, '0', '0.4', 20].map(C.cleanAbv), [6.8, 6.8, 6.8, 6.8, 0, 0.4, 20]);
  for (const bad of ['about 7', '-1', 21, '1e1', 'NaN', '7.123', {}, true]) assert.strictEqual(C.cleanAbv(bad), null, String(bad));
  assert.deepStrictEqual(C.cleanChips(['hoppy', 'hoppy', 'nope', 'malty', 'sour', 'roasty', 'fruity', 'crisp', 'boozy']), ['hoppy', 'malty', 'sour', 'roasty', 'fruity', 'crisp']);
  assert.strictEqual(C.cleanEmoji('🦊'), '🦊');
  assert.strictEqual(C.cleanEmoji('<x>'), null);
});

/* ---------------- pure: a blind tasting ---------------- */

test('a blind tasting: letters are shuffled at the start, and nobody sees a beer’s details, bringer or others’ scores before the reveal', () => {
  const s = C.newSession({ kind: 'blind' }, A('m1'), T0, ids);
  const m = ['m1', 'm2', 'm3'];
  C.addBeer(s, A('m1'), { name: 'Alpha', style: 'hazy', abv: '6.5' }, T0, ids, m);
  C.addBeer(s, A('m2'), { name: 'Bravo', style: 'stout', abv: 5 }, T0, ids, m);
  C.addBeer(s, A('m3'), { name: 'Charlie', style: 'pilsner', abv: 4.8 }, T0, ids, m);
  assert.strictEqual(C.stageOf(s, T0), 'setup');
  let v = C.sessionView(s, m, 'm2', false, T0);
  assert.deepStrictEqual(v.beers.map((b) => b.name || null), [null, 'Bravo', null], 'only your own beer during setup');
  assert.throws(() => C.setScore(s, A('m2'), s.beers[0].id, { stars: 4 }, T0), /hasn’t started/);
  assert.throws(() => C.startTasting(s, A('m2'), T0, () => 0), /Only whoever runs/);
  // A Fisher-Yates shuffle driven by the server's random numbers (here, always 0).
  C.startTasting(s, A('m1'), T0, () => 0);
  assert.deepStrictEqual(s.beers.map((b) => [b.label, b.name]), [['A', 'Bravo'], ['B', 'Charlie'], ['C', 'Alpha']], 'the order of adding is not the order of letters');
  assert.throws(() => C.addBeer(s, A('m2'), { name: 'Late' }, T0, ids, m), /lineup is set/);
  C.setScore(s, A('m2'), beerByName(s, 'Alpha').id, { stars: 4, style: 'hazy', abv: 6.4, chips: ['juicy'], note: 'Mango' }, T0);
  assert.throws(() => C.setScore(s, A('m2'), beerByName(s, 'Bravo').id, { stars: 5 }, T0), /You brought this one/);
  v = C.sessionView(s, m, 'm3', false, T0);
  const text = JSON.stringify(v);
  for (const leak of ['Alpha', 'Bravo', 'hazy', 'stout', '6.5', 'Mango', 'juicy']) assert.ok(!text.includes(leak), `m3 must not see ${leak}`);
  assert.ok(text.includes('Charlie'), 'but sees their own');
  assert.ok(!('broughtBy' in v.beers.find((b) => !b.mine)), 'no bringer before the reveal');
  assert.deepStrictEqual(v.bringers, ['m1', 'm2', 'm3'], 'who brought something is known - that is the guessing game');
  assert.deepStrictEqual(v.progress.find((p) => p.member === 'm2'), { member: 'm2', done: 1, of: 2, city: '', brought: 1 });
  assert.strictEqual(v.results, undefined);
  C.reveal(s, A('m1'), T0 + 5000);
  v = C.sessionView(s, m, 'm3', false, T0 + 5000);
  assert.strictEqual(v.stage, 'revealed');
  assert.ok(JSON.stringify(v).includes('Mango') && v.beers.every((b) => b.name && 'broughtBy' in b));
});

test('crowd scores are half-star means of everyone but the bringer; ranking uses the exact mean', () => {
  const s = blind([{ name: 'X', style: 'hazy', abv: 6.8, by: 'm1' }, { name: 'Y', style: 'stout', abv: 5.5, by: 'm2' }]);
  score(s, 'm2', 'X', { stars: 4 }); score(s, 'm3', 'X', { stars: 4.5 }); score(s, 'm4', 'X', { stars: 4.5 }); score(s, 'm5', 'X', { stars: 4 });
  score(s, 'm1', 'Y', { stars: 4.5 }); score(s, 'm3', 'Y', { stars: 4 });
  // A bringer's own stars never count, even if they are in the document.
  s.scores[beerByName(s, 'X').id].m1 = { stars: 0.5, style: null, abv: null, chips: [], note: '' };
  const r = C.results(s, ['m1', 'm2', 'm3', 'm4', 'm5']);
  const x = r.beers.find((b) => b.name === 'X'), y = r.beers.find((b) => b.name === 'Y');
  assert.deepStrictEqual([x.crowd.mean, x.crowd.half, x.crowd.n], [4.25, 4.5, 4]);
  assert.deepStrictEqual([y.crowd.mean, y.crowd.half, y.crowd.n], [4.25, 4.5, 2]);
  assert.deepStrictEqual(r.ranked, [x.id, y.id], 'a tie on the mean goes to more scores');
  assert.strictEqual(C.halfStar(4.24), 4);
  assert.strictEqual(C.halfStar(4.26), 4.5);
  assert.strictEqual(C.halfStar(3.75), 4);
  assert.strictEqual(C.halfStar(null), null);
});

test('style points, ABV closest (ties share) and who-brought guesses add up to each member’s points', () => {
  const s = blind([{ name: 'X', style: 'hazy', abv: 6.8, by: 'm1' }, { name: 'Y', style: 'stout', abv: 5.5, by: 'm2' }]);
  score(s, 'm2', 'X', { stars: 4, style: 'hazy', abv: 6.6 });        // exact 3, off 0.2
  score(s, 'm3', 'X', { stars: 4, style: 'dipa', abv: 7.0 });        // family 1, off 0.2 -> tie
  score(s, 'm4', 'X', { stars: 4, style: 'stout', abv: 9 });         // miss
  score(s, 'm1', 'Y', { stars: 4, style: 'porter', abv: 5.5 });      // family 1, exact ABV
  score(s, 'm3', 'Y', { stars: 3, style: 'stout', abv: 5.4 });       // exact 3
  const m = ['m1', 'm2', 'm3', 'm4'];
  C.setGuess(s, A('m3'), beerByName(s, 'X').id, 'm1', m, T0);      // right
  C.setGuess(s, A('m4'), beerByName(s, 'X').id, 'm2', m, T0);      // wrong
  C.setGuess(s, A('m3'), beerByName(s, 'Y').id, 'm2', m, T0);      // right
  const r = C.results(s, m);
  const x = r.beers.find((b) => b.name === 'X');
  assert.deepStrictEqual(x.abvWinners, ['m2', 'm3'], 'two guesses equally close share it');
  assert.strictEqual(x.abvBest, 0.2);
  assert.deepStrictEqual(r.beers.find((b) => b.name === 'Y').abvWinners, ['m1']);
  assert.deepStrictEqual(Object.fromEntries(m.map((k) => [k, [r.members[k].stylePts, r.members[k].abvWins, r.members[k].whoRight]])), {
    m1: [1, 1, 0], m2: [3, 1, 0], m3: [4, 1, 2], m4: [0, 0, 0],
  });
  // Best Palate m3 (4); ABV Whisperer: m1, m2, m3 all have 1 win - smaller average miss: m1 (0.0).
  assert.deepStrictEqual(r.awards.find((a) => a.id === 'palate').winners, ['m3']);
  assert.deepStrictEqual(r.awards.find((a) => a.id === 'abv').winners, ['m1'], 'a tie on wins goes to the smaller average miss');
  assert.deepStrictEqual(r.awards.find((a) => a.id === 'sleuth').winners, ['m3']);
  const pts = r.members.m3;
  assert.strictEqual(pts.points, 4 + 2 * 1 + 2 * 2 + 2 * pts.awards.length);
});

test('who brought it: never your own beer, never a beer you added, never yourself, only crew members; null takes it back', () => {
  const s = C.newSession({ kind: 'blind' }, A('m1'), T0, ids);
  const m = ['m1', 'm2', 'm3'];
  C.addBeer(s, A('m2'), { name: 'Mine' }, T0, ids, m);
  C.addBeer(s, A('m1'), { name: 'For Dee', broughtBy: 'm3' }, T0, ids, m);
  assert.throws(() => C.addBeer(s, A('m2'), { name: 'Sneaky', broughtBy: 'm3' }, T0, ids, m), /Only whoever runs/);
  assert.throws(() => C.addBeer(s, A('m1'), { name: 'Ghost', broughtBy: 'mnope' }, T0, ids, m), /isn’t in the crew/);
  assert.throws(() => C.setGuess(s, A('m3'), s.beers[0].id, 'm2', m, T0), /closed/, 'not before the tasting');
  C.startTasting(s, A('m1'), T0, () => 0);
  const mine = beerByName(s, 'Mine').id, forDee = beerByName(s, 'For Dee').id;
  assert.throws(() => C.setGuess(s, A('m2'), mine, 'm3', m, T0), /You know who brought this one/);
  assert.throws(() => C.setGuess(s, A('m3'), forDee, 'm1', m, T0), /You know who brought this one/, 'the bringer');
  assert.throws(() => C.setGuess(s, A('m1'), forDee, 'm2', m, T0), /You know who brought this one/, 'whoever added it');
  assert.throws(() => C.setGuess(s, A('m3'), mine, 'm3', m, T0), /You know you didn’t bring it/);
  assert.throws(() => C.setGuess(s, A('m3'), mine, 'mstranger', m, T0), /isn’t in the crew/);
  assert.throws(() => C.setGuess(s, A(null), mine, 'm2', m, T0), /Join the crew/);
  C.setGuess(s, A('m3'), mine, 'm2', m, T0);
  assert.strictEqual(s.guesses.m3[mine], 'm2');
  C.setGuess(s, A('m3'), mine, null, m, T0);
  assert.strictEqual(s.guesses.m3[mine], undefined);
  // An adder can rate stars (they count) but their guesses don't score.
  C.setScore(s, A('m1'), forDee, { stars: 5, style: 'other', abv: 5 }, T0);
  C.setGuess(s, A('m1'), mine, 'm2', m, T0);
  const r = C.results(s, m);
  assert.strictEqual(r.members.m1.whoRight, 1);
  assert.strictEqual(r.beers.find((b) => b.id === forDee).crowd.n, 1);
  // Same-Can Challenges have no "who brought it".
  const sc = C.newSession({ kind: 'samecan', beer: { name: 'Can' }, window: { closesAt: new Date(T0 + 86400000).toISOString() } }, A('m1'), T0, ids);
  assert.throws(() => C.setGuess(sc, A('m2'), sc.beers[0].id, 'm1', m, T0), /blind tastings/);
});

test('awards: every one, ties shared, and small crews get only the awards that make sense', () => {
  const s = blind([
    { name: 'Hazy', style: 'hazy', abv: 6.5, by: 'm1' }, { name: 'WC', style: 'west-coast', abv: 7, by: 'm2' },
    { name: 'Pils', style: 'pilsner', abv: 5, by: 'm3' },
  ]);
  for (const [mid, stars] of [['m2', 5], ['m3', 5], ['m4', 3], ['m5', 4]]) score(s, mid, 'Hazy', { stars, style: mid === 'm4' ? 'hazy' : 'witbier' });
  for (const [mid, stars] of [['m1', 5], ['m3', 5], ['m4', 3], ['m5', 4]]) score(s, mid, 'WC', { stars, style: mid === 'm5' ? 'west-coast' : 'pilsner' });
  for (const [mid, stars] of [['m1', 3], ['m2', 3], ['m4', 5], ['m5', 3]]) score(s, mid, 'Pils', { stars });
  const m = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const r = C.results(s, m);
  const aw = Object.fromEntries(r.awards.map((a) => [a.id, a.winners]));
  assert.deepStrictEqual(aw.palate, ['m4', 'm5'], 'Best Palate tie: 3 and 3');
  assert.deepStrictEqual(aw.pleaser, ['m1', 'm2'], 'Crowd Pleaser tie: two beers at 4.25 - both bringers');
  assert.deepStrictEqual(aw.contrarian, ['m4'], 'Contrarian: two off by 1.5 and one by 2');
  assert.deepStrictEqual(aw.hophead, ['m1', 'm2', 'm3'], 'Hop Head: three gave the IPAs they could rate a 5 - shared');
  assert.strictEqual(aw.abv, undefined, 'nobody guessed an ABV');
  assert.strictEqual(aw.sleuth, undefined, 'nobody guessed who brought it');
  assert.deepStrictEqual(r.awards.map((a) => a.id), ['palate', 'pleaser', 'contrarian', 'hophead'], 'shown in a fixed order');
  // A crew of two: no contrarian (needs two others), no hop head (needs two IPA raters).
  const s2 = blind([{ name: 'Hazy', style: 'hazy', abv: 6.5, by: 'm1' }, { name: 'Stout', style: 'stout', abv: 5, by: 'm2' }]);
  score(s2, 'm2', 'Hazy', { stars: 2, style: 'hazy', abv: 6.5 });
  score(s2, 'm1', 'Stout', { stars: 5, style: 'porter', abv: 9 });
  const r2 = C.results(s2, ['m1', 'm2']);
  assert.deepStrictEqual(r2.awards.map((a) => [a.id, a.winners]), [['palate', ['m2']], ['abv', ['m2']], ['pleaser', ['m2']]]);
  // Hop Head with a clear winner: two IPAs, three raters.
  const s3 = blind([{ name: 'H1', style: 'hazy', abv: 6, by: null }, { name: 'H2', style: 'na-ipa', abv: 0.5, by: null }]);
  for (const [mid, a, b] of [['m1', 5, 4.5], ['m2', 3, 3], ['m3', 4, 2]]) { score(s3, mid, 'H1', { stars: a }); score(s3, mid, 'H2', { stars: b }); }
  const r3 = C.results(s3, ['m1', 'm2', 'm3']);
  assert.deepStrictEqual(r3.awards.find((x) => x.id === 'hophead').winners, ['m1'], 'an NA IPA counts as an IPA for Hop Head');
  assert.deepStrictEqual(r3.awards.find((x) => x.id === 'contrarian').winners, ['m1'], 'and the one who loved them is 1.75 stars from the rest');
  // Contrarian needs half a star of distance: a crew that agrees has none.
  const s4 = blind([{ name: 'P', style: 'pilsner', abv: 5, by: null }, { name: 'Q', style: 'stout', abv: 6, by: null }]);
  for (const mid of ['m1', 'm2', 'm3']) { score(s4, mid, 'P', { stars: 4 }); score(s4, mid, 'Q', { stars: mid === 'm3' ? 3.5 : 3 }); }
  assert.strictEqual(C.results(s4, ['m1', 'm2', 'm3']).awards.find((x) => x.id === 'contrarian'), undefined, 'nobody half a star from the rest on average');
  // One person: nobody to be contrary with, nothing to share.
  const s1 = blind([{ name: 'Hazy', style: 'hazy', abv: 6.5, by: null }, { name: 'Pils', style: 'pilsner', abv: 5, by: null }], 'm6');
  score(s1, 'm1', 'Hazy', { stars: 4, style: 'hazy' });
  const r1 = C.results(s1, ['m1']);
  assert.deepStrictEqual(r1.awards.map((a) => a.id), ['palate'], 'a house pick has no bringer, so no Crowd Pleaser');
  // Whoever added the house picks knows them: their guesses never score.
  const s5 = blind([{ name: 'Hazy', style: 'hazy', abv: 6.5, by: null }, { name: 'Pils', style: 'pilsner', abv: 5, by: null }], 'm1');
  score(s5, 'm1', 'Hazy', { stars: 4, style: 'hazy', abv: 6.5 });
  assert.deepStrictEqual(C.results(s5, ['m1']).awards, []);
  // Nobody scored anything: no awards at all, and no crash.
  assert.deepStrictEqual(C.results(blind([{ name: 'A', by: 'm1' }, { name: 'B', by: 'm2' }]), ['m1', 'm2']).awards, []);
});

test('a member who left is out of every result; a beer they brought stays with nobody’s name', () => {
  const s = blind([{ name: 'X', style: 'hazy', abv: 6.8, by: 'm1' }, { name: 'Y', style: 'stout', abv: 5.5, by: 'm2' }]);
  score(s, 'm2', 'X', { stars: 4, style: 'hazy', note: 'secret note' });
  score(s, 'm3', 'X', { stars: 2 });
  C.setGuess(s, A('m3'), beerByName(s, 'X').id, 'm1', ['m1', 'm2', 'm3'], T0);
  const r = C.results(s, ['m1', 'm3']);
  assert.deepStrictEqual(r.beers.find((b) => b.name === 'X').crowd, { mean: 2, half: 2, n: 1 }, 'm2’s stars no longer count');
  assert.strictEqual(r.members.m2, undefined);
  assert.strictEqual(r.beers.find((b) => b.name === 'Y').broughtBy, null);
  assert.ok(C.scrubMember(s, 'm2'));
  assert.ok(!JSON.stringify(s).includes('secret note') && !JSON.stringify(s).includes('"m2"'), 'scrubbed from the document');
  C.scrubMember(s, 'm1');
  assert.ok(!JSON.stringify(s.guesses).includes('m1'), 'guesses naming them go too');
});

/* ---------------- pure: Same-Can ---------------- */

test('Same-Can: the window is checked on read - upcoming, open, then revealed when it closes, with no timer', () => {
  const opens = new Date(T0 + 3600000).toISOString(), closes = new Date(T0 + 3 * 86400000).toISOString();
  const s = C.newSession({ kind: 'samecan', beer: { name: 'Cold Snap Pils', brewery: 'Ridgeback', style: 'pilsner', abv: 5 }, window: { opensAt: opens, closesAt: closes } }, A('m1'), T0, ids);
  assert.strictEqual(s.title, 'Same-Can: Cold Snap Pils');
  assert.strictEqual(C.stageOf(s, T0), 'upcoming');
  assert.throws(() => C.setScore(s, A('m2'), s.beers[0].id, { stars: 4 }, T0), /hasn’t opened/);
  assert.strictEqual(C.stageOf(s, T0 + 7200000), 'open');
  C.setScore(s, A('m2'), s.beers[0].id, { stars: 4, style: 'helles', abv: 5.2 }, T0 + 7200000);
  C.setScore(s, A('m3'), s.beers[0].id, { stars: 3, style: 'pilsner', abv: 4.9 }, T0 + 7200000);
  C.setCity(s, A('m2'), '  Austin\u202e ', T0 + 7200000);
  let v = C.sessionView(s, ['m1', 'm2', 'm3'], 'm2', false, T0 + 7200000);
  assert.deepStrictEqual([v.beers[0].name, v.beers[0].style, v.beers[0].abv], ['Cold Snap Pils', undefined, undefined], 'the can is named; its style and ABV wait');
  assert.strictEqual(v.progress.find((p) => p.member === 'm2').city, 'Austin');
  const close = Date.parse(closes);
  assert.strictEqual(C.stageOf(s, close - 1), 'open');
  assert.strictEqual(C.stageOf(s, close), 'revealed', 'closed exactly at closesAt');
  assert.throws(() => C.setScore(s, A('m3'), s.beers[0].id, { stars: 5 }, close + 1), /Scoring has closed/);
  v = C.sessionView(s, ['m1', 'm2', 'm3'], 'm2', false, close + 1);
  assert.ok(v.results);
  assert.deepStrictEqual(v.results.beers[0].crowd, { mean: 3.5, half: 3.5, n: 2 }, 'everyone’s stars count - nobody brought the can');
  assert.strictEqual(C.settledAt(s, close + 1), close);
  assert.ok(/Tasted in Austin/.test(C.recap('Crew', s, v.results, (x) => x)));
  // The host can reveal early; the picker's guesses never score.
  const s2 = C.newSession({ kind: 'samecan', beer: { name: 'Can', style: 'pilsner', abv: 5 }, window: { closesAt: closes } }, A('m1'), T0, ids);
  C.setScore(s2, A('m1'), s2.beers[0].id, { stars: 4, style: 'pilsner', abv: 5 }, T0);
  assert.throws(() => C.reveal(s2, A('m2'), T0), /Only whoever runs/);
  C.reveal(s2, A('m9', true), T0 + 10);
  assert.strictEqual(C.results(s2, ['m1']).members.m1.stylePts, 0);
});

test('Same-Can windows: this weekend in the creator’s own time zone, at least an hour, at most two weeks', () => {
  // Thursday 2026-10-01 15:00 UTC.
  const thu = Date.parse('2026-10-01T15:00:00Z');
  assert.strictEqual(C.weekendWindow(thu, 0).closesAt, '2026-10-04T23:59:00.000Z', 'UTC: Sunday 23:59');
  assert.strictEqual(C.weekendWindow(thu, -7 * 60).closesAt, '2026-10-05T06:59:00.000Z', 'Denver (UTC-7): Sunday 23:59 there');
  assert.strictEqual(C.weekendWindow(thu, 9 * 60).closesAt, '2026-10-04T14:59:00.000Z', 'Tokyo (UTC+9)');
  assert.strictEqual(C.weekendWindow(thu, 5.5 * 60).closesAt, '2026-10-04T18:29:00.000Z', 'India (UTC+5:30)');
  // Sunday 23:30 in Sydney is Sunday 12:30 UTC - a weekend that is ending runs to next Sunday there.
  const sunLate = Date.parse('2026-10-04T12:30:00Z');
  assert.strictEqual(C.weekendWindow(sunLate, 11 * 60).closesAt, '2026-10-11T12:59:00.000Z');
  // Sunday morning UTC keeps today.
  assert.strictEqual(C.weekendWindow(Date.parse('2026-10-04T09:00:00Z'), 0).closesAt, '2026-10-04T23:59:00.000Z');
  // The same instant, read from any zone, is the same stage.
  const w = C.cleanWindow({ opensAt: '2026-10-02T12:00:00-07:00', closesAt: '2026-10-04T23:59:00+02:00' }, Date.parse('2026-10-02T19:00:00Z'));
  assert.deepStrictEqual(w, { opensAt: '2026-10-02T19:00:00.000Z', closesAt: '2026-10-04T21:59:00.000Z' });
  assert.throws(() => C.cleanWindow({ closesAt: new Date(T0 + 1800000).toISOString() }, T0), /at least an hour/);
  assert.throws(() => C.cleanWindow({ closesAt: new Date(T0 + 15 * 86400000).toISOString() }, T0), /two weeks/);
  assert.throws(() => C.cleanWindow({ closesAt: 'next tuesday' }, T0), /closes/);
  assert.strictEqual(C.cleanWindow({ opensAt: '2020-01-01T00:00:00Z', closesAt: new Date(T0 + 86400000).toISOString() }, T0).opensAt, new Date(T0).toISOString(), 'no back-dated opening');
});

test('home pours: one each, you score yours, the crew guesses its style and ABV from your notes', () => {
  const closes = new Date(T0 + 86400000).toISOString();
  const s = C.newSession({ kind: 'samecan', mode: 'home', window: { closesAt: closes } }, A('m1'), T0, ids);
  const m = ['m1', 'm2', 'm3'];
  const b1 = C.addBeer(s, A('m1'), { name: 'Local Hazy', style: 'hazy', abv: 6.5 }, T0, ids, m);
  const b2 = C.addBeer(s, A('m2'), { name: 'Denver Lager', style: 'helles', abv: 4.8 }, T0, ids, m);
  assert.throws(() => C.addBeer(s, A('m1'), { name: 'Another' }, T0, ids, m), /already poured/);
  C.setScore(s, A('m1'), b1.id, { stars: 4.5, chips: ['juicy'], note: 'Like a smoothie', style: 'stout' }, T0);
  assert.deepStrictEqual([s.scores[b1.id].m1.stars, s.scores[b1.id].m1.style], [4.5, null], 'no style guess on your own');
  C.setScore(s, A('m2'), b1.id, { stars: 5, style: 'hazy', abv: 6.0, chips: ['sour'], note: 'x' }, T0);
  assert.deepStrictEqual([s.scores[b1.id].m2.stars, s.scores[b1.id].m2.style, s.scores[b1.id].m2.note], [null, 'hazy', ''], 'no stars on someone else’s pour');
  C.setScore(s, A('m2'), b2.id, { stars: 3 }, T0);
  C.setScore(s, A('m3'), b2.id, { style: 'pilsner', abv: 5 }, T0);
  C.setCity(s, A('m1'), 'Leeds', T0);
  const v = C.sessionView(s, m, 'm3', false, T0);
  const pour = v.beers.find((b) => b.id === b1.id);
  assert.deepStrictEqual([pour.name, pour.style, pour.abv, pour.poured, pour.city, pour.clues], [undefined, undefined, undefined, 'm1', 'Leeds', { chips: ['juicy'], note: 'Like a smoothie' }]);
  const r = C.results(s, m);
  assert.deepStrictEqual(r.beers.find((b) => b.id === b1.id).crowd, { mean: 4.5, half: 4.5, n: 1 }, 'only the person who poured it tasted it');
  assert.deepStrictEqual(r.awards.map((a) => [a.id, a.winners]), [['palate', ['m2']], ['abv', ['m3']], ['hometown', ['m1']]]);
});

/* ---------------- pure: polls ---------------- */

test('polls: approval voting, results after you vote, ties shown as ties and broken by whoever runs it', () => {
  const p = C.newPoll({ question: 'Where next?', options: ['Harbor Lane', '<b>Old Mill</b>', ''] }, A('m1'), T0, ids);
  assert.deepStrictEqual(p.options.map((o) => o.text), ['Harbor Lane', 'Old Mill']);
  const m = ['m1', 'm2', 'm3', 'm4'];
  const [a, b] = p.options.map((o) => o.id);
  C.vote(p, A('m1'), [a, b, a, 'nope'], T0);
  assert.deepStrictEqual(p.votes.m1, [a, b], 'deduplicated, unknown dropped');
  assert.throws(() => C.vote(p, A('m2'), ['nope'], T0), /at least one/);
  assert.throws(() => C.vote(p, A(null), [a], T0), /Join/);
  C.vote(p, A('m2'), [a], T0);
  assert.strictEqual(C.pollView(p, m, 'm3', false).results, undefined, 'no peeking before you vote');
  assert.strictEqual(C.pollView(p, m, 'm3', false).voters, 2, 'but you see how many have');
  C.vote(p, A('m3'), [b], T0);
  let r = C.pollView(p, m, 'm3', false).results;
  assert.deepStrictEqual(r.rows.map((x) => [x.id, x.n]), [[a, 2], [b, 2]]);
  assert.deepStrictEqual([r.tie, r.leaders, r.winner], [true, [a, b], null]);
  assert.throws(() => C.closePoll(p, A('m2'), null, m, T0), /Only whoever started/);
  assert.throws(() => C.closePoll(p, A('m1'), null, m, T0), /tie/);
  const c = C.addOption(p, A('m4'), 'Tidewater party', null, T0, ids);
  C.vote(p, A('m4'), [c.id, b], T0);
  r = C.pollResults(p, m);
  assert.deepStrictEqual([r.tie, r.winner], [false, b]);
  assert.throws(() => C.removeOption(p, A('m2'), c.id, T0), /not yours/);
  C.closePoll(p, A('m1'), null, m, T0);
  assert.deepStrictEqual([p.closed, p.pick], [true, b]);
  assert.throws(() => C.vote(p, A('m2'), [a], T0), /closed/);
  assert.ok(C.pollView(p, m, 'mnew', false).results, 'a closed vote shows to everyone');
  // A tie broken by the host's pick.
  const q = C.newPoll({ question: 'When?', options: ['Fri', 'Sat'] }, A('m2'), T0, ids);
  C.vote(q, A('m1'), [q.options[0].id], T0); C.vote(q, A('m3'), [q.options[1].id], T0);
  C.closePoll(q, A('m9', true), q.options[1].id, m, T0);
  assert.strictEqual(C.pollResults(q, m).winner, q.options[1].id);
  // A member who left takes their votes out of the count.
  assert.strictEqual(C.pollResults(q, ['m1', 'm2']).voters, 1);
});

/* ---------------- pure: the leaderboard ---------------- */

test('the leaderboard: points over revealed sessions in order, attendance streaks, palate profiles, the crew’s best beers', () => {
  const st = S.state(Date.now());
  const memberIds = st.crew.members.map((m) => m.id);
  const b = C.board(st.sessions, memberIds, Date.now());
  assert.strictEqual(b.sessions, 2, 'the open Same-Can Challenge does not count yet');
  assert.deepStrictEqual(b.rows.map((r) => r.member), ['mxmaya001', 'mxpriya01', 'mxsam0001', 'mxdev0001', 'mxjonah01']);
  assert.ok(b.rows.every((r) => r.sessions === 2 && r.streak === 2 && r.best === 2));
  assert.strictEqual(b.rows[0].points, 36);
  assert.strictEqual(b.topBeers[0].name, 'Fog Lantern');
  assert.ok(b.topBeers.some((x) => x.style === 'na-wheat'), 'a non-alcoholic beer is on the same board');
  const maya = b.rows.find((r) => r.member === 'mxmaya001');
  assert.strictEqual(maya.profile[0].family, 'lager');
  // Streaks: miss one revealed session and the run starts again.
  const s1 = blind([{ name: 'A', style: 'hazy', abv: 6, by: 'm1' }, { name: 'B', style: 'stout', abv: 5, by: 'm2' }]);
  const mk = (t, who) => { const s = JSON.parse(JSON.stringify(s1)); s.id = `s${t}`; s.revealedAt = new Date(T0 + t * 86400000).toISOString(); s.scores = {}; for (const m of who) s.scores[s.beers[0].id] = { ...(s.scores[s.beers[0].id] || {}), [m]: { stars: 4, style: null, abv: null, chips: [], note: '' } }; return s; };
  const sessions = [mk(3, ['m3']), mk(1, ['m3', 'm4']), mk(2, ['m4']), mk(4, ['m3', 'm4'])];
  const bb = C.board(sessions, ['m3', 'm4'], T0 + 10 * 86400000);
  const row = (id) => bb.rows.find((r) => r.member === id);
  assert.deepStrictEqual([row('m3').streak, row('m3').best, row('m3').sessions], [2, 2, 3], 'sorted by reveal date: 1,_,3,4');
  assert.deepStrictEqual([row('m4').streak, row('m4').best], [1, 2]);
  // An unrevealed blind tasting never counts.
  const open = mk(5, ['m3']); open.revealedAt = null;
  assert.strictEqual(C.board([open], ['m3'], T0).sessions, 0);
});

test('the example crew: a finished four-beer blind tasting with awards, an open Same-Can with two of five done, a poll with votes', () => {
  const st = S.state(Date.now());
  const memberIds = st.crew.members.map((m) => m.id);
  assert.strictEqual(memberIds.length, 5);
  const hazy = st.sessions.find((s) => s.title === 'Hazy vs West Coast');
  const r = C.results(hazy, memberIds);
  assert.strictEqual(hazy.beers.length, 4);
  assert.ok(r.awards.length >= 5, r.awards.map((a) => a.id).join());
  assert.strictEqual(r.beers.find((b) => b.id === r.ranked[0]).name, 'Fog Lantern');
  const can = st.sessions.find((s) => s.kind === 'samecan');
  const v = C.sessionView(can, memberIds, S.ME, false, Date.now());
  assert.strictEqual(v.stage, 'open');
  assert.strictEqual(v.progress.filter((p) => p.done >= p.of).length, 2);
  assert.strictEqual(v.progress.find((p) => p.member === S.ME).done, 0, 'the visitor has a can to score');
  assert.ok(Object.keys(st.polls[0].votes).length >= 3 && !st.polls[0].votes[S.ME], 'the visitor has not voted yet');
  const text = JSON.stringify(st);
  assert.ok(!/@/.test(text), 'no addresses');
  const links = text.match(/https?:\/\/[^"]*/g) || [];
  assert.ok(links.length >= 2 && links.every((l) => /^https:\/\/[a-z0-9-]+\.example\//.test(l)), `no live links - only the reserved .example domain: ${links.join(' ')}`);
});

/* ---------------- pure: Cellar & Swap ---------------- */

const cid = { item: () => `i${++seq}x`, gift: () => `g${++seq}x`, square: () => `q${++seq}x` };
const have = (id, name, brewery, style, swap = true, extra = {}) => ({ id, name, brewery, style, size: null, count: null, note: '', swap, at: '', ...extra });
const want = (id, name, brewery, style, extra = {}) => ({ id, name, brewery, style, size: null, count: null, note: '', buyLink: null, sellerShips: null, at: '', ...extra });
const cel = (member, haves = [], wants = [], gifts = [], squares = []) => ({ crewId: 'c', member, haves, wants, gifts, squares });

test('cellar keys fold case, accents, punctuation, "&" and the corporate words - "Harbor Lane Brewing Co." is "harbor lane"', () => {
  assert.strictEqual(C.foldText('  Fög–Lantérn!! '), 'fog lantern');
  assert.strictEqual(C.foldText('Señorita'), C.foldText('SENORITA'));
  assert.strictEqual(C.foldText('Salt & Pepper'), 'salt and pepper');
  for (const b of ['The Tidewater Brewing Co.', 'Tidewater Brewing Company', 'tidewater', 'TIDEWATER BREWERY', 'Tidewater, LLC']) assert.strictEqual(C.breweryKey(b), 'tidewater', b);
  assert.strictEqual(C.breweryKey('Brewing Co.'), 'brewing co', 'all noise keeps the plain words rather than nothing');
  assert.strictEqual(C.breweryKey('Old Mill Ales'), 'old mill ales', '"ales" can be the name - it stays');
  assert.strictEqual(C.beerKey('Harbor Lane Brewing Co.', 'Dark Harbor'), C.beerKey('harbor lane', 'DARK-HARBOR'));
  assert.strictEqual(C.beerKey('x', '!!!'), '', 'no name, no key');
  assert.strictEqual(C.foldText('静岡'), '静岡', 'a name with no Latin letters keeps its own form');
  // Levels: 3 the same beer, 2 the same brewery, 1 the same style.
  const w = want('w', 'Fog Lantern', 'Tidewater Brewing', 'hazy');
  assert.strictEqual(C.matchLevel(w, have('h', 'fog lantern', 'The Tidewater Brewing Co.', 'ipa')), 3);
  assert.strictEqual(C.matchLevel(w, have('h', 'Fog Lantern', '', null)), 3, 'a missing brewery on one side still matches by name');
  assert.strictEqual(C.matchLevel(w, have('h', 'Fog Lantern', 'Copycat Ales', 'hazy')), 1, 'same name, different brewery: not the same beer');
  assert.strictEqual(C.matchLevel(w, have('h', 'Low Tide Saison', 'Tidewater Brewing Company', 'saison')), 2);
  assert.strictEqual(C.matchLevel(w, have('h', 'Juice Box', 'Elsewhere', 'hazy')), 1);
  assert.strictEqual(C.matchLevel(want('w', 'X', '', 'other'), have('h', 'Y', '', 'other')), 0, '"something else" is not a style match');
});

test('matches: two-way first, then one-way, same brewery, same style; only open-to-swap bottles, never a wish already being gifted', () => {
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  const by = {
    m1: cel('m1', [have('a1', 'Dark Harbor', 'Harbor Lane', 'imperial-stout'), have('a2', 'Sunday Lawn', 'Clearwater', 'na-wheat'), have('a3', 'Hoarded', 'Old Mill', 'barleywine', false)],
      [want('b1', 'Fog Lantern', 'Tidewater Brewing', 'hazy'), want('b2', 'Pacific Static', 'Driftline', 'west-coast'), want('b3', 'Gifted One', 'Elsewhere', 'gose', { buyLink: 'https://x.example/' })],
      [{ id: 'g1', want: 'b3', by: 'm6', claimedAt: '2026-10-01T00:00:00Z', arrivedAt: null }]),
    m5: cel('m5', [have('e1', 'Other Hazy', 'Nobody', 'hazy')], []),
    m4: cel('m4', [have('d1', 'Low Tide Saison', 'Tidewater Brewing Company', 'saison')], []),
    m3: cel('m3', [], [want('c1', 'dark harbor', 'Harbor Lane Brewing Co.', 'imperial-stout')]),
    m2: cel('m2', [have('f1', 'Fog Lantern', 'The Tidewater Brewing Co.', 'hazy'), have('f2', 'Pacific Static', 'Driftline', 'west-coast', false)], [want('f3', 'Sunday Lawn', '', null)]),
    m6: cel('m6', [have('g2', 'Gifted One', 'Elsewhere', 'gose'), have('g3', 'Old Mill thing', 'Old Mill', 'barleywine')], [want('g4', 'Hoarded', 'Old Mill', 'barleywine')]),
  };
  const ms = C.cellarMatches(by, 'm1', ids);
  assert.deepStrictEqual(ms.map((m) => [m.member, m.kind]), [['m2', 'two-way'], ['m3', 'one-way'], ['m4', 'brewery'], ['m5', 'style']]);
  assert.deepStrictEqual(ms[0].gets.map((g) => g.haveName), ['Fog Lantern'], 'Pacific Static is not open to swap');
  assert.deepStrictEqual(ms[0].gives.map((g) => g.haveName), ['Sunday Lawn']);
  assert.deepStrictEqual([ms[1].gets.length, ms[1].gives[0].haveName], [0, 'Dark Harbor'], 'they want what I have, folded through "Brewing Co."');
  assert.deepStrictEqual(ms[2].gets.map((g) => [g.wantName, g.haveName, g.level]), [['Fog Lantern', 'Low Tide Saison', 2]]);
  assert.ok(!ms.some((m) => m.member === 'm6'), 'a wish someone is gifting is out, and a bottle I keep is not offered');
  // The other way round, m2 sees the same pair as two-way; m6 sees nothing of m1's kept bottle.
  assert.strictEqual(C.cellarMatches(by, 'm2', ids).find((m) => m.member === 'm1').kind, 'two-way');
  // A kind outranks more lines: a style match with many lines stays below a one-way.
  const many = { ...by, m5: cel('m5', [have('e1', 'H1', 'N', 'hazy'), have('e2', 'H2', 'N2', 'west-coast')], [want('e3', 'Stout', 'Q', 'imperial-stout'), want('e4', 'NA', 'R', 'na-wheat')]) };
  assert.deepStrictEqual(C.cellarMatches(many, 'm1', ids).map((m) => m.kind), ['two-way', 'one-way', 'brewery', 'style']);
  // My own bottles never match my own wishes.
  assert.deepStrictEqual(C.cellarMatches({ m1: cel('m1', [have('x', 'Same', 'B', 'hazy')], [want('y', 'Same', 'B', 'hazy')]) }, 'm1', ['m1']), []);
});

test('cellar lines: bounded and stripped, a fixed style list and formats, counts 1-99, 60 haves and 60 wants, only your own', () => {
  const doc = C.newCellar('c', 'm1', T0);
  const it = C.addItem(doc, A('m1'), 'haves', { name: '<b>Fog</b> Lantern‮', brewery: 'Tidewater\u0000', style: 'hazy', size: 'crowler', count: '4', note: 'x'.repeat(500), swap: true, price: 9, address: '1 Main St', shipTo: 'Denver' }, T0, cid);
  assert.deepStrictEqual(Object.keys(it).sort(), ['at', 'brewery', 'count', 'id', 'name', 'note', 'size', 'style', 'swap']);
  assert.deepStrictEqual([it.name, it.brewery, it.count, it.size, Array.from(it.note).length], ['Fog Lantern', 'Tidewater', 4, 'crowler', C.LIMITS.note]);
  for (const bad of [{ name: '' }, { name: '!!' }, { name: 'X', style: 'nope' }, { name: 'X', size: 'keg' }, { name: 'X', count: 0 }, { name: 'X', count: 100 }, { name: 'X', count: 2.5 }, { name: 'X', count: 'lots' }]) {
    assert.throws(() => C.addItem(doc, A('m1'), 'haves', bad, T0, cid), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => C.addItem(doc, A('m2'), 'haves', { name: 'X' }, T0, cid), /not your list/);
  assert.throws(() => C.editItem(doc, A('m2'), it.id, { name: 'Y' }, T0), /not your list/);
  assert.throws(() => C.addItem(doc, A('m1'), 'stash', { name: 'X' }, T0, cid), (e) => e.status === 404);
  // An edit keeps what it does not mention.
  C.editItem(doc, A('m1'), it.id, { swap: false }, T0);
  assert.deepStrictEqual([doc.haves[0].name, doc.haves[0].swap, doc.haves[0].count], ['Fog Lantern', false, 4]);
  const w = C.addItem(doc, A('m1'), 'wants', { name: 'Dark Harbor', buyLink: 'https://Harbor-Lane.example/shop', sellerShips: 'maybe' }, T0, cid);
  assert.deepStrictEqual(Object.keys(w).sort(), ['at', 'brewery', 'buyLink', 'count', 'id', 'name', 'note', 'sellerShips', 'size', 'style']);
  assert.deepStrictEqual([w.buyLink, w.sellerShips], ['https://harbor-lane.example/shop', null], 'only yes / no / unsure');
  for (let i = doc.haves.length; i < C.LIMITS.haves; i++) C.addItem(doc, A('m1'), 'haves', { name: `Beer ${i}` }, T0, cid);
  assert.throws(() => C.addItem(doc, A('m1'), 'haves', { name: 'One more' }, T0, cid), /holds 60/);
  for (let i = doc.wants.length; i < C.LIMITS.wants; i++) C.addItem(doc, A('m1'), 'wants', { name: `Wish ${i}` }, T0, cid);
  assert.throws(() => C.addItem(doc, A('m1'), 'wants', { name: 'One more' }, T0, cid), /holds 60/);
  C.removeItem(doc, A('m1'), it.id, T0);
  assert.strictEqual(doc.haves.length, C.LIMITS.haves - 1);
});

test('"where to buy it legally" is https only: http, javascript:, data:, other schemes, user info and junk are refused; it is never fetched', () => {
  assert.strictEqual(C.cleanLink('  https://Shop.Tidewater.example/fog?size=4  '), 'https://shop.tidewater.example/fog?size=4');
  assert.strictEqual(C.cleanLink(''), null);
  assert.strictEqual(C.cleanLink(null), null);
  for (const bad of [
    'http://shop.example/x', 'javascript:alert(1)', 'JavaScript:alert(1)//https://x.example', 'data:text/html,<script>x</script>', 'ftp://shop.example/x',
    'mailto:a@b.example', 'file:///etc/passwd', 'vbscript:x', '//shop.example/x', 'shop.example/x', 'https://user:pw@shop.example/', 'https://localhost/x',
    'https:javascript:alert(1)', 'https://shop.example/a b', 'https://shop.example/"onmouseover=x', 'https://shop.example/‮x', `https://shop.example/${'a'.repeat(300)}`,
    'https://[::1]/x', 42, { href: 'https://x.example' },
  ]) assert.throws(() => C.cleanLink(bad), (e) => e.status === 400, String(bad));
  assert.strictEqual(C.linkHost('https://www.shop.example/x'), 'shop.example');
  // Nothing in the server or the rules fetches it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'public', 'flight-core.js'), 'utf8');
  assert.ok(!/fetch\([^)]*buyLink/.test(src) && !/readCrawl\([^)]*buyLink/.test(src));
});

test('swaps: proposed -> accepted | declined -> done when both tick, or cancelled; only the two can act, never your own accept, closed stays closed', () => {
  const ids = ['m1', 'm2', 'm3'];
  const mine = cel('m1', [have('h1', 'Dark Harbor', 'Harbor Lane', 'imperial-stout', true, { count: 2 })]);
  const theirs = cel('m2', [have('h2', 'Fog Lantern', 'Tidewater', 'hazy'), have('h3', 'Kept', 'X', 'pilsner', false)]);
  const tasting = { id: 'snight001', kind: 'blind', stage: 'setup', title: 'Thursday’s tasting', revealedAt: null };
  const mk = (extra) => C.newSwap({ to: 'm2', give: [{ item: 'h1', n: 2 }], get: ['h2'], session: 'snight001', ...extra }, A('m1'), mine, theirs, ids, tasting, T0);
  const w = mk();
  assert.deepStrictEqual([w.state, w.sessionTitle, w.where, w.give[0].n, w.get[0].name], ['proposed', 'Thursday’s tasting', '', 2, 'Fog Lantern']);
  assert.deepStrictEqual(Object.keys(w).sort(), ['createdAt', 'decidedAt', 'doneAt', 'from', 'get', 'give', 'session', 'sessionTitle', 'state', 'ticks', 'to', 'updatedAt', 'v', 'where']);
  // Bad proposals.
  assert.throws(() => mk({ to: 'm1' }), /yourself/);
  assert.throws(() => mk({ to: 'mstranger' }), /someone in the crew/);
  assert.throws(() => mk({ give: [], get: [] }), /at least one/);
  assert.throws(() => mk({ get: ['h3'] }), /open to swap/);
  assert.throws(() => mk({ give: [{ item: 'h1', n: 3 }] }), /Up to 2/);
  assert.throws(() => mk({ give: ['nope'] }), /isn’t on the list/);
  assert.throws(() => C.newSwap({ to: 'm2', give: ['h1'], session: 'sgone0001' }, A('m1'), mine, theirs, ids, null, T0), /isn’t in this crew/);
  assert.throws(() => C.newSwap({ to: 'm2', give: ['h1'], session: 'x' }, A('m1'), mine, theirs, ids, { ...tasting, revealedAt: new Date(T0).toISOString() }, T0), /over/);
  assert.throws(() => C.newSwap({ to: 'm2', give: ['h1'], session: 'x' }, A('m1'), mine, theirs, ids, { ...tasting, kind: 'samecan', window: { opensAt: new Date(T0).toISOString(), closesAt: new Date(T0 + 86400000).toISOString() } }, T0), /played apart/);
  const gift = C.newSwap({ to: 'm2', give: ['h1'], get: [], where: '<i>Saturday</i> at the taproom' }, A('m1'), mine, theirs, ids, null, T0);
  assert.deepStrictEqual([gift.get, gift.where, gift.session], [[], 'Saturday at the taproom', null], 'nothing back - a gift; a place in a few words');
  assert.strictEqual(C.newSwap({ to: 'm2', get: ['h2'] }, A('m1'), null, theirs, ids, null, T0).where, 'At our next tasting');
  // The state machine.
  assert.throws(() => C.swapAct(w, A('m3'), 'accept', T0), (e) => e.status === 404, 'a third member: it does not exist for them');
  assert.throws(() => C.swapAct(w, A(null), 'accept', T0), (e) => e.status === 404);
  assert.throws(() => C.swapAct(w, A('m1'), 'accept', T0), /can’t accept your own/);
  assert.throws(() => C.swapAct(w, A('m1'), 'decline', T0), /cancel it instead/);
  assert.throws(() => C.swapAct(w, A('m2'), 'cancel', T0), /Decline it instead/);
  assert.throws(() => C.swapAct(w, A('m1'), 'swapped', T0), /Accept it first/);
  assert.throws(() => C.swapAct(w, A('m2'), 'explode', T0), (e) => e.status === 404);
  C.swapAct(w, A('m2'), 'accept', T0);
  assert.throws(() => C.swapAct(w, A('m2'), 'accept', T0), /already been accepted/);
  C.swapAct(w, A('m1'), 'swapped', T0 + 1);
  C.swapAct(w, A('m1'), 'unswapped', T0 + 2);
  C.swapAct(w, A('m1'), 'swapped', T0 + 3);
  assert.strictEqual(w.state, 'accepted', 'one tick is not enough');
  C.swapAct(w, A('m2'), 'swapped', T0 + 4);
  assert.deepStrictEqual([w.state, w.doneAt], ['done', new Date(T0 + 4).toISOString()]);
  for (const [who, act] of [['m1', 'cancel'], ['m2', 'swapped'], ['m2', 'decline'], ['m1', 'unswapped']]) assert.throws(() => C.swapAct(w, A(who), act, T0), /nothing more to do/, `${who} ${act}`);
  const d = mk(); C.swapAct(d, A('m2'), 'decline', T0);
  assert.throws(() => C.swapAct(d, A('m2'), 'accept', T0), /declined - nothing more/);
  const c = mk(); C.swapAct(c, A('m2'), 'accept', T0); C.swapAct(c, A('m2'), 'cancel', T0);
  assert.strictEqual(c.state, 'cancelled', 'either can cancel an accepted swap');
  // What each one sees: a swap from the receiver's side reads the other way round.
  const v2 = C.cellarView([mine, theirs], [{ ...mk(), id: 'wv1' }], ids, 'm2', T0).swaps[0];
  assert.deepStrictEqual([v2.outgoing, v2.give[0].name, v2.get[0].name, v2.can.accept, v2.can.cancel], [false, 'Fog Lantern', 'Dark Harbor', true, false]);
  assert.deepStrictEqual(C.cellarView([mine, theirs], [{ ...mk(), id: 'wv1' }], ids, 'm3', T0).swaps, [], 'a third member does not see an open swap');
});

test('gifts: only through a seller’s link, never to yourself, one claimer at a time, only they can let it go, only the recipient says it arrived', () => {
  const doc = cel('m1', [], [want('w1', 'Pacific Static', 'Driftline', 'west-coast', { buyLink: 'https://driftline.example/shop' }), want('w2', 'No Link', 'X', null)]);
  assert.throws(() => C.claimGift(doc, A('m1'), 'w1', T0, cid), /yourself/);
  assert.throws(() => C.claimGift(doc, A('m2'), 'w2', T0, cid), /licensed seller/);
  assert.throws(() => C.claimGift(doc, A('m2'), 'nope', T0, cid), (e) => e.status === 404);
  assert.throws(() => C.claimGift(doc, A(null), 'w1', T0, cid), /Join/);
  const g = C.claimGift(doc, A('m2'), 'w1', T0, cid);
  assert.deepStrictEqual(Object.keys(g).sort(), ['arrivedAt', 'brewery', 'by', 'claimedAt', 'id', 'name', 'want']);
  assert.throws(() => C.claimGift(doc, A('m3'), 'w1', T0, cid), /Someone’s already on this one/);
  assert.throws(() => C.claimGift(doc, A('m2'), 'w1', T0, cid), /already on it/);
  assert.throws(() => C.unclaimGift(doc, A('m3'), 'w1', T0), /Only whoever claimed it/);
  assert.throws(() => C.giftArrived(doc, A('m2'), 'w1', T0), /Only whoever wished for it/);
  C.unclaimGift(doc, A('m2'), 'w1', T0);
  assert.strictEqual(C.activeGift(doc, 'w1'), null);
  assert.throws(() => C.giftArrived(doc, A('m1'), 'w1', T0), /Nobody’s on that one/);
  C.claimGift(doc, A('m3'), 'w1', T0, cid);
  const v = C.cellarView([doc], [], ['m1', 'm2', 'm3'], 'm2', T0);
  assert.deepStrictEqual(v.members[0].wants[0].gift, { by: 'm3', claimedAt: new Date(T0).toISOString() }, 'the crew sees who is on it');
  C.giftArrived(doc, A('m1'), 'w1', T0 + 1000);
  assert.ok(!doc.wants.some((w) => w.id === 'w1'), 'the wish comes off the list');
  assert.strictEqual(doc.gifts.filter((x) => x.arrivedAt).length, 1, 'the gift stays, for the tally');
  // Taking a wish off lets its claimer off; an arrived gift stays.
  const d2 = cel('m1', [], [want('w3', 'Z', '', null, { buyLink: 'https://z.example/' })]);
  C.claimGift(d2, A('m2'), 'w3', T0, cid);
  C.removeItem(d2, A('m1'), 'w3', T0);
  assert.deepStrictEqual(d2.gifts, []);
});

test('IOUs: counted from arrived gifts and one-sided swaps, in time order, offset one at a time by "squared up" - never stored, never money', () => {
  const ids = ['m1', 'm2', 'm3'];
  const at = (h) => new Date(T0 + h * 3600000).toISOString();
  const gift = (id, by, h) => ({ id, want: 'w', by, name: 'X', brewery: '', claimedAt: at(h - 1), arrivedAt: at(h) });
  const sw = (id, from, to, give, get, h, state = 'done') => ({ id, from, to, give: give.map((n) => ({ item: 'i', name: n, n: 1 })), get: get.map((n) => ({ item: 'i', name: n, n: 1 })), state, doneAt: state === 'done' ? at(h) : null });
  const cellars = [cel('m1', [], [], [gift('ga', 'm2', 1)]), cel('m2', [], [], [], [{ id: 'q1', with: 'm1', at: at(4) }, { id: 'q2', with: 'm1', at: at(5) }, { id: 'q3', with: 'm1', at: at(6) }])];
  const swaps = [
    sw('w1', 'm2', 'm1', ['Gift'], [], 2),            // one-sided, m2 gave m1: m1 owes m2
    sw('w2', 'm1', 'm2', ['A'], ['B'], 3),            // two-way: nothing owed
    sw('w3', 'm2', 'm1', ['Open'], [], 3, 'accepted'), // not done: nothing yet
    sw('w4', 'm1', 'm3', [], ['Asked for'], 2),        // m1 got without giving: m1 owes m3
  ];
  // At hour 3 (before any square): m1 owes m2 two (a gift + a one-sided swap), m1 owes m3 one.
  const early = C.tallies([cellars[0], cel('m2')], swaps, ids);
  assert.strictEqual(C.owedBetween(early, 'm1', 'm2'), -2);
  assert.strictEqual(C.owedBetween(early, 'm2', 'm1'), 2);
  assert.strictEqual(C.owedBetween(early, 'm1', 'm3'), -1);
  assert.strictEqual(C.owedBetween(early, 'm2', 'm3'), 0);
  // Three squares from m2: two settle it, the third finds them level and does nothing.
  const t = C.tallies(cellars, swaps, ids);
  assert.strictEqual(C.owedBetween(t, 'm1', 'm2'), 0);
  // A later gift the other way starts a new debt - the extra square was not banked.
  cellars[1].gifts.push(gift('gb', 'm1', 7));
  assert.strictEqual(C.owedBetween(C.tallies(cellars, swaps, ids), 'm1', 'm2'), 1, 'm2 owes m1 one');
  // The view: from m1's side.
  const v = C.cellarView(cellars, swaps, ids, 'm1', T0);
  assert.deepStrictEqual(v.ious, [{ member: 'm2', n: 1 }, { member: 'm3', n: -1 }]);
  // Someone who left takes their side of it with them.
  assert.deepStrictEqual(C.cellarView(cellars, swaps, ['m1', 'm2'], 'm1', T0).ious, [{ member: 'm2', n: 1 }]);
  // Squaring up needs something to square.
  const mine = C.newCellar('c', 'm3', T0);
  assert.throws(() => C.squareUp(mine, A('m3'), 'm2', 0, ids, T0, cid), /square already/);
  assert.throws(() => C.squareUp(mine, A('m3'), 'm3', 1, ids, T0, cid), /someone in the crew/);
  assert.throws(() => C.squareUp(mine, A('m2'), 'm1', 1, ids, T0, cid), /not your list/);
  C.squareUp(mine, A('m3'), 'm1', 1, ids, T0, cid);
  assert.deepStrictEqual(Object.keys(mine.squares[0]).sort(), ['at', 'id', 'with']);
});

test('the example crew’s Cellar: a two-way match, a done in-person swap, a claimed gift and IOUs both ways - with no price, address or shipping field', () => {
  const st = S.state(Date.now());
  const ids = st.crew.members.map((m) => m.id);
  const v = C.cellarView(st.cellars, st.swaps, ids, S.ME, Date.now());
  assert.deepStrictEqual(v.matches.map((m) => [m.member, m.kind]).slice(0, 2), [['mxmaya001', 'two-way'], ['mxpriya01', 'one-way']]);
  assert.ok(v.feed.some((f) => f.kind === 'swap' && f.give.length && f.get.length && f.sessionTitle === 'Lager night'), 'an in-person swap at a tasting');
  const pacific = v.members.find((m) => m.member === S.ME).wants.find((w) => w.name === 'Pacific Static');
  assert.strictEqual(pacific.gift.by, 'mxpriya01', 'Priya is on it');
  assert.ok(v.ious.some((x) => x.n > 0) && v.ious.some((x) => x.n < 0), JSON.stringify(v.ious));
  assert.ok(v.swaps.some((w) => w.state === 'proposed' && w.can.accept), 'an open proposal for the visitor');
  const keys = new Set();
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { keys.add(k); walk(x); } };
  walk({ cellars: st.cellars, swaps: st.swaps });
  assert.deepStrictEqual([...keys].filter((k) => MONEY_OR_ADDRESS.test(k)), ['sellerShips'], 'only the member’s own yes/no about a licensed seller');
});

// What must never be a field anywhere in Cellar & Swap. `sellerShips` - the
// member's own answer about a licensed seller - is the one key it lets past.
const MONEY_OR_ADDRESS = /price|pay|cost|amount|usd|money|cash|fee|address|addr|street|zip|postal|city|ship|carrier|tracking|courier|parcel/i;

/* ---------------- pure: Hopscotch links ---------------- */

const HOP = 'beer.strongtechnicalconsulting.com';
const crawlJson = { crawl: { title: 'River <b>district</b> crawl', city: 'Portland', state: 'Oregon', stops: [{ name: 'Harbor Lane' }, { name: 'Tidewater\u202e' }, { nope: 1 }], totalMiles: 1.94, by: 'Maya', owner: 'tag', userId: 'x' } };
function fakeFetch(handler) {
  const seen = [];
  const f = async (url, opts) => { seen.push({ url, opts }); return handler(url, opts); };
  f.seen = seen;
  return f;
}
const jsonRes = (body, extra = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(extra.headers || {}) } });

test('Hopscotch links: https on the one Hopscotch host, the /c/<id> path, nothing else is ever fetched', async () => {
  assert.strictEqual(hop.HOST(), HOP, 'the default host');
  assert.strictEqual(hop.shareIdFrom(`https://${HOP}/c/s_0abc123XYZ`), 's_0abc123XYZ');
  assert.strictEqual(hop.shareIdFrom(`Let's do this one: https://${HOP}/c/s_0abc/ !`), 's_0abc');
  for (const bad of [
    `http://${HOP}/c/s_1`, `https://${HOP}:8443/c/s_1`, `https://user:pw@${HOP}/c/s_1`, `https://evil.com/c/s_1`,
    `https://${HOP}.evil.com/c/s_1`, `https://evil.com/?${HOP}/c/s_1`, 'https://34.120.0.1/c/s_1', 'https://[::1]/c/s_1',
    `https://${HOP}/p/s_1`, `https://${HOP}/c/s_1/../../api/admin`, `https://${HOP}/c/${'a'.repeat(61)}`, `https://${HOP}/c/a%2Fb`,
    'ftp://x', 'just text', '',
  ]) assert.strictEqual(hop.shareIdFrom(bad), null, bad);
  const f = fakeFetch(() => jsonRes(crawlJson));
  hop._setFetch(f);
  try {
    for (const bad of [`http://${HOP}/c/s_1`, 'https://34.120.0.1/c/s_1', `https://evil.com/c/s_1`]) assert.strictEqual(await hop.readCrawl(bad), null);
    assert.strictEqual(f.seen.length, 0, 'none of those was fetched');
    const c = await hop.readCrawl(`https://${HOP}/c/s_good`);
    assert.strictEqual(f.seen[0].url, `https://${HOP}/api/shared-crawl/s_good`);
    assert.strictEqual(f.seen[0].opts.redirect, 'manual', 'redirects are never followed');
    assert.ok(f.seen[0].opts.signal, 'a timeout is wired in');
    assert.deepStrictEqual(c, { title: 'River district crawl', place: 'Portland, Oregon', stops: ['Harbor Lane', 'Tidewater'], miles: 1.9, by: 'Maya', url: `https://${HOP}/c/s_good` });
  } finally { hop._setFetch(null); }
});

test('Hopscotch links: a redirect, a non-JSON answer, a body over 64 KB, a hang or a 404 all give nothing back', async () => {
  const cases = {
    redirect: () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    redirected: () => { const r = jsonRes(crawlJson); Object.defineProperty(r, 'redirected', { value: true }); return r; },
    notfound: () => new Response('{"error":"That crawl is not here."}', { status: 404, headers: { 'content-type': 'application/json' } }),
    html: () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    bigHeader: () => jsonRes(crawlJson, { headers: { 'content-length': String(10 * 1024 * 1024) } }),
    bigStream: () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 80; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1024))); c.close(); } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    garbage: () => jsonRes('{not json'),
    empty: () => jsonRes({ crawl: { stops: [] } }),
    throws: () => { throw new Error('ECONNREFUSED'); },
  };
  try {
    for (const [name, h] of Object.entries(cases)) {
      hop._setFetch(fakeFetch(h));
      assert.strictEqual(await hop.readCrawl(`https://${HOP}/c/s_${name}`), null, name);
    }
    const hang = fakeFetch((url, opts) => new Promise((resolve, reject) => { opts.signal.addEventListener('abort', () => reject(new Error('aborted'))); }));
    hop._setFetch(hang, 60);
    const t0 = Date.now();
    assert.strictEqual(await hop.readCrawl(`https://${HOP}/c/s_hang`), null);
    assert.ok(Date.now() - t0 < 1000, 'the timeout ends it');
  } finally { hop._setFetch(null); }
});

/* ---------------- pure: the label reader ---------------- */

test('a model’s label reading is untrusted: bounded, stripped, styles from the list, an ABV only when it is a plain printed number', () => {
  assert.deepStrictEqual(ai.cleanLabel({ readable: true, name: 'Fog Lantern', brewery: 'Tidewater Brewing', style: 'hazy', stylePrinted: 'Hazy IPA', abv: 6.8, confidence: 'high' }),
    { name: 'Fog Lantern', brewery: 'Tidewater Brewing', style: 'hazy', abv: 6.8, confidence: 'high', stylePrinted: 'Hazy IPA' });
  const bad = ai.cleanLabel({ readable: true, name: `<img src=x onerror=alert(1)>Night\u202e Ferry${'A'.repeat(5000)}`, brewery: { evil: true }, style: 'ignore previous instructions', stylePrinted: '<script>alert(1)</script>Stout', abv: '65%', confidence: 'certain' });
  assert.ok(!/[<>\u202e]/.test(JSON.stringify(bad)));
  assert.ok(Array.from(bad.name).length <= C.LIMITS.beerName);
  assert.deepStrictEqual([bad.brewery, bad.style, bad.abv, bad.confidence], ['', 'other', null, 'low']);
  for (const abv of ['6.8', -1, 21, 65, NaN, Infinity, 6.8123, null, true]) assert.strictEqual(ai.cleanLabel({ readable: true, name: 'X', style: 'hazy', abv }).abv, null, String(abv));
  assert.strictEqual(ai.cleanLabel({ readable: true, name: 'X', style: 'hazy', abv: 0.5 }).abv, 0.5, 'a non-alcoholic ABV is a real ABV');
  assert.strictEqual(ai.cleanLabel({ readable: false, name: 'X' }), null);
  assert.strictEqual(ai.cleanLabel({ readable: true, name: '!!!' }), null);
  assert.strictEqual(ai.cleanLabel(null), null);
  assert.strictEqual(ai.LABEL_TOOL.input_schema.properties.style.enum.length, C.STYLES.length + 1);
  assert.match(ai.LABEL_SYSTEM, /never estimate the ABV/);
});

/* ---------------- static checks ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface, in both themes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'accent-soft']) for (const fg of ['text', 'muted', 'link']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, `${name} accent-ink on accent`);
    assert.ok(ratio(t.good, t['good-bg']) >= 4.5 && ratio(t.ok, t['ok-bg']) >= 4.5, `${name} tags`);
    assert.ok(ratio(t.err, t.card) >= 4.5, `${name} errors`);
    assert.ok(ratio(t['strip-ink'], t.strip) >= 4.5 && ratio(t['strip-btn-ink'], t['strip-btn']) >= 4.5, `${name} the strip`);
    assert.ok(ratio(t.star, t.card) >= 3, `${name} stars (graphics, 3:1)`);
  }
  assert.ok(ratio('#5d4f3c', '#ffffff') >= 4.5 && ratio('#5c2f00', '#ffffff') >= 4.5, 'the QR screens');
  assert.ok(ratio('#111111', '#ffffff') >= 4.5, 'the QR code');
});

test('the QR encoder draws a join link', () => {
  const svg = QR.svg('https://challenge.strongtechnicalconsulting.com/flight/j/ABCDEF', 'Join "x" <crew>');
  assert.ok(svg.startsWith('<svg') && !/<crew>|"x"/.test(svg));
  assert.ok(QR.matrix('https://example.com/flight/j/ABCDEF').length >= 21);
});

test('local-only switches throw on Cloud Run', () => {
  const dir = path.join(__dirname, '..');
  for (const [mod, env] of [['./lib/store', { FLIGHT_MEMORY: '1' }], ['./lib/fakeai', { FLIGHT_FAKE_AI: '1' }], ['./server', { FLIGHT_FAKE_AI: '1', FLIGHT_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, env: { ...process.env, FLIGHT_MEMORY: '', FLIGHT_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, FLIGHT_MEMORY: '', FLIGHT_COLLECTION_PREFIX: 'flight_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');
  assert.ok(/FLIGHT_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 9, 'every Firestore path is prefixed');
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, nothing logged from a body', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input) =/.test(js.replace(/img\.on(load|error) =/g, '')), 'handlers by addEventListener, not properties');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.ok(!/<script/i.test(js), 'no script written into markup');
  assert.ok(/Drink responsibly\. 21\+ where required\./.test(js), 'the responsible line, once');
  assert.strictEqual((js.match(/Drink responsibly/g) || []).length, 1);
  for (const f of ['server.js', 'lib/ai.js', 'lib/crews.js', 'lib/photo.js', 'lib/hopscotch.js', 'public/flight-core.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|photo|name|note|raw|crawl|text)/.test(src), `${f} logs a body`);
  }
  // A fun game, not a drinking game.
  const all = js + fs.readFileSync(path.join(__dirname, '..', 'public', 'flight-core.js'), 'utf8');
  for (const word of [/chug/i, /most drinks/i, /shotgun/i, /drinking game/i, /pints? (drunk|downed)/i]) assert.ok(!word.test(all), String(word));
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}

test('signed out: the page, the example and its files work with zero model calls; nothing private does', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  const meta = (await anon('GET', '/api/meta')).data;
  assert.deepStrictEqual([meta.styles.length, meta.families.length, meta.limits.members, meta.hopscotchHost], [C.STYLES.length, 10, 20, HOP]);
  for (const f of ['flight-core.js', 'sample.js', 'qr.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  for (const [m, p] of [['POST', '/api/snap'], ['POST', '/api/crews'], ['GET', '/api/crews']]) assert.strictEqual((await anon(m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`);
  assert.strictEqual((await anon('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg() } })).status, 401);
  assert.strictEqual((await anon('POST', '/api/snap', { photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } })).status, 401, 'the gate answers before the big parser');
  assert.strictEqual((await anon('POST', '/api/join/ABCDEF', { name: 'x'.repeat(100 * 1024) })).status, 413, 'every other route keeps the small limit');
  for (const p of ['/c/AAAAAAAAAAAAAAAA', '/j/ABCDEF']) {
    const r = await fetch(`${base}${p}`);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('<base href="../">'), 'deep links resolve assets from the app root');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the snap route’s gates come before its 6 MB parser, in order; no other route holds a model client', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/snap', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  for (const [p, m] of [['/api/crews', 'get'], ['/api/crews', 'post'], ['/api/crews/:cid', 'patch'], ['/api/crews/:cid', 'delete'], ['/api/crews/:cid/code', 'post'], ['/api/crews/:cid/seat', 'post']]) assert.strictEqual(layer(p, m).route.stack[0].handle.name, 'requireUser', `${m} ${p}`);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1);
});

let host, CREW, CODE, hostMid;

test('snap a label: the photo checked before any spend, one metered call, a proposal for review, nothing stored', async () => {
  host = await register('maya.host@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await host('POST', '/api/snap', {})).status, 400);
  assert.strictEqual((await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4 nope').toString('base64') } })).status, 400);
  assert.strictEqual((await host('POST', '/api/snap', { photo: { type: 'image/gif', data: jpeg() } })).status, 400);
  assert.strictEqual((await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } })).status, 400, 'over 4 MB');
  assert.strictEqual((await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } })).status, 413, 'over the 6 MB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const r = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg() } });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.label, { name: 'Fog Lantern', brewery: 'Tidewater Brewing', style: 'hazy', abv: 6.8, confidence: 'high', stylePrinted: 'Hazy IPA' });
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual((await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('NOABV') } })).data.label.abv, null, 'no ABV printed, none invented');
  const inj = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('INJECT') } });
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.deepStrictEqual([inj.data.label.style, inj.data.label.abv], ['other', null]);
  const blank = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('BLANK') } });
  assert.deepStrictEqual([blank.status, /No beer name/.test(blank.data.error)], [422, true]);
  assert.match((await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('MAXTOKENS') } })).data.error, /could not be read in one go/);
  const up = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('UPSTREAM401') } });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await host('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg('UPSTREAM529') } });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'snapping stores nothing');
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg() } });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/flight/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/snap', { photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } })).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('POST', '/api/crews', { name: 'Eve’s crew', hostName: 'Eve' })).status, 200, 'a crew needs no AI and no confirmed address');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  const r = await cal('POST', '/api/snap', { photo: { type: 'image/jpeg', data: jpeg() } });
  assert.strictEqual(r.status, 402);
  assert.strictEqual((await cal('POST', '/api/snap', { photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } })).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('a host starts a crew; a guest with no account joins by code with a name and an emoji and gets an opaque seat', async () => {
  const r = await host('POST', '/api/crews', { name: 'Thursday <i>Pour</i> Crew', hostName: 'Maya', emoji: '🦊' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  CREW = r.id || r.data.id; CODE = r.data.crew.code; hostMid = r.data.crew.me;
  assert.ok(K.isCrewId(CREW) && K.isCode(CODE));
  assert.deepStrictEqual([r.data.crew.name, r.data.crew.host, r.data.crew.members.length], ['Thursday Pour Crew', true, 1]);
  const guest = client();
  const look = await guest('GET', `/api/join/${CODE.toLowerCase().replace(/(...)/, '$1-')}`);
  assert.strictEqual(look.status, 200, 'the code is read however it is typed');
  assert.deepStrictEqual([look.data.name, look.data.members, look.data.already], ['Thursday Pour Crew', 1, null]);
  assert.ok(!/Maya/.test(look.text), 'a code shows the crew, not who is in it');
  assert.strictEqual(guest.cookies.flight_k, undefined, 'looking mints nothing');
  const j = await guest('POST', `/api/join/${CODE}`, { name: '<b>Dev</b> \u202e', emoji: '🐙' });
  assert.strictEqual(j.status, 200, JSON.stringify(j.data));
  assert.strictEqual(j.data.crewId, CREW);
  const ck = j.setCookie.find((c) => c.startsWith('flight_k='));
  assert.match(ck, /^flight_k=[A-Za-z0-9_-]{22}; Path=\/flight\/; Max-Age=\d+; SameSite=Lax; HttpOnly/, 'HttpOnly, scoped to the app path');
  const v = await guest('GET', `/api/crews/${CREW}`);
  assert.strictEqual(v.status, 200);
  assert.deepStrictEqual(v.data.crew.members.map((m) => [m.name, m.emoji, m.host]), [['Maya', '🦊', true], ['Dev', '🐙', false]]);
  assert.strictEqual(v.data.crew.me, j.data.me);
  assert.ok(/^m[a-z0-9]{9}$/.test(j.data.me), 'a random per-crew id');
  assert.ok(!/ownerTag|acctTags|keyHash|"acct"|example\.com|bWF5YS/.test(v.text), 'no tag, hash, account id or email reaches a member');
  assert.strictEqual((await guest('POST', `/api/join/${CODE}`, { name: 'Someone else' })).data.me, j.data.me, 'a browser that joined gets itself back');
  const other = client();
  const taken = await other('POST', `/api/join/${CODE}`, { name: 'dev' });
  assert.deepStrictEqual([taken.status, /already called/.test(taken.data.error)], [409, true]);
  const pri = await other('POST', `/api/join/${CODE}`, { name: 'Priya', emoji: '<svg>' });
  assert.strictEqual(pri.status, 200);
  assert.ok(C.EMOJI.includes((await other('GET', `/api/crews/${CREW}`)).data.crew.members.find((m) => m.name === 'Priya').emoji), 'an emoji off the list becomes one on it');
  assert.strictEqual((await client()('POST', `/api/join/${CODE}`, { name: '  ' })).status, 400);
  assert.strictEqual((await host('POST', `/api/join/${CODE}`, { name: 'Maya again' })).data.me, hostMid, 'the host is already in their own crew');
});

test('a stranger gets the same 404 a missing crew gets, on every route - signed in or not', async () => {
  const strangers = [client(), await register('olly.other@example.com')];
  const S1 = 'snope12345';
  const routes = [
    ['GET', ''], ['POST', '/me', { name: 'x' }], ['POST', '/sessions', { kind: 'blind' }], ['GET', `/sessions/${S1}`],
    ['POST', `/sessions/${S1}/beers`, { name: 'x' }], ['PUT', `/sessions/${S1}/scores/b1`, { stars: 4 }], ['POST', `/sessions/${S1}/reveal`, {}],
    ['POST', '/polls', { question: 'x' }], ['PUT', '/polls/pnope12345/vote', { options: [] }], ['DELETE', `/members/${hostMid}`],
  ];
  for (const s of strangers) {
    for (const [m, p, b] of routes) {
      const r = await s(m, `/api/crews/${CREW}${p}`, b);
      assert.strictEqual(r.status, 404, `${m} ${p}`);
      const missing = await s(m, `/api/crews/BBBBBBBBBBBBBBBB${p}`, b);
      assert.deepStrictEqual([r.data.error], [missing.data.error], 'the same answer as a crew that does not exist');
    }
  }
  const olly = strangers[1];
  for (const [m, p, b] of [['PATCH', '', { name: 'x' }], ['POST', '/code', {}], ['DELETE', ''], ['POST', '/seat', {}]]) assert.strictEqual((await olly(m, `/api/crews/${CREW}${p}`, b)).status, 404, `host route ${m} ${p}`);
});

let dev, pri, SID;

test('a blind tasting over HTTP: members bring beers in secret, the host starts it, guests score only as themselves', async () => {
  dev = client(); pri = client();
  await dev('POST', `/api/join/${CODE}`, { name: 'Sam' });
  await pri('POST', `/api/join/${CODE}`, { name: 'Ana' });
  const devMid = (await dev('GET', `/api/crews/${CREW}`)).data.crew.me;
  const priMid = (await pri('GET', `/api/crews/${CREW}`)).data.crew.me;
  let r = await dev('POST', `/api/crews/${CREW}/sessions`, { kind: 'blind', title: 'Hazy vs West Coast' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  SID = r.data.id;
  assert.deepStrictEqual([r.data.stage, r.data.canRun], ['setup', true], 'any member can start one and runs it');
  r = await dev('POST', `/api/crews/${CREW}/sessions/${SID}/beers`, { name: 'Night Ferry', brewery: 'Harbor Lane', style: 'oatmeal-stout', abv: '5.9' });
  assert.strictEqual(r.status, 200);
  r = await pri('POST', `/api/crews/${CREW}/sessions/${SID}/beers`, { name: 'Switchback West', style: 'west-coast', abv: 7.2, broughtBy: devMid });
  assert.deepStrictEqual([r.status, /Only whoever runs/.test(r.data.error)], [403, true], 'a guest cannot add a beer as someone else');
  await pri('POST', `/api/crews/${CREW}/sessions/${SID}/beers`, { name: 'Switchback West', style: 'west-coast', abv: 7.2 });
  await host('POST', `/api/crews/${CREW}/sessions/${SID}/beers`, { name: 'Fog Lantern', brewery: 'Tidewater', style: 'hazy', abv: 6.8 });
  const peek = (await pri('GET', `/api/crews/${CREW}/sessions/${SID}`)).text;
  assert.ok(!/Night Ferry|Fog Lantern|oatmeal|hazy/.test(peek) && /Switchback West/.test(peek), 'Priya sees only hers');
  assert.strictEqual((await pri('POST', `/api/crews/${CREW}/sessions/${SID}/start`, {})).status, 403, 'only whoever runs it starts it');
  assert.strictEqual((await host('POST', `/api/crews/${CREW}/sessions/${SID}/start`, {})).status, 200, 'the crew’s host can');
  const v = (await pri('GET', `/api/crews/${CREW}/sessions/${SID}`)).data;
  assert.deepStrictEqual(v.beers.map((b) => b.label).sort(), ['A', 'B', 'C']);
  const mine = v.beers.find((b) => b.mine);
  const other = v.beers.find((b) => !b.mine);
  assert.strictEqual((await pri('PUT', `/api/crews/${CREW}/sessions/${SID}/scores/${mine.id}`, { stars: 5 })).status, 409, 'not your own beer');
  // A member id in the body changes nothing: a score is always the caller's own.
  r = await pri('PUT', `/api/crews/${CREW}/sessions/${SID}/scores/${other.id}`, { stars: 4.5, style: 'hazy', abv: 6.7, chips: ['juicy', 'nope'], note: '<b>Mango</b>', member: devMid, mid: devMid });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual(r.data.mine.scores[other.id].chips, ['juicy']);
  assert.strictEqual(r.data.mine.scores[other.id].note, 'Mango');
  const doc = await store.get('sessions', SID);
  assert.deepStrictEqual(Object.keys(doc.scores[other.id]), [priMid], 'stored under Priya, whatever the body said');
  assert.strictEqual((await pri('PUT', `/api/crews/${CREW}/sessions/${SID}/scores/${other.id}`, { stars: 7 })).status, 400, 'an out-of-range star is refused');
  assert.strictEqual((await pri('PUT', `/api/crews/${CREW}/sessions/${SID}/scores/${other.id}`, { stars: 4, abv: 'lots' })).status, 400);
  assert.strictEqual((await store.get('sessions', SID)).scores[other.id][priMid].stars, 4.5, 'and the score already there stands');
  assert.strictEqual((await pri('PUT', `/api/crews/${CREW}/sessions/${SID}/guesses/${mine.id}`, { who: devMid })).status, 409, 'no guessing your own');
  assert.strictEqual((await pri('PUT', `/api/crews/${CREW}/sessions/${SID}/guesses/${other.id}`, { who: priMid })).status, 400, 'no guessing yourself');
  assert.strictEqual((await pri('PUT', `/api/crews/${CREW}/sessions/${SID}/guesses/${other.id}`, { who: devMid })).status, 200);
  assert.strictEqual((await pri('POST', `/api/crews/${CREW}/sessions/${SID}/reveal`, {})).status, 403, 'a guest cannot reveal');
  assert.strictEqual((await pri('DELETE', `/api/crews/${CREW}/sessions/${SID}`)).status, 403, 'or delete');
  assert.strictEqual((await pri('DELETE', `/api/crews/${CREW}/members/${devMid}`)).status, 403, 'or remove someone');
  assert.strictEqual((await pri('PATCH', `/api/crews/${CREW}`, { name: 'Mine now' })).status, 401, 'host routes need an account');
});

test('two phones scoring the same beer at the same moment both stick', async () => {
  const s = await host('POST', `/api/crews/${CREW}/sessions`, { kind: 'blind', title: 'Race night' });
  const sid = s.data.id;
  await host('POST', `/api/crews/${CREW}/sessions/${sid}/beers`, { name: 'One', broughtBy: null });
  await host('POST', `/api/crews/${CREW}/sessions/${sid}/beers`, { name: 'Two', broughtBy: null });
  await host('POST', `/api/crews/${CREW}/sessions/${sid}/start`, {});
  const phones = [];
  for (let i = 0; i < 6; i++) { const p = client(); await p('POST', `/api/join/${CODE}`, { name: `Racer ${i}` }); phones.push(p); }
  const beers = (await host('GET', `/api/crews/${CREW}/sessions/${sid}`)).data.beers.map((b) => b.id);
  const calls = [];
  phones.forEach((p, k) => beers.forEach((b) => calls.push(p('PUT', `/api/crews/${CREW}/sessions/${sid}/scores/${b}`, { stars: 1 + (k % 5), style: 'hazy' }))));
  const results = await Promise.all(calls);
  assert.ok(results.every((x) => x.status === 200), results.map((x) => x.status).join(','));
  const doc = await store.get('sessions', sid);
  for (const b of beers) assert.strictEqual(Object.keys(doc.scores[b]).length, 6, 'every phone’s score is there');
  // The queue is what keeps them: the same two writes without it lose one.
  await store.set('race', 'doc', { scores: {} });
  const naive = (who) => store._unsafeUpdate('race', 'doc', (cur) => ({ scores: { ...cur.scores, [who]: 1 } }));
  await Promise.all([naive('a'), naive('b')]);
  assert.strictEqual(Object.keys((await store.get('race', 'doc')).scores).length, 1, 'without the transaction one score is lost');
  await store.remove('race', 'doc');
  for (const p of phones) await p('DELETE', `/api/crews/${CREW}/members/${(await p('GET', `/api/crews/${CREW}`)).data.crew.me}`);
});

test('the reveal over HTTP: results, awards and the crew’s leaderboard; polling is cheap until something moves', async () => {
  const before = (await dev('GET', `/api/crews/${CREW}`)).data;
  const same = await dev('GET', `/api/crews/${CREW}?since=${before.crew.v}`);
  assert.deepStrictEqual(same.data, { same: true, v: before.crew.v });
  const sv = (await dev('GET', `/api/crews/${CREW}/sessions/${SID}`)).data;
  assert.deepStrictEqual((await dev('GET', `/api/crews/${CREW}/sessions/${SID}?since=${sv.v}&stage=${sv.stage}`)).data, { same: true, v: sv.v });
  const r = await dev('POST', `/api/crews/${CREW}/sessions/${SID}/reveal`, {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.stage, 'revealed');
  assert.ok(r.data.results.awards.length >= 1);
  assert.ok(r.data.beers.every((b) => b.name && b.style), 'everything is out');
  const moved = await dev('GET', `/api/crews/${CREW}?since=${before.crew.v}`);
  assert.ok(moved.data.crew && moved.data.board.sessions >= 1, 'the crew moved, and its board counts the reveal');
  assert.strictEqual((await pri('PUT', `/api/crews/${CREW}/sessions/${SID}/scores/${r.data.beers[0].id}`, { stars: 1 })).status, 409, 'scoring is closed');
});

test('a Same-Can Challenge over HTTP closes on the read after its window, with nothing written', async () => {
  const closes = new Date(Date.now() + 2 * 86400000).toISOString();
  const r = await host('POST', `/api/crews/${CREW}/sessions`, { kind: 'samecan', beer: { name: 'Cold Snap Pils', brewery: 'Ridgeback', style: 'pilsner', abv: 5 }, window: { closesAt: closes } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const sid = r.data.id;
  const view = (await dev('GET', `/api/crews/${CREW}/sessions/${sid}`)).data;
  assert.deepStrictEqual([view.stage, view.beers[0].name, view.beers[0].style], ['open', 'Cold Snap Pils', undefined]);
  await dev('PUT', `/api/crews/${CREW}/sessions/${sid}/city`, { city: 'Austin' });
  await dev('PUT', `/api/crews/${CREW}/sessions/${sid}/scores/${view.beers[0].id}`, { stars: 4, style: 'pilsner', abv: 5.1 });
  const v1 = (await dev('GET', `/api/crews/${CREW}/sessions/${sid}`)).data;
  // The window passes (moved in the store - there is no timer to wait for).
  await store.merge('sessions', sid, { window: { closesAt: new Date(Date.now() - 1000).toISOString() } });
  const doc = await store.get('sessions', sid);
  const v2 = await dev('GET', `/api/crews/${CREW}/sessions/${sid}?since=${v1.v}&stage=${v1.stage}`);
  assert.strictEqual(v2.data.stage, 'revealed', 'a "since" from before the close is not "same"');
  assert.ok(v2.data.results.awards.some((a) => a.id === 'palate'));
  assert.deepStrictEqual(await store.get('sessions', sid), doc, 'closing on read writes nothing');
  assert.strictEqual((await pri('PUT', `/api/crews/${CREW}/sessions/${sid}/scores/${view.beers[0].id}`, { stars: 2 })).status, 409);
  assert.strictEqual((await host('POST', `/api/crews/${CREW}/sessions`, { kind: 'samecan', beer: { name: 'X' }, window: { closesAt: new Date(Date.now() + 60000).toISOString() } })).status, 400, 'at least an hour');
});

test('votes over HTTP: approval, results after voting, a Hopscotch link becomes a crawl card - and on any failure keeps its text', async () => {
  const f = fakeFetch((url) => (/s_good/.test(url) ? jsonRes(crawlJson) : new Response('', { status: 302, headers: { location: 'https://evil.example/' } })));
  hop._setFetch(f);
  try {
    const r = await dev('POST', `/api/crews/${CREW}/polls`, { question: 'Where next?', options: [`https://${HOP}/c/s_good`, 'Harbor Lane taproom', `https://${HOP}/c/s_moved`, 'https://evil.example/c/s_good'] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const pid = r.data.id;
    assert.deepStrictEqual(r.data.options.map((o) => o.text), ['River district crawl · Portland, Oregon', 'Harbor Lane taproom', `https://${HOP}/c/s_moved`, 'https://evil.example/c/s_good']);
    assert.deepStrictEqual(r.data.options.map((o) => Boolean(o.crawl)), [true, false, false, false]);
    assert.strictEqual(f.seen.length, 2, 'only the two Hopscotch links were fetched');
    assert.ok(f.seen.every((x) => x.url.startsWith(`https://${HOP}/api/shared-crawl/`)));
    const [a, b] = r.data.options.map((o) => o.id);
    assert.strictEqual(r.data.results, undefined, 'no results before you vote');
    const v = await pri('PUT', `/api/crews/${CREW}/polls/${pid}/vote`, { options: [a, b] });
    assert.deepStrictEqual([v.status, v.data.results.rows[0].n, v.data.voted], [200, 1, true]);
    await dev('PUT', `/api/crews/${CREW}/polls/${pid}/vote`, { options: [b] });
    const added = await pri('POST', `/api/crews/${CREW}/polls/${pid}/options`, { text: `https://${HOP}/c/s_good` });
    assert.ok(added.data.options.some((o) => o.crawl && o.crawl.url === `https://${HOP}/c/s_good`));
    assert.strictEqual((await pri('POST', `/api/crews/${CREW}/polls/${pid}/close`, {})).status, 403, 'only whoever started it closes it');
    const closed = await dev('POST', `/api/crews/${CREW}/polls/${pid}/close`, {});
    assert.deepStrictEqual([closed.data.closed, closed.data.results.winner], [true, b]);
    // A stranger's link is never fetched.
    const before = f.seen.length;
    await client()('POST', `/api/crews/${CREW}/polls/${pid}/options`, { text: `https://${HOP}/c/s_good` });
    assert.strictEqual(f.seen.length, before);
  } finally { hop._setFetch(null); }
});

/* ---------------- Cellar & Swap over HTTP ---------------- */

let cAna, cSam, cPri, cDee, CC, cMid = {};
const cel$ = (p) => `/api/crews/${CC}${p}`;
const itemId = (bundle, mid, list, name) => bundle.members.find((m) => m.member === mid)[list].find((x) => x.name === name).id;

test('cellar over HTTP: members add haves and wants as themselves, links https only, typed text stripped - and nobody can write anyone else’s list', async () => {
  cAna = await register('ana.cellar@example.com');
  const c = await cAna('POST', '/api/crews', { name: 'Cellar crew', hostName: 'Ana', emoji: '🦊' });
  CC = c.data.id; cMid.ana = c.data.crew.me;
  for (const [k, n] of [['sam', 'Sam'], ['pri', 'Priya'], ['dee', 'Dee']]) {
    const cl = client();
    await cl('POST', `/api/join/${c.data.crew.code}`, { name: n });
    cMid[k] = (await cl('GET', `/api/crews/${CC}`)).data.crew.me;
    if (k === 'sam') cSam = cl; else if (k === 'pri') cPri = cl; else cDee = cl;
  }
  const empty = await cSam('GET', cel$('/cellar'));
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual([empty.data.matches, empty.data.swaps, empty.data.ious, empty.data.feed], [[], [], [], []]);
  let r = await cSam('POST', cel$('/cellar/haves'), { name: '<b>Fog Lantern</b>‮', brewery: 'Tidewater Brewing', style: 'hazy', size: 'can', count: 4, note: '<img src=x onerror=alert(1)>Juicy', swap: true, price: 12, address: '1 Main St', member: cMid.ana });
  assert.strictEqual(r.status, 200, r.text);
  const fog = r.data.members.find((m) => m.member === cMid.sam).haves[0];
  assert.deepStrictEqual([fog.name, fog.note, fog.swap, fog.count], ['Fog Lantern', 'Juicy', true, 4]);
  assert.ok(!('price' in fog) && !('address' in fog));
  assert.strictEqual(r.data.members.find((m) => m.member === cMid.ana).haves.length, 0, 'a member id in the body changes nothing - it is the caller’s own list');
  await cSam('POST', cel$('/cellar/haves'), { name: 'Sunday Lawn', brewery: 'Clearwater', style: 'na-wheat', size: 'can', count: 6, swap: true });
  await cSam('POST', cel$('/cellar/haves'), { name: 'Copper Kettle', brewery: 'Old Mill', style: 'marzen', swap: false });
  for (const bad of ['http://harbor-lane.example/shop', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://harbor-lane.example/', 'https://u:p@harbor-lane.example/']) {
    const x = await cSam('POST', cel$('/cellar/wants'), { name: 'Dark Harbor', buyLink: bad });
    assert.deepStrictEqual([x.status, /https link/.test(x.data.error)], [400, true], bad);
  }
  r = await cSam('POST', cel$('/cellar/wants'), { name: 'Dark Harbor', brewery: 'Harbor Lane', style: 'imperial-stout', buyLink: 'https://harbor-lane.example/shop', sellerShips: 'yes' });
  assert.strictEqual(r.status, 200);
  await cSam('POST', cel$('/cellar/wants'), { name: 'Pacific Static', brewery: 'Driftline', style: 'west-coast', buyLink: 'https://driftline.example/shop', sellerShips: 'unsure' });
  await cSam('POST', cel$('/cellar/wants'), { name: 'No Link Lager', style: 'helles' });
  for (const bad of [{ name: 'X', size: 'keg' }, { name: 'X', count: 0 }, { name: 'X', style: 'nope' }, { name: '' }]) assert.strictEqual((await cSam('POST', cel$('/cellar/haves'), bad)).status, 400, JSON.stringify(bad));
  assert.strictEqual((await cSam('POST', cel$('/cellar/stash'), { name: 'X' })).status, 404);
  // Ana's lists, folded spellings included.
  await cAna('POST', cel$('/cellar/haves'), { name: 'dark harbor', brewery: 'Harbor Lane Brewing Co.', style: 'imperial-stout', size: 'bottle', count: 2, swap: true });
  r = await cAna('POST', cel$('/cellar/wants'), { name: 'FOG-LANTERN', brewery: 'The Tidewater Brewing Co.', style: 'hazy' });
  // Only your own lines: another member's item id is "not on your list".
  const samFog = itemId(r.data, cMid.sam, 'haves', 'Fog Lantern');
  assert.strictEqual((await cAna('PATCH', cel$(`/cellar/haves/${samFog}`), { name: 'Mine now' })).status, 404);
  assert.strictEqual((await cAna('DELETE', cel$(`/cellar/haves/${samFog}`))).status, 404);
  assert.strictEqual((await cSam('PATCH', cel$(`/cellar/haves/${samFog}`), { count: 3 })).data.members.find((m) => m.member === cMid.sam).haves[0].count, 3, 'you can edit your own');
  // Matches, both ways round.
  const anaView = (await cAna('GET', cel$('/cellar'))).data;
  assert.deepStrictEqual([anaView.matches[0].member, anaView.matches[0].kind], [cMid.sam, 'two-way']);
  assert.deepStrictEqual([anaView.matches[0].gets[0].haveName, anaView.matches[0].gives[0].haveName], ['Fog Lantern', 'dark harbor']);
  const samView = (await cSam('GET', cel$('/cellar'))).data;
  assert.strictEqual(samView.matches[0].kind, 'two-way');
  const v = (await cSam('GET', `/api/crews/${CC}`)).data.crew.v;
  assert.deepStrictEqual((await cSam('GET', cel$(`/cellar?since=${v}`))).data, { same: true, v }, 'an idle cellar costs one read');
});

test('cellar: a stranger gets the same 404 a missing crew gets, on every cellar and swap route', async () => {
  const strangers = [client(), await register('olly.cellar@example.com')];
  const routes = [
    ['GET', '/cellar'], ['POST', '/cellar/haves', { name: 'x' }], ['PATCH', '/cellar/haves/ixxxxxxx1', { name: 'x' }], ['DELETE', '/cellar/wants/ixxxxxxx1'],
    ['POST', `/cellar/wants/${cMid.sam}/ixxxxxxx1/gift`, {}], ['DELETE', `/cellar/wants/${cMid.sam}/ixxxxxxx1/gift`], ['POST', `/cellar/wants/${cMid.sam}/ixxxxxxx1/arrived`, {}],
    ['POST', '/ious/square', { with: cMid.sam }], ['POST', '/swaps', { to: cMid.sam, give: [] }], ['POST', '/swaps/wxxxxxxx1/accept', {}],
  ];
  for (const s of strangers) {
    for (const [m, p, b] of routes) {
      const r = await s(m, cel$(p), b);
      assert.strictEqual(r.status, 404, `${m} ${p}`);
      const missing = await s(m, `/api/crews/BBBBBBBBBBBBBBBB${p}`, b);
      assert.strictEqual(r.data.error, missing.data.error, 'the same answer as a crew that does not exist');
    }
  }
  assert.ok(!store._dump().includes('olly'), 'nothing was written for them');
});

test('swaps over HTTP: propose for a tasting, only the two can act, no accepting your own, both tick to finish; the crew sees it done', async () => {
  const b0 = (await cAna('GET', cel$('/cellar'))).data;
  const anaDH = itemId(b0, cMid.ana, 'haves', 'dark harbor'), samFog = itemId(b0, cMid.sam, 'haves', 'Fog Lantern'), samKept = itemId(b0, cMid.sam, 'haves', 'Copper Kettle');
  const night = (await cAna('POST', `/api/crews/${CC}/sessions`, { kind: 'blind', title: 'Thursday’s tasting' })).data.id;
  const can = (await cAna('POST', `/api/crews/${CC}/sessions`, { kind: 'samecan', beer: { name: 'Can' }, window: { closesAt: new Date(Date.now() + 2 * 86400000).toISOString() } })).data.id;
  assert.strictEqual((await cAna('POST', cel$('/swaps'), { to: cMid.sam, give: [anaDH], get: [samKept] })).status, 409, 'not open to swap');
  assert.strictEqual((await cAna('POST', cel$('/swaps'), { to: cMid.sam, give: [anaDH], get: [samFog], session: can })).status, 409, 'a Same-Can Challenge is apart');
  assert.strictEqual((await cAna('POST', cel$('/swaps'), { to: cMid.sam, give: [anaDH], session: 'snotreal01' })).status, 400);
  assert.strictEqual((await cAna('POST', cel$('/swaps'), { to: cMid.ana, give: [anaDH] })).status, 400, 'not with yourself');
  assert.strictEqual((await cAna('POST', cel$('/swaps'), { to: cMid.sam })).status, 400, 'something to give or get');
  let r = await cAna('POST', cel$('/swaps'), { to: cMid.sam, give: [{ item: anaDH, n: 1 }], get: [samFog], session: night, where: 'my place, 12 Elm St', price: 20, address: 'x', shipping: 'ups' });
  assert.strictEqual(r.status, 200, r.text);
  const w = r.data.swaps[0];
  assert.deepStrictEqual([w.state, w.outgoing, w.sessionTitle, w.where, w.give[0].name, w.get[0].name], ['proposed', true, 'Thursday’s tasting', '', 'dark harbor', 'Fog Lantern']);
  const stored = await store.get('swaps', w.id);
  assert.deepStrictEqual(Object.keys(stored).sort(), ['createdAt', 'crewId', 'decidedAt', 'doneAt', 'from', 'get', 'give', 'id', 'session', 'sessionTitle', 'state', 'ticks', 'to', 'updatedAt', 'v', 'where']);
  for (const l of [...stored.give, ...stored.get]) assert.deepStrictEqual(Object.keys(l).sort(), ['brewery', 'item', 'n', 'name', 'size', 'style']);
  assert.deepStrictEqual((await cPri('GET', cel$('/cellar'))).data.swaps, [], 'Priya does not see a swap she is not in');
  assert.strictEqual((await cPri('POST', cel$(`/swaps/${w.id}/accept`), {})).status, 404, 'only the two can act');
  assert.strictEqual((await cPri('POST', cel$(`/swaps/${w.id}/cancel`), {})).status, 404);
  assert.strictEqual((await cAna('POST', cel$(`/swaps/${w.id}/accept`), {})).status, 403, 'no accepting your own');
  assert.strictEqual((await cSam('POST', cel$(`/swaps/${w.id}/swapped`), {})).status, 409, 'accept first');
  assert.strictEqual((await cSam('POST', cel$(`/swaps/${w.id}/explode`), {})).status, 404);
  r = await cSam('POST', cel$(`/swaps/${w.id}/accept`), {});
  assert.deepStrictEqual([r.status, r.data.swaps[0].state, r.data.swaps[0].outgoing], [200, 'accepted', false]);
  assert.strictEqual((await cSam('POST', cel$(`/swaps/${w.id}/accept`), {})).status, 409);
  await cAna('POST', cel$(`/swaps/${w.id}/swapped`), {});
  r = await cSam('POST', cel$(`/swaps/${w.id}/swapped`), {});
  assert.strictEqual(r.data.swaps[0].state, 'done');
  for (const [cl, act] of [[cAna, 'cancel'], [cSam, 'decline'], [cSam, 'unswapped']]) assert.strictEqual((await cl('POST', cel$(`/swaps/${w.id}/${act}`), {})).status, 409, `closed stays closed: ${act}`);
  const pri = (await cPri('GET', cel$('/cellar'))).data;
  const f = pri.feed.find((x) => x.id === w.id);
  assert.deepStrictEqual([f.kind, f.sessionTitle, f.give, f.get], ['swap', 'Thursday’s tasting', ['dark harbor'], ['Fog Lantern']], 'the crew sees it in the feed');
  // A one-sided swap in a place typed by hand: the place stays between the two.
  const samLawn = itemId(pri, cMid.sam, 'haves', 'Sunday Lawn');
  r = await cSam('POST', cel$('/swaps'), { to: cMid.pri, give: [{ item: samLawn, n: 2 }], get: [], where: 'Saturday, 12 Elm St' });
  const w2 = r.data.swaps.find((x) => x.state === 'proposed');
  assert.deepStrictEqual([w2.where, w2.get], ['Saturday, 12 Elm St', []]);
  await cPri('POST', cel$(`/swaps/${w2.id}/accept`), {});
  await cPri('POST', cel$(`/swaps/${w2.id}/swapped`), {});
  await cSam('POST', cel$(`/swaps/${w2.id}/swapped`), {});
  const dee = await cDee('GET', cel$('/cellar'));
  assert.ok(dee.data.feed.some((x) => x.id === w2.id) && !/Elm St/.test(dee.text), 'the crew sees who gave what - never the place typed');
  assert.deepStrictEqual((await cSam('GET', cel$('/cellar'))).data.ious, [{ member: cMid.pri, n: 1 }], 'Priya owes Sam one');
  assert.deepStrictEqual((await cPri('GET', cel$('/cellar'))).data.ious, [{ member: cMid.sam, n: -1 }]);
  // Declined and cancelled.
  const w3 = (await cSam('POST', cel$('/swaps'), { to: cMid.ana, get: [anaDH] })).data.swaps.find((x) => x.state === 'proposed');
  await cAna('POST', cel$(`/swaps/${w3.id}/decline`), {});
  assert.strictEqual((await cAna('POST', cel$(`/swaps/${w3.id}/accept`), {})).status, 409);
  const w4 = (await cSam('POST', cel$('/swaps'), { to: cMid.ana, get: [anaDH] })).data.swaps.find((x) => x.state === 'proposed');
  assert.strictEqual((await cSam('POST', cel$(`/swaps/${w4.id}/cancel`), {})).data.swaps.find((x) => x.id === w4.id).state, 'cancelled');
});

test('gifts over HTTP: one claimer at a time (even at the same moment), never your own, the recipient says it arrived, and the tally follows', async () => {
  const b = (await cDee('GET', cel$('/cellar'))).data;
  const dh = itemId(b, cMid.sam, 'wants', 'Dark Harbor'), ps = itemId(b, cMid.sam, 'wants', 'Pacific Static'), nl = itemId(b, cMid.sam, 'wants', 'No Link Lager');
  const g = (mid, iid) => cel$(`/cellar/wants/${mid}/${iid}/gift`);
  assert.strictEqual((await cSam('POST', g(cMid.sam, dh), {})).status, 409, 'not to yourself');
  assert.strictEqual((await cDee('POST', g(cMid.sam, nl), {})).status, 409, 'no seller link, no gift');
  assert.strictEqual((await cDee('POST', g('mnotreal01', dh), {})).status, 404);
  // Two at the same moment: exactly one is on it.
  const race = await Promise.all([cDee('POST', g(cMid.sam, dh), {}), cPri('POST', g(cMid.sam, dh), {})]);
  assert.deepStrictEqual(race.map((x) => x.status).sort(), [200, 409]);
  const winner = race[0].status === 200 ? cDee : cPri, loser = winner === cDee ? cPri : cDee;
  const winMid = winner === cDee ? cMid.dee : cMid.pri;
  let v = (await cAna('GET', cel$('/cellar'))).data;
  assert.deepStrictEqual(v.members.find((m) => m.member === cMid.sam).wants.find((w) => w.id === dh).gift.by, winMid, 'the crew sees who is on it');
  assert.ok(!v.matches.some((m) => m.gives.some((x) => x.want === dh)), 'a wish being gifted drops out of Ana’s matches');
  assert.strictEqual((await loser('DELETE', g(cMid.sam, dh))).status, 403, 'only the claimer lets it go');
  assert.strictEqual((await winner('POST', cel$(`/cellar/wants/${cMid.sam}/${dh}/arrived`), {})).status, 403, 'only the recipient says it arrived');
  assert.strictEqual((await winner('DELETE', g(cMid.sam, dh))).status, 200);
  assert.strictEqual((await cDee('POST', g(cMid.sam, dh), {})).status, 200, 'free again');
  // The owner adding a line while someone claims another: both stick.
  const [add, claim] = await Promise.all([cSam('POST', cel$('/cellar/wants'), { name: 'Raced In' }), cPri('POST', g(cMid.sam, ps), {})]);
  assert.deepStrictEqual([add.status, claim.status], [200, 200]);
  const doc = await store.get('cellars', `${CC}_${cMid.sam}`);
  assert.ok(doc.wants.some((w) => w.name === 'Raced In') && doc.gifts.some((x) => x.want === ps && x.by === cMid.pri), 'both writes are there');
  // It arrives.
  const r = await cSam('POST', cel$(`/cellar/wants/${cMid.sam}/${dh}/arrived`), {});
  assert.strictEqual(r.status, 200);
  assert.ok(!r.data.members.find((m) => m.member === cMid.sam).wants.some((w) => w.id === dh), 'off the wishlist');
  assert.ok(r.data.feed.some((f) => f.kind === 'gift' && f.from === cMid.dee && f.to === cMid.sam));
  assert.deepStrictEqual(r.data.ious, [{ member: cMid.pri, n: 1 }, { member: cMid.dee, n: -1 }], 'Sam owes Dee one; Priya still owes Sam');
  // Squared up: one at a time, and only while something is owed.
  assert.strictEqual((await cSam('POST', cel$('/ious/square'), { with: cMid.ana })).status, 409, 'nothing owed between them');
  assert.strictEqual((await cSam('POST', cel$('/ious/square'), { with: cMid.sam })).status, 400);
  assert.deepStrictEqual((await cDee('POST', cel$('/ious/square'), { with: cMid.sam })).data.ious, [], 'either side can square it');
  assert.strictEqual((await cSam('POST', cel$('/ious/square'), { with: cMid.dee })).status, 409, 'level now');
});

test('cellar limits: 60 haves, 30 open swaps a crew', async () => {
  const room = await register('rae.limits@example.com');
  const c = await room('POST', '/api/crews', { name: 'Limit crew', hostName: 'Rae' });
  const id = c.data.id;
  const g = client();
  await g('POST', `/api/join/${c.data.crew.code}`, { name: 'Gus' });
  const gus = (await g('GET', `/api/crews/${id}`)).data.crew.me;
  for (let i = 0; i < C.LIMITS.haves; i++) assert.strictEqual((await room('POST', `/api/crews/${id}/cellar/haves`, { name: `Beer ${i}`, swap: true })).status, 200, `have ${i}`);
  const full = await room('POST', `/api/crews/${id}/cellar/haves`, { name: 'Sixty-one' });
  assert.deepStrictEqual([full.status, /holds 60/.test(full.data.error)], [409, true]);
  const first = (await room('GET', `/api/crews/${id}/cellar`)).data.members.find((m) => m.member !== gus).haves[0].id;
  for (let i = 0; i < C.LIMITS.swapsOpen; i++) assert.strictEqual((await room('POST', `/api/crews/${id}/swaps`, { to: gus, give: [first] })).status, 200, `swap ${i}`);
  const more = await room('POST', `/api/crews/${id}/swaps`, { to: gus, give: [first] });
  assert.deepStrictEqual([more.status, /30 swaps open/.test(more.data.error)], [409, true]);
  await room('DELETE', `/api/crews/${id}`);
  assert.ok(!store._dump().includes(id), 'deleting the crew takes its cellars and swaps');
});

test('cellar documents hold no price, payment, address or shipping field - only the shapes they are meant to have', async () => {
  const keys = new Set();
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { if (!/^m[a-z0-9]{9}$/.test(k)) keys.add(k); walk(x); } };
  const cellars = await store.list('cellars', {});
  const swaps = await store.list('swaps', {});
  assert.ok(cellars.length >= 3 && swaps.length >= 3);
  for (const d of cellars) {
    assert.deepStrictEqual(Object.keys(d).sort(), ['createdAt', 'crewId', 'gifts', 'haves', 'id', 'member', 'squares', 'updatedAt', 'v', 'wants']);
    for (const h of d.haves) assert.deepStrictEqual(Object.keys(h).sort(), ['at', 'brewery', 'count', 'id', 'name', 'note', 'size', 'style', 'swap']);
    for (const w of d.wants) assert.deepStrictEqual(Object.keys(w).sort(), ['at', 'brewery', 'buyLink', 'count', 'id', 'name', 'note', 'sellerShips', 'size', 'style']);
    for (const x of d.gifts) assert.deepStrictEqual(Object.keys(x).sort(), ['arrivedAt', 'brewery', 'by', 'claimedAt', 'id', 'name', 'want']);
    for (const q of d.squares) assert.deepStrictEqual(Object.keys(q).sort(), ['at', 'id', 'with']);
  }
  walk(cellars); walk(swaps);
  assert.deepStrictEqual([...keys].filter((k) => MONEY_OR_ADDRESS.test(k)), ['sellerShips']);
  const text = JSON.stringify([cellars, swaps]);
  assert.ok(!/12 Main|1 Main St|"price"|"address"|"shipping"/.test(text), 'nothing a request tried to add');
  // The page never asks for one either.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // (The Same-Can "where are you tasting it?" box is a city: address-level2.)
  for (const input of js.match(/<(input|select|textarea)[^>]*>/g) || []) assert.ok(!/address|street|postal|zip|price|cost|card|ship-to|shipping/i.test(input.replace(/sellerShips|iShips|"address-level2"/g, '')), input);
  assert.ok(!/autocomplete="(street-address|postal-code|address-line|cc-)/.test(js));
});

test('leaving or being removed takes a member’s cellar, wishlist, swaps, claims and squared-up marks with them', async () => {
  const has = (mid) => store._dump().includes(mid);
  const priMid = cMid.pri, deeMid = cMid.dee;
  assert.ok(has(priMid) && has(deeMid));
  // Priya: her own lists, a claim on Sam's wish, a done one-sided swap and her side of the tally.
  await cPri('POST', cel$('/cellar/haves'), { name: 'Low Tide Saison', swap: true });
  assert.strictEqual((await cAna('DELETE', `/api/crews/${CC}/members/${priMid}`)).status, 200, 'the host removes her');
  assert.ok(!has(priMid), 'nothing anywhere names her');
  assert.strictEqual(await store.get('cellars', `${CC}_${priMid}`), null);
  let sam = (await cSam('GET', cel$('/cellar'))).data;
  assert.ok(!sam.ious.some((x) => x.member === priMid) && !sam.swaps.some((w) => w.with === priMid));
  assert.strictEqual(sam.members.find((m) => m.member === cMid.sam).wants.find((w) => w.name === 'Pacific Static').gift, null, 'her claim is gone - someone else can gift it');
  // Dee leaves on her own: her gift to Sam and the squared-up mark go with her.
  assert.strictEqual((await cDee('DELETE', `/api/crews/${CC}/members/${deeMid}`)).status, 200);
  assert.ok(!has(deeMid));
  sam = (await cSam('GET', cel$('/cellar'))).data;
  assert.deepStrictEqual(sam.ious, []);
  assert.ok(!sam.feed.some((f) => f.from === deeMid || f.to === deeMid));
  assert.strictEqual((await cPri('GET', cel$('/cellar'))).status, 404, 'she is a stranger now');
  // Deleting the crew takes every cellar and swap.
  assert.strictEqual((await cAna('DELETE', `/api/crews/${CC}`)).status, 200);
  assert.ok(!store._dump().includes(CC));
});

test('keep my seat: a guest signs in and comes back as themselves on another device', async () => {
  const phone = client();
  await phone('POST', `/api/join/${CODE}`, { name: 'Jonah', emoji: '🌵' });
  const mid = (await phone('GET', `/api/crews/${CREW}`)).data.crew.me;
  const r = await phone('POST', '/api/auth/register', { email: 'jonah.seat@example.com', password: 'a long enough password' });
  assert.strictEqual(r.status, 200);
  const kept = await phone('POST', `/api/crews/${CREW}/seat`, {});
  assert.strictEqual(kept.status, 200);
  assert.strictEqual(kept.data.members.find((m) => m.id === mid).seat, true);
  const laptop = client();
  await laptop('POST', '/api/auth/login', { email: 'jonah.seat@example.com', password: 'a long enough password' });
  assert.strictEqual((await laptop('GET', `/api/crews/${CREW}`)).data.crew.me, mid, 'the same seat on a device that never joined');
  const mine = await laptop('GET', '/api/crews');
  assert.deepStrictEqual(mine.data.crews.map((c) => [c.id, c.host]), [[CREW, false]]);
  assert.ok(!store._dump().includes(uidOf('jonah.seat@example.com')), 'the crew holds a tag, never the account id');
  await phone('DELETE', `/api/crews/${CREW}/members/${mid}`);
  assert.strictEqual((await laptop('GET', `/api/crews/${CREW}`)).status, 404, 'leaving ends the seat everywhere');
});

test('host powers: rename, a new code (the old one dies, members stay), remove someone and everything they put in', async () => {
  assert.strictEqual((await host('PATCH', `/api/crews/${CREW}`, { name: 'The <b>Pour</b> Crew' })).data.name, 'The Pour Crew');
  const old = CODE;
  const r = await host('POST', `/api/crews/${CREW}/code`, {});
  CODE = r.data.code;
  assert.ok(K.isCode(CODE) && CODE !== old);
  assert.strictEqual((await client()('GET', `/api/join/${old}`)).status, 404, 'the old code is dead');
  assert.strictEqual((await dev('GET', `/api/crews/${CREW}`)).status, 200, 'members are unaffected');
  const priMid = (await pri('GET', `/api/crews/${CREW}`)).data.crew.me;
  assert.ok(store._dump().includes(priMid));
  const rm = await host('DELETE', `/api/crews/${CREW}/members/${priMid}`);
  assert.strictEqual(rm.status, 200);
  assert.ok(!rm.data.members.some((m) => m.id === priMid));
  assert.ok(!store._dump().includes(priMid), 'her scores, guesses and votes are gone from every session and poll');
  assert.ok(!store._dump().includes('Mango'), 'and her note with them');
  assert.strictEqual((await pri('GET', `/api/crews/${CREW}`)).status, 404, 'she is a stranger now');
  assert.strictEqual((await host('DELETE', `/api/crews/${CREW}/members/${hostMid}`)).status, 409, 'the host cannot leave their own crew');
});

test('limits: 20 members, new members per address, distinct wrong codes per address', async () => {
  const hana = await register('hana.host@example.com');
  const c = await hana('POST', '/api/crews', { name: 'Big crew', hostName: 'Hana' });
  const code = c.data.crew.code;
  const ip = freshIp();
  for (let i = 0; i < 19; i++) assert.strictEqual((await client(ip)('POST', `/api/join/${code}`, { name: `P${i}` })).status, 200, `member ${i}`);
  const full = await client()('POST', `/api/join/${code}`, { name: 'One too many' });
  assert.deepStrictEqual([full.status, /full - 20/.test(full.data.error)], [409, true]);
  const c2 = await hana('POST', '/api/crews', { name: 'Second crew', hostName: 'Hana' });
  for (let i = 0; i < 11; i++) assert.strictEqual((await client(ip)('POST', `/api/join/${c2.data.crew.code}`, { name: `Q${i}` })).status, 200, `new member ${i}`);
  const limited = await client(ip)('POST', `/api/join/${c2.data.crew.code}`, { name: 'Q11' });
  assert.deepStrictEqual([limited.status, /Too many new members/.test(limited.data.error)], [429, true]);
  assert.strictEqual((await client()('POST', `/api/join/${c2.data.crew.code}`, { name: 'From elsewhere' })).status, 200, 'another address is unaffected');
  const guesser = client();
  for (let i = 0; i < 40; i++) assert.strictEqual((await guesser('GET', '/api/join/ZZZZZZ')).status, 404);
  assert.strictEqual((await guesser('GET', `/api/join/${code}`)).status, 200, 'a dead code polled is not guessing');
  const alpha = K.CODE_ALPHABET;
  for (let i = 0, n = 0; n < 30; i++) { const g = `Z${alpha[i % 32]}${alpha[Math.floor(i / 32) % 32]}ZZZ`; if (g === code) continue; await guesser('GET', `/api/join/${g}`); n++; }
  const blocked = await guesser('GET', `/api/join/${code}`);
  assert.deepStrictEqual([blocked.status, /Too many wrong codes/.test(blocked.data.error)], [429, true], 'then even the right code waits');
  assert.strictEqual((await client()('GET', `/api/join/${code}`)).status, 200, 'another address is unaffected');
  // Ten crews per host.
  for (let i = 0; i < 8; i++) assert.strictEqual((await hana('POST', '/api/crews', { name: `Crew ${i}`, hostName: 'Hana' })).status, 200);
  const r = await hana('POST', '/api/crews', { name: 'Eleventh', hostName: 'Hana' });
  assert.deepStrictEqual([r.status, /run 10 crews/.test(r.data.error)], [409, true]);
});

test('delete removes everything: a session, a vote, and a whole crew with all of it', async () => {
  const s = await dev('POST', `/api/crews/${CREW}/sessions`, { kind: 'blind', title: 'Doomed night' });
  await dev('POST', `/api/crews/${CREW}/sessions/${s.data.id}/beers`, { name: 'Doomed Beer' });
  assert.ok(store._dump().includes('Doomed Beer'));
  assert.strictEqual((await dev('DELETE', `/api/crews/${CREW}/sessions/${s.data.id}`)).status, 200);
  assert.ok(!store._dump().includes('Doomed'), 'the session and its beers are gone');
  const p = await dev('POST', `/api/crews/${CREW}/polls`, { question: 'Doomed vote?', options: ['Yes'] });
  assert.strictEqual((await dev('DELETE', `/api/crews/${CREW}/polls/${p.data.id}`)).status, 200);
  assert.ok(!store._dump().includes('Doomed vote'));
  assert.ok(store._dump().includes(CREW));
  assert.strictEqual((await dev('DELETE', `/api/crews/${CREW}`)).status, 401, 'deleting the crew needs the host’s account');
  assert.strictEqual((await host('DELETE', `/api/crews/${CREW}`)).status, 200);
  const dump = store._dump();
  assert.ok(!dump.includes(CREW), 'no session, poll or crew document names it');
  for (const word of ['Hazy vs West Coast', 'Night Ferry', 'Where next?', 'Cold Snap Pils', 'The Pour Crew']) assert.ok(!dump.includes(word), word);
  assert.strictEqual((await dev('GET', `/api/crews/${CREW}`)).status, 404);
  assert.strictEqual((await client()('GET', `/api/join/${CODE}`)).status, 404);
});

test('a crew nobody has touched in 180 days is deleted by the read that finds it', async () => {
  const zed = await register('zed.idle@example.com');
  const c = await zed('POST', '/api/crews', { name: 'Sleepy crew', hostName: 'Zed' });
  const id = c.data.id;
  await zed('POST', `/api/crews/${id}/sessions`, { kind: 'blind', title: 'Sleepy night' });
  await store.merge('crews', id, { updatedAt: new Date(Date.now() - 181 * 86400000).toISOString() });
  const r = await zed('GET', `/api/crews/${id}`);
  assert.deepStrictEqual([r.status, r.data.code], [404, 'expired']);
  assert.ok(!store._dump().includes(id) && !store._dump().includes('Sleepy'));
});

test('stored crews, sessions and polls hold no email, no account id, no browser key and no photo', async () => {
  const g = client();
  const zz = await register('zz.store@example.com');
  const c = await zz('POST', '/api/crews', { name: 'Store check', hostName: 'Zz' });
  await g('POST', `/api/join/${c.data.crew.code}`, { name: 'Keyholder' });
  const dump = store._dump();
  for (const email of ['maya.host@example.com', 'hana.host@example.com', 'olly.other@example.com', 'jonah.seat@example.com', 'zz.store@example.com']) {
    assert.ok(!dump.includes(email), `no email: ${email}`);
    assert.ok(!dump.includes(uidOf(email)), `no account id: ${email}`);
  }
  assert.ok(g.cookies.flight_k && !dump.includes(g.cookies.flight_k), 'the browser key itself is never stored');
  assert.ok(!dump.includes(MARK) && !dump.includes('/9j/'), 'no photo bytes');
  const doc = await store.get('crews', c.data.id);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['acctTags', 'code', 'createdAt', 'id', 'members', 'name', 'ownerTag', 'updatedAt', 'v'].sort());
  for (const m of doc.members) assert.deepStrictEqual(Object.keys(m).sort(), ['acct', 'emoji', 'host', 'id', 'joinedAt', 'keyHash', 'name'].sort());
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  hostApp.use('/flight', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/flight`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
