/* Arrivals - the made-up example: Thanksgiving at Mom's.
 *
 * Six invented people on their way to one invented house near Chicago, the
 * Wednesday before Thanksgiving, as the page would show it at 1:20 in the
 * afternoon. Airport codes and station names are real places; every person,
 * flight number and time is invented. It is drawn by the same code as a
 * real gathering and changed by the same one door (ArrivalsCore.act), in
 * memory only: nothing in it is kept, sent or synced.
 *
 * Planted, so the example shows what the app is for:
 *   - Leo landed this morning and is here; Rosa (Mom) drove.
 *   - Ana and the two kids (car seat) land at ORD at 3:10 with no ride yet;
 *     Ben lands at ORD at 3:35 and Sam - "you" - is down to get him: one
 *     run could get both.
 *   - Grandpa Joe's train pulls in at Union Station at 3:25 with no ride:
 *     a different place within the hour, which takes a second driver.
 *   - Priya and Dev are driving up; Mei flies in Thursday morning, delayed
 *     40 minutes, making her own way.
 *   - Sunday: Ana's and Ben's flights home leave ORD 25 minutes apart.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./arrivals-core'));
  else root.ArrivalsDemo = factory(root.ArrivalsCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var TZ = 'America/Chicago';
  var NOW = C.zonedToUtc('2026-11-25T13:20', TZ);
  var ME = 'msam2222';
  var NOTICE = 'This is a made-up family. Tap anything - nothing is kept or sent.';

  function trip(o) {
    var t = C.cleanTrip(o, { from: '2026-11-25', to: '2026-11-29', tz: TZ }, null);
    t.status = o.status || 'sched'; t.delay = o.delay || 0;
    if (o.ride) t.ride = o.ride;
    t.by = o.by || 'mrosa111'; t.ts = NOW;
    return t;
  }
  function doc() {
    return {
      id: 'demo', code: 'TURKEY', title: 'Thanksgiving at Mom’s', place: 'Mom’s house', from: '2026-11-25', to: '2026-11-29', tz: TZ, v: 1,
      members: {
        mrosa111: { name: 'Rosa', c: 1, host: true, joinedAt: '2026-11-20T10:00:00.000Z' },
        msam2222: { name: 'Sam', c: 0, joinedAt: '2026-11-20T10:05:00.000Z' },
        mana3333: { name: 'Ana', c: 2, joinedAt: '2026-11-20T11:00:00.000Z' },
        mben4444: { name: 'Ben', c: 3, joinedAt: '2026-11-21T09:00:00.000Z' },
        mmei5555: { name: 'Mei', c: 4, joinedAt: '2026-11-21T12:00:00.000Z' },
      },
      trips: {
        tleo1111a: trip({ who: 'Uncle Leo', mode: 'flight', from: 'Phoenix', carrier: 'WN', number: '918', hub: 'MDW', local: '2026-11-25T11:05', bags: 1, status: 'here', ride: { k: 'driver', mid: 'mrosa111' } }),
        tana2222a: trip({ who: 'Ana + the kids', mode: 'flight', from: 'Denver', carrier: 'UA', number: '1482', hub: 'ORD', local: '2026-11-25T15:10', party: 3, bags: 2, seat: true, note: 'Door 3, lower level', status: 'way', by: 'mana3333' }),
        tben3333a: trip({ who: 'Ben', mode: 'flight', from: 'Atlanta', carrier: 'DL', number: '2210', hub: 'ORD', local: '2026-11-25T15:35', bags: 1, by: 'mben4444', ride: { k: 'driver', mid: 'msam2222' } }),
        tjoe4444a: trip({ who: 'Grandpa Joe', mode: 'train', from: 'St. Louis', carrier: 'Amtrak', number: '302', hub: 'Union Station', local: '2026-11-25T15:25', bags: 1, note: 'Meet him inside, by the big clock' }),
        tpri5555a: trip({ who: 'Priya + Dev', mode: 'car', from: 'Minneapolis', local: '2026-11-25T18:30', party: 2, status: 'way' }),
        tmei6666a: trip({ who: 'Mei', mode: 'flight', from: 'Boston', carrier: 'AA', number: '2374', hub: 'ORD', local: '2026-11-26T09:15', delay: 40, own: true, by: 'mmei5555' }),
        tana7777a: trip({ dir: 'out', who: 'Ana + the kids', mode: 'flight', from: 'Denver', carrier: 'UA', number: '1483', hub: 'ORD', local: '2026-11-29T16:45', party: 3, bags: 2, seat: true, by: 'mana3333' }),
        tben8888a: trip({ dir: 'out', who: 'Ben', mode: 'flight', from: 'Atlanta', carrier: 'DL', number: '2215', hub: 'ORD', local: '2026-11-29T17:10', bags: 1, by: 'mben4444' }),
      },
    };
  }

  return { TZ: TZ, NOW: NOW, ME: ME, NOTICE: NOTICE, doc: doc };
}));
