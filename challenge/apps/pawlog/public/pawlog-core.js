/* Pawlog - the rules, in one file. Fed? Walked? Meds given? The whole house
 * knows.
 *
 * Run three times: by the page (window.PawlogCore), by the server and by the
 * tests (require). UMD, no dependencies, no clock and no dice of its own:
 * every function that needs "now" is handed it in milliseconds, and every
 * fresh id comes from an `ids` function the caller passes, so the sample and
 * the tests can stand on any instant they like (a clock change, a month end,
 * a leap day).
 *
 * What is here:
 *   - cleaning: one door for every typed string (no markup, no control or
 *     bidi characters, bounded), first names, the vet's one phone number,
 *     and contact details kept out of notes;
 *   - civil days and the household's own time zone: "today", minutes since
 *     midnight, and a log's instant read back as a day and a time, across a
 *     daylight-saving change;
 *   - pets and their care routine (templates per kind), each item with a
 *     time window and a repeat: every day, every N days, weekly, monthly
 *     (the 31st falls on the last day of a shorter month);
 *   - medicines: doses at set times, a start and an end;
 *   - the Today board: what is due, done (by whom and when), overdue;
 *   - the double-done guard and the two-minute undo;
 *   - health records (vaccinations, flea and worm treatment, vet visits)
 *     with due dates, a weight log, "Due soon";
 *   - the week: "walked 13 of 14 times", streaks, who did what;
 *   - every change (`act`), so the phone and the server run the same rules;
 *   - what each kind of link shows (`memberView`, `sitterView`);
 *   - the calendar file (.ics) and the sample home.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PawlogCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    homeName: 40,      // "The Hartley house"
    name: 24,          // a first name, maybe with an initial
    petName: 24,
    label: 40,         // "Evening walk (long one)"
    note: 400,         // a pet's notes for the sitter
    medName: 50,
    dose: 60,          // "4 drops, left ear"
    healthName: 60,
    practice: 60,
    members: 12,
    pets: 12,
    items: 80,         // routine items, every pet together
    meds: 24,
    health: 120,
    weights: 60,       // per pet
    logDays: 35,       // how much of the log is kept
    logs: 3000,
    timesPerMed: 4,
    sitterLinks: 3,
    sitterDays: 60,    // a sitter link closes no later than this many days ahead
    guardMin: 30,      // a second "done" this soon after the first asks first
    undoMin: 2,        // a "done" can be taken back for this long
    soonDays: 30,      // "Due soon" looks this far ahead
  };
  const DAY_MS = 86400000;
  const MIN_MS = 60000;

  /* ------------------------------------------------------------------ *
   * Cleaning
   * ------------------------------------------------------------------ */

  // Control characters and the bidi overrides and isolates. The zero-width
  // joiner stays: emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters. Cut before any pattern runs,
   *  so hostile input costs linear time. */
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** The same, but it has to say something: a letter, a digit or an emoji. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  /** Several lines (a pet's notes): each line cleaned, at most six. */
  function cleanNote(v, max) {
    if (typeof v !== 'string') return '';
    const lines = v.slice(0, max * 4 + 200).split(/\r\n|\r|\n/).map((l) => clean(l, max)).filter(Boolean).slice(0, 6);
    const s = lines.join('\n');
    return Array.from(s).length > max ? Array.from(s).slice(0, max - 1).join('') + '…' : s;
  }
  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function fail(status, message, extra) {
    return Object.assign(new Error(message), { status, expose: true }, extra || {});
  }
  /** A first name, and at most an initial: "Sam", "Sam K". Never a surname. */
  function firstName(v) {
    const words = cleanText(v, 60).split(' ').map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, '')).filter((w) => /[\p{L}]/u.test(w));
    if (!words.length) return '';
    const first = cleanText(words[0], LIMITS.name);
    if (!first) return '';
    const init = words[1] && /^\p{L}\.?$/u.test(words[1]) ? ' ' + words[1].charAt(0).toUpperCase() : '';
    return first.charAt(0).toUpperCase() + first.slice(1) + init;
  }
  function possessive(name) { return /s$/i.test(name) ? `${name}’` : `${name}’s`; }

  // Contact details belong in one place only: the vet's phone number. A
  // pet's notes travel to the sitter, so anything shaped like a phone
  // number, an email or a street address is taken out of them.
  const DATE_SHAPES = [/\b\d{4}-\d{2}-\d{2}\b/g, /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g];
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)[\s.-]?)?\d(?:[\s.-]?\d){6,}/g;
  const STREET = /\b\d{1,5}[A-Za-z]?\s+(?:[A-Za-z][A-Za-z'’.-]*\s+){0,3}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|way|close|place|pl|boulevard|blvd|crescent|cres|terrace|ter|highway|hwy|parkway|pkwy|circle|cir|square|sq|grove|gardens|gdns|mews|row|walk)\b\.?(?:,?\s*(?:apt|apartment|unit|flat|suite|ste)\.?\s*#?\s*\w+)?/gi;
  const POSTCODE_UK = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g;
  const ZIP = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g;
  const LABELLED = /\b(?:account|acct|a\/c|client|customer|owner|member|policy|invoice|inv|ref(?:erence)?|card|sort\s*code|routing|iban|microchip|chip)\s*(?:no\.?|number|num|id|#)?\s*[:#]?\s*[A-Z0-9][A-Z0-9 -]{3,}\d/gi;
  const ADDRESS_WORD = /\b(?:address|addr)\s*[:-]\s*[^\n,]{3,}(?:,[^\n,]{2,}){0,3}/gi;
  const LONG_DIGITS = /\d(?:[\s-]?\d){5,}/g;

  /** Text with anything shaped like an address, an account or reference
   *  number, an email or a phone number taken out. Dates stay. Used on a
   *  pet's notes, on pasted vet paperwork before a model sees it, and on
   *  every string a model sends back. */
  function stripPrivate(v, max) {
    if (typeof v !== 'string') return { text: '', stripped: false };
    let s = v.slice(0, (max || 20000) * 2);
    const keep = [];
    for (const re of DATE_SHAPES) s = s.replace(re, (m) => { keep.push(m); return `\u0001${keep.length - 1}\u0001`; });
    let stripped = false;
    const cut = () => { stripped = true; return ' '; };
    s = s.replace(EMAIL, cut).replace(ADDRESS_WORD, cut).replace(LABELLED, cut).replace(STREET, cut)
      .replace(POSTCODE_UK, cut).replace(ZIP, cut).replace(PHONE, cut).replace(LONG_DIGITS, cut);
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => keep[Number(i)]).replace(/[ \t]{2,}/g, ' ');
    return { text: s, stripped };
  }
  /** Does this text carry a contact detail the notes should not hold? */
  function hasContact(v) { return stripPrivate(v).stripped; }

  /** The vet's phone: the one phone number Pawlog keeps. Digits, spaces,
   *  + ( ) - and dots, 7 to 15 digits. Anything else is no number. */
  function cleanPhone(v) {
    if (typeof v !== 'string') return '';
    const s = v.replace(STRIP, '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 24 || !/^\+?[\d\s().-]+$/.test(s)) return '';
    const n = s.replace(/\D/g, '').length;
    return n >= 7 && n <= 15 ? s : '';
  }
  function telHref(phone) { return 'tel:' + String(phone || '').replace(/[^\d+]/g, ''); }

  /* ------------------------------------------------------------------ *
   * Calendar days. Every date is a civil 'YYYY-MM-DD' and the sums are done
   * on UTC midnights, so a clock change never moves a due date or miscounts
   * the days to it.
   * ------------------------------------------------------------------ */

  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function daysInMonth(y, m) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  function isDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    return y >= 1980 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }
  const dayMs = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / DAY_MS); }
  function addDays(day, n) { return fromMs(dayMs(day) + n * DAY_MS); }
  const pad = (n) => String(n).padStart(2, '0');
  function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
  /** n months on, kept on the same day of the month - or the month's last
   *  day when it is shorter (Jan 31 + 1 month is Feb 28, or 29). */
  function addMonths(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    const t = (y * 12 + (m - 1)) + n;
    const ny = Math.floor(t / 12);
    const nm = (t % 12) + 1;
    return ymd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
  }
  function weekday(day) { return new Date(dayMs(day)).getUTCDay(); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  /** "Oct 26", or "Oct 26, 2027" outside today's year. */
  function fmtDay(day, today) {
    if (!isDay(day)) return '';
    const [y, m, d] = day.split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}${today && today.slice(0, 4) !== String(y) ? `, ${y}` : ''}`;
  }
  /** "Today", "Yesterday", "Tomorrow", "Mon Oct 26". */
  function relDay(day, today) {
    const n = daysBetween(today, day);
    if (n === 0) return 'Today';
    if (n === -1) return 'Yesterday';
    if (n === 1) return 'Tomorrow';
    return `${WD[weekday(day)]} ${fmtDay(day, today)}`;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function ordinal(n) {
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return n + s;
  }
  /** "Due in 9 days", "Due tomorrow", "Due today", "3 days overdue". */
  function dueWords(inDays) {
    if (inDays === 0) return 'Due today';
    if (inDays === 1) return 'Due tomorrow';
    if (inDays > 1) return `Due in ${inDays} days`;
    return inDays === -1 ? '1 day overdue' : `${-inDays} days overdue`;
  }

  /* ------------------------------------------------------------------ *
   * The household's time zone. A log is an instant; the board needs the
   * household's own day and minute for it. Intl does the zone sums, so a
   * clock change is a 23- or 25-hour day and nothing else.
   * ------------------------------------------------------------------ */

  const fmts = new Map();
  function zoneFmt(tz) {
    let f = fmts.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      if (fmts.size > 50) fmts.clear();
      fmts.set(tz, f);
    }
    return f;
  }
  /** A real IANA zone name, or null. */
  function cleanTz(v) {
    if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(v)) return null;
    try { zoneFmt(v); return v; } catch (e) { return null; }
  }
  /** The household's day and minute (0-1439) at an instant. */
  function zoned(ms, tz) {
    const parts = {};
    for (const p of zoneFmt(tz || 'UTC').formatToParts(new Date(ms))) parts[p.type] = p.value;
    const h = Number(parts.hour) % 24;
    return { day: `${parts.year}-${parts.month}-${parts.day}`, min: h * 60 + Number(parts.minute) };
  }
  /** Minutes the zone is ahead of UTC at an instant. */
  function offsetMin(ms, tz) {
    const z = zoned(ms, tz);
    return Math.round((dayMs(z.day) + z.min * MIN_MS - Math.floor(ms / MIN_MS) * MIN_MS) / MIN_MS);
  }
  /** The instant a household day and minute names. In the hour a clock
   *  skips, the same minute an hour earlier; in the hour it repeats, the
   *  second time round. */
  function instantOf(day, min, tz) {
    const guess = dayMs(day) + min * MIN_MS;
    const o1 = offsetMin(guess, tz);
    let ms = guess - o1 * MIN_MS;
    const o2 = offsetMin(ms, tz);
    if (o2 !== o1) ms = guess - o2 * MIN_MS;
    return ms;
  }
  /** "7:42am" from minutes since midnight. */
  function fmtTime(min) {
    const m = ((Math.round(min) % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60);
    return `${h % 12 === 0 ? 12 : h % 12}:${pad(m % 60)}${h < 12 ? 'am' : 'pm'}`;
  }
  /** "7:42am" for an instant, in the household's zone. */
  function clockOf(ms, tz) { return fmtTime(zoned(ms, tz).min); }
  /** "07:42" for <input type=time>, and back. */
  function hhmm(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
  function parseHhmm(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    const h = Number(m[1]); const mi = Number(m[2]);
    return h <= 23 && mi <= 59 ? h * 60 + mi : null;
  }
  const isMin = (v) => Number.isInteger(v) && v >= 0 && v <= 1439;

  /* ------------------------------------------------------------------ *
   * Pets, kinds and their routine
   * ------------------------------------------------------------------ */

  const KINDS = [
    { id: 'dog', label: 'Dog', emoji: '🐕' },
    { id: 'cat', label: 'Cat', emoji: '🐈' },
    { id: 'rabbit', label: 'Rabbit', emoji: '🐇' },
    { id: 'bird', label: 'Bird', emoji: '🐦' },
    { id: 'fish', label: 'Fish', emoji: '🐠' },
    { id: 'reptile', label: 'Reptile', emoji: '🦎' },
    { id: 'other', label: 'Other', emoji: '🐾' },
  ];
  const KIND_IDS = KINDS.map((k) => k.id);
  const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[KINDS.length - 1];

  const TASKS = [
    { id: 'feed', label: 'Feed', emoji: '🥣', done: 'Fed' },
    { id: 'walk', label: 'Walk', emoji: '🦮', done: 'Walked' },
    { id: 'litter', label: 'Litter', emoji: '🧹', done: 'Litter done' },
    { id: 'water', label: 'Water', emoji: '💧', done: 'Water done' },
    { id: 'clean', label: 'Clean', emoji: '🧽', done: 'Cleaned' },
    { id: 'play', label: 'Play', emoji: '🎾', done: 'Played' },
    { id: 'meds', label: 'Medicine', emoji: '💊', done: 'Given' },
    { id: 'other', label: 'Other', emoji: '✅', done: 'Done' },
  ];
  const TASK_IDS = TASKS.map((t) => t.id);
  const taskOf = (id) => TASKS.find((t) => t.id === id) || TASKS[TASKS.length - 1];

  const EVERY = ['day', 'days', 'week', 'month'];
  /** A repeat: every day, every n days, weekly (on the anchor's weekday) or
   *  monthly (on the anchor's day of the month, or the last day of a shorter
   *  month). The anchor is the first day it applies. */
  function cleanRepeat(r, fallbackDay) {
    const x = r && typeof r === 'object' ? r : {};
    const every = EVERY.includes(x.every) ? x.every : 'day';
    const n = every === 'days' ? (Number.isInteger(x.n) && x.n >= 2 && x.n <= 30 ? x.n : 2) : 1;
    const anchor = isDay(x.anchor) ? x.anchor : fallbackDay;
    return { every, n, anchor };
  }
  /** Is a repeat due on this day? */
  function dueOn(r, day) {
    if (!r || !isDay(day)) return false;
    if (r.every === 'day') return true;
    if (!isDay(r.anchor) || day < r.anchor) return false;
    if (r.every === 'days') return daysBetween(r.anchor, day) % r.n === 0;
    if (r.every === 'week') return weekday(day) === weekday(r.anchor);
    if (r.every === 'month') {
      const [y, m, d] = day.split('-').map(Number);
      const want = Number(r.anchor.slice(8, 10));
      return d === Math.min(want, daysInMonth(y, m));
    }
    return false;
  }
  /** The first day on or after `from` that a repeat is due (within a year). */
  function nextDue(r, from) {
    for (let i = 0; i < 400; i++) { const d = addDays(from, i); if (dueOn(r, d)) return d; }
    return null;
  }
  /** "Every day", "Every 3 days", "Weekly on Sundays", "Monthly on the 31st". */
  function repeatWords(r) {
    if (!r || r.every === 'day') return 'Every day';
    if (r.every === 'days') return `Every ${r.n} days`;
    if (r.every === 'week') return `Weekly on ${WEEKDAYS[weekday(r.anchor)]}s`;
    const d = Number(r.anchor.slice(8, 10));
    return `Monthly on the ${ordinal(d)}${d > 28 ? ' (or the month’s last day)' : ''}`;
  }

  /** The routine a new pet starts with, by kind. Times are minutes since
   *  midnight; every one of them can be changed. */
  const TEMPLATES = {
    dog: [
      ['feed', 'Breakfast', 7 * 60, 9 * 60, 'day'],
      ['walk', 'Morning walk', 7 * 60, 10 * 60, 'day'],
      ['walk', 'Evening walk', 17 * 60, 20 * 60, 'day'],
      ['feed', 'Dinner', 17 * 60 + 30, 19 * 60 + 30, 'day'],
    ],
    cat: [
      ['feed', 'Breakfast', 7 * 60, 9 * 60, 'day'],
      ['feed', 'Dinner', 17 * 60 + 30, 19 * 60 + 30, 'day'],
      ['litter', 'Scoop the litter', 18 * 60, 22 * 60, 'day'],
    ],
    rabbit: [
      ['feed', 'Hay and pellets', 7 * 60, 9 * 60, 'day'],
      ['feed', 'Fresh greens', 17 * 60, 19 * 60, 'day'],
      ['water', 'Fresh water', 7 * 60, 10 * 60, 'day'],
      ['clean', 'Clean the hutch', 10 * 60, 18 * 60, 'week'],
    ],
    bird: [
      ['feed', 'Seed and fresh water', 7 * 60, 9 * 60, 'day'],
      ['play', 'Out of the cage', 16 * 60, 19 * 60, 'day'],
      ['clean', 'Clean the cage', 10 * 60, 18 * 60, 'week'],
    ],
    fish: [
      ['feed', 'Feed', 8 * 60, 10 * 60, 'day'],
      ['water', 'Water change', 10 * 60, 18 * 60, 'week'],
    ],
    reptile: [
      ['feed', 'Feed', 17 * 60, 19 * 60, 'days'],
      ['water', 'Mist and fresh water', 8 * 60, 10 * 60, 'day'],
      ['other', 'Check the heat lamp', 8 * 60, 10 * 60, 'day'],
      ['clean', 'Deep-clean the tank', 10 * 60, 18 * 60, 'month'],
    ],
    other: [
      ['feed', 'Feed', 8 * 60, 10 * 60, 'day'],
      ['water', 'Fresh water', 8 * 60, 10 * 60, 'day'],
    ],
  };
  function templateFor(kind, petId, today, ids) {
    return (TEMPLATES[kind] || TEMPLATES.other).map(([task, label, from, to, every]) => ({
      id: ids('i'), pet: petId, task, label, from, to,
      repeat: { every, n: every === 'days' ? 3 : 1, anchor: today },
    }));
  }

  const ID_RE = /^[a-z][a-z0-9-]{3,39}$/;
  const isId = (v) => typeof v === 'string' && ID_RE.test(v);

  /* ------------------------------------------------------------------ *
   * One door for each kind of record. The server runs these on everything
   * a phone sends; the phone runs them on what it reads back.
   * ------------------------------------------------------------------ */

  function cleanPet(raw, today) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const name = cleanText(p.name, LIMITS.petName);
    if (!isId(p.id) || !name) return null;
    const birthday = isDay(p.birthday) && p.birthday <= today ? p.birthday : null;
    return {
      id: p.id, name, kind: KIND_IDS.includes(p.kind) ? p.kind : 'other', birthday,
      notes: stripPrivate(cleanNote(p.notes, LIMITS.note)).text.replace(/ +\n/g, '\n').trim(),
      createdAt: Number.isFinite(p.createdAt) && p.createdAt > 0 ? Math.round(p.createdAt) : 0,
    };
  }
  function cleanItem(raw, pets, today) {
    const x = raw && typeof raw === 'object' ? raw : {};
    if (!isId(x.id) || !pets.includes(x.pet)) return null;
    const task = TASK_IDS.includes(x.task) && x.task !== 'meds' ? x.task : 'other';
    const label = cleanText(x.label, LIMITS.label) || taskOf(task).label;
    let from = isMin(x.from) ? x.from : 8 * 60;
    let to = isMin(x.to) ? x.to : from + 120;
    if (to <= from) to = Math.min(1439, from + 60);
    if (to <= from) from = to - 1;
    return { id: x.id, pet: x.pet, task, label, from, to, repeat: cleanRepeat(x.repeat, today) };
  }
  function cleanMed(raw, pets, today) {
    const x = raw && typeof raw === 'object' ? raw : {};
    const name = cleanText(x.name, LIMITS.medName);
    if (!isId(x.id) || !pets.includes(x.pet) || !name) return null;
    const times = [...new Set((Array.isArray(x.times) ? x.times : []).filter(isMin))].sort((a, b) => a - b).slice(0, LIMITS.timesPerMed);
    const start = isDay(x.start) ? x.start : today;
    const until = isDay(x.until) && x.until >= start ? x.until : null;
    const repeat = cleanRepeat(x.repeat, start);
    if (repeat.every !== 'day') repeat.anchor = start;
    return { id: x.id, pet: x.pet, name, dose: cleanText(x.dose, LIMITS.dose), times: times.length ? times : [8 * 60], repeat, start, until };
  }
  const HEALTH_TYPES = [
    { id: 'vaccine', label: 'Vaccination', emoji: '💉', months: 12 },
    { id: 'flea', label: 'Flea & tick', emoji: '🪲', months: 1 },
    { id: 'worm', label: 'Worming', emoji: '🪱', months: 3 },
    { id: 'visit', label: 'Vet visit', emoji: '🩺', months: 12 },
    { id: 'other', label: 'Other', emoji: '📋', months: 0 },
  ];
  const HEALTH_IDS = HEALTH_TYPES.map((h) => h.id);
  const healthOf = (id) => HEALTH_TYPES.find((h) => h.id === id) || HEALTH_TYPES[HEALTH_TYPES.length - 1];
  function cleanHealth(raw, pets) {
    const x = raw && typeof raw === 'object' ? raw : {};
    if (!isId(x.id) || !pets.includes(x.pet)) return null;
    const type = HEALTH_IDS.includes(x.type) ? x.type : 'other';
    const name = cleanText(x.name, LIMITS.healthName) || healthOf(type).label;
    const given = isDay(x.given) ? x.given : null;
    const due = isDay(x.due) ? x.due : null;
    if (!given && !due) return null;
    const everyMonths = Number.isInteger(x.everyMonths) && x.everyMonths >= 0 && x.everyMonths <= 36 ? x.everyMonths : 0;
    return { id: x.id, pet: x.pet, type, name, given, due, everyMonths };
  }
  function cleanWeight(raw, pets, today) {
    const x = raw && typeof raw === 'object' ? raw : {};
    if (!isId(x.id) || !pets.includes(x.pet) || !isDay(x.day) || x.day > addDays(today, 1)) return null;
    const g = Number.isInteger(x.g) && x.g >= 10 && x.g <= 150000 ? x.g : null;
    return g ? { id: x.id, pet: x.pet, day: x.day, g } : null;
  }
  function cleanMember(raw) {
    const x = raw && typeof raw === 'object' ? raw : {};
    const name = firstName(x.name);
    return isId(x.id) && name ? { id: x.id, name } : null;
  }
  function cleanLog(raw, pets) {
    const x = raw && typeof raw === 'object' ? raw : {};
    if (!isId(x.id) || !pets.includes(x.pet) || !isDay(x.day) || !Number.isFinite(x.at) || typeof x.key !== 'string' || !/^[a-z][a-z0-9-]{3,39}(?:@\d{1,4})?$/.test(x.key)) return null;
    const out = { id: x.id, key: x.key, pet: x.pet, day: x.day, at: Math.round(x.at), by: isId(x.by) || x.by === 'sitter' ? x.by : 'someone', name: firstName(x.name) || 'Someone' };
    if (x.by === 'sitter' && typeof x.link === 'string' && /^[A-Z2-9]{10}$/.test(x.link)) out.link = x.link;
    return out;
  }
  const UNITS = ['lb', 'kg'];
  /** A whole household, through every door above. Unknown fields, records
   *  that point at a missing pet and anything over a limit are dropped. */
  function cleanHome(raw, nowMs, tzFallback) {
    const h = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const tz = cleanTz(h.tz) || cleanTz(tzFallback) || 'UTC';
    const today = zoned(nowMs, tz).day;
    const pets = (Array.isArray(h.pets) ? h.pets : []).map((p) => cleanPet(p, today)).filter(Boolean);
    const seen = new Set();
    const uniq = (list) => list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
    const petList = uniq(pets).slice(0, LIMITS.pets);
    const petIds = petList.map((p) => p.id);
    const arr = (k) => (Array.isArray(h[k]) ? h[k] : []);
    const weightsByPet = {};
    const weights = uniq(arr('weights').map((w) => cleanWeight(w, petIds, today)).filter(Boolean))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
      .filter((w) => { weightsByPet[w.pet] = (weightsByPet[w.pet] || 0) + 1; return true; });
    const keepW = [];
    const counts = {};
    for (let i = weights.length - 1; i >= 0; i--) { const w = weights[i]; counts[w.pet] = (counts[w.pet] || 0) + 1; if (counts[w.pet] <= LIMITS.weights) keepW.unshift(w); }
    const vet = h.vet && typeof h.vet === 'object' ? h.vet : {};
    const members = [];
    for (const m of arr('members').map(cleanMember).filter(Boolean)) {
      if (members.length >= LIMITS.members || members.some((x) => x.id === m.id || fold(x.name) === fold(m.name))) continue;
      members.push(m);
    }
    return {
      v: Number.isInteger(h.v) && h.v >= 0 ? h.v : 0,
      name: cleanText(h.name, LIMITS.homeName) || 'Our home',
      tz,
      units: UNITS.includes(h.units) ? h.units : 'lb',
      members,
      pets: petList,
      items: uniq(arr('items').map((x) => cleanItem(x, petIds, today)).filter(Boolean)).slice(0, LIMITS.items),
      meds: uniq(arr('meds').map((x) => cleanMed(x, petIds, today)).filter(Boolean)).slice(0, LIMITS.meds),
      health: uniq(arr('health').map((x) => cleanHealth(x, petIds)).filter(Boolean)).slice(0, LIMITS.health),
      weights: keepW,
      vet: { practice: cleanText(vet.practice, LIMITS.practice), phone: cleanPhone(vet.phone) },
      logs: pruneLogs(uniq(arr('logs').map((x) => cleanLog(x, petIds)).filter(Boolean)), today),
      createdAt: Number.isFinite(h.createdAt) && h.createdAt > 0 ? Math.round(h.createdAt) : nowMs,
    };
  }
  function pruneLogs(logs, today) {
    const from = addDays(today, -LIMITS.logDays);
    return logs.filter((l) => l.day >= from && l.day <= addDays(today, 1)).sort((a, b) => a.at - b.at).slice(-LIMITS.logs);
  }

  /* ------------------------------------------------------------------ *
   * What is due, and the Today board
   * ------------------------------------------------------------------ */

  /** Is a medicine given on this day? */
  function medOn(m, day) { return day >= m.start && (!m.until || day <= m.until) && dueOn(m.repeat, day); }
  /** A medicine's course: "Starts Oct 30", "Last dose today", "4 days left
   *  (until Oct 27)", "Ongoing", "Finished Oct 20". */
  function medStatus(m, today) {
    if (m.start > today) return { id: 'upcoming', words: `Starts ${fmtDay(m.start, today)}` };
    if (!m.until) return { id: 'active', words: 'Ongoing', left: null };
    if (m.until < today) return { id: 'ended', words: `Finished ${fmtDay(m.until, today)}` };
    const left = daysBetween(today, m.until) + 1;
    return { id: 'active', left, words: left === 1 ? 'Last day today' : `${left} days left (until ${fmtDay(m.until, today)})` };
  }
  /** Everything due on a day, for every pet: routine items and medicine
   *  doses, in time order. A dose's key is `<med id>@<minute>`. */
  function dueOnDay(doc, day) {
    const out = [];
    for (const it of doc.items || []) {
      if (dueOn(it.repeat, day)) out.push({ key: it.id, pet: it.pet, kind: 'item', task: it.task, label: it.label, from: it.from, to: it.to, repeat: it.repeat });
    }
    for (const m of doc.meds || []) {
      if (!medOn(m, day)) continue;
      for (const t of m.times) {
        out.push({ key: `${m.id}@${t}`, pet: m.pet, kind: 'dose', task: 'meds', label: m.name + (m.dose ? ` · ${m.dose}` : ''), from: Math.max(0, t - 60), to: Math.min(1439, t + 120), at: t, med: m.id });
      }
    }
    return out.sort((a, b) => (a.from - b.from) || (a.to - b.to) || (a.key < b.key ? -1 : 1));
  }
  /** The latest log for a key on a day. */
  function logFor(doc, key, day) {
    let hit = null;
    for (const l of doc.logs || []) if (l.key === key && l.day === day && (!hit || l.at > hit.at)) hit = l;
    return hit;
  }
  function logsFor(doc, key, day) { return (doc.logs || []).filter((l) => l.key === key && l.day === day).sort((a, b) => a.at - b.at); }
  /** The board for the household's today: each pet's rows with their state.
   *  `done`, `now` (inside its window), `later`, `overdue` (past its window,
   *  not done). */
  function board(doc, nowMs) {
    const { day, min } = zoned(nowMs, doc.tz);
    const due = dueOnDay(doc, day);
    const pets = (doc.pets || []).map((p) => {
      const rows = due.filter((d) => d.pet === p.id).map((d) => {
        const log = logFor(doc, d.key, day);
        const times = logsFor(doc, d.key, day).length;
        const state = log ? 'done' : min > d.to ? 'overdue' : min >= d.from ? 'now' : 'later';
        return { ...d, log, times, state };
      });
      return { pet: p, rows, done: rows.filter((r) => r.log).length, total: rows.length, overdue: rows.filter((r) => r.state === 'overdue').length };
    });
    return { day, min, pets, done: pets.reduce((s, p) => s + p.done, 0), total: pets.reduce((s, p) => s + p.total, 0), overdue: pets.reduce((s, p) => s + p.overdue, 0) };
  }
  /** "Fed by Sam 7:42am", "Walked by Jo 5:10pm", "Done 7:42am" (a sitter's
   *  view does not carry the household's names). */
  function doneWords(row, tz) {
    const l = row.log;
    if (!l) return '';
    const verb = row.kind === 'dose' ? 'Given' : taskOf(row.task).done;
    return `${verb}${l.name ? ` by ${l.name}` : ''} ${clockOf(l.at, tz)}${row.times > 1 ? ` · ${row.times}×` : ''}`;
  }
  function windowWords(row) { return row.kind === 'dose' ? fmtTime(row.at) : `${fmtTime(row.from)}–${fmtTime(row.to)}`; }

  /** The double-done guard: has this already been done today, or in the
   *  last half hour (the 11:55pm feed is still "just now" at 12:05)? */
  function alreadyDone(doc, key, day, nowMs) {
    let hit = logFor(doc, key, day);
    for (const l of doc.logs || []) {
      if (l.key === key && nowMs - l.at < LIMITS.guardMin * MIN_MS && nowMs - l.at > -MIN_MS && (!hit || l.at > hit.at)) hit = l;
    }
    return hit;
  }

  /* ------------------------------------------------------------------ *
   * Health: due soon, records and weights
   * ------------------------------------------------------------------ */

  /** Everything coming due within `days` (and anything overdue), across the
   *  household: health records, and medicine courses ending in 3 days. */
  function dueSoon(doc, today, days) {
    const lim = days === undefined ? LIMITS.soonDays : days;
    const petName = (id) => ((doc.pets || []).find((p) => p.id === id) || {}).name || '';
    const out = [];
    for (const h of doc.health || []) {
      if (!h.due) continue;
      const n = daysBetween(today, h.due);
      if (n > lim || n < -365) continue;
      out.push({ kind: 'health', id: h.id, pet: h.pet, petName: petName(h.pet), type: h.type, emoji: healthOf(h.type).emoji, title: h.name, day: h.due, inDays: n, words: dueWords(n), overdue: n < 0 });
    }
    for (const m of doc.meds || []) {
      if (!m.until || m.start > today || m.until < today) continue;
      const n = daysBetween(today, m.until);
      if (n > 3) continue;
      out.push({ kind: 'med', id: m.id, pet: m.pet, petName: petName(m.pet), type: 'med', emoji: '💊', title: m.name, day: m.until, inDays: n, words: n === 0 ? 'Last day today' : `Course ends in ${plural(n, 'day')}`, overdue: false });
    }
    return out.sort((a, b) => (a.inDays - b.inDays) || (a.title < b.title ? -1 : 1));
  }
  function gramsFrom(value, unit) {
    const v = typeof value === 'number' ? value : Number(String(value || '').replace(/,/g, '.').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(v) || v <= 0) return null;
    const g = Math.round(unit === 'kg' ? v * 1000 : v * 453.59237);
    return g >= 10 && g <= 150000 ? g : null;
  }
  function fmtWeight(g, unit) {
    if (!Number.isFinite(g)) return '';
    if (unit === 'kg') return `${(g / 1000).toFixed(g < 10000 ? 2 : 1).replace(/\.?0+$/, '')} kg`;
    return `${(g / 453.59237).toFixed(1).replace(/\.0$/, '')} lb`;
  }
  function weightsOf(doc, petId) { return (doc.weights || []).filter((w) => w.pet === petId).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)); }
  /** Age in whole years and months, from a birthday. */
  function ageWords(birthday, today) {
    if (!isDay(birthday) || birthday > today) return '';
    const [by, bm, bd] = birthday.split('-').map(Number);
    const [ty, tm, td] = today.split('-').map(Number);
    let months = (ty - by) * 12 + (tm - bm) - (td < bd ? 1 : 0);
    if (months < 0) months = 0;
    if (months < 12) return plural(months, 'month');
    const y = Math.floor(months / 12);
    return plural(y, 'year');
  }

  /* ------------------------------------------------------------------ *
   * The week: what was done, streaks, who did what
   * ------------------------------------------------------------------ */

  const times = (n) => (n === 1 ? 'time' : 'times');
  const WEEK_WORDS = {
    feed: (d, n) => `Fed ${d} of ${n} ${n === 1 ? 'meal' : 'meals'}`,
    walk: (d, n) => `Walked ${d} of ${n} ${times(n)}`,
    litter: (d, n) => `Litter done ${d} of ${n} ${times(n)}`,
    water: (d, n) => `Water done ${d} of ${n} ${times(n)}`,
    clean: (d, n) => `Cleaned ${d} of ${n} ${times(n)}`,
    play: (d, n) => `Played ${d} of ${n} ${times(n)}`,
    meds: (d, n) => `${d} of ${n} ${n === 1 ? 'dose' : 'doses'} given`,
    other: (d, n) => `${d} of ${n} other ${n === 1 ? 'job' : 'jobs'} done`,
  };
  /** The seven days ending today for one pet. Today counts only what is
   *  done or already past its window, so the morning never looks like a
   *  failure. */
  function week(doc, petId, nowMs) {
    const { day: today, min } = zoned(nowMs, doc.tz);
    const days = [];
    const byTask = {};
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i);
      const due = dueOnDay(doc, d).filter((x) => x.pet === petId);
      let n = 0; let done = 0;
      for (const x of due) {
        const hit = Boolean(logFor(doc, x.key, d));
        if (d === today && !hit && min <= x.to) continue;
        n++; if (hit) done++;
        const t = byTask[x.task] || (byTask[x.task] = { task: x.task, due: 0, done: 0 });
        t.due++; if (hit) t.done++;
      }
      days.push({ day: d, due: n, done, all: due.length });
    }
    const lines = TASK_IDS.filter((t) => byTask[t] && byTask[t].due).map((t) => ({ ...byTask[t], words: WEEK_WORDS[t](byTask[t].done, byTask[t].due) }));
    return { days, lines, due: days.reduce((s, d) => s + d.due, 0), done: days.reduce((s, d) => s + d.done, 0), streak: streak(doc, petId, nowMs) };
  }
  /** Days in a row with everything done for this pet, ending yesterday (or
   *  today, once today is complete). A day with nothing due neither counts
   *  nor breaks it; nothing before the pet was added or the log was kept. */
  function streak(doc, petId, nowMs) {
    const { day: today } = zoned(nowMs, doc.tz);
    const pet = (doc.pets || []).find((p) => p.id === petId);
    const since = pet && pet.createdAt ? zoned(pet.createdAt, doc.tz).day : addDays(today, -LIMITS.logDays);
    const floor = since > addDays(today, -LIMITS.logDays) ? since : addDays(today, -LIMITS.logDays);
    const complete = (d) => {
      const due = dueOnDay(doc, d).filter((x) => x.pet === petId);
      if (!due.length) return null;
      return due.every((x) => logFor(doc, x.key, d));
    };
    let n = 0;
    let d = today;
    if (complete(today) !== true) d = addDays(today, -1);
    for (; d >= floor; d = addDays(d, -1)) {
      const c = complete(d);
      if (c === null) continue;
      if (!c) break;
      n++;
    }
    return { days: n, capped: n > 0 && d < floor };
  }
  /** Who did what in the last seven days: a gentle share, not a scoreboard. */
  function fairShare(doc, nowMs) {
    const { day: today } = zoned(nowMs, doc.tz);
    const from = addDays(today, -6);
    const counts = new Map();
    for (const l of doc.logs || []) {
      if (l.day < from || l.day > today) continue;
      const k = l.name || 'Someone';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    const rows = [...counts.entries()].map(([name, n]) => ({ name, n, pct: total ? Math.round((n / total) * 100) : 0 }));
    rows.sort((a, b) => (b.n - a.n) || (a.name < b.name ? -1 : 1));
    return { total, rows };
  }

  /* ------------------------------------------------------------------ *
   * Every change, as one function the phone and the server both run. The
   * server runs it inside a transaction; the phone on its own copy. `ctx`
   * is who is asking: {role: 'owner'|'member'|'sitter', sitter: {code, name}}.
   * `ids(prefix)` hands out fresh ids. Returns what the page needs to say.
   * ------------------------------------------------------------------ */

  const SITTER_ACTIONS = ['done', 'undo'];
  function petIds(doc) { return doc.pets.map((p) => p.id); }
  function need(cond, status, msg, extra) { if (!cond) throw fail(status, msg, extra); }
  function findIn(list, id, what) {
    const i = list.findIndex((x) => x.id === id);
    need(i >= 0, 404, `That ${what} isn’t here any more.`);
    return i;
  }
  function act(doc, ctx, action, a, nowMs, ids) {
    const role = (ctx && ctx.role) || 'owner';
    const args = a && typeof a === 'object' ? a : {};
    if (role === 'sitter') need(SITTER_ACTIONS.includes(action), 403, 'A sitter link can tick things off, nothing more.');
    const { day: today } = zoned(nowMs, doc.tz);
    const res = (() => {
      switch (action) {
        case 'done': return actDone(doc, ctx, args, nowMs, ids, today);
        case 'undo': {
          const i = (doc.logs || []).findIndex((l) => l.id === args.log);
          need(i >= 0, 404, 'That’s already been taken back.');
          const l = doc.logs[i];
          if (role === 'sitter') need(l.by === 'sitter' && l.link === ctx.sitter.code, 403, 'Only what you ticked can be taken back.');
          need(nowMs - l.at <= LIMITS.undoMin * MIN_MS, 409, `Too late to undo - it’s been more than ${LIMITS.undoMin} minutes.`);
          doc.logs.splice(i, 1);
          return { undone: l.id };
        }
        case 'join': {
          const name = firstName(args.name);
          need(name, 400, 'Add your first name.');
          const have = doc.members.find((m) => fold(m.name) === fold(name));
          if (have) return { member: have };
          need(doc.members.length < LIMITS.members, 409, `A household holds up to ${LIMITS.members} people.`);
          const m = { id: ids('m'), name };
          doc.members.push(m);
          return { member: m };
        }
        case 'rename': {
          need(role === 'owner' || args.id === args.by, 403, 'Only the owner can rename someone else.');
          const i = findIn(doc.members, args.id, 'person');
          const name = firstName(args.name);
          need(name, 400, 'Add a first name.');
          need(!doc.members.some((m, j) => j !== i && fold(m.name) === fold(name)), 409, `There’s already a ${name} in this household.`);
          doc.members[i].name = name;
          return { member: doc.members[i] };
        }
        case 'unjoin': {
          need(role === 'owner', 403, 'Only the owner can take someone out of the household.');
          const i = findIn(doc.members, args.id, 'person');
          doc.members.splice(i, 1);
          return { removed: args.id };
        }
        case 'home': {
          const name = cleanText(args.name, LIMITS.homeName);
          if (name) doc.name = name;
          if (args.tz !== undefined) { const tz = cleanTz(args.tz); need(tz, 400, 'That isn’t a time zone.'); doc.tz = tz; }
          if (UNITS.includes(args.units)) doc.units = args.units;
          return {};
        }
        case 'vet': {
          const phone = cleanPhone(args.phone);
          need(!args.phone || phone, 400, 'That doesn’t look like a phone number - digits, spaces and + ( ) - only.');
          doc.vet = { practice: cleanText(args.practice, LIMITS.practice), phone };
          return {};
        }
        case 'pet': return actPet(doc, args, nowMs, ids, today);
        case 'unpet': {
          const i = findIn(doc.pets, args.id, 'pet');
          const id = doc.pets[i].id;
          doc.pets.splice(i, 1);
          for (const k of ['items', 'meds', 'health', 'weights', 'logs']) doc[k] = doc[k].filter((x) => x.pet !== id);
          return { removed: id };
        }
        case 'item': {
          const isNew = !args.item || !doc.items.some((x) => x.id === args.item.id);
          need(!isNew || doc.items.length < LIMITS.items, 409, `That’s ${LIMITS.items} routine items - plenty. Remove one first.`);
          const it = cleanItem({ ...args.item, id: isNew ? ids('i') : args.item.id }, petIds(doc), today);
          need(it, 400, 'Pick the pet and a time for it.');
          if (isNew) doc.items.push(it); else doc.items[findIn(doc.items, it.id, 'routine item')] = it;
          return { item: it };
        }
        case 'unitem': { doc.items.splice(findIn(doc.items, args.id, 'routine item'), 1); return { removed: args.id }; }
        case 'med': {
          const isNew = !args.med || !doc.meds.some((x) => x.id === args.med.id);
          need(!isNew || doc.meds.length < LIMITS.meds, 409, `That’s ${LIMITS.meds} medicines - finish or remove one first.`);
          const m = cleanMed({ ...args.med, id: isNew ? ids('d') : args.med.id }, petIds(doc), today);
          need(m, 400, 'A medicine needs a name and a pet.');
          if (isNew) doc.meds.push(m); else doc.meds[findIn(doc.meds, m.id, 'medicine')] = m;
          return { med: m };
        }
        case 'stopmed': {
          const i = findIn(doc.meds, args.id, 'medicine');
          const m = doc.meds[i];
          m.until = m.start > today ? m.start : today;
          return { med: m };
        }
        case 'unmed': {
          const i = findIn(doc.meds, args.id, 'medicine');
          const id = doc.meds[i].id;
          doc.meds.splice(i, 1);
          doc.logs = doc.logs.filter((l) => !l.key.startsWith(`${id}@`));
          return { removed: id };
        }
        case 'health': {
          const isNew = !args.health || !doc.health.some((x) => x.id === args.health.id);
          need(!isNew || doc.health.length < LIMITS.health, 409, `That’s ${LIMITS.health} health records. Remove an old one first.`);
          const h = cleanHealth({ ...args.health, id: isNew ? ids('h') : args.health.id }, petIds(doc));
          need(h, 400, 'Add when it was given or when it’s due.');
          if (isNew) doc.health.push(h); else doc.health[findIn(doc.health, h.id, 'record')] = h;
          return { health: h };
        }
        case 'given': {
          const i = findIn(doc.health, args.id, 'record');
          const h = doc.health[i];
          const on = isDay(args.day) && args.day <= today ? args.day : today;
          h.given = on;
          h.due = h.everyMonths ? addMonths(on, h.everyMonths) : null;
          return { health: h };
        }
        case 'unhealth': { doc.health.splice(findIn(doc.health, args.id, 'record'), 1); return { removed: args.id }; }
        case 'weight': {
          need(doc.pets.some((p) => p.id === args.pet), 404, 'That pet isn’t here any more.');
          const g = Number.isInteger(args.g) ? args.g : gramsFrom(args.value, args.unit || doc.units);
          const w = cleanWeight({ id: ids('w'), pet: args.pet, day: isDay(args.day) ? args.day : today, g }, petIds(doc), today);
          need(w, 400, 'That weight doesn’t look right.');
          doc.weights = doc.weights.filter((x) => !(x.pet === w.pet && x.day === w.day));
          doc.weights.push(w);
          doc.weights.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
          const mine = doc.weights.filter((x) => x.pet === w.pet);
          if (mine.length > LIMITS.weights) { const drop = mine[0].id; doc.weights = doc.weights.filter((x) => x.id !== drop); }
          return { weight: w };
        }
        case 'unweight': { doc.weights.splice(findIn(doc.weights, args.id, 'weight'), 1); return { removed: args.id }; }
        default: throw fail(400, 'Unknown change.');
      }
    })();
    doc.logs = pruneLogs(doc.logs, today);
    doc.v = (doc.v || 0) + 1;
    return res;
  }
  function actDone(doc, ctx, args, nowMs, ids, today) {
    const day = args.day === undefined ? today : args.day;
    need(isDay(day) && (day === today || day === addDays(today, -1)), 400, 'Only today (or last night) can be ticked off.');
    const row = dueOnDay(doc, day).find((d) => d.key === args.key);
    need(row, 404, 'That isn’t on the list for today any more.');
    let by; let name; let link;
    if (ctx.role === 'sitter') { by = 'sitter'; name = firstName(ctx.sitter && ctx.sitter.name) || 'The sitter'; link = ctx.sitter && ctx.sitter.code; }
    else {
      const m = doc.members.find((x) => x.id === args.by);
      need(m, 400, 'Pick who you are first.', { code: 'who' });
      by = m.id; name = m.name;
    }
    const prev = alreadyDone(doc, row.key, day, nowMs);
    if (prev && args.again !== true) {
      const mine = prev.by === by;
      const when = clockOf(prev.at, doc.tz);
      const verb = row.kind === 'dose' ? 'given' : ({ feed: 'fed', walk: 'walked', clean: 'cleaned', play: 'played' }[row.task] || 'done');
      throw fail(409, `Already ${verb} by ${mine ? 'you' : prev.name} at ${when} - do it again?`,
        { code: 'already', by: prev.name, at: prev.at, when, mine, key: row.key, dose: row.kind === 'dose' });
    }
    const log = { id: ids('l'), key: row.key, pet: row.pet, day, at: nowMs, by, name };
    if (link) log.link = link;
    doc.logs.push(log);
    return { log, again: Boolean(prev) };
  }
  function actPet(doc, args, nowMs, ids, today) {
    const raw = args.pet && typeof args.pet === 'object' ? args.pet : {};
    const isNew = !doc.pets.some((p) => p.id === raw.id);
    need(!isNew || doc.pets.length < LIMITS.pets, 409, `A household holds up to ${LIMITS.pets} pets.`);
    const id = isNew ? ids('p') : raw.id;
    const old = isNew ? null : doc.pets.find((p) => p.id === id);
    const p = cleanPet({ ...raw, id, createdAt: old ? old.createdAt : nowMs }, today);
    need(p, 400, 'Give your pet a name.');
    if (isNew) {
      doc.pets.push(p);
      if (args.template !== false) {
        const room = LIMITS.items - doc.items.length;
        doc.items.push(...templateFor(p.kind, p.id, today, ids).slice(0, Math.max(0, room)));
      }
      const g = gramsFrom(args.weight, args.unit || doc.units);
      if (g) doc.weights.push({ id: ids('w'), pet: p.id, day: today, g });
    } else {
      doc.pets[doc.pets.findIndex((x) => x.id === id)] = p;
    }
    return { pet: p };
  }

  /* ------------------------------------------------------------------ *
   * What each link shows. Tested by exact keys.
   * ------------------------------------------------------------------ */

  /** Everyone in the household: all of it, except how the server checks
   *  the owner, counts devices, and the sitter links. */
  function memberView(doc) {
    return {
      v: doc.v, name: doc.name, tz: doc.tz, units: doc.units, link: doc.link || null,
      members: doc.members, pets: doc.pets, items: doc.items, meds: doc.meds, health: doc.health,
      weights: doc.weights, vet: doc.vet, logs: doc.logs, createdAt: doc.createdAt,
    };
  }
  /** The sitter: the pets, their notes, the routine and the medicines to
   *  give while the link is open, today's and yesterday's ticks (theirs by
   *  name, everyone else's as "done"), and the vet's practice name and
   *  phone. Never the household's names, health records, weights, birthdays
   *  or any link but their own. */
  function sitterView(doc, sitter, nowMs) {
    const { day: today } = zoned(nowMs, doc.tz);
    const pets = doc.pets.map((p) => ({ id: p.id, name: p.name, kind: p.kind, notes: p.notes }));
    const meds = doc.meds.filter((m) => !m.until || m.until >= addDays(today, -1)).filter((m) => m.start <= sitter.until)
      .map((m) => ({ id: m.id, pet: m.pet, name: m.name, dose: m.dose, times: m.times, repeat: m.repeat, start: m.start, until: m.until }));
    const logs = doc.logs.filter((l) => l.day >= addDays(today, -1)).map((l) => {
      const mine = l.by === 'sitter' && l.link === sitter.code;
      return { id: l.id, key: l.key, pet: l.pet, day: l.day, at: l.at, mine, name: mine ? l.name : '' };
    });
    return {
      v: doc.v, name: doc.name, tz: doc.tz, sitter: { name: sitter.name, until: sitter.until },
      pets, items: doc.items.map((i) => ({ id: i.id, pet: i.pet, task: i.task, label: i.label, from: i.from, to: i.to, repeat: i.repeat })),
      meds, logs, vet: { practice: doc.vet.practice, phone: doc.vet.phone },
    };
  }

  /* ------------------------------------------------------------------ *
   * The calendar file. Health due dates, the next vet visit and the last
   * day of a medicine course, as all-day events with a reminder a week
   * before (9am) and on the day. Nothing in the cloud writes a calendar:
   * the phone makes this file and the person opens it.
   * ------------------------------------------------------------------ */

  function icsText(v) {
    return String(v === null || v === undefined ? '' : v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  }
  function utf8Len(ch) { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  /** Lines folded at 75 octets (UTF-8), never inside a character. */
  function icsFold(line) {
    const out = [];
    let cur = ''; let bytes = 0;
    for (const ch of Array.from(line)) {
      const n = utf8Len(ch);
      if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  const compact = (day) => day.replace(/-/g, '');
  function stampOf(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  function alarm(n, what) {
    // Relative to the event's start, midnight of the day: n days before at
    // 9:00 is -(n-1) days and 15 hours; the day itself at 9:00 is +9 hours.
    const trig = n > 0 ? `-P${n - 1 ? `${n - 1}D` : ''}T15H` : 'PT9H';
    return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(what)}`, `TRIGGER:${trig}`, 'END:VALARM'];
  }
  /**
   * @param doc  a household (or one pet's part of it)
   * @param o    {today, nowMs, pet?}
   */
  function buildIcs(doc, o) {
    const stamp = stampOf(o.nowMs);
    const today = o.today;
    const pet = (id) => (doc.pets || []).find((p) => p.id === id);
    const vet = doc.vet && doc.vet.practice ? `Vet: ${doc.vet.practice}${doc.vet.phone ? `, ${doc.vet.phone}` : ''}` : '';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pawlog//Pet care//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(`Pet care - ${doc.name || 'Pawlog'}`)}`];
    const event = (uid, day, summary, desc, early, onDay) => {
      lines.push('BEGIN:VEVENT', `UID:${uid}@pawlog`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${compact(day)}`, `DTEND;VALUE=DATE:${compact(addDays(day, 1))}`,
        `SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(desc)}`, 'TRANSP:TRANSPARENT');
      if (early) lines.push(...alarm(7, early));
      lines.push(...alarm(0, onDay), 'END:VEVENT');
    };
    for (const h of doc.health || []) {
      const p = pet(h.pet);
      if (!p || !h.due || h.due < today || (o.pet && o.pet !== p.id)) continue;
      const t = healthOf(h.type);
      const what = h.type === 'visit' ? h.name : `${h.name} due`;
      event(`${h.id}-${compact(h.due)}`, h.due, `${kindOf(p.kind).emoji} ${p.name}: ${what}`,
        [h.given ? `Last given ${fmtDay(h.given, today)}.` : '', t.label + '.', vet, 'Tick it off in Pawlog when it’s done.'].filter(Boolean).join('\n'),
        daysBetween(today, h.due) > 7 ? `${possessive(p.name)} ${h.name} is due in a week - book it now.` : null,
        `${possessive(p.name)} ${h.name} is due today.`);
    }
    for (const m of doc.meds || []) {
      const p = pet(m.pet);
      if (!p || !m.until || m.until < today || (o.pet && o.pet !== p.id)) continue;
      event(`${m.id}-end-${compact(m.until)}`, m.until, `${kindOf(p.kind).emoji} ${p.name}: last day of ${m.name}`,
        [`${m.dose ? m.dose + ', ' : ''}${m.times.map(fmtTime).join(' and ')}.`, 'Finish the course unless the vet says otherwise.', vet].filter(Boolean).join('\n'),
        null, `Last day of ${possessive(p.name)} ${m.name}.`);
    }
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ *
   * Reading the model's proposal: a medicine schedule in words, and the
   * shapes a proposal may take. The server's lib/ai.js does the rest.
   * ------------------------------------------------------------------ */

  /** "twice daily" -> times and a repeat. Unknown words: once a day, 8am. */
  function parseSchedule(words) {
    const s = fold(words);
    const r = (every, n) => ({ every, n: n || 1 });
    if (/\b(?:three times|3 times|tid|t i d|every 8 hours|8 hourly)\b/.test(s)) return { times: [480, 840, 1320], repeat: r('day') };
    if (/\b(?:twice|two times|2 times|bid|b i d|every 12 hours|12 hourly|morning and (?:evening|night))\b/.test(s)) return { times: [480, 1200], repeat: r('day') };
    if (/\b(?:every other day|alternate days|eod)\b/.test(s)) return { times: [480], repeat: r('days', 2) };
    const nd = /\bevery (\d{1,2}) days\b/.exec(s);
    if (nd && Number(nd[1]) >= 2 && Number(nd[1]) <= 30) return { times: [480], repeat: r('days', Number(nd[1])) };
    if (/\b(?:weekly|once a week|every week)\b/.test(s)) return { times: [480], repeat: r('week') };
    if (/\b(?:monthly|once a month|every month)\b/.test(s)) return { times: [480], repeat: r('month') };
    if (/\b(?:evening|night|bedtime)\b/.test(s)) return { times: [1200], repeat: r('day') };
    return { times: [480], repeat: r('day') };
  }

  /* ------------------------------------------------------------------ *
   * The sample home: a made-up dog and cat, a household of three, today
   * half done, a medicine course, a vaccination due in 9 days and a week
   * of history - so every part of the app has something to show in one
   * tap. Every name and number is invented; the vet's number is a
   * 555-01xx fiction number.
   * ------------------------------------------------------------------ */

  function sample(nowMs, tz) {
    const zone = cleanTz(tz) || 'UTC';
    const { day: today } = zoned(nowMs, zone);
    let k = 0;
    const id = (p) => `sample-${p}${++k}`;
    const at = (day, m) => instantOf(day, Math.max(0, Math.min(1439, m)), zone);
    const members = [{ id: 'sample-sam', name: 'Sam' }, { id: 'sample-alex', name: 'Alex' }, { id: 'sample-priya', name: 'Priya' }];
    const created = nowMs - 220 * DAY_MS;
    const biscuit = { id: 'sample-biscuit', name: 'Biscuit', kind: 'dog', birthday: addMonths(today, -50), createdAt: created,
      notes: 'Give his pill hidden in a cube of cheese - he spits it out otherwise.\nNo grapes, raisins or chocolate.\nPulls towards squirrels: short lead in the park.' };
    const miso = { id: 'sample-miso', name: 'Miso', kind: 'cat', birthday: addMonths(today, -31), createdAt: created,
      notes: 'Shy with new people - she comes out after ten minutes.\nIndoor only: keep the patio door shut.' };
    const items = [
      ...templateFor('dog', biscuit.id, addDays(today, -200), () => id('i')),
      ...templateFor('cat', miso.id, addDays(today, -200), () => id('i')),
      { id: id('i'), pet: miso.id, task: 'clean', label: 'Change all the litter', from: 600, to: 1200, repeat: { every: 'week', n: 1, anchor: addDays(today, -4) } },
    ];
    const meds = [{ id: 'sample-drops', pet: biscuit.id, name: 'Ear drops', dose: '4 drops, left ear', times: [8 * 60, 20 * 60], repeat: { every: 'day', n: 1, anchor: addDays(today, -6) }, start: addDays(today, -6), until: addDays(today, 3) }];
    const health = [
      { id: 'sample-h1', pet: miso.id, type: 'vaccine', name: 'Cat flu booster', given: addMonths(addDays(today, 9), -12), due: addDays(today, 9), everyMonths: 12 },
      { id: 'sample-h2', pet: biscuit.id, type: 'flea', name: 'Flea & tick tablet', given: addDays(today, -20), due: addMonths(addDays(today, -20), 1), everyMonths: 1 },
      { id: 'sample-h3', pet: biscuit.id, type: 'vaccine', name: 'Rabies booster', given: addMonths(today, -7), due: addMonths(today, 5), everyMonths: 12 },
      { id: 'sample-h4', pet: biscuit.id, type: 'worm', name: 'Worming tablet', given: addDays(today, -61), due: addMonths(addDays(today, -61), 3), everyMonths: 3 },
      { id: 'sample-h5', pet: miso.id, type: 'flea', name: 'Spot-on flea treatment', given: addDays(today, -26), due: addMonths(addDays(today, -26), 1), everyMonths: 1 },
      { id: 'sample-h6', pet: biscuit.id, type: 'visit', name: 'Ear check with the vet', given: addDays(today, -6), due: addDays(today, 4), everyMonths: 0 },
    ];
    const kg = [11.9, 11.7, 11.6, 11.4, 11.3, 11.2];
    const weights = kg.map((v, i) => ({ id: `sample-w${i}`, pet: biscuit.id, day: addMonths(today, -(5 - i)), g: Math.round(v * 1000) }))
      .concat([4.1, 4.2, 4.2].map((v, i) => ({ id: `sample-wm${i}`, pet: miso.id, day: addMonths(today, -(4 - i * 2)), g: Math.round(v * 1000) })));
    const doc = { v: 1, name: 'The Hartley house', tz: zone, units: 'lb', members, pets: [biscuit, miso], items, meds, health, weights,
      vet: { practice: 'Fernhill Vets', phone: '(555) 010-4477' }, logs: [], createdAt: created, sample: true };
    // The last six days, nearly all done - one evening walk missed three
    // days ago, so the week reads "11 of 12" rather than a perfect score.
    const who = ['sample-sam', 'sample-alex', 'sample-priya'];
    const nameOf = (m) => members.find((x) => x.id === m).name;
    let w = 0;
    for (let i = 6; i >= 1; i--) {
      const d = addDays(today, -i);
      for (const row of dueOnDay(doc, d)) {
        if (i === 3 && /Evening walk/.test(row.label)) continue;
        const by = who[(w++ * 7 + i) % 3];
        doc.logs.push({ id: id('l'), key: row.key, pet: row.pet, day: d, at: at(d, row.from + 12 + ((w * 13) % 50)), by, name: nameOf(by) });
      }
    }
    // Today, about half done, at the natural time inside each window when
    // that is already past (Biscuit's breakfast by Alex at 7:42am), and
    // otherwise a little before now - so it is always before now. Miso was
    // fed by Sam, so a second tap shows the guard.
    const todays = dueOnDay(doc, today);
    const lastMidnight = at(today, 0);
    const tick = (pet, label, by, offset, mins) => {
      const row = todays.find((r) => r.pet === pet && r.label.startsWith(label));
      if (!row) return;
      const natural = at(today, row.from + offset);
      const when = natural <= nowMs - 2 * MIN_MS ? natural : Math.max(lastMidnight + MIN_MS, nowMs - mins * MIN_MS);
      doc.logs.push({ id: id('l'), key: row.key, pet, day: today, at: when, by, name: nameOf(by) });
    };
    tick(biscuit.id, 'Breakfast', 'sample-alex', 42, 95);
    tick(biscuit.id, 'Morning walk', 'sample-priya', 70, 70);
    tick(biscuit.id, 'Ear drops', 'sample-alex', 65, 60);
    tick(miso.id, 'Breakfast', 'sample-sam', 30, 12);
    return doc;
  }

  return {
    LIMITS, DAY_MS, KINDS, KIND_IDS, kindOf, TASKS, TASK_IDS, taskOf, HEALTH_TYPES, HEALTH_IDS, healthOf, TEMPLATES, UNITS, EVERY, MONTHS, WEEKDAYS,
    clean, cleanText, cleanNote, fold, fail, firstName, possessive, stripPrivate, hasContact, cleanPhone, telHref,
    isLeap, daysInMonth, isDay, dayMs, daysBetween, addDays, addMonths, weekday, fmtDay, relDay, plural, ordinal, dueWords,
    cleanTz, zoned, offsetMin, instantOf, fmtTime, clockOf, hhmm, parseHhmm, isId,
    cleanRepeat, dueOn, nextDue, repeatWords, templateFor,
    cleanPet, cleanItem, cleanMed, cleanHealth, cleanWeight, cleanMember, cleanLog, cleanHome, pruneLogs,
    medOn, medStatus, dueOnDay, logFor, logsFor, board, doneWords, windowWords, alreadyDone,
    dueSoon, gramsFrom, fmtWeight, weightsOf, ageWords,
    week, streak, fairShare,
    act, memberView, sitterView,
    icsText, icsFold, buildIcs, parseSchedule, sample,
  };
});
