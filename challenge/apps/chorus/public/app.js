/* Chorus - the page. One file, no build step. Every string that came from
 * outside this file (a typed name or chore, a model's suggestion, anything
 * from the server) is escaped before it is drawn, and no handler is written
 * into markup: clicks are routed by data-act attributes from one listener
 * (the lab's CSP allows script from this origin only). The rules - the deal,
 * ticks, swaps, fairness - are chorus-core.js, the same file the server and
 * the tests run.
 *
 * Where a household can live:
 *   example - The Garcias (sample.js), the first thing to try. Ticks and
 *             swaps work, on this phone only; nothing is saved.
 *   local   - "Start on this phone": the household is in localStorage on
 *             this device, no account, no server. The fridge-chart phone.
 *   online  - h/<id>: put online by a host with a free account; everyone
 *             else joined by code, link or QR with a name and an emoji.
 *   join    - j/<code>: which one is you?
 */
(function () {
  'use strict';

  var C = window.ChorusCore;
  var S = window.ChorusSample;
  var QR = window.ChorusQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_HOME = 'chorus-home-v1';
  var K_HOMES = 'chorus-homes-v1';
  var K_LAST = 'chorus-last-v1';
  var POLL_MS = 5000;
  var PHOTO_PX = 1600;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }());
  var HOME_ID = (function () { var m = /\/h\/([A-Za-z0-9_-]{16})\/?$/.exec(location.pathname); return m ? m[1] : null; }());
  var JOIN_CODE = (function () { var m = /\/j\/([A-Za-z0-9-]{4,16})\/?$/.exec(location.pathname); return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null; }());
  var TABS = [['week', '✅', 'This week'], ['fair', '⚖️', 'Fairness'], ['chores', '🧽', 'Chores'], ['people', '👥', 'People']];
  var CHORE_EMOJI = ['🧹', '🧽', '🍽️', '🗑️', '♻️', '🛁', '🚽', '🧺', '🧦', '🛏️', '🍳', '🛒', '🪴', '🐶', '🐱', '🧸', '🪣', '🪟', '🧊', '🚗', '💳', '📦', '🌿', '🧻'];

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var plural = C.plural;

  var state = {
    me: null,          // the account, if any
    view: 'start',     // start | new | house | join
    kind: null,        // example | local | online
    tab: 'week',
    home: null,        // {name, tz, me, members, chores, ...}
    weeks: [],         // this week first, then the ones before it (null where missing)
    week: null,
    today: 0,
    join: null,
    wiz: null,
    timer: null,
    welcome: false,
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
  function toast(msg, ms) {
    $$('.toast').forEach(function (old) { old.remove(); });
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function isExample() { return state.kind === 'example'; }
  function isLocal() { return state.kind === 'local'; }
  function isOnline() { return state.kind === 'online'; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The starter chores are free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }

  /* ---------------- households remembered on this phone ---------------- */

  function rememberHome(id, name) {
    var list = (recall(K_HOMES) || []).filter(function (c) { return c && c.id !== id; });
    list.unshift({ id: id, name: String(name || '').slice(0, 60) });
    keep(K_HOMES, list.slice(0, 20));
    keep(K_LAST, { id: id });
  }
  function forgetHome(id) {
    keep(K_HOMES, (recall(K_HOMES) || []).filter(function (c) { return c && c.id !== id; }));
    var last = recall(K_LAST);
    if (last && last.id === id) keep(K_LAST, null);
  }

  /* ---------------- the household on this phone ---------------- */

  /** What this phone keeps: {home: {name, tz, me, members, chores}, weeks:
   *  {'YYYY-MM-DD': doc}}. Read defensively - it is this app's own data,
   *  but a phone can hold anything. */
  function readLocal() {
    var raw = recall(K_HOME);
    if (!raw || !raw.home || !Array.isArray(raw.home.members) || !Array.isArray(raw.home.chores) || !raw.home.members.length) return null;
    return raw;
  }
  function weeksArray(map, week) {
    var out = [];
    for (var i = 0; i < C.LIMITS.keepWeeks; i++) { var k = C.addWeeks(week, -i); out.push(map && map[k] ? map[k] : null); }
    return out;
  }
  /** This week dealt (or re-dealt after a change), with what came before. */
  function prepare(home, map) {
    var week = C.weekKey(Date.now(), home.tz);
    var arr = weeksArray(map, week);
    var cur = C.ensureWeek(home, arr[0], week, arr.slice(1));
    arr[0] = cur;
    return { week: week, weeks: arr, changed: cur !== (map && map[week]) };
  }
  function saveLocal() {
    if (!isLocal()) return;
    var map = {};
    state.weeks.forEach(function (d) { if (d) map[d.week] = d; });
    keep(K_HOME, { home: state.home, weeks: map });
  }
  function openLocal() {
    var raw = readLocal();
    if (!raw) return false;
    var p = prepare(raw.home, raw.weeks);
    state.kind = 'local'; state.view = 'house';
    state.home = raw.home; state.week = p.week; state.weeks = p.weeks; state.today = C.dayIndex(Date.now(), raw.home.tz);
    if (p.changed) saveLocal();
    return true;
  }
  function openExample() {
    var s = S.state(Date.now(), TZ);
    state.kind = 'example'; state.view = 'house';
    state.home = s.home; state.week = s.week; state.weeks = s.weeks; state.today = s.today;
  }
  /** Re-deal after an edit on this phone (people or chores changed). */
  function redeal() {
    var cur = C.ensureWeek(state.home, state.weeks[0], state.week, state.weeks.slice(1));
    state.weeks[0] = cur;
    saveLocal();
  }

  /* ---------------- the household online ---------------- */

  function setBundle(d) {
    state.kind = 'online'; state.view = 'house';
    state.home = d.home; state.week = d.week; state.today = d.today;
    state.weeks = d.weeks;
    rememberHome(d.home.id, d.home.name);
  }
  function loadOnline(quiet) {
    var q = state.home && isOnline() ? '?since=' + state.home.v + '&week=' + encodeURIComponent(state.week) : '';
    return api('GET', 'api/homes/' + HOME_ID + q).then(function (d) {
      if (d.same) return;
      setBundle(d);
      draw();
    }).catch(function (e) {
      if (e.status === 404) {
        forgetHome(HOME_ID);
        stopPolling();
        state.home = null;
        $('#main').innerHTML = '<section class="card center gone"><div class="big-emoji" aria-hidden="true">🏠</div><h1>This household isn’t here for you</h1><p class="muted">' +
          esc(e.message === 'No household here.' ? 'You may have been removed, the household was deleted, or this browser forgot you. If you have the code, join again.' : e.message) + '</p>' +
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
    if (isOnline() && state.home) { loadOnline(true); startPolling(); }
    if (isLocal() && state.view === 'house' && C.weekKey(Date.now(), state.home.tz) !== state.week) { openLocal(); draw(); }
  });

  /* ---------------- who is acting ---------------- */

  function actor() {
    if (isExample()) return { mid: S.ME, host: true, local: true };
    if (isLocal()) return { mid: state.home.me || null, host: true, local: true };
    return { mid: state.home.me, host: state.home.host, local: false };
  }
  function member(id) { var ms = state.home.members; for (var i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i]; return null; }
  function chore(id) { var cs = state.home.chores; for (var i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i]; return null; }
  function colorOf(id) { var i = state.home.members.map(function (m) { return m.id; }).indexOf(id); return i < 0 ? 'pc-x' : 'pc-' + (i % 12); }
  function nameOf(id) { var m = member(id); return m ? m.name : 'Someone who left'; }
  function who(id, opts) {
    var m = member(id);
    var me = isOnline() && id === state.home.me;
    return '<span class="who"><span class="av ' + colorOf(id) + '" aria-hidden="true">' + esc(m ? m.emoji : '👤') + '</span><span class="nm">' + esc(m ? m.name : 'Someone who left') + '</span>' + (me && !(opts && opts.noYou) ? '<span class="you">you</span>' : '') + '</span>';
  }
  function dots(n) {
    var s = '<span class="dots" role="img" aria-label="Effort ' + n + ' of 5, ' + esc(C.EFFORT[n].toLowerCase()) + '">';
    for (var i = 1; i <= 5; i++) s += '<span class="dot' + (i <= n ? ' on' : '') + '" aria-hidden="true"></span>';
    return s + '</span>';
  }
  function freqLabel(f) { for (var i = 0; i < C.FREQS.length; i++) if (C.FREQS[i].id === f) return C.FREQS[i].label; return f; }
  function weightLabel(w) {
    if (w === 1) return 'Full share';
    if (w === 0.5) return 'Counts half';
    for (var i = 0; i < C.WEIGHTS.length; i++) if (C.WEIGHTS[i].v === w) return C.WEIGHTS[i].label;
    return 'Share ' + w;
  }
  function choreNames(ids) { return ids.map(function (id) { var c = chore(id); return c ? c.name : null; }).filter(Boolean); }

  /* ---------------- routing ---------------- */

  function go(hash) { history.pushState(null, '', BASE + (hash ? '#' + hash : '')); route(); scrollTo(0, 0); }
  function route() {
    stopPolling();
    closeSheet(true);
    var h = location.hash.replace(/^#/, '');
    if (JOIN_CODE) { state.view = 'join'; draw(); return; }
    if (HOME_ID) {
      var t = h.split('/')[0];
      state.tab = tabName(t);
      if (state.home && isOnline()) { draw(); startPolling(); return; }
      $('#main').innerHTML = '<p class="busy" role="status">Opening the household…</p>';
      loadOnline().then(startPolling);
      return;
    }
    if (/^example(\/|$)/.test(h)) {
      if (!isExample()) openExample();
      state.tab = tabName(h.split('/')[1]);
      draw(); return;
    }
    if (h === 'new') { state.view = 'new'; if (!state.wiz) state.wiz = newWizard(); draw(); return; }
    if (h === 'start') { state.view = 'start'; state.kind = null; draw(); return; }
    if (openLocal()) { state.tab = tabName(h); draw(); return; }
    var last = recall(K_LAST);
    if (!h && last && last.id && /^[A-Za-z0-9_-]{16}$/.test(last.id)) { location.replace(BASE + 'h/' + last.id); return; }
    state.view = 'start'; state.kind = null; draw();
  }
  function tabName(t) { for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === t) return t; return 'week'; }
  function tabHash(t) { return isExample() ? 'example/' + t : t; }
  window.addEventListener('popstate', route);

  /* ---------------- drawing: the shell ---------------- */

  function draw() {
    drawTop();
    var main = $('#main');
    if (state.view === 'start') { main.innerHTML = startHtml() + footer(); wireCodeForm(main); return loadMyHomes(); }
    if (state.view === 'new') return drawWizard();
    if (state.view === 'join') return drawJoin();
    if (!state.home) return;
    var h = state.home;
    var html = '';
    if (isExample()) {
      html += '<section class="strip" aria-label="About this example"><p><b>This is an example home.</b> Tick a chore, swap one, look at Fairness - nothing here is saved.</p>' +
        '<div class="row"><button class="btn big light" type="button" data-act="new">Start your own</button><button class="btn ghost-light" type="button" data-act="joinhome">Join a household</button></div></section>';
    }
    if (state.welcome) {
      html += '<section class="welcome card" role="status"><div class="big-emoji" aria-hidden="true">🎉</div><div><h2>Here’s your first week</h2><p class="muted">Chorus dealt it by effort and capacity. Tap a chore when it’s done. When you’re ready, put the household online from <b>People</b> so everyone ticks from their own phone.</p><button class="btn small ghost" type="button" data-act="nowelcome">Got it</button></div></section>';
    }
    html += '<header class="homehead"><div><p class="eyebrow">' + (isExample() ? 'Example household' : isLocal() ? 'On this phone' : (h.host ? 'You host' : 'Household')) + '</p><h1>' + esc(h.name) + '</h1></div>' +
      '<div class="faces" aria-label="' + esc(plural(h.members.length, 'person', 'people')) + '">' + h.members.slice(0, 8).map(function (m) { return '<span class="face ' + colorOf(m.id) + '" title="' + esc(m.name) + '" aria-hidden="true">' + esc(m.emoji) + '</span>'; }).join('') +
      (h.members.length > 8 ? '<span class="face more">+' + (h.members.length - 8) + '</span>' : '') + '</div></header>';
    html += '<nav class="tabbar dk-tabbar" aria-label="Household"><div class="tabbar-inner"><a class="rail-brand" href="' + esc(BASE) + '#start"><span aria-hidden="true">🧹</span>' + esc(h.name) + '</a>' + TABS.map(function (t) {
      var on = state.tab === t[0];
      return '<button type="button" class="tab' + (on ? ' on' : '') + '" data-act="tab" data-tab="' + t[0] + '"' + (on ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span>' + t[2] + '</button>';
    }).join('') + '</div></nav>';
    html += '<div id="tabView"></div>' + footer();
    main.innerHTML = html;
    ({ week: drawWeek, fair: drawFair, chores: drawChores, people: drawPeople })[state.tab]();
  }
  function footer() {
    return '<footer class="foot small muted"><p>Chorus is a <a href="' + esc(BASE) + '../">Challenge Lab</a> app. <a href="https://strongtechnicalconsulting.com/privacy">Privacy</a> · nobody but the host needs an account; one account works across every app on this site.</p></footer>';
  }

  /* ---------------- the start screen ---------------- */

  function startHtml() {
    var local = readLocal();
    var html = '<section class="hero"><div class="hero-art" aria-hidden="true"><span>🧺</span><span>🧹</span><span>🍽️</span></div>' +
      '<h1>Chores split fairly - and everyone can see it.</h1>' +
      '<p class="lede">Chorus deals out the week’s chores by how big each job is, who can’t do what, and who had the worst one last time. Tick them off, swap, and see who’s really carrying the house.</p></section>' +
      '<div class="choices">' +
      '<button type="button" class="choice" data-act="example"><span class="ci" aria-hidden="true">👀</span><span class="ct"><b>See an example home</b><span>The Garcias, halfway through their week.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      (local ? '<button type="button" class="choice primary" data-act="openlocal"><span class="ci" aria-hidden="true">🏠</span><span class="ct"><b>Open ' + esc(local.home.name) + '</b><span>Your household on this phone.</span></span><span class="chev" aria-hidden="true">›</span></button>'
        : '<button type="button" class="choice primary" data-act="new"><span class="ci" aria-hidden="true">🏠</span><span class="ct"><b>Start on this phone</b><span>No account. Ready in a minute.</span></span><span class="chev" aria-hidden="true">›</span></button>') +
      '<button type="button" class="choice" data-act="joinhome"><span class="ci" aria-hidden="true">🔑</span><span class="ct"><b>Join a household</b><span>Got a six-character code? Type it here.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '</div>';
    html += '<section class="card" id="myHomes" hidden></section>';
    html += '<section class="card how"><h2>How it works</h2><ol class="steps">' +
      '<li><span class="sn" aria-hidden="true">1</span><span><b>Pick a starter.</b> Roommates, a couple or a family with kids - each comes with the usual chores, ready to edit.</span></li>' +
      '<li><span class="sn" aria-hidden="true">2</span><span><b>Chorus deals the week.</b> Big jobs count more, kids count half, nobody gets what they can’t do, and the bathroom moves on every week.</span></li>' +
      '<li><span class="sn" aria-hidden="true">3</span><span><b>Tick, swap, nudge.</b> Everyone sees the same board, and Fairness shows who did what this month.</span></li>' +
      '</ol></section>';
    return html;
  }
  function loadMyHomes() {
    var box = $('#myHomes');
    if (!box) return;
    var local = recall(K_HOMES) || [];
    var p = signedIn() ? api('GET', 'api/homes').then(function (r) { return r.homes; }).catch(function () { return []; }) : Promise.resolve([]);
    p.then(function (rows) {
      var seen = {};
      var all = rows.map(function (c) { seen[c.id] = 1; return c; }).concat(local.filter(function (c) { return c && !seen[c.id]; }));
      if (!all.length || !$('#myHomes')) return;
      box.hidden = false;
      box.innerHTML = '<h2>Your households online</h2><ul class="tlist">' + all.map(function (c) {
        return '<li><a href="' + esc(BASE + 'h/' + c.id) + '"><b>' + esc(c.name) + '</b><span class="small muted">' + (c.host ? 'You host' : 'Member') + (c.members ? ' · ' + plural(c.members, 'person', 'people') : '') + '</span></a></li>';
      }).join('') + '</ul>';
    });
  }

  /* ---------------- This week ---------------- */

  function curDoc() { return state.weeks[0]; }
  function groupsOf(row) {
    var by = {}; var order = [];
    row.slots.forEach(function (s) { if (!by[s.chore]) { by[s.chore] = []; order.push(s.chore); } by[s.chore].push(s); });
    var idx = state.home.chores.map(function (c) { return c.id; });
    order.sort(function (a, b) { return idx.indexOf(a) - idx.indexOf(b); });
    return order.map(function (cid) { return { chore: chore(cid), slots: by[cid] }; });
  }
  var BORING = /^(It evens out|Shared out by day)/;
  function drawWeek() {
    var el = $('#tabView');
    var h = state.home;
    var doc = curDoc();
    var rows = C.board(h, doc);
    var ex = C.explain(h, doc, state.weeks.slice(1));
    var total = 0, done = 0;
    rows.forEach(function (r) { total += r.total; done += r.done; });
    var me = actor().mid;
    if (isOnline()) rows.sort(function (a, b) { return (b.id === me) - (a.id === me); });
    var hist = state.weeks.filter(Boolean);
    var html = '<section class="card weekhead full"><div class="sec-head"><div><p class="eyebrow">This week · ' + esc(C.weekLabel(state.week)) + '</p><h2>' + (total ? (done >= total ? 'Everything’s done 🎉' : plural(done, 'point') + ' of ' + total + ' done') : 'Nothing due this week') + '</h2></div>' +
      '<span class="pctbig" aria-hidden="true">' + (total ? Math.round(done / total * 100) : 0) + '%</span></div>' +
      '<div class="meter" role="img" aria-label="' + esc(done + ' of ' + total + ' points done') + '"><span style="width:' + (total ? Math.round(done / total * 100) : 0) + '%"></span></div>' +
      '<p class="small muted">' + esc(C.weekSummary(h, doc)) + '</p>' +
      (C.partialWeek(h, state.week) ? '<p class="note small" style="margin-bottom:0">This is a short first week - only what’s due from ' + (h.since === C.localDate(Date.now(), h.tz) ? 'today' : esc(C.DAY_NAMES[C.weekday(h.since)])) + ' on. Your first full week starts Monday.</p>' : '') + '</section>';
    // Up for grabs.
    var offers = [];
    Object.keys(doc.swaps || {}).forEach(function (k) { var s = doc.swaps[k]; if (s && s.state === 'offered' && !(doc.ticks || {})[k]) offers.push({ slot: k, from: s.from }); });
    if (offers.length) {
      html += '<section class="card grabs full"><h2>Up for grabs</h2><ul class="glist">' + offers.map(function (o) {
        var c = chore(o.slot.split('_')[0]); if (!c) return '';
        var sl = C.slotsFor(c, state.week).filter(function (x) { return x.id === o.slot; })[0];
        var mine = o.from === me && isOnline();
        return '<li><span class="gi" aria-hidden="true">' + esc(c.emoji) + '</span><span class="gb"><b>' + esc(c.name) + '</b><span class="small muted">' + esc(nameOf(o.from)) + ' is offering it · ' + esc(dayText(sl)) + ' · ' + plural(c.effort, 'point') + '</span></span>' +
          (mine ? '<button type="button" class="btn small ghost" data-act="swap" data-do="cancel" data-slot="' + esc(o.slot) + '">Take it back</button>'
            : '<button type="button" class="btn small" data-act="swap" data-do="claim" data-slot="' + esc(o.slot) + '">I’ll take it</button>') + '</li>';
      }).join('') + '</ul></section>';
    }
    html += '<div class="people">';
    rows.forEach(function (r) {
      var m = member(r.id);
      var groups = groupsOf(r);
      var allDone = r.slots.length && r.done >= r.total;
      var st = r.id ? C.streak(h, hist, r.id) : 0;
      html += '<section class="card person' + (allDone ? ' alldone' : '') + (r.id && r.id === me && isOnline() ? ' mine' : '') + '" aria-label="' + esc((m ? m.name : 'Nobody') + '’s chores') + '">';
      html += '<div class="phead">' + (r.id ? who(r.id) : '<span class="who"><span class="av pc-x" aria-hidden="true">❔</span><span class="nm">Nobody can</span></span>') +
        '<span class="pts"><b>' + r.done + '</b><span class="small muted"> / ' + r.total + ' pts</span></span></div>';
      if (r.id) html += '<div class="pmeta"><span class="minimeter ' + colorOf(r.id) + '" aria-hidden="true"><span style="width:' + (r.total ? Math.round(r.done / r.total * 100) : 0) + '%"></span></span>' +
        (st ? '<span class="streak" title="Weeks in a row with everything done">🔥 ' + plural(st, 'week') + '</span>' : '') +
        (m && m.weight !== 1 ? '<span class="small muted">' + esc(weightLabel(m.weight)) + '</span>' : '') + '</div>';
      if (allDone) html += '<p class="donebanner">All done this week 🎉</p>';
      if (!groups.length) html += '<p class="small muted">Nothing this week - a free pass.</p>';
      html += '<ul class="items">' + groups.map(function (g) { return itemHtml(r.id, g, ex); }).join('') + '</ul></section>';
    });
    html += '</div>';
    if (C.partialWeek(h, state.week)) html += previewHtml();
    var whys = [];
    rows.forEach(function (r) { groupsOf(r).forEach(function (g) { var t = ex[g.chore.id + ':' + (r.id || '-')]; if (t) whys.push('<li><span aria-hidden="true">' + esc(g.chore.emoji) + '</span> <b>' + esc(g.chore.name) + '</b> → ' + esc(r.id ? nameOf(r.id) : 'nobody') + '. <span class="muted">' + esc(t) + '</span></li>'); }); });
    html += '<details class="card whys full"><summary>Why the week looks like this</summary><p class="small muted">Every week Chorus balances points by each person’s share, keeps everyone off what they can’t do, and moves the least-liked jobs on. Same people and chores, same plan, on every phone.</p><ul>' + whys.join('') + '</ul></details>';
    el.innerHTML = html;
    el.className = 'tabgrid weekgrid';
  }
  /** A short first week: what next week will look like, dealt by the same
   *  rules from what is known now. A preview - Monday deals it for real. */
  function previewHtml() {
    var h = state.home;
    var next = C.addWeeks(state.week, 1);
    var d = C.deal(h, next, state.weeks, {});
    var doc = { week: next, basis: d.basis, assign: d.assign, ticks: {}, swaps: {} };
    var rows = C.board(h, doc);
    return '<section class="card preview full"><p class="eyebrow">Coming up · ' + esc(C.weekLabel(next)) + '</p><h2>Next week, at a glance</h2><p class="small muted">' + esc(C.weekSummary(h, doc)) + ' A preview - it’s dealt for real on Monday, and changes if you change the chores or people.</p><ul class="plist">' +
      rows.filter(function (r) { return r.id; }).map(function (r) {
        var g = groupsOf(r);
        return '<li><div class="phead">' + who(r.id) + '<span class="pts"><b>' + r.total + '</b><span class="small muted"> pts</span></span></div><div class="pchips">' +
          g.map(function (x) { return '<span class="pchip"><span aria-hidden="true">' + esc(x.chore.emoji) + '</span> ' + esc(x.chore.name) + (x.slots.length > 1 ? ' ×' + x.slots.length : '') + '</span>'; }).join('') + '</div></li>';
      }).join('') + '</ul></section>';
  }
  function dayText(s) {
    if (!s) return 'this week';
    if (s.day === null || s.day === undefined) return 'this week';
    if (s.day === state.today) return 'today';
    return C.DAYS[s.day];
  }
  function itemHtml(mid, g, ex) {
    var c = g.chore; var doc = curDoc();
    var why = ex[c.id + ':' + (mid || '-')];
    var meta = dots(c.effort) + '<span>' + esc(freqLabel(c.freq)) + '</span>';
    var offered = g.slots.filter(function (s) { return s.swap && s.swap.state === 'offered' && !s.done; }).length;
    var took = g.slots.filter(function (s) { return s.swap && s.swap.state === 'claimed' && s.swap.to === mid; }).length;
    if (offered) meta += '<span class="tagb warn">Up for grabs</span>';
    if (took) meta += '<span class="tagb good">Swapped in</span>';
    if (g.slots.length === 1) {
      var s = g.slots[0];
      var day = s.day === null ? '' : '<span class="tagb' + (s.day === state.today ? ' today' : '') + '">' + esc(dayText(s)) + '</span>';
      return '<li class="item' + (s.done ? ' done' : '') + '"><button type="button" class="tick" data-act="tick" data-slot="' + esc(s.id) + '" aria-pressed="' + s.done + '" aria-label="' + esc((s.done ? 'Undo ' : 'Done: ') + c.name) + '"><span aria-hidden="true">' + (s.done ? '✓' : '') + '</span></button>' +
        '<span class="ibody"><span class="iname"><span aria-hidden="true">' + esc(c.emoji) + '</span> <span class="nt">' + esc(c.name) + '</span></span><span class="imeta">' + day + meta + '</span>' +
        (why && !BORING.test(why) ? '<span class="why">' + esc(why) + '</span>' : '') + (s.done && s.doneBy && s.doneBy !== mid ? '<span class="why">Done by ' + esc(nameOf(s.doneBy)) + '</span>' : '') + '</span>' +
        '<button type="button" class="more" data-act="slot" data-slot="' + esc(s.id) + '" aria-label="' + esc('More for ' + c.name) + '">⋯</button></li>';
    }
    var all = g.slots.every(function (s) { return s.done; });
    return '<li class="item multi' + (all ? ' done' : '') + '"><span class="ibody"><span class="iname"><span aria-hidden="true">' + esc(c.emoji) + '</span> <span class="nt">' + esc(c.name) + '</span></span><span class="imeta">' + meta + '</span>' +
      '<span class="days">' + g.slots.map(function (s) {
        return '<button type="button" class="day' + (s.done ? ' done' : '') + (s.day === state.today ? ' today' : '') + (s.swap && s.swap.state === 'offered' && !s.done ? ' offered' : '') + '" data-act="tick" data-slot="' + esc(s.id) + '" aria-pressed="' + s.done + '" aria-label="' + esc((s.done ? 'Undo ' : 'Done: ') + c.name + ', ' + C.DAY_NAMES[s.day]) + '">' + esc(C.DAYS[s.day]) + (s.done ? ' ✓' : '') + '</button>';
      }).join('') + '</span>' + (why && !BORING.test(why) ? '<span class="why">' + esc(why) + '</span>' : '') + '</span>' +
      '<button type="button" class="more" data-act="slot" data-slot="' + esc(nextSlot(g.slots).id) + '" aria-label="' + esc('More for ' + c.name) + '">⋯</button></li>';
  }
  function nextSlot(slots) {
    var open = slots.filter(function (s) { return !s.done; });
    var later = open.filter(function (s) { return s.day >= state.today; });
    return later[0] || open[0] || slots[0];
  }
  function holderOf(slot) { return C.effective(curDoc())[slot] || null; }

  /** Tick or untick: on this phone the rules run here; online they run here
   *  first (so the tap answers at once) and then on the server, whose answer
   *  wins. */
  function doTick(slot, btn) {
    var doc = curDoc();
    var was = Boolean(doc.ticks && doc.ticks[slot]);
    var a = actor();
    var patch;
    try { patch = was ? C.untick(state.home, doc, slot) : C.tick(state.home, doc, slot, a, Date.now()); } catch (e) { return showError(e); }
    var holder = holderOf(slot);
    var before = personDone(holder);
    state.weeks[0] = C.applyPatch(doc, patch);
    if (!was) {
      celebrate(btn, chore(slot.split('_')[0]));
      if (!before && personDone(holder)) setTimeout(function () { bigCelebrate(nameOf(holder)); }, 250);
    } else toast('Undone');
    if (isLocal()) saveLocal();
    drawWeek();
    if (isOnline()) {
      api(was ? 'DELETE' : 'PUT', 'api/homes/' + HOME_ID + '/ticks/' + slot).then(function (d) { setBundle(d); if (state.tab === 'week' && !openSheetOpen()) drawWeek(); })
        .catch(function (e) { showError(e); loadOnline(true); });
    }
  }
  function personDone(mid) {
    if (!mid) return false;
    var r = C.board(state.home, curDoc()).filter(function (x) { return x.id === mid; })[0];
    return Boolean(r && r.slots.length && r.done >= r.total);
  }
  function doSwap(slot, action, to) {
    var doc = curDoc();
    var a = actor();
    if (isExample() && action === 'claim') a = { mid: S.ME, host: false, local: false };
    var patch;
    try { patch = C.swap(state.home, doc, slot, a, action, Date.now(), to); } catch (e) { return showError(e); }
    var c = chore(slot.split('_')[0]);
    var msg = action === 'offer' ? 'Offered - anyone can take it' : action === 'cancel' ? 'Offer taken back' : action === 'claim' ? 'It’s yours - the points moved with it' : 'Handed to ' + nameOf(to) + ' - the points moved with it';
    if (!isOnline()) {
      state.weeks[0] = C.applyPatch(doc, patch);
      saveLocal(); closeSheet(); draw(); toast(msg);
      return;
    }
    api('POST', 'api/homes/' + HOME_ID + '/swaps/' + slot, { action: action }).then(function (d) { setBundle(d); closeSheet(); draw(); toast(msg + (c ? '' : '')); })
      .catch(function (e) { showError(e); loadOnline(true); });
  }

  /* ---------------- a chore's sheet: why, swap, nudge ---------------- */

  function openSlot(slot) {
    var c = chore(slot.split('_')[0]); if (!c) return;
    var doc = curDoc();
    var holder = holderOf(slot);
    var mine = C.board(state.home, doc).filter(function (r) { return r.id === holder; })[0];
    var siblings = mine ? mine.slots.filter(function (s) { return s.chore === c.id; }) : [];
    var s = siblings.filter(function (x) { return x.id === slot; })[0] || { id: slot, day: null, done: false };
    var ex = C.explain(state.home, doc, state.weeks.slice(1))[c.id + ':' + (holder || '-')];
    var a = actor();
    var sw = doc.swaps && doc.swaps[slot];
    var offered = sw && sw.state === 'offered';
    var html = '<h2><span aria-hidden="true">' + esc(c.emoji) + '</span> ' + esc(c.name) + '</h2>' +
      '<p class="muted">' + (holder ? esc(nameOf(holder)) : 'Nobody') + ' · ' + esc(s.day === null ? freqLabel(c.freq).toLowerCase() : C.DAY_NAMES[s.day]) + ' · ' + plural(c.effort, 'point') + ' (' + esc(C.EFFORT[c.effort].toLowerCase() + ', ' + C.EFFORT_HINT[c.effort]) + ')</p>';
    if (siblings.length > 1) {
      html += '<div class="seg" role="radiogroup" aria-label="Which day">' + siblings.map(function (x) { return '<button type="button" class="segb" role="radio" aria-checked="' + (x.id === slot) + '" data-act="slot" data-slot="' + esc(x.id) + '">' + esc(C.DAYS[x.day]) + (x.done ? ' ✓' : '') + '</button>'; }).join('') + '</div>';
    }
    if (ex) html += '<div class="note"><p class="small" style="margin:0"><b>Why ' + esc(holder ? nameOf(holder) : 'nobody') + '?</b> ' + esc(ex) + '</p></div>';
    html += '<div class="stack">';
    html += '<button type="button" class="btn block" data-act="tick" data-slot="' + esc(slot) + '" data-close="1">' + (s.done ? 'Undo - it isn’t done' : 'Mark it done ✓') + '</button>';
    if (!s.done && holder) {
      if (isOnline()) {
        if (offered && sw.from === a.mid) html += '<button type="button" class="btn ghost block" data-act="swap" data-do="cancel" data-slot="' + esc(slot) + '">Take back the offer</button>';
        else if (offered) html += '<button type="button" class="btn ghost block" data-act="swap" data-do="claim" data-slot="' + esc(slot) + '">I’ll take it</button>';
        else if (holder === a.mid || a.host) html += '<button type="button" class="btn ghost block" data-act="swap" data-do="offer" data-slot="' + esc(slot) + '">Offer it to someone else</button><p class="small muted">Whoever takes it gets the points.</p>';
      } else {
        if (offered && isExample()) html += '<button type="button" class="btn ghost block" data-act="swap" data-do="claim" data-slot="' + esc(slot) + '">I’ll take it (as Maria)</button>';
        var others = state.home.members.filter(function (m) { return m.id !== holder && m.weight > 0 && (m.cant || []).indexOf(c.id) < 0; });
        if (others.length) html += '<div class="field"><span>Swap - hand it to</span><div class="row">' + others.map(function (m) { return '<button type="button" class="btn small ghost" data-act="give" data-slot="' + esc(slot) + '" data-to="' + esc(m.id) + '">' + esc(m.emoji + ' ' + m.name) + '</button>'; }).join('') + '</div><span class="small muted">The points move with it.</span></div>';
      }
    }
    if (holder && !s.done && (!isOnline() || holder !== a.mid)) {
      html += '<button type="button" class="btn ghost block" data-act="nudge" data-slot="' + esc(slot) + '">Nudge ' + esc(nameOf(holder)) + ' 👋</button><p class="small muted">Opens your share sheet with a friendly message. Chorus never sends anything itself.</p>';
    }
    html += '</div>';
    sheet(html);
  }
  function nudge(slot) {
    var c = chore(slot.split('_')[0]); var holder = holderOf(slot); var m = member(holder);
    if (!c || !m) return;
    var s = C.slotsFor(c, state.week).filter(function (x) { return x.id === slot; })[0];
    var text = C.nudgeText(m, c, s, state.today);
    if (navigator.share) {
      navigator.share({ text: text }).catch(function () { /* they closed it */ });
    } else copy(text, 'Copied - paste it into your chat with ' + m.name);
  }

  /* ---------------- celebrations ---------------- */

  function celebrate(btn, c) {
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* not on this device */ }
    if (REDUCED || !btn || !btn.getBoundingClientRect) return;
    var r = btn.getBoundingClientRect();
    var box = document.createElement('div');
    box.className = 'pop'; box.setAttribute('aria-hidden', 'true');
    box.style.left = (r.left + r.width / 2) + 'px'; box.style.top = (r.top + r.height / 2) + 'px';
    var bits = [c ? c.emoji : '✨', '✨', '⭐', '✨', c ? c.emoji : '⭐', '✨'];
    for (var i = 0; i < bits.length; i++) {
      var sp = document.createElement('span'); sp.textContent = bits[i];
      var ang = (i / bits.length) * Math.PI * 2;
      sp.style.setProperty('--dx', Math.round(Math.cos(ang) * 46) + 'px'); sp.style.setProperty('--dy', Math.round(Math.sin(ang) * 46 - 20) + 'px');
      box.appendChild(sp);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 900);
  }
  function bigCelebrate(name) {
    toast('🎉 ' + name + ' is all done this week!', 3200);
    try { if (navigator.vibrate) navigator.vibrate([12, 60, 18]); } catch (e) { /* not on this device */ }
    if (REDUCED) return;
    var box = document.createElement('div');
    box.className = 'burst'; box.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 18; i++) { var sp = document.createElement('span'); sp.textContent = ['🎉', '✨', '🧹', '⭐'][i % 4]; sp.style.setProperty('--x', (Math.random() * 100) + 'vw'); sp.style.setProperty('--d', (Math.random() * 0.5) + 's'); box.appendChild(sp); }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 2400);
  }

  /* ---------------- Fairness ---------------- */

  function drawFair() {
    var el = $('#tabView');
    var h = state.home;
    var docs = state.weeks.slice(0, C.LIMITS.historyWeeks).filter(Boolean);
    var f = C.fairness(h, docs);
    var maxPlan = Math.max.apply(null, f.rows.map(function (r) { return Math.max(r.week.planned, r.week.done); }).concat([1]));
    var maxShare = Math.max.apply(null, f.rows.map(function (r) { return Math.max(r.share, r.fair); }).concat([0.01]));
    var part = h.members.filter(function (m) { return m.weight !== 1; });
    var html = '<section class="card fairline full"><p class="eyebrow">Who’s carrying the house</p><p class="big">' + esc(f.line) + '</p>' +
      '<p class="small muted">A fair share is by each person’s capacity' + (part.length ? ' - ' + esc(C.sharePhrase(part)) : '') + '. Points are each chore’s effort, 1 to 5.</p></section>';
    html += '<section class="card"><h2>This week</h2><p class="small muted">Done, out of what each person has.</p><ul class="bars">' + f.rows.map(function (r) {
      return '<li><div class="blabel">' + who(r.id) + '<span class="bval"><b>' + r.week.done + '</b> of ' + r.week.planned + ' pts</span></div>' +
        '<div class="btrack" style="width:' + Math.max(4, Math.round(r.week.planned / maxPlan * 100)) + '%" role="img" aria-label="' + esc(nameOf(r.id) + ': ' + r.week.done + ' of ' + r.week.planned + ' points done') + '"><span class="bfill ' + colorOf(r.id) + '" style="width:' + (r.week.planned ? Math.round(Math.min(1, r.week.done / r.week.planned) * 100) : 0) + '%"></span></div></li>';
    }).join('') + '</ul></section>';
    html += '<section class="card"><h2>' + (f.weeks > 1 ? 'The last ' + esc(['', 'one', 'two', 'three', 'four'][f.weeks] || f.weeks) + ' weeks' : 'So far') + '</h2><p class="small muted">Share of the work done (' + plural(f.monthTotal, 'point') + '), with each person’s fair share marked.</p><ul class="bars">' + f.rows.map(function (r) {
      var over = r.share - r.fair;
      return '<li><div class="blabel">' + who(r.id) + '<span class="bval"><b>' + C.pct(r.share) + '</b> · fair ' + C.pct(r.fair) + (f.monthTotal && Math.abs(over) >= 0.05 ? (over > 0 ? ' <span class="tagb warn">+' + Math.round(over * 100) + '</span>' : ' <span class="tagb">' + Math.round(over * 100) + '</span>') : '') + '</span></div>' +
        '<div class="btrack wide" role="img" aria-label="' + esc(nameOf(r.id) + ' did ' + C.pct(r.share) + ' of the work; a fair share is ' + C.pct(r.fair)) + '"><span class="bfill ' + colorOf(r.id) + '" style="width:' + Math.round(r.share / maxShare * 100) + '%"></span><span class="fairmark" style="left:' + Math.round(r.fair / maxShare * 100) + '%"></span></div></li>';
    }).join('') + '</ul><p class="small muted legend"><span class="fairkey" aria-hidden="true"></span> fair share</p></section>';
    // Week by week, stacked.
    var wk = state.weeks.slice(0, C.LIMITS.historyWeeks).filter(Boolean).reverse();
    var maxW = Math.max.apply(null, wk.map(function (d) { return h.members.reduce(function (s, m) { return s + doneOf(d, m.id); }, 0); }).concat([1]));
    html += '<section class="card"><h2>Week by week</h2><ul class="stacks">' + wk.map(function (d) {
      var parts = h.members.map(function (m) { return { m: m, v: doneOf(d, m.id) }; }).filter(function (p) { return p.v > 0; });
      var tot = parts.reduce(function (s, p) { return s + p.v; }, 0);
      return '<li><span class="slabel">' + esc(d.week === state.week ? 'This week' : C.weekLabel(d.week)) + '</span><span class="sbar" role="img" aria-label="' + esc(parts.map(function (p) { return p.m.name + ' ' + p.v; }).join(', ') || 'nothing done') + '" style="width:' + Math.max(2, Math.round(tot / maxW * 100)) + '%">' +
        parts.map(function (p) { return '<span class="seg2 ' + colorOf(p.m.id) + '" style="flex:' + p.v + '"></span>'; }).join('') + '</span><span class="small muted">' + tot + '</span></li>';
    }).join('') + '</ul><p class="legend small">' + h.members.map(function (m) { return '<span class="lk"><span class="sw ' + colorOf(m.id) + '" aria-hidden="true"></span>' + esc(m.name) + '</span>'; }).join('') + '</p></section>';
    var streaks = h.members.map(function (m) { return { m: m, n: C.streak(h, state.weeks.filter(Boolean), m.id) }; }).sort(function (a, b) { return b.n - a.n; });
    html += '<section class="card"><h2>Streaks</h2><p class="small muted">Weeks in a row with everything ticked.</p><ul class="srows">' + streaks.map(function (x) {
      return '<li>' + who(x.m.id) + '<span>' + (x.n ? '🔥 <b>' + plural(x.n, 'week') + '</b>' : '<span class="muted">Not yet</span>') + '</span></li>';
    }).join('') + '</ul></section>';
    el.innerHTML = html;
    el.className = 'tabgrid';
  }
  function doneOf(d, mid) { var n = 0; var t = d.ticks || {}; Object.keys(t).forEach(function (k) { if (t[k] && t[k].who === mid) n += t[k].pts || 0; }); return n; }

  /* ---------------- Chores ---------------- */

  function drawChores() {
    var el = $('#tabView');
    var h = state.home;
    var perWeek = C.weekSlots(h.chores, state.week, h.since).reduce(function (s, x) { return s + x.pts; }, 0);
    var html = '<section class="card full"><div class="sec-head"><div><h2>' + plural(h.chores.length, 'chore') + '</h2><p class="small muted">' + plural(perWeek, 'point') + ' due this week. Change anything and the week is re-dealt - what’s already done stays done.</p></div></div>' +
      '<div class="row"><button type="button" class="btn" data-act="addchore">+ Add a chore</button><button type="button" class="btn ghost" data-act="suggest">✨ Suggest from a photo</button><button type="button" class="btn ghost" data-act="starters">Starter chores</button></div></section>';
    var byFreq = {};
    h.chores.forEach(function (c) { (byFreq[c.freq] = byFreq[c.freq] || []).push(c); });
    C.FREQS.forEach(function (fq) {
      var list = byFreq[fq.id]; if (!list) return;
      html += '<section class="card"><h2>' + esc(fq.label) + '</h2><ul class="clist">' + list.map(function (c) {
        var cant = h.members.filter(function (m) { return (m.cant || []).indexOf(c.id) >= 0; }).map(function (m) { return m.name; });
        return '<li><button type="button" class="crow" data-act="editchore" data-cid="' + esc(c.id) + '"><span class="gi" aria-hidden="true">' + esc(c.emoji) + '</span><span class="gb"><b>' + esc(c.name) + '</b><span class="imeta">' + dots(c.effort) + '<span>' + esc(C.EFFORT[c.effort]) + '</span>' +
          (cant.length ? '<span class="small muted">Not ' + esc(C.nameList(cant)) + '</span>' : '') + '</span></span><span class="chev" aria-hidden="true">›</span></button></li>';
      }).join('') + '</ul></section>';
    });
    if (!h.chores.length) html += '<section class="card center"><div class="big-emoji" aria-hidden="true">🧽</div><p>No chores yet. Add one, pick from the starters, or snap a room.</p></section>';
    el.innerHTML = html;
    el.className = 'tabgrid';
  }
  function choreForm(c) {
    c = c || { name: '', emoji: '🧹', effort: 2, freq: 'weekly' };
    var emojis = CHORE_EMOJI.indexOf(c.emoji) >= 0 ? CHORE_EMOJI : [c.emoji].concat(CHORE_EMOJI.slice(0, 23));
    return '<form id="choreForm" class="stack"><label class="field"><span>What needs doing</span><input class="input" id="cName" maxlength="' + C.LIMITS.choreName + '" value="' + esc(c.name) + '" required placeholder="Wipe the stovetop"></label>' +
      '<div class="field"><span>Emoji</span><div class="emojis small-e" role="radiogroup" aria-label="Chore emoji">' + emojis.map(function (e) { return '<button type="button" class="emo" role="radio" aria-checked="' + (e === c.emoji) + '" data-act="pickemo" data-emo="' + esc(e) + '">' + esc(e) + '</button>'; }).join('') + '</div></div>' +
      '<div class="field"><span>How big a job</span><div class="seg" role="radiogroup" aria-label="Effort">' + [1, 2, 3, 4, 5].map(function (n) { return '<button type="button" class="segb" role="radio" aria-checked="' + (n === c.effort) + '" data-act="pickeff" data-v="' + n + '"><b>' + n + '</b><span class="small">' + esc(C.EFFORT[n]) + '</span></button>'; }).join('') + '</div><span class="small muted" id="effHint">' + esc(C.EFFORT_HINT[c.effort]) + ' · worth ' + plural(c.effort, 'point') + '</span></div>' +
      '<div class="field"><span>How often</span><div class="seg" role="radiogroup" aria-label="How often">' + C.FREQS.map(function (f) { return '<button type="button" class="segb" role="radio" aria-checked="' + (f.id === c.freq) + '" data-act="pickfreq" data-v="' + f.id + '">' + esc(f.label) + '</button>'; }).join('') + '</div></div>' +
      '<div id="cErr"></div><button class="btn block" type="submit">' + (c.id ? 'Save' : 'Add it') + '</button>' + (c.id ? '<button type="button" class="btn ghost danger block" data-act="delchore" data-cid="' + esc(c.id) + '">Delete this chore</button>' : '') + '</form>';
  }
  function openChore(cid) {
    if (isExample()) return openStartOwn('Changing chores is for your own household.');
    var c = cid ? chore(cid) : null;
    var pick = { emoji: c ? c.emoji : '🧹', effort: c ? c.effort : 2, freq: c ? c.freq : 'weekly' };
    sheet('<h2>' + (c ? 'Edit chore' : 'Add a chore') + '</h2>' + choreForm(c), function (root) {
      root.__pick = pick;
      $('#choreForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var body = { name: $('#cName', root).value, emoji: pick.emoji, effort: pick.effort, freq: pick.freq };
        saveChores(c ? 'edit' : 'add', c ? c.id : null, body, $('#cErr', root));
      });
    });
  }
  /** Add / edit / delete chores: on this phone through the same cleaners
   *  the server uses; online through the server. */
  function saveChores(op, cid, body, errBox) {
    if (isOnline()) {
      var p = op === 'add' ? api('POST', 'api/homes/' + HOME_ID + '/chores', Array.isArray(body) ? { chores: body } : body)
        : op === 'edit' ? api('PATCH', 'api/homes/' + HOME_ID + '/chores/' + cid, body) : api('DELETE', 'api/homes/' + HOME_ID + '/chores/' + cid);
      return p.then(function (d) { setBundle(d); closeSheet(); draw(); toast(op === 'delete' ? 'Deleted - the week was re-dealt' : 'Saved - the week was re-dealt'); }).catch(function (e) { showError(e, errBox); });
    }
    try {
      var h = state.home;
      if (op === 'add') {
        var list = Array.isArray(body) ? body : [body];
        if (h.chores.length + list.length > C.LIMITS.chores) throw C.fail(409, 'A household keeps ' + C.LIMITS.chores + ' chores at most.');
        list.forEach(function (b) { h.chores.push(C.cleanChore(b, { week: state.week })); });
      } else if (op === 'edit') {
        var c = chore(cid);
        var next = C.cleanChore({ id: c.id, start: c.start, name: body.name, emoji: body.emoji, effort: body.effort, freq: body.freq, nudge: c.nudge }, { week: c.start });
        if (next.freq !== c.freq) next.start = state.week;
        h.chores[h.chores.indexOf(c)] = next;
      } else {
        h.chores = h.chores.filter(function (x) { return x.id !== cid; });
        h.members.forEach(function (m) { m.cant = (m.cant || []).filter(function (x) { return x !== cid; }); m.dislikes = (m.dislikes || []).filter(function (x) { return x !== cid; }); });
      }
      redeal(); closeSheet(); draw(); toast(op === 'delete' ? 'Deleted - the week was re-dealt' : 'Saved - the week was re-dealt');
    } catch (e) { showError(e, errBox); }
  }
  function openStarters() {
    if (isExample()) return openStartOwn('Adding chores is for your own household.');
    var have = state.home.chores.map(function (c) { return c.name.toLowerCase(); });
    sheet('<h2>Starter chores</h2><p class="small muted">Tick what your household needs. Free, no account.</p><div class="seg" role="radiogroup" aria-label="Starter set">' + C.TEMPLATES.map(function (t, i) { return '<button type="button" class="segb" role="radio" aria-checked="' + (i === 0) + '" data-act="startset" data-v="' + t.id + '">' + esc(t.emoji + ' ' + t.name) + '</button>'; }).join('') + '</div><div id="starterList"></div>', function (root) {
      function show(id) {
        var list = C.templateChores(id).filter(function (c) { return have.indexOf(c.name.toLowerCase()) < 0; });
        $('#starterList', root).innerHTML = list.length ? pickList(list, false) + '<div id="stErr"></div><button type="button" class="btn block" id="stAdd">Add the ticked chores</button>' : '<p class="muted">You already have all of these.</p>';
        var b = $('#stAdd', root);
        if (b) b.addEventListener('click', function () {
          var chosen = list.filter(function (c, i) { var x = $('#pk' + i, root); return x && x.checked; });
          if (!chosen.length) return toast('Tick at least one.');
          saveChores('add', null, chosen, $('#stErr', root));
        });
      }
      root.__startset = show;
      show(C.TEMPLATES[0].id);
    });
  }
  function pickList(list, checked) {
    return '<ul class="picklist">' + list.map(function (c, i) {
      return '<li><label class="pick"><input type="checkbox" id="pk' + i + '"' + (checked ? ' checked' : '') + '><span class="gi" aria-hidden="true">' + esc(c.emoji) + '</span><span class="gb"><b>' + esc(c.name) + '</b><span class="imeta">' + dots(c.effort) + '<span>' + esc(freqLabel(c.freq)) + '</span></span></span></label></li>';
    }).join('') + '</ul>';
  }

  /* ---------------- Suggest chores (the one AI feature) ---------------- */

  function openSuggest() {
    if (isExample()) return openStartOwn('Suggestions are for your own household - start one, it’s free.');
    if (!signedIn()) {
      return sheet('<h2>✨ Suggest chores from a photo</h2><p>Snap a room - or describe your home in a few words - and AI suggests the regular chores it needs, sized and scheduled. You tick the ones you want.</p>' +
        '<div class="note"><p class="small" style="margin:0"><b>Sign in free to use it.</b> A free account comes with $2 of AI credit - a suggestion costs about a cent. Everything else in Chorus is free without one.</p></div>' +
        '<button type="button" class="btn block" data-act="signin-suggest">Create a free account</button><button type="button" class="btn ghost block" data-act="starters">Use the starter chores instead</button>');
    }
    var photo = null;
    sheet('<h2>✨ Suggest chores</h2><p class="small muted">A photo of one room works best. It’s read once to make suggestions and never stored.</p>' +
      '<form id="sgForm" class="stack"><label class="btn ghost block filebtn"><input type="file" accept="image/*" capture="environment" id="sgFile" class="vh"><span id="sgFileLabel">📷 Take or choose a photo</span></label><div id="sgPrev"></div>' +
      '<label class="field"><span>Or describe your home</span><textarea class="input" id="sgText" rows="3" maxlength="' + C.LIMITS.suggestText + '" placeholder="Two-bed flat, a cat, a balcony with plants, we both work from home"></textarea></label>' +
      '<div id="sgErr"></div><button class="btn block" type="submit">Suggest chores</button></form><div id="sgOut"></div>', function (root) {
      $('#sgFile', root).addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0]; if (!f) return;
        $('#sgFileLabel', root).textContent = 'Preparing the photo…';
        shrink(f).then(function (p) {
          photo = p;
          $('#sgFileLabel', root).textContent = '📷 Change the photo';
          $('#sgPrev', root).innerHTML = '<img class="thumb" alt="The room you picked" src="data:image/jpeg;base64,' + p.data + '">';
        }).catch(function (err) { $('#sgFileLabel', root).textContent = '📷 Take or choose a photo'; showError(err, $('#sgErr', root)); });
      });
      $('#sgForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var text = $('#sgText', root).value.trim();
        if (!photo && text.length < 3) return showError(new Error('Add a photo of a room, or a few words about your home.'), $('#sgErr', root));
        var btn = $('button[type=submit]', root); btn.disabled = true;
        $('#sgErr', root).innerHTML = '<p class="busy" role="status">Looking around… this takes a few seconds.</p>';
        api('POST', 'api/suggest', { photo: photo || undefined, text: text || undefined, have: state.home.chores.map(function (c) { return c.name; }) }).then(function (r) {
          btn.disabled = false; $('#sgErr', root).innerHTML = '';
          $('#sgForm', root).hidden = true;
          var out = $('#sgOut', root);
          out.innerHTML = '<p><b>' + plural(r.chores.length, 'suggestion') + '</b> - untick any you don’t want. Nothing is added until you press Add.</p>' + pickList(r.chores, true) + '<div id="sgAddErr"></div><button type="button" class="btn block" id="sgAdd">Add the ticked chores</button><button type="button" class="btn ghost block" id="sgAgain">Try another photo</button>';
          $('#sgAdd', out).addEventListener('click', function () {
            var chosen = r.chores.filter(function (c, i) { var x = $('#pk' + i, out); return x && x.checked; });
            if (!chosen.length) return toast('Tick at least one.');
            saveChores('add', null, chosen, $('#sgAddErr', out));
          });
          $('#sgAgain', out).addEventListener('click', function () { out.innerHTML = ''; $('#sgForm', root).hidden = false; });
        }).catch(function (err) {
          btn.disabled = false;
          var box = $('#sgErr', root);
          if (err.status === 401) { box.innerHTML = ''; return openAccount('Suggestions use a cent of AI credit, so they need a free account (it comes with $2).', openSuggest); }
          if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
          if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
          showError(err, box);
        });
      });
    });
  }
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, PHOTO_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var dataUrl = c.toDataURL('image/jpeg', 0.85);
        URL.revokeObjectURL(url);
        resolve({ type: 'image/jpeg', data: dataUrl.split(',')[1] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be opened.')); };
      img.src = url;
    });
  }

  /* ---------------- People ---------------- */

  function joinLink() { return location.origin + BASE + 'j/' + state.home.code; }
  function drawPeople() {
    var el = $('#tabView');
    var h = state.home;
    var a = actor();
    var html = '';
    if (isOnline()) {
      html += '<section class="card invite"><div class="sec-head"><h2>Invite the household</h2><span class="small muted">' + h.members.length + ' of ' + C.LIMITS.members + '</span></div>' +
        '<div class="invgrid"><button type="button" class="qr" data-act="qrbig" aria-label="Show the QR code full screen">' + QR.svg(joinLink(), 'QR code to join ' + h.name) + '</button>' +
        '<div><p class="small muted">Code</p><p class="code">' + esc(h.display) + '</p><p class="small muted">They scan it or open the link, say which one they are, and they’re in. No account, no app.</p>' +
        '<div class="row"><button type="button" class="btn small" data-act="sharejoin">Share link</button><button type="button" class="btn small ghost" data-act="copyjoin">Copy</button></div></div></div>' +
        (h.host ? '<button type="button" class="link-btn small" data-act="rotate">New code (the old link stops working)</button>' : '') + '</section>';
    } else if (isLocal()) {
      html += '<section class="card online-cta"><h2>📲 Put it on everyone’s phone</h2><p>Right now this household lives on this phone. Put it online and everyone ticks their own chores, swaps, and sees the same board - they join with a code, no account.</p>' +
        '<p class="small muted">You need a free account to host it (so it’s yours to run and delete); nobody else does. The weeks so far come along, so the rotation remembers.</p><button type="button" class="btn" data-act="goonline">Put it online</button></section>';
    } else {
      html += '<section class="card online-cta"><h2>📲 Everyone on their own phone</h2><p>In a real household the host puts it online and everyone joins with a six-character code - no account for them.</p><button type="button" class="btn" data-act="new">Start your own</button></section>';
    }
    html += '<section class="card"><div class="sec-head"><h2>People</h2>' + ((isLocal() || (isOnline() && h.host)) && h.members.length < C.LIMITS.members ? '<button type="button" class="btn small ghost" data-act="addperson">+ Add someone</button>' : '') + '</div><ul class="members">' + h.members.map(function (m) {
      var can = isLocal() || (isOnline() && (h.host || m.id === a.mid));
      var cant = choreNames(m.cant || []); var dis = choreNames(m.dislikes || []);
      return '<li><button type="button" class="mrow" data-act="person" data-mid="' + esc(m.id) + '"' + (can || isExample() ? '' : ' disabled') + '>' + who(m.id) +
        '<span class="mbody"><span class="small">' + esc(weightLabel(m.weight)) + (m.host ? ' · host' : '') + (isOnline() && !m.joined ? ' · <span class="muted">hasn’t joined yet</span>' : '') + '</span>' +
        (cant.length ? '<span class="small muted">Can’t: ' + esc(cant.join(', ')) + '</span>' : '') +
        (dis.length ? '<span class="small muted">Least liked: ' + esc(dis.join(', ')) + '</span>' : '') + '</span>' + (can || isExample() ? '<span class="chev" aria-hidden="true">›</span>' : '') + '</button></li>';
    }).join('') + '</ul><p class="small muted">Tap someone to set their share, what they can’t do, and up to three least-liked chores - those rotate away from them first.</p></section>';
    if (isLocal() || (isOnline() && h.host)) {
      html += '<section class="card"><div class="sec-head"><h2>Household</h2></div><form class="addrow" id="renameForm"><input class="input" id="renameIn" maxlength="' + C.LIMITS.homeName + '" value="' + esc(h.name) + '" aria-label="Household name"><button class="btn ghost" type="submit">Rename</button></form>' +
        '<button type="button" class="btn ghost danger" data-act="delhome">' + (isLocal() ? 'Clear this household from this phone' : 'Delete the household and its history') + '</button></section>';
    } else if (isOnline()) {
      html += '<section class="card"><button type="button" class="link-btn danger" data-act="leave">Leave the household</button></section>';
    }
    el.innerHTML = html;
    el.className = 'tabgrid';
    var rf = $('#renameForm', el);
    if (rf) rf.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('#renameIn', el).value;
      if (isOnline()) return api('PATCH', 'api/homes/' + HOME_ID, { name: name }).then(function (d) { setBundle(d); draw(); toast('Renamed'); }).catch(function (err) { showError(err); });
      var n = C.clean(name, C.LIMITS.homeName);
      if (!n) return toast('Give the household a name.');
      state.home.name = n; saveLocal(); draw(); toast('Renamed');
    });
  }
  function openPerson(mid) {
    if (isExample()) return openStartOwn('Changing people is for your own household.');
    var m = mid ? member(mid) : null;
    var a = actor();
    var host = isLocal() || (isOnline() && state.home.host);
    var self = m && m.id === a.mid;
    var pick = { emoji: m ? m.emoji : (C.EMOJI.filter(function (e) { return !state.home.members.some(function (x) { return x.emoji === e; }); })[0] || C.EMOJI[0]), weight: m ? m.weight : 1, cant: m ? (m.cant || []).slice() : [], dislikes: m ? (m.dislikes || []).slice() : [] };
    var taken = state.home.members.filter(function (x) { return !m || x.id !== m.id; }).map(function (x) { return x.emoji; });
    var chores = state.home.chores;
    var html = '<h2>' + (m ? esc(m.name) : 'Add someone') + '</h2><form id="pForm" class="stack">' +
      '<label class="field"><span>Name</span><input class="input" id="pName" maxlength="' + C.LIMITS.memberName + '" value="' + esc(m ? m.name : '') + '" required placeholder="First name or nickname"></label>' +
      '<div class="field"><span>Emoji</span>' + emojiGrid(pick.emoji, taken) + '</div>' +
      (host ? '<div class="field"><span>How much they take on</span><div class="seg" role="radiogroup" aria-label="Share">' + C.WEIGHTS.map(function (w) { return '<button type="button" class="segb" role="radio" aria-checked="' + (w.v === pick.weight) + '" data-act="pickw" data-v="' + w.v + '">' + esc(w.label) + '</button>'; }).join('') + '</div><span class="small muted">A full share is an adult’s. Kids usually count half.</span></div>'
        : '<p class="small muted">Share: ' + esc(weightLabel(pick.weight)) + ' (the host sets this).</p>') +
      (m && chores.length ? '<fieldset class="picks-set"><legend>Can’t or won’t do</legend><div class="chips">' + chores.map(function (c) { return '<button type="button" class="chip" data-act="tcant" data-cid="' + esc(c.id) + '" aria-pressed="' + (pick.cant.indexOf(c.id) >= 0) + '">' + esc(c.emoji + ' ' + c.name) + '</button>'; }).join('') + '</div><span class="small muted">They never get these. Everyone can see the list.</span></fieldset>' +
        '<fieldset class="picks-set"><legend>Least liked (up to ' + C.LIMITS.dislikes + ')</legend><div class="chips">' + chores.map(function (c) { return '<button type="button" class="chip" data-act="tdis" data-cid="' + esc(c.id) + '" aria-pressed="' + (pick.dislikes.indexOf(c.id) >= 0) + '">' + esc(c.emoji + ' ' + c.name) + '</button>'; }).join('') + '</div><span class="small muted">They still get these sometimes - just never week after week.</span></fieldset>' : '') +
      '<div id="pErr"></div><button class="btn block" type="submit">' + (m ? 'Save' : 'Add them') + '</button>' +
      (m && !m.host && (host || self) && !(isLocal() && m.id === state.home.me) ? '<button type="button" class="btn ghost danger block" data-act="rmperson" data-mid="' + esc(m.id) + '">' + (self && !host ? 'Leave the household' : 'Remove ' + esc(m.name)) + '</button>' : '') + '</form>';
    sheet(html, function (root) {
      root.__pick = pick;
      $('#pForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var body = { name: $('#pName', root).value, emoji: pick.emoji };
        if (host) body.weight = pick.weight;
        if (m) { body.cant = pick.cant; body.dislikes = pick.dislikes; }
        savePerson(m ? m.id : null, body, $('#pErr', root));
      });
    });
  }
  function savePerson(mid, body, errBox) {
    if (isOnline()) {
      var p = mid ? api('PATCH', 'api/homes/' + HOME_ID + '/members/' + mid, body) : api('POST', 'api/homes/' + HOME_ID + '/members', body);
      return p.then(function (d) { setBundle(d); closeSheet(); draw(); toast('Saved'); }).catch(function (e) { showError(e, errBox); });
    }
    try {
      var h = state.home;
      var draft = h.members.map(function (x) { return x.id === mid ? Object.assign({}, x, body) : x; });
      if (!mid) {
        if (h.members.length >= C.LIMITS.members) throw C.fail(409, 'A household has ' + C.LIMITS.members + ' people at most.');
        draft.push(Object.assign({ id: C.newId('m') }, body));
      }
      var clean = C.cleanHome({ name: h.name, members: draft, chores: h.chores }, { week: state.week });
      h.members = clean.members;
      redeal(); closeSheet(); draw(); toast('Saved - the week was re-dealt');
    } catch (e) { showError(e, errBox); }
  }
  function removePerson(mid) {
    var m = member(mid); if (!m) return;
    var self = isOnline() && mid === actor().mid;
    if (!confirm(self ? 'Leave ' + state.home.name + '? Your chores go back into the deal.' : 'Remove ' + m.name + '? Their chores this week are re-dealt; what they already did stays in the history.')) return;
    if (isOnline()) {
      return api('DELETE', 'api/homes/' + HOME_ID + '/members/' + mid).then(function (d) {
        closeSheet();
        if (d.left) { forgetHome(HOME_ID); location.href = BASE + '#start'; return; }
        setBundle(d); draw(); toast('Removed');
      }).catch(function (e) { showError(e); });
    }
    state.home.members = state.home.members.filter(function (x) { return x.id !== mid; });
    redeal(); closeSheet(); draw(); toast('Removed - the week was re-dealt');
  }
  function emojiGrid(selected, taken) {
    return '<div class="emojis" role="radiogroup" aria-label="Emoji">' + C.EMOJI.map(function (e) {
      return '<button type="button" class="emo' + (taken && taken.indexOf(e) >= 0 && e !== selected ? ' taken' : '') + '" role="radio" aria-checked="' + (e === selected) + '" data-act="emo" data-emo="' + esc(e) + '">' + esc(e) + '</button>';
    }).join('') + '</div>';
  }
  function showQr() {
    var o = document.createElement('div');
    o.className = 'qrfull'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'Join code');
    o.innerHTML = '<button type="button" class="btn small ghost" id="qrClose">Close</button><div class="qrbox">' + QR.svg(joinLink(), 'QR code to join ' + state.home.name) + '</div><p class="code">' + esc(state.home.display) + '</p><p>Scan to join ' + esc(state.home.name) + '</p>';
    document.body.appendChild(o);
    function close() { o.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    $('#qrClose', o).addEventListener('click', close);
    o.addEventListener('click', function (e) { if (e.target === o) close(); });
    document.addEventListener('keydown', onKey);
    $('#qrClose', o).focus();
  }
  function goOnline() {
    if (!signedIn()) return openAccount('Hosting a household online needs a free account - so it’s yours to run and delete. Nobody else needs one: they join with a code.', goOnline);
    var raw = readLocal();
    if (!raw) return;
    sheet('<h2>Putting it online…</h2><p class="busy" role="status">One moment.</p>');
    api('POST', 'api/homes', { home: raw.home, me: raw.home.me, tz: raw.home.tz, weeks: raw.weeks }).then(function (d) {
      keep(K_HOME, null);
      rememberHome(d.id, d.home.name);
      location.href = BASE + 'h/' + d.id + '#people';
    }).catch(function (e) { closeSheet(); showError(e); });
  }

  /* ---------------- Start your own (the wizard) ---------------- */

  function newWizard() { return { step: 1, template: null, name: '', people: [], chores: [] }; }
  function setTemplate(id) {
    var w = state.wiz;
    var t = C.TEMPLATES.filter(function (x) { return x.id === id; })[0];
    w.template = id;
    var used = [];
    w.people = t.people.map(function (p, i) {
      var old = w.people[i];
      var e = old ? old.emoji : C.EMOJI.filter(function (x) { return used.indexOf(x) < 0; })[i % 4];
      used.push(e);
      return { id: old ? old.id : C.newId('m'), name: old ? old.name : '', emoji: e, weight: p.weight };
    });
    w.chores = C.templateChores(id).map(function (c) { return Object.assign({ on: true }, c); });
  }
  var PLACE = { roommates: ['Flat 4B', ['You', 'Roommate', 'Roommate']], couple: ['Our place', ['You', 'Your partner']], family: ['The Garcias', ['You', 'Another grown-up', 'A kid', 'Another kid']] };
  function drawWizard() {
    var w = state.wiz;
    var main = $('#main');
    var steps = ['Who lives here', 'The people', 'The chores'];
    var html = '<section class="wizard"><ol class="wsteps" aria-label="Steps">' + steps.map(function (s, i) { return '<li class="' + (i + 1 === w.step ? 'on' : i + 1 < w.step ? 'past' : '') + '"' + (i + 1 === w.step ? ' aria-current="step"' : '') + '><span>' + (i + 1) + '</span>' + esc(s) + '</li>'; }).join('') + '</ol>';
    if (w.step === 1) {
      html += '<h1>Who lives here?</h1><p class="muted">Pick the closest - it fills in the usual chores, and you can change everything.</p><div class="templates">' + C.TEMPLATES.map(function (t) {
        return '<button type="button" class="tpl' + (w.template === t.id ? ' on' : '') + '" data-act="tpl" data-v="' + t.id + '" aria-pressed="' + (w.template === t.id) + '"><span class="ti" aria-hidden="true">' + esc(t.emoji) + '</span><b>' + esc(t.name) + '</b><span class="small muted">' + esc(t.blurb) + '</span><span class="small">' + plural(t.chores.length, 'starter chore') + '</span></button>';
      }).join('') + '</div>';
      if (w.template) html += '<label class="field"><span>Call your household</span><input class="input" id="wName" maxlength="' + C.LIMITS.homeName + '" value="' + esc(w.name) + '" placeholder="' + esc(PLACE[w.template][0]) + '"></label>';
      html += '<div id="wErr"></div><div class="wnav"><a class="btn ghost" href="' + esc(BASE) + '#start">Cancel</a><button type="button" class="btn big" data-act="wnext"' + (w.template ? '' : ' disabled') + '>Next</button></div>';
    } else if (w.step === 2) {
      html += '<h1>Who’s in it?</h1><p class="muted">First names are fine. Tap an emoji to change it. Kids count half, so they get about half the work.</p><ul class="wpeople">' + w.people.map(function (p, i) {
        var ph = (PLACE[w.template][1][i] || 'Someone');
        return '<li><button type="button" class="emo big-e" data-act="wemo" data-i="' + i + '" aria-label="Change emoji for ' + esc(p.name || ph) + '">' + esc(p.emoji) + '</button>' +
          '<input class="input" data-i="' + i + '" maxlength="' + C.LIMITS.memberName + '" value="' + esc(p.name) + '" placeholder="' + esc(i === 0 ? 'Your name' : ph) + '" aria-label="' + esc(i === 0 ? 'Your name' : 'Name ' + (i + 1)) + '">' +
          '<button type="button" class="chip kid" data-act="wkid" data-i="' + i + '" aria-pressed="' + (p.weight === 0.5) + '">Kid</button>' +
          (i > 0 ? '<button type="button" class="btn small ghost sq" data-act="wrm" data-i="' + i + '" aria-label="Remove">✕</button>' : '<span class="you">you</span>') + '</li>';
      }).join('') + '</ul>' + (w.people.length < C.LIMITS.members ? '<button type="button" class="btn ghost" data-act="wadd">+ Add someone</button>' : '') +
        '<div id="wErr"></div><div class="wnav"><button type="button" class="btn ghost" data-act="wback">Back</button><button type="button" class="btn big" data-act="wnext">Next</button></div>';
    } else {
      var on = w.chores.filter(function (c) { return c.on; });
      html += '<h1>Pick your chores</h1><p class="muted">' + plural(on.length, 'chore') + ' ticked. Untick what you don’t need - you can add more later, or snap a room for suggestions.</p><ul class="picklist">' + w.chores.map(function (c, i) {
        return '<li><label class="pick"><input type="checkbox" data-wc="' + i + '"' + (c.on ? ' checked' : '') + '><span class="gi" aria-hidden="true">' + esc(c.emoji) + '</span><span class="gb"><b>' + esc(c.name) + '</b><span class="imeta">' + dots(c.effort) + '<span>' + esc(freqLabel(c.freq)) + '</span></span></span></label></li>';
      }).join('') + '</ul><div id="wErr"></div><div class="wnav"><button type="button" class="btn ghost" data-act="wback">Back</button><button type="button" class="btn big" data-act="wdone">Deal our first week</button></div>';
    }
    html += '</section>' + footer();
    main.innerHTML = html;
    $$('.wpeople input', main).forEach(function (inp) { inp.addEventListener('input', function () { w.people[Number(inp.getAttribute('data-i'))].name = inp.value; }); });
    $$('input[data-wc]', main).forEach(function (inp) { inp.addEventListener('change', function () { w.chores[Number(inp.getAttribute('data-wc'))].on = inp.checked; }); });
    var nm = $('#wName', main); if (nm) nm.addEventListener('input', function () { w.name = nm.value; });
  }
  function wizardDone() {
    var w = state.wiz;
    var week = C.weekKey(Date.now(), TZ);
    var people = w.people.map(function (p, i) { return { id: p.id, name: p.name.trim() || (i === 0 ? '' : ''), emoji: p.emoji, weight: p.weight }; });
    try {
      if (!people[0].name) throw C.fail(400, 'Add your own name first.');
      var home = C.cleanHome({ name: w.name.trim() || PLACE[w.template][0], members: people.filter(function (p, i) { return i === 0 || p.name; }), chores: w.chores.filter(function (c) { return c.on; }) }, { week: week });
      if (!home.chores.length) throw C.fail(400, 'Tick at least one chore.');
      home.tz = TZ; home.me = home.members[0].id; home.since = C.localDate(Date.now(), TZ);
      keep(K_HOME, { home: home, weeks: {} });
      state.wiz = null; state.welcome = true;
      keep(K_LAST, null);
      go('week');
    } catch (e) { showError(e, $('#wErr')); }
  }

  /* ---------------- join ---------------- */

  function drawJoin() {
    var main = $('#main');
    var j = state.join;
    if (!j) { main.innerHTML = '<p class="busy" role="status">Finding the household…</p>'; return; }
    if (j.error) {
      main.innerHTML = '<section class="card center gone"><div class="big-emoji" aria-hidden="true">🔑</div><h1>That code didn’t work</h1><p class="muted">' + esc(j.error) + '</p>' + joinBox() + '<a class="btn ghost" href="' + esc(BASE) + '#start">Back to the start</a></section>' + footer();
      wireCodeForm(main);
      return;
    }
    main.innerHTML = '<section class="card joincard"><div class="big-emoji" aria-hidden="true">🏠</div><p class="eyebrow">You’re invited to</p><h1>' + esc(j.name) + '</h1><p class="muted">' + plural(j.members, 'person', 'people') + ' sharing the chores fairly. Tick yours, swap, and see who’s doing what.</p>' +
      (j.seats.length ? '<h2>Which one is you?</h2><div class="seats">' + j.seats.map(function (s) { return '<button type="button" class="seat" data-act="seat" data-mid="' + esc(s.id) + '"><span class="em" aria-hidden="true">' + esc(s.emoji) + '</span>' + esc(s.name) + '</button>'; }).join('') + '</div><p class="small muted center">Not on the list? Join as someone new below.</p>' : '') +
      (j.full ? '<p class="err">This household is full.</p>' : '<form id="joinForm" class="stack"><h2>' + (j.seats.length ? 'Someone new' : 'Join as') + '</h2><label class="field"><span>Your name</span><input class="input" id="jName" maxlength="' + C.LIMITS.memberName + '" autocomplete="given-name" placeholder="First name or nickname"></label>' +
        '<div class="field"><span>Pick an emoji</span>' + emojiGrid(j.pick, j.takenEmoji) + '</div><div id="jErr"></div><button class="btn block big" type="submit">Join the household</button>' +
        '<p class="small muted center">No account needed - this phone remembers you.</p></form>') + '</section>' + footer();
    var f = $('#joinForm');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      doJoin({ name: $('#jName').value, emoji: j.pick }, $('button[type=submit]', f));
    });
  }
  function doJoin(body, btn) {
    if (btn) btn.disabled = true;
    api('POST', 'api/join/' + JOIN_CODE, body).then(function (r) {
      location.href = BASE + 'h/' + r.homeId + '#week';
    }).catch(function (err) { if (btn) btn.disabled = false; showError(err, $('#jErr') || null); });
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
      if (j.already) { location.replace(BASE + 'h/' + j.already + '#week'); return; }
      var free = C.EMOJI.filter(function (e) { return j.takenEmoji.indexOf(e) < 0; });
      j.pick = free[Math.floor(Math.random() * free.length)] || C.EMOJI[0];
      state.join = j; draw();
    }).catch(function (e) { state.join = { error: e.message }; draw(); });
  }
  function openJoinHome() {
    var list = recall(K_HOMES) || [];
    sheet('<h2>Join a household</h2><p class="small muted">Type the six-character code under their QR code, or open the link they sent.</p>' + joinBox() +
      (list.length ? '<h3>Households on this phone</h3><ul class="tlist">' + list.map(function (c) { return '<li><a href="' + esc(BASE + 'h/' + c.id) + '"><b>' + esc(c.name) + '</b></a></li>'; }).join('') + '</ul>' : ''), function (root) { wireCodeForm(root); });
  }
  function openStartOwn(reason) {
    sheet('<h2>Make it yours</h2><p class="muted">' + esc(reason) + ' It takes a minute, with no account.</p><button type="button" class="btn block big" data-act="new">Start on this phone</button><button type="button" class="btn ghost block" data-act="joinhome">Join a household</button>');
  }

  /* ---------------- account ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Account' : 'Sign in';
  }

  var lastFocus = null;
  function openSheetOpen() { return !$('#sheet').hidden; }
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
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

  var FREE_LINE = 'Nobody in a household needs an account to tick their chores. A free account lets you host a household online and get chore suggestions from a photo (it comes with $2 of AI credit). One account works across every app on this site.';

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
    if (isOnline()) { state.home = null; loadOnline().then(startPolling); return; }
    if (state.view === 'join') return loadJoin();
    draw();
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Chore suggestions cost about a cent. Households, the board, swaps and fairness are free.</p><div id="billing"></div></div>' +
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The starter chores, the board, swaps and fairness keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

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
        history.pushState(null, '', location.pathname + '#' + tabHash(tab));
        draw(); scrollTo(0, 0);
        break;
      }
      case 'example': go('example'); break;
      case 'new': closeSheet(true); state.wiz = newWizard(); go('new'); break;
      case 'openlocal': go('week'); break;
      case 'joinhome': openJoinHome(); break;
      case 'nowelcome': state.welcome = false; draw(); break;
      case 'signin': openAccount(); break;
      case 'signin-suggest': openAccount('A free account comes with $2 of AI credit. Suggestions cost about a cent each.', openSuggest); break;
      case 'tick': {
        var slot = t.getAttribute('data-slot');
        if (t.getAttribute('data-close')) { closeSheet(); var row = $('[data-act=tick][data-slot="' + slot + '"]', $('#main')); doTick(slot, row); }
        else doTick(slot, t);
        break;
      }
      case 'slot': openSlot(t.getAttribute('data-slot')); break;
      case 'swap': doSwap(t.getAttribute('data-slot'), t.getAttribute('data-do')); break;
      case 'give': doSwap(t.getAttribute('data-slot'), 'give', t.getAttribute('data-to')); break;
      case 'nudge': nudge(t.getAttribute('data-slot')); break;
      case 'addchore': openChore(null); break;
      case 'editchore': openChore(t.getAttribute('data-cid')); break;
      case 'delchore': if (confirm('Delete this chore? It comes off everyone’s week.')) saveChores('delete', t.getAttribute('data-cid'), null, null); break;
      case 'suggest': openSuggest(); break;
      case 'starters': openStarters(); break;
      case 'startset': setRadio(t); if (sh.__startset) sh.__startset(t.getAttribute('data-v')); break;
      case 'pickemo': setRadio(t); sh.__pick.emoji = t.getAttribute('data-emo'); break;
      case 'pickeff': setRadio(t); sh.__pick.effort = Number(t.getAttribute('data-v')); $('#effHint', sh).textContent = C.EFFORT_HINT[sh.__pick.effort] + ' · worth ' + plural(sh.__pick.effort, 'point'); break;
      case 'pickfreq': setRadio(t); sh.__pick.freq = t.getAttribute('data-v'); break;
      case 'pickw': setRadio(t); sh.__pick.weight = Number(t.getAttribute('data-v')); break;
      case 'emo': {
        setRadio(t);
        if (sh.contains(t) && sh.__pick) sh.__pick.emoji = t.getAttribute('data-emo');
        else if (state.join) state.join.pick = t.getAttribute('data-emo');
        break;
      }
      case 'tcant': case 'tdis': {
        var p = sh.__pick; var cid = t.getAttribute('data-cid');
        var list = act === 'tcant' ? p.cant : p.dislikes;
        var i = list.indexOf(cid);
        if (i >= 0) list.splice(i, 1);
        else {
          if (act === 'tdis' && list.length >= C.LIMITS.dislikes) { toast('Up to ' + C.LIMITS.dislikes + ' least-liked chores.'); break; }
          list.push(cid);
        }
        t.setAttribute('aria-pressed', String(list.indexOf(cid) >= 0));
        break;
      }
      case 'person': openPerson(t.getAttribute('data-mid')); break;
      case 'addperson': openPerson(null); break;
      case 'rmperson': removePerson(t.getAttribute('data-mid')); break;
      case 'leave': removePerson(actor().mid); break;
      case 'goonline': goOnline(); break;
      case 'qrbig': showQr(); break;
      case 'sharejoin': {
        var link = joinLink();
        if (navigator.share) navigator.share({ title: state.home.name, text: 'Join ' + state.home.name + ' on Chorus - our chores, split fairly:', url: link }).catch(function () { /* closed */ });
        else copy(link, 'Link copied');
        break;
      }
      case 'copyjoin': copy(joinLink(), 'Link copied'); break;
      case 'rotate':
        if (confirm('Make a new code? The old link and QR stop working; nobody already in is affected.')) api('POST', 'api/homes/' + HOME_ID + '/code', {}).then(function (d) { setBundle(d); draw(); toast('New code ready'); }).catch(function (err) { showError(err); });
        break;
      case 'delhome':
        if (isLocal()) {
          if (confirm('Clear ' + state.home.name + ' from this phone? Its chores and history are deleted. This can’t be undone.')) { keep(K_HOME, null); location.href = BASE + '#start'; }
        } else if (confirm('Delete ' + state.home.name + ' for everyone, with all its history? This can’t be undone.')) {
          api('DELETE', 'api/homes/' + HOME_ID).then(function () { forgetHome(HOME_ID); location.href = BASE + '#start'; }).catch(function (err) { showError(err); });
        }
        break;
      case 'seat': doJoin({ seat: t.getAttribute('data-mid') }, t); break;
      // the wizard
      case 'tpl': setTemplate(t.getAttribute('data-v')); drawWizard(); var n = $('#wName'); if (n) n.focus(); break;
      case 'wnext': {
        var w = state.wiz;
        if (w.step === 1 && !w.template) break;
        if (w.step === 2) {
          if (!w.people[0].name.trim()) { showError(new Error('Add your own name first.'), $('#wErr')); break; }
          var names = w.people.map(function (x) { return x.name.trim().toLowerCase(); }).filter(Boolean);
          if (names.some(function (x, i) { return names.indexOf(x) !== i; })) { showError(new Error('Two people have the same name - add an initial.'), $('#wErr')); break; }
        }
        w.step++; drawWizard(); scrollTo(0, 0);
        break;
      }
      case 'wback': state.wiz.step--; drawWizard(); scrollTo(0, 0); break;
      case 'wadd': {
        var used = state.wiz.people.map(function (x) { return x.emoji; });
        state.wiz.people.push({ id: C.newId('m'), name: '', emoji: C.EMOJI.filter(function (x) { return used.indexOf(x) < 0; })[0] || C.EMOJI[0], weight: 1 });
        drawWizard();
        var ins = $$('.wpeople input'); if (ins.length) ins[ins.length - 1].focus();
        break;
      }
      case 'wrm': state.wiz.people.splice(Number(t.getAttribute('data-i')), 1); drawWizard(); break;
      case 'wkid': { var pp = state.wiz.people[Number(t.getAttribute('data-i'))]; pp.weight = pp.weight === 0.5 ? 1 : 0.5; t.setAttribute('aria-pressed', String(pp.weight === 0.5)); break; }
      case 'wemo': {
        var pe = state.wiz.people[Number(t.getAttribute('data-i'))];
        var taken = state.wiz.people.map(function (x) { return x.emoji; });
        var k = C.EMOJI.indexOf(pe.emoji);
        for (var s2 = 1; s2 <= C.EMOJI.length; s2++) { var cand = C.EMOJI[(k + s2) % C.EMOJI.length]; if (taken.indexOf(cand) < 0) { pe.emoji = cand; break; } }
        t.textContent = pe.emoji;
        break;
      }
      case 'wdone': wizardDone(); break;
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
      if (state.view === 'start') loadMyHomes();
      if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
    });
  }
})();
