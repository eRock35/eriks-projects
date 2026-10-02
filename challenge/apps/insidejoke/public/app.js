/* Inside Joke - the page.
 *
 * One page, three places: the home screen (your groups, or the example
 * family the first time), a group at g/<id> (Today, Live, Board, Questions,
 * Group), and a join link at j/<code>. The example runs entirely here with
 * no account and no model call; a real group talks to the API through the
 * same "source" interface, so both draw with the same code.
 *
 * No inline script and no on*= attributes anywhere (the lab's CSP): every
 * handler is attached here. Every name, question and caption is escaped
 * before it is drawn. Chats are read here and never uploaded; photos are
 * redrawn here (which strips their EXIF) before anything is sent.
 */
(function () {
  'use strict';

  var C = window.InsideJokeCore;
  var S = window.InsideJokeSample;
  var QR = window.InsideJokeQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_GROUPS = 'ij-groups-v1';
  var K_TAB = 'ij-tab-v1';
  var K_FROM = 'ij-from-v1';
  var LIVE_POLL_MS = 1500;
  var GROUP_POLL_MS = 15000;
  var TODAY_POLL_MS = 20000;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }());
  var ROUTE = (function () {
    var g = /\/g\/([a-z0-9]{16})\/?$/.exec(location.pathname);
    if (g) return { kind: 'group', gid: g[1] };
    var j = /\/j\/([A-Za-z0-9-]{4,16})\/?$/.exec(location.pathname);
    if (j) return { kind: 'join', code: j[1].toUpperCase().replace(/[^A-Z0-9]/g, '') };
    return { kind: 'home' };
  }());

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var state = {
    me: null,            // the account, if any
    mode: null,          // 'sample' | 'group' | 'home' | 'join'
    src: null,           // where a group's data comes from
    group: null,
    tab: 'today',
    today: null, board: null, live: null, questions: null,
    started: false,      // today's intro passed
    verdict: null,       // the question whose verdict is showing
    boardSpan: 'week',
    timers: {},
    liveBusy: false, clockSkew: 0,
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // The two AI routes stream whitespace and so answer 200 even on
        // failure; an {error} body is a failure however it arrived.
        if (!res.ok || data.error) {
          var e = new Error(data.error || 'Something went wrong.');
          e.status = res.status; e.data = data;
          throw e;
        }
        return data;
      });
    });
  }
  function toast(msg, ms) {
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function isSample() { return state.mode === 'sample'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function names(list) {
    var n = list.map(function (x) { return x.name; });
    if (n.length <= 1) return n.join('');
    return n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
  }
  function dur(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    var h = Math.floor(m / 60);
    return h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
  }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going. It’s free, and your group never needs to.');
    if (err && err.status === 403 && err.data && err.data.code === 'verify-email' && where) return verifyNote(where, err);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Writing your own questions and the chat stats are free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).onclick = function () {
      var b = this; b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    };
  }

  /* ---------------- people ---------------- */

  function hex(m) { return C.colorHex(m && m.color); }
  function avatar(m, size) { return '<span class="av' + (size ? ' ' + size : '') + '" style="--c:' + esc(hex(m)) + '" aria-hidden="true">' + esc((m && m.emoji) || '🙂') + '</span>'; }
  function who(m, size) { return '<span class="who">' + avatar(m, size) + '<b>' + esc(m.name) + '</b></span>'; }
  function memberById(id) { var ms = (state.group && state.group.members) || []; for (var i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i]; return null; }
  function rememberGroup(g) {
    var list = (recall(K_GROUPS) || []).filter(function (x) { return x && x.id !== g.id; });
    list.unshift({ id: g.id, name: g.name });
    keep(K_GROUPS, list.slice(0, 20));
  }
  function forgetGroup(id) { keep(K_GROUPS, (recall(K_GROUPS) || []).filter(function (x) { return x && x.id !== id; })); }

  /* ---------------- sources: the API, or the example ---------------- */

  function apiSource(gid) {
    var p = 'api/groups/' + gid;
    return {
      sample: false,
      group: function (since) { return api('GET', p + (since !== undefined ? '?since=' + since : '')); },
      today: function () { return api('GET', p + '/today'); },
      answer: function (date, qid, a, from) { return api('POST', p + '/today', { date: date, qid: qid, a: a, from: from }); },
      board: function () { return api('GET', p + '/board'); },
      questions: function () { return api('GET', p + '/questions'); },
      live: function (since) { return api('GET', p + '/live' + (since !== undefined ? '?since=' + since : '')); },
      liveStart: function (o) { return api('POST', p + '/live', o); },
      liveJoin: function () { return api('POST', p + '/live/join', {}); },
      liveNext: function (idx) { return api('POST', p + '/live/next', { idx: idx }); },
      liveAnswer: function (idx, a) { return api('POST', p + '/live/answer', { idx: idx, a: a }); },
      liveEnd: function () { return api('DELETE', p + '/live'); },
      photoUrl: function (pid) { return BASE + p + '/photos/' + encodeURIComponent(pid); },
      path: p,
    };
  }

  /** The Riveras: a whole group in the browser. Today's five can be played
   *  (and are graded by the same core as a real group); nothing is saved. */
  function sampleSource() {
    var today = C.dayIn(TZ, Date.now());
    var st = S.state(today);
    var members = st.members.map(function (m) { return Object.assign({}, m, { you: m.id === st.me, linked: false }); });
    var qs = st.today.map(function (k) { return st.qs[k]; });
    function round() {
      var mine = qs.map(function (q, i) {
        var out = Object.assign(C.publicQuestion(q), { n: i + 1 });
        var p = st.picks[q.id];
        if (p) { out.picked = p.a; out.ok = p.ok; out.answer = q.answer; out.tolerance = q.tolerance; }
        return out;
      });
      var done = qs.every(function (q) { return st.picks[q.id]; });
      var score = qs.filter(function (q) { return st.picks[q.id] && st.picks[q.id].ok; }).length;
      var byId = {};
      members.forEach(function (m) { byId[m.id] = m; });
      var results = st.results.map(function (r) { var m = byId[r.id]; return { id: r.id, name: m.name, emoji: m.emoji, color: m.color, score: r.score, of: r.of, from: r.from, marks: r.marks }; });
      if (done) results.push({ id: st.me, name: byId[st.me].name, emoji: byId[st.me].emoji, color: byId[st.me].color, score: score, of: 5, from: st.from, marks: qs.map(function (q) { return st.picks[q.id].ok; }), you: true });
      results.sort(function (a, b) { return b.score - a.score || (a.you ? -1 : b.you ? 1 : 0); });
      var played = {};
      st.results.forEach(function (r) { played[r.id] = true; });
      if (done) played[st.me] = true;
      return {
        date: today, label: C.dateLabel(today), v: 1, questions: mine, done: done, score: score, of: 5, from: st.from,
        results: done ? results : null, captions: {},
        waiting: members.filter(function (m) { return !played[m.id]; }).map(function (m) { return { id: m.id, name: m.name, emoji: m.emoji, you: m.id === st.me }; }),
        closesInMs: C.msToMidnight(TZ, Date.now()), tz: TZ, sample: true,
      };
    }
    function board() {
      var lb = C.leaderboard(st.board, members, today);
      return { today: today, week: lb.week, month: lb.month, all: lb.all, me: lb.rows.filter(function (r) { return r.id === st.me; })[0], waiting: lb.rows.filter(function (r) { return !r.playedToday; }) };
    }
    function resolve(v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 120); }); }
    return {
      sample: true,
      group: function () {
        return resolve({ group: { id: 'sample', name: S.NAME, code: 'RIVERA', display: 'RIV-ERA', tz: TZ, members: members, me: st.me, host: false, today: today, counts: { questions: Object.keys(st.qs).length + 32, photos: 14 }, live: null, sample: true } });
      },
      today: function () { return resolve(round()); },
      answer: function (date, qid, a, from) {
        var q = qs.filter(function (x) { return x.id === qid; })[0];
        if (!q || st.picks[qid] || !C.validAnswer(q, a)) return Promise.reject(Object.assign(new Error('Pick one of the answers.'), { status: 400 }));
        st.picks[qid] = { a: a, ok: C.grade(q, a) };
        if (from) st.from = C.clean(from, C.LIMITS.city);
        if (qs.every(function (x) { return st.picks[x.id]; })) {
          var sc = qs.filter(function (x) { return st.picks[x.id].ok; }).length;
          (st.board.days[today] = st.board.days[today] || {})[st.me] = [sc, 5];
        }
        return resolve(round());
      },
      board: function () { return resolve(board()); },
      questions: function () {
        var list = Object.keys(st.qs).map(function (k) { var q = st.qs[k]; var m = members.filter(function (x) { return x.id === q.createdBy; })[0]; return Object.assign({}, q, { label: C.STYLE_LABEL[q.style], by: m ? m.name : '' }); });
        return resolve({ counts: { photo: 18, chat: 14, own: 10, live: 42 }, mine: [], others: null, example: list });
      },
      live: function () {
        var byId = {};
        members.forEach(function (m) { byId[m.id] = m; });
        return resolve({ state: 'podium', sample: true, when: st.podium.when, count: 10, players: st.podium.players.map(function (p) { var m = byId[p.id]; return { id: p.id, name: m.name, emoji: m.emoji, color: m.color, score: p.score, you: p.id === st.me }; }), podium: null, serverNow: Date.now() });
      },
      photoUrl: function (pid) { return S.PHOTOS[pid] || ''; },
      chat: st.chat,
    };
  }

  /* ---------------- the frame ---------------- */

  function setTabsVisible(on) {
    $('#tabs').hidden = !on;
    document.body.classList.toggle('has-tabs', on);
  }
  function stopTimers() { Object.keys(state.timers).forEach(function (k) { clearInterval(state.timers[k]); clearTimeout(state.timers[k]); }); state.timers = {}; }

  function drawStrip() {
    var el = $('#strip');
    var g = state.group;
    if (!g) { el.innerHTML = ''; return; }
    var faces = '<span class="faces" aria-hidden="true">' + g.members.slice(0, 6).map(function (m) { return avatar(m, 'sm'); }).join('') + '</span>';
    if (isSample()) {
      el.innerHTML = '<div class="strip"><p class="small" style="margin:0 0 4px;opacity:.9">This is an example family - play today’s 5, then start your own.</p>' +
        '<div class="ghead"><h1>' + esc(g.name) + '</h1>' + faces + '</div>' +
        '<p>Trivia made from <b>your own</b> photos and group chat. Everyone plays five a day on their own time - from anywhere - or all together on a video call.</p>' +
        '<div class="row"><button class="btn big light" type="button" id="playBtn">' + (state.today && state.today.done ? 'See today’s results' : 'Play today’s round') + '</button><button class="btn big ghost-light" type="button" id="startBtn">Start a group</button></div></div>';
      $('#playBtn').onclick = function () { setTab('today'); state.started = true; drawToday(); var v = $('#view'); if (v.scrollIntoView) v.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); };
      $('#startBtn').onclick = startGroup;
      return;
    }
    el.innerHTML = '<div class="ghead"><h1>' + esc(g.name) + '</h1>' + faces + '</div>';
  }

  function setTab(tab) {
    state.tab = tab;
    if (!isSample()) keep(K_TAB, tab);
    $$('#tabs [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    stopTimers();
    if (!isSample()) state.timers.group = setInterval(pollGroup, GROUP_POLL_MS);
    var v = $('#view');
    v.innerHTML = '<p class="busy" role="status">Loading…</p>';
    ({ today: loadToday, live: loadLive, board: loadBoard, questions: loadQuestions, group: drawGroupTab })[tab]();
  }
  $$('#tabs [data-tab]').forEach(function (b) { b.onclick = function () { setTab(b.getAttribute('data-tab')); window.scrollTo(0, 0); }; });

  function pollGroup() {
    if (document.hidden || !state.group || isSample()) return;
    state.src.group(state.group.v).then(function (r) {
      if (r.same) return;
      state.group = r.group;
      drawStrip(); drawBadges();
    }).catch(function () { /* a blip; the next poll tries again */ });
  }
  function drawBadges() {
    var b = $('#tabs [data-tab="live"]');
    var old = $('.tab-badge', b);
    if (old) old.remove();
    var l = state.group && state.group.live;
    if (l && l.state !== 'podium') b.insertAdjacentHTML('beforeend', '<span class="tab-badge live" aria-label="A game is on">' + (l.state === 'lobby' ? 'NEW' : 'ON') + '</span>');
  }

  function openGroup(src, tab) {
    state.src = src;
    return src.group().then(function (r) {
      state.group = r.group;
      state.mode = src.sample ? 'sample' : 'group';
      if (!src.sample) rememberGroup(r.group);
      $('#home').hidden = true;
      setTabsVisible(true);
      drawStrip(); drawBadges();
      setTab(tab || 'today');
    });
  }

  /* ---------------- today ---------------- */

  function loadToday() {
    Promise.all([state.src.today(), state.src.board().catch(function () { return null; })]).then(function (r) {
      state.today = r[0]; state.board = r[1];
      if (state.today.questions && state.today.questions.some(function (q) { return q.picked !== undefined; })) state.started = true;
      drawToday();
      if (!isSample()) state.timers.today = setInterval(function () {
        if (document.hidden || state.tab !== 'today' || !state.today || !state.today.done) return;
        state.src.today().then(function (t) { if (state.tab === 'today' && !state.verdict) { state.today = t; drawToday(); } }).catch(function () {});
      }, TODAY_POLL_MS);
    }).catch(function (e) { showError(e, $('#view')); });
  }

  function photoImg(q, cls) {
    if (!q.photoId) return '';
    var url = state.src.photoUrl(q.photoId);
    return url ? '<img class="' + (cls || 'photo') + '" src="' + esc(url) + '" alt="A photo from the group">' : '';
  }
  function optionText(q, i) { return q.options ? q.options[i] : ''; }
  function answerText(q, a) {
    if (q.kind === 'number') return String(a) + (q.unit ? ' ' + q.unit : '');
    return optionText(q, a);
  }
  function myStreak() { var me = state.board && state.board.me; return me ? me : null; }

  function drawToday() {
    var v = $('#view');
    var t = state.today;
    if (!t) return;
    if (t.empty) {
      v.innerHTML = '<div class="card"><h2>No round yet today</h2><p class="muted">The daily round draws five questions from the group’s bank. It’s empty so far - add a few from your photos, your group chat, or write your own.</p><button class="btn big block" type="button" id="toQs">Add questions</button></div>';
      $('#toQs').onclick = function () { setTab('questions'); };
      return;
    }
    var qs = t.questions;
    var next = qs.filter(function (q) { return q.picked === undefined; })[0];
    var st = myStreak();
    var head = '<div class="sec-head"><h2>Today’s round · ' + esc(t.label) + '</h2>' + (st && st.streak ? '<span class="chip fire">🔥 ' + esc(st.streak) + '</span>' : '') + '</div>';
    var dots = '<div class="dots" aria-hidden="true">' + qs.map(function (q) {
      var c = q.picked === undefined ? (next && q.id === next.id ? 'on' : '') : q.ok === true ? 'ok' : q.ok === false ? 'no' : 'vote';
      return '<span class="' + c + '"></span>';
    }).join('') + '</div>';

    if (state.verdict) {
      var vq = qs.filter(function (q) { return q.id === state.verdict; })[0];
      if (vq) return drawQuestion(v, t, vq, head, dots, true);
      state.verdict = null;
    }
    if (!t.done && !state.started) return drawIntro(v, t, head);
    if (!t.done && next) return drawQuestion(v, t, next, head, dots, false);
    drawResults(v, t, head);
  }

  function drawIntro(v, t, head) {
    var st = myStreak();
    var playedN = (t.results || []).length;
    var others = state.group.members.length - 1 - t.waiting.filter(function (w) { return !w.you; }).length;
    v.innerHTML = '<div class="split"><div class="card">' + head +
      '<p class="prompt" style="margin-top:2px">' + esc(t.questions.length) + ' questions about your people.</p>' +
      '<ul class="intro-list muted"><li>Play whenever suits you - the round locks at midnight' + (isSample() ? '' : ' (group time)') + ', ' + esc(dur(t.closesInMs)) + ' from now.</li><li>See how everyone did once you’re done.</li>' +
      (st && st.streak ? '<li>Your streak: 🔥 ' + esc(st.streak) + (st.atRisk ? ' - play today to keep it' : '') + '.</li>' : '<li>Play every day to build a streak.</li>') + '</ul>' +
      '<label class="field"><span>Playing from <span class="muted">(optional)</span></span><input class="input" id="fromIn" maxlength="30" placeholder="e.g. Denver" autocomplete="off"></label>' +
      '<button class="btn big block" type="button" id="goBtn">Start</button></div>' +
      '<div class="side card flat"><h3>Who’s played</h3>' + (others > 0 || playedN ? '<p class="muted small">' + esc(plural(Math.max(others, 0), 'person has', 'people have')) + ' played today. Finish yours to see their scores.</p>' : '<p class="muted small">Nobody yet - you could be first.</p>') + waitingLine(t) + '</div></div>';
    var f = $('#fromIn');
    f.value = recall(K_FROM) || '';
    $('#goBtn').onclick = function () { keep(K_FROM, C.clean(f.value, C.LIMITS.city) || null); state.started = true; drawToday(); };
  }

  function waitingLine(t) {
    var w = t.waiting.filter(function (x) { return !x.you; });
    if (!w.length) return '<p class="small" style="margin:8px 0 0">Everyone else has played 🎉</p>';
    return '<div class="waiting" style="margin-top:8px"><span class="faces" aria-hidden="true">' + w.slice(0, 6).map(function (m) { return avatar(memberById(m.id) || m, 'sm'); }).join('') + '</span><span class="small">' + esc(w.length > 3 ? plural(w.length, 'person hasn’t', 'people haven’t') + ' played yet' : names(w) + (w.length === 1 ? ' hasn’t' : ' haven’t') + ' played yet') + '</span></div>';
  }

  var SHAPES = ['▲', '◆', '●', '■'];

  function drawQuestion(v, t, q, head, dots, showVerdict) {
    var answered = q.picked !== undefined;
    var body = '<div class="card qcard">' + head + dots +
      '<div class="label"><span class="chip accent">' + esc(q.label || '') + '</span> <span class="small muted">Question ' + esc(q.n) + ' of ' + esc(t.questions.length) + '</span></div>' +
      photoImg(q) + '<p class="prompt">' + esc(q.prompt) + '</p>' + (q.quote ? '<blockquote class="quote">' + esc(q.quote) + '</blockquote>' : '');
    if (q.kind === 'number') {
      body += answered
        ? '<div class="answer ' + (q.ok ? 'right' : 'wrong') + '" role="status"><span class="k">#</span>You said ' + esc(answerText(q, q.picked)) + '</div>'
        : '<form class="numrow" id="numForm"><label class="vh" for="numIn">Your guess</label><input class="input" id="numIn" type="number" inputmode="decimal" step="any" required placeholder="Your guess"><button class="btn" type="submit">Lock it in</button></form>' +
          (q.style === 'when' ? '<p class="small muted" style="margin-top:8px">Within a year counts.</p>' : '<p class="small muted" style="margin-top:8px">Close counts - the nearer the better.</p>');
    } else {
      body += '<div class="answers" role="group" aria-label="Answers">' + q.options.map(function (o, i) {
        var cls = '';
        var tail = '';
        if (answered) {
          if (q.kind === 'caption') { if (i === q.picked) { cls = 'picked'; tail = 'Your vote'; } }
          else if (i === q.answer) { cls = 'right'; tail = '✓'; }
          else if (i === q.picked) { cls = 'wrong'; tail = '✗'; }
        }
        return '<button type="button" class="answer ' + cls + '" data-a="' + i + '"' + (answered ? ' disabled' : '') + '><span class="k" aria-hidden="true">' + 'ABCD'[i] + '</span><span>' + esc(o) + '</span>' + (tail ? '<span class="tail">' + esc(tail) + '</span>' : '') + '</button>';
      }).join('') + '</div>';
    }
    if (answered && showVerdict) {
      var last = t.questions.every(function (x) { return x.picked !== undefined; });
      var line = q.kind === 'caption' ? '<span class="em">🗳️</span><span>Vote counted. Captions have no right answer - see the group’s favourite at the end.</span>'
        : q.ok ? '<span class="em">🎉</span><span>' + esc(pickLine(q, true)) + '</span>'
          : '<span class="em">🙈</span><span>' + esc(pickLine(q, false)) + '</span>';
      body += '<div class="verdict ' + (q.kind === 'caption' ? 'vote' : q.ok ? 'ok' : 'no') + ' pop" role="status">' + line + '</div>' +
        '<button class="btn big block" type="button" id="nextQ">' + (last ? 'See how everyone did' : 'Next question') + '</button>';
    }
    body += '<div id="qErr"></div></div>';
    v.innerHTML = '<div class="split">' + body + '<div class="side card flat"><h3>Who’s played</h3>' + waitingLine(t) + '<p class="small muted" style="margin-top:10px">The round locks at midnight' + (isSample() ? '' : ' (group time)') + ' - ' + esc(dur(t.closesInMs)) + ' left.</p></div></div>';
    $$('[data-a]', v).forEach(function (b) { b.onclick = function () { submit(q, Number(b.getAttribute('data-a'))); }; });
    var nf = $('#numForm');
    if (nf) nf.onsubmit = function (e) { e.preventDefault(); var n = Number($('#numIn').value); if ($('#numIn').value === '' || !isFinite(n)) return; submit(q, n); };
    var nx = $('#nextQ');
    if (nx) { nx.onclick = function () { state.verdict = null; drawToday(); window.scrollTo(0, 0); }; setTimeout(function () { try { nx.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 30); }
  }
  function pickLine(q, ok) {
    if (q.kind === 'number') {
      var off = Math.abs(q.picked - q.answer);
      return ok ? (off ? 'Close enough! It was ' + answerText(q, q.answer) + '.' : 'Spot on: ' + answerText(q, q.answer) + '.') : 'It was ' + answerText(q, q.answer) + ' - you were ' + off + ' off.';
    }
    return ok ? 'Yes! ' + answerText(q, q.answer) + '.' : 'It was ' + answerText(q, q.answer) + '.';
  }

  function submit(q, a) {
    $$('[data-a], #numForm button', $('#view')).forEach(function (b) { b.disabled = true; });
    var from = recall(K_FROM);
    state.src.answer(state.today.date, q.id, a, from || undefined).then(function (t) {
      state.today = t;
      state.verdict = q.id;
      drawToday();
      if (t.done) { if (isSample()) drawStrip(); state.src.board().then(function (b) { state.board = b; }).catch(function () {}); }
    }).catch(function (e) {
      if (e.data && e.data.code === 'closed') { toast(e.message, 4000); state.started = false; return loadToday(); }
      $$('[data-a], #numForm button', $('#view')).forEach(function (b) { b.disabled = false; });
      showError(e, $('#qErr'));
    });
  }

  function marksText(marks) { return (marks || []).map(function (m) { return m === true ? '🟩' : m === false ? '🟥' : '🗳️'; }).join(''); }

  function drawResults(v, t, head) {
    var st = myStreak();
    var marks = t.questions.map(function (q) { return q.ok === undefined ? null : q.ok; });
    var streak = st ? st.streak : 0;
    var card = C.resultCard({ group: state.group.name, date: t.date, score: t.score, of: t.of, marks: marks, streak: streak });
    var others = (t.results || []).filter(function (r) { return !r.you; });
    var me = '<div class="card">' + head +
      '<div class="row spread" style="align-items:flex-end"><div><div class="score-big">' + esc(t.score) + '<span class="muted" style="font-size:1.4rem">/' + esc(t.of) + '</span></div><div class="marks" aria-label="' + esc(t.score + ' right out of ' + t.of) + '">' + marksText(marks) + '</div></div>' +
      (streak > 1 ? '<div class="center"><div style="font-size:2rem">🔥</div><b>' + esc(plural(streak, 'day')) + '</b><div class="small muted">streak</div></div>' : '') + '</div>' +
      '<p class="muted" style="margin-top:10px">' + esc(verdictLine(t, others)) + '</p>' +
      '<div class="copybox" id="cardText">' + esc(card) + '</div>' +
      '<div class="row"><button class="btn" type="button" id="copyCard">Copy for the family chat</button>' + (navigator.share ? '<button class="btn ghost" type="button" id="shareCard">Share…</button>' : '') + '</div>' +
      '<p class="small muted" style="margin-top:8px">No link in it - nothing that opens your group.</p></div>';
    var list = '<div class="card"><h2>How everyone did</h2>' + (t.results && t.results.length ? '<ul class="results">' + t.results.map(function (r) {
      return '<li class="' + (r.you ? 'you' : '') + '">' + avatar(r) + '<span class="sub"><b>' + esc(r.name) + (r.you ? ' (you)' : '') + '</b>' + (r.from ? '<span class="from">from ' + esc(r.from) + '</span>' : '') + '</span><span class="pts">' + esc(r.score + '/' + r.of) + ' <span aria-hidden="true">' + marksText(r.marks) + '</span></span></li>';
    }).join('') + '</ul>' : '') + nudge(t) + '</div>';
    var caps = Object.keys(t.captions || {}).map(function (id) { var c = t.captions[id]; return '<p class="small">🏅 Favourite caption so far: <b>“' + esc(c.text) + '”</b> (' + esc(plural(c.votes, 'vote')) + ')</p>'; }).join('');
    var review = '<div class="card"><h2>Your answers</h2><ol class="qlist" style="list-style:none">' + t.questions.map(function (q) {
      var mark = q.kind === 'caption' ? '🗳️' : q.ok ? '✅' : '❌';
      return '<li>' + (q.photoId ? photoImg(q, 'thumb') : '<span class="thumb" style="display:grid;place-items:center;font-size:1.4rem" aria-hidden="true">' + ({ chat: '💬', own: '✍️', photo: '📸' }[C.family(q.style)]) + '</span>') +
        '<div class="body"><b>' + esc(q.prompt) + '</b>' + (q.quote ? '<div class="small">“' + esc(q.quote) + '”</div>' : '') +
        '<div class="small">You: ' + esc(answerText(q, q.picked)) + (q.kind !== 'caption' && !q.ok ? ' · <span class="ans">Answer: ' + esc(answerText(q, q.answer)) + '</span>' : '') + '</div></div><span aria-label="' + (q.ok ? 'right' : 'wrong') + '">' + mark + '</span></li>';
    }).join('') + '</ol>' + caps + '<p class="small muted">Tomorrow’s round opens at midnight' + (isSample() ? '' : ' (group time)') + ' - ' + esc(dur(t.closesInMs)) + ' from now.</p></div>';
    v.innerHTML = '<div class="split"><div>' + me + review + '</div><div class="side">' + list + (isSample() ? sampleNext() : '') + '</div></div>';
    $('#copyCard').onclick = function () { copy(card, 'Copied - paste it in the family chat'); };
    var sh = $('#shareCard');
    if (sh) sh.onclick = function () { navigator.share({ text: card }).catch(function () {}); };
    var nb = $('#nudgeBtn');
    if (nb) nb.onclick = function () { copy('Today’s Inside Joke round is waiting - 5 questions, about two minutes. ' + (t.results && t.results.length > 1 ? 'Can you beat ' + t.results[0].score + '/' + t.results[0].of + '? ' : '') + '🔥', 'Copied - paste it in the family chat'); };
    var sn = $('#sampleStart');
    if (sn) sn.onclick = startGroup;
  }
  function verdictLine(t, others) {
    if (!others.length) return 'You’re the first to finish today. Everyone else sees your score when they’re done.';
    var best = others.reduce(function (m, r) { return Math.max(m, r.score); }, 0);
    if (t.score > best) return 'Top of the family today - so far.';
    if (t.score === best) return 'Tied for the top spot today.';
    var lead = others.filter(function (r) { return r.score > t.score; })[0].name + ' leads with ' + best + '/' + t.of + '.';
    return t.score >= t.of - 1 ? 'Not bad! ' + lead : lead + ' Tomorrow’s another round.';
  }
  function nudge(t) {
    var w = t.waiting.filter(function (x) { return !x.you; });
    if (!w.length) return '<p class="small" style="margin-top:10px">Everyone’s played today 🎉</p>';
    return '<div class="note" style="margin-top:12px"><p class="small" style="margin:0 0 6px"><b>' + esc(w.length === 1 ? w[0].name + ' hasn’t' : plural(w.length, 'person hasn’t', 'people haven’t')) + ' played today</b>' + (w.length > 1 ? ': ' + esc(names(w)) : '') + '.</p>' +
      '<button class="btn small ghost" type="button" id="nudgeBtn">Copy a nudge for the chat</button></div>';
  }
  function sampleNext() {
    return '<div class="card"><h2>Now make one for your people</h2><p class="muted">Start a group, invite them with a link or a code, and add questions from your own photos and group chat. They don’t need an account.</p><button class="btn big block" type="button" id="sampleStart">Start a group</button></div>';
  }

  /* ---------------- live ---------------- */

  function loadLive() {
    state.live = null;
    state.src.live().then(function (l) {
      takeLive(l);
      if (!isSample()) {
        state.timers.live = setInterval(pollLive, LIVE_POLL_MS);
        state.timers.tick = setInterval(tick, 200);
        if (l.state === 'lobby' && !l.joined) state.src.liveJoin().then(takeLive).catch(function () {});
      }
    }).catch(function (e) { showError(e, $('#view')); });
  }
  function takeLive(l) {
    if (l.serverNow) state.clockSkew = l.serverNow - Date.now();
    if (l.same) return;
    var prev = state.live;
    state.live = l;
    if (l.players && l.players.some(function (p) { return !memberById(p.id); })) pollGroup();
    if (state.group && state.group.live !== undefined) state.group.live = l.none ? null : { state: l.state };
    drawBadges();
    // Keep a typed guess: redraw a question only when it is a new one.
    if (prev && l.state === 'question' && prev.state === 'question' && prev.idx === l.idx && prev.mine && l.mine) { updatePlayers(l); return; }
    if (prev && l.state === 'question' && prev.state === 'question' && prev.idx === l.idx && !l.mine) { updatePlayers(l); return; }
    drawLive();
  }
  function pollLive() {
    if (document.hidden || state.tab !== 'live' || state.liveBusy) return;
    state.liveBusy = true;
    state.src.live(state.live && !state.live.none ? state.live.v : undefined).then(takeLive).catch(function () {}).then(function () { state.liveBusy = false; });
  }
  function now() { return Date.now() + state.clockSkew; }
  function tick() {
    var l = state.live;
    if (!l || state.tab !== 'live') return;
    var el = $('#secs');
    var bar = $('#tbar');
    if (l.state === 'question' && l.seconds && el) {
      var left = Math.max(0, l.closesAt - now());
      el.textContent = Math.ceil(left / 1000) + 's';
      if (bar) bar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, left / (l.seconds * 1000))) + ')';
      if (left <= 0) $$('.lopt:not(:disabled), #lnum button', $('#view')).forEach(function (b) { b.disabled = true; });
    }
    if (l.state === 'reveal' && l.seconds && el) {
      el.textContent = Math.max(0, Math.ceil((l.revealAt + l.revealMs - now()) / 1000)) + 's';
    }
  }
  function updatePlayers(l) {
    var el = $('#answeredLine');
    if (el) el.textContent = answeredLine(l);
    var pl = $('#playersList');
    if (pl) pl.innerHTML = playersHtml(l);
  }
  function answeredLine(l) { var n = l.players.filter(function (p) { return p.answered; }).length; return n + ' of ' + l.players.length + ' answered'; }
  function playersHtml(l) { return l.players.map(function (p) { return '<li class="' + (l.state === 'question' && p.answered ? 'done' : '') + '">' + avatar(p, 'sm') + esc(p.name) + '</li>'; }).join(''); }

  function liveSetup(v) {
    var opts = { count: 10, seconds: 20, families: ['photo', 'chat', 'own'] };
    function draw() {
      v.innerHTML = '<div class="split"><div class="card"><h2>Game night 🎉</h2><p class="muted">Everyone plays on their own phone, wherever they are - it works great beside a video call. Faster right answers score more.</p>' +
        '<div class="field"><span>Questions</span><div class="optgrid">' + [5, 10, 15, 20].map(function (n) { return '<button type="button" class="pill" data-count="' + n + '" aria-pressed="' + (opts.count === n) + '">' + n + '</button>'; }).join('') + '</div></div>' +
        '<div class="field"><span>From</span><div class="optgrid">' + [['photo', '📸 Photos'], ['chat', '💬 Chat'], ['own', '✍️ Written']].map(function (f) { return '<button type="button" class="pill" data-fam="' + f[0] + '" aria-pressed="' + (opts.families.indexOf(f[0]) >= 0) + '">' + f[1] + '</button>'; }).join('') + '</div></div>' +
        '<div class="field"><span>Each question</span><div class="optgrid">' + [[15, '15 s'], [20, '20 s'], [30, '30 s'], [0, 'I’ll move it on']].map(function (s) { return '<button type="button" class="pill" data-sec="' + s[0] + '" aria-pressed="' + (opts.seconds === s[0]) + '">' + s[1] + '</button>'; }).join('') + '</div></div>' +
        '<div id="liveErr"></div><button class="btn big block" type="button" id="liveGo">Open the room</button></div>' +
        '<div class="side card flat"><h3>How it works</h3><ol class="steps"><li>Open the room - everyone in the group sees it on the Live tab.</li><li>New people join with the room code ' + esc(state.group.display) + '.</li><li>You start it; questions move on by the timer or by you.</li><li>Scoreboard after each one, podium at the end.</li></ol></div></div>';
      $$('[data-count]', v).forEach(function (b) { b.onclick = function () { opts.count = Number(b.getAttribute('data-count')); draw(); }; });
      $$('[data-sec]', v).forEach(function (b) { b.onclick = function () { opts.seconds = Number(b.getAttribute('data-sec')); draw(); }; });
      $$('[data-fam]', v).forEach(function (b) {
        b.onclick = function () {
          var f = b.getAttribute('data-fam');
          var i = opts.families.indexOf(f);
          if (i >= 0 && opts.families.length > 1) opts.families.splice(i, 1); else if (i < 0) opts.families.push(f);
          draw();
        };
      });
      $('#liveGo').onclick = function () {
        this.disabled = true;
        state.src.liveStart(opts).then(function (l) { state.live = null; takeLive(l); }).catch(function (e) { $('#liveGo').disabled = false; showError(e, $('#liveErr')); });
      };
    }
    draw();
  }

  function drawLive() {
    var v = $('#view');
    var l = state.live;
    if (!l) return;
    var g = state.group;
    if (l.sample) return drawPodium(v, l);
    if (l.none) {
      if (g.host) return liveSetup(v);
      v.innerHTML = '<div class="card"><h2>Game night 🎉</h2><p class="muted">No game on right now. When ' + esc(hostName()) + ' opens the room, it appears here - keep this tab open on your phone, beside the video call.</p><p class="small muted">Room code: <b>' + esc(g.display) + '</b></p></div>';
      return;
    }
    if (l.state === 'lobby') return drawLobby(v, l);
    if (l.state === 'question') return drawLiveQuestion(v, l);
    if (l.state === 'reveal') return drawReveal(v, l);
    return drawPodium(v, l);
  }
  function hostName() { var h = state.group.members.filter(function (m) { return m.host; })[0]; return h ? h.name : 'the host'; }

  function drawLobby(v, l) {
    var g = state.group;
    var link = location.origin + BASE + 'j/' + g.code;
    v.innerHTML = '<div class="split"><div class="card"><div class="sec-head"><h2>The room is open</h2><span class="chip teal">' + esc(l.count) + ' questions · ' + (l.seconds ? esc(l.seconds) + ' s each' : 'host moves on') + '</span></div>' +
      '<div class="room">' + (g.host ? '<button type="button" class="qr" id="qrSmall" aria-label="Show the QR code full screen">' + QR.svg(link, 'QR code to join ' + g.name) + '</button>' : '') +
      '<div><p class="small muted" style="margin:0">Room code</p><p class="code" style="margin:0">' + esc(g.display) + '</p><p class="small muted">Group members: just open the Live tab. New people: scan, or type the code on the home page.</p></div></div>' +
      '<h3 style="margin-top:12px">In the room (' + esc(l.players.length) + ')</h3><ul class="players" id="playersList">' + playersHtml(l) + '</ul>' +
      (g.host ? '<div id="liveErr"></div><div class="row"><button class="btn big" type="button" id="liveStart"' + (l.players.length < 1 ? ' disabled' : '') + '>Start the game</button><button class="btn ghost danger" type="button" id="liveEnd">Close the room</button></div>'
        : (l.joined ? '<p class="verdict vote">You’re in. Waiting for ' + esc(hostName()) + ' to start…</p>' : '<button class="btn big block" type="button" id="liveJoin">I’m in</button>')) +
      '</div><div class="side card flat"><h3>Tip</h3><p class="small muted">Put the video call on one screen and Inside Joke on your phone. Questions show on everyone’s phone at once; faster right answers score more.</p></div></div>';
    var q = $('#qrSmall');
    if (q) q.onclick = function () { qrFull(link, g.display); };
    var s = $('#liveStart');
    if (s) s.onclick = function () { s.disabled = true; liveNext(l.idx); };
    var e = $('#liveEnd');
    if (e) e.onclick = endLive;
    var j = $('#liveJoin');
    if (j) j.onclick = function () { j.disabled = true; state.src.liveJoin().then(takeLive).catch(function (err) { showError(err); j.disabled = false; }); };
  }
  function liveNext(idx) {
    state.src.liveNext(idx).then(function (l) { state.live = null; takeLive(l); }).catch(function (e) { showError(e, $('#liveErr')); });
  }
  function endLive() {
    if (!confirm('Close the room? The game ends for everyone.')) return;
    state.src.liveEnd().then(function () { state.live = null; takeLive({ none: true, serverNow: Date.now() }); }).catch(function (e) { showError(e); });
  }

  function liveTop(l) {
    return '<div class="livebar"><span>Question ' + esc(l.idx + 1) + ' of ' + esc(l.count) + '</span>' + (l.seconds ? '<span class="secs" id="secs" aria-live="off"></span>' : '<span class="small muted">' + esc(hostName()) + ' moves it on</span>') + '</div>' +
      (l.seconds && l.state === 'question' ? '<div class="timer" aria-hidden="true"><i id="tbar"></i></div>' : '<div style="height:12px"></div>');
  }
  function drawLiveQuestion(v, l) {
    var q = l.question;
    var mine = l.mine;
    var html = '<div class="card">' + liveTop(l) + '<span class="chip accent">' + esc(q.label || '') + '</span>' + photoImg(q) + '<p class="prompt">' + esc(q.prompt) + '</p>' + (q.quote ? '<blockquote class="quote">' + esc(q.quote) + '</blockquote>' : '');
    if (q.kind === 'number') {
      html += mine ? '<p class="verdict vote">Locked in: ' + esc(answerText(q, mine.a)) + '</p>'
        : '<form class="numrow" id="lnum"><label class="vh" for="lnumIn">Your guess</label><input class="input" id="lnumIn" type="number" inputmode="decimal" step="any" required placeholder="Your guess"><button class="btn" type="submit">Lock it in</button></form><p class="small muted" style="margin-top:6px">Closest guess wins.</p>';
    } else {
      html += '<div class="lopts">' + q.options.map(function (o, i) {
        return '<button type="button" class="lopt o' + i + (mine ? (mine.a === i ? ' mine' : ' dim') : '') + '" data-la="' + i + '"' + (mine ? ' disabled' : '') + '><span class="shape" aria-hidden="true">' + SHAPES[i] + '</span><span>' + esc(o) + '</span></button>';
      }).join('') + '</div>';
      if (mine) html += '<p class="verdict vote" style="margin-top:12px">Locked in. ' + (q.kind === 'caption' ? 'Points if the room agrees with you.' : 'Waiting for the others…') + '</p>';
    }
    html += '<p class="small muted" id="answeredLine" style="margin-top:10px">' + esc(answeredLine(l)) + '</p><ul class="players" id="playersList">' + playersHtml(l) + '</ul><div id="liveErr"></div>';
    if (l.host) html += '<div class="row"><button class="btn ghost" type="button" id="liveNext">Reveal now</button><button class="btn ghost danger small" type="button" id="liveEnd">End game</button></div>';
    html += '</div>';
    v.innerHTML = html;
    $$('[data-la]', v).forEach(function (b) { b.onclick = function () { liveAnswer(l, Number(b.getAttribute('data-la'))); }; });
    var f = $('#lnum');
    if (f) f.onsubmit = function (e) { e.preventDefault(); var n = Number($('#lnumIn').value); if ($('#lnumIn').value === '' || !isFinite(n)) return; liveAnswer(l, n); };
    var n = $('#liveNext');
    if (n) n.onclick = function () { n.disabled = true; liveNext(l.idx); };
    var e = $('#liveEnd');
    if (e) e.onclick = endLive;
    tick();
  }
  function liveAnswer(l, a) {
    $$('.lopt, #lnum button', $('#view')).forEach(function (b) { b.disabled = true; });
    state.src.liveAnswer(l.idx, a).then(function (nl) { state.live = null; takeLive(nl); }).catch(function (e) {
      showError(e, $('#liveErr'));
      if (e.status !== 409) $$('.lopt, #lnum button', $('#view')).forEach(function (b) { b.disabled = false; });
    });
  }
  function drawReveal(v, l) {
    var q = l.question;
    var r = l.reveal;
    var html = '<div class="split"><div class="card">' + liveTop(l) + '<p class="prompt">' + esc(q.prompt) + '</p>' + (q.quote ? '<blockquote class="quote">' + esc(q.quote) + '</blockquote>' : '');
    if (r.mine !== null && r.mine !== undefined) html += '<div class="points-pop pop' + (r.mine ? '' : ' zero') + '">' + (r.mine ? '+' + esc(r.mine.toLocaleString()) : 'No points this time') + '</div>';
    else html += '<p class="muted center">You didn’t answer that one.</p>';
    if (q.kind === 'number') {
      html += '<p class="verdict ok">It was ' + esc(answerText(q, r.answer)) + '.</p><ul class="results">' + (r.guesses || []).map(function (g0) { return '<li>' + avatar(g0, 'sm') + '<span class="sub"><b>' + esc(g0.name) + '</b><span class="from">guessed ' + esc(answerText(q, g0.a)) + '</span></span><span class="pts">' + (g0.pts ? '+' + esc(g0.pts) : '') + '</span></li>'; }).join('') + '</ul>';
    } else {
      var total = (r.tally || []).reduce(function (s, n) { return s + n; }, 0) || 1;
      var best = q.kind === 'caption' ? (r.best || []) : [r.answer];
      html += '<div class="lopts">' + q.options.map(function (o, i) {
        var win = best.indexOf(i) >= 0;
        return '<div class="lopt o' + i + (win ? '' : ' dim') + (l.mine && l.mine.a === i ? ' mine' : '') + '"><span class="shape" aria-hidden="true">' + (win ? '✓' : SHAPES[i]) + '</span><span>' + esc(o) + '</span><span class="bar">' + esc(plural(r.tally[i], 'vote')) + ' · ' + Math.round(100 * r.tally[i] / total) + '%</span></div>';
      }).join('') + '</div>';
      if (q.kind === 'caption') html += '<p class="small muted" style="margin-top:8px">No right answer - the room’s favourite scores.</p>';
    }
    html += '<div id="liveErr"></div>' + (l.host ? '<button class="btn big block" type="button" id="liveNext">' + (l.idx + 1 >= l.count ? 'Final scores' : 'Next question') + '</button>' : (l.seconds ? '<p class="small muted center" style="margin-top:12px">Next question in <span id="secs"></span></p>' : '<p class="small muted center" style="margin-top:12px">Waiting for ' + esc(hostName()) + '…</p>')) + '</div>';
    html += '<div class="side card"><h3>Scoreboard</h3>' + scoreList(l.players.slice(0, 8)) + '</div></div>';
    v.innerHTML = html;
    var n = $('#liveNext');
    if (n) n.onclick = function () { n.disabled = true; liveNext(l.idx); };
    tick();
  }
  function scoreList(players, from) {
    from = from || 0;
    return '<ol class="board">' + players.map(function (p, i) {
      var rank = from + i;
      return '<li class="' + (p.you ? 'you' : '') + '"><span class="rank' + (rank < 3 ? ' gold' : '') + '">' + (rank + 1) + '</span>' + who(p) + '<span class="pts">' + esc(p.score.toLocaleString()) + '</span></li>';
    }).join('') + '</ol>';
  }
  function drawPodium(v, l) {
    var p = l.podium || l.players;
    var top = [p[1], p[0], p[2]];
    var html = '<div class="split"><div class="card"><h2>' + (l.sample ? 'Last game night' : 'Final scores') + ' 🏆</h2>' + (l.when ? '<p class="muted small">' + esc(l.when) + ' · ' + esc(l.count) + ' questions</p>' : '') +
      '<div class="podium">' + top.map(function (x, i) {
        if (!x) return '<div></div>';
        var place = [2, 1, 3][i];
        return '<div class="step p' + place + '">' + avatar(x, 'big') + '<div class="nm">' + esc(x.name) + '</div><div class="sc">' + esc(x.score.toLocaleString()) + '</div><div class="block" aria-label="' + ['', 'First', 'Second', 'Third'][place] + ' place">' + place + '</div></div>';
      }).join('') + '</div>' + (p.length > 3 ? scoreList(p.slice(3), 3) : '') +
      (l.sample ? '<p class="small muted" style="margin-top:10px">Six Riveras in four cities, one video call, ten questions about their own photos and chat.</p>' : '') + '</div>';
    html += '<div class="side card flat">' + (l.sample ? '<h3>Host your own</h3><p class="small muted">Start a group, add questions, then open the room on game night. Everyone joins on their own phone with the room code.</p><button class="btn block" type="button" id="sampleStart">Start a group</button>'
      : (l.host ? '<h3>Again?</h3><button class="btn block" type="button" id="liveAgain">New game</button>' : '<p class="small muted">Thanks for playing! The daily round is on the Today tab.</p>')) + '</div></div>';
    v.innerHTML = html;
    var s = $('#sampleStart');
    if (s) s.onclick = startGroup;
    var a = $('#liveAgain');
    if (a) a.onclick = function () { liveSetup(v); };
  }

  /* ---------------- board ---------------- */

  function loadBoard() {
    state.src.board().then(function (b) { state.board = b; drawBoard(); }).catch(function (e) { showError(e, $('#view')); });
  }
  function drawBoard() {
    var b = state.board;
    var v = $('#view');
    var span = state.boardSpan;
    var rows = b[span];
    var key = span === 'week' ? 'week' : span === 'month' ? 'month' : 'all';
    var me = b.me;
    var head = me ? '<div class="card"><div class="row spread" style="margin:0"><div><h2 style="margin:0">' + (me.streak ? '🔥 ' + esc(plural(me.streak, 'day')) + ' in a row' : 'No streak yet') + '</h2><p class="small muted" style="margin:4px 0 0">' +
      esc(me.atRisk ? 'Play today to make it ' + (me.streak + 1) + '.' : me.playedToday ? 'You’ve played today. See you tomorrow.' : 'Play today’s round to start one.') + (me.best > 1 ? ' Best: ' + me.best + '.' : '') + '</p></div>' +
      (!me.playedToday ? '<button class="btn" type="button" id="toToday">Play today</button>' : '') + '</div></div>' : '';
    var waiting = b.waiting.filter(function (w) { return !me || w.id !== me.id; });
    v.innerHTML = '<div class="split"><div>' + head + '<div class="card"><div class="sec-head"><h2>Leaderboard</h2></div>' +
      '<div class="seg" role="group" aria-label="Period">' + [['week', 'This week'], ['month', '30 days'], ['all', 'All time']].map(function (s) { return '<button type="button" data-span="' + s[0] + '" aria-pressed="' + (span === s[0]) + '">' + s[1] + '</button>'; }).join('') + '</div>' +
      '<ol class="board">' + rows.map(function (r, i) {
        var played = r[key + 'Played'];
        var rank = 1 + rows.filter(function (x) { return x[key] > r[key]; }).length;
        return '<li class="' + (me && r.id === me.id ? 'you' : '') + '"><span class="rank' + (rank <= 3 && r[key] ? ' gold' : '') + '">' + rank + '</span><span>' + who(r) + '<span class="streak" style="display:block;margin-left:42px">' + (r.streak ? '<b>🔥 ' + esc(r.streak) + '</b>' + (r.best > r.streak ? ' · best ' + esc(r.best) : '') : (r.best ? 'best streak ' + esc(r.best) : 'no streak yet')) + (r.playedToday ? ' · played today ✓' : '') + '</span></span>' +
          '<span class="pts">' + esc(r[key]) + '<small>' + esc(plural(played, 'round')) + '</small></span></li>';
      }).join('') + '</ol><p class="small muted">A point for every right answer in the daily round. Streaks count days in a row; a streak survives until the end of the next day.</p></div></div>' +
      '<div class="side card flat"><h3>Still to play today</h3>' + (waiting.length ? '<ul class="mlist">' + waiting.map(function (w) { return '<li>' + who(memberById(w.id) || w, 'sm') + '</li>'; }).join('') + '</ul><button class="btn small ghost block" type="button" id="nudge2">Copy a nudge for the chat</button>' : '<p class="small">Everyone’s played 🎉</p>') + '</div></div>';
    $$('[data-span]', v).forEach(function (x) { x.onclick = function () { state.boardSpan = x.getAttribute('data-span'); drawBoard(); }; });
    var tt = $('#toToday');
    if (tt) tt.onclick = function () { setTab('today'); };
    var n2 = $('#nudge2');
    if (n2) n2.onclick = function () { copy('Today’s Inside Joke round is waiting - 5 questions, about two minutes 🔥', 'Copied - paste it in the family chat'); };
  }

  /* ---------------- questions ---------------- */

  function loadQuestions() {
    state.src.questions().then(function (q) { state.questions = q; drawQuestions(); }).catch(function (e) { showError(e, $('#view')); });
  }
  function qItem(q, tools) {
    var ans = q.kind === 'caption' ? 'No right answer - voted' : q.kind === 'number' ? 'Answer: ' + answerText(q, q.answer) + (q.tolerance ? ' (± ' + q.tolerance + ')' : '') : 'Answer: ' + optionText(q, q.answer);
    return '<li>' + (q.photoId ? photoImg(q, 'thumb') : '<span class="thumb" style="display:grid;place-items:center;font-size:1.5rem" aria-hidden="true">' + ({ chat: '💬', own: '✍️', photo: '📸' }[C.family(q.style)]) + '</span>') +
      '<div class="body"><span class="chip">' + esc(q.label || C.STYLE_LABEL[q.style]) + '</span><div><b>' + esc(q.prompt) + '</b></div>' + (q.quote ? '<div class="small">“' + esc(q.quote) + '”</div>' : '') +
      (q.options && q.kind !== 'number' ? '<div class="small muted">' + esc(q.options.join(' · ')) + '</div>' : '') + (q.answer !== undefined ? '<div class="ans">' + esc(ans) + '</div>' : '') + (q.by ? '<div class="small muted">by ' + esc(q.by) + '</div>' : '') + '</div>' +
      (tools ? '<div class="tools">' + tools + '</div>' : '') + '</li>';
  }
  function drawQuestions() {
    var d = state.questions;
    var v = $('#view');
    var c = d.counts;
    var drafts = (d.mine || []).filter(function (q) { return q.status === 'draft'; });
    var mine = (d.mine || []).filter(function (q) { return q.status !== 'draft'; });
    var html = '<div class="split"><div>';
    html += '<div class="card"><div class="sec-head"><h2>Add questions</h2><span class="small muted">' + esc(plural(c.live, 'question')) + ' in the bank</span></div>' +
      '<div class="counts" style="margin-bottom:12px"><span class="chip">📸 ' + esc(c.photo) + ' from photos</span><span class="chip">💬 ' + esc(c.chat) + ' from chat</span><span class="chip">✍️ ' + esc(c.own) + ' written</span></div>' +
      '<div class="ways"><button type="button" class="way" id="wayPhoto"><span class="ic" aria-hidden="true">📸</span><span><b>From your photos</b><span class="small muted">Where, what year, who took it, caption this. You review every question first.</span></span><span class="chip cost">AI · ~1¢</span></button>' +
      '<button type="button" class="way" id="wayChat"><span class="ic" aria-hidden="true">💬</span><span><b>From your group chat</b><span class="small muted">A WhatsApp export or a pasted log, read on your phone. Who’s the night owl? Who said it?</span></span><span class="chip cost">Free</span></button>' +
      '<button type="button" class="way" id="wayOwn"><span class="ic" aria-hidden="true">✍️</span><span><b>Write your own</b><span class="small muted">Multiple choice, true or false, closest number, or “who in the group…”.</span></span><span class="chip cost">Free</span></button></div></div>';
    if (drafts.length) {
      html += '<div class="card" id="drafts"><div class="sec-head"><h2>To review (' + esc(drafts.length) + ')</h2></div><p class="small muted">Only you can see these. Fix or delete anything that isn’t right, then add them to the bank.</p><ul class="qlist">' +
        drafts.map(function (q) { return qItem(q, '<button class="btn small ghost" type="button" data-edit="' + esc(q.id) + '" aria-label="Edit">Edit</button><button class="btn small ghost danger" type="button" data-del="' + esc(q.id) + '" aria-label="Delete">✕</button>'); }).join('') +
        '</ul><button class="btn big block" type="button" id="publish">Add ' + esc(plural(drafts.length, 'question')) + ' to the bank</button></div>';
    }
    if (d.example) {
      html += '<div class="card"><h2>Some of the Riveras’ questions</h2><ul class="qlist">' + d.example.map(function (q) { return qItem(q); }).join('') + '</ul></div>';
    } else {
      html += '<div class="card"><h2>Your questions (' + esc(mine.length) + ')</h2>' + (mine.length ? '<p class="small muted">You wrote these, so they skip you in your own daily round.</p><ul class="qlist">' + mine.map(function (q) {
        return qItem(q, '<button class="btn small ghost" type="button" data-edit="' + esc(q.id) + '">Edit</button><button class="btn small ghost danger" type="button" data-del="' + esc(q.id) + '" aria-label="Delete">✕</button>');
      }).join('') + '</ul>' : '<p class="muted">None yet.</p>') + '</div>';
    }
    html += '</div><div class="side">';
    if (d.others) {
      html += '<div class="card"><h2>Everyone’s questions</h2><p class="small muted">As the host you can remove any question. You see the prompts, never the answers.</p>' + (d.others.length ? '<ul class="qlist">' + d.others.map(function (q) {
        return '<li>' + (q.photoId ? photoImg(q, 'thumb') : '') + '<div class="body"><b>' + esc(q.prompt) + '</b><div class="small muted">' + esc(q.label) + ' · by ' + esc(q.by) + '</div></div><div class="tools"><button class="btn small ghost danger" type="button" data-hdel="' + esc(q.id) + '" aria-label="Remove">✕</button></div></li>';
      }).join('') + '</ul>' : '<p class="muted small">Nobody else has added any yet.</p>') + '</div>';
    }
    html += '<div class="card flat"><h3>What’s kept</h3><p class="small muted">Photos: a small thumbnail and the questions, visible to members only. The full photo is read once and dropped, and its location is never read or sent. Chats: only the questions - the chat itself never leaves your phone, except a stripped excerpt if you ask for a “who said it?” round.</p></div></div></div>';
    v.innerHTML = html;
    $('#wayPhoto').onclick = function () { if (isSample()) return sampleNudge('Making questions from your own photos'); openPhotos(); };
    $('#wayChat').onclick = function () { openChat(); };
    $('#wayOwn').onclick = function () { if (isSample()) return sampleNudge('Writing your own questions'); openWrite(); };
    $$('[data-del]', v).forEach(function (b) { b.onclick = function () { delQuestion(b.getAttribute('data-del')); }; });
    $$('[data-hdel]', v).forEach(function (b) { b.onclick = function () { delQuestion(b.getAttribute('data-hdel')); }; });
    $$('[data-edit]', v).forEach(function (b) { b.onclick = function () { var q = (d.mine || []).filter(function (x) { return x.id === b.getAttribute('data-edit'); })[0]; if (q) openEdit(q); }; });
    var pub = $('#publish');
    if (pub) pub.onclick = function () {
      pub.disabled = true;
      api('POST', state.src.path + '/questions/publish', { ids: drafts.map(function (q) { return q.id; }) }).then(function (r) { toast(plural(r.published, 'question') + ' added to the bank'); loadQuestions(); }).catch(function (e) { pub.disabled = false; showError(e); });
    };
  }
  function delQuestion(id) {
    if (!confirm('Delete this question?')) return;
    api('DELETE', state.src.path + '/questions/' + encodeURIComponent(id)).then(function () { toast('Deleted'); loadQuestions(); }).catch(function (e) { showError(e); });
  }
  function sampleNudge(what) {
    sheet('<h2>' + esc(what) + '</h2><p class="muted">That’s for your own group. Start one - it takes a minute - and invite your people with a link or a code. They never need an account.</p><button class="btn big block" type="button" id="sn">Start a group</button>', function (root) { $('#sn', root).onclick = function () { closeSheet(); startGroup(); }; });
  }

  /* ---------------- write your own ---------------- */

  function openWrite() {
    var kind = 'own';
    var members = state.group.members;
    function draw(root) {
      var body = $('.body', root);
      var f = '<div class="optgrid" role="group" aria-label="Kind">' + [['own', 'Multiple choice'], ['own_tf', 'True or false'], ['own_number', 'Closest number'], ['own_who', 'Who in the group…']].map(function (k) { return '<button type="button" class="pill" data-k="' + k[0] + '" aria-pressed="' + (kind === k[0]) + '">' + k[1] + '</button>'; }).join('') + '</div>' +
        '<label class="field"><span>Question</span><textarea class="input" id="wPrompt" rows="2" maxlength="140" placeholder="' + esc({ own: 'What did Grandpa name the boat?', own_tf: 'True or false: Mom once drove to the wrong airport.', own_number: 'How many miles is it from our house to the lake?', own_who: 'Who in the group is most likely to miss a flight?' }[kind]) + '"></textarea></label>';
      if (kind === 'own') f += '<div class="field"><span>Answers - tick the right one</span>' + [0, 1, 2, 3].map(function (i) { return '<div class="opt-edit"><input type="radio" name="wRight" value="' + i + '"' + (i === 0 ? ' checked' : '') + ' aria-label="Answer ' + 'ABCD'[i] + ' is right"><input class="input" data-opt="' + i + '" maxlength="60" placeholder="' + (i < 2 ? 'Answer ' + 'ABCD'[i] : 'Answer ' + 'ABCD'[i] + ' (optional)') + '"></div>'; }).join('') + '</div>';
      if (kind === 'own_tf') f += '<div class="field"><span>The truth</span><div class="optgrid"><label class="check"><input type="radio" name="wRight" value="0" checked> True</label><label class="check"><input type="radio" name="wRight" value="1"> False</label></div></div>';
      if (kind === 'own_number') f += '<div class="row"><label class="field" style="flex:1"><span>Answer</span><input class="input" id="wNum" type="number" step="any" inputmode="decimal"></label><label class="field" style="flex:1"><span>Counts if within</span><input class="input" id="wTol" type="number" step="any" min="0" value="0" inputmode="decimal"></label></div><label class="field"><span>Unit <span class="muted">(optional)</span></span><input class="input" id="wUnit" maxlength="12" placeholder="miles"></label>';
      if (kind === 'own_who') f += '<div class="field"><span>Who’s in the running (2-4) - and who’s right</span>' + members.map(function (m) { return '<div class="opt-edit" style="grid-template-columns:44px 44px 1fr"><input type="radio" name="wRight" value="' + esc(m.id) + '" aria-label="' + esc(m.name) + ' is right"><input type="checkbox" data-mem="' + esc(m.id) + '" aria-label="Include ' + esc(m.name) + '" style="width:22px;height:22px;justify-self:center"><span>' + who(m, 'sm') + '</span></div>'; }).join('') + '</div>';
      f += '<div id="wErr"></div><button class="btn big block" type="button" id="wSave">Add to the bank</button><p class="small muted">You wrote it, so it won’t come up in your own daily round.</p>';
      body.innerHTML = f;
      $$('[data-k]', body).forEach(function (b) { b.onclick = function () { kind = b.getAttribute('data-k'); draw(root); }; });
      $('#wSave', body).onclick = function () {
        var q = { style: kind, prompt: $('#wPrompt', body).value };
        var right = $('input[name=wRight]:checked', body);
        if (kind === 'own') {
          var opts = [];
          var ans = -1;
          $$('[data-opt]', body).forEach(function (inp) { var t = inp.value.trim(); if (t) { if (right && right.value === inp.getAttribute('data-opt')) ans = opts.length; opts.push(t); } });
          q.options = opts; q.answer = ans;
        } else if (kind === 'own_tf') { q.answer = right ? Number(right.value) : 0; }
        else if (kind === 'own_number') { q.answer = Number($('#wNum', body).value); q.tolerance = Math.abs(Number($('#wTol', body).value) || 0); q.unit = $('#wUnit', body).value; if ($('#wNum', body).value === '') q.answer = NaN; }
        else {
          var ids = $$('[data-mem]', body).filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-mem'); });
          if (right && ids.indexOf(right.value) < 0 && ids.length < 4) ids.push(right.value);
          q.members = ids; q.answer = right ? ids.indexOf(right.value) : -1;
        }
        var btn = this;
        btn.disabled = true;
        api('POST', state.src.path + '/questions', { questions: [q], source: 'own' }).then(function () { closeSheet(); toast('Added to the bank'); loadQuestions(); }).catch(function (e) { btn.disabled = false; showError(e, $('#wErr', body)); });
      };
    }
    sheet('<h2>Write a question</h2><div class="body"></div>', draw);
  }

  function openEdit(q) {
    var lockedAnswers = ['where', 'when', 'who_took', 'who_said'].indexOf(q.style) >= 0;
    var html = '<h2>Edit question</h2><label class="field"><span>Question</span><textarea class="input" id="ePrompt" rows="2" maxlength="140">' + esc(q.prompt) + '</textarea></label>';
    if (q.kind !== 'number' && !lockedAnswers && q.style !== 'own_tf' && q.style !== 'own_who') {
      html += '<div class="field"><span>' + (q.kind === 'caption' ? 'Captions' : 'Answers - tick the right one') + '</span>' + [0, 1, 2, 3].map(function (i) {
        var val = q.options[i] || '';
        return '<div class="opt-edit">' + (q.kind === 'caption' ? '<span></span>' : '<input type="radio" name="eRight" value="' + i + '"' + (i === q.answer ? ' checked' : '') + ' aria-label="Answer ' + 'ABCD'[i] + ' is right">') + '<input class="input" data-eopt="' + i + '" maxlength="60" value="' + esc(val) + '"></div>';
      }).join('') + '</div>';
    } else if (lockedAnswers) {
      html += '<p class="small muted">The answer to this one comes from the facts you gave (or the chat) and can’t be changed here. Delete it if it’s wrong.</p>';
    }
    if (q.style === 'own_number') html += '<div class="row"><label class="field" style="flex:1"><span>Answer</span><input class="input" id="eNum" type="number" step="any" value="' + esc(q.answer) + '"></label><label class="field" style="flex:1"><span>Counts if within</span><input class="input" id="eTol" type="number" min="0" step="any" value="' + esc(q.tolerance || 0) + '"></label></div>';
    if (q.style === 'own_tf') html += '<div class="optgrid"><label class="check"><input type="radio" name="eRight" value="0"' + (q.answer === 0 ? ' checked' : '') + '> True</label><label class="check"><input type="radio" name="eRight" value="1"' + (q.answer === 1 ? ' checked' : '') + '> False</label></div>';
    html += '<div id="eErr"></div><button class="btn big block" type="button" id="eSave">Save</button>';
    sheet(html, function (root) {
      $('#eSave', root).onclick = function () {
        var out = { prompt: $('#ePrompt', root).value, options: q.options, answer: q.answer, members: q.members, tolerance: q.tolerance, unit: q.unit };
        var opts = $$('[data-eopt]', root);
        if (opts.length) {
          var r = $('input[name=eRight]:checked', root);
          var list = [];
          var ans = -1;
          opts.forEach(function (inp) { var t = inp.value.trim(); if (t) { if (r && r.value === inp.getAttribute('data-eopt')) ans = list.length; list.push(t); } });
          out.options = list; out.answer = q.kind === 'caption' ? null : ans;
        }
        if (q.style === 'own_tf') { var r2 = $('input[name=eRight]:checked', root); out.answer = r2 ? Number(r2.value) : q.answer; }
        if (q.style === 'own_number') { out.answer = Number($('#eNum', root).value); out.tolerance = Math.abs(Number($('#eTol', root).value) || 0); }
        var b = this;
        b.disabled = true;
        api('PUT', state.src.path + '/questions/' + encodeURIComponent(q.id), { question: out }).then(function () { closeSheet(); toast('Saved'); loadQuestions(); }).catch(function (e) { b.disabled = false; showError(e, $('#eErr', root)); });
      };
    });
  }

  /* ---------------- photos ---------------- */

  /** EXIF, read only for the date the photo was taken. A location tag is
   *  noticed (so the page can say it will be removed) but never read. */
  function exifInfo(buf) {
    var out = {};
    try {
      var v = new DataView(buf);
      if (v.getUint16(0) !== 0xffd8) return out;
      var off = 2;
      while (off + 10 < v.byteLength) {
        var marker = v.getUint16(off);
        var len = v.getUint16(off + 2);
        if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return readTiff(v, off + 10);
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
        off += 2 + len;
      }
    } catch (e) { /* not readable: no year */ }
    return out;
  }
  function readTiff(v, t) {
    var out = {};
    var le = v.getUint16(t) === 0x4949;
    function u16(o) { return v.getUint16(t + o, le); }
    function u32(o) { return v.getUint32(t + o, le); }
    function ifd(o) { var n = u16(o); var r = {}; for (var i = 0; i < n && i < 200; i++) { var e = o + 2 + i * 12; r[u16(e)] = { count: u32(e + 4), at: e + 8 }; } return r; }
    function str(en) { var o = en.count > 4 ? u32(en.at) : en.at; var s = ''; for (var i = 0; i < Math.min(en.count, 20); i++) { var c = v.getUint8(t + o + i); if (!c) break; s += String.fromCharCode(c); } return s; }
    try {
      var i0 = ifd(u32(4));
      out.gps = Boolean(i0[0x8825]);
      var date = null;
      if (i0[0x8769]) { var ex = ifd(u32(i0[0x8769].at)); if (ex[0x9003]) date = str(ex[0x9003]); }
      if (!date && i0[0x0132]) date = str(i0[0x0132]);
      var m = /^(\d{4}):/.exec(date || '');
      if (m && Number(m[1]) >= 1900 && Number(m[1]) <= new Date().getFullYear()) out.year = Number(m[1]);
    } catch (e) { /* ignore */ }
    return out;
  }
  function loadImg(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { res(img); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('That file isn’t a photo this browser can open.')); };
      img.src = url;
    });
  }
  /** A canvas redraw: a JPEG of at most `side` pixels and `maxBytes`, with
   *  no EXIF (a canvas never carries it). Returns base64. */
  function jpeg(img, side, maxBytes) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var scale = Math.min(1, side / Math.max(w, h));
    for (var tries = 0; tries < 6; tries++) {
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      for (var q = 0.82; q >= 0.45; q -= 0.12) {
        var data = c.toDataURL('image/jpeg', q).split(',')[1];
        if (data.length * 3 / 4 <= maxBytes) return data;
      }
      scale *= 0.8;
    }
    throw new Error('That photo could not be made small enough.');
  }

  function openPhotos() {
    if (!signedIn()) return openAccount('Making questions from photos uses AI, so it needs a free account (it comes with $2 of credit - a photo costs about a cent). The rest of your group never needs one.', openPhotos);
    var items = [];
    function draw(root) {
      var body = $('.body', root);
      body.innerHTML = '<p class="muted">Pick a few photos the group will remember. Add the place and a hint - the AI only uses what you tell it and what it can see, and never guesses who anyone is.</p>' +
        '<label class="btn block ghost">📷 Choose photos<input type="file" accept="image/*" multiple id="pFile" class="vh"></label>' +
        '<div class="pick-photos" id="pList" style="margin-top:12px"></div><div id="pErr"></div>' +
        '<p class="lock"><span aria-hidden="true">🔒</span><span>Each photo is redrawn on this phone first, which removes its location and camera details. Only a small thumbnail and the questions are kept, for your group only.</span></p>' +
        '<button class="btn big block" type="button" id="pGo" disabled>Make questions</button>';
      $('#pFile', body).onchange = function (e) {
        var files = Array.prototype.slice.call(e.target.files || [], 0, 10 - items.length);
        e.target.value = '';
        files.reduce(function (p, f) {
          return p.then(function () {
            return f.arrayBuffer().then(function (buf) {
              var ex = exifInfo(buf);
              return loadImg(f).then(function (img) {
                items.push({ thumb: jpeg(img, 640, 110 * 1024), image: jpeg(img, 1280, 1400 * 1024), year: ex.year || null, gps: Boolean(ex.gps), place: '', hint: '' });
              });
            });
          }).catch(function (err) { showError(err, $('#pErr', body)); });
        }, Promise.resolve()).then(function () { list(body); });
      };
      list(body);
      $('#pGo', body).onclick = function () { run(body); };
    }
    function list(body) {
      var el = $('#pList', body);
      el.innerHTML = items.map(function (it, i) {
        return '<div class="pp" data-i="' + i + '"><img src="data:image/jpeg;base64,' + it.thumb + '" alt="Photo ' + (i + 1) + '"><div>' +
          '<label class="field"><span>Where <span class="muted small">(the answer to “where?”)</span></span><input class="input" data-f="place" maxlength="60" placeholder="Lake Lanier" value="' + esc(it.place) + '"></label>' +
          '<div class="row" style="margin:0"><label class="field" style="flex:0 0 90px"><span>Year</span><input class="input" data-f="year" type="number" inputmode="numeric" min="1900" max="' + new Date().getFullYear() + '" value="' + esc(it.year || '') + '"></label>' +
          '<label class="field" style="flex:1 1 170px"><span>Hint</span><input class="input" data-f="hint" maxlength="140" placeholder="Dad’s birthday, the cake fell in" value="' + esc(it.hint) + '"></label></div>' +
          (it.gps ? '<p class="gps">📍 This photo had a location in it - removed before anything is sent.</p>' : '') +
          '<p class="small" data-status></p><button type="button" class="link-btn" data-rm>Remove</button></div></div>';
      }).join('');
      $$('.pp', el).forEach(function (row) {
        var it = items[Number(row.getAttribute('data-i'))];
        $$('[data-f]', row).forEach(function (inp) { inp.oninput = function () { var k = inp.getAttribute('data-f'); it[k] = k === 'year' ? (Number(inp.value) || null) : inp.value; }; });
        $('[data-rm]', row).onclick = function () { items.splice(items.indexOf(it), 1); list(body); };
      });
      $('#pGo', body).disabled = !items.length;
      $('#pGo', body).textContent = items.length ? 'Make questions from ' + plural(items.length, 'photo') : 'Make questions';
    }
    function run(body) {
      var go = $('#pGo', body);
      go.disabled = true;
      var made = 0;
      var i = 0;
      function nextOne() {
        if (i >= items.length) { closeSheet(); toast(made ? plural(made, 'question') + ' ready to review' : 'No questions this time', 3200); return loadQuestions(); }
        var it = items[i];
        var row = $$('.pp', body)[i];
        var st = $('[data-status]', row);
        st.textContent = 'Making questions… (' + (i + 1) + ' of ' + items.length + ')';
        go.textContent = 'Working on ' + (i + 1) + ' of ' + items.length + '…';
        return api('POST', state.src.path + '/photos', { thumb: it.thumb, image: { type: 'image/jpeg', data: it.image }, year: it.year, place: it.place, hint: it.hint }).then(function (r) {
          made += r.questions.length;
          st.textContent = '✓ ' + plural(r.questions.length, 'question');
          i++;
          return nextOne();
        }).catch(function (e) {
          if (e.status === 401 || e.status === 402 || (e.status === 403 && e.data && e.data.code === 'verify-email')) { go.disabled = false; return showError(e, $('#pErr', body)); }
          st.textContent = e.message;
          i++;
          return nextOne();
        });
      }
      nextOne();
    }
    sheet('<h2>Questions from photos</h2><div class="body"></div>', draw);
  }

  /* ---------------- group chat ---------------- */

  /** A WhatsApp .txt, or the .zip an iPhone makes (with _chat.txt inside),
   *  read here. Nothing is uploaded. */
  function readChatFile(file) {
    return file.arrayBuffer().then(function (buf) {
      var v = new DataView(buf);
      if (v.byteLength > 4 && v.getUint32(0, true) === 0x04034b50) return unzipText(buf);
      return new TextDecoder('utf-8').decode(buf);
    });
  }
  function unzipText(buf) {
    var v = new DataView(buf);
    var eocd = -1;
    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.reject(new Error('That zip could not be opened. Unzip it and pick the .txt inside.'));
    var n = v.getUint16(eocd + 10, true);
    var p = v.getUint32(eocd + 16, true);
    var best = null;
    for (var k = 0; k < n; k++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      var nlen = v.getUint16(p + 28, true);
      var name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
      var e = { method: v.getUint16(p + 10, true), csize: v.getUint32(p + 20, true), loff: v.getUint32(p + 42, true) };
      if (/\.txt$/i.test(name) && !/__MACOSX/.test(name) && (!best || /_chat\.txt$/i.test(name))) best = e;
      p += 46 + nlen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    }
    if (!best) return Promise.reject(new Error('No chat text in that zip. Export the chat “without media” and try again.'));
    var start = best.loff + 30 + v.getUint16(best.loff + 26, true) + v.getUint16(best.loff + 28, true);
    var data = new Uint8Array(buf, start, best.csize);
    if (best.method === 0) return Promise.resolve(new TextDecoder('utf-8').decode(data));
    if (best.method !== 8 || typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser can’t open that zip. Unzip it and pick the _chat.txt inside.'));
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (out) { return new TextDecoder('utf-8').decode(out); });
  }

  function openChat() {
    var parsed = null;
    var stats = null;
    var qs = [];
    function step1(root) {
      var body = $('.body', root);
      body.innerHTML = '<p class="note small"><b>Only share a chat everyone in it would be happy to play with.</b></p>' +
        '<details><summary class="small" style="min-height:44px;display:flex;align-items:center;cursor:pointer">How to export a WhatsApp chat</summary><ol class="steps"><li><b>iPhone:</b> open the chat, tap its name, scroll down, Export Chat, Without Media. Save it to Files.</li><li><b>Android:</b> open the chat, ⋮, More, Export chat, Without media.</li><li>Then pick the file below (.zip or .txt).</li></ol></details>' +
        '<label class="btn block">💬 Choose the export<input type="file" id="cFile" class="vh" accept=".txt,.zip,text/plain,application/zip"></label>' +
        '<p class="small muted center" style="margin:10px 0 4px">or paste a chat, one “Name: message” per line</p>' +
        '<textarea class="input" id="cPaste" rows="5" placeholder="Mom: Did everyone land ok?&#10;Erik: Just landed in Denver ✈️&#10;Lucía: lol same"></textarea>' +
        '<div id="cErr"></div><button class="btn block ghost" type="button" id="cRead">Read the pasted chat</button>' +
        '<p class="lock"><span aria-hidden="true">🔒</span><span>Read on this phone. Nothing is uploaded - only the questions you choose to keep.</span></p>';
      $('#cFile', body).onchange = function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        $('#cErr', body).innerHTML = '<p class="busy">Reading…</p>';
        readChatFile(f).then(function (text) { take(root, text); }).catch(function (err) { showError(err, $('#cErr', body)); });
      };
      $('#cRead', body).onclick = function () { take(root, $('#cPaste', body).value); };
    }
    function take(root, text) {
      parsed = C.parseChat(text);
      if (parsed.messages.length < 10 || parsed.names.length < 2) return showError(new Error(parsed.messages.length ? 'That chat is a bit short - it needs at least two people and ten messages.' : 'No messages found. A WhatsApp export, or lines like “Mom: hello”, please.'), $('#cErr', $('.body', root)));
      stats = C.chatStats(parsed);
      qs = C.statQuestions(stats, (state.group && state.group.id) + '|' + parsed.messages.length);
      step2(root);
    }
    function step2(root) {
      var body = $('.body', root);
      var max = stats.people[0] ? stats.people[0].count : 1;
      var top = function (k) { var s = stats.people.slice().sort(function (a, b) { return b[k] - a[k]; })[0]; return s && s[k] ? s : null; };
      var owl = top('night');
      var bird = top('early');
      var lol = top('lol');
      body.innerHTML = '<p class="muted small">' + esc(stats.total.toLocaleString()) + ' messages' + (stats.from ? ' · ' + esc(C.dateLabel(stats.from, true)) + ' to ' + esc(C.dateLabel(stats.to, true)) : '') + ' · read on this phone</p>' +
        '<div class="stats">' +
        (owl && stats.hasTime ? '<div class="stat"><span>🦉 Night owl</span><b>' + esc(owl.name) + '</b><span>' + esc(owl.night) + ' after 11pm</span></div>' : '') +
        (bird && stats.hasTime ? '<div class="stat"><span>🐓 Early bird</span><b>' + esc(bird.name) + '</b><span>' + esc(bird.early) + ' before 8am</span></div>' : '') +
        (lol ? '<div class="stat"><span>😂 Laughs most</span><b>' + esc(lol.name) + '</b><span>' + esc(lol.lol) + ' lols & hahas</span></div>' : '') +
        (stats.busiest && !(stats.topDays[1] && stats.topDays[1].count === stats.busiest.count) ? '<div class="stat"><span>📅 Busiest day</span><b>' + esc(C.dateLabel(stats.busiest.date, true)) + '</b><span>' + esc(stats.busiest.count) + ' messages</span></div>' : '') +
        (stats.first ? '<div class="stat"><span>👋 First message</span><b>' + esc(stats.first.name) + '</b><span>' + esc(stats.first.date ? C.dateLabel(stats.first.date, true) : 'at the top') + '</span></div>' : '') +
        '</div><h3>Who talks most</h3><ul class="bars">' + stats.people.slice(0, 8).map(function (p) {
          return '<li><span class="nm">' + esc(p.name) + '</span><span class="b"><i style="width:' + Math.max(2, Math.round(100 * p.count / max)) + '%"></i></span><span class="small">' + esc(p.count.toLocaleString()) + (p.topEmoji ? ' ' + esc(p.topEmoji) : '') + '</span></li>';
        }).join('') + '</ul>' +
        '<h3>Free questions from these stats</h3>' + (qs.length ? '<ul class="qlist">' + qs.map(function (q, i) {
          return '<li><input type="checkbox" checked data-qi="' + i + '" aria-label="Keep this question" style="width:22px;height:22px;flex:none;margin-top:4px;accent-color:var(--accent)"><div class="body"><b>' + esc(q.prompt) + '</b><div class="ans">' + esc(q.kind === 'number' ? 'Answer: ' + q.answer.toLocaleString() : 'Answer: ' + q.options[q.answer]) + '</div></div></li>';
        }).join('') + '</ul>' : '<p class="muted small">No clear winners to ask about in this one.</p>') +
        '<div id="cErr"></div>' + (qs.length ? '<button class="btn big block" type="button" id="cSave">' + (isSample() ? 'Add to a group of your own' : 'Add the ticked questions') + '</button>' : '') +
        '<div class="card flat" style="margin-top:16px"><h3>“Who said it?” round <span class="chip cost">AI · ~1¢</span></h3><p class="small muted">The AI picks memorable lines from up to 400 messages, and we check every quote is really in your chat and who said it. Phone numbers, emails and links are removed on this phone first; names stay - they’re the game. Only the questions are kept.</p><button class="btn ghost block" type="button" id="cAi">Make a “who said it?” round</button></div>';
      var save = $('#cSave', body);
      if (save) save.onclick = function () {
        if (isSample()) { closeSheet(); return sampleNudge('Adding questions from your chat'); }
        var keepQs = $$('[data-qi]', body).filter(function (c) { return c.checked; }).map(function (c) { return qs[Number(c.getAttribute('data-qi'))]; });
        if (!keepQs.length) return;
        save.disabled = true;
        api('POST', state.src.path + '/questions', { questions: keepQs, source: 'chat' }).then(function (r) { toast(plural(r.saved.length, 'question') + ' added to the bank'); save.textContent = 'Added ✓'; }).catch(function (e) { save.disabled = false; showError(e, $('#cErr', body)); });
      };
      $('#cAi', body).onclick = function () {
        if (isSample()) { closeSheet(); return sampleNudge('A “who said it?” round from your chat'); }
        if (!signedIn()) return openAccount('The “who said it?” round uses AI, so it needs a free account (it comes with $2 of credit). Your chat stays on this phone either way.');
        var b = this;
        b.disabled = true;
        b.textContent = 'Picking quotes…';
        var excerpt = C.buildExcerpt(parsed);
        api('POST', state.src.path + '/chat', { excerpt: excerpt }).then(function (r) { closeSheet(); toast(plural(r.questions.length, 'quote') + ' ready to review', 3200); loadQuestions(); })
          .catch(function (e) { b.disabled = false; b.textContent = 'Make a “who said it?” round'; showError(e, $('#cErr', body)); });
      };
    }
    sheet('<h2>Questions from your group chat</h2><div class="body"></div>', step1);
  }

  /* ---------------- the group tab ---------------- */

  function groupLink() { return location.origin + BASE + 'j/' + state.group.code; }
  function drawGroupTab() {
    var g = state.group;
    var v = $('#view');
    if (isSample()) {
      v.innerHTML = '<div class="card"><h2>' + esc(g.name) + '</h2><ul class="mlist">' + g.members.map(function (m) { return '<li>' + who(m) + '<span class="tag">' + (m.host ? 'host' : '') + (m.you ? ' · you' : '') + '</span></li>'; }).join('') + '</ul></div>' + sampleNext();
      $('#sampleStart').onclick = startGroup;
      return;
    }
    var meM = memberById(g.me) || {};
    v.innerHTML = '<div class="split"><div>' +
      '<div class="card"><h2>Invite your people</h2><p class="muted small">Anyone with this link or code can join with a name and an emoji - no account. Up to ' + esc(g.limits.members) + ' people.</p>' +
      '<div class="room"><button type="button" class="qr" id="qrSmall" aria-label="Show the QR code full screen">' + QR.svg(groupLink(), 'QR code to join ' + g.name) + '</button><div><p class="small muted" style="margin:0">Join code</p><p class="code" style="margin:0">' + esc(g.display) + '</p></div></div>' +
      '<div class="row"><button class="btn" type="button" id="copyLink">Copy invite link</button>' + (navigator.share ? '<button class="btn ghost" type="button" id="shareLink">Share…</button>' : '') + '</div></div>' +
      '<div class="card"><div class="sec-head"><h2>Members (' + esc(g.members.length) + ')</h2></div><ul class="mlist">' + g.members.map(function (m) {
        return '<li>' + who(m) + '<span class="tag">' + [m.host ? 'host' : '', m.you ? 'you' : '', m.linked ? '🔗' : ''].filter(Boolean).join(' · ') + '</span>' +
          (g.host && !m.host ? '<button class="btn small ghost danger x" type="button" data-rm="' + esc(m.id) + '">Remove</button>' : '') + '</li>';
      }).join('') + '</ul></div></div><div class="side">' +
      '<div class="card"><h2>You</h2><p>' + who(meM, 'big') + '</p><button class="btn ghost block" type="button" id="editMe">Change name, emoji or colour</button>' +
      (meM.linked ? '<p class="small muted" style="margin-top:10px">🔗 Your seat is tied to your account - sign in on any device to play as you.</p>' : '<p class="small muted" style="margin-top:10px">This phone remembers you. To play from another device too, tie your seat to a free account.</p><button class="btn ghost block" type="button" id="linkMe">Keep my seat on every device</button>') +
      (!g.host ? '<button class="btn ghost danger block" type="button" id="leave">Leave the group</button>' : '') + '</div>' +
      (g.host ? '<div class="card"><h2>Host</h2><label class="field"><span>Group name</span><input class="input" id="gName" maxlength="40" value="' + esc(g.name) + '"></label>' +
        '<label class="field"><span>Time zone <span class="muted small">(the daily round turns over at its midnight)</span></span><select class="input" id="gTz">' + tzOptions(g.tz) + '</select></label>' +
        '<div id="hErr"></div><button class="btn block" type="button" id="gSave">Save</button>' +
        '<button class="btn ghost block" type="button" id="rotate">New join code</button><p class="small muted">The old code stops working at once; members already in are not affected.</p>' +
        '<button class="btn ghost danger block" type="button" id="delGroup">Delete the group</button><p class="small muted">Deletes every member, question, photo, round and score. It can’t be undone.</p></div>' : '') +
      '<div class="card flat"><h3>Privacy</h3><p class="small muted">Only members can see this group, its photos and its questions - anyone else gets “not found”. Photos are served only through the app, never at a public address.</p></div></div></div>';
    $('#qrSmall').onclick = function () { qrFull(groupLink(), g.display); };
    $('#copyLink').onclick = function () { copy(groupLink(), 'Invite link copied'); };
    var sh = $('#shareLink');
    if (sh) sh.onclick = function () { navigator.share({ title: 'Join ' + g.name + ' on Inside Joke', text: 'Join ' + g.name + ' on Inside Joke - daily trivia about us. Code ' + g.display, url: groupLink() }).catch(function () {}); };
    $$('[data-rm]', v).forEach(function (b) {
      b.onclick = function () {
        var m = memberById(b.getAttribute('data-rm'));
        if (!m || !confirm('Remove ' + m.name + ' from the group? Their scores go too.')) return;
        api('DELETE', state.src.path + '/members/' + encodeURIComponent(m.id)).then(function (r) { state.group = r.group; drawStrip(); drawGroupTab(); }).catch(function (e) { showError(e); });
      };
    });
    $('#editMe').onclick = function () { editMe(); };
    var lk = $('#linkMe');
    if (lk) lk.onclick = function () {
      function go() { api('POST', state.src.path + '/link', {}).then(function (r) { state.group = r.group; toast('Your seat is tied to your account'); drawGroupTab(); }).catch(function (e) { showError(e); }); }
      if (!signedIn()) return openAccount('Sign in (or make a free account) and your seat in ' + g.name + ' follows you to every device.', go);
      go();
    };
    var lv = $('#leave');
    if (lv) lv.onclick = function () {
      if (!confirm('Leave ' + g.name + '? Your scores go with you.')) return;
      api('DELETE', state.src.path + '/members/' + encodeURIComponent(g.me)).then(function () { forgetGroup(g.id); location.href = BASE; }).catch(function (e) { showError(e); });
    };
    if (g.host) {
      $('#gSave').onclick = function () {
        api('PUT', state.src.path, { name: $('#gName').value, tz: $('#gTz').value }).then(function (r) { state.group = r.group; rememberGroup(r.group); drawStrip(); toast('Saved'); }).catch(function (e) { showError(e, $('#hErr')); });
      };
      $('#rotate').onclick = function () {
        if (!confirm('Make a new join code? The old one stops working.')) return;
        api('POST', state.src.path + '/code', {}).then(function (r) { state.group = r.group; drawGroupTab(); toast('New code: ' + r.group.display); }).catch(function (e) { showError(e); });
      };
      $('#delGroup').onclick = function () {
        var typed = prompt('This deletes everything in ' + g.name + ' for everyone. Type the group’s name to confirm:');
        if (typed === null) return;
        if (typed.trim().toLowerCase() !== g.name.trim().toLowerCase()) return toast('The name didn’t match - nothing was deleted.', 3600);
        api('DELETE', state.src.path).then(function () { forgetGroup(g.id); location.href = BASE; }).catch(function (e) { showError(e); });
      };
    }
  }
  function tzOptions(cur) {
    var list = [];
    try { if (Intl.supportedValuesOf) list = Intl.supportedValuesOf('timeZone'); } catch (e) { list = []; }
    if (!list.length) list = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Madrid', 'Asia/Tokyo', 'Australia/Sydney'];
    if (list.indexOf(cur) < 0) list = [cur].concat(list);
    return list.map(function (z) { return '<option value="' + esc(z) + '"' + (z === cur ? ' selected' : '') + '>' + esc(z.replace(/_/g, ' ')) + '</option>'; }).join('');
  }

  function pickers(sel) {
    return '<div class="field"><span id="emLbl">Emoji</span><div class="emojis" role="radiogroup" aria-labelledby="emLbl">' + C.EMOJI.map(function (e) { return '<button type="button" class="em-btn" role="radio" data-em="' + esc(e) + '" aria-checked="' + (sel.emoji === e) + '" aria-label="' + esc(e) + '">' + esc(e) + '</button>'; }).join('') + '</div></div>' +
      '<div class="field"><span id="colLbl">Colour</span><div class="swatches" role="radiogroup" aria-labelledby="colLbl">' + C.COLORS.map(function (c) { return '<button type="button" class="sw" role="radio" data-col="' + c.id + '" style="--c:' + c.hex + '" aria-checked="' + (sel.color === c.id) + '" aria-label="' + c.id + '"></button>'; }).join('') + '</div></div>';
  }
  function wirePickers(root, sel) {
    $$('[data-em]', root).forEach(function (b) { b.onclick = function () { sel.emoji = b.getAttribute('data-em'); $$('[data-em]', root).forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); }; });
    $$('[data-col]', root).forEach(function (b) { b.onclick = function () { sel.color = b.getAttribute('data-col'); $$('[data-col]', root).forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); }; });
  }
  function editMe() {
    var m = memberById(state.group.me);
    var sel = { emoji: m.emoji, color: m.color };
    sheet('<h2>You in ' + esc(state.group.name) + '</h2><label class="field"><span>Name</span><input class="input" id="meName" maxlength="20" value="' + esc(m.name) + '"></label>' + pickers(sel) + '<div id="meErr"></div><button class="btn big block" type="button" id="meSave">Save</button>', function (root) {
      wirePickers(root, sel);
      $('#meSave', root).onclick = function () {
        api('POST', state.src.path + '/me', { name: $('#meName', root).value, emoji: sel.emoji, color: sel.color }).then(function (r) { state.group = r.group; closeSheet(); drawStrip(); drawGroupTab(); }).catch(function (e) { showError(e, $('#meErr', root)); });
      };
    });
  }

  function qrFull(link, display) {
    var o = document.createElement('div');
    o.className = 'qrfull';
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-label', 'Join code');
    o.innerHTML = '<button type="button" class="btn small ghost" id="qrClose">Close</button><div class="qrbox">' + QR.svg(link, 'QR code, join code ' + display) + '</div><p class="code">' + esc(display) + '</p><p>Scan to join - no account needed.</p>';
    document.body.appendChild(o);
    $('#qrClose', o).onclick = function () { o.remove(); };
    $('#qrClose', o).focus();
  }

  /* ---------------- home, join, create ---------------- */

  function startGroup() {
    if (!signedIn()) return openAccount('Starting a group needs a free account, so the group is yours to run. Everyone you invite joins with just a name and an emoji.', startGroup);
    var sel = { emoji: '😎', color: 'grape' };
    sheet('<h2>Start a group</h2><label class="field"><span>Group name</span><input class="input" id="nName" maxlength="40" placeholder="The Strongs, College crew…"></label>' +
      '<label class="field"><span>Your name in it</span><input class="input" id="nMe" maxlength="20" placeholder="Erik, Dad, Auntie Jo…"></label>' + pickers(sel) +
      '<p class="small muted">The daily round turns over at midnight in ' + esc(TZ.replace(/_/g, ' ')) + ' - you can change it later.</p><div id="nErr"></div><button class="btn big block" type="button" id="nGo">Create the group</button>', function (root) {
      wirePickers(root, sel);
      $('#nGo', root).onclick = function () {
        var b = this;
        b.disabled = true;
        api('POST', 'api/groups', { name: $('#nName', root).value, tz: TZ, host: { name: $('#nMe', root).value, emoji: sel.emoji, color: sel.color } }).then(function (r) {
          rememberGroup(r.group);
          keep(K_TAB, 'group');
          location.href = BASE + 'g/' + r.group.id;
        }).catch(function (e) { b.disabled = false; showError(e, $('#nErr', root)); });
      };
    });
  }

  function joinByCode() {
    sheet('<h2>Join a group</h2><p class="muted">Type the code whoever invited you can see under Invite.</p><form id="jForm"><label class="field"><span>Join code</span><input class="input" id="jCode" autocomplete="off" autocapitalize="characters" maxlength="9" placeholder="ABC-DEF" style="font-size:1.4rem;letter-spacing:.1em;text-transform:uppercase"></label><div id="jErr"></div><button class="btn big block" type="submit">Next</button></form>', function (root) {
      $('#jForm', root).onsubmit = function (e) {
        e.preventDefault();
        var code = $('#jCode', root).value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length !== 6) return showError(new Error('A code is six letters and numbers, like ABC-DEF.'), $('#jErr', root));
        location.href = BASE + 'j/' + code;
      };
    });
  }

  function drawJoin() {
    state.mode = 'join';
    var el = $('#view');
    el.innerHTML = '<p class="busy" role="status">Finding the group…</p>';
    api('GET', 'api/code/' + ROUTE.code).then(function (g) {
      if (g.member) { location.replace(BASE + 'g/' + g.gid); return; }
      var sel = { emoji: C.EMOJI[Math.floor(Math.random() * 12)], color: null };
      el.innerHTML = '<div class="card"><p class="small muted" style="margin:0">You’re invited to</p><div class="ghead"><h1>' + esc(g.name) + '</h1></div>' +
        '<p class="faces" aria-label="' + esc(g.members.length + ' in the group') + '">' + g.members.slice(0, 12).map(function (m) { return '<span class="av sm" style="--c:' + esc(C.colorHex(m.color)) + '" title="' + esc(m.name) + '">' + esc(m.emoji) + '</span>'; }).join('') + '</p>' +
        '<p class="muted">' + esc(names(g.members.slice(0, 4))) + (g.members.length > 4 ? ' and ' + plural(g.members.length - 4, 'other') : '') + (g.members.length === 1 ? ' plays' : ' play') + ' trivia about each other here - five questions a day, and live on game night.</p>' +
        (g.full ? '<p class="err">This group is full.</p>' : '<label class="field"><span>Your name</span><input class="input" id="jName" maxlength="20" placeholder="What the group calls you"></label>' + pickers(sel) +
          '<div id="jErr"></div><button class="btn big block" type="button" id="jGo">Join ' + esc(g.name) + '</button><p class="small muted">No account needed. This phone remembers you; you can tie your seat to a free account later to play from other devices.</p>') + '</div>';
      if (g.full) return;
      wirePickers(el, sel);
      $('#jGo').onclick = function () {
        var b = this;
        b.disabled = true;
        api('POST', 'api/code/' + ROUTE.code + '/join', { name: $('#jName').value, emoji: sel.emoji, color: sel.color }).then(function (r) {
          rememberGroup({ id: r.gid, name: g.name });
          keep(K_TAB, 'today');
          location.replace(BASE + 'g/' + r.gid);
        }).catch(function (e) { b.disabled = false; showError(e, $('#jErr')); });
      };
    }).catch(function (e) {
      el.innerHTML = '<div class="card"><h2>That code didn’t work</h2><p class="err" role="alert">' + esc(e.message) + '</p><div class="row"><button class="btn" type="button" id="again">Type it again</button><a class="btn ghost" href="' + esc(BASE) + '">Home</a></div></div>';
      $('#again').onclick = joinByCode;
    });
  }

  function drawHome() {
    state.mode = 'home';
    stopTimers();
    setTabsVisible(false);
    state.group = null;
    $('#strip').innerHTML = '';
    $('#view').innerHTML = '';
    var h = $('#home');
    h.hidden = false;
    var local = recall(K_GROUPS) || [];
    h.innerHTML = '<div class="card"><h1>Your groups</h1><ul class="glist" id="gl"><li class="busy">Loading…</li></ul>' +
      '<div class="row"><button class="btn" type="button" id="hStart">Start a group</button><button class="btn ghost" type="button" id="hJoin">Join with a code</button></div></div>' +
      '<div class="card flat"><h2>See how it works</h2><p class="muted small">The Riveras are a made-up family: play their daily round, see their board and last game night.</p><button class="btn ghost block" type="button" id="hEx">Play the example</button></div>';
    $('#hStart').onclick = startGroup;
    $('#hJoin').onclick = joinByCode;
    $('#hEx').onclick = function () { $('#home').hidden = true; openGroup(sampleSource(), 'today'); };
    var seen = {};
    var rows = [];
    var mine = signedIn() ? api('GET', 'api/groups').then(function (r) { return r.groups; }).catch(function () { return []; }) : Promise.resolve([]);
    mine.then(function (acct) {
      acct.forEach(function (g) { seen[g.id] = true; rows.push(g); });
      return Promise.all(local.filter(function (g) { return g && !seen[g.id]; }).map(function (g) {
        return api('GET', 'api/groups/' + g.id).then(function (r) { rows.push({ id: r.group.id, name: r.group.name, members: r.group.members.length, emoji: r.group.members.slice(0, 5).map(function (m) { return m.emoji; }) }); }, function (e) { if (e.status === 404) forgetGroup(g.id); });
      }));
    }).then(function () {
      var el = $('#gl');
      if (!rows.length) { el.innerHTML = '<li class="muted">No groups on this phone yet. Start one, or join with the code someone sent you.</li>'; return; }
      el.innerHTML = rows.map(function (g) { return '<li><a href="' + esc(BASE + 'g/' + g.id) + '"><span style="font-size:1.4rem" aria-hidden="true">' + esc((g.emoji || []).join('')) + '</span><span><b>' + esc(g.name) + '</b><span class="small muted">' + esc(plural(g.members, 'member')) + (g.host ? ' · you host' : '') + '</span></span></a></li>'; }).join('');
    });
  }

  /* ---------------- account (the shared identity) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Account' : 'Sign in';
    b.onclick = function () { if (signedIn()) openSettings(); else openAccount(); };
    $('#groupsBtn').onclick = function () { if (ROUTE.kind === 'home') drawHome(); else location.href = BASE + '?home=1'; };
  }

  var lastFocus = null;
  function sheet(html, onOpen, opts) {
    var s = $('#sheet');
    var back = $('#sheetBack');
    lastFocus = document.activeElement;
    var closable = !(opts && opts.noClose);
    s.innerHTML = (closable ? '<button class="btn small ghost close" type="button" id="sheetClose" aria-label="Close">Close</button>' : '') + html;
    s.hidden = false; back.hidden = false;
    if (closable) $('#sheetClose').onclick = closeSheet;
    back.onclick = closable ? closeSheet : null;
    if (onOpen) onOpen(s);
    var f = s.querySelector('input:not(.vh):not([type=checkbox]):not([type=radio]), textarea') || s.querySelector('button:not(.close)') || $('#sheetClose');
    // Only if nothing in the sheet has focus yet: a fast tap into another
    // field must not have its typing moved.
    setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  var FREE_LINE = 'A free account lets you start a group (everyone you invite joins with no account) and make questions from photos with AI - it comes with $2 of credit. One account works across every app on this site.';

  function openAccount(reason, then) {
    var mode = 'register';
    function draw(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center" style="margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).onclick = function () { mode = mode === 'register' ? 'login' : 'register'; draw(root); };
      $('#authForm', root).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target;
        var btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (then) then(); else if (state.mode === 'group') openGroup(state.src, state.tab); else if (state.mode === 'home') drawHome(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      };
    }
    sheet('<div class="body"></div>', draw);
  }

  function openSettings() {
    var me = state.me;
    var b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(
      '<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread" style="margin:0"><b>AI credit</b><span>' + esc(left) + '</span></div>' +
      '<p class="small muted" style="margin:6px 0 0">Questions from a photo cost about a cent; a “who said it?” round about the same. Playing, the chat stats and writing your own are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); location.reload(); });
        };
        var pk = $('#pkEnrol', root);
        if (pk) pk.onclick = function () {
          var pw = prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        };
      });
  }
  function drawBilling(el) {
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" type="button" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button><p class="small muted">Membership covers every app on this site, runs the better model and lets you add credit.</p>';
        $('#joinM', el).onclick = function () { checkout('api/auth/billing/membership', {}); };
        return;
      }
      el.innerHTML = '<div class="row">' + (b.topUps || []).map(function (t) { return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) { btn.onclick = function () { checkout('api/auth/billing/credit', { usd: Number(btn.getAttribute('data-usd')) }); }; });
    }).catch(function () { el.innerHTML = ''; });
  }
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Playing, the chat stats and writing your own questions keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- start ---------------- */

  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !state.group || isSample()) return;
    if (state.tab === 'live') pollLive();
    pollGroup();
  });

  drawTop();
  loadMe().then(function () {
    if (ROUTE.kind === 'join') return drawJoin();
    if (ROUTE.kind === 'group') {
      return openGroup(apiSource(ROUTE.gid), recall(K_TAB) || 'today').catch(function (e) {
        if (e.status === 404) forgetGroup(ROUTE.gid);
        $('#view').innerHTML = '<div class="card"><h2>This group isn’t here</h2><p class="muted">' + esc(e.message) + ' It may have been deleted, or this phone isn’t in it yet - the invite link or code will let you in.</p><div class="row"><button class="btn" type="button" id="jc">Join with a code</button><a class="btn ghost" href="' + esc(BASE) + '">Home</a></div></div>';
        $('#jc').onclick = joinByCode;
      });
    }
    var local = recall(K_GROUPS) || [];
    if (local.length || /[?&]home=1\b/.test(location.search) || signedIn()) {
      if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
      return drawHome();
    }
    // The first visit: the example family, ready to play.
    return openGroup(sampleSource(), 'today');
  });
})();
