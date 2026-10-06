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
  {
    slug: 'glowup',
    name: 'Glowup',
    emoji: '✨',
    // Plum to ember, dark enough that white text holds 4.5:1 at both ends
    // and in the middle under the card's white highlight.
    color: '#6d1b7b',
    color2: '#8c2410',
    dropped: '2026-09-25',
    tagline: 'Give your listing a glow-up — and watch the score climb.',
    blurb: 'For hosts, Etsy and eBay sellers and local pros whose sales hang on one listing. Paste it or snap it for a 0–100 score with a fix for every point, then a rewrite that never invents a fact — scored by the same rules, so the jump is real.',
    features: ['A 0–100 glow score with five rings', 'A fix for every point you lose', '3 titles, new copy & a shot list', 'Versions, a streak & a share card'],
    audience: 'Airbnb & Vrbo hosts, Etsy & eBay sellers, local pros',
    status: 'testing',
  },
  {
    slug: 'booth',
    name: 'Booth',
    emoji: '🎪',
    // Tent red to navy. White text holds 4.5:1 at both ends and at the
    // midpoint under the card's white highlight (4.9:1 there, the worst spot).
    color: '#991b1b',
    color2: '#1e3a8a',
    dropped: '2026-09-25',
    tagline: 'Trade-show leads that don’t go cold.',
    blurb: 'For small teams who work trade shows, conferences, markets and pop-ups. Capture a lead in ten seconds — type it or snap the card — tap hot, warm or cold, and every lead gets a follow-up clock. A live booth leaderboard, then a scorecard: did the show pay off?',
    features: ['10-second capture, or snap the card', 'A going-cold clock on every lead', 'Follow-ups in your voice, or free', 'Booth leaderboard & ROI scorecard'],
    audience: 'Founders, reps & makers at shows, markets & pop-ups',
    status: 'testing',
  },
  {
    slug: 'receipt',
    name: 'Receipt',
    emoji: '🧾',
    // Register teal to receipt-ink crimson. White text holds 9.6:1 or better
    // at both ends and 5.0:1 at the worst spot, the midpoint under the card's
    // white highlight.
    color: '#0f4c45',
    color2: '#881337',
    dropped: '2026-09-25',
    tagline: 'Every meeting gets a receipt.',
    blurb: 'For anyone who runs or sits in meetings. Receipt prices the meeting live from role bands, rings every agenda item with its overrun in dollars, lets the room vote from their phones, and prints a receipt at the end — with TIME GIVEN BACK when you finish early.',
    features: ['Live cost ticker & agenda rings', 'Room vote by QR, plus bingo', 'A receipt with time given back', 'Keep / Shrink / Kill the repeats'],
    audience: 'Team leads, founders, PMs & anyone who books the weekly sync',
    status: 'testing',
  },
  {
    slug: 'tally',
    name: 'Tally',
    emoji: '🧮',
    // Ledger green to copper. White text holds 10:1 or better at both ends
    // and 5.0:1 at the worst spot, the midpoint under the card's white
    // highlight.
    color: '#0e4526',
    color2: '#72290c',
    dropped: '2026-09-26',
    tagline: 'Close the day in a minute. Know every card sale got paid.',
    blurb: 'For cafés, shops, salons and restaurants. Type or snap the day’s card totals, drop in your bank’s CSV, and Tally matches every day to its deposit: matched, short, pending or missing, in plain words. A short payout, a lost batch or fee creep can’t slip by.',
    features: ['Close the day in 4 numbers, or snap it', 'Bank CSV in, card payouts picked out', 'Matched · short · pending · missing', 'Month heatmap, fee creep & export'],
    audience: 'Cafés, shops, salons & restaurants that take cards',
    status: 'testing',
  },
  {
    slug: 'tipout',
    name: 'Tipout',
    emoji: '💵',
    // Bar-room burgundy to dollar green. White text needs 4.5:1 across the
    // gradient; npm run og darkens further if it does not hold.
    color: '#6b1530',
    color2: '#14532d',
    dropped: '2026-09-27',
    tagline: 'Split the tip pool in a minute. Show everyone the working.',
    blurb: 'For bars, restaurants and coffee shops that pool tips. Pick who worked, set their hours, enter card and cash tips, and Tipout splits the pool by hours, points or tip-outs, down to the cent. It builds each person\u2019s cash envelope from the bills in the drawer, and a receipt link shows staff exactly how their share was worked out.',
    features: ['Hours, points or tip-out rules', 'Split to the cent, every cent paid out', 'Cash envelopes from the bills you have', 'A receipt link that shows the working'],
    audience: 'Bars, restaurants & coffee shops that pool tips',
    status: 'testing',
  },
  {
    slug: 'tells',
    name: 'Tells',
    emoji: '🔎',
    // Ink violet to highlighter crimson. White text holds 4.5:1 at both ends
    // and across the gradient; npm run og darkens further if it does not.
    color: '#2e1a5e',
    color2: '#8a1538',
    dropped: '2026-09-27',
    tagline: 'See the tells of AI in a post, a page, a picture or a video.',
    blurb: 'Paste a post, give a link, or drop a picture or a video. Tells highlights the exact passages and signals that read as AI, gives a likelihood with how sure it is, reads Content Credentials and generator metadata, and checks separately whether the ideas are original, with the earlier sources it found. Evidence, not a verdict.',
    features: ['Highlights every tell, with its reason', 'A likelihood with a confidence band', 'Content Credentials & generator metadata', 'Originality check with earlier sources'],
    audience: 'Anyone reading LinkedIn, X or the news, and anyone hiring or grading',
    status: 'testing',
  },
  {
    slug: 'covenant',
    name: 'Covenant',
    emoji: '📜',
    // Bank green to navy. White text holds well over 4.5:1 at both ends and
    // across the gradient; npm run og darkens further if it does not.
    color: '#0f4a30',
    color2: '#1b2c52',
    dropped: '2026-09-28',
    tagline: 'Know what your business loan expects of you - before the bank tells you.',
    blurb: 'For small businesses with a bank or SBA loan, and the lenders who serve them. Paste the agreement or snap its pages and Covenant lists every covenant in plain English, each checked against the document\u2019s own words. A free health check says how much headroom you have in dollars, reporting deadlines go straight to your calendar, and each covenant comes with a plain explanation a lender\u2019s staff can hand a customer.',
    features: ['Reads the agreement, quotes checked', 'Health check with headroom in dollars', 'Deadlines straight to your calendar', 'Explanations lender staff can share'],
    audience: 'Small businesses with a bank or SBA loan, and the lenders who serve them',
    status: 'testing',
  },
  {
    slug: 'hike',
    name: 'Hike',
    emoji: '🏷️',
    // Price-tag rust to plum. White text holds well over 4.5:1 at both ends
    // and across the gradient; npm run og darkens further if it does not.
    color: '#8f2d0f',
    color2: '#4a1942',
    dropped: '2026-09-29',
    tagline: 'Raise your prices without losing your regulars.',
    blurb: 'For cafés, salons, trades and shops that haven\u2019t raised prices in a while. Hike tells you in one sentence how many customers you could lose and still make more, rounds your price list like a pro and holds it under $10, writes the announcement and the counter script for when someone asks why, and a tracker tells you afterwards whether it worked.',
    features: ['Your break-even in one sentence', 'A price list rounded like a pro', 'The announcement & counter script', 'A tracker that says if it worked'],
    audience: 'Cafés, salons, trades & shops that haven\u2019t raised prices in a while',
    status: 'testing',
  },
  {
    slug: 'dibs',
    name: 'Dibs',
    emoji: '🙋',
    // Basil to tomato - the salad and the steak on one bill. White text
    // holds 4.5:1 at both ends; npm run og darkens further if it does not.
    color: '#3f6212',
    color2: '#b3261e',
    dropped: '2026-09-29',
    tagline: 'Split the bill by what everyone actually had.',
    blurb: 'Snap or paste the receipt and share a QR code: everyone at the table taps what they had on their own phone, no account needed for friends. Shared plates, tax and tip are split fairly to the cent, the maths is checked against the printed total, and each person gets a Venmo, Cash App or PayPal link to whoever paid.',
    features: ['Snap or paste the receipt', 'Everyone taps their own, no account', 'Tax & tip split fairly to the cent', 'Pay links to whoever paid'],
    audience: 'Friends, couples, roommates & anyone who\u2019s ever done the bill maths at the table',
    status: 'testing',
  },
  {
    slug: 'leash',
    name: 'Leash',
    emoji: '🦮',
    // Slate teal to a warning amber-brown - calm control, and the worst
    // day's colour. White text holds well over 4.5:1 at both ends; npm run
    // og darkens further if it does not.
    color: '#1d4e5f',
    color2: '#8a4a0b',
    dropped: '2026-09-30',
    tagline: 'Know what your AI agent can do - before it does it.',
    blurb: 'For teams putting an AI agent in front of customers, money or data. Tick what it can do or paste its prompt, and Leash gives a blast-radius score and its worst day in dollars ("it could refund $240,000 before anyone looks"), the fixes that drop the score most, a timed bad-day drill that scores how ready you really are, and a one-page charter with a kill switch.',
    features: ['A blast-radius score and the worst day in dollars', 'Fixes ranked by how much they drop it', 'A timed bad-day drill', 'A one-page charter with a kill switch'],
    audience: 'Teams putting an AI agent in front of customers, money or data',
    status: 'testing',
  },
  {
    slug: 'drip',
    name: 'Drip',
    emoji: '💧',
    // Deep ocean blue to deep teal - water, calm, money staying put. White
    // text holds well over 4.5:1 at both ends; npm run og darkens further
    // if it does not.
    color: '#0b4a8f',
    color2: '#0f6466',
    dropped: '2026-10-01',
    tagline: 'Find every subscription quietly draining your account.',
    blurb: 'Drop in your bank or card CSV - read on your phone, never uploaded - and Drip finds every recurring charge, what it costs a year, the price creeps and the trials that turned paid. Swipe keep or cut, watch the savings add up, and get reminders before the next charge.',
    features: ['Your statement read on your phone, never uploaded', 'Every drip with its cost a year', 'Price creeps, trials and doubles flagged', 'Swipe keep or cut, reminders before the charge'],
    audience: 'Anyone with a bank account who suspects they\u2019re paying for things they don\u2019t use',
    status: 'testing',
  },
  {
    slug: 'boxed',
    name: 'Boxed',
    emoji: '🗂️',
    // Ledger green-grey to tax-form violet - greyer than Covenant's bank
    // green and ending in violet, not navy. White text holds well over 4.5:1
    // at both ends; npm run og darkens further if it does not.
    color: '#405c55',
    color2: '#3a2d74',
    dropped: '2026-10-02',
    tagline: 'Every K-1 box read, checked and rolled up - in minutes, not hours.',
    blurb: 'For preparers with partnership-heavy clients. Drop in the Schedule K-1 PDFs and Boxed reads every box and code with the page it came from, checks Item L and the boxes for keying errors, rolls them up across the client, tracks the K-1s still missing with reminders and a chase list, and exports CSV. Files are read once and not kept; partner TINs are never stored.',
    features: ['Every box and code read, with its page', 'Item L and the boxes checked for keying errors', 'A roll-up across the client, CSV out', 'What\u2019s still missing, with reminders'],
    audience: 'CPA firms, tax preparers and investors with a stack of K-1s',
    status: 'testing',
  },
  {
    slug: 'insidejoke',
    name: 'Inside Joke',
    emoji: '🤫',
    // Lagoon teal to party fuchsia - a game night, not a ledger. White text
    // holds 5.4:1 and 6.3:1; npm run og darkens further if it does not.
    color: '#0e7490',
    color2: '#a21caf',
    dropped: '2026-10-02',
    tagline: 'Trivia made from your own photos and group chat - play together, even miles apart.',
    blurb: 'Make a group for your family or friends and everyone joins with a code, no account. Questions come from your own photos (where was this, what year, who took it, caption this), your group chat read on your phone (who\u2019s the night owl, who said it?) and whatever you write. Play five a day on your own time with a leaderboard and streaks, or live together on a video call.',
    features: ['Questions from your own photos and group chat', 'Five a day, on your own time, with streaks', 'Live game night on everyone\u2019s phone', 'Members join with a code, no account'],
    audience: 'Families and friend groups, near or far',
    status: 'testing',
  },
  {
    slug: 'flight',
    name: 'Flight',
    emoji: '🍻',
    // Golden ale to stout - the two ends of a tasting flight. White text
    // holds 5.3:1 and 15:1; npm run og darkens further if it does not.
    color: '#946000',
    color2: '#3d1f0c',
    dropped: '2026-10-02',
    tagline: 'Blind tastings and beer games for your crew - in the same bar or different cities.',
    blurb: 'Everyone brings a beer, it gets a shuffled letter, and the crew scores it blind - stars, a style guess, an ABV guess - then guesses who brought what before the reveal hands out awards. Apart? A Same-Can Challenge has everyone score the same beer on their own time from wherever they are. Vote on the next brewery (paste a Hopscotch crawl link), keep a crew leaderboard, and swap what\u2019s in your fridge: have/want lists that match across the crew, swaps in person, and gifts through a licensed seller for a friend far away. Friends join with a code, no account.',
    features: ['Blind tastings with shuffled letters and awards', 'Guess who brought it, or a Same-Can Challenge when you\u2019re apart', 'Vote on the next one, crew leaderboard', 'Cellar & Swap: have/want matches, in-person swaps, gifts via licensed sellers'],
    audience: 'Beer crews, homebrew clubs and anyone who argues about IPAs',
    status: 'testing',
  },
  {
    slug: 'shadow',
    name: 'Shadow',
    emoji: '🔦',
    // Midnight slate to a flashlight's amber: finding what is in the dark.
    // White text holds over 4.5:1 at both ends; npm run og darkens further
    // if it does not.
    color: '#243048',
    color2: '#8a3c08',
    dropped: '2026-10-03',
    tagline: 'Find the software your team signed up for without asking.',
    blurb: 'Free trials turn into tools full of customer, staff or student data that nobody approved, owns or has a contract for. Drop in the company card statement and your Google Workspace or Microsoft 365 app-access export - read on your device, never uploaded - and Shadow lists every tool with who approved it, what data it holds, what access it was granted and what it costs. A risk score, the fixes that lower it most, a trial and renewal radar, a link staff use to ask first, and AI that reads a vendor\u2019s terms with every quote checked.',
    features: ['Card and sign-in exports read on your device, never uploaded', 'A Shadow score and the fixes that lower it most', 'Trials and renewals on a radar, with calendar reminders', '\u201cCan I use this?\u201d requests from staff, no account needed'],
    audience: 'IT, ops and finance at small companies, schools and public agencies',
    status: 'testing',
  },
  {
    slug: 'chorus',
    name: 'Chorus',
    emoji: '\u{1F9F9}',
    // Fresh sage to plum: a clean kitchen, then a calm evening. White text
    // holds 7:1 or better at both ends.
    color: '#3f6212',
    color2: '#6b21a8',
    dropped: '2026-10-04',
    tagline: 'Chores split fairly - and everyone can see it.',
    blurb: 'For roommates, couples and families. Chorus deals the week\u2019s chores by how big each job is, how much each person can take on (kids count half), what they can\u2019t do, and who had the worst one last time - and says why in plain words. Tick yours, swap what you can\u2019t get to, nudge without nagging, and the Fairness tab shows who\u2019s really carrying the house. Everyone joins with a code, no account.',
    features: ['A fair rotation weighed by effort and capacity', 'Tick, swap and nudge from everyone\u2019s phone', 'Fairness: who did what this month, in one line', 'Starter chores for roommates, couples and families, or snap a room for AI suggestions'],
    audience: 'Roommates, couples and families who share a home',
    status: 'testing',
  },
  {
    slug: 'tieout',
    name: 'Tieout',
    emoji: '\u{1FAA2}',
    // Rope red to ledger navy, the knot's two colours. White text holds
    // 8.2:1 and 14.5:1.
    color: '#9b1c1c',
    color2: '#13294b',
    dropped: '2026-10-05',
    tagline: 'Any bank statement PDF to a clean CSV - proven to tie out to the penny.',
    blurb: 'For bookkeepers and small businesses who re-key statements. Drop in any bank or card statement PDF (or photos of it) and Tieout reads every row, then proves it against the statement\u2019s own arithmetic - opening plus every row equals closing, the running balance row by row - and names the exact row that was misread, with the fix. Edit any cell, re-read one page, check a CSV you already have for free, and export CSV, QuickBooks Online, Xero or OFX. Statements are read once and not kept.',
    features: ['Any bank\u2019s PDF or photos, read by AI', 'Proven to tie out - the wrong row named', 'Fix in one tap, or re-read one page', 'CSV, QuickBooks, Xero or OFX, months merged'],
    audience: 'Bookkeepers, accountants and small-business owners',
    status: 'testing',
  },
  {
    slug: 'shelflife',
    name: 'Shelf Life',
    emoji: '\u{1F96C}',
    // Leaf green to tomato. White text holds 6.4:1 and 7.3:1.
    color: '#2f6b3a',
    color2: '#9a3412',
    dropped: '2026-10-06',
    tagline: 'Eat what\u2019s about to go off first - and stop binning food.',
    blurb: 'For households, couples and roommates who keep finding the spinach has turned. Shelf Life sorts your fridge, freezer and pantry by what needs eating - past its date, today, tomorrow, this week - ranks forty-odd simple recipes by how much of it they use up, and keeps score: eaten vs binned, money rescued, your no-waste streak, and what you keep binning. Add food in taps from 150 everyday foods, or snap the fridge or a receipt. Share one kitchen with the household by code, no account.',
    features: ['Eat-first board: today, tomorrow, this week', 'Tonight: recipes that use what\u2019s going off', 'Saved: eaten vs binned, streaks, money rescued', '150 foods in taps, or snap the fridge with AI'],
    audience: 'Households, couples and roommates who share a fridge',
    status: 'testing',
  },
];

function slugs() { return APPS.map((a) => a.slug); }
function get(slug) { return APPS.find((a) => a.slug === slug) || null; }

module.exports = { APPS, slugs, get };
