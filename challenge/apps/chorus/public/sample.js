/* The example household: "The Garcias" - invented from end to end. Four
 * people (two grown-ups, a teen who counts three quarters and a nine-year-old
 * who counts half), ten chores, four weeks of history and this week in
 * progress. It is DEALT by the real rules (ChorusCore.deal), week after week,
 * so the rotation, the explanations and the fairness numbers it shows are the
 * app's own, not hand-written. Who did what is decided by a hash, so the same
 * day always shows the same example: Luis lets a few slide and Maria picks
 * them up, which is what the fairness tab is for.
 *
 * Played with on this phone only - ticks and swaps work and are never saved.
 * UMD: window.ChorusSample in the page, require() in the tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chorus-core'));
  else root.ChorusSample = factory(root.ChorusCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  const ME = 'mxmaria01';
  const MEMBERS = [
    { id: ME, name: 'Maria', emoji: '🦋', weight: 1, cant: [], dislikes: ['cxlaundry'] },
    { id: 'mxluis001', name: 'Luis', emoji: '🐻', weight: 1, cant: [], dislikes: ['cxbathrm1'] },
    { id: 'mxsofia01', name: 'Sofia', emoji: '🦊', weight: 0.75, cant: [], dislikes: ['cxbathrm1', 'cxbins001'] },
    { id: 'mxmateo01', name: 'Mateo', emoji: '🐢', weight: 0.5, cant: ['cxbathrm1', 'cxgrocery', 'cxlaundry'], dislikes: ['cxvacuum1'] },
  ];
  const CHORES = [
    { id: 'cxdishes1', name: 'Load and unload the dishwasher', emoji: '🍽️', effort: 2, freq: 'daily' },
    { id: 'cxtable01', name: 'Set and clear the table', emoji: '🍴', effort: 1, freq: 'daily' },
    { id: 'cxbiscuit', name: 'Feed Biscuit', emoji: '🐶', effort: 1, freq: 'daily', nudge: 'Biscuit is giving you the eyes - dinner time' },
    { id: 'cxlaundry', name: 'Laundry', emoji: '🧺', effort: 3, freq: 'often' },
    { id: 'cxbins001', name: 'Take the bins out', emoji: '🗑️', effort: 2, freq: 'weekly', nudge: 'the bins go out tonight' },
    { id: 'cxbathrm1', name: 'Clean the bathroom', emoji: '🛁', effort: 4, freq: 'weekly' },
    { id: 'cxvacuum1', name: 'Vacuum', emoji: '🧹', effort: 3, freq: 'weekly' },
    { id: 'cxgrocery', name: 'Grocery shop', emoji: '🛒', effort: 3, freq: 'weekly' },
    { id: 'cxplayrm1', name: 'Tidy the playroom', emoji: '🧸', effort: 1, freq: 'often' },
    { id: 'cxsheets1', name: 'Change the sheets', emoji: '🛏️', effort: 2, freq: 'biweekly' },
  ];
  const LUIS = 'mxluis001';
  const FINISH = { mxmaria01: 1, mxluis001: 0.7, mxsofia01: 0.9, mxmateo01: 0.85 };

  const chance = (s) => C.hash32(s) / 4294967296;

  /** {home, weeks: [current, ...past] newest first, week, today}. */
  function state(now, tz) {
    const zone = C.cleanTz(tz || 'UTC');
    const week = C.weekKey(now, zone);
    const today = C.dayIndex(now, zone);
    const first = C.addWeeks(week, -4);
    const home = {
      name: 'The Garcias', tz: zone, me: ME,
      members: MEMBERS.map((m) => Object.assign({}, m, { cant: m.cant.slice(), dislikes: m.dislikes.slice() })),
      chores: CHORES.map((c) => Object.assign({ start: first }, c)),
    };
    const docs = [];
    for (let i = 4; i >= 0; i--) {
      const wk = C.addWeeks(week, -i);
      const d = C.deal(home, wk, docs.slice().reverse(), {});
      const doc = { week: wk, basis: d.basis, assign: d.assign, ticks: {}, swaps: {} };
      const at = (day) => new Date(Date.parse(C.dayDate(wk, day === null ? 3 : day) + 'T18:30:00Z')).toISOString();
      for (const s of C.weekSlots(home.chores, wk)) {
        const holder = doc.assign[s.id];
        if (!holder) continue;
        const r = chance(wk + s.id);
        // This week: only what is already behind us, and some of today.
        if (i === 0) {
          if (s.day === null ? r > 0.45 : s.day > today || (s.day === today && r < 0.5)) continue;
        }
        if (r < FINISH[holder]) { doc.ticks[s.id] = { who: holder, by: holder, pts: s.pts, at: at(s.day) }; continue; }
        if (holder === LUIS && chance('pick' + wk + s.id) < 0.75) {
          doc.swaps[s.id] = { from: LUIS, to: ME, state: 'claimed', at: at(s.day) };
          doc.ticks[s.id] = { who: ME, by: ME, pts: s.pts, at: at(s.day) };
        }
      }
      if (i === 0) {
        // Luis is offering one of his - the board shows it up for grabs.
        // A weekly one if he has one, else his next one coming up.
        const rank = (x) => (x.day === null ? -1 : x.day >= today ? x.day : 99);
        const his = C.weekSlots(home.chores, wk).filter((x) => doc.assign[x.id] === LUIS && !doc.ticks[x.id] && !doc.swaps[x.id]).sort((a, b) => rank(a) - rank(b));
        if (his[0]) doc.swaps[his[0].id] = { from: LUIS, state: 'offered', at: new Date(now - 3600000).toISOString() };
      }
      docs.push(doc);
    }
    return { home, weeks: docs.reverse(), week, today };
  }

  return { state, ME };
});
