// The progression layer: XP, levels, streaks and badges.
//
// Pure functions over a player record, so the rules can be tested without a
// database and so the server applies them in exactly one place (`award`).

const crypto = require('crypto');

const scenarios = require('./scenarios');

const LEVELS = [
  { at: 0, title: 'Rookie' },
  { at: 150, title: 'Contender' },
  { at: 450, title: 'Closer' },
  { at: 900, title: 'Negotiator' },
  { at: 1600, title: 'Rainmaker' },
  { at: 2600, title: 'Legend' },
];

function levelFor(xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].at) i++;
  const cur = LEVELS[i];
  const next = LEVELS[i + 1] || null;
  return {
    level: i + 1,
    title: cur.title,
    xp,
    floor: cur.at,
    next: next ? next.at : null,
    nextTitle: next ? next.title : null,
    progress: next ? (xp - cur.at) / (next.at - cur.at) : 1,
  };
}

const BADGES = {
  'first-blood': { emoji: '🥊', label: 'First round', desc: 'Finish your first spar.' },
  'first-win': { emoji: '🏆', label: 'First win', desc: 'Win a conversation.' },
  'brutal-win': { emoji: '💀', label: 'Brutal', desc: 'Win on Brutal difficulty.' },
  'comeback': { emoji: '🔄', label: 'Comeback', desc: 'Win after the mood hit -3 or lower.' },
  'detective': { emoji: '🕵️', label: 'Detective', desc: 'Uncover every hidden motivation in one round.' },
  'a-plus': { emoji: '⭐', label: 'A+', desc: 'Score 93 or higher.' },
  'streak-3': { emoji: '🔥', label: 'On fire', desc: 'Spar three days in a row.' },
  'streak-7': { emoji: '🌋', label: 'Unstoppable', desc: 'Spar seven days in a row.' },
  'daily': { emoji: '📅', label: 'Daily grind', desc: 'Finish a daily challenge.' },
  'all-rounder': { emoji: '🎯', label: 'All-rounder', desc: 'Win in every category.' },
  'architect': { emoji: '🛠️', label: 'Architect', desc: 'Play a scenario you built.' },
};

function blankPlayer(handle) {
  return {
    handle: handle || 'Anonymous',
    xp: 0,
    rounds: 0,
    wins: 0,
    streak: 0,
    bestStreak: 0,
    lastDay: null,
    badges: [],
    skillSum: { rapport: 0, discovery: 0, pushback: 0, clarity: 0, close: 0 },
    scored: 0,
    best: {},          // scenarioId -> best overall score
    winsByCategory: {},
    teamIds: [],
  };
}

function prevDay(key) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** XP for a finished, scored round. */
function xpFor(session, card) {
  const mult = (scenarios.DIFFICULTIES[session.difficulty] || scenarios.DIFFICULTIES.realistic).mult;
  let xp = Math.round(card.overall * mult);
  if (session.status === 'won') xp += Math.round(40 * mult);
  if (session.daily) xp += 25;
  const found = (session.revealed || []).length;
  xp += found * 10;
  return xp;
}

/**
 * Apply a scored round to a player. Returns the new player and what changed,
 * so the page can celebrate the right things.
 */
function award(player, session, card, today = scenarios.dayKey()) {
  const p = { ...blankPlayer(), ...player };
  p.skillSum = { ...blankPlayer().skillSum, ...(player && player.skillSum) };
  p.best = { ...(player && player.best) };
  p.winsByCategory = { ...(player && player.winsByCategory) };
  p.badges = [...((player && player.badges) || [])];

  const before = levelFor(p.xp);
  const gained = xpFor(session, card);
  p.xp += gained;
  p.rounds += 1;
  if (session.status === 'won') {
    p.wins += 1;
    const cat = session.scenario.category;
    p.winsByCategory[cat] = (p.winsByCategory[cat] || 0) + 1;
  }
  for (const k of Object.keys(p.skillSum)) p.skillSum[k] += card.skills[k] || 0;
  p.scored += 1;
  const key = session.scenarioId;
  const personalBest = !p.best[key] || card.overall > p.best[key];
  if (personalBest) p.best[key] = card.overall;

  // Streaks count days with a finished round, in UTC, like the daily challenge.
  if (p.lastDay !== today) {
    p.streak = p.lastDay === prevDay(today) ? p.streak + 1 : 1;
    p.lastDay = today;
  }
  p.bestStreak = Math.max(p.bestStreak, p.streak);

  const earned = [];
  const give = (id, cond) => { if (cond && !p.badges.includes(id)) { p.badges.push(id); earned.push(id); } };
  give('first-blood', true);
  give('first-win', session.status === 'won');
  give('brutal-win', session.status === 'won' && session.difficulty === 'brutal');
  give('comeback', session.status === 'won' && (session.minMood ?? 0) <= -3);
  give('detective', (session.hiddenCount || 0) > 0 && (session.revealed || []).length >= session.hiddenCount);
  give('a-plus', card.overall >= 93);
  give('streak-3', p.streak >= 3);
  give('streak-7', p.streak >= 7);
  give('daily', Boolean(session.daily));
  give('all-rounder', Object.keys(scenarios.CATEGORIES).every((c) => (p.winsByCategory[c] || 0) > 0));
  give('architect', Boolean(session.scenario && session.scenario.custom));

  const after = levelFor(p.xp);
  return {
    player: p,
    gained,
    levelUp: after.level > before.level ? after : null,
    earned: earned.map((id) => ({ id, ...BADGES[id] })),
    personalBest,
  };
}

/** Average skill profile, 0-10, for the radar. */
function skillProfile(player) {
  const n = (player && player.scored) || 0;
  const out = {};
  for (const k of Object.keys(scenarios.SKILLS)) {
    out[k] = n ? Math.round(((player.skillSum || {})[k] || 0) / n * 10) / 10 : 0;
  }
  return out;
}

function cleanHandle(v) {
  return String(v || '')
    .replace(/[^\p{L}\p{N} ._-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

/**
 * The handle an email would have made: the part before @, tidied, never the
 * domain. No longer given to anyone (2026-09-27) - the daily board is public,
 * and "Jane doe" is half of jane.doe@... It is kept to recognise the handles
 * made this way before, which publicHandle() hides until they are changed.
 */
function handleFromEmail(email) {
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ');
  const h = cleanHandle(local);
  return h ? h.charAt(0).toUpperCase() + h.slice(1) : 'Player';
}

/** A new player's handle until they pick one: "Player 4821". Random, so it
 *  says nothing about the account. */
function neutralHandle(rand = crypto.randomInt) {
  return `Player ${rand(1000, 10000)}`;
}

/** The neutral form of an old email-made handle: the same "Player NNNN" for
 *  one account on every surface, keyed so it cannot be matched to a guess. */
function neutralFor(uid, key) {
  const n = crypto.createHmac('sha256', key || 'spar handle').update(`handle\n${uid}`).digest().readUInt32BE(0) % 9000 + 1000;
  return `Player ${n}`;
}

/**
 * The name other people see. A handle someone chose is theirs; one that is
 * still what their email made (handleFromEmail, before 2026-09-27) is shown
 * as neutralFor(uid) on every public surface until they change it. A uid is
 * base64url(lowercased email), so the email is recovered from it here and
 * never leaves the server.
 */
function publicHandle(handle, uid, { chosen = false, key } = {}) {
  const h = handle || 'Player';
  if (chosen || !uid) return h;
  let email = '';
  try { email = Buffer.from(String(uid), 'base64url').toString('utf8'); } catch (_) { email = ''; }
  if (!email.includes('@')) return h;
  return h === handleFromEmail(email) ? neutralFor(uid, key) : h;
}

module.exports = { LEVELS, BADGES, levelFor, award, xpFor, skillProfile, blankPlayer, cleanHandle, handleFromEmail, neutralHandle, neutralFor, publicHandle, prevDay };
