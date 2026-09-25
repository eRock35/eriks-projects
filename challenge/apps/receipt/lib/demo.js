// The sample meeting a signed-out visitor runs. Everything here is INVENTED:
// the "Weekly Marketing Sync", its seven people, their first names, the
// invite, the log, the votes and the recurring meetings are fictional.
//
// No model call and no write, ever. The page plays the script below at 60x
// in the browser - the ticker, the rings, the log, the room's votes, a bingo -
// and every number it shows comes from the same public/rules.js a real
// meeting uses. The sharpener's and the recap writer's outputs are written by
// hand and passed through the real validators; the tests assert those remove
// nothing from them.

const R = require('../public/rules');
const M = require('./meetings');
const ai = require('./ai');

const MIN = R.MIN;

const SETUP = {
  title: 'Weekly Marketing Sync',
  invite: 'Sync on Q4 marketing - campaign stuff, launch, budget. Let’s align on next steps. Bring updates!',
  mode: 'bands',
  people: [{ band: 'exec', rate: 200, count: 1 }, { band: 'manager', rate: 110, count: 2 }, { band: 'ic', rate: 85, count: 4 }],
  loaded: false,
  bookedMinutes: 45,
  agenda: [
    { title: 'Wins and numbers', minutes: 5, owner: 'Maya' },
    { title: 'Campaign review', minutes: 15, owner: 'Jordan' },
    { title: 'Launch checklist', minutes: 10, owner: 'Sam' },
    { title: 'Budget asks', minutes: 10, owner: 'Priya' },
    { title: 'Owners and wrap-up', minutes: 5, owner: 'Maya' },
  ],
  labels: ['Maya', 'Jordan', 'Sam', 'Priya', 'Alex', 'Chris', 'Dee'],
  bingo: true,
  outcome: '',
};

// $760 an hour for the room; $486 is 38m 22s of it.
const END_MS = Math.round((486 / 760) * R.HOUR);
// Meeting time at which each item was closed. Campaign review runs 18
// minutes on a 15-minute box: $38 over.
const MARKS = [4 * MIN, 22 * MIN, 30.5 * MIN, 36.7 * MIN, END_MS];

// [meeting minute, kind, text, owner, due in days]
const LOG = [
  [2.5, 'parking', 'Rebrand the newsletter?'],
  [7, 'decision', 'Pause the paid social test until the new creative lands'],
  [11, 'action', 'Send the revised campaign brief', 'Jordan', 2],
  [19.5, 'decision', 'Move the launch webinar back two weeks'],
  [26, 'action', 'Add legal sign-off to the launch checklist', 'Sam', 5],
  [33, 'decision', 'Cap Q4 events at the current plan'],
  [35, 'action', 'Share the budget sheet with finance', 'Priya'],
  [37, 'parking', 'Agency review - next month'],
];

// Five of the seven vote. Two tap "could have been an email" mid-meeting;
// the fox gets bingo in the campaign review.
const VOTERS = [
  { id: 'v1', roti: 4 },
  { id: 'v2', roti: 3 },
  { id: 'v3', roti: 3, handle: '🦊' },
  { id: 'v4', roti: 2, emailAt: 9 * MIN },
  { id: 'v5', roti: 1, emailAt: 16 * MIN },
];
const BINGO_SEED = 'sample:v3';

/** The fox's card, and the four squares (with the free middle) that make
 *  the middle row - marked one by one as the phrases come up. */
function bingoScript() {
  const card = R.deal(BINGO_SEED);
  const row = [10, 11, 13, 14];
  const at = [1.5, 8, 12.5, 20].map((m) => m * MIN);
  return { handle: '🦊', card, marks: row.map((cell, i) => ({ cell, phrase: card[cell], at: at[i] })), line: [10, 11, 12, 13, 14], winAt: 20 * MIN };
}

/** The recap writer's example: rough notes, and an answer written by hand
 *  that cites every item. Passed through the real validator. */
const RECAP_NOTES = [
  'Jordan: I’ll send the revised brief by Friday.',
  'Chris: I’ll check the webinar platform can handle the new date.',
  'Sam: I can take the legal sign-off.',
  'Priya will share the budget sheet with finance.',
  'Agency review - next month.',
  'Same time next week.',
].join('\n');

function recapAnswer() {
  return {
    summary: 'Three decisions: the paid social test is paused, the launch webinar moves back, and Q4 events stay at the current plan. Every action has an owner.',
    decisions: [
      { text: 'Pause the paid social test until the new creative lands', source: 'log', ref: 2, quote: '' },
      { text: 'Move the launch webinar back two weeks', source: 'log', ref: 4, quote: '' },
      { text: 'Cap Q4 events at the current plan', source: 'log', ref: 6, quote: '' },
    ],
    actions: [
      { text: 'Send the revised campaign brief', owner: 'Jordan', due: '', dueText: '', source: 'log', ref: 3, quote: '' },
      { text: 'Add legal sign-off to the launch checklist', owner: 'Sam', due: '', dueText: '', source: 'log', ref: 5, quote: '' },
      { text: 'Share the budget sheet with finance', owner: 'Priya', due: '', dueText: '', source: 'log', ref: 7, quote: '' },
      { text: 'Check the webinar platform can handle the new date', owner: 'Chris', due: '', dueText: '', source: 'notes', ref: 0, quote: 'I’ll check the webinar platform can handle the new date.' },
    ],
    parking: [
      { text: 'Rebrand the newsletter?', source: 'log', ref: 1, quote: '' },
      { text: 'Agency review - next month', source: 'log', ref: 8, quote: '' },
    ],
    nextMeeting: 'Same time next week',
    boardText: '',
    readable: true,
  };
}

/** The sharpener's example for the vague invite: half of it could be an email. */
function sharpenAnswer() {
  return {
    outcome: 'Leave with a go or no-go on the campaign creative, an owner for every launch gap, and the Q4 budget asks agreed or parked.',
    items: [
      { title: 'Campaign creative: go or no-go?', minutes: 12, ownerRole: 'manager' },
      { title: 'Launch checklist: which gaps, and who owns each?', minutes: 8, ownerRole: 'ic' },
      { title: 'Q4 budget asks: agree or park?', minutes: 8, ownerRole: 'exec' },
      { title: 'Owners and next steps', minutes: 2, ownerRole: 'manager' },
    ],
    attendeeBands: ['exec', 'manager', 'ic'],
    verdict: 'split',
    why: 'The wins, numbers and launch status are updates - send them in writing first. Meet only for the three decisions, and the meeting gets much shorter.',
    asyncDraft: 'Hi team,\n\nBefore we meet, here is where Q4 marketing stands, so the meeting can be about decisions:\n\n- Wins and numbers: [add: this week’s numbers]\n- Campaign: [add: link to the new creative] - please look before we meet\n- Launch: [add: checklist status and the open gaps]\n- Budget: [add: the asks and amounts]\n\nReply here with anything that would change a decision. See you at the meeting.',
  };
}

// The sample audit: six recurring meetings, undecided, for the swipe.
// Weekly all-hands: 30 min x 48 a year x $1,600/h = $38,400.
const AUDIT = [
  ['Weekly all-hands', 30, 'weekly', [1, 5, 10]],
  ['Daily stand-up', 15, 'daily', [0, 1, 6]],
  ['Weekly Marketing Sync', 45, 'weekly', [1, 2, 4]],
  ['Monthly business review', 90, 'monthly', [3, 4, 2]],
  ['Friday pipeline review', 30, 'weekly', [1, 2, 3]],
  ['Design crit', 60, 'fortnightly', [0, 1, 5]],
];
function auditRows() {
  return AUDIT.map(([title, minutes, cadence, [e, m, i]], n) => {
    const r = R.validateRecurring({ title, minutes, cadence, mode: 'bands', people: [{ band: 'exec', count: e }, { band: 'manager', count: m }, { band: 'ic', count: i }] }).recurring;
    return { id: `a${n + 1}`, ...r };
  });
}

/** A month of past meetings for the sample scoreboard. [title, days ago,
 *  booked min, actual min, [exec, manager, ic], decisions, roti votes] */
const PAST = [
  ['Weekly Marketing Sync', 7, 45, 47, [1, 2, 4], 1, [2, 2, 1, 2, 2]],
  ['Launch go / no-go', 9, 30, 28, [1, 1, 3], 1, [3, 4, 3]],
  ['Monthly business review', 20, 90, 104, [3, 4, 2], 2, [2, 1, 2, 3]],
  ['Design crit', 3, 60, 52, [0, 1, 5], 2, [3, 4, 3, 3]],
  ['Pricing decision', 2, 30, 24, [1, 1, 1], 4, [4, 3, 4]],
];

function build(now, today) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const day = today || M.utcToday(nowMs);
  const iso = (ms) => new Date(ms).toISOString();
  const setup = R.validateSetup(SETUP).setup;
  const startMs = nowMs - END_MS - 20 * MIN;
  const log = LOG.map(([m, kind, text, owner, dueIn], i) => ({
    id: `l${i + 1}`, kind, text, owner: owner || '', due: dueIn ? R.addDays(day, dueIn) : null,
    at: m * MIN, createdAt: iso(startMs + m * MIN), doneAt: null,
  }));
  const bingo = bingoScript();
  const votes = VOTERS.map((v) => ({
    roti: v.roti, email: Boolean(v.emailAt), handle: v.handle || null,
    bingoAt: v.handle ? iso(startMs + bingo.winAt) : null,
  }));
  const meeting = {
    id: 'sample', ...setup, day, seriesKey: 'sample',
    startedAt: iso(startMs), endedAt: iso(startMs + END_MS), pauses: [], marks: MARKS.slice(),
    nDecision: 3, nAction: 3, nParking: 2, counts: { decision: 3, action: 3, parking: 2 }, status: 'ended', code: 'SAMP-LE23',
  };
  const receipt = R.receipt(meeting, log, votes, nowMs);

  // The script the page plays: agenda marks, log entries, the room.
  const events = [
    ...log.map((l) => ({ at: l.at, type: 'log', log: { kind: l.kind, text: l.text, owner: l.owner, due: l.due } })),
    ...VOTERS.filter((v) => v.emailAt).map((v) => ({ at: v.emailAt, type: 'email' })),
    ...bingo.marks.map((b) => ({ at: b.at, type: 'mark', cell: b.cell })),
    { at: bingo.winAt, type: 'bingo', handle: bingo.handle },
  ].sort((a, b) => a.at - b.at);

  const sharpenCtx = ai.sharpenContext(setup, setup.invite);
  const sharpen = ai.validateSharpen(sharpenAnswer(), sharpenCtx);
  const recapCtx = ai.recapContext({ ...setup, day }, log, RECAP_NOTES, false);
  const recap = ai.validateRecap(recapAnswer(), recapCtx);

  const audit = auditRows();
  const decided = audit.map((r) => (r.title === 'Friday pipeline review' ? { ...r, decision: 'kill' } : r));
  const pastRows = PAST.map(([title, ago, booked, actual, [e, m, i], decisions, roti], n) => {
    const d = R.addDays(day, -ago);
    const start = Date.parse(`${d}T15:00:00Z`);
    const doc = R.validateSetup({ title, bookedMinutes: booked, people: [{ band: 'exec', count: e }, { band: 'manager', count: m }, { band: 'ic', count: i }] }).setup;
    return M.summaryOf({
      id: `p${n + 1}`, ...doc, day: d, startedAt: iso(start), endedAt: iso(start + actual * MIN), pauses: [], marks: [],
      nDecision: decisions, rotiN: roti.length, rotiSum: roti.reduce((s, v) => s + v, 0),
    }, nowMs);
  });
  const thisRow = M.summaryOf({ ...meeting, rotiN: 5, rotiSum: 13 }, nowMs);
  const board = R.scoreboard([thisRow, ...pastRows], decided, day, { actions: { open: 3, done: 5, dropped: 1 } });
  const openActions = log.filter((l) => l.kind === 'action').map((l) => ({ ...l, meetingTitle: setup.title }));

  return {
    demo: true,
    now: iso(nowMs),
    today: day,
    meeting,
    log,
    votes,
    receipt,
    receiptText: R.receiptText(receipt),
    script: { endMs: END_MS, marks: MARKS.slice(), events, votes, bingo, speed: 60 },
    sharpen: { invite: setup.invite, proposal: sharpen },
    recap: { notes: RECAP_NOTES, recap },
    audit,
    scoreboard: board,
    openActions: R.byHeat(openActions, nowMs, day).map((r) => ({ ...r.action, heat: r.heat })),
  };
}

let cache = null;
/** Rebuilt at most once a minute: the sample's times are relative to now. */
function demo(now = Date.now(), today) {
  const key = `${Math.floor(now / 60000)}:${today || ''}`;
  if (!cache || cache.key !== key) cache = { key, value: build(now, today) };
  return cache.value;
}

module.exports = { demo, build, SETUP, LOG, MARKS, END_MS, VOTERS, AUDIT, RECAP_NOTES, recapAnswer, sharpenAnswer, bingoScript };
