/* Booth - the page. One file, no build step, every typed or model-written
 * string escaped. No style= attribute is written anywhere: bars and rings
 * are SVG, spacing is classes in app.css. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var view = $('#view');
  var R = window.BoothRules;

  // Where the app is mounted: '/' on its own, '/booth/' inside the lab. The
  // public scorecard lives one level down (s/<token>) with <base href="../">,
  // so the base comes from the document's base URI rather than the path.
  var BASE = new URL('.', document.baseURI).pathname;
  var PUB = location.pathname.match(/\/s\/([A-Za-z0-9_-]{22,40})\/?$/);
  var EV_KEY = 'booth-event';

  var state = { me: null, demo: null, cur: recall(EV_KEY), skew: 0, ctxKey: null, timers: [], drafts: {}, rec: null };

  /* ---------------- utilities ---------------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var enc = encodeURIComponent;
  function now() { return Date.now() + state.skew; }

  function api(method, path, body) {
    var headers = {};
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
  function fmtRange(a, b) {
    if (!a) return '';
    if (!b || a === b) return fmtDay(a, { year: 'numeric' });
    return fmtDay(a) + ' – ' + fmtDay(b, { year: 'numeric' });
  }
  function ago(iso) {
    var d = now() - Date.parse(iso);
    if (!(d >= 0)) return '';
    return d < 60000 ? 'just now' : R.duration(d) + ' ago';
  }
  function initials(s) { return String(s || '?').split(/[\s@.]+/).filter(Boolean).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it.'); });
  }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function every(ms, fn) { var t = setInterval(fn, ms); state.timers.push(t); return t; }
  function stopTimers() { state.timers.forEach(clearInterval); state.timers = []; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function people(n) { return n + (n === 1 ? ' person' : ' people'); }

  /** A small celebration: sixteen pieces placed and coloured by the
   *  stylesheet, shown only when motion is allowed. */
  function confetti() {
    if (reducedMotion()) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 16; i++) box.appendChild(document.createElement('i'));
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 2800);
  }

  // Thin line icons, one weight, drawn in the current colour.
  var PATHS = {
    back: '<path d="m15 18-6-6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    camera: '<path d="M4 8.5h3l1.5-2.5h7L17 8.5h3v10H4z"/><circle cx="12" cy="13" r="3.2"/>',
    mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.500a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
    check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>',
    alert: '<path d="M12 4 3.5 19h17z"/><path d="M12 10v4.500M12 16.800v.2"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.500V12l3 2"/>',
    lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.500V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    spark: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.500l2.5 2.500M15 15l2.5 2.500M17.5 6.5 15 9M9 15l-2.5 2.5"/>',
    bolt: '<path d="M13 3.5 5.5 13.500H11L10 20.500l7.5-10H12z"/>',
    trophy: '<path d="M8 20h8M12 16v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5.500h3V7a3 3 0 0 1-3 3M7 5.500H4V7a3 3 0 0 0 3 3"/>',
    shield: '<path d="M12 3.5 5 6v5.500c0 4.2 2.8 7.3 7 9 4.2-1.7 7-4.8 7-9V6z"/><path d="m9 12 2.2 2.200L15 10.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.500v2.200M12 18.300v2.200M3.5 12h2.200M18.3 12h2.200M6 6l1.6 1.600M16.4 16.4 18 18M18 6l-1.6 1.600M7.6 16.4 6 18"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4.5 7.5 7.5 6 7.5-6"/>',
  };
  function ico(name) { return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + String(PATHS[name] || '') + '</svg>'; }

  /** A thin progress bar as SVG - widths are attributes, never styles. */
  function bar(pct, cls, klass) {
    var w = Math.max(0, Math.min(100, Number(pct) || 0));
    return '<svg class="' + (klass || 'bar') + '" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="trk" width="100" height="4"/><rect class="val' + (cls ? ' ' + cls : '') + '" width="' + w.toFixed(1) + '" height="4"/></svg>';
  }
  function dot(temp) {
    var t = R.tempInfo(temp);
    return '<span class="dot ' + esc(temp) + '" role="img" aria-label="' + esc(t.label) + '"></span>';
  }

  /* ---------------- me and the top bar ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function signedIn() { return state.me && state.me.signedIn; }
  /** "Scan a card" with a voice memo is offered only when the server says it is switched on. */
  function scanOn() { return Boolean(state.me && state.me.scan); }
  function memoSeconds() { return (state.me && state.me.limits && state.me.limits.memoSeconds) || 12; }
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
      el.innerHTML = '<button class="btn small ghost" id="signInTop" type="button">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var b = me.budget || {};
    var cur = (me.events || []).filter(function (e) { return e.id === state.cur; })[0];
    el.innerHTML = (cur ? '<a class="pill ev" href="#/e/' + enc(cur.id) + '" title="Current event"><span>' + esc(cur.name) + '</span></a>' : '') +
      '<span class="pill credit num" title="AI credit">' + (b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span>' +
      '<button class="avatar-btn" id="acctBtn" type="button" aria-label="Account"><span>' + esc(initials(me.email)) + '</span></button>';
    $('#acctBtn').onclick = function () { openAccount(); };
  }

  function setCur(id) {
    state.cur = id || null;
    store(EV_KEY, state.cur);
    drawTop();
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
    var f = scrim.querySelector('input:not([type=checkbox]):not([readonly]), textarea');
    if (f) setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 50);
    return scrim.firstChild;
  }
  function closeSheet() { var s = $('#scrim'); if (s) s.remove(); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  function aiWords() {
    return scanOn()
      ? 'You also get $2 of AI credit for scanning cards and drafting follow-ups — about a cent each.'
      : 'You also get $2 of AI credit for card reading and drafted follow-ups — about a cent each.';
  }

  function openAccount(reason) {
    if (signedIn()) return openProfileSheet();
    var mode = 'register';
    function draw(root) {
      root.innerHTML = '<div class="grab"></div>' +
        '<h2>' + (mode === 'register' ? 'Start your booth — free.' : 'Welcome back') + '</h2>' +
        '<p class="muted small">' + esc(reason || (mode === 'register'
          ? 'Capturing leads, the cold clocks, templates, the leaderboard, the scorecard and the CSV are free forever. ' + aiWords() + ' One account works across every app on this site.'
          : 'Same account as the other apps on this site.')) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button>' +
        '</form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block mt8" id="pkBtn" type="button">Sign in with Face ID or a passkey</button>' : '') +
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
    return loadMe().then(function () { toast('You’re in.'); route(); });
  }

  function openProfileSheet() {
    var me = state.me;
    var b = me.budget || {};
    var remaining = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    var pct = b.unlimited ? 100 : Math.max(0, Math.min(100, (b.remainingUsd / (b.allowanceUsd || 1)) * 100));
    var model = me.ai === 'gemini' ? 'Gemini reads and drafts' : (me.tier === 'paid' ? 'Member model (Sonnet)' : 'Free model (Haiku)');
    sheet(
      '<h2>Your account</h2>' +
      '<p class="muted small">' + esc(me.email) + ' · ' + esc(model) + '</p>' +
      '<div class="section mt24"><div class="sec-head"><h3>AI credit</h3><span class="num">' + esc(remaining) + '</span></div>' +
      bar(pct, '', 'credit') +
      '<p class="small muted mt12">' + (scanOn() ? 'Scanning a card (with or without a voice memo) costs about a cent; so does a drafted follow-up.' : 'Reading a card or badge costs about a cent; so does a drafted follow-up.') + ' Capturing, the clocks, templates, the leaderboard, the scorecard and the CSV are free.</p>' +
      '<div id="billing" class="mt12"></div></div>' +
      (pkOk() ? '<button class="btn ghost block mt24" id="pkEnrol" type="button">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block mt8" id="signOut" type="button">Sign out</button>',
      function (root) {
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; setCur(null); location.hash = '#/'; loadMe().then(route); });
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
          '<p class="small muted mt8">Membership covers every app on this site, runs the better model, and lets you add credit.</p>';
        $('#joinM', el).onclick = function () { checkout('api/auth/billing/membership', {}); };
        return;
      }
      el.innerHTML = '<div class="btn-row">' + (b.topUps || []).map(function (t) {
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
      '<p class="muted small">Everything else keeps working: capturing leads, the cold clocks, the free templates, the leaderboard, the scorecard and the CSV export cost nothing.</p><div id="billing" class="mt16"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- routing ---------------- */

  function tabFor(parts) {
    if (!parts[0]) return 'events';
    if (parts[0] === 'new' || parts[0] === 'join') return 'events';
    var sub = parts[0] === 'sample' ? parts[1] : parts[2];
    if (sub === 'capture') return 'capture';
    if (sub === 'board') return 'board';
    if (sub === 'score') return 'score';
    if (sub === 'settings') return 'events';
    return 'leads';
  }

  function route() {
    closeSheet();
    stopTimers();
    stopRecording();
    if (PUB) return renderShared(PUB[1]);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return ''; } });
    var tab = tabFor(parts);
    $$('#tabbar button').forEach(function (b) { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    window.scrollTo(0, 0);
    if (parts[0] === 'sample') { state.ctxKey = 'sample'; return withCtx('sample', parts[1] || '', parts[2]); }
    if (parts[0] === 'e' && parts[1]) {
      if (!signedIn()) { location.hash = '#/'; return; }
      state.ctxKey = parts[1];
      if (state.cur !== parts[1]) setCur(parts[1]);
      return withCtx(parts[1], parts[2] || '', parts[3]);
    }
    state.ctxKey = null;
    if (parts[0] === 'new') return renderNewEvent();
    if (parts[0] === 'join') return renderJoin(parts[1] || '');
    return signedIn() ? renderEvents() : renderHome();
  }
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () {
      var t = b.dataset.tab;
      if (t === 'events') { location.hash = '#/'; return; }
      var base = ctxBase();
      if (!base) { location.hash = '#/'; toast('Pick an event first - or start one.'); return; }
      location.hash = base + ({ leads: '', capture: '/capture', board: '/board', score: '/score' })[t];
    };
  });
  function ctxBase() {
    if (state.ctxKey === 'sample') return '#/sample';
    if (state.ctxKey) return '#/e/' + enc(state.ctxKey);
    if (signedIn()) return state.cur && (state.me.events || []).some(function (e) { return e.id === state.cur; }) ? '#/e/' + enc(state.cur) : null;
    return '#/sample';
  }
  // Until we know who is signed in, a hash change would route as signed out.
  var ready = false;
  window.addEventListener('hashchange', function () { if (ready || PUB) route(); });

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner" role="status" aria-label="Loading"></span></div>'; }
  function backLink(href, label) { return '<a class="back" href="' + href + '">' + ico('back') + esc(label) + '</a>'; }
  function sampleBar(what) {
    return '<div class="sample-bar"><span><b>SAMPLE</b> · ' + esc(what || 'A made-up coffee roaster at a made-up expo. Real rules, no AI used.') + '</span>' +
      (signedIn() ? '<a class="btn small" href="#/new">Start your event</a>' : '<button class="btn small" type="button" data-signup>Start free</button>') + '</div>';
  }
  function wireSignup(root) { $$('[data-signup]', root || view).forEach(function (b) { b.onclick = function () { openAccount(); }; }); }

  /* ---------------- the event context ---------------- */

  /** Everything a screen of one event needs: its leads, for the sample or for real. */
  function loadCtx(key) {
    if (key === 'sample') {
      return loadDemo().then(function (d) {
        state.skew = Date.parse(d.now) - Date.now();
        return {
          demo: true, key: 'sample', base: '#/sample', event: d.event, leads: d.leads, members: d.members,
          board: d.leaderboard, score: d.scorecard, goingCold: d.goingCold, drafts: d.drafts, reps: d.reps, scan: d.scan,
          me: { name: 'You', signoff: '', tone: 'friendly' },
        };
      });
    }
    return api('GET', 'api/events/' + enc(key) + '/leads').then(function (r) {
      state.skew = Date.parse(r.now) - Date.now();
      return { demo: false, key: key, base: '#/e/' + enc(key), event: r.event, leads: r.leads, me: r.event.me };
    });
  }

  function withCtx(key, sub, arg) {
    loading();
    loadCtx(key).then(function (ctx) {
      if (sub === 'capture') return renderCapture(ctx);
      if (sub === 'lead' && arg) return renderLead(ctx, arg);
      if (sub === 'board') return renderBoard(ctx);
      if (sub === 'score') return renderScore(ctx);
      if (sub === 'settings' && !ctx.demo) return renderSettings(ctx);
      return renderLeads(ctx);
    }).catch(function (e) {
      if (e.status === 404 && key !== 'sample') {
        setCur(null);
        view.innerHTML = '<div class="empty"><h2>No such event</h2><p>It may have been deleted, or you were removed from its team.</p><a class="btn" href="#/">Your events</a></div>';
        return;
      }
      showError(e, view);
    });
  }

  function eventHead(ctx, title, sub) {
    var ev = ctx.event;
    return (ctx.demo ? sampleBar() : '') +
      '<div class="page-head"><div class="min0"><div class="eyebrow">' + esc(ev.name) + '</div><h1>' + esc(title) + '</h1>' +
      '<div class="sub">' + esc(sub || [fmtRange(ev.startDate, ev.endDate), ev.place].filter(Boolean).join(' · ')) + '</div></div>' +
      (ctx.demo ? '' : '<a class="btn small ghost" href="' + ctx.base + '/settings">' + ico('gear') + (ev.owner ? 'Team' : 'You') + '</a>') + '</div>';
  }

  /* ---------------- clocks ---------------- */

  function clockShort(l, c) {
    if (c.state === 'closed') return l.wonAt ? 'Won' : 'Lost';
    if (c.state === 'done') return l.wonAt ? 'Won' : (c.onTime ? 'Followed up' : 'Followed up late');
    if (c.state === 'cold') return 'Went cold';
    return R.duration(c.leftMs) + ' left';
  }

  /** Re-tick every visible clock every 30 seconds, from the same rules. */
  function tickClocks(leads) {
    var byId = {};
    leads.forEach(function (l) { byId[l.id] = l; });
    every(30000, function () {
      $$('[data-ck]').forEach(function (el) {
        var l = byId[el.dataset.ck];
        if (!l) return;
        var c = R.clock(l, now());
        var swap = function (node) { node.className = node.className.replace(/\b(fresh|cooling|cold|done|closed)\b/g, '').replace(/\s+/g, ' ').trim() + ' ' + c.state; };
        swap(el);
        var row = el.closest('.crow');
        if (row) swap(row);
        var label = $('.lbl', el);
        if (label) label.textContent = el.dataset.long ? R.clockLabel(c) : (row ? (c.state === 'cold' ? 'Went cold' : R.duration(c.leftMs)) : clockShort(l, c));
        var v = $('svg.bar .val', row || el);
        if (v) v.setAttribute('width', (c.pct * 100).toFixed(1));
        var ringv = $('.ring .val', el);
        if (ringv) ringv.setAttribute('stroke-dashoffset', String(100 - Math.round((c.state === 'done' || c.state === 'closed' ? 1 : c.pct) * 100)));
      });
    });
  }

  function leadName(l) { return l.name || l.company || l.email || l.phone || 'Unnamed lead'; }

  function leadRow(l, base) {
    var c = R.clock(l, now());
    var sub = [l.name ? l.company : '', l.title].filter(Boolean).join(' · ');
    return '<a class="row" href="' + base + '/lead/' + enc(l.id) + '">' + dot(l.temp) +
      '<span class="grow"><span class="t">' + esc(leadName(l)) + '</span>' +
      '<span class="m">' + esc(sub ? sub + ' · ' : '') + 'by ' + esc(l.capturedByName) + '</span></span>' +
      '<span class="end ck ' + c.state + '" data-ck="' + esc(l.id) + '"><span class="lbl">' + esc(clockShort(l, c)) + '</span>' +
      '<span class="status">' + esc(statusLine(l, c)) + '</span></span></a>';
  }

  /** The second line of a row: what the clock line does not already say. */
  function statusLine(l, c) {
    if (l.wonAt) return l.value ? R.money(l.value) : '';
    if (l.lostAt) return c.state === 'closed' ? '' : 'Lost';
    if (l.status === 'sent') return l.value ? R.money(l.value) + ' pipeline' : '';
    if (l.status === 'new') return 'captured ' + ago(l.capturedAt);
    return R.statusInfo(l.status).label;
  }

  function coldRow(r, base) {
    var l = r.lead || r;
    var c = R.clock(l, now());
    return '<a class="row crow ' + c.state + '" href="' + base + '/lead/' + enc(l.id) + '">' + dot(l.temp) +
      '<span class="grow"><span class="t">' + esc(leadName(l)) + '</span>' +
      '<span class="m">' + esc((l.name && l.company ? l.company + ' · ' : '') + 'by ' + (l.capturedByName || '')) + '</span>' +
      bar(c.pct * 100) + '</span>' +
      '<span class="end ck ' + c.state + (c.state === 'cooling' ? ' pulse' : '') + '" data-ck="' + esc(l.id) + '"><span class="lbl">' + esc(c.state === 'cold' ? 'Went cold' : R.duration(c.leftMs)) + '</span>' +
      '<span class="status">' + esc(c.state === 'cold' ? R.duration(c.overMs) + ' ago' : 'to go cold') + '</span></span></a>';
  }

  /* ---------------- signed-out home ---------------- */

  function renderHome() {
    loading();
    loadDemo().then(function (d) {
      state.skew = Date.parse(d.now) - Date.now();
      var cold = d.goingCold.filter(function (g) { return g.clock.state === 'cooling'; }).slice(0, 2);
      var sc = d.scorecard;
      view.innerHTML =
        '<section class="hero">' +
        '<p class="eyebrow">Free for your whole booth team</p>' +
        '<h1>Trade-show leads that don’t go cold.</h1>' +
        '<p class="lede">Capture a lead in ten seconds. Every one gets a follow-up clock. Then see whether the booth paid off.</p>' +
        '<div class="ctas"><button class="btn" type="button" data-signup>Start free</button><a class="btn ghost" href="#/sample">Walk the sample show</a></div>' +
        '<p class="trust">Capture, clocks and scorecard free forever · Card photos read once, never kept</p>' +
        '</section>' +
        '<div class="feats">' +
        '<div class="feat">' + ico('bolt') + '<h3>Capture in ten seconds</h3><p>' + (scanOn()
          ? 'Scan the card or badge and say a ten-second memo, or type it. Hot, warm or cold, what they asked about, the next step. Done.'
          : 'Type it, or snap the card or badge. Hot, warm or cold, what they asked about, the next step. Done.') + '</p></div>' +
        '<div class="feat">' + ico('clock') + '<h3>Beat the cold clock</h3><p>Every lead gets a timer: hot leads go cold in 48 hours. A free template, or a draft in your own voice, sent from your own mail app.</p></div>' +
        '<div class="feat">' + ico('trophy') + '<h3>Know if it paid off</h3><p>A live leaderboard on the day, and a scorecard after: follow-up rate, meetings, pipeline and ROI against what the booth cost.</p></div>' +
        '</div>' +
        '<div class="cols2 even">' +
        '<section class="section"><div class="sec-head"><h2>Going cold right now</h2><span class="count">Sample</span></div><div class="list">' +
        cold.map(function (g) { return coldRow(Object.assign({}, d.leads.filter(function (l) { return l.id === g.id; })[0]), '#/sample'); }).join('') + '</div></section>' +
        '<section class="section"><div class="sec-head"><h2>Did the booth pay off?</h2><span class="count">Sample</span></div>' +
        '<a class="plainlink" href="#/sample/score"><div class="bigline"><b class="good">' + (sc.roi >= 0 ? '+' : '') + sc.roi + '%</b><span class="muted small">return on the booth · ' + esc(R.money(sc.wonValue)) + ' won on ' + esc(R.money(sc.boothCost)) + '</span></div>' +
        '<p class="small mt12">See the sample scorecard</p></a></section>' +
        '</div>' +
        '<section class="section"><div class="row"><span class="grow"><span class="t">Joining a teammate’s booth?</span><span class="m">They’ll give you an 8-character code.</span></span><a class="btn small ghost" href="#/join">Enter a code</a></div></section>';
      wireSignup();
      tickClocks(d.leads);
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- my events ---------------- */

  function renderEvents() {
    loading();
    loadMe().then(function (me) {
      var evs = me.events || [];
      if (state.cur && !evs.some(function (e) { return e.id === state.cur; })) setCur(null);
      var h = '';
      if (!evs.length) {
        h += '<div class="empty"><h1>No events yet</h1><p class="mt12">Start one for your next show and share the code with the team. Or join a teammate’s booth.</p>' +
          '<div class="btn-row"><a class="btn" href="#/new">Start an event</a><a class="btn ghost" href="#/join">Join with a code</a></div>' +
          '<p class="mt24 small"><a href="#/sample">Or walk the sample show first</a></p></div>';
      } else {
        h += '<div class="page-head"><div><h1>Your events</h1><div class="sub">Each show is one shared lead list for its team.</div></div></div>' +
          '<div class="list">' + evs.map(function (e) {
            return '<a class="row" href="#/e/' + enc(e.id) + '"><span class="grow"><span class="t">' + esc(e.name) + '</span>' +
              '<span class="m">' + esc([fmtRange(e.startDate, e.endDate), e.place].filter(Boolean).join(' · ')) + '</span>' +
              '<span class="m">' + (e.role === 'owner' ? 'You run it' : 'Staff') + ' · ' + people(e.members) + '</span></span>' +
              '<span class="n"><b>' + e.leads + '</b><span>leads</span></span></a>';
          }).join('') + '</div>' +
          '<div class="btn-row mt24"><a class="btn" href="#/new">Start an event</a><a class="btn ghost" href="#/join">Join with a code</a></div>';
      }
      view.innerHTML = h;
    }).catch(function (e) { showError(e, view); });
  }

  function renderNewEvent() {
    if (!signedIn()) {
      view.innerHTML = '<div class="empty"><h1>Start your event</h1><p class="mt12">Make a free account, then share a code with your booth team.</p><button class="btn" type="button" data-signup>Start free</button></div>';
      return wireSignup();
    }
    var today = new Date(now()).toISOString().slice(0, 10);
    view.innerHTML = '<div class="narrow">' + backLink('#/', 'Your events') +
      '<div class="page-head"><div><h1>Start an event</h1><div class="sub">A trade show, a conference, a market day or a pop-up.</div></div></div>' +
      '<form id="evForm">' + eventFields({ startDate: today, endDate: today, chips: R.DEFAULT_CHIPS }) +
      '<label class="field"><span>Your name, as the team sees it</span><input class="input" name="yourName" maxlength="30" value="' + esc(state.me.name || '') + '"></label>' +
      '<div id="evErr"></div><button class="btn block" type="submit">Create the event</button></form></div>';
    $('#evForm').onsubmit = function (e) {
      e.preventDefault();
      var b = readEventFields(e.target);
      b.yourName = e.target.yourName.value;
      var btn = $('button[type=submit]', e.target); btn.disabled = true;
      api('POST', 'api/events', b).then(function (ev) {
        setCur(ev.id);
        return loadMe().then(function () { toast('Event created. Share the code with your team.'); location.hash = '#/e/' + enc(ev.id) + '/settings'; });
      }).catch(function (err) { btn.disabled = false; showError(err, $('#evErr')); });
    };
  }

  function eventFields(ev) {
    return '<label class="field"><span>Event name</span><input class="input" name="name" maxlength="60" required placeholder="e.g. Southeast Food & Bev Expo" value="' + esc(ev.name || '') + '"></label>' +
      '<div class="grid2"><label class="field"><span>First day</span><input class="input" name="startDate" type="date" required value="' + esc(ev.startDate || '') + '"></label>' +
      '<label class="field"><span>Last day</span><input class="input" name="endDate" type="date" value="' + esc(ev.endDate || '') + '"></label></div>' +
      '<label class="field"><span>Where</span><input class="input" name="place" maxlength="80" placeholder="Hall, city, booth number" value="' + esc(ev.place || '') + '"></label>' +
      '<label class="field"><span>What the booth cost, all in ($)</span><input class="input" name="boothCost" inputmode="decimal" placeholder="Space, travel, samples, printing" value="' + esc(ev.boothCost || '') + '"></label>' +
      '<label class="field"><span>Interests to tick (comma separated, up to 12)</span><input class="input" name="chips" maxlength="320" value="' + esc((ev.chips || []).join(', ')) + '"></label>' +
      '<p class="hint mb0">What visitors ask about: the chips your team taps in the ten-second qualify.</p><div class="mt16"></div>';
  }
  function readEventFields(f) {
    return { name: f.name.value, startDate: f.startDate.value, endDate: f.endDate.value || f.startDate.value, place: f.place.value, boothCost: f.boothCost.value, chips: f.chips.value.split(',') };
  }

  function renderJoin(code) {
    view.innerHTML = '<div class="narrow">' + backLink('#/', signedIn() ? 'Your events' : 'Home') +
      '<div class="page-head"><div><h1>Join a booth team</h1><div class="sub">Whoever runs the booth has an 8-character code in Booth, under Team.</div></div></div>' +
      '<form id="joinForm"><label class="field"><span>Code</span><input class="input code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="11" placeholder="ABCD-EFGH" value="' + esc(R.formatCode(code)) + '"></label>' +
      '<label class="field"><span>Your name, as the team sees it</span><input class="input" name="name" maxlength="30" value="' + esc((state.me && state.me.name) || '') + '"></label>' +
      '<div id="joinErr"></div><button class="btn block" type="submit">' + (signedIn() ? 'Join the team' : 'Sign in to join') + '</button>' +
      '<p class="hint">A wrong code tells you nothing about any event, and after a few wrong tries it waits 15 minutes.</p></form></div>';
    var input = $('#joinForm').code;
    input.addEventListener('input', function () { var v = R.formatCode(input.value); if (v !== input.value && R.normalizeCode(input.value).length === 8) input.value = v; });
    $('#joinForm').onsubmit = function (e) {
      e.preventDefault();
      if (!signedIn()) return openAccount('Sign in or make a free account, then you’re on the team.');
      var btn = $('button[type=submit]', e.target); btn.disabled = true;
      api('POST', 'api/join', { code: e.target.code.value, name: e.target.name.value }).then(function (r) {
        setCur(r.id);
        return loadMe().then(function () { toast(r.already ? 'You’re already on this team.' : 'You’re on the team.'); location.hash = '#/e/' + enc(r.id) + '/capture'; });
      }).catch(function (err) { btn.disabled = false; showError(err, $('#joinErr')); });
    };
  }

  /* ---------------- leads ---------------- */

  function renderLeads(ctx) {
    var filter = state.filter || 'all';
    var q = '';
    var leads = ctx.leads;
    var cold = R.goingCold(leads, now());
    var urgent = cold.filter(function (r) { return r.clock.state !== 'fresh'; });
    var hot = leads.filter(function (l) { return l.temp === 'hot'; }).length;
    var h = eventHead(ctx, 'Leads', plural(leads.length, 'lead') + ' · ' + hot + ' hot · ' + cold.length + ' waiting for a follow-up');
    if (!leads.length) {
      h += '<div class="empty"><h2>No leads yet</h2><p>Tap Capture when someone stops by. Ten seconds each. The clock starts when you save.</p><a class="btn" href="' + ctx.base + '/capture">Capture the first lead</a>' +
        (ctx.event.owner ? '<p class="small mt24">Team code: <b class="num">' + esc(ctx.event.code) + '</b> · <a href="' + ctx.base + '/settings">invite</a></p>' : '') + '</div>';
      view.innerHTML = h;
      return;
    }
    h += '<div class="cols2 even"><div>';
    if (urgent.length) {
      h += '<section class="section"><div class="sec-head"><h2>Going cold</h2><span class="count">' + urgent.length + ' need a follow-up now</span></div>' +
        '<div class="list">' + urgent.slice(0, 6).map(function (r) { return coldRow(r, ctx.base); }).join('') + '</div>' +
        (urgent.length > 6 ? '<p class="hint"><a href="' + ctx.base + '/score">All ' + urgent.length + ' on the scorecard</a></p>' : '') + '</section>';
    } else {
      h += '<div class="banner good">' + ico('shield') + '<span>Nothing is about to go cold. ' + (cold.length ? 'Next up: ' + esc(leadName(cold[0].lead)) + ' in ' + esc(R.duration(cold[0].clock.leftMs)) + '.' : 'Every lead has a follow-up.') + '</span></div>';
    }
    h += '</div><div>';
    h += '<section class="section"><div class="sec-head"><h2>All leads</h2><span class="count" id="nShown"></span></div>' +
      '<div class="search">' + ico('search') + '<input class="input" id="q" type="search" placeholder="Search name, company, note" aria-label="Search leads"></div>' +
      '<div class="chips scroll" role="group" aria-label="Filter">' +
      [['all', 'All'], ['hot', 'Hot'], ['warm', 'Warm'], ['cold', 'Cold'], ['todo', 'To follow up'], ['won', 'Won']].map(function (f) {
        return '<button class="chip" type="button" data-f="' + f[0] + '" aria-pressed="' + (filter === f[0]) + '">' + (R.TEMPS.some(function (t) { return t.key === f[0]; }) ? '<span class="dot ' + f[0] + '" aria-hidden="true"></span>' : '') + f[1] + '</button>';
      }).join('') + '</div><div class="list" id="leadList"></div></section></div></div>';
    view.innerHTML = h;
    function draw() {
      var rows = leads.filter(function (l) {
        if (filter === 'hot' || filter === 'warm' || filter === 'cold') { if (l.temp !== filter) return false; }
        if (filter === 'todo' && (l.sentAt || l.wonAt || l.lostAt)) return false;
        if (filter === 'won' && !l.wonAt) return false;
        if (q) {
          var hay = [l.name, l.company, l.title, l.email, l.note, (l.chips || []).join(' '), l.capturedByName].join(' ').toLowerCase();
          if (hay.indexOf(q) < 0) return false;
        }
        return true;
      });
      $('#leadList').innerHTML = rows.length ? rows.map(function (l) { return leadRow(l, ctx.base); }).join('') : '<p class="muted small mt16">Nothing matches.</p>';
      $('#nShown').textContent = rows.length === leads.length ? '' : rows.length + ' of ' + leads.length;
    }
    $$('[data-f]').forEach(function (b) {
      b.onclick = function () {
        filter = state.filter = b.dataset.f;
        $$('[data-f]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        draw();
      };
    });
    $('#q').addEventListener('input', function (e) { q = e.target.value.trim().toLowerCase(); draw(); });
    draw();
    wireSignup();
    tickClocks(leads);
  }

  /* ---------------- capture ---------------- */

  function emptyLead() { return { name: '', company: '', title: '', email: '', phone: '', temp: '', chips: [], next: '', note: '', source: 'typed' }; }

  function qualifyHtml(f, chips, fromMemo) {
    return (fromMemo ? '<p class="hint mb0">Filled in from your memo. Change anything.</p><div class="mt16"></div>' : '') +
      '<div class="label">How warm? <span class="count">the clock depends on it</span></div><div class="temps" role="radiogroup" aria-label="Temperature">' + R.TEMPS.map(function (t) {
        return '<button type="button" class="' + (f.temp === t.key ? 'on' : '') + '" data-temp="' + t.key + '" role="radio" aria-checked="' + (f.temp === t.key) + '"><b><span class="dot ' + t.key + '" aria-hidden="true"></span>' + t.label + '</b><span class="b">' + esc(t.blurb) + '</span></button>';
      }).join('') + '</div>' +
      (chips.length ? '<div class="label">Interested in</div><div class="chips" role="group" aria-label="Interests">' + chips.map(function (c) {
        var on = f.chips.indexOf(c) >= 0;
        return '<button type="button" class="chip" data-chip="' + esc(c) + '" aria-pressed="' + on + '">' + esc(c) + '</button>';
      }).join('') + '</div>' : '') +
      '<div class="label">Next step</div><div class="seg" role="radiogroup" aria-label="Next step">' + R.NEXT_STEPS.map(function (n) {
        return '<button type="button" data-next="' + n.key + '" class="' + (f.next === n.key ? 'on' : '') + '" role="radio" aria-checked="' + (f.next === n.key) + '">' + esc(n.label) + '</button>';
      }).join('') + '</div>' +
      '<div class="label">Note <span class="count" id="noteN">' + (f.note || '').length + '/' + R.LIMITS.note + '</span></div>' +
      '<textarea class="input" id="fNote" maxlength="' + R.LIMITS.note + '" rows="3" placeholder="What did they say? (only your team sees this)">' + esc(f.note) + '</textarea>';
  }

  function wireQualify(root, f, onChange) {
    $$('[data-temp]', root).forEach(function (b) {
      b.onclick = function () {
        f.temp = b.dataset.temp;
        $$('[data-temp]', root).forEach(function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
        onChange();
      };
    });
    $$('[data-chip]', root).forEach(function (b) {
      b.onclick = function () {
        var c = b.dataset.chip; var i = f.chips.indexOf(c);
        if (i >= 0) f.chips.splice(i, 1); else f.chips.push(c);
        b.setAttribute('aria-pressed', String(i < 0));
        onChange();
      };
    });
    $$('[data-next]', root).forEach(function (b) {
      b.onclick = function () {
        f.next = f.next === b.dataset.next ? '' : b.dataset.next;
        $$('[data-next]', root).forEach(function (x) { var on = x.dataset.next === f.next; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
        onChange();
      };
    });
    var n = $('#fNote', root);
    if (n) n.addEventListener('input', function () { f.note = n.value; $('#noteN', root).textContent = n.value.length + '/' + R.LIMITS.note; onChange(); });
  }

  var FIELD_IDS = { name: 'fName', company: 'fCompany', email: 'fEmail', phone: 'fPhone', title: 'fTitle' };
  var FIELD_LABELS = { name: 'Name', company: 'Company', email: 'Email', phone: 'Phone', title: 'Job title' };

  /** What sits under a scanned field: "check this" with a Looks right button
   *  when the reader was not sure, "checked" once the rep confirmed or
   *  retyped it, or a quiet line when it could not be read at all. */
  function markHtml(k, mark) {
    if (mark === 'check') return '<div class="chk" data-chk="' + k + '"><span>' + ico('alert') + 'Not sure. Check it against the card.</span><button class="btn small ghost" type="button" data-ok="' + k + '">Looks right</button></div>';
    if (mark === 'ok') return '<div class="chk ok" data-chk="' + k + '"><span>' + ico('check') + 'Checked</span></div>';
    if (mark === 'none') return '<div class="chk none" data-chk="' + k + '"><span>Not readable on the card. Type it in if you have it.</span></div>';
    return '';
  }

  function contactFields(f, marks) {
    marks = marks || {};
    function one(k, attrs) {
      return '<div><label class="field"><span>' + FIELD_LABELS[k] + '</span><input class="input' + (marks[k] === 'check' ? ' flag' : '') + '" id="' + FIELD_IDS[k] + '" autocomplete="off" ' + attrs + ' value="' + esc(f[k]) + '"></label>' + markHtml(k, marks[k]) + '</div>';
    }
    return '<div class="grid2">' + one('name', 'maxlength="80"') + one('company', 'maxlength="80"') + '</div>' +
      '<div class="grid2">' + one('email', 'type="email" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="120"') + one('phone', 'type="tel" inputmode="tel" maxlength="30"') + '</div>' +
      one('title', 'maxlength="80"');
  }
  function wireContact(root, f, onChange, marks, onMark) {
    Object.keys(FIELD_IDS).forEach(function (k) {
      var el = $('#' + FIELD_IDS[k], root);
      if (!el) return;
      function settle() {
        if (!marks || marks[k] !== 'check') return;
        marks[k] = 'ok';
        el.classList.remove('flag');
        var c = $('[data-chk="' + k + '"]', root);
        if (c) c.outerHTML = markHtml(k, 'ok');
        if (onMark) onMark();
      }
      el.addEventListener('input', function () { f[k] = el.value; el.classList.remove('bad'); settle(); onChange(); });
      var ok = $('[data-ok="' + k + '"]', root);
      if (ok) ok.onclick = settle;
    });
  }
  function markBad(root, field) {
    var id = { name: '#fName', email: '#fEmail', phone: '#fPhone', value: '#fValue' }[field];
    var el = id && $(id, root);
    if (el) { el.classList.add('bad'); el.focus(); }
  }

  /** Stop a memo that is still recording (leaving the screen, or a re-draw). */
  function stopRecording() {
    var r = state.rec;
    state.rec = null;
    if (!r) return;
    try { r.cancelled = true; if (r.rec.state !== 'inactive') r.rec.stop(); } catch (e) { /* already stopped */ }
    try { r.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
  }
  function canRecord() { return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }

  function renderCapture(ctx) {
    var f = emptyLead();
    var started = null;
    var last = state.lastSaved && state.lastSaved.ctx === ctx.key ? state.lastSaved : null;
    // The scan: a photo and (optionally) a memo, held in memory for one
    // request and nowhere else - never in localStorage, never re-sent.
    var scan = { stage: 'idle', photo: null, photoKb: 0, memo: null, memoSecs: 0, marks: {}, read: null, result: null, fromMemo: false };
    var useScan = scanOn();

    view.innerHTML = eventHead(ctx, 'Capture', 'Ten seconds: who, how warm, what next.') +
      '<div class="cols2 even"><div>' +
      '<section class="card scan" id="scan"></section>' +
      '<div class="or">or type it</div>' +
      '<div id="capForm">' + contactFields(f) + '</div></div>' +
      '<div><div id="qualify">' + qualifyHtml(f, ctx.event.chips || []) + '</div>' +
      '<div id="capErr"></div><p class="hint" id="capHint" role="status"></p>' +
      (last ? '<p class="hint" id="lastSaved">Last saved: <a href="' + ctx.base + '/lead/' + enc(last.id) + '">' + esc(last.name) + '</a> · ' + esc(R.tempInfo(last.temp).label) + (last.draft ? ' · <a href="' + ctx.base + '/lead/' + enc(last.id) + '">follow-up draft ready</a>' : '') + '</p>' : '') +
      '<div class="capture-bar"><span class="stopwatch" id="watch" aria-live="off" title="Time to qualify">0s</span><button class="btn" id="capSave" type="button">Save lead</button></div></div></div>';

    function onChange() {
      if (!started) {
        started = Date.now();
        every(250, function () {
          var s = Math.floor((Date.now() - started) / 1000);
          var w = $('#watch'); if (!w) return;
          w.textContent = s + 's';
          w.classList.toggle('fast', s <= 10);
        });
      }
    }
    /** Nothing can be saved while a field the reader was unsure of is unchecked. */
    function syncSave() {
      var left = Object.keys(scan.marks).filter(function (k) { return scan.marks[k] === 'check'; });
      var save = $('#capSave'); var hint = $('#capHint');
      if (save) save.disabled = left.length > 0;
      if (hint) hint.textContent = left.length ? 'Check ' + left.map(function (k) { return FIELD_LABELS[k].toLowerCase(); }).join(' and ') + ' first: tap Looks right, or correct it.' : '';
    }
    function redrawForm() {
      $('#capForm').innerHTML = contactFields(f, scan.marks);
      wireContact($('#capForm'), f, onChange, scan.marks, syncSave);
      syncSave();
    }
    function redrawQualify() {
      $('#qualify').innerHTML = qualifyHtml(f, ctx.event.chips || [], scan.fromMemo);
      wireQualify($('#qualify'), f, onChange);
    }

    /** A scan's answer becomes a PROPOSAL in the form: nothing is saved here. */
    function applyScan(r) {
      scan.result = r;
      scan.marks = {};
      ['name', 'company', 'title', 'email', 'phone'].forEach(function (k) {
        var v = r.fields[k] && r.fields[k].value;
        f[k] = v || '';
        if (v && r.check.indexOf(k) >= 0) scan.marks[k] = 'check';
        else if (!v && (k === 'name' || k === 'email' || k === 'phone')) scan.marks[k] = 'none';
      });
      f.source = r.kind;
      scan.read = { name: f.name, company: f.company, title: f.title };
      var m = r.memo;
      scan.fromMemo = Boolean(m && m.heard);
      if (scan.fromMemo) {
        if (!f.note) f.note = String(m.summary || '').slice(0, R.LIMITS.note);
        if (m.temp) f.temp = m.temp;
        if (m.next) f.next = m.next;
        (m.chips || []).forEach(function (c) { if (f.chips.indexOf(c) < 0) f.chips.push(c); });
      }
      scan.stage = 'done';
      redrawForm(); redrawQualify(); drawScan();
    }

    function sentLine() {
      var what = !useScan
        ? 'What is sent: the photo goes to Anthropic’s Claude to be read once (about a cent). Booth never stores it. Only what you save is kept.'
        : 'What is sent: the photo and your memo go to Google’s Gemini to be read once (about a cent). Booth never stores either. Only what you check and save is kept.';
      return '<p class="sent">' + ico('lock') + '<span>' + what + '</span></p>';
    }
    function fileBtn(label, cls) {
      return '<label class="btn ' + (cls || 'block') + ' filebtn">' + (cls ? '' : ico('camera')) + label + '<input type="file" accept="image/*" capture="environment" data-photo aria-label="' + esc(label) + '"></label>';
    }

    function drawScan() {
      var el = $('#scan'); if (!el) return;
      var h = '';
      var secs = memoSeconds();
      if (ctx.demo) {
        h = '<h2>' + ico('camera') + (useScan ? 'Scan a card or badge' : 'Snap a card or badge') + '</h2>';
        if (scan.stage === 'done') h += doneHtml();
        else h += '<p class="muted small mt8">' + (useScan
          ? 'Photograph the card, say a ten-second memo, and get the lead filled in with a follow-up draft to check. Sign up to use it.'
          : 'AI reads the card in seconds. Sign up to use it. In the sample, type one in.') + '</p>' +
          (useScan && ctx.scan ? '<button class="btn ghost block mt16" type="button" id="sampleScan">See a sample scan</button><p class="hint">Made up, written by hand. No AI is used in the sample.</p>'
            : '<button class="btn block mt16" type="button" data-signup>Start free</button>');
      } else if (!useScan) {
        h = '<h2>' + ico('camera') + 'Snap a card or badge</h2>' +
          '<p class="muted small mt8">AI reads the name, company, title, email and phone. You check it, then qualify.</p>' +
          '<div class="mt16" id="snapNote"></div>' +
          (scan.stage === 'reading' ? '' : fileBtn('Take the photo')) + sentLine();
      } else if (scan.stage === 'idle') {
        h = '<h2>' + ico('camera') + 'Scan a card or badge</h2>' +
          '<p class="muted small mt8">Take the photo, then say a ten-second memo if you like. You get the lead filled in and a follow-up draft to check.</p>' +
          '<div class="mt16">' + fileBtn('Take the photo') + '</div><div id="scanErr"></div>' + sentLine();
      } else if (scan.stage === 'ready' || scan.stage === 'recording') {
        h = '<h2>' + ico('camera') + 'Scan a card or badge</h2>' +
          '<div class="ready mt8">' + ico('check') + '<span class="grow"><b>Photo ready</b> · ' + scan.photoKb + ' KB</span>' + fileBtn('Retake', 'small ghost') + '</div>';
        if (scan.stage === 'recording') {
          h += '<div class="ready rec">' + ico('mic') + '<span class="grow"><b>Recording <span class="num" id="recT">0</span>s of ' + secs + '</b>' + bar(0, '', 'meter') + '</span><button class="btn small" type="button" id="recStop">Stop</button></div>';
        } else if (scan.memo) {
          h += '<div class="ready">' + ico('check') + '<span class="grow"><b>Memo ready</b> · ' + scan.memoSecs + ' s</span><button class="btn small ghost" type="button" id="recGo">Redo</button><button class="btn small plain" type="button" id="recDrop">Remove</button></div>';
        } else if (canRecord()) {
          h += '<div class="ready">' + ico('mic') + '<span class="grow"><b>Add a voice memo</b><span class="blk muted cap">Up to ' + secs + ' seconds, your own words: what they want, what happens next.</span></span><button class="btn small ghost" type="button" id="recGo">Record</button></div>';
        } else {
          h += '<p class="hint">Voice memos need a browser that can record. The photo on its own still works.</p>';
        }
        h += '<div id="scanErr"></div><button class="btn block mt16" type="button" id="scanGo"' + (scan.stage === 'recording' ? ' disabled' : '') + '>' + (scan.memo ? 'Read the card and memo' : 'Read the card') + ' <span class="cost">about 1¢</span></button>' + sentLine();
      } else if (scan.stage === 'reading') {
        h = '<h2>' + ico('camera') + 'Scan a card or badge</h2>' +
          '<div class="banner mt16"><span class="spinner"></span><span>Reading the ' + (scan.memo ? 'card and your memo. Both are' : 'card. The photo is') + ' dropped as soon as ' + (scan.memo ? 'they are' : 'it is') + ' read.</span></div>';
      } else {
        h = '<h2>' + ico('camera') + 'Scan a card or badge</h2>' + doneHtml() +
          '<button class="btn ghost block mt16" type="button" id="scanAgain">Start over</button>';
      }
      el.innerHTML = h;
      wireSignup(el);
      $$('[data-photo]', el).forEach(function (inp) {
        inp.onchange = function (e) { var file = e.target.files && e.target.files[0]; e.target.value = ''; if (file) gotPhoto(file); };
      });
      var b;
      if ((b = $('#sampleScan', el))) b.onclick = function () { onChange(); applyScan(ctx.scan); };
      if ((b = $('#recGo', el))) b.onclick = record;
      if ((b = $('#recDrop', el))) b.onclick = function () { scan.memo = null; scan.memoSecs = 0; drawScan(); };
      if ((b = $('#recStop', el))) b.onclick = function () { if (state.rec && state.rec.rec.state !== 'inactive') state.rec.rec.stop(); };
      if ((b = $('#scanGo', el))) b.onclick = readScan;
      if ((b = $('#scanAgain', el))) b.onclick = function () { resetCapture(ctx); };
    }

    function doneHtml() {
      var r = scan.result;
      var n = r.check.length;
      var h = '<div class="banner good mt16">' + ico('check') + '<span>Read from the ' + esc(r.kind) + '. ' +
        (n ? plural(n, 'field') + ' need' + (n === 1 ? 's' : '') + ' a look below before you can save.' : 'Check it, then save.') +
        (r.dropped && r.dropped.length ? ' Left out: the ' + esc(r.dropped.join(' and ')) + ' didn’t look right, so nothing was guessed.' : '') + '</span></div>';
      if (r.memo && r.memo.heard) {
        h += '<div class="heard"><p class="eyebrow">What we heard in your memo</p><p>' + esc(r.memo.summary) + '</p></div>' +
          '<p class="hint">It is in the note now. Edit it freely.</p>';
      } else if (r.memo) {
        h += '<p class="hint">We couldn’t make out the memo, so there is no draft. Type a note instead.</p>';
      }
      if (r.draft) {
        h += '<details class="draft"><summary>' + ico('mail') + 'Follow-up draft ready<span class="more">Show</span></summary>' +
          '<div class="subj">' + esc(r.draft.subject) + '</div><div class="pre">' + esc(r.draft.body) + '</div></details>' +
          '<p class="hint">Written only from the card and your memo. It waits on the lead after you save. You send it yourself: Booth never sends anything.</p>';
      }
      return h;
    }

    function gotPhoto(file) {
      onChange();
      if (!useScan) return snap(file);
      shrink(file).then(function (image) {
        scan.photo = image;
        scan.photoKb = Math.max(1, Math.round(image.data.length * 3 / 4 / 1024));
        if (scan.stage !== 'recording') scan.stage = 'ready';
        drawScan();
      }).catch(function (e) { showError(e, $('#scanErr')); });
    }

    /** The plain one-photo read (the model the app has always used). */
    function snap(file) {
      scan.stage = 'reading';
      drawScan();
      var note = $('#snapNote');
      note.innerHTML = '<div class="banner"><span class="spinner"></span><span>Reading the ' + (/badge/i.test(file.name) ? 'badge' : 'card') + '. The photo is dropped as soon as it’s read.</span></div>';
      shrink(file).then(function (image) {
        return api('POST', 'api/events/' + enc(ctx.key) + '/read', { image: image });
      }).then(function (c) {
        ['name', 'company', 'title', 'email', 'phone'].forEach(function (k) { if (c[k]) f[k] = c[k]; });
        f.source = c.kind;
        scan.stage = 'idle';
        redrawForm(); drawScan();
        $('#snapNote').innerHTML = '<div class="banner good">' + ico('check') + '<span>Read from the ' + esc(c.kind) + '. Check it, then qualify.' +
          (c.dropped && c.dropped.length ? ' Left out: the ' + esc(c.dropped.join(' and ')) + ' didn’t look right, so type it in.' : '') + '</span></div><div class="mt16"></div>';
        loadMe();
      }).catch(function (e) { scan.stage = 'idle'; drawScan(); showError(e, $('#snapNote')); });
    }

    /** Record the rep's memo: at most memoSeconds, then it stops itself. */
    function record() {
      var secs = memoSeconds();
      stopRecording();
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0];
        var rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
        var chunks = [];
        var me = state.rec = { rec: rec, stream: stream, cancelled: false };
        var t0 = Date.now();
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          if (state.rec === me) state.rec = null;
          if (me.cancelled) return;
          var took = Math.min(secs, Math.max(1, Math.round((Date.now() - t0) / 1000)));
          var blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
          scan.stage = 'ready';
          if (!blob.size || blob.size > 900 * 1024) { drawScan(); return showError(new Error(blob.size ? 'That memo is too big. Try a shorter one.' : 'Nothing was recorded. Try again.'), $('#scanErr')); }
          var fr = new FileReader();
          fr.onload = function () {
            var url = String(fr.result);
            scan.memo = { type: blob.type.split(';')[0], data: url.slice(url.indexOf(',') + 1) };
            scan.memoSecs = took;
            drawScan();
          };
          fr.readAsDataURL(blob);
        };
        scan.memo = null;
        scan.stage = 'recording';
        drawScan();
        rec.start();
        every(200, function () {
          if (state.rec !== me) return;
          var s = (Date.now() - t0) / 1000;
          var t = $('#recT'); if (t) t.textContent = String(Math.min(secs, Math.floor(s)));
          var v = $('svg.meter .val'); if (v) v.setAttribute('width', Math.min(100, s / secs * 100).toFixed(1));
          if (s >= secs && rec.state !== 'inactive') rec.stop();
        });
      }).catch(function () {
        showError(new Error('Booth can’t use the microphone. Allow it in your browser, or read the card on its own.'), $('#scanErr'));
      });
    }

    function readScan() {
      if (!scan.photo) return;
      var body = { image: scan.photo };
      if (scan.memo) body.memo = scan.memo;
      scan.stage = 'reading';
      drawScan();
      api('POST', 'api/events/' + enc(ctx.key) + '/scan', body).then(function (r) {
        // Read once: the page lets go of the photo and the memo too.
        scan.photo = null; scan.memo = null;
        applyScan(r);
        loadMe();
      }).catch(function (e) { scan.stage = 'ready'; drawScan(); showError(e, $('#scanErr')); });
    }

    wireContact($('#capForm'), f, onChange, scan.marks, syncSave);
    wireQualify($('#qualify'), f, onChange);
    drawScan();
    wireSignup();
    $('#capSave').onclick = function () {
      if (Object.keys(scan.marks).some(function (k) { return scan.marks[k] === 'check'; })) return syncSave();
      saveCapture(ctx, f, started, false, scan);
    };
  }

  function resetCapture(ctx) { stopTimers(); stopRecording(); renderCapture(ctx); window.scrollTo(0, 0); }

  /** The scan's draft belongs to the person the card named. If the rep
   *  changed the name, company or title, it is dropped rather than sent to
   *  someone it was not written for. */
  function draftFor(scan, l) {
    if (!scan || !scan.result || !scan.result.draft || !scan.read) return null;
    var same = ['name', 'company', 'title'].every(function (k) { return String(scan.read[k] || '') === String(l[k] || ''); });
    return same ? scan.result.draft : false;
  }

  function saveCapture(ctx, f, started, force, scan) {
    var err = $('#capErr');
    err.innerHTML = '';
    var r = R.validateLead(f, { chips: ctx.event.chips || [] });
    if (r.error) { err.innerHTML = '<div class="err" role="alert">' + esc(r.error) + '</div>'; markBad(view, r.field); return; }
    var secs = started ? Math.max(1, Math.round((Date.now() - started) / 1000)) : null;
    if (ctx.demo) {
      toast((secs ? 'Qualified in ' + secs + 's. ' : '') + 'Sample only, nothing saved. Start free to capture your own.', 4200);
      return resetCapture(ctx);
    }
    var btn = $('#capSave'); btn.disabled = true;
    var body = Object.assign({}, f, { force: force === true });
    api('POST', 'api/events/' + enc(ctx.key) + '/leads', body).then(function (res) {
      var l = res.lead;
      ctx.leads.unshift(l);
      var d = draftFor(scan, l);
      if (d) state.drafts[l.id] = d;
      state.lastSaved = { ctx: ctx.key, id: l.id, name: leadName(l), temp: l.temp, draft: Boolean(d) };
      var mine = ctx.leads.filter(function (x) { return x.mine; });
      var streak = R.hotStreak(mine).current;
      var msg = (secs ? (secs <= 10 ? 'Qualified in ' + secs + 's. ' : 'Saved in ' + secs + 's. ') : 'Saved. ') +
        (l.temp === 'hot' ? (streak >= 2 ? 'Hot streak: ' + streak + ' in a row.' : 'The clock is ticking: 48 hours.') : 'Follow up within ' + R.tempInfo(l.temp).window + '.') +
        (d ? ' The draft is on the lead.' : d === false ? ' You changed who it is for, so the draft was dropped.' : '');
      toast(msg, 3800);
      if (l.temp === 'hot' && (streak === 3 || streak === 5 || streak === 10)) confetti();
      resetCapture(ctx);
    }).catch(function (e) {
      btn.disabled = false;
      if (e.status === 409 && e.data && e.data.duplicate) return dupSheet(ctx, f, e.data.duplicate, started, scan);
      showError(e, err);
      if (e.data && e.data.field) markBad(view, e.data.field);
    });
  }

  function dupSheet(ctx, f, d, started, scan) {
    var t = R.tempInfo(d.temp);
    sheet('<h2>Already on the list?</h2>' +
      '<p class="muted">Same ' + esc(d.by) + ' as <b>' + esc(d.name || d.company || 'a lead') + '</b>' + (d.company && d.name ? ' (' + esc(d.company) + ')' : '') + ', ' + esc(t.label.toLowerCase()) + ', captured by ' + esc(d.capturedByName || 'a teammate') + ' ' + esc(ago(d.capturedAt)) + '.</p>' +
      '<button class="btn block mt16" id="dMerge" type="button">Merge into their lead</button>' +
      '<button class="btn ghost block mt8" id="dNew" type="button">Save as a separate lead</button><button class="btn plain block mt8" id="dCancel" type="button">Cancel</button>' +
      '<p class="hint">Merging fills in what’s missing, adds the interests you ticked, keeps the hotter temperature and adds your note. Nothing they wrote is overwritten.</p><div id="dErr"></div>',
      function (root) {
        $('#dMerge', root).onclick = function () {
          this.disabled = true;
          api('POST', 'api/events/' + enc(ctx.key) + '/leads/' + enc(d.id) + '/merge', f).then(function () {
            closeSheet(); toast('Merged into ' + (d.name || d.company || 'their lead') + '.'); resetCapture(ctx);
          }).catch(function (e) { showError(e, $('#dErr', root)); });
        };
        $('#dNew', root).onclick = function () { closeSheet(); saveCapture(ctx, f, started, true, scan); };
        $('#dCancel', root).onclick = closeSheet;
      });
  }

  /** Shrink a photo in the browser before it is sent: 1600px JPEG. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, 1600 / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var data = c.toDataURL('image/jpeg', 0.85);
        resolve({ type: 'image/jpeg', data: data.slice(data.indexOf(',') + 1) });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That image could not be opened. Try a JPEG or PNG photo.')); };
      img.src = url;
    });
  }

  /* ---------------- one lead ---------------- */

  function ring(c) {
    var pctv = c.state === 'done' || c.state === 'closed' ? 1 : c.pct;
    return '<div class="ring" aria-hidden="true"><svg viewBox="0 0 36 36"><circle class="trk" cx="18" cy="18" r="15.9" fill="none" stroke-width="3"/>' +
      '<circle class="val" cx="18" cy="18" r="15.9" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="100 100" stroke-dashoffset="' + (100 - Math.round(pctv * 100)) + '"/></svg></div>';
  }

  function renderLead(ctx, id) {
    var l = ctx.leads.filter(function (x) { return x.id === id; })[0];
    if (!l) { view.innerHTML = backLink(ctx.base, 'Leads') + '<div class="empty"><h2>No such lead</h2><p>It may have been deleted or merged.</p></div>'; return; }
    var t = R.tempInfo(l.temp);
    var c = R.clock(l, now());
    var f = { temp: l.temp, chips: (l.chips || []).slice(), next: l.next || '', note: l.note || '' };
    var src = { typed: 'typed in', card: 'from a business card', badge: 'from a badge' }[l.source] || 'typed in';
    var h = (ctx.demo ? sampleBar() : '') + backLink(ctx.base, 'Leads') +
      '<div class="cols2 even"><div>' +
      '<div class="lead-head"><h1>' + dot(l.temp) + '<span class="min0">' + esc(leadName(l)) + '</span></h1>' +
      '<div class="m">' + esc([l.title, l.name ? l.company : ''].filter(Boolean).join(' at ')) + '</div>' +
      '<div class="m cap">' + esc(t.label) + ' · captured by ' + esc(l.capturedByName) + ' · ' + esc(ago(l.capturedAt)) + ' · ' + esc(src) + (l.mergedCount ? ' · merged ' + plural(l.mergedCount, 'time') : '') + '</div></div>' +
      '<div class="clock-row ' + c.state + '" data-ck="' + esc(l.id) + '" data-long="1">' + ring(c) + '<div><b class="lbl">' + esc(R.clockLabel(c)) + '</b><span class="muted small">' +
      esc(c.state === 'cold' ? 'Late still beats never. Send it today.' : c.state === 'done' ? (l.wonAt ? 'Won. Nice work.' : 'Log the reply when it lands.') : c.state === 'closed' ? 'This lead is closed.' : t.label + ' leads go cold after ' + t.window + ' without a follow-up.') + '</span></div></div>' +
      '<section class="section" id="follow"></section>' +
      '</div><div>' +
      '<section class="section"><div class="sec-head"><h2>Contact</h2>' + (ctx.demo ? '' : '<button class="btn small ghost" id="editC" type="button">Edit</button>') + '</div><div class="list">' +
      (l.email ? '<div class="kv"><span class="k">Email</span><a class="grow" href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a><button class="btn small plain" type="button" data-copy="' + esc(l.email) + '">Copy</button></div>' : '') +
      (l.phone ? '<div class="kv"><span class="k">Phone</span><a class="grow" href="tel:' + esc(l.phone.replace(/[^\d+]/g, '')) + '">' + esc(l.phone) + '</a><button class="btn small plain" type="button" data-copy="' + esc(l.phone) + '">Copy</button></div>' : '') +
      (!l.email && !l.phone ? '<p class="muted small mt12">No email or phone captured.' + (ctx.demo ? '' : ' Add one so you can follow up.') + '</p>' : '') +
      '</div></section>' +
      '<section class="section"><div class="sec-head"><h2>What happened</h2><span class="count">' + esc(R.statusInfo(l.status).label) + '</span></div>' +
      '<div class="ladder" role="group" aria-label="Status">' + R.STATUSES.map(function (s) {
        var on = l.status === s.key;
        var past = !on && s.stamp && l[s.stamp];
        return '<button type="button" data-st="' + s.key + '" class="' + (on ? 'on' : past ? 'past' : '') + '" aria-pressed="' + on + '">' + esc(s.key === 'new' ? 'Not yet' : s.key === 'sent' ? 'Sent' : s.key === 'booked' ? 'Meeting' : s.label) + '</button>';
      }).join('') + '</div>' +
      '<div class="valrow"><label class="field"><span>Deal value ($), ' + (l.wonAt ? 'won' : 'estimated, counts toward pipeline') + '</span><input class="input" id="fValue" inputmode="decimal" placeholder="e.g. 2400" value="' + esc(l.value == null ? '' : l.value) + '"' + (ctx.demo ? ' readonly' : '') + '></label>' +
      (ctx.demo ? '' : '<button class="btn ghost" id="saveV" type="button">Save</button>') + '</div><div id="stErr"></div></section>' +
      '<section class="section" id="qualify"><div class="sec-head"><h2>Qualify</h2><button class="btn small hidden" id="saveQ" type="button">Save changes</button></div>' + qualifyHtml(f, ctx.event.chips || []) + '<div id="qErr"></div></section>' +
      (!ctx.demo && l.canDelete ? '<section class="section"><button class="btn danger block" id="delLead" type="button">Delete this lead</button></section>' : '') +
      '</div></div>';
    view.innerHTML = h;
    wireSignup();
    tickClocks([l]);
    $$('[data-copy]').forEach(function (b) { b.onclick = function () { copy(b.dataset.copy, 'Copied'); }; });

    // Qualify: re-qualify in place, save when something changed.
    wireQualify($('#qualify'), f, function () {
      var dirty = f.temp !== l.temp || f.next !== (l.next || '') || f.note !== (l.note || '') || f.chips.slice().sort().join('|') !== (l.chips || []).slice().sort().join('|');
      $('#saveQ').classList.toggle('hidden', !dirty || ctx.demo);
    });
    $('#saveQ').onclick = function () {
      this.disabled = true;
      api('PUT', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id), f).then(function (r) { replaceLead(ctx, r.lead); toast('Saved.'); renderLead(ctx, l.id); })
        .catch(function (e) { $('#saveQ').disabled = false; showError(e, $('#qErr')); });
    };
    var ec = $('#editC'); if (ec) ec.onclick = function () { editContact(ctx, l); };

    // Status ladder.
    $$('[data-st]').forEach(function (b) {
      b.onclick = function () {
        if (ctx.demo) return toast('Sample only. Start free to track your own.');
        var st = b.dataset.st;
        var body = { status: st };
        if (st === 'won') {
          var v = $('#fValue').value.trim();
          if (!v) { var p = prompt('Nice! What is the deal worth, in dollars?', ''); if (p === null) return; body.value = p; } else body.value = v;
        }
        api('POST', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id) + '/status', body).then(function (r) {
          replaceLead(ctx, r.lead);
          if (st === 'won') { confetti(); toast('Won! It counts on the scorecard.'); } else toast(R.statusInfo(st).label);
          renderLead(ctx, l.id);
        }).catch(function (e) { showError(e, $('#stErr')); if (e.data && e.data.field) markBad(view, e.data.field); });
      };
    });
    var sv = $('#saveV'); if (sv) sv.onclick = function () {
      api('PUT', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id), { value: $('#fValue').value.trim() }).then(function (r) { replaceLead(ctx, r.lead); toast('Deal value saved.'); })
        .catch(function (e) { showError(e, $('#stErr')); markBad(view, 'value'); });
    };
    var del = $('#delLead'); if (del) del.onclick = function () {
      if (!confirm('Delete ' + leadName(l) + '? This cannot be undone.')) return;
      api('DELETE', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id)).then(function () { delete state.drafts[l.id]; toast('Deleted.'); location.hash = ctx.base; }).catch(function (e) { showError(e); });
    };
    drawFollow(ctx, l);
  }

  function replaceLead(ctx, l) {
    for (var i = 0; i < ctx.leads.length; i++) if (ctx.leads[i].id === l.id) ctx.leads[i] = l;
  }

  function editContact(ctx, l) {
    var f = { name: l.name, company: l.company, title: l.title, email: l.email, phone: l.phone };
    sheet('<h2>Contact details</h2><div id="ecForm" class="mt16">' + contactFields(f) + '</div><div id="ecErr"></div><button class="btn block" id="ecSave" type="button">Save</button>', function (root) {
      wireContact(root, f, function () {});
      $('#ecSave', root).onclick = function (ev, force) {
        var btn = this; btn.disabled = true;
        api('PUT', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id), Object.assign({}, f, { force: force === true })).then(function (r) {
          replaceLead(ctx, r.lead); closeSheet(); toast('Saved.'); renderLead(ctx, l.id);
        }).catch(function (e) {
          btn.disabled = false;
          if (e.status === 409 && e.data && e.data.duplicate) {
            $('#ecErr', root).innerHTML = '<div class="err" role="alert">' + esc(e.message) + ' <button class="link-btn" id="ecForce" type="button">Save anyway</button></div>';
            $('#ecForce', root).onclick = function () { $('#ecSave', root).onclick.call($('#ecSave', root), null, true); };
            return;
          }
          showError(e, $('#ecErr', root));
          if (e.data && e.data.field) markBad(root, e.data.field);
        });
      };
    });
  }

  /** The follow-up: a free template, or a draft in the rep's voice. */
  function drawFollow(ctx, l) {
    var el = $('#follow');
    var mode = state.drafts[l.id] || (ctx.demo && ctx.drafts[l.id]) ? 'draft' : 'template';
    var rep = ctx.demo ? (ctx.reps[l.rep] || ctx.me) : ctx.me;
    function current() {
      if (mode === 'draft') return state.drafts[l.id] || (ctx.demo && ctx.drafts[l.id]) || null;
      return R.template(l, ctx.event, rep);
    }
    function draw() {
      var d = current();
      var h = '<div class="sec-head"><h2>Follow-up</h2><span class="count">' + esc(R.tempInfo(l.temp).label) + '</span></div>' +
        '<div class="tabs2" role="tablist"><button type="button" role="tab" data-mode="template" class="' + (mode === 'template' ? 'on' : '') + '" aria-selected="' + (mode === 'template') + '">Template · free</button>' +
        '<button type="button" role="tab" data-mode="draft" class="' + (mode === 'draft' ? 'on' : '') + '" aria-selected="' + (mode === 'draft') + '">In my voice</button></div>';
      if (mode === 'draft' && !d) {
        h += '<p class="muted small">A short email that sounds like you, from what was captured: the show, their interests, the next step and your note. It never adds a price, a date, a link or an attachment nobody mentioned. Where it needs one it leaves <b>[add: …]</b> for you.</p>' +
          (ctx.demo ? '<button class="btn block mt16" type="button" data-signup>Start free to draft yours</button>' : '<button class="btn block mt16" id="goDraft" type="button">Draft it <span class="cost">about 1¢</span></button>') + '<div id="dErr"></div>';
      } else {
        h += (mode === 'draft' && d.rep ? '<p class="hint mb0">Drafted for ' + esc(d.rep) + '. Sample.</p><div class="mt12"></div>' : '') +
          '<label class="field"><span>Subject</span><input class="input" id="mSubj" maxlength="120" value="' + esc(d.subject) + '"></label>' +
          '<label class="field"><span>Message</span><textarea class="input" id="mBody" rows="10" maxlength="2000">' + esc(d.body) + '</textarea></label>';
        if (mode === 'draft' && d.gaps && d.gaps.length) h += '<div class="label">Fill these in</div><div class="tags">' + d.gaps.map(function (g) { return '<span class="tag">[add: ' + esc(g) + ']</span>'; }).join('') + '</div>';
        if (mode === 'draft' && d.removed && d.removed.length) {
          h += '<details class="quiet mt8"><summary>Taken out: ' + plural(d.removed.length, 'thing') + ' nobody captured</summary><ul class="removed">' +
            d.removed.map(function (r) { return '<li><b>' + esc(r.what) + '</b> · ' + esc(r.detail ? 'a detail nobody captured' : '“' + r.text + '”') + '</li>'; }).join('') + '</ul></details>';
        }
        h += '<div class="btn-row mt16"><button class="btn ghost" id="mCopy" type="button">Copy</button>' +
          (l.email ? '<a class="btn ghost" id="mMail" href="#">Open in email</a>' : '') +
          (l.sentAt || ctx.demo ? '' : '<button class="btn" id="mSent" type="button">Mark as sent</button>') + '</div>' +
          (mode === 'draft' && !ctx.demo ? '<button class="btn plain small mt8" id="reDraft" type="button">Draft again · about 1¢</button>' : '') +
          '<p class="hint">Booth doesn’t send email. Copy it, or open it in your own mail app, then mark it sent so the clock stops.</p>';
      }
      el.innerHTML = h;
      wireSignup(el);
      $$('[data-mode]', el).forEach(function (b) { b.onclick = function () { mode = b.dataset.mode; draw(); }; });
      var subj = $('#mSubj', el), body = $('#mBody', el), mail = $('#mMail', el);
      function syncMail() { if (mail) mail.href = R.mailto(l.email, subj.value, body.value) || '#'; }
      if (subj) { subj.oninput = syncMail; body.oninput = syncMail; syncMail(); }
      var cp = $('#mCopy', el); if (cp) cp.onclick = function () { copy('Subject: ' + subj.value + '\n\n' + body.value, 'Copied. Paste it into your email.'); };
      var sent = $('#mSent', el); if (sent) sent.onclick = function () {
        api('POST', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id) + '/status', { status: 'sent' }).then(function (r) {
          replaceLead(ctx, r.lead);
          var c = R.clock(r.lead, now());
          toast(c.onTime ? (c.tookMs <= R.HOUR ? 'Quick draw: followed up in ' + R.duration(c.tookMs) + '.' : 'Followed up in time. Clock stopped.') : 'Followed up. Late still beats never.', 3200);
          renderLead(ctx, l.id);
        }).catch(function (e) { showError(e); });
      };
      var go = $('#goDraft', el) || $('#reDraft', el);
      if (go) go.onclick = function () {
        go.disabled = true; go.innerHTML = '<span class="spinner"></span> Writing in your voice';
        api('POST', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id) + '/draft').then(function (d2) {
          state.drafts[l.id] = d2; mode = 'draft'; draw(); loadMe();
        }).catch(function (e) { go.disabled = false; go.textContent = 'Try again'; showError(e, $('#dErr', el) || null); });
      };
    }
    draw();
  }

  /* ---------------- leaderboard ---------------- */

  function renderBoard(ctx) {
    var get = ctx.demo ? Promise.resolve({ rows: ctx.board }) : api('GET', 'api/events/' + enc(ctx.key) + '/leaderboard');
    get.then(function (r) {
      var rows = r.rows;
      var places = ['1st', '2nd', '3rd'];
      var h = eventHead(ctx, 'Leaderboard', 'Points for capturing, hot leads and follow-ups that beat the clock.');
      if (rows.length >= 2) {
        var order = rows.length >= 3 ? [1, 0, 2] : [1, 0];
        h += '<div class="podium n' + order.length + '">' + order.map(function (i) {
          var x = rows[i];
          return '<div class="pod p' + (i + 1) + '"><div class="place">' + places[i] + '</div><div class="nm">' + esc(x.name) + (x.you ? ' (you)' : '') + '</div><div class="pts num">' + x.points + ' <small>pts</small></div>' +
            (x.streak >= 2 ? '<div class="cap t-hot">' + x.streak + ' hot in a row</div>' : '<div class="cap muted">' + plural(x.captured, 'lead') + '</div>') + '</div>';
        }).join('') + '</div>';
      }
      h += '<div class="list">' + rows.map(function (x) {
        return '<div class="row brow"><span class="rk">' + x.rank + '</span><div class="grow"><div class="nm">' + esc(x.name) + (x.you ? ' <span class="tag">you</span>' : '') + (x.role === 'owner' ? ' <span class="tag">runs it</span>' : '') + '</div>' +
          '<div class="st"><span>' + plural(x.captured, 'lead') + '</span><span>' + x.hot + ' hot</span><span>' + x.onTime + ' on time</span>' +
          (x.meetings ? '<span>' + plural(x.meetings, 'meeting') + '</span>' : '') + (x.won ? '<span>' + x.won + ' won</span>' : '') +
          (x.wentCold ? '<span class="t-hot">' + x.wentCold + ' went cold</span>' : '') + (x.streak >= 2 ? '<span class="t-hot">' + x.streak + ' hot in a row</span>' : '') + '</div>' +
          (x.badges.length ? '<div class="badges">' + x.badges.map(function (k) { var b = R.badgeInfo(k); return '<span class="tag" title="' + esc(b.detail) + '">' + esc(b.label) + '</span>'; }).join('') + '</div>' : '') +
          '</div><div class="pts">' + x.points + '<small>points</small></div></div>';
      }).join('') + '</div>';
      h += '<section class="section"><div class="sec-head"><h2>How points work</h2></div><div class="tags">' +
        [['A lead', R.POINTS.lead], ['It’s hot', R.POINTS.hot], ['Followed up in time', R.POINTS.onTime], ['Followed up late', R.POINTS.late], ['A reply', R.POINTS.reply], ['A meeting', R.POINTS.meeting], ['A win', R.POINTS.won]].map(function (p) {
          return '<span class="tag">' + esc(p[0]) + ' +' + p[1] + '</span>';
        }).join('') + '</div><div class="label">Badges</div><div class="tags">' + R.BADGES.map(function (b) { return '<span class="tag" title="' + esc(b.detail) + '">' + esc(b.label) + '</span>'; }).join('') + '</div>' +
        '<p class="hint">Everyone on the team sees names and counts here. Lead details are on the Leads tab: it’s the team’s pipeline.</p></section>';
      view.innerHTML = h;
      wireSignup();
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- scorecard ---------------- */

  function hbar(label, v, max, cls, text, tip) {
    var w = max > 0 ? Math.max(v > 0 ? 1.5 : 0, v / max * 100) : 0;
    return '<div class="hbar" role="img" aria-label="' + esc(tip || label + ': ' + text) + '"><span class="lab">' + esc(label) + '</span>' +
      '<svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="trk" width="100" height="8"/><rect class="' + cls + '" width="' + w.toFixed(1) + '" height="8"/></svg>' +
      '<span class="v">' + esc(text) + '</span></div>';
  }

  /** The scorecard body - used by the team's own view and by the public card,
   *  whose fields are the same aggregates by name. */
  function scoreBody(sc) {
    var h = '';
    var v = sc.verdict || {};
    h += '<div class="banner ' + (v.key === 'paid' ? 'good' : v.key === 'cold' ? 'cold' : v.key === 'pipeline' ? 'warn' : '') + '">' + ico(v.key === 'paid' ? 'check' : v.key === 'cold' ? 'alert' : 'clock') + '<span>' + esc(v.text || '') + '</span></div>';
    var maxMoney = Math.max(sc.boothCost || 0, sc.wonValue || 0, sc.pipelineValue || 0);
    h += '<section class="section"><p class="eyebrow">Return on the booth</p><div class="bigline">' +
      (sc.roi == null ? '<b class="muted">—</b><span class="muted small">add the booth cost to see ROI</span>' : '<b class="' + (sc.roi >= 0 ? 'good' : 'bad') + '">' + (sc.roi > 0 ? '+' : '') + sc.roi + '%</b><span class="muted small">' + esc(R.money(sc.wonValue)) + ' won on ' + esc(R.money(sc.boothCost)) + '</span>') + '</div>' +
      '<div class="hbars mt24">' + hbar('Booth cost', sc.boothCost || 0, maxMoney, 'i-cost', R.money(sc.boothCost || 0)) + hbar('Won', sc.wonValue || 0, maxMoney, 'i-won', R.money(sc.wonValue || 0), 'Won: ' + R.money(sc.wonValue || 0) + ' from ' + plural(sc.won, 'deal')) +
      hbar('Pipeline', sc.pipelineValue || 0, maxMoney, 'i-pipe', R.money(sc.pipelineValue || 0), 'Open pipeline: ' + R.money(sc.pipelineValue || 0) + ' in estimated deal values') + '</div>' +
      '<div class="facts"><span>Cost per lead <b>' + (sc.costPerLead == null ? '—' : esc(R.money(sc.costPerLead))) + '</b></span><span>Cost per meeting <b>' + (sc.costPerMeeting == null ? '—' : esc(R.money(sc.costPerMeeting))) + '</b></span>' +
      (sc.coverage != null ? '<span>Pipeline + won covers the booth <b>' + sc.coverage + '×</b></span>' : '') + '</div></section>';
    h += '<section class="section"><div class="kpis">' +
      '<div class="kpi"><b>' + sc.leads + '</b><span>Leads captured</span></div>' +
      '<div class="kpi"><b>' + (sc.temps.hot || 0) + '</b><span>Hot leads</span></div>' +
      '<div class="kpi"><b>' + sc.within48Rate + '%</b><span>Followed up within 48h</span></div>' +
      '<div class="kpi"><b>' + sc.replies + '</b><span>Replies' + (sc.followedUp ? ' (' + sc.replyRate + '%)' : '') + '</span></div>' +
      '<div class="kpi"><b>' + sc.meetings + '</b><span>Meetings booked</span></div>' +
      '<div class="kpi"><b>' + esc(R.money(sc.wonValue)) + '</b><span>Won (' + sc.won + ')</span></div></div></section>';
    var tot = sc.leads || 1;
    var x = 0;
    h += '<section class="section"><div class="sec-head"><h2>Leads by temperature</h2><span class="count">' + plural(sc.leads, 'lead') + '</span></div>' +
      '<svg class="stackbar" viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label="' + esc(R.TEMPS.map(function (t) { return (sc.temps[t.key] || 0) + ' ' + t.label.toLowerCase(); }).join(', ')) + '"><rect class="trk" width="100" height="12"/>' +
      R.TEMPS.map(function (t) { var n = sc.temps[t.key] || 0; var w = n / tot * 100; var r = n ? '<rect class="' + t.key + '" x="' + x.toFixed(1) + '" width="' + Math.max(0, w - 0.6).toFixed(1) + '" height="12"/>' : ''; x += w; return r; }).join('') + '</svg>' +
      '<div class="legend">' + R.TEMPS.map(function (t) { var n = sc.temps[t.key] || 0; return '<span><span class="dot ' + t.key + '" aria-hidden="true"></span>' + t.label + ' <b class="num">' + n + '</b> <span class="muted">(' + Math.round(n / tot * 100) + '%)</span></span>'; }).join('') + '</div></section>';
    h += '<section class="section"><div class="sec-head"><h2>From booth to deal</h2><span class="count">each step as a share of leads</span></div><div class="hbars">' +
      sc.funnel.map(function (f) { return hbar(f.label, f.n, sc.leads, 'i-funnel', f.n + (sc.leads ? ' · ' + Math.round(f.n / sc.leads * 100) + '%' : '')); }).join('') + '</div>' +
      '<p class="hint">' + sc.onTimeRate + '% were followed up before their clock ran out; ' + plural(sc.wentCold, 'lead') + ' went cold waiting.</p></section>';
    if (sc.chips && sc.chips.length) {
      var cmax = sc.chips[0].n;
      h += '<section class="section"><div class="sec-head"><h2>What they asked about</h2></div><div class="hbars">' +
        sc.chips.slice(0, 8).map(function (c) { return hbar(c.chip, c.n, cmax, 'i-chip', String(c.n)); }).join('') + '</div></section>';
    }
    if (sc.days && sc.days.length) {
      var dmax = Math.max.apply(null, sc.days.map(function (d) { return d.n; })) || 1;
      var n = sc.days.length;
      h += '<section class="section"><div class="sec-head"><h2>Leads per day</h2></div>' +
        '<svg class="cols" viewBox="0 0 ' + (n * 20) + ' 100" preserveAspectRatio="none" role="img" aria-label="' + esc(sc.days.map(function (d) { return fmtDay(d.day) + ': ' + d.n; }).join(', ')) + '">' +
        sc.days.map(function (d, i) { var ht = Math.max(3, d.n / dmax * 100); return '<rect x="' + (i * 20 + 5) + '" y="' + (100 - ht).toFixed(1) + '" width="10" height="' + ht.toFixed(1) + '"/>'; }).join('') + '</svg>' +
        '<div class="colsx">' + sc.days.map(function (d) { return '<span><b>' + d.n + '</b>' + esc(fmtDay(d.day)) + '</span>'; }).join('') + '</div>' +
        '<details class="quiet"><summary>As a table</summary><table class="plain"><tr><th>Day</th><th>Leads</th></tr>' + sc.days.map(function (d) { return '<tr><td>' + esc(fmtDay(d.day, { weekday: 'short' })) + '</td><td>' + d.n + '</td></tr>'; }).join('') + '</table></details></section>';
    }
    return h;
  }

  function renderScore(ctx) {
    var get = ctx.demo ? Promise.resolve({ scorecard: ctx.score, goingCold: ctx.goingCold }) : api('GET', 'api/events/' + enc(ctx.key) + '/scorecard');
    get.then(function (r) {
      var sc = r.scorecard;
      var h = eventHead(ctx, 'Show scorecard', 'Did the booth pay off? Counted live from every lead.');
      h += '<div class="cols2"><div>' + scoreBody(sc) + '</div><div>';
      // The same leads the list shows, so the rows tick from their own capture times.
      var byId = {};
      ctx.leads.forEach(function (l) { byId[l.id] = l; });
      var cold = (r.goingCold || []).map(function (g) { return byId[g.id] || null; }).filter(Boolean);
      h += '<section class="section"><div class="sec-head"><h2>Going cold right now</h2><span class="count">' + plural(cold.length, 'lead') + '</span></div>' +
        (cold.length ? '<div class="list">' + cold.slice(0, 12).map(function (g) { return coldRow(g, ctx.base); }).join('') + '</div>' : '<p class="muted small">Every lead has had a follow-up.</p>') + '</section>';
      if (!ctx.demo && ctx.event.owner) {
        h += '<section class="section"><h2>Share or export</h2><p class="small muted mt8">Share a frozen, read-only scorecard: numbers only, never a lead’s name or contact. Export every lead as a CSV for your CRM.</p>' +
          '<div class="btn-row mt16"><button class="btn" id="shareBtn" type="button">' + (ctx.event.share ? 'Manage share link' : 'Share the scorecard') + '</button><a class="btn ghost" href="' + BASE + 'api/events/' + enc(ctx.key) + '/export.csv" download>Export CSV</a></div></section>';
      } else if (ctx.demo) {
        h += '<section class="section"><h2>Share or export</h2><p class="small muted mt8">The owner can share a read-only scorecard (numbers only) and export every lead as a CSV.</p><button class="btn block mt16" type="button" data-signup>Start free</button></section>';
      }
      h += '</div></div>';
      view.innerHTML = h;
      wireSignup();
      tickClocks(ctx.leads);
      var sb = $('#shareBtn'); if (sb) sb.onclick = function () { openShare(ctx); };
    }).catch(function (e) { showError(e, view); });
  }

  function openShare(ctx) {
    function draw(root, s) {
      var url = s ? location.origin + BASE + s.url : '';
      root.innerHTML = '<div class="grab"></div><h2>Share the scorecard</h2><p class="muted small">A public, read-only card: the verdict, ROI, follow-up rate, the funnel and what visitors asked about. Numbers only: no lead, no contact, no teammate. Frozen when you publish; update it any time.</p>' +
        (s ? '<div class="share-box mt16"><input class="input" id="shUrl" readonly value="' + esc(url) + '" aria-label="Share link"><button class="btn small" id="shCopy" type="button">Copy</button></div>' +
          '<div class="btn-row mt12"><button class="btn small ghost" id="shPub" type="button">Update the card</button><a class="btn small ghost" href="' + esc(BASE + s.url) + '" target="_blank" rel="noopener">Open</a><button class="btn small danger" id="shRevoke" type="button">Revoke</button></div>'
          : '<button class="btn block mt16" id="shPub" type="button">Publish the card</button>') +
        '<div id="shErr"></div><p class="hint">Anyone with the link can see it. Revoke it and the link is dead for good.</p>';
      $('#shPub', root).onclick = function () {
        this.disabled = true;
        api('POST', 'api/events/' + enc(ctx.key) + '/share').then(function (r) {
          ctx.event.share = { token: r.token, url: r.url, sharedAt: r.sharedAt };
          toast(s ? 'Updated. The link shows today’s numbers.' : 'Published. Copy the link.');
          draw(root, ctx.event.share);
        }).catch(function (e) { showError(e, $('#shErr', root)); });
      };
      var cp = $('#shCopy', root); if (cp) cp.onclick = function () { var i = $('#shUrl', root); i.select(); copy(i.value, 'Link copied'); };
      var rv = $('#shRevoke', root); if (rv) rv.onclick = function () {
        if (!confirm('Revoke this link? Anyone who has it will see “not valid”, and it never comes back.')) return;
        api('DELETE', 'api/events/' + enc(ctx.key) + '/share').then(function () { ctx.event.share = null; toast('Revoked.'); draw(root, null); }).catch(function (e) { showError(e, $('#shErr', root)); });
      };
    }
    sheet('', function (root) { draw(root, ctx.event.share); });
  }

  function renderShared(token) {
    document.body.classList.add('public');
    document.body.classList.remove('dk');
    loading();
    api('GET', 'api/shared/' + token).then(function (c) {
      document.title = c.event.name + ' · a Booth scorecard';
      view.innerHTML = '<div class="scard">' + (c.preview ? '<div class="banner">' + ico('lock') + '<span>This is what people see: a frozen card. Update it from the scorecard.</span></div><div class="mt24"></div>' : '') +
        '<p class="eyebrow">Show scorecard</p><h1>' + esc(c.event.name) + '</h1><div class="when">' + esc([fmtRange(c.event.startDate, c.event.endDate), c.event.place].filter(Boolean).join(' · ')) + ' · a team of ' + c.teamSize + '</div>' +
        '<div class="mt24">' + scoreBody(c) + '</div>' +
        '<p class="center small muted mt32">Frozen ' + esc(fmtDay(c.frozenAt, { year: 'numeric' })) + '. Numbers only: no lead’s name or contact is on this card.</p>' +
        '<p class="center small muted mt16">Made with <a href="./">Booth</a>: trade-show leads that don’t go cold.</p></div>';
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><h2>This link isn’t valid</h2><p>' + esc(e.message) + '</p><a class="btn" href="./">What is Booth?</a></div>';
    });
  }

  /* ---------------- settings ---------------- */

  function renderSettings(ctx) {
    api('GET', 'api/events/' + enc(ctx.key)).then(function (ev) {
      ctx.event = ev;
      var me = ev.me;
      var h = backLink(ctx.base, 'Leads') + '<div class="page-head"><div><div class="eyebrow">' + esc(ev.name) + '</div><h1>' + (ev.owner ? 'Team & event' : 'You on this team') + '</h1></div></div><div class="cols2 even"><div>';
      var invite = '';
      if (ev.owner) {
        invite = 'Join our booth team for ' + ev.name + ' on Booth: ' + location.origin + BASE + '#/join/' + R.normalizeCode(ev.code) + ' (code ' + ev.code + ')';
        h += '<section class="section"><div class="sec-head"><h2>Invite the team</h2><span class="count">' + people(ev.members) + '</span></div>' +
          '<div class="codebox" aria-label="Join code">' + esc(ev.code) + '</div>' +
          '<div class="btn-row"><button class="btn" id="copyInvite" type="button">Copy invite</button><button class="btn ghost" id="copyCode" type="button">Copy code</button></div>' +
          '<p class="hint">Staff see every lead and the leaderboard; only you can edit the event, export, share the scorecard or remove people. If the code leaked, reset it: the old one stops at once.</p><button class="btn small ghost mt8" id="resetCode" type="button">Reset the code</button>' +
          '<div class="list mt16">' + (ev.people || []).map(function (p) {
            return '<div class="row"><span class="grow"><span class="t">' + esc(p.name) + '</span><span class="m">' + (p.role === 'owner' ? 'Owner' : 'Staff') + (p.you ? ' · you' : '') + '</span></span>' +
              (p.role !== 'owner' ? '<button class="btn small danger" type="button" data-remove="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Remove</button>' : '') + '</div>';
          }).join('') + '</div></section>';
        h += '<section class="section"><form id="evForm"><h2>Event details</h2><div class="mt16"></div>' + eventFields(ev) + '<div id="evErr"></div><button class="btn block" type="submit">Save event</button></form></section>';
      }
      h += '</div><div>';
      h += '<section class="section"><form id="meForm"><h2>You</h2><div class="mt16"></div>' +
        '<label class="field"><span>Your name, as the team sees it</span><input class="input" name="name" maxlength="30" value="' + esc(me.name) + '"></label>' +
        '<label class="field"><span>Email sign-off</span><input class="input" name="signoff" maxlength="80" placeholder="e.g. Maya Okafor · Brightline Coffee" value="' + esc(me.signoff) + '"></label>' +
        '<label class="field"><span>Your voice for drafted follow-ups</span><select class="input" name="tone">' + R.TONES.map(function (t) { return '<option value="' + t.key + '"' + (me.tone === t.key ? ' selected' : '') + '>' + esc(t.label) + '</option>'; }).join('') + '</select></label>' +
        '<div id="meErr"></div><button class="btn block" type="submit">Save</button></form></section>';
      if (ev.owner) {
        h += '<section class="section"><h2>Scorecard & data</h2><p class="small muted mt8">Share a numbers-only scorecard, or take every lead to your CRM.</p><div class="btn-row mt16"><a class="btn ghost" href="' + ctx.base + '/score">Scorecard</a><a class="btn ghost" href="' + BASE + 'api/events/' + enc(ctx.key) + '/export.csv" download>Export CSV</a></div>' +
          '<p class="hint">The CSV holds every lead’s contact details, so keep it somewhere safe. Cells that a spreadsheet would run as a formula are kept as text.</p></section>' +
          '<section class="section"><h2>Delete the event</h2><p class="small muted mt8">Deletes every lead, the team, the code and the share link. It cannot be undone. Export first.</p><button class="btn danger block mt16" id="delEv" type="button">Delete ' + esc(ev.name) + '</button></section>';
      } else {
        h += '<section class="section"><h2>Leave the team</h2><p class="small muted mt8">The leads you captured stay with the team. They’re the booth’s pipeline.</p><button class="btn danger block mt16" id="leave" type="button">Leave ' + esc(ev.name) + '</button></section>';
      }
      h += '</div></div>';
      view.innerHTML = h;
      var root = 'api/events/' + enc(ctx.key);
      $('#meForm').onsubmit = function (e) {
        e.preventDefault();
        var f = e.target;
        api('PUT', root + '/me', { name: f.name.value, signoff: f.signoff.value, tone: f.tone.value }).then(function () { toast('Saved.'); }).catch(function (err) { showError(err, $('#meErr')); });
      };
      if (ev.owner) {
        $('#copyInvite').onclick = function () { copy(invite, 'Invite copied. Send it to the team.'); };
        $('#copyCode').onclick = function () { copy(ev.code, 'Code copied'); };
        $('#resetCode').onclick = function () {
          if (!confirm('Make a new code? The old one stops working right away.')) return;
          api('POST', root + '/code').then(function () { toast('New code made.'); renderSettings(ctx); }).catch(function (e) { showError(e); });
        };
        $$('[data-remove]').forEach(function (b) {
          b.onclick = function () {
            if (!confirm('Remove ' + b.dataset.name + ' from the team? Their leads stay.')) return;
            api('DELETE', root + '/members/' + enc(b.dataset.remove)).then(function () { toast('Removed.'); renderSettings(ctx); }).catch(function (e) { showError(e); });
          };
        });
        $('#evForm').onsubmit = function (e) {
          e.preventDefault();
          api('PUT', root, readEventFields(e.target)).then(function () { toast('Saved.'); loadMe(); }).catch(function (err) { showError(err, $('#evErr')); });
        };
        $('#delEv').onclick = function () {
          if (prompt('Type DELETE to delete ' + ev.name + ' and every lead in it.') !== 'DELETE') return;
          api('DELETE', root).then(function () { setCur(null); toast('Deleted.'); location.hash = '#/'; }).catch(function (e) { showError(e); });
        };
      } else {
        $('#leave').onclick = function () {
          if (!confirm('Leave ' + ev.name + '?')) return;
          api('DELETE', root + '/members/me').then(function () { setCur(null); toast('You left the team.'); location.hash = '#/'; }).catch(function (e) { showError(e); });
        };
      }
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
