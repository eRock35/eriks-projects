// Pure rules first, then end to end against the memory store and the fake
// model:
//   PAWLOG_MEMORY=1 PAWLOG_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /pawlog, the way the
// lab mounts it, so the auth cookie, the budget gate, shared homes, the
// household and sitter links, sync and the metered route's parser are
// exercised as deployed. Model calls are counted from the identity's usage
// rows - the same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.PAWLOG_MEMORY !== '1' || process.env.PAWLOG_FAKE_AI !== '1') {
  console.error('run with PAWLOG_MEMORY=1 PAWLOG_FAKE_AI=1');
  process.exit(1);
}
process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const { app, identityStore, store, fakeClient } = require('../server');
const C = require('../public/pawlog-core');
const ai = require('../lib/ai');
const H = require('../lib/homes');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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
    return { status: res.status, data, text, headers: res.headers };
  };
  call.cookies = cookies;
  return call;
}

const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const NY = 'America/New_York';
const LDN = 'Europe/London';
let n = 0;
const ids = (p) => `${p}test${String(++n).padStart(6, '0')}`;
const HOSTILE = ['<img src=x onerror=alert(1)>Rex', '"><svg onload=alert(1)>', '\u202eMiso\u202c', 'Bi\u2066scuit\u2069 <script>x</script>'];
/** A small household: one dog with the template routine, Sam and Alex. */
function home(nowMs, tz) {
  const doc = C.cleanHome({ name: 'Test home', tz: tz || NY, members: [{ id: 'msamxx01', name: 'Sam' }, { id: 'malexx01', name: 'Alex' }] }, nowMs, tz || NY);
  C.act(doc, { role: 'owner' }, 'pet', { pet: { name: 'Biscuit', kind: 'dog' }, weight: '24.5', unit: 'lb' }, nowMs, ids);
  return doc;
}
const at = (day, hh, mm, tz) => C.instantOf(day, hh * 60 + (mm || 0), tz || NY);

/* ---------------- cleaning ---------------- */

test('typed strings go through one door: no markup, control or bidi characters, bounded; first names only; contacts kept out of notes', () => {
  assert.strictEqual(C.cleanText('<b>Biscuit</b>\u0007', 24), 'Biscuit');
  assert.strictEqual(C.cleanText('<img src=x onerror=alert(1)>', 24), '', 'nothing left of pure markup');
  for (const h of HOSTILE) assert.ok(!/[<>\u202a-\u202e\u2066-\u2069]/.test(C.clean(h, 100)), h);
  assert.strictEqual(C.cleanText('a'.repeat(5e6), 40).length, 40, 'a huge string comes back bounded');
  assert.strictEqual(C.firstName('sam kowalski'), 'Sam', 'never a surname');
  assert.strictEqual(C.firstName('sam k'), 'Sam K', 'an initial is fine');
  assert.strictEqual(C.firstName('<b></b>'), '');
  assert.strictEqual(C.firstName('"><b>jamie'), 'Jamie', 'punctuation in front is not a name');
  const s = C.stripPrivate('Biscuit, 12 Elm Street, Apt 4. Call 555-010-9988 or jo@example.com. Acct # 99887766. SW1A 1AA. Springfield, IL 62704. Given 2026-10-01 and 10/14/2026.');
  assert.ok(s.stripped);
  assert.ok(!/Elm|555|example|9988|99887766|SW1A|62704/.test(s.text), s.text);
  assert.ok(/2026-10-01/.test(s.text) && /10\/14\/2026/.test(s.text), 'dates stay');
  assert.ok(!C.hasContact('Hides the pill in cheese. Walk 2 times a day, 30 min.'), 'ordinary notes are fine');
  const p = C.cleanPet({ id: 'ptest0001', name: HOSTILE[0], kind: 'wolf', notes: 'Shy.\nNeighbour has a key: 07700 900123', birthday: '2099-01-01' }, '2026-10-24');
  assert.deepStrictEqual([p.name, p.kind, p.birthday], ['Rex', 'other', null]);
  assert.ok(!/07700/.test(p.notes) && /Shy\./.test(p.notes), 'a phone number never reaches a pet’s notes');
  assert.strictEqual(C.cleanPhone('(555) 010-4477'), '(555) 010-4477');
  for (const bad of ['call me', '123', 'javascript:alert(1)', '+44 <b>20</b>', '1'.repeat(20)]) assert.strictEqual(C.cleanPhone(bad), '', bad);
  assert.strictEqual(C.telHref('(555) 010-4477'), 'tel:5550104477');
  assert.strictEqual(C.cleanTz('America/New_York'), 'America/New_York');
  for (const bad of ['Mars/Olympus', '../etc', '', 42]) assert.strictEqual(C.cleanTz(bad), null);
});

/* ---------------- routines and due maths ---------------- */

test('repeats: every day, every N days, weekly and monthly - the 31st falls on the last day of a shorter month, leap years included', () => {
  const r = (every, anchor, n2) => C.cleanRepeat({ every, anchor, n: n2 }, '2026-01-01');
  assert.ok(C.dueOn(r('day', '2026-10-24'), '2020-01-01'), 'daily is always due');
  const three = r('days', '2026-10-24', 3);
  assert.deepStrictEqual(['2026-10-24', '2026-10-25', '2026-10-27', '2026-11-02', '2026-10-21'].map((d) => C.dueOn(three, d)), [true, false, true, true, false], 'counted from the anchor, never before it');
  assert.deepStrictEqual(['2026-10-25', '2026-11-01', '2026-11-02'].map((d) => C.dueOn(r('week', '2026-10-18'), d)), [true, true, false], 'Sundays');
  const m31 = r('month', '2026-01-31');
  const due = []; for (let d = '2026-01-01'; d <= '2026-12-31'; d = C.addDays(d, 1)) if (C.dueOn(m31, d)) due.push(d);
  assert.deepStrictEqual(due, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
  assert.ok(C.dueOn(m31, '2028-02-29') && !C.dueOn(m31, '2028-02-28'), 'Feb 29 in a leap year');
  assert.strictEqual(C.addMonths('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(C.addMonths('2027-12-15', 3), '2028-03-15', 'across a year end');
  assert.strictEqual(C.addMonths('2028-02-29', 12), '2029-02-28');
  assert.strictEqual(C.nextDue(r('days', '2026-10-24', 5), '2026-10-26'), '2026-10-29');
  assert.match(C.repeatWords(m31), /Monthly on the 31st \(or the month’s last day\)/);
  assert.strictEqual(C.repeatWords(r('week', '2026-10-18')), 'Weekly on Sundays');
  assert.strictEqual(C.cleanRepeat({ every: 'days', n: 999 }, '2026-01-01').n, 2, 'out of range falls back');
  for (const k of C.KIND_IDS) assert.ok(C.TEMPLATES[k].length >= 2, `${k} has a template`);
  const dog = C.templateFor('dog', 'ptest0001', '2026-10-24', ids);
  assert.deepStrictEqual(dog.map((x) => x.label), ['Breakfast', 'Morning walk', 'Evening walk', 'Dinner'], 'a dog: breakfast, dinner, two walks');
  assert.deepStrictEqual(C.templateFor('fish', 'ptest0001', '2026-10-24', ids).map((x) => [x.label, x.repeat.every]), [['Feed', 'day'], ['Water change', 'week']]);
  assert.deepStrictEqual(C.templateFor('cat', 'ptest0001', '2026-10-24', ids).map((x) => x.task), ['feed', 'feed', 'litter']);
});

test('the household’s own day and minute: a log’s instant is read back in its zone, across both clock changes and the 25-hour day', () => {
  assert.deepStrictEqual(C.zoned(Date.UTC(2026, 9, 25, 3, 30), NY), { day: '2026-10-24', min: 23 * 60 + 30 }, 'still the 24th in New York');
  assert.deepStrictEqual(C.zoned(Date.UTC(2026, 9, 25, 3, 30), 'Asia/Tokyo'), { day: '2026-10-25', min: 12 * 60 + 30 });
  assert.strictEqual((C.instantOf('2026-10-26', 0, LDN) - C.instantOf('2026-10-25', 0, LDN)) / 3600000, 25, 'London’s autumn change');
  assert.strictEqual((C.instantOf('2026-11-02', 0, NY) - C.instantOf('2026-11-01', 0, NY)) / 3600000, 25, 'New York’s');
  assert.strictEqual((C.instantOf('2027-03-15', 0, NY) - C.instantOf('2027-03-14', 0, NY)) / 3600000, 23, 'and the spring one');
  for (const [d, m, tz] of [['2026-10-25', 8 * 60, LDN], ['2026-11-01', 19 * 60, NY], ['2027-03-14', 7 * 60 + 42, NY], ['2026-12-31', 1439, 'Pacific/Auckland']]) {
    assert.deepStrictEqual(C.zoned(C.instantOf(d, m, tz), tz), { day: d, min: m }, `${d} ${m} ${tz}`);
  }
  // Breakfast on the day the clocks go back: due 7-9, overdue at 9:01 by the
  // household's clock, not by UTC.
  const day = '2026-11-01';
  const doc = home(at(day, 6), NY);
  const row = (ms) => C.board(doc, ms).pets[0].rows.find((r) => r.label === 'Breakfast');
  assert.strictEqual(row(at(day, 8, 59)).state, 'now');
  assert.strictEqual(row(at(day, 9, 1)).state, 'overdue');
  assert.strictEqual(row(at(day, 6, 59)).state, 'later');
  assert.strictEqual(C.fmtTime(7 * 60 + 42), '7:42am');
  assert.strictEqual(C.fmtTime(0), '12:00am');
  assert.strictEqual(C.fmtTime(12 * 60 + 5), '12:05pm');
  // The same instants give the same board in every process time zone.
  const script = `const C=require('./public/pawlog-core');const s=C.sample(${Date.UTC(2026, 9, 31, 22, 0)},'America/New_York');
    console.log(JSON.stringify({b:C.board(s,${Date.UTC(2026, 10, 1, 14)}),w:C.week(s,'sample-biscuit',${Date.UTC(2026, 10, 1, 14)}),ics:C.buildIcs(s,{today:'2026-11-01',nowMs:${Date.UTC(2026, 10, 1, 14)}})}));`;
  const outs = ['UTC', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'].map((TZ) => {
    const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  });
  for (const o of outs) assert.strictEqual(o, outs[0], 'byte-identical whatever the server’s own zone');
});

/* ---------------- the board, the guard, undo ---------------- */

test('the board: due, done with who and when, overdue, the guard (same day, and the half hour across midnight), undo for two minutes', () => {
  const day = '2026-10-24';
  const doc = home(at(day, 6), NY);
  const b0 = C.board(doc, at(day, 7, 30));
  assert.deepStrictEqual(b0.pets[0].rows.map((r) => [r.label, r.state]), [['Breakfast', 'now'], ['Morning walk', 'now'], ['Evening walk', 'later'], ['Dinner', 'later']]);
  const key = b0.pets[0].rows[0].key;
  const r1 = C.act(doc, { role: 'member' }, 'done', { key, by: 'msamxx01' }, at(day, 7, 42), ids);
  const row = C.board(doc, at(day, 7, 50)).pets[0].rows[0];
  assert.strictEqual(C.doneWords(row, NY), 'Fed by Sam 7:42am');
  assert.throws(() => C.act(doc, { role: 'member' }, 'done', { key, by: 'malexx01' }, at(day, 7, 55), ids),
    (e) => e.status === 409 && e.code === 'already' && e.message === 'Already fed by Sam at 7:42am - do it again?' && e.by === 'Sam' && !e.mine);
  assert.throws(() => C.act(doc, { role: 'member' }, 'done', { key, by: 'msamxx01' }, at(day, 15), ids), (e) => e.mine && /by you/.test(e.message), 'later the same day too, and it knows it was you');
  const again = C.act(doc, { role: 'member' }, 'done', { key, by: 'malexx01', again: true }, at(day, 15), ids);
  assert.ok(again.again);
  assert.strictEqual(C.board(doc, at(day, 15, 1)).pets[0].rows[0].times, 2);
  assert.match(C.doneWords(C.board(doc, at(day, 15, 1)).pets[0].rows[0], NY), /Fed by Alex 3:00pm · 2×/);
  // Undo: the next two minutes, then not.
  assert.throws(() => C.act(doc, { role: 'member' }, 'undo', { log: r1.log.id }, at(day, 7, 45), ids), /Too late to undo/);
  C.act(doc, { role: 'member' }, 'undo', { log: again.log.id }, at(day, 15, 2), ids);
  assert.strictEqual(C.board(doc, at(day, 15, 3)).pets[0].rows[0].times, 1);
  // Across midnight: dinner at 11:55pm (late) and a tap at 12:10am is the guard.
  const k2 = b0.pets[0].rows[3].key;
  C.act(doc, { role: 'member' }, 'done', { key: k2, by: 'msamxx01' }, at(day, 23, 55), ids);
  assert.throws(() => C.act(doc, { role: 'member' }, 'done', { key: k2, by: 'malexx01' }, at('2026-10-25', 0, 10), ids), (e) => e.code === 'already');
  assert.doesNotThrow(() => C.act(doc, { role: 'member' }, 'done', { key: k2, by: 'malexx01' }, at('2026-10-25', 0, 26), ids), 'half an hour on, it is a new day’s job');
  // Who, what, when.
  assert.throws(() => C.act(doc, { role: 'member' }, 'done', { key, by: 'nobody01' }, at(day, 8), ids), (e) => e.code === 'who');
  assert.throws(() => C.act(doc, { role: 'member' }, 'done', { key: 'nope0001', by: 'msamxx01' }, at(day, 8), ids), /isn’t on the list/);
  assert.throws(() => C.act(doc, { role: 'member' }, 'done', { key, by: 'msamxx01', day: '2026-10-20' }, at(day, 8), ids), /Only today/);
  assert.throws(() => C.act(doc, { role: 'sitter', sitter: { code: 'ABCDEFGHJK', name: 'Jo' } }, 'pet', { pet: { name: 'X' } }, at(day, 8), ids), (e) => e.status === 403);
});

test('medicines: doses at set times on the board, the same double-dose guard, a course that ends drops off and says so', () => {
  const day = '2026-10-24';
  const doc = home(at(day, 6), NY);
  const pet = doc.pets[0].id;
  const { med } = C.act(doc, { role: 'owner' }, 'med', { med: { pet, name: 'Ear drops', dose: '4 drops', times: [1200, 480, 480], start: '2026-10-22', until: '2026-10-26' } }, at(day, 6), ids);
  assert.deepStrictEqual(med.times, [480, 1200], 'sorted, no repeats');
  const doses = (d) => C.dueOnDay(doc, d).filter((r) => r.kind === 'dose').map((r) => r.key);
  assert.deepStrictEqual(doses('2026-10-21'), [], 'not before it starts');
  assert.deepStrictEqual(doses('2026-10-26'), [`${med.id}@480`, `${med.id}@1200`], 'on the last day');
  assert.deepStrictEqual(doses('2026-10-27'), [], 'and gone after');
  assert.deepStrictEqual(['2026-10-20', '2026-10-24', '2026-10-26', '2026-10-27'].map((d) => C.medStatus(med, d).words), ['Starts Oct 22', '3 days left (until Oct 26)', 'Last day today', 'Finished Oct 26']);
  C.act(doc, { role: 'member' }, 'done', { key: `${med.id}@480`, by: 'malexx01' }, at(day, 8, 3), ids);
  assert.throws(() => C.act(doc, { role: 'member' }, 'done', { key: `${med.id}@480`, by: 'msamxx01' }, at(day, 8, 20), ids), (e) => e.code === 'already' && e.dose && /Already given by Alex at 8:03am/.test(e.message));
  assert.ok(C.dueSoon(doc, day).some((s) => s.kind === 'med' && s.words === 'Course ends in 2 days'));
  C.act(doc, { role: 'owner' }, 'stopmed', { id: med.id }, at(day, 12), ids);
  assert.deepStrictEqual(doses('2026-10-25'), [], 'stopping ends it today');
  const every2 = C.act(doc, { role: 'owner' }, 'med', { med: { pet, name: 'Tablet', times: [540], repeat: { every: 'days', n: 2 }, start: '2026-10-24' } }, at(day, 6), ids).med;
  assert.deepStrictEqual(['2026-10-24', '2026-10-25', '2026-10-26'].map((d) => C.medOn(every2, d)), [true, false, true]);
  assert.strictEqual(C.medStatus(every2, day).words, 'Ongoing');
  assert.deepStrictEqual(C.parseSchedule('Twice daily with food'), { times: [480, 1200], repeat: { every: 'day', n: 1 } });
  assert.deepStrictEqual(C.parseSchedule('every other day').repeat, { every: 'days', n: 2 });
  assert.deepStrictEqual(C.parseSchedule('three times a day').times, [480, 840, 1320]);
  assert.deepStrictEqual(C.parseSchedule('monthly').repeat.every, 'month');
  C.act(doc, { role: 'owner' }, 'unmed', { id: med.id }, at(day, 12), ids);
  assert.ok(!doc.logs.some((l) => l.key.startsWith(med.id)), 'its doses go with it');
});

test('vaccinations and treatments: due dates, "Done today" sets the next one by months, Due soon, weights in either unit', () => {
  const day = '2026-10-24';
  const doc = home(at(day, 6), NY);
  const pet = doc.pets[0].id;
  const { health: rab } = C.act(doc, { role: 'owner' }, 'health', { health: { pet, type: 'vaccine', name: 'Rabies booster', given: '2025-11-02', due: '2026-11-02', everyMonths: 12 } }, at(day, 6), ids);
  const { health: flea } = C.act(doc, { role: 'owner' }, 'health', { health: { pet, type: 'flea', name: 'Flea tablet', given: '2026-08-31', due: '2026-09-30', everyMonths: 1 } }, at(day, 6), ids);
  assert.throws(() => C.act(doc, { role: 'owner' }, 'health', { health: { pet, type: 'vaccine', name: 'Nothing' } }, at(day, 6), ids), /given or when it’s due/);
  const soon = C.dueSoon(doc, day);
  assert.deepStrictEqual(soon.filter((s) => s.kind === 'health').map((s) => [s.title, s.words]), [['Flea tablet', '24 days overdue'], ['Rabies booster', 'Due in 9 days']]);
  const g = C.act(doc, { role: 'member' }, 'given', { id: flea.id }, at('2027-01-31', 9), ids).health;
  assert.deepStrictEqual([g.given, g.due], ['2027-01-31', '2027-02-28'], 'a month on from the 31st is the last of February');
  assert.strictEqual(C.act(doc, { role: 'member' }, 'given', { id: rab.id }, at(day, 9), ids).health.due, '2027-10-24');
  assert.deepStrictEqual([C.dueWords(0), C.dueWords(1), C.dueWords(-1)], ['Due today', 'Due tomorrow', '1 day overdue']);
  assert.strictEqual(C.weightsOf(doc, pet)[0].g, Math.round(24.5 * 453.59237), 'the first weight from the pet form');
  C.act(doc, { role: 'member' }, 'weight', { pet, value: '11,2', unit: 'kg', day: '2026-10-24' }, at(day, 9), ids);
  assert.strictEqual(C.weightsOf(doc, pet).length, 1, 'one weight a day: the newer replaces it');
  assert.deepStrictEqual([C.fmtWeight(11200, 'kg'), C.fmtWeight(11200, 'lb')], ['11.2 kg', '24.7 lb']);
  assert.throws(() => C.act(doc, { role: 'member' }, 'weight', { pet, value: '9000', unit: 'kg' }, at(day, 9), ids), /doesn’t look right/);
  assert.strictEqual(C.ageWords('2022-08-30', '2026-10-24'), '4 years');
  assert.strictEqual(C.ageWords('2026-05-30', '2026-10-24'), '4 months');
});

test('the week: "walked 12 of 13 times", today only counts what is done or past, streaks, and a fair share that is not a scoreboard', () => {
  const nowMs = at('2026-10-24', 12);
  const s = C.sample(nowMs, NY);
  const w = C.week(s, 'sample-biscuit', nowMs);
  assert.strictEqual(w.days.length, 7);
  assert.deepStrictEqual(w.lines.map((l) => l.words), ['Fed 13 of 13 meals', 'Walked 12 of 13 times', '13 of 13 doses given'], 'one walk missed three days ago; this evening’s jobs not counted yet');
  assert.deepStrictEqual(w.streak, { days: 2, capped: false }, 'everything done since the missed walk');
  assert.strictEqual(C.week(s, 'sample-miso', nowMs).streak.days, 6);
  const fs2 = C.fairShare(s, nowMs);
  assert.strictEqual(fs2.rows.reduce((t, r) => t + r.n, 0), fs2.total);
  assert.deepStrictEqual(fs2.rows.map((r) => r.name).sort(), ['Alex', 'Priya', 'Sam']);
  assert.ok(Math.abs(fs2.rows.reduce((t, r) => t + r.pct, 0) - 100) <= 2);
  const nothing = home(at('2026-10-24', 6), NY);
  assert.deepStrictEqual(C.week(nothing, nothing.pets[0].id, at('2026-10-24', 6)).streak.days, 0, 'a new pet has no streak');
});

test('the sample: a dog and a cat, three people, about half done, the guard ready on Miso’s breakfast, a course, a booster in 9 days - at any hour, on a clock change', () => {
  for (const [day, hh, tz] of [['2026-10-24', 20, NY], ['2026-10-24', 3, NY], ['2026-11-01', 1, NY], ['2026-10-25', 10, LDN], ['2028-02-29', 12, 'Asia/Tokyo'], ['2026-12-31', 23, 'Pacific/Auckland']]) {
    const nowMs = at(day, hh, 30, tz);
    const s = C.sample(nowMs, tz);
    assert.deepStrictEqual(C.cleanHome(s, nowMs, tz).pets, s.pets, 'the sample passes the same door');
    assert.deepStrictEqual(s.pets.map((p) => p.kind), ['dog', 'cat']);
    assert.strictEqual(s.members.length, 3);
    const b = C.board(s, nowMs);
    assert.strictEqual(b.done, 4, `${day} ${hh}`);
    assert.ok(b.total >= 8 && b.done / b.total <= 0.5);
    assert.ok(s.logs.every((l) => l.at <= nowMs), 'every tick is in the past');
    const miso = b.pets[1].rows.find((r) => r.label === 'Breakfast');
    assert.ok(miso.log && miso.log.name === 'Sam');
    assert.throws(() => C.act(C.sample(nowMs, tz), { role: 'owner' }, 'done', { key: miso.key, by: 'sample-alex' }, nowMs, ids), (e) => e.code === 'already');
    const soon = C.dueSoon(s, b.day);
    assert.ok(soon.some((x) => x.title === 'Cat flu booster' && x.inDays === 9));
    assert.ok(soon.some((x) => x.kind === 'med'));
    assert.strictEqual(s.vet.phone, '(555) 010-4477');
  }
});

/* ---------------- what each link shows, permissions ---------------- */

test('what each link shows, by exact keys: the household sees the household; the sitter sees pets, notes, routine, medicines, ticks and the vet - no names, no health, no links', () => {
  const nowMs = at('2026-10-24', 12);
  const s = C.sample(nowMs, NY);
  Object.assign(s, { code: 'HOMECODE22', ownerHash: 'h', creator: 'd:x', link: 'LINKCODE22', sitters: { SITTER2222: { name: 'Jo', until: '2026-10-29' } } });
  const m = C.memberView(s);
  assert.deepStrictEqual(Object.keys(m).sort(), ['createdAt', 'health', 'items', 'link', 'logs', 'meds', 'members', 'name', 'pets', 'tz', 'units', 'v', 'vet', 'weights']);
  assert.ok(!/HOMECODE22|SITTER2222|d:x/.test(JSON.stringify(m)), 'not the home’s own code, the sitters or the device tag');
  const sv = C.sitterView(s, { code: 'SITTER2222', name: 'Jo', until: '2026-10-29' }, nowMs);
  assert.deepStrictEqual(Object.keys(sv).sort(), ['items', 'logs', 'meds', 'name', 'pets', 'sitter', 'tz', 'v', 'vet']);
  assert.deepStrictEqual(Object.keys(sv.pets[0]).sort(), ['id', 'kind', 'name', 'notes']);
  assert.deepStrictEqual(Object.keys(sv.vet).sort(), ['phone', 'practice']);
  assert.deepStrictEqual(Object.keys(sv.logs[0]).sort(), ['at', 'day', 'id', 'key', 'mine', 'name', 'pet']);
  const text = JSON.stringify(sv);
  for (const hidden of ['Sam', 'Alex', 'Priya', 'Rabies', 'birthday', 'LINKCODE22', 'HOMECODE22', '"g":']) assert.ok(!text.includes(hidden), `the sitter never sees ${hidden}`);
  assert.ok(sv.logs.every((l) => l.day >= '2026-10-23'), 'only today’s and yesterday’s ticks');
  const b = C.board(sv, nowMs);
  assert.strictEqual(C.doneWords(b.pets[0].rows[0], NY), 'Fed 7:42am', 'someone else’s tick reads as just done');
  const ctx = { role: 'sitter', sitter: { code: 'SITTER2222', name: 'Jo' } };
  const key = b.pets[0].rows.find((r) => !r.log).key;
  const r = C.act(s, ctx, 'done', { key }, nowMs, ids);
  assert.deepStrictEqual([r.log.by, r.log.name, r.log.link], ['sitter', 'Jo', 'SITTER2222']);
  const mine = C.sitterView(s, { code: 'SITTER2222', name: 'Jo', until: '2026-10-29' }, nowMs).logs.find((l) => l.id === r.log.id);
  assert.deepStrictEqual([mine.mine, mine.name], [true, 'Jo']);
  const alexLog = s.logs.find((l) => l.by === 'sample-alex' && l.day === '2026-10-24');
  alexLog.at = nowMs - 30000;
  assert.throws(() => C.act(s, ctx, 'undo', { log: alexLog.id }, nowMs, ids), (e) => e.status === 403, 'a sitter takes back only their own tick');
  for (const a of ['join', 'home', 'vet', 'pet', 'unpet', 'med', 'health', 'given', 'weight', 'unjoin']) assert.throws(() => C.act(s, ctx, a, {}, nowMs, ids), (e) => e.status === 403, a);
  assert.throws(() => C.act(s, { role: 'member' }, 'unjoin', { id: 'sample-sam' }, nowMs, ids), (e) => e.status === 403, 'only the owner takes people out');
});

/* ---------------- the calendar ---------------- */

test('the .ics: RFC 5545 shape, CRLF, folded at 75 octets, escaped, all-day due dates with a week-before and on-the-day reminder, course ends, nothing past', () => {
  const nowMs = at('2026-10-24', 12);
  const s = C.sample(nowMs, NY);
  s.pets[0].name = 'Bis;cuit, "the\\dog"';
  const ics = C.buildIcs(s, { today: '2026-10-24', nowMs });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every line ends CRLF');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.strictEqual((unfolded.match(/BEGIN:VEVENT/g) || []).length, (unfolded.match(/END:VEVENT/g) || []).length);
  const uids = unfolded.match(/^UID:.*$/gm);
  assert.strictEqual(new Set(uids).size, uids.length, 'unique UIDs');
  assert.ok(/SUMMARY:🐈 Miso: Cat flu booster due/.test(unfolded));
  assert.ok(/DTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261103/.test(unfolded), 'all day, the next day ends it');
  assert.ok(/TRIGGER:-P6DT15H/.test(unfolded) && /TRIGGER:PT9H/.test(unfolded), 'a week before at 9am, and on the day');
  assert.ok(unfolded.includes('Bis\\;cuit\\, "the\\\\dog"'), 'text escaped');
  assert.ok(/last day of Ear drops/.test(unfolded));
  assert.ok(/Fernhill Vets\\, \(555\) 010-4477/.test(unfolded));
  assert.ok(!/Hartley|Alex|Priya|Sam\b/.test(unfolded.replace(/X-WR-CALNAME.*\r\n/, '')), 'no household names in events');
  const past = C.buildIcs({ ...s, health: s.health.map((h) => ({ ...h, due: '2026-01-01' })), meds: [] }, { today: '2026-10-24', nowMs });
  assert.ok(!/BEGIN:VEVENT/.test(past), 'nothing already past');
});

/* ---------------- the page and the files ---------------- */

function luminance(hex) {
  const v = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes (and the lab card colours hold white)', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2']) for (const fg of ['text', 'muted', 'link']) ok(fg, bg);
    for (const fg of ['text', 'muted', 'link']) ok(fg, 'accent-soft');
    ok('accent-ink', 'accent'); ok('accent', 'card'); ok('accent', 'bg');
    for (const k of ['done', 'now', 'over', 'info']) { ok(k, `${k}-bg`); ok(k, 'card'); ok('text', `${k}-bg`); ok('muted', `${k}-bg`); }
    ok('card', 'done'); ok('ink2', 'card'); ok('err', 'card'); ok('err', 'bg');
    ok('strip-ink', 'strip'); ok('strip-btn-ink', 'strip-btn');
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) ok('av-ink', p);
  }
  assert.ok(ratio('#ffffff', '#0d6b5a') >= 4.5 && ratio('#ffffff', '#7a3d12') >= 4.5, 'the lab card colours hold white text');
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { PAWLOG_MEMORY: '1' }], ['./lib/fakeai', { PAWLOG_FAKE_AI: '1' }], ['./server', { PAWLOG_FAKE_AI: '1', PAWLOG_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, PAWLOG_MEMORY: '', PAWLOG_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; the one query is a single equality filter, so no composite index', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: ROOT, env: { ...process.env, PAWLOG_MEMORY: '', PAWLOG_COLLECTION_PREFIX: 'pawlog_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = read('lib/store.js');
  assert.ok(/PAWLOG_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10, 'every Firestore path is prefixed');
  const server = read('server.js');
  assert.deepStrictEqual(server.match(/store\.list\([^)]*\)/g), ["store.list('homes', { where: [['creator', '==', tag]], limit: H.LIMITS.openPerCreator * 4 })"]);
  assert.ok(!/orderBy/.test(server));
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, no email, the core has no clock, every drawn string escaped', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown)\s*=/.test(js), 'handlers by addEventListener');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/sessionStorage|indexedDB/.test(js));
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js), 'every browser URL is relative to BASE');
  assert.ok(/X-Pawlog-Key/.test(js) && !/[?&]key=/.test(js), 'the owner key rides in a header (or a #fragment), never a query');
  const core = read('public/pawlog-core.js');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + core + read('server.js') + read('CLAUDE.md')), 'no email address in the files');
  assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(core), 'the core has no dice and no clock');
  // Every typed or served field drawn into markup goes through esc().
  const risky = js.match(/'\s*\+\s*(p\.name|m\.name|d\.name|s\.name|i\.label|row\.label|h\.name|p\.notes|v\.practice|v\.phone|l\.name|r\.name|info\.by|state\.gone|s\.title|s\.petName|e\.message|err\.message)\s*\+/g);
  assert.strictEqual(risky, null, `unescaped: ${risky}`);
  for (const f of ['server.js', 'lib/ai.js', 'lib/homes.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|text|notes|name)/.test(read(f)), `${f} logs a body`);
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return;/.test(sw) && /\(h\|s\|o\)/.test(sw), 'the service worker never caches the API or a link page');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
function localHome() {
  const doc = home(Date.now(), NY);
  doc.pets[0].notes = 'Hides the pill in cheese.';
  doc.vet = { practice: 'Fernhill Vets', phone: '(555) 010-4477' };
  C.act(doc, { role: 'owner' }, 'health', { health: { pet: doc.pets[0].id, type: 'vaccine', name: 'Rabies booster', given: '2026-01-02', due: '2027-01-02', everyMonths: 12 } }, Date.now(), ids);
  return doc;
}
async function shareOne(owner) {
  const r = await (owner || client())('POST', '/api/homes', { home: localHome() });
  assert.strictEqual(r.status, 200, r.text);
  return r.data;
}
const key = (k) => ({ 'X-Pawlog-Key': k });
const PAPER = { kind: 'dog', text: 'Fernhill Vets. Client: Jane Doe, 12 Elm Street, Springfield, IL 62704. Acct # 99887766. Phone 555-010-9988. Rabies booster given today, next due in a year. Ear drops twice daily for 10 days. Weight 11.4 kg. Recheck in 2 weeks.' };

test('signed out: everything is free and makes no model call; the metered and sync routes answer 401 before reading a big body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  assert.strictEqual((await anon('GET', '/api/meta')).data.kinds.length, 7);
  for (const f of ['pawlog-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/read-paperwork', PAPER)).status, 401);
  assert.strictEqual((await anon('POST', '/api/read-paperwork', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 401, 'the gate answers before the parser');
  assert.strictEqual((await anon('GET', '/api/mine')).status, 401);
  assert.strictEqual((await anon('PUT', '/api/mine', { home: 'x'.repeat(900 * 1024) })).status, 401, 'refused before its big parser');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the metered route’s gates come before its parser, in order; one model client in the whole server', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/read-paperwork', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  assert.deepStrictEqual(layer('/api/mine', 'put').route.stack.map((l) => l.handle.name).slice(0, 2), ['requireUser', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one door to one metered call');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('a shared home: the owner shares, the household opens one link with no account, picks or adds a name, and everyone sees the same board', async () => {
  const owner = client();
  const made = await shareOne(owner);
  assert.ok(H.isCode(made.code) && H.isCode(made.link) && made.code !== made.link && H.isKey(made.key));
  assert.ok(owner.cookies.pawlog_k, 'a device key for the live-homes cap');
  const dump = store._dump();
  assert.ok(!dump.includes(made.key) && !dump.includes(owner.cookies.pawlog_k), 'neither the key nor the device key is stored');
  const phone = client();
  const seen = await phone('GET', `/api/l/${made.link}`);
  assert.strictEqual(seen.status, 200);
  assert.strictEqual(seen.data.role, 'member');
  assert.deepStrictEqual(Object.keys(seen.data.home).sort(), ['createdAt', 'health', 'items', 'link', 'logs', 'meds', 'members', 'name', 'pets', 'tz', 'units', 'v', 'vet', 'weights']);
  assert.ok(!seen.text.includes(made.code), 'the household link never names the home’s own code');
  assert.strictEqual(seen.headers.get('referrer-policy'), 'no-referrer');
  assert.match(seen.headers.get('x-robots-tag'), /noindex/);
  const pageRes = await fetch(`${base}/h/${made.link}`);
  const pageHtml = await pageRes.text();
  assert.ok(pageHtml.includes('<base href="../">') && pageRes.headers.get('referrer-policy') === 'no-referrer');
  assert.ok(!pageHtml.includes('Biscuit'), 'the page itself carries nothing of the household');
  const j = await phone('POST', `/api/l/${made.link}/act`, { action: 'join', name: '<b>jamie</b>\u202e' });
  assert.strictEqual(j.status, 200, j.text);
  assert.strictEqual(j.data.result.member.name, 'Jamie');
  const again = await phone('POST', `/api/l/${made.link}/act`, { action: 'join', name: 'JAMIE' });
  assert.strictEqual(again.data.result.member.id, j.data.result.member.id, 'the same name is the same person');
  const rowKey = C.board(seen.data.home, Date.now()).pets[0].rows[0].key;
  const d = await phone('POST', `/api/l/${made.link}/act`, { action: 'done', key: rowKey, by: j.data.result.member.id });
  assert.strictEqual(d.status, 200, d.text);
  const o = await owner('GET', `/api/homes/${made.code}?since=1`, undefined, key(made.key));
  assert.ok(o.data.home.logs.some((l) => l.name === 'Jamie'), 'the owner sees it');
  assert.deepStrictEqual((await owner('GET', `/api/homes/${made.code}?since=${o.data.home.v}`, undefined, key(made.key))).data, { same: true, v: o.data.home.v }, 'an unchanged poll is one small answer');
  assert.strictEqual((await phone('POST', `/api/l/${made.link}/act`, { action: 'unjoin', id: j.data.result.member.id })).status, 403, 'only the owner takes people out');
  assert.strictEqual((await phone('GET', `/api/homes/${made.code}`)).status, 404, 'no key, no home - the same 404 as nothing');
  assert.strictEqual((await phone('GET', `/api/homes/${made.code}`, undefined, key('x'.repeat(22)))).status, 404);
  // Replacing the link: the old one stops at once.
  const re = await owner('POST', `/api/homes/${made.code}/act`, { action: 'relink' }, key(made.key));
  assert.ok(re.data.link && re.data.link !== made.link);
  assert.strictEqual((await phone('GET', `/api/l/${made.link}`)).status, 404);
  assert.strictEqual((await phone('GET', `/api/l/${re.data.link}`)).status, 200);
  // The sample never leaves the phone; a home needs a pet and a name.
  assert.strictEqual((await client()('POST', '/api/homes', { home: { ...C.sample(Date.now(), NY), sample: true } })).status, 400);
  assert.strictEqual((await client()('POST', '/api/homes', { home: { members: [{ id: 'mtest0001', name: 'Sam' }] } })).status, 400);
  // Deleting it closes every link.
  assert.strictEqual((await owner('DELETE', `/api/homes/${made.code}`, undefined, key(made.key))).status, 200);
  const gone = await phone('GET', `/api/l/${re.data.link}`);
  const never = await phone('GET', `/api/l/${'A'.repeat(10)}`);
  const junk = await phone('GET', '/api/l/not-a-code');
  assert.deepStrictEqual([gone.status, never.status, junk.status], [404, 404, 404]);
  assert.ok(gone.data.error === never.data.error && never.data.error === junk.data.error, 'one answer for all three');
  assert.strictEqual((await fetch(`${base}/h/${made.link}`, { method: 'POST' })).status, 405);
});

test('the double-feeding guard holds under two taps at once: one lands, the other hears who and when; undo only for two minutes', async () => {
  const made = await shareOne();
  const a = client(); const b = client();
  const view = (await a('GET', `/api/l/${made.link}`)).data.home;
  const sam = view.members.find((m) => m.name === 'Sam').id;
  const alex = view.members.find((m) => m.name === 'Alex').id;
  const k = C.board(view, Date.now()).pets[0].rows[0].key;
  const [r1, r2] = await Promise.all([
    a('POST', `/api/l/${made.link}/act`, { action: 'done', key: k, by: sam }),
    b('POST', `/api/l/${made.link}/act`, { action: 'done', key: k, by: alex }),
  ]);
  const ok = [r1, r2].filter((r) => r.status === 200);
  const no = [r1, r2].filter((r) => r.status === 409);
  assert.deepStrictEqual([ok.length, no.length], [1, 1], 'exactly one feed');
  assert.strictEqual(no[0].data.code, 'already');
  assert.match(no[0].data.error, /^Already fed by (Sam|Alex) at \d{1,2}:\d{2}(am|pm) - do it again\?$/);
  assert.ok(no[0].data.when && no[0].data.by && no[0].data.at);
  const twice = await b('POST', `/api/l/${made.link}/act`, { action: 'done', key: k, by: alex, again: true });
  assert.strictEqual(twice.status, 200, 'and asked, it can be done again');
  assert.strictEqual(twice.data.home.logs.filter((l) => l.key === k).length, 2);
  // Undo: fine now, refused once the log is three minutes old.
  const u = await b('POST', `/api/l/${made.link}/act`, { action: 'undo', log: twice.data.result.log.id });
  assert.strictEqual(u.status, 200, u.text);
  const first = ok[0].data.result.log.id;
  await store.transact('homes', made.code, (cur) => ({ ...cur, logs: cur.logs.map((l) => (l.id === first ? { ...l, at: Date.now() - 3 * 60000 } : l)) }));
  const late = await a('POST', `/api/l/${made.link}/act`, { action: 'undo', log: first });
  assert.deepStrictEqual([late.status, /Too late to undo/.test(late.data.error)], [409, true]);
});

test('sitter links: the owner opens one until a day; it shows exactly the sitter’s slice, ticks only, and closes on its day, when closed, or with the home', async () => {
  const owner = client();
  const made = await shareOne(owner);
  const today = C.zoned(Date.now(), NY).day;
  const bad = await owner('POST', `/api/homes/${made.code}/act`, { action: 'sitter', name: 'Jo', until: C.addDays(today, 90) }, key(made.key));
  assert.strictEqual(bad.status, 400, 'no further than 60 days');
  const s = await owner('POST', `/api/homes/${made.code}/act`, { action: 'sitter', name: '<i>jo</i> bloggs', until: C.addDays(today, 3) }, key(made.key));
  assert.strictEqual(s.status, 200, s.text);
  const code = s.data.result.sitter;
  assert.deepStrictEqual(s.data.sitters.map((x) => [x.name, x.until]), [['Jo', C.addDays(today, 3)]]);
  const member = await client()('GET', `/api/l/${s.data.link}`);
  assert.ok(!member.text.includes(code), 'the household never sees the sitter link');
  const sit = client();
  const v = await sit('GET', `/api/l/${code}`);
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.data.role, 'sitter');
  assert.deepStrictEqual(Object.keys(v.data.home).sort(), ['items', 'logs', 'meds', 'name', 'pets', 'sitter', 'tz', 'v', 'vet']);
  for (const hidden of ['Sam', 'Alex', 'Rabies', made.link, made.code, 'weights', 'members']) assert.ok(!v.text.includes(hidden), `the sitter sees no ${hidden}`);
  assert.ok(v.text.includes('Hides the pill in cheese') && v.text.includes('(555) 010-4477'), 'notes and the vet’s one number');
  assert.strictEqual((await fetch(`${base}/s/${code}`)).headers.get('referrer-policy'), 'no-referrer');
  const k = C.board(v.data.home, Date.now()).pets[0].rows[0].key;
  const d = await sit('POST', `/api/l/${code}/act`, { action: 'done', key: k });
  assert.strictEqual(d.status, 200, d.text);
  assert.deepStrictEqual([d.data.result.log.name, d.data.result.log.by], ['Jo', 'sitter']);
  const o = await owner('GET', `/api/homes/${made.code}`, undefined, key(made.key));
  assert.ok(o.data.home.logs.some((l) => l.name === 'Jo' && l.by === 'sitter'), 'the household sees "Fed by Jo"');
  for (const a of ['join', 'pet', 'vet', 'health', 'relink', 'sitter']) assert.strictEqual((await sit('POST', `/api/l/${code}/act`, { action: a, name: 'X' })).status, 403, a);
  // The cap, then closing early, then a link whose day has ended.
  for (let i = 0; i < 2; i++) assert.strictEqual((await owner('POST', `/api/homes/${made.code}/act`, { action: 'sitter', name: `S${i}`, until: today }, key(made.key))).status, 200);
  assert.strictEqual((await owner('POST', `/api/homes/${made.code}/act`, { action: 'sitter', name: 'Four', until: today }, key(made.key))).status, 409, 'three open at most');
  const closed = await owner('POST', `/api/homes/${made.code}/act`, { action: 'unsitter', code }, key(made.key));
  assert.strictEqual(closed.status, 200);
  assert.strictEqual((await sit('GET', `/api/l/${code}`)).status, 404);
  const other = closed.data.sitters[0].code;
  await store.transact('homes', made.code, (cur) => ({ ...cur, sitters: { ...cur.sitters, [other]: { ...cur.sitters[other], expiresAt: new Date(Date.now() - 1000).toISOString() } } }));
  const expired = await client()('GET', `/api/l/${other}`);
  assert.strictEqual(expired.status, 404, 'past its day');
  assert.strictEqual(await store.get('links', other), null, 'and deleted by the read that found it');
  assert.strictEqual(expired.data.error, (await client()('GET', `/api/l/${'B'.repeat(10)}`)).data.error, 'reads like a link that never was');
  // A home nobody touches for its idle time is gone too, links and all.
  await store.transact('homes', made.code, (cur) => ({ ...cur, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.strictEqual((await client()('GET', `/api/l/${closed.data.link}`)).status, 404);
  assert.strictEqual(await store.get('homes', made.code), null);
});

test('limits: shared homes per address an hour and per phone, distinct wrong codes, hostile names stored clean', async () => {
  const ip = '198.51.100.7';
  const c = client(ip);
  const statuses = [];
  for (let i = 0; i < H.LIMITS.openPerCreator + 1; i++) statuses.push((await c('POST', '/api/homes', { home: localHome() })).status);
  assert.deepStrictEqual(statuses.slice(-1), [429], `${H.LIMITS.openPerCreator} live homes per phone`);
  assert.strictEqual(statuses.filter((s) => s === 200).length, H.LIMITS.openPerCreator);
  const d = client('198.51.100.8');
  for (let i = 0; i < H.LIMITS.homesPerIp; i++) { d.cookies.pawlog_k = undefined; delete d.cookies.pawlog_k; await d('POST', '/api/homes', { home: localHome() }); }
  delete d.cookies.pawlog_k;
  assert.strictEqual((await d('POST', '/api/homes', { home: localHome() })).status, 429, `${H.LIMITS.homesPerIp} an hour from one address`);
  const g = client('198.51.100.9');
  for (let i = 0; i < H.LIMITS.missesPerIp; i++) await g('GET', `/api/l/${String(i).padStart(10, 'C')}`);
  const real = (await shareOne()).link;
  assert.strictEqual((await g('GET', `/api/l/${real}`)).status, 429, 'past 30 distinct wrong codes, even a real one waits');
  const same = client('198.51.100.10');
  for (let i = 0; i < 40; i++) await same('GET', `/api/l/${'E'.repeat(10)}`);
  assert.strictEqual((await same('GET', `/api/l/${real}`)).status, 200, 'one dead link polled again is not guessing');
  const doc = localHome();
  doc.pets[0].name = HOSTILE[0]; doc.members[0].name = HOSTILE[1]; doc.name = HOSTILE[3];
  const made = await client()('POST', '/api/homes', { home: doc });
  assert.strictEqual(made.status, 200, made.text);
  assert.ok(!/[<>\u202a-\u202e\u2066-\u2069]/.test(JSON.stringify(made.data.home)), 'nothing hostile survives the door');
});

test('signed in, the owner’s household follows them: kept whole or as the shared keys, a stale phone cannot undo a newer one, nothing identifying stored', async () => {
  const phoneA = await register('sam.sync@example.com');
  const doc = localHome();
  const t1 = Date.now() - 5000;
  const put = await phoneA('PUT', '/api/mine', { home: { ...doc, extra: 'dropped' }, updatedAt: t1 });
  assert.strictEqual(put.status, 200, put.text);
  assert.ok(!('extra' in put.data.home) && put.data.home.pets[0].name === 'Biscuit');
  assert.strictEqual((await phoneA('PUT', '/api/mine', { home: { ...C.sample(Date.now(), NY), sample: true } })).status, 400, 'the sample stays on the phone');
  const phoneB = client();
  assert.strictEqual((await phoneB('POST', '/api/auth/login', { email: 'sam.sync@example.com', password: 'a long enough password' })).status, 200);
  assert.strictEqual((await phoneB('GET', '/api/mine')).data.home.pets[0].name, 'Biscuit', 'on the second phone');
  const stale = await phoneB('PUT', '/api/mine', { home: { ...doc, name: 'Older' }, updatedAt: t1 - 60000 });
  assert.ok(stale.data.stale && stale.data.home.name === 'Test home', 'an older copy is refused');
  const made = await shareOne();
  const sh = await phoneB('PUT', '/api/mine', { shared: { code: made.code, key: made.key }, updatedAt: Date.now() });
  assert.deepStrictEqual([sh.data.home, sh.data.shared.code], [null, made.code], 'once shared, the account keeps the keys');
  assert.strictEqual((await phoneB('PUT', '/api/mine', { shared: { code: 'nope', key: 'x' } })).status, 400);
  const dump = store._dump();
  assert.ok(!dump.includes('sam.sync') && !dump.includes(uidOf('sam.sync@example.com')), 'filed under an HMAC, never the account id or email');
  const other = await register('kim.other@example.com');
  assert.deepStrictEqual((await other('GET', '/api/mine')).data, { home: null, shared: null, updatedAt: null }, 'another account sees nothing');
  assert.strictEqual((await phoneA('DELETE', '/api/mine')).status, 200);
  assert.strictEqual((await phoneB('GET', '/api/mine')).data.shared, null);
  assert.strictEqual((await client()('GET', `/api/l/${made.link}`)).status, 200, 'the household link keeps working for everyone else');
});

test('read the vet paperwork: checked before any spend, one forced tool, the address and account numbers never reach the model or the proposal, nothing stored', async () => {
  const me = await register('ana.paper@example.com');
  const dump = store._dump();
  const calls = await modelCalls();
  for (const body of [{}, { text: '   ' }, { text: '1234 5678', kind: 'dog' }, { text: 'x'.repeat(9000) }, { text: 'Rabies', photo: { type: 'image/png', data: 'AAAA' } }, { photo: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4 not a photo').toString('base64') } }]) {
    assert.strictEqual((await me('POST', '/api/read-paperwork', body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.strictEqual((await me('POST', '/api/read-paperwork', { x: 'x'.repeat(10 * 1024 * 1024) })).status, 413, 'its own 9 MB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  fakeClient.seen.length = 0;
  const r = await me('POST', '/api/read-paperwork', { ...PAPER, name: 'Biscuit Doe', email: 'ana@example.com' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(fakeClient.calls[fakeClient.calls.length - 1], 'record_paperwork', 'one forced tool');
  assert.strictEqual(fakeClient.seen.length, 1);
  assert.ok(!/Elm Street|62704|99887766|555-010|Biscuit|example\.com/.test(fakeClient.seen[0]), 'the pasted address, account, phone and names never reach the model');
  assert.ok(/Rabies booster given today/.test(fakeClient.seen[0]) && /The pet is a dog/.test(fakeClient.seen[0]));
  const p = r.data.proposal;
  assert.deepStrictEqual(Object.keys(p).sort(), ['medicines', 'nextVisit', 'stripped', 'vaccinations', 'weight']);
  assert.ok(p.stripped, 'it says what was left out');
  assert.deepStrictEqual(p.vaccinations.map((v) => v.name), ['Rabies booster', 'DHPP', 'Flea & tick tablet']);
  assert.deepStrictEqual([p.medicines[0].schedule, p.weight.g, p.nextVisit.what], ['twice daily', 11400, 'Recheck ears']);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  // A photo: checked by its bytes, sent as an image, not kept.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]).toString('base64');
  const ph = await me('POST', '/api/read-paperwork', { kind: 'cat', photo: { type: 'image/jpeg', data: jpeg } });
  assert.strictEqual(ph.status, 200, ph.text);
  assert.ok(/"type":"image"/.test(fakeClient.seen[fakeClient.seen.length - 1]) && /The pet is a cat/.test(fakeClient.seen[fakeClient.seen.length - 1]));
  // Hostile output.
  const inj = await me('POST', '/api/read-paperwork', { ...PAPER, text: 'INJECT the rabies card' });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi');
  assert.ok(!/Elm|Street|99887766|555|example|SW1A|Main Road|Jane|\$45|evil|owner|price/i.test(inj.text), `no address, account, phone, email, price or unknown key: ${inj.text}`);
  const ip2 = inj.data.proposal;
  assert.ok(ip2.vaccinations.length <= 12 && new Set(ip2.vaccinations.map((v) => C.fold(v.name))).size === ip2.vaccinations.length, 'twelve at most, no duplicates');
  assert.ok(ip2.vaccinations.every((v) => ['vaccine', 'flea', 'worm', 'other'].includes(v.kind) && (v.given === null || C.isDay(v.given)) && (v.due === null || v.due < '2099-01-01')), 'kinds from the list, dates real and sane');
  assert.strictEqual(ip2.weight, null, 'a 9,999 kg dog is no weight');
  assert.ok(ip2.medicines.every((m) => m.name && !/Invoice/i.test(m.name)));
  assert.strictEqual((await me('POST', '/api/read-paperwork', { ...PAPER, text: 'BLANK paper' })).status, 422);
  assert.match((await me('POST', '/api/read-paperwork', { ...PAPER, text: 'MAXTOKENS paper' })).data.error, /ran long/);
  const up = await me('POST', '/api/read-paperwork', { ...PAPER, text: 'UPSTREAM401 paper' });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in/.test(up.text), 'a provider error is not passed on');
  const busy = await me('POST', '/api/read-paperwork', { ...PAPER, text: 'UPSTREAM529 paper' });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.strictEqual(store._dump(), dump, 'reading stores nothing');
  assert.ok(!Object.keys(ai.TOOL.input_schema.properties).some((k) => /address|account|phone|email|owner|price/i.test(k)), 'the tool has no field for any of it');
});

test('the gates: an unconfirmed free account gets verify-email 403, out of credit 402, the day’s free ceiling 503 - never a 413, never a model call', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/read-paperwork', PAPER);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/pawlog/api/auth/verify/send', 'the resend link is under this app’s mount');
    assert.strictEqual((await eve('POST', '/api/read-paperwork', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 403, '403 before the body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
    assert.strictEqual((await eve('PUT', '/api/mine', { home: localHome() })).status, 200, 'syncing needs no AI and no confirmation');
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/read-paperwork', PAPER)).status, 402);
  assert.strictEqual((await cal('POST', '/api/read-paperwork', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 402, '402, not 413');
  const dan = await register('dan.capped@example.com');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-pawlog-${day}`, { usd: 5000 });
  try {
    const capped = await dan('POST', '/api/read-paperwork', PAPER);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/read-paperwork', { x: 'x'.repeat(12 * 1024 * 1024) })).status, 503, 'the ceiling answers before the parser too');
  } finally { await identityStore.remove('control', `free-spend-pawlog-${day}`); }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'none of them spent anything');
  assert.strictEqual((await dan('POST', '/api/read-paperwork', PAPER)).status, 200, 'and it lifts when the day’s tally is under it');
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/pawlog' ? res.redirect(301, '/pawlog/') : next()));
  host.use('/pawlog', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/pawlog`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
