/* Duly - the page. One file, no build step. Every string that came from
 * outside this file (a typed payee, a note, a model's answer, anything from
 * the server) is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only). The rules - due dates,
 * AutoPay health, the month, the "higher than usual" flag, the calendar file,
 * the refusal of account numbers - are duly-core.js, the same file the server
 * and the tests run.
 *
 * Views (tabs): home (heads-up, coming up, the score, this month), month (a
 * calendar and the list), bills (every bill with its sparkline), autopay
 * (the score and a checklist per bill not on AutoPay). No bills yet: the
 * first run.
 *
 * Where things live: the bills in localStorage (duly-bills-v1), the two
 * settings in duly-settings-v1, the tab in duly-tab-v1. Signed in, the bills
 * are also kept in the account. A statement's photo is shrunk on this phone,
 * sent once to be read and never kept anywhere.
 */
(function () {
  'use strict';

  var C = window.DulyCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_BILLS = 'duly-bills-v1';
  var K_SET = 'duly-settings-v1';
  var K_TAB = 'duly-tab-v1';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PHOTO_PX = 1600;
  var PHOTO_MAX_BYTES = 1500000;   // a shrunk photo is sent only under this
  var TABS = ['home', 'month', 'bills', 'autopay'];

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() { return C.localDay(new Date()); }
  function money(c) { return C.fmtMoney(c); }
  function fmt(day) { return C.fmtDay(day, today()); }
  var plural = C.plural;
  function newId() { var a = new Uint8Array(9); crypto.getRandomValues(a); return 'b' + Array.prototype.map.call(a, function (x) { return x.toString(36).padStart(2, '0'); }).join('').slice(0, 15); }

  var state = {
    me: null,          // the account, if any
    bills: [],
    tab: 'home',
    month: null,       // 'YYYY-MM' on the Month tab
    selDay: null,      // a tapped day on the calendar
    settings: { spikePct: 20, remindDays: 3 },
    form: null,        // the add / edit form
    read: null,        // the statement reader
    armed: null,       // a delete waiting for its second tap
    ring: null,        // the score last drawn, so a change animates
  };
  var main = $('#main');

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    var h = {};
    if (body) h['Content-Type'] = 'application/json';
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin', headers: h,
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
  function toast(msg, ms) {
    $$('.toast').forEach(function (old) { old.remove(); });
    clearTimeout(toastTimer);
    if (!msg) return;
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || Math.min(6000, 2400 + msg.length * 30));
  }
  function say(msg) { var l = $('#live'); if (l) { l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); } }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function syncOn() { return signedIn() && state.me.sync !== false; }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function billById(id) { for (var i = 0; i < state.bills.length; i++) if (state.bills[i].id === id) return state.bills[i]; return null; }
  function hasSample() { return state.bills.some(function (b) { return b.sample; }); }
  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Adding a bill by hand works meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).addEventListener('click', function () {
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { toast('Sent - check your email.'); }, function () { toast('Could not send it. Try again in a minute.'); });
    });
  }
  /** A file for the phone to keep: the calendar export. Nothing is uploaded. */
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------------- this phone's bills ---------------- */

  function loadLocal() {
    var raw = recall(K_BILLS);
    var list = raw && Array.isArray(raw.bills) ? raw.bills : [];
    var t = today();
    state.bills = list.map(function (b) { try { return C.cleanBill(b, t, { keepSample: true }); } catch (e) { return null; } }).filter(Boolean).slice(0, C.LIMITS.bills);
    var s = recall(K_SET);
    if (s && typeof s === 'object') {
      if ([10, 15, 20, 25, 30, 40, 50].indexOf(s.spikePct) >= 0) state.settings.spikePct = s.spikePct;
      if ([0, 1, 2, 3, 5, 7].indexOf(s.remindDays) >= 0) state.settings.remindDays = s.remindDays;
    }
    var tab = recall(K_TAB);
    if (TABS.indexOf(tab) >= 0) state.tab = tab;
  }
  function saveLocal() { keep(K_BILLS, { v: 1, bills: state.bills }); }
  function touch(b) { b.updatedAt = Date.now(); }
  function syncFail(e) { if (e && e.status === 401) return; toast((e && e.message) || 'Could not save to your account - it is still on this phone.'); }
  function pushBill(b) { if (!syncOn() || b.sample) return; api('PUT', 'api/bills/' + b.id, { bill: C.toSaved(b), today: today() }).catch(syncFail); }
  function dropBill(id) { if (!syncOn() || /^sample/.test(id)) return; api('DELETE', 'api/bills/' + id).catch(syncFail); }
  /** Signed in: bring this phone's bills into the account (newer copy wins),
   *  then show what the account holds. */
  function syncIn(announce) {
    if (!syncOn()) return Promise.resolve();
    var mine = state.bills.filter(function (b) { return !b.sample; });
    return api('POST', 'api/bills/merge', { bills: mine.map(C.toSaved), today: today() }).then(function (r) {
      var t = today();
      var server = (r.bills || []).map(function (b) { try { return C.cleanBill(b, t); } catch (e) { return null; } }).filter(Boolean);
      var samples = server.length ? [] : state.bills.filter(function (b) { return b.sample; });
      state.bills = samples.concat(server);
      saveLocal();
      if (announce) toast(server.length ? 'Your bills now follow you to any phone you sign in on.' : 'Signed in. Bills you add now follow you to your other phones.');
      if (r.refused) toast(plural(r.refused, 'bill') + ' carried something like an account number and stayed on this phone only.', 5200);
      draw();
    }).catch(function (e) { if (e.status !== 401) toast(e.message); });
  }

  /* ---------------- small drawing helpers ---------------- */

  /** One small set of line icons, 1.5px stroke. Fixed markup, nothing typed. */
  var ICONS = {
    camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.2-2h6.6l1.2 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.6-5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    up: '<path d="M4 17l5.5-5.5 3.5 3.5L20 8"/><path d="M15 8h5v5"/>',
    pin: '<path d="M12 21s-6.5-5.7-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.3 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>',
    star: '<path d="M12 4l2.3 4.9 5.2.7-3.8 3.7.9 5.3L12 16l-4.6 2.6.9-5.3-3.8-3.7 5.2-.7z"/>',
    loop: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/>',
    shield: '<path d="M12 3.5l7 2.5v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.2"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
  };
  function icon(name) { return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>'; }
  function tile(b) { return '<span class="tile" aria-hidden="true">' + esc(C.emojiOf(b)) + '</span>'; }
  function payChip(b) {
    if (b.pay === 'auto') return '<span class="chip auto">✓ AutoPay on</span>';
    if (b.pay === 'off') return '<span class="chip off">AutoPay off</span>';
    return '<span class="chip manual">You pay by hand</span>';
  }
  function statusChip(it, t) {
    var cls = { paid: 'paid', today: 'today', overdue: 'late', soon: 'soon', later: 'ghost' }[it.status];
    var icon = { paid: '✓ ', today: '● ', overdue: '! ', soon: '', later: '' }[it.status];
    return '<span class="chip ' + cls + '">' + icon + esc(C.statusWords(it, it.day, t)) + '</span>';
  }
  function flagsFor(b) { return C.amountFlags(b, state.settings.spikePct); }
  function lastFlag(b) { var f = flagsFor(b); return f.length ? f[f.length - 1] : null; }
  /** A sparkline: the amounts in order, a dashed median, a dot on each
   *  higher-than-usual one. Numbers only - nothing typed reaches the SVG. */
  function spark(b, big) {
    var f = flagsFor(b);
    if (f.length < 2) return '';
    var W = big ? 320 : 120, H = big ? 110 : 34, P = big ? 8 : 4;
    var vals = f.map(function (x) { return x.a; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi += 100; lo = Math.max(0, lo - 100); }
    var X = function (i) { return P + (i * (W - 2 * P)) / (f.length - 1); };
    var Y = function (v) { return H - P - ((v - lo) * (H - 2 * P)) / (hi - lo); };
    var pts = f.map(function (x, i) { return X(i).toFixed(1) + ',' + Y(x.a).toFixed(1); });
    var med = C.median(vals);
    var out = '<svg class="spark' + (big ? ' big' : '') + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(sparkLabel(b, f)) + '">';
    if (big) out += '<polygon class="ar" points="' + X(0).toFixed(1) + ',' + (H - P) + ' ' + pts.join(' ') + ' ' + X(f.length - 1).toFixed(1) + ',' + (H - P) + '"/>';
    out += '<line class="md" x1="' + P + '" x2="' + (W - P) + '" y1="' + Y(med).toFixed(1) + '" y2="' + Y(med).toFixed(1) + '"/>';
    out += '<polyline class="ln" points="' + pts.join(' ') + '"/>';
    f.forEach(function (x, i) {
      if (x.high) out += '<circle class="hi" cx="' + X(i).toFixed(1) + '" cy="' + Y(x.a).toFixed(1) + '" r="' + (big ? 6 : 4) + '"/>';
      else if (big || i === f.length - 1) out += '<circle class="pt" cx="' + X(i).toFixed(1) + '" cy="' + Y(x.a).toFixed(1) + '" r="' + (big ? 3.5 : 2.5) + '"/>';
    });
    return out + '</svg>';
  }
  function sparkLabel(b, f) {
    var last = f[f.length - 1];
    return 'Last ' + f.length + ' amounts, from ' + money(f[0].a) + ' to ' + money(last.a) + (last.high ? ', the latest higher than usual' : '');
  }
  function ring(h, big) {
    var r = big ? 56 : 40, size = big ? 132 : 96, c = 2 * Math.PI * r;
    var pct = h.total ? h.on / h.total : 0;
    var from = state.ring === null ? pct : state.ring;
    return '<div class="ring" aria-hidden="true"><svg viewBox="0 0 ' + size + ' ' + size + '"><circle class="track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '"/>' +
      '<circle class="bar" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - from)).toFixed(1) + '" data-to="' + (c * (1 - pct)).toFixed(1) + '"/></svg>' +
      '<div class="lbl"><div><b>' + h.on + '/' + h.total + '</b><small>AutoPay</small></div></div></div>';
  }
  function settleRings() {
    var bars = $$('.ring .bar');
    if (!bars.length) return;
    var go = function () { bars.forEach(function (b) { b.setAttribute('stroke-dashoffset', b.getAttribute('data-to')); }); };
    if (REDUCED) go(); else requestAnimationFrame(function () { requestAnimationFrame(go); });
    var h = C.health(state.bills);
    state.ring = h.total ? h.on / h.total : 0;
  }

  /* ---------------- the views ---------------- */

  function draw() {
    var any = state.bills.length > 0;
    $('#tabbar').hidden = !any;
    $('#topAdd').hidden = !any;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (!any) { main.innerHTML = firstRun(); return; }
    var html = sampleStrip();
    if (state.tab === 'month') html += monthView();
    else if (state.tab === 'bills') html += billsView();
    else if (state.tab === 'autopay') html += autopayView();
    else html += homeView();
    main.innerHTML = html;
    settleRings();
  }

  function firstRun() {
    return '<section class="first">' +
      '<div class="hero">' +
      '<p class="eyebrow">Your household’s bills, watched</p>' +
      '<h1>Every bill on time.</h1>' +
      '<p class="lede">Each bill on its provider’s own AutoPay. Duly watches the dates and the amounts, and speaks up only when something is off.</p>' +
      '<div class="hero-acts"><button class="btn big" type="button" data-act="sample">Try a sample household</button><button class="btn big ghost" type="button" data-act="add">Add my first bill</button></div>' +
      '<p class="hero-more"><button class="link-btn" type="button" data-act="read">Or snap a statement' + icon('chev') + '</button></p>' +
      '<p class="promise"><b>Duly never pays a bill.</b> It never signs in to your bank, card or utility, and never asks for a password or an account number - it refuses them. Your providers’ own AutoPay does the paying; Duly watches.</p></div>' +
      '<div class="mock" aria-hidden="true">' +
      '<div class="mock-head"><b>Coming up</b><span>7 of 9 on AutoPay</span></div>' +
      '<div class="mock-row"><span class="e">📶</span><span><b>Internet</b><small>Due in 2 days · AutoPay</small><br><span class="mock-flag">↑ 31% higher than usual</span></span><b class="num">$91.99</b></div>' +
      '<div class="mock-row"><span class="e">🏠</span><span><b>Rent</b><small>Due Nov 1 · you pay this one</small></span><b class="num">$1,850.00</b></div>' +
      '<div class="mock-row"><span class="e">⚡</span><span><b>Electric</b><small>Paid by AutoPay ✓</small></span><b class="num">$99.80</b></div></div>' +
      '<h2 class="how-title">How it works</h2><ol class="how">' +
      '<li><div><b>List your bills</b><p>Payee, typical amount (or “it varies”), the due day. No account numbers - ever.</p></div></li>' +
      '<li><div><b>Switch on each provider’s AutoPay</b><p>Duly scores how many are on it and shows the steps for the rest - statement balance, from checking, a buffer.</p></div></li>' +
      '<li><div><b>Log what each one comes to</b><p>One tap for “same as last time”, or snap the statement. A bill 20% over its usual gets flagged before it’s paid.</p></div></li>' +
      '<li><div><b>Put the dates in your calendar</b><p>One file with every due date and a reminder. Your phone’s calendar does the rest.</p></div></li>' +
      '</ol></section>';
  }

  function sampleStrip() {
    if (!hasSample()) return '';
    return '<div class="strip" role="note"><p><b>A sample household.</b> Made-up bills and amounts to play with - nothing is saved anywhere.</p>' +
      '<div class="row"><button class="btn small ghost" type="button" data-act="mine">Start my own</button><button class="btn small quiet" type="button" data-act="clearsample">Clear the sample</button></div></div>';
  }

  var ALERT_ICON = { late: 'clock', high: 'up', due: 'pin', date: 'cal', 'new': 'star', autopay: 'loop' };
  function alertActs(a) {
    var b = a.id ? billById(a.id) : null;
    if (a.kind === 'late' || a.kind === 'due') return '<div class="row acts"><button class="btn small ghost" type="button" data-act="paid" data-id="' + esc(a.id) + '" data-day="' + esc(a.day) + '">Mark paid</button><button class="btn small quiet" type="button" data-act="open" data-id="' + esc(a.id) + '">Open</button></div>';
    if (a.kind === 'high') return '<div class="row acts"><button class="btn small ghost" type="button" data-act="open" data-id="' + esc(a.id) + '">See its history</button></div>';
    if (a.kind === 'date') return '<div class="row acts"><button class="btn small ghost" type="button" data-act="open" data-id="' + esc(a.id) + '">Add the due date</button></div>';
    if (a.kind === 'autopay') return '<div class="row acts"><button class="btn small ghost" type="button" data-act="tab" data-tab="autopay">Show me how</button></div>';
    return b ? '<div class="row acts"><button class="btn small ghost" type="button" data-act="open" data-id="' + esc(a.id) + '">Open</button></div>' : '';
  }
  function alertList() {
    return C.alerts(state.bills, today(), { spikePct: state.settings.spikePct, nowMs: Date.now() });
  }
  function alertsCard(list) {
    var html = '<section class="sect" aria-labelledby="hu"><div class="sec"><h2 id="hu">Heads-up</h2><span class="ct">' + (list.length ? plural(list.length, 'thing') : '') + '</span></div>';
    if (!list.length) return html + '<div class="quiet"><span class="ic" aria-hidden="true">' + icon('check') + '</span><div><b>All quiet.</b><span class="small">Every bill is on AutoPay and on track. Duly will speak up if one looks wrong, late or new.</span></div></div></section>';
    return html + '<div class="alerts">' + list.map(function (a) {
      return '<div class="alert ' + esc(a.kind) + '"><span class="ic" aria-hidden="true">' + icon(ALERT_ICON[a.kind]) + '</span><div><b>' + esc(a.title) + '</b><p>' + esc(a.text) + '</p>' + alertActs(a) + '</div></div>';
    }).join('') + '</div></section>';
  }
  function itemRow(it) {
    var b = billById(it.id), t = today();
    if (!b) return '';
    var canPay = b.pay !== 'auto' && (it.status === 'overdue' || it.status === 'today' || it.status === 'soon');
    var undo = it.status === 'paid' && it.how === 'marked';
    var amt = it.amount !== null ? money(it.amount) : '<span class="muted">varies</span>';
    return '<div class="brow' + (it.status === 'overdue' ? ' is-late' : '') + (it.status === 'paid' ? ' is-paid' : '') + '">' + tile(b) +
      '<button class="open" type="button" data-act="open" data-id="' + esc(b.id) + '"><span class="t">' + esc(b.payee) + '</span><span class="chips">' + statusChip(it, t) + (it.status === 'paid' ? '' : b.pay === 'auto' ? '<span class="chip auto">AutoPay</span>' : b.pay === 'off' ? '<span class="chip off">AutoPay off</span>' : '<span class="chip manual">By hand</span>') + '</span></button>' +
      '<div class="r"><span class="amt">' + amt + '</span>' +
      (canPay ? '<button class="btn small ghost" type="button" data-act="paid" data-id="' + esc(b.id) + '" data-day="' + esc(it.day) + '">Mark paid</button>' : '') +
      (undo ? '<button class="link-btn small" type="button" data-act="unpaid" data-id="' + esc(b.id) + '" data-day="' + esc(it.day) + '">Undo</button>' : '') +
      '</div></div>';
  }
  function scoreCard(big) {
    var h = C.health(state.bills);
    var all = h.total && h.on === h.total;
    return '<section class="sect"><div class="score' + (big ? ' big' : '') + '">' + ring(h, big) + '<div><h2>' + esc(h.words) + '</h2>' +
      '<p>' + (all ? 'Every bill pays itself. Duly keeps watching the amounts and the dates.' : h.off.length === 1 ? 'One to go. It takes a few minutes in the provider’s own app.' : h.off.length + ' to go. Each takes a few minutes in the provider’s own app.') + '</p>' +
      (big || all ? '' : '<button class="btn small ghost" type="button" data-act="tab" data-tab="autopay">Turn on the rest</button>') + '</div></div></section>';
  }
  function monthTotalsHtml(mv) {
    return '<div class="totals"><div class="tot"><b>' + C.fmtMoney(mv.total, { round: true }) + '</b><span>This month</span></div>' +
      '<div class="tot"><b>' + C.fmtMoney(mv.paid, { round: true }) + '</b><span>Paid</span></div>' +
      '<div class="tot come"><b>' + C.fmtMoney(mv.toCome, { round: true }) + '</b><span>Still to come</span></div></div>' +
      (mv.unknown ? '<p class="small muted">Plus ' + plural(mv.unknown, 'bill') + ' that ' + (mv.unknown === 1 ? 'varies' : 'vary') + ' with no amount logged yet.</p>' : '');
  }
  function calendarCard() {
    return '<section class="sect"><div class="sec"><h2>In your calendar</h2></div><p class="small muted">One file with every due date, repeating, and a reminder ' + esc(remindWords()) + '. Your phone’s calendar does the rest - nothing in the cloud writes to it.</p>' +
      '<div class="row"><button class="btn ghost" type="button" data-act="ics">' + icon('cal') + 'Download all due dates</button><button class="link-btn small" type="button" data-act="settings">Reminder and flag settings</button></div></section>';
  }
  function remindWords() { var n = state.settings.remindDays; return n === 0 ? 'on the day' : n === 1 ? 'the day before' : n + ' days before'; }

  function homeView() {
    var t = today();
    var up = C.upcoming(state.bills, t, 30);
    var mv = C.monthView(state.bills, t.slice(0, 7), t);
    var list = alertList();
    var late = list.filter(function (a) { return a.kind === 'late'; }).length;
    var title = late ? plural(late, 'bill') + ' late' : list.length ? plural(list.length, 'thing') + ' to look at' : 'All quiet';
    var headHtml = '<div class="page-head"><p class="eyebrow">' + esc(C.fmtDay(t, t)) + ' · ' + esc(C.health(state.bills).words) + '</p><h1>' + esc(title) + '</h1>' +
      '<div class="quick"><button class="btn" type="button" data-act="read">' + icon('camera') + 'Snap a statement</button><button class="btn ghost" type="button" data-act="add">' + icon('plus') + 'Add a bill</button></div></div>';
    var left = alertsCard(list) +
      '<section class="sect"><div class="sec"><h2>Coming up</h2><span class="ct">next 30 days</span></div>' +
      (up.length ? '<div class="rows">' + up.slice(0, 8).map(itemRow).join('') + '</div>' + (up.length > 8 ? '<p class="small muted mt">And ' + plural(up.length - 8, 'more') + ' - see the Month tab.</p>' : '') : '<p class="muted">Nothing due in the next 30 days.</p>') + '</section>';
    var right = scoreCard(false) +
      '<section class="sect"><div class="sec"><h2>' + esc(C.fmtMonth(t.slice(0, 7))) + '</h2><button class="link-btn" type="button" data-act="tab" data-tab="month">Open the month</button></div>' + monthTotalsHtml(mv) + '</section>' +
      calendarCard();
    return headHtml + '<div class="dk-split dk-split-aside"><div>' + left + '</div><div class="dk-sticky">' + right + '</div></div>';
  }

  function monthView() {
    var t = today();
    var ym = state.month || t.slice(0, 7);
    var mv = C.monthView(state.bills, ym, t);
    var byDay = {};
    mv.items.forEach(function (it) { (byDay[it.day] = byDay[it.day] || []).push(it); });
    var grid = C.monthGrid(ym);
    var cal = '<table class="cal" aria-label="' + esc(C.fmtMonth(ym)) + '"><thead><tr>' + C.WEEKDAYS.map(function (w) { return '<th scope="col"><abbr title="' + w + '">' + w.slice(0, 1) + '</abbr></th>'; }).join('') + '</tr></thead><tbody>' +
      grid.map(function (week) {
        return '<tr>' + week.map(function (d) {
          if (!d) return '<td><span class="day empty"></span></td>';
          var its = byDay[d] || [];
          var late = its.some(function (x) { return x.status === 'overdue'; });
          var label = C.fmtDay(d, t) + (its.length ? ': ' + its.map(function (x) { var b = billById(x.id); return (b ? b.payee : '') + ' ' + C.statusWords(x, x.day, t); }).join(', ') : ', nothing due');
          var dots = its.slice(0, 3).map(function (x) { var b = billById(x.id); return '<span>' + esc(b ? C.emojiOf(b) : '') + '</span>'; }).join('');
          return '<td><button class="day' + (d === t ? ' is-today' : '') + (late ? ' has-late' : '') + '" type="button" data-act="day" data-day="' + d + '" aria-pressed="' + (state.selDay === d) + '" aria-label="' + esc(label) + '"><span class="d">' + Number(d.slice(8)) + '</span><span class="dots">' + dots + (its.length > 3 ? '<span class="more">+' + (its.length - 3) + '</span>' : '') + '</span></button></td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>' +
      '<div class="legend"><span><i class="lt"></i>Today</span><span><i class="ll"></i>Something late</span><span>Tap a day to see its bills</span></div>';
    var items = state.selDay ? mv.items.filter(function (x) { return x.day === state.selDay; }) : mv.items;
    var groups = [['overdue', 'Late', 'late'], ['today', 'Due today', 'soon'], ['soon', 'Due in the next week', 'soon'], ['later', 'Later this month', ''], ['paid', 'Paid', 'paid']];
    var list = state.selDay ? '<div class="filterbar"><span>' + esc(C.fmtDay(state.selDay, t)) + '</span><button class="btn small ghost" type="button" data-act="day" data-day="' + esc(state.selDay) + '">Show the whole month</button></div>' : '';
    if (!items.length) list += '<p class="muted">' + (state.selDay ? 'Nothing due that day.' : 'Nothing due this month.') + '</p>';
    var first = true;
    groups.forEach(function (g) {
      var gi = items.filter(function (x) { return x.status === g[0]; });
      if (!gi.length) return;
      list += '<div class="sec ' + g[2] + (first ? '' : ' sub') + '"><h2>' + g[1] + '</h2><span class="ct">' + plural(gi.length, 'bill') + '</span></div><div class="rows">' + gi.map(itemRow).join('') + '</div>';
      first = false;
    });
    return '<div class="monthbar"><button class="navbtn" type="button" data-act="month" data-step="-1" aria-label="Previous month">‹</button><h1>' + esc(C.fmtMonth(ym)) + '</h1><button class="navbtn" type="button" data-act="month" data-step="1" aria-label="Next month">›</button></div>' +
      (ym !== t.slice(0, 7) ? '<p class="center back-now"><button class="link-btn" type="button" data-act="month" data-step="0">Back to this month</button></p>' : '') +
      '<div class="dk-split"><div>' + cal + '<section class="sect">' + monthTotalsHtml(mv) + '</section></div><div class="sect">' + list + '</div></div>';
  }

  function billCard(b) {
    var t = today();
    var nx = C.nextDue(b, t);
    var lf = lastFlag(b);
    var typ = C.typical(b);
    var last = C.lastAmount(b);
    var shown = last !== null ? last : typ;
    return '<article class="bcard">' + tile(b) + '<div class="mw0"><button class="open" type="button" data-act="open" data-id="' + esc(b.id) + '"><span class="t">' + esc(b.payee) + '</span><span class="w">' + esc(C.describeCycle(b.cycle)) + '</span></button>' +
      '<div class="chips">' + payChip(b) + (nx ? '<span class="chip ghost">Next ' + esc(C.fmtDay(nx, t)) + '</span>' : (b.cycle.kind === 'statement' ? '<span class="chip new">Add the next due date</span>' : '')) + (lf && lf.high ? '<span class="chip high">↑ ' + lf.over + '% higher than usual</span>' : '') + '</div>' +
      '<div class="line"><span class="amt">' + (shown !== null ? money(shown) : '<span class="muted">varies</span>') + (last !== null ? ' <small>last</small>' : b.varies ? '' : ' <small>usually</small>') + '</span>' + spark(b, false) + '</div></div></article>';
  }
  function billsView() {
    var t = today();
    var list = state.bills.slice().sort(function (a, b) { var x = C.nextDue(a, t) || '9999', y = C.nextDue(b, t) || '9999'; return x < y ? -1 : x > y ? 1 : a.payee.localeCompare(b.payee); });
    var monthly = 0, unknown = 0;
    state.bills.forEach(function (b) { var m = C.perMonth(b, t); if (m === null) unknown++; else monthly += m; });
    return '<div class="page-head"><h1>Your bills</h1><p class="sub">' + plural(state.bills.length, 'bill') + ' · about <b class="num">' + C.fmtMoney(monthly, { round: true }) + '</b> a month all told' + (unknown ? ' (plus ' + unknown + ' with no amount yet)' : '') + '</p>' +
      '<div class="quick"><button class="btn" type="button" data-act="read">' + icon('camera') + 'Snap a statement</button><button class="btn ghost" type="button" data-act="ics">' + icon('cal') + 'To calendar</button></div></div>' +
      '<div class="bills dk-grid">' + list.map(billCard).join('') + '</div>' +
      '<p class="small muted foot-note">Amounts are what you log - Duly never sees a statement unless you ask it to read one. <button class="link-btn small" type="button" data-act="settings">Settings</button></p>';
  }

  function autopayView() {
    var h = C.health(state.bills);
    var off = h.off;
    var on = state.bills.filter(function (b) { return b.pay === 'auto'; });
    var html = '<div class="page-head"><h1>AutoPay health</h1>' +
      '<p class="sub measure">The safe way to never pay a bill yourself: let each provider take it on the due date, from your checking account - and let Duly watch for the one that’s wrong. Duly can’t switch it on for you, and will never ask for your login.</p></div>' +
      '<div class="dk-split dk-split-aside"><div>';
    if (off.length) {
      html += '<div class="sec"><h2>Not on AutoPay yet</h2><span class="ct">' + plural(off.length, 'bill') + '</span></div><div class="checks">' + off.map(function (b, i) {
        var c = C.checklist(b);
        return '<details class="check"' + (i === 0 ? ' open' : '') + '><summary>' + tile(b) + '<span class="mw0"><span class="t">' + esc(c.title) + '</span><span class="w">' + esc(C.categoryOf(b.category).label) + ' · ' + esc(b.pay === 'off' ? 'AutoPay is off' : 'you pay it by hand') + '</span></span><span class="chev" aria-hidden="true">' + icon('chev') + '</span></summary>' +
          '<div class="check-body"><ol class="steps">' + c.steps.map(function (s) { return '<li><span>' + esc(s) + '</span></li>'; }).join('') + '</ol>' +
          '<ul class="honest">' + c.notes.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
          '<div class="row"><button class="btn" type="button" data-act="seton" data-id="' + esc(b.id) + '">It’s on now</button>' + (b.pay === 'off' ? '<button class="btn ghost" type="button" data-act="setmanual" data-id="' + esc(b.id) + '">I’ll pay this one by hand</button>' : '') + '</div></div></details>';
      }).join('') + '</div>';
    } else {
      html += '<div class="quiet"><span class="ic" aria-hidden="true">' + icon('check') + '</span><div><b>Every bill is on AutoPay.</b><span class="small">Keep a buffer in the account they pay from, and log amounts as they come - Duly will flag one that jumps.</span></div></div>';
    }
    html += '</div><div class="dk-sticky">' + scoreCard(true);
    if (on.length) {
      html += '<section class="sect"><div class="sec"><h2>On AutoPay</h2><span class="ct">' + on.length + '</span></div><ul class="onlist">' + on.map(function (b) {
        var nx = C.nextDue(b, today());
        return '<li><span aria-hidden="true">' + esc(C.emojiOf(b)) + '</span><button class="open" type="button" data-act="open" data-id="' + esc(b.id) + '"><b>' + esc(b.payee) + '</b></button><span class="small muted">' + (nx ? esc(C.fmtDay(nx, today())) : '') + '</span></li>';
      }).join('') + '</ul></section>';
    }
    html += '<section class="sect"><div class="sec"><h2>Before you switch one on</h2></div><ul class="honest flush">' +
      '<li>For a credit card, AutoPay the <b>statement balance</b>, not the minimum.</li><li>Pay from checking, and keep a buffer there.</li><li>Check the first payment went through.</li></ul></section></div></div>';
    return html;
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function head(title) { return '<div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2 id="sheetTitle">' + esc(title) + '</h2><button class="x" type="button" data-act="closesheet" aria-label="Close">×</button></div>'; }
  function sheet(html, bind) {
    var s = $('#sheet');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = html;
    s.hidden = false; $('#sheetBack').hidden = false;
    document.body.classList.add('sheet-open');
    var h = $('#sheetTitle', s);
    s.setAttribute('aria-labelledby', 'sheetTitle');
    if (bind) bind(s);
    if (h) h.setAttribute('tabindex', '-1');
    setTimeout(function () { var f = $('[autofocus]', s) || h; if (f) f.focus(); }, 30);
  }
  function closeSheet(noFocus) {
    var s = $('#sheet');
    if (s.hidden) return;
    s.hidden = true; s.innerHTML = ''; $('#sheetBack').hidden = true;
    document.body.classList.remove('sheet-open');
    state.form = null; state.read = null; state.armed = null;
    if (!noFocus && lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) { /* gone */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  /* ---------------- one bill ---------------- */

  function cycleChoices(b) {
    var t = today();
    var occ = C.occurrences(b, C.addDays(t, -150), C.addDays(t, 35));
    return occ.slice(-6).reverse();
  }
  function defaultCycle(b) {
    var t = today();
    var occ = cycleChoices(b);
    var logged = {};
    (b.history || []).forEach(function (h) { logged[h.d] = true; });
    for (var i = 0; i < occ.length; i++) if (!logged[occ[i]] && C.daysBetween(t, occ[i]) <= 25) return occ[i];
    return occ.filter(function (d) { return C.daysBetween(t, d) <= 25; })[0] || occ[0] || null;
  }
  function openBill(id) {
    var b = billById(id);
    if (!b) return;
    var t = today();
    var nx = C.nextDue(b, t);
    var typ = C.typical(b);
    var flags = flagsFor(b);
    var occ = cycleChoices(b);
    var dflt = defaultCycle(b);
    var last = C.lastAmount(b);
    var html = head(b.payee) +
      '<div class="detail-top">' + tile(b) + '<div><p class="muted">' + esc(C.categoryOf(b.category).label) + ' · ' + esc(C.describeCycle(b.cycle)) + '</p><div class="chips">' + payChip(b) + '</div></div></div>' +
      '<div class="facts"><div class="fact"><div class="k">Usually</div><div class="v">' + (typ !== null ? money(typ) : 'Varies') + '</div><div class="s">' + (b.varies ? 'Median of what you logged' : 'The amount you set') + '</div></div>' +
      '<div class="fact"><div class="k">Next due</div><div class="v">' + (nx ? esc(C.fmtDay(nx, t)) : '—') + '</div><div class="s">' + (nx ? esc(C.relDay(nx, t)) : b.cycle.kind === 'statement' ? 'Add it from the statement' : '') + '</div></div></div>' +
      (b.note ? '<p class="note small mt">' + esc(b.note) + '</p>' : '');
    if (b.cycle.kind === 'statement') {
      html += '<div class="logbox"><b>This statement’s due date</b><p class="small muted">A card’s due date moves a little each month - add it when the statement comes.</p><div class="row"><input class="input grow" type="date" id="stDate" aria-label="Due date"><button class="btn" type="button" data-act="adddate" data-id="' + esc(b.id) + '">Add</button></div>' +
        (b.cycle.dates.length ? '<p class="small muted">Entered: ' + b.cycle.dates.slice(-4).map(function (d) { return esc(C.fmtDay(d, t)); }).join(', ') + '</p>' : '') + '</div>';
    }
    html += '<h3>Amounts over time</h3>';
    if (flags.length >= 2) html += spark(b, true) + '<p class="small muted">Dashed line: the usual (median). ' + (flags.some(function (x) { return x.high; }) ? 'Orange dots: more than ' + state.settings.spikePct + '% over the usual.' : 'Nothing over ' + state.settings.spikePct + '% higher than usual.') + '</p>';
    else html += '<p class="small muted">Log a couple of amounts and a chart appears here, with a flag when one is more than ' + state.settings.spikePct + '% over the usual.</p>';
    html += '<div class="logbox"><b>Log an amount</b>' + (occ.length ? '<div class="field"><span>For the bill due</span><select class="input" id="logDay">' + occ.map(function (d) { return '<option value="' + d + '"' + (d === dflt ? ' selected' : '') + '>' + esc(C.fmtDay(d, t)) + ((b.history || []).some(function (h) { return h.d === d; }) ? ' (logged)' : '') + '</option>'; }).join('') + '</select></div>' : '<p class="small muted">Add the due date first.</p>') +
      (occ.length ? (last !== null ? '<button class="btn soft block" type="button" data-act="logsame" data-id="' + esc(b.id) + '">Same as last time · ' + money(last) + '</button>' : '') +
        '<div class="row mt"><label class="money grow"><span class="vh">Amount</span><input class="input" id="logAmt" inputmode="decimal" autocomplete="off" placeholder="' + (typ !== null ? esc((typ / 100).toFixed(2)) : '0.00') + '"></label><button class="btn" type="button" data-act="log" data-id="' + esc(b.id) + '">Log it</button></div><div id="logErr"></div>' : '') + '</div>';
    if (flags.length) {
      html += '<ul class="hist" aria-label="Logged amounts">' + flags.slice().reverse().map(function (f) {
        return '<li><span>' + esc(C.fmtDay(f.d, t)) + (f.high ? ' <span class="chip high">↑ ' + f.over + '%</span>' : '') + '</span><span class="amt">' + money(f.a) + '</span><button class="del" type="button" data-act="unlog" data-id="' + esc(b.id) + '" data-day="' + f.d + '" aria-label="Remove the amount for ' + esc(C.fmtDay(f.d, t)) + '">×</button></li>';
      }).join('') + '</ul>';
    }
    html += '<div class="stack">' +
      (b.pay !== 'auto' ? '<button class="btn" type="button" data-act="howto" data-id="' + esc(b.id) + '">How to turn on AutoPay</button>' : '') +
      '<div class="two"><button class="btn ghost" type="button" data-act="icsone" data-id="' + esc(b.id) + '">Add to calendar</button><button class="btn ghost" type="button" data-act="edit" data-id="' + esc(b.id) + '">Edit</button></div>' +
      '<button class="btn danger" type="button" data-act="delete" data-id="' + esc(b.id) + '">Delete this bill</button></div>';
    sheet(html, function (root) {
      var a = $('#logAmt', root);
      if (a) a.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); logAmount(b.id, a.value); } });
    });
  }
  function saveBill(b, msg) {
    touch(b);
    var t = today();
    var c = C.cleanBill(b, t, { keepSample: true });
    if (!c) return;
    var i = state.bills.findIndex(function (x) { return x.id === b.id; });
    if (i >= 0) state.bills[i] = c; else state.bills.push(c);
    saveLocal(); pushBill(c);
    if (msg) toast(msg);
    return c;
  }
  function logAmount(id, text, day) {
    var b = billById(id);
    if (!b) return;
    var err = $('#logErr');
    if (C.hasAccountNumber(String(text || ''))) { if (err) err.innerHTML = '<p class="err" role="alert">' + esc(C.REFUSAL) + '</p>'; return; }
    var a = typeof text === 'number' ? text : C.parseMoney(String(text || ''));
    if (a === null) { if (err) err.innerHTML = '<p class="err" role="alert">Type the amount, like 84.20.</p>'; return; }
    var d = day || ($('#logDay') && $('#logDay').value);
    if (!C.isDay(d)) return;
    var hist = (b.history || []).filter(function (h) { return h.d !== d; });
    hist.push({ d: d, a: a });
    hist.sort(function (x, y) { return x.d < y.d ? -1 : 1; });
    var copy = JSON.parse(JSON.stringify(b)); copy.history = hist;
    var saved = saveBill(copy);
    var f = flagsFor(saved).filter(function (x) { return x.d === d; })[0];
    if (f && f.high) { toast('Logged ' + money(a) + ' - that’s ' + f.over + '% over the usual ' + money(f.base) + '. Worth a look before it’s paid.', 6000); say('Higher than usual'); }
    else toast('Logged ' + money(a) + ' for ' + fmt(d) + '.');
    openBill(id); draw();
  }
  function setPaid(id, day, on) {
    var b = billById(id);
    if (!b || !C.isDay(day)) return;
    var copy = JSON.parse(JSON.stringify(b));
    copy.paid = (copy.paid || []).filter(function (d) { return d !== day; });
    if (on) copy.paid.push(day);
    saveBill(copy, on ? 'Marked paid. ' + (b.pay === 'auto' ? '' : 'Nice.') : 'Marked not paid.');
    draw();
  }
  function setPay(id, pay) {
    var b = billById(id);
    if (!b) return;
    var before = C.health(state.bills);
    var copy = JSON.parse(JSON.stringify(b)); copy.pay = pay;
    saveBill(copy);
    var h = C.health(state.bills);
    if (pay === 'auto') {
      toast(h.on === h.total ? 'Every bill is on AutoPay. Duly will keep watching.' : h.words + '. ' + (h.on > before.on ? 'Nice.' : ''), 4200);
      say(h.words);
    } else toast('Noted - Duly will remind you when it’s due.');
    draw();
  }
  function icsFor(bills, name) {
    var text = C.buildIcs(bills, { today: today(), nowMs: Date.now(), remindDays: state.settings.remindDays, name: 'Bills (Duly)' });
    download(name, text, 'text/calendar;charset=utf-8');
    toast('Saved ' + name + ' - open it to add the dates to your calendar.');
  }

  /* ---------------- add / edit ---------------- */

  function openForm(id, preset) {
    var b = id ? billById(id) : null;
    var t = today();
    var c = b ? b.cycle : null;
    var nxt = b ? C.nextDue(b, t) : null;
    state.form = {
      id: b ? b.id : null,
      payee: b ? b.payee : (preset && preset.payee) || '',
      category: b ? b.category : (preset && preset.category) || null,
      catTouched: Boolean(b) || Boolean(preset && preset.category),
      showCats: false,
      amount: b ? (b.amount !== null ? (b.amount / 100).toFixed(2) : '') : (preset && preset.amount !== null && preset.amount !== undefined ? (preset.amount / 100).toFixed(2) : ''),
      varies: b ? b.varies : Boolean(preset && preset.varies),
      kind: c ? c.kind : (preset && preset.kind) || 'monthly',
      day: c && c.day ? c.day : (preset && preset.day) || Number(t.slice(8)),
      every: c && c.every ? c.every : 3,
      date: c && c.kind !== 'monthly' ? (nxt || '') : (preset && preset.date) || '',
      pay: b ? b.pay : (preset && preset.pay) || 'auto',
      note: b ? b.note : '',
      err: '',
    };
    drawForm();
  }
  function guessLine(f) {
    var g = f.category || C.guessCategory(f.payee) || 'other';
    var cat = C.categoryOf(g);
    return '<span aria-hidden="true">' + cat.emoji + '</span> ' + esc(cat.label) + (f.catTouched ? '' : f.payee ? ' (a guess)' : '') + ' <button class="btn small ghost" type="button" data-act="cats">Change</button>';
  }
  function drawForm() {
    var f = state.form;
    var t = today();
    var dayOpts = ''; for (var d = 1; d <= 31; d++) dayOpts += '<option value="' + d + '"' + (d === f.day ? ' selected' : '') + '>' + C.ordinal(d) + (d >= 29 ? ' (or the last day)' : '') + '</option>';
    var everyOpts = [2, 3, 4, 6, 12].map(function (n) { return '<option value="' + n + '"' + (n === f.every ? ' selected' : '') + '>' + n + ' months</option>'; }).join('');
    var when = '';
    if (f.kind === 'monthly') when = '<label class="field"><span>Due on the</span><select class="input" id="fDay">' + dayOpts + '</select></label>';
    else if (f.kind === 'months') when = '<div class="two"><label class="field"><span>Every</span><select class="input" id="fEvery">' + everyOpts + '</select></label><label class="field"><span>Next due</span><input class="input" type="date" id="fDate" value="' + esc(f.date) + '"></label></div>';
    else if (f.kind === 'yearly') when = '<label class="field"><span>Next due</span><input class="input" type="date" id="fDate" value="' + esc(f.date) + '"><span class="hint">It repeats on that date every year.</span></label>';
    else when = '<label class="field"><span>This statement’s due date <span class="hint">(optional)</span></span><input class="input" type="date" id="fDate" value="' + esc(f.date) + '"><span class="hint">Cards and some utilities move the date each cycle. Add each one as the statement comes.</span></label>';
    var pays = [['auto', 'AutoPay on', 'The provider takes it on the due date'], ['off', 'AutoPay off', 'They offer it, it isn’t switched on'], ['manual', 'I pay it by hand', 'A check, a portal, a transfer']];
    sheet(head(f.id ? 'Edit bill' : 'Add a bill') +
      (f.id ? '' : '<p class="small muted">Got the bill handy? <button class="link-btn small" type="button" data-act="read">Snap a statement instead</button></p>') +
      '<form id="billForm" novalidate>' +
      '<label class="field"><span>Who is it from?</span><input class="input" id="fPayee" autocomplete="off" maxlength="' + C.LIMITS.payee + '" placeholder="City Power, Rent, Visa card…" value="' + esc(f.payee) + '"' + (f.id ? '' : ' autofocus') + '></label>' +
      '<div class="guess" id="guess">' + guessLine(f) + '</div>' +
      '<div class="cats" id="cats" role="group" aria-label="Category"' + (f.showCats ? '' : ' hidden') + '>' + C.CATEGORIES.map(function (c) { return '<button type="button" data-act="cat" data-cat="' + c.id + '" aria-pressed="' + (f.category === c.id) + '"><span class="e" aria-hidden="true">' + c.emoji + '</span>' + esc(c.label) + '</button>'; }).join('') + '</div>' +
      '<div class="field"><span>About how much?</span><div class="amount-row"><label class="money"><span class="vh">Amount</span><input class="input" id="fAmt" inputmode="decimal" autocomplete="off" placeholder="' + (f.varies ? 'It varies' : '84.20') + '" value="' + esc(f.varies ? '' : f.amount) + '"' + (f.varies ? ' disabled' : '') + '></label><button class="pill" type="button" data-act="varies" aria-pressed="' + f.varies + '">It varies</button></div></div>' +
      '<div class="field"><span>When is it due?</span><div class="seg" role="group" aria-label="How often">' +
      [['monthly', 'Monthly'], ['months', 'Every few months'], ['yearly', 'Yearly'], ['statement', 'Per statement']].map(function (k) { return '<button type="button" data-act="kind" data-kind="' + k[0] + '" aria-pressed="' + (f.kind === k[0]) + '">' + k[1] + '</button>'; }).join('') + '</div></div>' +
      when +
      '<div class="field"><span>How is it paid?</span><div class="payopt" role="group" aria-label="How it is paid">' + pays.map(function (p) { return '<button type="button" data-act="pay" data-pay="' + p[0] + '" aria-pressed="' + (f.pay === p[0]) + '"><span class="radio" aria-hidden="true"></span><span><b>' + p[1] + '</b><small>' + p[2] + '</small></span></button>'; }).join('') + '</div></div>' +
      '<label class="field"><span>Note <span class="hint">(optional)</span></span><input class="input" id="fNote" maxlength="' + C.LIMITS.note + '" autocomplete="off" placeholder="Paid from the joint account" value="' + esc(f.note) + '"></label>' +
      '<p class="refuse">' + icon('shield') + '<span>No account, card or routing numbers - Duly refuses them. “Ending 4421” is fine.</span></p>' +
      '<div id="formErr">' + (f.err ? '<p class="err" role="alert">' + esc(f.err) + '</p>' : '') + '</div>' +
      '<button class="btn big block" type="submit">' + (f.id ? 'Save changes' : 'Add the bill') + '</button></form>', function (root) {
      $('#fPayee', root).addEventListener('input', function (e) { f.payee = e.target.value; $('#guess', root).innerHTML = guessLine(f); });
      var amt = $('#fAmt', root); amt.addEventListener('input', function (e) { f.amount = e.target.value; });
      var day = $('#fDay', root); if (day) day.addEventListener('change', function (e) { f.day = Number(e.target.value); });
      var ev = $('#fEvery', root); if (ev) ev.addEventListener('change', function (e) { f.every = Number(e.target.value); });
      var dt = $('#fDate', root); if (dt) dt.addEventListener('change', function (e) { f.date = e.target.value; });
      $('#fNote', root).addEventListener('input', function (e) { f.note = e.target.value; });
      $('#billForm', root).addEventListener('submit', function (e) { e.preventDefault(); submitForm(); });
    });
  }
  function formErr(msg) { state.form.err = msg; var el = $('#formErr'); if (el) { el.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; el.scrollIntoView({ block: 'nearest' }); } }
  function submitForm() {
    var f = state.form, t = today();
    if (!C.cleanText(f.payee, C.LIMITS.payee)) return formErr('Who is the bill from?');
    if (C.hasAccountNumber(f.amount)) return formErr(C.REFUSAL);
    var amount = null;
    if (!f.varies) {
      amount = C.parseMoney(f.amount);
      if (amount === null) return formErr(String(f.amount).trim() ? 'That isn’t an amount - type it like 84.20.' : 'About how much is it? Or tap “It varies”.');
    }
    var cycle;
    if (f.kind === 'monthly') cycle = { kind: 'monthly', day: f.day };
    else if (f.kind === 'statement') {
      var old = f.id && billById(f.id) && billById(f.id).cycle.kind === 'statement' ? billById(f.id).cycle.dates.slice() : [];
      if (f.date) { if (!C.isDay(f.date)) return formErr('That due date isn’t a date.'); if (old.indexOf(f.date) < 0) old.push(f.date); }
      cycle = { kind: 'statement', dates: old };
    } else {
      if (!C.isDay(f.date)) return formErr('When is it next due?');
      var dd = Number(f.date.slice(8));
      cycle = f.kind === 'months' ? { kind: 'months', every: f.every, day: dd, anchor: f.date.slice(0, 7) } : { kind: 'yearly', month: Number(f.date.slice(5, 7)), day: dd };
    }
    var prev = f.id ? billById(f.id) : null;
    var raw = {
      id: f.id || newId(), payee: f.payee, category: f.category || C.guessCategory(f.payee) || 'other', amount: amount, varies: f.varies,
      cycle: cycle, pay: f.pay, note: f.note,
      history: prev ? prev.history : [], paid: prev ? prev.paid : [], since: prev ? prev.since : t,
      createdAt: prev ? prev.createdAt : Date.now(), updatedAt: Date.now(), sample: prev ? prev.sample : undefined,
    };
    if (f.preset && f.preset.logAmount !== null && f.preset.logAmount !== undefined && f.preset.logDay) raw.history = [{ d: f.preset.logDay, a: f.preset.logAmount }];
    var bill;
    try { bill = C.cleanBill(raw, t, { keepSample: true }); } catch (e) { return formErr(e.message); }
    if (!bill) return formErr('A bill needs who it’s from and when it’s due.');
    if (!prev && hasSample()) state.bills = state.bills.filter(function (x) { return !x.sample; });
    if (!prev && state.bills.length >= C.LIMITS.bills) return formErr('Duly keeps up to ' + C.LIMITS.bills + ' bills. Delete an old one first.');
    var i = state.bills.findIndex(function (x) { return x.id === bill.id; });
    if (i >= 0) state.bills[i] = bill; else state.bills.push(bill);
    saveLocal(); pushBill(bill);
    closeSheet(true);
    if (!prev && state.tab === 'autopay' && bill.pay === 'auto') state.tab = 'home';
    draw();
    toast(prev ? 'Saved.' : bill.payee + ' added. ' + (bill.pay === 'auto' ? 'On AutoPay ✓' : 'Not on AutoPay yet - see the AutoPay tab.'));
  }

  /* ---------------- read a statement (the one model call) ---------------- */

  function openRead() {
    state.read = state.read || { mode: 'photo', text: '', photo: null, busy: false, proposal: null, pick: null };
    drawRead();
  }
  function readerName() { return state.me && state.me.reader === 'gemini' ? 'Google’s Gemini' : 'Claude'; }
  function drawRead() {
    var r = state.read;
    var gate = signedIn() ? '' : '<div class="note gate"><p>Reading a statement uses AI, so it needs a free account - it comes with $2 of AI credit (each read is about a cent). Adding a bill by hand is free and always will be.</p><div class="row"><button class="btn small" type="button" data-act="signup">Create a free account</button><button class="btn small ghost" type="button" data-act="signin">Sign in</button><button class="btn small ghost" type="button" data-act="add">Add it by hand</button></div></div>';
    sheet(head('Snap a statement') +
      '<p class="intro">A photo of a bill, or its text. AI reads four things - the due date, the amount due, the minimum, and whether it says AutoPay - and you confirm before anything is saved.</p>' +
      '<div class="seg" role="group" aria-label="Photo or text"><button type="button" data-act="rmode" data-mode="photo" aria-pressed="' + (r.mode === 'photo') + '">Photo</button><button type="button" data-act="rmode" data-mode="text" aria-pressed="' + (r.mode === 'text') + '">Paste text</button></div>' +
      (r.mode === 'text'
        ? '<label class="field"><span class="vh">The bill’s text</span><textarea class="input" id="rText" maxlength="' + C.LIMITS.pasteChars + '" placeholder="Paste from the email or the provider’s website: the part with the amount due and the due date.">' + esc(r.text) + '</textarea></label>'
        : '<div class="field"><span class="filebtn snap">' + icon('camera') + '<span>' + (r.photo ? 'Choose another photo' : 'Take or choose a photo') + '</span><small>The whole page, flat and in good light</small><input type="file" id="rPhoto" accept="image/*" aria-label="Photo of the bill"></span>' + (r.photo ? '<div class="photo-prev"><img alt="" src="' + esc(r.photo.url) + '"><span class="small muted">Shrunk on this phone to ' + Math.max(1, Math.round(r.photo.bytes / 1024)) + ' KB. Read once, never kept.</span></div>' : '') + '</div>') +
      '<p class="refuse">' + icon('shield') + '<span>Read once by ' + readerName() + ', then dropped: the photo is never stored. Account and card numbers are never asked for, and anything shaped like one is taken out of pasted text before it is read.</span></p>' +
      (gate || '<button class="btn big block" type="button" data-act="doread"' + (r.busy ? ' disabled' : '') + '>' + (r.busy ? 'Reading…' : 'Read it') + '</button>') +
      '<div id="readOut" aria-live="polite">' + (r.busy ? '<p class="reading"><i aria-hidden="true"></i>Reading the due date, the amount and the AutoPay line…</p>' : proposalHtml()) + '</div>', function (root) {
      var tx = $('#rText', root); if (tx) tx.addEventListener('input', function (e) { r.text = e.target.value; });
      var ph = $('#rPhoto', root); if (ph) ph.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        shrink(file).then(function (p) { r.photo = p; r.proposal = null; drawRead(); }, function (err) { toast(err && err.tooBig ? 'That photo is too large even after shrinking. Try a closer shot of just the bill.' : 'That photo could not be read. Try a JPEG or PNG.'); });
      });
    });
  }
  function matchBill(payee) {
    var p = C.fold(payee);
    if (!p) return null;
    var first = p.split(' ')[0];
    var best = null;
    state.bills.forEach(function (b) {
      var q = C.fold(b.payee);
      if (q === p) best = b;
      else if (!best && p.length >= 4 && q.length >= 4 && (q.indexOf(p) >= 0 || p.indexOf(q) >= 0 || (first.length >= 4 && q.split(' ')[0] === first))) best = b;
    });
    return best;
  }
  /** Which bill the reading is for: the name when the reader gave one,
   *  otherwise a guess from the due date and the amount (duly-core.js). The
   *  person can change it; nothing is saved until they tap. */
  function guessPick(p) {
    var m = matchBill(p.payee);
    if (m) return m.id;
    return C.guessBill(state.bills, p, today()) || 'new';
  }
  /** The day of this bill the reading belongs to: the statement's own date
   *  for a statement bill, else the bill's nearest due date to it. */
  function cycleDayFor(b, p) {
    var t = today();
    if (b.cycle.kind === 'statement') return p.dueDate;
    var near = C.occurrences(b, C.addDays(p.dueDate || t, -20), C.addDays(p.dueDate || t, 20));
    return near.length ? near.reduce(function (a, x) { return Math.abs(C.daysBetween(x, p.dueDate || t)) < Math.abs(C.daysBetween(a, p.dueDate || t)) ? x : a; }) : null;
  }
  /** What the reading means for the chosen bill - sums done here, on the
   *  phone, from the bill's own history: never by the model. */
  function insights(p, b) {
    var out = [], t = today();
    var usual = C.typical(b);
    if (p.amount !== null && usual) {
      var pct = Math.round(((p.amount - usual) / usual) * 100);
      if (pct > state.settings.spikePct) out.push(['high', 'up', pct + '% higher than usual - it’s usually ' + money(usual) + '. Worth a look before it’s paid.']);
      else if (pct < -state.settings.spikePct) out.push(['', 'info', Math.abs(pct) + '% lower than the usual ' + money(usual) + '.']);
      else out.push(['ok', 'check', 'In line with the usual ' + money(usual) + '.']);
    }
    var day = p.dueDate ? cycleDayFor(b, p) : null;
    if (p.dueDate && day && day !== p.dueDate) out.push(['', 'cal', 'Duly has it due ' + C.fmtDay(day, t) + '; the statement says ' + C.fmtDay(p.dueDate, t) + '. The amount goes on that bill.']);
    if (p.autopay === 'on') out.push(b.pay === 'auto' ? ['ok', 'check', 'AutoPay is on, and the statement agrees.'] : ['ok', 'loop', 'The statement says AutoPay is on. Saving marks this bill AutoPay on.']);
    else if (p.autopay === 'off') out.push(b.pay === 'auto' ? ['warn', 'info', 'The statement says AutoPay is off, but Duly has it on. Saving marks it off - check the provider’s app.'] : ['', 'info', 'The statement says AutoPay is off.']);
    else if (b.pay === 'auto') out.push(['', 'info', 'The statement doesn’t mention AutoPay. Duly still has it on.']);
    if (p.minimumDue !== null) out.push(['', 'info', 'Minimum due ' + money(p.minimumDue) + '. On AutoPay, pay the statement balance, not the minimum.']);
    return out;
  }
  function proposalHtml() {
    var r = state.read;
    if (!r || !r.proposal) return '';
    var p = r.proposal, t = today();
    if (!r.pick || (r.pick !== 'new' && !billById(r.pick))) r.pick = guessPick(p);
    var b = r.pick === 'new' ? null : billById(r.pick);
    var guessed = b && !p.payee;
    var row = function (k, v, sub) { return '<div><dt>' + k + '</dt><dd' + (v ? '' : ' class="none"') + '>' + (v || 'Not shown') + (sub ? '<small>' + sub + '</small>' : '') + '</dd></div>'; };
    var ins = b ? insights(p, b) : (p.minimumDue !== null ? [['', 'info', 'Minimum due ' + money(p.minimumDue) + '. On AutoPay, pay the statement balance, not the minimum.']] : []);
    return '<div class="proposal"><p class="eyebrow">Read from the statement</p>' +
      '<dl class="read-list">' +
      (p.payee ? row('From', esc(p.payee)) : '') +
      row('Due date', p.dueDate ? esc(C.fmtDay(p.dueDate, t)) : '', p.dueDate ? esc(C.relDay(p.dueDate, t)) : '') +
      row('Amount due', p.amount !== null ? money(p.amount) : '') +
      row('Minimum', p.minimumDue !== null ? money(p.minimumDue) : '') +
      row('AutoPay', ({ on: 'Says it’s on', off: 'Says it’s off', unknown: '' })[p.autopay]) +
      '</dl>' +
      (p.stripped ? '<p class="note warn small"><b>Taken out:</b> something that looked like an account or card number. Duly never keeps them.</p>' : '') +
      (state.bills.length ? '<label class="field"><span>Which bill is this?</span><select class="input" id="rPick">' +
        state.bills.map(function (x) { return '<option value="' + esc(x.id) + '"' + (r.pick === x.id ? ' selected' : '') + '>' + esc(x.payee) + '</option>'; }).join('') +
        '<option value="new"' + (r.pick === 'new' ? ' selected' : '') + '>A new bill</option></select>' +
        (guessed ? '<span class="hint">Duly’s guess, from the date and the amount. Change it if it’s wrong.</span>' : '') + '</label>' : '') +
      (ins.length ? '<ul class="insights">' + ins.map(function (x) { return '<li class="' + x[0] + '">' + icon(x[1]) + '<span>' + esc(x[2]) + '</span></li>'; }).join('') + '</ul>' : '') +
      '<p class="confirm">Check it against the bill - AI can misread. Nothing is saved until you tap.</p>' +
      (b ? '<button class="btn big block" type="button" data-act="rupdate" data-id="' + esc(b.id) + '">Save to ' + esc(b.payee) + '</button>'
        : '<button class="btn big block" type="button" data-act="radd">Check and add it</button>') + '</div>';
  }
  function doRead() {
    var r = state.read;
    if (!signedIn()) return drawRead();
    var body = { today: today() };
    if (r.mode === 'text') {
      if (!r.text.trim()) return toast('Paste the bill’s text first.');
      body.text = r.text;
    } else {
      if (!r.photo) return toast('Choose a photo first.');
      body.photo = { type: r.photo.type, data: r.photo.data };
    }
    r.busy = true; r.proposal = null; r.pick = null; drawRead();
    api('POST', 'api/read', body).then(function (res) {
      if (state.read !== r) return;
      r.busy = false; r.proposal = res.proposal; drawRead();
      var out = $('#readOut'); if (out && out.scrollIntoView) out.scrollIntoView({ block: 'nearest' });
      say('Read. Check it, then save it.');
    }).catch(function (e) {
      if (state.read !== r) return;
      r.busy = false; drawRead();
      if (e.status === 401) { state.me = { signedIn: false }; return drawRead(); }
      if (e.status === 402) return openCredit(e.data);
      if (e.data && e.data.code === 'verify-email') return verifyNote($('#readOut'), e);
      showError(e, $('#readOut'));
    });
  }
  /** The proposal into the add form, prefilled - the person still taps Add. */
  function proposalToForm() {
    var p = state.read.proposal, t = today();
    var isCard = p.category === 'card' || (!p.payee && p.minimumDue !== null);
    var preset = {
      payee: p.payee, category: p.payee ? p.category : (isCard ? 'card' : null), amount: isCard ? null : p.amount, varies: isCard,
      kind: isCard ? 'statement' : 'monthly', day: p.dueDate ? Number(p.dueDate.slice(8)) : Number(t.slice(8)),
      date: isCard ? (p.dueDate || '') : '', pay: p.autopay === 'on' ? 'auto' : p.autopay === 'off' ? 'off' : 'manual',
    };
    openForm(null, preset);
    state.form.preset = { logAmount: p.amount, logDay: p.dueDate };
  }
  /** Save the reading to a bill already on the list: the amount for that
   *  cycle, the statement's due date, and AutoPay as the statement says it
   *  (on, or off when it clearly says so). On a tap, never before. */
  function proposalUpdate(id) {
    var p = state.read.proposal, b = billById(id);
    if (!b) return;
    var copy = JSON.parse(JSON.stringify(b));
    if (copy.cycle.kind === 'statement' && p.dueDate && copy.cycle.dates.indexOf(p.dueDate) < 0) copy.cycle.dates.push(p.dueDate);
    var day = cycleDayFor(copy, p);
    if (p.amount !== null && day) { copy.history = (copy.history || []).filter(function (h) { return h.d !== day; }); copy.history.push({ d: day, a: p.amount }); copy.history.sort(function (x, y) { return x.d < y.d ? -1 : 1; }); }
    if (p.autopay === 'on') copy.pay = 'auto';
    else if (p.autopay === 'off' && copy.pay === 'auto') copy.pay = 'off';
    saveBill(copy);
    closeSheet(true); draw();
    var lf = lastFlag(billById(id));
    toast('Saved to ' + b.payee + (p.amount !== null ? ' - ' + money(p.amount) : '') + (lf && lf.high && lf.d === day ? '. That’s ' + lf.over + '% over the usual.' : '.'), 5200);
  }
  /** A photo shrunk to ~1600px on its long side, as a JPEG, redrawn through
   *  a canvas (which also drops its EXIF, location included). If that is
   *  still over the cap it is drawn smaller and softer, a few times; a photo
   *  that will not fit is not sent at all. The original never leaves here. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('not an image'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        var tries = [[PHOTO_PX, 0.85], [PHOTO_PX, 0.7], [1280, 0.7], [1024, 0.6]];
        var dataUrl = '', bytes = 0;
        for (var i = 0; i < tries.length; i++) {
          var s = Math.min(1, tries[i][0] / Math.max(img.naturalWidth, img.naturalHeight));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          dataUrl = c.toDataURL('image/jpeg', tries[i][1]);
          bytes = Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4);
          if (bytes <= PHOTO_MAX_BYTES) break;
        }
        URL.revokeObjectURL(url);
        if (bytes > PHOTO_MAX_BYTES) return reject(Object.assign(new Error('too big'), { tooBig: true }));
        resolve({ type: 'image/jpeg', data: dataUrl.split(',')[1], url: dataUrl, bytes: bytes });
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('bad image')); });
      img.src = url;
    });
  }

  /* ---------------- settings ---------------- */

  function openSettings() {
    var s = state.settings;
    sheet(head('Settings') +
      '<label class="field"><span>Flag a bill as higher than usual when it’s more than</span><select class="input" id="sPct">' + [10, 15, 20, 25, 30, 40, 50].map(function (n) { return '<option value="' + n + '"' + (n === s.spikePct ? ' selected' : '') + '>' + n + '% over its median</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Calendar reminder</span><select class="input" id="sRemind">' + [[0, 'On the day, 9 am'], [1, '1 day before, 9 am'], [2, '2 days before'], [3, '3 days before'], [5, '5 days before'], [7, 'A week before']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === s.remindDays ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select><span class="hint">Applies to the next calendar file you download.</span></label>' +
      '<div class="stack"><button class="btn ghost" type="button" data-act="ics">Download all due dates</button>' +
      '<button class="btn danger" type="button" data-act="wipe">Clear every bill on this phone</button></div>' +
      '<p class="small muted mt">Settings stay on this phone. ' + (signedIn() ? 'Clearing this phone leaves your account’s copy alone.' : '') + '</p>', function (root) {
      $('#sPct', root).addEventListener('change', function (e) { s.spikePct = Number(e.target.value); keep(K_SET, s); draw(); });
      $('#sRemind', root).addEventListener('change', function (e) { s.remindDays = Number(e.target.value); keep(K_SET, s); draw(); });
    });
  }

  /* ---------------- the account ---------------- */

  var FREE_LINE = 'Duly works without an account. A free account keeps your bills on all your phones and unlocks “Snap a statement”, with $2 of AI credit. One account works across every app on this site. Duly never asks for a bank, card or utility login.';
  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }
  function openAccount(reason, then, login) {
    var mode = login ? 'login' : 'register';
    function draw2(root) {
      $('.body', root).innerHTML = head(mode === 'register' ? 'Create a free account' : 'Welcome back') +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<p class="small muted">This is a password for this site only - never your bank’s.</p>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block mt" id="pkBtn" type="button">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center mt">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(true); return loadMe(); }).then(function () { toast('You’re in.'); syncIn(true); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(true); return loadMe(); }).then(function () { syncIn(true); if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(head('Account') + '<p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><b>Your bills</b><p class="small muted">' + (syncOn() ? 'Kept in your account, so they follow you to any phone you sign in on. Never an account number, never a password.' : 'Syncing isn’t available right now - your bills are safe on this phone.') + '</p></div>' +
      '<div class="note"><div class="row between"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted">“Snap a statement” costs about a cent. Everything else in Duly is free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block mt" id="pkEnrol" type="button">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block mt" id="signOut" type="button">Sign out</button>' +
      '<p class="small muted mt">Signing out keeps this phone’s copy of your bills.</p>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); draw(); });
        });
        var pk = $('#pkEnrol', root);
        if (pk) pk.addEventListener('click', function () {
          var pw = prompt('Your password for this site, to confirm it is you:');
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
    sheet(head('Out of AI credit') + '<p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Adding bills by hand, the month, AutoPay health and the calendar keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });

  /* ---------------- one click listener ---------------- */

  function setTab(tab) {
    if (TABS.indexOf(tab) < 0) return;
    state.tab = tab; keep(K_TAB, tab);
    if (tab === 'month') { state.month = null; state.selDay = null; }
    closeSheet(true); draw(); scrollTo(0, 0);
    var m = $('#main'); if (m) m.focus({ preventScroll: true });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    var f = state.form;
    if (a !== 'delete' && a !== 'wipe') state.armed = null;
    switch (a) {
      case 'home': e.preventDefault(); setTab('home'); break;
      case 'closesheet': closeSheet(); break;
      case 'tab': setTab(t.getAttribute('data-tab')); break;
      case 'sample':
        state.bills = C.sample(today(), Date.now()).concat(state.bills.filter(function (b) { return !b.sample; }));
        state.tab = 'home'; saveLocal(); draw(); scrollTo(0, 0);
        toast('A made-up household to play with. Nothing is saved anywhere.');
        break;
      case 'clearsample':
        state.bills = state.bills.filter(function (b) { return !b.sample; });
        saveLocal(); draw(); scrollTo(0, 0); toast('Sample cleared.');
        break;
      case 'mine':
        state.bills = state.bills.filter(function (b) { return !b.sample; });
        saveLocal(); draw(); openForm(null);
        break;
      case 'add': openForm(null); break;
      case 'read': openRead(); break;
      case 'open': openBill(id); break;
      case 'edit': openForm(id); break;
      case 'delete': {
        if (state.armed !== 'delete:' + id) { state.armed = 'delete:' + id; t.textContent = 'Tap again to delete'; break; }
        state.bills = state.bills.filter(function (b) { return b.id !== id; });
        saveLocal(); dropBill(id); closeSheet(true); draw(); toast('Deleted.');
        break;
      }
      case 'wipe': {
        if (state.armed !== 'wipe') { state.armed = 'wipe'; t.textContent = 'Tap again to clear every bill'; break; }
        state.bills = []; saveLocal(); closeSheet(true); draw(); toast('Cleared from this phone.');
        break;
      }
      case 'paid': setPaid(id, t.getAttribute('data-day'), true); break;
      case 'unpaid': setPaid(id, t.getAttribute('data-day'), false); break;
      case 'seton': setPay(id, 'auto'); break;
      case 'setmanual': setPay(id, 'manual'); break;
      case 'howto': closeSheet(true); setTab('autopay'); setTimeout(function () { var d = $$('details.check').filter(function (x) { return x.querySelector('[data-id="' + id + '"]'); })[0]; if (d) { $$('details.check').forEach(function (x) { x.open = x === d; }); d.scrollIntoView({ block: 'start' }); } }, 30); break;
      case 'month': {
        var step = Number(t.getAttribute('data-step'));
        state.month = step === 0 ? null : C.addMonths(state.month || today().slice(0, 7), step);
        state.selDay = null; draw();
        break;
      }
      case 'day': { var d = t.getAttribute('data-day'); state.selDay = state.selDay === d ? null : d; draw(); break; }
      case 'ics': icsFor(state.bills, 'duly-bills.ics'); break;
      case 'icsone': { var ob = billById(id); if (ob) icsFor([ob], 'duly-' + C.fold(ob.payee).replace(/ /g, '-').slice(0, 30) + '.ics'); break; }
      case 'settings': openSettings(); break;
      case 'log': logAmount(id, $('#logAmt') && $('#logAmt').value); break;
      case 'logsame': { var lb = billById(id); if (lb && C.lastAmount(lb) !== null) logAmount(id, C.lastAmount(lb)); break; }
      case 'unlog': {
        var ub = billById(id), dd = t.getAttribute('data-day');
        if (!ub) break;
        var uc = JSON.parse(JSON.stringify(ub)); uc.history = uc.history.filter(function (h) { return h.d !== dd; });
        saveBill(uc, 'Removed.'); openBill(id); draw();
        break;
      }
      case 'adddate': {
        var sb = billById(id), v = $('#stDate') && $('#stDate').value;
        if (!sb || !C.isDay(v)) { toast('Pick the due date first.'); break; }
        var sc = JSON.parse(JSON.stringify(sb));
        if (sc.cycle.dates.indexOf(v) < 0) sc.cycle.dates.push(v);
        saveBill(sc, 'Due ' + fmt(v) + ' added.'); openBill(id); draw();
        break;
      }
      // the form
      case 'cats': f.showCats = !f.showCats; $('#cats').hidden = !f.showCats; break;
      case 'cat': f.category = t.getAttribute('data-cat'); f.catTouched = true; f.showCats = false; $('#cats').hidden = true; $$('#cats [data-cat]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); $('#guess').innerHTML = guessLine(f); break;
      case 'varies': f.varies = !f.varies; t.setAttribute('aria-pressed', String(f.varies)); var am = $('#fAmt'); am.disabled = f.varies; am.placeholder = f.varies ? 'It varies' : '84.20'; if (f.varies) am.value = ''; else am.value = f.amount; break;
      case 'kind': f.kind = t.getAttribute('data-kind'); if (f.kind !== 'monthly' && f.kind !== 'statement' && !f.date) f.date = ''; drawForm(); break;
      case 'pay': f.pay = t.getAttribute('data-pay'); $$('[data-act="pay"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); break;
      // reading a statement
      case 'rmode': state.read.mode = t.getAttribute('data-mode'); state.read.proposal = null; drawRead(); break;
      case 'doread': doRead(); break;
      case 'radd': proposalToForm(); break;
      case 'rupdate': proposalUpdate(id); break;
      case 'signup': { var r1 = state.read; openAccount(null, function () { state.read = r1; openRead(); }); break; }
      case 'signin': { var r2 = state.read; openAccount(null, function () { state.read = r2; openRead(); }, true); break; }
      default: break;
    }
  });

  // The reader's "Which bill is this?" - the one control drawn after the
  // sheet is bound, so it is heard here.
  document.addEventListener('change', function (e) {
    if (!e.target || e.target.id !== 'rPick' || !state.read) return;
    state.read.pick = e.target.value;
    $('#readOut').innerHTML = proposalHtml();
    var sel = $('#rPick'); if (sel) sel.focus();
  });

  /* ---------------- start ---------------- */

  loadLocal();
  draw();
  loadMe().then(function () { if (syncOn()) return syncIn(false); return null; });
  // The day can turn while the app sits in the background: redraw on return.
  var lastDay = today();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (today() !== lastDay) { lastDay = today(); if ($('#sheet').hidden) draw(); }
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }
}());
