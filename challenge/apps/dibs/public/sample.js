/* Dibs - the example. Everything here is INVENTED: Luigi's, the four
 * friends, the dishes and the prices were written for this demo, and the page
 * says "Example" wherever it shows it.
 *
 * UMD, like dibs-core.js: the page draws it with no request and no account,
 * the fake model reads "a photo of the receipt" as RECEIPT, and the tests
 * hold that the story the page tells is true of these numbers - Sam paid,
 * the burrata is split three ways, the wine four ways, one of the two
 * margaritas each for Ben and Cleo, Ana had the salad and a sparkling water,
 * the tiramisu is still unclaimed, and an even split would have cost Ana -
 * the salad person - the most.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DibsSample = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // What the printed receipt says - also the "paste an example" text, and
  // what the fake model reads off any photo.
  var RECEIPT = [
    'LUIGI\'S TRATTORIA',
    '214 Mulberry St',
    'New York, NY 10012',
    '(212) 555-0143',
    'Server: Maria        Table 12',
    'Guests: 4',
    '09/28/2026  8:47 PM',
    '------------------------------',
    'Burrata                  16.50',
    '2 x Margarita            24.00',
    'Chianti Classico (btl)   48.00',
    'Caesar Salad             13.00',
    'Ribeye                   42.00',
    'Margherita Pizza         18.00',
    'Lasagna                  21.00',
    'Old Fashioned            15.00',
    'Tiramisu                 10.00',
    'Sparkling Water           6.00',
    '------------------------------',
    'Subtotal                213.50',
    'Sales Tax 8.875%         18.95',
    'TOTAL                   232.45',
    'VISA ************4242',
    'Suggested tip:',
    '18% ..... 38.43',
    '20% ..... 42.70',
    '22% ..... 46.97',
    'Thank you! Grazie!',
  ].join('\n');

  var PEOPLE = [
    { id: 'psam', name: 'Sam', color: 'ocean' },
    { id: 'pana', name: 'Ana', color: 'tomato' },
    { id: 'pben', name: 'Ben', color: 'basil' },
    { id: 'pcleo', name: 'Cleo', color: 'grape' },
  ];

  // [id, name, unit, qty]
  var ITEMS = [
    ['iburrata', 'Burrata', 1650, 1],
    ['imarg', 'Margarita', 1200, 2],
    ['iwine', 'Chianti Classico (btl)', 4800, 1],
    ['isalad', 'Caesar Salad', 1300, 1],
    ['iribeye', 'Ribeye', 4200, 1],
    ['ipizza', 'Margherita Pizza', 1800, 1],
    ['ilasagna', 'Lasagna', 2100, 1],
    ['iold', 'Old Fashioned', 1500, 1],
    ['itira', 'Tiramisu', 1000, 1],
    ['iwater', 'Sparkling Water', 600, 1],
  ];

  var CLAIMS = {
    iburrata: { psam: 1, pana: 1, pcleo: 1 },
    imarg: { pben: 1, pcleo: 1 },
    iwine: { psam: 1, pana: 1, pben: 1, pcleo: 1 },
    isalad: { pana: 1 },
    iribeye: { pben: 1 },
    ipizza: { pcleo: 1 },
    ilasagna: { psam: 1 },
    iold: { pben: 1 },
    iwater: { pana: 1 },
  };

  function bill() {
    return {
      title: 'Dinner at Luigi’s',
      currency: 'USD',
      items: ITEMS.map(function (r) { return { id: r[0], name: r[1], unit: r[2], qty: r[3] }; }),
      tax: 1895,
      tip: { mode: 'percent', bp: 2000, cents: 0, base: 'subtotal', even: false, onReceipt: false },
      fees: [],
      discounts: [],
      printed: { subtotal: 21350, total: 23245 },
      payerId: 'psam',
      handles: { venmo: 'sam-example', cashapp: '', paypal: '' },
    };
  }

  function state() {
    return { bill: bill(), people: PEOPLE.map(function (p) { return { id: p.id, name: p.name, color: p.color }; }), claims: JSON.parse(JSON.stringify(CLAIMS)), everyone: {} };
  }

  return { RECEIPT: RECEIPT, PEOPLE: PEOPLE, ITEMS: ITEMS, CLAIMS: CLAIMS, bill: bill, state: state, TITLE: 'Dinner at Luigi’s' };
}));
