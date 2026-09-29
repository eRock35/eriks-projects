/* Hike - the example. Everything here is INVENTED: Maple Street Coffee, its
 * prices, costs and sales were written for this demo, and the page labels it
 * as an example wherever it shows.
 *
 * UMD, like hike-core.js: the page draws it with no request and no account,
 * the fake model reads "a photo of the menu" as these lines, and the tests
 * hold that the story the page tells is true of these numbers - the latte
 * rounds to $4.95 not $4.86, the breakfast sandwich is held under $10, the
 * locked $3.00 drip coffee stays, and four weeks after the change sales are
 * down a little, well inside the break-even, so the verdict is "ahead".
 *
 * Dates are relative to `today`, so the example is always four weeks past
 * its change, whatever day it is opened.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HikeSample = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NAME = 'Example: Maple Street Coffee';
  var BUSINESS = 'Maple Street Coffee';

  // [name, price, cost, sales a month, locked, section] - cents.
  var LINES = [
    ['Drip coffee', 300, 45, 1100, true, 'Coffee'],
    ['Latte', 450, 105, 900, false, 'Coffee'],
    ['Cappuccino', 400, 95, 380, false, 'Coffee'],
    ['Cold brew', 460, 70, 520, false, 'Coffee'],
    ['Tea', 275, 35, 260, false, 'Coffee'],
    ['Hot chocolate', 375, 80, 150, false, 'Coffee'],
    ['Oat milk (add-on)', 90, 25, 640, false, 'Coffee'],
    ['Butter croissant', 360, 110, 480, false, 'Bakery'],
    ['Blueberry muffin', 325, 85, 310, false, 'Bakery'],
    ['Breakfast sandwich', 950, 320, 420, false, 'Kitchen'],
    ['Avocado toast', 1100, 360, 190, false, 'Kitchen'],
    ['House beans, 12 oz', 1600, 750, 85, false, 'Retail'],
  ];

  function lines() {
    return LINES.map(function (l, i) {
      return { id: 's' + i, name: l[0], price: l[1], cost: l[2], volume: l[3], locked: l[4], hold: true, manual: null, section: l[5] };
    });
  }

  /** What a pasted version of the menu looks like - "Paste the example". */
  var PASTE = [
    'COFFEE',
    'Drip coffee ........ 3.00',
    'Latte ........ $4.50',
    'Cappuccino - 4.00',
    'Cold brew 4.60',
    'Tea 2.75',
    'Hot chocolate 3.75',
    'Oat milk (add-on) .90',
    '',
    'BAKERY',
    'Butter croissant 3.60',
    'Blueberry muffin 3.25',
    '',
    'KITCHEN',
    'Breakfast sandwich 9.50',
    'Avocado toast 11.00',
    '',
    'RETAIL',
    'House beans, 12 oz 16.00',
  ].join('\n');

  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  /** The whole example plan, four weeks past its change as of `today`. */
  function plan(today) {
    var effective = addDays(today, -28);
    return {
      name: NAME,
      meter: { price: '8.40', cost: '2.90', margin: '', costMode: 'cost', volume: '2,600', newPrice: '8.95', unit: 'customers', whatIf: 40 },
      lines: lines(),
      settings: { target: 800, style: 'cafe', holdUnder: true, currency: 'USD' },
      rollout: { notice: addDays(effective, -30), effective: effective, grandfatherWeeks: 0 },
      announce: {
        business: BUSINESS, type: 'café', reasons: ['ingredients', 'wages', 'rent', 'since'], since: '2023',
        other: 'Milk and coffee beans cost us much more than they did.', tone: 'warm', summary: '', grandfather: '', voice: '',
      },
      draft: null,
      tracker: {
        mode: 'units', baseline: '600',
        entries: [
          { week: effective, value: '583' },
          { week: addDays(effective, 7), value: '571' },
          { week: addDays(effective, 14), value: '580' },
          { week: addDays(effective, 21), value: '574' },
        ],
      },
    };
  }

  return { NAME: NAME, BUSINESS: BUSINESS, LINES: LINES, lines: lines, PASTE: PASTE, plan: plan };
}));
