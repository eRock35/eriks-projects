/* Pickup - the rules, in one file, run three times: by the page (a group on
 * this phone, the example group, and the screens of a group online), by the
 * server (which checks and stores every change to a group online), and by
 * the tests. UMD: window.PickupCore in the page, require() in node.
 *
 * Nothing here touches a store, the network or the clock on its own: every
 * function is handed `now` (ms) and the group's IANA time zone, so two phones
 * looking at one group draw the same game.
 *
 * What is in it:
 *   - SPORTS (players a side, a sensible cap, the positions that matter);
 *   - the week: games repeat on a weekday at a wall-clock time in the
 *     group's zone; the next one opens when this one is done (`ensureGame`);
 *   - answers: In / Maybe / Out, +1 guests, the cap and the waitlist
 *     (`lineup`), first come first served, +1s included, an Out moving the
 *     first waiter up with a line saying so;
 *   - fair teams (`balance`): skill, positions, split/together lines and
 *     last week's teams, exact for small games and a bounded swap search
 *     for big ones, deterministic, with a reshuffle that gives the next-best
 *     different split; winner-stays-on for three or four sides;
 *   - results, standings, streaks, attendance and Player of the Week;
 *   - court money: the cost split among who played, to the cent, Paid ticks
 *     and a running balance across weeks (no payments - nothing is held);
 *   - the free group-chat reader (`parseChat`) and the one door every
 *     answer goes through (`cleanReply`), typed or read by a model.
 *
 * Every action returns {patch: {set: {'games.<gid>.rsvps.<pid>': v}, del:
 * [...]}, msg}: the page applies it to its own copy (`applyPatch`) and the
 * server writes it as single keys in a transaction, so two phones never lose
 * each other's change.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickupCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  const LIMITS = {
    members: 40,
    guestsPerGame: 20,
    plusPerMember: 3,
    keepGames: 26,      // half a year of weekly games - the season
    log: 30,            // "Sam's in - Jo dropped out" lines kept per game
    matches: 24,
    lines: 20,          // split / together pairs
    groupName: 40,
    memberName: 24,
    place: 80,
    capMin: 2,
    capMax: 60,
    costMax: 100000,    // cents, per game, for the whole court
    pasteText: 20000,   // characters of pasted chat
    replies: 60,
    exactLimit: 30000,  // splits enumerated exactly up to this many
  };
  const EMOJI = ['🦊', '🐻', '🦁', '🐯', '🐼', '🐸', '🐙', '🦉', '🐝', '🦄', '🐳', '🦖', '🐢', '🦋', '🌵', '🌻', '⚡', '🔥', '🌈', '🚀', '🎸', '🎯', '🧢', '👟'];
  const SKILLS = [
    { n: 1, label: 'Just for fun' },
    { n: 2, label: 'Casual' },
    { n: 3, label: 'Solid' },
    { n: 4, label: 'Strong' },
    { n: 5, label: 'Ringer' },
  ];
  const SPORTS = [
    { id: 'basketball', name: 'Basketball', emoji: '🏀', perSide: 5, cap: 10, usePos: false, positions: [{ id: 'big', name: 'Big', short: 'Big' }], thing: 'hoops' },
    { id: 'football', name: 'Five-a-side', emoji: '⚽', perSide: 5, cap: 10, usePos: true, positions: [{ id: 'gk', name: 'Keeper', short: 'GK' }], thing: 'five-a-side' },
    { id: 'volleyball', name: 'Volleyball', emoji: '🏐', perSide: 6, cap: 12, usePos: true, positions: [{ id: 'setter', name: 'Setter', short: 'Setter' }], thing: 'volleyball' },
    { id: 'pickleball', name: 'Pickleball', emoji: '🏓', perSide: 2, cap: 8, usePos: false, positions: [], thing: 'pickleball' },
    { id: 'ultimate', name: 'Ultimate', emoji: '🥏', perSide: 7, cap: 14, usePos: true, positions: [{ id: 'handler', name: 'Handler', short: 'Handler' }], thing: 'ultimate' },
    { id: 'padel', name: 'Padel', emoji: '🎾', perSide: 2, cap: 4, usePos: false, positions: [], thing: 'padel' },
    { id: 'other', name: 'Something else', emoji: '🏃', perSide: 5, cap: 10, usePos: false, positions: [], thing: 'game' },
  ];
  const SPORT = {};
  for (const s of SPORTS) SPORT[s.id] = s;
  // Bibs. Each team is told apart by its name as well as its swatch.
  const TEAMS = [
    { id: 'orange', name: 'Orange', hex: '#ea580c' },
    { id: 'white', name: 'White', hex: '#f5f5f4' },
    { id: 'blue', name: 'Blue', hex: '#2563eb' },
    { id: 'green', name: 'Green', hex: '#16a34a' },
  ];
  const CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'NZD', 'INR', 'ZAR', 'SGD'];
  const ANSWERS = ['in', 'maybe', 'out'];
  const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']; // wd 0 = Monday
  const DONE_AFTER_MS = 12 * 3600 * 1000;   // a game is over this long after kickoff
  const VOTE_HOURS = 72;                    // Player of the Week voting stays open this long
  const STAY_MAX = 2;                       // winner stays on, two games at most

  /* ------------------------------------------------------------------ *
   * Cleaning: one door for every string
   * ------------------------------------------------------------------ */

  // Control characters and the bidi overrides and isolates: they never belong
  // in anything typed or read (a name like "‮Sam" would draw backwards on
  // every phone). The zero-width joiner stays: some emoji need it.
  const STRIP = /[\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁩﻿]/g;

  /** One line of untrusted text: no markup, no control or bidi characters,
   *  single spaces, at most `max` characters, cut on a whole character. Cut
   *  before any pattern runs, so hostile input costs linear time. */
  function clean(v, max) {
    let s = typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
    if (s.length > max * 4 + 200) s = s.slice(0, max * 4 + 200);
    s = s.replace(/<[^<>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('').replace(/\s+$/, '') + '…';
    return s;
  }
  /** A name: has to have a letter, digit or emoji. */
  function cleanText(v, max) {
    const s = clean(v, max);
    return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
  }
  function cleanName(v) { return cleanText(v, LIMITS.memberName); }
  function cleanEmoji(v) { return EMOJI.indexOf(v) >= 0 ? v : null; }
  function cleanSkill(v) {
    const n = typeof v === 'string' && /^\s*[1-5]\s*$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  }
  function cleanSport(v) { return Object.prototype.hasOwnProperty.call(SPORT, v) ? v : null; }
  function cleanCur(v) { return CURRENCIES.indexOf(v) >= 0 ? v : null; }
  function cleanTime(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    const h = Number(m[1]); const mi = Number(m[2]);
    return h <= 23 && mi <= 59 ? (h < 10 ? '0' : '') + h + ':' + m[2] : null;
  }
  function cleanWd(v) { return Number.isInteger(v) && v >= 0 && v <= 6 ? v : null; }
  function cleanCap(v) {
    const n = typeof v === 'string' && /^\s*\d{1,3}\s*$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n >= LIMITS.capMin && n <= LIMITS.capMax ? n : null;
  }
  function cleanPerSide(v) { return Number.isInteger(v) && v >= 1 && v <= 11 ? v : null; }
  /** Cents from a number of cents (integers only). */
  function cleanCents(v) { return Number.isInteger(v) && v >= 0 && v <= LIMITS.costMax ? v : null; }
  /** Cents from what a person types: "60", "$60", "60.50", "6,50". */
  function moneyIn(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v * 100 <= LIMITS.costMax ? Math.round(v * 100) : null;
    const s = String(v == null ? '' : v).replace(/[^\d.,]/g, '');
    if (!/\d/.test(s)) return null;
    const m = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(s.replace(/,(?=\d{3}\b)/g, ''));
    if (!m) return null;
    const cents = Number(m[1]) * 100 + (m[2] ? Number((m[2] + '0').slice(0, 2)) : 0);
    return cents <= LIMITS.costMax ? cents : null;
  }
  function cleanPlace(v) { return clean(v, LIMITS.place); }
  function cleanAnswer(v) { return ANSWERS.indexOf(v) >= 0 ? v : null; }

  const MEMBER_ID = /^m[a-z0-9]{6,12}$/;
  const GUEST_ID = /^x[a-z0-9]{6,12}$/;
  const MATCH_ID = /^r[a-z0-9]{6,12}$/;
  const LOG_ID = /^l[a-z0-9]{6,12}$/;
  const GAME_ID = /^g\d{8}[a-z]?$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isMemberId = (v) => typeof v === 'string' && MEMBER_ID.test(v);
  const isGuestId = (v) => typeof v === 'string' && GUEST_ID.test(v);
  const isMatchId = (v) => typeof v === 'string' && MATCH_ID.test(v);
  const isGameId = (v) => typeof v === 'string' && GAME_ID.test(v);
  function isDate(v) {
    if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
    const ms = Date.parse(v + 'T00:00:00Z');
    return !isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
  }

  /** A short random id from an unambiguous alphabet. `rand(n)` -> 0..n-1. */
  function newId(prefix, rand) {
    const A = 'abcdefghijkmnpqrstuvwxyz23456789';
    const r = rand || ((n) => Math.floor(Math.random() * n));
    let s = prefix;
    for (let i = 0; i < 9; i++) s += A[r(A.length)];
    return s;
  }
  const gameIdFor = (date) => 'g' + date.replace(/-/g, '');

  function fail(status, message, extra) {
    const e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) Object.assign(e, extra);
    return e;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  /** "a", "a and b", "a, b and c". */
  function nameList(names) {
    if (names.length <= 2) return names.join(' and ');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  /** FNV-1a, 32 bits, finalised. Tie-breaks and the example group. */
  function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }
  const fold = (s) => String(s || '').toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const copy = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const own = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

  /* ------------------------------------------------------------------ *
   * Time, in the group's own zone
   * ------------------------------------------------------------------ */

  function cleanTz(tz) {
    if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'UTC'; }
  }
  const fmtCache = {};
  function parts(ms, tz) {
    const z = cleanTz(tz);
    const f = fmtCache[z] || (fmtCache[z] = new Intl.DateTimeFormat('en-CA', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
    if (p.hour === '24') p.hour = '00';
    return p;
  }
  /** The calendar date at `ms` in `tz`, as 'YYYY-MM-DD'. */
  function localDate(ms, tz) { const p = parts(ms, tz); return p.year + '-' + p.month + '-' + p.day; }
  /** The zone's offset from UTC at `ms`, in ms. */
  function offsetAt(ms, tz) {
    const p = parts(ms, tz);
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return asUtc - Math.floor(ms / 1000) * 1000;
  }
  /** The instant a wall-clock date and time happen in `tz`. A time that
   *  does not exist (the hour skipped in spring) lands an hour later. */
  function zonedMs(date, time, tz) {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = (cleanTime(time) || '19:00').split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    let ms = guess - offsetAt(guess, tz);
    const again = guess - offsetAt(ms, tz);
    if (again !== ms) ms = Math.max(ms, again);
    return ms;
  }
  const DAY_MS = 86400000;
  const dateMs = (d) => Date.parse(d + 'T00:00:00Z');
  const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  function addDays(d, n) { return isoDate(dateMs(d) + n * DAY_MS); }
  function daysBetween(a, b) { return Math.round((dateMs(b) - dateMs(a)) / DAY_MS); }
  /** Monday = 0 ... Sunday = 6. */
  function weekday(d) { return (new Date(dateMs(d)).getUTCDay() + 6) % 7; }
  function onOrAfter(d, wd) { return addDays(d, (wd - weekday(d) + 7) % 7); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  /** "Thu 8 Oct". */
  function dateLabel(d) {
    const x = new Date(dateMs(d));
    return DAYS[weekday(d)] + ' ' + x.getUTCDate() + ' ' + MONTHS[x.getUTCMonth()];
  }
  function shortDate(d) { const x = new Date(dateMs(d)); return MONTHS[x.getUTCMonth()] + ' ' + x.getUTCDate(); }
  /** "7pm", "7:30pm", "12pm". */
  function timeLabel(t) {
    const c = cleanTime(t);
    if (!c) return '';
    const [h, m] = c.split(':').map(Number);
    const hh = h % 12 === 0 ? 12 : h % 12;
    return hh + (m ? ':' + (m < 10 ? '0' : '') + m : '') + (h < 12 ? 'am' : 'pm');
  }
  /** "Tonight", "Tomorrow", "Sunday", "Thu 15 Oct", "Last Thursday". */
  function whenLabel(date, today) {
    const n = daysBetween(today, date);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    if (n > 1 && n < 7) return WEEKDAY_NAMES[weekday(date)];
    return dateLabel(date);
  }

  /** Money from cents, in the group's currency: "$6", "$6.50", "£12". */
  function fmtMoney(cents, cur) {
    const c = cleanCur(cur) || 'USD';
    const n = (Number(cents) || 0) / 100;
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: c, minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
    } catch (e) { return '$' + (n % 1 ? n.toFixed(2) : String(n)); }
  }

  /* ------------------------------------------------------------------ *
   * Patches
   * ------------------------------------------------------------------ */

  function setPath(o, key, v) {
    const p = key.split('.');
    let at = o;
    for (const k of p.slice(0, -1)) { if (!at[k] || typeof at[k] !== 'object') at[k] = {}; at = at[k]; }
    at[p[p.length - 1]] = copy(v);
  }
  function delPath(o, key) {
    const p = key.split('.');
    let at = o;
    for (const k of p.slice(0, -1)) { if (!at[k] || typeof at[k] !== 'object') return; at = at[k]; }
    delete at[p[p.length - 1]];
  }
  /** Apply {set, del} to a group object (the page's copy, or a test's). */
  function applyPatch(g, patch) {
    if (!patch) return g;
    for (const k of Object.keys(patch.set || {})) setPath(g, k, patch.set[k]);
    for (const k of patch.del || []) delPath(g, k);
    return g;
  }
  const P = (gid, ...rest) => ['games', gid].concat(rest).join('.');

  /* ------------------------------------------------------------------ *
   * People
   * ------------------------------------------------------------------ */

  function memberOf(group, id) { return (group.members || []).find((m) => m.id === id) || null; }
  function hostOf(group) { return (group.members || []).find((m) => m.host) || (group.members || [])[0] || null; }
  function sportOf(group) { return SPORT[group.sport] || SPORT.other; }
  /** The number teams are made from: the host's quiet adjustment if there is
   *  one, else what the person said about themselves, else 3. */
  function skillOf(m) { return cleanSkill(m && m.adj) || cleanSkill(m && m.skill) || 3; }
  function nameOf(group, game, id) {
    const m = memberOf(group, id);
    if (m) return m.name;
    const x = game && game.guests && own(game.guests, id) ? game.guests[id] : null;
    return x ? x.name : 'Someone';
  }
  /** "Tom (Sam's +1)". */
  function guestLabel(group, x) {
    const by = memberOf(group, x.by);
    return x.name + (by ? ' (' + by.name + '’s +1)' : ' (+1)');
  }

  /* ------------------------------------------------------------------ *
   * Games: one a week, the next opening when this one is done
   * ------------------------------------------------------------------ */

  function games(group) {
    return Object.keys(group.games || {}).map((k) => group.games[k]).filter((g) => g && isDate(g.date)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  }
  function gameOf(group, gid) {
    const g = group.games && own(group.games, gid) ? group.games[gid] : null;
    if (!g) throw fail(404, 'That game isn’t here any more.');
    return g;
  }
  function kickoff(group, game) { return zonedMs(game.date, game.time, group.tz); }
  function started(group, game, now) { return now >= kickoff(group, game); }
  function latest(group) { const l = games(group); return l.length ? l[l.length - 1] : null; }
  function needsNext(group, now) {
    const l = latest(group);
    return !l || Boolean(l.done) || now >= kickoff(group, l) + DONE_AFTER_MS;
  }
  /** The date the next game falls on: the group's weekday on or after the
   *  day after the last game, never in the past. */
  function nextDate(group, now) {
    const s = group.sched || {};
    const today = localDate(now, group.tz);
    const l = latest(group);
    let from = l && addDays(l.date, 1) > today ? addDays(l.date, 1) : today;
    let d = onOrAfter(from, cleanWd(s.wd) === null ? weekday(today) : s.wd);
    if (zonedMs(d, s.time, group.tz) + DONE_AFTER_MS <= now) d = addDays(d, 7);
    return d;
  }
  function newGame(group, date, now) {
    const s = group.sched || {};
    return {
      id: gameIdFor(date), date, time: cleanTime(s.time) || '19:00', place: cleanPlace(s.place), cap: cleanCap(s.cap) || sportOf(group).cap,
      cost: cleanCents(s.cost) || 0, rsvps: {}, guests: {}, log: {}, teams: null, matches: {}, played: null, paid: {}, votes: {},
      potwClosed: false, done: false, created: now,
    };
  }
  /** The game that is on now - this week's - opening the next one when the
   *  last is done (12 hours after kickoff, or wrapped up by the host). Its
   *  regulars start as "not answered yet". Returns {gid, patch} where patch
   *  is null when nothing needs writing. Old games past the season drop off. */
  function ensureGame(group, now) {
    if (!needsNext(group, now)) return { gid: latest(group).id, patch: null };
    const date = nextDate(group, now);
    // A game whose date the host moved keeps its id, so the next one may
    // need a letter to be its own.
    let gid = gameIdFor(date);
    for (let i = 0; group.games && own(group.games, gid) && i < 25; i++) gid = gameIdFor(date) + 'bcdefghijklmnopqrstuvwxyz'[i];
    const set = {}; const del = [];
    set['games.' + gid] = Object.assign(newGame(group, date, now), { id: gid });
    const all = games(group);
    for (const g of all.slice(0, Math.max(0, all.length + 1 - LIMITS.keepGames))) del.push('games.' + g.id);
    return { gid, patch: { set, del } };
  }
  /** The game to show: the latest. */
  function current(group) { return latest(group); }
  /** The last game before this one that had teams - "last week". */
  function previousWithTeams(group, game) {
    const before = games(group).filter((g) => g.date < game.date && g.teams && Array.isArray(g.teams.sides));
    return before.length ? before[before.length - 1] : null;
  }

  /* ------------------------------------------------------------------ *
   * Answers, the cap and the waitlist
   * ------------------------------------------------------------------ */

  /** Who is in, who waits, who might and who can't - first come, first
   *  served, +1s included: a guest's place is the moment they were added. */
  function lineup(group, game) {
    const entries = [];
    const rs = game.rsvps || {};
    for (const m of group.members || []) {
      const r = own(rs, m.id) ? rs[m.id] : null;
      if (r && r.a === 'in') entries.push({ id: m.id, kind: 'm', name: m.name, emoji: m.emoji, t: Number(r.t) || 0, m });
    }
    for (const xid of Object.keys(game.guests || {})) {
      const x = game.guests[xid];
      if (!x) continue;
      entries.push({ id: xid, kind: 'x', name: x.name, by: x.by, t: Number(x.t) || 0, x });
    }
    entries.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
    const cap = cleanCap(game.cap) || 10;
    const out = { in: entries.slice(0, cap), wait: entries.slice(cap), maybe: [], out: [], none: [], cap };
    for (const m of group.members || []) {
      const r = own(rs, m.id) ? rs[m.id] : null;
      if (!r) out.none.push({ id: m.id, kind: 'm', name: m.name, emoji: m.emoji, m });
      else if (r.a === 'maybe') out.maybe.push({ id: m.id, kind: 'm', name: m.name, emoji: m.emoji, t: r.t, m });
      else if (r.a === 'out') out.out.push({ id: m.id, kind: 'm', name: m.name, emoji: m.emoji, t: r.t, m });
    }
    return out;
  }
  /** "8 in · need 2 more", "Full - 2 waiting", "Full · 10 in". */
  function headline(lu) {
    const n = lu.in.length;
    if (!n && !lu.wait.length) return 'Nobody’s in yet';
    if (lu.wait.length) return 'Full - ' + lu.wait.length + ' waiting';
    if (n >= lu.cap) return 'Full · ' + n + ' in';
    return n + ' in · need ' + (lu.cap - n) + ' more';
  }
  function statusOf(lu, id) {
    if (lu.in.some((e) => e.id === id)) return 'in';
    const w = lu.wait.findIndex((e) => e.id === id);
    if (w >= 0) return 'wait' + (w + 1);
    if (lu.maybe.some((e) => e.id === id)) return 'maybe';
    if (lu.out.some((e) => e.id === id)) return 'out';
    return 'none';
  }
  /** A time later than anything already in this game: two answers in one
   *  millisecond still have an order, so the last spot has one owner. */
  function nextT(game, now) {
    let t = 0;
    for (const k of Object.keys(game.rsvps || {})) t = Math.max(t, Number(game.rsvps[k] && game.rsvps[k].t) || 0);
    for (const k of Object.keys(game.guests || {})) t = Math.max(t, Number(game.guests[k] && game.guests[k].t) || 0);
    return Math.max(Number(now) || 0, t + 1);
  }
  /** The log lines a change makes: whoever moved up from the waitlist
   *  (paired with whoever's place they took) and whoever moved down. */
  function moves(group, gameBefore, gameAfter, actorId, why) {
    const before = lineup(group, gameBefore);
    const after = lineup(group, gameAfter);
    const was = new Set(before.in.map((e) => e.id));
    const now = new Set(after.in.map((e) => e.id));
    const up = after.in.filter((e) => !was.has(e.id) && e.id !== actorId && before.wait.some((w) => w.id === e.id));
    const left = before.in.filter((e) => !now.has(e.id) && !after.wait.some((w) => w.id === e.id));
    const down = before.in.filter((e) => !now.has(e.id) && after.wait.some((w) => w.id === e.id));
    const lines = [];
    up.forEach((e, i) => {
      const gone = left[i] || left[0];
      lines.push({ k: 'up', who: e.name, whom: gone ? gone.name : null, why: gone ? 'out' : why || 'cap' });
    });
    for (const e of down) lines.push({ k: 'down', who: e.name, why: why || 'cap' });
    return { up, down, left, lines, after };
  }
  function logPatch(game, lines, now, rand, set, del) {
    if (!lines.length) return;
    const have = Object.keys(game.log || {}).map((k) => ({ k, t: Number(game.log[k] && game.log[k].t) || 0 })).sort((a, b) => a.t - b.t);
    lines.forEach((l, i) => { set[P(game.id, 'log', newId('l', rand))] = Object.assign({ t: now + i }, l); });
    const over = have.length + lines.length - LIMITS.log;
    for (const h of have.slice(0, Math.max(0, over))) del.push(P(game.id, 'log', h.k));
  }
  /** "Sam's in - Jo dropped out". */
  function logText(l) {
    if (l.k === 'up') return l.who + '’s in' + (l.whom ? ' - ' + l.whom + (l.why === 'out' ? ' dropped out' : ' made room') : ' - a spot opened up');
    if (l.k === 'down') return l.who + ' is on the waitlist - the cap went down';
    return '';
  }
  function canAnswerFor(group, game, actor, id) {
    if (actor.host) return true;
    if (id === actor.mid) return true;
    const x = game.guests && own(game.guests, id) ? game.guests[id] : null;
    return Boolean(x && x.by === actor.mid);
  }
  function beforeKickoff(group, game, ctx) {
    if (!ctx.actor.host && started(group, game, ctx.now)) throw fail(409, 'Kickoff has passed - ask the host to change it.');
  }

  /**
   * In / Maybe / Out (or null to clear) for a regular or a +1. Yours, or a
   * +1 you brought; the host may answer for anyone. Going Out takes your +1s
   * out with you. An Out moves the first waiter up, with a line saying so.
   */
  function rsvp(group, gid, id, answer, ctx) {
    const game = gameOf(group, gid);
    const a = answer === null ? null : cleanAnswer(answer);
    if (answer !== null && !a) throw fail(400, 'In, maybe or out.');
    const guest = game.guests && own(game.guests, id) ? game.guests[id] : null;
    const m = memberOf(group, id);
    if (!guest && !m) throw fail(404, 'No one by that name in this group.');
    if (!canAnswerFor(group, game, ctx.actor, id)) throw fail(403, 'You can answer for yourself and your +1s.');
    beforeKickoff(group, game, ctx);
    const set = {}; const del = [];
    let msg = '';
    if (guest) {
      if (a === 'in') return { patch: { set, del }, msg: guest.name + ' is already on the list.' };
      if (a === 'maybe') throw fail(400, 'A +1 is in or out.');
      del.push(P(gid, 'guests', id));
    } else {
      const prev = game.rsvps && own(game.rsvps, id) ? game.rsvps[id] : null;
      if (a === null) del.push(P(gid, 'rsvps', id));
      else set[P(gid, 'rsvps', id)] = { a, t: a === 'in' && prev && prev.a === 'in' ? prev.t : nextT(game, ctx.now), by: ctx.actor.mid || null };
      if (a === 'out') for (const xid of Object.keys(game.guests || {})) if (game.guests[xid] && game.guests[xid].by === id) del.push(P(gid, 'guests', xid));
    }
    const after = copy(group);
    applyPatch(after, { set, del });
    const mv = moves(group, game, after.games[gid], id);
    logPatch(game, mv.lines, ctx.now, ctx.rand, set, del);
    const lu = mv.after;
    const st = statusOf(lu, id);
    const who = guest ? guest.name : m.name;
    const self = id === ctx.actor.mid;
    if (a === 'in') msg = st === 'in' ? (self ? 'You’re in! 🙌' : who + ' is in.') : (self ? 'It’s full - you’re #' + st.slice(4) + ' on the waitlist. You’ll move up if someone drops out.' : who + ' is #' + st.slice(4) + ' on the waitlist.');
    else if (a === 'maybe') msg = self ? 'Marked maybe. Tap In when you know.' : who + ': maybe.';
    else if (a === 'out') msg = guest ? who + ' is off the list.' : (self ? 'Got it - you’re out this week.' : who + ' is out.');
    else msg = who + ': answer cleared.';
    const dropped = (del.filter((k) => k.indexOf('.guests.') > 0 && k !== P(gid, 'guests', id))).length;
    if (dropped) msg += ' ' + (dropped === 1 ? 'Their +1 is out too.' : 'Their ' + dropped + ' guests are out too.');
    if (mv.up.length) msg += ' ' + nameList(mv.up.map((e) => e.name)) + (mv.up.length === 1 ? ' moves up from the waitlist.' : ' move up from the waitlist.');
    return { patch: { set, del }, msg, status: st };
  }

  /** Several answers at once - the host applying a pasted group chat. Each
   *  goes through `rsvp` in turn, so the waitlist rules are the same. */
  function rsvpMany(group, gid, answers, ctx) {
    if (!ctx.actor.host) throw fail(403, 'Only the host can apply answers for others.');
    const list = (Array.isArray(answers) ? answers : []).slice(0, LIMITS.replies);
    const g = copy(group);
    const set = {}; const del = [];
    let n = 0;
    for (const x of list) {
      if (!x || !memberOf(g, x.id)) continue;
      const a = cleanAnswer(x.a);
      if (!a) continue;
      const cur = g.games[gid].rsvps && g.games[gid].rsvps[x.id];
      if (cur && cur.a === a) continue;
      const r = rsvp(g, gid, x.id, a, ctx);
      applyPatch(g, r.patch);
      Object.assign(set, r.patch.set);
      for (const k of r.patch.del) { del.push(k); delete set[k]; }
      for (const k of Object.keys(r.patch.set)) { const i = del.indexOf(k); if (i >= 0) del.splice(i, 1); }
      n++;
      const plus = Math.min(LIMITS.plusPerMember, Math.max(0, Number(x.plus) || 0));
      if (a === 'in' && plus) {
        const mine = Object.keys(g.games[gid].guests || {}).filter((k) => g.games[gid].guests[k].by === x.id).length;
        for (let i = mine; i < plus; i++) {
          const gr = addGuest(g, gid, { name: i ? 'Guest ' + (i + 1) : 'Guest', by: x.id }, ctx);
          applyPatch(g, gr.patch);
          Object.assign(set, gr.patch.set);
        }
      }
    }
    return { patch: { set, del }, msg: n ? 'Applied ' + plural(n, 'answer') + '.' : 'Nothing new to apply.', n };
  }

  /** A +1: a guest named by whoever brings them. In, first come first
   *  served like anyone; on the waitlist when it is full. */
  function addGuest(group, gid, b, ctx) {
    const game = gameOf(group, gid);
    const by = b.by && ctx.actor.host ? b.by : ctx.actor.mid;
    const bringer = memberOf(group, by);
    if (!bringer) throw fail(400, 'Say who is bringing them.');
    beforeKickoff(group, game, ctx);
    const name = cleanName(b.name);
    if (!name) throw fail(400, 'Add your guest’s name.');
    const guests = Object.keys(game.guests || {}).map((k) => game.guests[k]);
    if (guests.length >= LIMITS.guestsPerGame) throw fail(409, 'That’s plenty of guests for one game.');
    if (guests.filter((x) => x.by === by).length >= LIMITS.plusPerMember) throw fail(409, bringer.name + ' already has ' + LIMITS.plusPerMember + ' guests this week.');
    const xid = newId('x', ctx.rand);
    const set = {};
    set[P(gid, 'guests', xid)] = { name, by, t: nextT(game, ctx.now), skill: cleanSkill(b.skill) };
    const after = copy(group);
    applyPatch(after, { set, del: [] });
    const st = statusOf(lineup(after, after.games[gid]), xid);
    const label = name + ' (' + bringer.name + '’s +1)';
    return { patch: { set, del: [] }, id: xid, msg: st === 'in' ? label + ' is in.' : label + ' is #' + st.slice(4) + ' on the waitlist.' };
  }

  /** The host changes this week's game: time, place, cap, cost, date. A
   *  bigger cap moves waiters up; a smaller one moves the latest in down. */
  function editGame(group, gid, b, ctx) {
    if (!ctx.actor.host) throw fail(403, 'Only the host can change the game.');
    const game = gameOf(group, gid);
    const set = {}; const del = [];
    const next = copy(game);
    if (b.time !== undefined) { const t = cleanTime(b.time); if (!t) throw fail(400, 'Pick a time.'); next.time = t; }
    if (b.place !== undefined) next.place = cleanPlace(b.place);
    if (b.cap !== undefined) { const c = cleanCap(b.cap); if (!c) throw fail(400, 'A cap from ' + LIMITS.capMin + ' to ' + LIMITS.capMax + '.'); next.cap = c; }
    if (b.cost !== undefined) { const c = cleanCents(b.cost); if (c === null) throw fail(400, 'That cost doesn’t look right.'); next.cost = c; }
    if (b.date !== undefined) {
      if (!isDate(b.date) || Math.abs(daysBetween(game.date, b.date)) > 14) throw fail(400, 'Pick a date within two weeks.');
      next.date = b.date;
    }
    for (const k of ['time', 'place', 'cap', 'cost', 'date']) if (next[k] !== game[k]) set[P(gid, k)] = next[k];
    const mv = moves(group, game, next, null, 'cap');
    logPatch(game, mv.lines, ctx.now, ctx.rand, set, del);
    let msg = 'Saved.';
    if (mv.up.length) msg += ' ' + nameList(mv.up.map((e) => e.name)) + (mv.up.length === 1 ? ' is in from the waitlist.' : ' are in from the waitlist.');
    if (mv.down.length) msg += ' ' + nameList(mv.down.map((e) => e.name)) + ' moved to the waitlist.';
    return { patch: { set, del }, msg };
  }

  /** The host wraps the game up; the next week's opens on the next read. */
  function wrapUp(group, gid, ctx) {
    if (!ctx.actor.host) throw fail(403, 'Only the host can wrap up the game.');
    const game = gameOf(group, gid);
    if (!started(group, game, ctx.now)) throw fail(409, 'Wrap up after kickoff.');
    const set = {}; set[P(gid, 'done')] = true;
    return { patch: { set, del: [] }, msg: 'Wrapped up - next week’s game is open.' };
  }

  /* ------------------------------------------------------------------ *
   * Fair teams
   * ------------------------------------------------------------------ */

  /** How many splits there are of n players into `sides` teams as even in
   *  size as can be (labels not counted). */
  function splitCount(n, sides) {
    const base = Math.floor(n / sides); const extra = n % sides;
    let c = 1;
    let left = n;
    for (let t = 0; t < sides; t++) {
      const size = base + (t < extra ? 1 : 0);
      c *= binom(left, size);
      left -= size;
    }
    const fact = (k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return f; };
    return c / (fact(extra) * fact(sides - extra));
  }
  function binom(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); }

  /**
   * Split players into `sides` teams. Pure and deterministic: the same
   * players, skills, lines, last week and seed always give the same teams on
   * every phone.
   *
   * Lower is better, in this order: broken split/together lines, then
   * positions spread unevenly (two keepers on one team), then the skill gap
   * (team totals, a smaller team counted at the group's average for its empty
   * spot), then the very same teams as last week, then how many of last
   * week's teammates are together again. Ties break by a hash of the seed
   * (the game id) and the split, and the snake draft's order by a hash of the
   * seed and each person - so equal players land differently week to week.
   *
   * Up to LIMITS.exactLimit possible splits are all looked at, so the answer
   * is the best there is; beyond that (a big group, four sides) a snake draft
   * and a bounded search of swaps from several starts. `n` picks the n-th
   * best different split - Reshuffle.
   *
   * @param players [{id, skill 1-5, pos}]
   * @param o {sides, seed, n, lines: [{a, b, k: 'apart'|'together'}], last: [[ids]], usePos}
   */
  function balance(players, o) {
    const S = Math.max(2, Math.min(4, o.sides || 2));
    const ps = players.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    const N = ps.length;
    if (N < S) throw fail(400, 'Not enough players for ' + S + ' teams.');
    const seed = String(o.seed || '');
    const idx = {};
    ps.forEach((p, i) => { idx[p.id] = i; });
    const sk = ps.map((p) => cleanSkill(p.skill) || 3);
    const total = sk.reduce((s, x) => s + x, 0);
    const base = Math.floor(N / S); const extra = N % S; const maxSize = extra ? base + 1 : base;
    const posIds = o.usePos ? Array.from(new Set(ps.map((p) => p.pos).filter(Boolean))).sort() : [];
    const posOf = ps.map((p) => posIds.indexOf(p.pos));
    const lines = (o.lines || []).filter((l) => own(idx, l.a) && own(idx, l.b) && l.a !== l.b).map((l) => ({ a: idx[l.a], b: idx[l.b], k: l.k === 'together' ? 'together' : 'apart' }));
    // Last week: each player's team then (-1 for nobody), for pair counts.
    const lastTeam = ps.map(() => -1);
    const lastSides = Array.isArray(o.last) ? o.last.length : 0;
    (o.last || []).forEach((team, t) => (team || []).forEach((id) => { if (own(idx, id)) lastTeam[idx[id]] = t; }));
    const lastSizes = []; for (let t = 0; t < lastSides; t++) lastSizes.push(lastTeam.filter((x) => x === t).length);
    const sameSet = lastSides === S && (o.last || []).reduce((n, team) => n + (team || []).length, 0) === N && lastTeam.every((x) => x >= 0);
    const lastPairs = lastSizes.reduce((s, c) => s + (c * (c - 1)) / 2, 0);

    const sums = new Array(S); const sizes = new Array(S); const posC = []; const cross = [];
    function score(asg) {
      sums.fill(0); sizes.fill(0);
      for (let t = 0; t < S; t++) { posC[t] = new Array(posIds.length).fill(0); cross[t] = new Array(lastSides).fill(0); }
      for (let i = 0; i < N; i++) {
        const t = asg[i];
        sums[t] += sk[i]; sizes[t]++;
        if (posOf[i] >= 0) posC[t][posOf[i]]++;
        if (lastTeam[i] >= 0) cross[t][lastTeam[i]]++;
      }
      let hi = -Infinity; let lo = Infinity;
      for (let t = 0; t < S; t++) { const v = sums[t] * N + (maxSize - sizes[t]) * total; if (v > hi) hi = v; if (v < lo) lo = v; }
      let pos = 0;
      for (let p = 0; p < posIds.length; p++) {
        let a = Infinity; let b = -Infinity;
        for (let t = 0; t < S; t++) { a = Math.min(a, posC[t][p]); b = Math.max(b, posC[t][p]); }
        pos += Math.max(0, b - a - 1);
      }
      let broken = 0;
      for (const l of lines) if ((asg[l.a] === asg[l.b]) !== (l.k === 'together')) broken++;
      let rep = 0;
      for (let t = 0; t < S; t++) for (let u = 0; u < lastSides; u++) rep += (cross[t][u] * (cross[t][u] - 1)) / 2;
      const same = sameSet && rep === lastPairs ? 1 : 0;
      return broken * 1e12 + pos * 1e10 + (hi - lo) * 1e4 + same * 5000 + rep;
    }
    function key(asg) {
      const teams = [];
      for (let t = 0; t < S; t++) teams.push([]);
      for (let i = 0; i < N; i++) teams[asg[i]].push(ps[i].id);
      return teams.map((x) => x.join(',')).sort().join('|');
    }
    const want = Math.max(0, Number(o.n) || 0) + 1;
    let found = [];
    function consider(asg, sc) {
      if (found.length >= want && sc > found[found.length - 1].sc) return;
      const k = key(asg);
      const h = hash32(seed + '|' + k);
      if (found.some((f) => f.k === k)) return;
      const item = { sc, h, k, asg: asg.slice() };
      let i = found.length;
      while (i > 0 && (found[i - 1].sc > sc || (found[i - 1].sc === sc && found[i - 1].h > h))) i--;
      found.splice(i, 0, item);
      if (found.length > want) found.pop();
    }
    const count = splitCount(N, S);
    const exact = count <= LIMITS.exactLimit;
    if (exact) {
      // Every split, once: player i joins an open team or opens the next one
      // (a restricted growth string), sizes held to base / base + 1.
      const asg = new Array(N).fill(0);
      const size = new Array(S).fill(0);
      let big = 0;
      const walk = (i, open) => {
        if (i === N) {
          if (open === S) consider(asg, score(asg));
          return;
        }
        if (N - i < S - open) return;
        for (let t = 0; t <= Math.min(open, S - 1); t++) {
          if (size[t] >= maxSize) continue;
          const grows = size[t] === base && extra > 0;
          if (grows && big >= extra) continue;
          asg[i] = t; size[t]++; if (grows) big++;
          walk(i + 1, t === open ? open + 1 : open);
          size[t]--; if (grows) big--;
        }
      };
      walk(0, 0);
      if (found.length < want && found.length) {
        // Fewer different splits than reshuffles asked for: go round again.
        const n2 = (want - 1) % found.length;
        return balance(players, Object.assign({}, o, { n: n2 }));
      }
    } else {
      const starts = 10 + 3 * want;
      const optima = [];
      for (let v = 0; v < starts; v++) {
        const order = ps.map((p, i) => i).sort((a, b) => sk[b] - sk[a] || hash32(seed + '#' + v + '#' + ps[a].id) - hash32(seed + '#' + v + '#' + ps[b].id));
        const asg = new Array(N).fill(0);
        const size = new Array(S).fill(0);
        let t = v % S; let dir = 1;
        const capOf = (x) => base + (x < extra ? 1 : 0);
        for (const i of order) {
          let tries = 0;
          while (size[t] >= capOf(t) && tries < 2 * S) { t += dir; if (t >= S || t < 0) { dir = -dir; t += dir; } tries++; }
          asg[i] = t; size[t]++;
          t += dir; if (t >= S || t < 0) { dir = -dir; t += dir; }
        }
        // Swap search: take any swap that lowers the score, until none does.
        let sc = score(asg);
        for (let pass = 0; pass < 30; pass++) {
          let better = false;
          for (let i = 0; i < N; i++) {
            for (let j = i + 1; j < N; j++) {
              if (asg[i] === asg[j]) continue;
              const ti = asg[i]; asg[i] = asg[j]; asg[j] = ti;
              const s2 = score(asg);
              if (s2 < sc) { sc = s2; better = true; } else { asg[j] = asg[i]; asg[i] = ti; }
            }
          }
          if (!better) break;
        }
        optima.push({ asg: asg.slice(), sc });
        consider(asg, sc);
      }
      // Near the best: every single swap of the best few, so a reshuffle has
      // close alternatives to offer.
      optima.sort((a, b) => a.sc - b.sc);
      for (const op of optima.slice(0, 3)) {
        const asg = op.asg.slice();
        for (let i = 0; i < N; i++) {
          for (let j = i + 1; j < N; j++) {
            if (asg[i] === asg[j]) continue;
            const ti = asg[i]; asg[i] = asg[j]; asg[j] = ti;
            consider(asg, score(asg));
            asg[j] = asg[i]; asg[i] = ti;
          }
        }
      }
    }
    const pick = found[Math.min(found.length - 1, want - 1)];
    const asg = pick.asg;
    score(asg);
    const teams = [];
    for (let t = 0; t < S; t++) teams.push([]);
    for (let i = 0; i < N; i++) teams[asg[i]].push(ps[i].id);
    // Bigger teams first, then by the hash, so colours move week to week.
    const order = teams.map((tm, t) => t).sort((a, b) => teams[b].length - teams[a].length || hash32(seed + '@' + teams[a].join()) - hash32(seed + '@' + teams[b].join()));
    const out = order.map((t) => teams[t].slice().sort((a, b) => sk[idx[b]] - sk[idx[a]] || (a < b ? -1 : 1)));
    let hi = -Infinity; let lo = Infinity;
    for (let t = 0; t < S; t++) { const v = sums[t] * N + (maxSize - sizes[t]) * total; hi = Math.max(hi, v); lo = Math.min(lo, v); }
    const sc = pick.sc;
    return {
      sides: out,
      gap: Math.round(((hi - lo) / N) * 10) / 10,
      broken: Math.floor(sc / 1e12),
      posOff: Math.floor((sc % 1e12) / 1e10),
      same: sameSet && Math.round(sc % 1e4) >= 5000 ? true : false,
      exact,
      score: sc,
      key: pick.k,
    };
  }
  /** "Dead even", "Within 1 point", "2.5 points apart". */
  function gapText(gap) {
    if (!(gap > 0)) return 'Dead even on skill';
    if (gap <= 1) return 'Within 1 point';
    return (Math.round(gap * 10) / 10) + ' points apart';
  }
  function suggestSides(n, perSide) {
    const ps = Math.max(1, perSide || 5);
    if (n >= 3 * ps && n >= 6) return Math.min(4, Math.floor(n / ps));
    return 2;
  }
  /** The players teams are made from, with the number each is balanced on. */
  function playersFor(group, game) {
    const lu = lineup(group, game);
    return lu.in.map((e) => (e.kind === 'm' ? { id: e.id, skill: skillOf(e.m), pos: e.m.pos || '' } : { id: e.id, skill: cleanSkill(e.x.skill) || 3, pos: '' }));
  }
  const basisOf = (ids) => ids.slice().sort().join(',');

  /** The host makes (or remakes) the teams from whoever is In. `n` is the
   *  reshuffle count: 0 is the best split, 1 the next-best different one. */
  function makeTeams(group, gid, b, ctx) {
    if (!ctx.actor.host) throw fail(403, 'The host makes the teams.');
    const game = gameOf(group, gid);
    const players = playersFor(group, game);
    const sides = Math.max(2, Math.min(4, Number(b.sides) || 2));
    if (players.length < sides * 2) throw fail(409, 'You need at least ' + sides * 2 + ' in to make ' + sides + ' teams.');
    const n = Math.max(0, Math.min(500, Number(b.n) || 0));
    const prev = previousWithTeams(group, game);
    const r = balance(players, { sides, seed: gid, n, lines: group.lines || [], last: prev ? prev.teams.sides : null, usePos: Boolean(group.usePos) });
    const teams = { sides: r.sides, n, gap: r.gap, broken: r.broken, posOff: r.posOff, same: r.same, made: ctx.now, basis: basisOf(players.map((p) => p.id)) };
    const set = {}; set[P(gid, 'teams')] = teams;
    const del = Object.keys(game.matches || {}).map((k) => P(gid, 'matches', k));
    return { patch: { set, del }, msg: (n ? 'Reshuffled' : 'Teams made') + ' - ' + gapText(r.gap).toLowerCase() + '.', teams };
  }
  function clearTeams(group, gid, ctx) {
    if (!ctx.actor.host) throw fail(403, 'The host makes the teams.');
    const game = gameOf(group, gid);
    const set = {}; set[P(gid, 'teams')] = null;
    return { patch: { set, del: Object.keys(game.matches || {}).map((k) => P(gid, 'matches', k)) }, msg: 'Teams cleared.' };
  }
  /** True when the In list moved since the teams were made. */
  function teamsStale(group, game) {
    if (!game.teams || !game.teams.basis) return false;
    return game.teams.basis !== basisOf(lineup(group, game).in.map((e) => e.id));
  }
  /** Team totals per side (the host sees these; others see only the gap). */
  function teamSums(group, game) {
    if (!game.teams) return [];
    const by = {};
    for (const p of playersFor(group, game)) by[p.id] = p.skill;
    return game.teams.sides.map((ids) => ids.reduce((s, id) => s + (by[id] || 3), 0));
  }

  /**
   * Winner stays on, for three or four teams: two play, the rest queue. The
   * loser goes to the back; the winner stays - for STAY_MAX games at most,
   * then goes to the back too so everyone plays. A draw sends both off, the
   * one that was on longer first. Two teams just play each other.
   */
  function rotation(sides, matches) {
    const S = Math.max(2, sides);
    if (S === 2) return { on: [0, 1], queue: [], streak: null };
    let on = [0, 1];
    let queue = [];
    for (let t = 2; t < S; t++) queue.push(t);
    let since = { 0: 0, 1: 0 }; // when each team on court came on
    let wins = { 0: 0, 1: 0 };
    let clock = 0;
    for (const m of matches) {
      clock++;
      const a = m.a; const b = m.b;
      if (on.indexOf(a) < 0 || on.indexOf(b) < 0) { on = [a, b]; queue = []; for (let t = 0; t < S; t++) if (t !== a && t !== b) queue.push(t); since = {}; since[a] = clock; since[b] = clock; wins = {}; wins[a] = 0; wins[b] = 0; }
      if (m.w === 'a' || m.w === 'b') {
        const win = m.w === 'a' ? a : b; const lose = m.w === 'a' ? b : a;
        wins[win] = (wins[win] || 0) + 1;
        queue.push(lose);
        if (wins[win] >= STAY_MAX) {
          queue.push(win);
          on = [queue.shift(), queue.shift()];
          since = {}; since[on[0]] = clock; since[on[1]] = clock; wins = {}; wins[on[0]] = 0; wins[on[1]] = 0;
        } else {
          const nxt = queue.shift();
          on = [win, nxt];
          since[nxt] = clock; wins[nxt] = 0;
        }
      } else {
        const first = (since[a] || 0) <= (since[b] || 0) ? a : b;
        queue.push(first, first === a ? b : a);
        on = [queue.shift(), queue.shift()];
        since = {}; since[on[0]] = clock; since[on[1]] = clock; wins = {}; wins[on[0]] = 0; wins[on[1]] = 0;
      }
    }
    const holder = (wins[on[0]] || 0) >= (wins[on[1]] || 0) ? on[0] : on[1];
    return { on, queue, streak: wins[holder] ? { team: holder, wins: wins[holder] } : null };
  }

  /* ------------------------------------------------------------------ *
   * Results
   * ------------------------------------------------------------------ */

  function matchList(game) {
    return Object.keys(game.matches || {}).map((k) => Object.assign({ id: k }, game.matches[k])).filter((m) => m && Number.isInteger(m.a)).sort((x, y) => (x.t || 0) - (y.t || 0) || (x.id < y.id ? -1 : 1));
  }
  function cleanScore(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'string' && /^\s*\d{1,3}\s*$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n >= 0 && n <= 999 ? n : undefined;
  }
  /** A result: a score (11-8) or just who won (or a draw). Any member may
   *  enter one; the host or whoever entered it may take it back. */
  function addMatch(group, gid, b, ctx) {
    const game = gameOf(group, gid);
    if (!game.teams || !Array.isArray(game.teams.sides)) throw fail(409, 'Make the teams first.');
    const S = game.teams.sides.length;
    const a = Number(b.a); const bb = Number(b.b);
    if (!Number.isInteger(a) || !Number.isInteger(bb) || a === bb || a < 0 || bb < 0 || a >= S || bb >= S) throw fail(400, 'Pick the two teams that played.');
    const sa = cleanScore(b.sa); const sb = cleanScore(b.sb);
    if (sa === undefined || sb === undefined) throw fail(400, 'A score is a number from 0 to 999.');
    let w = b.w;
    if (sa !== null && sb !== null) w = sa > sb ? 'a' : sa < sb ? 'b' : 'd';
    else if (sa !== null || sb !== null) throw fail(400, 'Add both scores, or just who won.');
    if (['a', 'b', 'd'].indexOf(w) < 0) throw fail(400, 'Who won?');
    if (Object.keys(game.matches || {}).length >= LIMITS.matches) throw fail(409, 'That’s a lot of games for one night.');
    const rid = newId('r', ctx.rand);
    const set = {}; set[P(gid, 'matches', rid)] = { a, b: bb, sa, sb, w, t: ctx.now, by: ctx.actor.mid || null };
    const A = TEAMS[a].name; const B = TEAMS[bb].name;
    const score = sa !== null ? ' ' + Math.max(sa, sb) + '-' + Math.min(sa, sb) : '';
    return { patch: { set, del: [] }, id: rid, msg: w === 'd' ? A + ' and ' + B + ' drew' + (sa !== null ? ' ' + sa + '-' + sb : '') + '.' : (w === 'a' ? A + ' beat ' + B : B + ' beat ' + A) + score + '.' };
  }
  function removeMatch(group, gid, rid, ctx) {
    const game = gameOf(group, gid);
    const m = game.matches && own(game.matches, rid) ? game.matches[rid] : null;
    if (!m) throw fail(404, 'That result isn’t here any more.');
    if (!ctx.actor.host && m.by !== ctx.actor.mid) throw fail(403, 'Only the host or whoever entered it can take a result back.');
    return { patch: { set: {}, del: [P(gid, 'matches', rid)] }, msg: 'Result removed.' };
  }

  /** Who played: what the host ticked, else the teams, else whoever is In. */
  function playedIds(group, game) {
    const known = (id) => Boolean(memberOf(group, id) || (game.guests && own(game.guests, id)));
    if (Array.isArray(game.played)) return game.played.filter(known);
    if (game.teams && Array.isArray(game.teams.sides)) return [].concat.apply([], game.teams.sides).filter(known);
    return lineup(group, game).in.map((e) => e.id);
  }
  function setPlayed(group, gid, ids, ctx) {
    if (!ctx.actor.host) throw fail(403, 'Only the host can change who played.');
    const game = gameOf(group, gid);
    const ok = (Array.isArray(ids) ? ids : []).filter((id, i, a) => typeof id === 'string' && a.indexOf(id) === i && (memberOf(group, id) || (game.guests && own(game.guests, id))));
    const set = {}; set[P(gid, 'played')] = ok.slice(0, LIMITS.members + LIMITS.guestsPerGame);
    return { patch: { set, del: [] }, msg: plural(ok.length, 'player') + ' played.' };
  }

  /* ------------------------------------------------------------------ *
   * Player of the Week
   * ------------------------------------------------------------------ */

  /** Open from kickoff until the host closes it, everyone who played has
   *  voted, or VOTE_HOURS pass. One vote per regular who played, for anyone
   *  else who played; the result shows only once it closes. */
  function potw(group, game, now, me) {
    const played = playedIds(group, game);
    const voters = played.filter((id) => memberOf(group, id));
    const votes = {};
    for (const v of Object.keys(game.votes || {})) if (voters.indexOf(v) >= 0 && played.indexOf(game.votes[v]) >= 0 && game.votes[v] !== v) votes[v] = game.votes[v];
    const ko = kickoff(group, game);
    const n = Object.keys(votes).length;
    const voteCount = typeof game.voteCount === 'number' ? game.voteCount : n; // a member's view carries the count, not the votes
    let reason = null;
    if (game.potwClosed) reason = 'host';
    else if (voters.length && voteCount >= voters.length) reason = 'all';
    else if (now >= ko + VOTE_HOURS * 3600 * 1000) reason = 'time';
    const open = now >= ko && !reason && voters.length >= 2;
    const out = { open, closed: Boolean(reason) && now >= ko, reason, voters, played, count: voteCount, mine: me && votes[me] ? votes[me] : (me && game.votes && game.votes[me]) || null, closesAt: ko + VOTE_HOURS * 3600 * 1000, winners: [], tally: {} };
    if (out.closed) {
      for (const v of Object.keys(votes)) out.tally[votes[v]] = (out.tally[votes[v]] || 0) + 1;
      const top = Math.max(0, ...Object.keys(out.tally).map((k) => out.tally[k]));
      if (top > 0) out.winners = Object.keys(out.tally).filter((k) => out.tally[k] === top).sort((a, b) => (nameOf(group, game, a) < nameOf(group, game, b) ? -1 : 1));
      out.top = top;
    }
    return out;
  }
  function vote(group, gid, voter, cand, ctx) {
    const game = gameOf(group, gid);
    // On a phone the host runs for everyone, votes are tapped in for each
    // person; online, everyone casts their own.
    if (voter !== ctx.actor.mid && (!ctx.actor.host || ctx.actor.online)) throw fail(403, 'You vote for yourself only.');
    const st = potw(group, game, ctx.now, voter);
    if (!st.open) throw fail(409, st.closed ? 'Voting has closed.' : 'Voting opens at kickoff.');
    if (st.voters.indexOf(voter) < 0) throw fail(403, 'Only regulars who played this week vote.');
    const set = {}; const del = [];
    if (cand === null) del.push(P(gid, 'votes', voter));
    else {
      if (st.played.indexOf(cand) < 0) throw fail(400, 'Vote for someone who played.');
      if (cand === voter) throw fail(400, 'Nice try - vote for someone else.');
      set[P(gid, 'votes', voter)] = cand;
    }
    return { patch: { set, del }, msg: cand === null ? 'Vote taken back.' : 'Vote in - it’s secret until voting closes. 🤫' };
  }
  function closeVotes(group, gid, ctx) {
    if (!ctx.actor.host) throw fail(403, 'Only the host can close the vote.');
    gameOf(group, gid);
    const set = {}; set[P(gid, 'potwClosed')] = true;
    return { patch: { set, del: [] }, msg: 'Voting closed - here’s the Player of the Week.' };
  }

  /* ------------------------------------------------------------------ *
   * The season: standings, streaks, attendance
   * ------------------------------------------------------------------ */

  function standings(group, now) {
    const past = games(group).filter((g) => started(group, g, now));
    const rows = {};
    for (const m of group.members || []) rows[m.id] = { id: m.id, name: m.name, emoji: m.emoji, games: 0, w: 0, d: 0, l: 0, results: [], potw: 0, came: 0, of: 0 };
    for (const g of past) {
      const played = playedIds(group, g);
      for (const id of played) if (rows[id]) rows[id].games++;
      if (g.teams && Array.isArray(g.teams.sides)) {
        const teamOf = {};
        g.teams.sides.forEach((ids, t) => ids.forEach((id) => { teamOf[id] = t; }));
        for (const m of matchList(g)) {
          for (const id of Object.keys(rows)) {
            if (!own(teamOf, id) || played.indexOf(id) < 0) continue;
            const t = teamOf[id];
            if (t !== m.a && t !== m.b) continue;
            const r = m.w === 'd' ? 'D' : (m.w === 'a') === (t === m.a) ? 'W' : 'L';
            rows[id].results.push(r);
            if (r === 'W') rows[id].w++; else if (r === 'L') rows[id].l++; else rows[id].d++;
          }
        }
      }
      const pw = potw(group, g, now, null);
      if (pw.closed) for (const id of pw.winners) if (rows[id]) rows[id].potw++;
    }
    const last10 = past.slice(-10);
    const list = Object.keys(rows).map((k) => rows[k]);
    for (const r of list) {
      r.of = last10.length;
      r.came = last10.filter((g) => playedIds(group, g).indexOf(r.id) >= 0).length;
      const mp = r.w + r.d + r.l;
      r.matches = mp;
      r.pct = mp ? Math.round((100 * r.w) / mp) : null;
      let s = 0;
      const lastR = r.results[r.results.length - 1];
      for (let i = r.results.length - 1; i >= 0 && r.results[i] === lastR; i--) s++;
      r.streak = lastR ? { r: lastR, n: s } : null;
      delete r.results;
    }
    list.sort((a, b) => b.w - a.w || (b.pct || 0) - (a.pct || 0) || b.games - a.games || (a.name < b.name ? -1 : 1));
    return { rows: list, games: past.length };
  }
  /** "🔥 3 wins in a row", "came 9 of the last 10". */
  function streakText(s) {
    if (!s || s.n < 2) return '';
    if (s.r === 'W') return '🔥 ' + s.n + ' wins in a row';
    if (s.r === 'L') return s.n + ' losses in a row';
    return s.n + ' draws in a row';
  }

  /* ------------------------------------------------------------------ *
   * Court money: the cost split among who played. No payments - Pickup
   * never holds or moves money; it keeps the list of who has paid.
   * ------------------------------------------------------------------ */

  function collectorOf(group) { const c = memberOf(group, group.collector); return c || hostOf(group); }
  /** Each player's share in cents, the cost split to the cent (the spare
   *  cents go one each to the first players by id), and who pays it: a +1's
   *  share is owed by whoever brought them. */
  function shares(group, game) {
    const ids = playedIds(group, game).slice().sort();
    const cost = cleanCents(game.cost) || 0;
    const out = { each: {}, owed: {}, cost, players: ids.length };
    if (!ids.length || !cost) return out;
    const base = Math.floor(cost / ids.length); let rem = cost - base * ids.length;
    for (const id of ids) {
      const c = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--;
      out.each[id] = c;
      const x = game.guests && own(game.guests, id) ? game.guests[id] : null;
      const payer = x && memberOf(group, x.by) ? x.by : id;
      out.owed[payer] = (out.owed[payer] || 0) + c;
    }
    return out;
  }
  function isPaid(group, game, payer) {
    const col = collectorOf(group);
    return Boolean((col && col.id === payer) || (game.paid && own(game.paid, payer) && game.paid[payer]));
  }
  /** Who owes what, across the season: every game that has kicked off. */
  function money(group, now) {
    const per = {};
    const weeks = [];
    let outstanding = 0;
    for (const g of games(group)) {
      if (!started(group, g, now)) continue;
      const sh = shares(group, g);
      if (!sh.cost) continue;
      const rows = Object.keys(sh.owed).map((payer) => ({ id: payer, cents: sh.owed[payer], paid: isPaid(group, g, payer) }));
      const owing = rows.filter((r) => !r.paid);
      weeks.push({ id: g.id, date: g.date, cost: sh.cost, players: sh.players, rows, owing: owing.reduce((s, r) => s + r.cents, 0) });
      for (const r of owing) {
        const p = per[r.id] || (per[r.id] = { id: r.id, cents: 0, games: [] });
        p.cents += r.cents; p.games.push({ id: g.id, date: g.date, cents: r.cents });
        outstanding += r.cents;
      }
    }
    const list = Object.keys(per).map((k) => per[k]).sort((a, b) => b.cents - a.cents || (a.id < b.id ? -1 : 1));
    return { owes: list, weeks: weeks.reverse(), outstanding };
  }
  function markPaid(group, gid, payer, paid, ctx) {
    const game = gameOf(group, gid);
    if (!ctx.actor.host && payer !== ctx.actor.mid) throw fail(403, 'Tick your own - the host can tick anyone.');
    const sh = shares(group, game);
    if (!own(sh.owed, payer)) throw fail(404, 'Nothing is owed for that game.');
    const set = {}; const del = [];
    if (paid) set[P(gid, 'paid', payer)] = { t: ctx.now, by: ctx.actor.mid || null };
    else del.push(P(gid, 'paid', payer));
    const who = (memberOf(group, payer) || {}).name || 'Someone';
    return { patch: { set, del }, msg: paid ? (payer === ctx.actor.mid ? 'Marked paid - thanks!' : who + ' marked paid.') : who + ' marked unpaid.' };
  }
  /** The copyable line for the group chat. */
  function reminderText(group, m) {
    const col = collectorOf(group);
    if (!m.owes.length) return group.name + ' - everyone’s paid up for the court. Thanks all! 🙌';
    const parts = m.owes.map((p) => {
      const mem = memberOf(group, p.id);
      return (mem ? mem.name : 'Someone') + ' ' + fmtMoney(p.cents, group.cur) + ' (' + p.games.map((g) => shortDate(g.date)).join(', ') + ')';
    });
    return 'Court money for ' + group.name + ': ' + parts.join(' · ') + '.' + (col ? ' Pay ' + col.name + ' - thanks!' : ' Thanks!');
  }

  /* ------------------------------------------------------------------ *
   * Sharing (Pickup never sends anything itself)
   * ------------------------------------------------------------------ */

  function gameLine(group, game) { return [timeLabel(game.time), game.place ? '@ ' + game.place : ''].filter(Boolean).join(' '); }
  /** "Thursday Hoops 7pm @ Riverside - 8 in, need 2. Tap to say you're in: <link>" */
  function shareText(group, game, link) {
    const lu = lineup(group, game);
    const n = lu.in.length;
    const state = lu.wait.length ? 'full, ' + lu.wait.length + ' waiting' : n >= lu.cap ? 'full' : n + ' in, need ' + (lu.cap - n);
    return group.name + ' ' + gameLine(group, game) + ' - ' + state + '. ' + (link ? (lu.wait.length || n >= lu.cap ? 'Join the waitlist: ' : 'Tap to say you’re in: ') + link : 'Reply in, out or maybe!');
  }
  function nudgeText(group, game, name, link) {
    const lu = lineup(group, game);
    const need = Math.max(0, lu.cap - lu.in.length);
    return 'Hey ' + name + ' - ' + sportOf(group).thing + ' ' + whenWord(group, game) + ' ' + gameLine(group, game) + '. ' + (need ? 'We’re at ' + lu.in.length + ', need ' + need + '. You in?' : 'It’s full but people drop out - want a waitlist spot?') + (link ? ' ' + link : '');
  }
  function whenWord(group, game) { return WEEKDAY_NAMES[weekday(game.date)]; }
  function teamsText(group, game) {
    if (!game.teams) return '';
    const lines = game.teams.sides.map((ids, t) => TEAMS[t].name + ': ' + ids.map((id) => nameOf(group, game, id)).join(', '));
    return group.name + ' - teams for ' + dateLabel(game.date) + '\n' + lines.join('\n') + '\n(' + gapText(game.teams.gap) + ', made by Pickup)';
  }

  /* ------------------------------------------------------------------ *
   * Answers from a group chat: one door, and a free reader
   * ------------------------------------------------------------------ */

  /** Every answer - typed, read by the free parser, read by a model - comes
   *  through here: a name (bounded, markup and bidi stripped), in / maybe /
   *  out, and 0-3 +1s. Anything else is dropped. */
  function cleanReply(r) {
    if (!r || typeof r !== 'object') return null;
    const name = cleanName(r.name);
    const answer = cleanAnswer(typeof r.answer === 'string' ? r.answer.toLowerCase() : r.answer);
    if (!name || !answer) return null;
    const p = typeof r.plusOnes === 'string' && /^\s*\d\s*$/.test(r.plusOnes) ? Number(r.plusOnes) : r.plusOnes;
    return { name, answer, plusOnes: answer === 'in' && Number.isInteger(p) && p > 0 ? Math.min(LIMITS.plusPerMember, p) : 0 };
  }

  // A chat line's own prefix: WhatsApp's "[08/10/2026, 18:42:11] " (iOS) or
  // "08/10/2026, 18:42 - " (Android), US dates, 12- or 24-hour.
  const STAMP = /^\[?\d{1,4}[/.\-]\d{1,2}[/.\-]\d{2,4},?\s+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s*[AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:[-–]\s*)?/;
  const SYSTEM = /end-to-end encrypted|<media omitted>|image omitted|video omitted|sticker omitted|gif omitted|this message was deleted|created group|added you|changed the subject|changed this group|joined using|left$|missed (voice|video) call/i;
  const W_OUT = /(?:^|[^\p{L}])(out|can'?t|cant|cannot|can not|won'?t|not (?:this|tonight|today|coming|playing)|no|nope|skip(?:ping)?|injured|away|busy|pass|sorry|next week)(?=$|[^\p{L}])|❌|👎|🚫|🤕/iu;
  const W_MAYBE = /(?:^|[^\p{L}])(maybe|might|probably|possibly|tbc|tbd|not sure|depends|hopefully|50\/50|50-50|prob)(?=$|[^\p{L}])|🤔|🤞/iu;
  const W_IN = /(?:^|[^\p{L}])(in|i'?m in|im in|count me in|yes|yep|yeah|yup|ya|sure|playing|i'?ll be there|be there|coming|down|let'?s go|lets go|see you there|deal)(?=$|[^\p{L}])|👍|✅|🙋|💪|🙌|👌|🏀|⚽|🏐|🏓|🥏|🎾|✋/iu;

  function classify(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 80) return null;
    const out = W_OUT.test(t); const maybe = W_MAYBE.test(t); const yes = W_IN.test(t);
    if (maybe && !out) return 'maybe';
    if (out && yes) return null;
    if (out) return 'out';
    if (yes) return 'in';
    return null;
  }
  function plusOf(text) {
    const m = /\+\s?([1-3])(?!\d)/.exec(text);
    if (m) return Number(m[1]);
    if (/plus one|bringing (?:a|my) (?:mate|friend|buddy|pal|brother|sister)|\+ ?a friend/i.test(text)) return 1;
    return 0;
  }
  const looksLikeName = (s) => /\p{L}/u.test(s) && !/\d{4,}/.test(s.replace(/\s/g, '')) && s.length <= 40;

  /**
   * The free reader: lines from a WhatsApp export or a pasted iMessage
   * thread. Understands
   *   "[08/10/2026, 18:42:11] Sam Lee: I'm in"   (a WhatsApp export)
   *   "Sam: can't make it"  "in - Mia"  "Mia - in"  "Tom out"  "Jo ✅"
   *   "1. Sam" "2) Jo +1"   (the "who's in" list people build in the chat)
   * and leaves the rest for the AI: anything ambiguous ("can't wait, I'm
   * in"), long, or without a name. A person's last answer wins.
   */
  function parseChat(text, opt) {
    const raw = typeof text === 'string' ? text.slice(0, LIMITS.pasteText) : '';
    const replies = []; const unread = [];
    const at = {};
    for (let line of raw.split(/\r?\n/)) {
      line = line.replace(STRIP, '').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      const hadStamp = STAMP.test(line);
      line = line.replace(STAMP, '').replace(/^~\s*/, '').trim();
      if (!line || SYSTEM.test(line)) continue;
      let name = null; let body = null; let answer = null;
      const list = /^(\d{1,2})\s*[.)\-:]\s*(.+)$/.exec(line);
      const colon = /^([^:]{1,40}):\s*(.+)$/.exec(line);
      const item = list && !hadStamp ? list[2] : colon && /^\d{1,2}\s*[.)]\s*\S/.test(colon[2]) ? colon[2].replace(/^\d{1,2}\s*[.)]\s*/, '') : null;
      if (item) {
        // "Who's in" lists: each numbered line is a name that's in, unless
        // it says otherwise ("3. Mia (maybe)", "4. Jo - out").
        const nm = item.replace(/\(.*?\)|\s[-–]\s.*$|\+\s?[1-3](?!\d)|[✅👍❌🤔]/gu, ' ').replace(/\s+/g, ' ').trim();
        const marks = ((/\((.*?)\)/.exec(item) || [])[1] || '') + ' ' + ((/\s[-–]\s(.*)$/.exec(item) || [])[1] || '') + ' ' + (item.match(/[❌🤔]/gu) || []).join(' ');
        const c = classify(marks.trim());
        name = nm; body = item; answer = c || 'in';
      } else if (colon && looksLikeName(colon[1].replace(/^~\s*/, ''))) {
        name = colon[1].replace(/^~\s*/, '').trim(); body = colon[2];
        if (/^(in|out|maybe|can'?t|cant|ins|outs|playing|not playing|subs?)$/i.test(name)) {
          // "Out: Jo, Mia" - a list under a heading.
          const a = classify(name) || (/^ins?$|playing/i.test(name) ? 'in' : null);
          const names = body.split(/,|&|\band\b/).map((s) => s.trim()).filter(Boolean);
          if (a && names.every(looksLikeName)) { for (const n of names) push(n, a, n); continue; }
        }
        answer = classify(body);
        if (/^(?:\+\s?[1-3]|plus one)$/i.test(body.trim())) answer = 'in';
      } else {
        const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(line);
        const tail = /^(.+?)\s+(in|out|maybe|✅|👍|❌|🤔)$/iu.exec(line);
        if (dash) {
          const l = classify(dash[1]); const r = classify(dash[2]);
          if (l && !r && looksLikeName(dash[2])) { name = dash[2]; answer = l; body = dash[1]; }
          else if (r && !l && looksLikeName(dash[1])) { name = dash[1]; answer = r; body = dash[2]; }
        } else if (tail && looksLikeName(tail[1]) && tail[1].split(' ').length <= 3) {
          name = tail[1]; answer = classify(tail[2]); body = tail[2];
        }
      }
      if (name && answer) push(name, answer, body || '');
      else unread.push(line.slice(0, 120));
    }
    function push(n, a, b) {
      const r = cleanReply({ name: n.replace(/[.,!]+$/, ''), answer: a, plusOnes: plusOf(b) });
      if (!r) return;
      const k = fold(r.name);
      if (own(at, k)) replies.splice(at[k], 1, r); else { at[k] = replies.length; replies.push(r); }
    }
    void opt;
    return { replies: replies.slice(0, LIMITS.replies), unread: unread.slice(0, 200), unreadCount: unread.length };
  }

  /** Match answers to the group's regulars by name: the whole name, else a
   *  first name only one regular has, else a regular called by the chat
   *  name's first word ("Sam Lee" -> Sam). Unmatched names come back with
   *  `id: null`, to add as new regulars if the host ticks them. */
  function matchReplies(replies, members) {
    const ms = (members || []).map((m) => ({ m, full: fold(m.name), first: fold(m.name).split(' ')[0] }));
    const used = {};
    return (replies || []).map((r0) => {
      const r = cleanReply(r0);
      if (!r) return null;
      const f = fold(r.name); const first = f.split(' ')[0];
      let hit = ms.filter((x) => x.full === f);
      if (hit.length !== 1) hit = ms.filter((x) => x.first === f);
      if (hit.length !== 1) hit = ms.filter((x) => x.full === first);
      if (hit.length !== 1) hit = ms.filter((x) => x.first === first);
      if (hit.length !== 1 && first.length >= 3) hit = ms.filter((x) => x.first.indexOf(first) === 0 || first.indexOf(x.first) === 0 && x.first.length >= 3);
      const m = hit.length === 1 ? hit[0].m : null;
      const id = m && !used[m.id] ? m.id : null;
      if (id) used[id] = 1;
      return { name: r.name, answer: r.answer, plusOnes: r.plusOnes, id, member: id ? m.name : null };
    }).filter(Boolean);
  }

  /* ------------------------------------------------------------------ *
   * The group: members, lines, settings
   * ------------------------------------------------------------------ */

  function nameTaken(group, name, except) {
    const k = fold(name);
    return (group.members || []).some((m) => m.id !== except && fold(m.name) === k);
  }
  function pickEmoji(group, wanted) {
    const taken = new Set((group.members || []).map((m) => m.emoji));
    if (cleanEmoji(wanted) && !taken.has(wanted)) return wanted;
    return EMOJI.find((e) => !taken.has(e)) || cleanEmoji(wanted) || EMOJI[0];
  }
  function cleanPos(group, v) {
    if (!v) return '';
    return sportOf(group).positions.some((p) => p.id === v) ? v : '';
  }
  /** A regular as stored on a phone or sent to go online - only known fields. */
  function cleanMember(group, raw, rand) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const name = cleanName(r.name);
    if (!name) return null;
    return { id: isMemberId(r.id) ? r.id : newId('m', rand), name, emoji: cleanEmoji(r.emoji) || EMOJI[0], skill: cleanSkill(r.skill), adj: cleanSkill(r.adj), pos: cleanPos(group, r.pos), host: r.host === true };
  }
  /** The host adds regulars by name (people who may never open the app:
   *  the host answers for them, or they join and say "that's me"). */
  function addMembers(group, names, ctx) {
    if (!ctx.actor.host) throw fail(403, 'Only the host adds regulars.');
    const list = (Array.isArray(names) ? names : [names]).slice(0, LIMITS.members);
    const out = [];
    const g = copy(group);
    for (const n0 of list) {
      const name = cleanName(n0);
      if (!name || nameTaken(g, name)) continue;
      if (g.members.length >= LIMITS.members) throw fail(409, 'A group has ' + LIMITS.members + ' regulars at most.');
      const m = { id: newId('m', ctx.rand), name, emoji: pickEmoji(g, null), skill: null, adj: null, pos: '', host: false };
      g.members.push(m);
      out.push(m);
    }
    return { members: out, msg: out.length ? 'Added ' + nameList(out.map((m) => m.name)) + '.' : 'Nobody new to add.' };
  }
  function cleanLines(group, list) {
    const ids = new Set((group.members || []).map((m) => m.id));
    const seen = {};
    const out = [];
    for (const l of Array.isArray(list) ? list.slice(0, 100) : []) {
      if (!l || !ids.has(l.a) || !ids.has(l.b) || l.a === l.b) continue;
      const k = [l.a, l.b].sort().join('|');
      if (seen[k]) continue;
      seen[k] = 1;
      out.push({ a: l.a, b: l.b, k: l.k === 'together' ? 'together' : 'apart' });
      if (out.length >= LIMITS.lines) break;
    }
    return out;
  }
  function cleanSched(group, raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const sp = sportOf(group);
    return {
      wd: cleanWd(r.wd) === null ? 3 : r.wd,
      time: cleanTime(r.time) || '19:00',
      place: cleanPlace(r.place),
      cap: cleanCap(r.cap) || sp.cap,
      cost: cleanCents(r.cost) || 0,
    };
  }
  function cleanMap(raw, keyOk, fn, max) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let n = 0;
    for (const k of Object.keys(raw)) {
      if (n >= max) break;
      if (!keyOk(k)) continue;
      const v = fn(raw[k], k);
      if (v === null || v === undefined) continue;
      out[k] = v; n++;
    }
    return out;
  }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
  /** A game as stored on a phone or sent to go online: every field checked,
   *  only this group's people, nothing else kept. */
  function cleanGame(group, raw, gid) {
    const r = raw && typeof raw === 'object' ? raw : {};
    if (!isGameId(gid) || !isDate(r.date)) return null;
    const mids = new Set((group.members || []).map((m) => m.id));
    const guests = cleanMap(r.guests, isGuestId, (x) => {
      const name = cleanName(x && x.name);
      return name && x && mids.has(x.by) ? { name, by: x.by, t: num(x.t, 0), skill: cleanSkill(x.skill) } : null;
    }, LIMITS.guestsPerGame);
    const pid = (id) => mids.has(id) || own(guests, id);
    const g = {
      id: gid, date: r.date, time: cleanTime(r.time) || '19:00', place: cleanPlace(r.place), cap: cleanCap(r.cap) || 10, cost: cleanCents(r.cost) || 0,
      rsvps: cleanMap(r.rsvps, (k) => mids.has(k), (x) => (x && cleanAnswer(x.a) ? { a: x.a, t: num(x.t, 0), by: mids.has(x.by) ? x.by : null } : null), LIMITS.members),
      guests,
      log: cleanMap(r.log, (k) => LOG_ID.test(k), (l) => (l && (l.k === 'up' || l.k === 'down') && cleanName(l.who) ? { k: l.k, who: cleanName(l.who), whom: cleanName(l.whom) || null, why: l.why === 'out' ? 'out' : 'cap', t: num(l.t, 0) } : null), LIMITS.log),
      teams: null,
      matches: {},
      played: Array.isArray(r.played) ? r.played.filter((id, i, a) => typeof id === 'string' && pid(id) && a.indexOf(id) === i) : null,
      paid: cleanMap(r.paid, (k) => mids.has(k), (x) => (x ? { t: num(x.t, 0), by: mids.has(x && x.by) ? x.by : null } : null), LIMITS.members),
      votes: cleanMap(r.votes, (k) => mids.has(k), (c) => (typeof c === 'string' && pid(c) ? c : null), LIMITS.members),
      potwClosed: r.potwClosed === true,
      done: r.done === true,
      created: num(r.created, 0),
    };
    if (r.teams && Array.isArray(r.teams.sides) && r.teams.sides.length >= 2 && r.teams.sides.length <= 4) {
      const seen = {};
      const sides = r.teams.sides.map((ids) => (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && pid(id) && !seen[id] && (seen[id] = 1)));
      if (sides.every((s) => s.length)) {
        g.teams = { sides, n: num(r.teams.n, 0), gap: Number.isFinite(Number(r.teams.gap)) ? Math.max(0, Math.round(Number(r.teams.gap) * 10) / 10) : 0, broken: num(r.teams.broken, 0), posOff: num(r.teams.posOff, 0), same: r.teams.same === true, made: num(r.teams.made, 0), basis: typeof r.teams.basis === 'string' ? r.teams.basis.slice(0, 2000) : '' };
        g.matches = cleanMap(r.matches, isMatchId, (m) => {
          const S = sides.length;
          if (!m || !Number.isInteger(m.a) || !Number.isInteger(m.b) || m.a === m.b || m.a < 0 || m.b < 0 || m.a >= S || m.b >= S || ['a', 'b', 'd'].indexOf(m.w) < 0) return null;
          const sa = cleanScore(m.sa); const sb = cleanScore(m.sb);
          return { a: m.a, b: m.b, sa: sa === undefined ? null : sa, sb: sb === undefined ? null : sb, w: m.w, t: num(m.t, 0), by: mids.has(m.by) ? m.by : null };
        }, LIMITS.matches);
      }
    }
    return g;
  }
  /** A whole group as kept on a phone or sent to go online: the name,
   *  sport, schedule, regulars, lines and the season's games, checked. */
  function cleanGroup(raw, ctx) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const name = cleanText(r.name, LIMITS.groupName);
    if (!name) throw fail(400, 'Give the group a name.');
    const sport = cleanSport(r.sport) || 'other';
    const g = { name, sport, tz: cleanTz(r.tz || ctx.tz), cur: cleanCur(r.cur) || 'USD', members: [], lines: [], games: {}, collector: null };
    g.perSide = cleanPerSide(r.perSide) || SPORT[sport].perSide;
    g.usePos = typeof r.usePos === 'boolean' ? r.usePos : SPORT[sport].usePos;
    g.sched = cleanSched(g, r.sched);
    const seenIds = {};
    for (const m0 of Array.isArray(r.members) ? r.members.slice(0, LIMITS.members) : []) {
      const m = cleanMember(g, m0, ctx.rand);
      if (!m || seenIds[m.id] || nameTaken(g, m.name)) continue;
      seenIds[m.id] = 1;
      g.members.push(m);
    }
    if (!g.members.length) throw fail(400, 'Add yourself - the group needs at least one regular.');
    if (!g.members.some((m) => m.host)) g.members[0].host = true;
    let hostSeen = false;
    for (const m of g.members) { if (m.host && hostSeen) m.host = false; if (m.host) hostSeen = true; }
    g.lines = cleanLines(g, r.lines);
    g.collector = memberOf(g, r.collector) ? r.collector : null;
    const keys = Object.keys(r.games && typeof r.games === 'object' ? r.games : {}).filter(isGameId).sort().slice(-LIMITS.keepGames);
    for (const k of keys) { const gm = cleanGame(g, r.games[k], k); if (gm) g.games[k] = gm; }
    return g;
  }

  /** A regular's own settings, or anyone's for the host. Skill is yours to
   *  say about yourself; `adj` is the host's quiet correction and only the
   *  host sees it. */
  function editMember(group, mid, b, actor) {
    const m = memberOf(group, mid);
    if (!m) throw fail(404, 'No such regular.');
    if (mid !== actor.mid && !actor.host) throw fail(403, 'You can only change your own settings.');
    if (b.name !== undefined) {
      const n = cleanName(b.name);
      if (!n) throw fail(400, 'Add a name.');
      if (nameTaken(group, n, mid)) throw fail(409, 'Someone here is already called ' + n + '.');
      m.name = n;
    }
    if (b.emoji !== undefined) { if (!cleanEmoji(b.emoji)) throw fail(400, 'Pick one of the emoji.'); m.emoji = b.emoji; }
    if (b.skill !== undefined) {
      if (mid !== actor.mid && !actor.host) throw fail(403, 'Your own number only.');
      if (b.skill !== null && !cleanSkill(b.skill)) throw fail(400, 'A number from 1 to 5.');
      m.skill = b.skill === null ? null : cleanSkill(b.skill);
    }
    if (b.adj !== undefined) {
      if (!actor.host) throw fail(403, 'Only the host adjusts.');
      if (b.adj !== null && !cleanSkill(b.adj)) throw fail(400, 'A number from 1 to 5.');
      m.adj = b.adj === null ? null : cleanSkill(b.adj);
    }
    if (b.pos !== undefined) m.pos = cleanPos(group, b.pos);
    return m;
  }
  /** The host's settings: name, sport, schedule, money. A schedule change
   *  can move this week's game too while nobody has answered it. */
  function editGroup(group, b, actor, now) {
    if (!actor.host) throw fail(403, 'Only the host changes the group.');
    if (b.name !== undefined) { const n = cleanText(b.name, LIMITS.groupName); if (!n) throw fail(400, 'Give the group a name.'); group.name = n; }
    if (b.sport !== undefined) {
      if (!cleanSport(b.sport)) throw fail(400, 'Pick a sport.');
      if (b.sport !== group.sport) { group.sport = b.sport; for (const m of group.members) m.pos = cleanPos(group, m.pos); group.usePos = SPORT[b.sport].usePos; group.perSide = SPORT[b.sport].perSide; }
    }
    if (b.perSide !== undefined) { const p = cleanPerSide(Number(b.perSide)); if (!p) throw fail(400, 'Players a side: 1 to 11.'); group.perSide = p; }
    if (b.usePos !== undefined) group.usePos = Boolean(b.usePos) && sportOf(group).positions.length > 0;
    if (b.cur !== undefined) { if (!cleanCur(b.cur)) throw fail(400, 'Pick a currency.'); group.cur = b.cur; }
    if (b.collector !== undefined) { if (!memberOf(group, b.collector)) throw fail(400, 'Pick who pays the court.'); group.collector = b.collector; }
    if (b.sched !== undefined) {
      const s = Object.assign({}, group.sched, b.sched || {});
      if (b.sched.cost !== undefined && typeof b.sched.cost !== 'number') s.cost = moneyIn(b.sched.cost);
      const next = cleanSched(group, s);
      if (b.sched.time !== undefined && !cleanTime(b.sched.time)) throw fail(400, 'Pick a time.');
      if (b.sched.cap !== undefined && !cleanCap(b.sched.cap)) throw fail(400, 'A cap from ' + LIMITS.capMin + ' to ' + LIMITS.capMax + '.');
      if (b.sched.cost !== undefined && s.cost === null) throw fail(400, 'That cost doesn’t look right.');
      group.sched = next;
      const cur = latest(group);
      if (cur && b.applyToCurrent !== false && !started(group, cur, now)) {
        cur.time = next.time; cur.place = next.place; cur.cap = next.cap; cur.cost = next.cost;
        const answered = Object.keys(cur.rsvps || {}).length + Object.keys(cur.guests || {}).length;
        if (!answered && weekday(cur.date) !== next.wd) {
          const today = localDate(now, group.tz);
          let d = onOrAfter(today, next.wd);
          if (zonedMs(d, next.time, group.tz) <= now) d = addDays(d, 7);
          let nid = gameIdFor(d);
          for (let i = 0; own(group.games, nid) && nid !== cur.id && i < 25; i++) nid = gameIdFor(d) + 'bcdefghijklmnopqrstuvwxyz'[i];
          const moved = Object.assign({}, cur, { id: nid, date: d });
          delete group.games[cur.id];
          group.games[moved.id] = moved;
        }
      }
    }
  }
  /** The host removes someone, or someone leaves: their future answers go;
   *  past games keep what they played (as someone who left). */
  function removeMember(group, mid, actor) {
    const target = memberOf(group, mid);
    if (!target) throw fail(404, 'No such regular.');
    if (mid !== actor.mid && !actor.host) throw fail(403, 'Only the host can remove someone.');
    if (target.host) throw fail(409, 'The host can’t leave - delete the group instead.');
    group.members = group.members.filter((m) => m.id !== mid);
    group.lines = (group.lines || []).filter((l) => l.a !== mid && l.b !== mid);
    if (group.collector === mid) group.collector = null;
    const cur = latest(group);
    if (cur) {
      if (cur.rsvps) delete cur.rsvps[mid];
      for (const x of Object.keys(cur.guests || {})) if (cur.guests[x].by === mid) delete cur.guests[x];
    }
  }

  /** A brand-new group on this phone, from the start sheet. */
  function newGroup(b, ctx) {
    const sport = cleanSport(b.sport) || 'basketball';
    const sp = SPORT[sport];
    const me = cleanName(b.me);
    if (!me) throw fail(400, 'Add your name - it’s how the group sees you.');
    const raw = {
      name: b.name, sport, tz: ctx.tz, cur: b.cur,
      sched: { wd: b.wd, time: b.time, place: b.place, cap: b.cap === undefined ? sp.cap : b.cap, cost: typeof b.cost === 'number' ? b.cost : moneyIn(b.cost) || 0 },
      members: [{ name: me, emoji: b.emoji || EMOJI[0], skill: cleanSkill(b.skill), host: true }],
    };
    const g = cleanGroup(raw, ctx);
    const extra = (Array.isArray(b.regulars) ? b.regulars : String(b.regulars || '').split(/[\n,]+/)).map((s) => cleanName(s)).filter(Boolean);
    const add = addMembers(g, extra, { actor: { host: true }, rand: ctx.rand });
    g.members = g.members.concat(add.members);
    const e = ensureGame(g, ctx.now);
    applyPatch(g, e.patch);
    return g;
  }

  return {
    LIMITS, EMOJI, SKILLS, SPORTS, SPORT, TEAMS, CURRENCIES, ANSWERS, WEEKDAY_NAMES, DAYS, STAY_MAX, VOTE_HOURS, DONE_AFTER_MS,
    clean, cleanText, cleanName, cleanEmoji, cleanSkill, cleanSport, cleanCur, cleanTime, cleanWd, cleanCap, cleanCents, moneyIn, cleanPlace, cleanAnswer, cleanTz,
    isMemberId, isGuestId, isMatchId, isGameId, isDate, newId, gameIdFor, fail, plural, nameList, hash32, fold, copy,
    localDate, zonedMs, addDays, daysBetween, weekday, onOrAfter, dateLabel, shortDate, timeLabel, whenLabel, fmtMoney,
    applyPatch, memberOf, hostOf, sportOf, skillOf, nameOf, guestLabel,
    games, gameOf, kickoff, started, latest, current, needsNext, nextDate, newGame, ensureGame, previousWithTeams,
    lineup, headline, statusOf, logText, rsvp, rsvpMany, addGuest, editGame, wrapUp,
    splitCount, balance, gapText, suggestSides, playersFor, makeTeams, clearTeams, teamsStale, teamSums, rotation,
    matchList, addMatch, removeMatch, playedIds, setPlayed, potw, vote, closeVotes,
    standings, streakText, collectorOf, shares, isPaid, money, markPaid, reminderText,
    shareText, nudgeText, teamsText, gameLine,
    cleanReply, classify, parseChat, matchReplies,
    cleanMember, cleanLines, cleanSched, cleanGame, cleanGroup, addMembers, editMember, editGroup, removeMember, newGroup, pickEmoji, nameTaken,
  };
});
