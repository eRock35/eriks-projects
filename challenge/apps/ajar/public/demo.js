/* Ajar - the made-up example. The Fernsby family is invented: two grown-ups
 * and two children, Wren (7) and Otto (4) - first names only, like every
 * family Ajar ever sees. (A web search for the surname found no well-known
 * family or brand of that name; see CLAUDE.md.)
 *
 * They count down to Christmas: doors 1 to 24 December 2026. Tuesday and
 * Thursday evenings are busy, the school concert on Wednesday 16 December is
 * pinned as its own quick door, and the budget is $45 with a little left.
 *
 * The example's clock is fixed at Wednesday 9 December 2026, 6:15 pm:
 * doors 1-8 are open (six done, each with a little drawn "photo", door 7
 * skipped, door 6 moved to Sunday 13), door 9 is today's and waits to be
 * opened, and the shopping list is partly ticked with one thing - bird seed
 * - due tomorrow.
 *
 * Nothing here is ever saved, sent or synced. No clock and no dice: every
 * time stamp is worked out from the dates.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ajar-core'));
  else root.AjarDemo = factory(root.AjarCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var FAMILY = 'The Fernsby family';
  var TODAY = '2026-12-09';
  var END = '2026-12-25';
  var NOW = { h: 18, m: 15 };
  var ID = 'demofernsb';
  var at = function (d, h) { return C.dayOf(d) * 86400000 + (h || 18) * 3600000; };

  // The plan as it stands on 9 December, door by door.
  var PLAN = [
    ['2026-12-01', 'kitchen-disco'],
    ['2026-12-02', 'walk-bingo'],
    ['2026-12-03', 'call-someone'],
    ['2026-12-04', 'paper-chain'],
    ['2026-12-05', 'decorate-tree'],
    ['2026-12-06', 'lights-walk'],       // came back here when salt dough moved to the 13th
    ['2026-12-07', 'paper-snowflakes'],
    ['2026-12-08', 'torch-stories'],
    ['2026-12-09', 'decorate-biscuits'],
    ['2026-12-10', 'freeze-dance'],
    ['2026-12-11', 'bird-feeder'],
    ['2026-12-12', 'stick-den'],
    ['2026-12-13', 'salt-dough'],
    ['2026-12-14', 'homemade-cards'],
    ['2026-12-15', 'joke-02'],
    ['2026-12-16', 'p-concrt'],
    ['2026-12-17', 'story-chain'],
    ['2026-12-18', 'hot-chocolate'],
    ['2026-12-19', 'biscuit-house'],
    ['2026-12-20', 'light-fort'],
    ['2026-12-21', 'wrap-together'],
    ['2026-12-22', 'treat-01'],
    ['2026-12-23', 'lantern-jars'],
    ['2026-12-24', 'memory-jar'],
  ];
  // Doors 1-8: six done, one skipped (paper snowflakes - fiddly for a
  // four-year-old), one moved (the salt dough, on a tired Sunday).
  var DOORS = [
    ['2026-12-01', 'done', false],
    ['2026-12-02', 'done', false],
    ['2026-12-03', 'done', false],
    ['2026-12-04', 'done', true],
    ['2026-12-05', 'done', true],
    ['2026-12-06', 'moved', false, '2026-12-13'],
    ['2026-12-07', 'skipped', false],
    ['2026-12-08', 'done', false],
  ];

  function countdown() {
    var t0 = at('2026-11-28', 10);
    var setup = {
      template: 'christmas', year: 2026, name: 'Christmas', bigDay: '', doors: 24, ends: 'eve', look: 'festive',
      kids: [{ name: 'Wren', age: 7 }, { name: 'Otto', age: 4 }], adults: 2,
      busy: [2, 4], busyDates: [],
      pins: [{ id: 'p-concrt', title: 'School concert', date: '2026-12-16' }],
      budget: { mode: 'set', usd: 45 }, evening: 60,
    };
    var cd = C.newCountdown(ID, setup, t0);
    cd.deck.picks = PLAN.map(function (p) { return p[1]; }).filter(C.isDeckId);
    PLAN.forEach(function (p) { cd.plan[p[0]] = { a: p[1], pin: false, t: t0 }; });
    // The move on the evening of the 6th re-stamped both days.
    cd.plan['2026-12-06'].t = at('2026-12-06', 17);
    cd.plan['2026-12-13'].t = at('2026-12-06', 17);
    DOORS.forEach(function (x) { cd.doors[x[0]] = { open: true, status: x[1], star: x[2], to: x[3] || '', t: at(x[0], 19) }; });
    // The shopping: everything due by today bought, and two cards things
    // early; bird seed is still to get - by tomorrow.
    var s = C.shopping(cd, TODAY);
    s.items.forEach(function (it) {
      var early = it.key === 'folded card' || it.key === 'felt tip';
      if (C.dayOf(it.by) <= C.dayOf('2026-12-10') && it.key !== 'bird seed' || early) cd.shop[it.key] = { got: true, t: at(it.by, 12) };
    });
    return cd;
  }

  // How the example ends, for the recap: every door opened by 24 December -
  // most done, a few skipped on the busiest days, five favourites.
  function finished() {
    var cd = countdown();
    var skip = { '2026-12-15': 1, '2026-12-22': 1 }, star = { '2026-12-13': 1, '2026-12-19': 1, '2026-12-24': 1 };
    C.datesOf(cd).forEach(function (d) {
      if (cd.doors[d]) return;
      cd.doors[d] = { open: true, status: skip[d] ? 'skipped' : 'done', star: Boolean(star[d]), to: '', t: at(d, 19) };
    });
    C.shopping(cd, END).items.forEach(function (it) { cd.shop[it.key] = { got: true, t: at(it.by, 12) }; });
    return cd;
  }

  // Little drawn "photos" for the six done doors - shapes, not people.
  function svg(body, bg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><rect width="160" height="120" fill="' + bg + '"/>' + body + '</svg>');
  }
  var PHOTOS = {
    '2026-12-01': svg('<circle cx="80" cy="34" r="16" fill="#e8e3f7"/><path d="M80 18v-14" stroke="#e8e3f7" stroke-width="2"/><circle cx="34" cy="96" r="12" fill="#f4b73a"/><circle cx="126" cy="92" r="10" fill="#7fd6b3"/><path d="M20 70l20-10M140 62l-18 12M60 80l10 -14" stroke="#ff9aa5" stroke-width="4" stroke-linecap="round"/>', '#2b2350'),
    '2026-12-02': svg('<path d="M0 92h160v28H0z" fill="#dfe8ee"/><path d="M30 92l14-40 14 40zM104 92l18-52 18 52z" fill="#3f6b55"/><circle cx="124" cy="26" r="10" fill="#f6efe3"/><path d="M66 88q8-10 16 0" stroke="#c0392b" stroke-width="4" fill="none"/>', '#a9c4d6'),
    '2026-12-03': svg('<rect x="52" y="20" width="56" height="84" rx="10" fill="#1f2937"/><rect x="58" y="30" width="44" height="58" rx="4" fill="#fde68a"/><circle cx="72" cy="52" r="7" fill="#f97316"/><circle cx="90" cy="60" r="7" fill="#60a5fa"/>', '#f2e8dc'),
    '2026-12-04': svg('<g fill="none" stroke-width="7"><ellipse cx="22" cy="60" rx="14" ry="20" stroke="#c0392b"/><ellipse cx="46" cy="60" rx="14" ry="20" stroke="#2e7d4f"/><ellipse cx="70" cy="60" rx="14" ry="20" stroke="#f4b73a"/><ellipse cx="94" cy="60" rx="14" ry="20" stroke="#3b82f6"/><ellipse cx="118" cy="60" rx="14" ry="20" stroke="#c0392b"/><ellipse cx="142" cy="60" rx="14" ry="20" stroke="#2e7d4f"/></g>', '#fbf3e6'),
    '2026-12-05': svg('<path d="M80 12l38 84H42z" fill="#2e7d4f"/><rect x="72" y="96" width="16" height="16" fill="#7a4a1c"/><circle cx="68" cy="58" r="5" fill="#f4b73a"/><circle cx="94" cy="72" r="5" fill="#c0392b"/><circle cx="80" cy="40" r="5" fill="#93c5fd"/><circle cx="62" cy="84" r="5" fill="#f9a8d4"/>', '#1d2a3a'),
    '2026-12-08': svg('<path d="M58 30L150 6v108L58 90z" fill="#fef3c7" opacity=".35"/><rect x="18" y="52" width="44" height="18" rx="5" transform="rotate(-14 40 61)" fill="#6b7280"/><rect x="56" y="44" width="10" height="26" rx="3" transform="rotate(-14 61 57)" fill="#facc15"/><path d="M96 92q22-12 44 0v16q-22-12-44 0z" fill="#f6efe3"/><path d="M118 86v20" stroke="#c0392b" stroke-width="2"/>', '#111827'),
  };

  // "More ideas for us" as an example: the request a family like this would
  // send, and a made-up answer run through the same check as a real one.
  var IDEAS_REQ = { theme: 'festive', month: 12, ages: [4, 7], likes: ['crafts', 'outdoors'], budget: 'little', count: 6, avoid: PLAN.map(function (p) { return p[1]; }).filter(C.isDeckId) };
  var IDEAS_RAW = { ideas: [
    { title: 'Pine-cone animals', how: 'Collect pine cones on a walk, then give them felt ears, googly eyes and tails to make a little forest family.', time: 'short', cost: 'little', where: 'home', mess: 'some', needs: ['pine cones', 'felt scraps', 'googly eyes'], ageMin: 3, ageMax: 10 },
    { title: 'Torchlight winter walk', how: 'After dark, take torches round the block and spot five things that glow, twinkle or reflect.', time: 'short', cost: 'free', where: 'nearby', mess: 'none', needs: ['torches'], ageMin: 3, ageMax: 12 },
    { title: 'Ice-cube painting', how: 'Freeze watery paint in an ice-cube tray with lolly sticks, then paint with the cubes as they melt.', time: 'short', cost: 'little', where: 'home', mess: 'lots', needs: ['ice-cube tray', 'poster paint', 'lolly sticks'], ageMin: 2, ageMax: 8 },
    { title: 'Leaf crowns', how: 'Staple fallen leaves to a strip of card and crown everyone king or queen of the park.', time: 'short', cost: 'free', where: 'outdoors', mess: 'some', needs: ['card strips', 'stapler'], ageMin: 3, ageMax: 9 },
    { title: 'Window star map', how: 'Stick little paper stars on a dark window in the shapes you can see outside at night.', time: 'quick', cost: 'free', where: 'home', mess: 'none', needs: ['paper stars'], ageMin: 4, ageMax: 12 },
    { title: 'Bird café', how: 'Set out a tray of seeds and apple pieces and keep a tally of every visitor for a week.', time: 'quick', cost: 'little', where: 'outdoors', mess: 'none', needs: ['bird seed', 'an apple'], ageMin: 3, ageMax: 17 },
  ] };

  return { FAMILY: FAMILY, TODAY: TODAY, END: END, NOW: NOW, ID: ID, countdown: countdown, finished: finished, PHOTOS: PHOTOS, IDEAS_REQ: IDEAS_REQ, IDEAS_RAW: IDEAS_RAW };
}));
