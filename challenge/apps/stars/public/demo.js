/* Stars - the made-up example. Saltmarrow Kitchen is invented, and so is
 * every dish, price, plate cost and sale on its menu: four weeks of sales,
 * picked so each part of the method shows:
 *
 *   Mains (6)    one of each kind, and two more:
 *                Braised short rib       STAR       $28.00, CM $18.20, 210 sold
 *                Beer-battered fish      PLOWHORSE  $19.00, CM $10.40, 260 sold
 *                Smash burger            PLOWHORSE  $17.00, CM $10.90, 240 sold
 *                Wild mushroom risotto   PUZZLE     $21.00, CM $16.80,  70 sold
 *                Confit duck leg         DOG        $24.00, CM $10.10,  40 sold
 *                Lobster linguine        DOG        $29.00, CM -$1.40,  55 sold
 *                                        - it loses money on every plate
 *                T = 875, TCM = $10,645.00, margin line $12.17 (12.1657...),
 *                popularity line 0.7 x 875 / 6 = 102.1 units
 *   Starters (5), Desserts (4)   the same method in other sections
 *   Kids (1)     one dish alone: a star by definition, and the page says so
 *   Sides (1)    a dish read from the menu with no plate cost yet: not rated
 *
 * Never kept, sent or synced. No clock: every time is D.T plus a constant.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stars-core'));
  else root.StarsDemo = factory(root.StarsCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var T = 1795000000000;
  var NAME = 'Saltmarrow Kitchen';
  var PERIOD = 'Four weeks of sales';
  var NOTICE = 'Made-up example: Saltmarrow Kitchen and its menu are invented. Nothing here is kept or sent.';

  // [id, name, section, price, plate cost, units sold]
  var DISHES = [
    ['imain00001', 'Braised short rib', 'Mains', '28.00', '9.80', '210'],
    ['imain00002', 'Beer-battered fish', 'Mains', '19.00', '8.60', '260'],
    ['imain00003', 'Smash burger', 'Mains', '17.00', '6.10', '240'],
    ['imain00004', 'Wild mushroom risotto', 'Mains', '21.00', '4.20', '70'],
    ['imain00005', 'Confit duck leg', 'Mains', '24.00', '13.90', '40'],
    ['imain00006', 'Lobster linguine', 'Mains', '29.00', '30.40', '55'],
    ['istart0001', 'Crispy squid', 'Starters', '12.00', '3.10', '260'],
    ['istart0002', 'Burrata and peaches', 'Starters', '14.00', '5.20', '180'],
    ['istart0003', 'Soup of the day', 'Starters', '9.00', '1.80', '90'],
    ['istart0004', 'Charcuterie board', 'Starters', '22.00', '11.50', '60'],
    ['istart0005', 'Grilled flatbread', 'Starters', '7.00', '1.40', '240'],
    ['idess00001', 'Sticky toffee pudding', 'Desserts', '10.00', '2.10', '150'],
    ['idess00002', 'Chocolate tart', 'Desserts', '11.00', '2.60', '120'],
    ['idess00003', 'Affogato', 'Desserts', '10.00', '1.20', '40'],
    ['idess00004', 'Cheese plate', 'Desserts', '15.00', '7.40', '30'],
    ['ikids00001', 'Kids pasta', 'Kids', '9.00', '2.00', '85'],
    ['iside00001', 'Truffle fries', 'Sides', '8.00', '', ''],
  ];
  function book() {
    var b = C.newBook(T);
    b.period = { label: PERIOD, t: T };
    DISHES.forEach(function (d) {
      var r = C.itemFrom({ name: d[1], cat: d[2], price: d[3], cost: d[4], sold: d[5] }, T);
      if (r.errors.length) throw new Error('demo dish ' + d[1] + ': ' + r.errors[0].msg);
      b.items[d[0]] = r.item;
    });
    return b;
  }
  var FISH = 'imain00002', RISOTTO = 'imain00004', LINGUINE = 'imain00006';

  // The example menu page: invented dishes and prices, and the reading a
  // model might have made of it - with a plate cost, units sold, the
  // restaurant's phone number and a stray field among them, which the same
  // check as a real reading drops.
  var MENU_LINES = [
    ['SMALL PLATES', ''],
    ['Charred leeks, romesco', '11'],
    ['Smoked trout rillettes', '13.50'],
    ['Market oysters (6)', 'MP'],
    ['LARGER PLATES', ''],
    ['Hanger steak, chimichurri', '32'],
    ['Roast cauliflower, tahini', '19'],
    ['Pork chop, apple mostarda', '27.5'],
  ];
  var MENU_TEXT = MENU_LINES.map(function (l) { return l[1] ? l[0] + ' ... ' + l[1] : l[0]; }).join('\n');
  var MENU_RAW = {
    items: [
      { name: 'Charred leeks, romesco', section: 'Small plates', price: '11', unsure: false },
      { name: 'Smoked trout rillettes', section: 'Small plates', price: '13.50', unsure: false },
      { name: 'Market oysters (6)', section: 'Small plates', price: 'MP', unsure: true },
      { name: 'Hanger steak, chimichurri', section: 'Larger plates', price: '32', unsure: false, plate_cost: '14.20' },
      { name: 'Roast cauliflower, tahini', section: 'Larger plates', price: '19', unsure: false, units_sold: 80 },
      { name: 'Pork chop, apple mostarda', section: 'Larger plates', price: '27.5', unsure: false },
      { name: 'Call ' + ['555', '014', '2290'].join(' ') + ' to book', section: '', price: '', unsure: true },
    ],
    restaurant_phone: 'withheld',
  };
  function menuSvg() {
    var y = 64, rows = MENU_LINES.map(function (l) {
      var head = !l[1];
      var out = head ? '<text x="40" y="' + y + '" font-size="14" font-weight="700" letter-spacing="2" fill="#5b3a29">' + C.esc(l[0]) + '</text>'
        : '<text x="40" y="' + y + '" font-size="16" fill="#2b2b2b">' + C.esc(l[0]) + '</text><text x="520" y="' + y + '" font-size="16" text-anchor="end" fill="#2b2b2b">' + C.esc(l[1]) + '</text>';
      y += head ? 30 : 28;
      return out;
    }).join('');
    return '<svg class="menusvg" viewBox="0 0 560 300" role="img" aria-label="A made-up page of a restaurant menu: small plates and larger plates with prices"><rect x="4" y="4" width="552" height="292" rx="6" fill="#fbf8f1" stroke="#c9bfa8"/><text x="280" y="36" font-size="18" text-anchor="middle" font-weight="700" fill="#b0175c">Made-up example menu</text>' + rows + '</svg>';
  }

  // A till export: one row per dish per week, so the same dish appears more
  // than once (its units add up). A new dish with a price is added; one with
  // no price, a row named with
  // a phone number and a typo in a number say what is wrong with them.
  var CSV = [
    'Item Name,Menu Group,Qty Sold,Unit Price',
    'Braised short rib,Mains,104,28.00',
    'Braised short rib,Mains,98,28.00',
    'Beer-battered fish,Mains,271,19.00',
    'Smash burger,Mains,233,17.50',
    'Wild mushroom risotto,Mains,88,21.00',
    'Confit duck leg,Mains,37,24.00',
    'Lobster linguine,Mains,41,32.00',
    'Crispy squid,Starters,"1,012",12.00',
    'Pickled eggs,Bar snacks,30,5.00',
    'Chef special,Mains,12,',
    'Call ' + ['555', '014', '2290'].join(' ') + ',Mains,1,10.00',
    'Grilled flatbread,Starters,2o4,7.00',
  ].join('\n') + '\n';

  return { T: T, NAME: NAME, PERIOD: PERIOD, NOTICE: NOTICE, DISHES: DISHES, book: book, FISH: FISH, RISOTTO: RISOTTO, LINGUINE: LINGUINE, MENU_TEXT: MENU_TEXT, MENU_RAW: MENU_RAW, menuSvg: menuSvg, CSV: CSV };
}));
