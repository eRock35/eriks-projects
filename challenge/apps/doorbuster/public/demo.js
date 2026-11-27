/* Doorbuster - the made-up example: Juniper & Wren, a gift shop.
 *
 * Its Black Friday weekend, Friday Nov 27 to Monday Nov 30 2026, as the
 * page would show it on the Saturday - day 2 of 4, mid-sale. Every person
 * and the shop are invented. It is drawn by the same code as a real sale
 * and changed by the same one door (DoorbusterCore.act), in memory only:
 * nothing in it is kept, sent or synced.
 *
 * Planted, so the example shows what the app is for:
 *   - 30% off the soy candle: usually 20 sold making $240; at 30% off each
 *     makes $5.40, so it needs 45 - 2.3x - and stands at 31 of 45. Tight.
 *   - Buy 2, get 1 free on the wool scarf: looks like 33% off, costs only
 *     on the third. Needs 26 sets (1.3x); 14 so far.
 *   - Enamel mug + tea tin for $20: a bundle that makes MORE than the mug
 *     alone. Break-even 12 bundles; 13 sold - already past it.
 *   - The doorbuster itself: the glass ornament at $4 off, BELOW COST -
 *     every sale loses $1.20, at most $36 if all 30 go, limit 2. There to
 *     bring people in. 22 gone, 8 left.
 *   - Spend $50, get $10 off: 12 of the usual 100 baskets get it for
 *     nothing; 20 uses to pay for itself; 9 so far.
 *   - Ana owns the sale; Theo and Priya are at the counter and see no cost.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./doorbuster-core'));
  else root.DoorbusterDemo = factory(root.DoorbusterCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var TODAY = '2026-11-28';
  var NOW = Date.UTC(2026, 10, 28, 19, 30);
  var ME = 'mowner11';
  var STAFF = 'mtheo222';
  var NOTICE = 'This is a made-up shop on the Saturday of its sale. Tap anything - nothing is kept or sent.';

  function doc() {
    var d = {
      id: 'demosale00000001', code: 'TRYDBR', v: 1,
      members: {
        mowner11: { name: 'Ana', c: 0, host: true, joinedAt: '2026-11-20T10:00:00.000Z' },
        mtheo222: { name: 'Theo', c: 1, joinedAt: '2026-11-26T09:00:00.000Z' },
        mpriya33: { name: 'Priya', c: 2, joinedAt: '2026-11-27T08:30:00.000Z' },
      },
      items: {}, deals: {}, tally: {}, taps: { mowner11: {}, mtheo222: {}, mpriya33: {} },
    };
    var g = C.cleanSale({ shop: 'Juniper & Wren', title: 'Black Friday weekend', from: '2026-11-27', to: '2026-11-30', cur: '$', margin: 50 }, TODAY);
    Object.keys(g).forEach(function (k) { d[k] = g[k]; });
    var n = 0;
    function item(id, name, price, cost, base, stock) { var x = C.cleanItem({ name: name, price: price, cost: cost, base: base, stock: stock }); x.ts = 1000 + (n++); d.items[id] = x; }
    function deal(id, raw, count, taps) {
      var x = C.cleanDeal(raw, d, null); x.ts = 2000 + (n++); d.deals[id] = x; d.tally[id] = count;
      d.taps.mowner11[id] = taps[0]; d.taps.mtheo222[id] = taps[1]; d.taps.mpriya33[id] = taps[2];
    }
    item('icandle1', 'Soy candle', 2200, 1000, 20, 60);
    item('iscarf01', 'Wool scarf', 4000, 2200, 20, 84);
    item('imug0001', 'Enamel mug', 1400, 400, 15, 40);
    item('iteatin1', 'Tea tin', 1200, 325, 12, 36);
    item('iornamt1', 'Glass ornament', 600, 320, 30, 30);
    item('icards01', 'Card set', 900, 250, 10, null);
    deal('dcandle1', { kind: 'pct', items: ['icandle1'], pct: 30, was: true }, 31, [6, 14, 11]);
    deal('dscarf01', { kind: 'multi', items: ['iscarf01'], n: 2, m: 1, mpct: 100, was: true }, 14, [2, 7, 5]);
    deal('dbundle1', { kind: 'bundle', items: ['imug0001', 'iteatin1'], price: 2000, was: true }, 13, [3, 4, 6]);
    deal('dornamt1', { kind: 'amount', items: ['iornamt1'], off: 400, limit: 2, wsl: true, goal: 'traffic' }, 22, [5, 9, 8]);
    deal('dspend01', { kind: 'spend', spend: 5000, save: 1000, basket: 3200, baskets: 100, clear: 12 }, 9, [1, 5, 3]);
    return d;
  }
  /** Draft items, as "Fill from a price list" would hand them back. */
  function drafts() { return C.cleanDrafts([{ name: 'Beeswax taper, pair', price: 16, cost: 6.4 }, { name: 'Linen tea towel', price: 18, cost: 0 }, { name: 'Brass bell', price: 0, cost: 4.75 }]); }

  return { TODAY: TODAY, NOW: NOW, ME: ME, STAFF: STAFF, NOTICE: NOTICE, doc: doc, drafts: drafts };
}));
