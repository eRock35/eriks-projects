// A sample book, written by hand, for people who have not signed up.
//
// No app on this domain makes a model call for a signed-out visitor, so the
// way to show what Chaser does is a real-looking book run through the real
// arithmetic: the same todayView(), scorecards() and lateFee() a signed-in
// person's data goes through, so the demo cannot drift from the product. The
// sample chase drafts are the template writer's (lib/ladder.js) - pre-written
// words, no model.
//
// The studio, the clients and the numbers are invented. Dates are relative to
// today so the sample never reads as last spring's.

const B = require('./book');
const L = require('./ladder');

const SETTINGS = {
  ...B.SETTINGS_DEFAULTS,
  businessName: 'Northlight Studio',
  yourName: 'Maya',
  signOff: 'Thanks so much,',
  tone: 30,
  paymentLink: 'https://pay.example/northlight',
  paymentInstructions: '',
  contact: 'hello@northlight.example',
  currency: 'USD',
  termsDays: 30,
  lateFee: { mode: 'percent', flatCents: 2500, pctPerMonth: 1.5, graceDays: 7 },
};

const CLIENTS = [
  { id: 'demo-c1', contactName: 'Dana Price', name: 'Brightwater Dental', email: 'accounts@brightwater.example', phone: '(555) 010-4411' },
  { id: 'demo-c2', contactName: 'Tom Keller', name: 'Ridgeline Outfitters', email: 'ap@ridgeline.example', phone: '(555) 010-2207' },
  { id: 'demo-c3', contactName: 'June Okafor', name: 'Juniper & Co. Bakery', email: 'hello@juniperbakery.example', phone: '(555) 010-3310' },
  { id: 'demo-c4', contactName: 'Priya Shah', name: 'Atlas Property Group', email: 'payables@atlaspg.example', phone: '' },
  { id: 'demo-c5', contactName: 'Leah Moreno', name: 'Sol Yoga Collective', email: 'sol@solyoga.example', phone: '(555) 010-8800' },
  { id: 'demo-c6', contactName: 'Marcus Webb', name: 'Parkside Legal', email: 'finance@parksidelegal.example', phone: '' },
];

// [id, client, number, dollars, issued (days from today), due, extra]
function book(today) {
  const d = (n) => B.addDays(today, n);
  const at = (n) => `${d(n)}T15:00:00.000Z`;
  const pay = (id, dollars, day) => ({ id, cents: Math.round(dollars * 100), date: d(day), note: '' });
  const ch = (kind, day) => ({ kind, at: at(day), channel: 'email', source: 'template', subject: '' });
  const inv = (id, clientId, number, dollars, issued, due, x = {}) => {
    const out = {
      id, clientId, number, amountCents: Math.round(dollars * 100), currency: 'USD',
      issued: d(issued), due: d(due), terms: 'Net 30', notes: x.notes || '', payments: x.payments || [],
      chases: x.chases || [], promises: x.promises || [], stage: (x.chases || []).filter((c) => c.kind !== 'plan').length,
      paused: false, writtenOff: Boolean(x.writtenOff), createdAt: at(issued), updatedAt: at(0),
    };
    out.lastChasedAt = out.chases.length ? out.chases[out.chases.length - 1].at : null;
    return out;
  };
  return [
    inv('demo-i1', 'demo-c1', 'NL-1041', 1850, -75, -45, { notes: 'Website care plan, Q2', payments: [pay('p1', 1850, -45)] }),
    inv('demo-i2', 'demo-c1', 'NL-1052', 1850, -45, -15, { notes: 'Website care plan, Q3', payments: [pay('p2', 1850, -16)] }),
    inv('demo-i3', 'demo-c1', 'NL-1063', 2100, -12, 18, { notes: 'New patient brochure' }),
    inv('demo-i4', 'demo-c2', 'NL-1033', 5200, -75, -45, { notes: 'Autumn catalogue design', chases: [ch('nudge', -40), ch('followup', -30)] }),
    inv('demo-i5', 'demo-c2', 'NL-0990', 3100, -150, -120, { notes: 'Spring lookbook', chases: [ch('nudge', -115), ch('followup', -104)], payments: [pay('p5', 3100, -98)] }),
    inv('demo-i6', 'demo-c2', 'NL-0961', 450, -210, -180, { notes: 'Trade-show banner rush fee', writtenOff: true, chases: [ch('nudge', -170), ch('followup', -160), ch('firm', -150), ch('final', -140)] }),
    inv('demo-i7', 'demo-c3', 'NL-1049', 640, -40, -10, { notes: 'Menu boards', chases: [ch('nudge', -8)], promises: [{ date: d(3), note: 'Said Friday, after the farmers market', at: at(-2) }] }),
    inv('demo-i8', 'demo-c4', 'NL-1044', 2800, -48, -18, { notes: 'Leasing brochure', chases: [ch('nudge', -14), ch('followup', -7)], promises: [{ date: d(-4), note: 'Promised on the phone', at: at(-6) }] }),
    inv('demo-i9', 'demo-c5', 'NL-1055', 380, -33, -3, { notes: 'Class schedule posters' }),
    inv('demo-i10', 'demo-c5', 'NL-1027', 380, -63, -33, { notes: 'Instagram templates', chases: [ch('nudge', -6)], payments: [pay('p10', 380, 0)] }),
    inv('demo-i11', 'demo-c6', 'NL-1060', 9600, -20, 10, { notes: 'Rebrand, milestone 2 of 3' }),
    inv('demo-i12', 'demo-c6', 'NL-0975', 6400, -120, -90, {
      notes: 'Rebrand, milestone 1 of 3',
      chases: [ch('nudge', -85), ch('followup', -76), ch('firm', -60), ch('final', -45)],
      payments: [pay('p12a', 3200, -40), pay('p12b', 3200, -26)],
    }),
    inv('demo-i13', 'demo-c4', 'NL-1002', 1200, -92, -62, { notes: 'Signage refresh', payments: [pay('p13', 1200, -55)] }),
  ];
}

/** The whole sample, computed per request. */
function demo(today = B.utcToday()) {
  const invoices = book(today);
  const view = B.todayView(invoices, CLIENTS, SETTINGS, today);
  const ds = B.deriveAll(invoices, today);
  const cards = B.scorecards(CLIENTS, ds, SETTINGS.currency);
  const byClient = B.indexClients(CLIENTS);
  const details = ds.map((x) => ({
    ...B.row(x, byClient),
    notes: x.notes,
    terms: x.terms,
    payments: x.payments,
    chases: x.chases,
    promises: x.promises,
    lateFee: B.lateFee(x, SETTINGS.lateFee, today),
  }));
  const drafts = {};
  for (const x of ds.filter((y) => y.status === 'open' || y.status === 'promised')) {
    const f = L.factsFor(x, byClient[x.clientId], SETTINGS, today, { kind: x.nextKind });
    drafts[x.id] = { ...L.template(f), kind: f.kind, kindLabel: f.kindLabel, source: 'sample', to: { email: byClient[x.clientId].email, phone: byClient[x.clientId].phone } };
  }
  return {
    demo: true,
    settings: { businessName: SETTINGS.businessName, yourName: SETTINGS.yourName, currency: SETTINGS.currency, lateFee: SETTINGS.lateFee, tone: SETTINGS.tone },
    today: view,
    clients: cards,
    invoices: details,
    drafts,
    badges: B.BADGES.map((b) => ({ ...b, earned: B.earnedBadges(ds, today).has(b.key) })),
  };
}

module.exports = { demo, SETTINGS, CLIENTS, book };
