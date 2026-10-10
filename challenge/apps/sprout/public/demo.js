/* The example jungle: fourteen plants across the living room, bedroom,
 * kitchen and bathroom of an invented flat, with real watering histories.
 *
 * Every date is worked out from TODAY (in the viewer's time zone) and the
 * viewer's hemisphere, by the app's own rules: each plant's last drink is
 * placed so that, by SproutCore's own schedule, it lands where the story
 * wants it - Bert the monstera three days late, three more thirsty today,
 * two to feel the soil of tomorrow, one waiting on a "Not yet", two coming
 * up and the rest happy - whatever the month (winter stretches every
 * interval, so the history stretches with it). One was watered twice in
 * four days (Zed the ZZ, who hates that), one was repotted two days ago,
 * one sits in light it doesn't like, and Sir Hiss has learned he drinks
 * less often than the catalogue says. The board, the streaks, the sitter
 * plan and the calendar are the app's own sums over this, never written by
 * hand.
 *
 * Every plant goes through SproutCore.cleanPlant, like a typed one. Played
 * with on this phone only: taps work and are never saved.
 * UMD: window.SproutDemo in the page, require() in the tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sprout-core'));
  else root.SproutDemo = factory(root.SproutCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // id, catalogue id, nickname, room, light where it sits, pot, drainage,
  // and the story: dueIn (days until the next drink is due; negative is
  // late) or lastAgo (days since the last drink), the lateness of the drinks
  // before it (oldest first), and extras.
  const SPECS = [
    { id: 'pxbert0001', cat: 'monstera', nick: 'Bert', room: 'living', light: 2, pot: 'l', drain: true, age: 420, dueIn: -3, past: [0, 0, 1, 0, 0, 0], fedAgo: 41, notes: [[11, 'New leaf unfurling - the biggest one yet 🌱']] },
    { id: 'pxhiss0002', cat: 'snake', nick: 'Sir Hiss', room: 'living', light: 1, pot: 'm', drain: true, age: 610, dueIn: 6, past: [0, 0, 0, 0], interval: 17, notyet: [2, 3] },
    { id: 'pxfigg0003', cat: 'fiddle', nick: 'Figgy', room: 'living', light: 2, pot: 'l', drain: true, age: 300, dueIn: 0, past: [0, 1, 0, 0, 0, 0, 0], moved: [64, 'living', 2, 'Away from the radiator - the brown spots stopped'] },
    { id: 'pxpoll0004', cat: 'pothos', nick: 'Polly', room: 'living', light: 0, pot: 'm', drain: true, age: 500, lastAgo: 2, past: [0, 0, 0, 2, 0], repotAgo: 2 },
    { id: 'pxpear0005', cat: 'pearls', nick: 'Pearl', room: 'living', light: 1, pot: 's', drain: true, age: 90, dueIn: 9, past: [0, 0] },
    { id: 'pxzed00006', cat: 'zz', nick: 'Zed', room: 'bedroom', light: 0, pot: 'm', drain: true, age: 700, lastAgo: 1, gapBefore: 3, past: [0, 0, 0] },
    { id: 'pxlily0007', cat: 'peacelily', nick: 'Lily', room: 'bedroom', light: 1, pot: 'm', drain: true, age: 240, dueIn: 0, past: [0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'pxspid0008', cat: 'spider', nick: 'Spidey', room: 'bedroom', light: 2, pot: 'm', drain: true, age: 380, dueIn: 1, past: [0, 2, 0, 0, 0] },
    { id: 'pxorla0009', cat: 'phalaenopsis', nick: 'Orla', room: 'bedroom', light: 2, pot: 's', drain: true, age: 150, dueIn: 3, past: [0, 0, 0, 0], notes: [[5, 'Flower spike! Do not move her.']] },
    { id: 'pxbasi0010', cat: 'basil', nick: 'Basil Fawlty', room: 'kitchen', light: 3, pot: 's', drain: true, age: 30, dueIn: 0, past: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0] },
    { id: 'pxspik0011', cat: 'cactus', nick: 'Spike', room: 'kitchen', light: 3, pot: 's', drain: true, age: 900, dueIn: 12, past: [0, 0] },
    { id: 'pxmint0012', cat: 'mint', nick: 'Minty', room: 'kitchen', light: 2, pot: 'm', drain: true, age: 60, dueIn: 2, past: [0, 0, 0, 0, 0, 0] },
    { id: 'pxfern0013', cat: 'bostonfern', nick: 'Fernando', room: 'bathroom', light: 1, pot: 'm', drain: true, age: 200, dueIn: 1, past: [0, 0, 0, 0, 0, 0, 0], mists: [1, 3, 6] },
    { id: 'pxcalv0014', cat: 'calathea', nick: 'Calvin', room: 'bathroom', light: 1, pot: 'm', drain: true, age: 330, dueIn: -2, past: [0, 0, 0, 0], interval: 6.72, notyetToday: 2, mists: [2, 5] },
  ];

  function build(today, hemi) {
    const plants = [];
    SPECS.forEach((s, si) => {
      let n = 0;
      const eid = () => 'ed' + si.toString(36).padStart(2, '0') + (n++).toString(36).padStart(4, '0');
      const p = { id: s.id, cat: s.cat, nick: s.nick, room: s.room, light: s.light, pot: s.pot, drain: s.drain, added: C.addDays(today, -s.age), events: [] };
      if (s.interval) p.interval = s.interval;
      const eff = (d) => C.effective(p, d, hemi);
      // The last drink: placed so its due date (by the season at that date)
      // lands on today + dueIn. Where a season boundary leaves no exact day
      // (the interval jumps from 3 to 4), the latest drink due just before
      // is used and a hold carries it to the day the story wants.
      let lw;
      if (s.lastAgo !== undefined) lw = C.addDays(today, -s.lastAgo);
      else {
        const target = C.addDays(today, s.dueIn);
        let near = null;
        for (let k = 1; k <= 130; k++) {
          const cand = C.addDays(target, -k);
          const due = C.addDays(cand, eff(cand));
          if (due === target) { lw = cand; break; }
          if (due < target && !near) near = cand;
        }
        if (!lw) { lw = near; p.hold = { d: target, why: s.dueIn <= 0 ? 'snooze' : 'check' }; }
      }
      // Drinks before it, walking back. Drink k came eff + late(k) days
      // after drink k-1 (eff at the earlier date, so a few rounds settle).
      const late = s.past.concat([s.lastLate || 0]);
      const dates = [lw];
      for (let k = late.length - 1; k >= 1; k--) {
        const later = dates[0];
        let prev;
        if (k === late.length - 1 && s.gapBefore) prev = C.addDays(later, -s.gapBefore);
        else {
          prev = C.addDays(later, -(eff(later) + late[k]));
          for (let r = 0; r < 4; r++) prev = C.addDays(later, -(eff(prev) + late[k]));
        }
        dates.unshift(prev);
      }
      dates.forEach((d, k) => p.events.push({ id: eid(), k: 'water', d, ...(late[k] && !(s.gapBefore && k === late.length - 1) ? { late: late[k] } : {}) }));
      (s.notyet || []).forEach((ago, i) => p.events.push({ id: eid(), k: 'notyet', d: C.addDays(lw, -(ago + i * 20)) }));
      if (s.notyetToday) {
        const when = C.addDays(today, -s.notyetToday);
        p.events.push({ id: eid(), k: 'notyet', d: when });
        p.hold = { d: today, why: 'check' };
      }
      (s.mists || []).forEach((ago) => p.events.push({ id: eid(), k: 'mist', d: C.addDays(today, -ago) }));
      (s.notes || []).forEach(([ago, note]) => p.events.push({ id: eid(), k: 'note', d: C.addDays(today, -ago), note }));
      if (s.moved) p.events.push({ id: eid(), k: 'move', d: C.addDays(today, -s.moved[0]), note: s.moved[3], prev: { room: s.moved[1], light: 3 } });
      if (s.repotAgo !== undefined) p.events.push({ id: eid(), k: 'repot', d: C.addDays(today, -s.repotAgo), note: 'Up a size - roots were circling the pot', prev: { pot: 's' } });
      // Fed recently, except Bert, who is due a feed in the growing season.
      if (C.GROUPS[C.catalogue(s.cat).group].fert) p.events.push({ id: eid(), k: 'fert', d: C.addDays(today, -(s.fedAgo || 12)) });
      plants.push(C.cleanPlant(p, { today }));
    });
    return { settings: { hemi, hemiAuto: true, name: 'Sam' }, plants, demo: true };
  }

  return { build, SPECS };
});
