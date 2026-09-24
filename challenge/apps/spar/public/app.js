/* Spar - the page. One file, no build step, every model-written string escaped. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');

  var state = { me: null, lib: null, daily: null, category: 'all' };

  // Where this app is mounted: '/' on its own host, '/spar/' inside the
  // challenge lab. Every URL the page builds goes through it.
  var BASE = location.pathname.replace(/[^/]*$/, '');

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(method, path, body) {
    return fetch(BASE + String(path).replace(/^\//, ''), {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
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

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { return null; }
  }

  function toast(msg, ms) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
  }

  /** A 402 is a till, not a wall: say what happened and where to go. */
  function showError(err, where) {
    if (err && err.status === 402) return openCreditSheet(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) { where.innerHTML = '<div class="err">' + esc(msg) + '</div>'; } else { toast(msg, 3500); }
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
  }

  function timeAgo(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function gradeClass(g) { return 'g-' + String(g || 'F').charAt(0); }

  var MOODS = [
    [-5, '🤬', 'Hostile'], [-4, '😠', 'Hostile'], [-3, '😒', 'Cold'], [-2, '😑', 'Cold'], [-1, '🤨', 'Guarded'],
    [0, '😐', 'Neutral'], [1, '🙂', 'Warming'], [2, '🙂', 'Warming'], [3, '😀', 'Engaged'], [4, '😄', 'Engaged'], [5, '🤝', 'Sold'],
  ];
  function mood(m) {
    var n = Math.max(-5, Math.min(5, Math.round(Number(m) || 0)));
    var row = MOODS[n + 5];
    return { n: n, face: row[1], label: row[2] };
  }
  function moodColor(n) {
    return n <= -3 ? 'var(--bad)' : n < 0 ? '#ff8a4d' : n === 0 ? 'var(--warn)' : n < 3 ? '#9be15d' : 'var(--good)';
  }

  function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var box = document.createElement('div');
    box.className = 'confetti';
    var colors = ['#ff5a36', '#ffd166', '#3ddc97', '#5aa9ff', '#ff8a3d', '#c77dff'];
    for (var i = 0; i < 70; i++) {
      var p = document.createElement('i');
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = Math.random() * 0.6 + 's';
      p.style.animationDuration = 1.4 + Math.random() * 1.2 + 's';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3400);
  }

  /* ---------------- data ---------------- */

  function loadMe() {
    return api('GET', '/api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function loadLib() {
    if (state.lib) return Promise.resolve(state.lib);
    return api('GET', '/api/library').then(function (l) { state.lib = l; return l; });
  }
  function signedIn() { return state.me && state.me.signedIn; }
  // Passkeys are bound to the shared domain; on a staging *.run.app host they
  // cannot work, so the buttons are not offered there.
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }

  function drawTop() {
    var el = $('#topRight');
    var me = state.me;
    if (!me || !me.signedIn) {
      el.innerHTML = '<button class="btn small" id="signInTop">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var p = me.player;
    el.innerHTML =
      (p.streak ? '<span class="pill streak" title="Day streak">🔥 ' + p.streak + '</span>' : '') +
      '<span class="pill xp" title="Level ' + p.level.level + '">⚡ ' + p.level.xp + '</span>' +
      '<button class="avatar-btn" id="acctBtn" aria-label="Account">' + esc(initials(p.handle)) + '</button>';
    $('#acctBtn').onclick = function () { openAccount(); };
  }

  /* ---------------- sheets ---------------- */

  function sheet(html, onMount) {
    closeSheet();
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.id = 'scrim';
    scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + html + '</div>';
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
    document.body.appendChild(scrim);
    if (onMount) onMount(scrim.firstChild);
    return scrim.firstChild;
  }
  function closeSheet() { var s = $('#scrim'); if (s) s.remove(); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function openAccount(reason) {
    if (signedIn()) return openProfileSheet();
    var mode = 'register';
    function draw(root) {
      root.innerHTML = '<div class="grab"></div>' +
        '<h2>' + (mode === 'register' ? 'Step into the ring' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Free account, with $2 of AI credit to start — roughly 20 practice rounds. One account works across every app on this site.'
          : 'Same account as the other apps on this site.')) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create account' : 'Sign in') + '</button>' +
        '</form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="center small muted" style="margin-top:14px">' +
        (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap">Sign in</button>' : 'New here? <button class="link-btn" id="swap">Create an account</button>') +
        '</p>';
      $('#swap', root).onclick = function () { mode = mode === 'register' ? 'login' : 'register'; draw(root); };
      $('#authForm', root).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target;
        var btn = $('button[type=submit]', f); btn.disabled = true;
        api('POST', '/api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(afterSignIn)
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(afterSignIn).catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      };
    }
    sheet('', function (root) { draw(root); });
  }

  function afterSignIn() {
    closeSheet();
    return loadMe().then(function () {
      var pending = store('spar.pendingJoin');
      if (pending) { store('spar.pendingJoin', ''); location.hash = '#/join/' + pending; }
      route();
      toast('You’re in. Pick a fight.');
    });
  }

  function openProfileSheet() {
    var me = state.me;
    var b = me.budget || {};
    var remaining = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    var pct = b.unlimited ? 100 : Math.max(0, Math.min(100, (b.remainingUsd / (b.allowanceUsd || 1)) * 100));
    sheet(
      '<div class="row spread"><h2>' + esc(me.player.handle) + '</h2><span class="pill xp">Lv ' + me.player.level.level + ' · ' + esc(me.player.level.title) + '</span></div>' +
      '<p class="muted small">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'Member model (Sonnet)' : 'Free model (Haiku)') + '</p>' +
      '<div class="card" style="margin:14px 0"><div class="row spread"><b>AI credit</b><span>' + remaining + '</span></div>' +
      '<div class="bar" style="margin-top:10px"><i style="width:' + pct + '%"></i></div>' +
      '<p class="small muted" style="margin:10px 0 0">Starting a round is free. Each line you say costs a fraction of a cent; a scorecard about a cent.</p>' +
      '<div id="billing" style="margin-top:12px"></div></div>' +
      '<label class="field"><span>Display name (shown on leaderboards)</span><div class="row"><input class="input" id="handleIn" maxlength="24" value="' + esc(me.player.handle) + '"><button class="btn small" id="handleSave">Save</button></div></label>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" style="margin-top:10px">Sign out</button>',
      function (root) {
        $('#handleSave', root).onclick = function () {
          api('POST', '/api/me/handle', { handle: $('#handleIn', root).value })
            .then(function () { toast('Saved.'); return loadMe(); })
            .catch(function (e) { showError(e); });
        };
        $('#signOut', root).onclick = function () {
          api('POST', '/api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); location.hash = '#/arena'; route(); });
        };
        var pk = $('#pkEnrol', root);
        if (pk) pk.onclick = function () {
          var pw = prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); })
            .catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        };
        drawBilling($('#billing', root));
      }
    );
  }

  function drawBilling(el) {
    api('GET', '/api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button>' +
          '<p class="small muted" style="margin:8px 0 0">Membership covers every app on this site, runs the better model, and lets you add credit.</p>';
        $('#joinM', el).onclick = function () { checkout('/api/auth/billing/membership', {}); };
        return;
      }
      el.innerHTML = '<div class="row wrap-row">' + (b.topUps || []).map(function (t) {
        return '<button class="btn small ghost" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>';
      }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) {
        btn.onclick = function () { checkout('/api/auth/billing/credit', { usd: Number(btn.dataset.usd) }); };
      });
    }).catch(function () { el.innerHTML = ''; });
  }

  function checkout(path, body) {
    body.returnTo = BASE + location.hash;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }

  function openCreditSheet(data) {
    sheet('<h2>Out of credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p>' +
      '<p class="muted small">Everything that is not a model call — your history, badges, teams, the demo — keeps working.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- routing ---------------- */

  var roundTimer = null;
  function route() {
    closeSheet();
    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
    stopSpeaking();
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var tab = parts[0] || 'arena';
    document.body.classList.toggle('in-round', tab === 'round' || tab === 'demo');
    view.style.padding = (tab === 'round' || tab === 'demo') ? '0' : '';
    $$('#tabbar button').forEach(function (b) {
      var t = b.dataset.tab;
      b.classList.toggle('on', t === tab || (t === 'teams' && (tab === 'team' || tab === 'join')));
    });
    window.scrollTo(0, 0);
    if (tab === 'round' && parts[1]) return renderRound(parts[1]);
    if (tab === 'demo') return renderDemo();
    if (tab === 'share' && parts[1]) return renderShare(parts[1]);
    if (tab === 'progress') return renderProgress();
    if (tab === 'build') return renderBuild();
    if (tab === 'teams') return renderTeams();
    if (tab === 'team' && parts[1]) return renderTeam(parts[1]);
    if (tab === 'join' && parts[1]) return joinTeam(parts[1]);
    return renderArena();
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () { location.hash = '#/' + b.dataset.tab; };
  });
  window.addEventListener('hashchange', route);

  function loading() { view.innerHTML = '<div class="empty"><span class="spinner"></span></div>'; }

  /* ---------------- arena ---------------- */

  function renderArena() {
    loading();
    Promise.all([loadLib(), api('GET', '/api/daily').catch(function () { return null; })]).then(function (r) {
      var lib = r[0]; state.daily = r[1];
      var me = state.me || {};
      var html = '';
      if (!me.signedIn) {
        html += '<section class="hero"><h1>Practise the conversation before it counts.</h1>' +
          '<p>Cold calls, raises, angry customers, investor pitches. Spar against someone with real reasons to say no — watch their mood move with every line, uncover what they are hiding, and get a coach’s scorecard.</p>' +
          '<div class="ctas"><button class="btn" id="heroSign">Start free</button><a class="btn ghost" href="#/demo">▶ Watch a round</a></div></section>';
      } else {
        var p = me.player;
        html += '<section class="card"><div class="level-strip"><div class="level-badge">' + p.level.level + '</div>' +
          '<div style="flex:1;min-width:0"><div class="row spread"><b>' + esc(p.level.title) + '</b><span class="small muted">' +
          (p.level.next ? p.level.xp + ' / ' + p.level.next + ' XP' : p.level.xp + ' XP · max level') + '</span></div>' +
          '<div class="bar" style="margin-top:8px"><i style="width:' + Math.round(p.level.progress * 100) + '%"></i></div>' +
          '<div class="small muted" style="margin-top:6px">' + p.rounds + ' rounds · ' + p.wins + ' wins' + (p.streak ? ' · 🔥 ' + p.streak + '-day streak' : '') + '</div></div></div></section>';
      }
      html += '<div class="dk-split dk-split-aside arena-split" style="margin-top:16px"><div>';
      html += '<div class="section-title"><h2>Pick your opponent</h2><span class="small muted">' + lib.scenarios.length + ' scenarios</span></div>';
      html += '<div class="chips" id="cats"><button class="chip' + (state.category === 'all' ? ' on' : '') + '" data-cat="all">All</button>' +
        Object.keys(lib.categories).map(function (k) {
          var c = lib.categories[k];
          return '<button class="chip' + (state.category === k ? ' on' : '') + '" data-cat="' + k + '">' + c.emoji + ' ' + esc(c.label) + '</button>';
        }).join('') + '</div>';
      html += '<div class="grid" style="margin-top:12px" id="scnGrid"></div></div>';
      html += '<aside class="dk-sticky" style="margin-top:12px">' + dailyCard(state.daily) + '</aside></div>';
      view.innerHTML = html;

      var hs = $('#heroSign'); if (hs) hs.onclick = function () { openAccount(); };
      $$('#cats .chip').forEach(function (c) {
        c.onclick = function () { state.category = c.dataset.cat; $$('#cats .chip').forEach(function (x) { x.classList.toggle('on', x === c); }); drawGrid(); };
      });
      var dp = $('#dailyPlay'); if (dp) dp.onclick = function () { startDaily(); };
      drawGrid();
    }).catch(function (e) { showError(e, view); });
  }

  function drawGrid() {
    var lib = state.lib;
    var best = (state.me && state.me.player && state.me.player.best) || {};
    var list = lib.scenarios.filter(function (s) { return state.category === 'all' || s.category === state.category; });
    var g = $('#scnGrid');
    g.innerHTML = list.map(function (s) {
      return '<button class="scn" data-id="' + esc(s.id) + '"><div class="em">' + s.emoji + '</div><h3>' + esc(s.title) + '</h3><p>' + esc(s.blurb) + '</p>' +
        '<div class="meta"><span class="tag-s">' + esc(lib.categories[s.category].label) + '</span>' +
        (best[s.id] != null ? '<span class="tag-s best">Best ' + best[s.id] + '</span>' : '') + '</div></button>';
    }).join('') +
      '<a class="scn build" href="#/build"><div class="em">🛠️</div><h3>Build your own</h3><p>Describe the conversation you are dreading. Spar builds the opponent.</p></a>';
    $$('.scn[data-id]', g).forEach(function (b) {
      b.onclick = function () {
        var s = lib.scenarios.filter(function (x) { return x.id === b.dataset.id; })[0];
        openBrief(s, { scenarioId: s.id });
      };
    });
  }

  function dailyCard(d) {
    if (!d) return '';
    var s = d.challenge.scenario;
    var board = d.board.slice(0, 8);
    return '<section class="daily"><div class="tag">Daily challenge · ' + esc(d.challenge.day) + '</div>' +
      '<h3>' + s.emoji + ' ' + esc(s.title) + '</h3><div style="opacity:.8;font-size:14px">' + esc(s.blurb) + '</div>' +
      '<div class="twist"><b>Today’s twist:</b> ' + esc(d.challenge.twist) + '</div>' +
      '<button class="btn block" id="dailyPlay">' + (d.mine ? 'Beat your ' + d.mine.score : 'Take the challenge') + ' · +25 XP</button>' +
      '<div class="board">' + (board.length ? board.map(function (r) {
        return '<div class="r' + (r.you ? ' you' : '') + '"><span class="rank">' + r.rank + '</span><span>' + esc(r.handle) + '</span><span class="g ' + gradeClass(r.grade) + '">' + esc(r.grade) + '</span><b>' + r.score + '</b></div>';
      }).join('') : '<div class="r" style="grid-template-columns:1fr"><span style="opacity:.75">Nobody on the board yet today. Be first.</span></div>') + '</div></section>';
  }

  function startDaily() {
    if (!signedIn()) return openAccount('Sign up free to take the daily challenge.');
    var d = state.daily;
    openBrief(d.challenge.scenario, { daily: true }, d.challenge.twist);
  }

  /* ---------------- brief & start ---------------- */

  function openBrief(s, startBody, twist) {
    var lib = state.lib || { difficulties: {} };
    var diff = store('spar.diff') || 'realistic';
    var fixed = startBody.daily || startBody.assignmentId;
    sheet(
      '<div class="row" style="gap:14px"><div style="font-size:40px">' + s.emoji + '</div><div><h2>' + esc(s.title) + '</h2><div class="muted small">' + esc(s.blurb || '') + '</div></div></div>' +
      '<dl class="brief">' +
      '<dt>You are</dt><dd>' + esc(s.youAre) + '</dd>' +
      '<dt>Across the table</dt><dd><b>' + esc(s.them.name) + '</b> — ' + esc(s.them.role) + ', ' + esc(s.them.company) + '</dd>' +
      '<dt>Your goal</dt><dd>' + esc(s.goal) + '</dd>' +
      '<dt>You win when</dt><dd>' + esc(s.win) + '</dd>' +
      (twist ? '<dt>Today’s twist</dt><dd>' + esc(twist) + '</dd>' : '') +
      '</dl>' +
      (fixed ? '' : '<div style="margin:16px 0 6px" class="small muted"><b>Difficulty</b></div><div class="diff" id="diffPick">' +
        Object.keys(lib.difficulties).map(function (k) {
          var d = lib.difficulties[k];
          return '<button data-d="' + k + '" class="' + (k === diff ? 'on' : '') + '">' + esc(d.label) + '<small>' + d.turns + ' lines · ' + d.mult + 'x XP</small></button>';
        }).join('') + '</div><p class="small muted" id="diffNote" style="min-height:2.6em">' + esc((lib.difficulties[diff] || {}).note || '') + '</p>') +
      '<p class="small muted">🔒 They are hiding what would really move them. Good questions uncover it — each motive found is +10 XP.</p>' +
      '<div id="briefErr"></div><button class="btn block" id="go">' + (signedIn() ? 'Start the conversation' : 'Sign up free to play') + '</button>' +
      '<p class="center small faint" style="margin-top:10px">Starting is free — you only spend credit when you speak.</p>',
      function (root) {
        $$('#diffPick button', root).forEach(function (b) {
          b.onclick = function () {
            diff = b.dataset.d; store('spar.diff', diff);
            $$('#diffPick button', root).forEach(function (x) { x.classList.toggle('on', x === b); });
            $('#diffNote', root).textContent = (lib.difficulties[diff] || {}).note || '';
          };
        });
        $('#go', root).onclick = function () {
          if (!signedIn()) return openAccount('Sign up free — $2 of AI credit, about 20 rounds.');
          var btn = this; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
          var body = Object.assign({ difficulty: diff }, startBody);
          api('POST', '/api/rounds', body).then(function (r) {
            closeSheet(); location.hash = '#/round/' + r.id;
          }).catch(function (e) { btn.disabled = false; btn.textContent = 'Start the conversation'; showError(e, $('#briefErr', root)); });
        };
      }
    );
  }

  /* ---------------- voice ---------------- */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var synth = window.speechSynthesis;
  function voiceOn() { return store('spar.voice') === '1'; }
  function stopSpeaking() { try { if (synth) synth.cancel(); } catch (e) { /* nothing to stop */ } }
  function speak(text, who) {
    if (!synth || !voiceOn()) return;
    try {
      stopSpeaking();
      var u = new SpeechSynthesisUtterance(text);
      var voices = synth.getVoices().filter(function (v) { return /^en/i.test(v.lang); });
      if (voices.length) {
        var h = 0; String(who || '').split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
        u.voice = voices[h % voices.length];
        u.pitch = 0.85 + (h % 30) / 100;
      }
      u.rate = 1.03;
      synth.speak(u);
    } catch (e) { /* voice is decoration */ }
  }

  /* ---------------- the round ---------------- */

  var round = null;

  function renderRound(id) {
    loading();
    api('GET', '/api/rounds/' + encodeURIComponent(id)).then(function (r) {
      round = r;
      if (r.scorecard) return drawScorecard(r);
      drawRound();
    }).catch(function (e) {
      if (e.status === 401) { openAccount('Sign in to see that round.'); view.innerHTML = ''; return; }
      showError(e, view);
    });
  }

  function turnsPips(r) {
    var out = '';
    for (var i = 0; i < r.maxTurns; i++) out += '<i class="' + (i < r.turns ? 'used' : '') + '"></i>';
    return out;
  }

  function intelChips(r, pop) {
    var out = '';
    for (var i = 1; i <= r.hiddenCount; i++) {
      var t = r.revealedText[i];
      out += t
        ? '<span class="i open' + (pop && pop.indexOf(i) >= 0 ? ' pop' : '') + '">🔓 ' + esc(t) + '</span>'
        : '<span class="i">🔒 Motive ' + i + '</span>';
    }
    return out;
  }

  function drawRound() {
    var r = round;
    var s = r.scenario;
    var m = mood(r.mood);
    view.innerHTML =
      '<div class="round dk-stream">' +
      '<div class="opp">' +
      '<div class="opp-head"><button class="icon-btn" id="back" aria-label="Back" style="width:36px;height:36px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></button>' +
      '<div class="face" id="face" style="border-color:' + moodColor(m.n) + '">' + m.face + '</div>' +
      '<div style="flex:1;min-width:0"><div class="opp-name">' + esc(s.them.name) + '</div><div class="opp-role">' + esc(s.them.role) + ' · ' + esc(s.them.company) + '</div></div>' +
      '<div style="text-align:right"><div class="turns" id="pips" title="Lines left">' + turnsPips(r) + '</div><div class="small faint" id="left" style="margin-top:4px">' + (r.maxTurns - r.turns) + ' lines left</div></div></div>' +
      '<div class="meter"><div class="meter-track"><div class="meter-knob" id="knob" style="left:' + ((m.n + 5) * 10) + '%"></div></div>' +
      '<div class="meter-labels"><span>Hostile</span><b id="moodLbl">' + m.label + '</b><span>Sold</span></div></div>' +
      '<div class="intel" id="intel">' + intelChips(r) + '</div>' +
      '</div>' +
      '<div class="chat" id="chat"></div>' +
      '<div id="overBox"></div>' +
      '<div class="composer dk-stream" id="composer">' +
      '<div class="tools">' +
      '<button class="tool" id="hintBtn">💡 Whisper <span id="hintLeft">' + (r.maxHints - r.hintsUsed) + '</span></button>' +
      (synth ? '<button class="tool' + (voiceOn() ? ' on' : '') + '" id="voiceBtn">🔊 Voice</button>' : '') +
      '<span style="flex:1"></span><button class="tool" id="endBtn">🏁 End & score</button></div>' +
      '<div class="line">' +
      (SR ? '<button class="icon-btn" id="micBtn" aria-label="Speak"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/></svg></button>' : '') +
      '<textarea id="say" rows="1" maxlength="700" placeholder="Say something to ' + esc(s.them.name.split(' ')[0]) + '…"></textarea>' +
      '<button class="icon-btn send" id="sendBtn" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button>' +
      '</div></div></div>';

    var chat = $('#chat');
    var prev = null;
    (r.daily ? ['<div class="system-note">📅 Daily challenge · ' + esc(r.twist || '') + '</div>'] : []).forEach(function (h) { chat.insertAdjacentHTML('beforeend', h); });
    if (r.twist && !r.daily) chat.insertAdjacentHTML('beforeend', '<div class="system-note">' + esc(r.twist) + '</div>');
    r.transcript.forEach(function (t) { addMsg(t, prev); if (t.who === 'them') prev = t.mood; });
    chat.scrollTop = chat.scrollHeight;
    if (r.transcript.length === 1) speak(r.transcript[0].text, s.them.name);

    $('#back').onclick = function () { history.length > 1 ? history.back() : (location.hash = '#/arena'); };
    $('#sendBtn').onclick = send;
    var ta = $('#say');
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
    $('#hintBtn').onclick = whisper;
    $('#endBtn').onclick = function () {
      if (round.status === 'live' && !confirm('End the conversation here and get your scorecard?')) return;
      finish();
    };
    var vb = $('#voiceBtn');
    if (vb) vb.onclick = function () { store('spar.voice', voiceOn() ? '0' : '1'); vb.classList.toggle('on', voiceOn()); if (!voiceOn()) stopSpeaking(); };
    if (SR) wireMic();
    if (r.status !== 'live') showOver();
    else if (window.innerWidth > 700) ta.focus();
  }

  function addMsg(t, prevMood, into) {
    var chat = into || $('#chat');
    var html;
    if (t.who === 'you') {
      html = '<div class="msg-row q"><div class="bubble">' + esc(t.text) + '</div></div>';
    } else {
      var delta = prevMood == null ? 0 : t.mood - prevMood;
      html = '<div class="msg-row them"><div class="bubble">' + esc(t.text) + '</div>' +
        (prevMood != null ? '<div class="delta ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : '') + '">' + mood(t.mood).face + ' ' + (delta > 0 ? '+' + delta + ' mood' : delta < 0 ? delta + ' mood' : 'no change') + '</div>' : '') +
        ((t.revealed || []).length ? '<div class="found">🔓 You uncovered a hidden motive (+10 XP)</div>' : '') +
        (t.note ? '<div class="note">Coach: ' + esc(t.note) + '</div>' : '') +
        '</div>';
    }
    chat.insertAdjacentHTML('beforeend', html);
  }

  function setMood(n) {
    var m = mood(n);
    var knob = $('#knob'); if (knob) knob.style.left = ((m.n + 5) * 10) + '%';
    var lbl = $('#moodLbl'); if (lbl) lbl.textContent = m.label;
    var face = $('#face');
    if (face) {
      face.textContent = m.face; face.style.borderColor = moodColor(m.n);
      face.classList.add('bump'); setTimeout(function () { face.classList.remove('bump'); }, 300);
    }
  }

  var sending = false;
  function send() {
    var ta = $('#say');
    var text = ta.value.trim();
    if (!text || sending || round.status !== 'live') return;
    stopListening();
    sending = true;
    var prevMood = round.mood;
    addMsg({ who: 'you', text: text });
    ta.value = ''; ta.style.height = 'auto';
    var chat = $('#chat');
    chat.insertAdjacentHTML('beforeend', '<div class="msg-row them typing" id="typing"><div class="bubble"><i></i><i></i><i></i></div></div>');
    chat.scrollTop = chat.scrollHeight;
    $('#sendBtn').disabled = true;
    api('POST', '/api/rounds/' + round.id + '/say', { text: text }).then(function (r) {
      round = r;
      var t = $('#typing'); if (t) t.remove();
      var last = r.transcript[r.transcript.length - 1];
      addMsg(last, prevMood);
      chat.scrollTop = chat.scrollHeight;
      setMood(r.mood);
      $('#pips').innerHTML = turnsPips(r);
      $('#left').textContent = (r.maxTurns - r.turns) + ' lines left';
      $('#intel').innerHTML = intelChips(r, r.newlyRevealed);
      if ((r.newlyRevealed || []).length) toast('🔓 Hidden motive uncovered!');
      speak(last.text, r.scenario.them.name);
      if (r.status !== 'live') showOver();
    }).catch(function (e) {
      var t = $('#typing'); if (t) t.remove();
      // Nothing was saved server-side, so put their words back to resend.
      var rows = $$('#chat .msg-row.q'); if (rows.length) rows[rows.length - 1].remove();
      ta.value = text;
      showError(e);
    }).then(function () { sending = false; var b = $('#sendBtn'); if (b) b.disabled = false; });
  }

  function whisper() {
    if (round.status !== 'live') return;
    var btn = $('#hintBtn'); btn.disabled = true;
    api('POST', '/api/rounds/' + round.id + '/hint').then(function (h) {
      round.hintsUsed = h.hintsUsed;
      $('#hintLeft').textContent = h.maxHints - h.hintsUsed;
      var chat = $('#chat');
      chat.insertAdjacentHTML('beforeend', '<div class="whisper"><b>💡 Coach:</b> ' + esc(h.hint) +
        '<div class="try">“' + esc(h.tryLine) + '”</div><button class="btn small ghost use">Use this line</button></div>');
      var w = $$('.whisper', chat).pop();
      $('.use', w).onclick = function () { var ta = $('#say'); ta.value = h.tryLine; ta.focus(); };
      chat.scrollTop = chat.scrollHeight;
      if (h.hintsUsed < h.maxHints) btn.disabled = false;
    }).catch(function (e) { btn.disabled = false; showError(e); });
  }

  function showOver() {
    var r = round;
    var comp = $('#composer'); if (comp) comp.classList.add('hidden');
    var title = r.status === 'won' ? '🏆 They said yes.' : r.status === 'lost' ? '💥 They walked.' : '⏱ Time.';
    var sub = r.status === 'won' ? 'You got the commitment. Let’s see how clean it was.'
      : r.status === 'lost' ? 'It happens in the real world too. The scorecard shows where it turned.'
        : 'Out of lines. Here’s how it went.';
    $('#overBox').innerHTML = '<div class="over"><h3>' + title + '</h3><p class="muted" style="margin:4px 0 14px">' + sub + '</p>' +
      '<button class="btn block" id="scoreBtn">Get my scorecard</button></div>';
    $('#scoreBtn').onclick = finish;
    if (r.status === 'won') confetti();
    var chat = $('#chat'); chat.scrollTop = chat.scrollHeight;
  }

  function finish() {
    var box = $('#overBox');
    var comp = $('#composer'); if (comp) comp.classList.add('hidden');
    box.innerHTML = '<div class="over"><span class="spinner"></span><p class="muted">The coach is reviewing the tape…</p></div>';
    stopSpeaking();
    api('POST', '/api/rounds/' + round.id + '/finish').then(function (r) {
      if (r.abandoned) { toast('Round discarded — you did not say anything.'); location.hash = '#/arena'; return; }
      round = r;
      loadMe();
      drawScorecard(r, true);
    }).catch(function (e) {
      box.innerHTML = '<div class="over"><p class="err">' + esc(e.message) + '</p><button class="btn block" id="retryScore">Try again</button></div>';
      $('#retryScore').onclick = finish;
      if (e.status === 402) openCreditSheet(e.data);
    });
  }

  /* mic: tap to talk, tap again to stop. Words land in the box to edit. */
  var rec = null;
  function stopListening() { if (rec) { try { rec.stop(); } catch (e) { /* already stopped */ } } }
  function wireMic() {
    var btn = $('#micBtn');
    btn.onclick = function () {
      if (rec) return stopListening();
      stopSpeaking();
      var ta = $('#say');
      var base = ta.value ? ta.value.trim() + ' ' : '';
      rec = new SR();
      rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true;
      rec.onresult = function (e) {
        var txt = '';
        for (var i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        ta.value = base + txt;
      };
      rec.onend = function () { rec = null; btn.classList.remove('rec'); };
      rec.onerror = function (e) { if (e.error === 'not-allowed') toast('Microphone access is off for this site.'); };
      try { rec.start(); btn.classList.add('rec'); } catch (e) { rec = null; }
    };
  }

  /* ---------------- scorecard ---------------- */

  function ring(score, grade) {
    var c = 2 * Math.PI * 64;
    var off = c * (1 - score / 100);
    var col = score >= 78 ? 'var(--good)' : score >= 55 ? 'var(--warn)' : 'var(--bad)';
    return '<div class="ring"><svg viewBox="0 0 150 150"><circle cx="75" cy="75" r="64" fill="none" stroke="var(--fill)" stroke-width="12"/>' +
      '<circle cx="75" cy="75" r="64" fill="none" stroke="' + col + '" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + c + '" class="ring-arc" data-off="' + off + '" style="transition:stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)"/></svg>' +
      '<div class="val"><div class="grade ' + gradeClass(grade) + '">' + esc(grade) + '</div><div class="num">' + score + ' / 100</div></div></div>';
  }

  function moodChart(trail) {
    if (!trail || trail.length < 2) return '';
    var w = 320, h = 120, pad = 14;
    var step = (w - pad * 2) / (trail.length - 1);
    var y = function (m) { return pad + (5 - m) * (h - pad * 2) / 10; };
    var pts = trail.map(function (m, i) { return (pad + i * step).toFixed(1) + ',' + y(m).toFixed(1); }).join(' ');
    var dots = trail.map(function (m, i) { return '<circle cx="' + (pad + i * step).toFixed(1) + '" cy="' + y(m).toFixed(1) + '" r="3.5" fill="' + moodColor(m) + '"/>'; }).join('');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;height:auto" role="img" aria-label="Mood over the conversation">' +
      '<defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3ddc97"/><stop offset=".5" stop-color="#ffc53d"/><stop offset="1" stop-color="#ff4d6a"/></linearGradient></defs>' +
      '<line x1="' + pad + '" x2="' + (w - pad) + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="var(--line)" stroke-dasharray="4 4"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="url(#mg)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>' + dots +
      '<text x="' + pad + '" y="11" font-size="10" fill="var(--faint)">Sold</text><text x="' + pad + '" y="' + (h - 2) + '" font-size="10" fill="var(--faint)">Hostile</text></svg>';
  }

  function skillBars(sk) {
    var names = (state.lib && state.lib.skills) || { rapport: 'Rapport', discovery: 'Discovery', pushback: 'Handling pushback', clarity: 'Clarity', close: 'Closing' };
    return '<div class="skillbars">' + Object.keys(names).map(function (k) {
      var v = sk[k] || 0;
      return '<div class="s"><span>' + esc(names[k]) + '</span><div class="bar"><i style="width:' + v * 10 + '%"></i></div><b>' + v + '</b></div>';
    }).join('') + '</div>';
  }

  /** Draw a scored round. Shared with the demo and with public share links. */
  function scorecardHtml(r, opts) {
    opts = opts || {};
    var c = r.scorecard;
    var s = r.scenario;
    var a = r.award || r.xp || null;
    var out = r.status === 'won' ? 'Won' : r.status === 'lost' ? 'They walked' : 'Out of time';
    var html = '<section class="score-hero ' + esc(r.status) + '">' +
      '<div class="outcome">' + out + ' · ' + esc(s.title) + '</div>' +
      (opts.handle ? '<div class="small muted" style="margin-top:4px">' + esc(opts.handle) + ' · ' + esc(r.difficulty) + '</div>' : '') +
      ring(c.overall, c.grade) +
      '<div class="headline">' + esc(c.headline) + '</div>';
    if (a && a.gained) html += '<div class="xp-gain">⚡ +' + a.gained + ' XP' + (a.personalBest ? ' · Personal best' : '') + '</div>';
    if (a && a.levelUp) html += '<div class="badges-new"><div class="badge-pop">🎉 Level ' + a.levelUp.level + ' — ' + esc(a.levelUp.title) + '</div></div>';
    if (a && a.earned && a.earned.length) html += '<div class="badges-new">' + a.earned.map(function (b) { return '<div class="badge-pop">' + b.emoji + ' ' + esc(b.label) + '</div>'; }).join('') + '</div>';
    html += '</section>';

    html += '<div class="cols two" style="margin-top:12px">' +
      '<section class="card"><h3 style="margin-bottom:12px">Skills</h3>' + skillBars(c.skills) + '</section>' +
      '<section class="card"><h3 style="margin-bottom:6px">Their mood</h3>' + moodChart(r.moodTrail) + '</section></div>';

    html += '<div class="cols two" style="margin-top:12px">' +
      '<section class="card"><h3>✅ What worked</h3><ul class="list-tight">' + c.strengths.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      (c.bestLine && c.bestLine.quote ? '<div class="small muted" style="margin-top:12px"><b>Best line</b></div><div class="quote">“' + esc(c.bestLine.quote) + '”</div><div class="small muted">' + esc(c.bestLine.why) + '</div>' : '') + '</section>' +
      '<section class="card"><h3>🎯 Work on</h3><ul class="list-tight">' + c.improve.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      (c.missedMoment && c.missedMoment.quote ? '<div class="small muted" style="margin-top:12px"><b>Missed moment</b></div><div class="quote miss">“' + esc(c.missedMoment.quote) + '”</div>' +
        '<div class="quote better">Try: ' + esc(c.missedMoment.better) + '</div><div class="small muted">' + esc(c.missedMoment.why) + '</div>' : '') + '</section></div>';

    if (r.revealedText && Object.keys(r.revealedText).length) {
      html += '<section class="card intel-reveal" style="margin-top:12px"><h3 style="margin-bottom:6px">🕵️ What they were hiding</h3>' +
        Object.keys(r.revealedText).map(function (k) {
          var found = (r.revealed || []).indexOf(Number(k)) >= 0;
          return '<div class="h"><span class="' + (found ? 'ok' : 'no') + '">' + (found ? '🔓' : '🔒') + '</span><div>' + esc(r.revealedText[k]) +
            '<div class="small ' + (found ? 'ok' : 'no') + '">' + (found ? 'You uncovered this' : 'You missed this') + '</div></div></div>';
        }).join('') + '</section>';
    }

    if (r.transcript && r.transcript.length) {
      html += '<details class="card" style="margin-top:12px"' + (opts.openTranscript ? ' open' : '') + '><summary><b>Replay the tape</b> <span class="small muted">with the coach’s notes</span></summary><div class="chat" id="tape" style="padding:12px 0 0"></div></details>';
    }
    return html;
  }

  function drawTape(r) {
    var tape = $('#tape'); if (!tape) return;
    var prev = null;
    r.transcript.forEach(function (t) { addMsg(t, prev, tape); if (t.who === 'them') prev = t.mood; });
  }

  function animateRing() {
    requestAnimationFrame(function () {
      $$('.ring-arc').forEach(function (a) { a.style.strokeDashoffset = a.dataset.off; });
    });
  }

  function drawScorecard(r, fresh) {
    document.body.classList.remove('in-round');
    view.style.padding = '';
    view.innerHTML = '<div class="row spread" style="margin-bottom:12px"><button class="btn small ghost" id="toArena">← Arena</button>' +
      '<div class="row"><button class="btn small ghost" id="shareBtn">Share</button><button class="btn small" id="rematch">Rematch</button></div></div>' +
      scorecardHtml(r) +
      '<div class="row" style="margin:18px 0 8px;gap:10px"><button class="btn block" id="rematch2">Run it back</button><a class="btn ghost block" href="#/arena">New opponent</a></div>';
    drawTape(r);
    animateRing();
    if (fresh && r.award && ((r.award.earned || []).length || r.award.levelUp || r.status === 'won')) confetti();
    $('#toArena').onclick = function () { location.hash = '#/arena'; };
    $('#rematch').onclick = $('#rematch2').onclick = function () { rematch(r); };
    $('#shareBtn').onclick = function () { shareRound(r); };
  }

  function rematch(r) {
    var body = { difficulty: r.difficulty };
    if (r.daily) {
      if (state.daily && state.daily.challenge.day === r.daily) body.daily = true;
      else body.scenarioId = r.scenarioId;
    } else if (r.source === 'custom') body.customId = r.scenarioId.split(':')[1];
    else if (r.source === 'team') { toast('Play team drills from the team page.'); location.hash = '#/team/' + r.teamId; return; }
    else body.scenarioId = r.scenarioId;
    api('POST', '/api/rounds', body).then(function (n) { location.hash = '#/round/' + n.id; }).catch(function (e) { showError(e); });
  }

  function shareRound(r) {
    sheet('<h2>Share your scorecard</h2><p class="muted">Anyone with the link sees your grade, skills and the coach’s notes. The conversation itself stays private unless you include it.</p>' +
      '<label class="row" style="margin:14px 0"><input type="checkbox" id="withT"> Include the transcript</label>' +
      '<button class="btn block" id="mk">Create link</button><div id="shareOut" style="margin-top:12px"></div>',
      function (root) {
        $('#mk', root).onclick = function () {
          api('POST', '/api/rounds/' + r.id + '/share', { transcript: $('#withT', root).checked }).then(function (x) {
            var url = location.origin + BASE + '#/share/' + x.shareId;
            $('#shareOut', root).innerHTML = '<input class="input" readonly value="' + esc(url) + '">';
            var text = 'I scored ' + r.scorecard.grade + ' on "' + r.scenario.title + '" in Spar. Think you can beat it?';
            if (navigator.share) navigator.share({ title: 'Spar scorecard', text: text, url: url }).catch(function () {});
            else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('Link copied.'); });
          }).catch(function (e) { showError(e); });
        };
      });
  }

  /* ---------------- demo ---------------- */

  function renderDemo() {
    loading();
    Promise.all([api('GET', '/api/demo'), loadLib()]).then(function (res) {
      var d = res[0];
      var steps = d.transcript.slice();
      round = Object.assign({}, d, { transcript: [], turns: 0, mood: 0, revealed: [], revealedText: {}, status: 'live', maxHints: 3, hintsUsed: 0 });
      drawRound();
      $('#composer').innerHTML = '<div class="row" style="justify-content:center"><span class="small muted">▶ Replay of a real-style round · </span><button class="link-btn" id="skip">Skip to scorecard</button></div>';
      var chat = $('#chat');
      var prev = 0, i = 0, done = false;
      function end() {
        if (done) return; done = true;
        if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
        var r = Object.assign({}, d, { transcript: d.transcript, award: { gained: d.xp.gained } });
        drawScorecard(r);
        view.insertAdjacentHTML('afterbegin', '<div class="card" style="margin-bottom:12px;text-align:center"><b>That’s a demo round.</b><p class="muted small" style="margin:6px 0 10px">Your turn — free account, $2 of credit, about 20 rounds.</p><button class="btn" id="demoSign">' + (signedIn() ? 'Pick an opponent' : 'Start free') + '</button></div>');
        $('#demoSign').onclick = function () { signedIn() ? (location.hash = '#/arena') : openAccount(); };
        $('#rematch').classList.add('hidden'); $('#shareBtn').classList.add('hidden');
        $('#rematch2').textContent = 'Try it yourself';
        $('#rematch2').onclick = function () {
          var s = state.lib.scenarios.filter(function (x) { return x.id === d.scenarioId; })[0];
          openBrief(s, { scenarioId: s.id });
        };
      }
      $('#skip').onclick = end;
      function next() {
        if (location.hash.indexOf('demo') < 0) { clearInterval(roundTimer); roundTimer = null; return; }
        if (i >= steps.length) return setTimeout(end, 1200);
        var t = steps[i++];
        addMsg({ who: t.who, text: t.text, mood: t.mood, revealed: t.revealed }, t.who === 'them' && i > 1 ? prev : null);
        if (t.who === 'them') {
          prev = t.mood; setMood(t.mood);
          (t.revealed || []).forEach(function (n) { round.revealed.push(n); round.revealedText[n] = d.revealedText[n]; });
          if ((t.revealed || []).length) $('#intel').innerHTML = intelChips(round, t.revealed);
        } else {
          round.turns++; $('#pips').innerHTML = turnsPips(round); $('#left').textContent = (round.maxTurns - round.turns) + ' lines left';
        }
        chat.scrollTop = chat.scrollHeight;
      }
      next();
      roundTimer = setInterval(next, 2300);
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- share ---------------- */

  function renderShare(id) {
    loading();
    Promise.all([api('GET', '/api/share/' + encodeURIComponent(id)), loadLib()]).then(function (res) {
      var s = res[0];
      var r = { scenario: s.scenario, scorecard: s.scorecard, status: s.status, difficulty: s.difficulty, moodTrail: s.moodTrail, transcript: s.transcript };
      view.innerHTML = scorecardHtml(r, { handle: s.handle, openTranscript: true }) +
        '<section class="hero" style="margin-top:16px"><h1 style="font-size:24px">Think you can beat ' + esc(s.scorecard.grade) + '?</h1><p>Same opponent, same stakes. Free to try.</p>' +
        '<div class="ctas"><button class="btn" id="tryIt">Take them on</button><a class="btn ghost" href="#/arena">See all scenarios</a></div></section>';
      drawTape(r);
      animateRing();
      $('#tryIt').onclick = function () {
        var lib = state.lib.scenarios.filter(function (x) { return x.id === s.scenario.id; })[0];
        if (lib) openBrief(lib, { scenarioId: lib.id }); else location.hash = '#/arena';
      };
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- progress ---------------- */

  function radar(skills) {
    var names = state.lib.skills;
    var keys = Object.keys(names);
    var cx = 160, cy = 150, R = 105;
    var pt = function (i, v) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / keys.length;
      return [cx + Math.cos(a) * R * v / 10, cy + Math.sin(a) * R * v / 10];
    };
    var rings = [2.5, 5, 7.5, 10].map(function (v) {
      return '<polygon points="' + keys.map(function (_, i) { return pt(i, v).join(','); }).join(' ') + '" fill="none" stroke="var(--line)"/>';
    }).join('');
    var axes = keys.map(function (k, i) {
      var p = pt(i, 10), l = pt(i, 12.6);
      return '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0] + '" y2="' + p[1] + '" stroke="var(--line)"/>' +
        '<text x="' + l[0] + '" y="' + (l[1] + 4) + '" font-size="12" font-weight="700" fill="var(--muted)" text-anchor="middle">' + esc(names[k].replace('Handling ', '')) + '</text>';
    }).join('');
    var shape = keys.map(function (k, i) { return pt(i, skills[k] || 0).join(','); }).join(' ');
    return '<svg class="radar" viewBox="0 0 320 300" role="img" aria-label="Skill profile">' + rings + axes +
      '<polygon points="' + shape + '" fill="color-mix(in srgb, var(--accent) 30%, transparent)" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/></svg>';
  }

  function renderProgress() {
    if (!signedIn()) return signedOutPitch('📈', 'Watch yourself get sharper', 'Every round is scored on five skills. Your profile, streaks, badges and history live here.');
    loading();
    // Inside the lab, a way back to it.
  if (BASE !== '/') {
    var lab = document.createElement('a');
    lab.href = '/'; lab.className = 'pill'; lab.textContent = '🧪 Lab'; lab.style.textDecoration = 'none'; lab.style.color = 'var(--muted)';
    lab.title = 'Back to the challenge lab';
    var brand = document.querySelector('.top .brand');
    brand.parentNode.insertBefore(lab, brand.nextSibling);
  }

  Promise.all([loadMe(), loadLib()]).then(function () {
      var me = state.me, p = me.player;
      var winRate = p.rounds ? Math.round(p.wins / p.rounds * 100) + '%' : '—';
      view.innerHTML =
        '<section class="card"><div class="level-strip"><div class="level-badge">' + p.level.level + '</div><div style="flex:1"><h2>' + esc(p.level.title) + '</h2>' +
        '<div class="bar" style="margin-top:8px"><i style="width:' + Math.round(p.level.progress * 100) + '%"></i></div>' +
        '<div class="small muted" style="margin-top:6px">' + (p.level.next ? (p.level.next - p.level.xp) + ' XP to ' + esc(p.level.nextTitle) : 'Top of the ladder') + '</div></div></div></section>' +
        '<div class="stat-row" style="margin-top:12px"><div class="stat"><b>' + p.rounds + '</b><span>Rounds</span></div><div class="stat"><b>' + p.wins + '</b><span>Wins</span></div>' +
        '<div class="stat"><b>' + winRate + '</b><span>Win rate</span></div><div class="stat"><b>' + p.streak + '🔥</b><span>Streak</span></div></div>' +
        '<div class="dk-split" style="margin-top:0"><div><div class="section-title"><h2>Skill profile</h2></div><section class="card">' +
        (p.rounds ? radar(p.skills) + '<p class="small muted center">Average across ' + p.rounds + ' scored rounds. Weakest: <b>' + esc(weakest(p.skills)) + '</b>.</p>' : '<div class="empty"><div class="e">🎯</div>Finish a round to see your profile.</div>') +
        '</section></div><div><div class="section-title"><h2>Badges</h2><span class="small muted">' + p.badges.filter(function (b) { return b.earned; }).length + ' / ' + p.badges.length + '</span></div>' +
        '<div class="badge-grid">' + p.badges.map(function (b) { return '<div class="bdg' + (b.earned ? '' : ' off') + '" title="' + esc(b.desc) + '"><div class="e">' + b.emoji + '</div><div class="l">' + esc(b.label) + '</div></div>'; }).join('') + '</div></div></div>' +
        '<div class="section-title"><h2>History</h2></div><div class="hist">' +
        (me.recent.length ? me.recent.map(function (s) {
          return '<button data-id="' + esc(s.id) + '"><span class="em">' + esc(s.emoji || '🥊') + '</span><span class="t"><b>' + esc(s.title) + '</b><span class="small muted">' +
            esc(s.status === 'live' ? 'In progress' : s.status === 'won' ? 'Won' : s.status === 'lost' ? 'Lost' : 'Ended') + ' · ' + esc(s.difficulty) + (s.daily ? ' · daily' : '') + ' · ' + timeAgo(s.createdAt) + '</span></span>' +
            '<span class="gr ' + gradeClass(s.grade) + '">' + (s.grade ? esc(s.grade) : s.status === 'live' ? '▶' : '…') + '</span></button>';
        }).join('') : '<div class="empty"><div class="e">🥊</div>No rounds yet. <a href="#/arena">Pick an opponent</a>.</div>') + '</div>';
      $$('.hist button').forEach(function (b) { b.onclick = function () { location.hash = '#/round/' + b.dataset.id; }; });
    }).catch(function (e) { showError(e, view); });
  }

  function weakest(skills) {
    var names = state.lib.skills, lo = null;
    Object.keys(names).forEach(function (k) { if (lo === null || skills[k] < skills[lo]) lo = k; });
    return names[lo];
  }

  function signedOutPitch(emoji, title, text) {
    view.innerHTML = '<section class="hero"><div style="font-size:44px">' + emoji + '</div><h1 style="font-size:28px;margin-top:8px">' + esc(title) + '</h1><p>' + esc(text) + '</p>' +
      '<div class="ctas"><button class="btn" id="pitchSign">Start free</button><a class="btn ghost" href="#/demo">▶ Watch a round</a></div></section>';
    $('#pitchSign').onclick = function () { openAccount(); };
  }

  /* ---------------- build ---------------- */

  var EXAMPLES = [
    'I sell cybersecurity training to a hospital IT director who thinks their staff already know not to click phishing links.',
    'I need to tell my landlord I will be two weeks late on rent for my restaurant, and ask him not to charge the late fee.',
    'Pitching my dog-walking app to a pet store owner so she puts our flyers at the register.',
    'Telling a long-time client we are raising our agency retainer by 20% next quarter.',
  ];

  function renderBuild() {
    if (!signedIn()) return signedOutPitch('🛠️', 'Rehearse YOUR conversation', 'Describe the call you are dreading — your product, your buyer, your numbers. Spar builds an opponent with real reasons to say no.');
    view.innerHTML =
      '<section class="hero"><h1 style="font-size:26px">Build an opponent</h1><p>Describe the conversation you are dreading: who they are, what you want, and why it is hard. Real names, products and numbers make it sharper.</p>' +
      '<textarea class="input" id="desc" maxlength="1200" placeholder="e.g. ' + esc(EXAMPLES[0]) + '"></textarea>' +
      '<div class="chips" style="margin:10px 0 14px">' + EXAMPLES.map(function (e, i) { return '<button class="chip" data-ex="' + i + '">' + esc(e.slice(0, 38)) + '…</button>'; }).join('') + '</div>' +
      '<div id="buildErr"></div><button class="btn" id="buildBtn">✨ Build it</button> <span class="small muted" style="margin-left:8px">About a cent of credit.</span></section>' +
      '<div class="section-title"><h2>Your scenarios</h2></div><div id="mine"><div class="empty"><span class="spinner"></span></div></div>';
    $$('[data-ex]').forEach(function (c) { c.onclick = function () { $('#desc').value = EXAMPLES[Number(c.dataset.ex)]; }; });
    $('#buildBtn').onclick = function () {
      var btn = this; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Building…';
      api('POST', '/api/custom', { description: $('#desc').value }).then(function (s) {
        btn.disabled = false; btn.textContent = '✨ Build it';
        $('#desc').value = '';
        drawMine();
        openBrief(s, { customId: s.id });
      }).catch(function (e) { btn.disabled = false; btn.textContent = '✨ Build it'; showError(e, $('#buildErr')); });
    };
    drawMine();
  }

  function drawMine() {
    Promise.all([api('GET', '/api/custom'), api('GET', '/api/teams')]).then(function (res) {
      var list = res[0].scenarios, teams = res[1].teams.filter(function (t) { return t.owner; });
      var el = $('#mine'); if (!el) return;
      if (!list.length) { el.innerHTML = '<div class="empty"><div class="e">🧪</div>Nothing built yet.</div>'; return; }
      el.innerHTML = '<div class="grid">' + list.map(function (s) {
        return '<div class="scn"><div class="em">' + esc(s.emoji) + '</div><h3>' + esc(s.title) + '</h3><p>' + esc(s.blurb) + '</p>' +
          '<p class="small">vs <b>' + esc(s.them.name) + '</b>, ' + esc(s.them.role) + '</p>' +
          '<div class="row wrap-row" style="margin-top:auto"><button class="btn small" data-play="' + esc(s.id) + '">Play</button>' +
          (teams.length ? '<button class="btn small ghost" data-assign="' + esc(s.id) + '">Assign to team</button>' : '') +
          '<button class="btn small danger" data-del="' + esc(s.id) + '">Delete</button></div></div>';
      }).join('') + '</div>';
      var byId = {}; list.forEach(function (s) { byId[s.id] = s; });
      $$('[data-play]', el).forEach(function (b) { b.onclick = function () { openBrief(byId[b.dataset.play], { customId: b.dataset.play }); }; });
      $$('[data-del]', el).forEach(function (b) {
        b.onclick = function () { if (!confirm('Delete this scenario?')) return; api('DELETE', '/api/custom/' + b.dataset.del).then(drawMine); };
      });
      $$('[data-assign]', el).forEach(function (b) {
        b.onclick = function () { assignSheet(teams, { customId: b.dataset.assign }, byId[b.dataset.assign].title); };
      });
    }).catch(function (e) { showError(e, $('#mine')); });
  }

  /* ---------------- teams ---------------- */

  function renderTeams() {
    if (!signedIn()) return signedOutPitch('🏟️', 'Sales training that reps actually do', 'Make a team, share a code, assign drills — including ones built about your own product. See who practised and how they scored. Nobody sees anyone else’s transcript.');
    loading();
    api('GET', '/api/teams').then(function (r) {
      view.innerHTML =
        '<section class="hero"><h1 style="font-size:26px">Teams</h1><p>For managers and coaches: assign drills, share one code, and watch the leaderboard. Members see scores, never each other’s transcripts.</p>' +
        '<div class="cols two"><form id="mkTeam" class="stack"><input class="input" name="name" maxlength="40" placeholder="Team name, e.g. West Coast AEs" required><button class="btn block">Create team</button></form>' +
        '<form id="joinTeam" class="stack"><input class="input" name="code" maxlength="6" placeholder="Join code, e.g. K7PQ2M" style="text-transform:uppercase;letter-spacing:.15em" required><button class="btn ghost block">Join team</button></form></div><div id="teamErr"></div></section>' +
        '<div class="section-title"><h2>Your teams</h2></div>' +
        (r.teams.length ? '<div class="hist">' + r.teams.map(function (t) {
          return '<button data-id="' + esc(t.id) + '"><span class="em">' + (t.owner ? '👑' : '🏟️') + '</span><span class="t"><b>' + esc(t.name) + '</b><span class="small muted">' + t.members + ' members · ' + t.drills + ' drills' + (t.owner ? ' · you run it' : '') + '</span></span><span class="gr">›</span></button>';
        }).join('') + '</div>' : '<div class="empty"><div class="e">🏟️</div>No teams yet.</div>');
      $$('.hist button').forEach(function (b) { b.onclick = function () { location.hash = '#/team/' + b.dataset.id; }; });
      $('#mkTeam').onsubmit = function (e) {
        e.preventDefault();
        api('POST', '/api/teams', { name: e.target.name.value }).then(function (t) { location.hash = '#/team/' + t.id; }).catch(function (err) { showError(err, $('#teamErr')); });
      };
      $('#joinTeam').onsubmit = function (e) {
        e.preventDefault();
        api('POST', '/api/teams/join', { code: e.target.code.value }).then(function (t) { toast('Joined ' + t.name + '.'); location.hash = '#/team/' + t.id; }).catch(function (err) { showError(err, $('#teamErr')); });
      };
    }).catch(function (e) { showError(e, view); });
  }

  function joinTeam(code) {
    if (!signedIn()) {
      store('spar.pendingJoin', code);
      signedOutPitch('🏟️', 'You’ve been invited to a team', 'Create a free account (or sign in) and you’ll join automatically.');
      return openAccount('Sign up or sign in to join the team.');
    }
    api('POST', '/api/teams/join', { code: code }).then(function (t) { toast('Joined ' + t.name + '.'); location.replace('#/team/' + t.id); })
      .catch(function (e) { showError(e, view); });
  }

  function renderTeam(id) {
    if (!signedIn()) return renderTeams();
    loading();
    Promise.all([api('GET', '/api/teams/' + encodeURIComponent(id)), loadLib()]).then(function (res) {
      var t = res[0];
      var link = location.origin + BASE + '#/join/' + t.code;
      var html = '<div class="row spread" style="margin-bottom:12px"><button class="btn small ghost" id="toTeams">← Teams</button><button class="btn small danger" id="leave">' + (t.owner ? 'Delete team' : 'Leave') + '</button></div>' +
        '<section class="hero"><div class="small muted">' + (t.owner ? 'You run this team' : 'Run by ' + esc(t.ownerHandle)) + '</div><h1 style="font-size:28px;margin-top:4px">' + esc(t.name) + '</h1>' +
        '<div class="row wrap-row" style="margin-top:14px"><div><div class="small muted">Invite code</div><div class="code">' + esc(t.code) + '</div></div><span style="flex:1"></span><button class="btn small" id="invite">Invite</button></div></section>';

      html += '<div class="dk-split dk-split-aside"><div>';
      html += '<div class="section-title"><h2>Drills</h2>' + (t.owner ? '<button class="btn small" id="addDrill">+ Add drill</button>' : '') + '</div>';
      html += t.assignments.length ? t.assignments.map(function (a) {
        var me = t.members.filter(function (m) { return m.you; })[0];
        var best = me && me.drills[a.id];
        return '<div class="drill"><span class="em">' + esc(a.scenario.emoji) + '</span><div class="t"><b>' + esc(a.scenario.title) + '</b>' +
          '<div class="small muted">' + esc(a.difficulty) + ' · ' + a.done + '/' + t.members.length + ' done' + (best != null ? ' · your best ' + best : '') + '</div>' +
          (a.note ? '<div class="small" style="margin-top:4px">📝 ' + esc(a.note) + '</div>' : '') + '</div>' +
          '<div class="row"><button class="btn small" data-play="' + esc(a.id) + '">' + (best != null ? 'Again' : 'Play') + '</button>' +
          (t.owner ? '<button class="btn small danger" data-rm="' + esc(a.id) + '" aria-label="Remove">✕</button>' : '') + '</div></div>';
      }).join('') : '<div class="empty"><div class="e">📋</div>' + (t.owner ? 'Add a drill — any library scenario, or one you built about your own product.' : 'No drills assigned yet.') + '</div>';

      html += '<div class="section-title"><h2>Leaderboard</h2></div><section class="card scroll-x"><table class="tbl"><thead><tr><th>#</th><th>Player</th><th>Level</th><th class="n">Team avg</th><th class="n">Rounds</th>' +
        t.assignments.map(function (a) { return '<th class="n" title="' + esc(a.scenario.title) + '">' + esc(a.scenario.emoji) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        t.members.map(function (m, i) {
          return '<tr' + (m.you ? ' style="background:var(--fill)"' : '') + '><td>' + (i + 1) + '</td><td><b>' + esc(m.handle) + '</b>' + (m.owner ? ' 👑' : '') + (m.streak ? ' <span class="small">🔥' + m.streak + '</span>' : '') + '</td>' +
            '<td>' + m.level.level + ' <span class="small muted">' + esc(m.level.title) + '</span></td><td class="n">' + (m.teamAvg != null ? m.teamAvg : '—') + '</td><td class="n">' + m.teamRounds + '</td>' +
            t.assignments.map(function (a) { var v = m.drills[a.id]; return '<td class="n">' + (v != null ? v : '<span class="faint">—</span>') + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table></section>';
      html += '</div><aside class="dk-sticky"><div class="section-title"><h2>Team skills</h2></div><section class="card">' + teamRadar(t) + '</section>' +
        '<div class="section-title"><h2>Activity</h2></div><section class="card feed">' +
        (t.feed.length ? t.feed.map(function (f) {
          return '<div class="f"><span>' + esc(f.emoji) + '</span><span style="flex:1;min-width:0"><b>' + esc(f.handle) + '</b> ' + (f.status === 'won' ? 'won' : f.status === 'lost' ? 'lost' : 'played') + ' <span class="muted">' + esc(f.title) + '</span><div class="small faint">' + timeAgo(f.at) + '</div></span><span class="gr ' + gradeClass(f.grade) + '">' + esc(f.grade) + '</span></div>';
        }).join('') : '<div class="empty small">Nothing yet — play a drill.</div>') + '</section></aside></div>';
      view.innerHTML = html;

      $('#toTeams').onclick = function () { location.hash = '#/teams'; };
      $('#invite').onclick = function () {
        var text = 'Join my team "' + t.name + '" on Spar — practise hard conversations and see how you stack up. Code: ' + t.code;
        if (navigator.share) navigator.share({ title: 'Join ' + t.name, text: text, url: link }).catch(function () {});
        else if (navigator.clipboard) navigator.clipboard.writeText(text + ' ' + link).then(function () { toast('Invite copied.'); });
        else prompt('Share this link:', link);
      };
      $('#leave').onclick = function () {
        if (!confirm(t.owner ? 'Delete this team for everyone?' : 'Leave this team?')) return;
        api('POST', '/api/teams/' + t.id + '/leave').then(function () { location.hash = '#/teams'; }).catch(function (e) { showError(e); });
      };
      var add = $('#addDrill');
      if (add) add.onclick = function () { assignSheet([{ id: t.id, name: t.name }], null, null, function () { renderTeam(id); }); };
      $$('[data-play]').forEach(function (b) {
        b.onclick = function () {
          var a = t.assignments.filter(function (x) { return x.id === b.dataset.play; })[0];
          openBrief(a.scenario, { teamId: t.id, assignmentId: a.id }, a.note ? 'Coach’s note: ' + a.note : null);
        };
      });
      $$('[data-rm]').forEach(function (b) {
        b.onclick = function () { api('DELETE', '/api/teams/' + t.id + '/assignments/' + b.dataset.rm).then(function () { renderTeam(id); }); };
      });
    }).catch(function (e) { showError(e, view); });
  }

  function teamRadar(t) {
    var withSkills = t.members.filter(function (m) { return m.skills && m.level && m.teamRounds; });
    if (!withSkills.length) return '<div class="empty small">Appears once members finish drills.</div>';
    var avg = {};
    Object.keys(state.lib.skills).forEach(function (k) {
      avg[k] = withSkills.reduce(function (a, m) { return a + (m.skills[k] || 0); }, 0) / withSkills.length;
    });
    return radar(avg) + '<p class="small muted center">Team weak spot: <b>' + esc(weakest(avg)) + '</b> — a good next drill.</p>';
  }

  /** Assign a drill: pick a team (when there is more than one), a scenario, a difficulty and a note. */
  function assignSheet(teams, preset, presetTitle, done) {
    Promise.all([loadLib(), api('GET', '/api/custom')]).then(function (res) {
      var lib = res[0], mine = res[1].scenarios;
      var opts = preset ? '' :
        '<label class="field"><span>Scenario</span><select class="input" id="aScn">' +
        '<optgroup label="Library">' + lib.scenarios.map(function (s) { return '<option value="lib:' + esc(s.id) + '">' + s.emoji + ' ' + esc(s.title) + '</option>'; }).join('') + '</optgroup>' +
        (mine.length ? '<optgroup label="Built by you">' + mine.map(function (s) { return '<option value="custom:' + esc(s.id) + '">' + esc(s.emoji) + ' ' + esc(s.title) + '</option>'; }).join('') + '</optgroup>' : '') +
        '</select></label>';
      sheet('<h2>Assign a drill</h2>' + (presetTitle ? '<p class="muted">' + esc(presetTitle) + '</p>' : '') +
        (teams.length > 1 ? '<label class="field"><span>Team</span><select class="input" id="aTeam">' + teams.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('') + '</select></label>' : '') +
        opts +
        '<label class="field"><span>Difficulty</span><select class="input" id="aDiff">' + Object.keys(lib.difficulties).map(function (k) { return '<option value="' + k + '"' + (k === 'realistic' ? ' selected' : '') + '>' + esc(lib.difficulties[k].label) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Note for the team (optional)</span><input class="input" id="aNote" maxlength="200" placeholder="e.g. Focus on discovery before you mention price"></label>' +
        '<div id="aErr"></div><button class="btn block" id="aGo">Assign</button>',
        function (root) {
          $('#aGo', root).onclick = function () {
            var teamId = teams.length > 1 ? $('#aTeam', root).value : teams[0].id;
            var body = { difficulty: $('#aDiff', root).value, note: $('#aNote', root).value };
            if (preset) Object.assign(body, preset);
            else {
              var v = $('#aScn', root).value.split(':');
              if (v[0] === 'lib') body.scenarioId = v[1]; else body.customId = v[1];
            }
            api('POST', '/api/teams/' + teamId + '/assignments', body).then(function () {
              closeSheet(); toast('Drill assigned.');
              if (done) done();
            }).catch(function (e) { showError(e, $('#aErr', root)); });
          };
        });
    }).catch(function (e) { showError(e); });
  }

  /* ---------------- boot ---------------- */

  // Stripe sends buyers back with a flag; say thank you once and tidy the URL.
  var qs = new URLSearchParams(location.search);
  if (qs.get('member') || qs.get('credited')) {
    setTimeout(function () { toast(qs.get('member') ? 'Welcome, member. The better model is on.' : 'Credit added.'); }, 400);
    history.replaceState(null, '', location.pathname + location.hash);
  }
  if (qs.get('s')) { location.hash = '#/share/' + qs.get('s'); history.replaceState(null, '', location.pathname + location.hash); }
  var topup = qs.get('topup');

  // Inside the lab, a way back to it.
  if (BASE !== '/') {
    var lab = document.createElement('a');
    lab.href = '/'; lab.className = 'pill'; lab.textContent = '🧪 Lab'; lab.style.textDecoration = 'none'; lab.style.color = 'var(--muted)';
    lab.title = 'Back to the challenge lab';
    var brand = document.querySelector('.top .brand');
    brand.parentNode.insertBefore(lab, brand.nextSibling);
  }

  Promise.all([loadMe(), loadLib()]).then(function () {
    route();
    if (topup) { history.replaceState(null, '', location.pathname + location.hash); signedIn() ? openProfileSheet() : openAccount(); }
  });
})();
