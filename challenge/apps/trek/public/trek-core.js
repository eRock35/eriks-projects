/* Trek - the rules, in one file, run three times: in the page
 * (window.TrekCore), on the server and in the tests (require).
 *
 * The routes (drawn here, stylised - no map data), the conversion of a
 * walk, run, ride, swim or roll into one "trail distance", days and weeks
 * as calendar dates, the leaderboard that rewards showing up, weekly
 * streaks, the crew's progress and its postcards, text cleaning, ids and
 * codes, what a shared crew shows each phone (crewView), the one door every
 * stored or synced trek goes through (cleanTreks), the two-phone merge and
 * the recap card's words.
 *
 * NO CLOCK AND NO DICE: "now", "today" and every new id are handed in
 * (tested), so the same input gives the same output on every phone and on
 * the server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrekCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = {
    members: 20,        // people in one crew, or on one phone's trek
    name: 20,           // a first name
    title: 40,          // a crew's or trek's name
    treks: 100,         // treks one phone (or one account) keeps
    logs: 3000,         // logs in one leg of a crew's journey, or one trek on a phone
    logsPerDay: 20,     // logs one person may add for one day
    past: 20,           // finished legs a crew remembers
    idleDays: 30,       // a crew nobody logged in, joined or changed for 30 days is gone
    backDays: 6,        // a log may be for today or up to six days back
    feed: 60,           // the newest logs a phone sees in the crew's feed
    storedBytes: 600 * 1024, // an account's treks, as stored
  };

  function fail(status, message, extra) {
    var e = new Error(message);
    e.status = status; e.expose = true;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    return e;
  }

  /* ------------------------------------------------------------------ *
   * The routes
   *
   * Real, well-known long-distance trails and lines, by their public names
   * and rounded published lengths - facts, not map data. Each is DRAWN
   * here as a stylised line in a 1000 x 560 box (its general direction and
   * a few bends, nothing traced), so there is nothing to license. The
   * checkpoints' names and postcards are invented and generic: they say
   * what a stretch of trail feels like, never a business or a person.
   * ------------------------------------------------------------------ */

  var CHECKS = [0.1, 0.25, 0.4, 0.5, 0.65, 0.8, 0.9, 1];
  function route(id, name, km, from, to, blurb, pts, peaks, sea, names, cards) {
    return {
      id: id, name: name, km: km, m: km * 1000, from: from, to: to, blurb: blurb, pts: pts, peaks: peaks || [], sea: sea || '',
      checkpoints: CHECKS.map(function (f, i) { return { i: i, f: f, at: Math.round(km * 1000 * f), name: names[i], card: cards[i] }; }),
    };
  }
  var ROUTES = [
    route('hadrian', 'Hadrian’s Wall Path', 135, 'Wallsend', 'Bowness-on-Solway', 'A week-long office challenge: coast to coast across the north of England, along an old Roman wall.',
      [[900, 300], [820, 270], [740, 290], [660, 250], [570, 270], [480, 240], [390, 270], [300, 250], [210, 280], [100, 260]], [[620, 210], [520, 200], [440, 215]], 'both',
      ['Out of the city', 'First stretch of wall', 'The crags', 'Halfway', 'The old fort', 'Down to the plain', 'Salt in the air', 'The far shore'],
      ['The streets thin out and the path finds the river. Somebody already wants a snack.', 'Stones older than anything you own, laid in a line over the hills. Hands on them for luck.', 'The wall climbs the crags like a dragon’s back. Every gap is a breather.', 'Halfway across a whole country, on foot. The crew photo is mostly wind.', 'Ruined barracks and a view in every direction. Imagine standing guard here in winter.', 'The land flattens and softens. Fields, gates, and a lot of sheep with opinions.', 'Marsh grass and big skies - the sea is close now.', 'Coast to coast. Boots off, feet in the water, done.']),
    route('c2c', 'Coast to Coast (England)', 309, 'St Bees', 'Robin Hood’s Bay', 'Sea to sea across the north of England: lakes, dales and moors in one long line.',
      [[90, 280], [170, 250], [250, 300], [330, 260], [420, 280], [520, 240], [600, 300], [690, 320], [780, 290], [860, 320], [910, 300]], [[200, 230], [280, 250], [340, 215]], 'both',
      ['Cliff path', 'Into the lakes', 'The high fells', 'Halfway', 'Down the dale', 'Across the plain', 'The moor', 'The other sea'],
      ['A pebble from the first beach goes in a pocket - tradition says it rides all the way.', 'Water in every valley and fells above it. The first big climb is behind you.', 'Wind, cloud and a long ridge. Somebody swears it was flat on the map.', 'Halfway between the seas. Stone walls criss-cross every hill.', 'A river, a village, a bench in the sun. The legs are getting used to this.', 'Flat miles through farmland - the quickest stretch, and the dullest. Talk helps.', 'Heather to the horizon. Purple in summer, brown and wild in winter.', 'The pebble goes into the other sea. Coast to coast - well walked.']),
    route('camino', 'Camino Francés', 780, 'Saint-Jean-Pied-de-Port', 'Santiago de Compostela', 'The old pilgrims’ way across the north of Spain, over the mountains and through the long plains.',
      [[900, 170], [820, 205], [740, 190], [660, 225], [560, 210], [470, 235], [380, 200], [290, 215], [200, 175], [120, 155], [90, 140]], [[870, 140], [210, 140], [250, 150]], '',
      ['Over the pass', 'Vineyards', 'Old bridges', 'Halfway', 'The long plateau', 'Into the hills', 'Green valleys', 'The cathedral square'],
      ['The first day is the hardest climb of the whole way. It is all downhill from here, sort of.', 'Rows of vines and red earth. A shell on a post points the way.', 'Stone bridges over slow rivers, and villages that grew up around walkers.', 'Halfway to the sea. People you passed a week ago wave from a café table.', 'Wheat fields and a sky that never ends. Hats on - there is no shade.', 'The path climbs again into cooler, greener hills. Fog in the mornings.', 'Moss, chestnut trees and rain that nobody minds any more.', 'Packs down in the square. Every crew that ever made it sat right here.']),
    route('at', 'Appalachian Trail', 3520, 'Springer Mountain, Georgia', 'Katahdin, Maine', 'The long one: ridge after ridge up the eastern mountains of the United States.',
      [[170, 500], [240, 455], [300, 430], [350, 380], [420, 350], [470, 300], [540, 270], [600, 230], [650, 215], [700, 170], [760, 140], [820, 110], [860, 70]], [[260, 420], [330, 360], [720, 140], [850, 50]], '',
      ['Off the first summit', 'The smoky ridges', 'Long green tunnel', 'Halfway', 'Rocky miles', 'The notches', 'The big woods', 'The last summit'],
      ['A plaque, a first white blaze, and two thousand miles of trail ahead. One step.', 'Blue haze on every ridge line. The shelters are full of stories.', 'Trees close over the path for days at a time. You learn every kind of birdsong.', 'Halfway. Tradition says eat a whole tub of ice cream here. Tradition is optional.', 'Rocks, rocks and more rocks. Boots earn their keep this stretch.', 'Steep cuts between the peaks - hands and feet both.', 'Lakes, moose country and long quiet miles. Almost there.', 'The sign on the last summit. Whole crew in the photo, arms up.']),
    route('pct', 'Pacific Crest Trail', 4265, 'the Mexican border', 'the Canadian border', 'Border to border along the mountains of the American West: desert, high peaks, volcanoes, forest.',
      [[330, 530], [300, 470], [250, 420], [230, 360], [260, 300], [240, 240], [290, 190], [310, 130], [340, 80], [360, 40]], [[230, 340], [210, 300], [280, 220], [330, 110]], '',
      ['The desert', 'Water caches', 'The high sierra', 'Halfway', 'Lava country', 'The volcanoes', 'Rain forest', 'The northern border'],
      ['Sand, cactus and early starts to beat the heat. The first hundred miles are about water.', 'Strangers leave jugs of water by the trail. Say thank you to the empty air.', 'Granite, snowmelt lakes and the highest passes of the whole way.', 'Halfway. A simple marker in the trees - and a long way still to go.', 'Black rock underfoot and a mountain on the skyline that used to be a volcano.', 'One snowy cone after another along the horizon. Every one a landmark.', 'Huge trees, ferns, and the kind of rain that just lives here.', 'A little monument at the border. The crew walked the length of a country.']),
    route('usa', 'Across America', 4700, 'New York', 'San Francisco', 'Coast to coast across the United States, east to west, as a crow-flies-ish line.',
      [[920, 190], [820, 210], [720, 230], [620, 220], [520, 250], [430, 240], [340, 280], [260, 250], [180, 280], [120, 270], [80, 260]], [[300, 230], [250, 220], [200, 245]], 'both',
      ['Leaving the coast', 'Old hills', 'The big river', 'Halfway', 'The plains', 'The Rockies', 'Desert and salt', 'The Pacific'],
      ['Skyline behind you, the whole continent ahead. Every journey starts on a sidewalk.', 'Rolling green hills and small towns with one diner each.', 'A river so wide it takes a while to cross the bridge. The middle of the map.', 'Halfway across the country. Corn to the horizon in every direction.', 'Wind, grass and grain towers. The sky gets bigger every day.', 'The mountains appear as a line on the horizon, then all at once.', 'Salt flats, red rock and nights full of stars.', 'Fog over the bay and the ocean at last. Coast to coast.']),
  ];
  var RBY = {};
  ROUTES.forEach(function (r) { RBY[r.id] = r; });
  function isRoute(id) { return typeof id === 'string' && Object.prototype.hasOwnProperty.call(RBY, id); }
  function routeOf(id) { return isRoute(id) ? RBY[id] : null; }

  /** The point a fraction of the way along a route's drawn line, by length. */
  function pointAt(r, frac) {
    var pts = r.pts, segs = [], total = 0;
    for (var i = 1; i < pts.length; i++) { var d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push(d); total += d; }
    var want = Math.max(0, Math.min(1, frac)) * total;
    for (var j = 0; j < segs.length; j++) {
      if (want <= segs[j] || j === segs.length - 1) {
        var t = segs[j] ? Math.min(1, want / segs[j]) : 0;
        return [Math.round((pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t) * 10) / 10, Math.round((pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t) * 10) / 10, j];
      }
      want -= segs[j];
    }
    return [pts[0][0], pts[0][1], 0];
  }

  /* ------------------------------------------------------------------ *
   * Trail distance: one fair number for five kinds of moving
   *
   * Effort per kilometre, roughly (energy cost of moving one body one
   * kilometre): walking and running cost about the same per km (running
   * is faster, not costlier per km); cycling about a third of that; swimming
   * about four times. A wheelchair push counts like a walk. So:
   *
   *   kind  | one km logged | one minute logged (an easy pace x the km rule)
   *   walk  | 1 trail km    | 80 m   (4.8 km/h)
   *   roll  | 1 trail km    | 80 m   (4.8 km/h)
   *   run   | 1 trail km    | 160 m  (9.6 km/h)
   *   ride  | 1/3 trail km  | 100 m  (18 km/h, a third)
   *   swim  | 4 trail km    | 120 m  (1.8 km/h, four times)
   *
   * Miles are 1.609344 km. The result is whole metres (rounded), worked
   * out by the server from what was logged - never sent by a phone.
   * ------------------------------------------------------------------ */

  var KINDS = {
    walk: { id: 'walk', label: 'Walk', verb: 'walked', perKm: 1, perMin: 80, maxKm: 100 },
    run: { id: 'run', label: 'Run', verb: 'ran', perKm: 1, perMin: 160, maxKm: 100 },
    ride: { id: 'ride', label: 'Ride', verb: 'rode', perKm: 1 / 3, perMin: 100, maxKm: 300 },
    swim: { id: 'swim', label: 'Swim', verb: 'swam', perKm: 4, perMin: 120, maxKm: 30 },
    roll: { id: 'roll', label: 'Roll', verb: 'rolled', perKm: 1, perMin: 80, maxKm: 100 },
  };
  var KIND_IDS = ['walk', 'run', 'ride', 'swim', 'roll'];
  var UNITS = ['min', 'km', 'mi'];
  var MI = 1609.344;
  var MAX_MIN = 600;
  function isKind(k) { return typeof k === 'string' && KIND_IDS.indexOf(k) >= 0; }
  function isUnit(u) { return typeof u === 'string' && UNITS.indexOf(u) >= 0; }
  /** A typed amount, checked: whole minutes 1 to 600, or km/mi to one
   *  decimal from 0.1 up to the kind's ceiling. NaN when out of range. */
  function cleanAmount(kind, unit, v) {
    if (!isKind(kind) || !isUnit(unit)) return NaN;
    var n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d{1,4}([.,]\d{1,2})?\s*$/.test(v) ? Number(v.trim().replace(',', '.')) : NaN);
    if (!isFinite(n)) return NaN;
    if (unit === 'min') { n = Math.round(n); return n >= 1 && n <= MAX_MIN ? n : NaN; }
    n = Math.round(n * 10) / 10;
    var km = unit === 'mi' ? n * MI / 1000 : n;
    return n >= 0.1 && km <= KINDS[kind].maxKm + 1e-9 ? n : NaN;
  }
  function amountProblem(kind, unit, v) {
    if (!isKind(kind)) return 'Pick walk, run, ride, swim or roll.';
    if (!isUnit(unit)) return 'Minutes, km or miles.';
    if (!isNaN(cleanAmount(kind, unit, v))) return '';
    if (unit === 'min') return 'Minutes from 1 to ' + MAX_MIN + '.';
    var max = unit === 'mi' ? Math.floor(KINDS[kind].maxKm * 1000 / MI) : KINDS[kind].maxKm;
    return 'From 0.1 to ' + max + ' ' + unit + ' for one ' + KINDS[kind].label.toLowerCase() + '.';
  }
  /** Trail metres for one log. Throws a 400 for anything out of range. */
  function toTrail(kind, unit, v) {
    var n = cleanAmount(kind, unit, v);
    if (isNaN(n)) throw fail(400, amountProblem(kind, unit, v) || 'That amount is out of range.');
    var k = KINDS[kind];
    if (unit === 'min') return Math.round(n * k.perMin);
    return Math.round((unit === 'mi' ? n * MI : n * 1000) * k.perKm);
  }

  /* ------------------------------------------------------------------ *
   * Days and weeks: calendar dates, never instants
   *
   * A log belongs to the logger's own day ("2026-11-22", their local date
   * when they logged it, or a day they picked up to six back). Weeks run
   * Monday to Sunday on those dates. So a Sunday-night walk in California
   * is Sunday's walk even though it is Monday in UTC - and the crew's
   * phones, wherever they are, agree on every week.
   * ------------------------------------------------------------------ */

  var DAY_MS = 86400000;
  function isDay(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var n = dayNum(s);
    return isFinite(n) && dayStr(n) === s;
  }
  function dayNum(s) { var p = String(s).split('-'); return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / DAY_MS); }
  function dayStr(n) { return new Date(n * DAY_MS).toISOString().slice(0, 10); }
  function addDays(s, n) { return dayStr(dayNum(s) + n); }
  /** A phone's local date for an instant: `offsetMin` is what the browser's
   *  getTimezoneOffset() says (minutes BEHIND UTC, so UTC-8 is 480). */
  function localDay(ms, offsetMin) { return dayStr(Math.floor((ms - (Number(offsetMin) || 0) * 60000) / DAY_MS)); }
  /** Monday of the week a day is in. 1970-01-01 was a Thursday. */
  function weekOf(s) { var n = dayNum(s); return dayStr(n - (((n + 3) % 7) + 7) % 7); }
  function weekday(s) { return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][(((dayNum(s) + 3) % 7) + 7) % 7]; }
  /** May a log be for this day? Today or up to six days back - checked by
   *  the server against its own UTC date with a day's slack either side,
   *  so every time zone (UTC-12 to UTC+14) fits. */
  function dayAllowed(day, utcToday) {
    if (!isDay(day) || !isDay(utcToday)) return false;
    var d = dayNum(day) - dayNum(utcToday);
    return d <= 1 && d >= -(LIMITS.backDays + 2);
  }

  /* ------------------------------------------------------------------ *
   * Scoring: showing up counts as much as distance
   *
   *   - Each person's trail distance counts up to 25 km a DAY (a long day
   *     helps, but cannot carry the crew alone - and a joke log of 999 km
   *     cannot either). The crew moves by the same capped distance.
   *   - Points: 10 for every day you were out at all, 1 per capped trail
   *     km, and 15 for every week (Monday to Sunday) with 3 or more days
   *     out. A 2 km walk every day of a week scores 70 + 14 + 15 = 99; one
   *     25 km day that week scores 10 + 25 = 35.
   *   - Your weekly streak: weeks in a row with 3+ days out. This week only
   *     counts once it is made, and does not break the streak while it can
   *     still be made.
   *   - The crew streak: weeks in a row when EVERYONE in the crew got out
   *     at least once (people count from the week they joined; someone who
   *     left no longer counts).
   * ------------------------------------------------------------------ */

  var CAP_M = 25000;
  var GOAL_DAYS = 3;
  var POINTS = { day: 10, km: 1, week: 15 };

  /** One person's days ({day: metres}) worked into their numbers. */
  function personStats(dayMap, today) {
    var days = Object.keys(dayMap || {}).filter(function (d) { return isDay(d) && dayMap[d] > 0; }).sort();
    var capped = 0, weeks = {};
    days.forEach(function (d) { capped += Math.min(dayMap[d], CAP_M); var w = weekOf(d); weeks[w] = (weeks[w] || 0) + 1; });
    var goal = Object.keys(weeks).filter(function (w) { return weeks[w] >= GOAL_DAYS; }).sort();
    var cur = isDay(today) ? weekOf(today) : (goal[goal.length - 1] || '1970-01-05');
    var w = weeks[cur] >= GOAL_DAYS ? cur : addDays(cur, -7), streak = 0;
    while (weeks[w] >= GOAL_DAYS) { streak++; w = addDays(w, -7); }
    var best = 0, run = 0, prev = null;
    goal.forEach(function (g) { run = prev && addDays(prev, 7) === g ? run + 1 : 1; prev = g; if (run > best) best = run; });
    return {
      active: days.length, m: capped, goalWeeks: goal.length, streak: streak, best: best, thisWeek: weeks[cur] || 0,
      pts: POINTS.day * days.length + POINTS.km * Math.floor(capped / 1000) + POINTS.week * goal.length,
      last: days[days.length - 1] || '',
    };
  }
  /** The leaderboard. players: [{name, c, left?}]; days: [{day: m}] by
   *  player index. Ranked by points, then days out, then distance; equal
   *  points share a place. */
  function standings(players, days, today) {
    var rows = (players || []).map(function (pl, i) {
      var s = personStats((days || [])[i], today);
      s.p = i; s.name = pl.name; s.c = pl.c; s.left = Boolean(pl.left);
      return s;
    });
    rows.sort(function (a, b) { return b.pts - a.pts || b.active - a.active || b.m - a.m || a.p - b.p; });
    var rank = 0, prev = null;
    rows.forEach(function (r, i) { if (prev === null || r.pts !== prev) { rank = i + 1; prev = r.pts; } r.rank = rank; });
    return rows;
  }
  /** Weeks in a row with everyone out at least once. */
  function crewStreak(players, days, today) {
    if (!isDay(today)) return 0;
    function met(w) {
      var end = addDays(w, 6), who = (players || []).map(function (pl, i) { return { pl: pl, i: i }; }).filter(function (x) { return !x.pl.left && isDay(x.pl.since) && x.pl.since <= end; });
      if (!who.length) return false;
      return who.every(function (x) { var dm = (days || [])[x.i] || {}; for (var k = 0; k < 7; k++) { if (dm[addDays(w, k)] > 0) return true; } return false; });
    }
    var cur = weekOf(today), w = met(cur) ? cur : addDays(cur, -7), n = 0;
    while (n < 520 && met(w)) { n++; w = addDays(w, -7); }
    return n;
  }
  /** How far the crew has come: every person's capped days added up. */
  function progress(routeId, days) {
    var r = routeOf(routeId) || ROUTES[0], m = 0;
    (days || []).forEach(function (dm) { Object.keys(dm || {}).forEach(function (d) { if (isDay(d) && dm[d] > 0) m += Math.min(dm[d], CAP_M); }); });
    var reached = r.checkpoints.filter(function (c) { return m >= c.at; });
    var next = r.checkpoints.filter(function (c) { return m < c.at; })[0] || null;
    return { m: m, of: r.m, frac: Math.min(1, m / r.m), done: m >= r.m, reached: reached.map(function (c) { return c.i; }), next: next ? { i: next.i, name: next.name, toGo: next.at - m } : null };
  }
  /** The checkpoints passed between two totals - the postcards to show. */
  function crossed(routeId, before, after) {
    var r = routeOf(routeId);
    if (!r) return [];
    return r.checkpoints.filter(function (c) { return before < c.at && after >= c.at; }).map(function (c) { return c.i; });
  }
  /** Each person's metres by day, from logs {lid: {p, day, m}}. */
  function dayTotals(logs, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push({});
    Object.keys(logs || {}).forEach(function (k) {
      var l = logs[k];
      if (!l || !out[l.p] || !isDay(l.day) || !(l.m > 0)) return;
      out[l.p][l.day] = (out[l.p][l.day] || 0) + l.m;
    });
    return out;
  }
  function headline(rows, ended) {
    if (!rows.some(function (r) { return r.active > 0; })) return ended ? 'Nobody logged a step this time.' : 'No steps yet - log the first walk.';
    var top = rows.filter(function (r) { return r.rank === 1; }), pts = plural(top[0].pts, 'point');
    if (rows.length === 1) return top[0].name + ' has ' + pts + '.';
    if (top.length > 1) return listNames(top.map(function (r) { return r.name; })) + (ended ? ' share the top on ' : ' are level on ') + pts + '.';
    return top[0].name + (ended ? ' finished top with ' : ' leads with ') + pts + '.';
  }

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
  function norm(v) { return line(v, 80).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function cleanName(v) {
    var s = line(v, LIMITS.name * 2).replace(/[^\p{L}\p{M}' ’.-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[ '.’-]+|[ '.’-]+$/g, '').trim();
    s = Array.from(s).slice(0, LIMITS.name).join('').trim();
    return /\p{L}/u.test(s) ? s : '';
  }
  function refuse(v) {
    var s = str(v);
    if (/[@＠﹫]/.test(s)) return 'No email addresses - first names and crew names only.';
    if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(s)) return 'No links - first names and crew names only.';
    if (/\p{Nd}(?:[\s.\-()]*\p{Nd}){6}/u.test(s)) return 'No phone numbers or long numbers - first names and crew names only.';
    if (/[<>]/.test(s)) return 'No markup, please.';
    return '';
  }
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
  /** A distance for people: "12.4 km", "7.7 mi", "780 km"; whole numbers from 1,000. */
  function dist(m, unit) {
    var v = unit === 'mi' ? m / MI : m / 1000;
    var s = v >= 1000 ? String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return s + (unit === 'mi' ? ' mi' : ' km');
  }
  function amountText(unit, amt) { return unit === 'min' ? amt + ' min' : amt + ' ' + unit; }
  /** "Priya walked 30 min" */
  function logText(name, l) { return name + ' ' + (KINDS[l.kind] ? KINDS[l.kind].verb : 'moved') + ' ' + amountText(l.unit, l.amt); }

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

  // Twelve colours, each holding white text at 4.5:1 or better (tested);
  // a crew of more than twelve repeats them, and initials tell people apart.
  var COLORS = ['#1b6e2a', '#1f5fbf', '#a3122f', '#7a2e8f', '#805400', '#0f6470', '#b5420e', '#4a4f9e', '#4f6014', '#9c2d6b', '#3f5563', '#6b4a2a'];

  /* ------------------------------------------------------------------ *
   * A shared crew, as one phone sees it
   *
   * crews/<id>: {code, title, route, v, members: {<mid>: {name, c,
   * keyHash, joinedAt, since, at, host?, left?}}, logs: {<lid>: {by, day,
   * kind, unit, amt, m, at}}, started, finished, past: [{route, m,
   * started, finished}], createdAt, updatedAt}
   * ------------------------------------------------------------------ */

  function memberIds(doc) {
    var m = (doc && doc.members) || {};
    return Object.keys(m).sort(function (a, b) { return String(m[a].joinedAt).localeCompare(String(m[b].joinedAt)) || (a < b ? -1 : 1); });
  }
  /** What a member's phone gets: names, colours, each person's metres by
   *  day, the newest logs and the finished legs - never a key hash. */
  function crewView(doc, mid) {
    var ids = memberIds(doc), m = doc.members || {}, logs = doc.logs || {};
    var plogs = {};
    Object.keys(logs).forEach(function (k) { var l = logs[k], p = ids.indexOf(l.by); if (p >= 0) plogs[k] = { p: p, day: l.day, m: l.m }; });
    var feed = Object.keys(logs).filter(function (k) { return ids.indexOf(logs[k].by) >= 0; })
      .sort(function (a, b) { return String(logs[b].at).localeCompare(String(logs[a].at)) || (a < b ? 1 : -1); }).slice(0, LIMITS.feed)
      .map(function (k) { var l = logs[k]; return { id: k, p: ids.indexOf(l.by), day: l.day, kind: l.kind, unit: l.unit, amt: l.amt, m: l.m, at: Date.parse(l.at) || 0 }; });
    return {
      id: doc.id, code: doc.code, title: doc.title, route: doc.route, v: doc.v || 0,
      you: ids.indexOf(mid), host: Boolean(m[mid] && m[mid].host),
      players: ids.map(function (id, i) { return { id: id, name: m[id].name, c: m[id].c, since: m[id].since, host: Boolean(m[id].host), left: Boolean(m[id].left), you: id === mid, p: i }; }),
      days: dayTotals(plogs, ids.length), feed: feed, logs: Object.keys(logs).length,
      started: doc.started || '', finished: doc.finished || '',
      past: (doc.past || []).map(function (x) { return { route: x.route, m: x.m, started: x.started, finished: x.finished }; }),
    };
  }

  /* ------------------------------------------------------------------ *
   * A trek on this phone
   *
   * {title, mode: solo|crew, route, players: [{name, c, since}],
   *  logs: {lid: {p, day, kind, unit, amt, t}}  (solo: what was logged;
   *        the trail metres are worked out again on every read),
   *  days: [{day: metres}]  (crew: the copy the crew last showed),
   *  leg (crew: which leg of its journey), started, ended (0 while going),
   *  t (last change), del (removed - a tombstone the other phone learns)}
   * ------------------------------------------------------------------ */

  function newTrek(o, now, today) {
    var names = [];
    (o.players || []).forEach(function (n) { var c = cleanName(n); if (c && names.length < LIMITS.members && !names.some(function (x) { return norm(x) === norm(c); })) names.push(c); });
    if (!names.length) names.push('Me');
    return {
      title: cleanTitle(o.title) || 'My trek', mode: 'solo', route: isRoute(o.route) ? o.route : ROUTES[0].id,
      players: names.map(function (n, i) { return { name: n, c: i % COLORS.length, since: today }; }),
      logs: {}, days: [], leg: 0, started: now, ended: 0, t: now, del: false,
    };
  }
  /** Log on this phone. Returns {trek, crossed: [checkpoint indexes]}. */
  function addLog(trek, lid, o, now, today) {
    if (trek.mode !== 'solo') throw fail(400, 'Log a crew’s walks with the crew.');
    if (trek.ended) throw fail(409, 'This trek is over.', { code: 'ended' });
    if (!trek.players[o.p]) throw fail(400, 'Who was it?');
    if (!isId(lid) || own(trek.logs, lid)) throw fail(400, 'Try again.');
    if (!isDay(o.day) || dayNum(o.day) > dayNum(today) || dayNum(o.day) < dayNum(today) - LIMITS.backDays) throw fail(400, 'Log today or up to ' + LIMITS.backDays + ' days back.');
    var m = toTrail(o.kind, o.unit, o.amt);
    if (Object.keys(trek.logs).length >= LIMITS.logs) throw fail(409, 'That is ' + LIMITS.logs + ' logs - the most one trek holds. Start a new one.');
    var same = Object.keys(trek.logs).filter(function (k) { return trek.logs[k].p === o.p && trek.logs[k].day === o.day; }).length;
    if (same >= LIMITS.logsPerDay) throw fail(409, LIMITS.logsPerDay + ' logs in one day is the most.');
    var before = progress(trek.route, trekDays(trek)).m;
    var x = clone(trek);
    x.logs[lid] = { p: o.p, day: o.day, kind: o.kind, unit: o.unit, amt: cleanAmount(o.kind, o.unit, o.amt), t: now };
    x.t = now;
    return { trek: x, m: m, crossed: crossed(x.route, before, before + Math.max(0, progress(x.route, trekDays(x)).m - before)) };
  }
  function removeLog(trek, lid, now) { if (!own(trek.logs, lid)) return trek; var x = clone(trek); delete x.logs[lid]; x.t = now; return x; }
  function endTrek(trek, now) { var x = clone(trek); x.ended = now; x.t = now; return x; }
  function renameTrek(trek, title, now) { var t = cleanTitle(title); if (!t) throw fail(400, refuse(title) || 'Give it a name.'); var x = clone(trek); x.title = t; x.t = now; return x; }
  function addPerson(trek, name, now, today) {
    var n = cleanName(name);
    if (!n) throw fail(400, 'Type a first name.');
    if (trek.players.length >= LIMITS.members) throw fail(400, 'That is ' + LIMITS.members + ' people - the most one trek holds.');
    if (trek.players.some(function (pl) { return norm(pl.name) === norm(n); })) throw fail(400, n + ' is already in.');
    var x = clone(trek);
    x.players.push({ name: n, c: x.players.length % COLORS.length, since: today });
    x.t = now;
    return x;
  }
  /** Each person's metres by day, worked out from what was logged (solo) or
   *  as the crew last showed them (crew). */
  function trekDays(trek) {
    if (trek.mode === 'crew') return trek.players.map(function (_, i) { return clone((trek.days || [])[i] || {}); });
    var plogs = {};
    Object.keys(trek.logs || {}).forEach(function (k) {
      var l = trek.logs[k], m = 0;
      try { m = toTrail(l.kind, l.unit, l.amt); } catch (e) { m = 0; }
      plogs[k] = { p: l.p, day: l.day, m: m };
    });
    return dayTotals(plogs, trek.players.length);
  }
  function summary(trek, today) {
    var days = trekDays(trek), rows = standings(trek.players, days, today);
    return { progress: progress(trek.route, days), rows: rows, headline: headline(rows, Boolean(trek.ended)), crew: crewStreak(trek.players, days, today), days: days };
  }
  /** A crew's view as a trek for this phone's history. */
  function trekFromCrew(view, prev, now) {
    return {
      title: cleanTitle(view.title) || 'Our crew', mode: 'crew', route: isRoute(view.route) ? view.route : ROUTES[0].id,
      players: view.players.map(function (pl) { return { name: cleanName(pl.name) || 'Walker', c: pl.c, since: isDay(pl.since) ? pl.since : '1970-01-01' }; }),
      logs: {}, days: view.days.map(function (dm) { var o = {}; Object.keys(dm).forEach(function (d) { if (isDay(d) && Number.isInteger(dm[d]) && dm[d] > 0) o[d] = dm[d]; }); return o; }),
      leg: (view.past || []).length, started: prev ? prev.started : now, ended: 0, t: now, del: false,
    };
  }

  /* ------------------------------------------------------------------ *
   * The one door: every trek read back from this phone or the account
   * goes through cleanTreks. strict (the server) refuses anything out of
   * shape, whole; lenient (this phone's own copy) mends and drops.
   * ------------------------------------------------------------------ */

  var TREK_KEYS = ['title', 'mode', 'route', 'players', 'logs', 'days', 'leg', 'started', 'ended', 't', 'del'];
  function bodyProblem(raw) {
    var found = '';
    (function walk(v, depth) {
      if (found || depth > 8) return;
      if (typeof v === 'string') { if (!isDay(v)) found = refuse(v); return; }
      if (Array.isArray(v)) v.forEach(function (x) { walk(x, depth + 1); });
      else if (isObj(v)) Object.keys(v).forEach(function (k) { if (!found && !isDay(k)) found = refuse(k); walk(v[k], depth + 1); });
    }(raw, 0));
    return found || null;
  }
  function cleanTrek(raw, strict) {
    var errs = [];
    function bad(msg) { errs.push(msg); }
    if (!isObj(raw)) return { trek: null, errors: ['A trek is not a record.'] };
    Object.keys(raw).forEach(function (k) { if (TREK_KEYS.indexOf(k) < 0) bad('Unknown field ' + k.slice(0, 20) + '.'); });
    if (raw.del === true) {
      if (!okTime(raw.t)) bad('A removed trek needs its time.');
      return { trek: errs.length && strict ? null : { del: true, t: okTime(raw.t) ? raw.t : 0 }, errors: errs };
    }
    var title = cleanTitle(raw.title);
    if (!title || title !== raw.title) bad('A name must be a plain line of 1 to 40 characters.');
    if (['solo', 'crew'].indexOf(raw.mode) < 0) bad('Unknown trek kind.');
    if (!isRoute(raw.route)) bad('Unknown route.');
    var players = [];
    if (!Array.isArray(raw.players) || !raw.players.length || raw.players.length > LIMITS.members) bad('A trek has 1 to ' + LIMITS.members + ' people.');
    (Array.isArray(raw.players) ? raw.players.slice(0, LIMITS.members) : []).forEach(function (pl) {
      var n = isObj(pl) ? cleanName(pl.name) : '';
      if (!isObj(pl) || !n || n !== pl.name || Object.keys(pl).some(function (k) { return ['name', 'c', 'since'].indexOf(k) < 0; }) || !(Number.isInteger(pl.c) && pl.c >= 0 && pl.c < COLORS.length) || !isDay(pl.since)) {
        bad('A person needs a first name, a colour and a start day.');
        if (n) players.push({ name: n, c: players.length % COLORS.length, since: isObj(pl) && isDay(pl.since) ? pl.since : '1970-01-01' });
        return;
      }
      players.push({ name: n, c: pl.c, since: pl.since });
    });
    if (!players.length) players.push({ name: 'Me', c: 0, since: '1970-01-01' });
    var logs = {}, days = [];
    if (!isObj(raw.logs)) bad('A trek’s logs must be a record.');
    var lk = Object.keys(isObj(raw.logs) ? raw.logs : {});
    if (lk.length > LIMITS.logs) bad('Too many logs.');
    if (raw.mode === 'crew' && lk.length) bad('A crew’s logs stay with the crew.');
    lk.slice(0, LIMITS.logs).forEach(function (k) {
      var l = raw.logs[k];
      if (!isId(k) || !isObj(l) || Object.keys(l).some(function (x) { return ['p', 'day', 'kind', 'unit', 'amt', 't'].indexOf(x) < 0; }) || !Number.isInteger(l.p) || !players[l.p] || !isDay(l.day) || !okTime(l.t) || isNaN(cleanAmount(l.kind, l.unit, l.amt)) || cleanAmount(l.kind, l.unit, l.amt) !== l.amt) { bad('A log is out of shape.'); return; }
      if (raw.mode !== 'crew') logs[k] = { p: l.p, day: l.day, kind: l.kind, unit: l.unit, amt: l.amt, t: l.t };
    });
    if (!Array.isArray(raw.days) || raw.days.length > LIMITS.members) bad('A trek’s days are out of shape.');
    if (raw.mode !== 'crew' && Array.isArray(raw.days) && raw.days.length) bad('A trek on one phone keeps its logs, not days.');
    if (raw.mode === 'crew') {
      (Array.isArray(raw.days) ? raw.days : []).slice(0, players.length).forEach(function (dm) {
        var o = {};
        if (!isObj(dm)) { bad('A day list is out of shape.'); days.push(o); return; }
        Object.keys(dm).forEach(function (d) { if (isDay(d) && Number.isInteger(dm[d]) && dm[d] > 0 && dm[d] < 1e7) o[d] = dm[d]; else bad('A day is out of shape.'); });
        days.push(o);
      });
      while (days.length < players.length) days.push({});
    }
    if (!(Number.isInteger(raw.leg) && raw.leg >= 0 && raw.leg <= 1000)) bad('Unknown leg.');
    ['started', 'ended', 't'].forEach(function (k) { if (!okTime(raw[k])) bad('A trek’s ' + k + ' time is out of shape.'); });
    if (raw.del !== undefined && raw.del !== false) bad('Unknown removal flag.');
    var trek = {
      title: title || 'My trek', mode: raw.mode === 'crew' ? 'crew' : 'solo', route: isRoute(raw.route) ? raw.route : ROUTES[0].id,
      players: players, logs: logs, days: raw.mode === 'crew' ? days : [], leg: Number.isInteger(raw.leg) && raw.leg >= 0 && raw.leg <= 1000 ? raw.leg : 0,
      started: okTime(raw.started) ? raw.started : 0, ended: okTime(raw.ended) ? raw.ended : 0, t: okTime(raw.t) ? raw.t : 0, del: false,
    };
    return { trek: strict && errs.length ? null : trek, errors: errs };
  }
  function cleanTreks(raw, strict) {
    var out = {}, errs = [];
    if (!isObj(raw)) return { treks: {}, errors: ['Treks must be a record.'] };
    var ids = Object.keys(raw);
    if (ids.length > LIMITS.treks) errs.push('That is more than ' + LIMITS.treks + ' treks.');
    ids.slice(0, LIMITS.treks).forEach(function (id) {
      if (!isId(id)) { errs.push('A trek id is out of shape.'); return; }
      var r = cleanTrek(raw[id], strict);
      r.errors.forEach(function (e) { errs.push(e); });
      if (r.trek) out[id] = r.trek;
    });
    return { treks: strict && errs.length ? {} : out, errors: errs };
  }
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function same(a, b) { return canon(a) === canon(b); }
  /** Two phones: each trek by its own time (a removal is a change); a tie
   *  goes to the larger copy by its canonical text, the same from either side. */
  function mergeTreks(local, remote) {
    var out = {}, pulled = 0;
    Object.keys(local || {}).concat(Object.keys(remote || {})).forEach(function (id) {
      if (own(out, id)) return;
      var a = own(local, id) ? local[id] : null, b = own(remote, id) ? remote[id] : null;
      var pick = !a ? b : !b ? a : (b.t > a.t ? b : a.t > b.t ? a : (canon(b) > canon(a) ? b : a));
      if (pick === b && (!a || !same(a, b))) pulled += 1;
      out[id] = clone(pick);
    });
    return { treks: out, pulled: pulled };
  }
  function live(treks) {
    return Object.keys(treks || {}).filter(function (id) { return treks[id] && !treks[id].del; })
      .map(function (id) { var x = clone(treks[id]); x.id = id; return x; })
      .sort(function (a, b) { return b.started - a.started || (a.id < b.id ? -1 : 1); });
  }
  function trimTreks(treks) {
    var ids = Object.keys(treks);
    if (ids.length <= LIMITS.treks) return treks;
    ids.sort(function (a, b) { var x = treks[a], y = treks[b]; return (x.del ? 0 : 1) - (y.del ? 0 : 1) || (x.t || 0) - (y.t || 0); });
    var out = clone(treks);
    ids.slice(0, ids.length - LIMITS.treks).forEach(function (id) { delete out[id]; });
    return out;
  }
  /** Every route this phone's treks have finished, and the distance in all. */
  function lifetime(treks) {
    var m = 0, done = {}, n = 0;
    live(treks).forEach(function (t) { var p = progress(t.route, trekDays(t)); m += p.m; n += 1; if (p.done) done[t.route] = true; });
    return { m: m, treks: n, done: Object.keys(done) };
  }

  /* ------------------------------------------------------------------ *
   * The recap card's words (the page draws them on a canvas)
   * ------------------------------------------------------------------ */

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dateText(day) { if (!isDay(day)) return ''; var p = day.split('-'); return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0]; }
  function initials(name) { var w = String(name || '?').split(/[\s-]+/).filter(Boolean); return (w.length > 1 ? Array.from(w[0])[0] + Array.from(w[w.length - 1])[0] : Array.from(w[0] || '?').slice(0, 2).join('')).toUpperCase(); }
  function recapData(trek, today, unit) {
    var s = summary(trek, today), r = routeOf(trek.route), pr = s.progress, shown = s.rows.slice(0, 4);
    var days = 0; s.rows.forEach(function (x) { days += x.active; });
    var best = s.rows.slice().sort(function (a, b) { return b.streak - a.streak || a.p - b.p; })[0];
    var moment = pr.done ? 'Finished the whole ' + r.name + '!' : pr.reached.length ? 'Latest postcard: ' + r.checkpoints[pr.reached[pr.reached.length - 1]].name + '.' : '';
    return {
      title: trek.title, date: dateText(today), route: r.name, from: r.from, to: r.to,
      line: dist(pr.m, unit) + ' of ' + dist(pr.of, unit) + ' · ' + Math.floor(pr.frac * 100) + '%',
      sub: plural(days, 'day') + ' out' + (trek.players.length > 1 ? ' · ' + plural(trek.players.length, 'person', 'people') : '') + (s.crew > 0 && trek.players.length > 1 ? ' · crew streak ' + plural(s.crew, 'week') : ''),
      headline: s.headline, frac: pr.frac, reached: pr.reached,
      rows: shown.map(function (x) { return { name: x.name, initials: initials(x.name), c: x.c, pts: x.pts, active: x.active, streak: x.streak, rank: x.rank }; }),
      more: s.rows.length > shown.length ? '+' + (s.rows.length - shown.length) + ' more' : '',
      moment: moment || (best && best.streak > 1 ? best.name + ' is on a ' + plural(best.streak, 'week') + ' streak.' : ''),
    };
  }
  function fitText(text, max, measure) {
    if (measure(text) <= max) return text;
    var cps = Array.from(text);
    while (cps.length && measure(cps.join('') + '…') > max) cps.pop();
    return cps.join('').trim() + '…';
  }

  return {
    LIMITS: LIMITS, ROUTES: ROUTES, CHECKS: CHECKS, KINDS: KINDS, KIND_IDS: KIND_IDS, UNITS: UNITS, MI: MI, MAX_MIN: MAX_MIN, CAP_M: CAP_M, GOAL_DAYS: GOAL_DAYS, POINTS: POINTS, COLORS: COLORS,
    fail: fail, isRoute: isRoute, routeOf: routeOf, pointAt: pointAt,
    isKind: isKind, isUnit: isUnit, cleanAmount: cleanAmount, amountProblem: amountProblem, toTrail: toTrail,
    isDay: isDay, dayNum: dayNum, dayStr: dayStr, addDays: addDays, localDay: localDay, weekOf: weekOf, weekday: weekday, dayAllowed: dayAllowed,
    personStats: personStats, standings: standings, crewStreak: crewStreak, progress: progress, crossed: crossed, dayTotals: dayTotals, headline: headline,
    line: line, esc: esc, norm: norm, cleanName: cleanName, cleanTitle: cleanTitle, refuse: refuse, plural: plural, listNames: listNames, clone: clone, dist: dist, amountText: amountText, logText: logText,
    newId: newId, isId: isId, CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN, normalizeCode: normalizeCode, isCode: isCode, formatCode: formatCode, isGid: isGid,
    memberIds: memberIds, crewView: crewView,
    newTrek: newTrek, addLog: addLog, removeLog: removeLog, endTrek: endTrek, renameTrek: renameTrek, addPerson: addPerson, trekDays: trekDays, summary: summary, trekFromCrew: trekFromCrew,
    bodyProblem: bodyProblem, cleanTrek: cleanTrek, cleanTreks: cleanTreks, canon: canon, same: same, mergeTreks: mergeTreks, live: live, trimTreks: trimTreks, lifetime: lifetime,
    dateText: dateText, initials: initials, recapData: recapData, fitText: fitText,
  };
});
