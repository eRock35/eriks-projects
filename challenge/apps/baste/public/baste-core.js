/* Baste - the rules, in one file, run three times: in the page
 * (window.BasteCore), on the server and in the tests (require).
 *
 * A dinner is worked BACKWARD from the time everyone eats: each dish is
 * ready at dinner, so it comes out its rest before that, goes in its cook
 * time before that, and its prep starts before that. The oven(s) are then
 * fitted: two dishes at different temperatures in one oven at once, or more
 * dishes than fit, is a CONFLICT, flagged with the fixes that would clear
 * it. On the day the same plan runs FORWARD from what has actually
 * happened: a step ticked late, a dish "running late +10", a guest's dish
 * that cannot go in before they arrive, an oven still busy - each pushes
 * what depends on it, and if dinner itself has to move the plan says so.
 *
 * Also here: time zones (the dinner's wall-clock time and its zone name one
 * instant; every time is shown in the dinner's zone), the built-in dishes,
 * the turkey chart, Fahrenheit and Celsius, what a dish is and how it is
 * cleaned, the one door every change goes through (act), what a phone is
 * shown (view), text cleaning, ids and codes.
 *
 * NO CLOCK AND NO DICE: "now", "today" and every new id are handed in
 * (tested), so the same input gives the same plan on every phone and on
 * the server.
 *
 * FOOD SAFETY: every time here is an estimate for planning. The page says
 * so wherever a time is shown for meat or stuffing: use a thermometer -
 * poultry and stuffing are done at 165 F / 74 C (USDA).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BasteCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    members: 20,       // people in one dinner
    dishes: 30,        // dishes in one dinner
    name: 20,          // a first name
    title: 40,         // the dinner's name
    dish: 40,          // a dish's name
    note: 140,
    prep: 240,         // minutes
    cook: 720,
    rest: 180,
    reheat: 60,
    late: 240,         // minutes late, at most
    ovens: 3,
    fit: 6,            // dishes that fit in one oven at once
    aheadDays: 400,    // a dinner is at most this far ahead
    keepDays: 7,       // a dinner is deleted this long after its day
    pasteChars: 8000,  // a pasted recipe
  };
  var MIN = 60000;
  var TOLERANCE_F = 25;  // two dishes this close in temperature may share an oven
  var SAME_F = 10;       // closer than this is the same oven setting
  var HEAT_MIN = 15;     // an empty oven is switched on this long before a dish goes in
  var WARM_MIN = 45;     // an oven emptied less than this ago is still on: no second "oven on"
  var GRACE_MIN = 2;     // a step this far past due starts pushing what follows
  var SAFE = '165°F / 74°C';

  function fail(status, message, extra) {
    var e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }
  function own(o, k) { return Boolean(o) && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, zero-width and bidirectional marks.
  var INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  function line(v, max) {
    var s = str(v).slice(0, (max || 200) * 8).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    var cps = Array.from(s);
    return cps.length > max ? cps.slice(0, max).join('').trim() : s;
  }
  function esc(v) { return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function norm(v) { return line(v, 80).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function cleanName(v) {
    var s = line(v, LIMITS.name * 2).replace(/[^\p{L}\p{M}' ’.-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[ '.’-]+|[ '.’-]+$/g, '').trim();
    s = Array.from(s).slice(0, LIMITS.name).join('').trim();
    return /\p{L}/u.test(s) ? s : '';
  }
  /** Why a piece of free text is not kept - or ''. Baste collects no email
   *  address and no phone number from anyone, and this is where that is
   *  held: every text field of a dinner and a dish passes here. */
  function refuse(v) {
    var s = str(v);
    if (/[@＠﹫]/.test(s)) return 'No email addresses, please - Baste keeps first names and dishes only.';
    if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(s)) return 'No links, please.';
    if (/\p{Nd}(?:[\s.\-()]*\p{Nd}){6}/u.test(s)) return 'No phone numbers or long numbers, please - Baste keeps first names and dishes only.';
    if (/[<>]/.test(s)) return 'No markup, please.';
    return '';
  }
  /** A text field: refused with a reason, or cleaned to `max`. */
  function field(v, max, label) {
    var why = refuse(v);
    if (why) throw fail(400, (label ? label + ': ' : '') + why);
    return line(v, max);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function listNames(names) {
    if (names.length <= 1) return names.join('');
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function initials(name) { var w = String(name || '?').split(/[\s+&-]+/).filter(Boolean); return (w.length > 1 ? Array.from(w[0])[0] + Array.from(w[w.length - 1])[0] : Array.from(w[0] || '?').slice(0, 2).join('')).toUpperCase(); }

  /* ------------------------------------------------------------------ *
   * Ids and codes
   * ------------------------------------------------------------------ */

  var ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
  function newId(rand, n, prefix) { var s = prefix || ''; for (var i = 0; i < (n || 8); i++) s += ID_CHARS[rand(ID_CHARS.length)]; return s; }
  function isId(v) { return typeof v === 'string' && /^[a-z][a-z0-9]{5,24}$/.test(v); }
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 6;
  function normalizeCode(v) { return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
  function isCode(v) { return typeof v === 'string' && v.length === CODE_LEN && v.split('').every(function (c) { return CODE_ALPHABET.indexOf(c) >= 0; }); }
  function formatCode(v) { var c = normalizeCode(v); return c.slice(0, 3) + '-' + c.slice(3); }
  function isGid(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{16}$/.test(v); }

  // Ten colours for people, each holding white text at 4.5:1 or better
  // (tested); past ten they repeat, and initials tell people apart.
  var COLORS = ['#0b6bcb', '#a3122f', '#1b6e2a', '#7a2e8f', '#805400', '#0f6470', '#b5420e', '#4a4f9e', '#9c2d6b', '#3f5563'];

  /* ------------------------------------------------------------------ *
   * Days: calendar dates as YYYY-MM-DD
   * ------------------------------------------------------------------ */

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function isDay(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var d = new Date(v + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === v && v >= '2000-01-01' && v <= '2100-12-31';
  }
  function dayMs(day) { return Date.parse(day + 'T00:00:00Z'); }
  function addDays(day, n) { return new Date(dayMs(day) + n * 86400000).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
  function weekday(day) { return WEEKDAYS[new Date(dayMs(day)).getUTCDay()]; }
  /** "Wednesday, Nov 25" */
  function dayLong(day) { return weekday(day) + ', ' + MONTHS[Number(day.slice(5, 7)) - 1] + ' ' + Number(day.slice(8)); }
  /** "Today", "Tomorrow", "Yesterday" or the long form. */
  function dayLabel(day, today) {
    if (day === today) return 'Today';
    if (day === addDays(today, 1)) return 'Tomorrow';
    if (day === addDays(today, -1)) return 'Yesterday';
    return dayLong(day);
  }
  /** "Nov 25 - 29" or "Nov 29 - Dec 2" */
  function dateRange(from, to) {
    var a = MONTHS[Number(from.slice(5, 7)) - 1] + ' ' + Number(from.slice(8));
    if (from === to) return a;
    return a + ' - ' + (from.slice(0, 7) === to.slice(0, 7) ? '' : MONTHS[Number(to.slice(5, 7)) - 1] + ' ') + Number(to.slice(8));
  }
  function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

  /* ------------------------------------------------------------------ *
   * Time zones
   *
   * Dinner is typed as a wall-clock time where it is eaten ("4:00 PM") with
   * that place's IANA zone. zonedToUtc turns the two into one instant, which
   * is what every step is worked back from and what is stored; zoneLocal
   * turns an instant back into a wall-clock time, so every phone shows the
   * plan in the dinner's own zone wherever the phone is.
   *
   * The zone rules are the platform's (Intl), never a table here.
   * ------------------------------------------------------------------ */

  var fmts = {};
  function fmtFor(tz) {
    if (!own(fmts, tz)) fmts[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return fmts[tz];
  }
  function isZone(tz) {
    if (typeof tz !== 'string' || tz.length < 2 || tz.length > 40 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
    try { fmtFor(tz); return true; } catch (e) { return false; }
  }
  function okTime(v) { return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 8.64e15; }
  /** An instant as the wall clock reads in `tz`: {y, mo, d, h, mi} */
  function zoneParts(ms, tz) {
    var o = {};
    fmtFor(tz).formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== 'literal') o[p.type] = Number(p.value); });
    return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
  }
  /** Minutes east of UTC in `tz` at that instant (Chicago in winter: -360). */
  function offsetMin(ms, tz) {
    var p = zoneParts(ms, tz);
    return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
  }
  /** "2026-11-25T15:10" in `tz` */
  function zoneLocal(ms, tz) {
    var p = zoneParts(ms, tz);
    return p.y + '-' + pad(p.mo) + '-' + pad(p.d) + 'T' + pad(p.h) + ':' + pad(p.mi);
  }
  function zoneDay(ms, tz) { return zoneLocal(ms, tz).slice(0, 10); }
  function isLocal(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) && isDay(v.slice(0, 10)) && Number(v.slice(11, 13)) < 24 && Number(v.slice(14)) < 60;
  }
  /** The instant a wall-clock time names in `tz`. A time that happens twice
   *  (the hour the clocks go back) is the FIRST one; a time that never
   *  happens (the hour they go forward) moves forward by the gap, the way a
   *  clock on the wall would have read. */
  function zonedToUtc(local, tz) {
    if (!isLocal(local) || !isZone(tz)) return null;
    var wall = Date.UTC(Number(local.slice(0, 4)), Number(local.slice(5, 7)) - 1, Number(local.slice(8, 10)), Number(local.slice(11, 13)), Number(local.slice(14, 16)));
    var a = offsetMin(wall - 86400000, tz), b = offsetMin(wall + 86400000, tz);
    var c1 = wall - a * 60000, c2 = wall - b * 60000;
    var ok = [c1, c2].filter(function (c) { return zoneLocal(c, tz) === local; });
    if (ok.length) return Math.min.apply(null, ok);
    return wall - Math.min(a, b) * 60000;
  }
  /** "CST", "PDT", "GMT+1" - the short name of the zone at that instant. */
  function zoneAbbr(ms, tz) {
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms));
      for (var i = 0; i < parts.length; i++) if (parts[i].type === 'timeZoneName') return parts[i].value;
    } catch (e) { /* fall through */ }
    return '';
  }
  /** "America/Chicago" -> "Chicago"; for labels. */
  function zoneCity(tz) { return str(tz).split('/').pop().replace(/_/g, ' '); }
  /** "15:10" -> "3:10 PM" */
  function clock(hm) {
    var h = Number(hm.slice(0, 2)), m = hm.slice(3, 5);
    return ((h + 11) % 12 + 1) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function clockAt(ms, tz) { return clock(zoneLocal(ms, tz).slice(11)); }
  // The zones offered first; the page adds the phone's own and, where the
  // browser lists them, every other.
  var COMMON_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];

  /* ------------------------------------------------------------------ *
   * Small things: whole numbers, durations, temperatures
   * ------------------------------------------------------------------ */

  function intIn(v, lo, hi, dflt) {
    var n = typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
  }
  function round5(n) { return Math.round(n / 5) * 5; }
  function ceil5(n) { return Math.ceil(n / 5) * 5; }
  /** 225 -> "3 h 45 min", 60 -> "1 h", 12 -> "12 min" */
  function dur(min) {
    min = Math.max(0, Math.round(min));
    var h = Math.floor(min / 60), m = min % 60;
    return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
  }
  /** Temperatures are KEPT in Fahrenheit (whole degrees) and shown rounded
   *  to 5 in the dinner's unit: 350 F is "350°F" or "175°C". */
  function fToC(f) { return (f - 32) * 5 / 9; }
  function cToF(c) { return Math.round(c * 9 / 5 + 32); }
  function tempText(f, unit) { return unit === 'C' ? round5(fToC(f)) + '°C' : round5(f) + '°F'; }
  /** The number alone, for a form field. */
  function tempNumber(f, unit) { return unit === 'C' ? round5(fToC(f)) : round5(f); }
  /** How long a dish takes at another temperature: a rule of thumb, minutes
   *  in proportion to the temperatures. ALWAYS shown as an estimate. */
  function adjust(cook, from, to) { return Math.max(1, Math.min(LIMITS.cook, Math.round(cook * from / to))); }
  /** "in 12 min", "in 1 h 5 min", "now", "8 min ago" */
  function until(ms, now) {
    var d = Math.round((ms - now) / MIN);
    if (d === 0) return 'now';
    return d > 0 ? 'in ' + dur(d) : dur(-d) + ' ago';
  }

  /* ------------------------------------------------------------------ *
   * The turkey chart
   *
   * USDA's roasting times for a whole turkey at 325 F, thawed, by weight,
   * unstuffed and stuffed: 8-12 lb 2 3/4-3 h (stuffed 3-3 1/2), 12-14 lb
   * 3-3 3/4 (3 1/2-4), 14-18 lb 3 3/4-4 1/4 (4-4 1/4), 18-20 lb 4 1/4-4 1/2
   * (4 1/4-4 3/4), 20-24 lb 4 1/2-5 (4 3/4-5 1/4). Read along each range
   * by weight and rounded to 5 minutes. A planning estimate only: the
   * turkey is done when a thermometer says so.
   * ------------------------------------------------------------------ */

  var TURKEY = {
    plain: [[8, 165], [12, 180], [14, 225], [18, 255], [20, 270], [24, 300]],
    stuffed: [[8, 180], [12, 210], [14, 240], [18, 255], [20, 285], [24, 315]],
  };
  var TURKEY_LB = [8, 24];
  var LB_PER_KG = 2.20462;
  function turkeyMinutes(lb, stuffed) {
    var pts = stuffed ? TURKEY.stuffed : TURKEY.plain;
    var w = Math.max(TURKEY_LB[0], Math.min(TURKEY_LB[1], lb));
    for (var i = 1; i < pts.length; i++) {
      if (w <= pts[i][0]) return round5(pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (w - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]));
    }
    return pts[pts.length - 1][1];
  }

  /* ------------------------------------------------------------------ *
   * The built-in dishes
   *
   * Ordinary planning figures for a holiday table - starting points the
   * cook changes to match their own recipe. `hold` is how long a dish may
   * wait, covered, beyond its rest before it suffers; `stoveCook` is the
   * minutes a stovetop version takes (the "move to stovetop" fix);
   * `baste` the minutes between bastes; `safe` picks the food-safety line.
   * ------------------------------------------------------------------ */

  var PRESETS = {
    turkey: { name: 'Turkey', method: 'oven', prep: 30, cook: 225, temp: 325, rest: 30, hold: 60, big: true, baste: 45, safe: 'poultry', weight: 14 },
    ham: { name: 'Ham', method: 'oven', prep: 15, cook: 120, temp: 325, rest: 15, hold: 45, big: true, safe: 'ham' },
    stuffing: { name: 'Stuffing', method: 'oven', prep: 25, cook: 40, temp: 350, rest: 10, hold: 30, canAhead: true, reheat: 20, stoveCook: 15, safe: 'stuffing' },
    mashed: { name: 'Mashed potatoes', method: 'stove', prep: 20, cook: 25, rest: 0, hold: 30, canAhead: true, reheat: 10 },
    sweet: { name: 'Sweet potatoes', method: 'oven', prep: 20, cook: 30, temp: 350, rest: 10, hold: 30, canAhead: true, reheat: 15, stoveCook: 25 },
    greenbean: { name: 'Green bean casserole', method: 'oven', prep: 15, cook: 30, temp: 350, rest: 10, hold: 20 },
    rolls: { name: 'Rolls', method: 'oven', prep: 5, cook: 10, temp: 375, rest: 0, hold: 10 },
    gravy: { name: 'Gravy', method: 'stove', prep: 5, cook: 15, rest: 0, hold: 20 },
    cranberry: { name: 'Cranberry sauce', method: 'stove', prep: 5, cook: 15, rest: 0, hold: 60, canAhead: true, ahead: true, reheat: 0 },
    macaroni: { name: 'Mac and cheese', method: 'oven', prep: 20, cook: 30, temp: 350, rest: 10, hold: 30, canAhead: true, reheat: 15, stoveCook: 20 },
    sprouts: { name: 'Brussels sprouts', method: 'oven', prep: 10, cook: 25, temp: 400, rest: 0, hold: 15, stoveCook: 15 },
    carrots: { name: 'Glazed carrots', method: 'stove', prep: 10, cook: 15, rest: 0, hold: 20 },
    cornbread: { name: 'Cornbread', method: 'oven', prep: 10, cook: 25, temp: 400, rest: 10, hold: 30, canAhead: true, reheat: 0 },
    salad: { name: 'Salad', method: 'none', prep: 15, cook: 0, rest: 0, hold: 20 },
    pumpkinpie: { name: 'Pumpkin pie', method: 'oven', prep: 20, cook: 55, temp: 375, rest: 120, hold: 120, canAhead: true, ahead: true, reheat: 0 },
    applepie: { name: 'Apple pie', method: 'oven', prep: 30, cook: 55, temp: 400, rest: 120, hold: 120, canAhead: true, ahead: true, reheat: 0 },
    pecanpie: { name: 'Pecan pie', method: 'oven', prep: 15, cook: 55, temp: 350, rest: 120, hold: 120, canAhead: true, ahead: true, reheat: 0 },
  };
  var PRESET_IDS = ['turkey', 'ham', 'stuffing', 'mashed', 'sweet', 'greenbean', 'rolls', 'gravy', 'cranberry', 'macaroni', 'sprouts', 'carrots', 'cornbread', 'salad', 'pumpkinpie', 'applepie', 'pecanpie'];
  var METHODS = { oven: 'Oven', stove: 'Stovetop', none: 'No cooking' };
  var METHOD_IDS = ['oven', 'stove', 'none'];
  function presetOf(d) { return own(PRESETS, d.kind) ? PRESETS[d.kind] : {}; }
  /** What a new dish of this kind starts as (the form's first values). */
  function fromPreset(kind) {
    var p = own(PRESETS, kind) ? PRESETS[kind] : null;
    if (!p) return { kind: 'custom', name: '', method: 'oven', prep: 15, cook: 30, temp: 350, rest: 5, big: false, canAhead: false, ahead: false, reheat: 15, note: '', guest: false, arrive: '', weight: 0, stuffed: false };
    return { kind: kind, name: p.name, method: p.method, prep: p.prep, cook: p.cook, temp: p.temp || 0, rest: p.rest, big: Boolean(p.big), canAhead: Boolean(p.canAhead), ahead: Boolean(p.ahead), reheat: p.reheat === undefined ? 15 : p.reheat, note: '', guest: false, arrive: '', weight: p.weight || 0, stuffed: false };
  }
  /** The food-safety line for a dish, or ''. Conventional wording. */
  function safeLine(d) {
    var s = presetOf(d).safe;
    if (s === 'poultry') return 'Done at ' + SAFE + ' in the thickest part of the breast and the innermost thigh' + (d.stuffed ? ', and in the centre of the stuffing' : '') + ' (USDA). Times are estimates - use a thermometer.';
    if (s === 'stuffing') return 'Stuffing is done at ' + SAFE + ' in the centre (USDA). Use a thermometer.';
    if (s === 'ham') return 'A fully cooked ham is reheated to 140°F / 60°C; a fresh ham is cooked to 145°F / 63°C and rested 3 minutes (USDA). Use a thermometer.';
    return '';
  }

  /* ------------------------------------------------------------------ *
   * A dinner's own details
   * ------------------------------------------------------------------ */

  /** {title, eatLocal, tz, eatAt, ovens, fit, unit}, checked against the
   *  server's day. The instant (`eatAt`) is worked out HERE. */
  function cleanDinner(b, today) {
    b = isObj(b) ? b : {};
    var title = field(b.title, LIMITS.title, 'Name') || 'Dinner';
    if (!isLocal(b.eatLocal)) throw fail(400, 'Pick the day and the time you eat.');
    if (!isZone(b.tz)) throw fail(400, 'Pick the time zone of the kitchen.');
    var day = b.eatLocal.slice(0, 10);
    if (day < addDays(today, -1) || day > addDays(today, LIMITS.aheadDays)) throw fail(400, 'Pick a dinner from today up to about a year ahead.');
    var eatAt = zonedToUtc(b.eatLocal, b.tz);
    if (!okTime(eatAt)) throw fail(400, 'Pick the day and the time you eat.');
    return { title: title, eatLocal: b.eatLocal, tz: b.tz, eatAt: eatAt, ovens: intIn(b.ovens, 1, LIMITS.ovens, 1), fit: intIn(b.fit, 1, LIMITS.fit, 3), unit: b.unit === 'C' ? 'C' : 'F' };
  }

  /* ------------------------------------------------------------------ *
   * A dish
   *
   *   {kind, name, method: 'oven'|'stove'|'none', prep, cook, temp (F),
   *    rest, big, canAhead, ahead, reheat, note, guest, arrive, weight (lb),
   *    stuffed, who, fix: {temp?, early?, stove?}, late, by, ts}
   *
   * `fix` holds the adjustments a conflict's fix made (another oven
   * temperature, out so many minutes early, the stovetop version); `late`
   * is minutes the dish is running behind; `who` the helper who has it.
   * ------------------------------------------------------------------ */

  function isClock(v) { return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) && Number(v.slice(0, 2)) < 24 && Number(v.slice(3)) < 60; }
  function cleanFix(f, d) {
    f = isObj(f) ? f : {};
    var out = {}, P = presetOf(d);
    var hold = P.hold || (d.big ? 45 : 30);
    if (d.method === 'oven' && !d.ahead) {
      var t = intIn(f.temp, 150, 550, null);
      if (t !== null && t !== d.temp && Math.abs(t - d.temp) <= TOLERANCE_F && !f.stove) out.temp = t;
      if (f.stove === true && P.stoveCook) out.stove = true;
    }
    if (!d.ahead) { var e = intIn(f.early, 1, hold, null); if (e !== null) out.early = e; }
    return out;
  }
  /** What was typed, made into a dish - or refused with a reason. `dn` is
   *  the dinner (its unit reads a typed temperature); `prev` an existing
   *  dish being edited (who has it, its fixes and its lateness are kept). */
  function cleanDish(b, dn, prev) {
    b = isObj(b) ? b : {};
    var kind = typeof b.kind === 'string' && own(PRESETS, b.kind) ? b.kind : 'custom';
    var name = field(b.name, LIMITS.dish, 'Dish');
    if (!/\p{L}/u.test(name)) throw fail(400, 'Give the dish a name.');
    if (METHOD_IDS.indexOf(b.method) < 0) throw fail(400, 'Pick oven, stovetop or no cooking.');
    var method = b.method;
    var prep = intIn(b.prep, 0, LIMITS.prep, null);
    if (prep === null) throw fail(400, 'Prep is whole minutes, up to ' + (LIMITS.prep / 60) + ' hours.');
    var weight = 0, stuffed = false, cook = 0, temp = 0;
    if (kind === 'turkey' && method === 'oven') {
      var w = typeof b.weight === 'string' && /^\d{1,2}(\.\d)?$/.test(b.weight) ? Number(b.weight) : b.weight;
      if (typeof w !== 'number' || !isFinite(w)) throw fail(400, 'Say what the turkey weighs.');
      if (b.wunit === 'kg') w = w * LB_PER_KG;
      w = Math.round(w * 10) / 10;
      if (w < TURKEY_LB[0] - 0.05 || w > TURKEY_LB[1] + 0.05) throw fail(400, 'The chart covers a whole turkey from 8 to 24 lb (3.6 to 10.9 kg). For anything else, add your own dish with your own times.');
      weight = w; stuffed = b.stuffed === true;
    }
    if (method !== 'none') {
      cook = weight ? turkeyMinutes(weight, stuffed) : intIn(b.cook, 1, LIMITS.cook, null);
      if (cook === null) throw fail(400, 'Cooking time is whole minutes, from 1 up to ' + (LIMITS.cook / 60) + ' hours.');
    }
    if (method === 'oven') {
      var unit = b.unit === 'C' || b.unit === 'F' ? b.unit : dn.unit;
      var typed = intIn(b.temp, 1, 999, null);
      temp = typed === null ? null : (unit === 'C' ? cToF(typed) : typed);
      // A Celsius dinner shows 350 F as 175: saved again untouched, it stays 350.
      if (prev && prev.method === 'oven' && typed !== null && typed === tempNumber(prev.temp, unit)) temp = prev.temp;
      if (weight) temp = 325;
      if (temp === null || temp < 150 || temp > 550) throw fail(400, 'The oven temperature is ' + (unit === 'C' ? '65 to 290°C' : '150 to 550°F') + '.');
    }
    var rest = intIn(b.rest, 0, LIMITS.rest, null);
    if (rest === null) throw fail(400, 'Rest is whole minutes, up to ' + (LIMITS.rest / 60) + ' hours.');
    var canAhead = b.canAhead === true || b.ahead === true;
    var guest = b.guest === true;
    var d = {
      kind: kind, name: name, method: method, prep: prep, cook: cook, temp: temp, rest: rest,
      big: method === 'oven' && (b.big === true || weight > 0),
      canAhead: canAhead, ahead: canAhead && b.ahead === true && !guest,
      reheat: intIn(b.reheat, 0, LIMITS.reheat, own(PRESETS, kind) && PRESETS[kind].reheat !== undefined ? PRESETS[kind].reheat : 15),
      note: field(b.note, LIMITS.note, 'Notes'),
      guest: guest, arrive: guest && isClock(b.arrive) ? b.arrive : '',
      weight: weight, stuffed: stuffed,
      who: prev && isId(prev.who) ? prev.who : '',
      late: prev ? intIn(prev.late, 0, LIMITS.late, 0) : 0,
    };
    d.fix = cleanFix(prev ? prev.fix : null, d);
    return d;
  }
  /** A draft read from a recipe: every field cleaned, anything out of shape
   *  left at an ordinary value for the cook to fix. Never throws; never
   *  carries a note (free text from a model is not put on the plan). */
  function cleanDraft(raw, dn) {
    var r = isObj(raw) ? raw : {};
    var name = refuse(r.name) ? '' : line(r.name, LIMITS.dish);
    if (!/\p{L}/u.test(name)) name = '';
    var method = METHOD_IDS.indexOf(r.method) >= 0 ? r.method : 'oven';
    var temp = 0;
    if (method === 'oven') {
      var t = typeof r.temp === 'number' && isFinite(r.temp) ? Math.round(r.temp) : null;
      if (t !== null && r.unit === 'C') t = cToF(t);
      temp = t !== null && t >= 150 && t <= 550 ? t : 350;
    }
    return {
      kind: 'custom', name: name, method: method,
      prep: intIn(r.prep, 0, LIMITS.prep, 15),
      cook: method === 'none' ? 0 : intIn(r.cook, 1, LIMITS.cook, 30),
      temp: temp,
      rest: intIn(r.rest, 0, LIMITS.rest, 0),
      big: false, canAhead: r.canAhead === true, ahead: false, reheat: 15, note: '', guest: false, arrive: '', weight: 0, stuffed: false,
      unit: dn && dn.unit === 'C' ? 'C' : 'F',
    };
  }

  /* ------------------------------------------------------------------ *
   * The plan
   *
   * plan(v, now) -> {eatAt, serveAt, moved, why, steps, dishes, conflicts,
   *                  ovens, cooking}
   *
   * `v` is what a phone is shown (view): the dinner, its dishes, which
   * steps are done. `now` is the instant, or null for the plan on paper.
   *
   * 1. BACKWARD (base): every dish as if nothing had happened yet - ready
   *    at dinner (less any minutes a fix took it out early), out its rest
   *    before, in its cook time before that, prep before that. Made-ahead
   *    dishes are stacked before the day's cooking starts.
   * 2. THE OVENS: each oven dish is put in the oven where it clashes with
   *    the fewest others. A clash that is left is a conflict, with fixes.
   * 3. FORWARD (live): from what is ticked done, each dish's "late", a
   *    guest's arrival and the clock, every step's time now. A dish cannot
   *    go in before the oven is free of the dish ahead of it, and no step
   *    that is not done is ever in the past (after two minutes' grace). If
   *    any dish would be ready after dinner, DINNER MOVES - by that much,
   *    rounded up to five minutes - and everything not yet started moves
   *    with it. The plan says so (`moved`, `why`): never silently.
   * ------------------------------------------------------------------ */

  /** A dish as it will actually be cooked, its fixes applied. */
  function effective(d) {
    var P = presetOf(d), fix = isObj(d.fix) ? d.fix : {};
    var e = { method: d.method, cook: d.cook, temp: d.temp, est: false, alt: false, hold: P.hold || (d.big ? 45 : 30), baste: 0, stoveCook: d.method === 'oven' ? (P.stoveCook || 0) : 0 };
    if (fix.stove && d.method === 'oven' && P.stoveCook) { e.method = 'stove'; e.cook = P.stoveCook; e.temp = 0; e.alt = true; }
    else if (fix.temp && d.method === 'oven' && fix.temp !== d.temp) { e.cook = adjust(d.cook, d.temp, fix.temp); e.temp = fix.temp; e.est = true; }
    e.early = Math.min(intIn(fix.early, 1, LIMITS.rest, 0), e.hold);
    if (e.method === 'oven') e.baste = P.baste || 0;
    e.big = e.method === 'oven' && Boolean(d.big);
    return e;
  }
  function overlap(a, b) { return Math.min(a.end0, b.end0) - Math.max(a.start0, b.start0); }
  /** Two oven dishes that cannot be in together: at different settings
   *  (10 F or more apart - closer than that is one setting on any dial), or
   *  one of them takes the whole oven. */
  function sameTemp(a, b) { return Math.abs(a - b) < SAME_F; }
  function clash(a, b) { return !sameTemp(a.temp, b.temp) ? 'temp' : (a.big || b.big ? 'room' : ''); }

  function basePlan(v) {
    var S0 = v.eatAt, day = [], ahead = [];
    var eatDay = v.eatLocal.slice(0, 10);
    v.dishes.forEach(function (d) {
      var e = effective(d);
      var x = { id: d.id, d: d, name: d.name, method: e.method, cook: e.cook, temp: e.temp, est: e.est, alt: e.alt, hold: e.hold, early: e.early, big: e.big, baste: e.baste, stoveCook: e.stoveCook, prep: d.prep, rest: d.rest, oven: -1, preds: [], heat0: false, arrive: null };
      if (d.ahead) { x.early = 0; ahead.push(x); return; }
      x.ready0 = S0 - x.early * MIN;
      x.end0 = x.ready0 - x.rest * MIN;
      x.start0 = x.end0 - x.cook * MIN;
      x.prep0 = x.start0 - x.prep * MIN;
      if (d.guest && isClock(d.arrive)) x.arrive = zonedToUtc(eatDay + 'T' + d.arrive, v.tz);
      day.push(x);
    });
    // The ovens: the big and the long first, each where it clashes least.
    var ovens = [], conflicts = [], i;
    for (i = 0; i < v.ovens; i++) ovens.push([]);
    var queue = day.filter(function (x) { return x.method === 'oven'; }).sort(function (a, b) { return (b.big - a.big) || (b.cook - a.cook) || (a.id < b.id ? -1 : 1); });
    queue.forEach(function (x) {
      var best = null;
      ovens.forEach(function (list, o) {
        var hits = [], room = [];
        list.forEach(function (y) {
          if (overlap(x, y) <= 0) return;
          var k = clash(x, y);
          if (k) hits.push({ kind: k, y: y }); else room.push(y);
        });
        // More at once than fit: x and the dishes it would share with.
        var most = 0;
        room.forEach(function (y) { var n = room.filter(function (z) { return z.start0 <= y.start0 && z.end0 > y.start0; }).length; if (n > most) most = n; });
        var over = most + 1 > v.fit ? room : [];
        var score = hits.length + (over.length ? 1 : 0);
        if (!best || score < best.score) best = { o: o, hits: hits, over: over, score: score };
      });
      x.oven = best.o; ovens[best.o].push(x);
      best.hits.forEach(function (h) {
        var a = h.y.start0 <= x.start0 ? h.y : x, b = a === x ? h.y : x;
        conflicts.push({ kind: h.kind, oven: best.o, ids: [a.id, b.id], from: Math.max(a.start0, b.start0), to: Math.min(a.end0, b.end0) });
      });
      if (best.over.length) {
        var all = best.over.concat([x]).sort(function (a, b) { return a.start0 - b.start0 || (a.id < b.id ? -1 : 1); });
        conflicts.push({ kind: 'room', oven: best.o, ids: all.map(function (y) { return y.id; }), from: Math.max.apply(null, all.map(function (y) { return y.start0; })), to: Math.min.apply(null, all.map(function (y) { return y.end0; })) });
      }
    });
    // What each oven dish waits for: the dish ahead of it in the same oven
    // that it cannot share with. And whether the oven is cold before it.
    queue.forEach(function (x) {
      var warm = false;
      ovens[x.oven].forEach(function (y) {
        if (y === x) return;
        if (y.end0 <= x.start0 && clash(x, y)) x.preds.push(y.id);
        if (y.start0 < x.start0 && y.end0 >= x.start0 - WARM_MIN * MIN) warm = true;
        if (y.start0 === x.start0 && y.id < x.id) warm = true;
      });
      x.heat0 = !warm;
    });
    day.sort(function (a, b) { return a.start0 - b.start0 || (a.id < b.id ? -1 : 1); });
    // Made ahead: finished before the day's cooking starts (or three hours
    // before dinner, whichever is earlier); oven ones one after another.
    var aheadEnd = S0 - 180 * MIN;
    day.forEach(function (x) { var first = Math.min(x.prep0, x.heat0 ? x.start0 - HEAT_MIN * MIN : x.prep0); if (first < aheadEnd) aheadEnd = first; });
    var cursor = aheadEnd;
    ahead.sort(function (a, b) { return (b.cook - a.cook) || (a.id < b.id ? -1 : 1); }).forEach(function (x) {
      var span = (x.prep + x.cook) * MIN;
      if (x.method === 'oven') { x.make0 = cursor - span; cursor = x.make0; } else x.make0 = aheadEnd - span;
    });
    return { S0: S0, day: day, ahead: ahead, ovens: ovens, conflicts: conflicts };
  }

  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function doneAt(v, key) { return own(v.done, key) && isObj(v.done[key]) && okTime(v.done[key].at) ? v.done[key].at : null; }

  /** The fixes that would clear one conflict, most useful first. Each is
   *  {k, label, changes: [{id, k, v}]} - `changes` is what act('fix') takes. */
  function fixesFor(c, B, v, shift) {
    var out = [], unit = v.unit;
    shift = shift || 0;
    var xs = c.ids.map(function (id) { return byId(B.day, id); }).filter(Boolean);
    function started(x) { return doneAt(v, x.id + '_in') !== null; }
    if (xs.length === 2) {
      var a = xs[0], b = xs[1];
      // Out early: one is out before the other goes in, and waits covered.
      [[a, b], [b, a]].forEach(function (p) {
        var first = p[0], then = p[1];
        var need = Math.round((first.end0 - then.start0) / MIN), total = first.early + need;
        if (need <= 0 || total > first.hold || started(first)) return;
        var waits = first.rest + total;
        out.push({
          k: 'early', id: first.id,
          label: first.big
            ? 'Use the ' + lower(first.name) + '’s rest: take it out ' + dur(need) + ' sooner (' + clockAt(first.end0 - need * MIN + shift, v.tz) + '). It rests ' + dur(waits) + ' under foil, and the oven is free for the ' + lower(then.name) + '.'
            : 'Cook the ' + lower(first.name) + ' first: out ' + dur(need) + ' sooner (' + clockAt(first.end0 - need * MIN + shift, v.tz) + '), kept covered for ' + dur(waits) + ', and the oven is free for the ' + lower(then.name) + '.',
          changes: [{ id: first.id, k: 'early', v: total }],
        });
      });
      // Share: the shorter cook moves to the longer one's temperature.
      if (c.kind === 'temp' && !a.big && !b.big && v.fit >= 2 && Math.abs(a.temp - b.temp) <= TOLERANCE_F) {
        var keep = a.cook > b.cook || (a.cook === b.cook && a.temp <= b.temp) ? a : b, move = keep === a ? b : a;
        var base = move.d.temp, was = move.d.cook, will = adjust(was, base, keep.temp);
        if (Math.abs(keep.temp - base) <= TOLERANCE_F && !started(move)) {
          out.push({
            k: 'share', id: move.id,
            label: 'Share the oven at ' + tempText(keep.temp, unit) + ': the ' + lower(move.name) + ' at ' + tempText(keep.temp, unit) + ' instead of ' + tempText(base, unit) + ', about ' + dur(will) + ' instead of ' + dur(was) + ' - an estimate, so check it early.',
            changes: [{ id: move.id, k: 'temp', v: keep.temp }],
          });
        }
      }
    }
    xs.forEach(function (x) {
      if (x.d.canAhead && !x.big && !x.d.guest && !started(x)) out.push({ k: 'ahead', id: x.id, label: 'Make the ' + lower(x.name) + ' ahead' + (x.d.reheat ? ' and reheat (' + dur(x.d.reheat) + ')' : '') + ' - that leaves the oven free.', changes: [{ id: x.id, k: 'ahead', v: true }] });
    });
    xs.forEach(function (x) {
      if (x.stoveCook && !started(x)) out.push({ k: 'stove', id: x.id, label: 'Move the ' + lower(x.name) + ' to the stovetop (' + dur(x.stoveCook) + ').', changes: [{ id: x.id, k: 'stove', v: true }] });
    });
    // The roast's rest first; otherwise sharing first.
    var anyBig = xs.some(function (x) { return x.big; });
    var rank = anyBig ? { early: 0, share: 1, ahead: 2, stove: 3 } : { share: 0, early: 1, ahead: 2, stove: 3 };
    out.forEach(function (f, i) { f.n = i; });
    out.sort(function (a, b) { return rank[a.k] - rank[b.k] || a.n - b.n; });
    out.forEach(function (f) { delete f.n; });
    // Where sharing works, "cook one first" is only noise.
    if (out.some(function (f) { return f.k === 'share'; })) out = out.filter(function (f) { return f.k !== 'early'; });
    return out.slice(0, 4);
  }
  function lower(name) { return /^[A-Z][a-z]/.test(name) && !/^(Brussels|Mac)\b/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name; }
  function conflictText(c, B, v, shift) {
    var xs = c.ids.map(function (id) { return byId(B.day, id); }).filter(Boolean);
    var when = clockAt(c.from + (shift || 0), v.tz) + ' to ' + clockAt(c.to + (shift || 0), v.tz);
    var where = v.ovens > 1 ? ' in oven ' + (c.oven + 1) : '';
    if (c.kind === 'temp' && xs.length === 2) {
      return 'The ' + lower(xs[0].name) + ' (' + tempText(xs[0].temp, v.unit) + ') and the ' + lower(xs[1].name) + ' (' + tempText(xs[1].temp, v.unit) + ') both need the oven' + where + ' from ' + when + ', at different temperatures' + (xs[0].big || xs[1].big ? ' - and the ' + lower((xs[0].big ? xs[0] : xs[1]).name) + ' takes the whole oven.' : '.');
    }
    if (xs.length === 2) return 'The ' + lower((xs[0].big ? xs[0] : xs[1]).name) + ' takes the whole oven' + where + ', and the ' + lower((xs[0].big ? xs[1] : xs[0]).name) + ' needs it from ' + when + '.';
    return listNames(xs.map(function (x) { return x.name; })) + ' all need the oven' + where + ' from ' + when + ' - that is ' + xs.length + ' dishes, and ' + (v.fit === 1 ? 'one fits' : v.fit + ' fit') + ' at once.';
  }

  /** The forward pass: every dish's times given what is done, what is
   *  late, who has not arrived and (unless null) the clock. */
  function liveTimes(v, B, now) {
    var lo = now === null ? -Infinity : now - GRACE_MIN * MIN;
    function pass(M) {
      var T = {}, worst = 0, who = null;
      B.day.forEach(function (x) {
        var id = x.id, L = intIn(x.d.late, 0, LIMITS.late, 0), sh = Math.max(M, L) * MIN, t = {};
        var E = x.arrive === null ? -Infinity : x.arrive;
        var pk = doneAt(v, id + '_prep'), ik = doneAt(v, id + '_in'), ok = doneAt(v, id + '_out'), hk = doneAt(v, id + '_heat');
        var minIn = -Infinity;
        t.prep = pk !== null ? pk : Math.max(x.prep0 + sh, lo, E);
        if (x.prep > 0 && pk === null) minIn = t.prep + x.prep * MIN;
        if (x.method === 'none') {
          t.in = t.out = pk !== null ? pk : t.prep + x.prep * MIN;
        } else {
          if (x.heat0) {
            t.heat = hk !== null ? hk : Math.max(x.start0 - HEAT_MIN * MIN + sh, lo);
            if (hk === null) minIn = Math.max(minIn, t.heat + HEAT_MIN * MIN);
          }
          if (ik !== null) t.in = ik;
          else {
            t.in = Math.max(x.start0 + sh, lo, minIn, E);
            x.preds.forEach(function (p) { if (T[p] && T[p].out > t.in) { t.in = T[p].out; t.by = p; } });
          }
          t.out = ok !== null ? ok : Math.max(t.in + (x.cook + (ik !== null ? L : 0)) * MIN, lo);
        }
        t.ready = t.out + x.rest * MIN;
        T[id] = t;
        var over = (t.ready - B.S0) / MIN;
        if (over > worst) { worst = over; who = id; }
      });
      return { T: T, worst: worst, who: who };
    }
    var first = pass(0), M = first.worst > 0 ? ceil5(first.worst - 1e-6) : 0, r = first, n = 0;
    while (M > 0 && n++ < 4) {
      r = pass(M);
      var need = r.worst > 0 ? ceil5(r.worst - 1e-6) : 0;
      if (need <= M) break;
      M = need;
    }
    return { T: r.T, M: M, who: first.who, T0: first.T };
  }

  function pass0Root(N, id) { var n = 0; while (N.T0[id] && N.T0[id].by && n++ < 40) id = N.T0[id].by; return id; }
  var KIND_ORDER = { make: 0, heat: 1, prep: 2, out: 3, in: 4, baste: 5, warm: 6 };
  function plan(v, now) {
    var B = basePlan(v);
    var P = liveTimes(v, B, null);                    // the plan as ticked and tapped, without the clock
    var N = now === null || now === undefined ? P : liveTimes(v, B, now);
    now = now === undefined ? null : now;
    var S = B.S0 + N.M * MIN, steps = [], dishes = {}, lanes = [], i;
    for (i = 0; i < v.ovens; i++) lanes.push([]);
    function push(x, kind, key, at, due, extra) {
      var d = doneAt(v, key);
      var s = { key: key, kind: kind, id: x.id, name: x.name, at: d !== null ? d : at, due: due, done: d !== null ? { at: d, by: v.done[key].by || '' } : null, who: own(v.claims, key) ? v.claims[key] : (x.d.who || ''), claimed: own(v.claims, key), oven: x.oven };
      // Overdue is said only of a step that is due now - not of one that has
      // been pushed into the future by what comes before it.
      s.overdue = now !== null && d === null && now - due >= MIN && s.at <= now + MIN ? Math.floor((now - due) / MIN) : 0;
      if (extra) for (var k in extra) if (own(extra, k)) s[k] = extra[k];
      steps.push(s);
      return s;
    }
    B.day.forEach(function (x) {
      var id = x.id, t = N.T[id], p = P.T[id];
      var pk = doneAt(v, id + '_prep'), ik = doneAt(v, id + '_in'), ok = doneAt(v, id + '_out');
      var cooks = x.method !== 'none';
      var state = ok !== null ? (now !== null && now >= t.ready ? 'ready' : (x.rest ? 'resting' : 'ready')) : ik !== null ? 'cooking' : pk !== null ? (cooks ? 'prepped' : 'ready') : 'todo';
      dishes[id] = { id: id, name: x.name, method: x.method, temp: x.temp, cook: x.cook, rest: x.rest, est: x.est, alt: x.alt, early: x.early, big: x.big, oven: x.oven, ahead: false, state: state, prepAt: t.prep, inAt: t.in, outAt: t.out, readyAt: t.ready, waits: Math.max(0, Math.round((S - t.ready) / MIN)) + x.rest, late: intIn(x.d.late, 0, LIMITS.late, 0) };
      var later = ik !== null || ok !== null;
      if (x.method === 'oven') lanes[x.oven].push({ id: id, name: x.name, from: t.in, to: t.out, temp: x.temp, est: x.est, big: x.big });
      if (x.method === 'oven' && x.heat0 && !(later && doneAt(v, id + '_heat') === null)) push(x, 'heat', id + '_heat', t.heat, p.heat, { temp: x.temp });
      if (x.prep > 0 && !(later && pk === null)) push(x, 'prep', id + '_prep', t.prep, p.prep, { mins: x.prep, last: !cooks });
      if (cooks) {
        if (!(ok !== null && ik === null)) push(x, 'in', id + '_in', t.in, p.in, { temp: x.temp, mins: x.cook, est: x.est, stove: x.method === 'stove', turn: false });
        if (x.baste && ok === null) {
          for (var k = 1; k < 40; k++) {
            var bt = t.in + k * x.baste * MIN, bd = p.in + k * x.baste * MIN;
            if (bt >= t.out - 20 * MIN) break;
            // A baste nobody ticked is not chased for long.
            if (now !== null && doneAt(v, id + '_baste_' + k) === null && now - bt > 20 * MIN) continue;
            push(x, 'baste', id + '_baste_' + k, bt, bd, { nth: k });
          }
        }
        push(x, 'out', id + '_out', t.out, p.out, { rest: x.rest, stove: x.method === 'stove', waits: dishes[id].waits });
      }
    });
    B.ahead.forEach(function (x) {
      var id = x.id, mk = doneAt(v, id + '_make');
      var lateBy = now !== null && mk === null ? Math.max(x.make0, now) : x.make0;
      dishes[id] = { id: id, name: x.name, method: x.method, temp: x.temp, cook: x.cook, rest: x.rest, est: x.est, alt: x.alt, early: 0, big: x.big, oven: -1, ahead: true, state: mk !== null ? 'made' : 'todo', prepAt: x.make0, inAt: x.make0 + x.prep * MIN, outAt: x.make0 + (x.prep + x.cook) * MIN, readyAt: S, waits: 0, late: 0 };
      push(x, 'make', id + '_make', lateBy, x.make0, { mins: x.prep + x.cook, prep: x.prep, cook: x.cook, temp: x.temp, by: x.make0 + (x.prep + x.cook) * MIN, method: x.method, missed: now !== null && mk === null && now - x.make0 > GRACE_MIN * MIN });
      if (x.d.reheat > 0) push(x, 'warm', id + '_warm', S - x.d.reheat * MIN, B.S0 + P.M * MIN - x.d.reheat * MIN, { mins: x.d.reheat });
    });
    // "Turn the oven": a dish going into an oven that is at another temperature.
    lanes.forEach(function (lane) {
      lane.sort(function (a, b) { return a.from - b.from || (a.id < b.id ? -1 : 1); });
      lane.forEach(function (seg, j) {
        if (!j) return;
        var prev = lane[j - 1];
        if (!sameTemp(prev.temp, seg.temp)) steps.forEach(function (s) { if (s.kind === 'in' && s.id === seg.id) s.turn = true; });
      });
    });
    steps.sort(function (a, b) { return a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.key < b.key ? -1 : 1); });
    // Conflicts belong to the plan on paper; their times are shown moved
    // with dinner when dinner has moved. The longest overlap first: its fix
    // often clears the others.
    var sh = N.M * MIN;
    var conflicts = B.conflicts.slice().sort(function (a, b) { return (b.to - b.from) - (a.to - a.from) || (a.ids.join() < b.ids.join() ? -1 : 1); }).map(function (c) { return { kind: c.kind, oven: c.oven, ids: c.ids, from: c.from + sh, to: c.to + sh, text: conflictText(c, B, v, sh), fixes: fixesFor(c, B, v, sh) }; });
    // Why dinner moved: the dish that would be ready last - or, if it is
    // only waiting for the oven, the dish it is waiting for.
    var why = '';
    if (N.M > 0 && N.who) {
      var first = pass0Root(N, N.who), w = byId(B.day, first), wt = N.T[first], L = intIn(w.d.late, 0, LIMITS.late, 0);
      if (L > 0) why = w.name + ' is running ' + dur(L) + ' late.';
      else if (w.arrive !== null && wt.in <= w.arrive + MIN && wt.prep <= w.arrive + MIN) why = w.name + ' arrives at ' + clockAt(w.arrive, v.tz) + ' and needs ' + dur((wt.ready - w.arrive) / MIN) + ' from then.';
      else if (doneAt(v, first + '_in') !== null) why = w.name + ' went in at ' + clockAt(wt.in, v.tz) + ' and comes out at ' + clockAt(wt.out, v.tz) + '.';
      else if (now !== null) why = w.name + ' needs ' + dur(Math.ceil((wt.ready - now) / MIN)) + ' from now.';
      else why = w.name + ' sets the time.';
      if (first !== N.who) why += ' The ' + lower(byId(B.day, N.who).name) + ' waits for the oven.';
    }
    var cooking = B.day.filter(function (x) { return dishes[x.id].state === 'cooking'; }).map(function (x) { return dishes[x.id]; }).sort(function (a, b) { return a.outAt - b.outAt; });
    return { eatAt: B.S0, serveAt: S, moved: N.M, why: why, steps: steps, dishes: dishes, conflicts: conflicts, ovens: lanes, cooking: cooking, first: steps.length ? steps[0].at : S };
  }
  /** The words on a step: {title, sub}. */
  function stepText(s, v) {
    var n = s.name, low = lower(n), unit = v.unit, d = byId(v.dishes, s.id) || {};
    if (s.kind === 'heat') return { title: 'Oven on - ' + tempText(s.temp, unit), sub: 'Heating for the ' + low + (v.ovens > 1 ? ' · oven ' + (s.oven + 1) : '') };
    if (s.kind === 'prep') return { title: s.last ? 'Make the ' + low : 'Prep the ' + low, sub: dur(s.mins) + (d.guest ? ' · brought by a guest' : '') };
    if (s.kind === 'in') {
      if (s.stove) return { title: n + ' on', sub: 'Stovetop · ' + dur(s.mins) };
      return { title: n + ' in - ' + tempText(s.temp, unit), sub: dur(s.mins) + (s.est ? ' (an estimate at this temperature - check early)' : '') + (s.turn ? ' · turn the oven to ' + tempText(s.temp, unit) : '') + (v.ovens > 1 ? ' · oven ' + (s.oven + 1) : '') };
    }
    if (s.kind === 'baste') return { title: 'Baste the ' + low, sub: 'Quickly - the oven loses heat while the door is open' };
    if (s.kind === 'out') {
      var safe = safeLine(d);
      var rest = s.stove ? (s.waits ? 'Keep covered · ' + dur(s.waits) + ' to dinner' : 'Straight to the table') : (s.waits ? 'Rest ' + dur(s.waits) + (s.waits > 15 ? ', covered with foil' : '') : 'Straight to the table');
      return { title: n + (s.stove ? ' off' : ' out'), sub: rest + (safe ? '. ' + safe : '') };
    }
    if (s.kind === 'make' && s.missed) return { title: 'Make the ' + low, sub: 'This was to be made ahead, by ' + clockAt(s.by, v.tz) + (s.method === 'oven' ? ', before the oven was needed' : '') + '. Tick it if it is made - or fit it in when you can: the plan no longer books time for it.' };
    if (s.kind === 'make') return { title: 'Make the ' + low, sub: 'Ahead - today or yesterday: ' + (s.prep ? dur(s.prep) + ' prep' : '') + (s.prep && s.cook ? ' + ' : '') + (s.cook ? dur(s.cook) + (s.method === 'oven' ? ' at ' + tempText(s.temp, unit) : ' on the stovetop') : '') + '. Done by ' + clockAt(s.by, v.tz) + ', before the oven is needed.' };
    if (s.kind === 'warm') return { title: 'Warm the ' + low, sub: dur(s.mins) + ', covered - microwave, stovetop, or the oven if there is room (the plan does not book it)' };
    return { title: n, sub: '' };
  }
  /** "Dinner moves to 5:35 PM (35 min later). Turkey needs 4 h 5 min from now." or '' */
  function movedText(p, v) {
    if (!p.moved) return '';
    return 'Dinner moves to ' + clockAt(p.serveAt, v.tz) + ' - ' + dur(p.moved) + ' later than ' + clockAt(p.eatAt, v.tz) + '. ' + p.why;
  }

  /* ------------------------------------------------------------------ *
   * The one door: every change to a dinner's dishes, steps and details
   *
   * act(doc, mid, action, ctx) -> {set: {'dishes.<id>': ...}, del: [...]},
   * or throws. The server runs it inside a transaction and writes exactly
   * what comes back; the example on the page runs the same function.
   * ctx = {now, id, today} - the clock and the new id are handed in.
   * ------------------------------------------------------------------ */

  function liveMember(doc, mid) { return own(doc.members, mid) && !doc.members[mid].left; }
  function dishOf(doc, id) {
    if (!isId(id) || !own(doc.dishes, id)) throw fail(404, 'That dish isn’t on the plan any more.', { code: 'no-dish' });
    return doc.dishes[id];
  }
  function isKey(v) { return typeof v === 'string' && /^[a-z][a-z0-9]{5,24}_(heat|prep|in|out|make|warm|baste_\d{1,2})$/.test(v); }
  function act(doc, mid, a, ctx) {
    a = isObj(a) ? a : {};
    var d, set = {}, del = [], k = typeof a.t === 'string' ? a.t : '';
    if (k === 'add') {
      if (Object.keys(doc.dishes || {}).length >= LIMITS.dishes) throw fail(409, 'This dinner has ' + LIMITS.dishes + ' dishes - the most one plan holds.', { code: 'full' });
      d = cleanDish(a.dish, doc, null);
      d.by = mid; d.ts = ctx.now;
      if (d.guest || a.mine === true) d.who = mid;
      set['dishes.' + ctx.id] = d;
      return { set: set, del: del };
    }
    if (k === 'edit') {
      var prev = dishOf(doc, a.id);
      d = cleanDish(a.dish, doc, prev);
      d.by = prev.by; d.ts = ctx.now;
      if (d.who && !liveMember(doc, d.who)) d.who = '';
      set['dishes.' + a.id] = d;
      return { set: set, del: del };
    }
    if (k === 'del') {
      dishOf(doc, a.id);
      del.push('dishes.' + a.id);
      Object.keys(doc.done || {}).forEach(function (key) { if (key.indexOf(a.id + '_') === 0) del.push('done.' + key); });
      Object.keys(doc.claims || {}).forEach(function (key) { if (key.indexOf(a.id + '_') === 0) del.push('claims.' + key); });
      return { set: set, del: del };
    }
    if (k === 'claim') {
      // "I've got the potatoes" - or letting go of them.
      d = dishOf(doc, a.id);
      set['dishes.' + a.id + '.who'] = a.on === false ? '' : mid;
      return { set: set, del: del };
    }
    if (k === 'claimstep' || k === 'done') {
      if (!isKey(a.key)) throw fail(400, 'That is not a step.');
      var p = plan(view(doc, mid), ctx.now), step = null;
      p.steps.forEach(function (s) { if (s.key === a.key) step = s; });
      if (!step) throw fail(404, 'That step isn’t on the plan any more.', { code: 'no-step' });
      if (k === 'claimstep') {
        if (a.on === false) del.push('claims.' + a.key); else set['claims.' + a.key] = mid;
        return { set: set, del: del };
      }
      if (a.on === false) { del.push('done.' + a.key); return { set: set, del: del }; }
      // "Did it on time": the time it was due, never later than now.
      set['done.' + a.key] = { at: a.when === 'time' ? Math.min(ctx.now, step.due) : ctx.now, by: mid };
      // Once a dish is in, "late" starts again from nothing: the time it
      // comes out now follows from when it actually went in.
      if (step.kind === 'in' && doc.dishes[step.id].late) set['dishes.' + step.id + '.late'] = 0;
      return { set: set, del: del };
    }
    if (k === 'late') {
      // `add` moves it (two phones tapping +10 make +20); `set` names it.
      d = dishOf(doc, a.id);
      var n = own(a, 'set') ? intIn(a.set, 0, LIMITS.late, null) : (typeof a.add === 'number' && Number.isInteger(a.add) && Math.abs(a.add) <= LIMITS.late ? Math.max(0, Math.min(LIMITS.late, (d.late || 0) + a.add)) : null);
      if (n === null) throw fail(400, 'Late is in whole minutes, up to ' + (LIMITS.late / 60) + ' hours.');
      if (d.ahead) throw fail(400, 'A dish made ahead has no clock to run late on.');
      set['dishes.' + a.id + '.late'] = n;
      return { set: set, del: del };
    }
    if (k === 'fix') {
      var list = Array.isArray(a.changes) ? a.changes.slice(0, 6) : [];
      if (!list.length) throw fail(400, 'Pick a fix.');
      var fixes = {}, aheads = {};
      list.forEach(function (c) {
        c = isObj(c) ? c : {};
        d = dishOf(doc, c.id);
        var f = own(fixes, c.id) ? fixes[c.id] : clone(isObj(d.fix) ? d.fix : {});
        var P = presetOf(d);
        if (c.k === 'temp') {
          var t = intIn(c.v, 150, 550, null);
          if (d.method !== 'oven' || t === null || Math.abs(t - d.temp) > TOLERANCE_F) throw fail(400, 'Dishes share an oven only within ' + TOLERANCE_F + '°F (about 15°C) of their own temperature.');
          if (t === d.temp) delete f.temp; else f.temp = t;
          delete f.stove;
        } else if (c.k === 'early') {
          var hold = P.hold || (d.big ? 45 : 30), e = intIn(c.v, 0, hold, null);
          if (e === null) throw fail(400, 'The ' + lower(d.name) + ' can wait up to ' + dur(hold) + ' beyond its rest - not longer.');
          if (e) f.early = e; else delete f.early;
        } else if (c.k === 'stove') {
          if (d.method !== 'oven' || !P.stoveCook) throw fail(400, 'There is no stovetop version of that built in - edit the dish instead.');
          if (c.v === false) delete f.stove; else { f.stove = true; delete f.temp; }
        } else if (c.k === 'ahead') {
          if (c.v !== false && (!d.canAhead || d.guest)) throw fail(400, 'That dish is not marked as one that can be made ahead.');
          aheads[c.id] = c.v !== false;
        } else if (c.k === 'clear') {
          f = {};
        } else throw fail(400, 'That is not a fix.');
        fixes[c.id] = f;
      });
      Object.keys(fixes).forEach(function (id) {
        var after = clone(doc.dishes[id]);
        if (own(aheads, id)) { after.ahead = aheads[id]; set['dishes.' + id + '.ahead'] = aheads[id]; if (aheads[id] && after.late) set['dishes.' + id + '.late'] = 0; }
        set['dishes.' + id + '.fix'] = cleanFix(fixes[id], after);
      });
      return { set: set, del: del };
    }
    if (k === 'details') {
      if (!own(doc.members, mid) || !doc.members[mid].host) throw fail(403, 'Only whoever started the dinner can change that.', { code: 'not-host' });
      var day = doc.eatLocal.slice(0, 10);
      var g = cleanDinner({ title: a.title, eatLocal: a.eatLocal, tz: a.tz, ovens: a.ovens, fit: a.fit, unit: a.unit }, ctx.today < day ? ctx.today : day);
      return { set: { title: g.title, eatLocal: g.eatLocal, tz: g.tz, eatAt: g.eatAt, ovens: g.ovens, fit: g.fit, unit: g.unit }, del: del };
    }
    throw fail(400, 'That is not something Baste does.');
  }
  /** A change applied to a copy (the example on the page; the tests). */
  function patch(doc, change) {
    var out = clone(doc);
    function walk(key, fn) { var parts = key.split('.'), at = out; for (var i = 0; i < parts.length - 1; i++) { if (!isObj(at[parts[i]])) at[parts[i]] = {}; at = at[parts[i]]; } fn(at, parts[parts.length - 1]); }
    Object.keys(change.set || {}).forEach(function (k) { walk(k, function (o, last) { o[last] = clone(change.set[k]); }); });
    (change.del || []).forEach(function (k) { walk(k, function (o, last) { delete o[last]; }); });
    out.v = (out.v || 0) + 1;
    return out;
  }
  /** A dinner is deleted keepDays after its day. */
  function expired(doc, today) { return !isLocal(doc.eatLocal) || today > addDays(doc.eatLocal.slice(0, 10), LIMITS.keepDays); }

  /* ------------------------------------------------------------------ *
   * What one phone is shown: never a key hash, never an owner tag
   * ------------------------------------------------------------------ */

  function memberIds(doc) {
    return Object.keys(doc.members || {}).sort(function (a, b) { var x = doc.members[a].joinedAt || '', y = doc.members[b].joinedAt || ''; return x < y ? -1 : x > y ? 1 : (a < b ? -1 : 1); });
  }
  function view(doc, mid) {
    var members = memberIds(doc).map(function (id) { var m = doc.members[id]; return { id: id, name: m.name, c: m.c || 0, host: Boolean(m.host), left: Boolean(m.left), me: id === mid }; });
    var live = {}; members.forEach(function (m) { if (!m.left) live[m.id] = 1; });
    var dishes = Object.keys(doc.dishes || {}).sort(function (a, b) { var x = doc.dishes[a].ts || 0, y = doc.dishes[b].ts || 0; return x - y || (a < b ? -1 : 1); }).map(function (id) {
      var d = doc.dishes[id];
      return { id: id, kind: d.kind, name: d.name, method: d.method, prep: d.prep, cook: d.cook, temp: d.temp, rest: d.rest, big: Boolean(d.big), canAhead: Boolean(d.canAhead), ahead: Boolean(d.ahead), reheat: d.reheat || 0, note: d.note || '', guest: Boolean(d.guest), arrive: d.arrive || '', weight: d.weight || 0, stuffed: Boolean(d.stuffed), who: own(live, d.who) ? d.who : '', fix: cleanFix(d.fix, d), late: intIn(d.late, 0, LIMITS.late, 0), mine: d.by === mid };
    });
    var done = {}, claims = {};
    Object.keys(doc.done || {}).forEach(function (k) { var x = doc.done[k]; if (isKey(k) && isObj(x) && okTime(x.at)) done[k] = { at: x.at, by: own(live, x.by) ? x.by : '' }; });
    Object.keys(doc.claims || {}).forEach(function (k) { if (isKey(k) && own(live, doc.claims[k])) claims[k] = doc.claims[k]; });
    return { id: doc.id, code: doc.code, title: doc.title, eatLocal: doc.eatLocal, tz: doc.tz, eatAt: doc.eatAt, ovens: doc.ovens || 1, fit: doc.fit || 3, unit: doc.unit === 'C' ? 'C' : 'F', v: doc.v || 0, me: mid, host: Boolean(own(doc.members, mid) && doc.members[mid].host), members: members, dishes: dishes, done: done, claims: claims, keptUntil: addDays(doc.eatLocal.slice(0, 10), LIMITS.keepDays) };
  }
  function memberOf(v, mid) { for (var i = 0; i < v.members.length; i++) if (v.members[i].id === mid) return v.members[i]; return null; }
  /** One line about a dish: "Oven · 350°F · 40 min · rest 10 min" */
  function dishLine(d, unit) {
    var e = effective(d), bits = [];
    if (d.ahead) bits.push('Made ahead');
    bits.push(e.method === 'oven' ? 'Oven · ' + tempText(e.temp, unit) : METHODS[e.method]);
    if (e.method !== 'none') bits.push(dur(e.cook) + (e.est ? ' (estimate)' : ''));
    if (d.prep) bits.push(dur(d.prep) + ' prep');
    if (d.rest && !d.ahead) bits.push('rest ' + dur(d.rest));
    return bits.join(' · ');
  }
  /** What a fix changed, in words, for the dish's own page: [text] */
  function fixLines(d, unit) {
    var e = effective(d), out = [];
    if (e.alt) out.push('On the stovetop instead of the oven (' + dur(e.cook) + ').');
    if (e.est) out.push('At ' + tempText(e.temp, unit) + ' instead of ' + tempText(d.temp, unit) + ' to share the oven: about ' + dur(e.cook) + ' instead of ' + dur(d.cook) + ' - an estimate.');
    if (e.early) out.push('Out ' + dur(e.early) + ' early to free the oven; it waits covered.');
    return out;
  }

  return {
    LIMITS: LIMITS, MIN: MIN, TOLERANCE_F: TOLERANCE_F, SAME_F: SAME_F, sameTemp: sameTemp, HEAT_MIN: HEAT_MIN, GRACE_MIN: GRACE_MIN, SAFE: SAFE,
    fail: fail, own: own, isObj: isObj, clone: clone,
    str: str, line: line, esc: esc, norm: norm, cleanName: cleanName, refuse: refuse, field: field, plural: plural, listNames: listNames, initials: initials,
    newId: newId, isId: isId, CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN, normalizeCode: normalizeCode, isCode: isCode, formatCode: formatCode, isGid: isGid, COLORS: COLORS,
    isDay: isDay, addDays: addDays, daysBetween: daysBetween, weekday: weekday, dayLong: dayLong, dayLabel: dayLabel, utcDay: utcDay,
    isZone: isZone, zoneParts: zoneParts, offsetMin: offsetMin, zoneLocal: zoneLocal, zoneDay: zoneDay, isLocal: isLocal, zonedToUtc: zonedToUtc, zoneAbbr: zoneAbbr, zoneCity: zoneCity, clock: clock, clockAt: clockAt, COMMON_ZONES: COMMON_ZONES,
    intIn: intIn, round5: round5, ceil5: ceil5, dur: dur, fToC: fToC, cToF: cToF, tempText: tempText, tempNumber: tempNumber, adjust: adjust, until: until,
    TURKEY: TURKEY, TURKEY_LB: TURKEY_LB, LB_PER_KG: LB_PER_KG, turkeyMinutes: turkeyMinutes,
    PRESETS: PRESETS, PRESET_IDS: PRESET_IDS, METHODS: METHODS, METHOD_IDS: METHOD_IDS, fromPreset: fromPreset, safeLine: safeLine,
    cleanDinner: cleanDinner, isClock: isClock, cleanFix: cleanFix, cleanDish: cleanDish, cleanDraft: cleanDraft,
    effective: effective, basePlan: basePlan, liveTimes: liveTimes, plan: plan, stepText: stepText, movedText: movedText, lower: lower,
    isKey: isKey, act: act, patch: patch, expired: expired,
    memberIds: memberIds, view: view, memberOf: memberOf, dishLine: dishLine, fixLines: fixLines,
  };
});
