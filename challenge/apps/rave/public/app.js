/* Rave - the page. One file, no build step, every model-written or typed
   string escaped. Nothing here writes a style attribute: bars and gauges are
   SVG attributes, confetti and states are classes. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');
  var RR = window.RaveRules;

  // Where the app is mounted: '/' on its own, '/rave/' inside the lab. The
  // public wall lives one level down (s/<token>) with <base href="../">, so
  // the base comes from the document's base URI rather than the path.
  var BASE = new URL('.', document.baseURI).pathname;
  var PUB = location.pathname.match(/\/s\/([A-Za-z0-9_-]{16,40})\/?$/);

  var PLATFORMS = [
    { key: 'google', label: 'Google' }, { key: 'yelp', label: 'Yelp' }, { key: 'facebook', label: 'Facebook' },
    { key: 'tripadvisor', label: 'Tripadvisor' }, { key: 'other', label: 'Other' },
  ];
  var TONES = [
    { key: 'warm', label: 'Warm', ex: '“Hi Maya, this made our morning — thank you! So glad the buns won you over.”' },
    { key: 'professional', label: 'Professional', ex: '“Dear Maya, thank you for the excellent review. We are delighted you enjoyed your visit.”' },
    { key: 'playful', label: 'Playful', ex: '“Hey Maya! Five stars?! You’ve made our week — come back soon, we’ll be here!”' },
  ];
  var LEVEL = { cool: 'Cool', warm: 'Warm', hot: 'Hot', boiling: 'Boiling' };
  var URG = { urgent: 'Handle offline', high: 'Unhappy', normal: 'Mixed', low: 'Happy', done: 'Replied' };
  // A reply the owner wrote themselves. It lives on this device only and
  // rides along with each draft request; the server never stores it.
  var VOICE_KEY = 'rave-voice-sample';

  var state = { me: null, demo: null, snapped: null, coolDraft: null, flush: null };

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localToday() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function voiceSample() { try { return localStorage.getItem(VOICE_KEY) || ''; } catch (e) { return ''; } }
  function saveVoiceSample(t) { try { if (t) localStorage.setItem(VOICE_KEY, t); else localStorage.removeItem(VOICE_KEY); } catch (e) { /* private mode: it just is not kept */ } }

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
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; else toast(msg, 3500);
  }

  function fmtDay(iso, opts) {
    if (!iso) return '';
    return new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', month: 'short', day: 'numeric' }, opts || {}));
  }
  function ago(days) {
    if (days == null) return '';
    if (days <= 0) return 'today';
    if (days === 1) return '1 day';
    return days + ' days';
  }
  function hoursLabel(h) {
    if (h == null) return '—';
    if (h < 1) return '<1h';
    if (h < 48) return Math.round(h) + 'h';
    return (Math.round(h / 24 * 10) / 10) + 'd';
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function initials(s) { return String(s || '?').split(/[\s@.]+/).filter(Boolean).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function platformLabel(k) { var p = PLATFORMS.filter(function (x) { return x.key === k; })[0]; return p ? p.label : 'Other'; }
  /** A reply box shows its whole reply: rows from the text (an attribute,
   *  not a style), and field-sizing where the browser has it. */
  function fit(ta) {
    if (!ta) return;
    var per = Math.max(24, Math.floor((ta.clientWidth || 320) / 8.6));
    var lines = String(ta.value).split('\n').reduce(function (n, l) { return n + Math.max(1, Math.ceil(l.length / per)); }, 0);
    ta.rows = Math.max(5, Math.min(22, lines + 1));
  }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast((what || 'Copied') + ' — paste it where the review is.'); }, function () { toast('Select the text and copy it.'); });
  }

  function confetti() {
    var box = $('#confetti');
    if (reducedMotion() || !box) return;
    var h = '';
    for (var i = 0; i < 36; i++) h += '<i class="x' + (i % 12) + ' c' + (i % 6) + ' d' + ((i * 5) % 9) + '"></i>';
    box.innerHTML = h;
    setTimeout(function () { box.innerHTML = ''; }, 2600);
  }

  function svg(d) { return '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + d.replace(/(\.\d)00/g, '$1') + '</svg>'; }
  var ICON = {
    back: svg('<path d="m14.5 6-6 6 6 6"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5.5 15V6a1.5 1.5 0 0 1 1.5-1.5h9"/>'),
    spark: svg('<path d="M11 4.5 12.6 9l4.4 1.5-4.4 1.5L11 16.5 9.4 12 5 10.500 9.400 9z"/><path d="M18 15.500l.7 1.800 1.800.7-1.800.7-.7 1.800-.7-1.800-1.800-.7 1.800-.7z"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    ok: svg('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>'),
    warn: svg('<path d="M12 4.500 20.500 19h-17z"/><path d="M12 10v4M12 16.500v.2"/>'),
    stop: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.500v5.500M12 16v.2"/>'),
    tip: svg('<path d="M9.5 18h5M10 20.500h4"/><path d="M8.500 14.500a5.500 5.500 0 1 1 7 0c-.6.5-1 1.200-1 2h-5c0-.8-.4-1.500-1-2Z"/>'),
    info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.2"/>'),
    phone: svg('<path d="M6.5 4h3l1.500 4-2 1.500a11 11 0 0 0 5.500 5.500l1.500-2 4 1.500v3a1.500 1.500 0 0 1-1.500 1.500A14.500 14.500 0 0 1 5 5.500 1.500 1.500 0 0 1 6.500 4Z"/>'),
    lock: svg('<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.500 10.500V8a3.500 3.500 0 0 1 7 0v2.500"/>'),
    camera: svg('<path d="M4.500 8.500h3l1.500-2h6l1.500 2h3v10h-15z"/><circle cx="12" cy="13" r="3"/>'),
    inbox: svg('<path d="M3.5 13.5h4.6l1.4 2.5h5l1.4-2.5h4.6"/><path d="M5.6 5.5h12.8l2.1 8v4.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-4.5z"/>'),
    heart: svg('<path d="M12 19.5s-7.5-4.4-7.5-10A4.200 4.200 0 0 1 12 7a4.200 4.200 0 0 1 7.500 2.500c0 5.600-7.500 10-7.500 10Z"/>'),
    cool: svg('<path d="M12 3v18M4.2 7.5l15.600 9M19.800 7.500l-15.600 9"/><path d="M9.500 4.500 12 7l2.500-2.500M9.500 19.500 12 17l2.500 2.500"/>'),
    chart: svg('<path d="M4 19.500h16"/><path d="M7 16v-5M12 16V6.500M17 16v-8"/>'),
    paste: svg('<rect x="6" y="5" width="12" height="15" rx="2"/><path d="M9.500 5V4h5v1M9 10.500h6M9 14h6"/>'),
    target: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".6"/>'),
    star: svg('<path d="m12 3.800 2.500 5.200 5.700.800-4.100 4 1 5.700-5.100-2.700-5.100 2.700 1-5.700-4.100-4 5.700-.800z"/>'),
    arrow: svg('<path d="M5 12h14M13.500 6.500 19 12l-5.500 5.500"/>'),
    close: svg('<path d="m7 7 10 10M17 7 7 17"/>'),
  };

  /** A horizontal bar, 0-100. The width is an SVG attribute. */
  function meter(pct, cls) {
    var p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    return '<svg class="meter' + (cls ? ' ' + cls : '') + '" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="6"/><rect class="fill" width="' + p + '" height="6"/></svg>';
  }

  /* ---------------- data ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function signedIn() { return state.me && state.me.signedIn; }
  function settings() { return (state.me && state.me.settings) || {}; }
  function loadDemo() {
    if (state.demo) return Promise.resolve(state.demo);
    return api('GET', 'api/demo').then(function (d) { state.demo = d; return d; });
  }
  function demoReview(d, id) { return d.reviews.filter(function (r) { return r.id === id; })[0]; }
  // Passkeys are bound to the shared domain; on a staging *.run.app host they
  // cannot work, so the buttons are not offered there.
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function needAccount(msg) { openAccount(msg || 'Sign up free to answer your own reviews — the sample is read-only.'); }

  function drawTop() {
    var el = $('#topRight');
    var me = state.me;
    if (!me || !me.signedIn) {
      el.innerHTML = '<button class="btn small ghost" id="signInTop" type="button">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var b = me.budget || {};
    el.innerHTML =
      '<span class="credit" title="AI credit left">' + (b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '<span class="vh"> of AI credit left</span></span>' +
      '<button class="avatar-btn" id="acctBtn" type="button" aria-label="Account and your voice"><span>' + esc(initials(settings().businessName || settings().ownerName || me.email)) + '</span></button>';
    $('#acctBtn').onclick = function () { openAccount(); };
  }

  function setInboxDot(n) { var d = $('#inboxDot'); if (d) d.hidden = !n; }

  /* ---------------- sheets ---------------- */

  function sheet(html, onMount) {
    closeSheet();
    var scrim = document.createElement('div');
    scrim.className = 'scrim'; scrim.id = 'scrim';
    scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-label="Dialog"></div>';
    var root = scrim.firstChild;
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
    document.body.appendChild(scrim);
    document.body.classList.add('sheet-open');
    fill(root, html);
    if (onMount) onMount(root);
    var f = root.querySelector('input, textarea');
    if (f) setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 50);
    return root;
  }
  /** A sheet's contents, under its grabber and close button. */
  function fill(root, html) {
    root.innerHTML = '<button class="sheet-close" type="button" aria-label="Close">' + ICON.close + '</button><div class="grab"></div>' + html;
    $('.sheet-close', root).onclick = closeSheet;
  }
  function closeSheet() { var s = $('#scrim'); if (s) s.remove(); document.body.classList.remove('sheet-open'); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function openAccount(reason) {
    if (signedIn()) return openProfileSheet();
    var mode = 'register';
    function draw(root) {
      fill(root,
        '<h2>' + (mode === 'register' ? 'Every review, answered well.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Free account with $2 of AI credit — a set of drafted replies costs well under a cent. Templates, the reply checklist and the heat gauge are free forever. One account works across every app on this site.'
          : 'Same account as the other apps on this site.')) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block mt16" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button>' +
        '</form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button">Sign in with Face ID or a passkey</button>' : '') +
        '<p class="center small muted mt16 mb0">' +
        (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') +
        '</p>');
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
      if (!settings().setUp) {
        location.hash = '#/settings';
        toast('First, your voice — 30 seconds, and every reply sounds like you.', 3800);
      } else {
        toast('You’re in.');
      }
      route();
    });
  }

  function openProfileSheet() {
    var me = state.me;
    var b = me.budget || {};
    var remaining = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    var pct = b.unlimited ? 100 : Math.max(0, Math.min(100, (b.remainingUsd / (b.allowanceUsd || 1)) * 100));
    sheet(
      '<h2>' + esc(settings().businessName || 'Your account') + '</h2>' +
      '<p class="muted small">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'Member model (Sonnet)' : 'Free model (Haiku)') + '</p>' +
      '<div class="account-credit"><div class="row between"><b>AI credit</b><span class="num">' + esc(remaining) + '</span></div>' + meter(pct) +
      '<p class="cap muted mt12 mb0">A set of replies in your voice or a cool-down costs well under a cent; a screenshot about a cent. Templates, the checklist, the heat gauge and your scoreboard are free.</p>' +
      '<div id="billing" class="mt12"></div></div>' +
      '<a class="btn block" href="#/settings" id="voiceLink">Your voice</a>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button">Sign out</button>',
      function (root) {
        $('#voiceLink', root).onclick = function () { closeSheet(); };
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); setInboxDot(0); location.hash = '#/'; route(); });
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
        el.innerHTML = '<button class="btn small soft" id="joinM" type="button">Become a member · $' + esc(b.monthlyUsd) + '/mo</button>' +
          '<p class="cap muted mt8 mb0">Membership covers every app on this site, runs the better model, and lets you add credit.</p>';
        $('#joinM', el).onclick = function () { checkout('api/auth/billing/membership', {}); };
        return;
      }
      el.innerHTML = '<div class="row wrap-row">' + (b.topUps || []).map(function (t) {
        return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>';
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
      '<p class="muted small">Replying still works: every review has a free template in your tone, the checklist and the heat gauge cost nothing, and so does marking replies and your scoreboard.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- routing ---------------- */

  function route() {
    closeSheet();
    if (state.flush) { state.flush(); state.flush = null; }
    if (PUB) return renderShared(PUB[1]);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var tab = parts[0] || 'inbox';
    if (tab === 'sample') tab = 'inbox';
    var owner = { review: 'inbox' };
    $$('[data-tab]').forEach(function (b) {
      if (b.dataset.tab === (owner[tab] || tab)) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    view.className = 'wrap';
    window.scrollTo(0, 0);
    if (tab === 'review' && parts[1]) return renderReview(decodeURIComponent(parts[1]));
    if (tab === 'add') return renderAdd();
    if (tab === 'cool') return renderCool(parts[1] ? decodeURIComponent(parts[1]) : null);
    if (tab === 'scores') return renderScores();
    if (tab === 'wall') return renderWall();
    if (tab === 'settings') return renderSettings();
    return signedIn() ? renderInbox() : renderHome();
  }
  $$('[data-tab]').forEach(function (b) {
    b.onclick = function () {
      var to = '#/' + (b.dataset.tab === 'inbox' ? '' : b.dataset.tab);
      if (location.hash === to || (to === '#/' && !location.hash)) route(); else location.hash = to;
    };
  });
  window.addEventListener('hashchange', route);

  function show(html, cls) {
    view.className = 'wrap view-in' + (cls ? ' ' + cls : '');
    view.innerHTML = html;
    wireSignup(view);
  }
  function loading() { view.innerHTML = '<div class="loading"><span class="spinner" role="status" aria-label="Loading"></span></div>'; }
  function backLink(href, label) { return '<a class="back" href="' + href + '">' + ICON.back + esc(label) + '</a>'; }
  function sampleBar(what) {
    return '<div class="strip"><p><b>Sample.</b> ' + esc(what || 'Juniper & Rye, an invented café — real rules, no AI used.') + '</p>' +
      '<button class="btn small" type="button" data-signup>Sign up free</button></div>';
  }
  function wireSignup(root) { $$('[data-signup]', root).forEach(function (b) { b.onclick = function () { openAccount(); }; }); }
  function empty(icon, title, body, action) {
    return '<div class="empty">' + icon + '<h2>' + esc(title) + '</h2><p>' + body + '</p>' + (action || '') + '</div>';
  }
  function pitch(icon, title, body) {
    show(empty(icon, title, esc(body), '<div class="choices"><button class="btn" type="button" data-signup>Start free</button><a class="btn ghost" href="#/">See the sample</a></div>'), 'narrow');
  }

  /* ---------------- pieces ---------------- */

  function starsHtml(n, big) {
    var h = '<span class="stars' + (big ? ' big' : '') + '" role="img" aria-label="' + n + ' out of 5 stars">';
    for (var i = 1; i <= 5; i++) h += '<span class="' + (i <= n ? '' : 'off') + '" aria-hidden="true">★</span>';
    return h + '</span>';
  }
  function avatar(name) { return '<span class="avatar" aria-hidden="true">' + esc(initials(name) || '?') + '</span>'; }
  function urgChip(u) { return '<span class="urg u-' + esc(u) + '">' + esc(URG[u] || u) + '</span>'; }
  function topicTag(k, cls) { return '<span class="tag ' + cls + '">' + esc(RR.topicInfo(k).label) + '</span>'; }
  function topicTags(t, max) {
    var out = [];
    (t.complaints || []).forEach(function (k) { out.push(topicTag(k, 'sting')); });
    (t.praise || []).forEach(function (k) { out.push(topicTag(k, 'praise')); });
    return out.slice(0, max || 8).join('');
  }

  function reviewRow(r) {
    var t = r.triage || {};
    var sub = platformLabel(r.platform) + ' · ' + fmtDay(r.date) + (r.status === 'waiting' ? ' · waiting ' + ago(r.waitingDays) : ' · replied ' + fmtDay(r.repliedDay));
    return '<a class="rrow' + (r.status === 'replied' ? ' done' : '') + '" href="#/review/' + encodeURIComponent(r.id) + '">' +
      '<div class="head">' + avatar(r.displayName) + '<div class="grow"><div class="who ellip">' + esc(r.displayName) + '</div><div class="meta ellip">' + esc(sub) + '</div></div>' + starsHtml(r.stars) + '</div>' +
      (r.excerpt || r.text ? '<p class="quote">' + esc(r.excerpt || r.text) + '</p>' : '<p class="quote faint">A star rating with no words.</p>') +
      '<div class="foot"><div class="tags">' + (t.risk && t.risk.flag ? '<span class="tag risk">' + esc(t.risk.reasons.map(function (k) { return RR.riskInfo(k).label; }).join(', ')) + '</span>' : '') + topicTags(t, 3) + '</div>' +
      '<div class="tags">' + (r.hasDraft && r.status === 'waiting' ? '<span class="draft-flag">Draft saved</span>' : '') + (r.favourite ? '<span class="tag">On your wall</span>' : '') + (r.urgency === 'low' ? '' : urgChip(r.urgency)) + '</div></div>' +
      '</a>';
  }

  /** The heat gauge: a number, its word, and a bar. Measured by rules.js. */
  function gauge(h, id, small) {
    return '<div class="gauge lv-' + esc(h.level) + (small ? ' small' : '') + '"' + (id ? ' id="' + id + '"' : '') + ' role="img" aria-label="Heat ' + h.score + ' degrees, ' + esc(LEVEL[h.level]) + '">' +
      '<div class="read"><b>' + h.score + '°</b><span>' + esc(LEVEL[h.level]) + '</span></div>' + meter(Math.max(3, h.score)) + '</div>';
  }
  function setGauge(el, h) {
    if (!el) return;
    el.className = 'gauge lv-' + h.level + (el.classList.contains('small') ? ' small' : '');
    el.setAttribute('aria-label', 'Heat ' + h.score + ' degrees, ' + LEVEL[h.level]);
    $('.fill', el).setAttribute('width', String(Math.max(3, Math.min(100, h.score))));
    $('b', el).textContent = h.score + '°';
    $('.read span', el).textContent = LEVEL[h.level];
  }
  function flagsHtml(h) {
    if (!h.flags.length) return '<span class="cap muted">Nothing heating it up.</span>';
    return h.flags.map(function (f) { return '<span class="tag sting">' + esc(f.label) + '</span>'; }).join('');
  }

  function lintHtml(res) {
    var head = '<div class="lint-head">' + gauge(res.heat, null, true) + '<span class="words">' + plural(res.words, 'word') + '</span></div>';
    var items = res.issues.map(function (x) {
      var ic = x.level === 'error' ? ICON.stop : x.level === 'warn' ? ICON.warn : ICON.tip;
      return '<li class="' + esc(x.level) + '">' + ic + '<div><b>' + esc(x.label) + '</b><span>' + esc(x.detail) + '</span></div></li>';
    });
    if (res.ok) items.unshift('<li class="ok">' + ICON.ok + '<div><b>Good to post</b><span>No red flags — not too long, not copy-pasted, nothing private, not arguing.</span></div></li>');
    return head + '<ul class="lint" aria-label="Reply checklist">' + items.join('') + '</ul>';
  }
  /** One line for an option: does the checklist pass? */
  function lintStatus(res) {
    if (!res) return '';
    var n = res.issues.filter(function (x) { return x.level !== 'tip'; }).length;
    return res.ok ? '<span class="status">' + ICON.ok + 'Good to post</span>' : '<span class="status warn">' + ICON.warn + plural(n, 'thing') + ' to check</span>';
  }
  /** What the server left out, and why - in its words. */
  function leftOut(dropped, noun) {
    if (!dropped || !dropped.length) return '';
    var whys = [];
    dropped.forEach(function (d) { if (d.why && whys.indexOf(d.why) < 0) whys.push(d.why); });
    return '<p class="left-out">' + plural(dropped.length, noun) + ' left out: ' + esc(whys.join('; ')) + '.</p>';
  }

  function celebrateBadges(list) {
    if (!list || !list.length) return;
    confetti();
    toast('Badge earned: ' + list.map(function (b) { return b.label; }).join(', '), 3600);
  }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    loadDemo().then(function (d) {
      var cd = d.cooldown;
      var waiting = d.reviews.filter(function (r) { return r.status === 'waiting'; });
      show(
        '<section class="hero hero-wrap"><h1>Answer every review like a pro. <em>Even the ones that sting.</em></h1>' +
        '<p class="lede">Replies in your voice, and a cool-down for the one you shouldn’t send.</p>' +
        '<div class="choices"><button class="btn big" type="button" id="heroGo">Start free</button><a class="btn big ghost" href="#/sample" id="heroSample">See the sample</a></div>' +
        '<p class="privacy">$2 of AI credit free. Templates and the checklist are always free. You post every reply yourself — Rave never touches your Google or Yelp account.</p></section>' +
        '<div id="sample">' + sampleBar() + '</div>' +
        '<div class="split lean"><div>' +
        '<div class="sec-head"><h2>Inbox</h2><span class="sub">' + esc(d.settings.businessName) + ' · ' + waiting.length + ' waiting · ' + d.scoreboard.responseRate + '% answered</span></div>' +
        '<div class="rows">' + d.reviews.slice(0, 6).map(reviewRow).join('') + '</div>' +
        '</div><div class="aside">' +
        '<section class="section first"><p class="eyebrow">Cool down</p><h2>Type the reply you want to send.</h2><p class="muted small">Rave hands back the one you’ll be glad you posted, keeps your actual points, and shows what it took out.</p>' +
        '<div class="duo mt16"><div><span class="cap">Ana’s draft</span>' + gauge(cd.heatBefore) + '</div><div class="arrow" aria-hidden="true">' + ICON.arrow + '</div><div><span class="cap">Posted</span>' + gauge(cd.heatAfter) + '</div></div>' +
        '<a class="btn soft block mt16" href="#/cool">See how it cooled</a></section>' +
        '<section class="section"><ul class="how">' +
        '<li>' + ICON.chart + '<div><b><a href="#/scores">Scoreboard</a></b><p>Response rate, time to reply, the rating trend and what people love most.</p></div></li>' +
        '<li>' + ICON.heart + '<div><b><a href="#/wall">Wall of love</a></b><p>Your best reviews on one page, for your own website.</p></div></li></ul></section>' +
        '</div></div>' +
        '<section class="section ruled"><h2>How it works</h2><ul class="how">' +
        '<li>' + ICON.paste + '<div><b>Paste or snap it</b><p>Paste a review or drop in a screenshot — Rave reads the stars, the name and the words. The screenshot is never kept.</p></div></li>' +
        '<li>' + ICON.target + '<div><b>Know what matters</b><p>Topics, sentiment and a flag for anything about health, safety or the law — the ones to handle offline.</p></div></li>' +
        '<li>' + ICON.cool + '<div><b>Reply without regret</b><p>Two or three drafts in your voice, checked so none invents an offer or a fact, and a cool-down for the ones that sting.</p></div></li>' +
        '</ul></section>' +
        '<section class="section ruled center"><h2>Every review, answered.</h2><p class="muted">Replying helps your rating, and it takes a minute.</p><button class="btn" type="button" data-signup>Sign up free</button></section>');
      $('#heroGo').onclick = function () { openAccount(); };
      $('#heroSample').onclick = function (e) { e.preventDefault(); $('#sample').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' }); };
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- inbox ---------------- */

  var inboxFilter = 'todo';
  function renderInbox() {
    loading();
    api('GET', 'api/reviews').then(function (r) {
      var all = r.reviews;
      setInboxDot(r.counts.urgent);
      var F = {
        todo: { label: 'To reply', f: function (x) { return x.status === 'waiting'; } },
        urgent: { label: 'Urgent', f: function (x) { return x.urgency === 'urgent' || x.urgency === 'high'; } },
        replied: { label: 'Replied', f: function (x) { return x.status === 'replied'; } },
        fav: { label: 'Wall', f: function (x) { return x.favourite; } },
        all: { label: 'All', f: function () { return true; } },
      };
      function draw() {
        var rows = all.filter(F[inboxFilter].f);
        var s = r.streak;
        var sub = all.length ? r.counts.waiting + ' waiting' + (r.counts.urgent ? ' · ' + r.counts.urgent + ' urgent' : '') : 'Nothing here yet';
        var h = '<div class="page-head"><div><h1>Inbox</h1><div class="sub">' + esc(sub) + '</div></div>' +
          (s.current ? '<a class="streak" href="#/scores" title="Days in a row at inbox zero">' + plural(s.current, 'day') + ' at zero' + (s.atRisk ? ' · reply today' : '') + '</a>' : '<a class="btn small soft" href="#/add">Add a review</a>') + '</div>';
        if (!settings().setUp) h += '<a class="note" href="#/settings">' + ICON.info + '<span class="grow"><b>Set up your voice.</b> Your name, sign-off, tone and how unhappy customers reach you — every reply uses them.</span></a>';
        h += '<div class="chips" role="group" aria-label="Filter">' + Object.keys(F).map(function (k) {
          var n = all.filter(F[k].f).length;
          return '<button class="chip" type="button" data-f="' + k + '" aria-pressed="' + (inboxFilter === k) + '">' + esc(F[k].label) + (k !== 'all' ? ' · ' + n : '') + '</button>';
        }).join('') + '</div>';
        if (rows.length) {
          h += '<div class="rows">' + rows.map(reviewRow).join('') + '</div>';
        } else if (!all.length) {
          h += empty(ICON.inbox, 'Add your first review', 'Paste one in or drop a screenshot. Start with the one you’ve been avoiding.', '<a class="btn" href="#/add">Add a review</a>');
        } else if (inboxFilter === 'todo') {
          h += empty(ICON.ok, 'Inbox zero', 'Every review answered.' + (s.current ? ' That’s ' + plural(s.current, 'day') + ' in a row.' : '') + ' New ones go in with <b>Add</b>.');
        } else {
          h += empty(ICON.inbox, 'Nothing here', 'Try another filter.');
        }
        show(h);
        $$('[data-f]').forEach(function (b) { b.onclick = function () { inboxFilter = b.dataset.f; draw(); }; });
      }
      draw();
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- one review ---------------- */

  function renderReview(id) {
    loading();
    if (!signedIn()) {
      return loadDemo().then(function (d) {
        var r = demoReview(d, id);
        if (!r) return pitch(ICON.lock, 'Sign in to see your reviews', 'Your inbox is yours alone — nobody else can open it.');
        drawReview(r, { demo: d });
      }).catch(function (e) { showError(e, view); });
    }
    api('GET', 'api/reviews/' + encodeURIComponent(id)).then(function (r) { drawReview(r, {}); }).catch(function (e) { showError(e, view); });
  }

  function triageHtml(r, demo) {
    var t = r.triage;
    var h = '<section class="section"><div class="sec-head"><h2>What they said</h2><span class="sub">' + (t.by === 'ai' ? 'Deeper read' : 'Quick read · free') + '</span></div>';
    h += '<div class="tags">' + urgChip(r.urgency === 'done' ? t.urgency : r.urgency) + '<span class="tag">' + esc(t.sentiment.charAt(0).toUpperCase() + t.sentiment.slice(1)) + '</span></div><div class="facts">';
    if (t.summary) h += '<p><b>In short:</b> ' + esc(t.summary) + '</p>';
    if (t.approach) h += '<p><b>How to answer:</b> ' + esc(t.approach) + '</p>';
    h += '<div class="pair"><div><p class="eyebrow">Stings</p><div class="tags">' + ((t.complaints || []).map(function (k) { return topicTag(k, 'sting'); }).join('') || '<span class="cap muted">Nothing</span>') + '</div></div>' +
      '<div><p class="eyebrow">Loved</p><div class="tags">' + ((t.praise || []).map(function (k) { return topicTag(k, 'praise'); }).join('') || '<span class="cap muted">Nothing specific</span>') + '</div></div></div></div>';
    if (t.by !== 'ai') {
      h += demo
        ? '<p class="honest">Signed in, “Deeper read” adds a one-line summary and advice on how to answer. About a tenth of a cent.</p>'
        : '<button class="btn small ghost mt16" type="button" id="deepBtn">' + ICON.spark + 'Deeper read</button>';
    }
    return h + '</section>';
  }

  function riskBanner(t) {
    if (!t.risk || !t.risk.flag) return '';
    var reasons = t.risk.reasons.map(function (k) { return RR.riskInfo(k); });
    return '<div class="note risk" role="note">' + ICON.phone + '<div><b>Handle this one offline — call them.</b>' +
      '<p>' + esc(reasons.map(function (x) { return x.label + ': ' + x.detail; }).join(' ')) + '</p>' +
      '<p class="muted">Keep the public reply short and sincere, give them a direct line, and don’t discuss details or admit fault in public. Then pick up the phone.</p></div></div>';
  }

  function drawReview(r, opts) {
    var demo = opts.demo || null;
    var s = demo ? demo.settings : settings();
    var d0 = demo ? demo.drafts[r.id] : null;
    var st = {
      text: demo ? (d0 ? d0.text : '') : (r.reply ? r.reply.text : ''),
      source: demo ? (d0 ? d0.source : 'template') : (r.reply ? r.reply.source : 'own'),
      note: '', variant: 1, busy: '', saved: true, timer: null,
      options: null, dropped: null, picked: -1,
    };
    var canWall = r.stars >= 4 && String(r.text || '').trim();
    var h = (demo ? sampleBar('A sample review. Nothing here can be changed.') : '') + backLink('#/', 'Inbox');
    h += riskBanner(r.triage);
    h += '<div class="split"><div>';
    h += '<div class="review-head">' + avatar(r.displayName) + '<div class="grow"><div class="who ellip">' + esc(r.displayName) + '</div><div class="cap muted">' + esc(platformLabel(r.platform)) + ' · ' + esc(fmtDay(r.date, { year: 'numeric' })) + (r.source === 'snap' ? ' · from a screenshot' : '') + '</div></div>' +
      (canWall ? '<button class="heart" type="button" id="favBtn" aria-pressed="' + Boolean(r.favourite) + '" aria-label="' + (r.favourite ? 'Remove from' : 'Add to') + ' wall of love">' + ICON.heart + '</button>' : '') + '</div>' +
      '<div class="mt12">' + starsHtml(r.stars, true) + '</div>' +
      (r.text ? '<p class="review-text">' + esc(r.text) + '</p>' : '<p class="review-text faint">A star rating with no words. It still deserves a thank-you.</p>');
    h += triageHtml(r, demo);
    h += '</div><div class="aside"><section class="composer" id="composer"></section></div></div>';
    if (!demo) h += '<div class="row wrap-row mt24"><button class="btn small ghost" type="button" id="editBtn">Edit review</button><button class="btn small danger" type="button" id="delBtn">Delete</button></div>';
    show(h);

    var box = $('#composer');
    function lintNow(text) {
      return RR.lint(text, { stars: r.stars, reviewer: r.reviewer || r.displayName, contactLine: s.contactLine, risk: r.triage.risk && r.triage.risk.flag, others: r.others || [] });
    }
    function optionsHtml() {
      if (!st.options) return '';
      return '<div class="options" id="optList"><div class="sec-head"><h3>' + plural(st.options.length, 'draft') + ' in your voice</h3><span class="sub">Pick one, then make it yours</span></div>' +
        st.options.map(function (o, i) {
          var on = i === st.picked;
          return '<div class="opt' + (on ? ' on' : '') + '"><div class="opt-head"><b>' + esc(o.label) + '</b>' + lintStatus(o.lint) + '</div>' +
            '<p class="opt-text">' + esc(o.text) + '</p>' + (o.note ? '<p class="opt-note">' + esc(o.note) + '</p>' : '') +
            (on ? '<p class="status mt12 mb0">' + ICON.check + 'In the box above — edit it there</p>' : '<button class="btn small soft" type="button" data-opt="' + i + '">Use this one</button>') + '</div>';
        }).join('') + leftOut(st.dropped, 'draft') +
        '<p class="honest">Each draft is checked against the review and your settings: one that adds a number, an offer, a promise or a personal detail you didn’t supply is never shown.</p></div>';
    }
    function drawComposer() {
      var replied = r.status === 'replied';
      var c = '<div class="sec-head"><h2>Your reply</h2><span class="save-state" id="saveState" aria-live="polite">' + (demo ? '' : st.saved ? (st.text ? 'Saved' : '') : 'Saving…') + '</span></div>';
      if (replied) {
        c += '<div class="note good">' + ICON.ok + '<span class="grow"><b>Replied ' + esc(fmtDay(r.repliedDay, { year: 'numeric' })) + '.</b>' + (r.replySource === 'cooled' ? ' Cooled down first.' : '') + '</span>' + (demo ? '' : '<button class="btn small ghost" type="button" id="undoBtn">Undo</button>') + '</div>';
      }
      c += '<textarea class="input" id="replyBox" aria-label="Your reply" placeholder="Write your reply, or tap a button below."' + (demo ? ' readonly' : '') + '>' + esc(st.text) + '</textarea>';
      if (demo) {
        c += '<p class="honest">' + (replied ? 'Ana’s posted reply, through the same checklist.' : 'Rave’s free template for this review — no AI used. Signed in, “Write it for me” drafts two or three from your voice and the review.') + '</p>';
      }
      c += '<div class="tool-row">' +
        '<button class="btn small" type="button" id="aiBtn"' + (st.busy === 'ai' ? ' disabled' : '') + '>' + (st.busy === 'ai' ? '<span class="spinner"></span>Writing…' : ICON.spark + (st.options ? 'Write new drafts' : 'Write it for me')) + '</button>' +
        '<button class="btn small ghost" type="button" id="tplBtn">' + (st.busy === 'tpl' ? '…' : 'Free template') + '</button>' +
        '<button class="btn small ghost" type="button" id="coolBtn">' + ICON.cool + 'Cool it down</button></div>';
      c += '<div id="compErr"></div>';
      c += optionsHtml();
      c += '<div id="lintBox" aria-live="polite"></div>';
      c += '<div class="btn-row end"><button class="btn ghost" type="button" id="copyBtn">' + ICON.copy + 'Copy</button>' +
        (replied ? '' : '<button class="btn" type="button" id="doneBtn">' + ICON.check + 'I posted it</button>') + '</div>';
      c += '<p class="honest">Rave never posts for you — no Google or Yelp login, no scraping. Copy the reply, paste it under the review on ' + esc(platformLabel(r.platform)) + ', then tap “I posted it”.</p>';
      box.innerHTML = c;
      drawLint();
      wireComposer();
      fit($('#replyBox', box));
    }
    function drawLint() { var el = $('#lintBox', box); if (el) el.innerHTML = lintHtml(lintNow(st.text)); }
    function setText(text, source, note) {
      st.text = text; st.source = source; st.note = note || '';
      drawComposer();
      save();
    }
    function save() {
      if (demo) return;
      clearTimeout(st.timer); st.timer = null;
      st.saved = false;
      var ss = $('#saveState', box); if (ss) ss.textContent = 'Saving…';
      return api('PUT', 'api/reviews/' + encodeURIComponent(r.id) + '/reply', { text: st.text, source: st.source })
        .then(function () { st.saved = true; var el = $('#saveState', box); if (el) el.textContent = st.text ? 'Saved' : ''; })
        .catch(function (e) { var el = $('#saveState', box); if (el) el.textContent = 'Not saved'; showError(e, $('#compErr', box)); });
    }
    state.flush = function () { if (st.timer) save(); };
    function wireComposer() {
      var ta = $('#replyBox', box);
      ta.oninput = function () {
        st.text = ta.value;
        fit(ta);
        if (st.source !== 'own' && !st.text.trim()) st.source = 'own';
        drawLint();
        if (demo) return;
        var ss = $('#saveState', box); if (ss) ss.textContent = 'Editing…';
        clearTimeout(st.timer);
        st.timer = setTimeout(save, 900);
      };
      $('#aiBtn', box).onclick = function () {
        if (demo) return needAccount('Sign up free and Rave drafts replies from your own voice — well under a cent for a set of three.');
        st.busy = 'ai'; drawComposer();
        api('POST', 'api/reviews/' + encodeURIComponent(r.id) + '/draft', { voiceSample: voiceSample() || undefined })
          .then(function (d) {
            st.busy = '';
            st.options = d.options && d.options.length ? d.options : [{ label: 'Draft', text: d.text, note: d.note, lint: d.lint }];
            st.dropped = d.dropped || [];
            st.picked = -1;
            loadMe();
            // An empty box takes the first draft straight away; words already
            // there are the owner's, and only their own tap replaces them.
            if (!st.text.trim()) { st.picked = 0; setText(st.options[0].text, 'ai', st.options[0].note); } else drawComposer();
            var list = $('#optList', box);
            if (list && window.innerWidth < 900) list.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
          })
          .catch(function (e) { st.busy = ''; drawComposer(); showError(e, $('#compErr', box)); });
      };
      $$('[data-opt]', box).forEach(function (b) {
        b.onclick = function () {
          var i = Number(b.dataset.opt);
          st.picked = i;
          setText(st.options[i].text, 'ai', st.options[i].note);
          var t = $('#replyBox', box);
          if (t && window.innerWidth < 900) t.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
        };
      });
      $('#tplBtn', box).onclick = function () {
        if (demo) return needAccount('Sign up free — templates in your own tone are free forever.');
        if (st.text.trim() && st.source !== 'template' && !confirm('Replace what is in the box with a template?')) return;
        st.busy = 'tpl'; drawComposer();
        api('POST', 'api/reviews/' + encodeURIComponent(r.id) + '/template', { variant: st.variant++ })
          .then(function (d) { st.busy = ''; st.picked = -1; setText(d.text, 'template'); })
          .catch(function (e) { st.busy = ''; drawComposer(); showError(e, $('#compErr', box)); });
      };
      $('#coolBtn', box).onclick = function () {
        if (demo) { location.hash = '#/cool'; return; }
        state.coolDraft = { text: st.text, reviewId: r.id };
        location.hash = '#/cool/' + encodeURIComponent(r.id);
      };
      $('#copyBtn', box).onclick = function () { if (!st.text.trim()) return toast('Nothing to copy yet.'); copy(st.text, 'Reply copied'); };
      var done = $('#doneBtn', box);
      if (done) done.onclick = function () {
        if (demo) return needAccount('Sign up free and every reply you post counts toward your streak.');
        var res = lintNow(st.text);
        if (st.text.trim() && res.issues.some(function (x) { return x.level === 'error'; }) && !confirm('The checklist found a problem. Mark it replied anyway?')) return;
        done.disabled = true;
        clearTimeout(st.timer); st.timer = null;
        api('POST', 'api/reviews/' + encodeURIComponent(r.id) + '/replied', { text: st.text, source: st.source })
          .then(function (x) {
            r = Object.assign(r, x);
            st.saved = true;
            drawComposer();
            if (x.waitingLeft === 0) { confetti(); toast('Inbox zero! Every review answered.', 3600); }
            else toast('Replied. ' + x.waitingLeft + ' to go.');
            celebrateBadges(x.newBadges);
          })
          .catch(function (e) { done.disabled = false; showError(e, $('#compErr', box)); });
      };
      var undo = $('#undoBtn', box);
      if (undo) undo.onclick = function () {
        api('POST', 'api/reviews/' + encodeURIComponent(r.id) + '/replied', { replied: false }).then(function (x) { r = Object.assign(r, x); drawComposer(); toast('Back in your inbox.'); }).catch(function (e) { showError(e); });
      };
    }
    drawComposer();

    var fav = $('#favBtn');
    if (fav) fav.onclick = function () {
      if (demo) return needAccount('Sign up free to build your own wall of love.');
      api('POST', 'api/reviews/' + encodeURIComponent(r.id) + '/favourite', { favourite: !r.favourite }).then(function (x) {
        r.favourite = x.favourite;
        fav.setAttribute('aria-pressed', String(r.favourite));
        fav.setAttribute('aria-label', (r.favourite ? 'Remove from' : 'Add to') + ' wall of love');
        toast(r.favourite ? 'On your wall of love. Publish it from the Wall tab.' : 'Taken off the wall.');
      }).catch(function (e) { showError(e); });
    };
    var deep = $('#deepBtn');
    if (deep) deep.onclick = function () {
      deep.disabled = true; deep.innerHTML = '<span class="spinner"></span>Reading…';
      api('POST', 'api/reviews/' + encodeURIComponent(r.id) + '/triage', {}).then(function (x) { loadMe(); drawReview(x, {}); })
        .catch(function (e) { deep.disabled = false; deep.innerHTML = ICON.spark + 'Deeper read'; showError(e); });
    };
    var ed = $('#editBtn'); if (ed) ed.onclick = function () { openEditReview(r); };
    var dl = $('#delBtn'); if (dl) dl.onclick = function () {
      if (!confirm('Delete this review from Rave? It stays on ' + platformLabel(r.platform) + ' — this only removes your copy.')) return;
      api('DELETE', 'api/reviews/' + encodeURIComponent(r.id)).then(function () { toast('Deleted.'); location.hash = '#/'; }).catch(function (e) { showError(e); });
    };
  }

  function platformPick(sel) {
    return '<div class="chips wrap-chips" role="group" aria-label="Where it was posted">' + PLATFORMS.map(function (p) {
      return '<button type="button" class="chip" data-plat="' + p.key + '" aria-pressed="' + (p.key === sel) + '">' + esc(p.label) + '</button>';
    }).join('') + '</div>';
  }
  function starPick(n) {
    var h = '<div class="star-pick" role="radiogroup" aria-label="Stars">';
    for (var i = 1; i <= 5; i++) h += '<button type="button" role="radio" aria-checked="' + (i === n) + '" aria-label="' + plural(i, 'star') + '" data-star="' + i + '" class="' + (i <= n ? 'on' : '') + '">★</button>';
    return h + '</div>';
  }
  function wirePickers(root, st) {
    $$('[data-star]', root).forEach(function (b) {
      b.onclick = function () {
        st.stars = Number(b.dataset.star);
        $$('[data-star]', root).forEach(function (x) { var n = Number(x.dataset.star); x.classList.toggle('on', n <= st.stars); x.setAttribute('aria-checked', String(n === st.stars)); });
      };
    });
    $$('[data-plat]', root).forEach(function (b) {
      b.onclick = function () {
        st.platform = b.dataset.plat;
        $$('[data-plat]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      };
    });
  }
  function reviewFields(p, ids) {
    return '<span class="label">Stars</span>' + starPick(p.stars || 0) +
      '<span class="label">Posted on</span>' + platformPick(p.platform || 'google') +
      '<label class="field mt16"><span>Reviewer</span><input class="input" id="' + ids + 'Who" placeholder="Name as shown" maxlength="80" value="' + esc(p.reviewer || '') + '"></label>' +
      '<label class="field"><span>Date posted</span><input class="input" id="' + ids + 'Date" type="date" max="' + localToday() + '" value="' + esc(p.date || localToday()) + '"></label>' +
      '<label class="field"><span>The review</span><textarea class="input" id="' + ids + 'Text" maxlength="5000" rows="6" placeholder="Paste the review here">' + esc(p.text || '') + '</textarea>' +
      '<small>No words, just stars? Leave it empty — a rating-only review still deserves a thank-you.</small></label>';
  }

  function openEditReview(r) {
    var st = { stars: r.stars, platform: r.platform };
    sheet('<h2>Edit review</h2><p class="small muted">Fix a typo from pasting — this is your copy, not the one on ' + esc(platformLabel(r.platform)) + '.</p>' +
      reviewFields(r, 'e') + '<div id="eErr"></div><button class="btn block mt16" type="button" id="eSave">Save</button>',
      function (root) {
        wirePickers(root, st);
        $('#eSave', root).onclick = function () {
          api('PUT', 'api/reviews/' + encodeURIComponent(r.id), { stars: st.stars, platform: st.platform, reviewer: $('#eWho', root).value, date: $('#eDate', root).value, text: $('#eText', root).value })
            .then(function (x) { closeSheet(); toast('Saved.'); drawReview(x, {}); })
            .catch(function (e) { showError(e, $('#eErr', root)); });
        };
      });
  }

  /* ---------------- add / snap ---------------- */

  function renderAdd() {
    if (!signedIn()) return pitch(ICON.paste, 'Paste a review, or drop a screenshot', 'Rave reads the stars, the name and the words from a screenshot — it is read once and never kept.');
    var p = state.snapped || {};
    var st = { stars: p.stars || 0, platform: p.platform || 'google' };
    show(
      '<div class="page-head"><div><h1>Add a review</h1><div class="sub">Paste it in, or let Rave read a screenshot.</div></div></div>' +
      '<label class="snap" id="snapCard">' + ICON.camera + '<span class="grow"><b>Drop in a screenshot</b><span>Of the review on Google, Yelp or anywhere — Rave fills in the rest. About a cent of AI credit; the image is never stored.</span></span>' +
      '<input type="file" id="snapIn" accept="image/*" aria-label="Choose a screenshot of the review"></label>' +
      '<div id="snapState" class="mt12"></div>' +
      '<div class="or">or paste it in</div>' +
      reviewFields(p, 'a') +
      '<div id="aErr"></div><button class="btn block big mt16" type="button" id="aSave">Add to my inbox</button>', 'narrow');
    if (state.snapped) {
      $('#snapState').innerHTML = '<div class="note">' + ICON.spark + '<span>Read from your screenshot' + (p.dateGuessed ? ' — the date wasn’t clear' + (p.dateText ? ' (“' + esc(p.dateText) + '”)' : '') + ', so check it' : '') + '. Check the rest, then add it. The image wasn’t kept.</span></div>';
    }
    wirePickers(view, st);
    $('#snapIn').onchange = function (e) { var f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) snap(f); };
    $('#aSave').onclick = function () {
      if (!st.stars) { showError(new Error('How many stars? Tap one above.'), $('#aErr')); return; }
      var btn = this; btn.disabled = true;
      api('POST', 'api/reviews', { stars: st.stars, platform: st.platform, reviewer: $('#aWho').value, date: $('#aDate').value, text: $('#aText').value, source: state.snapped ? 'snap' : 'paste' })
        .then(function (r) {
          state.snapped = null;
          toast(r.triage.risk.flag ? 'Added — flagged to handle offline.' : 'Added. Let’s answer it.', 3000);
          location.hash = '#/review/' + encodeURIComponent(r.id);
        }).catch(function (e) { btn.disabled = false; showError(e, $('#aErr')); });
    };
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
    var box = $('#snapState');
    box.innerHTML = '<div class="note"><span class="spinner"></span>Reading your screenshot…</div>';
    shrink(file).then(function (image) {
      return api('POST', 'api/reviews/read', { image: image });
    }).then(function (p) {
      state.snapped = p;
      loadMe();
      renderAdd();
    }).catch(function (e) {
      if (e.status === 402) { box.innerHTML = ''; return openCreditSheet(e.data); }
      box.innerHTML = '<div class="note warn">' + ICON.warn + '<span>' + esc(e.message) + '</span></div>';
    });
  }

  /* ---------------- cool down ---------------- */

  function renderCool(reviewId) {
    loading();
    var pre = state.coolDraft;
    state.coolDraft = null;
    var get = signedIn()
      ? api('GET', 'api/reviews').then(function (r) { return { reviews: r.reviews }; })
      : loadDemo().then(function (d) { return { demo: d, reviews: d.reviews }; });
    get.then(function (ctx) {
      var demo = ctx.demo || null;
      var s = demo ? demo.settings : settings();
      var options = ctx.reviews.filter(function (x) { return x.status === 'waiting' || x.id === reviewId; });
      var st = { reviewId: reviewId || (demo ? demo.cooldown.reviewId : ''), text: pre && pre.text ? pre.text : '', result: null, pick: 0 };
      function reviewOf(id) { return ctx.reviews.filter(function (y) { return y.id === id; })[0]; }
      function reviewer() { var x = reviewOf(st.reviewId); return x ? (x.reviewer || x.displayName) : ''; }
      function heatNow(text) { return RR.heat(text, { reviewer: reviewer(), contactLine: s.contactLine }); }

      show((demo ? sampleBar('The heat gauge is free and runs on your phone — try it. Cooling down needs an account.') : '') +
        '<div class="page-head"><div><h1>Cool down</h1><div class="sub">Type the reply you want to send. Get back the one you’ll be glad you posted.</div></div></div>' +
        '<div class="split"><div>' +
        '<label class="field"><span>Replying to</span><select class="input" id="coolFor"><option value="">No particular review</option>' +
        options.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === st.reviewId ? ' selected' : '') + '>' + esc(x.displayName + ' · ' + x.stars + '★ · ' + String(x.excerpt || x.text || '').slice(0, 40)) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field vent"><span>What you really want to say</span><textarea class="input" id="ventBox" maxlength="3000" rows="6" placeholder="Go on. Nobody sees this but you.">' + esc(st.text) + '</textarea></label>' +
        gauge(heatNow(st.text), 'liveGauge') +
        '<div class="tags mt12" id="liveFlags" aria-live="polite"></div>' +
        '<div class="btn-row end"><button class="btn big" type="button" id="coolGo">' + ICON.cool + 'Cool it down</button>' + (demo ? '<button class="btn big ghost" type="button" id="exampleBtn">See Ana’s example</button>' : '') + '</div>' +
        '<div id="coolErr"></div>' +
        '<p class="honest">What you type here is never saved — only the calm version, and only if you use it. The gauge runs on your device; cooling it down is one AI call (well under a cent).</p>' +
        '</div><div class="aside" id="coolOut"></div></div>');
      var ta = $('#ventBox');
      function live() {
        var ht = heatNow(ta.value);
        setGauge($('#liveGauge'), ht);
        $('#liveFlags').innerHTML = ta.value.trim() ? flagsHtml(ht) : '';
      }
      ta.oninput = function () { st.text = ta.value; fit(ta); live(); };
      $('#coolFor').onchange = function () { st.reviewId = this.value; live(); };
      live(); fit(ta);
      var out = $('#coolOut');

      function showResult(res, animate) {
        st.result = res;
        st.pick = 0;
        var opts = res.options && res.options.length ? res.options : [{ label: 'Calm', calm: res.calm, kept: [], heatAfter: res.heatAfter, lint: res.lint }];
        var rv = reviewOf(res.reviewId) || {};
        out.innerHTML =
          '<section class="section first" id="cooled"><div class="sec-head"><h2>The one to post</h2><span class="sub">' + (demo ? 'Ana’s, sample' : plural(opts.length, 'version')) + '</span></div>' +
          (opts.length > 1 ? '<div class="seg" role="group" aria-label="Versions">' + opts.map(function (o, i) { return '<button type="button" data-ver="' + i + '" aria-pressed="' + (i === 0) + '">' + esc(o.label) + '</button>'; }).join('') + '</div>' : '') +
          '<div class="duo mt16"><div><span class="cap">Your draft</span>' + gauge(res.heatBefore) + '</div><div class="arrow" aria-hidden="true">' + ICON.arrow + '</div><div><span class="cap">This version</span>' + gauge(animate ? res.heatBefore : opts[0].heatAfter, 'afterGauge') + '</div></div>' +
          '<p class="cap muted mt8" id="dropLine"></p>' +
          '<label class="field mt16"><span class="vh">The calm reply — edit it if you like</span><textarea class="input" id="calmBox"' + (demo ? ' readonly' : '') + '></textarea></label>' +
          '<div class="btn-row"><button class="btn ghost" type="button" id="calmCopy">' + ICON.copy + 'Copy</button>' + (res.reviewId ? '<button class="btn" type="button" id="calmUse">Use as my reply</button>' : '') + '</div>' +
          leftOut(res.dropped, 'version') +
          '<div id="keptBox"></div>' +
          (res.removed.length ? '<div class="sec-head mt24"><h3>What came out</h3><span class="sub">' + res.removed.length + '</span></div><ul class="removed">' + res.removed.map(function (x) {
            var k = RR.kindInfo(x.kind);
            return '<li><b>' + esc(k.label) + '</b>' + (x.quote ? '<s>' + esc(x.quote) + '</s>' : '') + (x.why ? '<span>' + esc(x.why) + '</span>' : '') + '</li>';
          }).join('') + '</ul>' : '') +
          '<div id="calmLint"></div>' +
          '<p class="honest">You edit it and post it yourself. Each version is checked against your draft: one that adds an offer, a number, a threat or a personal detail you didn’t write is never shown.</p></section>';
        var cb = $('#calmBox');
        function calmLint() { $('#calmLint').innerHTML = lintHtml(RR.lint(cb.value, { stars: rv.stars, reviewer: reviewer(), contactLine: s.contactLine, others: [] })); }
        function pick(i, first) {
          st.pick = i;
          var o = opts[i];
          $$('[data-ver]', out).forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.ver) === i)); });
          cb.value = o.calm;
          fit(cb);
          var down = res.heatBefore.score - o.heatAfter.score;
          $('#dropLine').textContent = down > 0 ? 'Down ' + down + '°, from ' + LEVEL[res.heatBefore.level].toLowerCase() + ' to ' + LEVEL[o.heatAfter.level].toLowerCase() + '.' : 'Already cool — lightly polished.';
          $('#keptBox').innerHTML = o.kept && o.kept.length
            ? '<div class="sec-head mt24"><h3>Your points, kept</h3><span class="sub">from your own words</span></div><ul class="kept">' + o.kept.map(function (k) { return '<li><b>' + esc(k.point) + '</b><q>' + esc(k.quote) + '</q></li>'; }).join('') + '</ul>'
            : '<p class="cap muted mt16">This version makes none of your draft’s points — it only apologises and takes it offline.</p>';
          if (!(first && animate)) setGauge($('#afterGauge'), o.heatAfter);
          calmLint();
        }
        $$('[data-ver]', out).forEach(function (b) { b.onclick = function () { pick(Number(b.dataset.ver)); }; });
        cb.oninput = function () { fit(cb); calmLint(); };
        pick(0, true);
        $('#calmCopy').onclick = function () { copy(cb.value, 'Calm reply copied'); };
        var use = $('#calmUse');
        if (use) use.onclick = function () {
          if (demo) return needAccount('Sign up free to cool down your own replies.');
          use.disabled = true;
          api('PUT', 'api/reviews/' + encodeURIComponent(res.reviewId) + '/reply', { text: cb.value, source: 'cooled' })
            .then(function () { toast('Saved as your reply. Cool head.'); location.hash = '#/review/' + encodeURIComponent(res.reviewId); })
            .catch(function (e) { use.disabled = false; showError(e); });
        };
        if (animate) setTimeout(function () { setGauge($('#afterGauge'), opts[st.pick].heatAfter); }, reducedMotion() ? 0 : 350);
        if (animate && window.innerWidth < 900) out.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      }
      function sample() {
        var c = demo.cooldown;
        return { calm: c.calm, removed: c.removed, heatBefore: c.heatBefore, reviewId: c.reviewId, dropped: [], options: [{ angle: 'sample', label: 'Sample', calm: c.calm, kept: c.keptPoints || [], heatAfter: c.heatAfter, lint: c.lint }] };
      }

      $('#coolGo').onclick = function () {
        if (demo) return needAccount('Sign up free to cool down your own replies — the heat gauge stays free.');
        if (ta.value.trim().length < 10) { showError(new Error('Type the reply you want to send first — at least a sentence.'), $('#coolErr')); return; }
        var btn = this; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Cooling…';
        $('#coolErr').innerHTML = '';
        api('POST', 'api/cooldown', { text: ta.value, reviewId: st.reviewId || undefined, voiceSample: voiceSample() || undefined })
          .then(function (res) { btn.disabled = false; btn.innerHTML = ICON.cool + 'Cool it down again'; loadMe(); showResult(res, true); })
          .catch(function (e) { btn.disabled = false; btn.innerHTML = ICON.cool + 'Cool it down'; showError(e, $('#coolErr')); });
      };
      var ex = $('#exampleBtn');
      if (ex) ex.onclick = function () {
        var c = demo.cooldown;
        st.reviewId = c.reviewId; $('#coolFor').value = c.reviewId;
        ta.value = c.angry; st.text = c.angry; fit(ta); live();
        showResult(sample(), true);
      };
      if (demo && !pre) {
        // The sample opens on the example, drawn at rest.
        ta.value = demo.cooldown.angry; st.text = ta.value; fit(ta); live();
        showResult(sample(), false);
      }
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- scoreboard ---------------- */

  function trendChart(months) {
    var W = 340, H = 150, padB = 24, padT = 22;
    var bw = W / months.length;
    var names = months.map(function (m) { return new Date(m.month + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }); });
    var h = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Average rating by month: ' +
      esc(months.map(function (m, i) { return names[i] + ' ' + (m.avg == null ? 'no reviews' : m.avg + ' stars from ' + m.count); }).join(', ')) + '">';
    h += '<line class="axis" x1="0" x2="' + W + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '"/>';
    months.forEach(function (m, i) {
      var x = i * bw + bw * 0.2, width = bw * 0.6;
      var bh = m.avg == null ? 0 : Math.max(4, (H - padB - padT) * m.avg / 5);
      var y = H - padB - bh;
      if (bh) h += '<path class="bar-r" d="M' + x + ' ' + (H - padB) + 'V' + (y + 4) + 'q0 -4 4 -4h' + (width - 8) + 'q4 0 4 4V' + (H - padB) + 'Z"><title>' + esc(names[i] + ': ' + m.avg + '★ from ' + m.count + ' review' + (m.count === 1 ? '' : 's')) + '</title></path>';
      h += '<text class="val" x="' + (x + width / 2) + '" y="' + (bh ? y - 7 : H - padB - 7) + '" text-anchor="middle">' + (m.avg == null ? '—' : esc(m.avg.toFixed(1))) + '</text>';
      h += '<text x="' + (x + width / 2) + '" y="' + (H - 7) + '" text-anchor="middle">' + esc(names[i]) + '</text>';
    });
    return h + '</svg>';
  }

  function drawScores(sb, badges, demo) {
    var st = sb.streak;
    var h = (demo ? sampleBar('Juniper & Rye’s scoreboard — invented reviews, real maths.') : '') +
      '<div class="page-head"><div><h1>Scoreboard</h1><div class="sub">How you’re doing, from ' + plural(sb.total, 'review') + '.</div></div></div>';
    if (!sb.total) {
      show(h + empty(ICON.chart, 'No scores yet', 'Add a few reviews and answer them — your response rate, reply time and streak show up here.', '<a class="btn" href="#/add">Add a review</a>'));
      return;
    }
    var trend = sb.trend30;
    h += '<div class="kpis">' +
      '<div class="kpi"><b>' + (sb.responseRate == null ? '—' : sb.responseRate + '%') + '</b><span>Answered</span></div>' +
      '<div class="kpi"><b>' + esc(hoursLabel(sb.medianReplyHours)) + '</b><span>Median time to reply</span></div>' +
      '<div class="kpi"><b>' + (sb.avgRating == null ? '—' : sb.avgRating.toFixed(1)) + (trend ? '<span class="delta ' + (trend > 0 ? 'up' : 'down') + '">' + (trend > 0 ? 'up ' : 'down ') + Math.abs(trend).toFixed(1) + '</span>' : '') + '</b><span>Average rating' + (trend ? ' · vs prior 30 days' : '') + '</span></div>' +
      '<div class="kpi"><b>' + sb.waiting + '</b><span>Waiting' + (sb.urgentWaiting ? ' · ' + sb.urgentWaiting + ' urgent' : '') + '</span></div>' +
      '</div>';
    h += '<div class="split"><div>';
    h += '<section class="section"><div class="sec-head"><h2>' + plural(st.current, 'day') + ' at inbox zero</h2></div><p class="muted small mb0">' +
      (st.atRisk ? 'Something new landed today — answer it to keep the streak.' : st.current ? 'Every review answered, day after day. Best: ' + st.best + '.' : sb.waiting ? 'Answer the ' + sb.waiting + ' waiting to start a streak.' + (st.best ? ' Best so far: ' + st.best + '.' : '') : 'All answered — the streak starts tomorrow.') + '</p></section>';
    h += '<section class="section"><div class="sec-head"><h2>Rating by month</h2><span class="sub">average stars</span></div>' + trendChart(sb.months) + '<p class="chart-note">By the date each review was posted. A month with no reviews shows a dash.</p></section>';
    h += '<section class="section"><div class="sec-head"><h2>Stars</h2><span class="sub">' + plural(sb.total, 'review') + '</span></div><div class="dist">' + [5, 4, 3, 2, 1].map(function (n) {
      var c = sb.distribution[n] || 0; var p = sb.total ? Math.round(100 * c / sb.total) : 0;
      return '<div class="r" role="img" aria-label="' + n + ' stars: ' + plural(c, 'review') + '"><span>' + n + '★</span>' + meter(p) + '<span class="n">' + c + '</span></div>';
    }).join('') + '</div></section>';
    h += '</div><div>';
    h += '<section class="section"><div class="sec-head"><h2>Loved vs stings</h2><span class="sub">by topic</span></div>';
    if (sb.topics.length) {
      var max = Math.max.apply(null, sb.topics.map(function (t) { return Math.max(t.praise, t.complaints); }).concat([1]));
      h += '<div class="legend"><span><i class="l-sting"></i>Stings</span><span><i class="l-praise"></i>Loved</span></div>' + sb.topics.slice(0, 8).map(function (t) {
        return '<div class="topic-row" role="img" aria-label="' + esc(t.label) + ': ' + t.praise + ' loved, ' + t.complaints + ' stings"><span class="ellip">' + esc(t.label) + '</span>' +
          '<span class="n">' + (t.complaints || '') + '</span>' + meter(100 * t.complaints / max, 'sting') + meter(100 * t.praise / max, 'praise') + '<span class="n">' + (t.praise || '') + '</span></div>';
      }).join('');
      var tp = sb.topPraise, tc = sb.topComplaint;
      h += '<p class="chart-note">' + (tp ? 'People love <b>' + esc(tp.label.toLowerCase()) + '</b> most' : '') + (tp && tc ? '; ' : '') + (tc ? 'the most common sting is <b>' + esc(tc.label.toLowerCase()) + '</b>' : '') + '. From each review’s triage — keywords, or the deeper read where you ran one.</p>';
    } else {
      h += '<p class="small muted mb0">Topics appear as reviews mention food, staff, the wait, the price…</p>';
    }
    h += '</section>';
    var earned = badges.filter(function (b) { return b.earnedAt; }).length;
    h += '<section class="section"><div class="sec-head"><h2>Badges</h2><span class="sub">' + earned + ' of ' + badges.length + '</span></div><ul class="badges">' + badges.map(function (b) {
      return '<li class="' + (b.earnedAt ? 'earned' : 'locked') + '">' + (b.earnedAt ? ICON.ok : ICON.lock) + '<div><b>' + esc(b.label) + '</b><span>' + esc(b.desc) + '</span></div>' +
        '<span class="cap muted">' + (b.earnedAt ? (demo ? 'Earned' : esc(fmtDay(b.earnedAt))) : '') + '</span></li>';
    }).join('') + '</ul></section>';
    h += '</div></div>';
    show(h);
  }

  function renderScores() {
    loading();
    if (!signedIn()) return loadDemo().then(function (d) { drawScores(d.scoreboard, d.badges, true); }).catch(function (e) { showError(e, view); });
    api('GET', 'api/scoreboard').then(function (sb) { drawScores(sb, sb.badges, false); }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- the wall of love ---------------- */

  function wallHtml(w) {
    var plats = [];
    w.reviews.forEach(function (r) { if (plats.indexOf(r.platform) < 0) plats.push(r.platform); });
    var h = '<div class="wall-head">' + (w.business.name ? '<div class="biz">' + esc(w.business.name) + '</div>' : '') + '<h1>' + esc(w.title) + '</h1>' +
      '<p>Hand-picked by ' + esc(w.business.name || 'the business') + ' from ' + esc(plats.join(', ') || 'their') + ' reviews. First names only.</p></div>';
    if (!w.reviews.length) return h + empty(ICON.heart, 'No reviews on the wall yet', 'Heart your favourite 4 and 5 star reviews and they appear here.');
    h += '<div class="wall">' + w.reviews.map(function (r) {
      return '<article class="love">' + starsHtml(r.stars) + '<p class="text">“' + esc(r.text) + '”</p><div class="by"><b>' + esc(r.name) + '</b><span>' + esc(r.platform) + ' · ' + esc(fmtDay(r.date, { year: 'numeric' })) + '</span></div>' +
        (r.reply ? '<div class="reply"><b>Reply from ' + esc(w.business.name || 'the owner') + '</b>' + esc(r.reply) + '</div>' : '') + '</article>';
    }).join('') + '</div>';
    return h;
  }

  function renderWall() {
    loading();
    if (!signedIn()) {
      return loadDemo().then(function (d) {
        show(sampleBar('Juniper & Rye’s wall — a public page they link from their own website.') +
          '<div class="page-head"><div><h1>Wall of love</h1><div class="sub">Heart your best reviews; publish one page you can link anywhere.</div></div></div>' +
          '<div class="frame">' + wallHtml(d.wall) + '</div>');
      }).catch(function (e) { showError(e, view); });
    }
    api('GET', 'api/wall').then(function (w) { drawWall(w); }).catch(function (e) { showError(e, view); });
  }

  function drawWall(w) {
    var favs = w.candidates.filter(function (c) { return c.favourite; }).length;
    var h = '<div class="page-head"><div><h1>Wall of love</h1><div class="sub">Heart your best reviews, then publish one page to link from your website.</div></div></div>';
    h += '<div class="split"><div>';
    h += '<div class="sec-head"><h2>' + (w.share ? 'Published' : 'Publish') + '</h2>' + (w.share ? '<span class="sub">copy of ' + esc(fmtDay(String(w.share.sharedAt || '').slice(0, 10))) + '</span>' : '') + '</div>' +
      '<label class="field"><span>Title</span><input class="input" id="wTitle" maxlength="80" placeholder="What our customers say" value="' + esc(w.title) + '"></label>' +
      '<label class="check"><input type="checkbox" id="wReplies"' + (w.showReplies ? ' checked' : '') + '><span>Show my replies under each review (only ones marked replied)</span></label>';
    if (w.share) {
      var url = location.origin + BASE + w.share.url;
      h += '<div class="share-box mt12"><input class="input" id="shareUrl" readonly value="' + esc(url) + '" aria-label="Wall link"><button class="btn small" type="button" id="cpShare">Copy</button></div>' +
        '<div class="row wrap-row mt12"><button class="btn small ghost" type="button" id="pubBtn">Update the copy</button><a class="btn small ghost" href="' + esc(BASE + w.share.url) + '" target="_blank" rel="noopener">Open</a><button class="btn small danger" type="button" id="rvBtn">Revoke</button></div>' +
        '<p class="honest">The link shows a frozen copy — hearting or deleting a review changes nothing until you tap Update. Revoke it and the link is dead for good.</p>';
    } else {
      h += '<button class="btn block mt12" type="button" id="pubBtn"' + (favs ? '' : ' disabled') + '>Publish ' + plural(favs, 'review') + '</button>' +
        '<p class="honest">A public, read-only page — first names only, no account needed to view it. Only 4 and 5 star reviews can go on it.</p>';
    }
    h += '<div id="wErr"></div>';
    h += '<section class="section"><div class="sec-head"><h2>Your 4 and 5 star reviews</h2><span class="sub">' + favs + ' on the wall</span></div>';
    h += w.candidates.length ? '<div class="rows">' + w.candidates.map(function (c) {
      return '<div class="pick-row"><div class="grow"><b>' + esc(c.displayName) + '</b> ' + starsHtml(c.stars) + '<span class="ex">' + esc(c.excerpt) + '</span></div>' +
        '<button class="heart" type="button" data-fav="' + esc(c.id) + '" aria-pressed="' + Boolean(c.favourite) + '" aria-label="' + (c.favourite ? 'Remove ' : 'Add ') + esc(c.displayName) + (c.favourite ? ' from' : ' to') + ' the wall">' + ICON.heart + '</button></div>';
    }).join('') + '</div>' : empty(ICON.star, 'No 4 or 5 star reviews yet', 'They’ll be here to pick from as they come in.');
    h += '</section></div><div class="aside"><section class="section first"><div class="sec-head"><h2>Preview</h2><span class="sub">' + (w.share ? 'next update' : 'before you publish') + '</span></div><div class="frame">' + wallHtml(w.preview) + '</div></section></div></div>';
    show(h);
    $$('[data-fav]').forEach(function (b) {
      b.onclick = function () {
        var on = b.getAttribute('aria-pressed') !== 'true';
        api('POST', 'api/reviews/' + encodeURIComponent(b.dataset.fav) + '/favourite', { favourite: on })
          .then(function () { return api('GET', 'api/wall'); }).then(drawWall).catch(function (e) { showError(e); });
      };
    });
    function publish() {
      var btn = $('#pubBtn'); btn.disabled = true;
      api('POST', 'api/wall', { title: $('#wTitle').value, showReplies: $('#wReplies').checked })
        .then(function (x) { toast(w.share ? 'Updated — the link shows the new copy.' : 'Published. Copy the link into your website.'); celebrateBadges(x.newBadges); drawWall(x); })
        .catch(function (e) { btn.disabled = false; showError(e, $('#wErr')); });
    }
    var pb = $('#pubBtn'); if (pb) pb.onclick = publish;
    var cp = $('#cpShare'); if (cp) cp.onclick = function () { var inp = $('#shareUrl'); inp.select(); copy(inp.value, 'Link copied'); };
    var rv = $('#rvBtn'); if (rv) rv.onclick = function () {
      if (!confirm('Revoke this link? Anyone who has it will see “not valid”, and it never comes back.')) return;
      api('DELETE', 'api/wall').then(function () { toast('Revoked.'); return api('GET', 'api/wall'); }).then(drawWall).catch(function (e) { showError(e); });
    };
  }

  function renderShared(token) {
    document.body.classList.add('public');
    loading();
    api('GET', 'api/shared/' + token).then(function (w) {
      document.title = w.title + (w.business.name ? ' · ' + w.business.name : '');
      show((w.preview ? '<div class="note">' + ICON.info + '<span>This is what visitors see — a frozen copy. Update it from the Wall tab.</span></div>' : '') +
        wallHtml(w) +
        '<p class="center cap muted mt24">Reviews collected with <a href="./">Rave</a></p>', 'wide');
    }).catch(function (e) {
      show(empty(ICON.lock, 'This link isn’t valid', esc(e.message)));
    });
  }

  /* ---------------- settings: your voice ---------------- */

  function renderSettings() {
    if (!signedIn()) return pitch(ICON.spark, 'Replies in your own voice', 'Your name, your sign-off, your tone, what to always and never say, and how an unhappy customer can reach you. Every reply uses them.');
    loading();
    api('GET', 'api/settings').then(function (s) {
      var tone = s.tone || 'warm';
      function text(id, label, val, max, ph, hint) {
        return '<label class="field"><span>' + label + '</span><input class="input" id="' + id + '" value="' + esc(val) + '" maxlength="' + max + '" placeholder="' + esc(ph) + '">' + (hint ? '<small>' + hint + '</small>' : '') + '</label>';
      }
      function area(id, label, val, max, ph, hint) {
        return '<label class="field"><span>' + label + '</span><textarea class="input" id="' + id + '" maxlength="' + max + '" rows="3" placeholder="' + esc(ph) + '">' + esc(val) + '</textarea>' + (hint ? '<small>' + hint + '</small>' : '') + '</label>';
      }
      show(
        '<div class="page-head"><div><h1>Your voice</h1><div class="sub">Every reply — drafted, templated or cooled down — uses these.</div></div></div>' +
        '<div class="split"><div>' +
        '<h2>Your business</h2>' +
        text('sBiz', 'Business', s.businessName, 80, 'Juniper & Rye') +
        text('sWhat', 'What you do', s.what, 60, 'neighbourhood café') +
        text('sName', 'Your name', s.ownerName, 60, 'Ana') +
        text('sSign', 'Sign-off', s.signOff, 60, 'Warmly,') +
        '<section class="section"><h2>Tone</h2>' +
        '<div class="seg" id="toneSeg" role="group" aria-label="Tone">' + TONES.map(function (t) { return '<button type="button" data-tone="' + t.key + '">' + esc(t.label) + '</button>'; }).join('') + '</div>' +
        '<p class="small muted mt12" id="tonePrev"></p>' +
        '<p class="hint">Playful stays warm and straight on 1–2 star reviews — nobody wants a joke about their bad night.</p></section>' +
        '</div><div>' +
        '<h2>How you sound</h2>' +
        area('sSample', 'A reply you wrote yourself (optional)', voiceSample(), 1200, 'Paste a reply you were happy with. Drafts will pick up its rhythm and word choice.', 'Stays on this device and rides along with each draft — never stored on our servers. Used for its sound only: no facts, offers or names are taken from it.') +
        '<section class="section"><h2>Taking it offline</h2>' +
        text('sContact', 'How an unhappy customer reaches you', s.contactLine, 160, 'ana@yourcafe.com or (555) 010-2277', 'Used in replies to 1–2 star and sensitive reviews. It’s the one contact detail the checklist lets through.') + '</section>' +
        '<section class="section"><h2>House rules</h2>' +
        area('sAlways', 'Always say', s.alwaysSay, 300, 'We bake everything in-house every morning.') +
        area('sNever', 'Never say', s.neverSay, 300, 'Never offer refunds or free food in a public reply.', 'These guide the AI drafts and cool-downs. A draft only offers a refund, a discount or a promise when “Always say” does.') + '</section>' +
        '<div id="sErr"></div><button class="btn block big mt16" type="button" id="sSave">Save</button>' +
        '</div></div>');
      function drawTone() {
        $$('#toneSeg button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.tone === tone)); });
        $('#tonePrev').textContent = TONES.filter(function (t) { return t.key === tone; })[0].ex;
      }
      $$('#toneSeg button').forEach(function (b) { b.onclick = function () { tone = b.dataset.tone; drawTone(); }; });
      drawTone();
      $('#sSave').onclick = function () {
        var btn = this; btn.disabled = true;
        saveVoiceSample($('#sSample').value.trim().slice(0, 1200));
        api('PUT', 'api/settings', {
          businessName: $('#sBiz').value, what: $('#sWhat').value, ownerName: $('#sName').value, signOff: $('#sSign').value,
          tone: tone, contactLine: $('#sContact').value, alwaysSay: $('#sAlways').value, neverSay: $('#sNever').value,
        }).then(function (r) {
          btn.disabled = false;
          state.me.settings = r; drawTop();
          toast('Saved. Your replies will sound like you.');
          location.hash = '#/';
        }).catch(function (e) { btn.disabled = false; showError(e, $('#sErr')); });
      };
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- start ---------------- */

  window.addEventListener('pagehide', function () { if (state.flush) state.flush(); });
  if (PUB) { route(); return; }
  loadMe().then(function () {
    route();
    if (signedIn()) api('GET', 'api/reviews').then(function (r) { setInboxDot(r.counts.urgent); }).catch(function () {});
  });
})();
