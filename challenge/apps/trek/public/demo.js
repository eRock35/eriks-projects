/* Trek - the made-up example. Everything here is invented: the Lunch Loop
 * (Mara, Dev, Priya, Tomas and Ines - five coworkers), their five weeks on
 * the Camino, and an earlier trek. The crew is played on this phone only -
 * the other four "phones" are what is already logged - and is never kept,
 * sent or synced. No clock and no dice: the days and times are constants.
 *
 * The planted story: the crew is 1.9 km short of halfway. Log a 30-minute
 * walk (+2.4 km) and the halfway postcard arrives. Priya, out nearly every
 * day on short walks, leads the board; Tomas, who covered the most ground
 * on long weekend rides, is fourth - showing up beats distance.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./trek-core'));
  else root.TrekDemo = factory(root.TrekCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var TODAY = '2026-11-22';          // a Sunday
  var START = '2026-10-19';          // the Monday five weeks before
  var NOON = 1795348800000;          // 22 Nov 2026, 12:00 UTC
  var DAY = 86400000;
  var NAME = 'The Lunch Loop';
  var ROUTE = 'camino';
  var NOTICE = 'Made up: the Lunch Loop crew and everything they logged are invented. Nothing here is kept or sent.';
  var YOU = 'mmara';
  var CODE = 'LNCH4P';

  // [id, name, colour, since, host]
  var MEMBERS = [['mmara', 'Mara', 0, START, true], ['mdev', 'Dev', 1, START], ['mpriya', 'Priya', 2, START], ['mtomas', 'Tomas', 3, START], ['mines', 'Ines', 4, '2026-11-02']];
  // Who does what, by day number from START (0 = Monday 19 October).
  function schedule() {
    var out = [];
    for (var d = 0; d <= 34; d++) {
      var wd = d % 7;
      if (d !== 9 && d !== 23) out.push(['mpriya', d, 'walk', 'min', 30]);                    // nearly every day, short
      if (wd === 0 || wd === 2 || wd === 4) out.push(['mmara', d, 'run', 'min', 30]);           // Mon, Wed, Fri
      if ((wd === 1 || wd === 3 || wd === 5 || wd === 6) && !(d >= 21 && d <= 24)) out.push(['mdev', d, 'walk', 'min', 45]); // missed a week
      if ((wd === 5 || wd === 6) && d !== 34) out.push(['mtomas', d, 'ride', 'km', 48]);        // long weekend rides
      if (d >= 14 && (wd === 1 || wd === 3)) out.push(['mines', d, 'swim', 'min', 30]);        // joined week 3
    }
    out.push(['mdev', 34, 'walk', 'km', 6.5]);
    return out;
  }

  function crew() {
    var members = {}, logs = {};
    MEMBERS.forEach(function (m, i) {
      members[m[0]] = { name: m[1], c: m[2], since: m[3], joinedAt: new Date(NOON - (35 - i) * DAY).toISOString(), at: new Date(NOON).toISOString() };
      if (m[4]) members[m[0]].host = true;
    });
    schedule().forEach(function (s, i) {
      var day = C.addDays(START, s[1]);
      logs['ldemo' + String(i).padStart(4, '0')] = { by: s[0], day: day, kind: s[2], unit: s[3], amt: s[4], m: C.toTrail(s[2], s[3], s[4]), at: new Date(NOON - (34 - s[1]) * DAY + (i % 50) * 60000 - 4 * 3600000).toISOString() };
    });
    return { id: 'demo000000000000', code: CODE, title: NAME, route: ROUTE, v: 1, members: members, logs: logs, started: START, finished: null, past: [], createdAt: new Date(NOON - 35 * DAY).toISOString(), updatedAt: new Date(NOON).toISOString() };
  }
  /** A log in the example: always yours. Returns {doc, m, crossed}. */
  function log(doc, n, o) {
    var d = C.clone(doc), ids = C.memberIds(d);
    var days = function (x) { var pl = {}; Object.keys(x.logs).forEach(function (k) { pl[k] = { p: ids.indexOf(x.logs[k].by), day: x.logs[k].day, m: x.logs[k].m }; }); return C.dayTotals(pl, ids.length); };
    var before = C.progress(d.route, days(d)).m;
    var m = C.toTrail(o.kind, o.unit, o.amt);
    d.logs['lyou' + String(n).padStart(5, '0')] = { by: YOU, day: o.day, kind: o.kind, unit: o.unit, amt: C.cleanAmount(o.kind, o.unit, o.amt), m: m, at: new Date(NOON + n * 60000).toISOString() };
    d.v += 1;
    var after = C.progress(d.route, days(d)).m;
    return { doc: d, m: m, crossed: C.crossed(d.route, before, after) };
  }
  function unlog(doc, lid) { var d = C.clone(doc); delete d.logs[lid]; d.v += 1; return d; }

  // An earlier trek on this phone: Mara's lunchtime walks along Hadrian's Wall.
  function treks() {
    var logs = {};
    for (var i = 0; i < 28; i++) logs['lwall' + String(i).padStart(4, '0')] = { p: 0, day: C.addDays('2026-08-03', i + Math.floor(i / 5) * 2), kind: i % 4 === 3 ? 'run' : 'walk', unit: 'km', amt: 5, t: NOON - (100 - i) * DAY };
    return {
      tdemowall1: { title: 'Lunchtime laps', mode: 'solo', route: 'hadrian', players: [{ name: 'Mara', c: 0, since: '2026-08-03' }], logs: logs, days: [], leg: 0, started: NOON - 101 * DAY, ended: NOON - 60 * DAY, t: NOON - 60 * DAY, del: false },
    };
  }

  return { TODAY: TODAY, START: START, NOON: NOON, NAME: NAME, ROUTE: ROUTE, NOTICE: NOTICE, YOU: YOU, CODE: CODE, crew: crew, log: log, unlog: unlog, treks: treks };
}));
