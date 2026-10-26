/* Rep - the rules, in one file. Lift, log, beat last time.
 *
 * Run three times: by the page (window.RepCore), by the server and by the
 * tests (require). UMD, no dependencies, no clock and no dice of its own:
 * anything that needs "now" is handed it (a 'YYYY-MM-DD' day in the lifter's
 * own zone, or milliseconds), so the same log gives the same answers on
 * every phone and the tests can stand on any day they like.
 *
 * What is here:
 *   - cleaning: one door for every typed string (no markup, no control or
 *     bidi characters, bounded, cut on a whole character);
 *   - units: weights are stored in kilograms (to 0.1 g) and shown in the
 *     lifter's choice, kg or lb, so a value typed in either comes back exactly;
 *   - the exercise library (43 lifts by muscle group and equipment) and
 *     custom exercises;
 *   - a workout: exercises, sets (weight x reps, RPE, warm-up), cleaned;
 *   - progress: estimated 1RM (Epley), each lift's sessions, the "beat last
 *     time" suggestion (add weight, stay, or deload after a third miss), PRs
 *     (weight, reps at a weight, e1RM, volume), weekly sets per muscle group,
 *     the weekly streak and the calendar;
 *   - the rest timer, worked out from a start timestamp (so it survives a
 *     locked screen), and the plate calculator (exact, or the nearest weight
 *     below and above);
 *   - routines: the starter templates, saving your own, what comes next;
 *   - export and import (JSON and CSV), the AI plan's brief and its
 *     validation, and the sample month.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RepCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITS = {
    name: 40,            // a workout, routine or custom exercise name
    note: 200,           // a workout's note (never sent anywhere but your own account)
    workouts: 5000,      // workouts kept on one phone or in one account
    monthWorkouts: 120,  // workouts in one calendar month (a sync document)
    entries: 20,         // exercises in one workout
    sets: 20,            // sets of one exercise in one workout
    routines: 80,
    routineItems: 12,    // exercises in one routine
    exercises: 100,      // custom exercises
    maxKg: 1000,         // the heaviest weight anyone may type
    reps: 100,
    restMin: 15,
    restMax: 900,
    perWeekMax: 7,
    importBytes: 2000000,
    importRows: 20000,
    planDays: 6,
    planExercises: 8,
    planLifts: 16,       // lifts summarised for the AI plan
    mergeBatch: 150,     // workouts per sync request
  };
  const DAY_MS = 86400000;
  const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
  const CUSTOM_RE = /^c[a-z0-9]{5,24}$/;

  /* ------------------------------------------------------------------ *
   * Cleaning
   * ------------------------------------------------------------------ */

  // Control characters and the bidi overrides and isolates. The zero-width
  // joiner stays: emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁩﻿]/g;

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
  const URLISH = /\b(?:https?:\/\/|www\.)\S*|\b(?:javascript|data|vbscript|file|mailto|tel):\S*|\b[a-z0-9-]+\.(?:com|net|org|co|io|app|uk|de|ly)(?:\/\S*)?/gi;
  /** Model text: no links of any kind, then cleaned. */
  function noLinks(v, max) {
    if (typeof v !== 'string') return '';
    return cleanText(v.slice(0, max * 4 + 200).replace(URLISH, ' '), max);
  }
  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function fail(status, message, extra) {
    return Object.assign(new Error(message), { status, expose: true }, extra || {});
  }
  function intIn(v, lo, hi) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  /** A short stable hash (djb2, base 36) - for ids that must come out the
   *  same when the same file is imported twice. Not for secrets. */
  function hash(s) {
    let h = 5381;
    const str = String(s);
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    let h2 = 52711;
    for (let i = str.length - 1; i >= 0; i--) h2 = ((h2 * 33) ^ str.charCodeAt(i)) >>> 0;
    return (h.toString(36) + h2.toString(36)).padStart(10, '0');
  }

  /* ------------------------------------------------------------------ *
   * Calendar days. Every date is a civil 'YYYY-MM-DD' in the lifter's own
   * zone, written on the phone when the workout starts; the sums are done on
   * UTC midnights, so a daylight-saving change can never move a workout to
   * another day or miscount a week.
   * ------------------------------------------------------------------ */

  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function daysInMonth(y, m) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  function isDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    return y >= 1990 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }
  const dayMs = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / DAY_MS); }
  function addDays(day, n) { return fromMs(dayMs(day) + n * DAY_MS); }
  const pad = (n) => String(n).padStart(2, '0');
  function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
  /** The lifter's own day, from a Date, in their zone. */
  function localDay(date) { return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate()); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function weekday(day) { return new Date(dayMs(day)).getUTCDay(); }
  /** The Monday that starts this day's week. */
  function weekStart(day) { return addDays(day, -((weekday(day) + 6) % 7)); }
  /** "Oct 26", or "Oct 26, 2025" outside today's year. */
  function fmtDay(day, today) {
    if (!isDay(day)) return '';
    const [y, m, d] = day.split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}${today && today.slice(0, 4) !== String(y) ? `, ${y}` : ''}`;
  }
  /** "Today", "Yesterday", "Mon", or "Oct 12". */
  function fmtWhen(day, today) {
    if (!isDay(day) || !isDay(today)) return '';
    const n = daysBetween(day, today);
    if (n === 0) return 'Today';
    if (n === 1) return 'Yesterday';
    if (n > 1 && n < 7) return WEEKDAYS[weekday(day)];
    return fmtDay(day, today);
  }
  function monthOf(day) { return day.slice(0, 7); }

  /* ------------------------------------------------------------------ *
   * Units. A weight is stored in kilograms, rounded to 0.1 g: any value
   * typed in kg or lb with up to two decimals comes back exactly when shown
   * in the same unit again (tested over the whole range).
   * ------------------------------------------------------------------ */

  const UNITS = ['kg', 'lb'];
  const KG_PER_LB = 0.45359237;
  const r2 = (x) => Math.round(x * 100) / 100;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  function unitOf(u) { return u === 'lb' ? 'lb' : 'kg'; }
  function toKg(v, unit) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    return r4(unitOf(unit) === 'lb' ? n * KG_PER_LB : n);
  }
  function fromKg(kg, unit) { const n = Number(kg) || 0; return unitOf(unit) === 'lb' ? n / KG_PER_LB : n; }
  /** The number to show, in the lifter's unit, to two decimals. */
  function shown(kg, unit) { const v = r2(fromKg(kg, unit)); return v === 0 ? 0 : v; }
  function fmtNum(n) { const v = r2(Number(n) || 0); return String(v === 0 ? 0 : v); }
  function fmtW(kg, unit) { return `${fmtNum(shown(kg, unit))} ${unitOf(unit)}`; }
  /** An estimate (e1RM) to one decimal: "107.9 kg". */
  function fmtE(kg, unit) { const v = Math.round(fromKg(kg, unit) * 10) / 10; return `${v === 0 ? 0 : v} ${unitOf(unit)}`; }
  /** 12,340 - for volumes. */
  function fmtBig(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** A typed number: "82.5" or "82,5"; nothing else. */
  function parseNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.trim().replace(',', '.');
    if (!/^\d{1,5}(?:\.\d{1,3})?$/.test(s)) return null;
    return Number(s);
  }
  /** A typed weight in the lifter's unit -> kilograms, or null. */
  function parseWeight(v, unit) {
    const n = parseNum(v);
    if (n === null) return null;
    const kg = toKg(n, unit);
    return kg >= 0 && kg <= LIMITS.maxKg ? kg : null;
  }
  function roundTo(x, step) { return r2(Math.round(x / step) * step); }
  /** The smallest jump a loaded bar can make: a pair of 1.25 kg or 2.5 lb plates. */
  function stepOf(unit) { return unitOf(unit) === 'lb' ? 5 : 2.5; }
  const near = (a, b) => Math.abs(a - b) < 0.01;

  /* ------------------------------------------------------------------ *
   * The exercise library
   * ------------------------------------------------------------------ */

  const GROUPS = [
    { id: 'legs', label: 'Legs' }, { id: 'chest', label: 'Chest' }, { id: 'back', label: 'Back' },
    { id: 'shoulders', label: 'Shoulders' }, { id: 'arms', label: 'Arms' }, { id: 'core', label: 'Core' },
    { id: 'other', label: 'Other' },
  ];
  const GROUP_IDS = GROUPS.map((g) => g.id);
  const KINDS = [
    { id: 'barbell', label: 'Barbell' }, { id: 'dumbbell', label: 'Dumbbell' },
    { id: 'machine', label: 'Machine or cable' }, { id: 'bodyweight', label: 'Bodyweight' },
  ];
  const KIND_IDS = KINDS.map((k) => k.id);
  const DEFAULT_REST = { barbell: 150, dumbbell: 90, machine: 90, bodyweight: 90 };

  const L = (id, name, group, kind, rest) => ({ id, name, group, kind, rest });
  const LIBRARY = [
    L('squat', 'Back squat', 'legs', 'barbell', 180),
    L('front-squat', 'Front squat', 'legs', 'barbell', 180),
    L('deadlift', 'Deadlift', 'legs', 'barbell', 180),
    L('rdl', 'Romanian deadlift', 'legs', 'barbell', 150),
    L('hip-thrust', 'Hip thrust', 'legs', 'barbell', 120),
    L('leg-press', 'Leg press', 'legs', 'machine', 120),
    L('leg-curl', 'Leg curl', 'legs', 'machine', 75),
    L('leg-extension', 'Leg extension', 'legs', 'machine', 75),
    L('calf-raise', 'Calf raise', 'legs', 'machine', 60),
    L('goblet-squat', 'Goblet squat', 'legs', 'dumbbell', 90),
    L('lunge', 'Walking lunge', 'legs', 'dumbbell', 90),
    L('split-squat', 'Bulgarian split squat', 'legs', 'dumbbell', 90),
    L('air-squat', 'Air squat', 'legs', 'bodyweight', 60),
    L('bench', 'Bench press', 'chest', 'barbell', 180),
    L('incline-bench', 'Incline bench press', 'chest', 'barbell', 150),
    L('db-bench', 'Dumbbell bench press', 'chest', 'dumbbell', 120),
    L('incline-db', 'Incline dumbbell press', 'chest', 'dumbbell', 120),
    L('chest-fly', 'Chest fly', 'chest', 'machine', 60),
    L('push-up', 'Push-up', 'chest', 'bodyweight', 60),
    L('dips', 'Dips', 'chest', 'bodyweight', 90),
    L('row', 'Barbell row', 'back', 'barbell', 150),
    L('pull-up', 'Pull-up', 'back', 'bodyweight', 120),
    L('chin-up', 'Chin-up', 'back', 'bodyweight', 120),
    L('lat-pulldown', 'Lat pulldown', 'back', 'machine', 90),
    L('cable-row', 'Seated cable row', 'back', 'machine', 90),
    L('db-row', 'One-arm dumbbell row', 'back', 'dumbbell', 90),
    L('inverted-row', 'Inverted row', 'back', 'bodyweight', 60),
    L('face-pull', 'Face pull', 'back', 'machine', 60),
    L('ohp', 'Overhead press', 'shoulders', 'barbell', 150),
    L('db-press', 'Dumbbell shoulder press', 'shoulders', 'dumbbell', 90),
    L('lateral-raise', 'Lateral raise', 'shoulders', 'dumbbell', 60),
    L('rear-delt', 'Rear delt fly', 'shoulders', 'dumbbell', 60),
    L('shrug', 'Shrug', 'shoulders', 'dumbbell', 60),
    L('curl', 'Barbell curl', 'arms', 'barbell', 75),
    L('db-curl', 'Dumbbell curl', 'arms', 'dumbbell', 60),
    L('hammer-curl', 'Hammer curl', 'arms', 'dumbbell', 60),
    L('pushdown', 'Triceps pushdown', 'arms', 'machine', 60),
    L('skull-crusher', 'Skull crusher', 'arms', 'barbell', 75),
    L('close-grip', 'Close-grip bench press', 'arms', 'barbell', 120),
    L('leg-raise', 'Hanging leg raise', 'core', 'bodyweight', 60),
    L('ab-wheel', 'Ab wheel rollout', 'core', 'bodyweight', 60),
    L('cable-crunch', 'Cable crunch', 'core', 'machine', 60),
    L('back-extension', 'Back extension', 'core', 'bodyweight', 60),
  ];
  const LIB = {};
  LIBRARY.forEach((e) => { LIB[e.id] = e; });

  // Other names people (and other apps' exports) use, folded.
  const ALIASES = {
    squat: 'squat', 'squat barbell': 'squat', 'barbell squat': 'squat', 'back squat barbell': 'squat', 'front squat barbell': 'front-squat',
    bench: 'bench', 'bench press barbell': 'bench', 'barbell bench press': 'bench', 'flat bench press': 'bench',
    'bench press dumbbell': 'db-bench', 'incline bench press barbell': 'incline-bench', 'incline bench press dumbbell': 'incline-db',
    'deadlift barbell': 'deadlift', 'conventional deadlift': 'deadlift', 'romanian deadlift barbell': 'rdl', 'stiff leg deadlift': 'rdl',
    ohp: 'ohp', 'overhead press barbell': 'ohp', 'military press': 'ohp', 'standing press': 'ohp', 'strict press': 'ohp',
    'shoulder press dumbbell': 'db-press', 'overhead press dumbbell': 'db-press', 'seated dumbbell press': 'db-press',
    'bent over row barbell': 'row', 'bent over row': 'row', 'barbell bent over row': 'row', 'pendlay row': 'row',
    'pull up': 'pull-up', pullup: 'pull-up', 'chin up': 'chin-up', chinup: 'chin-up',
    'lat pulldown cable': 'lat-pulldown', 'lat pulldown machine': 'lat-pulldown', 'seated row cable': 'cable-row', 'cable row': 'cable-row',
    'dumbbell row': 'db-row', 'bicep curl barbell': 'curl', 'biceps curl barbell': 'curl', 'bicep curl dumbbell': 'db-curl', 'biceps curl dumbbell': 'db-curl', 'bicep curl': 'db-curl',
    'hammer curl dumbbell': 'hammer-curl', 'triceps pushdown cable': 'pushdown', 'tricep pushdown': 'pushdown', 'tricep pushdown cable': 'pushdown',
    'skullcrusher barbell': 'skull-crusher', 'skullcrusher': 'skull-crusher', 'close grip bench press barbell': 'close-grip',
    'leg press machine': 'leg-press', 'leg curl machine': 'leg-curl', 'lying leg curl machine': 'leg-curl', 'seated leg curl machine': 'leg-curl',
    'leg extension machine': 'leg-extension', 'calf raise machine': 'calf-raise', 'standing calf raise': 'calf-raise',
    'lunge dumbbell': 'lunge', lunge: 'lunge', 'hip thrust barbell': 'hip-thrust', 'goblet squat kettlebell': 'goblet-squat',
    'lateral raise dumbbell': 'lateral-raise', 'side lateral raise': 'lateral-raise', 'rear delt fly dumbbell': 'rear-delt',
    'shrug dumbbell': 'shrug', 'shrug barbell': 'shrug', 'chest fly machine': 'chest-fly', 'chest fly cable': 'chest-fly', 'pec deck': 'chest-fly',
    'face pull cable': 'face-pull', 'push up': 'push-up', pushup: 'push-up', dip: 'dips', 'chest dip': 'dips', 'triceps dip': 'dips',
    'hanging leg raise': 'leg-raise', 'ab wheel': 'ab-wheel', 'cable crunch': 'cable-crunch', 'back extension': 'back-extension', hyperextension: 'back-extension',
  };
  const NAME_INDEX = {};
  LIBRARY.forEach((e) => { NAME_INDEX[fold(e.name)] = e.id; NAME_INDEX[fold(e.id)] = e.id; });
  const KIND_WORDS = /\b(barbell|dumbbell|dumbbells|machine|cable|bodyweight|smith machine|kettlebell|ez bar)\b/g;

  /** A library id for a name someone typed (or another app exported), or null. */
  function matchExercise(name) {
    if (typeof name !== 'string') return null;
    if (LIB[name]) return name;
    const f = fold(name.replace(/[()]/g, ' '));
    if (!f) return null;
    if (NAME_INDEX[f]) return NAME_INDEX[f];
    if (ALIASES[f]) return ALIASES[f];
    const bare = f.replace(KIND_WORDS, ' ').replace(/\s+/g, ' ').trim();
    return NAME_INDEX[bare] || ALIASES[bare] || null;
  }
  function guessKind(name) {
    const f = fold(name);
    if (/\bbarbell|\bbar\b|ez bar/.test(f)) return 'barbell';
    if (/dumbbell|kettlebell/.test(f)) return 'dumbbell';
    if (/machine|cable|smith|pulldown|press machine/.test(f)) return 'machine';
    if (/bodyweight|push ?up|pull ?up|chin ?up|dip|plank|burpee/.test(f)) return 'bodyweight';
    return 'machine';
  }
  function guessGroup(name) {
    const f = fold(name);
    if (/squat|lunge|leg|calf|hip|glute|deadlift|step up/.test(f)) return 'legs';
    if (/bench|chest|fly|pec|push ?up|dip/.test(f)) return 'chest';
    if (/row|pull|chin|lat|back/.test(f)) return 'back';
    if (/shoulder|overhead|lateral|delt|shrug|press/.test(f)) return 'shoulders';
    if (/curl|tricep|bicep|skull|arm/.test(f)) return 'arms';
    if (/\babs?\b|core|crunch|plank|twist|sit ?up/.test(f)) return 'core';
    return 'other';
  }
  function cleanRest(v) {
    const n = typeof v === 'number' ? Math.round(v) : NaN;
    return Number.isFinite(n) && n >= LIMITS.restMin && n <= LIMITS.restMax ? n : null;
  }
  /** A custom exercise, cleaned. */
  function cleanExercise(raw) {
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (typeof b.id !== 'string' || !CUSTOM_RE.test(b.id)) return null;
    const name = cleanText(b.name, LIMITS.name);
    if (!name) return null;
    const kind = KIND_IDS.includes(b.kind) ? b.kind : 'machine';
    const group = GROUP_IDS.includes(b.group) ? b.group : 'other';
    const out = { id: b.id, name, group, kind, rest: cleanRest(b.rest) || DEFAULT_REST[kind], custom: true };
    if (Number(b.updatedAt) > 0) out.updatedAt = Math.round(Number(b.updatedAt));
    return out;
  }
  const UNKNOWN = { id: 'unknown', name: 'Exercise', group: 'other', kind: 'machine', rest: 90 };
  /** The exercise for an id: the library's, or one of the lifter's own. */
  function exerciseOf(id, custom) {
    if (LIB[id]) return LIB[id];
    if (custom && Object.prototype.hasOwnProperty.call(custom, id) && custom[id]) return custom[id];
    return null;
  }
  function knownId(id, custom) { return Boolean(exerciseOf(id, custom)); }
  /** The rest for an exercise: the lifter's own choice for it, else its default. */
  function restOf(ex, settings) {
    const own = settings && settings.rest && Object.prototype.hasOwnProperty.call(settings.rest, ex.id) ? cleanRest(settings.rest[ex.id]) : null;
    return own || ex.rest || DEFAULT_REST[ex.kind] || 90;
  }
  /** How much to add when every rep was done: lower-body barbell and machine
   *  lifts 5 kg / 10 lb, everything else 2.5 kg / 5 lb. */
  function incrementOf(ex, unit) {
    const lb = unitOf(unit) === 'lb';
    const big = (ex.kind === 'barbell' || ex.kind === 'machine') && ex.group === 'legs';
    return big ? (lb ? 10 : 5) : (lb ? 5 : 2.5);
  }

  /* ------------------------------------------------------------------ *
   * Settings (kept on the phone)
   * ------------------------------------------------------------------ */

  const PLATES = { kg: [25, 20, 15, 10, 5, 2.5, 2, 1.25, 1, 0.5, 0.25], lb: [55, 45, 35, 25, 15, 10, 5, 2.5, 1.25] };
  const PLATE_DEFAULTS = {
    kg: { 25: 8, 20: 8, 15: 8, 10: 8, 5: 8, 2.5: 8, 1.25: 8 },
    lb: { 45: 10, 35: 8, 25: 8, 10: 8, 5: 8, 2.5: 8 },
  };
  const BARS = { kg: [20, 15, 10], lb: [45, 35, 15] };

  function cleanPlates(raw, unit) {
    const u = unitOf(unit);
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : PLATE_DEFAULTS[u];
    const out = {};
    PLATES[u].forEach((s) => { const n = intIn(src[String(s)], 0, 20); if (n) out[String(s)] = n; });
    return out;
  }
  function cleanBar(v, unit) {
    const n = typeof v === 'number' ? v : parseNum(v);
    const max = unitOf(unit) === 'lb' ? 220 : 100;
    return Number.isFinite(n) && n >= 0 && n <= max ? r2(n) : BARS[unitOf(unit)][0];
  }
  function defaultSettings(unit) {
    return { unit: unitOf(unit), bar: { kg: 20, lb: 45 }, plates: { kg: cleanPlates(null, 'kg'), lb: cleanPlates(null, 'lb') }, perWeek: 3, rest: {}, autoRest: true, sound: true, vibrate: true };
  }
  function cleanSettings(raw, fallbackUnit) {
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = defaultSettings(UNITS.includes(b.unit) ? b.unit : fallbackUnit);
    const bar = b.bar && typeof b.bar === 'object' ? b.bar : {};
    out.bar = { kg: cleanBar(bar.kg, 'kg'), lb: cleanBar(bar.lb, 'lb') };
    const pl = b.plates && typeof b.plates === 'object' ? b.plates : {};
    out.plates = { kg: cleanPlates(pl.kg, 'kg'), lb: cleanPlates(pl.lb, 'lb') };
    out.perWeek = intIn(b.perWeek, 1, LIMITS.perWeekMax) || 3;
    const rest = b.rest && typeof b.rest === 'object' && !Array.isArray(b.rest) ? b.rest : {};
    Object.keys(rest).slice(0, 200).forEach((k) => { if ((LIB[k] || CUSTOM_RE.test(k)) && cleanRest(rest[k])) out.rest[k] = cleanRest(rest[k]); });
    ['autoRest', 'sound', 'vibrate'].forEach((k) => { if (typeof b[k] === 'boolean') out[k] = b[k]; });
    // The routine to offer next, when the lifter chose one (a saved plan, a
    // program to follow); otherwise "what comes next" is worked out.
    if (typeof b.upNext === 'string' && ID_RE.test(b.upNext)) out.upNext = b.upNext;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * A workout
   * ------------------------------------------------------------------ */

  function cleanRpe(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n >= 5 && n <= 10 && Math.round(n * 2) === n * 2 ? n : null;
  }
  /** One set: weight in kg, reps, an optional RPE, warm-up or not. In a
   *  workout still under way a planned set may have no weight yet, and
   *  carries `done`. */
  function cleanSet(raw, active) {
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!b) return null;
    const w = typeof b.w === 'number' && Number.isFinite(b.w) && b.w >= 0 && b.w <= LIMITS.maxKg ? r4(b.w) : null;
    const r = intIn(b.r, 0, LIMITS.reps);
    const done = active ? b.done === true : true;
    if (r === null || (w === null && done)) return null;
    const out = { w, r, rpe: cleanRpe(b.rpe), warm: b.warm === true };
    if (active) out.done = done;
    if (Number(b.at) > 0 && Number(b.at) < 4102444800000) out.at = Math.round(Number(b.at));
    return out;
  }
  function cleanGoal(g) {
    if (!g || typeof g !== 'object') return null;
    const sets = intIn(g.sets, 1, 10), reps = intIn(g.reps, 1, 50);
    return sets && reps ? { sets, reps } : null;
  }
  function cleanEntry(raw, custom, active) {
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!b || typeof b.ex !== 'string' || !(LIB[b.ex] || CUSTOM_RE.test(b.ex))) return null;
    if (custom && !knownId(b.ex, custom)) return null;
    const sets = (Array.isArray(b.sets) ? b.sets.slice(0, LIMITS.sets) : []).map((s) => cleanSet(s, active)).filter(Boolean);
    if (!active && !sets.length) return null;
    const out = { id: typeof b.id === 'string' && ID_RE.test(b.id) ? b.id : `e${hash(JSON.stringify([b.ex, sets.length])).slice(0, 8)}`, ex: b.ex, goal: cleanGoal(b.goal), rest: cleanRest(b.rest), sets };
    const pct = intIn(b.pct, 30, 100);
    if (pct) out.pct = pct;
    return out;
  }
  const TIME_MAX = 4102444800000; // 2100
  /**
   * A workout, cleaned. `opts`:
   *   today       the lifter's day: a workout dated after tomorrow is refused
   *   custom      their custom exercises; an entry for any other id is dropped
   *   active      a workout still under way (planned sets, a rest timer)
   *   keepSample  keep the sample flag (the page only - never the server)
   */
  function cleanWorkout(raw, opts) {
    const o = opts || {};
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!b || typeof b.id !== 'string' || !ID_RE.test(b.id) || !isDay(b.day)) return null;
    if (o.today && isDay(o.today) && b.day > addDays(o.today, 1)) return null;
    const entries = (Array.isArray(b.entries) ? b.entries.slice(0, LIMITS.entries) : []).map((e) => cleanEntry(e, o.custom, o.active)).filter(Boolean);
    if (!o.active && !entries.length) return null;
    const startedAt = Number(b.startedAt) > 0 && Number(b.startedAt) < TIME_MAX ? Math.round(Number(b.startedAt)) : dayMs(b.day) + 12 * 3600000;
    const endedAt = Number(b.endedAt) >= startedAt && Number(b.endedAt) < TIME_MAX ? Math.round(Number(b.endedAt)) : null;
    const out = {
      id: b.id, day: b.day, startedAt, endedAt,
      name: cleanText(b.name, LIMITS.name) || 'Workout',
      routineId: typeof b.routineId === 'string' && ID_RE.test(b.routineId) ? b.routineId : null,
      program: cleanText(b.program, LIMITS.name) || null,
      note: cleanText(b.note, LIMITS.note),
      entries,
      updatedAt: Number(b.updatedAt) > 0 && Number(b.updatedAt) < TIME_MAX ? Math.round(Number(b.updatedAt)) : startedAt,
    };
    if (o.keepSample && b.sample === true) out.sample = true;
    if (o.active) {
      const t = b.rest && typeof b.rest === 'object' ? b.rest : null;
      out.rest = t && Number(t.start) > 0 && cleanRest(t.secs) ? { start: Math.round(Number(t.start)), secs: cleanRest(t.secs), ex: typeof t.ex === 'string' ? t.ex.slice(0, 40) : '', alerted: t.alerted === true } : null;
      const c = b.cur && typeof b.cur === 'object' ? b.cur : {};
      out.cur = { e: intIn(c.e, 0, LIMITS.entries) || 0, s: intIn(c.s, 0, LIMITS.sets) || 0 };
    }
    return out;
  }
  const SAVED_FIELDS = ['id', 'day', 'startedAt', 'endedAt', 'name', 'routineId', 'program', 'note', 'entries', 'updatedAt'];
  /** What leaves the phone: the workout's own fields, never the sample flag. */
  function toSaved(w) { const out = {}; SAVED_FIELDS.forEach((k) => { out[k] = w[k]; }); return out; }
  function byTime(a, b) {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  /** Finish a workout under way: only the sets that were logged are kept. */
  function finish(active, nowMs) {
    const entries = (active.entries || []).map((e) => ({ id: e.id, ex: e.ex, goal: e.goal, rest: e.rest, sets: e.sets.filter((s) => s.done && s.w !== null).map((s) => { const o = { w: s.w, r: s.r, rpe: s.rpe, warm: s.warm }; if (s.at) o.at = s.at; return o; }) })).filter((e) => e.sets.length);
    if (!entries.length) return null;
    return { id: active.id, day: active.day, startedAt: active.startedAt, endedAt: Math.max(active.startedAt, nowMs), name: active.name, routineId: active.routineId, program: active.program, note: active.note || '', entries, updatedAt: nowMs };
  }
  /** Newer copy wins, by id; what only one side has is kept. */
  function mergeById(mine, theirs) {
    const map = {};
    (mine || []).forEach((x) => { map[x.id] = x; });
    (theirs || []).forEach((x) => { const have = map[x.id]; if (!have || Number(x.updatedAt || 0) > Number(have.updatedAt || 0)) map[x.id] = x; });
    return Object.keys(map).map((k) => map[k]);
  }

  /* ------------------------------------------------------------------ *
   * Progress: e1RM, sessions, "beat last time", PRs
   * ------------------------------------------------------------------ */

  /** Estimated one-rep max, Epley: w x (1 + reps / 30). A single is itself;
   *  over 15 reps the estimate means little, so there is none. */
  function e1rm(w, r) {
    if (!(w > 0) || !Number.isInteger(r) || r < 1 || r > 15) return null;
    return r === 1 ? r4(w) : r4(w * (1 + r / 30));
  }
  function working(sets) { return (sets || []).filter((s) => s && !s.warm && s.done !== false && typeof s.w === 'number'); }

  /** One exercise in one workout, summed up. "Done" means every set at the
   *  top weight reached the goal: the routine's reps, or else the reps of the
   *  first set at that weight (what you went for). */
  function summarize(w, sets, goal, ex) {
    const bw = ex && ex.kind === 'bodyweight';
    const topW = Math.max.apply(null, sets.map((s) => s.w));
    const atTop = sets.filter((s) => near(s.w, topW));
    const goalReps = goal ? goal.reps : atTop[0].r;
    const goalSets = goal ? goal.sets : atTop.length;
    const done = goalReps >= 1 && atTop.length >= goalSets && atTop.every((s) => s.r >= goalReps);
    let best = null;
    if (!bw) sets.forEach((s) => { const e = e1rm(s.w, s.r); if (e && (!best || e > best.e)) best = { e, w: s.w, r: s.r }; });
    const volume = sets.reduce((t, s) => t + (bw ? s.r : s.w * s.r), 0);
    const maxReps = Math.max.apply(null, sets.map((s) => s.r));
    return {
      day: w.day, at: w.startedAt, workoutId: w.id, sets, topW, reps: atTop.map((s) => s.r), goalReps, goalSets, done,
      e1rm: best ? best.e : null, best: best ? { w: best.w, r: best.r } : { w: topW, r: Math.max.apply(null, atTop.map((s) => s.r)) },
      volume: r2(volume), maxReps, topRpe: atTop[atTop.length - 1].rpe,
    };
  }
  /** Every session of one exercise, oldest first. `before` (a workout) keeps
   *  only the sessions before it. */
  function sessionsOf(workouts, exId, ex, before) {
    const out = [];
    (workouts || []).slice().sort(byTime).forEach((w) => {
      if (before && (w.id === before.id || byTime(w, before) >= 0)) return;
      let sets = [];
      let goal = null;
      (w.entries || []).forEach((e) => { if (e.ex !== exId) return; sets = sets.concat(working(e.sets)); if (!goal && e.goal) goal = e.goal; });
      if (sets.length) out.push(summarize(w, sets, goal, ex));
    });
    return out;
  }
  /** "3x5", or "5, 5, 4" when the sets differ. */
  function scheme(s) { return s.reps.every((r) => r === s.reps[0]) ? `${s.reps.length}x${s.reps[0]}` : s.reps.join(', '); }
  /** The best e1RM since a day (or ever). */
  function bestE1rm(sessions, since) {
    let best = null;
    (sessions || []).forEach((s) => { if (s.e1rm && (!since || s.day >= since) && (!best || s.e1rm > best)) best = s.e1rm; });
    return best;
  }

  /**
   * "Beat last time": what to put on the bar next, from the last session.
   *   - every rep done: add the increment ("try 82.5 kg") - unless the top
   *     set was RPE 9.5 or 10, then repeat it once;
   *   - reps missed: stay at the weight; a second miss says a third means a
   *     deload; the third miss in a row at the same weight: deload 10%,
   *     rounded to what the bar can make;
   *   - bodyweight with no added weight: add a rep, or stay.
   */
  function suggest(sessions, ex, unit) {
    const u = unitOf(unit);
    if (!ex) return null;
    if (!sessions || !sessions.length) {
      return { kind: 'first', text: ex.kind === 'bodyweight' ? 'First time - see how many good reps you have in you.' : 'First time - pick a weight you could lift for two more reps.', w: null, reps: null, sets: null };
    }
    const last = sessions[sessions.length - 1];
    const sch = scheme(last);
    const short = last.reps.length < last.goalSets;
    const missed = short ? `${plural(last.reps.length, 'set')} of ${last.goalSets}` : last.reps.join(', ');
    const base = { reps: last.goalReps, sets: last.goalSets, last };
    if (ex.kind === 'bodyweight' && last.topW < 0.01) {
      if (last.done) return Object.assign({}, base, { kind: 'reps', text: `Last time ${sch}, all reps done - try ${last.goalSets}x${Math.min(50, last.goalReps + 1)}`, w: 0, reps: Math.min(50, last.goalReps + 1) });
      return Object.assign({}, base, { kind: 'stay', text: `Missed reps last time (${missed}) - stay at ${last.goalSets}x${last.goalReps}`, w: 0 });
    }
    const W = shown(last.topW, u);
    const step = stepOf(u);
    const unitS = ` ${u}`;
    if (last.done) {
      if (last.topRpe !== null && last.topRpe >= 9.5) {
        return Object.assign({}, base, { kind: 'repeat', text: `All reps at ${fmtNum(W)}${unitS}, but at RPE ${fmtNum(last.topRpe)} - repeat ${fmtNum(W)}${unitS} before adding weight`, w: last.topW });
      }
      let next = roundTo(W + incrementOf(ex, u), step);
      if (next <= W) next = r2(next + step);
      return Object.assign({}, base, { kind: 'up', text: `Last time ${sch} at ${fmtNum(W)}${unitS}, all reps done - try ${fmtNum(next)}${unitS}`, w: toKg(next, u) });
    }
    let misses = 0;
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i];
      if (s.done || !near(s.topW, last.topW)) break;
      misses++;
    }
    if (misses >= 3) {
      let d = roundTo(W * 0.9, step);
      if (d >= W) d = r2(W - step);
      if (d < 0) d = 0;
      const nth = misses === 3 ? 'Third miss in a row' : `${misses} misses in a row`;
      return Object.assign({}, base, { kind: 'deload', misses, text: `${nth} at ${fmtNum(W)}${unitS} - deload to ${fmtNum(d)}${unitS} and build back up`, w: toKg(d, u) });
    }
    if (misses === 2) return Object.assign({}, base, { kind: 'stay', misses, text: `Missed reps twice at ${fmtNum(W)}${unitS} - stay there; a third miss means a deload`, w: last.topW });
    return Object.assign({}, base, { kind: 'stay', misses, text: `Missed reps last time (${missed} at ${fmtNum(W)}${unitS}) - stay at ${fmtNum(W)}${unitS}`, w: last.topW });
  }

  // Records: everything logged before, so a new set can be measured against it.
  const wkey = (kg) => String(Math.round(kg * 100));
  function emptyRecords() { return { any: false, w: 0, e1rm: 0, vol: 0, reps: {} }; }
  function addToRecords(rec, s, ex) {
    if (!s || s.warm || typeof s.w !== 'number' || !(s.r >= 1)) return rec;
    rec.any = true;
    if (s.w > rec.w) rec.w = s.w;
    const k = wkey(s.w);
    if (!(k in rec.reps) || s.r > rec.reps[k]) rec.reps[k] = s.r;
    const e = ex.kind === 'bodyweight' ? null : e1rm(s.w, s.r);
    if (e && e > rec.e1rm) rec.e1rm = e;
    return rec;
  }
  function recordsOf(sessions, ex) {
    const rec = emptyRecords();
    (sessions || []).forEach((s) => { s.sets.forEach((x) => addToRecords(rec, x, ex)); if (s.volume > rec.vol) rec.vol = s.volume; });
    return rec;
  }
  function weightWords(kg, ex, unit) { return ex.kind === 'bodyweight' ? (kg < 0.01 ? 'bodyweight' : `+${fmtW(kg, unit)}`) : fmtW(kg, unit); }
  /** The PRs one set sets against the records (nothing for a first-ever set:
   *  there is nothing to beat yet). */
  function setPrs(rec, s, ex, unit) {
    if (!rec || !rec.any || !s || s.warm || typeof s.w !== 'number' || !(s.r >= 1)) return [];
    const out = [];
    if (s.w > rec.w + 0.005) {
      out.push({ type: 'weight', title: 'Heaviest ever', text: `${weightWords(s.w, ex, unit)} × ${s.r} (was ${weightWords(rec.w, ex, unit)})` });
    } else {
      const k = wkey(s.w);
      if (k in rec.reps && s.r > rec.reps[k]) out.push({ type: 'reps', title: `Most reps at ${weightWords(s.w, ex, unit)}`, text: `${s.r} reps (was ${rec.reps[k]})` });
    }
    const e = ex.kind === 'bodyweight' ? null : e1rm(s.w, s.r);
    if (e && rec.e1rm > 0 && e > rec.e1rm + 0.005) out.push({ type: 'e1rm', title: 'Best estimated 1RM', text: `${fmtE(e, unit)} (was ${fmtE(rec.e1rm, unit)})` });
    return out;
  }
  /** A whole session's PRs against everything before it. */
  function sessionPrs(prior, session, ex, unit) {
    const rec = Array.isArray(prior) ? recordsOf(prior, ex) : prior;
    if (!rec.any) return [];
    const out = [];
    const sets = session.sets.filter((s) => !s.warm && s.r >= 1);
    if (!sets.length) return [];
    const top = sets.reduce((a, s) => (s.w > a.w + 0.005 || (near(s.w, a.w) && s.r > a.r) ? s : a), sets[0]);
    if (top.w > rec.w + 0.005) out.push({ type: 'weight', title: 'Heaviest ever', text: `${weightWords(top.w, ex, unit)} × ${top.r} (was ${weightWords(rec.w, ex, unit)})` });
    const atW = {};
    sets.forEach((s) => { const k = wkey(s.w); if (!atW[k] || s.r > atW[k].r) atW[k] = s; });
    const repPr = Object.keys(atW).map((k) => atW[k]).filter((s) => (wkey(s.w) in rec.reps) && s.r > rec.reps[wkey(s.w)]).sort((a, b) => b.w - a.w)[0];
    if (repPr && !(near(repPr.w, top.w) && out.length)) out.push({ type: 'reps', title: `Most reps at ${weightWords(repPr.w, ex, unit)}`, text: `${repPr.r} reps (was ${rec.reps[wkey(repPr.w)]})` });
    if (session.e1rm && rec.e1rm > 0 && session.e1rm > rec.e1rm + 0.005) out.push({ type: 'e1rm', title: 'Best estimated 1RM', text: `${fmtE(session.e1rm, unit)} (was ${fmtE(rec.e1rm, unit)})` });
    if (rec.vol > 0 && session.volume > rec.vol + 0.005) out.push({ type: 'volume', title: 'Most volume', text: ex.kind === 'bodyweight' ? `${fmtBig(session.volume)} reps (was ${fmtBig(rec.vol)})` : `${fmtBig(shown(session.volume, unit))} ${unitOf(unit)} (was ${fmtBig(shown(rec.vol, unit))} ${unitOf(unit)})` });
    return out;
  }
  /** Every session of a lift with the PRs it set, oldest first - one pass,
   *  for the chart and the PR list. */
  function timeline(workouts, exId, custom, unit) {
    const ex = exerciseOf(exId, custom);
    if (!ex) return [];
    const sessions = sessionsOf(workouts, exId, ex);
    const rec = emptyRecords();
    return sessions.map((s) => {
      const prs = sessionPrs(rec, s, ex, unit);
      s.sets.forEach((x) => addToRecords(rec, x, ex));
      if (s.volume > rec.vol) rec.vol = s.volume;
      return Object.assign({}, s, { prs });
    });
  }
  /** The PRs a workout set, lift by lift. */
  function workoutPrs(workouts, workout, custom, unit) {
    const out = [];
    const seen = {};
    (workout.entries || []).forEach((e) => {
      if (seen[e.ex]) return;
      seen[e.ex] = true;
      const ex = exerciseOf(e.ex, custom);
      if (!ex) return;
      const mine = sessionsOf([workout], e.ex, ex)[0];
      if (!mine) return;
      const prs = sessionPrs(sessionsOf(workouts, e.ex, ex, workout), mine, ex, unit);
      if (prs.length) out.push({ ex: e.ex, name: ex.name, prs });
    });
    return out;
  }
  /** The lifts with any history, most recently trained first. */
  function liftsOf(workouts, custom) {
    const last = {};
    const count = {};
    (workouts || []).forEach((w) => (w.entries || []).forEach((e) => {
      if (!working(e.sets).length || !exerciseOf(e.ex, custom)) return;
      count[e.ex] = (count[e.ex] || 0) + 1;
      if (!last[e.ex] || last[e.ex] < w.day) last[e.ex] = w.day;
    }));
    return Object.keys(last).sort((a, b) => (last[a] < last[b] ? 1 : last[a] > last[b] ? -1 : count[b] - count[a]));
  }

  /* ------------------------------------------------------------------ *
   * Weeks: sets per muscle group, the streak, the calendar
   * ------------------------------------------------------------------ */

  /** Working sets and volume per muscle group for each of the last `weeks`
   *  weeks (Monday to Sunday), oldest first. */
  function groupWeeks(workouts, custom, today, weeks) {
    const n = weeks || 4;
    const start = addDays(weekStart(today), -7 * (n - 1));
    const rows = [];
    for (let i = 0; i < n; i++) rows.push({ start: addDays(start, 7 * i), workouts: 0, sets: {}, volume: {} });
    (workouts || []).forEach((w) => {
      if (!isDay(w.day) || w.day < start) return;
      const i = Math.floor(daysBetween(start, w.day) / 7);
      if (i < 0 || i >= n) return;
      rows[i].workouts++;
      (w.entries || []).forEach((e) => {
        const ex = exerciseOf(e.ex, custom);
        const g = ex ? ex.group : 'other';
        const ws = working(e.sets);
        if (!ws.length) return;
        rows[i].sets[g] = (rows[i].sets[g] || 0) + ws.length;
        rows[i].volume[g] = r2((rows[i].volume[g] || 0) + ws.reduce((t, s) => t + s.w * s.r, 0));
      });
    });
    return rows;
  }
  /**
   * The weekly streak: weeks in a row (Monday to Sunday) with at least
   * `perWeek` workouts. This week counts once it is met, and does not break
   * the streak until it is over (`pending`).
   */
  function streak(workouts, today, perWeek) {
    const goal = intIn(perWeek, 1, LIMITS.perWeekMax) || 3;
    const counts = {};
    (workouts || []).forEach((w) => { if (!isDay(w.day) || w.day > today) return; const k = weekStart(w.day); counts[k] = (counts[k] || 0) + 1; });
    const thisWeek = weekStart(today);
    const met = (k) => (counts[k] || 0) >= goal;
    let current = met(thisWeek) ? 1 : 0;
    for (let k = addDays(thisWeek, -7); met(k); k = addDays(k, -7)) current++;
    const keys = Object.keys(counts).sort();
    let best = 0;
    if (keys.length) {
      let run = 0;
      for (let d = keys[0]; d <= thisWeek; d = addDays(d, 7)) { run = met(d) ? run + 1 : 0; if (run > best) best = run; }
    }
    const done = counts[thisWeek] || 0;
    return { current, best: Math.max(best, current), thisWeek: done, goal, pending: !met(thisWeek), left: Math.max(0, goal - done), daysLeft: 7 - ((weekday(today) + 6) % 7) };
  }
  /** The last `weeks` weeks, a column per week, a row per weekday. */
  function calendar(workouts, today, weeks) {
    const n = weeks || 12;
    const start = addDays(weekStart(today), -7 * (n - 1));
    const per = {};
    (workouts || []).forEach((w) => { if (isDay(w.day)) per[w.day] = (per[w.day] || 0) + 1; });
    const cols = [];
    for (let i = 0; i < n; i++) {
      const days = [];
      for (let j = 0; j < 7; j++) { const d = addDays(start, i * 7 + j); days.push({ day: d, n: per[d] || 0, future: d > today, today: d === today }); }
      cols.push({ start: addDays(start, i * 7), days });
    }
    return cols;
  }

  /* ------------------------------------------------------------------ *
   * The rest timer: a start timestamp and a length, nothing that ticks. A
   * phone that locks for two minutes comes back to the right number.
   * ------------------------------------------------------------------ */

  /** Whole seconds left (rounded up), never below 0 or above the length. */
  function restLeft(startMs, secs, nowMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(secs) || secs <= 0) return 0;
    const left = startMs + secs * 1000 - nowMs;
    if (left <= 0) return 0;
    return Math.min(secs, Math.ceil(left / 1000));
  }
  /** How far through the rest, 0 to 1. */
  function restDone(startMs, secs, nowMs) {
    if (!Number.isFinite(startMs) || !(secs > 0)) return 1;
    return Math.max(0, Math.min(1, (nowMs - startMs) / (secs * 1000)));
  }
  /** Add or take away seconds; taking away more than is left ends it. */
  function restAdjust(timer, delta, nowMs) {
    if (!timer) return null;
    const elapsed = Math.max(0, (nowMs - timer.start) / 1000);
    const secs = Math.min(LIMITS.restMax, Math.max(0, timer.secs + delta));
    if (secs <= elapsed) return Object.assign({}, timer, { secs: Math.max(1, Math.ceil(elapsed)), ended: true });
    return Object.assign({}, timer, { secs: Math.round(secs) });
  }
  /** "1:30", "12:05", "1:02:09". */
  function fmtClock(s) {
    const t = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  /* ------------------------------------------------------------------ *
   * The plate calculator
   * ------------------------------------------------------------------ */

  function gcd(a, b) { return b ? gcd(b, a % b) : a; }
  /**
   * The plates per side for a target on a bar, from the plates you have
   * (`counts`: pairs of each size). Worked in hundredths, so 1.25 is exact.
   * Exact when it can be made; otherwise the nearest weight below and above
   * that can. Heaviest plates first, the way you load them.
   *   {unit, target, bar, exact, total, perSide, below, above, why}
   *   why: 'under' (less than the bar), 'between' (no exact match),
   *        'heavy' (more than your plates make)
   */
  function plateMath(target, bar, counts, unit) {
    const u = unitOf(unit);
    const res = { unit: u, target: r2(Number(target) || 0), bar: r2(Number(bar) || 0), exact: false, total: null, perSide: [], below: null, above: null, why: null };
    if (!(Number(target) >= 0) || !(Number(bar) >= 0) || Number(target) > 5000) { res.why = 'bad'; return res; }
    const H = (x) => Math.round(x * 100);
    const sizes = PLATES[u].filter((s) => counts && intIn(counts[String(s)], 1, 20)).map((s) => ({ s, h: H(s), n: intIn(counts[String(s)], 1, 20) }));
    const T = H(target), B = H(bar);
    if (T < B) { res.why = 'under'; res.above = { total: res.bar, perSide: [] }; return res; }
    if (T === B) { res.exact = true; res.total = res.bar; return res; }
    const g = sizes.reduce((a, x) => gcd(a, x.h), 0) || 1;
    const maxU = sizes.reduce((t, x) => t + x.n * (x.h / g), 0);
    // reach[i][v]: v (in units of g) can be made per side from sizes[i..].
    const reach = new Array(sizes.length + 1);
    reach[sizes.length] = new Uint8Array(maxU + 1);
    reach[sizes.length][0] = 1;
    for (let i = sizes.length - 1; i >= 0; i--) {
      const prev = reach[i + 1], cur = new Uint8Array(maxU + 1), step = sizes[i].h / g;
      for (let v = 0; v <= maxU; v++) {
        if (!prev[v]) continue;
        for (let k = 0; k <= sizes[i].n && v + k * step <= maxU; k++) cur[v + k * step] = 1;
      }
      reach[i] = cur;
    }
    // Heaviest first: as many of each size as still leaves the rest makeable.
    const build = (side) => {
      const out = [];
      let rem = side;
      for (let i = 0; i < sizes.length; i++) {
        const step = sizes[i].h / g;
        for (let k = Math.min(sizes[i].n, Math.floor(rem / step)); k >= 0; k--) {
          if (reach[i + 1][rem - k * step]) { for (let j = 0; j < k; j++) out.push(sizes[i].s); rem -= k * step; break; }
        }
      }
      return out;
    };
    const want = (T - B) / 2 / g;
    const all = reach[0];
    const totalOf = (v) => r2((B + 2 * v * g) / 100);
    if (Number.isInteger(want) && want <= maxU && all[want]) { res.exact = true; res.total = totalOf(want); res.perSide = build(want); return res; }
    let lo = Math.min(maxU, Math.floor(want));
    while (lo >= 0 && !all[lo]) lo--;
    let hi = Math.ceil(want);
    while (hi <= maxU && !all[hi]) hi++;
    if (lo >= 0) res.below = { total: totalOf(lo), perSide: build(lo) };
    if (hi <= maxU) res.above = { total: totalOf(hi), perSide: build(hi) };
    res.why = want > maxU ? 'heavy' : 'between';
    return res;
  }
  /** "20 + 10 + 2.5" */
  function platesText(list) { return list.length ? list.map(fmtNum).join(' + ') : 'nothing - just the bar'; }

  /* ------------------------------------------------------------------ *
   * Routines
   * ------------------------------------------------------------------ */

  const S = (id, name, items) => ({ id, name, items });
  const STARTERS = [
    { id: 'starter-fb', name: 'Beginner full body', perWeek: 3, blurb: 'Three days a week, alternating A and B. Simple and steady: add weight when every rep is done.', routines: [
      S('starter-fb-a', 'Full body A', [['squat', 3, 5], ['bench', 3, 5], ['row', 3, 8], ['db-curl', 2, 12]]),
      S('starter-fb-b', 'Full body B', [['squat', 3, 5], ['ohp', 3, 5], ['deadlift', 1, 5], ['pull-up', 3, 8]]),
    ] },
    { id: 'starter-ppl', name: 'Push / Pull / Legs', perWeek: 3, blurb: 'Three days in order - or each twice for six. More sets per muscle, for size as well as strength.', routines: [
      S('starter-ppl-push', 'Push', [['bench', 4, 6], ['ohp', 3, 8], ['incline-db', 3, 10], ['lateral-raise', 3, 12], ['pushdown', 3, 12]]),
      S('starter-ppl-pull', 'Pull', [['row', 4, 6], ['pull-up', 3, 8], ['lat-pulldown', 3, 10], ['face-pull', 3, 15], ['db-curl', 3, 12]]),
      S('starter-ppl-legs', 'Legs', [['squat', 4, 6], ['rdl', 3, 8], ['leg-press', 3, 10], ['leg-curl', 3, 12], ['calf-raise', 3, 15]]),
    ] },
    { id: 'starter-5x5', name: '5x5 strength', perWeek: 3, blurb: 'Three days a week, alternating A and B. Five heavy sets of five on the big lifts, and little else.', routines: [
      S('starter-5x5-a', '5x5 A', [['squat', 5, 5], ['bench', 5, 5], ['row', 5, 5]]),
      S('starter-5x5-b', '5x5 B', [['squat', 5, 5], ['ohp', 5, 5], ['deadlift', 1, 5]]),
    ] },
  ];
  const STARTER_ROUTINES = [];
  STARTERS.forEach((p) => p.routines.forEach((r, i) => STARTER_ROUTINES.push({
    id: r.id, name: r.name, program: p.name, order: i, builtIn: true, from: 'starter',
    exercises: r.items.map(([ex, sets, reps]) => ({ ex, sets, reps, rest: null, pct: null, w: null })),
  })));
  function cleanRoutine(raw, custom) {
    const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!b || typeof b.id !== 'string' || !ID_RE.test(b.id) || /^starter-/.test(b.id)) return null;
    const name = cleanText(b.name, LIMITS.name);
    if (!name) return null;
    const exercises = (Array.isArray(b.exercises) ? b.exercises.slice(0, LIMITS.routineItems) : []).map((x) => {
      if (!x || typeof x !== 'object' || typeof x.ex !== 'string' || !(LIB[x.ex] || CUSTOM_RE.test(x.ex))) return null;
      if (custom && !knownId(x.ex, custom)) return null;
      const sets = intIn(x.sets, 1, 10), reps = intIn(x.reps, 1, 50);
      if (!sets || !reps) return null;
      const w = typeof x.w === 'number' && Number.isFinite(x.w) && x.w >= 0 && x.w <= LIMITS.maxKg ? r4(x.w) : null;
      return { ex: x.ex, sets, reps, rest: cleanRest(x.rest), pct: intIn(x.pct, 30, 100), w };
    }).filter(Boolean);
    if (!exercises.length) return null;
    const out = { id: b.id, name, program: cleanText(b.program, LIMITS.name) || null, week: intIn(b.week, 1, 8), order: intIn(b.order, 0, 999) || 0, from: ['me', 'ai'].includes(b.from) ? b.from : 'me', exercises };
    out.updatedAt = Number(b.updatedAt) > 0 && Number(b.updatedAt) < TIME_MAX ? Math.round(Number(b.updatedAt)) : 0;
    return out;
  }
  /** A finished workout as a routine of your own. */
  function routineFromWorkout(w, id, nowMs) {
    const exercises = (w.entries || []).map((e) => {
      const ws = working(e.sets);
      if (!ws.length) return null;
      const top = Math.max.apply(null, ws.map((s) => s.w));
      const atTop = ws.filter((s) => near(s.w, top));
      return { ex: e.ex, sets: Math.min(10, (e.goal && e.goal.sets) || atTop.length), reps: Math.min(50, Math.max(1, (e.goal && e.goal.reps) || atTop[0].r)), rest: e.rest || null, pct: null, w: null };
    }).filter(Boolean).slice(0, LIMITS.routineItems);
    return { id, name: w.name || 'My routine', program: null, week: null, order: 0, from: 'me', exercises, updatedAt: nowMs };
  }
  function routineById(id, routines) { return STARTER_ROUTINES.concat(routines || []).find((r) => r.id === id) || null; }
  /** What comes next: the routine after the one you did last, in its program. */
  function nextUp(workouts, routines) {
    const all = STARTER_ROUTINES.concat(routines || []);
    const last = (workouts || []).slice().sort(byTime).reverse().find((w) => w.routineId && all.some((r) => r.id === w.routineId));
    if (!last) return null;
    const r = all.find((x) => x.id === last.routineId);
    if (!r.program) return r;
    const prog = all.filter((x) => x.program === r.program && Boolean(x.builtIn) === Boolean(r.builtIn))
      .sort((a, b) => ((a.week || 0) - (b.week || 0)) || ((a.order || 0) - (b.order || 0)));
    const i = prog.findIndex((x) => x.id === r.id);
    return prog[(i + 1) % prog.length];
  }
  /** The sets you did last time for a lift, in order - drawn greyed beside
   *  today's as the target to beat. */
  function lastSets(workouts, exId, ex, before) {
    const s = sessionsOf(workouts, exId, ex, before);
    return s.length ? s[s.length - 1].sets : [];
  }
  /**
   * A routine as a workout under way: every set planned, with the weight
   * from its plan (a % of your best e1RM in the last 8 weeks, or a number),
   * else from "beat last time", else blank to pick.
   *   ctx: {workouts, custom, settings, today, nowMs, id(prefix)}
   */
  function draftEntry(item, ctx) {
    const unit = ctx.settings.unit;
    const ex = exerciseOf(item.ex, ctx.custom);
    if (!ex) return null;
    const sessions = sessionsOf(ctx.workouts, item.ex, ex);
    const sug = suggest(sessions, ex, unit);
    let w = null;
    let reps = item.reps || (sug && sug.reps) || (ex.kind === 'barbell' ? 5 : 10);
    const sets = item.sets || (sug && sug.sets) || 3;
    if (item.pct) {
      const best = bestE1rm(sessions, addDays(ctx.today, -56));
      if (best) w = toKg(roundTo(shown(best, unit) * item.pct / 100, stepOf(unit)), unit);
    }
    if (w === null && typeof item.w === 'number') w = item.w;
    if (w === null && sug && sug.kind !== 'first') w = sug.w;
    if (sug && sug.kind === 'reps' && !item.pct) reps = Math.max(reps, sug.reps);
    if (w === null && ex.kind === 'bodyweight') w = 0;
    const planned = [];
    for (let i = 0; i < sets; i++) planned.push({ w, r: reps, rpe: null, warm: false, done: false });
    // Only a routine sets a goal. An exercise added on the fly is judged on
    // what was actually done (the first set's reps, every set at the top
    // weight), not on a default someone never chose.
    const goal = item.sets && item.reps ? { sets, reps } : null;
    const out = { id: ctx.id('e'), ex: item.ex, goal, rest: item.rest || null, sets: planned };
    if (item.pct) out.pct = item.pct;
    return out;
  }
  function draftWorkout(routine, ctx) {
    const entries = routine ? routine.exercises.map((it) => draftEntry(it, ctx)).filter(Boolean) : [];
    return {
      id: ctx.id('w'), day: ctx.today, startedAt: ctx.nowMs, endedAt: null,
      name: routine ? routine.name : 'Workout', routineId: routine ? routine.id : null, program: routine ? routine.program || null : null,
      note: '', entries, updatedAt: ctx.nowMs, rest: null, cur: { e: 0, s: 0 },
    };
  }

  /* ------------------------------------------------------------------ *
   * Export and import
   * ------------------------------------------------------------------ */

  function exportJson(data, unit) {
    return JSON.stringify({
      app: 'rep', version: 1, unit: unitOf(unit),
      workouts: (data.workouts || []).filter((w) => !w.sample).slice().sort(byTime).map(toSaved),
      routines: (data.routines || []).filter((r) => !r.builtIn),
      exercises: Object.keys(data.custom || {}).map((k) => data.custom[k]),
    }, null, 1);
  }
  /** A Rep export, checked: every workout, routine and exercise cleaned the
   *  same way the app cleans its own. What could not be read is counted. */
  function importJson(text, opts) {
    const o = opts || {};
    if (typeof text !== 'string' || !text.trim()) throw fail(400, 'That file is empty.');
    if (text.length > LIMITS.importBytes) throw fail(413, 'That file is too big to bring in (2 MB at most).');
    let j;
    try { j = JSON.parse(text); } catch (e) { throw fail(400, 'That isn’t a Rep export - it isn’t JSON.'); }
    if (!j || typeof j !== 'object' || j.app !== 'rep' || !Array.isArray(j.workouts)) throw fail(400, 'That isn’t a Rep export.');
    const custom = {};
    (Array.isArray(j.exercises) ? j.exercises.slice(0, LIMITS.exercises) : []).forEach((x) => { const e = cleanExercise(x); if (e) custom[e.id] = e; });
    const both = Object.assign({}, o.custom || {}, custom);
    let skipped = 0;
    const workouts = [];
    j.workouts.slice(0, LIMITS.workouts).forEach((w) => { const c = cleanWorkout(w, { today: o.today, custom: both }); if (c) workouts.push(c); else skipped++; });
    skipped += Math.max(0, j.workouts.length - LIMITS.workouts);
    const routines = [];
    (Array.isArray(j.routines) ? j.routines.slice(0, LIMITS.routines) : []).forEach((r) => { const c = cleanRoutine(r, both); if (c) routines.push(c); else skipped++; });
    return { workouts, routines, custom, skipped, unit: unitOf(j.unit) };
  }
  const CSV_HEAD = ['Date', 'Workout', 'Exercise', 'Set', 'Weight', 'Unit', 'Reps', 'RPE', 'Warm-up'];
  /** One CSV cell: quoted when it must be, and never read as a formula by a
   *  spreadsheet (a leading = + - @ gets a quote mark). */
  function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  function exportCsv(workouts, custom, unit) {
    const u = unitOf(unit);
    const lines = [CSV_HEAD.join(',')];
    (workouts || []).filter((w) => !w.sample).slice().sort(byTime).forEach((w) => (w.entries || []).forEach((e) => {
      const ex = exerciseOf(e.ex, custom);
      e.sets.forEach((s, i) => lines.push([w.day, w.name, ex ? ex.name : e.ex, i + 1, fmtNum(shown(s.w, u)), u, s.r, s.rpe === null ? '' : s.rpe, s.warm ? 'yes' : ''].map(csvCell).join(',')));
    }));
    return lines.join('\r\n') + '\r\n';
  }
  /** RFC 4180 rows: quoted fields, doubled quotes, CRLF or LF. Bounded. */
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
        continue;
      }
      if (c === '"' && cell === '') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((x) => x.trim() !== '')) rows.push(row);
        row = [];
        if (rows.length > LIMITS.importRows + 1) break;
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row); }
    return rows;
  }
  const COLS = {
    date: ['date', 'day'], workout: ['workout', 'workout name', 'name'], exercise: ['exercise', 'exercise name'],
    set: ['set', 'set order', 'set number'], weight: ['weight', 'weight kg', 'weight lb', 'weight lbs', 'weight kgs', 'load'],
    unit: ['unit', 'units', 'weight unit'], reps: ['reps', 'repetitions'], rpe: ['rpe'], warm: ['warm up', 'warmup', 'warm up set'],
  };
  /**
   * A CSV of sets - Rep's own, or another app's with the usual columns (Date,
   * Exercise, Weight, Reps; a "Workout Name" and "Set Order" are understood
   * too). Exercises are matched to the library by name; anything else
   * becomes a custom exercise. Ids come from the date, workout and exercise,
   * so bringing the same file in twice adds nothing.
   */
  function importCsv(text, opts) {
    const o = opts || {};
    if (typeof text !== 'string' || !text.trim()) throw fail(400, 'That file is empty.');
    if (text.length > LIMITS.importBytes) throw fail(413, 'That file is too big to bring in (2 MB at most).');
    const rows = parseCsv(text.replace(/^﻿/, ''));
    if (rows.length < 2) throw fail(400, 'That CSV has no sets in it.');
    if (rows.length > LIMITS.importRows + 1) throw fail(413, `That CSV has more than ${LIMITS.importRows} rows.`);
    const head = rows[0].map((h) => fold(h));
    const col = {};
    Object.keys(COLS).forEach((k) => { col[k] = head.findIndex((h) => COLS[k].includes(h)); });
    if (col.date < 0 || col.exercise < 0 || col.reps < 0) throw fail(400, 'That CSV needs Date, Exercise and Reps columns.');
    const headUnit = col.weight >= 0 && /\blbs?\b/.test(head[col.weight]) ? 'lb' : col.weight >= 0 && /\bkgs?\b/.test(head[col.weight]) ? 'kg' : null;
    const defUnit = unitOf(o.unit);
    const today = o.today;
    const known = Object.assign({}, o.custom || {});
    const custom = {};
    const byKey = {};
    const order = [];
    let skipped = 0;
    rows.slice(1).forEach((r) => {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(r[col.date] || '').trim());
      const day = m && isDay(m[1]) && (!today || m[1] <= addDays(today, 1)) ? m[1] : null;
      const exName = cleanText(r[col.exercise], LIMITS.name);
      const reps = intIn(String(r[col.reps] || '').trim().replace(/\.0+$/, ''), 0, LIMITS.reps);
      if (!day || !exName || reps === null || reps < 1) { skipped++; return; }
      let exId = matchExercise(exName);
      if (!exId) {
        const found = Object.keys(known).find((k) => fold(known[k].name) === fold(exName)) || Object.keys(custom).find((k) => fold(custom[k].name) === fold(exName));
        exId = found || `c${hash(fold(exName)).slice(0, 12)}`;
        if (!found) custom[exId] = { id: exId, name: exName, group: guessGroup(exName), kind: guessKind(exName), rest: DEFAULT_REST[guessKind(exName)], custom: true };
      }
      const rawW = col.weight >= 0 ? String(r[col.weight] || '').trim() : '';
      const n = rawW === '' ? 0 : parseNum(rawW);
      const unitCell = col.unit >= 0 ? fold(r[col.unit]) : '';
      const u = /^lbs?$/.test(unitCell) ? 'lb' : /^kgs?$/.test(unitCell) ? 'kg' : headUnit || defUnit;
      const w = n === null ? null : toKg(n, u);
      if (w === null || w > LIMITS.maxKg) { skipped++; return; }
      const wName = cleanText(col.workout >= 0 ? r[col.workout] : '', LIMITS.name) || 'Workout';
      const key = `${day}|${fold(wName)}`;
      if (!byKey[key]) { byKey[key] = { id: `imp${hash(key)}`, day, startedAt: dayMs(day) + 12 * 3600000 + order.length, endedAt: null, name: wName, routineId: null, program: null, note: '', entries: [], updatedAt: 1 }; order.push(key); }
      const wk = byKey[key];
      let e = wk.entries.find((x) => x.ex === exId);
      if (!e) {
        if (wk.entries.length >= LIMITS.entries) { skipped++; return; }
        e = { id: `e${hash(key + exId).slice(0, 10)}`, ex: exId, goal: null, rest: null, sets: [] };
        wk.entries.push(e);
      }
      if (e.sets.length >= LIMITS.sets) { skipped++; return; }
      const warm = col.warm >= 0 && /^(yes|y|true|1|w|warm ?up)$/i.test(String(r[col.warm] || '').trim());
      e.sets.push({ w, r: reps, rpe: col.rpe >= 0 ? cleanRpe(String(r[col.rpe] || '').trim() || null) : null, warm });
    });
    const all = Object.assign({}, known, custom);
    const workouts = order.map((k) => cleanWorkout(byKey[k], { today, custom: all })).filter(Boolean).slice(0, LIMITS.workouts);
    if (!workouts.length) throw fail(400, 'No sets could be read from that CSV. Each row needs a date (2026-10-26), an exercise and reps.');
    return { workouts, routines: [], custom, skipped, unit: defUnit };
  }

  /* ------------------------------------------------------------------ *
   * "Plan my next 4 weeks" - what may be sent, and what may come back
   * ------------------------------------------------------------------ */

  const GOALS = [
    { id: 'strength', label: 'Strength', hint: 'heavier, fewer reps' },
    { id: 'size', label: 'Size', hint: 'more sets, 8-12 reps' },
    { id: 'general', label: 'General', hint: 'a bit of both' },
  ];
  const GOAL_IDS = GOALS.map((g) => g.id);
  /** The brief, built on the phone: the goal, days, equipment and a compact
   *  summary of recent training. No name, no notes, no dates of birth - the
   *  person is not in it at all. */
  function planBrief(workouts, custom, today, unit, choice) {
    const u = unitOf(unit);
    const since = addDays(today, -56);
    const recent = (workouts || []).filter((w) => w.day >= since && w.day <= today);
    const lifts = liftsOf(recent, custom).slice(0, LIMITS.planLifts).map((id) => {
      const ex = exerciseOf(id, custom);
      const sessions = sessionsOf(recent, id, ex);
      const last = sessions[sessions.length - 1];
      const sug = suggest(sessions, ex, u);
      const best = sessions.reduce((a, s) => (!a || (s.e1rm || 0) > (a.e1rm || 0) || (!s.e1rm && !a.e1rm && s.maxReps > a.maxReps) ? s : a), null);
      return {
        ex: LIB[id] ? id : ex.name, kind: ex.kind, sessions: sessions.length,
        best: { w: shown(best.best.w, u), r: best.best.r },
        e1rm: bestE1rm(sessions) ? shown(bestE1rm(sessions), u) : null,
        last: { w: shown(last.topW, u), sets: last.reps.length, reps: last.goalReps, done: last.done },
        misses: sug && sug.misses ? sug.misses : 0,
      };
    });
    const c = choice || {};
    return { goal: c.goal, days: c.days, equipment: c.equipment, unit: u, lifts };
  }
  /** The brief as the server reads it (and the page, to show what is sent):
   *  only these fields, each bounded. A 400 here costs nothing. */
  function cleanBrief(input) {
    const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const goal = GOAL_IDS.includes(b.goal) ? b.goal : null;
    const days = intIn(b.days, 2, LIMITS.planDays);
    const equipment = Array.isArray(b.equipment) ? KIND_IDS.filter((k) => b.equipment.includes(k)) : [];
    if (!goal || !days || !equipment.length) throw fail(400, 'Pick a goal, how many days a week, and your equipment first.');
    const unit = unitOf(b.unit);
    const max = shown(LIMITS.maxKg, unit);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? r2(v) : null);
    const lifts = [];
    (Array.isArray(b.lifts) ? b.lifts.slice(0, LIMITS.planLifts) : []).forEach((x) => {
      if (!x || typeof x !== 'object') return;
      const id = typeof x.ex === 'string' && LIB[x.ex] ? x.ex : null;
      const name = id ? LIB[id].name : noLinks(x.ex, LIMITS.name);
      if (!name) return;
      const best = x.best && typeof x.best === 'object' ? x.best : {};
      const last = x.last && typeof x.last === 'object' ? x.last : {};
      lifts.push({
        ex: id || name, custom: !id, kind: id ? LIB[id].kind : (KIND_IDS.includes(x.kind) ? x.kind : 'machine'),
        sessions: intIn(x.sessions, 0, 60) || 0,
        best: { w: num(best.w), r: intIn(best.r, 1, 50) },
        e1rm: num(x.e1rm),
        last: { w: num(last.w), sets: intIn(last.sets, 1, 20), reps: intIn(last.reps, 1, 50), done: last.done === true },
        misses: intIn(x.misses, 0, 20) || 0,
      });
    });
    return { goal, days, equipment, unit, lifts };
  }
  function planRef(v, brief) {
    if (typeof v !== 'string') return null;
    if (LIB[v]) return { ex: v };
    const m = matchExercise(noLinks(v, 60));
    if (m) return { ex: m };
    const name = noLinks(v, LIMITS.name);
    if (!name || !/\p{L}{2}/u.test(name) || !name.replace(KIND_WORDS, '').trim()) return null;
    const mine = (brief.lifts || []).find((l) => l.custom && fold(l.ex) === fold(name));
    return { custom: mine ? mine.ex : name, kind: mine ? mine.kind : guessKind(name), group: guessGroup(name) };
  }
  function planWeek(x, unit) {
    if (!x || typeof x !== 'object') return null;
    const clamp = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null);
    const sets = clamp(x.sets, 1, 8), reps = clamp(x.reps, 1, 30);
    if (!sets || !reps) return null;
    const pct = typeof x.pct === 'number' && x.pct >= 30 && x.pct <= 100 ? Math.round(x.pct) : null;
    const max = shown(LIMITS.maxKg, unit);
    const w = pct === null && typeof x.weight === 'number' && Number.isFinite(x.weight) && x.weight >= 0 && x.weight <= max ? toKg(roundTo(x.weight, 0.25), unit) : null;
    return { sets, reps, pct, w };
  }
  /**
   * The model's plan, made safe: the days asked for (at most), up to 8
   * exercises a day - each a library lift or a clearly named custom one,
   * only on the equipment you have (bodyweight always) - and exactly four
   * weeks for each: sets 1-8, reps 1-30, a load as a % of e1RM (30-100) or a
   * weight in your unit, rest 30 s to 10 min. No links, no markup.
   */
  function cleanPlan(raw, brief) {
    const b = brief;
    const allowed = b.equipment.concat(['bodyweight']);
    const src = raw && typeof raw === 'object' && Array.isArray(raw.days) ? raw.days.slice(0, b.days) : [];
    const days = [];
    src.forEach((d, i) => {
      if (!d || typeof d !== 'object') return;
      const items = [];
      (Array.isArray(d.exercises) ? d.exercises.slice(0, 12) : []).forEach((x) => {
        if (items.length >= LIMITS.planExercises || !x || typeof x !== 'object') return;
        const ref = planRef(x.exercise, b);
        if (!ref) return;
        if (ref.ex && !allowed.includes(LIB[ref.ex].kind)) return;
        if (items.some((it) => (ref.ex ? it.ex === ref.ex : it.custom && fold(it.custom) === fold(ref.custom)))) return;
        const weeks = (Array.isArray(x.weeks) ? x.weeks.slice(0, 4) : []).map((wk) => planWeek(wk, b.unit)).filter(Boolean);
        if (!weeks.length) return;
        while (weeks.length < 4) weeks.push(Object.assign({}, weeks[weeks.length - 1]));
        const rest = typeof x.rest === 'number' && Number.isFinite(x.rest) ? Math.min(600, Math.max(30, Math.round(x.rest))) : (ref.ex ? LIB[ref.ex].rest : DEFAULT_REST[ref.kind]);
        items.push(Object.assign({}, ref, { rest, weeks }));
      });
      if (items.length) days.push({ name: noLinks(d.name, 30) || `Day ${'ABCDEF'[i]}`, exercises: items });
    });
    if (!days.length) throw fail(422, 'No usable plan came back. Try again in a moment.');
    return { summary: noLinks(raw && raw.summary, 240), unit: b.unit, goal: b.goal, days };
  }
  /** A cleaned plan as routines to save: one per day per week ("Week 2 ·
   *  Upper"), all in one program, and the custom exercises it needs. */
  function planRoutines(plan, opts) {
    const o = opts || {};
    const have = Object.assign({}, o.custom || {});
    const fresh = {};
    const idOf = (it) => {
      if (it.ex) return it.ex;
      const found = Object.keys(have).find((k) => fold(have[k].name) === fold(it.custom)) || Object.keys(fresh).find((k) => fold(fresh[k].name) === fold(it.custom));
      if (found) return found;
      const id = o.id('c');
      fresh[id] = { id, name: it.custom, group: it.group || guessGroup(it.custom), kind: KIND_IDS.includes(it.kind) ? it.kind : 'machine', rest: DEFAULT_REST[it.kind] || 90, custom: true, updatedAt: o.nowMs };
      return id;
    };
    const routines = [];
    for (let wk = 1; wk <= 4; wk++) {
      plan.days.forEach((d, i) => routines.push({
        id: o.id('r'), name: cleanText(`Week ${wk} · ${d.name}`, LIMITS.name), program: o.label || 'My 4-week plan', week: wk, order: i, from: 'ai', updatedAt: o.nowMs,
        exercises: d.exercises.map((it) => { const p = it.weeks[wk - 1]; return { ex: idOf(it), sets: p.sets, reps: p.reps, rest: it.rest, pct: p.pct, w: p.w }; }),
      }));
    }
    return { routines, custom: fresh };
  }

  /* ------------------------------------------------------------------ *
   * The sample month: a made-up lifter's last four weeks, three workouts a
   * week (Monday, Wednesday, Friday) on the beginner full-body routine.
   * Squat and deadlift climb, the bench press set a PR in the last workout,
   * the overhead press has stalled three times at the same weight (so it
   * suggests a deload), pull-ups crept up to 3x8.
   * ------------------------------------------------------------------ */

  function sample(today, nowMs, unit) {
    const u = unitOf(unit);
    const nice = (kg) => (u === 'kg' ? kg : roundTo(kg * 2.20462, 5));
    const kgOf = (kg) => toKg(nice(kg), u);
    const days = [];
    const monday = weekStart(today);
    for (let wk = 4; wk >= 0; wk--) [0, 2, 4].forEach((o) => { const d = addDays(monday, -7 * wk + o); if (d < today) days.push(d); });
    const n = days.length;
    const set = (kg, r, rpe) => ({ w: kgOf(kg), r, rpe: rpe || null, warm: false });
    const warm = (kg, r) => ({ w: kgOf(kg), r, rpe: null, warm: true });
    const entry = (k, ex, goal, sets) => ({ id: `sample-e${k}-${ex}`, ex, goal, rest: null, sets });
    const bench = [[57.5, [5, 5, 5], 9], [55, [5, 5, 5], 8.5], [55, [5, 5, 4], 10], [52.5, [5, 5, 5], 8], [50, [5, 5, 5], 7.5], [47.5, [5, 5, 5], 7], [45, [5, 5, 5], 7]];
    const ohp = [[40, [4, 4, 3], 10], [40, [5, 4, 3], 10], [40, [5, 4, 4], 9.5], [37.5, [5, 5, 5], 9], [35, [5, 5, 5], 8], [32.5, [5, 5, 5], 7.5], [30, [5, 5, 5], 7]];
    const pull = [[8, 8, 8], [8, 8, 7], [8, 7, 6], [7, 6, 6], [6, 6, 5], [6, 5, 5], [5, 5, 4]];
    const workouts = days.map((day, i) => {
      const back = n - 1 - i;            // 0 = the most recent workout
      const isA = back % 2 === 0;
      const k = Math.floor(back / 2);    // this kind's sessions back from its latest
      const sq = 92.5 - 2.5 * back;
      const entries = [entry(i, 'squat', { sets: 3, reps: 5 }, [warm(20, 5), warm(roundTo(sq * 0.6, 2.5), 5), set(sq, 5), set(sq, 5), set(sq, 5, back < 3 ? 8.5 : 7.5)])];
      if (isA) {
        const [bw, br, brpe] = bench[Math.min(k, bench.length - 1)];
        entries.push(entry(i, 'bench', { sets: 3, reps: 5 }, br.map((r, j) => set(bw, r, j === br.length - 1 ? brpe : null))));
        const rw = 62.5 - 2.5 * k;
        entries.push(entry(i, 'row', { sets: 3, reps: 8 }, [set(rw, 8), set(rw, 8), set(rw, 8, 8)]));
        const cw = k < 2 ? 12.5 : 10;
        entries.push(entry(i, 'db-curl', { sets: 2, reps: 12 }, [set(cw, 12), set(cw, k === 0 ? 12 : 11)]));
      } else {
        const [ow, or, orpe] = ohp[Math.min(k, ohp.length - 1)];
        entries.push(entry(i, 'ohp', { sets: 3, reps: 5 }, or.map((r, j) => set(ow, r, j === or.length - 1 ? orpe : null))));
        const dl = 110 - 5 * k;
        entries.push(entry(i, 'deadlift', { sets: 1, reps: 5 }, [warm(60, 5), set(dl, 5, k === 0 ? 8.5 : 8)]));
        const pr = pull[Math.min(k, pull.length - 1)];
        entries.push(entry(i, 'pull-up', { sets: 3, reps: 8 }, pr.map((r) => ({ w: 0, r, rpe: null, warm: false }))));
      }
      const startedAt = dayMs(day) + (17 * 60 + 40) * 60000;
      return {
        id: `sample-w${pad(i)}`, day, startedAt, endedAt: startedAt + (52 + (i * 7) % 15) * 60000,
        name: isA ? 'Full body A' : 'Full body B', routineId: isA ? 'starter-fb-a' : 'starter-fb-b', program: 'Beginner full body',
        note: '', entries, updatedAt: nowMs, sample: true,
      };
    });
    return { workouts };
  }

  return {
    LIMITS, DAY_MS, ID_RE, CUSTOM_RE, UNITS, KG_PER_LB, GROUPS, KINDS, LIBRARY, PLATES, PLATE_DEFAULTS, BARS, STARTERS, STARTER_ROUTINES, GOALS, SAVED_FIELDS, CSV_HEAD,
    clean, cleanText, noLinks, fold, fail, intIn, plural, hash,
    isDay, isLeap, daysInMonth, dayMs, daysBetween, addDays, localDay, weekday, weekStart, fmtDay, fmtWhen, monthOf, MONTHS, WEEKDAYS,
    unitOf, toKg, fromKg, shown, fmtNum, fmtW, fmtE, fmtBig, parseNum, parseWeight, roundTo, stepOf,
    matchExercise, guessKind, guessGroup, cleanExercise, exerciseOf, knownId, restOf, incrementOf, cleanRest, UNKNOWN,
    defaultSettings, cleanSettings, cleanPlates, cleanBar,
    cleanSet, cleanRpe, cleanEntry, cleanWorkout, toSaved, byTime, finish, mergeById, working,
    e1rm, summarize, sessionsOf, scheme, bestE1rm, suggest, emptyRecords, addToRecords, recordsOf, setPrs, sessionPrs, timeline, workoutPrs, liftsOf,
    groupWeeks, streak, calendar,
    restLeft, restDone, restAdjust, fmtClock,
    plateMath, platesText,
    cleanRoutine, routineFromWorkout, routineById, nextUp, lastSets, draftEntry, draftWorkout,
    exportJson, importJson, exportCsv, importCsv, parseCsv, csvCell,
    planBrief, cleanBrief, cleanPlan, planRoutines,
    sample,
  };
});
