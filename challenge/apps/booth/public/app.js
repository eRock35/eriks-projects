/* Booth - the page. One file, no build step, every typed or model-written string escaped. */
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

  var state = { me: null, demo: null, cur: recall(EV_KEY), skew: 0, ctxKey: null, timers: [], drafts: {} };

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

  function confetti() {
    if (reducedMotion()) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var colors = ['#d8364a', '#f7f5f2', '#f2a900', '#2f95dd', '#5ee0a0'];
    for (var i = 0; i < 80; i++) {
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

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  };

  // One tooltip for every chart mark that carries data-tip.
  var tipEl = null;
  document.addEventListener('pointerover', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { if (tipEl) { tipEl.remove(); tipEl = null; } return; }
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.setAttribute('aria-hidden', 'true'); document.body.appendChild(tipEl); }
    tipEl.textContent = t.getAttribute('data-tip');
  });
  document.addEventListener('pointermove', function (e) {
    if (!tipEl) return;
    tipEl.style.left = Math.min(window.innerWidth - tipEl.offsetWidth - 8, e.clientX + 12) + 'px';
    tipEl.style.top = (e.clientY - tipEl.offsetHeight - 10) + 'px';
  });

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
      el.innerHTML = '<button class="btn small" id="signInTop">Sign in</button>';
      $('#signInTop').onclick = function () { openAccount(); };
      return;
    }
    var b = me.budget || {};
    var cur = (me.events || []).filter(function (e) { return e.id === state.cur; })[0];
    el.innerHTML = (cur ? '<a class="pill ev" href="#/e/' + enc(cur.id) + '" title="Current event">🎪 ' + esc(cur.name) + '</a>' : '') +
      '<span class="pill credit" title="AI credit">' + (b.unlimited ? '∞' : '$' + Number(b.remainingUsd || 0).toFixed(2)) + '</span>' +
      '<button class="avatar-btn" id="acctBtn" aria-label="Account">' + esc(initials(me.email)) + '</button>';
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

  function openAccount(reason) {
    if (signedIn()) return openProfileSheet();
    var mode = 'register';
    function draw(root) {
      root.innerHTML = '<div class="grab"></div>' +
        '<h2>' + (mode === 'register' ? 'Start your booth — free.' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || (mode === 'register'
          ? 'Capturing leads, the cold clocks, templates, the leaderboard, the scorecard and the CSV are free forever. You also get $2 of AI credit for card reading and drafted follow-ups — about a cent each. One account works across every app on this site.'
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
      '<div class="stackbar" style="height:10px;margin-top:10px;background:var(--track)"><i style="width:' + pct + '%;background:var(--good)"></i></div>' +
      '<p class="small muted" style="margin:10px 0 0">Reading a card or badge costs about a cent; so does a drafted follow-up. Capturing, the clocks, templates, the leaderboard, the scorecard and the CSV are free.</p>' +
      '<div id="billing" style="margin-top:12px"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" style="margin-top:10px">Sign out</button>',
      function (root) {
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; setCur(null); location.hash = '#/'; route(); });
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
      '<p class="muted small">Everything else keeps working: capturing leads, the cold clocks, the free templates, the leaderboard, the scorecard and the CSV export cost nothing.</p><div id="billing"></div>',
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
    if (PUB) return renderShared(PUB[1]);
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return ''; } });
    var tab = tabFor(parts);
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
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

  function loading() { view.innerHTML = '<div class="loading"><span class="spinner" aria-label="Loading"></span></div>'; }
  function backLink(href, label) { return '<a class="back" href="' + href + '">' + ICON.back + esc(label) + '</a>'; }
  function sampleBar(what) {
    return '<div class="sample-bar"><span><b>SAMPLE</b> · ' + esc(what || 'A made-up coffee roaster at a made-up expo — real rules, no AI used.') + '</span>' +
      (signedIn() ? '<a class="btn small" href="#/new">Start your event</a>' : '<button class="btn small" data-signup>Start free</button>') + '</div>';
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
          board: d.leaderboard, score: d.scorecard, goingCold: d.goingCold, drafts: d.drafts, reps: d.reps,
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
        view.innerHTML = '<div class="empty"><div class="e">🔍</div><h2>No such event</h2><p>It may have been deleted, or you were removed from its team.</p><a class="btn" href="#/">Your events</a></div>';
        return;
      }
      showError(e, view);
    });
  }

  function eventHead(ctx, title, sub) {
    var ev = ctx.event;
    return (ctx.demo ? sampleBar() : '') +
      '<div class="page-head"><div style="min-width:0"><div class="eyebrow">' + esc(ev.name) + '</div><h1>' + esc(title) + '</h1>' +
      '<div class="sub">' + esc(sub || [fmtRange(ev.startDate, ev.endDate), ev.place].filter(Boolean).join(' · ')) + '</div></div>' +
      (ctx.demo ? '' : '<a class="btn small ghost" href="' + ctx.base + '/settings" aria-label="Event settings">⚙︎ ' + (ev.owner ? 'Team' : 'You') + '</a>') + '</div>';
  }

  /* ---------------- clocks ---------------- */

  function clockShort(l, c) {
    if (c.state === 'closed') return l.wonAt ? '🏆 Won' : '🪦 Lost';
    if (c.state === 'done') return l.wonAt ? '🏆 Won' : (c.onTime ? '✓ Followed up' : '✓ Followed up late');
    if (c.state === 'cold') return '🧊 Went cold';
    if (c.state === 'cooling') return '⏳ ' + R.duration(c.leftMs) + ' left';
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
        el.className = el.className.replace(/\b(fresh|cooling|cold|done|closed)\b/g, '').trim() + ' ' + c.state;
        var label = $('.lbl', el);
        if (label) label.textContent = el.dataset.long ? R.clockLabel(c) : clockShort(l, c);
        var bar = $('.bar i', el.closest('.crow') || el);
        if (bar) bar.style.width = Math.round(c.pct * 100) + '%';
      });
    });
  }

  function leadName(l) { return l.name || l.company || l.email || l.phone || 'Unnamed lead'; }

  function leadRow(l, base) {
    var c = R.clock(l, now());
    var t = R.tempInfo(l.temp);
    var sub = [l.name ? l.company : '', l.title].filter(Boolean).join(' · ');
    return '<a class="lrow" href="' + base + '/lead/' + enc(l.id) + '">' +
      '<span class="te ' + esc(l.temp) + '" role="img" aria-label="' + esc(t.label) + '">' + t.emoji + '</span>' +
      '<span style="min-width:0"><span class="t" style="display:block">' + esc(leadName(l)) + '</span>' +
      '<span class="m" style="display:block">' + esc(sub ? sub + ' · ' : '') + 'by ' + esc(l.capturedByName) + '</span></span>' +
      '<span class="ck ' + c.state + '" data-ck="' + esc(l.id) + '"><span class="lbl">' + esc(clockShort(l, c)) + '</span>' +
      '<span class="status">' + esc(statusLine(l, c)) + '</span></span></a>';
  }

  /** The second line of a row: what the clock line does not already say. */
  function statusLine(l, c) {
    if (l.wonAt) return l.value ? R.money(l.value) : 'Won';
    if (l.lostAt) return c.state === 'closed' ? '' : 'Lost';
    if (l.status === 'sent') return l.value ? R.money(l.value) + ' pipeline' : '';
    if (l.status === 'new') return 'captured ' + ago(l.capturedAt);
    return R.statusInfo(l.status).label;
  }

  function coldRow(r, base) {
    var l = r.lead || r;
    var c = R.clock(l, now());
    var t = R.tempInfo(l.temp);
    return '<a class="crow ' + c.state + '" href="' + base + '/lead/' + enc(l.id) + '">' +
      '<span class="te ' + esc(l.temp) + '" role="img" aria-label="' + esc(t.label) + '" style="width:38px;height:38px;border-radius:12px;display:grid;place-items:center;font-size:19px">' + t.emoji + '</span>' +
      '<span style="min-width:0"><span class="t" style="display:block">' + esc(leadName(l)) + '</span>' +
      '<span class="m">' + esc((l.name && l.company ? l.company + ' · ' : '') + 'by ' + (l.capturedByName || '')) + '</span>' +
      '<span class="bar" aria-hidden="true"><i style="width:' + Math.round(c.pct * 100) + '%"></i></span></span>' +
      '<span class="ck ' + c.state + (c.state === 'cooling' ? ' pulse' : '') + '" data-ck="' + esc(l.id) + '"><span class="lbl">' + esc(c.state === 'cold' ? 'Went cold' : R.duration(c.leftMs)) + '</span>' +
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
        '<section class="hero"><div class="hero-grid"><div>' +
        '<span class="kicker">🎪 Free for your whole booth team</span>' +
        '<h1>Trade-show leads that <em>don’t go cold.</em></h1>' +
        '<p>For small teams who work trade shows, conferences, farmers’ markets and pop-ups. Capture a lead in ten seconds, and every one gets a follow-up clock — hot leads go cold in 48 hours. Then see whether the booth paid off.</p>' +
        '<div class="ctas"><button class="btn lg" data-signup>Start free</button><a class="btn lg ghost" href="#/sample">Walk the sample show</a></div>' +
        '<div class="trust"><span>✓ Capture, clocks & scorecard free forever</span><span>✓ Card photos read once, never kept</span><span>✓ Join with a code, no setup</span></div>' +
        '</div><div class="stack">' +
        '<div class="card"><div class="card-head"><h3>🧊 Going cold right now</h3><span class="sub">Sample</span></div><div class="cold-list">' +
        cold.map(function (g) { return coldRow(Object.assign({}, d.leads.filter(function (l) { return l.id === g.id; })[0]), '#/sample'); }).join('') + '</div></div>' +
        '<a class="card" href="#/sample/score" style="display:block;text-decoration:none;color:inherit"><div class="eyebrow">Sample scorecard</div><div class="row wrap-row" style="margin-top:8px;align-items:baseline;gap:4px 12px"><b style="font-size:34px;letter-spacing:-.04em;color:var(--good)" class="num">' + (sc.roi >= 0 ? '+' : '') + sc.roi + '%</b><span class="muted small">return on the booth · ' + esc(R.money(sc.wonValue)) + ' won on ' + esc(R.money(sc.boothCost)) + '</span></div></a>' +
        '</div></div></section>' +
        '<div class="steps">' +
        '<div class="step"><div class="ic">⚡</div><h3>Capture in ten seconds</h3><p>Type it or snap the card or badge. Tap 🔥 hot, 🌤 warm or 🧊 cold, tick what they asked about, pick the next step. Done.</p></div>' +
        '<div class="step"><div class="ic">⏳</div><h3>Beat the cold clock</h3><p>Every lead gets a timer. A free template per temperature, or a draft in your own voice — copy it or open it in your mail app.</p></div>' +
        '<div class="step"><div class="ic">🏆</div><h3>Know if it paid off</h3><p>A live leaderboard on the day, and a scorecard after: follow-up rate, meetings, pipeline and ROI against what the booth cost.</p></div>' +
        '</div>' +
        '<div class="card" style="margin-top:16px"><div class="row spread wrap-row"><div><b>Joining a teammate’s booth?</b><div class="small muted">They’ll give you an 8-character code.</div></div><a class="btn ghost" href="#/join">Enter a code</a></div></div>';
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
      var h = '<div class="page-head"><div><h1>Your events</h1><div class="sub">Each show is one shared lead list for its team.</div></div></div>';
      if (!evs.length) {
        h += '<div class="empty boxed"><div class="e">🎪</div><h2>No events yet</h2><p>Start one for your next show and share the code with the team — or join a teammate’s booth.</p>' +
          '<div class="btn-row" style="max-width:420px;margin:0 auto"><a class="btn" href="#/new">Start an event</a><a class="btn ghost" href="#/join">Join with a code</a></div>' +
          '<p style="margin-top:16px"><a href="#/sample">Or walk the sample show first →</a></p></div>';
      } else {
        h += '<div class="list">' + evs.map(function (e) {
          return '<a class="ecard" href="#/e/' + enc(e.id) + '"><span class="ic" aria-hidden="true">🎪</span><span style="min-width:0"><span class="t" style="display:block">' + esc(e.name) + '</span>' +
            '<span class="m" style="display:block">' + esc([fmtRange(e.startDate, e.endDate), e.place].filter(Boolean).join(' · ')) + '</span>' +
            '<span class="m" style="display:block">' + (e.role === 'owner' ? 'You run it' : 'Staff') + ' · ' + plural(e.members, 'person') .replace('persons', 'people') + '</span></span>' +
            '<span class="n"><b>' + e.leads + '</b><span>leads</span></span></a>';
        }).join('') + '</div>' +
          '<div class="btn-row" style="margin-top:14px"><a class="btn" href="#/new">Start an event</a><a class="btn ghost" href="#/join">Join with a code</a></div>';
      }
      view.innerHTML = h;
    }).catch(function (e) { showError(e, view); });
  }

  function renderNewEvent() {
    if (!signedIn()) {
      view.innerHTML = '<div class="empty"><div class="e">🎪</div><h2>Start your event</h2><p>Make a free account, then share a code with your booth team.</p><button class="btn" data-signup>Start free</button></div>';
      return wireSignup();
    }
    var today = new Date(now()).toISOString().slice(0, 10);
    view.innerHTML = backLink('#/', 'Your events') +
      '<div class="page-head"><div><h1>Start an event</h1><div class="sub">A trade show, a conference, a market day or a pop-up.</div></div></div>' +
      '<form class="card narrow" id="evForm">' + eventFields({ startDate: today, endDate: today, chips: R.DEFAULT_CHIPS }) +
      '<label class="field"><span>Your name, as the team sees it</span><input class="input" name="yourName" maxlength="30" value="' + esc(state.me.name || '') + '"></label>' +
      '<div id="evErr"></div><button class="btn block" type="submit">Create the event</button></form>';
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
      '<p class="hint" style="margin:-4px 2px 12px">What visitors ask about — the chips your team taps in the ten-second qualify.</p>';
  }
  function readEventFields(f) {
    return { name: f.name.value, startDate: f.startDate.value, endDate: f.endDate.value || f.startDate.value, place: f.place.value, boothCost: f.boothCost.value, chips: f.chips.value.split(',') };
  }

  function renderJoin(code) {
    view.innerHTML = backLink('#/', signedIn() ? 'Your events' : 'Home') +
      '<div class="page-head"><div><h1>Join a booth team</h1><div class="sub">Whoever runs the booth has an 8-character code in Booth → Team.</div></div></div>' +
      '<form class="card narrow" id="joinForm"><label class="field"><span>Code</span><input class="input codebox" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="11" placeholder="ABCD-EFGH" value="' + esc(R.formatCode(code)) + '" style="font-size:28px;letter-spacing:.12em"></label>' +
      '<label class="field"><span>Your name, as the team sees it</span><input class="input" name="name" maxlength="30" value="' + esc((state.me && state.me.name) || '') + '"></label>' +
      '<div id="joinErr"></div><button class="btn block lg" type="submit">' + (signedIn() ? 'Join the team' : 'Sign in to join') + '</button>' +
      '<p class="hint">A wrong code tells you nothing about any event, and after a few wrong tries it waits 15 minutes.</p></form>';
    var input = $('#joinForm').code;
    input.addEventListener('input', function () { var v = R.formatCode(input.value); if (v !== input.value && R.normalizeCode(input.value).length === 8) input.value = v; });
    $('#joinForm').onsubmit = function (e) {
      e.preventDefault();
      if (!signedIn()) return openAccount('Sign in or make a free account, then you’re on the team.');
      var btn = $('button[type=submit]', e.target); btn.disabled = true;
      api('POST', 'api/join', { code: e.target.code.value, name: e.target.name.value }).then(function (r) {
        setCur(r.id);
        return loadMe().then(function () { toast(r.already ? 'You’re already on this team.' : 'You’re on the team 🎪'); location.hash = '#/e/' + enc(r.id) + '/capture'; });
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
      h += '<div class="empty boxed"><div class="e">📇</div><h2>No leads yet</h2><p>Tap Capture when someone stops by. Ten seconds each — the clock starts when you save.</p><a class="btn" href="' + ctx.base + '/capture">Capture the first lead</a>' +
        (ctx.event.owner ? '<p class="small" style="margin-top:14px">Team code: <b>' + esc(ctx.event.code) + '</b> · <a href="' + ctx.base + '/settings">invite</a></p>' : '') + '</div>';
      view.innerHTML = h;
      return;
    }
    h += '<div class="dk-2"><div>';
    if (urgent.length) {
      h += '<div class="section-title" style="margin-top:0"><h2>🧊 Going cold</h2><span class="count">' + urgent.length + ' need a follow-up now</span></div>' +
        '<div class="cold-list">' + urgent.slice(0, 6).map(function (r) { return coldRow(r, ctx.base); }).join('') + '</div>' +
        (urgent.length > 6 ? '<p class="hint"><a href="' + ctx.base + '/score">All ' + urgent.length + ' on the scorecard →</a></p>' : '');
    } else {
      h += '<div class="banner good"><span class="e">🛡️</span><span>Nothing is about to go cold. ' + (cold.length ? 'Next up: ' + esc(leadName(cold[0].lead)) + ' in ' + esc(R.duration(cold[0].clock.leftMs)) + '.' : 'Every lead has a follow-up.') + '</span></div>';
    }
    h += '</div><div>';
    h += '<div class="section-title"' + (urgent.length ? '' : ' style="margin-top:14px"') + '><h2>All leads</h2><span class="count" id="nShown"></span></div>' +
      '<div class="search">' + ICON.search + '<input class="input" id="q" type="search" placeholder="Search name, company, note" aria-label="Search leads"></div>' +
      '<div class="chips scroll" role="group" aria-label="Filter" style="margin-bottom:12px">' +
      [['all', 'All'], ['hot', '🔥 Hot'], ['warm', '🌤 Warm'], ['cold', '🧊 Cold'], ['todo', '⏳ To follow up'], ['won', '🏆 Won']].map(function (f) {
        return '<button class="chip' + (filter === f[0] ? ' on' : '') + '" data-f="' + f[0] + '" aria-pressed="' + (filter === f[0]) + '">' + f[1] + '</button>';
      }).join('') + '</div><div class="list" id="leadList"></div></div></div>';
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
      $('#leadList').innerHTML = rows.length ? rows.map(function (l) { return leadRow(l, ctx.base); }).join('') : '<div class="empty boxed"><p>Nothing matches.</p></div>';
      $('#nShown').textContent = rows.length === leads.length ? '' : rows.length + ' of ' + leads.length;
    }
    $$('[data-f]').forEach(function (b) {
      b.onclick = function () {
        filter = state.filter = b.dataset.f;
        $$('[data-f]').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
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

  function qualifyHtml(f, chips) {
    return '<div class="label">How warm? <span class="count">the clock depends on it</span></div><div class="temps" role="radiogroup" aria-label="Temperature">' + R.TEMPS.map(function (t) {
      return '<button type="button" class="' + t.key + (f.temp === t.key ? ' on' : '') + '" data-temp="' + t.key + '" role="radio" aria-checked="' + (f.temp === t.key) + '"><span class="e" aria-hidden="true">' + t.emoji + '</span><b>' + t.label + '</b><span>' + esc(t.blurb) + '</span></button>';
    }).join('') + '</div>' +
      (chips.length ? '<div class="label">Interested in</div><div class="chips" role="group" aria-label="Interests">' + chips.map(function (c) {
        var on = f.chips.indexOf(c) >= 0;
        return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-chip="' + esc(c) + '" aria-pressed="' + on + '">' + esc(c) + '</button>';
      }).join('') + '</div>' : '') +
      '<div class="label">Next step</div><div class="seg" role="radiogroup" aria-label="Next step">' + R.NEXT_STEPS.map(function (n) {
        return '<button type="button" data-next="' + n.key + '" class="' + (f.next === n.key ? 'on' : '') + '" role="radio" aria-checked="' + (f.next === n.key) + '"><span class="e" aria-hidden="true">' + n.emoji + '</span>' + esc(n.label) + '</button>';
      }).join('') + '</div>' +
      '<div class="label">Note <span class="count" id="noteN">' + (f.note || '').length + '/' + R.LIMITS.note + '</span></div>' +
      '<textarea class="input" id="fNote" maxlength="' + R.LIMITS.note + '" rows="2" placeholder="What did they say? (only your team sees this)">' + esc(f.note) + '</textarea>';
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
        b.classList.toggle('on', i < 0); b.setAttribute('aria-pressed', String(i < 0));
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

  function contactFields(f) {
    return '<div class="grid2"><label class="field"><span>Name</span><input class="input" id="fName" autocomplete="off" maxlength="80" value="' + esc(f.name) + '"></label>' +
      '<label class="field"><span>Company</span><input class="input" id="fCompany" autocomplete="off" maxlength="80" value="' + esc(f.company) + '"></label></div>' +
      '<div class="grid2"><label class="field"><span>Email</span><input class="input" id="fEmail" type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="120" value="' + esc(f.email) + '"></label>' +
      '<label class="field"><span>Phone</span><input class="input" id="fPhone" type="tel" inputmode="tel" autocomplete="off" maxlength="30" value="' + esc(f.phone) + '"></label></div>' +
      '<label class="field"><span>Job title</span><input class="input" id="fTitle" autocomplete="off" maxlength="80" value="' + esc(f.title) + '"></label>';
  }
  function wireContact(root, f, onChange) {
    [['#fName', 'name'], ['#fCompany', 'company'], ['#fEmail', 'email'], ['#fPhone', 'phone'], ['#fTitle', 'title']].forEach(function (p) {
      var el = $(p[0], root);
      if (el) el.addEventListener('input', function () { f[p[1]] = el.value; el.classList.remove('bad'); onChange(); });
    });
  }
  function markBad(root, field) {
    var id = { name: '#fName', email: '#fEmail', phone: '#fPhone', value: '#fValue' }[field];
    var el = id && $(id, root);
    if (el) { el.classList.add('bad'); el.focus(); }
  }

  function renderCapture(ctx) {
    var f = emptyLead();
    var started = null;
    var last = state.lastSaved && state.lastSaved.ctx === ctx.key ? state.lastSaved : null;
    view.innerHTML = eventHead(ctx, 'Capture', 'Ten seconds: who, how warm, what next.') +
      '<div class="dk-2"><div>' +
      (ctx.demo
        ? '<div class="card snap-card" data-signup role="button" tabindex="0"><span class="ic" aria-hidden="true">📷</span><span class="grow"><b>Snap a card or badge</b><span>Reads it in seconds — sign up to use it. In the sample, type one in.</span></span></div>'
        : '<label class="card snap-card"><span class="ic" aria-hidden="true">📷</span><span class="grow"><b>Snap a card or badge</b><span>AI reads it once (about a cent) · the photo is never stored</span></span><input type="file" accept="image/*" capture="environment" id="snapIn"></label>') +
      '<div id="snapNote"></div>' +
      '<div class="or">or type it</div>' +
      '<div class="card" id="capForm">' + contactFields(f) + '</div></div>' +
      '<div><div class="card" id="qualify">' + qualifyHtml(f, ctx.event.chips || []) + '</div>' +
      '<div id="capErr"></div>' +
      (last ? '<p class="hint" id="lastSaved">Last saved: <a href="' + ctx.base + '/lead/' + enc(last.id) + '">' + esc(last.name) + '</a> ' + esc(R.tempInfo(last.temp).emoji) + '</p>' : '') +
      '<div class="capture-bar"><span class="stopwatch" id="watch" aria-live="off" title="Time to qualify">⏱ 0s</span><button class="btn" id="capSave">Save lead</button></div></div></div>';
    function onChange() {
      if (!started) {
        started = Date.now();
        every(250, function () {
          var s = Math.floor((Date.now() - started) / 1000);
          var w = $('#watch'); if (!w) return;
          w.textContent = '⏱ ' + s + 's';
          w.classList.toggle('fast', s <= 10);
        });
      }
    }
    wireContact($('#capForm'), f, onChange);
    wireQualify($('#qualify'), f, onChange);
    wireSignup();
    var snapIn = $('#snapIn');
    if (snapIn) snapIn.onchange = function (e) { var file = e.target.files && e.target.files[0]; e.target.value = ''; if (file) snap(ctx, file, f, onChange); };
    $('#capSave').onclick = function () { saveCapture(ctx, f, started, false); };
  }

  function resetCapture(ctx) { renderCapture(ctx); window.scrollTo(0, 0); }

  function saveCapture(ctx, f, started, force) {
    var err = $('#capErr');
    err.innerHTML = '';
    var r = R.validateLead(f, { chips: ctx.event.chips || [] });
    if (r.error) { err.innerHTML = '<div class="err" role="alert">' + esc(r.error) + '</div>'; markBad(view, r.field); return; }
    var secs = started ? Math.max(1, Math.round((Date.now() - started) / 1000)) : null;
    if (ctx.demo) {
      toast((secs ? 'Qualified in ' + secs + 's ' + (secs <= 10 ? '⚡ ' : '') + '— ' : '') + 'sample only, nothing saved. Start free to capture your own.', 4200);
      return resetCapture(ctx);
    }
    var btn = $('#capSave'); btn.disabled = true;
    var body = Object.assign({}, f, { force: force === true });
    api('POST', 'api/events/' + enc(ctx.key) + '/leads', body).then(function (res) {
      var l = res.lead;
      ctx.leads.unshift(l);
      state.lastSaved = { ctx: ctx.key, id: l.id, name: leadName(l), temp: l.temp };
      var mine = ctx.leads.filter(function (x) { return x.capturedBy === l.capturedBy; });
      var streak = R.hotStreak(mine).current;
      var msg = (secs ? (secs <= 10 ? '⚡ Qualified in ' + secs + 's. ' : 'Saved in ' + secs + 's. ') : 'Saved. ') +
        (l.temp === 'hot' ? (streak >= 2 ? '🔥 Hot streak: ' + streak + ' in a row!' : '🔥 Clock’s ticking: 48h.') : R.tempInfo(l.temp).emoji + ' Follow up within ' + R.tempInfo(l.temp).window + '.');
      toast(msg, 3400);
      if (l.temp === 'hot' && (streak === 3 || streak === 5 || streak === 10)) confetti();
      resetCapture(ctx);
    }).catch(function (e) {
      btn.disabled = false;
      if (e.status === 409 && e.data && e.data.duplicate) return dupSheet(ctx, f, e.data.duplicate, started);
      showError(e, err);
      if (e.data && e.data.field) markBad(view, e.data.field);
    });
  }

  function dupSheet(ctx, f, d, started) {
    var t = R.tempInfo(d.temp);
    sheet('<h2>Already on the list?</h2>' +
      '<p class="muted">Same ' + esc(d.by) + ' as <b>' + esc(d.name || d.company || 'a lead') + '</b>' + (d.company && d.name ? ' (' + esc(d.company) + ')' : '') + ' ' + t.emoji + ', captured by ' + esc(d.capturedByName || 'a teammate') + ' ' + esc(ago(d.capturedAt)) + '.</p>' +
      '<div class="stack" style="margin-top:14px"><button class="btn block" id="dMerge">Merge into their lead</button>' +
      '<button class="btn ghost block" id="dNew">Save as a separate lead</button><button class="btn plain block" id="dCancel">Cancel</button></div>' +
      '<p class="hint">Merging fills in what’s missing, adds the interests you ticked, keeps the hotter temperature and adds your note. Nothing they wrote is overwritten.</p><div id="dErr"></div>',
      function (root) {
        $('#dMerge', root).onclick = function () {
          this.disabled = true;
          api('POST', 'api/events/' + enc(ctx.key) + '/leads/' + enc(d.id) + '/merge', f).then(function () {
            closeSheet(); toast('Merged into ' + (d.name || d.company || 'their lead') + '.'); resetCapture(ctx);
          }).catch(function (e) { showError(e, $('#dErr', root)); });
        };
        $('#dNew', root).onclick = function () { closeSheet(); saveCapture(ctx, f, started, true); };
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

  function snap(ctx, file, f, onChange) {
    var note = $('#snapNote');
    note.innerHTML = '<div class="banner" style="margin-top:10px"><span class="spinner"></span><span>Reading the ' + (/badge/i.test(file.name) ? 'badge' : 'card') + '… the photo is dropped as soon as it’s read.</span></div>';
    onChange();
    shrink(file).then(function (image) {
      return api('POST', 'api/events/' + enc(ctx.key) + '/read', { image: image });
    }).then(function (c) {
      ['name', 'company', 'title', 'email', 'phone'].forEach(function (k) { if (c[k]) f[k] = c[k]; });
      f.source = c.kind;
      $('#capForm').innerHTML = contactFields(f);
      wireContact($('#capForm'), f, onChange);
      note.innerHTML = '<div class="banner good" style="margin-top:10px"><span class="e">✓</span><span>Read from the ' + esc(c.kind) + '. Check it, then qualify.' +
        (c.dropped && c.dropped.length ? ' Left out: ' + esc(c.dropped.join(' and ')) + ' (didn’t look right — type it in).' : '') + '</span></div>';
    }).catch(function (e) { note.innerHTML = ''; showError(e, note); });
  }

  /* ---------------- one lead ---------------- */

  function ring(c) {
    var pctv = c.state === 'done' || c.state === 'closed' ? 1 : c.pct;
    var color = c.state === 'cold' ? 'var(--m-hot)' : c.state === 'cooling' ? 'var(--m-warm)' : c.state === 'fresh' ? 'var(--m-cold)' : 'var(--good)';
    var e = c.state === 'cold' ? '🧊' : c.state === 'done' ? '✓' : c.state === 'closed' ? '🔒' : '⏳';
    return '<div class="ring" aria-hidden="true"><svg viewBox="0 0 36 36"><circle class="trk" cx="18" cy="18" r="15.9" fill="none" stroke-width="3.4"/>' +
      '<circle class="val" cx="18" cy="18" r="15.9" fill="none" stroke-width="3.4" stroke-linecap="round" stroke="' + color + '" stroke-dasharray="100 100" stroke-dashoffset="' + (100 - Math.round(pctv * 100)) + '"/></svg><span class="e">' + e + '</span></div>';
  }

  function renderLead(ctx, id) {
    var l = ctx.leads.filter(function (x) { return x.id === id; })[0];
    if (!l) { view.innerHTML = backLink(ctx.base, 'Leads') + '<div class="empty"><div class="e">🔍</div><h2>No such lead</h2><p>It may have been deleted or merged.</p></div>'; return; }
    var t = R.tempInfo(l.temp);
    var c = R.clock(l, now());
    var f = { temp: l.temp, chips: (l.chips || []).slice(), next: l.next || '', note: l.note || '' };
    var src = { typed: 'typed in', card: 'from a business card', badge: 'from a badge' }[l.source] || 'typed in';
    var h = (ctx.demo ? sampleBar() : '') + backLink(ctx.base, 'Leads') +
      '<div class="dk-2"><div class="stack">' +
      '<div class="card lead-head"><span class="te ' + esc(l.temp) + '" role="img" aria-label="' + esc(t.label) + ' lead">' + t.emoji + '</span><div style="min-width:0"><h1>' + esc(leadName(l)) + '</h1>' +
      '<div class="m">' + esc([l.title, l.name ? l.company : ''].filter(Boolean).join(' at ')) + '</div>' +
      '<div class="m small">Captured by ' + esc(l.capturedByName) + ' · ' + esc(ago(l.capturedAt)) + ' · ' + esc(src) + (l.mergedCount ? ' · merged ' + plural(l.mergedCount, 'time') : '') + '</div></div></div>' +
      '<div class="card clock-card" data-ck="' + esc(l.id) + '" data-long="1">' + ring(c) + '<div><b class="lbl">' + esc(R.clockLabel(c)) + '</b><span class="muted small">' +
      esc(c.state === 'cold' ? 'Late still beats never — send it today.' : c.state === 'done' ? (l.wonAt ? 'Won. Nice work.' : 'Log the reply when it lands.') : c.state === 'closed' ? 'This lead is closed.' : t.label + ' leads go cold after ' + t.window + ' without a follow-up.') + '</span></div></div>' +
      '<div class="card"><div class="card-head"><h3>Contact</h3>' + (ctx.demo ? '' : '<button class="btn small ghost" id="editC">Edit</button>') + '</div><div class="contact">' +
      (l.email ? '<div class="crow2"><span class="k">Email</span><a class="grow" href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a><button class="btn small ghost" data-copy="' + esc(l.email) + '">Copy</button></div>' : '') +
      (l.phone ? '<div class="crow2"><span class="k">Phone</span><a class="grow" href="tel:' + esc(l.phone.replace(/[^\d+]/g, '')) + '">' + esc(l.phone) + '</a><button class="btn small ghost" data-copy="' + esc(l.phone) + '">Copy</button></div>' : '') +
      (!l.email && !l.phone ? '<p class="muted small" style="margin:0">No email or phone captured.' + (ctx.demo ? '' : ' Add one so you can follow up.') + '</p>' : '') +
      '</div></div>' +
      '<div class="card" id="qualify"><div class="card-head"><h3>Qualify</h3><button class="btn small hidden" id="saveQ">Save changes</button></div>' + qualifyHtml(f, ctx.event.chips || []) + '<div id="qErr"></div></div>' +
      '</div><div class="stack dk-sticky">' +
      '<div class="card" id="follow"></div>' +
      '<div class="card"><div class="card-head"><h3>What happened</h3><span class="sub">' + esc(R.statusInfo(l.status).label) + '</span></div>' +
      '<div class="ladder" role="group" aria-label="Status">' + R.STATUSES.map(function (s) {
        var on = l.status === s.key;
        var past = !on && s.stamp && l[s.stamp];
        return '<button data-st="' + s.key + '" class="' + (on ? 'on' : past ? 'past' : '') + '" aria-pressed="' + on + '"><span class="e" aria-hidden="true">' + s.emoji + '</span>' + esc(s.key === 'new' ? 'Not yet' : s.key === 'booked' ? 'Meeting' : s.label) + '</button>';
      }).join('') + '</div>' +
      '<div class="row" style="margin-top:12px;align-items:flex-end"><label class="field grow" style="margin:0"><span>Deal value ($) — ' + (l.wonAt ? 'won' : 'estimated, counts toward pipeline') + '</span><input class="input" id="fValue" inputmode="decimal" placeholder="e.g. 2400" value="' + esc(l.value == null ? '' : l.value) + '"' + (ctx.demo ? ' readonly' : '') + '></label>' +
      (ctx.demo ? '' : '<button class="btn small ghost" id="saveV" style="min-height:46px">Save</button>') + '</div><div id="stErr"></div></div>' +
      (!ctx.demo && l.canDelete ? '<button class="btn danger block" id="delLead">Delete this lead</button>' : '') +
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
        if (ctx.demo) return toast('Sample only — start free to track your own.');
        var st = b.dataset.st;
        var body = { status: st };
        if (st === 'won') {
          var v = $('#fValue').value.trim();
          if (!v) { var p = prompt('Nice! What is the deal worth, in dollars?', ''); if (p === null) return; body.value = p; } else body.value = v;
        }
        api('POST', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id) + '/status', body).then(function (r) {
          replaceLead(ctx, r.lead);
          if (st === 'won') { confetti(); toast('🏆 Won! It counts on the scorecard.'); } else toast(R.statusInfo(st).emoji + ' ' + R.statusInfo(st).label);
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
      api('DELETE', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id)).then(function () { toast('Deleted.'); location.hash = ctx.base; }).catch(function (e) { showError(e); });
    };
    drawFollow(ctx, l);
  }

  function replaceLead(ctx, l) {
    for (var i = 0; i < ctx.leads.length; i++) if (ctx.leads[i].id === l.id) ctx.leads[i] = l;
  }

  function editContact(ctx, l) {
    var f = { name: l.name, company: l.company, title: l.title, email: l.email, phone: l.phone };
    sheet('<h2>Contact details</h2><div id="ecForm">' + contactFields(f) + '</div><div id="ecErr"></div><button class="btn block" id="ecSave">Save</button>', function (root) {
      wireContact(root, f, function () {});
      $('#ecSave', root).onclick = function (ev, force) {
        var btn = this; btn.disabled = true;
        api('PUT', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id), Object.assign({}, f, { force: force === true })).then(function (r) {
          replaceLead(ctx, r.lead); closeSheet(); toast('Saved.'); renderLead(ctx, l.id);
        }).catch(function (e) {
          btn.disabled = false;
          if (e.status === 409 && e.data && e.data.duplicate) {
            $('#ecErr', root).innerHTML = '<div class="err" role="alert">' + esc(e.message) + ' <button class="link-btn" id="ecForce">Save anyway</button></div>';
            $('#ecForce', root).onclick = function () { $('#ecSave', root).onclick.call($('#ecSave', root), null, true); };
            return;
          }
          showError(e, $('#ecErr', root));
          if (e.data && e.data.field) markBad(root, e.data.field);
        });
      };
    });
  }

  /** The follow-up card: a free template, or a draft in the rep's voice. */
  function drawFollow(ctx, l) {
    var el = $('#follow');
    var mode = state.drafts[l.id] || (ctx.demo && ctx.drafts[l.id]) ? 'draft' : 'template';
    var rep = ctx.demo ? (ctx.reps[l.capturedBy] || ctx.me) : ctx.me;
    function current() {
      if (mode === 'draft') return state.drafts[l.id] || (ctx.demo && ctx.drafts[l.id]) || null;
      return R.template(l, ctx.event, rep);
    }
    function draw() {
      var d = current();
      var h = '<div class="card-head"><h3>Follow-up</h3><span class="sub">' + esc(R.tempInfo(l.temp).emoji + ' ' + R.tempInfo(l.temp).label) + '</span></div>' +
        '<div class="tabs2" role="tablist"><button role="tab" data-mode="template" class="' + (mode === 'template' ? 'on' : '') + '" aria-selected="' + (mode === 'template') + '">Template · free</button>' +
        '<button role="tab" data-mode="draft" class="' + (mode === 'draft' ? 'on' : '') + '" aria-selected="' + (mode === 'draft') + '">✨ In my voice</button></div>';
      if (mode === 'draft' && !d) {
        h += '<p class="muted small" style="margin-top:0">A short email that sounds like you, from what was captured — the show, their interests, the next step and your note. It never adds a price, a date, a link or an attachment nobody mentioned; where it needs one it leaves <b>[add: …]</b> for you.</p>' +
          (ctx.demo ? '<button class="btn block" data-signup>Start free to draft yours</button>' : '<button class="btn block" id="goDraft">✨ Draft it <span class="cost">about 1¢</span></button>') + '<div id="dErr"></div>';
      } else {
        h += (mode === 'draft' && d.rep ? '<p class="hint" style="margin:0 0 8px">Drafted for ' + esc(d.rep) + ' — sample.</p>' : '') +
          '<label class="field"><span>Subject</span><input class="input" id="mSubj" maxlength="120" value="' + esc(d.subject) + '"></label>' +
          '<label class="field"><span>Message</span><textarea class="input" id="mBody" rows="9" maxlength="2000">' + esc(d.body) + '</textarea></label>';
        if (mode === 'draft' && d.gaps && d.gaps.length) h += '<div class="label" style="margin-top:4px">Fill these in</div><div class="tags gaps">' + d.gaps.map(function (g) { return '<span class="tag">[add: ' + esc(g) + ']</span>'; }).join('') + '</div>';
        if (mode === 'draft' && d.removed && d.removed.length) {
          h += '<details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">Taken out: ' + plural(d.removed.length, 'thing') + ' nobody captured</summary><ul class="removed">' +
            d.removed.map(function (r) { return '<li><b>' + esc(r.what) + '</b> · ' + esc(r.detail ? 'a detail nobody captured' : '“' + r.text + '”') + '</li>'; }).join('') + '</ul></details>';
        }
        h += '<div class="btn-row" style="margin-top:12px"><button class="btn ghost" id="mCopy">Copy</button>' +
          (l.email ? '<a class="btn ghost" id="mMail" href="#">Open in email</a>' : '') +
          (l.sentAt || ctx.demo ? '' : '<button class="btn" id="mSent">Mark as sent</button>') + '</div>' +
          (mode === 'draft' && !ctx.demo ? '<button class="btn plain small" id="reDraft" style="margin-top:6px">Draft again · about 1¢</button>' : '') +
          '<p class="nomail">Booth doesn’t send email — there’s no mail service here. Copy it, or open it in your own mail app, then mark it sent so the clock stops.</p>';
      }
      el.innerHTML = h;
      wireSignup(el);
      $$('[data-mode]', el).forEach(function (b) { b.onclick = function () { mode = b.dataset.mode; draw(); }; });
      var subj = $('#mSubj', el), body = $('#mBody', el), mail = $('#mMail', el);
      function syncMail() { if (mail) mail.href = R.mailto(l.email, subj.value, body.value) || '#'; }
      if (subj) { subj.oninput = syncMail; body.oninput = syncMail; syncMail(); }
      var cp = $('#mCopy', el); if (cp) cp.onclick = function () { copy('Subject: ' + subj.value + '\n\n' + body.value, 'Copied — paste it into your email'); };
      var sent = $('#mSent', el); if (sent) sent.onclick = function () {
        api('POST', 'api/events/' + enc(ctx.key) + '/leads/' + enc(l.id) + '/status', { status: 'sent' }).then(function (r) {
          replaceLead(ctx, r.lead);
          var c = R.clock(r.lead, now());
          toast(c.onTime ? (c.tookMs <= R.HOUR ? '⚡ Quick draw — followed up in ' + R.duration(c.tookMs) + '.' : '📤 Followed up in time. Clock stopped.') : '📤 Followed up. Late still beats never.', 3200);
          renderLead(ctx, l.id);
        }).catch(function (e) { showError(e); });
      };
      var go = $('#goDraft', el) || $('#reDraft', el);
      if (go) go.onclick = function () {
        go.disabled = true; go.innerHTML = '<span class="spinner"></span> Writing in your voice…';
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
      var medals = ['🥇', '🥈', '🥉'];
      var h = eventHead(ctx, 'Leaderboard', 'Points for capturing, hot leads and follow-ups that beat the clock.');
      if (rows.length >= 2) {
        var order = rows.length >= 3 ? [1, 0, 2] : [1, 0];
        h += '<div class="podium" style="grid-template-columns:repeat(' + order.length + ',minmax(0,1fr))">' + order.map(function (i) {
          var x = rows[i];
          return '<div class="pod p' + (i + 1) + '"><div class="medal" aria-hidden="true">' + medals[i] + '</div><div class="nm">' + esc(x.name) + (x.you ? ' (you)' : '') + '</div><div class="pts num">' + x.points + ' <small>pts</small></div>' +
            (x.streak >= 2 ? '<div class="small t-hot">🔥 ×' + x.streak + ' streak</div>' : '<div class="small muted">' + plural(x.captured, 'lead') + '</div>') + '</div>';
        }).join('') + '</div>';
      }
      h += '<div class="card" style="padding:4px 0">' + rows.map(function (x) {
        return '<div class="brow' + (x.you ? ' you' : '') + '"><span class="rk">' + x.rank + '</span><div style="min-width:0"><div class="nm">' + esc(x.name) + (x.you ? ' <span class="tag">you</span>' : '') + (x.role === 'owner' ? ' <span class="tag">runs it</span>' : '') + '</div>' +
          '<div class="st"><span title="Leads captured">📇 ' + x.captured + '</span><span title="Hot leads">🔥 ' + x.hot + '</span><span title="Followed up before the clock ran out">⏱ ' + x.onTime + ' on time</span>' +
          (x.meetings ? '<span title="Meetings booked">📅 ' + x.meetings + '</span>' : '') + (x.won ? '<span title="Won">🏆 ' + x.won + '</span>' : '') +
          (x.wentCold ? '<span title="Their leads that went cold">🧊 ' + x.wentCold + ' cold</span>' : '') + (x.streak >= 2 ? '<span class="t-hot">🔥×' + x.streak + ' streak</span>' : '') + '</div>' +
          (x.badges.length ? '<div class="badges">' + x.badges.map(function (k) { var b = R.badgeInfo(k); return '<span role="img" title="' + esc(b.label + ': ' + b.detail) + '" aria-label="' + esc(b.label) + '">' + b.emoji + '</span>'; }).join('') + '</div>' : '') +
          '</div><div class="pts">' + x.points + '<small>points</small></div></div>';
      }).join('') + '</div>';
      h += '<div class="section-title"><h2>How points work</h2></div><div class="card small muted"><div class="tags">' +
        [['📇 A lead', R.POINTS.lead], ['🔥 It’s hot', R.POINTS.hot], ['⏱ Followed up in time', R.POINTS.onTime], ['📤 Followed up late', R.POINTS.late], ['💬 A reply', R.POINTS.reply], ['📅 A meeting', R.POINTS.meeting], ['🏆 A win', R.POINTS.won]].map(function (p) {
          return '<span class="tag">' + esc(p[0]) + ' +' + p[1] + '</span>';
        }).join('') + '</div><div class="label" style="margin-top:14px">Badges</div><div class="tags">' + R.BADGES.map(function (b) { return '<span class="tag" title="' + esc(b.detail) + '">' + b.emoji + ' ' + esc(b.label) + '</span>'; }).join('') + '</div>' +
        '<p style="margin:12px 0 0">Everyone on the team sees names and counts here. Lead details are on the Leads tab — it’s the team’s pipeline.</p></div>';
      view.innerHTML = h;
      wireSignup();
    }).catch(function (e) { showError(e, view); });
  }

  /* ---------------- scorecard ---------------- */

  function hbar(label, v, max, cls, text, tip) {
    // The longest bar takes 68% of the track, so every value label sits just
    // past its bar, in text ink - never white on a light mark.
    var w = max > 0 ? Math.max(v > 0 ? 1.5 : 0, v / max * 68) : 0;
    return '<div class="hbar"><span class="lab">' + esc(label) + '</span><div class="tr" data-tip="' + esc(tip || label + ': ' + text) + '" role="img" aria-label="' + esc(label + ': ' + text) + '">' +
      '<i class="' + cls + '" style="width:' + w.toFixed(1) + '%"></i><span class="v" style="left:calc(' + w.toFixed(1) + '% + 8px)">' + esc(text) + '</span></div></div>';
  }

  /** The scorecard body - used by the team's own view and by the public card,
   *  whose fields are the same aggregates by name. */
  function scoreBody(sc) {
    var h = '';
    var v = sc.verdict || {};
    h += '<div class="banner ' + (v.key === 'paid' ? 'good' : v.key === 'cold' ? 'cold' : v.key === 'pipeline' ? 'warn' : '') + '"><span class="e" aria-hidden="true">' + esc(v.emoji || '🎪') + '</span><span>' + esc(v.text || '') + '</span></div>';
    var maxMoney = Math.max(sc.boothCost || 0, sc.wonValue || 0, sc.pipelineValue || 0);
    h += '<div class="card roi" style="margin-top:12px"><div><div class="eyebrow">Return on the booth</div><div class="big">' +
      (sc.roi == null ? '<b class="muted">—</b><span class="muted small">add the booth cost to see ROI</span>' : '<b class="num ' + (sc.roi >= 0 ? 'good' : 'bad') + '">' + (sc.roi > 0 ? '+' : '') + sc.roi + '%</b><span class="muted small">' + esc(R.money(sc.wonValue)) + ' won on ' + esc(R.money(sc.boothCost)) + '</span>') + '</div></div>' +
      '<div class="hbars">' + hbar('Booth cost', sc.boothCost || 0, maxMoney, 'i-cost', R.money(sc.boothCost || 0)) + hbar('Won', sc.wonValue || 0, maxMoney, 'i-won', R.money(sc.wonValue || 0), 'Won: ' + R.money(sc.wonValue || 0) + ' from ' + plural(sc.won, 'deal')) +
      hbar('Pipeline', sc.pipelineValue || 0, maxMoney, 'i-pipe', R.money(sc.pipelineValue || 0), 'Open pipeline: ' + R.money(sc.pipelineValue || 0) + ' in estimated deal values') + '</div>' +
      '<div class="row wrap-row small muted" style="gap:6px 18px"><span>Cost per lead <b class="num" style="color:var(--text)">' + (sc.costPerLead == null ? '—' : esc(R.money(sc.costPerLead))) + '</b></span><span>Cost per meeting <b class="num" style="color:var(--text)">' + (sc.costPerMeeting == null ? '—' : esc(R.money(sc.costPerMeeting))) + '</b></span>' +
      (sc.coverage != null ? '<span>Pipeline + won covers the booth <b class="num" style="color:var(--text)">' + sc.coverage + '×</b></span>' : '') + '</div></div>';
    h += '<div class="kpis" style="margin-top:12px">' +
      '<div class="kpi"><b>' + sc.leads + '</b><span>Leads captured</span></div>' +
      '<div class="kpi"><b>' + (sc.temps.hot || 0) + '</b><span>🔥 Hot leads</span></div>' +
      '<div class="kpi"><b>' + sc.within48Rate + '%</b><span>Followed up within 48h</span></div>' +
      '<div class="kpi"><b>' + sc.replies + '</b><span>Replies' + (sc.followedUp ? ' (' + sc.replyRate + '%)' : '') + '</span></div>' +
      '<div class="kpi"><b>' + sc.meetings + '</b><span>Meetings booked</span></div>' +
      '<div class="kpi"><b>' + esc(R.money(sc.wonValue)) + '</b><span>Won (' + sc.won + ')</span></div></div>';
    var tot = sc.leads || 1;
    h += '<div class="card" style="margin-top:12px"><div class="card-head"><h3>Leads by temperature</h3><span class="sub">' + plural(sc.leads, 'lead') + '</span></div>' +
      '<div class="stackbar" role="img" aria-label="' + esc(R.TEMPS.map(function (t) { return (sc.temps[t.key] || 0) + ' ' + t.label.toLowerCase(); }).join(', ')) + '">' +
      R.TEMPS.map(function (t) { var n = sc.temps[t.key] || 0; return n ? '<i class="' + t.key + '" style="flex:' + n + '" data-tip="' + esc(t.label + ': ' + n + ' (' + Math.round(n / tot * 100) + '%)') + '"></i>' : ''; }).join('') + '</div>' +
      '<div class="legend">' + R.TEMPS.map(function (t) { var n = sc.temps[t.key] || 0; return '<span><i style="background:var(--m-' + t.key + ')"></i>' + t.emoji + ' ' + t.label + ' <b class="num">' + n + '</b> <span class="muted">(' + Math.round(n / tot * 100) + '%)</span></span>'; }).join('') + '</div></div>';
    h += '<div class="card" style="margin-top:12px"><div class="card-head"><h3>From booth to deal</h3><span class="sub">each step as a share of leads</span></div><div class="hbars">' +
      sc.funnel.map(function (f) { return hbar(f.label, f.n, sc.leads, 'i-funnel', f.n + (sc.leads ? ' · ' + Math.round(f.n / sc.leads * 100) + '%' : '')); }).join('') + '</div>' +
      '<p class="hint" style="margin-top:12px">' + sc.onTimeRate + '% were followed up before their clock ran out; ' + plural(sc.wentCold, 'lead') + ' went cold waiting.</p></div>';
    if (sc.chips && sc.chips.length) {
      var cmax = sc.chips[0].n;
      h += '<div class="card" style="margin-top:12px"><div class="card-head"><h3>What they asked about</h3></div><div class="hbars">' +
        sc.chips.slice(0, 8).map(function (c) { return hbar(c.chip, c.n, cmax, 'i-chip', String(c.n)); }).join('') + '</div></div>';
    }
    if (sc.days && sc.days.length) {
      var dmax = Math.max.apply(null, sc.days.map(function (d) { return d.n; }));
      h += '<div class="card" style="margin-top:12px"><div class="card-head"><h3>Leads per day</h3></div><div class="cols" role="img" aria-label="' + esc(sc.days.map(function (d) { return fmtDay(d.day) + ': ' + d.n; }).join(', ')) + '">' +
        sc.days.map(function (d) { return '<div class="c" data-tip="' + esc(fmtDay(d.day) + ': ' + plural(d.n, 'lead')) + '"><b>' + d.n + '</b><i style="height:' + Math.max(4, d.n / dmax * 80) + '%"></i><span>' + esc(fmtDay(d.day)) + '</span></div>'; }).join('') + '</div>' +
        '<details class="table"><summary>As a table</summary><table><tr><th>Day</th><th>Leads</th></tr>' + sc.days.map(function (d) { return '<tr><td>' + esc(fmtDay(d.day, { weekday: 'short' })) + '</td><td>' + d.n + '</td></tr>'; }).join('') + '</table></details></div>';
    }
    return h;
  }

  function renderScore(ctx) {
    var get = ctx.demo ? Promise.resolve({ scorecard: ctx.score, goingCold: ctx.goingCold }) : api('GET', 'api/events/' + enc(ctx.key) + '/scorecard');
    get.then(function (r) {
      var sc = r.scorecard;
      var h = eventHead(ctx, 'Show scorecard', 'Did the booth pay off? Counted live from every lead.');
      h += '<div class="dk-2"><div>' + scoreBody(sc) + '</div><div class="stack dk-sticky">';
      // The same leads the list shows, so the rows tick from their own capture times.
      var byId = {};
      ctx.leads.forEach(function (l) { byId[l.id] = l; });
      var cold = (r.goingCold || []).map(function (g) { return byId[g.id] || null; }).filter(Boolean);
      h += '<div class="card"><div class="card-head"><h3>🧊 Going cold right now</h3><span class="sub">' + plural(cold.length, 'lead') + '</span></div>' +
        (cold.length ? '<div class="cold-list">' + cold.slice(0, 12).map(function (g) { return coldRow(g, ctx.base); }).join('') + '</div>' : '<p class="muted small" style="margin:0">Every lead has had a follow-up. 🛡️</p>') + '</div>';
      if (!ctx.demo && ctx.event.owner) {
        h += '<div class="card"><h3>Share or export</h3><p class="small muted">Share a frozen, read-only scorecard — numbers only, never a lead’s name or contact. Export every lead as a CSV for your CRM.</p>' +
          '<div class="btn-row"><button class="btn" id="shareBtn">' + (ctx.event.share ? 'Manage share link' : 'Share the scorecard') + '</button><a class="btn ghost" href="' + BASE + 'api/events/' + enc(ctx.key) + '/export.csv" download>Export CSV</a></div></div>';
      } else if (ctx.demo) {
        h += '<div class="card"><h3>Share or export</h3><p class="small muted">The owner can share a read-only scorecard (numbers only) and export every lead as a CSV.</p><button class="btn block" data-signup>Start free</button></div>';
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
      root.innerHTML = '<div class="grab"></div><h2>Share the scorecard</h2><p class="muted small">A public, read-only card: the verdict, ROI, follow-up rate, the funnel and what visitors asked about. Numbers only — no lead, no contact, no teammate. Frozen when you publish; update it any time.</p>' +
        (s ? '<div class="share-box"><input class="input" id="shUrl" readonly value="' + esc(url) + '" aria-label="Share link"><button class="btn small" id="shCopy">Copy</button></div>' +
          '<div class="btn-row" style="margin-top:10px"><button class="btn small ghost" id="shPub">Update the card</button><a class="btn small ghost" href="' + esc(BASE + s.url) + '" target="_blank" rel="noopener">Open</a><button class="btn small danger" id="shRevoke">Revoke</button></div>'
          : '<button class="btn block" id="shPub">Publish the card</button>') +
        '<div id="shErr"></div><p class="small muted" style="margin:12px 0 0">Anyone with the link can see it. Revoke it and the link is dead for good.</p>';
      $('#shPub', root).onclick = function () {
        this.disabled = true;
        api('POST', 'api/events/' + enc(ctx.key) + '/share').then(function (r) {
          ctx.event.share = { token: r.token, url: r.url, sharedAt: r.sharedAt };
          toast(s ? 'Updated — the link shows today’s numbers.' : 'Published. Copy the link.');
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
      view.innerHTML = (c.preview ? '<div class="banner" style="margin:0 auto 12px;max-width:620px"><span class="e">👀</span><span>This is what people see — a frozen card. Update it from the scorecard.</span></div>' : '') +
        '<div class="scard"><div class="kind">🎪 Show scorecard</div><h1>' + esc(c.event.name) + '</h1><div class="when">' + esc([fmtRange(c.event.startDate, c.event.endDate), c.event.place].filter(Boolean).join(' · ')) + ' · a team of ' + c.teamSize + '</div>' +
        '<div style="margin-top:18px">' + scoreBody(c) + '</div>' +
        '<p class="center small muted" style="margin:16px 0 0">Frozen ' + esc(fmtDay(c.frozenAt, { year: 'numeric' })) + '. Numbers only — no lead’s name or contact is on this card.</p></div>' +
        '<p class="center small faint" style="margin-top:22px">Made with <a href="./">Booth 🎪</a> — trade-show leads that don’t go cold.</p>';
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><div class="e">🔒</div><h2>This link isn’t valid</h2><p>' + esc(e.message) + '</p><a class="btn" href="./">What is Booth?</a></div>';
    });
  }

  /* ---------------- settings ---------------- */

  function renderSettings(ctx) {
    api('GET', 'api/events/' + enc(ctx.key)).then(function (ev) {
      ctx.event = ev;
      var me = ev.me;
      var h = backLink(ctx.base, 'Leads') + '<div class="page-head"><div><div class="eyebrow">' + esc(ev.name) + '</div><h1>' + (ev.owner ? 'Team & event' : 'You on this team') + '</h1></div></div><div class="dk-2"><div class="stack">';
      if (ev.owner) {
        var invite = 'Join our booth team for ' + ev.name + ' on Booth: ' + location.origin + BASE + '#/join/' + R.normalizeCode(ev.code) + ' (code ' + ev.code + ')';
        h += '<div class="card"><div class="card-head"><h3>Invite the team</h3><span class="sub">' + plural(ev.members, 'person').replace('persons', 'people') + '</span></div>' +
          '<div class="codebox" aria-label="Join code">' + esc(ev.code) + '</div>' +
          '<div class="btn-row" style="margin-top:10px"><button class="btn" id="copyInvite">Copy invite</button><button class="btn ghost" id="copyCode">Copy code</button></div>' +
          '<p class="hint">Staff see every lead and the leaderboard; only you can edit the event, export, share the scorecard or remove people. <button class="link-btn" id="resetCode">Reset the code</button> if it leaked — the old one stops at once.</p>' +
          '<div class="members" style="margin-top:10px">' + (ev.people || []).map(function (p) {
            return '<div class="mrow"><span class="grow"><b>' + esc(p.name) + '</b>' + (p.you ? ' <span class="tag">you</span>' : '') + ' <span class="tag">' + (p.role === 'owner' ? 'owner' : 'staff') + '</span></span>' +
              (p.role !== 'owner' ? '<button class="btn small danger" data-remove="' + esc(p.uid) + '" data-name="' + esc(p.name) + '">Remove</button>' : '') + '</div>';
          }).join('') + '</div></div>';
        h += '<form class="card" id="evForm"><h3 style="margin-bottom:12px">Event details</h3>' + eventFields(ev) + '<div id="evErr"></div><button class="btn block" type="submit">Save event</button></form>';
      }
      h += '</div><div class="stack">';
      h += '<form class="card" id="meForm"><h3 style="margin-bottom:12px">You</h3>' +
        '<label class="field"><span>Your name, as the team sees it</span><input class="input" name="name" maxlength="30" value="' + esc(me.name) + '"></label>' +
        '<label class="field"><span>Email sign-off</span><input class="input" name="signoff" maxlength="80" placeholder="e.g. Maya Okafor · Brightline Coffee" value="' + esc(me.signoff) + '"></label>' +
        '<label class="field"><span>Your voice for drafted follow-ups</span><select class="input" name="tone">' + R.TONES.map(function (t) { return '<option value="' + t.key + '"' + (me.tone === t.key ? ' selected' : '') + '>' + esc(t.label) + '</option>'; }).join('') + '</select></label>' +
        '<div id="meErr"></div><button class="btn block" type="submit">Save</button></form>';
      if (ev.owner) {
        h += '<div class="card"><h3>Scorecard & data</h3><p class="small muted">Share a numbers-only scorecard, or take every lead to your CRM.</p><div class="btn-row"><a class="btn ghost" href="' + ctx.base + '/score">Scorecard</a><a class="btn ghost" href="' + BASE + 'api/events/' + enc(ctx.key) + '/export.csv" download>Export CSV</a></div>' +
          '<p class="hint">The CSV holds every lead’s contact details — keep it somewhere safe. Cells that a spreadsheet would run as a formula are kept as text.</p></div>' +
          '<div class="card"><h3>Delete the event</h3><p class="small muted">Deletes every lead, the team, the code and the share link. It cannot be undone — export first.</p><button class="btn danger block" id="delEv">Delete ' + esc(ev.name) + '</button></div>';
      } else {
        h += '<div class="card"><h3>Leave the team</h3><p class="small muted">The leads you captured stay with the team — they’re the booth’s pipeline.</p><button class="btn danger block" id="leave">Leave ' + esc(ev.name) + '</button></div>';
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
        $('#copyInvite').onclick = function () { copy(invite, 'Invite copied — send it to the team'); };
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
    if (q.get('member') || q.get('credited')) toast(q.get('member') ? 'Welcome, member 🎪' : 'Credit added 🎪', 3000);
    route();
  });
})();
