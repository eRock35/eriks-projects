/* The example crew: made up from end to end - the people, the beers and the
 * breweries are invented, so nothing here claims anything about a real
 * business. The first thing a new visitor sees, played with on the phone
 * and never saved. Timestamps are relative to "now", so the Same-Can
 * Challenge is always open and the history always recent.
 * UMD: window.FlightSample in the page, require() in the tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlightSample = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;
  var ME = 'mxsam0001';
  var MEMBERS = [
    { id: 'mxmaya001', name: 'Maya', emoji: '🦊', host: true, seat: true },
    { id: 'mxdev0001', name: 'Dev', emoji: '🐙', host: false, seat: false },
    { id: 'mxjonah01', name: 'Jonah', emoji: '🌵', host: false, seat: false },
    { id: 'mxpriya01', name: 'Priya', emoji: '🌶️', host: false, seat: true },
    { id: ME, name: 'Sam', emoji: '🐻', host: false, seat: false },
  ];
  var MAYA = 'mxmaya001', DEV = 'mxdev0001', JONAH = 'mxjonah01', PRIYA = 'mxpriya01', SAM = ME;

  /** The coming Sunday at 23:59 on this device's clock, at least a day off,
   *  so the example's window always reads like a weekend. */
  function sundayNight(now) {
    var d = new Date(now);
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
    d.setHours(23, 59, 0, 0);
    if (d.getTime() - now < DAY) d.setDate(d.getDate() + 7);
    return d.getTime();
  }
  function iso(t) { return new Date(t).toISOString(); }
  function sc(stars, style, abv, chips, note) { return { stars: stars, style: style, abv: abv, chips: chips || [], note: note || '', at: '' }; }

  function lagerNight(now) {
    var t = now - 21 * DAY;
    return {
      id: 'sxlager01', kind: 'blind', title: 'Lager night', runner: MAYA, stage: 'tasting',
      createdAt: iso(t - 3 * 3600000), updatedAt: iso(t), revealedAt: iso(t), v: 40,
      beers: [
        { id: 'bxl1', label: 'A', name: 'Copper Kettle Märzen', brewery: 'Old Mill Brewing', style: 'marzen', abv: 5.8, broughtBy: JONAH, addedBy: JONAH },
        { id: 'bxl2', label: 'B', name: 'Lakeside Helles', brewery: 'Pine Hollow', style: 'helles', abv: 4.9, broughtBy: MAYA, addedBy: MAYA },
        { id: 'bxl3', label: 'C', name: 'Cold Snap Pils', brewery: 'Ridgeback Beer Co.', style: 'pilsner', abv: 5.0, broughtBy: DEV, addedBy: DEV },
      ],
      scores: {
        bxl1: { mxmaya001: sc(3.5, 'marzen', 5.5, ['malty', 'sweet']), mxdev0001: sc(3, 'dunkel', 6), mxpriya01: sc(4, 'amber', 5.8, ['malty']), mxsam0001: sc(3.5, 'bock', 6.5) },
        bxl2: { mxdev0001: sc(4, 'pilsner', 4.8, ['crisp']), mxjonah01: sc(4.5, 'helles', 5, ['crisp', 'light']), mxpriya01: sc(3.5, 'kolsch', 4.6), mxsam0001: sc(4, 'helles', 4.5) },
        bxl3: { mxmaya001: sc(4.5, 'pilsner', 5.2, ['crisp', 'bitter']), mxjonah01: sc(4, 'helles', 4.9), mxpriya01: sc(4.5, 'pilsner', 5, ['crisp']), mxsam0001: sc(3, 'light-lager', 4.2) },
      },
      guesses: {
        mxmaya001: { bxl1: JONAH, bxl3: DEV }, mxpriya01: { bxl1: DEV, bxl2: MAYA, bxl3: JONAH }, mxsam0001: { bxl2: MAYA, bxl3: DEV },
      },
      cities: {},
    };
  }

  function hazyNight(now) {
    var t = now - 7 * DAY;
    return {
      id: 'sxhazy001', kind: 'blind', title: 'Hazy vs West Coast', runner: MAYA, stage: 'tasting',
      createdAt: iso(t - 3 * 3600000), updatedAt: iso(t), revealedAt: iso(t), v: 61,
      beers: [
        { id: 'bxh1', label: 'A', name: 'Switchback West', brewery: 'Ridgeback Beer Co.', style: 'west-coast', abv: 7.2, broughtBy: PRIYA, addedBy: PRIYA },
        { id: 'bxh2', label: 'B', name: 'Fog Lantern', brewery: 'Tidewater Brewing', style: 'hazy', abv: 6.8, broughtBy: MAYA, addedBy: MAYA },
        { id: 'bxh3', label: 'C', name: 'Sunday Lawn', brewery: 'Clearwater', style: 'na-wheat', abv: 0.4, broughtBy: SAM, addedBy: SAM },
        { id: 'bxh4', label: 'D', name: 'Night Ferry', brewery: 'Harbor Lane', style: 'oatmeal-stout', abv: 5.9, broughtBy: DEV, addedBy: DEV },
      ],
      scores: {
        bxh1: {
          mxmaya001: sc(4, 'west-coast', 7, ['hoppy', 'bitter', 'dry'], 'Pine needles, in a good way.'),
          mxdev0001: sc(3.5, 'ipa', 6.5, ['hoppy', 'bitter']),
          mxjonah01: sc(2, 'dipa', 8, ['bitter', 'boozy'], 'Too much for me.'),
          mxsam0001: sc(4.5, 'west-coast', 7.5, ['hoppy', 'crisp'], 'Snappy finish.'),
        },
        bxh2: {
          mxdev0001: sc(4.5, 'hazy', 6.5, ['juicy', 'fruity', 'smooth'], 'Mango smoothie with a hop backbone.'),
          mxjonah01: sc(3, 'witbier', 5.5, ['fruity', 'sweet']),
          mxpriya01: sc(4.5, 'hazy', 6.8, ['juicy', 'fruity'], 'This is the one.'),
          mxsam0001: sc(5, 'hazy', 7, ['juicy', 'hoppy', 'smooth'], 'Would drink again.'),
        },
        bxh3: {
          mxmaya001: sc(3.5, 'hefeweizen', 4.5, ['light', 'fruity'], 'Banana-ish. No idea.'),
          mxdev0001: sc(3, 'na-wheat', 0.5, ['light'], 'NA? Has to be.'),
          mxjonah01: sc(4, 'witbier', 4.8, ['light', 'spicy']),
          mxpriya01: sc(3.5, 'na-lager', 0.5, ['light', 'crisp']),
        },
        bxh4: {
          mxmaya001: sc(4, 'oatmeal-stout', 6, ['roasty', 'smooth'], 'Coffee and toast.'),
          mxjonah01: sc(5, 'imperial-stout', 9, ['roasty', 'boozy'], 'Best of the night by a mile.'),
          mxpriya01: sc(3.5, 'porter', 5.5, ['roasty']),
          mxsam0001: sc(3.5, 'milk-stout', 5, ['roasty', 'sweet']),
        },
      },
      guesses: {
        mxmaya001: { bxh1: PRIYA, bxh3: SAM, bxh4: DEV },
        mxdev0001: { bxh1: PRIYA, bxh2: SAM, bxh3: MAYA },
        mxjonah01: { bxh1: DEV, bxh2: MAYA, bxh3: PRIYA, bxh4: SAM },
        mxpriya01: { bxh2: MAYA, bxh3: SAM, bxh4: DEV },
        mxsam0001: { bxh1: PRIYA, bxh2: DEV, bxh4: MAYA },
      },
      cities: {},
    };
  }

  function sameCan(now) {
    return {
      id: 'sxcan0001', kind: 'samecan', mode: 'same', title: 'Same-Can: Cold Snap Pils (the rematch)', runner: MAYA,
      createdAt: iso(now - DAY), updatedAt: iso(now - 4 * 3600000), revealedAt: null, v: 9,
      window: { opensAt: iso(now - DAY), closesAt: iso(sundayNight(now)) },
      beers: [{ id: 'bxc1', label: 'A', name: 'Cold Snap Pils', brewery: 'Ridgeback Beer Co.', style: 'pilsner', abv: 5.0, broughtBy: null, addedBy: MAYA }],
      scores: {
        bxc1: {
          mxdev0001: sc(4, 'pilsner', 5.1, ['crisp', 'bitter'], 'Better from the can than on tap.'),
          mxpriya01: sc(3.5, 'helles', 4.8, ['crisp', 'light'], 'Fine on a porch. Hot one in Denver.'),
        },
      },
      guesses: {},
      cities: { mxdev0001: 'Austin', mxpriya01: 'Denver' },
    };
  }

  function poll(now) {
    return {
      id: 'pxnext001', question: 'Where do we go next month?', runner: DEV, closed: false, pick: null,
      createdAt: iso(now - 2 * DAY), updatedAt: iso(now - DAY), v: 7,
      options: [
        { id: 'oxa', text: 'Harbor Lane taproom - trivia night', crawl: null, addedBy: DEV },
        { id: 'oxb', text: 'River district crawl · Portland, Oregon', addedBy: MAYA, crawl: { title: 'River district crawl', place: 'Portland, Oregon', stops: ['Harbor Lane', 'Tidewater Brewing', 'Old Mill Brewing', 'Pine Hollow'], miles: 1.9, by: 'Maya', url: null } },
        { id: 'oxc', text: 'Tidewater’s anniversary party', crawl: null, addedBy: PRIYA },
      ],
      votes: { mxmaya001: ['oxb', 'oxa'], mxdev0001: ['oxb'], mxjonah01: ['oxb', 'oxc'], mxpriya01: ['oxa'] },
    };
  }

  function state(now) {
    now = now || Date.now();
    return {
      crew: { id: 'sample', name: 'Thursday Pour Crew', code: 'PNTKQ7', display: 'PNT-KQ7', v: 1, members: MEMBERS.map(function (m) { return Object.assign({}, m); }), me: ME, host: false },
      sessions: [sameCan(now), hazyNight(now), lagerNight(now)],
      polls: [poll(now)],
    };
  }

  return { state: state, ME: ME, MEMBERS: MEMBERS };
});
