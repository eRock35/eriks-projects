/* Spotted - the rules, in one file, run three times: in the page
 * (window.SpottedCore), on the server and in the tests (require).
 *
 * The board (the 50 states and DC, each with its rarity tier and its tile
 * on the drawn map), text cleaning, ids and codes, scoring and standings,
 * a trip on this phone (solo or pass-the-phone), what a shared car game
 * shows each phone (gameView), a game turned into a trip for the history,
 * the one door every stored or synced trip goes through (cleanTrips), the
 * two-phone merge, the lifetime map and the recap card's words.
 *
 * NO CLOCK AND NO DICE: "now" and every new id are handed in (tested), so
 * the same input gives the same output on every phone and on the server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpottedCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    players: 12,        // people in one car game, or on one phone's trip
    name: 20,           // a first name
    title: 40,          // a trip's name ("Over the river to Gran's")
    trips: 300,         // trips one phone (or one account) keeps
    idleHours: 24,      // a car game nobody touched for a day is gone
    undoMinutes: 5,     // a spotter may take back their own tap this long
    storedBytes: 600 * 1024, // an account's trips, as stored
  };

  function fail(status, message, extra) {
    var e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }

  /* ------------------------------------------------------------------ *
   * The board
   *
   * RARITY (no data source; a documented rule): how often a plate turns up
   * on an ordinary US road trip follows, roughly, how many cars a state
   * has, which follows how many people live there. So the tiers are cut by
   * population (rounded, public census scale - no live data), with one
   * exception: Alaska and Hawaii are Rare whatever their size, because you
   * cannot drive a car from either onto the mainland's roads.
   *   Everywhere (1 point) - the 14 biggest states, about 7.4 million and up.
   *   Common     (2)       - the next 16, about 3.4 to 7.1 million.
   *   Uncommon   (3)       - the next 11, about 1.3 to 3.2 million.
   *   Rare       (5)       - the 8 smallest (DC among them, all under about
   *                          1.2 million), plus Alaska and Hawaii.
   * A host may pick "Every plate 1 point" instead.
   *
   * THE MAP is a tile map: one square per state, placed near where it sits
   * (the familiar 11 x 8 grid). It is drawn here, not traced from any map
   * data, so there is nothing to license.
   * ------------------------------------------------------------------ */

  var TIERS = [
    null,
    { id: 1, name: 'Everywhere', pts: 1 },
    { id: 2, name: 'Common', pts: 2 },
    { id: 3, name: 'Uncommon', pts: 3 },
    { id: 4, name: 'Rare', pts: 5 },
  ];
  // [code, name, tier, column, row]
  var RAW = [
    ['AK', 'Alaska', 4, 0, 0], ['ME', 'Maine', 3, 10, 0],
    ['VT', 'Vermont', 4, 9, 1], ['NH', 'New Hampshire', 3, 10, 1],
    ['WA', 'Washington', 1, 0, 2], ['ID', 'Idaho', 3, 1, 2], ['MT', 'Montana', 4, 2, 2], ['ND', 'North Dakota', 4, 3, 2], ['MN', 'Minnesota', 2, 4, 2], ['IL', 'Illinois', 1, 5, 2], ['WI', 'Wisconsin', 2, 6, 2], ['MI', 'Michigan', 1, 7, 2], ['NY', 'New York', 1, 8, 2], ['RI', 'Rhode Island', 4, 9, 2], ['MA', 'Massachusetts', 2, 10, 2],
    ['OR', 'Oregon', 2, 0, 3], ['NV', 'Nevada', 3, 1, 3], ['WY', 'Wyoming', 4, 2, 3], ['SD', 'South Dakota', 4, 3, 3], ['IA', 'Iowa', 3, 4, 3], ['IN', 'Indiana', 2, 5, 3], ['OH', 'Ohio', 1, 6, 3], ['PA', 'Pennsylvania', 1, 7, 3], ['NJ', 'New Jersey', 1, 8, 3], ['CT', 'Connecticut', 2, 9, 3],
    ['CA', 'California', 1, 0, 4], ['UT', 'Utah', 2, 1, 4], ['CO', 'Colorado', 2, 2, 4], ['NE', 'Nebraska', 3, 3, 4], ['MO', 'Missouri', 2, 4, 4], ['KY', 'Kentucky', 2, 5, 4], ['WV', 'West Virginia', 3, 6, 4], ['VA', 'Virginia', 1, 7, 4], ['MD', 'Maryland', 2, 8, 4], ['DE', 'Delaware', 4, 9, 4],
    ['AZ', 'Arizona', 1, 1, 5], ['NM', 'New Mexico', 3, 2, 5], ['KS', 'Kansas', 3, 3, 5], ['AR', 'Arkansas', 3, 4, 5], ['TN', 'Tennessee', 2, 5, 5], ['NC', 'North Carolina', 1, 6, 5], ['SC', 'South Carolina', 2, 7, 5], ['DC', 'District of Columbia', 4, 8, 5],
    ['OK', 'Oklahoma', 2, 3, 6], ['LA', 'Louisiana', 2, 4, 6], ['MS', 'Mississippi', 3, 5, 6], ['AL', 'Alabama', 2, 6, 6], ['GA', 'Georgia', 1, 7, 6],
    ['HI', 'Hawaii', 4, 0, 7], ['TX', 'Texas', 1, 3, 7], ['FL', 'Florida', 1, 8, 7],
  ];
  var STATES = RAW.map(function (r) { return { c: r[0], n: r[1], tier: r[2], x: r[3], y: r[4] }; });
  var BY = {};
  STATES.forEach(function (s) { BY[s.c] = s; });
  var CODES = STATES.map(function (s) { return s.c; }).sort();
  var MAP_COLS = 11, MAP_ROWS = 8;
  var SCORINGS = ['rarity', 'flat'];

  function isState(c) { return typeof c === 'string' && Object.prototype.hasOwnProperty.call(BY, c); }
  function stateOf(c) { return isState(c) ? BY[c] : null; }
  function pointsFor(c, scoring) { var s = stateOf(c); if (!s) return 0; return scoring === 'flat' ? 1 : TIERS[s.tier].pts; }
  function tierOf(c) { var s = stateOf(c); return s ? TIERS[s.tier] : null; }

  // Twelve players' colours, each holding white text at 4.5:1 or better
  // (tested), and told apart by name and initial as well as colour.
  var COLORS = ['#b5420e', '#2a5db0', '#1d6b3a', '#7a2e8f', '#a3122f', '#0f6470', '#805400', '#4a4f9e', '#4f6014', '#9c2d6b', '#3f5563', '#6b4a2a'];

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  // Control characters, zero-width and bidirectional marks: nothing a person
  // means to type in a name, and the bidi ones can turn a name into a lie.
  var INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : ''); }
  /** One plain line: markup and invisible characters gone, whitespace
   *  folded, cut on a whole character. */
  function line(v, max) {
    var s = str(v).slice(0, (max || 200) * 8).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    var cps = Array.from(s);
    return cps.length > max ? cps.slice(0, max).join('').trim() : s;
  }
  function esc(v) {
    return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function norm(v) { return line(v, 80).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  /** A first name: letters (any script), spaces, hyphens and apostrophes;
   *  no digits, no markup. Empty when nothing is left. */
  function cleanName(v) {
    var s = line(v, LIMITS.name * 2).replace(/[^\p{L}\p{M}' ’.-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[ '.’-]+|[ '.’-]+$/g, '').trim();
    s = Array.from(s).slice(0, LIMITS.name).join('').trim();
    return /\p{L}/u.test(s) ? s : '';
  }
  /** Why a piece of text may not be kept, or '' - an @ in any width, a
   *  link, seven digits in a row in any script (a phone number), markup. */
  function refuse(v) {
    var s = str(v);
    if (/[@＠﹫]/.test(s)) return 'No email addresses - first names and trip names only.';
    if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(s)) return 'No links - first names and trip names only.';
    if (/\p{Nd}(?:[\s.\-()]*\p{Nd}){6}/u.test(s)) return 'No phone numbers or long numbers - first names and trip names only.';
    if (/[<>]/.test(s)) return 'No markup, please.';
    return '';
  }
  /** A trip's name: a plain line, at most 40 characters; '' if refused. */
  function cleanTitle(v) { if (refuse(v)) return ''; return line(v, LIMITS.title); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function listNames(names) {
    if (names.length <= 1) return names.join('');
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function own(o, k) { return Boolean(o) && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
  function okTime(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 8.64e15; }

  /* ------------------------------------------------------------------ *
   * Ids and codes
   * ------------------------------------------------------------------ */

  var ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
  function newId(rand, n, prefix) {
    var s = prefix || '';
    for (var i = 0; i < (n || 8); i++) s += ID_CHARS[rand(ID_CHARS.length)];
    return s;
  }
  function isId(v) { return typeof v === 'string' && /^[a-z][a-z0-9]{5,24}$/.test(v); }
  // Join codes: no I, O, 0 or 1, so nobody reads one for the other.
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 6;
  function normalizeCode(v) { return str(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
  function isCode(v) { return typeof v === 'string' && v.length === CODE_LEN && v.split('').every(function (c) { return CODE_ALPHABET.indexOf(c) >= 0; }); }
  function formatCode(v) { var c = normalizeCode(v); return c.slice(0, 3) + '-' + c.slice(3); }
  function isGid(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{16}$/.test(v); }

  /* ------------------------------------------------------------------ *
   * Scoring
   *
   * players: [{name, c}]; spots: {XX: {p: index into players, t}}.
   * ------------------------------------------------------------------ */

  function standings(players, spots, scoring) {
    var rows = (players || []).map(function (pl, i) { return { p: i, name: pl.name, c: pl.c, pts: 0, count: 0, rares: 0, left: Boolean(pl.left) }; });
    Object.keys(spots || {}).forEach(function (code) {
      var s = spots[code], r = rows[s && s.p];
      if (!r || !isState(code)) return;
      r.pts += pointsFor(code, scoring); r.count += 1;
      if (BY[code].tier === 4) r.rares += 1;
    });
    rows.sort(function (a, b) { return b.pts - a.pts || b.count - a.count || a.p - b.p; });
    var rank = 0, prev = null;
    rows.forEach(function (r, i) { if (prev === null || r.pts !== prev) { rank = i + 1; prev = r.pts; } r.rank = rank; });
    return rows;
  }
  function totals(spots, scoring) {
    var n = 0, pts = 0;
    Object.keys(spots || {}).forEach(function (c) { if (isState(c)) { n += 1; pts += pointsFor(c, scoring); } });
    return { count: n, pts: pts, of: STATES.length };
  }
  /** Who is ahead, or who won, in plain words. A tie said plainly. */
  function headline(rows, ended) {
    var any = rows.some(function (r) { return r.count > 0; });
    if (!any) return ended ? 'Nobody spotted a plate this time.' : 'No plates yet - eyes out the windows.';
    var top = rows.filter(function (r) { return r.rank === 1; });
    var pts = plural(top[0].pts, 'point');
    if (rows.length === 1) return top[0].name + ' has ' + pts + '.';
    if (top.length > 1) return listNames(top.map(function (r) { return r.name; })) + (ended ? ' tie for the win on ' : ' are tied on ') + pts + '.';
    return top[0].name + (ended ? ' wins with ' : ' leads with ') + pts + '.';
  }
  /** The best moments: the rarest plate and who saw it, the most rare
   *  plates, the most plates. */
  function highlights(trip) {
    var out = [], spots = trip.spots || {}, players = trip.players || [];
    var codes = Object.keys(spots).filter(isState);
    if (!codes.length) return out;
    codes.sort(function (a, b) { return BY[b].tier - BY[a].tier || (spots[a].t || 0) - (spots[b].t || 0) || (a < b ? -1 : 1); });
    var best = codes[0], who = players[spots[best].p];
    if (BY[best].tier >= 3) out.push('Rarest plate: ' + BY[best].n + (who ? ', spotted by ' + who.name : '') + '.');
    var rows = standings(players, spots, trip.scoring);
    var rare = rows.slice().sort(function (a, b) { return b.rares - a.rares || a.p - b.p; })[0];
    if (rare && rare.rares >= 2 && players.length > 1) out.push(rare.name + ' spotted ' + plural(rare.rares, 'rare plate') + '.');
    var most = rows.slice().sort(function (a, b) { return b.count - a.count || a.p - b.p; });
    if (most.length > 1 && most[0].count > most[1].count) out.push(most[0].name + ' spotted the most: ' + plural(most[0].count, 'plate') + '.');
    var t = totals(spots, trip.scoring);
    if (t.count === t.of) out.push('Every plate on the board - all 51!');
    return out;
  }

  /* ------------------------------------------------------------------ *
   * A trip on this phone
   *
   * {title, mode: solo|game, scoring: rarity|flat, players: [{name, c}],
   *  spots: {XX: {p, t}}, started, ended (0 while going), t (last change),
   *  del (removed - kept as a tombstone so the other phone learns it)}
   * ------------------------------------------------------------------ */

  function newTrip(o, now) {
    var names = [];
    (o.players || []).forEach(function (n) { var c = cleanName(n); if (c && names.length < LIMITS.players && !names.some(function (x) { return norm(x) === norm(c); })) names.push(c); });
    if (!names.length) names.push('Me');
    return {
      title: cleanTitle(o.title) || 'Road trip',
      mode: o.mode === 'game' ? 'game' : 'solo',
      scoring: SCORINGS.indexOf(o.scoring) >= 0 ? o.scoring : 'rarity',
      players: names.map(function (n, i) { return { name: n, c: i % COLORS.length }; }),
      spots: {}, started: now, ended: 0, t: now, del: false,
    };
  }
  /** Spot a plate: the first one in wins - a plate already spotted stays
   *  with whoever got it. Returns a new trip. */
  function spot(trip, code, p, now) {
    if (!isState(code)) throw fail(400, 'That is not a plate on the board.');
    if (trip.ended) throw fail(409, 'This trip is over.', { code: 'ended' });
    if (!trip.players[p]) throw fail(400, 'Who spotted it?');
    if (own(trip.spots, code)) { var by = trip.players[trip.spots[code].p]; throw fail(409, (by ? by.name : 'Someone') + ' already spotted ' + BY[code].n + '.', { code: 'taken' }); }
    var x = clone(trip);
    x.spots[code] = { p: p, t: now };
    x.t = now;
    return x;
  }
  function unspot(trip, code, now) {
    if (!own(trip.spots, code)) return trip;
    var x = clone(trip);
    delete x.spots[code];
    x.t = now;
    return x;
  }
  function endTrip(trip, now) { var x = clone(trip); x.ended = now; x.t = now; return x; }
  function renameTrip(trip, title, now) { var t = cleanTitle(title); if (!t) throw fail(400, refuse(title) || 'Give the trip a name.'); var x = clone(trip); x.title = t; x.t = now; return x; }
  function addPlayer(trip, name, now) {
    var n = cleanName(name);
    if (!n) throw fail(400, 'Type a first name.');
    if (trip.players.length >= LIMITS.players) throw fail(400, 'That is ' + LIMITS.players + ' players - the most one trip holds.');
    if (trip.players.some(function (pl) { return norm(pl.name) === norm(n); })) throw fail(400, n + ' is already playing.');
    var x = clone(trip);
    var used = x.players.map(function (pl) { return pl.c; });
    var c = 0; while (used.indexOf(c) >= 0 && c < COLORS.length - 1) c++;
    x.players.push({ name: n, c: c });
    x.t = now;
    return x;
  }
  function summary(trip) {
    var t = totals(trip.spots, trip.scoring), rows = standings(trip.players, trip.spots, trip.scoring);
    return { count: t.count, pts: t.pts, of: t.of, rows: rows, headline: headline(rows, Boolean(trip.ended)) };
  }

  /* ------------------------------------------------------------------ *
   * A shared car game, as one phone sees it
   *
   * games/<id>: {code, title, scoring, v, members: {<mid>: {name, c,
   * keyHash, joinedAt, at, host?, left?}}, spots: {XX: {by: mid, at}},
   * ended (ISO or null), createdAt, updatedAt}
   * ------------------------------------------------------------------ */

  function memberIds(doc) {
    var m = (doc && doc.members) || {};
    return Object.keys(m).sort(function (a, b) { return String(m[a].joinedAt).localeCompare(String(m[b].joinedAt)) || (a < b ? -1 : 1); });
  }
  /** What a member's phone gets: names, colours, spots and the scoreboard -
   *  never a key hash. */
  function gameView(doc, mid) {
    var ids = memberIds(doc), m = doc.members || {};
    var players = ids.map(function (id) { return { name: m[id].name, c: m[id].c, left: Boolean(m[id].left) }; });
    var spots = {};
    Object.keys(doc.spots || {}).forEach(function (code) {
      var s = doc.spots[code], p = ids.indexOf(s.by);
      if (isState(code) && p >= 0) spots[code] = { p: p, t: Date.parse(s.at) || 0 };
    });
    var rows = standings(players, spots, doc.scoring);
    return {
      id: doc.id, code: doc.code, title: doc.title, scoring: doc.scoring, ended: Boolean(doc.ended), v: doc.v || 0,
      you: ids.indexOf(mid), host: Boolean(m[mid] && m[mid].host),
      players: ids.map(function (id, i) { return { id: id, name: m[id].name, c: m[id].c, host: Boolean(m[id].host), left: Boolean(m[id].left), you: id === mid, p: i }; }),
      spots: spots, rows: rows, headline: headline(rows, Boolean(doc.ended)), total: totals(spots, doc.scoring),
    };
  }
  /** A game as a trip for this phone's history (kept up to date while it
   *  runs, so a game that closes after a quiet day is still remembered). */
  function tripFromGame(view, prev, now) {
    return {
      title: cleanTitle(view.title) || 'Car game',
      mode: 'game',
      scoring: SCORINGS.indexOf(view.scoring) >= 0 ? view.scoring : 'rarity',
      players: view.players.map(function (pl) { return { name: cleanName(pl.name) || 'Player', c: pl.c }; }),
      spots: clone(view.spots),
      started: prev ? prev.started : now, ended: view.ended ? ((prev && prev.ended) || now) : 0, t: now, del: false,
    };
  }

  /* ------------------------------------------------------------------ *
   * The one door: every trip read back from this phone, a file or the
   * account goes through cleanTrips. strict (the server) refuses anything
   * out of shape, whole; lenient (this phone's own copy) mends and drops.
   * ------------------------------------------------------------------ */

  var TRIP_KEYS = ['title', 'mode', 'scoring', 'players', 'spots', 'started', 'ended', 't', 'del'];
  /** The first string anywhere in a body that may not be kept, as a reason. */
  function bodyProblem(raw) {
    var found = '';
    (function walk(v, depth) {
      if (found || depth > 8) return;
      if (typeof v === 'string') { found = refuse(v); return; }
      if (Array.isArray(v)) v.forEach(function (x) { walk(x, depth + 1); });
      else if (isObj(v)) Object.keys(v).forEach(function (k) { if (!found) found = refuse(k); walk(v[k], depth + 1); });
    }(raw, 0));
    return found || null;
  }
  function cleanTrip(raw, strict) {
    var errs = [];
    function bad(msg) { errs.push(msg); }
    if (!isObj(raw)) return { trip: null, errors: ['A trip is not a record.'] };
    Object.keys(raw).forEach(function (k) { if (TRIP_KEYS.indexOf(k) < 0) bad('Unknown field ' + k.slice(0, 20) + '.'); });
    if (raw.del === true) {
      if (!okTime(raw.t)) bad('A removed trip needs its time.');
      return { trip: errs.length && strict ? null : { del: true, t: okTime(raw.t) ? raw.t : 0 }, errors: errs };
    }
    var title = cleanTitle(raw.title);
    if (!title || title !== raw.title) bad('A trip name must be a plain line of 1 to 40 characters.');
    if (['solo', 'game'].indexOf(raw.mode) < 0) bad('Unknown trip kind.');
    if (SCORINGS.indexOf(raw.scoring) < 0) bad('Unknown scoring.');
    var players = [];
    if (!Array.isArray(raw.players) || !raw.players.length || raw.players.length > LIMITS.players) bad('A trip has 1 to 12 players.');
    (Array.isArray(raw.players) ? raw.players.slice(0, LIMITS.players) : []).forEach(function (pl) {
      var n = isObj(pl) ? cleanName(pl.name) : '';
      if (!isObj(pl) || !n || n !== pl.name || Object.keys(pl).some(function (k) { return k !== 'name' && k !== 'c'; }) || !(Number.isInteger(pl.c) && pl.c >= 0 && pl.c < COLORS.length)) { bad('A player needs a first name and a colour.'); if (n) players.push({ name: n, c: players.length % COLORS.length }); return; }
      players.push({ name: n, c: pl.c });
    });
    if (!players.length) players.push({ name: 'Me', c: 0 });
    var spots = {};
    if (!isObj(raw.spots)) bad('A trip’s plates must be a record.');
    Object.keys(isObj(raw.spots) ? raw.spots : {}).forEach(function (code) {
      var s = raw.spots[code];
      if (!isState(code) || !isObj(s) || !Number.isInteger(s.p) || !players[s.p] || !okTime(s.t) || Object.keys(s).some(function (k) { return k !== 'p' && k !== 't'; })) { bad('A plate is out of shape.'); return; }
      spots[code] = { p: s.p, t: s.t };
    });
    ['started', 'ended', 't'].forEach(function (k) { if (!okTime(raw[k])) bad('A trip’s ' + k + ' time is out of shape.'); });
    if (raw.del !== undefined && raw.del !== false) bad('Unknown removal flag.');
    var trip = {
      title: title || 'Road trip', mode: raw.mode === 'game' ? 'game' : 'solo', scoring: raw.scoring === 'flat' ? 'flat' : 'rarity',
      players: players, spots: spots, started: okTime(raw.started) ? raw.started : 0, ended: okTime(raw.ended) ? raw.ended : 0, t: okTime(raw.t) ? raw.t : 0, del: false,
    };
    return { trip: strict && errs.length ? null : trip, errors: errs };
  }
  function cleanTrips(raw, strict) {
    var out = {}, errs = [];
    if (!isObj(raw)) return { trips: {}, errors: ['Trips must be a record.'] };
    var ids = Object.keys(raw);
    if (ids.length > LIMITS.trips) errs.push('That is more than ' + LIMITS.trips + ' trips.');
    ids.slice(0, LIMITS.trips).forEach(function (id) {
      if (!isId(id)) { errs.push('A trip id is out of shape.'); return; }
      var r = cleanTrip(raw[id], strict);
      r.errors.forEach(function (e) { errs.push(e); });
      if (r.trip) out[id] = r.trip;
    });
    return { trips: strict && errs.length ? {} : out, errors: errs };
  }
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function same(a, b) { return canon(a) === canon(b); }
  /** Two phones: each trip by its own time (a removal is a change); a tie
   *  goes to the larger copy by its canonical text, so the merge is the same
   *  from either side. */
  function mergeTrips(local, remote) {
    var out = {}, pulled = 0;
    var ids = Object.keys(local || {}).concat(Object.keys(remote || {}));
    ids.forEach(function (id) {
      if (own(out, id)) return;
      var a = own(local, id) ? local[id] : null, b = own(remote, id) ? remote[id] : null;
      var pick = !a ? b : !b ? a : (b.t > a.t ? b : a.t > b.t ? a : (canon(b) > canon(a) ? b : a));
      if (pick === b && (!a || !same(a, b))) pulled += 1;
      out[id] = clone(pick);
    });
    return { trips: out, pulled: pulled };
  }
  function live(trips) {
    return Object.keys(trips || {}).filter(function (id) { return trips[id] && !trips[id].del; })
      .map(function (id) { var x = clone(trips[id]); x.id = id; return x; })
      .sort(function (a, b) { return b.started - a.started || (a.id < b.id ? -1 : 1); });
  }
  /** Every plate this phone has ever seen, on any trip: the lifetime map. */
  function lifetime(trips) {
    var seen = {};
    live(trips).forEach(function (tr) {
      Object.keys(tr.spots).forEach(function (c) { var t = tr.spots[c].t; if (!seen[c] || t < seen[c].t) seen[c] = { t: t, title: tr.title }; });
    });
    var missing = STATES.filter(function (s) { return !seen[s.c]; }).map(function (s) { return s.c; });
    return { seen: seen, count: STATES.length - missing.length, missing: missing, trips: live(trips).length };
  }
  /** Trims the oldest finished trips (and old tombstones) to the limit. */
  function trimTrips(trips) {
    var ids = Object.keys(trips);
    if (ids.length <= LIMITS.trips) return trips;
    ids.sort(function (a, b) { var x = trips[a], y = trips[b]; return (x.del ? 0 : 1) - (y.del ? 0 : 1) || (x.t || 0) - (y.t || 0); });
    var out = clone(trips);
    ids.slice(0, ids.length - LIMITS.trips).forEach(function (id) { delete out[id]; });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The recap card's words (the page draws them on a canvas)
   * ------------------------------------------------------------------ */

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dateText(ms) { var d = new Date(ms); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function initials(name) { var w = String(name || '?').split(/[\s-]+/).filter(Boolean); return (w.length > 1 ? Array.from(w[0])[0] + Array.from(w[w.length - 1])[0] : Array.from(w[0] || '?').slice(0, 2).join('')).toUpperCase(); }
  function recapData(trip, dateMs) {
    var s = summary(trip);
    var shown = s.rows.slice(0, 4);
    return {
      title: trip.title, date: dateText(dateMs || trip.started),
      headline: s.headline,
      line: s.count + ' of ' + s.of + ' plates · ' + plural(s.pts, 'point') + (trip.players.length > 1 ? ' · ' + plural(trip.players.length, 'player') : ''),
      rows: shown.map(function (r) { return { name: r.name, initials: initials(r.name), c: r.c, pts: r.pts, count: r.count, rank: r.rank }; }),
      more: s.rows.length > shown.length ? '+' + (s.rows.length - shown.length) + ' more' : '',
      moment: highlights(trip)[0] || '',
      spots: Object.keys(trip.spots).reduce(function (o, c) { o[c] = trip.players[trip.spots[c].p] ? trip.players[trip.spots[c].p].c : 0; return o; }, {}),
    };
  }
  /** The longest prefix of `text` that `measure` says fits, with an
   *  ellipsis when cut. Pure: the canvas's measureText is handed in. */
  function fitText(text, max, measure) {
    if (measure(text) <= max) return text;
    var cps = Array.from(text);
    while (cps.length && measure(cps.join('') + '…') > max) cps.pop();
    return cps.join('').trim() + '…';
  }

  return {
    LIMITS: LIMITS, TIERS: TIERS, STATES: STATES, CODES: CODES, MAP_COLS: MAP_COLS, MAP_ROWS: MAP_ROWS, COLORS: COLORS, SCORINGS: SCORINGS,
    fail: fail, isState: isState, stateOf: stateOf, pointsFor: pointsFor, tierOf: tierOf,
    line: line, esc: esc, norm: norm, cleanName: cleanName, cleanTitle: cleanTitle, refuse: refuse, plural: plural, listNames: listNames, clone: clone,
    newId: newId, isId: isId, CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN, normalizeCode: normalizeCode, isCode: isCode, formatCode: formatCode, isGid: isGid,
    standings: standings, totals: totals, headline: headline, highlights: highlights,
    newTrip: newTrip, spot: spot, unspot: unspot, endTrip: endTrip, renameTrip: renameTrip, addPlayer: addPlayer, summary: summary,
    memberIds: memberIds, gameView: gameView, tripFromGame: tripFromGame,
    bodyProblem: bodyProblem, cleanTrip: cleanTrip, cleanTrips: cleanTrips, canon: canon, same: same, mergeTrips: mergeTrips, live: live, lifetime: lifetime, trimTrips: trimTrips,
    dateText: dateText, initials: initials, recapData: recapData, fitText: fitText,
  };
});
