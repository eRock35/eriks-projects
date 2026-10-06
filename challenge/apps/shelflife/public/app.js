/* Shelf Life - the page. One file, no build step. Every string that came
 * from outside this file (a typed food, a model's reading of a photo or its
 * recipe, anything from the server) is escaped before it is drawn, and no
 * handler is written into markup: clicks are routed by data-act attributes
 * from one listener (the lab's CSP allows script from this origin only). The
 * rules - dates, bands, recipes, stats - are shelf-core.js, the same file the
 * server and the tests run.
 *
 * Where a kitchen can live:
 *   example - Sam & Priya's (sample.js), the first thing to try. Ate it,
 *             Binned it and Froze it work, on this phone only; nothing is
 *             saved. Editing or adding offers "Make it yours".
 *   local   - "Start my kitchen": in localStorage on this device, no account,
 *             no server.
 *   online  - k/<id>: put online by a host with a free account; everyone
 *             else joined by code, link or QR with a name and an emoji.
 *   join    - j/<code>.
 */
(function () {
  'use strict';

  var C = window.ShelfCore;
  var S = window.ShelfSample;
  var QR = window.ShelfQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LOCAL = 'shelflife-kitchen-v1';
  var K_LIST = 'shelflife-kitchens-v1';
  var K_LAST = 'shelflife-last-v1';
  var POLL_MS = 5000;
  var PHOTO_PX = 1600;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }());
  var KITCHEN_ID = (function () { var m = /\/k\/([A-Za-z0-9_-]{16})\/?$/.exec(location.pathname); return m ? m[1] : null; }());
  var JOIN_CODE = (function () { var m = /\/j\/([A-Za-z0-9-]{4,16})\/?$/.exec(location.pathname); return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null; }());
  var TABS = [['eat', '🥬', 'Eat first'], ['tonight', '🍳', 'Tonight'], ['add', '+', 'Add'], ['saved', '📊', 'Saved'], ['kitchen', '🏠', 'Kitchen']];
  var BAND_ICON = { past: '⚠️', today: '⏰', tomorrow: '🌙', week: '📅', later: '🌿' };
  var GUIDE = '<p class="guide" role="note"><span aria-hidden="true">👃</span><span><b>Dates here are typical guidance, not a safety check.</b> Use your eyes and nose - and when in doubt, throw it out.</span></p>';

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var plural = C.plural;

  var state = {
    me: null,          // the account, if any
    view: 'start',     // start | kitchen | join
    kind: null,        // example | local | online
    tab: 'eat',
    k: null,           // {name, tz, created, items, history, (online: id, code, members, me, host, v)}
    join: null,
    timer: null,
    welcome: false,
    picks: {},         // the weekly-shop grid: {catalogue id: true}
    q: '',             // what is typed in the add search
    idea: null,        // the chef's last idea
    ideaAvoid: [],
    range: 'week',
    more: false,
    day: null,         // the "today" the board was drawn for
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
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
  var toastTimer = null;
  function toast(msg, opts) {
    $$('.toast').forEach(function (old) { old.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast' + (opts && opts.undo ? '' : ' plain');
    t.setAttribute('role', 'status');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (opts && opts.undo ? '<button type="button" class="btn small light" data-act="undo" data-eid="' + esc(opts.undo) + '">Undo</button>' : '');
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, (opts && opts.ms) || (opts && opts.undo ? 5200 : 2800));
  }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function shareText(title, text) {
    if (navigator.share) navigator.share({ title: title, text: text }).catch(function () { /* closed */ });
    else copy(text, 'Copied - paste it anywhere');
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function isExample() { return state.kind === 'example'; }
  function isLocal() { return state.kind === 'local'; }
  function isOnline() { return state.kind === 'online'; }
  function today() { return C.localDate(Date.now(), (state.k && state.k.tz) || TZ); }
  function items() { return C.sortItems(C.asList(state.k.items)); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, { ms: 4200 });
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Shelf Life is free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  /** A metered call's failure, in the sheet it came from. */
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('This uses a cent or two of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- kitchens remembered on this phone ---------------- */

  function rememberKitchen(id, name) {
    var list = (recall(K_LIST) || []).filter(function (c) { return c && c.id !== id; });
    list.unshift({ id: id, name: String(name || '').slice(0, 60) });
    keep(K_LIST, list.slice(0, 20));
    keep(K_LAST, { id: id });
  }
  function forgetKitchen(id) {
    keep(K_LIST, (recall(K_LIST) || []).filter(function (c) { return c && c.id !== id; }));
    var last = recall(K_LAST);
    if (last && last.id === id) keep(K_LAST, null);
  }

  /* ---------------- the kitchen on this phone ---------------- */

  /** What this phone keeps, read defensively and cleaned by the same rules
   *  the server uses - it is this app's own data, but a phone can hold
   *  anything. */
  function readLocal() {
    var raw = recall(K_LOCAL);
    if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') return null;
    var tz = C.cleanTz(raw.tz || TZ);
    var k = C.cleanKitchen(raw, { today: C.localDate(Date.now(), tz) });
    k.tz = tz;
    return k;
  }
  function saveLocal() {
    if (!isLocal()) return;
    keep(K_LOCAL, { name: state.k.name, tz: state.k.tz, created: state.k.created, items: state.k.items, history: state.k.history });
  }
  function openLocal() {
    var k = readLocal();
    if (!k) return false;
    state.kind = 'local'; state.view = 'kitchen'; state.k = k;
    return true;
  }
  function openExample() {
    state.kind = 'example'; state.view = 'kitchen'; state.k = S.state(Date.now(), TZ);
    state.idea = null;
  }
  function startLocal() {
    if (!readLocal()) {
      keep(K_LOCAL, { name: 'My kitchen', tz: TZ, created: C.localDate(Date.now(), TZ), items: {}, history: {} });
      state.welcome = true;
    }
    keep(K_LAST, null);
    state.idea = null;
    closeSheet(true);
    go('add');
  }

  /* ---------------- the kitchen online ---------------- */

  function setBundle(d) {
    state.kind = 'online'; state.view = 'kitchen';
    state.k = d.kitchen;
    rememberKitchen(d.kitchen.id, d.kitchen.name);
  }
  function loadOnline(quiet) {
    var q = state.k && isOnline() ? '?since=' + state.k.v : '';
    return api('GET', 'api/kitchens/' + KITCHEN_ID + q).then(function (d) {
      if (d.same) return;
      setBundle(d);
      if (!openSheetOpen()) draw();
    }).catch(function (e) {
      if (e.status === 404) {
        forgetKitchen(KITCHEN_ID);
        stopPolling();
        state.k = null;
        $('#main').innerHTML = '<section class="card center gone"><div class="big-emoji" aria-hidden="true">🥬</div><h1>This kitchen isn’t here for you</h1><p class="muted">' +
          esc(e.message === 'No kitchen here.' ? 'You may have left or been removed, the kitchen was deleted, or this browser forgot you. If you have the code, join again.' : e.message) + '</p>' +
          (signedIn() ? '' : '<button class="btn" type="button" data-act="signin">Sign in</button> ') + '<a class="btn ghost" href="' + esc(BASE) + '#start">Back to the start</a></section>';
        return;
      }
      if (!quiet) showError(e);
    });
  }
  function stopPolling() { clearInterval(state.timer); state.timer = null; }
  function startPolling() {
    stopPolling();
    if (!isOnline() || document.hidden) return;
    state.timer = setInterval(function () { loadOnline(true); }, POLL_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return stopPolling();
    if (isOnline() && state.k) { loadOnline(true); startPolling(); }
    if (state.view === 'kitchen' && state.k && state.day !== today() && !openSheetOpen()) draw();
  });
  // A new day turns the board over: Tomorrow becomes Today. Checked once a
  // minute on the phone (the server has no timer and needs none).
  setInterval(function () {
    if (document.hidden || state.view !== 'kitchen' || !state.k || openSheetOpen()) return;
    if (state.day !== today()) draw();
  }, 60000);

  /* ---------------- doing things ---------------- */

  /** Run one action on the kitchen: on this phone, through the core; online,
   *  through the server (which runs the same core in a transaction). */
  function run(op, a) {
    if (isOnline()) {
      var base = 'api/kitchens/' + KITCHEN_ID;
      var p;
      if (op === 'add') p = api('POST', base + '/items', { items: a.list });
      else if (op === 'edit') p = api('PATCH', base + '/items/' + a.iid, a.body);
      else if (op === 'act') p = api('PATCH', base + '/items/' + a.iid, { action: a.action, days: a.days });
      else if (op === 'remove') p = api('DELETE', base + '/items/' + a.iid);
      else if (op === 'done') p = api('POST', base + '/items/' + a.iid + '/done', { outcome: a.outcome });
      else if (op === 'cook') p = api('POST', base + '/cook', { ids: a.ids, title: a.title });
      else if (op === 'undo') p = api('POST', base + '/undo/' + a.eid, {});
      return p.then(function (d) { setBundle(d); return { msg: d.msg, eid: d.eid }; });
    }
    try {
      var ctx = { today: today(), now: Date.now(), by: null };
      var k = state.k;
      var r;
      if (op === 'add') r = C.addItems(k, a.list, ctx);
      else if (op === 'edit') r = C.editItem(k, a.iid, a.body, ctx);
      else if (op === 'act') r = a.action === 'open' ? C.open(k, a.iid, ctx) : a.action === 'freeze' ? C.freeze(k, a.iid, ctx) : a.action === 'thaw' ? C.thaw(k, a.iid, ctx) : C.extend(k, a.iid, a.days, ctx);
      else if (op === 'remove') r = C.removeItem(k, a.iid);
      else if (op === 'done') r = C.done(k, a.iid, a.outcome, ctx);
      else if (op === 'cook') r = C.cook(k, a.ids, a.title, ctx);
      else if (op === 'undo') r = C.undo(k, a.eid, ctx);
      C.applyPatch(k, r.patch);
      saveLocal();
      return Promise.resolve({ msg: r.msg, eid: r.event ? r.event.id : null });
    } catch (e) { return Promise.reject(e); }
  }
  function doRun(op, a, opts) {
    return run(op, a).then(function (r) {
      if (!(opts && opts.keepSheet)) closeSheet(true);
      draw();
      toast(r.msg, r.eid ? { undo: r.eid } : null);
      return r;
    }).catch(function (e) {
      if (e.status === 404 && isOnline()) loadOnline(true);
      showError(e, opts && opts.errBox);
      throw e;
    });
  }

  /* ---------------- routing ---------------- */

  function go(hash) { history.pushState(null, '', BASE + (hash ? '#' + hash : '')); route(); scrollTo(0, 0); }
  function tabName(t) { for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === t) return t; return 'eat'; }
  function tabHash(t) { return isExample() ? 'example/' + t : t; }
  function route() {
    stopPolling();
    closeSheet(true);
    var h = location.hash.replace(/^#/, '');
    if (JOIN_CODE) { state.view = 'join'; draw(); return; }
    if (KITCHEN_ID) {
      state.tab = tabName(h.split('/')[0]);
      if (state.k && isOnline()) { draw(); startPolling(); return; }
      $('#main').innerHTML = '<p class="busy" role="status">Opening the kitchen…</p>';
      loadOnline().then(startPolling);
      return;
    }
    if (/^example(\/|$)/.test(h)) {
      if (!isExample()) openExample();
      state.tab = tabName(h.split('/')[1]);
      draw(); return;
    }
    if (h === 'start') { state.view = 'start'; state.kind = null; draw(); return; }
    if (openLocal()) { state.tab = tabName(h); draw(); return; }
    var last = recall(K_LAST);
    if (!h && last && last.id && /^[A-Za-z0-9_-]{16}$/.test(last.id)) { location.replace(BASE + 'k/' + last.id); return; }
    state.view = 'start'; state.kind = null; draw();
  }
  window.addEventListener('popstate', route);

  /* ---------------- drawing: the shell ---------------- */

  function draw() {
    drawTop();
    var main = $('#main');
    if (state.view === 'start') { main.innerHTML = startHtml() + footer(); wireCodeForm(main); return loadMyKitchens(); }
    if (state.view === 'join') return drawJoin();
    if (!state.k) return;
    state.day = today();
    var k = state.k;
    var html = '';
    if (isExample() && state.tab === 'eat') {
      html += '<section class="strip" aria-label="About this example"><p><b>This is an example kitchen.</b> Tap Ate it, Binned it or Freeze - try Tonight and Saved. Nothing here is saved.</p>' +
        '<div class="row"><button class="btn big light" type="button" data-act="startlocal">Start my kitchen</button><button class="btn ghost-light" type="button" data-act="joinkitchen">Join a household</button></div></section>';
    } else if (isExample()) {
      html += '<section class="strip slim" aria-label="About this example"><p><b>Example kitchen</b> - nothing is saved.</p><button class="btn small light" type="button" data-act="startlocal">Start mine</button></section>';
    }
    html += '<header class="khead"><div><p class="eyebrow">' + (isExample() ? 'Example kitchen' : isLocal() ? 'On this phone' : (k.host ? 'Shared · you host' : 'Shared kitchen')) + '</p><h1>' + esc(k.name) + '</h1></div>' +
      (isOnline() ? '<div class="faces" aria-label="' + esc(plural(k.members.length, 'person', 'people')) + '">' + k.members.slice(0, 6).map(function (m) { return '<span class="face" title="' + esc(m.name) + '" aria-hidden="true">' + esc(m.emoji) + '</span>'; }).join('') + (k.members.length > 6 ? '<span class="face more">+' + (k.members.length - 6) + '</span>' : '') + '</div>' : '') + '</header>';
    html += '<nav class="tabbar dk-tabbar" aria-label="Kitchen"><div class="tabbar-inner"><a class="rail-brand" href="' + esc(BASE) + '#start"><span aria-hidden="true">🥬</span>' + esc(k.name) + '</a>' + TABS.map(function (t) {
      var on = state.tab === t[0];
      return '<button type="button" class="tab' + (t[0] === 'add' ? ' add' : '') + (on ? ' on' : '') + '" data-act="tab" data-tab="' + t[0] + '"' + (on ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span>' + t[2] + '</button>';
    }).join('') + '</div></nav>';
    html += '<div id="tabView"></div>' + footer();
    main.innerHTML = html;
    ({ eat: drawEat, tonight: drawTonight, add: drawAdd, saved: drawSaved, kitchen: drawKitchen })[state.tab]();
  }
  function footer() {
    return '<footer class="foot small muted"><p>Shelf Life is a <a href="' + esc(BASE) + '../">Challenge Lab</a> app. <a href="https://strongtechnicalconsulting.com/privacy">Privacy</a> · free without an account; one account works across every app on this site.</p></footer>';
  }

  /* ---------------- the start screen ---------------- */

  function startHtml() {
    var local = readLocal();
    var n = local ? C.counts(local.items, C.localDate(Date.now(), local.tz)) : null;
    var html = '<section class="hero"><div class="hero-art" aria-hidden="true"><span>🥛</span><span>🥬</span><span>🍓</span></div>' +
      '<h1>Eat what’s about to go off first.</h1>' +
      '<p class="lede">And stop binning food. Shelf Life sorts your fridge, freezer and pantry by what needs eating, finds something to cook tonight that uses it, and keeps score of what you’ve saved.</p></section>' +
      '<div class="choices">' +
      '<button type="button" class="choice" data-act="example"><span class="ci" aria-hidden="true">👀</span><span class="ct"><b>Look at an example kitchen</b><span>Sam &amp; Priya’s - three things to use today, and a recipe for them.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      (local ? '<button type="button" class="choice primary" data-act="openlocal"><span class="ci" aria-hidden="true">🥬</span><span class="ct"><b>Open ' + esc(local.name) + '</b><span>' + (n.total ? plural(n.total, 'thing') + (n.today + n.past ? ' · ' + (n.today + n.past) + ' to use today' : '') : 'On this phone - nothing added yet') + '</span></span><span class="chev" aria-hidden="true">›</span></button>'
        : '<button type="button" class="choice primary" data-act="startlocal"><span class="ci" aria-hidden="true">🧊</span><span class="ct"><b>Start my kitchen</b><span>On this phone. No account - add what you bought in a minute.</span></span><span class="chev" aria-hidden="true">›</span></button>') +
      '<button type="button" class="choice" data-act="joinkitchen"><span class="ci" aria-hidden="true">🔑</span><span class="ct"><b>Join a household kitchen</b><span>Someone shared theirs? Type the six-character code.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '</div>';
    html += '<section class="card" id="myKitchens" hidden></section>';
    html += '<section class="card how"><h2>How it works</h2><ol class="steps">' +
      '<li><span class="sn" aria-hidden="true">1</span><span><b>Add what you bought.</b> Tap from 150 everyday foods - each knows how long it usually keeps - or snap the fridge or a receipt.</span></li>' +
      '<li><span class="sn" aria-hidden="true">2</span><span><b>Eat first.</b> Everything sorted: past its date, today, tomorrow, this week. Ate it, Binned it, Froze it - one tap each.</span></li>' +
      '<li><span class="sn" aria-hidden="true">3</span><span><b>Cook tonight.</b> Forty-odd simple recipes, ranked by how much of what’s going off they use up.</span></li>' +
      '<li><span class="sn" aria-hidden="true">4</span><span><b>Watch the bin get emptier.</b> Eaten vs binned, money rescued, your no-waste streak - and what you keep binning.</span></li>' +
      '</ol></section>' + GUIDE;
    return html;
  }
  function loadMyKitchens() {
    var box = $('#myKitchens');
    if (!box) return;
    var local = recall(K_LIST) || [];
    var p = signedIn() ? api('GET', 'api/kitchens').then(function (r) { return r.kitchens; }).catch(function () { return []; }) : Promise.resolve([]);
    p.then(function (rows) {
      var seen = {};
      var all = rows.map(function (c) { seen[c.id] = 1; return c; }).concat(local.filter(function (c) { return c && !seen[c.id]; }));
      if (!all.length || !$('#myKitchens')) return;
      box.hidden = false;
      box.innerHTML = '<h2>Your shared kitchens</h2><ul class="tlist">' + all.map(function (c) {
        return '<li><a href="' + esc(BASE + 'k/' + c.id) + '"><b>' + esc(c.name) + '</b><span class="small muted">' + (c.host ? 'You host' : 'Member') + (c.members ? ' · ' + plural(c.members, 'person', 'people') : '') + '</span></a></li>';
      }).join('') + '</ul>';
    });
  }

  /* ---------------- Eat first (the board) ---------------- */

  function bandClass(b) { return 'b-' + b; }
  function dayText(it, t) {
    var d = C.daysLeft(it, t);
    if (it.place === 'freezer' && d > 7) return 'Frozen';
    if (d < 0) return (d === -1 ? '1 day' : -d + ' days') + ' past';
    if (d === 0) return 'Today';
    if (d === 1) return 'Tomorrow';
    if (d <= 13) return d + ' days';
    if (d <= 60) return Math.round(d / 7) + ' wks';
    return Math.round(d / 30) + ' mo';
  }
  function placeName(p) { for (var i = 0; i < C.PLACES.length; i++) if (C.PLACES[i].id === p) return C.PLACES[i].label; return p; }
  function metaText(it, t) {
    var bits = [placeName(it.place)];
    if (it.place === 'freezer' && it.frozen) bits.push('frozen ' + C.relDays(C.daysBetween(t, it.frozen)).replace('today', 'today'));
    if (it.opened) bits.push('opened ' + C.relDays(C.daysBetween(t, it.opened)));
    if (it.leftover) bits.push('leftovers');
    bits.push((C.daysLeft(it, t) < 0 ? 'was due ' : 'use by ') + C.dateLabel(it.use, t));
    return bits.join(' · ');
  }
  function itemHtml(it, t) {
    var band = C.bandOf(it, t);
    var frozen = it.place === 'freezer';
    return '<li class="item ' + bandClass(band) + '" data-iid="' + esc(it.id) + '"><div class="irow"><span class="ie" aria-hidden="true">' + esc(it.emoji) + '</span>' +
      '<span class="ib"><span class="iname">' + esc(it.name) + (it.qty > 1 ? ' <span class="qty">×' + it.qty + '</span>' : '') + '</span><span class="imeta">' + esc(metaText(it, t)) + '</span></span>' +
      '<span class="dchip">' + esc(dayText(it, t)) + '</span></div>' +
      (band === 'past' ? '<p class="check">Check it first - look, sniff. When in doubt, throw it out.</p>' : '') +
      '<div class="iacts">' +
      '<button type="button" class="ia ate" data-act="done" data-out="ate" data-iid="' + esc(it.id) + '"><span aria-hidden="true">✓</span> Ate it</button>' +
      '<button type="button" class="ia bin" data-act="done" data-out="binned" data-iid="' + esc(it.id) + '"><span aria-hidden="true">🗑</span> Binned</button>' +
      (frozen ? '<button type="button" class="ia" data-act="itemact" data-do="thaw" data-iid="' + esc(it.id) + '">Thaw</button>'
        : '<button type="button" class="ia icon" data-act="itemact" data-do="freeze" data-iid="' + esc(it.id) + '" aria-label="Froze it: ' + esc(it.name) + '" title="Froze it"><span aria-hidden="true">❄️</span><span class="wide" aria-hidden="true"> Freeze</span></button>') +
      '<button type="button" class="ia icon" data-act="itemact" data-do="extend" data-iid="' + esc(it.id) + '" aria-label="One more day for ' + esc(it.name) + '" title="One more day"><span aria-hidden="true">+1<span class="wide"> day</span></span></button>' +
      '<button type="button" class="ia icon" data-act="edititem" data-iid="' + esc(it.id) + '" aria-label="Edit ' + esc(it.name) + '"><span aria-hidden="true">✏️</span></button>' +
      '</div></li>';
  }
  function drawEat() {
    var el = $('#tabView');
    var t = today();
    var list = items();
    var html = '';
    if (state.welcome && isLocal()) html += welcomeHtml();
    if (!list.length) {
      el.className = '';
      el.innerHTML = html + '<section class="card empty"><div class="big-emoji" aria-hidden="true">🧊</div><h2>Nothing in the kitchen yet</h2><p class="muted">Add what’s in your fridge - tap it from the weekly-shop grid, type it, or snap the fridge.</p><button class="btn big" type="button" data-act="tab" data-tab="add">+ Add food</button></section>' + GUIDE;
      return;
    }
    var bands = C.bands(list, t);
    var n = C.counts(list, t);
    var top = C.rankRecipes(list, t)[0];
    html += '<div class="boardgrid"><div>';
    html += '<section class="card"><p class="headline">' + esc(C.headline(list, t)) + '</p><div class="bchips" role="list">' + bands.map(function (b) {
      return '<a role="listitem" class="bchip ' + bandClass(b.id) + '" href="#band-' + b.id + '" data-act="jump" data-band="' + b.id + '"><span aria-hidden="true">' + BAND_ICON[b.id] + '</span><b>' + b.items.length + '</b> ' + esc(C.BANDS.filter(function (x) { return x.id === b.id; })[0].short) + '</a>';
    }).join('') + '</div>' +
      (top ? '<button type="button" class="tonight-teaser" data-act="tab" data-tab="tonight"><span class="te" aria-hidden="true">' + esc(top.recipe.emoji) + '</span><span class="tb"><b>Tonight: ' + esc(top.recipe.title) + '</b><span>' + esc(C.recipeLine(top)) + '</span></span><span class="chev" aria-hidden="true">›</span></button>' : '') +
      '</section>';
    bands.forEach(function (b) {
      var head = '<div class="bhead"><span class="btag ' + bandClass(b.id) + '"><span aria-hidden="true">' + BAND_ICON[b.id] + '</span>' + esc(b.label) + '</span><span class="small">' + plural(b.items.length, 'thing') + '</span></div>';
      var body = '<ul class="items">' + b.items.map(function (it) { return itemHtml(it, t); }).join('') + '</ul>';
      if (b.id === 'later') html += '<details class="band" id="band-later"' + (n.total - n.later < 4 ? ' open' : '') + '><summary>' + head.replace('</span></div>', ' · show</span></div>') + '</summary>' + body + '</details>';
      else html += '<section class="band" id="band-' + b.id + '" aria-label="' + esc(b.label) + '">' + head + body + '</section>';
    });
    html += '</div><aside class="side">' + sideHtml(t) + '</aside></div>';
    el.className = '';
    el.innerHTML = html;
  }
  /** The board's right-hand column on a desktop, and its end on a phone. */
  function sideHtml(t) {
    var st = C.stats(state.k, t);
    var html = '<section class="card"><h2>This week</h2><div class="tiles"><div class="stat ate"><b>' + st.week.ate + '</b><span>eaten</span></div><div class="stat bin"><b>' + st.week.binned + '</b><span>binned</span></div><div class="stat"><b>' + (st.streak.days) + '</b><span>' + (st.streak.days === 1 ? 'day' : 'days') + ' no waste</span></div></div>' +
      '<button type="button" class="link-btn" data-act="tab" data-tab="saved">See what you’ve saved →</button></section>';
    return html + GUIDE;
  }
  function welcomeHtml() {
    return '<section class="welcome card" role="status"><div class="big-emoji" aria-hidden="true">🎉</div><div><h2>Your kitchen is ready</h2><p class="muted">Start with what’s in the fridge right now: tap the things you have below, or type them. Each one gets a typical use-by date you can change.</p><button class="btn small ghost" type="button" data-act="nowelcome">Got it</button></div></section>';
  }

  /* ---------------- an item: edit, open, freeze ---------------- */

  function itemById(iid) { return state.k && state.k.items ? state.k.items[iid] || null : null; }
  function dateChips(t, sel, suggested) {
    var opts = [['0', 'Today'], ['1', '+1 day'], ['3', '+3 days'], ['7', '+7 days']];
    return '<div class="seg" role="radiogroup" aria-label="Use by">' +
      (suggested !== null && suggested !== undefined ? '<button type="button" class="segb" role="radio" aria-checked="' + (sel.mode === 'typical') + '" data-act="date" data-mode="typical">Typical · ' + esc(suggested === 0 ? 'today' : plural(suggested, 'day')) + '</button>' : '') +
      opts.map(function (o) { return '<button type="button" class="segb" role="radio" aria-checked="' + (sel.mode === 'n' && String(sel.n) === o[0]) + '" data-act="date" data-mode="n" data-n="' + o[0] + '">' + o[1] + '</button>'; }).join('') +
      '<button type="button" class="segb" role="radio" aria-checked="' + (sel.mode === 'pick') + '" data-act="pickdate"><span aria-hidden="true">📅</span><span data-picklabel>' + (sel.mode === 'pick' && C.isDate(sel.pick) ? esc(C.dateLabel(sel.pick, t)) : 'Pick a date') + '</span></button>' +
      '</div><input type="date" class="vh" data-pick tabindex="-1" aria-hidden="true" min="' + esc(C.addDays(t, -60)) + '" max="' + esc(C.addDays(t, 1000)) + '" value="' + esc(sel.pick || '') + '">';
  }
  function placeSeg(sel) {
    return '<div class="seg" role="radiogroup" aria-label="Where it is">' + C.PLACES.map(function (p) {
      return '<button type="button" class="segb" role="radio" aria-checked="' + (p.id === sel) + '" data-act="place" data-v="' + p.id + '"><span aria-hidden="true">' + p.emoji + '</span>' + esc(p.label) + '</button>';
    }).join('') + '</div>';
  }
  function stepper(id, v) {
    return '<div class="stepper"><button type="button" data-act="step" data-for="' + id + '" data-d="-1" aria-label="One fewer">−</button><output id="' + id + '" aria-live="polite">' + v + '</output><button type="button" data-act="step" data-for="' + id + '" data-d="1" aria-label="One more">+</button></div>';
  }
  /** Wire a sheet's date chips, place buttons and steppers to `form`. */
  function wireForm(root, form, onChange) {
    root.__form = form;
    root.__change = onChange || function () {};
    var pick = $('[data-pick]', root);
    if (pick) pick.addEventListener('change', function () {
      if (!C.isDate(pick.value)) return;
      form.date = { mode: 'pick', pick: pick.value };
      var b = $('[data-act=pickdate]', root);
      if (b) { setRadio(b); $('[data-picklabel]', b).textContent = C.dateLabel(pick.value, today()); }
      root.__change();
    });
  }
  function useFrom(sel, t, typical) {
    if (sel.mode === 'pick' && C.isDate(sel.pick)) return sel.pick;
    if (sel.mode === 'n') return C.addDays(t, sel.n);
    return C.addDays(t, typical);
  }
  function openItem(iid) {
    if (isExample()) return openStartOwn('Editing is for your own kitchen.');
    var it = itemById(iid);
    if (!it) return;
    var t = today();
    var form = { qty: it.qty, place: it.place, date: { mode: 'pick', pick: it.use }, dateTouched: false };
    var cat = C.CAT[it.cat] || null;
    var html = '<div class="ihead"><span class="ie" aria-hidden="true">' + esc(it.emoji) + '</span><div><h2 style="margin:0">' + esc(it.name) + '</h2><p class="small muted" style="margin:0">' + esc(metaText(it, t)) + '</p></div></div>' +
      '<div class="row" style="margin:12px 0">' +
      (it.opened || it.place === 'freezer' ? '' : '<button type="button" class="btn small ghost" data-act="sheetact" data-do="open" data-iid="' + esc(it.id) + '">📭 I opened it</button>') +
      (it.place === 'freezer' ? '<button type="button" class="btn small ghost" data-act="sheetact" data-do="thaw" data-iid="' + esc(it.id) + '">Thaw it</button>' : '<button type="button" class="btn small ghost" data-act="sheetact" data-do="freeze" data-iid="' + esc(it.id) + '">❄️ Froze it</button>') +
      '<button type="button" class="btn small ghost" data-act="sheetact" data-do="extend3" data-iid="' + esc(it.id) + '">+3 days</button></div>' +
      (cat && cat.opened && !it.opened && it.place !== 'freezer' ? '<p class="small muted">Once opened, ' + esc(cat.name.toLowerCase()) + ' usually keeps about ' + plural(cat.opened, 'day') + (cat.openPlace ? ', in the ' + cat.openPlace : '') + '.</p>' : '') +
      '<form id="iForm" class="stack"><label class="field"><span>Name</span><input class="input" id="iName" maxlength="' + C.LIMITS.itemName + '" value="' + esc(it.name) + '"></label>' +
      '<div class="field"><span>How many</span>' + stepper('iQty', it.qty) + '</div>' +
      '<div class="field"><span>Where</span>' + placeSeg(it.place) + '</div>' +
      '<div class="field"><span>Use by</span>' + dateChips(t, form.date, null) + '<span class="datehint" id="iHint">' + esc(C.dateLabel(it.use, t)) + '</span></div>' +
      '<div id="iErr"></div><button class="btn block" type="submit">Save</button>' +
      '<button type="button" class="btn ghost danger block" data-act="removeitem" data-iid="' + esc(it.id) + '">Take it off the list (added by mistake)</button></form>';
    sheet(html, function (root) {
      wireForm(root, form, function () {
        form.dateTouched = true;
        $('#iHint', root).textContent = C.dateLabel(useFrom(form.date, t, 0), t);
      });
      $('#iForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var body = { name: $('#iName', root).value, qty: form.qty };
        if (form.place !== it.place) body.place = form.place;
        if (form.dateTouched) body.use = useFrom(form.date, t, 0);
        doRun('edit', { iid: it.id, body: body }, { errBox: $('#iErr', root) }).catch(function () {});
      });
    });
  }

  /* ---------------- Add ---------------- */

  function drawAdd() {
    var el = $('#tabView');
    var t = today();
    var html = '';
    if (state.welcome && isLocal()) html += welcomeHtml();
    html += '<section class="card"><h2>What did you buy?</h2><form class="searchbox" id="qForm" role="search"><span class="sicon" aria-hidden="true">🔎</span><input class="input" id="q" type="search" autocomplete="off" maxlength="' + C.LIMITS.itemName + '" placeholder="Spinach, milk, leftover curry…" aria-label="Food name" value="' + esc(state.q) + '"></form><ul class="results" id="results" aria-live="polite"></ul>' +
      '<div class="quick"><button type="button" class="qbtn" data-act="snap"><span class="qi" aria-hidden="true">📷</span><span><b>Snap it</b> <span class="ai">AI</span><span class="qs">The open fridge or a receipt</span></span></button><button type="button" class="qbtn" data-act="leftovers"><span class="qi" aria-hidden="true">🍲</span><span><b>Leftovers</b><span class="qs">One tap, keeps ~4 days</span></span></button></div></section>';
    var picked = Object.keys(state.picks);
    var have = {};
    items().forEach(function (it) { if (it.cat && C.daysLeft(it, t) >= 0) have[it.cat] = (have[it.cat] || 0) + it.qty; });
    html += '<section class="card"><div class="sec-head"><h2>Weekly shop</h2><span class="small muted">Tap what you bought</span></div><div class="shopgrid">' + C.WEEKLY.map(function (id) {
      var c = C.CAT[id];
      var on = Boolean(state.picks[id]);
      return '<button type="button" class="tile" data-act="pickshop" data-cat="' + id + '" aria-pressed="' + on + '"><span class="te" aria-hidden="true">' + esc(c.emoji) + '</span>' + esc(c.name) + '<span class="td">' + esc(have[id] ? 'You have ' + have[id] : shortKeep(c)) + '</span></button>';
    }).join('') + '</div>' +
      (picked.length ? '<div class="addbar"><button type="button" class="btn big" data-act="addpicks">Add ' + plural(picked.length, 'thing') + '</button></div>' : '') + '</section>';
    html += shopNudgeHtml(t) + GUIDE;
    el.className = '';
    el.innerHTML = html;
    var q = $('#q', el);
    q.addEventListener('input', function () { state.q = q.value; drawResults(); });
    $('#qForm', el).addEventListener('submit', function (e) {
      e.preventDefault();
      var first = C.search(state.q, 1)[0];
      if (first && C.fold(first.name) === C.fold(state.q)) openAdd(first.id, null); else if (state.q.trim()) openAdd(null, state.q);
    });
    drawResults();
  }
  function shortKeep(c) {
    var d = c.days;
    var where = c.place === 'freezer' ? ' frozen' : '';
    if (d <= 13) return plural(d, 'day') + where;
    if (d <= 60) return Math.round(d / 7) + ' weeks' + where;
    return Math.round(d / 30) + ' months' + where;
  }
  function drawResults() {
    var box = $('#results');
    if (!box) return;
    var q = state.q.trim();
    if (!q) { box.innerHTML = ''; return; }
    var hits = C.search(q, 6);
    var exact = hits.some(function (c) { return C.fold(c.name) === C.fold(q); });
    box.innerHTML = hits.map(function (c) {
      return '<li><button type="button" class="res" data-act="addcat" data-cat="' + c.id + '"><span class="ie" aria-hidden="true">' + esc(c.emoji) + '</span><span class="ib"><b>' + esc(c.name) + '</b><span class="imeta">' + esc(placeName(c.place) + ' · keeps ' + shortKeep(c).replace(' frozen', '') + (c.opened ? ' · ' + plural(c.opened, 'day') + ' once open' : '')) + '</span></span><span class="plus" aria-hidden="true">+</span></button></li>';
    }).join('') + (exact ? '' : '<li><button type="button" class="res" data-act="addfree"><span class="ie" aria-hidden="true">🍽️</span><span class="ib"><b>Add “' + esc(C.clean(q, C.LIMITS.itemName)) + '”</b><span class="imeta">Not in the list - you pick the date</span></span><span class="plus" aria-hidden="true">+</span></button></li>');
  }
  /** The add sheet: from the catalogue (catId) or as typed (name). */
  function openAdd(catId, name) {
    if (isExample()) return openStartOwn('Adding food is for your own kitchen.');
    var t = today();
    var cat = catId ? C.CAT[catId] : C.catFor(name);
    var nm = cat && !name ? cat.name : C.clean(name, C.LIMITS.itemName);
    if (!nm) return;
    var form = { qty: 1, place: cat ? cat.place : 'fridge', date: { mode: 'typical' }, opened: false };
    function typical() { return C.shelfDays(cat, form.place, form.opened); }
    function hint() { return 'Use by ' + C.dateLabel(useFrom(form.date, t, typical()), t) + (form.date.mode === 'typical' ? ' - typical for ' + (cat ? cat.name.toLowerCase() : 'this') + (form.place === 'freezer' ? ' frozen' : form.opened ? ' once open' : '') : ''); }
    function body(root) {
      $('#aDates', root).innerHTML = dateChips(t, form.date, typical());
      $('#aHint', root).textContent = hint();
      wireForm(root, form, function () { $('#aHint', root).textContent = hint(); });
    }
    var html = '<div class="ihead"><span class="ie" aria-hidden="true">' + esc(cat ? cat.emoji : '🍽️') + '</span><div><h2 style="margin:0">' + esc(nm) + '</h2><p class="small muted" style="margin:0">' + esc(cat ? 'Usually keeps ' + shortKeep(cat) + (cat.opened ? ', ' + plural(cat.opened, 'day') + ' once open' : '') : 'Not in the list - pick a date that fits') + '</p></div></div>' +
      '<form id="aForm" class="stack">' + (cat ? '' : '<label class="field"><span>Name</span><input class="input" id="aName" maxlength="' + C.LIMITS.itemName + '" value="' + esc(nm) + '"></label>') +
      '<div class="field"><span>How many</span>' + stepper('aQty', 1) + '</div>' +
      '<div class="field"><span>Where</span>' + placeSeg(form.place) + '</div>' +
      (cat && cat.opened ? '<label class="pick" style="min-height:48px"><input type="checkbox" id="aOpened"><span class="gb"><b>It’s already open</b><span>Uses the opened shelf life</span></span></label>' : '') +
      '<div class="field"><span>Use by</span><div id="aDates"></div><span class="datehint" id="aHint"></span></div>' +
      '<div id="aErr"></div><button class="btn block big" type="submit">Add to the kitchen</button></form>';
    sheet(html, function (root) {
      root.__placeChange = function () { if (form.date.mode === 'typical') body(root); else $('#aHint', root).textContent = hint(); body(root); };
      body(root);
      var op = $('#aOpened', root);
      if (op) op.addEventListener('change', function () { form.opened = op.checked; body(root); });
      $('#aForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var raw = { name: cat ? cat.name : $('#aName', root).value, cat: cat ? cat.id : undefined, qty: form.qty, place: form.place, use: useFrom(form.date, t, typical()) };
        if (form.opened) raw.opened = t;
        doRun('add', { list: [raw] }, { errBox: $('#aErr', root) }).then(function () { state.q = ''; state.welcome = false; draw(); }).catch(function () {});
      });
    });
  }
  function openLeftovers() {
    if (isExample()) return openStartOwn('Adding food is for your own kitchen.');
    var form = { qty: 2 };
    sheet('<h2>🍲 Leftovers</h2><p class="small muted">Cooked food usually keeps about 4 days in the fridge - or freeze it for later.</p><form id="lForm" class="stack"><label class="field"><span>What is it?</span><input class="input" id="lName" maxlength="' + C.LIMITS.itemName + '" placeholder="Chilli, roast chicken, pasta bake…" autocomplete="off"></label>' +
      '<div class="field"><span>Portions</span>' + stepper('lQty', 2) + '</div><div id="lErr"></div><button class="btn block big" type="submit">Add leftovers</button></form>', function (root) {
      root.__form = form;
      $('#lForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var name = C.cleanText($('#lName', root).value, C.LIMITS.itemName);
        doRun('add', { list: [{ name: name ? (/leftover/i.test(name) ? name : name + ' (leftovers)') : 'Leftovers', cat: 'leftovers', emoji: '🍲', place: 'fridge', qty: form.qty, leftover: true, daysLeft: C.CAT.leftovers.days }] }, { errBox: $('#lErr', root) }).catch(function () {});
      });
    });
  }
  function addPicks() {
    if (isExample()) return openStartOwn('Adding food is for your own kitchen.');
    var list = Object.keys(state.picks).map(function (id) { return { cat: id, name: C.CAT[id].name }; });
    if (!list.length) return;
    doRun('add', { list: list }).then(function () { state.picks = {}; state.welcome = false; draw(); }).catch(function () {});
  }
  function shopNudgeHtml(t) {
    var s = C.shopping(state.k, t);
    if (!s.dontBuy.length && !s.runningOut.length) return '';
    return '<section class="card" id="shopnudge"><div class="sec-head"><h2>🛒 Before you shop</h2></div>' +
      (s.runningOut.length ? '<h3>Running out?</h3><div class="shoplist">' + s.runningOut.map(function (x) { return '<span class="pchip out" title="' + esc(x.why) + '"><span aria-hidden="true">' + esc(x.emoji) + '</span>' + esc(x.name) + '</span>'; }).join('') + '</div>' : '') +
      (s.dontBuy.length ? '<h3>Don’t buy - you have it</h3><div class="shoplist">' + s.dontBuy.slice(0, 30).map(function (x) { return '<span class="pchip"><span aria-hidden="true">' + esc(x.emoji) + '</span>' + esc(x.name) + (x.qty > 1 ? ' ×' + x.qty : '') + '</span>'; }).join('') + (s.dontBuy.length > 30 ? '<span class="pchip">+' + (s.dontBuy.length - 30) + ' more</span>' : '') + '</div>' : '') +
      '<div class="row"><button type="button" class="btn small" data-act="shareshop">Share the list</button><button type="button" class="btn small ghost" data-act="copyshop">Copy</button></div>' +
      '<p class="small muted" style="margin-top:8px">Shelf Life never sends anything itself - it hands the list to your phone’s share sheet.</p></section>';
  }

  /* ---------------- Snap (AI) ---------------- */

  function openSnap() {
    if (isExample()) return openStartOwn('Snapping adds food, so it’s for your own kitchen - start one, it’s free.');
    if (!signedIn()) {
      return sheet('<h2>📷 Snap the fridge or a receipt</h2><p>Take a photo of the open fridge, a cupboard shelf or your grocery receipt, and AI lists the food with a typical date for each. You tick what to add.</p>' +
        '<div class="note"><p class="small" style="margin:0"><b>Sign in free to use it.</b> A free account comes with $2 of AI credit - a snap costs about a cent or two. Everything else in Shelf Life is free without one.</p></div>' +
        '<button type="button" class="btn block" data-act="signin-snap">Create a free account</button><button type="button" class="btn ghost block" data-act="closesheet">Add by hand instead</button>');
    }
    var photo = null;
    sheet('<h2>📷 Snap the fridge or a receipt</h2><p class="small muted">One shelf or one receipt at a time works best. The photo is read once to list the food and never stored.</p>' +
      '<form id="snForm" class="stack"><label class="btn ghost block filebtn"><input type="file" accept="image/*" capture="environment" id="snFile" class="vh"><span id="snLabel">📷 Take or choose a photo</span></label><div id="snPrev"></div>' +
      '<div id="snErr"></div><button class="btn block" type="submit" disabled>Find the food</button></form><div id="snOut"></div>', function (root) {
      var btn = $('button[type=submit]', root);
      $('#snFile', root).addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0]; if (!f) return;
        $('#snLabel', root).textContent = 'Preparing the photo…';
        shrink(f).then(function (p) {
          photo = p; btn.disabled = false;
          $('#snLabel', root).textContent = '📷 Change the photo';
          $('#snPrev', root).innerHTML = '<img class="thumb" alt="The photo you picked" src="data:image/jpeg;base64,' + p.data + '">';
        }).catch(function (err) { $('#snLabel', root).textContent = '📷 Take or choose a photo'; showError(err, $('#snErr', root)); });
      });
      $('#snForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        if (!photo) return;
        btn.disabled = true;
        $('#snErr', root).innerHTML = '<p class="busy" role="status">Looking for food… this takes a few seconds.</p>';
        api('POST', 'api/snap', { photo: photo, tz: state.k.tz }).then(function (r) {
          btn.disabled = false; $('#snErr', root).innerHTML = '';
          $('#snForm', root).hidden = true;
          var out = $('#snOut', root);
          var t = today();
          out.innerHTML = '<p><b>Found ' + plural(r.items.length, 'thing') + '</b> - untick anything that’s wrong. Nothing is added until you press Add.</p><ul class="picklist">' + r.items.map(function (it, i) {
            return '<li><label class="pick"><input type="checkbox" id="sn' + i + '" checked><span class="ie" aria-hidden="true">' + esc(it.emoji) + '</span><span class="gb"><b>' + esc(it.name) + (it.qty > 1 ? ' ×' + it.qty : '') + '</b><span>' + esc(placeName(it.place) + ' · use by ' + C.dateLabel(C.addDays(t, it.daysLeft), t)) + '</span></span></label></li>';
          }).join('') + '</ul><div id="snAddErr"></div><button type="button" class="btn block big" id="snAdd">Add the ticked items</button><button type="button" class="btn ghost block" id="snAgain">Try another photo</button>';
          $('#snAdd', out).addEventListener('click', function () {
            var chosen = r.items.filter(function (it, i) { var x = $('#sn' + i, out); return x && x.checked; });
            if (!chosen.length) return toast('Tick at least one.');
            doRun('add', { list: chosen }, { errBox: $('#snAddErr', out) }).then(function () { state.welcome = false; state.tab = 'eat'; history.replaceState(null, '', location.pathname + '#' + tabHash('eat')); draw(); }).catch(function () {});
          });
          $('#snAgain', out).addEventListener('click', function () { out.innerHTML = ''; $('#snForm', root).hidden = false; });
        }).catch(function (err) { btn.disabled = false; meteredError(err, $('#snErr', root), openSnap); });
      });
    });
  }
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        var k = Math.min(1, PHOTO_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var dataUrl = c.toDataURL('image/jpeg', 0.85);
        URL.revokeObjectURL(url);
        resolve({ type: 'image/jpeg', data: dataUrl.split(',')[1] });
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be opened.')); });
      img.src = url;
    });
  }

  /* ---------------- Tonight ---------------- */

  function chipFor(it, t) {
    return '<span class="rchip ' + bandClass(C.bandOf(it, t)) + '"><span aria-hidden="true">' + esc(it.emoji) + '</span>' + esc(it.name) + ' · ' + esc(dayText(it, t).toLowerCase()) + '</span>';
  }
  function recipeHtml(m, t, i) {
    var r = m.recipe;
    return '<li class="card recipe">' + (i === 0 ? '<p class="rank">Best use of tonight</p>' : '') + '<div class="rhead"><span class="remoji" aria-hidden="true">' + esc(r.emoji) + '</span><div><h3 class="rtitle">' + esc(r.title) + '</h3><p class="rline">' + esc(C.recipeLine(m)) + '</p>' +
      '<p class="rneed">' + (m.missing.length ? 'You’d need: ' + esc(m.missing.join(', ')) : 'You have everything for it') + '</p></div></div>' +
      '<div class="rchips">' + m.used.concat(m.nice).map(function (it) { return chipFor(it, t); }).join('') + '</div>' +
      '<details class="rsteps"><summary>How to make it</summary><ol>' + r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></details>' +
      '<div class="racts"><button type="button" class="btn" data-act="cook" data-rid="' + esc(r.id) + '">Cook this</button></div></li>';
  }
  function drawTonight() {
    var el = $('#tabView');
    var t = today();
    var list = items();
    var ranked = C.rankRecipes(list, t);
    var html = '<section class="card chef full"><div class="rhead"><span class="remoji" aria-hidden="true">✨</span><div><h2 style="margin:0">Something new with what’s going off</h2><p class="small muted" style="margin:2px 0 0">A chef’s idea built around your most urgent food. <span class="ai">AI</span></p></div></div>' +
      '<div id="ideaBox">' + (state.idea ? ideaHtml(state.idea, t) : '') + '</div><div id="ideaErr"></div>' +
      '<button type="button" class="btn block" data-act="idea">' + (state.idea ? 'Another idea' : 'Give me an idea') + '</button></section>';
    if (!list.length) {
      html += '<section class="card empty full"><div class="big-emoji" aria-hidden="true">🍳</div><h2>Add some food to get recipes</h2><p class="muted">Tonight ranks ' + C.RECIPES.length + ' simple recipes by how much of what’s going off they use.</p><button class="btn" type="button" data-act="tab" data-tab="add">+ Add food</button></section>';
    } else if (!ranked.length) {
      html += '<section class="card empty full"><div class="big-emoji" aria-hidden="true">🤔</div><h2>No recipe fits yet</h2><p class="muted">None of the built-in recipes uses enough of what you have. Try the chef’s idea above.</p></section>';
    } else {
      var show = state.more ? ranked.slice(0, 16) : ranked.slice(0, 6);
      html += '<h2 style="margin-top:20px">Uses what’s going off first</h2><ul class="rlist two">' + show.map(function (m, i) { return recipeHtml(m, t, i); }).join('') + '</ul>' +
        (ranked.length > show.length ? '<button type="button" class="btn ghost block" data-act="more">' + (state.more ? 'Fewer' : 'More ideas (' + (Math.min(16, ranked.length) - show.length) + ')') + '</button>' : '');
    }
    el.className = '';
    el.innerHTML = html + GUIDE;
  }
  function ideaHtml(r, t) {
    var used = r.uses.map(itemById).filter(Boolean);
    return '<div class="note" style="margin-top:12px"><div class="rhead"><span class="remoji" aria-hidden="true">' + esc(r.emoji) + '</span><div><h3 class="rtitle">' + esc(r.title) + '</h3><p class="rline">Uses ' + esc(plural(used.length, 'thing')) + ' from your kitchen · ' + r.minutes + ' min</p>' +
      (r.extra.length ? '<p class="rneed">Also: ' + esc(r.extra.join(', ')) + '</p>' : '') + '</div></div>' +
      '<div class="rchips">' + used.map(function (it) { return chipFor(it, t); }).join('') + '</div>' +
      '<ol style="margin:10px 0 0;padding-left:22px">' + r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      (used.length ? '<div class="racts"><button type="button" class="btn" data-act="cookidea">Cook this</button></div>' : '<p class="small muted">Those items have gone since - ask for another.</p>') + '</div>';
  }
  function getIdea(btn) {
    if (!signedIn()) {
      return sheet('<h2>✨ A chef’s idea</h2><p>AI looks at what’s going off soonest in your kitchen and invents one simple dinner around it - with steps, and a “Cook this” that marks the food eaten.</p>' +
        '<div class="note"><p class="small" style="margin:0"><b>Sign in free to use it.</b> A free account comes with $2 of AI credit - an idea costs about a cent. The ' + C.RECIPES.length + ' recipes below are free without one.</p></div>' +
        '<button type="button" class="btn block" data-act="signin-idea">Create a free account</button><button type="button" class="btn ghost block" data-act="closesheet">Use the free recipes</button>');
    }
    var t = today();
    var list = items().filter(function (it) { return C.daysLeft(it, t) >= -3; }).slice(0, C.LIMITS.ideaItems);
    if (!list.length) return toast('Add some food first.');
    if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
    var box = $('#ideaErr');
    if (box) box.innerHTML = '<p class="busy" role="status">Looking in the fridge…</p>';
    api('POST', 'api/idea', { items: list.map(function (it) { return { id: it.id, name: it.name, daysLeft: C.daysLeft(it, t), place: it.place }; }), avoid: state.ideaAvoid.slice(-5) }).then(function (r) {
      state.idea = r.recipe;
      state.ideaAvoid.push(r.recipe.title);
      draw();
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Give me an idea'; }
      meteredError(err, $('#ideaErr') || document.createElement('div'), function () { state.tab = 'tonight'; draw(); });
    });
  }
  /** "Cook this": which items it uses - the main ones ticked, the extras not. */
  function openCook(title, main, extra) {
    var t = today();
    var all = main.map(function (it) { return { it: it, on: true }; }).concat(extra.map(function (it) { return { it: it, on: false }; }));
    sheet('<h2>Cooking ' + esc(title) + '</h2><p class="small muted">Tick what you used - each comes off the list as eaten (one of each).</p><ul class="picklist">' + all.map(function (x, i) {
      return '<li><label class="pick"><input type="checkbox" id="ck' + i + '"' + (x.on ? ' checked' : '') + '><span class="ie" aria-hidden="true">' + esc(x.it.emoji) + '</span><span class="gb"><b>' + esc(x.it.name) + (x.it.qty > 1 ? ' (1 of ' + x.it.qty + ')' : '') + '</b><span>' + esc(dayText(x.it, t)) + '</span></span></label></li>';
    }).join('') + '</ul><div id="ckErr"></div><button type="button" class="btn block big" id="ckGo">Mark as eaten</button>', function (root) {
      $('#ckGo', root).addEventListener('click', function () {
        var ids = all.filter(function (x, i) { var c = $('#ck' + i, root); return c && c.checked; }).map(function (x) { return x.it.id; });
        if (!ids.length) return toast('Tick at least one.');
        doRun('cook', { ids: ids, title: title }, { errBox: $('#ckErr', root) }).then(function () { celebrate(); }).catch(function () {});
      });
    });
  }

  /* ---------------- Saved and wasted ---------------- */

  function drawSaved() {
    var el = $('#tabView');
    var t = today();
    var st = C.stats(state.k, t);
    var r = state.range === 'month' ? st.month : st.week;
    var html = '';
    if (!st.total) {
      el.className = '';
      el.innerHTML = '<section class="card empty"><div class="big-emoji" aria-hidden="true">📊</div><h2>Your score starts with the first “Ate it”</h2><p class="muted">Every time you eat or bin something, Shelf Life keeps count: how much you ate before it went off, an estimate of the money that saved, and your streak of days with nothing binned.</p><button class="btn" type="button" data-act="tab" data-tab="eat">Go to Eat first</button></section>' + GUIDE;
      return;
    }
    html += '<section class="card full"><div class="sec-head"><h2>Saved and wasted</h2><div class="seg" role="radiogroup" aria-label="Period" style="flex:0 0 auto">' +
      '<button type="button" class="segb" role="radio" aria-checked="' + (state.range === 'week') + '" data-act="range" data-v="week">This week</button><button type="button" class="segb" role="radio" aria-checked="' + (state.range === 'month') + '" data-act="range" data-v="month">4 weeks</button></div></div>' +
      '<div class="tiles"><div class="stat ate"><b>' + r.ate + '</b><span>eaten</span></div><div class="stat bin"><b>' + r.binned + '</b><span>binned</span></div><div class="stat"><b>' + (r.eatenPct === null ? '–' : r.eatenPct + '%') + '</b><span>eaten, not binned</span></div></div>' +
      '<p class="savedline">' + (r.rescued ? 'About ' + esc(C.money(r.savedUsd)) + ' of food rescued' : 'Nothing rescued at the last minute yet') + '</p>' +
      '<p class="small muted">' + (r.rescued ? plural(r.rescued, 'thing') + ' eaten on or just before its date' : 'Eat something on the day it’s due to count a rescue') + (r.binned ? ' · about ' + esc(C.money(r.wastedUsd)) + ' binned' : '') + '. A rough estimate from typical prices, not your receipts.</p></section>';
    html += '<section class="card"><div class="streak"><span class="fire" aria-hidden="true">' + (st.streak.days >= 3 ? '🔥' : '🌱') + '</span><div><b>' + plural(st.streak.days, 'day') + '</b> with nothing binned<p class="small muted" style="margin:0">' + (st.streak.days === 0 ? 'Something went in the bin today - tomorrow’s a fresh start.' : st.streak.best > st.streak.days ? 'Your best so far: ' + plural(st.streak.best, 'day') + '.' : 'Your best run yet. Keep it going.') + '</p></div></div></section>';
    var max = Math.max.apply(null, st.weeks.map(function (w) { return w.ate + w.binned; }).concat([1]));
    html += '<section class="card"><h2>Week by week</h2><ul class="wbars">' + st.weeks.map(function (w) {
      var tot = w.ate + w.binned;
      return '<li><div class="wlab"><b>' + esc(w.label) + '</b><span>' + w.ate + ' eaten · ' + w.binned + ' binned</span></div><div class="wtrack" role="img" aria-label="' + esc(w.label + ': ' + w.ate + ' eaten, ' + w.binned + ' binned') + '">' +
        (w.ate ? '<span class="we" style="width:' + (100 * w.ate / max).toFixed(1) + '%"></span>' : '') + (w.binned ? '<span class="wb" style="width:' + (100 * w.binned / max).toFixed(1) + '%"></span>' : '') + '</div></li>';
    }).join('') + '</ul><div class="legend"><span><i class="le"></i>Eaten</span><span><i class="lb"></i>Binned</span></div></section>';
    if (st.binnedMost.length) {
      html += '<section class="card"><h2>What keeps ending up in the bin</h2><ul class="binned">' + st.binnedMost.map(function (x) {
        return '<li><span class="be" aria-hidden="true">' + esc(x.emoji) + '</span><span>' + esc(C.binLine(x)) + '</span></li>';
      }).join('') + '</ul></section>';
    }
    var recent = C.asList(state.k.history).slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; }).slice(0, 10);
    html += '<section class="card"><h2>Lately</h2><ul class="recent">' + recent.map(function (e) {
      var who = isOnline() && e.by ? memberName(e.by) : '';
      return '<li><span aria-hidden="true">' + esc(e.emoji) + '</span><span>' + esc(e.name) + (e.dish ? '<span class="muted"> · in ' + esc(e.dish) + '</span>' : '') + '<br><span class="small muted">' + esc(C.dateLabel(e.date, t) + (who ? ' · ' + who : '')) + '</span></span><span class="rv ' + e.outcome + '">' + (e.outcome === 'ate' ? (e.left <= C.RESCUE_DAYS ? 'Rescued' : 'Eaten') : 'Binned') + '</span></li>';
    }).join('') + '</ul></section>';
    el.className = 'tabgrid';
    el.innerHTML = html;
  }
  function memberName(mid) {
    var ms = (state.k && state.k.members) || [];
    for (var i = 0; i < ms.length; i++) if (ms[i].id === mid) return ms[i].name;
    return 'someone who left';
  }

  /* ---------------- Kitchen (sharing and settings) ---------------- */

  function joinLink() { return location.origin + BASE + 'j/' + state.k.code; }
  function drawKitchen() {
    var el = $('#tabView');
    var k = state.k;
    var html = '';
    if (isOnline()) {
      html += '<section class="card invite"><div class="sec-head"><h2>Invite the household</h2><span class="small muted">' + k.members.length + ' of ' + C.LIMITS.members + '</span></div>' +
        '<div class="invgrid"><button type="button" class="qr" data-act="qrbig" aria-label="Show the QR code full screen">' + QR.svg(joinLink(), 'QR code to join ' + k.name) + '</button>' +
        '<div><p class="small muted" style="margin:0">Code</p><p class="code">' + esc(k.display) + '</p><p class="small muted">They scan it or open the link, type a name, and they’re in - no account, no app. Everyone sees the same kitchen.</p>' +
        '<div class="row"><button type="button" class="btn small" data-act="sharejoin">Share link</button><button type="button" class="btn small ghost" data-act="copyjoin">Copy</button></div></div></div>' +
        (k.host ? '<button type="button" class="link-btn small" data-act="rotate">New code (the old link stops working)</button>' : '') + '</section>';
      html += '<section class="card"><h2>Who’s in</h2><ul class="members">' + k.members.map(function (m) {
        var me = m.id === k.me;
        return '<li><span class="em" aria-hidden="true">' + esc(m.emoji) + '</span><span class="nm">' + esc(m.name) + (m.host ? ' <span class="small muted">· host</span>' : '') + '</span>' + (me ? '<span class="you">you</span><button type="button" class="btn small ghost" data-act="renameme">Change</button>' : (k.host && !m.host ? '<button type="button" class="btn small ghost danger" data-act="rmmember" data-mid="' + esc(m.id) + '">Remove</button>' : '')) + '</li>';
      }).join('') + '</ul></section>';
    } else if (isLocal()) {
      html += '<section class="card online-cta"><h2>📲 Share with my household</h2><p>Right now this kitchen lives on this phone. Put it online and everyone you live with sees the same fridge - Ate it on one phone is gone on the other.</p>' +
        '<p class="small muted">You need a free account to host it (so it’s yours to run and delete); nobody else does - they join with a code. Everything you’ve added and your history come along.</p><button type="button" class="btn" data-act="goonline">Put it online</button></section>';
    } else {
      html += '<section class="card online-cta"><h2>📲 One kitchen, everyone’s phone</h2><p>In your own kitchen, put it online and the household joins with a six-character code - no account for them.</p><button type="button" class="btn" data-act="startlocal">Start my kitchen</button></section>';
    }
    if (isLocal() || (isOnline() && k.host)) {
      html += '<section class="card"><h2>Kitchen</h2><form class="addrow" id="renameForm"><input class="input" id="renameIn" maxlength="' + C.LIMITS.kitchenName + '" value="' + esc(k.name) + '" aria-label="Kitchen name"><button class="btn ghost" type="submit">Rename</button></form>' +
        '<p class="small muted" style="margin-top:10px">Days turn over at midnight in ' + esc(k.tz) + '.</p>' +
        '<button type="button" class="btn ghost danger" data-act="delkitchen">' + (isLocal() ? 'Clear this kitchen from this phone' : 'Delete the kitchen and its history') + '</button></section>';
    } else if (isOnline()) {
      html += '<section class="card"><p class="small muted">Days turn over at midnight in ' + esc(k.tz) + '.</p><button type="button" class="link-btn danger" data-act="leave">Leave this kitchen</button></section>';
    }
    html += '<section class="card"><h2>About the dates</h2><p class="small">Each food’s date starts from how long it typically keeps in a home fridge, freezer or pantry - and resets when you open it or freeze it. They’re a guide to what to eat first, <b>not a food-safety check</b>. The printed date on the pack wins; your eyes and nose decide.</p><p class="small muted">No reminders or notifications: there’s no sender on this platform, and a fridge app that pings is one people mute. Open it when you’re deciding what to eat.</p></section>';
    el.className = 'tabgrid';
    el.innerHTML = html;
    var rf = $('#renameForm', el);
    if (rf) rf.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('#renameIn', el).value;
      if (isOnline()) return api('PATCH', 'api/kitchens/' + KITCHEN_ID, { name: name }).then(function (d) { setBundle(d); draw(); toast('Renamed'); }).catch(function (err) { showError(err); });
      var n = C.cleanText(name, C.LIMITS.kitchenName);
      if (!n) return toast('Give the kitchen a name.');
      state.k.name = n; saveLocal(); draw(); toast('Renamed');
    });
  }
  function showQr() {
    var o = document.createElement('div');
    o.className = 'qrfull'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'Join code');
    o.innerHTML = '<button type="button" class="btn small ghost" id="qrClose">Close</button><div class="qrbox">' + QR.svg(joinLink(), 'QR code to join ' + state.k.name) + '</div><p class="code">' + esc(state.k.display) + '</p><p>Scan to join ' + esc(state.k.name) + '</p>';
    document.body.appendChild(o);
    function close() { o.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    $('#qrClose', o).addEventListener('click', close);
    o.addEventListener('click', function (e) { if (e.target === o) close(); });
    document.addEventListener('keydown', onKey);
    $('#qrClose', o).focus();
  }
  function emojiGrid(selected, taken) {
    return '<div class="emojis" role="radiogroup" aria-label="Emoji">' + C.EMOJI.map(function (e) {
      return '<button type="button" class="emo' + (taken && taken.indexOf(e) >= 0 && e !== selected ? ' taken' : '') + '" role="radio" aria-checked="' + (e === selected) + '" data-act="emo" data-emo="' + esc(e) + '">' + esc(e) + '</button>';
    }).join('') + '</div>';
  }
  /** Who you are, for going online, joining or a name change. */
  function nameSheet(title, lead, cta, initial, taken, then) {
    var pick = { emoji: initial.emoji };
    sheet('<h2>' + esc(title) + '</h2><p class="small muted">' + esc(lead) + '</p><form id="nmForm" class="stack"><label class="field"><span>Your name</span><input class="input" id="nmName" maxlength="' + C.LIMITS.memberName + '" autocomplete="given-name" value="' + esc(initial.name || '') + '" placeholder="First name or nickname"></label>' +
      '<div class="field"><span>Pick an emoji</span>' + emojiGrid(pick.emoji, taken) + '</div><div id="nmErr"></div><button class="btn block big" type="submit">' + esc(cta) + '</button></form>', function (root) {
      root.__pick = pick;
      $('#nmForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        then({ name: $('#nmName', root).value, emoji: pick.emoji }, $('#nmErr', root), $('button[type=submit]', root));
      });
    });
  }
  function goOnline() {
    if (!signedIn()) return openAccount('Hosting a kitchen online needs a free account - so it’s yours to run and delete. Nobody else needs one: they join with a code.', goOnline);
    var local = readLocal();
    if (!local) return;
    nameSheet('Put ' + local.name + ' online', 'This is how the others see you in the kitchen. No email is shown to anyone.', 'Put it online', { emoji: C.EMOJI[0] }, [], function (me, errBox, btn) {
      btn.disabled = true;
      api('POST', 'api/kitchens', { kitchen: { name: local.name, created: local.created, items: local.items, history: local.history }, me: me, tz: local.tz }).then(function (d) {
        keep(K_LOCAL, null);
        rememberKitchen(d.id, d.kitchen.name);
        location.href = BASE + 'k/' + d.id + '#kitchen';
      }).catch(function (e) { btn.disabled = false; showError(e, errBox); });
    });
  }

  /* ---------------- join ---------------- */

  function drawJoin() {
    var main = $('#main');
    var j = state.join;
    if (!j) { main.innerHTML = '<p class="busy" role="status">Finding the kitchen…</p>'; return; }
    if (j.error) {
      main.innerHTML = '<section class="card center gone"><div class="big-emoji" aria-hidden="true">🔑</div><h1>That code didn’t work</h1><p class="muted">' + esc(j.error) + '</p>' + joinBox() + '<a class="btn ghost" href="' + esc(BASE) + '#start">Back to the start</a></section>' + footer();
      wireCodeForm(main);
      return;
    }
    main.innerHTML = '<section class="card joincard"><div class="big-emoji" aria-hidden="true">🥬</div><p class="eyebrow">You’re invited to</p><h1>' + esc(j.name) + '</h1><p class="muted">' + plural(j.members, 'person', 'people') + ' keeping one fridge, eating what’s going off first. Tap Ate it, find tonight’s recipe, and see what you’ve saved together.</p>' +
      (j.full ? '<p class="err">This kitchen is full.</p>' : '<form id="joinForm" class="stack"><h2>Join as</h2><label class="field"><span>Your name</span><input class="input" id="jName" maxlength="' + C.LIMITS.memberName + '" autocomplete="given-name" placeholder="First name or nickname"></label>' +
        '<div class="field"><span>Pick an emoji</span>' + emojiGrid(j.pick, j.takenEmoji) + '</div><div id="jErr"></div><button class="btn block big" type="submit">Join the kitchen</button>' +
        '<p class="small muted center">No account needed - this phone remembers you.</p></form>') + '</section>' + GUIDE + footer();
    var f = $('#joinForm');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('button[type=submit]', f);
      btn.disabled = true;
      api('POST', 'api/join/' + JOIN_CODE, { name: $('#jName').value, emoji: j.pick }).then(function (r) {
        location.href = BASE + 'k/' + r.kitchenId + '#eat';
      }).catch(function (err) { btn.disabled = false; showError(err, $('#jErr')); });
    });
  }
  function joinBox() {
    return '<form class="addrow joinbox" id="codeForm"><input class="input code-in" id="codeIn" maxlength="9" autocapitalize="characters" autocomplete="off" placeholder="ABC-DEF" aria-label="Join code"><button class="btn" type="submit">Join</button></form>';
  }
  function wireCodeForm(root) {
    var f = $('#codeForm', root);
    if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var c = $('#codeIn', root).value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length !== 6) return toast('Codes are six characters, like ABC-DEF.');
      location.href = BASE + 'j/' + c;
    });
  }
  function loadJoin() {
    api('GET', 'api/join/' + JOIN_CODE).then(function (j) {
      if (j.already) { location.replace(BASE + 'k/' + j.already + '#eat'); return; }
      var free = C.EMOJI.filter(function (e) { return j.takenEmoji.indexOf(e) < 0; });
      j.pick = free[Math.floor(Math.random() * free.length)] || C.EMOJI[0];
      state.join = j; draw();
    }).catch(function (e) { state.join = { error: e.message }; draw(); });
  }
  function openJoinKitchen() {
    var list = recall(K_LIST) || [];
    sheet('<h2>Join a household kitchen</h2><p class="small muted">Type the six-character code under their QR code, or open the link they sent.</p>' + joinBox() +
      (list.length ? '<h3>Kitchens on this phone</h3><ul class="tlist">' + list.map(function (c) { return '<li><a href="' + esc(BASE + 'k/' + c.id) + '"><b>' + esc(c.name) + '</b></a></li>'; }).join('') + '</ul>' : ''), function (root) { wireCodeForm(root); });
  }
  function openStartOwn(reason) {
    var local = readLocal();
    sheet('<h2>Make it yours</h2><p class="muted">' + esc(reason) + ' Your own kitchen takes a minute, with no account.</p><button type="button" class="btn block big" data-act="startlocal">' + (local ? 'Open ' + esc(local.name) : 'Start my kitchen') + '</button><button type="button" class="btn ghost block" data-act="joinkitchen">Join a household kitchen</button><button type="button" class="btn ghost block" data-act="closesheet">Keep looking around</button>');
  }

  /* ---------------- account ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var lastFocus = null;
  function openSheetOpen() { return !$('#sheet').hidden; }
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.__form = null; s.__pick = null; s.__change = null; s.__placeChange = null;
    s.hidden = false; back.hidden = false;
    document.body.classList.add('sheet-open');
    s.scrollTop = 0;
    if (onOpen) onOpen(s);
    // Focus the heading, not a field: on a phone a focused field throws up
    // the keyboard over the very thing being read.
    var f = s.querySelector('h2') || s.querySelector('button:not(.close)');
    if (f && f.tagName === 'H2') f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  var FREE_LINE = 'Nothing in Shelf Life needs an account except two things: hosting a kitchen online for your household, and the AI features (snap the fridge, a chef’s idea) - a free account comes with $2 of AI credit. One account works across every app on this site.';

  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center" style="margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); afterSignIn(then); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { afterSignIn(then); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function afterSignIn(then) {
    if (then) return then();
    if (isOnline()) { state.k = null; loadOnline().then(startPolling); return; }
    if (state.view === 'join') return loadJoin();
    draw();
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">A snap or a chef’s idea costs a cent or two. The board, recipes, stats and sharing are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); if (isOnline()) location.reload(); });
        });
        var pk = $('#pkEnrol', root);
        if (pk) pk.addEventListener('click', function () {
          var pw = prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        });
      });
  }
  function drawBilling(el) {
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" type="button" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button><p class="small muted">Membership covers every app on this site, runs the better model and lets you add credit.</p>';
        $('#joinM', el).addEventListener('click', function () { checkout('api/auth/billing/membership', {}); });
        return;
      }
      el.innerHTML = '<div class="row">' + (b.topUps || []).map(function (t) { return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) { btn.addEventListener('click', function () { checkout('api/auth/billing/credit', { usd: Number(btn.getAttribute('data-usd')) }); }); });
    }).catch(function () { el.innerHTML = ''; });
  }
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Adding by hand, the board, the recipes and the stats keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- a little joy ---------------- */

  function pop(btn, emoji) {
    if (REDUCED || !btn || !btn.getBoundingClientRect) return;
    var r = btn.getBoundingClientRect();
    var p = document.createElement('div');
    p.className = 'pop'; p.style.left = (r.left + r.width / 2) + 'px'; p.style.top = (r.top + r.height / 2) + 'px';
    var out = '';
    for (var i = 0; i < 6; i++) { var a = (Math.PI * 2 * i) / 6; out += '<span style="--dx:' + Math.round(Math.cos(a) * 46) + 'px;--dy:' + Math.round(Math.sin(a) * 46 - 20) + 'px">' + esc(emoji) + '</span>'; }
    p.innerHTML = out;
    document.body.appendChild(p);
    setTimeout(function () { p.remove(); }, 900);
  }
  function celebrate() { pop($('.tab.on') || document.body, '✨'); }

  /* ---------------- one click listener ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    var sh = $('#sheet');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'tab': {
        var tab = t.getAttribute('data-tab');
        state.tab = tab;
        closeSheet(true);
        history.pushState(null, '', location.pathname + '#' + tabHash(tab));
        draw(); scrollTo(0, 0);
        break;
      }
      case 'jump': {
        e.preventDefault();
        var target = $('#band-' + t.getAttribute('data-band'));
        if (target) { if (target.tagName === 'DETAILS') target.open = true; target.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); }
        break;
      }
      case 'example': go('example'); break;
      case 'startlocal': startLocal(); break;
      case 'openlocal': go('eat'); break;
      case 'joinkitchen': openJoinKitchen(); break;
      case 'nowelcome': state.welcome = false; draw(); break;
      case 'signin': openAccount(); break;
      case 'signin-snap': openAccount('A free account comes with $2 of AI credit. A snap costs about a cent or two.', openSnap); break;
      case 'signin-idea': openAccount('A free account comes with $2 of AI credit. An idea costs about a cent.', function () { state.tab = 'tonight'; draw(); }); break;
      case 'done': {
        var out = t.getAttribute('data-out');
        if (out === 'ate') pop(t, '✨');
        doRun('done', { iid: t.getAttribute('data-iid'), outcome: out }).catch(function () {});
        break;
      }
      case 'itemact': {
        var what = t.getAttribute('data-do');
        doRun('act', { iid: t.getAttribute('data-iid'), action: what, days: what === 'extend' ? 1 : undefined }).catch(function () {});
        break;
      }
      case 'sheetact': {
        var w = t.getAttribute('data-do');
        if (w === 'extend3') doRun('act', { iid: t.getAttribute('data-iid'), action: 'extend', days: 3 }).catch(function () {});
        else doRun('act', { iid: t.getAttribute('data-iid'), action: w }).catch(function () {});
        break;
      }
      case 'edititem': openItem(t.getAttribute('data-iid')); break;
      case 'removeitem': doRun('remove', { iid: t.getAttribute('data-iid') }).catch(function () {}); break;
      case 'undo': {
        var eid = t.getAttribute('data-eid');
        $$('.toast').forEach(function (x) { x.remove(); });
        doRun('undo', { eid: eid }).catch(function () {});
        break;
      }
      case 'addcat': openAdd(t.getAttribute('data-cat'), null); break;
      case 'addfree': openAdd(null, state.q); break;
      case 'pickshop': {
        var cid = t.getAttribute('data-cat');
        if (state.picks[cid]) delete state.picks[cid]; else state.picks[cid] = true;
        var y = window.scrollY;
        drawAdd();
        scrollTo(0, y);
        break;
      }
      case 'addpicks': addPicks(); break;
      case 'snap': openSnap(); break;
      case 'leftovers': openLeftovers(); break;
      case 'shareshop': shareText(state.k.name + ' - before you shop', C.shoppingText(C.shopping(state.k, today()), state.k.name)); break;
      case 'copyshop': copy(C.shoppingText(C.shopping(state.k, today()), state.k.name), 'List copied'); break;
      case 'step': {
        var f = sh.__form; if (!f) break;
        f.qty = Math.max(1, Math.min(C.LIMITS.qty, (f.qty || 1) + Number(t.getAttribute('data-d'))));
        var o = $('#' + t.getAttribute('data-for'), sh); if (o) o.textContent = f.qty;
        break;
      }
      case 'place': {
        if (!sh.__form) break;
        setRadio(t); sh.__form.place = t.getAttribute('data-v');
        if (sh.__placeChange) sh.__placeChange();
        break;
      }
      case 'pickdate': {
        // The phone's own date picker, opened from a chip - the bare
        // native field reads "mm/dd/yyyy", which is not a date anyone chose.
        var inp = $('[data-pick]', sh);
        if (!inp) break;
        try { inp.showPicker(); } catch (err) { inp.removeAttribute('tabindex'); inp.classList.remove('vh'); inp.classList.add('input'); inp.focus(); }
        break;
      }
      case 'date': {
        if (!sh.__form) break;
        setRadio(t);
        sh.__form.date = t.getAttribute('data-mode') === 'typical' ? { mode: 'typical' } : { mode: 'n', n: Number(t.getAttribute('data-n')) };
        if (sh.__change) sh.__change();
        break;
      }
      case 'cook': {
        var rid = t.getAttribute('data-rid');
        var rec = C.RECIPES.filter(function (r) { return r.id === rid; })[0];
        if (!rec) break;
        var m = C.matchRecipe(rec, items(), today());
        openCook(rec.title, m.used, m.nice);
        break;
      }
      case 'cookidea': {
        if (!state.idea) break;
        openCook(state.idea.title, state.idea.uses.map(itemById).filter(Boolean), []);
        break;
      }
      case 'idea': getIdea(t); break;
      case 'more': state.more = !state.more; drawTonight(); break;
      case 'range': state.range = t.getAttribute('data-v'); drawSaved(); break;
      case 'goonline': goOnline(); break;
      case 'qrbig': showQr(); break;
      case 'sharejoin': {
        var link = joinLink();
        if (navigator.share) navigator.share({ title: state.k.name, text: 'Join ' + state.k.name + ' on Shelf Life - our fridge, so we eat what’s going off first:', url: link }).catch(function () { /* closed */ });
        else copy(link, 'Link copied');
        break;
      }
      case 'copyjoin': copy(joinLink(), 'Link copied'); break;
      case 'rotate':
        if (confirm('Make a new code? The old link and QR stop working; nobody already in is affected.')) api('POST', 'api/kitchens/' + KITCHEN_ID + '/code', {}).then(function (d) { setBundle(d); draw(); toast('New code ready'); }).catch(function (err) { showError(err); });
        break;
      case 'renameme': {
        var me = state.k.members.filter(function (x) { return x.id === state.k.me; })[0];
        if (!me) break;
        nameSheet('Your name', 'How the others in ' + state.k.name + ' see you.', 'Save', me, state.k.members.filter(function (x) { return x.id !== me.id; }).map(function (x) { return x.emoji; }), function (body, errBox) {
          api('PATCH', 'api/kitchens/' + KITCHEN_ID + '/members/' + me.id, body).then(function (d) { setBundle(d); closeSheet(); draw(); toast('Saved'); }).catch(function (err) { showError(err, errBox); });
        });
        break;
      }
      case 'rmmember': {
        var mid = t.getAttribute('data-mid');
        if (!confirm('Remove ' + memberName(mid) + ' from the kitchen? What they ate stays in the history.')) break;
        api('DELETE', 'api/kitchens/' + KITCHEN_ID + '/members/' + mid).then(function (d) { setBundle(d); draw(); toast('Removed'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'leave':
        if (!confirm('Leave ' + state.k.name + '? You can join again with the code.')) break;
        api('DELETE', 'api/kitchens/' + KITCHEN_ID + '/members/' + state.k.me).then(function () { forgetKitchen(KITCHEN_ID); location.href = BASE + '#start'; }).catch(function (err) { showError(err); });
        break;
      case 'delkitchen':
        if (isLocal()) {
          if (confirm('Clear ' + state.k.name + ' from this phone? Its food and history are deleted. This can’t be undone.')) { keep(K_LOCAL, null); location.href = BASE + '#start'; }
        } else if (confirm('Delete ' + state.k.name + ' for everyone, with all its history? This can’t be undone.')) {
          api('DELETE', 'api/kitchens/' + KITCHEN_ID).then(function () { forgetKitchen(KITCHEN_ID); location.href = BASE + '#start'; }).catch(function (err) { showError(err); });
        }
        break;
      case 'emo': {
        setRadio(t);
        if (sh.contains(t) && sh.__pick) sh.__pick.emoji = t.getAttribute('data-emo');
        else if (state.join) state.join.pick = t.getAttribute('data-emo');
        break;
      }
      default: break;
    }
  });
  function setRadio(t) {
    var group = t.closest('[role=radiogroup]');
    if (group) $$('[role=radio]', group).forEach(function (b) { b.setAttribute('aria-checked', String(b === t)); });
  }

  /* ---------------- start ---------------- */

  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  if (JOIN_CODE) { state.view = 'join'; draw(); loadMe().then(loadJoin); }
  else {
    route();
    loadMe().then(function () {
      if (state.view === 'start') loadMyKitchens();
      if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
    });
  }
})();
