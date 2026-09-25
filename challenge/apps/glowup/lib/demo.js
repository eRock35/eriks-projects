// The signed-out sample: three plainly fictional listings, each with its
// history, a glow-up and (for the cabin) a competitor comparison.
//
// No model call, ever. The rewrites and the comparison below are hand-written
// in the shapes the model returns, and they go through the SAME validators
// (ai.validateGlow, ai.validateCompare) and the same rules as a real answer -
// so the guard, the platform limits and the scoring are exercised by the demo
// too, and every score on the page is computed, not typed in.
//
// The Loon's Nest, Wick & Ember and Northfield are invented. Any resemblance
// to a real cabin, shop or brand is an accident.

const R = require('../public/rules');
const L = require('./listings');
const ai = require('./ai');

/* ---------------- The Loon's Nest: a lakeside cabin on Airbnb ---------------- */

const LOON_V1 = {
  type: 'stay',
  platform: 'airbnb',
  title: 'Cozy Lakefront Cabin - PERFECT GETAWAY',
  description: 'Welcome to The Loon\'s Nest!!! This is a really nice and cozy cabin on the lake that is great for families and couples and anyone who wants to get away from it all and relax in a beautiful setting surrounded by nature, with a hot tub and kayaks and a wood stove for chilly nights and a big deck and the the dock where you can fish or swim. Dogs are welcome too. Message us with any questions!',
  tags: ['hot tub', 'wood stove', 'kayaks', 'dog friendly', 'dock'],
  keywords: ['lake cabin', 'hot tub', 'dog friendly'],
  price: '$189 / night',
  photoCount: 8,
  shots: ['hero', 'outside'],
};

const LOON_GLOW = {
  titles: [
    { text: 'Lake cabin with hot tub, wood stove & kayaks', angle: 'Search first' },
    { text: 'Hot tub lake cabin on the water - dogs welcome', angle: 'Feature first' },
    { text: 'The Loon\'s Nest: dog friendly lake cabin with dock', angle: 'The name' },
  ],
  description: [
    'Lake cabin on the water, with a hot tub and a wood stove for cool nights.',
    '• Sleeps [add: how many guests] - [add: beds and their sizes]',
    '• [add: check-in time, and how guests get in]',
    '• [add: parking - where, and for how many cars]',
    '• [add: Wi-Fi speed in Mbps, if you have Wi-Fi]',
    '• Kayaks and a dock to fish or swim from',
    '• Dog friendly - bring the dog',
    '• [add: how many minutes] to [add: the nearest town or trailhead]',
    'Tap Reserve to check your dates.',
  ].join('\n'),
  tags: ['lake cabin', 'hot tub', 'dog friendly', 'wood stove', 'kayaks', 'dock'],
  shots: [
    { shot: 'The hot tub with the lake behind it', why: 'It is your headline amenity - show it where it is.' },
    { shot: 'Each bedroom, bed made, from the doorway', why: 'Guests book on beds. Two photos answer "will we fit?"' },
    { shot: 'The bathroom, lights on', why: 'The photo guests look for and hosts skip.' },
    { shot: 'The kitchen from the corner', why: 'Families plan meals; show the stove and the table.' },
    { shot: 'Kayaks on the dock in the morning', why: 'Sells the lake better than any adjective.' },
  ],
  gaps: ['how many guests it sleeps', 'check-in time', 'parking', 'Wi-Fi speed', 'minutes to town or a trailhead'],
  summary: 'Led with the lake and the hot tub, cut “cozy” and “perfect”, split the paragraph into bullets and marked five facts guests look for.',
};

// What the host typed into the gaps.
const LOON_FILLED = {
  description: [
    'Lake cabin on the water, with a hot tub and a wood stove for cool nights.',
    '• Sleeps 4: a queen bed and 2 twin bunks',
    '• Self check-in from 4pm with a keypad',
    '• Parking for 2 cars in the driveway',
    '• Wi-Fi 150 Mbps, with a desk by the window',
    '• Kayaks and a dock to fish or swim from',
    '• Dog friendly - bring the dog',
    '• 10 min drive to Pine Falls trailhead',
    'Tap Reserve to check your dates.',
  ].join('\n'),
  tags: ['lake cabin', 'hot tub', 'dog friendly', 'wood stove', 'kayaks', 'dock', 'Wi-Fi', 'parking'],
};

const PINE_HOLLOW = {
  title: 'A-frame on Pine Hollow Lake · hot tub · 5 min to trails',
  description: 'Wake up to the lake through a 20-foot wall of windows.\n• Sleeps 6: king, queen, 2 twins\n• Hot tub, fire pit, 2 paddleboards\n• 300 Mbps Wi-Fi and a desk\n• Self check-in after 3pm\nBook your dates - summer weekends go fast.',
  tags: ['hot tub', 'fire pit', 'paddleboards', 'wifi'],
  price: '$215 / night',
  photoCount: 26,
};

const LOON_COMPARE = {
  theyDoBetter: [
    { point: 'Their first line sells the view with a number: “a 20-foot wall of windows”.', move: 'Open with your best real fact - if the hot tub looks at the lake, say that first.' },
    { point: '26 photos to your 8, and every room is in them.', move: 'Shoot the bedrooms and the bathroom next - they are on your shot list.' },
    { point: 'They list outdoor extras (fire pit, paddleboards) in one line.', move: 'If you have more outside - a grill, a fire pit - list it; if not, your dock is the answer.' },
  ],
  youDoBetter: [
    { point: 'Dogs are welcome and you say so - they don’t, and dog owners filter for it.' },
    { point: 'You give the drive to the trailhead in minutes.' },
  ],
  verdict: 'Add the missing photos - that is the biggest gap left, and the only one words can’t fix.',
};

/* ---------------- Wick & Ember: a candle on Etsy ---------------- */

const CANDLE_V1 = {
  type: 'product',
  platform: 'etsy',
  title: 'Handmade Candle - Cedar Smoke - Great Gift!!',
  description: 'This is a hand poured candle that smells amazing. Perfect for any room. Makes a great gift for anyone! Wooden wick, soy wax, 8 oz amber jar.',
  tags: ['candle', 'cedar candle', 'handmade', 'gift'],
  keywords: ['cedar candle', 'wood wick candle', 'gift for him'],
  price: '$24',
  photoCount: 3,
  shots: ['hero'],
};

const CANDLE_GLOW = {
  titles: [
    { text: 'Cedar candle with wood wick, 8 oz soy wax in amber jar - smoky cedar scent, hand poured gift for him', angle: 'Search first' },
    { text: 'Wood wick candle - cedar and smoke, 8 oz soy wax, hand poured in an amber jar', angle: 'Feature first' },
    { text: 'Gift for him: hand poured cedar candle with a crackling wood wick, 8 oz', angle: 'The occasion' },
  ],
  description: [
    'A crackling wood wick and smoky cedar, hand poured in an 8 oz amber jar of soy wax.',
    '• Scent: cedar and smoke',
    '• Soy wax, wooden wick, amber glass jar',
    '• Burn time: [add: how many hours]',
    '• Care: trim the wick to [add: how short] before each light',
    '• Ships in [add: processing time]',
    'A gift for him, a housewarming or yourself. Add it to your cart.',
  ].join('\n'),
  tags: ['cedar candle', 'wood wick candle', 'gift for him', 'soy candle', 'smoky candle', 'amber jar candle', 'hand poured candle', 'crackling candle', 'woodsy candle', 'man candle', 'cabin candle', 'housewarming gift', 'candle gift'],
  shots: [
    { shot: 'The candle lit, in a hand, for scale', why: 'An 8 oz jar means nothing until someone holds it.' },
    { shot: 'A close-up of the wood wick burning', why: 'The crackle is the reason to choose it - show the flame.' },
    { shot: 'The lid, label and box together', why: 'Gift buyers want to see what arrives.' },
  ],
  gaps: ['burn time in hours', 'how far to trim the wick', 'processing time'],
  summary: 'Led with the wood wick and the cedar, used all 13 tags and marked the three facts gift buyers check.',
};

const CANDLE_FILLED = {
  description: [
    'A crackling wood wick and smoky cedar, hand poured in an 8 oz amber jar of soy wax.',
    '• Scent: cedar and smoke',
    '• Soy wax, wooden wick, amber glass jar',
    '• Burn time: about 45 hours',
    '• Care: trim the wick to 1/8 inch before each light',
    '• Ships in 2 business days, gift-ready',
    'A gift for him, a housewarming or yourself. Add it to your cart.',
  ].join('\n'),
  photoCount: 7,
  shots: ['hero', 'scale', 'detail', 'package'],
};

/* ---------------- Northfield: a resale jacket on eBay ---------------- */

const JACKET_V1 = {
  type: 'resale',
  platform: 'ebay',
  title: 'Northfield Jacket mens M waxed canvas NICE',
  description: 'Nice jacket. Worn a few times. Great condition. No holes. Smoke free home.',
  tags: ['waxed canvas', 'jacket'],
  keywords: ['waxed canvas jacket', 'field jacket'],
  price: '$68 or best offer',
  photoCount: 5,
  shots: ['front', 'back'],
};

const JACKET_GLOW = {
  titles: [
    { text: 'Northfield waxed canvas jacket, men\'s M - field jacket, worn a few times', angle: 'Search first' },
    { text: 'Northfield field jacket, waxed canvas, size M - no holes, smoke free home', angle: 'Condition first' },
    { text: 'Men\'s M Northfield waxed canvas field jacket', angle: 'Short and plain' },
  ],
  description: [
    'Northfield waxed canvas field jacket in men\'s M, worn a few times, no holes.',
    '• Condition: gently worn - [add: any marks, fading or wear on the cuffs]',
    '• Size M. Measurements: pit to pit [add: inches], length [add: inches]',
    '• [add: colour]',
    '• Smoke free home',
    'Ships [add: how fast]. Make an offer or message me with questions.',
  ].join('\n'),
  tags: ['waxed canvas jacket', 'field jacket', 'Northfield', 'mens M jacket', 'waxed jacket'],
  shots: [
    { shot: 'The label and size tag, in focus', why: 'Resale buyers check the tag before anything else.' },
    { shot: 'Any wear on the cuffs and collar, close up', why: 'Showing flaws first prevents returns.' },
    { shot: 'Measurements with a tape, pit to pit and length', why: 'Size M fits differently by brand - numbers settle it.' },
  ],
  gaps: ['marks or wear', 'pit to pit and length in inches', 'colour', 'shipping speed'],
  summary: 'Put the brand, the size and "field jacket" up front and turned the adjectives into condition facts.',
};

const JACKET_FILLED = {
  description: [
    'Northfield waxed canvas field jacket in men\'s M, worn a few times, no holes.',
    '• Condition: gently worn - light fading on the cuffs, no stains',
    '• Size M. Measurements: pit to pit 22 in, length 29 in',
    '• Olive, with a brown corduroy collar',
    '• Smoke free home',
    'Ships next day. Make an offer or message me with questions.',
  ].join('\n'),
  photoCount: 9,
  shots: ['front', 'back', 'tag', 'flaws'],
};

/* ---------------- assembly ---------------- */

function history(id, start, today, steps) {
  // steps: [{ daysAgo, source, fields }], oldest first
  const rows = steps.map((s, i) => {
    const fields = { ...(i ? steps[i - 1].resolved : start), ...s.fields };
    s.resolved = fields;
    const sm = R.summary(fields);
    return { id: `${id}-v${i + 1}`, n: i + 1, at: `${R.addDays(today, -s.daysAgo)}T${String(9 + i).padStart(2, '0')}:20:00.000Z`, source: s.source, fields, score: sm.score, cats: sm.cats };
  });
  return rows.reverse(); // newest first, as the store lists them
}

function listing(id, versions) {
  const cur = versions[0];
  const first = versions[versions.length - 1];
  return {
    id,
    ...cur.fields,
    score: cur.score,
    cats: cur.cats,
    firstScore: first.score,
    bestScore: Math.max(...versions.map((v) => v.score)),
    versionCount: versions.length,
    trail: versions.slice().reverse().map((v) => v.score),
    createdAt: first.at,
    updatedAt: cur.at,
  };
}

function demo(today = L.utcToday()) {
  const specs = [
    { id: 'loons-nest', v1: LOON_V1, glow: LOON_GLOW, filled: LOON_FILLED, days: [6, 5, 1] },
    { id: 'wick-ember', v1: CANDLE_V1, glow: CANDLE_GLOW, filled: CANDLE_FILLED, days: [9, 4, 0] },
    { id: 'northfield', v1: JACKET_V1, glow: JACKET_GLOW, filled: JACKET_FILLED, days: [3, 2, 2] },
  ];
  const items = {};
  const glows = {};
  const summaries = [];
  const improvedDays = new Set();
  for (const s of specs) {
    const proposal = ai.validateGlow(s.glow, s.v1);
    const glow = L.glowResult(s.v1, proposal);
    const versions = history(s.id, s.v1, today, [
      { daysAgo: s.days[0], source: 'paste', fields: {} },
      { daysAgo: s.days[1], source: 'glowup', fields: glow.fields },
      { daysAgo: s.days[2], source: 'edit', fields: s.filled },
    ]);
    const l = listing(s.id, versions);
    if (s.id === 'loons-nest') {
      const theirs = L.cleanCompetitor(PINE_HOLLOW, l);
      l.compare = L.compareResult(l, theirs, ai.validateCompare(LOON_COMPARE), `${R.addDays(today, -1)}T15:05:00.000Z`, versions[0].n);
    }
    const detail = L.detailOf(l, versions);
    detail.card = L.shareCard(l, versions, { includeText: false });
    detail.history = versions.slice().reverse().map((v) => v.fields);
    items[s.id] = detail;
    glows[s.id] = glow;
    summaries.push(L.summaryOf(l));
    versions.forEach((v, i) => { if (versions[i + 1] && v.score > versions[i + 1].score) improvedDays.add(v.at.slice(0, 10)); });
  }
  return {
    demo: true,
    today,
    listings: summaries,
    items,
    glows,
    wins: winsOf(summaries, [...improvedDays], today),
  };
}

/** The Wins view, from listing summaries and the days a save raised a score. */
function winsOf(summaries, days, today) {
  const gained = summaries.reduce((s, l) => s + Math.max(0, (l.score || 0) - (l.firstScore || 0)), 0);
  const best = summaries.slice().sort((a, b) => (b.score - b.firstScore) - (a.score - a.firstScore))[0] || null;
  return {
    streak: R.dayStreak(days, today),
    listings: summaries.length,
    gained,
    glowing: summaries.filter((l) => l.score >= 90).length,
    average: summaries.length ? Math.round(summaries.reduce((s, l) => s + (l.score || 0), 0) / summaries.length) : 0,
    best: best && best.score > best.firstScore ? { id: best.id, title: best.title, from: best.firstScore, to: best.score } : null,
  };
}

module.exports = { demo, winsOf, LOON_V1, LOON_GLOW, LOON_FILLED, LOON_COMPARE, PINE_HOLLOW, CANDLE_V1, CANDLE_GLOW, JACKET_V1, JACKET_GLOW };
