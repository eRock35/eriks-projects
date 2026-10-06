/* The example kitchen: "Sam & Priya's kitchen" - invented from end to end.
 * Twenty-seven things across the fridge, freezer and pantry, dated relative
 * to TODAY (in the viewer's time zone) so the board always has something
 * going today, something tomorrow, one thing already past its date and a
 * freezer full of later. Four weeks of history sit behind it - what was
 * eaten, what was binned (spinach, three times this month, which is what the
 * Saved tab is for) - so the stats, the streak and the shopping nudge are
 * the app's own sums over it, not hand-written numbers.
 *
 * Every item goes through ShelfCore.cleanItem, like a typed one. Played with
 * on this phone only: Ate it / Binned it / Froze it work and are never saved.
 * UMD: window.ShelfSample in the page, require() in the tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./shelf-core'));
  else root.ShelfSample = factory(root.ShelfCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // [id, catalogue id, name (or null for the catalogue's), days left, qty,
  //  place (or null), opened days ago (or null), frozen days ago (or null)]
  const ITEMS = [
    ['ixcorian1', 'herbs', 'Coriander', -1, 1, null, null, null],
    ['ixspinch1', 'spinach', 'Spinach', 0, 1, null, 2, null],
    ['ixchickn1', 'roastchicken', 'Half a roast chicken', 0, 1, null, null, null],
    ['ixstrawb1', 'berries', 'Strawberries', 0, 1, null, null, null],
    ['ixmilk001', 'milk', null, 1, 1, null, 4, null],
    ['ixmushrm1', 'mushrooms', null, 1, 1, null, null, null],
    ['ixcurry01', 'leftovers', 'Chickpea curry', 2, 2, null, null, null],
    ['ixbanana1', 'bananas', null, 2, 4, null, null, null],
    ['ixgreeky1', 'greekyog', null, 3, 1, null, 1, null],
    ['ixbread01', 'bread', 'Sourdough', 3, 1, null, null, null],
    ['ixfeta001', 'feta', null, 4, 1, null, 1, null],
    ['ixhummus1', 'hummus', null, 4, 1, null, 2, null],
    ['ixpepper1', 'peppers', null, 5, 3, null, null, null],
    ['ixeggs001', 'eggs', null, 6, 1, null, null, null],
    ['ixcarrot1', 'carrots', null, 15, 1, null, null, null],
    ['ixapple01', 'apples', null, 20, 6, null, null, null],
    ['ixchedd01', 'cheddar', null, 24, 1, null, 6, null],
    ['ixbutter1', 'butter', null, 40, 1, null, 9, null],
    ['ixonion01', 'onions', null, 18, 4, null, null, null],
    ['ixpotato1', 'potatoes', null, 12, 1, null, null, null],
    ['ixpasta01', 'pasta', 'Penne', 300, 2, null, null, null],
    ['ixtomtin1', 'tinnedtom', null, 400, 3, null, null, null],
    ['ixsalsa01', 'salsa', null, 200, 1, null, null, null],
    ['ixpeas001', 'peas', null, 200, 1, null, null, null],
    ['ixsalmon1', 'salmon', 'Salmon fillets', 60, 2, 'freezer', null, 30],
    ['ixicecrm1', 'icecream', 'Mint choc chip', 120, 1, null, 12, null],
    ['ixbreadf1', 'bread', 'Half a loaf (frozen)', 50, 1, 'freezer', null, 40],
  ];

  // What came and went in the last four weeks, as [days ago, catalogue id,
  // name or null, outcome, days left when it went]. Spinach was binned three
  // times; nothing has been binned for the last six days.
  const HISTORY = [
    [27, 'milk', null, 'ate', 2], [27, 'bananas', null, 'ate', 1], [26, 'chicken', 'Chicken thighs', 'ate', 1],
    [25, 'spinach', null, 'binned', -1], [25, 'bread', null, 'ate', 2], [24, 'yoghurt', null, 'ate', 4],
    [23, 'mince', null, 'ate', 0], [23, 'peppers', null, 'ate', 3], [22, 'berries', 'Strawberries', 'ate', 0],
    [21, 'eggs', null, 'ate', 9], [20, 'bread', 'Bagels', 'binned', -2], [20, 'salmon', null, 'ate', 1],
    [19, 'mushrooms', null, 'ate', 1], [18, 'tomatoes', null, 'ate', 2], [17, 'leftovers', 'Lasagne', 'ate', 1],
    [16, 'spinach', null, 'binned', -1], [16, 'herbs', 'Basil', 'binned', -2], [15, 'milk', null, 'ate', 1],
    [15, 'cheddar', null, 'ate', 10], [14, 'bananas', null, 'ate', 0], [13, 'broccoli', null, 'ate', 2],
    [12, 'mushrooms', null, 'binned', -1], [12, 'chicken', 'Chicken breasts', 'ate', 0], [11, 'saladbag', null, 'ate', 1],
    [10, 'yoghurt', null, 'ate', 2], [10, 'bread', null, 'ate', 1], [9, 'mince', null, 'ate', 1],
    [8, 'berries', 'Raspberries', 'ate', 0], [8, 'cucumber', null, 'ate', 2], [7, 'leftovers', 'Fish pie', 'ate', 0],
    [6, 'spinach', null, 'binned', -2], [6, 'eggs', null, 'ate', 5], [5, 'milk', null, 'ate', 0],
    [5, 'bananas', null, 'ate', 1], [4, 'chicken', 'Chicken thighs', 'ate', 1], [4, 'tomatoes', null, 'ate', 0],
    [3, 'peppers', null, 'ate', 2], [3, 'bread', null, 'ate', 0], [2, 'avocado', null, 'ate', 0],
    [2, 'saladbag', null, 'ate', 1], [1, 'yoghurt', null, 'ate', 1], [1, 'leftovers', 'Chilli', 'ate', 1],
    [1, 'broccoli', null, 'ate', 1], [0, 'apples', null, 'ate', 21],
  ];

  /** The example, as of `now` in `tz`: {name, tz, created, items, history}. */
  function state(now, tz) {
    const today = C.localDate(now, tz);
    const items = {};
    for (const r of ITEMS) {
      const it = C.cleanItem({
        id: r[0], cat: r[1], name: r[2] || C.CAT[r[1]].name, daysLeft: r[3], qty: r[4], place: r[5] || undefined,
        opened: r[6] === null ? null : C.addDays(today, -r[6]),
        frozen: r[7] === null ? null : C.addDays(today, -r[7]),
        added: C.addDays(today, -Math.min(10, r[6] === null ? 3 : r[6] + 1)),
        leftover: r[1] === 'leftovers',
      }, { today: today, keepId: true });
      items[it.id] = it;
    }
    const history = {};
    HISTORY.forEach((h, i) => {
      const date = C.addDays(today, -h[0]);
      const cat = C.CAT[h[1]];
      const id = 'ex' + String(1000 + i).slice(1) + 'hist';
      history[id] = {
        id: id, iid: 'ixgone' + String(100 + i).slice(1), name: h[2] || cat.name, emoji: h[1] === 'leftovers' ? '🍲' : cat.emoji, cat: cat.id,
        place: cat.place === 'pantry' ? 'pantry' : 'fridge', outcome: h[3], date: date, left: h[4], price: cat.price, by: null,
        at: date + 'T18:' + String(10 + (i % 40)).padStart(2, '0') + ':00.000Z',
      };
    });
    return { name: 'Sam & Priya’s kitchen', tz: tz, created: C.addDays(today, -30), items: items, history: history };
  }

  return { state: state, ITEMS: ITEMS, HISTORY: HISTORY };
});
