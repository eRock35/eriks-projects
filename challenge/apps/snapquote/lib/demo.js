// A sample quote, written by hand, for people who have not signed up.
//
// No app on this domain makes a model call for a signed-out visitor, so the
// way to show what a Snapquote looks like is a real one. It is stored in the
// same shape as a quote the model drafted, and served through the same
// `publicView()` a customer's link uses, so it is drawn by the same code and
// cannot drift from what the product actually sends.
//
// The business and the customer are invented. The prices are plausible for a
// US interior repaint in 2026 and are not a promise about anyone's market.

const Q = require('./quote');

const BUSINESS = {
  name: 'Brightline Painting Co.',
  trade: 'painter',
  color: '#0fb58a',
  logo: '🎨',
  phone: '(555) 014-2290',
  email: 'hello@brightline.example',
  license: 'Lic. #PC-448120',
  taxPct: 7.5,
  markupPct: 20,
  hourlyRate: 70,
  terms: '30% deposit to book your dates. Balance due on completion, by card, check or bank transfer.',
  validDays: 30,
};

const QUOTE = {
  number: 'Q-1042',
  title: 'Living room, hallway & stairwell repaint',
  trade: 'painter',
  customer: { name: 'Jordan Rivera', address: '118 Maple Crest Dr' },
  scope: 'We will move and cover furniture, protect floors, and repair the nail holes and hairline cracks in the living room, hallway and stairwell. Walls get a stain-blocking spot prime and two full coats of a scrubbable eggshell in your chosen color. We clean up every evening, and on the last day we walk the rooms with you before we call it done.',
  items: [
    { id: 'demo1', description: 'Move & cover furniture, mask floors and fixtures', category: 'labor', qty: 3, unit: 'hr', unitPrice: 70 },
    { id: 'demo2', description: 'Patch nail holes & cracks, sand, spot-prime', category: 'labor', qty: 5, unit: 'hr', unitPrice: 70 },
    { id: 'demo3', description: 'Walls, 2 coats - approx. 860 sq ft', category: 'labor', qty: 16, unit: 'hr', unitPrice: 70 },
    { id: 'demo4', description: 'Scrubbable eggshell, premium line', category: 'material', qty: 6, unit: 'gal', unitPrice: 54 },
    { id: 'demo5', description: 'Stain-blocking primer', category: 'material', qty: 1, unit: 'gal', unitPrice: 38 },
    { id: 'demo6', description: 'Stair scaffold plank & ladder rental', category: 'equipment', qty: 2, unit: 'day', unitPrice: 45 },
    { id: 'demo7', description: 'Tape, plastic, filler & sundries', category: 'material', qty: 1, unit: 'lot', unitPrice: 60 },
  ],
  tiers: [
    { key: 'good', label: 'Walls', summary: 'Every wall refreshed in a tough, wipeable finish.', items: [] },
    { key: 'better', label: 'Walls + trim', summary: 'Adds baseboards, door frames and the stair stringer in satin enamel - the crisp, finished look.', items: [
      { id: 'demo8', description: 'Baseboards, 6 door frames & stair stringer', category: 'labor', qty: 9, unit: 'hr', unitPrice: 70 },
      { id: 'demo9', description: 'Satin trim enamel', category: 'material', qty: 2, unit: 'gal', unitPrice: 62 },
    ] },
    { key: 'best', label: 'Walls, trim + ceilings', summary: 'Everything in Better, plus bright new ceilings throughout. Looks like a new house.', items: [
      { id: 'demo8', description: 'Baseboards, 6 door frames & stair stringer', category: 'labor', qty: 9, unit: 'hr', unitPrice: 70 },
      { id: 'demo9', description: 'Satin trim enamel', category: 'material', qty: 2, unit: 'gal', unitPrice: 62 },
      { id: 'demo10', description: 'Ceilings, flat white, 2 coats', category: 'labor', qty: 8, unit: 'hr', unitPrice: 70 },
      { id: 'demo11', description: 'Ceiling paint', category: 'material', qty: 3, unit: 'gal', unitPrice: 44 },
    ] },
  ],
  assumptions: [
    'Walls are drywall in sound condition; no water damage behind the cracks.',
    'One wall color throughout; an accent wall is $120 extra.',
    'Clear access 8am-5pm on work days.',
  ],
  exclusions: [
    'Moving pianos, safes or anything over 150 lb.',
    'Wallpaper removal and drywall replacement.',
    'Closet interiors.',
  ],
  timeline: '3 days on site (4 with ceilings). Next openings: the week of Oct 12.',
  markupPct: 20,
  taxPct: 7.5,
  discount: 0,
  status: 'viewed',
};

/** Built per request so the dates are always "sent two days ago, good for a
 *  month" - a sample that says it expired last spring would be a poor advert. */
function demo(now = Date.now()) {
  const day = 86400000;
  const q = {
    ...QUOTE,
    createdAt: new Date(now - 2 * day - 3600000).toISOString(),
    sentAt: new Date(now - 2 * day).toISOString(),
    validUntil: new Date(now + 28 * day).toISOString(),
  };
  q.terms = BUSINESS.terms;
  q.totals = Q.computeTotals(q);
  return { demo: true, ...Q.publicView(q, BUSINESS, now) };
}

module.exports = { demo, BUSINESS, QUOTE };
