// Pure rules first, then end to end against the memory store and the fake
// model:
//   FIRSTDAY_MEMORY=1 FIRSTDAY_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /firstday, the way
// the lab mounts it, so the auth cookie, the budget gate, the device cookie's
// path, the manager key, the role links and the metered route's parser are
// exercised as deployed. Model calls are counted from the identity's usage
// rows - the same rows that bill a real account.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.FIRSTDAY_MEMORY !== '1' || process.env.FIRSTDAY_FAKE_AI !== '1') {
  console.error('run with FIRSTDAY_MEMORY=1 FIRSTDAY_FAKE_AI=1');
  process.exit(1);
}
process.env.FREE_TIER_DAILY_CAP_USD = '1000';
process.env.DAILY_CAP_CACHE_MS = '0';

const { app, identityStore, store } = require('../server');
const C = require('../public/firstday-core');
const P = require('../lib/plans');
const ai = require('../lib/ai');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NOW = Date.parse('2026-10-23T15:00:00Z'); // a Friday
const DAY = 86400000;

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
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
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
const HOSTILE = ['<img src=x onerror=alert(1)>Ana', '"><svg onload=alert(1)>Bo', '\u202eCal\u202c', 'Dee <script>x</script>'];
const ids = (() => { let n = 0; return (p) => C.idFrom(p, `test:${n++}`, 9); })();
function basePlan(extra) {
  return { hire: 'Sam', role: 'Barista', start: '2026-10-26', manager: 'Mia', buddy: 'Jonah', business: 'Corner Cafe', pattern: 'onsite', zone: 'America/New_York', ...(extra || {}) };
}
function doc(extra, opts) { return C.newDoc(basePlan(extra), opts || { template: 'frontofhouse' }, NOW, ids); }

/* ---------------- cleaning and refusals ---------------- */

test('typed strings go through one door; a person is a first name and at most an initial', () => {
  assert.strictEqual(C.firstName('Mia Rodriguez'), 'Mia R.');
  assert.strictEqual(C.firstName('<b>Sam</b>'), 'Sam');
  assert.strictEqual(C.firstName('\u202eCal\u202c'), 'Cal');
  assert.strictEqual(C.firstName('Dee <script>x</script>'), 'Dee X.', 'the tag goes; what was inside is only text');
  assert.strictEqual(C.firstName('42'), '');
  assert.strictEqual(C.clean('a <img src=x onerror=1> b', 50), 'a b');
  assert.strictEqual(C.clean('x'.repeat(500), 90).length, 90);
  assert.strictEqual(C.cleanLines('Hi\n\n\n\nthere <b>x</b>', 100), 'Hi\n\nthere x');
});

test('a field shaped like a government ID, a bank number, pay, a phone number or an email is refused with a sentence', () => {
  const refused = {
    id: ['SSN 123-45-6789', 'NI number AB 12 34 56 C', 'AB123456C', 'passport number on file', 'date of birth 1990'],
    bank: ['IBAN GB82 WEST 1234 5698 7654 32', 'sort code please', 'routing number', 'their bank details'],
    salary: ['Salary agreed', '$52,000 a year', '£30k', '€48000', '$18/hr', '17.50 an hour', 'starting wage'],
    number: ['call 07700 900123', '4111 1111 1111 1111', '555-867-5309'],
    email: ['sam@example.com'],
    address: ['their home address'],
  };
  for (const [code, list] of Object.entries(refused)) {
    for (const s of list) {
      const hit = C.sensitive(s);
      assert.ok(hit, `${s} should be refused`);
      assert.ok(['id', 'bank', 'number'].includes(code) ? ['id', 'bank', 'number'].includes(hit.code) : hit.code === code, `${s}: ${hit.code} not ${code}`);
      assert.ok(/[.]$/.test(hit.text) && hit.text.length > 30, 'a sentence');
    }
  }
  for (const ok of ['Order the $1,200 laptop', 'Bring $5 for parking', 'Start 2026-10-26 at 9:00', 'Arrive at 8:30am', 'Unit 4, back door', 'Lunch for 2 hours', 'Set up the 2FA app', 'Review the first 90 days']) {
    assert.strictEqual(C.sensitive(ok), null, `${ok} should be allowed`);
  }
  assert.throws(() => C.guard('What to bring', '$45,000 salary'), (e) => e.status === 422 && /^What to bring: That looks like pay/.test(e.message));
});

/* ---------------- dates ---------------- */

test('business days: weekends, month and year ends, holidays, weekend workers, and the way back', () => {
  const cal = { holidays: [] };
  assert.strictEqual(C.shiftWorkdays('2026-10-26', 4, cal), '2026-10-30', 'Mon + 4 = Fri');
  assert.strictEqual(C.shiftWorkdays('2026-10-26', 5, cal), '2026-11-02', 'over the weekend and the month end');
  assert.strictEqual(C.shiftWorkdays('2026-10-26', -1, cal), '2026-10-23', 'the working day before a Monday is Friday');
  assert.strictEqual(C.shiftWorkdays('2026-10-26', -10, cal), '2026-10-12');
  assert.strictEqual(C.shiftWorkdays('2026-12-28', 4, { holidays: ['2027-01-01'] }), '2027-01-04', 'across the new year and its holiday');
  assert.strictEqual(C.shiftWorkdays('2026-11-23', 3, { holidays: ['2026-11-26', '2026-11-27'] }), '2026-11-30', 'Thanksgiving and the Friday after');
  assert.strictEqual(C.shiftWorkdays('2027-02-26', 1, cal), '2027-03-01', 'February end');
  assert.strictEqual(C.shiftWorkdays('2028-02-28', 1, cal), '2028-02-29', 'a leap day is a Tuesday working day');
  assert.strictEqual(C.shiftWorkdays('2026-10-24', 1, { workWeekends: true }), '2026-10-25', 'weekend workers count Sunday');
  assert.strictEqual(C.shiftWorkdays('2026-10-24', 0, cal), '2026-10-24', 'day 1 can be a Saturday');
  // Calendar-day check-ins roll forward to a working day.
  const plan = { start: '2026-10-26', holidays: ['2026-12-25'] };
  assert.strictEqual(C.dueOf(plan, { offset: 60, unit: 'cd' }), '2026-12-28', 'Fri 25 Dec is a holiday, then the weekend');
  assert.strictEqual(C.dueOf(plan, { offset: 30, unit: 'cd' }), '2026-11-25');
  // DST: civil dates do not move when the clocks do (UK 25 Oct, US 1 Nov).
  assert.strictEqual(C.shiftWorkdays('2026-10-23', 1, cal), '2026-10-26');
  assert.strictEqual(C.shiftWorkdays('2026-10-30', 1, cal), '2026-11-02');
  assert.strictEqual(C.addDays('2026-03-08', 1), '2026-03-09');
  // offsetFor is the inverse of shiftWorkdays for every working day in range.
  for (const p of [{ start: '2026-10-26', holidays: ['2026-11-26', '2026-12-25', '2027-01-01'] }, { start: '2026-12-31', holidays: [], workWeekends: true }, { start: '2027-02-27', holidays: ['2027-03-01'] }]) {
    for (let n = C.LIMITS.offsetMin; n <= C.LIMITS.offsetMax; n++) {
      const d = C.shiftWorkdays(p.start, n, p);
      assert.strictEqual(C.offsetFor(p, d), n, `${p.start} ${n} -> ${d}`);
    }
  }
  assert.strictEqual(C.offsetFor({ start: '2026-10-26', holidays: [] }, '2026-10-31'), 5, 'a Saturday picked after day 1 counts as the next working day');
  assert.strictEqual(C.jobDay({ start: '2026-10-26', holidays: [] }, '2026-11-02'), 6);
  assert.strictEqual(C.jobDay({ start: '2026-10-26', holidays: [] }, '2026-10-25'), 0);
});

test('time: the countdown is to the arrival time in the business zone, in real hours across a clock change', () => {
  // London's clocks went back on Sun 25 Oct 2026: Fri 23 Oct 09:00 BST is
  // 08:00Z; Mon 26 Oct 09:00 GMT is 09:00Z - 3 days and 1 hour, not 3 days.
  const d = doc({ zone: 'Europe/London', arrive: '09:00' });
  const c = C.countdown(d, Date.parse('2026-10-23T08:00:00Z'));
  assert.deepStrictEqual([c.before, c.days, c.hours, c.mins, c.toGo], [true, 3, 1, 0, 3]);
  // New York changes on 1 Nov: a start on Mon 2 Nov at 8:30 EST is 13:30Z.
  const ny = doc({ start: '2026-11-02', arrive: '08:30' });
  assert.strictEqual(C.countdown(ny, NOW).at, Date.parse('2026-11-02T13:30:00Z'));
  assert.strictEqual(C.countdown(doc(), Date.parse('2026-10-26T12:00:00Z')).label, 'Today at 9am');
  assert.strictEqual(C.countdown(doc(), Date.parse('2026-10-25T18:00:00Z')).label, 'Tomorrow at 9am');
  const after = C.countdown(doc(), Date.parse('2026-10-28T15:00:00Z'));
  assert.deepStrictEqual([after.before, after.day, after.label], [false, 3, 'Day 3 of the first week']);
  assert.strictEqual(C.todayIn('Pacific/Kiritimati', Date.parse('2026-10-23T12:00:00Z')), '2026-10-24');
});

/* ---------------- templates ---------------- */

test('every template is whole: owners, offsets, sections, a timed day 1, four check-ins, words for what is missing, nothing sensitive', () => {
  assert.deepStrictEqual(Object.keys(C.TEMPLATES).sort(), ['frontofhouse', 'office', 'remote', 'seasonal', 'trades']);
  for (const [id, t] of Object.entries(C.TEMPLATES)) {
    for (const pattern of C.PATTERNS) {
      const tasks = C.fromTemplate(id, pattern, ids);
      assert.strictEqual(tasks.length, t.tasks.filter((x) => !x.only || x.only.includes(pattern)).length, `${id}/${pattern}: every task survives cleaning`);
      const phases = new Set(tasks.map(C.phaseOf));
      for (const s of C.SECTIONS) assert.ok(phases.has(s[0]), `${id} has ${s[0]}`);
      for (const o of C.OWNERS) assert.ok(tasks.some((x) => x.owner === o), `${id} gives ${o} something`);
      assert.deepStrictEqual(tasks.filter((x) => x.checkin).map((x) => x.checkin).sort(), ['d30', 'd5', 'd60', 'd90']);
      assert.ok(tasks.filter((x) => x.checkin === 'd5').every((x) => x.offset === 4 && x.unit === 'bd'));
      assert.ok(tasks.filter((x) => ['d30', 'd60', 'd90'].includes(x.checkin)).every((x) => x.unit === 'cd' && x.offset === Number(x.checkin.slice(1))));
      const day1 = tasks.filter((x) => C.phaseOf(x) === 'day1');
      assert.ok(day1.length >= 4 && day1.every((x) => x.time), `${id}: day 1 is hour by hour`);
      const times = day1.map((x) => x.time);
      assert.deepStrictEqual(times, times.slice().sort(), `${id}: day 1 in time order`);
      const prep = tasks.filter((x) => C.phaseOf(x) === 'before' && x.owner !== 'hire');
      assert.ok(prep.length >= 6 && prep.every((x) => x.miss), `${id}: every prep task says what is missing`);
      assert.ok(prep.some((x) => /team|crew/.test(x.title)) && prep.some((x) => /paperwork/.test(x.title)) && prep.some((x) => /welcome/i.test(x.title)), `${id}: team told, paperwork, welcome`);
      for (const x of tasks) {
        assert.ok(x.offset >= C.LIMITS.offsetMin && x.offset <= C.LIMITS.offsetMax && x.title.length <= C.LIMITS.title && !C.sensitive(x.title));
      }
    }
    assert.ok(t.label && t.emoji && t.blurb && C.PATTERNS.includes(t.pattern));
  }
  // The pattern decides between a desk and a shipped laptop.
  assert.ok(C.fromTemplate('office', 'onsite').some((x) => /desk/.test(x.title)) && !C.fromTemplate('office', 'onsite').some((x) => /Ship the laptop/.test(x.title)));
  assert.ok(C.fromTemplate('office', 'remote').some((x) => /Ship the laptop/.test(x.title)) && !C.fromTemplate('office', 'remote').some((x) => /desk/.test(x.title)));
  assert.ok(C.fromTemplate('office', 'hybrid').some((x) => /desk/.test(x.title)) && C.fromTemplate('office', 'hybrid').some((x) => /Ship the laptop/.test(x.title)));
});

/* ---------------- readiness, overdue, changes ---------------- */

test('readiness and overdue: the business’s prep, the earliest missing first, in words, with the days to go', () => {
  const s = C.sample('2026-10-23', 'America/New_York', NOW);
  assert.strictEqual(s.plan.start, '2026-10-26', 'the sample starts next Monday');
  const r = C.readiness(s, NOW);
  assert.strictEqual(r.text, '7 of 9 done - uniform not ordered, buddy break not planned, 3 days to go');
  assert.deepStrictEqual([r.level, r.pct], ['behind', 78]);
  const od = C.overdue(s, NOW);
  assert.deepStrictEqual(od.map((t) => t.title), ['Order the uniform and name badge']);
  assert.strictEqual(od[0].due, '2026-10-12');
  // Tick everything before day 1: all set.
  for (const t of s.tasks) if (C.phaseOf(t) === 'before') C.manage(s, 'tick', { id: t.id, done: true }, NOW);
  assert.deepStrictEqual([C.readiness(s, NOW).text, C.readiness(s, NOW).level], ['9 of 9 done - all set, 3 days to go', 'ready']);
  // A fresh office plan: nothing done, and the wording for more than two.
  const o = doc({}, { template: 'office' });
  const ro = C.readiness(o, NOW);
  assert.match(ro.text, /^0 of 9 done - laptop not ordered, paperwork not sent and 7 more, 3 days to go$/);
  // The new hire's own to-dos are not counted against the business.
  assert.ok(o.tasks.some((t) => t.owner === 'hire' && C.phaseOf(t) === 'before'));
  assert.strictEqual(C.readiness(doc({ start: '2026-10-24' }), NOW).text.endsWith('starts tomorrow'), true);
});

test('changes: add, edit, move, remove, tick, holidays, details, a template or a proposal - every one checked', () => {
  const d = doc();
  const n = d.tasks.length;
  const r = C.manage(d, 'addTask', { task: { title: 'Order the coffee-shop apron', owner: 'it', offset: -5 } }, NOW, ids);
  assert.strictEqual(d.tasks.length, n + 1);
  const t = d.tasks.find((x) => x.id === r.id);
  assert.deepStrictEqual([t.owner, t.offset, t.unit, t.time, t.done], ['it', -5, 'bd', null, false]);
  C.manage(d, 'editTask', { id: t.id, task: { offset: 0, time: '7:15', owner: 'nobody' } }, NOW);
  const t2 = d.tasks.find((x) => x.id === r.id);
  assert.deepStrictEqual([t2.title, t2.offset, t2.time, t2.owner], ['Order the coffee-shop apron', 0, '07:15', 'it'], 'a made-up owner keeps the old one');
  C.manage(d, 'editTask', { id: t.id, task: { offset: 3, time: '10:00' } }, NOW);
  assert.strictEqual(d.tasks.find((x) => x.id === t.id).time, null, 'only day 1 is hour by hour');
  assert.throws(() => C.manage(d, 'addTask', { task: { title: '', owner: 'it', offset: 1 } }, NOW), (e) => e.status === 400);
  assert.throws(() => C.manage(d, 'addTask', { task: { title: 'Far out', owner: 'it', offset: 91 } }, NOW), (e) => e.status === 400);
  assert.throws(() => C.manage(d, 'addTask', { task: { title: 'Note salary $45,000', owner: 'it', offset: 1 } }, NOW), (e) => e.status === 422);
  assert.throws(() => C.manage(d, 'addTask', { task: { title: 'Add SSN 123-45-6789 to payroll', owner: 'it', offset: 1 } }, NOW), (e) => e.status === 422);
  // Move: the task takes its neighbour's day and sits beside it.
  const order = () => C.ordered(d).map((x) => x.t.id);
  const before = order();
  const k = before.indexOf(t.id);
  C.manage(d, 'moveTask', { id: t.id, dir: 'up' }, NOW);
  assert.strictEqual(order().indexOf(t.id), k - 1);
  assert.deepStrictEqual(C.manage(d, 'moveTask', { id: order()[0], dir: 'up' }, NOW), { moved: false });
  C.manage(d, 'tick', { id: t.id, done: true }, NOW);
  assert.deepStrictEqual([d.tasks.find((x) => x.id === t.id).done, d.tasks.find((x) => x.id === t.id).doneBy], [true, 'manager']);
  C.manage(d, 'removeTask', { id: t.id }, NOW);
  assert.ok(!d.tasks.some((x) => x.id === t.id));
  assert.throws(() => C.manage(d, 'removeTask', { id: t.id }, NOW), (e) => e.status === 404);
  // Holidays move due dates; garbage and duplicates go.
  const ck = d.tasks.find((x) => x.checkin === 'd5');
  assert.strictEqual(C.dueOf(d.plan, ck), '2026-10-30');
  C.manage(d, 'holidays', { holidays: ['2026-10-28', '2026-10-28', 'not a date', '2026-02-30'] }, NOW);
  assert.deepStrictEqual(d.plan.holidays, ['2026-10-28']);
  assert.strictEqual(C.dueOf(d.plan, ck), '2026-11-02', 'the day-5 check-in moves past the holiday and the weekend');
  // Details: names cleaned, start bounded, refusals.
  C.manage(d, 'details', { plan: { hire: 'Samira Khan', bring: 'Black shoes' } }, NOW);
  assert.deepStrictEqual([d.plan.hire, d.plan.bring, d.plan.role], ['Samira K.', 'Black shoes', 'Barista']);
  assert.throws(() => C.manage(d, 'details', { plan: { start: '2028-01-01' } }, NOW), (e) => e.status === 400);
  assert.throws(() => C.manage(d, 'details', { plan: { welcome: 'Your salary is $40k' } }, NOW), (e) => e.status === 422 && /^The welcome message:/.test(e.message));
  assert.throws(() => C.manage(d, 'details', { plan: { where: '42 Elm Street - their home address' } }, NOW), (e) => e.status === 422);
  // A template or a proposal replaces the tasks, cleaned, nothing ticked.
  C.manage(d, 'template', { template: 'trades' }, NOW, ids);
  assert.ok(d.tasks.some((x) => /PPE/.test(x.title)) && d.tasks.every((x) => !x.done));
  const res = C.manage(d, 'replaceTasks', { tasks: [{ title: 'A', owner: 'manager', offset: -2 }, { title: '<b>B</b>', owner: 'hire', offset: 0, time: '9:00' }, { title: 'bad', owner: 'manager', offset: 'x' }] }, NOW, ids);
  assert.strictEqual(res.count, 2);
  assert.deepStrictEqual(d.tasks.map((x) => x.title), ['A', 'B']);
  // The cap.
  const big = doc();
  while (big.tasks.length < C.LIMITS.tasks) C.manage(big, 'addTask', { task: { title: 'More', owner: 'hire', offset: 2 } }, NOW, ids);
  assert.throws(() => C.manage(big, 'addTask', { task: { title: 'One too many', owner: 'hire', offset: 2 } }, NOW, ids), (e) => e.status === 409);
  // Copy for the next hire: the same tasks, nothing done.
  const copied = C.newDoc(basePlan({ hire: 'Leo', start: '2026-11-09' }), { tasks: C.copyTasks(C.sample('2026-10-23', 'UTC', NOW)) }, NOW, ids);
  assert.strictEqual(copied.tasks.length, C.sample('2026-10-23', 'UTC', NOW).tasks.length);
  assert.ok(copied.tasks.every((x) => !x.done) && !Object.keys(copied.checkins).length);
});

test('role links: each ticks only its own tasks; only the new hire answers a check-in, only once it is open', () => {
  const d = doc();
  const buddyTask = d.tasks.find((t) => t.owner === 'buddy');
  const hireTask = d.tasks.find((t) => t.owner === 'hire');
  C.linkAct(d, 'buddy', 'tick', { id: buddyTask.id, done: true }, NOW);
  assert.deepStrictEqual([buddyTask.done, buddyTask.doneBy], [true, 'buddy']);
  assert.throws(() => C.linkAct(d, 'buddy', 'tick', { id: hireTask.id, done: true }, NOW), (e) => e.status === 403);
  assert.throws(() => C.linkAct(d, 'it', 'tick', { id: buddyTask.id, done: false }, NOW), (e) => e.status === 403);
  assert.throws(() => C.linkAct(d, 'manager', 'tick', { id: buddyTask.id, done: false }, NOW), (e) => e.status === 403);
  assert.throws(() => C.linkAct(d, 'buddy', 'checkin', { key: 'd5', mood: 4 }, NOW), (e) => e.status === 403);
  assert.throws(() => C.linkAct(d, 'hire', 'checkin', { key: 'd5', mood: 4 }, NOW), (e) => e.status === 409 && /opens on Friday 30 Oct/.test(e.message));
  const fri = Date.parse('2026-10-30T14:00:00Z');
  assert.throws(() => C.linkAct(d, 'hire', 'checkin', { key: 'd5' }, fri), (e) => e.status === 400);
  assert.throws(() => C.linkAct(d, 'hire', 'checkin', { key: 'd7', mood: 3 }, fri), (e) => e.status === 404);
  assert.throws(() => C.linkAct(d, 'hire', 'checkin', { key: 'd5', mood: 3, help: 'my sort code is 12-34-56' }, fri), (e) => e.status === 422);
  C.linkAct(d, 'hire', 'checkin', { key: 'd5', mood: 4, unclear: 'The <b>loyalty</b> cards', help: 'A quieter shift\nwith Jonah' }, fri);
  assert.deepStrictEqual({ ...d.checkins.d5, at: 'x' }, { mood: 4, unclear: 'The loyalty cards', help: 'A quieter shift\nwith Jonah', at: 'x' });
  assert.strictEqual(C.checkinState(d, 'd5', '2026-10-30').state, 'done');
  assert.strictEqual(C.checkinState(d, 'd30', '2026-10-30').state, 'upcoming');
  // The sample's preview may open one early - the page only; the server never passes it.
  const s = C.sample('2026-10-23', 'UTC', NOW);
  C.linkAct(s, 'hire', 'checkin', { key: 'd30', mood: 5 }, NOW, { early: true });
  assert.strictEqual(s.checkins.d30.mood, 5);
  assert.ok(!/early/.test(read('server.js')), 'the server never lets a check-in open early');
});

/* ---------------- views and the calendar ---------------- */

test('what each link sees: first names, the start, its own tasks; the hire also the welcome, the week and their check-ins - nothing else', () => {
  const d = doc({ where: 'Back door', bring: 'Shoes', welcome: 'Hi Sam', holidays: ['2026-12-25'] });
  d.checkins.d5 = { mood: 2, unclear: 'SECRET-ANSWER', help: '', at: '2026-10-30T10:00:00.000Z' };
  for (const role of C.ROLES) {
    const v = C.roleView(d, role, NOW);
    const keys = ['countdown', 'plan', 'role', 'tasks', 'today', 'v'].concat(role === 'hire' ? ['checkins', 'schedule', 'welcome'] : []);
    assert.deepStrictEqual(Object.keys(v).sort(), keys.sort(), role);
    assert.deepStrictEqual(Object.keys(v.plan).sort(), ['arrive', 'business', 'buddy', 'hire', 'manager', 'pattern', 'role', 'start', 'zone'].sort());
    assert.ok(v.tasks.every((t) => d.tasks.find((x) => x.id === t.id).owner === role), `${role}: only its own tasks`);
    assert.ok(v.tasks.every((t) => Object.keys(t).sort().join() === 'done,due,id,overdue,phase,time,title'));
    const text = JSON.stringify(v);
    assert.ok(!text.includes('2026-12-25') && !text.includes('holidays') && !text.includes('readiness') && !text.includes('miss'), `${role}: no holidays, no meter`);
    assert.strictEqual(text.includes('SECRET-ANSWER'), role === 'hire', `${role}: a check-in answer only on the hire's own link`);
  }
  const h = C.roleView(d, 'hire', NOW);
  assert.deepStrictEqual(h.welcome, { where: 'Back door', ask: 'Mia', bring: 'Shoes', message: 'Hi Sam' });
  assert.ok(h.schedule.length && h.schedule.every((t) => ['day1', 'week'].includes(t.phase)) && !h.schedule.some((t) => /check-in/i.test(t.title)));
  assert.ok(h.schedule.every((t) => !('done' in t)), 'the schedule carries nobody’s ticks');
  assert.throws(() => C.roleView(d, 'manager', NOW), (e) => e.status === 403);
  const m = C.managerView(d, NOW);
  assert.ok(m.readiness && m.overdue && m.checkins.length === 4 && m.plan.holidays.length === 1);
});

test('the .ics: valid, CRLF, folded, escaped; day 1 at real instants across a clock change; each link gets its own', () => {
  const d = doc({ zone: 'Europe/London', start: '2026-10-26', arrive: '08:30', business: 'Fernhill, Cafe; "Ltd"', where: 'Side door' });
  const ics = C.buildIcs(d, 'hire', NOW);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'CRLF only');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`);
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
  assert.match(ics, /X-WR-CALNAME:My first week · Fernhill\\, Cafe\\; "Ltd"/);
  // London is on GMT after 25 Oct: 08:30 local is 08:30Z.
  assert.match(ics, /DTSTART:20261026T083000Z\r\nDTEND:20261026T090000Z\r\nSUMMARY:First day at Fernhill/);
  const hireCount = C.roleView(d, 'hire', NOW);
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 1 + new Set(hireCount.tasks.map((t) => t.id).concat(hireCount.schedule.map((t) => t.id))).size);
  assert.match(ics, /DTSTART;VALUE=DATE:20261027\r\nDTEND;VALUE=DATE:20261028/);
  const buddy = C.buildIcs(d, 'buddy', NOW);
  assert.strictEqual((buddy.match(/BEGIN:VEVENT/g) || []).length, d.tasks.filter((t) => t.owner === 'buddy').length);
  const mgr = C.buildIcs(d, 'manager', NOW);
  assert.strictEqual((mgr.match(/BEGIN:VEVENT/g) || []).length, d.tasks.length);
  // A US plan across 1 Nov: a day-1 9am in New York on Mon 2 Nov is 14:00Z (EST), not 13:00Z.
  const ny = C.buildIcs(doc({ start: '2026-11-02', arrive: '09:00' }), 'hire', NOW);
  assert.match(ny, /DTSTART:20261102T140000Z/);
  // Hostile text cannot break a line out of its field.
  const bad = doc();
  C.manage(bad, 'addTask', { task: { title: 'Line\r\nBEGIN:VEVENT; evil', owner: 'buddy', offset: 1 } }, NOW, ids);
  assert.ok(!/\r\nBEGIN:VEVENT; evil/.test(C.buildIcs(bad, 'buddy', NOW)));
});

/* ---------------- the page and the code ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every text colour holds 4.5:1 on its surface in both themes', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const ok = (fg, bg, min = 4.5) => assert.ok(ratio(t[fg], t[bg]) >= min, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const bg of ['bg', 'card', 'card2']) for (const fg of ['text', 'muted', 'link', 'ind', 'err', 'ok', 'accent']) ok(fg, bg);
    ok('accent-ink', 'accent'); ok('link', 'accent-soft'); ok('text', 'accent-soft'); ok('muted', 'card2');
    for (const s of ['ok', 'warn', 'err']) ok(s, `${s}-bg`);
    for (const o of C.OWNERS) ok(`o-${o}`, `o-${o}-bg`);
    ok('bg', 'text'); ok('card', 'ind'); ok('ok', 'card'); // the toast, the preview bar, a tick
  }
  const lab = require('../../../lab.js').get('firstday');
  for (const c of [lab.color, lab.color2]) assert.ok(ratio('#ffffff', c) >= 4.5, `lab card colour ${c} holds white text`);
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { FIRSTDAY_MEMORY: '1' }], ['./lib/fakeai', { FIRSTDAY_FAKE_AI: '1' }], ['./server', { FIRSTDAY_FAKE_AI: '1', FIRSTDAY_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, FIRSTDAY_MEMORY: '', FIRSTDAY_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
});

test('the collection prefix is honoured; single-field queries only; only the host’s shared dependencies', () => {
  const r = spawnSync(process.execPath, ['-e', "const {store}=require('./lib/store'); console.log(store.kind)"], {
    cwd: ROOT, env: { ...process.env, FIRSTDAY_MEMORY: '', FIRSTDAY_COLLECTION_PREFIX: 'firstday_' }, encoding: 'utf8',
  });
  assert.strictEqual(r.stdout.trim(), 'firestore');
  const src = read('lib/store.js');
  assert.ok(/FIRSTDAY_COLLECTION_PREFIX/.test(src) && (src.match(/PREFIX \+ path/g) || []).length >= 10);
  const server = read('server.js');
  const queries = [...server.matchAll(/where: \[(\[[^\]]*\](?:, )?)+\]/g)];
  assert.ok(queries.length >= 1);
  for (const m of queries) assert.strictEqual((m[0].match(/\['/g) || []).length, 1, m[0]);
  assert.ok(!/orderBy/.test(server));
  assert.deepStrictEqual(Object.keys(require('../package.json').dependencies).sort(), ['@anthropic-ai/sdk', '@google-cloud/firestore', '@simplewebauthn/server', 'express']);
});

test('the page: relative links, no inline script or handlers, the banner, storage wrapped, everything escaped; the core has no clock and no dice', () => {
  const html = read('public/index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && /<body class="dk">/.test(html));
  assert.ok(!/(src|href)="\//.test(html), 'relative asset links only');
  const js = read('public/app.js');
  assert.ok(!/\son[a-z]+=\\?["']/.test(js), 'no handler written into markup');
  assert.ok(!/\.on(click|submit|change|input|load|error|keydown)\s*=/.test(js));
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js));
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(!/<script/i.test(js));
  assert.ok(!/fetch\(['"]\//.test(js) && !/href="\//.test(js) && !/location\.href = ['"]\//.test(js), 'every browser URL is relative to BASE');
  for (const f of ['hire', 'manager', 'buddy', 'role', 'business', 'title', 'where', 'bring', 'welcome', 'message', 'unclear', 'help', 'summary', 'label', 'text', 'ask', 'name']) {
    const raw = new RegExp(`'\\s*\\+\\s*[a-zA-Z0-9_.]+\\.${f}\\s*\\+\\s*'`, 'g');
    const bad = (js.match(raw) || []).filter((m) => !/(C\.LIMITS|\bL)\./.test(m));
    assert.deepStrictEqual(bad, [], `.${f} drawn without esc(): ${bad.join(' ')}`);
  }
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + read('public/firstday-core.js')), 'no email address in the page');
  assert.ok(!/Math\.random|Date\.now\(\)/.test(read('public/firstday-core.js')), 'the core has no dice and no clock');
  assert.match(js, /prefers-reduced-motion/);
  for (const f of ['server.js', 'lib/ai.js', 'lib/plans.js', 'public/firstday-core.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|about|answer|title)/.test(read(f)), `${f} logs a body`);
  assert.ok(/rel\.indexOf\('api\/'\) === 0 \|\| rel\.indexOf\('p\/'\) === 0 \|\| rel\.indexOf\('l\/'\) === 0/.test(read('public/sw.js')), 'the service worker never caches the API, a plan or a link');
  assert.match(js, /#k=/, 'the manager link for another device keeps its key after #, never in the path or query');
});

/* ---------------- over HTTP ---------------- */

async function register(email, ip) {
  const c = client(ip);
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const todayNY = () => C.todayIn('America/New_York', Date.now());
async function openPlan(c, plan, extra) {
  const r = await c('POST', '/api/plans', { plan: { ...basePlan({ start: C.nextMonday(todayNY()) }), ...(plan || {}) }, template: 'frontofhouse', ...(extra || {}) });
  assert.strictEqual(r.status, 200, r.text);
  return { code: r.data.code, key: r.data.key, links: r.data.links, plan: r.data.plan, mgr: { 'X-Firstday-Key': r.data.key } };
}

test('signed out: the page, a plan, its links and every tick work with zero model calls; the metered route answers 401 before reading a big body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.ok, true);
  for (const f of ['firstday-core.js', 'app.js', 'app.css', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/tailor', { about: 'A cafe of twelve people serving brunch.', role: 'Barista' })).status, 401);
  assert.strictEqual((await anon('POST', '/api/tailor', { about: 'x'.repeat(200 * 1024) })).status, 401, 'the gate answers before the parser');
  assert.strictEqual((await anon('POST', '/api/plans', { plan: { hire: 'x'.repeat(80 * 1024) } })).status, 413, 'every other route keeps its own limit');
  assert.strictEqual((await anon('POST', '/api/plans', { plan: { hire: '' } })).status, 400);
  const p = await openPlan(anon);
  assert.match(p.code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.deepStrictEqual(Object.keys(p.links).sort(), ['buddy', 'hire', 'it']);
  assert.strictEqual(new Set([p.code, ...Object.values(p.links)]).size, 4, 'four different codes');
  assert.match(anon.cookies.firstday_k, /^[A-Za-z0-9_-]{22}$/);
  for (const r of C.ROLES) assert.strictEqual((await anon('GET', `/api/l/${p.links[r]}`)).data.role, r);
  for (const route of [`/p/${p.code}`, `/l/${p.links.hire}`]) {
    const deep = await fetch(`${base}${route}`);
    assert.ok((await deep.text()).includes('<base href="../">'));
    assert.strictEqual(deep.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(deep.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.strictEqual((await fetch(`${base}${route}`, { method: 'POST' })).status, 405);
  }
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('a plan’s life over HTTP: the key, three links, ticks from each, the meter moving, a check-in, calendars, a new link, delete', async () => {
  const mgrC = client();
  // A start ten days ago, so the day-5 check-in is open now.
  const start = C.addDays(todayNY(), -10);
  const p = await openPlan(mgrC, { start, where: 'Back door', bring: 'Shoes', welcome: 'Hi Sam' });
  // Without the key the plan is the 404 a missing code gets.
  const missing = await client()('GET', '/api/plans/ZZZZZZZZZZ');
  for (const h of [{}, { 'X-Firstday-Key': P.newKey() }]) {
    const r = await client()('GET', `/api/plans/${p.code}`, undefined, h);
    assert.deepStrictEqual([r.status, r.data.error], [404, missing.data.error]);
    assert.strictEqual((await client()('POST', `/api/plans/${p.code}/manage`, { action: 'tick', id: p.plan.tasks[0].id, done: true }, h)).status, 404);
  }
  // A role link is not the plan, and the plan's code is not a link.
  assert.strictEqual((await client()('GET', `/api/plans/${p.links.hire}`, undefined, p.mgr)).status, 404);
  assert.strictEqual((await client()('GET', `/api/l/${p.code}`)).status, 404);
  let r = await mgrC('GET', `/api/plans/${p.code}`, undefined, p.mgr);
  assert.strictEqual(r.data.role, 'manager');
  const v = r.data.plan.v;
  assert.deepStrictEqual((await mgrC('GET', `/api/plans/${p.code}?since=${v}`, undefined, p.mgr)).data, { same: true, v });
  // The buddy ticks one of theirs; not someone else's.
  const buddy = client();
  const bv = (await buddy('GET', `/api/l/${p.links.buddy}`)).data.plan;
  r = await buddy('POST', `/api/l/${p.links.buddy}/act`, { action: 'tick', id: bv.tasks[0].id, done: true });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.plan.tasks[0].done, true);
  const otherId = p.plan.tasks.find((t) => t.owner === 'manager').id;
  assert.strictEqual((await buddy('POST', `/api/l/${p.links.buddy}/act`, { action: 'tick', id: otherId, done: true })).status, 403);
  assert.strictEqual((await buddy('POST', `/api/l/${p.links.buddy}/act`, { action: 'checkin', key: 'd5', mood: 3 })).status, 403);
  // IT ticks; the manager's meter moves (the buddy's tick above was not prep).
  const it = client();
  const iv = (await it('GET', `/api/l/${p.links.it}`)).data.plan;
  const beforeDone = (await mgrC('GET', `/api/plans/${p.code}`, undefined, p.mgr)).data.plan.readiness.done;
  await it('POST', `/api/l/${p.links.it}/act`, { action: 'tick', id: iv.tasks.find((t) => t.phase === 'before').id, done: true });
  r = await mgrC('GET', `/api/plans/${p.code}`, undefined, p.mgr);
  assert.strictEqual(r.data.plan.readiness.done, beforeDone + 1, 'IT’s tick counts on the manager’s meter');
  // The hire: an open check-in, then a future one refused.
  const hire = client();
  const hv = (await hire('GET', `/api/l/${p.links.hire}`)).data.plan;
  assert.deepStrictEqual(hv.welcome, { where: 'Back door', ask: 'Mia', bring: 'Shoes', message: 'Hi Sam' });
  assert.strictEqual(hv.checkins.find((k) => k.key === 'd5').state, 'open');
  r = await hire('POST', `/api/l/${p.links.hire}/act`, { action: 'checkin', key: 'd5', mood: 2, unclear: 'The rota app', help: 'Shadow a close' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.data.plan.checkins.find((k) => k.key === 'd5').answer.unclear, 'The rota app');
  r = await hire('POST', `/api/l/${p.links.hire}/act`, { action: 'checkin', key: 'd60', mood: 5 });
  assert.deepStrictEqual([r.status, /opens on/.test(r.data.error)], [409, true]);
  r = await mgrC('GET', `/api/plans/${p.code}`, undefined, p.mgr);
  assert.deepStrictEqual(r.data.plan.checkins.find((k) => k.key === 'd5').answer.help, 'Shadow a close');
  assert.ok(!(await buddy('GET', `/api/l/${p.links.buddy}`)).text.includes('Shadow a close'), 'the buddy never sees the answer');
  // Calendars.
  const ics = await hire('GET', `/api/l/${p.links.hire}/calendar.ics`);
  assert.strictEqual(ics.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.match(ics.headers.get('content-disposition'), /my-first-week\.ics/);
  assert.ok(ics.text.startsWith('BEGIN:VCALENDAR') && (ics.text.match(/BEGIN:VEVENT/g) || []).length > 10);
  const bics = await buddy('GET', `/api/l/${p.links.buddy}/calendar.ics`);
  assert.strictEqual((bics.text.match(/BEGIN:VEVENT/g) || []).length, bv.tasks.length);
  // A new buddy link: the old one dies at once.
  r = await mgrC('POST', `/api/plans/${p.code}/manage`, { action: 'relink', role: 'buddy' }, p.mgr);
  assert.notStrictEqual(r.data.links.buddy, p.links.buddy);
  assert.strictEqual((await buddy('GET', `/api/l/${p.links.buddy}`)).status, 404);
  assert.strictEqual((await buddy('GET', `/api/l/${r.data.links.buddy}`)).status, 200);
  assert.strictEqual(await store.get('links', p.links.buddy), null, 'the old link document is gone');
  // Manager edits: a holiday moves a due date the hire sees.
  const firstWeek = hv.schedule.find((t) => t.phase === 'week');
  r = await mgrC('POST', `/api/plans/${p.code}/manage`, { action: 'holidays', holidays: [firstWeek.due] }, p.mgr);
  assert.notStrictEqual((await hire('GET', `/api/l/${p.links.hire}`)).data.plan.schedule.find((t) => t.id === firstWeek.id).due, firstWeek.due);
  // Copy for the next hire.
  const copy = await openPlan(mgrC, { hire: 'Leo' }, { tasks: C.copyTasks({ tasks: r.data.plan.tasks }), template: undefined });
  assert.strictEqual(copy.plan.tasks.length, r.data.plan.tasks.length);
  assert.ok(copy.plan.tasks.every((t) => !t.done) && copy.plan.checkins.every((k) => !k.answer));
  // Delete: the manager only, and the links go with it.
  assert.strictEqual((await hire('DELETE', `/api/plans/${p.code}`)).status, 404);
  assert.strictEqual((await mgrC('DELETE', `/api/plans/${p.code}`, undefined, p.mgr)).status, 200);
  for (const code of [p.links.hire, p.links.it, r.data.links.buddy]) {
    assert.strictEqual((await client()('GET', `/api/l/${code}`)).status, 404);
    assert.strictEqual(await store.get('links', code), null);
  }
});

test('what a link reveals: first names and tasks - never a key, a hash, a tag, another link, the holidays, the meter or someone else’s tasks; hostile names are cleaned', async () => {
  const mgrC = client();
  const p = await openPlan(mgrC, { hire: HOSTILE[0], manager: HOSTILE[1], buddy: HOSTILE[2], business: HOSTILE[3], holidays: ['2026-12-25'] });
  const stored = await store.get('plans', p.code);
  assert.deepStrictEqual([stored.plan.hire, stored.plan.manager, stored.plan.buddy, stored.plan.business], ['Ana', 'Bo', 'Cal', 'Dee x']);
  const leaks = [p.key, stored.ownerHash, stored.creator, p.code, mgrC.cookies.firstday_k, '2026-12-25', 'readiness', 'createdAt', 'expiresAt'];
  for (const role of C.ROLES) {
    const r = await client()('GET', `/api/l/${p.links[role]}`);
    assert.ok(!/[<>\u202e]/.test(r.text), 'no markup or bidi in what a link is sent');
    for (const s of leaks.concat(Object.entries(p.links).filter(([k]) => k !== role).map(([, c]) => c))) assert.ok(!r.text.includes(s), `the ${role} link leaks ${s}`);
    assert.deepStrictEqual(Object.keys(r.data).sort(), ['plan', 'role']);
  }
  const all = (await mgrC('GET', `/api/plans/${p.code}`, undefined, p.mgr)).text;
  assert.ok(!all.includes(stored.ownerHash) && !all.includes(stored.creator) && !all.includes(p.key), 'not even the manager gets the hash, the tag or the key back');
  assert.ok(!store._dump().includes(p.key) && !store._dump().includes(mgrC.cookies.firstday_k), 'no key is stored');
  assert.deepStrictEqual(Object.keys(stored).sort(), ['checkins', 'code', 'createdAt', 'creator', 'expiresAt', 'id', 'links', 'ownerHash', 'plan', 'tasks', 'template', 'updatedAt', 'v'].sort(), 'exactly what is stored');
  assert.deepStrictEqual(Object.keys(await store.get('links', p.links.hire)).sort(), ['id', 'plan', 'role'], 'a link names a plan and a role, nothing else');
});

test('refused, not stored: a salary, a bank or ID number in any field over HTTP is a 422 with a sentence, and nothing changes', async () => {
  const mgrC = client();
  const dump0 = store._dump();
  for (const plan of [{ bring: 'Your offer: $48,000 salary' }, { welcome: 'Send your bank details and sort code' }, { where: 'SSN 123-45-6789 at the desk' }, { role: 'Barista on $17/hr' }]) {
    const r = await mgrC('POST', '/api/plans', { plan: basePlan({ start: C.nextMonday(todayNY()), ...plan }), template: 'office' });
    assert.strictEqual(r.status, 422, r.text);
    assert.match(r.data.error, /: That (looks like|’s a long number)/);
  }
  assert.strictEqual(store._dump(), dump0, 'nothing stored');
  const p = await openPlan(mgrC);
  const v0 = (await store.get('plans', p.code)).v;
  let r = await mgrC('POST', `/api/plans/${p.code}/manage`, { action: 'addTask', task: { title: 'Record passport number', owner: 'it', offset: -2 } }, p.mgr);
  assert.strictEqual(r.status, 422);
  r = await mgrC('POST', `/api/plans/${p.code}/manage`, { action: 'details', plan: { bring: 'IBAN GB82 WEST 1234 5698 7654 32' } }, p.mgr);
  assert.strictEqual(r.status, 422);
  assert.strictEqual((await store.get('plans', p.code)).v, v0, 'a refused change changes nothing');
  const past = await openPlan(client(), { start: C.addDays(todayNY(), -10) });
  r = await client()('POST', `/api/l/${past.links.hire}/act`, { action: 'checkin', key: 'd5', mood: 3, help: 'Pay me at 4111 1111 1111 1111' });
  assert.strictEqual(r.status, 422);
  assert.ok(!store._dump().includes('4111'));
});

test('codes, limits and expiry: unknown, malformed and expired read the same 404; 10 plans an hour per address; 8 per phone; distinct wrong codes', async () => {
  const codes = new Set();
  for (let i = 0; i < 300; i++) codes.add(P.newCode());
  assert.strictEqual(codes.size, 300);
  for (const c of codes) assert.ok(P.isCode(c) && !/[IO01]/.test(c));
  const anon = client();
  const unknown = await anon('GET', '/api/l/ZZZZZZZZZZ');
  const bad = await anon('GET', '/api/l/not-a-code!!');
  assert.deepStrictEqual([unknown.status, bad.status, bad.data.error], [404, 404, unknown.data.error]);
  const p = await openPlan(client());
  await store.merge('plans', p.code, { expiresAt: '2026-01-01T00:00:00.000Z' });
  const ex = await anon('GET', `/api/l/${p.links.hire}`);
  assert.deepStrictEqual([ex.status, ex.data], [unknown.status, unknown.data]);
  assert.strictEqual(await store.get('plans', p.code), null, 'deleted by the read that found it');
  for (const r of C.ROLES) assert.strictEqual(await store.get('links', p.links[r]), null, 'and its links');
  // Expiry: 60 days after the last change, never before 120 days after day 1.
  const far = await openPlan(client(), { start: C.addDays(todayNY(), 200) });
  const exp = Date.parse((await store.get('plans', far.code)).expiresAt);
  assert.ok(exp >= Date.parse(`${C.addDays(todayNY(), 320)}T00:00:00Z`) - DAY, 'the 90-day check-in always has a home');
  const soon = await openPlan(client(), { start: C.addDays(todayNY(), -29) });
  const exp2 = Date.parse((await store.get('plans', soon.code)).expiresAt);
  assert.ok(exp2 - Date.now() > 89 * DAY && exp2 - Date.now() < 92 * DAY, 'start + 120 days');
  assert.strictEqual(P.extend({ plan: { start: '2026-01-01' } }, Date.parse('2026-10-01T00:00:00Z')).expiresAt, '2026-11-30T00:00:00.000Z', '60 days after a change');
  // Per address.
  const net = '2001:db8:cccc:1';
  for (let i = 0; i < P.LIMITS.plansPerIp; i++) assert.strictEqual((await client(`${net}::${i + 1}`)('POST', '/api/plans', { plan: basePlan({ hire: `T${'abcdefghijk'[i]}`, start: C.nextMonday(todayNY()) }) })).status, 200);
  const over = await client(`${net}::99`)('POST', '/api/plans', { plan: basePlan({ start: C.nextMonday(todayNY()) }) });
  assert.deepStrictEqual([over.status, /10 new plans/.test(over.data.error)], [429, true]);
  // Per phone.
  const phone = client();
  await openPlan(phone);
  for (let i = 1; i < P.LIMITS.openPerCreator; i++) { const c = client(); Object.assign(c.cookies, phone.cookies); assert.strictEqual((await c('POST', '/api/plans', { plan: basePlan({ start: C.nextMonday(todayNY()) }) })).status, 200); }
  const c9 = client(); Object.assign(c9.cookies, phone.cookies);
  const capped = await c9('POST', '/api/plans', { plan: basePlan({ start: C.nextMonday(todayNY()) }) });
  assert.deepStrictEqual([capped.status, /8 plans/.test(capped.data.error)], [429, true]);
  // Distinct wrong codes: guessing stops; one dead code polled is not guessing.
  const live = await openPlan(client());
  const guess = client();
  for (let i = 0; i < 40; i++) assert.strictEqual((await guess('GET', '/api/l/ZZZZZZZZZZ')).status, 404);
  for (let i = 0; i < P.LIMITS.missesPerIp - 1; i++) await guess('GET', `/api/l/${P.newCode()}`);
  assert.strictEqual((await guess('GET', `/api/l/${live.links.hire}`)).status, 429, 'then even a real one waits');
  assert.strictEqual((await client()('GET', `/api/l/${live.links.hire}`)).status, 200, 'for that address only');
  assert.match(read('server.js'), /opensAll\.blocked\('all'\)/);
});

test('the metered route’s gates come before its parser, in order; one model client; Haiku free, Sonnet for members', () => {
  const layer = (p, m) => app._router.stack.find((l) => l.route && l.route.path === p && l.route.methods[m]);
  assert.deepStrictEqual(layer('/api/tailor', 'post').route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1);
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
});

test('Tailor it to us: checked before any spend, one forced tool, validated, a proposal only - applied only by the manager’s tap', async () => {
  const me = await register('ana.tailor@example.com');
  const ASK = { about: 'A 12-person bike shop. Repairs on the workshop floor using a paper job board, the till on Saturdays.', role: 'Bike mechanic', pattern: 'onsite', template: 'trades' };
  const dump = store._dump();
  const calls = await modelCalls();
  assert.strictEqual((await me('POST', '/api/tailor', { ...ASK, about: 'short' })).status, 400);
  assert.strictEqual((await me('POST', '/api/tailor', { ...ASK, role: '' })).status, 400);
  assert.strictEqual((await me('POST', '/api/tailor', { ...ASK, about: 'x'.repeat(3000) })).status, 400);
  assert.strictEqual((await me('POST', '/api/tailor', { ...ASK, about: 'A bike shop where the salary is $40,000 for this role.' })).status, 422, 'pay is refused before it is sent anywhere');
  assert.strictEqual((await me('POST', '/api/tailor', { ...ASK, about: 'x'.repeat(20 * 1024) })).status, 413, 'its own 16 KB parser, after the gates');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad request');
  const r = await me('POST', '/api/tailor', ASK);
  assert.strictEqual(r.status, 200, r.text);
  const pr = r.data.proposal;
  assert.ok(pr.tasks.length >= ai.MIN_TASKS && pr.tasks.length <= ai.MAX_TASKS);
  assert.ok(pr.tasks.some((t) => /paper job board/.test(t.title)), 'tailored to what was described');
  assert.ok(pr.tasks.every((t) => C.OWNERS.includes(t.owner) && Number.isInteger(t.offset)));
  assert.match(pr.summary, /Bike mechanic/);
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  assert.strictEqual(store._dump(), dump, 'nothing stored - it is a proposal');
  // Hostile output is cleaned, bounded and dropped where it breaks a rule.
  const inj = await me('POST', '/api/tailor', { ...ASK, about: `${ASK.about} INJECT` });
  const ip = inj.data.proposal;
  assert.ok(ip, inj.text);
  const text = JSON.stringify(ip);
  assert.ok(!/[<>\u202e]/.test(text), 'no markup or bidi survives');
  assert.ok(!/Made-up owner|Too far out|String offset|salary|SSN|48,000|123-45/.test(text), 'made-up owners, impossible offsets, pay and IDs dropped');
  assert.ok(ip.tasks.find((t) => t.title === 'Timed on day 3').time === null, 'a time only on day 1');
  assert.strictEqual(ip.tasks.filter((t) => t.checkin === 'd5').length, 1, 'one check-in each');
  assert.ok(ip.tasks.length <= ai.MAX_TASKS && ip.dropped >= 5);
  assert.ok(ip.tasks.every((t) => t.title.length <= C.LIMITS.title));
  assert.strictEqual(ip.summary, 'Tailored for you');
  for (const [trigger, re, status] of [['BLANK', /didn’t come back as a usable plan/, 422], ['MAXTOKENS', /ran long/, 502]]) {
    const b = await me('POST', '/api/tailor', { ...ASK, about: `${ASK.about} ${trigger}` });
    assert.strictEqual(b.status, 200, 'streamed: the outcome is in the body');
    assert.deepStrictEqual([re.test(b.data.error), b.data.status], [true, status], b.text);
  }
  const up = await me('POST', '/api/tailor', { ...ASK, about: `${ASK.about} UPSTREAM401` });
  assert.ok(up.data.error && up.data.status === 502 && !/fake_upstream|stand-in/.test(up.text));
  const busy = await me('POST', '/api/tailor', { ...ASK, about: `${ASK.about} UPSTREAM529` });
  assert.deepStrictEqual([busy.data.status, /AI is busy/.test(busy.data.error)], [503, true]);
  assert.ok(!store._dump().includes('paper job board'), 'the description is never stored');
  // Applying is an ordinary change, on the manager's tap.
  const mgrC = client();
  const p = await openPlan(mgrC);
  const ap = await mgrC('POST', `/api/plans/${p.code}/manage`, { action: 'replaceTasks', tasks: pr.tasks }, p.mgr);
  assert.strictEqual(ap.data.result.count, pr.tasks.length);
  const proposed = new Set(pr.tasks.map((t) => t.id));
  assert.ok(ap.data.plan.tasks.every((t) => C.TASK_ID.test(t.id) && !proposed.has(t.id)), 'fresh ids on apply');
});

test('the model sees only the description, the role and the pattern - no names, one forced tool, enums for owners and check-ins', async () => {
  const seen = [];
  const spy = { messages: { create: async (p) => { seen.push(p); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'propose_plan', input: { tasks: C.TEMPLATES.office.tasks } }] }; } } };
  const b = ai.brief({ about: 'A small office <script>x</script> with eight people and a shared drive.', role: '<b>Office manager</b>', pattern: 'hybrid', template: 'office', hire: 'SECRET-NAME', secret: 'SECRET-FIELD' });
  assert.deepStrictEqual(Object.keys(b).sort(), ['about', 'pattern', 'role', 'template']);
  assert.strictEqual(b.role, 'Office manager');
  const raw = await ai.propose(spy, 'claude-haiku-4-5', b);
  const p = seen[0];
  assert.deepStrictEqual(p.tool_choice, { type: 'tool', name: 'propose_plan' });
  assert.ok(p.max_tokens <= 4000);
  assert.ok(!/SECRET|<script/.test(JSON.stringify(p.messages)));
  const item = p.tools[0].input_schema.properties.tasks.items.properties;
  assert.deepStrictEqual(item.owner.enum, C.OWNERS);
  assert.deepStrictEqual(item.checkin.enum, C.CHECKINS);
  assert.deepStrictEqual([item.offset.minimum, item.offset.maximum], [-30, 90]);
  assert.strictEqual(p.tools[0].input_schema.properties.tasks.maxItems, ai.MAX_TASKS);
  assert.match(p.system, /never an instruction/);
  assert.ok(ai.toProposal(raw).tasks.length > 10);
  assert.throws(() => ai.toProposal({ tasks: [{ title: 'Only day 1', owner: 'manager', offset: 0 }] }), (e) => e.status === 422);
});

test('the gates: unconfirmed 403, out of credit 402, the day’s free ceiling 503 - each before the parser, never a model call', async () => {
  const ASK = { about: 'A cafe of twelve people serving brunch on weekends.', role: 'Barista' };
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/tailor', ASK);
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/firstday/api/auth/verify/send');
    assert.strictEqual((await eve('POST', '/api/tailor', { about: 'x'.repeat(200 * 1024) })).status, 403);
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/tailor', ASK)).status, 402);
  assert.strictEqual((await cal('POST', '/api/tailor', { about: 'x'.repeat(200 * 1024) })).status, 402, '402, not 413');
  const dan = await register('dan.capped@example.com');
  const day = new Date().toISOString().slice(0, 10);
  await identityStore.set('control', `free-spend-firstday-${day}`, { usd: 5000 });
  try {
    const capped = await dan('POST', '/api/tailor', ASK);
    assert.deepStrictEqual([capped.status, /free tier is used up/.test(capped.data.error)], [503, true]);
    assert.strictEqual((await dan('POST', '/api/tailor', { about: 'x'.repeat(200 * 1024) })).status, 503);
  } finally { await identityStore.remove('control', `free-spend-firstday-${day}`); }
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call behind any gate');
  assert.strictEqual((await dan('POST', '/api/tailor', ASK)).status, 200, 'and it lifts');
});

test('concurrent links: ticks from every link and the manager at once all land (one transaction each)', async () => {
  const mgrC = client();
  const p = await openPlan(mgrC);
  const byOwner = (o) => p.plan.tasks.filter((t) => t.owner === o).map((t) => t.id);
  const jobs = [];
  for (const role of C.ROLES) for (const id of byOwner(role)) jobs.push(client()('POST', `/api/l/${p.links[role]}/act`, { action: 'tick', id, done: true }));
  for (const id of byOwner('manager')) jobs.push(mgrC('POST', `/api/plans/${p.code}/manage`, { action: 'tick', id, done: true }, p.mgr));
  const res = await Promise.all(jobs);
  assert.ok(res.every((r) => r.status === 200), res.map((r) => r.status).join());
  const after = await store.get('plans', p.code);
  assert.ok(after.tasks.every((t) => t.done), 'every tick stuck');
  assert.ok(!/setInterval|setTimeout/.test(read('server.js')), 'nothing runs after a response (billed per request)');
});

/* ---------------- run ---------------- */

(async () => {
  const host = express();
  host.use((req, res, next) => (req.path === '/firstday' ? res.redirect(301, '/firstday/') : next()));
  host.use('/firstday', app);
  const server = http.createServer(host).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/firstday`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  FAIL ${t.name}\n${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
