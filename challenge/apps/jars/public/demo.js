/* The example family: Maya (9) and Leo (6), with about four months of real
 * pocket-money history.
 *
 * Every date is worked out from TODAY (in the viewer's time zone), and every
 * balance is the app's own sums over that history - each payday run by
 * JarsCore.runPaydays, each spend, gift, move and purchase by JarsCore.act -
 * never typed in by hand. Both children's payday is today's weekday and
 * today's payday has NOT been paid yet, so opening the example shows a
 * payday happening ("Paid today: £3 spend, £2.40 save, 60p give").
 *
 * The story, after today's payday:
 *   - Maya is saving for a LEGO set (60) at 2% a week from the Bank of Mum &
 *     Dad, and is about SIX paydays away - the size of Grandma's birthday
 *     money four months ago is chosen (by search, in the viewer's currency)
 *     so that the app's own ETA says exactly that. Her Give jar is heading
 *     to the animal shelter; a bike bell waits as her next goal.
 *   - Leo bought a dinosaur torch a month ago and is one payday from his
 *     sticker book: a little move from Spend to Save gets him there today,
 *     which is the quickest way to see the celebration.
 *
 * Amounts follow the viewer's currency (scaled for rupees, kronor and the
 * like; yen have no minor unit, so ¥600 a week). Played with on this phone
 * only: taps work and are never saved.
 * UMD: window.JarsDemo in the page, require() in the tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./jars-core'));
  else root.JarsDemo = factory(root.JarsCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // Rough "pocket money" scale against pounds and dollars, so £6 a week is
  // ₹300, 60 kr, R90 - not ₹6.
  const SCALE = { INR: 50, MXN: 15, BRL: 5, ZAR: 15, SEK: 10, NOK: 10, DKK: 7, PLN: 4, HKD: 8 };
  const MAYA_GOAL = 6000;   // the LEGO set
  const MAYA_WEEKS = 6;     // paydays to go, after today's
  const LEO_GOAL = 500;     // the sticker book
  const LEO_SHORT = 40;     // what Leo is short after today's payday

  function scaleOf(cur) { return SCALE[cur] || 1; }

  /** Run a scripted history: paydays up to each action's day, then the
   *  action, then paydays up to (not including) today. */
  function play(kid, script, today, currency) {
    let k = kid;
    // Oldest first, whatever order the script was written in.
    for (const s of script.slice().sort((a, b) => b.ago - a.ago)) {
      const d = C.addDays(today, -s.ago);
      k = C.runPaydays(k, d).kid;
      if (s.goal) { k = C.addGoal(k, s.goal, { today: d, rand: s.rand }); continue; }
      // A purchase is of whatever goal is active by then.
      const opts = s.kind === 'buy' ? { gid: C.activeGoal(k).id } : s.opts;
      k = C.act(k, s.kind, opts, { today: d, currency }).kid;
    }
    return C.runPaydays(k, C.addDays(today, -1)).kid;
  }
  function seeded(seed) {
    let s = seed >>> 0;
    return (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n; };
  }

  function maya(today, currency, birthday) {
    const m = scaleOf(currency);
    const wd = C.weekdayOf(today);
    const start = C.addDays(today, -7 * 17);
    const kid = C.cleanKid({
      id: 'kmayademo1', name: 'Maya', emoji: '🦊', colour: 'berry', age: 9, cause: 'the animal shelter',
      weekly: 600 * m, payday: wd, split: { spend: 50, save: 40, give: 10 }, interest: { on: true, bp: 200, cap: 600 * m },
      start, made: start,
    }, { today });
    const script = [
      { ago: 116, kind: 'add', opts: { amount: birthday, why: 'birthday', note: 'Birthday money from Grandma', into: 'save' } },
      { ago: 115, goal: { name: 'Art set', emoji: '🎨', price: 3000 * m }, rand: seeded(10) },
      { ago: 110, kind: 'spend', opts: { amount: 120 * m, what: 'Sweets' } },
      { ago: 104, kind: 'spend', opts: { amount: 600 * m, what: 'Cinema with friends' } },
      { ago: 100, goal: { name: 'LEGO set', emoji: '🧱', price: MAYA_GOAL * m }, rand: seeded(11) },
      { ago: 96, kind: 'spend', opts: { amount: 450 * m, what: 'Trading cards' } },
      { ago: 88, kind: 'give', opts: { amount: 200 * m, to: 'the school toy drive' } },
      { ago: 82, kind: 'spend', opts: { amount: 250 * m, what: 'Football stickers' } },
      { ago: 75, kind: 'move', opts: { amount: 200 * m, from: 'spend', to: 'save' } },
      { ago: 68, kind: 'spend', opts: { amount: 500 * m, what: 'Present for Ava’s party' } },
      { ago: 60, kind: 'spend', opts: { amount: 300 * m, what: 'A comic' } },
      { ago: 58, kind: 'buy' },
      { ago: 45, kind: 'add', opts: { amount: 300 * m, why: 'chore', note: 'Washed the car', into: 'spend' } },
      { ago: 52, kind: 'spend', opts: { amount: 200 * m, what: 'Hair clips' } },
      { ago: 40, goal: { name: 'Bike bell', emoji: '🚲', price: 800 * m }, rand: seeded(12) },
      { ago: 33, kind: 'spend', opts: { amount: 200 * m, what: 'Ice cream with Leo' } },
      { ago: 26, kind: 'spend', opts: { amount: 450 * m, what: 'Book fair' } },
      { ago: 20, kind: 'spend', opts: { amount: 350 * m, what: 'Slime kit' } },
      { ago: 15, kind: 'spend', opts: { amount: 100 * m, what: 'Sweets' } },
      { ago: 9, kind: 'spend', opts: { amount: 150 * m, what: 'Stickers' } },
      { ago: 3, kind: 'spend', opts: { amount: 100 * m, what: 'Pencil with a fox on it' } },
    ];
    return play(kid, script, today, currency);
  }

  function leo(today, currency, nudge) {
    const m = scaleOf(currency);
    const wd = C.weekdayOf(today);
    const start = C.addDays(today, -7 * 8);
    const kid = C.cleanKid({
      id: 'kleodemo01', name: 'Leo', emoji: '🐸', colour: 'leaf', age: 6, cause: 'the food bank',
      weekly: 200 * m, payday: wd, split: { spend: 50, save: 40, give: 10 }, interest: { on: false, bp: 200, cap: 0 },
      start, made: start,
    }, { today });
    const script = [
      { ago: 55, goal: { name: 'Dinosaur torch', emoji: '🦕', price: 300 * m }, rand: seeded(21) },
      { ago: 50, kind: 'spend', opts: { amount: 50 * m, what: 'Sweets' } },
      { ago: 40, kind: 'spend', opts: { amount: 100 * m, what: 'Bouncy ball' } },
      { ago: 30, kind: 'buy' },
      { ago: 29, goal: { name: 'Sticker book', emoji: '📒', price: LEO_GOAL * m }, rand: seeded(22) },
      { ago: 26, kind: 'add', opts: { amount: 100 * m, why: 'tooth', note: 'Tooth fairy!', into: 'spend' } },
      { ago: 22, kind: 'spend', opts: { amount: 150 * m, what: 'Ice cream with Maya' } },
      { ago: 46, kind: 'spend', opts: { amount: 50 * m, what: 'Sweets' } },
      { ago: 14, kind: 'give', opts: { amount: 60 * m, to: 'the food bank' } },
      { ago: 6, kind: 'spend', opts: { amount: 200 * m, what: 'Toy car' } },
      { ago: 12, kind: 'move', opts: { amount: nudge, from: 'spend', to: 'save' } },
    ].filter((s) => !(s.kind === 'move' && !nudge));
    return play(kid, script, today, currency);
  }

  /** Maya's ETA after today's payday, for a given birthday gift (Infinity
   *  when that gift is too small for the story - the art set unaffordable). */
  function mayaWeeks(today, currency, birthday) {
    let k;
    try { k = C.runPaydays(maya(today, currency, birthday), today).kid; } catch (e) { return Infinity; }
    const st = C.goalStatus(k, today);
    return st && st.weeks !== null ? st.weeks : Infinity;
  }
  /** The birthday money that makes Maya exactly MAYA_WEEKS paydays away. The
   *  ETA only falls as the gift grows, so: the smallest gift that gets her
   *  within MAYA_WEEKS, the smallest within one fewer, and the roundest
   *  amount between them. */
  function tuneBirthday(today, currency) {
    const m = scaleOf(currency);
    const hi = MAYA_GOAL * m;
    const least = (weeks) => {
      let lo = 1; let h = hi;
      while (lo < h) { const mid = Math.floor((lo + h) / 2); if (mayaWeeks(today, currency, mid) <= weeks) h = mid; else lo = mid + 1; }
      return lo;
    };
    const a = least(MAYA_WEEKS); const b = least(MAYA_WEEKS - 1);
    for (const step of [500 * m, 100 * m, 50 * m, 10 * m, 1]) {
      const x = Math.ceil(a / step) * step;
      if (x < b && mayaWeeks(today, currency, x) === MAYA_WEEKS) return x;
    }
    return a;
  }

  function build(today, currency) {
    const cur = C.cleanCur(currency) || 'USD';
    const m = scaleOf(cur);
    const mk = maya(today, cur, tuneBirthday(today, cur));
    // Leo: how far short is he after today's payday without the nudge?
    const bare = C.runPaydays(leo(today, cur, 0), today).kid;
    const nudge = Math.max(0, Math.min(bare.jars.spend, LEO_GOAL * m - LEO_SHORT * m - bare.jars.save));
    const lk = leo(today, cur, nudge);
    const kids = [mk, lk].map((k) => C.cleanKid(k, { today }));
    return { settings: { currency: cur, curAuto: true }, kids, example: true };
  }

  return { build, MAYA_WEEKS, LEO_GOAL, LEO_SHORT, scaleOf, _mayaWeeks: mayaWeeks, _tune: tuneBirthday, _leo: leo };
});
