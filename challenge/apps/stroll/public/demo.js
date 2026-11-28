/* Stroll - the made-up street on the page: the Maple Street Shop Small
 * Passport, on Small Business Saturday. Drawn by the same code as a real
 * passport and changed by the same rules (StrollCore.stamp, .act, .draw),
 * in memory only: nothing here is stored or sent, and it starts again from
 * these same numbers every time. Every name is invented.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stroll-core'));
  else root.StrollDemo = factory(root.StrollCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var TODAY = '2026-11-28';
  var NOW = Date.parse('2026-11-28T15:30:00Z');
  var ID = 'demoMapleStreet0';
  var NOTICE = 'A made-up street - nothing here is saved or sent.';
  var ME = 'DEMOdemoDEMOdemoDEMOdemoDEMOdemo'; // the visitor's card
  function tag(n) { return ('demoCARD' + (1000 + n) + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').slice(0, 32); }

  var SHOPS = [
    ['sjuniper1', 'Juniper & Wren', 'A free gift wrap with any purchase', 'JW7K', 61],
    ['spagebk22', 'Dog-Eared Books', '10% off staff picks', 'DE4B', 54],
    ['scrumb333', 'Crumb Bakery', 'A free cookie with any coffee', 'CR9M', 73],
    ['sspoke444', 'Spoke & Chain', 'A free safety check for your bike', 'SP3C', 22],
    ['sfern5555', 'Fern & Frond', '', 'FF6P', 38],
    ['stoybox66', 'The Toy Box', 'A balloon for every little shopper', 'TB2X', 47],
    ['sthread77', 'Needle & Thread', '$5 off alterations', 'NT8H', 19],
    ['skettle88', 'Copper Kettle Tea', 'A free taster of today’s tea', 'CK5T', 44],
  ];
  // Other shoppers: [first name, how many shops stamped (the first n)].
  var PEOPLE = [['Priya', 8], ['Marcus', 6], ['Dee', 5], ['Tomás', 5], ['Ada', 4], ['Lin', 3], ['Sam', 2], ['Noor', 7], ['Jo', 1], ['Wes', 5], ['Imani', 3], ['Ruth', 2]];

  function doc() {
    var shops = {};
    SHOPS.forEach(function (s, i) { shops[s[0]] = { name: s[1], perk: s[2], k: s[3], ts: i + 1 }; });
    return {
      id: ID, code: 'MAPLE2', title: 'Maple Street Shop Small Passport', place: 'Maple Street, Riverton', from: '2026-11-28', to: '2026-11-29',
      goal: 5, bonus: true, prize: 'A $150 basket with something from every shop', v: 1,
      host: { name: 'Ana', keyHash: 'demo' }, shops: shops, winners: {},
    };
  }
  /** Every card on the made-up street, the visitor's first. */
  function cards() {
    var mine = { tag: ME, name: 'You', stamps: {}, removed: false };
    [0, 2, 5].forEach(function (i) { mine.stamps[SHOPS[i][0]] = NOW - (i + 1) * 600000; });
    return [mine].concat(PEOPLE.map(function (p, n) {
      var stamps = {};
      SHOPS.slice(0, p[1]).forEach(function (s, i) { stamps[s[0]] = NOW - (n + i) * 300000; });
      return { tag: tag(n), name: p[0], stamps: stamps, removed: false };
    }));
  }
  /** The counts a real stroll keeps by increment - here worked out from
   *  the cards, plus the made-up footfall beyond the named shoppers. */
  function counts(d, list) {
    var out = { cards: 0, stamps: 0, done: 0 };
    var named = {};
    list.forEach(function (c) {
      if (c.removed) return;
      out.cards++;
      if (C.progress(d, c).done) out.done++;
      Object.keys(c.stamps).forEach(function (sid) { if (C.own(d.shops, sid)) named[sid] = (named[sid] || 0) + 1; });
    });
    out.cards += 84; out.done += 31;
    SHOPS.forEach(function (s) { if (!C.own(d.shops, s[0])) return; var n = s[4] + (named[s[0]] || 0); out['s_' + s[0]] = n; out.stamps += n; });
    C.shopIds(d).forEach(function (sid) { if (!C.own(out, 's_' + sid)) { out['s_' + sid] = named[sid] || 0; out.stamps += named[sid] || 0; } });
    out.d_20261128 = out.stamps;
    return out;
  }

  return { TODAY: TODAY, NOW: NOW, ID: ID, NOTICE: NOTICE, ME: ME, SHOPS: SHOPS, doc: doc, cards: cards, counts: counts };
}));
