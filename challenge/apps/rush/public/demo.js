/* Rush - the made-up example. Larkmoor Bakehouse is invented, and so are
 * all seventy of its customers (first names and last initials only, like
 * every customer Rush ever sees). A web search for the name on 2026-11-19
 * found only unrelated bakeries; see CLAUDE.md.
 *
 * Its Thanksgiving pickup: Tuesday 24 November 2026, 11:00 am-7:00 pm, and
 * Wednesday 25 November, 8:00 am-4:00 pm, in 30-minute slots of three, with
 * a $10 deposit. Six items. 70 orders - 30 on Tuesday, 40 on Wednesday - and
 * 11 slots full (3 and 8). Pecan pie is sold out for Wednesday (24 of 24),
 * with 6 left on Tuesday: the only thing sold out.
 *
 * The example's clock is fixed at 2:10 pm on Tuesday 24 November: 11 of
 * Tuesday's 30 orders picked up, two late (T-013 from 12:30, T-036 from
 * 1:30), the 2:00s arriving, six boxed and waiting, $628 collected and $634
 * still due. Four allergy notes (T-014, T-053, T-054, T-066) and an
 * inscription. 39 deposits, 18 paid in full, 13 pay at pickup: $4,653
 * ordered. The bake list: Tuesday all out but the last trays of rolls (15
 * of 23); Wednesday's pies started (pumpkin 18 of 37, pecan 12 of 24).
 *
 * And a made-up phone-order pad: three orders written by hand, with a
 * pre-made reading that goes through the same checks as a real one.
 *
 * Nothing here is ever kept, sent or synced. No clock and no dice: every
 * time stamp is worked out from the dates.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rush-core'));
  else root.RushDemo = factory(root.RushCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var SHOP = 'Larkmoor Bakehouse';
  var DAYS = ['2026-11-24', '2026-11-25'];
  var NOW = { d: '2026-11-24', m: 14 * 60 + 10 };
  var NOTICE = 'Made up: Larkmoor Bakehouse and all of its customers are invented. The demo’s clock is set to Tuesday 24 November 2026, 2:10 pm. Nothing here is kept or sent.';
  var at = function (d, m) { return C.dayOf(d) * 86400000 + m * 60000; };
  var ITEMS = [
    // id, name, unit, price, batch (one oven load), cap a day
    ['pumpkin', 'Pumpkin pie', 'whole pie', 3000, 6, 40],
    ['pecan', 'Pecan pie', 'whole pie', 3400, 6, 24],
    ['apple', 'Apple crumb pie', 'whole pie', 3200, 6, 30],
    ['rolls', 'Dinner rolls', 'dozen', 1200, 3, null],
    ['cornbread', 'Cornbread', 'pan', 1300, 4, 20],
    ['cranberry', 'Cranberry loaf', 'loaf', 1500, 8, null],
  ];
  // Order number | name | day (0 Tue, 1 Wed) | slot | how many of each item,
  // in the order above | d deposit, f paid in full, p pay at pickup |
  // p picked up, b boxed - ready, '' waiting | note.
  var ROWS = [
    '1|Ava M.|0|11:00|100000|d|p|',
    '38|Milo C.|0|11:00|030030|p|p|',
    '5|Ella R.|0|11:30|001000|d|p|',
    '42|Remy V.|0|11:30|000030|f|p|',
    '9|Iris N.|0|12:00|020003|d|p|',
    '46|Vera N.|0|12:00|101003|p|p|',
    '13|Mara S.|0|12:30|000400|d|b|',
    '50|Zara L.|0|12:30|001110|d|p|',
    '17|Priya V.|0|12:30|100000|f|p|',
    '54|Dot H.|0|13:00|031000|d|p|Egg allergy - no egg wash on the rolls, please',
    '21|Tessa J.|0|13:00|000210|p|p|',
    '58|Hattie C.|0|13:30|000210|d|p|',
    '36|Kofi A.|0|13:30|000100|f|b|',
    '62|Lou F.|0|14:00|100110|p|b|',
    '29|Cal M.|0|14:00|010100|d|b|',
    '66|Pete G.|0|14:00|000400|f|b|Peanut allergy - no nut toppings',
    '33|Hana P.|0|14:30|010000|d|b|',
    '70|Wren P.|0|14:30|030000|f||',
    '37|Lena B.|0|15:00|200013|d||',
    '4|Dev P.|0|15:30|100000|f||',
    '41|Pia G.|0|15:30|201010|p||Two boxes, please - one is a gift',
    '8|Hugo B.|0|16:00|000400|d||Picking up for my mum',
    '45|Ula M.|0|16:00|100000|f||',
    '12|Leo F.|0|16:00|001000|d||',
    '49|Yusuf B.|0|16:30|000010|f||',
    '16|Opal G.|0|16:30|020000|p||',
    '53|Cyrus P.|0|17:00|121000|d||Coeliac - no wheat flour on the cornbread pan, please',
    '20|Sam W.|0|17:30|010000|f||',
    '57|Gil R.|0|17:30|100000|d||',
    '24|Wes Z.|0|18:00|200300|f||',
    '61|Kit B.|1|08:00|001000|d||',
    '28|Bianca R.|1|08:00|110000|f||',
    '65|Olive D.|1|08:30|001000|d||',
    '32|Gus L.|1|08:30|300000|p||',
    '69|Tova L.|1|09:00|130020|d||',
    '25|Yara Q.|1|09:00|000210|d||',
    '3|Carla D.|1|09:00|030000|f||',
    '40|Owen J.|1|09:30|200400|d||',
    '7|Grace H.|1|09:30|100000|d||',
    '44|Theo R.|1|09:30|220000|p||',
    '11|Kira L.|1|10:00|100100|d||',
    '48|Xavi T.|1|10:00|100000|d||',
    '15|Nate C.|1|10:30|001020|f||',
    '52|Bryn E.|1|10:30|000020|d||',
    '19|Rosa E.|1|10:30|300000|p||',
    '56|Flo M.|1|11:00|000400|d||',
    '23|Victor Y.|1|11:00|001000|d||',
    '60|Jack T.|1|11:00|020000|f||Running a little late is likely - hold it for me',
    '27|Abe N.|1|11:30|200200|d||Write Happy 80th on the box',
    '64|Noor S.|1|11:30|020000|d||',
    '31|Fay T.|1|12:00|000420|p||',
    '68|Silas N.|1|12:00|000101|d||',
    '35|Jules F.|1|12:00|000001|f||',
    '2|Ben T.|1|12:30|010000|d||',
    '39|Nia H.|1|12:30|200103|d||',
    '6|Finn O.|1|13:00|300000|p||',
    '43|Sadie W.|1|13:00|200100|d||',
    '10|Jonah W.|1|13:30|310001|f||',
    '47|Wynn D.|1|13:30|000002|d||',
    '18|Quinn A.|1|13:30|030000|d||',
    '51|Amos K.|1|14:00|000100|p||',
    '14|Dana K.|1|14:00|100100|d||Nut allergy in the family - please box away from the pecan pies',
    '55|Edie S.|1|14:00|010000|d||',
    '22|Uma K.|1|14:30|200200|f||',
    '59|Ines J.|1|14:30|021300|d||',
    '26|Zoe I.|1|15:00|100320|d||',
    '63|Moe A.|1|15:00|200100|p||',
    '30|Eli S.|1|15:00|230100|d||',
    '67|Rhea K.|1|15:30|000030|f||',
    '34|Ivan D.|1|15:30|200003|d||',
  ];
  var KIND = { d: 'deposit', f: 'full', p: 'pickup' };
  var HOWS = ['card', 'cash', 'card', 'other', 'card'];

  function shop() {
    var t0 = at('2026-11-01', 9 * 60);
    var setup = {
      name: SHOP, event: 'Thanksgiving pickup',
      days: [{ d: DAYS[0], open: '11:00', close: '19:00' }, { d: DAYS[1], open: '08:00', close: '16:00' }],
      slotMin: 30, perSlot: 3, cutoff: { d: '2026-11-22', t: '18:00' }, deposit: { mode: 'fixed', cents: 1000, pct: 25 },
    };
    var s = C.newShop(setup, t0);
    ITEMS.forEach(function (x, i) { s.items[x[0]] = { id: x[0], name: x[1], unit: x[2], price: x[3], batch: x[4], cap: x[5], off: false, del: false, pos: i, t: t0 }; });
    ROWS.forEach(function (row) {
      var r = row.split('|'), no = +r[0], day = DAYS[+r[2]], slot = r[3];
      var lines = [];
      r[4].split('').forEach(function (q, i) { if (+q) lines.push({ item: ITEMS[i][0], qty: +q, price: ITEMS[i][3] }); });
      var tot = lines.reduce(function (a, l) { return a + l.qty * l.price; }, 0), kind = KIND[r[5]];
      var taken = at('2026-11-02', 8 * 60) + (no - 1) * 7 * 3600000 + (no % 5) * 600000;
      var o = {
        id: 'odemo' + ('0000' + no).slice(-5), no: no, name: r[1], day: day, slot: slot, lines: lines, note: r[7] || '',
        pay: { kind: kind, paid: kind === 'deposit' ? 1000 : kind === 'full' ? tot : 0, how: kind === 'pickup' ? '' : HOWS[no % HOWS.length] },
        status: 'waiting', got: null, prev: '', at: taken, u: taken, su: taken,
      };
      if (r[6] === 'b' || r[6] === 'p') { o.status = 'boxed'; o.su = at(DAYS[0], 10 * 60 + (no % 50)); }
      if (r[6] === 'p') {
        var due = C.balance(o);
        o.prev = 'boxed'; o.status = 'picked'; o.got = due ? { cents: due, how: no % 3 ? 'card' : 'cash' } : null;
        o.su = at(DAYS[0], C.mins(slot) + 12);
      }
      s.orders[o.id] = o;
    });
    // The bake list as it stands at 2:10 on Tuesday.
    var tb = at(DAYS[0], 13 * 60);
    ITEMS.forEach(function (x) {
      var rows = C.bakeList(s, DAYS[0]).rows.filter(function (r) { return r.item === x[0]; })[0];
      if (rows) s.bake[DAYS[0] + '|' + x[0]] = { n: x[0] === 'rolls' ? 5 : rows.trays.length, t: tb };
    });
    s.bake[DAYS[1] + '|pumpkin'] = { n: 3, t: tb };
    s.bake[DAYS[1] + '|pecan'] = { n: 2, t: tb };
    return s;
  }

  // The order pad: a made-up page of phone orders, written by hand. Drawn
  // as SVG in a generic cursive font family (no web font). Its pre-made
  // reading is what a model might return for it, and goes through the same
  // checks (cleanAiSlip) and the same mapping to drafts as a real one.
  var SLIP_MENU = ITEMS.map(function (x) { return { id: x[0], name: x[1] }; });
  var SLIP_RAW = { orders: [
    { name: 'Ruth P.', items: [{ item: 'pumpkin', qty: 1 }, { item: 'rolls', qty: 1 }], weekday: 'wednesday', dayOfMonth: null, time: '10:30', note: '', paid: 'deposit', unsure: [] },
    { name: 'Omar S.', items: [{ item: 'apple', qty: 1 }, { item: 'cornbread', qty: 1 }], weekday: 'tuesday', dayOfMonth: null, time: '5pm', note: '', paid: 'unknown', unsure: ['paid'] },
    { name: 'Bea L.', items: [{ item: 'pecan', qty: 1 }, { item: 'other', qty: 2, words: 'mince pies' }], weekday: 'wednesday', dayOfMonth: 25, time: '12:30', note: '', paid: 'none', unsure: [] },
  ] };
  var PAD_LINES = [
    ['Ruth P.', '1 pumpkin + 1 doz rolls', 'Wed 10:30', '$10 dep'],
    ['Omar S.', '1 apple crumb + 1 cornbread', 'Tue 5pm', 'paid?'],
    ['Bea L.', '1 pecan, 2 mince pies', 'Wed 25th', '12:30 - pay then'],
  ];
  /** The pad as SVG markup - drawn from fixed words, nothing typed. */
  function padSvg() {
    var y = 92, rows = PAD_LINES.map(function (l, i) {
      var top = y + i * 78;
      return '<g><text x="28" y="' + top + '" class="pad-h">' + l[0] + '</text><text x="32" y="' + (top + 26) + '" class="pad-w">' + l[1] + '</text>' +
        '<text x="262" y="' + top + '" class="pad-w">' + l[2] + '</text><text x="270" y="' + (top + 26) + '" class="pad-w">' + l[3] + '</text></g>';
    }).join('');
    var rules = '';
    for (var k = 0; k < 8; k++) rules += '<line x1="20" x2="380" y1="' + (104 + k * 39) + '" y2="' + (104 + k * 39) + '"/>';
    return '<svg class="pad" viewBox="0 0 400 360" role="img" aria-label="A made-up phone-order pad with three handwritten orders">' +
      '<rect x="6" y="6" width="388" height="348" rx="10" class="pad-bg"/><rect x="6" y="6" width="388" height="40" rx="10" class="pad-top"/>' +
      '<text x="24" y="33" class="pad-t">PHONE ORDERS - THANKSGIVING</text><line x1="252" x2="252" y1="52" y2="350" class="pad-m"/>' +
      '<g class="pad-r">' + rules + '</g>' + rows + '<text x="24" y="344" class="pad-x">Made-up example</text></svg>';
  }

  return { SHOP: SHOP, DAYS: DAYS, NOW: NOW, NOTICE: NOTICE, ITEMS: ITEMS, ROWS: ROWS, shop: shop, SLIP_MENU: SLIP_MENU, SLIP_RAW: SLIP_RAW, PAD_LINES: PAD_LINES, padSvg: padSvg };
}));
