/* Ajar - the page. One file, no build step.
 *
 * EVERYTHING HAPPENS ON THIS PHONE. The countdown - the big day, the kids'
 * first names and ages, busy evenings, the deck choices, the plan, the
 * doors, the shopping ticks - is worked out by AjarCore and kept through
 * ajar-store.js (IndexedDB, with a memory fallback). Photos of done doors
 * are shrunk through a canvas (no EXIF, no location) and kept on this phone
 * only: never sent, never synced. The made-up example is never kept, sent
 * or synced.
 *
 * The requests this page makes: sign-in, the account's copy of the
 * countdowns (signed in, to keep two grown-ups' phones in step - never a
 * photo), and the one optional AI idea request, whose body - the kids'
 * ages, the chips, the budget word, the month, the theme, how many and the
 * built-in deck ids already chosen - is shown in full before it is sent.
 *
 * Every string a person typed, the server sent or a model wrote is escaped
 * before it is drawn, and no handler is written into markup: clicks and
 * changes are routed by data-act and data-* attributes from one listener
 * each (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.AjarCore;
  var D = window.AjarDemo;
  var AS = window.AjarStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  var REDUCED = (function () { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return { matches: false }; } }());

  var real = AS.create(AS.idb('ajar'));

  var state = {
    me: null, view: 'start', list: [], curId: '', device: AS.cleanDevice({}), sync: {}, syncState: 'local', syncErr: '',
    demo: false, demoCd: null, draft: null, tour: 0,
    deck: { mode: 'swipe', f: { th: '', tm: '', c: '', w: '', m: '', k: '' }, seen: {}, last: [], more: 0 },
    sel: '', pending: null, report: null, mergeNote: null, kidQ: null, kidMsg: '', kidOpen: '',
    ai: { likes: [], count: 8, ideas: null, req: null, example: false }, recap: { photo: false, blob: null, url: null },
    paper: '', photoDays: {}, busy: false,
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
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else here stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    reveal(where);
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function reveal(el) { try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* old browsers */ } }
  function meteredError(err, box, retry, why) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount(why, retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    if (err.status === 413) return showError(new Error('That was too much to send. Pick fewer chips or fewer ideas.'), box);
    showError(err, box);
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }

  /* ---------------- the clock, ids and dice (the page's, never the core's) ---------------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { if (state.demo) return state.demoEnd ? D.END : D.TODAY; var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function nowHM() { if (state.demo) return state.demoEnd ? { h: 19, m: 30 } : D.NOW; var d = new Date(); return { h: d.getHours(), m: d.getMinutes() }; }
  function stamp() { return Date.now(); }
  function seed() { try { var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; } catch (e) { return Math.floor(Math.random() * 4294967295); } }
  function rid(n) { var s = '', abc = 'abcdefghijklmnopqrstuvwxyz0123456789'; try { var a = new Uint8Array(n); crypto.getRandomValues(a); for (var i = 0; i < n; i++) s += abc[a[i] % 36]; } catch (e) { for (var j = 0; j < n; j++) s += abc[Math.floor(Math.random() * 36)]; } return s; }

  /* ---------------- countdowns: this phone, and the example ---------------- */

  function byId(id) { return state.list.filter(function (x) { return x.id === id; })[0] || null; }
  function cd() { return state.demo ? state.demoCd : byId(state.curId); }
  function saveLocal() {
    real.putCountdowns(state.list).catch(function () { /* still in this tab */ });
    real.putCurrent(state.curId).catch(function () { /* fine */ });
  }
  function saveDevice() { real.putDevice(state.device).catch(function () { /* fine */ }); }
  function saveSync() { real.putSync(state.sync).catch(function () { /* fine */ }); }
  /** Keep a changed countdown: the example in memory only; a real one on
   *  this phone and, signed in, in the account. */
  function commit(next, quiet) {
    if (state.demo) state.demoCd = next;
    else {
      var i = -1;
      state.list.forEach(function (x, k) { if (x.id === next.id) i = k; });
      if (i < 0) state.list.push(next); else state.list[i] = next;
      saveLocal(); pushSoon(next.id);
    }
    if (!quiet) keepPlace(draw);
  }
  /** A core change: refused (with its way out drawn as a button) or kept. */
  function apply(r, ctx, where) {
    if (!r.ok) { state.pending = { r: r, ctx: ctx || {} }; if (where) drawRefusal(where); else keepPlace(draw); say(r.msg); return false; }
    state.pending = null;
    commit(r.cd);
    if (r.msg) say(r.msg);
    return true;
  }
  function refusalHtml() {
    var p = state.pending;
    if (!p) return '';
    return '<div class="refuse" role="alert"><p>' + esc(p.r.msg) + '</p><div class="btns"><button class="btn small" type="button" data-act="way">' + esc(p.r.way.label) + '</button><button class="btn small ghost" type="button" data-act="unrefuse">Not now</button></div></div>';
  }
  function drawRefusal(where) { where.innerHTML = refusalHtml(); reveal(where); }

  /* ---------------- two phones: the account copy ---------------- */

  var pushTimers = {};
  function syncOf(id) { return state.sync[id] || { base: null, at: 0 }; }
  function bodyOf(c) { var b = C.cleanCountdown(c).countdown; delete b.updatedAt; return b; }
  function pushSoon(id) {
    if (!signedIn() || !state.me.sync || state.demo) return;
    clearTimeout(pushTimers[id]);
    state.syncState = 'syncing'; drawSync();
    pushTimers[id] = setTimeout(function () { push(id); }, 800);
  }
  function push(id, base) {
    var c = byId(id);
    if (!c || !signedIn()) return Promise.resolve();
    return api('PUT', 'api/countdowns/' + id, { countdown: bodyOf(c), base: base !== undefined ? base : syncOf(id).base }).then(function (out) {
      state.sync[id] = { base: out.countdown.updatedAt, at: stamp() }; saveSync();
      state.syncState = 'synced'; state.syncErr = ''; drawSync();
    }).catch(function (err) {
      var code = err.data && err.data.code;
      if (err.status === 409 && code === 'conflict' && err.data.countdown) return mergeIn(err.data.countdown);
      if (err.status === 409 && code === 'removed') { state.sync[id] = { base: null, at: 0 }; saveSync(); state.syncState = 'removed'; drawSync(); return null; }
      if (err.status === 409 && code === 'full') { state.syncState = 'full'; state.syncErr = err.message; drawSync(); return null; }
      state.syncState = 'error'; state.syncErr = err.message; drawSync();
      return null;
    });
  }
  /** The account's copy came back different: merge it into this phone's
   *  (each day, door and tick by its own time), keep the result here, and
   *  save it against the account's version. */
  function mergeIn(acc) {
    var local = byId(acc.id);
    if (!local) return null;
    var m = C.merge(local, acc, syncOf(acc.id).at);
    var merged = m.cd;
    delete merged.updatedAt;
    var pulled = !C.same(merged, local);
    var i = state.list.indexOf(local);
    state.list[i] = merged; saveLocal();
    if (pulled) {
      // Say what came in: so many days, doors and ticks, and the setup or the deck.
      var diff = function (f) { return Object.keys(merged[f]).filter(function (k) { return C.canon(merged[f][k]) !== C.canon(local[f][k]); }).length; };
      var bits = [], dp = diff('plan'), dd = diff('doors'), ds = diff('shop');
      if (dp) bits.push(plural(dp, 'day') + ' of the plan');
      if (dd) bits.push(plural(dd, 'door'));
      if (ds) bits.push(plural(ds, 'shopping tick'));
      if (C.canon(merged.setup) !== C.canon(local.setup)) bits.push('the setup');
      if (C.canon(merged.deck) !== C.canon(local.deck)) bits.push('the chosen ideas');
      state.mergeNote = { pulled: bits, notes: m.notes };
      if (state.view !== 'setup') keepPlace(draw);
    }
    if (C.same(merged, acc)) { state.sync[acc.id] = { base: acc.updatedAt, at: stamp() }; saveSync(); state.syncState = 'synced'; drawSync(); return null; }
    return push(acc.id, acc.updatedAt);
  }
  function syncIn() {
    if (!signedIn() || !state.me.sync) return Promise.resolve();
    return api('GET', 'api/countdowns').then(function (out) {
      var accs = out.countdowns || [], jobs = [];
      accs.forEach(function (acc) {
        var local = byId(acc.id), s = syncOf(acc.id);
        if (!local) {
          if (state.list.length >= C.LIMITS.countdowns) return;
          var c = C.clone(acc); delete c.updatedAt;
          state.list.push(c); state.sync[acc.id] = { base: acc.updatedAt, at: stamp() };
          if (!state.curId) state.curId = acc.id;
          return;
        }
        if (s.base === acc.updatedAt) { if (!C.same(local, acc)) jobs.push(push(acc.id)); return; }
        jobs.push(mergeIn(acc));
      });
      state.list.forEach(function (c) {
        if (accs.some(function (a) { return a.id === c.id; })) return;
        if (syncOf(c.id).base === null) jobs.push(push(c.id, null));
        else { state.sync[c.id] = { base: null, at: 0 }; state.syncState = 'removed'; }
      });
      saveLocal(); saveSync();
      if (!jobs.length && state.syncState !== 'removed') state.syncState = 'synced';
      drawSync();
      if (state.view === 'start' && state.list.length && !state.demo) go('doors');
      else if (state.view !== 'setup') keepPlace(draw);
      return Promise.all(jobs);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function syncLine() {
    if (state.demo) return '<span class="sync small muted">The example is never saved or synced.</span>';
    if (!signedIn()) return '<span class="sync small muted">On this phone only · <button class="link-btn" type="button" data-act="signin">sign in to keep two phones in step</button></span>';
    if (state.me && !state.me.sync) return '<span class="sync small muted">Keeping it in the account is unavailable right now - it is on this phone.</span>';
    if (state.syncState === 'syncing') return '<span class="sync small muted">Saving to your account…</span>';
    if (state.syncState === 'removed') return '<span class="sync small warnline">Removed from your account on another phone - kept here. <button class="link-btn" type="button" data-act="resync">Keep it in the account again</button></span>';
    if (state.syncState === 'full') return '<span class="sync small warnline">' + esc(state.syncErr) + '</span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t reach your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small okline">✓ In step with your account - photos stay on this phone</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }
  function mergeNoteHtml() {
    var m = state.mergeNote;
    if (!m || state.demo) return '';
    var lines = (m.pulled.length ? ['From your other phone: ' + m.pulled.join(', ') + '.'] : []).concat(m.notes.slice(0, 4));
    return '<div class="merged" role="status"><b>Merged with your other phone</b><button class="link-btn" type="button" data-act="mergeok">OK</button>' + (lines.length ? '<ul>' + lines.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
  }

  /* ---------------- navigation ---------------- */

  var VIEWS = ['start', 'calendars', 'setup', 'deck', 'plan', 'shop', 'doors', 'print', 'recap', 'more'];
  var NEEDS_CD = ['deck', 'plan', 'shop', 'doors', 'print', 'recap', 'more'];
  /** Go to a view. A tour step's after-hook runs last, so the scroll it
   *  makes is not undone by the jump to the top. */
  function go(view, after) {
    history.pushState(null, '', BASE + '#' + view);
    route(); scrollTo(0, 0);
    if (after) after();
  }
  function route() {
    closeSheet(true);
    state.pending = null; state.sel = '';
    var h = (location.hash || '').replace(/^#/, '');
    var v = VIEWS.indexOf(h) >= 0 ? h : 'start';
    if (NEEDS_CD.indexOf(v) >= 0 && !cd()) v = state.list.length ? 'calendars' : 'start';
    if (v === 'setup' && !state.draft) { if (cd()) state.draft = { setup: C.clone(cd().setup), id: cd().id }; else v = 'start'; }
    if (v === 'start' && state.list.length && !state.demo && h === '') v = cd() ? 'doors' : 'calendars';
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
    var main = $('#main'), tb = $('#tabbar'), c = cd();
    tb.hidden = !c || ['start', 'calendars'].indexOf(state.view) >= 0 || (state.view === 'setup' && !state.draft.id);
    var tab = state.view === 'recap' || state.view === 'print' || state.view === 'setup' ? 'more' : state.view;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('#kidBtn').hidden = !c || ['start', 'calendars', 'setup'].indexOf(state.view) >= 0;
    var v = state.view, html;
    if (v === 'calendars') html = calendarsHtml();
    else if (v === 'setup') html = setupHtml();
    else if (v === 'deck') html = deckHtml();
    else if (v === 'plan') html = planHtml();
    else if (v === 'shop') html = shopHtml();
    else if (v === 'doors') html = doorsHtml();
    else if (v === 'print') html = printHtml();
    else if (v === 'recap') html = recapHtml();
    else if (v === 'more') html = moreHtml();
    else html = startHtml();
    main.innerHTML = html;
    document.body.classList.toggle('in-demo', state.demo);
    drawSync();
    afterDraw();
  }
  function afterDraw() {
    if (state.view === 'recap' || state.view === 'doors') fillPhotos();
    if (state.view === 'deck' && state.deck.mode === 'swipe') bindSwipe();
    if (state.view === 'print') fitPreviews();
  }

  /* ---------------- the example and its tour ---------------- */

  var TOUR = [
    { view: 'doors', title: 'Open today’s door', body: 'In the example it is Wednesday 9 December, 6:15 pm. Door 9 is wiggling - tap it. Doors 1 to 8 are open: six done, one skipped, one moved.', next: 'Next: the plan' },
    { view: 'plan', title: 'Why each day is where it is', body: 'Tuesdays and Thursdays are busy, so they get 5-minute doors and a joke. Half-day ones sit on weekends, nothing that needs shopping comes first, and the concert has its own door. Tap two days to swap them.', next: 'Next: the shopping' },
    { view: 'shop', title: 'What to buy, by when', body: 'Every activity’s things in one list, each due the day before it is needed. Bird seed is due tomorrow.', next: 'Next: kid mode' },
    { view: 'doors', title: 'Kid mode on this phone', body: 'Just the doors, big: nothing to edit, and tomorrow’s door stays shut. Getting out asks a grown-up a sum.', next: 'Next: print the cards', kid: true },
    { view: 'print', title: 'Print the door cards', body: 'Eight cards a sheet, with cut lines, for a calendar with pockets or envelopes - Letter or A4. Or one page for the fridge with the shopping on it.', next: 'Make our calendar' },
  ];
  function startDemo() {
    state.demo = true; state.demoCd = D.countdown(); state.demoEnd = false; state.tour = 1; state.mergeNote = null; state.draft = null;
    go('doors');
  }
  function leaveDemo() {
    state.demo = false; state.demoCd = null; state.demoEnd = false; state.tour = 0; state.draft = null;
    if (!state.device.tour) { state.device.tour = true; saveDevice(); }
    go(state.list.length ? (cd() ? 'doors' : 'calendars') : 'start');
  }
  function tourStep(n) {
    if (n > TOUR.length) { leaveDemo(); startNew(); return; }
    state.tour = n;
    var s = TOUR[n - 1];
    go(s.view, function () {
      if (n === 2) { var b = $('.day.busy'); if (b) b.scrollIntoView({ block: 'center' }); }
      if (n === 3) { var due = $('.shoprow.due-tomorrow'); if (due) { due.scrollIntoView({ block: 'center' }); due.classList.add('pulse'); } }
    });
  }
  function guideHtml(view) {
    if (!state.demo) return '';
    var n = state.tour, s = TOUR[n - 1];
    if (!s || s.view !== view) {
      return '<div class="guide" role="note"><div class="gt"><span class="step">Example · ' + esc(D.FAMILY) + '</span><span>Made up - every tap works, and nothing is kept.</span></div><button class="btn ghost small" type="button" data-act="tour" data-step="1">Take the tour</button></div>';
    }
    return '<div class="guide" role="note"><div class="gt"><span class="step">' + esc('Example · ' + D.FAMILY + ' · step ' + n + ' of ' + TOUR.length) + '</span><b>' + esc(s.title) + '</b><span>' + esc(s.body) + '</span></div>' +
      '<div class="btns">' + (s.kid ? '<button class="btn ghost" type="button" data-act="kid">Try kid mode</button>' : '') + '<button class="btn" type="button" data-act="' + (n === TOUR.length ? 'tourdone' : 'tour') + '" data-step="' + esc(n + 1) + '">' + esc(s.next) + '</button></div></div>';
  }
  function demoRibbon() {
    return state.demo ? '<p class="ribbon">Made-up example: ' + esc(D.FAMILY) + ' is invented, and nothing here is kept, sent or synced. <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>' : '';
  }

  /* ---------------- first run ---------------- */

  function mockCalHtml() {
    var nums = [7, 2, 15, 11, 4, 20, 9, 18, 1, 13, 22, 6, 16, 3, 24, 10, 19, 5, 12, 21, 8, 14, 23, 17];
    return '<div class="mock look-festive" aria-hidden="true"><div class="mock-top"><span>24 little doors</span><span class="mt">to the big day</span></div><div class="mock-doors">' +
      nums.map(function (n) { return '<span class="md' + (n === 9 ? ' ajar' : n < 9 ? ' done' : '') + (n === 24 ? ' big' : '') + '"><i></i><b>' + esc(n) + '</b></span>'; }).join('') + '</div></div>';
  }
  function startHtml() {
    return '<div class="stack">' +
      '<section class="hero"><div class="copy"><div class="kicker"><span aria-hidden="true">🌟</span> A countdown of small things to do together</div>' +
      '<h1>One little door a day to the big day.</h1>' +
      '<p>Pick small things to do together - and Ajar plans them around your real week: quick ones on busy evenings, the big ones at weekends, the shopping in time, the budget kept. For Christmas, a birthday, a trip, or any day worth counting down to.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="demo">Try the demo</button><button class="btn big ghost" type="button" data-act="new">Make our calendar</button></div>' +
      '<p class="caps">1 December is close - families set these up the weekend before.</p></div>' + mockCalHtml() + '</section>' +
      '<section class="how4"><h2 class="vh">How it works</h2>' +
      '<div class="card"><h3>Pick the big day</h3><p class="small muted">Christmas (doors 1-24 December), from the first Sunday of Advent, or any big day with 3 to 31 doors.</p></div>' +
      '<div class="card"><h3>Choose what you’d like to do</h3><p class="small muted">Swipe through about a hundred small activities - crafts, baking, walks, games - or add your own.</p></div>' +
      '<div class="card"><h3>Ajar plans it around your week</h3><p class="small muted">Busy evenings get 5-minute doors, weekends the big ones, nothing that needs shopping too soon - and it says why.</p></div>' +
      '<div class="card"><h3>Open a door each day</h3><p class="small muted">On the phone, in kid mode, or printed as cards for a calendar you already have.</p></div>' +
      '</section>' +
      '<section class="card promise"><h2>The promise</h2><ul class="ticks"><li><b>No sign-in.</b> Everything works without an account.</li><li><b>Works offline</b> once it has loaded.</li><li><b>Stays on this phone</b> - photos never leave it.</li><li><b>Never asks for anything but first names.</b> No addresses, no birthdays, no school.</li></ul><p class="small muted" style="margin:8px 0 0">Sign in only if you want two grown-ups’ phones in step, or AI to suggest more ideas from the kids’ ages.</p></section>' +
      '<p class="foot">A trial app in the <a href="../">Challenge Lab</a>. Activities are written plainly - no brands, no shops, nothing to buy from us.</p>' +
      '</div>';
  }

  /* ---------------- your calendars ---------------- */

  function calendarsHtml() {
    var t = today();
    var rows = state.list.map(function (c) {
      var r = C.range(c.setup), rc = C.recap(c, t), go2 = C.daysToGo(c, t);
      return '<div class="calrow"><div><b>' + esc(C.bigName(c.setup)) + '</b><span class="small muted">' + esc(r ? C.dayLabel(r.start) + ' to ' + C.dayLabel(r.end) : '') + ' · ' + esc(rc.opened + ' of ' + plural(rc.doors, 'door') + ' open') + (go2 > 0 ? ' · ' + esc(plural(go2, 'day')) + ' to go' : '') + '</span></div>' +
        '<div class="btns"><button class="btn small" type="button" data-act="opencal" data-id="' + esc(c.id) + '">Open</button><button class="btn small ghost" type="button" data-act="rmcal" data-id="' + esc(c.id) + '">Remove</button></div></div>';
    }).join('');
    return '<div class="stack narrow"><div class="sec-head"><h1>Your countdowns</h1><span class="muted">' + esc(state.list.length + ' of ' + C.LIMITS.countdowns) + '</span></div>' +
      '<section class="card">' + (rows || '<p class="muted">None yet.</p>') + '</section>' +
      '<div class="btns">' + (state.list.length < C.LIMITS.countdowns ? '<button class="btn" type="button" data-act="new">New countdown</button>' : '<span class="small muted">This phone keeps up to three - remove one to start another.</span>') + '<button class="btn ghost" type="button" data-act="demo">See the example</button></div>' +
      '<p class="small" data-sync></p></div>';
  }

  /* ---------------- setup ---------------- */

  function startNew() {
    if (state.list.length >= C.LIMITS.countdowns) { toast('This phone keeps up to three countdowns - remove one first.', 4200); go('calendars'); return; }
    state.demo = false; state.demoCd = null;
    state.draft = { setup: C.defaultSetup(today()), id: null };
    go('setup');
  }
  function tplCard(val, title, sub, cur) {
    return '<button class="tpl" type="button" data-act="tpl" data-v="' + esc(val) + '" aria-pressed="' + (cur === val) + '"><b>' + esc(title) + '</b><span>' + esc(sub) + '</span></button>';
  }
  function setupHtml() {
    var dr = state.draft, s = dr.setup, isNew = !dr.id, r = C.range(s), t = today();
    var adv = C.adventStart(s.year || C.christmasYear(t)), advDoors = C.range({ template: 'advent', year: s.year }).doors;
    var kidRows = s.kids.map(function (k, i) {
      return '<div class="kidrow"><label class="field"><span class="vh">Name ' + esc(i + 1) + '</span><input class="input" data-kid="' + esc(i) + '" data-f="name" maxlength="20" autocomplete="off" placeholder="First name" value="' + esc(k.name) + '"></label>' +
        '<label class="field"><span class="vh">Age</span><select class="input" data-kid="' + esc(i) + '" data-f="age">' + '<option value="">Age</option>' + Array.from({ length: 18 }, function (_, a) { return '<option value="' + a + '"' + (k.age === a ? ' selected' : '') + '>' + (a === 0 ? 'Under 1' : esc(plural(a, 'year'))) + '</option>'; }).join('') + '</select></label>' +
        '<button class="btn small ghost" type="button" data-act="rmkid" data-i="' + esc(i) + '" aria-label="Remove this child">Remove</button></div>';
    }).join('');
    var wd = [1, 2, 3, 4, 5, 6, 0].map(function (d) { return '<button class="wd" type="button" data-act="busywd" data-d="' + esc(d) + '" aria-pressed="' + (s.busy.indexOf(d) >= 0) + '"><span aria-hidden="true">' + esc(C.WD[d].charAt(0)) + '</span><span class="vh">' + esc(C.WD_LONG[d]) + '</span></button>'; }).join('');
    var bdates = s.busyDates.map(function (d) { return '<span class="chipx">' + esc(C.dayLabel(d)) + '<button type="button" data-act="rmbusy" data-d="' + esc(d) + '" aria-label="Remove ' + esc(C.dayLabel(d)) + '">×</button></span>'; }).join('');
    var pins = s.pins.map(function (p) { return '<span class="chipx">' + esc(p.title + ', ' + C.dayLabel(p.date)) + '<button type="button" data-act="rmpin" data-id="' + esc(p.id) + '" aria-label="Remove ' + esc(p.title) + '">×</button></span>'; }).join('');
    var custom = s.template === 'custom';
    return '<div class="stack">' + demoRibbon() +
      '<div class="sec-head"><h1>' + (isNew ? 'Make our calendar' : 'Setup') + '</h1><span class="muted small">About a minute. Change any of it later.</span></div>' +
      '<div class="setup-grid">' +
      '<section class="card"><h2>The big day</h2><div class="tpls">' +
      tplCard('christmas', 'Christmas', 'Doors 1-24 December - 24 doors', s.template) +
      tplCard('advent', 'From the first Sunday of Advent', C.dayLabel(adv) + ' to 24 December - ' + plural(advDoors, 'door'), s.template) +
      tplCard('custom', 'Any big day', 'A birthday, a trip, the last day of school - 3 to 31 doors', s.template) + '</div>' +
      (custom ? '<div class="pair" style="margin-top:12px"><label class="field"><span>What is it?</span><input class="input" data-set="name" maxlength="40" placeholder="Like: Grandma visits" value="' + esc(s.name === 'The big day' ? '' : s.name) + '"></label><label class="field"><span>The day</span><input class="input" type="date" data-set="bigDay" min="' + esc(t) + '" value="' + esc(s.bigDay) + '"></label></div>' +
        '<div class="pair" style="margin-top:10px"><label class="field"><span>How many doors</span><select class="input" data-set="doors">' + Array.from({ length: 29 }, function (_, i) { var n = i + 3; return '<option value="' + n + '"' + (s.doors === n ? ' selected' : '') + '>' + esc(plural(n, 'door')) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>The look</span><select class="input" data-set="look">' + C.LOOKS.map(function (l) { return '<option value="' + esc(l) + '"' + (s.look === l ? ' selected' : '') + '>' + esc(C.LOOK_WORD[l]) + '</option>'; }).join('') + '</select></label></div>' +
        '<p class="lab" style="margin-top:12px">The last door</p><div class="seg2 two" role="group" aria-label="The last door"><button type="button" data-act="ends" data-v="eve" aria-pressed="' + esc(s.ends !== 'day') + '">The day before</button><button type="button" data-act="ends" data-v="day" aria-pressed="' + esc(s.ends === 'day') + '">On the big day</button></div>' : '') +
      '<p class="small rangeline">' + esc(r ? C.rangeLine(s) : 'Pick the day to see the doors.') + '</p></section>' +
      '<section class="card"><h2>Who’s in</h2><p class="small muted" style="margin-top:-4px">First names or nicknames only - and ages, so the ideas suit them.</p><div class="kids">' + kidRows + '</div>' +
      (s.kids.length < C.LIMITS.kids ? '<button class="btn small ghost" type="button" data-act="addkid">+ Add a child</button>' : '') +
      '<div class="stepper" style="margin-top:12px"><span>Grown-ups</span><button class="btn small ghost" type="button" data-act="adults" data-d="-1" aria-label="One fewer grown-up">−</button><b aria-live="polite">' + esc(s.adults) + '</b><button class="btn small ghost" type="button" data-act="adults" data-d="1" aria-label="One more grown-up">+</button></div></section>' +
      '<section class="card"><h2>Busy evenings</h2><p class="small muted" style="margin-top:-4px">Tap the weekdays that are usually busy - they get 5-minute doors.</p><div class="wds" role="group" aria-label="Busy weekdays">' + wd + '</div>' +
      '<details class="fold"' + (s.busyDates.length ? ' open' : '') + '><summary>Other busy dates' + (s.busyDates.length ? ' (' + esc(s.busyDates.length) + ')' : '') + '</summary><div class="chips">' + bdates + '</div><div class="addrow"><label class="field"><span class="vh">A busy date</span><input class="input" type="date" id="busyDate" value="' + esc(r ? r.start : '') + '"></label><button class="btn small ghost" type="button" data-act="addbusy">Add</button></div></details>' +
      '<details class="fold"' + (s.pins.length ? ' open' : '') + '><summary>Things on a fixed date' + (s.pins.length ? ' (' + esc(s.pins.length) + ')' : '') + '</summary><p class="small muted">A concert, a party, a visit - each becomes its own quick door.</p><div class="chips">' + pins + '</div><div class="addrow"><label class="field"><span class="vh">What</span><input class="input" id="pinTitle" maxlength="40" placeholder="Like: School concert"></label><label class="field"><span class="vh">When</span><input class="input" type="date" id="pinDate" value="' + esc(r ? r.start : '') + '"></label><button class="btn small ghost" type="button" data-act="addpin">Add</button></div></details></section>' +
      '<section class="card"><h2>Money and time</h2><p class="lab">A budget for the whole countdown</p><div class="seg2 three" role="group" aria-label="Budget">' +
      [['none', 'No money'], ['little', 'A little'], ['set', 'An amount']].map(function (b) { return '<button type="button" data-act="budget" data-v="' + esc(b[0]) + '" aria-pressed="' + esc(s.budget.mode === b[0]) + '">' + esc(b[1]) + '</button>'; }).join('') + '</div>' +
      (s.budget.mode === 'set' ? '<label class="field" style="margin-top:8px"><span>Dollars, all told</span><input class="input money" type="number" inputmode="numeric" min="1" max="2000" data-set="usd" value="' + esc(s.budget.usd) + '"></label>' : '<p class="small muted">' + esc(C.budgetWord(s)) + '</p>') +
      '<p class="lab" style="margin-top:12px">A normal evening has</p><div class="seg2 four" role="group" aria-label="A normal evening">' + C.EVENINGS.map(function (m) { return '<button type="button" data-act="evening" data-v="' + m + '" aria-pressed="' + (s.evening === m) + '">' + esc({ 15: '15 min', 30: '30 min', 60: 'An hour', 120: '2 hours+' }[m]) + '</button>'; }).join('') + '</div></section>' +
      '</div><div id="setupErr"></div>' +
      '<div class="btns end"><button class="btn big" type="button" data-act="savesetup">' + (isNew ? 'Next: choose activities' : 'Save and re-plan') + '</button>' + (isNew ? '' : '<button class="btn ghost" type="button" data-act="tab" data-tab="doors">Cancel</button>') + '</div></div>';
  }
  function saveSetup() {
    var dr = state.draft, t = today(), errs = [];
    var s = C.cleanSetup(dr.setup, errs, true);
    var box = $('#setupErr');
    var problem = C.bodyProblem(dr.setup);
    if (problem || errs.length) { showError(new Error(problem ? 'Not saved: ' + problem.charAt(0).toLowerCase() + problem.slice(1) : (errs[0].indexOf('kids') >= 0 ? 'Names: first names or nicknames only - letters, no numbers.' : errs[0])), box); return; }
    var r = C.range(s);
    if (!r) { showError(new Error('Pick the day you are counting down to.'), box); return; }
    if (!state.demo && C.dayOf(r.end) < C.dayOf(t)) { showError(new Error('That day has passed - pick one that hasn’t come yet.'), box); return; }
    if (dr.id) {
      var cur = cd(), next = C.clone(cur);
      next.setup = s; next.setupT = stamp();
      if (Object.keys(cur.plan).length) { var rp = C.replan(next, { seed: seed(), t: stamp() }); next = rp.cd; state.report = rp.report; }
      state.draft = null; commit(next, true); toast('Saved.'); go('plan');
      return;
    }
    if (state.list.length >= C.LIMITS.countdowns) { showError(new Error('This phone keeps up to three countdowns - remove one first.'), box); return; }
    var c = C.newCountdown(rid(10), s, stamp());
    state.list.push(c); state.curId = c.id; state.draft = null; state.report = null;
    saveLocal(); pushSoon(c.id);
    go('deck');
  }

  /* ---------------- the deck: choosing ---------------- */

  var KIND_ICON = { crafts: '✂️', baking: '🧁', outdoors: '🌲', music: '🎵', building: '🧱', reading: '📖', giving: '💌', science: '🔬', games: '🎲', quiet: '☕' };
  function deckPool() {
    var c = cd(), f = state.deck.f, th = C.themesFor(c.setup), ages = C.kidAges(c.setup);
    var all = C.DECK.filter(function (a) { return th.indexOf(a.th) >= 0; }).concat(c.deck.custom);
    return all.filter(function (a) {
      return (!f.th || a.th === f.th) && (!f.tm || a.tm === f.tm) && (!f.c || a.c === f.c) && (!f.w || a.w === f.w) && (!f.m || a.m === f.m) && (!f.k || a.k === f.k);
    }).sort(function (x, y) { return (C.suitsAges(y, ages) ? 1 : 0) - (C.suitsAges(x, ages) ? 1 : 0); });
  }
  function tagsHtml(a, c) {
    var t = [C.TIME_WORD[a.tm], a.c === 'free' ? 'Free' : C.money(C.costOf(c, a)), C.WHERE_WORD[a.w], C.MESS_WORD[a.m], 'Ages ' + a.a[0] + '-' + a.a[1]];
    return '<span class="tags">' + t.map(function (x, i) { return '<span class="tag' + (i === 3 && a.m === 'lots' ? ' messy' : '') + '">' + esc(x) + '</span>'; }).join('') + (a.src === 'ai' ? '<span class="tag ai">AI idea</span>' : a.src === 'own' ? '<span class="tag own">Yours</span>' : '') + '</span>';
  }
  function needsHtml(a) { return a.n.length ? '<p class="needs"><b>You need:</b> ' + esc(a.n.join(', ')) + '</p>' : '<p class="needs muted">Nothing to buy.</p>'; }
  function chipGroup(key, label, opts) {
    var f = state.deck.f;
    return '<div class="fgroup"><span class="lab">' + esc(label) + '</span><div class="chips">' + [['', 'Any']].concat(opts).map(function (o) { return '<button class="chip" type="button" data-act="filter" data-k="' + esc(key) + '" data-v="' + esc(o[0]) + '" aria-pressed="' + (f[key] === o[0]) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div></div>';
  }
  function deckHtml() {
    var c = cd(), r = C.range(c.setup), n = c.deck.picks.length, doors = r ? r.doors : 0;
    var th = C.themesFor(c.setup), f = state.deck.f, on = Object.keys(f).filter(function (k) { return f[k]; }).length;
    var filters = '<details class="fold filters"' + (on ? ' open' : '') + '><summary>Filter' + (on ? ' (' + esc(on) + ' on)' : '') + '</summary>' +
      (th.length > 1 ? chipGroup('th', 'Theme', th.map(function (x) { return [x, C.THEME_WORD[x]]; })) : '') +
      chipGroup('tm', 'Time', C.TIMES.map(function (x) { return [x, C.TIME_WORD[x]]; })) +
      chipGroup('c', 'Cost', C.COSTS.map(function (x) { return [x, C.COST_WORD[x]]; })) +
      chipGroup('w', 'Where', C.WHERES.map(function (x) { return [x, C.WHERE_WORD[x]]; })) +
      chipGroup('m', 'Mess', C.MESSES.map(function (x) { return [x, C.MESS_WORD[x]]; })) +
      chipGroup('k', 'Kind', C.LIKES.map(function (x) { return [x, C.LIKE_WORD[x]]; })) + '</details>';
    var pct = Math.min(100, Math.round(100 * n / Math.max(1, doors)));
    var head = '<div class="sec-head"><h1>What would you like to do?</h1><span class="muted">' + esc(plural(n, 'chosen', 'chosen') + ' for ' + plural(doors, 'door')) + '</span></div>' +
      '<div class="meter" aria-hidden="true"><i style="width:' + esc(pct) + '%"></i></div>' +
      '<p class="small muted">' + esc(n >= doors - 2 ? 'Plenty - busy evenings get fillers (a joke, a tiny treat, a note) so you don’t need one for every door.' : 'A good mix is about one for each door, a few short. Fillers cover the rest.') + '</p>';
    var tools = '<div class="btns">' + (n ? '' : '<button class="btn" type="button" data-act="starter">Pick a good mix for us</button>') +
      '<div class="seg2 two" role="group" aria-label="How to choose"><button type="button" data-act="deckmode" data-v="swipe" aria-pressed="' + (state.deck.mode === 'swipe') + '">Swipe</button><button type="button" data-act="deckmode" data-v="list" aria-pressed="' + (state.deck.mode === 'list') + '">List</button></div></div>';
    var body = state.deck.mode === 'swipe' ? swipeHtml() : listHtml();
    var foot = '<div class="btns deckfoot"><button class="btn ghost" type="button" data-act="addown">+ Add your own</button><button class="btn ghost" type="button" data-act="ai">✨ More ideas for us</button><button class="btn big" type="button" data-act="planit"' + (n ? '' : ' disabled') + '>' + (Object.keys(c.plan).length ? 'Plan it again' : 'Plan it') + ' →</button></div>';
    return '<div class="stack">' + demoRibbon() + guideHtml('deck') + head + tools + filters + body + foot + '</div>';
  }
  function swipeList() {
    var c = cd();
    return deckPool().filter(function (a) { return c.deck.picks.indexOf(a.id) < 0 && !state.deck.seen[a.id]; });
  }
  function swipeHtml() {
    var c = cd(), left = swipeList(), a = left[0];
    if (!a) return '<section class="card center"><p><b>That’s every idea for these filters.</b></p><div class="btns" style="justify-content:center"><button class="btn ghost" type="button" data-act="reseen">See the ones you passed again</button><button class="btn ghost" type="button" data-act="deckmode" data-v="list">See the list</button></div></section>';
    var ages = C.kidAges(c.setup);
    return '<section class="swipe" aria-label="One idea at a time"><div class="swipe-card" id="swipeCard" data-id="' + esc(a.id) + '" tabindex="0" aria-describedby="swipeHint">' +
      '<span class="kicon" aria-hidden="true">' + esc(KIND_ICON[a.k]) + '</span><h2>' + esc(a.t) + '</h2><p>' + esc(a.h) + '</p>' + tagsHtml(a, c) + needsHtml(a) +
      (ages.length && !C.suitsAges(a, ages) ? '<p class="small warnline">For ages ' + esc(a.a[0] + '-' + a.a[1]) + ' - check it suits everyone.</p>' : '') +
      '<span class="stamp yes" aria-hidden="true">Yes!</span><span class="stamp no" aria-hidden="true">Not now</span></div>' +
      '<p class="small muted center" id="swipeHint">' + esc(left.length + ' left') + ' · swipe right for yes, left to pass - or tap</p>' +
      '<div class="swipe-btns"><button class="btn big ghost" type="button" data-act="swno">✕ Not this time</button>' + (state.deck.last.length ? '<button class="btn ghost" type="button" data-act="swundo">Undo</button>' : '') + '<button class="btn big" type="button" data-act="swyes">♥ Yes please</button></div></section>';
  }
  function listHtml() {
    var c = cd(), pool = deckPool(), shown = 24 + state.deck.more;
    var picked = pool.filter(function (a) { return c.deck.picks.indexOf(a.id) >= 0; });
    var rest = pool.filter(function (a) { return c.deck.picks.indexOf(a.id) < 0; });
    var all = picked.concat(rest), vis = all.slice(0, Math.max(shown, picked.length));
    return '<div class="deckgrid">' + vis.map(function (a) {
      var on = c.deck.picks.indexOf(a.id) >= 0;
      return '<div class="dcard' + (on ? ' on' : '') + '"><button class="dtick" type="button" data-act="pick" data-id="' + esc(a.id) + '" aria-pressed="' + esc(on) + '"><span class="kicon" aria-hidden="true">' + esc(KIND_ICON[a.k]) + '</span><span class="dt"><b>' + esc(a.t) + '</b><span>' + esc(a.h) + '</span></span><span class="box" aria-hidden="true">' + (on ? '✓' : '+') + '</span></button>' + tagsHtml(a, c) + (a.src !== 'deck' ? '<button class="link-btn small" type="button" data-act="rmown" data-id="' + esc(a.id) + '">Remove from the deck</button>' : '') + '</div>';
    }).join('') + '</div>' + (all.length > vis.length ? '<button class="btn ghost block" type="button" data-act="moredeck">Show ' + esc(Math.min(24, all.length - vis.length)) + ' more of ' + esc(all.length - vis.length) + '</button>' : '');
  }
  function setPicks(next) { var c = cd(), n = C.clone(c); n.deck.picks = next; n.deckT = stamp(); return n; }
  function pick(id, on) {
    var c = cd(), p = c.deck.picks.slice(), i = p.indexOf(id);
    if (on && i < 0) p.push(id);
    if (!on && i >= 0) p.splice(i, 1);
    var next = setPicks(p);
    if (!on) {
      // Off the shut, unpinned days it was on; "Plan it again" fills the gap.
      C.datesOf(next).forEach(function (d) { var e = next.plan[d]; var inf = C.info(next, d); if (e && e.a === id && !inf.opened && !e.pin) next.plan[d] = { a: '', pin: false, t: stamp() }; });
    }
    return next;
  }
  function swipe(yes) {
    var card = $('#swipeCard');
    if (!card) return;
    var id = card.getAttribute('data-id');
    state.deck.last.push(id);
    if (yes) commit(pick(id, true), true); else state.deck.seen[id] = true;
    if (yes) say('Chosen.');
    var go2 = function () { keepPlace(draw); var n = $('#swipeCard'); if (n) try { n.focus({ preventScroll: true }); } catch (e) { /* fine */ } };
    if (REDUCED.matches) return go2();
    card.classList.add(yes ? 'fly-yes' : 'fly-no');
    setTimeout(go2, 220);
  }
  function bindSwipe() {
    var card = $('#swipeCard');
    if (!card) return;
    var x0 = null, dx = 0, id = null;
    card.addEventListener('pointerdown', function (e) { x0 = e.clientX; dx = 0; id = e.pointerId; try { card.setPointerCapture(id); } catch (er) { /* fine */ } });
    card.addEventListener('pointermove', function (e) {
      if (x0 === null) return;
      dx = e.clientX - x0;
      card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 18) + 'deg)';
      card.classList.toggle('lean-yes', dx > 40); card.classList.toggle('lean-no', dx < -40);
    });
    var end = function () {
      if (x0 === null) return;
      x0 = null;
      if (Math.abs(dx) > 90) { swipe(dx > 0); return; }
      card.style.transform = ''; card.classList.remove('lean-yes', 'lean-no');
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  /* ---------------- your own activity ---------------- */

  function segHtml(name, opts, cur) {
    return '<div class="seg2" role="group" aria-label="' + esc(name) + '">' + opts.map(function (o) { return '<button type="button" data-own="' + esc(name) + '" data-v="' + esc(o[0]) + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>';
  }
  function openOwn() {
    var c = cd(), th = C.themesFor(c.setup);
    var f = { tm: 'short', c: 'free', w: 'home', m: 'none', k: 'crafts', th: th[0], a0: 2, a1: 12 };
    function body(root) {
      $('.body', root).innerHTML = '<h2>Add your own</h2><p class="small muted">It goes in your deck and is planned like the others. Keep it to the activity - no names, addresses or links.</p>' +
        '<label class="field"><span>What</span><input class="input" id="ownT" maxlength="50" placeholder="Like: Make paper boats"></label>' +
        '<label class="field" style="margin-top:10px"><span>How, in a line</span><textarea class="input" id="ownH" maxlength="160" rows="2" placeholder="Fold them and race them in the bath"></textarea></label>' +
        '<p class="lab" style="margin-top:12px">How long</p>' + segHtml('tm', C.TIMES.map(function (x) { return [x, C.TIME_WORD[x]]; }), f.tm) +
        '<p class="lab" style="margin-top:12px">Cost</p>' + segHtml('c', C.COSTS.map(function (x) { return [x, C.COST_WORD[x]]; }), f.c) +
        (f.c !== 'free' ? '<label class="field" style="margin-top:8px"><span>About how much, in dollars</span><input class="input money" id="ownAmt" type="number" inputmode="decimal" min="0" max="500" step="0.5" value="' + esc(C.COST_DEFAULT[f.c] / 100) + '"></label>' : '') +
        '<p class="lab" style="margin-top:12px">Where</p>' + segHtml('w', C.WHERES.map(function (x) { return [x, C.WHERE_WORD[x]]; }), f.w) +
        '<p class="lab" style="margin-top:12px">Mess</p>' + segHtml('m', C.MESSES.map(function (x) { return [x, C.MESS_WORD[x]]; }), f.m) +
        '<div class="pair" style="margin-top:12px"><label class="field"><span>Kind</span><select class="input" id="ownK">' + C.LIKES.map(function (k) { return '<option value="' + esc(k) + '"' + (f.k === k ? ' selected' : '') + '>' + esc(C.LIKE_WORD[k]) + '</option>'; }).join('') + '</select></label>' +
        '<div class="pair tight"><label class="field"><span>From age</span><select class="input" id="ownA0">' + Array.from({ length: 18 }, function (_, a) { return '<option' + (a === f.a0 ? ' selected' : '') + '>' + a + '</option>'; }).join('') + '</select></label><label class="field"><span>To age</span><select class="input" id="ownA1">' + Array.from({ length: 18 }, function (_, a) { return '<option' + (a === f.a1 ? ' selected' : '') + '>' + a + '</option>'; }).join('') + '</select></label></div></div>' +
        '<p class="lab" style="margin-top:12px">What to buy or find (up to four)</p><div class="pair">' + [0, 1, 2, 3].map(function (i) { return '<input class="input" id="ownN' + i + '" maxlength="30" aria-label="Thing ' + (i + 1) + '">'; }).join('') + '</div>' +
        '<div id="ownErr"></div><div class="btns" style="margin-top:12px"><button class="btn" type="button" id="ownSave">Add it</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>';
      $$('[data-own]', root).forEach(function (b) {
        b.addEventListener('click', function () {
          var keep = { t: $('#ownT', root).value, h: $('#ownH', root).value };
          f[b.getAttribute('data-own')] = b.getAttribute('data-v');
          body(root); $('#ownT', root).value = keep.t; $('#ownH', root).value = keep.h;
        });
      });
      $('#ownSave', root).addEventListener('click', function () {
        var a0 = Number($('#ownA0', root).value), a1 = Number($('#ownA1', root).value);
        var amt = $('#ownAmt', root) ? Math.round(Number($('#ownAmt', root).value || 0) * 100) : 0;
        var raw = { id: 'c-' + rid(8), t: $('#ownT', root).value, h: $('#ownH', root).value, th: f.th, tm: f.tm, c: f.c, amt: f.c === 'free' ? 0 : Math.max(0, Math.min(C.LIMITS.amtMax, amt || 0)), w: f.w, m: f.m, k: $('#ownK', root).value, a: [Math.min(a0, a1), Math.max(a0, a1)], n: [0, 1, 2, 3].map(function (i) { return $('#ownN' + i, root).value; }).filter(function (x) { return x.trim(); }), src: 'own' };
        var errs = [], problem = C.bodyProblem(raw);
        var act = C.cleanActivity(raw, errs, true);
        if (problem || errs.length || !act) { showError(new Error(problem ? 'Keep it to the activity - ' + problem.charAt(0).toLowerCase() + problem.slice(1) : (!raw.t.trim() ? 'Give it a name.' : 'Check it - ' + errs[0])), $('#ownErr', root)); return; }
        var cur = cd();
        if (cur.deck.custom.length >= C.LIMITS.custom) { showError(new Error('Your deck holds up to ' + C.LIMITS.custom + ' of your own.'), $('#ownErr', root)); return; }
        var next = C.clone(cur);
        next.deck.custom.push(act); next.deck.picks.push(act.id); next.deckT = stamp();
        closeSheet(); commit(next); toast('Added and chosen: ' + act.t);
      });
    }
    sheet('<div class="body"></div>', body);
  }

  /* ---------------- the plan ---------------- */

  function planIt() {
    var c = cd();
    var r = C.replan(c, { seed: seed(), t: stamp() });
    state.report = r.report;
    commit(r.cd, true);
    go('plan');
  }
  function reportHtml() {
    var c = cd(), rep = state.report, out = '';
    var gone = C.unplaced(c);
    if (rep && rep.leftOut.length) {
      var budget = rep.leftOut.filter(function (x) { return x.why === 'budget'; }), rules = rep.leftOut.filter(function (x) { return x.why !== 'budget'; });
      var name = function (x) { var a = C.activity(c, x.id); return a ? a.t : ''; };
      out += '<div class="note warnbox"><p><b>' + esc(plural(rep.leftOut.length, 'choice') + ' didn’t fit') + '</b></p><ul>' +
        (budget.length ? '<li>' + esc('Over the budget: ' + budget.map(name).join(', ') + '.') + '</li>' : '') +
        (rules.length ? '<li>' + esc('No day left that suits ' + rules.map(name).join(', ') + ' - ' + (rules.some(function (x) { return x.why === 'full'; }) ? 'every door has something.' : 'the free evenings and weekends are taken.')) + '</li>' : '') + '</ul>' +
        '<div class="btns">' + (budget.length ? '<button class="btn small ghost" type="button" data-act="editsetup">Change the budget</button>' : '') + '<button class="btn small ghost" type="button" data-act="tab" data-tab="deck">Change the choices</button></div></div>';
    } else if (gone.length && Object.keys(c.plan).length) {
      out += '<div class="note"><p>' + esc(plural(gone.length, 'chosen activity', 'chosen activities') + ' on no day yet.') + '</p><button class="btn small" type="button" data-act="planit">Plan it again</button></div>';
    }
    return out;
  }
  function planHtml() {
    var c = cd(), t = today(), r = C.range(c.setup);
    if (!Object.keys(c.plan).length) return '<div class="stack">' + demoRibbon() + '<section class="card center"><h1>No plan yet</h1><p class="muted">Choose some activities first - Ajar places them on the days.</p><button class="btn" type="button" data-act="tab" data-tab="deck">Choose activities</button></section></div>';
    var b = C.budget(c), issues = C.checkPlan(c).filter(function (x) { return x.code !== 'empty'; }), empties = C.checkPlan(c).filter(function (x) { return x.code === 'empty'; });
    // Doors already opened are folded away: their days are settled.
    var weeks = [], byW = {}, opened = [];
    C.datesOf(c).forEach(function (d) {
      if (C.info(c, d).opened) { opened.push(d); return; }
      var w = C.weekStart(d); if (!byW[w]) { byW[w] = []; weeks.push(w); } byW[w].push(d);
    });
    var dayRow = function (d) {
      var inf = C.info(c, d), a = C.planned(c, d), ex = C.explain(c, d), e = c.plan[d] || {};
      var cls = 'day' + (inf.busy ? ' busy' : '') + (inf.weekend ? ' we' : '') + (state.sel === d ? ' sel' : '') + (inf.opened ? ' opened' : '') + (ex.warn ? ' warn' : '') + (d === t ? ' today' : '');
      return '<div class="' + cls + '"><button class="dsel" type="button" data-act="pickday" data-iso="' + esc(d) + '" aria-pressed="' + (state.sel === d) + '"><span class="dno">' + esc(inf.door) + '</span><span class="dbody"><span class="dd">' + esc(C.dayLabel(d)) + (inf.busy ? ' · busy' : '') + (inf.opened ? ' · opened' : '') + '</span><b class="dt">' + esc(a ? a.t : 'Nothing yet') + '</b><span class="why">' + esc(ex.text) + '</span></span></button>' +
        (inf.pin || inf.opened ? '' : '<button class="pinbtn" type="button" data-act="pin" data-iso="' + esc(d) + '" aria-pressed="' + esc(Boolean(e.pin)) + '" aria-label="' + esc((e.pin ? 'Unpin door ' : 'Pin door ') + inf.door) + '">' + (e.pin ? '📌' : '<span class="pinoff" aria-hidden="true">📌</span>') + '</button>') + '</div>';
    };
    var openedHtml = (opened.length ? '<details class="fold openedfold"><summary>' + esc(plural(opened.length, 'door') + ' opened already (' + C.dayLabel(opened[0]) + (opened.length > 1 ? ' to ' + C.dayLabel(opened[opened.length - 1]) : '') + ')') + '</summary><div class="week">' + opened.map(dayRow).join('') + '</div></details>' : '');
    var rows = weeks.map(function (w) { return '<section class="week"><h2 class="wk">' + esc('Week of ' + C.dayLabel(w)) + '</h2>' + byW[w].map(dayRow).join('') + '</section>'; }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('plan') + mergeNoteHtml() +
      '<div class="sec-head"><h1>The plan</h1><span class="muted">' + esc(r ? C.dayLabel(r.start) + ' to ' + C.dayLabel(r.end) : '') + '</span></div>' +
      '<p class="small muted" style="margin:0">Tap two days to swap them. Pin a day to keep it where it is when you shuffle.</p>' +
      '<div class="btns"><button class="btn" type="button" data-act="shuffle">Shuffle the unpinned</button><button class="btn ghost" type="button" data-act="tab" data-tab="deck">Change the choices</button><button class="btn ghost" type="button" data-act="toprint">Print</button></div>' +
      '<div id="refusal">' + refusalHtml() + '</div>' + reportHtml() +
      (empties.length ? '<div class="note"><p>' + esc(plural(empties.length, 'door') + ' with nothing behind ' + (empties.length === 1 ? 'it' : 'them') + '.') + '</p><button class="btn small" type="button" data-act="planit">Fill the gaps</button></div>' : '') +
      (issues.length ? '<div class="note warnbox"><p><b>Moved by hand against the rules:</b></p><ul>' + issues.slice(0, 6).map(function (x) { return '<li>' + esc(x.msg) + '</li>'; }).join('') + '</ul><button class="btn small ghost" type="button" data-act="shuffle">Let Ajar re-plan the unpinned</button></div>' : '') +
      '<div class="budgetline ' + (b.over ? 'over' : '') + '"><b>Budget</b> <span>' + esc(b.word) + '</span> <button class="link-btn" type="button" data-act="tab" data-tab="shop">Costs per door</button></div>' +
      openedHtml + '<div class="weeks">' + rows + '</div><p class="small" data-sync></p></div>';
  }
  function pickDay(d) {
    if (!state.sel) { state.sel = d; state.pending = null; keepPlace(draw); say('Door chosen. Tap another day to swap.'); return; }
    if (state.sel === d) { state.sel = ''; keepPlace(draw); return; }
    var a = state.sel;
    state.sel = '';
    doSwap(a, d, {});
  }
  function doSwap(d1, d2, o) {
    var r = C.swap(cd(), d1, d2, { t: stamp(), force: o.force, unpin: o.unpin });
    if (apply(r, { kind: 'swap', d1: d1, d2: d2 })) toast(r.msg);
  }
  function doWay() {
    var p = state.pending;
    if (!p) return;
    var w = p.r.way;
    state.pending = null;
    if (w.act === 'cancel') { state.sel = ''; keepPlace(draw); return; }
    if (w.act === 'setup') { editSetup(); return; }
    if (w.act === 'plan') { closeSheet(); go('plan'); return; }
    if (w.act === 'swap') { doSwap(p.ctx.d1, p.ctx.d2, w); return; }
    if (w.act === 'move') { doMove(p.ctx.from, p.ctx.to, w); return; }
    if (w.act === 'open') { openFlow(p.ctx.d || p.ctx.from); }
  }
  function editSetup() { var c = cd(); if (!c) return; state.draft = { setup: C.clone(c.setup), id: c.id }; go('setup'); }

  /* ---------------- the shopping list and the budget ---------------- */

  function shopHtml() {
    var c = cd(), t = today(), s = C.shopping(c, t), b = C.budget(c);
    var groups = s.groups.map(function (g) {
      var all = g.items.every(function (it) { return it.got; });
      return (all ? '<details class="card gotfold"><summary><span class="wk">' + esc(g.label) + '</span> <span class="pill ok">' + esc(g.items.length === 1 ? 'Got it' : 'All ' + g.items.length + ' got') + '</span></summary>' : '<section class="card"><h2 class="wk">' + esc(g.label) + '</h2>') + g.items.map(function (it) {
        var due = it.due === 'tomorrow' ? '<span class="pill warn">Buy by tomorrow</span>' : it.due === 'today' ? '<span class="pill warn">Buy today</span>' : it.due === 'late' ? '<span class="pill bad">Needed already</span>' : '';
        return '<label class="shoprow' + (it.got ? ' got' : '') + (it.due ? ' due-' + esc(it.due) : '') + '"><input type="checkbox" data-tick="' + esc(it.key) + '"' + (it.got ? ' checked' : '') + '><span class="sl"><b>' + esc(it.label) + '</b><small>' + esc('By ' + it.byLabel + ' · for door ' + it.uses.map(function (u) { return u.door; }).join(', ') + ': ' + it.uses[0].title + (it.uses.length > 1 ? ' and ' + plural(it.uses.length - 1, 'more') : '')) + '</small></span>' + due + '</label>';
      }).join('') + (all ? '</details>' : '</section>');
    }).join('');
    var costRows = b.rows.map(function (x) {
      var a = C.planned(c, x.iso);
      return '<tr><td>' + esc(x.door) + '</td><td class="wrap">' + esc(x.title) + '</td><td class="r"><label class="vh" for="amt-' + esc(x.iso) + '">Cost of ' + esc(x.title) + ' in dollars</label><input class="input n2" id="amt-' + esc(x.iso) + '" type="number" min="0" max="500" step="0.5" inputmode="decimal" data-amt="' + esc(a.id) + '" value="' + esc(x.cents / 100) + '"></td></tr>';
    }).join('');
    return '<div class="stack">' + demoRibbon() + guideHtml('shop') + mergeNoteHtml() +
      '<div class="sec-head"><h1>Shopping</h1><span class="muted">' + esc(s.items.length ? plural(s.left, 'thing') + ' to get' + (s.got ? ', ' + s.got + ' got' : '') : 'Nothing to buy') + '</span></div>' +
      '<p class="small muted" style="margin:0">Everything the plan needs, each by the day before it is first used.</p>' +
      (s.items.length ? '<div class="btns"><button class="btn" type="button" data-act="shareshop">Share the list</button><button class="btn ghost" type="button" data-act="toprint" data-what="fridge">Print it on the fridge plan</button></div>' : '') +
      '<div class="shop-grid"><div class="stack">' + (groups || '<section class="card"><p class="muted">Nothing on the plan needs buying.</p></section>') + '</div>' +
      '<section class="card"><h2>Budget</h2><p class="' + (b.over ? 'err' : 'okline') + '">' + esc(b.word) + '</p>' +
      (b.rows.length ? '<div class="tablewrap"><table class="t"><thead><tr><th>Door</th><th>Activity</th><th class="r">$</th></tr></thead><tbody>' + costRows + '<tr class="tot"><td></td><td>Total</td><td class="r">' + esc(C.money(b.total)) + '</td></tr></tbody></table></div><p class="small muted">Change an amount to what it will really cost you. ' + esc(C.budgetWord(c.setup)) + '.</p>' : '<p class="muted">Nothing on the plan costs money.</p>') +
      '</section></div></div>';
  }

  /* ---------------- the doors ---------------- */

  var STATUS_MARK = { done: '✓', skipped: '–', moved: '→' };
  function doorBtn(c, x, kid) {
    var lab = 'Door ' + x.n + ', ' + x.label + (x.state === 'today' ? ', today - tap to open' : x.state === 'shut' ? ', ' + x.opens.toLowerCase() : x.state === 'missed' ? ', not opened yet' : ', open' + (x.status ? ', ' + x.status : '') + (x.star ? ', a favourite' : ''));
    var big = x.n === C.datesOf(c).length;
    return '<button class="door st-' + esc(x.state) + (big ? ' big' : '') + (x.state === 'today' ? ' wiggle' : '') + '" type="button" data-act="' + (kid ? 'kiddoor' : 'door') + '" data-iso="' + esc(x.iso) + '" aria-label="' + esc(lab) + '">' +
      '<span class="inside" aria-hidden="true">' + (x.state === 'open' ? '<span class="in-n">' + esc(x.n) + '</span><span class="in-m">' + esc(STATUS_MARK[x.status] || '·') + '</span>' + (x.star ? '<span class="in-s">★</span>' : '') : '') + '</span>' +
      '<span class="leaf" aria-hidden="true"><span class="dn">' + esc(x.n) + '</span>' + (x.state === 'shut' && !kid ? '' : '') + '</span></button>';
  }
  function calHtml(c, kid) {
    var t = today(), ds = C.doors(c, t), order = C.layout(c), byN = {};
    ds.forEach(function (x) { byN[x.n] = x; });
    // The last door is twice as wide. Little decorations fill the cells the
    // last row would leave empty, for each column count the board can have
    // (it changes with the width), so the board is always a full rectangle.
    // The column count for each width (phone, middle, wide) is the one of a
    // few that leaves the fewest gaps.
    var cells = ds.length + 1, need = function (k) { return (k - cells % k) % k; };
    var best = function (ks) { return ks.reduce(function (a, k) { return need(k) < need(a) ? k : a; }); };
    var p = kid ? 3 : 4, m = best(kid ? [5, 4] : [5, 6]), w = best(kid ? [6, 5, 7] : [6, 5, 7, 8]);
    var most = Math.max(need(p), need(m), need(w)), deco = '';
    for (var i = 0; i < most; i++) deco += '<span class="deco d' + (i % 3) + (i < need(p) ? ' p' : '') + (i < need(m) ? ' m' : '') + (i < need(w) ? ' w' : '') + '" aria-hidden="true"></span>';
    return '<div class="cal look-' + esc(C.lookOf(c.setup)) + (kid ? ' kidcal' : '') + '"><div class="garland" aria-hidden="true"></div><div class="doors m' + esc(m) + ' w' + esc(w) + '">' + order.map(function (n) { return doorBtn(c, byN[n], kid); }).join('') + deco + '</div></div>';
  }
  function toGoWord(c) {
    var k = C.daysToGo(c, today());
    if (k > 1) return plural(k, 'sleep') + ' to ' + C.bigName(c.setup);
    if (k === 1) return C.bigName(c.setup) + ' is tomorrow!';
    if (k === 0) return 'It’s the day!';
    return 'The countdown is over';
  }
  function doorsHtml() {
    var c = cd(), t = today(), tx = C.door(c, t, t), rc = C.recap(c, t), hm = nowHM();
    var tonight = '';
    if (tx && tx.state === 'today') tonight = '<div class="tonight"><b>Door ' + esc(tx.n) + ' is waiting.</b> <span class="muted">Tap the wiggling door.</span></div>';
    else if (tx && tx.state === 'open') tonight = '<div class="tonight"><b>' + esc('Door ' + tx.n + ': ' + (tx.act ? tx.act.t : '')) + '</b> <button class="link-btn" type="button" data-act="door" data-iso="' + esc(t) + '">See it</button></div>';
    var missed = C.doors(c, t).filter(function (x) { return x.state === 'missed'; });
    var due = C.shopping(c, t).items.filter(function (it) { return it.due; });
    var dueHtml = due.length ? '<div class="note duebox"><p><b>' + esc(due.length === 1 ? 'To buy by ' + C.relDay(due[0].by, t) + ': ' + due[0].label : plural(due.length, 'thing') + ' to buy soon: ' + due.slice(0, 4).map(function (x) { return x.label; }).join(', ')) + '</b></p><button class="link-btn" type="button" data-act="tab" data-tab="shop">The shopping list</button></div>' : '';
    return '<div class="stack">' + demoRibbon() + guideHtml('doors') + mergeNoteHtml() +
      '<div class="doors-layout"><div class="dl-head stack"><div class="cal-head"><div><h1>' + esc(C.bigName(c.setup)) + '</h1><p class="togo">' + esc(toGoWord(c)) + '</p></div><p class="small muted nowline">' + esc(C.longDay(t)) + (state.demo ? ', ' + esc(C.clock(hm.h, hm.m)) : '') + '</p></div>' +
      (rc.over ? '<div class="note okbox"><p><b>' + esc(rc.opened === rc.doors ? 'Every door is open.' : 'The countdown is over.') + '</b> See how it went.</p><button class="btn small" type="button" data-act="tab" data-tab="recap">The recap</button></div>' : '') +
      tonight + dueHtml + '</div><div class="dl-cal">' + calHtml(c, false) + '</div><div class="dl-side stack">' +
      (missed.length ? '<p class="small muted" style="margin:0">' + esc(plural(missed.length, 'earlier door') + ' not opened yet - ' + (missed.length === 1 ? 'it opens' : 'they open') + ' any time.') + '</p>' : '') +
      '<p class="legend small muted"><span>✓ done</span><span>– skipped</span><span>→ moved</span><span>★ favourite</span></p>' +
      '<div class="btns"><button class="btn ghost" type="button" data-act="kid">Kid mode on this phone</button><button class="btn ghost" type="button" data-act="toprint">Print the door cards</button></div>' +
      '<p class="small" data-sync></p></div></div></div>';
  }
  /** Open a door: a hinged swing and a small burst (reduced motion: a fade
   *  and words), then what is behind it. A door that has not come yet stays
   *  shut - a grown-up can peek in the plan. */
  function openFlow(d, kid) {
    var c = cd(), t = today(), x = C.door(c, d, t);
    if (!x) return;
    if (x.state === 'open') { if (kid) kidShow(d); else doorSheet(d); return; }
    if (x.locked) {
      if (kid) { state.kidMsg = 'Door ' + x.n + ' ' + x.opens.replace(/^Opens/, 'opens') + '. Not yet!'; kidDraw(); return; }
      var r = C.openDoor(c, d, t, stamp());
      sheet('<h2>' + esc('Door ' + x.n + ' is shut') + '</h2><p>' + esc(r.msg) + '</p><p class="small muted">No peeking! A grown-up can see the whole plan.</p><div class="btns"><button class="btn" type="button" data-act="peek">' + esc(r.way.label) + '</button><button class="btn ghost" type="button" data-act="closesheet">OK</button></div>');
      return;
    }
    var root = kid ? $('#kid') : document;
    var btn = $('.door[data-iso="' + d + '"]', root);
    var done = function () {
      var r2 = C.openDoor(cd(), d, t, stamp());
      if (!r2.ok) return;
      commit(r2.cd, true);
      say('Door ' + x.n + ' is open.');
      if (kid) { kidDraw(); kidShow(d); } else { keepPlace(draw); doorSheet(d); }
    };
    if (!btn) return done();
    if (REDUCED.matches) { btn.classList.add('opening-fade'); setTimeout(done, 260); return; }
    btn.classList.add('opening');
    var burst = document.createElement('span');
    burst.className = 'burst'; burst.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 10; i++) { var s = document.createElement('i'); s.style.setProperty('--a', (i * 36) + 'deg'); burst.appendChild(s); }
    btn.appendChild(burst);
    setTimeout(done, 820);
  }
  function behindHtml(c, x, kid) {
    var a = x.act;
    if (!a) return '<p class="muted">A surprise - nothing planned here yet.</p>';
    var moved = x.status === 'moved';
    return '<div class="behind look-' + esc(C.lookOf(c.setup)) + '"><span class="kicon" aria-hidden="true">' + esc(a.filler ? { joke: '😄', treat: '🎁', note: '💌' }[a.filler] : a.src === 'pin' ? '📌' : KIND_ICON[a.k]) + '</span>' +
      (moved ? '<p class="small"><b>' + esc('Moved to ' + C.dayLabel(x.to) + '.') + '</b> Instead tonight:</p>' : '') +
      '<h3>' + esc(a.t) + '</h3><p class="how">' + esc(a.h) + '</p>' +
      (a.answer ? '<details class="answer"><summary>The answer</summary><p>' + esc(a.answer) + '</p></details>' : '') +
      (kid ? '' : (a.filler || a.src === 'pin' ? '' : tagsHtml(a, c) + needsHtml(a))) + '</div>';
  }
  function photoLine() { return '<p class="tiny muted photoline">Photos stay on this phone - shrunk, with the location taken out. Never sent, never synced.</p>'; }
  function doorSheet(d) {
    var c = cd(), t = today(), x = C.door(c, d, t);
    if (!x) return;
    var moveDays = C.datesOf(c).filter(function (e) { var y = C.door(c, e, t); var inf = C.info(c, e); return C.dayOf(e) > C.dayOf(t) && C.dayOf(e) > C.dayOf(d) && y.state === 'shut' && !inf.pin; });
    var html = '<h2>' + esc('Door ' + x.n + ' · ' + x.label) + '</h2>' + (state.demo ? '<p class="tiny muted">Made-up example.</p>' : '') + behindHtml(c, x, false) +
      (x.status === 'moved' ? '' : '<div class="doorbtns" role="group" aria-label="How did it go?">' +
        '<button class="btn" type="button" data-act="status" data-v="done" data-iso="' + esc(d) + '" aria-pressed="' + (x.status === 'done') + '">✓ Done</button>' +
        '<button class="btn ghost" type="button" data-act="status" data-v="skipped" data-iso="' + esc(d) + '" aria-pressed="' + (x.status === 'skipped') + '">Skipped</button>' +
        '<button class="btn ghost" type="button" data-act="star" data-iso="' + esc(d) + '" aria-pressed="' + esc(x.star) + '">' + (x.star ? '★ Favourite' : '☆ Favourite') + '</button></div>') +
      (x.status === '' && x.act && x.act.src !== 'pin' && moveDays.length ? '<details class="fold" id="moveFold"><summary>Not tonight? Move it to another day</summary><p class="small muted">It swaps with what that day has - often a little filler, which comes here instead.</p><div class="chips">' + moveDays.slice(0, 14).map(function (e) { var a2 = C.planned(c, e); return '<button class="chip" type="button" data-act="moveto" data-from="' + esc(d) + '" data-to="' + esc(e) + '">' + esc(C.dayLabel(e) + (a2 && a2.filler ? ' (a filler)' : '')) + '</button>'; }).join('') + '</div></details>' : '') +
      '<div id="doorRefusal"></div>' +
      (x.status === 'done' ? '<div class="photo-slot" id="photoSlot"></div>' : '');
    sheet(html, function (root) { if (x.status === 'done') drawPhotoSlot($('#photoSlot', root), d); });
  }
  function setDoor(d, fn) {
    var r = fn(cd());
    if (!r.ok) { state.pending = { r: r, ctx: { kind: 'door', d: d } }; var box = $('#doorRefusal'); if (box) drawRefusal(box); return; }
    commit(r.cd, true); keepPlace(draw); doorSheet(d);
  }
  function doMove(from, to, o) {
    var r = C.move(cd(), from, to, { t: stamp(), today: today(), force: o.force, unpin: o.unpin });
    if (!r.ok) { state.pending = { r: r, ctx: { kind: 'move', from: from, to: to } }; var box = $('#doorRefusal'); if (box) drawRefusal(box); else keepPlace(draw); return; }
    state.pending = null; commit(r.cd, true); keepPlace(draw); doorSheet(from); toast(r.msg);
  }

  /* ---------------- photos: on this phone only ---------------- */

  function redraw(img, max, q) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, s = Math.min(1, max / Math.max(w, h));
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
    var g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);
  }
  /** A photo redrawn through a canvas, which drops its EXIF - location
   *  included - before it is kept. */
  function prepPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('That isn’t a photo.'));
      var url = URL.createObjectURL(file), img = new Image();
      img.addEventListener('load', function () {
        try { var full = redraw(img, 1280, 0.8), thumb = redraw(img, 320, 0.7); URL.revokeObjectURL(url); resolve({ full: full, thumb: thumb, at: stamp() }); } catch (e) { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); });
      img.src = url;
    });
  }
  function photoOf(d) {
    if (state.demo) return Promise.resolve(D.PHOTOS[d] ? { full: D.PHOTOS[d], thumb: D.PHOTOS[d] } : null);
    return real.photoGet(state.curId, d).catch(function () { return null; });
  }
  function drawPhotoSlot(el, d) {
    if (!el) return;
    photoOf(d).then(function (p) {
      el.innerHTML = (p ? '<img class="photo" alt="' + esc('A photo from door ' + (C.datesOf(cd()).indexOf(d) + 1)) + '" src="' + esc(p.thumb) + '">' : '') +
        (state.demo ? '<p class="small muted">The example’s photos are drawings. Your own stay on your phone.</p>' :
          '<div class="btns"><label class="btn ghost filepick">' + (p ? 'Change the photo' : '📷 Add a photo') + '<input type="file" accept="image/*" data-photo="' + esc(d) + '"></label>' + (p ? '<button class="btn ghost small" type="button" data-act="rmphoto" data-iso="' + esc(d) + '">Remove it</button>' : '') + '</div>') + photoLine();
    });
  }
  function fillPhotos() {
    $$('[data-thumb]').forEach(function (img) {
      var d = img.getAttribute('data-thumb');
      photoOf(d).then(function (p) {
        if (!p || !document.body.contains(img)) return;
        img.src = p.thumb;
        var fig = img.closest('figure'); if (fig) fig.hidden = false;
        var none = $('[data-nophotos]'); if (none) none.hidden = true;
      });
    });
  }

  /* ---------------- kid mode on this phone ---------------- */

  function kidOn() {
    if (!cd()) return;
    state.kidMsg = ''; state.kidQ = null; state.kidOpen = '';
    if (!state.demo) { state.device.kid = true; saveDevice(); }
    closeSheet(true);
    $('#kid').hidden = false; document.body.classList.add('kid-on');
    kidDraw();
    try { $('#kid .kid-top b').focus(); } catch (e) { /* fine */ }
  }
  function kidOff() {
    $('#kid').hidden = true; $('#kid').innerHTML = ''; document.body.classList.remove('kid-on');
    if (!state.demo) { state.device.kid = false; saveDevice(); }
    keepPlace(draw);
  }
  function kidDraw() {
    var c = cd(), k = $('#kid');
    if (!c || k.hidden) return;
    var x = state.kidOpen ? C.door(c, state.kidOpen, today()) : null;
    var q = state.kidQ;
    k.className = 'kid look-' + C.lookOf(c.setup);
    k.innerHTML = '<div class="kid-top"><b tabindex="-1">' + esc(C.bigName(c.setup)) + '</b><span>' + esc(toGoWord(c)) + '</span><button class="kid-exit" type="button" data-act="kidexit">Grown-ups</button></div>' +
      (state.demo ? '<p class="kid-demo">Made-up example</p>' : '') +
      (state.kidMsg ? '<p class="kid-msg" role="status">' + esc(state.kidMsg) + '</p>' : '') +
      (q ? '<div class="kid-q" role="group" aria-label="A question for a grown-up"><p><b>Grown-ups: what is ' + esc(q.text) + '?</b></p><div class="kid-choices">' + q.choices.map(function (n) { return '<button type="button" data-act="kidans" data-v="' + esc(n) + '">' + esc(n) + '</button>'; }).join('') + '</div><button class="link-btn" type="button" data-act="kidstay">Stay in kid mode</button></div>' : '') +
      (x ? '<div class="kid-behind"><p class="kid-n">' + esc('Door ' + x.n + ' · ' + x.label) + '</p>' + behindHtml(c, x, true) + '<button class="btn big" type="button" data-act="kidclose">Close the door</button></div>' : calHtml(c, true));
  }
  function kidShow(d) { state.kidOpen = d; state.kidMsg = ''; kidDraw(); }

  /* ---------------- print: door cards and the fridge plan ---------------- */

  function paper() { return state.paper || state.device.paper || C.paperFor(LOCALE); }
  function cardsSheetHtml(c, cs, paperId) {
    var g = C.cardGrid(paperId), P = g.paper;
    return '<div class="psheet" style="width:' + esc(P.w) + 'mm;height:' + esc(P.h) + 'mm">' +
      '<svg class="cuts" viewBox="0 0 ' + esc(P.w) + ' ' + esc(P.h) + '" width="' + esc(P.w) + 'mm" height="' + esc(P.h) + 'mm" aria-hidden="true">' + g.cuts.map(function (l) { return '<line x1="' + esc(l.x1) + '" y1="' + esc(l.y1) + '" x2="' + esc(l.x2) + '" y2="' + esc(l.y2) + '"/>'; }).join('') + '</svg>' +
      cs.map(function (k, i) {
        var b = g.cards[i];
        return '<div class="pcard' + (k.filler ? ' pf' : '') + '" style="left:' + esc(b.x) + 'mm;top:' + esc(b.y) + 'mm;width:' + esc(b.w) + 'mm;height:' + esc(b.h) + 'mm"><div class="pc-n">' + esc(k.n) + '</div><div class="pc-b"><div class="pc-d">' + esc(k.day) + '</div><div class="pc-t">' + esc(k.title) + '</div><div class="pc-h">' + esc(k.filler === 'joke' ? k.how.replace(k.answer, '').trim() : k.how) + '</div>' + (k.answer ? '<div class="pc-a">' + esc(k.answer) + '</div>' : '') + (k.needs.length ? '<div class="pc-x">You need: ' + esc(k.needs.join(', ')) + '</div>' : '') + (state.demo ? '<div class="pc-demo">Made-up example</div>' : '') + '</div></div>';
      }).join('') + '<span class="pfoot">' + esc(C.bigName(c.setup) + ' · door cards · cut along the dashed lines') + '</span></div>';
  }
  function cardsHtml(c, paperId) { return C.sheets(c).map(function (cs) { return cardsSheetHtml(c, cs, paperId); }).join(''); }
  function fridgeHtml(c, paperId) {
    var P = C.PAPERS[paperId], f = C.fridge(c), s = C.shopping(c, today()), r = C.range(c.setup);
    // The weeks share what the page has left after the heading, the
    // shopping (three columns) and the footer, between 18 and 40 mm a row.
    var small = s.items.length > 30 || f.weeks.length > 5;
    var shopH = s.items.length ? 8 + Math.ceil(s.items.length / 3) * (small ? 3.4 : 3.8) : 0;
    var rowH = Math.max(18, Math.min(40, Math.floor((P.h - 20 - 16 - 8 - shopH - 12) / Math.max(1, f.weeks.length))));
    return '<div class="psheet fridge' + (small ? ' small' : '') + '" style="width:' + esc(P.w) + 'mm;height:' + esc(P.h) + 'mm;--row:' + esc(rowH) + 'mm"><div class="fr-in">' +
      '<div class="fr-head"><b>' + esc(C.bigName(c.setup)) + '</b><span>' + esc(r ? C.dayLabel(r.start) + ' to ' + C.dayLabel(r.end) + ' · ' + plural(r.doors, 'door') : '') + '</span>' + (state.demo ? '<span class="pc-demo">Made-up example</span>' : '') + '</div>' +
      '<table class="fr-grid"><thead><tr>' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (w) { return '<th>' + esc(w) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      f.weeks.map(function (w) { return '<tr>' + w.map(function (x) { return x.blank ? '<td class="blank"><span class="fd">' + esc(x.day) + '</span></td>' : '<td' + (x.busy ? ' class="busy"' : '') + '><span class="fd">' + esc(x.day) + '</span><span class="fn">' + esc(x.n) + '</span><span class="ft">' + esc(x.title) + '</span>' + (x.needs ? '<span class="fx">needs shopping</span>' : '') + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table>' +
      (s.items.length ? '<div class="fr-shop"><b>Shopping - buy by</b><ul>' + s.items.map(function (it) { return '<li><i>' + (it.got ? '✓' : '') + '</i>' + esc(it.label) + ' <span>' + esc(it.byLabel) + '</span></li>'; }).join('') + '</ul></div>' : '') +
      '<div class="fr-foot">' + esc('Busy evenings are shaded. Made with Ajar.') + '</div></div></div>';
  }
  function printHtml() {
    var c = cd(), p = paper();
    return '<div class="stack">' + demoRibbon() + guideHtml('print') +
      '<div class="sec-head"><h1>Print</h1><div class="seg2 two" role="group" aria-label="Paper"><button type="button" data-act="paper" data-v="letter" aria-pressed="' + (p === 'letter') + '">Letter</button><button type="button" data-act="paper" data-v="a4" aria-pressed="' + (p === 'a4') + '">A4</button></div></div>' +
      '<div class="printgrid"><section class="card"><h2>Door cards</h2><p class="small muted">' + esc(plural(C.datesOf(c).length, 'card') + ', 8 to a sheet with cut lines - ' + plural(C.sheets(c).length, 'sheet') + '. Drop them into a calendar with pockets or numbered envelopes.') + '</p><div class="preview" data-fit><div class="scaler">' + cardsSheetHtml(c, C.sheets(c)[0] || [], p) + '</div></div><button class="btn" type="button" data-act="print" data-what="cards">Print the door cards</button></section>' +
      '<section class="card"><h2>The fridge plan</h2><p class="small muted">One page: every day and its activity, and the shopping with buy-by dates.</p><div class="preview" data-fit><div class="scaler">' + fridgeHtml(c, p) + '</div></div><button class="btn" type="button" data-act="print" data-what="fridge">Print the fridge plan</button></section></div></div>';
  }
  function fitPreviews() {
    $$('[data-fit]').forEach(function (box) {
      var sc = $('.scaler', box), sh = $('.psheet', box);
      if (!sc || !sh) return;
      var k = Math.min(1, (box.clientWidth - 2) / sh.offsetWidth);
      sc.style.transform = 'scale(' + k + ')';
      box.style.height = Math.ceil(sh.offsetHeight * k + 4) + 'px';
    });
  }
  function doPrint(what) {
    var c = cd(), p = paper();
    var style = $('#pageStyle');
    if (!style) { style = document.createElement('style'); style.id = 'pageStyle'; document.head.appendChild(style); }
    style.textContent = '@page { size: ' + C.PAPERS[p].css + ' portrait; margin: 0; }';
    $('#print').innerHTML = what === 'fridge' ? fridgeHtml(c, p) : cardsHtml(c, p);
    var t = document.title;
    document.title = C.bigName(c.setup) + (what === 'fridge' ? ' - fridge plan' : ' - door cards');
    setTimeout(function () { try { window.print(); } catch (e) { /* the page still holds them */ } document.title = t; }, 60);
  }

  /* ---------------- the end: the recap and its card ---------------- */

  function recapHtml() {
    var c = cd(), t = today(), r = C.recap(c, t);
    var grid = '<div class="tickgrid" aria-label="' + esc(r.opened + ' of ' + r.doors + ' doors opened') + '">' + r.grid.map(function (g) { return '<span class="tk tk-' + (g.status || (g.open ? 'open' : 'shut')) + '" title="' + esc('Door ' + g.n) + '"><b>' + esc(g.n) + '</b>' + (g.status ? '<i>' + esc(STATUS_MARK[g.status]) + '</i>' : '') + (g.star ? '<em>★</em>' : '') + '</span>'; }).join('') + '</div>';
    var doneDays = r.grid.filter(function (g) { return g.status === 'done'; });
    // Only the done doors that have a photo on this phone show; the rest stay hidden.
    var photos = doneDays.map(function (g) { var a = C.planned(c, g.iso); return '<figure class="rphoto" hidden><img alt="' + esc('Door ' + g.n + ': ' + (a ? a.t : '')) + '" data-thumb="' + esc(g.iso) + '"><figcaption>' + esc(g.n + ' · ' + (a ? a.t : '')) + '</figcaption></figure>'; }).join('');
    return '<div class="stack">' + demoRibbon() +
      '<div class="sec-head"><h1>' + esc(r.over ? 'How it went' : 'So far') + '</h1><span class="muted">' + esc(C.bigName(c.setup)) + '</span></div>' +
      (r.over ? '' : '<p class="small muted" style="margin:0">' + esc('The recap is all here once the last door is open or the day has passed. ' + plural(r.doors - r.opened, 'door') + ' still to open.') + '</p>' + (state.demo ? '<div class="btns"><button class="btn ghost" type="button" data-act="demoend">See how the example ends</button></div>' : '')) +
      '<div class="tiles"><div class="tile"><span class="tv">' + esc(r.opened) + '</span><span class="tl">opened</span></div><div class="tile"><span class="tv">' + esc(r.done) + '</span><span class="tl">done</span></div><div class="tile"><span class="tv">' + esc(r.skipped) + '</span><span class="tl">skipped</span></div><div class="tile"><span class="tv">' + esc(r.stars) + '</span><span class="tl">' + (r.stars === 1 ? 'favourite' : 'favourites') + '</span></div></div>' +
      '<div class="recap-grid"><section class="card"><h2>Every door</h2>' + grid + (r.favourites.length ? '<h3 style="margin-top:14px">Favourites</h3><ul class="favs">' + r.favourites.map(function (f) { return '<li>★ ' + esc(f.title) + ' <span class="muted">door ' + esc(f.n) + '</span></li>'; }).join('') + '</ul>' : '') + '</section>' +
      '<section class="card"><h2>Photos on this phone</h2>' + (doneDays.length ? '<div class="rphotos">' + photos + '</div>' : '') + '<p class="muted" data-nophotos>Done doors with a photo show up here.</p>' + photoLine() + '</section></div>' +
      '<section class="card"><h2>The recap card</h2><p class="small muted">A picture of how it went, for the family chat - drawn on this phone, shared as a picture. Never a link, never uploaded.</p>' +
      '<label class="check"><input type="checkbox" data-recap="photo"' + (state.recap.photo ? ' checked' : '') + '> Include a photo (off unless you tick it - a picture of people is theirs to choose to send)</label>' +
      '<div id="rcOut"></div><div class="btns"><button class="btn" type="button" data-act="drawcard">' + (state.recap.url ? 'Draw it again' : 'Make the card') + '</button><button class="btn" type="button" data-act="sharecard"' + (state.recap.blob ? '' : ' hidden') + ' id="rcShare">' + (canShareFiles() ? 'Share it' : 'Download it') + '</button></div></section></div>';
  }
  function canShareFiles() {
    try { return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; }
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  var CARD_LOOK = { festive: ['#1f4d3a', '#7a1f1f', '#fbf4e6', '#7f1d1d'], winter: ['#1d3a5c', '#3b5f8a', '#f2f7fb', '#1d3a5c'], birthday: ['#7a1f5c', '#c2410c', '#fff4fa', '#7a1f5c'], trip: ['#134e4a', '#1d4e89', '#f3faf8', '#134e4a'], any: ['#5b3a14', '#9a3412', '#fffaf0', '#5b3a14'] };
  function loadImg(src) { return new Promise(function (r) { var im = new Image(); im.addEventListener('load', function () { r(im); }); im.addEventListener('error', function () { r(null); }); im.src = src; }); }
  function star(g, cx, cy, r) { g.beginPath(); for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; g.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a)); } g.closePath(); g.fill(); }
  /** The recap card, 1080 x 1350, drawn here: the name, the counts, every
   *  door as a little tick, the favourites, and a photo only if ticked. */
  function drawRecapCard() {
    var c = cd(), d = C.recapCard(c, today()), L = CARD_LOOK[C.lookOf(c.setup)];
    var withPhoto = state.recap.photo;
    var firstDone = d.grid.filter(function (x) { return x.status === 'done'; });
    var photoP = withPhoto ? (function next(i) { if (i >= firstDone.length) return Promise.resolve(null); return photoOf(firstDone[i].iso).then(function (p) { return p ? loadImg(p.full) : next(i + 1); }); }(0)) : Promise.resolve(null);
    return photoP.then(function (photo) {
      var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350;
      var g = cv.getContext('2d'), F = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      var grad = g.createLinearGradient(0, 0, 1080, 1350); grad.addColorStop(0, L[0]); grad.addColorStop(1, L[1]);
      g.fillStyle = grad; g.fillRect(0, 0, 1080, 1350);
      g.fillStyle = 'rgba(255,255,255,.05)';
      for (var y0 = 30; y0 < 1350; y0 += 46) for (var x0 = (y0 / 46) % 2 ? 30 : 53; x0 < 1080; x0 += 46) { g.beginPath(); g.arc(x0, y0, 3, 0, Math.PI * 2); g.fill(); }
      var m = function (font) { g.font = font; return function (s) { return g.measureText(s).width; }; };
      g.textBaseline = 'alphabetic'; g.fillStyle = '#ffffff';
      g.font = '900 76px ' + F; g.fillText(C.fitText(m('900 76px ' + F), d.title, 912), 84, 150);
      g.fillStyle = '#f6efe3'; g.font = '700 34px ' + F; g.fillText(C.fitText(m('700 34px ' + F), d.sub + (state.demo ? ' · Made-up example' : ''), 912), 84, 204);
      // The counts.
      d.counts.forEach(function (k, i) {
        var x = 84 + i * 234;
        g.fillStyle = 'rgba(255,255,255,.14)'; roundRect(g, x, 250, 210, 150, 26); g.fill();
        g.fillStyle = '#ffffff'; g.font = '900 66px ' + F; g.fillText(String(k[0]), x + 24, 330);
        g.fillStyle = '#f6efe3'; g.font = '700 28px ' + F; g.fillText(C.fitText(m('700 28px ' + F), k[1], 170), x + 24, 376);
      });
      // Every door as a little tick.
      // The grid gets what the favourites and the footer leave: the
      // favourites need a heading, a line each and maybe "+N more".
      var n = d.grid.length, cols = n > 24 ? 8 : 6, cell = cols === 8 ? 106 : 140, gap = cols === 8 ? 10 : 14, rows = Math.ceil(n / cols);
      var favH = d.favourites.length ? 60 + d.favourites.length * 52 + (d.more ? 44 : 0) : 0, gy = 440;
      var room = 1240 - gy - favH - 40;
      if (rows * (cell + gap) > room) cell = Math.max(60, Math.floor(room / rows) - gap);
      var gw = cols * cell + (cols - 1) * gap, gx = (1080 - gw) / 2;
      d.grid.forEach(function (x, i) {
        var cx = gx + (i % cols) * (cell + gap), cy = gy + Math.floor(i / cols) * (cell + gap);
        g.fillStyle = x.open ? L[2] : 'rgba(255,255,255,.18)'; roundRect(g, cx, cy, cell, cell, 18); g.fill();
        g.fillStyle = x.open ? L[3] : '#ffffff'; g.font = '800 ' + Math.round(cell * 0.24) + 'px ' + F; g.fillText(String(x.n), cx + 12, cy + Math.round(cell * 0.3));
        g.strokeStyle = L[3]; g.lineWidth = Math.max(6, cell * 0.07); g.lineCap = 'round'; g.lineJoin = 'round';
        var mx = cx + cell * 0.5, my = cy + cell * 0.62, s = cell * 0.2;
        if (x.status === 'done') { g.beginPath(); g.moveTo(mx - s, my); g.lineTo(mx - s * 0.2, my + s * 0.8); g.lineTo(mx + s * 1.2, my - s * 0.9); g.stroke(); }
        else if (x.status === 'skipped') { g.beginPath(); g.moveTo(mx - s, my); g.lineTo(mx + s, my); g.stroke(); }
        else if (x.status === 'moved') { g.beginPath(); g.moveTo(mx - s, my); g.lineTo(mx + s, my); g.moveTo(mx + s * 0.3, my - s * 0.7); g.lineTo(mx + s, my); g.lineTo(mx + s * 0.3, my + s * 0.7); g.stroke(); }
        if (x.star) { g.fillStyle = '#f4b73a'; star(g, cx + cell - 22, cy + 22, 14); }
      });
      var fy = gy + rows * (cell + gap) + 40;
      // Favourites, and a photo beside them only if ticked.
      var fw = photo ? 560 : 912;
      if (d.favourites.length) {
        g.fillStyle = '#ffffff'; g.font = '800 36px ' + F; g.fillText('Favourites', 84, fy + 10);
        d.favourites.forEach(function (f, i) {
          g.fillStyle = '#f4b73a'; star(g, 100, fy + 58 + i * 52, 14);
          g.fillStyle = '#ffffff'; g.font = '700 32px ' + F; g.fillText(C.fitText(m('700 32px ' + F), f, fw - 50), 128, fy + 70 + i * 52);
        });
        if (d.more) { g.fillStyle = '#f6efe3'; g.font = '700 28px ' + F; g.fillText('+' + d.more + ' more', 128, fy + 70 + d.favourites.length * 52); }
      }
      if (photo) {
        var pw = 330, ph = Math.round(pw * (photo.naturalHeight || photo.height) / Math.max(1, photo.naturalWidth || photo.width));
        ph = Math.min(ph, 1250 - fy); var px = 1080 - 84 - pw;
        g.save(); roundRect(g, px, fy - 20, pw, ph, 22); g.clip(); g.drawImage(photo, px, fy - 20, pw, ph); g.restore();
      }
      g.fillStyle = '#f6efe3'; g.font = '700 28px ' + F;
      g.fillText(C.fitText(m('700 28px ' + F), 'Made with Ajar · ' + location.host + BASE.replace(/\/$/, ''), 912), 84, 1300);
      return new Promise(function (resolve) { try { cv.toBlob(function (b) { resolve(b); }, 'image/png'); } catch (e) { resolve(null); } });
    });
  }

  /* ---------------- more ---------------- */

  function moreHtml() {
    var c = cd();
    return '<div class="stack narrow">' + demoRibbon() + '<div class="sec-head"><h1>' + esc(C.bigName(c.setup)) + '</h1><span class="muted small">' + esc(C.rangeLine(c.setup)) + '</span></div>' +
      '<div class="morelist">' +
      '<button class="morebtn" type="button" data-act="editsetup"><b>Setup</b><span>The big day, who’s in, busy evenings, money and time</span></button>' +
      '<button class="morebtn" type="button" data-act="toprint"><b>Print</b><span>Door cards, 8 a sheet, and the fridge plan</span></button>' +
      '<button class="morebtn" type="button" data-act="tab" data-tab="recap"><b>The recap</b><span>Doors opened, favourites, photos and a card to share</span></button>' +
      '<button class="morebtn" type="button" data-act="kid"><b>Kid mode on this phone</b><span>Just the doors - leaving it asks a grown-up sum</span></button>' +
      (state.demo ? '<button class="morebtn" type="button" data-act="leavedemo"><b>Leave the example</b><span>Nothing from it is kept</span></button>' : '<button class="morebtn" type="button" data-act="calendars"><b>Your countdowns</b><span>Up to three on this phone</span></button>') +
      '</div><p class="small" data-sync></p></div>';
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

  /* ---------------- the AI: "More ideas for us" ---------------- */

  var WHY_AI = 'More ideas uses a little AI credit, so it needs a free account (it comes with $2).';
  var SENT_LINE = 'What is sent: the kids’ ages, the chips you picked, your budget and the month - never names, never your own ideas.';
  /** The body as JSON, one field a line - the same object api() sends. */
  function sentText(body) { return '{\n' + Object.keys(body).map(function (k) { return '  "' + k + '": ' + JSON.stringify(body[k]).replace(/,/g, ', '); }).join(',\n') + '\n}'; }
  function openAi() {
    var c = cd();
    if (!state.ai.likes.length) state.ai.likes = [];
    function body(root) {
      var b = $('.body', root), payload = C.ideasPayload(c, state.ai.likes, state.ai.count);
      var chips = '<div class="chips">' + C.LIKES.map(function (k) { return '<button class="chip" type="button" data-like="' + esc(k) + '" aria-pressed="' + (state.ai.likes.indexOf(k) >= 0) + '">' + esc(C.LIKE_WORD[k]) + '</button>'; }).join('') + '</div>';
      var intro = '<h2>✨ More ideas for us</h2><p>AI suggests small activities that suit your kids’ ages and what they like. You read each one and add the ones you want - nothing is added on its own.</p>';
      var form = '<p class="lab">They like</p>' + chips + '<label class="field" style="margin-top:10px"><span>How many ideas</span><select class="input" id="aiCount">' + [4, 6, 8, 10, 12].map(function (n) { return '<option value="' + n + '"' + (state.ai.count === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
        '<p class="sentline"><b>' + esc(SENT_LINE) + '</b></p><details class="fold"><summary>Exactly what will be sent</summary><pre class="sent-pre" tabindex="0" id="aiSent">' + esc(sentText(payload)) + '</pre><p class="small muted">The ids are the built-in deck’s, so it does not repeat what you chose. Your own ideas and every name stay on this phone.</p></details>';
      if (state.demo) {
        b.innerHTML = intro + form + '<div class="note" style="margin-top:12px"><p style="margin:0">This is the example, so here is a made-up answer to the example’s request - run through the same checks as a real one. Make your own calendar to ask for real.</p></div><div class="btns" style="margin-top:12px"><button class="btn" type="button" id="aiExample">See the example ideas</button></div>';
      } else if (!signedIn()) {
        b.innerHTML = intro + form + '<div class="note" style="margin-top:12px"><p style="margin:0">' + esc(WHY_AI) + ' One account works across every app on this site. The built-in deck and everything else here stay free with no account.</p></div><div class="btns" style="margin-top:12px"><button class="btn" type="button" id="aiJoin">Create a free account</button><button class="btn ghost" type="button" id="aiExample">See an example first</button></div>';
        $('#aiJoin', root).addEventListener('click', function () { openAccount(WHY_AI, openAi); });
      } else {
        b.innerHTML = intro + form + '<div id="aiErr"></div><div class="btns" style="margin-top:12px"><button class="btn" type="button" id="aiSend">Send and get ideas</button><span class="small muted">About a cent' + (state.me.tier === 'paid' ? ' (member model)' : '') + '.</span></div>';
        $('#aiSend', root).addEventListener('click', function () {
          var btn = $('#aiSend', root), sent = C.ideasPayload(cd(), state.ai.likes, state.ai.count);
          btn.disabled = true; btn.textContent = 'Asking…';
          api('POST', 'api/ai/ideas', sent).then(function (res) {
            loadMe();
            state.ai.ideas = res.ideas; state.ai.req = C.ideasRequest(sent).req; state.ai.example = false; state.ai.dropped = res.dropped || 0;
            showIdeas();
          }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send and get ideas'; meteredError(err, $('#aiErr', root), openAi, WHY_AI); });
        });
      }
      var ex = $('#aiExample', root);
      if (ex) ex.addEventListener('click', function () {
        var req = C.ideasRequest(D.IDEAS_REQ).req, out = C.cleanIdeas(D.IDEAS_RAW, req);
        state.ai.ideas = out.ideas; state.ai.req = req; state.ai.example = true; state.ai.dropped = out.dropped;
        showIdeas();
      });
      $$('[data-like]', root).forEach(function (el) {
        el.addEventListener('click', function () {
          var k = el.getAttribute('data-like'), i = state.ai.likes.indexOf(k);
          if (i >= 0) state.ai.likes.splice(i, 1); else state.ai.likes.push(k);
          var open = $('details.fold', root) && $('details.fold', root).open;
          body(root); if (open) $('details.fold', root).open = true;
        });
      });
      $('#aiCount', root).addEventListener('change', function (e) { state.ai.count = Number(e.target.value) || 8; body(root); });
    }
    sheet('<div class="body"></div>', body);
  }
  function showIdeas() {
    var ideas = state.ai.ideas || [], c = cd(), added = {};
    (c.deck.custom || []).forEach(function (a) { added[C.norm(a.t)] = true; });
    sheet('<h2>' + (state.ai.example ? 'Example ideas' : 'Ideas for you') + '</h2>' +
      '<p class="ai-label">' + (state.ai.example ? 'Made-up example answer - ' : '') + 'AI-written - check they suit your family</p>' +
      (state.ai.dropped ? '<p class="small muted">' + esc(plural(state.ai.dropped, 'answer') + ' did not pass the checks and ' + (state.ai.dropped === 1 ? 'was' : 'were') + ' left out.') + '</p>' : '') +
      '<div class="ideas">' + ideas.map(function (x, i) {
        var a = { tm: x.time, c: x.cost, amt: C.COST_DEFAULT[x.cost], w: x.where, m: x.mess, a: [x.ageMin, x.ageMax], n: x.needs, src: 'ai', id: '' };
        var isIn = added[C.norm(x.title)];
        return '<div class="idea"><h3>' + esc(x.title) + '</h3><p>' + esc(x.how) + '</p>' + tagsHtml(a, c) + needsHtml(a) +
          (state.ai.example ? '' : '<button class="btn small' + (isIn ? ' ghost' : '') + '" type="button" data-act="addidea" data-i="' + esc(i) + '"' + (isIn ? ' disabled' : '') + '>' + (isIn ? 'In your deck ✓' : '+ Add to our deck') + '</button>') + '</div>';
      }).join('') + '</div>' +
      '<div class="btns" style="margin-top:12px">' + (state.ai.example ? (state.demo ? '<button class="btn" type="button" data-act="tourdone">Make our calendar</button>' : '<button class="btn" type="button" data-act="aijoin">Create a free account</button>') : '') + '<button class="btn ghost" type="button" data-act="closesheet">Done</button></div>');
  }
  function addIdea(i) {
    var x = (state.ai.ideas || [])[i], c = cd();
    if (!x || state.ai.example) return;
    if (c.deck.custom.length >= C.LIMITS.custom) { toast('Your deck holds up to ' + C.LIMITS.custom + ' of your own.'); return; }
    var act = C.ideaToActivity(x, 'c-' + rid(8), state.ai.req);
    var errs = [], clean = C.cleanActivity(act, errs, false);
    if (!clean) return;
    var next = C.clone(c);
    next.deck.custom.push(clean); next.deck.picks.push(clean.id); next.deckT = stamp();
    commit(next, true); keepPlace(draw); showIdeas();
    toast('Added and chosen: ' + clean.t);
  }

  /* ---------------- the account (shared shape with the lab) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }
  var FREE_LINE = 'Ajar is free with no account, and everything stays on this phone. A free account keeps your countdowns in step across two phones (never a photo) and adds AI ideas - it comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field" style="margin:10px 0"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">More ideas costs about a cent. The deck, the plan, the doors, printing and the recap are free and stay on this phone.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my countdowns from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your countdowns from the account? This phone keeps its copies.')) return;
          Promise.all(state.list.map(function (c) { return api('DELETE', 'api/countdowns/' + c.id); })).then(function () {
            state.list.forEach(function (c) { state.sync[c.id] = { base: null, at: 0 }; }); saveSync(); state.syncState = 'local';
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The built-in deck, your own ideas, the plan and everything else keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  function draftSet(fn) { fn(state.draft.setup); keepPlace(draw); }
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), iso = el.getAttribute('data-iso');
    switch (act) {
      case 'home': e.preventDefault(); if (state.demo) go('doors'); else go(state.list.length ? 'calendars' : 'start'); break;
      case 'tab': closeSheet(true); go(el.getAttribute('data-tab')); break;
      case 'demo': startDemo(); break;
      case 'leavedemo': leaveDemo(); break;
      case 'tour': tourStep(Number(el.getAttribute('data-step')) || 1); break;
      case 'tourdone': closeSheet(true); leaveDemo(); startNew(); break;
      case 'new': startNew(); break;
      case 'calendars': go('calendars'); break;
      case 'opencal': state.demo = false; state.curId = el.getAttribute('data-id'); saveLocal(); go('doors'); break;
      case 'rmcal': {
        var id = el.getAttribute('data-id'), c0 = byId(id);
        if (!c0 || !confirm('Remove ' + C.bigName(c0.setup) + ' from this phone' + (signedIn() ? ' and your account' : '') + '? Its photos on this phone go too.')) break;
        state.list = state.list.filter(function (x) { return x.id !== id; });
        if (state.curId === id) state.curId = state.list.length ? state.list[0].id : '';
        delete state.sync[id]; saveSync(); saveLocal(); real.photoClear(id).catch(function () { /* fine */ });
        if (signedIn()) api('DELETE', 'api/countdowns/' + id).catch(function () { /* the account copy stays; it can be removed later */ });
        keepPlace(draw); break;
      }
      case 'editsetup': editSetup(); break;
      case 'tpl': draftSet(function (s) { s.template = el.getAttribute('data-v'); if (s.template !== 'custom') { s.year = C.christmasYear(today()); s.name = 'Christmas'; } else if (s.name === 'Christmas') s.name = ''; }); break;
      case 'ends': draftSet(function (s) { s.ends = el.getAttribute('data-v'); }); break;
      case 'addkid': draftSet(function (s) { if (s.kids.length < C.LIMITS.kids) s.kids.push({ name: '', age: null }); }); var ins = $$('[data-kid][data-f="name"]'); if (ins.length) ins[ins.length - 1].focus(); break;
      case 'rmkid': draftSet(function (s) { s.kids.splice(Number(el.getAttribute('data-i')), 1); }); break;
      case 'adults': draftSet(function (s) { s.adults = Math.max(0, Math.min(C.LIMITS.adultsMax, s.adults + Number(el.getAttribute('data-d')))); }); break;
      case 'busywd': draftSet(function (s) { var d = Number(el.getAttribute('data-d')), i = s.busy.indexOf(d); if (i >= 0) s.busy.splice(i, 1); else s.busy.push(d); s.busy.sort(); }); break;
      case 'addbusy': { var v = $('#busyDate').value; if (!C.isIso(v)) { toast('Pick a date.'); break; } draftSet(function (s) { if (s.busyDates.indexOf(v) < 0 && s.busyDates.length < C.LIMITS.busyDates) s.busyDates.push(v); s.busyDates.sort(); }); break; }
      case 'rmbusy': draftSet(function (s) { s.busyDates = s.busyDates.filter(function (d) { return d !== el.getAttribute('data-d'); }); }); break;
      case 'addpin': {
        var title = C.line($('#pinTitle').value, 40), date = $('#pinDate').value, rg = C.range(state.draft.setup);
        if (!title) { toast('Say what it is - like "School concert".'); break; }
        var bad = C.bodyProblem(title);
        if (bad) { toast('Just what it is - ' + bad.charAt(0).toLowerCase() + bad.slice(1), 4200); break; }
        if (!C.isIso(date) || !rg || rg.dates.indexOf(date) < 0) { toast('Pick a date between the first and the last door.', 4200); break; }
        if (state.draft.setup.pins.some(function (p) { return p.date === date; })) { toast('There is already something fixed on ' + C.dayLabel(date) + '.'); break; }
        if (state.draft.setup.pins.length >= C.LIMITS.pins) { toast('Up to ' + C.LIMITS.pins + ' fixed-date things.'); break; }
        draftSet(function (s) { s.pins.push({ id: 'p-' + rid(6), title: title, date: date }); s.pins.sort(function (a, b) { return a.date < b.date ? -1 : 1; }); });
        break;
      }
      case 'rmpin': draftSet(function (s) { s.pins = s.pins.filter(function (p) { return p.id !== el.getAttribute('data-id'); }); }); break;
      case 'budget': draftSet(function (s) { s.budget.mode = el.getAttribute('data-v'); if (s.budget.mode === 'set' && !s.budget.usd) s.budget.usd = 40; }); break;
      case 'evening': draftSet(function (s) { s.evening = Number(el.getAttribute('data-v')); }); break;
      case 'savesetup': saveSetup(); break;
      case 'deckmode': state.deck.mode = el.getAttribute('data-v') === 'list' ? 'list' : 'swipe'; state.deck.more = 0; keepPlace(draw); break;
      case 'filter': state.deck.f[el.getAttribute('data-k')] = el.getAttribute('data-v'); state.deck.more = 0; keepPlace(draw); break;
      case 'starter': { var cur = cd(), n2 = setPicks(C.starterPicks(cur, seed())); commit(n2, true); keepPlace(draw); toast(plural(n2.deck.picks.length, 'idea') + ' chosen - change any of them, then plan it.', 3600); break; }
      case 'swyes': swipe(true); break;
      case 'swno': swipe(false); break;
      case 'swundo': { var lastId = state.deck.last.pop(); if (!lastId) break; delete state.deck.seen[lastId]; if (cd().deck.picks.indexOf(lastId) >= 0) commit(pick(lastId, false), true); keepPlace(draw); break; }
      case 'reseen': state.deck.seen = {}; keepPlace(draw); break;
      case 'pick': { var pid = el.getAttribute('data-id'); commit(pick(pid, cd().deck.picks.indexOf(pid) < 0)); break; }
      case 'moredeck': state.deck.more += 24; keepPlace(draw); break;
      case 'rmown': { var oid = el.getAttribute('data-id'), nx = pick(oid, false); nx.deck.custom = nx.deck.custom.filter(function (a) { return a.id !== oid; }); commit(nx); break; }
      case 'addown': openOwn(); break;
      case 'ai': openAi(); break;
      case 'aijoin': openAccount(WHY_AI, openAi); break;
      case 'addidea': addIdea(Number(el.getAttribute('data-i'))); break;
      case 'planit': planIt(); break;
      case 'shuffle': { var rp = C.replan(cd(), { seed: seed(), t: stamp() }); state.report = rp.report; state.pending = null; commit(rp.cd); toast('Shuffled - pinned, opened and fixed days stayed put.'); break; }
      case 'pickday': pickDay(iso); break;
      case 'pin': apply(C.togglePin(cd(), iso, { t: stamp() }), { kind: 'pin', d: iso }); break;
      case 'way': doWay(); break;
      case 'unrefuse': state.pending = null; state.sel = ''; var rb = $('#doorRefusal'); if (rb) rb.innerHTML = ''; else keepPlace(draw); break;
      case 'door': openFlow(iso, false); break;
      case 'peek': closeSheet(true); go('plan'); break;
      case 'status': setDoor(iso, function (c) { return C.setStatus(c, iso, el.getAttribute('data-v'), stamp()); }); break;
      case 'star': setDoor(iso, function (c) { return C.toggleStar(c, iso, stamp()); }); break;
      case 'moveto': doMove(el.getAttribute('data-from'), el.getAttribute('data-to'), {}); break;
      case 'rmphoto': real.photoDel(state.curId, iso).then(function () { doorSheet(iso); toast('Removed from this phone.'); }); break;
      case 'shareshop': {
        var text = C.shopText(cd(), today()) + (state.demo ? '\n\n(Made-up example)' : '');
        if (navigator.share) navigator.share({ title: 'Shopping', text: text }).catch(function (er) { if (!er || er.name !== 'AbortError') copy(text, 'Copied the list.'); });
        else copy(text, 'Copied the list - paste it anywhere.');
        break;
      }
      case 'toprint': closeSheet(true); go('print'); break;
      case 'paper': state.paper = el.getAttribute('data-v'); if (!state.demo) { state.device.paper = state.paper; saveDevice(); } keepPlace(draw); break;
      case 'print': doPrint(el.getAttribute('data-what')); break;
      case 'kid': kidOn(); break;
      case 'kiddoor': openFlow(iso, true); break;
      case 'kidclose': state.kidOpen = ''; kidDraw(); break;
      case 'kidexit': state.kidQ = C.kidQuestion(seed()); state.kidMsg = ''; state.kidOpen = ''; kidDraw(); var q1 = $('#kid .kid-choices button'); if (q1) q1.focus(); break;
      case 'kidstay': state.kidQ = null; kidDraw(); break;
      case 'kidans': if (state.kidQ && Number(el.getAttribute('data-v')) === state.kidQ.answer) { state.kidQ = null; kidOff(); toast('Kid mode is off.'); } else { state.kidQ = C.kidQuestion(seed()); state.kidMsg = 'Not quite - a grown-up can try this one.'; kidDraw(); } break;
      case 'drawcard': {
        drawRecapCard().then(function (blob) {
          var out = $('#rcOut');
          if (!blob || !out) { if (out) showError(new Error('This browser couldn’t draw the card.'), out); return; }
          if (state.recap.url) URL.revokeObjectURL(state.recap.url);
          state.recap.blob = blob; state.recap.url = URL.createObjectURL(blob);
          out.innerHTML = '<img class="recap-img" alt="' + esc('Recap card: ' + C.bigName(cd().setup)) + '" src="' + esc(state.recap.url) + '">';
          var sb = $('#rcShare'); if (sb) sb.hidden = false;
          el.textContent = 'Draw it again';
          say(canShareFiles() ? 'Drawn - tap Share it.' : 'Drawn - tap Download it.');
        }).catch(function () { var out = $('#rcOut'); if (out) showError(new Error('This browser couldn’t draw the card. Try it without the photo.'), out); });
        break;
      }
      case 'sharecard': {
        var rc = state.recap;
        if (!rc.blob) break;
        var name = 'ajar-' + C.bigName(cd().setup).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-recap.png';
        var file = new File([rc.blob], name, { type: 'image/png' });
        if (canShareFiles()) navigator.share({ files: [file], title: C.bigName(cd().setup) }).catch(function (er) { if (!er || er.name !== 'AbortError') download(name, 'image/png', rc.blob); });
        else download(name, 'image/png', rc.blob);
        break;
      }
      case 'demoend': if (state.demo) { state.demoCd = D.finished(); state.demoEnd = true; state.recap = { photo: false, blob: null, url: null }; keepPlace(draw); } break;
      case 'mergeok': state.mergeNote = null; keepPlace(draw); break;
      case 'signin': openAccount(); break;
      case 'retrysync': if (state.curId) push(state.curId); break;
      case 'resync': if (state.curId) push(state.curId, null); break;
      case 'closesheet': closeSheet(); break;
      default: break;
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.hasAttribute('data-set') && state.draft) {
      var k = t.getAttribute('data-set'), s = state.draft.setup;
      if (k === 'name') s.name = t.value;
      if (k === 'bigDay') s.bigDay = t.value;
      if (k === 'doors') s.doors = Number(t.value);
      if (k === 'look') s.look = t.value;
      if (k === 'usd') s.budget.usd = Math.max(0, Math.min(C.LIMITS.usdMax, Math.round(Number(t.value) || 0)));
      if (k !== 'name') keepPlace(draw);
      return;
    }
    if (t.hasAttribute('data-kid') && state.draft) {
      var kid = state.draft.setup.kids[Number(t.getAttribute('data-kid'))];
      if (!kid) return;
      if (t.getAttribute('data-f') === 'age') kid.age = t.value === '' ? null : Number(t.value);
      return;
    }
    if (t.hasAttribute('data-tick')) {
      var key = t.getAttribute('data-tick'), next = C.clone(cd());
      next.shop[key] = { got: t.checked, t: stamp() };
      commit(next);
      return;
    }
    if (t.hasAttribute('data-amt')) {
      var aid = t.getAttribute('data-amt'), n = C.clone(cd()), cents = Math.round(Number(t.value) * 100);
      if (!isFinite(cents) || cents < 0 || cents > C.LIMITS.amtMax) { toast('An amount from $0 to $500.'); keepPlace(draw); return; }
      n.deck.costs[aid] = cents; n.deckT = stamp();
      commit(n);
      return;
    }
    if (t.hasAttribute('data-recap')) { state.recap.photo = t.checked; return; }
    if (t.hasAttribute('data-photo')) {
      var f = t.files && t.files[0], d = t.getAttribute('data-photo');
      t.value = '';
      if (!f) return;
      prepPhoto(f).then(function (p) { return real.photoPut(state.curId, d, p); }).then(function (ok) {
        if (ok === false) throw new Error('That photo could not be kept.');
        if (!state.device.photoLine) { state.device.photoLine = true; saveDevice(); }
        doorSheet(d); toast(real.persistent() ? 'Kept on this phone.' : 'Kept until you close this tab - this browser won’t store it.');
      }).catch(function (er) { toast(er.message || 'That photo could not be read.'); });
    }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute || !state.draft) return;
    if (t.getAttribute('data-set') === 'name') state.draft.setup.name = t.value;
    if (t.hasAttribute('data-kid') && t.getAttribute('data-f') === 'name') { var kid = state.draft.setup.kids[Number(t.getAttribute('data-kid'))]; if (kid) kid.name = t.value; }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); return; }
    if (state.view === 'deck' && state.deck.mode === 'swipe' && $('#sheet').hidden && document.activeElement && document.activeElement.id === 'swipeCard') {
      if (e.key === 'ArrowRight') { e.preventDefault(); swipe(true); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); swipe(false); }
    }
  });
  window.addEventListener('popstate', function () { if (!$('#kid').hidden) { history.pushState(null, '', location.href); return; } route(); });
  window.addEventListener('resize', function () { if (state.view === 'print') fitPreviews(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!state.demo && cd() && ['doors', 'plan', 'shop'].indexOf(state.view) >= 0) keepPlace(draw);   // a new day may have come
    if (signedIn()) syncIn();
  });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  drawTop();
  Promise.all([real.getCountdowns(), real.getCurrent(), real.getDevice(), real.getSync()]).then(function (r) {
    state.list = r[0]; state.curId = r[1] && byId(r[1]) ? r[1] : (state.list[0] ? state.list[0].id : ''); state.device = r[2]; state.sync = r[3];
  }).catch(function () { /* fresh */ }).then(function () {
    var h = (location.hash || '').replace(/^#/, '');
    if (h && ['calendars', 'doors', 'plan', 'shop', 'deck', 'print', 'recap', 'more'].indexOf(h) < 0) history.replaceState(null, '', BASE);
    route();
    if (state.device.kid && cd()) kidOn();
    return loadMe();
  }).then(function () { if (signedIn()) syncIn(); });
}());
