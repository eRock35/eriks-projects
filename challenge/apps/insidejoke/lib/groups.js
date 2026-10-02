// A group, its daily rounds, its board and its live games: pure rules, no
// store. The server reads a document, runs one of these inside a
// transaction, and writes what comes back. Every change bumps `v`, so a
// phone polling with `?since=v` gets a one-line "nothing new" answer.
//
// What a group document holds - and nothing else:
//   {id, name, code, ownerTag, accountTags, tz, createdAt, updatedAt, v,
//    members: [{id, name, emoji, color, keyHash|null, acct|null, host, joinedAt}],
//    photoCount, questionCount}
//
// - `ownerTag` and `acct` are HMACs of an account id under a key derived from
//   the identity secret: they prove who signed in without the group holding
//   an account id or an email. `accountTags` lists them so "my groups" is one
//   array-contains query.
// - `keyHash` is sha256(the browser's key + the group id). The key lives in an
//   HttpOnly cookie scoped to the app's path; the hash differs per group, so
//   two groups cannot be linked to one phone.
// - Member ids are random per group. That is all any member learns about
//   another: a name, an emoji, a colour and a random id.

const crypto = require('crypto');
const Core = require('../public/ij-core');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_LEN = 6;                                         // 32^6 ≈ 1.07 billion
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const ID_RE = /^[a-z0-9]{16}$/;

const LIMITS = {
  groupsPerHost: 10,
  members: Core.LIMITS.members,      // 30, the host included
  newMembersPerIp: 30,               // new members one address may add...
  newMembersWindowMs: 60 * 60 * 1000, // ...an hour
  missesPerIp: 30,                   // distinct wrong codes one address may try...
  missWindowMs: 15 * 60 * 1000,      // ...in 15 minutes
  writesPerIp: 600,                  // answers and other writes, per address...
  writesWindowMs: 10 * 60 * 1000,    // ...in 10 minutes
  questionsPerPost: 20,
  liveIdleMs: 6 * 60 * 60 * 1000,    // a live game nobody touched for 6 hours is over
  revealMs: 6000,                    // the reveal, in timer mode
  timers: [0, 15, 20, 30],           // seconds a question; 0 = the host advances
  liveCounts: [5, 10, 15, 20],
  boardDays: 400,                    // daily scores kept for week/month boards and streaks
};

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, expose: true }, extra || {});
}
function need(cond, status, message) { if (!cond) throw httpError(status, message); }

/* ---------------- ids, codes, tags ---------------- */

function newCode() {
  let out = '';
  while (out.length < CODE_LEN) {
    for (const b of crypto.randomBytes(12)) {
      if (b < 256 - (256 % CODE_ALPHABET.length)) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LEN) break;
    }
  }
  return out;
}
function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }
function isCode(v) { return CODE_RE.test(String(v || '')); }
function formatCode(c) { const s = normalizeCode(c); return s.length === CODE_LEN ? `${s.slice(0, 3)}-${s.slice(3)}` : s; }

/** 16 random characters from a-z0-9, uniform. */
function newId() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  while (s.length < 16) for (const b of crypto.randomBytes(24)) { if (b < 252 && s.length < 16) s += abc[b % 36]; }
  return s;
}
const isId = (v) => ID_RE.test(String(v || ''));

function derived(secret, purpose) { return crypto.createHmac('sha256', String(secret)).update(purpose).digest(); }
/** An account's tag in this app: the same in every group (so "my groups" is
 *  one query), and not the account id. */
function acctTag(uid, secret) {
  return crypto.createHmac('sha256', derived(secret, 'insidejoke account v1')).update(String(uid)).digest('base64url').slice(0, 27);
}
function keyHash(key, gid) { return crypto.createHash('sha256').update(`${key}:${gid}`).digest('base64url').slice(0, 32); }
function newKey() { return crypto.randomBytes(16).toString('base64url'); }
function newMid() { return `m${newId().slice(0, 11)}`; }

function touch(doc, now) { doc.v = (doc.v || 0) + 1; doc.updatedAt = new Date(now).toISOString(); return doc; }

/* ---------------- the group ---------------- */

function cleanGroupName(v) {
  const s = Core.clean(v, Core.LIMITS.groupName);
  return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
}
function pickColor(doc, wanted) {
  const taken = new Set((doc.members || []).map((m) => m.color));
  if (Core.COLOR_IDS.includes(wanted) && !taken.has(wanted)) return wanted;
  return Core.COLOR_IDS.find((c) => !taken.has(c)) || (Core.COLOR_IDS.includes(wanted) ? wanted : Core.COLOR_IDS[0]);
}
const pickEmoji = (e) => (Core.EMOJI.includes(e) ? e : Core.EMOJI[0]);

function createGroup({ gid, code, name, tz, host, tag, hash, now }) {
  const n = cleanGroupName(name);
  need(n, 400, 'Give the group a name, like “The Strongs” or “College crew”.');
  const hn = Core.cleanName(host && host.name);
  need(hn, 400, 'Add your own name (or a nickname) too.');
  const at = new Date(now).toISOString();
  const doc = {
    id: gid, name: n, code, ownerTag: tag, accountTags: [tag], tz: Core.validTz(tz) ? tz : 'UTC',
    createdAt: at, updatedAt: at, v: 1, members: [], photoCount: 0, questionCount: 0,
  };
  doc.members.push({ id: newMid(), name: hn, emoji: pickEmoji(host.emoji), color: pickColor(doc, host.color), keyHash: hash || null, acct: tag, host: true, joinedAt: at });
  return doc;
}

/** Who is asking: {mid, host, member}. A browser is known by its key's hash,
 *  an account by its tag; the host is the member whose account owns the
 *  group, and only while signed in as it. */
function actorOf(doc, { hash, tag }) {
  const byKey = hash ? doc.members.find((m) => m.keyHash && m.keyHash === hash) : null;
  const byAcct = tag ? doc.members.find((m) => m.acct && m.acct === tag) : null;
  const member = byAcct || byKey || null;
  const host = Boolean(member && member.host && tag && doc.ownerTag === tag && member.acct === tag);
  return { mid: member ? member.id : null, host, member };
}

function memberView(m, me) {
  return { id: m.id, name: m.name, emoji: m.emoji, color: m.color, host: Boolean(m.host), linked: Boolean(m.acct), you: m.id === me };
}
function groupView(doc, actor, today) {
  return {
    id: doc.id, name: doc.name, code: doc.code, display: formatCode(doc.code), tz: doc.tz, v: doc.v || 0,
    members: doc.members.map((m) => memberView(m, actor.mid)),
    me: actor.mid, host: actor.host, today,
    counts: { photos: doc.photoCount || 0, questions: doc.questionCount || 0 },
    limits: { members: LIMITS.members, photos: Core.LIMITS.photos, questions: Core.LIMITS.questions },
  };
}

/** A new member, by name and emoji. A browser (or an account) that already
 *  joined gets its own seat back. Returns {mid, isNew}. */
function join(doc, { hash, tag, name, emoji, color }, now) {
  const mine = doc.members.find((m) => (hash && m.keyHash === hash) || (tag && m.acct === tag));
  if (mine) {
    if (hash && !mine.keyHash) mine.keyHash = hash;
    return { mid: mine.id, isNew: false };
  }
  const n = Core.cleanName(name);
  need(n, 400, 'Add your name (or a nickname) first.');
  need(doc.members.length < LIMITS.members, 409, `This group is full - ${LIMITS.members} people at most.`);
  const m = { id: newMid(), name: n, emoji: pickEmoji(emoji), color: pickColor(doc, color), keyHash: hash || null, acct: null, host: false, joinedAt: new Date(now).toISOString() };
  doc.members.push(m);
  touch(doc, now);
  return { mid: m.id, isNew: true };
}

/** Keep this seat across devices: tie it to the signed-in account. */
function link(doc, actor, tag, now) {
  need(actor.member, 404, 'Join the group first.');
  need(tag, 401, 'Sign in to keep your seat on every device.');
  const other = doc.members.find((m) => m.acct === tag && m.id !== actor.mid);
  need(!other, 409, `This account already has a seat here (${other ? other.name : ''}).`);
  need(!actor.member.acct || actor.member.acct === tag, 409, 'This seat belongs to another account.');
  actor.member.acct = tag;
  if (!doc.accountTags.includes(tag)) doc.accountTags.push(tag);
  return touch(doc, now);
}

function editMember(doc, actor, { mid, name, emoji, color }, now) {
  const who = mid || actor.mid;
  need(actor.member, 404, 'Join the group first.');
  need(actor.host || who === actor.mid, 403, 'You can only change your own name.');
  const m = doc.members.find((x) => x.id === who);
  need(m, 404, 'That person is not in this group.');
  if (name !== undefined) { const n = Core.cleanName(name); need(n, 400, 'A name needs a letter, a number or an emoji.'); m.name = n; }
  if (emoji !== undefined) { need(Core.EMOJI.includes(emoji), 400, 'Pick one of the emoji.'); m.emoji = emoji; }
  if (color !== undefined) { need(Core.COLOR_IDS.includes(color), 400, 'Pick one of the colours.'); m.color = color; }
  return touch(doc, now);
}

function removeMember(doc, actor, mid, now) {
  const self = mid === actor.mid;
  need(actor.host || self, 403, 'Only the host can remove someone.');
  const m = doc.members.find((x) => x.id === mid);
  need(m, 404, 'That person is not in this group.');
  need(!m.host, 409, self ? 'You run this group - delete it instead, or keep it.' : 'The host can’t be removed.');
  doc.members = doc.members.filter((x) => x.id !== mid);
  if (m.acct && !doc.members.some((x) => x.acct === m.acct)) doc.accountTags = doc.accountTags.filter((t) => t !== m.acct);
  return touch(doc, now);
}

function settings(doc, actor, { name, tz }, now) {
  need(actor.host, 403, 'Only the host can change the group.');
  if (name !== undefined) { const n = cleanGroupName(name); need(n, 400, 'The group needs a name.'); doc.name = n; }
  if (tz !== undefined) { need(Core.validTz(tz), 400, 'That time zone is not one we know.'); doc.tz = tz; }
  return touch(doc, now);
}

/* ---------------- the bank's index (on the board document) ---------------- */

// The board document carries a compact index of the live bank, so drawing a
// day's round reads one document and ten questions, never the whole bank.

function newBoard(gid) { return { gid, days: {}, total: {}, best: {}, used: {}, bank: {} }; }
function bankAdd(board, q) { board.bank = board.bank || {}; board.bank[q.id] = [q.style, q.photoId || '', q.createdBy || '']; }
function bankRemove(board, ids) { for (const id of ids) if (board.bank) delete board.bank[id]; }
function bankList(board) {
  return Object.entries((board && board.bank) || {}).map(([id, r]) => ({ id, style: r[0], photoId: r[1] || null, createdBy: r[2] || null }));
}

/* ---------------- daily rounds ---------------- */

const roundId = (gid, date) => `${gid}_${date}`;

/** What a round keeps of a question: everything needed to grade it later,
 *  so editing or deleting the question never changes a day already drawn. */
function snapshot(q) {
  return {
    id: q.id, kind: q.kind, style: q.style, prompt: q.prompt, quote: q.quote || null, options: q.options || null, members: q.members || null,
    answer: q.answer === undefined ? null : q.answer, tolerance: q.tolerance || null, unit: q.unit || null, photoId: q.photoId || null,
    createdBy: q.createdBy || null, aboutName: q.aboutName || null,
  };
}

function newRound(gid, date, questions) {
  const qs = {};
  for (const q of questions) qs[q.id] = snapshot(q);
  return { gid, date, cands: questions.map((q) => q.id), qs, answers: {}, v: 1 };
}

/** One player's five ids: fixed at their first answer, so a question added
 *  or a name changed later never reshuffles a round half played. */
function playerIds(round, member) {
  const a = round.answers && round.answers[member.id];
  if (a && Array.isArray(a.order)) return a.order;
  return Core.roundFor(round.cands.map((id) => round.qs[id]).filter(Boolean), member).map((q) => q.id);
}

function marksOf(round, a) {
  return (a.order || []).map((id) => (a.picks[id] ? a.picks[id].ok : undefined));
}

/** The round as one member sees it. Answers are shown for what they have
 *  answered; everyone's results only once they have finished. */
function roundView(round, group, actor, now) {
  const member = actor.member;
  const ids = playerIds(round, member);
  const mine = (round.answers || {})[member.id] || null;
  const picks = (mine && mine.picks) || {};
  const qs = ids.map((id) => {
    const q = round.qs[id];
    const out = { ...Core.publicQuestion(q), n: ids.indexOf(id) + 1 };
    if (q.members) out.options = q.members.map((mid, i) => { const m = group.members.find((x) => x.id === mid); return m ? m.name : q.options[i]; });
    if (picks[id]) { out.picked = picks[id].a; out.ok = picks[id].ok; out.answer = q.answer; out.tolerance = q.tolerance; }
    return out;
  });
  const done = Boolean(mine && mine.done);
  const byId = Object.fromEntries(group.members.map((m) => [m.id, m]));
  const results = [];
  let captions = null;
  if (done) {
    for (const [mid, a] of Object.entries(round.answers || {})) {
      if (!a.done || !byId[mid]) continue;
      results.push({ id: mid, name: byId[mid].name, emoji: byId[mid].emoji, color: byId[mid].color, score: a.score, of: a.of, from: a.from || null, marks: marksOf(round, a), you: mid === member.id });
    }
    results.sort((x, y) => (y.score - x.score) || (x.name < y.name ? -1 : 1));
    // The group's favourite caption so far, for each caption question.
    captions = {};
    for (const id of round.cands) {
      const q = round.qs[id];
      if (!q || q.kind !== 'caption') continue;
      const votes = {};
      for (const a of Object.values(round.answers || {})) if (a.picks && a.picks[id]) votes[a.picks[id].a] = (votes[a.picks[id].a] || 0) + 1;
      const best = Object.keys(votes).sort((x, y) => votes[y] - votes[x] || x - y)[0];
      if (best !== undefined) captions[id] = { text: q.options[Number(best)], votes: votes[best] };
    }
  }
  const waiting = group.members.filter((m) => !(round.answers[m.id] && round.answers[m.id].done)).map((m) => ({ id: m.id, name: m.name, emoji: m.emoji, you: m.id === member.id }));
  return {
    date: round.date, label: Core.dateLabel(round.date), v: round.v || 0, questions: qs, done,
    score: mine ? mine.score || 0 : 0, of: qs.filter((q) => q.kind !== 'caption').length,
    from: mine ? mine.from || null : null,
    results: done ? results : null, captions, waiting,
    closesInMs: Core.msToMidnight(group.tz, now), tz: group.tz,
  };
}

/** One answer to one of today's questions. Once given it stands. Returns
 *  {finished: bool} - true on the answer that completes the round. */
function answerDaily(round, member, { qid, a, from }, now) {
  const ids = playerIds(round, member);
  need(ids.includes(qid), 404, 'That question is not in your round today.');
  const q = round.qs[qid];
  need(Core.validAnswer(q, a), 400, q.kind === 'number' ? 'Type a number.' : 'Pick one of the answers.');
  round.answers = round.answers || {};
  const cur = round.answers[member.id] || { order: ids, picks: {}, score: 0, of: ids.map((id) => round.qs[id]).filter((x) => x.kind !== 'caption').length, done: false, from: null };
  need(!cur.picks[qid], 409, 'You’ve answered that one already.');
  const ok = Core.grade(q, a);
  cur.picks[qid] = { a, ok };
  if (ok) cur.score++;
  if (from !== undefined && from !== null) { const f = Core.clean(from, Core.LIMITS.city); cur.from = f || null; }
  let finished = false;
  if (!cur.done && ids.every((id) => cur.picks[id])) { cur.done = true; cur.at = new Date(now).toISOString(); finished = true; }
  round.answers[member.id] = cur;
  round.v = (round.v || 0) + 1;
  return { finished, score: cur.score, of: cur.of };
}

/** Record a finished round on the board: idempotent (a second call for the
 *  same member and day changes nothing). */
function recordDay(board, date, mid, score, of) {
  board.days = board.days || {};
  board.total = board.total || {};
  board.best = board.best || {};
  const day = board.days[date] || {};
  if (day[mid]) return false;
  day[mid] = [score, of];
  board.days[date] = day;
  const t = board.total[mid] || { pts: 0, played: 0 };
  t.pts += score; t.played += 1;
  board.total[mid] = t;
  const mine = Object.keys(board.days).filter((d) => board.days[d][mid]);
  board.best[mid] = Math.max(board.best[mid] || 0, Core.streakOf(mine, date).best);
  const oldest = Core.addDays(date, -LIMITS.boardDays);
  for (const d of Object.keys(board.days)) if (d < oldest) delete board.days[d];
  return true;
}
function markUsed(board, ids, date) {
  board.used = board.used || {};
  for (const id of ids) board.used[id] = date;
  const oldest = Core.addDays(date, -Core.LIMITS.noRepeatDays);
  for (const [id, d] of Object.entries(board.used)) if (d < oldest) delete board.used[id];
}
function dropMember(board, mid) {
  for (const d of Object.keys(board.days || {})) { delete board.days[d][mid]; if (!Object.keys(board.days[d]).length) delete board.days[d]; }
  if (board.total) delete board.total[mid];
  if (board.best) delete board.best[mid];
}

/* ---------------- live game night ---------------- */

function newLive(gid, { qs, seconds, by, now }) {
  return {
    gid, v: 1, state: 'lobby', by, seconds: LIMITS.timers.includes(seconds) ? seconds : 20,
    qs: qs.map(snapshot), idx: -1, openedAt: null, closesAt: null, revealAt: null, endedAt: null,
    players: {}, answers: {}, results: {}, createdAt: now, updatedAt: now,
  };
}

function liveReveal(live, at) {
  const q = live.qs[live.idx];
  const answers = live.answers[live.idx] || {};
  const s = Core.settleReveal(q, answers);
  for (const [mid, pts] of Object.entries(s.pts)) {
    live.players[mid] = live.players[mid] || { score: 0 };
    live.players[mid].score += pts;
  }
  live.results[live.idx] = { pts: s.pts, best: s.best === Infinity ? null : s.best };
  live.state = 'reveal';
  live.revealAt = at;
}
function liveOpenNext(live, at) {
  if (live.idx + 1 >= live.qs.length) { live.state = 'podium'; live.endedAt = at; return; }
  live.idx += 1;
  live.state = 'question';
  live.openedAt = at;
  live.closesAt = live.seconds ? at + live.seconds * 1000 : null;
  live.revealAt = null;
}

/** Timer mode needs no server timer: whichever request finds a question
 *  past its window (or a reveal past its six seconds) moves the game on, as
 *  of the moment it was due. Returns whether anything moved. */
function liveAdvanceDue(live, now) {
  let moved = false;
  for (let guard = 0; guard < 100; guard++) {
    if (live.state === 'question' && live.seconds && now >= live.closesAt + Core.LIVE.graceMs) { liveReveal(live, live.closesAt + Core.LIVE.graceMs); moved = true; continue; }
    if (live.state === 'reveal' && live.seconds && now >= live.revealAt + LIMITS.revealMs) { liveOpenNext(live, live.revealAt + LIMITS.revealMs); moved = true; continue; }
    break;
  }
  if (moved) { live.v = (live.v || 0) + 1; live.updatedAt = now; }
  return moved;
}

/** The host's button: start, reveal now, next question. */
function liveNext(live, now) {
  if (live.state === 'lobby' || live.state === 'reveal') liveOpenNext(live, now);
  else if (live.state === 'question') liveReveal(live, now);
  else throw httpError(409, 'The game is over. Start a new one.');
  live.v = (live.v || 0) + 1;
  live.updatedAt = now;
}

function liveJoin(live, mid, now) {
  if (live.players[mid]) return false;
  live.players[mid] = { score: 0 };
  live.v = (live.v || 0) + 1;
  live.updatedAt = now;
  return true;
}

/** An answer, checked against the question's open window on the server's
 *  clock: the page's countdown is for show, this is the rule. */
function liveAnswer(live, mid, { idx, a }, now) {
  need(live.state === 'question' && idx === live.idx, 409, 'That question has closed.');
  if (live.seconds) need(now <= live.closesAt + Core.LIVE.graceMs, 409, 'Time’s up for that one.');
  const q = live.qs[live.idx];
  need(Core.validAnswer(q, a), 400, q.kind === 'number' ? 'Type a number.' : 'Pick one of the answers.');
  live.answers[idx] = live.answers[idx] || {};
  need(!live.answers[idx][mid], 409, 'You’ve answered this one.');
  const ms = Math.max(0, now - live.openedAt);
  live.answers[idx][mid] = { a, ms, pts: Core.livePoints(q, a, ms, live.seconds * 1000) };
  live.players[mid] = live.players[mid] || { score: 0 };
  live.v = (live.v || 0) + 1;
  live.updatedAt = now;
}

function liveView(live, group, actor, now) {
  const byId = Object.fromEntries(group.members.map((m) => [m.id, m]));
  const cur = live.idx >= 0 ? live.qs[live.idx] : null;
  const answers = cur ? live.answers[live.idx] || {} : {};
  const players = Object.entries(live.players).filter(([mid]) => byId[mid]).map(([mid, p]) => ({
    id: mid, name: byId[mid].name, emoji: byId[mid].emoji, color: byId[mid].color, score: p.score, answered: Boolean(answers[mid]), you: mid === actor.mid,
  })).sort((x, y) => y.score - x.score || (x.name < y.name ? -1 : 1));
  const out = {
    state: live.state, v: live.v || 0, idx: live.idx, count: live.qs.length, seconds: live.seconds,
    openedAt: live.openedAt, closesAt: live.closesAt, revealAt: live.revealAt, revealMs: LIMITS.revealMs, serverNow: now,
    players, host: actor.host, joined: Boolean(live.players[actor.mid]), question: null, mine: null, reveal: null,
  };
  if (cur && (live.state === 'question' || live.state === 'reveal')) {
    const pq = Core.publicQuestion(cur);
    if (cur.members) pq.options = cur.members.map((mid, i) => (byId[mid] ? byId[mid].name : cur.options[i]));
    out.question = pq;
    if (answers[actor.mid]) out.mine = { a: answers[actor.mid].a };
  }
  if (cur && live.state === 'reveal') {
    const res = live.results[live.idx] || { pts: {} };
    const tally = cur.options ? cur.options.map((_, i) => Object.values(answers).filter((x) => x.a === i).length) : null;
    const guesses = cur.kind === 'number' ? Object.entries(answers).filter(([mid]) => byId[mid]).map(([mid, x]) => ({ name: byId[mid].name, emoji: byId[mid].emoji, color: byId[mid].color, a: x.a, pts: res.pts[mid] || 0 })).sort((x, y) => Math.abs(x.a - cur.answer) - Math.abs(y.a - cur.answer)) : null;
    out.reveal = { answer: cur.answer, tally, guesses, best: res.best, mine: answers[actor.mid] ? res.pts[actor.mid] || 0 : null, answeredBy: Object.keys(answers).length };
  }
  if (live.state === 'podium') out.podium = players.slice();
  return out;
}

module.exports = {
  CODE_ALPHABET, CODE_LEN, LIMITS, httpError, need,
  newCode, normalizeCode, isCode, formatCode, newId, isId, acctTag, keyHash, newKey, newMid,
  cleanGroupName, createGroup, actorOf, groupView, memberView, join, link, editMember, removeMember, settings, touch,
  newBoard, bankAdd, bankRemove, bankList, roundId, snapshot, newRound, playerIds, roundView, answerDaily, recordDay, markUsed, dropMember,
  newLive, liveAdvanceDue, liveNext, liveJoin, liveAnswer, liveView, liveReveal,
};
