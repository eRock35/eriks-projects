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
  {
    slug: 'burnrate',
    name: 'Burnrate',
    emoji: '\u{1F525}',
    // Ember orange to night indigo. White text holds 7.3:1 and 11.4:1.
    color: '#9a3412',
    color2: '#312e81',
    dropped: '2026-10-07',
    tagline: 'See where your coding agent\u2019s tokens go - and cut the waste.',
    blurb: 'For engineering leads, founders and developers paying for Claude Code. Drop in your ~/.claude/projects folder - read on your device, never uploaded - and Burnrate prices every turn at list prices: by day, project, model, session and person, subagents apart, with a projected month. Then it finds the waste - caches gone cold, files re-read, giant test logs, bloated sessions, loops, big models on small turns, subagents duplicating each other - each with dollars attached and a fix to paste into CLAUDE.md. Compare the team, export Markdown, CSV or a summary card, and let AI write your fixes from the numbers alone.',
    features: ['Transcripts read on your device, never uploaded', 'Seven waste patterns, each with dollars and a fix', 'Team view with a seat-cost line, by day and person', 'Markdown, CSV and a share card; AI writes your CLAUDE.md fixes'],
    audience: 'Engineering leaders, founders and developers paying for coding agents',
    status: 'testing',
  },
  {
    slug: 'pickup',
    name: 'Pickup',
    emoji: '\u{1F3C0}',
    // Court orange to navy. White text holds 5.2:1 and 10.4:1.
    color: '#c2410c',
    color2: '#1e3a8a',
    dropped: '2026-10-08',
    tagline: 'Who\u2019s in, fair teams, and who owes for the court.',
    blurb: 'For anyone who runs a weekly pickup game - basketball, five-a-side, volleyball, pickleball, ultimate, padel - out of a group chat. Everyone taps In, Maybe or Out from a link, no app and no account; past the cap there\u2019s a waitlist, and when someone drops the next one\u2019s in. One tap makes even teams by skill, positions and who should play apart, results build a season with streaks and a Player of the Week vote, and the court cost is split among who actually played, with Paid ticks and a reminder ready to paste. Paste the group chat and Pickup reads the replies for you.',
    features: ['In / Maybe / Out with a cap and a waitlist', 'Fair teams in one tap, reshuffle for a new split', 'Season standings, streaks, Player of the Week', 'Court money split among who played, no chasing'],
    audience: 'Anyone who organises a weekly pickup game or rec group',
    status: 'testing',
  },
  {
    slug: 'parity',
    name: 'Parity',
    emoji: '\u2696\uFE0F',
    // Deep teal to slate night. White text holds 6.8:1 and 12.2:1.
    color: '#0b6474',
    color2: '#0b3b45',
    dropped: '2026-10-09',
    tagline: 'Prove the migrated data matches - without it leaving your machine.',
    blurb: 'For data engineers, platform leads and DBAs moving a table between schemas or systems where the data can\u2019t go to a cloud diff tool. Drop the table before and after - CSV, TSV or JSON Lines, up to about 1 GB each, read on your device and never uploaded. Parity pairs the columns, learns the rules from rows that share a key (trim, cents to dollars, date formats, code tables) and names every missing, duplicated or changed row with its key and what happened to it - truncated, shifted by hours, null turned empty. Aggregates side by side, a sign-off report in HTML, Markdown or JSON, and fingerprints for two machines that can\u2019t share data at all.',
    features: ['Read on your device, works with the network off', 'Columns mapped and rules learned, no code', 'Every problem named, with keys and before \u2192 after', 'Fingerprints compare two air-gapped machines'],
    audience: 'Data engineers, platform leads and DBAs running migrations',
    status: 'testing',
  },
  {
    slug: 'sprout',
    name: 'Sprout',
    emoji: '\u{1F331}',
    // Leaf green to watering-can blue. White text holds 6.5:1 and 8.5:1.
    color: '#2d6a3e',
    color2: '#0d4f86',
    dropped: '2026-10-10',
    tagline: 'Know which plants need you today - and hand them to a plant-sitter in one link.',
    blurb: 'For anyone with houseplants, from one pothos to a jungle, who waters on vibes, drowns some and forgets others, and panics before a trip. Pick from 89 common plants and Sprout sorts them every morning - thirsty today, check the soil, coming up, happy - learns each plant\u2019s real pace from every \u201cNot yet\u201d, stretches the gaps in winter, warns when one sits in the wrong light, and keeps a streak, a history and a photo diary. Going away? One link gives your sitter a day-by-day list to tick off, and the plan lives in the link itself - nothing stored on a server. Not sure what it is, or why it\u2019s yellowing? Snap it and AI takes a look.',
    features: ['Today board: thirsty, check soil, coming up, happy', 'Learns each plant\u2019s pace, longer in winter', 'Plant-sitter link: a day-by-day list, no app, no server', '89 plants with care and pet safety; AI reads a photo'],
    audience: 'Anyone with houseplants - especially the ones who travel',
    status: 'testing',
  },
  {
    slug: 'lanes',
    name: 'Lanes',
    emoji: '\u{1F6A6}',
    // Lane teal to night asphalt. White text holds 6.1:1 and 16.5:1.
    color: '#0b6e64',
    color2: '#15202b',
    dropped: '2026-10-11',
    tagline: 'Run coding agents in parallel without them stepping on each other.',
    blurb: 'For developers and engineering leads running several coding agents at once - Claude Code, Codex, Cursor - or several people on parallel branches. Copy one command, run it in your repo, and Lanes reads every branch\u2019s changes on your device (nothing is uploaded) and shows what will collide before you merge: the same lines changed twice, lockfiles, two migrations numbered 0042, version bumps, the same helper written twice - then the merge order that needs the fewest rebases, with the commands. Starting fresh? Plan a lane per agent from your real file tree, with rules for shared files, reserved migration numbers and a brief for each agent - or let AI split the tasks from your file paths alone.',
    features: ['Diffs read on your device, never uploaded', 'Collisions by line, lockfiles, migrations, duplicate helpers', 'A merge order with the fewest rebases, and the commands', 'Lanes and a brief per agent; AI splits tasks from paths only'],
    audience: 'Developers and engineering leads running coding agents in parallel',
    status: 'testing',
  },
  {
    slug: 'glovebox',
    name: 'Glovebox',
    emoji: '\u{1F9E4}',
    // Dashboard blue to night dash. White text holds 8.1:1 and 15.6:1.
    color: '#1d4f91',
    color2: '#1b2433',
    dropped: '2026-10-12',
    tagline: 'Know what your car needs next - and what that warning light means.',
    blurb: 'For any driver whose only record is the oil-change sticker, who can\u2019t remember when the tyres were rotated, panics at an orange light on the dash, and has nothing to show a buyer. Tell Glovebox your car and the odometer, and it builds a maintenance plan - oil, tyres, brakes, filters, battery, renewals; no oil changes on an EV - then sorts what\u2019s due into overdue, due soon, coming up and all good, by miles or months, whichever comes first, projected from how far you actually drive. Pick a warning light by colour and shape for what it means and what to do - red always says stop safely. Log services and costs, keep receipt photos on your phone, and hand a buyer a tidy service history in one link that nothing on a server ever sees. AI reads a dashboard or receipt photo if you want.',
    features: ['What\u2019s due: miles or months, whichever comes first', '42 warning lights by colour and shape, free', 'Service log, costs and cost per mile on your phone', 'A buyer\u2019s service history in one link; AI reads photos'],
    audience: 'Any driver - especially before a road trip, or when it\u2019s time to sell',
    status: 'testing',
  },
  {
    slug: 'triage',
    name: 'Triage',
    emoji: '\u{1FA7A}',
    // Triage crimson to night slate. White text holds 8.0:1 and 16.1:1.
    color: '#9b1c3a',
    color2: '#1b2130',
    dropped: '2026-10-13',
    tagline: 'Review the giant AI-written PR in the order that matters - and skim the rest with a clear conscience.',
    blurb: 'For engineering leads and reviewers whose coding agents now open 3,000-line pull requests several times a day. Paste the diff, or run one command - Triage reads it on your device (nothing is uploaded) and sorts the real changes from the renames, reformatting, lockfile churn, snapshots and generated code. What\u2019s left is ranked by what it touches - permission checks, migrations, routes with no test, config defaults, new dependencies, secrets and hidden characters - with why and what to look for. You get a review plan with a time estimate, the one check that makes skimming each group safe, a split into smaller stacked PRs with the git commands and a comment for the author, and a report for the PR. AI explains one hunk if you ask, after you see exactly what it would send.',
    features: ['Diffs read on your device, never uploaded', 'Mechanical vs meaningful, line by line, conservatively', 'A risk-ordered review plan with checklists and checks', 'Split it into stacked PRs, with the commands'],
    audience: 'Engineering leads and reviewers facing large AI-written pull requests',
    status: 'testing',
  },
  {
    slug: 'settle',
    name: 'Settle',
    emoji: '\u{1F91D}',
    // Settle violet to deep berry. White text holds 7.1:1 and 7.9:1.
    color: '#6d28d9',
    color2: '#9d174d',
    dropped: '2026-10-14',
    tagline: 'Where are we eating? Settle it in a minute.',
    blurb: 'For friends, couples, families and housemates stuck in the group-chat loop of \u201cI don\u2019t mind, what do you want?\u201d - dinner, a takeaway, a movie, the weekend plan, a holiday spot. Ask once, pick options or a ready-made deck, and drop one link in the chat: everyone swipes Yes, No or Love on their own phone, no app and no account, and nobody sees anyone\u2019s votes until the reveal. The first thing everyone said yes to is the match; a tie spins a wheel that lands the same on every phone. Rank-a-top-3 mode runs ranked choice and explains every round, everyone gets one veto, and AI can fill the deck with ideas.',
    features: ['Everyone swipes Yes, No or Love - no app, no account', 'It\u2019s a match: the first thing everyone said yes to', 'Ranked choice with every round in words, one veto each', 'Built-in decks for dinner, movies, date night and more'],
    audience: 'Friends, couples and families who can\u2019t decide where to eat',
    status: 'testing',
  },
  {
    slug: 'zoned',
    name: 'Zoned',
    emoji: '\u{1F6A7}',
    // Hazard orange to night slate. White text holds 6.3:1 and 15.6:1.
    color: '#a3420c',
    color2: '#1c2433',
    dropped: '2026-10-15',
    tagline: 'Find the building and fridge controllers on your till network - and fence them off.',
    blurb: 'For IT directors and single-site IT generalists at grocers, convenience stores, restaurants, clinics and small offices, where the HVAC or refrigeration contractor plugged their controllers - and often a cellular modem - into the same flat network as the tills, the office PCs and the guest Wi-Fi. Bring a scan you already ran (nmap, an ARP table or the router\u2019s DHCP list): Zoned reads it on your device - it never scans anything and nothing is uploaded - and names every device with why it thinks so, from the maker names, ports and banners. You get the findings in plain words, six zones with every device placed, default-deny firewall rules, steps for UniFi, Meraki, pfSense and FortiGate, a checklist and a letter for the contractor, and a report. AI suggests what the unknowns are if you ask, after you see exactly what it would send - never an address.',
    features: ['Scans read on your device; Zoned never scans anything', 'Refrigeration, HVAC and remote-access boxes found, with why', 'Six zones, every device placed, default-deny firewall rules', 'A contractor checklist and letter with the exact ports'],
    audience: 'Store and small-office IT people with a contractor\u2019s controllers on the till network',
    status: 'testing',
  },
  {
    slug: 'jars',
    name: 'Jars',
    emoji: '\u{1FAD9}',
    // Jar purple to berry. White text holds 8.4:1 and 7.2:1.
    color: '#5b2fb3',
    color2: '#a3215e',
    dropped: '2026-10-16',
    tagline: 'Pocket money in three jars - spend, save, give - and watch the savings grow.',
    blurb: 'For parents of kids about 5 to 12 who want to teach money with the pocket money they already give - but whose system is coins in a drawer, an IOU they forget, and a kid who can\u2019t tell how long until the LEGO set. Set each child\u2019s pocket money, payday and split, and payday runs itself: open Jars and the money drops into three jars a kid can tap, missed weeks caught up, never twice. Goals show \u201cabout 6 more paydays\u201d, optional Bank of Mum & Dad interest makes saving visible, and a grown-up PIN guards anything that adds money or dips into Save. Grandparents get a read-only link and can send back a gift note. Everything stays on your phone: no account, no AI, nothing uploaded.',
    features: ['Payday runs itself - split three ways, never paid twice', 'Goals counted in paydays, with a celebration when reached', 'Bank of Mum & Dad interest, with a with-vs-without chart', 'A grandparents\u2019 link and gift notes - no account, no server'],
    audience: 'Parents of kids about 5 to 12 who give pocket money',
    status: 'testing',
  },
  {
    slug: 'sniff',
    name: 'Sniff',
    emoji: '\u{1F43D}',
    // Indigo to magenta. White text holds 9.2:1 and 7.1:1.
    color: '#4b2bb0',
    color2: '#a21f6b',
    dropped: '2026-10-17',
    tagline: 'Before you install that app, see where it could send your data.',
    blurb: 'For IT generalists, security-minded power users and small-business owners about to install a browser extension, an npm or PyPI package, a repo, or an AI-built tool from one person. Drop a folder, a .zip, a .crx or a .tgz, or paste code - Sniff reads it on your device (nothing is uploaded) and shows what it could read (cookies, keys, env vars, the clipboard, ~/.ssh and .npmrc, browser passwords, wallets) joined to where it could send each one, risky destinations named - a Discord webhook, a raw IP, a tunnel. It flags the hiding (base64, eval, packed code, a date gate), the postinstall scripts that run before you use it, and every extension permission in plain words. Static reading, not proof - it finds what the code could do. Built-in samples, good and bad, and AI can weigh in on one finding after you see the exact lines it would send.',
    features: ['Read on your device - a folder, .zip, .crx, .tgz or pasted code, never uploaded', 'A data map: what it reads → how it leaves → where, risky hosts first', 'Hiding, install-time scripts and extension permissions, in plain words', 'A made-up sample to try; AI explains a finding from only the lines you confirm'],
    audience: 'IT generalists, power users and owners vetting a single-contributor or AI-built app',
    status: 'testing',
  },
  {
    slug: 'boomerang',
    name: 'Boomerang',
    emoji: '\u{1FA83}',
    // Boomerang teal to burnt orange. White text holds 6.3:1 and 7.3:1.
    color: '#0f6b66',
    color2: '#9a3412',
    dropped: '2026-10-18',
    tagline: 'Lend it. Get it back.',
    blurb: 'For anyone with friends, family, roommates or neighbours who has lent a drill, a book, a jacket, a dish or a board game and can\u2019t remember who has it - and finds asking for it back awkward. Add a loan in seconds (the emoji picks itself, a photo stays on your phone) and your shelf sorts itself into out now, due soon, overdue and back home, with a little personality: \u201cYour ladder has been on holiday for 94 days\u201d, your return rate and your most reliable borrower. Send them a receipt link they confirm with one tap - no app, no account - and later tap \u201cI\u2019ve given it back\u201d while you tap \u201cIt\u2019s back\u201d. When it\u2019s overdue, slide a tone dial from Polite to Legal-ish for a ready-to-send nudge. Free and no account; sign in to have your shelf on every phone, and AI can write a custom nudge.',
    features: ['Lent and borrowed in seconds, sorted by what\u2019s overdue', 'A receipt link your friend confirms - no app, no account', 'Nudges from Polite to Legal-ish, ready to send', 'Stats with personality and a celebration when it comes back'],
    audience: 'Anyone with friends, family, roommates or neighbours',
    status: 'testing',
  },
  {
    slug: 'drill',
    name: 'Drill',
    emoji: '\u{1F6A8}',
    // Alarm red to night navy. White text holds 6.5:1 and 14.3:1.
    color: '#b4232a',
    color2: '#1e2a44',
    dropped: '2026-10-19',
    tagline: 'Rehearse the bad day before it happens.',
    blurb: 'For owners and managers of small businesses - 5 to 200 people - and whoever would be on the call: the IT person, the office manager, finance. Most have no incident plan and have never rehearsed one, yet insurers and auditors ask whether you have run a tabletop exercise, and consultants charge thousands to run one. Drill runs it for you: ransomware on a Monday, a leaked customer list, the payroll email that wasn’t from the CEO, an AI agent that emailed the wrong people, the website down on launch day. Timed injects land on a role, everyone votes from their own phone - no app, no account - the facilitator locks the call, and the story branches on what you chose. You leave with a readiness score per area, the three gaps to fix, an action list with owners and the timeline, as Markdown or a printable page. Try a 5-minute drill solo first; AI can write a scenario around your own business and tools.',
    features: ['A 5-minute drill, solo, no setup', 'Run it as a room: everyone joins by code on their own phone', 'Branching injects to each role, votes, a decision clock', 'An after-action report you can hand your insurer'],
    audience: 'Owners, managers and the IT person at small businesses (5-200 people)',
    status: 'testing',
  },
  {
    slug: 'duly',
    name: 'Duly',
    emoji: '\u{1F4C5}',
    // On-time green to calendar indigo. White text holds 6.5:1 and 10.0:1.
    color: '#0b6b4f',
    color2: '#2b3a8f',
    dropped: '2026-10-20',
    tagline: 'Every bill on time - without paying them yourself.',
    blurb: 'For anyone running a household\u2019s bills who would love to never pay one by hand again. The safe version of that is every bill on its provider\u2019s own AutoPay - and something that watches them and only speaks up when one is wrong, late, new or not on AutoPay. Add a bill in seconds (who it\u2019s from, about how much, the due day - monthly, every few months, yearly or per statement) and Duly scores your AutoPay health with the steps to switch the rest on (statement balance, not the minimum; from checking; keep a buffer), draws the month with what is paid and still to come, flags an amount 20% over its usual, and puts every due date in your own calendar with a reminder. Duly never pays a bill, never signs in to a bank, card or utility, and never holds a password or an account number - it refuses them. Free and no account; sign in to have your bills on every phone, and AI can read a pasted bill or a photo of one.',
    features: ['A sample household to try in one tap', 'AutoPay health, with the steps to turn on the rest', 'The month: paid, due soon, late - and \u201chigher than usual\u201d', 'Every due date in your own calendar (.ics), with a reminder'],
    audience: 'Anyone running a household\u2019s bills',
    status: 'testing',
  },
  {
    slug: 'rota',
    name: 'Rota',
    emoji: '\u{1F5D3}\u{FE0F}',
    // Shift teal to rota plum. White text holds 7.1:1 and 9.9:1.
    color: '#0e6170',
    color2: '#5b2a86',
    dropped: '2026-10-21',
    tagline: 'Next week\u2019s shifts, fair and filled - without the group-chat chaos.',
    blurb: 'For managers of small hourly teams - cafes, bars, restaurants, shops and clinic front desks, 4 to 30 people - who build the week by hand in a spreadsheet, collect availability by text and lose track of swaps in a group chat nobody can follow. Set up the week\u2019s shifts from a template or last week, and share one link: each person taps their name on their own phone - no app, no account - and marks can, prefer not or can\u2019t, with hours if they have them. Fill the gaps builds the week without ever breaking a can\u2019t, a role, an overlap, the rest between a close and an open, or anyone\u2019s max hours; it spreads closes and weekends across the month, moves people toward the hours they asked for, explains every placement and says plainly what it couldn\u2019t fill and why. A fairness panel shows who has been short-changed over four weeks. Publish, and everyone gets their shifts with Add to calendar, offers swaps to the teammates the rules allow, and you approve. AI can read the availability texts they already sent you.',
    features: ['One link: staff mark availability on their own phones', 'Fill the gaps - every rule kept, every placement explained', 'A fairness panel over four weeks: hours, closes, weekends', 'Swaps only to eligible teammates, with Add to calendar'],
    audience: 'Managers of small hourly teams: cafes, bars, restaurants, shops and front desks',
    status: 'testing',
  },
  {
    slug: 'kindly',
    name: 'Kindly',
    emoji: '\u{1F381}',
    // Ribbon raspberry to gift-box plum. White text holds 7.2:1 and 9.9:1.
    color: '#a3214a',
    color2: '#5b2a86',
    dropped: '2026-10-22',
    tagline: 'Never miss the people who matter - and always know what to give.',
    blurb: 'For anyone with friends and family whose birthdays and anniversaries slip by, whose gift ideas heard in July are gone by December, and who has a nagging feeling they gave the same scarf last year. Add the people and their dates - birthdays with or without the year, anniversaries, a dog’s gotcha day, Feb 29 kept on the 28th or the 1st - and Coming up counts down the next 60 days, flags the milestones (“turns 40”, the silver anniversary) and nudges you at each person’s lead time with “order by Oct 26 to arrive”. Save an idea with one tap the moment you hear it, mark it bought and given, and Kindly keeps what you gave each year and warns you before you repeat it, with a budget per occasion and what you have spent so far. Send someone a wishlist link - no app, no account, it shows only their first name and a box - and their ideas land on your list marked “from them”. Every date goes into your own calendar as a yearly event with a reminder. Free and on your phone with no account; sign in to sync, and AI can suggest five ideas from their notes - never told their name.',
    features: ['Coming up: countdowns, milestones and “order by” nudges', 'Gift ideas all year, with a “given before” warning', 'A wishlist link they fill in - no app, no account', 'Every date in your own calendar (.ics), with a reminder'],
    audience: 'Anyone with friends and family',
    status: 'testing',
  },
];

function slugs() { return APPS.map((a) => a.slug); }
function get(slug) { return APPS.find((a) => a.slug === slug) || null; }

module.exports = { APPS, slugs, get };
