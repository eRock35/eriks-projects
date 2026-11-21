/* Rush - the page. One file, no build step.
 *
 * EVERYTHING HAPPENS ON THIS PHONE. The shop - its event, pickup days and
 * slots, the menu, every order (a first name and a last initial, what they
 * ordered, when they collect, what was paid, a note), the bake ticks - is
 * worked out by RushCore and kept through rush-store.js (IndexedDB, with a
 * memory fallback). The made-up example is never kept, sent or synced.
 *
 * The requests this page makes: sign-in, the account's copy of the shop
 * (signed in, to keep two phones at the counter in step), and the one
 * optional order-slip reading, whose body - the photo shrunk on this phone
 * and the menu's item ids and names - is shown in full before it is sent.
 * There is never a link for customers: no route hosts a menu, an order or
 * an order form.
 *
 * Every string a person typed, the server sent or a model wrote is escaped
 * before it is drawn, and no handler is written into markup: clicks and
 * changes are routed by data-act and data-* attributes from one listener
 * each (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.RushCore;
  var D = window.RushDemo;
  var RS = window.RushStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural, money = C.money;
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  var REDUCED = (function () { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return { matches: false }; } }());

  var real = RS.create(RS.idb('rush'));

  var state = {
    me: null, view: 'start', shop: null, demo: false, demoShop: null, device: RS.cleanDevice({}), sync: RS.cleanSync({}), syncState: 'local', syncErr: '',
    tour: 0, day: '', bakeDay: '', pickDay: '', q: '', oq: '', ofilter: 'all',
    form: null, refusal: null, formOk: '', drafts: null, setupDraft: null, setupMsg: '',
    labels: { scope: 'day', day: '', slot: '', order: '', start: 1 }, paper: '',
    share: { order: '', a: null, b: null }, mergeNote: null, cheer: '', demoCheered: [], csv: false, slip: null,
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
  /** Said to a screen reader, not shown. */
  function say(msg) { var l = $('#live'); l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function download(name, type, data) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function shareText(title, text, done) {
    if (navigator.share) navigator.share({ title: title, text: text }).catch(function (er) { if (!er || er.name !== 'AbortError') copy(text, done); });
    else copy(text, done);
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
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Rush stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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
    if (err.status === 413) return showError(new Error('That photo was too much to send. Try again - the page shrinks it first.'), box);
    showError(err, box);
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }

  /* ---------------- the clock and ids (the page's, never the core's) ---------------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { if (state.demo) return D.NOW.d; var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function now() { if (state.demo) return D.NOW; var d = new Date(); return { d: today(), m: d.getHours() * 60 + d.getMinutes() }; }
  function stamp() { return Date.now(); }
  function rid(n) { var s = '', abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; try { var a = new Uint8Array(n); crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += abc[a[i] % 36]; } catch (e) { for (var j = 0; j < n; j++) s += abc[Math.floor(Math.random() * 36)]; } return s; }
  function newOrderId() { return 'o' + rid(9); }
  function newItemId() { return 'i' + rid(7); }

  /* ---------------- the shop: this phone's, and the example ---------------- */

  function shop() { return state.demo ? state.demoShop : state.shop; }
  function saveLocal() { real.putShop(state.shop).catch(function () { /* still in this tab */ }); }
  function saveDevice() { if (!state.demo) real.putDevice(state.device).catch(function () { /* fine */ }); }
  function saveSync() { real.putSync(state.sync).catch(function () { /* fine */ }); }
  /** Keep a changed shop: the example in memory only; a real one on this
   *  phone and, signed in, in the account. */
  function commit(next, quiet) {
    if (state.demo) state.demoShop = next;
    else { state.shop = next; saveLocal(); pushSoon(); }
    if (!quiet) keepPlace(draw);
  }
  function no(o) { return C.orderNo(shop().setup, o.no); }
  function itemsText(o) { var s = shop(); return o.lines.map(function (l) { var it = C.itemOf(s, l.item); return it ? C.qtyText(it, l.qty) : ''; }).filter(Boolean); }
  /** A pickup day to show first: today if it is one, else the next, else the first. */
  function pickDefault() {
    var ds = shop().setup.days, t = today();
    var d = ds.filter(function (x) { return x.d === t; })[0] || ds.filter(function (x) { return x.d > t; })[0] || ds[0];
    return d ? d.d : '';
  }
  function validDay(d) { return Boolean(C.dayOfSetup(shop().setup, d)); }
  function tmHtml(m) { var p = C.clockParts(m); return '<span class="tm">' + esc(p.t) + '<small>' + esc(p.ap) + '</small></span>'; }
  function dayTabsHtml(cur, act, sub) {
    return '<div class="daytabs" role="group" aria-label="Pickup day">' + shop().setup.days.map(function (d) {
      return '<button class="daytab" type="button" data-act="' + esc(act) + '" data-day="' + esc(d.d) + '" aria-pressed="' + (d.d === cur) + '">' + esc(C.dayLabel(d.d)) + (sub ? '<small>' + esc(sub(d.d)) + '</small>' : '') + '</button>';
    }).join('') + '</div>';
  }

  /* ---------------- two phones: the account copy ---------------- */

  var pushTimer = null;
  function bodyOf(s) { var b = C.cleanShop(s).shop; delete b.updatedAt; return b; }
  function pushSoon() {
    if (!signedIn() || !state.me.sync || state.demo || !state.shop) return;
    clearTimeout(pushTimer);
    state.syncState = 'syncing'; drawSync();
    pushTimer = setTimeout(function () { push(); }, 800);
  }
  function push(base) {
    if (!state.shop || !signedIn() || state.demo) return Promise.resolve();
    return api('PUT', 'api/sync', { data: bodyOf(state.shop), base: base !== undefined ? base : state.sync.base }).then(function (out) {
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
    state.shop = C.cleanShop(acc).shop; delete state.shop.updatedAt;
    state.sync = { base: at, at: stamp() }; saveLocal(); saveSync();
    state.syncState = 'synced'; drawSync();
    if (state.view === 'start') go('board'); else keepPlace(draw);
  }
  /** The account's copy came back different: merge it into this phone's
   *  (each order's details and status by their own times, items and bake
   *  ticks by theirs), keep the result here, and save it against the
   *  account's version. */
  function mergeIn(acc, at) {
    var local = state.shop;
    if (!local) { adopt(acc, at); return null; }
    var m = C.merge(local, acc, state.sync.at);
    var merged = m.shop;
    delete merged.updatedAt;
    var pulled = !C.same(merged, local);
    state.shop = merged; saveLocal();
    if (pulled || m.notes.length || m.flags.length) {
      var diff = Object.keys(merged.orders).filter(function (k) { return C.canon(merged.orders[k]) !== C.canon(local.orders[k]); }).length;
      var bits = [];
      if (diff) bits.push(plural(diff, 'order'));
      if (C.canon(merged.items) !== C.canon(local.items)) bits.push('the menu');
      if (C.canon(merged.setup) !== C.canon(local.setup)) bits.push('the setup');
      if (C.canon(merged.bake) !== C.canon(local.bake)) bits.push('the bake ticks');
      state.mergeNote = { pulled: bits, notes: m.notes, flags: m.flags.length };
      if (['setup', 'order'].indexOf(state.view) < 0) keepPlace(draw);
      if ((m.notes.length || m.flags.length) && $('#sheet').hidden) openMergeSheet();
    }
    if (C.same(merged, acc)) { state.sync = { base: at, at: stamp() }; saveSync(); state.syncState = 'synced'; drawSync(); return null; }
    return push(at);
  }
  function syncIn() {
    if (!signedIn() || !state.me.sync || state.demo) return Promise.resolve();
    return api('GET', 'api/sync').then(function (out) {
      if (!out.data) {
        if (!state.shop) { state.syncState = 'synced'; drawSync(); return null; }
        if (state.sync.base === null) return push(null);
        state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'removed'; drawSync(); return null;
      }
      if (!state.shop) { adopt(out.data, out.updatedAt); return null; }
      if (state.sync.base === out.updatedAt) { if (!C.same(state.shop, out.data)) return push(); state.syncState = 'synced'; drawSync(); return null; }
      return mergeIn(out.data, out.updatedAt);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function syncLine() {
    if (state.demo) return '<span class="sync small muted">The example is never saved, sent or synced.</span>';
    if (!signedIn()) return '<span class="sync small muted">On this phone only · <button class="link-btn" type="button" data-act="signin">sign in to keep two phones at the counter in step</button></span>';
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
    var lines = (m.pulled.length ? ['From your other phone: ' + C.list(m.pulled) + '.'] : []).concat(m.notes.slice(0, 4));
    return '<div class="merged" role="status"><b>Merged with your other phone</b><button class="link-btn" type="button" data-act="mergeok">OK</button>' + (lines.length ? '<ul>' + lines.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
  }
  /** What is booked past a cap - flagged on the board, never dropped. */
  function flagsHtml(day) {
    var fs = C.overs(shop()).filter(function (f) { return !day || f.day === day; });
    return fs.map(function (f) {
      var o = shop().orders[f.orders[0]], sug = o ? C.moveSuggestion(shop(), o.id, now()) : null;
      return '<div class="flag" role="alert"><p>' + esc(f.msg) + '</p><div class="btns">' +
        (sug ? '<button class="btn small" type="button" data-act="flagmove" data-id="' + esc(o.id) + '" data-day="' + esc(sug.day) + '" data-slot="' + esc(sug.slot) + '">' + esc('Move ' + no(o) + ' to ' + (sug.day === o.day ? '' : C.dayLabel(sug.day) + ', ') + C.clock(C.mins(sug.slot))) + '</button>' : '') +
        (o ? '<button class="btn small ghost" type="button" data-act="edit" data-id="' + esc(o.id) + '">' + esc('Edit ' + no(o)) + '</button>' : '') + '</div></div>';
    }).join('');
  }
  function openMergeSheet() {
    var m = state.mergeNote || { pulled: [], notes: [] };
    sheet('<h2>Merged with your other phone</h2>' +
      (m.pulled.length ? '<p>' + esc('From your other phone: ' + C.list(m.pulled) + '.') + '</p>' : '') +
      (m.notes.length ? '<ul>' + m.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="stack" id="mergeFlags">' + flagsHtml('') + '</div>' +
      '<p class="small muted">Nothing booked was dropped: an order over a cap stays booked and flagged until someone moves it.</p>' +
      '<div class="btns"><button class="btn" type="button" data-act="mergeok">OK</button><button class="btn ghost" type="button" data-act="tab" data-tab="board">See the slots</button></div>');
  }

  /* ---------------- navigation ---------------- */

  var VIEWS = ['start', 'setup', 'board', 'order', 'bake', 'pickup', 'labels', 'money', 'share', 'orders', 'more'];
  /** Go to a view. A tour step's after-hook runs last, so the scroll it
   *  makes is not undone by the jump to the top, and a sheet it opens is
   *  not closed by the route change. */
  function go(view, after) {
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
    if (after) after();
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    var v = VIEWS.indexOf(h) >= 0 ? h : 'start';
    if (v !== 'start' && v !== 'setup' && !shop()) v = 'start';
    if (v === 'setup' && !state.setupDraft) state.setupDraft = setupDraftOf(shop());
    if (v === 'start' && shop() && !state.demo && h === '') v = 'board';
    if (v === 'order' && !state.form) state.form = blankForm();
    if (v !== 'order') { state.refusal = null; state.formOk = ''; }
    state.view = v;
    draw();
  }
  // A redraw can remove a focused field, whose change event then asks for a
  // redraw of its own in the middle of this one: that one waits its turn.
  var drawing = false;
  function draw() {
    if (drawing) { setTimeout(draw, 0); return; }
    drawing = true;
    try { drawNow(); } finally { drawing = false; }
  }
  function drawNow() {
    var main = $('#main'), tb = $('#tabbar'), s = shop();
    tb.hidden = !s || state.view === 'start' || (state.view === 'setup' && !s);
    var tab = ['labels', 'money', 'share', 'orders', 'setup'].indexOf(state.view) >= 0 ? 'more' : state.view;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var v = state.view, html;
    if (s && !validDay(state.day)) state.day = pickDefault();
    if (s && !validDay(state.bakeDay)) state.bakeDay = pickDefault();
    if (s && !validDay(state.pickDay)) state.pickDay = pickDefault();
    if (v === 'setup') html = setupHtml();
    else if (v === 'board') html = boardHtml();
    else if (v === 'order') html = orderHtml();
    else if (v === 'bake') html = bakeHtml();
    else if (v === 'pickup') html = pickupHtml();
    else if (v === 'labels') html = labelsHtml();
    else if (v === 'money') html = moneyHtml();
    else if (v === 'share') html = shareHtml();
    else if (v === 'orders') html = ordersHtml();
    else if (v === 'more') html = moreHtml();
    else html = startHtml();
    main.innerHTML = html;
    document.body.classList.toggle('in-demo', state.demo);
    drawSync();
    if (v === 'labels' || v === 'bake') fitPreviews();
  }

  /* ---------------- the example and its tour ---------------- */

  var TOUR = [
    { view: 'board', title: 'The slot board', body: 'Every pickup time is a little pie, three places to a slot, and a slice fills for each order. It is 2:10 on Tuesday: the 2:00 slot is outlined, earlier ones are dimmed, and pecan pie is sold out for Wednesday.', btn: 'Open the 2:00 slot', next: 'Next: take an order' },
    { view: 'order', title: 'Take an order - and watch a cap bite', body: 'Lee A. wants a pecan pie on Wednesday. Wednesday’s 24 are all booked, so Rush says so and offers the way out: move the order to Tuesday, or take the pecan pie off.', next: 'Next: the bake list' },
    { view: 'bake', title: 'What to bake for Wednesday', body: 'Every item booked for Wednesday, in oven loads to tick as they come out - pumpkin 18 of 37 done, pecan 12 of 24 - and hour by hour, what each hour’s pickups need.', next: 'Next: pickup day' },
    { view: 'pickup', title: 'Pickup day', body: 'Late first, then the 2:00s arriving, then the rest by slot, with the balance due big on every card. Tick one picked up and Rush collects the balance.', btn: 'Tick one picked up', next: 'Next: box labels' },
    { view: 'labels', title: 'Box labels', body: 'Ten 2 x 4 in labels to a Letter sheet, or 99 x 57 mm on A4: the order number large, the name, the slot, the items, the balance - and an allergy marked. Start part way down a part-used sheet.', next: 'Set up my preorders' },
  ];
  function startDemo() {
    state.demo = true; state.demoShop = D.shop(); state.tour = 1; state.mergeNote = null; state.form = null; state.drafts = null; state.setupDraft = null;
    state.day = D.NOW.d; state.pickDay = D.NOW.d; state.bakeDay = D.NOW.d; state.q = ''; state.cheer = ''; state.demoCheered = []; state.share = { order: '', a: null, b: null };
    state.labels = { scope: 'slot', day: D.NOW.d, slot: '14:00', order: '', start: 1 };
    go('board');
  }
  function leaveDemo() {
    state.demo = false; state.demoShop = null; state.tour = 0; state.form = null; state.drafts = null; state.setupDraft = null; state.labels = { scope: 'day', day: '', slot: '', order: '', start: 1 };
    state.share = { order: '', a: null, b: null };
    if (!state.device.tour) { state.device.tour = true; saveDevice(); }
    go(state.shop ? 'board' : 'start');
  }
  function tourStep(n) {
    if (n > TOUR.length) { leaveDemo(); startSetup(); return; }
    state.tour = n;
    var s = TOUR[n - 1];
    if (n === 2) {
      state.drafts = null;
      state.form = blankForm(D.DAYS[1], '12:30');
      state.form.name = 'Lee A.'; state.form.lines = { pecan: 1 };
      state.refusal = C.checkOrder(shop(), formOrder(), { now: now() });
    }
    if (n === 3) state.bakeDay = D.DAYS[1];
    if (n === 4) { state.pickDay = D.NOW.d; state.q = ''; }
    if (n === 5) state.labels = { scope: 'slot', day: D.NOW.d, slot: '14:00', order: '', start: 1 };
    go(s.view, function () {
      if (n === 2) { var r = $('#refusal'); if (r) reveal(r); }
      if (n === 3) { var tr = $('.trays'); if (tr) tr.scrollIntoView({ block: 'center' }); }
    });
  }
  function guideHtml(view) {
    if (!state.demo) return '';
    var n = state.tour, s = TOUR[n - 1];
    if (!s || s.view !== view) {
      return '<div class="guide" role="note"><div class="gt"><span class="gstep">Example · ' + esc(D.SHOP) + '</span><span>Made up - every tap works, and nothing is kept.</span></div><button class="btn ghost small" type="button" data-act="tour" data-step="1">Take the tour</button></div>';
    }
    return '<div class="guide" role="note"><div class="gt"><span class="gstep">' + esc('Example · step ' + n + ' of ' + TOUR.length) + '</span><b>' + esc(s.title) + '</b><span>' + esc(s.body) + '</span></div>' +
      '<div class="btns">' + (s.btn ? '<button class="btn ghost" type="button" data-act="tourdo" data-step="' + esc(n) + '">' + esc(s.btn) + '</button>' : '') + '<button class="btn" type="button" data-act="' + (n === TOUR.length ? 'tourdone' : 'tour') + '" data-step="' + esc(n + 1) + '">' + esc(s.next) + '</button></div></div>';
  }
  function demoRibbon() {
    return state.demo ? '<p class="ribbon">' + esc(D.NOTICE) + ' <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>' : '';
  }
  function tourDo(n) {
    if (n === 1) openSlot(D.NOW.d, '14:00');
    if (n === 4) {
      var line = C.pickupLine(shop(), D.NOW.d, now(), '');
      var o = line.now.filter(function (x) { return C.balance(x) > 0; })[0] || line.now[0] || line.late[0];
      if (o) pick(o.id);
    }
  }

  /* ---------------- first run ---------------- */

  /** A lattice pie with a pickup tag, drawn in SVG. */
  function heroPieHtml() {
    var bars = '';
    for (var i = 0; i < 6; i++) { var x = 58 + i * 25; bars += '<rect x="' + esc(x) + '" y="40" width="11" height="180" rx="5" fill="#d48a3c" stroke="#9a5a1c" stroke-width="2" transform="rotate(35 130 130)"/>'; }
    for (var j = 0; j < 6; j++) { var x2 = 58 + j * 25; bars += '<rect x="' + esc(x2) + '" y="40" width="11" height="180" rx="5" fill="#e09a4a" stroke="#9a5a1c" stroke-width="2" transform="rotate(-35 130 130)"/>'; }
    return '<svg class="hero-pie" viewBox="0 0 300 260" aria-hidden="true">' +
      '<ellipse cx="130" cy="214" rx="118" ry="20" fill="rgba(0,0,0,.18)"/>' +
      '<circle cx="130" cy="130" r="104" fill="#c27a32"/><circle cx="130" cy="130" r="92" fill="#8f2f1c"/>' +
      '<clipPath id="lat"><circle cx="130" cy="130" r="92"/></clipPath><g clip-path="url(#lat)">' + bars + '</g>' +
      '<circle cx="130" cy="130" r="98" fill="none" stroke="#f3c27a" stroke-width="12" stroke-dasharray=".1 15.4" stroke-linecap="round"/>' +
      '<g transform="rotate(12 238 70)"><path d="M206 40h62a8 8 0 0 1 8 8v44a8 8 0 0 1-8 8h-62l-18-30z" fill="#fff6ea" stroke="#4a2c0c" stroke-width="2"/><circle cx="204" cy="70" r="5" fill="#826c4a"/>' +
      '<text x="216" y="64" font-size="13" font-weight="800" fill="#4a2c0c" font-family="system-ui, sans-serif">PICKUP</text><text x="216" y="86" font-size="17" font-weight="900" fill="#7d4f69" font-family="system-ui, sans-serif">T-014</text></g>' +
      '<path d="M186 76c-10 10-20 22-34 30" fill="none" stroke="#fff6ea" stroke-width="2" stroke-dasharray="3 3"/></svg>';
  }
  function startHtml() {
    return '<div class="stack">' +
      '<section class="hero"><div class="copy"><div class="kicker"><span aria-hidden="true">🥧</span> Holiday preorders for small food shops</div>' +
      '<h1>Holiday preorders without the chaos.</h1>' +
      '<p>Slots that fill, the bake list, a pickup line that moves. For the week before Thanksgiving - and Christmas next - when the orders pile up on paper pads, twelve people book into 2:00 and nobody can find order 47.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the demo</button><button class="btn big ghost" type="button" data-act="new">Set up my preorders</button></div>' +
      '<p class="caps">For bakeries and cafes, butchers, caterers, farm stands and home bakers.</p></div>' + heroPieHtml() + '</section>' +
      '<section class="how4"><h2 class="vh">How it works</h2>' +
      '<div class="card"><h3>Set up in a minute</h3><p class="small muted">Your pickup days and hours, slots of 15 to 60 minutes, how many orders fit in each - and the menu, with a cap a day for each item.</p></div>' +
      '<div class="card"><h3>Take orders fast</h3><p class="small muted">Big steppers, the caps live beside each item, and only the slots with room. Overselling is blocked - with a way out.</p></div>' +
      '<div class="card"><h3>Bake to the list</h3><p class="small muted">How many of each by the first pickup, in oven loads to tick, and hour by hour what each hour’s pickups need.</p></div>' +
      '<div class="card"><h3>A pickup line that moves</h3><p class="small muted">Late first, then now, then the rest by slot - the balance due big on every card - and box labels to print.</p></div>' +
      '</section>' +
      '<section class="card promise"><h2>The promise</h2><ul class="ticks"><li><b>No sign-in.</b> Everything works without an account.</li><li><b>No customer phone numbers or emails.</b> Rush never asks for one - keep those in your till or your contacts.</li><li><b>Works offline</b> once it has loaded.</li><li><b>Stays on this phone.</b> No link for customers, no storefront, nothing sent.</li></ul><p class="small muted" style="margin:8px 0 0">Sign in only to keep two phones at the counter in step, or to have AI read a paper order slip into drafts you check.</p></section>' +
      '<p class="foot">A trial app in the <a href="../">Challenge Lab</a>. Rush takes no payments and holds no card numbers.</p>' +
      '</div>';
  }

  /* ---------------- setup ---------------- */

  function setupDraftOf(s) {
    var setup = s ? C.clone(s.setup) : C.defaultSetup(today());
    var ev = C.EVENTS.indexOf(setup.event) >= 0 ? setup.event : 'own';
    return { setup: setup, items: s ? C.clone(s.items) : {}, open: '', ev: ev, isNew: !s };
  }
  function startSetup() {
    state.demo = false; state.demoShop = null;
    state.setupDraft = setupDraftOf(state.shop); state.setupMsg = '';
    go('setup');
  }
  function timeOpts(cur) {
    var out = '';
    for (var m = 5 * 60; m <= 23 * 60; m += 15) out += '<option value="' + esc(C.hm(m)) + '"' + (C.hm(m) === cur ? ' selected' : '') + '>' + esc(C.clock(m)) + '</option>';
    if (C.mins(cur) !== null && C.mins(cur) % 15) out = '<option value="' + esc(cur) + '" selected>' + esc(C.clock(C.mins(cur))) + '</option>' + out;
    return out;
  }
  function itemRowHtml(it) {
    var sd = state.setupDraft;
    if (sd.open === it.id) {
      return '<div class="medit" id="medit"><div class="pair"><label class="field"><span>Item</span><input class="input" data-iset="name" data-id="' + esc(it.id) + '" value="' + esc(it.name) + '" maxlength="40" autocomplete="off"></label>' +
        '<label class="field"><span>Unit, as a word</span><input class="input" data-iset="unit" data-id="' + esc(it.id) + '" value="' + esc(it.unit) + '" maxlength="20" autocomplete="off"></label></div>' +
        '<div class="pair"><label class="field"><span>Price ($)</span><input class="input" inputmode="decimal" data-iset="price" data-id="' + esc(it.id) + '" value="' + esc(it.price ? (it.price / 100).toFixed(it.price % 100 ? 2 : 0) : '') + '"></label>' +
        '<label class="field"><span>Batch (one oven load)</span><input class="input" type="number" min="1" max="99" data-iset="batch" data-id="' + esc(it.id) + '" value="' + esc(it.batch) + '"></label></div>' +
        '<div class="pair"><label class="field"><span>Cap a pickup day</span><input class="input" type="number" min="1" max="999" data-iset="cap" data-id="' + esc(it.id) + '" value="' + esc(it.cap === null ? '' : it.cap) + '"><small>Leave it empty for no limit.</small></label>' +
        '<label class="check"><input type="checkbox" data-iset="off" data-id="' + esc(it.id) + '"' + (it.off ? ' checked' : '') + '> Not taking orders for it now</label></div>' +
        '<div class="btns"><button class="btn small" type="button" data-act="idone">Done</button><button class="btn small ghost" type="button" data-act="idel" data-id="' + esc(it.id) + '">Remove</button></div></div>';
    }
    return '<div class="mrow"><div class="mt"><b>' + esc(it.name || 'New item') + (it.off ? ' · not taking orders' : '') + '</b><span>' + esc(C.priceWord(it) + ' · batch ' + it.batch + ' · ' + C.capWord(it).toLowerCase()) + '</span></div>' +
      '<button class="btn small ghost" type="button" data-act="iedit" data-id="' + esc(it.id) + '" aria-label="' + esc('Edit ' + (it.name || 'the new item')) + '">Edit</button></div>';
  }
  function setupHtml() {
    var sd = state.setupDraft, s = sd.setup, has = Boolean(shop());
    var items = Object.keys(sd.items).map(function (k) { return sd.items[k]; }).filter(function (x) { return !x.del; }).sort(function (a, b) { return a.pos - b.pos; });
    var slotsN = s.days.map(function (d) { return C.slots(s, d).length; }).reduce(function (a, b) { return a + b; }, 0);
    var dayRows = s.days.map(function (d, i) {
      return '<div class="dayrow"><label class="field dd"><span>Day ' + esc(i + 1) + '</span><input class="input" type="date" data-dset="d" data-i="' + esc(i) + '" value="' + esc(d.d) + '"></label>' +
        '<label class="field"><span>Opens</span><select class="input" data-dset="open" data-i="' + esc(i) + '">' + timeOpts(d.open) + '</select></label>' +
        '<label class="field"><span>Closes</span><select class="input" data-dset="close" data-i="' + esc(i) + '">' + timeOpts(d.close) + '</select></label>' +
        '<button class="xbtn" type="button" data-act="rmday" data-i="' + esc(i) + '" aria-label="' + esc('Remove ' + C.dayLabel(d.d)) + '"' + (s.days.length < 2 ? ' disabled' : '') + '>×</button></div>';
    }).join('');
    var dp = s.deposit;
    return '<div class="stack">' + demoRibbon() +
      '<div class="sec-head"><h1>' + (sd.isNew ? 'Set up your preorders' : 'Setup') + '</h1><span class="muted small">About a minute. You can change any of it later.</span></div>' +
      '<div class="setup-grid"><div class="stack">' +
      '<section class="card"><h2>Your shop</h2><div class="pair wide">' +
      '<label class="field"><span>Shop nickname</span><input class="input" data-sset="name" value="' + esc(s.name) + '" maxlength="40" autocomplete="organization"><small>What customers call you - it ends every confirmation. No address needed, anywhere.</small></label>' +
      '<div class="field"><span>The event</span><div class="chips" role="group" aria-label="The event">' + C.EVENTS.map(function (e) { return '<button class="chip" type="button" data-act="event" data-v="' + esc(e) + '" aria-pressed="' + (sd.ev === e) + '">' + esc(e) + '</button>'; }).join('') + '<button class="chip" type="button" data-act="event" data-v="own" aria-pressed="' + (sd.ev === 'own') + '">Its own name</button></div></div></div>' +
      (sd.ev === 'own' ? '<label class="field" style="margin-top:10px"><span>Event name</span><input class="input" data-sset="event" value="' + esc(s.event) + '" maxlength="40"></label>' : '') +
      '<p class="small muted" style="margin:10px 0 0">' + esc('Order numbers start ' + C.orderNo(s, 1) + ' - the event’s first letter.') + '</p></section>' +
      '<section class="card"><h2>Pickup days</h2>' + dayRows +
      (s.days.length < C.LIMITS.days ? '<button class="btn small ghost" type="button" data-act="addday">+ Add a pickup day</button>' : '') +
      '<div class="pair wide" style="margin-top:12px"><div class="field"><span>Slot length</span><div class="seg four" role="group" aria-label="Slot length">' + C.SLOT_MINS.map(function (m) { return '<button type="button" data-act="slotmin" data-v="' + esc(m) + '" aria-pressed="' + (s.slotMin === m) + '">' + esc(m) + ' min</button>'; }).join('') + '</div></div>' +
      '<div class="field"><span>Orders a slot</span><div class="stepper"><button type="button" data-act="perslot" data-d="-1" aria-label="One fewer">−</button><b>' + esc(s.perSlot) + '</b><button type="button" data-act="perslot" data-d="1" aria-label="One more">+</button></div></div></div>' +
      '<p class="small muted" style="margin:10px 0 0">' + esc(plural(slotsN, 'pickup slot') + ' in all, ' + plural(slotsN * s.perSlot, 'place') + '.') + '</p></section>' +
      '<section class="card"><h2>Cutoff and deposit</h2><div class="pair"><label class="field"><span>Orders close on</span><input class="input" type="date" data-sset="cutd" value="' + esc(s.cutoff ? s.cutoff.d : '') + '"></label>' +
      '<label class="field"><span>at</span><select class="input" data-sset="cutt">' + timeOpts(s.cutoff ? s.cutoff.t : '18:00') + '</select></label></div><p class="small muted" style="margin:6px 0 12px">The cutoff goes in the text you share - Rush still lets you take a late order.</p>' +
      '<div class="field"><span>Deposit</span><div class="seg" role="group" aria-label="Deposit">' + [['none', 'None'], ['fixed', 'An amount'], ['percent', 'A percent']].map(function (x) { return '<button type="button" data-act="deposit" data-v="' + esc(x[0]) + '" aria-pressed="' + (dp.mode === x[0]) + '">' + esc(x[1]) + '</button>'; }).join('') + '</div></div>' +
      (dp.mode === 'fixed' ? '<label class="field" style="margin-top:10px"><span>Deposit ($)</span><input class="input" inputmode="decimal" data-sset="depc" value="' + esc((dp.cents / 100).toFixed(dp.cents % 100 ? 2 : 0)) + '"></label>' : '') +
      (dp.mode === 'percent' ? '<label class="field" style="margin-top:10px"><span>Deposit (% of the order)</span><input class="input" type="number" min="1" max="100" data-sset="depp" value="' + esc(dp.pct) + '"></label>' : '') + '</section>' +
      '</div><div class="stack"><section class="card"><h2>The menu</h2><p class="small muted">Start from one and change anything:</p><div class="chips" role="group" aria-label="Starter menus">' +
      Object.keys(C.STARTERS).map(function (k) { return '<button class="chip" type="button" data-act="starter" data-v="' + esc(k) + '">' + esc(C.STARTERS[k].label) + '</button>'; }).join('') + '</div>' +
      '<div style="margin-top:12px">' + (items.length ? items.map(itemRowHtml).join('') : '<p class="muted">No items yet - tap a starter menu or add your own.</p>') + '</div>' +
      (items.length < C.LIMITS.items ? '<button class="btn small ghost" type="button" data-act="iadd">+ Add an item</button>' : '') +
      '<p class="small muted" style="margin:10px 0 0">The cap is how many you can make for one pickup day. The batch is one oven load - the bake list counts in those.</p></section>' +
      '<div id="setupMsg">' + (state.setupMsg ? '<div class="refuse" role="alert"><p>' + esc(state.setupMsg) + '</p></div>' : '') + '</div>' +
      '<div class="btns"><button class="btn big" type="button" data-act="savesetup">' + (sd.isNew ? 'Start taking orders' : 'Save the setup') + '</button>' + (has ? '<button class="btn ghost" type="button" data-act="tab" data-tab="board">Cancel</button>' : '<button class="btn ghost" type="button" data-act="home">Back</button>') + '</div>' +
      '</div></div></div>';
  }
  /** Save the setup: through the text doors, and refused (with what to do)
   *  when it would strand orders. */
  function saveSetup() {
    var sd = state.setupDraft, s = sd.setup, cur = shop(), t = stamp();
    var bad = function (msg) { state.setupMsg = msg; keepPlace(draw); var m = $('#setupMsg'); if (m) reveal(m); };
    var nm = C.line(s.name, C.LIMITS.shop);
    if (!nm) return bad('Give your shop a nickname - it ends every confirmation.');
    var why = C.refuse(s.name, C.LIMITS.shop) || C.refuse(s.event, C.LIMITS.event);
    if (why) return bad(why);
    if (!C.line(s.event, C.LIMITS.event)) return bad('Name the event - like "Thanksgiving pickup".');
    var seen = {};
    for (var i = 0; i < s.days.length; i++) {
      var d = s.days[i], a = C.mins(d.open), b = C.mins(d.close);
      if (!C.isIso(d.d)) return bad('Pick a date for day ' + (i + 1) + '.');
      if (seen[d.d]) return bad(C.dayLabel(d.d) + ' is there twice.');
      seen[d.d] = true;
      if (a === null || b === null || s.slotMin > b - a) return bad(C.dayLabel(d.d) + ' closes before a whole ' + s.slotMin + '-minute slot fits.');
    }
    var items = Object.keys(sd.items).map(function (k) { return sd.items[k]; });
    var liveItems = items.filter(function (x) { return !x.del; });
    if (!liveItems.length) return bad('Add at least one item to the menu - or tap a starter menu.');
    for (var j = 0; j < liveItems.length; j++) {
      var it = liveItems[j];
      if (!C.line(it.name, C.LIMITS.item)) return bad('Every item needs a name.');
      var w = C.refuse(it.name, C.LIMITS.item) || C.refuse(it.unit, C.LIMITS.unit);
      if (w) return bad(it.name + ': ' + w);
    }
    if (cur) {
      var live = C.liveOrders(cur);
      var gone = cur.setup.days.filter(function (x) { return !seen[x.d] && live.some(function (o) { return o.day === x.d; }); })[0];
      if (gone) return bad(C.dayLabel(gone.d) + ' still has ' + plural(live.filter(function (o) { return o.day === gone.d; }).length, 'order') + ' - move them to another day first, or keep the day.');
      if (s.slotMin !== cur.setup.slotMin && live.length) return bad('The slot length can’t change once orders are booked - ' + plural(live.length, 'order holds its slot', 'orders hold their slots') + '. Keep ' + cur.setup.slotMin + ' minutes.');
    }
    var next = cur ? C.clone(cur) : C.newShop(s, t);
    var setupClean = { name: nm, event: C.line(s.event, C.LIMITS.event), days: s.days.slice().sort(function (x, y) { return x.d < y.d ? -1 : 1; }), slotMin: s.slotMin, perSlot: s.perSlot, cutoff: s.cutoff && C.isIso(s.cutoff.d) ? s.cutoff : null, deposit: s.deposit };
    if (!cur || C.canon(setupClean) !== C.canon(cur.setup)) { next.setup = setupClean; next.setupT = t; }
    items.forEach(function (x) {
      var prev = cur && cur.items[x.id];
      var clean = { id: x.id, name: C.line(x.name, C.LIMITS.item), unit: C.line(x.unit, C.LIMITS.unit), price: x.price, batch: x.batch, cap: x.cap, off: Boolean(x.off), del: Boolean(x.del), pos: x.pos, t: x.t };
      if (!prev || C.canon(Object.assign({}, clean, { t: 0 })) !== C.canon(Object.assign({}, prev, { t: 0 }))) clean.t = t;
      else clean.t = prev.t;
      next.items[x.id] = clean;
    });
    var chk = C.cleanShop(next, true);
    if (chk.errors.length) return bad(chk.errors[0]);
    var overs = C.overs(next).length;
    state.setupDraft = null; state.setupMsg = '';
    commit(next, true);
    go('board', function () { if (overs) toast(plural(overs, 'slot or item is', 'slots or items are') + ' now over a cap - flagged on the board.', 5000); else toast(sd.isNew ? 'Ready - take your first order.' : 'Saved.'); });
  }

  /* ---------------- the slot board ---------------- */

  /** A slot as a little pie: a crimped crust, a slice per place that fills
   *  as it books, steam vents; a red ring when it is booked past its cap. */
  function pieSvg(n, per, fresh) {
    var cx = 50, cy = 50, r = 38, out = '<svg class="pie" viewBox="0 0 100 100" aria-hidden="true"><circle class="crust" cx="50" cy="50" r="44"/><circle class="crimp" cx="50" cy="50" r="44.5"/><circle class="base" cx="50" cy="50" r="' + r + '"/>';
    var k = Math.min(n, per);
    var pt = function (a) { return (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2); };
    for (var i = 0; i < k; i++) {
      if (per === 1) { out += '<circle class="slice' + (fresh && i === k - 1 ? ' fresh' : '') + '" cx="50" cy="50" r="' + r + '"/>'; break; }
      var a0 = -Math.PI / 2 + i * 2 * Math.PI / per, a1 = a0 + 2 * Math.PI / per;
      out += '<path class="slice' + (fresh && i === k - 1 ? ' fresh' : '') + '" d="M50 50L' + pt(a0) + 'A' + r + ' ' + r + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + pt(a1) + 'Z"/>';
    }
    if (per > 1) for (var j = 0; j < per; j++) { var a = -Math.PI / 2 + j * 2 * Math.PI / per; out += '<line class="cut" x1="50" y1="50" x2="' + (cx + r * Math.cos(a)).toFixed(2) + '" y2="' + (cy + r * Math.sin(a)).toFixed(2) + '"/>'; }
    var ventCls = k ? 'vent' : 'vent on-base';
    out += '<path class="' + ventCls + '" d="M44 41q3 3 0 6M50 39q3 3 0 6M56 41q3 3 0 6"/>';
    if (n > per) out += '<circle class="ring" cx="50" cy="50" r="47.5"/>';
    return out + '</svg>';
  }
  function slotTileHtml(day, s) {
    var cls = 'slot' + (s.full ? ' full' : '') + (s.over ? ' over' : '') + (s.past ? ' past' : '') + (s.current ? ' now' : '');
    var left = s.over ? s.over + ' over' : s.full ? 'Full' : s.left + ' left';
    var label = C.slotSpan(shop().setup, s.key) + ', ' + plural(s.n, 'order') + ' of ' + s.per + (s.over ? ', ' + s.over + ' over' : s.full ? ', full' : '') + (s.past ? ', passed' : '') + (s.current ? ', now' : '');
    return '<button class="' + cls + '" type="button" data-act="slot" data-day="' + esc(day) + '" data-slot="' + esc(s.key) + '" aria-label="' + esc(label) + '">' +
      (s.current ? '<span class="now-tag">Now</span>' : '') + '<span class="st">' + tmHtml(s.s) + '</span>' + pieSvg(s.n, s.per) +
      '<span class="sl">' + esc(left) + '</span>' + (s.over ? '<span class="stamp over">OVER</span>' : s.full ? '<span class="stamp">FULL</span>' : '') + '</button>';
  }
  function itemChipsHtml(b) {
    return '<div class="itemchips">' + b.items.map(function (it) {
      var cls = it.soldOut ? 'ichip out' : it.left !== null && it.left <= 3 ? 'ichip low' : 'ichip';
      var txt = it.over ? it.name + ' - ' + it.over + ' over' : it.soldOut ? it.name + ' - sold out' : it.left !== null ? it.name + ' - ' + it.left + ' left' : it.name + ' - ' + it.booked + ' booked';
      return '<span class="' + cls + '">' + esc(txt) + '</span>';
    }).join('') + '</div>';
  }
  function boardHtml() {
    var s = shop(), d = state.day, b = C.board(s, d, now());
    var outside = b.outside.length ? '<p class="small warnline">' + esc(plural(b.outside.length, 'order is', 'orders are') + ' booked outside the day’s hours - see the flag above.') + '</p>' : '';
    return '<div class="stack">' + demoRibbon() + guideHtml('board') + mergeNoteHtml() + flagsHtml(d) +
      '<div class="sec-head"><h1>Pickup slots</h1><span class="muted">' + esc(s.setup.event + ' · ' + plural(C.liveOrders(s).length, 'order')) + '</span></div>' +
      dayTabsHtml(d, 'bday', function (x) { var bb = C.board(s, x); return plural(bb.orders, 'order') + ' · ' + bb.full + ' full'; }) +
      itemChipsHtml(b) +
      '<p class="legend"><span>' + esc('Each pie is a pickup time with ' + plural(s.setup.perSlot, 'place') + '; a slice fills for each order.') + '</span>' + (now().d === d ? '<span>Passed slots are dimmed; the current one is outlined.</span>' : '') + '</p>' +
      '<section class="pies" aria-label="' + esc('Slots on ' + C.longDay(d)) + '">' + b.slots.map(function (x) { return slotTileHtml(d, x); }).join('') + '</section>' + outside +
      '<div class="btns"><button class="btn" type="button" data-act="neworder">+ New order</button><button class="btn ghost" type="button" data-act="slip">📷 Read an order slip</button><button class="btn ghost" type="button" data-act="labelsday" data-day="' + esc(d) + '">Labels for the day</button></div>' +
      '<p class="small" data-sync></p></div>';
  }
  function orderLineHtml(o, opts) {
    opts = opts || {};
    return '<div class="orow' + (o.status === 'cancelled' ? ' cancelled' : '') + '"><div class="od"><b>' + esc(no(o) + ' · ' + o.name) + '</b><span>' + esc(itemsText(o).join(', ')) + '</span><span>' + esc((opts.when ? C.dayLabel(o.day) + ', ' + C.clock(C.mins(o.slot)) + ' · ' : '') + C.STATUS_WORD[o.status] + ' · ' + (o.status === 'cancelled' ? 'cancelled' : C.dueWord(o))) + '</span>' +
      (o.note ? '<span' + (C.isAllergy(o.note) ? ' class="al"' : '') + '>' + esc((C.isAllergy(o.note) ? 'ALLERGY: ' : 'Note: ') + o.note) + '</span>' : '') + '</div><div class="btns">' + (opts.buttons || '') + '</div></div>';
  }
  function openSlot(day, key) {
    var s = shop(), b = C.board(s, day, now()), x = b.slots.filter(function (y) { return y.key === key; })[0];
    if (!x) return;
    var alt = x.full || x.past ? C.nearestSlot(s, day, key, { now: now(), notSame: true }) : null;
    var take = x.past ? '' : !x.full ? '<button class="btn" type="button" data-act="takeat" data-day="' + esc(day) + '" data-slot="' + esc(key) + '">' + esc('Take an order at ' + C.clock(x.s)) + '</button>' : '';
    var altBtn = alt ? '<button class="btn' + (take ? ' ghost' : '') + '" type="button" data-act="takeat" data-day="' + esc(day) + '" data-slot="' + esc(alt) + '">' + esc((x.past ? 'Passed - ' : 'Full - ') + C.clock(C.mins(alt)) + ' has room') + '</button>' : '';
    sheet('<h2>' + esc(C.slotSpan(s.setup, key) + ' · ' + C.dayLabel(day)) + '</h2>' +
      '<p class="muted">' + esc(plural(x.n, 'order') + ' of ' + x.per + (x.over ? ' - ' + x.over + ' over' : x.full ? ' - full' : ' - ' + x.left + ' left') + (x.past ? ' · this slot has passed' : x.current ? ' · now' : '')) + '</p>' +
      (x.orders.length ? x.orders.map(function (o) { return orderLineHtml(o, { buttons: '<button class="btn small ghost" type="button" data-act="edit" data-id="' + esc(o.id) + '">Edit</button>' }); }).join('') : '<p class="muted">Nobody booked yet.</p>') +
      '<div class="btns" style="margin-top:12px">' + take + altBtn + (x.orders.length ? '<button class="btn ghost" type="button" data-act="labelsslot" data-day="' + esc(day) + '" data-slot="' + esc(key) + '">Print this slot’s labels</button>' : '') + '</div>');
  }

  /* ---------------- taking an order ---------------- */

  function defaultPay(setup) { return { kind: setup.deposit.mode === 'none' ? 'pickup' : 'deposit', paid: null, how: 'card' }; }
  function blankForm(day, slot) {
    var s = shop(), d = day || state.day || pickDefault();
    var k = slot || (d ? C.nearestSlot(s, d, '', { now: now() }) : '') || '';
    return { id: null, name: '', lines: {}, day: d, slot: k, note: '', pay: defaultPay(s.setup), unsure: [], draft: null };
  }
  function formFromOrder(o) {
    var lines = {};
    o.lines.forEach(function (l) { lines[l.item] = l.qty; });
    return { id: o.id, name: o.name, lines: lines, day: o.day, slot: o.slot, note: o.note, pay: { kind: o.pay.kind, paid: o.pay.kind === 'deposit' ? o.pay.paid : null, how: o.pay.how || 'card' }, unsure: [], draft: null };
  }
  function formOrder() {
    var f = state.form;
    return { id: f.id || 'onewxxxxxx', name: f.name, day: f.day, slot: f.slot, note: f.note, lines: Object.keys(f.lines).filter(function (k) { return f.lines[k] > 0; }).map(function (k) { return { item: k, qty: f.lines[k] }; }) };
  }
  function formTotal() {
    var s = shop(), f = state.form, prev = f.id ? s.orders[f.id] : null;
    return C.shapeOrder(s, { lines: formOrder().lines, pay: { kind: 'pickup' } }, prev).lines.reduce(function (a, l) { return a + l.qty * l.price; }, 0);
  }
  function formPay() {
    var f = state.form, t = formTotal(), setup = shop().setup;
    var paid = f.pay.kind === 'full' ? t : f.pay.kind === 'deposit' ? (f.pay.paid === null ? C.depositFor(setup, t) : Math.min(t, f.pay.paid)) : 0;
    return { kind: f.pay.kind, paid: paid, how: f.pay.how };
  }
  function uns(field) { return state.form.unsure.indexOf(field) >= 0 ? ' unsure' : ''; }
  function unsTag(field, why) { return state.form.unsure.indexOf(field) >= 0 ? '<span class="unsure-tag">' + esc(why || 'Check this') + '</span>' : ''; }
  function orderHtml() {
    var s = shop(), f = state.form, setup = s.setup, prev = f.id ? s.orders[f.id] : null, w = f.day ? C.dayWord(setup, f.day) : '';
    var items = C.menu(s).filter(function (it) { return !it.off || f.lines[it.id]; });
    var rows = items.map(function (it) {
      var q = f.lines[it.id] || 0, left = f.day ? C.itemLeft(s, it.id, f.day, f.id) : null;
      var capCls = left === null ? '' : left <= 0 ? ' out' : q > left || left <= 3 ? ' low' : '';
      var cap = left === null ? 'No limit' : it.name + ': ' + (left <= 0 ? 'sold out' : left + ' left') + ' for ' + w;
      return '<div class="irow' + (q ? ' has' : '') + '"><div><div class="iname">' + esc(it.name) + '</div><div class="small muted">' + esc(C.priceWord(it)) + '</div><div class="icap' + capCls + '">' + esc(cap) + '</div></div>' +
        '<div class="qty" role="group" aria-label="' + esc(it.name) + '"><button type="button" data-act="qty" data-item="' + esc(it.id) + '" data-d="-1" aria-label="' + esc('One fewer ' + it.name) + '"' + (q ? '' : ' disabled') + '>−</button><b aria-live="polite">' + esc(q) + '</b><button type="button" data-act="qty" data-item="' + esc(it.id) + '" data-d="1" aria-label="' + esc('One more ' + it.name) + '"' + (q >= C.LIMITS.qty ? ' disabled' : '') + '>+</button></div></div>';
    }).join('');
    var b = f.day ? C.board(s, f.day, now()) : null;
    var grid = b ? b.slots.map(function (x) {
      var mine = prev && prev.day === f.day && prev.slot === x.key && prev.status !== 'cancelled' ? 1 : 0;
      var left = x.left + mine, dis = (x.past && !(prev && prev.slot === x.key && prev.day === f.day)) || left <= 0;
      return '<button class="sbtn" type="button" data-act="pickslot" data-slot="' + esc(x.key) + '" aria-pressed="' + (f.slot === x.key) + '"' + (dis && f.slot !== x.key ? ' disabled' : '') + '>' + tmHtml(x.s) + '<small class="left">' + esc(x.past ? 'passed' : left <= 0 ? 'full' : left + ' left') + '</small></button>';
    }).join('') : '';
    var t = formTotal(), py = formPay(), due = Math.max(0, t - py.paid - (prev && prev.got ? prev.got.cents : 0));
    var dr = state.drafts;
    var draftBar = dr ? '<div class="draftbar"><span><b>' + esc('Draft ' + (dr.i + 1) + ' of ' + dr.list.length + ' from the slip') + '</b>' + (dr.example ? ' · made-up example reading' : ' · AI-written - check it against the slip') + '</span><div class="btns"><button class="btn small ghost" type="button" data-act="skipdraft">Skip this one</button></div></div>' : '';
    var other = f.draft && f.draft.other && f.draft.other.length ? '<p class="small warnline">' + esc('Not on the menu, kept as words in the note: ' + C.list(f.draft.other) + '.') + '</p>' : '';
    var written = f.draft && f.unsure.indexOf('time') >= 0 && f.draft.written.time ? 'Written ' + f.draft.written.time + ' - that time had no room, so this is the nearest' : 'Check this';
    return '<div class="stack">' + demoRibbon() + guideHtml('order') + draftBar +
      '<div class="sec-head"><h1>' + esc(prev ? 'Edit ' + no(prev) : 'New order') + '</h1>' + (prev ? '<span class="muted">' + esc(C.STATUS_WORD[prev.status] + ' · taken as ' + no(prev)) + '</span>' : '<span class="muted small">' + esc('It will be ' + C.orderNo(setup, C.nextNo(s))) + '</span>') + '</div>' +
      '<div class="two oform"><section class="card"><label class="field' + uns('name') + '"><span>Customer’s name ' + unsTag('name') + '</span><input class="input" id="fName" data-fset="name" value="' + esc(f.name) + '" maxlength="40" autocomplete="off" placeholder="First name and last initial"><small>Rush never asks for a phone number or an email - keep those in your till or your contacts.</small></label>' +
      '<div class="field' + uns('items') + '" style="margin-top:12px" id="fItems"><span>Items ' + unsTag('items') + '</span><div class="items">' + (rows || '<p class="muted">No items on the menu - add some in Setup.</p>') + '</div></div>' + other + '</section>' +
      '<section class="card"><div class="field' + uns('day') + '"><span>Pickup day ' + unsTag('day') + '</span>' + dayTabsHtml(f.day, 'fday', function (x) { return C.wdLong(x); }) + '</div>' +
      '<div class="field' + uns('time') + '" style="margin-top:12px"><span>Pickup time ' + unsTag('time', written) + '</span><div class="slotgrid" role="group" aria-label="Pickup time">' + grid + '</div></div>' +
      '<label class="field' + uns('note') + '" style="margin-top:12px"><span>Note ' + unsTag('note') + '</span><textarea class="input" id="fNote" data-fset="note" maxlength="200" placeholder="Anything to remember - an inscription, an allergy">' + esc(f.note) + '</textarea><small>An allergy is shown in bold on the ticket and the label. Acting on it is the shop’s job - Rush only shows it.</small></label>' +
      '<div class="field' + uns('paid') + '" style="margin-top:12px"><span>Payment ' + unsTag('paid', 'Check how it was paid') + '</span><div class="seg" role="group" aria-label="Payment">' + C.PAY_KINDS.map(function (k) { return '<button type="button" data-act="paykind" data-v="' + esc(k) + '" aria-pressed="' + (f.pay.kind === k) + '">' + esc(C.PAY_WORD[k]) + '</button>'; }).join('') + '</div></div>' +
      (f.pay.kind === 'deposit' ? '<label class="field" style="margin-top:10px"><span>Deposit paid ($)</span><input class="input" id="fDep" inputmode="decimal" data-fset="dep" value="' + esc((py.paid / 100).toFixed(py.paid % 100 ? 2 : 0)) + '"><small>' + esc(setup.deposit.mode === 'none' ? 'Any amount paid now.' : 'The rule says ' + money(C.depositFor(setup, t)) + ' - change it if they paid something else.') + '</small></label>' : '') +
      (f.pay.kind !== 'pickup' ? '<div class="field" style="margin-top:10px"><span>Paid by</span><div class="seg" role="group" aria-label="Paid by">' + C.HOWS.map(function (h) { return '<button type="button" data-act="payhow" data-v="' + esc(h) + '" aria-pressed="' + (f.pay.how === h) + '">' + esc(C.HOW_WORD[h]) + '</button>'; }).join('') + '</div></div>' : '') +
      '<div class="totline" style="margin-top:12px"><span>Total <b>' + esc(money(t)) + '</b></span><span>' + esc(py.paid ? money(py.paid) + ' paid' : 'Nothing paid yet') + '</span><span><b>' + esc(due ? money(due) + ' due at pickup' : 'Paid') + '</b></span></div>' +
      '<div id="refusal" style="margin-top:12px">' + refusalHtml() + (state.formOk ? '<p class="okline">' + esc(state.formOk) + '</p>' : '') + '</div>' +
      '<div class="btns" style="margin-top:12px"><button class="btn big" type="button" data-act="book">' + (prev ? 'Save changes' : dr ? 'Book it' : 'Book it') + '</button>' +
      (prev && prev.status !== 'picked' && prev.status !== 'cancelled' ? '<button class="btn danger" type="button" data-act="cancelorder" data-id="' + esc(prev.id) + '">Cancel the order</button>' : '') +
      (prev ? '<button class="btn ghost" type="button" data-act="shareone" data-id="' + esc(prev.id) + '">Confirmation text</button>' : '') +
      (!dr && !state.demo ? '<button class="btn ghost" type="button" data-act="slip">📷 Read a slip</button>' : '') + '</div></section></div></div>';
  }
  function refusalHtml() {
    var r = state.refusal;
    if (!r) return '';
    return r.problems.map(function (p, i) {
      return '<div class="refuse" role="alert"' + (i ? ' style="margin-top:8px"' : '') + '><p>' + esc(p.msg) + '</p><div class="btns">' + p.fixes.map(function (x, j) {
        return '<button class="btn small' + (j ? ' ghost' : '') + '" type="button" data-act="fix" data-p="' + esc(i) + '" data-f="' + esc(j) + '">' + esc(x.label) + '</button>';
      }).join('') + '</div></div>';
    }).join('');
  }
  function recheck() {
    var r = C.checkOrder(shop(), formOrder(), { now: now() });
    if (r.ok) { state.refusal = null; state.formOk = 'It fits now - tap Book it.'; } else { state.refusal = r; state.formOk = ''; }
  }
  function applyFix(pi, fi) {
    var p = state.refusal && state.refusal.problems[pi], x = p && p.fixes[fi], f = state.form;
    if (!x) return;
    if (x.act === 'focus') { var el = x.target === 'name' ? $('#fName') : x.target === 'note' ? $('#fNote') : x.target === 'dep' ? $('#fDep') : $('#fItems'); if (el) { reveal(el); if (el.focus) el.focus(); } return; }
    if (x.act === 'setup') { startSetup(); return; }
    if (x.act === 'orders') { go('orders'); return; }
    if (x.act === 'restore' && f.id) { var rr = C.restoreOrder(shop(), f.id, { t: stamp(), now: now() }); if (rr.ok) { commit(rr.shop, true); recheck(); } else state.refusal = rr; keepPlace(draw); return; }
    if (x.act === 'moveDay') { f.day = x.day; f.slot = x.slot; }
    if (x.act === 'moveSlot') f.slot = x.slot;
    if (x.act === 'drop') delete f.lines[x.item];
    if (x.act === 'set') f.lines[x.item] = x.qty;
    f.unsure = f.unsure.filter(function (u) { return !(x.act === 'moveSlot' || x.act === 'moveDay') || (u !== 'time' && u !== 'day'); });
    recheck();
    keepPlace(draw);
    var r = $('#refusal'); if (r) reveal(r);
  }
  function book() {
    var f = state.form, s = shop(), prev = f.id ? s.orders[f.id] : null;
    if (f.pay.kind === 'deposit' && f.pay.paid === -1) { state.refusal = { problems: [{ msg: 'Type the deposit as an amount, like 10 or 12.50 - "about $28" can’t be added up.', fixes: [{ label: 'Change the deposit', act: 'focus', target: 'dep' }] }] }; keepPlace(draw); return; }
    var draft = { id: f.id, name: f.name, day: f.day, slot: f.slot, note: f.note, lines: formOrder().lines, pay: formPay() };
    var r = C.saveOrder(s, draft, { t: stamp(), now: now(), id: f.id || newOrderId() });
    if (!r.ok) { state.refusal = r; state.formOk = ''; keepPlace(draw); var box = $('#refusal'); if (box) reveal(box); say(r.msg); return; }
    commit(r.shop, true);
    var o = r.order;
    if (state.drafts) {
      state.drafts.booked++;
      nextDraft(no(o) + ' booked.');
      return;
    }
    state.form = null; state.refusal = null; state.day = o.day;
    go('board', function () { bookedSheet(o.id, Boolean(prev)); });
  }
  /** The booked sheet, opened after the route change that shows the board,
   *  so that change cannot close it. */
  function bookedSheet(id, edited) {
    var s = shop(), o = s.orders[id];
    if (!o) return;
    var text = C.confirmText(s, o);
    sheet('<h2>' + esc((edited ? 'Saved ' : 'Booked ') + no(o)) + '</h2><p>' + esc(o.name + ' · ' + C.dayLabel(o.day) + ', ' + C.slotSpan(s.setup, o.slot) + ' · ' + C.dueWord(o)) + '</p>' +
      '<p class="lab">The confirmation, to send them</p><pre class="sent-pre">' + esc(text) + '</pre>' +
      (state.demo ? '<p class="small muted">In the example this is shown, never sent.</p>' : '') +
      '<div class="btns" style="margin-top:12px">' + (state.demo ? '' : '<button class="btn" type="button" data-act="sendconfirm" data-id="' + esc(o.id) + '">Share the confirmation</button>') + '<button class="btn ghost" type="button" data-act="neworder">Take another order</button><button class="btn ghost" type="button" data-act="closesheet">Done</button></div>');
  }
  function editOrder(id) {
    var o = shop().orders[id];
    if (!o) return;
    state.drafts = null; state.form = formFromOrder(o); state.refusal = null; state.formOk = '';
    go('order');
  }

  /* ---------------- drafts from the order slip ---------------- */

  function formFromDraft(d) {
    var lines = {};
    d.lines.forEach(function (l) { lines[l.item] = l.qty; });
    return { id: null, name: d.name, lines: lines, day: d.day, slot: d.slot, note: d.note, pay: { kind: d.pay.kind, paid: d.pay.kind === 'deposit' ? d.pay.paid : null, how: d.pay.how || 'card' }, unsure: d.unsure.slice(), draft: d };
  }
  function startDrafts(list, example) {
    closeSheet(true);
    state.drafts = { list: list, i: 0, example: example, booked: 0 };
    state.form = formFromDraft(list[0]); state.refusal = null; state.formOk = '';
    go('order');
  }
  function nextDraft(msg) {
    var dr = state.drafts;
    dr.i++;
    if (dr.i >= dr.list.length) {
      var booked = dr.booked;
      state.drafts = null; state.form = null; state.refusal = null;
      go('board', function () { toast((msg ? msg + ' ' : '') + 'That was the last draft: ' + plural(booked, 'order') + ' booked from the slip.', 4200); });
      return;
    }
    state.form = formFromDraft(dr.list[dr.i]); state.refusal = null; state.formOk = '';
    keepPlace(draw); scrollTo(0, 0);
    if (msg) toast(msg + ' Next draft.');
  }

  /* ---------------- the bake list ---------------- */

  function bakeHtml() {
    var s = shop(), d = state.bakeDay, bl = C.bakeList(s, d), hours = C.byHour(s, d);
    var rows = bl.rows.map(function (r) {
      var it = C.itemOf(s, r.item);
      return '<div class="bakerow"><div class="bakehead"><b>' + esc(r.name) + '</b><span class="' + (r.allDone ? 'okline' : 'muted') + '">' + esc((r.allDone ? '✓ ' : '') + r.done + ' of ' + r.qty + ' done · ready by ' + C.clock(r.first)) + '</span></div>' +
        '<div class="trays" role="group" aria-label="' + esc(r.name + ' trays') + '">' + r.trays.map(function (n, k) {
          var on = k < r.n, dots = '';
          for (var i = 0; i < Math.min(n, 12); i++) dots += '<i></i>';
          var cols = n <= 4 ? n : n <= 6 || n === 9 ? 3 : 4;
          return '<button class="tray" type="button" data-act="tray" data-item="' + esc(r.item) + '" data-k="' + esc(k) + '" aria-pressed="' + on + '" aria-label="' + esc('Tray ' + (k + 1) + ' of ' + r.trays.length + ': ' + C.qtyText(it, n) + (on ? ', done' : '')) + '"><span class="dots" style="grid-template-columns:repeat(' + esc(cols) + ', 9px)">' + dots + '</span><small>' + esc((k + 1) + ' · ' + n) + '</small></button>';
        }).join('') + '</div></div>';
    }).join('');
    var pct = bl.qty ? Math.round(100 * bl.done / bl.qty) : 0;
    var hourRows = hours.filter(function (h) { return h.orders; }).map(function (h) {
      return '<div class="hrow"><span class="hr">' + esc(h.label) + '</span><span class="hn">' + esc(plural(h.orders, 'pickup')) + '</span><ul>' + h.need.map(function (x) { var it = C.itemOf(s, x.item); return '<li>' + esc(C.qtyText(it, x.qty)) + ' <small>' + esc(x.by + ' by then') + '</small></li>'; }).join('') + '</ul></div>';
    }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('bake') +
      '<div class="sec-head"><h1>The bake list</h1><span class="muted">' + esc(C.longDay(d)) + '</span></div>' +
      dayTabsHtml(d, 'bakeday', function (x) { var b2 = C.bakeList(s, x); return b2.done + ' of ' + b2.qty + ' done'; }) +
      '<div class="two wide-left"><section class="card"><h2>' + esc('By the first pickup: ' + bl.done + ' of ' + bl.qty + ' done') + '</h2><div class="meter" aria-hidden="true"><i style="width:' + esc(pct) + '%"></i></div>' +
      '<p class="small muted" style="margin:8px 0 12px">' + esc(plural(bl.ticked, 'tray') + ' of ' + bl.trays + ' ticked. Each tray is one oven load - tap it when it comes out.') + '</p>' + (rows || '<p class="muted">Nothing booked for this day yet.</p>') + '</section>' +
      '<section class="card"><h2>Hour by hour</h2><p class="small muted">What each hour’s pickups need, and how many of each by then.</p>' + (hourRows ? '<div class="hours">' + hourRows + '</div>' : '<p class="muted">No pickups booked.</p>') +
      '<div class="btns" style="margin-top:12px"><div class="seg" role="group" aria-label="Paper">' + paperBtns() + '</div><button class="btn" type="button" data-act="printbake">Print the bake sheet</button></div></section></div></div>';
  }
  function paper() { return state.paper || state.device.paper || C.paperFor(LOCALE); }
  function paperBtns() { var p = paper(); return ['letter', 'a4'].map(function (k) { return '<button type="button" data-act="paper" data-v="' + esc(k) + '" aria-pressed="' + (p === k) + '">' + esc(C.SHEETS[k].name) + '</button>'; }).join(''); }
  function bakeSheetHtml(d, paperId) {
    var s = shop(), P = C.SHEETS[paperId], bl = C.bakeList(s, d), hours = C.byHour(s, d).filter(function (h) { return h.orders; });
    return '<div class="psheet bsheet" style="width:' + esc(P.w) + 'mm;height:' + esc(P.h) + 'mm"><div class="bs-in">' +
      '<div class="bs-head"><b>' + esc('Bake sheet · ' + C.longDay(d)) + '</b><span>' + esc((s.setup.name ? s.setup.name + ' · ' : '') + s.setup.event + ' · ' + bl.done + ' of ' + bl.qty + ' done') + '</span>' + (state.demo ? '<span class="bs-demo">Made-up example</span>' : '') + '</div>' +
      '<table class="bs-t"><thead><tr><th>Item</th><th>Needed</th><th>By</th><th>Trays - tick one per oven load</th></tr></thead><tbody>' + bl.rows.map(function (r) {
        return '<tr><td><b>' + esc(r.name) + '</b></td><td>' + esc(r.qty) + '</td><td>' + esc(C.clock(r.first)) + '</td><td>' + r.trays.map(function (n, k) { return '<span class="bs-box' + (k < r.n ? ' done' : '') + '"><small>' + esc(n) + '</small></span>'; }).join('') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<h3 class="bs-h">Hour by hour</h3><table class="bs-t"><thead><tr><th>Hour</th><th>Orders</th><th>Needs (and by then)</th></tr></thead><tbody>' + hours.map(function (h) {
        return '<tr><td>' + esc(h.label) + '</td><td>' + esc(h.orders) + '</td><td>' + esc(h.need.map(function (x) { return C.qtyText(C.itemOf(s, x.item), x.qty) + ' (' + x.by + ')'; }).join(', ')) + '</td></tr>';
      }).join('') + '</tbody></table><p class="bs-note">' + esc('A box is one oven load; the number under it is how many it holds. Made with Rush.') + '</p></div></div>';
  }

  /* ---------------- pickup day ---------------- */

  function pcardHtml(o, late) {
    var due = C.balance(o), s = shop();
    var cls = 'pcard' + (late ? ' late' : '') + (o.status === 'boxed' ? ' boxed' : '') + (o.status === 'picked' ? ' picked' : '');
    var btns = o.status === 'picked'
      ? '<p class="small muted" style="margin:0">' + esc('Picked up' + (o.got ? ' · ' + money(o.got.cents) + ' collected (' + C.HOW_WORD[o.got.how].toLowerCase() + ')' : '')) + '</p><button class="btn ghost" type="button" data-act="undo" data-id="' + esc(o.id) + '">Undo</button>'
      : (o.status === 'boxed' ? '<button class="btn ghost" type="button" data-act="unbox" data-id="' + esc(o.id) + '">Not boxed yet</button>' : '<button class="btn ghost" type="button" data-act="box" data-id="' + esc(o.id) + '">Boxed - ready</button>') +
        '<button class="btn" type="button" data-act="pick" data-id="' + esc(o.id) + '">Picked up</button>';
    var note = o.note ? (C.isAllergy(o.note) ? '<p class="allergy"><b>ALLERGY</b> ' + esc(o.note) + '</p>' : '<p class="pnote">' + esc(o.note) + '</p>') : '';
    return '<article class="' + cls + '"><div class="ph"><span class="pno">' + esc(no(o)) + '</span><span class="pname">' + esc(o.name) + '</span><span class="pdue' + (due ? '' : ' paid') + '">' + esc(due ? money(due) + ' due' : 'Paid') + '</span></div>' +
      '<div class="pmeta">' + esc(C.slotSpan(s.setup, o.slot) + ' · ' + (late ? 'Late · ' : '') + C.STATUS_WORD[o.status]) + '</div><ul class="pitems">' + itemsText(o).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' + note +
      '<div class="pbtns">' + btns + '</div></article>';
  }
  function pickupHtml() {
    var s = shop(), d = state.pickDay, n = now(), p = C.pickupLine(s, d, n, state.q), sm = p.summary;
    var cheer = '';
    if (sm.allDone && state.cheer === d) cheer = '<div class="cheer" role="status"><div class="conf" aria-hidden="true">' + (REDUCED.matches ? '' : Array.apply(null, Array(18)).map(function (_, i) { return '<i style="left:' + (i * 5.5 + 2) + '%;animation-delay:' + (i % 6) * 0.12 + 's"></i>'; }).join('')) + '</div><b>Every order for ' + esc(C.dayLabel(d)) + ' is picked up.</b><p style="margin:4px 0 0">The line is clear. Well done - put the kettle on.</p></div>';
    var group = function (title, list2, late, extra) {
      if (!list2.length) return '';
      return '<section class="pgroup' + (late ? ' late' : '') + '"><h2>' + esc(title) + '<span class="pill' + (late ? ' bad' : '') + '">' + esc(list2.length) + '</span>' + (extra || '') + '</h2><div class="pgrid">' + list2.map(function (o) { return pcardHtml(o, late); }).join('') + '</div></section>';
    };
    var isToday = n.d === d;
    var cur = isToday ? C.board(s, d, n).slots.filter(function (x) { return x.current; })[0] : null;
    var coming = p.coming.map(function (g) { return group('Coming up · ' + g.span, g.orders, false); }).join('');
    var picked = p.picked.length ? '<details class="card"><summary class="row spread" style="min-height:48px;cursor:pointer"><b>' + esc('Picked up (' + p.picked.length + ')') + '</b><span class="small muted">Tap to see them and undo</span></summary><div class="pgrid" style="margin-top:10px">' + p.picked.map(function (o) { return pcardHtml(o, false); }).join('') + '</div></details>' : '';
    var empty = !p.matched ? '<p class="muted">' + esc(state.q ? 'No order matches "' + state.q + '".' : 'No orders for this day.') + '</p>' : '';
    return '<div class="stack">' + demoRibbon() + guideHtml('pickup') +
      '<div class="sec-head"><h1>Pickup</h1><span class="muted">' + esc(C.longDay(d) + (isToday ? ' · now ' + C.clock(n.m) : d > n.d ? ' · coming up' : ' · passed')) + '</span></div>' +
      dayTabsHtml(d, 'pickday', function (x) { return C.wdLong(x); }) +
      '<div class="sumbar"><div class="sum"><b>' + esc(sm.picked + ' of ' + sm.total) + '</b><span>picked up</span></div><div class="sum"><b>' + esc(sm.toCome) + '</b><span>still to come</span></div><div class="sum"><b>' + esc(money(sm.collected)) + '</b><span>collected today</span></div><div class="sum"><b>' + esc(money(sm.due)) + '</b><span>still due</span></div></div>' +
      cheer + '<label class="field"><span>Find an order</span><input class="input" type="search" id="pq" data-act-input="pq" value="' + esc(state.q) + '" placeholder="Name or order number" autocomplete="off"></label>' + empty +
      '<div class="pcols">' + group('Late', p.late, true) + group(cur ? 'Now · ' + C.slotSpan(s.setup, cur.key) : 'Now', p.now, false) + coming + '</div>' + picked +
      '<p class="small" data-sync></p></div>';
  }
  function pick(id) {
    var s = shop(), o = s.orders[id];
    if (!o) return;
    var due = C.balance(o);
    if (!due) { finishPick(id, ''); return; }
    sheet('<h2>' + esc('Collect ' + money(due) + ' from ' + o.name) + '</h2><p class="muted">' + esc(no(o) + ' · ' + itemsText(o).join(', ') + (o.pay.paid ? ' · ' + money(o.pay.paid) + ' paid when ordered' : '')) + '</p><p><b>How did they pay?</b></p>' +
      '<div class="howbtns">' + C.HOWS.map(function (h) { return '<button class="btn" type="button" data-act="collect" data-id="' + esc(id) + '" data-how="' + esc(h) + '">' + esc(C.HOW_WORD[h]) + '</button>'; }).join('') + '</div>' +
      '<p class="small muted" style="margin-top:10px">Rush only notes how - it takes no payments.</p><button class="btn ghost" type="button" data-act="closesheet">Not yet</button>');
  }
  function finishPick(id, how) {
    var r = C.pickUp(shop(), id, how, stamp());
    if (!r.ok) { toast(r.msg); return; }
    closeSheet(true);
    commit(r.shop, true);
    var o = r.order, d = o.day, sm = C.pickupLine(shop(), d, now(), '').summary;
    var cheered = state.demo ? state.demoCheered : state.device.cheered;
    if (sm.allDone && cheered.indexOf(d) < 0) { cheered.push(d); state.cheer = d; saveDevice(); }
    keepPlace(draw);
    toast(no(o) + ' picked up' + (o.got ? ' - ' + money(o.got.cents) + ' collected.' : '.'));
  }

  /* ---------------- box labels ---------------- */

  function labelList() {
    var L = state.labels, s = shop();
    if (L.scope === 'order') return C.labelsFor(s, { order: L.order });
    return C.labelsFor(s, { day: L.day, slot: L.scope === 'slot' ? L.slot : '' });
  }
  function labelSheetsHtml(paperId, previewOnly) {
    var pages = C.labelPages(labelList(), paperId, state.labels.start), P = C.SHEETS[paperId];
    if (previewOnly) pages = pages.slice(0, 1);
    return pages.map(function (page) {
      return '<div class="psheet lsheet" style="width:' + esc(P.w) + 'mm;height:' + esc(P.h) + 'mm">' + page.map(function (c) {
        var b = c.cell, l = c.label, pos = 'left:' + b.x.toFixed(2) + 'mm;top:' + b.y.toFixed(2) + 'mm;width:' + b.w.toFixed(2) + 'mm;height:' + b.h.toFixed(2) + 'mm';
        if (!l) return previewOnly ? '<div class="blab" style="' + esc(pos) + '"></div>' : '';
        var shown = l.items.slice(0, 3), more = l.items.length - shown.length;
        return '<div class="blab" style="' + esc(pos) + '"><div class="bl-top"><span class="bl-no">' + esc(l.no) + '</span><span class="bl-due">' + esc(l.due) + '</span></div>' +
          '<div><div class="bl-name">' + esc(l.name) + '</div><div class="bl-when">' + esc(l.day + ' · ' + l.slot) + '</div></div>' +
          '<div class="bl-items">' + esc(shown.join(' · ') + (more > 0 ? ' · +' + more + ' more' : '')) + '</div>' +
          (l.note ? '<div class="bl-note' + (l.allergy ? ' al' : '') + '">' + esc((l.allergy ? 'ALLERGY: ' : '') + l.note) + '</div>' : '<div></div>') + (state.demo ? '<span class="bl-demo">Made-up example</span>' : '') + '</div>';
      }).join('') + '</div>';
    }).join('');
  }
  function labelsHtml() {
    var s = shop(), L = state.labels, p = paper();
    if (!validDay(L.day)) L.day = state.day || pickDefault();
    var slotsOf = C.board(s, L.day).slots.filter(function (x) { return x.n; });
    if (L.scope === 'slot' && !slotsOf.some(function (x) { return x.key === L.slot; })) L.slot = slotsOf[0] ? slotsOf[0].key : '';
    var live = C.liveOrders(s).sort(C.byPlace);
    if (L.scope === 'order' && !s.orders[L.order]) L.order = live[0] ? live[0].id : '';
    var labels = labelList(), pages = C.labelPages(labels, p, L.start);
    var starts = '';
    for (var i = 1; i <= 10; i++) starts += '<button type="button" data-act="lstart" data-v="' + esc(i) + '" aria-pressed="' + (L.start === i) + '"' + (i < L.start ? ' class="used"' : '') + ' aria-label="' + esc('Start at label ' + i) + '">' + esc(i) + '</button>';
    var pick2 = L.scope === 'order'
      ? '<label class="field"><span>Order</span><select class="input" data-lset="order">' + live.map(function (o) { return '<option value="' + esc(o.id) + '"' + (o.id === L.order ? ' selected' : '') + '>' + esc(no(o) + ' · ' + o.name) + '</option>'; }).join('') + '</select></label>'
      : dayTabsHtml(L.day, 'lday') + (L.scope === 'slot' ? '<label class="field" style="margin-top:8px"><span>Slot</span><select class="input" data-lset="slot">' + slotsOf.map(function (x) { return '<option value="' + esc(x.key) + '"' + (x.key === L.slot ? ' selected' : '') + '>' + esc(C.slotSpan(s.setup, x.key) + ' · ' + plural(x.n, 'order')) + '</option>'; }).join('') + '</select></label>' : '');
    return '<div class="stack">' + demoRibbon() + guideHtml('labels') +
      '<div class="sec-head"><h1>Box labels</h1><span class="muted">' + esc(C.SHEETS[p].desc) + '</span></div>' +
      '<div class="two"><section class="card"><div class="field"><span>Labels for</span><div class="seg" role="group" aria-label="Labels for">' + [['day', 'A day'], ['slot', 'A slot'], ['order', 'One order']].map(function (x) { return '<button type="button" data-act="lscope" data-v="' + esc(x[0]) + '" aria-pressed="' + (L.scope === x[0]) + '">' + esc(x[1]) + '</button>'; }).join('') + '</div></div>' +
      '<div style="margin-top:10px">' + pick2 + '</div>' +
      '<div class="field" style="margin-top:12px"><span>Label stock</span><div class="seg" role="group" aria-label="Label stock">' + ['letter', 'a4'].map(function (k) { return '<button type="button" data-act="paper" data-v="' + esc(k) + '" aria-pressed="' + (p === k) + '">' + esc(C.SHEETS[k].desc) + '</button>'; }).join('') + '</div></div>' +
      '<div class="field" style="margin-top:12px"><span>Start at label - for a part-used sheet</span><div class="starts" role="group" aria-label="Start at label">' + starts + '</div><small>' + esc(L.start > 2 ? 'Labels 1 to ' + (L.start - 1) + ' are skipped on the first sheet.' : L.start === 2 ? 'Label 1 is skipped on the first sheet.' : 'A fresh sheet.') + '</small></div>' +
      '<p class="note small" style="margin-top:12px"><b>Print at 100%</b> (actual size) - not "fit to page" - or the labels will not line up with the sheet.</p>' +
      '<div class="btns"><button class="btn big" type="button" data-act="printlabels"' + (labels.length ? '' : ' disabled') + '>' + esc('Print ' + plural(labels.length, 'label') + ' · ' + plural(pages.length, 'sheet')) + '</button></div></section>' +
      '<section class="card"><h2>The first sheet</h2><div class="preview" data-fit><div class="scaler">' + (labels.length ? labelSheetsHtml(p, true) : '') + '</div></div>' + (labels.length ? '' : '<p class="muted">No orders here yet.</p>') + '</section></div></div>';
  }
  function fitPreviews() {
    $$('[data-fit]').forEach(function (box) {
      var sc = $('.scaler', box), sh = $('.psheet', box);
      if (!sc || !sh) { box.style.height = '0px'; return; }
      var k = Math.min(1, (box.clientWidth - 2) / sh.offsetWidth);
      sc.style.transform = 'scale(' + k + ')';
      box.style.height = Math.ceil(sh.offsetHeight * k + 4) + 'px';
    });
  }
  function doPrint(html, title, paperId) {
    var style = $('#pageStyle');
    if (!style) { style = document.createElement('style'); style.id = 'pageStyle'; document.head.appendChild(style); }
    style.textContent = '@page { size: ' + C.SHEETS[paperId].css + ' portrait; margin: 0; }';
    $('#print').innerHTML = html;
    var t = document.title;
    document.title = title;
    setTimeout(function () { try { window.print(); } catch (e) { /* the page still holds them */ } document.title = t; }, 60);
  }

  /* ---------------- the money ---------------- */

  function moneyHtml() {
    var s = shop(), m = C.moneyOf(s);
    var csv = C.csv(s);
    return '<div class="stack">' + demoRibbon() +
      '<div class="sec-head"><h1>The money</h1><span class="muted">' + esc(s.setup.event + ' · ' + plural(m.orders, 'order')) + '</span></div>' +
      '<div class="mgrid"><div class="sum"><b>' + esc(money(m.ordered)) + '</b><span>ordered</span></div><div class="sum"><b>' + esc(money(m.paidWhenOrdered)) + '</b><span>paid when ordered</span></div><div class="sum"><b>' + esc(money(m.collected)) + '</b><span>collected at pickup</span></div><div class="sum"><b>' + esc(money(m.due)) + '</b><span>still due</span></div></div>' +
      '<div class="two"><section class="card"><h2>How they paid</h2><ul class="plainlist"><li>' + esc(plural(m.byPay.deposit, 'deposit')) + '</li><li>' + esc(plural(m.byPay.full, 'order') + ' paid in full') + '</li><li>' + esc(plural(m.byPay.pickup, 'order') + ' to pay at pickup') + '</li></ul>' +
      '<p class="small muted" style="margin-top:10px">' + esc(m.cancelled.n ? plural(m.cancelled.n, 'cancelled order is', 'cancelled orders are') + ' left out of these totals (' + m.cancelled.nos.join(', ') + ') - ' + (m.cancelled.paid ? money(m.cancelled.paid) + ' was paid on ' + (m.cancelled.n === 1 ? 'it' : 'them') + ', to give back or keep.' : 'nothing was paid on ' + (m.cancelled.n === 1 ? 'it' : 'them') + '.') : 'No cancelled orders.') + '</p></section>' +
      '<section class="card"><h2>By item</h2><div class="tablewrap"><table class="t"><thead><tr><th>Item</th><th>Ordered</th><th class="r">Total</th></tr></thead><tbody>' + m.items.map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.text) + '</td><td class="r">' + esc(money(x.total)) + '</td></tr>'; }).join('') +
      '<tr class="tot"><td>All items</td><td></td><td class="r">' + esc(money(m.ordered)) + '</td></tr></tbody></table></div></section></div>' +
      '<section class="card"><h2>Export the orders</h2><p class="small muted">A CSV built on this phone, for a spreadsheet - every cell that would start a formula gets a quote first, so nothing in it runs.</p>' +
      (state.demo ? '<p class="small muted">In the example the CSV is shown, never downloaded.</p><pre class="csvpre" tabindex="0" aria-label="The CSV">' + esc(csv) + '</pre>' :
        '<div class="btns"><button class="btn" type="button" data-act="csv">Download the CSV</button><button class="btn ghost" type="button" data-act="csvshow">' + (state.csv ? 'Hide it' : 'Show it here') + '</button></div>' + (state.csv ? '<pre class="csvpre" tabindex="0" style="margin-top:10px">' + esc(csv) + '</pre>' : '')) + '</section></div>';
  }

  /* ---------------- share texts ---------------- */

  function shareHtml() {
    var s = shop(), live = C.liveOrders(s).sort(function (a, b) { return a.no - b.no; }), sh = state.share;
    if (!s.orders[sh.order] || s.orders[sh.order].status === 'cancelled') { sh.order = live[0] ? live[0].id : ''; sh.a = null; }
    var o = s.orders[sh.order];
    if (sh.a === null && o) sh.a = C.confirmText(s, o);
    if (sh.b === null) sh.b = C.menuText(s);
    var btn = function (which) { return state.demo ? '' : '<div class="btns" style="margin-top:8px"><button class="btn" type="button" data-act="sharetext" data-v="' + which + '">Share</button><button class="btn ghost" type="button" data-act="copytext" data-v="' + which + '">Copy</button></div>'; };
    return '<div class="stack">' + demoRibbon() +
      '<div class="sec-head"><h1>Share</h1><span class="muted small">Plain text, through your phone’s share sheet. Never a link.</span></div>' +
      (state.demo ? '<p class="note small">In the example these are shown, never shared.</p>' : '') +
      '<div class="two"><section class="card"><h2>An order confirmation</h2>' + (live.length ? '<label class="field"><span>Order</span><select class="input" data-shset="order">' + live.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === sh.order ? ' selected' : '') + '>' + esc(no(x) + ' · ' + x.name) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field" style="margin-top:10px"><span>The text - change anything</span><textarea class="input" rows="5" data-shset="a">' + esc(sh.a) + '</textarea></label>' + btn('a') : '<p class="muted">No orders yet.</p>') + '</section>' +
      '<section class="card"><h2>What we’re taking orders for</h2><label class="field"><span>The text - change anything</span><textarea class="input" rows="14" data-shset="b">' + esc(sh.b) + '</textarea></label>' + btn('b') +
      '<button class="link-btn" type="button" data-act="sharereset">Write it again from the menu</button></section></div>' +
      '<p class="small muted">Rush has no customer page or order form - customers order with you, the way they always have.</p></div>';
  }

  /* ---------------- all orders ---------------- */

  function ordersHtml() {
    var s = shop(), f = state.ofilter;
    var all = C.allOrders(s).sort(C.byPlace).filter(function (o) { return f === 'all' ? o.status !== 'cancelled' : f === 'cancelled' ? o.status === 'cancelled' : o.day === f && o.status !== 'cancelled'; });
    var shown = C.search(s, all, state.oq);
    var chips = [['all', 'All']].concat(s.setup.days.map(function (d) { return [d.d, C.dayLabel(d.d)]; })).concat([['cancelled', 'Cancelled']]);
    return '<div class="stack narrow">' + demoRibbon() +
      '<div class="sec-head"><h1>All orders</h1><span class="muted">' + esc(plural(shown.length, 'order')) + '</span></div>' +
      '<div class="chips" role="group" aria-label="Show">' + chips.map(function (c) { return '<button class="chip" type="button" data-act="ofilter" data-v="' + esc(c[0]) + '" aria-pressed="' + (f === c[0]) + '">' + esc(c[1]) + '</button>'; }).join('') + '</div>' +
      '<label class="field"><span>Find an order</span><input class="input" type="search" id="oq" data-act-input="oq" value="' + esc(state.oq) + '" placeholder="Name or order number" autocomplete="off"></label>' +
      '<div id="restoreMsg"></div><section class="card">' + (shown.length ? shown.map(function (o) {
        var b = o.status === 'cancelled' ? '<button class="btn small" type="button" data-act="restore" data-id="' + esc(o.id) + '">Restore</button>'
          : '<button class="btn small ghost" type="button" data-act="edit" data-id="' + esc(o.id) + '">Edit</button>' + (o.status === 'picked' ? '' : '<button class="btn small ghost" type="button" data-act="cancelorder" data-id="' + esc(o.id) + '">Cancel</button>');
        return orderLineHtml(o, { when: true, buttons: b });
      }).join('') : '<p class="muted">Nothing here.</p>') + '</section><p class="small muted">A cancelled order keeps its number and stays here; it frees its place and its items. Restoring it goes through the caps again.</p></div>';
  }
  function cancelOrder(id) {
    var o = shop().orders[id];
    if (!o || !confirm('Cancel ' + no(o) + ' for ' + o.name + '? It stays in the history with its number' + (o.pay.paid ? ' - ' + money(o.pay.paid) + ' was paid on it.' : '.'))) return;
    var r = C.cancelOrder(shop(), id, stamp());
    if (!r.ok) { toast(r.msg); return; }
    commit(r.shop, true);
    if (state.view === 'order') { state.form = null; go('orders'); } else keepPlace(draw);
    toast(no(o) + ' cancelled - its place is free.');
  }
  function restore(id) {
    var r = C.restoreOrder(shop(), id, { t: stamp(), now: now() });
    if (!r.ok) {
      var box = $('#restoreMsg'), o = shop().orders[id];
      if (box) { box.innerHTML = '<div class="refuse" role="alert"><p>' + esc(no(o) + ': ' + r.msg) + '</p><div class="btns"><button class="btn small" type="button" data-act="edit" data-id="' + esc(id) + '">' + esc('Change ' + no(o) + ' first') + '</button></div></div>'; reveal(box); }
      return;
    }
    commit(r.shop);
    toast(no(r.order) + ' is back.');
  }

  /* ---------------- more ---------------- */

  function moreHtml() {
    var s = shop();
    return '<div class="stack narrow">' + demoRibbon() + '<div class="sec-head"><h1>' + esc(s.setup.name || 'Your shop') + '</h1><span class="muted small">' + esc(s.setup.event + ' · ' + s.setup.days.map(function (d) { return C.dayLabel(d.d); }).join(', ')) + '</span></div>' +
      '<div class="morelist">' +
      '<button class="morebtn" type="button" data-act="tab" data-tab="orders"><b>All orders</b><span>Find, edit, cancel and restore</span></button>' +
      '<button class="morebtn" type="button" data-act="tab" data-tab="labels"><b>Box labels</b><span>2 x 4 in on Letter, or 99 x 57 mm on A4</span></button>' +
      '<button class="morebtn" type="button" data-act="tab" data-tab="money"><b>The money</b><span>Ordered, paid, collected, still due - and the CSV</span></button>' +
      '<button class="morebtn" type="button" data-act="tab" data-tab="share"><b>Share</b><span>A confirmation, and what you are taking orders for</span></button>' +
      '<button class="morebtn" type="button" data-act="slip"><b>Read an order slip</b><span>AI reads a paper pad into drafts you check</span></button>' +
      '<button class="morebtn" type="button" data-act="editsetup"><b>Setup</b><span>The event, pickup days and hours, slots, deposit, the menu</span></button>' +
      (state.demo ? '<button class="morebtn" type="button" data-act="leavedemo"><b>Leave the example</b><span>Nothing from it is kept</span></button>' : '<button class="morebtn" type="button" data-act="demo"><b>See the example</b><span>Larkmoor Bakehouse, made up</span></button>') +
      '</div><p class="small" data-sync></p>' +
      (state.demo ? '' : '<p class="small muted">Everything here is on this phone. <button class="link-btn" type="button" data-act="forgetshop">Remove the shop from this phone</button></p>') + '</div>';
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

  /* ---------------- the AI: "Read the order slip" ---------------- */

  var WHY_AI = 'Reading a slip uses a little AI credit, so it needs a free account (it comes with $2).';
  var SENT_LINE = 'What is sent: this photo, shrunk on your phone, and nothing else but your menu’s item names.';
  /** The photo, shrunk to 1600 px through a canvas (EXIF and location gone),
   *  as a JPEG. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.addEventListener('load', function () {
        try {
          var k = Math.min(1, C.LIMITS.aiImageSide / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          var g = cv.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
          var q = 0.85, url2 = cv.toDataURL('image/jpeg', q);
          while (url2.length * 0.75 > 2 * 1024 * 1024 && q > 0.45) { q -= 0.1; url2 = cv.toDataURL('image/jpeg', q); }
          URL.revokeObjectURL(url);
          resolve({ url: url2, w: w, h: h, kb: Math.round(url2.split(',')[1].length * 0.75 / 1024) });
        } catch (e) { reject(e); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That file could not be read as a photo.')); });
      img.src = url;
    });
  }
  function slipBody(photo) { return { image: { type: 'image/jpeg', data: photo.url.split(',')[1] }, menu: C.slipMenu(shop()) }; }
  function openSlip() {
    var s = shop(), names = C.slipMenu(s).map(function (m) { return m.name; });
    var intro = '<h2>📷 Read the order slip</h2><p>Take a photo of a paper order pad or slip. AI reads each order into a draft you check and book - nothing is booked on its own.</p>';
    if (state.demo) {
      sheet(intro + '<p class="ai-label">Made-up example</p>' + D.padSvg() +
        '<p class="small muted">A made-up phone-order pad. Its reading below was written in advance and goes through the same checks as a real one - nothing is sent.</p>' +
        '<div class="btns"><button class="btn" type="button" data-act="slipexample">See the example reading</button></div>');
      return;
    }
    if (!signedIn()) {
      sheet(intro + '<div class="note"><p style="margin:0">' + esc(WHY_AI) + ' One account works across every app on this site. Everything else in Rush stays free with no account.</p></div>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="aijoin">Create a free account</button><button class="btn ghost" type="button" data-act="slipdemo">See the example first</button></div>');
      return;
    }
    var p = state.slip;
    sheet(intro + '<label class="btn ghost" style="position:relative;overflow:hidden">' + (p ? 'Choose another photo' : 'Choose or take a photo') + '<input type="file" accept="image/*" capture="environment" data-slipfile="1" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>' +
      (p ? '<p class="sentline"><b>' + esc(SENT_LINE) + '</b></p><img class="slipimg" alt="The photo that will be sent" src="' + esc(p.url) + '"><p class="small muted">' + esc('This exact JPEG: ' + p.w + ' x ' + p.h + ' px, ' + p.kb + ' KB - and nothing else but your menu’s item names:') + '</p><ul class="namelist">' + names.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' +
        '<p class="small muted">Never your shop’s name, a customer or an order. The photo is read once and not kept.</p><div id="slipErr"></div><div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="slipsend">Send and read it</button><span class="small muted">' + esc('About a cent' + (state.me.tier === 'paid' ? ' (member model)' : '') + '.') + '</span></div>' : '<p class="small muted">The photo is shrunk on this phone first - the location and camera details go - and you see exactly what is sent before you send it.</p>'));
  }
  function slipSend(btn) {
    var p = state.slip;
    if (!p) return;
    var sent = slipBody(p);
    btn.disabled = true; btn.textContent = 'Reading…';
    api('POST', 'api/ai/slip', sent).then(function (res) {
      loadMe();
      var drafts = C.slipDrafts(shop(), res.orders, { now: now() });
      state.slip = null;
      if (res.dropped) toast(plural(res.dropped, 'reading') + ' did not pass the checks and ' + (res.dropped === 1 ? 'was' : 'were') + ' left out.', 4200);
      startDrafts(drafts, false);
    }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send and read it'; meteredError(err, $('#slipErr'), openSlip, WHY_AI); });
  }
  function slipExample() {
    var req = C.slipRequest({ image: { type: 'image/jpeg', data: 'ZXhhbXBsZSBvbmx5IC0gbmV2ZXIgc2VudA==' }, menu: D.SLIP_MENU }).req;
    var out = C.cleanAiSlip(D.SLIP_RAW, req);
    startDrafts(C.slipDrafts(shop(), out.orders, { now: now() }), true);
  }

  /* ---------------- the account (shared shape with the lab) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }
  var FREE_LINE = 'Rush is free with no account, and everything stays on this phone. A free account keeps two phones at the counter in step and adds reading a paper order slip with AI - it comes with $2 of AI credit, and one account works across every app on this site.';
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
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Reading a slip costs about a cent. Slots, orders, the bake list, pickup, labels and the money are free and stay on this phone.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my shop from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your shop from the account? This phone keeps its copy.')) return;
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Typing orders in, the slots, the bake list, pickup and everything else keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  function sdSet(fn) { fn(state.setupDraft); state.setupMsg = ''; keepPlace(draw); }
  function formSet(fn) { fn(state.form); recheckSoft(); keepPlace(draw); }
  /** After a change in the form, a refusal that no longer holds goes away. */
  function recheckSoft() { if (state.refusal) recheck(); else state.formOk = ''; }
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id'), dday = el.getAttribute('data-day'), v = el.getAttribute('data-v');
    switch (act) {
      case 'home': e.preventDefault(); if (state.demo) go('board'); else go(state.shop ? 'board' : 'start'); break;
      case 'tab': closeSheet(true); if (el.getAttribute('data-tab') === 'order') { state.drafts = null; state.form = null; } go(el.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'leavedemo': leaveDemo(); break;
      case 'tour': tourStep(Number(el.getAttribute('data-step')) || 1); break;
      case 'tourdo': tourDo(Number(el.getAttribute('data-step'))); break;
      case 'tourdone': closeSheet(true); leaveDemo(); startSetup(); break;
      case 'new': startSetup(); break;
      case 'editsetup': state.setupDraft = setupDraftOf(shop()); state.setupMsg = ''; go('setup'); break;
      case 'event': sdSet(function (sd) { sd.ev = v; if (v !== 'own') sd.setup.event = v; else if (C.EVENTS.indexOf(sd.setup.event) >= 0) sd.setup.event = ''; }); break;
      case 'addday': sdSet(function (sd) { var ds = sd.setup.days, last = ds[ds.length - 1]; if (ds.length < C.LIMITS.days) ds.push({ d: last ? C.addDays(last.d, 1) : today(), open: last ? last.open : '10:00', close: last ? last.close : '17:00' }); }); break;
      case 'rmday': sdSet(function (sd) { if (sd.setup.days.length > 1) sd.setup.days.splice(Number(el.getAttribute('data-i')), 1); }); break;
      case 'slotmin': sdSet(function (sd) { sd.setup.slotMin = Number(v); }); break;
      case 'perslot': sdSet(function (sd) { sd.setup.perSlot = Math.max(1, Math.min(C.LIMITS.perSlot, sd.setup.perSlot + Number(el.getAttribute('data-d')))); }); break;
      case 'deposit': sdSet(function (sd) { sd.setup.deposit.mode = v; }); break;
      case 'starter': {
        var sd0 = state.setupDraft, have = Object.keys(sd0.items).filter(function (k) { return !sd0.items[k].del; }).length, items = C.STARTERS[v].items;
        if (have + items.length > C.LIMITS.items) { toast('The menu holds up to ' + C.LIMITS.items + ' items.'); break; }
        if (have && !confirm('Add the ' + items.length + ' items of "' + C.STARTERS[v].label + '" to your menu?')) break;
        sdSet(function (sd) { var ids = items.map(function () { return newItemId(); }); C.starterItems(v, ids, stamp()).forEach(function (it, i) { it.pos = have + i; sd.items[it.id] = it; }); sd.open = ''; });
        break;
      }
      case 'iadd': sdSet(function (sd) { var nid = newItemId(), n = Object.keys(sd.items).length; sd.items[nid] = { id: nid, name: '', unit: 'each', price: 0, batch: 6, cap: null, off: false, del: false, pos: n, t: stamp() }; sd.open = nid; }); setTimeout(function () { var f = $('#medit input'); if (f) f.focus(); }, 30); break;
      case 'iedit': sdSet(function (sd) { sd.open = id; }); break;
      case 'idone': sdSet(function (sd) { sd.open = ''; }); break;
      case 'idel': {
        var sd1 = state.setupDraft, it1 = sd1.items[id], users = shop() ? C.liveOrders(shop()).filter(function (o) { return o.lines.some(function (l) { return l.item === id; }); }).length : 0;
        if (users) { if (confirm(plural(users, 'order') + ' still ' + (users === 1 ? 'has' : 'have') + ' ' + it1.name + '. Stop taking new orders for it instead?')) sdSet(function (sd) { sd.items[id].off = true; sd.open = ''; }); break; }
        sdSet(function (sd) { if (shop() && shop().items[id]) sd.items[id].del = true; else delete sd.items[id]; sd.open = ''; });
        break;
      }
      case 'savesetup': saveSetup(); break;
      case 'bday': state.day = dday; keepPlace(draw); break;
      case 'slot': openSlot(dday, el.getAttribute('data-slot')); break;
      case 'takeat': closeSheet(true); state.drafts = null; state.form = blankForm(dday, el.getAttribute('data-slot')); state.refusal = null; go('order'); break;
      case 'neworder': closeSheet(true); state.drafts = null; state.form = blankForm(); state.refusal = null; go('order'); break;
      case 'edit': closeSheet(true); editOrder(id); break;
      case 'qty': formSet(function (f) { var k = el.getAttribute('data-item'); f.lines[k] = Math.max(0, Math.min(C.LIMITS.qty, (f.lines[k] || 0) + Number(el.getAttribute('data-d')))); if (!f.lines[k]) delete f.lines[k]; f.unsure = f.unsure.filter(function (u) { return u !== 'items'; }); }); break;
      case 'fday': formSet(function (f) { if (f.day !== dday) { f.day = dday; var k = C.slotOf(shop().setup, dday, f.slot) ? f.slot : ''; f.slot = C.nearestSlot(shop(), dday, k || f.slot, { now: now(), except: f.id }) || k; } f.unsure = f.unsure.filter(function (u) { return u !== 'day'; }); }); break;
      case 'pickslot': formSet(function (f) { f.slot = el.getAttribute('data-slot'); f.unsure = f.unsure.filter(function (u) { return u !== 'time'; }); }); break;
      case 'paykind': formSet(function (f) { f.pay.kind = v; f.pay.paid = null; f.unsure = f.unsure.filter(function (u) { return u !== 'paid'; }); }); break;
      case 'payhow': formSet(function (f) { f.pay.how = v; }); break;
      case 'fix': applyFix(Number(el.getAttribute('data-p')), Number(el.getAttribute('data-f'))); break;
      case 'book': book(); break;
      case 'skipdraft': nextDraft(''); break;
      case 'cancelorder': cancelOrder(id); break;
      case 'restore': restore(id); break;
      case 'shareone': state.share = { order: id, a: null, b: state.share.b }; go('share'); break;
      case 'sendconfirm': { var oc = shop().orders[id]; if (oc) shareText('Your order', C.confirmText(shop(), oc), 'Copied the confirmation.'); break; }
      case 'bakeday': state.bakeDay = dday; keepPlace(draw); break;
      case 'tray': commit(C.tickTray(shop(), state.bakeDay, el.getAttribute('data-item'), Number(el.getAttribute('data-k')), stamp()).shop); break;
      case 'printbake': doPrint(bakeSheetHtml(state.bakeDay, paper()), 'Bake sheet - ' + C.dayLabel(state.bakeDay), paper()); break;
      case 'pickday': state.pickDay = dday; state.q = ''; keepPlace(draw); break;
      case 'box': case 'unbox': { var rb = C.setBoxed(shop(), id, act === 'box', stamp()); if (rb.ok) commit(rb.shop); else toast(rb.msg); break; }
      case 'pick': pick(id); break;
      case 'collect': finishPick(id, el.getAttribute('data-how')); break;
      case 'undo': { var ru = C.undoPickup(shop(), id, stamp()); if (ru.ok) { if (state.cheer === ru.order.day) state.cheer = ''; commit(ru.shop); toast(no(ru.order) + ' is back in the line' + (ru.order.status === 'boxed' ? ', boxed.' : '.')); } break; }
      case 'labelsday': closeSheet(true); state.labels.scope = 'day'; state.labels.day = dday; go('labels'); break;
      case 'labelsslot': closeSheet(true); state.labels = { scope: 'slot', day: dday, slot: el.getAttribute('data-slot'), order: '', start: state.labels.start }; go('labels'); break;
      case 'lscope': state.labels.scope = v; keepPlace(draw); break;
      case 'lday': state.labels.day = dday; keepPlace(draw); break;
      case 'lstart': state.labels.start = Number(v); keepPlace(draw); break;
      case 'paper': state.paper = v; if (!state.demo) { state.device.paper = v; saveDevice(); } keepPlace(draw); break;
      case 'printlabels': doPrint(labelSheetsHtml(paper(), false), 'Box labels', paper()); break;
      case 'csv': download('rush-orders-' + C.fold(shop().setup.event).replace(/\s+/g, '-') + '.csv', 'text/csv', C.csv(shop())); break;
      case 'csvshow': state.csv = !state.csv; keepPlace(draw); break;
      case 'sharetext': case 'copytext': {
        var txt = v === 'a' ? state.share.a : state.share.b, title = v === 'a' ? 'Your order' : shop().setup.event;
        var why = C.refuse(txt, 4000, false);
        if (why) { toast(why, 4200); break; }
        if (act === 'sharetext') shareText(title, txt, 'Copied.'); else copy(txt, 'Copied.');
        break;
      }
      case 'sharereset': state.share.b = null; keepPlace(draw); break;
      case 'ofilter': state.ofilter = v; keepPlace(draw); break;
      case 'slip': state.slip = null; openSlip(); break;
      case 'slipdemo': closeSheet(true); startDemo(); setTimeout(openSlip, 30); break;
      case 'slipexample': slipExample(); break;
      case 'slipsend': slipSend(el); break;
      case 'aijoin': openAccount(WHY_AI, openSlip); break;
      case 'flagmove': {
        var rm = C.moveOrder(shop(), id, dday, el.getAttribute('data-slot'), { t: stamp(), now: now() });
        if (!rm.ok) { toast(rm.msg, 4200); break; }
        commit(rm.shop, true);
        if (!$('#sheet').hidden && $('#mergeFlags')) $('#mergeFlags').innerHTML = flagsHtml('');
        keepPlace(draw);
        toast(no(rm.order) + ' moved to ' + C.dayLabel(rm.order.day) + ', ' + C.clock(C.mins(rm.order.slot)) + '.');
        break;
      }
      case 'forgetshop': if (confirm('Remove the shop and every order from this phone? ' + (signedIn() ? 'The account copy stays until you remove it in Account.' : 'This cannot be undone.'))) { state.shop = null; real.putShop(null); state.sync = { base: null, at: 0 }; saveSync(); go('start'); } break;
      case 'mergeok': state.mergeNote = null; closeSheet(true); keepPlace(draw); break;
      case 'signin': openAccount(); break;
      case 'retrysync': push(); break;
      case 'resync': push(null); break;
      case 'closesheet': closeSheet(); break;
      default: break;
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var sd = state.setupDraft;
    if (t.hasAttribute('data-sset') && sd) {
      var k = t.getAttribute('data-sset'), s = sd.setup;
      if (k === 'name') s.name = t.value;
      if (k === 'event') s.event = t.value;
      if (k === 'cutd') s.cutoff = t.value ? { d: t.value, t: s.cutoff ? s.cutoff.t : '18:00' } : null;
      if (k === 'cutt' && s.cutoff) s.cutoff.t = t.value;
      if (k === 'depc') { var c = C.parseMoney(t.value); if (c === null || c > C.LIMITS.depositMax) { toast('Type the deposit as an amount, like 10 or 12.50.'); } else s.deposit.cents = c; }
      if (k === 'depp') s.deposit.pct = Math.max(1, Math.min(100, Math.round(Number(t.value) || 25)));
      if (k !== 'name' && k !== 'event') keepPlace(draw);
      return;
    }
    if (t.hasAttribute('data-dset') && sd) {
      var day = sd.setup.days[Number(t.getAttribute('data-i'))];
      if (day) day[t.getAttribute('data-dset')] = t.value;
      keepPlace(draw);
      return;
    }
    if (t.hasAttribute('data-iset') && sd) {
      var it = sd.items[t.getAttribute('data-id')], f = t.getAttribute('data-iset');
      if (!it) return;
      if (f === 'price') { var p = C.parseMoney(t.value); if (p === null || p > C.LIMITS.priceMax) { toast('Type the price as an amount, like 30 or 12.50 - "about $28" can’t be added up.', 4200); t.value = it.price ? (it.price / 100).toFixed(2) : ''; } else it.price = p; }
      if (f === 'batch') it.batch = Math.max(1, Math.min(C.LIMITS.batchMax, Math.round(Number(t.value) || 1)));
      if (f === 'cap') it.cap = t.value === '' ? null : Math.max(1, Math.min(C.LIMITS.capMax, Math.round(Number(t.value) || 1)));
      if (f === 'off') it.off = t.checked;
      return;
    }
    if (t.hasAttribute('data-fset') && state.form && t.getAttribute('data-fset') === 'dep') {
      var cents = C.parseMoney(t.value);
      state.form.pay.paid = cents === null ? -1 : cents;
      if (cents === null) toast('Type the deposit as an amount, like 10 or 12.50 - "about $28" can’t be added up.', 4200);
      keepPlace(draw);
      return;
    }
    if (t.hasAttribute('data-lset')) { state.labels[t.getAttribute('data-lset')] = t.value; keepPlace(draw); return; }
    if (t.hasAttribute('data-shset')) {
      var sk = t.getAttribute('data-shset');
      if (sk === 'order') { state.share.order = t.value; state.share.a = null; keepPlace(draw); }
      return;
    }
    if (t.hasAttribute('data-slipfile')) {
      var file = t.files && t.files[0];
      t.value = '';
      if (!file) return;
      shrink(file).then(function (p2) { state.slip = p2; openSlip(); }).catch(function (er) { toast(er.message || 'That photo could not be read.'); });
    }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-fset') === 'name' && state.form) { state.form.name = t.value; state.form.unsure = state.form.unsure.filter(function (u) { return u !== 'name'; }); }
    if (t.getAttribute('data-fset') === 'note' && state.form) state.form.note = t.value;
    if (t.getAttribute('data-sset') === 'name' && state.setupDraft) state.setupDraft.setup.name = t.value;
    if (t.getAttribute('data-sset') === 'event' && state.setupDraft) state.setupDraft.setup.event = t.value;
    if (t.getAttribute('data-iset') === 'name' && state.setupDraft) { var it = state.setupDraft.items[t.getAttribute('data-id')]; if (it) it.name = t.value; }
    if (t.getAttribute('data-iset') === 'unit' && state.setupDraft) { var it2 = state.setupDraft.items[t.getAttribute('data-id')]; if (it2) it2.unit = t.value; }
    if (t.getAttribute('data-shset') === 'a') state.share.a = t.value;
    if (t.getAttribute('data-shset') === 'b') state.share.b = t.value;
    var q = t.getAttribute('data-act-input');
    if (q === 'pq' || q === 'oq') {
      if (q === 'pq') state.q = t.value; else state.oq = t.value;
      var pos = t.selectionStart;
      keepPlace(draw);
      var again = $('#' + q); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (er) { /* fine */ } }
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  });
  window.addEventListener('popstate', function () { route(); });
  window.addEventListener('resize', function () { if (state.view === 'labels' || state.view === 'bake') fitPreviews(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!state.demo && shop() && ['board', 'pickup'].indexOf(state.view) >= 0) keepPlace(draw);   // the clock has moved on
    if (signedIn()) syncIn();
  });
  // Every minute while in front: re-ask the account (two phones at one
  // counter), and redraw the board and the pickup line as the clock moves.
  setInterval(function () {
    if (document.visibilityState !== 'visible') return;
    if (signedIn()) syncIn();
    if (!state.demo && shop() && ['board', 'pickup'].indexOf(state.view) >= 0 && $('#sheet').hidden && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) keepPlace(draw);
  }, 60000);

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  drawTop();
  Promise.all([real.getShop(), real.getDevice(), real.getSync()]).then(function (r) {
    state.shop = r[0]; state.device = r[1]; state.sync = r[2];
  }).catch(function () { /* fresh */ }).then(function () {
    var h = (location.hash || '').replace(/^#/, '');
    if (h && ['board', 'bake', 'pickup', 'labels', 'money', 'share', 'orders', 'more'].indexOf(h) < 0) history.replaceState(null, '', BASE);
    route();
    return loadMe();
  }).then(function () { if (signedIn()) syncIn(); });
}());
