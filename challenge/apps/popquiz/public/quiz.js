/* Pop Quiz's rules - everything that needs no model, in one file that runs in
 * the browser AND on the server (server.js requires it).
 *
 *   validateQuestion(raw)   one question, checked and cleaned: exactly one
 *                           right answer, distinct options, bounded lengths,
 *                           no markup. The model's proposals, the manager's
 *                           edits and hand-written questions all go through it.
 *   review(card, right)     the Leitner box scheme: a miss goes back to box 1
 *                           and returns tomorrow; each hit moves it up a box
 *                           and further away (1, 2, 4, 7, 14 days).
 *   pickDaily(...)          today's five: due reviews first, lowest box first,
 *                           always room for one new question.
 *   streaks, XP, badges, the weekly leaderboard, mastery and blind spots.
 *
 * One implementation on purpose: the editor validates a question live as the
 * manager types, the server validates what it saves, and the two cannot
 * disagree about what a valid question is. The sample quiz a signed-out
 * visitor plays runs the same check() the server runs on a real answer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PopQuiz = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;

  /* ---------------- vocabulary ---------------- */

  var QTYPES = [
    { key: 'mcq', label: 'Multiple choice', short: 'Multiple choice', min: 4, max: 4 },
    { key: 'tf', label: 'True or false', short: 'True or false', min: 2, max: 2 },
    { key: 'which', label: 'Which one is it?', short: 'Which one?', min: 2, max: 4 },
  ];
  var QTYPE_KEYS = QTYPES.map(function (t) { return t.key; });

  var LIMITS = {
    promptMin: 8, prompt: 240, option: 100, explanation: 300, explanationMin: 10,
    source: 200, topic: 40, perDeck: 40, perDay: 5,
  };

  // Days until a card comes back, by the box it is in. Box 0 is "never seen".
  var INTERVALS = [0, 1, 2, 4, 7, 14];
  var TOP_BOX = 5;
  // A question counts as known from box 3: answered right at least twice in a
  // row since it was last missed.
  var KNOWN_BOX = 3;

  var XP = { right: 10, wrong: 2, finish: 10, perfect: 20 };

  var BADGES = [
    { key: 'first', emoji: '🎯', label: 'First quiz', detail: 'Finished a daily quiz.' },
    { key: 'perfect', emoji: '💯', label: 'Perfect day', detail: 'Five out of five.' },
    { key: 'streak3', emoji: '🔥', label: 'On a roll', detail: 'A 3-day streak.' },
    { key: 'streak7', emoji: '⚡', label: 'Week streak', detail: 'Seven days in a row.' },
    { key: 'comeback', emoji: '💪', label: 'Comeback', detail: 'Got one right that you had missed before.' },
    { key: 'sharp', emoji: '🧠', label: 'Sharp', detail: 'Five perfect days.' },
    { key: 'xp500', emoji: '🏅', label: '500 XP', detail: 'Five hundred points of know-how.' },
    { key: 'master', emoji: '🎓', label: 'Know-it-all', detail: '80% mastery with 10+ questions to know.' },
  ];

  // Join codes: 8 characters from 32 that cannot be misread (no 0/O, 1/I).
  // 32^8 is about 1.1 trillion, so a guess is hopeless even before the server
  // limits how many a person may make.
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 8;
  var CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

  /* ---------------- text ---------------- */

  /** One line: tags stripped, then any stray angle bracket, control
   *  characters and runs of whitespace. Everything here ends up in a page. */
  function clean(v, max) {
    return String(v == null ? '' : v)
      .replace(/<\/?[a-z!][^>]*>/gi, '')
      .replace(/[<>]/g, '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 400);
  }
  function same(a, b) { return norm(a) === norm(b); }
  function norm(s) { return String(s || '').toLowerCase().replace(/[\s.!?,;:'"’“”]+/g, ' ').trim(); }

  function typeInfo(k) { for (var i = 0; i < QTYPES.length; i++) if (QTYPES[i].key === k) return QTYPES[i]; return null; }
  function badgeInfo(k) { for (var i = 0; i < BADGES.length; i++) if (BADGES[i].key === k) return BADGES[i]; return null; }

  /* ---------------- dates ---------------- */

  function isoDay(v) {
    var s = String(v == null ? '' : v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var t = Date.parse(s + 'T00:00:00Z');
    if (!isFinite(t)) return null;
    return new Date(t).toISOString().slice(0, 10) === s ? s : null;
  }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY); }
  /** Monday of the week the day falls in: the leaderboard's week. */
  function weekStart(iso) {
    var dow = new Date(iso + 'T00:00:00Z').getUTCDay(); // 0 Sunday
    return addDays(iso, -((dow + 6) % 7));
  }

  /** FNV-1a: a stable, seedable order, so today's quiz is the same five
   *  questions on every reload and different for each person. */
  function hash(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h;
  }

  /* ---------------- questions ---------------- */

  /**
   * One question in, checked and cleaned. Options come either as strings plus
   * an `answer` index (the editor, hand-written) or as {text, correct} objects
   * (the model) - with objects the flags decide, so a proposal that marks no
   * answer or two answers right is refused rather than guessed at.
   *
   * @param raw   {type, prompt, options, answer?, explanation, source, topic, id?}
   * @param opts  {strict}: the model's proposals must explain their answer.
   * @returns     {q} or {error}
   */
  function validateQuestion(raw, opts) {
    opts = opts || {};
    var fail = function (e) { return { error: e }; };
    if (!raw || typeof raw !== 'object') return fail('That question is empty.');
    var type = String(raw.type || '').toLowerCase();
    var t = typeInfo(type);
    if (!t) return fail('Pick a question type.');
    var prompt = clean(raw.prompt, LIMITS.prompt);
    if (prompt.length < LIMITS.promptMin) return fail('Write the question (a few words at least).');

    var list = Array.isArray(raw.options) ? raw.options.slice(0, 8) : [];
    var flagged = list.some(function (o) { return o && typeof o === 'object'; });
    var texts = [];
    var right = [];
    list.forEach(function (o, i) {
      if (o && typeof o === 'object') {
        texts.push(clean(o.text, LIMITS.option));
        if (o.correct === true) right.push(i);
      } else {
        texts.push(clean(o, LIMITS.option));
      }
    });
    if (!flagged && raw.answer !== undefined && raw.answer !== null && raw.answer !== '') {
      var a = Number(raw.answer);
      if (Number.isInteger(a)) right = [a];
    }

    if (type === 'tf') {
      // Always "True", "False", in that order, whatever the source spelled.
      if (texts.length !== 2) return fail('True or false needs exactly two options.');
      var isT = texts.map(function (x) { return /^(true|yes)$/i.test(x); });
      var isF = texts.map(function (x) { return /^(false|no)$/i.test(x); });
      if (!((isT[0] && isF[1]) || (isF[0] && isT[1]))) return fail('True or false options must be True and False.');
      if (right.length === 0) return fail('Mark the right answer.');
      if (right.length > 1) return fail('Only one answer can be right.');
      if (right[0] !== 0 && right[0] !== 1) return fail('Mark the right answer.');
      right = [isT[right[0]] ? 0 : 1];
      texts = ['True', 'False'];
    } else {
      if (texts.length < t.min || texts.length > t.max) {
        return fail(t.min === t.max ? t.label + ' needs exactly ' + t.min + ' options.' : t.label + ' needs ' + t.min + ' to ' + t.max + ' options.');
      }
      for (var i = 0; i < texts.length; i++) if (!texts[i]) return fail('Fill in every option.');
      for (var x = 0; x < texts.length; x++) {
        for (var y = x + 1; y < texts.length; y++) if (same(texts[x], texts[y])) return fail('Two options say the same thing.');
      }
      if (right.length === 0) return fail('Mark the right answer.');
      if (right.length > 1) return fail('Only one answer can be right.');
      if (right[0] < 0 || right[0] >= texts.length) return fail('Mark the right answer.');
    }

    var explanation = clean(raw.explanation, LIMITS.explanation);
    if (opts.strict && explanation.length < LIMITS.explanationMin) return fail('Explain the answer.');
    var q = {
      type: type,
      prompt: prompt,
      options: texts,
      answer: right[0],
      explanation: explanation,
      source: clean(raw.source, LIMITS.source).replace(/^["“”']+|["“”']+$/g, ''),
      topic: clean(raw.topic, LIMITS.topic),
    };
    if (raw.id != null && /^[A-Za-z0-9_-]{4,24}$/.test(String(raw.id))) q.id = String(raw.id);
    return { q: q };
  }

  /** Right or wrong. The server runs this on every real answer; the sample
   *  quiz runs it in the page. */
  function check(q, choice) {
    return Number.isInteger(choice) && choice === q.answer;
  }

  /** Same fact? A question whose options or right answer changed is a new
   *  question - its old history was about something else. */
  function sameFact(a, b) {
    if (!a || !b || a.type !== b.type || a.answer !== b.answer || a.options.length !== b.options.length) return false;
    for (var i = 0; i < a.options.length; i++) if (!same(a.options[i], b.options[i])) return false;
    return true;
  }

  /* ---------------- spaced repetition ---------------- */

  /**
   * The Leitner move for one answer.
   *   right: up a box (a new card that is right jumps to box 2), back in
   *          1 / 2 / 4 / 7 / 14 days.
   *   wrong: back to box 1, back tomorrow. The wrong option is counted, so the
   *          manager can see what people think the answer is.
   * @returns {card, comeback}  comeback: right after the last try was a miss.
   */
  function review(card, right, today, choice) {
    var c = {
      box: 0, due: null, right: 0, wrong: 0, last: null, lastRight: null, picks: {},
    };
    if (card) for (var k in card) if (Object.prototype.hasOwnProperty.call(card, k)) c[k] = card[k];
    var picks = {};
    for (var p in (c.picks || {})) picks[p] = c.picks[p];
    var comeback = Boolean(right && c.lastRight === false);
    if (right) {
      c.box = Math.min(TOP_BOX, Math.max(1, c.box || 0) + 1);
      c.right = (c.right || 0) + 1;
    } else {
      c.box = 1;
      c.wrong = (c.wrong || 0) + 1;
      if (Number.isInteger(choice)) picks[choice] = (picks[choice] || 0) + 1;
    }
    c.picks = picks;
    c.due = addDays(today, INTERVALS[c.box]);
    c.last = today;
    c.lastRight = Boolean(right);
    return { card: c, comeback: comeback };
  }

  /**
   * Today's questions for one person.
   *
   * Due reviews come first, lowest box first (what they know least), then
   * questions they have never seen in deck order, then whatever is due
   * soonest so there are always five when the team has five. When reviews
   * would fill every slot, one is kept for something new - otherwise a busy
   * week of misses would stop anyone ever learning the next deck.
   *
   * @param questions  every published question, in deck order
   * @param cards      {qid: card} for this person
   * @param seed       uid + day: a stable order for today, different per person
   * @returns          question ids
   */
  function pickDaily(questions, cards, today, seed, n) {
    n = n || LIMITS.perDay;
    cards = cards || {};
    var due = [];
    var fresh = [];
    var later = [];
    (questions || []).forEach(function (q, i) {
      var c = cards[q.id];
      if (!c || !c.box) fresh.push({ q: q, i: i });
      else if (!c.due || c.due <= today) due.push({ q: q, c: c, i: i });
      else later.push({ q: q, c: c, i: i });
    });
    var h = function (x) { return hash(seed + '|' + x.q.id); };
    var byDay = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
    due.sort(function (a, b) { return (a.c.box - b.c.box) || byDay(a.c.due || '', b.c.due || '') || (h(a) - h(b)); });
    fresh.sort(function (a, b) { return a.i - b.i; });
    later.sort(function (a, b) { return byDay(a.c.due, b.c.due) || (a.c.box - b.c.box) || (h(a) - h(b)); });

    var takeDue = Math.min(due.length, fresh.length ? n - 1 : n);
    var out = due.slice(0, takeDue);
    out = out.concat(fresh.slice(0, n - out.length));
    if (out.length < n) out = out.concat(due.slice(takeDue, takeDue + n - out.length));
    if (out.length < n) out = out.concat(later.slice(0, n - out.length));
    // Shuffled for the day, so the new one is not always last.
    out.sort(function (a, b) { return h(a) - h(b); });
    return out.map(function (x) { return x.q.id; });
  }

  /* ---------------- streaks, XP, badges ---------------- */

  /** The streak after finishing today's quiz. */
  function nextStreak(streak, lastDoneDay, today) {
    if (lastDoneDay === today) return streak || 1;
    if (lastDoneDay && daysBetween(lastDoneDay, today) === 1) return (streak || 0) + 1;
    return 1;
  }
  /** The streak as it stands today: alive if the last quiz was today or
   *  yesterday (yesterday means "at risk" - do today's to keep it). */
  function streakNow(p, today) {
    if (!p || !p.lastDoneDay) return 0;
    var gap = daysBetween(p.lastDoneDay, today);
    return gap >= 0 && gap <= 1 ? (p.streak || 0) : 0;
  }
  function streakAtRisk(p, today) {
    return Boolean(p && p.lastDoneDay && daysBetween(p.lastDoneDay, today) === 1 && (p.streak || 0) > 0);
  }

  function xpForAnswer(right) { return right ? XP.right : XP.wrong; }
  function xpForFinish(score, total) { return XP.finish + (total > 0 && score === total ? XP.perfect : 0); }

  /** XP earned this week (Monday to today). */
  function weekXp(xpByDay, today) {
    var from = weekStart(today);
    var sum = 0;
    for (var d in (xpByDay || {})) if (d >= from && d <= today) sum += Number(xpByDay[d]) || 0;
    return sum;
  }

  function doneToday(p, today) {
    var t = p && p.today;
    if (!t || t.day !== today || !t.ids || !t.ids.length) return false;
    for (var i = 0; i < t.ids.length; i++) if (!(t.answers && t.answers[t.ids[i]])) return false;
    return true;
  }

  /** Share of the team's questions this person knows (box 3 or better). */
  function mastery(questions, cards) {
    if (!questions || !questions.length) return 0;
    var known = 0;
    cards = cards || {};
    questions.forEach(function (q) { var c = cards[q.id]; if (c && c.box >= KNOWN_BOX) known++; });
    return Math.round(known / questions.length * 100);
  }

  function badgesFor(p, ctx) {
    ctx = ctx || {};
    var out = [];
    p = p || {};
    if ((p.daysDone || 0) >= 1) out.push('first');
    if ((p.perfectDays || 0) >= 1) out.push('perfect');
    if ((p.best || 0) >= 3) out.push('streak3');
    if ((p.best || 0) >= 7) out.push('streak7');
    if ((p.comebacks || 0) >= 1) out.push('comeback');
    if ((p.perfectDays || 0) >= 5) out.push('sharp');
    if ((p.xp || 0) >= 500) out.push('xp500');
    if ((ctx.questions || 0) >= 10 && (ctx.mastery || 0) >= 80) out.push('master');
    return out;
  }

  /* ---------------- the team ---------------- */

  /**
   * The weekly board: name, XP this week, streak. Nothing else about anyone -
   * which questions a person missed is between them and the manager.
   * @param entries [{uid, name, progress}]
   */
  function leaderboard(entries, today) {
    var rows = (entries || []).map(function (e) {
      var p = e.progress || {};
      return { uid: e.uid, name: e.name, weekXp: weekXp(p.xpByDay, today), streak: streakNow(p, today), xp: p.xp || 0 };
    });
    rows.sort(function (a, b) { return (b.weekXp - a.weekXp) || (b.streak - a.streak) || String(a.name).localeCompare(String(b.name)); });
    var rank = 0;
    rows.forEach(function (r, i) {
      if (i === 0 || r.weekXp !== rows[i - 1].weekXp) rank = i + 1;
      r.rank = rank;
    });
    return rows;
  }

  /**
   * Blind spots: the questions the team misses most. Each person's history
   * for a question is one card; a question needs `min` answers across the
   * team before its rate means anything. `commonWrong` is the option people
   * pick instead - usually the most useful line on the page, because it says
   * what the team actually believes.
   * @param cardsList  one {qid: card} map per member
   */
  function blindSpots(questions, cardsList, opts) {
    opts = opts || {};
    var min = opts.min || 3;
    var rows = (questions || []).map(function (q) {
      var attempts = 0, misses = 0, people = 0, stuck = 0, picks = {};
      (cardsList || []).forEach(function (cards) {
        var c = cards && cards[q.id];
        if (!c) return;
        var a = (c.right || 0) + (c.wrong || 0);
        if (!a) return;
        people++;
        attempts += a;
        misses += c.wrong || 0;
        if (c.lastRight === false) stuck++;
        for (var k in (c.picks || {})) picks[k] = (picks[k] || 0) + (Number(c.picks[k]) || 0);
      });
      var top = null;
      for (var j in picks) {
        var idx = Number(j);
        if (idx === q.answer || !q.options[idx]) continue;
        if (top === null || picks[j] > picks[top]) top = j;
      }
      return {
        id: q.id, prompt: q.prompt, type: q.type, topic: q.topic || '', deckId: q.deckId || null, deckTitle: q.deckTitle || '',
        options: q.options, answer: q.answer, explanation: q.explanation || '',
        attempts: attempts, misses: misses, people: people, stuck: stuck,
        missRate: attempts ? Math.round(misses / attempts * 100) : 0,
        commonWrong: top !== null ? q.options[Number(top)] : null,
        commonWrongCount: top !== null ? picks[top] : 0,
      };
    });
    return rows
      .filter(function (r) { return r.attempts >= min && r.misses > 0; })
      .sort(function (a, b) { return (b.missRate - a.missRate) || (b.misses - a.misses) || (b.stuck - a.stuck); })
      .slice(0, opts.top || 6);
  }

  /** The same arithmetic rolled up by topic. */
  function topicSpots(questions, cardsList, opts) {
    opts = opts || {};
    var by = {};
    (questions || []).forEach(function (q) {
      var key = q.topic || q.deckTitle || 'General';
      var t = by[key] || (by[key] = { topic: key, questions: 0, attempts: 0, misses: 0 });
      t.questions++;
      (cardsList || []).forEach(function (cards) {
        var c = cards && cards[q.id];
        if (!c) return;
        t.attempts += (c.right || 0) + (c.wrong || 0);
        t.misses += c.wrong || 0;
      });
    });
    return Object.keys(by).map(function (k) {
      var t = by[k];
      t.missRate = t.attempts ? Math.round(t.misses / t.attempts * 100) : 0;
      return t;
    }).filter(function (t) { return t.attempts >= (opts.min || 3); })
      .sort(function (a, b) { return (b.missRate - a.missRate) || (b.misses - a.misses); })
      .slice(0, opts.top || 8);
  }

  /* ---------------- join codes ---------------- */

  function normalizeCode(v) {
    return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  }
  function isCode(v) { return CODE_RE.test(String(v || '')); }
  function formatCode(v) { var s = normalizeCode(v); return s.length === CODE_LEN ? s.slice(0, 4) + '-' + s.slice(4) : s; }

  return {
    QTYPES: QTYPES, QTYPE_KEYS: QTYPE_KEYS, LIMITS: LIMITS, INTERVALS: INTERVALS, TOP_BOX: TOP_BOX, KNOWN_BOX: KNOWN_BOX,
    XP: XP, BADGES: BADGES, CODE_ALPHABET: CODE_ALPHABET, CODE_LEN: CODE_LEN,
    clean: clean, typeInfo: typeInfo, badgeInfo: badgeInfo,
    isoDay: isoDay, addDays: addDays, daysBetween: daysBetween, weekStart: weekStart, hash: hash,
    validateQuestion: validateQuestion, check: check, sameFact: sameFact,
    review: review, pickDaily: pickDaily,
    nextStreak: nextStreak, streakNow: streakNow, streakAtRisk: streakAtRisk,
    xpForAnswer: xpForAnswer, xpForFinish: xpForFinish, weekXp: weekXp, doneToday: doneToday,
    mastery: mastery, badgesFor: badgesFor,
    leaderboard: leaderboard, blindSpots: blindSpots, topicSpots: topicSpots,
    normalizeCode: normalizeCode, isCode: isCode, formatCode: formatCode,
  };
});
