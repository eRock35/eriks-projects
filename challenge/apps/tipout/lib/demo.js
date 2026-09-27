// The sample: an invented bar, The Copper Fox, closing an invented Friday
// dinner shift - run through the real rules, with no account and no model
// call. Every name is a made-up first name and every number is made up; the
// shape is a realistic mid-size bar: nine people on; the kitchen gets 3% of
// food sales and the busser 8% of the tips off the top, then servers,
// bartenders and the host split the rest by points × hours. $1,601.60 in tips
// on $4,920 of food.
//
// Dana, the floor supervisor, is on the roster but not on tonight's shift.
// Tick her in and the fairness heads-up appears - the sample is there to be
// played with.

const R = require('../public/rules');

const ROLES = [
  { key: 'server', name: 'Server', pts: 100 },
  { key: 'bartender', name: 'Bartender', pts: 120 },
  { key: 'busser', name: 'Busser', pts: 50 },
  { key: 'host', name: 'Host', pts: 40 },
  { key: 'kitchen', name: 'Kitchen', pts: 100 },
  { key: 'supervisor', name: 'Floor supervisor', pts: 100, manager: true },
];

const PEOPLE = [
  { id: 'pmaya', name: 'Maya', role: 'server' },
  { id: 'pjordan', name: 'Jordan', role: 'server' },
  { id: 'ppriya', name: 'Priya', role: 'server' },
  { id: 'pluis', name: 'Luis', role: 'bartender' },
  { id: 'psam', name: 'Sam', role: 'bartender' },
  { id: 'pana', name: 'Ana', role: 'busser' },
  { id: 'ptheo', name: 'Theo', role: 'host' },
  { id: 'pmarco', name: 'Marco', role: 'kitchen' },
  { id: 'pkeisha', name: 'Keisha', role: 'kitchen' },
  { id: 'pdana', name: 'Dana', role: 'supervisor' },
];

const SETUP = {
  method: 'tipout',
  restBy: 'points',
  cashDollars: true,
  roles: ROLES,
  tipouts: [{ to: 'kitchen', bp: 300, of: 'sales' }, { to: 'busser', bp: 800, of: 'tips' }],
  people: PEOPLE,
};

// Tonight: who worked and for how long.
const TONIGHT = {
  card: '1284.60', cash: '317.00', sales: '4920.00',
  hours: { pmaya: 6.5, pjordan: 7, ppriya: 5.5, pluis: 8, psam: 5, pana: 6, ptheo: 5, pmarco: 8, pkeisha: 7.5 },
  // $317 counted out of the tip jar and the servers' cash: nine $20s, six
  // $10s, nine $5s and thirty-two $1s.
  drawer: { 2000: 9, 1000: 6, 500: 9, 100: 32 },
};

// The rest of the week, Tuesday to Sunday (Monday the bar is closed).
const WEEK = [
  { dow: 1, part: 'dinner', card: '612.40', cash: '141.00', sales: '2410.00', hours: { pmaya: 6, pjordan: 5.5, pluis: 7, pana: 5, ptheo: 4.5, pmarco: 7 } },
  { dow: 2, part: 'dinner', card: '698.15', cash: '162.00', sales: '2785.50', hours: { pjordan: 6, ppriya: 6, psam: 7, pana: 5.5, ptheo: 4, pkeisha: 7 } },
  { dow: 3, part: 'dinner', card: '904.80', cash: '208.00', sales: '3560.00', hours: { pmaya: 6.5, ppriya: 6, pluis: 7.5, psam: 5, pana: 6, ptheo: 5, pmarco: 8 } },
  { dow: 5, part: 'dinner', card: '1391.25', cash: '356.00', sales: '5210.75', hours: { pmaya: 7, pjordan: 7, ppriya: 6.5, pluis: 8, psam: 6.5, pana: 6.5, ptheo: 5.5, pmarco: 8, pkeisha: 8 } },
  { dow: 6, part: 'brunch', card: '488.90', cash: '96.00', sales: '1940.00', hours: { pjordan: 5, ppriya: 5, psam: 5, pana: 4.5, pkeisha: 6 } },
];

/** The most recent Friday on or before `today`. */
function lastFriday(today) {
  const d = new Date(`${today}T00:00:00Z`).getUTCDay();
  return R.addDays(today, -((d - 5 + 7) % 7));
}

function shiftInput(date, part, n) {
  const byId = Object.fromEntries(PEOPLE.map((p) => [p.id, p]));
  return {
    date,
    part,
    card: n.card,
    cash: n.cash,
    sales: n.sales,
    crew: Object.keys(n.hours).map((pid) => ({ pid, name: byId[pid].name, role: byId[pid].role, hours: n.hours[pid] })),
    drawer: n.drawer || null,
    rules: { method: SETUP.method, restBy: SETUP.restBy, cashDollars: SETUP.cashDollars, roles: ROLES, tipouts: SETUP.tipouts },
  };
}

function build(today) {
  const friday = lastFriday(today);
  const monday = R.weekStart(friday);
  const tonight = shiftInput(friday, 'dinner', TONIGHT);
  const v = R.validateShift(tonight, null);
  if (v.error) throw new Error(`demo: ${v.error}`);
  const result = R.split(v.shift);
  const items = [{ id: 'demo-fri', shift: v.shift, result }];
  for (const w of WEEK) {
    // A sample night later than today would be a shift from the future.
    if (R.addDays(monday, w.dow) > today) continue;
    const x = R.validateShift(shiftInput(R.addDays(monday, w.dow), w.part, w), null);
    if (x.error) throw new Error(`demo: ${x.error}`);
    items.push({ id: `demo-${w.dow}`, shift: x.shift, result: R.split(x.shift) });
  }
  return { friday, monday, tonight, shift: v.shift, result, items };
}

/** What GET /api/demo answers: the setup, tonight's inputs and the week. */
function demo(today) {
  const b = build(today);
  const setup = R.validateSetup(SETUP).setup;
  return {
    demo: true,
    venue: 'The Copper Fox',
    setup,
    tonight: { ...b.tonight, rules: undefined },
    result: b.result,
    envelopes: R.envelopesFor(b.result, b.shift.drawer),
    week: R.week(b.items, b.monday),
    shifts: b.items.map((it) => ({
      id: it.id, date: it.shift.date, part: it.shift.part, total: it.result.totalIn, card: it.result.card, cash: it.result.cash,
      people: it.result.people.length, hours: R.hoursText(it.shift.crew.reduce((s, p) => s + p.q, 0)), shared: false, headsUp: false,
    })).sort((a, c) => (a.date < c.date ? 1 : -1)),
    items: b.items.map((it) => ({ id: it.id, shift: it.shift })),
  };
}

module.exports = { demo, build, SETUP, TONIGHT, PEOPLE, ROLES, lastFriday };
