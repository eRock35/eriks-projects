/* Punch - the page. One file, no build step.
 *
 * EVERYTHING HAPPENS ON THIS PHONE. A job, its areas, the numbered pins on
 * each area's photo, every fix's trade, priority, due date, note and state,
 * the lists by trade and the client's sign-off are worked out by PunchCore
 * and kept through punch-store.js (IndexedDB, with a memory fallback).
 * Photos - each area's "before", each fix's "after" - and the client's
 * drawn signature are redrawn on this phone and kept on this phone ONLY:
 * they leave it only inside a closeout the person prints or saves. The
 * made-up example is never kept, sent or synced.
 *
 * The requests this page makes: sign-in, and the account's copy of the
 * punch lists' TEXT (signed in, to keep two phones on one job in step;
 * merged pin by pin by PunchCore.merge when both changed).
 *
 * Every string a person typed or the server sent is escaped before it is
 * drawn, and no handler is written into markup: clicks, changes, input and
 * the signing pad's pointer events are routed by data-* attributes and
 * addEventListener (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.PunchCore;
  var D = window.PunchDemo;
  var RS = window.PunchStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var REDUCED = (function () { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return { matches: false }; } }());

  var real = RS.create(RS.idb('punch'));

  var state = {
    me: null, view: 'start', book: null, demo: false, demoBook: null, device: RS.cleanDevice({}), sync: RS.cleanSync({}), syncState: 'local', syncErr: '',
    tour: 0, job: null, area: null, item: null, placing: null, which: 'open', mergeNote: null, demoClock: 0, demoSign: null, demoAfter: {},
    pics: {}, pending: {}, printWhat: 'closeout', pad: { strokes: [] }, form: null, newArea: null, lastTrade: '',
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
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function showError(err, where) {
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) { where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; reveal(where); }
    else toast(msg, 4200);
  }
  function reveal(el) { try { el.scrollIntoView({ block: 'center', behavior: REDUCED.matches ? 'auto' : 'smooth' }); } catch (e) { /* old browsers */ } }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }

  /* ---------------- the clock and ids (the page's, never the core's) ---------------- */

  function stamp() { if (state.demo) { state.demoClock += 1000; return D.T + state.demoClock; } return Date.now(); }
  function today() { if (state.demo) return D.TODAY; var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function rid(n) { var s = '', abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; try { var a = new Uint8Array(n); crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += abc[a[i] % 36]; } catch (e) { for (var j = 0; j < n; j++) s += abc[Math.floor(Math.random() * 36)]; } return s; }
  function newId(p) { return p + rid(9); }

  /* ---------------- the book: this phone's, and the example ---------------- */

  function book() { return state.demo ? state.demoBook : state.book; }
  function job() { var b = book(), j = b && state.job && b.jobs[state.job]; return j && !j.del ? j : null; }
  function area() { var b = book(), a = b && state.area && b.areas[state.area]; return a && !a.del && a.job === state.job ? a : null; }
  function item(id) { var b = book(), x = b && b.items[id || state.item]; if (!x || x.del) return null; var y = C.clone(x); y.id = id || state.item; return y; }
  function saveLocal() { real.putBook(state.book).catch(function () { /* still in this tab */ }); }
  function saveDevice() { if (!state.demo) real.putDevice(state.device).catch(function () { /* fine */ }); }
  function saveSync() { real.putSync(state.sync).catch(function () { /* fine */ }); }
  /** Keep a changed book: the example in memory only; a real one on this
   *  phone and, signed in, in the account. */
  function commit(next, quiet) {
    if (state.demo) state.demoBook = next;
    else { state.book = next; saveLocal(); pushSoon(); }
    if (!quiet) keepPlace(draw);
  }
  function ensureBook() { if (!state.demo && !state.book) state.book = C.newBook(stamp()); return book(); }

  /* ---------------- pictures: on this phone only ---------------- */

  /** A picture by its ref, if this phone has it (or the example draws it). */
  function pic(ref) {
    if (state.demo) {
      if (ref.indexOf('photo:') === 0) return D.photo(ref.slice(6));
      if (ref.indexOf('after:') === 0) return state.demoAfter[ref] || D.after(ref.slice(6));
      return ref.indexOf('sign:') === 0 ? state.demoSign : null;
    }
    if (state.pics[ref]) return state.pics[ref];
    if (!state.pending[ref]) {
      state.pending[ref] = true;
      real.getPic(ref).then(function (url) { if (url) { state.pics[ref] = url; keepPlace(draw); } });
    }
    return null;
  }
  function keepPic(ref, url) {
    if (state.demo) { if (ref.indexOf('after:') === 0) state.demoAfter[ref] = url; else if (ref.indexOf('sign:') === 0) state.demoSign = url; return Promise.resolve(); }
    return real.putPic(ref, url).then(function () { state.pics[ref] = url; state.pending[ref] = true; });
  }
  function dropPic(ref) {
    if (state.demo) { if (ref.indexOf('sign:') === 0) state.demoSign = null; else state.demoAfter[ref] = null; return Promise.resolve(); }
    delete state.pics[ref];
    return real.delPic(ref).catch(function () { /* gone */ });
  }
  /** A photo redrawn through a canvas at `side` px as a JPEG - location,
   *  camera and every other detail the file carried are left behind. */
  function shrink(file, side) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.addEventListener('load', function () {
        try {
          var k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          var g = cv.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
          var q = 0.82, out = cv.toDataURL('image/jpeg', q);
          while (out.length > RS.PHOTO_MAX && q > 0.35) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
          URL.revokeObjectURL(url);
          if (out.length > RS.PHOTO_MAX) { reject(new Error('That photo is too big to keep - try another.')); return; }
          resolve({ url: out, ar: Math.round(w / h * 1000) });
        } catch (e) { reject(e); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That file could not be read as a photo.')); });
      img.src = url;
    });
  }

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
    if (!state.book) return Promise.resolve();
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
    if (state.view === 'start') go('jobs'); else keepPlace(draw);
  }
  /** The account's copy came back different: merge it into this phone's -
   *  pin by pin, each pin by its parts - keep the result here, and save it
   *  against the account's version. */
  function mergeIn(acc, at) {
    var local = state.book;
    if (!local) { adopt(acc, at); return null; }
    var m = C.merge(local, acc, state.sync.at && state.sync.base ? state.sync.base : 0);
    var merged = m.book;
    var pulled = !C.same(merged, local);
    state.book = merged; saveLocal();
    if (pulled || m.notes.length) {
      state.mergeNote = { notes: m.notes };
      if (!sheetOpen()) keepPlace(draw);
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
    if (!signedIn()) return '<span class="sync small muted">On this phone only · <button class="link-btn" type="button" data-act="signin">sign in to keep two phones on one job</button></span>';
    if (state.me && !state.me.sync) return '<span class="sync small muted">Keeping it in the account is unavailable right now - it is on this phone.</span>';
    if (state.syncState === 'syncing') return '<span class="sync small muted">Saving to your account…</span>';
    if (state.syncState === 'removed') return '<span class="sync small warnline">Removed from your account on another phone - kept here. <button class="link-btn" type="button" data-act="resync">Keep it in the account again</button></span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t reach your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small okline">✓ In step with your account (text only - photos stay on each phone)</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }
  function mergeNoteHtml() {
    var m = state.mergeNote;
    if (!m || state.demo) return '';
    var lines = ['Changes from your other phone are in.'].concat(m.notes.slice(0, 5));
    return '<div class="merged" role="status"><b>Merged with your other phone</b> <button class="link-btn" type="button" data-act="mergeok">OK</button><ul>' + lines.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>';
  }

  /* ---------------- navigation ---------------- */

  var VIEWS = ['start', 'jobs', 'job', 'area', 'item', 'trades', 'closeout', 'print', 'more'];
  function go(view, after) {
    clearTimeout(toastTimer); $$('.toast').forEach(function (t) { t.remove(); });
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
    if (after) after();
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var v = VIEWS.indexOf(h) >= 0 ? h : 'start';
    var b = book();
    if (v !== 'area') state.placing = null;
    if (v === 'item' && !(item() && area())) v = 'area';
    if (v === 'area' && !area()) v = 'job';
    if (['job', 'trades', 'closeout', 'print'].indexOf(v) >= 0 && !job()) v = 'jobs';
    if (['jobs', 'more'].indexOf(v) >= 0 && !b) v = 'start';
    if (v === 'start' && b && !state.demo && h === '') v = C.jobs(b).length ? 'jobs' : 'start';
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
    var v = state.view;
    tb.hidden = v === 'start' || v === 'print' || ((v === 'jobs' || v === 'more') && !job());
    var tab = v === 'area' || v === 'item' ? 'job' : v;
    $$('#tabbar [data-tab]').forEach(function (x) { if (x.getAttribute('data-tab') === tab) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    var html;
    if (v === 'jobs') html = jobsHtml();
    else if (v === 'job') html = jobHtml();
    else if (v === 'area') html = areaHtml();
    else if (v === 'item') html = itemHtml();
    else if (v === 'trades') html = tradesHtml();
    else if (v === 'closeout') html = closeoutHtml();
    else if (v === 'print') html = printHtml();
    else if (v === 'more') html = moreHtml();
    else html = startHtml();
    main.innerHTML = html;
    document.body.classList.toggle('in-demo', state.demo);
    document.body.classList.toggle('placing', Boolean(state.placing));
    if (v === 'closeout') initPad();
    drawSync();
  }

  /* ---------------- the example and its tour ---------------- */

  var TOUR = [
    { view: 'job', title: 'The job, room by room', body: 'A made-up kitchen and bath refresh: twelve fixes across three rooms, each room with its photo and numbered pins. Seven are open, three fixed and waiting to be checked, two verified - and #2, the sagging cabinet door, was due yesterday.', btn: 'Open the kitchen', next: 'Next: pin a fix' },
    { view: 'area', title: 'A pin for every fix', body: 'Tap Drop a pin, then tap the photo where the fix is, and give it a trade, a priority, a due date and a few words. Numbers never repeat on a job, so #7 means the same pin on every list and on both phones.', btn: 'Drop a pin by the window', next: 'Next: before and after' },
    { view: 'item', title: 'Open, fixed, verified', body: 'The electrician fixed #3 this morning and took an after photo - it sits beside the before. On the walk-through you check it and tap Verify.', btn: 'Verify #3', next: 'Next: a list for each sub' },
    { view: 'trades', title: 'A list for each sub', body: 'Every open fix grouped by trade, highest priority first, with the room and the due date. Copy or share the tile list as text, or print it for the sub’s clipboard.', btn: 'Copy the tile list', next: 'Next: the client signs' },
    { view: 'closeout', title: 'The client signs on the phone', body: 'They sign with a finger and type their name; the date and what was open, fixed and verified are kept with it. The signature stays on this phone - it leaves only in the closeout you print.', btn: 'Sign as the client', next: 'Next: the closeout' },
    { view: 'print', title: 'The closeout', body: 'Every room with its pins, each fix’s before beside its after, and the signature. Print it, or save it as a PDF to send.', btn: 'Print the closeout', next: 'Start my own job' },
  ];
  function startDemo() {
    state.demo = true; state.demoBook = D.book(); state.demoClock = 0; state.tour = 1; state.mergeNote = null; state.demoSign = null; state.demoAfter = {};
    state.job = D.JOB; state.area = null; state.item = null; state.placing = null; state.which = 'open'; state.pad = { strokes: [] }; state.printWhat = 'closeout';
    go('job');
  }
  function leaveDemo() {
    state.demo = false; state.demoBook = null; state.tour = 0; state.demoSign = null; state.demoAfter = {}; state.placing = null; state.pad = { strokes: [] };
    state.job = null; state.area = null; state.item = null;
    if (!state.device.tour) { state.device.tour = true; saveDevice(); }
    var js = state.book ? C.jobs(state.book) : [];
    if (js.length === 1) state.job = js[0].id;
    go(js.length ? 'jobs' : 'start');
  }
  function tourStep(n) {
    if (n > TOUR.length) { leaveDemo(); openNewJob(); return; }
    state.tour = n;
    if (n === 2) state.area = D.KITCHEN;
    if (n === 3) { state.area = D.KITCHEN; state.item = D.OUTLET; }
    if (n === 6) state.printWhat = 'closeout';
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
    if (n === 1) { state.area = D.KITCHEN; state.tour = 2; go('area'); }
    if (n === 2) {
      var pid = 'pdemo' + ('0000' + (state.demoClock + 13)).slice(-5);
      commit(C.addItem(book(), pid, { area: D.KITCHEN, x: 640, y: 300, trade: 'Paint', pri: 'normal', due: '2026-11-25', note: 'Caulk the gap along the window trim' }, stamp()), true);
      state.item = pid; state.tour = 2; go('item'); say('Pin #' + item(pid).n + ' added by the window.');
    }
    if (n === 3) { state.item = D.OUTLET; setStateOf(D.OUTLET, 'verified'); }
    if (n === 4) { state.which = 'open'; copy(C.tradeText(book(), D.JOB, 'Tile', today(), 'open'), 'The tile list is copied - paste it to the sub.'); }
    if (n === 5) { state.pad = { strokes: D.SIGN.map(function (s) { return s.slice(); }) }; keepPlace(draw); var nm = $('#signer'); if (nm) nm.value = D.CLIENT; doSign(); }
    if (n === 6) window.print();
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var has = Boolean(state.book && C.jobs(state.book).length);
    return '<div class="stack">' +
      '<section class="hero"><div><p class="kicker">📌 For contractors, remodelers, builders and handymen</p><h1>Walk the job, pin every fix on a photo, close it out with a before-and-after the client signs.</h1>' +
      '<p>Photograph each room and drop a numbered pin on every fix - its trade, priority, due date and a few words. Move each one from open to fixed to verified with the after photo beside the before, hand every sub their own list, and let the client sign on your phone.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the example</button>' +
      (has ? '<button class="btn big ghost" type="button" data-act="tab" data-tab="jobs">My jobs</button>' : '<button class="btn big ghost" type="button" data-act="newjob">Start a job</button>') + '</div>' +
      '<p class="caps">Free · no sign-in · works offline · photos never leave the phone</p></div>' +
      '<div class="hero-art" aria-hidden="true"><div class="heroboard"><span class="hp s-open" style="left:22%;top:30%">1</span><span class="hp s-fixed" style="left:62%;top:48%">2</span><span class="hp s-verified" style="left:40%;top:72%">3</span></div></div></section>' +
      '<section class="card"><h2>How it works</h2><div class="how4">' +
      '<div><h3>Photo, then pins</h3><p>One photo per room or area. Tap where the fix is: a numbered pin with its trade, priority, due date and note.</p></div>' +
      '<div><h3>Open, fixed, verified</h3><p>The sub fixes it and you snap the after; on the walk you verify it. Before and after sit side by side.</p></div>' +
      '<div><h3>A list for each sub</h3><p>Every open fix by trade, highest priority first - copy, share or print it.</p></div>' +
      '<div><h3>Signed and closed out</h3><p>The client signs on the phone; the closeout prints with every pin, every pair and the signature.</p></div>' +
      '</div></section>' +
      '<section class="card"><ul class="ticks"><li>No account needed - everything works signed out, offline, on this phone.</li><li>Photos and signatures stay on the phone that took them, with their location and camera details stripped. They leave only in a closeout you choose to print or save.</li><li>Signed in, two phones on one job stay in step - merged pin by pin, so nobody’s fix is lost.</li></ul></section>' +
      '<p class="foot">Punch is a trial in the Challenge Lab.</p></div>';
  }

  /* ---------------- shared pieces ---------------- */

  function stateChip(s) { return '<span class="st s-' + esc(s) + '">' + esc(C.STATE[s].label) + '</span>'; }
  function priChip(p) { return p === 'normal' ? '' : '<span class="pri p-' + esc(p) + '">' + esc(C.PRI[p]) + '</span>'; }
  function dueChip(it) {
    if (!it.due) return '';
    return C.overdue(it, today()) ? '<span class="flag">Overdue · ' + esc(C.shortDay(it.due)) + '</span>' : '<span class="tag">Due ' + esc(C.shortDay(it.due)) + '</span>';
  }
  function countsHtml(c) {
    return '<div class="counts" aria-label="How far the fixes have got">' + C.STATES.map(function (s) { return '<span class="st s-' + esc(s) + '">' + esc(C.STATE[s].label + ' · ' + c[s]) + '</span>'; }).join('') + '</div>';
  }
  function bar(c) {
    if (!c.total) return '';
    var w = function (n) { return Math.round(n / c.total * 1000) / 10; };
    return '<div class="pbar" role="img" aria-label="' + esc(c.verified + ' verified, ' + c.fixed + ' fixed, ' + c.open + ' open of ' + c.total) + '"><span class="b-verified" style="width:' + w(c.verified) + '%"></span><span class="b-fixed" style="width:' + w(c.fixed) + '%"></span></div>';
  }
  function pinLabel(it) { return 'Pin ' + it.n + ': ' + it.trade + ' - ' + it.note + ' (' + C.STATE[it.state].label.toLowerCase() + ')'; }
  /** An area's photo with its pins. `live`: pins are buttons and the photo
   *  takes a tap when a pin is being placed; otherwise a picture. */
  function boardHtml(a, aid, opts) {
    opts = opts || {};
    var url = pic('photo:' + aid), its = C.itemsOf(book(), a.job, aid);
    var ratio = 'aspect-ratio:' + a.ar + ' / 1000';
    var pins = its.map(function (it) {
      // The dot stays whole at the photo's edge: its centre is kept 15px in.
      var pos = 'left:clamp(15px, ' + (it.x / 10) + '%, calc(100% - 15px));top:clamp(15px, ' + (it.y / 10) + '%, calc(100% - 15px))';
      var mark = '<span class="pv">' + esc(it.n) + '</span>';
      if (opts.live) return '<button type="button" class="pin s-' + esc(it.state) + (it.id === state.item ? ' cur' : '') + '" style="' + pos + '" data-act="pin" data-id="' + esc(it.id) + '" aria-label="' + esc(pinLabel(it)) + '">' + mark + '</button>';
      return '<span class="pin s-' + esc(it.state) + (opts.only && opts.only !== it.id ? ' dim' : '') + '" style="' + pos + '" aria-hidden="true">' + mark + '</span>';
    }).join('');
    var img = url ? '<img class="bimg" src="' + esc(url) + '" alt="' + esc('Photo of ' + a.name + ' with ' + plural(its.length, 'pin')) + '">' :
      '<div class="nophoto"><span>' + esc(opts.live ? 'No photo of this area on this phone yet - pins still go where you tap.' : 'Photo on the phone that took it') + '</span></div>';
    return '<div class="board' + (opts.live ? ' live' : '') + (opts.mini ? ' mini' : '') + '" style="' + ratio + '"' + (opts.live ? ' data-act="board"' : '') + '>' + img + pins + '</div>';
  }
  /** The "before" of one pin: the area photo, close up around it. */
  function beforeHtml(it, a) {
    var url = pic('photo:' + it.area);
    if (!url) return '<div class="crop empty"><span>No before photo on this phone</span></div>';
    var c = C.crop(it.x, it.y, a.ar, 2.5);
    return '<div class="crop"><img src="' + esc(url) + '" alt="' + esc('Before: ' + a.name + ' around pin ' + it.n) + '" style="left:' + c.left + '%;top:' + c.top + '%;width:' + c.width + '%;height:' + c.height + '%"><span class="cmark s-' + esc(it.state) + '" style="left:' + c.px + '%;top:' + c.py + '%" aria-hidden="true">' + esc(it.n) + '</span></div>';
  }
  function afterHtml(it, live) {
    var url = pic('after:' + it.id);
    if (url) return '<div class="crop after"><img class="fill" src="' + esc(url) + '" alt="' + esc('After: pin ' + it.n + ' fixed') + '"></div>';
    if (live && it.state !== 'open') return '<div class="crop empty"><label class="photobtn">Take the after photo<input type="file" accept="image/*" data-afterphoto="' + esc(it.id) + '"></label></div>';
    return '<div class="crop empty"><span>' + esc(it.state === 'open' ? 'Not fixed yet' : 'No after photo on this phone') + '</span></div>';
  }
  function pairHtml(it, a, live) {
    return '<div class="pair2"><figure><figcaption>Before</figcaption>' + beforeHtml(it, a) + '</figure><figure><figcaption>After' + (it.sd ? ' · ' + esc(C.shortDay(it.sd)) : '') + '</figcaption>' + afterHtml(it, live) + '</figure></div>';
  }
  function rowHtml(it, withArea) {
    return '<button type="button" class="irow" data-act="open" data-id="' + esc(it.id) + '" data-area="' + esc(it.area) + '"><span class="inum s-' + esc(it.state) + '">' + esc(it.n) + '</span><span class="ibody"><span class="in">' + esc(it.note) + '</span>' +
      '<span class="ir">' + esc(it.trade) + (withArea ? ' · ' + esc(C.areaName(book(), it.area)) : '') + ' ' + stateChip(it.state) + priChip(it.pri) + dueChip(it) + '</span></span></button>';
  }
  function jobHead() {
    var j = job();
    return '<p class="crumb"><button class="link-btn" type="button" data-act="tab" data-tab="jobs">Jobs</button> / <b>' + esc(j.name) + '</b>' + (j.client ? ' <span class="muted">· ' + esc(j.client) + '</span>' : '') + '</p>';
  }

  /* ---------------- jobs ---------------- */

  function jobsHtml() {
    var b = book(), js = C.jobs(b);
    var cards = js.map(function (j) {
      var c = C.counts(C.itemsOf(b, j.id)), s = C.signOf(b, j.id);
      return '<button type="button" class="jrow" data-act="openjob" data-id="' + esc(j.id) + '"><span class="jn">' + esc(j.name) + '</span>' + (j.client ? '<span class="muted small">' + esc(j.client) + '</span>' : '') +
        '<span class="jr">' + esc(plural(C.areasOf(b, j.id).length, 'area') + ' · ' + plural(c.total, 'fix', 'fixes')) + (s ? ' <span class="st s-verified">Signed ' + esc(C.shortDay(s.date)) + '</span>' : '') + '</span>' + bar(c) + '</button>';
    }).join('');
    return '<div class="stack">' + demoRibbon() + mergeNoteHtml() +
      '<section class="card"><div class="row spread"><h1 style="margin:0">Jobs</h1><button class="btn" type="button" data-act="newjob">New job</button></div><p class="small" data-sync>' + syncLine() + '</p></section>' +
      (cards ? '<div class="jlist">' + cards + '</div>' : '<section class="card"><p class="muted">No jobs yet. Start one - a name is enough.</p></section>') + '</div>';
  }
  function openNewJob(jid) {
    var j = jid ? book().jobs[jid] : null;
    sheet('<h2>' + (j ? 'Rename the job' : 'A new job') + '</h2>' +
      '<label class="field"><span>Job name</span><input class="input" id="jName" maxlength="60" placeholder="Kitchen remodel" value="' + esc(j ? j.name : '') + '"></label>' +
      '<label class="field"><span>Client (optional, for the closeout)</span><input class="input" id="jClient" maxlength="60" autocomplete="off" value="' + esc(j ? j.client : '') + '"></label>' +
      '<p class="small muted">No address or phone number - Punch keeps plain words only.</p><p class="err" id="jErr" role="alert" hidden></p>' +
      '<button class="btn block" type="button" data-act="savejob" data-id="' + esc(jid || '') + '">' + (j ? 'Keep it' : 'Start the job') + '</button>');
  }
  function saveJob(jid) {
    var name = $('#jName').value.trim(), client = $('#jClient').value.trim(), err = $('#jErr');
    var why = C.jobNameProblem(name) || C.clientProblem(client);
    err.hidden = !why; err.textContent = why;
    if (why) return;
    var id = jid || newId('j');
    commit(C.putJob(ensureBook(), id, name, client, stamp()), true);
    state.job = id; closeSheet(true);
    if (jid) keepPlace(draw); else { go('job'); toast('Now add the first room or area.'); }
  }

  /* ---------------- one job: its areas ---------------- */

  function jobHtml() {
    var b = book(), j = job(), as = C.areasOf(b, state.job), all = C.itemsOf(b, state.job), c = C.counts(all);
    var late = all.filter(function (it) { return C.overdue(it, today()); });
    var cards = as.map(function (a) {
      var ac = C.counts(C.itemsOf(b, state.job, a.id));
      return '<button type="button" class="acard" data-act="openarea" data-id="' + esc(a.id) + '">' + boardHtml(a, a.id, { mini: true }) +
        '<span class="an">' + esc(a.name) + '</span><span class="small muted">' + esc(plural(ac.total, 'fix', 'fixes') + (ac.open ? ' · ' + ac.open + ' open' : '')) + '</span></button>';
    }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('job') + mergeNoteHtml() +
      '<section class="card">' + jobHead() + '<div class="row spread"><h1 style="margin:0">' + esc(j.name) + '</h1><div class="btns"><button class="btn" type="button" data-act="newarea">Add an area</button><button class="btn ghost small" type="button" data-act="editjob">Rename</button></div></div>' +
      (c.total ? countsHtml(c) + bar(c) : '<p class="muted">No fixes yet. Add a room or area, photograph it, and drop a pin on each fix.</p>') +
      (late.length ? '<p class="warnline">' + esc(plural(late.length, 'fix', 'fixes') + ' past due: ' + late.map(function (it) { return '#' + it.n; }).join(', ')) + '</p>' : '') +
      '<p class="small" data-sync>' + syncLine() + '</p></section>' +
      (cards ? '<div class="agrid">' + cards + '</div>' : '') +
      (all.length ? '<section class="card"><h2>Every fix on this job</h2><div class="ilist">' + all.map(function (it) { return rowHtml(it, true); }).join('') + '</div></section>' : '') + '</div>';
  }
  function openNewArea(aid) {
    var a = aid ? book().areas[aid] : null;
    state.newArea = { photo: null };
    sheet('<h2>' + (a ? 'Rename the area' : 'A room or area') + '</h2>' +
      '<label class="field"><span>Name</span><input class="input" id="aName" maxlength="40" placeholder="Kitchen" value="' + esc(a ? a.name : '') + '" list="areaNames"><datalist id="areaNames">' + ['Kitchen', 'Main bath', 'Hall bath', 'Living room', 'Primary bedroom', 'Bedroom 2', 'Hallway', 'Laundry', 'Garage', 'Exterior', 'Front porch', 'Basement'].map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist></label>' +
      (a ? '' : '<div class="field"><span>Its photo</span><label class="photobtn">Take or choose a photo<input type="file" accept="image/*" data-newareaphoto></label><span class="hint">Kept on this phone only, with its location and camera details stripped. You can add it later.</span><div id="naPrev"></div></div>') +
      '<p class="err" id="aErr" role="alert" hidden></p><button class="btn block" type="button" data-act="savearea" data-id="' + esc(aid || '') + '">' + (a ? 'Keep it' : 'Add the area') + '</button>');
  }
  function saveArea(aid) {
    var name = $('#aName').value.trim(), err = $('#aErr'), why = C.areaNameProblem(name);
    err.hidden = !why; err.textContent = why;
    if (why) return;
    var id = aid || newId('a'), old = aid ? book().areas[aid] : null, ph = !aid && state.newArea && state.newArea.photo;
    var done = function () {
      commit(C.putArea(book(), id, state.job, name, ph ? ph.ar : (old ? old.ar : 1333), stamp()), true);
      state.area = id; state.newArea = null; closeSheet(true);
      if (aid) keepPlace(draw); else go('area');
    };
    if (ph) keepPic('photo:' + id, ph.url).then(done, function (e) { err.hidden = false; err.textContent = e.message; });
    else done();
  }

  /* ---------------- one area: the photo and its pins ---------------- */

  function areaHtml() {
    var a = area(), its = C.itemsOf(book(), state.job, state.area), has = Boolean(pic('photo:' + state.area));
    var tools = state.placing ?
      '<div class="placebar" role="status"><b>' + esc(state.placing === 'move' ? 'Tap the photo where pin #' + item().n + ' belongs' : 'Tap the photo where the fix is') + '</b><button class="btn ghost small" type="button" data-act="cancelplace">Cancel</button></div>' :
      '<div class="btns"><button class="btn" type="button" data-act="place">📌 Drop a pin</button><label class="photobtn">' + (has ? 'Replace the photo' : 'Add a photo') + '<input type="file" accept="image/*" data-areaphoto></label></div>';
    return '<div class="stack">' + demoRibbon() + guideHtml('area') + mergeNoteHtml() +
      '<section class="card">' + jobHead() + '<div class="row spread"><h1 style="margin:0">' + esc(a.name) + '</h1><div class="btns"><button class="btn ghost small" type="button" data-act="editarea">Rename</button><button class="btn danger small" type="button" data-act="removearea">Remove</button></div></div>' +
      (its.length ? countsHtml(C.counts(its)) : '') + '</section>' +
      '<section class="card boardcard">' + tools + boardHtml(a, state.area, { live: true }) + '<p class="small muted" style="margin-top:8px">Each pin is a fix: red is open, amber fixed, green verified - and every pin carries its number.</p></section>' +
      (its.length ? '<section class="card"><h2>Fixes here</h2><div class="ilist">' + its.map(function (it) { return rowHtml(it, false); }).join('') + '</div></section>' : '') + '</div>';
  }
  function boardPoint(e, el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) / r.width * 1000), y: Math.round((e.clientY - r.top) / r.height * 1000) };
  }
  function placeAt(p) {
    if (state.placing === 'move') {
      commit(C.moveItem(book(), state.item, p.x, p.y, stamp()), true);
      state.placing = null; go('item'); toast('Pin moved.'); return;
    }
    state.placing = null; keepPlace(draw);
    openPinForm(null, p);
  }

  /* ---------------- a pin: the form ---------------- */

  function formHtml(f) {
    return '<label class="field"><span>Trade</span><input class="input" id="fTrade" maxlength="30" list="tradeList" placeholder="Paint" value="' + esc(f.trade) + '"><datalist id="tradeList">' + C.TRADES.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist></label>' +
      '<div class="field"><span>Priority</span><div class="seg" role="group" aria-label="Priority">' + C.PRIS.map(function (p) { return '<button type="button" data-act="pri" data-v="' + esc(p) + '" aria-pressed="' + (f.pri === p) + '">' + esc(C.PRI[p]) + '</button>'; }).join('') + '</div></div>' +
      '<label class="field"><span>Due (optional)</span><input class="input" id="fDue" type="date" value="' + esc(f.due) + '"></label>' +
      '<label class="field"><span>What needs fixing</span><textarea class="input" id="fNote" maxlength="240" placeholder="Touch up the ceiling above the window">' + esc(f.note) + '</textarea></label>' +
      '<p class="err" id="fErr" role="alert" hidden></p>';
  }
  function readForm() {
    var f = { trade: $('#fTrade').value.trim(), pri: state.form.pri, due: $('#fDue').value, note: $('#fNote').value.trim() };
    var why = C.tradeProblem(f.trade) || C.noteProblem(f.note) || (f.due && !C.isDay(f.due) ? 'The due date is not a date.' : '');
    var err = $('#fErr'); err.hidden = !why; err.textContent = why;
    return why ? null : f;
  }
  function openPinForm(pid, p) {
    var it = pid ? item(pid) : null;
    state.form = { pid: pid, x: p ? p.x : 500, y: p ? p.y : 500, pri: it ? it.pri : 'normal' };
    var f = it ? { trade: it.trade, due: it.due, note: it.note, pri: it.pri } : { trade: state.lastTrade, due: '', note: '', pri: 'normal' };
    sheet('<h2>' + esc(it ? 'Pin #' + it.n : 'Pin #' + C.nextNumber(book(), state.job) + ' in ' + area().name) + '</h2>' + formHtml(f) +
      '<button class="btn block" type="button" data-act="savepin">' + (it ? 'Keep it' : 'Add the pin') + '</button>');
  }
  function savePin() {
    var f = readForm(), F = state.form;
    if (!f) return;
    state.lastTrade = f.trade;
    if (F.pid) { commit(C.editItem(book(), F.pid, f, stamp()), true); closeSheet(true); keepPlace(draw); toast('Kept.'); return; }
    var pid = newId('p'), b = C.addItem(book(), pid, { area: state.area, x: F.x, y: F.y, trade: f.trade, pri: f.pri, due: f.due, note: f.note }, stamp());
    commit(b, true); closeSheet(true); keepPlace(draw);
    toast('Pin #' + b.items[pid].n + ' added. Drop the next one, or open it to add its after photo later.');
  }

  /* ---------------- a pin: before, after, state ---------------- */

  function setStateOf(pid, s) {
    var it = item(pid);
    commit(C.setState(book(), pid, s, today(), stamp()), true);
    keepPlace(draw);
    say('Pin #' + it.n + ' is ' + C.STATE[s].label.toLowerCase() + '.');
  }
  function itemHtml() {
    var it = item(), a = area();
    var next = it.state === 'open' ? ['fixed'] : it.state === 'fixed' ? ['verified', 'open'] : ['open'];
    var acts = next.map(function (s) { return '<button class="btn' + (s === 'open' ? ' ghost' : '') + '" type="button" data-act="state" data-v="' + esc(s) + '">' + esc(s === 'open' ? 'Reopen' : C.STATE[s].verb) + '</button>'; }).join('');
    var steps = '<ol class="steps" aria-label="Where it has got">' + C.STATES.map(function (s) { var i = C.STATES.indexOf(s), cur = C.STATES.indexOf(it.state); return '<li class="' + (i < cur ? 'done' : i === cur ? 'now' : '') + '"' + (i === cur ? ' aria-current="step"' : '') + '>' + esc(C.STATE[s].label) + '</li>'; }).join('') + '</ol>';
    return '<div class="stack">' + demoRibbon() + guideHtml('item') + mergeNoteHtml() +
      '<section class="card">' + jobHead() + '<p class="small"><button class="link-btn" type="button" data-act="openarea" data-id="' + esc(state.area) + '">← ' + esc(a.name) + '</button></p>' +
      '<div class="row"><span class="inum big s-' + esc(it.state) + '">' + esc(it.n) + '</span><h1 style="margin:0" class="grow">' + esc(it.note) + '</h1></div>' +
      '<p class="ir">' + esc(it.trade) + ' ' + stateChip(it.state) + priChip(it.pri) + dueChip(it) + '</p>' + steps +
      '<p class="muted small">' + esc(C.STATE[it.state].what + (it.sd ? ' (' + C.fmtDay(it.sd) + ')' : '')) + '</p><div class="btns">' + acts + '</div></section>' +
      '<section class="card"><h2>Before and after</h2>' + pairHtml(it, a, true) +
      (pic('after:' + it.id) ? '<div class="btns" style="margin-top:10px"><label class="photobtn">Retake the after photo<input type="file" accept="image/*" data-afterphoto="' + esc(it.id) + '"></label><button class="btn ghost small" type="button" data-act="dropafter">Remove the after photo</button></div>' : '') +
      '<p class="small muted" style="margin-top:8px">Both photos stay on this phone.</p></section>' +
      '<section class="card"><div class="btns"><button class="btn ghost" type="button" data-act="editpin">Edit trade, priority, due, note</button><button class="btn ghost" type="button" data-act="movepin">Move the pin</button><button class="btn danger" type="button" data-act="removepin">Remove</button></div></section></div>';
  }

  /* ---------------- lists by trade ---------------- */

  var WHICH = { open: 'Still to do', fixed: 'Fixed - to check', all: 'Everything' };
  function tradesHtml() {
    var b = book(), groups = C.byTrade(b, state.job, state.which);
    var seg = '<div class="seg" role="group" aria-label="Which fixes">' + Object.keys(WHICH).map(function (k) { return '<button type="button" data-act="which" data-v="' + esc(k) + '" aria-pressed="' + (state.which === k) + '">' + esc(WHICH[k]) + '</button>'; }).join('') + '</div>';
    var cards = groups.map(function (g) {
      return '<section class="card"><div class="row spread"><h2 style="margin:0">' + esc(g.trade) + ' <span class="count">' + esc(g.items.length) + '</span></h2><div class="btns"><button class="btn small" type="button" data-act="sharetrade" data-v="' + esc(g.trade) + '">Share</button><button class="btn ghost small" type="button" data-act="copytrade" data-v="' + esc(g.trade) + '">Copy</button><button class="btn ghost small" type="button" data-act="printtrade" data-v="' + esc(g.trade) + '">Print</button></div></div>' +
        '<div class="ilist">' + g.items.map(function (it) { return rowHtml(it, true); }).join('') + '</div></section>';
    }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('trades') + mergeNoteHtml() +
      '<section class="card">' + jobHead() + '<h1>A list for each sub</h1><p class="small muted">Highest priority first, then the soonest due. Shared as plain text - no photos go with it.</p>' + seg + '</section>' +
      (cards || '<section class="card"><p class="muted">' + esc(state.which === 'open' ? 'Nothing open - every fix is done.' : 'Nothing here.') + '</p></section>') + '</div>';
  }

  /* ---------------- the closeout: the client signs ---------------- */

  function closeoutHtml() {
    var b = book(), j = job(), c = C.counts(C.itemsOf(b, state.job)), s = C.signOf(b, state.job), url = pic('sign:' + state.job);
    var signed = s ? '<section class="card"><h2>Signed</h2>' + (url ? '<img class="sigimg" src="' + esc(url) + '" alt="' + esc('Signature of ' + s.name) + '">' : '<p class="muted small">The signature is on the phone it was signed on.</p>') +
      '<p><b>' + esc(s.name) + '</b> · ' + esc(C.fmtDay(s.date)) + '</p><p class="small muted">' + esc('Signed with ' + s.verified + ' verified, ' + s.fixed + ' fixed and ' + s.open + ' open.') + '</p>' +
      (s.changed ? '<p class="warnline">' + esc(plural(s.changed, 'pin') + ' changed after it was signed.') + '</p>' : '') +
      '<div class="btns"><button class="btn" type="button" data-act="printclose">Print the closeout</button><button class="btn danger small" type="button" data-act="unsign">Clear the sign-off</button></div></section>' :
      '<section class="card"><h2>The client signs here</h2>' +
      (c.open ? '<p class="warnline">' + esc(plural(c.open, 'fix', 'fixes') + ' still open - they can sign anyway, and the closeout will say so.') + '</p>' : '') +
      '<div class="padwrap"><canvas id="pad" class="pad" aria-label="Signature pad: sign with a finger or the mouse"></canvas><span class="padline" aria-hidden="true">Sign above the line</span></div>' +
      '<div class="btns" style="margin:8px 0 12px"><button class="btn ghost small" type="button" data-act="clearpad">Clear</button></div>' +
      '<div class="formgrid"><label class="field"><span>Client’s name</span><input class="input" id="signer" maxlength="60" autocomplete="off" value="' + esc(j.client) + '"></label>' +
      '<label class="field"><span>Date</span><input class="input" id="signDate" type="date" value="' + esc(today()) + '"></label></div>' +
      '<p class="err" id="signErr" role="alert" hidden></p><button class="btn block" type="button" data-act="sign">Sign the closeout</button>' +
      '<p class="small muted" style="margin-top:8px">The signature is kept on this phone only. Its name and date sync with the job; the picture leaves only in the closeout you print or save.</p></section>';
    return '<div class="stack">' + demoRibbon() + guideHtml('closeout') + mergeNoteHtml() +
      '<section class="card">' + jobHead() + '<div class="row spread"><h1 style="margin:0">Closeout</h1><button class="btn ghost" type="button" data-act="printclose">Preview and print</button></div>' + countsHtml(c) + bar(c) + '</section>' + signed + '</div>';
  }
  /* The signing pad: strokes kept per mille of the pad, drawn by pointer
   * events (finger, pen or mouse), redrawn whenever the page redraws. */
  var padCtx = null, padDown = null;
  function sizePad() {
    var cv = $('#pad');
    if (!cv) { padCtx = null; return; }
    var r = cv.getBoundingClientRect(), dpr = Math.max(1, window.devicePixelRatio || 1);
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    padCtx = cv.getContext('2d');
    paint(padCtx, cv.width, cv.height, state.pad.strokes, false);
  }
  function initPad() {
    var cv = $('#pad');
    sizePad();
    if (!cv) return;
    cv.addEventListener('pointerdown', function (e) { e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (x) { /* fine */ } padDown = [padPt(e, cv)]; state.pad.strokes.push(padDown); });
    cv.addEventListener('pointermove', function (e) { if (!padDown) return; e.preventDefault(); padDown.push(padPt(e, cv)); paint(padCtx, cv.width, cv.height, state.pad.strokes, false); });
    var up = function () { padDown = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  }
  function padPt(e, cv) { var r = cv.getBoundingClientRect(); return [Math.round((e.clientX - r.left) / r.width * 1000), Math.round((e.clientY - r.top) / r.height * 1000)]; }
  function paint(g, w, h, strokes, white) {
    g.clearRect(0, 0, w, h);
    if (white) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    g.strokeStyle = '#10131a'; g.lineWidth = Math.max(2, w / 260); g.lineCap = 'round'; g.lineJoin = 'round';
    strokes.forEach(function (s) {
      g.beginPath();
      s.forEach(function (p, i) { var x = p[0] / 1000 * w, y = p[1] / 1000 * h; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      if (s.length === 1) g.lineTo(s[0][0] / 1000 * w + 0.5, s[0][1] / 1000 * h);
      g.stroke();
    });
  }
  function inked(strokes) { var n = 0; strokes.forEach(function (s) { n += s.length; }); return n >= 6; }
  function doSign() {
    var name = $('#signer').value.trim(), date = $('#signDate').value, err = $('#signErr');
    var why = C.signerProblem(name) || (!C.isDay(date) ? 'Pick the date.' : '') || (!inked(state.pad.strokes) ? 'Ask the client to sign in the box first.' : '');
    err.hidden = !why; err.textContent = why;
    if (why) return;
    var cv = document.createElement('canvas'); cv.width = 900; cv.height = 300;
    paint(cv.getContext('2d'), 900, 300, state.pad.strokes, true);
    var jid = state.job;
    keepPic('sign:' + jid, cv.toDataURL('image/png')).then(function () {
      commit(C.sign(book(), jid, name, date, stamp()), true); state.pad = { strokes: [] };
      keepPlace(draw); toast('Signed by ' + name + '.');
    }, function (e) { err.hidden = false; err.textContent = e.message; });
  }

  /* ---------------- print: the closeout, or one trade's list ---------------- */

  function printHtml() {
    var b = book(), j = job(), what = state.printWhat;
    var head = '<div class="btns noprint" style="margin-bottom:12px"><button class="btn" type="button" data-act="print">Print or save as PDF</button><button class="btn ghost" type="button" data-act="tab" data-tab="' + (what === 'closeout' ? 'closeout' : 'trades') + '">Back</button></div>';
    if (what !== 'closeout') {
      var g = C.byTrade(b, state.job, state.which).filter(function (x) { return x.trade === what; })[0];
      var rows = g ? g.items.map(function (it) { return '<tr><td class="box" aria-label="To tick">☐</td><td>' + esc('#' + it.n) + '</td><td>' + esc(it.areaName) + '</td><td class="wrapc">' + esc(it.note) + '</td><td>' + esc(C.PRI[it.pri]) + '</td><td>' + esc(it.due ? C.shortDay(it.due) : '') + '</td></tr>'; }).join('') : '';
      return '<div class="stack doc">' + demoRibbon() + head + '<section class="card"><h1>' + esc(j.name + ' - ' + what) + '</h1><p class="muted">' + esc(WHICH[state.which] + ' · printed ' + C.fmtDay(today())) + '</p>' +
        '<div class="tablebox" tabindex="0" role="region" aria-label="The list"><table class="grid"><thead><tr><th>Done</th><th>Pin</th><th>Area</th><th>Fix</th><th>Priority</th><th>Due</th></tr></thead><tbody>' + rows + '</tbody></table></div></section></div>';
    }
    var co = C.closeout(b, state.job), s = co.sign, url = pic('sign:' + state.job);
    var parts = co.areas.map(function (x) {
      var rows = x.items.map(function (it) { return '<tr><td>' + esc('#' + it.n) + '</td><td>' + esc(it.trade) + '</td><td class="wrapc">' + esc(it.note) + '</td><td>' + esc(C.STATE[it.state].label + (it.sd ? ' ' + C.shortDay(it.sd) : '')) + '</td><td>' + esc(it.due ? C.shortDay(it.due) : '') + '</td></tr>'; }).join('');
      return '<section class="card rsec"><h2>' + esc(x.area.name) + '</h2>' + boardHtml(x.area, x.area.id, {}) +
        (rows ? '<div class="tablebox" tabindex="0" role="region" aria-label="' + esc('Fixes in ' + x.area.name) + '"><table class="grid"><thead><tr><th>Pin</th><th>Trade</th><th>Fix</th><th>State</th><th>Due</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="muted">No fixes here.</p>') + '</section>';
    }).join('');
    var pairs = co.pairs.map(function (it) { var a = b.areas[it.area]; return '<div class="pairbox"><p class="pt"><b>' + esc('#' + it.n + ' ' + it.note) + '</b> <span class="muted">' + esc(a.name + ' · ' + it.trade + ' · ' + C.STATE[it.state].label) + '</span></p>' + pairHtml(it, a, false) + '</div>'; }).join('');
    return '<div class="stack doc report">' + demoRibbon() + guideHtml('print') + head +
      '<section class="card"><h1>' + esc('Closeout - ' + j.name) + '</h1><p class="muted">' + esc([j.client ? 'Client: ' + j.client : '', state.device.by && !state.demo ? 'Prepared by ' + state.device.by : '', 'Printed ' + C.fmtDay(today())].filter(Boolean).join(' · ')) + '</p>' +
      countsHtml(co.counts) + '</section>' + parts +
      (pairs ? '<section class="card"><h2>Before and after</h2><div class="pairs">' + pairs + '</div></section>' : '') +
      '<section class="card rsec"><h2>Sign-off</h2>' + (s ? (url ? '<img class="sigimg" src="' + esc(url) + '" alt="' + esc('Signature of ' + s.name) + '">' : '') + '<p><b>' + esc(s.name) + '</b> · ' + esc(C.fmtDay(s.date)) + '</p><p class="small">' + esc('Signed with ' + s.verified + ' verified, ' + s.fixed + ' fixed and ' + s.open + ' open.') + '</p>' + (s.changed ? '<p class="warnline">' + esc(plural(s.changed, 'pin') + ' changed after it was signed.') + '</p>' : '') : '<p class="muted">Not signed yet.</p><div class="sigline"></div><p class="small">Client signature and date</p>') + '</section></div>';
  }

  /* ---------------- more ---------------- */

  function moreHtml() {
    return '<div class="stack">' + demoRibbon() +
      (state.demo ? '' : '<section class="card"><h2>Your name or company, for the closeout</h2><p class="small muted">Printed as “Prepared by”. Kept on this phone only, never synced.</p><label class="field"><span>Prepared by</span><input class="input" id="by" maxlength="60" autocomplete="organization" value="' + esc(state.device.by) + '"></label><p class="err" id="byErr" role="alert" hidden></p><button class="btn ghost" type="button" data-act="saveby">Keep it</button></section>') +
      '<section class="card"><h2>What Punch keeps</h2><ul class="ticks"><li>Jobs, areas, pins and notes stay on this phone; signed in, their text is kept in your account so a second phone on the job stays in step.</li><li>Photos and the client’s signature never leave this phone. Each photo is redrawn here first, so its location and camera details are gone. They appear only in a closeout you print or save.</li><li>Two phones on one job are merged pin by pin: one phone marking #4 fixed while the other edits #4’s note keeps both, and a pin changed after the other phone removed it is kept.</li><li>No address, phone number or email is kept - Punch refuses them in any field.</li></ul></section>' +
      (state.demo ? '<button class="btn ghost block" type="button" data-act="leavedemo">Leave the example</button>' :
        '<section class="card"><h2>This phone</h2><p class="small" data-sync>' + syncLine() + '</p><button class="btn ghost block" type="button" data-act="' + (signedIn() ? 'account' : 'signin') + '">' + (signedIn() ? 'Account' : 'Sign in to keep two phones on one job') + '</button>' +
        (job() ? '<button class="btn danger block" type="button" data-act="removejob" style="margin-top:10px">Remove this job</button>' : '') +
        '<button class="btn danger block" type="button" data-act="wipe" style="margin-top:10px">Remove everything from this phone</button></section>') +
      '</div>';
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheetOpen() { return !$('#sheet').hidden; }
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
  var FREE_LINE = 'Punch is free with no account, and everything stays on this phone. A free account keeps two phones on one job in step - the text only; photos and signatures never leave the phone. One account works across every app on this site.';
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
    sheet('<h2>Account</h2><p class="small muted">' + esc(state.me.email) + '</p><p class="small" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button">Remove my jobs from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>', function (root) {
      $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
      $('#forget', root).addEventListener('click', function () {
        if (!confirm('Remove your jobs from the account? This phone keeps its copy.')) return;
        api('DELETE', 'api/sync').then(function () { state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'local'; closeSheet(); toast('Removed from the account. This phone still has them.'); }).catch(function (e) { showError(e); });
      });
      var pk = $('#pkEnrol', root);
      if (pk) pk.addEventListener('click', function () {
        var pw = prompt('Your password, to confirm it is you:');
        if (!pw) return;
        Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
      });
    });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  function tradeOf(el) { return el.getAttribute('data-v'); }
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id'), v = el.getAttribute('data-v');
    switch (act) {
      case 'home': e.preventDefault(); go(book() && C.jobs(book()).length ? (job() ? 'job' : 'jobs') : 'start'); break;
      case 'tab': closeSheet(true); go(el.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'leavedemo': leaveDemo(); break;
      case 'tour': tourStep(Number(el.getAttribute('data-step'))); break;
      case 'tourdo': tourDo(Number(el.getAttribute('data-step'))); break;
      case 'tourdone': leaveDemo(); openNewJob(); break;
      case 'closesheet': closeSheet(); break;
      case 'signin': openAccount(); break;
      case 'account': openAccountSheet(); break;
      case 'mergeok': state.mergeNote = null; keepPlace(draw); break;
      case 'resync': state.sync = { base: null, at: 0 }; push(null); break;
      case 'retrysync': syncIn(); break;
      case 'newjob': openNewJob(); break;
      case 'editjob': openNewJob(state.job); break;
      case 'savejob': saveJob(id); break;
      case 'openjob': state.job = id; state.area = null; state.item = null; go('job'); break;
      case 'newarea': openNewArea(); break;
      case 'editarea': openNewArea(state.area); break;
      case 'savearea': saveArea(id); break;
      case 'openarea': state.area = id; state.item = null; go('area'); break;
      case 'removearea': (function () {
        var a = area(), n = C.itemsOf(book(), state.job, state.area).length;
        if (!confirm('Remove “' + a.name + '”' + (n ? ' and its ' + plural(n, 'pin') : '') + (state.demo ? ' from the example?' : '?'))) return;
        var aid = state.area;
        commit(C.removeArea(book(), aid, stamp()), true); dropPic('photo:' + aid); state.area = null; go('job'); toast('Removed.');
      }()); break;
      case 'removejob': (function () {
        var j = job();
        if (!confirm('Remove the job “' + j.name + '”, its areas and every pin?')) return;
        var jid = state.job;
        C.areasOf(book(), jid).forEach(function (a) { dropPic('photo:' + a.id); });
        C.itemsOf(book(), jid).forEach(function (it) { dropPic('after:' + it.id); });
        dropPic('sign:' + jid);
        commit(C.removeJob(book(), jid, stamp()), true); state.job = null; go('jobs'); toast('Removed.');
      }()); break;
      case 'place': state.placing = 'new'; keepPlace(draw); say('Tap the photo where the fix is.'); break;
      case 'cancelplace': state.placing = null; keepPlace(draw); break;
      case 'board': if (state.placing) placeAt(boardPoint(e, el)); break;
      case 'pin': if (state.placing) { placeAt(boardPoint(e, el.closest('.board'))); break; } state.item = id; go('item'); break;
      case 'open': state.item = id; state.area = el.getAttribute('data-area'); go('item'); break;
      case 'pri': if (state.form) { state.form.pri = v; $$('[data-act="pri"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v)); }); } break;
      case 'savepin': savePin(); break;
      case 'editpin': openPinForm(state.item); break;
      case 'movepin': state.placing = 'move'; go('area'); break;
      case 'removepin': (function () {
        var it = item();
        if (!confirm('Remove pin #' + it.n + '?')) return;
        commit(C.removeItem(book(), it.id, stamp()), true); dropPic('after:' + it.id); state.item = null; go('area'); toast('Removed.');
      }()); break;
      case 'state': setStateOf(state.item, v); break;
      case 'dropafter': dropPic('after:' + state.item).then(function () { keepPlace(draw); }); break;
      case 'which': state.which = v; keepPlace(draw); break;
      case 'copytrade': copy(C.tradeText(book(), state.job, tradeOf(el), today(), state.which), 'Copied - paste it to the sub.'); break;
      case 'sharetrade': shareText(job().name + ' - ' + tradeOf(el), C.tradeText(book(), state.job, tradeOf(el), today(), state.which), 'Copied - paste it to the sub.'); break;
      case 'printtrade': state.printWhat = tradeOf(el); go('print'); break;
      case 'printclose': state.printWhat = 'closeout'; go('print'); break;
      case 'clearpad': state.pad = { strokes: [] }; if (padCtx) { var cv = $('#pad'); paint(padCtx, cv.width, cv.height, [], false); } break;
      case 'sign': doSign(); break;
      case 'unsign': (function () {
        if (!confirm('Clear the client’s sign-off? The signature is removed from this phone.')) return;
        commit(C.unsign(book(), state.job, stamp()), true); dropPic('sign:' + state.job).then(function () { keepPlace(draw); });
      }()); break;
      case 'print': window.print(); break;
      case 'saveby': (function () {
        var s = $('#by').value.trim(), why = s ? C.refuse(s, 60) : '', err = $('#byErr');
        err.hidden = !why; err.textContent = why;
        if (why) return;
        state.device.by = s; saveDevice(); toast(s ? 'Kept on this phone.' : 'Cleared.');
      }()); break;
      case 'wipe':
        if (!confirm('Remove every job, photo and signature from this phone?')) return;
        real.clearAll().then(function () { state.book = null; state.pics = {}; state.pending = {}; state.job = null; state.sync = RS.cleanSync({}); state.device = RS.cleanDevice({}); go('start'); toast('Removed from this phone.'); });
        break;
      default: break;
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sheetOpen()) closeSheet();
    else if (e.key === 'Escape' && state.placing) { state.placing = null; keepPlace(draw); }
  });
  function photoInput(t, fn) {
    var file = t.files && t.files[0];
    t.value = '';
    if (!file) return;
    shrink(file, C.LIMITS.photoSide).then(fn).catch(function (er) { toast(er.message || 'That photo could not be used.', 4200); });
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.hasAttribute('data-newareaphoto')) {
      photoInput(t, function (p) { if (!state.newArea) return; state.newArea.photo = p; var pv = $('#naPrev'); if (pv) pv.innerHTML = '<img class="prev" src="' + esc(p.url) + '" alt="The photo, as it will be kept">'; });
      return;
    }
    if (t.hasAttribute('data-areaphoto')) {
      var aid = state.area;
      photoInput(t, function (p) {
        keepPic('photo:' + aid, p.url).then(function () { var a = book().areas[aid]; commit(C.putArea(book(), aid, a.job, a.name, p.ar, stamp()), true); keepPlace(draw); toast('Photo kept on this phone. The pins stay where they were on the picture.'); }, function (er) { toast(er.message, 4200); });
      });
      return;
    }
    if (t.hasAttribute('data-afterphoto')) {
      var pid = t.getAttribute('data-afterphoto');
      photoInput(t, function (p) { keepPic('after:' + pid, p.url).then(function () { keepPlace(draw); toast('After photo kept on this phone.'); }, function (er) { toast(er.message, 4200); }); });
    }
  });
  window.addEventListener('popstate', function () { route(); });
  // A turned phone resizes the pad; the strokes are kept per mille, so they
  // redraw in place (and nothing typed beside it is lost).
  var resizeTimer = null;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { if (!padDown) sizePad(); }, 150); });
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
    var js = state.book ? C.jobs(state.book) : [];
    if (js.length) state.job = js[0].id;
  }).catch(function () { /* fresh */ }).then(function () {
    var h = (location.hash || '').replace(/^#/, '');
    if (h && ['jobs', 'job', 'trades', 'closeout', 'more'].indexOf(h) < 0) history.replaceState(null, '', BASE);
    route();
    return loadMe();
  }).then(function () { if (signedIn()) syncIn(); });
}());
