/* Receipt's rules - everything that needs no model, in one file that runs in
 * the browser AND on the server (server.js requires it).
 *
 *   validateSetup(raw)     a meeting's setup: title, who is in the room as role
 *                          bands with hourly rates (never names with
 *                          salaries), the booked length, a timeboxed agenda,
 *                          the attendee labels actions may be assigned to.
 *   elapsed / live         the meter: time and money from startedAt, the
 *                          pauses and the item marks - stored timestamps
 *                          only, so a locked phone or a reload loses nothing
 *                          and the server never runs a timer.
 *   agenda                 planned vs actual per item, the current item's
 *                          ring, and any overrun in dollars.
 *   receipt                the thermal receipt: cost by band, per item, per
 *                          decision, the room's ROTI and "could have been an
 *                          email" votes, TIME GIVEN BACK.
 *   heat                   an action's clock after the meeting: warm, hot,
 *                          scorching, dropped.
 *   deal / bingoLine       buzzword bingo: a card dealt from a seed, and a
 *                          line checked the same way on both sides.
 *   annualCost / savings   the recurring-meeting tax audit.
 *   scoreboard             weekly totals, the on-time streak, time given back,
 *                          the ROTI trend, badges.
 *
 * One implementation on purpose: the page ticks the meter and draws the
 * receipt with the same arithmetic the server uses to answer, so the room's
 * phone, the facilitator's laptop and the shared link cannot disagree by a
 * cent. Every dollar here is an ESTIMATE from role-band rates, and the page
 * says so.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReceiptRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SEC = 1000;
  var MIN = 60 * SEC;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;

  /* ---------------- vocabulary ---------------- */

  // Loaded hourly cost per person, by role band. Deliberately bands, not
  // people: nobody types a colleague's salary into a meeting app.
  var BANDS = [
    { key: 'exec', label: 'Exec', rate: 200, emoji: '🧭' },
    { key: 'manager', label: 'Manager', rate: 110, emoji: '📋' },
    { key: 'ic', label: 'IC', rate: 85, emoji: '🛠️' },
  ];
  var BAND_KEYS = BANDS.map(function (b) { return b.key; });
  var BLENDED = { key: 'blended', label: 'Everyone', rate: 100, emoji: '👥' };
  // Salary is not the whole cost of an hour: benefits, tax, the desk. 1.3x is
  // the usual rule of thumb, and it is opt-in.
  var LOADED = 1.3;

  var CADENCES = [
    { key: 'daily', label: 'Daily', perYear: 240 },
    { key: 'twiceweekly', label: 'Twice a week', perYear: 96 },
    { key: 'weekly', label: 'Weekly', perYear: 48 },
    { key: 'fortnightly', label: 'Every 2 weeks', perYear: 24 },
    { key: 'monthly', label: 'Monthly', perYear: 12 },
  ];
  var CADENCE_KEYS = CADENCES.map(function (c) { return c.key; });

  var KINDS = [
    { key: 'decision', label: 'Decision', emoji: '✅' },
    { key: 'action', label: 'Action', emoji: '📌' },
    { key: 'parking', label: 'Parking lot', emoji: '🅿️' },
  ];
  var KIND_KEYS = KINDS.map(function (k) { return k.key; });

  // Return On Time Invested, the classic 0-4 retro vote.
  var ROTI = [
    { v: 0, emoji: '😩', label: 'Waste', text: 'I got nothing from it' },
    { v: 1, emoji: '😕', label: 'Less than my time', text: 'Some value, not enough' },
    { v: 2, emoji: '😐', label: 'Break-even', text: 'Worth about what it cost me' },
    { v: 3, emoji: '🙂', label: 'Worth it', text: 'More than my time' },
    { v: 4, emoji: '🤩', label: 'Excellent', text: 'Far more than my time' },
  ];

  // What the ticker compares the bill to. Pings fire when one is passed.
  var MILESTONES = [
    { usd: 5, emoji: '☕', one: 'fancy coffee', many: 'fancy coffees', ping: 'a fancy coffee' },
    { usd: 12, emoji: '🌯', one: 'burrito', many: 'burritos', ping: 'a burrito' },
    { usd: 30, emoji: '💳', one: 'month of a SaaS seat', many: 'months of SaaS seats', ping: 'a month of a SaaS seat' },
    { usd: 75, emoji: '🍕', one: 'pizza party', many: 'pizza parties', ping: 'pizza for the whole team' },
    { usd: 180, emoji: '🎧', one: 'pair of good headphones', many: 'pairs of good headphones', ping: 'a pair of good headphones' },
    { usd: 349, emoji: '📱', one: 'iPad', many: 'iPads', ping: 'the price of an iPad' },
    { usd: 450, emoji: '✈️', one: 'round-trip flight', many: 'round-trip flights', ping: 'a round-trip flight' },
    { usd: 1000, emoji: '💻', one: 'new laptop', many: 'new laptops', ping: 'a new laptop' },
    { usd: 2500, emoji: '🏖️', one: 'week at the beach', many: 'weeks at the beach', ping: 'a week at the beach' },
    { usd: 10000, emoji: '🚗', one: 'used car', many: 'used cars', ping: 'a used car' },
  ];

  var HEAT = [
    { key: 'warm', emoji: '🌤', label: 'Warm', text: 'Plenty of time' },
    { key: 'hot', emoji: '🔥', label: 'Hot', text: 'Due soon' },
    { key: 'scorching', emoji: '🌶️', label: 'Scorching', text: 'Past due' },
    { key: 'dropped', emoji: '💨', label: 'Dropped', text: 'A week past due' },
    { key: 'done', emoji: '✅', label: 'Done', text: 'Done' },
  ];

  var BADGES = [
    { key: 'first', emoji: '🧾', label: 'First Receipt', detail: 'Ran a meeting to its receipt.' },
    { key: 'zerooverrun', emoji: '⏱️', label: 'Zero-Overrun Week', detail: 'Two or more meetings in a week, none over time.' },
    { key: 'killed', emoji: '🪓', label: 'Killed a Meeting', detail: 'Cut a recurring meeting in the audit.' },
    { key: 'cheapdecision', emoji: '💡', label: 'Cost-per-Decision under $50', detail: 'A meeting whose decisions cost under $50 each.' },
  ];

  // Buzzword bingo. Clichés, not people: nothing on a card is about anyone.
  var PHRASES = [
    'Can you see my screen?', 'You’re on mute', 'Let’s take this offline', 'Circle back', 'Double-click on that',
    'Can everyone hear me?', 'Sorry, go ahead', 'I’ll be quick', 'Quick question', 'Low-hanging fruit',
    'Move the needle', 'Synergy', 'Bandwidth', 'Let’s park that', 'Touch base',
    'Going forward', 'At the end of the day', 'Deep dive', 'Alignment', 'Action item',
    'Who just joined?', 'I have a hard stop', 'Ping me', 'Loop in', 'Just to piggyback',
    'Net-net', 'Per my last email', 'Boil the ocean', 'Level-set', 'North star',
    'Pivot', 'Game changer', 'Win-win', 'Put a pin in it', 'Let’s socialize this',
    'Leverage', 'Think outside the box', 'Take it to the next level', 'Paradigm shift', 'Moving parts',
    'On my radar', 'Let’s unpack that', 'Bring it back to', 'Heads down', 'Ballpark figure',
    'Sorry, I was on mute', 'Can we get a quick update?', 'Let’s not reinvent the wheel',
  ];
  var FREE = 12; // the middle square
  var HANDLES = ['🦊', '🐙', '🦉', '🐢', '🦄', '🐝', '🐧', '🦖', '🐳', '🦜', '🐼', '🦔', '🐸', '🦩', '🐨', '🐯'];

  // Free agendas to start from. Minutes add up to the length.
  var TEMPLATES = [
    { key: 'weekly', label: 'Weekly sync', minutes: 30, items: [['Wins and blockers', 5], ['Numbers check', 5], ['The one big issue', 12], ['Decisions and owners', 5], ['Wrap-up', 3]] },
    { key: 'standup', label: 'Stand-up', minutes: 15, items: [['Yesterday and today', 8], ['Blockers', 5], ['Wrap-up', 2]] },
    { key: 'decision', label: 'Decision meeting', minutes: 30, items: [['Context in one slide', 5], ['Options on the table', 10], ['Decide', 10], ['Owners and dates', 5]] },
    { key: 'oneonone', label: '1:1', minutes: 30, items: [['How are things, really?', 5], ['Their topics', 15], ['Feedback both ways', 5], ['Next steps', 5]] },
    { key: 'retro', label: 'Retro', minutes: 45, items: [['What went well', 10], ['What didn’t', 15], ['Ideas', 10], ['Actions and owners', 10]] },
    { key: 'planning', label: 'Planning', minutes: 60, items: [['Goals', 10], ['Priorities', 20], ['Capacity', 15], ['Commitments', 10], ['Wrap-up', 5]] },
  ];

  var LIMITS = {
    title: 80, invite: 2000, outcome: 200,
    items: 12, itemTitle: 80, itemMinutes: 240, itemOwner: 30,
    bookedMin: 5, bookedMax: 480,
    count: 200, headcount: 300, rate: 2000,
    labels: 30, label: 30,
    logText: 200, notes: 20000,
    recurringTitle: 80,
    graceMs: MIN,             // finishing within a minute of the booking is on time
    voteWindowMs: DAY,        // the room can still vote for a day after the end
  };

  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 8;
  var CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

  function find(list, key, fallback) { for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i]; return fallback === undefined ? null : fallback; }
  function bandInfo(k) { return k === 'blended' ? BLENDED : find(BANDS, k, BANDS[2]); }
  function cadenceInfo(k) { return find(CADENCES, k, CADENCES[2]); }
  function kindInfo(k) { return find(KINDS, k, KINDS[0]); }
  function heatInfo(k) { return find(HEAT, k, HEAT[0]); }
  function badgeInfo(k) { return find(BADGES, k); }

  /* ---------------- text ---------------- */

  /** One line: tags stripped, then any stray angle bracket, control
   *  characters and runs of whitespace. Everything here ends up in a page.
   *  The input is cut BEFORE any pattern runs, and the tag pattern stops at
   *  the next '<': a run of '<' with no '>' used to cost O(n^2), and one
   *  signed-in request could hold the lab's whole process for seconds. */
  function clean(v, max) {
    return String(v == null ? '' : v).slice(0, (max || 200) * 4)
      .replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
      .replace(/<[^<>]*>/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 200);
  }

  /** Several lines: the same, newlines kept (one blank line at most), and
   *  markdown emphasis and headings dropped. */
  function cleanText(v, max) {
    return String(v == null ? '' : v).slice(0, (max || 2000) * 4)
      .replace(/\r\n?/g, '\n')
      .replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
      .replace(/<[^<>]*>/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, ' ')
      .split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max || 2000);
  }

  /** Whitespace, case and curly quotes folded - how a quote is matched. */
  function norm(v) {
    return String(v == null ? '' : v).toLowerCase()
      .replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\s+/g, ' ').trim();
  }

  function toNumber(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  function intIn(v, lo, hi) {
    var n = toNumber(v);
    if (n === null || Number.isNaN(n)) return null;
    n = Math.round(n);
    return n < lo || n > hi ? null : n;
  }

  function isoDay(v) {
    var s = String(v || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var d = new Date(s + 'T12:00:00Z');
    return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
  }
  function addDays(day, n) { return new Date(Date.parse(day + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAY); }
  /** The Monday of `day`'s week. */
  function weekOf(day) {
    var d = new Date(day + 'T12:00:00Z');
    var dow = (d.getUTCDay() + 6) % 7;
    return addDays(day, -dow);
  }

  /* ---------------- formatting (page, text receipt and PNG alike) ---------------- */

  function money(usd, cents) {
    var n = Number(usd) || 0;
    var neg = n < 0;
    n = Math.abs(n);
    var s = cents ? n.toFixed(2) : String(Math.round(n));
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-$' : '$') + parts.join('.');
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** 38:22, or 1:02:05 past the hour. */
  function clockText(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    var h = Math.floor(s / 3600); var m = Math.floor((s % 3600) / 60); var sec = s % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(sec) : m + ':' + pad2(sec);
  }
  /** 38m 22s / 1h 5m / 45s. */
  function durText(ms) {
    var s = Math.max(0, Math.round((ms || 0) / 1000));
    var h = Math.floor(s / 3600); var m = Math.floor((s % 3600) / 60); var sec = s % 60;
    if (h) return h + 'h' + (m ? ' ' + m + 'm' : '');
    if (m) return m + 'm' + (sec ? ' ' + sec + 's' : '');
    return sec + 's';
  }
  /** Whole minutes, rounded down: "6 min". Time given back is never rounded up. */
  function minText(ms) { var m = Math.floor(Math.max(0, ms || 0) / MIN); return m + ' min'; }
  function hoursText(h) {
    var n = Number(h) || 0;
    var v = n >= 10 ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(Math.round(n * 10) / 10);
    return v + ' h';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ---------------- who is in the room, and what it costs ---------------- */

  /**
   * The people in the room as role bands. `mode` 'bands' keeps one row per
   * band (a count may be 0); 'blended' is one row at one rate. Nothing here
   * can hold a name: labels for actions are a separate list with no rate.
   */
  function cleanPeople(raw, mode) {
    var rows = Array.isArray(raw) ? raw : [];
    var byKey = {};
    rows.forEach(function (r) { if (r && typeof r === 'object') byKey[String(r.band)] = r; });
    var keys = mode === 'blended' ? ['blended'] : BAND_KEYS;
    return keys.map(function (k) {
      var info = bandInfo(k);
      var r = byKey[k] || {};
      var rate = toNumber(r.rate);
      var count = toNumber(r.count);
      return {
        band: k,
        rate: rate === null ? info.rate : rate,
        count: count === null ? 0 : count,
      };
    });
  }
  function checkPeople(people) {
    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      if (Number.isNaN(p.rate) || p.rate < 0 || p.rate > LIMITS.rate) return 'An hourly rate is a number of dollars up to $' + LIMITS.rate + '.';
      if (Number.isNaN(p.count) || p.count < 0 || p.count > LIMITS.count || Math.round(p.count) !== p.count) return 'A headcount is a whole number up to ' + LIMITS.count + '.';
    }
    var n = headcount({ people: people });
    if (n < 1) return 'Add at least one person.';
    if (n > LIMITS.headcount) return 'That is more than ' + LIMITS.headcount + ' people - this is for meetings, not conferences.';
    return null;
  }
  function headcount(m) { return (m.people || []).reduce(function (s, p) { return s + (Number(p.count) || 0); }, 0); }
  /** Dollars per hour for the whole room. */
  function hourly(m) {
    var base = (m.people || []).reduce(function (s, p) { return s + (Number(p.rate) || 0) * (Number(p.count) || 0); }, 0);
    return base * (m.loaded ? LOADED : 1);
  }
  function bandsInUse(m) { return (m.people || []).filter(function (p) { return p.count > 0; }).map(function (p) { return p.band; }); }
  function costFor(m, ms) { return hourly(m) * Math.max(0, ms || 0) / HOUR; }

  function cleanLabels(raw) {
    var list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,\n]/);
    var out = [];
    var seen = {};
    for (var i = 0; i < list.length && out.length < LIMITS.labels; i++) {
      var t = clean(list[i], LIMITS.label);
      if (!t || seen[t.toLowerCase()]) continue;
      seen[t.toLowerCase()] = true;
      out.push(t);
    }
    return out;
  }
  /** The typed label, in its own spelling, or '' when it is not one. */
  function matchLabel(labels, v) {
    var t = clean(v, LIMITS.label).toLowerCase();
    if (!t) return '';
    for (var i = 0; i < (labels || []).length; i++) if (String(labels[i]).toLowerCase() === t) return labels[i];
    return '';
  }

  function cleanAgenda(raw) {
    var out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (it) {
      if (!it || typeof it !== 'object' || out.length >= LIMITS.items) return;
      var title = clean(it.title, LIMITS.itemTitle);
      if (!title) return;
      out.push({ title: title, minutes: intIn(it.minutes, 1, LIMITS.itemMinutes), owner: clean(it.owner, LIMITS.itemOwner) });
    });
    return out;
  }
  function agendaMinutes(items) { return (items || []).reduce(function (s, it) { return s + (Number(it.minutes) || 0); }, 0); }

  /**
   * A meeting's setup, from the new-meeting form, an edit or an applied
   * sharpener proposal. All or nothing: the first problem is the error.
   * Fields not sent keep `prev`'s.
   * @returns { setup } or { error, field }
   */
  function validateSetup(raw, prev) {
    raw = raw || {};
    prev = prev || {};
    var has = function (k) { return raw[k] !== undefined; };
    var title = has('title') ? clean(raw.title, LIMITS.title) : (prev.title || '');
    if (title.length < 2) return { error: 'Give the meeting a name.', field: 'title' };
    var mode = has('mode') ? (raw.mode === 'blended' ? 'blended' : 'bands') : (prev.mode || 'bands');
    var people = has('people') || has('mode') ? cleanPeople(has('people') ? raw.people : prev.people, mode) : (prev.people || cleanPeople([], mode));
    var pErr = checkPeople(people);
    if (pErr) return { error: pErr, field: 'people' };
    var agenda = has('agenda') ? cleanAgenda(raw.agenda) : (prev.agenda || []);
    for (var i = 0; i < agenda.length; i++) {
      if (agenda[i].minutes === null) return { error: 'Give “' + agenda[i].title + '” a number of minutes (1 to ' + LIMITS.itemMinutes + ').', field: 'agenda' };
    }
    var booked = has('bookedMinutes') ? intIn(raw.bookedMinutes, LIMITS.bookedMin, LIMITS.bookedMax) : (prev.bookedMinutes || null);
    if (has('bookedMinutes') && booked === null) return { error: 'A meeting is booked for ' + LIMITS.bookedMin + ' to ' + LIMITS.bookedMax + ' minutes.', field: 'bookedMinutes' };
    if (booked === null) booked = Math.max(LIMITS.bookedMin, Math.min(LIMITS.bookedMax, agendaMinutes(agenda) || 30));
    if (agendaMinutes(agenda) > booked) return { error: 'The agenda adds up to ' + agendaMinutes(agenda) + ' min, but the meeting is booked for ' + booked + '. Trim an item or book it longer.', field: 'agenda' };
    return {
      setup: {
        title: title,
        mode: mode,
        people: people,
        loaded: has('loaded') ? raw.loaded === true : Boolean(prev.loaded),
        bookedMinutes: booked,
        agenda: agenda,
        labels: has('labels') ? cleanLabels(raw.labels) : (prev.labels || []),
        bingo: has('bingo') ? raw.bingo === true : Boolean(prev.bingo),
        outcome: has('outcome') ? clean(raw.outcome, LIMITS.outcome) : (prev.outcome || ''),
        invite: has('invite') ? cleanText(raw.invite, LIMITS.invite) : (prev.invite || ''),
      },
    };
  }

  /* ---------------- the meter ---------------- */

  function t(iso) { var n = Date.parse(iso); return Number.isFinite(n) ? n : null; }
  function started(m) { return Boolean(m && m.startedAt); }
  function ended(m) { return Boolean(m && m.endedAt); }
  function isPaused(m) {
    if (!started(m) || ended(m)) return false;
    var p = m.pauses || [];
    return p.length > 0 && !p[p.length - 1].until;
  }
  function status(m) { return !started(m) ? 'waiting' : ended(m) ? 'ended' : isPaused(m) ? 'paused' : 'live'; }

  /** Meeting time: from the start to the end (or now), minus every pause. */
  function elapsed(m, now) {
    if (!started(m)) return 0;
    var start = t(m.startedAt);
    var end = ended(m) ? t(m.endedAt) : now;
    var paused = 0;
    (m.pauses || []).forEach(function (p) {
      var a = Math.max(t(p.at), start);
      var b = Math.min(p.until ? t(p.until) : end, end);
      if (b > a) paused += b - a;
    });
    return Math.max(0, end - start - paused);
  }

  /** elapsed() backwards: the wall-clock time (ms) at which the meeting had
   *  run `ms` of meeting time, stepping over the pauses. What "End it at the
   *  booked time" stores as endedAt for a meeting nobody ended. */
  function wallAt(m, ms) {
    var cursor = t(m.startedAt);
    var left = Math.max(0, ms || 0);
    var pauses = (m.pauses || []).map(function (p) { return { a: t(p.at), b: p.until ? t(p.until) : Infinity }; })
      .filter(function (p) { return p.a !== null; })
      .sort(function (x, y) { return x.a - y.a; });
    for (var i = 0; i < pauses.length; i++) {
      var p = pauses[i];
      if (p.b <= cursor) continue;
      var run = Math.max(0, p.a - cursor);
      if (left <= run) return cursor + left;
      if (p.b === Infinity) return Math.max(cursor, p.a); // paused for good: it never ran longer
      left -= run;
      cursor = Math.max(cursor, p.b);
    }
    return cursor + left;
  }

  /**
   * Every agenda item, planned vs actual, from the marks - the meeting time
   * at which each item was closed. The current item is the first without a
   * mark; its ring is how much of its time has gone.
   */
  function agenda(m, now) {
    var el = elapsed(m, now);
    var marks = m.marks || [];
    var perMs = hourly(m) / HOUR;
    var items = (m.agenda || []).map(function (it, i) {
      var plannedMs = (Number(it.minutes) || 0) * MIN;
      var from = i === 0 ? 0 : marks[i - 1];
      var st;
      if (i < marks.length) st = 'done';
      else if (i === marks.length && started(m) && !ended(m)) st = 'current';
      else st = ended(m) ? 'skipped' : 'upcoming';
      var actualMs = st === 'done' ? Math.max(0, marks[i] - from) : st === 'current' ? Math.max(0, el - (from || 0)) : null;
      var overMs = actualMs === null ? 0 : Math.max(0, actualMs - plannedMs);
      return {
        n: i + 1, title: it.title, owner: it.owner || '', minutes: it.minutes,
        state: st, plannedMs: plannedMs, actualMs: actualMs,
        overMs: overMs, overUsd: overMs * perMs,
        underMs: actualMs === null || st === 'current' ? 0 : Math.max(0, plannedMs - actualMs),
        leftMs: st === 'current' ? plannedMs - actualMs : null,
        pct: actualMs === null || !plannedMs ? 0 : Math.min(1, actualMs / plannedMs),
      };
    });
    var current = null;
    for (var i = 0; i < items.length; i++) if (items[i].state === 'current') current = items[i];
    var afterMs = items.length && marks.length >= items.length ? Math.max(0, el - marks[items.length - 1]) : 0;
    return { items: items, current: current, afterMs: afterMs, plannedMs: agendaMinutes(m.agenda) * MIN };
  }

  /** Everything the ticker shows, at `now`. */
  function live(m, now) {
    var el = elapsed(m, now);
    var n = headcount(m);
    var usd = costFor(m, el);
    var booked = (m.bookedMinutes || 0) * MIN;
    return {
      status: status(m),
      elapsedMs: el,
      bookedMs: booked,
      leftMs: booked - el,
      costUsd: usd,
      personHours: n * el / HOUR,
      hourly: hourly(m),
      perMinute: hourly(m) / 60,
      headcount: n,
      compare: compare(usd),
      agenda: agenda(m, now),
    };
  }

  /* ---------------- comparisons ---------------- */

  /** "≈ 3.2 burritos": the biggest thing the bill has passed. */
  function compare(usd) {
    var m = null;
    for (var i = 0; i < MILESTONES.length; i++) if (usd >= MILESTONES[i].usd) m = MILESTONES[i];
    if (!m) return null;
    var n = usd / m.usd;
    var shown = n < 10 ? Math.floor(n * 10) / 10 : Math.floor(n);
    return { emoji: m.emoji, usd: m.usd, count: shown, text: (shown === 1 ? '1 ' + m.one : shown + ' ' + m.many) };
  }
  /** The milestones crossed going from `a` to `b` dollars, for the pings. */
  function crossed(a, b) {
    return MILESTONES.filter(function (m) { return a < m.usd && b >= m.usd; });
  }

  /* ---------------- the log ---------------- */

  /**
   * A decision, an action or a parking-lot item. An action's owner must be
   * one of the meeting's typed labels (or nobody); its due date a real day.
   */
  function validateLog(raw, labels) {
    raw = raw || {};
    var kind = raw.kind;
    if (KIND_KEYS.indexOf(kind) < 0) return { error: 'Log a decision, an action or a parking-lot item.', field: 'kind' };
    var text = clean(raw.text, LIMITS.logText);
    if (text.length < 2) return { error: 'Say what it was, in a few words.', field: 'text' };
    var owner = '';
    var due = null;
    if (kind === 'action') {
      if (raw.owner != null && String(raw.owner).trim()) {
        owner = matchLabel(labels, raw.owner);
        if (!owner) return { error: 'Pick the owner from the meeting’s attendees (or add them to its list).', field: 'owner' };
      }
      if (raw.due != null && raw.due !== '') {
        due = isoDay(raw.due);
        if (!due) return { error: 'The due date is not a date.', field: 'due' };
      }
    }
    return { item: { kind: kind, text: text, owner: owner, due: due } };
  }

  /* ---------------- actions after the meeting: the heat clock ---------------- */

  /**
   * How hot an open action is, from its age against its due date (or a week,
   * when it has none): warm for the first half, hot for the second, scorching
   * once past due, dropped a week after that. Computed on every read; nothing
   * is stored but the dates.
   *
   * A due date is a day on the person's own calendar, so "past due" is
   * decided by `today` - the browser's date, sent as x-local-date - and not
   * by 23:59 UTC, which in California turned an action scorching at 5pm on
   * the day it was due. Without `today`, the UTC date stands in.
   */
  function heat(a, now, today) {
    if (a.doneAt) return { state: 'done', leftMs: null, overMs: 0 };
    var created = t(a.createdAt) || now;
    var dueAt = a.due ? Date.parse(a.due + 'T23:59:59Z') : created + 7 * DAY;
    var day = isoDay(today) || new Date(now).toISOString().slice(0, 10);
    var past = a.due ? day > a.due : now > dueAt;
    if (!past) {
      var windowMs = Math.max(HOUR, dueAt - created);
      return { state: (now - created) / windowMs < 0.5 ? 'warm' : 'hot', leftMs: Math.max(0, dueAt - now), overMs: 0, dueAt: new Date(dueAt).toISOString() };
    }
    var over = Math.max(0, now - dueAt);
    var dropped = a.due ? daysBetween(a.due, day) > 7 : over > 7 * DAY;
    return { state: dropped ? 'dropped' : 'scorching', leftMs: 0, overMs: over, dueAt: new Date(dueAt).toISOString() };
  }
  var HEAT_RANK = { dropped: 0, scorching: 1, hot: 2, warm: 3, done: 4 };
  /** Open actions, hottest first - dropped ones last among the open, since
   *  late still beats never but scorching is the one to chase. */
  function byHeat(actions, now, today) {
    return actions.map(function (a) { return { action: a, heat: heat(a, now, today) }; })
      .filter(function (r) { return r.heat.state !== 'done'; })
      .sort(function (x, y) {
        var rx = x.heat.state === 'dropped' ? 9 : HEAT_RANK[x.heat.state];
        var ry = y.heat.state === 'dropped' ? 9 : HEAT_RANK[y.heat.state];
        return rx - ry || (x.heat.leftMs - y.heat.leftMs) || String(x.action.createdAt).localeCompare(String(y.action.createdAt));
      });
  }

  /* ---------------- the room: ROTI, email votes, bingo ---------------- */

  function validRoti(v) { return v === null ? null : (intIn(v, 0, 4)); }
  function rotiSummary(votes) {
    var dist = [0, 0, 0, 0, 0];
    var sum = 0;
    var n = 0;
    (votes || []).forEach(function (v) {
      if (v && typeof v.roti === 'number' && v.roti >= 0 && v.roti <= 4) { dist[v.roti]++; sum += v.roti; n++; }
    });
    return { n: n, avg: n ? Math.round(sum / n * 10) / 10 : null, dist: dist };
  }

  /** A small, fast, seeded shuffle - so a card can be dealt again anywhere. */
  function hash32(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function rng(seed) {
    var a = hash32(seed);
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** 25 squares for one person in one meeting: 24 clichés and a free middle. */
  function deal(seed) {
    var r = rng('bingo:' + seed);
    var idx = PHRASES.map(function (_, i) { return i; });
    for (var i = idx.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; }
    var cells = idx.slice(0, 24).map(function (i) { return PHRASES[i]; });
    cells.splice(FREE, 0, 'FREE');
    return cells;
  }
  var LINES = (function () {
    var out = [];
    for (var r = 0; r < 5; r++) out.push([0, 1, 2, 3, 4].map(function (c) { return r * 5 + c; }));
    for (var c = 0; c < 5; c++) out.push([0, 1, 2, 3, 4].map(function (r) { return r * 5 + c; }));
    out.push([0, 6, 12, 18, 24]);
    out.push([4, 8, 12, 16, 20]);
    return out;
  })();
  function cleanMarks(raw) {
    var out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (v) {
      var n = intIn(v, 0, 24);
      if (n !== null && out.indexOf(n) < 0) out.push(n);
    });
    return out.sort(function (a, b) { return a - b; });
  }
  /** The first complete line, or null. The middle is always marked. */
  function bingoLine(marks) {
    var set = {};
    cleanMarks(marks).forEach(function (n) { set[n] = true; });
    set[FREE] = true;
    for (var i = 0; i < LINES.length; i++) {
      if (LINES[i].every(function (n) { return set[n]; })) return LINES[i];
    }
    return null;
  }

  /* ---------------- the receipt ---------------- */

  function verdict(r) {
    if (!r.ended) return { key: 'live', emoji: '⏱️', text: 'Still running.' };
    var voters = r.voters;
    if (voters >= 2 && r.emailVotes * 2 > voters) return { key: 'email', emoji: '📧', text: 'The room thinks this could have been an email.' };
    if (r.roti.n) {
      if (r.roti.avg >= 3) return { key: 'worth', emoji: '🏆', text: 'Worth it - the room says so.' };
      if (r.roti.avg >= 2) return { key: 'fair', emoji: '👍', text: 'Worth it, just. Tighten the agenda and it pays.' };
      return { key: 'costly', emoji: '🧾', text: 'The room paid more than it got back.' };
    }
    if (!r.counts.decision) return { key: 'nodecision', emoji: '🫥', text: 'No decisions logged - a status update could have done this.' };
    return { key: 'novotes', emoji: '🗳️', text: 'No votes yet - share the room code next time.' };
  }

  /**
   * The receipt, from the meeting, its log and the room's votes. Votes are
   * anonymous rows ({roti, email, handle, bingoAt}); nobody is named.
   */
  function receipt(m, logs, votes, now) {
    var L = live(m, now);
    var isEnded = ended(m);
    var people = (m.people || []).filter(function (p) { return p.count > 0; }).map(function (p) {
      var info = bandInfo(p.band);
      return { band: p.band, label: info.label, count: p.count, rate: p.rate, costUsd: p.rate * p.count * (m.loaded ? LOADED : 1) * L.elapsedMs / HOUR };
    });
    var list = (logs || []).slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0) || String(a.createdAt).localeCompare(String(b.createdAt)); });
    var pick = function (k) { return list.filter(function (l) { return l.kind === k; }); };
    var decisions = pick('decision');
    var actions = pick('action');
    var parking = pick('parking');
    var roti = rotiSummary(votes);
    var emailVotes = (votes || []).filter(function (v) { return v && v.email; }).length;
    var voters = (votes || []).filter(function (v) { return v && (v.email || typeof v.roti === 'number'); }).length;
    var winners = (votes || []).filter(function (v) { return v && v.bingoAt && v.handle; }).sort(function (a, b) { return String(a.bingoAt).localeCompare(String(b.bingoAt)); });
    var givenBack = isEnded ? Math.max(0, L.bookedMs - L.elapsedMs) : 0;
    var overrun = Math.max(0, L.elapsedMs - L.bookedMs);
    var r = {
      title: m.title,
      day: m.day || (m.startedAt ? String(m.startedAt).slice(0, 10) : null),
      startedAt: m.startedAt || null,
      endedAt: m.endedAt || null,
      ended: isEnded,
      durationMs: L.elapsedMs,
      bookedMs: L.bookedMs,
      headcount: L.headcount,
      hourly: L.hourly,
      loaded: Boolean(m.loaded),
      mode: m.mode || 'bands',
      people: people,
      costUsd: L.costUsd,
      personHours: L.personHours,
      items: L.agenda.items.map(function (it) {
        return { n: it.n, title: it.title, owner: it.owner, state: it.state, plannedMs: it.plannedMs, actualMs: it.actualMs, overMs: it.overMs, overUsd: it.overUsd };
      }),
      afterMs: L.agenda.afterMs,
      decisions: decisions.map(function (d) { return { text: d.text }; }),
      actions: actions.map(function (a) { return { text: a.text, owner: a.owner || '', due: a.due || null, done: Boolean(a.doneAt) }; }),
      parking: parking.map(function (p) { return { text: p.text }; }),
      counts: { decision: decisions.length, action: actions.length, parking: parking.length },
      costPerDecision: decisions.length ? L.costUsd / decisions.length : null,
      roti: roti,
      emailVotes: emailVotes,
      voters: voters,
      givenBackMs: givenBack,
      personMinutesGivenBack: givenBack * L.headcount / MIN,
      overrunMs: overrun,
      onTime: isEnded && L.elapsedMs <= L.bookedMs + LIMITS.graceMs,
      early: isEnded && givenBack >= MIN,
      overItems: L.agenda.items.filter(function (it) { return it.overMs >= 30 * SEC && it.state !== 'current'; }).length,
      bingo: winners.length ? { handle: winners[0].handle, at: winners[0].bingoAt } : null,
      compare: L.compare,
    };
    r.verdict = verdict(r);
    return r;
  }

  /** The receipt as plain text: what "Copy as text" puts on the clipboard. */
  function receiptText(r, opts) {
    opts = opts || {};
    var W = 34;
    var line = new Array(W + 1).join('-');
    var row = function (a, b) { a = String(a); b = String(b); var gap = Math.max(1, W - a.length - b.length); return a + new Array(gap + 1).join(' ') + b; };
    var center = function (s) { s = String(s); var n = Math.max(0, Math.floor((W - s.length) / 2)); return new Array(n + 1).join(' ') + s; };
    // Long text wraps at the paper's width rather than running off it.
    var wrap = function (s, first, rest) {
      var words = String(s).split(' ');
      var lines = [];
      var cur = first;
      words.forEach(function (w) {
        if (cur.length + w.length + 1 > W && cur.trim().length > first.trim().length) { lines.push(cur); cur = rest; }
        cur += (cur === first || cur === rest ? '' : ' ') + w;
      });
      lines.push(cur);
      return lines;
    };
    var bullet = function (s) { wrap(s, '  * ', '    ').forEach(function (l) { out.push(l); }); };
    var out = [center('MEETING RECEIPT')];
    if (r.title && !opts.numbersOnly) out.push(center(r.title.slice(0, W)));
    if (r.day) out.push(center(r.day));
    out.push(line);
    out.push(row('DURATION', durText(r.durationMs)));
    out.push(row('BOOKED', durText(r.bookedMs)));
    out.push(row('HEADCOUNT', r.headcount));
    (r.people || []).forEach(function (p) { out.push(row('  ' + p.count + ' x ' + p.label, money(p.costUsd, true))); });
    if (r.loaded) out.push('  (loaded cost, x' + LOADED + ')');
    if ((r.items || []).length) {
      out.push(line);
      out.push(row('AGENDA', 'PLAN / ACTUAL'));
      r.items.forEach(function (it) {
        var name = opts.numbersOnly || !it.title ? 'Item ' + it.n : it.title;
        out.push(row(name.slice(0, W - 14), Math.round(it.plannedMs / MIN) + 'm / ' + (it.actualMs == null ? '-' : durText(it.actualMs))));
        if (it.overUsd >= 1) out.push(row('   over', '+' + money(it.overUsd)));
      });
      if (r.afterMs >= MIN) out.push(row('After the agenda', durText(r.afterMs)));
    }
    out.push(line);
    out.push(row('DECISIONS', r.counts.decision));
    if (!opts.numbersOnly) (r.decisions || []).forEach(function (d) { bullet(d.text); });
    out.push(row('ACTIONS', r.counts.action));
    if (!opts.numbersOnly) (r.actions || []).forEach(function (a) { bullet(a.text + (a.owner ? ' - ' + a.owner : '') + (a.due ? ' (due ' + a.due + ')' : '')); });
    out.push(row('PARKING LOT', r.counts.parking));
    if (!opts.numbersOnly) (r.parking || []).forEach(function (p) { bullet(p.text); });
    out.push(row('COST PER DECISION', r.costPerDecision == null ? 'NO DECISIONS' : money(r.costPerDecision)));
    out.push(line);
    out.push(row('PERSON-HOURS', (Math.round(r.personHours * 10) / 10).toFixed(1)));
    out.push(row('TOTAL', money(r.costUsd, true)));
    out.push(line);
    out.push(row('ROTI', r.roti.n ? r.roti.avg.toFixed(1) + '/4 (' + plural(r.roti.n, 'vote') + ')' : 'no votes'));
    out.push(row('COULD HAVE BEEN AN EMAIL', r.emailVotes));
    if (r.bingo) out.push(row('BINGO', r.bingo.handle));
    if (r.givenBackMs >= MIN) out.push(row('TIME GIVEN BACK', minText(r.givenBackMs).toUpperCase()));
    else if (r.overrunMs > LIMITS.graceMs) out.push(row('OVER TIME', durText(r.overrunMs).toUpperCase()));
    out.push(line);
    wrap(r.verdict.text, '', '').forEach(function (l) { out.push(center(l)); });
    out.push(center('Estimates from role-band rates.'));
    out.push(center('THANK YOU FOR YOUR TIME'));
    return out.join('\n');
  }

  /* ---------------- recaps (free template, and the model's) ---------------- */

  function fmtDue(day) {
    if (!isoDay(day)) return '';
    return new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  }

  /** A recap as plain text for Slack or email. `rec` is either the free
   *  template's (from the log) or the model's, already validated. */
  function recapText(meta, rec) {
    var out = ['Recap: ' + (meta.title || 'our meeting') + (meta.day ? ' (' + meta.day + ')' : '')];
    if (rec.summary) out.push('', rec.summary);
    var sec = function (title, rows) {
      if (!rows.length) return;
      out.push('', title);
      rows.forEach(function (r) { out.push('- ' + r); });
    };
    sec('Decisions', (rec.decisions || []).map(function (d) { return d.text; }));
    sec('Actions', (rec.actions || []).map(function (a) {
      return a.text + ' - ' + (a.owner || '[owner?]') + (a.due ? ', due ' + fmtDue(a.due) : '');
    }));
    sec('Parking lot', (rec.parking || []).map(function (p) { return p.text; }));
    out.push('', 'Next meeting: ' + (rec.nextMeeting || '[add: when]'));
    return out.join('\n');
  }

  /** The free recap: exactly what was logged, nothing more. */
  function recapTemplate(m, logs) {
    var list = (logs || []).slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var rec = {
      summary: '',
      decisions: list.filter(function (l) { return l.kind === 'decision'; }).map(function (l) { return { text: l.text }; }),
      actions: list.filter(function (l) { return l.kind === 'action'; }).map(function (l) { return { text: l.text, owner: l.owner || '', due: l.due || null }; }),
      parking: list.filter(function (l) { return l.kind === 'parking'; }).map(function (l) { return { text: l.text }; }),
      nextMeeting: '',
    };
    var meta = { title: m.title, day: m.day };
    return { recap: rec, subject: 'Recap: ' + (m.title || 'our meeting'), body: recapText(meta, rec) };
  }

  /** A mailto: with no recipient - the facilitator's own mail app fills it.
   *  Receipt sends nothing itself; there is no mail service. */
  function mailto(subject, body) {
    return 'mailto:?subject=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(String(body || '').slice(0, 1800));
  }

  /* ---------------- the recurring-meeting audit ---------------- */

  function validateRecurring(raw, prev) {
    raw = raw || {};
    prev = prev || {};
    var has = function (k) { return raw[k] !== undefined; };
    var title = has('title') ? clean(raw.title, LIMITS.recurringTitle) : (prev.title || '');
    if (title.length < 2) return { error: 'Give the meeting a name.', field: 'title' };
    var minutes = has('minutes') ? intIn(raw.minutes, LIMITS.bookedMin, LIMITS.bookedMax) : (prev.minutes || null);
    if (minutes === null) return { error: 'How long is it? ' + LIMITS.bookedMin + ' to ' + LIMITS.bookedMax + ' minutes.', field: 'minutes' };
    var cadence = has('cadence') ? raw.cadence : (prev.cadence || 'weekly');
    if (CADENCE_KEYS.indexOf(cadence) < 0) return { error: 'How often does it happen?', field: 'cadence' };
    var mode = has('mode') ? (raw.mode === 'blended' ? 'blended' : 'bands') : (prev.mode || 'bands');
    var people = has('people') || has('mode') ? cleanPeople(has('people') ? raw.people : prev.people, mode) : (prev.people || cleanPeople([], mode));
    var pErr = checkPeople(people);
    if (pErr) return { error: pErr, field: 'people' };
    var decision = has('decision') ? raw.decision : (prev.decision || null);
    if (decision !== null && ['keep', 'shrink', 'kill'].indexOf(decision) < 0) return { error: 'Keep, shrink or kill.', field: 'decision' };
    var base = { title: title, minutes: minutes, cadence: cadence, mode: mode, people: people, loaded: has('loaded') ? raw.loaded === true : Boolean(prev.loaded) };
    var shrink = null;
    if (decision === 'shrink') {
      var s = has('shrink') ? raw.shrink : prev.shrink;
      shrink = cleanShrink(s, base) || shrinkSuggestion(base);
    }
    base.decision = decision;
    base.shrink = shrink;
    return { recurring: base };
  }

  function round5(n) { return Math.round(n / 5) * 5; }
  function cadenceStep(k) {
    var i = CADENCE_KEYS.indexOf(k);
    return i >= 0 && i < CADENCE_KEYS.length - 1 ? CADENCE_KEYS[i + 1] : k;
  }
  /** Shrink's first offer: half the length (50 → 25), one step less often
   *  (weekly → every 2 weeks), and nobody dropped until you choose. */
  function shrinkSuggestion(r) {
    return { minutes: r.minutes > 15 ? Math.max(15, round5(r.minutes / 2)) : r.minutes, cadence: cadenceStep(r.cadence), drop: [] };
  }
  function cleanShrink(s, r) {
    if (!s || typeof s !== 'object') return null;
    var minutes = intIn(s.minutes, LIMITS.bookedMin, r.minutes);
    var cadence = CADENCE_KEYS.indexOf(s.cadence) >= 0 && CADENCE_KEYS.indexOf(s.cadence) >= CADENCE_KEYS.indexOf(r.cadence) ? s.cadence : r.cadence;
    var inUse = bandsInUse(r);
    var drop = (Array.isArray(s.drop) ? s.drop : []).filter(function (b, i, a) { return inUse.indexOf(b) >= 0 && a.indexOf(b) === i; });
    if (drop.length >= inUse.length) drop = drop.slice(0, inUse.length - 1); // somebody still has to be there
    return { minutes: minutes === null ? r.minutes : minutes, cadence: cadence, drop: drop };
  }
  /** The meeting as it would be after the shrink. */
  function shrunk(r, s) {
    s = s || shrinkSuggestion(r);
    return {
      title: r.title, minutes: s.minutes, cadence: s.cadence, mode: r.mode, loaded: r.loaded,
      people: (r.people || []).map(function (p) { return { band: p.band, rate: p.rate, count: (s.drop || []).indexOf(p.band) >= 0 ? 0 : p.count }; }),
    };
  }
  function perMeeting(r) { return hourly(r) * (r.minutes || 0) / 60; }
  function annualCost(r) { return perMeeting(r) * cadenceInfo(r.cadence).perYear; }
  function annualHours(r) { return headcount(r) * (r.minutes || 0) / 60 * cadenceInfo(r.cadence).perYear; }
  /** What a decision saves a year: all of it to kill, the difference to
   *  shrink, nothing to keep. */
  function savings(r) {
    if (r.decision === 'kill') return annualCost(r);
    if (r.decision === 'shrink') return Math.max(0, annualCost(r) - annualCost(shrunk(r, r.shrink)));
    return 0;
  }
  function hoursSaved(r) {
    if (r.decision === 'kill') return annualHours(r);
    if (r.decision === 'shrink') return Math.max(0, annualHours(r) - annualHours(shrunk(r, r.shrink)));
    return 0;
  }
  function audit(list) {
    var rows = (list || []).map(function (r) { return { r: r, annual: annualCost(r), saved: savings(r), hours: annualHours(r), hoursSaved: hoursSaved(r) }; })
      .sort(function (a, b) { return b.annual - a.annual; });
    var sum = function (k) { return rows.reduce(function (s, x) { return s + x[k]; }, 0); };
    var count = function (d) { return rows.filter(function (x) { return (x.r.decision || null) === d; }).length; };
    return {
      rows: rows, totalAnnual: sum('annual'), savedPerYear: sum('saved'), hoursPerYear: sum('hours'), hoursSaved: sum('hoursSaved'),
      kept: count('keep'), shrunk: count('shrink'), killed: count('kill'), undecided: count(null),
    };
  }

  /* ---------------- the scoreboard ---------------- */

  /**
   * From the summaries of ended meetings (one row each: day, endedAt,
   * costUsd, personHours, durationMs, bookedMs, headcount, decisions, rotiAvg,
   * rotiN, title) and the audit's rows. Everything is team-level: nobody's
   * name appears, and dropped actions are a count, never a list by owner.
   */
  function scoreboard(rows, recurring, today, extra) {
    extra = extra || {};
    var done = (rows || []).filter(function (r) { return r.endedAt; }).slice().sort(function (a, b) { return String(b.endedAt).localeCompare(String(a.endedAt)); });
    var thisWeek = weekOf(today);
    var weeks = [];
    for (var i = 7; i >= 0; i--) weeks.push({ week: addDays(thisWeek, -7 * i), costUsd: 0, personHours: 0, meetings: 0, givenBackMs: 0 });
    var onTime = function (r) { return r.durationMs <= r.bookedMs + LIMITS.graceMs; };
    var weekStats = {};
    done.forEach(function (r) {
      var wk = weekOf(r.day || String(r.endedAt).slice(0, 10));
      for (var j = 0; j < weeks.length; j++) {
        if (weeks[j].week === wk) {
          weeks[j].costUsd += r.costUsd; weeks[j].personHours += r.personHours; weeks[j].meetings++;
          weeks[j].givenBackMs += Math.max(0, r.bookedMs - r.durationMs);
        }
      }
      var ws = weekStats[wk] || (weekStats[wk] = { n: 0, over: 0 });
      ws.n++;
      if (!onTime(r)) ws.over++;
    });
    var streak = 0;
    for (var k = 0; k < done.length && onTime(done[k]); k++) streak++;
    var best = 0; var run = 0;
    done.slice().reverse().forEach(function (r) { run = onTime(r) ? run + 1 : 0; best = Math.max(best, run); });
    var givenBackMs = done.reduce(function (s, r) { return s + Math.max(0, r.bookedMs - r.durationMs); }, 0);
    var givenBackPersonH = done.reduce(function (s, r) { return s + Math.max(0, r.bookedMs - r.durationMs) * (r.headcount || 0) / HOUR; }, 0);
    var month = String(today).slice(0, 7);
    var thisMonth = done.filter(function (r) { return String(r.day || '').slice(0, 7) === month; });
    var priciest = thisMonth.slice().sort(function (a, b) { return b.costUsd - a.costUsd; })[0] || null;
    var trend = done.filter(function (r) { return r.rotiN > 0; }).slice(0, 10).reverse().map(function (r) { return { day: r.day, avg: r.rotiAvg, title: r.title }; });
    var a = audit(recurring || []);
    var badges = [];
    if (done.length) badges.push('first');
    if (Object.keys(weekStats).some(function (w) { return weekStats[w].n >= 2 && !weekStats[w].over; })) badges.push('zerooverrun');
    if ((recurring || []).some(function (r) { return r.decision === 'kill'; })) badges.push('killed');
    if (done.some(function (r) { return r.decisions > 0 && r.costUsd / r.decisions < 50; })) badges.push('cheapdecision');
    return {
      meetings: done.length,
      totalUsd: done.reduce(function (s, r) { return s + r.costUsd; }, 0),
      totalPersonHours: done.reduce(function (s, r) { return s + r.personHours; }, 0),
      weeks: weeks,
      thisWeek: weeks[weeks.length - 1],
      streak: streak,
      bestStreak: best,
      givenBackMs: givenBackMs,
      givenBackPersonHours: givenBackPersonH,
      rotiTrend: trend,
      priciest: priciest ? { title: priciest.title, day: priciest.day, costUsd: priciest.costUsd, id: priciest.id } : null,
      savedPerYear: a.savedPerYear,
      badges: badges,
      actions: extra.actions || { open: 0, done: 0, dropped: 0 },
    };
  }

  /* ---------------- codes ---------------- */

  function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16); }
  function isCode(v) { return CODE_RE.test(String(v || '')); }
  function formatCode(v) { var s = normalizeCode(v); return s.length === CODE_LEN ? s.slice(0, 4) + '-' + s.slice(4) : s; }

  return {
    SEC: SEC, MIN: MIN, HOUR: HOUR, DAY: DAY,
    BANDS: BANDS, BAND_KEYS: BAND_KEYS, BLENDED: BLENDED, LOADED: LOADED, CADENCES: CADENCES, CADENCE_KEYS: CADENCE_KEYS,
    KINDS: KINDS, KIND_KEYS: KIND_KEYS, ROTI: ROTI, MILESTONES: MILESTONES, HEAT: HEAT, BADGES: BADGES,
    PHRASES: PHRASES, FREE: FREE, HANDLES: HANDLES, LINES: LINES, TEMPLATES: TEMPLATES, LIMITS: LIMITS,
    CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN,
    bandInfo: bandInfo, cadenceInfo: cadenceInfo, kindInfo: kindInfo, heatInfo: heatInfo, badgeInfo: badgeInfo,
    clean: clean, cleanText: cleanText, norm: norm, toNumber: toNumber, intIn: intIn,
    isoDay: isoDay, addDays: addDays, daysBetween: daysBetween, weekOf: weekOf,
    money: money, clockText: clockText, durText: durText, minText: minText, hoursText: hoursText, plural: plural,
    cleanPeople: cleanPeople, headcount: headcount, hourly: hourly, bandsInUse: bandsInUse, costFor: costFor,
    cleanLabels: cleanLabels, matchLabel: matchLabel, cleanAgenda: cleanAgenda, agendaMinutes: agendaMinutes, validateSetup: validateSetup,
    started: started, ended: ended, isPaused: isPaused, status: status, elapsed: elapsed, wallAt: wallAt, agenda: agenda, live: live,
    compare: compare, crossed: crossed,
    validateLog: validateLog, heat: heat, byHeat: byHeat,
    validRoti: validRoti, rotiSummary: rotiSummary, hash32: hash32, deal: deal, cleanMarks: cleanMarks, bingoLine: bingoLine,
    receipt: receipt, verdict: verdict, receiptText: receiptText,
    fmtDue: fmtDue, recapText: recapText, recapTemplate: recapTemplate, mailto: mailto,
    validateRecurring: validateRecurring, shrinkSuggestion: shrinkSuggestion, cleanShrink: cleanShrink, shrunk: shrunk,
    perMeeting: perMeeting, annualCost: annualCost, annualHours: annualHours, savings: savings, audit: audit,
    scoreboard: scoreboard,
    normalizeCode: normalizeCode, isCode: isCode, formatCode: formatCode,
  };
});
