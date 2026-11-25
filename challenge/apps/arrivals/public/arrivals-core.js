/* Arrivals - the rules, in one file, run three times: in the page
 * (window.ArrivalsCore), on the server and in the tests (require).
 *
 * Time zones (a wall-clock time at an airport becomes one instant, and that
 * instant is shown in the gathering's own zone), days, what a trip is and
 * how it is cleaned, the one door every change to a gathering goes through
 * (act), what a phone is shown (view), the board, who still needs a ride,
 * pickups that clash, pickups that could be one run, a driver's runs, the
 * day's plan in words, text cleaning, ids and codes.
 *
 * NO CLOCK AND NO DICE: "now", "today" and every new id are handed in
 * (tested), so the same input gives the same output on every phone and on
 * the server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArrivalsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    members: 40,       // people in one gathering
    trips: 120,        // arrivals and departures in one gathering
    name: 20,          // a first name
    who: 40,           // who is travelling ("Ana + the kids")
    title: 40,         // the gathering's name
    place: 40,         // where everyone is headed ("Mom's house")
    from: 40,          // where a trip starts
    hub: 40,           // the airport or station
    carrier: 24,
    number: 8,
    note: 140,
    party: 12,
    bags: 12,
    delay: 720,        // minutes late, at most
    spanDays: 30,      // a gathering lasts at most this long
    aheadDays: 400,    // and starts at most this far ahead
    slackDays: 7,      // a trip may be this many days outside the dates
    keepDays: 14,      // a gathering is deleted this long after its last day
    pasteChars: 6000,  // a pasted confirmation
    drafts: 4,         // trips read from one confirmation
  };
  var COMBINE_MIN = 45;   // same place within this: one run could get both
  var NEARBY_MIN = 60;    // different places within this: two drivers
  var CLASH_MIN = 90;     // one driver, two places, closer than this: a clash
  var STALE_MS = 6 * 3600000; // a ride this long past no longer raises a flag
  var OVERDUE_MIN = 20;   // past its time by this, with no update: "due"

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
  /** Why a piece of free text is not kept - or ''. Arrivals collects no
   *  email address and no phone number from anyone, and this is where that
   *  is held: every text field of a gathering and a trip passes here. */
  function refuse(v) {
    var s = str(v);
    if (/[@＠﹫]/.test(s)) return 'No email addresses, please - Arrivals keeps names and travel details only.';
    if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(s)) return 'No links, please.';
    if (/\p{Nd}(?:[\s.\-()]*\p{Nd}){6}/u.test(s)) return 'No phone numbers or long numbers, please - Arrivals keeps names and travel details only.';
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
   * A trip is typed as a wall-clock time AT THE PLACE IT HAPPENS ("lands
   * 3:10 PM at O'Hare") with that place's IANA zone. zonedToUtc turns the
   * two into one instant, which is what is sorted, compared and stored;
   * zoneLocal turns an instant back into a wall-clock time in any zone, so
   * the board shows every trip in the gathering's own zone whatever zone
   * the trip was typed in and wherever the phone is.
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
   * A gathering's own details
   * ------------------------------------------------------------------ */

  /** {title, place, from, to, tz}, checked against the server's day. */
  function cleanGathering(b, today) {
    b = isObj(b) ? b : {};
    var place = field(b.place, LIMITS.place, 'Where');
    if (!place) throw fail(400, 'Say where everyone is headed - “Mom’s house” is plenty.');
    var title = field(b.title, LIMITS.title, 'Name') || place;
    if (!isDay(b.from)) throw fail(400, 'Pick the first day.');
    var to = isDay(b.to) ? b.to : b.from;
    if (to < b.from) throw fail(400, 'The last day is before the first.');
    if (daysBetween(b.from, to) > LIMITS.spanDays) throw fail(400, 'A gathering can run up to ' + LIMITS.spanDays + ' days.');
    if (b.from < addDays(today, -3) || b.from > addDays(today, LIMITS.aheadDays)) throw fail(400, 'Pick dates from this week up to about a year ahead.');
    if (!isZone(b.tz)) throw fail(400, 'Pick the time zone of the place everyone is headed.');
    return { title: title, place: place, from: b.from, to: to, tz: b.tz };
  }

  /* ------------------------------------------------------------------ *
   * A trip: one arrival or one departure
   *
   *   {dir: 'in'|'out', who, mode, from, carrier, number, hub, local, tz,
   *    at, party, bags, seat, note, status, delay, ride: {k, mid?}, by, ts}
   *
   * `local` is the wall-clock time at `hub` (an arrival's landing time, a
   * departure's leaving time) in `tz`; `at` is that instant, worked out
   * HERE - a phone never sends one. `delay` is minutes late.
   * ------------------------------------------------------------------ */

  var MODES = {
    flight: { label: 'Flight', hub: 'Airport', hubHint: 'ORD, or “O’Hare”', arrive: 'lands', arrived: 'Landed', lead: 90 },
    train: { label: 'Train', hub: 'Station', hubHint: 'Union Station', arrive: 'pulls in', arrived: 'At the station', lead: 30 },
    bus: { label: 'Bus', hub: 'Stop or station', hubHint: 'Downtown bus station', arrive: 'pulls in', arrived: 'At the stop', lead: 30 },
    car: { label: 'Driving', hub: '', hubHint: '', arrive: 'rolls in', arrived: 'Here', lead: 0 },
  };
  var MODE_IDS = ['flight', 'train', 'bus', 'car'];
  function isMode(v) { return typeof v === 'string' && own(MODES, v); }
  // An arrival moves scheduled -> on the way -> landed -> here (a drive has
  // no "landed"); a departure scheduled -> left.
  function statuses(t) { return t.dir === 'out' ? ['sched', 'left'] : (t.mode === 'car' ? ['sched', 'way', 'here'] : ['sched', 'way', 'landed', 'here']); }
  function done(t) { return t.status === 'here' || t.status === 'left'; }
  /** The instant it is now expected. */
  function expected(t) { return t.at + (t.delay || 0) * 60000; }
  /** When a driver has to be there: an arrival's expected time; for a
   *  departure, ahead of it by the usual margin (90 minutes for a flight,
   *  30 for a train or bus). A stated rule, not a prediction. */
  function meetAt(t) { return expected(t) - (t.dir === 'out' ? MODES[t.mode].lead * 60000 : 0); }
  /** What the board says: here | left | landed | delayed | way | sched */
  function stateOf(t) {
    if (done(t) || t.status === 'landed') return t.status;
    if (t.delay > 0) return 'delayed';
    return t.status === 'way' ? 'way' : 'sched';
  }
  function delayText(min) { return min >= 60 ? (min % 60 ? Math.floor(min / 60) + ' h ' + (min % 60) + ' min' : plural(min / 60, 'hour')) : min + ' min'; }
  function stateLabel(t) {
    var s = stateOf(t);
    if (s === 'here') return 'Here';
    if (s === 'left') return 'Left';
    if (s === 'landed') return MODES[t.mode].arrived;
    if (s === 'delayed') return 'Delayed ' + delayText(t.delay);
    if (s === 'way') return 'On the way';
    return 'Scheduled';
  }
  /** The next one-tap step, or null: {status, label} */
  function nextStep(t) {
    var list = statuses(t), i = list.indexOf(t.status);
    if (i < 0 || i === list.length - 1) return null;
    var n = list[i + 1];
    return { status: n, label: n === 'way' ? 'On the way' : n === 'landed' ? (t.mode === 'flight' ? 'Landed' : 'Arrived') : n === 'here' ? 'Here' : 'Left' };
  }
  /** "UA 1482" */
  function carrierLine(t) { return [t.carrier, t.number].filter(Boolean).join(' '); }
  /** The key two hubs share when they are the same place: an airport code
   *  where there is one ("ORD", "O'Hare (ORD)", "ORD Terminal 3"), else the
   *  words with the filler taken out. '' when no place was given. */
  function hubKey(v) {
    var s = line(v, 80);
    var m = /\(([A-Za-z]{3})\)/.exec(s) || /^([A-Za-z]{3})$/.exec(s) || /(?:^|[\s,/-])([A-Z]{3})(?=$|[\s,/-])/.exec(s);
    if (m) return m[1].toUpperCase();
    return norm(s).replace(/\b(airport|station|international|intl|terminal|the|bus|train|depot|stop)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function intIn(v, lo, hi, dflt) {
    var n = typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
  }
  /** What was typed, made into a trip - or refused with a reason. `g` is
   *  the gathering (its dates bound the time); `prev` an existing trip
   *  being edited (its status, delay and ride are kept). */
  function cleanTrip(b, g, prev) {
    b = isObj(b) ? b : {};
    var dir = b.dir === 'out' ? 'out' : 'in';
    var who = field(b.who, LIMITS.who, 'Who');
    if (!/\p{L}/u.test(who)) throw fail(400, 'Say who is travelling.');
    if (!isMode(b.mode)) throw fail(400, 'Pick how they are travelling.');
    var mode = b.mode, car = mode === 'car';
    var tz = b.tz === undefined || b.tz === null || b.tz === '' ? g.tz : b.tz;
    if (!isZone(tz)) throw fail(400, 'That time zone is not one Arrivals knows.');
    if (!isLocal(b.local)) throw fail(400, 'Pick the day and the time.');
    var day = b.local.slice(0, 10);
    if (day < addDays(g.from, -LIMITS.slackDays) || day > addDays(g.to, LIMITS.slackDays)) throw fail(400, 'That day is more than a week outside this gathering’s dates (' + dateRange(g.from, g.to) + ').');
    var number = car ? '' : field(b.number, LIMITS.number + 4, 'Number').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.number);
    var t = {
      dir: dir, who: who, mode: mode,
      from: field(b.from, LIMITS.from, dir === 'out' ? 'Going to' : 'From'),
      carrier: car ? '' : field(b.carrier, LIMITS.carrier, 'Carrier'),
      number: number,
      hub: car ? '' : field(b.hub, LIMITS.hub, MODES[mode].hub),
      local: b.local, tz: tz, at: zonedToUtc(b.local, tz),
      party: intIn(b.party, 1, LIMITS.party, 1),
      bags: intIn(b.bags, 0, LIMITS.bags, 0),
      seat: b.seat === true,
      note: field(b.note, LIMITS.note, 'Notes'),
      status: prev && statuses({ dir: dir, mode: mode }).indexOf(prev.status) >= 0 ? prev.status : 'sched',
      delay: prev ? intIn(prev.delay, 0, LIMITS.delay, 0) : 0,
      ride: car ? { k: 'self' } : (prev && prev.ride && prev.ride.k !== 'self' ? cleanRide(prev.ride) : { k: b.own === true ? 'own' : 'none' }),
    };
    if (!okTime(t.at)) throw fail(400, 'Pick the day and the time.');
    return t;
  }
  function cleanRide(r) {
    r = isObj(r) ? r : {};
    if (r.k === 'driver' && isId(r.mid)) return { k: 'driver', mid: r.mid };
    return { k: r.k === 'own' ? 'own' : r.k === 'self' ? 'self' : 'none' };
  }
  /** A draft read from a confirmation: every field cleaned, anything out of
   *  shape left blank for the person to fill. Never throws. */
  function cleanDraft(raw, g) {
    var r = isObj(raw) ? raw : {};
    function soft(v, max) { return refuse(v) ? '' : line(v, max); }
    var mode = isMode(r.mode) ? r.mode : 'flight';
    var local = isLocal(r.local) && r.local.slice(0, 10) >= addDays(g.from, -LIMITS.slackDays) && r.local.slice(0, 10) <= addDays(g.to, LIMITS.slackDays) ? r.local : '';
    return {
      dir: r.dir === 'out' ? 'out' : 'in',
      who: /\p{L}/u.test(soft(r.who, LIMITS.who)) ? soft(r.who, LIMITS.who) : '',
      mode: mode,
      from: soft(r.from, LIMITS.from),
      carrier: mode === 'car' ? '' : soft(r.carrier, LIMITS.carrier),
      number: mode === 'car' ? '' : soft(r.number, LIMITS.number + 4).toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.number),
      hub: mode === 'car' ? '' : soft(r.hub, LIMITS.hub),
      local: local,
      tz: isZone(r.tz) ? r.tz : g.tz,
      party: intIn(r.party, 1, LIMITS.party, 1),
    };
  }

  /* ------------------------------------------------------------------ *
   * The one door: every change to a gathering's trips and details
   *
   * act(doc, mid, action, ctx) -> {set: {'trips.<id>': ...}, del: [...]},
   * or throws. The server runs it inside a transaction and writes exactly
   * what comes back; the example on the page runs the same function.
   * ctx = {now, id, today} - the clock and the new id are handed in.
   * ------------------------------------------------------------------ */

  function liveMember(doc, mid) { return own(doc.members, mid) && !doc.members[mid].left; }
  function tripOf(doc, id) {
    if (!isId(id) || !own(doc.trips, id)) throw fail(404, 'That trip isn’t on the board any more.', { code: 'no-trip' });
    return doc.trips[id];
  }
  function act(doc, mid, a, ctx) {
    a = isObj(a) ? a : {};
    var t, id, set = {}, k = typeof a.t === 'string' ? a.t : '';
    if (k === 'add') {
      if (Object.keys(doc.trips || {}).length >= LIMITS.trips) throw fail(409, 'This gathering has ' + LIMITS.trips + ' trips - the most one board holds.', { code: 'full' });
      t = cleanTrip(a.trip, doc, null);
      t.by = mid; t.ts = ctx.now;
      set['trips.' + ctx.id] = t;
      return { set: set, del: [] };
    }
    if (k === 'edit') {
      var prev = tripOf(doc, a.id);
      t = cleanTrip(a.trip, doc, prev);
      t.by = prev.by; t.ts = ctx.now;
      if (t.ride.k === 'driver' && !liveMember(doc, t.ride.mid)) t.ride = { k: 'none' };
      set['trips.' + a.id] = t;
      return { set: set, del: [] };
    }
    if (k === 'del') { tripOf(doc, a.id); return { set: {}, del: ['trips.' + a.id] }; }
    if (k === 'status') {
      t = tripOf(doc, a.id);
      if (statuses(t).indexOf(a.status) < 0) throw fail(400, 'That isn’t a step this trip has.');
      set['trips.' + a.id + '.status'] = a.status;
      set['trips.' + a.id + '.ts'] = ctx.now;
      return { set: set, del: [] };
    }
    if (k === 'delay') {
      // `add` moves it (two phones tapping +20 make +40); `set` names it.
      t = tripOf(doc, a.id);
      var d = own(a, 'set') ? intIn(a.set, 0, LIMITS.delay, null) : (typeof a.add === 'number' && Number.isInteger(a.add) && Math.abs(a.add) <= LIMITS.delay ? Math.max(0, Math.min(LIMITS.delay, (t.delay || 0) + a.add)) : null);
      if (d === null) throw fail(400, 'A delay is in whole minutes, up to ' + (LIMITS.delay / 60) + ' hours.');
      set['trips.' + a.id + '.delay'] = d;
      set['trips.' + a.id + '.ts'] = ctx.now;
      return { set: set, del: [] };
    }
    if (k === 'ride') {
      var ids = Array.isArray(a.ids) ? a.ids.slice(0, 12) : [a.id];
      if (!ids.length) throw fail(400, 'Pick a trip.');
      var ride = a.k === 'driver' ? { k: 'driver', mid: a.mid === undefined ? mid : a.mid } : { k: a.k === 'own' ? 'own' : 'none' };
      if (ride.k === 'driver' && !liveMember(doc, ride.mid)) throw fail(400, 'That driver isn’t in this gathering.');
      for (var i = 0; i < ids.length; i++) {
        id = ids[i]; t = tripOf(doc, id);
        if (t.mode === 'car') throw fail(400, t.who + ' is driving - no ride needed.');
        set['trips.' + id + '.ride'] = ride;
        set['trips.' + id + '.ts'] = ctx.now;
      }
      return { set: set, del: [] };
    }
    if (k === 'details') {
      if (!own(doc.members, mid) || !doc.members[mid].host) throw fail(403, 'Only whoever started the gathering can change that.', { code: 'not-host' });
      var g = cleanGathering({ title: a.title, place: a.place, from: a.from, to: a.to, tz: a.tz }, ctx.today < doc.from ? ctx.today : doc.from);
      return { set: { title: g.title, place: g.place, from: g.from, to: g.to, tz: g.tz }, del: [] };
    }
    throw fail(400, 'That is not something Arrivals does.');
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

  /** The last day anything happens: the gathering's last day or its latest
   *  trip. The gathering is deleted keepDays after it. */
  function lastDay(doc) {
    var d = isDay(doc.to) ? doc.to : '2000-01-01';
    Object.keys(doc.trips || {}).forEach(function (k) { var l = doc.trips[k] && doc.trips[k].local; if (isLocal(l) && l.slice(0, 10) > d) d = l.slice(0, 10); });
    return d;
  }
  function expired(doc, today) { return today > addDays(lastDay(doc), LIMITS.keepDays); }

  /* ------------------------------------------------------------------ *
   * What one phone is shown: never a key hash, never an owner tag
   * ------------------------------------------------------------------ */

  function memberIds(doc) {
    return Object.keys(doc.members || {}).sort(function (a, b) { var x = doc.members[a].joinedAt || '', y = doc.members[b].joinedAt || ''; return x < y ? -1 : x > y ? 1 : (a < b ? -1 : 1); });
  }
  function view(doc, mid) {
    var members = memberIds(doc).map(function (id) { var m = doc.members[id]; return { id: id, name: m.name, c: m.c || 0, host: Boolean(m.host), left: Boolean(m.left), me: id === mid }; });
    var trips = Object.keys(doc.trips || {}).map(function (id) {
      var t = doc.trips[id];
      return { id: id, dir: t.dir, who: t.who, mode: t.mode, from: t.from, carrier: t.carrier, number: t.number, hub: t.hub, local: t.local, tz: t.tz, at: t.at, party: t.party, bags: t.bags, seat: Boolean(t.seat), note: t.note, status: t.status, delay: t.delay || 0, ride: cleanRide(t.ride), mine: t.by === mid };
    });
    return { id: doc.id, code: doc.code, title: doc.title, place: doc.place, from: doc.from, to: doc.to, tz: doc.tz, v: doc.v || 0, me: mid, host: Boolean(own(doc.members, mid) && doc.members[mid].host), members: members, trips: trips, keptUntil: addDays(lastDay(doc), LIMITS.keepDays) };
  }
  function memberOf(v, mid) { for (var i = 0; i < v.members.length; i++) if (v.members[i].id === mid) return v.members[i]; return null; }
  function driverOf(v, t) { var m = t.ride.k === 'driver' ? memberOf(v, t.ride.mid) : null; return m && !m.left ? m : null; }

  /* ------------------------------------------------------------------ *
   * The board
   * ------------------------------------------------------------------ */

  function byTime(a, b) { return expected(a) - expected(b) || (a.id < b.id ? -1 : 1); }
  /** Does this trip still need someone to drive? (Not a drive of their
   *  own, not finished, not making their own way.) */
  function wantsRide(t) { return t.mode !== 'car' && !done(t) && t.ride.k !== 'own'; }
  /** "Sam is picking up" / "Needs a ride" / "Own way" / "Driving" */
  function rideLine(v, t) {
    if (t.mode === 'car') return { k: 'self', text: 'Driving' };
    if (t.ride.k === 'own') return { k: 'own', text: 'Making their own way' };
    var d = driverOf(v, t);
    if (d && done(t)) return { k: 'driver', text: (d.me ? 'You ' : d.name + ' ') + (t.dir === 'out' ? 'dropped them off' : 'picked them up'), mid: d.id };
    if (d) return { k: 'driver', text: (d.me ? 'You’re ' : d.name + ' is ') + (t.dir === 'out' ? 'dropping off' : 'picking up'), mid: d.id };
    return { k: 'none', text: done(t) ? 'No ride noted' : (t.dir === 'out' ? 'Needs a lift there' : 'Needs a ride') };
  }
  /** Everything the board draws, from one view and the time now:
   *  {days: [{day, label, rows}], out: [{day, label, rows}], counts, zone}.
   *  A row is the trip plus what to show: the day and clock in the
   *  gathering's zone, the scheduled clock when it has moved, its state. */
  function board(v, now) {
    var today = zoneDay(now, v.tz);
    function row(t) {
      var ex = expected(t), loc = zoneLocal(ex, v.tz), st = stateOf(t);
      return {
        t: t, day: loc.slice(0, 10), clock: clock(loc.slice(11)),
        was: t.delay > 0 ? clockAt(t.at, v.tz) : '',
        // Typed in another zone than the gathering's: say what it read there.
        there: t.tz !== v.tz && offsetMin(ex, t.tz) !== offsetMin(ex, v.tz) ? clockAt(ex, t.tz) + ' ' + zoneAbbr(ex, t.tz) : '',
        state: st, label: stateLabel(t), next: nextStep(t),
        due: !done(t) && t.status !== 'landed' && now - ex > OVERDUE_MIN * 60000,
        ride: rideLine(v, t),
      };
    }
    function group(list) {
      var days = [], at = {};
      list.sort(byTime).forEach(function (t) {
        var r = row(t);
        if (!own(at, r.day)) { at[r.day] = { day: r.day, label: dayLabel(r.day, today), rows: [] }; days.push(at[r.day]); }
        at[r.day].rows.push(r);
      });
      return days;
    }
    var ins = v.trips.filter(function (t) { return t.dir !== 'out'; }), outs = v.trips.filter(function (t) { return t.dir === 'out'; });
    var people = function (list) { return list.reduce(function (n, t) { return n + t.party; }, 0); };
    return {
      today: today,
      days: group(ins), out: group(outs),
      counts: {
        coming: people(ins), here: people(ins.filter(function (t) { return t.status === 'here'; })),
        delayed: ins.concat(outs).filter(function (t) { return stateOf(t) === 'delayed'; }).length,
        noRide: v.trips.filter(function (t) { return wantsRide(t) && !driverOf(v, t); }).length,
      },
      zone: zoneCity(v.tz) + ' time' + (zoneAbbr(now, v.tz) && zoneAbbr(now, v.tz) !== zoneCity(v.tz) ? ' (' + zoneAbbr(now, v.tz) + ')' : ''),
    };
  }

  /* ------------------------------------------------------------------ *
   * Gaps, clashes and runs that could be one
   * ------------------------------------------------------------------ */

  /** The rides still to be driven, with what the checks need. */
  function rides(v, now) {
    return v.trips.filter(function (t) { return wantsRide(t) && meetAt(t) > now - STALE_MS; }).map(function (t) {
      var d = driverOf(v, t);
      return { t: t, key: hubKey(t.hub), at: meetAt(t), driver: d ? d.id : null };
    }).sort(function (a, b) { return a.at - b.at || (a.t.id < b.t.id ? -1 : 1); });
  }
  function mins(a, b) { return Math.abs(a - b) / 60000; }
  /** What needs someone's attention, worst first:
   *   clash     - ONE driver due at two different places less than 90
   *               minutes apart
   *   twoplaces - two rides at different places within the hour, and not
   *               two drivers on them yet
   *   noride    - nobody is down to drive this one */
  function issues(v, now) {
    var R = rides(v, now), out = [], i, j;
    for (i = 0; i < R.length; i++) for (j = i + 1; j < R.length; j++) {
      var a = R[i], b = R[j];
      if (!a.key || !b.key || a.key === b.key) continue;
      if (a.driver && a.driver === b.driver && mins(a.at, b.at) < CLASH_MIN) out.push({ kind: 'clash', a: a.t, b: b.t, driver: a.driver, gap: Math.round(mins(a.at, b.at)) });
      else if (a.driver !== b.driver || !a.driver) { if (mins(a.at, b.at) <= NEARBY_MIN && (!a.driver || !b.driver)) out.push({ kind: 'twoplaces', a: a.t, b: b.t, gap: Math.round(mins(a.at, b.at)) }); }
    }
    // Three people at one airport and one at the station is ONE thing to
    // sort out, not three: keep the closest pair for each pair of places.
    var best = {};
    out = out.filter(function (it) {
      if (it.kind !== 'twoplaces') return true;
      var ks = [hubKey(it.a.hub), hubKey(it.b.hub)].sort().join('|');
      if (own(best, ks) && best[ks].gap <= it.gap) return false;
      best[ks] = it; return true;
    }).filter(function (it) { return it.kind !== 'twoplaces' || best[[hubKey(it.a.hub), hubKey(it.b.hub)].sort().join('|')] === it; });
    R.forEach(function (r) { if (!r.driver) out.push({ kind: 'noride', a: r.t }); });
    var rank = { clash: 0, twoplaces: 1, noride: 2 };
    return out.sort(function (x, y) { return rank[x.kind] - rank[y.kind]; });
  }
  /** Rides at the same place within 45 minutes of the first, as clusters. */
  function clusters(list) {
    var by = {}, keys = [], out = [];
    list.forEach(function (r) { var k = r.key || '?' + r.t.id; if (!own(by, k)) { by[k] = []; keys.push(k); } by[k].push(r); });
    keys.forEach(function (k) {
      var cur = null;
      by[k].forEach(function (r) {
        if (cur && mins(r.at, cur[0].at) <= COMBINE_MIN) cur.push(r);
        else { cur = [r]; out.push(cur); }
      });
    });
    return out.sort(function (a, b) { return a[0].at - b[0].at; });
  }
  /** Rides that one trip could cover: same place, within 45 minutes, and
   *  not already all with one driver. {hub, trips, people, span, driver} -
   *  `driver` is the one already down for part of it, if exactly one is. */
  function combos(v, now) {
    return clusters(rides(v, now)).filter(function (c) {
      if (c.length < 2 || !c[0].key) return false;
      return !(c[0].driver && c.every(function (r) { return r.driver === c[0].driver; }));
    }).map(function (c) {
      var drivers = c.map(function (r) { return r.driver; }).filter(function (d, i, all) { return d && all.indexOf(d) === i; });
      return {
        hub: c[0].t.hub, trips: c.map(function (r) { return r.t; }),
        people: c.reduce(function (n, r) { return n + r.t.party; }, 0),
        span: Math.round(mins(c[c.length - 1].at, c[0].at)),
        driver: drivers.length === 1 ? drivers[0] : null,
      };
    });
  }
  /** One driver's runs, in order: each a place, a time to be there, and
   *  everyone to collect or drop (rides at one place within 45 minutes are
   *  one run). Finished rides are left out. */
  function runs(v, mid, now) {
    var mine = rides(v, now === undefined ? 0 : now).filter(function (r) { return r.driver === mid; });
    return clusters(mine).map(function (c) {
      var first = c[0], last = c[c.length - 1];
      return {
        day: zoneDay(first.at, v.tz), at: first.at, until: last.at, hub: first.t.hub,
        clock: clockAt(first.at, v.tz) + (last.at - first.at >= 60000 ? ' - ' + clockAt(last.at, v.tz) : ''),
        trips: c.map(function (r) { return r.t; }),
        people: c.reduce(function (n, r) { return n + r.t.party; }, 0),
        bags: c.reduce(function (n, r) { return n + r.t.bags; }, 0),
        seat: c.some(function (r) { return r.t.seat; }),
      };
    });
  }
  /** Who is driving at all, in member order, with their runs. */
  function drivers(v, now) {
    return v.members.map(function (m) { return { m: m, runs: runs(v, m.id, now) }; }).filter(function (d) { return d.runs.length; });
  }

  /* ------------------------------------------------------------------ *
   * Words
   * ------------------------------------------------------------------ */

  function partyText(t) { return t.party > 1 ? t.who + ' (' + t.party + ')' : t.who; }
  /** "UA 1482 from Denver" / "Driving from Minneapolis" */
  function tripLine(t) {
    var c = carrierLine(t), bits = [];
    if (t.mode === 'car') bits.push('Driving'); else bits.push(c || MODES[t.mode].label);
    if (t.from) bits.push((t.dir === 'out' ? 'to ' : 'from ') + t.from);
    return bits.join(' ');
  }
  function extras(t) {
    var x = [];
    if (t.party > 1) x.push(t.party + ' people');
    if (t.bags) x.push(plural(t.bags, 'bag'));
    if (t.seat) x.push('car seat');
    return x.join(' · ');
  }
  function issueText(v, it) {
    var c = function (t) { return clockAt(meetAt(t), v.tz); };
    if (it.kind === 'clash') { var d = memberOf(v, it.driver); return (d && d.me ? 'You are' : (d ? d.name : 'One driver') + ' is') + ' down for ' + it.a.who + ' at ' + it.a.hub + ' (' + c(it.a) + ') and ' + it.b.who + ' at ' + it.b.hub + ' (' + c(it.b) + ') - ' + (it.gap ? it.gap + ' minutes apart' : 'at the same time') + ', two different places.'; }
    if (it.kind === 'twoplaces') return it.a.who + ' at ' + it.a.hub + ' (' + c(it.a) + ') and ' + it.b.who + ' at ' + it.b.hub + ' (' + c(it.b) + ') are ' + (it.gap ? it.gap + ' minutes apart' : 'at the same time') + ' at different places - that takes two drivers.';
    return it.a.who + (it.a.dir === 'out' ? ' needs a lift to ' : ' needs a ride from ') + (it.a.hub || 'their ' + MODES[it.a.mode].label.toLowerCase()) + (it.a.dir === 'out' ? ' - there by ' : ' - ') + c(it.a) + '.';
  }
  /** With `today` (a zone day), a run on another day starts with its day:
   *  "Sunday, Nov 29: Ana (3:15 PM) and Ben (3:40 PM) ...". */
  function comboText(v, c, today) {
    var day = today ? zoneDay(meetAt(c.trips[0]), v.tz) : '';
    return (today && day !== today ? dayLabel(day, today) + ': ' : '') + listNames(c.trips.map(function (t) { return t.who + ' (' + clockAt(meetAt(t), v.tz) + ')'; })) + (c.trips.length === 2 ? ' are both at ' : ' are all at ') + c.hub + ' within ' + (c.span || 1) + ' minutes - one run could ' + (c.trips.every(function (t) { return t.dir === 'out'; }) ? 'take ' : 'get ') + (c.trips.length === 2 ? 'both' : 'everyone') + ' (' + plural(c.people, 'person', 'people') + ').';
  }
  /** One day's plan in plain lines, for the host to read or send: every
   *  arrival and departure that day in the gathering's zone, who is
   *  driving, and what is still open. Rules, not a model. */
  function briefing(v, day, now) {
    var b = board(v, now), L = [];
    L.push(v.title + ' - ' + dayLong(day) + ', ' + b.zone);
    function rows(groups, verb) {
      groups.filter(function (g) { return g.day === day; }).forEach(function (g) {
        g.rows.forEach(function (r) {
          var t = r.t;
          L.push(r.clock + '  ' + t.who + ' ' + (t.dir === 'out' ? 'leaves' : MODES[t.mode].arrive) + (t.hub ? (t.dir === 'out' ? ' from ' : ' at ') + t.hub : '') + ' - ' + tripLine(t) + (r.state === 'delayed' ? ' - ' + r.label.toLowerCase() : '') + ' - ' + (r.ride.k === 'driver' && !/^You/.test(r.ride.text) ? r.ride.text : r.ride.text.charAt(0).toLowerCase() + r.ride.text.slice(1)) + (extras(t) ? ' (' + extras(t).replace(/ · /g, ', ') + ')' : '') + '.');
        });
      });
    }
    rows(b.days); rows(b.out);
    if (L.length === 1) L.push('Nobody is arriving or leaving.');
    var open = issues(v, now).filter(function (it) { return zoneDay(meetAt(it.a), v.tz) === day; });
    if (open.length) { L.push(''); L.push('Still open:'); open.forEach(function (it) { L.push('- ' + issueText(v, it)); }); }
    combos(v, now).filter(function (c) { return zoneDay(meetAt(c.trips[0]), v.tz) === day; }).forEach(function (c) { L.push('- ' + comboText(v, c)); });
    return L.join('\n');
  }

  return {
    LIMITS: LIMITS, COMBINE_MIN: COMBINE_MIN, NEARBY_MIN: NEARBY_MIN, CLASH_MIN: CLASH_MIN, STALE_MS: STALE_MS, OVERDUE_MIN: OVERDUE_MIN,
    fail: fail, own: own, isObj: isObj, clone: clone,
    str: str, line: line, esc: esc, norm: norm, cleanName: cleanName, refuse: refuse, field: field, plural: plural, listNames: listNames, initials: initials,
    newId: newId, isId: isId, CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN, normalizeCode: normalizeCode, isCode: isCode, formatCode: formatCode, isGid: isGid, COLORS: COLORS,
    isDay: isDay, addDays: addDays, daysBetween: daysBetween, weekday: weekday, dayLong: dayLong, dayLabel: dayLabel, dateRange: dateRange, utcDay: utcDay,
    isZone: isZone, zoneParts: zoneParts, offsetMin: offsetMin, zoneLocal: zoneLocal, zoneDay: zoneDay, isLocal: isLocal, zonedToUtc: zonedToUtc, zoneAbbr: zoneAbbr, zoneCity: zoneCity, clock: clock, clockAt: clockAt, COMMON_ZONES: COMMON_ZONES,
    cleanGathering: cleanGathering,
    MODES: MODES, MODE_IDS: MODE_IDS, isMode: isMode, statuses: statuses, done: done, expected: expected, meetAt: meetAt, stateOf: stateOf, stateLabel: stateLabel, delayText: delayText, nextStep: nextStep, carrierLine: carrierLine, hubKey: hubKey,
    cleanTrip: cleanTrip, cleanRide: cleanRide, cleanDraft: cleanDraft,
    act: act, patch: patch, lastDay: lastDay, expired: expired,
    memberIds: memberIds, view: view, memberOf: memberOf, driverOf: driverOf,
    wantsRide: wantsRide, rideLine: rideLine, board: board, rides: rides, issues: issues, combos: combos, runs: runs, drivers: drivers,
    partyText: partyText, tripLine: tripLine, extras: extras, issueText: issueText, comboText: comboText, briefing: briefing,
  };
});
