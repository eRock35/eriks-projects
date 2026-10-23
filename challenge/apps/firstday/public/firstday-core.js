/* Firstday - the rules. One file, run three times: in the page
 * (window.FirstdayCore), in the server (require) and in the tests. It holds:
 *
 *   - cleaning: every typed string goes through one door (markup, control
 *     and direction characters stripped, bounded); a person is a first name
 *     and at most an initial; and a field shaped like a government ID, a
 *     bank or card number, a phone number, an email address or a salary is
 *     REFUSED with a sentence, never quietly kept;
 *   - dates: due dates counted in business days from the start date,
 *     skipping weekends (unless the business works them) and the plan's own
 *     holidays; 30/60/90-day check-ins counted in calendar days and rolled
 *     to the next working day;
 *   - the five built-in templates, every task with an owner role and a due
 *     offset;
 *   - every change (`manage` for the manager, `linkAct` for a role link),
 *     readiness, overdue, the day-1 countdown, check-ins, the views each
 *     link gets, the .ics, and the sample cafe hire.
 *
 * No clock and no dice: anything that needs "now" or a fresh id is handed
 * it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FirstdayCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    name: 24,          // a first name and an initial
    role: 60,
    business: 60,
    title: 90,         // a task
    miss: 40,          // "laptop not ordered"
    place: 140,        // where to go
    bring: 200,
    welcome: 600,
    answer: 500,       // a check-in answer
    tasks: 80,
    holidays: 30,
    offsetMin: -30,    // business days before day 1
    offsetMax: 90,     // days after
    startPast: 30,     // a plan may start up to 30 days ago...
    startAhead: 240,   // ...or 240 days ahead
    about: 1200,       // "Tailor it to us"
  };
  const OWNERS = ['manager', 'buddy', 'it', 'hire'];
  const OWNER_LABEL = { manager: 'Manager', buddy: 'Buddy', it: 'IT/admin', hire: 'New hire' };
  const ROLES = ['hire', 'buddy', 'it'];  // the three role links
  const PATTERNS = ['onsite', 'remote', 'hybrid'];
  const PATTERN_LABEL = { onsite: 'On-site', remote: 'Remote', hybrid: 'Hybrid' };
  const CHECKINS = ['d5', 'd30', 'd60', 'd90'];
  const CHECKIN_LABEL = { d5: 'Day 5', d30: 'Day 30', d60: 'Day 60', d90: 'Day 90' };
  const MOODS = { 1: 'Rough', 2: 'Unsure', 3: 'OK', 4: 'Good', 5: 'Great' };
  const MOOD_ICON = { 1: '😣', 2: '😕', 3: '🙂', 4: '😊', 5: '🤩' };
  const SECTIONS = [['before', 'Before day 1'], ['day1', 'Day 1'], ['week', 'Days 2–5'], ['later', '30, 60 and 90 days']];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const HOUR = 3600000;
  const DAY = 86400000;

  function err(status, message, extra) { return Object.assign(new Error(message), { status, expose: true }, extra || {}); }

  /* ------------------------------------------------------------------ *
   * Cleaning
   * ------------------------------------------------------------------ */

  // Control characters, zero-width and bidi overrides/isolates, BOM.
  const CTRL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
  /** Any typed string: tags and stray angle brackets out, control and bidi
   *  characters out, whitespace collapsed, cut to `max` characters. */
  function clean(v, max) {
    if (typeof v !== 'string') return '';
    const m = Math.max(1, max || 200);
    let s = v.slice(0, m * 4 + 64);
    s = s.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').replace(CTRL, '').replace(/\s+/g, ' ').trim();
    return Array.from(s).slice(0, m).join('').trim();
  }
  /** Like clean, but keeps line breaks (a welcome message reads better in
   *  paragraphs): at most three in a row. */
  function cleanLines(v, max) {
    if (typeof v !== 'string') return '';
    const lines = v.slice(0, max * 4 + 64).split(/\r\n|\r|\n/).map((l) => clean(l, max));
    return Array.from(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()).slice(0, max).join('').trim();
  }
  /** A first name, and at most an initial: "Mia Rodriguez" -> "Mia R.". The
   *  links show first names only, so the rule lives here, not in copy. */
  function firstName(v) {
    const s = clean(v, 80).replace(/[^\p{L}\p{M}'’ .-]/gu, ' ').replace(/\s+/g, ' ').trim();
    const words = s.split(' ').map((w) => w.replace(/^[.'’-]+|[.'’-]+$/g, '')).filter(Boolean);
    if (!words.length) return '';
    const first = Array.from(words[0]).slice(0, 20).join('');
    const initial = words[1] ? `${Array.from(words[1])[0].toUpperCase()}.` : '';
    return Array.from(initial ? `${first} ${initial}` : first).slice(0, LIMITS.name).join('');
  }
  function fold(v) {
    return String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /* ---- what Firstday refuses to hold ---- */

  const NOT_HERE = 'Firstday holds first names and tasks only - keep it in your payroll or HR system.';
  const REFUSE = [
    // Government IDs: US SSN, UK National Insurance, and the words for them.
    ['id', /\b\d{3}[- ]\d{2}[- ]\d{4}\b/],
    ['id', /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/i],
    ['id', /\b(ssn|social security|national insurance|ni number|passport (no|number|#)|driv(er'?s|ing) licen[cs]e (no|number|#)|tax (id|file number|code)|\btfn\b|sin number|date of birth|d\.o\.b\.?)\b/i],
    // Bank and card details.
    ['bank', /\b[A-Z]{2}\d{2} ?(?:[A-Z0-9]{4} ?){2,7}[A-Z0-9]{1,4}\b/],
    ['bank', /\b(routing (no|number|#)|sort code|account (no|number|#)|acct (no|#)|iban|swift code|bic code|bank details|card number|cvv)\b/i],
    // Pay: the words, a salary-sized amount, an hourly rate.
    ['salary', /\b(salary|salaries|wages?|pay rate|hourly rate|rate of pay|compensation|per annum|p\.a\.|annual pay|base pay)\b/i],
    ['salary', /[$£€]\s?(?:\d{2,3}(?:,\d{3})+|\d(?:,\d{3}){2,}|\d{5,}|\d+(?:\.\d+)?\s?k\b)/i],
    ['salary', /(?:[$£€]\s?)?\b\d{1,3}(?:\.\d{1,2})?\s?(?:\/\s?h(?:ou)?r\b|per hour\b|an hour\b|p\/h\b)/i],
    // Anything else long and numeric: an account, an ID, a phone number.
    ['number', /(?:\d[\s.-]?){8,}\d/],
    ['email', /[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/i],
    ['address', /\b(home address|lives at|their address)\b/i],
  ];
  const REFUSE_TEXT = {
    id: `That looks like an ID number. ${NOT_HERE}`,
    bank: `That looks like bank or card details. ${NOT_HERE}`,
    salary: 'That looks like pay or salary. Firstday holds first names and tasks only - keep pay in the offer letter and payroll, not in a link people share.',
    number: 'That’s a long number - a bank, ID or phone number? Leave numbers like that out; Firstday holds first names and tasks only.',
    email: 'Leave email addresses out - each person gets their own link instead.',
    address: 'Leave home addresses out - Firstday holds first names and tasks only.',
  };
  /** {code, text} when a string is shaped like something Firstday must not
   *  hold; null when it is fine. */
  function sensitive(v) {
    const s = String(v == null ? '' : v);
    if (!s) return null;
    for (const [code, re] of REFUSE) if (re.test(s)) return { code, text: REFUSE_TEXT[code] };
    return null;
  }
  /** Throw the refusal as a 422, naming the field. */
  function guard(label, v) {
    const hit = sensitive(v);
    if (hit) throw err(422, `${label}: ${hit.text}`, { code: `sensitive-${hit.code}` });
    return v;
  }

  /* ------------------------------------------------------------------ *
   * Dates: business days from the start date
   * ------------------------------------------------------------------ */

  const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function cleanTime(v) {
    const m = TIME_RE.exec(String(v == null ? '' : v).trim());
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  }
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  function fmtTime(t) {
    let m = typeof t === 'number' ? t : toMin(t);
    m = ((m % 1440) + 1440) % 1440;
    if (m === 0) return 'midnight';
    if (m === 720) return 'noon';
    const h = Math.floor(m / 60); const mm = m % 60;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
  }
  function cleanDate(v) {
    const m = DATE_RE.exec(String(v || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : null;
  }
  // Dates are civil days; sums run at UTC midnight, where no clock changes.
  const dayMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  function addDays(s, n) { return isoOf(dayMs(s) + n * DAY); }
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / DAY); }
  /** 0 = Monday ... 6 = Sunday. */
  function weekday(s) { return (new Date(dayMs(s)).getUTCDay() + 6) % 7; }
  /** "Mon 26 Oct". */
  function dayLabel(s) { const d = new Date(dayMs(s)); return `${DAYS[weekday(s)]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; }
  function longDay(s) { const d = new Date(dayMs(s)); return `${DAY_LONG[weekday(s)]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; }

  /** A working day: Monday to Friday (or every day, for a business that
   *  works weekends), and not one of the plan's holidays. */
  function isWorkday(d, cal) {
    const c = cal || {};
    if (!c.workWeekends && weekday(d) >= 5) return false;
    return !(c.holidays || []).includes(d);
  }
  /** `n` working days after (or before, when negative) `start`. Day 0 is the
   *  start itself, whatever day it is - a shop can start someone on a
   *  Saturday. */
  function shiftWorkdays(start, n, cal) {
    let d = start;
    let left = Math.abs(n);
    const step = n > 0 ? 1 : -1;
    for (let guard = 0; left > 0 && guard < 1000; guard++) {
      d = addDays(d, step);
      if (isWorkday(d, cal)) left--;
    }
    return d;
  }
  function nextWorkday(d, cal) {
    let x = d;
    for (let guard = 0; !isWorkday(x, cal) && guard < 400; guard++) x = addDays(x, 1);
    return x;
  }
  /** When a task is due. `bd` offsets count working days; `cd` offsets (the
   *  30/60/90-day check-ins) count calendar days, then roll forward to the
   *  next working day. */
  function dueOf(plan, t) {
    if (t.unit === 'cd') return nextWorkday(addDays(plan.start, t.offset), plan);
    return shiftWorkdays(plan.start, t.offset, plan);
  }
  /** The working-day offset that lands on `date` (a picked date that is not
   *  a working day counts as the next one after day 1, the one before it
   *  otherwise). The inverse of shiftWorkdays. */
  function offsetFor(plan, date) {
    if (date === plan.start) return 0;
    let n = 0;
    if (date > plan.start) {
      for (let d = addDays(plan.start, 1), g = 0; d <= date && g < 1000; d = addDays(d, 1), g++) if (isWorkday(d, plan)) n++;
      if (!isWorkday(date, plan)) n++;
      return Math.min(n, LIMITS.offsetMax);
    }
    for (let d = addDays(plan.start, -1), g = 0; d >= date && g < 1000; d = addDays(d, -1), g++) if (isWorkday(d, plan)) n--;
    return Math.max(n, LIMITS.offsetMin);
  }
  /** Which day of the job a date is: 1 on the start, counted in working
   *  days. 0 or less before it. */
  function jobDay(plan, date) {
    if (date < plan.start) return 0;
    let n = 1;
    for (let d = addDays(plan.start, 1), g = 0; d <= date && g < 1000; d = addDays(d, 1), g++) if (isWorkday(d, plan)) n++;
    return n;
  }

  /* ---- civil time in the business's zone ---- */

  const zoneCache = {};
  function zoneOk(z) {
    if (typeof z !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(z) || z.length > 40) return false;
    if (zoneCache[z] !== undefined) return Boolean(zoneCache[z]);
    try { zoneCache[z] = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch (e) { zoneCache[z] = false; }
    return Boolean(zoneCache[z]);
  }
  function cleanZone(z) { return zoneOk(z) ? z : 'UTC'; }
  function offsetMin(zone, ms) {
    if (!zoneOk(zone)) return 0;
    const parts = {};
    for (const p of zoneCache[zone].formatToParts(new Date(ms))) parts[p.type] = p.value;
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
  }
  /** The instant a wall clock in `zone` reads `date` at `min` minutes after
   *  midnight. A skipped time lands just after the gap; a repeated one
   *  takes the first. */
  function wallToUtc(date, min, zone) {
    const guess = dayMs(date) + min * 60000;
    let t = guess - offsetMin(zone, guess) * 60000;
    t = guess - offsetMin(zone, t) * 60000;
    const early = t - HOUR;
    if (early + offsetMin(zone, early) * 60000 === guess) return early;
    return t;
  }
  function todayIn(zone, ms) { return isoOf(ms + offsetMin(cleanZone(zone), ms) * 60000); }
  /** The Monday after `today` (a week ahead when today is Monday). */
  function nextMonday(today) { return addDays(today, 7 - weekday(today)); }

  /* ------------------------------------------------------------------ *
   * Ids: from a seed, so the core needs no dice
   * ------------------------------------------------------------------ */

  const ID_ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
  function idFrom(prefix, seed, n) {
    let h = 2166136261;
    let out = '';
    const s = String(seed);
    for (let k = 0; out.length < (n || 9); k++) {
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) + k; h = Math.imul(h, 16777619) >>> 0; }
      out += ID_ALPHA[h % ID_ALPHA.length];
    }
    return prefix + out;
  }
  const TASK_ID = /^t[a-z0-9]{6,12}$/;

  /* ------------------------------------------------------------------ *
   * Tasks
   * ------------------------------------------------------------------ */

  function intIn(v, lo, hi) { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; }
  /** Where a task sits on the page, from when it is due. */
  function phaseOf(t) {
    if (t.unit === 'cd') return 'later';
    if (t.offset < 0) return 'before';
    if (t.offset === 0) return 'day1';
    if (t.offset <= 4) return 'week';
    return 'later';
  }
  /** One task, checked. `prev` keeps what a partial edit leaves out. Throws
   *  a 400 for a task with no title or an impossible date, a 422 for one
   *  shaped like something Firstday must not hold. */
  function cleanTask(x, id, prev) {
    const b = x && typeof x === 'object' ? x : {};
    const p = prev || {};
    const title = b.title !== undefined ? clean(b.title, LIMITS.title) : p.title;
    if (!title) throw err(400, 'Give the task a name - “Order the laptop”, “Lunch with your buddy”.');
    guard('The task', title);
    const owner = OWNERS.includes(b.owner) ? b.owner : (OWNERS.includes(p.owner) ? p.owner : 'manager');
    const offset = b.offset !== undefined ? intIn(b.offset, LIMITS.offsetMin, LIMITS.offsetMax) : p.offset;
    if (offset === null || offset === undefined) throw err(400, `A task is due between ${-LIMITS.offsetMin} working days before day 1 and ${LIMITS.offsetMax} days after.`);
    let unit = b.unit !== undefined ? b.unit : p.unit;
    unit = unit === 'cd' && offset >= 5 ? 'cd' : 'bd';
    let time = b.time !== undefined ? cleanTime(b.time) : (p.time || null);
    if (!(offset === 0 && unit === 'bd')) time = null; // the hour-by-hour is day 1's
    const miss = clean(b.miss !== undefined ? b.miss : (p.miss || ''), LIMITS.miss) || null;
    if (miss) guard('The task', miss);
    const ck = b.checkin !== undefined ? b.checkin : p.checkin;
    const checkin = CHECKINS.includes(ck) ? ck : null;
    return {
      id, title, owner, offset, unit, time, miss, checkin,
      done: p.done === true, doneAt: p.doneAt || null, doneBy: p.doneBy || null,
    };
  }
  /** A list of tasks from outside (a template, a copy, a proposal): bad
   *  ones dropped rather than refusing the lot, ids fresh, nothing done, a
   *  check-in key used once. */
  function cleanTaskList(list, ids) {
    const out = [];
    const seen = new Set();
    for (const x of Array.isArray(list) ? list.slice(0, LIMITS.tasks * 2) : []) {
      if (out.length >= LIMITS.tasks) break;
      try {
        const t = cleanTask(x, ids('t'));
        if (t.checkin && seen.has(t.checkin)) t.checkin = null;
        if (t.checkin) seen.add(t.checkin);
        out.push(t);
      } catch (e) { if (!e.expose) throw e; }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The plan
   * ------------------------------------------------------------------ */

  /** The plan's own fields, checked: `prev` keeps what a partial edit
   *  leaves out; `today` (the business's) bounds the start date. */
  function cleanPlan(b, prev, today) {
    const x = b && typeof b === 'object' ? b : {};
    const p = prev || {};
    const pick = (k, fn) => (x[k] !== undefined ? fn(x[k]) : p[k]);
    const plan = {
      hire: pick('hire', firstName),
      role: pick('role', (v) => clean(v, LIMITS.role)),
      business: pick('business', (v) => clean(v, LIMITS.business)),
      manager: pick('manager', firstName),
      buddy: pick('buddy', firstName),
      start: pick('start', cleanDate),
      pattern: pick('pattern', (v) => (PATTERNS.includes(v) ? v : 'onsite')),
      zone: pick('zone', cleanZone),
      workWeekends: pick('workWeekends', (v) => v === true),
      holidays: pick('holidays', cleanHolidays),
      arrive: pick('arrive', (v) => cleanTime(v) || '09:00'),
      where: pick('where', (v) => clean(v, LIMITS.place)),
      ask: pick('ask', firstName),
      bring: pick('bring', (v) => clean(v, LIMITS.bring)),
      welcome: pick('welcome', (v) => cleanLines(v, LIMITS.welcome)),
    };
    if (!plan.hire) throw err(400, 'Add the new hire’s first name.');
    if (!plan.role) throw err(400, 'Add the role - “Barista”, “Office manager”, “Apprentice electrician”.');
    if (!plan.start) throw err(400, 'Pick their start date.');
    if (!plan.manager) throw err(400, 'Add the manager’s first name - the person they report to.');
    if (today && plan.start !== p.start && (plan.start < addDays(today, -LIMITS.startPast) || plan.start > addDays(today, LIMITS.startAhead))) {
      throw err(400, 'Pick a start date from the last month up to eight months ahead.');
    }
    for (const [label, k] of [['The role', 'role'], ['The business', 'business'], ['Where to go', 'where'], ['What to bring', 'bring'], ['The welcome message', 'welcome']]) guard(label, plan[k] || '');
    plan.buddy = plan.buddy || '';
    plan.business = plan.business || '';
    plan.where = plan.where || '';
    plan.bring = plan.bring || '';
    plan.welcome = plan.welcome || '';
    plan.ask = plan.ask || plan.manager;
    plan.pattern = plan.pattern || 'onsite';
    plan.zone = plan.zone || 'UTC';
    plan.workWeekends = plan.workWeekends === true;
    plan.holidays = plan.holidays || [];
    plan.arrive = plan.arrive || '09:00';
    return plan;
  }
  function cleanHolidays(list) {
    const out = [];
    for (const d of Array.isArray(list) ? list.slice(0, 100) : []) {
      const c = cleanDate(d);
      if (c && !out.includes(c)) out.push(c);
    }
    return out.sort().slice(0, LIMITS.holidays);
  }

  function touch(doc, now) { doc.v = (doc.v || 0) + 1; doc.updatedAt = new Date(now).toISOString(); return doc; }

  /** A fresh plan. `tasks` (a copy, a proposal) or `template` lays out the
   *  tasks; with neither, the template that fits the pattern. */
  function newDoc(fields, opts, now, ids) {
    const o = opts || {};
    const plan = cleanPlan(fields, null, todayIn(cleanZone(fields && fields.zone), now));
    const mk = ids || seqIds(`${plan.hire}:${plan.start}:${now}`);
    const template = TEMPLATES[o.template] ? o.template : (plan.pattern === 'remote' ? 'remote' : 'office');
    const tasks = Array.isArray(o.tasks) ? cleanTaskList(o.tasks, mk) : fromTemplate(template, plan.pattern, mk);
    const at = new Date(now).toISOString();
    return { v: 1, plan, tasks, checkins: {}, template, createdAt: at, updatedAt: at };
  }
  function seqIds(seed) { let n = 0; return (p) => idFrom(p, `${seed}:${n++}`, 9); }

  /** "Copy this plan for the next hire": the same tasks, nothing done, no
   *  check-ins, the new person's name and date. */
  function copyTasks(doc) {
    return doc.tasks.map((t) => ({ title: t.title, owner: t.owner, offset: t.offset, unit: t.unit, time: t.time, miss: t.miss, checkin: t.checkin }));
  }

  /* ------------------------------------------------------------------ *
   * Changes
   * ------------------------------------------------------------------ */

  function taskOf(doc, id) { return doc.tasks.find((t) => t.id === id) || null; }
  /** Tasks in the order the page draws them: by due date, then day 1's
   *  clock, then where they sit in the list. */
  function ordered(doc) {
    return doc.tasks.map((t, i) => ({ t, i, due: dueOf(doc.plan, t) }))
      .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : (a.t.time || '') < (b.t.time || '') ? -1 : (a.t.time || '') > (b.t.time || '') ? 1 : a.i - b.i));
  }
  function tick(t, done, by, now) {
    t.done = done === true;
    t.doneAt = t.done ? new Date(now).toISOString() : null;
    t.doneBy = t.done ? by : null;
  }

  /** A manager's change, run in the page for the sample and in a
   *  transaction on the server for a real plan. Returns a small result. */
  function manage(doc, action, b, now, ids) {
    const mk = ids || seqIds(`${doc.v}:${doc.tasks.length}:${action}`);
    const today = todayIn(doc.plan.zone, now);
    let result = {};
    switch (action) {
      case 'details': {
        const plan = cleanPlan(b.plan, doc.plan, today);
        doc.plan = plan;
        break;
      }
      case 'holidays': doc.plan.holidays = cleanHolidays(b.holidays); break;
      case 'addTask': {
        if (doc.tasks.length >= LIMITS.tasks) throw err(409, `A plan holds ${LIMITS.tasks} tasks. Remove one first.`);
        const t = cleanTask(b.task, mk('t'));
        if (t.checkin && doc.tasks.some((x) => x.checkin === t.checkin)) t.checkin = null;
        doc.tasks.push(t);
        result = { id: t.id };
        break;
      }
      case 'editTask': {
        const i = doc.tasks.findIndex((t) => t.id === b.id);
        if (i < 0) throw err(404, 'That task isn’t on the plan any more.');
        const next = cleanTask(b.task, doc.tasks[i].id, doc.tasks[i]);
        doc.tasks[i] = next;
        break;
      }
      case 'removeTask': {
        const i = doc.tasks.findIndex((t) => t.id === b.id);
        if (i < 0) throw err(404, 'That task isn’t on the plan any more.');
        doc.tasks.splice(i, 1);
        break;
      }
      case 'moveTask': {
        // Earlier or later by one place in the order the page shows: the
        // task takes its neighbour's day (and time) and sits beside it.
        const list = ordered(doc);
        const k = list.findIndex((x) => x.t.id === b.id);
        if (k < 0) throw err(404, 'That task isn’t on the plan any more.');
        const j = b.dir === 'up' ? k - 1 : k + 1;
        if (j < 0 || j >= list.length) { result = { moved: false }; break; }
        const me = list[k].t; const nb = list[j].t;
        me.offset = nb.offset; me.unit = nb.unit; me.time = nb.time;
        doc.tasks.splice(list[k].i, 1);
        const at = doc.tasks.indexOf(nb);
        doc.tasks.splice(b.dir === 'up' ? at : at + 1, 0, me);
        result = { moved: true };
        break;
      }
      case 'tick': {
        const t = taskOf(doc, b.id);
        if (!t) throw err(404, 'That task isn’t on the plan any more.');
        tick(t, b.done, 'manager', now);
        break;
      }
      case 'template': {
        if (!TEMPLATES[b.template]) throw err(400, 'Unknown template.');
        doc.tasks = fromTemplate(b.template, doc.plan.pattern, mk);
        doc.template = b.template;
        break;
      }
      case 'replaceTasks': {
        const tasks = cleanTaskList(b.tasks, mk);
        if (!tasks.length) throw err(400, 'That plan has no tasks to use.');
        doc.tasks = tasks;
        result = { count: tasks.length };
        break;
      }
      default: throw err(400, 'Unknown change.');
    }
    touch(doc, now);
    return result;
  }

  /** What a role link may change: tick its own tasks; the new hire also
   *  answers an open check-in. `opts.early` lets the sample preview a
   *  check-in before its day (the page only - the server never passes it). */
  function linkAct(doc, role, action, b, now, opts) {
    if (!ROLES.includes(role)) throw err(403, 'Not from this link.');
    const today = todayIn(doc.plan.zone, now);
    if (action === 'tick') {
      const t = taskOf(doc, b && b.id);
      if (!t) throw err(404, 'That task isn’t on the plan any more.');
      if (t.owner !== role) throw err(403, 'That one is someone else’s to tick.');
      tick(t, b.done, role, now);
    } else if (action === 'checkin') {
      if (role !== 'hire') throw err(403, 'Check-ins are the new hire’s to fill in.');
      const key = b && b.key;
      const st = checkinState(doc, key, today);
      if (!st) throw err(404, 'There’s no check-in like that on this plan.');
      if (st.state === 'upcoming' && !(opts && opts.early)) throw err(409, `This check-in opens on ${longDay(st.due)}.`);
      const mood = intIn(b.mood, 1, 5);
      if (!mood) throw err(400, 'Pick how it’s going first.');
      const unclear = cleanLines(typeof b.unclear === 'string' ? b.unclear : '', LIMITS.answer);
      const help = cleanLines(typeof b.help === 'string' ? b.help : '', LIMITS.answer);
      guard('What’s unclear', unclear);
      guard('What would help', help);
      doc.checkins = doc.checkins || {};
      doc.checkins[key] = { mood, unclear, help, at: new Date(now).toISOString() };
    } else throw err(400, 'Unknown change.');
    touch(doc, now);
    return {};
  }

  /* ------------------------------------------------------------------ *
   * Progress: readiness, overdue, the countdown, check-ins
   * ------------------------------------------------------------------ */

  function withDue(doc, t, today) {
    const due = dueOf(doc.plan, t);
    return { id: t.id, title: t.title, owner: t.owner, offset: t.offset, unit: t.unit, time: t.time, miss: t.miss, checkin: t.checkin, done: t.done, doneAt: t.doneAt, doneBy: t.doneBy, due, phase: phaseOf(t), overdue: !t.done && due < today };
  }
  function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || `${one}s`)}`; }

  /** The meter before day 1: the business's prep done, what is still missing (the
   *  earliest due first, in words a manager would say) and the days left.
   *  "7 of 9 done - laptop not ordered, 3 days to go". */
  function readiness(doc, now) {
    const today = todayIn(doc.plan.zone, now);
    // The business's prep: the new hire's own to-dos (sign the contract,
    // read the welcome) are theirs, not a measure of whether WE are ready.
    const before = ordered(doc).filter((x) => phaseOf(x.t) === 'before' && x.t.owner !== 'hire');
    const done = before.filter((x) => x.t.done).length;
    const missing = before.filter((x) => !x.t.done).map((x) => ({ id: x.t.id, text: x.t.miss || `“${x.t.title}” not done`, overdue: x.due < today, due: x.due }));
    const toGo = daysBetween(today, doc.plan.start);
    const when = toGo > 1 ? `${toGo} days to go` : toGo === 1 ? 'starts tomorrow' : toGo === 0 ? 'starts today' : 'already started';
    const miss = missing.slice(0, 2).map((m) => m.text);
    const more = missing.length > 2 ? ` and ${missing.length - 2} more` : '';
    const text = before.length
      ? `${done} of ${before.length} done${missing.length ? ` - ${miss.join(', ')}${more}` : ' - all set'}, ${when}`
      : `No prep tasks yet, ${when}`;
    const pct = before.length ? Math.round((done / before.length) * 100) : 0;
    const level = !missing.length ? 'ready' : missing.some((m) => m.overdue) ? 'behind' : 'on-track';
    return { done, total: before.length, missing, toGo, text, pct, level };
  }
  function overdue(doc, now) {
    const today = todayIn(doc.plan.zone, now);
    return ordered(doc).filter((x) => !x.t.done && x.due < today).map((x) => withDue(doc, x.t, today));
  }
  /** Day 1's countdown in the business's zone: to the arrival time on the
   *  start date. After it, which day of the job it is. */
  function countdown(doc, now) {
    const p = doc.plan;
    const at = wallToUtc(p.start, toMin(p.arrive || '09:00'), p.zone);
    const ms = at - now;
    const today = todayIn(p.zone, now);
    if (ms > 0) {
      const days = Math.floor(ms / DAY);
      const hours = Math.floor((ms % DAY) / HOUR);
      const mins = Math.floor((ms % HOUR) / 60000);
      const toGo = daysBetween(today, p.start);
      const label = toGo === 0 ? `Today at ${fmtTime(p.arrive)}` : toGo === 1 ? `Tomorrow at ${fmtTime(p.arrive)}` : `${toGo} days to go`;
      return { before: true, ms, days, hours, mins, toGo, at, label };
    }
    const day = jobDay(p, today);
    return { before: false, ms, days: 0, hours: 0, mins: 0, toGo: daysBetween(today, p.start), at, day, label: day <= 5 ? `Day ${day} of the first week` : `Day ${day} on the job` };
  }
  /** A check-in: when it is due, and upcoming / open / done. */
  function checkinState(doc, key, today) {
    if (!CHECKINS.includes(key)) return null;
    const t = doc.tasks.find((x) => x.checkin === key);
    if (!t) return null;
    const due = dueOf(doc.plan, t);
    const answer = doc.checkins && doc.checkins[key] ? doc.checkins[key] : null;
    return { key, label: CHECKIN_LABEL[key], due, state: answer ? 'done' : (today >= due ? 'open' : 'upcoming'), answer };
  }
  function checkinList(doc, today) { return CHECKINS.map((k) => checkinState(doc, k, today)).filter(Boolean); }

  /* ------------------------------------------------------------------ *
   * What each link sees
   * ------------------------------------------------------------------ */

  /** The manager: everything (the server never adds a hash or a key). */
  function managerView(doc, now) {
    const today = todayIn(doc.plan.zone, now);
    return {
      v: doc.v, today, template: doc.template || null,
      plan: { ...doc.plan, holidays: (doc.plan.holidays || []).slice() },
      tasks: ordered(doc).map((x) => withDue(doc, x.t, today)),
      checkins: checkinList(doc, today),
      readiness: readiness(doc, now), overdue: overdue(doc, now), countdown: countdown(doc, now),
      createdAt: doc.createdAt, updatedAt: doc.updatedAt,
    };
  }
  /** A role link: first names, the start, its OWN tasks; the new hire also
   *  gets the welcome, the first week's schedule and their check-ins.
   *  Never the holidays, anyone else's tasks or ticks, the readiness meter,
   *  or a check-in answer on anyone's link but the hire's. */
  function roleView(doc, role, now) {
    if (!ROLES.includes(role)) throw err(403, 'Not from this link.');
    const today = todayIn(doc.plan.zone, now);
    const p = doc.plan;
    const mine = ordered(doc).filter((x) => x.t.owner === role).map((x) => {
      const t = withDue(doc, x.t, today);
      return { id: t.id, title: t.title, due: t.due, time: t.time, phase: t.phase, done: t.done, overdue: t.overdue };
    });
    const c = countdown(doc, now);
    const view = {
      v: doc.v, role, today,
      plan: { hire: p.hire, manager: p.manager, buddy: p.buddy, role: p.role, business: p.business, start: p.start, arrive: p.arrive, pattern: p.pattern, zone: p.zone },
      tasks: mine,
      countdown: { before: c.before, ms: c.ms, days: c.days, hours: c.hours, mins: c.mins, toGo: c.toGo, label: c.label, day: c.day || null },
    };
    if (role === 'hire') {
      view.welcome = { where: p.where, ask: p.ask, bring: p.bring, message: p.welcome };
      view.schedule = ordered(doc).filter((x) => ['day1', 'week'].includes(phaseOf(x.t)) && !x.t.checkin).map((x) => ({ id: x.t.id, title: x.t.title, owner: x.t.owner, due: x.due, time: x.t.time, phase: phaseOf(x.t) }));
      view.checkins = checkinList(doc, today).map((k) => ({ key: k.key, label: k.label, due: k.due, state: k.state, answer: k.answer }));
    }
    return view;
  }

  /* ------------------------------------------------------------------ *
   * The .ics: a person's tasks and the first week, in their own calendar
   * ------------------------------------------------------------------ */

  function icsText(v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n'); }
  function utf8Len(ch) { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  function icsFold(line) {
    const out = []; let cur = ''; let bytes = 0;
    for (const ch of Array.from(line)) {
      const n = utf8Len(ch);
      if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateOnly = (d) => d.replace(/-/g, '');

  /** `who` is 'manager' (every task) or a role (its own tasks; the hire
   *  also gets the first-day arrival and the week's schedule). Day 1's
   *  timed items are real instants in the business's zone; everything
   *  else is an all-day event on its due date. */
  function buildIcs(doc, who, now) {
    const p = doc.plan;
    const today = todayIn(p.zone, now);
    const all = ordered(doc);
    const rows = who === 'manager' ? all
      : all.filter((x) => x.t.owner === who || (who === 'hire' && ['day1', 'week'].includes(phaseOf(x.t)) && !x.t.checkin));
    const name = who === 'manager' ? `${p.hire}’s first weeks` : who === 'hire' ? 'My first week' : `${p.hire}’s first week`;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Firstday//Onboarding//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(`${name}${p.business ? ` · ${p.business}` : ''}`)}`];
    const event = (uid, start, end, summary, desc, allDay) => {
      lines.push('BEGIN:VEVENT', `UID:${uid}@firstday`, `DTSTAMP:${stamp(now)}`);
      if (allDay) lines.push(`DTSTART;VALUE=DATE:${dateOnly(start)}`, `DTEND;VALUE=DATE:${dateOnly(end)}`);
      else lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
      lines.push(`SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(desc)}`);
      if (!allDay) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, 'TRIGGER:-PT15M', 'END:VALARM');
      lines.push('END:VEVENT');
    };
    if (who === 'hire') {
      const at = wallToUtc(p.start, toMin(p.arrive), p.zone);
      event(`arrive-${dateOnly(p.start)}`, at, at + 30 * 60000, `First day${p.business ? ` at ${p.business}` : ''}`, `${p.where ? `${p.where}. ` : ''}Ask for ${p.ask || p.manager}.${p.bring ? ` Bring: ${p.bring}.` : ''}`, false);
    }
    const timed = all.filter((x) => x.t.time && phaseOf(x.t) === 'day1').map((x) => toMin(x.t.time)).sort((a, b) => a - b);
    for (const { t, due } of rows) {
      const owner = t.owner === 'hire' ? p.hire : t.owner === 'manager' ? p.manager : t.owner === 'buddy' ? (p.buddy || 'Buddy') : 'IT/admin';
      const desc = `${OWNER_LABEL[t.owner]}: ${owner}. ${t.done ? 'Done. ' : ''}From Firstday.`;
      if (t.time) {
        const s = toMin(t.time);
        const nextT = timed.find((m) => m > s);
        const e = Math.min(nextT !== undefined ? nextT : s + 60, s + 120);
        event(`${t.id}-${dateOnly(due)}`, wallToUtc(due, s, p.zone), wallToUtc(due, e, p.zone), t.title, desc, false);
      } else {
        event(`${t.id}-${dateOnly(due)}`, due, addDays(due, 1), t.title, desc, true);
      }
    }
    if (!rows.length && today) { /* an empty calendar is still a valid one */ }
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ *
   * Templates
   * ------------------------------------------------------------------ */

  // T(offset, owner, title, extra): offsets are working days from day 1 (0);
  // `cd` ones are calendar days. `only` keeps a task to some work patterns.
  const T = (offset, owner, title, extra) => ({ offset, owner, title, unit: 'bd', ...(extra || {}) });
  const CD = (offset, owner, title, extra) => ({ offset, owner, title, unit: 'cd', ...(extra || {}) });
  const REMOTE = ['remote', 'hybrid'];
  const SITE = ['onsite', 'hybrid'];
  const CHECKS = [
    T(4, 'manager', 'Day-5 check-in: how was the first week?', { checkin: 'd5' }),
    CD(30, 'manager', '30-day check-in: what’s clear, what isn’t', { checkin: 'd30' }),
    CD(60, 'manager', '60-day check-in: settle goals for the next month', { checkin: 'd60' }),
    CD(90, 'manager', '90-day check-in: how it’s going, and what’s next', { checkin: 'd90' }),
  ];
  const TEMPLATES = {
    frontofhouse: {
      label: 'Front of house', emoji: '☕', blurb: 'Cafes, restaurants, bars and shops: uniform, the till, the menu and a buddy on the floor.',
      pattern: 'onsite',
      tasks: [
        T(-10, 'manager', 'Order the uniform and name badge', { miss: 'uniform not ordered' }),
        T(-8, 'manager', 'Send the paperwork: contract, tax forms, handbook', { miss: 'paperwork not sent' }),
        T(-6, 'manager', 'Ask the buddy and agree their first week', { miss: 'buddy not briefed' }),
        T(-5, 'it', 'Set up the till/POS login and the rota app', { miss: 'till login not set up' }),
        T(-4, 'hire', 'Sign and send back the paperwork'),
        T(-3, 'manager', 'Tell the team who’s starting, when, and who’s their buddy', { miss: 'team not told' }),
        T(-3, 'manager', 'Put their first two weeks of shifts on the rota', { miss: 'shifts not on the rota' }),
        T(-2, 'manager', 'Clear a locker and a hook for their things', { miss: 'locker not ready' }),
        T(-2, 'manager', 'Send the welcome message: where, when, what to bring', { miss: 'welcome not sent' }),
        T(-1, 'buddy', 'Plan a first-day break together', { miss: 'buddy break not planned' }),
        T(-1, 'hire', 'Read the welcome message and reply with any questions'),
        T(0, 'manager', 'Welcome, coffee and a walk round front and back', { time: '08:30' }),
        T(0, 'manager', 'Locker, uniform, fire exits and first aid', { time: '09:00' }),
        T(0, 'buddy', 'Shadowing on the floor through the morning', { time: '09:30' }),
        T(0, 'hire', 'Allergens and food safety basics', { time: '11:00' }),
        T(0, 'buddy', 'First-day break together', { time: '12:30' }),
        T(0, 'buddy', 'First orders, side by side', { time: '13:30' }),
        T(0, 'manager', 'End-of-day chat: how was it?', { time: '15:00' }),
        T(1, 'hire', 'Learn the ten best-sellers and what’s in them'),
        T(1, 'buddy', 'Show the opening checklist'),
        T(2, 'hire', 'Run the till with your buddy watching'),
        T(3, 'buddy', 'Show the closing checklist and cash-up'),
        T(4, 'hire', 'Serve a busy hour with your buddy nearby'),
        T(10, 'hire', 'Open or close with the shift lead'),
      ].concat(CHECKS),
    },
    office: {
      label: 'Office / admin', emoji: '🗂️', blurb: 'Admin, finance, sales and office roles: a desk, the logins, the tools and who does what.',
      pattern: 'onsite',
      tasks: [
        T(-10, 'it', 'Order the laptop and anything else they need', { miss: 'laptop not ordered' }),
        T(-8, 'manager', 'Send the paperwork: contract, tax forms, handbook', { miss: 'paperwork not sent' }),
        T(-6, 'manager', 'Ask the buddy and agree their first week', { miss: 'buddy not briefed' }),
        T(-5, 'it', 'Create their accounts: email, chat, shared drive', { miss: 'accounts not set up' }),
        T(-4, 'hire', 'Sign and send back the paperwork'),
        T(-3, 'manager', 'Tell the team who’s starting, when, and who’s their buddy', { miss: 'team not told' }),
        T(-3, 'manager', 'Book the first week’s meetings in their calendar', { miss: 'first week not booked' }),
        T(-2, 'it', 'Set up the desk, keys or door fob', { miss: 'desk not ready', only: SITE }),
        T(-4, 'it', 'Ship the laptop and test a video call together', { miss: 'laptop not shipped', only: REMOTE }),
        T(-2, 'manager', 'Send the welcome message: where, when, what to bring', { miss: 'welcome not sent' }),
        T(-1, 'buddy', 'Plan a first-day lunch or coffee', { miss: 'buddy lunch not planned' }),
        T(-1, 'hire', 'Read the welcome message and reply with any questions'),
        T(0, 'manager', 'Welcome, coffee and a tour', { time: '09:00' }),
        T(0, 'it', 'Laptop, logins and the password manager', { time: '09:30' }),
        T(0, 'manager', 'The role, the first 30 days and who does what', { time: '10:30' }),
        T(0, 'buddy', 'Lunch together', { time: '12:30' }),
        T(0, 'buddy', 'Walk through the tools the team uses every day', { time: '14:00' }),
        T(0, 'hire', 'Read the handbook’s first chapter and note questions', { time: '15:30' }),
        T(0, 'manager', 'End-of-day chat: how was it?', { time: '16:30' }),
        T(1, 'buddy', 'Sit in on a real piece of work together'),
        T(2, 'hire', 'Meet three people outside the team'),
        T(3, 'hire', 'Do a first small task end to end'),
        T(4, 'buddy', 'Coffee: what’s been confusing so far?'),
        T(15, 'hire', 'Own one recurring task'),
      ].concat(CHECKS),
    },
    trades: {
      label: 'Trades / field', emoji: '🦺', blurb: 'Electricians, plumbers, builders, cleaners and field crews: PPE, the van, safety first, then on the job with a lead.',
      pattern: 'onsite',
      tasks: [
        T(-10, 'manager', 'Order PPE: boots, hi-vis, gloves, glasses', { miss: 'PPE not ordered' }),
        T(-8, 'manager', 'Send the paperwork: contract, tax forms, handbook', { miss: 'paperwork not sent' }),
        T(-7, 'manager', 'Check the certificates and tickets they hold', { miss: 'certificates not checked' }),
        T(-6, 'manager', 'Ask the lead hand to buddy them on the first jobs', { miss: 'buddy not briefed' }),
        T(-5, 'it', 'Set up the job-sheet app and timesheets', { miss: 'job app not set up' }),
        T(-4, 'hire', 'Sign and send back the paperwork'),
        T(-3, 'manager', 'Tell the crew who’s starting and which van they’re on', { miss: 'crew not told' }),
        T(-2, 'manager', 'Sort the tools they’ll carry and a place for them', { miss: 'tools not sorted' }),
        T(-2, 'manager', 'Send the welcome message: where, when, what to bring', { miss: 'welcome not sent' }),
        T(-1, 'hire', 'Read the welcome message and reply with any questions'),
        T(0, 'manager', 'Welcome at the yard, coffee and the safety talk', { time: '07:00' }),
        T(0, 'manager', 'PPE fitted, first aid, reporting a near miss', { time: '07:45' }),
        T(0, 'buddy', 'Van and tools check together', { time: '08:15' }),
        T(0, 'buddy', 'First job: watch, carry, ask', { time: '09:00' }),
        T(0, 'buddy', 'Lunch with the crew', { time: '12:00' }),
        T(0, 'hire', 'Fill in your first job sheet', { time: '15:00' }),
        T(0, 'manager', 'End-of-day chat: how was it?', { time: '15:30' }),
        T(1, 'buddy', 'One part of a job, with the lead checking'),
        T(2, 'hire', 'Learn how to order parts and log materials'),
        T(3, 'buddy', 'Talk through what went well and one thing to practise'),
        T(4, 'hire', 'Load and lock the van at the end of the day'),
        T(20, 'hire', 'Take the lead on a small job, with a check after'),
      ].concat(CHECKS),
    },
    remote: {
      label: 'Remote knowledge worker', emoji: '💻', blurb: 'Remote and hybrid roles: the laptop shipped early, every login working, and people to talk to from day one.',
      pattern: 'remote',
      tasks: [
        T(-12, 'it', 'Order and ship the laptop and headset', { miss: 'laptop not shipped' }),
        T(-8, 'manager', 'Send the paperwork: contract, tax forms, handbook', { miss: 'paperwork not sent' }),
        T(-6, 'manager', 'Ask the buddy and agree their first week', { miss: 'buddy not briefed' }),
        T(-5, 'it', 'Create their accounts: email, chat, video, code or docs', { miss: 'accounts not set up' }),
        T(-4, 'hire', 'Sign and send back the paperwork'),
        T(-3, 'manager', 'Tell the team who’s starting and who’s their buddy', { miss: 'team not told' }),
        T(-3, 'manager', 'Book the first week’s calls in their calendar', { miss: 'first week not booked' }),
        T(-2, 'it', 'Test a video call with them on the new laptop', { miss: 'video call not tested' }),
        T(-2, 'manager', 'Send the welcome message: the first call’s link and time', { miss: 'welcome not sent' }),
        T(-1, 'hire', 'Unbox the laptop and check you can sign in'),
        T(0, 'manager', 'Welcome call: the week ahead', { time: '09:00' }),
        T(0, 'it', 'Logins, two-factor and the password manager', { time: '09:45' }),
        T(0, 'manager', 'The role, the first 30 days and who does what', { time: '11:00' }),
        T(0, 'buddy', 'Virtual lunch together', { time: '12:30' }),
        T(0, 'buddy', 'A tour of where things live: chat channels, docs, tickets', { time: '14:00' }),
        T(0, 'hire', 'Post a hello in the team channel', { time: '15:00' }),
        T(0, 'manager', 'End-of-day call: how was it?', { time: '16:30' }),
        T(1, 'buddy', 'Pair on a real piece of work'),
        T(2, 'hire', 'Book three short calls with people outside the team'),
        T(3, 'hire', 'Ship a first small change end to end'),
        T(4, 'buddy', 'Call: what’s been confusing so far?'),
        T(15, 'hire', 'Own one recurring piece of work'),
      ].concat(CHECKS),
    },
    seasonal: {
      label: 'Part-time / seasonal', emoji: '🌤️', blurb: 'Part-time, weekend and seasonal staff: short shifts, the essentials first, the rest as they go.',
      pattern: 'onsite',
      tasks: [
        T(-7, 'manager', 'Send the paperwork: contract and tax forms', { miss: 'paperwork not sent' }),
        T(-5, 'manager', 'Order the uniform or T-shirt', { miss: 'uniform not ordered' }),
        T(-4, 'it', 'Set up their rota and clock-in login', { miss: 'logins not set up' }),
        T(-3, 'hire', 'Sign and send back the paperwork'),
        T(-3, 'manager', 'Tell the team who’s starting and when', { miss: 'team not told' }),
        T(-2, 'manager', 'Put their shifts for the season on the rota', { miss: 'shifts not on the rota' }),
        T(-2, 'manager', 'Send the welcome message: where, when, what to bring', { miss: 'welcome not sent' }),
        T(-1, 'buddy', 'Agree to be their go-to person for the first shifts', { miss: 'buddy not asked' }),
        T(0, 'manager', 'Welcome, a quick tour and the fire exits', { time: '09:00' }),
        T(0, 'buddy', 'Shadowing on the job', { time: '09:30' }),
        T(0, 'hire', 'The three things that matter most here', { time: '11:30' }),
        T(0, 'manager', 'End-of-shift chat: how was it?', { time: '13:00' }),
        T(1, 'buddy', 'The main job, with the buddy nearby'),
        T(3, 'hire', 'Work a shift with a lighter check-in'),
        T(4, 'manager', 'Day-5 check-in: how was the first week?', { checkin: 'd5' }),
        CD(30, 'manager', '30-day check-in: what’s clear, what isn’t', { checkin: 'd30' }),
        CD(60, 'manager', 'Mid-season check-in: more shifts, or fewer?', { checkin: 'd60' }),
        CD(90, 'manager', 'End-of-season chat: would they come back?', { checkin: 'd90' }),
      ],
    },
  };
  /** A template's tasks for a work pattern, with ids. */
  function fromTemplate(id, pattern, ids) {
    const t = TEMPLATES[id] || TEMPLATES.office;
    return cleanTaskList(t.tasks.filter((x) => !x.only || x.only.includes(pattern)), ids || seqIds(`tpl:${id}`));
  }

  /* ------------------------------------------------------------------ *
   * The sample: a made-up cafe hire starting next Monday
   * ------------------------------------------------------------------ */

  /** Fernhill Cafe (made up): Sam starts as a barista next Monday, Mia
   *  manages, Jonah is the buddy. Most of the prep is done - 7 of 9 - but
   *  the uniform has slipped past its date, so the meter has something to
   *  say; on the first week itself nothing is ticked yet. */
  function sample(today, zone, now) {
    const start = nextMonday(today);
    const doc = {
      v: 1,
      plan: {
        hire: 'Sam', role: 'Barista', business: 'Fernhill Cafe', manager: 'Mia', buddy: 'Jonah', start,
        pattern: 'onsite', zone: cleanZone(zone), workWeekends: false, arrive: '08:30',
        // The cafe closes for the winter holidays: the 60- and 90-day
        // check-ins roll past them, which is the point of listing them.
        holidays: cleanHolidays([0, 1].flatMap((k) => [`${+start.slice(0, 4) + k}-12-25`, `${+start.slice(0, 4) + k}-12-26`, `${+start.slice(0, 4) + k}-01-01`]).filter((d) => d > start && d < addDays(start, 120))),
        where: 'Fernhill Cafe - the side door by the bike rack, before we open', ask: 'Mia',
        bring: 'Comfortable non-slip shoes, a water bottle and your signed contract',
        welcome: 'Hi Sam! We’re so glad you’re joining us.\n\nMonday is about settling in - nobody expects you to know the menu yet. Jonah is your buddy all week and makes the best flat white in town. See you at 8:30!\n\nMia',
      },
      tasks: fromTemplate('frontofhouse', 'onsite', seqIds('sample')),
      checkins: {}, template: 'frontofhouse',
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    };
    const doneTitles = ['Send the paperwork', 'Ask the buddy', 'Set up the till', 'Sign and send back', 'Put their first two weeks', 'Tell the team', 'Send the welcome', 'Clear a locker'];
    for (const t of doc.tasks) {
      if (doneTitles.some((d) => t.title.startsWith(d))) { t.done = true; t.doneAt = new Date(now - 2 * DAY).toISOString(); t.doneBy = t.owner; }
    }
    return doc;
  }

  return {
    LIMITS, OWNERS, OWNER_LABEL, ROLES, PATTERNS, PATTERN_LABEL, CHECKINS, CHECKIN_LABEL, MOODS, MOOD_ICON, SECTIONS, DAYS, DAY_LONG, MONTHS, TEMPLATES, TASK_ID, REFUSE_TEXT,
    err, clean, cleanLines, firstName, fold, sensitive, guard, cleanTime, cleanDate, toMin, fmtTime, addDays, daysBetween, weekday, dayLabel, longDay,
    isWorkday, shiftWorkdays, nextWorkday, dueOf, offsetFor, jobDay, zoneOk, cleanZone, offsetMin, wallToUtc, todayIn, nextMonday, idFrom,
    phaseOf, cleanTask, cleanTaskList, cleanPlan, cleanHolidays, newDoc, copyTasks, fromTemplate, ordered, manage, linkAct,
    readiness, overdue, countdown, checkinState, checkinList, managerView, roleView, buildIcs, icsText, icsFold, sample, plural,
  };
}));
