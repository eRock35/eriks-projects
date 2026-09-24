// The lab's registry: every trial app, in the order they dropped.
//
// Adding an app is one entry here plus its folder in apps/<slug>. The host
// mounts it at /<slug>/, gives its collections the `<slug>_` prefix in the
// shared `challenge` database, and the landing page draws its card from this.
//
// `status`:
//   testing    - live in the lab, open for votes
//   graduated  - moved to its own subdomain; the card links there instead
//   retired    - killed; the card stays as a tombstone, the app is unmounted

const APPS = [
  {
    slug: 'spar',
    name: 'Spar',
    emoji: '🥊',
    color: '#ff5a36',
    color2: '#ff8a3d',
    dropped: '2026-09-24',
    tagline: 'Practise the hard conversation before it counts.',
    blurb: 'Spar against an AI counterpart with real reasons to say no — a cold-called CFO, a procurement lead with a cheaper quote, your boss when you ask for a raise. Their mood moves with every line, they are hiding what would really move them, and a coach scores you at the end.',
    features: ['Live mood meter + hidden motives', 'Coach’s scorecard & replay', 'Daily challenge leaderboard', 'Teams: assign drills to your reps'],
    audience: 'Sales teams, managers, anyone negotiating',
    status: 'testing',
  },
  {
    slug: 'snapquote',
    name: 'Snapquote',
    emoji: '📸',
    color: '#10b981',
    color2: '#06b6d4',
    dropped: '2026-09-24',
    tagline: 'A few photos and a voice note become a pro quote in 60 seconds.',
    blurb: 'For painters, landscapers, handymen, cleaners and every small service business that loses jobs to whoever quotes first. Snap the job, describe it, and get an itemized quote with good/better/best options — then send a branded link your customer can accept and sign.',
    features: ['Photo + voice → itemized quote', 'Good / Better / Best tiers', 'Branded link customers sign', 'Pipeline & win-rate scoreboard'],
    audience: 'Trades & small service businesses',
    status: 'testing',
  },
  {
    slug: 'chaser',
    name: 'Chaser',
    emoji: '💸',
    color: '#7c5cff',
    color2: '#ff5fa2',
    dropped: '2026-09-24',
    tagline: 'Get paid without the awkward part.',
    blurb: 'For freelancers, agencies and small service businesses owed money. Add what you’re owed — or snap the invoice — and Chaser tells you who to chase today, writes the chase in your own voice, and turns every “paid” into a small celebration.',
    features: ['Today’s chase list, ranked by what matters', 'Nudge → firm → final, in your voice', 'Client scorecards & a 4-week cash forecast', 'Printable statements with a share link'],
    audience: 'Freelancers, agencies & small service businesses',
    status: 'testing',
  },
  {
    slug: 'rave',
    name: 'Rave',
    emoji: '⭐',
    color: '#d97706',
    color2: '#e11d48',
    dropped: '2026-09-24',
    tagline: 'Answer every review like a pro — even the ones that sting.',
    blurb: 'For restaurants, salons, contractors, clinics and shops that live on their stars. Paste or screenshot a review and Rave triages it, drafts a reply in your voice, and cools down the angry one before you post it — with a checklist that catches the mistakes that go viral.',
    features: ['Review inbox with triage & risk flags', 'Replies in your voice, or free templates', 'Cool down: a heat meter for angry replies', 'Scoreboard, streaks & a wall of love'],
    audience: 'Restaurants, salons, contractors, clinics & shops',
    status: 'testing',
  },
  {
    slug: 'popquiz',
    name: 'Pop Quiz',
    emoji: '🧠',
    // Both ends hold white text at 4.5:1 or better, including under the
    // card's white highlight in the top corner.
    color: '#1e40af',
    color2: '#6b21a8',
    dropped: '2026-09-24',
    tagline: 'Staff training that plays like a daily game.',
    blurb: 'For any small team with new hires and rules that must stick. Paste the menu or the closing checklist — or snap the page — approve the questions, and your staff play five a day. Misses come back tomorrow, and you see what the whole team keeps getting wrong.',
    features: ['Paste or snap the binder → a quiz', 'Five a day, streaks & a leaderboard', 'Misses come back until they stick', 'Blind spots: what to retrain'],
    audience: 'Restaurants, shops, salons, clinics, gyms & hotels',
    status: 'testing',
  },
];

function slugs() { return APPS.map((a) => a.slug); }
function get(slug) { return APPS.find((a) => a.slug === slug) || null; }

module.exports = { APPS, slugs, get };
