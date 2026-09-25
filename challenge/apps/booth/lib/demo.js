// The sample show a signed-out visitor sees. Everything here is INVENTED:
// Brightline Coffee Roasters, the Southeast Food & Bev Expo 2026, its three
// staff and its twenty visitors are fictional, every email is @example.com
// and every phone is a 555-01xx number, which the North American plan keeps
// for fiction.
//
// No model call, ever. The leads are hand-written with times relative to
// "now", then run through the real rules - the clocks, the going-cold list,
// the leaderboard and the scorecard come out of the same code as a real
// show's. The two drafted follow-ups are hand-written too, and pass through
// the real draft validator; the tests assert it removes nothing from them.

const B = require('../public/rules');
const E = require('./events');
const ai = require('./ai');

const H = B.HOUR;

const MEMBERS = [
  { uid: 'demo-maya', name: 'Maya', role: 'owner', signoff: 'Maya Okafor · Brightline Coffee Roasters', tone: 'friendly' },
  { uid: 'demo-theo', name: 'Theo', role: 'staff', signoff: 'Theo · Brightline Coffee Roasters', tone: 'direct' },
  { uid: 'demo-priya', name: 'Priya', role: 'staff', signoff: 'Priya Nair · Brightline Coffee Roasters', tone: 'warm' },
];

const CHIPS = ['Wholesale', 'Samples', 'Café program', 'Private label', 'Pricing'];

// [id, name, company, title, temp, chips, next, note, by, hoursAgo, follow-up]
// follow-up: { sent: hours after capture, replied, booked, won, lost, value }
const ROWS = [
  ['d01', 'Dana Whitfield', 'Magnolia Market Co-op', 'Grocery Buyer', 'hot', ['Wholesale', 'Samples'], 'quote', 'Wants 5 lb bags for 3 stores. Asked about decaf.', 'demo-maya', 70, { sent: 3, replied: true, booked: true, won: true, value: 4800 }],
  ['d02', 'Marcus Lee', 'Two Rivers Café', 'Owner', 'hot', ['Café program', 'Pricing'], 'demo', 'Opening a second location in spring. Needs barista training.', 'demo-theo', 69, { sent: 0.5, replied: true, booked: true, value: 6000 }],
  ['d03', 'Elena Rossi', 'Peachtree Bakehouse', 'Head Baker', 'warm', ['Wholesale'], 'info', 'Uses a medium roast for cold brew now.', 'demo-priya', 68, { sent: 20 }],
  ['d04', 'Jamal Carter', 'Sunbelt Office Supply', 'Facilities Manager', 'warm', ['Café program'], 'call', 'Office coffee for 120 staff.', 'demo-theo', 67, { sent: 30, replied: true, value: 2400 }],
  ['d05', 'Grace Kim', 'Hive Coworking', 'Community Lead', 'hot', ['Café program', 'Samples'], 'demo', 'Wants a tasting for members.', 'demo-priya', 66, { sent: 5, replied: true, booked: true, won: true, value: 1900 }],
  ['d06', 'Owen Price', 'Lakeside Grill', 'Chef', 'cold', [], 'info', 'Happy with current supplier - just browsing.', 'demo-maya', 65, null],
  ['d07', 'Sofia Alvarez', 'Casa Verde Market', 'Owner', 'hot', ['Private label'], 'quote', 'Private label for two blends.', 'demo-theo', 64, null],
  ['d08', 'Ben Hollis', 'Hollis & Sons Deli', 'Owner', 'warm', ['Wholesale', 'Pricing'], 'quote', 'Price sensitive. Compare with his current roaster.', 'demo-maya', 62, { sent: 50 }],
  ['d09', 'Nadia Petrova', 'Riverbend Books & Brew', 'Manager', 'warm', ['Samples'], 'info', '', 'demo-priya', 60, null],
  ['d10', 'Luis Moreno', 'Southern Rail Catering', 'Operations Director', 'hot', ['Wholesale', 'Pricing'], 'call', 'Caters about 40 events a month.', 'demo-maya', 50, null],
  ['d11', 'Hannah Brooks', 'Brooks Family Farm Stand', 'Owner', 'cold', ['Private label'], 'info', '', 'demo-theo', 49, { sent: 26, lost: true }],
  ['d12', 'Kevin O’Neil', 'Cornerstone Community Café', 'Volunteer Coordinator', 'warm', ['Café program'], 'call', 'Sunday coffee after services.', 'demo-priya', 47, { sent: 10 }],
  ['d13', 'Aisha Bello', 'Gather Kitchen', 'Co-founder', 'hot', ['Samples', 'Café program'], 'demo', 'Very keen - wants a tasting for her team.', 'demo-priya', 46, null],
  ['d14', 'Tom Becker', 'Becker Hardware', 'Owner', 'cold', [], '', '', 'demo-theo', 45, null],
  ['d15', 'Mei Tanaka', 'Lotus Tea House', 'Owner', 'warm', ['Wholesale'], 'quote', 'Adding coffee to a tea menu.', 'demo-maya', 44, null],
  ['d16', 'Chris Duval', 'Parkside Hotel', 'Food & Beverage Manager', 'hot', ['Café program', 'Wholesale', 'Pricing'], 'call', 'Breakfast service, 180 rooms. Decides this quarter.', 'demo-theo', 44.5, { value: 8000 }],
  ['d17', 'Rosa Jimenez', 'Jimenez Panadería', 'Owner', 'warm', ['Samples'], 'info', '', 'demo-priya', 43, { sent: 2, replied: true }],
  ['d18', 'Derek Walsh', 'Walsh Fitness', 'Studio Owner', 'cold', [], '', '', 'demo-maya', 42, null],
  ['d19', 'Lina Haddad', 'Olive & Fig Market', 'Buyer', 'hot', ['Wholesale', 'Private label'], 'quote', 'Wants pricing on three blends.', 'demo-theo', 26, { value: 3000 }],
  ['d20', 'Sam Whitaker', 'Blue Ridge Outfitters', 'Buyer', 'warm', ['Samples'], 'info', '', 'demo-maya', 24, { sent: 1 }],
];

/** A phone that reads real and is reserved for fiction: 404-555-01xx. */
const phoneFor = (i) => `(404) 555-01${String(10 + i).padStart(2, '0')}`;
const emailFor = (name, company) => `${name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '')}@${company.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 18)}.example.com`;

// Two follow-ups a rep might have drafted, written by hand. They only use
// what the lead carries - the validator is run on them to prove it.
const DRAFTS = {
  d13: {
    subject: 'A tasting for the Gather Kitchen team',
    body: 'Hi Aisha,\n\nIt was great to meet you at our booth at the Southeast Food & Bev Expo 2026 - thanks for giving the samples a try.\n\nYou mentioned a tasting for your team, and I would love to set that up. Could you send me two or three times that suit you, and how many people will be there?\n\nThanks,\nPriya Nair · Brightline Coffee Roasters',
  },
  d16: {
    subject: 'Breakfast coffee for the Parkside Hotel',
    body: 'Hi Chris,\n\nGood to talk at the Southeast Food & Bev Expo 2026 about breakfast service at the Parkside.\n\nYou were interested in our café program and wholesale pricing. Is a short call this week possible? Tell me a time that works and I will ring you - [add: your direct number].\n\nTheo · Brightline Coffee Roasters',
  },
};

function build(now) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const iso = (t) => new Date(t).toISOString();
  const event = {
    id: 'sample',
    name: 'Southeast Food & Bev Expo 2026',
    place: 'Hall B, booth 214 (a fictional show)',
    startDate: iso(nowMs - 3 * B.DAY).slice(0, 10),
    endDate: iso(nowMs - 1 * B.DAY).slice(0, 10),
    boothCost: 3200,
    chips: CHIPS,
    company: 'Brightline Coffee Roasters',
  };
  const byUid = Object.fromEntries(MEMBERS.map((m) => [m.uid, m]));
  const leads = ROWS.map((r, i) => {
    const [id, name, company, title, temp, chips, next, note, by, ago, f] = r;
    const at = nowMs - ago * H;
    const l = {
      id, name, company, title, temp, chips, next, note,
      email: i % 5 === 3 ? '' : emailFor(name, company),
      phone: i % 3 === 1 ? '' : phoneFor(i),
      source: i % 4 === 0 ? 'card' : i % 4 === 2 ? 'badge' : 'typed',
      capturedBy: by,
      capturedByName: byUid[by].name,
      capturedAt: iso(at),
      status: 'new',
      value: f && f.value != null ? f.value : null,
    };
    if (f && f.sent != null) {
      const sent = at + f.sent * H;
      Object.assign(l, B.applyStatus(l, 'sent', iso(sent), by));
      if (f.replied) Object.assign(l, B.applyStatus(l, 'replied', iso(sent + 6 * H), by));
      if (f.booked) Object.assign(l, B.applyStatus(l, 'booked', iso(sent + 20 * H), by));
      if (f.won) Object.assign(l, B.applyStatus(l, 'won', iso(Math.min(nowMs - H, sent + 40 * H)), by));
      if (f.lost) Object.assign(l, B.applyStatus(l, 'lost', iso(sent + 12 * H), by));
    }
    l.updatedAt = l.capturedAt;
    return l;
  });
  return { event, leads, nowMs };
}

function demo(now) {
  const { event, leads, nowMs } = build(now);
  const views = leads.map((l) => E.leadView(l, nowMs));
  const members = MEMBERS.map(({ uid, name, role }) => ({ uid, name, role }));
  const sc = B.scorecard(event, leads, nowMs);
  const drafts = {};
  for (const [id, d] of Object.entries(DRAFTS)) {
    const l = leads.find((x) => x.id === id);
    const rep = MEMBERS.find((m) => m.uid === l.capturedBy);
    const v = ai.validateDraft(d, ai.draftSource(event, rep, l), d.subject);
    drafts[id] = { ...v, rep: rep.name };
  }
  return {
    demo: true,
    now: new Date(nowMs).toISOString(),
    event: { ...event, role: 'staff', owner: false, members: members.length },
    members,
    reps: Object.fromEntries(MEMBERS.map((m) => [m.uid, { name: m.name, signoff: m.signoff, tone: m.tone }])),
    leads: views,
    leaderboard: B.leaderboard(members, leads, nowMs, { boothCost: event.boothCost }),
    scorecard: sc,
    goingCold: B.goingCold(leads, nowMs).map((r) => ({ id: r.lead.id, name: r.lead.name, company: r.lead.company, temp: r.lead.temp, capturedByName: r.lead.capturedByName, clock: r.clock })),
    drafts,
  };
}

module.exports = { demo, build, MEMBERS, ROWS, DRAFTS, CHIPS };
