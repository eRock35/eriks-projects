/* Spotted - the made-up example. Everything here is invented: the Vance-
 * Okoro family (Junie, Theo, Rosa and Ben), their drive to Gran's for
 * Thanksgiving, and three trips before it. The car game is played on this
 * phone only - the other three "phones" are scripted - and is never kept,
 * sent or synced. No clock and no dice: the times are constants.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./spotted-core'));
  else root.SpottedDemo = factory(root.SpottedCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var T = 1795618800000;   // Wed 25 Nov 2026, 15:00 UTC - the day before Thanksgiving
  var NAME = 'Over the river to Gran’s';
  var NOTICE = 'Made up: the Vance-Okoro family, their drive and their trips are invented. The other phones are scripted; nothing here is kept or sent.';
  var YOU = 'mjunie';
  var CODE = 'TRK4GN';
  var MIN = 60000;

  var MEMBERS = [['mjunie', 'Junie', 0, true], ['mtheo', 'Theo', 1], ['mrosa', 'Rosa', 2], ['mben', 'Ben', 3]];
  // [plate, who, minutes into the drive]
  var SPOTS = [
    ['VA', 'mben', 2], ['MD', 'mrosa', 4], ['NC', 'mjunie', 7], ['PA', 'mtheo', 9], ['NY', 'mtheo', 12], ['FL', 'mrosa', 15],
    ['NJ', 'mjunie', 18], ['TN', 'mben', 22], ['SC', 'mrosa', 26], ['DC', 'mtheo', 31], ['GA', 'mjunie', 35], ['WV', 'mrosa', 40],
    ['TX', 'mben', 44], ['MA', 'mtheo', 51], ['CT', 'mjunie', 55], ['KY', 'mrosa', 63], ['DE', 'mjunie', 70], ['IL', 'mben', 77],
    ['MI', 'mtheo', 84], ['CA', 'mrosa', 92], ['ME', 'mtheo', 101], ['AL', 'mben', 110],
  ];
  // The scripted race: tap Ohio and Theo's phone gets there a beat before
  // yours - first tap wins.
  var RACE = { OH: 'mtheo' };

  function game() {
    var members = {}, spots = {};
    MEMBERS.forEach(function (m, i) {
      members[m[0]] = { name: m[1], c: m[2], joinedAt: new Date(T + i * 1000).toISOString(), at: new Date(T).toISOString() };
      if (m[3]) members[m[0]].host = true;
    });
    SPOTS.forEach(function (s) { spots[s[0]] = { by: s[1], at: new Date(T + s[2] * MIN).toISOString() }; });
    return { id: 'demo000000000000', code: CODE, title: NAME, scoring: 'rarity', v: 1, members: members, spots: spots, ended: null, createdAt: new Date(T).toISOString(), updatedAt: new Date(T).toISOString() };
  }
  /** A tap in the example: yours, unless the script says another phone
   *  got there first. Returns {doc, taken: name|null}. */
  function tap(doc, code, at) {
    var d = C.clone(doc);
    if (d.spots[code]) return { doc: d, taken: d.spots[code].by === YOU ? 'you' : d.members[d.spots[code].by].name };
    var who = RACE[code] || YOU;
    d.spots[code] = { by: who, at: new Date(at).toISOString() };
    d.v += 1;
    return { doc: d, taken: who === YOU ? null : d.members[who].name };
  }
  function untap(doc, code) { var d = C.clone(doc); delete d.spots[code]; d.v += 1; return d; }

  // Three earlier trips, so the history and the lifetime map have stories.
  function trip(title, start, players, plates, scoring) {
    var spots = {};
    plates.forEach(function (p, i) { spots[p[0]] = { p: p[1], t: start + (i + 1) * 7 * MIN }; });
    return { title: title, mode: players.length > 1 ? 'game' : 'solo', scoring: scoring || 'rarity', players: players.map(function (n, i) { return { name: n, c: i }; }), spots: spots, started: start, ended: start + 9 * 60 * MIN, t: start + 9 * 60 * MIN, del: false };
  }
  function trips() {
    return {
      tdemolake1: trip('Lake weekend', 1784383200000, ['Junie', 'Theo'], [['VA', 0], ['NC', 1], ['PA', 0], ['OH', 1], ['MD', 0], ['NY', 1], ['WV', 0], ['IN', 1], ['MI', 1], ['KY', 0], ['VT', 0], ['IL', 1], ['TN', 0], ['NJ', 1]]),
      tdemocoast: trip('Spring break at the coast', 1773493200000, ['Junie', 'Theo', 'Rosa', 'Ben'], [['SC', 2], ['GA', 3], ['FL', 0], ['NC', 1], ['VA', 2], ['TN', 0], ['OH', 3], ['NY', 1], ['AL', 2], ['TX', 0], ['MS', 3], ['LA', 1], ['PA', 2], ['MA', 0], ['ME', 1], ['AK', 2], ['CO', 3], ['NH', 0], ['MN', 1], ['WI', 2]]),
      tdemogran5: trip('Gran’s, last Thanksgiving', 1764165600000, ['Junie', 'Theo', 'Rosa', 'Ben'], [['VA', 3], ['MD', 2], ['PA', 1], ['NC', 0], ['DE', 0], ['NJ', 3], ['NY', 1], ['CT', 2], ['FL', 3], ['GA', 0], ['MA', 1], ['OH', 2], ['IL', 0], ['AZ', 1], ['RI', 3], ['WA', 2], ['MO', 0], ['HI', 1]]),
    };
  }

  return { T: T, NAME: NAME, NOTICE: NOTICE, YOU: YOU, CODE: CODE, RACE: RACE, game: game, tap: tap, untap: untap, trips: trips };
}));
