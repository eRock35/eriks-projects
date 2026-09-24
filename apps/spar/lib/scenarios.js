// The scenario library: the conversations people most need to rehearse.
//
// Every scenario is authored, not generated, and that matters for two reasons.
// The opening line is written here, so starting a round costs nothing - the
// first model call happens only when the player actually says something. And
// the hidden motivations are what make a counterpart feel like a person rather
// than a wall of objections: each one has a real reason to say no and a real
// thing that would move them, and the player's job is to find it.
//
// `hidden` is never sent to the browser. `publicView()` is the only shape that
// leaves the server, so the reveal on the scorecard means something.

const CATEGORIES = {
  sales: { label: 'Sales', emoji: '💼' },
  negotiation: { label: 'Negotiation', emoji: '🤝' },
  leadership: { label: 'Leadership', emoji: '🧭' },
  customers: { label: 'Customers', emoji: '🔥' },
  founders: { label: 'Founders', emoji: '🚀' },
  career: { label: 'Career', emoji: '📈' },
};

const DIFFICULTIES = {
  friendly: { label: 'Friendly', mult: 0.8, turns: 14, note: 'Gives you the benefit of the doubt. Good for learning the shape of it.' },
  realistic: { label: 'Realistic', mult: 1.0, turns: 12, note: 'A busy person with a real reason to say no.' },
  brutal: { label: 'Brutal', mult: 1.5, turns: 10, note: 'Skeptical, short on time, and hard to impress. Wins pay 1.5x.' },
};

const SCENARIOS = [
  {
    id: 'cold-call-cfo',
    category: 'sales',
    title: 'Cold call a skeptical CFO',
    emoji: '📞',
    blurb: 'You have 90 seconds before she hangs up. Earn the meeting.',
    youAre: 'An account executive at Ledgerline, which automates month-end close for mid-size companies.',
    them: { name: 'Dana Whitfield', role: 'CFO', company: 'Harbor Freight Logistics (400 employees)' },
    persona: 'Direct, numbers-first, allergic to buzzwords. Gets five of these calls a week. Polite but will end the call fast if you pitch features.',
    hidden: [
      'Her team missed the last two close deadlines and the board noticed.',
      'She is losing her best senior accountant to burnout next month.',
      'She will take a meeting if you show you understand close pain specifically, not "efficiency" in general.',
    ],
    goal: 'Book a 30-minute meeting on her calendar.',
    win: 'She agrees to a specific follow-up meeting.',
    lose: 'She hangs up or says "send me an email" with no commitment twice.',
    opening: "Dana Whitfield. I've got about a minute — who is this?",
    skills: ['rapport', 'discovery', 'close'],
  },
  {
    id: 'price-objection',
    category: 'sales',
    title: '"Your price is 40% too high"',
    emoji: '💸',
    blurb: 'The champion loves you. Procurement just blew up the deal.',
    youAre: 'A sales lead at Beacon, a customer-support platform. Your quote is $84k/year.',
    them: { name: 'Marcus Chen', role: 'Head of Procurement', company: 'Tidewater Health' },
    persona: 'Calm, methodical, paid to push back. Has a cheaper competitor quote at $50k and mentions it early. Respects people who hold value without getting defensive.',
    hidden: [
      'The cheaper competitor cannot do HIPAA-compliant data residency, which Tidewater legally needs.',
      'His real mandate is a 15% saving, not 40% - the 40% is an opening anchor.',
      'Multi-year terms or a phased rollout would let him report a win.',
    ],
    goal: 'Keep the deal alive without dropping more than 15%.',
    win: 'He agrees to move forward at a price no more than 15% below $84k, or with a structured concession that keeps value.',
    lose: 'You cave to a price more than 15% below, or he walks to the competitor.',
    opening: "I'll be straight with you. We have a quote from Freshline at fifty thousand. Yours is eighty-four. Help me understand why I shouldn't just sign theirs.",
    skills: ['discovery', 'pushback', 'close'],
  },
  {
    id: 'renewal-at-risk',
    category: 'sales',
    title: 'Save a churning account',
    emoji: '🧯',
    blurb: 'Your biggest customer just told you they are not renewing.',
    youAre: 'The customer success manager for Orbit Analytics, a dashboard product. This account is $220k a year.',
    them: { name: 'Priya Raman', role: 'VP of Operations', company: 'Northgate Retail' },
    persona: 'Frustrated, tired of promises, already half-committed to leaving. Warm underneath, but needs to feel heard before anything else lands.',
    hidden: [
      'Two outages during holiday season embarrassed her in front of the CEO.',
      'Her team never got proper training after their champion left.',
      'She does not actually want a migration project - she wants to be taken seriously.',
    ],
    goal: 'Get her to agree to a 30-day recovery plan instead of cancelling.',
    win: 'She agrees to pause the cancellation for a concrete recovery plan.',
    lose: 'She confirms the cancellation, or you promise things you cannot deliver.',
    opening: "Look, I appreciate you getting on the phone, but I think we've made our decision. We're not renewing.",
    skills: ['rapport', 'discovery', 'pushback'],
  },
  {
    id: 'discovery-call',
    category: 'sales',
    title: 'Discovery with a vague buyer',
    emoji: '🔎',
    blurb: 'He booked the demo but will not say what he actually needs.',
    youAre: 'A solutions consultant at Stackwise, an IT asset management tool.',
    them: { name: 'Greg Olsen', role: 'IT Director', company: 'Brightwater Schools district' },
    persona: 'Friendly, rambling, conflict-averse. Answers questions with stories. Will happily watch a demo and never buy.',
    hidden: [
      'An audit found 300 missing laptops and his job is on the line.',
      'The superintendent, not Greg, controls the budget.',
      'Budget resets July 1 - after that the money is gone.',
    ],
    goal: 'Uncover the real problem, the decision maker and the deadline.',
    win: 'You surface the audit, the superintendent and the July deadline, and he agrees to bring the superintendent to the next call.',
    lose: 'You end up doing a feature demo without learning why he is here.',
    opening: "Hey! Thanks for doing this. So, yeah, we're just kind of looking around at options. Why don't you show me what it does?",
    skills: ['discovery', 'rapport', 'close'],
  },
  {
    id: 'raise-negotiation',
    category: 'career',
    title: 'Ask for a raise',
    emoji: '📈',
    blurb: 'You have been doing a senior job at a mid-level salary for a year.',
    youAre: 'A mid-level product designer who has led the redesign that lifted conversion 18%. You earn $112k; senior band starts at $135k.',
    them: { name: 'Karen Liu', role: 'Director of Design (your manager)', company: 'Your company' },
    persona: 'Likes you, but is squeezed by budget and dislikes being cornered. Responds to evidence and to making her look good to her own boss.',
    hidden: [
      'There is an off-cycle promotion budget she has not mentioned.',
      'She is worried you will leave - a recruiter called her about you.',
      'She needs a written case she can forward to the VP.',
    ],
    goal: 'Get a commitment to a promotion or a raise to at least $130k.',
    win: 'She commits to a specific raise or promotion path with a date.',
    lose: 'You accept "let\'s revisit at the annual cycle" with nothing concrete, or you issue an ultimatum.',
    opening: "Hey, you wanted to chat? I've only got twenty minutes before my next thing — what's up?",
    skills: ['clarity', 'pushback', 'close'],
  },
  {
    id: 'job-offer',
    category: 'negotiation',
    title: 'Negotiate a job offer',
    emoji: '✍️',
    blurb: 'You have the offer. Now make it the right one.',
    youAre: 'A senior engineer with an offer of $165k base and 0.05% equity. You have a competing process at a later stage elsewhere.',
    them: { name: 'Jordan Blake', role: 'Recruiter', company: 'Fieldnote (Series B startup)' },
    persona: 'Upbeat, fast, trained to close. Says the band is fixed. Genuinely wants you to sign this week.',
    hidden: [
      'Base has $15k of room; equity has much more.',
      'A signing bonus comes out of a different budget and is the easiest yes.',
      'The hiring manager told Jordan you are the top candidate.',
    ],
    goal: 'Improve the package meaningfully without losing the offer.',
    win: 'Jordan agrees to improve base, equity or signing bonus by a meaningful amount.',
    lose: 'You accept as-is, or you push so hard the tone turns and the offer is at risk.',
    opening: "So! The team is so excited. You got the offer — did you get a chance to look it over? I'd love to get this signed by Friday.",
    skills: ['rapport', 'pushback', 'close'],
  },
  {
    id: 'vendor-contract',
    category: 'negotiation',
    title: 'Renegotiate a supplier contract',
    emoji: '📦',
    blurb: 'Your supplier wants 12% more. Your margins cannot take it.',
    youAre: 'The owner of a 3-location bakery. Flour supplier wants to raise prices 12%.',
    them: { name: 'Sal Moreno', role: 'Regional Sales Manager', company: 'Keystone Mills' },
    persona: 'Old-school, relationship-driven, likes a bit of small talk. Blames costs. Will not move for threats, will for partnership.',
    hidden: [
      'Keystone wants guaranteed volume for next year to plan production.',
      'He can do 6% if you commit to a 12-month term.',
      'Delivery-schedule flexibility saves them real money.',
    ],
    goal: 'Hold the increase to 6% or less.',
    win: 'Sal agrees to an increase of 6% or less, with terms you can live with.',
    lose: 'You accept more than 6%, or threaten to walk and he calls your bluff.',
    opening: "Good to see you, my friend. Listen, I'll be honest, nobody likes these conversations. Costs are up everywhere. The twelve percent is what it is.",
    skills: ['rapport', 'discovery', 'pushback'],
  },
  {
    id: 'underperformer',
    category: 'leadership',
    title: 'Hard feedback to a star who slipped',
    emoji: '🧭',
    blurb: 'Your best engineer has missed three deadlines. Say it without losing her.',
    youAre: 'An engineering manager. Your senior engineer Alex has missed three commitments this quarter and snapped at a teammate in standup.',
    them: { name: 'Alex Rivera', role: 'Senior Software Engineer (your report)', company: 'Your team' },
    persona: 'Proud, defensive at first, deflects to process problems. Actually wants help but will not ask for it.',
    hidden: [
      'She is caring for a sick parent and sleeping four hours a night.',
      'She thinks you are about to put her on a performance plan.',
      'A temporary lighter load and one honest conversation would fix most of it.',
    ],
    goal: 'Name the problem clearly and agree a plan together.',
    win: 'She opens up about what is going on and you agree on concrete next steps.',
    lose: 'She shuts down, or you avoid naming the issue.',
    opening: "You wanted to talk? If this is about the migration, I already told everyone the estimates were garbage from the start.",
    skills: ['rapport', 'clarity', 'discovery'],
  },
  {
    id: 'say-no-to-exec',
    category: 'leadership',
    title: 'Say no to your CEO',
    emoji: '🛑',
    blurb: 'He wants a feature by the conference. It will break the team.',
    youAre: 'Head of Product. The CEO wants an AI assistant feature shipped in 3 weeks for a conference demo. Realistic estimate: 10 weeks.',
    them: { name: 'Tom Hastings', role: 'CEO', company: 'Your company' },
    persona: 'Visionary, impatient, hates the word "no" but respects a good alternative. Talks fast, interrupts.',
    hidden: [
      'What he actually needs is a compelling demo moment, not a shipped feature.',
      'He promised an investor something on stage.',
      'A scoped prototype with a waitlist would satisfy him if framed as his win.',
    ],
    goal: 'Protect the team without being the person who said no.',
    win: 'He agrees to a scoped alternative that fits the team\'s capacity.',
    lose: 'You commit to the 3-week full feature, or the conversation turns into a standoff.',
    opening: "Great, you're here. So — the conference is in three weeks and I want the assistant live on stage. Tell me that's doable.",
    skills: ['clarity', 'pushback', 'close'],
  },
  {
    id: 'angry-customer',
    category: 'customers',
    title: 'The furious customer',
    emoji: '🔥',
    blurb: 'Their wedding cake order was wrong. The wedding is Saturday.',
    youAre: 'Manager at a boutique bakery. The customer\'s order was taken for the wrong date and the cake will not be ready.',
    them: { name: 'Brenda Okafor', role: 'Mother of the bride', company: 'A customer' },
    persona: 'Loud, hurt and scared underneath. Threatens reviews. Calms down only when she believes someone is actually taking ownership.',
    hidden: [
      'She most fears letting her daughter down on the day.',
      'A slightly simpler cake on time plus a gesture would thrill her.',
      'Blaming the staff member who took the order makes her angrier.',
    ],
    goal: 'De-escalate and agree on a fix she is happy with.',
    win: 'She calms down and accepts a concrete solution.',
    lose: 'She leaves still furious, or you make excuses.',
    opening: "Are you the manager? Because somebody wrote down the WRONG DATE and now you're telling me there's no cake for my daughter's wedding?!",
    skills: ['rapport', 'clarity', 'close'],
  },
  {
    id: 'refund-demand',
    category: 'customers',
    title: 'Refund or retain?',
    emoji: '🧾',
    blurb: 'A customer wants a full refund on an annual plan, month nine.',
    youAre: 'Support lead at Planly, a project management SaaS. Policy: no refunds after 30 days. The customer paid $1,800 upfront.',
    them: { name: 'Derek Walsh', role: 'Small agency owner', company: 'Walsh Creative' },
    persona: 'Reasonable but firm, feels misled by the sales rep about a feature. Will escalate publicly if brushed off.',
    hidden: [
      'He was promised a client-portal feature that is actually launching next month.',
      'He likes the product; his team uses it daily.',
      'Early access to the portal plus a couple of free months would keep him.',
    ],
    goal: 'Keep him as a customer without breaking policy.',
    win: 'He stays, with a remedy that is not a full refund.',
    lose: 'He escalates, or you give a full refund immediately.',
    opening: "Hi. I want a refund on our annual plan. Your sales guy told me we'd have client portals and we don't. That's the whole reason we bought it.",
    skills: ['discovery', 'pushback', 'close'],
  },
  {
    id: 'vc-pitch',
    category: 'founders',
    title: 'Pitch a skeptical VC',
    emoji: '🚀',
    blurb: 'Partner meeting. She has seen 40 companies like yours this year.',
    youAre: 'Founder of Shiftly, scheduling software for restaurants. $40k MRR, growing 12% monthly, raising a $3M seed.',
    them: { name: 'Elena Varga', role: 'Partner', company: 'Northstar Ventures' },
    persona: 'Sharp, fast, pattern-matches everything to "crowded market". Asks about moats and why now. Warms to crisp answers and founder insight.',
    hidden: [
      'She lost a deal in this space and regrets it.',
      'She cares most about retention and distribution, not features.',
      'A specific, surprising insight about restaurant ops wins her attention.',
    ],
    goal: 'Get to a second meeting with the full partnership.',
    win: 'She invites you back to pitch the partnership.',
    lose: 'She says "we\'ll pass for now" or "come back when you have more traction".',
    opening: "Thanks for coming in. I'll be honest, we've looked at a lot of restaurant scheduling tools. What makes you different?",
    skills: ['clarity', 'pushback', 'close'],
  },
  {
    id: 'cofounder-equity',
    category: 'founders',
    title: 'The equity conversation',
    emoji: '⚖️',
    blurb: 'Your co-founder wants 50/50. You have been at it a year longer.',
    youAre: 'Founder who built the product alone for 14 months before bringing on a technical co-founder 3 months ago.',
    them: { name: 'Sam Patel', role: 'Technical co-founder', company: 'Your startup' },
    persona: 'Loyal, talented, quietly anxious about being "just an employee". Reads any imbalance as disrespect at first.',
    hidden: [
      'Sam left a well-paid job and feels the risk acutely.',
      'Vesting with a cliff and a clear title matter more to Sam than the exact split.',
      'A 60/40 with acceleration on key milestones would feel fair if explained well.',
    ],
    goal: 'Agree a split that reflects history without damaging the partnership.',
    win: 'Sam agrees to a split and vesting structure, and the relationship feels intact.',
    lose: 'Sam feels disrespected and talks about leaving, or you give 50/50 to avoid conflict.',
    opening: "So, I talked to my lawyer friend. Standard for co-founders is fifty-fifty. I think that's what's fair here.",
    skills: ['rapport', 'clarity', 'pushback'],
  },
  {
    id: 'landlord-lease',
    category: 'negotiation',
    title: 'Negotiate your lease renewal',
    emoji: '🏢',
    blurb: 'Your landlord wants 18% more. Moving the shop would cost a fortune.',
    youAre: 'Owner of an independent coffee shop. Rent is $6,200/month; the landlord wants $7,300 on renewal.',
    them: { name: 'Victor Hale', role: 'Property owner', company: 'Hale Properties' },
    persona: 'Businesslike, claims "market rate". Hates vacancy more than he admits. Values reliable tenants.',
    hidden: [
      'Two other units in the building have been empty for six months.',
      'He needs the building to look occupied to refinance.',
      'A longer lease at a smaller increase is attractive to him.',
    ],
    goal: 'Renew at $6,700/month or less.',
    win: 'He agrees to $6,700/month or less, or an equivalent package.',
    lose: 'You accept more than $6,700, or bluff about leaving and he calls it.',
    opening: "Thanks for meeting. Look, the market's moved. Seventy-three hundred is still below what I could get for that corner.",
    skills: ['discovery', 'pushback', 'close'],
  },
];

const SKILLS = {
  rapport: 'Rapport',
  discovery: 'Discovery',
  pushback: 'Handling pushback',
  clarity: 'Clarity',
  close: 'Closing',
};

const byId = new Map(SCENARIOS.map((s) => [s.id, s]));

function get(id) {
  return byId.get(String(id || '')) || null;
}

/** What the browser may see. The hidden motivations are the puzzle. */
function publicView(s) {
  if (!s) return null;
  return {
    id: s.id,
    category: s.category,
    title: s.title,
    emoji: s.emoji,
    blurb: s.blurb,
    youAre: s.youAre,
    them: s.them,
    goal: s.goal,
    win: s.win,
    opening: s.opening,
    skills: s.skills,
    custom: Boolean(s.custom),
  };
}

/* ------------------------------------------------------------------ *
 * The daily challenge
 * ------------------------------------------------------------------ */

// A twist per day, so the same scenario never plays the same way twice. They
// are small changes to circumstance rather than to the persona, because a
// different person would make yesterday's leaderboard incomparable.
const TWISTS = [
  'They have exactly five minutes before another meeting and will say so.',
  'They were burned by a vendor/partner just like you last year.',
  'They are in an unusually good mood today - but still have their reasons.',
  'Their boss is sitting in on the call and they want to look tough.',
  'They just read a news story that makes your position look weaker.',
  'They are distracted and will test whether you are worth their attention.',
  'They open by mistaking you for someone else, and are embarrassed about it.',
];

function hash(str) {
  let h = 2166136261;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function daily(key = dayKey()) {
  const h = hash(`spar:${key}`);
  const scenario = SCENARIOS[h % SCENARIOS.length];
  const twist = TWISTS[(h >>> 8) % TWISTS.length];
  return { day: key, scenarioId: scenario.id, twist, difficulty: 'realistic' };
}

module.exports = { SCENARIOS, CATEGORIES, DIFFICULTIES, SKILLS, TWISTS, get, publicView, daily, dayKey, hash };
