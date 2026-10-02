/* Flight - the page. One file, no build step. Every string that came from
 * outside this file (a typed name or note, a model's reading of a label, a
 * Hopscotch crawl, anything from the server) is escaped before it is drawn,
 * and no handler is written into markup: clicks are routed by data-act
 * attributes from one listener (the lab's CSP allows script from this
 * origin only). The sums are flight-core.js, the same file the server and
 * the tests run.
 *
 * Three ways to be here:
 *   sample - the example crew, the first thing a new visitor sees. Scoring
 *            and voting work, on this phone only; nothing is saved.
 *   crew   - c/<id>: a real crew. Members are this browser (an HttpOnly key)
 *            or a signed-in account that kept its seat.
 *   join   - j/<code>: a name and an emoji, then you're in.
 */
(function () {
  'use strict';

  var C = window.FlightCore;
  var S = window.FlightSample;
  var QR = window.FlightQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_CREWS = 'flight-crews-v1';
  var PHOTO_PX = 1600;
  var POLL_CREW_MS = 6000;
  var POLL_SESSION_MS = 3000;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CREW_ID = (function () { var m = /\/c\/([A-Za-z0-9_-]{16})\/?$/.exec(location.pathname); return m ? m[1] : null; }());
  var JOIN_CODE = (function () { var m = /\/j\/([A-Za-z0-9-]{4,16})\/?$/.exec(location.pathname); return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null; }());

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var state = {
    me: null,            // the account, if any
    mode: CREW_ID ? 'crew' : (JOIN_CODE ? 'join' : 'sample'),
    data: null,          // {crew, sessions, polls, board}
    tab: 'play',
    sid: null,           // the session on screen
    session: null,       // its view
    sample: null,        // the example crew's raw documents
    join: null,
    timers: { crew: null, session: null },
    busy: false,
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
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
    $$('.toast').forEach(function (old) { old.remove(); });
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
  function sample() { return state.mode === 'sample'; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then snap it again. Typing the beer in is free meanwhile.</p><button class="btn small ghost" type="button" data-act="resend">Send the link again</button></div>';
    var b = $('[data-act=resend]', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }

  /* ---------------- crews remembered on this phone ---------------- */

  function rememberCrew(id, name) {
    var list = (recall(K_CREWS) || []).filter(function (c) { return c && c.id !== id; });
    list.unshift({ id: id, name: String(name || '').slice(0, 60) });
    keep(K_CREWS, list.slice(0, 20));
  }
  function forgetCrew(id) { keep(K_CREWS, (recall(K_CREWS) || []).filter(function (c) { return c && c.id !== id; })); }

  /* ---------------- people ---------------- */

  function crew() { return state.data && state.data.crew; }
  function member(id) { var c = crew(); if (!c) return null; for (var i = 0; i < c.members.length; i++) if (c.members[i].id === id) return c.members[i]; return null; }
  function nameOf(id) { var m = member(id); return m ? m.name : 'Someone who left'; }
  function who(id, extra) {
    var m = member(id);
    return '<span class="who' + (extra ? ' ' + extra : '') + '"><span class="em" aria-hidden="true">' + esc(m ? m.emoji : '👤') + '</span>' + esc(m ? m.name : 'Someone who left') + (id === crew().me ? ' <span class="you">you</span>' : '') + '</span>';
  }
  function emojiOf(id) { var m = member(id); return m ? m.emoji : '👤'; }
  function stars(n, label) {
    if (n === null || n === undefined) return '';
    var out = '<span class="stars" role="img" aria-label="' + esc(label || C.starsText(n) + ' out of 5 stars') + '">';
    for (var i = 1; i <= 5; i++) out += '<span class="st ' + (n >= i ? 'full' : n >= i - 0.5 ? 'half' : 'none') + '" aria-hidden="true"></span>';
    return out + '</span>';
  }
  function fmtTime(iso) {
    try { return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); } catch (e) { return iso; }
  }
  function fmtDay(iso) {
    try { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso)); } catch (e) { return ''; }
  }
  function untilText(iso) {
    var ms = Date.parse(iso) - Date.now();
    if (ms <= 0) return 'closed';
    var h = Math.floor(ms / 3600000);
    if (h >= 48) return Math.floor(h / 24) + ' days left';
    if (h >= 1) return h + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm left';
    return Math.max(1, Math.floor(ms / 60000)) + ' min left';
  }

  /* ---------------- the example crew, on this phone ---------------- */

  function sampleIds() { return state.sample.crew.members.map(function (m) { return m.id; }); }
  function sampleBundle() {
    var now = Date.now();
    var sm = state.sample;
    var ids = sampleIds();
    return {
      crew: sm.crew,
      sessions: sm.sessions.map(function (s) { return C.sessionSummary(s, ids, now); }),
      polls: sm.polls.map(function (p) { return C.pollView(p, ids, S.ME, false); }),
      board: C.board(sm.sessions, ids, now),
    };
  }
  function sampleSession(sid) {
    var s = state.sample.sessions.filter(function (x) { return x.id === sid; })[0];
    return s ? C.sessionView(s, sampleIds(), S.ME, false, Date.now()) : null;
  }
  /** The example's writes: the same rules, applied here, never sent. */
  function sampleCall(method, path, body) {
    return new Promise(function (resolve) {
      var now = Date.now();
      var actor = { mid: S.ME, host: false };
      var m = /^api\/crews\/sample\/sessions\/([^/]+)\/(scores|guesses)\/([^/]+)$/.exec(path) || /^api\/crews\/sample\/sessions\/([^/]+)\/(city)$/.exec(path);
      if (m) {
        var s = state.sample.sessions.filter(function (x) { return x.id === m[1]; })[0];
        if (m[2] === 'scores') C.setScore(s, actor, m[3], body, now);
        else if (m[2] === 'guesses') C.setGuess(s, actor, m[3], body.who || null, sampleIds(), now);
        else C.setCity(s, actor, body.city, now);
        return resolve(C.sessionView(s, sampleIds(), S.ME, false, now));
      }
      var p = /^api\/crews\/sample\/polls\/([^/]+)\/(vote|options)$/.exec(path);
      if (p) {
        var poll = state.sample.polls.filter(function (x) { return x.id === p[1]; })[0];
        if (p[2] === 'vote') C.vote(poll, actor, body.options, now);
        else C.addOption(poll, actor, body.text, null, now, { option: function () { return C.shortId('ox'); } });
        return resolve(C.pollView(poll, sampleIds(), S.ME, false));
      }
      throw C.fail(409, 'That’s for your own crew - start one, it’s free.', { code: 'sample' });
    });
  }
  /** Every crew write goes through here: the server for a real crew, the
   *  rules on this phone for the example. */
  function call(method, path, body) {
    if (sample()) {
      return sampleCall(method, path, body).catch(function (e) {
        if (e && e.code === 'sample') openStart(e.message);
        throw e;
      });
    }
    return api(method, path, body);
  }
  function crewPath(rest) { return 'api/crews/' + (sample() ? 'sample' : CREW_ID) + (rest || ''); }

  /* ---------------- loading ---------------- */

  function loadCrew(quiet) {
    if (sample()) { state.data = sampleBundle(); draw(); return Promise.resolve(); }
    var since = state.data ? '?since=' + state.data.crew.v : '';
    return api('GET', crewPath(since)).then(function (d) {
      if (d.same) return;
      state.data = d;
      rememberCrew(d.crew.id, d.crew.name);
      draw();
    }).catch(function (e) {
      if (e.status === 404) {
        forgetCrew(CREW_ID);
        stopPolling();
        state.data = null;
        $('#main').innerHTML = '<section class="card center gone"><div class="big-emoji" aria-hidden="true">🍻</div><h1>This crew isn’t here for you</h1><p class="muted">' + esc(e.message === 'No crew here.' ? 'You may have been signed out, removed, or the crew was deleted. If you have a join code, use it again.' : e.message) + '</p>' +
          (signedIn() ? '' : '<button class="btn" type="button" data-act="signin">Sign in</button> ') + '<a class="btn ghost" href="' + esc(BASE) + '">See the example crew</a></section>';
        return;
      }
      if (!quiet) showError(e);
    });
  }
  function loadSession(quiet) {
    if (!state.sid) return Promise.resolve();
    if (sample()) { state.session = sampleSession(state.sid); drawSession(); return Promise.resolve(); }
    var s = state.session && state.session.id === state.sid ? state.session : null;
    var q = s ? '?since=' + s.v + '&stage=' + s.stage : '';
    return api('GET', crewPath('/sessions/' + state.sid + q)).then(function (d) {
      if (d.same) return;
      var wasOpen = state.session && state.session.id === d.id ? state.session.stage : null;
      state.session = d;
      drawSession();
      if (wasOpen && wasOpen !== 'revealed' && d.stage === 'revealed') celebrate();
    }).catch(function (e) {
      if (e.status === 404 && /session/i.test(e.message)) { state.sid = null; state.session = null; setHash('play'); draw(); return; }
      if (!quiet) showError(e);
    });
  }

  function stopPolling() { clearInterval(state.timers.crew); clearInterval(state.timers.session); state.timers.crew = state.timers.session = null; }
  function startPolling() {
    stopPolling();
    if (sample() || !CREW_ID || document.hidden) return;
    state.timers.crew = setInterval(function () { loadCrew(true); }, POLL_CREW_MS);
    if (state.sid) state.timers.session = setInterval(function () { loadSession(true); }, POLL_SESSION_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return stopPolling();
    if (state.mode === 'crew' && state.data) { loadCrew(true); loadSession(true); startPolling(); }
  });

  /* ---------------- navigation (the hash) ---------------- */

  function setHash(h) { if (location.hash !== '#' + h) history.replaceState(null, '', '#' + h); }
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    var m = /^s\/([A-Za-z0-9]{4,20})$/.exec(h);
    if (m) { state.sid = m[1]; return; }
    state.sid = null; state.session = null;
    state.tab = ['play', 'vote', 'board', 'crew'].indexOf(h) >= 0 ? h : 'play';
  }
  function openSession(sid) {
    state.sid = sid; state.session = null; state.pushed = true;
    history.pushState(null, '', '#s/' + sid);
    draw(); scrollTo(0, 0);
    loadSession().then(startPolling);
  }
  function goTab(t) {
    state.sid = null; state.session = null; state.tab = t;
    history.pushState(null, '', '#' + t);
    draw(); startPolling();
  }
  window.addEventListener('popstate', function () { readHash(); draw(); if (state.sid) loadSession(); startPolling(); });

  /* ---------------- drawing: the shell ---------------- */

  function draw() {
    drawTop();
    if (state.mode === 'join') return drawJoin();
    if (!state.data) return;
    var main = $('#main');
    var c = crew();
    var html = '';
    if (sample()) {
      html += '<section class="strip" aria-label="About this example"><p><b>This is an example crew</b> - try scoring a beer, then start your own.</p>' +
        '<div class="row"><button class="btn big light" type="button" data-act="start">Start a crew</button><button class="btn ghost-light" type="button" data-act="havecode">I have a code</button></div></section>';
    }
    if (!state.sid) html += '<header class="crewhead"><div><p class="eyebrow">' + (sample() ? 'Example crew' : (c.host ? 'Your crew' : 'Crew')) + '</p><h1>' + esc(c.name) + '</h1></div>' +
      '<div class="faces" aria-label="' + esc(plural(c.members.length, 'member')) + '">' + c.members.slice(0, 8).map(function (m) { return '<span class="face" title="' + esc(m.name) + '" aria-hidden="true">' + esc(m.emoji) + '</span>'; }).join('') +
      (c.members.length > 8 ? '<span class="face more">+' + (c.members.length - 8) + '</span>' : '') + '</div></header>';
    var on = state.sid ? 'play' : state.tab;
    html += '<nav class="tabbar dk-tabbar" aria-label="Crew"><div class="tabbar-inner"><a class="rail-brand" href="./"><span aria-hidden="true">🍻</span>' + esc(c.name) + '</a>' + [['play', '🍺', 'Play'], ['vote', '🗳️', 'Vote'], ['board', '🏆', 'Leaderboard'], ['crew', '👥', 'Crew']].map(function (t) {
      return '<button type="button" class="tab' + (on === t[0] ? ' on' : '') + '" data-act="tab" data-tab="' + t[0] + '"' + (on === t[0] ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span>' + t[2] + '</button>';
    }).join('') + '</div></nav>';
    html += state.sid ? '<div id="sessionView"></div>' : '<div id="tabView" class="tabgrid"></div>';
    html += footer();
    main.innerHTML = html;
    if (state.sid) drawSession();
    else ({ play: drawPlay, vote: drawVote, board: drawBoard, crew: drawCrewTab })[state.tab]();
  }
  function footer() {
    return '<footer class="foot small muted"><p class="quiet">Drink responsibly. 21+ where required. Non-alcoholic beers count for everything here.</p>' +
      '<p>Flight is a <a href="' + esc(BASE) + '../">Challenge Lab</a> app. <a href="https://strongtechnicalconsulting.com/privacy">Privacy</a> · members need no account; one account works across every app on this site.</p></footer>';
  }

  /* ---------------- Play: sessions ---------------- */

  function lastRevealed() {
    var list = state.data.sessions.filter(function (s) { return s.stage === 'revealed'; });
    list.sort(function (a, b) { return String(b.revealedAt || (b.window && b.window.closesAt) || b.createdAt).localeCompare(String(a.revealedAt || (a.window && a.window.closesAt) || a.createdAt)); });
    return list[0] || null;
  }
  function stageLine(s) {
    if (s.kind === 'samecan') {
      if (s.stage === 'open') return 'Open · ' + untilText(s.window.closesAt) + ' · ' + plural(s.players, 'person', 'people') + ' in';
      if (s.stage === 'upcoming') return 'Opens ' + fmtTime(s.window.opensAt);
      return 'Closed ' + fmtDay(s.window.closesAt);
    }
    if (s.stage === 'setup') return 'Lining up · ' + plural(s.beers, 'beer') + ' in';
    if (s.stage === 'tasting') return 'Tasting now · ' + plural(s.beers, 'beer') + ' · ' + plural(s.players, 'person', 'people') + ' scoring';
    return 'Revealed ' + fmtDay(s.revealedAt || s.createdAt);
  }
  function sessionCard(s) {
    var icon = s.kind === 'blind' ? '🙈' : (s.mode === 'home' ? '🏡' : '🥫');
    var live = s.stage !== 'revealed';
    return '<button type="button" class="srow' + (live ? ' live' : '') + '" data-act="session" data-sid="' + esc(s.id) + '"><span class="sicon" aria-hidden="true">' + icon + '</span><span class="sbody"><b>' + esc(s.title) + '</b><span class="small muted">' + esc(stageLine(s)) + '</span>' +
      (s.top ? '<span class="small">Top: ' + esc(s.top.name) + ' ' + esc(C.starsText(s.top.half)) + '★</span>' : '') + '</span><span class="chev" aria-hidden="true">›</span></button>';
  }
  function awardChips(awards) {
    return '<ul class="awards">' + awards.map(function (a) {
      return '<li class="award"><span class="aw-emoji" aria-hidden="true">' + esc(a.emoji) + '</span><span><span class="aw-title">' + esc(a.title) + '</span><span class="aw-who">' + esc(C.nameList(a.winners.map(nameOf))) + '</span>' + (a.detail ? '<span class="small muted aw-detail">' + esc(a.detail) + '</span>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  function drawPlay() {
    var el = $('#tabView');
    var d = state.data;
    var open = d.sessions.filter(function (s) { return s.stage !== 'revealed'; });
    var done = d.sessions.filter(function (s) { return s.stage === 'revealed'; });
    var last = lastRevealed();
    var html = '';
    if (last && last.awards && last.awards.length) {
      html += '<section class="card hero-awards"><div class="sec-head"><div><p class="eyebrow">Last time</p><h2>' + esc(last.title) + '</h2></div><button class="btn small ghost" type="button" data-act="session" data-sid="' + esc(last.id) + '">See the reveal</button></div>' +
        (last.top ? '<p class="topbeer"><span aria-hidden="true">🥇</span> <b>' + esc(last.top.name) + '</b> ' + stars(last.top.half) + ' <span class="small muted">' + esc(C.starsText(last.top.half)) + '</span></p>' : '') + awardChips(last.awards) + '</section>';
    }
    html += '<section class="card"><div class="sec-head"><h2>' + (open.length ? 'On now' : 'Play') + '</h2></div>' +
      (open.length ? '<div class="slist">' + open.map(sessionCard).join('') + '</div>' : '<p class="muted">Nothing on right now. Start one:</p>') +
      '<div class="startgrid"><button type="button" class="startbtn" data-act="newsession" data-kind="blind"><span class="si" aria-hidden="true">🙈</span><b>Blind tasting</b><span class="small">Same room. Everyone brings a beer, it gets a letter, nobody knows whose is whose.</span></button>' +
      '<button type="button" class="startbtn" data-act="newsession" data-kind="samecan"><span class="si" aria-hidden="true">🥫</span><b>Same-Can Challenge</b><span class="small">Apart. One beer everyone can find - or a local one each - scored on your own time.</span></button></div></section>';
    if (done.length) html += '<section class="card"><div class="sec-head"><h2>History</h2><span class="small muted">' + plural(done.length, 'session') + '</span></div><div class="slist">' + done.map(sessionCard).join('') + '</div></section>';
    el.innerHTML = html;
  }

  /* ---------------- a session ---------------- */

  function drawSession() {
    var el = $('#sessionView');
    if (!el) return;
    var s = state.session;
    if (!s) { el.innerHTML = '<p class="busy" role="status">Opening…</p>'; return; }
    var html = '<div class="row spread backrow"><button type="button" class="link-btn" data-act="back">← ' + esc(crew().name) + '</button>' +
      (s.canRun ? '<button type="button" class="btn small ghost" data-act="delsession">Delete</button>' : '') + '</div>';
    var kind = s.kind === 'blind' ? 'Blind tasting' : (s.mode === 'home' ? 'Same-Can Challenge · home pours' : 'Same-Can Challenge');
    var apart = s.kind === 'samecan' && s.stage !== 'revealed';
    html += '<section class="card shead"><p class="eyebrow">' + esc(kind) + '</p><h1>' + esc(s.title) + '</h1>' + sessionStatus(s, !apart) + '</section>';
    if (s.stage === 'revealed') html += revealHtml(s);
    else if (s.kind === 'blind' && s.stage === 'setup') html += setupHtml(s);
    else {
      var parts = playHtml(s);
      html += '<div class="scols"><div class="scol">' + parts.main + '</div><div class="scol">' + parts.side + (apart ? '<section class="card"><div class="sec-head"><h2>Who’s in</h2></div>' + progressHtml(s) + '</section>' : '') + '</div></div>';
    }
    el.innerHTML = html;
    var rc = $('#recapText', el);
    if (rc) rc.value = recapText(s);
  }
  function progressHtml(s) {
    return '<ul class="progress" aria-label="Who has finished">' + s.progress.filter(function (p) { return p.of > 0 || s.kind === 'samecan'; }).map(function (p) {
      var fin = p.of && p.done >= p.of;
      return '<li class="' + (fin ? 'fin' : '') + '">' + who(p.member) + '<span class="small">' + (fin ? '✓ done' : p.done + '/' + p.of) + (p.city ? ' · ' + esc(p.city) : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  function sessionStatus(s, withProgress) {
    var done = s.progress.filter(function (p) { return p.of && p.done >= p.of; }).length;
    var line = '';
    if (s.kind === 'samecan') {
      line = s.stage === 'open' ? 'Open until <b>' + esc(fmtTime(s.window.closesAt)) + '</b> your time · ' + esc(untilText(s.window.closesAt)) : s.stage === 'upcoming' ? 'Opens ' + esc(fmtTime(s.window.opensAt)) : 'Closed ' + esc(fmtTime(s.window.closesAt));
    } else if (s.stage === 'setup') line = 'Lining up the beers. Bring yours, then whoever runs it starts the tasting.';
    else if (s.stage === 'tasting') line = 'Tasting. Score each letter blind - the names come out at the reveal.';
    else line = 'Revealed ' + esc(fmtTime(s.revealedAt || (s.window && s.window.closesAt)));
    var html = '<p class="small muted">' + line + '</p>';
    if (s.stage !== 'setup' && s.stage !== 'revealed') {
      if (withProgress) html += progressHtml(s);
      else html += '<p class="small"><b>' + esc(done) + ' of ' + esc(s.progress.length) + '</b> done so far.</p>';
      if (s.canRun) html += '<button type="button" class="btn block" data-act="reveal">Reveal' + (done < s.progress.length ? ' now (' + done + ' of ' + s.progress.length + ' done)' : ' - everyone’s done!') + '</button>';
      else if (s.kind === 'samecan') html += '<p class="small muted">Results show when the window closes, or when ' + esc(s.runner ? nameOf(s.runner) : 'the host') + ' reveals early.</p>';
    }
    return html;
  }

  function beerMeta(b) {
    var bits = [];
    if (b.brewery) bits.push(esc(b.brewery));
    if (b.style) bits.push(esc(C.styleName(b.style)));
    if (b.abv !== null && b.abv !== undefined) bits.push(esc(C.abvText(b.abv)));
    return bits.join(' · ');
  }

  function setupHtml(s) {
    var mine = s.beers.filter(function (b) { return b.mine || b.added; });
    var html = '<section class="card"><div class="sec-head"><h2>The lineup</h2><span class="small muted">' + plural(s.beers.length, 'beer') + ' in · up to ' + C.LIMITS.beers + '</span></div>';
    html += '<p class="small muted">Only you see what you brought. When the tasting starts the beers get shuffled letters, so the order they went in gives nothing away.</p>';
    if (mine.length) html += '<ul class="beerlist">' + mine.map(function (b) {
      return '<li><span class="lbl q" aria-hidden="true">?</span><span><b>' + esc(b.name) + '</b><span class="small muted">' + beerMeta(b) + (b.added && !b.mine ? ' · added for ' + esc(b.broughtBy ? nameOf(b.broughtBy) : 'nobody in the crew') : ' · yours') + '</span></span>' +
        '<span class="row"><button type="button" class="btn small ghost" data-act="editbeer" data-bid="' + esc(b.id) + '">Edit</button><button type="button" class="btn small ghost" data-act="rmbeer" data-bid="' + esc(b.id) + '" aria-label="Take ' + esc(b.name) + ' out">✕</button></span></li>';
    }).join('') + '</ul>';
    var others = s.beers.length - mine.length;
    if (others > 0) html += '<p class="small">' + '🍺'.repeat(Math.min(others, 8)) + ' ' + plural(others, 'more beer') + ' from the crew, hidden.</p>';
    html += '<div class="row"><button type="button" class="btn" data-act="bring">+ Bring a beer</button>' + (s.canRun ? '<button type="button" class="btn ghost" data-act="bringfor">Add one for someone</button>' : '') + '</div>';
    if (s.canRun) html += '<button type="button" class="btn block big" data-act="starttasting"' + (s.beers.length < 2 ? ' disabled' : '') + '>Start the tasting →</button>' + (s.beers.length < 2 ? '<p class="small muted center">At least two beers to start.</p>' : '');
    else html += '<p class="small muted">' + esc(s.runner ? nameOf(s.runner) : 'The host') + ' starts the tasting when everyone’s beer is in.</p>';
    return html + '</section>';
  }

  /** Tasting (blind), or an open Same-Can Challenge. */
  function playHtml(s) {
    var home = s.mode === 'home';
    var html = '';
    var city = '';
    if (s.kind === 'samecan') {
      city = '<section class="card"><label class="field"><span>Where are you tasting it? <span class="muted">(optional - the crew sees it)</span></span><div class="addrow"><input class="input" id="cityIn" maxlength="' + C.LIMITS.city + '" placeholder="e.g. Denver" value="' + esc(s.mine.city) + '" autocomplete="address-level2"><button type="button" class="btn ghost" data-act="savecity">Save</button></div></label></section>';
    }
    if (home) {
      var mineBeer = s.beers.filter(function (b) { return b.mine; })[0];
      html += '<section class="card"><div class="sec-head"><h2>Your pour</h2></div>' + (mineBeer ?
        '<div class="beer mine"><span class="lbl">' + esc(mineBeer.label) + '</span><span class="bbody"><b>' + esc(mineBeer.name) + '</b><span class="small muted">' + beerMeta(mineBeer) + '</span>' + myScoreLine(s, mineBeer) + '</span><span class="col"><button type="button" class="btn small" data-act="score" data-bid="' + esc(mineBeer.id) + '">' + (s.mine.scores[mineBeer.id] ? 'Edit score' : 'Score it') + '</button><button type="button" class="btn small ghost" data-act="editbeer" data-bid="' + esc(mineBeer.id) + '">Edit beer</button></span></div>'
        : '<p class="muted">Pick something local - from your town’s brewery if you can. The crew sees your tasting notes and city, and guesses its style before the reveal.</p><button type="button" class="btn" data-act="bring">+ Pour yours</button>') + '</section>';
      var others = s.beers.filter(function (b) { return !b.mine; });
      html += '<section class="card"><div class="sec-head"><h2>Guess their pours</h2><span class="small muted">style and ABV, from the clues</span></div>' + (others.length ? '<div class="beers">' + others.map(function (b) {
        var cl = b.clues || { chips: [], note: '' };
        return '<button type="button" class="beer" data-act="score" data-bid="' + esc(b.id) + '"><span class="lbl">' + esc(b.label) + '</span><span class="bbody"><b>' + esc(nameOf(b.poured)) + '’s pour</b><span class="small muted">' + (b.city ? 'in ' + esc(b.city) + ' · ' : '') + (cl.chips.length ? esc(cl.chips.join(', ')) : 'no notes yet') + '</span>' + (cl.note ? '<span class="small quote">“' + esc(cl.note) + '”</span>' : '') + myScoreLine(s, b) + '</span><span class="chev" aria-hidden="true">›</span></button>';
      }).join('') + '</div>' : '<p class="muted">Nobody else has poured yet.</p>') + '</section>';
      return { main: html, side: city };
    }
    html += '<section class="card"><div class="sec-head"><h2>' + (s.kind === 'blind' ? 'Score them blind' : 'Score it') + '</h2>' + (s.kind === 'blind' ? '<span class="small muted">tap a letter</span>' : '') + '</div><div class="beers">' + s.beers.map(function (b) {
      if (b.mine) return '<div class="beer mine"><span class="lbl">' + esc(b.label) + '</span><span class="bbody"><b>Yours: ' + esc(b.name) + '</b><span class="small muted">Pour it as ' + esc(b.label) + ' - and sit this one out.</span></span></div>';
      var title = s.kind === 'blind' ? 'Beer ' + esc(b.label) : esc(b.name);
      var sub = s.kind === 'blind' ? (b.added ? 'You added this one - your stars count, your guesses don’t.' : 'Mystery beer') : esc(b.brewery || '') + (b.added ? ' · you picked it, so your guesses won’t score' : '');
      return '<button type="button" class="beer" data-act="score" data-bid="' + esc(b.id) + '"><span class="lbl">' + esc(b.label) + '</span><span class="bbody"><b>' + title + '</b><span class="small muted">' + sub + '</span>' + myScoreLine(s, b) + '</span><span class="chev" aria-hidden="true">›</span></button>';
    }).join('') + '</div></section>';
    var side = city;
    if (s.kind === 'blind' && s.bringers.length) {
      side += '<section class="card"><div class="sec-head"><h2>Guess who brought it</h2><span class="small muted">' + POINTS_TEXT.who + '</span></div><p class="small muted">Brought tonight: ' + s.bringers.map(function (m) { return esc(emojiOf(m) + ' ' + nameOf(m)); }).join(', ') + '</p>' +
        '<div class="guessgrid">' + s.beers.filter(function (b) { return !b.mine && !b.added; }).map(function (b) {
          var g = s.mine.guesses[b.id] || '';
          return '<label class="guess"><span class="lbl sm">' + esc(b.label) + '</span><select class="input" data-act="guess" data-bid="' + esc(b.id) + '" aria-label="Who brought beer ' + esc(b.label) + '?"><option value="">Who brought ' + esc(b.label) + '?</option>' +
            s.bringers.filter(function (m) { return m !== crew().me; }).map(function (m) { return '<option value="' + esc(m) + '"' + (g === m ? ' selected' : '') + '>' + esc(emojiOf(m) + ' ' + nameOf(m)) + '</option>'; }).join('') + '</select></label>';
        }).join('') + '</div></section>';
    }
    return { main: html, side: side };
  }
  var POINTS_TEXT = { who: C.POINTS.whoBrought + ' points each' };
  function myScoreLine(s, b) {
    var sc = s.mine.scores[b.id];
    if (!sc) return '';
    var bits = [];
    if (sc.stars !== null && sc.stars !== undefined) bits.push(stars(sc.stars) + ' ' + esc(C.starsText(sc.stars)));
    if (sc.style) bits.push(esc(C.styleName(sc.style)));
    if (sc.abv !== null && sc.abv !== undefined) bits.push(esc(C.abvText(sc.abv)));
    return '<span class="mine-line small">✓ ' + bits.join(' · ') + '</span>';
  }

  function revealHtml(s) {
    var r = s.results;
    var me = crew().me;
    var byId = {};
    r.beers.forEach(function (b) { byId[b.id] = b; });
    var order = r.ranked.concat(r.beers.filter(function (b) { return r.ranked.indexOf(b.id) < 0; }).map(function (b) { return b.id; }));
    var html = '';
    if (r.awards.length) html += '<section class="card hero-awards"><div class="sec-head"><h2>Awards</h2></div>' + awardChips(r.awards) + '</section>';
    var right = '';
    var mine = r.members[me];
    if (mine) {
      right += '<section class="card mypts"><div class="sec-head"><h2>Your night</h2><span class="pts">' + esc(mine.points) + ' pts</span></div><p class="small">' +
        [mine.stylePts + ' style point' + (mine.stylePts === 1 ? '' : 's'), plural(mine.abvWins, 'ABV win'), s.kind === 'blind' ? mine.whoRight + ' right on who brought it' : '', mine.awards.length ? plural(mine.awards.length, 'award') : ''].filter(Boolean).map(esc).join(' · ') + '</p></section>';
    }
    html += '<div class="scols reveal-cols"><div class="scol"><section class="card"><div class="sec-head"><h2>The reveal</h2><span class="small muted">crowd score, best first</span></div><ol class="reveal">';
    order.forEach(function (id, i) {
      var b = byId[id];
      html += '<li class="rbeer"><details' + (i === 0 ? ' open' : '') + '><summary><span class="rank">' + (i + 1) + '</span><span class="lbl">' + esc(b.label || '') + '</span><span class="bbody"><b>' + esc(b.name) + '</b><span class="small muted">' + beerMeta(b) + '</span>' +
        (b.broughtBy ? '<span class="small">' + (s.mode === 'home' ? 'Poured by ' : 'Brought by ') + who(b.broughtBy) + '</span>' : '') + '</span><span class="crowd">' + (b.crowd.n ? stars(b.crowd.half, 'Crowd score ' + C.starsText(b.crowd.half) + ' stars') + '<b>' + esc(C.starsText(b.crowd.half)) + '</b><span class="small muted">' + plural(b.crowd.n, 'score') + '</span>' : '<span class="small muted">no stars</span>') + '</span></summary>';
      html += '<div class="rdetail">';
      if (b.abv !== null && b.abv !== undefined && b.abvWinners.length) html += '<p class="small">🎯 Closest on ABV: ' + esc(C.nameList(b.abvWinners.map(nameOf))) + ' (' + (b.abvBest === 0 ? 'spot on' : 'off by ' + esc(b.abvBest.toFixed(1))) + ')</p>';
      var right = b.who.filter(function (w) { return w.right; });
      if (s.kind === 'blind' && b.who.length) html += '<p class="small">🕵️ ' + (right.length ? esc(C.nameList(right.map(function (w) { return nameOf(w.member); }))) + ' guessed who brought it' : 'Nobody guessed who brought it') + ' (' + plural(b.who.length, 'guess', 'guesses') + ')</p>';
      html += '<ul class="scores">' + b.scores.map(function (sc) {
        var hit = b.styleHits.filter(function (h) { return h.member === sc.member; })[0];
        return '<li>' + who(sc.member) + '<span class="sline">' + (sc.stars !== null && sc.stars !== undefined ? stars(sc.stars) + ' ' : '') +
          (sc.style ? '<span class="tag' + (hit && hit.pts === C.POINTS.styleExact ? ' good' : hit && hit.pts ? ' ok' : '') + '">' + esc(C.styleName(sc.style)) + (hit && hit.pts ? ' +' + hit.pts : '') + '</span>' : '') +
          (sc.abv !== null && sc.abv !== undefined ? '<span class="tag' + (b.abvWinners.indexOf(sc.member) >= 0 ? ' good' : '') + '">' + esc(C.abvText(sc.abv)) + '</span>' : '') +
          sc.chips.map(function (c) { return '<span class="chip-s">' + esc(c) + '</span>'; }).join('') + '</span>' + (sc.note ? '<span class="small quote">“' + esc(sc.note) + '”</span>' : '') + '</li>';
      }).join('') + '</ul></div></details></li>';
    });
    html += '</ol></section></div><div class="scol">' + right;
    if (s.kind === 'samecan') {
      var cities = s.progress.filter(function (p) { return p.city; });
      if (cities.length) html += '<section class="card"><div class="sec-head"><h2>Tasted from</h2></div><ul class="cities">' + cities.map(function (p) { return '<li>' + who(p.member) + '<span>📍 ' + esc(p.city) + '</span></li>'; }).join('') + '</ul></section>';
    }
    html += '<section class="card"><div class="sec-head"><h2>Recap for the group chat</h2></div><textarea class="input recap" id="recapText" rows="8" readonly aria-label="Recap text"></textarea><div class="row"><button type="button" class="btn" data-act="sharerecap">Share</button><button type="button" class="btn ghost" data-act="copyrecap">Copy</button></div></section></div></div>';
    return html;
  }
  function recapText(s) {
    var cities = {};
    s.progress.forEach(function (p) { if (p.city) cities[p.member] = p.city; });
    return C.recap(crew().name, { title: s.title, kind: s.kind, mode: s.mode, cities: cities }, s.results, nameOf) + (sample() ? '' : '\n— scored on Flight');
  }
  function celebrate() {
    toast('🍻 The reveal is in!', 3000);
    if (REDUCED) return;
    var box = document.createElement('div');
    box.className = 'burst'; box.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 16; i++) { var sp = document.createElement('span'); sp.textContent = ['🍻', '🏆', '⭐', '🎯'][i % 4]; sp.style.setProperty('--x', (Math.random() * 100) + 'vw'); sp.style.setProperty('--d', (Math.random() * 0.6) + 's'); box.appendChild(sp); }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 2400);
  }

  /* ---------------- scoring sheet ---------------- */

  function styleSelect(id, value, placeholder) {
    return '<select class="input" id="' + id + '"><option value="">' + esc(placeholder) + '</option>' + C.FAMILIES.map(function (f) {
      return '<optgroup label="' + esc(f.name) + '">' + C.STYLES.filter(function (s) { return s.family === f.id; }).map(function (s) { return '<option value="' + esc(s.id) + '"' + (value === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</optgroup>';
    }).join('') + '<option value="other"' + (value === 'other' ? ' selected' : '') + '>Something else</option></select>';
  }
  function starPicker(v) {
    var out = '<div class="starpick" role="radiogroup" aria-label="Overall, out of 5 stars">';
    for (var i = 1; i <= 5; i++) out += '<button type="button" class="sp ' + (v >= i ? 'full' : v >= i - 0.5 ? 'half' : 'none') + '" data-act="star" data-n="' + i + '" role="radio" aria-checked="' + (v === i || v === i - 0.5) + '" aria-label="' + i + ' star' + (i === 1 ? '' : 's') + '"></button>';
    return out + '<output class="spv" id="starsOut">' + (v ? esc(C.starsText(v)) + ' ★' : 'Tap a star') + '</output></div><p class="small muted">Tap a star again for a half.</p>';
  }
  function openScore(bid) {
    var s = state.session;
    var b = s.beers.filter(function (x) { return x.id === bid; })[0];
    if (!b) return;
    var home = s.mode === 'home';
    var own = home && b.mine;
    var sc = s.mine.scores[bid] || {};
    var draft = { stars: sc.stars || null, chips: (sc.chips || []).slice() };
    var guessOnly = home && !own;
    var title = s.kind === 'blind' ? 'Beer ' + b.label : (home ? (own ? 'Your pour' : nameOf(b.poured) + '’s pour') : b.name);
    var idx = s.beers.indexOf(b);
    sheet('<h2>' + esc(title) + '</h2>' + (s.kind === 'blind' ? '<p class="small muted">Blind - judge what’s in the glass.</p>' : '') +
      (guessOnly ? '<p class="small muted">' + (b.clues && b.clues.chips.length ? 'Their notes: ' + esc(b.clues.chips.join(', ')) : 'No notes yet.') + (b.clues && b.clues.note ? ' · “' + esc(b.clues.note) + '”' : '') + '</p>' : '') +
      '<form id="scoreForm" class="stack">' +
      (guessOnly ? '' : '<div class="field"><span>Overall</span>' + starPicker(draft.stars) + '</div>') +
      (own ? '' : '<label class="field"><span>Style guess <span class="muted">(exact ' + C.POINTS.styleExact + ' pts, same family ' + C.POINTS.styleFamily + ')</span></span>' + styleSelect('scStyle', sc.style || '', 'Pick a style') + '</label>' +
        '<label class="field"><span>ABV guess <span class="muted">(closest wins ' + C.POINTS.abvClosest + ' pts)</span></span><div class="abvrow"><button type="button" class="btn ghost sq" data-act="abvstep" data-d="-0.5" aria-label="Half a percent less">−</button><input class="input" id="scAbv" inputmode="decimal" placeholder="e.g. 6.5" value="' + esc(sc.abv !== null && sc.abv !== undefined ? sc.abv : '') + '" aria-label="ABV guess, percent"><span class="pct">%</span><button type="button" class="btn ghost sq" data-act="abvstep" data-d="0.5" aria-label="Half a percent more">+</button></div></label>') +
      (guessOnly ? '' : '<div class="field"><span>Tasting notes</span><div class="chips" id="chipBox">' + C.CHIPS.map(function (c) { return '<button type="button" class="chip" data-act="chip" data-chip="' + esc(c) + '" aria-pressed="' + (draft.chips.indexOf(c) >= 0) + '">' + esc(c) + '</button>'; }).join('') + '</div></div>' +
        '<label class="field"><span>A note <span class="muted">(optional · the crew sees it after the reveal)</span></span><input class="input" id="scNote" maxlength="' + C.LIMITS.note + '" value="' + esc(sc.note || '') + '" placeholder="Pine, mango, a bit sticky…"></label>') +
      '<div id="scErr"></div><div class="row"><button class="btn big grow" type="submit">' + (idx < s.beers.length - 1 && s.kind === 'blind' ? 'Save · next beer →' : 'Save') + '</button></div></form>',
      function (root) {
        root.__draft = draft;
        $('#scoreForm', root).addEventListener('submit', function (e) {
          e.preventDefault();
          var btn = $('button[type=submit]', root); btn.disabled = true;
          var body = { stars: draft.stars, chips: draft.chips, note: $('#scNote', root) ? $('#scNote', root).value : '' };
          if ($('#scStyle', root)) body.style = $('#scStyle', root).value || null;
          if ($('#scAbv', root)) body.abv = $('#scAbv', root).value.trim() === '' ? null : $('#scAbv', root).value;
          if (body.abv !== null && body.abv !== undefined && C.cleanAbv(body.abv) === null) { btn.disabled = false; return showError(new Error('ABV is a number from 0 to 20, like 6.5.'), $('#scErr', root)); }
          call('PUT', crewPath('/sessions/' + s.id + '/scores/' + bid), body).then(function (v) {
            state.session = v; drawSession();
            var next = null;
            if (s.kind === 'blind') for (var i = idx + 1; i < v.beers.length; i++) if (!v.beers[i].mine && !v.mine.scores[v.beers[i].id]) { next = v.beers[i].id; break; }
            closeSheet();
            if (next) openScore(next);
            else toast(sample() ? 'Scored - in the example it stays on this phone.' : 'Saved');
          }).catch(function (err) { btn.disabled = false; showError(err, $('#scErr', root)); });
        });
      });
  }

  /* ---------------- bring a beer (with Snap the label) ---------------- */

  function openBring(opts) {
    opts = opts || {};
    var s = state.session;
    var b = opts.beer || {};
    var forSomeone = opts.forSomeone;
    var home = s.mode === 'home';
    sheet('<h2>' + (opts.beer ? 'Edit the beer' : home ? 'Pour yours' : forSomeone ? 'Add a beer for someone' : 'Bring a beer') + '</h2>' +
      '<p class="small muted">' + (home ? 'The crew sees its name, style and ABV at the reveal.' : 'Only you' + (forSomeone ? ' and whoever brought it' : '') + ' see this until the reveal.') + '</p>' +
      '<div class="snapbox" id="snapBox"><button type="button" class="btn ghost block" data-act="snap"><span aria-hidden="true">📷</span> Snap the label</button><input type="file" accept="image/*" capture="environment" id="snapFile" class="vh" tabindex="-1" aria-hidden="true"><p class="small muted">Reads the name, brewery, style and ABV - you check it before it’s saved. Uses a cent or two of AI credit (free account).</p><div id="snapOut" aria-live="polite"></div></div>' +
      '<form id="beerForm" class="stack">' +
      '<label class="field"><span>Name</span><input class="input" id="bName" maxlength="' + C.LIMITS.beerName + '" required value="' + esc(b.name || '') + '" placeholder="Fog Lantern"></label>' +
      '<label class="field"><span>Brewery</span><input class="input" id="bBrewery" maxlength="' + C.LIMITS.brewery + '" value="' + esc(b.brewery || '') + '" placeholder="Tidewater Brewing"></label>' +
      '<label class="field"><span>Style</span>' + styleSelect('bStyle', b.style || '', 'Not sure') + '</label>' +
      '<label class="field"><span>ABV %</span><input class="input" id="bAbv" inputmode="decimal" value="' + esc(b.abv !== null && b.abv !== undefined ? b.abv : '') + '" placeholder="As printed on the can"></label>' +
      (forSomeone ? '<label class="field"><span>Who brought it?</span><select class="input" id="bBy"><option value="">Nobody in the crew (a house pick)</option>' + crew().members.filter(function (m) { return m.id !== crew().me; }).map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.emoji + ' ' + m.name) + '</option>'; }).join('') + '</select></label>' : '') +
      '<div id="bErr"></div><button class="btn block big" type="submit">' + (opts.beer ? 'Save' : home ? 'Pour it' : 'Add it') + '</button></form>',
      function (root) {
        $('#snapFile', root).addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) snapLabel(f, root); e.target.value = ''; });
        $('#beerForm', root).addEventListener('submit', function (e) {
          e.preventDefault();
          var body = { name: $('#bName', root).value, brewery: $('#bBrewery', root).value, style: $('#bStyle', root).value || null, abv: $('#bAbv', root).value.trim() || null };
          if (body.abv !== null && C.cleanAbv(body.abv) === null) return showError(new Error('ABV is a number from 0 to 20, like 6.8.'), $('#bErr', root));
          if (forSomeone) body.broughtBy = $('#bBy', root).value || null;
          var btn = $('button[type=submit]', root); btn.disabled = true;
          var p = opts.beer ? call('PATCH', crewPath('/sessions/' + s.id + '/beers/' + opts.beer.id), body) : call('POST', crewPath('/sessions/' + s.id + '/beers'), body);
          p.then(function (v) {
            state.session = v; closeSheet(); drawSession();
            toast(opts.beer ? 'Saved' : home ? 'Poured. Now score it.' : 'In the lineup - it stays secret.');
            if (home && !opts.beer) { var mb = v.beers.filter(function (x) { return x.mine; })[0]; if (mb) openScore(mb.id); }
          }).catch(function (err) { btn.disabled = false; showError(err, $('#bErr', root)); });
        });
      });
  }

  /** A photo shrunk to ~1600px on its long side, as a JPEG. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, PHOTO_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var dataUrl = c.toDataURL('image/jpeg', 0.85);
        URL.revokeObjectURL(url);
        resolve({ type: 'image/jpeg', data: dataUrl.split(',')[1] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be opened.')); };
      img.src = url;
    });
  }
  function snapLabel(file, root) {
    var out = $('#snapOut', root);
    out.innerHTML = '<p class="busy" role="status">Reading the label…</p>';
    shrink(file).then(function (p) { return api('POST', 'api/snap', { photo: p }); }).then(function (r) {
      var l = r.label;
      $('#bName', root).value = l.name;
      $('#bBrewery', root).value = l.brewery || '';
      $('#bStyle', root).value = l.style && l.style !== 'other' ? l.style : (l.style === 'other' ? 'other' : '');
      $('#bAbv', root).value = l.abv !== null ? l.abv : '';
      out.innerHTML = '<div class="note review"><p><b>Check it against the can</b> - nothing is saved until you press ' + (state.session.mode === 'home' ? 'Pour it' : 'Add it') + '.</p><p class="small">' +
        (l.abv === null ? '⚠︎ No ABV printed that could be read - add it if you know it. ' : '') +
        (l.stylePrinted ? 'Label says “' + esc(l.stylePrinted) + '”. ' : '') + 'Confidence: ' + esc(l.confidence) + '.</p></div>';
    }).catch(function (e) {
      if (e.status === 401) { out.innerHTML = ''; return openAccount('Snapping a label uses a cent or two of AI credit, so it needs a free account (it comes with $2). Typing the beer in is free.'); }
      if (e.status === 402) { out.innerHTML = ''; return openCredit(e.data); }
      if (e.data && e.data.code === 'verify-email') return verifyNote(out, e);
      showError(e, out);
    });
  }

  /* ---------------- start things ---------------- */

  function openNewSession(kind) {
    if (sample()) return openStart('Running a tasting is for your own crew - start one, it’s free.');
    var blind = kind === 'blind';
    sheet('<h2>' + (blind ? 'A blind tasting' : 'A Same-Can Challenge') + '</h2>' +
      '<p class="small muted">' + (blind ? 'For the same room. Everyone brings a beer on their phone; when you start, the beers get shuffled letters. Score blind, guess who brought what, then reveal.' : 'For a crew that’s apart. Everyone scores on their own time before the window closes; the results come out when it does.') + '</p>' +
      '<form id="nsForm" class="stack"><label class="field"><span>Call it</span><input class="input" id="nsTitle" maxlength="' + C.LIMITS.title + '" placeholder="' + (blind ? 'Hazy vs West Coast' : 'Pils weekend') + '"></label>' +
      (blind ? '' :
        '<div class="field"><span>The beer</span><div class="seg" role="radiogroup"><button type="button" class="segb" role="radio" aria-checked="true" data-act="nsmode" data-mode="same">Same can for everyone</button><button type="button" class="segb" role="radio" aria-checked="false" data-act="nsmode" data-mode="home">A local one each</button></div></div>' +
        '<div id="nsSame"><label class="field"><span>Which beer? <span class="muted">(shown to the crew - its style and ABV stay hidden)</span></span><input class="input" id="nsBeer" maxlength="' + C.LIMITS.beerName + '" placeholder="Something everyone can find"></label>' +
        '<label class="field"><span>Brewery</span><input class="input" id="nsBrewery" maxlength="' + C.LIMITS.brewery + '"></label>' +
        '<details class="field"><summary class="small">Its style and ABV (for scoring - you’ll be the one who knows)</summary>' + styleSelect('nsStyle', '', 'Not sure yet') + '<input class="input" id="nsAbv" inputmode="decimal" placeholder="ABV %" style="margin-top:8px"></details></div>' +
        '<div class="field"><span>Window</span><div class="seg" role="radiogroup"><button type="button" class="segb" role="radio" aria-checked="true" data-act="nswin" data-win="weekend">This weekend</button><button type="button" class="segb" role="radio" aria-checked="false" data-act="nswin" data-win="week">A week</button><button type="button" class="segb" role="radio" aria-checked="false" data-act="nswin" data-win="custom">Pick</button></div><input class="input" type="datetime-local" id="nsClose" hidden aria-label="Closes at"><p class="small muted" id="nsWinText"></p></div>') +
      '<div id="nsErr"></div><button class="btn block big" type="submit">Start it</button></form>',
      function (root) {
        var mode = 'same', win = 'weekend';
        function winNow() {
          var now = Date.now();
          if (win === 'weekend') return C.weekendWindow(now, -new Date().getTimezoneOffset());
          if (win === 'week') return { opensAt: new Date(now).toISOString(), closesAt: new Date(now + 7 * 86400000).toISOString() };
          var v = $('#nsClose', root).value;
          return { opensAt: new Date(now).toISOString(), closesAt: v ? new Date(v).toISOString() : null };
        }
        function winText() { var w = winNow(); var t = $('#nsWinText', root); if (t) t.textContent = w.closesAt ? 'Closes ' + fmtTime(w.closesAt) + ' your time (' + untilText(w.closesAt) + ').' : 'Pick when it closes.'; }
        root.__nsMode = function (m) { mode = m; $$('[data-act=nsmode]', root).forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-mode') === m)); }); $('#nsSame', root).hidden = m !== 'same'; };
        root.__nsWin = function (w) { win = w; $$('[data-act=nswin]', root).forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-win') === w)); }); $('#nsClose', root).hidden = w !== 'custom'; winText(); };
        if (!blind) { winText(); $('#nsClose', root).addEventListener('input', winText); }
        $('#nsForm', root).addEventListener('submit', function (e) {
          e.preventDefault();
          var body = { kind: kind, title: $('#nsTitle', root).value };
          if (!blind) {
            body.mode = mode; body.window = winNow();
            if (mode === 'same') body.beer = { name: $('#nsBeer', root).value, brewery: $('#nsBrewery', root).value, style: $('#nsStyle', root).value || null, abv: $('#nsAbv', root).value || null };
          }
          var btn = $('button[type=submit]', root); btn.disabled = true;
          api('POST', crewPath('/sessions'), body).then(function (v) {
            closeSheet();
            state.session = v; state.sid = v.id;
            history.pushState(null, '', '#s/' + v.id);
            draw(); startPolling(); scrollTo(0, 0);
            if (blind) toast('Now everyone brings a beer from their phone.', 3200);
          }).catch(function (err) { btn.disabled = false; showError(err, $('#nsErr', root)); });
        });
      });
  }

  /* ---------------- Vote ---------------- */

  function drawVote() {
    var el = $('#tabView');
    var polls = state.data.polls;
    var html = '<section class="card full"><div class="sec-head"><h2>Vote on the next one</h2><button type="button" class="btn small" data-act="newpoll">+ New vote</button></div><p class="small muted">Tick every option you’d be happy with - the most ticks wins. Paste a Hopscotch crawl link as an option and it shows the crawl.</p></section>';
    if (!polls.length) html += '<section class="card center full"><p class="muted">No votes yet. Where next? Which brewery? Which Saturday?</p></section>';
    polls.forEach(function (p) { html += pollCard(p); });
    el.innerHTML = html;
  }
  function crawlBox(c) {
    if (!c) return '';
    return '<span class="crawl"><span class="small"><b>🗺️ Hopscotch crawl</b>' + (c.place ? ' · ' + esc(c.place) : '') + (c.miles !== null && c.miles !== undefined ? ' · ' + esc(c.miles) + ' mi' : '') + ' · ' + plural(c.stops.length, 'stop') + '</span>' +
      '<span class="small muted">' + esc(c.stops.join(' → ')) + '</span>' + (c.url && /^https:\/\//.test(c.url) ? '<a class="small" href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer">Open in Hopscotch ↗</a>' : '') + '</span>';
  }
  function pollCard(p) {
    var r = p.results;
    var html = '<section class="card poll" data-pid="' + esc(p.id) + '"><div class="sec-head"><h2>' + esc(p.question) + '</h2>' + (p.closed ? '<span class="badge">Closed</span>' : '<span class="small muted">' + plural(p.voters, 'vote') + '</span>') + '</div>';
    if (r) {
      var max = Math.max.apply(null, r.rows.map(function (x) { return x.n; }).concat([1]));
      var opt = {};
      p.options.forEach(function (o) { opt[o.id] = o; });
      html += '<ul class="results">' + r.rows.map(function (row) {
        var o = opt[row.id];
        var win = r.winner === row.id;
        return '<li class="' + (win ? 'win' : '') + '"><div class="rtop"><span class="otext">' + (win ? '🏆 ' : '') + esc(o.text) + (p.myVote.indexOf(o.id) >= 0 ? ' <span class="you">your pick</span>' : '') + '</span><b>' + row.n + '</b></div>' + crawlBox(o.crawl) +
          '<div class="bar" aria-hidden="true"><span style="width:' + Math.round(row.n / max * 100) + '%"></span></div><span class="small muted">' + row.voters.map(function (m) { return esc(emojiOf(m) + ' ' + nameOf(m)); }).join(', ') + '</span>' +
          (!p.closed && (o.mine || p.canRun) ? '<button type="button" class="link-btn small" data-act="rmoption" data-pid="' + esc(p.id) + '" data-oid="' + esc(o.id) + '">Remove</button>' : '') + '</li>';
      }).join('') + '</ul>';
      if (r.tie && !p.closed) html += '<p class="small"><b>It’s a tie</b> between ' + r.leaders.map(function (id) { return esc(opt[id].text); }).join(' and ') + '.' + (p.canRun ? ' Close the vote and pick one.' : '') + '</p>';
    }
    if (!p.closed && p.voted && state.editPoll !== p.id) html += '<button type="button" class="btn small ghost" data-act="editvote" data-pid="' + esc(p.id) + '">Change my vote</button>';
    else if (!p.closed) {
      html += '<form class="voteform" data-pid="' + esc(p.id) + '"><fieldset><legend class="vh">Your picks</legend>' + p.options.map(function (o) {
        return '<label class="opt"><input type="checkbox" value="' + esc(o.id) + '"' + (p.myVote.indexOf(o.id) >= 0 ? ' checked' : '') + '><span><span class="otext">' + esc(o.text) + '</span>' + crawlBox(o.crawl) + '</span></label>';
      }).join('') + '</fieldset>' + (p.options.length ? '<button class="btn" type="submit">' + (p.voted ? 'Change my vote' : 'Vote') + '</button>' : '') + (!p.voted && p.options.length ? '<p class="small muted">Results show once you vote.</p>' : '') + '</form>';
    }
    if (!p.closed) {
      html += '<form class="addopt" data-pid="' + esc(p.id) + '"><input class="input" maxlength="300" placeholder="Add an option, or paste a Hopscotch crawl link" aria-label="Add an option"><button class="btn ghost" type="submit">Add</button></form>';
      if (p.canRun) html += '<div class="row"><button type="button" class="btn small ghost" data-act="closepoll" data-pid="' + esc(p.id) + '">Close the vote</button><button type="button" class="btn small ghost" data-act="delpoll" data-pid="' + esc(p.id) + '">Delete</button></div>';
    } else if (p.canRun) html += '<div class="row"><button type="button" class="btn small ghost" data-act="delpoll" data-pid="' + esc(p.id) + '">Delete</button></div>';
    return html + '</section>';
  }
  function replacePoll(v) {
    if (state.editPoll === v.id) state.editPoll = null;
    state.data.polls = state.data.polls.map(function (p) { return p.id === v.id ? v : p; });
    if (!state.sid && state.tab === 'vote') drawVote();
  }
  function openNewPoll() {
    if (sample()) return openStart('Starting a vote is for your own crew - start one, it’s free.');
    sheet('<h2>A new vote</h2><form id="npForm" class="stack"><label class="field"><span>The question</span><input class="input" id="npQ" maxlength="' + C.LIMITS.pollQuestion + '" required placeholder="Where do we go next month?"></label>' +
      '<div class="field"><span>Options <span class="muted">(anyone can add more later)</span></span><div class="stack" id="npOpts">' + [0, 1, 2].map(function (i) { return '<input class="input" maxlength="300" placeholder="' + (i === 1 ? 'or paste a Hopscotch crawl link' : 'Option ' + (i + 1)) + '" aria-label="Option ' + (i + 1) + '">'; }).join('') + '</div><button type="button" class="link-btn small" data-act="npmore">+ another option</button></div>' +
      '<div id="npErr"></div><button class="btn block big" type="submit">Start the vote</button></form>', function (root) {
      $('#npForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var opts = $$('#npOpts input', root).map(function (i) { return i.value.trim(); }).filter(Boolean);
        var btn = $('button[type=submit]', root); btn.disabled = true; btn.textContent = 'Starting…';
        api('POST', crewPath('/polls'), { question: $('#npQ', root).value, options: opts }).then(function (v) {
          closeSheet(); state.data.polls.unshift(v); state.tab = 'vote'; setHash('vote'); draw();
        }).catch(function (err) { btn.disabled = false; btn.textContent = 'Start the vote'; showError(err, $('#npErr', root)); });
      });
    });
  }

  /* ---------------- Leaderboard ---------------- */

  function drawBoard() {
    var el = $('#tabView');
    var b = state.data.board;
    var html = '<section class="card"><div class="sec-head"><h2>Crew leaderboard</h2><span class="small muted">' + plural(b.sessions, 'session') + '</span></div>';
    if (!b.sessions) html += '<p class="muted">Points arrive with the first reveal: style guesses (' + C.POINTS.styleExact + ' exact, ' + C.POINTS.styleFamily + ' same family), closest ABV (' + C.POINTS.abvClosest + '), who brought it (' + C.POINTS.whoBrought + ') and every award (' + C.POINTS.award + ').</p>';
    else {
      html += '<ol class="board">' + b.rows.map(function (r, i) {
        var top = r.profile[0];
        return '<li><details><summary><span class="rank' + (i < 3 ? ' r' + (i + 1) : '') + '">' + (i + 1) + '</span>' + who(r.member) + '<span class="bpts"><b>' + esc(r.points) + '</b><span class="small muted">pts</span></span></summary>' +
          '<div class="bdetail"><p class="small">' + [r.stylePts + ' style pts', plural(r.abvWins, 'ABV win'), r.whoRight + ' right on who brought it', plural(r.awards, 'award')].map(esc).join(' · ') + '</p>' +
          '<p class="small">' + (r.streak > 1 ? '🔥 ' + esc(r.streak) + ' sessions in a row' : 'At ' + plural(r.sessions, 'session')) + (r.best > r.streak ? ' · best run ' + esc(r.best) : '') + '</p>' +
          (r.profile.length ? '<p class="small"><b>Palate:</b> loves ' + esc(top.name.toLowerCase()) + '</p><ul class="profile">' + r.profile.slice(0, 5).map(function (f) { return '<li><span class="small">' + esc(f.name) + '</span><span class="bar" aria-hidden="true"><span style="width:' + Math.round(f.mean / 5 * 100) + '%"></span></span><span class="small">' + esc(f.mean.toFixed(1)) + '★ <span class="muted">(' + esc(f.n) + ')</span></span></li>'; }).join('') + '</ul>' : '<p class="small muted">No ratings yet.</p>') +
          '</div></details></li>';
      }).join('') + '</ol>';
    }
    html += '</section>';
    if (b.topBeers.length) {
      html += '<section class="card"><div class="sec-head"><h2>The crew’s best ever</h2></div><ol class="topbeers">' + b.topBeers.map(function (t) {
        return '<li><span class="bbody"><b>' + esc(t.name) + '</b><span class="small muted">' + beerMeta(t) + ' · ' + esc(t.session) + '</span></span><span class="crowd">' + stars(t.half) + '<b>' + esc(C.starsText(t.half)) + '</b></span></li>';
      }).join('') + '</ol></section>';
    }
    el.innerHTML = html;
  }

  /* ---------------- Crew: invite, members, settings ---------------- */

  function joinLink() { return location.origin + BASE + 'j/' + crew().code; }
  function drawCrewTab() {
    var el = $('#tabView');
    var c = crew();
    var me = member(c.me);
    var html = '<section class="card invite"><div class="sec-head"><h2>Invite the crew</h2><span class="small muted">' + c.members.length + ' of ' + C.LIMITS.members + '</span></div>' +
      '<div class="invgrid">' + (sample() ? '<div class="qr fake" aria-hidden="true">QR</div>' : '<button type="button" class="qr" data-act="qrbig" aria-label="Show the QR code full screen">' + QR.svg(joinLink(), 'QR code to join ' + c.name) + '</button>') +
      '<div><p class="small muted">Code</p><p class="code">' + esc(c.display) + '</p><p class="small muted">Friends scan it or open the link, type a name, pick an emoji. No account, no app.</p>' +
      (sample() ? '' : '<div class="row"><button type="button" class="btn small" data-act="sharejoin">Share link</button><button type="button" class="btn small ghost" data-act="copyjoin">Copy</button></div>') + '</div></div>' +
      (c.host ? '<button type="button" class="link-btn small" data-act="rotate">New code (the old link stops working)</button>' : '') + '</section>';
    html += '<section class="card"><div class="sec-head"><h2>Members</h2></div><ul class="members">' + c.members.map(function (m) {
      return '<li>' + who(m.id) + (m.host ? '<span class="badge">host</span>' : '') + (m.seat ? '<span class="small muted" title="Signed in - their seat follows them">🔒 seat kept</span>' : '') +
        (c.host && !m.host && !sample() ? '<button type="button" class="btn small ghost" data-act="rmmember" data-mid="' + esc(m.id) + '">Remove</button>' : '') + '</li>';
    }).join('') + '</ul></section>';
    if (me && !sample()) {
      html += '<section class="card"><div class="sec-head"><h2>You</h2></div><div class="row"><button type="button" class="btn ghost" data-act="editme">Change name or emoji</button>' +
        (!me.seat ? '<button type="button" class="btn ghost" data-act="seat">Keep my seat on any device</button>' : '<span class="small muted">🔒 Your seat follows your account.</span>') + '</div>' +
        (!me.seat ? '<p class="small muted">You’re in on this browser. Sign in (free) to come back as you from another phone or laptop.</p>' : '') +
        (!me.host ? '<button type="button" class="link-btn small danger" data-act="leave">Leave the crew</button>' : '') + '</section>';
    }
    if (c.host && !sample()) {
      html += '<section class="card"><div class="sec-head"><h2>Host</h2></div><form class="addrow" id="renameForm"><input class="input" id="renameIn" maxlength="' + C.LIMITS.crewName + '" value="' + esc(c.name) + '" aria-label="Crew name"><button class="btn ghost" type="submit">Rename</button></form>' +
        '<button type="button" class="btn ghost danger" data-act="delcrew">Delete the crew and everything in it</button></section>';
    }
    el.innerHTML = html;
    var rf = $('#renameForm', el);
    if (rf) rf.addEventListener('submit', function (e) { e.preventDefault(); api('PATCH', crewPath(''), { name: $('#renameIn', el).value }).then(function (v) { state.data.crew = v; draw(); toast('Renamed'); }).catch(function (err) { showError(err); }); });
  }

  function showQr() {
    var o = document.createElement('div');
    o.className = 'qrfull'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'Join code');
    o.innerHTML = '<button type="button" class="btn small ghost" id="qrClose">Close</button><div class="qrbox">' + QR.svg(joinLink(), 'QR code to join ' + crew().name) + '</div><p class="code">' + esc(crew().display) + '</p><p>Scan to join ' + esc(crew().name) + '</p>';
    document.body.appendChild(o);
    function close() { o.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    $('#qrClose', o).addEventListener('click', close);
    o.addEventListener('click', function (e) { if (e.target === o) close(); });
    document.addEventListener('keydown', onKey);
    $('#qrClose', o).focus();
  }

  function emojiGrid(selected, taken) {
    return '<div class="emojis" role="radiogroup" aria-label="Your emoji">' + C.EMOJI.map(function (e) {
      return '<button type="button" class="emo' + (taken && taken.indexOf(e) >= 0 && e !== selected ? ' taken' : '') + '" role="radio" aria-checked="' + (e === selected) + '" data-act="emo" data-emo="' + esc(e) + '">' + esc(e) + '</button>';
    }).join('') + '</div>';
  }
  function openEditMe() {
    var me = member(crew().me);
    var pick = me.emoji;
    sheet('<h2>You in ' + esc(crew().name) + '</h2><form id="meForm" class="stack"><label class="field"><span>Name</span><input class="input" id="meName" maxlength="' + C.LIMITS.memberName + '" value="' + esc(me.name) + '"></label><div class="field"><span>Emoji</span>' + emojiGrid(pick, crew().members.map(function (m) { return m.emoji; })) + '</div><div id="meErr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      root.__emo = function (e) { pick = e; };
      $('#meForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        api('POST', crewPath('/me'), { name: $('#meName', root).value, emoji: pick }).then(function (v) { state.data.crew = v; closeSheet(); draw(); }).catch(function (err) { showError(err, $('#meErr', root)); });
      });
    });
  }

  /* ---------------- join ---------------- */

  function drawJoin() {
    var main = $('#main');
    var j = state.join;
    if (!j) { main.innerHTML = '<p class="busy" role="status">Finding the crew…</p>'; return; }
    if (j.error) {
      main.innerHTML = '<section class="card center gone"><div class="big-emoji" aria-hidden="true">🍻</div><h1>That code didn’t work</h1><p class="muted">' + esc(j.error) + '</p>' + joinBox() + '<a class="btn ghost" href="' + esc(BASE) + '">See the example crew</a></section>' + footer();
      return;
    }
    main.innerHTML = '<section class="card joincard"><div class="big-emoji" aria-hidden="true">🍻</div><p class="eyebrow">You’re invited to</p><h1>' + esc(j.name) + '</h1><p class="muted">' + plural(j.members, 'member') + ' · blind tastings, a Same-Can Challenge when you’re apart, votes on the next brewery, and a leaderboard.</p>' +
      (j.full ? '<p class="err">This crew is full.</p>' : '<form id="joinForm" class="stack"><label class="field"><span>Your name</span><input class="input" id="jName" maxlength="' + C.LIMITS.memberName + '" autocomplete="given-name" required placeholder="First name or nickname"></label>' +
        '<div class="field"><span>Pick an emoji</span>' + emojiGrid(j.pick, j.takenEmoji) + '</div><div id="jErr"></div><button class="btn block big" type="submit">Join the crew</button>' +
        '<p class="small muted center">No account needed - this phone remembers you. ' + (signedIn() ? 'You’re signed in, so your seat will follow your account.' : 'Sign in later to keep your seat on other devices.') + '</p></form>') + '</section>' + footer();
    var f = $('#joinForm');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('button[type=submit]', f); btn.disabled = true;
      api('POST', 'api/join/' + JOIN_CODE, { name: $('#jName').value, emoji: j.pick }).then(function (r) {
        location.href = BASE + 'c/' + r.crewId;
      }).catch(function (err) { btn.disabled = false; showError(err, $('#jErr')); });
    });
  }
  function joinBox() {
    return '<form class="addrow joinbox" id="codeForm"><input class="input" id="codeIn" maxlength="9" autocapitalize="characters" autocomplete="off" placeholder="ABC-DEF" aria-label="Join code"><button class="btn" type="submit">Join</button></form>';
  }
  function wireCodeForm(root) {
    var f = $('#codeForm', root);
    if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var c = $('#codeIn', root).value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length !== 6) return toast('Codes are six characters, like ABC-DEF.');
      location.href = BASE + 'j/' + c;
    });
  }
  function loadJoin() {
    api('GET', 'api/join/' + JOIN_CODE).then(function (j) {
      if (j.already) { location.replace(BASE + 'c/' + j.already); return; }
      var free = C.EMOJI.filter(function (e) { return j.takenEmoji.indexOf(e) < 0; });
      j.pick = free[Math.floor(Math.random() * free.length)] || C.EMOJI[0];
      state.join = j; draw();
    }).catch(function (e) { state.join = { error: e.message }; draw(); wireCodeForm(document); });
  }

  /* ---------------- start a crew ---------------- */

  function openStart(reason) {
    if (!signedIn()) {
      return openAccount((reason ? reason + ' ' : '') + 'A free account makes the crew yours to run and delete. Your friends never need one - they join with a code.', function () { openStart(); });
    }
    var pick = C.EMOJI[Math.floor(Math.random() * 8)];
    sheet('<h2>Start a crew</h2><p class="small muted">Free. You host; friends join by link, QR or code with no account. Up to ' + C.LIMITS.members + ' people.</p>' +
      '<form id="scForm" class="stack"><label class="field"><span>Crew name</span><input class="input" id="scName" maxlength="' + C.LIMITS.crewName + '" required placeholder="Thursday Pour Crew"></label>' +
      '<label class="field"><span>Your name</span><input class="input" id="scMe" maxlength="' + C.LIMITS.memberName + '" required placeholder="What the crew calls you"></label>' +
      '<div class="field"><span>Your emoji</span>' + emojiGrid(pick, []) + '</div><div id="scErr"></div><button class="btn block big" type="submit">Start the crew</button></form>', function (root) {
      root.__emo = function (e) { pick = e; };
      $('#scForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = $('button[type=submit]', root); btn.disabled = true;
        api('POST', 'api/crews', { name: $('#scName', root).value, hostName: $('#scMe', root).value, emoji: pick }).then(function (r) {
          rememberCrew(r.id, r.crew.name);
          location.href = BASE + 'c/' + r.id + '#crew';
        }).catch(function (err) { btn.disabled = false; showError(err, $('#scErr', root)); });
      });
    });
  }
  function openHaveCode() {
    var list = (recall(K_CREWS) || []);
    sheet('<h2>Join a crew</h2><p class="small muted">Type the six-character code under their QR code.</p>' + joinBox() +
      (list.length ? '<h3>Crews on this phone</h3><ul class="tlist">' + list.map(function (c) { return '<li><a href="' + esc(BASE + 'c/' + c.id) + '"><b>' + esc(c.name) + '</b></a></li>'; }).join('') + '</ul>' : ''), function (root) { wireCodeForm(root); });
  }
  function openMyCrews() {
    sheet('<h2>Your crews</h2><div id="mcList"><p class="busy">Loading…</p></div><button type="button" class="btn block" data-act="start">Start a crew</button>', function (root) {
      var local = recall(K_CREWS) || [];
      var p = signedIn() ? api('GET', 'api/crews').then(function (r) { return r.crews; }) : Promise.resolve([]);
      p.then(function (rows) {
        var seen = {};
        var all = rows.map(function (c) { seen[c.id] = 1; return { id: c.id, name: c.name, host: c.host, members: c.members }; })
          .concat(local.filter(function (c) { return c && !seen[c.id]; }));
        var el = $('#mcList', root);
        if (!all.length) { el.innerHTML = '<p class="muted">No crews yet. Start one, or join with a code.</p>' + joinBox(); wireCodeForm(root); return; }
        el.innerHTML = '<ul class="tlist">' + all.map(function (c) { return '<li><a href="' + esc(BASE + 'c/' + c.id) + '"><b>' + esc(c.name) + '</b><span class="small muted">' + (c.host ? 'You host' : 'Member') + (c.members ? ' · ' + plural(c.members, 'member') : '') + '</span></a></li>'; }).join('') + '</ul>';
      }).catch(function (e) { showError(e, $('#mcList', root)); });
    });
  }

  /* ---------------- account ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Account' : 'Sign in';
    $('#crewsBtn').hidden = !(signedIn() || (recall(K_CREWS) || []).length);
  }

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    document.body.classList.add('sheet-open');
    s.scrollTop = 0;
    if (onOpen) onOpen(s);
    // Focus the sheet's heading, not a field: on a phone a focused field
    // throws up the keyboard over the very thing being scored.
    var f = s.querySelector('h2') || s.querySelector('button:not(.close)');
    if (f && f.tagName === 'H2') f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  $('#sheetBack').addEventListener('click', closeSheet);

  var FREE_LINE = 'Members never need an account - they join with a code. A free account lets you host a crew, keep your seat on any device, and snap labels with AI (it comes with $2 of credit). One account works across every app on this site.';

  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
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
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); afterSignIn(then); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { afterSignIn(then); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function afterSignIn(then) {
    if (then) return then();
    if (state.mode === 'crew') { state.data = null; loadCrew().then(function () { if (state.sid) loadSession(); startPolling(); }); }
    if (state.mode === 'join') loadJoin();
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Snapping a label costs a cent or two. Crews, tastings, votes and the leaderboard are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); if (state.mode === 'crew') location.reload(); });
        });
        var pk = $('#pkEnrol', root);
        if (pk) pk.addEventListener('click', function () {
          var pw = prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        });
      });
  }
  function drawBilling(el) {
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" type="button" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button><p class="small muted">Membership covers every app on this site, runs the better model and lets you add credit.</p>';
        $('#joinM', el).addEventListener('click', function () { checkout('api/auth/billing/membership', {}); });
        return;
      }
      el.innerHTML = '<div class="row">' + (b.topUps || []).map(function (t) { return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) { btn.addEventListener('click', function () { checkout('api/auth/billing/credit', { usd: Number(btn.getAttribute('data-usd')) }); }); });
    }).catch(function () { el.innerHTML = ''; });
  }
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Typing the beer in, tasting, voting and the leaderboard keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  function confirmDo(msg, fn) { if (confirm(msg)) fn(); }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    var s = state.session;
    var sheetRoot = $('#sheet');
    switch (act) {
      case 'tab': goTab(t.getAttribute('data-tab')); break;
      case 'session': openSession(t.getAttribute('data-sid')); break;
      case 'back': if (state.pushed) { state.pushed = false; history.back(); } else goTab('play'); break;
      case 'start': closeSheet(); openStart(); break;
      case 'havecode': openHaveCode(); break;
      case 'signin': openAccount(); break;
      case 'closesheet': closeSheet(); break;
      case 'newsession': openNewSession(t.getAttribute('data-kind')); break;
      case 'nsmode': sheetRoot.__nsMode(t.getAttribute('data-mode')); break;
      case 'nswin': sheetRoot.__nsWin(t.getAttribute('data-win')); break;
      case 'bring': openBring({}); break;
      case 'bringfor': openBring({ forSomeone: true }); break;
      case 'editbeer': openBring({ beer: s.beers.filter(function (b) { return b.id === t.getAttribute('data-bid'); })[0] }); break;
      case 'rmbeer': confirmDo('Take this beer out of the lineup?', function () { call('DELETE', crewPath('/sessions/' + s.id + '/beers/' + t.getAttribute('data-bid'))).then(function (v) { state.session = v; drawSession(); }).catch(function (err) { showError(err); }); }); break;
      case 'snap': $('#snapFile', sheetRoot).click(); break;
      case 'starttasting': confirmDo('Start the tasting? The lineup is locked and the beers get their letters.', function () { call('POST', crewPath('/sessions/' + s.id + '/start'), {}).then(function (v) { state.session = v; drawSession(); toast('Letters are out - check yours and pour it.', 3200); }).catch(function (err) { showError(err); }); }); break;
      case 'score': openScore(t.getAttribute('data-bid')); break;
      case 'star': {
        var d = sheetRoot.__draft; var n = Number(t.getAttribute('data-n'));
        d.stars = d.stars === n ? n - 0.5 : (d.stars === n - 0.5 ? n : n);
        if (d.stars < 0.5) d.stars = 0.5;
        $$('.sp', sheetRoot).forEach(function (b) { var k = Number(b.getAttribute('data-n')); b.className = 'sp ' + (d.stars >= k ? 'full' : d.stars >= k - 0.5 ? 'half' : 'none'); b.setAttribute('aria-checked', String(d.stars === k || d.stars === k - 0.5)); });
        $('#starsOut', sheetRoot).textContent = C.starsText(d.stars) + ' ★';
        break;
      }
      case 'chip': {
        var dr = sheetRoot.__draft; var c = t.getAttribute('data-chip'); var i = dr.chips.indexOf(c);
        if (i >= 0) dr.chips.splice(i, 1); else if (dr.chips.length < C.LIMITS.chips) dr.chips.push(c); else { toast('Six notes is plenty.'); break; }
        t.setAttribute('aria-pressed', String(i < 0));
        break;
      }
      case 'abvstep': {
        var inp = $('#scAbv', sheetRoot); var cur = C.cleanAbv(inp.value); if (cur === null) cur = 5;
        inp.value = Math.max(0, Math.min(20, Math.round((cur + Number(t.getAttribute('data-d'))) * 10) / 10)).toFixed(1);
        break;
      }
      case 'savecity': call('PUT', crewPath('/sessions/' + s.id + '/city'), { city: $('#cityIn').value }).then(function (v) { state.session = v; drawSession(); toast('Saved'); }).catch(function (err) { showError(err); }); break;
      case 'reveal': confirmDo('Reveal it now? Scoring closes for everyone.', function () { call('POST', crewPath('/sessions/' + s.id + '/reveal'), {}).then(function (v) { state.session = v; drawSession(); celebrate(); scrollTo(0, 0); }).catch(function (err) { showError(err); }); }); break;
      case 'delsession': confirmDo('Delete this session and every score in it? Its points leave the leaderboard.', function () { api('DELETE', crewPath('/sessions/' + s.id)).then(function () { state.sid = null; state.session = null; state.data = null; setHash('play'); state.tab = 'play'; loadCrew(); }).catch(function (err) { showError(err); }); }); break;
      case 'copyrecap': copy($('#recapText').value, 'Recap copied'); break;
      case 'sharerecap': {
        var text = $('#recapText').value;
        if (navigator.share) navigator.share({ text: text }).catch(function () { /* cancelled */ }); else copy(text, 'Recap copied');
        break;
      }
      case 'newpoll': openNewPoll(); break;
      case 'editvote': state.editPoll = t.getAttribute('data-pid'); drawVote(); break;
      case 'npmore': { var box = $('#npOpts', sheetRoot); if (box.children.length < C.LIMITS.pollOptions) { var ni = document.createElement('input'); ni.className = 'input'; ni.maxLength = 300; ni.placeholder = 'Option ' + (box.children.length + 1); ni.setAttribute('aria-label', 'Option ' + (box.children.length + 1)); box.appendChild(ni); ni.focus(); } break; }
      case 'rmoption': call('DELETE', crewPath('/polls/' + t.getAttribute('data-pid') + '/options/' + t.getAttribute('data-oid'))).then(replacePoll).catch(function (err) { showError(err); }); break;
      case 'closepoll': {
        var pid = t.getAttribute('data-pid');
        var pl = state.data.polls.filter(function (x) { return x.id === pid; })[0];
        var r = pl.results;
        if (r && r.tie) {
          sheet('<h2>Break the tie</h2><p class="muted">Pick the winner to close the vote.</p><div class="stack">' + r.leaders.map(function (id) { var o = pl.options.filter(function (x) { return x.id === id; })[0]; return '<button type="button" class="btn ghost block" data-act="pickwin" data-pid="' + esc(pid) + '" data-oid="' + esc(id) + '">' + esc(o.text) + '</button>'; }).join('') + '</div>');
        } else confirmDo('Close the vote?', function () { call('POST', crewPath('/polls/' + pid + '/close'), {}).then(replacePoll).catch(function (err) { showError(err); }); });
        break;
      }
      case 'pickwin': call('POST', crewPath('/polls/' + t.getAttribute('data-pid') + '/close'), { pick: t.getAttribute('data-oid') }).then(function (v) { closeSheet(); replacePoll(v); }).catch(function (err) { showError(err); }); break;
      case 'delpoll': confirmDo('Delete this vote and everyone’s picks?', function () { api('DELETE', crewPath('/polls/' + t.getAttribute('data-pid'))).then(function () { state.data.polls = state.data.polls.filter(function (x) { return x.id !== t.getAttribute('data-pid'); }); drawVote(); }).catch(function (err) { showError(err); }); }); break;
      case 'qrbig': showQr(); break;
      case 'copyjoin': copy(joinLink(), 'Link copied - send it to the crew'); break;
      case 'sharejoin': {
        var txt = 'Join ' + crew().name + ' on Flight - blind tastings and beer games. Code ' + crew().display;
        if (navigator.share) navigator.share({ title: crew().name, text: txt, url: joinLink() }).catch(function () { /* cancelled */ }); else copy(joinLink(), 'Link copied - send it to the crew');
        break;
      }
      case 'rotate': confirmDo('Make a new code? The old link and QR code stop working. Nobody already in the crew is affected.', function () { api('POST', crewPath('/code'), {}).then(function (v) { state.data.crew = v; draw(); toast('New code: ' + v.display); }).catch(function (err) { showError(err); }); }); break;
      case 'rmmember': confirmDo('Remove ' + nameOf(t.getAttribute('data-mid')) + '? Their scores, guesses and votes go with them.', function () { api('DELETE', crewPath('/members/' + t.getAttribute('data-mid'))).then(function (v) { state.data.crew = v; state.data = null; loadCrew(); }).catch(function (err) { showError(err); }); }); break;
      case 'leave': confirmDo('Leave ' + crew().name + '? Your scores, guesses and votes go with you.', function () { api('DELETE', crewPath('/members/' + crew().me)).then(function () { forgetCrew(CREW_ID); location.href = BASE; }).catch(function (err) { showError(err); }); }); break;
      case 'delcrew': confirmDo('Delete ' + crew().name + ' - every session, score, vote and member? This cannot be undone.', function () { api('DELETE', crewPath('')).then(function () { forgetCrew(CREW_ID); location.href = BASE; }).catch(function (err) { showError(err); }); }); break;
      case 'editme': openEditMe(); break;
      case 'seat': if (!signedIn()) openAccount('Sign in (free) and your seat in this crew follows your account to any device.', function () { doSeat(); }); else doSeat(); break;
      case 'emo': {
        var root = t.closest('.sheet') || document;
        $$('.emo', t.parentNode).forEach(function (b) { b.setAttribute('aria-checked', String(b === t)); });
        var em = t.getAttribute('data-emo');
        if (root.__emo) root.__emo(em); else if (state.join) state.join.pick = em;
        break;
      }
      default: break;
    }
  });
  function doSeat() { api('POST', crewPath('/seat'), {}).then(function (v) { state.data.crew = v; draw(); toast('Your seat follows your account now.'); }).catch(function (err) { showError(err); }); }

  // Votes and "who brought it" picks: forms and selects.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.classList.contains('voteform')) {
      e.preventDefault();
      var picks = $$('input[type=checkbox]:checked', f).map(function (i) { return i.value; });
      if (!picks.length) return toast('Tick at least one.');
      call('PUT', crewPath('/polls/' + f.getAttribute('data-pid') + '/vote'), { options: picks }).then(function (v) { replacePoll(v); toast('Voted'); }).catch(function (err) { showError(err); });
    } else if (f.classList.contains('addopt')) {
      e.preventDefault();
      var inp = $('input', f); var text = inp.value.trim();
      if (!text) return;
      var btn = $('button', f); btn.disabled = true;
      call('POST', crewPath('/polls/' + f.getAttribute('data-pid') + '/options'), { text: text }).then(function (v) { replacePoll(v); }).catch(function (err) { btn.disabled = false; showError(err); });
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute('data-act') === 'guess') {
      call('PUT', crewPath('/sessions/' + state.session.id + '/guesses/' + t.getAttribute('data-bid')), { who: t.value || null })
        .then(function (v) { state.session = v; toast(t.value ? 'Guess saved' : 'Guess cleared'); }).catch(function (err) { showError(err); drawSession(); });
    }
  });

  /* ---------------- start ---------------- */

  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  $('#crewsBtn').addEventListener('click', openMyCrews);
  drawTop();
  readHash();
  if (state.mode === 'join') {
    draw();
    loadMe().then(loadJoin);
  } else if (state.mode === 'crew') {
    $('#main').innerHTML = '<p class="busy" role="status">Opening the crew…</p>';
    loadMe().then(function () { return loadCrew(); }).then(function () {
      if (state.sid) loadSession();
      startPolling();
      if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
    });
  } else {
    state.sample = S.state(Date.now());
    if (!location.hash) state.tab = 'play';
    state.data = sampleBundle();
    draw();
    if (state.sid) loadSession();
    loadMe().then(function () { if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings(); });
  }
})();
