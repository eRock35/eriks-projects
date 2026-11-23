/* Snapquote - the page. One file, no build step, every model-written string
   escaped. No style attribute is ever written: a colour or a width that is
   only known at run time rides on data-css as custom properties, and the
   observer below sets them through the CSSOM (see paint). */
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

  var state = { me: null, meta: null, templates: null, nf: null, read: null, justDrafted: null };

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Run-time values for CSS, as custom properties only: css({ brand: '#123' })
   *  -> data-css="--brand:#123". Nothing but a `--name` is ever applied. */
  function css(o) {
    return ' data-css="' + esc(Object.keys(o).map(function (k) { return '--' + k + ':' + String(o[k]).replace(/[;"<>]/g, ''); }).join(';')) + '"';
  }
  function paint(el) {
    String(el.getAttribute('data-css') || '').split(';').forEach(function (d) {
      var i = d.indexOf(':');
      if (i > 2 && d.slice(0, 2) === '--') el.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim());
    });
  }
  new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType !== 1) return;
        if (n.hasAttribute('data-css')) paint(n);
        $$('[data-css]', n).forEach(paint);
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

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
    if (where) { where.innerHTML = '<div class="err" role="alert">' + esc(msg) + '</div>'; } else { toast(msg, 3500); }
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
  function clock(secs) { secs = Math.max(0, Math.round(secs)); return Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2); }
  function initials(name) {
    return String(name || '?').split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
  }
  /** Readable ink on a brand color: whichever of near-black and white has the
   *  higher contrast with it (they cross at a luminance of about 0.18). */
  function inkFor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#ffffff';
    var n = parseInt(m[1], 16);
    var ch = [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    var L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    return L > 0.179 ? '#0b1210' : '#ffffff';
  }
  function brandCss(color) { return css({ brand: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#0fb58a', 'brand-ink': inkFor(color || '#0fb58a') }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function confetti(colors) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var box = document.createElement('div');
    box.className = 'confetti';
    colors = colors || ['#10b981', '#06b6d4', '#34d399', '#0ea5e9', '#a7f3d0', '#047857'];
    for (var i = 0; i < 60; i++) {
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

  // One family of line icons: 24px box, 1.5px stroke, round joins.
  function ico(d, cls) { return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>'; }
  var ICON = {
    back: ico('<path d="m15 18-6-6 6-6"/>'),
    eye: ico('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
    up: ico('<path d="m18 15-6-6-6 6"/>'),
    down: ico('<path d="m6 9 6 6 6-6"/>'),
    x: ico('<path d="M18 6 6 18M6 6l12 12"/>'),
    plus: ico('<path d="M12 5v14M5 12h14"/>'),
    chev: ico('<path d="m9 6 6 6-6 6"/>'),
    phone: ico('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/>'),
    mail: ico('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'),
    mic: ico('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/>'),
    stop: ico('<rect x="7" y="7" width="10" height="10" rx="2"/>'),
    cam: ico('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>'),
    spark: ico('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2.3 2.3.7-2.3.7L19 21l-.7-2.3-2.3-.7 2.3-.7z"/>'),
    send: ico('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
    lock: ico('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    check: ico('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    chat: ico('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>'),
    share: ico('<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
    flame: ico('<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-1.8.8-3 1.8-4 .2 1.5 1 2.4 2 2.8C10.5 9 11 6 12 3Z"/>'),
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
  /** "Read the job" (photos + a voice note -> line items) is switched on. */
  function voiceOn() { return Boolean(state.me && state.me.voice); }
  function voiceSecs() { return (state.meta && state.meta.maxVoiceSeconds) || 60; }
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
      el.innerHTML = '<button class="btn small quiet" id="signInTop" type="button">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var b = me.budget || {};
    var p = me.profile || {};
    el.innerHTML =
      '<span class="credit num" title="AI credit left">' + (b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span>' +
      '<button class="avatar-btn" id="acctBtn" type="button" aria-label="Account"' + brandCss(p.color) + '><span>' + logoHtml(p) + '</span></button>';
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
    document.body.classList.add('sheet-open');
    if (onMount) onMount(scrim.firstChild);
    return scrim.firstChild;
  }
  function closeSheet() { var s = $('#scrim'); if (s) s.remove(); document.body.classList.remove('sheet-open'); }
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
        '<button class="btn lg block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button>' +
        '</form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block mt12" id="pkBtn" type="button">Sign in with Face ID / passkey</button>' : '') +
        '<p class="center small muted mt16">' +
        (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') +
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
      '<h2>' + esc(profile().name || 'Your account') + '</h2>' +
      '<p class="muted small">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'Member model (Sonnet)' : 'Free model (Haiku)') + '</p>' +
      '<div class="card my16"><div class="row spread"><b>AI credit</b><span class="num">' + remaining + '</span></div>' +
      '<div class="bar mt12"><i' + css({ w: pct + '%' }) + '></i></div>' +
      '<p class="small muted mt12 mb0">' + (voiceOn() ? 'Reading a job from photos and a voice note, or drafting a whole quote, costs about 1–2¢.' : 'Drafting a quote from photos costs about 1–2¢.') + ' Polishing and follow-ups well under a cent. Editing, sending, templates and the customer page are free.</p>' +
      '<div id="billing" class="mt12"></div></div>' +
      '<a class="btn ghost block" href="#/business" id="bizLink">Business profile</a>' +
      (pkOk() ? '<button class="btn ghost block mt8" id="pkEnrol" type="button">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block mt8" id="signOut" type="button">Sign out</button>',
      function (root) {
        $('#bizLink', root).onclick = function () { closeSheet(); };
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); return loadMe(); }).then(function () { state.templates = null; state.nf = null; state.read = null; location.hash = '#/'; route(); });
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
        el.innerHTML = '<button class="btn small" id="joinM" type="button">Become a member · $' + esc(b.monthlyUsd) + '/mo</button>' +
          '<p class="small muted mt8 mb0">Membership covers every app on this site, runs the better model, and lets you add credit.</p>';
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
    stopRecording(true);
    if (PUB) return renderPublic(PUB[1]);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/');
    var tab = parts[0] || 'quotes';
    $$('#tabbar button').forEach(function (b) {
      var t = b.dataset.tab;
      var on = t === tab || (t === 'quotes' && (tab === 'quote' || tab === 'sample')) || (t === 'new' && tab === 'review');
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    document.body.classList.toggle('has-bar', tab === 'quote' || tab === 'review');
    if (tab === 'quote' && parts[1]) return renderEditor(parts[1]);
    if (tab === 'sample') return renderSample();
    if (tab === 'new') return renderNew();
    if (tab === 'review') return renderReview();
    if (tab === 'stats') return renderStats();
    if (tab === 'business') return renderBusiness();
    return signedIn() ? renderPipeline() : renderHome();
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () { location.hash = '#/' + b.dataset.tab; };
  });
  window.addEventListener('hashchange', route);

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner"></span></div>'; }

  function signedOutPitch(title, body) {
    view.innerHTML = '<section class="hero slim"><h1>' + esc(title) + '</h1><p class="lede">' + esc(body) + '</p>' +
      '<div class="ctas"><button class="btn lg" id="pitchGo" type="button">Start free</button><a class="btn lg ghost" href="#/sample">See a sample quote</a></div></section>';
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
        return '<span class="chip still">' + esc(state.meta.trades[k].label) + '</span>';
      }).join('') : '';
      view.innerHTML =
        '<section class="hero">' +
        '<p class="eyebrow">The first quote in usually wins</p>' +
        '<h1>Snap the job.<br>Send the quote.</h1>' +
        '<p class="lede">A few photos and a voice note become an itemized quote with your rates, markup and tax — before you’re back in the truck.</p>' +
        '<div class="ctas"><button class="btn lg" id="heroGo" type="button">Try it free</button><a class="btn lg ghost" href="#/sample">See a sample quote</a></div>' +
        '<p class="trust">$2 free credit · No card · Photos and recordings never stored</p>' +
        '</section>' +
        '<a class="mini-quote" href="#/sample"' + brandCss(b.color) + ' aria-label="Open the sample quote">' +
        '<div class="mq-head"><span class="mq-logo">' + esc(b.logo) + '</span><span class="grow"><b>' + esc(b.name) + '</b><small>' + esc(d.number) + ' · ' + esc(d.title) + '</small></span><span class="status st-accepted">Accepted</span></div>' +
        lines.map(function (l) { return '<div class="mq-line"><span>' + esc(l.description) + '</span><b class="num">' + money0(l.price) + '</b></div>'; }).join('') +
        '<div class="mq-total"><span>Total' + (tier ? ' · ' + esc(tier.label) : '') + '</span><b class="num">' + money(total) + '</b></div></a>' +
        '<section class="section"><ol class="steps">' +
        '<li><span class="n">1</span><div><h3>Snap</h3><p>Up to four photos of the job. Shrunk on your phone, read once, never kept.</p></div></li>' +
        '<li><span class="n">2</span><div><h3>Say it</h3><p>Talk it through like you’d brief a helper: rooms, sizes, condition, what they want.</p></div></li>' +
        '<li><span class="n">3</span><div><h3>Send and get signed</h3><p>Check every line, then text a branded link. They pick an option and sign. You see when they open it.</p></div></li>' +
        '</ol></section>' +
        '<section class="section center"><h2>Built for the trades</h2><div class="chips center-row">' + trades + '</div></section>' +
        '<section class="section cta-band"><h2>Your next quote, in about a minute.</h2><p class="muted">Every quote tracked on a pipeline, with a win-rate scoreboard and a weekly streak to keep you quick.</p>' +
        '<button class="btn lg" id="bandGo" type="button">Create a free account</button></section>';
      $('#heroGo').onclick = function () { openAccount(); };
      $('#bandGo').onclick = function () { openAccount(); };
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- the customer's quote (and the sample) ---------------- */

  var CAT_ORDER = ['labor', 'material', 'equipment', 'other'];
  var CATS = { labor: { label: 'Labor' }, material: { label: 'Materials' }, equipment: { label: 'Equipment' }, other: { label: 'Other' } };

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
    var lines = (p.items || []).map(function (l) { return { l: l, isNew: false }; })
      .concat(tier ? tier.items.map(function (l) { return { l: l, isNew: true }; }) : []);

    var h = '<article class="qdoc"' + brandCss(b.color) + '>' +
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
      h += '<h3 class="qd-h">Choose your option</h3><div class="qd-tiers">' + p.tiers.map(function (t) {
        return '<button type="button" class="qd-tier' + (t.key === p._sel ? ' on' : '') + '" data-tier="' + esc(t.key) + '" aria-pressed="' + (t.key === p._sel) + '">' +
          '<span class="radio"></span>' +
          '<span class="nm">' + esc({ good: 'Good', better: 'Better', best: 'Best' }[t.key] || t.key) + (t.key === p.recommended ? ' <span class="rec">Most popular</span>' : '') + '</span><span class="lb">' + esc(t.label) + '</span>' +
          '<span class="pr num">' + money(t.totals && t.totals.total) + '</span><span class="sm">' + esc(t.summary) + '</span></button>';
      }).join('') + '</div>';
    }

    h += '<h3 class="qd-h">What’s included' + (tier ? ' · ' + esc(tier.label) : '') + '</h3>';
    CAT_ORDER.forEach(function (c) {
      var rows = lines.filter(function (x) { return x.l.category === c; });
      if (!rows.length) return;
      var sum = rows.reduce(function (a, x) { return a + x.l.price; }, 0);
      h += '<div class="qd-group"><h4><span>' + CATS[c].label + '</span><span class="num">' + money(sum) + '</span></h4>' + rows.map(function (x) {
        var l = x.l;
        return '<div class="qd-line' + (x.isNew ? ' new' : '') + '"><div class="d">' + esc(l.description) + '</div><div class="a num">' + money(l.price) + '</div>' +
          '<div class="q num">' + esc(l.qty) + ' ' + esc(l.unit) + ' × ' + money(l.unitPrice) + '</div></div>';
      }).join('') + '</div>';
    });

    if (totals) {
      h += '<div class="qd-totals num"><div class="r"><span>Subtotal</span><span>' + money(totals.subtotal) + '</span></div>' +
        (totals.discount ? '<div class="r"><span>Discount</span><span>−' + money(totals.discount) + '</span></div>' : '') +
        (totals.tax ? '<div class="r"><span>Tax (' + esc(p.taxPct) + '%)</span><span>' + money(totals.tax) + '</span></div>' : '') +
        '<div class="r t"><span>Total</span><span>' + money(totals.total) + '</span></div></div>';
    }

    var boxes = '';
    if (p.timeline) boxes += '<div class="qd-box"><h5>Timeline</h5><p>' + esc(p.timeline) + '</p></div>';
    if (p.terms) boxes += '<div class="qd-box"><h5>Payment terms</h5><p>' + esc(p.terms) + '</p></div>';
    if ((p.assumptions || []).length) boxes += '<div class="qd-box"><h5>Assumptions</h5><ul>' + p.assumptions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    if ((p.exclusions || []).length) boxes += '<div class="qd-box"><h5>Not included</h5><ul>' + p.exclusions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
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
      return '<div class="qd-stamp"><div class="ok">' + ICON.check + '</div><h3>Accepted</h3><div class="sig">' + esc(r.name) + '</div>' +
        '<div class="small muted">' + esc(dateFmt(r.at, { month: 'long', day: 'numeric', year: 'numeric' })) + (tl ? ' · ' + esc(tl) : '') + '</div>' +
        '<p class="small muted mt12 mb0">' + esc(b.name) + ' can see your acceptance and will be in touch to schedule.</p></div>';
    }
    if (p.status === 'declined') {
      return '<div class="qd-stamp off"><h3>Declined</h3><p class="small muted mt8 mb0">Changed your mind? Get in touch with ' + esc(b.name) + '.</p></div>';
    }
    if (p.status === 'expired') {
      return '<div class="qd-stamp off"><h3>This quote has expired</h3><p class="small muted mt8 mb0">It was valid until ' + esc(dateFmt(p.validUntil)) + '. Prices may have changed — ask ' + esc(b.name) + ' for an updated one.</p></div>';
    }
    var who = opts.preview ? '<div class="note mb12"><div>This is your preview — exactly what your customer sees. They accept or ask for changes here.</div></div>' : '';
    var asked = p.status === 'changes' ? '<div class="note warn mb12"><div>You asked for changes. ' + esc(b.name) + ' will send an update — or you can accept this version now.</div></div>' : '';
    return '<div class="qd-respond">' + who + asked + '<h3>Ready to go ahead?</h3>' +
      '<p class="small muted">' + (p.tiers ? 'You’ve chosen <b>' + esc(tier ? tier.label : '') + '</b>. ' : '') + 'Type your full name to sign. By accepting you agree to the scope and terms above.</p>' +
      '<label class="vh" for="sigName">Your full name</label><input class="input sig" id="sigName" placeholder="Your full name" autocomplete="name" value="' + esc(p._name || '') + '"' + (opts.preview ? ' disabled' : '') + '>' +
      '<div id="accErr"></div>' +
      '<button type="button" class="btn lg block qd-accept mt12" id="acceptBtn"' + (opts.preview ? ' disabled' : '') + '>Accept · ' + money(totals && totals.total) + '</button>' +
      '<div class="row center-row mt12"><button type="button" class="link-btn" id="chgBtn">Request changes</button><button type="button" class="link-btn quiet" id="decBtn">Decline</button></div>' +
      '<div id="chgBox" class="hidden mt12"><label class="vh" for="chgText">What would you like changed?</label><textarea class="input" id="chgText" maxlength="1000" placeholder="What would you like changed? e.g. “Can you add the upstairs hallway?”"></textarea>' +
      '<button type="button" class="btn block ghost mt8" id="chgSend">Send to ' + esc(b.name) + '</button></div></div>';
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
      if (!/\S+\s+\S+/.test(name)) { $('#accErr', root).innerHTML = '<div class="err" role="alert">Type your full name — first and last — to sign.</div>'; $('#sigName', root).focus(); return; }
      acc.disabled = true; acc.innerHTML = '<span class="spinner"></span>';
      post('accept', { name: name, tier: p._sel || null }).then(function (np) {
        np._sel = p._sel; Object.keys(p).forEach(function (k) { delete p[k]; }); Object.assign(p, np);
        drawDoc(root, p, opts); confetti([p.business.color, '#34d399', '#06b6d4', '#a7f3d0']);
        $('#respond', root).scrollIntoView({ block: 'center' });
      }).catch(function (e) {
        if (e.demo) {
          // The sample shows the moment without pretending it happened.
          p.status = 'accepted'; p.response = { kind: 'accepted', name: name, tier: p._sel || null, at: new Date().toISOString() };
          drawDoc(root, p, opts); confetti([p.business.color, '#34d399', '#06b6d4', '#a7f3d0']);
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
        '<button type="button" class="btn small" id="sampleGo">' + (signedIn() ? 'Make one' : 'Try it free') + '</button></div><div id="doc"></div>';
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
      view.innerHTML = '<div id="doc"></div>';
      drawDoc($('#doc'), p, { token: token, preview: p.preview });
    }).catch(function (e) {
      view.innerHTML = '<section class="hero slim"><h1>This link isn’t working</h1><p class="lede">' + esc(e.message) + ' Ask whoever sent it for a fresh link.</p></section>';
    });
  }

  /* ---------------- pipeline ---------------- */

  var COLUMNS = [
    { key: 'draft', label: 'Drafts', has: ['draft'], empty: 'Nothing in progress.' },
    { key: 'sent', label: 'Sent', has: ['sent'], empty: 'Nothing waiting to be opened.' },
    { key: 'viewed', label: 'Viewed', has: ['viewed', 'changes'], empty: 'Opened quotes land here.' },
    { key: 'won', label: 'Won', has: ['accepted'], empty: 'Your wins show up here.' },
    { key: 'lost', label: 'Lost', has: ['declined', 'expired'], empty: 'Nothing lost. Keep it that way.' },
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

      var html = '<div class="page-head"><div><h1>Pipeline</h1><p class="sub">' + open.length + ' open · <span class="num">' + money0(openVal) + '</span> in play</p></div>' +
        '<a class="btn" href="#/new">' + ICON.plus + 'New quote</a></div>';
      if (!p.setUp) html += '<a class="note link mb12" href="#/business"><div class="grow"><b>Add your business details</b><div class="small muted">Name, logo, colors and rates go on every quote.</div></div>' + ICON.chev + '</a>';
      if (unread.length) html += '<a class="note warn link mb12" href="#/quote/' + esc(unread[0].id) + '"><div class="grow"><b>' + esc(unread[0].customer || 'A customer') + ' asked for changes</b><div class="small muted">' + esc(unread[0].title) + '</div></div>' + ICON.chev + '</a>';

      if (!qs.length) {
        html += '<section class="hero slim"><h2>Snap your first quote</h2><p class="lede">Photos and a quick voice note in, a professional quote out — usually in under a minute.</p>' +
          '<div class="ctas"><a class="btn lg" href="#/new">New quote</a><a class="btn lg ghost" href="#/sample">See a sample</a></div></section>';
        view.innerHTML = html;
        return;
      }
      html += '<dl class="kpis"><div><dt>Open value</dt><dd class="num">' + moneyShort(openVal) + '</dd></div>' +
        '<div><dt>Sent this week</dt><dd class="num">' + sentWeek + '</dd></div>' +
        '<div><dt>Win rate</dt><dd class="num">' + (decided ? Math.round(won.length / decided * 100) + '%' : '—') + '</dd></div></dl>';
      html += '<div class="board">' + COLUMNS.map(function (c) {
        var rows = qs.filter(function (q) { return c.has.indexOf(q.status) >= 0; });
        var sum = rows.reduce(function (a, q) { return a + q.value; }, 0);
        return '<section class="col' + (rows.length ? '' : ' none') + '"><div class="col-head"><h2><i class="dot d-' + c.key + '"></i>' + c.label + ' <span class="count num">' + rows.length + '</span></h2><span class="sum num">' + (rows.length ? moneyShort(sum) : '') + '</span></div>' +
          (rows.length ? '<div class="rows">' + rows.map(card).join('') + '</div>' : '<p class="col-empty">' + c.empty + '</p>') + '</section>';
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
    return '<button type="button" class="qcard" data-id="' + esc(q.id) + '">' +
      '<span class="main"><span class="t">' + (q.unread ? '<i class="flag" title="New message"></i>' : '') + esc(q.customer || 'No customer yet') + '</span><span class="c">' + esc(q.number) + (q.tiers ? ' · ' + q.tiers + ' options' : '') + ' · ' + esc(q.title) + '</span></span>' +
      '<span class="side"><span class="v num">' + money0(q.value) + '</span>' +
      (q.status === 'changes' || q.status === 'expired' || q.status === 'declined' ? statusChip(q.status) : '<span class="when">' + esc(when) + '</span>') + '</span></button>';
  }

  /* ---------------- new quote ---------------- */

  function freshForm() {
    return { photos: [], voice: null, trade: profile().trade || 'handyman', title: '', description: '', customer: { name: '', contact: '', address: '' }, tiers: false };
  }

  function renderNew() {
    if (!state.nf) state.nf = freshForm();
    var nf = state.nf;
    var meta = state.meta || { trades: {} };
    var voice = voiceOn();
    var tpl = signedIn() ? (state.templates ? Promise.resolve(state.templates) : api('GET', 'api/templates').then(function (r) { state.templates = r.templates; return r.templates; }).catch(function () { return []; })) : Promise.resolve([]);
    tpl.then(function (templates) {
      view.innerHTML =
        '<div class="page-head"><div><h1>New quote</h1><p class="sub">' + (voice ? 'Photos and a voice note. We list the work; your prices do the rest.' : 'Photos and a few words. We’ll do the write-up.') + '</p></div></div>' +
        (templates.length ? '<div class="chips mb16"><span class="small muted chips-lab">Start from</span>' + templates.map(function (t) {
          return '<button type="button" class="chip" data-tpl="' + esc(t.id) + '">' + esc(t.name) + '</button>';
        }).join('') + '<button type="button" class="chip" id="blankQ">Blank quote</button></div>' : '') +
        '<div class="dk-2"><div>' +
        '<section class="block"><div class="block-head"><h2>Photos</h2><span class="small muted num" id="phCount">' + nf.photos.length + ' of 4</span></div>' +
        '<div class="photos" id="photos"></div><input type="file" id="fileIn" accept="image/*" multiple hidden>' +
        '<p class="tiny muted mt8 mb0">Shrunk on your phone before upload, read once, then discarded. Only the quote is saved.</p></section>' +
        (voice ? '<section class="block"><div class="block-head"><h2>Voice note</h2><span class="small muted">Up to ' + voiceSecs() + ' seconds</span></div><div id="voiceBox"></div>' +
          '<p class="tiny muted mt8 mb0">Talk it through like you’d brief a helper. Heard once to list the work, never stored.</p></section>' : '') +
        '<section class="block"><div class="block-head"><h2>The job</h2></div>' +
        '<div class="trade-pick" id="tradePick" role="group" aria-label="Trade">' + Object.keys(meta.trades).map(function (k) {
          var t = meta.trades[k];
          return '<button type="button" data-trade="' + k + '" class="chip' + (k === nf.trade ? ' on' : '') + '" aria-pressed="' + (k === nf.trade) + '">' + esc(t.label) + '</button>';
        }).join('') + '</div>' +
        '<label class="field mt16"><span>Job title (optional)</span><input class="input" id="jobTitle" maxlength="90" placeholder="e.g. Kitchen repaint" value="' + esc(nf.title) + '"></label>' +
        '<label class="field mb0"><span>' + (voice ? 'Anything to add in writing (optional)' : 'Describe it — or tap the mic and talk') + '</span><div class="dictate"><textarea class="input" id="desc" maxlength="' + (voice ? 1500 : 3000) + '" placeholder="e.g. Two bedrooms and the hall, walls and trim, about 9ft ceilings. Some nail holes, one water stain on the ceiling.">' + esc(nf.description) + '</textarea>' +
        (SR && !voice ? '<button class="mic" id="micBtn" type="button">' + ICON.mic + '<span>Dictate</span></button>' : '') + '</div></label></section>' +
        '</div><div class="dk-sticky">' +
        '<section class="block"><div class="block-head"><h2>Customer</h2></div><div class="group">' +
        '<div class="cell"><label for="cName">Name</label><input id="cName" maxlength="80" placeholder="Jordan Rivera" value="' + esc(nf.customer.name) + '" autocomplete="off"></div>' +
        '<div class="cell"><label for="cContact">Phone or email</label><input id="cContact" maxlength="120" placeholder="(555) 555-0123" value="' + esc(nf.customer.contact) + '" autocomplete="off"></div>' +
        '<div class="cell"><label for="cAddr">Job address</label><input id="cAddr" maxlength="160" placeholder="118 Maple Crest Dr" value="' + esc(nf.customer.address) + '" autocomplete="off"></div></div></section>' +
        (voice ? '' :
          '<section class="block"><div class="block-head"><h2>Pricing</h2></div>' +
          '<div class="tier-opt"><button type="button" id="tSingle" class="' + (nf.tiers ? '' : 'on') + '"><b>One price</b><span>A single clear total</span></button>' +
          '<button type="button" id="tTiers" class="' + (nf.tiers ? 'on' : '') + '"><b>Good · Better · Best</b><span>Three options, more yeses</span></button></div></section>') +
        '<p class="tiny muted mt12">Your rate (' + money0(profile().hourlyRate || 75) + '/hr), markup (' + esc(profile().markupPct != null ? profile().markupPct : 15) + '%) and tax (' + esc(profile().taxPct || 0) + '%) are applied automatically — <a href="#/business">change</a>.</p>' +
        '<div class="snap-bar"><div id="snapErr"></div>' +
        (voice
          ? '<button type="button" class="btn lg block" id="readBtn">' + ICON.spark + 'Read the job</button>' +
            '<p class="center tiny muted mt8 mb0">' + (signedIn() ? 'You check every line before anything is saved · about 1–2¢<br><button type="button" class="link-btn tiny" id="snapBtn">Draft a whole quote instead</button> · <button type="button" class="link-btn tiny" id="startBlank">build it by hand, free</button>' : 'Free to try — $2 of credit on sign-up') + '</p>'
          : '<button type="button" class="btn lg block" id="snapBtn">' + ICON.spark + 'Snap my quote</button>' +
            '<p class="center tiny muted mt8 mb0">' + (signedIn() ? 'About 1–2¢ of credit · <button type="button" class="link-btn tiny" id="startBlank">or build it by hand, free</button>' : 'Free to try — $2 of credit on sign-up') + '</p>') +
        '</div></div></div>';

      drawPhotos();
      if (voice) drawVoice();
      $$('#tradePick button').forEach(function (b) {
        b.onclick = function () { nf.trade = b.dataset.trade; $$('#tradePick button').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); };
      });
      $('#jobTitle').oninput = function (e) { nf.title = e.target.value; };
      $('#desc').oninput = function (e) { nf.description = e.target.value; };
      $('#cName').oninput = function (e) { nf.customer.name = e.target.value; };
      $('#cContact').oninput = function (e) { nf.customer.contact = e.target.value; };
      $('#cAddr').oninput = function (e) { nf.customer.address = e.target.value; };
      var ts = $('#tSingle'); if (ts) ts.onclick = function () { nf.tiers = false; this.classList.add('on'); $('#tTiers').classList.remove('on'); };
      var tt = $('#tTiers'); if (tt) tt.onclick = function () { nf.tiers = true; this.classList.add('on'); $('#tSingle').classList.remove('on'); };
      $('#fileIn').onchange = function (e) { addPhotos(e.target.files); e.target.value = ''; };
      var mb = $('#micBtn'); if (mb) wireMic(mb, $('#desc'), function (v) { nf.description = v; });
      var sn = $('#snapBtn'); if (sn) sn.onclick = snap;
      var rb = $('#readBtn'); if (rb) rb.onclick = readJob;
      var sb = $('#startBlank'); if (sb) sb.onclick = function () { startQuote({ customer: nf.customer }); };
      $$('[data-tpl]').forEach(function (b) { b.onclick = function () { startQuote({ templateId: b.dataset.tpl, customer: nf.customer }); }; });
      var bq = $('#blankQ'); if (bq) bq.onclick = function () { startQuote({ customer: nf.customer }); };
    });
  }

  function startQuote(body) {
    if (!signedIn()) return openAccount();
    api('POST', 'api/quotes', body).then(function (q) { dropForm(); location.hash = '#/quote/' + q.id; }).catch(function (e) { showError(e); });
  }

  /** The form is done with: let go of the photos and the recording. They only
   *  ever lived in this page's memory. */
  function dropForm() {
    if (state.nf && state.nf.voice && state.nf.voice.url) URL.revokeObjectURL(state.nf.voice.url);
    state.nf = null;
  }

  function drawPhotos() {
    var nf = state.nf; var el = $('#photos'); if (!el) return;
    var h = nf.photos.map(function (p, i) {
      return '<div class="ph filled"><img src="' + p.url + '" alt="Job photo ' + (i + 1) + '"><button type="button" class="x" data-rm="' + i + '" aria-label="Remove photo ' + (i + 1) + '">' + ICON.x + '</button></div>';
    }).join('');
    for (var i = nf.photos.length; i < 4; i++) {
      h += i === nf.photos.length
        ? '<button class="ph add" id="addPh" type="button" aria-label="Add photos">' + ICON.cam + '<small>Add</small></button>'
        : '<div class="ph"></div>';
    }
    el.innerHTML = h;
    var add = $('#addPh'); if (add) add.onclick = function () { $('#fileIn').click(); };
    $$('[data-rm]', el).forEach(function (b) { b.onclick = function () { nf.photos.splice(Number(b.dataset.rm), 1); drawPhotos(); }; });
    var c = $('#phCount'); if (c) c.textContent = nf.photos.length + ' of 4';
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

  /* ---- the voice note: up to 60 seconds, recorded here, never stored ---- */

  var recorder = null; // { rec, stream, tick, stopAt, started, cancelled }
  function recType() {
    if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
    return '';
  }
  function stopRecording(cancel) {
    if (!recorder) return;
    recorder.cancelled = Boolean(cancel);
    try { recorder.rec.stop(); } catch (e) { /* already stopped */ }
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { reject(new Error('That recording could not be read.')); };
      fr.readAsDataURL(blob);
    });
  }
  function audioSeconds(blob) {
    return new Promise(function (resolve) {
      var a = document.createElement('audio'); var url = URL.createObjectURL(blob);
      var done = function (v) { URL.revokeObjectURL(url); resolve(v); };
      a.preload = 'metadata';
      a.onloadedmetadata = function () { done(isFinite(a.duration) ? a.duration : null); };
      a.onerror = function () { done(null); };
      setTimeout(function () { done(null); }, 3000);
      a.src = url;
    });
  }
  function setVoice(blob, secs) {
    var nf = state.nf; if (!nf) return;
    if (nf.voice && nf.voice.url) URL.revokeObjectURL(nf.voice.url);
    nf.voice = blob ? { blob: blob, type: (blob.type || 'audio/webm').split(';')[0], url: URL.createObjectURL(blob), secs: secs } : null;
    drawVoice();
  }

  function drawVoice() {
    var box = $('#voiceBox'); var nf = state.nf; if (!box || !nf) return;
    var max = voiceSecs();
    var maxBytes = (state.meta && state.meta.maxVoiceBytes) || 2097152;
    var can = recType() !== null;
    if (recorder) {
      box.innerHTML = '<div class="voice rec"><button type="button" class="rec-btn on" id="recStop" aria-label="Stop recording">' + ICON.stop + '</button>' +
        '<div class="grow"><div class="row spread"><b>Recording…</b><span class="num" id="recClock" aria-live="off">0:00 / ' + clock(max) + '</span></div>' +
        '<div class="bar mt8"><i id="recBar"></i></div><p class="tiny muted mt8 mb0">Stops by itself at ' + max + ' seconds.</p></div></div>';
      $('#recStop').onclick = function () { stopRecording(false); };
      return;
    }
    if (nf.voice) {
      box.innerHTML = '<div class="voice have"><audio controls src="' + esc(nf.voice.url) + '"></audio>' +
        '<div class="row mt8"><span class="small muted grow">' + (nf.voice.secs ? clock(nf.voice.secs) + ' recorded' : 'Recorded') + '</span>' +
        (can ? '<button type="button" class="btn small ghost" id="recAgain">Record again</button>' : '') + '<button type="button" class="btn small plain" id="recDrop">Remove</button></div></div>';
      var again = $('#recAgain'); if (again) again.onclick = startRecording;
      $('#recDrop').onclick = function () { setVoice(null); };
      return;
    }
    box.innerHTML = '<div class="voice">' +
      (can ? '<button type="button" class="rec-btn" id="recStart" aria-label="Record a voice note">' + ICON.mic + '</button><div class="grow"><b>Record a voice note</b><div class="small muted">Rooms, sizes, condition, what they want.</div></div>'
        : '<div class="grow"><b>Recording isn’t available in this browser</b><div class="small muted">Choose a recording instead, ' + max + ' seconds at most.</div></div>') +
      '</div><label class="link-btn tiny file-pick">Or choose a recording<input class="vh" type="file" accept="audio/*" id="voiceFile"></label><div id="voiceErr"></div>';
    var st = $('#recStart'); if (st) st.onclick = startRecording;
    $('#voiceFile').onchange = function (e) {
      var f = e.target.files && e.target.files[0]; e.target.value = '';
      if (!f) return;
      var say = function (m) { $('#voiceErr').innerHTML = '<div class="err" role="alert">' + esc(m) + '</div>'; };
      if (f.size > maxBytes) return say('That recording is too big. Keep it to ' + max + ' seconds.');
      audioSeconds(f).then(function (secs) {
        if (secs !== null && secs > max + 0.5) return say('That recording is longer than ' + max + ' seconds. Trim it, or record one here.');
        setVoice(f, secs);
      });
    };
  }

  function startRecording() {
    var max = voiceSecs();
    var type = recType();
    if (type === null || recorder) return;
    var maxBytes = (state.meta && state.meta.maxVoiceBytes) || 2097152;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var opts = { audioBitsPerSecond: 32000 }; if (type) opts.mimeType = type;
      var rec = new MediaRecorder(stream, opts);
      var chunks = [];
      var me = recorder = { rec: rec, stream: stream, started: Date.now(), cancelled: false };
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        clearInterval(me.tick); clearTimeout(me.stopAt);
        stream.getTracks().forEach(function (t) { t.stop(); });
        var secs = Math.min(max, (Date.now() - me.started) / 1000);
        recorder = null;
        if (me.cancelled || !state.nf) { drawVoice(); return; }
        var blob = new Blob(chunks, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] });
        if (!blob.size || secs < 1) { drawVoice(); toast('That was too short to hear. Hold on a little longer.'); return; }
        if (blob.size > maxBytes) { drawVoice(); toast('That recording came out too big. Try a shorter one.'); return; }
        setVoice(blob, secs);
      };
      rec.start(1000);
      drawVoice();
      me.tick = setInterval(function () {
        var s = (Date.now() - me.started) / 1000;
        var c = $('#recClock'); if (c) c.textContent = clock(s) + ' / ' + clock(max);
        var b = $('#recBar'); if (b) b.style.setProperty('--w', Math.min(100, s / max * 100) + '%');
      }, 250);
      // The cap: sixty seconds, then it stops by itself.
      me.stopAt = setTimeout(function () { stopRecording(false); }, max * 1000);
    }).catch(function () { toast('Microphone access is off for this site. You can choose a recording instead.', 3800); });
  }

  /** The waiting screen both readers share. Returns { done(cb), fail() }. */
  function working(title, steps, photos) {
    var ov = document.createElement('div');
    ov.className = 'drafting';
    ov.setAttribute('role', 'status');
    ov.innerHTML = '<div class="box">' +
      (photos.length ? '<div class="thumbs">' + photos.map(function (p) { return '<div><img src="' + p.url + '" alt=""></div>'; }).join('') + '</div>' : '') +
      '<h2>' + esc(title) + '</h2><ol>' + steps.map(function (s) { return '<li><i></i>' + esc(s) + '</li>'; }).join('') + '</ol></div>';
    document.body.appendChild(ov);
    var lis = $$('li', ov), at = 0;
    lis[0].classList.add('on');
    var tick = setInterval(function () {
      if (at >= lis.length - 1) return;
      lis[at].classList.remove('on'); lis[at].classList.add('done');
      at++; lis[at].classList.add('on');
    }, 1500);
    return {
      done: function (cb) { clearInterval(tick); lis.forEach(function (li) { li.classList.remove('on'); li.classList.add('done'); }); setTimeout(function () { ov.remove(); cb(); }, 400); },
      fail: function () { clearInterval(tick); ov.remove(); },
    };
  }

  /** Claude drafts a whole quote, prices and all (the reader the app has
   *  always had). */
  function snap() {
    var nf = state.nf;
    if (!signedIn()) return openAccount('Sign up free — $2 of AI credit, enough for roughly 100 quotes.');
    if (!nf.photos.length && nf.description.trim().length < 8) {
      $('#snapErr').innerHTML = '<div class="err" role="alert">Add a photo or say a sentence about the job first.</div>';
      return;
    }
    stopListening(); stopRecording(true);
    var started = Date.now();
    var w = working('Drafting your quote…', [nf.photos.length ? 'Looking at your photos' : 'Reading your notes', 'Measuring up the job', 'Pricing labor and materials', 'Writing it up'], nf.photos);
    api('POST', 'api/quotes/draft', {
      photos: nf.photos.map(function (p) { return { type: p.type, data: p.data }; }),
      description: nf.description, title: nf.title, trade: nf.trade, customer: nf.customer, tiers: nf.tiers,
    }).then(function (q) {
      state.justDrafted = { id: q.id, secs: Math.max(1, Math.round((Date.now() - started) / 1000)), photos: nf.photos.length };
      dropForm();
      loadMe();
      w.done(function () { location.hash = '#/quote/' + q.id; });
    }).catch(function (e) { w.fail(); showError(e, $('#snapErr')); });
  }

  /** Read the job: photos and the voice note become line items to check.
   *  Nothing is saved by this - the review screen is where a quote is made. */
  function readJob() {
    var nf = state.nf;
    if (!signedIn()) return openAccount('Sign up free — $2 of AI credit, enough for roughly 100 quotes.');
    if (recorder) { $('#snapErr').innerHTML = '<div class="err" role="alert">Stop the recording first.</div>'; return; }
    if (!nf.photos.length && !nf.voice && nf.description.trim().length < 8) {
      $('#snapErr').innerHTML = '<div class="err" role="alert">Add a photo, record a voice note, or type a sentence about the job first.</div>';
      return;
    }
    var started = Date.now();
    var steps = [];
    if (nf.photos.length) steps.push('Looking at your photos');
    if (nf.voice) steps.push('Listening to your voice note');
    steps.push('Listing the work', 'Pricing it from your own rates');
    var w = working('Reading the job…', steps, nf.photos);
    (nf.voice ? blobToBase64(nf.voice.blob) : Promise.resolve(null)).then(function (b64) {
      return api('POST', 'api/quotes/read', {
        photos: nf.photos.map(function (p) { return { type: p.type, data: p.data }; }),
        audio: b64 ? { type: nf.voice.type, data: b64 } : undefined,
        note: nf.description, title: nf.title, trade: nf.trade,
      });
    }).then(function (r) {
      state.read = {
        title: r.title, heard: r.heard, trade: r.trade, lines: r.lines, questions: r.questions || [], photoCount: r.photoCount, hadVoice: r.hadVoice,
        pricing: r.pricing, note: nf.description, customer: clone(nf.customer), secs: Math.max(1, Math.round((Date.now() - started) / 1000)),
      };
      loadMe();
      w.done(function () { location.hash = '#/review'; });
    }).catch(function (e) {
      w.fail();
      if (e && e.data && e.data.code === 'ai-off') { loadMe().then(renderNew); return toast(e.message, 4000); }
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

  /* ---------------- check the lines (after a read) ---------------- */

  var CONF = { high: 'Sure', medium: 'Likely', low: 'Check this' };

  function lineTags(l) {
    var flags = l.flags || [];
    var t = '<span class="tag' + (l.confidence === 'low' ? ' warn' : l.confidence === 'high' ? ' good' : '') + '">' + CONF[l.confidence || 'high'] + '</span>';
    if (flags.indexOf('qty') >= 0) t += '<span class="tag warn">Quantity is a guess</span>';
    var src = l.priceSource || { kind: 'you', label: 'Your price' };
    t += '<span class="tag' + (numIn(l.unitPrice) > 0 ? '' : ' warn') + '">' + esc(numIn(l.unitPrice) > 0 ? src.label : 'Needs your price') + '</span>';
    return t;
  }
  function needsLook(l) { return (l.flags || []).length > 0 || !(numIn(l.unitPrice) > 0); }

  function renderReview() {
    var rd = state.read;
    if (!signedIn() || !rd) { location.hash = '#/new'; return; }
    var from = [rd.photoCount ? rd.photoCount + ' photo' + (rd.photoCount > 1 ? 's' : '') : '', rd.hadVoice ? 'your voice note' : '', !rd.photoCount && !rd.hadVoice ? 'your note' : ''].filter(Boolean).join(' and ');
    view.innerHTML =
      '<div class="ed-top"><button type="button" class="icon-btn" id="rvBack" aria-label="Back to the job">' + ICON.back + '</button><span class="small muted grow">Read in ' + rd.secs + 's from ' + esc(from) + '</span></div>' +
      '<div class="page-head tight"><div><h1>Check the lines</h1><p class="sub" id="rvSub"></p></div></div>' +
      '<label class="field"><span>Job title</span><input class="input" id="rvTitle" maxlength="90" value="' + esc(rd.title) + '"></label>' +
      (rd.heard ? '<figure class="heard"><figcaption>What I heard</figcaption><blockquote>' + esc(rd.heard) + '</blockquote></figure>' : '') +
      '<div class="dk-2"><div>' +
      '<section class="block"><div class="block-head"><h2>Line items</h2><span class="small muted">Edit, remove or add</span></div>' +
      '<div class="items" id="rvItems"></div><button type="button" class="add-line" id="rvAdd">' + ICON.plus + 'Add line</button></section>' +
      '</div><div class="dk-sticky">' +
      ((rd.questions || []).length ? '<section class="block"><div class="block-head"><h2>Worth checking on site</h2></div><ul class="checks">' + rd.questions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' : '') +
      '<section class="block"><div class="block-head"><h2>Totals</h2><span class="small muted">Worked out from your rates</span></div><div id="rvTotals" class="totals"></div></section>' +
      '<p class="tiny muted mt12">The AI only describes the work. Every price is yours — from your price list, templates, past quotes and hourly rate — and the totals, markup (' + esc(rd.pricing.markupPct) + '%) and tax (' + esc(rd.pricing.taxPct) + '%) are calculated by Snapquote. Your photos and recording were not kept.</p>' +
      '</div></div>' +
      '<div class="actionbar"><div class="sum"><b id="rvBar" class="num"></b><span id="rvState">Nothing saved yet</span></div>' +
      '<button type="button" class="btn ghost" id="rvDrop">Discard</button><button type="button" class="btn" id="rvSave">Save as quote</button></div>';

    var armed = false;
    function totals() {
      var t = totalsFor(rd.lines, { markupPct: rd.pricing.markupPct, taxPct: rd.pricing.taxPct, discount: 0 });
      var look = rd.lines.filter(needsLook).length;
      $('#rvSub').textContent = rd.lines.length + ' line' + (rd.lines.length === 1 ? '' : 's') + (look ? ' · ' + look + ' to check' : ' · all priced');
      $('#rvTotals').innerHTML = '<div class="r"><span class="muted">Subtotal</span><span>' + money(t.subtotal) + '</span></div>' +
        '<div class="r"><span class="muted">Tax (' + esc(rd.pricing.taxPct) + '%)</span><span>' + money(t.tax) + '</span></div>' +
        '<div class="r big"><span>Total</span><span>' + money(t.total) + '</span></div>' +
        '<div class="r private"><span>' + ICON.lock + 'Your cost ' + money(t.cost) + '</span><span>Margin ' + money(t.margin) + '</span></div>';
      $('#rvBar').textContent = money(t.total);
      armed = false; $('#rvState').textContent = 'Nothing saved yet'; $('#rvState').className = '';
    }
    function draw() {
      var el = $('#rvItems');
      el.innerHTML = (rd.lines.length ? rd.lines.map(function (l, i) {
        var pl = priceLine(l, rd.pricing.markupPct);
        return '<div class="item rv' + (needsLook(l) ? ' look' : '') + '" data-i="' + i + '"><div class="top-row"><textarea class="desc" rows="1" data-f="description" maxlength="160" placeholder="What is it?" aria-label="Line ' + (i + 1) + ' description">' + esc(l.description) + '</textarea>' +
          '<div class="ctl"><button type="button" data-act="rm" aria-label="Remove line ' + (i + 1) + '">' + ICON.x + '</button></div></div>' +
          '<div class="tags" data-tags>' + lineTags(l) + '</div>' +
          '<div class="nums"><select data-f="category" aria-label="Category">' + CAT_ORDER.map(function (c) { return '<option value="' + c + '"' + (c === l.category ? ' selected' : '') + '>' + CATS[c].label + '</option>'; }).join('') + '</select>' +
          '<input class="n" data-f="qty" inputmode="decimal" aria-label="Quantity" value="' + esc(l.qty) + '">' +
          '<input class="n unit" data-f="unit" list="units" aria-label="Unit" maxlength="12" value="' + esc(l.unit) + '">' +
          '<div class="money-in"><input class="n" data-f="unitPrice" inputmode="decimal" aria-label="Your price per unit" value="' + esc(l.unitPrice || '') + '" placeholder="0"></div>' +
          '<div class="amt"><span data-amt class="num">' + money(pl.price) + '</span></div></div></div>';
      }).join('') : '<p class="col-empty">No lines left. Add one, or go back and read the job again.</p>') +
        '<datalist id="units">' + ((state.meta && state.meta.units) || []).map(function (u) { return '<option value="' + esc(u) + '">'; }).join('') + '</datalist>';
      $$('.item', el).forEach(function (row) {
        var i = Number(row.dataset.i);
        var l = rd.lines[i];
        $$('[data-f]', row).forEach(function (inp) {
          inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', function () {
            var f = inp.dataset.f;
            l[f] = inp.value;
            // The person has now said it themselves: the doubt is settled.
            if (f === 'qty') l.flags = (l.flags || []).filter(function (x) { return x !== 'qty'; });
            if (f === 'unitPrice') { l.flags = (l.flags || []).filter(function (x) { return x !== 'price'; }); l.priceSource = { kind: 'you', label: 'Your price' }; }
            if (f === 'description') { l.flags = (l.flags || []).filter(function (x) { return x !== 'unclear'; }); if (l.confidence === 'low') l.confidence = 'medium'; autoGrow(inp); }
            $('[data-amt]', row).textContent = money(priceLine(l, rd.pricing.markupPct).price);
            $('[data-tags]', row).innerHTML = lineTags(l);
            row.classList.toggle('look', needsLook(l));
            totals();
          });
        });
        autoGrow($('.desc', row));
        $('[data-act=rm]', row).onclick = function () { rd.lines.splice(i, 1); draw(); totals(); };
      });
    }
    draw(); totals();
    $('#rvTitle').oninput = function (e) { rd.title = e.target.value; };
    $('#rvBack').onclick = function () { location.hash = '#/new'; };
    $('#rvAdd').onclick = function () {
      rd.lines.push({ description: '', category: 'labor', qty: 1, unit: 'hr', unitPrice: rd.pricing.hourlyRate || 0, confidence: 'high', flags: [], priceSource: { kind: 'rate', label: 'Your hourly rate' } });
      draw(); totals();
      var rows = $$('#rvItems .desc'); if (rows.length) rows[rows.length - 1].focus();
    };
    $('#rvDrop').onclick = function () {
      if (!confirm('Discard these lines? Nothing has been saved.')) return;
      state.read = null; location.hash = '#/new';
    };
    $('#rvSave').onclick = function () {
      var items = rd.lines.filter(function (l) { return String(l.description || '').trim(); });
      var st = $('#rvState');
      if (!items.length) { st.textContent = 'Keep at least one line'; st.className = 'dirty'; return; }
      var unpriced = items.filter(function (l) { return !(numIn(l.unitPrice) > 0); }).length;
      if (unpriced && !armed) { armed = true; st.textContent = unpriced + ' line' + (unpriced === 1 ? ' has' : 's have') + ' no price — tap Save again to keep ' + (unpriced === 1 ? 'it' : 'them') + ' at $0'; st.className = 'dirty'; return; }
      var btn = this; btn.disabled = true;
      api('POST', 'api/quotes', {
        customer: rd.customer,
        read: {
          title: rd.title, trade: rd.trade, heard: rd.heard, note: rd.note, photoCount: rd.photoCount,
          items: items.map(function (l) { return { description: l.description, category: l.category, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice }; }),
        },
      }).then(function (q) {
        state.justDrafted = { id: q.id, secs: rd.secs, photos: rd.photoCount, read: true };
        state.read = null; dropForm();
        location.hash = '#/quote/' + q.id;
      }).catch(function (e) { btn.disabled = false; showError(e); });
    };
  }

  /* ---------------- the editor ---------------- */

  var q = null;     // the quote as the server last returned it
  var ed = null;    // what is on screen
  var dirty = false;
  var list = 'base';

  function renderEditor(id) {
    if (!signedIn()) return signedOutPitch('Sign in to see that quote', 'Your quotes live in your account.');
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

  var SOURCES = { ai: 'Drafted', read: 'Read from the job', template: 'From template', duplicate: 'Copy' };

  function drawEditor() {
    var locked = q.locked;
    var dis = locked ? ' disabled' : '';
    var jd = state.justDrafted && state.justDrafted.id === q.id ? state.justDrafted : null;
    var steps = [['Created', true], ['Sent', !!q.sentAt], ['Viewed', !!q.viewedAt], [q.status === 'declined' ? 'Declined' : q.status === 'expired' ? 'Expired' : 'Won', ['accepted', 'declined', 'expired'].indexOf(q.status) >= 0]];
    var msgs = (q.messages || []).filter(function (m) { return m.from === 'customer'; });
    var r = q.response;

    view.innerHTML =
      '<div class="ed-top"><button type="button" class="icon-btn" id="edBack" aria-label="Back to the pipeline">' + ICON.back + '</button>' +
      '<span class="small muted num grow">' + esc(q.number) + ' · ' + (SOURCES[q.source] || 'Manual') + '</span>' +
      statusChip(q.status) +
      (q.publicUrl ? '<a class="icon-btn" href="' + esc(BASE + q.publicUrl) + '" target="_blank" rel="noopener" aria-label="Preview as customer" title="Preview as customer">' + ICON.eye + '</a>' : '') + '</div>' +
      (jd ? '<div class="note good mb12"><div><b>' + (jd.read ? 'Saved' : 'Drafted in ' + jd.secs + 's' + (jd.photos ? ' from ' + jd.photos + ' photo' + (jd.photos > 1 ? 's' : '') : '')) + '.</b> <span class="muted">' + (jd.read ? 'Add a line or two of scope, then send it while you’re still in the driveway.' : 'Check the quantities and prices — then send it while you’re still in the driveway.') + '</span></div></div>' : '') +
      (locked && r ? '<div class="note good mb12"><div><b>Accepted by ' + esc(r.name) + '</b> · ' + esc(dateFmt(r.at)) + (r.tier ? ' · ' + esc(tierLabel(r.tier)) : '') + '<div class="small muted">Locked so the price they signed stays the price. Duplicate to make a new version.</div></div></div>' : '') +
      (msgs.length ? '<section class="card warn-card mb12"><div class="block-head"><h2>From ' + esc(q.customer.name || 'your customer') + '</h2></div><div class="msgs">' +
        msgs.slice(-4).map(function (m) { return '<div class="m">' + esc(m.text) + '<div class="when">' + esc(timeAgo(m.at)) + '</div></div>'; }).join('') +
        '</div><p class="small muted mt12 mb0">Make the changes below, then tap <b>Send update</b> — same link, fresh validity date.</p></section>' : '') +
      '<section class="ed-hero"><label class="vh" for="edTitle">Job title</label><input class="title-in" id="edTitle" maxlength="90" value="' + esc(ed.title) + '"' + dis + '>' +
      '<div class="small muted">' + esc(ed.customer.name || 'No customer yet') + (ed.customer.address ? ' · ' + esc(ed.customer.address) : '') + '</div>' +
      '<div class="big num" id="bigTotal"></div>' +
      '<div class="timeline">' + steps.map(function (s, i) {
        return (i ? '<div class="ln' + (s[1] ? ' on' : '') + '"></div>' : '') + '<div class="s' + (s[1] ? ' on' : '') + '"><i></i>' + s[0] + '</div>';
      }).join('') + '</div></section>' +
      '<div class="dk-2"><div>' +
      // scope
      '<section class="block"><div class="block-head"><h2>Scope</h2><span class="small muted">What the customer reads first</span></div>' +
      '<label class="vh" for="edScope">Scope</label><textarea class="input" id="edScope" maxlength="1500" rows="5"' + dis + '>' + esc(ed.scope) + '</textarea>' +
      (locked ? '' : '<div class="polish-row"><button type="button" class="btn small ghost" data-tone="friendly">' + ICON.spark + 'Friendlier</button><button type="button" class="btn small ghost" data-tone="professional">' + ICON.spark + 'More professional</button></div><div id="suggest"></div>') + '</section>' +
      // items
      '<section class="block"><div class="block-head"><h2>Line items</h2>' + (locked ? '' : '<button type="button" class="btn small plain" id="tierToggle">' + (ed.tiers ? 'Remove options' : 'Add Good / Better / Best') + '</button>') + '</div>' +
      '<div id="tierTabs"></div><div id="tierMeta"></div><div class="items" id="items"></div>' +
      (locked ? '' : '<button type="button" class="add-line" id="addLine">' + ICON.plus + 'Add line</button>') + '</section>' +
      // details
      '<section class="block"><div class="block-head"><h2>Details</h2></div>' +
      '<label class="field"><span>Timeline</span><input class="input" id="edTimeline" maxlength="200" value="' + esc(ed.timeline) + '"' + dis + ' placeholder="e.g. 2 days on site; can start next week"></label>' +
      '<label class="field"><span>Assumptions (one per line)</span><textarea class="input" id="edAssume" rows="3"' + dis + '>' + esc((ed.assumptions || []).join('\n')) + '</textarea></label>' +
      '<label class="field"><span>Not included (one per line)</span><textarea class="input" id="edExcl" rows="3"' + dis + '>' + esc((ed.exclusions || []).join('\n')) + '</textarea></label>' +
      '<label class="field"><span>Payment terms</span><textarea class="input" id="edTerms" rows="2" maxlength="400"' + dis + '>' + esc(ed.terms) + '</textarea></label>' +
      '<label class="field mb0"><span class="with-ico">' + ICON.lock + 'Private notes — only you see these</span><textarea class="input" id="edNotes" rows="3" maxlength="1500"' + dis + ' placeholder="Gate code, parking, what they said about budget…">' + esc(ed.notes) + '</textarea></label></section>' +
      '</div><div class="dk-sticky">' +
      // pricing
      '<section class="block"><div class="block-head"><h2>Pricing</h2><span class="small muted">Markup applies to non-labor lines</span></div>' +
      '<div class="adj"><div><label for="edMarkup">Markup %</label><input class="input num" id="edMarkup" inputmode="decimal" value="' + esc(ed.markupPct) + '"' + dis + '></div>' +
      '<div><label for="edTax">Tax %</label><input class="input num" id="edTax" inputmode="decimal" value="' + esc(ed.taxPct) + '"' + dis + '></div>' +
      '<div><label for="edDisc">Discount $</label><input class="input num" id="edDisc" inputmode="decimal" value="' + esc(ed.discount || 0) + '"' + dis + '></div></div>' +
      '<div id="totals" class="totals mt16"></div>' +
      '<div class="row spread small muted mt12"><label for="edValid">Valid for</label><span><input class="input num valid-in" id="edValid" inputmode="numeric" value="' + esc(ed.validDays || 30) + '"' + dis + '> days</span></div></section>' +
      // customer
      '<section class="block"><div class="block-head"><h2>Customer</h2></div><div class="group">' +
      '<div class="cell"><label for="ecName">Name</label><input id="ecName" maxlength="80" value="' + esc(ed.customer.name) + '"' + dis + '></div>' +
      '<div class="cell"><label for="ecContact">Phone / email</label><input id="ecContact" maxlength="120" value="' + esc(ed.customer.contact) + '"' + dis + '></div>' +
      '<div class="cell"><label for="ecAddr">Address</label><input id="ecAddr" maxlength="160" value="' + esc(ed.customer.address) + '"' + dis + '></div></div>' +
      (q.description ? '<p class="hint">Your original notes: “' + esc(q.description.slice(0, 220)) + (q.description.length > 220 ? '…' : '') + '”</p>' : '') + '</section>' +
      // follow-up
      (q.sentAt && !locked ? '<section class="block follow"><div class="block-head"><h2>Follow up</h2><span class="small muted">' + (q.viewedAt ? 'Opened ' + esc(timeAgo(q.viewedAt)) : 'Not opened yet') + '</span></div><div id="followBox"></div>' +
        '<button type="button" class="btn small ghost block" id="followBtn">' + ICON.spark + (q.followUp ? 'Write another' : 'Draft a follow-up') + '</button></section>' : '') +
      // more
      '<section class="block"><div class="block-head"><h2>More</h2></div><div class="more-actions">' +
      '<button type="button" class="btn ghost" id="dupBtn">Duplicate</button><button type="button" class="btn ghost" id="tplBtn">Save as template</button>' +
      (q.sentAt && ['sent', 'viewed', 'changes', 'expired'].indexOf(q.status) >= 0 ? '<button type="button" class="btn ghost" id="wonBtn">Mark won</button><button type="button" class="btn ghost" id="lostBtn">Mark lost</button>' : '') +
      (q.status === 'declined' ? '<button type="button" class="btn ghost" id="reopenBtn">Reopen</button>' : '') +
      '<button type="button" class="btn danger" id="delBtn">Delete</button></div></section>' +
      '</div></div>' +
      // action bar
      '<div class="actionbar"><div class="sum"><b id="barTotal" class="num"></b><span id="saveState">' + (locked ? 'Accepted · locked' : 'All changes saved') + '</span></div>' +
      (locked ? (q.publicUrl ? '<button type="button" class="btn" id="shareBtn">Share link</button>' : '') :
        '<button type="button" class="btn ghost" id="saveBtn">Save</button><button type="button" class="btn" id="sendBtn">' + ICON.send + (!q.sentAt ? 'Send' : q.status === 'changes' ? 'Send update' : 'Share') + '</button>') + '</div>';

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
    el.innerHTML = '<div class="tier-tabs"><button type="button" data-list="base" class="' + (list === 'base' ? 'on' : '') + '">In every option<small>' + ed.items.length + ' lines</small></button>' +
      ed.tiers.map(function (t) {
        return '<button type="button" data-list="' + t.key + '" class="' + (list === t.key ? 'on' : '') + '">' + esc({ good: 'Good', better: 'Better', best: 'Best' }[t.key]) + '<small class="num">' + money0(tot[t.key].total) + '</small></button>';
      }).join('') + '</div>';
    $$('[data-list]', el).forEach(function (b) { b.onclick = function () { list = b.dataset.list; drawTierTabs(); drawItems(); }; });
    if (list === 'base') {
      meta.innerHTML = '<p class="small muted">Lines here are in all three options. Each option adds its own lines on top.</p>';
    } else {
      var t = ed.tiers.filter(function (x) { return x.key === list; })[0];
      meta.innerHTML = '<div class="tier-meta"><input class="input" id="tLabel" maxlength="40" placeholder="Option name" aria-label="Option name" value="' + esc(t.label) + '"' + (q.locked ? ' disabled' : '') + '>' +
        '<input class="input" id="tSummary" maxlength="280" placeholder="One line on what this option gets them" aria-label="Option summary" value="' + esc(t.summary) + '"' + (q.locked ? ' disabled' : '') + '></div>';
      $('#tLabel').oninput = function (e) { t.label = e.target.value; touch(); };
      $('#tSummary').oninput = function (e) { t.summary = e.target.value; touch(); };
    }
  }

  function itemRow(it, i, n) {
    var l = priceLine(it, ed.markupPct);
    var dis = q.locked ? ' disabled' : '';
    return '<div class="item" data-i="' + i + '"><div class="top-row"><textarea class="desc" rows="1" data-f="description" maxlength="160" placeholder="What is it?" aria-label="Line ' + (i + 1) + ' description"' + dis + '>' + esc(it.description) + '</textarea>' +
      (q.locked ? '' : '<div class="ctl"><button type="button" data-act="up" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>' + ICON.up + '</button><button type="button" data-act="down" aria-label="Move down"' + (i === n - 1 ? ' disabled' : '') + '>' + ICON.down + '</button><button type="button" data-act="rm" aria-label="Remove line">' + ICON.x + '</button></div>') + '</div>' +
      '<div class="nums"><select data-f="category" aria-label="Category"' + dis + '>' + CAT_ORDER.map(function (c) { return '<option value="' + c + '"' + (c === it.category ? ' selected' : '') + '>' + CATS[c].label + '</option>'; }).join('') + '</select>' +
      '<input class="n" data-f="qty" inputmode="decimal" aria-label="Quantity" value="' + esc(it.qty) + '"' + dis + '>' +
      '<input class="n unit" data-f="unit" list="units" aria-label="Unit" maxlength="12" value="' + esc(it.unit) + '"' + dis + '>' +
      '<div class="money-in"><input class="n" data-f="unitPrice" inputmode="decimal" aria-label="Unit price" value="' + esc(it.unitPrice) + '"' + dis + '></div>' +
      '<div class="amt"><span data-amt class="num">' + money(l.price) + '</span><small data-cost class="num">' + (l.marked && ed.markupPct ? 'cost ' + money(l.cost) : '') + '</small></div></div></div>';
  }

  function drawItems() {
    var items = listItems();
    var el = $('#items');
    el.innerHTML = (items.length ? items.map(function (it, i) { return itemRow(it, i, items.length); }).join('')
      : '<p class="col-empty">' + (list === 'base' ? 'No lines yet.' : 'This option adds nothing on top — add what makes it worth more.') + '</p>') +
      '<datalist id="units">' + ((state.meta && state.meta.units) || []).map(function (u) { return '<option value="' + esc(u) + '">'; }).join('') + '</datalist>';
    $$('.item', el).forEach(function (row) {
      var i = Number(row.dataset.i);
      $$('[data-f]', row).forEach(function (inp) {
        var ev = inp.tagName === 'SELECT' ? 'change' : 'input';
        inp.addEventListener(ev, function () {
          items[i][inp.dataset.f] = inp.value;
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
        '<div class="r private mt8"><span>' + ICON.lock + 'Better: your cost ' + money0(h.cost) + '</span><span>margin ' + money0(h.margin) + '</span></div>';
      var tabs = $$('#tierTabs [data-list] small');
      ed.tiers.forEach(function (x, i) { if (tabs[i + 1]) tabs[i + 1].textContent = money0(t.tiers[x.key].total); });
      if (tabs[0]) tabs[0].textContent = ed.items.length + ' lines';
    } else {
      var s = t.single;
      el.innerHTML = '<div class="r"><span class="muted">Subtotal</span><span>' + money(s.subtotal) + '</span></div>' +
        (s.discount ? '<div class="r"><span class="muted">Discount</span><span>−' + money(s.discount) + '</span></div>' : '') +
        '<div class="r"><span class="muted">Tax (' + esc(numIn(ed.taxPct, 30)) + '%)</span><span>' + money(s.tax) + '</span></div>' +
        '<div class="r big"><span>Total</span><span>' + money(s.total) + '</span></div>' +
        '<div class="r private"><span>' + ICON.lock + 'Your cost ' + money(s.cost) + '</span><span>Margin ' + money(s.margin) + '</span></div>';
    }
    $('#bigTotal').innerHTML = money(h.total) + '<small>' + (t.tiers ? 'Better option' : 'incl. tax') + '</small>';
    $('#barTotal').textContent = money(h.total);
  }

  function drawFollow() {
    var box = $('#followBox'); if (!box) return;
    var f = q.followUp;
    if (!f) { box.innerHTML = '<p class="small muted">Quiet customer? A friendly nudge wins a surprising number of jobs.</p>'; return; }
    var phone = /[0-9]{3}/.test(ed.customer.contact || '') && !/@/.test(ed.customer.contact || '') ? ed.customer.contact.replace(/[^0-9+]/g, '') : '';
    var email = /@/.test(ed.customer.contact || '') ? ed.customer.contact : '';
    box.innerHTML = '<div class="eyebrow">Text</div><div class="box">' + esc(f.sms) + '</div>' +
      '<div class="row mt8 mb16"><button type="button" class="btn small ghost" data-copy="sms">Copy</button><a class="btn small ghost" href="sms:' + esc(phone) + '?&body=' + encodeURIComponent(f.sms) + '">Open Messages</a></div>' +
      '<div class="eyebrow">Email · ' + esc(f.emailSubject) + '</div><div class="box">' + esc(f.emailBody) + '</div>' +
      '<div class="row mt8 mb12"><button type="button" class="btn small ghost" data-copy="email">Copy</button><a class="btn small ghost" href="mailto:' + esc(email) + '?subject=' + encodeURIComponent(f.emailSubject) + '&body=' + encodeURIComponent(f.emailBody) + '">Open Mail</a></div>';
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
      tt.textContent = ed.tiers ? 'Remove options' : 'Add Good / Better / Best';
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
        b.disabled = true; var was = b.innerHTML; b.innerHTML = '<span class="spinner"></span>';
        api('POST', 'api/quotes/' + q.id + '/polish', { tone: b.dataset.tone, scope: ed.scope }).then(function (r) {
          box.innerHTML = '<div class="suggest"><div class="eyebrow">' + (r.tone === 'friendly' ? 'Friendlier' : 'More professional') + '</div><div class="pre">' + esc(r.scope) + '</div>' +
            '<div class="row mt12"><button type="button" class="btn small" id="useSug">Use this</button><button type="button" class="btn small ghost" id="dropSug">Keep mine</button></div></div>';
          $('#useSug').onclick = function () { ed.scope = r.scope; $('#edScope').value = r.scope; autoGrow($('#edScope')); box.innerHTML = ''; touch(); };
          $('#dropSug').onclick = function () { box.innerHTML = ''; };
          loadMe();
        }).catch(function (e) { showError(e); }).then(function () { b.disabled = false; b.innerHTML = was; });
      };
    });

    var fb = $('#followBtn');
    if (fb) fb.onclick = function () {
      fb.disabled = true; fb.innerHTML = '<span class="spinner"></span>Writing…';
      api('POST', 'api/quotes/' + q.id + '/follow-up').then(function (f) {
        q.followUp = f; drawFollow(); loadMe();
        fb.innerHTML = ICON.spark + 'Write another';
      }).catch(function (e) { fb.innerHTML = ICON.spark + 'Draft a follow-up'; showError(e); }).then(function () { fb.disabled = false; });
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
    sheet('<h2>' + (first ? 'Quote ready to send' : 'Share this quote') + '</h2>' +
      '<p class="muted small">' + (first ? 'The clock is running — valid until ' : 'Valid until ') + esc(dateFmt(q.validUntil)) + '. You’ll see here when they open it.</p>' +
      '<div class="share-link"><span>' + esc(link) + '</span><button type="button" class="btn small" id="cpy">Copy</button></div>' +
      '<div class="share-grid">' +
      '<a href="sms:' + esc(phone) + '?&body=' + encodeURIComponent(msg) + '">' + ICON.chat + 'Text</a>' +
      '<a href="mailto:' + esc(email) + '?subject=' + encodeURIComponent('Your quote: ' + q.title) + '&body=' + encodeURIComponent(msg) + '">' + ICON.mail + 'Email</a>' +
      (navigator.share ? '<button type="button" id="natShare">' + ICON.share + 'More</button>' : '<a href="' + esc(link) + '" target="_blank" rel="noopener">' + ICON.eye + 'Preview</a>') +
      '</div>' +
      (navigator.share ? '<a class="btn ghost block mt12" href="' + esc(link) + '" target="_blank" rel="noopener">Preview as your customer</a>' : ''),
      function (root) {
        $('#cpy', root).onclick = function () { copy(link); };
        var ns = $('#natShare', root);
        if (ns) ns.onclick = function () { navigator.share({ title: q.title, text: msg.replace(link, '').trim(), url: link }).catch(function () { /* cancelled */ }); };
      });
    if (first) confetti();
  }

  /* ---------------- scoreboard ---------------- */

  function renderStats() {
    if (!signedIn()) return signedOutPitch('Your win rate, front and center', 'Every quote you send is tracked: win rate, money won, how fast you quote, and a weekly streak to keep you quick.');
    loading();
    api('GET', 'api/stats').then(function (s) {
      var c = 2 * Math.PI * 54;
      var wr = s.winRate == null ? 0 : s.winRate;
      var weeksOn = s.chart.map(function (w) { return w.count > 0; });
      view.innerHTML =
        '<div class="page-head"><div><h1>Scoreboard</h1><p class="sub">' + (s.sentThisWeek ? s.sentThisWeek + ' sent this week — keep it rolling.' : 'Send one this week to keep the streak alive.') + '</p></div></div>' +
        '<div class="score-top">' +
        '<div class="ringbox"><div class="ring"><svg viewBox="0 0 132 132" aria-hidden="true"><circle class="ring-track" cx="66" cy="66" r="54" fill="none" stroke-width="10"/>' +
        '<circle class="ring-arc" cx="66" cy="66" r="54" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - wr / 100)) + '"/></svg>' +
        '<div class="val"><b class="num">' + (s.winRate == null ? '—' : s.winRate + '%') + '</b><span>win rate</span></div></div>' +
        '<div class="small muted mt8">' + s.won + ' won of ' + s.decided + ' decided</div></div>' +
        '<div class="streak-card"><div class="streak-n">' + ICON.flame + '<b class="num">' + s.streakWeeks + '</b></div><span class="small muted">week' + (s.streakWeeks === 1 ? '' : 's') + ' in a row with a quote out</span>' +
        '<div class="wk" title="Last 8 weeks" role="img" aria-label="' + weeksOn.filter(Boolean).length + ' of the last 8 weeks had a quote sent">' + weeksOn.map(function (on) { return '<i class="' + (on ? 'on' : '') + '"></i>'; }).join('') + '</div></div></div>' +
        '<dl class="kgrid">' +
        kstat('Total won', money0(s.totalWon), s.won + ' job' + (s.won === 1 ? '' : 's')) +
        kstat('Total quoted', money0(s.totalQuoted), s.sent + ' sent') +
        kstat('Pipeline', money0(s.pipelineValue), 'open and unexpired') +
        kstat('Average quote', money0(s.averageQuote), 'across sent quotes') +
        kstat('Time to send', durationFmt(s.avgMinutesToSend), 'from draft to sent') +
        kstat('Quotes', String(s.quotes), (s.byStatus.draft || 0) + ' in draft') +
        '</dl>' +
        '<section class="block"><div class="block-head"><h2>Last 8 weeks</h2><div class="chart-legend"><span><i class="lg-quoted"></i>Quoted</span><span><i class="lg-won"></i>Won</span></div></div>' +
        '<div class="chart" id="chart"></div><p class="tiny muted mt8 mb0">By the week each quote was sent, so “won” is always part of “quoted”.</p></section>' +
        '<section class="block"><div class="block-head"><h2>Where your quotes are</h2></div>' + statusBar(s.byStatus) + '</section>' +
        (s.sent ? '' : '<div class="note mt16"><div>Your scoreboard fills in as you send quotes. <a href="#/new">Snap one now</a>.</div></div>');
      // Drawn at the container's real width, so 11px labels are 11px on a
      // phone and on a monitor rather than scaling with the viewBox.
      var drawChart = function () { var el = $('#chart'); if (!el) return window.removeEventListener('resize', drawChart); el.innerHTML = barChart(s.chart, el.clientWidth); wireChart(s.chart); };
      drawChart();
      window.addEventListener('resize', drawChart);
    }).catch(function (e) { showError(e, view); });
  }

  function kstat(label, value, sub) {
    return '<div class="kstat"><dt>' + esc(label) + '</dt><dd><span class="v num">' + esc(value) + '</span><span class="s">' + esc(sub) + '</span></dd></div>';
  }

  /** Grouped bars: quoted vs won per week. One axis, rounded data-ends on the
   *  baseline, 2px gap between the pair, a hover tooltip per week. */
  function barChart(rows, width) {
    var W = Math.max(260, Math.round(width || 640)), H = W < 500 ? 200 : 240, padL = 44, padR = 8, padT = 12, padB = 26;
    var max = Math.max.apply(null, rows.map(function (r) { return r.quoted; }).concat([1]));
    var step = Math.pow(10, Math.floor(Math.log10(max)));
    var nice = Math.ceil(max / step) * step; if (nice / step > 5) step *= 2; nice = Math.ceil(max / step) * step;
    var ih = H - padT - padB, iw = W - padL - padR;
    var y = function (v) { return padT + ih - (v / nice) * ih; };
    var gw = iw / rows.length, bw = Math.max(6, Math.min(26, (gw - 16) / 2));
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Quoted and won value by week, last 8 weeks">';
    for (var g = 0; g <= nice; g += step) {
      out += '<line class="ax" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(g) + '" y2="' + y(g) + '"/>' +
        '<text class="axt" x="' + (padL - 8) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + moneyShort(g) + '</text>';
    }
    var bar = function (x, v, cls) {
      if (!v) return '';
      var top = y(v), h = padT + ih - top, r = Math.min(4, h);
      // Rounded top, square foot on the baseline.
      return '<path class="' + cls + '" d="M' + x + ',' + (padT + ih) + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + r) + 'V' + (padT + ih) + 'Z"/>';
    };
    rows.forEach(function (r, i) {
      var cx = padL + gw * i + gw / 2;
      out += bar(cx - bw - 1, r.quoted, 'b-quoted') + bar(cx + 1, r.won, 'b-won');
      var d = new Date(r.week + 'T00:00:00Z');
      if (W >= 500 || i % 2 === 1) out += '<text class="axt" x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + '</text>';
      out += '<rect class="hit" data-w="' + i + '" x="' + (padL + gw * i) + '" y="' + padT + '" width="' + gw + '" height="' + ih + '" rx="6"/>';
    });
    out += '<line class="ax base" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (padT + ih) + '" y2="' + (padT + ih) + '"/></svg>';
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
          '<div><i class="lg-quoted"></i>Quoted ' + money0(r.quoted) + ' · ' + r.count + '</div><div><i class="lg-won"></i>Won ' + money0(r.won) + '</div>';
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
    var parts = [['draft', 'Draft'], ['sent', 'Sent'], ['viewed', 'Viewed'], ['changes', 'Changes'], ['accepted', 'Won'], ['declined', 'Declined'], ['expired', 'Expired']];
    var total = parts.reduce(function (a, p) { return a + (by[p[0]] || 0); }, 0);
    if (!total) return '<p class="small muted mb0">No quotes yet.</p>';
    return '<div class="stack-bar" role="img" aria-label="Quotes by status">' + parts.filter(function (p) { return by[p[0]]; }).map(function (p) {
      return '<i class="sb-' + p[0] + '"' + css({ w: (by[p[0]] / total * 100) + '%' }) + ' title="' + p[1] + ': ' + by[p[0]] + '"></i>';
    }).join('') + '</div><div class="legend">' + parts.filter(function (p) { return by[p[0]]; }).map(function (p) {
      return '<span><i class="sb-' + p[0] + '"></i>' + p[1] + ' <b class="num">' + by[p[0]] + '</b></span>';
    }).join('') + '</div>';
  }

  /* ---------------- business ---------------- */

  var SWATCHES = ['#0fb58a', '#0891b2', '#2563eb', '#4f46e5', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#15803d', '#334155', '#111827'];
  var LOGOS = ['🎨', '🌿', '🔧', '🧽', '🏠', '🚰', '⚡', '📷', '🎉', '🪚', '🧱', '🪴', '🛠️', '✨', '🌊', '☀️'];

  function renderBusiness() {
    if (!signedIn()) return signedOutPitch('Your brand on every quote', 'Name, logo, colors, license number, rates and terms — set once, on every quote you send.');
    var p = clone(profile());
    p.rates = (p.rates || []).map(function (r) { return clone(r); });
    var meta = state.meta || { trades: {} };
    var maxRates = meta.maxRates || 40;
    view.innerHTML =
      '<div class="page-head"><div><h1>Business</h1><p class="sub">How every quote looks and adds up.</p></div></div>' +
      '<div class="dk-2"><div>' +
      '<div class="brand-preview" id="bprev"></div>' +
      '<section class="block"><div class="block-head"><h2>Identity</h2></div><div class="group">' +
      '<div class="cell"><label for="bName">Business name</label><input id="bName" maxlength="60" placeholder="Brightline Painting Co." value="' + esc(p.name) + '"></div>' +
      '<div class="cell"><label for="bTrade">Trade</label><select id="bTrade">' + Object.keys(meta.trades).map(function (k) { return '<option value="' + k + '"' + (k === p.trade ? ' selected' : '') + '>' + esc(meta.trades[k].label) + '</option>'; }).join('') + '</select></div>' +
      '<div class="cell"><label for="bLogo">Logo</label><input id="bLogo" maxlength="4" placeholder="Emoji or initials" value="' + esc(p.logo) + '"></div></div>' +
      '<div class="logos" id="logos" role="group" aria-label="Pick a logo">' + LOGOS.map(function (l) { return '<button type="button" data-logo="' + l + '" class="' + (l === p.logo ? 'on' : '') + '">' + l + '</button>'; }).join('') + '</div>' +
      '<p class="lbl mt16">Brand color</p>' +
      '<div class="swatches" id="swatches" role="group" aria-label="Brand color">' + SWATCHES.map(function (c) { return '<button type="button" data-c="' + c + '"' + css({ c: c }) + ' class="' + (c === p.color ? 'on' : '') + '" aria-label="' + c + '"></button>'; }).join('') +
      '<label title="Custom color" class="custom-color"><span class="vh">Custom color</span><input type="color" id="bColor" value="' + esc(p.color) + '"></label></div></section>' +
      '<section class="block"><div class="block-head"><h2>Contact</h2><span class="small muted">Shown on quotes</span></div><div class="group">' +
      '<div class="cell"><label for="bPhone">Phone</label><input id="bPhone" type="tel" maxlength="30" placeholder="(555) 555-0100" value="' + esc(p.phone) + '"></div>' +
      '<div class="cell"><label for="bEmail">Email</label><input id="bEmail" type="email" maxlength="120" placeholder="hello@yourbusiness.com" value="' + esc(p.email) + '"></div>' +
      '<div class="cell"><label for="bLic">License #</label><input id="bLic" maxlength="40" placeholder="Optional" value="' + esc(p.license) + '"></div></div></section>' +
      '</div><div class="dk-sticky">' +
      '<section class="block"><div class="block-head"><h2>Money</h2></div><div class="group">' +
      '<div class="cell"><label for="bRate">Hourly rate</label><input id="bRate" inputmode="decimal" value="' + esc(p.hourlyRate) + '"><span class="unit">$/hr</span></div>' +
      '<div class="cell"><label for="bMarkup">Markup</label><input id="bMarkup" inputmode="decimal" value="' + esc(p.markupPct) + '"><span class="unit">%</span></div>' +
      '<div class="cell"><label for="bTax">Sales tax</label><input id="bTax" inputmode="decimal" value="' + esc(p.taxPct) + '"><span class="unit">%</span></div>' +
      '<div class="cell"><label for="bValid">Quotes valid</label><input id="bValid" inputmode="numeric" value="' + esc(p.validDays) + '"><span class="unit">days</span></div></div>' +
      '<p class="hint">Markup is added to materials, equipment and other lines — never to labor, which your rate already covers. Customers see the marked-up price only.</p></section>' +
      '<section class="block"><div class="block-head"><h2>Price list</h2><span class="small muted num" id="rateCount"></span></div>' +
      '<p class="small muted">What things cost you, per unit. ' + (voiceOn() ? 'When a job is read from photos and a voice note, each line is priced from this list first, then your templates and past quotes, then your hourly rate. The AI never sets a price.' : 'Kept with your business so every quote starts from your own numbers.') + '</p>' +
      '<div id="rateRows" class="rates"></div><button type="button" class="add-line" id="rateAdd">' + ICON.plus + 'Add a price</button></section>' +
      '<section class="block"><div class="block-head"><h2>Payment terms</h2></div><label class="vh" for="bTerms">Payment terms</label><textarea class="input" id="bTerms" maxlength="400" rows="3">' + esc(p.terms) + '</textarea></section>' +
      '<div id="bErr"></div><button type="button" class="btn block lg mt16" id="bSave">Save</button>' +
      '<section class="block"><div class="block-head"><h2>Account</h2></div><div class="row spread"><div class="grow wrap-any"><b class="small">' + esc(state.me.email) + '</b><div class="tiny muted">' + (state.me.tier === 'paid' ? 'Member · Sonnet' : 'Free · Haiku') + '</div></div><button type="button" class="btn small ghost" id="acct">Manage</button></div></section>' +
      '</div></div>' +
      '<datalist id="units">' + (meta.units || []).map(function (u) { return '<option value="' + esc(u) + '">'; }).join('') + '</datalist>';

    var preview = function () {
      $('#bprev').innerHTML = '<div class="qdoc flat"' + brandCss(p.color) + '><div class="qd-head"><div class="qd-biz"><div class="qd-logo">' + esc(p.logo || initials(p.name || 'Your Business')) + '</div><div><h2>' + esc(p.name || 'Your business name') + '</h2>' +
        '<div class="sub">' + [(meta.trades[p.trade] || {}).label, p.license].filter(Boolean).map(esc).join(' · ') + '</div></div></div>' +
        '<div class="qd-contact">' + (p.phone ? '<span>' + ICON.phone + esc(p.phone) + '</span>' : '') + (p.email ? '<span>' + ICON.mail + esc(p.email) + '</span>' : '') + (!p.phone && !p.email ? '<span>This is how your quotes will look</span>' : '') + '</div></div></div>';
    };
    preview();

    var drawRates = function () {
      $('#rateCount').textContent = p.rates.length + ' of ' + maxRates;
      $('#rateAdd').disabled = p.rates.length >= maxRates;
      $('#rateRows').innerHTML = p.rates.length ? p.rates.map(function (r, i) {
        return '<div class="rate" data-i="' + i + '"><div class="rate-top"><input class="input" data-r="name" maxlength="80" placeholder="e.g. Eggshell wall paint" aria-label="Price ' + (i + 1) + ' name" value="' + esc(r.name) + '">' +
          '<button type="button" class="icon-btn" data-rrm aria-label="Remove price ' + (i + 1) + '">' + ICON.x + '</button></div>' +
          '<div class="rate-nums"><select data-r="category" aria-label="Kind">' + CAT_ORDER.map(function (c) { return '<option value="' + c + '"' + (c === r.category ? ' selected' : '') + '>' + CATS[c].label + '</option>'; }).join('') + '</select>' +
          '<div class="money-in"><input class="n" data-r="unitPrice" inputmode="decimal" aria-label="Your price" placeholder="0" value="' + esc(r.unitPrice || '') + '"></div>' +
          '<span class="per">per</span><input class="n unit" data-r="unit" list="units" maxlength="12" aria-label="Unit" value="' + esc(r.unit) + '"></div></div>';
      }).join('') : '<p class="col-empty">No prices yet. Add what you buy and charge for most.</p>';
      $$('#rateRows .rate').forEach(function (row) {
        var r = p.rates[Number(row.dataset.i)];
        $$('[data-r]', row).forEach(function (inp) { inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', function () { r[inp.dataset.r] = inp.value; }); });
        $('[data-rrm]', row).onclick = function () { p.rates.splice(Number(row.dataset.i), 1); drawRates(); };
      });
    };
    drawRates();
    $('#rateAdd').onclick = function () {
      p.rates.push({ name: '', category: 'material', unit: 'ea', unitPrice: '' });
      drawRates();
      var ins = $$('#rateRows [data-r=name]'); if (ins.length) ins[ins.length - 1].focus();
    };

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
        state.me.profile = np; p.rates = (np.rates || []).map(function (r) { return clone(r); }); drawRates();
        drawTop(); toast('Saved. Every quote wears it now.');
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
    lab.href = '/'; lab.className = 'lab-link'; lab.textContent = 'Lab';
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
