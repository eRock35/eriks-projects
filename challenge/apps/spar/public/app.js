/* Spar - the page. One file, no build step, every model-written string escaped.
   The page writes no style attribute (app.css explains): anything that depends
   on data - a bar's width, the mood knob's place - is a class. */
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
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
  }

  /** A 402 is a till, not a wall: say what happened and where to go. */
  function showError(err, where) {
    if (err && err.status === 402) return openCreditSheet(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) { where.innerHTML = '<div class="err" role="alert">' + esc(msg) + '</div>'; } else { toast(msg, 4500); }
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

  // The mood is told in words; the colour (three status tones) only backs it up.
  var MOODS = ['Hostile', 'Hostile', 'Cold', 'Cold', 'Guarded', 'Neutral', 'Warming', 'Warming', 'Engaged', 'Engaged', 'Sold'];
  function mood(m) {
    var n = Math.max(-5, Math.min(5, Math.round(Number(m) || 0)));
    return { n: n, label: MOODS[n + 5], tone: n <= -2 ? 'bad' : n >= 2 ? 'good' : 'warn' };
  }

  // A width that depends on data is a class (p0..p20, 5% steps).
  function bar(pct, cls) {
    var step = Math.max(0, Math.min(20, Math.round((Number(pct) || 0) / 5)));
    return '<span class="bar ' + (cls || '') + ' p' + step + '"><i></i></span>';
  }

  var ICONS = {
    back: '<path d="m15 18-6-6 6-6"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    send: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
    lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    open: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.6-1.6"/>',
    bulb: '<path d="M9.5 17.5h5M10.5 20.5h3"/><path d="M12 3.5a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2h5c0-.8.4-1.5 1-2A6 6 0 0 0 12 3.5z"/>',
    sound: '<path d="M4.5 9.5v5H8l4.5 3.5V6L8 9.5z"/><path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
    flag: '<path d="M6 20.5v-16"/><path d="M6 5h11l-2 4 2 4H6"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  };
  function ic(name) { return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>'; }

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
      el.innerHTML = '<button class="btn small ghost" id="signInTop" type="button">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var p = me.player;
    el.innerHTML =
      (p.streak ? '<span class="stat-chip"><b>' + p.streak + '</b>-day streak</span>' : '<span class="stat-chip"><b>' + p.level.xp + '</b> XP</span>') +
      '<button class="avatar-btn" id="acctBtn" type="button" aria-label="Account"><span>' + esc(initials(p.handle)) + '</span></button>';
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
        '<h2>' + (mode === 'register' ? 'Create your account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Free account, with $2 of AI credit to start — roughly 20 practice rounds. One account works across every app on this site.'
          : 'Same account as the other apps on this site.')) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create account' : 'Sign in') + '</button>' +
        '</form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block mt12" id="pkBtn" type="button">Sign in with Face ID / passkey</button>' : '') +
        '<p class="center small muted mt16 mb0">' +
        (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') +
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
      toast('You’re in. Pick an opponent.');
    });
  }

  function openProfileSheet() {
    var me = state.me;
    var b = me.budget || {};
    var remaining = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    var pct = b.unlimited ? 100 : Math.max(0, Math.min(100, (b.remainingUsd / (b.allowanceUsd || 1)) * 100));
    sheet(
      '<div class="row spread"><h2 class="mb0">' + esc(me.player.handle) + '</h2><span class="tag">Level ' + me.player.level.level + ' · ' + esc(me.player.level.title) + '</span></div>' +
      '<p class="muted small mt8">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'Member model (Sonnet)' : 'Free model (Haiku)') + '</p>' +
      '<div class="credit"><div class="row spread mb8"><b>AI credit</b><span class="num">' + remaining + '</span></div>' +
      bar(pct, 'accent') +
      '<p class="small muted mt12 mb0">Starting a round is free. Each line you say costs a fraction of a cent; a scorecard about a cent.</p>' +
      '<div id="billing" class="mt12"></div></div>' +
      '<label class="field"><span>Display name (shown on leaderboards)</span><div class="row"><input class="input" id="handleIn" maxlength="24" value="' + esc(me.player.handle) + '"><button class="btn small" id="handleSave" type="button">Save</button></div></label>' +
      (me.player.publicHandle && me.player.publicHandle !== me.player.handle ? '<p class="small muted">Leaderboards show you as <b>' + esc(me.player.publicHandle) + '</b> until you save a name.</p>' : '') +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block mt12" id="signOut" type="button">Sign out</button>',
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
        el.innerHTML = '<button class="btn small" id="joinM" type="button">Become a member · $' + esc(b.monthlyUsd) + '/mo</button>' +
          '<p class="small muted mt8 mb0">Membership covers every app on this site, runs the better model, and lets you add credit.</p>';
        $('#joinM', el).onclick = function () { checkout('/api/auth/billing/membership', {}); };
        return;
      }
      el.innerHTML = '<div class="row wrap-row">' + (b.topUps || []).map(function (t) {
        return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>';
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
    $$('[data-tab]').forEach(function (b) {
      var t = b.dataset.tab;
      var on = t === tab || (t === 'teams' && (tab === 'team' || tab === 'join'));
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
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
  $$('[data-tab]').forEach(function (b) {
    b.onclick = function () { location.hash = '#/' + b.dataset.tab; };
  });
  window.addEventListener('hashchange', route);

  function loading() { view.innerHTML = '<div class="empty"><span class="spinner" role="status" aria-label="Loading"></span></div>'; }

  /* ---------------- home ---------------- */

  function levelLine(p) {
    return '<div class="level"><div class="row spread"><span><b>Level ' + p.level.level + ' · ' + esc(p.level.title) + '</b></span><span class="small muted num">' +
      (p.level.next ? p.level.xp + ' / ' + p.level.next + ' XP' : p.level.xp + ' XP · top level') + '</span></div>' +
      bar(p.level.progress * 100, 'accent') +
      '<div class="small muted num">' + p.rounds + ' rounds · ' + p.wins + ' wins' + (p.streak ? ' · ' + p.streak + '-day streak' : '') + '</div></div>';
  }

  function renderArena() {
    loading();
    Promise.all([loadLib(), api('GET', '/api/daily').catch(function () { return null; })]).then(function (r) {
      var lib = r[0]; state.daily = r[1];
      var me = state.me || {};
      var html = '';
      if (!me.signedIn) {
        html += '<section class="hero"><h1>Practise the conversation before it counts.</h1>' +
          '<p>A counterpart who pushes back like a real person. Then a coach’s scorecard, in your own words.</p>' +
          '<div class="ctas"><button class="btn" id="heroSign" type="button">Start free</button><a class="btn ghost" href="#/demo">Watch a round</a></div></section>';
      } else {
        html += '<section class="page-head"><h1>Who are you up against?</h1>' + levelLine(me.player) + '</section>';
      }
      html += '<div class="split">' +
        '<aside>' + (state.daily ? '<div class="section-title"><h2>Today’s challenge</h2><span class="small num">' + esc(state.daily.challenge.day) + '</span></div>' + dailyCard(state.daily) : '') + '</aside>' +
        '<div class="main"><div class="section-title"><h2>Pick your opponent</h2><span class="small">' + lib.scenarios.length + ' scenarios</span></div>' +
        '<div class="chips" id="cats"><button class="chip" type="button" aria-pressed="' + (state.category === 'all') + '" data-cat="all">All</button>' +
        Object.keys(lib.categories).map(function (k) {
          return '<button class="chip" type="button" aria-pressed="' + (state.category === k) + '" data-cat="' + k + '">' + esc(lib.categories[k].label) + '</button>';
        }).join('') + '</div>' +
        '<div class="list mt12" id="scnGrid"></div></div></div>';
      view.innerHTML = html;

      var hs = $('#heroSign'); if (hs) hs.onclick = function () { openAccount(); };
      $$('#cats .chip').forEach(function (c) {
        c.onclick = function () {
          state.category = c.dataset.cat;
          $$('#cats .chip').forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
          drawGrid();
        };
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
    g.innerHTML =
      '<a class="item" href="#/build"><span class="em">' + ic('plus') + '</span><span class="t"><b>Describe your own</b><span>The conversation you are dreading. Spar builds the person across the table.</span></span><span class="end"><span class="chev">' + ic('chev') + '</span></span></a>' +
      list.map(function (s) {
        return '<button class="item" type="button" data-id="' + esc(s.id) + '"><span class="em" aria-hidden="true">' + esc(s.emoji) + '</span><span class="t"><b>' + esc(s.title) + '</b><span>' + esc(s.blurb) + '</span></span>' +
          '<span class="end">' + (best[s.id] != null ? '<span>Best ' + best[s.id] + '</span>' : '') + '<span class="chev">' + ic('chev') + '</span></span></button>';
      }).join('');
    $$('.item[data-id]', g).forEach(function (b) {
      b.onclick = function () {
        var s = lib.scenarios.filter(function (x) { return x.id === b.dataset.id; })[0];
        openBrief(s, { scenarioId: s.id });
      };
    });
  }

  function dailyCard(d) {
    var s = d.challenge.scenario;
    var board = d.board.slice(0, 5);
    return '<section class="daily"><h3>' + esc(s.title) + '</h3>' +
      '<div class="twist"><b>Today’s twist.</b> ' + esc(d.challenge.twist) + '</div>' +
      '<button class="btn block" id="dailyPlay" type="button">' + (d.mine ? 'Beat your ' + d.mine.score : 'Take the challenge') + '</button>' +
      '<div class="board">' + (board.length ? board.map(function (r) {
        return '<div class="r' + (r.you ? ' you' : '') + '"><span class="rank">' + r.rank + '</span><span>' + esc(r.handle) + (r.you ? ' (you)' : '') + '</span><span class="muted">' + esc(r.grade) + '</span><b>' + r.score + '</b></div>';
      }).join('') : '<div class="none">Nobody on the board yet today. Be first: +25 XP.</div>') + '</div></section>';
  }

  function startDaily() {
    var d = state.daily;
    openBrief(d.challenge.scenario, { daily: true }, d.challenge.twist);
  }

  /* ---------------- brief & start ---------------- */

  function openBrief(s, startBody, twist) {
    var lib = state.lib || { difficulties: {} };
    var diff = store('spar.diff') || 'realistic';
    if (!lib.difficulties[diff]) diff = 'realistic';
    var fixed = startBody.daily || startBody.assignmentId;
    var row = function (k, v) { return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'; };
    sheet(
      '<div class="sheet-head"><span class="em" aria-hidden="true">' + esc(s.emoji) + '</span><div><h2 class="mb0">' + esc(s.title) + '</h2><div class="muted small">' + esc(s.blurb || '') + '</div></div></div>' +
      '<dl class="brief">' +
      row('You are', esc(s.youAre)) +
      row('Across the table', '<b>' + esc(s.them.name) + '</b> — ' + esc(s.them.role) + ', ' + esc(s.them.company)) +
      row('Your goal', esc(s.goal)) +
      row('You win when', esc(s.win)) +
      (twist ? row('Today’s twist', esc(twist)) : '') +
      '</dl>' +
      (fixed ? '' : '<div class="eyebrow">How hard</div><div class="seg" id="diffPick">' +
        Object.keys(lib.difficulties).map(function (k) {
          var d = lib.difficulties[k];
          return '<button type="button" data-d="' + k + '" aria-pressed="' + (k === diff) + '">' + esc(d.label) + '<small>' + d.turns + ' lines · ' + d.mult + 'x XP</small></button>';
        }).join('') + '</div><p class="small muted note-min mt8" id="diffNote">' + esc((lib.difficulties[diff] || {}).note || '') + '</p>') +
      '<p class="small muted">They are holding back what would really move them. Good questions bring it out. They push back hard, and never get personal.</p>' +
      '<div id="briefErr"></div><button class="btn block" id="go" type="button">' + (signedIn() ? 'Start the conversation' : 'Sign up free to play') + '</button>' +
      '<p class="center small muted mt12 mb0">Starting is free. You only spend credit when you speak.</p>',
      function (root) {
        $$('#diffPick button', root).forEach(function (b) {
          b.onclick = function () {
            diff = b.dataset.d; store('spar.diff', diff);
            $$('#diffPick button', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
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
      document.body.classList.remove('in-round');
      if (e.status === 401) { openAccount('Sign in to see that round.'); view.innerHTML = ''; return; }
      showError(e, view);
    });
  }

  function intelChips(r, pop) {
    var out = '';
    for (var i = 1; i <= r.hiddenCount; i++) {
      var t = r.revealedText[i];
      out += t
        ? '<span class="i open' + (pop && pop.indexOf(i) >= 0 ? ' pop' : '') + '">' + ic('open') + '<span>' + esc(t) + '</span></span>'
        : '<span class="i">' + ic('lock') + 'Motive ' + i + ' hidden</span>';
    }
    return out;
  }

  function drawRound() {
    var r = round;
    var s = r.scenario;
    var m = mood(r.mood);
    document.body.classList.add('in-round');
    view.innerHTML =
      '<div class="round">' +
      '<div class="opp">' +
      '<div class="opp-head"><button class="icon-btn" id="back" type="button" aria-label="Back">' + ic('back') + '</button>' +
      '<div class="face m-' + m.tone + '" id="face" aria-hidden="true">' + esc(initials(s.them.name)) + '</div>' +
      '<div class="grow"><div class="opp-name">' + esc(s.them.name) + '</div><div class="opp-role">' + esc(s.them.role) + ' · ' + esc(s.them.company) + '</div></div>' +
      '<div class="left"><b id="left">' + (r.maxTurns - r.turns) + '</b>lines left</div></div>' +
      '<div class="meter"><div class="meter-track"><div class="meter-knob pos' + (m.n + 5) + '" id="knob"></div></div>' +
      '<div class="meter-labels"><span>Hostile</span><b id="moodLbl" class="m-' + m.tone + '" aria-live="polite">' + m.label + '</b><span>Sold</span></div></div>' +
      '<div class="intel" id="intel">' + intelChips(r) + '</div>' +
      '</div>' +
      '<div class="chat" id="chat" aria-live="polite"></div>' +
      '<div id="overBox"></div>' +
      '<div class="composer" id="composer">' +
      '<div class="tools">' +
      '<button class="tool" id="hintBtn" type="button">' + ic('bulb') + 'Whisper · <span id="hintLeft">' + (r.maxHints - r.hintsUsed) + '</span></button>' +
      (synth ? '<button class="tool" id="voiceBtn" type="button" aria-pressed="' + voiceOn() + '">' + ic('sound') + 'Voice</button>' : '') +
      '<button class="tool end" id="endBtn" type="button">' + ic('flag') + 'End<span class="wide">&nbsp;and score</span></button></div>' +
      '<div class="line">' +
      (SR ? '<button class="icon-btn" id="micBtn" type="button" aria-label="Speak">' + ic('mic') + '</button>' : '') +
      '<textarea id="say" rows="1" maxlength="700" aria-label="Your line" placeholder="Say something to ' + esc(s.them.name.split(' ')[0]) + '…"></textarea>' +
      '<button class="icon-btn send" id="sendBtn" type="button" aria-label="Send">' + ic('send') + '</button>' +
      '</div></div></div>';

    var chat = $('#chat');
    var prev = null;
    if (r.twist) chat.insertAdjacentHTML('beforeend', '<div class="system-note">' + (r.daily ? 'Daily challenge · ' : '') + esc(r.twist) + '</div>');
    r.transcript.forEach(function (t) { addMsg(t, prev); if (t.who === 'them') prev = t.mood; });
    chat.scrollTop = chat.scrollHeight;
    if (r.transcript.length === 1) speak(r.transcript[0].text, s.them.name);

    $('#back').onclick = function () { history.length > 1 ? history.back() : (location.hash = '#/arena'); };
    $('#sendBtn').onclick = send;
    var ta = $('#say');
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    // Where the box cannot size itself to its content, grow it a row at a time.
    ta.addEventListener('input', function () { ta.rows = Math.min(5, Math.max(1, ta.value.split('\n').length, Math.ceil(ta.value.length / 38))); });
    $('#hintBtn').onclick = whisper;
    if (r.hintsUsed >= r.maxHints) $('#hintBtn').disabled = true;
    $('#endBtn').onclick = function () {
      if (round.status === 'live' && !confirm('End the conversation here and get your scorecard?')) return;
      finish();
    };
    var vb = $('#voiceBtn');
    if (vb) vb.onclick = function () { store('spar.voice', voiceOn() ? '0' : '1'); vb.setAttribute('aria-pressed', String(voiceOn())); if (!voiceOn()) stopSpeaking(); };
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
        (prevMood != null ? '<div class="delta ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : '') + '">' + mood(t.mood).label + ' · ' + (delta > 0 ? 'mood +' + delta : delta < 0 ? 'mood −' + Math.abs(delta) : 'no change') + '</div>' : '') +
        ((t.revealed || []).length ? '<div class="found">You uncovered a hidden motive · +10 XP</div>' : '') +
        (t.note ? '<div class="note">Coach: ' + esc(t.note) + '</div>' : '') +
        '</div>';
    }
    chat.insertAdjacentHTML('beforeend', html);
  }

  function setMood(n) {
    var m = mood(n);
    var knob = $('#knob'); if (knob) knob.className = 'meter-knob pos' + (m.n + 5);
    var lbl = $('#moodLbl'); if (lbl) { lbl.textContent = m.label; lbl.className = 'm-' + m.tone; }
    var face = $('#face'); if (face) face.className = 'face m-' + m.tone;
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
    ta.value = ''; ta.rows = 1;
    var chat = $('#chat');
    chat.insertAdjacentHTML('beforeend', '<div class="msg-row them typing" id="typing"><div class="bubble"><i></i><i></i><i></i><span class="vh">Thinking</span></div></div>');
    chat.scrollTop = chat.scrollHeight;
    $('#sendBtn').disabled = true;
    api('POST', '/api/rounds/' + round.id + '/say', { text: text }).then(function (r) {
      round = r;
      var t = $('#typing'); if (t) t.remove();
      var last = r.transcript[r.transcript.length - 1];
      addMsg(last, prevMood);
      chat.scrollTop = chat.scrollHeight;
      setMood(r.mood);
      $('#left').textContent = r.maxTurns - r.turns;
      $('#intel').innerHTML = intelChips(r, r.newlyRevealed);
      if ((r.newlyRevealed || []).length) toast('Hidden motive uncovered.');
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
      chat.insertAdjacentHTML('beforeend', '<div class="whisper"><div class="eyebrow">Coach’s whisper</div>' + esc(h.hint) +
        '<div class="try">“' + esc(h.tryLine) + '”</div><button class="btn small ghost use" type="button">Use this line</button></div>');
      var w = $$('.whisper', chat).pop();
      $('.use', w).onclick = function () { var ta = $('#say'); ta.value = h.tryLine; ta.dispatchEvent(new Event('input')); ta.focus(); };
      chat.scrollTop = chat.scrollHeight;
      if (h.hintsUsed < h.maxHints) btn.disabled = false;
    }).catch(function (e) { btn.disabled = false; showError(e); });
  }

  function showOver() {
    var r = round;
    var comp = $('#composer'); if (comp) comp.classList.add('hidden');
    var title = r.status === 'won' ? 'They said yes.' : r.status === 'lost' ? 'They walked.' : 'That’s time.';
    var sub = r.status === 'won' ? 'You got the commitment. Let’s see how clean it was.'
      : r.status === 'lost' ? 'It happens in the real world too. The scorecard shows where it turned.'
        : 'Out of lines. Here’s how it went.';
    $('#overBox').innerHTML = '<div class="over"><h3>' + title + '</h3><p>' + sub + '</p>' +
      '<button class="btn block" id="scoreBtn" type="button">Get my scorecard</button></div>';
    $('#scoreBtn').onclick = finish;
    var chat = $('#chat'); chat.scrollTop = chat.scrollHeight;
  }

  function finish() {
    var box = $('#overBox');
    var comp = $('#composer'); if (comp) comp.classList.add('hidden');
    box.innerHTML = '<div class="over"><span class="spinner"></span><p class="mt12 mb0" role="status">The coach is reading back what you said…</p></div>';
    stopSpeaking();
    api('POST', '/api/rounds/' + round.id + '/finish').then(function (r) {
      if (r.abandoned) { toast('Round discarded — you did not say anything.'); location.hash = '#/arena'; return; }
      round = r;
      loadMe();
      drawScorecard(r, true);
    }).catch(function (e) {
      box.innerHTML = '<div class="over"><p class="err" role="alert">' + esc(e.message) + '</p><div class="row"><button class="btn block" id="retryScore" type="button">Try again</button>' +
        (round.status === 'live' ? '<button class="btn ghost block" id="keepGoing" type="button">Keep talking</button>' : '') + '</div></div>';
      $('#retryScore').onclick = finish;
      var kg = $('#keepGoing');
      if (kg) kg.onclick = function () { box.innerHTML = ''; if (comp) comp.classList.remove('hidden'); };
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
        ta.dispatchEvent(new Event('input'));
      };
      rec.onend = function () { rec = null; btn.classList.remove('rec'); btn.setAttribute('aria-label', 'Speak'); };
      rec.onerror = function (e) { if (e.error === 'not-allowed') toast('Microphone access is off for this site.'); };
      try { rec.start(); btn.classList.add('rec'); btn.setAttribute('aria-label', 'Stop listening'); } catch (e) { rec = null; }
    };
  }

  /* ---------------- scorecard ---------------- */

  var RING = 2 * Math.PI * 64;
  function ring(score, grade) {
    var off = RING * (1 - Math.max(0, Math.min(100, score)) / 100);
    return '<div class="ring"><svg viewBox="0 0 150 150" aria-hidden="true"><circle class="track" cx="75" cy="75" r="64"/>' +
      '<circle class="ring-arc" cx="75" cy="75" r="64" stroke-dasharray="' + RING.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg>' +
      '<div class="val"><div class="g">' + esc(grade) + '</div><div class="n">' + score + ' / 100</div></div></div>';
  }

  function moodChart(trail) {
    if (!trail || trail.length < 2) return '<p class="muted small">Not enough of a conversation to chart.</p>';
    var w = 320, h = 120, pad = 14;
    var step = (w - pad * 2) / (trail.length - 1);
    var y = function (m) { return pad + (5 - m) * (h - pad * 2) / 10; };
    var pts = trail.map(function (m, i) { return (pad + i * step).toFixed(1) + ',' + y(m).toFixed(1); }).join(' ');
    var dots = trail.map(function (m, i) { return '<circle class="d-' + mood(m).tone + '" cx="' + (pad + i * step).toFixed(1) + '" cy="' + y(m).toFixed(1) + '" r="3.5"/>'; }).join('');
    var first = mood(trail[0]).label, last = mood(trail[trail.length - 1]).label;
    return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Their mood over the conversation: from ' + first + ' to ' + last + '">' +
      '<line class="zero" x1="' + pad + '" x2="' + (w - pad) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>' +
      '<polyline class="trail" points="' + pts + '"/>' + dots +
      '<text x="' + pad + '" y="11">Sold</text><text x="' + pad + '" y="' + (h - 2) + '">Hostile</text></svg>' +
      '<p class="small muted mt8 mb0">Started ' + first.toLowerCase() + ', ended ' + last.toLowerCase() + '.</p>';
  }

  function skillNames() {
    return (state.lib && state.lib.skills) || { rapport: 'Rapport', discovery: 'Discovery', pushback: 'Handling pushback', clarity: 'Clarity', close: 'Closing' };
  }

  function skillBars(sk) {
    var names = skillNames();
    return '<div class="skillbars">' + Object.keys(names).map(function (k) {
      var v = sk[k] || 0;
      return '<div class="s"><span>' + esc(names[k]) + '</span>' + bar(v * 10) + '<b>' + v + '</b></div>';
    }).join('') + '</div>';
  }

  /** The coach's moments: each hangs on something the player really said (the
   *  server checks every quote against their lines and drops the rest). */
  function momentsHtml(c) {
    var list = c.moments || [];
    if (!list.length) return '';
    var names = skillNames();
    return '<section class="section"><div class="section-title"><h2>In your words</h2><span class="small">Quoted from what you said</span></div><div class="moments">' +
      list.map(function (m) {
        var ok = m.verdict === 'worked';
        return '<div class="moment"><div class="meta"><span class="tag ' + (ok ? 'good' : 'bad') + '">' + (ok ? 'Worked' : 'Missed') + '</span><span>' + esc(names[m.skill] || m.skill) + '</span></div>' +
          '<blockquote class="quote ' + (ok ? 'worked' : 'missed') + '">“' + esc(m.quote) + '”</blockquote><p>' + esc(m.note) + '</p></div>';
      }).join('') + '</div></section>';
  }

  /** Draw a scored round. Shared with the demo and with public share links. */
  function scorecardHtml(r, opts) {
    opts = opts || {};
    var c = r.scorecard;
    var s = r.scenario;
    var a = r.award || r.xp || null;
    var out = r.status === 'won' ? 'Won' : r.status === 'lost' ? 'They walked' : 'Out of time';
    var tone = r.status === 'won' ? 'good' : r.status === 'lost' ? 'bad' : 'warn';
    var html = '<section class="score-hero narrow">' +
      '<div class="row center gain"><span class="tag ' + tone + '">' + out + '</span><span class="tag">' + esc(s.title) + '</span></div>' +
      (opts.handle ? '<div class="small muted mt8">' + esc(opts.handle) + ' · ' + esc(r.difficulty) + '</div>' : '') +
      ring(c.overall, c.grade) +
      '<p class="headline">' + esc(c.headline) + '</p>';
    var gains = [];
    if (a && a.gained) gains.push('<span class="tag">+' + a.gained + ' XP' + (a.personalBest ? ' · personal best' : '') + '</span>');
    if (a && a.levelUp) gains.push('<span class="tag good">Level ' + a.levelUp.level + ' · ' + esc(a.levelUp.title) + '</span>');
    if (a && a.earned) a.earned.forEach(function (b) { gains.push('<span class="tag good">Badge: ' + esc(b.label) + '</span>'); });
    if (gains.length) html += '<div class="gain">' + gains.join('') + '</div>';
    html += '</section>';

    html += '<div class="narrow">' + momentsHtml(c) + '</div>';

    html += '<div class="cols two section">' +
      '<section><h2 class="mb16">Skills</h2>' + skillBars(c.skills) + '</section>' +
      '<section><h2 class="mb16">Their mood</h2>' + moodChart(r.moodTrail) + '</section></div>';

    html += '<div class="cols two section">' +
      '<section><h2>What worked</h2><ul class="list-tight">' + c.strengths.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      (c.bestLine && c.bestLine.quote ? '<div class="take"><div class="eyebrow">Your best line</div><blockquote class="quote worked">“' + esc(c.bestLine.quote) + '”</blockquote><p>' + esc(c.bestLine.why) + '</p></div>' : '') + '</section>' +
      '<section><h2>Work on</h2><ul class="list-tight">' + c.improve.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      (c.missedMoment && c.missedMoment.quote ? '<div class="take"><div class="eyebrow">The moment you missed</div><blockquote class="quote missed">“' + esc(c.missedMoment.quote) + '”</blockquote>' +
        '<div class="better"><b>Try:</b> ' + esc(c.missedMoment.better) + '</div><p>' + esc(c.missedMoment.why) + '</p></div>' : '') + '</section></div>';

    if (r.revealedText && Object.keys(r.revealedText).length) {
      html += '<section class="section narrow"><h2 class="mb16">What they were holding back</h2>' +
        Object.keys(r.revealedText).map(function (k) {
          var found = (r.revealed || []).indexOf(Number(k)) >= 0;
          return '<div class="hid"><span class="' + (found ? 'ok' : 'no') + '">' + ic(found ? 'open' : 'lock') + '</span><div>' + esc(r.revealedText[k]) +
            '<small class="' + (found ? 'ok' : 'no') + '">' + (found ? 'You uncovered this' : 'You missed this') + '</small></div></div>';
        }).join('') + '</section>';
    }

    if (r.transcript && r.transcript.length) {
      html += '<details class="tape-box narrow"' + (opts.openTranscript ? ' open' : '') + '><summary>Replay the conversation <span>with the coach’s notes</span></summary><div class="chat tape" id="tape"></div></details>';
    }
    return html;
  }

  function drawTape(r) {
    var tape = $('#tape'); if (!tape) return;
    var prev = null;
    r.transcript.forEach(function (t) { addMsg(t, prev, tape); if (t.who === 'them') prev = t.mood; });
  }

  function drawScorecard(r) {
    document.body.classList.remove('in-round');
    view.innerHTML = '<div class="score-top narrow"><button class="btn small ghost" id="toArena" type="button">All opponents</button>' +
      '<button class="btn small ghost" id="shareBtn" type="button">Share</button></div>' +
      scorecardHtml(r) +
      '<div class="actions"><button class="btn" id="rematch" type="button">Run it back</button><a class="btn ghost" href="#/arena">New opponent</a></div>';
    drawTape(r);
    window.scrollTo(0, 0);
    $('#toArena').onclick = function () { location.hash = '#/arena'; };
    $('#rematch').onclick = function () { rematch(r); };
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
    sheet('<h2>Share your scorecard</h2><p class="muted">Anyone with the link sees your grade, skills and the coach’s advice. What you said — the conversation and the coach’s line-by-line quotes — stays private unless you include it.</p>' +
      '<label class="check"><input type="checkbox" id="withT"> Include what I said</label>' +
      '<button class="btn block" id="mk" type="button">Create link</button><div id="shareOut" class="mt12"></div>',
      function (root) {
        $('#mk', root).onclick = function () {
          api('POST', '/api/rounds/' + r.id + '/share', { transcript: $('#withT', root).checked }).then(function (x) {
            var url = location.origin + BASE + '#/share/' + x.shareId;
            $('#shareOut', root).innerHTML = '<input class="input" readonly aria-label="Share link" value="' + esc(url) + '">';
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
      $('#composer').innerHTML = '<div class="demo-bar"><span>A replay, not a live model.</span><button class="link-btn" id="skip" type="button">Skip to the scorecard</button></div>';
      var chat = $('#chat');
      var prev = 0, i = 0, done = false;
      function end() {
        if (done) return; done = true;
        if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
        var r = Object.assign({}, d, { transcript: d.transcript, award: { gained: d.xp.gained } });
        drawScorecard(r);
        view.insertAdjacentHTML('afterbegin', '<div class="banner narrow"><b>That was a demo round.</b><p>Your turn — a free account comes with $2 of credit, about 20 rounds.</p><button class="btn" id="demoSign" type="button">' + (signedIn() ? 'Pick an opponent' : 'Start free') + '</button></div>');
        $('#demoSign').onclick = function () { signedIn() ? (location.hash = '#/arena') : openAccount(); };
        $('.score-top').classList.add('hidden');
        $('#rematch').textContent = 'Try it yourself';
        $('#rematch').onclick = function () {
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
          round.turns++; $('#left').textContent = round.maxTurns - round.turns;
        }
        chat.scrollTop = chat.scrollHeight;
      }
      next();
      roundTimer = setInterval(next, 2300);
    }).catch(function (e) { document.body.classList.remove('in-round'); showError(e, view); });
  }

  /* ---------------- share ---------------- */

  function renderShare(id) {
    loading();
    Promise.all([api('GET', '/api/share/' + encodeURIComponent(id)), loadLib()]).then(function (res) {
      var s = res[0];
      var r = { scenario: s.scenario, scorecard: s.scorecard, status: s.status, difficulty: s.difficulty, moodTrail: s.moodTrail, transcript: s.transcript };
      view.innerHTML = scorecardHtml(r, { handle: s.handle, openTranscript: true }) +
        '<section class="hero sub"><h1>Think you can beat ' + esc(s.scorecard.grade) + '?</h1><p>Same opponent, same stakes. Free to try.</p>' +
        '<div class="ctas"><button class="btn" id="tryIt" type="button">Take them on</button><a class="btn ghost" href="#/arena">See all scenarios</a></div></section>';
      drawTape(r);
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
      return [(cx + Math.cos(a) * R * v / 10).toFixed(1), (cy + Math.sin(a) * R * v / 10).toFixed(1)];
    };
    var rings = [2.5, 5, 7.5, 10].map(function (v) {
      return '<polygon class="web" points="' + keys.map(function (_, i) { return pt(i, v).join(','); }).join(' ') + '"/>';
    }).join('');
    var axes = keys.map(function (k, i) {
      var p = pt(i, 10), l = pt(i, 12.6);
      return '<line class="web" x1="' + cx + '" y1="' + cy + '" x2="' + p[0] + '" y2="' + p[1] + '"/>' +
        '<text x="' + l[0] + '" y="' + (Number(l[1]) + 4) + '" text-anchor="middle">' + esc(names[k].replace('Handling ', '')) + '</text>';
    }).join('');
    var shape = keys.map(function (k, i) { return pt(i, skills[k] || 0).join(','); }).join(' ');
    var said = keys.map(function (k) { return names[k] + ' ' + (Math.round((skills[k] || 0) * 10) / 10); }).join(', ');
    return '<svg class="radar" viewBox="0 0 320 300" role="img" aria-label="Skill profile: ' + esc(said) + '">' + rings + axes +
      '<polygon class="shape" points="' + shape + '"/></svg>';
  }

  function statusWord(s) { return s === 'live' ? 'In progress' : s === 'won' ? 'Won' : s === 'lost' ? 'Lost' : 'Ended'; }

  function renderProgress() {
    if (!signedIn()) return signedOutPitch('Watch yourself get sharper', 'Every round is scored on five skills. Your profile, streaks, badges and history live here.');
    loading();
    Promise.all([loadMe(), loadLib()]).then(function () {
      var me = state.me, p = me.player;
      var winRate = p.rounds ? Math.round(p.wins / p.rounds * 100) + '%' : '—';
      var earned = p.badges.filter(function (b) { return b.earned; }).length;
      view.innerHTML =
        '<section class="page-head"><h1>Your progress</h1>' + levelLine(p) +
        (p.level.next ? '<p class="small">' + (p.level.next - p.level.xp) + ' XP to ' + esc(p.level.nextTitle) + '.</p>' : '') + '</section>' +
        '<div class="stats narrow"><div><b>' + p.rounds + '</b><span>Rounds</span></div><div><b>' + p.wins + '</b><span>Wins</span></div>' +
        '<div><b>' + winRate + '</b><span>Win rate</span></div><div><b>' + p.streak + '</b><span>Day streak</span></div></div>' +
        '<div class="section-title narrow"><h2>History</h2></div><div class="list narrow">' +
        (me.recent.length ? me.recent.map(function (s) {
          return '<button class="item" type="button" data-id="' + esc(s.id) + '"><span class="em" aria-hidden="true">' + esc(s.emoji || '') + '</span><span class="t"><b>' + esc(s.title) + '</b><span>' +
            statusWord(s.status) + ' · ' + esc(s.difficulty) + (s.daily ? ' · daily' : '') + ' · ' + timeAgo(s.createdAt) + '</span></span>' +
            '<span class="end">' + (s.grade ? '<span class="grade">' + esc(s.grade) + '</span>' : s.status === 'live' ? '<span>Resume</span>' : '<span>Score it</span>') + '<span class="chev">' + ic('chev') + '</span></span></button>';
        }).join('') : '<div class="empty">No rounds yet. <a href="#/arena">Pick an opponent</a>.</div>') + '</div>' +
        '<div class="cols two">' +
        '<section><div class="section-title"><h2>Skill profile</h2></div>' +
        (p.rounds ? radar(p.skills) + '<p class="small muted center">Average across ' + p.rounds + ' scored rounds. Weakest: <b>' + esc(weakest(p.skills)) + '</b>.</p>' : '<div class="empty">Finish a round to see your profile.</div>') +
        '</section><section><div class="section-title"><h2>Badges</h2><span class="small num">' + earned + ' of ' + p.badges.length + '</span></div><div class="list">' +
        p.badges.map(function (b) {
          return '<div class="item static' + (b.earned ? '' : ' off') + '"><span class="em" aria-hidden="true">' + esc(b.emoji) + '</span><span class="t"><b>' + esc(b.label) + '</b><span>' + esc(b.desc) + '</span></span>' +
            '<span class="end">' + (b.earned ? '<span class="tag good">Earned</span>' : '') + '</span></div>';
        }).join('') + '</div></section></div>';
      $$('.item[data-id]').forEach(function (b) { b.onclick = function () { location.hash = '#/round/' + b.dataset.id; }; });
    }).catch(function (e) { showError(e, view); });
  }

  function weakest(skills) {
    var names = state.lib.skills, lo = null;
    Object.keys(names).forEach(function (k) { if (lo === null || skills[k] < skills[lo]) lo = k; });
    return names[lo];
  }

  function signedOutPitch(title, text) {
    view.innerHTML = '<section class="hero sub"><h1>' + esc(title) + '</h1><p>' + esc(text) + '</p>' +
      '<div class="ctas"><button class="btn" id="pitchSign" type="button">Start free</button><a class="btn ghost" href="#/demo">Watch a round</a></div></section>';
    $('#pitchSign').onclick = function () { openAccount(); };
  }

  /* ---------------- build ---------------- */

  var EXAMPLES = [
    ['Selling to a skeptic', 'I sell cybersecurity training to a hospital IT director who thinks their staff already know not to click phishing links.'],
    ['Late on rent', 'I need to tell my landlord I will be two weeks late on rent for my restaurant, and ask him not to charge the late fee.'],
    ['A small partnership', 'Pitching my dog-walking app to a pet store owner so she puts our flyers at the register.'],
    ['Raising our price', 'Telling a long-time client we are raising our agency retainer by 20% next quarter.'],
  ];

  function renderBuild() {
    if (!signedIn()) return signedOutPitch('Rehearse your own conversation', 'Describe the call you are dreading — your product, your buyer, your numbers. Spar builds the person across the table, with real reasons to say no.');
    view.innerHTML =
      '<section class="page-head"><h1>Build an opponent</h1><p>Describe the conversation you are dreading: who they are, what you want, and why it is hard. Your product and your numbers make it sharper. Spar invents the person; they push back hard, and never get personal.</p></section>' +
      '<div class="narrow mt24"><label class="field"><span>The situation</span><textarea class="input" id="desc" maxlength="1200" placeholder="e.g. ' + esc(EXAMPLES[0][1]) + '"></textarea></label>' +
      '<div class="eyebrow">Or start from one of these</div><div class="chips wrap-row mb16">' + EXAMPLES.map(function (e, i) { return '<button class="chip" type="button" data-ex="' + i + '">' + esc(e[0]) + '</button>'; }).join('') + '</div>' +
      '<div id="buildErr"></div><div class="row wrap-row"><button class="btn" id="buildBtn" type="button">Build my opponent</button><span class="small muted">About a cent of credit.</span></div></div>' +
      '<div class="section-title narrow"><h2>Your scenarios</h2></div><div id="mine" class="narrow"><div class="empty"><span class="spinner"></span></div></div>';
    $$('[data-ex]').forEach(function (c) { c.onclick = function () { $('#desc').value = EXAMPLES[Number(c.dataset.ex)][1]; $('#desc').focus(); }; });
    $('#buildBtn').onclick = function () {
      var btn = this; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Building…';
      $('#buildErr').innerHTML = '';
      api('POST', '/api/custom', { description: $('#desc').value }).then(function (s) {
        btn.disabled = false; btn.textContent = 'Build my opponent';
        $('#desc').value = '';
        drawMine();
        openBrief(s, { customId: s.id });
      }).catch(function (e) { btn.disabled = false; btn.textContent = 'Build my opponent'; showError(e, $('#buildErr')); });
    };
    drawMine();
  }

  function drawMine() {
    Promise.all([api('GET', '/api/custom'), api('GET', '/api/teams')]).then(function (res) {
      var list = res[0].scenarios, teams = res[1].teams.filter(function (t) { return t.owner; });
      var el = $('#mine'); if (!el) return;
      if (!list.length) { el.innerHTML = '<div class="empty">Nothing built yet.</div>'; return; }
      el.innerHTML = '<div class="list">' + list.map(function (s) {
        return '<div class="item static wrap-row"><span class="em" aria-hidden="true">' + esc(s.emoji) + '</span><span class="t"><b>' + esc(s.title) + '</b><span>vs ' + esc(s.them.name) + ', ' + esc(s.them.role) + '</span></span>' +
          '<span class="drill-actions"><button class="btn small" type="button" data-play="' + esc(s.id) + '">Play</button>' +
          (teams.length ? '<button class="btn small ghost" type="button" data-assign="' + esc(s.id) + '">Assign</button>' : '') +
          '<button class="btn small danger" type="button" data-del="' + esc(s.id) + '">Delete</button></span></div>';
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
    if (!signedIn()) return signedOutPitch('Training your team will actually do', 'Make a team, share a code, assign drills — including ones built about your own product. See who practised and how they scored. Nobody sees anyone else’s transcript.');
    loading();
    api('GET', '/api/teams').then(function (r) {
      view.innerHTML =
        '<section class="page-head"><h1>Teams</h1><p>For managers and coaches: assign drills, share one code, and watch the leaderboard. Members see scores, never each other’s conversations.</p></section>' +
        '<div class="forms narrow"><form id="mkTeam" class="stack"><label class="field mb0"><span>Start a team</span><input class="input" name="name" maxlength="40" placeholder="e.g. West Coast AEs" required></label><button class="btn block">Create team</button></form>' +
        '<form id="joinTeam" class="stack"><label class="field mb0"><span>Join with a code</span><input class="input code-in" name="code" maxlength="6" placeholder="K7PQ2M" autocapitalize="characters" autocomplete="off" required></label><button class="btn ghost block">Join team</button></form></div><div id="teamErr" class="narrow"></div>' +
        '<div class="section-title narrow"><h2>Your teams</h2></div>' +
        (r.teams.length ? '<div class="list narrow">' + r.teams.map(function (t) {
          return '<button class="item" type="button" data-id="' + esc(t.id) + '"><span class="em" aria-hidden="true">' + esc(initials(t.name)) + '</span><span class="t"><b>' + esc(t.name) + '</b><span>' + t.members + ' members · ' + t.drills + ' drills' + (t.owner ? ' · you run it' : '') + '</span></span><span class="end"><span class="chev">' + ic('chev') + '</span></span></button>';
        }).join('') + '</div>' : '<div class="empty narrow">No teams yet.</div>');
      $$('.item[data-id]').forEach(function (b) { b.onclick = function () { location.hash = '#/team/' + b.dataset.id; }; });
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
      signedOutPitch('You’ve been invited to a team', 'Create a free account (or sign in) and you’ll join automatically.');
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
      var html = '<div class="score-top"><button class="btn small ghost" id="toTeams" type="button">All teams</button><button class="btn small danger" id="leave" type="button">' + (t.owner ? 'Delete team' : 'Leave') + '</button></div>' +
        '<section class="page-head mt16"><div class="eyebrow">' + (t.owner ? 'You run this team' : 'Run by ' + esc(t.ownerHandle)) + '</div><h1>' + esc(t.name) + '</h1>' +
        '<div class="invite"><div><div class="eyebrow">Invite code</div><div class="code">' + esc(t.code) + '</div></div><button class="btn small" id="invite" type="button">Invite</button></div></section>';

      html += '<div class="split mf"><aside><div class="section-title"><h2>Team skills</h2></div>' + teamRadar(t) +
        '<div class="section-title"><h2>Activity</h2></div><div class="feed">' +
        (t.feed.length ? t.feed.map(function (f) {
          return '<div class="f"><span class="grow"><b>' + esc(f.handle) + '</b> ' + (f.status === 'won' ? 'won' : f.status === 'lost' ? 'lost' : 'played') + ' <span class="muted">' + esc(f.title) + '</span><small>' + timeAgo(f.at) + '</small></span><span class="grade">' + esc(f.grade) + '</span></div>';
        }).join('') : '<div class="empty">Nothing yet — play a drill.</div>') + '</div></aside><div class="main">';
      html += '<div class="section-title"><h2>Drills</h2>' + (t.owner ? '<button class="btn small" id="addDrill" type="button">Add drill</button>' : '') + '</div>';
      html += t.assignments.length ? '<div class="list">' + t.assignments.map(function (a) {
        var me = t.members.filter(function (m) { return m.you; })[0];
        var best = me && me.drills[a.id];
        return '<div class="item static wrap-row"><span class="em" aria-hidden="true">' + esc(a.scenario.emoji) + '</span><span class="t"><b>' + esc(a.scenario.title) + '</b>' +
          '<span>' + esc(a.difficulty) + ' · ' + a.done + ' of ' + t.members.length + ' done' + (best != null ? ' · your best ' + best : '') + '</span>' +
          (a.note ? '<span>Note: ' + esc(a.note) + '</span>' : '') + '</span>' +
          '<span class="drill-actions"><button class="btn small" type="button" data-play="' + esc(a.id) + '">' + (best != null ? 'Again' : 'Play') + '</button>' +
          (t.owner ? '<button class="btn small danger" type="button" data-rm="' + esc(a.id) + '">Remove</button>' : '') + '</span></div>';
      }).join('') + '</div>' : '<div class="empty">' + (t.owner ? 'Add a drill — any library scenario, or one you built about your own product.' : 'No drills assigned yet.') + '</div>';

      html += '<div class="section-title"><h2>Leaderboard</h2></div><div class="scroll-x"><table class="tbl"><thead><tr><th>#</th><th>Player</th><th>Level</th><th class="n">Team avg</th><th class="n">Rounds</th>' +
        t.assignments.map(function (a) { return '<th class="n" title="' + esc(a.scenario.title) + '"><span aria-hidden="true">' + esc(a.scenario.emoji) + '</span><span class="vh">' + esc(a.scenario.title) + '</span></th>'; }).join('') + '</tr></thead><tbody>' +
        t.members.map(function (m, i) {
          return '<tr' + (m.you ? ' class="you"' : '') + '><td>' + (i + 1) + '</td><td>' + esc(m.handle) + (m.you ? ' (you)' : '') + (m.owner ? ' · owner' : '') + '</td>' +
            '<td>' + m.level.level + ' <span class="small muted">' + esc(m.level.title) + '</span></td><td class="n">' + (m.teamAvg != null ? m.teamAvg : '—') + '</td><td class="n">' + m.teamRounds + '</td>' +
            t.assignments.map(function (a) { var v = m.drills[a.id]; return '<td class="n">' + (v != null ? v : '<span class="muted">—</span>') + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>';
      html += '</div></div>';
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
    if (!withSkills.length) return '<div class="empty">Appears once members finish drills.</div>';
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
        '<optgroup label="Library">' + lib.scenarios.map(function (s) { return '<option value="lib:' + esc(s.id) + '">' + esc(s.title) + '</option>'; }).join('') + '</optgroup>' +
        (mine.length ? '<optgroup label="Built by you">' + mine.map(function (s) { return '<option value="custom:' + esc(s.id) + '">' + esc(s.title) + '</option>'; }).join('') + '</optgroup>' : '') +
        '</select></label>';
      sheet('<h2>Assign a drill</h2>' + (presetTitle ? '<p class="muted">' + esc(presetTitle) + '</p>' : '') +
        (teams.length > 1 ? '<label class="field"><span>Team</span><select class="input" id="aTeam">' + teams.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('') + '</select></label>' : '') +
        opts +
        '<label class="field"><span>Difficulty</span><select class="input" id="aDiff">' + Object.keys(lib.difficulties).map(function (k) { return '<option value="' + k + '"' + (k === 'realistic' ? ' selected' : '') + '>' + esc(lib.difficulties[k].label) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Note for the team (optional)</span><input class="input" id="aNote" maxlength="200" placeholder="e.g. Focus on discovery before you mention price"></label>' +
        '<div id="aErr"></div><button class="btn block" id="aGo" type="button">Assign</button>',
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
    lab.href = '/'; lab.className = 'lablink'; lab.textContent = 'Lab';
    lab.title = 'Back to the Challenge Lab';
    lab.setAttribute('aria-label', 'Back to the Challenge Lab');
    var brand = document.querySelector('.top .brand');
    brand.parentNode.insertBefore(lab, brand.nextSibling);
  }

  Promise.all([loadMe(), loadLib()]).then(function () {
    route();
    if (topup) { history.replaceState(null, '', location.pathname + location.hash); signedIn() ? openProfileSheet() : openAccount(); }
  });
})();
