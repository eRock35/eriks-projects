/* Tally - the page. One file, no build step, every typed, imported or
 * model-read string escaped. The matching, the calendar and the export are
 * computed with the same public/rules.js the server uses. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');
  var R = window.TallyRules;

  // Where the app is mounted: '/' on its own, '/tally/' inside the lab.
  var BASE = new URL('.', document.baseURI).pathname;

  var state = { me: null, demo: null, sample: null, books: null, flash: null, after: null };

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var enc = encodeURIComponent;
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
          e.status = res.status; e.data = data; e.field = data.field;
          throw e;
        }
        return data;
      });
    });
  }

  function toast(msg, ms) {
    $$('.toast').forEach(function (t) { t.remove(); });
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2800);
  }
  function ping(emoji, msg) {
    $$('.ping').forEach(function (p) { p.remove(); });
    var t = document.createElement('div');
    t.className = 'ping'; t.setAttribute('role', 'status');
    t.innerHTML = '<span class="e" aria-hidden="true">' + esc(emoji) + '</span><span>' + esc(msg) + '</span>';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3600);
  }
  /** A 402 is a till, not a wall: say what happened and where to go. */
  function showError(err, where) {
    if (err && err.status === 402) return openCreditSheet(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.', 'login');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<div class="err" role="alert">' + esc(msg) + '</div>'; else toast(msg, 3800);
  }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function initials(s) { return String(s || '?').split(/[\s@.]+/).filter(Boolean).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function confetti() {
    if (reducedMotion()) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var colors = ['#3fbf7f', '#f5f3ec', '#d9a21b', '#16693f', '#3fa7d6'];
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

  function download(name, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  };

  function statusPill(status) {
    var s = R.STATUS[status];
    return '<span class="st ' + esc(status) + '"><i aria-hidden="true"><b>' + esc(s.icon) + '</b></i>' + esc(s.label) + '</span>';
  }

  /* ---------------- me, the sample and the books ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function signedIn() { return state.me && state.me.signedIn; }
  function loadDemo() {
    if (state.demo) return Promise.resolve(state.demo);
    return api('GET', 'api/demo').then(function (d) { state.demo = d; return d; });
  }
  /** The sample's books, as the visitor has changed them in this tab. Never
   *  sent anywhere; a reload starts it over. */
  function sampleBooks() {
    return loadDemo().then(function (d) {
      if (!state.sample) state.sample = { settings: clone(d.settings), days: clone(d.days), deposits: clone(d.deposits), today: d.today, business: d.business };
      return state.sample;
    });
  }
  function loadBooks() {
    return api('GET', 'api/books').then(function (b) { state.books = b; return b; });
  }
  function booksFor(mode) { return mode === 'sample' ? sampleBooks() : loadBooks(); }
  function compute(b) { return R.reconcile(b.days, b.deposits, b.settings, b.today); }
  function matchedSet(b) {
    var out = {};
    compute(b).rows.forEach(function (r) { if (r.status === 'matched') out[r.date] = 1; });
    return out;
  }
  /** "Books balanced" - the days that became matched with this change. */
  function celebrate(before, b) {
    var after = compute(b);
    var fresh = after.rows.filter(function (r) { return r.status === 'matched' && !before[r.date]; });
    if (!fresh.length) return false;
    confetti();
    var st = R.streak(after.rows);
    ping('✅', 'Books balanced · ' + (fresh.length === 1 ? R.dayShort(fresh[0].date) : R.plural(fresh.length, 'day')) + (st.current > 1 ? ' · ' + st.current + ' days in a row' : ''));
    return true;
  }
  function href(mode, path) { return (mode === 'sample' ? '#/sample' : '#') + (path ? '/' + path : '/'); }

  // Passkeys are bound to the shared domain; on a staging *.run.app host they
  // cannot work, so the buttons are not offered there.
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }

  function drawTop() {
    var el = $('#topRight');
    var me = state.me;
    if (!me || !me.signedIn) {
      el.innerHTML = '<a class="btn small ghost hide-xs" href="#/sample">See a sample</a><button class="btn small" id="signInTop">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(null, 'login'); };
      return;
    }
    var b = me.budget || {};
    el.innerHTML = '<span class="pill credit" title="AI credit, for snapping reports">' + (b.unlimited ? '∞' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + ' AI</span>' +
      '<button class="avatar-btn" id="acctBtn" aria-label="Account">' + esc(initials(me.email)) + '</button>';
    $('#acctBtn').onclick = function () { openAccount(); };
  }

  /* ---------------- sheets ---------------- */

  var sheetOpener = null;
  /** A modal sheet: a visible Close, named by its first heading, Tab kept
   *  inside, focus handed back to whatever opened it. */
  function sheet(html, onMount) {
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
  function labelSheet() { var h = $('#scrim .sheet h2'); if (h) h.id = 'sheetTitle'; }
  function closeSheet(keepFocus) {
    var s = $('#scrim');
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
    if (e.key === 'Escape') closeSheet();
    if (e.key === 'Tab') trapTab(e);
  });

  /* ---------------- the account ---------------- */

  function openAccount(reason, startMode) {
    if (signedIn()) return openProfileSheet();
    var mode = startMode === 'login' ? 'login' : 'register';
    function draw(root) {
      root.innerHTML =
        '<h2>' + (mode === 'register' ? 'Close the day in a minute — free.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Closing days, importing deposits, the matching, the month and the export are free forever. You also get $2 of AI credit for snapping end-of-day reports — about a cent a photo. One account works across every app on this site.'
          : 'Same account as the other apps on this site.')) + '</p>' +
        '<form id="authForm" style="margin-top:14px">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button>' +
        '</form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="center small muted" style="margin-top:10px">' +
        (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap">Sign in</button>' : 'New here? <button class="link-btn" id="swap">Create an account</button>') +
        '</p>' +
        '<div class="nobank"><span class="e" aria-hidden="true">🔒</span><span>Tally never asks for a bank login. Deposits come from a file you download yourself.</span></div>';
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
    var after = state.after;
    state.after = null;
    closeSheet(true);
    state.books = null;
    return loadMe().then(function () {
      toast('You’re in.');
      var want = after || '#/';
      if (location.hash !== want) location.hash = want; else route();
    });
  }

  function openProfileSheet() {
    var me = state.me;
    var b = me.budget || {};
    var remaining = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(
      '<h2>Your account</h2>' +
      '<p class="muted small">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'Member model (Sonnet)' : 'Free model (Haiku)') + '</p>' +
      '<div class="card" style="margin:14px 0"><div class="row spread"><b>AI credit</b><span class="num">' + remaining + '</span></div>' +
      '<p class="small muted" style="margin-top:8px">Snapping an end-of-day report costs about a cent. Typing the numbers, importing deposits, matching, the month and the export are free.</p>' +
      '<div id="billing" style="margin-top:12px"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" style="margin-top:10px">Sign out</button>',
      function (root) {
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.books = null; drawTop(); location.hash = '#/'; route(); });
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
          '<p class="small muted" style="margin-top:8px">Membership covers every app on this site, runs the better model, and lets you add credit.</p>';
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
      '<p class="muted small" style="margin-top:8px">Everything else keeps working: type the four numbers instead of snapping them, import deposits, and the matching, the month and the export cost nothing.</p><div id="billing" style="margin-top:12px"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- routing ---------------- */

  function tabFor(parts) {
    var p = parts[0] === 'sample' ? parts[1] : parts[0];
    if (p === 'close') return 'close';
    if (p === 'deposits') return 'deposits';
    if (p === 'settings') return 'settings';
    return 'books';
  }

  function route() {
    // A "Books balanced" ping outlives the redraw that follows the change
    // that earned it; it removes itself.
    closeSheet();
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return ''; } });
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tabFor(parts)); });
    window.scrollTo(0, 0);
    if (parts[0] === 'sample') return renderPage('sample', parts.slice(1));
    if (!signedIn()) {
      // Signed out, every page is the sample's: nothing here needs an account
      // to look at, and nothing in the sample is ever saved.
      if (['close', 'deposits', 'settings', 'm'].indexOf(parts[0]) >= 0) { location.replace('#/sample/' + parts.join('/')); return; }
      return renderHome();
    }
    return renderPage('real', parts);
  }
  function renderPage(mode, parts) {
    if (parts[0] === 'close') return renderClose(mode, R.isoDay(parts[1]));
    if (parts[0] === 'deposits') return renderDeposits(mode);
    if (parts[0] === 'settings') return renderSettings(mode);
    return renderBooks(mode, R.isoMonth(parts[0] === 'm' ? parts[1] : null));
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () {
      var t = b.dataset.tab;
      var sample = !signedIn() || /^#\/sample/.test(location.hash);
      var path = { books: '', close: 'close', deposits: 'deposits', settings: 'settings' }[t];
      location.hash = (sample ? '#/sample' : '#') + '/' + path;
    };
  });
  var ready = false;
  window.addEventListener('hashchange', function () { if (ready) route(); });

  function loading() { view.innerHTML = '<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading…</span></div>'; }
  function backLink(to, label) { return '<a class="back" href="' + to + '">' + ICON.back + esc(label) + '</a>'; }
  function sampleBar(page) {
    var items = [['', 'Month'], ['close', 'Close the day'], ['deposits', 'Deposits'], ['settings', 'Fee settings']];
    return '<div class="sample-bar"><span><b>SAMPLE</b> · Copper Kettle Coffee is made up. Real rules, no AI, nothing saved.</span>' +
      (signedIn() ? '<a class="btn small" href="#/">Your books</a>' : '<button class="btn small" data-signup>Start free</button>') + '</div>' +
      '<nav class="subnav" aria-label="Sample">' + items.map(function (x) {
        return '<a href="#/sample' + (x[0] ? '/' + x[0] : '') + '"' + (x[0] === page ? ' class="on" aria-current="page"' : '') + '>' + esc(x[1]) + '</a>';
      }).join('') + '</nav>';
  }
  function wireSignup(root) { $$('[data-signup]', root || view).forEach(function (b) { b.onclick = function () { openAccount(); }; }); }
  function centerSubnav() {
    var nav = $('.subnav'); var on = $('.subnav .on');
    if (!nav || !on) return;
    var n = nav.getBoundingClientRect(); var o = on.getBoundingClientRect();
    nav.scrollLeft += (o.left + o.width / 2) - (n.left + n.width / 2);
  }

  /* ---------------- the calendar ---------------- */

  function defaultMonth(result, today) {
    var m = R.monthOf(today);
    var months = R.monthsOf(result);
    if (!months.length || months.indexOf(m) >= 0) return m;
    return months[0];
  }

  function calendarHTML(mv, opts) {
    opts = opts || {};
    var h = '<div class="cal' + (opts.static ? ' mini' : '') + '" role="grid" aria-label="' + esc(mv.label) + '">';
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d, i) { h += '<div class="wd" aria-hidden="true" title="' + R.WEEKDAYS[i] + '">' + d + '</div>'; });
    for (var i = 0; i < mv.lead; i++) h += '<div aria-hidden="true"></div>';
    mv.cells.forEach(function (c) {
      var cls = 'cell b-' + c.bucket + (c.future ? ' future' : '') + (c.date === opts.today ? ' today' : '') + (state.flash === c.date ? ' fresh' : '');
      var st = c.status ? R.STATUS[c.status] : null;
      var label = R.dayShort(c.date) + ': ' + (st ? st.label + ', ' + R.money(c.charged) + ' card sales and tips' : c.future ? 'not yet' : 'not closed');
      var inner = '<span class="d">' + c.day + '</span>' + (st ? '<span class="k" aria-hidden="true"><b>' + esc(st.icon) + '</b></span><span class="a">' + esc(R.moneyShort(c.charged)) + '</span>' : '');
      if (opts.static || (c.future && !st)) h += '<div class="' + cls + '" aria-label="' + esc(label) + '">' + inner + '</div>';
      else h += '<button type="button" class="' + cls + '" data-date="' + c.date + '" aria-label="' + esc(label) + '">' + inner + '</button>';
    });
    h += '</div>';
    if (!opts.noLegend) {
      h += '<div class="legend" aria-hidden="true"><span><i class="b-green"></i>✓ Matched</span><span><i class="b-amber"></i>! Short</span><span><i class="b-red"></i>× Missing</span><span><i class="b-grey"></i>… Pending</span><span><i class="b-empty"></i>Not closed</span></div>';
    }
    return h;
  }

  function sparkHTML(result) {
    var gs = result.groups.filter(function (g) { return g.status === 'matched' && g.charged > 0; });
    if (gs.length < 2) return '';
    var rates = gs.map(function (g) { return g.actualRate; });
    var plan = gs.reduce(function (a, g) { return a + g.fee; }, 0) / gs.reduce(function (a, g) { return a + g.charged; }, 0);
    var lo = Math.min.apply(null, rates.concat([plan])) - 0.001; var hi = Math.max.apply(null, rates.concat([plan])) + 0.001;
    var W = 300, H = 44;
    var y = function (v) { return (H - 4) - ((v - lo) / (hi - lo)) * (H - 8); };
    var pts = rates.map(function (r, i) { return (i * (W - 4) / (rates.length - 1) + 2).toFixed(1) + ',' + y(r).toFixed(1); }).join(' ');
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Effective fee rate per deposit, rising from ' + esc(R.pct(rates[0])) + ' to ' + esc(R.pct(rates[rates.length - 1])) + '; dashed line is your plan">' +
      '<line class="pl" vector-effect="non-scaling-stroke" x1="2" x2="' + (W - 2) + '" y1="' + y(plan).toFixed(1) + '" y2="' + y(plan).toFixed(1) + '"/><polyline class="ln" vector-effect="non-scaling-stroke" points="' + pts + '"/></svg>';
  }

  /* ---------------- the books (month view) ---------------- */

  function renderBooks(mode, want) {
    loading();
    booksFor(mode).then(function (b) {
      var result = compute(b);
      if (mode === 'real' && !b.days.length) return renderFirstRun(b);
      var m = want || defaultMonth(result, b.today);
      var mv = R.month(result, m);
      var months = R.monthsOf(result);
      var oldest = months.length ? months[months.length - 1] : m;
      var newest = R.monthOf(b.today) > (months[0] || m) ? R.monthOf(b.today) : (months[0] || m);
      var prev = R.addMonths(m, -1); var next = R.addMonths(m, 1);
      var t = mv.totals;
      var s = b.settings;
      var procLabel = R.preset(s.processor).key === 'custom' ? 'Your processor' : R.preset(s.processor).label;
      var planRate = t.feeCharged ? result.rows.filter(function (r) { return r.status === 'matched' && R.monthOf(r.date) === m; }).reduce(function (a, r) { return a + r.fee; }, 0) / t.feeCharged : null;
      var name = mode === 'sample' ? b.business : (s.business || 'Your books');

      var h = mode === 'sample' ? sampleBar('') : '';
      h += '<div class="month-head"><div><h1>' + esc(mv.label) + '</h1><div class="sub">' + esc(name) + ' · ' + esc(procLabel) + ', ' + esc(R.feeText(s)) + ' <span class="faint">(estimate)</span></div></div>' +
        '<div class="mnav">' + (prev >= oldest ? '<a href="' + href(mode, 'm/' + prev) + '" aria-label="Previous month">‹</a>' : '<span aria-hidden="true">‹</span>') +
        (next <= newest ? '<a href="' + href(mode, 'm/' + next) + '" aria-label="Next month">›</a>' : '<span aria-hidden="true">›</span>') + '</div></div>';

      if (mode === 'real' && !b.deposits.length) {
        h += '<div class="banner"><span class="e" aria-hidden="true">🏦</span><div><b>Step 2 of 3: add your deposits</b>Paste or upload the CSV from your bank’s website and Tally will match each day. No bank login, ever.<div style="margin-top:10px"><a class="btn small" href="#/deposits">Add deposits</a></div></div></div>';
      }

      // What needs a look, said first.
      var bad = mv.counts.short + mv.counts.missing;
      if (bad) {
        h += '<div class="banner bad" style="margin-bottom:12px"><span class="e" aria-hidden="true">🔎</span><div><b>' + esc(R.money(t.unaccounted)) + ' unaccounted for</b>' +
          esc([mv.counts.missing ? R.plural(mv.counts.missing, 'missing deposit') : '', mv.counts.short ? R.plural(mv.counts.short, 'short deposit') : ''].filter(Boolean).join(' and ')) + ' this month. <a href="#flags">See why ↓</a></div></div>';
      } else if (mv.counts.matched && !mv.counts.pending) {
        h += '<div class="banner" style="margin-bottom:12px"><span class="e" aria-hidden="true">✅</span><div><b>Every card sale this month got paid.</b>' + esc(R.plural(mv.counts.matched, 'day')) + ' matched to the bank.</div></div>';
      }

      h += '<div class="dk-split dk-split-aside"><div>';
      h += '<div class="card">' + calendarHTML(mv, { today: b.today }) + '</div>';
      h += '</div><div class="stack">';
      h += '<div class="tiles">' +
        '<div class="tile"><div class="k">Card sales</div><b>' + esc(R.money0(t.sales)) + '</b><span>' + esc(R.plural(t.days, 'day')) + ' closed' + (t.tips ? ' · +' + esc(R.money0(t.tips)) + ' tips' : '') + '</span></div>' +
        '<div class="tile"><div class="k">Deposited</div><b>' + esc(R.money0(t.paid)) + '</b><span>' + (t.onTheWay ? esc(R.money0(t.onTheWay)) + ' on the way' : 'nothing pending') + '</span></div>' +
        '<div class="tile' + (mv.creep ? ' bad' : '') + '"><div class="k">Effective fee</div><b>' + esc(t.feeRate == null ? '—' : R.pct(t.feeRate)) + '</b><span>' + (planRate ? 'plan ≈ ' + esc(R.pct(planRate)) : 'once deposits match') + '</span></div>' +
        '<div class="tile ' + (t.unaccounted ? 'bad' : 'good') + '"><div class="k">Unaccounted for</div><b>' + esc(R.money(t.unaccounted)) + '</b><span>' + (t.unaccounted ? 'short + missing' : 'all accounted for') + '</span></div>' +
        '</div>';
      h += '<div class="card streak"><span class="fire" aria-hidden="true">' + (mv.streak.current >= 3 ? '🔥' : '📒') + '</span><div><b>' + esc(R.plural(mv.streak.current, 'day')) + ' in a row reconciled</b><div class="small muted">Best run: ' + esc(R.plural(mv.streak.best, 'day')) + '. Pending days don’t break it.</div></div></div>';
      if (mv.creep) {
        var c = mv.creep;
        h += '<div class="banner warn"><span class="e" aria-hidden="true">📈</span><div class="grow"><b>Fee creep: ' + esc(R.pct(c.fromRate)) + ' → ' + esc(R.pct(c.toRate)) + '</b>Since ' + esc(R.dayShort(c.since)) + ' · about <b style="display:inline">' + esc(R.money0(c.monthlyCents)) + ' a month</b> at your volume.' + sparkHTML(result) +
          '<div class="small" style="margin-top:6px">Every deposit still “matches” — the extra hides inside the allowance, which is how creep goes unnoticed. Ask ' + esc(procLabel === 'Your processor' ? 'your processor' : procLabel) + ' whether your rate changed.</div></div></div>';
      }
      h += '</div></div>';

      if (mv.attention.length) {
        h += '<div class="section-title" id="flags"><h2>Needs a look</h2><span class="count">' + mv.attention.length + '</span></div><ul class="flags">';
        mv.attention.forEach(function (r) {
          var amount = r.status === 'short' ? r.shortfall : r.net;
          h += '<li class="flag ' + r.status + '"><div class="fh"><h3>' + esc(R.dayLong(r.date)) + '</h3>' + statusPill(r.status) + '</div>' +
            '<div class="amt">' + esc(R.money(amount)) + '<small>' + (r.status === 'short' ? 'short' : 'expected, not arrived') + '</small></div>' +
            '<p>' + esc(R.explain(result, r)) + '</p><div class="btn-row">' +
            (r.status === 'missing' && mode === 'sample' && state.demo && state.demo.lateDeposit && r.date === '2026-09-22' && !hasDeposit(b, state.demo.lateDeposit)
              ? '<button class="btn small" data-late>✨ It turned up Friday — add it</button>' : '') +
            (r.status === 'missing' ? '<button class="btn small ghost" data-adddep="' + r.date + '">Add the deposit</button>' : '') +
            '<button class="btn small ghost" data-open="' + r.date + '">Open the day</button></div></li>';
        });
        h += '</ul>';
      }

      if (result.unplaced.length) {
        h += '<div class="section-title"><h2>Deposits we couldn’t place</h2><span class="count">' + result.unplaced.length + '</span></div><div class="list">' +
          result.unplaced.slice(0, 20).map(function (d) {
            return '<div class="drow unplaced"><div style="min-width:0"><div class="t">' + esc(d.description) + '</div><div class="m">' + esc(R.dayShort(d.date)) + ' · no closed day in its window matches this amount — did you close ' + esc(R.dayShort(R.addDays(d.date, -1))) + '?</div></div><div class="n"><b>' + esc(R.money(d.amountCents)) + '</b></div></div>';
          }).join('') + '</div>';
      }

      var rows = result.rows.filter(function (r) { return R.monthOf(r.date) === m; }).reverse();
      if (rows.length) {
        h += '<details class="more" style="margin-top:14px"><summary>Every day in ' + esc(mv.label) + ' (' + rows.length + ')</summary><div class="list">' + rows.map(function (r) {
          return '<button type="button" class="drow" data-open="' + r.date + '"><div style="min-width:0"><div class="t">' + esc(R.dayShort(r.date)) + '</div><div class="m">' +
            esc(R.money(r.grossCents)) + ' sales · expected ' + esc(R.money(Math.max(0, r.net))) + '</div></div><div class="end">' + statusPill(r.status) + '</div></button>';
        }).join('') + '</div></details>';
      }

      h += '<div class="btn-row" style="margin-top:16px"><button class="btn ghost" id="exportBtn">⬇ Export ' + esc(mv.label) + ' (CSV)</button><a class="btn" href="' + href(mode, 'close') + '">＋ Close a day</a></div>';
      h += '<p class="hint" style="margin-top:12px">Fees are estimates from your fee settings. A deposit counts as matched when it’s within ' + esc(R.money(s.tolCents)) + ' or ' + esc(R.bpsText(s.tolBps)) + ' of what we expected, whichever is larger.</p>';

      view.innerHTML = h;
      state.flash = null;
      wireSignup();
      centerSubnav();
      $$('[data-date]', view).forEach(function (el) { el.onclick = function () { openDay(mode, el.dataset.date); }; });
      $$('[data-open]', view).forEach(function (el) { el.onclick = function () { openDay(mode, el.dataset.open); }; });
      $$('[data-adddep]', view).forEach(function (el) { el.onclick = function () { addDepositSheet(mode, R.rowOf(result, el.dataset.adddep)); }; });
      var late = $('[data-late]', view);
      if (late) late.onclick = function () {
        var before = matchedSet(b);
        b.deposits.push(clone(state.demo.lateDeposit));
        celebrate(before, b);
        state.flash = '2026-09-22';
        renderBooks(mode, m);
      };
      $('#exportBtn').onclick = function () { exportMonth(mode, b, m); };
    }).catch(function (e) { showError(e, view); });
  }
  /** "Tue, Sep 22", or a run as "Fri–Sun, Sep 18–20". */
  function daysText(dates) {
    if (dates.length === 1) return R.dayShort(dates[0]);
    var a = dates[0]; var z = dates[dates.length - 1];
    var sameMonth = a.slice(0, 7) === z.slice(0, 7);
    return R.weekday(a).slice(0, 3) + '–' + R.weekday(z).slice(0, 3) + ', ' + R.monthDay(a) + '–' + (sameMonth ? +z.slice(8) : R.monthDay(z));
  }
  function hasDeposit(b, dep) { var k = R.depositKey(dep); return b.deposits.some(function (d) { return R.depositKey(d) === k; }); }

  function exportMonth(mode, b, m) {
    if (mode === 'sample') return download('copper-kettle-' + m + '.csv', R.exportCsv(compute(b), m));
    fetch(BASE + 'api/export?month=' + enc(m) + '&today=' + enc(localDay()), { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Could not export.'); });
      return res.text().then(function (text) { download('tally-' + m + '.csv', text); toast('Exported ' + R.monthLabel(m) + '.'); });
    }).catch(function (e) { showError(e); });
  }

  /** One day, explained: the plain-words reason and the ledger behind it. */
  function openDay(mode, date) {
    booksFor(mode).then(function (b) {
      var result = compute(b);
      var r = R.rowOf(result, date);
      if (!r) {
        if (date > b.today) return;
        location.hash = href(mode, 'close/' + date);
        return;
      }
      var g = R.groupOf(result, r);
      var s = b.settings;
      var settled = r.status === 'matched' || r.status === 'short';
      var diff = settled ? r.paid - r.net : null;
      var html = '<h2>' + esc(R.dayLong(r.date)) + '</h2><div>' + statusPill(r.status) + (r.source === 'snap' ? ' <span class="tag">📸 from a photo</span>' : '') + '</div>' +
        '<p class="explain">' + esc(R.explain(result, r)) + '</p>' +
        '<div class="ledger">' +
        '<div class="l"><span>Card sales</span><b>' + esc(R.money(r.grossCents)) + '</b></div>' +
        (r.tipsCents ? '<div class="l"><span>+ Card tips</span><b>' + esc(R.money(r.tipsCents)) + '</b></div>' : '') +
        (r.refundsCents ? '<div class="l"><span>− Refunds</span><b>' + esc(R.money(r.refundsCents)) + '</b></div>' : '') +
        '<div class="l"><span>− Fees (' + esc(R.feeText(s)) + ' × ' + r.txCount + ', estimate)</span><b>' + esc(R.money(r.fee)) + '</b></div>' +
        '<div class="l total"><span>Should reach the bank</span><b>' + esc(R.money(Math.max(0, r.net))) + '</b></div>' +
        (settled ? '<div class="l"><span>Deposited ' + esc(R.dayShort(g.paidOn)) + (g.dates.length > 1 ? ' (this day’s share of ' + esc(R.money(g.paid)) + ')' : '') + '</span><b>' + esc(R.money(r.paid)) + '</b></div>' +
          '<div class="l diff' + (r.status === 'matched' ? ' ok' : '') + '"><span>Difference</span><b>' + esc(diff === 0 ? '$0.00' : (diff > 0 ? '+' : '') + R.money(diff)) + '</b></div>'
          : '<div class="l"><span>' + (r.status === 'none' ? 'Nothing due' : 'Due by ' + esc(R.dayShort(r.due))) + '</span><b>' + (r.status === 'none' ? '—' : 'Nothing yet') + '</b></div>') +
        '</div>' +
        '<div class="btn-row" style="margin-top:14px">' +
        (r.status === 'missing' ? '<button class="btn" id="dAdd">Add the deposit</button>' : '') +
        '<a class="btn ghost" href="' + href(mode, 'close/' + r.date) + '">Edit this day</a>' +
        '<button class="btn danger" id="dDel">Delete</button></div>';
      sheet(html, function (root) {
        var add = $('#dAdd', root);
        if (add) add.onclick = function () { addDepositSheet(mode, r); };
        $('#dDel', root).onclick = function () {
          if (!confirm('Delete ' + R.dayShort(r.date) + '? Its deposit (if any) stays, unmatched.')) return;
          if (mode === 'sample') {
            b.days = b.days.filter(function (d) { return d.date !== r.date; });
            closeSheet(); toast('Deleted (only in this sample).'); route(); return;
          }
          api('DELETE', 'api/days/' + r.date).then(function () { closeSheet(); toast('Deleted ' + R.dayShort(r.date) + '.'); route(); }).catch(function (e) { showError(e); });
        };
      });
    });
  }

  /** A deposit typed by hand - prefilled with what a missing day expects. */
  function addDepositSheet(mode, row) {
    var today = mode === 'sample' ? state.sample.today : localDay();
    var date = row && row.due <= today ? row.due : today;
    sheet('<h2>Add a deposit</h2><p class="muted small">What your bank shows. ' + (row ? 'We filled in what ' + esc(R.dayShort(row.date)) + ' should have brought — change it to the real amount.' : '') + '</p>' +
      '<form id="depF" style="margin-top:12px">' + depositFields(date, row ? R.plain(row.net) : '', '') +
      '<div id="depErr"></div><button class="btn block">Add deposit</button></form>',
      function (root) {
        $('#depF', root).onsubmit = function (e) {
          e.preventDefault();
          var f = e.target;
          addDeposits(mode, [{ date: f.date.value, amount: f.amount.value, description: f.description.value }], $('#depErr', root)).then(function (ok) { if (ok) { closeSheet(); route(); } });
        };
      });
  }
  function depositFields(date, amount, description) {
    return '<div class="grid2"><label class="field"><span>Date it reached the bank</span><input class="input" type="date" name="date" required value="' + esc(date) + '"></label>' +
      '<label class="field"><span>Amount</span><span class="money-in"><b>$</b><input class="input" name="amount" inputmode="decimal" autocomplete="off" required placeholder="1,248.87" value="' + esc(amount) + '"></span></label></div>' +
      '<label class="field"><span>Description <span class="faint">(optional)</span></span><input class="input" name="description" maxlength="120" placeholder="Card deposit" value="' + esc(description) + '"></label>';
  }
  /** Add deposits in either world; resolves true when added. */
  function addDeposits(mode, list, errEl) {
    if (mode === 'sample') {
      var b = state.sample;
      var before = matchedSet(b);
      for (var i = 0; i < list.length; i++) {
        var r = R.validateDeposit(list[i], b.today);
        if (r.error) { showError({ message: r.error }, errEl); return Promise.resolve(false); }
        r.deposit.id = 'local' + Date.now() + i;
        b.deposits.push(r.deposit);
      }
      if (!celebrate(before, b)) toast('Added (only in this sample).');
      return Promise.resolve(true);
    }
    var prior = state.books ? matchedSet(state.books) : {};
    return api('POST', 'api/deposits', list.length === 1 ? list[0] : { deposits: list }).then(function (out) {
      return loadBooks().then(function (b) {
        if (!celebrate(prior, b)) toast(out.added.length ? 'Added ' + R.plural(out.added.length, 'deposit') + (out.skipped ? ' (' + out.skipped + ' already here)' : '') + '.' : 'Those were already in Tally.');
        return true;
      });
    }).catch(function (e) { showError(e, errEl); return false; });
  }

  /* ---------------- first run ---------------- */

  function procGrid(current) {
    return '<div class="procs">' + R.PRESETS.map(function (p) {
      return '<button type="button" class="proc' + (p.key === current ? ' on' : '') + '" data-proc="' + p.key + '" aria-pressed="' + (p.key === current) + '"><b>' + esc(p.key === 'custom' ? 'Other' : p.label) + '</b><span>' +
        (p.key === 'custom' ? 'your rate' : esc(R.feeText(p))) + '</span></button>';
    }).join('') + '</div>';
  }

  function renderFirstRun(b) {
    var me = state.me || {};
    var hasDeps = b.deposits.length > 0;
    var p = R.preset(b.settings.processor);
    var h = '<div class="page-head"><div><h1>Welcome' + (me.name ? ', ' + esc(me.name) : '') + '</h1><div class="sub">Three steps, and you’ll know every card sale got paid.</div></div></div>' +
      '<div class="card firstrun"><h2>Who runs your card terminal?</h2><p class="small muted" style="margin:4px 0 12px">We’ll use their typical rate to estimate fees — an estimate you can change any time in Settings.</p>' +
      procGrid(b.settings.configured ? b.settings.processor : null) +
      '<div id="procNote" class="hint">' + (b.settings.configured ? esc(p.label) + ': ' + esc(R.feeText(b.settings)) + ', ' + esc(R.windowText(b.settings.windowDays)) + '. ' + esc(p.note) + '.' : '') + '</div>' +
      '<ol class="todo">' +
      '<li class="next"><span class="n">1</span><div><h3>Close today</h3><p>Four numbers from your terminal’s end-of-day report: card sales, refunds, tips and the number of transactions. Or snap a photo of it.</p><a class="btn small" href="#/close">Close today</a></div></li>' +
      '<li class="' + (hasDeps ? 'done' : '') + '"><span class="n">2</span><div><h3>Add your deposits</h3><p>' + (hasDeps ? esc(R.plural(b.deposits.length, 'deposit')) + ' in. ' : '') + 'Download the CSV from your bank’s website and drop it in. We pick out Square, Stripe, Clover, Toast and the rest.</p>' + (hasDeps ? '' : '<a class="btn small ghost" href="#/deposits">Add deposits</a>') + '</div></li>' +
      '<li class="later"><span class="n">3</span><div><h3>See what’s missing</h3><p>Every day comes back ✓ matched, ! short, … pending or × missing — with the reason in plain words.</p></div></li>' +
      '</ol></div>' +
      '<a class="banner" href="#/sample" style="margin-top:12px;text-decoration:none;color:inherit"><span class="e" aria-hidden="true">☕</span><div><b>Want to see it working first?</b>Open a sample café’s September: a short deposit, a missing batch and fee creep, all caught. Nothing is saved. <span style="color:var(--accent);font-weight:700">Open the sample →</span></div></a>' +
      '<div class="nobank"><span class="e" aria-hidden="true">🔒</span><span>No bank connection and no bank login, ever. Deposits come from a file you download yourself, and the file isn’t kept.</span></div>';
    view.innerHTML = h;
    $$('[data-proc]', view).forEach(function (btn) {
      btn.onclick = function () {
        var pr = R.preset(btn.dataset.proc);
        $$('[data-proc]', view).forEach(function (x) { x.classList.toggle('on', x === btn); x.setAttribute('aria-pressed', String(x === btn)); });
        api('PUT', 'api/settings', { processor: pr.key, feePct: R.bpsText(pr.feeBps).replace('%', ''), feeFixed: R.plain(pr.feeFixedCents), windowDays: pr.windowDays }).then(function (out) {
          b.settings = out.settings;
          $('#procNote').textContent = pr.label + ': ' + R.feeText(out.settings) + ', ' + R.windowText(out.settings.windowDays) + '. ' + pr.note + '.';
          toast('Saved: ' + pr.label + '.');
        }).catch(function (e) { showError(e); });
      };
    });
  }

  /* ---------------- close the day ---------------- */

  function renderClose(mode, date) {
    loading();
    booksFor(mode).then(function (b) {
      var today = b.today;
      var existing = null;
      var pick = date && date <= R.addDays(today, 1) ? date : null;
      if (!pick) {
        // The next day that needs closing: today unless it's done, then the
        // most recent unclosed day this week, else today again.
        pick = today;
        if (b.days.some(function (d) { return d.date === today; })) {
          for (var i = 1; i < 7; i++) { var d0 = R.addDays(today, -i); if (!b.days.some(function (d) { return d.date === d0; })) { pick = d0; break; } }
        }
      }
      var h = (mode === 'sample' ? sampleBar('close') : '') +
        '<div class="page-head"><div><h1>Close the day</h1><div class="sub">Four numbers from the terminal’s end-of-day report — the Z-report or batch report.</div></div></div>' +
        '<div class="dk-split dk-split-aside"><div>' +
        '<label class="snap" id="snapBtn"><span class="ic" aria-hidden="true">📸</span><span class="grow"><b>Snap the report</b><span>We read the numbers once and you check them. About 1¢ of AI credit; the photo isn’t kept.</span></span>' +
        (mode === 'real' ? '<input type="file" accept="image/*" capture="environment" id="snapFile">' : '') + '</label>' +
        '<div id="snapOut"></div>' +
        '<div class="or">or type them</div>' +
        '<form class="card" id="closeF" novalidate>' +
        '<label class="field"><span>Which day?</span><input class="input" type="date" name="date" required max="' + esc(R.addDays(today, 1)) + '" value="' + esc(pick) + '">' +
        '<span class="quickdates"><button type="button" class="chip" data-q="0">Today</button><button type="button" class="chip" data-q="1">Yesterday</button></span></label>' +
        '<div id="exists"></div>' +
        '<div class="grid2">' +
        '<label class="field"><span>Card sales</span><span class="money-in" data-f="gross"><b>$</b><input class="input" name="gross" inputmode="decimal" autocomplete="off" placeholder="1,284.50"></span><small>Before refunds, card only.</small></label>' +
        '<label class="field"><span>Card transactions</span><span class="money-in" data-f="tx"><b>#</b><input class="input" name="tx" inputmode="numeric" autocomplete="off" placeholder="96"></span><small>The count on the report.</small></label>' +
        '<label class="field"><span>Refunds</span><span class="money-in" data-f="refunds"><b>$</b><input class="input" name="refunds" inputmode="decimal" autocomplete="off" placeholder="0.00"></span><small>Card refunds and voids.</small></label>' +
        '<label class="field"><span>Card tips <span class="faint">(optional)</span></span><span class="money-in" data-f="tips"><b>$</b><input class="input" name="tips" inputmode="decimal" autocomplete="off" placeholder="0.00"></span><small>Only if not already in card sales.</small></label>' +
        '</div></form>' +
        '</div><div class="dk-sticky"><div class="expect" id="expect" aria-live="polite"></div>' +
        '<div id="closeErr"></div><button class="btn block lg" id="closeBtn" type="submit" form="closeF" style="margin-top:12px">Close the day</button>' +
        '<p class="hint" style="margin-top:10px">Fees use your settings: ' + esc(R.feeText(b.settings)) + ' per transaction, paid ' + esc(R.windowText(b.settings.windowDays)) + '. <a href="' + href(mode, 'settings') + '">Change</a></p></div></div>';
      view.innerHTML = h;
      wireSignup();
      centerSubnav();
      var f = $('#closeF');

      function fill(d) {
        f.gross.value = d ? R.plain(d.grossCents) : '';
        f.refunds.value = d && d.refundsCents ? R.plain(d.refundsCents) : '';
        f.tips.value = d && d.tipsCents ? R.plain(d.tipsCents) : '';
        f.tx.value = d && d.txCount ? String(d.txCount) : '';
      }
      function onDate(initial) {
        var d = R.isoDay(f.date.value);
        existing = d ? b.days.filter(function (x) { return x.date === d; })[0] || null : null;
        $('#exists').innerHTML = existing ? '<div class="banner" style="margin-bottom:14px"><span class="e" aria-hidden="true">📝</span><div><b>' + esc(R.dayShort(d)) + ' is already closed.</b>Saving replaces its numbers.</div></div>' : '';
        if (existing) fill(existing); else if (!initial) fill(null);
        if (mode === 'sample' && !existing && initial && d === b.today) {
          // A believable Saturday, typed for the visitor, so the preview has
          // something to say the moment the page opens.
          f.gross.value = '1,876.35'; f.tips.value = '171.40'; f.refunds.value = ''; f.tx.value = '142';
        }
        $$('[data-q]').forEach(function (c) { c.classList.toggle('on', R.addDays(today, -Number(c.dataset.q)) === d); });
        update();
      }
      function update() {
        var d = R.isoDay(f.date.value);
        var gross = R.toCents(f.gross.value || '0'); var refunds = R.toCents(f.refunds.value || '0'); var tips = R.toCents(f.tips.value || '0');
        var tx = Number(String(f.tx.value || '0').replace(/,/g, ''));
        $('#closeBtn').textContent = d ? (existing ? 'Save ' + R.dayShort(d) : 'Close ' + R.dayLong(d)) : 'Close the day';
        var box = $('#expect');
        if (!d || gross === null || refunds === null || tips === null || !Number.isInteger(tx) || !gross) {
          box.innerHTML = '<div class="eyebrow">Should reach your bank</div><div class="big faint">$—</div><p class="small muted" style="margin-top:6px">Type the day’s card sales and we’ll work out what your processor should deposit, and by when.</p>';
          return;
        }
        var e = R.expected({ grossCents: gross, refundsCents: refunds, tipsCents: tips, txCount: tx }, b.settings);
        var due = R.dueBy(d, b.settings);
        var hol = R.holidaysBetween(d, due);
        box.innerHTML = '<div class="eyebrow">Should reach your bank</div><div class="big">' + esc(R.money(Math.max(0, e.net))) + '</div>' +
          '<div class="l"><span>Card sales' + (tips ? ' + tips' : '') + '</span><b>' + esc(R.money(e.charged)) + '</b></div>' +
          (refunds ? '<div class="l"><span>− Refunds</span><b>' + esc(R.money(refunds)) + '</b></div>' : '') +
          '<div class="l"><span>− Fees ≈ ' + esc(R.feeText(b.settings)) + (tx ? ' × ' + tx : '') + '</span><b>' + esc(R.money(e.fee)) + '</b></div>' +
          '<div class="when">By <b>' + esc(R.dayLong(due)) + '</b> — ' + esc(R.windowText(b.settings.windowDays)) + (hol.length ? ' (' + esc(hol.map(function (x) { return x.name; }).join(', ')) + ' pushes it back)' : '') + '. Weekends and bank holidays roll forward.</div>' +
          (e.charged && !tx ? '<p class="small warn" style="margin-top:6px">Add the transaction count — the ' + esc(R.money(b.settings.feeFixedCents)) + ' per-transaction fee is most of a small ticket’s cost.</p>' : '');
      }
      f.date.onchange = function () { onDate(false); };
      ['gross', 'refunds', 'tips', 'tx'].forEach(function (k) { f[k].oninput = function () { f[k].removeAttribute('aria-invalid'); $('[data-f=' + k + ']').classList.remove('filled'); update(); }; });
      $$('[data-q]').forEach(function (c) { c.onclick = function () { f.date.value = R.addDays(today, -Number(c.dataset.q)); onDate(false); }; });
      onDate(true);

      f.onsubmit = function (e) {
        e.preventDefault();
        var body = { date: f.date.value, gross: f.gross.value, refunds: f.refunds.value, tips: f.tips.value, tx: f.tx.value, source: f.dataset.source || 'typed' };
        var err = $('#closeErr');
        err.innerHTML = '';
        $$('[aria-invalid]', f).forEach(function (x) { x.removeAttribute('aria-invalid'); });
        function bad(msg, field) {
          err.innerHTML = '<div class="err" role="alert" id="closeErrMsg">' + esc(msg) + '</div>';
          var el = field && f[field];
          if (el) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', 'closeErrMsg'); el.focus(); }
        }
        var v = R.validateDay(body, today);
        if (v.error) return bad(v.error, v.field);
        var btn = $('#closeBtn'); btn.disabled = true;
        if (mode === 'sample') {
          var before = matchedSet(b);
          b.days = b.days.filter(function (x) { return x.date !== v.day.date; }).concat([v.day]);
          afterClose(mode, b, v.day, before);
          return;
        }
        var prior = state.books ? matchedSet(state.books) : {};
        api('PUT', 'api/days/' + v.day.date, body).then(function () {
          return loadBooks().then(function (nb) { afterClose(mode, nb, v.day, prior); });
        }).catch(function (e2) { btn.disabled = false; if (e2.status === 402 || e2.status === 401) return showError(e2); bad(e2.message, e2.field); });
      };

      var snapBtn = $('#snapBtn');
      if (mode === 'sample') {
        snapBtn.onclick = function (e) { e.preventDefault(); openAccount('Snapping reads the report with AI — about a cent a photo, from the $2 of credit every free account gets. Typing the numbers is free forever.'); };
      } else {
        $('#snapFile').onchange = function (e) {
          var file = e.target.files && e.target.files[0];
          e.target.value = '';
          if (!file) return;
          var out = $('#snapOut');
          snapBtn.querySelector('b').innerHTML = '<span class="spinner" aria-hidden="true" style="width:16px;height:16px;border-width:2px"></span> Reading your report…';
          shrink(file).then(function (img) { return api('POST', 'api/days/snap', { image: img }); }).then(function (r) {
            snapBtn.querySelector('b').textContent = 'Snap another report';
            var p = r.proposal;
            if (p.date) f.date.value = p.date;
            onDate(false);
            ['gross', 'refunds', 'tips', 'tx'].forEach(function (k) { f[k].value = p[k] || ''; $('[data-f=' + k + ']').classList.toggle('filled', r.filled.indexOf(k) >= 0); });
            f.dataset.source = 'snap';
            update();
            out.innerHTML = '<div class="banner' + (r.confidence === 'high' && !r.dropped.length ? '' : ' warn') + '" style="margin-top:12px"><span class="e" aria-hidden="true">🔍</span><div><b>Read from your photo — check each number against the slip.</b>' +
              'Filled: ' + esc(r.filled.map(function (k) { return { date: 'date', gross: 'card sales', refunds: 'refunds', tips: 'tips', tx: 'transactions' }[k]; }).join(', ')) + '.' +
              (r.dropped.length ? ' We couldn’t trust ' + esc(r.dropped.join(', ')) + ' — type ' + (r.dropped.length > 1 ? 'those' : 'it') + ' in.' : '') +
              (r.notes ? ' <i>“' + esc(r.notes) + '”</i>' : '') + ' Nothing is saved until you press Close. The photo was not kept.</div></div>';
            loadMe();
          }).catch(function (e3) {
            snapBtn.querySelector('b').textContent = 'Snap the report';
            showError(e3, out);
          });
        };
      }
    }).catch(function (e) { showError(e, view); });
  }

  function afterClose(mode, b, day, before) {
    var result = compute(b);
    var r = R.rowOf(result, day.date);
    var balanced = celebrate(before, b);
    state.flash = day.date;
    var h = (mode === 'sample' ? sampleBar('close') : '') + '<div class="card done-card">';
    if (balanced || r.status === 'matched') {
      h += '<div class="e" aria-hidden="true">🎉</div><span class="balanced">✓ Books balanced</span><h2>' + esc(R.dayLong(day.date)) + ' is paid.</h2><p>' + esc(R.explain(result, r)) + '</p>';
    } else if (r.status === 'none') {
      h += '<div class="e" aria-hidden="true">📒</div><h2>' + esc(R.dayLong(day.date)) + ' is closed.</h2><p>' + esc(R.explain(result, r)) + '</p>';
    } else {
      h += '<div class="e" aria-hidden="true">📒</div><h2>' + esc(R.dayLong(day.date)) + ' is closed.</h2><p><b>' + esc(R.money(r.net)) + '</b> should reach your bank by <b>' + esc(R.dayLong(r.due)) + '</b>. ' +
        (r.status === 'short' ? esc(R.explain(result, r)) : r.status === 'missing' ? 'That date has passed — add your deposits and Tally will look for it.' : 'Add your deposits when the bank shows them and Tally will match them.') + '</p>';
    }
    h += '<div class="btn-row" style="max-width:440px;margin:0 auto"><a class="btn" href="' + href(mode, '') + '">See the month</a>' +
      (r.status === 'matched' ? '<a class="btn ghost" href="' + href(mode, 'close') + '">Close another day</a>' : '<a class="btn ghost" href="' + href(mode, 'deposits') + '">Add deposits</a>') + '</div></div>';
    view.innerHTML = h;
    wireSignup();
    if (!balanced) toast(mode === 'sample' ? 'Closed (only in this sample).' : 'Closed ' + R.dayShort(day.date) + '.');
  }

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

  /* ---------------- deposits ---------------- */

  function renderDeposits(mode) {
    loading();
    booksFor(mode).then(function (b) {
      var result = compute(b);
      var placed = {};
      result.groups.forEach(function (g) { g.deposits.forEach(function (d) { placed[d.id + '|' + d.date + '|' + d.amountCents] = g; }); });
      var h = (mode === 'sample' ? sampleBar('deposits') : '') +
        '<div class="page-head"><div><h1>Deposits</h1><div class="sub">What actually reached your bank.</div></div></div>' +
        '<div class="dk-split"><div>' +
        '<div class="card"><h2>Import from your bank</h2><p class="small muted" style="margin:4px 0 12px">On your bank’s website: Activity → Download → CSV. Drop the file here and tick the card deposits — we pre-tick Square, Stripe, Clover, Toast and the rest.</p>' +
        '<label class="drop" id="drop"><span class="ic" aria-hidden="true">📄</span><span class="grow"><b>Choose your bank’s CSV</b><span>or drop it here · up to 2 MB</span></span><input type="file" id="csvFile" accept=".csv,text/csv,text/plain"></label>' +
        '<details class="more" id="pasteBox"><summary>Or paste the text</summary><textarea class="input" id="csvText" rows="5" placeholder="Date,Description,Amount&#10;09/15/2026,SQUARE INC SQ260915,1248.87"></textarea><button class="btn small ghost" id="csvRead" style="margin-top:8px">Read it</button></details>' +
        '<div id="csvErr"></div><div class="preview" id="preview"></div>' +
        '<div class="nobank"><span class="e" aria-hidden="true">🔒</span><span>No bank connection, no bank login. The file is read once and not kept; only the lines you tick are saved.</span></div></div>' +
        '<div class="card"><details class="more"><summary>Type one in instead</summary><form id="oneF" style="margin-top:6px">' + depositFields(b.today, '', '') + '<div id="oneErr"></div><button class="btn block">Add deposit</button></form></details></div>' +
        '</div><div>';
      var deps = b.deposits.slice().sort(function (x, y) { return x.date < y.date ? 1 : x.date > y.date ? -1 : 0; });
      h += '<div class="section-title" style="margin-top:4px"><h2>' + (mode === 'sample' ? 'Copper Kettle’s deposits' : 'Your deposits') + '</h2><span class="count">' + deps.length + (mode === 'real' && deps.length > b.limits.deposits * 0.8 ? ' of ' + b.limits.deposits.toLocaleString('en-US') + ' max' : '') + '</span></div>';
      if (!deps.length) {
        h += '<div class="empty boxed"><div class="e">🏦</div><h2>No deposits yet</h2><p>Import your bank’s CSV and each day’s card sales get matched to what actually arrived.</p></div>';
      } else {
        h += '<div class="list">' + deps.slice(0, 200).map(function (d) {
          var g = placed[String(d.id || '') + '|' + d.date + '|' + d.amountCents];
          var p = R.processorOf(d.description, b.settings.keywords);
          return '<div class="drow' + (g ? '' : ' unplaced') + '"><div style="min-width:0"><div class="t" title="' + esc(d.description) + '">' + esc(R.dayShort(d.date)) + ' · ' + esc(p ? p.label : d.description) + '</div><div class="m">' +
            (g ? 'For sales on ' + esc(daysText(g.dates)) + (g.status === 'short' ? ' · came up short' : '') : 'Not matched to a day yet') + '</div></div>' +
            '<div class="end"><div class="n"><b>' + esc(R.money(d.amountCents)) + '</b></div><button class="icon-btn" data-del="' + esc(d.id) + '" aria-label="Delete deposit of ' + esc(R.money(d.amountCents)) + ' on ' + esc(R.dayShort(d.date)) + '">×</button></div></div>';
        }).join('') + '</div>' + (deps.length > 200 ? '<p class="hint">Showing the newest 200.</p>' : '');
      }
      h += '</div></div>';
      view.innerHTML = h;
      wireSignup();
      centerSubnav();

      function readCsv(text) {
        var err = $('#csvErr'); err.innerHTML = '';
        var pv = $('#preview');
        pv.innerHTML = '<div class="loading" style="padding:20px 0"><span class="spinner"></span></div>';
        var work = mode === 'sample'
          ? Promise.resolve().then(function () {
            var r = R.parseBankCsv(text, b.settings.keywords);
            if (r.error) { var e = new Error(r.error); throw e; }
            var keys = {}; b.deposits.forEach(function (d) { keys[R.depositKey(d)] = 1; });
            r.rows.forEach(function (x) { x.have = Boolean(keys[x.key]); });
            return r;
          })
          : api('POST', 'api/deposits/csv', { csv: text });
        work.then(function (r) { drawPreview(r); }).catch(function (e) { pv.innerHTML = ''; showError(e, err); });
      }
      function drawPreview(r) {
        var cards = r.rows.filter(function (x) { return x.processor && !x.have; });
        var have = r.rows.filter(function (x) { return x.have; });
        var other = r.rows.filter(function (x) { return !x.processor && !x.have; });
        function line(x, i, on) {
          return '<li><label class="' + (x.have ? 'have' : '') + '"><input type="checkbox" data-i="' + i + '"' + (on ? ' checked' : '') + (x.have ? ' disabled' : '') + '>' +
            '<span style="min-width:0"><span class="t" style="display:block">' + esc(x.description) + '</span><span class="m">' + esc(R.dayShort(x.date)) + (x.processor ? ' · ' + esc(x.processor) : '') + (x.have ? ' · already in Tally' : '') + '</span></span>' +
            '<span class="n">' + esc(R.money(x.amountCents)) + '</span></label></li>';
        }
        var idx = function (x) { return r.rows.indexOf(x); };
        var sk = r.skipped || {};
        var h2 = (mode === 'sample' ? '<p class="hint" style="margin:0 0 8px">Read from Copper Kettle’s own (made-up) bank export for September:</p>' : '') + '<p class="sum"><b>' + esc(R.plural(cards.length, 'new card deposit')) + '</b>' +
          (have.length ? ' · ' + esc(R.plural(have.length, 'already in Tally', 'already in Tally')) : '') +
          (other.length ? ' · ' + esc(R.plural(other.length, 'other deposit')) + ' left out' : '') +
          (sk.outflows ? ' · ' + esc(R.plural(sk.outflows, 'payment out', 'payments out')) + ' skipped' : '') + '.</p>';
        if (cards.length) h2 += '<ul class="checks">' + cards.map(function (x) { return line(x, idx(x), true); }).join('') + '</ul>';
        if (have.length) h2 += '<details class="more"><summary>Already in Tally (' + have.length + ')</summary><ul class="checks">' + have.map(function (x) { return line(x, idx(x), false); }).join('') + '</ul></details>';
        if (other.length) h2 += '<details class="more"' + (cards.length ? '' : ' open') + '><summary>Other money in — cash, transfers (' + other.length + ')</summary><p class="hint" style="margin-bottom:8px">Not from a card processor, so unticked. Tick one if it is — or add its word in Settings.</p><ul class="checks">' + other.map(function (x) { return line(x, idx(x), false); }).join('') + '</ul></details>';
        h2 += '<div id="addErr"></div><button class="btn block" id="addPicked" style="margin-top:12px"></button>';
        var pv = $('#preview');
        pv.innerHTML = h2;
        function count() {
          var n = $$('input[data-i]:checked', pv).length;
          var btn = $('#addPicked', pv);
          btn.disabled = !n;
          btn.textContent = mode === 'sample' && !signedIn() ? (n ? 'Add ' + R.plural(n, 'deposit') + ' to the sample' : 'Nothing new to add — tick one') : (n ? 'Add ' + R.plural(n, 'deposit') : 'Nothing new to add');
        }
        $$('input[data-i]', pv).forEach(function (c) { c.onchange = count; });
        count();
        $('#addPicked', pv).onclick = function () {
          var list = $$('input[data-i]:checked', pv).map(function (c) { var x = r.rows[Number(c.dataset.i)]; return { date: x.date, amount: R.plain(x.amountCents), description: x.description, source: 'csv' }; });
          var btn = this; btn.disabled = true;
          addDeposits(mode, list, $('#addErr', pv)).then(function (ok) { if (ok) route(); else btn.disabled = false; });
        };
      }
      $('#csvFile').onchange = function (e) {
        var file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) return showError({ message: 'That file is over 2 MB. Download a shorter date range - a month or two.' }, $('#csvErr'));
        var fr = new FileReader();
        fr.onload = function () { readCsv(String(fr.result || '')); };
        fr.readAsText(file);
      };
      var drop = $('#drop');
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) {
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        var fr = new FileReader(); fr.onload = function () { readCsv(String(fr.result || '')); }; fr.readAsText(file);
      });
      $('#csvRead').onclick = function (e) { e.preventDefault(); readCsv($('#csvText').value); };
      $('#oneF').onsubmit = function (e) {
        e.preventDefault();
        var f = e.target;
        addDeposits(mode, [{ date: f.date.value, amount: f.amount.value, description: f.description.value }], $('#oneErr')).then(function (ok) { if (ok) route(); });
      };
      $$('[data-del]', view).forEach(function (btn) {
        btn.onclick = function () {
          var id = btn.dataset.del;
          if (mode === 'sample') { b.deposits = b.deposits.filter(function (d) { return d.id !== id; }); toast('Deleted (only in this sample).'); route(); return; }
          api('DELETE', 'api/deposits/' + enc(id)).then(function () { toast('Deposit deleted.'); route(); }).catch(function (e) { showError(e); });
        };
      });
      if (mode === 'sample') {
        // The sample's own bank export, read the moment the page opens, so
        // a visitor sees the filter work without finding a file.
        $('#csvText').value = state.demo.csv;
        readCsv(state.demo.csv);
      }
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- settings ---------------- */

  function renderSettings(mode) {
    loading();
    booksFor(mode).then(function (b) {
      var s = b.settings;
      var kws = s.keywords.slice();
      var h = (mode === 'sample' ? sampleBar('settings') : '') +
        '<div class="page-head"><div><h1>' + (mode === 'sample' ? 'Fee settings' : 'Settings') + '</h1><div class="sub">Your fee model, and how Tally spots a card deposit.' + (mode === 'sample' ? ' Changes here only affect this sample — try a 2-day window and watch the month.' : '') + '</div></div></div>' +
        '<form id="setF" novalidate><div class="dk-split"><div>' +
        (mode === 'real' ? '<div class="card"><label class="field" style="margin:0"><span>Business name</span><input class="input" name="business" maxlength="60" placeholder="Copper Kettle Coffee" value="' + esc(s.business) + '"></label></div>' : '') +
        '<div class="card"><h2>Your card processor</h2><p class="small muted" style="margin:4px 0 12px">Typical published in-person rates as we understand them — <b>estimates</b>. Your monthly statement is the truth: type its numbers below.</p>' + procGrid(s.processor) + '</div>' +
        '<div class="card"><h2>Fee model</h2><p class="small muted" style="margin:4px 0 12px">Fee per day = the percentage of card sales and tips, plus the per-transaction fee.</p><div class="grid2">' +
        '<label class="field"><span>Percentage</span><span class="money-in pct"><b>%</b><input class="input" name="feePct" inputmode="decimal" value="' + esc(R.bpsText(s.feeBps).replace('%', '')) + '"></span></label>' +
        '<label class="field"><span>Per transaction</span><span class="money-in"><b>$</b><input class="input" name="feeFixed" inputmode="decimal" value="' + esc(R.plain(s.feeFixedCents)) + '"></span></label></div>' +
        '<div class="field"><span id="winLbl" style="display:block;font-size:13.5px;font-weight:700;color:var(--muted);margin-bottom:6px">Deposits arrive within</span><div class="seg" role="group" aria-labelledby="winLbl">' +
        [1, 2, 3].map(function (n) { return '<button type="button" data-win="' + n + '" aria-pressed="' + (s.windowDays === n) + '"' + (s.windowDays === n ? ' class="on"' : '') + '>' + n + ' business day' + (n > 1 ? 's' : '') + '</button>'; }).join('') +
        '</div><small style="display:block;font-size:13px;color:var(--faint);margin-top:5px">Weekends and US bank holidays roll forward. A deposit up to 5 business days late still matches, marked late.</small></div>' +
        '</div></div><div>' +
        '<div class="card"><h2>When is a deposit short?</h2><p class="small muted" style="margin:4px 0 12px">Processors round per transaction, so a deposit a little under the estimate still matches. More than this is flagged short.</p><div class="grid2">' +
        '<label class="field"><span>Allow up to</span><span class="money-in"><b>$</b><input class="input" name="tol" inputmode="decimal" value="' + esc(R.plain(s.tolCents)) + '"></span></label>' +
        '<label class="field"><span>or, if larger</span><span class="money-in pct"><b>%</b><input class="input" name="tolPct" inputmode="decimal" value="' + esc(R.bpsText(s.tolBps).replace('%', '')) + '"></span></label></div></div>' +
        '<div class="card"><h2>What counts as a card deposit</h2><p class="small muted" style="margin:4px 0 12px">A bank line is pre-ticked on import when its description contains one of these.</p><div class="kw" id="kw"></div>' +
        '<div class="row" style="margin-top:10px"><input class="input grow" id="kwNew" maxlength="30" placeholder="e.g. MRCH SVC" aria-label="Add a keyword"><button type="button" class="btn small ghost" id="kwAdd">Add</button></div></div>' +
        '</div></div><div id="setErr"></div><button class="btn block lg" style="margin-top:14px">' + (mode === 'sample' ? 'Apply to the sample' : 'Save settings') + '</button></form>';
      if (mode === 'real') {
        h += '<div class="card" style="margin-top:16px"><h2>Your data</h2><div class="nobank" style="margin-top:6px"><span class="e" aria-hidden="true">🔒</span><span>No bank connection and no bank login, ever. Photos of reports are read once and not kept. Your days and deposits are yours: export any month from the Books tab.</span></div>' +
          '<details class="more" style="margin-top:6px"><summary>Delete everything</summary><p class="small muted">Every closed day, every deposit and these settings. This can’t be undone. Type DELETE to confirm.</p><div class="row" style="margin-top:8px"><input class="input grow" id="delConfirm" aria-label="Type DELETE to confirm" autocomplete="off"><button type="button" class="btn danger" id="delAll">Delete</button></div><div id="delErr"></div></details></div>';
      }
      view.innerHTML = h;
      wireSignup();
      centerSubnav();
      var f = $('#setF');
      var win = s.windowDays;
      var proc = s.processor;
      function drawKw() {
        $('#kw').innerHTML = kws.map(function (k, i) { return '<span>' + esc(k) + '<button type="button" data-kw="' + i + '" aria-label="Remove ' + esc(k) + '">×</button></span>'; }).join('');
        $$('[data-kw]').forEach(function (x) { x.onclick = function () { kws.splice(Number(x.dataset.kw), 1); drawKw(); }; });
      }
      drawKw();
      $('#kwAdd').onclick = function () {
        var v = R.clean($('#kwNew').value, 30).toUpperCase();
        if (v.length >= 2 && kws.indexOf(v) < 0) kws.push(v);
        $('#kwNew').value = ''; drawKw();
      };
      $('#kwNew').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); $('#kwAdd').click(); } };
      $$('[data-win]').forEach(function (x) { x.onclick = function () { win = Number(x.dataset.win); $$('[data-win]').forEach(function (y) { y.classList.toggle('on', y === x); y.setAttribute('aria-pressed', String(y === x)); }); }; });
      $$('[data-proc]').forEach(function (x) {
        x.onclick = function () {
          var p = R.preset(x.dataset.proc);
          proc = p.key;
          $$('[data-proc]').forEach(function (y) { y.classList.toggle('on', y === x); y.setAttribute('aria-pressed', String(y === x)); });
          if (p.key !== 'custom') {
            f.feePct.value = R.bpsText(p.feeBps).replace('%', '');
            f.feeFixed.value = R.plain(p.feeFixedCents);
            win = p.windowDays;
            $$('[data-win]').forEach(function (y) { var on = Number(y.dataset.win) === win; y.classList.toggle('on', on); y.setAttribute('aria-pressed', String(on)); });
          } else f.feePct.focus();
        };
      });
      f.onsubmit = function (e) {
        e.preventDefault();
        var body = { processor: proc, feePct: f.feePct.value, feeFixed: f.feeFixed.value, windowDays: win, tol: f.tol.value, tolPct: f.tolPct.value, keywords: kws };
        if (f.business) body.business = f.business.value;
        var err = $('#setErr'); err.innerHTML = '';
        var v = R.validateSettings(body, s);
        if (v.error) { showError({ message: v.error }, err); if (f[v.field]) f[v.field].focus(); return; }
        if (mode === 'sample') { b.settings = v.settings; toast('Applied to the sample.'); location.hash = '#/sample'; return; }
        api('PUT', 'api/settings', body).then(function (out) { b.settings = out.settings; loadMe(); toast('Settings saved.'); location.hash = '#/'; }).catch(function (e2) { showError(e2, err); });
      };
      var del = $('#delAll');
      if (del) del.onclick = function () {
        api('DELETE', 'api/books', { confirm: $('#delConfirm').value.trim() }).then(function () { state.books = null; toast('Everything deleted.'); location.hash = '#/'; loadMe(); })
          .catch(function (e) { showError(e, $('#delErr')); });
      };
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    sampleBooks().then(function (b) {
      var result = compute(b);
      var mv = R.month(result, '2026-09');
      view.innerHTML =
        '<section class="hero"><div class="hero-grid"><div>' +
        '<span class="kicker">🧮 For cafés, shops, salons &amp; restaurants</span>' +
        '<h1>Close the day in a minute. Know every card sale <em>got paid.</em></h1>' +
        '<p class="lede">Your terminal says you took $1,284 on Tuesday. A few days later your processor deposits less — fees, refunds, holds. Tally matches the two, day by day, and tells you in plain words when a deposit comes up short or never arrives.</p>' +
        '<div class="ctas"><a class="btn lg" href="#/sample">▶ See a sample café</a><button class="btn lg ghost" data-signup>Start free</button></div>' +
        '<div class="trust"><span>✓ No bank login, ever</span><span>✓ Typing is free forever</span><span>✓ Square, Stripe, Clover, Toast…</span></div>' +
        '</div><a class="peek" href="#/sample" aria-label="Open the sample café’s September"><div class="ph"><b>Copper Kettle Coffee · Sep 2026</b><span>sample</span></div>' +
        calendarHTML(mv, { static: true, noLegend: true }) +
        '<div class="callout"><span aria-hidden="true">×</span><span><b>' + esc(R.money(mv.totals.unaccounted)) + '</b> unaccounted for — a missing batch and a short deposit.</span></div></a></div></section>' +
        '<div class="steps">' +
        '<div class="step"><div class="ic">⌨️</div><h3>1 · Close today</h3><p>Four numbers off the end-of-day report — or snap a photo of it. Tally works out what should reach the bank, and by when.</p></div>' +
        '<div class="step"><div class="ic">🏦</div><h3>2 · Add deposits</h3><p>Drop in the CSV your bank’s website already gives you. We pick out the Square, Stripe, Clover and Toast payouts.</p></div>' +
        '<div class="step"><div class="ic">🔎</div><h3>3 · See what’s missing</h3><p>Every day: ✓ matched, ! short, … pending or × missing — with the reason, in plain words.</p></div>' +
        '</div>' +
        '<div class="card why"><h2>Why bother?</h2><p style="margin-top:8px">Processors get it wrong more often than you’d think: a batch that never settles, a chargeback held without a word, a rate that creeps up 0.3 points. At $40,000 a month in card sales, 0.3 points is $1,440 a year.</p><p>Most small shops never check, because matching a terminal report to a bank statement by hand is a chore. Tally makes it a minute.</p></div>' +
        '<div class="nobank"><span class="e" aria-hidden="true">🔒</span><span>No bank connection. Tally never asks for a bank login — deposits come from a file you download yourself.</span></div>';
      wireSignup();
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- boot ---------------- */

  loadMe().then(function () { ready = true; route(); });
})();
