/* Glowup - the page. One file, no build step, every typed or model-written string escaped. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');
  var R = window.GlowRules;

  // Where the app is mounted: '/' on its own, '/glowup/' inside the lab. The
  // public card lives one level down (s/<token>) with <base href="../">, so
  // the base comes from the document's base URI rather than the path.
  var BASE = new URL('.', document.baseURI).pathname;
  var PUB = location.pathname.match(/\/s\/([A-Za-z0-9_-]{22,40})\/?$/);

  var SOURCE = { paste: 'Pasted', snap: 'From a screenshot', edit: 'Edited', glowup: 'Glow-up', revert: 'Went back' };
  var DRAFT_KEY = 'glowup-draft';

  var state = { me: null, demo: null, glow: {}, snapped: null, cur: null };

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localToday() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

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

  function fmtDay(iso) {
    if (!iso) return '';
    return new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  }
  function initials(s) { return String(s || '?').split(/[\s@.]+/).filter(Boolean).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it.'); });
  }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(window.innerHeight * 0.7, Math.max(ta.scrollHeight + 4, 120)) + 'px'; }

  function confetti() {
    if (reducedMotion()) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var colors = ['#f59e0b', '#ec4899', '#a855f7', '#fde68a', '#f0abfc', '#4ade80'];
    for (var i = 0; i < 90; i++) {
      var p = document.createElement('i');
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = Math.random() * 0.6 + 's';
      p.style.animationDuration = 1.4 + Math.random() * 1.2 + 's';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3400);
    window.addEventListener('hashchange', function () { box.remove(); }, { once: true });
  }

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9z"/></svg>',
  };

  // One gradient for every "glowing" dial, defined once.
  (function () {
    var d = document.createElement('div');
    d.innerHTML = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs><linearGradient id="glowGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f59e0b"/><stop offset=".55" stop-color="#ec4899"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs></svg>';
    document.body.appendChild(d.firstChild);
  })();

  /* ---------------- the dial, the rings, the sparkline ---------------- */

  var ARC = Math.PI * 50;
  function gcls(score) { return 'g-' + R.gradeOf(score).key; }

  /** The credit-score dial. `from` makes it climb from one score to another. */
  function gauge(score, opts) {
    opts = opts || {};
    var g = R.gradeOf(score);
    var start = opts.from != null ? opts.from : 0;
    return '<div class="gauge ' + (opts.size || '') + ' ' + gcls(start) + '" data-score="' + score + '" data-from="' + start + '" role="img" aria-label="Glow score ' + score + ' of 100, ' + esc(g.label) + '">' +
      '<svg viewBox="0 0 120 66" aria-hidden="true"><path class="trk" d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke-width="9" stroke-linecap="round"/>' +
      '<path class="arc" d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + ARC.toFixed(2) + '" stroke-dashoffset="' + (ARC * (1 - start / 100)).toFixed(2) + '"/></svg>' +
      '<div class="readout"><b>' + start + '</b><span>' + esc(R.gradeOf(start).emoji + ' ' + R.gradeOf(start).label) + '</span></div></div>';
  }

  /** Move every dial in `root` to its score: the arc sweeps, the number counts. */
  function animateGauges(root, delay) {
    $$('.gauge[data-score]', root).forEach(function (el) {
      var to = Number(el.dataset.score), from = Number(el.dataset.from || 0);
      setGauge(el, from, to, delay || 0);
    });
  }
  function setGauge(el, from, to, delay) {
    var arc = $('.arc', el), num = $('.readout b', el), lab = $('.readout span', el);
    var paint = function (v) {
      var g = R.gradeOf(v);
      el.className = el.className.replace(/\bg-\w+/g, '').trim() + ' ' + gcls(v);
      num.textContent = v;
      lab.textContent = g.emoji + ' ' + g.label;
    };
    el.dataset.score = to;
    if (reducedMotion() || from === to) { arc.style.strokeDashoffset = (ARC * (1 - to / 100)).toFixed(2); paint(to); return; }
    setTimeout(function () {
      arc.style.strokeDashoffset = (ARC * (1 - to / 100)).toFixed(2);
      var t0 = null, dur = 1300;
      function step(t) {
        if (!t0) t0 = t;
        var k = Math.min(1, (t - t0) / dur);
        var e = 1 - Math.pow(1 - k, 3);
        paint(Math.round(from + (to - from) * e));
        if (k < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }, 60 + (delay || 0));
  }

  function catVal(cats, key) { var v = cats && cats[key]; return typeof v === 'number' ? v : (v && typeof v.score === 'number' ? v.score : 0); }

  function rings(cats, opts) {
    opts = opts || {};
    return '<div class="rings" role="list">' + R.CATS.map(function (c) {
      var v = catVal(cats, c.key), pct = Math.round(v / R.CAT_MAX * 100);
      var cls = pct >= 90 ? 'g-great' : pct >= 60 ? 'g-good' : pct >= 40 ? 'g-okay' : 'g-dim';
      return '<div class="ring ' + cls + '" role="listitem" aria-label="' + esc(c.label) + ': ' + v + ' of 20">' +
        '<div class="ring-wrap"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="trk" cx="18" cy="18" r="15.9" fill="none" stroke-width="3.6"/>' +
        '<circle class="val" cx="18" cy="18" r="15.9" fill="none" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="100 100" stroke-dashoffset="' + (opts.still ? 100 - pct : 100) + '" data-pct="' + pct + '"/></svg>' +
        '<span class="e" aria-hidden="true">' + c.emoji + '</span></div>' +
        '<span class="lab">' + esc(c.label) + '</span><span class="pts">' + v + '<small>/20</small></span></div>';
    }).join('') + '</div>';
  }
  function animateRings(root) {
    var go = function () { $$('.ring .val', root).forEach(function (c) { c.style.strokeDashoffset = 100 - Number(c.dataset.pct); }); };
    if (reducedMotion()) go(); else setTimeout(go, 80);
  }

  function sparkSvg(scores, w, h, cls) {
    var pts = R.sparkline(scores || [], w, h, 4);
    if (!pts.length) return '';
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' ');
    var area = d + ' L' + pts[pts.length - 1][0] + ' ' + h + ' L' + pts[0][0] + ' ' + h + ' Z';
    var last = pts[pts.length - 1];
    return '<svg class="spark ' + (cls || '') + '" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true"><path class="a" d="' + area + '"/><path class="l" d="' + d + '"/><circle cx="' + last[0] + '" cy="' + last[1] + '" r="3"/></svg>';
  }

  function deltaChip(from, to, label) {
    var d = to - from;
    var cls = d > 0 ? '' : d < 0 ? ' down' : ' flat';
    return '<span class="delta' + cls + '">' + (d > 0 ? '▲ +' : d < 0 ? '▼ ' : '') + d + (label ? ' ' + esc(label) : '') + '</span>';
  }

  function fixesHtml(result, opts) {
    opts = opts || {};
    var fx = result.fixes.slice(0, opts.limit || 99);
    var html = fx.length ? '<ul class="fixes">' + fx.map(function (f) {
      var c = R.catInfo(f.cat);
      return '<li><span class="e" aria-hidden="true">' + c.emoji + '</span><div><b>' + esc(f.label) + '</b><span>' + esc(f.fix) + '</span></div><span class="lost">−' + f.lost + '</span></li>';
    }).join('') + '</ul>' : '<div class="banner good"><span class="e">✨</span><span>Nothing left to fix. This listing is glowing.</span></div>';
    if (opts.good) {
      var ok = result.checks.filter(function (c) { return c.ok; });
      if (ok.length) {
        html += '<details class="more"><summary>What’s already working (' + ok.length + ')</summary><ul class="fixes">' + ok.map(function (f) {
          return '<li class="ok"><span class="e" aria-hidden="true">✓</span><div><b>' + esc(f.label) + '</b><span>' + esc(f.good) + '</span></div><span class="lost">' + f.max + '/' + f.max + '</span></li>';
        }).join('') + '</ul></details>';
      }
    }
    return html;
  }

  /* ---------------- data ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function signedIn() { return state.me && state.me.signedIn; }
  function loadDemo() {
    if (state.demo) return Promise.resolve(state.demo);
    return api('GET', 'api/demo').then(function (d) { state.demo = d; return d; });
  }
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
    var b = me.budget || {};
    var st = me.streak || {};
    el.innerHTML =
      (st.days ? '<span class="pill streak" title="Days in a row you raised a score">✨ ' + st.days + '</span>' : '') +
      '<span class="pill credit" title="AI credit">' + (b.unlimited ? '∞' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span>' +
      '<button class="avatar-btn" id="acctBtn" aria-label="Account">' + esc(initials(me.email)) + '</button>';
    $('#acctBtn').onclick = function () { openAccount(); };
  }

  /* ---------------- sheets ---------------- */

  function sheet(html, onMount) {
    closeSheet();
    var scrim = document.createElement('div');
    scrim.className = 'scrim'; scrim.id = 'scrim';
    scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + html + '</div>';
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
    document.body.appendChild(scrim);
    if (onMount) onMount(scrim.firstChild);
    var f = scrim.querySelector('input:not([type=checkbox]), textarea');
    if (f) setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 50);
    return scrim.firstChild;
  }
  function closeSheet() { var s = $('#scrim'); if (s) s.remove(); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function openAccount(reason) {
    if (signedIn()) return openProfileSheet();
    var mode = 'register';
    function draw(root) {
      root.innerHTML = '<div class="grab"></div>' +
        '<h2>' + (mode === 'register' ? 'Give your listings a glow-up.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Free account with $2 of AI credit — a glow-up costs about a cent, so that is a lot of them. Scoring, editing, versions and share cards are free forever. One account works across every app on this site.'
          : 'Same account as the other apps on this site.')) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button>' +
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
      var d = recall(DRAFT_KEY);
      if (d && (d.title || d.description) && !/^#\/add/.test(location.hash)) {
        location.hash = '#/add';
        toast('Your listing is still here - save it now.', 3200);
      } else {
        toast('You’re in.');
        route();
      }
    });
  }

  function openProfileSheet() {
    var me = state.me;
    var b = me.budget || {};
    var remaining = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    var pct = b.unlimited ? 100 : Math.max(0, Math.min(100, (b.remainingUsd / (b.allowanceUsd || 1)) * 100));
    sheet(
      '<h2>Your account</h2>' +
      '<p class="muted small">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'Member model (Sonnet)' : 'Free model (Haiku)') + '</p>' +
      '<div class="card" style="margin:14px 0"><div class="row spread"><b>AI credit</b><span class="num">' + remaining + '</span></div>' +
      '<div class="bar-row" style="grid-template-columns:1fr;margin-top:10px"><div class="tr"><i class="a" style="width:' + pct + '%;height:12px;top:0"></i></div></div>' +
      '<p class="small muted" style="margin:10px 0 0">A glow-up or a comparison costs about a cent; reading a screenshot about a cent. The score, edits, versions and share cards are free.</p>' +
      '<div id="billing" style="margin-top:12px"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" style="margin-top:10px">Sign out</button>',
      function (root) {
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.glow = {}; drawTop(); location.hash = '#/'; route(); });
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
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button>' +
          '<p class="small muted" style="margin:8px 0 0">Membership covers every app on this site, runs the better model, and lets you add credit.</p>';
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
      '<p class="muted small">Everything else keeps working: the glow score and every fix, editing with live re-scoring, versions, going back, and share cards cost nothing.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- routing ---------------- */

  function route() {
    closeSheet();
    if (PUB) return renderShared(PUB[1]);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/').map(function (p) { return decodeURIComponent(p); });
    var tab = parts[0] || 'home';
    var owner = { l: 'home' };
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === (owner[tab] || tab)); });
    window.scrollTo(0, 0);
    if (tab === 'l' && parts[1]) return renderListing(parts[1], parts[2] || '');
    if (tab === 'sample' && parts[1]) return renderSample(parts[1], parts[2] || '');
    if (tab === 'sample') return renderSampleList();
    if (tab === 'add') return renderAdd();
    if (tab === 'wins') return renderWins();
    return signedIn() ? renderMine() : renderHome();
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () { location.hash = '#/' + (b.dataset.tab === 'home' ? '' : b.dataset.tab); };
  });
  // Until we know who is signed in, a hash change would route as signed out
  // (and bounce a listing link to the home page). The first route() runs
  // once /api/me answers, and draws whatever the hash is by then.
  var ready = false;
  window.addEventListener('hashchange', function () { if (ready || PUB) route(); });

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner" aria-label="Loading"></span></div>'; }
  function backLink(href, label) { return '<a class="back" href="' + href + '">' + ICON.back + esc(label) + '</a>'; }
  function sampleBar(what) {
    return '<div class="sample-bar"><span><b>SAMPLE</b> · ' + esc(what || 'Invented listings — real rules, no AI used.') + '</span>' +
      (signedIn() ? '<a class="btn small" href="#/add">Score yours</a>' : '<button class="btn small" data-signup>Sign up free</button>') + '</div>';
  }
  function wireSignup(root) { $$('[data-signup]', root).forEach(function (b) { b.onclick = function () { openAccount(); }; }); }

  function lcard(l, href) {
    return '<a class="lcard" href="' + href + '"><span class="badge-e" aria-hidden="true">' + esc(l.emoji) + '</span>' +
      '<span style="min-width:0"><span class="t" style="display:block">' + esc(l.title) + '</span>' +
      '<span class="m"><span>' + esc(l.typeLabel) + ' · ' + esc(l.platformLabel) + '</span>' + ((l.trail || []).length > 1 ? sparkSvg(l.trail, 64, 18) : '') +
      (l.firstScore != null && l.score !== l.firstScore ? deltaChip(l.firstScore, l.score) : '') + (l.shared ? '<span class="tag src">Shared</span>' : '') + '</span></span>' +
      '<span class="sc ' + gcls(l.score) + '"><b>' + l.score + '</b><span class="gtext">' + esc(l.grade.label) + '</span></span></a>';
  }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    loadDemo().then(function (d) {
      var loon = d.items['loons-nest'];
      var first = loon.trail[0], last = loon.trail[loon.trail.length - 1];
      view.innerHTML =
        '<section class="hero"><div class="hero-grid"><div>' +
        '<span class="kicker">✨ Free listing score · no sign-up</span>' +
        '<h1>Give your listing a <em>glow-up</em> — and watch the score climb.</h1>' +
        '<p>For Airbnb and Vrbo hosts, Etsy and eBay sellers, and local service pros. Paste your listing and get a 0–100 score with a fix for every point — then a rewrite that never makes things up.</p>' +
        '<div class="ctas"><a class="btn lg" href="#/add">Score my listing free</a><a class="btn lg ghost" href="#/sample/loons-nest">See a glow-up</a></div>' +
        '<div class="trust"><span>✓ Scoring is free, instant and private</span><span>✓ No invented amenities, ever</span><span>✓ Works for rentals, products, resale and services</span></div>' +
        '</div><div><div class="card score-card ' + gcls(last) + '" style="background:var(--card2)">' +
        '<div class="eyebrow">The Loon’s Nest · sample</div>' + gauge(last, { from: first }) + '<div class="scale"><span>0</span><span>100</span></div>' +
        '<div class="meta">' + deltaChip(first, last, 'in 3 versions') + '</div>' + rings(loon.result.cats) +
        '</div></div></div></section>' +
        '<div class="section-title"><h2>How it works</h2></div>' +
        '<div class="steps">' +
        '<div class="step"><div class="ic">📋</div><h3>Paste or snap it</h3><p>Title, description, tags, how many photos. Or a screenshot of the listing — read once, never kept.</p></div>' +
        '<div class="step"><div class="ic">🎯</div><h3>Get the score</h3><p>Five rings — Title, Hook, Details, Trust, Photos — and exactly what to fix, re-scored live as you type.</p></div>' +
        '<div class="step"><div class="ic">✨</div><h3>Glow it up</h3><p>Three titles to A/B, a scannable description, tags and a shot list. Missing facts come back as [add: …], not made up.</p></div>' +
        '</div>' +
        '<div class="section-title"><h2>Three sample glow-ups</h2><span class="count">scored for real</span></div>' +
        '<div class="list">' + d.listings.map(function (l) { return lcard(l, '#/sample/' + encodeURIComponent(l.id)); }).join('') + '</div>' +
        '<div class="cta-band"><h2>What would yours score?</h2><p>Paste it in. No account needed to see the score.</p><a class="btn lg" href="#/add">Score my listing</a></div>';
      animateGauges(view, 500);
      animateRings(view);
    }).catch(function (e) { showError(e, view); });
  }

  function renderSampleList() {
    loading();
    loadDemo().then(function (d) {
      view.innerHTML = sampleBar() +
        '<div class="page-head"><div><h1>Sample glow-ups</h1><div class="sub">Three invented listings, each with its versions, a rewrite and a share card.</div></div></div>' +
        '<div class="list">' + d.listings.map(function (l) { return lcard(l, '#/sample/' + encodeURIComponent(l.id)); }).join('') + '</div>';
      wireSignup(view);
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- my listings ---------------- */

  function renderMine() {
    loading();
    api('GET', 'api/listings').then(function (r) {
      var h = '<div class="page-head"><div><h1>Your listings</h1><div class="sub">' + (r.listings.length ? 'Tap one to see its fixes, glow it up, or compare.' : 'Paste one in to get its glow score.') + '</div></div>' +
        (r.listings.length ? '<a class="btn small" href="#/add">+ Score one</a>' : '') + '</div>';
      if (!r.listings.length) {
        h += '<div class="empty boxed"><div class="e">✨</div><h2>No listings yet</h2><p>Paste a title and description — or snap a screenshot — and see what it scores. It takes a minute.</p>' +
          '<div class="btn-row" style="justify-content:center"><a class="btn" href="#/add">Score my first listing</a><a class="btn ghost" href="#/sample">See the samples</a></div></div>';
      } else {
        var w = r.wins;
        h += '<div class="kpis" style="margin-bottom:14px"><div class="kpi"><b>' + w.average + '</b><span>Average score</span></div><div class="kpi"><b>+' + w.gained + '</b><span>Points gained</span></div>' +
          '<div class="kpi"><b>' + w.glowing + '</b><span>Glowing (90+)</span></div><div class="kpi"><b>' + w.streak.days + '</b><span>Day streak' + (w.streak.atRisk ? ' · save one today' : '') + '</span></div></div>';
        h += '<div class="list">' + r.listings.map(function (l) { return lcard(l, '#/l/' + encodeURIComponent(l.id)); }).join('') + '</div>';
      }
      view.innerHTML = h;
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- one listing ---------------- */

  function subnav(base, on, demo, hasCompare) {
    var items = [['', 'Score'], ['glow', 'Glow up'], ['edit', 'Edit'], ['compare', 'Compare'], ['versions', 'Versions']];
    if (demo) items = [['', 'Score'], ['glow', 'Glow-up'], ['versions', 'Versions'], ['card', 'Card']].concat(hasCompare ? [['compare', 'Compare']] : []);
    return '<div class="chips subnav" role="tablist" style="margin-bottom:14px">' + items.map(function (it) {
      return '<a class="chip' + (on === it[0] ? ' on' : '') + '" role="tab" aria-selected="' + (on === it[0]) + '" href="' + base + (it[0] ? '/' + it[0] : '') + '" style="text-decoration:none">' + esc(it[1]) + '</a>';
    }).join('') + '</div>';
  }

  function renderListing(id, sub) {
    if (!signedIn()) { location.hash = '#/'; return; }
    loading();
    api('GET', 'api/listings/' + encodeURIComponent(id)).then(function (l) {
      state.cur = l;
      var base = '#/l/' + encodeURIComponent(l.id);
      var head = backLink('#/', 'Your listings') + subnav(base, sub, false);
      if (sub === 'glow') return drawGlow(l, head, false);
      if (sub === 'edit') return drawEdit(l, head);
      if (sub === 'compare') return drawCompare(l, head, false);
      if (sub === 'versions') return drawVersions(l, head, false);
      drawScore(l, head, false);
    }).catch(function (e) {
      if (e.status === 404) view.innerHTML = '<div class="empty"><div class="e">🔍</div><h2>Not found</h2><p>' + esc(e.message) + '</p><a class="btn" href="#/">Your listings</a></div>';
      else showError(e, view);
    });
  }

  function renderSample(id, sub) {
    loading();
    loadDemo().then(function (d) {
      var l = d.items[id];
      if (!l) { location.hash = '#/sample'; return; }
      var base = '#/sample/' + encodeURIComponent(id);
      var head = sampleBar() + backLink('#/sample', 'Samples') + subnav(base, sub, true, Boolean(l.compare));
      if (sub === 'glow') drawGlow(l, head, true, d.glows[id]);
      else if (sub === 'compare') drawCompare(l, head, true);
      else if (sub === 'versions') drawVersions(l, head, true);
      else if (sub === 'card') drawCardPreview(l, head);
      else drawScore(l, head, true);
      wireSignup(view);
    }).catch(function (e) { showError(e, view); });
  }

  function typeLine(l) {
    var t = R.typeInfo(l.type), p = R.platformOf(l.type, l.platform);
    return '<span class="tag plat">' + t.emoji + ' ' + esc(t.short) + '</span><span class="tag plat">' + esc(p.label) + '</span>';
  }

  function drawScore(l, head, demo) {
    var res = l.result;
    var base = (demo ? '#/sample/' : '#/l/') + encodeURIComponent(l.id);
    var h = head + '<div class="dk-2"><div>';
    h += '<div class="card score-card ' + gcls(res.score) + '">' + gauge(res.score) + '<div class="scale"><span>0</span><span>100</span></div>' +
      '<div class="ttl">' + esc(l.title || '(no title yet)') + '</div><div class="meta">' + typeLine(l) +
      (l.firstScore != null && l.versions.length > 1 ? deltaChip(l.firstScore, res.score, 'since version 1') : '') + '</div>' + rings(res.cats) + '</div>';
    h += '<div class="section-title"><h2>' + (res.fixes.length ? 'Fix these next' : 'All done') + '</h2><span class="count">' + (res.fixes.length ? res.fixes.reduce(function (s, f) { return s + f.lost; }, 0) + ' points on the table' : '') + '</span></div>';
    h += fixesHtml(res, { good: true });
    h += '</div><div class="dk-sticky">';
    h += '<div class="card"><div class="card-head"><h3>Make it better</h3></div><div class="actions">' +
      '<a class="btn glow-btn wide" href="' + base + '/glow">' + ICON.spark + (demo ? 'See its glow-up' : 'Glow it up') + (demo ? '' : ' <span class="cost">· about 1¢</span>') + '</a>' +
      (demo ? '' : '<a class="btn ghost" href="' + base + '/edit">Edit it myself</a>') +
      (demo && !l.compare ? '' : '<a class="btn ghost" href="' + base + '/compare">Compare</a>') +
      (demo ? '<a class="btn ghost" href="' + base + '/card">The share card</a>' : '<button class="btn ghost" id="shareBtn">' + (l.share ? 'Share card · live' : 'Share the glow-up') + '</button>') +
      '<a class="btn ghost" href="' + base + '/versions">Versions (' + l.versions.length + ')</a></div>' +
      (demo ? '' : '<p class="small muted" style="margin:10px 0 0">The score and every fix are free. A glow-up rewrites it with AI and scores the result with the same rules.</p>') + '</div>';
    if (l.trail.length > 1) {
      h += '<div class="card"><div class="card-head"><h3>Score over time</h3><span class="sub">' + l.trail.length + ' versions' + (l.streak > 1 ? ' · ' + l.streak + ' better in a row' : '') + '</span></div>' + bigSpark(l.trail) + '</div>';
    }
    if (l.compare) {
      h += '<div class="card"><div class="card-head"><h3>Last comparison</h3><span class="sub">' + esc(fmtDay(l.compare.at)) + '</span></div>' +
        '<div class="row spread"><span>You <b class="' + gcls(l.compare.me.score) + ' gtext">' + l.compare.me.score + '</b></span><span class="faint">vs</span><span>' + esc(truncate(l.compare.them.title, 34)) + ' <b class="' + gcls(l.compare.them.score) + ' gtext">' + l.compare.them.score + '</b></span></div>' +
        (l.compare.verdict ? '<p class="small muted" style="margin:10px 0 0">' + esc(l.compare.verdict) + '</p>' : '') + '</div>';
    }
    h += '</div></div>';
    view.innerHTML = h;
    animateGauges(view);
    animateRings(view);
    var sb = $('#shareBtn'); if (sb) sb.onclick = function () { openShare(l); };
  }

  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function bigSpark(scores) {
    var w = 320, h = 90, pts = R.sparkline(scores, w, h, 12);
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' ');
    var area = d + ' L' + pts[pts.length - 1][0] + ' ' + h + ' L' + pts[0][0] + ' ' + h + ' Z';
    var dots = scores.length === 1 ? '' : scores.map(function (s, i) {
      var p = pts[i];
      return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3.5"/>' + (i === 0 || i === scores.length - 1 || scores.length <= 6 ? '<text x="' + p[0] + '" y="' + Math.max(10, p[1] - 8) + '" text-anchor="' + (i === 0 ? 'start' : i === scores.length - 1 ? 'end' : 'middle') + '">' + s + '</text>' : '');
    }).join('');
    return '<svg class="spark big-spark" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Score by version: ' + scores.join(', ') + '"><path class="a" d="' + area + '"/><path class="l" d="' + d + '"/>' + dots + '</svg>';
  }

  /* ---------------- the form: add and edit, scored live ---------------- */

  function emptyFields() { return { type: 'stay', platform: 'airbnb', title: '', description: '', tags: [], keywords: [], price: '', photoCount: 0, shots: [] }; }

  function formHtml(f) {
    var t = R.typeInfo(f.type), plats = R.platformsFor(f.type), p = R.platformOf(f.type, f.platform);
    return '<div class="group-title">What is it?</div>' +
      '<div class="type-pick" role="group" aria-label="Listing type">' + R.TYPES.map(function (x) {
        return '<button type="button" data-type="' + x.key + '" class="' + (x.key === f.type ? 'on' : '') + '" aria-pressed="' + (x.key === f.type) + '"><span class="e" aria-hidden="true">' + x.emoji + '</span><b>' + esc(x.label) + '</b><span>' + esc(x.who) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="group-title">Where it’s listed</div><div class="chips" role="group" aria-label="Platform">' + plats.map(function (x) {
        return '<button type="button" class="chip' + (x.key === p.key ? ' on' : '') + '" data-plat="' + x.key + '" aria-pressed="' + (x.key === p.key) + '">' + esc(x.label) + '</button>';
      }).join('') + '</div><p class="hint">' + esc(p.note) + '</p>' +
      '<div class="group-title"><span>Title</span><span class="count" id="tCount"></span></div><div class="group"><div class="cell stack"><label for="fTitle" class="sr-only">Title</label><input id="fTitle" maxlength="200" placeholder="' + (f.type === 'stay' ? 'Lake cabin with hot tub & wood stove' : f.type === 'product' ? 'Cedar candle with wood wick, 8 oz' : f.type === 'resale' ? 'Waxed canvas field jacket, men’s M' : 'Riverside Plumbing') + '" value="' + esc(f.title) + '"></div></div>' +
      '<div class="group-title"><span>Description</span><span class="count" id="dCount"></span></div><div class="group"><div class="cell stack"><label for="fDesc" class="sr-only">Description</label><textarea id="fDesc" maxlength="6000" rows="8" placeholder="Paste the description exactly as it is now.">' + esc(f.description) + '</textarea></div></div>' +
      '<div class="group-title">Search & details</div><div class="group">' +
      '<div class="cell stack"><label for="fKw">Search words buyers type <span class="faint">comma between</span></label><input id="fKw" maxlength="300" placeholder="' + (f.type === 'stay' ? 'lake cabin, hot tub, dog friendly' : f.type === 'product' ? 'cedar candle, wood wick candle' : f.type === 'resale' ? 'waxed canvas jacket, field jacket' : 'emergency plumber, water heater repair') + '" value="' + esc((f.keywords || []).join(', ')) + '"></div>' +
      '<div class="cell stack"><label for="fTags">' + esc(t.tagsLabel) + ' <span class="faint" id="tagCount"></span></label><textarea id="fTags" rows="3" maxlength="2000" placeholder="' + esc(t.tagsHint) + '">' + esc((f.tags || []).join('\n')) + '</textarea></div>' +
      '<div class="cell"><label for="fPrice">Price</label><input id="fPrice" maxlength="40" placeholder="' + (f.type === 'stay' ? '$189 / night' : f.type === 'service' ? 'Free quotes' : '$24') + '" value="' + esc(f.price) + '"></div>' +
      '<div class="cell"><span class="lbl" id="phLbl">Photos</span><span class="grow"></span><div class="stepper" role="group" aria-labelledby="phLbl"><button type="button" id="phMinus" aria-label="One fewer photo">−</button><input id="fPhotos" inputmode="numeric" aria-label="Number of photos" value="' + (f.photoCount || 0) + '"><button type="button" id="phPlus" aria-label="One more photo">+</button></div></div>' +
      '</div><p class="hint">Aim for ' + t.photosRec + ' photos for a ' + esc(t.short.toLowerCase()) + '.</p>' +
      '<div class="group-title">Which of these shots do you have?</div><div class="group shot-list">' + R.SHOTS[f.type].map(function (s) {
        return '<label><input type="checkbox" data-shot="' + s.key + '"' + ((f.shots || []).indexOf(s.key) >= 0 ? ' checked' : '') + '><span>' + esc(s.label) + '</span></label>';
      }).join('') + '</div>';
  }

  function scorePanel(res) {
    return '<div class="card score-card ' + gcls(res.score) + '" id="sideCard">' + gauge(res.score, { size: 'small' }) + rings(res.cats, { still: true }) + '</div>' +
      '<div class="section-title"><h2>Top fixes</h2><span class="count" id="sideLost"></span></div><div id="sideFixes">' + fixesHtml(res, { limit: 5 }) + '</div>';
  }
  function liveStrip(res) {
    return '<div class="live ' + gcls(res.score) + '" id="live" aria-live="polite"><b class="n gtext" id="liveN">' + res.score + '</b><div class="grow"><div class="mini-rings" id="liveRings"></div><div class="fix1" id="liveFix"></div></div></div>';
  }

  /**
   * Wire a form so every keystroke re-scores it with the same rules the
   * server uses. `f` is mutated in place; `onType` redraws the whole form
   * (type changes swap the checklist and shot list).
   */
  function wireForm(root, f, onChange, onType) {
    function paint() {
      var res = R.score(f);
      var plat = R.platformOf(f.type, f.platform);
      var tc = $('#tCount', root);
      if (tc) { tc.textContent = (f.title || '').length + ' / ' + plat.titleMax; tc.classList.toggle('over', (f.title || '').length > plat.titleMax); }
      var dc = $('#dCount', root);
      if (dc) { dc.textContent = (f.description || '').length + (plat.descMax ? ' / ' + plat.descMax : ''); dc.classList.toggle('over', Boolean(plat.descMax && (f.description || '').length > plat.descMax)); }
      var tg = $('#tagCount', root);
      if (tg) tg.textContent = plat.tagsMax ? (f.tags || []).length + ' of ' + plat.tagsMax : '';
      var live = $('#live', root);
      if (live) {
        live.className = 'live ' + gcls(res.score);
        $('#liveN', root).textContent = res.score;
        $('#liveRings', root).innerHTML = R.CATS.map(function (c) { var v = catVal(res.cats, c.key); var pc = v / 20 * 100; return '<i class="' + (pc >= 90 ? 'g-great' : pc >= 60 ? 'g-good' : pc >= 40 ? 'g-okay' : 'g-dim') + '" title="' + esc(c.label) + ' ' + v + '/20"><s style="width:' + pc + '%"></s></i>'; }).join('');
        $('#liveFix', root).textContent = res.fixes.length ? 'Next: ' + res.fixes[0].fix : 'Nothing left to fix ✨';
      }
      var side = $('#sideCard', root);
      if (side) {
        var g = $('.gauge', side);
        setGauge(g, Number(g.dataset.score), res.score, 0);
        side.className = 'card score-card ' + gcls(res.score);
        $$('.ring', side).forEach(function (r, i) {
          var v = catVal(res.cats, R.CATS[i].key), pc = Math.round(v / 20 * 100);
          r.className = 'ring ' + (pc >= 90 ? 'g-great' : pc >= 60 ? 'g-good' : pc >= 40 ? 'g-okay' : 'g-dim');
          $('.val', r).style.strokeDashoffset = 100 - pc;
          $('.pts', r).innerHTML = v + '<small>/20</small>';
        });
        $('#sideFixes', root).innerHTML = fixesHtml(res, { limit: 5 });
        $('#sideLost', root).textContent = res.fixes.length ? res.fixes.reduce(function (s, x) { return s + x.lost; }, 0) + ' points to win' : '';
      }
      if (onChange) onChange(res);
    }
    var timer = null;
    function later() { clearTimeout(timer); timer = setTimeout(paint, 90); }
    $$('[data-type]', root).forEach(function (b) {
      b.onclick = function () {
        if (f.type === b.dataset.type) return;
        f.type = b.dataset.type; f.platform = R.platformsFor(f.type)[0].key; f.shots = [];
        onType();
      };
    });
    $$('[data-plat]', root).forEach(function (b) {
      b.onclick = function () {
        f.platform = b.dataset.plat;
        $$('[data-plat]', root).forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
        var hint = b.parentNode.nextElementSibling; if (hint) hint.textContent = R.platformInfo(f.platform).note;
        paint();
      };
    });
    var bind = function (sel, fn) { var el = $(sel, root); if (el) el.addEventListener('input', function () { fn(el.value); later(); }); };
    bind('#fTitle', function (v) { f.title = v; });
    bind('#fDesc', function (v) { f.description = v; });
    bind('#fKw', function (v) { f.keywords = v.split(',').map(function (s) { return s.trim(); }).filter(Boolean); });
    bind('#fTags', function (v) { f.tags = R.list(v); });
    bind('#fPrice', function (v) { f.price = v; });
    bind('#fPhotos', function (v) { f.photoCount = Math.max(0, Math.min(100, parseInt(v, 10) || 0)); });
    var ph = $('#fPhotos', root);
    var stepBy = function (n) { f.photoCount = Math.max(0, Math.min(100, (f.photoCount || 0) + n)); ph.value = f.photoCount; paint(); };
    if (ph) { $('#phMinus', root).onclick = function () { stepBy(-1); }; $('#phPlus', root).onclick = function () { stepBy(1); }; }
    $$('[data-shot]', root).forEach(function (c) {
      c.onchange = function () {
        f.shots = $$('[data-shot]', root).filter(function (x) { return x.checked; }).map(function (x) { return x.dataset.shot; });
        paint();
      };
    });
    var ta = $('#fDesc', root); if (ta) { grow(ta); ta.addEventListener('input', function () { grow(ta); }); }
    paint();
  }

  function renderAdd() {
    var f = state.snapped ? Object.assign(emptyFields(), state.snapped) : (recall(DRAFT_KEY) || emptyFields());
    var fromSnap = Boolean(state.snapped);
    function draw() {
      var res = R.score(f);
      view.innerHTML =
        '<div class="page-head"><div><h1>Score a listing</h1><div class="sub">Paste it as it is now. The score updates as you type' + (signedIn() ? '.' : ' — free, no account needed.') + '</div></div></div>' +
        '<div class="dk-2"><div>' + liveStrip(res) +
        '<label class="card snap-card" id="snapCard"><span class="ic" aria-hidden="true">📸</span><span class="grow"><b>Snap a screenshot instead</b><span>Of the listing page — Glowup reads the title and description. About a cent of AI credit; the image is never stored.</span></span>' +
        '<input type="file" id="snapIn" accept="image/*"></label><div id="snapState">' + (fromSnap ? '<div class="banner" style="margin-top:12px"><span class="e">✨</span><span>Read from your screenshot. Check it, tick the shots you have, then save. The image wasn’t kept.</span></div>' : '') + '</div>' +
        '<div class="or">or paste it in</div>' +
        formHtml(f) +
        '<div id="aErr"></div><button class="btn block lg" id="aSave" style="margin-top:18px">' + (signedIn() ? 'Save & see every fix' : 'Sign up free to save it') + '</button>' +
        (signedIn() ? '' : '<p class="hint center">Saving keeps its versions, unlocks the glow-up and the share card. Your text stays on this device until then.</p>') +
        '</div><div class="dk-sticky side-score">' + scorePanel(res) + '</div></div>';
      animateGauges(view);
      animateRings(view);
      wireForm(view, f, function () { store(DRAFT_KEY, f); }, function () { store(DRAFT_KEY, f); draw(); });
      $('#snapIn').onchange = function (e) { var file = e.target.files && e.target.files[0]; e.target.value = ''; if (file) snap(file); };
      $('#aSave').onclick = function () {
        store(DRAFT_KEY, f);
        if (!signedIn()) return openAccount('Sign up free to save this listing, keep its versions and glow it up. Your text is kept on this device.');
        var btn = this; btn.disabled = true;
        api('POST', 'api/listings', Object.assign({}, f, { source: fromSnap ? 'snap' : 'paste' })).then(function (l) {
          store(DRAFT_KEY, null); state.snapped = null;
          toast('Saved. It scores ' + l.result.score + ' — here’s what to fix.', 3200);
          location.hash = '#/l/' + encodeURIComponent(l.id);
        }).catch(function (e) { btn.disabled = false; showError(e, $('#aErr')); });
      };
    }
    draw();
  }

  /** Shrink on the phone: 1600px on the long side, JPEG, under ~3.5 MB. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        var q = 0.88, d = c.toDataURL('image/jpeg', q);
        while (d.length * 0.75 > 3.5e6 && q > 0.4) { q -= 0.15; d = c.toDataURL('image/jpeg', q); }
        c.width = c.height = 0;
        resolve({ type: 'image/jpeg', data: d.split(',')[1] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That image could not be opened. Try a PNG or JPEG screenshot.')); };
      img.src = url;
    });
  }

  function snap(file) {
    if (!signedIn()) return openAccount('Sign up free to read a screenshot - it uses a cent of AI credit. Pasting is free without an account.');
    var box = $('#snapState');
    box.innerHTML = '<div class="card writing" style="margin-top:12px"><span class="spinner"></span>Reading your screenshot…</div>';
    shrink(file).then(function (image) {
      return api('POST', 'api/listings/read', { image: image });
    }).then(function (p) {
      var keep = recall(DRAFT_KEY) || {};
      state.snapped = { type: p.type, platform: p.platform, title: p.title, description: p.description, tags: p.tags, price: p.price, photoCount: p.photoCount == null ? (keep.photoCount || 0) : p.photoCount, keywords: keep.keywords || [], shots: [] };
      loadMe();
      renderAdd();
    }).catch(function (e) {
      if (e.status === 402) { box.innerHTML = ''; return openCreditSheet(e.data); }
      box.innerHTML = '<div class="banner warn" style="margin-top:12px"><span class="e">🤔</span><span>' + esc(e.message) + '</span></div>';
    });
  }

  function drawEdit(l, head) {
    var f = {};
    ['type', 'platform', 'title', 'description', 'tags', 'keywords', 'price', 'photoCount', 'shots'].forEach(function (k) { f[k] = Array.isArray(l[k]) ? l[k].slice() : l[k]; });
    var before = l.result.score;
    function draw() {
      var res = R.score(f);
      view.innerHTML = head + '<div class="dk-2"><div>' + liveStrip(res) + formHtml(f) +
        '<div id="eErr"></div><div class="btn-row" style="margin-top:18px"><button class="btn lg" id="eSave">Save as version ' + (l.versions[0].n + 1) + '</button><a class="btn lg ghost" href="#/l/' + encodeURIComponent(l.id) + '">Cancel</a></div>' +
        '<p class="hint">Every save is a version. You can always go back.</p>' +
        '</div><div class="dk-sticky side-score"><div class="banner" style="margin-bottom:12px"><span class="e">🎯</span><span>Saved score: <b>' + before + '</b>. Watch it move as you type.</span></div>' + scorePanel(res) + '</div></div>';
      animateGauges(view);
      animateRings(view);
      wireForm(view, f, null, draw);
      $('#eSave').onclick = function () {
        var btn = this; btn.disabled = true;
        api('PUT', 'api/listings/' + encodeURIComponent(l.id), f).then(function (r) {
          celebrate(r, before);
          location.hash = '#/l/' + encodeURIComponent(l.id);
        }).catch(function (e) { btn.disabled = false; showError(e, $('#eErr')); });
      };
    }
    draw();
  }

  function celebrate(r, before) {
    if (r.unchanged) return toast('Nothing changed - no new version.');
    var d = r.result.score - before;
    if (d > 0) { toast('+' + d + ' — now ' + r.result.score + '. ' + (r.newBest ? 'A new best! ' : '') + '✨', 3400); confetti(); }
    else if (d < 0) toast('Saved. That cost ' + (-d) + ' point' + (d === -1 ? '' : 's') + ' - Versions can take you back.', 3400);
    else toast('Saved as a new version.');
    loadMe();
  }

  /* ---------------- glow it up ---------------- */

  function drawGlow(l, head, demo, pre) {
    var g = pre || state.glow[l.id];
    if (!g) {
      view.innerHTML = head + '<div class="card" style="text-align:center;padding:26px 18px"><div style="font-size:44px">✨</div><h2 style="margin:8px 0">Glow it up</h2>' +
        '<p class="muted" style="max-width:46ch;margin:0 auto 16px">Three titles to test, a rewritten description, tags and a shot list for your photos — scored by the same rules, so you see the real before and after. Anything a buyer would want that your listing doesn’t say comes back as <b>[add: …]</b> for you to fill in, never made up.</p>' +
        '<button class="btn lg glow-btn" id="goGlow">' + ICON.spark + 'Glow it up <span class="cost">· about 1¢</span></button><div id="gErr"></div>' +
        '<p class="hint">Nothing changes until you apply it.</p></div>';
      $('#goGlow').onclick = function () {
        view.innerHTML = head + '<div class="card polish" aria-live="polite"><div class="sparkles" aria-hidden="true">✨</div><b>Polishing your listing…</b><span class="muted small">Rewriting, then scoring it with the same rules.</span></div>';
        api('POST', 'api/listings/' + encodeURIComponent(l.id) + '/glowup').then(function (r) {
          state.glow[l.id] = r;
          loadMe();
          drawGlow(l, head, false);
        }).catch(function (e) {
          drawGlow(l, head, false);
          showError(e, $('#gErr'));
        });
      };
      return;
    }
    var pick = 0;
    var fields = { title: g.titles.length ? g.titles[0].text : l.title, description: g.fields.description, tags: g.fields.tags.slice() };
    // "Before" is what the glow-up was run on: the saved listing, or for the
    // sample its first version.
    var orig = demo ? (demoVersion(l.id, 1) || l) : l;
    function merged() { return Object.assign({}, { type: l.type, platform: l.platform, keywords: orig.keywords || l.keywords, price: orig.price || l.price, photoCount: orig.photoCount != null ? orig.photoCount : l.photoCount, shots: orig.shots || l.shots }, fields); }
    var after = R.score(merged());
    var plat = R.platformOf(l.type, l.platform);
    var h = head;
    h += '<div class="card"><div class="glow-top"><div><div class="ba"><div class="side"><div class="cap">Before</div>' + gauge(g.before.score, { size: 'small' }) + '</div><div class="arrow" aria-hidden="true">→</div>' +
      '<div class="side"><div class="cap">After</div>' + gauge(after.score, { size: 'small', from: g.before.score }) + '</div></div>' +
      '<div class="center" style="margin-top:6px" id="gDelta">' + deltaChip(g.before.score, after.score, 'points') + '</div></div>' +
      '<div><div class="bars" id="gBars"></div><div class="bar-legend"><span><i style="background:color-mix(in srgb,var(--faint) 70%,transparent)"></i>Before</span><span><i style="background:linear-gradient(90deg,var(--glow-a),var(--glow-b))"></i>After</span></div></div></div>' +
      (g.summary ? '<p class="small muted" style="margin:12px 0 0">' + esc(g.summary) + '</p>' : '') + '</div>';
    if (g.removed && g.removed.length) {
      h += '<div class="banner warn" style="margin-top:12px;align-items:flex-start"><span class="e">🛡️</span><div><b>We took out ' + g.removed.length + ' thing' + (g.removed.length === 1 ? '' : 's') + ' your listing doesn’t say.</b> A rewrite must never invent facts — fill in the real ones yourself.<ul class="removed">' +
        g.removed.slice(0, 6).map(function (r) { return '<li><b>' + esc(r.what) + '</b> · ' + esc(r.where) + (r.number ? ' - a number your listing doesn’t give' : ': “' + esc(r.text) + '”') + '</li>'; }).join('') + '</ul></div></div>';
    }
    h += '<div class="dk-2" style="margin-top:4px"><div>';
    h += '<div class="section-title"><h2>' + (plat.titleLocked ? 'Business name' : 'Pick a title') + '</h2><span class="count">' + (plat.titleLocked ? 'Google wants your real name' : 'max ' + plat.titleMax + ' characters') + '</span></div>';
    h += '<div class="opts" role="radiogroup" aria-label="Title options">' + g.titles.map(function (t, i) {
      return '<button class="opt' + (i === 0 ? ' on' : '') + '" role="radio" aria-checked="' + (i === 0) + '" data-opt="' + i + '"><span class="dot" aria-hidden="true"></span><span style="min-width:0"><span class="txt" style="display:block">' + esc(t.text) + '</span><span class="sub">' + esc(t.angle) + ' · ' + t.text.length + '/' + plat.titleMax + (t.trimmed ? ' · trimmed to fit' : '') + '</span></span><span class="sc ' + gcls(t.score) + '"><span class="gtext">' + t.score + '</span></span></button>';
    }).join('') + '</div>';
    if (!demo) h += '<p class="hint">Test one for a week, then try another — the score tells you which reads better; your bookings tell you which sells.</p>';
    h += '<div class="section-title"><h2>New description</h2><span class="count" id="gdCount"></span></div>';
    h += demo ? '<div class="card pre">' + esc(fields.description) + '</div>'
      : '<textarea class="input" id="gDesc" rows="10" aria-label="New description">' + esc(fields.description) + '</textarea>';
    if (g.gaps && g.gaps.length) h += '<div class="group-title" style="margin-left:4px">Fill these in <span class="count">' + g.gaps.length + '</span></div><div class="gaps">' + g.gaps.map(function (x) { return '<span class="tag">[add: ' + esc(x) + ']</span>'; }).join('') + '</div>' + (demo ? '' : '<p class="hint" style="margin-left:4px">Replace each [add: …] in the text with the real fact, or delete the line. The score climbs as you do.</p>');
    h += '<div class="section-title"><h2>' + esc(R.typeInfo(l.type).tagsLabel) + '</h2><span class="count">' + fields.tags.length + (plat.tagsMax ? ' of ' + plat.tagsMax : '') + '</span></div><div class="tags">' + fields.tags.map(function (t) { return '<span class="tag plat">' + esc(t) + '</span>'; }).join('') + '</div>';
    h += '<details class="more"><summary>Your original</summary><div class="orig"><b>' + esc(orig.title) + '</b>\n\n' + esc(orig.description) + '</div></details>';
    h += '</div><div class="dk-sticky">';
    if (g.shots && g.shots.length) h += '<div class="section-title" style="margin-top:4px"><h2>Your shot list</h2><span class="count">photos to take next</span></div><ol class="shots">' + g.shots.map(function (s, i) { return '<li><span class="n">' + (i + 1) + '</span><div><b>' + esc(s.shot) + '</b><span>' + esc(s.why) + '</span></div></li>'; }).join('') + '</ol>';
    h += '<div class="section-title"><h2>What’s left</h2><span class="count" id="gLeftN"></span></div><div id="gLeft"></div>';
    h += demo ? '<div class="banner" style="margin-top:14px"><span class="e">👀</span><span>The host applied this, then filled in the gaps: <b>' + l.trail[1] + ' → ' + l.trail[2] + '</b>. See Versions.</span></div>'
      : '<div id="applyErr"></div><div class="btn-row" style="margin-top:14px"><button class="btn lg" id="applyBtn">Use this as version ' + (l.versions[0].n + 1) + '</button><button class="btn lg ghost" id="againBtn">Try again · 1¢</button></div><p class="hint">Applying saves a new version. Your original stays in Versions.</p>';
    h += '</div></div>';
    view.innerHTML = h;
    animateGauges(view, 250);

    function bars(res) {
      $('#gBars').innerHTML = R.CATS.map(function (c) {
        var b = catVal(g.before.cats, c.key), a = catVal(res.cats, c.key);
        return '<div class="bar-row"><span class="lab">' + c.emoji + ' ' + esc(c.label) + '</span><span class="tr"><i class="b" style="width:' + (b / 20 * 100) + '%"></i><i class="a" style="width:' + (a / 20 * 100) + '%"></i></span><span class="v">' + b + ' → <b>' + a + '</b></span></div>';
      }).join('');
    }
    function repaint(animate) {
      var res = R.score(merged());
      var gEl = $$('.ba .gauge', view)[1];
      if (!animate) setGauge(gEl, Number(gEl.dataset.score), res.score, 0);
      $('#gDelta').innerHTML = deltaChip(g.before.score, res.score, 'points');
      bars(res);
      $('#gLeft').innerHTML = fixesHtml(res, { limit: 4 });
      $('#gLeftN').textContent = res.fixes.length ? res.fixes.reduce(function (s, x) { return s + x.lost; }, 0) + ' points' : '';
      var dc = $('#gdCount'); if (dc) dc.textContent = fields.description.length + (plat.descMax ? ' / ' + plat.descMax : '') + ' characters';
    }
    repaint(true);
    $$('[data-opt]').forEach(function (b) {
      b.onclick = function () {
        pick = Number(b.dataset.opt);
        fields.title = g.titles[pick].text;
        $$('[data-opt]').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
        repaint();
      };
    });
    var ta = $('#gDesc');
    if (ta) { grow(ta); ta.addEventListener('input', function () { fields.description = ta.value; grow(ta); repaint(); }); }
    var ap = $('#applyBtn');
    if (ap) ap.onclick = function () {
      ap.disabled = true;
      var before = l.result.score;
      api('PUT', 'api/listings/' + encodeURIComponent(l.id), { title: fields.title, description: fields.description, tags: fields.tags, source: 'glowup' }).then(function (r) {
        delete state.glow[l.id];
        celebrate(r, before);
        location.hash = '#/l/' + encodeURIComponent(l.id);
      }).catch(function (e) { ap.disabled = false; showError(e, $('#applyErr')); });
    };
    var again = $('#againBtn');
    if (again) again.onclick = function () { delete state.glow[l.id]; drawGlow(l, head, false); $('#goGlow').click(); };
  }

  /* ---------------- compare ---------------- */

  function vsBlock(c) {
    return '<div class="card"><div class="vs"><div><div class="cap center eyebrow">You</div>' + gauge(c.me.score, { size: 'small' }) + '</div><div class="mid">vs</div>' +
      '<div><div class="cap center eyebrow">Them</div>' + gauge(c.them.score, { size: 'small' }) + '<div class="who">' + esc(c.them.title) + '</div></div></div>' +
      '<div class="bars">' + R.CATS.map(function (k) {
        var a = catVal(c.me.cats, k.key), b = catVal(c.them.cats, k.key);
        return '<div class="bar-row"><span class="lab">' + k.emoji + ' ' + esc(k.label) + '</span><span class="tr"><i class="b" style="width:' + (b / 20 * 100) + '%"></i><i class="a" style="width:' + (a / 20 * 100) + '%"></i></span><span class="v"><b>' + a + '</b> vs ' + b + '</span></div>';
      }).join('') + '</div><div class="bar-legend"><span><i style="background:linear-gradient(90deg,var(--glow-a),var(--glow-b))"></i>You</span><span><i style="background:color-mix(in srgb,var(--faint) 70%,transparent)"></i>Them</span></div>' +
      '<p class="small muted" style="margin:10px 0 0">Both scored by the same rules. We can’t see their photos, only how many (' + c.them.photos + '), so their Photos ring is an estimate.</p></div>';
  }
  function compareResultHtml(c) {
    return vsBlock(c) +
      '<div style="margin-top:4px"><div><div class="section-title"><h2>They do better</h2></div><ul class="pts-list them">' + c.theyDoBetter.map(function (x) { return '<li>' + esc(x.point) + (x.move ? '<span>→ ' + esc(x.move) + '</span>' : '') + '</li>'; }).join('') + '</ul></div>' +
      '<div><div class="section-title"><h2>You do better</h2></div><ul class="pts-list you">' + c.youDoBetter.map(function (x) { return '<li>' + esc(x.point) + '</li>'; }).join('') + '</ul></div></div>' +
      (c.verdict ? '<div class="banner" style="margin-top:14px"><span class="e">🎯</span><span><b>The one change:</b> ' + esc(c.verdict) + '</span></div>' : '');
  }

  function drawCompare(l, head, demo) {
    var h = head;
    if (demo) {
      h += l.compare ? compareResultHtml(l.compare) : '<div class="empty boxed"><p>No comparison on this sample.</p></div>';
      view.innerHTML = h; animateGauges(view); return;
    }
    h += '<div class="dk-2"><div><div class="card"><div class="card-head"><h3>Paste a competitor</h3><span class="sub">one that ranks above you</span></div>' +
      '<label class="field"><span>Their title</span><input class="input" id="cTitle" maxlength="200"></label>' +
      '<label class="field"><span>Their description</span><textarea class="input" id="cDesc" rows="7" maxlength="6000"></textarea></label>' +
      '<div class="row"><label class="field grow"><span>Their photo count</span><input class="input" id="cPhotos" inputmode="numeric" placeholder="e.g. 24"></label><label class="field grow"><span>Their price</span><input class="input" id="cPrice" maxlength="40"></label></div>' +
      '<div id="cErr"></div><button class="btn block glow-btn" id="cGo">Compare · about 1¢</button>' +
      '<p class="hint" style="margin-left:0">We keep their title and scores with your listing, never their full text. Nothing of theirs is copied into yours.</p></div></div>' +
      '<div id="cOut">' + (l.compare ? '<div class="section-title" style="margin-top:4px"><h2>Last comparison</h2><span class="count">' + esc(fmtDay(l.compare.at)) + '</span></div>' + compareResultHtml(l.compare) : '<div class="empty boxed"><div class="e">🥊</div><h2>See how you stack up</h2><p>Both listings get the same glow score, side by side, plus what they do better and what you already win on.</p></div>') + '</div></div>';
    view.innerHTML = h;
    animateGauges(view);
    $('#cGo').onclick = function () {
      var btn = this; btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Comparing…';
      api('POST', 'api/listings/' + encodeURIComponent(l.id) + '/compare', { title: $('#cTitle').value, description: $('#cDesc').value, photoCount: $('#cPhotos').value, price: $('#cPrice').value })
        .then(function (c) {
          btn.disabled = false; btn.textContent = 'Compare again · about 1¢';
          $('#cOut').innerHTML = compareResultHtml(c);
          animateGauges($('#cOut'));
          loadMe();
          if (window.innerWidth < 1100) $('#cOut').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
        })
        .catch(function (e) { btn.disabled = false; btn.textContent = 'Compare · about 1¢'; showError(e, $('#cErr')); });
    };
  }

  /* ---------------- versions ---------------- */

  function drawVersions(l, head, demo) {
    var rows = l.versions;
    var h = head + '<div class="card"><div class="card-head"><h3>Score over time</h3><span class="sub">' + (l.streak > 0 ? l.streak + ' better save' + (l.streak === 1 ? '' : 's') + ' in a row' : 'every save is kept') + '</span></div>' + bigSpark(l.trail) + '</div>';
    h += '<div class="section-title"><h2>Versions</h2><span class="count">' + rows.length + ' kept</span></div><div class="group">' + rows.map(function (v, i) {
      var prev = rows[i + 1];
      var d = prev ? v.score - prev.score : null;
      return '<button class="vrow' + (i === 0 ? ' current' : '') + '" data-v="' + esc(v.id) + '"><span class="n">v' + v.n + '</span><span style="min-width:0"><span class="t" style="display:block">' + esc(v.title || '(no title)') + '</span><span class="m">' + esc(SOURCE[v.source] || v.source) + ' · ' + esc(fmtDay(v.at)) + (i === 0 ? ' · current' : '') + '</span></span>' +
        '<span class="s ' + gcls(v.score) + '">' + v.score + (d != null ? '<small class="' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '" style="color:' + (d > 0 ? 'var(--good)' : d < 0 ? 'var(--bad)' : 'var(--faint)') + '">' + (d > 0 ? '+' : '') + d + '</small>' : '<small class="faint">first</small>') + '</span></button>';
    }).join('') + '</div><p class="hint">Going back saves the old text as a new version — nothing is ever lost.</p>';
    view.innerHTML = h;
    $$('[data-v]').forEach(function (b) {
      b.onclick = function () { openVersion(l, b.dataset.v, demo); };
    });
  }

  function openVersion(l, vid, demo) {
    var show = function (v) {
      var cur = l.versions[0].id === v.id;
      sheet('<h2>Version ' + v.n + ' · ' + esc(SOURCE[v.source] || v.source) + '</h2><p class="muted small">' + esc(fmtDay(v.at)) + '</p>' +
        '<div class="card score-card ' + gcls(v.result.score) + '">' + gauge(v.result.score, { size: 'small' }) + rings(v.result.cats, { still: true }) + '</div>' +
        '<div class="orig"><b>' + esc(v.fields.title) + '</b>\n\n' + esc(v.fields.description) + '</div>' +
        (demo || cur ? '' : '<div id="rvErr"></div><button class="btn block" id="revertBtn" style="margin-top:14px">Go back to this version</button>'),
        function (root) {
          animateGauges(root);
          var rb = $('#revertBtn', root);
          if (rb) rb.onclick = function () {
            rb.disabled = true;
            api('POST', 'api/listings/' + encodeURIComponent(l.id) + '/revert', { versionId: v.id }).then(function (r) {
              closeSheet();
              toast(r.unchanged ? 'That is already the current text.' : 'Back to version ' + v.n + ' - saved as version ' + r.versions[0].n + '.', 3200);
              route();
            }).catch(function (e) { rb.disabled = false; showError(e, $('#rvErr', root)); });
          };
        });
    };
    if (demo) {
      // The sample carries each version's text in `history`, oldest first.
      var v = l.versions.filter(function (x) { return x.id === vid; })[0];
      var full = demoVersion(l.id, v.n);
      return show(Object.assign({}, v, { fields: full, result: R.score(full) }));
    }
    api('GET', 'api/listings/' + encodeURIComponent(l.id) + '/versions/' + encodeURIComponent(vid)).then(show).catch(function (e) { showError(e); });
  }
  function demoVersion(id, n) {
    var d = state.demo && state.demo.items[id];
    return d && d.history ? d.history[n - 1] : null;
  }

  /* ---------------- the share card ---------------- */

  function cardHtml(c, opts) {
    opts = opts || {};
    return '<div class="gcard ' + gcls(c.after.score) + '"><div class="kind">' + esc(c.emoji) + ' ' + esc(c.typeLabel) + ' · ' + esc(c.platformLabel) + '</div>' +
      '<h1>' + esc(c.title) + '</h1>' +
      '<div class="big"><span class="n b num" aria-label="Before">' + c.before.score + '</span><span class="arrow" aria-hidden="true">→</span><span class="n num gtext" aria-label="After">' + c.after.score + '</span></div>' +
      '<div class="gl"><span class="gtext">' + esc(c.after.grade.emoji + ' ' + c.after.grade.label) + '</span> · ' + deltaChip(c.before.score, c.after.score, 'points in ' + c.saves + ' version' + (c.saves === 1 ? '' : 's')) + '</div>' +
      rings(c.after.cats, { still: opts.still }) +
      (c.trail && c.trail.length > 1 ? '<div style="margin-top:14px">' + bigSpark(c.trail) + '</div>' : '') +
      (c.text ? '<div class="text">' + esc(c.text.description) + (c.text.tags && c.text.tags.length ? '<div class="tags" style="margin-top:10px">' + c.text.tags.map(function (t) { return '<span class="tag plat">' + esc(t) + '</span>'; }).join('') + '</div>' : '') + '</div>' : '') +
      '</div>';
  }

  function drawCardPreview(l, head) {
    view.innerHTML = head + '<p class="muted small center" style="margin:0 0 12px">A share link shows this card — the scores, the rings and the new title. Never the full text unless you tick it.</p>' + cardHtml(l.card);
    animateRings(view);
  }

  function openShare(l) {
    function draw(root, s) {
      var url = s ? location.origin + BASE + s.url : '';
      root.innerHTML = '<div class="grab"></div><h2>Share the glow-up</h2><p class="muted small">A public, read-only card: before and after scores, the rings and your new title. Frozen when you publish; update it any time.</p>' +
        '<label class="check" style="margin:12px 0"><input type="checkbox" id="shText"' + (s && s.includeText ? ' checked' : '') + '><span>Also show the full new description and tags</span></label>' +
        (s ? '<div class="share-box"><input class="input" id="shUrl" readonly value="' + esc(url) + '" aria-label="Share link"><button class="btn small" id="shCopy">Copy</button></div>' +
          '<div class="more-actions"><button class="btn small ghost" id="shPub">Update the card</button><a class="btn small ghost" href="' + esc(BASE + s.url) + '" target="_blank" rel="noopener">Open</a><button class="btn small danger" id="shRevoke">Revoke</button></div>'
          : '<button class="btn block" id="shPub">Publish the card</button>') +
        '<div id="shErr"></div><p class="small muted" style="margin:12px 0 0">Anyone with the link can see it. Revoke it and the link is dead for good.</p>';
      $('#shPub', root).onclick = function () {
        this.disabled = true;
        api('POST', 'api/listings/' + encodeURIComponent(l.id) + '/share', { includeText: $('#shText', root).checked }).then(function (r) {
          l.share = { token: r.token, url: r.url, sharedAt: r.sharedAt, includeText: r.includeText };
          toast(s ? 'Updated - the link shows the new card.' : 'Published. Copy the link.');
          draw(root, l.share);
        }).catch(function (e) { showError(e, $('#shErr', root)); });
      };
      var cp = $('#shCopy', root); if (cp) cp.onclick = function () { var i = $('#shUrl', root); i.select(); copy(i.value, 'Link copied'); };
      var rv = $('#shRevoke', root); if (rv) rv.onclick = function () {
        if (!confirm('Revoke this link? Anyone who has it will see “not valid”, and it never comes back.')) return;
        api('DELETE', 'api/listings/' + encodeURIComponent(l.id) + '/share').then(function () { l.share = null; toast('Revoked.'); draw(root, null); }).catch(function (e) { showError(e, $('#shErr', root)); });
      };
    }
    sheet('', function (root) { draw(root, l.share); });
  }

  function renderShared(token) {
    document.body.classList.add('public');
    document.body.classList.remove('dk');
    loading();
    api('GET', 'api/shared/' + token).then(function (c) {
      document.title = c.title + ' · a Glowup card';
      view.innerHTML = (c.preview ? '<div class="banner" style="margin-bottom:12px;max-width:560px;margin-inline:auto"><span class="e">👀</span><span>This is what people see — a frozen card. Update it from the listing.</span></div>' : '') +
        cardHtml(c) +
        '<p class="center small faint" style="margin-top:22px">Scored by <a href="./">Glowup ✨</a> — what would yours score?</p>';
      animateRings(view);
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><div class="e">🔒</div><h2>This link isn’t valid</h2><p>' + esc(e.message) + '</p><a class="btn" href="./">Score your own listing</a></div>';
    });
  }

  /* ---------------- wins ---------------- */

  function renderWins() {
    loading();
    var get = signedIn() ? api('GET', 'api/listings') : loadDemo().then(function (d) { return { listings: d.listings, wins: d.wins, demo: true }; });
    get.then(function (r) {
      var w = r.wins, st = w.streak;
      var base = r.demo ? '#/sample/' : '#/l/';
      var h = (r.demo ? sampleBar('A sample account with three invented listings.') : '') +
        '<div class="page-head"><div><h1>Wins</h1><div class="sub">Every point you’ve added, and the streak that keeps you at it.</div></div></div>';
      h += '<div class="card streak-card"><span class="flame" aria-hidden="true">' + (st.days ? '✨' : '🌑') + '</span><div><b>' + st.days + '</b> <span class="muted">day' + (st.days === 1 ? '' : 's') + ' in a row</span>' +
        '<div class="small muted">' + (st.days ? (st.atRisk ? 'Raise any score today to keep it going.' : 'You raised a score today. Nice.') : 'Raise a listing’s score today to start a streak.') + '</div></div></div>';
      h += '<div class="kpis" style="margin-top:12px"><div class="kpi"><b>+' + w.gained + '</b><span>Points gained</span></div><div class="kpi"><b>' + w.average + '</b><span>Average score</span></div>' +
        '<div class="kpi"><b>' + w.glowing + '</b><span>Glowing (90+)</span></div><div class="kpi"><b>' + w.listings + '</b><span>Listings</span></div></div>';
      if (w.best) h += '<div class="card" style="margin-top:12px"><div class="eyebrow">Biggest glow-up</div><div class="row spread" style="margin-top:8px"><b style="min-width:0;overflow-wrap:anywhere">' + esc(w.best.title) + '</b><span class="num" style="white-space:nowrap"><span class="faint">' + w.best.from + '</span> → <b class="gtext ' + gcls(w.best.to) + '">' + w.best.to + '</b></span></div></div>';
      h += '<div class="section-title"><h2>Every listing</h2></div>' + (r.listings.length ? '<div class="list">' + r.listings.map(function (l) { return lcard(l, base + encodeURIComponent(l.id)); }).join('') + '</div>' : '<div class="empty boxed"><p>No listings yet.</p><a class="btn" href="#/add">Score one</a></div>');
      view.innerHTML = h;
      wireSignup(view);
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- start ---------------- */

  if (PUB) { route(); return; }
  loadMe().then(function () {
    ready = true;
    var q = new URLSearchParams(location.search);
    if (q.get('member') || q.get('credited')) toast(q.get('member') ? 'Welcome, member ✨' : 'Credit added ✨', 3000);
    route();
  });
})();
