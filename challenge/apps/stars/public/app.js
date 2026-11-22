/* Stars - the page. One file, no build step.
 *
 * EVERYTHING HAPPENS ON THIS PHONE. Each dish - its name, its menu section,
 * its price, plate cost and units sold - is worked out by StarsCore (the
 * contribution margin, food cost and menu mix, the section's margin and
 * popularity lines, the quadrant, the suggestions, the what-if) and kept
 * through stars-store.js (IndexedDB, with a memory fallback). A sales CSV
 * is read in this tab and only the rows applied are kept. The made-up
 * example is never kept, sent or synced.
 *
 * The requests this page makes: sign-in, the account's copy of the menu
 * (signed in, to keep two phones in step), and the one optional "Read the
 * menu", whose body - one or two photos shrunk on this phone, or the pasted
 * menu, and nothing else - is shown before it is sent. Plate costs and
 * sales never go with it.
 *
 * Every string a person typed, the server sent or a model wrote is escaped
 * before it is drawn, and no handler is written into markup: clicks,
 * changes and input are routed by data-* attributes from one listener each
 * (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.StarsCore;
  var D = window.StarsDemo;
  var RS = window.StarsStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural, M = C.fmtMoney, P = C.fmtPct;
  var REDUCED = (function () { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return { matches: false }; } }());

  var real = RS.create(RS.idb('stars'));

  var state = {
    me: null, view: 'start', book: null, demo: false, demoBook: null, device: RS.cleanDevice({}), sync: RS.cleanSync({}), syncState: 'local', syncErr: '',
    tour: 0, did: null, draft: null, mergeNote: null, demoClock: 0, chartKey: null, wi: null, csv: null, reading: null,
    read: { mode: 'photo', photos: {}, text: '' },
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.error) { var e = new Error(data.error || 'Something went wrong.'); e.status = res.status; e.data = data; throw e; }
        return data;
      });
    });
  }
  var toastTimer = null;
  function toast(msg, ms) {
    $$('.toast').forEach(function (t) { t.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function say(msg) { var l = $('#live'); l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function shareText(title, text, done) {
    if (navigator.share) navigator.share({ title: title, text: text }).catch(function (er) { if (!er || er.name !== 'AbortError') copy(text, done); });
    else copy(text, done);
  }
  /** A file made on this phone and handed to the browser to save. */
  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'text/plain' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) { where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; reveal(where); }
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Stars stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    reveal(where);
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function reveal(el) { try { el.scrollIntoView({ block: 'center', behavior: REDUCED.matches ? 'auto' : 'smooth' }); } catch (e) { /* old browsers */ } }
  function meteredError(err, box, retry, why) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount(why, retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    if (err.status === 413) return showError(new Error('That was too much to send. Try again - the page shrinks photos first.'), box);
    showError(err, box);
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }


  /* ---------------- the clock and ids (the page's, never the core's) ---------------- */

  function stamp() { if (state.demo) { state.demoClock += 1000; return D.T + state.demoClock; } return Date.now(); }
  function rid(n) { var s = '', abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; try { var a = new Uint8Array(n); crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += abc[a[i] % 36]; } catch (e) { for (var j = 0; j < n; j++) s += abc[Math.floor(Math.random() * 36)]; } return s; }
  function newId() { return 'i' + rid(9); }

  /* ---------------- the menu: this phone's, and the example ---------------- */

  function book() { return state.demo ? state.demoBook : state.book; }
  function dish(id) { var b = book(), x = b && b.items[id]; if (!x || x.del) return null; var y = C.clone(x); y.id = id; return y; }
  function saveLocal() { real.putBook(state.book).catch(function () { /* still in this tab */ }); }
  function saveDevice() { if (!state.demo) real.putDevice(state.device).catch(function () { /* fine */ }); }
  function saveSync() { real.putSync(state.sync).catch(function () { /* fine */ }); }
  /** Keep a changed menu: the example in memory only; a real one on this
   *  phone and, signed in, in the account. */
  function commit(next, quiet) {
    if (state.demo) state.demoBook = next;
    else { state.book = next; saveLocal(); pushSoon(); }
    if (!quiet) keepPlace(draw);
  }
  function ensureBook() { if (!state.demo && !state.book) state.book = C.newBook(stamp()); return book(); }
  function placeName() { return state.demo ? D.NAME : (state.device.place || 'My menu'); }

  /* ---------------- two phones: the account copy ---------------- */

  var pushTimer = null;
  function bodyOf(b) { return C.cleanBook(b).book; }
  function pushSoon() {
    if (!signedIn() || !state.me.sync || state.demo || !state.book) return;
    clearTimeout(pushTimer);
    state.syncState = 'syncing'; drawSync();
    pushTimer = setTimeout(function () { push(); }, 800);
  }
  function push(base) {
    if (!state.book || !signedIn() || state.demo) return Promise.resolve();
    return api('PUT', 'api/sync', { data: bodyOf(state.book), base: base !== undefined ? base : state.sync.base }).then(function (out) {
      state.sync = { base: out.updatedAt, at: stamp() }; saveSync();
      state.syncState = 'synced'; state.syncErr = ''; drawSync();
    }).catch(function (err) {
      var code = err.data && err.data.code;
      if (err.status === 409 && code === 'conflict' && err.data.data) return mergeIn(err.data.data, err.data.updatedAt);
      if (err.status === 409 && code === 'removed') { state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'removed'; drawSync(); return null; }
      state.syncState = 'error'; state.syncErr = err.message; drawSync();
      return null;
    });
  }
  function adopt(acc, at) {
    state.book = C.cleanBook(acc).book;
    state.sync = { base: at, at: stamp() }; saveLocal(); saveSync();
    state.syncState = 'synced'; drawSync();
    if (state.view === 'start') go('menu'); else keepPlace(draw);
  }
  /** The account's copy came back different: merge it into this phone's
   *  (each dish by its own time; a dish both phones changed keeps both),
   *  keep the result here, and save it against the account's version. */
  function mergeIn(acc, at) {
    var local = state.book;
    if (!local) { adopt(acc, at); return null; }
    var m = C.merge(local, acc, state.sync.at && state.sync.base ? state.sync.base : 0);
    var merged = m.book;
    var pulled = !C.same(merged, local);
    state.book = merged; saveLocal();
    if (pulled || m.notes.length) {
      state.mergeNote = { notes: m.notes };
      if (state.view !== 'edit') keepPlace(draw);
    }
    if (C.same(merged, C.cleanBook(acc).book)) { state.sync = { base: at, at: stamp() }; saveSync(); state.syncState = 'synced'; drawSync(); return null; }
    return push(at);
  }
  function syncIn() {
    if (!signedIn() || !state.me.sync || state.demo) return Promise.resolve();
    return api('GET', 'api/sync').then(function (out) {
      if (!out.data) {
        if (!state.book) { state.syncState = 'synced'; drawSync(); return null; }
        if (state.sync.base === null) return push(null);
        state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'removed'; drawSync(); return null;
      }
      if (!state.book) { adopt(out.data, out.updatedAt); return null; }
      if (state.sync.base === out.updatedAt) { if (!C.same(state.book, out.data)) return push(); state.syncState = 'synced'; drawSync(); return null; }
      return mergeIn(out.data, out.updatedAt);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function syncLine() {
    if (state.demo) return '<span class="sync small muted">The example is never saved, sent or synced.</span>';
    if (!signedIn()) return '<span class="sync small muted">On this phone only · <button class="link-btn" type="button" data-act="signin">sign in to keep two phones in step</button></span>';
    if (state.me && !state.me.sync) return '<span class="sync small muted">Keeping it in the account is unavailable right now - it is on this phone.</span>';
    if (state.syncState === 'syncing') return '<span class="sync small muted">Saving to your account…</span>';
    if (state.syncState === 'removed') return '<span class="sync small warnline">Removed from your account on another phone - kept here. <button class="link-btn" type="button" data-act="resync">Keep it in the account again</button></span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t reach your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small okline">✓ In step with your account</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }
  function mergeNoteHtml() {
    var m = state.mergeNote;
    if (!m || state.demo) return '';
    var lines = ['Changes from your other phone are in.'].concat(m.notes.slice(0, 4));
    return '<div class="merged" role="status"><b>Merged with your other phone</b> <button class="link-btn" type="button" data-act="mergeok">OK</button><ul>' + lines.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>';
  }


  /* ---------------- navigation ---------------- */

  var VIEWS = ['start', 'menu', 'dish', 'edit', 'add', 'chart', 'import', 'report', 'more'];
  function go(view, after) {
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
    if (after) after();
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var v = VIEWS.indexOf(h) >= 0 ? h : 'start';
    if (v === 'add') { if (!state.draft || !state.draft.isNew) state.draft = newDraft(); v = 'edit'; }
    if (v === 'dish' && !(state.did && dish(state.did))) v = book() ? 'menu' : 'start';
    if (v === 'edit' && !state.draft) v = book() ? 'menu' : 'start';
    if (['menu', 'chart', 'report', 'more'].indexOf(v) >= 0 && !book()) v = 'start';
    if (v === 'start' && book() && !state.demo && h === '') v = 'menu';
    state.view = v;
    draw();
  }
  var drawing = false;
  function draw() {
    if (drawing) { setTimeout(draw, 0); return; }
    drawing = true;
    try { drawNow(); } finally { drawing = false; }
  }
  function drawNow() {
    var main = $('#main'), tb = $('#tabbar');
    tb.hidden = state.view === 'start';
    var tab = state.view === 'dish' ? 'menu' : state.view === 'report' ? 'more' : state.view === 'edit' ? (state.draft && state.draft.isNew ? 'add' : 'menu') : state.view;
    $$('#tabbar [data-tab]').forEach(function (x) { if (x.getAttribute('data-tab') === tab) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    var v = state.view, html;
    if (v === 'menu') html = menuHtml();
    else if (v === 'dish') html = dishHtml();
    else if (v === 'edit') html = editHtml();
    else if (v === 'chart') html = chartViewHtml();
    else if (v === 'import') html = importHtml();
    else if (v === 'report') html = reportHtml();
    else if (v === 'more') html = moreHtml();
    else html = startHtml();
    main.innerHTML = html;
    document.body.classList.toggle('in-demo', state.demo);
    drawSync();
  }

  /* ---------------- the example and its tour ---------------- */

  var TOUR = [
    { view: 'menu', title: 'The menu, section by section', body: 'Seventeen made-up dishes at Saltmarrow Kitchen with four weeks of sales. Each one is a star, a plowhorse, a puzzle or a dog against its own section’s lines - the Mains margin line is $12.17 (the average margin, weighted by units sold) and its popularity line 102.1 units (70% of an even share).', btn: 'Open the beer-battered fish', next: 'Next: why it is a plowhorse' },
    { view: 'dish', title: 'A plowhorse', body: '$19.00 less an $8.60 plate is a $10.40 margin - under the $12.17 line - but 260 sold is well over the popularity line. Raising its price raises the line too, so Stars solves for it: at $21.52 it reaches the line, with the same sales.', btn: 'Try $21.75 in the what-if', next: 'Next: the four quadrants' },
    { view: 'chart', title: 'The four quadrants', body: 'Margin up the side, units sold along the bottom, the two lines crossing: stars top right, plowhorses bottom right, puzzles top left, dogs bottom left. Every dot is numbered and named in the table under it.', btn: 'Show the whole menu', next: 'Next: this week’s sales' },
    { view: 'import', title: 'A sales file', body: 'Open the till’s export: Stars guesses which column is which and you can change every one. Rows for the same dish add up, a new dish is added, and a row with a phone number or a typo says what is wrong. All on this phone.', btn: 'Read the example sales file', next: 'Next: read a menu' },
    { view: 'import', title: 'Read a menu', body: 'Photograph the menu, or paste it, and AI reads the dishes and prices for you to confirm. Plate costs and sales are never sent; a plate cost or a phone number in the reading is dropped.', btn: 'Read the example menu', next: 'Next: the report' },
    { view: 'report', title: 'The report', body: 'Every section on one page - its lines, the chart, each dish with its quadrant and the first thing to do about it. Print it for the kitchen meeting, or save it as a PDF.', btn: 'Print the report', next: 'Start my own menu' },
  ];
  function startDemo() {
    state.demo = true; state.demoBook = D.book(); state.demoClock = 0; state.tour = 1; state.mergeNote = null; state.draft = null; state.did = null; state.csv = null; state.reading = null; state.chartKey = null; state.wi = null;
    go('menu');
  }
  function leaveDemo() {
    state.demo = false; state.demoBook = null; state.tour = 0; state.draft = null; state.did = null; state.csv = null; state.reading = null; state.chartKey = null; state.wi = null;
    if (!state.device.tour) { state.device.tour = true; saveDevice(); }
    go(state.book ? 'menu' : 'start');
  }
  function tourStep(n) {
    if (n > TOUR.length) { leaveDemo(); go('add'); return; }
    state.tour = n;
    if (n === 2) { state.did = D.FISH; state.wi = null; }
    if (n === 3) state.chartKey = 'mains';
    go(TOUR[n - 1].view);
  }
  function guideHtml(view) {
    if (!state.demo) return '';
    var n = state.tour, s = TOUR[n - 1];
    if (!s || s.view !== view) {
      return '<div class="guide" role="note"><div class="gt"><span class="gstep">Example · ' + esc(D.NAME) + '</span><span>Made up - every tap works, and nothing is kept.</span></div><button class="btn ghost small" type="button" data-act="tour" data-step="1">Take the tour</button></div>';
    }
    return '<div class="guide" role="note"><div class="gt"><span class="gstep">' + esc('Example · step ' + n + ' of ' + TOUR.length) + '</span><b>' + esc(s.title) + '</b><span>' + esc(s.body) + '</span></div>' +
      '<div class="btns"><button class="btn ghost" type="button" data-act="tourdo" data-step="' + esc(n) + '">' + esc(s.btn) + '</button><button class="btn" type="button" data-act="' + (n === TOUR.length ? 'tourdone' : 'tour') + '" data-step="' + esc(n + 1) + '">' + esc(s.next) + '</button></div></div>';
  }
  function demoRibbon() {
    return state.demo ? '<p class="ribbon">' + esc(D.NOTICE) + ' <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>' : '';
  }
  function tourDo(n) {
    if (n === 1) { state.did = D.FISH; state.wi = null; state.tour = 2; go('dish'); }
    if (n === 2) { state.wi = { id: D.FISH, price: '21.75', sold: '260' }; keepPlace(draw); var w = $('#whatif'); if (w) reveal(w); say('With the price at $21.75 the fish becomes a star.'); }
    if (n === 3) { state.chartKey = '*'; keepPlace(draw); }
    if (n === 4) { readCsv(D.CSV); }
    if (n === 5) readExample();
    if (n === 6) window.print();
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var has = Boolean(state.book);
    return '<div class="stack">' +
      '<section class="hero"><div><p class="kicker">⭐ For independent restaurants</p><h1>Find the stars on your menu - and the dogs eating your margin.</h1>' +
      '<p>Type each dish’s price, plate cost and units sold - or open the till’s sales file - and Stars works out its contribution margin and popularity against the rest of its section: a star, a plowhorse, a puzzle or a dog. Plain suggestions for each one, a what-if price, food cost, and a report to print for the kitchen meeting.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the example</button>' +
      (has ? '<button class="btn big ghost" type="button" data-act="tab" data-tab="menu">My menu</button>' : '<button class="btn big ghost" type="button" data-act="tab" data-tab="add">Add a dish</button>') + '</div>' +
      '<p class="caps">Free · no sign-in · works offline</p></div>' +
      '<div class="hero-art" aria-hidden="true"><div class="quadcard"><div><b>Puzzle</b><span>Earns well, few order it</span></div><div class="qs"><b>⭐ Star</b><span>Earns well, sells well</span></div><div><b>Dog</b><span>Earns little, sells little</span></div><div><b>Plowhorse</b><span>Sells well, earns little</span></div></div></div></section>' +
      '<section class="card"><h2>How it works</h2><div class="how4">' +
      '<div><h3>Your dishes, once</h3><p>Price, plate cost and units sold - typed, from a sales CSV, or read from a photo of the menu by AI for you to confirm.</p></div>' +
      '<div><h3>The classic method</h3><p>Margin against the section’s sales-weighted average, popularity against 70% of an even share.</p></div>' +
      '<div><h3>What to do about each</h3><p>Reprice, reposition, rework the plate or cut - with the exact price that would cross the line.</p></div>' +
      '<div><h3>A report to print</h3><p>Every section, its chart and table, food cost and the first move for each dish.</p></div>' +
      '</div></section>' +
      '<section class="card"><ul class="ticks"><li>No account needed - everything works signed out, on this phone.</li><li>Money is kept in whole cents and every comparison is exact, so a dish on the line is never misjudged by a rounding.</li><li>Reading a menu with AI sends the menu alone - never your plate costs or sales.</li></ul></section>' +
      '<p class="foot">Stars is a trial in the Challenge Lab.</p></div>';
  }

  /* ---------------- shared pieces ---------------- */

  function quadChip(q) { return '<span class="q ' + esc(q) + '">' + esc(C.QUAD[q].label) + '</span>'; }
  function waitChip(x) { return '<span class="q none">' + esc(!C.isInt(x.cost) && !C.isInt(x.sold) ? 'Needs plate cost and units' : !C.isInt(x.cost) ? 'Needs a plate cost' : 'Needs units sold') + '</span>'; }
  function linesText(g) {
    if (!g || !g.n) return '';
    return 'Margin line ' + M(g.avgCm) + (g.noSales ? ' (plain average - nothing sold)' : '') + ' · popularity line ' + (g.popUnits10 / 10).toFixed(1) + ' units (' + P(g.popShare) + ' of ' + C.fmtUnits(g.sold) + ')';
  }
  function sectionNote(g) {
    if (!g || !g.n) return '';
    if (g.noSales) return '<p class="small warnline">Nothing in this section has sales for the period yet, so nothing in it can be popular.</p>';
    if (g.lone) return '<p class="small muted">One rated dish alone: it is compared with itself, so it is a star by definition when it sells. Compare it on the whole menu in Quadrants.</p>';
    return '';
  }

  /* ---------------- the menu ---------------- */

  function menuHtml() {
    var b = book(), secs = C.sections(b), all = C.analyse(C.liveItems(b));
    var counts = C.QUADS.map(function (q) { var n = 0; secs.forEach(function (s) { n += s.g.counts[q]; }); return n ? '<span class="q ' + esc(q) + '">' + esc(C.QUAD[q].label + 's · ' + n) + '</span>' : ''; }).join('');
    var cards = secs.map(function (s) {
      var rated = s.g.items.slice().sort(function (x, y) { return C.QUADS.indexOf(x.quad) - C.QUADS.indexOf(y.quad) || y.earned - x.earned; });
      var rows = rated.map(function (x) {
        return '<li><button class="drow" type="button" data-act="open" data-id="' + esc(x.id) + '"><span class="dn">' + esc(x.name) + '</span><span class="dr">' + quadChip(x.quad) +
          '<span>' + esc(M(x.cm) + ' margin') + '</span><span class="muted">' + esc(C.fmtUnits(x.sold) + ' sold · food cost ' + P(x.foodPct)) + '</span>' + (x.loses ? '<span class="flag">Loses money</span>' : '') + '</span></button></li>';
      }).join('') + s.items.filter(function (x) { return !C.rated(x); }).map(function (x) {
        return '<li><button class="drow" type="button" data-act="open" data-id="' + esc(x.id) + '"><span class="dn">' + esc(x.name) + '</span><span class="dr">' + waitChip(x) + '<span>' + esc(M(x.price)) + '</span></span></button></li>';
      }).join('');
      return '<section class="card"><div class="secthead"><h2 style="margin:0">' + esc(s.name) + '</h2><span class="small muted">' + esc(plural(s.items.length, 'dish', 'dishes') + (s.g.foodPct !== null ? ' · food cost ' + P(s.g.foodPct) : '')) + '</span></div>' +
        (s.g.n ? '<p class="lines" style="margin:6px 0 0">' + esc(linesText(s.g)) + '</p>' : '') + sectionNote(s.g) +
        '<ul class="dlist" style="list-style:none;padding:0">' + rows + '</ul></section>';
    }).join('');
    var period = b.period && b.period.label ? b.period.label : 'No period named yet';
    return '<div class="stack">' + demoRibbon() + guideHtml('menu') + mergeNoteHtml() +
      '<section class="card"><div class="row spread"><h1 style="margin:0">' + esc(placeName()) + '</h1><div class="btns"><button class="btn small ghost" type="button" data-act="tab" data-tab="chart">Quadrants</button><button class="btn small ghost" type="button" data-act="tab" data-tab="report">Report</button><button class="btn small" type="button" data-act="tab" data-tab="add">Add a dish</button></div></div>' +
      '<p class="muted small" style="margin:6px 0">' + esc(period + ' · ' + plural(C.liveItems(b).length, 'dish', 'dishes')) + '</p>' +
      (all.n ? '<div class="figs" style="margin:10px 0"><div class="figure"><div class="fw">Sales</div><div class="fv">' + esc(M(all.revenue)) + '</div></div><div class="figure"><div class="fw">Food cost</div><div class="fv">' + esc(P(all.foodPct)) + '</div></div><div class="figure"><div class="fw">Margin earned</div><div class="fv">' + esc(M(all.tcm)) + '</div></div><div class="figure"><div class="fw">Units sold</div><div class="fv">' + esc(C.fmtUnits(all.sold)) + '</div></div></div>' : '') +
      (counts ? '<div class="counts" aria-label="How many of each kind">' + counts + '</div>' : '') + '<p class="small" data-sync>' + syncLine() + '</p></section>' +
      (cards || '<section class="card"><p>No dishes yet.</p><div class="btns"><button class="btn" type="button" data-act="tab" data-tab="add">Add the first one</button><button class="btn ghost" type="button" data-act="tab" data-tab="import">Import a sales file or a menu</button></div></section>') +
      '</div>';
  }

  /* ---------------- one dish ---------------- */

  function dishHtml() {
    var x = dish(state.did), s = C.sectionOf(book(), x.id), g = s.g, r = C.find(g, x.id);
    var head = '<section class="card"><p class="small muted" style="margin:0"><button class="link-btn" type="button" data-act="tab" data-tab="menu">← ' + esc(s.name) + '</button></p><h1 style="margin:4px 0 8px">' + esc(x.name) + '</h1>';
    var acts = '<div class="btns" style="margin-top:12px"><button class="btn ghost" type="button" data-act="edit" data-id="' + esc(x.id) + '">Edit</button><button class="btn ghost danger" type="button" data-act="remove" data-id="' + esc(x.id) + '">Remove</button></div>';
    if (!r) {
      return '<div class="stack">' + demoRibbon() + guideHtml('dish') + head + '<p>' + waitChip(x) + ' ' + esc(M(x.price)) + '</p><p class="muted">Add its plate cost and units sold for the period and Stars rates it against the rest of ' + esc(s.name) + '.</p>' + acts + '</section></div>';
    }
    var why = [
      'Its margin, ' + M(r.cm) + ' (' + M(r.price) + ' less a ' + M(r.cost) + ' plate), is ' + (r.onCmLine ? 'exactly on' : r.hiCm ? 'above' : 'under') + ' the ' + s.name + ' margin line of ' + M(g.avgCm) + (g.noSales ? ', the plain average of the margins (nothing sold yet).' : ', the average margin weighted by units sold.'),
      C.fmtUnits(r.sold) + ' sold' + (r.mix !== null ? ' (' + P(r.mix) + ' of the section)' : '') + ' is ' + (g.noSales ? 'not rated for popularity: nothing in the section sold.' : (r.onPopLine ? 'exactly on' : r.hiPop ? 'at or above' : 'under') + ' the popularity line of ' + (g.popUnits10 / 10).toFixed(1) + ' - 70% of an even share of ' + C.fmtUnits(g.sold) + ' across ' + plural(g.n, 'dish', 'dishes') + '.'),
    ];
    if (r.onCmLine || r.onPopLine) why.push('On a line counts as high.');
    var sug = C.suggestions(g, r).map(function (o) { return '<li><span class="kind">' + esc(o.kind === 'note' ? 'Note' : o.kind) + '</span>' + esc(o.text) + '</li>'; }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('dish') + head +
      '<p class="verdict">' + quadChip(r.quad) + ' ' + esc(C.QUAD[r.quad].what + '.') + (r.loses ? ' <span class="flag">Loses ' + esc(M(-r.cm)) + ' a plate</span>' : '') + '</p>' +
      '<div class="figs" style="margin-top:12px"><div class="figure"><div class="fw">Price</div><div class="fv">' + esc(M(r.price)) + '</div></div><div class="figure"><div class="fw">Plate cost</div><div class="fv">' + esc(M(r.cost)) + '</div></div><div class="figure"><div class="fw">Margin</div><div class="fv">' + esc(M(r.cm)) + '</div></div><div class="figure"><div class="fw">Food cost</div><div class="fv">' + esc(P(r.foodPct)) + '</div></div></div>' +
      '<h2 style="margin-top:14px">Why</h2><ul class="why">' + why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' + acts + '</section>' +
      '<section class="card"><h2>What to do</h2><ul class="sugg">' + sug + '</ul></section>' +
      whatIfHtml(s, r) + '</div>';
  }
  function whatIfHtml(s, r) {
    var lp = C.linePrice(s.g, r);
    var wi = state.wi && state.wi.id === r.id ? state.wi : { id: r.id, price: C.moneyField(lp !== null ? C.menuPrice(lp) : r.price), sold: String(r.sold) };
    state.wi = wi;
    return '<section class="card" id="whatif"><h2>What if</h2><p class="small muted">Change the price - and the units, if you expect them to move - and see the margin and quadrant, everything else in ' + esc(s.name) + ' selling the same.</p>' +
      '<div class="whatif"><label class="field"><span>Price</span><input class="input" inputmode="decimal" data-wi="price" value="' + esc(wi.price) + '"></label><label class="field"><span>Units sold</span><input class="input" inputmode="numeric" data-wi="sold" value="' + esc(wi.sold) + '"></label></div>' +
      '<div class="wiout" id="wiout" aria-live="polite">' + whatIfOut(s, r) + '</div>' +
      '<div class="btns" style="margin-top:10px"><button class="btn ghost" type="button" data-act="wiapply">Use this price</button></div></section>';
  }
  function whatIfOut(s, r) {
    var wi = state.wi, p = C.parseMoney(wi.price, 'The price'), u = C.parseUnits(wi.sold);
    if (p.error) return esc(p.error);
    if (p.v < 1 || p.v > C.LIMITS.priceMax) return esc('The price should be $0.01 to $999.99.');
    if (u.error) return esc(u.error);
    var w = C.whatIf(s.g.items, r.id, p.v, u.v), a = w.after;
    return esc('At ' + M(a.price) + ' and ' + C.fmtUnits(a.sold) + ' sold: margin ' + M(a.cm) + ', food cost ' + P(a.foodPct) + ', ' + s.name + ' margin line ' + M(w.groupAfter.avgCm) + ' - ') + quadChip(a.quad) + (a.quad !== r.quad ? esc(' (was a ' + C.QUAD[r.quad].label.toLowerCase() + ')') : esc(' (no change)'));
  }

  /* ---------------- the quadrant chart ---------------- */

  function chartGroups() {
    var b = book(), secs = C.sections(b).filter(function (s) { return s.g.n; });
    var out = secs.map(function (s) { return { key: s.key, name: s.name, g: s.g }; });
    if (secs.length > 1) out.push({ key: '*', name: 'Whole menu', g: C.analyse(C.liveItems(b)) });
    return out;
  }
  function numbered(g) { return g.items.slice().sort(function (x, y) { return C.QUADS.indexOf(x.quad) - C.QUADS.indexOf(y.quad) || y.earned - x.earned || x.name.localeCompare(y.name); }); }
  function chartSvg(grp, idp) {
    var g = grp.g, rows = numbered(g), W = 640, H = 440, pl = 96, pr = 24, pt = 30, pb = 60;
    var popLine = g.pop.num / g.pop.den, avg = g.line.num / g.line.den;
    var maxX = Math.max(popLine, 1, Math.max.apply(null, rows.map(function (r) { return r.sold; }))) * 1.12;
    var cms = rows.map(function (r) { return r.cm; }).concat([avg, 0]);
    var lo = Math.min.apply(null, cms), hi = Math.max.apply(null, cms), pad = Math.max(50, (hi - lo) * 0.1);
    lo = lo < 0 ? lo - pad : 0; hi += pad;
    var x = function (v) { return Math.round(pl + (W - pl - pr) * v / maxX); };
    var y = function (v) { return Math.round(pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo))); };
    var qx = x(popLine), qy = y(avg);
    var corner = function (tx, ty, anchor, label) { return '<text class="qlab" x="' + tx + '" y="' + ty + '" text-anchor="' + anchor + '">' + esc(label) + '</text>'; };
    var dots = rows.map(function (r, i) {
      var label = (i + 1) + '. ' + r.name + ': ' + M(r.cm) + ' margin, ' + C.fmtUnits(r.sold) + ' sold - ' + C.QUAD[r.quad].label;
      return '<g class="dot ' + esc(r.quad) + '" tabindex="0" role="img" data-act="dot" data-tip="' + esc(label) + '" aria-label="' + esc(label) + '"><title>' + esc(label) + '</title><circle class="hit" cx="' + x(r.sold) + '" cy="' + y(r.cm) + '" r="26"/><circle class="m" cx="' + x(r.sold) + '" cy="' + y(r.cm) + '" r="12"/><text x="' + x(r.sold) + '" y="' + y(r.cm) + '" dy="0.35em" text-anchor="middle">' + esc(i + 1) + '</text></g>';
    }).join('');
    return '<svg class="qchart" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-labelledby="' + esc(idp) + 't"><title id="' + esc(idp) + 't">' + esc(grp.name + ': margin against units sold, ' + plural(rows.length, 'dish', 'dishes') + '. The same numbers are in the table below.') + '</title>' +
      '<rect class="zone" x="' + qx + '" y="' + pt + '" width="' + (W - pr - qx) + '" height="' + (qy - pt) + '" opacity=".55"/>' +
      '<line class="ax" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '"/><line class="ax" x1="' + pl + '" x2="' + pl + '" y1="' + pt + '" y2="' + (H - pb) + '"/>' +
      (lo < 0 ? '<line class="ax" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(0) + '" y2="' + y(0) + '"/><text x="' + (pl - 6) + '" y="' + (y(0) + 4) + '" text-anchor="end">$0</text>' : '') +
      '<line class="lim" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + qy + '" y2="' + qy + '"/><line class="lim" x1="' + qx + '" x2="' + qx + '" y1="' + pt + '" y2="' + (H - pb) + '"/>' +
      '<text x="' + (pl - 6) + '" y="' + (qy + 4) + '" text-anchor="end">' + esc(M(Math.round(avg))) + '</text>' +
      '<text x="' + qx + '" y="' + (H - pb + 26) + '" text-anchor="middle">' + esc((g.popUnits10 / 10).toFixed(1)) + '</text>' +
      '<text x="' + (W - pr) + '" y="' + (H - 8) + '" text-anchor="end">' + esc('Units sold →') + '</text>' +
      '<text x="' + pl + '" y="' + (H - 8) + '" text-anchor="start">0</text>' +
      '<text transform="translate(26 ' + Math.round((pt + H - pb) / 2) + ') rotate(-90)" text-anchor="middle">' + esc('Margin a plate →') + '</text>' +
      corner(qx + 8, pt + 4, 'start', 'Stars') + corner(qx - 8, pt + 4, 'end', 'Puzzles') + corner(qx + 8, H - pb - 10, 'start', 'Plowhorses') + corner(qx - 8, H - pb - 10, 'end', 'Dogs') +
      dots + '</svg>';
  }
  function chartTable(grp, links) {
    var rows = numbered(grp.g).map(function (r, i) {
      var nm = links ? '<button class="link-btn" type="button" data-act="open" data-id="' + esc(r.id) + '">' + esc(r.name) + '</button>' : esc(r.name);
      return '<tr><td>' + esc(i + 1) + '</td><td>' + nm + '</td><td>' + quadChip(r.quad) + '</td><td>' + esc(M(r.cm)) + '</td><td>' + esc(C.fmtUnits(r.sold)) + '</td><td>' + esc(P(r.mix)) + '</td><td>' + esc(P(r.foodPct)) + '</td><td>' + esc(M(r.price)) + '</td></tr>';
    }).join('');
    return '<div class="tablebox" tabindex="0" role="region" aria-label="' + esc(grp.name + ' in a table') + '"><table class="grid"><thead><tr><th>#</th><th>Dish</th><th>Kind</th><th>Margin</th><th>Sold</th><th>Mix</th><th>Food cost</th><th>Price</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function legendHtml() { return '<div class="legend" aria-hidden="true">' + C.QUADS.map(function (q) { return quadChip(q); }).join('') + '</div>'; }
  function chartViewHtml() {
    var gs = chartGroups();
    if (!gs.length) return '<div class="stack">' + demoRibbon() + guideHtml('chart') + '<section class="card"><h1>Quadrants</h1><p>No dish has its plate cost and units sold yet. Add them and the chart draws itself.</p><button class="btn" type="button" data-act="tab" data-tab="menu">To the menu</button></section></div>';
    var cur = gs.filter(function (x) { return x.key === state.chartKey; })[0] || gs[0];
    state.chartKey = cur.key;
    var seg = '<div class="seg" role="group" aria-label="Which section">' + gs.map(function (x) { return '<button type="button" data-act="chartkey" data-v="' + esc(x.key) + '" aria-pressed="' + (x.key === cur.key) + '">' + esc(x.name) + '</button>'; }).join('') + '</div>';
    return '<div class="stack">' + demoRibbon() + guideHtml('chart') +
      '<section class="card"><div class="row spread"><h1 style="margin:0">Quadrants</h1><button class="btn small ghost" type="button" data-act="tab" data-tab="report">Report</button></div><div style="margin-top:10px">' + seg + '</div></section>' +
      '<section class="card"><h2>' + esc(cur.name) + '</h2><p class="lines" style="margin:0 0 8px">' + esc(linesText(cur.g)) + '</p>' + sectionNote(cur.g) +
      (cur.key === '*' ? '<p class="small muted">The whole menu at once: a dessert is measured against mains here, so the sections remain the fairer test.</p>' : '') +
      legendHtml() + chartSvg(cur, 'qc') + '<p class="tip" id="qtip" aria-live="polite">Tap or hover a dot for its numbers - every dish is in the table too.</p>' +
      chartTable(cur, true) + '</section></div>';
  }

  /* ---------------- the editor ---------------- */

  function newDraft(cat) { return { id: newId(), isNew: true, fields: C.emptyFields(cat || ''), errs: {}, msg: '' }; }
  function draftOf(id) { var x = dish(id); return { id: id, isNew: false, fields: C.fieldsOf(x), errs: {}, msg: '' }; }
  var HINT = { name: 'As the menu has it.', cat: 'Dishes are compared within their section.', price: 'The menu price, before tax.', cost: 'What one plate costs to make. Leave empty for now if you do not know.', sold: 'Over the period - leave empty for now if you do not know.' };
  function fieldHtml(k) {
    var d = state.draft, v = d.fields[k], err = d.errs[k];
    var mode = k === 'sold' ? ' inputmode="numeric"' : (k === 'price' || k === 'cost') ? ' inputmode="decimal"' : '';
    var list = k === 'cat' ? ' list="catlist"' : '';
    return '<label class="field"><span>' + esc(C.FIELD_LABEL[k]) + '</span><input class="input" data-f="' + esc(k) + '" value="' + esc(v) + '"' + mode + list + ' autocomplete="off"><span class="hint">' + esc(HINT[k]) + '</span>' + (err ? '<span class="ferr" role="alert">' + esc(err) + '</span>' : '') + '</label>';
  }
  function editHtml() {
    var d = state.draft, cats = C.sections(book() || C.newBook(0)).map(function (s) { return '<option value="' + esc(s.name) + '">'; }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('edit') +
      '<section class="card"><h1>' + esc(d.isNew ? 'Add a dish' : 'Edit ' + d.fields.name) + '</h1>' + (d.isNew ? '<p class="small muted">Or bring many at once: <button class="link-btn" type="button" data-act="tab" data-tab="import">a sales CSV, or a menu read by AI</button>.</p>' : '') + (d.msg ? '<p class="err" role="alert">' + esc(d.msg) + '</p>' : '') +
      '<datalist id="catlist">' + cats + '</datalist>' +
      '<div class="formgrid">' + fieldHtml('name') + fieldHtml('cat') + fieldHtml('price') + fieldHtml('cost') + fieldHtml('sold') + '</div></section>' +
      '<div class="preview" id="preview" aria-live="polite">' + previewHtml() + '</div>' +
      '<div class="btns"><button class="btn big" type="button" data-act="save">' + (state.demo ? 'Save (in the example only)' : 'Save on this phone') + '</button><button class="btn big ghost" type="button" data-act="canceledit">Cancel</button></div>' +
      '</div>';
  }
  function previewHtml() {
    var r = C.itemFrom(state.draft.fields, 0);
    if (r.errors.length) return '<span class="muted">' + esc(plural(r.errors.length, 'thing') + ' to fill in or fix: ' + r.errors[0].msg) + '</span>';
    var x = r.item;
    if (!C.isInt(x.cost)) return esc(M(x.price) + ' - add a plate cost to see its margin.');
    return esc('Margin ' + M(x.price - x.cost) + ' a plate · food cost ' + P(C.permille(x.cost, x.price)) + (x.cost > x.price ? ' · it loses money on every plate' : ''));
  }
  function saveDraft() {
    var d = state.draft, t = stamp();
    var r = C.itemFrom(d.fields, t);
    d.errs = {};
    if (r.errors.length) {
      r.errors.forEach(function (x) { if (!d.errs[x.field]) d.errs[x.field] = x.msg; });
      d.msg = 'Not saved yet - ' + plural(r.errors.length, 'thing') + ' to fix below.';
      keepPlace(draw);
      var first = $('.ferr'); if (first) reveal(first);
      return;
    }
    var b = ensureBook();
    commit(C.putItem(b, d.id, r.item, t), true);
    state.did = d.id; state.draft = null; state.wi = null;
    go('dish'); toast(state.demo ? 'Saved in the example.' : 'Saved on this phone.');
  }

  /* ---------------- import: a sales CSV ---------------- */

  function readCsv(text) {
    var plan = C.csvPlan(text);
    state.csv = { plan: plan, map: plan.error ? {} : C.clone(plan.map), res: null, text: String(text).length <= 20000 ? String(text) : '' };
    if (!plan.error) state.csv.res = C.csvRows(plan, state.csv.map, book() || C.newBook(0));
    if (state.view !== 'import') go('import'); else keepPlace(draw);
    var m = $('#mapper'); if (m) reveal(m);
  }
  function csvHtml() {
    var c = state.csv;
    if (!c) return '';
    if (c.plan.error) return '<section class="card" id="mapper"><p class="err" role="alert">' + esc(c.plan.error) + '</p></section>';
    var opts = function (k) {
      return '<select class="input" data-map="' + esc(k) + '"><option value="-1">' + esc(k === 'name' ? 'Pick a column' : 'Not in this file') + '</option>' + c.plan.head.map(function (h, i) { return '<option value="' + i + '"' + (c.map[k] === i ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join('') + '</select>';
    };
    var mapper = '<div class="formgrid">' + C.MAP_KEYS.map(function (k) { return '<label class="field"><span>' + esc(C.FIELD_LABEL[k]) + '</span>' + opts(k) + '</label>'; }).join('') + '</div>';
    var r = c.res, body;
    if (!r || r.error) body = '<p class="err" role="alert">' + esc((r && r.error) || 'Pick the columns.') + '</p>';
    else {
      var rows = r.rows.slice(0, 200).map(function (x) {
        var does = x.errors.length ? x.errors[0] : x.match ? 'Update' : 'Add';
        return '<tr' + (x.errors.length ? ' class="bad"' : '') + '><td>' + esc(x.rows ? x.rows.join(', ') : x.row) + '</td><td>' + esc(x.name) + '</td><td>' + esc(x.cat) + '</td><td>' + esc(C.isInt(x.price) ? M(x.price) : '') + '</td><td>' + esc(C.isInt(x.cost) ? M(x.cost) : '') + '</td><td>' + esc(C.isInt(x.sold) ? C.fmtUnits(x.sold) : '') + '</td><td' + (x.errors.length ? ' class="err"' : '') + '>' + esc(does) + '</td></tr>';
      }).join('');
      body = '<p><b>' + esc(plural(r.adds, 'dish', 'dishes') + ' to add, ' + plural(r.updates, 'to update') + (r.bad ? ', ' + plural(r.bad, 'row') + ' to fix' : '')) + '</b></p>' +
        '<div class="tablebox" tabindex="0" role="region" aria-label="What each row will do"><table class="grid"><thead><tr><th>Row</th><th>Dish</th><th>Section</th><th>Price</th><th>Plate cost</th><th>Sold</th><th>Does</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="csvapply"' + (r.ok ? '' : ' disabled') + '>' + esc('Apply ' + plural(r.ok, 'row')) + '</button><button class="btn ghost" type="button" data-act="csvclear">Start again</button></div>';
    }
    return '<section class="card" id="mapper"><h2>Which column is which</h2><p class="small muted">Stars guessed from the header - change any of them. Rows for the same dish add up their units. A dish already on the menu (same name, same section) is updated; a new one needs a price.</p>' + mapper + body + '</section>';
  }

  /* ---------------- import: a menu read by AI ---------------- */

  var WHY_AI = 'Reading a menu uses a little AI credit, so it needs a free account (it comes with $2).';
  var SENT_PHOTO = 'What is sent: these photos of the menu, shrunk on your phone - and nothing else. Never your plate costs, your sales or anything else in Stars.';
  var SENT_TEXT = 'What is sent: exactly this text - and nothing else. Take out the phone number, address and web address first; Stars refuses text that has them.';
  function shrink(file, side, maxBytes) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.addEventListener('load', function () {
        try {
          var k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          var g = cv.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
          var q = 0.85, url2 = cv.toDataURL('image/jpeg', q);
          while (url2.length > maxBytes && q > 0.35) { q -= 0.1; url2 = cv.toDataURL('image/jpeg', q); }
          URL.revokeObjectURL(url);
          if (url2.length > maxBytes) { reject(new Error('That photo is too detailed to send - try one a little further away.')); return; }
          resolve({ url: url2 });
        } catch (e) { reject(e); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That file could not be read as a photo.')); });
      img.src = url;
    });
  }
  function readBody() {
    var r = state.read;
    if (r.mode === 'text') return { text: r.text };
    return { images: [1, 2].filter(function (s) { return r.photos[s]; }).map(function (s) { return { type: 'image/jpeg', data: r.photos[s].split(',')[1] }; }) };
  }
  function openReadMenu() {
    var intro = '<h2>✨ Read the menu</h2><p>AI reads the dishes and prices off your menu for you to confirm. It has no field for a plate cost or units sold, and nothing it reads is saved until you add it.</p>';
    if (state.demo) {
      sheet(intro + '<p class="small muted">Made-up example. Its reading was written in advance and goes through the same checks as a real one - nothing is sent.</p>' + D.menuSvg() + '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="readexample">Read the example menu</button></div>');
      return;
    }
    if (!signedIn()) {
      sheet(intro + '<div class="note"><p style="margin:0">' + esc(WHY_AI) + ' One account works across every app on this site. Everything else in Stars stays free with no account.</p></div>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="aijoin">Create a free account</button><button class="btn ghost" type="button" data-act="readdemo">See the example first</button></div>');
      return;
    }
    sheet(intro + '<div id="readBody"></div>', function (root) { drawRead($('#readBody', root)); });
  }
  function drawRead(el) {
    el = el || $('#readBody');
    if (!el) return;
    var r = state.read, n = [1, 2].filter(function (s) { return r.photos[s]; }).length;
    var seg = '<div class="seg" role="group" aria-label="Photo or text"><button type="button" data-act="readmode" data-v="photo" aria-pressed="' + (r.mode === 'photo') + '">A photo</button><button type="button" data-act="readmode" data-v="text" aria-pressed="' + (r.mode === 'text') + '">Paste the text</button></div>';
    var body;
    if (r.mode === 'photo') {
      body = '<p class="small muted" style="margin-top:10px">One or two pages of the menu.</p>' +
        '<div class="btns">' + (n < 2 ? '<label class="photobtn">' + (n ? 'Add a second page' : 'Take or choose a photo') + '<input type="file" accept="image/*" data-menuphoto></label>' : '') + (n ? '<button class="btn ghost small" type="button" data-act="clearphotos">Start again</button>' : '') + '</div>' +
        (n ? '<p class="sentline"><b>' + esc(SENT_PHOTO) + '</b></p><div class="aiimgs">' + [1, 2].filter(function (s) { return r.photos[s]; }).map(function (s) { return '<img alt="The photo that will be sent" src="' + esc(r.photos[s]) + '">'; }).join('') + '</div>' : '');
    } else {
      var why = r.text ? C.pasteProblem(r.text) : '';
      body = '<label class="field" style="margin-top:10px"><span>The menu, pasted</span><textarea class="input tall" id="pasteText" data-act-input="paste" spellcheck="false">' + esc(r.text) + '</textarea></label>' +
        '<p class="err" id="pasteWhy" role="alert"' + (why ? '' : ' hidden') + '>' + esc(why) + '</p><p class="sentline small"><b>' + esc(SENT_TEXT) + '</b></p>';
    }
    var ready = r.mode === 'photo' ? n > 0 : Boolean(r.text.trim()) && !C.pasteProblem(r.text);
    el.innerHTML = seg + body + '<div id="readErr"></div><div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="readsend"' + (ready ? '' : ' disabled') + '>Send and read the menu</button><span class="small muted">' + esc('A few cents' + (state.me && state.me.tier === 'paid' ? ' (member model)' : '') + '. Read once and not kept.') + '</span></div>';
  }
  function readSend(btn) {
    var sent = readBody();
    btn.disabled = true; btn.textContent = 'Reading the menu…';
    api('POST', 'api/ai/menu', sent).then(function (res) {
      loadMe();
      takeReading(res, false);
      state.read = { mode: state.read.mode, photos: {}, text: '' };
      toast('Read - check every dish and price against the menu.');
    }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send and read the menu'; meteredError(err, $('#readErr'), openReadMenu, WHY_AI); });
  }
  function takeReading(res, example) {
    state.reading = { example: example, dropped: res.dropped.slice(), items: res.items.map(function (x) { return { keep: Boolean(x.price), name: x.name, cat: x.cat, price: x.price, unsure: x.unsure, err: '' }; }) };
    closeSheet(true);
    if (state.view !== 'import') go('import'); else keepPlace(draw);
    var c = $('#reading'); if (c) reveal(c);
  }
  function readExample() { takeReading(C.cleanAiMenu(D.MENU_RAW), true); }
  function readingHtml() {
    var R0 = state.reading;
    if (!R0) return '';
    var rows = R0.items.map(function (x, i) {
      return '<div class="note" style="margin-top:8px"><label class="checkrow"><input type="checkbox" data-rd="keep" data-i="' + i + '"' + (x.keep ? ' checked' : '') + '> Add this dish' + (x.unsure ? ' <span class="check">· check this</span>' : '') + '</label>' +
        '<div class="formgrid three"><label class="field"><span>Dish</span><input class="input" data-rd="name" data-i="' + i + '" value="' + esc(x.name) + '"></label><label class="field"><span>Section</span><input class="input" data-rd="cat" data-i="' + i + '" value="' + esc(x.cat) + '"></label><label class="field"><span>Price</span><input class="input" inputmode="decimal" data-rd="price" data-i="' + i + '" value="' + esc(x.price) + '"></label></div>' +
        (x.err ? '<p class="err" role="alert">' + esc(x.err) + '</p>' : '') + '</div>';
    }).join('');
    var n = R0.items.filter(function (x) { return x.keep; }).length;
    return '<section class="card" id="reading"><h2>' + esc(R0.example ? 'The example menu, read' : 'Read from your menu') + '</h2><p class="small muted">Check each name and price against the menu. They are added without a plate cost or units sold - add those from a sales file or by hand.</p>' +
      (R0.dropped.length ? '<p class="small"><b>Left out by Stars’ checks:</b> ' + esc(R0.dropped.join(', ')) + '.</p>' : '') + rows +
      '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="readadd"' + (n ? '' : ' disabled') + '>' + esc('Add ' + plural(n, 'dish', 'dishes')) + '</button><button class="btn ghost" type="button" data-act="readclear">Discard the reading</button></div></section>';
  }
  function addReading() {
    var R0 = state.reading, t = stamp(), b = ensureBook(), bad = 0, added = 0, live = C.liveItems(b);
    R0.items.forEach(function (x) {
      x.err = '';
      if (!x.keep) return;
      var r = C.itemFrom({ name: x.name, cat: x.cat, price: x.price, cost: '', sold: '' }, t);
      if (r.errors.length) { x.err = r.errors[0].msg; bad++; return; }
      if (live.some(function (y) { return y.name.toLowerCase() === r.item.name.toLowerCase() && y.cat.toLowerCase() === r.item.cat.toLowerCase(); })) { x.err = 'Already on the menu.'; bad++; return; }
      b = C.putItem(b, newId(), r.item, t); added++;
    });
    if (bad) { if (added) commit(b, true); R0.items = R0.items.filter(function (x) { return x.err; }); keepPlace(draw); toast(plural(added, 'dish', 'dishes') + ' added - ' + plural(bad, 'to fix') + '.', 4200); return; }
    commit(b, true); state.reading = null; go('menu'); toast(plural(added, 'dish', 'dishes') + ' added. Now their plate costs and sales.');
  }
  function importHtml() {
    return '<div class="stack">' + demoRibbon() + guideHtml('import') +
      '<section class="card"><h1>Import</h1><p class="small muted">Bring many dishes at once. Worked out on this phone - a file is never sent or kept.</p></section>' +
      '<section class="card"><h2>A sales file (CSV)</h2><p class="small muted">An export from the till or a spreadsheet: a header row, then one row per dish (or per dish per day - they add up). You pick which column is the dish, the section, the price, the plate cost and the units sold.</p>' +
      '<div class="btns"><label class="photobtn">Open a CSV file<input type="file" accept=".csv,text/csv,text/plain" data-csvfile></label><button class="btn ghost" type="button" data-act="template">Download a template</button><button class="btn ghost" type="button" data-act="csvexample">Use the example file</button></div>' +
      '<label class="field" style="margin-top:12px"><span>Or paste it</span><textarea class="input tall mono" id="csvText" spellcheck="false" placeholder="item,category,price,plate cost,units sold">' + esc(state.csv ? state.csv.text : '') + '</textarea></label>' +
      '<button class="btn" type="button" data-act="csvread">Read it</button></section>' + csvHtml() +
      '<section class="card"><div class="row spread"><h2 style="margin:0">A menu, read by AI</h2><button class="btn ghost" type="button" data-act="readmenu">✨ Read the menu</button></div><p class="small muted" style="margin-top:8px">A photo of the menu (or its text) becomes a list of dishes and prices for you to confirm - never sent with your costs or sales.</p></section>' +
      readingHtml() + '</div>';
  }

  /* ---------------- the report ---------------- */

  function reportHtml() {
    var b = book(), secs = C.sections(b), all = C.analyse(C.liveItems(b));
    var today = new Date();
    var printed = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
    var parts = secs.map(function (s, si) {
      if (!s.g.n) return '<section class="card rsec"><h2>' + esc(s.name) + '</h2><p class="muted">' + esc(plural(s.items.length, 'dish', 'dishes') + ' waiting for a plate cost or units sold.') + '</p></section>';
      var grp = { key: s.key, name: s.name, g: s.g };
      var moves = numbered(s.g).map(function (r, i) { var o = C.suggestions(s.g, r).filter(function (z) { return z.kind !== 'note'; })[0]; return '<li><b>' + esc((i + 1) + '. ' + r.name) + '</b> ' + quadChip(r.quad) + ' ' + esc(o ? o.text : '') + '</li>'; }).join('');
      return '<section class="card rsec"><h2>' + esc(s.name) + '</h2><p class="lines">' + esc(linesText(s.g) + ' · food cost ' + P(s.g.foodPct) + ' · margin earned ' + M(s.g.tcm)) + '</p>' + sectionNote(s.g) +
        chartSvg(grp, 'rp' + si) + chartTable(grp, false) + '<h3 style="margin-top:12px">First moves</h3><ul class="sugg">' + moves + '</ul>' +
        (s.g.waiting.length ? '<p class="small muted">' + esc('Not rated yet: ' + s.items.filter(function (x) { return !C.rated(x); }).map(function (x) { return x.name; }).join(', ') + '.') + '</p>' : '') + '</section>';
    }).join('');
    return '<div class="stack report">' + demoRibbon() + guideHtml('report') +
      '<section class="card"><div class="row spread"><h1 style="margin:0">' + esc(placeName() + ' - menu report') + '</h1><div class="btns"><button class="btn" type="button" data-act="print">Print or save as PDF</button><button class="btn ghost" type="button" data-act="exportcsv">Export CSV</button></div></div>' +
      '<p class="muted" style="margin:6px 0 0">' + esc((b.period.label || 'Period not named') + ' · printed ' + printed) + '</p>' +
      (all.n ? '<p class="lines" style="margin-top:8px">' + esc('Sales ' + M(all.revenue) + ' · food cost ' + P(all.foodPct) + ' · margin earned ' + M(all.tcm) + ' · ' + C.fmtUnits(all.sold) + ' units') + '</p>' : '') +
      '<p class="small muted">Method: classic menu engineering. Within each section a dish is high margin at or above the average contribution margin weighted by units sold, and popular at or above 70% of an even share of the units sold. Stars: both high; plowhorses: popular, low margin; puzzles: high margin, not popular; dogs: neither.</p></section>' +
      parts + '</div>';
  }

  /* ---------------- more ---------------- */

  function moreHtml() {
    var b = book(), n = C.liveItems(b).length;
    return '<div class="stack">' + demoRibbon() + guideHtml('more') +
      '<section class="card"><h1>' + esc(placeName()) + '</h1><p class="muted">' + esc(plural(n, 'dish', 'dishes')) + '</p><p class="small" data-sync>' + syncLine() + '</p><button class="btn block" type="button" data-act="tab" data-tab="report">The report - print or save</button></section>' +
      '<section class="card"><h2>The period</h2><p class="small muted">What the units sold cover, for the report - “March”, “Four weeks to 30 March”.</p><label class="field"><span>Period</span><input class="input" id="period" maxlength="40" value="' + esc(b.period.label) + '"></label><p class="err" id="periodErr" role="alert" hidden></p><button class="btn ghost" type="button" data-act="saveperiod">Keep it</button></section>' +
      (state.demo ? '' : '<section class="card"><h2>Your restaurant’s name, for the report</h2><p class="small muted">Kept on this phone only, never synced.</p><label class="field"><span>Name on the report</span><input class="input" id="place" maxlength="80" autocomplete="organization" value="' + esc(state.device.place) + '"></label><p class="err" id="placeErr" role="alert" hidden></p><button class="btn ghost" type="button" data-act="saveplace">Keep it</button></section>') +
      '<section class="card"><h2>The method</h2><ul class="ticks"><li>Contribution margin = menu price − plate cost, in whole cents.</li><li>Within each section, the margin line is the average margin weighted by units sold; a dish at or above it is high margin.</li><li>The popularity line is 70% of an even share: (1 ÷ n) × 0.7 of the section’s units. A dish at or above it is popular.</li><li>That is the classic menu-engineering method. Every comparison is exact - no rounding decides a quadrant.</li><li>A dish alone in its section is a star by definition; one with no sales is never popular; one whose plate costs more than its price is flagged.</li></ul></section>' +
      '<section class="card"><h2>What Stars keeps</h2><ul class="ticks"><li>Your dishes, prices, plate costs and sales stay on this phone; signed in, they are kept in your account to reach your other phone.</li><li>Reading a menu sends that menu’s photo or text and nothing else; it is read once and not kept.</li><li>A sales file is read in this tab and never sent or kept - only the rows you apply.</li></ul></section>' +
      (state.demo ? '<button class="btn ghost block" type="button" data-act="leavedemo">Leave the example</button>' :
        '<section class="card"><h2>This phone</h2><button class="btn ghost block" type="button" data-act="' + (signedIn() ? 'account' : 'signin') + '">' + (signedIn() ? 'Account' : 'Sign in to keep two phones in step') + '</button><button class="btn danger block" type="button" data-act="wipe" style="margin-top:10px">Remove everything from this phone</button></section>') +
      '</div>';
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    clearTimeout(toastTimer);
    $$('.toast').forEach(function (t) { t.remove(); });
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    var vb = document.getElementById('stc-verify-banner'), off = vb ? Math.max(0, vb.getBoundingClientRect().bottom) : 0;
    s.style.maxHeight = off ? 'calc(100vh - ' + Math.round((matchMedia('(min-width: 720px)').matches ? 2 : 1) * (off + 8)) + 'px)' : '';
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  /* ---------------- the account (shared shape with the lab) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }
  var FREE_LINE = 'Stars is free with no account, and everything stays on this phone. A free account keeps two phones in step and adds reading a menu with AI - it comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field" style="margin:10px 0"><span>Your email (for your account only)</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field" style="margin:10px 0"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); return syncIn(); }).then(function () { if (then) then(); else keepPlace(draw); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { return syncIn(); }).then(function () { if (then) then(); else keepPlace(draw); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var leftUsd = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(leftUsd) + '</span></div><p class="small muted" style="margin:6px 0 0">Reading a menu costs a few cents. Everything else is free and stays on this phone.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my menu from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your menu from the account? This phone keeps its copy.')) return;
          api('DELETE', 'api/sync').then(function () {
            state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'local';
            closeSheet(); toast('Removed from the account. This phone still has it.');
          }).catch(function (e) { showError(e); });
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
  function checkout(path, body) { body.returnTo = BASE; api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); }); }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Typing dishes in yourself, the sales file and everything else keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }


  /* ---------------- wiring: one listener per kind of event ---------------- */

  function showTip(el) { var t = $('#qtip'); if (t && el) t.textContent = el.getAttribute('data-tip'); }
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id'), v = el.getAttribute('data-v');
    switch (act) {
      case 'home': e.preventDefault(); go(book() ? 'menu' : 'start'); break;
      case 'tab': closeSheet(true); go(el.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'leavedemo': leaveDemo(); break;
      case 'tour': tourStep(Number(el.getAttribute('data-step'))); break;
      case 'tourdo': tourDo(Number(el.getAttribute('data-step'))); break;
      case 'tourdone': leaveDemo(); go('add'); break;
      case 'closesheet': closeSheet(); break;
      case 'signin': openAccount(); break;
      case 'account': openAccountSheet(); break;
      case 'aijoin': openAccount(WHY_AI, openReadMenu); break;
      case 'mergeok': state.mergeNote = null; keepPlace(draw); break;
      case 'resync': state.sync = { base: null, at: 0 }; push(null); break;
      case 'retrysync': syncIn(); break;
      case 'open': state.did = id; state.wi = null; go('dish'); break;
      case 'edit': state.draft = draftOf(id); go('edit'); break;
      case 'remove': (function () {
        var x = dish(id);
        if (!confirm('Remove “' + x.name + '”' + (state.demo ? ' from the example' : ' from this phone') + '?')) return;
        commit(C.removeItem(book(), id, stamp()), true); go('menu'); toast('Removed.');
      }()); break;
      case 'dot': showTip(el); break;
      case 'chartkey': state.chartKey = v; keepPlace(draw); break;
      case 'wiapply': (function () {
        var x = dish(state.did), p = C.parseMoney(state.wi.price, 'The price');
        if (!x || p.error || p.v < 1 || p.v > C.LIMITS.priceMax) { toast(p.error || 'The price should be $0.01 to $999.99.'); return; }
        var it = { name: x.name, cat: x.cat, price: p.v, cost: x.cost, sold: x.sold };
        commit(C.putItem(book(), x.id, it, stamp()), true); state.wi = null; keepPlace(draw); toast('Price changed to ' + M(p.v) + '.');
      }()); break;
      case 'save': saveDraft(); break;
      case 'canceledit': (function () { var d = state.draft; state.draft = null; if (d && !d.isNew) { state.did = d.id; go('dish'); } else go(book() ? 'menu' : 'start'); }()); break;
      case 'readmenu': openReadMenu(); break;
      case 'readmode': state.read.mode = v; drawRead(); break;
      case 'clearphotos': state.read.photos = {}; drawRead(); break;
      case 'readsend': readSend(el); break;
      case 'readexample': readExample(); break;
      case 'readdemo': closeSheet(true); startDemo(); tourStep(5); break;
      case 'readadd': addReading(); break;
      case 'readclear': state.reading = null; keepPlace(draw); break;
      case 'csvread': readCsv($('#csvText').value); break;
      case 'csvexample': readCsv(D.CSV); break;
      case 'csvclear': state.csv = null; keepPlace(draw); break;
      case 'csvapply': (function () {
        var r = state.csv && state.csv.res;
        if (!r || r.error || !r.ok) return;
        commit(C.applyRows(ensureBook(), r, stamp(), newId), true);
        state.csv = null; go('menu'); toast(plural(r.adds, 'dish', 'dishes') + ' added, ' + plural(r.updates, 'updated') + '.');
      }()); break;
      case 'template': download('stars-template.csv', C.TEMPLATE, 'text/csv'); break;
      case 'exportcsv': download('stars-menu-report.csv', C.reportCsv(book()), 'text/csv'); break;
      case 'print': window.print(); break;
      case 'saveperiod': (function () {
        var s = $('#period').value.trim(), why = C.periodProblem(s), err = $('#periodErr');
        err.hidden = !why; err.textContent = why;
        if (why) return;
        commit(C.setPeriod(ensureBook(), s, stamp()), true); toast(s ? 'Kept.' : 'Cleared.');
      }()); break;
      case 'saveplace': (function () {
        var s = $('#place').value.trim(), why = s ? C.refuse(s, 80) : '', err = $('#placeErr');
        err.hidden = !why; err.textContent = why;
        if (why) return;
        state.device.place = s; saveDevice(); toast(s ? 'Kept on this phone.' : 'Cleared.');
      }()); break;
      case 'wipe':
        if (!confirm('Remove the whole menu from this phone?')) return;
        real.clearAll().then(function () { state.book = null; state.sync = RS.cleanSync({}); state.device = RS.cleanDevice({}); go('start'); toast('Removed from this phone.'); });
        break;
      default: break;
    }
  });
  document.addEventListener('mouseover', function (e) { var g = e.target.closest && e.target.closest('.qchart .dot'); if (g) showTip(g); });
  document.addEventListener('focusin', function (e) { var g = e.target.closest && e.target.closest('.qchart .dot'); if (g) showTip(g); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
    var g = e.target.closest && e.target.closest('.qchart .dot');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showTip(g); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.hasAttribute('data-map') && state.csv) {
      state.csv.map[t.getAttribute('data-map')] = Number(t.value);
      state.csv.res = C.csvRows(state.csv.plan, state.csv.map, book() || C.newBook(0));
      keepPlace(draw); return;
    }
    if (t.getAttribute('data-rd') === 'keep' && state.reading) { state.reading.items[Number(t.getAttribute('data-i'))].keep = t.checked; keepPlace(draw); return; }
    if (t.hasAttribute('data-menuphoto')) {
      var file = t.files && t.files[0];
      t.value = '';
      if (!file) return;
      shrink(file, C.LIMITS.aiImageSide, Math.floor(C.LIMITS.aiImageBytes * 4 / 3)).then(function (p2) {
        var r = state.read, slot = r.photos[1] ? 2 : 1;
        r.photos[slot] = p2.url; drawRead();
      }).catch(function (er) { toast(er.message || 'That photo could not be used.', 4200); });
      return;
    }
    if (t.hasAttribute('data-csvfile')) {
      var f = t.files && t.files[0];
      t.value = '';
      if (!f) return;
      if (f.size > C.LIMITS.csvBytes) { toast('That file is over 1 MB - split it.', 4200); return; }
      var rd = new FileReader();
      rd.addEventListener('load', function () { readCsv(String(rd.result || '')); });
      rd.addEventListener('error', function () { toast('That file could not be read.'); });
      rd.readAsText(f);
    }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.hasAttribute('data-f') && state.draft) {
      state.draft.fields[t.getAttribute('data-f')] = t.value;
      var p = $('#preview'); if (p) p.innerHTML = previewHtml();
      return;
    }
    if (t.hasAttribute('data-wi') && state.wi) {
      state.wi[t.getAttribute('data-wi')] = t.value;
      var x = dish(state.did), s = x && C.sectionOf(book(), x.id), r = s && C.find(s.g, x.id), o = $('#wiout');
      if (o && r) o.innerHTML = whatIfOut(s, r);
      return;
    }
    if (t.hasAttribute('data-rd') && state.reading && t.getAttribute('data-rd') !== 'keep') { state.reading.items[Number(t.getAttribute('data-i'))][t.getAttribute('data-rd')] = t.value; return; }
    if (t.getAttribute('data-act-input') === 'paste') {
      state.read.text = t.value;
      var why = t.value ? C.pasteProblem(t.value) : '', w = $('#pasteWhy'), send = $('[data-act="readsend"]');
      if (w) { w.hidden = !why; w.textContent = why; }
      if (send) send.disabled = !t.value.trim() || Boolean(why);
    }
  });
  window.addEventListener('popstate', function () { route(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (signedIn()) syncIn();
  });
  // Every minute while in front: re-ask the account (two phones in step).
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    if (signedIn()) syncIn();
  }, 60000);

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  drawTop();
  Promise.all([real.getBook(), real.getDevice(), real.getSync()]).then(function (r) {
    state.book = r[0]; state.device = r[1]; state.sync = r[2];
  }).catch(function () { /* fresh */ }).then(function () {
    var h = (location.hash || '').replace(/^#/, '');
    if (h && ['menu', 'chart', 'import', 'report', 'more', 'add'].indexOf(h) < 0) history.replaceState(null, '', BASE);
    route();
    return loadMe();
  }).then(function () { if (signedIn()) syncIn(); });
}());

