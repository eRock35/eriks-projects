/* Rave - the page. One file, no build step, every model-written or typed string escaped. */
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

  var state = { me: null, demo: null, snapped: null, coolDraft: null, flush: null };

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
  function initials(s) { return String(s || '?').split(/[\s@.]+/).filter(Boolean).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function hue(s) { var h = 0; for (var i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) % 360; return h; }
  function platformLabel(k) { var p = PLATFORMS.filter(function (x) { return x.key === k; })[0]; return p ? p.label : 'Other'; }
  /** A reply box grows to fit its reply, up to most of the screen, so the
   *  sign-off is never hidden below a fold inside a fold. */
  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(window.innerHeight * 0.6, Math.max(ta.scrollHeight + 4, 140)) + 'px';
  }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast((what || 'Copied') + ' — paste it where the review is.'); }, function () { toast('Select the text and copy it.'); });
  }

  function confetti() {
    if (reducedMotion()) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var colors = ['#fbbf24', '#fb7185', '#f59e0b', '#4ade80', '#38bdf8', '#fb923c'];
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
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  };

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
      el.innerHTML = '<button class="btn small" id="signInTop">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var b = me.budget || {};
    el.innerHTML =
      '<span class="pill credit" title="AI credit">' + (b.unlimited ? '∞' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span>' +
      '<button class="avatar-btn" id="acctBtn" aria-label="Account">' + esc(initials(settings().businessName || settings().ownerName || me.email)) + '</button>';
    $('#acctBtn').onclick = function () { openAccount(); };
  }

  function setInboxDot(n) { var d = $('#inboxDot'); if (d) d.classList.toggle('hidden', !n); }

  /* ---------------- sheets ---------------- */

  function sheet(html, onMount) {
    closeSheet();
    var scrim = document.createElement('div');
    scrim.className = 'scrim'; scrim.id = 'scrim';
    scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + html + '</div>';
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
    document.body.appendChild(scrim);
    if (onMount) onMount(scrim.firstChild);
    var f = scrim.querySelector('input, textarea, button:not(.link-btn)');
    if (f && f.tagName !== 'BUTTON') setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 50);
    return scrim.firstChild;
  }
  function closeSheet() { var s = $('#scrim'); if (s) s.remove(); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function openAccount(reason) {
    if (signedIn()) return openProfileSheet();
    var mode = 'register';
    function draw(root) {
      root.innerHTML = '<div class="grab"></div>' +
        '<h2>' + (mode === 'register' ? 'Every review, answered well.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Free account with $2 of AI credit — a drafted reply costs well under a cent, so that is hundreds of them. Templates, the reply checklist and the thermometer are free forever. One account works across every app on this site.'
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
      '<div class="card" style="margin:14px 0"><div class="row spread"><b>AI credit</b><span class="num">' + remaining + '</span></div>' +
      '<div class="dist" style="margin-top:10px"><div class="r" style="grid-template-columns:1fr"><div class="t"><i style="width:' + pct + '%"></i></div></div></div>' +
      '<p class="small muted" style="margin:10px 0 0">A reply in your voice or a cool-down costs well under a cent; a screenshot about a cent. Templates, the checklist, the thermometer and your scoreboard are free.</p>' +
      '<div id="billing" style="margin-top:12px"></div></div>' +
      '<a class="btn ghost block" href="#/settings" id="voiceLink">Your voice</a>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" style="margin-top:10px">Sign out</button>',
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
      '<p class="muted small">Replying still works: every review has a free template in your tone, the checklist and the thermometer cost nothing, and so does marking replies and your scoreboard.</p><div id="billing"></div>',
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
    var owner = { review: 'inbox' };
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === (owner[tab] || tab)); });
    window.scrollTo(0, 0);
    if (tab === 'review' && parts[1]) return renderReview(decodeURIComponent(parts[1]));
    if (tab === 'add') return renderAdd();
    if (tab === 'cool') return renderCool(parts[1] ? decodeURIComponent(parts[1]) : null);
    if (tab === 'scores') return renderScores();
    if (tab === 'wall') return renderWall();
    if (tab === 'settings') return renderSettings();
    return signedIn() ? renderInbox() : renderHome();
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () { location.hash = '#/' + (b.dataset.tab === 'inbox' ? '' : b.dataset.tab); };
  });
  window.addEventListener('hashchange', route);

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner" aria-label="Loading"></span></div>'; }
  function backLink(href, label) { return '<a class="back" href="' + href + '">' + ICON.back + esc(label) + '</a>'; }
  function sampleBar(what) {
    return '<div class="sample-bar"><span><b>SAMPLE</b> · ' + esc(what || 'Juniper & Rye, an invented café — real rules, no AI used.') + '</span>' +
      '<button class="btn small" data-signup>Sign up free</button></div>';
  }
  function wireSignup(root) { $$('[data-signup]', root).forEach(function (b) { b.onclick = function () { openAccount(); }; }); }
  function pitch(emoji, title, body) {
    view.innerHTML = '<div class="empty"><div class="e">' + emoji + '</div><h2>' + esc(title) + '</h2><p>' + esc(body) + '</p>' +
      '<div class="btn-row" style="justify-content:center"><button class="btn" data-signup>Start free</button><a class="btn ghost" href="#/">See the sample</a></div></div>';
    wireSignup(view);
  }

  /* ---------------- pieces ---------------- */

  function starsHtml(n, big) {
    var h = '<span class="stars' + (big ? ' big' : '') + '" role="img" aria-label="' + n + ' out of 5 stars">';
    for (var i = 1; i <= 5; i++) h += '<span class="' + (i <= n ? '' : 'off') + '" aria-hidden="true">★</span>';
    return h + '</span>';
  }
  function avatar(name) {
    return '<span class="avatar" aria-hidden="true" style="background:hsl(' + hue(name || '?') + ' 45% 36%)">' + esc(initials(name) || '?') + '</span>';
  }
  function urgChip(u) { return '<span class="urg u-' + esc(u) + '">' + esc(URG[u] || u) + '</span>'; }
  function topicTags(t, max) {
    var out = [];
    (t.complaints || []).forEach(function (k) { var i = RR.topicInfo(k); out.push('<span class="tag sting">' + esc(i.emoji) + ' ' + esc(i.label) + '</span>'); });
    (t.praise || []).forEach(function (k) { var i = RR.topicInfo(k); out.push('<span class="tag praise">' + esc(i.emoji) + ' ' + esc(i.label) + '</span>'); });
    return out.slice(0, max || 8).join('');
  }

  function reviewCard(r) {
    var t = r.triage || {};
    var sub = platformLabel(r.platform) + ' · ' + fmtDay(r.date) + (r.status === 'waiting' ? ' · waiting ' + ago(r.waitingDays) : ' · replied ' + fmtDay(r.repliedDay));
    return '<div class="rcard u-' + esc(r.urgency) + (r.status === 'replied' ? ' done' : '') + '" role="link" tabindex="0" data-rev="' + esc(r.id) + '">' +
      '<div class="head">' + avatar(r.displayName) + '<div class="grow"><div class="who ellip">' + esc(r.displayName) + '</div><div class="meta ellip">' + esc(sub) + '</div></div>' + starsHtml(r.stars) + '</div>' +
      (r.excerpt || r.text ? '<p class="quote">' + esc(r.excerpt || r.text) + '</p>' : '<p class="quote faint">A star rating with no words.</p>') +
      '<div class="foot"><div class="tags">' + (t.risk && t.risk.flag ? '<span class="tag risk">⚠️ ' + esc(t.risk.reasons.map(function (k) { return RR.riskInfo(k).label; }).join(', ')) + '</span>' : '') + topicTags(t, 3) + '</div>' +
      '<div class="row">' + (r.hasDraft && r.status === 'waiting' ? '<span class="draft-flag">Draft saved</span>' : '') + (r.favourite ? '<span role="img" aria-label="On your wall of love">💛</span>' : '') + (r.urgency === 'low' ? '' : urgChip(r.urgency)) + '</div></div>' +
      '</div>';
  }
  function wireCards(root, demo) {
    $$('[data-rev]', root).forEach(function (el) {
      var go = function () { location.hash = '#/review/' + encodeURIComponent(el.dataset.rev); };
      el.onclick = go;
      el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
  }

  function heatbar(h) {
    return '<div class="heatbar lv-' + esc(h.level) + '" aria-label="Heat ' + h.score + ' degrees, ' + esc(LEVEL[h.level]) + '"><span>🌡️ ' + h.score + '° ' + esc(LEVEL[h.level]) + '</span><span class="track" aria-hidden="true"><i style="left:' + Math.max(2, Math.min(98, h.score)) + '%"></i></span></div>';
  }

  function lintHtml(res) {
    var head = '<div class="lint-head">' + heatbar(res.heat) + '<span class="small faint">' + res.words + ' word' + (res.words === 1 ? '' : 's') + '</span></div>';
    var items = res.issues.map(function (x) {
      var ic = x.level === 'error' ? '⛔' : x.level === 'warn' ? '⚠️' : '💡';
      return '<li class="' + esc(x.level) + '"><span class="ic" aria-hidden="true">' + ic + '</span><div><b>' + esc(x.label) + '</b><span>' + esc(x.detail) + '</span></div></li>';
    });
    if (res.ok) items.unshift('<li class="ok"><span class="ic" aria-hidden="true">✅</span><div><b>Good to post</b><span>No red flags — not too long, not copy-pasted, nothing private, not arguing.</span></div></li>');
    return head + '<ul class="lint" aria-label="Reply checklist">' + items.join('') + '</ul>';
  }

  function thermoHtml(h, id) {
    return '<div class="thermo lv-' + esc(h.level) + (h.level === 'boiling' ? ' boiling' : '') + '"' + (id ? ' id="' + id + '"' : '') + ' role="img" aria-label="Heat ' + h.score + ' degrees, ' + esc(LEVEL[h.level]) + '">' +
      '<div class="tube"><i class="mercury" style="--h:' + Math.max(4, h.score) + '%"></i></div><div class="bulb"></div>' +
      '<b>' + h.score + '°</b><small>' + esc(LEVEL[h.level]) + '</small></div>';
  }
  function setThermo(el, h) {
    if (!el) return;
    el.className = 'thermo lv-' + h.level + (h.level === 'boiling' ? ' boiling' : '');
    el.setAttribute('aria-label', 'Heat ' + h.score + ' degrees, ' + LEVEL[h.level]);
    $('.mercury', el).style.setProperty('--h', Math.max(4, h.score) + '%');
    $('b', el).textContent = h.score + '°';
    $('small', el).textContent = LEVEL[h.level];
  }
  function flagsHtml(h) {
    if (!h.flags.length) return '<span class="small faint">Nothing heating it up.</span>';
    return h.flags.map(function (f) { return '<span class="tag">' + esc(f.emoji) + ' ' + esc(f.label) + '</span>'; }).join('');
  }
  function snow(root) {
    if (reducedMotion() || !root) return;
    root.classList.add('frost');
    for (var i = 0; i < 18; i++) {
      var f = document.createElement('span');
      f.className = 'flake'; f.setAttribute('aria-hidden', 'true'); f.textContent = '❄';
      f.style.left = Math.random() * 100 + '%';
      f.style.animationDelay = Math.random() * 0.8 + 's';
      f.style.fontSize = 10 + Math.random() * 12 + 'px';
      root.appendChild(f);
      setTimeout(function (x) { return function () { x.remove(); }; }(f), 3400);
    }
  }

  function celebrateBadges(list) {
    if (!list || !list.length) return;
    confetti();
    toast('Badge earned: ' + list.map(function (b) { return b.emoji + ' ' + b.label; }).join(', '), 3600);
  }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    loadDemo().then(function (d) {
      var cd = d.cooldown;
      var waiting = d.reviews.filter(function (r) { return r.status === 'waiting'; });
      view.innerHTML =
        '<section class="hero"><span class="kicker">⭐ For restaurants, salons, contractors, clinics &amp; shops</span>' +
        '<h1>Answer every review like a pro — <em>even the ones that sting.</em></h1>' +
        '<p>Paste or screenshot your Google and Yelp reviews. Rave triages them, drafts replies in your voice, and cools down the angry one before you post it.</p>' +
        '<div class="ctas"><button class="btn lg" id="heroGo">Start free</button><a class="btn lg ghost" href="#sample">See the sample</a></div>' +
        '<div class="trust"><span>✓ $2 of AI credit free</span><span>✓ Templates &amp; checklist always free</span><span>✓ You post it — we never touch your accounts</span></div></section>' +
        '<div id="sample">' + sampleBar() + '</div>' +
        '<div class="dk-2"><div>' +
        '<div class="page-head" style="margin-top:6px"><div><h1>Inbox</h1><div class="sub">' + esc(d.settings.businessName) + ' · ' + waiting.length + ' waiting · ' + d.scoreboard.responseRate + '% answered</div></div></div>' +
        '<div class="list">' + d.reviews.slice(0, 6).map(reviewCard).join('') + '</div>' +
        '</div><div class="dk-sticky">' +
        '<a class="card" href="#/cool" style="display:block;text-decoration:none;color:inherit">' +
        '<div class="eyebrow">Cool down · the signature move</div>' +
        '<h3 style="margin:6px 0 4px">Type the reply you want to send.</h3><p class="small muted" style="margin:0">Rave hands back the one you’ll be glad you posted — and shows what it took out.</p>' +
        '<div class="duo" style="margin-top:12px"><div class="side"><span class="cap">Ana’s draft</span>' + thermoHtml(cd.heatBefore) + '</div><div class="arrow" aria-hidden="true">→</div><div class="side"><span class="cap">Posted</span>' + thermoHtml(cd.heatAfter) + '</div></div>' +
        '<div class="flags">' + cd.removed.slice(0, 4).map(function (x) { var k = RR.kindInfo(x.kind); return '<span class="tag">' + esc(k.emoji) + ' ' + esc(k.label) + '</span>'; }).join('') + '</div></a>' +
        '<a class="card row" href="#/scores" style="text-decoration:none;color:inherit"><span style="font-size:30px">🏆</span><div class="grow"><b>Scoreboard</b><div class="small muted">Response rate, time to reply, the rating trend and what people love most.</div></div><span class="muted">›</span></a>' +
        '<a class="card row" href="#/wall" style="text-decoration:none;color:inherit"><span style="font-size:30px">💛</span><div class="grow"><b>Wall of love</b><div class="small muted">Your best reviews on one page, for your own website.</div></div><span class="muted">›</span></a>' +
        '</div></div>' +
        '<div class="steps">' +
        '<div class="step"><div class="ic">📋</div><h3>Paste or snap it</h3><p>Paste a review or drop in a screenshot — Rave reads the stars, the name and the words. The screenshot is never kept.</p></div>' +
        '<div class="step"><div class="ic">🎯</div><h3>Know what matters</h3><p>Topics, sentiment and a red flag for anything about health, safety or the law — the ones to handle offline.</p></div>' +
        '<div class="step"><div class="ic">🧊</div><h3>Reply without regret</h3><p>A draft in your voice, a checklist that catches copy-paste and private details, and a cool-down for the ones that sting.</p></div>' +
        '</div>' +
        '<div class="cta-band"><h2>Every review, answered.</h2><p>Replying helps your rating, and it takes a minute. The bad ones take a cool head — that’s what Rave is for.</p><button class="btn lg" id="bandGo">Sign up free</button></div>';
      wireCards(view, true);
      $('#heroGo').onclick = function () { openAccount(); };
      $('#bandGo').onclick = function () { openAccount(); };
      $('a[href="#sample"]').onclick = function (e) { e.preventDefault(); $('#sample').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' }); };
      wireSignup(view);
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
        fav: { label: '💛 Wall', f: function (x) { return x.favourite; } },
        all: { label: 'All', f: function () { return true; } },
      };
      function draw() {
        var rows = all.filter(F[inboxFilter].f);
        var s = r.streak;
        var sub = all.length ? r.counts.waiting + ' waiting' + (r.counts.urgent ? ' · ' + r.counts.urgent + ' urgent' : '') : 'Nothing here yet';
        var h = '<div class="page-head"><div><h1>Inbox</h1><div class="sub">' + esc(sub) + '</div></div>' +
          (s.current ? '<a class="pill streak" href="#/scores" title="Days in a row at inbox zero">🔥 ' + s.current + ' day' + (s.current === 1 ? '' : 's') + (s.atRisk ? ' · reply today' : '') + '</a>' : '<a class="btn small" href="#/add">+ Add</a>') + '</div>';
        if (!settings().setUp) h += '<a class="banner" href="#/settings" style="text-decoration:none;color:inherit;margin-bottom:12px"><span class="e">🎙️</span><span class="grow"><b>Set up your voice.</b> Your name, sign-off, tone and how unhappy customers reach you — every reply uses them.</span><span>›</span></a>';
        h += '<div class="chips" style="margin-bottom:14px" role="group" aria-label="Filter">' + Object.keys(F).map(function (k) {
          var n = all.filter(F[k].f).length;
          return '<button class="chip' + (inboxFilter === k ? ' on' : '') + '" data-f="' + k + '" aria-pressed="' + (inboxFilter === k) + '">' + esc(F[k].label) + (k !== 'all' ? ' · ' + n : '') + '</button>';
        }).join('') + '</div>';
        if (rows.length) {
          h += '<div class="list">' + rows.map(reviewCard).join('') + '</div>';
        } else if (!all.length) {
          h += '<div class="empty boxed"><div class="e">📬</div><h2>Add your first review</h2><p>Paste one in or drop a screenshot. Start with the one you’ve been avoiding.</p><a class="btn" href="#/add">Add a review</a></div>';
        } else if (inboxFilter === 'todo') {
          h += '<div class="empty boxed zero"><div class="e">🎉</div><h2>Inbox zero</h2><p>Every review answered.' + (s.current ? ' That’s ' + s.current + ' day' + (s.current === 1 ? '' : 's') + ' in a row.' : '') + ' New ones go in with <b>Add</b>.</p></div>';
        } else {
          h += '<div class="empty boxed"><div class="e">🔍</div><h2>Nothing here</h2><p>Try another filter.</p></div>';
        }
        view.innerHTML = h;
        $$('[data-f]').forEach(function (b) { b.onclick = function () { inboxFilter = b.dataset.f; draw(); }; });
        wireCards(view);
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
        if (!r) return pitch('🔒', 'Sign in to see your reviews', 'Your inbox is yours alone — nobody else can open it.');
        drawReview(r, { demo: d });
      }).catch(function (e) { showError(e, view); });
    }
    api('GET', 'api/reviews/' + encodeURIComponent(id)).then(function (r) { drawReview(r, {}); }).catch(function (e) { showError(e, view); });
  }

  function triageCard(r, demo) {
    var t = r.triage;
    var h = '<div class="card triage"><div class="card-head"><h3>What they said</h3><span class="by">' + (t.by === 'ai' ? '✨ Deeper read' : 'Quick read · free') + '</span></div>';
    h += '<div class="row wrap-row">' + urgChip(r.urgency === 'done' ? t.urgency : r.urgency) + '<span class="tag">' + esc(t.sentiment.charAt(0).toUpperCase() + t.sentiment.slice(1)) + '</span></div>';
    if (t.summary) h += '<p class="line"><b>In short:</b> ' + esc(t.summary) + '</p>';
    if (t.approach) h += '<p class="line"><b>How to answer:</b> ' + esc(t.approach) + '</p>';
    h += '<div class="grid2"><div><div class="eyebrow">Stings</div><div class="tags">' + ((t.complaints || []).map(function (k) { var i = RR.topicInfo(k); return '<span class="tag sting">' + esc(i.emoji) + ' ' + esc(i.label) + '</span>'; }).join('') || '<span class="small faint">Nothing</span>') + '</div></div>' +
      '<div><div class="eyebrow">Loved</div><div class="tags">' + ((t.praise || []).map(function (k) { var i = RR.topicInfo(k); return '<span class="tag praise">' + esc(i.emoji) + ' ' + esc(i.label) + '</span>'; }).join('') || '<span class="small faint">Nothing specific</span>') + '</div></div></div>';
    if (t.by !== 'ai') {
      h += demo
        ? '<p class="small faint" style="margin:12px 0 0">Signed in, “Deeper read” adds a one-line summary and advice on how to answer. About a tenth of a cent.</p>'
        : '<button class="btn small ghost" id="deepBtn" style="margin-top:12px">' + ICON.spark + 'Deeper read</button>';
    }
    return h + '</div>';
  }

  function riskBanner(t) {
    if (!t.risk || !t.risk.flag) return '';
    var reasons = t.risk.reasons.map(function (k) { return RR.riskInfo(k); });
    return '<div class="banner risk" role="note" style="margin-bottom:12px"><span class="e">📞</span><div><b>Handle this one offline — call them.</b>' +
      '<div class="small" style="margin-top:4px">' + esc(reasons.map(function (x) { return x.label + ': ' + x.detail; }).join(' ')) + '</div>' +
      '<div class="small muted" style="margin-top:6px">Keep the public reply short and sincere, give them a direct line, and don’t discuss details or admit fault in public. Then pick up the phone.</div></div></div>';
  }

  function drawReview(r, opts) {
    var demo = opts.demo || null;
    var s = demo ? demo.settings : settings();
    var d0 = demo ? demo.drafts[r.id] : null;
    var st = {
      text: demo ? (d0 ? d0.text : '') : (r.reply ? r.reply.text : ''),
      source: demo ? (d0 ? d0.source : 'template') : (r.reply ? r.reply.source : 'own'),
      note: '', variant: 1, busy: '', saved: true, timer: null,
    };
    var canWall = r.stars >= 4 && String(r.text || '').trim();
    var h = (demo ? sampleBar('A sample review. Nothing here can be changed.') : '') + backLink('#/', 'Inbox');
    h += riskBanner(r.triage);
    h += '<div class="dk-2"><div>';
    h += '<div class="card review-card"><div class="row">' + avatar(r.displayName) + '<div class="grow"><div class="who ellip">' + esc(r.displayName) + '</div><div class="small muted">' + esc(platformLabel(r.platform)) + ' · ' + esc(fmtDay(r.date, { year: 'numeric' })) + (r.source === 'snap' ? ' · from a screenshot' : '') + '</div></div>' +
      (canWall ? '<button class="heart' + (r.favourite ? ' on' : '') + '" id="favBtn" aria-pressed="' + Boolean(r.favourite) + '" aria-label="' + (r.favourite ? 'Remove from' : 'Add to') + ' wall of love">' + (r.favourite ? '♥' : '♡') + '</button>' : '') + '</div>' +
      '<div style="margin-top:12px">' + starsHtml(r.stars, true) + '</div>' +
      (r.text ? '<p class="text">' + esc(r.text) + '</p>' : '<p class="text faint">A star rating with no words. It still deserves a thank-you.</p>') + '</div>';
    h += triageCard(r, demo);
    h += '</div><div class="dk-sticky"><div class="card composer" id="composer"></div></div></div>';
    if (!demo) h += '<div class="more-actions" style="margin-top:14px"><button class="btn small ghost" id="editBtn">Edit review</button><button class="btn small danger" id="delBtn">Delete</button></div>';
    view.innerHTML = h;
    wireSignup(view);

    var box = $('#composer');
    function lintNow(text) {
      return RR.lint(text, { stars: r.stars, reviewer: r.reviewer || r.displayName, contactLine: s.contactLine, risk: r.triage.risk && r.triage.risk.flag, others: r.others || [] });
    }
    function drawComposer() {
      var replied = r.status === 'replied';
      var c = '<div class="card-head"><h3>Your reply</h3><span class="save-state" id="saveState" aria-live="polite">' + (demo ? '' : st.saved ? (st.text ? 'Saved' : '') : 'Saving…') + '</span></div>';
      if (replied) {
        c += '<div class="banner good" style="margin-bottom:12px"><span class="e">✅</span><span class="grow"><b>Replied ' + esc(fmtDay(r.repliedDay, { year: 'numeric' })) + '.</b>' + (r.replySource === 'cooled' ? ' Cooled down first 🧊.' : '') + '</span>' + (demo ? '' : '<button class="btn small ghost" id="undoBtn">Undo</button>') + '</div>';
      }
      c += '<textarea class="input" id="replyBox" aria-label="Your reply" placeholder="Write your reply, or tap a button below."' + (demo ? ' readonly' : '') + '>' + esc(st.text) + '</textarea>';
      if (st.note) c += '<p class="small muted" style="margin:8px 2px 0">✨ ' + esc(st.note) + '</p>';
      if (demo) {
        c += '<p class="small muted" style="margin:10px 0 0">' + (replied ? 'Ana’s posted reply, through the same checklist.' : 'Rave’s free template for this review — no AI used. Signed in, “Write it for me” drafts one from your voice and the review.') + '</p>';
      }
      c += '<div class="tool-row">' +
        '<button class="btn small" id="aiBtn">' + ICON.spark + (st.busy === 'ai' ? 'Writing…' : st.source === 'ai' ? 'Try another' : 'Write it for me') + '</button>' +
        '<button class="btn small ghost" id="tplBtn">' + (st.busy === 'tpl' ? '…' : 'Template · free') + '</button>' +
        '<button class="btn small ice" id="coolBtn">🧊 Cool it down</button></div>';
      c += '<div id="lintBox" aria-live="polite"></div>';
      c += '<div class="btn-row" style="margin-top:14px"><button class="btn ghost" id="copyBtn">' + ICON.copy + 'Copy</button>' +
        (replied ? '' : '<button class="btn good" id="doneBtn">' + ICON.check + 'I posted it</button>') + '</div>';
      c += '<p class="honest"><span aria-hidden="true">ℹ️</span><span>Rave never posts for you — no Google or Yelp login, no scraping. Copy the reply, paste it under the review on ' + esc(platformLabel(r.platform)) + ', then tap “I posted it”.</span></p>';
      c += '<div id="compErr"></div>';
      box.innerHTML = c;
      drawLint();
      wireComposer();
      fit();
    }
    function drawLint() { var el = $('#lintBox', box); if (el) el.innerHTML = lintHtml(lintNow(st.text)); }
    function fit() { var ta = $('#replyBox', box); if (ta) grow(ta); }
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
        grow(ta);
        if (st.source !== 'own' && !st.text.trim()) st.source = 'own';
        drawLint();
        if (demo) return;
        var ss = $('#saveState', box); if (ss) ss.textContent = 'Editing…';
        clearTimeout(st.timer);
        st.timer = setTimeout(save, 900);
      };
      $('#aiBtn', box).onclick = function () {
        if (demo) return needAccount('Sign up free and Rave drafts replies from your own voice — about a tenth of a cent each.');
        if (st.text.trim() && !confirm('Replace what is in the box with a new draft?')) return;
        st.busy = 'ai'; drawComposer();
        api('POST', 'api/reviews/' + encodeURIComponent(r.id) + '/draft', {})
          .then(function (d) { st.busy = ''; setText(d.text, 'ai', d.note); loadMe(); })
          .catch(function (e) { st.busy = ''; drawComposer(); showError(e, $('#compErr', box)); });
      };
      $('#tplBtn', box).onclick = function () {
        if (demo) return needAccount('Sign up free — templates in your own tone are free forever.');
        if (st.text.trim() && st.source !== 'template' && !confirm('Replace what is in the box with a template?')) return;
        st.busy = 'tpl'; drawComposer();
        api('POST', 'api/reviews/' + encodeURIComponent(r.id) + '/template', { variant: st.variant++ })
          .then(function (d) { st.busy = ''; setText(d.text, 'template'); })
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
            if (x.waitingLeft === 0) { confetti(); toast('Inbox zero! Every review answered. 🎉', 3600); }
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
        fav.classList.toggle('on', r.favourite); fav.textContent = r.favourite ? '♥' : '♡';
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
    return '<div class="plat-pick" role="group" aria-label="Where it was posted">' + PLATFORMS.map(function (p) {
      return '<button type="button" class="chip' + (p.key === sel ? ' on' : '') + '" data-plat="' + p.key + '" aria-pressed="' + (p.key === sel) + '">' + esc(p.label) + '</button>';
    }).join('') + '</div>';
  }
  function starPick(n) {
    var h = '<div class="star-pick" role="radiogroup" aria-label="Stars">';
    for (var i = 1; i <= 5; i++) h += '<button type="button" role="radio" aria-checked="' + (i === n) + '" aria-label="' + i + ' star' + (i === 1 ? '' : 's') + '" data-star="' + i + '" class="' + (i <= n ? 'on' : '') + '">★</button>';
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
        $$('[data-plat]', root).forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      };
    });
  }

  function openEditReview(r) {
    var st = { stars: r.stars, platform: r.platform };
    sheet('<h2>Edit review</h2><p class="small muted">Fix a typo from pasting — this is your copy, not the one on ' + esc(platformLabel(r.platform)) + '.</p>' +
      '<div class="group-title">Stars</div>' + starPick(r.stars) +
      '<div class="group-title">Posted on</div>' + platformPick(r.platform) +
      '<div class="group" style="margin-top:14px"><div class="cell"><label for="eWho">Reviewer</label><input id="eWho" value="' + esc(r.reviewer) + '" maxlength="80"></div>' +
      '<div class="cell"><label for="eDate">Date</label><input id="eDate" type="date" max="' + localToday() + '" value="' + esc(r.date) + '"></div>' +
      '<div class="cell stack"><label for="eText">Review</label><textarea id="eText" maxlength="5000">' + esc(r.text) + '</textarea></div></div>' +
      '<div id="eErr"></div><button class="btn block" id="eSave" style="margin-top:14px">Save</button>',
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
    if (!signedIn()) return pitch('📋', 'Paste a review, or drop a screenshot', 'Rave reads the stars, the name and the words from a screenshot — it is read once and never kept.');
    var p = state.snapped || {};
    var st = { stars: p.stars || 0, platform: p.platform || 'google' };
    view.innerHTML =
      '<div class="page-head"><div><h1>Add a review</h1><div class="sub">Paste it in, or let Rave read a screenshot.</div></div></div>' +
      '<label class="card snap-card" id="snapCard"><span class="ic">📸</span><span class="grow"><b>Drop in a screenshot</b><span>Of the review on Google, Yelp or anywhere — Rave fills in the rest. About a cent of AI credit; the image is never stored.</span></span>' +
      '<input type="file" id="snapIn" accept="image/*"></label>' +
      '<div id="snapState"></div>' +
      '<div class="or">or paste it in</div>' +
      '<div class="group-title">Stars</div>' + starPick(st.stars) +
      '<div class="group-title">Posted on</div>' + platformPick(st.platform) +
      '<div class="group" style="margin-top:14px">' +
      '<div class="cell"><label for="aWho">Reviewer</label><input id="aWho" placeholder="Name as shown" maxlength="80" value="' + esc(p.reviewer || '') + '"></div>' +
      '<div class="cell"><label for="aDate">Date posted</label><input id="aDate" type="date" max="' + localToday() + '" value="' + esc(p.date || localToday()) + '"></div>' +
      '<div class="cell stack"><label for="aText">The review</label><textarea id="aText" maxlength="5000" rows="7" placeholder="Paste the review here">' + esc(p.text || '') + '</textarea></div>' +
      '</div><p class="hint">No words, just stars? Leave it empty — a rating-only review still deserves a thank-you.</p>' +
      '<div id="aErr"></div><button class="btn block lg" id="aSave" style="margin-top:16px">Add to my inbox</button>';
    if (state.snapped) {
      $('#snapState').innerHTML = '<div class="banner" style="margin-top:12px"><span class="e">✨</span><span>Read from your screenshot' + (p.dateGuessed ? ' — the date wasn’t clear' + (p.dateText ? ' (“' + esc(p.dateText) + '”)' : '') + ', so check it' : '') + '. Check the rest, then add it. The image wasn’t kept.</span></div>';
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
    box.innerHTML = '<div class="card writing" style="margin-top:12px"><span class="spinner"></span>Reading your screenshot…</div>';
    shrink(file).then(function (image) {
      return api('POST', 'api/reviews/read', { image: image });
    }).then(function (p) {
      state.snapped = p;
      loadMe();
      renderAdd();
    }).catch(function (e) {
      if (e.status === 402) { box.innerHTML = ''; return openCreditSheet(e.data); }
      box.innerHTML = '<div class="banner warn" style="margin-top:12px"><span class="e">🤔</span><span>' + esc(e.message) + '</span></div>';
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
      var st = { reviewId: reviewId || (demo ? demo.cooldown.reviewId : ''), text: pre && pre.text ? pre.text : '', result: null, busy: false };
      function reviewer() { var x = ctx.reviews.filter(function (y) { return y.id === st.reviewId; })[0]; return x ? (x.reviewer || x.displayName) : ''; }
      function heatNow(text) { return RR.heat(text, { reviewer: reviewer(), contactLine: s.contactLine }); }

      var h = (demo ? sampleBar('The thermometer is free and runs on your phone — try it. Cooling down needs an account.') : '') +
        '<div class="page-head"><div><h1>Cool down 🧊</h1><div class="sub">Type the reply you <i>want</i> to send. Rave hands back the one you’ll be glad you posted.</div></div></div>' +
        '<div class="dk-2"><div>' +
        '<div class="card">' +
        '<label class="field"><span>Replying to</span><select class="input" id="coolFor"><option value="">No particular review</option>' +
        options.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === st.reviewId ? ' selected' : '') + '>' + esc(x.displayName + ' · ' + x.stars + '★ · ' + String(x.excerpt || x.text || '').slice(0, 40)) + '</option>'; }).join('') + '</select></label>' +
        '<div class="vent"><label class="field" style="margin:0"><span>What you really want to say</span><textarea class="input" id="ventBox" maxlength="3000" placeholder="Go on. Nobody sees this but you.">' + esc(st.text) + '</textarea></label>' +
        thermoHtml(heatNow(st.text), 'liveThermo') + '</div>' +
        '<div class="flags" id="liveFlags" aria-live="polite"></div>' +
        '<div class="btn-row cool-cta"><button class="btn ice lg" id="coolGo">🧊 Cool it down</button>' + (demo ? '<button class="btn ghost lg" id="exampleBtn">See Ana’s example</button>' : '') + '</div>' +
        '<p class="honest"><span aria-hidden="true">🔒</span><span>What you type here is never saved — only the calm version, and only if you use it. The thermometer runs on your device; cooling it down is one AI call (well under a cent).</span></p>' +
        '<div id="coolErr"></div></div>' +
        '</div><div class="dk-sticky" id="coolOut"></div></div>';
      view.innerHTML = h;
      wireSignup(view);
      var ta = $('#ventBox');
      function live() {
        var ht = heatNow(ta.value);
        setThermo($('#liveThermo'), ht);
        $('#liveFlags').innerHTML = ta.value.trim() ? flagsHtml(ht) : '';
      }
      ta.oninput = function () { st.text = ta.value; live(); };
      $('#coolFor').onchange = function () { st.reviewId = this.value; live(); };
      live();
      var out = $('#coolOut');
      if (!demo && !st.text) out.innerHTML = '<div class="empty boxed"><div class="e">🌡️</div><h2>Let it out</h2><p>Type the reply you’d send if nobody was watching. Watch the thermometer — then let Rave cool it down.</p></div>';

      function showResult(res, animate) {
        st.result = res;
        var calm = res.calm;
        out.innerHTML =
          '<div class="card cooled" id="cooledCard">' +
          '<div class="duo"><div class="side"><span class="cap">Before</span>' + thermoHtml(res.heatBefore) + '</div><div class="arrow" aria-hidden="true">→</div><div class="side"><span class="cap">After</span>' + thermoHtml(animate ? res.heatBefore : res.heatAfter, 'afterThermo') + '</div></div>' +
          '<p class="center small muted" style="margin:0">' + (res.heatBefore.score - res.heatAfter.score > 0 ? 'Down ' + (res.heatBefore.score - res.heatAfter.score) + '°, from ' + esc(LEVEL[res.heatBefore.level].toLowerCase()) + ' to ' + esc(LEVEL[res.heatAfter.level].toLowerCase()) + '.' : 'Already cool — lightly polished.') + '</p>' +
          '<div class="calm"><label class="field" style="margin:0"><span>The one to post' + (demo ? ' (Ana’s, sample)' : ' — edit it if you like') + '</span><textarea class="input" id="calmBox"' + (demo ? ' readonly' : '') + '>' + esc(calm) + '</textarea></label></div>' +
          '<div id="calmLint"></div>' +
          '<div class="btn-row"><button class="btn ghost" id="calmCopy">' + ICON.copy + 'Copy</button>' + (res.reviewId ? '<button class="btn" id="calmUse">Use as my reply</button>' : '') + '</div>' +
          '</div>' +
          (res.removed.length ? '<div class="card"><div class="card-head"><h3>What we took out</h3><span class="sub">' + res.removed.length + '</span></div><ul class="removed">' + res.removed.map(function (x) {
            var k = RR.kindInfo(x.kind);
            return '<li><span class="e" aria-hidden="true">' + esc(k.emoji) + '</span><div class="grow"><b>' + esc(k.label) + '</b>' + (x.quote ? '<s>' + esc(x.quote) + '</s>' : '') + (x.why ? '<span>' + esc(x.why) + '</span>' : '') + '</div></li>';
          }).join('') + '</ul>' + (res.kept ? '<p class="small muted" style="margin:12px 0 0"><b>Kept:</b> ' + esc(res.kept) + '</p>' : '') + '</div>' : '');
        var cb = $('#calmBox');
        function calmLint() { $('#calmLint').innerHTML = lintHtml(RR.lint(cb.value, { stars: (ctx.reviews.filter(function (y) { return y.id === res.reviewId; })[0] || {}).stars, reviewer: reviewer(), contactLine: s.contactLine, others: [] })); }
        cb.oninput = function () { grow(cb); calmLint(); };
        calmLint();
        grow(cb);
        $('#calmCopy').onclick = function () { copy(cb.value, 'Calm reply copied'); };
        var use = $('#calmUse');
        if (use) use.onclick = function () {
          if (demo) return needAccount('Sign up free to cool down your own replies.');
          use.disabled = true;
          api('PUT', 'api/reviews/' + encodeURIComponent(res.reviewId) + '/reply', { text: cb.value, source: 'cooled' })
            .then(function () { toast('Saved as your reply. Cool head. 🧊'); location.hash = '#/review/' + encodeURIComponent(res.reviewId); })
            .catch(function (e) { use.disabled = false; showError(e); });
        };
        if (animate) {
          snow($('#cooledCard'));
          setTimeout(function () { setThermo($('#afterThermo'), res.heatAfter); }, reducedMotion() ? 0 : 350);
        }
        if (window.innerWidth < 1100) out.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      }

      $('#coolGo').onclick = function () {
        if (demo) return needAccount('Sign up free to cool down your own replies — the thermometer stays free.');
        if (ta.value.trim().length < 10) { showError(new Error('Type the reply you want to send first — at least a sentence.'), $('#coolErr')); return; }
        var btn = this; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Cooling…';
        $('#coolErr').innerHTML = '';
        api('POST', 'api/cooldown', { text: ta.value, reviewId: st.reviewId || undefined })
          .then(function (res) { btn.disabled = false; btn.innerHTML = '🧊 Cool it down again'; loadMe(); showResult(res, true); })
          .catch(function (e) { btn.disabled = false; btn.innerHTML = '🧊 Cool it down'; showError(e, $('#coolErr')); });
      };
      var ex = $('#exampleBtn');
      if (ex) ex.onclick = function () {
        var c = demo.cooldown;
        st.reviewId = c.reviewId; $('#coolFor').value = c.reviewId;
        ta.value = c.angry; st.text = c.angry; live();
        showResult({ calm: c.calm, removed: c.removed, kept: c.kept, heatBefore: c.heatBefore, heatAfter: c.heatAfter, reviewId: c.reviewId }, true);
      };
      if (demo && !pre) {
        // The sample opens on the example, drawn at rest.
        var c = demo.cooldown;
        ta.value = c.angry; st.text = c.angry; live();
        showResult({ calm: c.calm, removed: c.removed, kept: c.kept, heatBefore: c.heatBefore, heatAfter: c.heatAfter, reviewId: c.reviewId }, false);
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
      if (bh) h += '<path class="bar" d="M' + x + ' ' + (H - padB) + 'V' + (y + 4) + 'q0 -4 4 -4h' + (width - 8) + 'q4 0 4 4V' + (H - padB) + 'Z"><title>' + esc(names[i] + ': ' + m.avg + '★ from ' + m.count + ' review' + (m.count === 1 ? '' : 's')) + '</title></path>';
      h += '<text class="val" x="' + (x + width / 2) + '" y="' + (bh ? y - 7 : H - padB - 7) + '" text-anchor="middle">' + (m.avg == null ? '—' : esc(m.avg.toFixed(1))) + '</text>';
      h += '<text x="' + (x + width / 2) + '" y="' + (H - 7) + '" text-anchor="middle">' + esc(names[i]) + '</text>';
    });
    return h + '</svg>';
  }

  function drawScores(sb, badges, demo) {
    var st = sb.streak;
    var h = (demo ? sampleBar('Juniper & Rye’s scoreboard — invented reviews, real maths.') : '') +
      '<div class="page-head"><div><h1>Scoreboard</h1><div class="sub">How you’re doing, from ' + sb.total + ' review' + (sb.total === 1 ? '' : 's') + '.</div></div></div>';
    if (!sb.total) {
      view.innerHTML = h + '<div class="empty boxed"><div class="e">🏆</div><h2>No scores yet</h2><p>Add a few reviews and answer them — your response rate, reply time and streak show up here.</p><a class="btn" href="#/add">Add a review</a></div>';
      return;
    }
    var trend = sb.trend30;
    h += '<div class="kpis">' +
      '<div class="kpi"><b>' + (sb.responseRate == null ? '—' : sb.responseRate + '%') + '</b><span>Answered</span></div>' +
      '<div class="kpi"><b>' + esc(hoursLabel(sb.medianReplyHours)) + '</b><span>Median time to reply</span></div>' +
      '<div class="kpi"><b>' + (sb.avgRating == null ? '—' : sb.avgRating.toFixed(1) + '★') + (trend ? '<span class="delta ' + (trend > 0 ? 'up' : 'down') + '">' + (trend > 0 ? '▲' : '▼') + ' ' + Math.abs(trend).toFixed(1) + '</span>' : '') + '</b><span>Average rating' + (trend ? ' · vs prior 30 days' : '') + '</span></div>' +
      '<div class="kpi"><b>' + sb.waiting + '</b><span>Waiting' + (sb.urgentWaiting ? ' · ' + sb.urgentWaiting + ' urgent' : '') + '</span></div>' +
      '</div>';
    h += '<div class="dk-2" style="margin-top:12px"><div>';
    h += '<div class="card streak-card"><span class="flame" aria-hidden="true">' + (st.current ? '🔥' : st.todayZero ? '✨' : '🌱') + '</span><div><b>' + st.current + '</b> <span class="muted">day' + (st.current === 1 ? '' : 's') + ' at inbox zero</span><div class="small muted">' +
      (st.atRisk ? 'Something new landed today — answer it to keep the streak.' : st.current ? 'Every review answered, day after day. Best: ' + st.best + '.' : sb.waiting ? 'Answer the ' + sb.waiting + ' waiting to start a streak.' + (st.best ? ' Best so far: ' + st.best + '.' : '') : 'All answered — the streak starts tomorrow.') + '</div></div></div>';
    h += '<div class="card"><div class="card-head"><h3>Rating by month</h3><span class="sub">average stars</span></div>' + trendChart(sb.months) + '<p class="chart-note">By the date each review was posted. A month with no reviews shows a dash.</p></div>';
    h += '<div class="card"><div class="card-head"><h3>Stars</h3><span class="sub">' + sb.total + ' reviews</span></div><div class="dist">' + [5, 4, 3, 2, 1].map(function (n) {
      var c = sb.distribution[n] || 0; var p = sb.total ? Math.round(100 * c / sb.total) : 0;
      return '<div class="r"><span>' + n + '★</span><span class="t" role="img" aria-label="' + n + ' stars: ' + c + ' reviews"><i style="width:' + p + '%"></i></span><span class="num">' + c + '</span></div>';
    }).join('') + '</div></div>';
    h += '</div><div>';
    h += '<div class="card"><div class="card-head"><h3>Loved vs stings</h3><span class="sub">by topic</span></div>';
    if (sb.topics.length) {
      var max = Math.max.apply(null, sb.topics.map(function (t) { return Math.max(t.praise, t.complaints); }).concat([1]));
      h += '<div class="legend"><span><i style="background:var(--sting)"></i>Stings</span><span><i style="background:var(--praise)"></i>Loved</span></div><div class="topic-rows">' + sb.topics.slice(0, 8).map(function (t) {
        return '<div class="topic-row"><div class="name ellip">' + esc(t.emoji) + ' ' + esc(t.label) + '</div><div class="bars" role="img" aria-label="' + esc(t.label) + ': ' + t.praise + ' loved, ' + t.complaints + ' stings">' +
          '<span class="n" aria-hidden="true">' + (t.complaints || '') + '</span><div class="l"><i style="width:' + (100 * t.complaints / max) + '%"></i></div><div class="r"><i style="width:' + (100 * t.praise / max) + '%"></i></div><span class="n" aria-hidden="true">' + (t.praise || '') + '</span></div></div>';
      }).join('') + '</div>';
      var tp = sb.topPraise, tc = sb.topComplaint;
      h += '<p class="chart-note">' + (tp ? 'People love <b>' + esc(tp.label.toLowerCase()) + '</b> most' : '') + (tp && tc ? '; ' : '') + (tc ? 'the most common sting is <b>' + esc(tc.label.toLowerCase()) + '</b>' : '') + '. From each review’s triage — keywords, or the deeper read where you ran one.</p>';
    } else {
      h += '<p class="small muted" style="margin:0">Topics appear as reviews mention food, staff, the wait, the price…</p>';
    }
    h += '</div>';
    var earned = badges.filter(function (b) { return b.earnedAt; }).length;
    h += '<div class="section-title"><h2>Badges</h2><span class="count">' + earned + ' of ' + badges.length + '</span></div><div class="badges">' + badges.map(function (b) {
      return '<div class="badge ' + (b.earnedAt ? 'earned' : 'locked') + '"><span class="e" aria-hidden="true">' + esc(b.emoji) + '</span><b>' + esc(b.label) + '</b><span>' + esc(b.desc) + '</span>' +
        (b.earnedAt ? '<div class="tiny faint" style="margin-top:6px">' + (demo ? 'Earned' : 'Earned ' + esc(fmtDay(b.earnedAt))) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
    h += '</div></div>';
    view.innerHTML = h;
    wireSignup(view);
  }

  function renderScores() {
    loading();
    if (!signedIn()) return loadDemo().then(function (d) { drawScores(d.scoreboard, d.badges, true); }).catch(function (e) { showError(e, view); });
    api('GET', 'api/scoreboard').then(function (sb) { drawScores(sb, sb.badges, false); }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- the wall of love ---------------- */

  function wallHtml(w, opts) {
    opts = opts || {};
    var plats = [];
    w.reviews.forEach(function (r) { if (plats.indexOf(r.platform) < 0) plats.push(r.platform); });
    var h = '<div class="wall-head">' + (w.business.name ? '<div class="biz">' + esc(w.business.name) + '</div>' : '') + '<h1>' + esc(w.title) + '</h1>' +
      '<p>Hand-picked by ' + esc(w.business.name || 'the business') + ' from ' + esc(plats.join(', ') || 'their') + ' reviews. First names only.</p></div>';
    if (!w.reviews.length) return h + '<div class="empty boxed"><div class="e">💛</div><h2>No reviews on the wall yet</h2><p>Heart your favourite 4 and 5 star reviews and they appear here.</p></div>';
    h += '<div class="wall">' + w.reviews.map(function (r) {
      return '<article class="love">' + starsHtml(r.stars) + '<p class="text">“' + esc(r.text) + '”</p><div class="by"><span>— ' + esc(r.name) + '</span><span>' + esc(r.platform) + ' · ' + esc(fmtDay(r.date, { year: 'numeric' })) + '</span></div>' +
        (r.reply ? '<div class="reply"><b>Reply from ' + esc(w.business.name || 'the owner') + '</b>' + esc(r.reply) + '</div>' : '') + '</article>';
    }).join('') + '</div>';
    return h;
  }

  function renderWall() {
    loading();
    if (!signedIn()) {
      return loadDemo().then(function (d) {
        view.innerHTML = sampleBar('Juniper & Rye’s wall — a public page they link from their own website.') +
          '<div class="page-head"><div><h1>Wall of love</h1><div class="sub">Heart your best reviews; publish one page you can link anywhere.</div></div></div>' +
          '<div class="card" style="padding:4px 16px 16px">' + wallHtml(d.wall) + '</div>';
        wireSignup(view);
      }).catch(function (e) { showError(e, view); });
    }
    api('GET', 'api/wall').then(function (w) { drawWall(w); }).catch(function (e) { showError(e, view); });
  }

  function drawWall(w) {
    var favs = w.candidates.filter(function (c) { return c.favourite; }).length;
    var h = '<div class="page-head"><div><h1>Wall of love</h1><div class="sub">Heart your best reviews, then publish one page to link from your website.</div></div></div>';
    h += '<div class="dk-2"><div>';
    h += '<div class="card"><div class="card-head"><h3>' + (w.share ? 'Published' : 'Publish') + '</h3>' + (w.share ? '<span class="sub">copy of ' + esc(fmtDay(String(w.share.sharedAt || '').slice(0, 10))) + '</span>' : '') + '</div>' +
      '<label class="field"><span>Title</span><input class="input" id="wTitle" maxlength="80" placeholder="What our customers say" value="' + esc(w.title) + '"></label>' +
      '<label class="check" style="margin-bottom:12px"><input type="checkbox" id="wReplies"' + (w.showReplies ? ' checked' : '') + '><span>Show my replies under each review (only ones marked replied)</span></label>';
    if (w.share) {
      var url = location.origin + BASE + w.share.url;
      h += '<div class="share-box"><input class="input" id="shareUrl" readonly value="' + esc(url) + '" aria-label="Wall link"><button class="btn small" id="cpShare">Copy</button></div>' +
        '<div class="more-actions"><button class="btn small ghost" id="pubBtn">Update the copy</button><a class="btn small ghost" href="' + esc(BASE + w.share.url) + '" target="_blank" rel="noopener">Open</a><button class="btn small danger" id="rvBtn">Revoke</button></div>' +
        '<p class="small muted" style="margin:10px 0 0">The link shows a frozen copy — hearting or deleting a review changes nothing until you tap Update. Revoke it and the link is dead for good.</p>';
    } else {
      h += '<button class="btn block" id="pubBtn"' + (favs ? '' : ' disabled') + '>Publish ' + favs + ' review' + (favs === 1 ? '' : 's') + '</button>' +
        '<p class="small muted" style="margin:10px 0 0">A public, read-only page — first names only, no account needed to view it. Only 4 and 5 star reviews can go on it.</p>';
    }
    h += '<div id="wErr"></div></div>';
    h += '<div class="section-title"><h2>Your 4 and 5 star reviews</h2><span class="count">' + favs + ' on the wall</span></div>';
    h += w.candidates.length ? '<div class="group">' + w.candidates.map(function (c) {
      return '<div class="pick-row"><div class="grow"><b>' + esc(c.displayName) + ' ' + starsHtml(c.stars) + '</b><span class="ex">' + esc(c.excerpt) + '</span></div>' +
        '<button class="heart' + (c.favourite ? ' on' : '') + '" data-fav="' + esc(c.id) + '" aria-pressed="' + c.favourite + '" aria-label="' + (c.favourite ? 'Remove ' : 'Add ') + esc(c.displayName) + (c.favourite ? ' from' : ' to') + ' the wall">' + (c.favourite ? '♥' : '♡') + '</button></div>';
    }).join('') + '</div>' : '<div class="empty boxed"><div class="e">⭐</div><h2>No 4 or 5 star reviews yet</h2><p>They’ll be here to pick from as they come in.</p></div>';
    h += '</div><div class="dk-sticky"><div class="section-title" style="margin-top:4px"><h2>Preview</h2><span class="count">' + (w.share ? 'next update' : 'before you publish') + '</span></div><div class="card" style="padding:4px 16px 16px">' + wallHtml(w.preview) + '</div></div></div>';
    view.innerHTML = h;
    $$('[data-fav]').forEach(function (b) {
      b.onclick = function () {
        var on = !b.classList.contains('on');
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
    document.body.classList.remove('dk');
    loading();
    api('GET', 'api/shared/' + token).then(function (w) {
      document.title = w.title + (w.business.name ? ' · ' + w.business.name : '');
      view.style.maxWidth = '1100px';
      view.innerHTML = (w.preview ? '<div class="banner" style="margin-bottom:12px"><span class="e">👀</span><span>This is what visitors see — a frozen copy. Update it from the Wall tab.</span></div>' : '') +
        wallHtml(w, { public: true }) +
        '<p class="center small faint" style="margin-top:22px">Reviews collected with <a href="./">Rave ⭐</a></p>';
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><div class="e">🔒</div><h2>This link isn’t valid</h2><p>' + esc(e.message) + '</p></div>';
    });
  }

  /* ---------------- settings: your voice ---------------- */

  function renderSettings() {
    if (!signedIn()) return pitch('🎙️', 'Replies in your own voice', 'Your name, your sign-off, your tone, what to always and never say, and how an unhappy customer can reach you. Every reply uses them.');
    loading();
    api('GET', 'api/settings').then(function (s) {
      var tone = s.tone || 'warm';
      view.innerHTML =
        '<div class="page-head"><div><h1>Your voice</h1><div class="sub">Every reply — drafted, templated or cooled down — uses these.</div></div></div>' +
        '<div class="dk-2"><div>' +
        '<div class="group-title">Your business</div><div class="group">' +
        '<div class="cell"><label for="sBiz">Business</label><input id="sBiz" value="' + esc(s.businessName) + '" maxlength="80" placeholder="Juniper & Rye"></div>' +
        '<div class="cell"><label for="sWhat">What you do</label><input id="sWhat" value="' + esc(s.what) + '" maxlength="60" placeholder="neighbourhood café"></div>' +
        '<div class="cell"><label for="sName">Your name</label><input id="sName" value="' + esc(s.ownerName) + '" maxlength="60" placeholder="Ana"></div>' +
        '<div class="cell"><label for="sSign">Sign-off</label><input id="sSign" value="' + esc(s.signOff) + '" maxlength="60" placeholder="Warmly,"></div></div>' +
        '<div class="group-title">Tone</div><div class="group"><div class="cell stack">' +
        '<div class="seg" id="toneSeg" role="group" aria-label="Tone">' + TONES.map(function (t) { return '<button data-tone="' + t.key + '">' + esc(t.label) + '</button>'; }).join('') + '</div>' +
        '<p class="small muted" id="tonePrev" style="margin:6px 0 0"></p></div></div>' +
        '<p class="hint">Playful stays warm and straight on 1–2 star reviews — nobody wants a joke about their bad night.</p>' +
        '</div><div>' +
        '<div class="group-title">Taking it offline</div><div class="group">' +
        '<div class="cell stack"><label for="sContact">How an unhappy customer reaches you</label><input id="sContact" value="' + esc(s.contactLine) + '" maxlength="160" placeholder="ana@yourcafe.com or (555) 010-2277"></div></div>' +
        '<p class="hint">Used in replies to 1–2 star and sensitive reviews. It’s the one contact detail the checklist lets through.</p>' +
        '<div class="group-title">House rules</div><div class="group">' +
        '<div class="cell stack"><label for="sAlways">Always say</label><textarea id="sAlways" maxlength="300" placeholder="We bake everything in-house every morning.">' + esc(s.alwaysSay) + '</textarea></div>' +
        '<div class="cell stack"><label for="sNever">Never say</label><textarea id="sNever" maxlength="300" placeholder="Never offer refunds or free food in a public reply.">' + esc(s.neverSay) + '</textarea></div></div>' +
        '<p class="hint">These guide the AI drafts and cool-downs. Templates use your name, sign-off, tone and contact line.</p>' +
        '<div id="sErr"></div><button class="btn block lg" id="sSave" style="margin-top:18px">Save</button>' +
        '</div></div>';
      function drawTone() {
        $$('#toneSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.tone === tone); b.setAttribute('aria-pressed', String(b.dataset.tone === tone)); });
        $('#tonePrev').textContent = TONES.filter(function (t) { return t.key === tone; })[0].ex;
      }
      $$('#toneSeg button').forEach(function (b) { b.onclick = function () { tone = b.dataset.tone; drawTone(); }; });
      drawTone();
      $('#sSave').onclick = function () {
        var btn = this; btn.disabled = true;
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
