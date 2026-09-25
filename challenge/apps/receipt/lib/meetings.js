// Meetings, their log, the room's votes and the audit: the server-side
// shapes, limits and the frozen share card.
//
// The rules the page also needs (setup validation, the meter, the agenda,
// the receipt, heat, bingo, the audit arithmetic, the scoreboard) live in
// public/rules.js and are required from here; this file holds what only the
// server does - ids, codes, tokens, caps, the views it answers with, and the
// numbers-only public receipt.

const crypto = require('crypto');
const R = require('../public/rules');

const LIMITS = {
  meetings: 300,        // meetings one person keeps
  recurring: 40,        // rows in one person's audit
  log: 100,             // decisions + actions + parking items in one meeting
  voters: 300,          // browsers voting in one room
  seriesLookback: 4,    // earlier meetings of a series read for loose ends
  scoreboardLogs: 20,   // recent meetings whose actions the scoreboard reads
  roomMissesPerIp: 40,  // distinct wrong room codes per address per window
  // Brand-new voters per address per window. Below a room's 300 on purpose,
  // so one address cannot fill a room and set its verdict; above a typical
  // meeting behind one office NAT, so a real room is not turned away. A big
  // all-hands on one address fills over two windows.
  newVotersPerIp: 60,
  roomWindowMs: 15 * 60 * 1000,
  ...R.LIMITS,
};

/** An error the app means the client to see, status and words as given.
 *  `expose` is what tells it apart from anything else carrying a `.status` -
 *  an Anthropic SDK error has one too, and its status and raw body are not
 *  ours to pass on. */
function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}

const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,40}$/;
const VID_RE = /^[A-Za-z0-9_-]{22,40}$/;

/** 12 url-safe characters from 9 random bytes. */
const newId = () => crypto.randomBytes(9).toString('base64url');
/** 22 url-safe characters from 16 random bytes: a share link's secret, and
 *  a voter's opaque browser id. */
const newToken = () => crypto.randomBytes(16).toString('base64url');

/** A room code: 8 characters, each drawn uniformly from the 32 in the
 *  alphabet (rejection sampling, so no character is likelier than another). */
function newCode() {
  let out = '';
  while (out.length < R.CODE_LEN) {
    for (const b of crypto.randomBytes(16)) {
      if (b < 256 - (256 % R.CODE_ALPHABET.length)) out += R.CODE_ALPHABET[b % R.CODE_ALPHABET.length];
      if (out.length === R.CODE_LEN) break;
    }
  }
  return out;
}

const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
/** The browser's own calendar day (sent as a header), within a day of UTC -
 *  so a meeting at 9pm in California lands in the right week. */
function todayFrom(v, now = Date.now()) {
  const d = R.isoDay(v);
  const utc = utcToday(now);
  return d && Math.abs(R.daysBetween(utc, d)) <= 1 ? d : utc;
}

/** A name for someone who has not given one: the front of their email. */
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].split(/[._+-]/).filter(Boolean)[0] || 'there';
  return R.clean(local.charAt(0).toUpperCase() + local.slice(1), 30);
}

// The log's counters sit on the meeting as plain top-level fields (bumped
// atomically), so the list and the scoreboard never read a subcollection.
const COUNTER = { decision: 'nDecision', action: 'nAction', parking: 'nParking' };
const countsOf = (m) => ({
  decision: Math.max(0, m.nDecision || 0), action: Math.max(0, m.nAction || 0), parking: Math.max(0, m.nParking || 0),
});

const SETUP_KEYS = ['title', 'mode', 'people', 'loaded', 'bookedMinutes', 'agenda', 'labels', 'bingo', 'outcome', 'invite'];
const pickSetup = (m) => Object.fromEntries(SETUP_KEYS.map((k) => [k, m[k]]));

/** A meeting for its owner's page. */
function meetingView(m) {
  return {
    id: m.id,
    ...pickSetup(m),
    seriesKey: m.seriesKey || m.id,
    day: m.day || null,
    startedAt: m.startedAt || null,
    endedAt: m.endedAt || null,
    pauses: m.pauses || [],
    marks: m.marks || [],
    status: R.status(m),
    code: m.code ? R.formatCode(m.code) : null,
    share: m.shareToken ? { token: m.shareToken, url: `s/${m.shareToken}`, sharedAt: m.sharedAt } : null,
    counts: countsOf(m),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/** One row of the meetings list and the scoreboard, from the meeting
 *  document alone (the counters on it, no subcollection reads). */
function summaryOf(m, now) {
  const L = R.live(m, now);
  const counts = countsOf(m);
  return {
    id: m.id,
    title: m.title,
    status: L.status,
    day: m.day || null,
    createdAt: m.createdAt,
    startedAt: m.startedAt || null,
    endedAt: m.endedAt || null,
    bookedMs: L.bookedMs,
    durationMs: L.elapsedMs,
    headcount: L.headcount,
    hourly: L.hourly,
    costUsd: L.costUsd,
    personHours: L.personHours,
    decisions: counts.decision,
    actions: counts.action,
    rotiN: Math.max(0, m.rotiN || 0),
    rotiAvg: m.rotiN > 0 ? Math.round((m.rotiSum || 0) / m.rotiN * 10) / 10 : null,
    emailVotes: Math.max(0, m.emailN || 0),
    seriesKey: m.seriesKey || m.id,
    agendaItems: (m.agenda || []).length,
  };
}

/** A vote as the facilitator's page and the receipt see it: no browser id. */
const voteView = (v) => ({ roti: typeof v.roti === 'number' ? v.roti : null, email: Boolean(v.email), handle: v.handle || null, bingoAt: v.bingoAt || null });

/** A logged item for the owner's page. */
const logView = (l) => ({
  id: l.id, kind: l.kind, text: l.text, owner: l.owner || '', due: l.due || null,
  at: l.at || 0, createdAt: l.createdAt, doneAt: l.doneAt || null,
});

/**
 * The frozen, public receipt. Built field by field from the computed receipt
 * - numbers only: no meeting title, no agenda item names, no decision or
 * action text, no attendee label, no note. An emoji bingo handle (from a
 * fixed list) is the only thing on it that anyone chose.
 */
function shareCard(r, at) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    frozenAt: at,
    day: r.day,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    ended: r.ended,
    durationMs: r.durationMs,
    bookedMs: r.bookedMs,
    headcount: r.headcount,
    hourly: round2(r.hourly),
    loaded: r.loaded,
    mode: r.mode,
    people: r.people.map((p) => ({ band: p.band, label: R.bandInfo(p.band).label, count: p.count, rate: p.rate, costUsd: round2(p.costUsd) })),
    costUsd: round2(r.costUsd),
    personHours: round2(r.personHours),
    items: r.items.map((it) => ({ n: it.n, state: it.state, plannedMs: it.plannedMs, actualMs: it.actualMs, overMs: it.overMs, overUsd: round2(it.overUsd) })),
    afterMs: r.afterMs,
    counts: { decision: r.counts.decision, action: r.counts.action, parking: r.counts.parking },
    costPerDecision: r.costPerDecision == null ? null : round2(r.costPerDecision),
    roti: { n: r.roti.n, avg: r.roti.avg, dist: r.roti.dist.slice() },
    emailVotes: r.emailVotes,
    voters: r.voters,
    givenBackMs: r.givenBackMs,
    personMinutesGivenBack: Math.round(r.personMinutesGivenBack),
    overrunMs: r.overrunMs,
    onTime: r.onTime,
    early: r.early,
    overItems: r.overItems,
    bingo: r.bingo && R.HANDLES.includes(r.bingo.handle) ? { handle: r.bingo.handle } : null,
    compare: r.compare ? { emoji: r.compare.emoji, text: r.compare.text } : null,
    verdict: { key: r.verdict.key, emoji: r.verdict.emoji, text: r.verdict.text },
  };
}

module.exports = {
  LIMITS, ID_RE, TOKEN_RE, VID_RE,
  httpError, newId, newToken, newCode, utcToday, todayFrom, nameFromEmail,
  COUNTER, countsOf, SETUP_KEYS, pickSetup, meetingView, summaryOf, voteView, logView, shareCard,
};
