/* Pop Quiz - the page. One file, no build step, every typed or model-written string escaped. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');
  var PQ = window.PopQuiz;

  // Where the app is mounted: '/' on its own, '/popquiz/' inside the lab.
  var BASE = new URL('.', document.baseURI).pathname;

  var TYPE_LABEL = { mcq: 'Multiple choice', tf: 'True or false', which: 'Which one?' };
  var TYPE_SHORT = { mcq: 'Multiple', tf: 'True / false', which: 'Which one' };
  var EMOJIS = ['🍕', '☕', '🍔', '🌮', '🍣', '🥗', '🍰', '🍺', '🛍️', '👗', '💇', '💅', '🦷', '🩺', '🏋️', '🧘', '🏨', '🧰', '🚗', '🐾', '🌿', '📚', '🎬', '🧠'];
  var DECK_EMOJIS = ['📘', '🍕', '⚠️', '🔒', '🧼', '💳', '🛎️', '🧾', '🔥', '🥜', '🍷', '🧯', '📦', '🔁', '💬', '⭐'];

  var state = { me: null, demo: null, teamId: null, editor: null, demoView: 'manager', keys: null };

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localToday() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  function api(method, path, body) {
    var headers = { 'X-Local-Date': localToday() };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(BASE + String(path).replace(/^\//, ''), {
      method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin',
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
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
  }

  /** A 402 is a till, not a wall: say what happened and where to go. */
  function showError(err, where) {
    if (err && err.status === 402) return openCreditSheet(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<div class="err" role="alert">' + esc(msg) + '</div>'; else toast(msg, 3500);
  }

  function fmtDay(iso, opts) {
    if (!iso) return '';
    return new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', month: 'short', day: 'numeric' }, opts || {}));
  }
  function initials(s) { return String(s || '?').split(/[\s@.]+/).filter(Boolean).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function av(name, cls) { return '<span class="av ' + (cls || '') + '" aria-hidden="true">' + esc(initials(name) || '?') + '</span>'; }
  /** A share out of 100 as a thin bar. A <progress>, so its width is an attribute, never a style. */
  function bar(pct, cls) { var v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0))); return '<progress class="bar ' + (cls || '') + '" max="100" value="' + v + '" aria-hidden="true"></progress>'; }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function copyText(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied.'); }, function () { window.prompt('Copy this:', text); });
  }

  /** A small burst when a day goes perfectly. Every piece is placed by the stylesheet. */
  function confetti() {
    if (reducedMotion()) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 16; i++) box.appendChild(document.createElement('i'));
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 2600);
    window.addEventListener('hashchange', function () { box.remove(); }, { once: true });
  }

  function xpFloat(el, n) {
    if (reducedMotion() || !el || !n) return;
    var f = document.createElement('span');
    f.className = 'xp-float'; f.setAttribute('aria-hidden', 'true'); f.textContent = '+' + n;
    el.appendChild(f);
    setTimeout(function () { f.remove(); }, 1100);
  }

  function ring(pct, label, sub, cls, aria) {
    var c = 2 * Math.PI * 52;
    var off = c * (1 - Math.max(0, Math.min(1, pct)));
    return '<div class="ring ' + (cls || '') + '" role="img" aria-label="' + esc(aria || label) + '"><svg viewBox="0 0 120 120" aria-hidden="true">' +
      '<circle class="track" cx="60" cy="60" r="52" fill="none" stroke-width="8"/>' +
      '<circle class="val" cx="60" cy="60" r="52" fill="none" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/></svg>' +
      '<div class="lbl" aria-hidden="true"><div>' + esc(label) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div></div></div>';
  }

  function ic(d, extra) { return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '>' + d + '</svg>'; }
  var ICON = {
    back: ic('<path d="m15 18-6-6 6-6"/>'),
    chev: ic('<path d="m9 6 6 6-6 6"/>'),
    trash: ic('<path d="M4 7h16M9 7V4h6v3M18 7l-1 13H7L6 7"/>'),
    spark: ic('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/>'),
    x: ic('<path d="M6 6l12 12M18 6 6 18"/>'),
    check: ic('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    flame: ic('<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-1.8.8-3 1.8-4 .3 1.6 1.2 2.4 2 2.6C10.2 9.5 10.8 6 12 3z"/>'),
    bolt: ic('<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>'),
    camera: ic('<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.5-2.500h5L16 7h2.500A1.5 1.5 0 0 1 20 8.500v9a1.5 1.5 0 0 1-1.5 1.500h-13A1.5 1.5 0 0 1 4 17.500z"/><circle cx="12" cy="13" r="3.5"/>'),
    text: ic('<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8.500h6M9 12h6M9 15.500h3.5"/>'),
    pencil: ic('<path d="M4 20l1-4L16.5 4.500a1.7 1.7 0 0 1 2.5 0l.5.500a1.7 1.7 0 0 1 0 2.500L8 19z"/><path d="M14.5 6.500l3 3"/>'),
    ticket: ic('<path d="M4 8a1.5 1.5 0 0 1 1.5-1.500h13A1.5 1.5 0 0 1 20 8v2a2 2 0 0 0 0 4v2a1.5 1.5 0 0 1-1.5 1.500h-13A1.5 1.5 0 0 1 4 16v-2a2 2 0 0 0 0-4z"/><path d="M14 7v10" stroke-dasharray="2 2.5"/>'),
    team: ic('<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.5-3 2.7-4.5 5.5-4.500s5 1.5 5.5 4.5"/><circle cx="17" cy="10" r="2.3"/><path d="M16.5 14.600c2.2.2 3.6 1.5 4 3.9"/>'),
    target: ic('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>'),
    page: ic('<path d="M7 3.500h7l4 4V19a1.5 1.5 0 0 1-1.5 1.500h-9.500A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.500z"/><path d="M14 3.500V8h4M9 12.500h6M9 16h4"/>'),
    repeat: ic('<path d="M17 4l3 3-3 3"/><path d="M20 7H8a4 4 0 0 0-4 4v1M7 20l-3-3 3-3"/><path d="M4 17h12a4 4 0 0 0 4-4v-1"/>'),
    plus: ic('<path d="M12 5v14M5 12h14"/>'),
  };

  /* ---------------- data ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; pickTeam(); drawTop(); drawTabs(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); drawTabs(); return state.me; });
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function teams() { return (state.me && state.me.teams) || []; }
  function pickTeam() {
    var ts = teams();
    var want = state.teamId || lsGet('pq-team');
    var t = ts.filter(function (x) { return x.id === want; })[0] || ts[0] || null;
    state.teamId = t ? t.id : null;
    if (t) lsSet('pq-team', t.id);
  }
  function team() { var id = state.teamId; return teams().filter(function (t) { return t.id === id; })[0] || null; }
  function isManager() { var t = team(); return Boolean(t && t.role === 'manager'); }
  function setTeam(id) { state.teamId = id; lsSet('pq-team', id); drawTop(); drawTabs(); }
  function teamPath(rest) { return 'api/teams/' + encodeURIComponent(state.teamId) + (rest || ''); }
  function loadDemo() {
    if (state.demo) return Promise.resolve(state.demo);
    return api('GET', 'api/demo').then(function (d) { state.demo = d; return d; });
  }
  // Passkeys are bound to the shared domain; on a staging *.run.app host they
  // cannot work, so the buttons are not offered there.
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function needAccount(msg) { openAccount(msg || 'Sign up free to run your own team — the sample is read-only.'); }

  function drawTop() {
    var el = $('#topRight');
    var me = state.me;
    if (!me || !me.signedIn) {
      el.innerHTML = '<button class="btn small ghost" id="signInTop">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var t = team();
    el.innerHTML = (t ? '<button class="pill team-pill" id="teamPill" aria-label="Switch team">' + '<span aria-hidden="true">' + esc(t.emoji) + '</span><span class="ellip">' + esc(t.name) + '</span><span class="caret" aria-hidden="true">' + ICON.chev + '</span></button>' : '') +
      '<button class="avatar-btn" id="acctBtn" aria-label="Account">' + av(me.name || me.email) + '</button>';
    $('#acctBtn').onclick = function () { openProfileSheet(); };
    var tp = $('#teamPill'); if (tp) tp.onclick = openTeamSheet;
  }

  function drawTabs() {
    var staff = signedIn() && team() && !isManager();
    $('#teamTabLabel').textContent = staff ? 'Me' : 'Dashboard';
    $('#decksTab').classList.toggle('hidden', Boolean(staff));
  }
  function setTodayDot(on) { var d = $('#todayDot'); if (d) d.classList.toggle('hidden', !on); }

  /* ---------------- sheets ---------------- */

  function sheet(html, onMount) {
    closeSheet();
    var scrim = document.createElement('div');
    scrim.className = 'scrim'; scrim.id = 'scrim';
    scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + html + '</div>';
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
    document.body.appendChild(scrim);
    if (onMount) onMount(scrim.firstChild);
    var f = scrim.querySelector('input:not([type=hidden]), textarea');
    if (f) setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 50);
    return scrim.firstChild;
  }
  function closeSheet() { var s = $('#scrim'); if (s) s.remove(); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') return closeSheet();
    if (state.keys && !$('#scrim') && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) state.keys(e);
  });

  function openAccount(reason) {
    if (signedIn()) return openProfileSheet();
    var mode = 'register';
    function draw(root) {
      root.innerHTML = '<div class="grab"></div>' +
        '<h2>' + (mode === 'register' ? 'Make training stick.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Free account. Playing quizzes is free forever; managers get $2 of AI credit to turn material into questions — about a cent a deck. One account works across every app on this site.'
          : 'Same account as the other apps on this site.')) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button>' +
        '</form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn">Sign in with Face ID / passkey</button>' : '') +
        '<p class="center small muted">' +
        (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap">Sign in</button>' : 'New here? <button class="link-btn" id="swap">Create an account</button>') +
        '</p>';
      $('#swap', root).onclick = function () { mode = mode === 'register' ? 'login' : 'register'; draw(root); };
      $('#authForm', root).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target;
        var btn = $('button[type=submit]', f); btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
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
      var pending = lsGet('pq-join');
      if (pending) {
        lsSet('pq-join', null);
        return doJoin(pending.split('|')[0], pending.split('|').slice(1).join('|'));
      }
      toast('You’re in.');
      route();
    });
  }

  function openProfileSheet() {
    var me = state.me;
    var b = me.budget || {};
    var remaining = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    var pct = b.unlimited ? 100 : Math.max(0, Math.min(100, (b.remainingUsd / (b.allowanceUsd || 1)) * 100));
    sheet(
      '<h2>' + esc(me.name || 'Your account') + '</h2>' +
      '<p class="muted small">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'Member model (Sonnet)' : 'Free model (Haiku)') + '</p>' +
      '<div class="card"><div class="row spread"><b>AI credit</b><span class="num">' + remaining + '</span></div>' +
      '' + bar(pct) + '' +
      '<p class="small muted">Only one thing costs credit: a manager turning pasted text or a photo into questions — about a cent a deck. Playing, streaks, the leaderboard, the dashboard and writing questions by hand are free.</p>' +
      '<div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut">Sign out</button>',
      function (root) {
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.teamId = null; drawTop(); drawTabs(); setTodayDot(false); location.hash = '#/'; route(); });
        };
        var pk = $('#pkEnrol', root);
        if (pk) pk.onclick = function () {
          var pw = window.prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); })
            .catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        };
        drawBilling($('#billing', root));
      }
    );
  }

  function drawBilling(el) {
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button>' +
          '<p class="small muted">Membership covers every app on this site, runs the better model, and lets you add credit.</p>';
        $('#joinM', el).onclick = function () { checkout('api/auth/billing/membership', {}); };
        return;
      }
      el.innerHTML = '<div class="row wrap-row">' + (b.topUps || []).map(function (t) {
        return '<button class="btn small ghost" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>';
      }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) {
        btn.onclick = function () { checkout('api/auth/billing/credit', { usd: Number(btn.dataset.usd) }); };
      });
    }).catch(function () { el.innerHTML = ''; });
  }
  function checkout(path, body) {
    body.returnTo = BASE + location.hash;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCreditSheet(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p>' +
      '<p class="muted small">You can still write questions by hand — that is free — and your team’s quizzes, streaks, leaderboard and your dashboard never cost anything.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  function openTeamSheet() {
    var ts = teams();
    sheet('<h2>Your teams</h2><div class="list">' + ts.map(function (t) {
      return '<div class="lrow tap' + (t.id === state.teamId ? ' you' : '') + '" role="button" tabindex="0" data-team="' + esc(t.id) + '"><span class="av emo" aria-hidden="true">' + esc(t.emoji) + '</span>' +
        '<div class="grow"><div class="nm ellip">' + esc(t.name) + '</div><div class="sub">' + (t.role === 'manager' ? 'Manager' : 'Staff') + ' · ' + plural(t.members, 'person', 'people') + '</div></div>' +
        (t.id === state.teamId ? '<span class="tag acc">Current</span>' : '') + '</div>';
    }).join('') + '</div>' +
      '<div class="btn-row"><a class="btn ghost" href="#/join">Join a team</a><a class="btn ghost" href="#/create">Start a team</a></div>',
    function (root) {
      $$('[data-team]', root).forEach(function (el) {
        var go = function () { setTeam(el.dataset.team); closeSheet(); if (location.hash === '#/today') route(); else location.hash = '#/today'; };
        el.onclick = go;
        el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      });
      $$('a', root).forEach(function (a) { a.addEventListener('click', closeSheet); });
    });
  }

  /* ---------------- routing ---------------- */

  function route() {
    closeSheet();
    state.keys = null;
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var tab = parts[0] || '';
    var owner = { '': signedIn() ? 'today' : '', today: 'today', sample: 'today', board: 'board', team: 'team', decks: 'decks', 'new': 'decks', review: 'decks', deck: 'decks' };
    $$('#tabbar button').forEach(function (b) { var on = b.dataset.tab === owner[tab]; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    view.setAttribute('data-page', tab === '' && !signedIn() ? 'home' : (tab || 'today'));
    window.scrollTo(0, 0);
    if (tab === 'join') return renderJoin(parts[1] ? decodeURIComponent(parts[1]) : '');
    if (tab === 'create') return renderCreate();
    if (tab === 'sample') return renderDemoQuiz();
    if (!signedIn()) {
      if (tab === 'today') return renderDemoQuiz();
      if (tab === 'board') return renderBoard();
      if (tab === 'team') return renderTeam();
      if (tab === 'decks') return renderDecks();
      if (tab === 'deck') return renderDemoDeck(parts[1]);
      if (tab === 'new') return renderNewDeck(parts[1]);
      return renderHome();
    }
    if (!team()) return renderWelcome();
    if (tab === 'board') return renderBoard();
    if (tab === 'team') return renderTeam();
    if (tab === 'decks' || tab === 'new' || tab === 'review' || tab === 'deck') {
      if (!isManager()) { location.hash = '#/today'; return; }
      if (tab === 'new') return renderNewDeck(parts[1]);
      if (tab === 'review') return renderReview();
      if (tab === 'deck') return renderDeckEdit(decodeURIComponent(parts[1] || ''));
      return renderDecks();
    }
    return renderToday();
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () { location.hash = '#/' + b.dataset.tab; };
  });
  window.addEventListener('hashchange', route);

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner" aria-label="Loading"></span></div>'; }
  function backLink(href, label) { return '<a class="back" href="' + href + '">' + ICON.back + esc(label) + '</a>'; }
  function sampleBar(what) {
    return '<div class="sample-bar"><span><b>Sample</b> ' + esc(what || 'Slice Society, an invented pizza place. Real maths, no AI, nothing saved.') + '</span>' +
      (signedIn() ? '' : '<button class="btn small" data-signup>Start free</button>') + '</div>';
  }
  function wireSignup(root) { $$('[data-signup]', root || view).forEach(function (b) { b.onclick = function () { openAccount(); }; }); }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    loadDemo().then(function (d) {
      var dash = d.dashboard;
      var spot = dash.blindSpots[0];
      var top3 = d.leaderboard.rows.slice(0, 3);
      view.innerHTML =
        '<section class="hero">' +
        '<p class="eyebrow">Staff training, two minutes a day</p>' +
        '<h1>The binder nobody reads, as a daily game.</h1>' +
        '<p class="lead">Snap a page of the training binder. Approve the questions. Your team plays five a day.</p>' +
        '<div class="ctas"><a class="btn lg" href="#/today">Play the sample quiz</a><button class="btn lg ghost" id="heroGo">Start a team free</button></div>' +
        '</section>' +
        '<section class="steps">' +
        '<div class="step">' + ICON.camera + '<h3>Snap the binder</h3><p>A photo of the page, or paste the text: menu and allergens, opening and closing, safety, returns. You review every question before anyone sees it.</p></div>' +
        '<div class="step">' + ICON.bolt + '<h3>Five a day</h3><p>Two minutes on a break. Missed questions come back tomorrow; known ones fade out. Streaks, XP and a weekly leaderboard.</p></div>' +
        '<div class="step">' + ICON.target + '<h3>See the blind spots</h3><p>Who’s done today, who knows what, and the questions the whole team keeps getting wrong, so you know what to retrain.</p></div>' +
        '</section>' +
        '<section class="showcase"><div class="section-title"><h2>' + esc(d.team.emoji + ' ' + d.team.name) + '</h2><span class="count">a sample team</span></div>' +
        '<div class="two">' +
        '<div><p class="eyebrow">Their biggest blind spot</p><div class="spots">' + spotHtml(spot) + '</div><a class="more-link" href="#/team">See the whole dashboard' + ICON.chev + '</a></div>' +
        '<div><p class="eyebrow">This week’s leaderboard</p><div class="list">' + top3.map(function (r) { return boardRow(r); }).join('') + '</div>' +
        '<a class="more-link" href="#/board">Full leaderboard' + ICON.chev + '</a></div>' +
        '</div></section>' +
        '<section class="closing"><h2>Your rules, learned by Friday.</h2><p>Make a team in 30 seconds, share an 8-letter code, and tomorrow’s pre-shift starts with a streak.</p><button class="btn lg" id="bandGo">Start a team free</button>' +
        '<p class="trust">Free to play, forever · You approve every question · No model call until you sign in</p></section>';
      $('#heroGo').onclick = function () { openAccount(); };
      $('#bandGo').onclick = function () { openAccount(); };
    }).catch(function (e) { showError(e, view); });
  }

  function renderWelcome() {
    var me = state.me;
    view.innerHTML = '<div class="page-head"><div><h1>Welcome, ' + esc(me.name) + '</h1><div class="sub">Are you running the training, or taking it?</div></div></div>' +
      '<div class="rows choices">' +
      '<a class="rowlink" href="#/create"><span class="ricon">' + ICON.team + '</span><span class="grow"><b>I run a team</b><span class="sub">Make a team, add your menu or checklist, and share a code with your staff.</span></span>' + ICON.chev + '</a>' +
      '<a class="rowlink" href="#/join"><span class="ricon">' + ICON.ticket + '</span><span class="grow"><b>I have a join code</b><span class="sub">Your manager gave you 8 letters and numbers. Joining is free.</span></span>' + ICON.chev + '</a>' +
      '</div>' +
      '<p class="center small muted">Just looking? <a href="#/sample">Play the sample quiz</a>.</p>';
  }

  /* ---------------- the quiz player ---------------- */

  var VERDICTS = ['Nice one', 'Spot on', 'Nailed it', 'Correct', 'Yes'];

  /**
   * One question at a time. `answer(q, choice)` resolves to the result - the
   * server's for a real quiz, quiz.js's check() for the sample - so the page
   * never needs the right answer before it is given.
   */
  function player(opts) {
    var qs = opts.questions;
    var answers = Object.assign({}, opts.answers || {});
    var xp = opts.xp || 0;
    var i = firstOpen();
    var busy = false;
    function firstOpen() { for (var k = 0; k < qs.length; k++) if (!answers[qs[k].id]) return k; return qs.length; }
    function segs() {
      return qs.map(function (q, k) {
        var a = answers[q.id];
        return '<i class="' + (a ? (a.correct ? 'ok' : 'no') : (k === i ? 'now' : '')) + '"></i>';
      }).join('');
    }
    function draw() {
      if (i >= qs.length) return opts.finish(answers);
      var q = qs[i];
      var tf = q.type === 'tf';
      view.innerHTML = (opts.top || '') +
        '<div class="quiz"><div class="qhead"><div class="segs" id="segs" role="progressbar" aria-valuemin="0" aria-valuemax="' + qs.length + '" aria-valuenow="' + i + '" aria-label="Question ' + (i + 1) + ' of ' + qs.length + '">' + segs() + '</div>' +
        (opts.streak ? '<span class="pill fire" title="Day streak">' + ICON.flame + '' + opts.streak + '</span>' : '') +
        '<span class="pill xp" id="xpPill" title="XP this week">' + ICON.bolt + '<span id="xpNum">' + xp + '</span></span></div>' +
        '<div class="qcard" id="qcard"><div class="qmeta"><span class="qtype">' + esc(TYPE_LABEL[q.type] || '') + '</span>' +
        '<span class="ellip">' + esc(((q.deckEmoji || '') + ' ' + (q.deckTitle || '')).trim()) + '</span><span class="grow"></span><span class="num">' + (i + 1) + ' / ' + qs.length + '</span></div>' +
        '<h2 class="qprompt" id="qprompt" tabindex="-1">' + esc(q.prompt) + '</h2>' +
        '<div class="opts' + (tf ? ' tf' : '') + '" role="group" aria-labelledby="qprompt">' + q.options.map(function (o, k) {
          return '<button class="opt" data-i="' + k + '"><span class="key" aria-hidden="true">' + (tf ? (k === 0 ? '✓' : '✗') : 'ABCD'.charAt(k)) + '</span><span>' + esc(o) + '</span></button>';
        }).join('') + '</div>' +
        '<div id="fb" aria-live="polite"></div></div>' +
        '<div class="qfoot" id="qfoot"></div>' +
        '<p class="kbd-hint">Keys: ' + (tf ? 'T or F' : 'A–D or 1–4') + ' to answer · Enter for the next one</p></div>';
      wireSignup(view);
      $$('.opt', view).forEach(function (b) { b.onclick = function () { choose(Number(b.dataset.i)); }; });
      state.keys = function (e) {
        var k = e.key.toLowerCase();
        if (answers[q.id]) { if (e.key === 'Enter') { var n = $('#nextBtn'); if (n) { e.preventDefault(); n.click(); } } return; }
        var idx = tf ? { t: 0, f: 1, 1: 0, 2: 1 }[k] : ({ a: 0, b: 1, c: 2, d: 3, 1: 0, 2: 1, 3: 2, 4: 3 })[k];
        if (idx !== undefined && idx < q.options.length) { e.preventDefault(); choose(idx); }
      };
      if (answers[q.id]) show(answers[q.id], false);
    }
    function choose(k) {
      var q = qs[i];
      if (busy || answers[q.id]) return;
      busy = true;
      var btns = $$('.opt', view);
      btns.forEach(function (b) { b.disabled = true; });
      btns[k].classList.add('chosen');
      opts.answer(q, k).then(function (r) {
        busy = false;
        answers[q.id] = r;
        show(r, true);
      }).catch(function (e) {
        busy = false;
        btns.forEach(function (b) { b.disabled = false; b.classList.remove('chosen'); });
        if (opts.onError && opts.onError(e)) return;
        showError(e, $('#fb'));
      });
    }
    function show(r, live) {
      var q = qs[i];
      var btns = $$('.opt', view);
      btns.forEach(function (b, k) {
        b.disabled = true;
        b.classList.remove('chosen');
        if (k === r.answer) { b.classList.add('right'); if (live && k === r.choice) b.classList.add('pick'); b.insertAdjacentHTML('beforeend', '<span class="mark" aria-label="Right answer">' + ICON.check + '</span>'); } else if (k === r.choice) { b.classList.add('wrong'); b.insertAdjacentHTML('beforeend', '<span class="mark" aria-label="Your answer">' + ICON.x + '</span>'); } else b.classList.add('dim');
      });
      var ok = r.correct;
      $('#fb').innerHTML = '<div class="fb ' + (ok ? 'ok' : 'no') + '">' +
        '<div class="verdict">' + (ok ? VERDICTS[i % VERDICTS.length] : 'Not quite') + (r.xpGained ? ' <span class="small muted">+' + r.xpGained + ' XP</span>' : '') + '</div>' +
        (!ok && r.answer != null && q.options[r.answer] ? '<p>The answer is <b>' + esc(q.options[r.answer]) + '</b>.</p>' : '') +
        (r.explanation ? '<p>' + esc(r.explanation) + '</p>' : '') +
        (r.source ? '<blockquote>From the deck: “' + esc(r.source) + '”</blockquote>' : '') +
        (r.nextIn != null ? '<div class="next-in">' + (ok ? 'You’ll see this again in ' + plural(r.nextIn, 'day') + '.' : 'This one comes back tomorrow. That’s how it sticks.') + '</div>' : '') +
        '</div>';
      var last = firstOpen() >= qs.length;
      $('#qfoot').innerHTML = '<button class="btn lg block" id="nextBtn">' + (last ? 'See how you did →' : 'Next question →') + '</button>';
      $('#nextBtn').onclick = function () {
        i = firstOpen(); draw(); window.scrollTo(0, 0);
        var p = $('#qprompt'); if (p) p.focus({ preventScroll: true });
      };
      if (live) {
        $('#segs').innerHTML = segs();
        if (r.xpGained) {
          xp += r.xpGained;
          var pill = $('#xpPill'); var num = $('#xpNum'); if (num) num.textContent = xp;
          xpFloat(pill, r.xpGained);
        }
        $('#nextBtn').focus({ preventScroll: true });
        var fb = $('#fb'); if (fb && fb.scrollIntoView && window.innerHeight < 900) fb.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    }
    draw();
  }

  function resultsHtml(o) {
    var total = o.total || 0;
    var score = o.score || 0;
    var perfect = total > 0 && score === total;
    var title = perfect ? 'Perfect day' : score >= total - 1 ? 'So close' : score * 2 >= total ? 'Good work' : 'Every miss is a lesson';
    var lead = perfect ? 'Every one right. That’s how rules stick.' : 'The ones you missed come back tomorrow — that’s how they stick.';
    return '<div class="quiz"><div class="result">' +
      ring(total ? score / total : 0, score + '/' + total, 'right', '', score + ' of ' + total + ' right') +
      '<h1>' + esc(title) + '</h1><p class="lead">' + esc(lead) + '</p>' +
      '<div class="stat-row"><div class="stat fire"><b>' + ICON.flame + '' + (o.streak || 0) + '</b><span>day streak</span></div>' +
      '<div class="stat xp"><b>+' + (o.xpToday || 0) + '</b><span>XP today</span></div>' +
      '<div class="stat"><b>' + (o.mastery != null ? o.mastery + '%' : Math.round(total ? score / total * 100 : 0) + '%') + '</b><span>' + (o.mastery != null ? 'mastered' : 'right') + '</span></div></div>' +
      (o.badges && o.badges.length ? '<div>' + o.badges.map(function (b) { return '<span class="badge-toast">' + esc(b.emoji) + ' Badge: ' + esc(b.label) + '</span>'; }).join('') + '</div>' : '') +
      '</div>' +
      '<div class="section-title"><h2>Today’s questions</h2><span class="count">' + esc(o.note || 'New quiz tomorrow') + '</span></div>' +
      '<div class="card"><ul class="recap">' + o.questions.map(function (q) {
        var a = o.answers[q.id] || {};
        var right = a.answer != null ? q.options[a.answer] : '';
        return '<li class="' + (a.correct ? 'ok' : 'no') + '"><span class="ri" aria-label="' + (a.correct ? 'Right' : 'Missed') + '">' + (a.correct ? ICON.check : ICON.repeat) + '</span><div><b>' + esc(q.prompt) + '</b>' +
          (right ? '<span>' + (a.correct ? 'Answer: ' : 'You picked “' + esc(q.options[a.choice] || '') + '” — it’s ') + '<b class="inl">' + esc(right) + '</b></span>' : '') + '</div></li>';
      }).join('') + '</ul></div>' +
      '<div class="btn-row"><a class="btn lg" href="#/board">Leaderboard</a>' + (o.demo ? '<button class="btn lg ghost" data-signup>Start your team free</button>' : '<a class="btn lg ghost" href="#/team">' + (isManager() ? 'Dashboard' : 'My progress') + '</a>') + '</div></div>';
  }

  function renderDemoQuiz() {
    loading();
    loadDemo().then(function (d) {
      var xpNow = 0;
      player({
        questions: d.sample,
        top: sampleBar('Slice Society’s daily quiz — an invented pizza place. Nothing you answer is saved.'),
        streak: 0,
        xp: 0,
        answer: function (q, k) {
          var ok = PQ.check(q, k);
          var r = PQ.review(null, ok, d.today, k);
          var gained = PQ.xpForAnswer(ok);
          xpNow += gained;
          return Promise.resolve({ choice: k, correct: ok, answer: q.answer, explanation: q.explanation, source: q.source, xpGained: gained, nextIn: PQ.INTERVALS[r.card.box] });
        },
        finish: function (answers) {
          var score = d.sample.filter(function (q) { return answers[q.id] && answers[q.id].correct; }).length;
          var bonus = PQ.xpForFinish(score, d.sample.length);
          view.innerHTML = sampleBar('That’s the whole loop. Your team would do this every day — on their own phones.') +
            resultsHtml({ score: score, total: d.sample.length, streak: 1, xpToday: xpNow + bonus, questions: d.sample, answers: answers, demo: true, note: 'Sample — nothing saved' });
          wireSignup(view);
          if (score === d.sample.length) confetti();
        },
      });
    }).catch(function (e) { showError(e, view); });
  }

  function renderToday() {
    loading();
    var tid = state.teamId;
    api('GET', teamPath('/quiz')).then(function (d) {
      if (tid !== state.teamId) return;
      setTodayDot(!d.done && !d.empty);
      if (d.empty) return emptyToday();
      if (d.done) return drawDone(d, [], false);
      var badges = [];
      var top = d.stats.atRisk ? '<div class="banner warn"><span class="e">' + ICON.flame + '</span><div><b>Keep your ' + d.stats.streak + '-day streak alive</b> — finish today’s five.</div></div>' : '';
      player({
        questions: d.questions,
        answers: d.answers,
        streak: d.stats.streak,
        xp: d.stats.weekXp,
        top: top,
        answer: function (q, k) {
          return api('POST', teamPath('/quiz/answer'), { qid: q.id, choice: k }).then(function (r) {
            (r.newBadges || []).forEach(function (b) { badges.push(b); });
            return r;
          });
        },
        onError: function (e) {
          if (e.status === 409) { toast(e.message, 3200); renderToday(); return true; }
          return false;
        },
        finish: function () {
          loading();
          api('GET', teamPath('/quiz')).then(function (d2) { setTodayDot(false); drawDone(d2, badges, true); }).catch(function (e) { showError(e, view); });
        },
      });
    }).catch(function (e) { showError(e, view); });
  }

  function drawDone(d, badges, fresh) {
    var perfect = d.total > 0 && d.score === d.total;
    view.innerHTML = resultsHtml({
      score: d.score, total: d.total, streak: d.stats.streak, xpToday: d.stats.xpToday, mastery: d.stats.mastery,
      questions: d.questions, answers: d.answers, badges: badges, note: 'Next quiz tomorrow',
    });
    if (fresh && perfect) confetti();
    else if (fresh && badges.length) confetti();
  }

  function emptyToday() {
    if (isManager()) {
      view.innerHTML = '<div class="empty"><h2>No questions yet</h2><p>Paste a menu, a checklist or a policy — or snap a photo of the page — and review the questions before your team sees them. Or write a few by hand.</p>' +
        '<div class="btn-row"><a class="btn" href="#/new">Make your first deck</a><a class="btn ghost" href="#/team">Invite your team</a></div></div>';
    } else {
      view.innerHTML = '<div class="empty"><h2>Nothing to play yet</h2><p>Your manager hasn’t published any questions. As soon as they do, your daily five show up here.</p>' +
        '<a class="btn ghost" href="#/sample">Try the sample quiz meanwhile</a></div>';
    }
  }

  /* ---------------- the leaderboard ---------------- */

  function boardRow(r) {
    return '<div class="lrow' + (r.you ? ' you' : '') + '"><span class="rank">' + r.rank + '</span>' + av(r.name) +
      '<div class="grow"><div class="nm ellip">' + esc(r.name) + (r.you ? ' <span class="tag acc">You</span>' : '') + '</div><div class="sub">' + (r.streak ? '' + ICON.flame + '' + r.streak + '-day streak' : 'No streak yet') + '</div></div>' +
      '<span class="xpv num">' + r.weekXp + ' <span class="small muted">XP</span></span></div>';
  }

  function drawBoard(lb, o) {
    var rows = lb.rows;
    var podium = rows.length >= 3 && rows[0].weekXp > 0;
    var p = podium ? [rows[1], rows[0], rows[2]] : [];
    var cls = ['second', 'first', 'third'];
    var medal = ['2', '1', '3'];
    view.innerHTML = (o.demo ? sampleBar() : '') +
      '<div class="page-head"><div><h1>Leaderboard</h1><div class="sub">' + esc((o.team ? o.team.emoji + ' ' + o.team.name + ' · ' : '') + 'Week of ' + fmtDay(lb.week) + ' · resets Monday') + '</div></div></div>' +
      (rows.every(function (r) { return !r.weekXp; }) ? '<div class="banner"><div>Nobody has played this week yet. Five questions puts you on top.</div></div>' : '') +
      (podium ? '<div class="podium">' + p.map(function (r, k) {
        return '<div class="pod ' + cls[k] + '">' + av(r.name) + '<div class="nm ellip">' + esc(r.name) + (r.you ? ' (you)' : '') + '</div><div class="xpv num">' + r.weekXp + ' XP</div><div class="block" aria-hidden="true">' + medal[k] + '</div></div>';
      }).join('') + '</div>' : '') +
      ((podium ? rows.slice(3) : rows).length ? '<div class="list">' + (podium ? rows.slice(3) : rows).map(boardRow).join('') + '</div>' : '') +
      '<p class="hint center">Everyone on the team sees name, XP this week and streak — never which questions anyone missed.</p>';
    wireSignup(view);
  }

  function renderBoard() {
    loading();
    if (!signedIn()) {
      return loadDemo().then(function (d) { drawBoard(d.leaderboard, { demo: true, team: d.team }); }).catch(function (e) { showError(e, view); });
    }
    api('GET', teamPath('/leaderboard')).then(function (lb) { drawBoard(lb, { team: lb.team }); }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- the dashboard and "me" ---------------- */

  function spotHtml(s) {
    if (!s) return '<div class="card muted small">No blind spots yet.</div>';
    return '<div class="spot"><div class="top-line"><span class="rate num">' + s.missRate + '%</span><div class="grow">' + bar(s.missRate, 'bad') + '' +
      '<div class="small muted">missed · ' + s.misses + ' of ' + s.attempts + ' answers' + (s.stuck ? ' · ' + plural(s.stuck, 'person', 'people') + ' still getting it wrong' : '') + '</div></div></div>' +
      '<div class="q">' + esc(s.prompt) + '</div>' +
      '<div class="ans"><div class="r">Right: ' + esc(s.options[s.answer]) + '</div>' + (s.commonWrong ? '<div class="w">Most picked instead: ' + esc(s.commonWrong) + ' (' + s.commonWrongCount + '×)</div>' : '') + '</div>' +
      '<div class="tags">' + (s.topic ? '<span class="tag">' + esc(s.topic) + '</span>' : '') + (s.deckTitle && s.deckTitle !== s.topic ? '<span class="tag">' + esc(s.deckTitle) + '</span>' : '') + '</div>' +
      '</div>';
  }

  function drawDashboard(d, o) {
    var t = o.team;
    var real = !o.demo;
    var people = d.people;
    view.innerHTML = (o.demo ? sampleBar() + demoSwitch() : '') +
      '<div class="page-head"><div><h1>' + esc(t.emoji + ' ' + t.name) + '</h1><div class="sub">Manager dashboard · ' + esc(fmtDay(d.today, { weekday: 'long' })) + '</div></div></div>' +
      '<div class="kpis">' +
      '<div class="kpi">' + ring(d.total ? d.done / d.total : 0, d.done + '/' + d.total, '', 'sm', d.done + ' of ' + d.total + ' done today') + '<div><b class="sr-only">' + d.done + '/' + d.total + '</b><span>done today</span></div></div>' +
      '<div class="kpi"><div><b>' + d.mastery + '%</b><span>team mastery</span></div></div>' +
      '<div class="kpi fire"><div><b>' + ICON.flame + '' + d.bestStreak + '</b><span>longest streak</span></div></div>' +
      '<div class="kpi"><div><b>' + d.questions + '</b><span>questions live</span></div></div>' +
      '</div>' +
      '<div class="dk-2">' +
      '<div><div class="section-title"><h2>Who’s done today</h2><span class="count">' + d.done + ' of ' + d.total + '</span></div>' +
      '<div class="list">' + people.map(function (p) {
        return '<div class="lrow' + (real ? ' tap' : '') + '"' + (real ? ' role="button" tabindex="0" data-person="' + esc(p.id) + '"' : '') + '>' + av(p.name) +
          '<div class="grow"><div class="nm ellip">' + esc(p.name) + (p.role === 'manager' ? ' <span class="tag">Manager</span>' : '') + '</div>' +
          '<div class="sub">' + (p.streak ? '' + ICON.flame + '' + p.streak + ' · ' : '') + (p.started ? (p.accuracy != null ? p.accuracy + '% right · ' : '') + p.mastery + '% known' : 'Not started') + '</div>' +
          '' + bar(p.mastery, 'mbar') + '</div>' +
          '<span class="done-chip ' + (p.doneToday ? 'yes' : 'no') + '">' + (p.doneToday ? 'Done' : 'Not yet') + '</span></div>';
      }).join('') + '</div></div>' +
      '<div><div class="section-title"><h2>Blind spots</h2><span class="count">what to retrain</span></div>' +
      (d.blindSpots.length ? d.blindSpots.slice(0, o.demo ? 4 : 6).map(spotHtml).join('') +
        '<p class="hint">Bring the top one up at the next pre-shift — or reword it, if the question is the problem.</p>'
        : '<div class="card muted">No blind spots yet. They appear once a question has been answered three times across the team.</div>') +
      '</div></div>' +
      (d.topics.length ? '<div class="section-title"><h2>By topic</h2><span class="count">share of answers missed</span></div><div class="card">' + d.topics.map(function (x) {
        return '<div class="topic-row"><span class="ellip">' + esc(x.topic) + '</span>' + bar(x.missRate, 'bad') + '<span class="pc">' + x.missRate + '%</span></div>';
      }).join('') + '</div>' : '') +
      '<div class="section-title"><h2>Decks</h2><span class="count">' + plural(d.decks.length, 'deck') + '</span></div>' +
      (d.decks.length ? d.decks.map(function (x) {
        return '<a class="deck" href="#/deck/' + encodeURIComponent(x.id) + '"><span class="e" aria-hidden="true">' + esc(x.emoji) + '</span><div class="grow"><b class="ellip">' + esc(x.title) + '</b><div class="sub">' + plural(x.count, 'question') + ' · ' + x.mastery + '% mastered</div>' +
          '' + bar(x.mastery) + '</div></a>';
      }).join('') : '<div class="card"><p class="muted">No decks yet.</p><a class="btn" href="#/new">Make your first deck</a></div>') +
      '<div class="section-title"><h2>Invite your team</h2><span class="count">' + plural(d.total, 'person', 'people') + ' · max 50</span></div>' +
      inviteCard(t.code, o.demo);
    wireSignup(view);
    wireDemoSwitch();
    wireInvite(t.code, o.demo);
    if (real) {
      $$('[data-person]').forEach(function (el) {
        var go = function () { openPerson(people.filter(function (p) { return p.id === el.dataset.person; })[0], t); };
        el.onclick = go;
        el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      });
    }
  }

  function inviteCard(code, demo) {
    return '<div class="card"><div class="invite"><span class="code-big num" aria-label="Join code">' + esc(code || '') + '</span>' +
      '<div class="grow small muted">Staff sign up free, tap <b>I have a join code</b>, and they’re in. Anyone with the code can join — reset it if it leaks.</div></div>' +
      '<div class="btn-row"><button class="btn small" id="copyLink"' + (demo ? ' disabled' : '') + '>Copy invite link</button>' +
      '<button class="btn small ghost" id="shareLink"' + (demo ? ' disabled' : '') + '>Share…</button>' +
      '<button class="btn small ghost" id="newCode"' + (demo ? ' disabled' : '') + '>New code</button></div></div>';
  }
  function inviteLink(code) { return location.origin + BASE + '#/join/' + encodeURIComponent(code); }
  function wireInvite(code, demo) {
    if (demo || !$('#copyLink')) return;
    var msg = function (c) { return 'Join our team on Pop Quiz — five quick questions a day. Code: ' + c + ' ' + inviteLink(c); };
    $('#copyLink').onclick = function () { copyText(inviteLink(code), 'Invite link copied.'); };
    $('#shareLink').onclick = function () {
      if (navigator.share) navigator.share({ title: 'Pop Quiz', text: msg(code) }).catch(function () { /* cancelled */ });
      else copyText(msg(code), 'Invite copied — paste it in your team chat.');
    };
    $('#newCode').onclick = function () {
      if (!window.confirm('Make a new code? The old one stops working straight away (people already on the team stay on it).')) return;
      api('POST', teamPath('/code')).then(function (r) { toast('New code: ' + r.code); route(); }).catch(function (e) { showError(e); });
    };
  }

  function openPerson(p, t) {
    if (!p) return;
    var canRemove = !p.you && (t.owner || p.role !== 'manager');
    sheet('<div class="row">' + av(p.name) + '<div><h2>' + esc(p.name) + '</h2><div class="small muted">' + (p.role === 'manager' ? 'Manager' : 'Staff') + (p.lastDoneDay ? ' · last quiz ' + esc(fmtDay(p.lastDoneDay)) : ' · no quiz yet') + '</div></div></div>' +
      '<div class="stat-row"><div class="stat fire"><b>' + ICON.flame + '' + p.streak + '</b><span>streak</span></div><div class="stat"><b>' + p.mastery + '%</b><span>known</span></div><div class="stat"><b>' + (p.accuracy == null ? '—' : p.accuracy + '%') + '</b><span>accuracy</span></div></div>' +
      '<p class="small muted">' + plural(p.answered, 'answer') + ' so far · ' + p.weekXp + ' XP this week. Which questions they miss shows up in the team’s blind spots, not per person.</p>' +
      (canRemove ? '<button class="btn danger block" id="rmBtn">Remove from team</button>' : ''),
    function (root) {
      var rm = $('#rmBtn', root);
      if (rm) rm.onclick = function () {
        if (!window.confirm('Remove ' + p.name + '? Their streak and progress on this team are deleted.')) return;
        api('DELETE', teamPath('/members/' + encodeURIComponent(p.id))).then(function () { closeSheet(); toast(p.name + ' removed.'); route(); }).catch(function (e) { showError(e); });
      };
    });
  }

  function demoSwitch() {
    return '<div class="seg" role="group" aria-label="Whose view"><button data-dv="manager" class="' + (state.demoView === 'manager' ? 'on' : '') + '">Manager’s view</button><button data-dv="staff" class="' + (state.demoView === 'staff' ? 'on' : '') + '">A staff member’s view</button></div>';
  }
  function wireDemoSwitch() {
    $$('[data-dv]').forEach(function (b) { b.onclick = function () { state.demoView = b.dataset.dv; renderTeam(); }; });
  }

  function drawMe(s, o) {
    var badges = s.badges || [];
    view.innerHTML = (o.demo ? sampleBar() + demoSwitch() : '') +
      '<div class="page-head"><div><h1>' + esc(o.name) + '</h1><div class="sub">' + esc(o.team.emoji + ' ' + o.team.name) + '</div></div></div>' +
      (s.atRisk ? '<div class="banner warn"><span class="e">' + ICON.flame + '</span><div><b>Your ' + s.streak + '-day streak ends at midnight.</b> <a href="#/today">Play today’s five</a>.</div></div>' : '') +
      '<div class="card"><div class="me-top">' + ring(s.mastery / 100, s.mastery + '%', 'known', '', s.mastery + '% mastered') +
      '<div class="grow"><b class="big">You know ' + s.known + ' of ' + plural(s.questions, 'question') + '</b><p class="small muted">A question counts as known once you’ve got it right twice in a row. Misses come back the next day until they stick.</p></div></div>' +
      '<div class="stat-row"><div class="stat fire"><b>' + ICON.flame + '' + s.streak + '</b><span>day streak</span></div><div class="stat xp"><b>' + s.weekXp + '</b><span>XP this week</span></div><div class="stat"><b>' + s.xp + '</b><span>XP all time</span></div></div>' +
      '<div class="stat-row"><div class="stat"><b>' + s.best + '</b><span>best streak</span></div><div class="stat"><b>' + s.perfectDays + '</b><span>perfect days</span></div><div class="stat"><b>' + s.daysDone + '</b><span>quizzes done</span></div></div></div>' +
      '<div class="section-title"><h2>Badges</h2><span class="count">' + badges.filter(function (b) { return b.earnedAt; }).length + ' of ' + badges.length + '</span></div>' +
      '<div class="badges">' + badges.map(function (b) {
        return '<div class="badge ' + (b.earnedAt ? 'earned' : 'locked') + '"><div class="e" aria-hidden="true">' + esc(b.emoji) + '</div><b>' + esc(b.label) + '</b><span>' + esc(b.earnedAt ? 'Earned ' + fmtDay(b.earnedAt) : b.detail) + '</span></div>';
      }).join('') + '</div>' +
      (o.demo ? '' : '<div class="section-title"><h2>On this team</h2></div><div class="card">' +
        '<label class="field"><span>Your name, as the team sees it</span><div class="row"><input class="input" id="myName" maxlength="30" value="' + esc(o.name) + '"><button class="btn small ghost" id="saveName">Save</button></div></label>' +
        '<button class="btn danger small" id="leaveBtn">Leave ' + esc(o.team.name) + '</button></div>');
    wireSignup(view);
    wireDemoSwitch();
    var sn = $('#saveName');
    if (sn) sn.onclick = function () {
      api('PUT', teamPath('/me'), { name: $('#myName').value }).then(function (r) { toast('Saved — you’re “' + r.name + '” on the leaderboard.'); }).catch(function (e) { showError(e); });
    };
    var lv = $('#leaveBtn');
    if (lv) lv.onclick = function () {
      if (!window.confirm('Leave ' + o.team.name + '? Your streak and progress there are deleted.')) return;
      api('DELETE', teamPath('/members/me')).then(function () { state.teamId = null; lsSet('pq-team', null); return loadMe(); }).then(function () { toast('You left the team.'); location.hash = '#/'; route(); }).catch(function (e) { showError(e); });
    };
  }

  function renderTeam() {
    loading();
    if (!signedIn()) {
      return loadDemo().then(function (d) {
        if (state.demoView === 'staff') drawMe(d.me, { demo: true, name: d.me.name, team: d.team });
        else drawDashboard(d.dashboard, { demo: true, team: d.team });
      }).catch(function (e) { showError(e, view); });
    }
    if (isManager()) {
      return api('GET', teamPath('/dashboard')).then(function (d) { drawDashboard(d, { team: d.team }); }).catch(function (e) { showError(e, view); });
    }
    api('GET', teamPath('/quiz')).then(function (d) { drawMe(d.stats, { name: d.team.you, team: d.team }); }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- decks ---------------- */

  function newDeckChoices(signedOut) {
    var quotes = Boolean(state.me && state.me.photoReader === 'gemini');
    return '<div class="rows choices">' +
      '<label class="rowlink" id="snapCard" tabindex="0" role="button"><span class="ricon">' + ICON.camera + '</span><span class="grow"><b>Snap a page</b><span class="sub">' +
      (quotes ? 'A photo of the binder page. Every question quotes the page, and you see what was read.' : 'A photo of the binder page or the laminated sign by the door.') + ' Read once, never stored.</span></span><span class="tag acc">AI · about 1¢</span>' +
      (signedOut ? '' : '<input type="file" accept="image/*" id="snapIn" class="file-in">') + '</label>' +
      '<a class="rowlink" href="#/new/paste"><span class="ricon">' + ICON.text + '</span><span class="grow"><b>Paste text</b><span class="sub">A menu, allergen sheet, checklist or returns policy. Pop Quiz drafts the questions for you to review.</span></span><span class="tag acc">AI · about 1¢</span></a>' +
      '<a class="rowlink" href="#/new/hand"><span class="ricon">' + ICON.pencil + '</span><span class="grow"><b>Write by hand</b><span class="sub">Multiple choice, true or false, or “which one is it?”.</span></span><span class="tag good">Free</span></a>' +
      '</div>';
  }

  function renderDecks() {
    loading();
    if (!signedIn()) {
      return loadDemo().then(function (d) {
        view.innerHTML = sampleBar() +
          '<div class="page-head"><div><h1>Decks</h1><div class="sub">' + esc(d.team.emoji + ' ' + d.team.name) + ' · what the team is learning</div></div></div>' +
          d.decks.map(function (x) {
            return '<a class="deck" href="#/deck/' + encodeURIComponent(x.id) + '"><span class="e" aria-hidden="true">' + esc(x.emoji) + '</span><div class="grow"><b>' + esc(x.title) + '</b><div class="sub">' + plural(x.count, 'question') + ' · ' + (x.source === 'photo' ? 'from a photo of the page' : 'from the staff sheet') + '</div></div>' + ICON.chev + '</a>';
          }).join('') +
          '<div class="section-title"><h2>Make a deck</h2></div>' + newDeckChoices(true);
        wireSignup(view);
        $('#snapCard').onclick = function (e) { e.preventDefault(); needAccount('Sign up free to turn a photo of your own binder into questions.'); };
      }).catch(function (e) { showError(e, view); });
    }
    api('GET', teamPath('')).then(function (t) {
      var b = state.me.budget || {};
      view.innerHTML = '<div class="page-head"><div><h1>Decks</h1><div class="sub">' + esc(t.emoji + ' ' + t.name) + ' · ' + plural(t.questions, 'question') + ' live</div></div>' +
        '<span class="pill credit" title="AI credit">' + (b.unlimited ? '∞' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span></div>' +
        (draftOf() ? '<a class="banner link" href="#/review"><div><b>You have a draft waiting for review.</b> Nothing is live until you publish it. <span class="go">Open it</span></div></a>' : '') +
        (t.decks.length ? t.decks.map(function (x) {
          return '<a class="deck" href="#/deck/' + encodeURIComponent(x.id) + '"><span class="e" aria-hidden="true">' + esc(x.emoji) + '</span><div class="grow"><b class="ellip">' + esc(x.title) + '</b><div class="sub">' + plural(x.count, 'question') + ' · ' + ({ text: 'from text', photo: 'from a photo', hand: 'written by hand' }[x.source] || '') + ' · ' + esc(fmtDay(x.publishedAt)) + '</div></div>' + ICON.chev + '</a>';
        }).join('') : '<div class="empty"><h2>No decks yet</h2><p>Start with the thing new hires get wrong most — usually allergens or closing.</p></div>') +
        '<div class="section-title"><h2>New deck</h2></div>' + newDeckChoices(false);
      wireSnap();
    }).catch(function (e) { showError(e, view); });
  }

  function wireSnap() {
    var input = $('#snapIn');
    if (!input) return;
    input.onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) snap(f);
    };
    var card = $('#snapCard');
    if (card) card.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
  }

  function draftKey() { return 'pq-draft-' + state.teamId; }
  function draftOf() { try { var s = lsGet(draftKey()); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function saveDraft() { if (state.editor && state.editor.mode === 'new') lsSet(draftKey(), JSON.stringify(state.editor)); }
  function dropDraft() { lsSet(draftKey(), null); }

  function renderNewDeck(mode) {
    if (mode === 'hand') {
      if (!signedIn()) return needAccount('Sign up free to write your own questions.');
      state.editor = { mode: 'new', title: '', emoji: '📘', source: 'hand', questions: [blankQuestion('mcq')], dropped: 0 };
      saveDraft();
      location.hash = '#/review';
      return;
    }
    if (mode !== 'paste') {
      view.innerHTML = backLink('#/decks', 'Decks') + '<div class="page-head"><div><h1>New deck</h1><div class="sub">You review every question before your team sees it.</div></div></div>' + newDeckChoices(!signedIn());
      wireSnap();
      var sc = $('#snapCard'); if (sc && !signedIn()) sc.onclick = function (e) { e.preventDefault(); needAccount('Sign up free to turn a photo of your own binder into questions.'); };
      return;
    }
    var demo = !signedIn();
    view.innerHTML = (demo ? sampleBar('Try it with Slice Society’s staff sheet — sign up to run it on yours.') : '') + backLink('#/new', 'New deck') +
      '<div class="page-head"><div><h1>Paste your material</h1><div class="sub">Menus, allergen lists, opening &amp; closing, safety rules, the returns policy, an upsell script.</div></div></div>' +
      '<div class="card">' +
      '<label class="field"><span>Deck title</span><input class="input" id="pTitle" maxlength="60" placeholder="e.g. Menu & allergens"></label>' +
      '<label class="field"><span>The material</span><textarea class="input" id="pText" rows="10" maxlength="12000" placeholder="Paste a page or two. Only what’s written here gets asked about."></textarea></label>' +
      '<div class="row spread small muted"><span id="pCount">0 / 12,000</span><span>Only facts in the text are used.</span></div>' +
      '<div class="field"><span>How many questions</span><div class="seg" id="pN" role="group" aria-label="How many questions"><button data-n="6">6</button><button data-n="8" class="on">8</button><button data-n="10">10</button><button data-n="12">12</button></div></div>' +
      '<div id="pErr"></div>' +
      '<button class="btn lg block" id="pGo">' + ICON.spark + 'Write the questions</button>' +
      '<p class="hint center">Uses a little AI credit (about a cent). Nothing is saved until you publish.</p></div>';
    var n = 8;
    var ta = $('#pText');
    var count = function () { $('#pCount').textContent = ta.value.length.toLocaleString() + ' / 12,000'; };
    if (demo) { $('#pTitle').value = 'Menu & allergens'; loadDemo().then(function (d) { ta.value = d.material; count(); }); }
    ta.oninput = count;
    wireSignup(view);
    $$('#pN button').forEach(function (b) { b.onclick = function () { n = Number(b.dataset.n); $$('#pN button').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
    $('#pGo').onclick = function () {
      if (demo) return needAccount('Sign up free to turn your own material into questions — you get $2 of credit, which is a couple of hundred decks.');
      var btn = this;
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Reading your material…';
      api('POST', teamPath('/generate'), { text: ta.value, title: $('#pTitle').value, count: n }).then(function (p) {
        loadMe();
        startReview(p);
      }).catch(function (e) {
        btn.disabled = false; btn.innerHTML = ICON.spark + 'Write the questions';
        showError(e, $('#pErr'));
      });
    };
  }

  function startReview(p) {
    state.editor = {
      mode: 'new', title: p.title || '', emoji: '📘', source: p.source || 'text', questions: p.questions, dropped: p.dropped || 0,
      // Only a page read with quotes carries these: what the model read, kept on this device with the draft.
      transcription: p.grounded && p.transcription ? String(p.transcription) : '', ungrounded: p.ungrounded || 0,
    };
    saveDraft();
    location.hash = '#/review';
  }

  /** The photo, made small on this device before it is sent: 1600px at most,
   *  then smaller and softer until it is under about 2 MB. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var tries = [[1600, 0.85], [1600, 0.7], [1280, 0.7], [1024, 0.6]];
        var data = '';
        for (var k = 0; k < tries.length; k++) {
          var s = Math.min(1, tries[k][0] / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          data = c.toDataURL('image/jpeg', tries[k][1]);
          if (data.length <= 2800000) break;
        }
        URL.revokeObjectURL(url);
        if (data.length > 5300000) return reject(new Error('That photo is too large even after shrinking. Try a closer shot of one page.'));
        resolve({ type: 'image/jpeg', data: data });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That image could not be opened. Try a JPEG or PNG photo.')); };
      img.src = url;
    });
  }
  function snap(file) {
    var quotes = Boolean(state.me && state.me.photoReader === 'gemini');
    view.setAttribute('data-page', 'reading');
    view.innerHTML = '<div class="reading" role="status"><span class="spinner" aria-hidden="true"></span><h2>Reading the page</h2>' +
      '<ol class="reading-steps"><li>The photo is shrunk on this device</li><li>The page is read once</li><li>' + (quotes ? 'Questions are written from its own words' : 'Questions are drafted for you to review') + '</li></ol>' +
      '<p class="hint">The photo is not stored. Nothing is live until you publish.</p></div>';
    shrink(file).then(function (image) {
      return api('POST', teamPath('/generate/photo'), { image: image });
    }).then(function (p) {
      loadMe();
      toast(p.grounded ? 'Read once, not stored. Every question quotes the page.' : 'Read once, not stored. Review the questions below.', 3200);
      startReview(p);
    }).catch(function (e) {
      renderDecks();
      setTimeout(function () { showError(e); }, 50);
    });
  }

  /* ---------------- the editor: review before publishing ---------------- */

  function blankQuestion(type) {
    if (type === 'tf') return { type: 'tf', prompt: '', options: ['True', 'False'], answer: 0, explanation: '', source: '', topic: '' };
    if (type === 'which') return { type: 'which', prompt: '', options: ['', '', ''], answer: null, explanation: '', source: '', topic: '' };
    return { type: 'mcq', prompt: '', options: ['', '', '', ''], answer: null, explanation: '', source: '', topic: '' };
  }
  function retype(q, type) {
    if (q.type === type) return q;
    var n = Object.assign({}, q, { type: type });
    if (type === 'tf') { n.options = ['True', 'False']; n.answer = 0; return n; }
    var opts = q.type === 'tf' ? [] : q.options.slice(0, 4);
    var want = type === 'mcq' ? 4 : Math.max(2, Math.min(4, opts.length || 3));
    while (opts.length < want) opts.push('');
    n.options = opts.slice(0, want);
    n.answer = q.type !== 'tf' && q.answer != null && q.answer < n.options.length ? q.answer : null;
    return n;
  }
  function check(q) { return PQ.validateQuestion(q); }

  /* A page read with quotes: the draft carries what was read, and every
     question's quote can be looked up in it - the same loose match the
     server made (spacing, case and quote style aside). */
  function foldText(v) {
    return String(v || '').replace(/[\u2018\u2019\u201A\u2032`]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function onPage(source) {
    var ed = state.editor;
    var w = foldText(source);
    return Boolean(ed && ed.transcription && w.length >= 12 && foldText(ed.transcription).indexOf(w) >= 0);
  }
  function proofHtml(q) {
    var ed = state.editor;
    if (!ed || !ed.transcription) return '';
    if (!(q.source || '').trim()) return '<span class="proof off">No quote from the page</span>';
    return onPage(q.source) ? '<button type="button" class="proof ok" data-proof>' + ICON.check + 'On the page<span class="sr-only">: show it</span></button>' : '<span class="proof off">Edited: not the page’s words</span>';
  }
  function drawPageText(source) {
    var ed = state.editor;
    var el = $('#pageText');
    if (!el || !ed) return;
    var w = source ? foldText(source) : '';
    var hit = false;
    el.innerHTML = ed.transcription.split('\n').map(function (line) {
      var l = line.replace(/\s+/g, ' ').trim();
      var f = foldText(l);
      var at = w && !hit && f.length === l.length ? f.indexOf(w) : -1;
      if (at < 0) return esc(l);
      hit = true;
      return esc(l.slice(0, at)) + '<mark>' + esc(l.slice(at, at + w.length)) + '</mark>' + esc(l.slice(at + w.length));
    }).join('\n');
  }
  function showOnPage(source) {
    var d = $('#pageRead');
    if (!d) return;
    d.open = true;
    drawPageText(source);
    ($('mark', d) || d).scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function qedHtml(q, i) {
    var tf = q.type === 'tf';
    var r = check(q);
    return '<div class="qed' + (r.error && q.prompt ? ' bad' : '') + '" data-q="' + i + '">' +
      '<div class="qed-head"><span class="n">' + (i + 1) + '</span><div class="seg" role="group" aria-label="Question type">' +
      ['mcq', 'tf', 'which'].map(function (t) { return '<button type="button" data-type="' + t + '" class="' + (q.type === t ? 'on' : '') + '" aria-pressed="' + (q.type === t) + '">' + TYPE_SHORT[t] + '</button>'; }).join('') +
      '</div><button type="button" class="icon-btn" data-del aria-label="Delete question ' + (i + 1) + '">' + ICON.trash + '</button></div>' +
      '<textarea class="input" data-f="prompt" rows="2" maxlength="240" aria-label="Question ' + (i + 1) + '" placeholder="' + (tf ? 'A statement to judge, e.g. “Garlic knots are vegan.”' : q.type === 'which' ? 'e.g. Which one has walnuts in it?' : 'e.g. What must the walk-in read before you leave?') + '">' + esc(q.prompt) + '</textarea>' +
      '<div class="ed-opts" role="radiogroup" aria-label="Options - pick the right answer">' + q.options.map(function (o, j) {
        return '<div class="ed-opt' + (q.answer === j ? ' is-right' : '') + '"><label class="rad" title="The right answer"><input type="radio" name="ans' + i + '" data-ans="' + j + '"' + (q.answer === j ? ' checked' : '') + ' aria-label="Option ' + (j + 1) + ' is right"></label>' +
          '<input class="input" data-o="' + j + '" maxlength="100" value="' + esc(o) + '"' + (tf ? ' readonly' : '') + ' aria-label="Option ' + (j + 1) + '" placeholder="Option ' + 'ABCD'.charAt(j) + '">' +
          (q.type === 'which' && q.options.length > 2 ? '<button type="button" class="icon-btn" data-rmo="' + j + '" aria-label="Remove option ' + (j + 1) + '">' + ICON.x + '</button>' : '') + '</div>';
      }).join('') + '</div>' +
      (q.type === 'which' && q.options.length < 4 ? '<button type="button" class="link-btn small" data-addo>Add an option</button>' : '') +
      '<div class="lbl">Why — shown after they answer</div>' +
      '<textarea class="input" data-f="explanation" rows="2" maxlength="300" placeholder="One line on why. People remember the reason, not the rule.">' + esc(q.explanation) + '</textarea>' +
      '<div class="lbl">' + (state.editor && state.editor.transcription ? 'From the page' : 'Quote and topic') + '<span data-proofline>' + proofHtml(q) + '</span></div>' +
      '<div class="more"><input class="input" data-f="source" maxlength="200" value="' + esc(q.source) + '" placeholder="Quote from the material" aria-label="Source quote"><input class="input" data-f="topic" maxlength="40" value="' + esc(q.topic) + '" placeholder="Topic, e.g. Allergens" aria-label="Topic"></div>' +
      '<div class="qerr" aria-live="polite">' + (r.error && q.prompt ? esc(r.error) : '') + '</div>' +
      '</div>';
  }

  function renderReview() {
    if (!state.editor || state.editor.mode !== 'new') state.editor = draftOf();
    if (!state.editor) { location.hash = '#/decks'; return; }
    drawEditor();
  }

  function renderDeckEdit(id) {
    if (!signedIn()) return renderDemoDeck(id);
    loading();
    api('GET', teamPath('/decks/' + encodeURIComponent(id))).then(function (d) {
      state.editor = { mode: 'edit', deckId: d.id, title: d.title, emoji: d.emoji, source: d.source, questions: d.questions, dropped: 0 };
      drawEditor();
    }).catch(function (e) { showError(e, view); });
  }

  function drawEditor() {
    var ed = state.editor;
    var isNew = ed.mode === 'new';
    view.innerHTML = backLink('#/decks', 'Decks') +
      '<div class="page-head"><div><h1>' + (isNew ? 'Review before publishing' : 'Edit deck') + '</h1><div class="sub">' + (isNew ? ({ text: 'Drafted from your text', photo: 'Drafted from your photo', hand: 'Written by you' }[ed.source] || '') : 'Changes reach your team’s next quiz') + '</div></div></div>' +
      (isNew ? '<div class="banner"><div><b>' + (ed.transcription ? 'Every question below quotes the page.' : 'This is a proposal.') + ' Nothing is saved until you publish.</b> Fix anything that’s off, delete what doesn’t matter, add your own.' + leftOut(ed) + '</div></div>' : '') +
      (isNew && ed.transcription ? '<details class="page-read" id="pageRead"><summary>' + ICON.page + '<span class="grow">What was read on the page</span>' + ICON.chev + '</summary><pre id="pageText"></pre>' +
        '<p class="hint">Read once; the photo was not kept. This text stays on this device with the draft, and goes when you publish or discard.</p></details>' : '') +
      '<div class="card"><label class="field"><span>Deck title</span><input class="input" id="edTitle" maxlength="60" value="' + esc(ed.title) + '" placeholder="e.g. Closing checklist"></label>' +
      '<div class="field"><span>Icon</span><div class="emoji-grid" role="radiogroup" aria-label="Deck icon">' + DECK_EMOJIS.map(function (e) { return '<button type="button" role="radio" aria-checked="' + (ed.emoji === e) + '" class="' + (ed.emoji === e ? 'on' : '') + '" data-em="' + e + '">' + e + '</button>'; }).join('') + '</div></div></div>' +
      '<div class="section-title"><h2>Questions</h2><span class="count" id="edCount"></span></div>' +
      '<div id="qlist"></div>' +
      '<button type="button" class="btn ghost block" id="addQ">' + ICON.plus + 'Add a question</button>' +
      '<div id="edErr"></div>' +
      '<div class="publish-bar">' + (isNew ? '<button type="button" class="btn ghost" id="discard">Discard</button>' : '<button type="button" class="btn danger" id="delDeck">Delete</button>') +
      '<button type="button" class="btn" id="publish"></button></div>';
    drawList();
    drawPageText('');
    $('#edTitle').oninput = function () { ed.title = this.value; saveDraft(); updateBar(); };
    $$('[data-em]').forEach(function (b) {
      b.onclick = function () { ed.emoji = b.dataset.em; $$('[data-em]').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); }); saveDraft(); };
    });
    $('#addQ').onclick = function () {
      if (ed.questions.length >= PQ.LIMITS.perDeck) return toast('A deck holds up to ' + PQ.LIMITS.perDeck + ' questions.');
      ed.questions.push(blankQuestion('mcq')); saveDraft(); drawList();
      var last = $$('.qed').pop(); if (last) { last.scrollIntoView({ block: 'center' }); $('textarea', last).focus(); }
    };
    var discard = $('#discard');
    if (discard) discard.onclick = function () {
      if (!window.confirm('Discard this draft? None of it was published.')) return;
      dropDraft(); state.editor = null; location.hash = '#/decks';
    };
    var del = $('#delDeck');
    if (del) del.onclick = function () {
      if (!window.confirm('Delete “' + ed.title + '”? Its questions leave your team’s quizzes.')) return;
      api('DELETE', teamPath('/decks/' + encodeURIComponent(ed.deckId))).then(function () { toast('Deck deleted.'); state.editor = null; location.hash = '#/decks'; }).catch(function (e) { showError(e); });
    };
    $('#publish').onclick = publish;

    var list = $('#qlist');
    list.addEventListener('input', function (e) {
      var card = e.target.closest('.qed'); if (!card) return;
      var q = ed.questions[Number(card.dataset.q)];
      if (e.target.dataset.f) q[e.target.dataset.f] = e.target.value;
      if (e.target.tagName === 'TEXTAREA') fit(e.target);
      if (e.target.dataset.o !== undefined) q.options[Number(e.target.dataset.o)] = e.target.value;
      refreshCard(card, q);
      saveDraft();
    });
    list.addEventListener('change', function (e) {
      if (e.target.dataset.ans === undefined) return;
      var card = e.target.closest('.qed');
      var q = ed.questions[Number(card.dataset.q)];
      q.answer = Number(e.target.dataset.ans);
      $$('.ed-opt', card).forEach(function (el, j) { el.classList.toggle('is-right', j === q.answer); });
      refreshCard(card, q);
      saveDraft();
    });
    list.addEventListener('click', function (e) {
      var t = e.target.closest('button'); if (!t) return;
      var card = t.closest('.qed'); if (!card) return;
      var i = Number(card.dataset.q);
      var q = ed.questions[i];
      if (t.hasAttribute('data-proof')) { showOnPage(q.source); return; }
      if (t.dataset.type) { ed.questions[i] = retype(q, t.dataset.type); }
      else if (t.hasAttribute('data-del')) {
        if ((q.prompt || '').trim() && !window.confirm('Delete question ' + (i + 1) + '?')) return;
        ed.questions.splice(i, 1);
      } else if (t.dataset.rmo !== undefined) {
        var j = Number(t.dataset.rmo);
        q.options.splice(j, 1);
        if (q.answer === j) q.answer = null; else if (q.answer > j) q.answer--;
      } else if (t.hasAttribute('data-addo')) { q.options.push(''); }
      else return;
      saveDraft();
      drawList();
    });
  }

  /** What the checks left out of a draft, said plainly. */
  function leftOut(ed) {
    var un = Math.min(ed.ungrounded || 0, ed.dropped || 0);
    var other = (ed.dropped || 0) - un;
    return (un ? ' ' + plural(un, 'draft question') + ' had no sentence on the page behind ' + (un === 1 ? 'it and was' : 'them and were') + ' left out.' : '') +
      (other ? ' ' + plural(other, 'draft question') + ' didn’t pass our checks and ' + (other === 1 ? 'was' : 'were') + ' left out.' : '');
  }

  function drawList() {
    var ed = state.editor;
    $('#qlist').innerHTML = ed.questions.length ? ed.questions.map(qedHtml).join('') : '<div class="card muted">No questions left. Add one below — or discard the draft.</div>';
    $$('#qlist textarea').forEach(fit);
    updateBar();
  }
  /** A question box grows to fit what is in it (field-sizing in the stylesheet); rows is the fallback. */
  function fit(ta) { ta.rows = Math.max(2, Math.min(8, Math.ceil(ta.value.length / 34))); }
  function refreshCard(card, q) {
    var r = check(q);
    var show = r.error && (q.prompt || '').trim();
    card.classList.toggle('bad', Boolean(show));
    $('.qerr', card).textContent = show ? r.error : '';
    var pl = $('[data-proofline]', card); if (pl) pl.innerHTML = proofHtml(q);
    updateBar();
  }
  function updateBar() {
    var ed = state.editor;
    var bad = ed.questions.filter(function (q) { return check(q).error; }).length;
    var n = ed.questions.length;
    $('#edCount').textContent = plural(n, 'question') + (bad ? ' · ' + bad + ' to fix' : ' · all good');
    var btn = $('#publish');
    btn.disabled = !n || bad > 0 || (ed.title || '').trim().length < 2;
    btn.textContent = ed.mode === 'new' ? 'Publish ' + plural(n, 'question') : 'Save changes';
  }

  function publish() {
    var ed = state.editor;
    var btn = $('#publish');
    btn.disabled = true;
    var body = { title: ed.title, emoji: ed.emoji, source: ed.source, questions: ed.questions };
    var req = ed.mode === 'new' ? api('POST', teamPath('/decks'), body) : api('PUT', teamPath('/decks/' + encodeURIComponent(ed.deckId)), body);
    req.then(function (d) {
      if (ed.mode === 'new') dropDraft();
      state.editor = null;
      toast(ed.mode === 'new' ? 'Published. ' + plural(d.questions.length, 'question') + ' join your team’s daily quiz.' : 'Saved.', 3400);
      location.hash = '#/decks';
    }).catch(function (e) {
      updateBar();
      showError(e, $('#edErr'));
      if (e.data && e.data.index !== undefined) {
        var card = $('.qed[data-q="' + e.data.index + '"]');
        if (card) { card.classList.add('bad', 'flash'); card.scrollIntoView({ block: 'center' }); }
      }
    });
  }

  function renderDemoDeck(id) {
    loading();
    loadDemo().then(function (d) {
      var deck = d.decks.filter(function (x) { return x.id === id; })[0];
      if (!deck) { location.hash = '#/decks'; return; }
      view.innerHTML = sampleBar() + backLink('#/decks', 'Decks') +
        '<div class="page-head"><div><h1>' + esc(deck.emoji + ' ' + deck.title) + '</h1><div class="sub">' + plural(deck.count, 'question') + ' · what the manager approved</div></div></div>' +
        deck.questions.map(function (q, i) {
          return '<div class="qed"><div class="qed-head"><span class="n">' + (i + 1) + '</span><span class="qtype">' + esc(TYPE_LABEL[q.type]) + '</span><span class="grow"></span><span class="tag">' + esc(q.topic) + '</span></div>' +
            '<div class="qed-q">' + esc(q.prompt) + '</div>' +
            '<div class="ed-opts">' + q.options.map(function (o, j) { return '<div class="ed-opt' + (j === q.answer ? ' is-right' : '') + '"><span class="input ro">' + (j === q.answer ? ICON.check : '') + esc(o) + '</span></div>'; }).join('') + '</div>' +
            '<p class="small muted">' + esc(q.explanation) + '</p></div>';
        }).join('');
      wireSignup(view);
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- join and create ---------------- */

  function fmtCodeInput(v) { var s = PQ.normalizeCode(v).slice(0, 8); return s.length > 4 ? s.slice(0, 4) + '-' + s.slice(4) : s; }

  function renderJoin(code) {
    var me = state.me || {};
    view.innerHTML = '<div class="narrow">' + (signedIn() && teams().length ? backLink('#/today', 'Back') : '') +
      '<div class="empty"><h2>Join your team</h2><p>Your manager has an 8-character code. Joining is free — you’ll get five quick questions a day.</p></div>' +
      '<form class="card" id="joinForm" autocomplete="off">' +
      '<label class="field"><span>Join code</span><input class="input code-input" id="jCode" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="11" placeholder="ABCD-EFGH" value="' + esc(fmtCodeInput(code)) + '" required></label>' +
      '<label class="field"><span>Your name, as the team will see it</span><input class="input" id="jName" maxlength="30" value="' + esc(me.name || '') + '" placeholder="e.g. Priya"></label>' +
      '<div id="jErr"></div><button class="btn lg block" type="submit">Join team</button></form>' +
      '<p class="center small muted">Running the training? <a href="#/create">Start a team</a> · <a href="#/sample">Try the sample quiz</a></p></div>';
    var input = $('#jCode');
    input.oninput = function () { var p = input.selectionStart === input.value.length; input.value = fmtCodeInput(input.value); if (p) input.selectionStart = input.selectionEnd = input.value.length; };
    $('#joinForm').onsubmit = function (e) {
      e.preventDefault();
      var c = PQ.normalizeCode(input.value);
      if (c.length !== 8) return showError(new Error('Codes are 8 letters and numbers, like ABCD-EFGH.'), $('#jErr'));
      if (!signedIn()) {
        lsSet('pq-join', c + '|' + $('#jName').value);
        return openAccount('Create a free account to join — it takes 20 seconds. Your code is saved.');
      }
      doJoin(c, $('#jName').value, $('#jErr'), $('button[type=submit]', this));
    };
    if (!code) input.focus();
  }

  function doJoin(code, name, errEl, btn) {
    if (btn) btn.disabled = true;
    return api('POST', 'api/join', { code: code, name: name }).then(function (r) {
      return loadMe().then(function () {
        setTeam(r.id);
        toast(r.already ? 'You’re already on ' + r.name + '.' : 'Welcome to ' + r.emoji + ' ' + r.name + '! Here’s today’s quiz.', 3400);
        if (location.hash === '#/today') route(); else location.hash = '#/today';
      });
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      if (!errEl) { location.hash = '#/join/' + encodeURIComponent(code); setTimeout(function () { showError(e, $('#jErr')); }, 60); return; }
      showError(e, errEl);
    });
  }

  function renderCreate() {
    var me = state.me || {};
    var emoji = '🍕';
    view.innerHTML = '<div class="narrow">' + (signedIn() && teams().length ? backLink('#/team', 'Back') : '') +
      '<div class="page-head"><div><h1>Start a team</h1><div class="sub">Free. Up to 50 people, and you can run up to 5 teams.</div></div></div>' +
      '<form class="card" id="createForm">' +
      '<label class="field"><span>Team or business name</span><input class="input" id="cName" maxlength="40" required placeholder="e.g. Slice Society — front of house"></label>' +
      '<div class="field"><span>Icon</span><div class="emoji-grid" role="radiogroup" aria-label="Team icon">' + EMOJIS.map(function (e) { return '<button type="button" role="radio" aria-checked="' + (e === emoji) + '" class="' + (e === emoji ? 'on' : '') + '" data-em="' + e + '">' + e + '</button>'; }).join('') + '</div></div>' +
      '<label class="field"><span>Your name, as the team will see it</span><input class="input" id="cYou" maxlength="30" value="' + esc(me.name || '') + '" placeholder="e.g. Gio"></label>' +
      '<div id="cErr"></div><button class="btn lg block" type="submit">Create team</button></form></div>';
    $$('[data-em]').forEach(function (b) {
      b.onclick = function () { emoji = b.dataset.em; $$('[data-em]').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); }); };
    });
    $('#createForm').onsubmit = function (e) {
      e.preventDefault();
      if (!signedIn()) return openAccount('Create a free account first — then your team is one tap away.');
      var btn = $('button[type=submit]', this); btn.disabled = true;
      api('POST', 'api/teams', { name: $('#cName').value, emoji: emoji, yourName: $('#cYou').value }).then(function (t) {
        return loadMe().then(function () {
          setTeam(t.id);
          location.hash = '#/decks';
          setTimeout(function () { openInviteSheet(t); }, 80);
        });
      }).catch(function (err) { btn.disabled = false; showError(err, $('#cErr')); });
    };
  }

  function openInviteSheet(t) {
    sheet('<h2>' + esc(t.emoji + ' ' + t.name) + ' is ready</h2><p class="muted">Share this code with your team. They sign up free and tap <b>I have a join code</b>.</p>' +
      '<div class="center"><span class="code-big">' + esc(t.code) + '</span></div>' +
      '<div class="btn-row"><button class="btn" id="sCopy">Copy invite link</button><button class="btn ghost" id="sShare">Share…</button></div>' +
      '<p class="small muted">Next: add your first deck below — paste your menu or checklist, or snap a photo of the page.</p>',
    function (root) {
      var text = 'Join our team on Pop Quiz — five quick questions a day. Code: ' + t.code + ' ' + inviteLink(t.code);
      $('#sCopy', root).onclick = function () { copyText(inviteLink(t.code), 'Invite link copied.'); };
      $('#sShare', root).onclick = function () {
        if (navigator.share) navigator.share({ title: 'Pop Quiz', text: text }).catch(function () { /* cancelled */ });
        else copyText(text, 'Invite copied — paste it in your team chat.');
      };
    });
  }

  /* ---------------- start ---------------- */

  loadMe().then(route);
})();
