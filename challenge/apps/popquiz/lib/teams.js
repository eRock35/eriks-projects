// Teams, decks and progress: the server-side shapes, limits and arithmetic.
//
// The rules that the page also needs (question validation, Leitner, streaks,
// the leaderboard, blind spots) live in public/quiz.js and are required from
// here; this file holds what only the server does - ids, codes, limits, and
// assembling the views each role is allowed to see.

const crypto = require('crypto');
const Q = require('../public/quiz');

const DAY = 86400000;

const LIMITS = {
  members: 50,          // people on one team
  ownedTeams: 5,        // teams one manager can run
  memberships: 12,      // teams one person can be on
  decks: 20,            // decks on one team
  questions: 300,       // published questions on one team
  perDeck: Q.LIMITS.perDeck,
  sourceMin: 80,        // characters of pasted material, at least
  source: 12000,        // and at most
  teamName: 40,
  personName: 30,
  deckTitle: 60,
  generateMin: 4,
  generateMax: 12,
  joinTries: 8,         // wrong codes per person per window
  joinTriesPerIp: 30,   // and per address, for someone with many accounts
  joinWindowMs: 15 * 60 * 1000,
  xpDaysKept: 70,
};

const EMOJIS = ['🍕', '☕', '🍔', '🌮', '🍣', '🥗', '🍰', '🍺', '🛍️', '👗', '💇', '💅', '🦷', '🩺', '🏋️', '🧘', '🏨', '🧰', '🚗', '🐾', '🌿', '📚', '🎬', '🧠'];

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

const clean = Q.clean;

/** Paragraphs kept, markup and control characters gone. For pasted material. */
function cleanText(v, max = 2000) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/<\/?[a-z!][^>]*>/gi, '')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const utcToday = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** The page sends its own local date so "today" and the streak mean the
 *  person's day; anything more than a day from UTC falls back to UTC. */
function todayFrom(v, now = Date.now()) {
  const u = utcToday(now);
  const d = Q.isoDay(v);
  return d && Math.abs(Q.daysBetween(u, d)) <= 1 ? d : u;
}

/** 12 url-safe characters from 9 random bytes. */
const newId = () => crypto.randomBytes(9).toString('base64url');

/** A join code: 8 characters, each drawn uniformly from the 32 in the
 *  alphabet (rejection sampling, so no character is likelier than another). */
function newCode() {
  let out = '';
  while (out.length < Q.CODE_LEN) {
    for (const b of crypto.randomBytes(16)) {
      if (b < 256 - (256 % Q.CODE_ALPHABET.length)) out += Q.CODE_ALPHABET[b % Q.CODE_ALPHABET.length];
      if (out.length === Q.CODE_LEN) break;
    }
  }
  return out;
}

/** A name for someone who has not given one: the front of their email. */
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].split(/[._+-]/).filter(Boolean)[0] || 'Teammate';
  return clean(local.charAt(0).toUpperCase() + local.slice(1), LIMITS.personName);
}

function cleanTeam(b, prev = {}) {
  const out = {};
  if (b.name !== undefined || !prev.name) {
    const name = clean(b.name, LIMITS.teamName);
    if (name.length < 2) throw httpError(400, 'Give the team a name.');
    out.name = name;
  }
  if (b.emoji !== undefined || !prev.emoji) out.emoji = EMOJIS.includes(b.emoji) ? b.emoji : (prev.emoji || '🧠');
  return out;
}

function cleanPersonName(v, fallback) {
  const n = clean(v, LIMITS.personName);
  return n.length >= 1 ? n : fallback;
}

/**
 * A deck's questions from the editor: every one validated, all or nothing. A
 * question that keeps its id keeps its history only if it is the same fact -
 * change the options or the right answer and it is a new question.
 */
function cleanQuestions(list, prevQuestions = []) {
  if (!Array.isArray(list) || !list.length) throw httpError(400, 'A deck needs at least one question.');
  if (list.length > LIMITS.perDeck) throw httpError(400, `A deck holds up to ${LIMITS.perDeck} questions - split it in two.`);
  const prev = new Map(prevQuestions.map((q) => [q.id, q]));
  const seen = new Set();
  const out = [];
  list.forEach((raw, i) => {
    const r = Q.validateQuestion(raw);
    if (r.error) throw httpError(400, `Question ${i + 1}: ${r.error}`, { index: i });
    const q = r.q;
    const key = q.prompt.toLowerCase();
    if (seen.has(key)) throw httpError(400, `Question ${i + 1} is the same as an earlier one.`, { index: i });
    seen.add(key);
    const old = q.id && prev.get(q.id);
    if (!old || !Q.sameFact(old, q)) q.id = newId();
    out.push(q);
  });
  return out;
}

function cleanDeckMeta(b) {
  const title = clean(b.title, LIMITS.deckTitle);
  if (title.length < 2) throw httpError(400, 'Give the deck a title.');
  return {
    title,
    emoji: EMOJIS.includes(b.emoji) ? b.emoji : '📘',
  };
}

/** Every published question on a team, in deck order, carrying its deck. */
function flatten(decks) {
  const out = [];
  [...decks].sort((a, b) => String(a.publishedAt || a.createdAt).localeCompare(String(b.publishedAt || b.createdAt))).forEach((d) => {
    (d.questions || []).forEach((q) => out.push({ ...q, deckId: d.id, deckTitle: d.title, deckEmoji: d.emoji, topic: q.topic || d.title }));
  });
  return out;
}

/** What a player sees before answering: never the answer. */
function publicQuestion(q) {
  return { id: q.id, type: q.type, prompt: q.prompt, options: q.options, deckTitle: q.deckTitle, deckEmoji: q.deckEmoji, topic: q.topic };
}

/** What they see after: the answer, why, and where it came from. */
function resultOf(q, a) {
  return { choice: a.choice, correct: a.correct, answer: q.answer, explanation: q.explanation, source: q.source };
}

function deckSummary(d) {
  return { id: d.id, title: d.title, emoji: d.emoji, count: (d.questions || []).length, source: d.source, publishedAt: d.publishedAt || d.createdAt, updatedAt: d.updatedAt };
}

function emptyProgress() {
  return { cards: {}, xp: 0, xpByDay: {}, streak: 0, best: 0, lastDoneDay: null, daysDone: 0, perfectDays: 0, comebacks: 0, badges: {}, today: null };
}

/** Keep the XP ledger bounded: the week and a little history is all it needs. */
function trimXp(xpByDay, today) {
  const from = Q.addDays(today, -LIMITS.xpDaysKept);
  const out = {};
  for (const [d, v] of Object.entries(xpByDay || {})) if (d >= from) out[d] = v;
  return out;
}

/** A person's own numbers, for their Me tab and the end of a quiz. */
function statsOf(p, questions, today) {
  const m = Q.mastery(questions, p.cards);
  return {
    xp: p.xp || 0,
    weekXp: Q.weekXp(p.xpByDay, today),
    xpToday: (p.xpByDay || {})[today] || 0,
    streak: Q.streakNow(p, today),
    atRisk: Q.streakAtRisk(p, today) && !Q.doneToday(p, today),
    best: p.best || 0,
    daysDone: p.daysDone || 0,
    perfectDays: p.perfectDays || 0,
    mastery: m,
    known: questions.filter((q) => p.cards && p.cards[q.id] && p.cards[q.id].box >= Q.KNOWN_BOX).length,
    questions: questions.length,
    badges: Q.BADGES.map((b) => ({ ...b, earnedAt: (p.badges || {})[b.key] || null })),
  };
}

/**
 * The manager's dashboard, computed from every member's progress on each
 * read - nothing here is a stored count that could drift.
 *
 * @param members   [{uid, name, role, joinedAt}]
 * @param progress  {uid: progress}
 */
function dashboard(members, progress, questions, decks, today) {
  const people = members.map((m) => {
    const p = progress[m.uid] || emptyProgress();
    const attempts = Object.values(p.cards || {}).reduce((s, c) => s + (c.right || 0) + (c.wrong || 0), 0);
    const right = Object.values(p.cards || {}).reduce((s, c) => s + (c.right || 0), 0);
    return {
      uid: m.uid,
      name: m.name,
      role: m.role,
      doneToday: Q.doneToday(p, today),
      streak: Q.streakNow(p, today),
      weekXp: Q.weekXp(p.xpByDay, today),
      mastery: Q.mastery(questions, p.cards),
      accuracy: attempts ? Math.round(right / attempts * 100) : null,
      answered: attempts,
      lastDoneDay: p.lastDoneDay || null,
      started: attempts > 0,
    };
  }).sort((a, b) => Number(b.doneToday) - Number(a.doneToday) || b.mastery - a.mastery || String(a.name).localeCompare(String(b.name)));

  const cardsList = members.map((m) => (progress[m.uid] || {}).cards || {});
  const started = people.filter((p) => p.started);
  const deckRows = decks.map((d) => {
    const qs = questions.filter((q) => q.deckId === d.id);
    const vals = members.filter((m) => progress[m.uid] && Object.keys(progress[m.uid].cards || {}).length)
      .map((m) => Q.mastery(qs, progress[m.uid].cards));
    return { ...deckSummary(d), mastery: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0 };
  });
  return {
    today,
    done: people.filter((p) => p.doneToday).length,
    total: people.length,
    mastery: started.length ? Math.round(started.reduce((s, p) => s + p.mastery, 0) / started.length) : 0,
    bestStreak: people.reduce((m, p) => Math.max(m, p.streak), 0),
    questions: questions.length,
    people,
    blindSpots: Q.blindSpots(questions, cardsList, { min: 3, top: 6 }),
    topics: Q.topicSpots(questions, cardsList, { min: 3, top: 8 }),
    decks: deckRows,
  };
}

module.exports = {
  LIMITS, EMOJIS, DAY,
  httpError, clean, cleanText, utcToday, todayFrom, newId, newCode, nameFromEmail,
  cleanTeam, cleanPersonName, cleanQuestions, cleanDeckMeta,
  flatten, publicQuestion, resultOf, deckSummary, emptyProgress, trimXp, statsOf, dashboard,
};
