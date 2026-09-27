/* Tipout - the page. One file, no build step, every typed or model-read string escaped. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');
  var R = window.TipoutRules;
  var QR = window.TipoutQR;

  // Where the app is mounted: '/' on its own, '/tipout/' inside the lab. A
  // receipt lives one level down (s/<token>) with <base href="../">, so the
  // base comes from the document's base URI rather than the path.
  var BASE = new URL('.', document.baseURI).pathname;
  var PUB = location.pathname.match(/\/s\/([A-Za-z0-9_-]{22})\/?$/);
  var K_SETUP = 'tipout-setup';
  var K_DRAFT = 'tipout-draft';

  var state = {
    me: null, demo: null,
    setup: recall(K_SETUP),     // mine: the server's when signed in, else this browser's
    draft: recall(K_DRAFT),     // mine: tonight, in progress
    sample: null,               // the sample's own setup + draft, in memory only
    edit: null,                 // a saved shift being looked at: {id, share, draft}
    openHow: {},
  };

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var enc = encodeURIComponent;
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function localDay(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  /** The shift being closed: after midnight and before 5 a.m. it is still last night's. */
  function shiftDay() { var d = new Date(); if (d.getHours() < 5) d.setDate(d.getDate() - 1); return localDay(d); }
  function shiftPart() { var h = new Date().getHours(); return h >= 5 && h < 16 ? 'lunch' : 'dinner'; }

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

  /** A 402 is a till, not a wall: say what happened and where to go. */
  function showError(err, where) {
    if (err && err.status === 402) return openCreditSheet(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<div class="err" role="alert">' + esc(msg) + '</div>'; else toast(msg, 3800);
  }

  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function initial(s) { return String(s || '?').trim().charAt(0).toUpperCase() || '?'; }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it.'); });
  }
  /** navigator.share where the browser has it, else copy. */
  function shareOut(title, text, url) {
    var data = { title: title, text: text };
    if (url) data.url = url;
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      navigator.share(data).catch(function (e) { if (e && e.name !== 'AbortError') copy(url || text, 'Copied'); });
    } else copy(url ? (text ? text + ' ' : '') + url : text, url ? 'Link copied' : 'Copied');
  }
  function linkFor(path) { return location.origin + BASE + path; }

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  };

  /* ---------------- me and the top bar ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) {
      state.me = me;
      if (me.signedIn) {
        if (me.setup) { state.setup = me.setup; store(K_SETUP, me.setup); }
        else if (state.setup) { pushSetup(state.setup); }
      }
      drawTop();
      return me;
    }).catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
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
    el.innerHTML = '<span class="pill credit" title="AI credit, for snapping POS reports">' + (b.unlimited ? '∞' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span>' +
      '<button class="avatar-btn" id="acctBtn" aria-label="Account">' + esc(initial(me.email)) + '</button>';
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
    return scrim.firstChild;
  }
  function closeSheet() { var s = $('#scrim'); if (s) s.remove(); var q = $('.qr-big'); if (q) q.remove(); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function openAccount(reason) {
    if (signedIn()) return openProfileSheet();
    var mode = 'register';
    function draw(root) {
      root.innerHTML = '<div class="grab"></div>' +
        '<h2>' + (mode === 'register' ? 'Save your shifts — free.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'The split, the envelopes and the arithmetic never need an account. One is for keeping your pool rules and your week of shifts, and for receipt links your staff can open. You also get $2 of AI credit for snapping POS reports — about a cent each. One account works across every app on this site.'
          : 'Same account as the other apps on this site.')) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button>' +
        '</form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="center small muted" style="margin-top:10px">' +
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
      var em = $('input[name=email]', root);
      if (em) setTimeout(function () { try { em.focus(); } catch (e) { /* ignore */ } }, 60);
    }
    sheet('', function (root) { draw(root); });
  }

  function afterSignIn() {
    closeSheet();
    return loadMe().then(function () { toast('You’re in.'); route(); });
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
      '<div style="height:10px;margin-top:10px;background:var(--track);border-radius:9px;overflow:hidden"><i style="display:block;height:100%;width:' + pct + '%;background:var(--bar)"></i></div>' +
      '<p class="small muted" style="margin:10px 0 0">Snapping a POS report costs about a cent. The split, the envelopes, the receipts, history and the CSV are free.</p>' +
      '<div id="billing" style="margin-top:12px"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" style="margin-top:10px">Sign out</button>',
      function (root) {
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
      '<p class="muted small">Everything else keeps working: type the tips in and the split, envelopes, receipts and history cost nothing.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- setup: the pool rules and roster ---------------- */

  var pushTimer = null;
  function pushSetup(setup) {
    if (!signedIn()) return Promise.resolve();
    return api('PUT', 'api/setup', setup).then(function (r) { state.setup = r.setup; store(K_SETUP, r.setup); return r.setup; });
  }
  /** Keep the setup: in this browser always, on the server when signed in. */
  function saveSetup(setup, quiet) {
    var v = R.validateSetup(setup);
    if (v.error) return v;
    state.setup = v.setup;
    store(K_SETUP, v.setup);
    clearTimeout(pushTimer);
    if (signedIn()) {
      pushTimer = setTimeout(function () {
        pushSetup(v.setup).then(function () { var s = $('#savedState'); if (s) s.textContent = 'Saved to your account'; })
          .catch(function (e) { if (!quiet) showError(e); });
      }, 500);
    }
    return v;
  }
  function rulesOf(setup) {
    return { method: setup.method, restBy: setup.restBy, cashDollars: setup.cashDollars, roles: setup.roles, tipouts: setup.tipouts };
  }
  function roleName(setup, key) { for (var i = 0; i < setup.roles.length; i++) if (setup.roles[i].key === key) return setup.roles[i].name; return key; }
  function roleOf(setup, key) { for (var i = 0; i < setup.roles.length; i++) if (setup.roles[i].key === key) return setup.roles[i]; return null; }

  /* ---------------- drafts ---------------- */

  function newDraft() {
    return { date: shiftDay(), part: shiftPart(), card: '', cash: '', sales: '', on: {}, q: {}, drawer: null, countOpen: false, coins: false, filled: [] };
  }
  function draftFromShift(shift) {
    var d = newDraft();
    d.date = shift.date; d.part = shift.part;
    d.card = shift.card ? R.plain(shift.card) : ''; d.cash = shift.cash ? R.plain(shift.cash) : '';
    d.sales = shift.sales === null || shift.sales === undefined ? '' : R.plain(shift.sales);
    shift.crew.forEach(function (p) { d.on[p.pid] = true; d.q[p.pid] = p.q; });
    d.drawer = shift.drawer ? clone(shift.drawer) : null;
    d.countOpen = Boolean(shift.drawer);
    return d;
  }

  /** The draft as a shift the rules can check: crew from the roster. */
  function toShift(setup, d, extra) {
    var crew = [];
    (extra || []).concat(setup.people).forEach(function (p) {
      if (!d.on[p.id] || crew.some(function (c) { return c.pid === p.id; })) return;
      crew.push({ pid: p.id, name: p.name, role: p.role, q: d.q[p.id] || 0 });
    });
    return { date: d.date, part: d.part, card: d.card, cash: d.cash, sales: d.sales, crew: crew, drawer: d.drawer, rules: rulesOf(setup) };
  }

  /* ---------------- routing ---------------- */

  function tabFor(parts) {
    var p = parts[0] === 'sample' ? parts[1] : parts[0];
    if (p === 'team' || p === 'start') return 'team';
    if (p === 'history' || p === 'shift') return 'history';
    return 'split';
  }

  function route() {
    closeSheet();
    if (PUB) return renderPublic(PUB[1]);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return ''; } });
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tabFor(parts)); });
    window.scrollTo(0, 0);
    if (parts[0] === 'sample') {
      return loadDemo().then(function (d) {
        if (!state.sample) state.sample = { setup: clone(d.setup), draft: draftFromShift(Object.assign({}, d.tonight, { card: R.toCents(d.tonight.card), cash: R.toCents(d.tonight.cash), sales: R.toCents(d.tonight.sales), crew: d.tonight.crew.map(function (c) { return { pid: c.pid, q: R.toQuarters(c.hours) }; }) })) };
        if (parts[1] === 'team') return renderTeam(sampleCtx());
        if (parts[1] === 'history') return renderHistory(sampleCtx());
        return renderSplit(sampleCtx());
      }).catch(function (e) { showError(e, view); });
    }
    if (parts[0] === 'start') return renderStart(parts[1] || '');
    if (parts[0] === 'team') return state.setup ? renderTeam(mineCtx()) : go('#/start');
    if (parts[0] === 'history') return renderHistory(mineCtx());
    if (parts[0] === 'shift' && parts[1]) return openSaved(parts[1]);
    if (parts[0] !== 'shift') state.edit = null;
    if (parts[0] === 'split') return state.setup ? renderSplit(mineCtx()) : go('#/start');
    // Home: straight to tonight's split when there is a pool; else the landing.
    if (state.setup) return renderSplit(mineCtx());
    if (signedIn()) return go('#/start');
    return renderLanding();
  }
  function go(h) { if (location.hash === h) route(); else location.hash = h; }

  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () {
      var sample = /^#\/sample/.test(location.hash);
      var t = b.dataset.tab;
      if (sample) { go('#/sample' + (t === 'split' ? '' : '/' + t)); return; }
      if (!state.setup && t !== 'history') { go(signedIn() ? '#/start' : '#/'); return; }
      go(t === 'split' ? '#/split' : '#/' + t);
    };
  });
  var ready = false;
  window.addEventListener('hashchange', function () { if (ready || PUB) route(); });

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner" aria-label="Loading"></span></div>'; }

  function sampleCtx() {
    var d = state.demo;
    return {
      sample: true, base: '#/sample', setup: state.sample.setup, draft: state.sample.draft, venue: d.venue,
      saveDraft: function () { /* the sample lives in memory */ },
      saveSetup: function (s) { var v = R.validateSetup(s); if (!v.error) state.sample.setup = v.setup; return v; },
    };
  }
  function mineCtx() {
    if (!state.draft) state.draft = newDraft();
    return { sample: false, base: '#', setup: state.setup, draft: state.draft, saveDraft: function () { store(K_DRAFT, state.draft); }, saveSetup: saveSetup };
  }
  function sampleBar(what) {
    return '<div class="sample-bar"><span><b>SAMPLE</b> · ' + esc(what) + '</span>' +
      (state.setup ? '<a class="btn small" href="#/split">Back to my pool</a>' : '<a class="btn small" href="#/start">Set up my pool</a>') + '</div>';
  }

  /* ---------------- landing ---------------- */

  function renderLanding() {
    view.innerHTML =
      '<section class="hero"><div class="hero-grid"><div>' +
      '<span class="kicker">🫙 For bars, restaurants and coffee shops</span>' +
      '<h1>Split tonight’s tips in <em>under a minute</em>.</h1>' +
      '<p class="lede">Tick who worked, tap in hours, type the card and cash tips. Every share to the cent with the arithmetic shown, cash envelopes built from the bills in the drawer, and a receipt link each person can check.</p>' +
      '<div class="ctas"><a class="btn lg" href="#/sample">Try a sample bar shift →</a><a class="btn lg ghost" href="#/start">Set up my pool</a></div>' +
      '<div class="trust"><span>No account needed to split</span><span>Balanced to the cent, always</span><span>First names only</span></div>' +
      '</div><div id="heroPreview" aria-hidden="true"></div></div></section>' +
      '<div class="steps">' +
      '<div class="step"><div class="ic">⚖️</div><h3>Set the rules once</h3><p>By hours, by role points, or tip-outs to the bar and kitchen first. Your roles, your percentages.</p></div>' +
      '<div class="step"><div class="ic">⏱️</div><h3>Close in a minute</h3><p>Tick who worked, quick-set hours, type the tips — or snap the POS report and we fill them in.</p></div>' +
      '<div class="step"><div class="ic">🧾</div><h3>Show your working</h3><p>A QR code at close opens each person’s receipt: how their share was worked out, number by number.</p></div>' +
      '</div>' +
      '<p class="fine">Tipout does the arithmetic your house rules describe. It flags a manager or supervisor in the pool — US federal law (the FLSA, since 2018) bars them from keeping pooled tips — but it is not legal or payroll advice: check your state and local rules.</p>';
    loadDemo().then(function (d) {
      var el = $('#heroPreview');
      if (!el) return;
      var card = R.shareCard(Object.assign({}, d.tonight, { part: 'dinner' }), d.result, 'pmaya', null);
      el.innerHTML = receiptHtml(card, { compact: true });
    }).catch(function () { /* the preview is decoration */ });
  }

  /* ---------------- first run: pick a template, add the team ---------------- */

  function renderStart(step) {
    var s = state.wiz || (state.wiz = { tpl: null, people: [] });
    if (step === 'team' && s.tpl) return renderStartTeam(s);
    view.innerHTML =
      '<div class="wiz-steps" aria-hidden="true"><i class="on"></i><i></i></div>' +
      '<div class="page-head"><div><div class="eyebrow">Step 1 of 2</div><h1>How does your house split tips?</h1><div class="sub">Pick the closest. Every role, point and percentage can be changed later.</div></div></div>' +
      '<div class="tpl-grid">' + R.TEMPLATES.map(function (t) {
        return '<button class="tpl' + (s.tpl === t.key ? ' on' : '') + '" data-tpl="' + esc(t.key) + '"><span class="e" aria-hidden="true">' + t.emoji + '</span><b>' + esc(t.label) + '</b><span>' + esc(t.blurb) + '</span></button>';
      }).join('') + '</div>' +
      '<p class="fine">Not sure? Most bars and cafés start <b>hours-based</b>. <a href="#/sample">See a sample shift first →</a></p>';
    $$('[data-tpl]').forEach(function (b) {
      b.onclick = function () { s.tpl = b.dataset.tpl; go('#/start/team'); };
    });
  }

  function renderStartTeam(s) {
    var rules = R.template(s.tpl);
    function draw() {
      view.innerHTML =
        '<a class="back" href="#/start">' + ICON.back + 'Rules</a>' +
        '<div class="wiz-steps" aria-hidden="true"><i class="on"></i><i class="on"></i></div>' +
        '<div class="page-head"><div><div class="eyebrow">Step 2 of 2 · ' + esc(R.TEMPLATES.filter(function (t) { return t.key === s.tpl; })[0].label) + '</div><h1>Who’s on the team?</h1><div class="sub">First names only. Add everyone who can be in the pool; you tick who worked at close.</div></div></div>' +
        '<div class="card"><form id="addP" class="add-row" autocomplete="off">' +
        '<input class="input" id="pName" placeholder="First name" aria-label="First name" maxlength="30">' +
        '<select class="input" id="pRole" aria-label="Role">' + rules.roles.map(function (r) { return '<option value="' + esc(r.key) + '">' + esc(r.name) + '</option>'; }).join('') + '</select>' +
        '<button class="btn" type="submit">Add</button></form>' +
        '<div id="wizErr"></div>' +
        (s.people.length ? '<div class="chips" style="margin-top:14px">' + s.people.map(function (p, i) {
          return '<button class="chip" data-rm="' + i + '" aria-label="Remove ' + esc(p.name) + '">' + esc(p.name) + ' · ' + esc(roleName({ roles: rules.roles }, p.role)) + ' ✕</button>';
        }).join('') + '</div>' : '<p class="hint" style="margin-top:12px">Type a name and press Enter. You can add more people at close too.</p>') +
        '</div>' +
        '<div class="btn-row" style="margin-top:16px"><button class="btn lg" id="done">' + (s.people.length ? 'Split a shift with ' + s.people.length + ' →' : 'Skip — add people at close →') + '</button></div>';
      var f = $('#addP');
      f.onsubmit = function (e) {
        e.preventDefault();
        var name = R.cleanName($('#pName').value);
        if (!name) { $('#wizErr').innerHTML = '<div class="err">Type a first name.</div>'; return; }
        if (s.people.length >= R.LIMITS.roster) return;
        s.people.push({ id: R.newPid(), name: name, role: $('#pRole').value });
        var keep = $('#pRole').value;
        draw();
        $('#pRole').value = keep;
        $('#pName').focus();
      };
      $$('[data-rm]').forEach(function (b) { b.onclick = function () { s.people.splice(Number(b.dataset.rm), 1); draw(); }; });
      $('#done').onclick = function () {
        var setup = Object.assign(rules, { people: s.people });
        var v = saveSetup(setup);
        if (v.error) { $('#wizErr').innerHTML = '<div class="err">' + esc(v.error) + '</div>'; return; }
        state.wiz = null;
        state.draft = newDraft();
        store(K_DRAFT, state.draft);
        go('#/split');
      };
      setTimeout(function () { var n = $('#pName'); if (n && window.innerWidth > 700) n.focus(); }, 30);
    }
    draw();
  }

  /* ---------------- the split ---------------- */

  function renderSplit(ctx) {
    var setup = ctx.setup;
    var d = ctx.draft;
    var edit = ctx.edit;
    var head = (ctx.sample ? sampleBar(ctx.venue + ' is made up — play with anything. Nothing is saved.') : '') +
      (edit ? '<div class="banner info" style="margin-bottom:14px"><span class="e">🗂️</span><div class="grow"><b>Saved shift · ' + esc(R.dayShort(d.date)) + ' · ' + esc(R.partLabel(d.part)) + '</b><p>Changes here update the saved shift' + (edit.share ? ' and its receipt links' : '') + ' when you press Update.</p></div><a class="btn small ghost" href="#/split" id="leaveEdit">Close</a></div>' : '') +
      '<div class="page-head"><div><div class="eyebrow">' + esc(ctx.sample ? ctx.venue : (edit ? 'Saved shift' : 'End of shift')) + '</div><h1>' + (edit ? 'Edit the split' : 'Split the tips') + '</h1></div></div>';
    view.innerHTML = head +
      '<div class="dk-split"><div class="stack" id="colIn"></div><div class="stack split-out" id="colOut" aria-live="polite"></div></div>';
    var le = $('#leaveEdit');
    if (le) le.onclick = function (e) { e.preventDefault(); state.edit = null; go('#/split'); };
    drawInputs(ctx);
    drawOut(ctx);
  }

  function persist(ctx) { ctx.saveDraft(); }

  function drawInputs(ctx) {
    var setup = ctx.setup;
    var d = ctx.draft;
    var needSales = setup.method === 'tipout' && setup.tipouts.some(function (t) { return t.of === 'sales'; });
    var html =
      '<div class="card"><div class="label">Shift</div><div class="shift-row">' +
      '<input class="input date-in" type="date" id="dDate" value="' + esc(d.date) + '" aria-label="Shift date">' +
      '<div class="seg parts" role="group" aria-label="Part of the day">' + R.PARTS.map(function (p) {
        return '<button type="button" data-part="' + p.key + '" class="' + (d.part === p.key ? 'on' : '') + '" aria-pressed="' + (d.part === p.key) + '">' + esc(p.label) + '</button>';
      }).join('') + '</div></div></div>' +
      '<div class="card"><div class="label">Tips' + (d.filled.length ? '<span class="count" style="color:var(--amber)">from the photo — check them</span>' : '') + '</div><div class="money-grid">' +
      money('card', 'Card tips', '', d.card, d) + money('cash', 'Cash tips', '', d.cash, d) +
      money('sales', 'Food sales', needSales ? 'for the kitchen tip-out' : 'optional', d.sales, d, true) +
      '</div>' +
      '<label class="snap" id="snapLbl"><span class="ic" aria-hidden="true">📷</span><span class="grow"><b>Snap the POS tip report</b><small>' + (signedIn() ? 'We read the totals into these boxes · about 1¢ of AI credit' : 'Reads the totals for you · needs a free account') + '</small></span>' +
      (signedIn() ? '<input type="file" id="snapFile" accept="image/*" capture="environment">' : '') + '</label>' +
      '<div id="snapOut"></div></div>' +
      '<div class="card" id="crewCard"></div>';
    $('#colIn').innerHTML = html;

    $('#dDate').onchange = function (e) { if (R.isoDay(e.target.value)) { d.date = e.target.value; persist(ctx); drawOut(ctx); } };
    $$('[data-part]').forEach(function (b) {
      b.onclick = function () { d.part = b.dataset.part; persist(ctx); $$('[data-part]').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); drawOut(ctx); };
    });
    $$('[data-money]').forEach(function (inp) {
      inp.oninput = function () {
        var k = inp.dataset.money;
        d[k] = inp.value;
        d.filled = d.filled.filter(function (x) { return x !== k; });
        inp.classList.remove('filled');
        inp.classList.toggle('bad', inp.value.trim() !== '' && R.toCents(inp.value) === null);
        persist(ctx); drawOut(ctx);
      };
    });
    var snapLbl = $('#snapLbl');
    if (!signedIn()) snapLbl.onclick = function (e) { e.preventDefault(); openAccount('Snapping the POS report uses AI, so it needs a free account: $2 of credit, about a cent a photo. Typing the numbers is always free and never needs one.'); };
    var sf = $('#snapFile');
    if (sf) sf.onchange = function () { if (sf.files && sf.files[0]) snap(ctx, sf.files[0]); sf.value = ''; };
    drawCrew(ctx);
  }

  function money(k, label, note, val, d, wide) {
    return '<label class="money' + (wide ? ' wide' : '') + '"><span>' + esc(label) + (note ? '<em>' + esc(note) + '</em>' : '') + '</span><div class="mwrap"><i aria-hidden="true">$</i>' +
      '<input data-money="' + k + '" inputmode="decimal" autocomplete="off" enterkeyhint="next" placeholder="0.00" value="' + esc(val) + '" class="' + (d.filled.indexOf(k) >= 0 ? 'filled' : '') + (val && R.toCents(val) === null ? ' bad' : '') + '" aria-label="' + esc(label) + '"></div></label>';
  }

  function drawCrew(ctx) {
    var setup = ctx.setup;
    var d = ctx.draft;
    var people = setup.people;
    var on = people.filter(function (p) { return d.on[p.id]; });
    var qTotal = on.reduce(function (s, p) { return s + (d.q[p.id] || 0); }, 0);
    var el = $('#crewCard');
    el.innerHTML =
      '<div class="crew-head"><div class="label" style="margin:0">Who worked</div><span class="small muted num">' + R.plural(on.length, 'person', 'people') + ' · ' + R.hoursText(qTotal) + ' h</span></div>' +
      (people.length ? '<div class="presets"><span>Set ticked to</span>' + [4, 5, 6, 7, 8].map(function (h) { return '<button class="chip" data-all="' + h + '">' + h + 'h</button>'; }).join('') + '</div>' : '') +
      '<div id="prows">' + people.map(function (p) {
        var isOn = Boolean(d.on[p.id]);
        var role = roleOf(setup, p.role);
        var mgr = role && (role.manager || R.looksManager(role.name));
        return '<div class="prow' + (isOn ? ' on' : '') + '" data-pid="' + esc(p.id) + '">' +
          '<button class="who" data-tog="' + esc(p.id) + '" aria-pressed="' + isOn + '"><span class="tick" aria-hidden="true">✓</span><span style="min-width:0"><b>' + esc(p.name) + '</b><small>' + esc(role ? role.name : p.role) + (mgr ? ' · <span class="mgr">manager</span>' : '') + '</small></span></button>' +
          (isOn ? stepper(p.id, d.q[p.id] || 0) : '<span class="off">Off</span>') + '</div>';
      }).join('') + '</div>' +
      '<form class="add-row" id="quickAdd" autocomplete="off"><input class="input" id="qaName" placeholder="Add someone: first name" aria-label="First name" maxlength="30"><select class="input" id="qaRole" aria-label="Role">' +
      setup.roles.map(function (r) { return '<option value="' + esc(r.key) + '">' + esc(r.name) + '</option>'; }).join('') + '</select><button class="btn ghost" type="submit">Add</button></form>' +
      (people.length ? '' : '<p class="hint">Add everyone who worked tonight. They join your team for next time.</p>');

    $$('[data-tog]', el).forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.tog;
        if (d.on[id]) { delete d.on[id]; } else { d.on[id] = true; if (!d.q[id]) d.q[id] = lastQ(ctx) || 24; }
        persist(ctx); drawCrew(ctx); drawOut(ctx);
      };
    });
    $$('[data-all]', el).forEach(function (b) {
      b.onclick = function () {
        var q = Number(b.dataset.all) * 4;
        var any = false;
        people.forEach(function (p) { if (d.on[p.id]) { d.q[p.id] = q; any = true; } });
        if (!any) { toast('Tick who worked first.'); return; }
        persist(ctx); drawCrew(ctx); drawOut(ctx);
      };
    });
    wireSteppers(el, ctx);
    $('#quickAdd', el).onsubmit = function (e) {
      e.preventDefault();
      var name = R.cleanName($('#qaName').value);
      if (!name) { toast('Type a first name.'); return; }
      if (setup.people.length >= R.LIMITS.roster) { toast('A team can have up to ' + R.LIMITS.roster + ' people.'); return; }
      var s2 = clone(setup);
      var id = R.newPid();
      s2.people.push({ id: id, name: name, role: $('#qaRole').value });
      var v = ctx.saveSetup(s2);
      if (v.error) { toast(v.error); return; }
      ctx.setup = v.setup;
      d.on[id] = true; d.q[id] = lastQ(ctx) || 24;
      persist(ctx); drawCrew(ctx); drawOut(ctx);
      var n = $('#qaName'); if (n) n.focus();
    };
  }

  /** The most common hours tonight, so the next person ticked starts there. */
  function lastQ(ctx) {
    var counts = {};
    var best = 0; var bq = 0;
    Object.keys(ctx.draft.on).forEach(function (id) { var q = ctx.draft.q[id]; if (q) { counts[q] = (counts[q] || 0) + 1; if (counts[q] > best) { best = counts[q]; bq = q; } } });
    return bq;
  }

  function stepper(id, q) {
    return '<div class="stepper" role="group" aria-label="Hours">' +
      '<button type="button" data-step="-1" data-id="' + esc(id) + '" aria-label="Less time"' + (q <= 0 ? ' disabled' : '') + '>−</button>' +
      '<button type="button" class="val" data-hrs="' + esc(id) + '" aria-label="' + esc(R.hoursText(q)) + ' hours, tap for presets">' + esc(R.hoursText(q)) + '<small>h</small></button>' +
      '<button type="button" data-step="1" data-id="' + esc(id) + '" aria-label="More time"' + (q >= R.LIMITS.maxQuarters ? ' disabled' : '') + '>+</button></div>';
  }

  function wireSteppers(el, ctx) {
    var d = ctx.draft;
    $$('[data-step]', el).forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.id;
        d.q[id] = Math.max(0, Math.min(R.LIMITS.maxQuarters, (d.q[id] || 0) + Number(b.dataset.step)));
        persist(ctx);
        var row = b.closest('.prow');
        var tmp = document.createElement('div');
        tmp.innerHTML = stepper(id, d.q[id]);
        row.replaceChild(tmp.firstChild, b.closest('.stepper'));
        wireSteppers(row, ctx);
        var btn = $('[data-step="' + b.dataset.step + '"]', row); if (btn && !btn.disabled) btn.focus();
        updateCrewCount(ctx);
        drawOut(ctx);
      };
    });
    $$('[data-hrs]', el).forEach(function (b) {
      b.onclick = function () { openHours(ctx, b.dataset.hrs); };
    });
  }

  function updateCrewCount(ctx) {
    var d = ctx.draft;
    var on = ctx.setup.people.filter(function (p) { return d.on[p.id]; });
    var qTotal = on.reduce(function (s, p) { return s + (d.q[p.id] || 0); }, 0);
    var c = $('#crewCard .crew-head .small');
    if (c) c.textContent = R.plural(on.length, 'person', 'people') + ' · ' + R.hoursText(qTotal) + ' h';
  }

  function openHours(ctx, id) {
    var p = ctx.setup.people.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var presets = [3, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9, 10];
    sheet('<h2>' + esc(p.name) + '’s hours</h2><p class="muted small">Tap one, or use − and + for quarter hours.</p>' +
      '<div class="chips" style="margin:12px 0">' + presets.map(function (h) {
        return '<button class="chip' + (ctx.draft.q[id] === h * 4 ? ' on' : '') + '" data-h="' + h + '" style="min-width:64px">' + h + 'h</button>';
      }).join('') + '</div>' +
      '<label class="field"><span>Exact hours</span><input class="input" id="hExact" inputmode="decimal" value="' + esc(R.hoursText(ctx.draft.q[id] || 0)) + '"></label>' +
      '<button class="btn block" id="hOk">Done</button>', function (root) {
      function set(q) {
        if (q === null || q > R.LIMITS.maxQuarters) { toast('Hours are between 0 and 24.'); return; }
        ctx.draft.q[id] = q; persist(ctx); closeSheet(); drawCrew(ctx); drawOut(ctx);
      }
      $$('[data-h]', root).forEach(function (b) { b.onclick = function () { set(Number(b.dataset.h) * 4); }; });
      $('#hOk', root).onclick = function () { set(R.toQuarters($('#hExact', root).value)); };
    });
  }

  /* ---------------- snap the POS report ---------------- */

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

  function snap(ctx, file) {
    var out = $('#snapOut');
    out.innerHTML = '<div class="banner info" style="margin-top:10px"><span class="spinner" style="width:20px;height:20px;border-width:2px"></span><div>Reading the report… the photo is read once and never stored.</div></div>';
    shrink(file).then(function (image) { return api('POST', 'api/snap', { image: image }); }).then(function (r) {
      var d = ctx.draft;
      d.filled = [];
      ['card', 'cash', 'sales'].forEach(function (k) { if (r.proposal[k] !== '') { d[k] = r.proposal[k]; d.filled.push(k); } });
      persist(ctx);
      drawInputs(ctx); drawOut(ctx);
      $('#snapOut').innerHTML = '<div class="banner' + (r.confidence === 'high' ? '' : ' warn') + '" style="margin-top:10px"><span class="e">📷</span><div><b>Filled in ' + esc(r.filled.map(function (k) { return { card: 'card tips', cash: 'cash tips', sales: 'food sales' }[k]; }).join(', ')) + ' — check them against the report.</b>' +
        '<p>' + esc(r.note || '') + (r.dropped.length ? ' Left out (unreadable): ' + esc(r.dropped.join(', ')) + '.' : '') + ' Confidence: ' + esc(r.confidence) + '.</p></div></div>';
      loadMe();
    }).catch(function (e) {
      if (e.status === 402 || e.status === 401) { out.innerHTML = ''; return showError(e); }
      out.innerHTML = '<div class="banner bad" style="margin-top:10px"><span class="e">📷</span><div>' + esc(e.message) + '</div></div>';
    });
  }

  /* ---------------- results ---------------- */

  /** `raw` is what the server is sent: money as the dollars typed, never the
   *  validated cents - the server validates the same text itself. */
  function compute(ctx) {
    var raw = toShift(ctx.setup, ctx.draft);
    var v = R.validateShift(raw, null);
    if (v.error) return { error: v.error, field: v.field };
    var r = R.split(v.shift);
    if (r.error) return r;
    return { shift: v.shift, result: r, raw: raw };
  }

  function drawOut(ctx) {
    var el = $('#colOut');
    if (!el) return;
    var c = compute(ctx);
    if (c.error) {
      var tips = R.toCents(ctx.draft.card) || R.toCents(ctx.draft.cash);
      el.innerHTML = '<div class="card results-empty"><div class="e" aria-hidden="true">🫙</div><h3 style="margin:8px 0 4px">' +
        (c.field === 'crew' ? (ctx.setup.people.length ? 'Tick who worked' : 'Add who worked') : 'Almost there') + '</h3><p style="margin:0">' + esc(c.error) + '</p>' +
        (!tips && c.field === 'crew' ? '<p class="small" style="margin:8px 0 0">Then type the card and cash tips — the split appears here as you go.</p>' : '') + '</div>';
      return;
    }
    var r = c.result; var s = c.shift;
    var max = r.people.reduce(function (m, p) { return Math.max(m, p.total); }, 0) || 1;
    var html =
      '<div class="pool"><span class="jar" aria-hidden="true">🫙</span><div class="eyebrow">Tip pool · ' + esc(R.dayShort(s.date)) + ' · ' + esc(R.partLabel(s.part)) + '</div>' +
      '<div class="big num">' + esc(R.money(r.totalIn)) + '</div>' +
      '<div class="mix"><span>💳 ' + esc(R.money(r.card)) + ' card</span><span>💵 ' + esc(R.money(r.cash)) + ' cash</span>' + (r.sales !== null ? '<span>🍽 ' + esc(R.money(r.sales)) + ' food</span>' : '') + '</div>' +
      '<div class="how">' + esc(R.methodLine(r)) + ' ' + esc(R.plural(r.people.length, 'person', 'people')) + '.</div>' +
      '<div class="balance' + (r.check.balanced ? '' : ' off') + '"><span class="ok" aria-hidden="true">' + (r.check.balanced ? '✓' : '!') + '</span><span>Paid out <b class="num">' + esc(R.money(r.check.out)) + '</b> = tips in <b class="num">' + esc(R.money(r.check.in)) + '</b> — ' + (r.check.balanced ? 'balanced to the cent' : 'NOT balanced') + '</span></div></div>';
    if (r.headsUp) {
      html += '<div class="banner warn" role="note"><span class="e" aria-hidden="true">⚠️</span><div><b>' + esc(r.headsUp.title) + '</b><p>' + esc(r.headsUp.text) + '</p></div></div>';
    }
    r.notes.forEach(function (n) { html += '<div class="banner info"><span class="e" aria-hidden="true">ℹ️</span><p>' + esc(n) + '</p></div>'; });
    var tps = r.pieces.filter(function (p) { return p.kind === 'tipout'; });
    if (tps.length) {
      html += '<div class="card"><div class="label">Tip-outs first</div><div class="pieces">' + tps.map(function (p) {
        return p.skipped ? '<div class="piece skip"><span>' + esc(p.roleName) + ' · ' + esc(R.bpText(p.bp)) + ' of ' + (p.of === 'sales' ? 'food sales' : 'the tips') + '</span><span>skipped</span></div>'
          : '<div class="piece"><span>' + esc(p.roleName) + ' · ' + esc(p.formula) + '</span><b>' + esc(R.money(p.amount)) + '</b></div>';
      }).join('') + (function () { var rest = r.pieces.filter(function (p) { return p.kind === 'rest'; })[0]; return rest ? '<div class="piece"><span>The rest, by ' + (rest.by === 'points' ? 'points × hours' : 'hours') + '</span><b>' + esc(R.money(rest.amount)) + '</b></div>' : ''; })() + '</div></div>';
    }
    html += '<div class="card"><div class="label">Shares<span class="count">tap a name for the working</span></div><div class="plist">' + r.people.map(function (p) {
      var perH = p.q ? R.money(Math.round((p.total * 4) / p.q)) + '/h' : 'no hours';
      var isMgr = r.headsUp && r.headsUp.people.indexOf(p.pid) >= 0;
      return '<details class="sh' + (isMgr ? ' mgr-row' : '') + '" data-how="' + esc(p.pid) + '"' + (state.openHow[p.pid] ? ' open' : '') + '><summary>' +
        '<span class="av" aria-hidden="true">' + esc(initial(p.name)) + '</span>' +
        '<span class="nm"><b>' + esc(p.name) + '</b><small>' + esc(p.roleName) + ' · ' + esc(R.hoursText(p.q)) + ' h · ' + esc(perH) + '</small></span>' +
        '<span class="amt"><b>' + esc(R.money(p.total)) + '</b><small>' + esc(R.moneyTight(p.card)) + ' card · ' + esc(R.moneyTight(p.cash)) + ' cash</small></span></summary>' +
        '<div class="meter" aria-hidden="true"><i style="width:' + Math.round((p.total / max) * 100) + '%"></i></div>' +
        '<div class="how"><ol>' + p.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ol></div></details>';
    }).join('') + '</div></div>';
    html += '<div class="card" id="envCard"></div>';
    html += '<div class="card"><div class="act-bar">' + actions(ctx) + '</div></div>';
    el.innerHTML = html;
    $$('[data-how]', el).forEach(function (det) {
      det.addEventListener('toggle', function () { state.openHow[det.dataset.how] = det.open; });
    });
    drawEnvelopes(ctx, c);
    wireActions(ctx, c);
  }

  /* ---------------- envelopes ---------------- */

  function drawEnvelopes(ctx, c) {
    var d = ctx.draft;
    var el = $('#envCard');
    var r = c.result;
    if (!r.cashPaid && !r.cash) {
      el.innerHTML = '<div class="label">Cash envelopes</div><p class="muted small" style="margin:0">No cash tips tonight — everything goes out with the card tips.</p>';
      return;
    }
    var env = R.envelopesFor(r, d.drawer);
    var showCoins = d.coins || !ctx.setup.cashDollars;
    var counted = d.drawer ? R.drawerCents(d.drawer) : 0;
    var tag = env.status === 'exact' ? '<span class="tag good">✓ Exact change</span>' : env.status === 'short' ? '<span class="tag bad">Can’t make exact change</span>' : '<span class="tag">Not counted</span>';
    var html = '<div class="card-head"><div class="label" style="margin:0">Cash envelopes</div>' + tag + '</div>';
    html += '<button class="btn ghost block" id="countTog" aria-expanded="' + Boolean(d.countOpen) + '">' + (d.countOpen ? 'Hide the drawer count' : (d.drawer ? 'Edit the drawer count' : 'Count the drawer — which bills do you have?')) + '</button>';
    if (d.countOpen) {
      html += '<div class="drawer" style="margin-top:12px">' + R.DENOMS.filter(function (x) { return x.kind === 'bill' || showCoins; }).map(function (x) {
        var n = (d.drawer && d.drawer[String(x.c)]) || 0;
        return '<div class="den"><span class="bill bchip b' + x.c + '">' + esc(x.label) + '</span><div class="stepper" role="group" aria-label="' + esc(x.label) + ' count">' +
          '<button type="button" data-den="' + x.c + '" data-by="-1" aria-label="One fewer ' + esc(x.label) + '"' + (n ? '' : ' disabled') + '>−</button>' +
          '<button type="button" class="val" data-denset="' + x.c + '" aria-label="' + n + ' of ' + esc(x.label) + ', tap to type">' + n + '</button>' +
          '<button type="button" data-den="' + x.c + '" data-by="1" aria-label="One more ' + esc(x.label) + '">+</button></div></div>';
      }).join('') + '</div>' +
      (ctx.setup.cashDollars ? '<button class="link-btn small" id="coinTog">' + (d.coins ? 'Hide coins' : 'Coins in the drawer too?') + '</button>' : '') +
      '<div class="counted"><span class="muted">Counted <b class="num" style="color:var(--text)">' + esc(R.money(counted)) + '</b> · envelopes need <b class="num" style="color:var(--text)">' + esc(R.money(env.need)) + '</b></span>' +
      (d.drawer ? '<button class="link-btn small" id="countClear" style="padding:0;min-height:0">Clear</button>' : '') + '</div>' +
      (d.drawer && counted !== r.cash ? '<p class="hint">The count is ' + esc(R.money(counted)) + '; cash tips say ' + esc(R.money(r.cash)) + '. ' + (counted > r.cash ? 'Anything over stays in the drawer.' : 'Recount, or fix the cash tips above.') + '</p>' : '');
    }
    html += '<div class="banner ' + (env.status === 'exact' ? '' : env.status === 'short' ? 'bad' : 'info') + '" style="margin-top:12px"><span class="e" aria-hidden="true">' + (env.status === 'exact' ? '✅' : env.status === 'short' ? '🧮' : '💵') + '</span><div><p>' + esc(env.message) + '</p>' +
      env.advice.map(function (a) { return '<p style="margin-top:4px"><b style="display:inline">Fix:</b> ' + esc(a) + '</p>'; }).join('') + '</div></div>';
    if (r.toCard && ctx.setup.cashDollars) html += '<p class="hint">' + esc(R.money(r.toCard)) + ' in coins isn’t in any envelope — it goes out with the card tips.</p>';
    html += '<div class="env-grid">' + env.people.map(function (p) {
      return '<div class="env' + (p.short ? ' short' : '') + '"><div class="who2">' + esc(p.name) + '</div><div class="cash">' + esc(R.money(p.cents)) + '</div>' +
        '<div class="bills">' + p.bills.map(function (b) { return '<span class="bchip b' + b.c + '">' + b.n + ' × ' + esc(R.denomLabel(b.c)) + '</span>'; }).join('') + '</div>' +
        (p.short ? '<div class="miss">' + esc(R.money(p.short)) + ' missing</div>' : '') + '</div>';
    }).join('') + '</div>';
    el.innerHTML = html;
    $('#countTog', el).onclick = function () { d.countOpen = !d.countOpen; persist(ctx); drawEnvelopes(ctx, c); };
    var ct = $('#coinTog', el); if (ct) ct.onclick = function () { d.coins = !d.coins; persist(ctx); drawEnvelopes(ctx, c); };
    var cc = $('#countClear', el); if (cc) cc.onclick = function () { d.drawer = null; persist(ctx); drawEnvelopes(ctx, c); };
    $$('[data-den]', el).forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.den;
        d.drawer = d.drawer || {};
        d.drawer[k] = Math.max(0, Math.min(R.LIMITS.denomCount, (d.drawer[k] || 0) + Number(b.dataset.by)));
        if (!d.drawer[k]) delete d.drawer[k];
        if (!Object.keys(d.drawer).length) d.drawer = null;
        persist(ctx); drawEnvelopes(ctx, c);
        var again = $('[data-den="' + k + '"][data-by="' + b.dataset.by + '"]', $('#envCard'));
        if (again && !again.disabled) again.focus();
      };
    });
    $$('[data-denset]', el).forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.denset;
        var v = prompt('How many ' + R.denomLabel(Number(k)) + '?', String((d.drawer && d.drawer[k]) || 0));
        if (v === null) return;
        var n = Number(String(v).trim());
        if (!Number.isInteger(n) || n < 0 || n > R.LIMITS.denomCount) { toast('Count whole bills.'); return; }
        d.drawer = d.drawer || {};
        if (n) d.drawer[k] = n; else delete d.drawer[k];
        if (!Object.keys(d.drawer).length) d.drawer = null;
        persist(ctx); drawEnvelopes(ctx, c);
      };
    });
  }

  /* ---------------- save, share, copy ---------------- */

  function actions(ctx) {
    if (ctx.sample) {
      return '<button class="btn primary" id="aPreview">🧾 See a staff receipt</button>' +
        '<button class="btn ghost" id="aCopy">Copy as text</button><button class="btn ghost" id="aReset">Reset sample</button>';
    }
    if (ctx.edit) {
      return '<button class="btn primary" id="aUpdate">Update saved shift</button>' +
        '<button class="btn ghost" id="aShare">' + (ctx.edit.share ? '🧾 Receipts & QR' : '🧾 Share receipts') + '</button><button class="btn ghost" id="aCopy">Copy as text</button>' +
        '<button class="btn danger" id="aDelete" style="grid-column:1/-1">Delete this shift</button>';
    }
    return '<button class="btn primary" id="aSave">' + (signedIn() ? 'Save shift & share receipts' : 'Save & share receipts') + '</button>' +
      '<button class="btn ghost" id="aCopy">Copy as text</button><button class="btn ghost" id="aNew">Start a new shift</button>';
  }

  function wireActions(ctx, c) {
    var on = function (id, fn) { var b = $('#' + id); if (b) b.onclick = fn; };
    on('aCopy', function () { copy(R.receiptText(c.shift, c.result), 'The whole split is copied'); });
    on('aPreview', function () { openPreview(c); });
    on('aReset', function () { state.sample = null; route(); toast('Sample reset'); });
    on('aNew', function () {
      if (!confirm('Clear tonight’s numbers and start a new shift? Your team and rules stay.')) return;
      state.draft = newDraft(); store(K_DRAFT, state.draft); state.openHow = {}; route();
    });
    on('aSave', function (e) {
      if (!signedIn()) return openAccount('Saving shifts and sharing receipt links needs a free account — the links live on our server so staff can open them without one. Your split stays right here while you sign up.');
      var b = e.currentTarget; b.disabled = true;
      api('POST', 'api/shifts', c.raw).then(function (saved) {
        return api('POST', 'api/shifts/' + enc(saved.id) + '/share');
      }).then(function (sv) {
        state.draft = newDraft(); store(K_DRAFT, state.draft);
        state.edit = editFrom(sv);
        location.hash = '#/shift/' + enc(sv.id);
        toast('Saved. Receipts are ready to share.');
        setTimeout(function () { openShareSheet(sv); }, 60);
      }).catch(function (err) { b.disabled = false; showError(err); });
    });
    on('aUpdate', function (e) {
      var b = e.currentTarget; b.disabled = true;
      api('PUT', 'api/shifts/' + enc(ctx.edit.id), c.raw).then(function (sv) {
        ctx.edit.share = sv.share; b.disabled = false;
        toast(sv.share ? 'Updated — the receipt links show the new numbers.' : 'Updated.');
      }).catch(function (err) { b.disabled = false; showError(err); });
    });
    on('aShare', function () {
      var p = ctx.edit.share ? api('GET', 'api/shifts/' + enc(ctx.edit.id)) : api('POST', 'api/shifts/' + enc(ctx.edit.id) + '/share');
      p.then(function (sv) { ctx.edit.share = sv.share; openShareSheet(sv); }).catch(function (err) { showError(err); });
    });
    on('aDelete', function () {
      if (!confirm('Delete this shift? Its receipt links stop working too.')) return;
      api('DELETE', 'api/shifts/' + enc(ctx.edit.id)).then(function () { state.edit = null; toast('Deleted.'); go('#/history'); }).catch(function (err) { showError(err); });
    });
  }

  function openPreview(c) {
    var p = c.result.people[0];
    sheet('<h2>What a staff member sees</h2><p class="muted small">Scanning the QR at close opens a receipt like this — their share, how it was worked out, and the pool it came from. Numbers and first names only, no account needed. Links need a free account to create.</p>' +
      '<div class="chips" style="margin:10px 0">' + c.result.people.map(function (x, i) { return '<button class="chip' + (i === 0 ? ' on' : '') + '" data-pv="' + esc(x.pid) + '">' + esc(x.name) + '</button>'; }).join('') + '<button class="chip" data-pv="">Whole shift</button></div>' +
      '<div id="pvBox"></div>' + (signedIn() ? '' : '<button class="btn block" id="pvSign">Create a free account</button>'), function (root) {
      function show(pid) {
        $('#pvBox', root).innerHTML = receiptHtml(R.shareCard(c.shift, c.result, pid || null, null), {});
        $$('[data-pv]', root).forEach(function (b) { b.classList.toggle('on', b.dataset.pv === (pid || '')); });
      }
      $$('[data-pv]', root).forEach(function (b) { b.onclick = function () { show(b.dataset.pv); }; });
      var sb = $('#pvSign', root); if (sb) sb.onclick = function () { openAccount(); };
      show(p ? p.pid : '');
    });
  }

  function openShareSheet(sv) {
    var share = sv.share;
    if (!share) return;
    var whole = linkFor(share.url);
    var totals = {};
    sv.result.people.forEach(function (p) { totals[p.pid] = p.total; });
    sheet('<h2>Tip receipts</h2><p class="muted small">Staff open these with no account: their share and how it was worked out. Numbers and first names only; the links can’t be guessed, and you can revoke them.</p>' +
      '<div class="label">The whole shift</div>' +
      '<button class="qr-box" id="qrWhole" aria-label="Show the QR code full screen" style="border:0;cursor:pointer">' + QR.svg(whole, 'QR code for the whole shift') + '</button>' +
      '<div class="linkbox">' + esc(whole) + '</div>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn" id="shWhole">Share link</button><button class="btn ghost" id="bigWhole">Show QR full screen</button></div>' +
      '<div class="label">Each person’s own receipt</div>' +
      share.people.map(function (p) {
        return '<div class="plink"><span><b>' + esc(p.name) + '</b><small class="num">' + esc(R.money(totals[p.pid] || 0)) + '</small></span>' +
          '<button class="btn small ghost" data-qr="' + esc(p.pid) + '" aria-label="QR code for ' + esc(p.name) + '">QR</button>' +
          '<button class="btn small ghost" data-send="' + esc(p.pid) + '">Send</button></div>';
      }).join('') +
      '<button class="btn danger block" id="revoke" style="margin-top:16px">Revoke all links</button>', function (root) {
      var byPid = {};
      share.people.forEach(function (p) { byPid[p.pid] = p; });
      var title = 'Tip receipt · ' + R.dayShort(sv.shift.date) + ' · ' + R.partLabel(sv.shift.part);
      $('#shWhole', root).onclick = function () { shareOut(title, 'Tonight’s tip split, with the working:', whole); };
      var big = function () { bigQr(whole, 'Tonight’s tips', 'Scan to see the whole split and how every share was worked out.'); };
      $('#bigWhole', root).onclick = big;
      $('#qrWhole', root).onclick = big;
      $$('[data-qr]', root).forEach(function (b) {
        b.onclick = function () { var p = byPid[b.dataset.qr]; bigQr(linkFor(p.url), p.name, 'Scan to see your share — ' + R.money(totals[p.pid] || 0) + ' — and how it was worked out.'); };
      });
      $$('[data-send]', root).forEach(function (b) {
        b.onclick = function () { var p = byPid[b.dataset.send]; shareOut(title, p.name + ', your tips tonight: ' + R.money(totals[p.pid] || 0) + '. How it was worked out:', linkFor(p.url)); };
      });
      $('#revoke', root).onclick = function () {
        if (!confirm('Revoke every receipt link for this shift? Anyone who opens one will see that it is gone.')) return;
        api('DELETE', 'api/shifts/' + enc(sv.id) + '/share').then(function () {
          if (state.edit && state.edit.id === sv.id) state.edit.share = null;
          closeSheet(); toast('Links revoked.'); route();
        }).catch(function (e) { showError(e); });
      };
    });
  }

  function bigQr(url, title, text) {
    var o = document.createElement('div');
    o.className = 'qr-big'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', 'QR code');
    o.innerHTML = '<button type="button">Close</button><h3>' + esc(title) + '</h3>' + QR.svg(url, 'QR code for ' + title) + '<p>' + esc(text) + '</p>';
    $('button', o).onclick = function () { o.remove(); };
    document.body.appendChild(o);
  }

  /* ---------------- a saved shift ---------------- */

  /** A saved shift, opened with its OWN rules and crew - the setup it was
   *  split with - so an edit to the team since cannot change it. */
  function editFrom(sv) {
    var setup = Object.assign({}, sv.shift.rules, { people: sv.shift.crew.map(function (p) { return { id: p.pid, name: p.name, role: p.role }; }) });
    return { id: sv.id, share: sv.share, draft: draftFromShift(sv.shift), setup: setup };
  }
  function editCtx() {
    var e = state.edit;
    return {
      sample: false, base: '#', setup: e.setup, draft: e.draft, edit: e, saveDraft: function () {},
      saveSetup: function (s) { var v = R.validateSetup(s); if (!v.error) e.setup = v.setup; return v; },
    };
  }

  function openSaved(id) {
    if (!signedIn()) { go('#/'); return; }
    if (state.edit && state.edit.id === id) return renderSplit(editCtx());
    loading();
    api('GET', 'api/shifts/' + enc(id)).then(function (sv) {
      if (sv.error) throw new Error(sv.error);
      state.edit = editFrom(sv);
      renderSplit(editCtx());
    }).catch(function (e) {
      if (e.status === 404) { view.innerHTML = '<div class="empty"><div class="e">🔍</div><h2>No such shift</h2><p>It may have been deleted.</p><a class="btn" href="#/history">History</a></div>'; return; }
      showError(e, view);
    });
  }

  /* ---------------- team & rules ---------------- */

  function renderTeam(ctx) {
    var ts = clone(ctx.setup);
    var usesPts = function () { return ts.method === 'points' || (ts.method === 'tipout' && ts.restBy === 'points'); };
    function commit(full) {
      var v = ctx.saveSetup(ts);
      var err = $('#teamErr');
      if (v.error) { if (err) err.innerHTML = '<div class="banner bad"><span class="e">⚠️</span><p>' + esc(v.error) + '</p></div>'; return; }
      if (err) err.innerHTML = '';
      ctx.setup = v.setup;
      ts.roles.forEach(function (r, i) { r.key = v.setup.roles[i].key; });
      var st = $('#savedState'); if (st) st.textContent = ctx.sample ? 'Sample only — not saved' : (signedIn() ? 'Saving…' : 'Saved on this device');
      if (full) draw();
    }
    function draw() {
      var roleOpts = function (sel) { return ts.roles.map(function (r) { return '<option value="' + esc(r.key) + '"' + (r.key === sel ? ' selected' : '') + '>' + esc(r.name) + '</option>'; }).join(''); };
      view.innerHTML = (ctx.sample ? sampleBar('Change anything — the sample split follows. Nothing is saved.') : '') +
        '<div class="page-head"><div><div class="eyebrow">Set once</div><h1>Team &amp; rules</h1><div class="sub" id="savedState">' + (ctx.sample ? 'Sample only — not saved' : (signedIn() ? 'Saved to your account' : 'Saved on this device · <button class="link-btn" id="teamSign" style="min-height:0;padding:0">sign in to keep it everywhere</button>')) + '</div></div></div>' +
        '<div id="teamErr"></div>' +
        '<div class="dk-split"><div class="stack">' +
        '<div class="card"><h2>How the pool splits</h2><div class="tpl-grid" style="margin-top:12px">' + R.METHODS.map(function (m) {
          return '<button class="tpl' + (ts.method === m.key ? ' on' : '') + '" data-method="' + m.key + '" aria-pressed="' + (ts.method === m.key) + '"><span class="e" aria-hidden="true">' + m.emoji + '</span><b>' + esc(m.label) + '</b><span>' + esc(m.blurb) + '</span></button>';
        }).join('') + '</div>' +
        (ts.method === 'tipout' ? '<div class="label">Tip-outs, taken first</div><div id="tos">' + ts.tipouts.map(function (t, i) {
          return '<div class="to-row"><select class="input" data-to="' + i + '" aria-label="Role">' + roleOpts(t.to) + '</select><span class="words">gets</span>' +
            '<div class="stepper"><button type="button" data-bp="' + i + '" data-by="-50" aria-label="Half a percent less">−</button><span class="val" style="display:grid;place-items:center">' + esc(R.bpText(t.bp)) + '</span><button type="button" data-bp="' + i + '" data-by="50" aria-label="Half a percent more">+</button></div>' +
            '<span class="words">of</span><select class="input" data-of="' + i + '" aria-label="Of what"><option value="tips"' + (t.of === 'tips' ? ' selected' : '') + '>the tips</option><option value="sales"' + (t.of === 'sales' ? ' selected' : '') + '>food sales</option></select>' +
            '<button class="icon-btn" data-rmto="' + i + '" aria-label="Remove this tip-out">✕</button></div>';
        }).join('') + '</div>' + (ts.tipouts.length < R.LIMITS.tipouts ? '<button class="btn small ghost" id="addTo" style="margin-top:8px">+ Add a tip-out</button>' : '') +
          '<div class="label">Then the rest is split by</div><div class="seg" role="group" aria-label="Split the rest by"><button data-rest="hours" class="' + (ts.restBy === 'hours' ? 'on' : '') + '">Hours</button><button data-rest="points" class="' + (ts.restBy === 'points' ? 'on' : '') + '">Points × hours</button></div>' : '') +
        '<label class="switch" style="margin-top:14px"><input type="checkbox" id="cashD"' + (ts.cashDollars ? ' checked' : '') + '><span>Cash envelopes in whole dollars<small>Coins stay in the drawer and go out with the card tips.</small></span></label>' +
        '</div>' +
        '<div class="card"><h2>Roles</h2><p class="small muted" style="margin:4px 0 6px">' + (usesPts() ? 'Points weight each hour: a 1.2 hour counts 20% more than a 1.0 hour.' : 'Points only matter when the split uses them.') + '</p>' + ts.roles.map(function (r, i) {
          return '<div class="role-row"><input class="input" data-rname="' + i + '" value="' + esc(r.name) + '" aria-label="Role name" maxlength="24">' +
            (usesPts() ? '<div class="stepper"><button type="button" data-pts="' + i + '" data-by="-10" aria-label="Fewer points">−</button><span class="val" style="display:grid;place-items:center">' + esc(R.ptsText(r.pts)) + '<small>pts</small></span><button type="button" data-pts="' + i + '" data-by="10" aria-label="More points">+</button></div>' : '') +
            '<label class="mini-switch"><input type="checkbox" data-mgr="' + i + '"' + (r.manager ? ' checked' : '') + '>Manager / supervisor</label>' +
            (ts.roles.length > 1 ? '<button class="icon-btn" data-rmrole="' + i + '" aria-label="Remove ' + esc(r.name) + '">✕</button>' : '') + '</div>';
        }).join('') + (ts.roles.length < R.LIMITS.roles ? '<button class="btn small ghost" id="addRole" style="margin-top:8px">+ Add a role</button>' : '') +
        '<p class="hint">Marking a role as manager or supervisor never changes a number — it shows a heads-up when they are in the pool.</p></div>' +
        '</div><div class="stack">' +
        '<div class="card"><h2>Team <span class="small muted num">' + ts.people.length + '</span></h2><p class="small muted" style="margin:4px 0 6px">First names only. An initial is fine to tell two apart (Sam R.).</p>' +
        ts.people.map(function (p, i) {
          return '<div class="person-row"><input class="input" data-pname="' + i + '" value="' + esc(p.name) + '" aria-label="First name" maxlength="24"><select class="input" data-prole="' + i + '" aria-label="Role">' + roleOpts(p.role) + '</select>' +
            '<button class="icon-btn" data-rmp="' + i + '" aria-label="Remove ' + esc(p.name) + '">✕</button></div>';
        }).join('') +
        '<form class="add-row" id="teamAdd" autocomplete="off"><input class="input" id="taName" placeholder="First name" aria-label="First name" maxlength="30"><select class="input" id="taRole" aria-label="Role">' + roleOpts(ts.roles[0].key) + '</select><button class="btn ghost" type="submit">Add</button></form>' +
        '</div>' +
        (ctx.sample ? '' : '<div class="card"><h2>Start over</h2><p class="small muted">Pick a different template. Your team stays; roles and tip-outs are replaced.</p><div class="btn-row"><a class="btn ghost" href="#/start">Choose a template</a></div></div>') +
        '</div></div>';

      var ts2 = $('#teamSign'); if (ts2) ts2.onclick = function () { openAccount(); };
      $$('[data-method]').forEach(function (b) {
        b.onclick = function () {
          ts.method = b.dataset.method;
          if (ts.method === 'tipout' && !ts.tipouts.length && ts.roles.length > 1) ts.tipouts.push({ to: ts.roles[1].key, bp: 1000, of: 'tips' });
          if (ts.method === 'points') ts.restBy = 'points';
          commit(true);
        };
      });
      $$('[data-rest]').forEach(function (b) { b.onclick = function () { ts.restBy = b.dataset.rest; commit(true); }; });
      $('#cashD').onchange = function (e) { ts.cashDollars = e.target.checked; commit(false); };
      $$('[data-to]').forEach(function (s) { s.onchange = function () { ts.tipouts[Number(s.dataset.to)].to = s.value; commit(true); }; });
      $$('[data-of]').forEach(function (s) { s.onchange = function () { ts.tipouts[Number(s.dataset.of)].of = s.value; commit(true); }; });
      $$('[data-bp]').forEach(function (b) {
        b.onclick = function () { var t = ts.tipouts[Number(b.dataset.bp)]; t.bp = Math.max(50, Math.min(R.LIMITS.maxBp, t.bp + Number(b.dataset.by))); commit(true); };
      });
      $$('[data-rmto]').forEach(function (b) { b.onclick = function () { ts.tipouts.splice(Number(b.dataset.rmto), 1); commit(true); }; });
      var at = $('#addTo'); if (at) at.onclick = function () {
        var used = {}; ts.tipouts.forEach(function (t) { used[t.to + '/tips'] = true; });
        var r = ts.roles.filter(function (x) { return !used[x.key + '/tips']; })[0];
        if (!r) { toast('Every role already has a tip-out of the tips.'); return; }
        ts.tipouts.push({ to: r.key, bp: 500, of: 'tips' }); commit(true);
      };
      $$('[data-rname]').forEach(function (inp) {
        inp.onchange = function () {
          var r = ts.roles[Number(inp.dataset.rname)];
          r.name = inp.value;
          if (R.looksManager(inp.value)) r.manager = true;
          commit(true);
        };
      });
      $$('[data-pts]').forEach(function (b) {
        b.onclick = function () { var r = ts.roles[Number(b.dataset.pts)]; r.pts = Math.max(0, Math.min(R.LIMITS.maxPts, r.pts + Number(b.dataset.by))); commit(true); };
      });
      $$('[data-mgr]').forEach(function (c) { c.onchange = function () { ts.roles[Number(c.dataset.mgr)].manager = c.checked; commit(false); }; });
      $$('[data-rmrole]').forEach(function (b) {
        b.onclick = function () {
          var i = Number(b.dataset.rmrole);
          var key = ts.roles[i].key;
          var n = ts.people.filter(function (p) { return p.role === key; }).length;
          if (n && !confirm(n + ' ' + (n === 1 ? 'person has' : 'people have') + ' this role. They move to ' + ts.roles[i === 0 ? 1 : 0].name + '. Remove it?')) return;
          ts.roles.splice(i, 1);
          ts.tipouts = ts.tipouts.filter(function (t) { return t.to !== key; });
          ts.people.forEach(function (p) { if (p.role === key) p.role = ts.roles[0].key; });
          commit(true);
        };
      });
      var ar = $('#addRole'); if (ar) ar.onclick = function () {
        ts.roles.push({ key: 'role' + Date.now().toString(36).slice(-4), name: 'New role', pts: 100, manager: false });
        commit(true);
        var inputs = $$('[data-rname]'); var last = inputs[inputs.length - 1]; if (last) { last.focus(); last.select(); }
      };
      $$('[data-pname]').forEach(function (inp) {
        inp.onchange = function () {
          var name = R.cleanName(inp.value);
          if (!name) { toast('Everyone needs a first name.'); inp.value = ts.people[Number(inp.dataset.pname)].name; return; }
          ts.people[Number(inp.dataset.pname)].name = name; inp.value = name; commit(false);
        };
      });
      $$('[data-prole]').forEach(function (s) { s.onchange = function () { ts.people[Number(s.dataset.prole)].role = s.value; commit(false); }; });
      $$('[data-rmp]').forEach(function (b) { b.onclick = function () { ts.people.splice(Number(b.dataset.rmp), 1); commit(true); }; });
      $('#teamAdd').onsubmit = function (e) {
        e.preventDefault();
        var name = R.cleanName($('#taName').value);
        if (!name) { toast('Type a first name.'); return; }
        if (ts.people.length >= R.LIMITS.roster) { toast('Up to ' + R.LIMITS.roster + ' people.'); return; }
        var role = $('#taRole').value;
        ts.people.push({ id: R.newPid(), name: name, role: role });
        commit(true);
        $('#taRole').value = role;
        $('#taName').focus();
      };
    }
    draw();
  }

  /* ---------------- history ---------------- */

  function renderHistory(ctx, start) {
    if (!ctx.sample && !signedIn()) {
      view.innerHTML = '<div class="empty"><div class="e">🗓️</div><h2>Your week of shifts</h2><p>Save each night’s split and see the week: totals per person, tips per hour, and a CSV for payroll. Saving needs a free account; splitting never does.</p>' +
        '<div class="btn-row" style="justify-content:center"><button class="btn" id="hSign">Create a free account</button><a class="btn ghost" href="#/sample/history">See a sample week</a></div></div>';
      $('#hSign').onclick = function () { openAccount(); };
      return;
    }
    if (ctx.sample) {
      var d = state.demo;
      return drawWeek(ctx, d.week, d.shifts);
    }
    start = start || state.weekStart || R.weekStart(localDay());
    state.weekStart = start;
    loading();
    api('GET', 'api/week?start=' + enc(start)).then(function (r) { drawWeek(ctx, r.week, r.shifts); }).catch(function (e) { showError(e, view); });
  }

  function drawWeek(ctx, w, shifts) {
    var maxDay = w.days.reduce(function (m, x) { return Math.max(m, x.total); }, 0) || 1;
    var thisWeek = R.weekStart(localDay());
    view.innerHTML = (ctx.sample ? sampleBar('A made-up week at ' + ctx.venue + '. Tap a shift to open it.') : '') +
      '<div class="page-head"><div><div class="eyebrow">History</div><h1>The week</h1></div>' +
      (ctx.sample ? '' : '<a class="btn small ghost" download href="' + esc(BASE + 'api/export.csv?from=' + enc(w.start) + '&to=' + enc(w.end)) + '">⬇ CSV</a>') + '</div>' +
      '<div class="stack">' +
      (ctx.sample ? '<div class="card week-nav"><b>' + esc(w.label) + '</b></div>' :
        '<div class="card week-nav"><button class="btn small ghost" id="wPrev" aria-label="Previous week">←</button><b>' + esc(w.label) + (w.start === thisWeek ? ' · this week' : '') + '</b><button class="btn small ghost" id="wNext" aria-label="Next week"' + (w.start >= thisWeek ? ' disabled' : '') + '>→</button></div>') +
      '<div class="stat-row"><div class="stat"><b>' + esc(R.money(w.total)) + '</b><span>Tips paid out</span></div><div class="stat"><b>' + w.shifts + '</b><span>Shifts</span></div>' +
      '<div class="stat"><b>' + esc(w.hours) + '</b><span>Hours worked</span></div><div class="stat"><b>' + (w.perHour === null ? '—' : esc(R.money(w.perHour))) + '</b><span>Tips per hour</span></div></div>' +
      '<div class="card"><div class="label">By day</div><div class="days" role="img" aria-label="Tips per day this week">' + w.days.map(function (x) {
        var h = Math.round((x.total / maxDay) * 100);
        return '<div class="day"><em>' + (x.total ? esc(R.moneyTight(Math.round(x.total / 100) * 100)) : '') + '</em><i class="' + (x.total ? '' : 'zero') + '" style="height:' + Math.max(2, h * 0.9) + '%"></i><span>' + esc(R.dayShort(x.date).slice(0, 3)) + '</span></div>';
      }).join('') + '</div></div>' +
      (w.people.length ? '<div class="card" style="overflow-x:auto"><div class="label">Per person</div><table class="tbl"><thead><tr><th>Name</th><th>Shifts</th><th>Hours</th><th>Tips</th><th>Per hour</th></tr></thead><tbody>' + w.people.map(function (p) {
        return '<tr><td><b>' + esc(p.name) + '</b></td><td>' + p.shifts + '</td><td>' + esc(p.hours) + '</td><td><b>' + esc(R.money(p.total)) + '</b></td><td>' + (p.perHour === null ? '—' : esc(R.money(p.perHour))) + '</td></tr>';
      }).join('') + '</tbody></table><p class="hint">Tips per hour is each person’s tips this week over their hours in the pool. It doesn’t include wages.</p></div>' : '') +
      '<div class="label">Shifts</div>' +
      (shifts.length ? '<div class="stack">' + shifts.map(function (s) {
        if (s.error) return '<div class="srow"><span>Unreadable shift</span></div>';
        return '<a class="srow" href="' + (ctx.sample ? '#/sample" data-sample="' + esc(s.id) : '#/shift/' + enc(s.id)) + '"><span><b>' + esc(R.dayShort(s.date)) + ' · ' + esc(R.partLabel(s.part)) + '</b><small>' + esc(R.plural(s.people, 'person', 'people')) + ' · ' + esc(s.hours) + ' h' + (s.shared ? ' · 🧾 shared' : '') + (s.headsUp ? ' · ⚠️ manager in pool' : '') + '</small></span><b class="num">' + esc(R.money(s.total)) + '</b></a>';
      }).join('') + '</div>' : '<div class="card center muted">No shifts saved this week. <a href="#/split">Split tonight’s →</a></div>') +
      '</div>';
    var p = $('#wPrev'); if (p) p.onclick = function () { renderHistory(ctx, R.addDays(w.start, -7)); };
    var n = $('#wNext'); if (n) n.onclick = function () { renderHistory(ctx, R.addDays(w.start, 7)); };
    $$('[data-sample]').forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        var it = state.demo.items.filter(function (x) { return x.id === a.dataset.sample; })[0];
        if (!it) return;
        state.sample.draft = draftFromShift(it.shift);
        go('#/sample');
      };
    });
  }

  /* ---------------- the receipt (public page, preview, landing) ---------------- */

  function receiptHtml(card, opts) {
    opts = opts || {};
    var one = card.kind === 'person' && card.people[0];
    var poolLines =
      '<div class="ln"><span>Card tips</span><b>' + esc(R.money(card.pool.card)) + '</b></div>' +
      '<div class="ln"><span>Cash tips</span><b>' + esc(R.money(card.pool.cash)) + '</b></div>' +
      (card.pool.sales !== null && card.pool.sales !== undefined ? '<div class="ln muted2"><span>Food sales</span><b>' + esc(R.money(card.pool.sales)) + '</b></div>' : '') +
      '<div class="ln tot"><span>Tip pool</span><b>' + esc(R.money(card.pool.total)) + '</b></div>';
    var pieces = card.pieces.filter(function (p) { return p.kind === 'tipout'; }).map(function (p) {
      return '<div class="ln"><span>' + esc(p.roleName) + ' tip-out' + (p.skipped ? ' (skipped)' : '') + '</span><b>' + (p.skipped ? '—' : esc(R.money(p.amount))) + '</b></div>' +
        (p.skipped ? '' : '<div class="muted2" style="font-size:12.5px">' + esc(p.formula) + '</div>');
    }).join('');
    var html = '<div class="receipt">' +
      '<div class="r-top"><div class="r-brand">🫙 TIPOUT</div><div class="r-sub">TIP RECEIPT · ' + esc(R.dayShort(card.date).toUpperCase()) + ' · ' + esc(String(card.partLabel || '').toUpperCase()) + '</div></div><hr>';
    if (one) {
      html += '<div class="r-you"><div class="nm">' + esc(one.name) + '</div><div class="muted2">' + esc(one.roleName) + ' · ' + esc(one.hours) + ' h</div>' +
        '<div class="r-big">' + esc(R.money(one.total)) + '</div><div class="muted2">' + esc(R.money(one.card)) + ' card · ' + esc(R.money(one.cash)) + ' cash</div></div>' +
        (opts.compact ? '' : '<hr><b>HOW YOUR SHARE WAS WORKED OUT</b><ol>' + one.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ol>') + '<hr>';
      html += poolLines + (opts.compact ? '' : '<div class="muted2" style="margin-top:6px">' + esc(card.methodLine) + ' ' + esc(R.plural(card.headcount, 'person', 'people')) + ' in the pool.</div>' + (pieces ? '<hr>' + pieces : ''));
    } else {
      html += poolLines + '<div class="muted2" style="margin-top:6px">' + esc(card.methodLine) + '</div>' + (pieces ? '<hr>' + pieces : '') + '<hr>' +
        card.people.map(function (p) {
          return '<div class="who-block"><details><summary><div class="ln"><span><b>' + esc(p.name) + '</b> · ' + esc(p.roleName) + ' · ' + esc(p.hours) + ' h</span><b>' + esc(R.money(p.total)) + '</b></div></summary>' +
            '<div class="muted2" style="font-size:13px">' + esc(R.money(p.card)) + ' card · ' + esc(R.money(p.cash)) + ' cash</div><ol>' + p.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ol></details></div>';
        }).join('');
    }
    html += '<hr><div class="check">' + (card.check.balanced ? '<span class="ok">✓</span> PAID OUT ' + esc(R.money(card.check.out)) + ' = TIPS IN ' + esc(R.money(card.check.in)) + '<br><span class="muted2" style="font-weight:600">balanced to the cent</span>' : 'NOT BALANCED') + '</div>';
    if (!opts.compact) html += '<hr><div class="foot">Numbers and first names only. Questions about your share? Ask your shift lead.<br>Made with Tipout — the free tip-pool calculator. <a href="./">Split your own →</a></div>';
    return html + '</div>';
  }

  function renderPublic(token) {
    document.body.classList.add('public');
    loading();
    api('GET', 'api/shared/' + enc(token)).then(function (card) {
      document.title = (card.kind === 'person' && card.people[0] ? card.people[0].name + '’s tips · ' : 'Tip split · ') + R.dayShort(card.date) + ' · Tipout';
      view.innerHTML = (card.preview ? '<div class="banner info" style="margin-bottom:10px"><span class="e">👀</span><p>This is what staff see. You’re the shift lead, so you see this note; they don’t.</p></div>' : '') +
        receiptHtml(card, {}) +
        '<div class="pub-actions"><button class="btn ghost" id="pubShare">Share</button><a class="btn ghost" href="./">What’s Tipout?</a></div>';
      $('#pubShare').onclick = function () { shareOut(document.title, '', location.href); };
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><div class="e">🧾</div><h2>Receipt not found</h2><p>' + esc(e.message) + '</p><a class="btn" href="./">What’s Tipout?</a></div>';
    });
  }

  /* ---------------- boot ---------------- */

  if (PUB) {
    route();
  } else {
    loading();
    loadMe().then(function () { ready = true; route(); });
  }
})();
