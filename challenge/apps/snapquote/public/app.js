/* Snapquote - the page. One file, no build step, every model-written string escaped. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');

  // Where the app is mounted: '/' on its own, '/snapquote/' inside the lab. The
  // customer page lives one level down (q/<token>) with <base href="../">, so
  // the base is read from the document's base URI rather than the path.
  var BASE = new URL('.', document.baseURI).pathname;
  var PUB = location.pathname.match(/\/q\/([A-Za-z0-9_-]{16,40})\/?$/);

  var state = { me: null, meta: null, templates: null, nf: null, justDrafted: null };

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

  var fmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  var fmt0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) { return fmt2.format(Number(n) || 0); }
  function money0(n) { return fmt0.format(Math.round(Number(n) || 0)); }
  function moneyShort(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return '$' + (n / 1e3).toFixed(0) + 'k';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return money0(n);
  }
  function dateFmt(iso, opts) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function timeAgo(iso) {
    if (!iso) return '';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return dateFmt(iso, { month: 'short', day: 'numeric' });
  }
  function durationFmt(min) {
    if (min == null) return '—';
    if (min < 60) return Math.max(1, Math.round(min)) + ' min';
    if (min < 60 * 48) return (min / 60).toFixed(min < 600 ? 1 : 0).replace(/\.0$/, '') + ' hr';
    return Math.round(min / 1440) + ' days';
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
  }
  /** Readable ink on a brand color. */
  function inkFor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    var n = parseInt(m[1], 16);
    var ch = [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    var L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    return L > 0.45 ? '#10181a' : '#ffffff';
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function confetti(colors) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var box = document.createElement('div');
    box.className = 'confetti';
    colors = colors || ['#16c79a', '#0fa3c4', '#ffd166', '#6f7ff0', '#ff8a5b', '#34d399'];
    for (var i = 0; i < 80; i++) {
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

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/></svg>',
    cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9zM5 15l.7 1.8 1.8.7-1.8.7L5 20l-.7-1.8L2.5 17.5l1.8-.7z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  };

  /* ---------------- money, the same rules as lib/quote.js ---------------- */

  // The editor recomputes as you type. The server recomputes again on save and
  // its answer is the one that is stored; this copy exists so the number under
  // your thumb moves with it.
  function cents(n) { return Math.round(n * 100) / 100; }
  function numIn(v, hi) { var n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); if (!isFinite(n)) n = 0; return Math.max(0, Math.min(hi || 1e7, n)); }
  function priceLine(it, markupPct) {
    var m = numIn(markupPct, 1000) / 100;
    var marked = it.category !== 'labor';
    var unit = marked ? cents(numIn(it.unitPrice) * (1 + m)) : numIn(it.unitPrice);
    return { cost: cents(numIn(it.qty) * numIn(it.unitPrice)), unit: unit, price: cents(numIn(it.qty) * unit), marked: marked };
  }
  function totalsFor(items, q) {
    var cost = 0, sub = 0;
    (items || []).forEach(function (it) { var l = priceLine(it, q.markupPct); cost += l.cost; sub += l.price; });
    cost = cents(cost); sub = cents(sub);
    var disc = cents(Math.min(numIn(q.discount), sub));
    var taxable = cents(sub - disc);
    var tax = cents(taxable * numIn(q.taxPct, 100) / 100);
    return { cost: cost, subtotal: sub, discount: disc, tax: tax, total: cents(taxable + tax), margin: cents(taxable - cost) };
  }
  function computeTotals(q) {
    if (q.tiers && q.tiers.length) {
      var t = {};
      q.tiers.forEach(function (tier) { t[tier.key] = totalsFor((q.items || []).concat(tier.items || []), q); });
      return { tiers: t };
    }
    return { single: totalsFor(q.items, q) };
  }
  function headline(q) {
    var t = computeTotals(q);
    if (t.tiers) { var k = t.tiers.better ? 'better' : q.tiers[0].key; return t.tiers[k]; }
    return t.single;
  }

  var STATUS = {
    draft: 'Draft', sent: 'Sent', viewed: 'Viewed', changes: 'Changes asked', accepted: 'Won', declined: 'Declined', expired: 'Expired',
  };
  function statusChip(s) { return '<span class="status st-' + esc(s) + '">' + esc(STATUS[s] || s) + '</span>'; }

  /* ---------------- data ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function loadMeta() {
    if (state.meta) return Promise.resolve(state.meta);
    return api('GET', 'api/meta').then(function (m) { state.meta = m; return m; });
  }
  function signedIn() { return state.me && state.me.signedIn; }
  function profile() { return (state.me && state.me.profile) || {}; }
  // Passkeys are bound to the shared domain; on a staging *.run.app host they
  // cannot work, so the buttons are not offered there.
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }

  function logoHtml(p) {
    return esc(p.logo || initials(p.name || (state.me && state.me.email) || 'S'));
  }

  function drawTop() {
    var el = $('#topRight');
    var me = state.me;
    if (!me || !me.signedIn) {
      el.innerHTML = '<button class="btn small" id="signInTop">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var b = me.budget || {};
    var p = me.profile || {};
    el.innerHTML =
      '<span class="pill credit" title="AI credit">' + (b.unlimited ? '∞' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span>' +
      '<button class="avatar-btn" id="acctBtn" aria-label="Account" style="--brand:' + esc(p.color || '') + ';color:' + inkFor(p.color) + '">' + logoHtml(p) + '</button>';
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
        '<h2>' + (mode === 'register' ? 'Quote first. Win more.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Free account with $2 of AI credit — enough for roughly 100 drafted quotes. One account works across every app on this site.'
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
      if (!profile().setUp) {
        location.hash = '#/business';
        toast('Set up your business first — 30 seconds, and every quote wears it.', 3800);
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
      '<div class="row spread"><h2>' + esc(profile().name || 'Your account') + '</h2></div>' +
      '<p class="muted small">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'Member model (Sonnet)' : 'Free model (Haiku)') + '</p>' +
      '<div class="card" style="margin:14px 0"><div class="row spread"><b>AI credit</b><span class="num">' + remaining + '</span></div>' +
      '<div class="bar" style="margin-top:10px"><i style="width:' + pct + '%"></i></div>' +
      '<p class="small muted" style="margin:10px 0 0">Drafting a quote from photos costs about 1–2¢. Polishing and follow-ups well under a cent. Editing, sending, templates and the customer page are free.</p>' +
      '<div id="billing" style="margin-top:12px"></div></div>' +
      '<a class="btn ghost block" href="#/business" id="bizLink">Business profile</a>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" style="margin-top:10px">Sign out</button>',
      function (root) {
        $('#bizLink', root).onclick = function () { closeSheet(); };
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.templates = null; drawTop(); location.hash = '#/'; route(); });
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
    sheet('<h2>Out of credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p>' +
      '<p class="muted small">Everything that is not a model call keeps working: editing, sending, templates, your pipeline and the customer page. You can still build a quote by hand.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- routing ---------------- */

  var leaving = null; // a view's "before you go" hook - the editor saves on the way out
  function route() {
    if (leaving) { try { leaving(); } catch (e) { /* never block navigation */ } leaving = null; }
    closeSheet();
    stopListening();
    if (PUB) return renderPublic(PUB[1]);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var tab = parts[0] || 'quotes';
    $$('#tabbar button').forEach(function (b) {
      var t = b.dataset.tab;
      b.classList.toggle('on', t === tab || (t === 'quotes' && (tab === 'quote' || tab === 'sample')));
    });
    window.scrollTo(0, 0);
    if (tab === 'quote' && parts[1]) return renderEditor(parts[1]);
    if (tab === 'sample') return renderSample();
    if (tab === 'new') return renderNew();
    if (tab === 'stats') return renderStats();
    if (tab === 'business') return renderBusiness();
    return signedIn() ? renderPipeline() : renderHome();
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () { location.hash = '#/' + b.dataset.tab; };
  });
  window.addEventListener('hashchange', route);

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner"></span></div>'; }

  function signedOutPitch(emoji, title, body) {
    view.innerHTML = '<div class="empty"><div class="e">' + emoji + '</div><h2>' + esc(title) + '</h2><p>' + esc(body) + '</p>' +
      '<div class="row" style="justify-content:center;flex-wrap:wrap"><button class="btn" id="pitchGo">Start free</button><a class="btn ghost" href="#/sample">See a sample quote</a></div></div>';
    $('#pitchGo').onclick = function () { openAccount(); };
  }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    api('GET', 'api/demo').then(function (d) {
      var tier = (d.tiers || []).filter(function (t) { return t.key === 'better'; })[0];
      var lines = d.items.slice(0, 3).concat(tier ? tier.items.slice(0, 1) : []);
      var total = tier ? tier.totals.total : d.totals.total;
      var b = d.business;
      var trades = state.meta ? Object.keys(state.meta.trades).filter(function (k) { return k !== 'other'; }).map(function (k) {
        var t = state.meta.trades[k]; return '<span>' + t.emoji + ' ' + esc(t.label) + '</span>';
      }).join('') : '';
      view.innerHTML =
        '<section class="hero"><div class="hero-grid"><div>' +
        '<span class="kicker">⚡ The first quote in usually wins</span>' +
        '<h1>Snap the job.<br>Say what you see.<br><em>Send the quote.</em></h1>' +
        '<p>Take a few photos, talk it through on site, and Snapquote writes an itemized, branded quote with your rates, markup and tax — before you’re back in the truck. Your customer signs it from their phone.</p>' +
        '<div class="ctas"><button class="btn lg" id="heroGo">Try it free</button><a class="btn lg ghost" href="#/sample">See a sample quote</a></div>' +
        '<div class="trust"><span>✓ $2 free credit</span><span>✓ No card</span><span>✓ Photos never stored</span></div>' +
        '</div>' +
        '<div class="mini-quote" style="--b:' + esc(b.color) + '"><div class="mq-head" style="color:' + inkFor(b.color) + '"><div class="mq-logo">' + esc(b.logo) + '</div><div><b>' + esc(b.name) + '</b><div class="small" style="opacity:.85">' + esc(d.number) + ' · ' + esc(d.title) + '</div></div></div>' +
        '<div class="mq-stamp">ACCEPTED</div>' +
        '<div class="mq-body">' + lines.map(function (l) { return '<div class="mq-line"><span>' + esc(l.description) + '</span><b class="num">' + money0(l.price) + '</b></div>'; }).join('') +
        '<div class="mq-total"><small>Total · ' + esc(tier ? tier.label : '') + '</small><span class="num">' + money(total) + '</span></div>' +
        '<a class="mq-accept" href="#/sample" style="color:' + inkFor(b.color) + '">Accept quote</a></div></div>' +
        '</div></section>' +
        '<div class="steps">' +
        '<div class="step"><div class="ic">📸</div><h3>Snap</h3><p>Up to four photos of the job. We shrink them on your phone, read them once, and never keep them.</p></div>' +
        '<div class="step"><div class="ic">🎙️</div><h3>Say it</h3><p>Dictate like you’d brief a helper: rooms, sizes, condition, what they want. Good / Better / Best if you like.</p></div>' +
        '<div class="step"><div class="ic">✅</div><h3>Send &amp; get signed</h3><p>Tweak any line, then text a branded link. They pick an option and sign. You see when they open it.</p></div>' +
        '</div>' +
        '<div class="section-title" style="justify-content:center"><h2>Built for the trades</h2></div><div class="trades">' + trades + '</div>' +
        '<div class="cta-band"><h2>Your next quote, in about a minute.</h2><p>Every quote tracked on a pipeline, with a win-rate scoreboard and a weekly streak to keep you quick.</p>' +
        '<button class="btn lg" id="bandGo">Create a free account</button></div>';
      $('#heroGo').onclick = function () { openAccount(); };
      $('#bandGo').onclick = function () { openAccount(); };
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- the customer's quote (and the sample) ---------------- */

  var CAT_ORDER = ['labor', 'material', 'equipment', 'other'];
  var CATS = { labor: { label: 'Labor', emoji: '🛠️' }, material: { label: 'Materials', emoji: '🧱' }, equipment: { label: 'Equipment', emoji: '🚜' }, other: { label: 'Other', emoji: '📎' } };

  /**
   * Draw a public quote into `root`. The same function draws a customer's
   * link, the owner's preview and the signed-out sample, so the sample cannot
   * drift from what a customer actually receives.
   *
   * opts: { token, demo, preview }
   */
  function drawDoc(root, p, opts) {
    opts = opts || {};
    if (p.tiers && !p._sel) p._sel = (p.response && p.response.tier) || p.recommended || p.tiers[0].key;
    var tier = p.tiers ? p.tiers.filter(function (t) { return t.key === p._sel; })[0] : null;
    var totals = tier ? tier.totals : p.totals;
    var b = p.business;
    var ink = inkFor(b.color);
    var lines = (p.items || []).map(function (l) { return { l: l, isNew: false }; })
      .concat(tier ? tier.items.map(function (l) { return { l: l, isNew: true }; }) : []);

    var h = '<article class="qdoc" style="--brand:' + esc(b.color) + ';--brand-ink:' + ink + '">' +
      '<header class="qd-head"><div class="qd-biz"><div class="qd-logo">' + esc(b.logo || initials(b.name)) + '</div><div><h2>' + esc(b.name) + '</h2>' +
      '<div class="sub">' + [b.trade, b.license].filter(Boolean).map(esc).join(' · ') + '</div></div></div>' +
      '<div class="qd-contact">' +
      (b.phone ? '<a href="tel:' + esc(b.phone.replace(/[^0-9+]/g, '')) + '">' + ICON.phone + esc(b.phone) + '</a>' : '') +
      (b.email ? '<a href="mailto:' + esc(b.email) + '">' + ICON.mail + esc(b.email) + '</a>' : '') +
      '</div></header>' +
      '<div class="qd-body">' +
      '<div class="qd-meta"><div><span>Quote</span><b>' + esc(p.number || '—') + '</b></div><div><span>Issued</span><b>' + esc(dateFmt(p.issuedAt, { month: 'short', day: 'numeric' }) || '—') + '</b></div>' +
      '<div><span>Valid until</span><b>' + esc(p.validUntil ? dateFmt(p.validUntil, { month: 'short', day: 'numeric' }) : '—') + '</b></div></div>' +
      (p.customer && p.customer.name ? '<div class="qd-for">Prepared for <b>' + esc(p.customer.name) + '</b>' + (p.customer.address ? ' · ' + esc(p.customer.address) : '') + '</div>' : '') +
      '<h1 class="qd-title">' + esc(p.title) + '</h1>' +
      (p.scope ? '<p class="qd-scope">' + esc(p.scope) + '</p>' : '');

    if (p.tiers) {
      h += '<div class="qd-h">Choose your option</div><div class="qd-tiers">' + p.tiers.map(function (t) {
        return '<button class="qd-tier' + (t.key === p._sel ? ' on' : '') + '" data-tier="' + esc(t.key) + '">' +
          (t.key === p.recommended ? '<span class="rec">Most popular</span>' : '') + '<span class="radio"></span>' +
          '<div class="nm">' + esc({ good: 'Good', better: 'Better', best: 'Best' }[t.key] || t.key) + '</div><div class="lb">' + esc(t.label) + '</div>' +
          '<div class="pr">' + money(t.totals && t.totals.total) + '</div><div class="sm">' + esc(t.summary) + '</div></button>';
      }).join('') + '</div>';
    }

    h += '<div class="qd-h">What’s included' + (tier ? ' · ' + esc(tier.label) : '') + '</div>';
    CAT_ORDER.forEach(function (c) {
      var rows = lines.filter(function (x) { return x.l.category === c; });
      if (!rows.length) return;
      var sum = rows.reduce(function (a, x) { return a + x.l.price; }, 0);
      h += '<div class="qd-group"><h4><span>' + CATS[c].emoji + ' ' + CATS[c].label + '</span><span class="num">' + money(sum) + '</span></h4>' + rows.map(function (x) {
        var l = x.l;
        return '<div class="qd-line' + (x.isNew ? ' new' : '') + '"><div class="d">' + esc(l.description) + '</div><div class="a">' + money(l.price) + '</div>' +
          '<div class="q">' + esc(l.qty) + ' ' + esc(l.unit) + ' × ' + money(l.unitPrice) + '</div></div>';
      }).join('') + '</div>';
    });

    if (totals) {
      h += '<div class="qd-totals"><div class="r"><span>Subtotal</span><span>' + money(totals.subtotal) + '</span></div>' +
        (totals.discount ? '<div class="r"><span>Discount</span><span>−' + money(totals.discount) + '</span></div>' : '') +
        (totals.tax ? '<div class="r"><span>Tax (' + esc(p.taxPct) + '%)</span><span>' + money(totals.tax) + '</span></div>' : '') +
        '<div class="r t"><span>Total</span>' + money(totals.total) + '</div></div>';
    }

    var boxes = '';
    if (p.timeline) boxes += '<div class="qd-box"><h5>🗓️ Timeline</h5><p>' + esc(p.timeline) + '</p></div>';
    if (p.terms) boxes += '<div class="qd-box"><h5>💳 Payment terms</h5><p>' + esc(p.terms) + '</p></div>';
    if ((p.assumptions || []).length) boxes += '<div class="qd-box"><h5>📐 Assumptions</h5><ul>' + p.assumptions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    if ((p.exclusions || []).length) boxes += '<div class="qd-box"><h5>🚫 Not included</h5><ul>' + p.exclusions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    if (boxes) h += '<div class="qd-cols">' + boxes + '</div>';

    h += '<div id="respond">' + respondHtml(p, opts, totals, tier) + '</div>';
    h += '</div><div class="qd-foot">Sent with <a href="' + esc(BASE) + '" target="_blank" rel="noopener">Snapquote</a> · Quote ' + esc(p.number || '') + '</div></article>';
    root.innerHTML = h;
    wireDoc(root, p, opts);
  }

  function respondHtml(p, opts, totals, tier) {
    var b = p.business;
    var r = p.response;
    if (p.status === 'accepted' && r) {
      var tl = r.tier && p.tiers ? (p.tiers.filter(function (t) { return t.key === r.tier; })[0] || {}).label : null;
      return '<div class="qd-stamp"><div class="ok">✓</div><h3>Accepted</h3><div class="sig">' + esc(r.name) + '</div>' +
        '<div class="small muted">' + esc(dateFmt(r.at, { month: 'long', day: 'numeric', year: 'numeric' })) + (tl ? ' · ' + esc(tl) : '') + '</div>' +
        '<p class="small muted" style="margin:10px 0 0">' + esc(b.name) + ' can see your acceptance and will be in touch to schedule.</p></div>';
    }
    if (p.status === 'declined') {
      return '<div class="qd-stamp off"><div class="ok">–</div><h3>Declined</h3><p class="small muted" style="margin:6px 0 0">Changed your mind? Get in touch with ' + esc(b.name) + '.</p></div>';
    }
    if (p.status === 'expired') {
      return '<div class="qd-stamp off"><div class="ok">⏱</div><h3>This quote has expired</h3><p class="small muted" style="margin:6px 0 0">It was valid until ' + esc(dateFmt(p.validUntil)) + '. Prices may have changed — ask ' + esc(b.name) + ' for an updated one.</p></div>';
    }
    var who = opts.preview ? '<div class="banner" style="margin-bottom:12px"><span class="e">👀</span><div>This is your preview — exactly what your customer sees. They accept or ask for changes here.</div></div>' : '';
    var asked = p.status === 'changes' ? '<div class="banner warn" style="margin-bottom:12px"><span class="e">✏️</span><div>You asked for changes. ' + esc(b.name) + ' will send an update — or you can accept this version now.</div></div>' : '';
    return '<div class="qd-respond">' + who + asked + '<h3>Ready to go ahead?</h3>' +
      '<p class="small muted" style="margin:6px 0 14px">' + (p.tiers ? 'You’ve chosen <b>' + esc(tier ? tier.label : '') + '</b>. ' : '') + 'Type your full name to sign. By accepting you agree to the scope and terms above.</p>' +
      '<input class="input sig" id="sigName" placeholder="Your full name" autocomplete="name" value="' + esc(p._name || '') + '"' + (opts.preview ? ' disabled' : '') + '>' +
      '<div id="accErr"></div>' +
      '<button class="btn lg block qd-accept" id="acceptBtn" style="margin-top:12px"' + (opts.preview ? ' disabled' : '') + '>Accept · ' + money(totals && totals.total) + '</button>' +
      '<div class="row" style="justify-content:center;gap:18px;margin-top:14px"><button class="link-btn" id="chgBtn">Request changes</button><button class="link-btn" id="decBtn" style="color:var(--faint)">Decline</button></div>' +
      '<div id="chgBox" class="hidden" style="margin-top:12px"><textarea class="input" id="chgText" maxlength="1000" placeholder="What would you like changed? e.g. “Can you add the upstairs hallway?”"></textarea>' +
      '<button class="btn block ghost" id="chgSend" style="margin-top:8px">Send to ' + esc(b.name) + '</button></div></div>';
  }

  function wireDoc(root, p, opts) {
    $$('[data-tier]', root).forEach(function (btn) {
      btn.onclick = function () {
        if (p.status === 'accepted') return;
        var n = $('#sigName', root); if (n) p._name = n.value;
        p._sel = btn.dataset.tier;
        drawDoc(root, p, opts);
      };
    });
    var acc = $('#acceptBtn', root);
    if (!acc || opts.preview) return;
    var post = function (path, body) {
      if (opts.demo) return Promise.reject(Object.assign(new Error('demo'), { demo: true }));
      return api('POST', 'api/public/' + opts.token + '/' + path, body);
    };
    acc.onclick = function () {
      var name = $('#sigName', root).value.trim();
      if (!/\S+\s+\S+/.test(name)) { $('#accErr', root).innerHTML = '<div class="err">Type your full name — first and last — to sign.</div>'; $('#sigName', root).focus(); return; }
      acc.disabled = true; acc.innerHTML = '<span class="spinner"></span>';
      post('accept', { name: name, tier: p._sel || null }).then(function (np) {
        np._sel = p._sel; Object.keys(p).forEach(function (k) { delete p[k]; }); Object.assign(p, np);
        drawDoc(root, p, opts); confetti([p.business.color, '#ffd166', '#34d399', '#6f7ff0']);
        $('#respond', root).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }).catch(function (e) {
        if (e.demo) {
          // The sample shows the moment without pretending it happened.
          p.status = 'accepted'; p.response = { kind: 'accepted', name: name, tier: p._sel || null, at: new Date().toISOString() };
          drawDoc(root, p, opts); confetti([p.business.color, '#ffd166', '#34d399', '#6f7ff0']);
          toast('That’s the moment. On a real quote, it lands on the pro’s pipeline as won.', 3600);
          return;
        }
        acc.disabled = false; acc.textContent = 'Accept';
        showError(e, $('#accErr', root));
      });
    };
    $('#chgBtn', root).onclick = function () { $('#chgBox', root).classList.toggle('hidden'); $('#chgText', root).focus(); };
    $('#chgSend', root).onclick = function () {
      var t = $('#chgText', root).value.trim();
      if (t.length < 3) return $('#chgText', root).focus();
      post('changes', { message: t }).then(function (np) {
        Object.keys(p).forEach(function (k) { delete p[k]; }); Object.assign(p, np);
        drawDoc(root, p, opts); toast('Sent. They’ll get back to you with an update.');
      }).catch(function (e) { if (e.demo) return toast('On a real quote, this goes straight to the pro.'); showError(e); });
    };
    $('#decBtn', root).onclick = function () {
      if (opts.demo) return toast('On a real quote, this lets the pro know — politely.');
      var why = prompt('Optional: anything you’d like ' + p.business.name + ' to know?');
      if (why === null) return;
      post('decline', { message: why }).then(function (np) {
        Object.keys(p).forEach(function (k) { delete p[k]; }); Object.assign(p, np); drawDoc(root, p, opts);
      }).catch(function (e) { showError(e); });
    };
  }

  function renderSample() {
    loading();
    api('GET', 'api/demo').then(function (d) {
      view.innerHTML = '<div class="sample-bar"><div><div class="eyebrow">Sample quote</div><div class="small muted">What your customer gets — pick an option, try signing it.</div></div>' +
        '<button class="btn small" id="sampleGo">' + (signedIn() ? 'Make one' : 'Try it free') + '</button></div><div id="doc"></div>';
      $('#sampleGo').onclick = function () { signedIn() ? (location.hash = '#/new') : openAccount(); };
      drawDoc($('#doc'), d, { demo: true });
    }).catch(function (e) { showError(e, view); });
  }

  function renderPublic(token) {
    document.body.classList.add('public');
    $('#tabbar').hidden = true;
    view.className = 'pub-wrap';
    loading();
    api('GET', 'api/public/' + token).then(function (p) {
      document.title = p.title + ' — ' + p.business.name;
      var meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.setAttribute('content', p.business.color);
      view.innerHTML = '<div id="doc"></div>';
      drawDoc($('#doc'), p, { token: token, preview: p.preview });
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><div class="e">🔗</div><h2>This link isn’t working</h2><p>' + esc(e.message) + ' Ask whoever sent it for a fresh link.</p></div>';
    });
  }

  /* ---------------- pipeline ---------------- */

  var COLUMNS = [
    { key: 'draft', label: 'Drafts', color: 'var(--faint)', has: ['draft'], empty: 'Nothing in progress.' },
    { key: 'sent', label: 'Sent', color: 'var(--blue)', has: ['sent'], empty: 'Nothing waiting to be opened.' },
    { key: 'viewed', label: 'Viewed', color: 'var(--violet)', has: ['viewed', 'changes'], empty: 'Opened quotes land here.' },
    { key: 'won', label: 'Won', color: 'var(--good)', has: ['accepted'], empty: 'Your wins show up here. 🏆' },
    { key: 'lost', label: 'Lost', color: 'var(--bad)', has: ['declined', 'expired'], empty: 'Nothing lost. Keep it that way.' },
  ];

  function renderPipeline() {
    loading();
    api('GET', 'api/quotes').then(function (r) {
      var qs = r.quotes;
      var p = profile();
      var open = qs.filter(function (q) { return ['sent', 'viewed', 'changes'].indexOf(q.status) >= 0; });
      var openVal = open.reduce(function (a, q) { return a + q.value; }, 0);
      var won = qs.filter(function (q) { return q.status === 'accepted'; });
      var decided = won.length + qs.filter(function (q) { return q.status === 'declined' || q.status === 'expired'; }).length;
      var weekAgo = Date.now() - 7 * 86400000;
      var sentWeek = qs.filter(function (q) { return q.sentAt && Date.parse(q.sentAt) > weekAgo; }).length;
      var unread = qs.filter(function (q) { return q.unread; });

      var html = '<div class="page-head"><div><h1>Pipeline</h1><div class="sub">' + open.length + ' open · <b class="num">' + money0(openVal) + '</b> in play</div></div>' +
        '<a class="btn small" href="#/new">＋ New quote</a></div>';
      if (!p.setUp) html += '<a class="banner" href="#/business" style="text-decoration:none;color:inherit;margin-bottom:12px"><span class="e">🏷️</span><div class="grow"><b>Add your business details</b><div class="small muted">Name, logo, colors and rates go on every quote.</div></div><span>›</span></a>';
      if (unread.length) html += '<a class="banner warn" href="#/quote/' + esc(unread[0].id) + '" style="text-decoration:none;color:inherit;margin-bottom:12px"><span class="e">✏️</span><div class="grow"><b>' + esc(unread[0].customer || 'A customer') + ' asked for changes</b><div class="small muted">' + esc(unread[0].title) + '</div></div><span>›</span></a>';

      if (!qs.length) {
        html += '<div class="card empty"><div class="e">📸</div><h2>Snap your first quote</h2><p>Photos and a quick voice note in, a professional quote out — usually in under a minute.</p>' +
          '<div class="row" style="justify-content:center;flex-wrap:wrap"><a class="btn" href="#/new">New quote</a><a class="btn ghost" href="#/sample">See a sample</a></div></div>';
        view.innerHTML = html;
        return;
      }
      html += '<div class="kpis"><div class="kpi"><b>' + moneyShort(openVal) + '</b><span>Open value</span></div>' +
        '<div class="kpi"><b>' + sentWeek + '</b><span>Sent this week</span></div>' +
        '<div class="kpi"><b>' + (decided ? Math.round(won.length / decided * 100) + '%' : '—') + '</b><span>Win rate</span></div></div>';
      html += '<div class="board">' + COLUMNS.map(function (c) {
        var rows = qs.filter(function (q) { return c.has.indexOf(q.status) >= 0; });
        var sum = rows.reduce(function (a, q) { return a + q.value; }, 0);
        return '<section class="col"><div class="col-head"><b><i class="dot" style="background:' + c.color + '"></i>' + c.label + ' <span class="count">' + rows.length + '</span></b><span class="sum">' + (rows.length ? moneyShort(sum) : '') + '</span></div>' +
          (rows.length ? rows.map(card).join('') : '<div class="col-empty">' + c.empty + '</div>') + '</section>';
      }).join('') + '</div>';
      view.innerHTML = html;
      $$('.qcard').forEach(function (b) { b.onclick = function () { location.hash = '#/quote/' + b.dataset.id; }; });
    }).catch(function (e) { showError(e, view); });
  }

  function card(q) {
    var when = q.status === 'draft' ? 'Edited ' + timeAgo(q.updatedAt)
      : q.status === 'accepted' ? 'Won ' + timeAgo(q.respondedAt || q.updatedAt)
        : q.status === 'expired' ? 'Expired ' + dateFmt(q.validUntil, { month: 'short', day: 'numeric' })
          : q.viewedAt ? 'Opened ' + timeAgo(q.viewedAt) : 'Sent ' + timeAgo(q.sentAt);
    return '<button class="qcard" data-id="' + esc(q.id) + '">' + (q.unread ? '<i class="flag" title="New message"></i>' : '') +
      '<div class="t">' + esc(q.customer || 'No customer yet') + '</div><div class="c">' + esc(q.number) + (q.tiers ? ' · ' + q.tiers + ' options' : '') + ' · ' + esc(q.title) + '</div>' +
      '<div class="b"><span class="v">' + money0(q.value) + '</span>' +
      (q.status === 'changes' || q.status === 'expired' || q.status === 'declined' ? statusChip(q.status) : '<span class="when">' + esc(when) + '</span>') + '</div></button>';
  }

  /* ---------------- new quote ---------------- */

  function freshForm() {
    return { photos: [], trade: profile().trade || 'handyman', title: '', description: '', customer: { name: '', contact: '', address: '' }, tiers: false };
  }

  function renderNew() {
    if (!state.nf) state.nf = freshForm();
    var nf = state.nf;
    var meta = state.meta || { trades: {} };
    var tpl = signedIn() ? (state.templates ? Promise.resolve(state.templates) : api('GET', 'api/templates').then(function (r) { state.templates = r.templates; return r.templates; }).catch(function () { return []; })) : Promise.resolve([]);
    tpl.then(function (templates) {
      view.innerHTML =
        '<div class="page-head"><div><h1>New quote</h1><div class="sub">Photos + a few words. We’ll do the write-up.</div></div></div>' +
        (templates.length ? '<div class="chips" style="margin-bottom:14px"><span class="small muted" style="align-self:center;white-space:nowrap">Start from:</span>' + templates.map(function (t) {
          return '<button class="chip" data-tpl="' + esc(t.id) + '">📋 ' + esc(t.name) + '</button>';
        }).join('') + '<button class="chip" id="blankQ">Blank quote</button></div>' : '') +
        '<div class="dk-2"><div>' +
        '<div class="group-title">Photos <span class="tiny faint" style="text-transform:none;letter-spacing:0">' + nf.photos.length + ' of 4</span></div>' +
        '<div class="card"><div class="photos" id="photos"></div><input type="file" id="fileIn" accept="image/*" multiple hidden>' +
        '<p class="tiny faint" style="margin:10px 0 0">Shrunk on your phone before upload, read once to draft the quote, then discarded. Only the quote is saved.</p></div>' +
        '<div class="group-title">The job</div>' +
        '<div class="card"><div class="trade-pick" id="tradePick">' + Object.keys(meta.trades).map(function (k) {
          var t = meta.trades[k];
          return '<button data-trade="' + k + '" class="' + (k === nf.trade ? 'on' : '') + '"><span class="e">' + t.emoji + '</span>' + esc(t.label) + '</button>';
        }).join('') + '</div>' +
        '<label class="field" style="margin:14px 0 12px"><span>Job title (optional)</span><input class="input" id="jobTitle" maxlength="90" placeholder="e.g. Kitchen repaint" value="' + esc(nf.title) + '"></label>' +
        '<label class="field" style="margin:0"><span>Describe it — or tap the mic and talk</span><div class="dictate"><textarea class="input" id="desc" maxlength="3000" placeholder="e.g. Two bedrooms and the hall, walls and trim, about 9ft ceilings. Some nail holes, one water stain on the ceiling. They want it done before the 15th.">' + esc(nf.description) + '</textarea>' +
        (SR ? '<button class="mic" id="micBtn" type="button">' + ICON.mic + '<span>Dictate</span></button>' : '') + '</div></label></div>' +
        '</div><div class="dk-sticky">' +
        '<div class="group-title">Customer</div>' +
        '<div class="group"><div class="cell"><label for="cName">Name</label><input id="cName" maxlength="80" placeholder="Jordan Rivera" value="' + esc(nf.customer.name) + '" autocomplete="off"></div>' +
        '<div class="cell"><label for="cContact">Phone or email</label><input id="cContact" maxlength="120" placeholder="(555) 555-0123" value="' + esc(nf.customer.contact) + '" autocomplete="off"></div>' +
        '<div class="cell"><label for="cAddr">Job address</label><input id="cAddr" maxlength="160" placeholder="118 Maple Crest Dr" value="' + esc(nf.customer.address) + '" autocomplete="off"></div></div>' +
        '<div class="group-title">Pricing</div>' +
        '<div class="tier-opt"><button id="tSingle" class="' + (nf.tiers ? '' : 'on') + '"><div class="gbb"><i style="flex:3;background:var(--accent)"></i></div><b>One price</b><span>A single clear total</span></button>' +
        '<button id="tTiers" class="' + (nf.tiers ? 'on' : '') + '"><div class="gbb"><i></i><i></i><i></i></div><b>Good · Better · Best</b><span>Three options, more yeses</span></button></div>' +
        '<p class="tiny faint" style="margin:10px 4px 0">Your rate (' + money0(profile().hourlyRate || 75) + '/hr), markup (' + esc(profile().markupPct != null ? profile().markupPct : 15) + '%) and tax (' + esc(profile().taxPct || 0) + '%) are applied automatically — <a href="#/business">change</a>.</p>' +
        '<div class="snap-bar"><div id="snapErr"></div><button class="btn lg block" id="snapBtn">' + ICON.spark + ' Snap my quote</button>' +
        '<p class="center tiny faint" style="margin:8px 0 0">' + (signedIn() ? 'About 1–2¢ of credit · <button class="link-btn tiny" id="startBlank">or build it by hand, free</button>' : 'Free to try — $2 of credit on sign-up') + '</p></div>' +
        '</div></div>';

      drawPhotos();
      $$('#tradePick button').forEach(function (b) {
        b.onclick = function () { nf.trade = b.dataset.trade; $$('#tradePick button').forEach(function (x) { x.classList.toggle('on', x === b); }); };
      });
      $('#jobTitle').oninput = function (e) { nf.title = e.target.value; };
      $('#desc').oninput = function (e) { nf.description = e.target.value; };
      $('#cName').oninput = function (e) { nf.customer.name = e.target.value; };
      $('#cContact').oninput = function (e) { nf.customer.contact = e.target.value; };
      $('#cAddr').oninput = function (e) { nf.customer.address = e.target.value; };
      $('#tSingle').onclick = function () { nf.tiers = false; this.classList.add('on'); $('#tTiers').classList.remove('on'); };
      $('#tTiers').onclick = function () { nf.tiers = true; this.classList.add('on'); $('#tSingle').classList.remove('on'); };
      $('#fileIn').onchange = function (e) { addPhotos(e.target.files); e.target.value = ''; };
      if (SR) wireMic($('#micBtn'), $('#desc'), function (v) { nf.description = v; });
      $('#snapBtn').onclick = snap;
      var sb = $('#startBlank'); if (sb) sb.onclick = function () { startQuote({ customer: nf.customer }); };
      $$('[data-tpl]').forEach(function (b) { b.onclick = function () { startQuote({ templateId: b.dataset.tpl, customer: nf.customer }); }; });
      var bq = $('#blankQ'); if (bq) bq.onclick = function () { startQuote({ customer: nf.customer }); };
    });
  }

  function startQuote(body) {
    if (!signedIn()) return openAccount();
    api('POST', 'api/quotes', body).then(function (q) { state.nf = null; location.hash = '#/quote/' + q.id; }).catch(function (e) { showError(e); });
  }

  function drawPhotos() {
    var nf = state.nf; var el = $('#photos'); if (!el) return;
    var h = nf.photos.map(function (p, i) {
      return '<div class="ph filled"><img src="' + p.url + '" alt="Job photo ' + (i + 1) + '"><button class="x" data-rm="' + i + '" aria-label="Remove photo">×</button></div>';
    }).join('');
    for (var i = nf.photos.length; i < 4; i++) {
      h += i === nf.photos.length
        ? '<button class="ph add" id="addPh" type="button" aria-label="Add photos">' + ICON.cam + '<small>Add</small></button>'
        : '<div class="ph"></div>';
    }
    el.innerHTML = h;
    var add = $('#addPh'); if (add) add.onclick = function () { $('#fileIn').click(); };
    $$('[data-rm]', el).forEach(function (b) { b.onclick = function () { nf.photos.splice(Number(b.dataset.rm), 1); drawPhotos(); }; });
    var gt = $$('.group-title .tiny')[0]; if (gt) gt.textContent = nf.photos.length + ' of 4';
  }

  /** Shrink on the phone: max 1024px on the long side, JPEG, under ~1.4 MB.
   *  A 12-megapixel photo is 4 MB+ and would be refused; this is ~150 KB. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        var q = 0.82, d = c.toDataURL('image/jpeg', q);
        while (d.length * 0.75 > 1.4e6 && q > 0.35) { q -= 0.15; d = c.toDataURL('image/jpeg', q); }
        resolve({ type: 'image/jpeg', data: d.split(',')[1], url: d });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be read. Try a JPEG or PNG.')); };
      img.src = url;
    });
  }

  function addPhotos(files) {
    var nf = state.nf;
    var list = Array.prototype.slice.call(files || []).slice(0, 4 - nf.photos.length);
    if (files && files.length > list.length) toast('Up to 4 photos per quote.');
    list.reduce(function (p, f) {
      return p.then(function () { return shrink(f).then(function (ph) { nf.photos.push(ph); drawPhotos(); }); });
    }, Promise.resolve()).catch(function (e) { toast(e.message); });
  }

  function snap() {
    var nf = state.nf;
    if (!signedIn()) return openAccount('Sign up free — $2 of AI credit, enough for roughly 100 quotes.');
    if (!nf.photos.length && nf.description.trim().length < 8) {
      $('#snapErr').innerHTML = '<div class="err">Add a photo or say a sentence about the job first.</div>';
      return;
    }
    stopListening();
    var started = Date.now();
    var ov = document.createElement('div');
    ov.className = 'drafting';
    var steps = nf.photos.length
      ? ['Looking at your photos', 'Measuring up the job', 'Pricing labor & materials', 'Writing it up']
      : ['Reading your notes', 'Measuring up the job', 'Pricing labor & materials', 'Writing it up'];
    ov.innerHTML = '<div class="box">' +
      (nf.photos.length ? '<div class="thumbs">' + nf.photos.map(function (p) { return '<div><img src="' + p.url + '" alt=""></div>'; }).join('') + '</div>' : '') +
      '<div class="doc"><i></i><i></i><i></i><i></i><i></i></div>' +
      '<h2>Drafting your quote…</h2><ol>' + steps.map(function (s) { return '<li><i></i>' + s + '</li>'; }).join('') + '</ol></div>';
    document.body.appendChild(ov);
    var lis = $$('li', ov), at = 0;
    lis[0].classList.add('on');
    var tick = setInterval(function () {
      if (at >= lis.length - 1) return;
      lis[at].classList.remove('on'); lis[at].classList.add('done'); lis[at].firstChild.textContent = '✓';
      at++; lis[at].classList.add('on');
    }, 1700);
    api('POST', 'api/quotes/draft', {
      photos: nf.photos.map(function (p) { return { type: p.type, data: p.data }; }),
      description: nf.description, title: nf.title, trade: nf.trade, customer: nf.customer, tiers: nf.tiers,
    }).then(function (q) {
      clearInterval(tick);
      lis.forEach(function (li) { li.classList.remove('on'); li.classList.add('done'); li.firstChild.textContent = '✓'; });
      state.justDrafted = { id: q.id, secs: Math.max(1, Math.round((Date.now() - started) / 1000)), photos: nf.photos.length };
      state.nf = null;
      loadMe();
      setTimeout(function () { ov.remove(); location.hash = '#/quote/' + q.id; }, 450);
    }).catch(function (e) {
      clearInterval(tick); ov.remove();
      showError(e, $('#snapErr'));
    });
  }

  /* mic: tap to talk, tap again to stop. Words land in the box to edit. */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null;
  function stopListening() { if (rec) { try { rec.stop(); } catch (e) { /* already stopped */ } } }
  function wireMic(btn, ta, onText) {
    btn.onclick = function () {
      if (rec) return stopListening();
      var base = ta.value ? ta.value.trim() + ' ' : '';
      rec = new SR();
      rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true;
      rec.onresult = function (e) {
        var txt = '';
        for (var i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        ta.value = base + txt;
        if (onText) onText(ta.value);
      };
      rec.onend = function () { rec = null; btn.classList.remove('rec'); $('span', btn).textContent = 'Dictate'; };
      rec.onerror = function (e) { if (e.error === 'not-allowed') toast('Microphone access is off for this site.'); };
      try { rec.start(); btn.classList.add('rec'); $('span', btn).textContent = 'Listening… tap to stop'; } catch (e) { rec = null; }
    };
  }

  /* ---------------- the editor ---------------- */

  var q = null;     // the quote as the server last returned it
  var ed = null;    // what is on screen
  var dirty = false;
  var list = 'base';

  function renderEditor(id) {
    if (!signedIn()) return signedOutPitch('🔒', 'Sign in to see that quote', 'Your quotes live in your account.');
    loading();
    api('GET', 'api/quotes/' + encodeURIComponent(id)).then(function (r) {
      q = r; ed = clone(r); dirty = false; list = 'base';
      drawEditor();
      leaving = function () { state.justDrafted = null; if (dirty && q && !q.locked) api('PUT', 'api/quotes/' + q.id, payload()).catch(function () { /* next open shows the saved version */ }); };
      if (state.justDrafted && state.justDrafted.id === id) confetti();
    }).catch(function (e) { showError(e, view); });
  }

  function payload() {
    return {
      title: ed.title, scope: ed.scope, customer: ed.customer, items: ed.items, tiers: ed.tiers,
      assumptions: ed.assumptions, exclusions: ed.exclusions, timeline: ed.timeline, terms: ed.terms, notes: ed.notes,
      markupPct: ed.markupPct, taxPct: ed.taxPct, discount: ed.discount, validDays: ed.validDays,
    };
  }

  function touch() {
    dirty = true;
    var s = $('#saveState'); if (s) { s.textContent = 'Unsaved changes'; s.className = 'dirty'; }
    refreshTotals();
  }

  function listItems() {
    if (list === 'base') return ed.items;
    var t = (ed.tiers || []).filter(function (x) { return x.key === list; })[0];
    return t ? t.items : ed.items;
  }

  function drawEditor() {
    var locked = q.locked;
    var jd = state.justDrafted && state.justDrafted.id === q.id ? state.justDrafted : null;
    var steps = [['Created', true], ['Sent', !!q.sentAt], ['Viewed', !!q.viewedAt], [q.status === 'declined' ? 'Declined' : q.status === 'expired' ? 'Expired' : 'Won', ['accepted', 'declined', 'expired'].indexOf(q.status) >= 0]];
    var msgs = (q.messages || []).filter(function (m) { return m.from === 'customer'; });
    var r = q.response;

    view.innerHTML =
      '<div class="ed-top"><button class="icon-btn" id="edBack" aria-label="Back">' + ICON.back + '</button>' +
      '<div class="grow"><div class="small muted num">' + esc(q.number) + ' · ' + (q.source === 'ai' ? '✨ Drafted' : q.source === 'template' ? '📋 From template' : q.source === 'duplicate' ? 'Copy' : 'Manual') + '</div></div>' +
      statusChip(q.status) +
      (q.publicUrl ? '<a class="icon-btn" href="' + esc(BASE + q.publicUrl) + '" target="_blank" rel="noopener" aria-label="Preview as customer" title="Preview as customer">' + ICON.eye + '</a>' : '') + '</div>' +
      (jd ? '<div class="banner good" style="margin-bottom:12px"><span class="e">✨</span><div><b>Drafted in ' + jd.secs + 's' + (jd.photos ? ' from ' + jd.photos + ' photo' + (jd.photos > 1 ? 's' : '') : '') + '.</b> <span class="muted">Check the quantities and prices — then send it while you’re still in the driveway.</span></div></div>' : '') +
      (locked && r ? '<div class="banner good" style="margin-bottom:12px"><span class="e">🏆</span><div><b>Accepted by ' + esc(r.name) + '</b> · ' + esc(dateFmt(r.at)) + (r.tier ? ' · ' + esc(tierLabel(r.tier)) : '') + '<div class="small muted">Locked so the price they signed stays the price. Duplicate to make a new version.</div></div></div>' : '') +
      (msgs.length ? '<div class="card" style="margin-bottom:12px;border-color:color-mix(in srgb,var(--warn) 40%,transparent)"><div class="card-head"><h3>💬 From ' + esc(q.customer.name || 'your customer') + '</h3></div><div class="msgs">' +
        msgs.slice(-4).map(function (m) { return '<div class="m">' + esc(m.text) + '<div class="when">' + esc(timeAgo(m.at)) + '</div></div>'; }).join('') +
        '</div><p class="small muted" style="margin:10px 0 0">Make the changes below, then tap <b>Send update</b> — same link, fresh validity date.</p></div>' : '') +
      '<section class="ed-hero"><input class="title-in" id="edTitle" maxlength="90" value="' + esc(ed.title) + '"' + (locked ? ' disabled' : '') + ' aria-label="Job title">' +
      '<div class="small muted">' + esc(ed.customer.name || 'No customer yet') + (ed.customer.address ? ' · ' + esc(ed.customer.address) : '') + '</div>' +
      '<div class="big" id="bigTotal"></div>' +
      '<div class="timeline">' + steps.map(function (s, i) {
        return (i ? '<div class="ln' + (s[1] ? ' on' : '') + '"></div>' : '') + '<div class="s' + (s[1] ? ' on' : '') + '"><i></i>' + s[0] + '</div>';
      }).join('') + '</div></section>' +
      '<div class="dk-2" style="margin-top:12px"><div>' +
      // scope
      '<div class="card"><div class="card-head"><h3>Scope</h3><span class="sub">What the customer reads first</span></div>' +
      '<textarea class="input" id="edScope" maxlength="1500" rows="5"' + (locked ? ' disabled' : '') + '>' + esc(ed.scope) + '</textarea>' +
      (locked ? '' : '<div class="polish-row"><button class="btn small ghost" data-tone="friendly">' + ICON.spark + ' Friendlier</button><button class="btn small ghost" data-tone="professional">' + ICON.spark + ' More professional</button></div><div id="suggest"></div>') + '</div>' +
      // items
      '<div class="card"><div class="card-head"><h3>Line items</h3>' + (locked ? '' : '<button class="btn small plain" id="tierToggle">' + (ed.tiers ? 'Remove options' : '＋ Good / Better / Best') + '</button>') + '</div>' +
      '<div id="tierTabs"></div><div id="tierMeta"></div><div class="items" id="items"></div>' +
      (locked ? '' : '<button class="add-line" id="addLine">＋ Add line</button>') + '</div>' +
      // details
      '<div class="card"><div class="card-head"><h3>Details</h3></div>' +
      '<label class="field"><span>Timeline</span><input class="input" id="edTimeline" maxlength="200" value="' + esc(ed.timeline) + '"' + (locked ? ' disabled' : '') + ' placeholder="e.g. 2 days on site; can start next week"></label>' +
      '<label class="field"><span>Assumptions (one per line)</span><textarea class="input" id="edAssume" rows="3"' + (locked ? ' disabled' : '') + '>' + esc((ed.assumptions || []).join('\n')) + '</textarea></label>' +
      '<label class="field"><span>Not included (one per line)</span><textarea class="input" id="edExcl" rows="3"' + (locked ? ' disabled' : '') + '>' + esc((ed.exclusions || []).join('\n')) + '</textarea></label>' +
      '<label class="field"><span>Payment terms</span><textarea class="input" id="edTerms" rows="2" maxlength="400"' + (locked ? ' disabled' : '') + '>' + esc(ed.terms) + '</textarea></label>' +
      '<label class="field" style="margin:0"><span>' + ICON.lock.replace('<svg', '<svg style="width:13px;height:13px;vertical-align:-2px"') + ' Private notes — only you see these</span><textarea class="input" id="edNotes" rows="3" maxlength="1500"' + (locked ? ' disabled' : '') + ' placeholder="Gate code, parking, what they said about budget…">' + esc(ed.notes) + '</textarea></label></div>' +
      '</div><div class="dk-sticky">' +
      // pricing
      '<div class="card"><div class="card-head"><h3>Pricing</h3><span class="sub">Markup applies to non-labor lines</span></div>' +
      '<div class="adj"><div><label for="edMarkup">Markup %</label><input class="input num" id="edMarkup" inputmode="decimal" value="' + esc(ed.markupPct) + '"' + (locked ? ' disabled' : '') + '></div>' +
      '<div><label for="edTax">Tax %</label><input class="input num" id="edTax" inputmode="decimal" value="' + esc(ed.taxPct) + '"' + (locked ? ' disabled' : '') + '></div>' +
      '<div><label for="edDisc">Discount $</label><input class="input num" id="edDisc" inputmode="decimal" value="' + esc(ed.discount || 0) + '"' + (locked ? ' disabled' : '') + '></div></div>' +
      '<div id="totals" class="totals" style="margin-top:14px"></div>' +
      '<div class="row spread small muted" style="margin-top:10px"><span>Valid for</span><span><input class="input num" id="edValid" inputmode="numeric" style="width:64px;padding:6px 8px;text-align:right;display:inline-block" value="' + esc(ed.validDays || 30) + '"' + (locked ? ' disabled' : '') + '> days</span></div></div>' +
      // customer
      '<div class="group-title">Customer</div><div class="group">' +
      '<div class="cell"><label for="ecName">Name</label><input id="ecName" maxlength="80" value="' + esc(ed.customer.name) + '"' + (locked ? ' disabled' : '') + '></div>' +
      '<div class="cell"><label for="ecContact">Phone / email</label><input id="ecContact" maxlength="120" value="' + esc(ed.customer.contact) + '"' + (locked ? ' disabled' : '') + '></div>' +
      '<div class="cell"><label for="ecAddr">Address</label><input id="ecAddr" maxlength="160" value="' + esc(ed.customer.address) + '"' + (locked ? ' disabled' : '') + '></div></div>' +
      (q.description ? '<p class="hint">Your original notes: “' + esc(q.description.slice(0, 220)) + (q.description.length > 220 ? '…' : '') + '”</p>' : '') +
      // follow-up
      (q.sentAt && !locked ? '<div class="card follow" style="margin-top:12px"><div class="card-head"><h3>Follow up</h3><span class="sub">' + (q.viewedAt ? 'Opened ' + esc(timeAgo(q.viewedAt)) : 'Not opened yet') + '</span></div><div id="followBox"></div>' +
        '<button class="btn small ghost block" id="followBtn">' + ICON.spark + ' ' + (q.followUp ? 'Write another' : 'Draft a follow-up') + '</button></div>' : '') +
      // more
      '<div class="group-title">More</div><div class="more-actions">' +
      '<button class="btn ghost" id="dupBtn">Duplicate</button><button class="btn ghost" id="tplBtn">Save as template</button>' +
      (q.sentAt && ['sent', 'viewed', 'changes', 'expired'].indexOf(q.status) >= 0 ? '<button class="btn ghost" id="wonBtn">🏆 Mark won</button><button class="btn ghost" id="lostBtn">Mark lost</button>' : '') +
      (q.status === 'declined' ? '<button class="btn ghost" id="reopenBtn">Reopen</button>' : '') +
      '<button class="btn danger" id="delBtn">Delete</button></div>' +
      '</div></div>' +
      // action bar
      '<div class="actionbar"><div class="sum"><b id="barTotal"></b><span id="saveState">' + (locked ? 'Accepted · locked' : 'All changes saved') + '</span></div>' +
      (locked ? (q.publicUrl ? '<button class="btn" id="shareBtn">Share link</button>' : '') :
        '<button class="btn ghost" id="saveBtn">Save</button><button class="btn" id="sendBtn">' + ICON.send + ' ' + (!q.sentAt ? 'Send' : q.status === 'changes' ? 'Send update' : 'Share') + '</button>') + '</div>';

    drawTierTabs(); drawItems(); refreshTotals(); drawFollow();
    wireEditor();
  }

  function tierLabel(k) {
    var t = (ed.tiers || q.tiers || []).filter(function (x) { return x.key === k; })[0];
    return t ? t.label : k;
  }

  function drawTierTabs() {
    var el = $('#tierTabs'); var meta = $('#tierMeta');
    if (!ed.tiers) { el.innerHTML = ''; meta.innerHTML = ''; list = 'base'; return; }
    var tot = computeTotals(ed).tiers;
    el.innerHTML = '<div class="tier-tabs"><button data-list="base" class="' + (list === 'base' ? 'on' : '') + '">In every option<small>' + ed.items.length + ' lines</small></button>' +
      ed.tiers.map(function (t) {
        return '<button data-list="' + t.key + '" class="' + (list === t.key ? 'on' : '') + '">' + esc({ good: 'Good', better: 'Better', best: 'Best' }[t.key]) + '<small>' + money0(tot[t.key].total) + '</small></button>';
      }).join('') + '</div>';
    $$('[data-list]', el).forEach(function (b) { b.onclick = function () { list = b.dataset.list; drawTierTabs(); drawItems(); }; });
    if (list === 'base') {
      meta.innerHTML = '<p class="small muted" style="margin:0 0 10px">Lines here are in all three options. Each option adds its own lines on top.</p>';
    } else {
      var t = ed.tiers.filter(function (x) { return x.key === list; })[0];
      meta.innerHTML = '<div class="tier-meta"><input class="input" id="tLabel" maxlength="40" placeholder="Option name" value="' + esc(t.label) + '"' + (q.locked ? ' disabled' : '') + '>' +
        '<input class="input" id="tSummary" maxlength="280" placeholder="One line on what this option gets them" value="' + esc(t.summary) + '"' + (q.locked ? ' disabled' : '') + '></div>';
      $('#tLabel').oninput = function (e) { t.label = e.target.value; touch(); };
      $('#tSummary').oninput = function (e) { t.summary = e.target.value; touch(); };
    }
  }

  function itemRow(it, i, n) {
    var l = priceLine(it, ed.markupPct);
    var dis = q.locked ? ' disabled' : '';
    return '<div class="item" data-i="' + i + '"><div class="top-row"><textarea class="desc" rows="1" data-f="description" maxlength="160" placeholder="What is it?"' + dis + '>' + esc(it.description) + '</textarea>' +
      (q.locked ? '' : '<div class="ctl"><button data-act="up" aria-label="Move up"' + (i === 0 ? ' disabled style="opacity:.3"' : '') + '>' + ICON.up + '</button><button data-act="down" aria-label="Move down"' + (i === n - 1 ? ' disabled style="opacity:.3"' : '') + '>' + ICON.down + '</button><button data-act="rm" aria-label="Remove line">' + ICON.x + '</button></div>') + '</div>' +
      '<div class="nums"><select data-f="category" aria-label="Category"' + dis + '>' + CAT_ORDER.map(function (c) { return '<option value="' + c + '"' + (c === it.category ? ' selected' : '') + '>' + CATS[c].emoji + ' ' + CATS[c].label + '</option>'; }).join('') + '</select>' +
      '<input class="n" data-f="qty" inputmode="decimal" aria-label="Quantity" value="' + esc(it.qty) + '"' + dis + '>' +
      '<input class="n" data-f="unit" list="units" aria-label="Unit" style="text-align:left" maxlength="12" value="' + esc(it.unit) + '"' + dis + '>' +
      '<div class="money-in"><input class="n" data-f="unitPrice" inputmode="decimal" aria-label="Unit price" value="' + esc(it.unitPrice) + '"' + dis + '></div>' +
      '<div class="amt"><span data-amt>' + money(l.price) + '</span><small data-cost>' + (l.marked && ed.markupPct ? 'cost ' + money(l.cost) : '') + '</small></div></div></div>';
  }

  function drawItems() {
    var items = listItems();
    var el = $('#items');
    el.innerHTML = (items.length ? items.map(function (it, i) { return itemRow(it, i, items.length); }).join('')
      : '<div class="col-empty">' + (list === 'base' ? 'No lines yet.' : 'This option adds nothing on top — add what makes it worth more.') + '</div>') +
      '<datalist id="units">' + ((state.meta && state.meta.units) || []).map(function (u) { return '<option value="' + esc(u) + '">'; }).join('') + '</datalist>';
    $$('.item', el).forEach(function (row) {
      var i = Number(row.dataset.i);
      $$('[data-f]', row).forEach(function (inp) {
        var ev = inp.tagName === 'SELECT' ? 'change' : 'input';
        inp.addEventListener(ev, function () {
          var f = inp.dataset.f;
          items[i][f] = (f === 'qty' || f === 'unitPrice') ? inp.value : inp.value;
          if (inp.classList.contains('desc')) autoGrow(inp);
          var l = priceLine(items[i], ed.markupPct);
          $('[data-amt]', row).textContent = money(l.price);
          $('[data-cost]', row).textContent = l.marked && ed.markupPct ? 'cost ' + money(l.cost) : '';
          touch();
        });
      });
      autoGrow($('.desc', row));
      $$('[data-act]', row).forEach(function (b) {
        b.onclick = function () {
          var a = b.dataset.act;
          if (a === 'rm') items.splice(i, 1);
          if (a === 'up' && i > 0) items.splice(i - 1, 0, items.splice(i, 1)[0]);
          if (a === 'down' && i < items.length - 1) items.splice(i + 1, 0, items.splice(i, 1)[0]);
          drawItems(); drawTierTabs(); touch();
        };
      });
    });
  }

  function autoGrow(ta) { if (!ta) return; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

  function refreshTotals() {
    var t = computeTotals(ed);
    var h = headline(ed);
    var el = $('#totals');
    if (t.tiers) {
      el.innerHTML = '<div class="tier-totals">' + ed.tiers.map(function (x) {
        return '<div><span>' + esc(x.label || x.key) + '</span><b>' + money0(t.tiers[x.key].total) + '</b></div>';
      }).join('') + '</div>' +
        '<div class="r private" style="margin-top:8px"><span>Better: your cost ' + money0(h.cost) + '</span><span>margin ' + money0(h.margin) + '</span></div>';
      var tabs = $$('#tierTabs [data-list] small');
      ed.tiers.forEach(function (x, i) { if (tabs[i + 1]) tabs[i + 1].textContent = money0(t.tiers[x.key].total); });
      if (tabs[0]) tabs[0].textContent = ed.items.length + ' lines';
    } else {
      var s = t.single;
      el.innerHTML = '<div class="r"><span class="muted">Subtotal</span><span>' + money(s.subtotal) + '</span></div>' +
        (s.discount ? '<div class="r"><span class="muted">Discount</span><span>−' + money(s.discount) + '</span></div>' : '') +
        '<div class="r"><span class="muted">Tax (' + esc(numIn(ed.taxPct, 30)) + '%)</span><span>' + money(s.tax) + '</span></div>' +
        '<div class="r big"><span>Total</span><span>' + money(s.total) + '</span></div>' +
        '<div class="r private"><span>' + ICON.lock.replace('<svg', '<svg style="width:12px;height:12px;vertical-align:-1px"') + ' Your cost ' + money(s.cost) + '</span><span>Margin ' + money(s.margin) + '</span></div>';
    }
    $('#bigTotal').innerHTML = money(h.total) + '<small>' + (t.tiers ? 'Better option' : 'incl. tax') + '</small>';
    $('#barTotal').textContent = money(h.total);
  }

  function drawFollow() {
    var box = $('#followBox'); if (!box) return;
    var f = q.followUp;
    if (!f) { box.innerHTML = '<p class="small muted" style="margin:0 0 10px">Quiet customer? A friendly nudge wins a surprising number of jobs.</p>'; return; }
    var phone = /[0-9]{3}/.test(ed.customer.contact || '') && !/@/.test(ed.customer.contact || '') ? ed.customer.contact.replace(/[^0-9+]/g, '') : '';
    var email = /@/.test(ed.customer.contact || '') ? ed.customer.contact : '';
    box.innerHTML = '<div class="eyebrow" style="margin-bottom:6px">Text</div><div class="box">' + esc(f.sms) + '</div>' +
      '<div class="row" style="margin:8px 0 14px"><button class="btn small ghost" data-copy="sms">Copy</button><a class="btn small ghost" href="sms:' + esc(phone) + '?&body=' + encodeURIComponent(f.sms) + '">Open Messages</a></div>' +
      '<div class="eyebrow" style="margin-bottom:6px">Email · ' + esc(f.emailSubject) + '</div><div class="box">' + esc(f.emailBody) + '</div>' +
      '<div class="row" style="margin:8px 0 12px"><button class="btn small ghost" data-copy="email">Copy</button><a class="btn small ghost" href="mailto:' + esc(email) + '?subject=' + encodeURIComponent(f.emailSubject) + '&body=' + encodeURIComponent(f.emailBody) + '">Open Mail</a></div>';
    $$('[data-copy]', box).forEach(function (b) {
      b.onclick = function () { copy(b.dataset.copy === 'sms' ? f.sms : f.emailBody); };
    });
  }

  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Copied.'); })
      .catch(function () { prompt('Copy this:', text); });
  }

  function lines(v) { return String(v || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }

  function wireEditor() {
    $('#edBack').onclick = function () { location.hash = '#/quotes'; };
    var bind = function (sel, fn) { var el = $(sel); if (el) el.addEventListener('input', function () { fn(el.value); touch(); }); };
    bind('#edTitle', function (v) { ed.title = v; });
    bind('#edScope', function (v) { ed.scope = v; });
    bind('#edTimeline', function (v) { ed.timeline = v; });
    bind('#edAssume', function (v) { ed.assumptions = lines(v); });
    bind('#edExcl', function (v) { ed.exclusions = lines(v); });
    bind('#edTerms', function (v) { ed.terms = v; });
    bind('#edNotes', function (v) { ed.notes = v; });
    bind('#edMarkup', function (v) { ed.markupPct = numIn(v, 200); drawItemsAmounts(); });
    bind('#edTax', function (v) { ed.taxPct = numIn(v, 30); });
    bind('#edDisc', function (v) { ed.discount = numIn(v); });
    bind('#edValid', function (v) { ed.validDays = Math.max(1, Math.round(numIn(v, 365)) || 30); });
    bind('#ecName', function (v) { ed.customer.name = v; });
    bind('#ecContact', function (v) { ed.customer.contact = v; });
    bind('#ecAddr', function (v) { ed.customer.address = v; });
    autoGrow($('#edScope'));

    var tt = $('#tierToggle');
    if (tt) tt.onclick = function () {
      if (ed.tiers) {
        if (!confirm('Remove the three options? Their extra lines will be deleted.')) return;
        ed.tiers = null; list = 'base';
      } else {
        ed.tiers = [
          { key: 'good', label: 'Standard', summary: 'The essentials, done right.', items: [] },
          { key: 'better', label: 'Upgraded', summary: 'Our most popular option.', items: [] },
          { key: 'best', label: 'Premium', summary: 'Everything, finished to the highest standard.', items: [] },
        ];
        list = 'better';
      }
      tt.textContent = ed.tiers ? 'Remove options' : '＋ Good / Better / Best';
      drawTierTabs(); drawItems(); touch();
    };
    var al = $('#addLine');
    if (al) al.onclick = function () {
      listItems().push({ description: '', category: 'labor', qty: 1, unit: 'hr', unitPrice: profile().hourlyRate || 75 });
      drawItems(); drawTierTabs(); touch();
      var rows = $$('#items .desc'); if (rows.length) rows[rows.length - 1].focus();
    };

    $$('[data-tone]').forEach(function (b) {
      b.onclick = function () {
        var box = $('#suggest');
        b.disabled = true; var was = b.innerHTML; b.innerHTML = '<span class="spinner" style="border-color:var(--fill2);border-top-color:var(--accent)"></span>';
        api('POST', 'api/quotes/' + q.id + '/polish', { tone: b.dataset.tone, scope: ed.scope }).then(function (r) {
          box.innerHTML = '<div class="suggest"><div class="lbl">✨ ' + (r.tone === 'friendly' ? 'Friendlier' : 'More professional') + '</div><div style="white-space:pre-wrap">' + esc(r.scope) + '</div>' +
            '<div class="row" style="margin-top:10px"><button class="btn small" id="useSug">Use this</button><button class="btn small ghost" id="dropSug">Keep mine</button></div></div>';
          $('#useSug').onclick = function () { ed.scope = r.scope; $('#edScope').value = r.scope; autoGrow($('#edScope')); box.innerHTML = ''; touch(); };
          $('#dropSug').onclick = function () { box.innerHTML = ''; };
          loadMe();
        }).catch(function (e) { showError(e); }).then(function () { b.disabled = false; b.innerHTML = was; });
      };
    });

    var fb = $('#followBtn');
    if (fb) fb.onclick = function () {
      fb.disabled = true; fb.innerHTML = '<span class="spinner" style="border-color:var(--fill2);border-top-color:var(--accent)"></span> Writing…';
      api('POST', 'api/quotes/' + q.id + '/follow-up').then(function (f) {
        q.followUp = f; drawFollow(); loadMe();
        fb.innerHTML = ICON.spark + ' Write another';
      }).catch(function (e) { fb.innerHTML = ICON.spark + ' Draft a follow-up'; showError(e); }).then(function () { fb.disabled = false; });
    };

    var sv = $('#saveBtn'); if (sv) sv.onclick = function () { save().then(function () { toast('Saved.'); }); };
    var sd = $('#sendBtn'); if (sd) sd.onclick = send;
    var sh = $('#shareBtn'); if (sh) sh.onclick = function () { openShare(); };
    $('#dupBtn').onclick = function () {
      (dirty ? save() : Promise.resolve()).then(function () { return api('POST', 'api/quotes/' + q.id + '/duplicate'); })
        .then(function (c) { toast('Duplicated as ' + c.number + '.'); location.hash = '#/quote/' + c.id; }).catch(function (e) { showError(e); });
    };
    $('#tplBtn').onclick = function () {
      var name = prompt('Name this template:', ed.title);
      if (!name) return;
      (dirty ? save() : Promise.resolve()).then(function () { return api('POST', 'api/quotes/' + q.id + '/template', { name: name }); })
        .then(function () { state.templates = null; toast('Saved as a template. Find it under New quote.'); }).catch(function (e) { showError(e); });
    };
    var mark = function (status) {
      return function () {
        var body = { status: status };
        if (status === 'accepted' && ed.tiers) {
          var pick = prompt('Which option did they choose? (good / better / best)', 'better');
          if (!pick) return; body.tier = pick.trim().toLowerCase();
        } else if (!confirm(status === 'accepted' ? 'Mark this quote as won?' : status === 'declined' ? 'Mark this quote as lost?' : 'Reopen this quote?')) return;
        api('POST', 'api/quotes/' + q.id + '/mark', body).then(function (r) {
          q = r; ed = clone(r); dirty = false; drawEditor();
          if (status === 'accepted') confetti();
        }).catch(function (e) { showError(e); });
      };
    };
    var w = $('#wonBtn'); if (w) w.onclick = mark('accepted');
    var lo = $('#lostBtn'); if (lo) lo.onclick = mark('declined');
    var ro = $('#reopenBtn'); if (ro) ro.onclick = mark('sent');
    $('#delBtn').onclick = function () {
      if (!confirm('Delete ' + q.number + '?' + (q.publicUrl ? ' Its link will stop working.' : ''))) return;
      api('DELETE', 'api/quotes/' + q.id).then(function () { dirty = false; toast('Deleted.'); location.hash = '#/quotes'; }).catch(function (e) { showError(e); });
    };
  }

  function drawItemsAmounts() {
    var items = listItems();
    $$('#items .item').forEach(function (row) {
      var it = items[Number(row.dataset.i)]; if (!it) return;
      var l = priceLine(it, ed.markupPct);
      $('[data-amt]', row).textContent = money(l.price);
      $('[data-cost]', row).textContent = l.marked && ed.markupPct ? 'cost ' + money(l.cost) : '';
    });
  }

  function save() {
    var s = $('#saveState'); if (s) { s.textContent = 'Saving…'; s.className = ''; }
    return api('PUT', 'api/quotes/' + q.id, payload()).then(function (r) {
      q = r; dirty = false;
      // The server's arithmetic is the record; put its cleaned lines back.
      ed.items = clone(r.items); ed.tiers = r.tiers ? clone(r.tiers) : null;
      drawItems(); drawTierTabs(); refreshTotals();
      if (s) { s.textContent = 'All changes saved'; s.className = ''; }
      return r;
    }).catch(function (e) { if (s) { s.textContent = 'Not saved'; s.className = 'dirty'; } showError(e); throw e; });
  }

  function send() {
    var btn = $('#sendBtn'); btn.disabled = true;
    (dirty ? save() : Promise.resolve()).then(function () {
      var wasSent = Boolean(q.sentAt) && q.status !== 'changes' && q.status !== 'expired';
      return (wasSent ? Promise.resolve(q) : api('POST', 'api/quotes/' + q.id + '/send')).then(function (r) {
        var first = !q.sentAt;
        q = r; ed = clone(r); dirty = false;
        drawEditor();
        openShare(first);
      });
    }).catch(function (e) { showError(e); }).then(function () { var b = $('#sendBtn'); if (b) b.disabled = false; });
  }

  function openShare(first) {
    var link = location.origin + BASE + q.publicUrl;
    var p = profile();
    var first_ = (q.customer.name || '').split(' ')[0];
    var msg = 'Hi' + (first_ ? ' ' + first_ : '') + ', here’s your quote for ' + q.title + (p.name ? ' from ' + p.name : '') + '. You can pick an option and accept it right from your phone: ' + link;
    var phone = /[0-9]{3}/.test(q.customer.contact || '') && !/@/.test(q.customer.contact || '') ? q.customer.contact.replace(/[^0-9+]/g, '') : '';
    var email = /@/.test(q.customer.contact || '') ? q.customer.contact : '';
    sheet('<h2>' + (first ? '🚀 Quote ready to send' : 'Share this quote') + '</h2>' +
      '<p class="muted small">' + (first ? 'The clock is running — valid until ' : 'Valid until ') + esc(dateFmt(q.validUntil)) + '. You’ll see here when they open it.</p>' +
      '<div class="share-link"><span>' + esc(link) + '</span><button class="btn small" id="cpy">Copy</button></div>' +
      '<div class="share-grid">' +
      '<a href="sms:' + esc(phone) + '?&body=' + encodeURIComponent(msg) + '"><span class="e">💬</span>Text</a>' +
      '<a href="mailto:' + esc(email) + '?subject=' + encodeURIComponent('Your quote: ' + q.title) + '&body=' + encodeURIComponent(msg) + '"><span class="e">✉️</span>Email</a>' +
      (navigator.share ? '<button id="natShare"><span class="e">📤</span>More…</button>' : '<a href="' + esc(link) + '" target="_blank" rel="noopener"><span class="e">👀</span>Preview</a>') +
      '</div>' +
      (navigator.share ? '<a class="btn ghost block" style="margin-top:12px" href="' + esc(link) + '" target="_blank" rel="noopener">Preview as your customer</a>' : ''),
      function (root) {
        $('#cpy', root).onclick = function () { copy(link); };
        var ns = $('#natShare', root);
        if (ns) ns.onclick = function () { navigator.share({ title: q.title, text: msg.replace(link, '').trim(), url: link }).catch(function () { /* cancelled */ }); };
      });
    if (first) confetti();
  }

  /* ---------------- scoreboard ---------------- */

  function renderStats() {
    if (!signedIn()) return signedOutPitch('🏆', 'Your win rate, front and center', 'Every quote you send is tracked: win rate, money won, how fast you quote, and a weekly streak to keep you quick.');
    loading();
    api('GET', 'api/stats').then(function (s) {
      var c = 2 * Math.PI * 54;
      var wr = s.winRate == null ? 0 : s.winRate;
      var weeksOn = s.chart.map(function (w) { return w.count > 0; });
      view.innerHTML =
        '<div class="page-head"><div><h1>Scoreboard</h1><div class="sub">' + (s.sentThisWeek ? s.sentThisWeek + ' sent this week — keep it rolling.' : 'Send one this week to keep the streak alive.') + '</div></div></div>' +
        '<div class="score-top">' +
        '<div class="card ringbox"><div class="ring"><svg viewBox="0 0 132 132"><circle cx="66" cy="66" r="54" fill="none" stroke="var(--fill2)" stroke-width="12"/>' +
        '<circle cx="66" cy="66" r="54" fill="none" stroke="url(#rg)" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + c + '" id="ringArc" style="transition:stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)"/>' +
        '<defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent2)"/></linearGradient></defs></svg>' +
        '<div class="val"><b>' + (s.winRate == null ? '—' : s.winRate + '%') + '</b><span>win rate</span></div></div>' +
        '<div class="small muted" style="margin-top:8px">' + s.won + ' won of ' + s.decided + ' decided</div></div>' +
        '<div class="card streak-card"><div><div class="flame">🔥</div><b>' + s.streakWeeks + '</b><span>week' + (s.streakWeeks === 1 ? '' : 's') + ' in a row with a quote out</span></div>' +
        '<div class="wk" title="Last 8 weeks">' + weeksOn.map(function (on) { return '<i class="' + (on ? 'on' : '') + '"></i>'; }).join('') + '</div></div></div>' +
        '<div class="kgrid">' +
        kstat('💵', 'Total won', money0(s.totalWon), s.won + ' job' + (s.won === 1 ? '' : 's')) +
        kstat('📤', 'Total quoted', money0(s.totalQuoted), s.sent + ' sent') +
        kstat('⏳', 'Pipeline', money0(s.pipelineValue), 'open and unexpired') +
        kstat('📏', 'Average quote', money0(s.averageQuote), 'across sent quotes') +
        kstat('⚡', 'Time to send', durationFmt(s.avgMinutesToSend), 'from draft to sent') +
        kstat('🗂️', 'Quotes', String(s.quotes), (s.byStatus.draft || 0) + ' in draft') +
        '</div>' +
        '<div class="card" style="margin-top:12px"><div class="card-head"><h3>Last 8 weeks</h3><div class="chart-legend"><span><i style="background:var(--c-quoted)"></i>Quoted</span><span><i style="background:var(--c-won)"></i>Won</span></div></div>' +
        '<div class="chart" id="chart"></div><p class="tiny faint" style="margin:8px 0 0">By the week each quote was sent, so “won” is always part of “quoted”.</p></div>' +
        '<div class="card" style="margin-top:12px"><div class="card-head"><h3>Where your quotes are</h3></div>' + statusBar(s.byStatus) + '</div>' +
        (s.sent ? '' : '<div class="banner" style="margin-top:12px"><span class="e">💡</span><div>Your scoreboard fills in as you send quotes. <a href="#/new">Snap one now</a>.</div></div>');
      requestAnimationFrame(function () { var a = $('#ringArc'); if (a) a.style.strokeDashoffset = c * (1 - wr / 100); });
      // Drawn at the container's real width, so 11px labels are 11px on a
      // phone and on a monitor rather than scaling with the viewBox.
      var drawChart = function () { var el = $('#chart'); if (!el) return window.removeEventListener('resize', drawChart); el.innerHTML = barChart(s.chart, el.clientWidth); wireChart(s.chart); };
      drawChart();
      window.addEventListener('resize', drawChart);
    }).catch(function (e) { showError(e, view); });
  }

  function kstat(icon, label, value, sub) {
    return '<div class="kstat"><div class="l">' + icon + ' ' + esc(label) + '</div><div class="v">' + esc(value) + '</div><div class="s">' + esc(sub) + '</div></div>';
  }

  /** Grouped bars: quoted vs won per week. One axis, rounded data-ends on the
   *  baseline, 2px gap between the pair, a hover tooltip per week. */
  function barChart(rows, width) {
    var W = Math.max(280, Math.round(width || 640)), H = W < 500 ? 200 : 240, padL = 44, padR = 8, padT = 12, padB = 26;
    var max = Math.max.apply(null, rows.map(function (r) { return r.quoted; }).concat([1]));
    var step = Math.pow(10, Math.floor(Math.log10(max)));
    var nice = Math.ceil(max / step) * step; if (nice / step > 5) step *= 2; nice = Math.ceil(max / step) * step;
    var ih = H - padT - padB, iw = W - padL - padR;
    var y = function (v) { return padT + ih - (v / nice) * ih; };
    var gw = iw / rows.length, bw = Math.max(6, Math.min(26, (gw - 16) / 2));
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Quoted and won value by week, last 8 weeks">';
    for (var g = 0; g <= nice; g += step) {
      out += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(g) + '" y2="' + y(g) + '" stroke="var(--line)"/>' +
        '<text x="' + (padL - 8) + '" y="' + (y(g) + 4) + '" text-anchor="end" font-size="11" fill="var(--faint)">' + moneyShort(g) + '</text>';
    }
    var bar = function (x, v, color) {
      if (!v) return '';
      var top = y(v), h = padT + ih - top, r = Math.min(4, h);
      // Rounded top, square foot on the baseline.
      return '<path d="M' + x + ',' + (padT + ih) + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + r) + 'V' + (padT + ih) + 'Z" fill="' + color + '"/>';
    };
    rows.forEach(function (r, i) {
      var cx = padL + gw * i + gw / 2;
      out += bar(cx - bw - 1, r.quoted, 'var(--c-quoted)') + bar(cx + 1, r.won, 'var(--c-won)');
      var d = new Date(r.week + 'T00:00:00Z');
      if (W >= 500 || i % 2 === 1) out += '<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="var(--faint)">' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + '</text>';
      out += '<rect class="hit" data-w="' + i + '" x="' + (padL + gw * i) + '" y="' + padT + '" width="' + gw + '" height="' + ih + '" rx="6"/>';
    });
    out += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (padT + ih) + '" y2="' + (padT + ih) + '" stroke="var(--fill2)"/></svg>';
    return out;
  }

  function wireChart(rows) {
    var box = $('#chart'); if (!box) return;
    var tip = document.createElement('div'); tip.className = 'chart-tip hidden'; box.appendChild(tip);
    $$('.hit', box).forEach(function (h) {
      var show = function () {
        var r = rows[Number(h.dataset.w)];
        var bb = h.getBoundingClientRect(), cb = box.getBoundingClientRect();
        tip.innerHTML = '<div>Week of ' + esc(new Date(r.week + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })) + '</div>' +
          '<div><i style="background:var(--c-quoted)"></i>Quoted ' + money0(r.quoted) + ' · ' + r.count + '</div><div><i style="background:var(--c-won)"></i>Won ' + money0(r.won) + '</div>';
        tip.style.left = Math.max(70, Math.min(cb.width - 70, bb.left - cb.left + bb.width / 2)) + 'px';
        tip.style.top = (bb.top - cb.top + 8) + 'px';
        tip.classList.remove('hidden');
      };
      h.addEventListener('mouseenter', show);
      h.addEventListener('click', show);
      h.addEventListener('mouseleave', function () { tip.classList.add('hidden'); });
    });
  }

  function statusBar(by) {
    var parts = [['draft', 'Draft', 'var(--faint)'], ['sent', 'Sent', 'var(--blue)'], ['viewed', 'Viewed', 'var(--violet)'], ['changes', 'Changes', 'var(--warn)'], ['accepted', 'Won', 'var(--good)'], ['declined', 'Declined', 'var(--bad)'], ['expired', 'Expired', 'var(--faint)']];
    var total = parts.reduce(function (a, p) { return a + (by[p[0]] || 0); }, 0);
    if (!total) return '<p class="small muted" style="margin:0">No quotes yet.</p>';
    return '<div class="stack-bar">' + parts.filter(function (p) { return by[p[0]]; }).map(function (p) {
      return '<i style="width:' + (by[p[0]] / total * 100) + '%;background:' + p[2] + '" title="' + p[1] + ': ' + by[p[0]] + '"></i>';
    }).join('') + '</div><div class="legend">' + parts.filter(function (p) { return by[p[0]]; }).map(function (p) {
      return '<span><i style="background:' + p[2] + '"></i>' + p[1] + ' <b style="color:var(--text)">' + by[p[0]] + '</b></span>';
    }).join('') + '</div>';
  }

  /* ---------------- business ---------------- */

  var SWATCHES = ['#0fb58a', '#0891b2', '#2563eb', '#4f46e5', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#15803d', '#334155', '#111827'];
  var LOGOS = ['🎨', '🌿', '🔧', '🧽', '🏠', '🚰', '⚡', '📷', '🎉', '🪚', '🧱', '🪴', '🛠️', '✨', '🌊', '☀️'];

  function renderBusiness() {
    if (!signedIn()) return signedOutPitch('🏷️', 'Your brand on every quote', 'Name, logo, colors, license number, rates and terms — set once, on every quote you send.');
    var p = clone(profile());
    var meta = state.meta || { trades: {} };
    view.innerHTML =
      '<div class="page-head"><div><h1>Business</h1><div class="sub">How every quote looks and adds up.</div></div></div>' +
      '<div class="dk-2"><div>' +
      '<div class="brand-preview" id="bprev"></div>' +
      '<div class="group-title">Identity</div><div class="group">' +
      '<div class="cell"><label for="bName">Business name</label><input id="bName" maxlength="60" placeholder="Brightline Painting Co." value="' + esc(p.name) + '"></div>' +
      '<div class="cell"><label for="bTrade">Trade</label><select id="bTrade">' + Object.keys(meta.trades).map(function (k) { return '<option value="' + k + '"' + (k === p.trade ? ' selected' : '') + '>' + meta.trades[k].emoji + ' ' + esc(meta.trades[k].label) + '</option>'; }).join('') + '</select></div>' +
      '<div class="cell"><label for="bLogo">Logo</label><input id="bLogo" maxlength="4" placeholder="Emoji or initials" value="' + esc(p.logo) + '"></div>' +
      '<div class="logos" id="logos">' + LOGOS.map(function (l) { return '<button data-logo="' + l + '" class="' + (l === p.logo ? 'on' : '') + '">' + l + '</button>'; }).join('') + '</div>' +
      '<div class="cell" style="border-top:1px solid var(--line)"><span class="lbl">Brand color</span></div>' +
      '<div class="swatches" id="swatches">' + SWATCHES.map(function (c) { return '<button data-c="' + c + '" style="background:' + c + '" class="' + (c === p.color ? 'on' : '') + '" aria-label="' + c + '"></button>'; }).join('') +
      '<label title="Custom color"><input type="color" id="bColor" value="' + esc(p.color) + '"></label></div></div>' +
      '<div class="group-title">Contact (shown on quotes)</div><div class="group">' +
      '<div class="cell"><label for="bPhone">Phone</label><input id="bPhone" type="tel" maxlength="30" placeholder="(555) 555-0100" value="' + esc(p.phone) + '"></div>' +
      '<div class="cell"><label for="bEmail">Email</label><input id="bEmail" type="email" maxlength="120" placeholder="hello@yourbusiness.com" value="' + esc(p.email) + '"></div>' +
      '<div class="cell"><label for="bLic">License #</label><input id="bLic" maxlength="40" placeholder="Optional" value="' + esc(p.license) + '"></div></div>' +
      '</div><div class="dk-sticky">' +
      '<div class="group-title">Money</div><div class="group">' +
      '<div class="cell"><label for="bRate">Hourly rate</label><input id="bRate" inputmode="decimal" value="' + esc(p.hourlyRate) + '"><span class="unit">$/hr</span></div>' +
      '<div class="cell"><label for="bMarkup">Markup</label><input id="bMarkup" inputmode="decimal" value="' + esc(p.markupPct) + '"><span class="unit">%</span></div>' +
      '<div class="cell"><label for="bTax">Sales tax</label><input id="bTax" inputmode="decimal" value="' + esc(p.taxPct) + '"><span class="unit">%</span></div>' +
      '<div class="cell"><label for="bValid">Quotes valid</label><input id="bValid" inputmode="numeric" value="' + esc(p.validDays) + '"><span class="unit">days</span></div></div>' +
      '<p class="hint">Markup is added to materials, equipment and other lines — never to labor, which your rate already covers. Customers see the marked-up price only.</p>' +
      '<div class="group-title">Payment terms</div><div class="group"><div class="cell stack"><textarea id="bTerms" maxlength="400" rows="3">' + esc(p.terms) + '</textarea></div></div>' +
      '<div id="bErr"></div><button class="btn block lg" id="bSave" style="margin-top:16px">Save</button>' +
      '<div class="group-title">Account</div><div class="card"><div class="row spread"><div><b class="small">' + esc(state.me.email) + '</b><div class="tiny muted">' + (state.me.tier === 'paid' ? 'Member · Sonnet' : 'Free · Haiku') + '</div></div><button class="btn small ghost" id="acct">Manage</button></div></div>' +
      '</div></div>';

    var preview = function () {
      var ink = inkFor(p.color);
      $('#bprev').innerHTML = '<div class="qdoc" style="--brand:' + esc(p.color) + ';--brand-ink:' + ink + ';border-radius:0;border:0;box-shadow:none"><div class="qd-head"><div class="qd-biz"><div class="qd-logo">' + esc(p.logo || initials(p.name || 'Your Business')) + '</div><div><h2>' + esc(p.name || 'Your business name') + '</h2>' +
        '<div class="sub">' + [(meta.trades[p.trade] || {}).label, p.license].filter(Boolean).map(esc).join(' · ') + '</div></div></div>' +
        '<div class="qd-contact">' + (p.phone ? '<a>' + ICON.phone + esc(p.phone) + '</a>' : '') + (p.email ? '<a>' + ICON.mail + esc(p.email) + '</a>' : '') + (!p.phone && !p.email ? '<a>This is how your quotes will look</a>' : '') + '</div></div></div>';
    };
    preview();
    var bind = function (sel, key, ev) { $(sel).addEventListener(ev || 'input', function (e) { p[key] = e.target.value; preview(); }); };
    bind('#bName', 'name'); bind('#bTrade', 'trade', 'change'); bind('#bLogo', 'logo'); bind('#bPhone', 'phone'); bind('#bEmail', 'email'); bind('#bLic', 'license');
    bind('#bRate', 'hourlyRate'); bind('#bMarkup', 'markupPct'); bind('#bTax', 'taxPct'); bind('#bValid', 'validDays'); bind('#bTerms', 'terms');
    $$('[data-logo]').forEach(function (b) { b.onclick = function () { p.logo = b.dataset.logo; $('#bLogo').value = p.logo; $$('[data-logo]').forEach(function (x) { x.classList.toggle('on', x === b); }); preview(); }; });
    $$('[data-c]').forEach(function (b) { b.onclick = function () { p.color = b.dataset.c; $('#bColor').value = p.color; $$('[data-c]').forEach(function (x) { x.classList.toggle('on', x === b); }); preview(); }; });
    $('#bColor').addEventListener('input', function (e) { p.color = e.target.value; $$('[data-c]').forEach(function (x) { x.classList.remove('on'); }); preview(); });
    $('#acct').onclick = function () { openProfileSheet(); };
    $('#bSave').onclick = function () {
      var btn = this; btn.disabled = true;
      api('PUT', 'api/profile', p).then(function (np) {
        state.me.profile = np; drawTop(); toast('Saved. Every quote wears it now.');
        if (!state.nf) state.nf = null;
      }).catch(function (e) { showError(e, $('#bErr')); }).then(function () { btn.disabled = false; });
    };
  }

  /* ---------------- boot ---------------- */

  // Stripe sends buyers back with a flag; say thank you once and tidy the URL.
  var qs = new URLSearchParams(location.search);
  if (qs.get('member') || qs.get('credited')) {
    setTimeout(function () { toast(qs.get('member') ? 'Welcome, member. The better model is on.' : 'Credit added.'); }, 400);
    history.replaceState(null, '', location.pathname + location.hash);
  }
  var topup = qs.get('topup');

  // Inside the lab, a way back to it. Never on a customer's quote page.
  if (BASE !== '/' && !PUB) {
    var lab = document.createElement('a');
    lab.href = '/'; lab.className = 'pill'; lab.textContent = '🧪 Lab'; lab.style.textDecoration = 'none'; lab.style.color = 'var(--muted)';
    lab.title = 'Back to the challenge lab';
    var brandEl = document.querySelector('.top .brand');
    brandEl.parentNode.insertBefore(lab, brandEl.nextSibling);
  }

  if (PUB) {
    route();
  } else {
    Promise.all([loadMe(), loadMeta()]).then(function () {
      route();
      if (topup) { history.replaceState(null, '', location.pathname + location.hash); signedIn() ? openProfileSheet() : openAccount(); }
    });
  }
})();
