/* Pickup - the example group, "Thursday Hoops": sixteen regulars, basketball
 * on Thursdays at 7pm, a $60 court split among whoever plays.
 *
 * It is not a fixture. Every week of it is PLAYED BY THE REAL RULES in
 * pickup-core.js: answers go through `rsvp` (so the waitlist and the
 * "Lena's in - Jo dropped out" line are the app's own), teams through
 * `makeTeams` (so the split/together lines and last week's teams count),
 * results through `addMatch`, votes through `vote`, payments through
 * `markPaid`. Who answers what, and who wins, is a hash of the week and the
 * person - the same example on every phone on the same day. Dates are
 * relative to today in the viewer's zone: this week's game is the next
 * Thursday 7pm still to come, and the six before it are the season so far.
 *
 * Two people still owe for the court (Ben for two weeks, Nina for one), so
 * the Money tab has something to chase. UMD: window.PickupSample in the
 * page, require() in the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pickup-core'));
  else root.PickupSample = factory(root.PickupCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // [id, name, emoji, self-rated skill, host's quiet adjustment, position]
  const PEOPLE = [
    ['malex0001', 'Alex', '🦊', 3, null, ''],
    ['msam00001', 'Sam', '🐻', 5, null, 'big'],
    ['mjo000001', 'Jo', '🐯', 4, null, ''],
    ['mmia00001', 'Mia', '🦉', 4, null, ''],
    ['mpriya001', 'Priya', '🐝', 3, null, ''],
    ['mtom00001', 'Tom', '🐳', 2, null, ''],
    ['mdev00001', 'Dev', '🚀', 5, 4, 'big'],
    ['mlena0001', 'Lena', '🦋', 3, null, ''],
    ['mkai00001', 'Kai', '⚡', 4, null, ''],
    ['mravi0001', 'Ravi', '🐢', 2, null, ''],
    ['mola00001', 'Ola', '🌻', 3, null, ''],
    ['mben00001', 'Ben', '🐼', 3, null, ''],
    ['mchris001', 'Chris', '🎸', 1, 2, ''],
    ['mnina0001', 'Nina', '🌵', 4, null, ''],
    ['momar0001', 'Omar', '🎯', 3, null, 'big'],
    ['mzoe00001', 'Zoe', '🔥', 2, null, ''],
  ];
  const HOST = 'malex0001';
  const H = 3600 * 1000;

  function seeded(seed) {
    let s = C.hash32(seed) || 1;
    return (n) => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s % n; };
  }

  function base(tz) {
    return {
      name: 'Thursday Hoops', sport: 'basketball', tz, cur: 'USD',
      sched: { wd: 3, time: '19:00', place: 'Riverside Rec Center', cap: 10, cost: 6000 },
      members: PEOPLE.map(([id, name, emoji, skill, adj, pos]) => ({ id, name, emoji, skill, adj, pos, host: id === HOST })),
      lines: [{ a: 'msam00001', b: 'mjo000001', k: 'apart' }, { a: 'mmia00001', b: 'mpriya001', k: 'together' }],
      collector: HOST,
      games: {},
    };
  }

  /** The example group at `now`, in the viewer's zone. */
  function state(now, tz) {
    const zone = C.cleanTz(tz);
    const rand = seeded('thursday hoops');
    const g = C.cleanGroup(base(zone), { tz: zone, rand });
    const actor = { mid: HOST, host: true };
    const apply = (r) => { C.applyPatch(g, r.patch); return r; };
    const ctx = (at) => ({ now: at, rand, actor });

    // This week's game: the next Thursday 7pm still to come; the season is
    // the six Thursdays before it.
    let date = C.onOrAfter(C.localDate(now, zone), 3);
    if (C.zonedMs(date, '19:00', zone) <= now) date = C.addDays(date, 7);
    const dates = [];
    for (let i = 6; i >= 1; i--) dates.push(C.addDays(date, -7 * i));

    dates.forEach((d, w) => {
      const gid = C.gameIdFor(d);
      g.games[gid] = C.newGame(g, d, 0);
      const ko = C.kickoff(g, g.games[gid]);
      // Answers over the two days before: most regulars, most weeks. The
      // keen ones answer first (Ben and Nina were keen the weeks they owe).
      const keen = (id) => id === 'msam00001' || id === 'mmia00001' || id === 'mpriya001' || id === HOST || (id === 'mben00001' && w >= 4) || (id === 'mnina0001' && w === 5);
      const order = PEOPLE.map((p) => p[0]).sort((a, b) => keen(b) - keen(a) || C.hash32(d + a) - C.hash32(d + b));
      order.forEach((id, i) => {
        const h = C.hash32('a' + d + id) % 100;
        const a = keen(id) || h < 62 ? 'in' : h < 78 ? 'out' : 'maybe';
        apply(C.rsvp(g, gid, id, a, ctx(ko - 48 * H + i * 2 * H)));
      });
      if (w === 2) apply(C.addGuest(g, gid, { name: 'Marcus', by: 'mkai00001', skill: 4 }, ctx(ko - 10 * H)));
      apply(C.makeTeams(g, gid, { sides: 2 }, ctx(ko - 2 * H)));
      // Three or four games to 11, won by whichever side the hash and the
      // skill favour.
      const game = g.games[gid];
      const sums = C.teamSums(g, game);
      const n = 3 + (C.hash32('n' + d) % 2);
      for (let i = 0; i < n; i++) {
        const edge = (sums[0] - sums[1]) * 6 + (C.hash32('m' + d + i) % 40) - 20;
        const lose = 4 + (C.hash32('s' + d + i) % 7);
        apply(C.addMatch(g, gid, edge >= 0 ? { a: 0, b: 1, sa: 11, sb: lose } : { a: 0, b: 1, sa: lose, sb: 11 }, ctx(ko + (i + 1) * 25 * 60 * 1000)));
      }
      // Player of the Week: most voters pick from the winning side.
      const played = C.playedIds(g, game).filter((id) => C.memberOf(g, id));
      const wins = [0, 0];
      for (const m of C.matchList(game)) if (m.w === 'a') wins[m.a]++; else if (m.w === 'b') wins[m.b]++;
      const top = game.teams.sides[wins[0] >= wins[1] ? 0 : 1].filter((id) => C.memberOf(g, id));
      const star = top[C.hash32('star' + d) % Math.min(3, top.length)];
      const fresh = now < ko + C.VOTE_HOURS * H; // last week's vote may still be open: Alex's is left to the visitor
      played.forEach((v, i) => {
        if (C.hash32('v' + d + v) % 100 < 15 || (fresh && v === HOST)) return; // not everyone votes
        const cand = v !== star && C.hash32('c' + d + v) % 100 < 65 ? star : top.filter((x) => x !== v)[C.hash32('o' + d + v) % Math.max(1, top.length - 1)];
        if (cand && cand !== v) apply(C.vote(g, gid, v, cand, ctx(ko + 3 * H + i * 60000)));
      });
      // Court money: everyone paid Alex, except Ben (the last two weeks)
      // and Nina (last week).
      const sh = C.shares(g, game);
      for (const payer of Object.keys(sh.owed)) {
        if (payer === HOST) continue;
        if (payer === 'mben00001' && w >= 4) continue;
        if (payer === 'mnina0001' && w === 5) continue;
        apply(C.markPaid(g, gid, payer, true, ctx(ko + 20 * H)));
      }
    });

    // This week: answers over the last four days, Jo drops out (Lena moves
    // up), a +1 joins the waitlist, and the host has made the teams.
    const gid = C.gameIdFor(date);
    g.games[gid] = C.newGame(g, date, 0);
    const ko = C.kickoff(g, g.games[gid]);
    const start = Math.min(now - 3 * H, ko - 60 * H);
    const plan = [
      ['msam00001', 'in'], ['mmia00001', 'in'], ['mpriya001', 'in'], [HOST, 'in'], ['mjo000001', 'in'], ['mdev00001', 'in'],
      ['mkai00001', 'in'], ['mtom00001', 'out'], ['mola00001', 'in'], ['mchris001', 'in'], ['mnina0001', 'in'], ['mlena0001', 'in'],
      ['mzoe00001', 'maybe'], ['mravi0001', 'in'], ['momar0001', 'maybe'],
    ];
    const span = Math.max(H, now - start - H);
    plan.forEach(([id, a], i) => apply(C.rsvp(g, gid, id, a, ctx(start + Math.floor((span * i) / (plan.length + 3))))));
    apply(C.rsvp(g, gid, 'mjo000001', 'out', ctx(start + Math.floor((span * (plan.length + 1)) / (plan.length + 3)))));
    apply(C.addGuest(g, gid, { name: 'Marcus', by: 'mkai00001', skill: 4 }, ctx(start + Math.floor((span * (plan.length + 2)) / (plan.length + 3)))));
    apply(C.makeTeams(g, gid, { sides: 2 }, ctx(now - H)));
    return g;
  }

  return { state, HOST, PEOPLE };
});
