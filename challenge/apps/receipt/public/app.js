/* Receipt - the page. One file, no build step, every typed or model-written
 * string escaped. The meter, the rings and the receipt are drawn with the
 * same public/rules.js the server answers with. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');
  var R = window.ReceiptRules;
  var QR = window.ReceiptQR;

  // Where the app is mounted: '/' on its own, '/receipt/' inside the lab. The
  // shared receipt (s/<token>) and the room (r/<code>) live one level down
  // with <base href="../">, so the base comes from the document's base URI.
  var BASE = new URL('.', document.baseURI).pathname;
  var PUB = location.pathname.match(/\/s\/([A-Za-z0-9_-]{22,40})\/?$/);
  var ROOM = location.pathname.match(/\/r\/([A-Za-z0-9-]{8,12})\/?$/i);

  var state = { me: null, demo: null, skew: 0, timers: [], sound: recall('receipt-sound') !== false, live: null };

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var enc = encodeURIComponent;
  function now() { return Date.now() + state.skew; }
  function localDay() { var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

  function api(method, path, body) {
    var headers = { 'x-local-date': localDay() };
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
  function ping(emoji, msg) {
    $$('.ping').forEach(function (p) { p.remove(); });
    var t = document.createElement('div');
    t.className = 'ping'; t.setAttribute('role', 'status');
    t.innerHTML = '<span class="e" aria-hidden="true">' + esc(emoji) + '</span><span>' + esc(msg) + '</span>';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  /** A 402 is a till, not a wall: say what happened and where to go. */
  function showError(err, where) {
    if (err && err.status === 402) return openCreditSheet(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.', 'login');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<div class="err" role="alert">' + esc(msg) + '</div>'; else toast(msg, 3500);
  }

  function fmtDay(iso, opts) {
    if (!iso) return '';
    return new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }, opts || {}));
  }
  function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it.'); });
  }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function every(ms, fn) { var t = setInterval(fn, ms); state.timers.push(t); return t; }
  function stopTimers() { state.timers.forEach(clearInterval); state.timers = []; state.live = null; document.body.classList.remove('live-mode'); }
  function visible() { return document.visibilityState !== 'hidden'; }
  function initials(s) { return String(s || '?').split(/[\s@.]+/).filter(Boolean).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function usd(n) { return R.money(n, true); }
  /** $1,234.56 with the cents a size down. */
  function bigUsd(n) {
    var s = R.money(n, true);
    var i = s.lastIndexOf('.');
    return esc(s.slice(0, i)) + '<small>' + esc(s.slice(i)) + '</small>';
  }
  function gaps(text) { return esc(text).replace(/\[add:[^\]]{0,60}\]/g, function (m) { return '<span class="gap">' + m + '</span>'; }); }

  function confetti() {
    if (reducedMotion()) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var colors = ['#2fb58f', '#fbf8f0', '#d9a21b', '#e5484d', '#3fa7d6'];
    for (var i = 0; i < 90; i++) {
      var p = document.createElement('i');
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = Math.random() * 0.5 + 's';
      p.style.animationDuration = 1.3 + Math.random() * 1.1 + 's';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3200);
  }

  /** A gentle two-note chime and a buzz, once per item that runs over. */
  function chime() {
    try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch (e) { /* no vibration */ }
    if (!state.sound) return;
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      state.ac = state.ac || new C();
      var ac = state.ac;
      [660, 880].forEach(function (f, i) {
        var o = ac.createOscillator(); var g = ac.createGain(); var t0 = ac.currentTime + i * 0.18;
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);
        o.connect(g); g.connect(ac.destination); o.start(t0); o.stop(t0 + 0.45);
      });
    } catch (e) { /* no audio */ }
  }

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  };

  /* ---------------- me and the top bar ---------------- */

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
      el.innerHTML = '<a class="btn small ghost" href="#/sample">Try a meeting</a><button class="btn small" id="signInTop">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(null, 'login'); };
      return;
    }
    var b = me.budget || {};
    var live = (me.live || [])[0];
    el.innerHTML = (live ? '<a class="pill live" href="#/m/' + enc(live.id) + '" title="Live now: ' + esc(live.title) + '"><span class="lt">' + esc(live.title) + '</span><span class="ls">Live</span></a>' : '') +
      '<span class="pill credit" title="AI credit">' + (b.unlimited ? '∞' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span>' +
      '<button class="avatar-btn" id="acctBtn" aria-label="Account">' + esc(initials(me.email)) + '</button>';
    $('#acctBtn').onclick = function () { openAccount(); };
  }

  /* ---------------- sheets ---------------- */

  /**
   * A modal sheet. It has a visible Close (screen readers cannot reach the
   * scrim and phones have no Escape), is named by its first heading, keeps
   * Tab inside itself, and gives focus back to whatever opened it.
   * `onMount` and the return value get the sheet's body, which a sheet may
   * redraw freely - the Close button sits outside it.
   */
  var sheetOpener = null;
  function sheet(html, onMount) {
    // Replacing one sheet with another keeps the ORIGINAL opener.
    var opener = $('#scrim') ? sheetOpener : document.activeElement;
    closeSheet(true);
    sheetOpener = opener;
    var scrim = document.createElement('div');
    scrim.className = 'scrim'; scrim.id = 'scrim';
    scrim.innerHTML = '<div class="sheet dk-sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" tabindex="-1">' +
      '<button type="button" class="sheet-x" aria-label="Close">×</button><div class="grab" aria-hidden="true"></div><div class="sheet-body">' + html + '</div></div>';
    var dlg = scrim.firstChild;
    var body = $('.sheet-body', dlg);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
    $('.sheet-x', dlg).onclick = function () { closeSheet(); };
    document.body.appendChild(scrim);
    if (onMount) onMount(body);
    labelSheet();
    var f = scrim.querySelector('.sheet-body input:not([type=checkbox]):not([type=date]):not([readonly]), .sheet-body textarea');
    setTimeout(function () { try { (f || dlg).focus(); } catch (e) { /* ignore */ } }, 50);
    return body;
  }
  /** The first heading names the dialog; call again after a sheet redraws. */
  function labelSheet() { var h = $('#scrim .sheet h2'); if (h) h.id = 'sheetTitle'; }
  function closeSheet(keepFocus) {
    var s = $('#scrim');
    state.after = null;
    if (!s) return;
    s.remove();
    var o = sheetOpener;
    sheetOpener = null;
    if (!keepFocus && o && o.isConnected && o.focus) { try { o.focus(); } catch (e) { /* ignore */ } }
  }
  function focusables(root) {
    return $$('button, [href], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])', root)
      .filter(function (x) { return !x.disabled && x.offsetParent !== null; });
  }
  /** Tab and Shift-Tab wrap inside an open sheet; nothing behind it takes focus. */
  function trapTab(e) {
    var dlg = $('#scrim .sheet');
    if (!dlg) return;
    var f = focusables(dlg);
    if (!f.length) return;
    var first = f[0]; var last = f[f.length - 1]; var a = document.activeElement;
    if (!dlg.contains(a)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && (a === first || a === dlg)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeSheet(); var q = $('.qr-big'); if (q) q.remove(); }
    if (e.key === 'Tab') trapTab(e);
  });

  /** The account sheet. `startMode` 'login' for someone coming back (the
   *  header's Sign in, an expired session, a link to a meeting); 'register'
   *  for the Start free and New buttons. */
  function openAccount(reason, startMode) {
    if (signedIn()) return openProfileSheet();
    var mode = startMode === 'login' ? 'login' : 'register';
    function draw(root) {
      root.innerHTML =
        '<h2>' + (mode === 'register' ? 'Every meeting gets a receipt — free.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'The live meter, the timeboxed agenda, the log, the room vote, bingo, the receipt, the audit and the scoreboard are free forever. You also get $2 of AI credit for sharpening agendas and writing recaps — about a cent each. One account works across every app on this site.'
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
      labelSheet();
      $('#swap', root).onclick = function () { mode = mode === 'register' ? 'login' : 'register'; draw(root); var em = $('[name=email]', root); if (em) em.focus(); };
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
    // Where they were headed before the sign-in got in the way (a link to a
    // meeting), read before closeSheet() forgets it.
    var after = state.after;
    closeSheet(true);
    return loadMe().then(function () {
      toast('You’re in.');
      if (after && location.hash !== after) location.hash = after;
      else if (!after && /^#\/sample/.test(location.hash)) location.hash = '#/';
      else route();
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
      '<div class="bar-cost" style="height:10px;margin-top:10px"><i style="width:' + pct + '%;background:var(--m-ok)"></i></div>' +
      '<p class="small muted" style="margin:10px 0 0">Sharpening an agenda costs about a cent; so does a recap (a few cents with a whiteboard photo). The meter, the room, the receipt, the audit and the scoreboard are free.</p>' +
      '<div id="billing" style="margin-top:12px"></div></div>' +
      '<label class="toggle" style="margin-bottom:10px"><input type="checkbox" id="soundT"' + (state.sound ? ' checked' : '') + '><span class="sw"></span><span><b>Chime when an item runs over</b><small>Your phone also buzzes, where it can.</small></span></label>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" style="margin-top:10px">Sign out</button>',
      function (root) {
        $('#soundT', root).onchange = function (e) { state.sound = e.target.checked; store('receipt-sound', state.sound); };
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); location.hash = '#/'; route(); });
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
      '<p class="muted small">Everything else keeps working: the meter, the agenda rings, the log, the room vote, bingo, the receipt, the free recap template, the audit and the scoreboard cost nothing.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- routing ---------------- */

  function tabFor(parts) {
    if (parts[0] === 'sample') return parts[1] === 'audit' ? 'audit' : parts[1] === 'score' ? 'score' : 'meetings';
    if (parts[0] === 'new') return 'new';
    if (parts[0] === 'audit') return 'audit';
    if (parts[0] === 'score') return 'score';
    return 'meetings';
  }

  function route() {
    closeSheet();
    stopTimers();
    $$('.ping, .qr-big').forEach(function (p) { p.remove(); });
    if (PUB) return renderShared(PUB[1]);
    if (ROOM) return renderRoom(ROOM[1]);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return ''; } });
    var tab = tabFor(parts);
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    window.scrollTo(0, 0);
    if (parts[0] === 'sample') return renderSample(parts[1] || 'live');
    if (parts[0] === 'join') return renderJoin();
    if (!signedIn() && ['audit', 'score'].indexOf(parts[0]) >= 0) {
      location.hash = parts[0] === 'audit' ? '#/sample/audit' : '#/sample/score';
      return;
    }
    if (!signedIn() && (parts[0] === 'new' || parts[0] === 'm')) {
      // The home page under a sign-in sheet. The hash is replaced, not set:
      // a hashchange would route again and close the sheet it opened.
      var want = location.hash;
      history.replaceState(null, '', location.pathname + location.search + '#/');
      $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === 'meetings'); });
      renderHome();
      if (parts[0] === 'new') openAccount('Make a free account to run your own meetings.');
      else { openAccount('Sign in to open this meeting.', 'login'); state.after = want; }
      return;
    }
    if (parts[0] === 'new') return renderSetup(null);
    if (parts[0] === 'm' && parts[1]) return renderMeeting(parts[1], parts[2] || '');
    if (parts[0] === 'audit') return renderAudit();
    if (parts[0] === 'score') return renderScore();
    return signedIn() ? renderMeetings() : renderHome();
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () {
      var t = b.dataset.tab;
      if (!signedIn()) {
        if (t === 'new') return openAccount('Make a free account to run your own meetings.');
        location.hash = { meetings: '#/sample', audit: '#/sample/audit', score: '#/sample/score' }[t];
        return;
      }
      location.hash = { meetings: '#/', new: '#/new', audit: '#/audit', score: '#/score' }[t];
    };
  });
  // Until we know who is signed in, a hash change would route as signed out.
  var ready = false;
  window.addEventListener('hashchange', function () { if (ready) route(); });

  function loading() { view.innerHTML = '<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading…</span></div>'; }
  function backLink(href, label) { return '<a class="back" href="' + href + '">' + ICON.back + esc(label) + '</a>'; }
  function sampleBar(what) {
    return '<div class="sample-bar"><span><b>SAMPLE</b> · ' + esc(what || 'A made-up weekly marketing sync — real rules, no AI used, nothing saved.') + '</span>' +
      (signedIn() ? '<a class="btn small" href="#/new">Run your own</a>' : '<button class="btn small" data-signup>Start free</button>') + '</div>';
  }
  function wireSignup(root) { $$('[data-signup]', root || view).forEach(function (b) { b.onclick = function () { openAccount(); }; }); }
  function subnav(cur) {
    var items = [['live', 'Live meeting'], ['receipt', 'The receipt'], ['sharpen', 'Sharpener & recap'], ['audit', 'Audit'], ['score', 'Scoreboard']];
    return '<nav class="subnav" aria-label="Sample">' + items.map(function (x) {
      return '<a href="#/sample' + (x[0] === 'live' ? '' : '/' + x[0]) + '"' + (x[0] === cur ? ' class="on" aria-current="page"' : '') + '>' + esc(x[1]) + '</a>';
    }).join('') + '</nav>';
  }
  /** The subnav scrolls sideways on a phone; bring the current pill into
   *  view, or the reader cannot tell where they are or that more follow. */
  function centerSubnav() {
    var nav = $('.subnav'); var on = $('.subnav .on');
    if (!nav || !on) return;
    var n = nav.getBoundingClientRect(); var o = on.getBoundingClientRect();
    nav.scrollLeft += (o.left + o.width / 2) - (n.left + n.width / 2);
  }
  // A link to the page you are on changes no hash, so nothing would happen:
  // the current subnav pill runs the page again (the sample, from the top).
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('.subnav a[aria-current]');
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); route(); }
  });

  /* ---------------- the receipt (paper) ---------------- */

  function receiptHTML(r, opts) {
    opts = opts || {};
    var numbersOnly = opts.numbersOnly;
    // Compact: the home page's peek - the lines that make the point.
    var compact = opts.compact;
    var ln = function (a, b, cls) { return '<div class="ln' + (cls ? ' ' + cls : '') + '"><span>' + a + '</span><span>' + b + '</span></div>'; };
    var h = '<div class="paper" id="paper">';
    h += '<div class="hd"><div class="logo" aria-hidden="true">🧾</div><div class="ttl">MEETING RECEIPT</div>' +
      (numbersOnly ? '' : '<div class="nm">' + esc(r.title || 'A meeting') + '</div>') +
      '<div class="dim">' + esc(fmtDay(r.day || r.startedAt, { year: 'numeric' })) + (r.startedAt ? ' · ' + esc(fmtTime(r.startedAt)) + (r.endedAt ? '–' + esc(fmtTime(r.endedAt)) : '') : '') + '</div></div><hr>';
    h += ln('DURATION', esc(R.durText(r.durationMs))) + ln('BOOKED', esc(R.durText(r.bookedMs))) + ln('HEADCOUNT', esc(r.headcount));
    if (!compact) (r.people || []).forEach(function (p) {
      h += '<div class="sub">' + ln(esc(p.count + ' × ' + (p.label || R.bandInfo(p.band).label) + ' @ ' + R.money(p.rate) + '/h'), esc(usd(p.costUsd))) + '</div>';
    });
    if (r.loaded) h += '<div class="sub dim">Loaded cost, ×' + R.LOADED + '</div>';
    if (compact) {
      (r.items || []).filter(function (it) { return it.overUsd >= 1; }).forEach(function (it) {
        h += ln(esc(it.title), '+' + esc(R.money(it.overUsd)), 'red');
      });
    } else if ((r.items || []).length) {
      h += '<hr>' + ln('<b>AGENDA</b>', '<span class="dim">PLAN → ACTUAL</span>');
      r.items.forEach(function (it) {
        var name = numbersOnly || !it.title ? 'Item ' + it.n : it.title;
        var act = it.actualMs == null ? (it.state === 'skipped' ? 'skipped' : '–') : R.durText(it.actualMs);
        h += ln(esc(name), esc(Math.round(it.plannedMs / R.MIN) + 'm → ' + act), it.overUsd >= 1 ? 'red' : '');
        if (it.overUsd >= 1) h += '<div class="sub red">' + ln('over by ' + esc(R.durText(it.overMs)), '+' + esc(R.money(it.overUsd))) + '</div>';
      });
      if (r.afterMs >= R.MIN) h += ln('After the agenda', esc(R.durText(r.afterMs)), 'dim');
    }
    h += '<hr>' + ln('DECISIONS', esc(r.counts.decision));
    if (compact) numbersOnly = true;
    if (!numbersOnly) (r.decisions || []).forEach(function (d) { h += '<div class="bul">✓ ' + esc(d.text) + '</div>'; });
    if (!compact) h += ln('ACTIONS', esc(r.counts.action));
    if (!numbersOnly) (r.actions || []).forEach(function (a) { h += '<div class="bul">→ ' + esc(a.text) + (a.owner ? ' <span class="dim">· ' + esc(a.owner) + '</span>' : '') + (a.due ? ' <span class="dim">· due ' + esc(R.fmtDue(a.due)) + '</span>' : '') + '</div>'; });
    if (!compact) h += ln('PARKING LOT', esc(r.counts.parking));
    if (!numbersOnly) (r.parking || []).forEach(function (p) { h += '<div class="bul">P ' + esc(p.text) + '</div>'; });
    h += ln('COST PER DECISION', r.costPerDecision == null ? '<span class="red">NO DECISIONS</span>' : esc(R.money(r.costPerDecision)), 'big');
    h += '<hr>' + (compact ? '' : ln('PERSON-HOURS', esc((Math.round(r.personHours * 10) / 10).toFixed(1))));
    h += ln('TOTAL', esc(usd(r.costUsd)), 'total');
    if (r.compare) h += '<div class="dim" style="text-align:right">≈ ' + esc(r.compare.text) + ' ' + esc(r.compare.emoji) + '</div>';
    h += '<hr>';
    var roti = r.roti || { n: 0, dist: [0, 0, 0, 0, 0] };
    h += ln('ROTI · WORTH IT?', roti.n ? esc(roti.avg.toFixed(1)) + '/4' : '<span class="dim">no votes</span>', 'big');
    if (roti.n && !compact) {
      var max = Math.max.apply(null, roti.dist.concat([1]));
      h += '<div class="roti-bar" aria-hidden="true">' + roti.dist.map(function (n) { return '<i style="height:' + Math.round(n / max * 100) + '%"></i>'; }).join('') + '</div>' +
        '<div class="roti-axis" aria-hidden="true"><span>0</span><span>1</span><span>2</span><span>3</span><span>4</span></div>' +
        '<div class="dim" style="font-size:12px">' + esc(R.plural(roti.n, 'vote')) + ' from the room</div>';
    }
    h += ln('COULD HAVE BEEN AN EMAIL', esc(r.emailVotes) + (r.voters ? ' <span class="dim">of ' + esc(r.voters) + '</span>' : ''));
    if (r.bingo) h += ln('BINGO', esc(r.bingo.handle));
    if (r.givenBackMs >= R.MIN) {
      h += '<div class="given">TIME GIVEN BACK · ' + esc(R.minText(r.givenBackMs).toUpperCase()) + '</div>' +
        '<div class="center dim" style="font-size:12px;margin-top:8px">' + esc(Math.round(r.personMinutesGivenBack)) + ' person-minutes back to the team</div>';
    } else if (r.overrunMs > R.LIMITS.graceMs) {
      h += '<div class="overtime">OVER TIME · ' + esc(R.durText(r.overrunMs).toUpperCase()) + '</div>';
    }
    h += '<hr><div class="verdict">' + esc(r.verdict.emoji) + ' ' + esc(r.verdict.text) + '</div>';
    h += '<div class="barcode" aria-hidden="true"></div>';
    if (compact) return h + '</div>';
    h += '<div class="foot">Estimates from role-band rates, not salaries.<br>THANK YOU FOR YOUR TIME</div>';
    return h + '</div>';
  }

  /** The receipt as a PNG, drawn line by line from the same text receipt the
   *  "Copy as text" button uses. */
  function receiptPNG(r, opts) {
    var lines = R.receiptText(r, opts).split('\n');
    var scale = 2;
    var fs = 14;
    var lh = 20;
    var pad = 26;
    var c = document.createElement('canvas');
    var ctx = c.getContext('2d');
    var font = fs + 'px ui-monospace, Menlo, Consolas, "Courier New", monospace';
    ctx.font = font;
    var w = Math.ceil(Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; }))) + pad * 2;
    var hgt = pad * 2 + lines.length * lh + 60;
    c.width = w * scale; c.height = (hgt + 12) * scale;
    ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#fbf8f0';
    ctx.fillRect(0, 0, w, hgt);
    // The torn edge.
    ctx.beginPath();
    ctx.moveTo(0, hgt);
    for (var x = 0; x <= w; x += 12) { ctx.lineTo(x + 6, hgt + 10); ctx.lineTo(x + 12, hgt); }
    ctx.lineTo(w, hgt); ctx.closePath(); ctx.fill();
    ctx.textBaseline = 'top';
    lines.forEach(function (l, i) {
      var bold = /MEETING RECEIPT|^TOTAL|TIME GIVEN BACK|COST PER DECISION/.test(l);
      ctx.font = (bold ? 'bold ' : '') + font;
      ctx.fillStyle = /TIME GIVEN BACK/.test(l) ? '#146c43' : /OVER TIME|over +\+/.test(l) ? '#b3261e' : '#1d1b17';
      ctx.fillText(l, pad, pad + i * lh);
    });
    // A barcode, for the look of it.
    ctx.fillStyle = '#1d1b17';
    var bx = pad; var by = pad + lines.length * lh + 14;
    for (var i = 0; bx < w - pad; i++) { var bw = [2, 1, 3, 1, 2][i % 5]; ctx.fillRect(bx, by, bw, 34); bx += bw + [2, 3, 1, 2, 3][i % 5]; }
    return c;
  }
  function downloadPNG(r, opts, name) {
    var c = receiptPNG(r, opts);
    c.toBlob(function (blob) {
      if (!blob) return toast('Could not draw the image here.');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name || 'meeting-receipt.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast('Receipt saved as an image');
    }, 'image/png');
  }
  function tear() {
    var p = $('#paper');
    if (!p) return;
    p.classList.remove('torn'); void p.offsetWidth; p.classList.add('torn');
    if (!reducedMotion()) { try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) { /* ignore */ } }
    toast('✂️ Torn off. Save it, copy it or share it.');
  }
  function fileName(r) { return 'receipt-' + String(r.title || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + (r.day || 'day') + '.png'; }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    loadDemo().then(function (d) {
      var a = R.audit(d.audit);
      view.innerHTML =
        '<section class="hero"><div class="hero-grid"><div>' +
        '<span class="kicker">🧾 Free for every meeting</span>' +
        '<h1>Every meeting gets a <em>receipt.</em></h1>' +
        '<p>A live price on the meeting while it runs, a timeboxed agenda that shows overruns in dollars, one tap to log a decision, and the room’s own vote from their phones. At the end, a receipt — with <b>TIME GIVEN BACK</b> when you finish early.</p>' +
        '<div class="ctas"><a class="btn lg" href="#/sample">▶ Try a meeting</a><button class="btn lg ghost" data-signup>Start free</button></div>' +
        '<div class="trust"><span>✓ Role bands, never salaries</span><span>✓ The room votes with no account</span><span>✓ Free forever, AI optional</span></div>' +
        '</div><div class="peek"><a href="#/sample/receipt" style="text-decoration:none;width:100%;display:flex;justify-content:center;padding-bottom:12px" aria-label="See the sample receipt">' + receiptHTML(d.receipt, { compact: true }) + '</a></div></div></section>' +
        '<div class="steps">' +
        '<div class="step"><div class="ic">⏱️</div><h3>Run it live</h3><p>A ticker in dollars and person-hours, rings on every agenda item, and a red “$38 over” when one runs long.</p></div>' +
        '<div class="step"><div class="ic">🗳️</div><h3>Let the room vote</h3><p>Everyone scans a QR code: “could have been an email”, a 0–4 worth-it vote, and optional buzzword bingo.</p></div>' +
        '<div class="step"><div class="ic">🧾</div><h3>Print the receipt</h3><p>Cost by role, per item, per decision, the room’s verdict — and the time you gave back. Share numbers only.</p></div>' +
        '<div class="step"><div class="ic">🪓</div><h3>Audit the repeats</h3><p>List the recurring ones, see what each costs a year, and swipe Keep, Shrink or Kill.</p></div>' +
        '</div>' +
        '<a class="card" href="#/sample/audit" style="display:block;margin-top:16px;text-decoration:none;color:inherit"><div class="row spread wrap-row"><div><div class="eyebrow">Sample audit</div><b style="font-size:20px">' + esc(a.rows[0].r.title) + ': ' + esc(R.money(a.rows[0].annual)) + '/yr</b>' +
        '<div class="small muted">Six recurring meetings cost ' + esc(R.money(a.totalAnnual)) + ' a year. Swipe them →</div></div><span class="btn small ghost">Keep · Shrink · Kill</span></div></a>' +
        '<div class="card" style="margin-top:12px"><div class="row spread wrap-row"><div><b>In a meeting right now?</b><div class="small muted">Enter the code on the facilitator’s screen to vote.</div></div><a class="btn ghost" href="#/join">Enter a room code</a></div></div>';
      wireSignup();
    }).catch(function (e) { showError(e, view); });
  }

  function renderJoin() {
    view.innerHTML = backLink('#/', 'Back') + '<div class="page-head"><div><h1>Join a room</h1><div class="sub">No account needed. Your vote is anonymous.</div></div></div>' +
      '<form class="card" id="joinF"><label class="field"><span>Room code</span><input class="input" name="code" autocomplete="off" autocapitalize="characters" placeholder="ABCD-2345" maxlength="12" style="font-family:var(--mono);font-size:22px;letter-spacing:.08em"></label>' +
      '<div id="jErr"></div><button class="btn block">Join</button></form>';
    $('#joinF').onsubmit = function (e) {
      e.preventDefault();
      var c = R.normalizeCode(e.target.code.value);
      if (!R.isCode(c)) { $('#jErr').innerHTML = '<div class="err" role="alert" id="jErrMsg">That’s 8 letters and numbers, like ABCD-2345.</div>'; e.target.code.setAttribute('aria-invalid', 'true'); e.target.code.setAttribute('aria-describedby', 'jErrMsg'); return; }
      location.href = BASE + 'r/' + R.formatCode(c);
    };
  }

  /* ---------------- my meetings ---------------- */

  function renderMeetings() {
    loading();
    api('GET', 'api/meetings').then(function (r) {
      state.skew = Date.parse(r.now) - Date.now();
      var ms = r.meetings || [];
      var h = '<div class="page-head"><div><h1>Your meetings</h1><div class="sub">Set one up before it starts; run it live; keep the receipt.</div></div><a class="btn small" href="#/new">＋ New</a></div>';
      if (!ms.length) {
        h += '<div class="empty boxed"><div class="e">🧾</div><h2>No meetings yet</h2><p>Set up your next one — who is in the room and a timeboxed agenda — then press Start when it begins.</p>' +
          '<div class="btn-row" style="max-width:420px;margin:0 auto"><a class="btn" href="#/new">New meeting</a><a class="btn ghost" href="#/sample">Try the sample</a></div></div>';
      } else {
        h += '<div class="list">' + ms.map(function (m) {
          var live = m.status === 'live' || m.status === 'paused';
          var sub = m.status === 'waiting' ? 'Ready · ' + R.minText(m.bookedMs) + ' booked · ' + R.plural(m.headcount, 'person', 'people')
            : live ? (m.status === 'paused' ? 'Paused' : 'Live now') + ' · ' + R.plural(m.headcount, 'person', 'people')
              : fmtDay(m.day) + ' · ' + R.durText(m.durationMs) + ' · ' + R.plural(m.decisions, 'decision') + (m.rotiAvg != null ? ' · ROTI ' + m.rotiAvg.toFixed(1) : '');
          return '<a class="mcard' + (live ? ' live' : '') + '" href="#/m/' + enc(m.id) + '"><span class="ic" aria-hidden="true">' + (live ? '⏱️' : m.status === 'waiting' ? '📋' : '🧾') + '</span>' +
            '<span style="min-width:0"><span class="t" style="display:block">' + esc(m.title) + '</span><span class="m" style="display:block">' + esc(sub) + '</span></span>' +
            '<span class="n"><b>' + esc(m.status === 'waiting' ? '≈' + R.money(m.hourly * m.bookedMs / R.HOUR) : R.money(m.costUsd)) + '</b><span>' + (m.status === 'waiting' ? 'if on time' : live ? 'and counting' : 'total') + '</span></span></a>';
        }).join('') + '</div>' +
          '<div class="btn-row" style="margin-top:14px"><a class="btn" href="#/new">New meeting</a><a class="btn ghost" href="#/audit">Audit the recurring ones</a></div>';
      }
      view.innerHTML = h;
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- set up a meeting ---------------- */

  function peopleFields(f, prefix) {
    prefix = prefix || 'p';
    var rows = f.mode === 'blended' ? [f.people[0] || { band: 'blended', rate: R.BLENDED.rate, count: 5 }] : f.people;
    var blended = f.mode === 'blended';
    return '<div class="seg2" role="group" aria-label="How to count the room"><button type="button" data-mode="bands" aria-pressed="' + !blended + '"' + (!blended ? ' class="on"' : '') + '>By role band</button><button type="button" data-mode="blended" aria-pressed="' + blended + '"' + (blended ? ' class="on"' : '') + '>One blended rate</button></div>' +
      '<div class="bands" style="margin-top:10px">' + rows.map(function (p, i) {
        var info = R.bandInfo(p.band);
        return '<div class="band" data-i="' + i + '"><span class="nm"><span class="be" aria-hidden="true">' + esc(info.emoji) + ' </span>' + esc(info.label) + (p.band === 'blended' ? '<small>Everyone, one rate</small>' : '') + '</span>' +
          '<label class="rate"><span>$</span><input inputmode="decimal" aria-label="' + esc(info.label) + ' hourly rate" data-k="rate" value="' + esc(p.rate) + '"><span>/h</span></label>' +
          '<span class="stepper"><button type="button" data-step="-1" aria-label="One fewer ' + esc(info.label) + '">−</button><input inputmode="numeric" aria-label="' + esc(info.label) + ' headcount" data-k="count" value="' + esc(p.count) + '"><button type="button" data-step="1" aria-label="One more ' + esc(info.label) + '">＋</button></span></div>';
      }).join('') + '</div>' +
      '<label class="toggle" style="margin-top:8px"><input type="checkbox" id="' + prefix + 'Loaded"' + (f.loaded ? ' checked' : '') + '><span class="sw"></span><span><b>Loaded cost ×' + R.LOADED + '</b><small>Benefits, tax and the desk: salary is not the whole hour.</small></span></label>';
  }
  function wirePeople(root, f, onChange, prefix) {
    prefix = prefix || 'p';
    $$('[data-mode]', root).forEach(function (b) {
      b.onclick = function () {
        if (f.mode === b.dataset.mode) return;
        // Each mode keeps its own rows, so peeking at the other one and
        // coming back loses nothing (it used to put everyone into IC). The
        // POST bodies are built field by field, so these never leave the page.
        var n = Math.max(1, R.headcount(f));
        if (f.mode === 'blended') f._blended = f.people; else f._bands = f.people;
        f.mode = b.dataset.mode;
        f.people = f.mode === 'blended'
          ? (f._blended || [{ band: 'blended', rate: R.BLENDED.rate, count: n }])
          : (f._bands || R.BANDS.map(function (x) { return { band: x.key, rate: x.rate, count: x.key === 'ic' ? n : 0 }; }));
        onChange(true);
      };
    });
    $$('.band', root).forEach(function (row) {
      var i = Number(row.dataset.i);
      $$('input', row).forEach(function (inp) {
        inp.oninput = function () { var n = R.toNumber(inp.value); f.people[i][inp.dataset.k] = n === null || Number.isNaN(n) ? 0 : n; onChange(false); };
      });
      $$('[data-step]', row).forEach(function (b) {
        b.onclick = function () {
          var p = f.people[i];
          p.count = Math.max(0, Math.min(R.LIMITS.count, (Number(p.count) || 0) + Number(b.dataset.step)));
          $('[data-k=count]', row).value = p.count;
          onChange(false);
        };
      });
    });
    var ld = $('#' + prefix + 'Loaded', root);
    if (ld) ld.onchange = function () { f.loaded = ld.checked; onChange(false); };
  }

  function renderSetup(m) {
    var last = (state.me && state.me.lastSetup) || null;
    var f = m ? JSON.parse(JSON.stringify(m)) : {
      title: '', mode: last ? last.mode : 'bands', loaded: last ? last.loaded : false, bookedMinutes: 30, agenda: [], labels: last ? last.labels : [], bingo: false, invite: '',
      people: last ? last.people : R.BANDS.map(function (b) { return { band: b.key, rate: b.rate, count: b.key === 'ic' ? 4 : b.key === 'manager' ? 1 : 0 }; }),
    };
    if (f.mode !== 'blended' && f.people.length !== 3) f.people = R.cleanPeople(f.people, 'bands');
    var started = m && m.startedAt;
    function draw() {
      view.innerHTML = backLink(m ? '#/m/' + enc(m.id) : '#/', m ? 'Back to the meeting' : 'Your meetings') +
        '<div class="page-head"><div><h1>' + (m ? 'Edit the meeting' : 'New meeting') + '</h1><div class="sub">' + (started ? 'It has started: the room, the rates and the agenda are locked so the receipt stays honest.' : 'Who is in the room, how long it is booked for, and what it is for.') + '</div></div></div>' +
        '<form id="setupF" class="dk-split dk-split-aside"><div>' +
        '<div class="card"><label class="field"><span>Meeting name</span><input class="input" name="title" maxlength="80" required placeholder="Weekly marketing sync" value="' + esc(f.title) + '"></label>' +
        '<label class="field" style="margin:0"><span>The invite, as sent (optional — the sharpener works from this)</span><textarea class="input" name="invite" maxlength="2000" placeholder="Sync on Q4 - campaign, launch, budget. Bring updates!">' + esc(f.invite || '') + '</textarea></label></div>' +
        (started ? '' : '<div class="label">Who’s in the room <span class="count" id="pplCount"></span></div><div class="card" id="people">' + peopleFields(f) + '<div class="costline" id="costline"></div><p class="hint">Rates are estimates per role band. Nobody’s name or salary goes in here.</p></div>') +
        (started ? '' : '<div class="label">Booked for</div><div class="chips" id="booked">' + [15, 25, 30, 45, 50, 60, 90].map(function (n) {
          return '<button type="button" class="chip' + (f.bookedMinutes === n ? ' on' : '') + '" aria-pressed="' + (f.bookedMinutes === n) + '" data-min="' + n + '">' + n + ' min</button>';
        }).join('') + '<input class="input" id="bookedOther" inputmode="numeric" aria-label="Other length in minutes" placeholder="Other" style="width:90px;min-height:44px;padding:6px 10px;border-radius:999px" value="' + ([15, 25, 30, 45, 50, 60, 90].indexOf(f.bookedMinutes) < 0 ? esc(f.bookedMinutes) : '') + '"></div>') +
        '</div><div>' +
        (started ? '' : '<div class="label col-top">Timeboxed agenda <span class="count fit" id="fit"></span></div><div class="card"><div class="chips" style="margin-bottom:10px">' + R.TEMPLATES.map(function (t) {
          return '<button type="button" class="chip" data-tpl="' + esc(t.key) + '">' + esc(t.label) + '</button>';
        }).join('') + '</div><div class="agenda-edit" id="agendaEd"></div><button type="button" class="btn small ghost" id="addItem" style="margin-top:10px">＋ Add an item</button></div>') +
        '<div class="label">Attendee names for action owners</div><div class="card"><input class="input" name="labels" placeholder="Maya, Jordan, Sam" value="' + esc((f.labels || []).join(', ')) + '"><p class="hint">Optional. First names or roles, so an action can have an owner. Never shown on a shared receipt, never tied to a rate.</p></div>' +
        '<div class="label">For the room</div><label class="toggle"><input type="checkbox" name="bingo"' + (f.bingo ? ' checked' : '') + '><span class="sw"></span><span><b>Buzzword bingo</b><small>Each phone gets its own card. Off by default — your call.</small></span></label>' +
        '<div id="setErr" style="margin-top:12px"></div>' +
        '<div class="btn-row" style="margin-top:14px"><button class="btn lg" type="submit">' + (m ? 'Save' : 'Create the meeting') + '</button></div>' +
        (m ? '<button type="button" class="btn danger block" id="delM" style="margin-top:22px">Delete this meeting</button>' : '') +
        '</div></form>';
      if (!started) {
        var onPeople = function (redraw) {
          if (redraw) { $('#people').innerHTML = peopleFields(f) + '<div class="costline" id="costline"></div><p class="hint">Rates are estimates per role band. Nobody’s name or salary goes in here.</p>'; wirePeople($('#people'), f, onPeople); }
          summary();
        };
        wirePeople($('#people'), f, onPeople);
        var pickBooked = function () { $$('#booked .chip').forEach(function (x) { var on = Number(x.dataset.min) === f.bookedMinutes && !$('#bookedOther').value; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }); };
        $$('#booked [data-min]').forEach(function (b) { b.onclick = function () { f.bookedMinutes = Number(b.dataset.min); $('#bookedOther').value = ''; pickBooked(); summary(); }; });
        $('#bookedOther').oninput = function (e) { var n = R.intIn(e.target.value, 1, 480); if (n) { f.bookedMinutes = n; pickBooked(); summary(); } };
        $$('[data-tpl]').forEach(function (b) {
          b.onclick = function () {
            var t = R.TEMPLATES.filter(function (x) { return x.key === b.dataset.tpl; })[0];
            f.agenda = t.items.map(function (x) { return { title: x[0], minutes: x[1], owner: '' }; });
            if (f.bookedMinutes < t.minutes) f.bookedMinutes = t.minutes;
            if (!$('[name=title]').value) $('[name=title]').value = t.label;
            drawAgenda(); summary();
            if (f.bookedMinutes === t.minutes) $('#bookedOther').value = '';
            pickBooked();
          };
        });
        $('#addItem').onclick = function () { if (f.agenda.length < R.LIMITS.items) { f.agenda.push({ title: '', minutes: 5, owner: '' }); drawAgenda(); summary(); var inps = $$('#agendaEd [data-k=title]'); if (inps.length) inps[inps.length - 1].focus(); } };
        drawAgenda(); summary();
      }
      $('#setupF').onsubmit = function (e) {
        e.preventDefault();
        var fm = e.target;
        var body = { title: fm.title.value, invite: fm.invite.value, labels: fm.labels.value, bingo: fm.bingo.checked };
        if (!started) Object.assign(body, { mode: f.mode, people: f.people, loaded: Boolean(f.loaded), bookedMinutes: f.bookedMinutes, agenda: f.agenda.filter(function (a) { return String(a.title).trim(); }) });
        var btn = $('button[type=submit]', fm); btn.disabled = true;
        (m ? api('PUT', 'api/meetings/' + enc(m.id), body) : api('POST', 'api/meetings', body)).then(function (r) {
          return loadMe().then(function () { location.hash = '#/m/' + enc(r.meeting.id); });
        }).catch(function (err) { btn.disabled = false; showError(err, $('#setErr')); });
      };
      var del = $('#delM');
      if (del) del.onclick = function () {
        if (!confirm('Delete “' + m.title + '”? Its log, the room’s votes and any shared receipt go too.')) return;
        api('DELETE', 'api/meetings/' + enc(m.id)).then(function () { return loadMe(); }).then(function () { toast('Deleted'); location.hash = '#/'; }).catch(function (err) { showError(err); });
      };
    }
    function drawAgenda() {
      var el = $('#agendaEd');
      if (!el) return;
      if (!f.agenda.length) { el.innerHTML = '<p class="hint" style="margin:0">No agenda yet — pick a template, add items, or sharpen the invite after you create it.</p>'; return; }
      el.innerHTML = f.agenda.map(function (a, i) {
        return '<div class="aitem" data-i="' + i + '"><div class="arow"><input class="input" data-k="title" maxlength="80" aria-label="Item ' + (i + 1) + '" placeholder="Item ' + (i + 1) + '" value="' + esc(a.title) + '">' +
          '<input class="input" data-k="minutes" inputmode="numeric" aria-label="Minutes for item ' + (i + 1) + '" value="' + esc(a.minutes) + '">' +
          '<button type="button" class="x" data-x aria-label="Remove item ' + (i + 1) + '">×</button></div>' +
          '<input class="input" data-k="owner" maxlength="30" aria-label="Who leads item ' + (i + 1) + '" placeholder="Who leads it (optional)" value="' + esc(a.owner || '') + '" style="min-height:38px;padding:7px 11px;font-size:14px"></div>';
      }).join('');
      $$('.aitem', el).forEach(function (row) {
        var i = Number(row.dataset.i);
        $$('input', row).forEach(function (inp) {
          inp.oninput = function () { f.agenda[i][inp.dataset.k] = inp.dataset.k === 'minutes' ? (R.intIn(inp.value, 0, 240) || 0) : inp.value; summary(); };
        });
        $('[data-x]', row).onclick = function () { f.agenda.splice(i, 1); drawAgenda(); summary(); };
      });
    }
    function summary() {
      var n = R.headcount(f);
      var hr = R.hourly(f);
      var cl = $('#costline');
      if (cl) cl.innerHTML = '<b>' + esc(R.money(hr)) + '/h</b> for ' + esc(R.plural(n, 'person', 'people')) + ' · <b>' + esc(usd(hr / 60)) + '</b> a minute · about <b>' + esc(R.money(hr * f.bookedMinutes / 60)) + '</b> if it runs its ' + esc(f.bookedMinutes) + ' minutes.';
      var pc = $('#pplCount'); if (pc) pc.textContent = R.plural(n, 'person', 'people');
      var fit = $('#fit');
      if (fit) {
        var used = R.agendaMinutes(f.agenda);
        fit.textContent = used + ' of ' + f.bookedMinutes + ' min';
        fit.className = 'count fit ' + (used > f.bookedMinutes ? 'bad' : used ? 'good' : '');
      }
    }
    draw();
  }

  /* ---------------- one meeting ---------------- */

  function loadMeeting(id) {
    return api('GET', 'api/meetings/' + enc(id)).then(function (d) { state.skew = Date.parse(d.now) - Date.now(); return d; });
  }

  function renderMeeting(id, sub) {
    loading();
    loadMeeting(id).then(function (d) {
      var m = d.meeting;
      if (sub === 'edit') return renderSetup(m);
      if (sub === 'recap') return renderRecap(d);
      if (m.status === 'waiting') return renderPrep(d);
      if (m.status === 'ended' || sub === 'receipt') return renderReceiptPage(d);
      return renderLiveReal(d);
    }).catch(function (e) {
      if (e.status === 404) {
        view.innerHTML = '<div class="empty"><div class="e">🔍</div><h2>No such meeting</h2><p>It may have been deleted.</p><a class="btn" href="#/">Your meetings</a></div>';
        return;
      }
      showError(e, view);
    });
  }

  function roomLink(code) { return location.origin + BASE + 'r/' + code; }
  function roomCard(c) {
    var code = c.code;
    var demoNote = c.demo ? '<p class="hint" style="margin:10px 0 0">Sample: in a real meeting, people scan this and vote from their phones.</p>' : '';
    return '<div class="card room-card"><div class="card-head"><h3>🗳️ The room</h3><span class="sub">No account needed</span></div>' +
      '<div class="room-grid"><button class="qr" id="qrBtn" aria-label="Show the QR code full screen">' + QR.svg(roomLink(code), 'QR code for room ' + code) + '</button>' +
      '<div style="min-width:0"><div class="eyebrow">Room code</div><div class="code">' + esc(code) + '</div>' +
      '<div class="small muted">Scan, or open <b>' + esc(location.host + BASE) + 'r/…</b></div>' +
      '<div class="row wrap-row" style="margin-top:8px;gap:6px"><button class="btn small ghost" id="copyRoom">Copy link</button><button class="btn small ghost" id="bigQr">Show big</button></div></div></div>' +
      '<div class="pulse-row" id="pulseRow">' + pulseCells(c.pulse) + '</div>' +
      (c.bingoMini || '') + demoNote +
      '</div>';
  }
  function bingoStatus(on, p) {
    if (!on) return '';
    return '<div class="small muted" id="bingoLine" style="margin-top:10px">🎲 Bingo is on' + (p && p.bingo ? ' · <b style="color:var(--text)">' + esc(p.bingo.handle) + ' got bingo first</b>' : ' · nobody has a line yet') + '</div>';
  }
  function pulseCells(p) {
    p = p || { voters: 0, emailVotes: 0, roti: { n: 0 } };
    return '<div><b>' + esc(p.voters) + '</b><span>voted</span></div><div><b>' + esc(p.emailVotes) + '</b><span>📧 email</span></div><div><b>' + (p.roti && p.roti.n ? esc(p.roti.avg.toFixed(1)) : '–') + '</b><span>ROTI /4</span></div>';
  }
  function wireRoom(root, code, demo) {
    var show = function () {
      var o = document.createElement('div');
      o.className = 'qr-big'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', 'Room QR code');
      o.innerHTML = '<button type="button">Close</button>' + QR.svg(roomLink(code), 'QR code for room ' + code) + '<div class="code">' + esc(code) + '</div><p>Scan to vote: “could have been an email”, and was it worth your time?</p>';
      o.onclick = function () { o.remove(); };
      document.body.appendChild(o);
    };
    var q = $('#qrBtn', root); if (q) q.onclick = show;
    var b = $('#bigQr', root); if (b) b.onclick = show;
    var c = $('#copyRoom', root);
    if (c) c.onclick = demo ? function () { toast('Sample: a real meeting’s link opens its room.'); } : function () { copy(roomLink(code), 'Room link copied — paste it in the call chat'); };
  }

  function looseEndsCard(list, onDone) {
    if (!list || !list.length) return '';
    return '<div class="card"><div class="card-head"><h3>🔥 Loose ends from last time</h3><span class="sub">' + esc(R.plural(list.length, 'open action')) + '</span></div><ul class="logl">' + list.map(function (a) {
      var hi = R.heatInfo(a.heat.state);
      return '<li><span class="e" aria-hidden="true">' + hi.emoji + '</span><span style="min-width:0"><span class="t" style="display:block">' + esc(a.text) + '</span>' +
        '<span class="m">' + esc([a.owner || 'No owner', a.due ? 'due ' + R.fmtDue(a.due) : '', a.meetingDay ? 'from ' + fmtDay(a.meetingDay) : ''].filter(Boolean).join(' · ')) + '</span></span>' +
        '<span class="row" style="gap:6px"><span class="heat ' + esc(a.heat.state) + '">' + esc(hi.label) + '</span>' + (onDone ? '<button class="icon-btn" data-done="' + esc(a.id) + '" data-mid="' + esc(a.meetingId) + '" aria-label="Mark done">✓</button>' : '') + '</span></li>';
    }).join('') + '</ul></div>';
  }
  function wireLooseEnds(root, reload) {
    $$('[data-done]', root).forEach(function (b) {
      b.onclick = function () {
        b.disabled = true;
        api('PUT', 'api/meetings/' + enc(b.dataset.mid) + '/log/' + enc(b.dataset.done), { done: true }).then(function () { toast('Done ✓'); reload(); }).catch(function (e) { b.disabled = false; showError(e); });
      };
    });
  }

  function agendaListHTML(m, t) {
    var a = R.agenda(m, t);
    if (!a.items.length) return '<p class="muted small" style="margin:0">No agenda — the whole meeting is one box: ' + esc(m.bookedMinutes) + ' minutes.</p>';
    return '<ul class="agenda-list">' + a.items.map(function (it) {
      var r = '';
      if (it.state === 'done') r = '<span class="' + (it.overMs >= 30000 ? 'bad' : 'good') + '">' + esc(R.durText(it.actualMs)) + '<small>' + (it.overUsd >= 1 ? '+' + esc(R.money(it.overUsd)) : it.underMs >= 30000 ? '−' + esc(R.durText(it.underMs)) : 'on time') + '</small></span>';
      else if (it.state === 'current') r = '<span data-cur-act>' + esc(R.clockText(it.actualMs)) + '</span><small class="faint">of ' + esc(it.minutes) + 'm</small>';
      else if (it.state === 'skipped') r = '<span class="faint">skipped</span>';
      else r = '<span class="faint">' + esc(it.minutes) + ' min</span>';
      return '<li class="' + it.state + '"><span class="n">' + it.n + '</span><span style="min-width:0"><span class="t" style="display:block">' + esc(it.title) + '</span>' + (it.owner ? '<span class="m">' + esc(it.owner) + '</span>' : '') + '</span><span class="r">' + r + '</span></li>';
    }).join('') + (a.afterMs >= 30000 ? '<li class="skipped"><span class="n">+</span><span class="t">After the agenda</span><span class="r">' + esc(R.durText(a.afterMs)) + '</span></li>' : '') + '</ul>';
  }

  /* ---------------- prep: before the start ---------------- */

  function renderPrep(d) {
    var m = d.meeting;
    var hr = R.hourly(m);
    view.innerHTML = backLink('#/', 'Your meetings') +
      '<div class="live-head"><div style="min-width:0"><span class="state waiting">Ready</span><h1 style="margin-top:8px">' + esc(m.title) + '</h1>' +
      '<div class="muted" style="margin-top:4px">' + esc(m.bookedMinutes) + ' min booked · ' + esc(R.plural(R.headcount(m), 'person', 'people')) + ' · ' + esc(R.money(hr)) + '/h — about ' + esc(R.money(hr * m.bookedMinutes / 60)) + ' if it runs to time</div></div>' +
      '<a class="btn small ghost" href="#/m/' + enc(m.id) + '/edit">Edit</a></div>' +
      '<div class="dk-split dk-split-aside"><div class="stack">' +
      '<button class="btn xl block" id="startBtn">▶ Start the meeting</button>' +
      looseEndsCard(d.looseEnds, true) +
      (m.outcome ? '<div class="card"><div class="eyebrow">The outcome</div><p style="margin:6px 0 0;font-weight:650">' + esc(m.outcome) + '</p></div>' : '') +
      '<div class="card"><div class="card-head"><h3>📋 Agenda</h3><span class="sub">' + esc(R.agendaMinutes(m.agenda)) + ' of ' + esc(m.bookedMinutes) + ' min</span></div>' + agendaListHTML(m, now()) + '</div>' +
      '<div class="card" id="sharpCard"><div class="card-head"><h3>✨ Sharpen the invite</h3><span class="sub">about a cent</span></div>' +
      '<p class="small muted" style="margin:0 0 10px">Paste the vague invite. You get an outcome, a timeboxed agenda that fits ' + esc(m.bookedMinutes) + ' minutes, who really needs to be there — and an honest verdict on whether it could be an email. Nothing changes until you tap Apply.</p>' +
      '<textarea class="input" id="invite" maxlength="2000" placeholder="Sync on Q4 - campaign, launch, budget. Bring updates!">' + esc(m.invite || '') + '</textarea>' +
      '<div id="shErr"></div><button class="btn block" id="sharpBtn" style="margin-top:10px">✨ Sharpen it <span class="cost">· ~1¢</span></button><div id="proposal"></div></div>' +
      '</div><div class="stack dk-sticky">' + roomCard({ code: m.code, pulse: null }) +
      '<div class="card"><div class="row spread"><div><b>Buzzword bingo</b><div class="small muted">' + (m.bingo ? 'On — every phone gets a card.' : 'Off. Turn it on in Edit.') + '</div></div><span class="tag' + (m.bingo ? ' good' : '') + '">' + (m.bingo ? 'On' : 'Off') + '</span></div></div>' +
      '<div class="card"><div class="eyebrow">When it’s over</div><p class="small muted" style="margin:6px 0 0">Press End and a receipt prints: cost by band and item, decisions, the room’s vote, and TIME GIVEN BACK if you finish early.</p></div>' +
      '</div></div>';
    wireRoom(view, m.code);
    wireLooseEnds(view, function () { renderMeeting(m.id, ''); });
    $('#startBtn').onclick = function (e) {
      e.target.disabled = true;
      chimeUnlock();
      api('POST', 'api/meetings/' + enc(m.id) + '/start').then(function () { return loadMe(); }).then(function () { window.scrollTo(0, 0); renderMeeting(m.id, ''); })
        .catch(function (err) { e.target.disabled = false; showError(err); });
    };
    $('#sharpBtn').onclick = function (e) {
      var btn = e.target.closest('button'); btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> Sharpening…';
      api('POST', 'api/meetings/' + enc(m.id) + '/sharpen', { invite: $('#invite').value }).then(function (r) {
        btn.disabled = false; btn.innerHTML = '✨ Sharpen again <span class="cost">· ~1¢</span>';
        $('#shErr').innerHTML = '';
        drawProposal($('#proposal'), r.proposal, r.invite, m);
        loadMe();
      }).catch(function (err) { btn.disabled = false; btn.innerHTML = '✨ Sharpen it <span class="cost">· ~1¢</span>'; showError(err, $('#shErr')); });
    };
  }
  function chimeUnlock() {
    // Audio needs a tap to start on phones; the Start tap is it.
    try { var C = window.AudioContext || window.webkitAudioContext; if (C && !state.ac) state.ac = new C(); if (state.ac && state.ac.resume) state.ac.resume(); } catch (e) { /* no audio */ }
  }

  var VERDICT = {
    meeting: { emoji: '✅', label: 'Needs a meeting' },
    split: { emoji: '✂️', label: 'Half of it could be an email' },
    email: { emoji: '📧', label: 'This could be an email' },
  };
  function proposalHTML(p, opts) {
    opts = opts || {};
    var v = VERDICT[p.verdict] || VERDICT.meeting;
    return '<div class="stack" style="margin-top:14px">' +
      '<div><span class="verdict-badge ' + esc(p.verdict) + '">' + v.emoji + ' ' + esc(v.label) + '</span></div>' +
      (p.why ? '<p style="margin:0" class="muted">' + gaps(p.why) + '</p>' : '') +
      (p.outcome ? '<div><div class="eyebrow">Outcome</div><p style="margin:4px 0 0;font-weight:700">' + gaps(p.outcome) + '</p></div>' : '') +
      (p.items.length ? '<div><div class="eyebrow" style="margin-bottom:6px">Agenda · ' + esc(p.minutes) + ' of ' + esc(p.bookedMinutes) + ' min</div><ul class="agenda-list">' + p.items.map(function (it, i) {
        return '<li><span class="n">' + (i + 1) + '</span><span style="min-width:0"><span class="t" style="display:block">' + gaps(it.title) + '</span>' + (it.owner ? '<span class="m">' + esc(it.owner) + ' leads</span>' : '') + '</span><span class="r">' + esc(it.minutes) + ' min</span></li>';
      }).join('') + '</ul></div>' : '') +
      (p.attendeeBands && p.attendeeBands.length ? '<div class="small muted">Who needs to be there: <b>' + esc(p.attendeeBands.map(function (b) { return R.bandInfo(b).label; }).join(', ')) + '</b>' + (p.skipBands && p.skipBands.length ? ' — send ' + esc(p.skipBands.map(function (b) { return R.bandInfo(b).label; }).join(', ')) + ' the recap instead.' : '') + '</div>' : '') +
      (p.asyncDraft ? '<div><div class="eyebrow" style="margin-bottom:6px">📧 Send this instead' + (p.verdict === 'split' ? ' (before the meeting)' : '') + '</div><div class="draft">' + gaps(p.asyncDraft) + '</div>' +
        '<div class="btn-row" style="margin-top:8px"><button class="btn small ghost" data-copydraft>Copy the update</button><a class="btn small ghost" href="' + esc(R.mailto('Update: ' + (opts.title || 'our meeting'), p.asyncDraft)) + '">Open in mail</a></div></div>' : '') +
      ((p.notes || []).length ? '<div class="banner warn"><span class="e">📏</span><span>' + esc(p.notes.join(' ')) + '</span></div>' : '') +
      ((p.removed || []).length ? '<details><summary class="small muted">Taken out: ' + esc(R.plural(p.removed.length, 'detail')) + ' you never gave</summary><ul class="removed">' + p.removed.map(function (x) { return '<li><b>' + esc(x.what) + '</b> — ' + esc(x.why) + '</li>'; }).join('') + '</ul></details>' : '') +
      (opts.actions === false ? '' : '<div class="btn-row">' + (p.items.length ? '<button class="btn" data-apply>Apply this agenda</button>' : '') + '<button class="btn ghost" data-discard>Discard</button></div>') +
      '</div>';
  }
  function drawProposal(el, p, invite, m) {
    el.innerHTML = proposalHTML(p, { title: m.title });
    var cd = $('[data-copydraft]', el); if (cd) cd.onclick = function () { copy(p.asyncDraft, 'Update copied'); };
    var ds = $('[data-discard]', el); if (ds) ds.onclick = function () { el.innerHTML = ''; };
    var ap = $('[data-apply]', el);
    if (ap) ap.onclick = function () {
      ap.disabled = true;
      api('PUT', 'api/meetings/' + enc(m.id), { agenda: p.items.map(function (it) { return { title: it.title, minutes: it.minutes, owner: it.owner }; }), outcome: p.outcome, invite: invite })
        .then(function () { toast('Agenda applied'); renderMeeting(m.id, ''); })
        .catch(function (e) { ap.disabled = false; showError(e); });
    };
  }

  /* ---------------- the live meter (real and sample alike) ---------------- */

  /**
   * One live meeting on screen. `c` carries the meeting, its log, the room's
   * numbers and what the buttons do - so the sample (played in the browser)
   * and a real meeting (stored on the server) draw from the same code.
   */
  function mountLive(c) {
    var chimed = {};
    var lastUsd = null;
    var endArmed = false;
    var tickMs = reducedMotion() ? 1000 : 200;
    var freshLog = null;

    function html() {
      var m = c.m;
      var st = R.status(m);
      var a = R.agenda(m, c.now());
      var cur = a.current;
      var cpd = m && c.log.filter(function (l) { return l.kind === 'decision'; }).length;
      var labelsNote = m.labels && m.labels.length ? '' : '<p class="hint" style="margin:8px 0 0">Add attendee names in Edit to give actions an owner.</p>';
      return (c.demo ? sampleBar('A made-up weekly marketing sync, played at 60× — real rules, no AI, nothing saved.') + subnav('live') : backLink('#/', 'Your meetings')) +
        '<div class="live-head"><div style="min-width:0"><span class="state ' + st + '" id="stateTag">' + (st === 'paused' ? 'Paused' : st === 'waiting' ? 'Ready' : st === 'ended' ? 'Ended' : 'Live') + '</span>' +
        '<h1 style="margin-top:8px">' + esc(m.title) + '</h1></div>' +
        (c.demo ? '<button class="btn small ghost ff" id="ffBtn" aria-pressed="' + (c.speed() > 1) + '">⏩ ' + (c.speed() > 1 ? '60×' : '1×') + '</button>' : '<a class="btn small ghost" href="#/m/' + enc(m.id) + '/edit">Edit</a>') + '</div>' +
        '<div class="dk-split dk-split-aside"><div class="stack">' +
        '<div class="ticker' + (st === 'paused' ? ' paused' : '') + '"><div class="lbl">This meeting has cost</div><div class="usd" id="tUsd">$0<small>.00</small></div>' +
        '<div class="meta" id="tMeta"></div>' +
        '<div class="chips"><span class="chip" id="tRate"></span><span class="chip">' + esc(R.plural(R.headcount(m), 'person', 'people')) + '</span><span class="chip" id="tCmp"></span></div>' +
        '<div class="note">Estimated from role-band rates' + (m.loaded ? ', loaded ×' + R.LOADED : '') + ' — not anyone’s salary.</div></div>' +
        '<div class="card now-item" id="nowItem">' + nowItemHTML(cur, a, m) + '</div>' +
        forgottenHTML(st) +
        // The controls and the one-tap log row ride together; on a phone they
        // are pinned to the bottom of the screen (the tab bar steps aside), so
        // logging a decision never needs a scroll first.
        '<div class="live-dock">' + controlsHTML(st, a) +
        '<div class="quick" role="group" aria-label="Log it, one tap"><button data-log="decision"><span class="e" aria-hidden="true">✅</span>Decision</button><button data-log="action"><span class="e" aria-hidden="true">📌</span>Action</button><button data-log="parking"><span class="e" aria-hidden="true">🅿️</span>Park it</button></div></div>' +
        '<div class="card"><div class="card-head"><h3>The log</h3><span class="sub">decisions, actions, parking lot</span></div>' +
        '<div class="cpd" style="margin-top:0"><span>' + esc(R.plural(cpd, 'decision')) + (cpd ? ' · each cost' : '') + '</span><b id="cpd">' + (cpd ? '' : 'none yet') + '</b></div>' + labelsNote +
        (c.log.length ? '<ul class="logl" style="margin-top:12px">' + c.log.slice().sort(function (x, y) { return (y.at || 0) - (x.at || 0); }).map(function (l) {
          var k = R.kindInfo(l.kind);
          return '<li class="' + (l.doneAt ? 'done ' : '') + (freshLog === l ? 'new' : '') + '"><span class="e" aria-hidden="true">' + k.emoji + '</span><span style="min-width:0"><span class="t" style="display:block">' + esc(l.text) + '</span>' +
            ((l.owner || l.due) ? '<span class="m">' + esc([l.owner, l.due ? 'due ' + R.fmtDue(l.due) : ''].filter(Boolean).join(' · ')) + '</span>' : '') + '</span>' +
            '<span class="at">' + esc(R.clockText(l.at || 0)) + (c.demo || !l.id ? '' : ' <button class="icon-btn" data-edit="' + esc(l.id) + '" aria-label="Edit or delete this item" style="display:inline-grid;vertical-align:middle;margin-left:4px">⋯</button>') + '</span></li>';
        }).join('') + '</ul>' : '') + '</div>' +
        '</div><div class="stack dk-sticky">' +
        roomCard({ code: m.code, pulse: c.pulse, demo: c.demo, bingoMini: c.bingoMini ? c.bingoMini() : bingoStatus(m.bingo, c.pulse) }) +
        (c.looseEnds && c.looseEnds.length ? looseEndsCard(c.looseEnds, !c.demo) : '') +
        '<div class="card"><div class="card-head"><h3>📋 Agenda</h3><span class="sub">' + esc(R.agendaMinutes(m.agenda)) + ' of ' + esc(m.bookedMinutes) + ' min</span></div><div id="agendaL">' + agendaListHTML(m, c.now()) + '</div></div>' +
        '</div></div>';
    }
    function controlsHTML(st, a) {
      if (st === 'waiting') return '<button class="btn xl block" data-ctl="start">▶ Start' + (c.demo ? ' the sample' : ' the meeting') + '</button>';
      if (st === 'ended') return '';
      var hasNext = a.items.length && a.items.some(function (i) { return i.state === 'current'; });
      return '<div class="controls">' +
        (st === 'paused' ? '<button class="btn ghost" data-ctl="resume">▶ Resume</button>' : '<button class="btn ghost" data-ctl="pause">⏸ Pause</button>') +
        (c.demo ? '<button class="btn" data-ctl="skip">⏭ Skip to receipt</button>' : '<button class="btn" data-ctl="next"' + (hasNext ? '' : ' disabled') + '>' + (hasNext ? 'Next item →' : 'No more items') + '</button>') +
        (c.demo ? '<button class="btn stop" data-ctl="restart">↺ Restart</button>' : '<button class="btn stop" data-ctl="end">■ End</button>') + '</div>';
    }
    /**
     * A meeting nobody ended: well past its booking, or opened on a later day
     * than it started. The meter would keep charging until someone taps End,
     * so offer to end it when it really ended - at the booked time, or at the
     * last thing logged. The server clamps either to what happened.
     */
    function forgottenHTML(st) {
      if (c.demo || (st !== 'live' && st !== 'paused')) return '';
      var m = c.m;
      var el = R.elapsed(m, c.now());
      var booked = (m.bookedMinutes || 0) * R.MIN;
      if (!(el > booked + 2 * R.HOUR || (m.day && m.day !== localDay()))) return '';
      // Never before the last closed item: the server holds the same floor.
      var floor = (m.marks || []).length ? m.marks[m.marks.length - 1] : 0;
      var atBooked = Math.min(el, Math.max(floor, booked));
      var lastLog = Math.max(floor, c.log.reduce(function (s, l) { return Math.max(s, l.at || 0); }, 0));
      return '<div class="banner warn forgot" role="note"><span class="e" aria-hidden="true">🕰️</span><span><b>Still running?</b> This meeting has run ' + esc(R.durText(el)) + ' against ' + esc(R.durText(booked)) + ' booked. If it ended earlier, end it then — the receipt will count only that.' +
        '<span class="btn-row" style="margin-top:10px;display:flex"><button class="btn small" data-endat="' + atBooked + '">End it at the booked time (' + esc(R.clockText(atBooked)) + ')</button>' +
        (lastLog > 0 && lastLog < el && lastLog !== atBooked ? '<button class="btn small ghost" data-endat="' + lastLog + '">At the last logged item (' + esc(R.clockText(lastLog)) + ')</button>' : '') + '</span></span></div>';
    }
    function nowItemHTML(cur, a, m) {
      var C = 326.73;
      var title; var sub; var pct; var left; var over = 0; var overUsd = 0;
      var el = R.elapsed(m, c.now());
      if (!R.started(m)) {
        // Not "past the agenda" - it has not begun.
        var bk = m.bookedMinutes * R.MIN;
        title = 'Not started yet';
        sub = a.items.length ? 'Press Start and item 1, “' + a.items[0].title + '”, begins.' : 'Press Start when the meeting begins.';
        pct = 0; left = bk;
      } else if (cur) {
        title = cur.title; sub = 'Item ' + cur.n + ' of ' + a.items.length + (cur.owner ? ' · ' + cur.owner : '') + ' · ' + cur.minutes + ' min';
        pct = cur.pct; left = cur.leftMs; over = cur.overMs; overUsd = cur.overUsd;
      } else {
        var booked = m.bookedMinutes * R.MIN;
        title = a.items.length ? (R.ended(m) ? 'Done' : 'Past the agenda') : 'Open discussion';
        sub = a.items.length ? 'Every item is closed. End when you’re done.' : 'No agenda — the whole booking is one box.';
        pct = Math.min(1, el / booked); left = booked - el; over = Math.max(0, el - booked); overUsd = R.costFor(m, over);
      }
      var cls = over > 0 ? 'over' : pct >= 0.8 ? 'warn' : '';
      return '<div class="ring ' + cls + '" id="ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="trk" cx="60" cy="60" r="52" fill="none" stroke-width="10"/><circle class="val" id="ringVal" cx="60" cy="60" r="52" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + C + '" stroke-dashoffset="' + (C * (1 - pct)).toFixed(2) + '"/></svg>' +
        '<div class="c"><div><b id="ringT">' + (over > 0 ? '+' + R.clockText(over) : R.clockText(Math.max(0, left))) + '</b><span>' + (over > 0 ? 'over' : 'left') + '</span></div></div></div>' +
        '<div style="min-width:0"><div class="eyebrow">' + (cur ? 'Now' : ' ') + '</div><h2>' + esc(title) + '</h2><div class="m">' + esc(sub) + '</div>' +
        '<div id="overLine">' + (over > 0 ? '<div class="overrun">This item is ' + esc(R.money(overUsd)) + ' over</div>' : (R.started(m) && !R.ended(m) ? '<div class="onpace">On time</div>' : '')) + '</div></div>';
    }
    function draw() {
      view.innerHTML = html();
      wire();
      tick(true);
      freshLog = null;
    }
    function wire() {
      wireRoom(view, c.m.code, c.demo);
      wireSignup();
      $$('[data-ctl]').forEach(function (b) {
        b.onclick = function () {
          var k = b.dataset.ctl;
          if (k === 'end' && !endArmed) {
            endArmed = true; b.textContent = 'Tap to end';
            setTimeout(function () { endArmed = false; if (b.isConnected) b.textContent = '■ End'; }, 3000);
            return;
          }
          if (k === 'start') chimeUnlock();
          b.disabled = true;
          Promise.resolve(c.onControl(k)).catch(function (e) { b.disabled = false; showError(e); });
        };
      });
      $$('[data-endat]').forEach(function (b) {
        b.onclick = function () {
          var ms = Number(b.dataset.endat);
          if (!confirm('End it at ' + R.clockText(ms) + ' of meeting time? The receipt counts the meeting up to then, not the time since.')) return;
          b.disabled = true;
          Promise.resolve(c.onControl('end', { at: ms })).catch(function (e) { b.disabled = false; showError(e); });
        };
      });
      $$('[data-log]').forEach(function (b) { b.onclick = function () { openLogSheet(b.dataset.log); }; });
      $$('[data-edit]').forEach(function (b) { b.onclick = function () { openItemSheet(c.log.filter(function (l) { return l.id === b.dataset.edit; })[0]); }; });
      var ff = $('#ffBtn'); if (ff) ff.onclick = function () { c.toggleSpeed(); ff.textContent = '⏩ ' + (c.speed() > 1 ? '60×' : '1×'); ff.setAttribute('aria-pressed', String(c.speed() > 1)); };
      if (c.looseEnds && !c.demo) wireLooseEnds(view, c.reload);
    }
    function openLogSheet(kind) {
      var k = R.kindInfo(kind);
      var labels = c.m.labels || [];
      var owner = '';
      sheet('<h2>' + k.emoji + ' ' + esc(kind === 'decision' ? 'Log a decision' : kind === 'action' ? 'Log an action' : 'Park it for later') + '</h2>' +
        '<form id="logF"><label class="field"><span>' + (kind === 'decision' ? 'What was decided?' : kind === 'action' ? 'What needs doing?' : 'What are you parking?') + '</span><input class="input" name="text" maxlength="200" required autocomplete="off"></label>' +
        (kind === 'action' ? '<div class="field"><span id="ownerLbl">Owner</span>' + (labels.length ? '<div class="chips" id="owners" role="group" aria-labelledby="ownerLbl">' + labels.map(function (l) { return '<button type="button" class="chip" aria-pressed="false" data-o="' + esc(l) + '">' + esc(l) + '</button>'; }).join('') + '</div>' : '<p class="hint" style="margin:0">No attendee names yet — add them in Edit to assign owners.</p>') + '</div>' +
          '<label class="field"><span>Due (optional)</span><input class="input" type="date" name="due"></label>' : '') +
        '<div id="lErr"></div><button class="btn block" type="submit">Log it</button></form>',
        function (root) {
          $$('[data-o]', root).forEach(function (b) { b.onclick = function () { owner = owner === b.dataset.o ? '' : b.dataset.o; $$('[data-o]', root).forEach(function (x) { var on = x.dataset.o === owner; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }); }; });
          $('#logF', root).onsubmit = function (e) {
            e.preventDefault();
            var body = { kind: kind, text: e.target.text.value, owner: owner, due: e.target.due ? e.target.due.value : '' };
            var r = R.validateLog(body, labels);
            if (r.error) return showError(new Error(r.error), $('#lErr', root));
            var btn = $('button[type=submit]', e.target); btn.disabled = true;
            Promise.resolve(c.onLog(body)).then(function (item) {
              closeSheet();
              freshLog = item;
              toast(k.emoji + ' Logged' + (c.demo ? ' (sample — saved nowhere)' : ''));
              draw();
            }).catch(function (err) { btn.disabled = false; showError(err, $('#lErr', root)); });
          };
        });
    }
    /** Fix a logged item's words (it keeps its time), tick an action done,
     *  or delete it - the delete asks first. */
    function openItemSheet(l) {
      if (!l) return;
      var k = R.kindInfo(l.kind);
      sheet('<h2>' + k.emoji + ' Edit this ' + esc(k.label.toLowerCase()) + '</h2>' +
        '<form id="itemF"><label class="field"><span>' + (l.kind === 'decision' ? 'What was decided' : l.kind === 'action' ? 'What needs doing' : 'What is parked') + '</span><input class="input" name="text" maxlength="200" required autocomplete="off" value="' + esc(l.text) + '"></label>' +
        '<div id="iErr"></div><button class="btn block" type="submit">Save</button></form>' +
        (l.kind === 'action' ? '<button class="btn ghost block" id="iDone" style="margin-top:10px">' + (l.doneAt ? 'Mark not done' : '✓ Mark done') + '</button>' : '') +
        '<button class="btn danger block" id="iDel" style="margin-top:10px">Delete</button>',
        function (root) {
          $('#itemF', root).onsubmit = function (e) {
            e.preventDefault();
            var text = e.target.text.value;
            var r = R.validateLog({ kind: l.kind, text: text, owner: l.owner, due: l.due }, c.m.labels || []);
            if (r.error) return showError(new Error(r.error), $('#iErr', root));
            var btn = $('button[type=submit]', e.target); btn.disabled = true;
            c.onItem(l, { text: text }).then(function () { closeSheet(); toast('Saved'); draw(); }).catch(function (err) { btn.disabled = false; showError(err, $('#iErr', root)); });
          };
          var dn = $('#iDone', root);
          if (dn) dn.onclick = function () { c.onItem(l, { done: !l.doneAt }).then(function () { closeSheet(); draw(); }).catch(function (e) { showError(e); }); };
          $('#iDel', root).onclick = function () {
            if (!confirm('Delete “' + l.text + '” from the log?')) return;
            c.onItem(l, null).then(function () { closeSheet(); toast('Deleted'); draw(); }).catch(function (e) { showError(e); });
          };
        });
    }
    function tick(first) {
      var m = c.m;
      var t = c.now();
      var L = R.live(m, t);
      var el = $('#tUsd');
      if (!el) return;
      el.innerHTML = bigUsd(L.costUsd);
      var st = L.status;
      $('#tMeta').innerHTML = (st === 'paused' ? 'Paused at ' : '') + '<b>' + esc(R.clockText(L.elapsedMs)) + '</b> of ' + esc(R.clockText(L.bookedMs)) + ' · <b>' + esc((Math.round(L.personHours * 10) / 10).toFixed(1)) + '</b> person-hours';
      $('#tRate').textContent = usd(L.perMinute) + ' a minute';
      var cmp = $('#tCmp');
      cmp.textContent = L.compare ? L.compare.emoji + ' ≈ ' + L.compare.text : '☕ not a coffee yet';
      var dec = c.log.filter(function (l) { return l.kind === 'decision'; }).length;
      var cpd = $('#cpd'); if (cpd && dec) cpd.textContent = R.money(L.costUsd / dec);
      if (lastUsd !== null && !first && st === 'live') {
        var passed = R.crossed(lastUsd, L.costUsd);
        if (passed.length) { var mm = passed[passed.length - 1]; ping(mm.emoji, 'Just passed ' + mm.ping); }
      }
      lastUsd = L.costUsd;
      // The current item's ring.
      var cur = L.agenda.current;
      var ni = $('#nowItem');
      if (ni) {
        var key = (cur ? cur.n : 'x') + ':' + st;
        if (ni.dataset.key !== key) { ni.innerHTML = nowItemHTML(cur, L.agenda, m); ni.dataset.key = key; }
        else {
          var C = 326.73;
          var pct; var left; var over;
          if (cur) { pct = cur.pct; left = cur.leftMs; over = cur.overMs; } else { pct = Math.min(1, L.elapsedMs / L.bookedMs); left = L.leftMs; over = Math.max(0, -L.leftMs); }
          $('#ringVal').setAttribute('stroke-dashoffset', (C * (1 - pct)).toFixed(2));
          $('#ring').className = 'ring ' + (over > 0 ? 'over' : pct >= 0.8 ? 'warn' : '');
          $('#ringT').textContent = over > 0 ? '+' + R.clockText(over) : R.clockText(Math.max(0, left));
          $('#ringT').nextSibling.textContent = over > 0 ? 'over' : 'left';
          var ol = $('#overLine');
          var ou = cur ? cur.overUsd : R.costFor(m, over);
          ol.innerHTML = over > 0 ? '<div class="overrun">' + (cur ? 'This item is ' : 'The meeting is ') + esc(R.money(ou)) + ' over</div>' : (st === 'live' || st === 'paused' ? '<div class="onpace">On time</div>' : '');
        }
        if (cur && cur.overMs > 0 && !chimed[cur.n] && st === 'live') {
          chimed[cur.n] = true;
          if (!first) { chime(); ping('⏰', '“' + cur.title + '” is over time'); }
        }
        if (cur && first && cur.overMs > 0) chimed[cur.n] = true;
      }
      var ca = $('[data-cur-act]'); if (ca && cur) ca.textContent = R.clockText(cur.actualMs);
    }
    // On a phone the tab bar steps aside for the pinned controls (app.css);
    // stopTimers() brings it back when the view changes.
    document.body.classList.add('live-mode');
    draw();
    if (c.demo) centerSubnav();
    every(tickMs, function () { if (visible()) tick(false); });
    return {
      draw: draw,
      tick: tick,
      updatePulse: function (p) {
        c.pulse = p;
        var pr = $('#pulseRow'); if (pr) pr.innerHTML = pulseCells(p);
        var bl = $('#bingoLine'); if (bl && !c.demo) bl.outerHTML = bingoStatus(c.m.bingo, p);
      },
    };
  }

  function renderLiveReal(d) {
    var c = {
      demo: false,
      m: d.meeting,
      log: d.log,
      looseEnds: d.looseEnds,
      pulse: pulseOf(d.votes),
      now: now,
      reload: function () { renderMeeting(d.meeting.id, ''); },
      onControl: function (k, body) {
        return api('POST', 'api/meetings/' + enc(c.m.id) + '/' + k, body).then(function (r) {
          state.skew = Date.parse(r.now) - Date.now();
          c.m = r.meeting;
          if (k === 'end') { return loadMe().then(function () { renderMeeting(c.m.id, ''); }); }
          live.draw();
        }, function (e) {
          if (e.status === 409) { renderMeeting(c.m.id, ''); return; }
          throw e;
        });
      },
      onLog: function (body) {
        return api('POST', 'api/meetings/' + enc(c.m.id) + '/log', body).then(function (r) { c.log.push(r.item); return r.item; });
      },
      onItem: function (l, patch) {
        if (!patch) return api('DELETE', 'api/meetings/' + enc(c.m.id) + '/log/' + enc(l.id)).then(function () { c.log = c.log.filter(function (x) { return x !== l; }); });
        return api('PUT', 'api/meetings/' + enc(c.m.id) + '/log/' + enc(l.id), patch).then(function (r) { Object.assign(l, r.item); });
      },
    };
    var live = mountLive(c);
    state.live = live;
    // What the room is saying, every five seconds while this is on screen.
    every(5000, function () {
      if (!visible()) return;
      api('GET', 'api/meetings/' + enc(c.m.id) + '/pulse').then(function (p) { live.updatePulse(p); }).catch(function () { /* next time */ });
    });
  }
  function pulseOf(votes) {
    var r = R.receipt({ people: [] }, [], votes || [], Date.now());
    return { voters: r.voters, emailVotes: r.emailVotes, roti: r.roti, bingo: r.bingo };
  }

  /* ---------------- the receipt page ---------------- */

  function receiptActions(r, opts) {
    opts = opts || {};
    return '<div class="btn-row ract" style="max-width:420px;margin:0 auto">' +
      '<button class="btn" id="tearBtn">✂️ Tear it off</button><button class="btn ghost" id="pngBtn">⬇️ Save PNG</button><button class="btn ghost" id="txtBtn">📋 Copy text</button></div>';
  }
  function wireReceiptActions(r, opts) {
    $('#tearBtn').onclick = tear;
    $('#pngBtn').onclick = function () { downloadPNG(r, opts, fileName(r)); };
    $('#txtBtn').onclick = function () { copy(R.receiptText(r, opts), 'Receipt copied as text'); };
  }

  function renderReceiptPage(d) {
    var m = d.meeting;
    var draw = function (votes, log, anim) {
      var r = R.receipt(m, log, votes, now());
      view.innerHTML = backLink('#/', 'Your meetings') +
        '<div class="live-head"><div style="min-width:0"><span class="state ended">Ended</span><h1 style="margin-top:8px">' + esc(m.title) + '</h1></div><a class="btn small ghost" href="#/m/' + enc(m.id) + '/edit">Edit</a></div>' +
        '<div class="dk-split dk-split-aside"><div>' +
        '<div class="' + (anim ? 'printing' : '') + '"><div class="slot" aria-hidden="true"></div><div class="paper-wrap">' + receiptHTML(r) + '</div></div>' +
        receiptActions(r) + '</div><div class="stack dk-sticky">' +
        '<div class="card"><div class="card-head"><h3>🔗 Share it</h3><span class="sub">numbers only</span></div><div id="shareBox"></div></div>' +
        '<div class="card"><h3>📝 The recap</h3><p class="small muted" style="margin:6px 0 10px">A free template from the log, or a clean write-up from your notes, a transcript or a whiteboard photo.</p><a class="btn block" href="#/m/' + enc(m.id) + '/recap">Write the recap</a></div>' +
        '<div class="card"><h3>🔁 Same time next week?</h3><p class="small muted" style="margin:6px 0 10px">Same room, rates and agenda — and this meeting’s open actions come back at the top as loose ends.</p><button class="btn ghost block" id="againBtn">Set up the next one</button></div>' +
        '<div class="card"><div class="card-head"><h3>🗳️ The room</h3><span class="sub">votes count for a day</span></div><div class="pulse-row" style="margin-top:0">' + pulseCells(pulseOf(votes)) + '</div>' +
        '<p class="small muted" style="margin:10px 0 0">Room code <b>' + esc(m.code) + '</b> — late votes still land on the receipt until tomorrow.</p></div>' +
        '</div></div>';
      wireReceiptActions(r);
      drawShare($('#shareBox'), m);
      $('#againBtn').onclick = function (e) {
        e.target.disabled = true;
        api('POST', 'api/meetings', { repeatOf: m.id }).then(function (x) { return loadMe().then(function () { location.hash = '#/m/' + enc(x.meeting.id); }); })
          .catch(function (err) { e.target.disabled = false; showError(err); });
      };
    };
    var votes = d.votes;
    draw(votes, d.log, Date.now() - Date.parse(m.endedAt) < 8000 && !reducedMotion());
    // Late votes: re-ask every 10 s for the first half hour, while on screen.
    if (Date.now() - Date.parse(m.endedAt) < 30 * 60000) {
      every(10000, function () {
        if (!visible()) return;
        api('GET', 'api/meetings/' + enc(m.id) + '/pulse').then(function (p) {
          if (JSON.stringify(p.votes) !== JSON.stringify(votes)) { votes = p.votes; draw(votes, d.log, false); }
        }).catch(function () { /* next time */ });
      });
    }
  }

  function drawShare(el, m) {
    if (m.share) {
      var url = location.origin + BASE + m.share.url;
      el.innerHTML = '<div class="share-box"><div class="link">' + esc(url) + '</div>' +
        '<div class="btn-row"><button class="btn small" id="shCopy">Copy link</button><button class="btn small ghost" id="shUp">Update</button><button class="btn small danger" id="shOff">Revoke</button></div>' +
        '<p class="small muted" style="margin:0">Frozen ' + esc(fmtDay(m.share.sharedAt)) + '. No title, no names, no decisions — just the numbers.</p></div>';
      $('#shCopy', el).onclick = function () { copy(url, 'Link copied'); };
      $('#shUp', el).onclick = function () { api('POST', 'api/meetings/' + enc(m.id) + '/share').then(function (s) { m.share = { token: s.token, url: s.url, sharedAt: s.sharedAt }; drawShare(el, m); toast('Updated with the latest votes'); }).catch(function (e) { showError(e); }); };
      $('#shOff', el).onclick = function () { api('DELETE', 'api/meetings/' + enc(m.id) + '/share').then(function () { m.share = null; drawShare(el, m); toast('Link revoked'); }).catch(function (e) { showError(e); }); };
      return;
    }
    el.innerHTML = '<p class="small muted" style="margin:0 0 10px">A public link to a frozen, numbers-only copy: cost, time, decisions counted, the room’s score. No title, no attendee names, no notes.</p><button class="btn block" id="shOn">Make a share link</button>';
    $('#shOn', el).onclick = function (e) {
      e.target.disabled = true;
      api('POST', 'api/meetings/' + enc(m.id) + '/share').then(function (s) { m.share = { token: s.token, url: s.url, sharedAt: s.sharedAt }; drawShare(el, m); }).catch(function (err) { e.target.disabled = false; showError(err); });
    };
  }

  /* ---------------- the recap ---------------- */

  function recapHTML(rec, opts) {
    opts = opts || {};
    var srcTag = function (x) { return x.source === 'log' ? '<span class="src">Logged</span>' : x.source === 'board' ? '<span class="src board">Whiteboard</span>' : '<span class="src notes">From notes</span>'; };
    var item = function (x, extra) {
      return '<li><div class="top-line"><b>' + esc(x.text) + '</b>' + srcTag(x) + '</div>' + (extra || '') + (x.quote ? '<span class="quote">“' + esc(x.quote) + '”</span>' : '') + '</li>';
    };
    var sec = function (title, rows, fn) { return rows.length ? '<div><div class="eyebrow" style="margin:12px 0 6px">' + esc(title) + '</div><ul class="rec-list">' + rows.map(fn).join('') + '</ul></div>' : ''; };
    return (rec.summary ? '<p style="margin:0;font-weight:650">' + gaps(rec.summary) + '</p>' : '') +
      sec('Decisions', rec.decisions, function (x) { return item(x); }) +
      sec('Actions', rec.actions, function (x) {
        return item(x, '<div class="small" style="margin-top:3px">' + (x.owner && x.owner !== '[owner?]' ? '<b>' + esc(x.owner) + '</b>' : '<span class="owner-q">[owner?]</span>') + (x.due ? ' · due ' + esc(R.fmtDue(x.due)) : '') + '</div>');
      }) +
      sec('Parking lot', rec.parking, function (x) { return item(x); }) +
      '<div class="small muted" style="margin-top:10px">Next meeting: ' + (rec.nextMeeting ? '<b>' + esc(rec.nextMeeting) + '</b>' : '<span class="gap">[add: when]</span>') + '</div>' +
      (rec.boardText ? '<details style="margin-top:10px"><summary class="small muted">What the whiteboard said</summary><div class="draft" style="margin-top:6px">' + esc(rec.boardText) + '</div></details>' : '') +
      ((rec.removed || []).length ? '<details style="margin-top:10px"' + (opts.openRemoved ? ' open' : '') + '><summary class="small muted">Taken out or unowned: ' + esc(R.plural(rec.removed.length, 'thing')) + '</summary><ul class="removed">' + rec.removed.map(function (x) { return '<li><b>' + esc(x.what) + '</b> — ' + esc(x.why) + '</li>'; }).join('') + '</ul></details>' : '');
  }

  function renderRecap(d) {
    var m = d.meeting;
    var tpl = R.recapTemplate(m, d.log);
    var photo = null;
    view.innerHTML = backLink('#/m/' + enc(m.id), 'Back to the receipt') +
      '<div class="page-head"><div><h1>The recap</h1><div class="sub">' + esc(m.title) + ' · ' + esc(fmtDay(m.day)) + '. Paste it into Slack or email — Receipt sends nothing itself.</div></div></div>' +
      '<div class="dk-split"><div class="stack"><div class="card"><div class="card-head"><h3>📋 Free: from the log</h3><span class="sub">exactly what was logged</span></div>' +
      '<textarea class="input" id="tplText" rows="12" style="font-family:var(--mono);font-size:13.5px">' + esc(tpl.body) + '</textarea>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn small" id="tplCopy">Copy</button><a class="btn small ghost" id="tplMail" href="' + esc(R.mailto(tpl.subject, tpl.body)) + '">Open in mail</a></div></div></div>' +
      '<div class="stack"><div class="card"><div class="card-head"><h3>✨ Write it for me</h3><span class="sub">about a cent</span></div>' +
      '<p class="small muted" style="margin:0 0 10px">From the log, plus rough notes or a Zoom, Teams or Meet transcript. Every item cites where it came from; an owner only when someone actually took it on; a date only when one was said. The notes and any photo are read once and never stored.</p>' +
      '<label class="field"><span>Notes or transcript (optional)</span><textarea class="input" id="notes" rows="6" maxlength="20000" placeholder="Jordan: I’ll send the revised brief by Friday.&#10;Sam will book the room."></textarea></label>' +
      '<label class="photo-pick"><input type="file" accept="image/*" id="photoIn"><span class="ic">🖼️</span><span class="grow"><b id="photoLbl">Add a whiteboard photo</b><span class="small muted" style="display:block">Optional · read once, never kept</span></span></label>' +
      '<div id="rErr"></div><button class="btn block" id="recBtn" style="margin-top:12px">✨ Write the recap <span class="cost">· ~1¢</span></button></div>' +
      '<div id="recOut"></div></div></div>';
    $('#tplCopy').onclick = function () { copy($('#tplText').value, 'Recap copied'); };
    $('#tplText').oninput = function (e) { $('#tplMail').href = R.mailto(tpl.subject, e.target.value); };
    $('#photoIn').onchange = function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      shrink(file).then(function (img) { photo = img; $('#photoLbl').textContent = '✓ Whiteboard photo ready'; }).catch(function (err) { showError(err, $('#rErr')); });
    };
    $('#recBtn').onclick = function (e) {
      var btn = e.target.closest('button'); btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> Writing…';
      var body = { notes: $('#notes').value };
      if (photo) body.image = photo;
      api('POST', 'api/meetings/' + enc(m.id) + '/recap', body).then(function (rec) {
        btn.disabled = false; btn.innerHTML = '✨ Write it again <span class="cost">· ~1¢</span>';
        $('#rErr').innerHTML = '';
        $('#recOut').innerHTML = '<div class="card"><div class="card-head"><h3>Your recap</h3><span class="sub">a proposal — edit before you send</span></div>' + recapHTML(rec) +
          '<textarea class="input" id="recText" rows="12" style="margin-top:12px;font-family:var(--mono);font-size:13.5px">' + esc(rec.body) + '</textarea>' +
          '<div class="btn-row" style="margin-top:10px"><button class="btn small" id="recCopy">Copy</button><a class="btn small ghost" id="recMail" href="' + esc(rec.mailto) + '">Open in mail</a></div></div>';
        $('#recCopy').onclick = function () { copy($('#recText').value, 'Recap copied'); };
        $('#recText').oninput = function (ev) { $('#recMail').href = R.mailto(rec.subject, ev.target.value); };
        loadMe();
      }).catch(function (err) { btn.disabled = false; btn.innerHTML = '✨ Write the recap <span class="cost">· ~1¢</span>'; showError(err, $('#rErr')); });
    };
  }

  /** Shrink a photo in the browser before it is sent: 1600px JPEG. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, 1600 / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        var data = cv.toDataURL('image/jpeg', 0.85);
        resolve({ type: 'image/jpeg', data: data.slice(data.indexOf(',') + 1) });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That image could not be opened. Try a JPEG or PNG photo.')); };
      img.src = url;
    });
  }

  /* ---------------- the sample ---------------- */

  function renderSample(sub) {
    loading();
    loadDemo().then(function (d) {
      if (sub === 'receipt') return sampleReceipt(d);
      if (sub === 'sharpen') return sampleSharpen(d);
      if (sub === 'audit') return renderAudit(d);
      if (sub === 'score') return scoreView(d.scoreboard, d.openActions, d);
      return sampleLive(d);
    }).catch(function (e) { showError(e, view); });
  }

  /**
   * The sample, played in the browser. A virtual clock runs at 60x; the
   * script's agenda marks, log entries, email taps and bingo squares land as
   * it passes them; the room votes in the wrap-up; and the end prints the
   * same receipt the server computed from the same rules.
   */
  function sampleLive(d) {
    var S = d.script;
    var setup = JSON.parse(JSON.stringify(d.meeting));
    var V0 = Date.now();
    var run = { speed: S.speed, t: 0, lastReal: null, running: false, done: false, ev: 0, votes: 0, marks: [], won: false };
    var m = Object.assign({}, setup, { startedAt: null, endedAt: null, pauses: [], marks: [] });
    var log = [];
    var emails = 0;
    var bingo = S.bingo;
    // The room votes during the wrap-up, one by one.
    var voteAt = S.votes.map(function (_, i) { return S.endMs - (S.votes.length - i) * 16000; });
    function vnow() { return V0 + run.t; }
    function advance() {
      if (!run.running) return;
      var real = Date.now();
      run.t += (real - run.lastReal) * run.speed;
      run.lastReal = real;
      if (run.t >= S.endMs) run.t = S.endMs;
      var changed = false;
      while (m.marks.length < S.marks.length - 1 && run.t >= S.marks[m.marks.length]) { m.marks.push(S.marks[m.marks.length]); changed = true; }
      while (run.ev < S.events.length && S.events[run.ev].at <= run.t) {
        var e = S.events[run.ev++];
        if (e.type === 'log') { var item = Object.assign({ at: e.at, createdAt: new Date(V0 + e.at).toISOString() }, e.log); log.push(item); changed = true; if (!run.quiet) ping(R.kindInfo(e.log.kind).emoji, e.log.text); }
        if (e.type === 'email') { emails++; changed = true; if (!run.quiet) ping('📧', 'Someone in the room: “could have been an email”'); }
        if (e.type === 'mark') { run.marks.push(e.cell); changed = true; }
        if (e.type === 'bingo') { run.won = true; changed = true; if (!run.quiet) { confetti(); ping('🦊', 'BINGO! 🦊 filled a line'); } }
      }
      while (run.votes < voteAt.length && run.t >= voteAt[run.votes]) { run.votes++; changed = true; }
      if (run.t >= S.endMs && !run.done) {
        run.done = true; run.running = false;
        m.marks = S.marks.slice();
        m.endedAt = new Date(V0 + S.endMs).toISOString();
        return finish();
      }
      if (changed) { live.updatePulse(pulse()); live.draw(); }
    }
    function pulse() {
      return { voters: Math.max(run.votes, emails), emailVotes: emails, roti: R.rotiSummary(S.votes.slice(0, run.votes)) };
    }
    function mini() {
      var line = run.won ? bingo.line : [];
      return '<div class="small muted" style="margin-top:12px">🎲 Bingo is on. ' + (run.won ? '<b>🦊 got bingo!</b>' : '🦊’s card:') + '</div><div class="mini-bingo' + (run.won ? ' win' : '') + '" aria-hidden="true">' +
        bingo.card.map(function (_, i) { return '<i class="' + (i === R.FREE ? 'free' : run.marks.indexOf(i) >= 0 || line.indexOf(i) >= 0 ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    }
    function finish() {
      stopTimers();
      $$('.ping').forEach(function (p) { p.remove(); });
      window.scrollTo(0, 0);
      var votes = S.votes.map(function (v) { return { roti: v.roti, email: false, handle: v.handle || null, bingoAt: v.handle ? new Date(V0 + bingo.winAt).toISOString() : null }; });
      for (var i = 0; i < emails && i < votes.length; i++) votes[votes.length - 1 - i].email = true;
      var r = R.receipt(m, log, votes, vnow());
      view.innerHTML = sampleBar('The sample meeting just ended. Every number below comes from the rules file — no AI, nothing saved.') + subnav('live') +
        '<div class="live-head"><div><span class="state ended">Ended</span><h1 style="margin-top:8px">' + esc(m.title) + '</h1></div><button class="btn small ghost" data-rerun>↺ Run it again</button></div>' +
        '<div class="dk-split dk-split-aside"><div class="' + (reducedMotion() ? '' : 'printing') + '"><div class="slot" aria-hidden="true"></div><div class="paper-wrap">' + receiptHTML(r) + '</div>' + receiptActions(r) + '</div>' +
        '<div class="stack dk-sticky"><div class="card"><h3>What just happened</h3><div style="margin-top:8px">' +
        '<div class="kv"><span>Cost</span><b>' + esc(usd(r.costUsd)) + '</b></div><div class="kv"><span>Decisions</span><b>' + esc(r.counts.decision) + ' · ' + esc(R.money(r.costPerDecision)) + ' each</b></div>' +
        '<div class="kv"><span>The campaign review</span><b class="bad">' + esc(R.money(r.items[1].overUsd)) + ' over</b></div><div class="kv"><span>The room’s ROTI</span><b>' + esc(r.roti.avg.toFixed(1)) + '/4</b></div>' +
        '<div class="kv"><span>Time given back</span><b class="good">' + esc(R.minText(r.givenBackMs)) + '</b></div></div></div>' +
        '<div class="card"><h3>Next in the sample</h3><div class="btn-row" style="margin-top:10px"><a class="btn ghost" href="#/sample/sharpen">✨ The sharpened agenda</a><a class="btn ghost" href="#/sample/audit">🪓 Swipe the audit</a></div></div>' +
        '<div class="card"><h3>Run your own</h3><p class="small muted" style="margin:6px 0 10px">Free: the meter, the room, the receipt, the audit. About a cent for an AI agenda or recap.</p>' + (signedIn() ? '<a class="btn block" href="#/new">New meeting</a>' : '<button class="btn block" data-signup>Start free</button>') + '</div></div></div>';
      wireSignup();
      wireReceiptActions(r);
      // The page is already on #/sample, so a link there changes nothing.
      $('[data-rerun]').onclick = function () { route(); };
    }
    var c = {
      demo: true,
      m: m,
      log: log,
      pulse: { voters: 0, emailVotes: 0, roti: { n: 0 } },
      now: vnow,
      speed: function () { return run.speed; },
      toggleSpeed: function () { run.speed = run.speed > 1 ? 1 : S.speed; },
      bingoMini: mini,
      onControl: function (k) {
        if (k === 'start') { m.startedAt = new Date(V0).toISOString(); run.running = true; run.lastReal = Date.now(); live.draw(); window.scrollTo(0, 0); }
        if (k === 'pause') { run.running = false; m.pauses = [{ at: new Date(vnow()).toISOString(), until: null }]; live.draw(); }
        if (k === 'resume') { m.pauses = []; run.running = true; run.lastReal = Date.now(); live.draw(); }
        if (k === 'skip') { if (!m.startedAt) m.startedAt = new Date(V0).toISOString(); run.quiet = true; run.running = true; run.lastReal = Date.now(); run.t = S.endMs; advance(); }
        if (k === 'restart') { route(); }
      },
      onLog: function (body) {
        var item = { kind: body.kind, text: R.clean(body.text, 200), owner: R.matchLabel(m.labels, body.owner), due: R.isoDay(body.due), at: R.elapsed(m, vnow()), createdAt: new Date().toISOString() };
        log.push(item);
        return item;
      },
    };
    // A paused sample keeps no pause interval: its virtual clock just stops.
    var live = mountLive(c);
    state.live = live;
    every(100, advance);
  }

  function sampleReceipt(d) {
    var r = d.receipt;
    view.innerHTML = sampleBar() + subnav('receipt') +
      '<div class="dk-split dk-split-aside"><div><div class="paper-wrap">' + receiptHTML(r) + '</div>' + receiptActions(r) + '</div>' +
      '<div class="stack dk-sticky"><div class="card"><h3>How to read it</h3><div style="margin-top:8px">' +
      '<div class="kv"><span>7 people at $760/h</span><b>' + esc(usd(r.hourly / 60)) + '/min</b></div>' +
      '<div class="kv"><span>38m 22s of 45 booked</span><b>' + esc(usd(r.costUsd)) + '</b></div>' +
      '<div class="kv"><span>÷ 3 decisions</span><b>' + esc(R.money(r.costPerDecision)) + ' each</b></div>' +
      '<div class="kv"><span>Campaign review: 18 of 15 min</span><b class="bad">+' + esc(R.money(r.items[1].overUsd)) + '</b></div>' +
      '<div class="kv"><span>5 votes: 4, 3, 3, 2, 1</span><b>ROTI ' + esc(r.roti.avg.toFixed(1)) + '</b></div></div>' +
      '<p class="small muted" style="margin:10px 0 0">Shared, it drops the title, the agenda’s names, the decisions and the attendees — numbers only.</p></div>' +
      '<div class="card"><h3>The same receipt, shared</h3><div class="btn-row" style="margin-top:10px"><button class="btn ghost" id="pubPng">⬇️ Numbers-only PNG</button></div></div></div></div>';
    wireReceiptActions(r);
    wireSignup();
    centerSubnav();
    $('#pubPng').onclick = function () { downloadPNG(r, { numbersOnly: true }, 'meeting-receipt-numbers-only.png'); };
  }

  function sampleSharpen(d) {
    var p = d.sharpen.proposal;
    var rec = d.recap.recap;
    view.innerHTML = sampleBar('Written by hand as examples of what the AI returns for this sample — clearly not a live model call.') + subnav('sharpen') +
      '<div class="section-title" style="margin-top:4px"><h2>✨ The agenda sharpener</h2><span class="count">example output</span></div>' +
      '<div class="dk-split"><div class="card"><div class="eyebrow" style="margin-bottom:6px">The invite, as sent</div><div class="vague">' + esc(d.sharpen.invite) + '</div>' +
      '<p class="small muted" style="margin:10px 0 0">45 minutes booked for seven people: about ' + esc(R.money(760 * 0.75)) + ' of time, and no outcome.</p></div>' +
      '<div class="card"><div class="eyebrow">Sharpened</div>' + proposalHTML(p, { actions: false, title: d.meeting.title }) + '</div></div>' +
      '<div class="section-title"><h2>📝 The recap writer</h2><span class="count">example output</span></div>' +
      '<div class="dk-split"><div class="card"><div class="eyebrow" style="margin-bottom:6px">Rough notes, pasted</div><div class="vague">' + esc(d.recap.notes) + '</div>' +
      '<p class="small muted" style="margin:10px 0 0">Plus the log from the meeting. Notes are read once and never stored.</p></div>' +
      '<div class="card">' + recapHTML(rec) + '<textarea class="input" rows="10" readonly style="margin-top:12px;font-family:var(--mono);font-size:13px">' + esc(rec.body) + '</textarea></div></div>';
    var cd = $('[data-copydraft]'); if (cd) cd.onclick = function () { copy(p.asyncDraft, 'Update copied'); };
    wireSignup();
    centerSubnav();
  }

  /* ---------------- the audit ---------------- */

  function cadenceText(r) { return R.cadenceInfo(r.cadence).label + ' · ' + r.minutes + ' min · ' + R.plural(R.headcount(r), 'person', 'people'); }

  /** The audit, for real (`sample` absent) or the sample's local copy. */
  function renderAudit(sample) {
    var rows = null;
    var totals = null;
    var saved = sample ? 0 : (recall('receipt-audit-shown') || 0);
    var local = sample ? JSON.parse(JSON.stringify(sample.audit)) : null;
    function load() {
      if (local) {
        var a = R.audit(local);
        rows = a.rows.map(function (x) { return Object.assign({}, x.r, { annual: x.annual, saved: x.saved, hours: x.hours, suggestion: R.shrinkSuggestion(x.r) }); });
        totals = a;
        return Promise.resolve();
      }
      return api('GET', 'api/recurring').then(function (a) { rows = a.rows; totals = a; });
    }
    function decide(row, decision, shrink) {
      if (local) {
        var x = local.filter(function (y) { return y.id === row.id; })[0];
        var r = R.validateRecurring({ decision: decision, shrink: shrink }, x);
        Object.assign(x, r.recurring);
        return load().then(draw);
      }
      return api('PUT', 'api/recurring/' + enc(row.id), { decision: decision, shrink: shrink }).then(function (a) { rows = a.rows; totals = a; draw(); });
    }
    function countUp(el, from, to) {
      if (!el) return;
      if (reducedMotion() || from === to) { el.textContent = R.money(to); return; }
      var t0 = performance.now();
      var step = function (t) {
        var k = Math.min(1, (t - t0) / 700);
        el.textContent = R.money(from + (to - from) * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    function draw() {
      var undecided = rows.filter(function (r) { return !r.decision; });
      var h = (sample ? sampleBar('A made-up company’s recurring meetings. Swipe them — nothing is saved.') + subnav('audit') : '') +
        '<div class="page-head"><div><h1>The meeting tax</h1><div class="sub">Every recurring meeting, priced for a year. Keep it, shrink it or kill it.</div></div></div>' +
        // Totals only once there is something to total: "$0 a year, 0
        // meetings" over an empty list says nothing.
        (rows.length ? '<div class="saved-card"><div><b class="num">' + esc(R.money(totals.totalAnnual)) + '</b><span>a year, ' + esc(R.plural(rows.length, 'meeting')) + ' · ' + esc(R.hoursText(totals.hoursPerYear).replace(' h', '')) + ' person-hours</span></div>' +
        '<div class="good"><b class="num" id="savedN">' + esc(R.money(saved)) + '</b><span>saved per year · ' + esc(R.hoursText(totals.hoursSaved).replace(' h', '')) + ' hours back</span></div></div>' : '');
      h += '<div class="dk-split dk-split-aside" style="margin-top:6px"><div>';
      if (!rows.length) {
        h += '<div class="empty boxed" style="margin-top:14px"><div class="e" aria-hidden="true">🪓</div><h2>Nothing to audit yet</h2><p>Add the meetings that repeat — the weekly sync, the stand-up, the all-hands — and see what each costs a year.</p>' +
          '<button class="btn" data-add-first>Add your first one</button></div>';
      } else if (undecided.length) {
            h += '<div class="section-title"><h2>Triage</h2><span class="count">' + esc(undecided.length) + ' to go · most expensive first</span></div>' +
          '<div class="deck" id="deck">' + undecided.slice(0, 3).reverse().map(function (r, i, arr) {
            var depth = arr.length - 1 - i;
            return '<div class="swipe' + (depth === 1 ? ' under' : depth === 2 ? ' under2' : '') + '"' + (depth === 0 ? ' id="topCard"' : ' aria-hidden="true"') + '>' +
              '<span class="stamp kill" aria-hidden="true">KILL</span><span class="stamp keep" aria-hidden="true">KEEP</span>' +
              '<div><h3>' + esc(r.title) + '</h3><div class="m">' + esc(cadenceText(r)) + '</div></div>' +
              '<div><div class="yr">' + esc(R.money(r.annual)) + '<small> / year</small></div><div class="m">' + esc(R.money(R.perMeeting(r))) + ' each time · ' + esc(R.hoursText(r.hours)) + ' of people’s time a year</div></div></div>';
          }).join('') + '</div>' +
          '<div class="triage"><button class="kill" data-dec="kill"><span class="e">🪓</span>Kill</button><button class="shrink" data-dec="shrink"><span class="e">✂️</span>Shrink</button><button class="keep" data-dec="keep"><span class="e">👍</span>Keep</button></div>' +
          '<p class="hint center">Swipe left to kill, right to keep — or tap.</p>';
      } else {
        h += '<div class="banner" style="margin-top:14px"><span class="e">🎉</span><span>Every recurring meeting has a verdict. ' + (totals.savedPerYear ? 'That’s <b>' + esc(R.money(totals.savedPerYear)) + '</b> a year handed back.' : '') + '</span></div>';
      }
      if (rows.length) {
        h += '<div class="section-title"><h2>All of them</h2><span class="count">ranked by cost</span></div><div class="list">' + rows.map(function (r) {
          var max = rows[0].annual || 1;
          var tag = r.decision === 'kill' ? '<span class="tag bad">Killed · saves ' + esc(R.money(r.saved)) + '</span>' : r.decision === 'shrink' ? '<span class="tag warn">Shrunk · saves ' + esc(R.money(r.saved)) + '</span>' : r.decision === 'keep' ? '<span class="tag good">Kept</span>' : '<span class="tag">Undecided</span>';
          return '<button class="arow2' + (r.decision === 'kill' ? ' killed' : '') + '" data-row="' + esc(r.id) + '"><span style="min-width:0"><span class="t" style="display:block">' + esc(r.title) + '</span><span class="m" style="display:block">' + esc(cadenceText(r)) + '</span>' +
            '<span class="bar-cost" style="display:block"><i style="width:' + Math.round(r.annual / max * 100) + '%"></i></span></span><span class="n"><b>' + esc(R.money(r.annual)) + '</b>' + tag + '</span></button>';
        }).join('') + '</div>';
      }
      h += '</div><div class="dk-sticky"><div class="section-title col-top"><h2>Add a recurring meeting</h2></div><form class="card" id="addRec">' +
        '<label class="field"><span>Name</span><input class="input" name="title" maxlength="80" placeholder="Weekly all-hands" required></label>' +
        '<div class="grid2"><label class="field"><span>Minutes</span><input class="input" name="minutes" inputmode="numeric" value="30"></label>' +
        '<label class="field"><span>How often</span><select class="input" name="cadence">' + R.CADENCES.map(function (cd) { return '<option value="' + cd.key + '"' + (cd.key === 'weekly' ? ' selected' : '') + '>' + esc(cd.label) + '</option>'; }).join('') + '</select></label></div>' +
        '<div id="recPeople"></div><div class="costline" id="recCost"></div><div id="aErr"></div><button class="btn block" style="margin-top:12px">Add it</button></form></div></div>';
      view.innerHTML = h;
      wireSignup();
      if (sample) centerSubnav();
      var first = $('[data-add-first]');
      if (first) first.onclick = function () { var t = $('#addRec [name=title]'); t.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); t.focus({ preventScroll: true }); };
      countUp($('#savedN'), saved, totals.savedPerYear);
      saved = totals.savedPerYear;
      if (!sample) store('receipt-audit-shown', saved);
      wireDeck(undecided[0]);
      $$('[data-row]').forEach(function (b) { b.onclick = function () { openRow(rows.filter(function (r) { return r.id === b.dataset.row; })[0]); }; });
      var nf = { mode: 'bands', loaded: false, people: R.BANDS.map(function (x) { return { band: x.key, rate: x.rate, count: x.key === 'ic' ? 4 : x.key === 'manager' ? 1 : 0 }; }) };
      var addForm = $('#addRec');
      var redrawPeople = function (full) {
        if (full) { $('#recPeople').innerHTML = peopleFields(nf, 'r'); wirePeople($('#recPeople'), nf, redrawPeople, 'r'); }
        var mins = R.intIn(addForm.minutes.value, 1, 480) || 0;
        var tmp = { people: nf.people, loaded: nf.loaded, minutes: mins, cadence: addForm.cadence.value };
        $('#recCost').innerHTML = 'About <b>' + esc(R.money(R.annualCost(tmp))) + '</b> a year — ' + esc(R.money(R.perMeeting(tmp))) + ' each time.';
      };
      redrawPeople(true);
      addForm.minutes.oninput = function () { redrawPeople(false); };
      addForm.cadence.onchange = function () { redrawPeople(false); };
      addForm.onsubmit = function (e) {
        e.preventDefault();
        var body = { title: addForm.title.value, minutes: addForm.minutes.value, cadence: addForm.cadence.value, mode: nf.mode, people: nf.people, loaded: nf.loaded };
        if (local) {
          var r = R.validateRecurring(body);
          if (r.error) return showError(new Error(r.error), $('#aErr'));
          local.push(Object.assign({ id: 's' + Date.now() }, r.recurring));
          return load().then(draw).then(function () { toast('Added (sample — saved nowhere)'); });
        }
        api('POST', 'api/recurring', body).then(function (a) { rows = a.rows; totals = a; draw(); toast('Added'); }).catch(function (err) { showError(err, $('#aErr')); });
      };
    }
    function wireDeck(top) {
      if (!top) return;
      var card = $('#topCard');
      $$('[data-dec]').forEach(function (b) {
        b.onclick = function () { go(b.dataset.dec); };
      });
      function go(dec) {
        if (dec === 'shrink') return openShrink(top);
        if (!reducedMotion() && card) {
          card.style.transform = 'translateX(' + (dec === 'kill' ? -130 : 130) + '%) rotate(' + (dec === 'kill' ? -18 : 18) + 'deg)';
          card.style.opacity = '0';
        }
        setTimeout(function () {
          decide(top, dec).then(function () { if (dec === 'kill') toast('🪓 Killed — ' + R.money(R.annualCost(top)) + ' a year back'); }).catch(function (e) { showError(e); });
        }, reducedMotion() ? 0 : 280);
      }
      if (!card) return;
      var x0 = null; var dx = 0; var id = null;
      card.addEventListener('pointerdown', function (e) { x0 = e.clientX; dx = 0; id = e.pointerId; card.setPointerCapture(id); card.classList.add('drag'); });
      card.addEventListener('pointermove', function (e) {
        if (x0 === null) return;
        dx = e.clientX - x0;
        card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 18) + 'deg)';
        $('.stamp.kill', card).style.opacity = Math.max(0, Math.min(1, -dx / 90));
        $('.stamp.keep', card).style.opacity = Math.max(0, Math.min(1, dx / 90));
      });
      var end = function () {
        if (x0 === null) return;
        x0 = null; card.classList.remove('drag');
        if (dx < -90) go('kill');
        else if (dx > 90) go('keep');
        else { card.style.transform = ''; $$('.stamp', card).forEach(function (s) { s.style.opacity = 0; }); }
      };
      card.addEventListener('pointerup', end);
      card.addEventListener('pointercancel', end);
    }
    function openShrink(r) {
      var s = r.shrink ? JSON.parse(JSON.stringify(r.shrink)) : JSON.parse(JSON.stringify(r.suggestion || R.shrinkSuggestion(r)));
      var inUse = R.bandsInUse(r);
      function body() {
        var after = R.shrunk(r, s);
        return '<h2>✂️ Shrink “' + esc(r.title) + '”</h2><p class="muted small">Now ' + esc(cadenceText(r)) + ' — ' + esc(R.money(r.annual)) + ' a year.</p>' +
          '<div class="label" id="shL">Length</div><div class="chips" role="group" aria-labelledby="shL">' + [r.minutes, (r.suggestion || R.shrinkSuggestion(r)).minutes, 60, 45, 30, 25, 20, 15, 10].filter(function (n, i, a) { return n <= r.minutes && a.indexOf(n) === i; }).sort(function (x, y) { return y - x; }).map(function (n) { return '<button type="button" class="chip' + (s.minutes === n ? ' on' : '') + '" aria-pressed="' + (s.minutes === n) + '" data-sm="' + n + '">' + n + ' min</button>'; }).join('') + '</div>' +
          '<div class="label" id="shC">How often</div><div class="chips" role="group" aria-labelledby="shC">' + R.CADENCES.filter(function (cd) { return R.CADENCE_KEYS.indexOf(cd.key) >= R.CADENCE_KEYS.indexOf(r.cadence); }).map(function (cd) { return '<button type="button" class="chip' + (s.cadence === cd.key ? ' on' : '') + '" aria-pressed="' + (s.cadence === cd.key) + '" data-sc="' + cd.key + '">' + esc(cd.label) + '</button>'; }).join('') + '</div>' +
          (inUse.length > 1 ? '<div class="label" id="shD">Send the recap instead to</div><div class="chips" role="group" aria-labelledby="shD">' + inUse.map(function (b) { return '<button type="button" class="chip' + (s.drop.indexOf(b) >= 0 ? ' on' : '') + '" aria-pressed="' + (s.drop.indexOf(b) >= 0) + '" data-sd="' + b + '">' + esc(R.bandInfo(b).label + 's') + '</button>'; }).join('') + '</div>' : '') +
          '<div class="costline" style="margin-top:14px">After: <b>' + esc(R.money(R.annualCost(after))) + '</b> a year. Saves <b class="good">' + esc(R.money(Math.max(0, r.annual - R.annualCost(after)))) + '</b>.</div>' +
          '<button class="btn block" id="doShrink" style="margin-top:12px">Shrink it</button>';
      }
      sheet('<div id="shr">' + body() + '</div>', function (root) {
        var wire = function () {
          $$('[data-sm]', root).forEach(function (b) { b.onclick = function () { s.minutes = Number(b.dataset.sm); redraw(); }; });
          $$('[data-sc]', root).forEach(function (b) { b.onclick = function () { s.cadence = b.dataset.sc; redraw(); }; });
          $$('[data-sd]', root).forEach(function (b) {
            b.onclick = function () {
              var i = s.drop.indexOf(b.dataset.sd);
              if (i >= 0) s.drop.splice(i, 1); else if (s.drop.length < inUse.length - 1) s.drop.push(b.dataset.sd); else toast('Somebody still has to be there.');
              redraw();
            };
          });
          $('#doShrink', root).onclick = function () { closeSheet(); decide(r, 'shrink', s).then(function () { toast('✂️ Shrunk'); }).catch(function (e) { showError(e); }); };
        };
        // Redrawn in place; focus goes back to the chip that was pressed.
        var redraw = function () {
          var a = document.activeElement;
          var key = a && a.dataset ? ['sm', 'sc', 'sd'].filter(function (k) { return a.dataset[k] !== undefined; }).map(function (k) { return '[data-' + k + '="' + a.dataset[k] + '"]'; })[0] : null;
          $('#shr', root).innerHTML = body(); wire(); labelSheet();
          var back = key && $(key, root); if (back) back.focus();
        };
        wire();
      });
    }
    function openRow(r) {
      sheet('<h2>' + esc(r.title) + '</h2><p class="muted">' + esc(cadenceText(r)) + ' · ' + esc(R.money(r.annual)) + ' a year</p>' +
        '<div class="triage" style="margin-top:12px"><button class="kill" data-d="kill"><span class="e">🪓</span>Kill</button><button class="shrink" data-d="shrink"><span class="e">✂️</span>Shrink</button><button class="keep" data-d="keep"><span class="e">👍</span>Keep</button></div>' +
        (r.decision ? '<button class="btn ghost block" data-d="undo" style="margin-top:10px">Undo the decision</button>' : '') +
        '<button class="btn danger block" id="delRow" style="margin-top:10px">Remove from the audit</button>',
        function (root) {
          $$('[data-d]', root).forEach(function (b) {
            b.onclick = function () {
              closeSheet();
              var dd = b.dataset.d;
              if (dd === 'shrink') return openShrink(r);
              decide(r, dd === 'undo' ? null : dd).catch(function (e) { showError(e); });
            };
          });
          $('#delRow', root).onclick = function () {
            closeSheet();
            if (local) { local = local.filter(function (y) { return y.id !== r.id; }); load().then(draw); return; }
            api('DELETE', 'api/recurring/' + enc(r.id)).then(function (a) { rows = a.rows; totals = a; draw(); }).catch(function (e) { showError(e); });
          };
        });
    }
    if (!sample) loading();
    load().then(draw).catch(function (e) { showError(e, view); });
  }

  /* ---------------- the scoreboard ---------------- */

  function renderScore() {
    loading();
    api('GET', 'api/scoreboard').then(function (s) { scoreView(s.scoreboard, s.openActions, null); }).catch(function (e) { showError(e, view); });
  }

  function scoreView(sb, actions, sample) {
    var maxW = Math.max.apply(null, sb.weeks.map(function (w) { return w.costUsd; }).concat([1]));
    var trend = sb.rotiTrend || [];
    // One column per meeting (no empty columns), and on a phone the label is
    // the day number alone - "Sep 16" is wider than a tenth of the card.
    var svg = trend.length ? '<div class="bars roti-bars" role="img" aria-label="ROTI for the last ' + trend.length + ' meetings with votes" style="grid-template-columns:repeat(' + trend.length + ',minmax(0,1fr))">' + trend.map(function (t) {
      return '<div class="b' + (t.avg >= 3 ? ' now' : t.avg < 2 ? ' low' : '') + '" title="' + esc(t.title + ' · ' + fmtDay(t.day) + ' · ' + t.avg.toFixed(1) + '/4') + '"><em>' + esc(t.avg.toFixed(1)) + '</em><i style="height:' + Math.round(t.avg / 4 * 100) + '%"></i><span><span class="mo">' + esc(fmtDay(t.day, { weekday: undefined, day: undefined })) + ' </span>' + esc(fmtDay(t.day, { weekday: undefined, month: undefined })) + '</span></div>';
    }).join('') + '</div>' : '';
    view.innerHTML = (sample ? sampleBar('A made-up month of meetings — real rules, nothing saved.') + subnav('score') : '') +
      '<div class="page-head"><div><h1>Scoreboard</h1><div class="sub">Team totals only. Nobody is ranked; the time you give back is the score.</div></div></div>' +
      '<div class="tiles">' +
      '<div class="tile"><div class="k">This week</div><b>' + esc(R.money(sb.thisWeek.costUsd)) + '</b><span>' + esc(R.plural(sb.thisWeek.meetings, 'meeting')) + ' · ' + esc(R.hoursText(sb.thisWeek.personHours)) + '</span></div>' +
      '<div class="tile hot"><div class="k">On-time streak</div><b>🔥 ' + esc(sb.streak) + '</b><span>best ' + esc(sb.bestStreak) + ' in a row</span></div>' +
      '<div class="tile good"><div class="k">Time given back</div><b>' + esc(R.minText(sb.givenBackMs)) + '</b><span>' + esc(R.hoursText(sb.givenBackPersonHours)) + ' of people’s time</span></div>' +
      '<div class="tile good"><div class="k">Audit savings</div><b>' + esc(R.money(sb.savedPerYear)) + '</b><span>a year, from Keep · Shrink · Kill</span></div>' +
      '</div>' +
      '<div class="dk-split" style="margin-top:12px"><div class="stack">' +
      '<div class="card"><div class="card-head"><h3>Meeting cost by week</h3><span class="sub">last 8 weeks</span></div><div class="bars">' + sb.weeks.map(function (w, i) {
        return '<div class="b' + (i === sb.weeks.length - 1 ? ' now' : '') + '" title="' + esc('Week of ' + fmtDay(w.week) + ': ' + R.money(w.costUsd) + ', ' + R.plural(w.meetings, 'meeting')) + '"><em>' + (w.costUsd ? esc(R.money(w.costUsd).replace(/,(\d)\d\d$/, '.$1k').replace(/,\d{3}$/, 'k')) : '') + '</em><i style="height:' + Math.round(w.costUsd / maxW * 100) + '%"></i><span>' + esc(fmtDay(w.week, { weekday: undefined })) + '</span></div>';
      }).join('') + '</div></div>' +
      '<div class="card"><div class="card-head"><h3>Was it worth it?</h3><span class="sub">ROTI, 0–4, by meeting</span></div>' + (svg || '<p class="muted small" style="margin:0">No votes yet — share the room code in your next meeting.</p>') + '</div>' +
      (sb.priciest ? '<div class="card"><div class="eyebrow">Most expensive this month</div><div class="row spread" style="margin-top:6px"><b style="font-size:17px">' + esc(sb.priciest.title) + '</b><b class="num" style="font-size:20px">' + esc(R.money(sb.priciest.costUsd)) + '</b></div><div class="small muted">' + esc(fmtDay(sb.priciest.day)) + '</div></div>' : '') +
      '</div><div class="stack">' +
      '<div class="card"><div class="card-head"><h3>Badges</h3><span class="sub">' + esc(sb.badges.length) + ' of ' + R.BADGES.length + '</span></div><div class="badges">' + R.BADGES.map(function (b) {
        var on = sb.badges.indexOf(b.key) >= 0;
        return '<div class="badge' + (on ? '' : ' off') + '"><div class="e" aria-hidden="true">' + b.emoji + '</div><b>' + esc(b.label) + '</b><span>' + esc(b.detail) + '</span></div>';
      }).join('') + '</div></div>' +
      '<div class="card"><div class="card-head"><h3>Actions after the meeting</h3><span class="sub">' + esc(sb.actions.open) + ' open · ' + esc(sb.actions.done) + ' done · ' + esc(sb.actions.dropped) + ' dropped</span></div>' +
      ((actions || []).length ? '<ul class="logl">' + actions.map(function (a) {
        var hi = R.heatInfo(a.heat.state);
        return '<li><span class="e" aria-hidden="true">' + hi.emoji + '</span><span style="min-width:0"><span class="t" style="display:block">' + esc(a.text) + '</span><span class="m">' + esc([a.owner || 'No owner', a.due ? 'due ' + R.fmtDue(a.due) : '', a.meetingTitle].filter(Boolean).join(' · ')) + '</span></span><span class="heat ' + esc(a.heat.state) + '">' + esc(hi.label) + '</span></li>';
      }).join('') + '</ul>' : '<p class="muted small" style="margin:0">No open actions. Log one with 📌 during a meeting.</p>') +
      '<p class="hint">Dropped actions are counted for the team, never by person.</p></div>' +
      '</div></div>';
    wireSignup();
    if (sample) centerSubnav();
  }

  /* ---------------- the room (attendees, no account) ---------------- */

  function renderRoom(codeRaw) {
    document.body.classList.add('public');
    document.body.classList.remove('dk');
    var code = R.formatCode(codeRaw);
    var key = 'receipt-bingo-' + R.normalizeCode(code);
    var marks = recall(key) || [];
    var handle = recall('receipt-handle') || null;
    var data = null;
    var busy = false;
    var claimed = false;
    function load(first) {
      return api('GET', 'api/room/' + enc(R.normalizeCode(code))).then(function (d) {
        state.skew = Date.parse(d.now) - Date.now();
        var changed = !data || JSON.stringify([d.status, d.me, d.room, d.bingo && d.bingo.winner, d.meeting.marks]) !== JSON.stringify([data.status, data.me, data.room, data.bingo && data.bingo.winner, data.meeting.marks]);
        data = d;
        if (d.me.handle) handle = d.me.handle;
        if (d.me.bingoAt) claimed = true;
        if (first || changed) draw();
      });
    }
    function draw() {
      var d = data;
      var m = d.meeting;
      var L = R.live(m, now());
      var st = d.status;
      document.title = m.title + ' · the room';
      var cur = L.agenda.current;
      var h = '<div class="room"><div class="brandline"><a href="./"><span class="mark" aria-hidden="true" style="font-size:20px">🧾</span>Receipt</a><span class="small muted">Room ' + esc(d.code) + '</span></div>' +
        '<div class="ticker"><div class="row spread"><span class="state ' + st + '">' + (st === 'waiting' ? 'Not started' : st === 'paused' ? 'Paused' : st === 'ended' ? 'Ended' : 'Live') + '</span><span class="small muted">' + esc(R.plural(L.headcount, 'person', 'people')) + '</span></div>' +
        '<h1 style="font-size:22px;margin-top:10px;overflow-wrap:anywhere">' + esc(m.title) + '</h1>' +
        (st === 'waiting' ? '<p class="muted" style="margin:8px 0 0">It hasn’t started yet. Keep this open — voting opens when it does.</p>' :
          '<div class="usd" id="rUsd" style="font-size:clamp(44px,14vw,72px)">' + bigUsd(L.costUsd) + '</div><div class="meta" id="rMeta"></div>' +
          (cur ? '<div class="small muted" style="margin-top:6px">Now: <b style="color:var(--text)">' + esc(cur.title) + '</b> · <span id="rLeft"></span></div>' : '') +
          (st === 'ended' && L.leftMs >= R.MIN ? '<div class="good" style="margin-top:8px;font-weight:800">🎉 Finished early: ' + esc(R.minText(L.leftMs)) + ' given back</div>' : '')) +
        '<div class="note">Estimated from role-band rates — nobody’s salary.</div></div>';
      if (d.votingOpen) {
        h += '<div class="stack" style="margin-top:12px">' +
          '<button class="email-btn' + (d.me.email ? ' on' : '') + '" id="emailBtn" aria-pressed="' + d.me.email + '"><span class="e" aria-hidden="true">📧</span><span><b>' + (d.me.email ? 'You said: could have been an email' : 'Could this have been an email?') + '</b><span class="sub">' + esc(R.plural(d.room.emailVotes, 'person thinks', 'people think')) + ' so. Tap to ' + (d.me.email ? 'take it back' : 'say so') + '.</span></span></button>' +
          '<div class="card"><h3>' + (st === 'ended' ? 'It’s over — was it worth your time?' : 'Was this worth your time?') + '</h3><p class="small muted" style="margin:4px 0 10px">Return on time invested, 0 to 4. Change it any time until tomorrow.</p>' +
          '<div class="roti" role="group" aria-label="Your vote">' + R.ROTI.map(function (x) {
            return '<button data-roti="' + x.v + '" class="' + (d.me.roti === x.v ? 'on' : '') + '" aria-pressed="' + (d.me.roti === x.v) + '"><span class="e" aria-hidden="true">' + x.emoji + '</span><b>' + x.v + '</b><span>' + esc(x.label) + '</span></button>';
          }).join('') + '</div><p class="small muted" style="margin:10px 0 0">' + esc(R.plural(d.room.rotiN, 'vote')) + ' so far. Anonymous — one per browser.</p></div></div>';
      } else if (st !== 'waiting') {
        h += '<div class="banner" style="margin-top:12px"><span class="e">🔒</span><span>Voting has closed for this meeting.</span></div>';
      }
      if (d.bingo && st !== 'waiting') {
        var card = d.bingo.card;
        var line = R.bingoLine(marks);
        h += '<div class="card" style="margin-top:12px"><div class="card-head"><h3>🎲 Buzzword bingo</h3><span class="sub">' + (d.bingo.winner ? esc(d.bingo.winner) + ' won' : 'your own card') + '</span></div>';
        if (!handle) {
          h += '<p class="small muted" style="margin:0 0 10px">Pick who you’ll be. Just an emoji — no name.</p><div class="handles">' + R.HANDLES.map(function (x) { return '<button data-h="' + esc(x) + '" aria-label="Play as ' + esc(x) + '">' + esc(x) + '</button>'; }).join('') + '</div>';
        } else {
          var over = st === 'ended';
          if (claimed) h += '<div class="bingo-banner" style="margin-bottom:10px">BINGO! ' + esc(handle) + '</div>';
          h += '<div class="bingo' + (over ? ' closed' : '') + '">' + card.map(function (p, i) {
            var on = i === R.FREE || marks.indexOf(i) >= 0;
            var win = line && line.indexOf(i) >= 0;
            return '<button data-cell="' + i + '" class="' + (i === R.FREE ? 'free' : '') + (on && i !== R.FREE ? ' on' : '') + (win ? ' win' : '') + '" aria-pressed="' + on + '"' + (i === R.FREE || over ? ' disabled' : '') + '>' + esc(i === R.FREE ? '★ FREE' : p) + '</button>';
          }).join('') + '</div><p class="small muted" style="margin:10px 0 0">' + (over
            ? 'The meeting is over — bingo is closed.' + (d.bingo.winner ? ' ' + esc(d.bingo.winner) + ' got a line first.' : ' Nobody got a line.')
            : 'Playing as ' + esc(handle) + '. Tap a square when you hear it. A full line is bingo.') + '</p>';
        }
        h += '</div>';
      }
      h += '<p class="center small faint" style="margin-top:22px">Made with <a href="./">Receipt 🧾</a> — every meeting gets a receipt.</p></div>';
      view.innerHTML = h;
      wire();
      tick();
    }
    function tick() {
      var d = data;
      if (!d) return;
      var L = R.live(d.meeting, now());
      var u = $('#rUsd'); if (u) u.innerHTML = bigUsd(L.costUsd);
      var mt = $('#rMeta'); if (mt) mt.innerHTML = '<b>' + esc(R.clockText(L.elapsedMs)) + '</b> of ' + esc(R.clockText(L.bookedMs)) + ' · ' + esc(usd(L.perMinute)) + ' a minute';
      var lf = $('#rLeft'); var cur = L.agenda.current;
      if (lf && cur) lf.innerHTML = cur.overMs > 0 ? '<span class="bad">' + esc(R.money(cur.overUsd)) + ' over</span>' : esc(R.clockText(cur.leftMs)) + ' left';
    }
    function send(path, body, after) {
      if (busy) return;
      busy = true;
      api('POST', 'api/room/' + enc(R.normalizeCode(code)) + '/' + path, body).then(function (d) {
        busy = false;
        data = Object.assign(data, d);
        if (after) after(d);
        draw();
      }).catch(function (e) { busy = false; if (e.status === 404) gone(e); else showError(e); });
    }
    /** The code stopped working (reset, or the meeting deleted) or this
     *  network is being told to slow down: stop asking. Polling a dead code
     *  every 10 s from a room full of phones is what used to trip the
     *  wrong-code limit for everyone on the same Wi-Fi. */
    function gone(e) {
      stopTimers();
      var reset = e.status === 404;
      view.innerHTML = '<div class="room"><div class="empty"><div class="e" aria-hidden="true">' + (reset ? '🔄' : '⏳') + '</div><h2>' + (reset ? 'This room’s code changed' : 'Slow down') + '</h2><p>' +
        esc(reset ? 'Whoever is running the meeting reset the code, or ended and deleted it. Scan the new QR code on their screen.' : e.message) + '</p><a class="btn" href="./#/join">Enter the new code</a></div></div>';
    }
    function wire() {
      var eb = $('#emailBtn'); if (eb) eb.onclick = function () { send('email', { on: !data.me.email }); };
      $$('[data-roti]').forEach(function (b) {
        b.onclick = function () { var v = Number(b.dataset.roti); send('vote', { roti: data.me.roti === v ? null : v }, function () { toast(data.me.roti === null ? 'Vote withdrawn' : 'Thanks — counted'); }); };
      });
      $$('[data-h]').forEach(function (b) { b.onclick = function () { handle = b.dataset.h; store('receipt-handle', handle); draw(); }; });
      $$('[data-cell]').forEach(function (b) {
        b.onclick = function () {
          var i = Number(b.dataset.cell);
          var k = marks.indexOf(i);
          if (k >= 0) marks.splice(k, 1); else marks.push(i);
          store(key, marks);
          if (R.bingoLine(marks) && !claimed) {
            send('bingo', { handle: handle, marks: marks }, function (d) { claimed = true; confetti(); ping(handle, d.bingo && d.bingo.winner === handle ? 'BINGO! You’re first.' : 'BINGO! ' + (d.bingo && d.bingo.winner ? d.bingo.winner + ' got there first.' : '')); });
          } else draw();
        };
      });
    }
    loading();
    load(true).catch(function (e) {
      view.innerHTML = '<div class="room"><div class="empty"><div class="e">🔍</div><h2>' + (e.status === 429 ? 'Slow down' : 'No such room') + '</h2><p>' + esc(e.message) + '</p><a class="btn" href="./#/join">Try another code</a></div></div>';
    });
    every(reducedMotion() ? 1000 : 250, function () { if (visible()) tick(); });
    every(10000, function () {
      if (visible() && !busy) load(false).catch(function (e) { if (e.status === 404 || e.status === 429) gone(e); /* anything else: next time */ });
    });
  }

  /* ---------------- the shared receipt ---------------- */

  function renderShared(token) {
    document.body.classList.add('public');
    document.body.classList.remove('dk');
    loading();
    api('GET', 'api/shared/' + token).then(function (c) {
      document.title = 'A meeting receipt · ' + R.money(c.costUsd);
      view.innerHTML = (c.preview ? '<div class="banner" style="margin:0 auto 12px;max-width:520px"><span class="e">👀</span><span>This is what people see — a frozen, numbers-only copy. Update it from the meeting’s receipt.</span></div>' : '') +
        '<div class="paper-wrap">' + receiptHTML(c, { numbersOnly: true }) + '</div>' + receiptActions(c) +
        '<p class="center small muted" style="margin:16px auto 0;max-width:46ch">Frozen ' + esc(fmtDay(c.frozenAt, { year: 'numeric' })) + '. Numbers only — no title, no names, no decisions or notes are on this receipt.</p>' +
        '<p class="center small faint" style="margin-top:18px">Made with <a href="./">Receipt 🧾</a> — every meeting gets a receipt.</p>';
      wireReceiptActions(c, { numbersOnly: true });
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><div class="e">🔒</div><h2>This link isn’t valid</h2><p>' + esc(e.message) + '</p><a class="btn" href="./">What is Receipt?</a></div>';
    });
  }

  /* ---------------- boot ---------------- */

  document.addEventListener('visibilitychange', function () {
    // A locked phone comes back to the right number: everything is computed
    // from timestamps, so a redraw is all it takes.
    if (visible() && state.live && state.live.tick) state.live.tick(false);
  });

  if (PUB || ROOM) { route(); return; }
  loadMe().then(function () { ready = true; route(); });
})();
