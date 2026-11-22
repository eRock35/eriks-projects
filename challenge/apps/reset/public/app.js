/* Reset - the page. One file, no build step.
 *
 * EVERYTHING HAPPENS ON THIS PHONE. Each loan - its nickname, its
 * rate-change terms and its current numbers - is worked out by ResetCore
 * (the new rate, which rule bound it, the payment in exact cents, the
 * working, future resets, the draft notice) and kept through
 * reset-store.js (IndexedDB, with a memory fallback). A batch CSV is
 * worked out in this tab and never kept. The made-up example is never
 * kept, sent or synced.
 *
 * The requests this page makes: sign-in, the account's copy of the book
 * (signed in, to keep two phones in step), and the one optional "Read the
 * note", whose body - one or two photos shrunk on this phone, or the pasted
 * rate-change section, and nothing else - is shown before it is sent.
 *
 * Every string a person typed, the server sent or a model wrote is escaped
 * before it is drawn, and no handler is written into markup: clicks,
 * changes and input are routed by data-* attributes from one listener each
 * (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.ResetCore;
  var D = window.ResetDemo;
  var RS = window.ResetStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural, R = C.fmtRate, M = C.fmtMoney;
  var REDUCED = (function () { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return { matches: false }; } }());

  var real = RS.create(RS.idb('reset'));

  var state = {
    me: null, view: 'start', book: null, demo: false, demoBook: null, device: RS.cleanDevice({}), sync: RS.cleanSync({}), syncState: 'local', syncErr: '',
    tour: 0, lid: null, draft: null, mergeNote: null, demoClock: 0, showPay: false, batch: null, batchText: '', noticeNick: false,
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
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Reset stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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

  /* ---------------- the book: this phone's, and the example ---------------- */

  function book() { return state.demo ? state.demoBook : state.book; }
  function loan(id) { var b = book(), L = b && b.loans[id]; if (!L || L.del) return null; var x = C.clone(L); x.id = id; return x; }
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
  function workOf(L) { try { return C.work(L); } catch (e) { return null; } }

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
    if (state.view === 'start') go('loans'); else keepPlace(draw);
  }
  /** The account's copy came back different: merge it into this phone's
   *  (each loan by its own time; a loan both phones changed keeps both),
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

  var VIEWS = ['start', 'loans', 'loan', 'edit', 'add', 'batch', 'more'];
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
    if (v === 'loan' && !(state.lid && loan(state.lid))) v = book() ? 'loans' : 'start';
    if (v === 'edit' && !state.draft) v = book() ? 'loans' : 'start';
    if (['loans', 'more'].indexOf(v) >= 0 && !book()) v = 'start';
    if (v === 'start' && book() && !state.demo && h === '') v = 'loans';
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
    var tab = state.view === 'loan' ? 'loans' : state.view === 'edit' ? (state.draft && state.draft.isNew ? 'add' : 'loans') : state.view;
    $$('#tabbar [data-tab]').forEach(function (x) { if (x.getAttribute('data-tab') === tab) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    var v = state.view, html;
    if (v === 'loans') html = loansHtml();
    else if (v === 'loan') html = loanHtml();
    else if (v === 'edit') html = editHtml();
    else if (v === 'batch') html = batchHtml();
    else if (v === 'more') html = moreHtml();
    else html = startHtml();
    main.innerHTML = html;
    document.body.classList.toggle('in-demo', state.demo);
    drawSync();
  }

  /* ---------------- the example and its tour ---------------- */

  var TOUR = [
    { view: 'loans', title: 'The book', body: 'Seven made-up loans at Quillmere Community Bank, each with its next rate change worked out: the new rate, the new payment and the rule that set it. Loans go by nickname only - never a borrower’s name or a loan number.', btn: 'Open Maple duplex 5/6', next: 'Next: which cap bit' },
    { view: 'loan', title: 'Which cap bit', body: 'Its first change: SOFR 4.300% + a 2.750% margin is 7.050%, rounded to the nearest ⅛ is 7.000% - but the first-change cap holds it to 3.250% + 2 = 5.250%. Every step is shown, and the payment is worked to the cent: $1,498.12.', btn: 'Show the payment working', next: 'Next: what if the index rises' },
    { view: 'loan', title: 'Future resets', body: 'Say SOFR rises ¼ point every six months: the 1-point periodic cap and the 8.250% lifetime cap play out reset by reset, with the balance paid down in exact cents between them.', btn: 'Index up ¼ point a reset', next: 'Next: the notice' },
    { view: 'loan', title: 'A draft notice', body: 'A plain-text draft of the change notice - old and new rate and payment, how the rate was set and which limit applied - with brackets for the borrower’s name and loan number, which Reset never keeps. A draft for a person to check, not legal advice.', btn: 'Draft the notice', next: 'Next: a whole batch' },
    { view: 'batch', title: 'A batch from CSV', body: 'Open or paste a CSV of loans: every row is worked out on this phone, or says what is wrong with it - a row named after a person is refused and never echoed. Export the results as a CSV.', btn: 'Work out the example CSV', next: 'Next: read the note' },
    { view: 'edit', title: 'Read the note', body: 'Photograph the note’s rate-change section, or paste it, and AI reads the terms into the form for you to check against the note. It has no field for a name, a loan number or an amount, and anything like that is dropped.', btn: 'Read the example note', next: 'Add my first loan' },
  ];
  var MAPLE = 'lmaple0001';
  function startDemo() {
    state.demo = true; state.demoBook = D.book(); state.demoClock = 0; state.tour = 1; state.mergeNote = null; state.draft = null; state.lid = null; state.batch = null; state.batchText = ''; state.showPay = false;
    go('loans');
  }
  function leaveDemo() {
    state.demo = false; state.demoBook = null; state.tour = 0; state.draft = null; state.lid = null; state.batch = null; state.batchText = ''; state.showPay = false;
    if (!state.device.tour) { state.device.tour = true; saveDevice(); }
    go(state.book ? 'loans' : 'start');
  }
  function tourStep(n) {
    if (n > TOUR.length) { leaveDemo(); go('add'); return; }
    state.tour = n;
    if (n >= 2 && n <= 4) state.lid = MAPLE;
    if (n === 6) state.draft = newDraft();
    go(TOUR[n - 1].view);
    if (n === 3) { var f = $('#future'); if (f) reveal(f); }
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
    if (n === 1) { state.lid = MAPLE; state.tour = 2; go('loan'); }
    if (n === 2) { state.showPay = true; keepPlace(draw); var p = $('#paywork'); if (p) reveal(p); }
    if (n === 3) { setWhat(MAPLE, { kind: 'step', by: 25000, list: [] }); var f = $('#future'); if (f) reveal(f); say('The index now rises a quarter point at each reset.'); }
    if (n === 4) openNotice();
    if (n === 5) { state.batchText = D.CSV; runBatch(); }
    if (n === 6) readExample();
  }

  /* ---------------- first run ---------------- */

  function heroArtHtml() {
    return '<div class="hero-art" aria-hidden="true"><div class="stepcard">' +
      '<div class="sr"><span>Index (SOFR)</span><span>4.300%</span></div><div class="sr"><span>+ Margin</span><span>2.750%</span></div>' +
      '<div class="sr"><span>Rounded to ⅛</span><span>7.000%</span></div><div class="sr bit"><span>First-change cap bit</span><span>5.250%</span></div>' +
      '<div class="sr"><span>New payment</span><span class="big">$1,498.12</span></div></div></div>';
  }
  function startHtml() {
    var has = Boolean(state.book);
    return '<div class="stack">' +
      '<section class="hero"><div><p class="kicker">📈 For servicing and loan accounting</p><h1>Every rate reset, worked out from the note.</h1>' +
      '<p>Index, margin, rounding, the first-change, periodic and lifetime caps, floor and ceiling - Reset works the new rate step by step, says which rule bit, and amortises the new payment in exact cents. A whole batch from a CSV, future resets under a what-if index, and a draft change notice to check.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the example</button>' +
      (has ? '<button class="btn big ghost" type="button" data-act="tab" data-tab="loans">My loans</button>' : '<button class="btn big ghost" type="button" data-act="tab" data-tab="add">Add a loan</button>') + '</div>' +
      '<p class="caps">Free · no sign-in · works offline · loans by nickname only</p></div>' + heroArtHtml() + '</section>' +
      '<section class="card"><h2>How it works</h2><div class="how4">' +
      '<div><h3>Type the terms once</h3><p>From the note’s rate-change section - or photograph it and let AI read the terms for you to check.</p></div>' +
      '<div><h3>See which rule bit</h3><p>Index + margin, rounding, each cap, the floor and the ceiling in order, with the working shown.</p></div>' +
      '<div><h3>The payment to the cent</h3><p>Amortised over the months left with exact arithmetic - no float drift, ever.</p></div>' +
      '<div><h3>Batch, what-if, notice</h3><p>A CSV of loans worked out on the phone, future resets under any index path, and a draft notice.</p></div>' +
      '</div></section>' +
      '<section class="card"><ul class="ticks"><li>No account needed - everything works signed out, on this phone.</li><li>Loans by nickname only: a borrower’s name, a tax id or an account number is refused.</li><li>The draft notice is a draft for a person to check against the note and the rules - not legal advice.</li></ul></section>' +
      '<p class="foot">Reset is a trial in the Challenge Lab.</p></div>';
  }

  /* ---------------- the book ---------------- */

  function ruleClass(b) { return ['first-change cap', 'periodic cap', 'lifetime cap', 'ceiling'].indexOf(b) >= 0 ? 'rule capped' : (b === 'floor' || b === 'zero') ? 'rule floored' : 'rule'; }
  function ruleChip(b) { return '<span class="' + ruleClass(b) + '">' + esc(C.RULE_LABEL[b]) + '</span>'; }
  function loansHtml() {
    var ls = C.liveLoans(book()), counts = {};
    var rows = ls.map(function (L) {
      var w = workOf(L);
      if (w) counts[w.bound] = (counts[w.bound] || 0) + 1;
      return '<li><button class="lrow" type="button" data-act="open" data-id="' + esc(L.id) + '"><span class="ln">' + esc(L.nick) + '</span>' +
        (w ? '<span class="lr"><span>' + esc(R(L.rate) + ' → ' + R(w.rate)) + '</span>' + ruleChip(w.bound) + '<span class="muted">' + esc(M(w.payment) + ' a month' + (L.date ? ' from ' + C.fmtDay(w.firstPayDay) : '')) + '</span></span>' : '<span class="err">These numbers do not work out - open it to check.</span>') +
        '</button></li>';
    }).join('');
    var chips = C.RULES.filter(function (k) { return counts[k]; }).map(function (k) { return '<span class="' + ruleClass(k) + '">' + esc(C.RULE_LABEL[k] + ' · ' + counts[k]) + '</span>'; }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('loans') + mergeNoteHtml() +
      '<section class="card"><div class="row spread"><h1 style="margin:0">' + esc(state.demo ? D.NAME : 'My loans') + '</h1><button class="btn small" type="button" data-act="tab" data-tab="add">Add a loan</button></div>' +
      '<p class="muted small" style="margin-top:6px">' + esc(plural(ls.length, 'loan')) + ' · the next change of each, worked out</p>' + (chips ? '<div class="rulecounts" aria-label="Which rule set each rate">' + chips + '</div>' : '') + '<p class="small" data-sync>' + syncLine() + '</p></section>' +
      (ls.length ? '<ul class="llist" style="list-style:none;padding:0;margin:0">' + rows + '</ul>' : '<section class="card"><p>No loans yet.</p><button class="btn" type="button" data-act="tab" data-tab="add">Add the first one</button></section>') +
      '</div>';
  }

  /* ---------------- one loan ---------------- */

  function loanHtml() {
    var L = loan(state.lid), w = workOf(L);
    if (!w) return '<div class="stack">' + demoRibbon() + '<section class="card"><h1>' + esc(L.nick) + '</h1><p class="err">These numbers do not work out. Edit the loan to check them.</p><button class="btn" type="button" data-act="edit" data-id="' + esc(L.id) + '">Edit</button></section></div>';
    var T = L.terms, ch = w.change;
    var steps = w.steps.map(function (s) { return '<li class="' + (s.moved ? 'moved' : '') + '">' + esc(s.text) + (s.moved && s.rule === w.bound ? '<span class="why">this one bit</span>' : '') + '</li>'; }).join('');
    var dates = L.date ? [['Change date', C.fmtDay(L.date)], ['Index as of', C.fmtDay(w.lookbackDay) + ' (' + T.lookback + ' days before)'], ['First new payment', C.fmtDay(w.firstPayDay)], ['Next change', C.fmtDay(w.nextChange)]] : [];
    dates.push(['Balance', M(L.bal)], ['Months left', String(L.months)], ['Index', T.name || 'Not named'], ['This change', L.first ? 'The first' : 'A later one']);
    return '<div class="stack">' + demoRibbon() + guideHtml('loan') +
      '<div class="row"><button class="btn small ghost" type="button" data-act="tab" data-tab="loans">← Loans</button></div>' +
      '<section class="card"><h1>' + esc(L.nick) + '</h1>' +
      '<div class="result"><div class="figure"><div class="fw">New rate</div><div class="fv">' + esc(R(w.rate)) + '</div><div class="fw">' + esc('was ' + R(L.rate) + (ch === 0 ? ', no change' : ', ' + (ch > 0 ? '+' : '−') + C.fmtPts(Math.abs(ch)))) + '</div></div>' +
      '<div class="figure"><div class="fw">New payment' + (T.io ? ' (interest only)' : '') + '</div><div class="fv">' + esc(M(w.payment)) + '</div><div class="fw">' + esc('was ' + M(w.paymentWas) + ' at ' + R(L.rate) + ' (' + (w.payment >= w.paymentWas ? '+' : '−') + M(Math.abs(w.payment - w.paymentWas)) + ')') + '</div></div></div>' +
      '<p class="bitline" style="margin-top:12px">' + ruleChip(w.bound) + ' ' + esc(C.boundSentence(w)) + '</p>' +
      '<dl class="dates" style="margin-top:12px">' + dates.map(function (d) { return '<div><dt>' + esc(d[0]) + '</dt><dd>' + esc(d[1]) + '</dd></div>'; }).join('') + '</dl>' +
      '<div class="btns" style="margin-top:14px"><button class="btn" type="button" data-act="notice">Draft the notice</button><button class="btn ghost" type="button" data-act="edit" data-id="' + esc(L.id) + '">Edit</button><button class="btn danger" type="button" data-act="remove" data-id="' + esc(L.id) + '">Remove</button></div></section>' +
      '<section class="card"><h2>The working</h2><ol class="working">' + steps + '</ol>' +
      '<details class="more" id="paywork"' + (state.showPay ? ' open' : '') + '><summary>The payment, worked to the cent</summary><ul class="paywork mono">' + w.paymentWorking.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details></section>' +
      '<section class="card" id="future"><h2>Future resets</h2><p class="small muted">What if the index moves? Each later change uses the periodic cap, the lifetime cap, the floor and the ceiling the same way, with the balance paid down in exact cents between changes. Caps never carry over.</p>' +
      whatControlsHtml(L) + '<div id="futureBox">' + futureHtml(L) + '</div></section>' +
      '</div>';
  }
  var WHAT = [['flat', 'Index stays'], ['up', 'Rises'], ['down', 'Falls'], ['list', 'My own path']];
  function whatMode(w) { return w.kind === 'step' ? (w.by >= 0 ? 'up' : 'down') : w.kind; }
  function whatControlsHtml(L) {
    var w = L.what || C.defaultWhat(), mode = whatMode(w);
    var seg = '<div class="seg" role="group" aria-label="What the index does">' + WHAT.map(function (m) { return '<button type="button" data-act="what" data-v="' + esc(m[0]) + '" aria-pressed="' + (mode === m[0]) + '">' + esc(m[1]) + '</button>'; }).join('') + '</div>';
    var extra = '';
    if (mode === 'up' || mode === 'down') extra = '<label class="field" style="margin-top:10px"><span>By how much at each reset (points)</span><input class="input" inputmode="decimal" data-what="by" value="' + esc(C.rateField(Math.abs(w.by))) + '"></label>';
    if (mode === 'list') extra = '<label class="field" style="margin-top:10px"><span>The index at each later reset, in order (percent, commas between; the last one holds)</span><input class="input" inputmode="decimal" data-what="list" value="' + esc(w.list.map(C.rateField).join(', ')) + '" placeholder="4.5, 4.75, 5, 5"></label>';
    return seg + extra + '<p class="err" id="whatErr" role="alert" hidden></p>';
  }
  function futureHtml(L) {
    var rows;
    try { rows = C.future(L, L.what || C.defaultWhat(), 12); } catch (e) { return '<p class="err">' + esc(e.message) + '</p>'; }
    var body = rows.map(function (r) {
      return '<tr><td>' + esc(r.k === 0 ? 'Now' : '+' + r.k) + '</td><td>' + esc(r.day ? C.fmtDay(r.day) : '-') + '</td><td>' + esc(R(r.index)) + '</td><td>' + esc(R(r.rate)) + '</td><td>' + esc(C.RULE_LABEL[r.bound]) + '</td><td>' + esc(M(r.payment)) + '</td><td>' + esc(M(r.balance)) + '</td><td>' + esc(String(r.months)) + '</td></tr>';
    }).join('');
    return futureChartHtml(L, rows) + '<div class="tablebox" tabindex="0" role="region" aria-label="Future resets"><table class="grid"><thead><tr><th>Reset</th><th>Date</th><th>Index</th><th>Rate</th><th>Set by</th><th>Payment</th><th>Balance</th><th>Months</th></tr></thead><tbody>' + body + '</tbody></table></div>';
  }
  /** The rate at each reset as a step line, with the lifetime limit and
   *  the floor dashed. Drawn from numbers this page worked out. */
  function futureChartHtml(L, rows) {
    var T = L.terms, hiLim = null;
    if (T.lifetimeCap !== null) hiLim = L.start + T.lifetimeCap;
    if (T.ceiling !== null) hiLim = hiLim === null ? T.ceiling : Math.min(hiLim, T.ceiling);
    var vals = rows.map(function (r) { return r.rate; }).concat([L.rate]);
    if (hiLim !== null) vals.push(hiLim);
    if (T.floor !== null) vals.push(T.floor);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi += C.PCT; lo = Math.max(0, lo - C.PCT); }
    var W = 600, H = 240, pl = 86, pr = 12, pt = 30, pb = 34;
    var x = function (i) { return pl + (W - pl - pr) * (rows.length > 1 ? i / (rows.length - 1) : 0.5); };
    var y = function (v) { return pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo)); };
    var d = 'M' + x(0) + ' ' + y(rows[0].rate);
    for (var i = 1; i < rows.length; i++) d += 'H' + x(i) + 'V' + y(rows[i].rate);
    var lim = function (v, label) { return v === null ? '' : '<line class="lim" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (W - pr) + '" y="' + (y(v) - 6) + '" text-anchor="end">' + esc(label + ' ' + R(v)) + '</text>'; };
    var dots = rows.map(function (r, j) { return '<circle class="dot" cx="' + x(j) + '" cy="' + y(r.rate) + '" r="4"/>'; }).join('');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('The rate at each reset, from ' + R(rows[0].rate) + ' to ' + R(rows[rows.length - 1].rate)) + '">' +
      '<line class="ax" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '"/>' +
      '<text x="' + (pl - 6) + '" y="' + (y(hi) + 4) + '" text-anchor="end">' + esc(R(hi)) + '</text><text x="' + (pl - 6) + '" y="' + (y(lo) + 4) + '" text-anchor="end">' + esc(R(lo)) + '</text>' +
      lim(hiLim, 'Most it can be') + lim(T.floor, 'Floor') + '<path class="ln" d="' + d + '"/>' + dots +
      '<text x="' + pl + '" y="' + (H - 6) + '">Now</text><text x="' + (W - pr) + '" y="' + (H - 6) + '" text-anchor="end">' + esc('+' + (rows.length - 1) + ' resets') + '</text></svg>';
  }
  function setWhat(id, what) {
    var b = book(), L = b.loans[id];
    if (!L || L.del) return;
    var x = C.clone(L); x.what = what;
    commit(C.putLoan(b, id, x, stamp()));
  }
  /** A what-if number typed: kept when it reads, the table redrawn in
   *  place so the field keeps the cursor. */
  function whatInput(el) {
    var L = loan(state.lid), w = C.clone(L.what || C.defaultWhat()), err = '';
    if (el.getAttribute('data-what') === 'by') {
      var r = C.parseRate(el.value, 'The step');
      if (r.error) err = r.error; else if (r.v > 5 * C.PCT) err = 'Up to 5 points a reset.'; else w.by = whatMode(w) === 'down' ? -r.v : r.v;
    } else {
      var parts = el.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean), list = [];
      if (parts.length > C.LIMITS.whatList) err = 'Up to ' + C.LIMITS.whatList + ' values.';
      parts.forEach(function (p) { var q = C.parseRate(p, 'An index value'); if (q.error) err = err || q.error; else list.push(q.v); });
      if (!err) w.list = list;
    }
    var e = $('#whatErr');
    if (e) { e.hidden = !err; e.textContent = err; }
    if (err) return;
    var b = book(), x = C.clone(b.loans[state.lid]); x.what = w;
    commit(C.putLoan(b, state.lid, x, stamp()), true);
    var box = $('#futureBox'); if (box) box.innerHTML = futureHtml(loan(state.lid));
  }

  /* ---------------- the notice ---------------- */

  function noticeFor(L) {
    var w = C.work(L);
    return C.noticeText(L, w, { lender: state.demo ? D.NAME : state.device.lender, withNick: state.noticeNick });
  }
  function openNotice() {
    var L = loan(state.lid);
    if (!L) return;
    var text = noticeFor(L);
    sheet('<h2>Draft change notice</h2><p class="small muted">A draft for a person at the bank to check against the note and the rules for this loan - not legal advice. The brackets are for you to fill in after you copy it: Reset never keeps a borrower’s name, address or loan number.' + (state.demo ? '' : ' The bank’s name comes from More.') + '</p>' +
      '<div class="checkrow"><span>Put the nickname on it (for your own file)</span><div class="seg" role="group" aria-label="Nickname on the draft"><button type="button" data-act="noticenick" data-v="0" aria-pressed="' + esc(String(!state.noticeNick)) + '">No</button><button type="button" data-act="noticenick" data-v="1" aria-pressed="' + esc(String(state.noticeNick)) + '">Yes</button></div></div>' +
      '<label class="field"><span>The draft (edit it here before you copy it)</span><textarea class="input notice" id="noticeText" spellcheck="false">' + esc(text) + '</textarea></label>' +
      '<div class="btns"><button class="btn" type="button" data-act="noticecopy">Copy</button><button class="btn ghost" type="button" data-act="noticeshare">Share</button><button class="btn ghost" type="button" data-act="noticefile">Save as a text file</button></div>');
  }

  /* ---------------- the editor ---------------- */

  function newDraft() { return { id: 'l' + rid(9), isNew: true, fields: C.emptyFields(), errs: {}, unsure: [], dropped: [], read: false, example: false, msg: '' }; }
  function draftOf(id) { var L = loan(id); return { id: id, isNew: false, fields: C.fieldsOf(L), errs: {}, unsure: [], dropped: [], read: false, example: false, msg: '' }; }
  var HINT = {
    nick: 'A nickname only - like “Maple duplex 5/1”. Never a borrower’s name or a loan number.', rate: 'Percent, as it is now.', start: 'The rate the loan started at. Needed for a lifetime cap.',
    bal: 'Dollars and cents, after the last payment before the change.', months: 'Payments left after the change.', index: 'Percent, the value as of the lookback date. Can be below zero.',
    date: 'Optional - for the notice and future resets.', margin: 'Percent added to the index.', step: 'Percent: 0.125 is an eighth.', lookback: 'Days before the change date.',
    every: 'Months between changes after this one.', firstCap: 'Points, if the note has one.', periodicCap: 'Points, up or down at one change.', lifetimeCap: 'Points above the start rate.',
    floor: 'Percent, if the note has one.', ceiling: 'Percent, if the note states a maximum.', name: 'As the note names it.',
  };
  function fieldHtml(k, type) {
    var d = state.draft, v = d.fields[k], err = d.errs[k], unsure = d.unsure.indexOf(k) >= 0;
    var input;
    if (k === 'round') input = '<select class="input" data-f="round">' + [['nearest', 'To the nearest increment'], ['up', 'Up to the next increment'], ['down', 'Down'], ['none', 'Not rounded']].map(function (o) { return '<option value="' + o[0] + '"' + (v === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    else if (k === 'first' || k === 'io') input = '<select class="input" data-f="' + k + '"><option value="0"' + (v !== '1' ? ' selected' : '') + '>No</option><option value="1"' + (v === '1' ? ' selected' : '') + '>Yes</option></select>';
    else if (k === 'payRound') input = '<select class="input" data-f="payRound"><option value="nearest"' + (v !== 'up' ? ' selected' : '') + '>To the nearest cent</option><option value="up"' + (v === 'up' ? ' selected' : '') + '>Up to the next cent</option></select>';
    else input = '<input class="input" data-f="' + k + '" value="' + esc(v) + '"' + (type === 'date' ? ' type="date"' : type === 'text' ? ' autocomplete="off" maxlength="80"' : ' inputmode="decimal" autocomplete="off"') + '>';
    return '<label class="field' + (unsure ? ' unsure' : '') + '"><span>' + esc(C.FIELD_LABEL[k]) + (unsure ? ' <span class="check">check this</span>' : '') + '</span>' + input +
      (HINT[k] ? '<span class="hint">' + esc(HINT[k]) + '</span>' : '') + (err ? '<span class="ferr">' + esc(err) + '</span>' : '') + '</label>';
  }
  function editHtml() {
    var d = state.draft;
    var dropped = d.dropped.length ? '<p class="small"><b>Left out by Reset’s checks:</b> ' + esc(d.dropped.join(', ')) + '. A reading never sets a name, a loan number or an amount.</p>' : '';
    var readNote = d.read ? '<div class="note" role="status"><p style="margin:0"><b>' + esc(d.example ? 'The example note, read.' : 'Read from the note.') + '</b> Check every term against the note before you save' + (d.unsure.length ? ' - especially the ones marked “check this”' : '') + '.</p>' + dropped + '</div>' : '';
    return '<div class="stack">' + demoRibbon() + guideHtml('edit') +
      '<section class="card"><h1>' + esc(d.isNew ? 'Add a loan' : 'Edit ' + d.fields.nick) + '</h1><p class="small muted">Type the numbers as they are before the change. Everything is worked out on this phone as you type.</p>' + (d.msg ? '<p class="err" role="alert">' + esc(d.msg) + '</p>' : '') + '</section>' +
      '<section class="card"><h2>The loan</h2>' + fieldHtml('nick', 'text') + '<div class="formgrid three">' + fieldHtml('rate') + fieldHtml('start') + fieldHtml('bal') + fieldHtml('months') + fieldHtml('first') + fieldHtml('date', 'date') + '</div></section>' +
      '<section class="card"><h2>This change</h2><div class="formgrid">' + fieldHtml('index') + '</div></section>' +
      '<section class="card"><div class="row spread"><h2 style="margin:0">The note’s terms</h2><button class="btn ghost" type="button" data-act="readnote">✨ Read the note</button></div>' + readNote +
      '<div class="formgrid three" style="margin-top:12px">' + fieldHtml('name', 'text') + fieldHtml('margin') + fieldHtml('round') + fieldHtml('step') + fieldHtml('lookback') + fieldHtml('every') + fieldHtml('firstCap') + fieldHtml('periodicCap') + fieldHtml('lifetimeCap') + fieldHtml('floor') + fieldHtml('ceiling') + fieldHtml('io') + fieldHtml('payRound') + '</div></section>' +
      '<div class="preview" id="preview" aria-live="polite">' + previewHtml() + '</div>' +
      '<div class="btns"><button class="btn big" type="button" data-act="save">' + (state.demo ? 'Save (in the example only)' : 'Save on this phone') + '</button><button class="btn big ghost" type="button" data-act="canceledit">Cancel</button></div>' +
      '</div>';
  }
  function previewHtml() {
    var r = C.loanFrom(state.draft.fields, 0);
    if (r.errors.length) return '<span class="muted">' + esc(plural(r.errors.length, 'thing') + ' to fill in or fix: ' + r.errors[0].msg) + '</span>';
    var w = workOf(r.loan);
    if (!w) return '<span class="err">These numbers do not work out.</span>';
    return esc('New rate ' + R(w.rate) + ' · ' + M(w.payment) + ' a month · ') + ruleChip(w.bound);
  }
  function saveDraft() {
    var d = state.draft, t = stamp();
    var r = C.loanFrom(d.fields, t);
    d.errs = {};
    if (r.errors.length) {
      r.errors.forEach(function (x) { if (!d.errs[x.field]) d.errs[x.field] = x.msg; });
      d.msg = 'Not saved yet - ' + plural(r.errors.length, 'thing') + ' to fix below.';
      keepPlace(draw);
      var first = $('.ferr'); if (first) reveal(first);
      return;
    }
    var old = loan(d.id);
    r.loan.what = old && old.what ? old.what : C.defaultWhat();
    var b = ensureBook();
    commit(C.putLoan(b, d.id, r.loan, t), true);
    state.lid = d.id; state.draft = null;
    go('loan'); toast(state.demo ? 'Saved in the example.' : 'Saved on this phone.');
  }

  /* ---------------- the AI: "Read the note" ---------------- */

  var WHY_AI = 'Reading a note uses a little AI credit, so it needs a free account (it comes with $2).';
  var SENT_PHOTO = 'What is sent: these photos of the note, shrunk on your phone - and nothing else. Not the nickname, the balance, the rate or anything else in Reset.';
  var SENT_TEXT = 'What is sent: exactly this text - and nothing else. Take out any names, addresses and loan numbers first; Reset refuses text that has them.';
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
  function openReadNote() {
    var intro = '<h2>✨ Read the note</h2><p>AI reads the rate-change section into the terms for you to check against the note. It has no field for a person, a loan number or an amount, and never sets the balance, the rate or the index value.</p>';
    if (state.demo) {
      sheet(intro + '<p class="small muted">Made-up example. Its reading was written in advance and goes through the same checks as a real one - nothing is sent.</p>' + D.noteSvg() + '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="readexample">Read the example note</button></div>');
      return;
    }
    if (!signedIn()) {
      sheet(intro + '<div class="note"><p style="margin:0">' + esc(WHY_AI) + ' One account works across every app on this site. Everything else in Reset stays free with no account.</p></div>' +
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
      body = '<p class="small muted" style="margin-top:10px">One or two photos of the rate-change section only - not the signature page.</p>' +
        '<div class="btns">' + (n < 2 ? '<label class="photobtn">' + (n ? 'Add a second page' : 'Take or choose a photo') + '<input type="file" accept="image/*" data-notephoto></label>' : '') + (n ? '<button class="btn ghost small" type="button" data-act="clearphotos">Start again</button>' : '') + '</div>' +
        (n ? '<p class="sentline"><b>' + esc(SENT_PHOTO) + '</b></p><div class="aiimgs">' + [1, 2].filter(function (s) { return r.photos[s]; }).map(function (s) { return '<img alt="The photo that will be sent" src="' + esc(r.photos[s]) + '">'; }).join('') + '</div>' : '');
    } else {
      var why = r.text ? C.pasteProblem(r.text) : '';
      body = '<label class="field" style="margin-top:10px"><span>The rate-change section, pasted</span><textarea class="input tall" id="pasteText" data-act-input="paste" spellcheck="false">' + esc(r.text) + '</textarea></label>' +
        '<p class="err" id="pasteWhy" role="alert"' + (why ? '' : ' hidden') + '>' + esc(why) + '</p><p class="sentline small"><b>' + esc(SENT_TEXT) + '</b></p>';
    }
    var ready = r.mode === 'photo' ? n > 0 : Boolean(r.text.trim()) && !C.pasteProblem(r.text);
    el.innerHTML = seg + body + '<div id="readErr"></div><div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="readsend"' + (ready ? '' : ' disabled') + '>Send and read the terms</button><span class="small muted">' + esc('About a cent' + (state.me && state.me.tier === 'paid' ? ' (member model)' : '') + '. Read once and not kept.') + '</span></div>';
  }
  function readSend(btn) {
    var sent = readBody();
    btn.disabled = true; btn.textContent = 'Reading the note…';
    api('POST', 'api/ai/terms', sent).then(function (res) {
      loadMe();
      fillFromReading(res, false);
      state.read = { mode: state.read.mode, photos: {}, text: '' };
      closeSheet(true); keepPlace(draw);
      toast('Read - check every term against the note.');
    }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send and read the terms'; meteredError(err, $('#readErr'), openReadNote, WHY_AI); });
  }
  function fillFromReading(res, example) {
    var d = state.draft;
    Object.keys(res.fields).forEach(function (k) { d.fields[k] = res.fields[k]; });
    d.unsure = res.unsure.slice(); d.dropped = res.dropped.slice(); d.read = true; d.example = example; d.errs = {};
  }
  function readExample() {
    if (!state.draft) state.draft = newDraft();
    fillFromReading(C.cleanAiTerms(D.NOTE_RAW), true);
    closeSheet(true); keepPlace(draw);
  }

  /* ---------------- the batch ---------------- */

  function runBatch() {
    var b = C.batch(state.batchText);
    state.batch = b;
    keepPlace(draw);
    if (!b.error) say(plural(b.ok, 'loan') + ' worked out, ' + plural(b.bad, 'row') + ' to fix.');
  }
  function batchHtml() {
    var b = state.batch, res = '';
    if (b && b.error) res = '<section class="card"><p class="err" role="alert">' + esc(b.error) + '</p></section>';
    else if (b) {
      var chips = C.RULES.filter(function (k) { return b.counts[k]; }).map(function (k) { return '<span class="' + ruleClass(k) + '">' + esc(C.RULE_LABEL[k] + ' · ' + b.counts[k]) + '</span>'; }).join('');
      var rows = b.rows.map(function (x) {
        if (x.error) return '<tr class="bad"><td>' + esc(x.row) + '</td><td>' + esc(x.nick) + '</td><td colspan="5" class="err">' + esc(x.error) + '</td></tr>';
        return '<tr><td>' + esc(x.row) + '</td><td>' + esc(x.nick) + '</td><td>' + esc(R(x.res.rate)) + '</td><td>' + esc(C.RULE_LABEL[x.res.bound]) + '</td><td>' + esc(M(x.res.payment)) + '</td><td>' + esc((x.res.payment >= x.res.paymentWas ? '+' : '−') + M(Math.abs(x.res.payment - x.res.paymentWas))) + '</td><td>' + esc(R(x.res.fully)) + '</td></tr>';
      }).join('');
      res = '<section class="card"><div class="row spread"><h2 style="margin:0">' + esc(plural(b.ok, 'loan') + ' worked out' + (b.bad ? ', ' + plural(b.bad, 'row') + ' to fix' : '')) + '</h2><button class="btn" type="button" data-act="exportbatch">Export results (CSV)</button></div>' +
        (chips ? '<div class="rulecounts" style="margin:10px 0">' + chips + '</div>' : '') +
        '<div class="tablebox" tabindex="0" role="region" aria-label="Batch results"><table class="grid"><thead><tr><th>Row</th><th>Nickname</th><th>New rate</th><th>Set by</th><th>Payment</th><th>Change</th><th>Index + margin</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
    }
    return '<div class="stack">' + demoRibbon() + guideHtml('batch') +
      '<section class="card"><h1>A batch from CSV</h1><p class="small muted">Worked out on this phone - the file is never sent or kept. One row per loan; the header names the columns, in any order. Needed: ' + esc(['nickname', 'balance', 'rate', 'months', 'index', 'margin'].join(', ')) + '. Optional: rounding (nearest, up, down, none), increment, periodic_cap, first_change_cap, lifetime_cap, start_rate, floor, ceiling, first_change (yes/no), interest_only (yes/no). Rates are percent; caps are points.</p>' +
      '<div class="btns"><label class="photobtn">Open a CSV file<input type="file" accept=".csv,text/csv,text/plain" data-csvfile></label><button class="btn ghost" type="button" data-act="template">Download a template</button><button class="btn ghost" type="button" data-act="batchexample">Use the example CSV</button></div>' +
      '<label class="field" style="margin-top:12px"><span>Or paste it</span><textarea class="input tall mono" id="csvText" data-act-input="csv" spellcheck="false" placeholder="nickname,balance,rate,months,index,margin">' + esc(state.batchText) + '</textarea></label>' +
      '<button class="btn" type="button" data-act="runbatch">Work them out</button></section>' + res + '</div>';
  }

  /* ---------------- more ---------------- */

  function moreHtml() {
    var n = C.liveLoans(book()).length;
    return '<div class="stack">' + demoRibbon() + guideHtml('more') +
      '<section class="card"><h1>' + esc(state.demo ? D.NAME : 'My loans') + '</h1><p class="muted">' + esc(plural(n, 'loan')) + '</p><p class="small" data-sync>' + syncLine() + '</p></section>' +
      (state.demo ? '' : '<section class="card"><h2>Your institution, for the draft notice</h2><p class="small muted">Kept on this phone only, never synced. Leave it empty for “[Lender name]”.</p><label class="field"><span>Name on the notice</span><input class="input" id="lender" maxlength="80" autocomplete="organization" value="' + esc(state.device.lender) + '"></label><p class="err" id="lenderErr" role="alert" hidden></p><button class="btn ghost" type="button" data-act="savelender">Keep it</button></section>') +
      '<section class="card"><h2>The arithmetic</h2><ul class="ticks"><li>Rates are whole numbers of 0.00001%, money whole cents - never a float.</li><li>Index + margin, rounded (a half rounds up), then the first-change or periodic cap from the current rate, the lifetime cap from the start rate, the ceiling, the floor, and never below zero. Caps never carry over.</li><li>The payment is P = B × r ÷ (1 − (1 + r)^−n), r = rate ÷ 12, as one exact fraction, rounded once to the cent.</li></ul></section>' +
      '<section class="card"><h2>What Reset keeps</h2><ul class="ticks"><li>Each loan’s nickname, terms and numbers stay on this phone; signed in, they are kept in your account to reach your other phone.</li><li>A nickname that looks like a person’s name, a tax id or an account number is refused - here and on the server.</li><li>Reading a note sends that note’s photo or pasted section and nothing else; it is read once and not kept.</li><li>A batch CSV is worked out in this tab and never kept or sent.</li></ul></section>' +
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
  var FREE_LINE = 'Reset is free with no account, and everything stays on this phone. A free account keeps two phones in step and adds reading a note with AI - it comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(leftUsd) + '</span></div><p class="small muted" style="margin:6px 0 0">Reading a note costs about a cent. Everything else is free and stays on this phone.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my loans from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your loans from the account? This phone keeps its copy.')) return;
          api('DELETE', 'api/sync').then(function () {
            state.sync = { base: null, at: 0 }; saveSync(); state.syncState = 'local';
            closeSheet(); toast('Removed from the account. This phone still has them.');
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Typing the terms in yourself, the batch and everything else keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id'), v = el.getAttribute('data-v');
    switch (act) {
      case 'home': e.preventDefault(); go(book() ? 'loans' : 'start'); break;
      case 'tab': closeSheet(true); go(el.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'leavedemo': leaveDemo(); break;
      case 'tour': tourStep(Number(el.getAttribute('data-step'))); break;
      case 'tourdo': tourDo(Number(el.getAttribute('data-step'))); break;
      case 'tourdone': leaveDemo(); go('add'); break;
      case 'closesheet': closeSheet(); break;
      case 'signin': openAccount(); break;
      case 'account': openAccountSheet(); break;
      case 'aijoin': openAccount(WHY_AI, openReadNote); break;
      case 'mergeok': state.mergeNote = null; keepPlace(draw); break;
      case 'resync': state.sync = { base: null, at: 0 }; push(null); break;
      case 'retrysync': syncIn(); break;
      case 'open': state.lid = id; state.showPay = false; go('loan'); break;
      case 'edit': state.draft = draftOf(id); go('edit'); break;
      case 'remove': (function () {
        var L = loan(id);
        if (!confirm('Remove “' + L.nick + '”' + (state.demo ? ' from the example' : ' from this phone') + '?')) return;
        commit(C.removeLoan(book(), id, stamp()), true); go('loans'); toast('Removed.');
      }()); break;
      case 'what': (function () {
        var L = loan(state.lid), w = C.clone(L.what || C.defaultWhat()), by = Math.abs(w.by) || 25000;
        if (v === 'flat') w.kind = 'flat';
        else if (v === 'list') { w.kind = 'list'; if (!w.list.length) w.list = [L.index]; }
        else { w.kind = 'step'; w.by = v === 'down' ? -by : by; }
        setWhat(state.lid, w);
      }()); break;
      case 'notice': openNotice(); break;
      case 'noticenick': (function () { state.noticeNick = v === '1'; var L = loan(state.lid), ta = $('#noticeText'); if (L && ta) ta.value = noticeFor(L); $$('[data-act="noticenick"]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-v') === v)); }); }()); break;
      case 'noticecopy': copy($('#noticeText').value, 'Copied - check it before it goes anywhere.'); break;
      case 'noticeshare': shareText('Draft rate change notice', $('#noticeText').value, 'Copied - check it before it goes anywhere.'); break;
      case 'noticefile': download('draft-rate-change-notice.txt', $('#noticeText').value, 'text/plain'); break;
      case 'save': saveDraft(); break;
      case 'canceledit': (function () { var d = state.draft; state.draft = null; if (d && !d.isNew) { state.lid = d.id; go('loan'); } else go(book() ? 'loans' : 'start'); }()); break;
      case 'readnote': openReadNote(); break;
      case 'readmode': state.read.mode = v; drawRead(); break;
      case 'clearphotos': state.read.photos = {}; drawRead(); break;
      case 'readsend': readSend(el); break;
      case 'readexample': readExample(); break;
      case 'readdemo': closeSheet(true); startDemo(); tourStep(6); break;
      case 'runbatch': runBatch(); break;
      case 'batchexample': state.batchText = D.CSV; runBatch(); break;
      case 'template': download('reset-template.csv', C.TEMPLATE, 'text/csv'); break;
      case 'exportbatch': if (state.batch && !state.batch.error) download('reset-results.csv', C.batchCsv(state.batch), 'text/csv'); break;
      case 'savelender': (function () {
        var s = $('#lender').value.trim(), why = s ? (C.refuse(s, 80) || (C.nameIn(s) ? 'That looks like a person’s name - put the institution’s name here.' : '')) : '', err = $('#lenderErr');
        err.hidden = !why; err.textContent = why;
        if (why) return;
        state.device.lender = s; saveDevice(); toast(s ? 'Kept on this phone.' : 'Cleared.');
      }()); break;
      case 'wipe':
        if (!confirm('Remove every loan from this phone?')) return;
        real.clearAll().then(function () { state.book = null; state.sync = RS.cleanSync({}); state.device = RS.cleanDevice({}); go('start'); toast('Removed from this phone.'); });
        break;
      default: break;
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.hasAttribute('data-f') && state.draft && t.tagName === 'SELECT') { state.draft.fields[t.getAttribute('data-f')] = t.value; var p = $('#preview'); if (p) p.innerHTML = previewHtml(); return; }
    if (t.hasAttribute('data-notephoto')) {
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
      rd.addEventListener('load', function () { state.batchText = String(rd.result || ''); runBatch(); });
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
    if (t.hasAttribute('data-what')) { whatInput(t); return; }
    if (t.getAttribute('data-act-input') === 'csv') { state.batchText = t.value; return; }
    if (t.getAttribute('data-act-input') === 'paste') {
      state.read.text = t.value;
      var why = t.value ? C.pasteProblem(t.value) : '', w = $('#pasteWhy'), send = $('[data-act="readsend"]');
      if (w) { w.hidden = !why; w.textContent = why; }
      if (send) send.disabled = !t.value.trim() || Boolean(why);
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
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
    if (h && ['loans', 'batch', 'more', 'add'].indexOf(h) < 0) history.replaceState(null, '', BASE);
    route();
    return loadMe();
  }).then(function () { if (signedIn()) syncIn(); });
}());
