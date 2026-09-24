// A sample inbox, written by hand, for people who have not signed up.
//
// No app on this domain makes a model call for a signed-out visitor, so the
// way to show what Rave does is a real-looking inbox run through the real
// arithmetic: the same view(), triageOf(), scoreboard(), lint and heat a
// signed-in person's data goes through, so the demo cannot drift from the
// product. The "deeper read" triage on three reviews and the cool-down example
// are pre-written - no model - and pass through the same validators.
//
// Juniper & Rye, its owner and every reviewer are invented. Dates are relative
// to today so the sample never reads as last spring's.

const V = require('./reviews');
const R = require('../public/rules');

const SETTINGS = {
  ...V.SETTINGS_DEFAULTS,
  businessName: 'Juniper & Rye',
  what: 'neighbourhood café & bakery',
  ownerName: 'Ana',
  signOff: 'Warmly,',
  tone: 'warm',
  alwaysSay: 'We bake everything in-house every morning.',
  neverSay: 'Never offer free food or refunds in a public reply.',
  contactLine: 'ana@juniperandrye.example or (555) 010-2277',
};

// [id, platform, stars, reviewer, posted (days ago), text, replied (days ago, hour UTC) | null, reply, favourite]
const ROWS = [
  ['r1', 'google', 5, 'Maya Reyes', 2, 'The cardamom buns are unreal and the oat flat white is the best in the neighbourhood. Staff remembered my order on my second visit, which never happens! Cosy spot to work for an hour.', [1, 15],
    'Hi Maya,\n\nThis made our morning — thank you! The cardamom buns come out of our oven at 7 every day, so we’re thrilled they’ve won you over. See you (and your flat white) soon.\n\nWarmly,\nAna, Juniper & Rye', true],
  ['r2', 'yelp', 4, 'Dev Patel', 3, 'Great sourdough and a lovely patio. Only knock: we waited about 20 minutes for a table at Sunday brunch. Worth it, but plan ahead.', null, '', false],
  ['r3', 'google', 1, 'Brett Lawson', 0, 'Worst brunch of my life. Waited 50 minutes for cold eggs, the waiter rolled his eyes when I asked where our food was, and there was a hair in my hash. $18 for THIS?? Never again. Avoid.', null, '', false],
  ['r4', 'tripadvisor', 2, 'Sofia Greco', 12, 'Pretty café but pricey for what you get. The avocado toast was tiny and the music was so loud we couldn’t hear each other.', [8, 10],
    'Hi Sofia,\n\nThank you for the honest feedback, and I’m sorry the visit didn’t feel like good value. You’re right about the music — we’ve turned it down on weekends since. I’d love to hear more: ana@juniperandrye.example or (555) 010-2277.\n\nWarmly,\nAna, Juniper & Rye', false],
  ['r5', 'google', 5, 'Tom Hughes', 18, 'Dog-friendly patio, water bowls out, and the barista gave my spaniel a biscuit. Coffee is excellent. Our new Saturday ritual.', [18, 16],
    'Hi Tom,\n\nYour spaniel is welcome any Saturday — the biscuit jar will be ready. Thank you for such a lovely review.\n\nWarmly,\nAna, Juniper & Rye', true],
  ['r6', 'yelp', 1, 'J. M.', 1, 'My partner and I both got sick the night after eating the chicken sandwich. Stomach cramps all night. Not ok.', null, '', false],
  ['r7', 'google', 3, 'Priya Shah', 6, 'Coffee was great and the staff were lovely, but the lemon cake tasted a day old. Would come back for drinks.', [5, 11],
    'Hi Priya,\n\nThank you for the fair review. We bake everything in-house every morning, so a tired lemon cake isn’t what we want to serve — I’ve raised it with the kitchen. Glad the coffee and the team made up for it.\n\nWarmly,\nAna, Juniper & Rye', false],
  ['r8', 'facebook', 5, 'Luis Morales', 25, 'Juniper & Rye catered our office breakfast for 30 people. On time, beautifully packed, and everyone raved about the pastries. Already booked them again.', [24, 9],
    'Hi Luis,\n\nThirty happy colleagues is the best review we could ask for. Thank you for trusting us with the breakfast — we’re already looking forward to the next one.\n\nWarmly,\nAna, Juniper & Rye', true],
  ['r9', 'google', 4, 'Hannah Brooks', 40, 'Lovely brunch and a friendly team. A little crowded on weekends, but that’s the price of being good!', [39, 14],
    'Hi Hannah,\n\nThank you! Weekends do get busy — weekday mornings are our quiet secret if you fancy a calmer brunch. So glad you enjoyed it.\n\nWarmly,\nAna, Juniper & Rye', true],
  ['r10', 'google', 2, 'Chris Doyle', 55, 'Ordered ahead online and my order still wasn’t ready when I arrived. Staff were apologetic though.', [53, 12],
    'Hi Chris,\n\nI’m sorry your order wasn’t ready — that’s exactly what ordering ahead is supposed to avoid. We’ve changed how online orders reach the counter since. If you’d like to tell me more, I’m at ana@juniperandrye.example.\n\nWarmly,\nAna, Juniper & Rye', false],
  ['r11', 'yelp', 5, 'Aisha Khan', 75, 'Best matcha latte in town and the space is gorgeous. Staff are always so welcoming.', [74, 10],
    'Hi Aisha,\n\nThank you so much — the matcha fans are a loyal bunch and we’re glad to count you in. See you soon!\n\nWarmly,\nAna, Juniper & Rye', false],
  ['r12', 'google', 5, 'Sam Porter', 110, 'Hidden gem. The sourdough alone is worth the trip.', [109, 13],
    'Hi Sam,\n\nThank you! Our sourdough takes two days from start to loaf, so this means a lot. Come back hungry.\n\nWarmly,\nAna, Juniper & Rye', false],
];

// The "deeper read" a signed-in owner would get from the model, pre-written.
const TRIAGE = {
  r2: { sentiment: 'mixed', topics: ['food', 'atmosphere', 'wait'], praise: ['food', 'atmosphere'], complaints: ['wait'], riskReasons: [], urgency: 'normal', summary: 'Loved the sourdough and patio; waited 20 minutes for a table at Sunday brunch.', approach: 'Thank them, own the weekend wait, and mention a quieter time to visit.' },
  r3: { sentiment: 'negative', topics: ['wait', 'food', 'staff', 'cleanliness', 'price'], praise: [], complaints: ['wait', 'food', 'staff', 'cleanliness', 'price'], riskReasons: [], urgency: 'high', summary: 'A 50-minute wait, cold eggs, an eye-roll from a server and a hair in the food.', approach: 'Apologise without excuses, skip the details, and invite him to talk to you directly.' },
  r6: { sentiment: 'negative', topics: ['food'], praise: [], complaints: ['food'], riskReasons: ['health'], urgency: 'urgent', summary: 'Two people report getting sick after the chicken sandwich.', approach: 'Short and sincere, no details or admission in public — call them and check the kitchen log today.' },
};

// Ana's first draft to Brett, and what Rave made of it.
const ANGRY = 'Brett, maybe if you hadn’t shown up at 11:30 on a SATURDAY with a party of 8 and no reservation you wouldn’t have waited. Our eggs are cooked to order and nobody else complained. Frankly people like you are why restaurants hate Yelp. Don’t bother coming back!!';
const CALM = 'Hi Brett,\n\nThank you for the feedback, and I’m sorry your brunch wasn’t what it should have been. Saturday late mornings are our busiest time and we didn’t keep up that day — that’s on us to fix, not you. A cold plate and a hair in your food aren’t acceptable at any hour.\n\nI’d really like to hear more and make it right: ana@juniperandrye.example or (555) 010-2277.\n\nWarmly,\nAna, Juniper & Rye';
const REMOVED = [
  { kind: 'blame', quote: 'maybe if you hadn’t shown up at 11:30 on a SATURDAY', why: 'Readers hear “it was your fault” — and they picture themselves as the customer.' },
  { kind: 'insult', quote: 'people like you are why restaurants hate Yelp', why: 'Name-calling is the line people screenshot.' },
  { kind: 'argue', quote: 'nobody else complained', why: 'Arguing the facts in public never wins; take it offline.' },
  { kind: 'dismiss', quote: 'Don’t bother coming back!!', why: 'Turns one unhappy customer into a story about the owner.' },
  { kind: 'private', quote: 'a party of 8 and no reservation', why: 'Details of his visit are his, not the internet’s.' },
];

function records(today) {
  const at = (daysAgo, hour) => `${V.addDays(today, -daysAgo)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
  return ROWS.map(([id, platform, stars, reviewer, posted, text, replied, reply, favourite]) => {
    const r = {
      id: `demo-${id}`,
      platform, stars, reviewer, text,
      date: V.addDays(today, -posted),
      source: 'paste',
      addedAt: at(posted, 8),
      addedDay: V.addDays(today, -posted),
      favourite,
      triage: TRIAGE[id] ? { ...V.validateTriage(TRIAGE[id], stars), at: at(posted, 9) } : null,
      reply: reply ? { text: reply, source: 'own', at: at(replied[0], replied[1]) } : null,
      repliedAt: replied ? at(replied[0], replied[1]) : null,
      repliedDay: replied ? V.addDays(today, -replied[0]) : null,
      replySource: replied ? 'own' : null,
    };
    return r;
  });
}

function demo(today = V.utcToday()) {
  const recs = records(today);
  const views = V.sortViews(recs.map((r) => V.view(r, today)));
  const drafts = {};
  for (const r of recs.filter((x) => !x.repliedAt)) {
    const text = V.template(r, SETTINGS);
    drafts[r.id] = { text, source: 'template', lint: V.lintFor(text, r, recs, SETTINGS) };
  }
  // Every replied review gets its checklist too, so the sample shows a clean one.
  for (const r of recs.filter((x) => x.repliedAt)) drafts[r.id] = { text: r.reply.text, source: 'own', lint: V.lintFor(r.reply.text, r, recs, SETTINGS) };
  const brett = recs.find((r) => r.id === 'demo-r3');
  const ctx = { reviewer: brett.reviewer, contactLine: SETTINGS.contactLine };
  const before = R.heat(ANGRY, ctx);
  const after = R.heat(CALM, ctx);
  const got = V.earnedBadges(recs, today, { wall: true });
  return {
    demo: true,
    today,
    settings: SETTINGS,
    reviews: views,
    drafts,
    scoreboard: V.scoreboard(recs, today),
    badges: V.BADGES.map((b) => ({ ...b, earnedAt: got.has(b.key) ? today : null })),
    cooldown: {
      reviewId: brett.id,
      angry: ANGRY,
      calm: CALM,
      removed: REMOVED.map((x) => ({ ...x, by: 'sample' })),
      kept: 'That Saturday late mornings are the busiest time — said as your problem to fix, not his.',
      heatBefore: before,
      heatAfter: after,
      lint: V.lintFor(CALM, brett, recs, SETTINGS),
    },
    wall: V.wallOf(SETTINGS, recs, { title: 'Why people love Juniper & Rye', showReplies: true }, today),
  };
}

module.exports = { demo, SETTINGS, ANGRY, CALM };
