/* Baste - the made-up example: Thanksgiving at Rosa's.
 *
 * One oven, nine dishes, dinner at four - as the page would show it at
 * 1:10 in the afternoon on Thanksgiving Day 2026 in Chicago. Every person
 * is invented. It is drawn by the same code as a real dinner and changed by
 * the same one door (BasteCore.act), in memory only: nothing in it is kept,
 * sent or synced.
 *
 * Planted, so the example shows what the app is for:
 *   - The pumpkin pie and the cranberry sauce were made this morning.
 *   - The 14 lb turkey went in at 11:24, a minute early, and has been
 *     basted twice. An earlier fix already took it out 20 minutes early:
 *     it rests 50 minutes under foil so the sides get the oven.
 *   - Mei is bringing the sweet potatoes: 20 minutes at 375 F when she
 *     arrives at three. The stuffing and the green bean casserole are in
 *     at 350 F then - a CONFLICT, with its fix (share the oven at 350 F,
 *     the time marked as an estimate).
 *   - Sam has the mashed potatoes; nobody has the gravy or the rolls yet.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./baste-core'));
  else root.BasteDemo = factory(root.BasteCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var TZ = 'America/Chicago';
  var DAY = '2026-11-26';
  var at = function (hm) { return C.zonedToUtc(DAY + 'T' + hm, TZ); };
  var NOW = at('13:10');
  var ME = 'mrosa111';
  var NOTICE = 'This is a made-up dinner, shown as it would be at 1:10 PM. Tap anything - nothing is kept or sent.';

  function doc() {
    var dn = C.cleanDinner({ title: 'Thanksgiving at Rosa’s', eatLocal: DAY + 'T16:00', tz: TZ, ovens: 1, fit: 3, unit: 'F' }, DAY);
    var d = {
      id: 'demodinner000001', code: 'TRYBST', v: 1,
      members: {
        mrosa111: { name: 'Rosa', c: 0, host: true, joinedAt: '2026-11-24T10:00:00.000Z' },
        msam2222: { name: 'Sam', c: 1, joinedAt: '2026-11-24T11:00:00.000Z' },
        mmei3333: { name: 'Mei', c: 2, joinedAt: '2026-11-25T09:00:00.000Z' },
        mleo4444: { name: 'Leo', c: 3, joinedAt: '2026-11-26T12:30:00.000Z' },
      },
      dishes: {}, done: {}, claims: {},
    };
    Object.keys(dn).forEach(function (k) { d[k] = dn[k]; });
    var n = 0;
    function dish(id, kind, extra, more) {
      var f = C.fromPreset(kind), k;
      for (k in (extra || {})) if (C.own(extra, k)) f[k] = extra[k];
      var x = C.cleanDish(f, d, null);
      x.by = 'mrosa111'; x.ts = at('08:00') + (n++);
      for (k in (more || {})) if (C.own(more, k)) x[k] = more[k];
      d.dishes[id] = x;
    }
    dish('dturkey01', 'turkey', { weight: 14, stuffed: false }, { who: 'mrosa111', fix: { early: 20 } });
    dish('dstuffing', 'stuffing', {}, { who: 'mrosa111' });
    dish('dmashed01', 'mashed', {}, { who: 'msam2222' });
    dish('dsweetpot', 'sweet', { cook: 20, temp: 375, prep: 0, rest: 10, guest: true, arrive: '15:00', note: 'Already assembled - just needs the oven' }, { who: 'mmei3333', by: 'mmei3333' });
    dish('dgreenbn1', 'greenbean', {}, { who: 'mleo4444' });
    dish('drolls001', 'rolls', {});
    dish('dgravy001', 'gravy', {});
    dish('dcranbry1', 'cranberry', {}, { who: 'msam2222' });
    dish('dpumpkin1', 'pumpkinpie', {}, { who: 'mrosa111' });
    d.done = {
      dpumpkin1_make: { at: at('09:05'), by: 'mrosa111' },
      dcranbry1_make: { at: at('10:20'), by: 'msam2222' },
      dturkey01_prep: { at: at('11:20'), by: 'mrosa111' },
      dturkey01_heat: { at: at('11:10'), by: 'mrosa111' },
      dturkey01_in: { at: at('11:24'), by: 'mrosa111' },
      dturkey01_baste_1: { at: at('12:10'), by: 'mleo4444' },
      dturkey01_baste_2: { at: at('12:56'), by: 'mrosa111' },
    };
    d.claims = { dturkey01_baste_3: 'mleo4444' };
    return d;
  }

  return { TZ: TZ, DAY: DAY, NOW: NOW, ME: ME, NOTICE: NOTICE, doc: doc };
}));
