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
  // Textareas size themselves (field-sizing in app.css); nothing is styled from script.
  function grow() {}

  function ic(d, cls) { return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; }
  var SPARK = '<path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z"/>';
  var ICON = {
    back: ic('<path d="m15 18-6-6 6-6"/>'),
    chev: ic('<path d="m9 6 6 6-6 6"/>', 'chev'),
    arrow: ic('<path d="M5 12h14M13 6l6 6-6 6"/>', 'arrow'),
    spark: ic(SPARK),
    mark: ic(SPARK, 'mark'),
    info: ic('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>', 'ic'),
    shield: ic('<path d="M12 3.5l7 2.5v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/><path d="m9 12 2 2 4-4"/>', 'ic'),
    check: ic('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>', 'ic'),
    camera: ic('<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 'ic'),
  };
  function banner(kind, icon, html) { return '<div class="banner' + (kind ? ' ' + kind : '') + '">' + icon + '<div class="grow">' + html + '</div></div>'; }
  /** A thin bar whose width is an SVG attribute, never a style. */
  function barSvg(pct, cls) {
    return '<svg class="bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="t" width="100" height="6"/><rect class="' + (cls || 'a') + '" width="' + Math.max(0, Math.min(100, Math.round(pct))) + '" height="6"/></svg>';
  }

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
      '<div class="readout"><b>' + start + '</b><span>' + esc(R.gradeOf(start).label) + '</span></div></div>';
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
      lab.textContent = g.label;
    };
    el.dataset.score = to;
    if (reducedMotion() || from === to) { arc.setAttribute('stroke-dashoffset', (ARC * (1 - to / 100)).toFixed(2)); paint(to); return; }
    setTimeout(function () {
      arc.setAttribute('stroke-dashoffset', (ARC * (1 - to / 100)).toFixed(2));
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
        '<span class="rv">' + v + '</span></div>' +
        '<span class="lab">' + esc(c.label) + '</span></div>';
    }).join('') + '</div>';
  }
  function animateRings(root) {
    var go = function () { $$('.ring .val', root).forEach(function (c) { c.setAttribute('stroke-dashoffset', 100 - Number(c.dataset.pct)); }); };
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
    return '<span class="delta' + cls + '">' + (d > 0 ? '+' : d < 0 ? '\u2212' : '') + Math.abs(d) + (label ? ' ' + esc(label) : '') + '</span>';
  }

  function fixesHtml(result, opts) {
    opts = opts || {};
    var fx = result.fixes.slice(0, opts.limit || 99);
    var html = fx.length ? '<ul class="fixes">' + fx.map(function (f) {
      var c = R.catInfo(f.cat);
      return '<li><div><span class="cat">' + esc(c.label) + '</span><b>' + esc(f.label) + '</b><span>' + esc(f.fix) + '</span></div><span class="lost"><span class="sr-only">costs </span>−' + f.lost + '</span></li>';
    }).join('') + '</ul>' : banner('good', ICON.check, 'Nothing left to fix. This listing is glowing.');
    if (opts.good) {
      var ok = result.checks.filter(function (c) { return c.ok; });
      if (ok.length) {
        html += '<details class="more"><summary>What’s already working (' + ok.length + ')</summary><ul class="fixes">' + ok.map(function (f) {
          return '<li class="ok"><div><b>' + esc(f.label) + '</b><span>' + esc(f.good) + '</span></div><span class="lost">' + f.max + '/' + f.max + '</span></li>';
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
      el.innerHTML = '<button class="btn small ghost" id="signInTop">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var b = me.budget || {};
    var st = me.streak || {};
    el.innerHTML =
      (st.days ? '<span class="pill streak" title="Days in a row you raised a score">' + st.days + '-day streak</span>' : '') +
      '<span class="pill credit" title="AI credit">' + (b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span>' +
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
        '<h2>' + (mode === 'register' ? 'Create your free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Free account with $2 of AI credit — a glow-up costs about a cent, so that is a lot of them. Scoring, editing, versions and share cards are free forever. One account works across every app on this site.'
          : 'Same account as the other apps on this site.')) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button>' +
        '</form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block mt-s" id="pkBtn">Sign in with Face ID or a passkey</button>' : '') +
        '<p class="center small muted mt">' +
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
      '<div class="row spread"><b>AI credit</b><span class="num">' + remaining + '</span></div>' +
      '<div class="mt-s">' + barSvg(pct) + '</div>' +
      '<p class="small muted mt-s">A glow-up, a comparison or a screenshot read costs about a cent. The score, edits, versions and share cards are free.</p>' +
      '<div id="billing" class="mt"></div>' +
      (pkOk() ? '<button class="btn ghost block mt" id="pkEnrol">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block mt-s" id="signOut">Sign out</button>',
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
          '<p class="small muted mt-s">Membership covers every app on this site, runs the better model, and lets you add credit.</p>';
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
    $$('[data-tab]').forEach(function (b) {
      var on = b.dataset.tab === (owner[tab] || tab);
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    if (tab === 'l' && parts[1]) return renderListing(parts[1], parts[2] || '');
    if (tab === 'sample' && parts[1]) return renderSample(parts[1], parts[2] || '');
    if (tab === 'sample') return renderSampleList();
    if (tab === 'add') return renderAdd();
    if (tab === 'wins') return renderWins();
    return signedIn() ? renderMine() : renderHome();
  }
  // Until we know who is signed in, a hash change would route as signed out
  // (and bounce a listing link to the home page). The first route() runs
  // once /api/me answers, and draws whatever the hash is by then.
  var ready = false;
  window.addEventListener('hashchange', function () { if (ready || PUB) route(); });

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner" aria-label="Loading"></span></div>'; }
  function backLink(href, label) { return '<a class="back" href="' + href + '">' + ICON.back + esc(label) + '</a>'; }
  function sampleBar(what) {
    return '<div class="sample-bar"><span><b>SAMPLE</b> ' + esc(what || 'Invented listings — real rules, no AI used.') + '</span>' +
      (signedIn() ? '<a class="btn small" href="#/add">Score yours</a>' : '<button class="btn small" data-signup>Sign up free</button>') + '</div>';
  }
  function wireSignup(root) { $$('[data-signup]', root).forEach(function (b) { b.onclick = function () { openAccount(); }; }); }

  function lcard(l, href) {
    return '<a class="lcard" href="' + href + '"><span class="grow"><span class="t">' + esc(l.title) + '</span>' +
      '<span class="m"><span>' + esc(l.typeLabel) + ' · ' + esc(l.platformLabel) + '</span>' + ((l.trail || []).length > 1 ? sparkSvg(l.trail, 64, 18) : '') +
      (l.firstScore != null && l.score !== l.firstScore ? deltaChip(l.firstScore, l.score) : '') + (l.shared ? '<span class="tag">Shared</span>' : '') + '</span></span>' +
      '<span class="sc ' + gcls(l.score) + '"><b>' + l.score + '</b><span class="gtext">' + esc(l.grade.label) + '</span></span>' + ICON.chev + '</a>';
  }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    loadDemo().then(function (d) {
      var loon = d.items['loons-nest'];
      var first = loon.trail[0], last = loon.trail[loon.trail.length - 1];
      view.innerHTML =
        '<section class="hero">' +
        '<h1>Give your listing a glow-up.</h1>' +
        '<p class="lede">A 0–100 score, a fix for every point, and a rewrite that never makes things up.</p>' +
        '<div class="btn-row"><a class="btn lg" href="#/add">Score my listing</a><a class="btn lg ghost" href="#/sample/loons-nest/glow">See a glow-up</a></div>' +
        '<p class="fine">Free, instant, no sign-up. For rentals, products, resale and local services.</p>' +
        '</section>' +
        '<section class="showcase ' + gcls(last) + '"><div class="eyebrow">The Loon’s Nest · a sample cabin</div>' +
        gauge(last, { from: first }) +
        '<div class="meta">' + deltaChip(first, last, 'points in 3 versions') + '</div>' + rings(loon.result.cats) + '</section>' +
        '<div class="section-title"><h2>How it works</h2></div>' +
        '<ol class="steps">' +
        '<li><h3>Paste or snap it</h3><p>Title, description, tags, how many photos. Or a screenshot of the listing, read once and never kept.</p></li>' +
        '<li><h3>Get the score</h3><p>Five rings: Title, Hook, Details, Trust, Photos. Exactly what to fix, re-scored as you type.</p></li>' +
        '<li><h3>Glow it up</h3><p>Three titles to A/B and a rewritten listing, each scored against your original. Missing facts come back as [add: …], never made up.</p></li>' +
        '</ol>' +
        '<div class="section-title"><h2>Three sample glow-ups</h2><span class="count">scored for real</span></div>' +
        '<div class="list">' + d.listings.map(function (l) { return lcard(l, '#/sample/' + encodeURIComponent(l.id)); }).join('') + '</div>' +
        '<div class="cta-band"><h2>What would yours score?</h2><p>Paste it in. No account needed to see the score.</p><a class="btn lg" href="#/add">Score my listing</a></div>';
      animateGauges(view, 400);
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
      var h = '';
      if (!r.listings.length) {
        h += '<section class="hero"><h1>What does your listing score?</h1><p class="lede">Paste a title and description, or snap a screenshot. It takes a minute.</p>' +
          '<div class="btn-row"><a class="btn lg" href="#/add">Score my first listing</a><a class="btn lg ghost" href="#/sample">See the samples</a></div></section>';
      } else {
        var w = r.wins;
        h += '<div class="page-head"><div><h1>Your listings</h1><div class="sub">Tap one to see its fixes, glow it up, or compare.</div></div>' +
          '<a class="btn" href="#/add">Score one</a></div>';
        h += '<div class="kpis"><div class="kpi"><b>' + w.average + '</b><span>Average score</span></div><div class="kpi"><b>+' + w.gained + '</b><span>Points gained</span></div>' +
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
    return '<nav class="subnav" aria-label="This listing">' + items.map(function (it) {
      return '<a class="' + (on === it[0] ? 'on' : '') + '"' + (on === it[0] ? ' aria-current="page"' : '') + ' href="' + base + (it[0] ? '/' + it[0] : '') + '">' + esc(it[1]) + '</a>';
    }).join('') + '</nav>';
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
      if (e.status === 404) view.innerHTML = '<div class="empty"><h2>Not found</h2><p>' + esc(e.message) + '</p><a class="btn" href="#/">Your listings</a></div>';
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
    return '<span class="tag">' + esc(t.short) + '</span><span class="tag">' + esc(p.label) + '</span>';
  }

  function drawScore(l, head, demo) {
    var res = l.result;
    var base = (demo ? '#/sample/' : '#/l/') + encodeURIComponent(l.id);
    var h = head + '<div class="dk-2"><div>';
    h += '<section class="score-block ' + gcls(res.score) + '">' + gauge(res.score) +
      '<div class="ttl">' + esc(l.title || '(no title yet)') + '</div><div class="meta">' + typeLine(l) +
      (l.firstScore != null && l.versions.length > 1 ? deltaChip(l.firstScore, res.score, 'since version 1') : '') + '</div>' + rings(res.cats) + '</section>';
    h += '<div class="section-title"><h2>' + (res.fixes.length ? 'Fix these next' : 'All done') + '</h2><span class="count">' + (res.fixes.length ? res.fixes.reduce(function (s, f) { return s + f.lost; }, 0) + ' points on the table' : '') + '</span></div>';
    h += fixesHtml(res, { good: true });
    h += '</div><div class="dk-sticky">';
    h += '<div class="section-title"><h2>Make it better</h2></div><div class="actions">' +
      (demo ? '<a class="btn lg" href="' + base + '/glow">' + ICON.spark + 'See its glow-up</a>'
        : '<button class="btn lg" id="glowNow">' + ICON.spark + 'Glow it up <span class="cost">· about 1¢</span></button>') +
      (demo ? '' : '<a class="btn ghost" href="' + base + '/edit">Edit it myself</a>') +
      (demo && !l.compare ? '' : '<a class="btn ghost" href="' + base + '/compare">Compare with a competitor</a>') +
      (demo ? '<a class="btn ghost" href="' + base + '/card">The share card</a>' : '<button class="btn ghost" id="shareBtn">' + (l.share ? 'Share card · live' : 'Share the glow-up') + '</button>') +
      '<a class="btn ghost" href="' + base + '/versions">Versions (' + l.versions.length + ')</a></div>' +
      (demo ? '' : '<p class="hint">The score and every fix are free. A glow-up writes three titles and a new listing with AI, then scores each one with these same rules. Nothing changes until you apply it.</p>');
    if (l.trail.length > 1) {
      h += '<div class="section-title"><h2>Score over time</h2><span class="count">' + l.trail.length + ' versions' + (l.streak > 1 ? ' · ' + l.streak + ' better in a row' : '') + '</span></div>' + bigSpark(l.trail);
    }
    if (l.compare) {
      h += '<div class="section-title"><h2>Last comparison</h2><span class="count">' + esc(fmtDay(l.compare.at)) + '</span></div>' +
        '<div class="best-row"><span>You <b class="' + gcls(l.compare.me.score) + ' gtext num">' + l.compare.me.score + '</b></span><span>' + esc(truncate(l.compare.them.title, 34)) + ' <b class="' + gcls(l.compare.them.score) + ' gtext num">' + l.compare.them.score + '</b></span></div>' +
        (l.compare.verdict ? '<p class="hint">' + esc(l.compare.verdict) + '</p>' : '');
    }
    h += '</div></div>';
    view.innerHTML = h;
    animateGauges(view);
    animateRings(view);
    var sb = $('#shareBtn'); if (sb) sb.onclick = function () { openShare(l); };
    // One tap from the listing starts the rewrite: the button says what it costs.
    var gn = $('#glowNow'); if (gn) gn.onclick = function () { state.autoGlow = l.id; delete state.glow[l.id]; location.hash = base + '/glow'; };
  }

  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function bigSpark(scores) {
    var w = 320, h = 90, pts = R.sparkline(scores, w, h, 12);
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' ');
    var area = d + ' L' + pts[pts.length - 1][0] + ' ' + h + ' L' + pts[0][0] + ' ' + h + ' Z';
    var dots = scores.length === 1 ? '' : scores.map(function (s, i) {
      var p = pts[i];
      return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3"/>' + (i === 0 || i === scores.length - 1 || scores.length <= 6 ? '<text x="' + p[0] + '" y="' + Math.max(10, p[1] - 8) + '" text-anchor="' + (i === 0 ? 'start' : i === scores.length - 1 ? 'end' : 'middle') + '">' + s + '</text>' : '');
    }).join('');
    return '<svg class="spark big-spark" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Score by version: ' + scores.join(', ') + '"><path class="a" d="' + area + '"/><path class="l" d="' + d + '"/>' + dots + '</svg>';
  }

  /* ---------------- the form: add and edit, scored live ---------------- */

  function emptyFields() { return { type: 'stay', platform: 'airbnb', title: '', description: '', tags: [], keywords: [], price: '', photoCount: 0, shots: [] }; }

  function formHtml(f) {
    var t = R.typeInfo(f.type), plats = R.platformsFor(f.type), p = R.platformOf(f.type, f.platform);
    return '<div class="group-title">What is it?</div>' +
      '<div class="type-pick" role="group" aria-label="Listing type">' + R.TYPES.map(function (x) {
        return '<button type="button" data-type="' + x.key + '" class="' + (x.key === f.type ? 'on' : '') + '" aria-pressed="' + (x.key === f.type) + '"><b>' + esc(x.label) + '</b><span>' + esc(x.who) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="group-title">Where it’s listed</div><div class="chips" role="group" aria-label="Platform">' + plats.map(function (x) {
        return '<button type="button" class="chip' + (x.key === p.key ? ' on' : '') + '" data-plat="' + x.key + '" aria-pressed="' + (x.key === p.key) + '">' + esc(x.label) + '</button>';
      }).join('') + '</div><p class="hint">' + esc(p.note) + '</p>' +
      '<div class="group-title">The listing</div>' +
      '<div class="field"><label for="fTitle"><span>Title</span><span class="count" id="tCount"></span></label><input id="fTitle" maxlength="200" placeholder="' + (f.type === 'stay' ? 'Lake cabin with hot tub & wood stove' : f.type === 'product' ? 'Cedar candle with wood wick, 8 oz' : f.type === 'resale' ? 'Waxed canvas field jacket, men’s M' : 'Riverside Plumbing') + '" value="' + esc(f.title) + '"></div>' +
      '<div class="field"><label for="fDesc"><span>Description</span><span class="count" id="dCount"></span></label><textarea id="fDesc" maxlength="6000" rows="8" placeholder="Paste the description exactly as it is now.">' + esc(f.description) + '</textarea></div>' +
      '<div class="field"><label for="fKw"><span>Search words buyers type</span><span class="opt-note">comma between</span></label><input id="fKw" maxlength="300" placeholder="' + (f.type === 'stay' ? 'lake cabin, hot tub, dog friendly' : f.type === 'product' ? 'cedar candle, wood wick candle' : f.type === 'resale' ? 'waxed canvas jacket, field jacket' : 'emergency plumber, water heater repair') + '" value="' + esc((f.keywords || []).join(', ')) + '"></div>' +
      '<div class="field"><label for="fTags"><span>' + esc(t.tagsLabel) + '</span><span class="opt-note" id="tagCount"></span></label><textarea id="fTags" rows="3" maxlength="2000" placeholder="' + esc(t.tagsHint) + '">' + esc((f.tags || []).join('\n')) + '</textarea></div>' +
      '<div class="form-row"><div class="field"><label for="fPrice"><span>Price</span></label><input id="fPrice" maxlength="40" placeholder="' + (f.type === 'stay' ? '$189 / night' : f.type === 'service' ? 'Free quotes' : '$24') + '" value="' + esc(f.price) + '"></div>' +
      '<div class="field"><span class="lbl" id="phLbl">Photos</span><div class="stepper" role="group" aria-labelledby="phLbl"><button type="button" id="phMinus" aria-label="One fewer photo">−</button><input id="fPhotos" inputmode="numeric" aria-label="Number of photos" value="' + (f.photoCount || 0) + '"><button type="button" id="phPlus" aria-label="One more photo">+</button></div></div></div>' +
      '<p class="hint">Aim for ' + t.photosRec + ' photos for a ' + esc(t.short.toLowerCase()) + '.</p>' +
      '<div class="group-title">Which of these shots do you have?</div><div class="shot-list">' + R.SHOTS[f.type].map(function (s) {
        return '<label><input type="checkbox" data-shot="' + s.key + '"' + ((f.shots || []).indexOf(s.key) >= 0 ? ' checked' : '') + '><span>' + esc(s.label) + '</span></label>';
      }).join('') + '</div>';
  }

  function ringCls(pc) { return pc >= 90 ? 'g-great' : pc >= 60 ? 'g-good' : pc >= 40 ? 'g-okay' : 'g-dim'; }
  function scorePanel(res) {
    return '<section class="score-block ' + gcls(res.score) + '" id="sideCard">' + gauge(res.score, { size: 'small' }) + rings(res.cats, { still: true }) + '</section>' +
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
      if (tg) tg.textContent = plat.tagsMax ? (f.tags || []).length + ' of ' + plat.tagsMax : 'one per line';
      var live = $('#live', root);
      if (live) {
        live.className = 'live ' + gcls(res.score);
        $('#liveN', root).textContent = res.score;
        $('#liveRings', root).innerHTML = R.CATS.map(function (c) { var v = catVal(res.cats, c.key); var pc = v / 20 * 100; return '<span class="' + ringCls(pc) + '" title="' + esc(c.label) + ' ' + v + '/20">' + barSvg(pc) + '</span>'; }).join('');
        $('#liveFix', root).textContent = res.fixes.length ? 'Next: ' + res.fixes[0].fix : 'Nothing left to fix.';
      }
      var side = $('#sideCard', root);
      if (side) {
        var g = $('.gauge', side);
        setGauge(g, Number(g.dataset.score), res.score, 0);
        side.className = 'score-block ' + gcls(res.score);
        $$('.ring', side).forEach(function (r, i) {
          var v = catVal(res.cats, R.CATS[i].key), pc = Math.round(v / 20 * 100);
          r.className = 'ring ' + ringCls(pc);
          r.setAttribute('aria-label', R.CATS[i].label + ': ' + v + ' of 20');
          $('.val', r).setAttribute('stroke-dashoffset', 100 - pc);
          $('.rv', r).textContent = v;
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
        '<div class="page-head"><div><h1>Score a listing</h1><div class="sub">Paste it as it is now. The score updates as you type' + (signedIn() ? '.' : ', free, with no account.') + '</div></div></div>' +
        '<div class="dk-2"><div>' + liveStrip(res) +
        '<label class="snap-card" id="snapCard">' + ICON.camera + '<span class="grow"><b>Snap a screenshot instead</b><span>Glowup reads the title and description. About 1¢ of AI credit; the image is never stored.</span></span>' +
        '<input type="file" id="snapIn" accept="image/*"></label><div id="snapState">' + (fromSnap ? banner('', ICON.info, 'Read from your screenshot. Check it, tick the shots you have, then save. The image wasn’t kept.') : '') + '</div>' +
        '<div class="or">or paste it in</div>' +
        formHtml(f) +
        '<div id="aErr"></div><button class="btn block lg mt" id="aSave">' + (signedIn() ? 'Save and see every fix' : 'Sign up free to save it') + '</button>' +
        (signedIn() ? '' : '<p class="hint center">Saving keeps its versions and unlocks the glow-up and the share card. Your text stays on this device until then.</p>') +
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
          toast('Saved. It scores ' + l.result.score + '. Here’s what to fix.', 3200);
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
    box.innerHTML = '<div class="writing" role="status"><span class="spinner"></span>Reading your screenshot…</div>';
    shrink(file).then(function (image) {
      return api('POST', 'api/listings/read', { image: image });
    }).then(function (p) {
      var keep = recall(DRAFT_KEY) || {};
      state.snapped = { type: p.type, platform: p.platform, title: p.title, description: p.description, tags: p.tags, price: p.price, photoCount: p.photoCount == null ? (keep.photoCount || 0) : p.photoCount, keywords: keep.keywords || [], shots: [] };
      loadMe();
      renderAdd();
    }).catch(function (e) {
      if (e.status === 402) { box.innerHTML = ''; return openCreditSheet(e.data); }
      box.innerHTML = banner('warn', ICON.info, esc(e.message) + ' Pasting it in is free.');
    });
  }

  function drawEdit(l, head) {
    var f = {};
    ['type', 'platform', 'title', 'description', 'tags', 'keywords', 'price', 'photoCount', 'shots'].forEach(function (k) { f[k] = Array.isArray(l[k]) ? l[k].slice() : l[k]; });
    var before = l.result.score;
    function draw() {
      var res = R.score(f);
      view.innerHTML = head + '<div class="dk-2"><div>' + liveStrip(res) + formHtml(f) +
        '<div id="eErr"></div><div class="btn-row mt"><button class="btn lg" id="eSave">Save as version ' + (l.versions[0].n + 1) + '</button><a class="btn lg ghost" href="#/l/' + encodeURIComponent(l.id) + '">Cancel</a></div>' +
        '<p class="hint">Every save is a version. You can always go back.</p>' +
        '</div><div class="dk-sticky side-score"><p class="hint mb">Saved score: <b>' + before + '</b>. Watch it move as you type.</p>' + scorePanel(res) + '</div></div>';
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
    if (d > 0) toast('+' + d + ' points. Now ' + r.result.score + (r.newBest ? ', a new best.' : '.'), 3400);
    else if (d < 0) toast('Saved. That cost ' + (-d) + ' point' + (d === -1 ? '' : 's') + ' - Versions can take you back.', 3400);
    else toast('Saved as a new version.');
    loadMe();
  }

  /* ---------------- glow it up ---------------- */

  /**
   * The AI feature. The model wrote three titles and one listing through a
   * forced tool; the server threw away anything carrying a fact or number the
   * seller's listing does not, and scored every option with the rules that
   * scored the original. This page only shows those numbers side by side and
   * lets the seller pick and edit - re-scored here by the same rules file.
   */
  function drawGlow(l, head, demo, pre) {
    var g = pre || state.glow[l.id];
    if (!g) {
      var run = function () {
        view.innerHTML = head + '<div class="glow-intro" role="status" aria-live="polite">' + ICON.mark + '<h2>Writing three titles and a new listing…</h2>' +
          '<p>Using only the facts in your listing. Then each one is scored with the same rules as your original.</p><span class="spinner"></span></div>';
        api('POST', 'api/listings/' + encodeURIComponent(l.id) + '/glowup').then(function (r) {
          state.glow[l.id] = r;
          loadMe();
          drawGlow(l, head, false);
        }).catch(function (e) {
          drawGlow(l, head, false);
          showError(e, $('#gErr'));
        });
      };
      view.innerHTML = head + '<div class="glow-intro">' + ICON.mark + '<h2>Three titles to A/B and a rewritten listing</h2>' +
        '<p>Written from the facts already in your listing, nothing invented. Anything a buyer would want that it doesn’t say comes back as <b>[add: …]</b> for you to fill in. Every option is scored against your original by the same rules.</p>' +
        '<button class="btn lg" id="goGlow">' + ICON.spark + 'Glow it up <span class="cost">· about 1¢</span></button><div id="gErr"></div>' +
        '<p class="hint">Nothing changes until you apply it. <a href="#/l/' + encodeURIComponent(l.id) + '/edit">Edit it myself</a> is free.</p></div>';
      $('#goGlow').onclick = run;
      if (state.autoGlow === l.id) { state.autoGlow = null; run(); }
      return;
    }
    // "Before" is what the glow-up was run on: the saved listing, or for the
    // sample its first version.
    var orig = demo ? (demoVersion(l.id, 1) || l) : l;
    var plat = R.platformOf(l.type, l.platform);
    var b0 = g.before.score;
    var opts = g.titles.map(function (t) { return { text: t.text, angle: t.angle, score: t.score, alone: t.alone, trimmed: t.trimmed, locked: t.locked }; });
    if (!plat.titleLocked && g.rewrite) opts.push({ text: g.rewrite.title, angle: 'Keep my title', score: g.rewrite.score, keep: true });
    var fields = { title: opts.length ? opts[0].text : l.title, description: g.fields.description, tags: g.fields.tags.slice() };
    function merged() { return Object.assign({}, { type: l.type, platform: l.platform, keywords: orig.keywords || l.keywords, price: orig.price || l.price, photoCount: orig.photoCount != null ? orig.photoCount : l.photoCount, shots: orig.shots || l.shots }, fields); }
    var after = R.score(merged());
    var bg = R.gradeOf(b0);
    var h = head;
    h += '<section class="narrow"><div class="ba" role="group" aria-label="Score before and after">' +
      '<div class="side was"><span class="cap">Before</span><b class="n" id="gBeforeN">' + b0 + '</b><span class="gl">' + esc(bg.label) + '</span></div>' + ICON.arrow +
      '<div class="side ' + gcls(after.score) + '" id="gAfter"><span class="cap">After</span><b class="n gtext" id="gAfterN">' + after.score + '</b><span class="gl" id="gAfterL">' + esc(R.gradeOf(after.score).label) + '</span></div></div>' +
      '<div class="ba-foot"><span id="gDelta" aria-live="polite">' + deltaChip(b0, after.score, 'points') + '</span>' +
      '<p>Both numbers come from Glowup’s rules, not from the AI.' + (g.summary ? ' ' + esc(g.summary) : '') + '</p></div>' +
      '<div class="bars" id="gBars"></div><div class="bar-legend"><span><i class="b"></i>Before</span><span><i></i>After</span></div></section>';
    if (g.removed && g.removed.length) {
      h += banner('warn', ICON.shield, '<b>We took out ' + g.removed.length + ' thing' + (g.removed.length === 1 ? '' : 's') + ' your listing doesn’t say.</b> A rewrite must never invent facts. Add the real ones yourself.<ul class="removed">' +
        g.removed.slice(0, 6).map(function (r) { return '<li><b>' + esc(r.what) + '</b> · ' + esc(r.where) + (r.number ? ' - a number your listing doesn’t give' : ': “' + esc(r.text) + '”') + '</li>'; }).join('') + '</ul>');
    }
    h += '<div class="dk-2"><div>';
    h += '<div class="section-title"><h2>' + (plat.titleLocked ? 'Business name' : 'Pick a title to test') + '</h2><span class="count">' + (plat.titleLocked ? 'Google wants your real name' : 'before → after') + '</span></div>';
    h += '<div class="opts" role="radiogroup" aria-label="Title options">' + opts.map(function (t, i) {
      var sub = esc(t.angle) + ' · ' + t.text.length + '/' + plat.titleMax + (t.trimmed ? ' · trimmed to fit' : '') +
        (t.alone != null && !t.locked ? ' · title alone ' + b0 + ' → ' + t.alone : '') + (t.keep ? ' · new description only' : '');
      return '<button class="opt' + (i === 0 ? ' on' : '') + '" role="radio" aria-checked="' + (i === 0) + '" data-opt="' + i + '"><span class="dot" aria-hidden="true"></span>' +
        '<span class="min0"><span class="txt">' + esc(t.text || '(no title)') + '</span><span class="sub">' + sub + '</span></span>' +
        '<span class="sc ' + gcls(t.score) + '"><span class="sr-only">Before </span>' + b0 + '<span class="ar" aria-hidden="true">→</span><span class="sr-only"> after </span><b class="gtext">' + t.score + '</b>' + deltaChip(b0, t.score) + '</span></button>';
    }).join('') + '</div>';
    if (!demo && !plat.titleLocked) {
      h += '<div class="field mt"><label for="gTitle"><span>Your title</span><span class="count" id="gtCount"></span></label><input id="gTitle" maxlength="200" value="' + esc(fields.title) + '"></div>' +
        '<p class="hint">Pick one, edit it if you like, and test it for a week. The score says which reads better; your bookings say which sells.</p>';
    }
    h += '<div class="section-title"><h2>The rewritten listing</h2><span class="count" id="gdCount"></span></div>';
    h += demo ? '<div class="pre">' + esc(fields.description) + '</div>'
      : '<textarea class="input" id="gDesc" rows="10" aria-label="New description">' + esc(fields.description) + '</textarea>';
    if (g.gaps && g.gaps.length) h += '<div class="group-title">Fill these in <span class="count">' + g.gaps.length + '</span></div><div class="gaps">' + g.gaps.map(function (x) { return '<span class="tag">[add: ' + esc(x) + ']</span>'; }).join('') + '</div>' + (demo ? '' : '<p class="hint">Replace each [add: …] in the text with the real fact, or delete the line. The score climbs as you do.</p>');
    h += '<div class="group-title">' + esc(R.typeInfo(l.type).tagsLabel) + ' <span class="count">' + fields.tags.length + (plat.tagsMax ? ' of ' + plat.tagsMax : '') + '</span></div><div class="tags">' + fields.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>';
    h += '<details class="more"><summary>Your original</summary><div class="orig"><b>' + esc(orig.title) + '</b>\n\n' + esc(orig.description) + '</div></details>';
    h += '</div><div class="dk-sticky">';
    h += demo ? banner('', ICON.info, 'The host applied this, then filled in the gaps: <b>' + l.trail[1] + ' → ' + l.trail[2] + '</b>. See Versions.')
      : '<div id="applyErr"></div><div class="actions"><button class="btn lg" id="applyBtn">Use this as version ' + (l.versions[0].n + 1) + '</button><button class="btn ghost" id="againBtn">Try again · about 1¢</button></div><p class="hint">Applying saves a new version. Your original stays in Versions.</p>';
    h += '<div class="section-title"><h2>What’s left</h2><span class="count" id="gLeftN"></span></div><div id="gLeft"></div>';
    if (g.shots && g.shots.length) h += '<div class="section-title"><h2>Your shot list</h2><span class="count">photos to take next</span></div><ol class="shots">' + g.shots.map(function (s, i) { return '<li><span class="n">' + (i + 1) + '</span><div><b>' + esc(s.shot) + '</b><span>' + esc(s.why) + '</span></div></li>'; }).join('') + '</ol>';
    h += '</div></div>';
    view.innerHTML = h;

    function bars(res) {
      $('#gBars').innerHTML = R.CATS.map(function (c) {
        var b = catVal(g.before.cats, c.key), a = catVal(res.cats, c.key);
        return '<div class="bar-row"><span class="lab">' + esc(c.label) + '</span><span class="tr">' + barSvg(b / 20 * 100, 'b') + barSvg(a / 20 * 100) + '</span><span class="v">' + b + ' → <b>' + a + '</b></span></div>';
      }).join('');
    }
    function repaint() {
      var res = R.score(merged());
      $('#gAfter').className = 'side ' + gcls(res.score);
      $('#gAfterN').textContent = res.score;
      $('#gAfterL').textContent = R.gradeOf(res.score).label;
      $('#gDelta').innerHTML = deltaChip(b0, res.score, 'points');
      bars(res);
      $('#gLeft').innerHTML = fixesHtml(res, { limit: 4 });
      $('#gLeftN').textContent = res.fixes.length ? res.fixes.reduce(function (s, x) { return s + x.lost; }, 0) + ' points' : '';
      var dc = $('#gdCount'); if (dc) { dc.textContent = fields.description.length + (plat.descMax ? ' / ' + plat.descMax : '') + ' characters'; dc.classList.toggle('over', Boolean(plat.descMax && fields.description.length > plat.descMax)); }
      var tc = $('#gtCount'); if (tc) { tc.textContent = fields.title.length + ' / ' + plat.titleMax; tc.classList.toggle('over', fields.title.length > plat.titleMax); }
    }
    repaint();
    var ti = $('#gTitle');
    $$('[data-opt]').forEach(function (b) {
      b.onclick = function () {
        fields.title = opts[Number(b.dataset.opt)].text;
        if (ti) ti.value = fields.title;
        $$('[data-opt]').forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
        repaint();
      };
    });
    if (ti) ti.addEventListener('input', function () { fields.title = ti.value; repaint(); });
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
    if (again) again.onclick = function () { delete state.glow[l.id]; state.autoGlow = l.id; drawGlow(l, head, false); };
  }

  /* ---------------- compare ---------------- */

  function vsBlock(c) {
    return '<div class="vs"><div class="' + gcls(c.me.score) + '"><div class="eyebrow">You</div>' + gauge(c.me.score, { size: 'small' }) + '</div><div class="mid">vs</div>' +
      '<div><div class="eyebrow">Them</div>' + gauge(c.them.score, { size: 'small' }) + '<div class="who">' + esc(c.them.title) + '</div></div></div>' +
      '<div class="bars">' + R.CATS.map(function (k) {
        var a = catVal(c.me.cats, k.key), b = catVal(c.them.cats, k.key);
        return '<div class="bar-row"><span class="lab">' + esc(k.label) + '</span><span class="tr">' + barSvg(a / 20 * 100) + barSvg(b / 20 * 100, 'b') + '</span><span class="v"><b>' + a + '</b> vs ' + b + '</span></div>';
      }).join('') + '</div><div class="bar-legend"><span><i></i>You</span><span><i class="b"></i>Them</span></div>' +
      '<p class="hint center">Both scored by the same rules. We can’t see their photos, only how many (' + c.them.photos + '), so their Photos ring is an estimate.</p>';
  }
  function compareResultHtml(c) {
    return vsBlock(c) +
      '<div class="section-title"><h2>They do better</h2></div><ul class="pts-list them">' + c.theyDoBetter.map(function (x) { return '<li>' + esc(x.point) + (x.move ? '<span>' + esc(x.move) + '</span>' : '') + '</li>'; }).join('') + '</ul>' +
      '<div class="section-title"><h2>You do better</h2></div><ul class="pts-list you">' + c.youDoBetter.map(function (x) { return '<li>' + esc(x.point) + '</li>'; }).join('') + '</ul>' +
      (c.verdict ? banner('', ICON.info, '<b>The one change:</b> ' + esc(c.verdict)) : '');
  }

  function drawCompare(l, head, demo) {
    var h = head;
    if (demo) {
      h += '<div class="narrow">' + (l.compare ? compareResultHtml(l.compare) : '<div class="empty"><p>No comparison on this sample.</p></div>') + '</div>';
      view.innerHTML = h; animateGauges(view); return;
    }
    h += '<div class="dk-2"><div><div class="section-title"><h2>Paste a competitor</h2><span class="count">one that ranks above you</span></div>' +
      '<label class="field"><span>Their title</span><input class="input" id="cTitle" maxlength="200"></label>' +
      '<label class="field"><span>Their description</span><textarea class="input" id="cDesc" rows="7" maxlength="6000"></textarea></label>' +
      '<div class="form-row"><label class="field"><span>Their price</span><input class="input" id="cPrice" maxlength="40"></label><label class="field"><span>Photos</span><input class="input" id="cPhotos" inputmode="numeric" placeholder="24" size="4"></label></div>' +
      '<div id="cErr"></div><button class="btn block lg" id="cGo">Compare · about 1¢</button>' +
      '<p class="hint">We keep their title and scores with your listing, never their full text. Nothing of theirs is copied into yours.</p></div>' +
      '<div id="cOut">' + (l.compare ? '<div class="section-title"><h2>Last comparison</h2><span class="count">' + esc(fmtDay(l.compare.at)) + '</span></div>' + compareResultHtml(l.compare) : '<div class="empty"><h2>See how you stack up</h2><p>Both listings get the same glow score, side by side, plus what they do better and what you already win on.</p></div>') + '</div></div>';
    view.innerHTML = h;
    animateGauges(view);
    $('#cGo').onclick = function () {
      var btn = this; btn.disabled = true;
      btn.textContent = 'Comparing…';
      api('POST', 'api/listings/' + encodeURIComponent(l.id) + '/compare', { title: $('#cTitle').value, description: $('#cDesc').value, photoCount: $('#cPhotos').value, price: $('#cPrice').value })
        .then(function (c) {
          btn.disabled = false; btn.textContent = 'Compare again · about 1¢';
          $('#cOut').innerHTML = compareResultHtml(c);
          animateGauges($('#cOut'));
          loadMe();
          if (window.innerWidth < 900) $('#cOut').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
        })
        .catch(function (e) { btn.disabled = false; btn.textContent = 'Compare · about 1¢'; showError(e, $('#cErr')); });
    };
  }

  /* ---------------- versions ---------------- */

  function drawVersions(l, head, demo) {
    var rows = l.versions;
    var h = head + '<div class="narrow"><div class="section-title"><h2>Score over time</h2><span class="count">' + (l.streak > 0 ? l.streak + ' better save' + (l.streak === 1 ? '' : 's') + ' in a row' : 'every save is kept') + '</span></div>' + bigSpark(l.trail);
    h += '<div class="section-title"><h2>Versions</h2><span class="count">' + rows.length + ' kept</span></div><div class="vlist">' + rows.map(function (v, i) {
      var prev = rows[i + 1];
      var d = prev ? v.score - prev.score : null;
      return '<button class="vrow' + (i === 0 ? ' current' : '') + '" data-v="' + esc(v.id) + '"><span class="n">v' + v.n + '</span><span class="min0"><span class="t">' + esc(v.title || '(no title)') + '</span><span class="m">' + esc(SOURCE[v.source] || v.source) + ' · ' + esc(fmtDay(v.at)) + (i === 0 ? ' · current' : '') + '</span></span>' +
        '<span class="s">' + v.score + (d != null ? '<small class="' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d) + '</small>' : '<small>first</small>') + '</span></button>';
    }).join('') + '</div><p class="hint">Going back saves the old text as a new version. Nothing is ever lost.</p></div>';
    view.innerHTML = h;
    $$('[data-v]').forEach(function (b) {
      b.onclick = function () { openVersion(l, b.dataset.v, demo); };
    });
  }

  function openVersion(l, vid, demo) {
    var show = function (v) {
      var cur = l.versions[0].id === v.id;
      sheet('<h2>Version ' + v.n + ' · ' + esc(SOURCE[v.source] || v.source) + '</h2><p class="muted small">' + esc(fmtDay(v.at)) + '</p>' +
        '<section class="score-block ' + gcls(v.result.score) + '">' + gauge(v.result.score, { size: 'small' }) + rings(v.result.cats, { still: true }) + '</section>' +
        '<div class="orig"><b>' + esc(v.fields.title) + '</b>\n\n' + esc(v.fields.description) + '</div>' +
        (demo || cur ? '' : '<div id="rvErr"></div><button class="btn block lg" id="revertBtn">Go back to this version</button>'),
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
    return '<div class="gcard ' + gcls(c.after.score) + '"><div class="kind">' + esc(c.typeLabel) + ' · ' + esc(c.platformLabel) + '</div>' +
      '<h1>' + esc(c.title) + '</h1>' +
      '<div class="big"><span class="n b num"><span class="sr-only">Before </span>' + c.before.score + '</span><span class="arrow" aria-hidden="true">→</span><span class="n num gtext"><span class="sr-only">After </span>' + c.after.score + '</span></div>' +
      '<div class="gl"><span class="gtext">' + esc(c.after.grade.label) + '</span> · ' + deltaChip(c.before.score, c.after.score, 'points in ' + c.saves + ' version' + (c.saves === 1 ? '' : 's')) + '</div>' +
      rings(c.after.cats, { still: opts.still }) +
      (c.trail && c.trail.length > 1 ? bigSpark(c.trail) : '') +
      (c.text ? '<div class="text">' + esc(c.text.description) + (c.text.tags && c.text.tags.length ? '<div class="tags mt">' + c.text.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>' : '') + '</div>' : '') +
      '</div>';
  }

  function drawCardPreview(l, head) {
    view.innerHTML = head + '<p class="muted small center mb">A share link shows this card: the scores, the rings and the new title. Never the full text unless you tick it.</p>' + cardHtml(l.card);
    animateRings(view);
  }

  function openShare(l) {
    function draw(root, s) {
      var url = s ? location.origin + BASE + s.url : '';
      root.innerHTML = '<div class="grab"></div><h2>Share the glow-up</h2><p class="muted small">A public, read-only card: before and after scores, the rings and your new title. Frozen when you publish; update it any time.</p>' +
        '<label class="check"><input type="checkbox" id="shText"' + (s && s.includeText ? ' checked' : '') + '><span>Also show the full new description and tags</span></label>' +
        (s ? '<div class="share-box"><input class="input" id="shUrl" readonly value="' + esc(url) + '" aria-label="Share link"><button class="btn" id="shCopy">Copy</button></div>' +
          '<div class="more-actions"><button class="btn small ghost" id="shPub">Update the card</button><a class="btn small ghost" href="' + esc(BASE + s.url) + '" target="_blank" rel="noopener">Open</a><button class="btn small danger" id="shRevoke">Revoke</button></div>'
          : '<button class="btn block lg mt-s" id="shPub">Publish the card</button>') +
        '<div id="shErr"></div><p class="small muted mt">Anyone with the link can see it. Revoke it and the link is dead for good.</p>';
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
      view.innerHTML = (c.preview ? '<div class="narrow">' + banner('', ICON.info, 'This is what people see: a frozen card. Update it from the listing.') + '</div>' : '') +
        cardHtml(c) +
        '<p class="center small muted mt">Scored by <a href="./">Glowup</a>. What would yours score?</p>';
      animateRings(view);
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><h2>This link isn’t valid</h2><p>' + esc(e.message) + '</p><a class="btn" href="./">Score your own listing</a></div>';
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
      h += '<div class="streak-line"><b>' + st.days + '</b><div><span>day' + (st.days === 1 ? '' : 's') + ' in a row</span>' +
        '<div class="small muted">' + (st.days ? (st.atRisk ? 'Raise any score today to keep it going.' : 'You raised a score today. Nice.') : 'Raise a listing’s score today to start a streak.') + '</div></div></div>';
      h += '<div class="kpis"><div class="kpi"><b>+' + w.gained + '</b><span>Points gained</span></div><div class="kpi"><b>' + w.average + '</b><span>Average score</span></div>' +
        '<div class="kpi"><b>' + w.glowing + '</b><span>Glowing (90+)</span></div><div class="kpi"><b>' + w.listings + '</b><span>Listings</span></div></div>';
      if (w.best) h += '<div class="eyebrow">Biggest glow-up</div><div class="best-row mt-s"><b class="min0">' + esc(w.best.title) + '</b><span class="num"><span class="muted">' + w.best.from + '</span> → <b class="gtext ' + gcls(w.best.to) + '">' + w.best.to + '</b></span></div>';
      h += '<div class="section-title"><h2>Every listing</h2></div>' + (r.listings.length ? '<div class="list">' + r.listings.map(function (l) { return lcard(l, base + encodeURIComponent(l.id)); }).join('') + '</div>' : '<div class="empty"><p>No listings yet.</p><a class="btn" href="#/add">Score one</a></div>');
      view.innerHTML = h;
      wireSignup(view);
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- start ---------------- */

  if (PUB) { route(); return; }
  loadMe().then(function () {
    ready = true;
    var q = new URLSearchParams(location.search);
    if (q.get('member') || q.get('credited')) toast(q.get('member') ? 'Welcome, member.' : 'Credit added.', 3000);
    route();
  });
})();
