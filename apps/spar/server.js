// Spar - practise the conversation before it counts.
//
// A live role-play against a counterpart who has real reasons to say no, a
// mood meter that moves with every line, hidden motivations to uncover, and a
// coach's scorecard at the end. See CLAUDE.md for the decisions that matter.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const scenarios = require('./lib/scenarios');
const coach = require('./lib/coach');
const game = require('./lib/game');
const { DEMO } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.SPAR_FAKE_AI === '1';

// Free tier on Haiku, paid tier on Sonnet - the same split every sibling app
// uses, decided in one place by identity.planFor. The whisper is always
// Haiku: one sentence of coaching does not need the bigger model.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };
const HINT_MODEL = 'claude-haiku-4-5';
const INVENT_MODEL = 'claude-haiku-4-5';

const MAX_HINTS = 3;
const MAX_CUSTOM = 30;
const MAX_TEAMS_OWNED = 5;
const MAX_TEAM_MEMBERS = 50;
const MAX_ASSIGNMENTS = 20;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '64kb' }));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'spar',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Spar',
  mountPath: '/api/auth',
});
identity.mount(app);

const sharedClient = FAKE_AI
  ? identity.meter(require('./lib/fakeai').create())
  : identity.meter(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

function clientFor(req) {
  if (FAKE_AI) return Promise.resolve(sharedClient);
  return identity.clientFor(req.user, sharedClient, (apiKey) => new Anthropic({ apiKey }));
}

function modelFor(req) {
  return identityLib.planFor(req.user, MODELS).model;
}

// Never put a model call behind a sign-in alone: every one of these goes
// through the budget and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
const fail = (res, err, fallback = 'Something went wrong.') => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : fallback });
};
const httpError = (status, message) => Object.assign(new Error(message), { status });
const newId = (n = 12) => crypto.randomBytes(n).toString('base64url').slice(0, n);

const sessionsOf = (uid) => `players/${uid}/sessions`;
const customOf = (uid) => `players/${uid}/custom`;

async function loadPlayer(user) {
  const p = await store.get('players', user.id);
  if (p) return p;
  const fresh = { ...game.blankPlayer(game.handleFromEmail(user.email)), createdAt: now() };
  await store.set('players', user.id, fresh);
  return { id: user.id, ...fresh };
}

function playerSummary(p) {
  return {
    handle: p.handle,
    level: game.levelFor(p.xp || 0),
    rounds: p.rounds || 0,
    wins: p.wins || 0,
    streak: p.streak || 0,
    bestStreak: p.bestStreak || 0,
    lastDay: p.lastDay || null,
    badges: Object.entries(game.BADGES).map(([id, b]) => ({ id, ...b, earned: (p.badges || []).includes(id) })),
    skills: game.skillProfile(p),
    best: p.best || {},
  };
}

/** A session as the browser may see it. Hidden motivations stay hidden until
 *  they are uncovered, or until the round is scored and everything is shown. */
function sessionView(s) {
  const hidden = (s.scenario && s.scenario.hidden) || [];
  const revealAll = Boolean(s.scorecard);
  const revealedText = {};
  hidden.forEach((h, i) => {
    if (revealAll || (s.revealed || []).includes(i + 1)) revealedText[i + 1] = h;
  });
  return {
    id: s.id,
    scenarioId: s.scenarioId,
    scenario: scenarios.publicView(s.scenario),
    source: s.source,
    teamId: s.teamId || null,
    difficulty: s.difficulty,
    twist: s.twist || null,
    daily: s.daily || null,
    status: s.status,
    mood: s.mood,
    moodTrail: s.moodTrail || [],
    turns: s.turns,
    maxTurns: s.maxTurns,
    hintsUsed: s.hintsUsed || 0,
    maxHints: MAX_HINTS,
    hiddenCount: hidden.length,
    revealed: s.revealed || [],
    revealedText,
    // Private notes are the coach's material; they are shown with the
    // scorecard, not during play, where they would read as a cheat sheet.
    transcript: (s.transcript || []).map((t) => ({
      who: t.who, text: t.text, mood: t.mood, revealed: t.revealed,
      note: revealAll ? t.note : undefined,
    })),
    scorecard: s.scorecard || null,
    award: s.award || null,
    shareId: s.shareId || null,
    createdAt: s.createdAt,
    endedAt: s.endedAt || null,
  };
}

// One turn at a time per round. A double tap would otherwise send two player
// lines against the same transcript and the second write would drop the first.
const busy = new Set();
async function exclusive(key, fn) {
  if (busy.has(key)) throw httpError(409, 'Still waiting on the last reply.');
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

async function loadSession(req) {
  const s = await store.get(sessionsOf(req.user.id), req.params.id);
  if (!s) throw httpError(404, 'No such round.');
  return s;
}

/* ------------------------------------------------------------------ *
 * Public: health, library, daily, demo, shares
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/library', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    categories: scenarios.CATEGORIES,
    difficulties: scenarios.DIFFICULTIES,
    skills: scenarios.SKILLS,
    badges: game.BADGES,
    levels: game.LEVELS,
    scenarios: scenarios.SCENARIOS.map(scenarios.publicView),
  });
});

app.get('/api/demo', (_req, res) => res.json(DEMO));

app.get('/api/daily', async (req, res) => {
  try {
    const d = scenarios.daily();
    const rows = await store.list(`daily/${d.day}/scores`, { orderBy: 'score', dir: 'desc', limit: 25 });
    const uid = req.user && req.user.id;
    res.json({
      challenge: { ...d, scenario: scenarios.publicView(scenarios.get(d.scenarioId)) },
      board: rows.map((r, i) => ({ rank: i + 1, handle: r.handle, score: r.score, grade: r.grade, status: r.status, you: r.id === uid })),
      mine: uid ? (await store.get(`daily/${d.day}/scores`, uid)) : null,
      players: rows.length,
    });
  } catch (err) { fail(res, err); }
});

app.get('/api/share/:id', async (req, res) => {
  try {
    const s = await store.get('shares', String(req.params.id).slice(0, 20));
    if (!s) throw httpError(404, 'That scorecard is not here any more.');
    res.json(s);
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Me
 * ------------------------------------------------------------------ */

app.get('/api/me', async (req, res) => {
  try {
    if (!req.user) return res.json({ signedIn: false });
    const p = await loadPlayer(req.user);
    const recent = await store.list(sessionsOf(req.user.id), { orderBy: 'createdAt', dir: 'desc', limit: 25 });
    res.json({
      signedIn: true,
      email: req.user.email,
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      player: playerSummary(p),
      recent: recent.map((s) => ({
        id: s.id, title: s.scenario && s.scenario.title, emoji: s.scenario && s.scenario.emoji,
        status: s.status, difficulty: s.difficulty, daily: s.daily || null,
        score: s.scorecard ? s.scorecard.overall : null, grade: s.scorecard ? s.scorecard.grade : null,
        createdAt: s.createdAt, turns: s.turns,
      })),
    });
  } catch (err) { fail(res, err); }
});

app.post('/api/me/handle', identity.requireUser, async (req, res) => {
  try {
    const handle = game.cleanHandle((req.body || {}).handle);
    if (handle.length < 2) throw httpError(400, 'Pick a name with at least two letters.');
    await loadPlayer(req.user);
    await store.merge('players', req.user.id, { handle });
    res.json({ ok: true, handle });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Rounds
 * ------------------------------------------------------------------ */

/** Which scenario a new round is for: the library, your own, or a team drill. */
async function resolveScenario(req) {
  const b = req.body || {};
  if (b.teamId && b.assignmentId) {
    const team = await store.get('teams', String(b.teamId));
    if (!team || !(team.memberIds || []).includes(req.user.id)) throw httpError(404, 'No such team.');
    const a = (team.assignments || []).find((x) => x.id === b.assignmentId);
    if (!a) throw httpError(404, 'That drill was removed.');
    return { scenario: a.scenario, source: 'team', teamId: team.id, assignmentId: a.id, scenarioId: `team:${a.id}`, difficulty: a.difficulty };
  }
  if (b.customId) {
    const c = await store.get(customOf(req.user.id), String(b.customId));
    if (!c) throw httpError(404, 'No such scenario.');
    return { scenario: c, source: 'custom', scenarioId: `custom:${c.id}` };
  }
  const s = scenarios.get(b.scenarioId);
  if (!s) throw httpError(404, 'No such scenario.');
  return { scenario: s, source: 'library', scenarioId: s.id };
}

// Starting a round is free: the opening line is authored, so the first model
// call happens only when the player actually says something.
app.post('/api/rounds', identity.requireUser, async (req, res) => {
  try {
    const b = req.body || {};
    const today = scenarios.daily();
    const isDaily = b.daily === true;
    let picked;
    if (isDaily) {
      const s = scenarios.get(today.scenarioId);
      picked = { scenario: s, source: 'library', scenarioId: s.id };
    } else {
      picked = await resolveScenario(req);
    }
    // A team drill is played at the difficulty its owner set, so the scores
    // on the team board are comparable.
    const difficulty = isDaily ? today.difficulty
      : picked.difficulty ? picked.difficulty
        : (scenarios.DIFFICULTIES[b.difficulty] ? b.difficulty : 'realistic');
    const diff = scenarios.DIFFICULTIES[difficulty];
    const startMood = difficulty === 'brutal' ? -1 : 0;
    const { id: _drop, ...scenario } = picked.scenario;
    const round = {
      scenarioId: picked.scenarioId,
      scenario,
      source: picked.source,
      teamId: picked.teamId || null,
      assignmentId: picked.assignmentId || null,
      difficulty,
      twist: isDaily ? today.twist : null,
      daily: isDaily ? today.day : null,
      status: 'live',
      mood: startMood,
      minMood: startMood,
      moodTrail: [startMood],
      turns: 0,
      maxTurns: diff.turns,
      revealed: [],
      hiddenCount: (scenario.hidden || []).length,
      hintsUsed: 0,
      transcript: [{ who: 'them', text: scenario.opening, mood: startMood, at: now() }],
      createdAt: now(),
      updatedAt: now(),
    };
    const id = await store.add(sessionsOf(req.user.id), round);
    await loadPlayer(req.user);
    res.json(sessionView({ id, ...round }));
  } catch (err) { fail(res, err); }
});

app.get('/api/rounds/:id', identity.requireUser, async (req, res) => {
  try { res.json(sessionView(await loadSession(req))); } catch (err) { fail(res, err); }
});

app.post('/api/rounds/:id/say', ...spend, async (req, res) => {
  try {
    const text = coach.clean((req.body || {}).text, coach.MAX_PLAYER_CHARS);
    if (!text) throw httpError(400, 'Say something first.');
    const out = await exclusive(`${req.user.id}/${req.params.id}`, async () => {
      const s = await loadSession(req);
      if (s.status !== 'live') throw httpError(409, 'This round is over.');
      s.transcript.push({ who: 'you', text, at: now() });
      s.turns += 1;
      const client = await clientFor(req);
      // Nothing is saved until the reply is in, so a failed call leaves the
      // round exactly as it was and the player can simply send again.
      const r = await coach.turn(client, modelFor(req), s.scenario, s);
      const newly = r.revealed.filter((n) => !(s.revealed || []).includes(n));
      s.revealed = [...new Set([...(s.revealed || []), ...r.revealed])].sort();
      s.transcript.push({ who: 'them', text: r.reply, mood: r.mood, note: r.note, revealed: newly, at: now() });
      s.mood = r.mood;
      s.minMood = Math.min(s.minMood ?? r.mood, r.mood);
      s.moodTrail = [...(s.moodTrail || []), r.mood];
      if (r.outcome !== 'ongoing') s.status = r.outcome;
      else if (s.turns >= s.maxTurns) s.status = 'ended';
      if (s.status !== 'live') s.endedAt = now();
      s.updatedAt = now();
      const { id, ...data } = s;
      await store.set(sessionsOf(req.user.id), id, data);
      return { ...sessionView(s), newlyRevealed: newly };
    });
    res.json(out);
  } catch (err) { fail(res, err, 'The other side did not answer. Try again.'); }
});

app.post('/api/rounds/:id/hint', ...spend, async (req, res) => {
  try {
    const s = await loadSession(req);
    if (s.status !== 'live') throw httpError(409, 'This round is over.');
    if ((s.hintsUsed || 0) >= MAX_HINTS) throw httpError(429, `You have used all ${MAX_HINTS} whispers this round.`);
    const client = await clientFor(req);
    const h = await coach.hint(client, HINT_MODEL, s.scenario, s);
    await store.merge(sessionsOf(req.user.id), s.id, { hintsUsed: (s.hintsUsed || 0) + 1, updatedAt: now() });
    res.json({ ...h, hintsUsed: (s.hintsUsed || 0) + 1, maxHints: MAX_HINTS });
  } catch (err) { fail(res, err, 'The coach lost their voice. Try again.'); }
});

/** End the round (if it is still going) and score it. Safe to call twice: a
 *  scored round answers with its scorecard rather than paying again. */
app.post('/api/rounds/:id/finish', ...spend, async (req, res) => {
  try {
    const out = await exclusive(`${req.user.id}/${req.params.id}`, async () => {
      const s = await loadSession(req);
      if (s.scorecard) return sessionView(s);
      const said = (s.transcript || []).filter((t) => t.who === 'you').length;
      if (!said) {
        await store.remove(sessionsOf(req.user.id), s.id);
        return { id: s.id, abandoned: true };
      }
      if (s.status === 'live') { s.status = 'ended'; s.endedAt = now(); }
      const client = await clientFor(req);
      const card = await coach.score(client, modelFor(req), s.scenario, s);

      const player = await loadPlayer(req.user);
      const award = game.award(player, s, card);
      const { id: _pid, ...pdata } = award.player;
      await store.set('players', req.user.id, pdata);

      s.scorecard = card;
      s.scoredAt = now();
      s.award = { gained: award.gained, levelUp: award.levelUp, earned: award.earned, personalBest: award.personalBest, level: game.levelFor(award.player.xp) };
      const { id, ...data } = s;
      await store.set(sessionsOf(req.user.id), id, data);

      // The daily board keeps each player's best, and only for today's
      // challenge: a round started yesterday and scored today is not today's.
      if (s.daily && s.daily === scenarios.dayKey()) {
        const path_ = `daily/${s.daily}/scores`;
        const prev = await store.get(path_, req.user.id);
        if (!prev || card.overall > prev.score) {
          await store.set(path_, req.user.id, { handle: pdata.handle, score: card.overall, grade: card.grade, status: s.status, at: now() });
        }
      }
      if (s.teamId) {
        await store.add(`teams/${s.teamId}/results`, {
          uid: req.user.id, handle: pdata.handle, assignmentId: s.assignmentId || null,
          title: s.scenario.title, emoji: s.scenario.emoji, score: card.overall, grade: card.grade,
          status: s.status, difficulty: s.difficulty, at: now(),
        });
      }
      return sessionView(s);
    });
    res.json(out);
  } catch (err) { fail(res, err, 'The coach could not score that. Try again.'); }
});

app.delete('/api/rounds/:id', identity.requireUser, async (req, res) => {
  try {
    const s = await loadSession(req);
    await store.remove(sessionsOf(req.user.id), s.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** Publish a scorecard. The transcript goes only if asked for: what someone
 *  typed while practising a raise conversation is theirs to decide about. */
app.post('/api/rounds/:id/share', identity.requireUser, async (req, res) => {
  try {
    const s = await loadSession(req);
    if (!s.scorecard) throw httpError(409, 'Finish the round first.');
    const withTranscript = (req.body || {}).transcript === true;
    const player = await loadPlayer(req.user);
    const shareId = s.shareId || newId(10);
    await store.set('shares', shareId, {
      handle: player.handle,
      scenario: scenarios.publicView(s.scenario),
      difficulty: s.difficulty,
      status: s.status,
      daily: s.daily || null,
      moodTrail: s.moodTrail || [],
      scorecard: s.scorecard,
      transcript: withTranscript ? s.transcript.map((t) => ({ who: t.who, text: t.text, mood: t.mood })) : null,
      createdAt: now(),
    });
    await store.merge(sessionsOf(req.user.id), s.id, { shareId });
    res.json({ shareId, url: `/?s=${shareId}` });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Scenarios you build
 * ------------------------------------------------------------------ */

app.get('/api/custom', identity.requireUser, async (req, res) => {
  try {
    const rows = await store.list(customOf(req.user.id), { orderBy: 'createdAt', dir: 'desc', limit: MAX_CUSTOM });
    res.json({ scenarios: rows.map((r) => ({ ...scenarios.publicView(r), id: r.id, createdAt: r.createdAt })) });
  } catch (err) { fail(res, err); }
});

app.post('/api/custom', ...spend, async (req, res) => {
  try {
    const description = coach.clean((req.body || {}).description, 1200);
    if (description.length < 20) throw httpError(400, 'Describe the situation in a sentence or two - who, what you want, and why it is hard.');
    const existing = await store.list(customOf(req.user.id), { limit: MAX_CUSTOM + 1 });
    if (existing.length >= MAX_CUSTOM) throw httpError(409, `You have ${MAX_CUSTOM} scenarios. Delete one to build another.`);
    const client = await clientFor(req);
    const s = await coach.invent(client, INVENT_MODEL, description);
    const row = { ...s, prompt: description, createdAt: now() };
    const id = await store.add(customOf(req.user.id), row);
    res.json({ ...scenarios.publicView(row), id });
  } catch (err) { fail(res, err, 'Could not build that scenario. Try again.'); }
});

app.delete('/api/custom/:id', identity.requireUser, async (req, res) => {
  try {
    await store.remove(customOf(req.user.id), String(req.params.id));
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Teams - the business half
 *
 * A manager makes a team, shares a six-letter code, and assigns drills -
 * library scenarios or ones they built about their own product. Members play
 * them on their own credit, and the manager sees who practised and how they
 * scored. Nobody sees anyone else's transcript: a team sees scores, never
 * what someone typed.
 * ------------------------------------------------------------------ */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function teamCode() {
  const bytes = crypto.randomBytes(6);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

async function loadTeam(req, { owner = false } = {}) {
  const t = await store.get('teams', String(req.params.id));
  // 404 rather than 403 for a team you are not in, so ids are not confirmed.
  if (!t || !(t.memberIds || []).includes(req.user.id)) throw httpError(404, 'No such team.');
  if (owner && t.ownerId !== req.user.id) throw httpError(403, 'Only the team owner can do that.');
  return t;
}

app.get('/api/teams', identity.requireUser, async (req, res) => {
  try {
    const p = await loadPlayer(req.user);
    const teams = [];
    for (const tid of (p.teamIds || []).slice(0, 10)) {
      const t = await store.get('teams', tid);
      if (t && (t.memberIds || []).includes(req.user.id)) {
        teams.push({ id: t.id, name: t.name, owner: t.ownerId === req.user.id, members: (t.memberIds || []).length, drills: (t.assignments || []).length });
      }
    }
    res.json({ teams });
  } catch (err) { fail(res, err); }
});

app.post('/api/teams', identity.requireUser, async (req, res) => {
  try {
    const name = coach.clean((req.body || {}).name, 40);
    if (name.length < 2) throw httpError(400, 'Give the team a name.');
    const p = await loadPlayer(req.user);
    const owned = (p.ownedTeams || 0);
    if (owned >= MAX_TEAMS_OWNED) throw httpError(409, `You can own up to ${MAX_TEAMS_OWNED} teams.`);
    let code = teamCode();
    for (let i = 0; i < 5 && (await store.get('teamcodes', code)); i++) code = teamCode();
    const team = {
      name, code, ownerId: req.user.id, ownerHandle: p.handle,
      memberIds: [req.user.id],
      members: { [req.user.id]: { handle: p.handle, joinedAt: now() } },
      assignments: [], createdAt: now(),
    };
    const id = await store.add('teams', team);
    await store.set('teamcodes', code, { teamId: id });
    await store.merge('players', req.user.id, { teamIds: [...new Set([...(p.teamIds || []), id])], ownedTeams: owned + 1 });
    res.json({ id, name, code });
  } catch (err) { fail(res, err); }
});

app.post('/api/teams/join', identity.requireUser, async (req, res) => {
  try {
    const code = String((req.body || {}).code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const link = code.length === 6 ? await store.get('teamcodes', code) : null;
    const t = link && await store.get('teams', link.teamId);
    if (!t) throw httpError(404, 'No team has that code. Check it with whoever sent it.');
    const p = await loadPlayer(req.user);
    if (!(t.memberIds || []).includes(req.user.id)) {
      if ((t.memberIds || []).length >= MAX_TEAM_MEMBERS) throw httpError(409, 'That team is full.');
      await store.merge('teams', t.id, {
        memberIds: [...(t.memberIds || []), req.user.id],
        members: { [req.user.id]: { handle: p.handle, joinedAt: now() } },
      });
    }
    await store.merge('players', req.user.id, { teamIds: [...new Set([...(p.teamIds || []), t.id])] });
    res.json({ id: t.id, name: t.name });
  } catch (err) { fail(res, err); }
});

app.get('/api/teams/:id', identity.requireUser, async (req, res) => {
  try {
    const t = await loadTeam(req);
    const results = await store.list(`teams/${t.id}/results`, { orderBy: 'at', dir: 'desc', limit: 200 });
    const members = [];
    for (const uid of (t.memberIds || []).slice(0, MAX_TEAM_MEMBERS)) {
      const p = await store.get('players', uid);
      const mine = results.filter((r) => r.uid === uid);
      members.push({
        handle: (p && p.handle) || (t.members[uid] || {}).handle || 'Player',
        you: uid === req.user.id,
        owner: uid === t.ownerId,
        level: game.levelFor((p && p.xp) || 0),
        rounds: (p && p.rounds) || 0,
        wins: (p && p.wins) || 0,
        streak: (p && p.streak) || 0,
        skills: p ? game.skillProfile(p) : null,
        teamRounds: mine.length,
        teamAvg: mine.length ? Math.round(mine.reduce((a, r) => a + r.score, 0) / mine.length) : null,
        drills: Object.fromEntries((t.assignments || []).map((a) => {
          const best = mine.filter((r) => r.assignmentId === a.id).reduce((m, r) => Math.max(m, r.score), -1);
          return [a.id, best >= 0 ? best : null];
        })),
      });
    }
    members.sort((a, b) => (b.teamAvg ?? -1) - (a.teamAvg ?? -1) || b.level.xp - a.level.xp);
    res.json({
      id: t.id, name: t.name, code: t.code, owner: t.ownerId === req.user.id, ownerHandle: t.ownerHandle,
      assignments: (t.assignments || []).map((a) => ({
        id: a.id, note: a.note, createdAt: a.createdAt, difficulty: a.difficulty || 'realistic',
        scenario: scenarios.publicView(a.scenario),
        done: members.filter((m) => m.drills[a.id] != null).length,
      })),
      members,
      feed: results.slice(0, 30).map((r) => ({ handle: r.handle, title: r.title, emoji: r.emoji, score: r.score, grade: r.grade, status: r.status, at: r.at })),
    });
  } catch (err) { fail(res, err); }
});

app.post('/api/teams/:id/assignments', identity.requireUser, async (req, res) => {
  try {
    const t = await loadTeam(req, { owner: true });
    if ((t.assignments || []).length >= MAX_ASSIGNMENTS) throw httpError(409, `A team can have ${MAX_ASSIGNMENTS} drills. Remove one first.`);
    const b = req.body || {};
    let s = null;
    if (b.customId) {
      const c = await store.get(customOf(req.user.id), String(b.customId));
      if (c) { const { id: _i, prompt: _p, createdAt: _c, ...rest } = c; s = rest; }
    } else {
      s = scenarios.get(b.scenarioId);
    }
    if (!s) throw httpError(404, 'No such scenario.');
    const a = {
      id: newId(8), scenario: s, note: coach.clean(b.note, 200),
      difficulty: scenarios.DIFFICULTIES[b.difficulty] ? b.difficulty : 'realistic', createdAt: now(),
    };
    await store.merge('teams', t.id, { assignments: [...(t.assignments || []), a] });
    res.json({ ok: true, id: a.id });
  } catch (err) { fail(res, err); }
});

app.delete('/api/teams/:id/assignments/:aid', identity.requireUser, async (req, res) => {
  try {
    const t = await loadTeam(req, { owner: true });
    await store.merge('teams', t.id, { assignments: (t.assignments || []).filter((a) => a.id !== req.params.aid) });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

app.post('/api/teams/:id/leave', identity.requireUser, async (req, res) => {
  try {
    const t = await loadTeam(req);
    const p = await loadPlayer(req.user);
    if (t.ownerId === req.user.id) {
      // The owner leaving ends the team: nobody else can assign drills, and a
      // team nobody runs is a leaderboard nobody reads.
      for (const uid of t.memberIds || []) {
        const m = await store.get('players', uid);
        if (m) await store.merge('players', uid, { teamIds: (m.teamIds || []).filter((x) => x !== t.id) });
      }
      await store.remove('teamcodes', t.code);
      await store.remove('teams', t.id);
      await store.merge('players', req.user.id, { ownedTeams: Math.max(0, (p.ownedTeams || 1) - 1) });
      return res.json({ ok: true, deleted: true });
    }
    const members = { ...t.members };
    delete members[req.user.id];
    // A merge cannot delete a nested key, so the members map is written whole.
    const { id: _tid, ...rest } = t;
    await store.set('teams', t.id, { ...rest, memberIds: (t.memberIds || []).filter((x) => x !== req.user.id), members });
    await store.merge('players', req.user.id, { teamIds: (p.teamIds || []).filter((x) => x !== t.id) });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`spar listening on ${PORT}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore };
