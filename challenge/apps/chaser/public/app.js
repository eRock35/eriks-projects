/* Chaser - the page. One file, no build step, every model-written or typed string escaped. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');

  // Where the app is mounted: '/' on its own, '/chaser/' inside the lab. The
  // shared statement lives one level down (s/<token>) with <base href="../">,
  // so the base comes from the document's base URI rather than the path.
  var BASE = new URL('.', document.baseURI).pathname;
  var PUB = location.pathname.match(/\/s\/([A-Za-z0-9_-]{16,40})\/?$/);

  var STAGES = [
    { key: 'nudge', label: 'Friendly nudge', short: 'Nudge' },
    { key: 'followup', label: 'Follow-up', short: 'Follow-up' },
    { key: 'firm', label: 'Firm reminder', short: 'Firm' },
    { key: 'final', label: 'Final notice', short: 'Final' },
  ];
  var KINDS = STAGES.concat([{ key: 'plan', label: 'Payment plan offer', short: 'Plan offer' }]);
  var CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'SGD', 'INR', 'ZAR', 'MXN', 'BRL'];

  var state = { me: null, demo: null, clientNames: null, snapped: null, prefillClient: null };

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  /** The phone's own date: "late" means late where the person is. */
  function localToday() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

  function api(method, path, body) {
    var headers = { 'X-Local-Date': localToday() };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(BASE + String(path).replace(/^\//, ''), {
      method: method,
      headers: headers,
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
    if (where) { where.innerHTML = '<div class="err">' + esc(msg) + '</div>'; } else { toast(msg, 3500); }
  }

  var fmts = {};
  function fmt(cur, whole) {
    var k = cur + (whole ? '0' : '2');
    if (!fmts[k]) {
      try { fmts[k] = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }); }
      catch (e) { fmts[k] = { format: function (n) { return cur + ' ' + n.toFixed(whole ? 0 : 2); } }; }
    }
    return fmts[k];
  }
  /** Cents to money, dropping ".00" on whole amounts. */
  function money(cents, cur) {
    var n = (Number(cents) || 0) / 100;
    return fmt(cur || 'USD', n % 1 === 0).format(n);
  }
  function moneyShort(cents, cur) {
    var n = (Number(cents) || 0) / 100;
    if (n >= 1e6) return fmt(cur, true).format(0).replace(/0.*$/, '') + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return fmt(cur, true).format(0).replace(/0.*$/, '') + Math.round(n / 1e3) + 'k';
    return fmt(cur || 'USD', true).format(Math.round(n));
  }
  function fmtDay(iso, opts) {
    if (!iso) return '';
    return new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', month: 'short', day: 'numeric' }, opts || {}));
  }
  function relDay(iso) {
    var n = daysBetween(localToday(), iso);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    if (n > 1 && n < 7) return fmtDay(iso, { weekday: 'long', month: undefined, day: undefined }).replace(/,.*/, '');
    return fmtDay(iso);
  }
  function initials(s) { return String(s || '?').split(/[\s@.]+/).filter(Boolean).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }

  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function confetti() {
    if (reducedMotion()) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var colors = ['#8b7bff', '#e36bd6', '#ffd166', '#34d399', '#60a5fa', '#ff8a5b'];
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
    // The celebration belongs to the moment, not to the next page.
    window.addEventListener('hashchange', function () { box.remove(); }, { once: true });
  }

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
    sms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9z"/></svg>',
    cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/></svg>',
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
  // Passkeys are bound to the shared domain; on a staging *.run.app host they
  // cannot work, so the buttons are not offered there.
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function needAccount(msg) { openAccount(msg || 'Sign up free to chase your own invoices — the sample is read-only.'); }

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
      '<button class="avatar-btn" id="acctBtn" aria-label="Account">' + esc(initials(settings().businessName || settings().yourName || me.email)) + '</button>';
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
        '<h2>' + (mode === 'register' ? 'Get paid. Skip the awkward part.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Free account with $2 of AI credit — a chase costs well under a cent, so that is hundreds of drafts. The templates are free forever. One account works across every app on this site.'
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
    state.clientNames = null;
    return loadMe().then(function () {
      if (!settings().setUp) {
        location.hash = '#/settings';
        toast('First, your voice — 30 seconds, and every chase sounds like you.', 3800);
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
      '<div class="progress" style="margin-top:10px"><i style="width:' + pct + '%;background:linear-gradient(90deg,var(--accent),var(--accent2))"></i></div>' +
      '<p class="small muted" style="margin:10px 0 0">A chase in your voice costs well under a cent; snapping an invoice about a cent. Templates, payments, statements and everything else are free.</p>' +
      '<div id="billing" style="margin-top:12px"></div></div>' +
      '<a class="btn ghost block" href="#/settings" id="voiceLink">Your voice &amp; late fees</a>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" style="margin-top:10px">Sign out</button>',
      function (root) {
        $('#voiceLink', root).onclick = function () { closeSheet(); };
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
      '<p class="muted small">Chasing still works: every rung of the ladder has a free template in your voice, and payments, promises, statements and your scorecards cost nothing.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- routing ---------------- */

  function route() {
    closeSheet();
    if (PUB) return renderShared(PUB[1]);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var tab = parts[0] || 'today';
    var owner = { invoice: 'invoices', client: 'clients', statement: 'clients' };
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === (owner[tab] || tab)); });
    window.scrollTo(0, 0);
    if (tab === 'invoice' && parts[1]) return renderInvoice(parts[1]);
    if (tab === 'client' && parts[1]) return renderClient(parts[1]);
    if (tab === 'statement' && parts[1]) return renderStatement(parts[1]);
    if (tab === 'invoices') return renderInvoices();
    if (tab === 'add') return renderAdd();
    if (tab === 'clients') return renderClients();
    if (tab === 'wins') return renderWins();
    if (tab === 'settings') return renderSettings();
    return signedIn() ? renderToday() : renderHome();
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () { location.hash = '#/' + (b.dataset.tab === 'today' ? '' : b.dataset.tab); };
  });
  window.addEventListener('hashchange', route);

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner" aria-label="Loading"></span></div>'; }
  function backLink(href, label) { return '<a class="back no-print" href="' + href + '">' + ICON.back + esc(label) + '</a>'; }
  function sampleBar(what) {
    return '<div class="sample-bar"><span><b>SAMPLE DATA</b> · ' + esc(what || 'Northlight Studio’s book — invented clients, real arithmetic.') + '</span>' +
      '<button class="btn small" data-signup>Sign up free to chase your own</button></div>';
  }
  function wireSignup(root) { $$('[data-signup]', root).forEach(function (b) { b.onclick = function () { openAccount(); }; }); }

  /* ---------------- pieces ---------------- */

  function rungs(stage) {
    var h = '<span class="rungs" aria-label="' + (stage ? esc(STAGES[stage - 1].label) + ' sent' : 'Not chased yet') + '">';
    for (var i = 0; i < 4; i++) h += '<i class="' + (i < stage ? 'on' : '') + '"></i>';
    return h + '<span>' + (stage ? esc(STAGES[stage - 1].short) + ' sent' : 'Not chased') + '</span></span>';
  }
  function whyChips(r) {
    return '<div class="why">' + (r.why || []).map(function (w) {
      var cls = /didn't pay|broken/.test(w) ? 'hot' : (/late/.test(w) && r.daysLate > 30 ? 'hot' : (/late/.test(w) ? 'warm' : ''));
      return '<span class="' + cls + '">' + esc(w) + '</span>';
    }).join('') + '</div>';
  }
  function statusChip(r) {
    if (r.paused && r.status === 'open') return '<span class="status st-paused">Paused</span>';
    if (r.status === 'open' && r.daysLate > 0) return '<span class="status st-late">Overdue</span>';
    var label = { open: 'Open', promised: 'Promised', paid: 'Paid', written_off: 'Written off' }[r.status] || r.status;
    return '<span class="status st-' + esc(r.status) + '">' + esc(label) + '</span>';
  }

  function chaseCard(r, i) {
    return '<div class="crow' + (i === 0 ? ' rank1' : '') + '" role="link" tabindex="0" data-inv="' + esc(r.id) + '">' +
      (i === 0 ? '<span class="rank">Chase first</span>' : '') +
      '<div class="top-line"><div class="who grow"><div class="ellip">' + esc(r.client.name) + '</div><small>' + esc(r.number) + ' · due ' + esc(fmtDay(r.due)) + '</small></div>' +
      '<div class="amt">' + money(r.balanceCents, r.currency) + (r.paidCents ? '<small>of ' + money(r.amountCents, r.currency) + '</small>' : '') + '</div></div>' +
      whyChips(r) +
      '<div class="foot">' + rungs(r.stage) + '<button class="btn small" data-chase="' + esc(r.id) + '">Chase · ' + esc(shortKind(r.nextKind)) + '</button></div>' +
      '</div>';
  }
  function shortKind(k) { var x = KINDS.filter(function (s) { return s.key === k; })[0]; return x ? x.short : k; }
  function kindLabel(k) { var x = KINDS.filter(function (s) { return s.key === k; })[0]; return x ? x.label : k; }

  function miniRow(r, href) {
    var sub;
    if (r.status === 'promised') sub = 'Promised ' + relDay(r.promise.date);
    else if (r.status === 'paid') sub = 'Paid ' + fmtDay(r.paidAt);
    else if (r.status === 'written_off') sub = 'Written off';
    else if (r.paused) sub = 'Paused · ' + (r.daysLate > 0 ? r.daysLate + ' days late' : 'due ' + fmtDay(r.due));
    else if (r.daysLate < 1) sub = 'Due ' + relDay(r.due);
    else if (r.nextChaseOn) sub = 'Chased · next chase ' + relDay(r.nextChaseOn);
    else sub = r.daysLate + ' days late';
    return '<a class="mrow" href="' + (href || '#/invoice/' + esc(r.id)) + '"><div class="grow"><b class="ellip">' + esc(r.client.name) + '</b><span>' + esc(r.number) + ' · ' + esc(sub) + '</span></div>' +
      '<div class="amt">' + money(r.status === 'paid' ? r.amountCents : r.balanceCents, r.currency) + '<small>' + statusChip(r) + '</small></div></a>';
  }

  /** The forecast, drawn: one series, four weekly bars, direct labels, a hover
   *  tip and a table for screen readers. Colour is --c-likely, validated in
   *  both themes. */
  function forecastChart(fc) {
    var W = 340, H = 150, padL = 4, padB = 26, padT = 22;
    var max = Math.max.apply(null, fc.weeks.map(function (w) { return w.likelyCents; }).concat([1]));
    var bw = (W - padL * 2) / fc.weeks.length;
    var labels = ['This week', 'Next week'];
    var h = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Likely cash in over the next four weeks: ' +
      esc(fc.weeks.map(function (w, i) { return (labels[i] || 'week of ' + fmtDay(w.start)) + ' ' + money(w.likelyCents, fc.currency); }).join(', ')) + '">';
    h += '<line class="axis" x1="0" x2="' + W + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '"/>';
    fc.weeks.forEach(function (w, i) {
      var x = padL + i * bw + bw * 0.18, width = bw * 0.64;
      var bh = w.likelyCents ? Math.max(4, (H - padB - padT) * w.likelyCents / max) : 0;
      var y = H - padB - bh;
      var label = labels[i] || fmtDay(w.start);
      var tip = label + ' (' + fmtDay(w.start) + '–' + fmtDay(w.end) + '): likely ' + money(w.likelyCents, fc.currency) + ' from ' + w.count + ' invoice' + (w.count === 1 ? '' : 's') + (w.dueCents ? ' · ' + money(w.dueCents, fc.currency) + ' falls due' : '');
      h += '<rect class="bar-hit" x="' + (padL + i * bw) + '" y="0" width="' + bw + '" height="' + (H - padB) + '" fill="transparent" tabindex="0" data-tip="' + esc(tip) + '"><title>' + esc(tip) + '</title></rect>';
      if (bh) h += '<path class="bar" d="M' + x + ' ' + (H - padB) + 'V' + (y + 4) + 'q0 -4 4 -4h' + (width - 8) + 'q4 0 4 4V' + (H - padB) + 'Z"/>';
      h += '<text class="val" x="' + (x + width / 2) + '" y="' + (y - 7) + '" text-anchor="middle">' + (w.likelyCents ? esc(moneyShort(w.likelyCents, fc.currency)) : '—') + '</text>';
      h += '<text x="' + (x + width / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(label) + '</text>';
    });
    h += '</svg>';
    h += '<table class="sr-only"><caption>Likely cash in by week</caption><tr><th>Week</th><th>Likely</th><th>Falls due</th></tr>' + fc.weeks.map(function (w, i) {
      return '<tr><td>' + esc(labels[i] || fmtDay(w.start)) + '</td><td>' + money(w.likelyCents, fc.currency) + '</td><td>' + money(w.dueCents, fc.currency) + '</td></tr>';
    }).join('') + '</table>';
    return h;
  }
  function wireTips(root) {
    var tip = null;
    function show(el, x, y) {
      if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip); }
      tip.textContent = el.getAttribute('data-tip');
      tip.style.left = Math.min(window.innerWidth - 250, Math.max(8, x - 120)) + 'px';
      tip.style.top = Math.max(8, y - 64) + 'px';
    }
    function hide() { if (tip) { tip.remove(); tip = null; } }
    $$('[data-tip]', root).forEach(function (el) {
      el.addEventListener('mousemove', function (e) { show(el, e.clientX, e.clientY); });
      el.addEventListener('mouseleave', hide);
      el.addEventListener('focus', function () { var r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top + 30); });
      el.addEventListener('blur', hide);
    });
    window.addEventListener('hashchange', hide, { once: true });
  }

  function forecastCard(fc) {
    var none = !fc.weeks.some(function (w) { return w.likelyCents; });
    return '<div class="card forecast"><div class="eyebrow">Cash forecast · next 4 weeks</div>' +
      (none
        ? '<p class="muted" style="margin:8px 0 0">Nothing expected in the next four weeks yet. Add what you are owed and this fills in.</p>'
        : '<div class="headline" style="margin-top:6px">Likely ~' + esc(moneyShort(Math.round(fc.likelyCents / 1000) * 1000 || fc.likelyCents, fc.currency)) + ' <small>by ' + esc(fmtDay(fc.byDate)) + '</small></div>' +
          forecastChart(fc)) +
      '<p class="chart-note">From what is due, promises, and how each client has paid before — a planning number, not a promise.' + (fc.laterCents ? ' ' + esc(moneyShort(fc.laterCents, fc.currency)) + ' more is likely after that.' : '') + '</p></div>';
  }

  function kpis(t, cur) {
    return '<div class="kpis">' +
      '<div class="kpi"><b>' + esc(moneyShort(t.outstandingCents, cur)) + '</b><span>Outstanding</span></div>' +
      '<div class="kpi' + (t.overdueCents ? ' bad' : '') + '"><b>' + esc(moneyShort(t.overdueCents, cur)) + '</b><span>Overdue' + (t.overdueCount ? ' · ' + t.overdueCount : '') + '</span></div>' +
      '<div class="kpi' + (t.collectedMonthCents ? ' good' : '') + '"><b>' + esc(moneyShort(t.collectedMonthCents, cur)) + '</b><span>In this month</span></div>' +
      '</div>' +
      ((t.others || []).length ? '<p class="others">Plus ' + t.others.map(function (o) { return money(o.outstandingCents, o.currency) + ' in ' + o.currency; }).join(', ') + ' — kept separate, never converted.</p>' : '');
  }

  /** Today, for real data or the sample. */
  function drawToday(root, t, opts) {
    opts = opts || {};
    var h = '';
    h += kpis(t.totals, t.currency);
    h += '<div class="dk-2" style="margin-top:12px"><div>';
    h += '<div class="section-title" style="margin-top:12px"><h2>Chase today</h2><span class="count">' + (t.chase.length ? t.chase.length + ' to chase' : '') + '</span></div>';
    if (t.chase.length) {
      h += '<div class="list">' + t.chase.map(chaseCard).join('') + '</div>';
    } else {
      h += '<div class="empty boxed"><div class="e">🎉</div><h2>Nobody to chase today</h2><p>' +
        (t.counts && t.counts.invoices ? 'Everything is paid, promised, not due yet, or chased recently. Enjoy it.' : 'Add what you’re owed and Chaser puts the right person at the top every morning.') + '</p>' +
        (!opts.demo && !(t.counts && t.counts.invoices) ? '<div class="btn-row" style="justify-content:center"><a class="btn" href="#/add">Add an invoice</a></div>' : '') + '</div>';
    }
    if (t.waiting.length) {
      h += '<div class="section-title"><h2>Waiting</h2><span class="count">promised, chased or not due</span></div>';
      h += '<div class="group">' + t.waiting.map(function (r) { return miniRow(r, opts.demo ? '#/invoice/' + esc(r.id) : null); }).join('') + '</div>';
    }
    if (t.paused.length) {
      h += '<div class="section-title"><h2>Paused</h2></div><div class="group">' + t.paused.map(function (r) { return miniRow(r); }).join('') + '</div>';
    }
    h += '</div><div class="dk-sticky">';
    h += forecastCard(t.forecast);
    if (opts.wins !== false) {
      h += '<a class="card row" href="#/wins" style="text-decoration:none;color:inherit;margin-top:12px"><span style="font-size:30px">' + (t.streakWeeks ? '🔥' : '🏆') + '</span><div class="grow"><b>' +
        (t.streakWeeks ? t.streakWeeks + '-week collecting streak' : 'Wins') + '</b><div class="small muted">' +
        (t.streakWeeks ? 'Money in every week. Keep it going.' : 'Streaks and badges for getting paid.') + '</div></div><span class="muted">›</span></a>';
    }
    h += '</div></div>';
    root.innerHTML = h;
    wireTips(root);
    $$('[data-inv]', root).forEach(function (el) {
      var go = function () { location.hash = '#/invoice/' + el.dataset.inv; };
      el.onclick = go;
      el.onkeydown = function (e) { if (e.key === 'Enter') go(); };
    });
    $$('[data-chase]', root).forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); startChase(b.dataset.chase); };
    });
  }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    loadDemo().then(function (d) {
      view.innerHTML =
        '<section class="hero"><span class="kicker">💸 For freelancers &amp; small businesses</span>' +
        '<h1>Get paid.<br><em>Skip the awkward part.</em></h1>' +
        '<p>Add what you’re owed. Chaser tells you who to chase today, writes the chase in your own voice, and makes every “paid” feel like a win.</p>' +
        '<div class="ctas"><button class="btn lg" id="heroGo">Start free</button><a class="btn lg ghost" href="#sample">See the sample below</a></div>' +
        '<div class="trust"><span>✓ $2 of AI credit free</span><span>✓ Templates always free</span><span>✓ Sends from your own mail app</span></div></section>' +
        '<div id="sample">' + sampleBar() + '</div>' +
        '<div class="page-head" style="margin-top:14px"><div><h1>Today</h1><div class="sub">' + esc(fmtDay(d.today.today, { weekday: 'long', month: 'long' })) + ' · ' + esc(d.settings.businessName) + '</div></div></div>' +
        '<div id="todayBox"></div>' +
        '<div class="section-title"><h2>Who pays, and how</h2><a class="small" href="#/clients">All scorecards ›</a></div>' +
        '<div class="group">' + d.clients.slice(0, 3).map(clientRow).join('') + '</div>' +
        '<div class="steps">' +
        '<div class="step"><div class="ic">📸</div><h3>Snap or type it</h3><p>Photograph an invoice and Chaser reads it — or add it by hand in ten seconds.</p></div>' +
        '<div class="step"><div class="ic">🪜</div><h3>Climb the ladder</h3><p>Friendly nudge, follow-up, firm, final notice — each drafted in your voice, sent from your own mail or messages.</p></div>' +
        '<div class="step"><div class="ic">🎉</div><h3>Celebrate paid</h3><p>Confetti, a collecting streak, badges — and scorecards that tell you which clients to ask for a deposit.</p></div>' +
        '</div>' +
        '<div class="cta-band"><h2>Stop putting it off.</h2><p>Chasing money is awkward. Chaser makes it one tap a morning.</p><button class="btn lg" id="bandGo">Sign up free</button></div>';
      drawToday($('#todayBox'), d.today, { demo: true, wins: true });
      $('#heroGo').onclick = function () { openAccount(); };
      $('#bandGo').onclick = function () { openAccount(); };
      $('a[href="#sample"]').onclick = function (e) { e.preventDefault(); $('#sample').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' }); };
      wireSignup(view);
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- Today ---------------- */

  function renderToday() {
    loading();
    api('GET', 'api/today').then(function (t) {
      var s = settings();
      var hour = new Date().getHours();
      var hi = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
      view.innerHTML =
        '<div class="page-head"><div><h1>Today</h1><div class="sub">' + esc(hi + (s.yourName ? ', ' + s.yourName : '')) + ' · ' + esc(fmtDay(t.today, { weekday: 'long', month: 'long' })) + '</div></div>' +
        (t.streakWeeks ? '<a class="pill streak" href="#/wins">🔥 ' + t.streakWeeks + ' wk</a>' : '') + '</div>' +
        (!t.setUp ? '<a class="banner" href="#/settings" style="text-decoration:none;color:inherit;margin-bottom:12px"><span class="e">🎙️</span><span class="grow"><b>Set up your voice.</b> Your name, sign-off and how to pay — so every chase sounds like you.</span><span>›</span></a>' : '') +
        '<div id="todayBox"></div>';
      drawToday($('#todayBox'), t, {});
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- the chase ---------------- */

  function startChase(id) {
    if (!signedIn()) {
      return loadDemo().then(function (d) {
        var inv = d.invoices.filter(function (x) { return x.id === id; })[0];
        if (inv) openChase(inv, { demo: d.drafts[id] });
      });
    }
    api('GET', 'api/invoices/' + id).then(function (inv) { openChase(inv, {}); }).catch(function (e) { showError(e); });
  }

  /**
   * The chase sheet: pick the rung, draft it (model or template), edit it,
   * then hand it to the phone's own mail or messages app. Logging it as sent
   * is a separate, deliberate tap - it is what climbs the ladder.
   */
  function openChase(inv, opts) {
    var demo = opts.demo || null;
    var st = { kind: demo ? demo.kind : inv.nextKind, fee: false, draft: demo, tab: 'email', busy: false, touched: false };
    var fee = inv.lateFee || null;
    var to = (demo && demo.to) || inv.clientInfo || {};
    var name = (inv.clientInfo && inv.clientInfo.name) || inv.client.name;
    var root = sheet('');

    function draw() {
      var h = '<div class="grab"></div><h2>Chase ' + esc(name) + '</h2>' +
        '<p class="muted small" style="margin:0">' + esc(inv.number) + ' · ' + money(inv.balanceCents, inv.currency) + ' owed · ' +
        (inv.daysLate > 0 ? inv.daysLate + ' days late' : 'due ' + esc(fmtDay(inv.due))) + (inv.promiseBroken ? ' · promise broken' : '') + '</p>';
      h += '<div class="kind-pick" role="group" aria-label="Which chase">' + KINDS.map(function (k, i) {
        var tag = k.key === inv.nextKind ? 'Next' : (i < 4 && i < inv.stage ? 'Sent' : (k.key === 'plan' ? 'Off-ladder' : ''));
        return '<button data-kind="' + k.key + '" class="' + (st.kind === k.key ? 'on' : '') + '" aria-pressed="' + (st.kind === k.key) + '">' + esc(k.short) + '<small>' + esc(tag || ' ') + '</small></button>';
      }).join('') + '</div>';
      if (fee && fee.applies) {
        h += '<label class="check card" style="padding:12px"><input type="checkbox" id="feeChk"' + (st.fee ? ' checked' : '') + '><span><b>Mention the late fee: ' + money(fee.cents, inv.currency) + '</b><br><span class="small muted">' + esc(fee.rule) + ' Only if you tick this — it is never added on its own.</span></span></label>';
      }
      if (demo) {
        h += '<p class="small muted" style="margin:12px 0 0">A pre-written sample from Chaser’s template — no AI was used. Signed in, “Write it in my voice” drafts one from your settings and the invoice’s history.</p>';
      } else {
        h += '<div class="btn-row" style="margin-top:12px"><button class="btn" id="aiBtn">' + ICON.spark + (st.draft ? 'Rewrite' : 'Write it in my voice') + '</button><button class="btn ghost" id="tplBtn">Template · free</button></div>';
      }
      if (st.busy) h += '<div class="writing"><span class="spinner"></span>Writing your ' + esc(kindLabel(st.kind).toLowerCase()) + '…</div>';
      if (st.draft && !st.busy) {
        var d = st.draft;
        h += '<div class="draft">' +
          '<div class="row spread draft-tabs"><div class="seg" style="flex:1"><button data-tab="email" class="' + (st.tab === 'email' ? 'on' : '') + '">Email</button><button data-tab="sms" class="' + (st.tab === 'sms' ? 'on' : '') + '">Text message</button></div>' +
          '<span class="src">' + (d.source === 'ai' ? '✨ Your voice' : d.source === 'template' ? 'Template' : 'Sample') + '</span></div>';
        if (st.tab === 'email') {
          h += '<label class="field"><span>Subject</span><input class="input" id="dSubj" value="' + esc(d.subject) + '"></label>' +
            '<label class="field"><span>Message</span><textarea class="input" id="dBody">' + esc(d.body) + '</textarea></label>';
        } else {
          h += '<label class="field sms"><span>Text</span><textarea class="input" id="dSms">' + esc(d.sms) + '</textarea><div class="count-note" id="smsCount">' + d.sms.length + ' characters</div></label>';
        }
        h += '<div class="send-row">' +
          '<a class="btn" id="sendMail" href="#">' + ICON.mail + 'Mail</a>' +
          '<a class="btn ghost" id="sendSms" href="#">' + ICON.sms + 'Messages</a>' +
          '<button class="btn ghost" id="copyBtn">' + ICON.copy + 'Copy</button></div>' +
          '<p class="honest"><span aria-hidden="true">ℹ️</span><span>Chaser has no mail server. Mail and Messages open your own apps with this filled in — it comes from you, and nothing goes until you press send there.</span></p>' +
          '<button class="btn good block logged" id="logBtn">I sent it — log the ' + esc(kindLabel(st.kind).toLowerCase()) + '</button>' +
          '</div>';
      }
      h += '<div id="chaseErr"></div>';
      root.innerHTML = h;
      wire();
      fit();
    }
    // The message box grows to fit the draft, up to most of the screen, so
    // the sign-off is never hidden below a fold inside a fold.
    function fit() {
      var ta = $('#dBody', root);
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(window.innerHeight * 0.6, ta.scrollHeight + 4) + 'px';
    }

    function current() {
      var d = st.draft || {};
      return {
        subject: $('#dSubj', root) ? $('#dSubj', root).value : d.subject,
        body: $('#dBody', root) ? $('#dBody', root).value : d.body,
        sms: $('#dSms', root) ? $('#dSms', root).value : d.sms,
      };
    }
    function keep() { if (st.draft) { var c = current(); st.draft.subject = c.subject; st.draft.body = c.body; st.draft.sms = c.sms; } }
    function links() {
      var c = current();
      var mail = $('#sendMail', root), sms = $('#sendSms', root);
      if (mail) mail.href = 'mailto:' + encodeURIComponent(to.email || '') + '?subject=' + encodeURIComponent(c.subject || '') + '&body=' + encodeURIComponent(c.body || '');
      if (sms) sms.href = 'sms:' + String(to.phone || '').replace(/[^0-9+]/g, '') + '?&body=' + encodeURIComponent(c.sms || '');
    }
    function draft(kind) {
      if (demo) return;
      st.busy = true; draw();
      api('POST', 'api/invoices/' + inv.id + '/' + kind, { kind: st.kind, includeFee: st.fee })
        .then(function (d) { st.draft = d; st.busy = false; st.tab = 'email'; draw(); if (kind === 'draft') loadMe(); })
        .catch(function (e) { st.busy = false; draw(); if (e.status === 402) { openCreditSheet(e.data); return; } showError(e, $('#chaseErr', root)); });
    }
    function wire() {
      $$('[data-kind]', root).forEach(function (b) {
        b.onclick = function () {
          if (demo) return needAccount('Sign up free to pick the rung and draft your own chases.');
          keep(); st.kind = b.dataset.kind; st.draft = null; draw();
        };
      });
      var fc = $('#feeChk', root);
      if (fc) fc.onchange = function () { if (demo) { fc.checked = false; return needAccount(); } keep(); st.fee = fc.checked; st.draft = null; draw(); };
      var ai = $('#aiBtn', root); if (ai) ai.onclick = function () { draft('draft'); };
      var tp = $('#tplBtn', root); if (tp) tp.onclick = function () { draft('template'); };
      $$('[data-tab]', root).forEach(function (b) { b.onclick = function () { keep(); st.tab = b.dataset.tab; draw(); }; });
      ['#dSubj', '#dBody', '#dSms'].forEach(function (sel) {
        var el = $(sel, root);
        if (el) el.oninput = function () { links(); if (sel === '#dBody') fit(); var n = $('#smsCount', root); if (n && sel === '#dSms') n.textContent = el.value.length + ' characters'; };
      });
      var mail = $('#sendMail', root);
      if (mail) {
        links();
        mail.onclick = function (e) { if (demo) { e.preventDefault(); return needAccount(); } st.channel = 'email'; nudgeLog(); };
        $('#sendSms', root).onclick = function (e) { if (demo) { e.preventDefault(); return needAccount(); } if (!to.phone) toast('No phone number for this client — Messages opens without one.'); st.channel = 'sms'; nudgeLog(); };
        $('#copyBtn', root).onclick = function () {
          var c = current();
          var text = st.tab === 'sms' ? c.sms : c.subject + '\n\n' + c.body;
          (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Copied.'); }, function () { toast('Select the text and copy it.'); });
          st.channel = 'copy'; nudgeLog();
        };
        $('#logBtn', root).onclick = function () {
          if (demo) return needAccount('Sign up free and every chase you log climbs the ladder.');
          var c = current(); var btn = this; btn.disabled = true;
          api('POST', 'api/invoices/' + inv.id + '/chases', { kind: st.kind, channel: st.channel || (st.tab === 'sms' ? 'sms' : 'email'), source: st.draft.source === 'ai' ? 'ai' : 'template', subject: c.subject, body: st.tab === 'sms' ? c.sms : c.body })
            .then(function (r) {
              closeSheet();
              toast(r.nextChaseOn ? 'Logged. Next: ' + kindLabel(r.nextKind).toLowerCase() + ' ' + relDay(r.nextChaseOn) + '.' : 'Logged.', 3200);
              celebrateBadges(r.newBadges);
              route();
            }).catch(function (e) { btn.disabled = false; showError(e, $('#chaseErr', root)); });
        };
      }
    }
    function nudgeLog() {
      var b = $('#logBtn', root);
      if (b) { b.classList.add('pulse'); b.textContent = 'Sent it? Log the ' + kindLabel(st.kind).toLowerCase(); }
    }
    draw();
  }

  function celebrateBadges(list) {
    if (!list || !list.length) return;
    confetti();
    toast('Badge earned: ' + list.map(function (b) { return b.emoji + ' ' + b.label; }).join(', '), 3600);
  }

  /* ---------------- invoice ---------------- */

  function renderInvoice(id) {
    loading();
    var get = signedIn() ? api('GET', 'api/invoices/' + id) : loadDemo().then(function (d) {
      var inv = d.invoices.filter(function (x) { return x.id === id; })[0];
      if (!inv) { var e = new Error('Sign in to see your invoices.'); e.status = 401; throw e; }
      inv.demo = true; return inv;
    });
    get.then(function (inv) { drawInvoice(inv); }).catch(function (e) { showError(e, view); });
  }

  function drawInvoice(inv) {
    var demo = Boolean(inv.demo);
    var name = (inv.clientInfo && inv.clientInfo.name) || inv.client.name;
    var cid = (inv.clientInfo && inv.clientInfo.id) || inv.client.id;
    var live = inv.status === 'open' || inv.status === 'promised';
    var paidPct = inv.amountCents ? Math.round(100 * inv.paidCents / inv.amountCents) : 0;
    var h = (demo ? sampleBar('A sample invoice. Nothing here can be changed.') : '') + backLink('#/' + (demo ? '' : 'invoices'), demo ? 'Today' : 'Invoices');
    h += '<div class="dk-2"><div>';
    h += '<div class="card inv-head"><div class="row spread"><a href="#/client/' + esc(cid) + '" class="ellip" style="font-weight:750;color:var(--text);text-decoration:none">' + esc(name) + ' ›</a>' + statusChip(inv) + '</div>' +
      '<div class="amount">' + money(inv.status === 'paid' ? inv.amountCents : inv.balanceCents, inv.currency) + '</div>' +
      '<div class="of">' + (inv.status === 'paid' ? 'Paid in full ' + esc(fmtDay(inv.paidAt, { year: 'numeric' })) + ' 🎉' : inv.paidCents ? money(inv.paidCents, inv.currency) + ' paid of ' + money(inv.amountCents, inv.currency) : 'owed on ' + esc(inv.number)) + '</div>' +
      (inv.paidCents && inv.status !== 'paid' ? '<div class="progress" aria-label="' + paidPct + '% paid"><i style="width:' + paidPct + '%"></i></div>' : '') +
      (live ? whyChips(inv) : '') +
      '<div class="facts">' +
      '<div><span>Invoice</span><b>' + esc(inv.number) + '</b></div>' +
      '<div><span>Due</span><b>' + esc(fmtDay(inv.due, { year: 'numeric' })) + '</b></div>' +
      '<div><span>Issued</span><b>' + esc(fmtDay(inv.issued, { year: 'numeric' })) + '</b></div>' +
      '<div><span>Terms</span><b>' + esc(inv.terms || '—') + '</b></div>' +
      '</div>' +
      (inv.notes ? '<p class="small muted" style="margin:14px 0 0">' + esc(inv.notes) + '</p>' : '');
    if (live) {
      h += '<div class="actions"><button class="btn" id="chaseBtn">Chase · ' + esc(shortKind(inv.nextKind)) + '</button><button class="btn good" id="paidBtn">Mark paid</button></div>' +
        '<div class="more-actions"><button class="btn small ghost" id="payBtn">Log a part payment</button><button class="btn small ghost" id="promBtn">They promised…</button>' +
        (demo ? '' : '<button class="btn small ghost" id="pauseBtn">' + (inv.paused ? 'Resume chasing' : 'Pause chasing') + '</button>') + '</div>';
    }
    h += '</div>';

    if (live || inv.stage) {
      h += '<div class="card"><div class="card-head"><h3>The ladder</h3><span class="sub">' + (live ? 'Next: ' + esc(kindLabel(inv.nextKind)) : esc(inv.stageLabel)) + '</span></div><div class="ladder">' +
        STAGES.map(function (s, i) {
          var cls = i < inv.stage ? 'done' : (live && s.key === inv.nextKind ? 'next' : '');
          return '<div class="' + cls + '"><i></i>' + esc(s.short) + '</div>';
        }).join('') + '</div>' +
        (inv.nextChaseOn && live ? '<p class="small muted" style="margin:10px 0 0">Next chase is due ' + esc(relDay(inv.nextChaseOn)) + '. Chasing sooner is fine — you decide.</p>' : '') +
        (inv.paused ? '<p class="small muted" style="margin:10px 0 0">Paused — it stays off the chase list until you resume.</p>' : '') + '</div>';
    }

    var fee = inv.lateFee;
    if (fee && live && fee.mode !== 'none') {
      h += '<div class="card fee-box"><span class="e">⏱️</span><div class="grow"><div class="eyebrow">Late fee, if you charge it</div><b>' + money(fee.cents, inv.currency) + '</b>' +
        '<div class="small muted">' + esc(fee.rule) + ' Never added to the balance — tick it into a chase if you choose to ask for it.</div></div></div>';
    } else if (live && fee && fee.mode === 'none' && inv.daysLate > 0 && !demo) {
      h += '<div class="card small muted">No late-fee policy set. <a href="#/settings">Add one</a> to see what you could charge — it is only ever shown, never added.</div>';
    }
    h += '</div><div class="dk-sticky">';

    h += '<div class="card"><div class="card-head"><h3>Payments</h3><span class="sub">' + money(inv.paidCents, inv.currency) + ' in</span></div>';
    h += (inv.payments || []).length ? '<ul class="timeline">' + inv.payments.map(function (p) {
      return '<li><span class="dot">💵</span><div class="grow"><b>' + money(p.cents, inv.currency) + '</b><span>' + esc(fmtDay(p.date, { year: 'numeric' })) + (p.note ? ' · ' + esc(p.note) : '') + '</span></div>' +
        (demo ? '' : '<button class="icon-btn x" data-delpay="' + esc(p.id) + '" aria-label="Remove this payment">' + ICON.x + '</button>') + '</li>';
    }).join('') + '</ul>' : '<p class="small muted" style="margin:0">Nothing in yet.</p>';
    h += '</div>';

    var events = [];
    (inv.chases || []).forEach(function (c) { events.push({ at: c.at, html: '<span class="dot">' + ({ email: '✉️', sms: '💬', copy: '📋', call: '📞' }[c.channel] || '📣') + '</span><div class="grow"><b>' + esc(kindLabel(c.kind)) + '</b><span>' + esc(fmtDay(c.at, { year: 'numeric' })) + ' · ' + esc({ email: 'by email', sms: 'by text', copy: 'copied', call: 'call' }[c.channel] || 'sent') + (c.subject ? ' · ' + esc(c.subject) : '') + '</span></div>' }); });
    (inv.promises || []).forEach(function (p) {
      var broken = p.date < localToday() && (inv.status !== 'paid' || (inv.paidAt && inv.paidAt > p.date));
      var kept = inv.status === 'paid' && inv.paidAt && inv.paidAt <= p.date;
      events.push({ at: p.at || p.date, html: '<span class="dot">' + (kept ? '🤝' : broken ? '💔' : '🗓️') + '</span><div class="grow"><b>Promised to pay by ' + esc(fmtDay(p.date, { weekday: 'short' })) + '</b><span>' + (kept ? 'Kept' : broken ? 'Broken' : 'Waiting') + (p.note ? ' · ' + esc(p.note) : '') + '</span></div>' });
    });
    events.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    h += '<div class="card"><div class="card-head"><h3>Timeline</h3><span class="sub">' + (inv.chases || []).length + ' chase' + ((inv.chases || []).length === 1 ? '' : 's') + '</span></div>' +
      (events.length ? '<ul class="timeline">' + events.map(function (e) { return '<li>' + e.html + '</li>'; }).join('') + '</ul>' : '<p class="small muted" style="margin:0">No chases yet.</p>') + '</div>';

    if (!demo) {
      h += '<div class="more-actions no-print" style="margin-top:14px"><button class="btn small ghost" id="editBtn">Edit invoice</button>' +
        (live ? '<button class="btn small ghost" id="woBtn">Write off</button>' : inv.status === 'written_off' ? '<button class="btn small ghost" id="unwoBtn">Reopen</button>' : '') +
        (inv.promise && inv.status === 'promised' ? '<button class="btn small ghost" id="unpromBtn">Remove promise</button>' : '') +
        '<button class="btn small danger" id="delBtn">Delete</button></div>';
    }
    h += '</div></div>';
    view.innerHTML = h;
    wireSignup(view);

    var guard = function (fn) { return function () { if (demo) return needAccount(); fn.apply(this, arguments); }; };
    var cb = $('#chaseBtn'); if (cb) cb.onclick = function () { if (demo) return startChase(inv.id); openChase(inv, {}); };
    var pb = $('#paidBtn'); if (pb) pb.onclick = guard(function () { markPaid(inv, pb); });
    var pp = $('#payBtn'); if (pp) pp.onclick = guard(function () { openPayment(inv); });
    var pr = $('#promBtn'); if (pr) pr.onclick = guard(function () { openPromise(inv); });
    var pa = $('#pauseBtn'); if (pa) pa.onclick = function () { act(inv, 'pause', { paused: !inv.paused }, inv.paused ? 'Back on the chase list.' : 'Paused.'); };
    var ed = $('#editBtn'); if (ed) ed.onclick = function () { openEditInvoice(inv); };
    var wo = $('#woBtn'); if (wo) wo.onclick = function () { if (confirm('Write this invoice off? It leaves your totals and chase list, and counts against the client’s scorecard.')) act(inv, 'write-off', { writtenOff: true }, 'Written off.'); };
    var uw = $('#unwoBtn'); if (uw) uw.onclick = function () { act(inv, 'write-off', { writtenOff: false }, 'Reopened.'); };
    var up = $('#unpromBtn'); if (up) up.onclick = function () { api('DELETE', 'api/invoices/' + inv.id + '/promise').then(drawInvoice).catch(function (e) { showError(e); }); };
    var dl = $('#delBtn'); if (dl) dl.onclick = function () {
      if (!confirm('Delete ' + inv.number + ' for good? Its payments and chase history go with it.')) return;
      api('DELETE', 'api/invoices/' + inv.id).then(function () { toast('Deleted.'); location.hash = '#/invoices'; }).catch(function (e) { showError(e); });
    };
    $$('[data-delpay]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Remove this payment?')) return;
        api('DELETE', 'api/invoices/' + inv.id + '/payments/' + b.dataset.delpay).then(drawInvoice).catch(function (e) { showError(e); });
      };
    });
  }

  function act(inv, what, body, msg) {
    api('POST', 'api/invoices/' + inv.id + '/' + what, body).then(function (r) { toast(msg); drawInvoice(r); }).catch(function (e) { showError(e); });
  }

  function markPaid(inv, btn) {
    if (btn) btn.disabled = true;
    api('POST', 'api/invoices/' + inv.id + '/payments', { full: true }).then(function (r) {
      drawInvoice(r);
      if (r.win) showWin(r);
    }).catch(function (e) { if (btn) btn.disabled = false; showError(e); });
  }

  /** The moment. Confetti (unless motion is reduced), the amount, how late it
   *  was, the streak, and any badge it earned. */
  function showWin(r) {
    var w = r.win;
    confetti();
    var late = w.daysLate;
    sheet('<div class="win"><div class="big" aria-hidden="true">🎉</div><h2>Paid!</h2><div class="amt">' + money(w.cents, w.currency) + '</div>' +
      '<p class="muted" style="margin:6px 0 0">' + esc((r.clientInfo && r.clientInfo.name) || r.client.name) + ' · ' + esc(r.number) + '</p>' +
      '<p style="margin:12px 0 0">' + (late >= 60 ? 'Collected <b>' + late + ' days late</b>. That one took grit.' : late > 0 ? 'In after ' + late + ' day' + (late === 1 ? '' : 's') + ' late — the chase worked.' : 'Paid on time. A good client.') + '</p>' +
      (w.streakWeeks ? '<p style="margin:8px 0 0">🔥 <b>' + w.streakWeeks + '-week</b> collecting streak</p>' : '') +
      ((r.newBadges || []).length ? '<div class="new-badges">' + r.newBadges.map(function (b) { return '<span>' + esc(b.emoji) + ' ' + esc(b.label) + '</span>'; }).join('') + '</div>' : '') +
      '<button class="btn block lg" id="winOk" style="margin-top:18px">Nice</button></div>',
      function (root) { $('#winOk', root).onclick = closeSheet; });
  }

  function openPayment(inv) {
    sheet('<h2>Log a payment</h2><p class="muted small">' + esc(inv.number) + ' · ' + money(inv.balanceCents, inv.currency) + ' still owed</p>' +
      '<div class="group" style="margin-top:12px">' +
      '<div class="cell"><label for="pAmt">Amount</label><input id="pAmt" inputmode="decimal" placeholder="0.00" value="' + esc((inv.balanceCents / 100).toFixed(2)) + '"></div>' +
      '<div class="cell"><label for="pDate">Date</label><input id="pDate" type="date" max="' + localToday() + '" value="' + localToday() + '"></div>' +
      '<div class="cell"><label for="pNote">Note</label><input id="pNote" placeholder="Bank transfer" maxlength="120"></div></div>' +
      '<div id="pErr"></div><button class="btn block" id="pSave" style="margin-top:14px">Log it</button>',
      function (root) {
        $('#pSave', root).onclick = function () {
          var btn = this; btn.disabled = true;
          api('POST', 'api/invoices/' + inv.id + '/payments', { amount: $('#pAmt', root).value, date: $('#pDate', root).value, note: $('#pNote', root).value })
            .then(function (r) { closeSheet(); drawInvoice(r); if (r.win) showWin(r); else { toast('Logged. ' + money(r.balanceCents, r.currency) + ' to go.'); celebrateBadges(r.newBadges); } })
            .catch(function (e) { btn.disabled = false; showError(e, $('#pErr', root)); });
        };
      });
  }

  function openPromise(inv) {
    var t = localToday();
    var dow = new Date(t + 'T12:00:00Z').getUTCDay();
    var fri = addDays(t, ((5 - dow + 7) % 7) || 7);
    var mon = addDays(t, ((1 - dow + 7) % 7) || 7);
    var eom = (function () { var d = new Date(t + 'T12:00:00Z'); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); })();
    sheet('<h2>They promised to pay</h2><p class="muted small">Chaser stops nagging you about it until then. If the day passes without the money, it goes to the top of the list and the next chase mentions it.</p>' +
      '<div class="chips" style="margin:12px 0"><button class="chip" data-d="' + fri + '">Friday</button><button class="chip" data-d="' + mon + '">Next Monday</button><button class="chip" data-d="' + eom + '">End of month</button></div>' +
      '<div class="group"><div class="cell"><label for="prDate">By</label><input id="prDate" type="date" min="' + t + '" value="' + fri + '"></div>' +
      '<div class="cell"><label for="prNote">Note</label><input id="prNote" placeholder="Said on the phone" maxlength="140"></div></div>' +
      '<div id="prErr"></div><button class="btn block" id="prSave" style="margin-top:14px">Save the promise</button>',
      function (root) {
        $$('[data-d]', root).forEach(function (b) { b.onclick = function () { $('#prDate', root).value = b.dataset.d; }; });
        $('#prSave', root).onclick = function () {
          api('POST', 'api/invoices/' + inv.id + '/promise', { date: $('#prDate', root).value, note: $('#prNote', root).value })
            .then(function (r) { closeSheet(); toast('Promise noted for ' + relDay(r.promise.date) + '.'); drawInvoice(r); })
            .catch(function (e) { showError(e, $('#prErr', root)); });
        };
      });
  }

  function currencyOptions(sel) {
    return CURRENCIES.map(function (c) { return '<option' + (c === sel ? ' selected' : '') + '>' + c + '</option>'; }).join('');
  }

  function openEditInvoice(inv) {
    sheet('<h2>Edit ' + esc(inv.number) + '</h2>' +
      '<div class="group" style="margin-top:12px">' +
      '<div class="cell"><label for="eNum">Invoice #</label><input id="eNum" value="' + esc(inv.number) + '" maxlength="40"></div>' +
      '<div class="cell"><label for="eAmt">Amount</label><input id="eAmt" inputmode="decimal" value="' + esc((inv.amountCents / 100).toFixed(2)) + '"></div>' +
      '<div class="cell"><label for="eCur">Currency</label><select id="eCur">' + currencyOptions(inv.currency) + '</select></div>' +
      '<div class="cell"><label for="eIss">Issued</label><input id="eIss" type="date" value="' + esc(inv.issued) + '"></div>' +
      '<div class="cell"><label for="eDue">Due</label><input id="eDue" type="date" value="' + esc(inv.due) + '"></div>' +
      '<div class="cell"><label for="eTerms">Terms</label><input id="eTerms" value="' + esc(inv.terms) + '" maxlength="40"></div>' +
      '<div class="cell stack"><label for="eNotes">Notes (private)</label><textarea id="eNotes" maxlength="1000">' + esc(inv.notes) + '</textarea></div></div>' +
      '<div id="eErr"></div><button class="btn block" id="eSave" style="margin-top:14px">Save</button>',
      function (root) {
        $('#eSave', root).onclick = function () {
          api('PUT', 'api/invoices/' + inv.id, {
            number: $('#eNum', root).value, amount: $('#eAmt', root).value, currency: $('#eCur', root).value,
            issued: $('#eIss', root).value, due: $('#eDue', root).value, terms: $('#eTerms', root).value, notes: $('#eNotes', root).value,
          }).then(function (r) { closeSheet(); toast('Saved.'); drawInvoice(r); }).catch(function (e) { showError(e, $('#eErr', root)); });
        };
      });
  }

  /* ---------------- invoices list ---------------- */

  var invFilter = 'live';
  function renderInvoices() {
    if (!signedIn()) return pitch('📄', 'Every invoice, and where it stands', 'Open, overdue, promised, paid — with the balance after every part payment.');
    loading();
    api('GET', 'api/invoices').then(function (r) {
      var all = r.invoices;
      var F = {
        live: { label: 'Unpaid', f: function (x) { return x.status === 'open' || x.status === 'promised'; } },
        late: { label: 'Overdue', f: function (x) { return (x.status === 'open' || x.status === 'promised') && x.daysLate > 0; } },
        promised: { label: 'Promised', f: function (x) { return x.status === 'promised'; } },
        paid: { label: 'Paid', f: function (x) { return x.status === 'paid'; } },
        written_off: { label: 'Written off', f: function (x) { return x.status === 'written_off'; } },
        all: { label: 'All', f: function () { return true; } },
      };
      function draw() {
        var rows = all.filter(F[invFilter].f);
        view.innerHTML = '<div class="page-head"><div><h1>Invoices</h1><div class="sub">' + all.length + ' in your book</div></div><a class="btn small" href="#/add">+ Add</a></div>' +
          '<div class="chips" style="margin-bottom:14px">' + Object.keys(F).map(function (k) {
            var n = all.filter(F[k].f).length;
            return '<button class="chip' + (invFilter === k ? ' on' : '') + '" data-f="' + k + '">' + F[k].label + (k !== 'all' ? ' · ' + n : '') + '</button>';
          }).join('') + '</div>' +
          (rows.length ? '<div class="group list-group">' + rows.map(function (x) { return miniRow(x); }).join('') + '</div>'
            : '<div class="empty boxed"><div class="e">📭</div><h2>' + (all.length ? 'Nothing here' : 'No invoices yet') + '</h2><p>' + (all.length ? 'Try another filter.' : 'Snap one or type it in — it takes ten seconds.') + '</p>' + (all.length ? '' : '<a class="btn" href="#/add">Add an invoice</a>') + '</div>');
        $$('[data-f]').forEach(function (b) { b.onclick = function () { invFilter = b.dataset.f; draw(); }; });
      }
      draw();
    }).catch(function (e) { showError(e, view); });
  }

  function pitch(emoji, title, body) {
    view.innerHTML = '<div class="empty"><div class="e">' + emoji + '</div><h2>' + esc(title) + '</h2><p>' + esc(body) + '</p>' +
      '<div class="btn-row" style="justify-content:center"><button class="btn" data-signup>Start free</button><a class="btn ghost" href="#/">See the sample</a></div></div>';
    wireSignup(view);
  }

  /* ---------------- add / snap ---------------- */

  function renderAdd() {
    if (!signedIn()) return pitch('📸', 'Snap an invoice, or type it in', 'Chaser reads the client, amount and dates from a photo — the photo is read once and never kept.');
    var s = settings();
    var p = state.snapped || {};
    var pre = state.prefillClient || (p.client && p.client.name) || '';
    view.innerHTML =
      '<div class="page-head"><div><h1>Add an invoice</h1><div class="sub">What are you owed?</div></div></div>' +
      '<label class="card snap-card" id="snapCard"><span class="ic">📸</span><span class="grow"><b>Snap an invoice</b><span>A photo of one you sent — Chaser fills in the details. About a cent of AI credit; the photo is never stored.</span></span>' +
      '<input type="file" id="snapIn" accept="image/*" capture="environment"></label>' +
      '<div id="snapState"></div>' +
      '<div class="or">or type it in</div>' +
      '<div class="group-title">Client</div>' +
      '<div class="group">' +
      '<div class="cell"><label for="aClient">Client</label><input id="aClient" list="clientList" placeholder="Business or person" value="' + esc(pre) + '" maxlength="80" autocomplete="off"></div>' +
      '<div class="cell"><label for="aContact">Contact</label><input id="aContact" placeholder="Who you deal with" maxlength="60"></div>' +
      '<div class="cell"><label for="aEmail">Email</label><input id="aEmail" type="email" inputmode="email" placeholder="For Mail" value="' + esc((p.client && p.client.email) || '') + '"></div>' +
      '<div class="cell"><label for="aPhone">Phone</label><input id="aPhone" type="tel" placeholder="For Messages"></div>' +
      '</div><datalist id="clientList"></datalist>' +
      '<p class="hint">An existing client is matched by name — their details are kept.</p>' +
      '<div class="group-title">Invoice</div>' +
      '<div class="group">' +
      '<div class="cell"><label for="aAmt">Amount</label><input id="aAmt" inputmode="decimal" placeholder="0.00" value="' + (p.amountCents ? esc((p.amountCents / 100).toFixed(2)) : '') + '"></div>' +
      '<div class="cell"><label for="aCur">Currency</label><select id="aCur">' + currencyOptions(p.currency || s.currency || 'USD') + '</select></div>' +
      '<div class="cell"><label for="aNum">Invoice #</label><input id="aNum" placeholder="Automatic" maxlength="40" value="' + esc(p.number || '') + '"></div>' +
      '<div class="cell"><label for="aIss">Issued</label><input id="aIss" type="date" value="' + esc(p.issued || localToday()) + '"></div>' +
      '<div class="cell"><label for="aDue">Due</label><input id="aDue" type="date" value="' + esc(p.due || '') + '"></div>' +
      '<div class="cell"><label for="aTerms">Terms</label><input id="aTerms" placeholder="Net ' + esc(s.termsDays == null ? 30 : s.termsDays) + '" maxlength="40" value="' + esc(p.terms || '') + '"></div>' +
      '<div class="cell stack"><label for="aNotes">Notes (private)</label><textarea id="aNotes" maxlength="1000" placeholder="What it was for">' + esc(p.notes || '') + '</textarea></div>' +
      '</div><p class="hint">No due date? It is worked out from the terms.</p>' +
      '<div id="aErr"></div><button class="btn block lg" id="aSave" style="margin-top:16px">Add to my book</button>';
    if (state.snapped) $('#snapState').innerHTML = '<div class="banner" style="margin-top:12px"><span class="e">✨</span><span>Read from your photo' + (p.currencyGuessed ? ' (currency not shown — check it)' : '') + '. Check it, then save. The photo wasn’t kept.</span></div>';
    state.prefillClient = null;
    api('GET', 'api/invoices').then(function (r) {
      $('#clientList').innerHTML = r.clients.map(function (c) { return '<option value="' + esc(c.name) + '">'; }).join('');
    }).catch(function () {});
    $('#snapIn').onchange = function (e) { var f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) snap(f); };
    $('#aSave').onclick = function () {
      var btn = this; btn.disabled = true;
      api('POST', 'api/invoices', {
        client: { name: $('#aClient').value, contactName: $('#aContact').value, email: $('#aEmail').value, phone: $('#aPhone').value },
        amount: $('#aAmt').value, currency: $('#aCur').value, number: $('#aNum').value, issued: $('#aIss').value,
        due: $('#aDue').value, terms: $('#aTerms').value, notes: $('#aNotes').value, source: state.snapped ? 'snap' : 'manual',
      }).then(function (inv) {
        state.snapped = null;
        toast(inv.daysLate > 0 ? 'Added — it is already ' + inv.daysLate + ' days late. Chase it?' : 'Added. Chaser will tell you when it is time.', 3200);
        location.hash = '#/invoice/' + inv.id;
      }).catch(function (e) { btn.disabled = false; showError(e, $('#aErr')); });
    };
  }

  /** Shrink on the phone: 1600px on the long side, JPEG, under ~3.5 MB. A
   *  12-megapixel photo is 4 MB+; this is a few hundred KB and still legible. */
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
        var q = 0.85, d = c.toDataURL('image/jpeg', q);
        while (d.length * 0.75 > 3.5e6 && q > 0.4) { q -= 0.15; d = c.toDataURL('image/jpeg', q); }
        c.width = c.height = 0;
        resolve({ type: 'image/jpeg', data: d.split(',')[1] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be opened. Try a JPEG or PNG.')); };
      img.src = url;
    });
  }

  function snap(file) {
    var box = $('#snapState');
    box.innerHTML = '<div class="card writing" style="margin-top:12px"><span class="spinner"></span>Reading your invoice…</div>';
    shrink(file).then(function (image) {
      return api('POST', 'api/invoices/read', { image: image });
    }).then(function (p) {
      state.snapped = p;
      loadMe();
      renderAdd();
    }).catch(function (e) {
      if (e.status === 402) { box.innerHTML = ''; return openCreditSheet(e.data); }
      box.innerHTML = '<div class="banner warn" style="margin-top:12px"><span class="e">🤔</span><span>' + esc(e.message) + '</span></div>';
    });
  }

  /* ---------------- clients ---------------- */

  function gradeBox(c, big) {
    return '<span class="grade ' + (c.grade ? 'g-' + c.grade : 'g-new') + (big ? ' big' : '') + '" aria-label="' + (c.grade ? 'Grade ' + c.grade : 'New client, no grade yet') + '">' + (c.grade || 'New') + '</span>';
  }
  function clientRow(c) {
    var bits = [];
    if (c.avgDaysLate != null) bits.push(c.avgDaysLate ? 'avg ' + Math.round(c.avgDaysLate) + ' days late' : 'pays on time');
    if (c.onTimePct != null) bits.push(c.onTimePct + '% on time');
    if (c.brokenPromises) bits.push(c.brokenPromises + ' broken promise' + (c.brokenPromises > 1 ? 's' : ''));
    if (!bits.length) bits.push(c.invoices ? 'No payments yet' : 'No invoices yet');
    return '<a class="mrow" href="#/client/' + esc(c.id) + '">' + gradeBox(c) + '<div class="grow"><b class="ellip">' + esc(c.name) + '</b><span>' + esc(bits.join(' · ')) + '</span></div>' +
      '<div class="amt">' + (c.outstandingCents ? money(c.outstandingCents, c.currency) : '—') + '<small>' + (c.overdueCents ? '<span style="color:var(--bad)">' + money(c.overdueCents, c.currency) + ' late</span>' : 'owed') + '</small></div></a>';
  }

  function renderClients() {
    loading();
    var get = signedIn() ? api('GET', 'api/clients').then(function (r) { return { clients: r.clients }; }) : loadDemo().then(function (d) { return { clients: d.clients, demo: true }; });
    get.then(function (r) {
      view.innerHTML = (r.demo ? sampleBar() : '') +
        '<div class="page-head"><div><h1>Clients</h1><div class="sub">Riskiest first — what’s owed, weighted by how they pay</div></div>' + (r.demo ? '' : '<button class="btn small" id="addC">+ Client</button>') + '</div>' +
        (r.clients.length ? '<div class="group">' + r.clients.map(clientRow).join('') + '</div>'
          : '<div class="empty boxed"><div class="e">👥</div><h2>No clients yet</h2><p>They appear as you add invoices. Each gets a scorecard once they pay.</p></div>') +
        '<p class="hint">Grades come from days late, on-time payments, broken promises and write-offs. A client with no history has no grade.</p>';
      wireSignup(view);
      var a = $('#addC'); if (a) a.onclick = function () { openClientSheet(null); };
    }).catch(function (e) { showError(e, view); });
  }

  function openClientSheet(c) {
    c = c || {};
    sheet('<h2>' + (c.id ? 'Edit client' : 'New client') + '</h2>' +
      '<div class="group" style="margin-top:12px">' +
      '<div class="cell"><label for="cName">Name</label><input id="cName" value="' + esc(c.name || '') + '" maxlength="80" placeholder="Business or person"></div>' +
      '<div class="cell"><label for="cContact">Contact</label><input id="cContact" value="' + esc(c.contactName || '') + '" maxlength="60" placeholder="Chases greet them"></div>' +
      '<div class="cell"><label for="cEmail">Email</label><input id="cEmail" type="email" value="' + esc(c.email || '') + '"></div>' +
      '<div class="cell"><label for="cPhone">Phone</label><input id="cPhone" type="tel" value="' + esc(c.phone || '') + '"></div>' +
      '<div class="cell stack"><label for="cNotes">Notes (private)</label><textarea id="cNotes" maxlength="600">' + esc(c.notes || '') + '</textarea></div></div>' +
      '<div id="cErr"></div><button class="btn block" id="cSave" style="margin-top:14px">Save</button>',
      function (root) {
        $('#cSave', root).onclick = function () {
          var body = { name: $('#cName', root).value, contactName: $('#cContact', root).value, email: $('#cEmail', root).value, phone: $('#cPhone', root).value, notes: $('#cNotes', root).value };
          api(c.id ? 'PUT' : 'POST', 'api/clients' + (c.id ? '/' + c.id : ''), body).then(function (r) {
            closeSheet(); toast('Saved.'); location.hash = '#/client/' + r.id; route();
          }).catch(function (e) { showError(e, $('#cErr', root)); });
        };
      });
  }

  function renderClient(id) {
    loading();
    var get = signedIn() ? api('GET', 'api/clients/' + id) : loadDemo().then(function (d) {
      var c = d.clients.filter(function (x) { return x.id === id; })[0];
      if (!c) { var e = new Error('Sign in to see your clients.'); e.status = 401; throw e; }
      return Object.assign({ demo: true, rows: d.invoices.filter(function (i) { return i.client.id === id; }) }, c);
    });
    get.then(function (c) {
      var demo = Boolean(c.demo);
      var h = (demo ? sampleBar('A sample scorecard. Invented client, real maths.') : '') + backLink('#/clients', 'Clients');
      h += '<div class="dk-2"><div>';
      h += '<div class="card"><div class="row" style="gap:16px">' + gradeBox(c, true) + '<div class="grow"><h1 style="font-size:24px" class="ellip">' + esc(c.name) + '</h1>' +
        '<div class="small muted">' + esc([c.contactName, c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details yet') + '</div>' +
        (c.points != null ? '<div class="small faint" style="margin-top:4px">' + esc(c.points) + ' / 100 reliability points</div>' : '') + '</div></div></div>';
      h += '<div class="card style-note"><span class="e">🧭</span><div><div class="eyebrow">The chase style that works</div><p style="margin:4px 0 0">' + esc(c.style) + '</p></div></div>';
      h += '<div class="card"><div class="stats">' +
        '<div class="stat"><b>' + (c.avgDaysLate == null ? '—' : esc(c.avgDaysLate)) + '</b><span>Avg days late</span></div>' +
        '<div class="stat"><b>' + (c.onTimePct == null ? '—' : c.onTimePct + '%') + '</b><span>Paid on time</span></div>' +
        '<div class="stat"><b>' + esc(moneyShort(c.totalPaidCents, c.currency)) + '</b><span>Total paid</span></div>' +
        '<div class="stat"><b>' + esc(moneyShort(c.outstandingCents, c.currency)) + '</b><span>Outstanding</span></div>' +
        '<div class="stat"><b>' + c.brokenPromises + '</b><span>Broken promises</span></div>' +
        '<div class="stat"><b>' + c.writtenOff + '</b><span>Written off</span></div>' +
        '</div></div>';
      h += '</div><div class="dk-sticky">';
      h += '<div class="btn-row">' + (demo ? '' : '<a class="btn" href="#/statement/' + esc(c.id) + '">Statement</a><button class="btn ghost" id="newInv">+ Invoice</button>') + '</div>';
      h += '<div class="section-title" style="margin-top:' + (demo ? '0' : '18px') + '"><h2>Invoices</h2><span class="count">' + c.rows.length + '</span></div>';
      h += c.rows.length ? '<div class="group">' + c.rows.map(function (r) { return miniRow(r); }).join('') + '</div>' : '<p class="muted small">No invoices yet.</p>';
      if (!demo) h += '<div class="more-actions" style="margin-top:14px"><button class="btn small ghost" id="editC">Edit client</button><button class="btn small danger" id="delC">Delete</button></div>';
      h += '</div></div>';
      view.innerHTML = h;
      wireSignup(view);
      var ni = $('#newInv'); if (ni) ni.onclick = function () { state.prefillClient = c.name; state.snapped = null; location.hash = '#/add'; };
      var ec = $('#editC'); if (ec) ec.onclick = function () { openClientSheet(c); };
      var dc = $('#delC'); if (dc) dc.onclick = function () {
        if (!confirm('Delete ' + c.name + '?')) return;
        api('DELETE', 'api/clients/' + c.id).then(function () { toast('Deleted.'); location.hash = '#/clients'; }).catch(function (e) { showError(e); });
      };
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- statements ---------------- */

  function statementDoc(st, opts) {
    opts = opts || {};
    var h = '<article class="doc">' +
      '<div class="doc-head"><div><div class="biz">' + esc(st.business.name || 'Statement') + '</div>' + (st.business.contact ? '<div class="m">' + esc(st.business.contact) + '</div>' : '') + '</div>' +
      '<div class="doc-title"><h1>Statement of account</h1><div class="m">As of ' + esc(fmtDay(st.asOf, { year: 'numeric' })) + '</div></div></div>' +
      '<div class="to"><div><div class="m">To</div><b>' + esc(st.client.name) + '</b>' + (st.client.contactName ? '<div class="m">Attn: ' + esc(st.client.contactName) + '</div>' : '') + '</div></div>';
    if (!st.groups.length) {
      h += '<p>Nothing is owed. Thank you!</p>';
    }
    st.groups.forEach(function (g) {
      var cur = g.currency;
      h += '<h4>Open invoices' + (st.groups.length > 1 ? ' · ' + esc(cur) : '') + '</h4>';
      h += g.invoices.length ? '<div class="scroll"><table class="tbl"><thead><tr><th>Invoice</th><th class="opt">Issued</th><th>Due</th><th class="r opt">Amount</th><th class="r opt">Paid</th><th class="r">Balance</th></tr></thead><tbody>' +
        g.invoices.map(function (i) {
          return '<tr><td>' + esc(i.number) + '</td><td class="opt">' + esc(fmtDay(i.issued)) + '</td><td>' + esc(fmtDay(i.due)) + (i.daysLate ? '<div class="late">' + i.daysLate + ' days overdue</div>' : '') + '</td>' +
            '<td class="r opt">' + money(i.amountCents, cur) + '</td><td class="r opt">' + (i.paidCents ? money(i.paidCents, cur) : '—') + '</td><td class="r"><b>' + money(i.balanceCents, cur) + '</b></td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="m">No open invoices.</p>';
      if (g.payments.length) {
        h += '<h4>Payments received</h4><table class="tbl"><tbody>' + g.payments.map(function (p) {
          return '<tr><td>' + esc(fmtDay(p.date, { year: 'numeric' })) + '</td><td>' + esc(p.number) + '</td><td class="r">' + money(p.cents, cur) + '</td></tr>';
        }).join('') + '</tbody></table>';
      }
      h += '<div class="total"><span>Balance due' + (g.overdueCents ? '<div class="m">' + money(g.overdueCents, cur) + ' of it overdue</div>' : '') + '</span><b>' + money(g.balanceCents, cur) + '</b></div>';
    });
    if (st.business.paymentLink || st.business.paymentInstructions) {
      h += '<div class="pay"><h4 style="margin-top:0">How to pay</h4>' +
        (st.business.paymentLink ? '<div><a href="' + esc(st.business.paymentLink) + '" rel="noopener noreferrer" target="_blank">' + esc(st.business.paymentLink) + '</a></div>' : '') +
        (st.business.paymentInstructions ? '<div style="white-space:pre-line">' + esc(st.business.paymentInstructions) + '</div>' : '') + '</div>';
    }
    h += '<div class="foot">' + (opts.shared ? 'A read-only copy, frozen on ' + esc(fmtDay(st.asOf, { year: 'numeric' })) + '. Payments made since may not show — ask ' + esc(st.business.name || 'the sender') + ' for a fresh link.' : 'Thank you for your business.') + '</div>';
    return h + '</article>';
  }

  function renderStatement(id) {
    if (!signedIn()) return pitch('🧾', 'Statements of account', 'One clean page per client — every open invoice, every payment, the balance. Print it, or send a link that needs no account.');
    loading();
    api('GET', 'api/clients/' + id + '/statement').then(function (st) {
      function shareHtml() {
        if (!st.share) {
          return '<div class="card no-print"><div class="card-head"><h3>Share a link</h3></div><p class="small muted" style="margin:0 0 12px">A frozen, read-only copy of this page. Your client needs no account; nothing else in your book is visible through it. Revoke it and the link dies.</p><button class="btn" id="mkShare">Create share link</button></div>';
        }
        var url = location.origin + BASE + st.share.url;
        return '<div class="card no-print"><div class="card-head"><h3>Share link</h3><span class="sub">copy of ' + esc(fmtDay((st.share.sharedAt || '').slice(0, 10))) + '</span></div>' +
          '<div class="share-box"><input class="input" id="shareUrl" readonly value="' + esc(url) + '"><button class="btn small" id="cpShare">Copy</button></div>' +
          '<div class="more-actions"><button class="btn small ghost" id="upShare">Update the copy</button><a class="btn small ghost" href="' + esc(BASE + st.share.url) + '" target="_blank" rel="noopener">Open</a><button class="btn small danger" id="rvShare">Revoke</button></div>' +
          '<p class="small muted" style="margin:10px 0 0">The link shows the statement as it was when you last updated it — logging a payment does not change it until you tap Update.</p></div>';
      }
      function draw() {
        view.innerHTML = backLink('#/client/' + esc(id), st.client.name) +
          '<div class="row spread no-print" style="margin-bottom:12px"><h1 style="font-size:26px">Statement</h1><button class="btn small ghost" id="printBtn">' + ICON.print + 'Print</button></div>' +
          '<div class="dk-2"><div>' + statementDoc(st) + '</div><div class="dk-sticky">' + shareHtml() + '</div></div>';
        $('#printBtn').onclick = function () { window.print(); };
        var mk = $('#mkShare'); if (mk) mk.onclick = function () { share(); };
        var up = $('#upShare'); if (up) up.onclick = function () { share('Updated — the link now shows today’s statement.'); };
        var cp = $('#cpShare'); if (cp) cp.onclick = function () {
          var inp = $('#shareUrl'); inp.select();
          (navigator.clipboard ? navigator.clipboard.writeText(inp.value) : Promise.reject()).then(function () { toast('Link copied.'); }, function () { toast('Select the link and copy it.'); });
        };
        var rv = $('#rvShare'); if (rv) rv.onclick = function () {
          if (!confirm('Revoke this link? Anyone who has it will see “not valid”.')) return;
          api('DELETE', 'api/clients/' + id + '/share').then(function () { st.share = null; toast('Revoked.'); draw(); }).catch(function (e) { showError(e); });
        };
      }
      function share(msg) {
        api('POST', 'api/clients/' + id + '/share').then(function (r) { st.share = r; toast(msg || 'Link ready — copy it into a message.'); draw(); }).catch(function (e) { showError(e); });
      }
      draw();
    }).catch(function (e) { showError(e, view); });
  }

  function renderShared(token) {
    document.body.classList.add('public');
    document.body.classList.remove('dk');
    loading();
    api('GET', 'api/shared/' + token).then(function (st) {
      document.title = 'Statement · ' + (st.business.name || 'Chaser');
      view.innerHTML = (st.preview ? '<div class="banner no-print" style="margin-bottom:12px"><span class="e">👀</span><span>This is what your client sees. It is a frozen copy — update it from the statement page.</span></div>' : '') +
        '<div class="row spread no-print" style="margin-bottom:12px"><span class="small muted">Shared statement</span><button class="btn small ghost" id="printBtn">' + ICON.print + 'Print</button></div>' +
        statementDoc(st, { shared: true }) +
        '<p class="center small faint no-print" style="margin-top:18px">Sent with Chaser 💸</p>';
      $('#printBtn').onclick = function () { window.print(); };
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><div class="e">🔒</div><h2>This link isn’t valid</h2><p>' + esc(e.message) + ' Ask the sender for a fresh one.</p></div>';
    });
  }

  /* ---------------- wins ---------------- */

  function renderWins() {
    loading();
    var get = signedIn() ? api('GET', 'api/wins') : loadDemo().then(function (d) {
      return { demo: true, currency: 'USD', streakWeeks: d.today.streakWeeks, collectedMonthCents: d.today.totals.collectedMonthCents, collectedCents: null, paidCount: d.invoices.filter(function (i) { return i.status === 'paid'; }).length, chasesSent: d.invoices.reduce(function (a, i) { return a + i.chases.length; }, 0), hardest: null, badges: d.badges.map(function (b) { return Object.assign({}, b, { earnedAt: b.earned ? d.today.today : null }); }) };
    });
    get.then(function (w) {
      var earned = w.badges.filter(function (b) { return b.earnedAt; }).length;
      view.innerHTML = (w.demo ? sampleBar() : '') +
        '<div class="page-head"><div><h1>Wins</h1><div class="sub">Getting paid is the job. Celebrate it.</div></div></div>' +
        '<div class="dk-2"><div>' +
        '<div class="card streak-card"><span class="flame" aria-hidden="true">' + (w.streakWeeks ? '🔥' : '🌱') + '</span><div><b>' + w.streakWeeks + '</b> <span class="muted">week' + (w.streakWeeks === 1 ? '' : 's') + '</span><div class="small muted">' +
        (w.streakWeeks ? 'Money in every week, ' + w.streakWeeks + ' in a row. Log this week’s to keep it.' : 'Log a payment this week to start a collecting streak.') + '</div></div></div>' +
        '<div class="kpis" style="margin-top:12px">' +
        '<div class="kpi good"><b>' + esc(moneyShort(w.collectedMonthCents, w.currency)) + '</b><span>In this month</span></div>' +
        '<div class="kpi"><b>' + w.paidCount + '</b><span>Paid in full</span></div>' +
        '<div class="kpi"><b>' + w.chasesSent + '</b><span>Chases sent</span></div></div>' +
        (w.hardest ? '<a class="card row" href="#/invoice/' + esc(w.hardest.id) + '" style="text-decoration:none;color:inherit;margin-top:12px"><span style="font-size:28px">🧗</span><div class="grow"><b>Hardest-won: ' + money(w.hardest.cents, w.currency) + '</b><div class="small muted">' + esc(w.hardest.number) + ' — collected ' + w.hardest.daysLate + ' days late</div></div></a>' : '') +
        '</div><div>' +
        '<div class="section-title" style="margin-top:4px"><h2>Badges</h2><span class="count">' + earned + ' of ' + w.badges.length + '</span></div>' +
        '<div class="badges">' + w.badges.map(function (b) {
          return '<div class="badge ' + (b.earnedAt ? 'earned' : 'locked') + '"><span class="e" aria-hidden="true">' + esc(b.emoji) + '</span><b>' + esc(b.label) + '</b><span>' + esc(b.desc) + '</span>' +
            (b.earnedAt ? '<div class="tiny faint" style="margin-top:6px">' + (w.demo ? 'Earned' : 'Earned ' + esc(fmtDay(b.earnedAt))) + '</div>' : '') + '</div>';
        }).join('') + '</div></div></div>';
      wireSignup(view);
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- settings: your voice ---------------- */

  function tonePreview(t) {
    if (t < 40) return '“Hope all is well! Just a friendly reminder that invoice INV-1042 for $1,200 was due on the 3rd. It may simply have slipped through…”';
    if (t < 70) return '“A quick reminder that invoice INV-1042 for $1,200 was due on the 3rd and I haven’t seen payment yet.”';
    return '“Invoice INV-1042 for $1,200 was due on the 3rd and is now 21 days overdue. Please arrange payment this week.”';
  }

  function renderSettings() {
    if (!signedIn()) return pitch('🎙️', 'Chases in your own voice', 'Your name, your sign-off, how direct you like to be, and how clients pay you. Every draft uses them.');
    loading();
    api('GET', 'api/settings').then(function (s) {
      var lf = Object.assign({ mode: 'none', flatCents: 2500, pctPerMonth: 1.5, graceDays: 7 }, s.lateFee || {});
      view.innerHTML =
        '<div class="page-head"><div><h1>Your voice</h1><div class="sub">Every chase — written for you or from a template — uses these.</div></div></div>' +
        '<div class="dk-2"><div>' +
        '<div class="group-title">You</div><div class="group">' +
        '<div class="cell"><label for="sBiz">Business</label><input id="sBiz" value="' + esc(s.businessName) + '" maxlength="80" placeholder="Northlight Studio"></div>' +
        '<div class="cell"><label for="sName">Your name</label><input id="sName" value="' + esc(s.yourName) + '" maxlength="60" placeholder="Maya"></div>' +
        '<div class="cell"><label for="sSign">Sign-off</label><input id="sSign" value="' + esc(s.signOff) + '" maxlength="60" placeholder="Thanks,"></div>' +
        '<div class="cell"><label for="sContact">On statements</label><input id="sContact" value="' + esc(s.contact) + '" maxlength="120" placeholder="Email or phone clients can reach"></div></div>' +
        '<p class="hint">Statements show your business name and this contact line — nothing else about you.</p>' +
        '<div class="group-title">Tone</div><div class="group"><div class="cell stack">' +
        '<div class="row spread small"><span>Friendly</span><span>Direct</span></div>' +
        '<input type="range" id="sTone" min="0" max="100" step="5" value="' + esc(s.tone) + '" aria-label="Tone, friendly to direct">' +
        '<p class="small muted" id="tonePrev" style="margin:4px 0 0">' + esc(tonePreview(s.tone)) + '</p></div></div>' +
        '<div class="group-title">How clients pay you</div><div class="group">' +
        '<div class="cell"><label for="sLink">Payment link</label><input id="sLink" type="url" inputmode="url" value="' + esc(s.paymentLink) + '" placeholder="https://…"></div>' +
        '<div class="cell stack"><label for="sInstr">Instructions</label><textarea id="sInstr" maxlength="400" placeholder="Bank transfer to …, or cheque payable to …">' + esc(s.paymentInstructions) + '</textarea></div></div>' +
        '<p class="hint">Links must be https. Both go into every chase and every statement.</p>' +
        '</div><div>' +
        '<div class="group-title">Defaults</div><div class="group">' +
        '<div class="cell"><label for="sCur">Currency</label><select id="sCur">' + currencyOptions(s.currency) + '</select></div>' +
        '<div class="cell"><label for="sTerms">Terms (days)</label><input id="sTerms" inputmode="numeric" value="' + esc(s.termsDays) + '"></div></div>' +
        '<div class="group-title">Late fees</div><div class="group"><div class="cell stack">' +
        '<div class="seg" id="lfMode"><button data-m="none">None</button><button data-m="flat">Flat fee</button><button data-m="percent">% a month</button></div></div>' +
        '<div class="cell lf-flat"><label for="lfFlat">Fee</label><input id="lfFlat" inputmode="decimal" value="' + esc((lf.flatCents / 100).toFixed(2)) + '"></div>' +
        '<div class="cell lf-pct"><label for="lfPct">% per month</label><input id="lfPct" inputmode="decimal" value="' + esc(lf.pctPerMonth) + '"></div>' +
        '<div class="cell lf-any"><label for="lfGrace">Grace days</label><input id="lfGrace" inputmode="numeric" value="' + esc(lf.graceDays) + '"></div>' +
        '<div class="cell lf-any stack"><p class="small muted" id="lfEx" style="margin:0"></p></div></div>' +
        '<p class="hint">Chaser only ever <b>shows</b> the fee and, if you tick it, mentions it in a chase. It never adds it to a balance or a statement. Check what your contract and local law allow.</p>' +
        '<div id="sErr"></div><button class="btn block lg" id="sSave" style="margin-top:18px">Save</button>' +
        '</div></div>';
      var mode = lf.mode;
      function drawMode() {
        $$('#lfMode button').forEach(function (b) { b.classList.toggle('on', b.dataset.m === mode); });
        $$('.lf-flat').forEach(function (e) { e.classList.toggle('hidden', mode !== 'flat'); });
        $$('.lf-pct').forEach(function (e) { e.classList.toggle('hidden', mode !== 'percent'); });
        $$('.lf-any').forEach(function (e) { e.classList.toggle('hidden', mode === 'none'); });
        var grace = Math.max(0, Number($('#lfGrace').value) || 0);
        var ex = '';
        if (mode === 'flat') ex = 'On an invoice 30 days late: ' + (30 > grace ? money(Math.round((Number($('#lfFlat').value) || 0) * 100), $('#sCur').value) : 'nothing (still in grace)') + '.';
        if (mode === 'percent') ex = 'On $1,000, 30 days late: ' + money(Math.round(100000 * (Number($('#lfPct').value) || 0) / 100 * Math.max(0, 30 - grace) / 30), 'USD') + ' (pro rata after the grace days).';
        $('#lfEx').textContent = ex;
      }
      $$('#lfMode button').forEach(function (b) { b.onclick = function () { mode = b.dataset.m; drawMode(); }; });
      ['#lfFlat', '#lfPct', '#lfGrace'].forEach(function (s2) { $(s2).oninput = drawMode; });
      drawMode();
      $('#sTone').oninput = function () { $('#tonePrev').textContent = tonePreview(Number(this.value)); };
      $('#sSave').onclick = function () {
        var btn = this; btn.disabled = true;
        api('PUT', 'api/settings', {
          businessName: $('#sBiz').value, yourName: $('#sName').value, signOff: $('#sSign').value, contact: $('#sContact').value,
          tone: Number($('#sTone').value), paymentLink: $('#sLink').value, paymentInstructions: $('#sInstr').value,
          currency: $('#sCur').value, termsDays: $('#sTerms').value,
          lateFee: { mode: mode, flat: $('#lfFlat').value, pctPerMonth: $('#lfPct').value, graceDays: $('#lfGrace').value },
        }).then(function (r) {
          btn.disabled = false;
          if ($('#sLink').value.trim() && !r.paymentLink) { showError(new Error('That payment link was not saved — it must start with https://'), $('#sErr')); return; }
          state.me.settings = r; drawTop();
          toast('Saved. Your chases will sound like you.');
          location.hash = '#/';
        }).catch(function (e) { btn.disabled = false; showError(e, $('#sErr')); });
      };
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- start ---------------- */

  if (PUB) { route(); return; }
  loadMe().then(route);
})();
