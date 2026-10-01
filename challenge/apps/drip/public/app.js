/* Drip - the page. One file, no build step. Every string that came from
 * outside this file (a merchant name from a statement, a typed name, a
 * model's reading, a saved list) is escaped before it is drawn, and no
 * handler is written into markup (the lab's CSP allows script from this
 * origin only). The sums are drip-core.js, the same file the server and the
 * tests run.
 *
 * A STATEMENT NEVER LEAVES THIS PAGE. It is read here, by DripCore, into
 * drips. The only things this file ever sends: the drips (name, category,
 * amount, cadence, next date, decision, notes - C.toSaved) when a signed-in
 * person saves, screenshots they chose to snap, and sign-in forms. test/run.js
 * holds that by reading this file.
 *
 * Two ways to be here:
 *   sample - Alex's made-up statement, the first thing a visitor sees, ready
 *            to swipe. Never saved.
 *   mine   - the person's own drips: from their statement, a snapped
 *            subscriptions page, or typed. Kept in localStorage (drips only,
 *            every access in try/catch), and in their account once they save.
 */
(function () {
  'use strict';

  var C = window.DripCore;
  var S = window.DripSample;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LOCAL = 'drip-v1';
  var PHOTO_PX = 1600;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TODAY = (function () { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }());
  var YEAR = TODAY.slice(0, 4);
  var FLAG_ICON = { creep: '📈', trial: '🎣', double: '👯', twice: '👯', renewal: '📅', quiet: '💤' };
  var FLAG_WORD = { creep: 'Price creep', trial: 'Trial turned paid', double: 'Doubled up', twice: 'Charged twice', renewal: 'Renews soon', quiet: 'Gone quiet' };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function m$(c, whole) { return C.money(c, { whole: whole }); }

  var state = {
    me: null,
    mode: 'sample',      // 'sample' | 'mine'
    view: 'main',        // 'main' | 'import'
    drips: [],
    report: null,        // what the import read: counts and the date range only
    checkedOn: null,
    since: null,         // C.compare against the last check
    saved: null,         // the account's list, when signed in
    sync: false,         // changes save to the account by themselves
    history: [],         // undo for the stack
    flagsOpen: false,
    focus: false,        // the full-screen swipe view
    busy: false,
    saveTimer: null,
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // The snap route streams whitespace and so answers 200 even on
        // failure; an {error} body is a failure however it arrived.
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
    $$('.toast').forEach(function (x) { x.remove(); });
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  /** The 403 an unconfirmed free account gets, with its resend button. */
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then come back and snap it again. Adding them by hand is free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).onclick = function () {
      var b = this; b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    };
  }

  /* ---------------- the data ---------------- */

  var sampleCache = null;
  function sample() {
    if (sampleCache) return sampleCache;
    var p = C.parseStatements(S.files(TODAY));
    var r = C.findRecurring(p.transactions, { today: TODAY });
    sampleCache = { drips: r.drips, report: reportOf(p, r) };
    return sampleCache;
  }
  /** What the page says about an import: counts and dates, nothing else. */
  function reportOf(p, r) {
    return { files: p.files.filter(function (f) { return !f.error; }).length, charges: r.considered, range: p.range, skipped: p.skipped, dupes: p.dupes || 0 };
  }
  function freshSample() {
    sampleCache = null;
    var s = sample();
    s.drips.forEach(function (d) { d.decision = null; });
    return s;
  }

  function persist() {
    if (state.mode !== 'mine') return;
    state.localAt = new Date().toISOString();
    keep(K_LOCAL, { v: 1, drips: state.drips.map(function (d) { return localShape(d); }).filter(Boolean), report: state.report, checkedOn: state.checkedOn, since: state.since, syncedTo: state.sync && signedIn() ? state.me.email : null, at: state.localAt });
    if (state.sync && signedIn()) queueSave();
  }
  /** A drip as this phone keeps it: the drip, its flag sentences and how
   *  often it was seen - never the charges themselves. */
  function localShape(d) {
    var x = C.cleanDrip(d, { local: true });
    if (!x) return null;
    delete x.charges;
    if (d.charges && d.charges.length) x.seen = d.charges.length; else if (Number.isInteger(d.seen)) x.seen = d.seen;
    return x;
  }
  function fromLocal(saved) {
    var list = C.cleanList(saved.drips, { local: true });
    (saved.drips || []).forEach(function (raw, i) { if (list[i] && raw && Number.isInteger(raw.seen) && raw.id === list[i].id) list[i].seen = Math.min(999, raw.seen); });
    return list;
  }

  function setMine(drips, extra) {
    state.mode = 'mine';
    state.drips = drips;
    Object.assign(state, extra || {});
    state.history = [];
    persist();
    drawAll();
  }

  function activeDrips() { return state.drips.filter(function (d) { return !d.quiet; }); }
  function byId(id) { for (var i = 0; i < state.drips.length; i++) if (state.drips[i].id === id) return state.drips[i]; return null; }
  function rankOf(d) { var r = 99; (d.flags || []).forEach(function (f) { var x = { creep: 0, trial: 1, double: 2, twice: 3, renewal: 4 }[f.type]; if (x !== undefined && x < r) r = x; }); return r; }
  /** The stack: flagged drips first, then the biggest a year. */
  function stackOrder() {
    return activeDrips().slice().sort(function (a, b) { return (rankOf(a) - rankOf(b)) || (b.yearly - a.yearly) || (a.name < b.name ? -1 : 1); });
  }
  function undecided() { return stackOrder().filter(function (d) { return !d.decision; }); }

  /* ---------------- drawing ---------------- */

  function drawAll() {
    $('#importView').hidden = state.view !== 'import';
    $('#mainView').hidden = state.view === 'import';
    drawStrip();
    if (state.view === 'import') { drawImport(); return; }
    drawHero();
    drawFlags();
    drawSince();
    drawStack();
    drawList();
  }

  function drawStrip() {
    var el = $('#strip');
    if (state.view === 'import') { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    if (state.mode === 'sample') {
      el.className = 'strip ex-strip';
      el.innerHTML = '<p class="ex"><span class="tag">Example</span> This is an example statement for ' + esc(S.WHO) + ' - swipe through it, then try your own.</p>' +
        '<button class="btn block" type="button" id="checkBtn">Check my statement</button>' +
        '<p class="sub lock">🔒 Read on your phone. Nothing is uploaded.</p>';
      $('#checkBtn').onclick = openImport;
      return;
    }
    var r = state.report;
    var line = r && r.charges ? 'From ' + plural(r.files, 'file') + ', ' + C.fmtDate(r.range.from, YEAR) + ' – ' + C.fmtDate(r.range.to, YEAR) + ' · ' + plural(r.charges, 'charge') + ' read on this phone.' : 'Your own list, on this phone.';
    var sk = r && r.skipped ? skippedText(r.skipped) : '';
    var saveBit = signedIn()
      ? (state.sync ? '<span class="sub">✓ Saved to your account' + (state.checkedOn ? ' · checked ' + esc(C.fmtDate(state.checkedOn, YEAR)) : '') + '</span>' : '<button class="btn small" type="button" id="saveBtn">Save my list</button>')
      : '<button class="btn small" type="button" id="saveBtn">Sign in to save</button>';
    el.className = 'strip';
    el.innerHTML = '<span class="tag">Your drips</span><p>' + esc(line) + (sk ? ' <span class="sub">' + esc(sk) + '</span>' : '') + '</p>' +
      '<div class="strip-actions">' + saveBit + '<button class="btn small ghost" type="button" id="checkBtn">Check another</button><button class="btn small ghost" type="button" id="exBtn">See the example</button></div>';
    $('#checkBtn').onclick = openImport;
    $('#exBtn').onclick = function () { state.mode = 'sample'; state.drips = freshSample().drips; state.since = null; state.history = []; drawAll(); scrollTo(0, 0); };
    var sb = $('#saveBtn');
    if (sb) sb.onclick = saveNow;
  }
  function skippedText(s) {
    var parts = [];
    if (s.payments) parts.push(plural(s.payments, 'payment'));
    if (s.refunds) parts.push(plural(s.refunds, 'refund'));
    if (s.transfers) parts.push(plural(s.transfers, 'transfer'));
    if (s.interest) parts.push(plural(s.interest, 'interest line'));
    if (s.moneyIn) parts.push(s.moneyIn + ' money in');
    if (s.unreadable) parts.push(s.unreadable + ' unreadable');
    if (!parts.length) return '';
    return 'Skipped ' + (parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]) + '.';
  }

  function countUp(el, to, fmt) {
    var from = Number(el.getAttribute('data-v') || 0);
    el.setAttribute('data-v', String(to));
    if (REDUCED || !window.requestAnimationFrame || from === to) { el.textContent = fmt(to); return; }
    var t0 = null, dur = 700;
    function tick(t) {
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(from + (to - from) * e));
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function drawHero() {
    var el = $('#hero');
    var t = C.totals(state.drips);
    var who = state.mode === 'sample' ? esc(S.WHO) + ' has' : 'You have';
    if (!t.count) {
      el.innerHTML = '<p class="lead">' + (state.mode === 'sample' ? '' : 'No drips on your list yet.') + '</p><p class="year">Check a statement, snap your subscriptions page, or add one by hand.</p>';
      return;
    }
    el.innerHTML = '<p class="lead">' + who + ' <b>' + plural(t.count, 'drip') + '</b> costing</p>' +
      '<p class="huge"><span class="num" id="heroNum" data-v="0">' + esc(m$(0, true)) + '</span><span class="unit">a month</span></p>' +
      '<p class="year">That’s <b>' + esc(m$(t.yearly, true)) + ' a year</b>.</p>' +
      '<div class="catbar" aria-hidden="true">' + t.byCat.map(function (c) { return '<span style="width:' + (100 * c.yearly / t.yearly).toFixed(2) + '%;background:' + esc(c.color) + '"></span>'; }).join('') + '</div>' +
      '<ul class="legend" aria-label="Where it goes, a month">' + t.byCat.map(function (c, i) {
        return '<li' + (i >= 3 && !state.legendOpen && t.byCat.length > 4 ? ' hidden' : '') + '><span class="sw" style="background:' + esc(c.color) + '" aria-hidden="true"></span><span class="lname">' + esc(c.emoji + ' ' + c.short) + '</span><span class="lamt">' + esc(m$(c.monthly, true)) + '/mo</span></li>';
      }).join('') +
      (t.byCat.length > 4 ? '<li><button class="legend-more" type="button" id="legendMore" aria-expanded="' + Boolean(state.legendOpen) + '">' + (state.legendOpen ? 'Fewer' : '+ ' + (t.byCat.length - 3) + ' more') + '</button></li>' : '') + '</ul>';
    var lm = $('#legendMore');
    if (lm) lm.onclick = function () { state.legendOpen = !state.legendOpen; drawHero(); };
    countUp($('#heroNum'), t.monthly, function (v) { return m$(v, true); });
  }

  function drawFlags() {
    var el = $('#flagsCard');
    var all = C.topFlags(state.drips);
    if (!all.length) { el.hidden = true; return; }
    el.hidden = false;
    var shown = state.flagsOpen ? all : all.slice(0, 3);
    el.innerHTML = '<div class="sec-head"><h2>Wait, what?</h2><span class="small muted">' + plural(all.length, 'thing') + ' worth a look</span></div>' +
      '<ul class="flags">' + shown.map(function (f) {
        return '<li class="flag ' + esc(f.type) + '"><span class="fi" aria-hidden="true">' + FLAG_ICON[f.type] + '</span><p><span class="ft">' + esc(FLAG_WORD[f.type]) + '</span>' + esc(f.text) + '</p></li>';
      }).join('') + '</ul>' +
      (all.length > 3 ? '<button class="link-btn" type="button" id="moreFlags">' + (state.flagsOpen ? 'Show fewer' : 'Show all ' + all.length) + '</button>' : '') +
      '<p class="small muted quietline">Drip finds patterns in your charges - check anything before you cancel it.</p>';
    var mf = $('#moreFlags');
    if (mf) mf.onclick = function () { state.flagsOpen = !state.flagsOpen; drawFlags(); };
  }

  function drawSince() {
    var el = $('#sinceCard');
    var s = state.since;
    if (state.mode !== 'mine' || !s || (!s.added.length && !s.changed.length && !s.gone.length)) { el.hidden = true; return; }
    el.hidden = false;
    var li = function (x) { return '<li>' + x + '</li>'; };
    el.innerHTML = '<div class="sec-head"><h2>Since you last checked' + (s.on ? ' (' + esc(C.fmtDate(s.on, YEAR)) + ')' : '') + '</h2><button class="btn small ghost" type="button" id="sinceX">Dismiss</button></div>' +
      (s.added.length ? '<p class="small"><b>New:</b></p><ul>' + s.added.map(function (d) { return li(esc(d.name) + ' · ' + esc(m$(d.cents)) + ' ' + esc(C.CADENCE_WORD[d.cadence])); }).join('') + '</ul>' : '') +
      (s.changed.length ? '<p class="small"><b>Price changed:</b></p><ul>' + s.changed.map(function (d) { return li(esc(d.name) + ': ' + esc(m$(d.from)) + ' → ' + esc(m$(d.to)) + (d.yearly ? ' (' + (d.yearly > 0 ? 'up ' : 'down ') + esc(m$(Math.abs(d.yearly))) + ' a year)' : '')); }).join('') + '</ul>' : '') +
      (s.gone.length ? '<p class="small"><b>Not seen this time:</b></p><ul>' + s.gone.map(function (d) { return li(esc(d.name)); }).join('') + '</ul>' : '');
    el.className = 'card since';
    $('#sinceX').onclick = function () { state.since = null; persist(); drawSince(); };
  }

  /* ---------------- keep or cut ---------------- */

  function sparkSvg(d) {
    var ch = (d.charges || []).slice(-12);
    if (ch.length < 2) return '';
    var max = Math.max.apply(null, ch.map(function (c) { return c.cents; })) || 1;
    var w = 9, gap = 3, h = 34;
    return '<svg class="spark" width="' + (ch.length * (w + gap)) + '" height="' + h + '" viewBox="0 0 ' + (ch.length * (w + gap)) + ' ' + h + '" aria-hidden="true">' +
      ch.map(function (c, i) { var bh = Math.max(4, Math.round(h * c.cents / max)); return '<rect x="' + (i * (w + gap)) + '" y="' + (h - bh) + '" width="' + w + '" height="' + bh + '" rx="2"></rect>'; }).join('') + '</svg>';
  }
  function seenText(d) {
    var n = d.charges && d.charges.length ? d.charges.length : d.seen;
    if (d.probablyYearly) return 'Probably yearly';
    if (d.source === 'hand') return 'Added by hand';
    if (d.source === 'snap') return 'From your screenshot';
    if (!n) return '';
    return 'Seen ' + plural(n, 'time');
  }
  function cardHtml(d, cls) {
    var flags = (d.flags || []).slice(0, 2);
    var col = C.CATS[d.cat].color;
    return '<div class="sc ' + cls + '" style="--c:' + esc(col) + '" data-id="' + esc(d.id) + '"' + (cls === 'front' ? '' : ' aria-hidden="true"') + '>' +
      '<div class="sc-top"><span class="sc-emoji" aria-hidden="true">' + d.emoji + '</span><span class="sc-cat">' + esc(C.CATS[d.cat].label) + '</span><span class="sc-cat" style="margin-left:auto">' + esc(seenText(d)) + '</span></div>' +
      '<h3 class="sc-name">' + esc(d.name) + '</h3>' +
      '<p class="sc-price"><b>' + esc(m$(d.cents)) + '</b> ' + esc(C.CADENCE_WORD[d.cadence]) + '</p>' +
      '<p class="sc-year"><b>' + esc(m$(d.yearly)) + '</b> a year</p>' +
      (flags.length ? '<ul class="sc-flags">' + flags.map(function (f) { return '<li class="' + (f.type === 'double' || f.type === 'renewal' ? 'soft' : '') + '">' + FLAG_ICON[f.type] + ' ' + esc(f.text) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="sc-foot"><p class="sc-dates">' + (d.last ? 'Last ' + esc(C.fmtDate(d.last, YEAR)) : '') + (d.last && d.next ? ' · ' : '') + (d.next ? 'next ' + esc(C.fmtDate(d.next, YEAR)) : '') + '</p>' + sparkSvg(d) + '</div>' +
      '<span class="stamp keep" aria-hidden="true">KEEP</span><span class="stamp cut" aria-hidden="true">CUT</span><span class="stamp unsure" aria-hidden="true">NOT SURE</span>' +
      '</div>';
  }

  function drawStack() {
    var el = $('#stackCard');
    var order = stackOrder();
    if (!order.length) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('focus', state.focus);
    document.body.classList.toggle('locked', state.focus);
    var left = undecided();
    var done = order.length - left.length;
    var sv = C.savings(state.drips);
    var pct = activeDrips().length ? Math.min(100, Math.round(100 * sv.yearly / Math.max(1, C.totals(state.drips).yearly))) : 0;
    var head = '<div class="stack-head"><h2 id="stackH">Keep or cut?</h2><span class="progress">' + done + ' of ' + order.length + ' decided</span>' +
      (state.focus ? '<button class="btn small ghost" type="button" id="focusX" aria-label="Close the full-screen view">Close</button>' : '') + '</div>' +
      '<div class="meter"><div class="bar" role="progressbar" aria-label="Share of your yearly total you are cutting" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><div class="fill" style="width:' + pct + '%"></div></div>' +
      '<p id="saveLine" aria-live="polite">' + saveLineHtml(sv) + '</p></div>';
    if (!left.length) {
      el.innerHTML = head + summaryHtml(order, sv);
      wireSummary(el);
    } else {
      var shown = left.slice(0, 3);
      el.innerHTML = head +
        '<div class="deck" id="deck">' + shown.slice().reverse().map(function (d) { var i = shown.indexOf(d); return cardHtml(d, i === 0 ? 'front' : 'behind' + i); }).join('') + '</div>' +
        '<div class="choices3" role="group" aria-label="Decide on ' + esc(left[0].name) + '">' +
        '<button class="dbtn cut" type="button" data-d="cut"><span class="di" aria-hidden="true">✕</span>Cut</button>' +
        '<button class="dbtn unsure" type="button" data-d="unsure"><span class="di" aria-hidden="true">?</span>Not sure</button>' +
        '<button class="dbtn keep" type="button" data-d="keep"><span class="di" aria-hidden="true">♥</span>Keep</button></div>' +
        '<div class="under"><button class="link-btn" type="button" id="undoBtn"' + (state.history.length ? '' : ' hidden') + '>↶ Undo</button>' +
        '<span class="keys">Swipe, or use ← ↑ → keys</span>' +
        (!state.focus ? '<button class="link-btn" type="button" id="focusBtn">Full screen</button>' : '') + '</div>';
      $$('.dbtn', el).forEach(function (b) { b.onclick = function () { decide(b.getAttribute('data-d')); }; });
      wireDrag($('.sc.front', el));
    }
    var u = $('#undoBtn', el); if (u) u.onclick = undo;
    var fb = $('#focusBtn', el); if (fb) fb.onclick = function () { state.focus = true; drawStack(); var t = $('.dbtn.keep'); if (t) t.focus(); };
    var fx = $('#focusX', el); if (fx) fx.onclick = function () { state.focus = false; drawStack(); var s = $('#stackCard'); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'start' }); };
  }
  function saveLineHtml(sv) {
    if (!sv.count) return esc(C.savingsLine(sv));
    return 'Cutting ' + sv.count + ' saves <b>' + esc(m$(sv.yearly, sv.yearly >= 10000)) + ' a year</b> - that’s ' + esc(sv.equivalent) + '.';
  }

  function summaryHtml(order, sv) {
    var kept = order.filter(function (d) { return d.decision === 'keep'; });
    var cut = order.filter(function (d) { return d.decision === 'cut'; });
    var unsure = order.filter(function (d) { return d.decision === 'unsure'; });
    var rem = C.reminders(state.drips, TODAY);
    return '<h3 style="margin-top:6px">Done! Here’s your plan</h3>' +
      '<div class="tally3"><div class="k"><b>' + kept.length + '</b>Kept</div><div class="c"><b>' + cut.length + '</b>Cut</div><div class="u"><b>' + unsure.length + '</b>Not sure</div></div>' +
      (cut.length ? '<p class="bigsave"><b>' + esc(m$(sv.yearly, sv.yearly >= 10000)) + ' a year</b>back in your pocket - that’s ' + esc(sv.equivalent) + '.</p>' : '<p class="bigsave">Nothing cut - everything earns its place. 👏</p>') +
      (cut.length ? '<h3>To cancel, soonest first</h3><p class="small muted">' + esc(C.howToCancel({})) + '</p><ul class="cutlist">' + cut.slice().sort(function (a, b) { return String(a.next || '9999') < String(b.next || '9999') ? -1 : 1; }).map(function (d) {
        var how = C.howToCancel(d);
        return '<li><div class="cn"><span>' + d.emoji + ' ' + esc(d.name) + '</span><span>' + esc(m$(d.yearly)) + '/yr</span></div>' +
          (d.next ? '<p class="when">Cancel before ' + esc(C.fmtDate(d.next, YEAR)) + '</p>' : '<p class="small muted" style="margin:2px 0 0">No next date known - check your account.</p>') +
          (how !== C.howToCancel({}) ? '<p class="small muted" style="margin:0">' + esc(how.replace(C.howToCancel({}), '').trim()) + '</p>' : '') + '</li>';
      }).join('') + '</ul>' : '') +
      (unsure.length ? '<p class="small muted">Not sure about ' + esc(unsure.map(function (d) { return d.name; }).join(', ')) + ' - check when you last used ' + (unsure.length === 1 ? 'it' : 'them') + '.</p>' : '') +
      '<div class="row" style="margin-top:12px">' +
      (rem.length ? '<button class="btn" type="button" id="icsBtn">📅 Add ' + plural(rem.length, 'reminder') + ' to my calendar</button>' : '') +
      (state.mode === 'sample' ? '<button class="btn ghost" type="button" id="tryOwn">Now check my statement</button>' : (!state.sync ? '<button class="btn ghost" type="button" id="sumSave">' + (signedIn() ? 'Save my list' : 'Sign in to save') + '</button>' : '')) +
      '<button class="btn ghost" type="button" id="againBtn">Go through again</button></div>' +
      (rem.length ? '<p class="small muted" style="margin-top:8px">' + esc(rem.length === 1 ? 'One all-day reminder' : rem.length + ' all-day reminders') + ': a nudge two days before each charge you’re cutting' + (rem.some(function (r) { return r.kind === 'renew'; }) ? ', and a week before each yearly renewal' : '') + '.</p>' : '');
  }
  function wireSummary(el) {
    var ib = $('#icsBtn', el);
    if (ib) ib.onclick = downloadIcs;
    var to = $('#tryOwn', el); if (to) to.onclick = openImport;
    var ss = $('#sumSave', el); if (ss) ss.onclick = saveNow;
    $('#againBtn', el).onclick = function () { state.drips.forEach(function (d) { d.decision = null; }); state.history = []; persist(); drawStack(); drawList(); };
    if (!REDUCED && state.celebrate) { state.celebrate = false; burst(); }
  }
  function burst() {
    var b = document.createElement('div');
    b.className = 'burst'; b.setAttribute('aria-hidden', 'true');
    var bits = ['💸', '💧', '✨', '💰'];
    for (var i = 0; i < 18; i++) {
      var s = document.createElement('span');
      s.textContent = bits[i % bits.length];
      s.style.left = (5 + (i * 53) % 90) + '%';
      s.style.animationDelay = ((i % 6) * 0.08) + 's';
      b.appendChild(s);
    }
    document.body.appendChild(b);
    setTimeout(function () { b.remove(); }, 1800);
  }

  function decide(choice, flyFrom) {
    if (state.busy) return;
    var left = undecided();
    if (!left.length) return;
    var d = left[0];
    var card = $('#deck .sc.front');
    var finish = function () {
      state.busy = false;
      state.history.push({ id: d.id, prev: d.decision });
      d.decision = choice;
      if (navigator.vibrate && !REDUCED) try { navigator.vibrate(choice === 'cut' ? 18 : 8); } catch (e) { /* ignore */ }
      if (!undecided().length) state.celebrate = C.savings(state.drips).count > 0;
      persist();
      drawStack();
      drawList();
      var live = $('#saveLine');
      if (live) live.setAttribute('aria-label', (choice === 'cut' ? 'Cut ' : choice === 'keep' ? 'Kept ' : 'Not sure about ') + d.name + '. ' + C.savingsLine(C.savings(state.drips)));
      var next = $('#deck .sc.front') ? $('.dbtn.' + choice) : $('#icsBtn') || $('#againBtn');
      if (next && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('dbtn')) next.focus();
    };
    if (!card || REDUCED) { finish(); return; }
    state.busy = true;
    var x = choice === 'keep' ? 1 : choice === 'cut' ? -1 : 0;
    var start = flyFrom || { dx: 0, dy: 0 };
    card.classList.remove('dragging', 'settle');
    card.classList.add('fly');
    stamps(card, choice === 'keep' ? 1 : 0, choice === 'cut' ? 1 : 0, choice === 'unsure' ? 1 : 0);
    // A frame so the transition starts from where the finger left it.
    card.style.transform = 'translate(' + start.dx + 'px,' + start.dy + 'px) rotate(' + (start.dx / 18) + 'deg)';
    requestAnimationFrame(function () {
      card.style.transform = x ? 'translate(' + (x * 140) + '%,' + (start.dy - 30) + 'px) rotate(' + (x * 24) + 'deg)' : 'translate(' + start.dx + 'px,-130%) rotate(-4deg)';
      card.style.opacity = '0';
    });
    setTimeout(finish, 290);
  }
  function undo() {
    var h = state.history.pop();
    if (!h) return;
    var d = byId(h.id);
    if (d) d.decision = h.prev;
    persist();
    drawStack();
    drawList();
  }
  function stamps(card, k, c, u) {
    var s = function (sel, v) { var e = $(sel, card); if (e) e.style.opacity = String(Math.max(0, Math.min(1, v))); };
    s('.stamp.keep', k); s('.stamp.cut', c); s('.stamp.unsure', u);
  }
  /** The top card follows a finger or a mouse. Far enough right is Keep,
   *  left is Cut, up is Not sure; anything less springs back. On a phone,
   *  outside the full-screen view, vertical drags are left to the page so it
   *  still scrolls (touch-action: pan-y) - up is then a button. */
  function wireDrag(card) {
    if (!card) return;
    card.style.touchAction = state.focus ? 'none' : 'pan-y';
    var drag = null;
    card.addEventListener('pointerdown', function (e) {
      if (state.busy || (e.button && e.button !== 0)) return;
      drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, id: e.pointerId };
      try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      card.classList.add('dragging'); card.classList.remove('settle');
    });
    card.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag.dx = e.clientX - drag.x; drag.dy = Math.min(e.clientY - drag.y, 40);
      card.style.transform = 'translate(' + drag.dx + 'px,' + drag.dy + 'px) rotate(' + (drag.dx / 18) + 'deg)';
      var up = -drag.dy > Math.abs(drag.dx) ? -drag.dy / 110 : 0;
      stamps(card, drag.dx / 100, -drag.dx / 100, up);
    });
    var end = function (e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      var g = drag; drag = null;
      card.classList.remove('dragging');
      if (e && e.type === 'pointerup') {
        if (g.dx > 90) return decide('keep', g);
        if (g.dx < -90) return decide('cut', g);
        if (g.dy < -90 && -g.dy > Math.abs(g.dx) * 1.2) return decide('unsure', g);
      }
      card.classList.add('settle');
      card.style.transform = '';
      stamps(card, 0, 0, 0);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    card.addEventListener('lostpointercapture', function () { if (drag) end({ type: 'pointercancel', pointerId: drag.id }); });
  }
  document.addEventListener('keydown', function (e) {
    if (state.view !== 'main' || !$('#sheet').hidden) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#deck')) { if (e.key === 'Escape' && state.focus) { state.focus = false; drawStack(); } return; }
    var map = { ArrowRight: 'keep', ArrowLeft: 'cut', ArrowUp: 'unsure' };
    if (map[e.key]) { e.preventDefault(); decide(map[e.key]); }
    else if ((e.key === 'z' || e.key === 'Backspace') && state.history.length) { e.preventDefault(); undo(); }
    else if (e.key === 'Escape' && state.focus) { state.focus = false; drawStack(); }
  });

  function downloadIcs() {
    var text = C.ics({ drips: state.drips, today: TODAY, now: new Date().toISOString() });
    var blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'drip-reminders.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Reminders downloaded - open the file to add them to your calendar.', 3600);
  }

  /* ---------------- the list ---------------- */

  function drawList() {
    var el = $('#listCard');
    var act = activeDrips().slice().sort(function (a, b) { return b.yearly - a.yearly || (a.name < b.name ? -1 : 1); });
    var quiet = state.drips.filter(function (d) { return d.quiet; });
    var row = function (d) {
      var chip = d.decision ? '<span class="chip ' + d.decision + '">' + (d.decision === 'keep' ? 'Keep' : d.decision === 'cut' ? 'Cut' : 'Not sure') + '</span>' : '';
      var meta = d.quiet ? 'Last charged ' + C.fmtDate(d.last, YEAR) + ' · not counted' : C.CADENCE_LABEL[d.cadence] + (d.next ? ' · next ' + C.fmtDate(d.next, YEAR) : '') + ((d.flags || []).length ? ' · ' + FLAG_WORD[d.flags[0].type].toLowerCase() : '');
      return '<li><button type="button" class="drip' + (d.quiet ? ' isquiet' : '') + '" data-edit="' + esc(d.id) + '"><span class="de" aria-hidden="true">' + d.emoji + '</span>' +
        '<span class="dm"><span class="dn">' + esc(d.name) + chip + '</span><span class="dd">' + esc(meta) + '</span></span>' +
        '<span class="da"><b>' + esc(m$(d.cents)) + '</b><span>' + esc(m$(d.yearly, true)) + '/yr</span></span></button></li>';
    };
    el.innerHTML = '<div class="sec-head"><h2>' + (state.mode === 'sample' ? esc(S.WHO) + '’s drips' : 'All your drips') + '</h2><span class="small muted">Tap one to edit</span></div>' +
      (act.length ? '<ul class="drips">' + act.map(row).join('') + '</ul>' : '<p class="muted">Nothing here yet.</p>') +
      (quiet.length ? '<p class="subh">Gone quiet</p><ul class="drips">' + quiet.map(row).join('') + '</ul>' : '') +
      '<div class="tools"><button class="btn ghost" type="button" id="snapBtn">📸 Snap my subscriptions</button><button class="btn ghost" type="button" id="handBtn">✍️ Add one by hand</button></div>' +
      (state.mode === 'mine' ? '<p class="small" style="margin-top:12px"><button class="link-btn" type="button" id="wipeBtn">Delete my list' + (signedIn() && state.sync ? ' (from this phone and my account)' : ' from this phone') + '</button></p>' : '');
    $$('[data-edit]', el).forEach(function (b) { b.onclick = function () { editSheet(b.getAttribute('data-edit')); }; });
    $('#snapBtn', el).onclick = openSnap;
    $('#handBtn', el).onclick = function () { handSheet(); };
    var w = $('#wipeBtn', el); if (w) w.onclick = wipe;
  }

  function wipe() {
    if (!confirm('Delete your whole list' + (signedIn() && state.sync ? ' from this phone and your account' : ' from this phone') + '? This can’t be undone.')) return;
    var done = function () { keep(K_LOCAL, null); state.sync = false; state.saved = null; state.since = null; state.mode = 'sample'; state.drips = freshSample().drips; state.report = null; drawAll(); scrollTo(0, 0); toast('Deleted.'); };
    if (signedIn() && state.sync) api('DELETE', 'api/list').then(done).catch(function (e) { showError(e); });
    else done();
  }

  /** Editing a sample drip turns the example into nothing - it is a demo.
   *  On your own list, every field can change. */
  function editSheet(id) {
    var d = byId(id);
    if (!d) return;
    var ro = state.mode === 'sample';
    var decision = d.decision;
    sheet('<h2>' + d.emoji + ' ' + esc(d.name) + '</h2>' +
      ((d.flags || []).length ? '<ul class="flags" style="margin-bottom:12px">' + d.flags.map(function (f) { return '<li class="flag ' + esc(f.type) + '"><span class="fi" aria-hidden="true">' + FLAG_ICON[f.type] + '</span><p><span class="ft">' + esc(FLAG_WORD[f.type]) + '</span>' + esc(f.text) + '</p></li>'; }).join('') + '</ul>' : '') +
      '<div class="field"><span id="decLbl">Keep or cut?</span><div class="seg" role="group" aria-labelledby="decLbl">' +
      ['cut', 'unsure', 'keep'].map(function (k) { return '<button type="button" class="' + k + '" data-dec="' + k + '" aria-pressed="' + (decision === k) + '">' + (k === 'keep' ? 'Keep' : k === 'cut' ? 'Cut' : 'Not sure') + '</button>'; }).join('') + '</div></div>' +
      (ro ? '<p class="small muted">This is ' + esc(S.WHO) + '’s example. Check your own statement to edit names, prices and dates.</p>' :
        '<label class="field"><span>Name</span><input class="input" id="eName" maxlength="' + C.LIMITS.name + '" value="' + esc(d.name) + '"></label>' +
        '<div class="grid2"><label class="field"><span>Costs</span><input class="input" id="eAmt" inputmode="decimal" value="' + esc(C.plain(d.cents)) + '"></label>' +
        '<label class="field"><span>How often</span><select class="input" id="eCad">' + C.CADENCES.map(function (c) { return '<option value="' + c + '"' + (c === d.cadence ? ' selected' : '') + '>' + esc(C.CADENCE_LABEL[c]) + '</option>'; }).join('') + '</select></label></div>' +
        '<div class="grid2"><label class="field"><span>Next charge</span><input class="input" type="date" id="eNext" value="' + esc(d.next || '') + '"></label>' +
        '<label class="field"><span>Category</span><select class="input" id="eCat">' + C.CAT_IDS.map(function (c) { return '<option value="' + c + '"' + (c === d.cat ? ' selected' : '') + '>' + esc(C.CATS[c].emoji + ' ' + C.CATS[c].label) + '</option>'; }).join('') + '</select></label></div>' +
        '<label class="field"><span>Notes</span><textarea class="input" id="eNotes" maxlength="' + C.LIMITS.notes + '" placeholder="Shared with my sister · cancel after the finale">' + esc(d.notes || '') + '</textarea></label>') +
      '<p class="small muted">' + esc(C.howToCancel(d)) + '</p><div id="eErr"></div>' +
      '<div class="row"><button class="btn" type="button" id="eSave">Done</button>' + (ro ? '' : '<button class="btn ghost" type="button" id="eDel">Remove</button>') + '</div>',
    function (root) {
      $$('[data-dec]', root).forEach(function (b) {
        b.onclick = function () { var k = b.getAttribute('data-dec'); decision = decision === k ? null : k; $$('[data-dec]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-dec') === decision)); }); };
      });
      $('#eSave', root).onclick = function () {
        if (!ro) {
          var cents = C.toCents($('#eAmt', root).value);
          var name = C.clean($('#eName', root).value, C.LIMITS.name);
          if (!cents || !name) return showError(new Error(!name ? 'Give it a name.' : 'Type what it costs, like 9.99.'), $('#eErr', root));
          var priceMoved = cents !== d.cents || $('#eCad', root).value !== d.cadence;
          d.name = name; d.cents = cents; d.cadence = $('#eCad', root).value; d.cat = $('#eCat', root).value;
          d.emoji = C.CATS[d.cat].emoji;
          d.next = C.isoDay($('#eNext', root).value) ? $('#eNext', root).value : null;
          d.notes = C.clean($('#eNotes', root).value, C.LIMITS.notes);
          d.monthly = C.monthlyOf(d.cents, d.cadence); d.yearly = C.yearlyOf(d.cents, d.cadence);
          if (priceMoved) d.flags = (d.flags || []).filter(function (f) { return f.type === 'double'; });
        }
        d.decision = decision;
        closeSheet(); persist(); drawAll();
      };
      var del = $('#eDel', root);
      if (del) del.onclick = function () { state.drips = state.drips.filter(function (x) { return x !== d; }); closeSheet(); persist(); drawAll(); toast('Removed ' + d.name); };
    });
  }

  function handSheet() {
    sheet('<h2>Add one by hand</h2><p class="small muted">For the ones a statement can’t show: paid in cash, on another card, or through someone else.</p>' +
      '<label class="field"><span>Name</span><input class="input" id="hName" maxlength="' + C.LIMITS.name + '" placeholder="Gym, music, newspaper…" autocomplete="off"></label>' +
      '<div class="grid2"><label class="field"><span>Costs</span><input class="input" id="hAmt" inputmode="decimal" placeholder="9.99"></label>' +
      '<label class="field"><span>How often</span><select class="input" id="hCad">' + C.CADENCES.map(function (c) { return '<option value="' + c + '"' + (c === 'monthly' ? ' selected' : '') + '>' + esc(C.CADENCE_LABEL[c]) + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="grid2"><label class="field"><span>Next charge (optional)</span><input class="input" type="date" id="hNext"></label>' +
      '<label class="field"><span>Category</span><select class="input" id="hCat"><option value="">Guess for me</option>' + C.CAT_IDS.map(function (c) { return '<option value="' + c + '">' + esc(C.CATS[c].emoji + ' ' + C.CATS[c].label) + '</option>'; }).join('') + '</select></label></div>' +
      '<div id="hErr"></div><button class="btn block" type="button" id="hAdd">Add it</button>', function (root) {
      $('#hAdd', root).onclick = function () {
        var r = C.handDrip({ name: $('#hName', root).value, amount: $('#hAmt', root).value, cadence: $('#hCad', root).value, next: $('#hNext', root).value, cat: $('#hCat', root).value }, TODAY);
        if (r.error) return showError(new Error(r.error), $('#hErr', root));
        addDrips([r.drip]);
        closeSheet();
        toast('Added ' + r.drip.name);
      };
      $('#hAmt', root).addEventListener('keydown', function (e) { if (e.key === 'Enter') $('#hAdd', root).click(); });
    });
  }

  /** New drips join your own list (never Alex's example). */
  function addDrips(list) {
    var base = state.mode === 'mine' ? state.drips : [];
    var have = {};
    base.forEach(function (d) { have[d.key + '|' + d.cadence] = true; });
    var fresh = list.filter(function (d) { return !have[d.key + '|' + d.cadence]; });
    if (base.length + fresh.length > C.LIMITS.drips) { toast('A list keeps up to ' + C.LIMITS.drips + ' drips.'); fresh = fresh.slice(0, Math.max(0, C.LIMITS.drips - base.length)); }
    var wasSample = state.mode === 'sample';
    setMine(base.concat(fresh), wasSample ? { report: null, since: null, checkedOn: TODAY } : {});
    if (wasSample) scrollTo(0, 0);
  }

  /* ---------------- checking a statement ---------------- */

  function openImport() {
    state.view = 'import'; state.focus = false; document.body.classList.remove('locked');
    drawAll();
    scrollTo(0, 0);
    var h = $('#importView h1'); if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
  }
  function closeImport() { state.view = 'main'; drawAll(); scrollTo(0, 0); }

  function drawImport() {
    var el = $('#importView');
    el.innerHTML = '<button type="button" class="link-btn" id="iBack">← Back</button>' +
      '<h1>Check your statement</h1>' +
      '<p class="private"><span class="pi" aria-hidden="true">🔒</span><span>Read on this phone. Nothing is uploaded.</span></p>' +
      '<ol class="steps">' +
      '<li><span><b>Sign in to your bank’s website.</b> A computer is easiest; most banking apps can’t export.</span></li>' +
      '<li><span><b>Activity → Download → CSV.</b> Pick 6 to 12 months - a longer range finds yearly charges.</span></li>' +
      '<li><span><b>Drop it here.</b> Several at once is fine: your checking account and each card.</span></li></ol>' +
      '<label class="drop" id="drop"><span class="dropi" aria-hidden="true">📄</span><b>Drop CSV files here</b><span class="small muted">or tap to choose them</span>' +
      '<input type="file" id="csvFile" class="vh" multiple accept=".csv,.txt,text/csv,text/plain"></label>' +
      '<details class="more"><summary>Or paste the CSV text</summary><textarea class="input paste" id="csvPaste" placeholder="Date,Description,Amount&#10;09/12/2026,STREAMIO.COM,-17.99"></textarea>' +
      '<button class="btn small" type="button" id="pasteGo">Read it</button></details>' +
      '<div id="importOut" aria-live="polite"></div>' +
      '<h2 style="margin-top:22px">Other ways</h2>' +
      '<button type="button" class="choice" id="iSnap"><span class="ci" aria-hidden="true">📸</span><b>Snap my subscriptions page</b><span class="small muted">AI reads a screenshot of Settings → Subscriptions · free account, a cent or two of your $2 credit</span></button>' +
      '<button type="button" class="choice" id="iHand"><span class="ci" aria-hidden="true">✍️</span><b>Add one by hand</b><span class="small muted">Free · for cash, another card, or anything a statement can’t show</span></button>' +
      '<p class="small muted">Payments, transfers, refunds and interest are skipped and counted, so they never look like a subscription.</p>';
    $('#iBack').onclick = closeImport;
    $('#iSnap').onclick = openSnap;
    $('#iHand').onclick = function () { handSheet(); };
    var drop = $('#drop');
    $('#csvFile').onchange = function (e) { readFiles(e.target.files); e.target.value = ''; };
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) readFiles(e.dataTransfer.files); });
    $('#pasteGo').onclick = function () {
      var text = $('#csvPaste').value;
      if (!text.trim()) return toast('Paste the text of a CSV first.');
      runImport([{ name: 'pasted.csv', text: text }]);
    };
  }

  function readFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var out = $('#importOut');
    if (!files.length) return;
    if (files.length > C.LIMITS.files) return showError(new Error('Up to ' + C.LIMITS.files + ' files at a time.'), out);
    var size = files.reduce(function (n, f) { return n + f.size; }, 0);
    if (size > C.LIMITS.bytes) return showError(new Error('Those files add up to more than 5 MB. Download a shorter date range - 3 to 12 months is plenty.'), out);
    if (files.some(function (f) { return /\.(pdf|ofx|qfx|qbo|xlsx?)$/i.test(f.name); })) return showError(new Error('Drip reads CSV files. Most banks offer CSV next to PDF and Excel under Download.'), out);
    out.innerHTML = '<p class="busy" role="status"><span class="spin" aria-hidden="true"></span> Reading on this phone…</p>';
    Promise.all(files.map(function (f) { return f.text().then(function (t) { return { name: f.name, text: t }; }); }))
      .then(runImport, function () { showError(new Error('That file could not be opened.'), out); });
  }

  /** Read, find, merge with the last list, show. Nothing here is sent. */
  function runImport(files) {
    var out = $('#importOut');
    var p = C.parseStatements(files);
    if (p.error) return showError(new Error(p.error), out);
    var r = C.findRecurring(p.transactions, { today: TODAY });
    var report = reportOf(p, r);
    var bad = p.files.filter(function (f) { return f.error; });
    if (!r.drips.length) {
      out.innerHTML = '<div class="report"><p><b>No repeating charges found</b> in ' + esc(plural(report.charges, 'charge')) + ' from ' + esc(C.fmtDate(report.range.from, YEAR)) + ' to ' + esc(C.fmtDate(report.range.to, YEAR)) + '.</p>' +
        '<p class="small muted" style="margin:0">A subscription needs at least two charges to show up. Try a longer range (6 to 12 months), or add your other cards. ' + esc(skippedText(report.skipped)) + '</p></div>';
      return;
    }
    var prev = state.mode === 'mine' ? state.drips : (state.saved ? C.cleanList(state.saved.drips, { local: true }) : []);
    var prevOn = state.mode === 'mine' ? state.checkedOn : (state.saved ? state.saved.checkedOn : null);
    var merged = C.carryOver(r.drips, prev);
    var since = prev.length ? Object.assign(C.compare(prev, merged), { on: prevOn }) : null;
    state.view = 'main';
    state.flagsOpen = false;
    setMine(merged, { report: report, since: since, checkedOn: TODAY });
    scrollTo(0, 0);
    toast('Found ' + plural(C.totals(merged).count, 'drip') + (bad.length ? ' · ' + bad.length + ' file' + (bad.length === 1 ? '' : 's') + ' could not be read' : ''), 3200);
  }

  /* ---------------- snap a subscriptions page ---------------- */

  function openSnap() {
    if (!signedIn()) {
      sheet('<h2>Snap your subscriptions page</h2><p class="muted">AI reads the list from a screenshot - so it needs a free account. It comes with $2 of credit, and a screenshot costs a cent or two.</p>' +
        '<p class="small muted">Checking a statement and adding drips by hand are free, with no account.</p>' +
        '<button class="btn block" type="button" id="sIn">Sign in or create a free account</button>', function (root) {
        $('#sIn', root).onclick = function () { openAccount(null, openSnap); };
      });
      return;
    }
    var photos = [];
    function draw(root) {
      var body = $('.body', root);
      body.innerHTML = '<h2>Snap your subscriptions page</h2>' +
        '<p class="small muted"><b>iPhone:</b> Settings → your name → Subscriptions. <b>Android:</b> Play Store → your profile → Payments &amp; subscriptions. Take a screenshot (up to 3), then add them here.</p>' +
        '<p class="small muted">The screenshots are read once and never stored.</p>' +
        '<div class="thumbs">' + photos.map(function (p, i) { return '<figure><img alt="Screenshot ' + (i + 1) + '" src="' + esc(p.url) + '"><button type="button" class="x" data-rm="' + i + '" aria-label="Remove screenshot ' + (i + 1) + '">✕</button></figure>'; }).join('') + '</div>' +
        (photos.length < C.LIMITS.snapImages ? '<label class="btn block ghost">' + (photos.length ? '+ Add another' : '📸 Choose screenshots') + '<input type="file" accept="image/*" multiple id="snapFile" class="vh"></label>' : '') +
        '<div id="snapOut"></div>' +
        '<button type="button" class="btn block" id="snapGo"' + (photos.length ? '' : ' disabled') + ' style="margin-top:10px">Read them</button><p class="small muted center">Uses AI credit - usually a cent or two.</p>';
      $$('[data-rm]', body).forEach(function (b) { b.onclick = function () { photos.splice(Number(b.getAttribute('data-rm')), 1); draw(root); }; });
      var inp = $('#snapFile', body);
      if (inp) inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files || []).slice(0, C.LIMITS.snapImages - photos.length);
        Promise.all(files.map(shrink)).then(function (ps) { photos = photos.concat(ps); draw(root); }).catch(function () { toast('That image could not be opened. Try a PNG or JPEG.'); });
      };
      $('#snapGo', body).onclick = function () {
        var btn = this; btn.disabled = true;
        var out = $('#snapOut', body);
        out.innerHTML = '<p class="busy" role="status"><span class="spin" aria-hidden="true"></span> Reading the list… about 15 seconds.</p>';
        api('POST', 'api/snap', { photos: photos.map(function (p) { return { type: p.type, data: p.data }; }) }).then(function (res) {
          photos = [];
          review(root, res);
        }).catch(function (e) {
          btn.disabled = false;
          if (e.status === 402 || e.status === 401) { out.innerHTML = ''; closeSheet(); return showError(e); }
          if (e.data && e.data.code === 'verify-email') return verifyNote(out, e);
          showError(e, out);
        });
      };
    }
    sheet('<div class="body"></div>', draw);
  }

  /** What the model read, editable, before any of it joins the list. */
  function review(root, res) {
    var body = $('.body', root);
    var have = {};
    (state.mode === 'mine' ? state.drips : []).forEach(function (d) { have[d.key + '|' + d.cadence] = true; });
    var items = res.items.map(function (it) { var info = C.merchantInfo(it.name); return Object.assign({}, it, { on: !have[info.key + '|' + it.cadence], dupe: Boolean(have[info.key + '|' + it.cadence]) }); });
    body.innerHTML = '<h2>Check what was read</h2><p class="small muted">' + plural(items.length, 'subscription') + ' found. Fix anything that’s wrong, untick what you don’t want.' + (res.dropped ? ' ' + plural(res.dropped, 'line') + ' had no price that could be read and ' + (res.dropped === 1 ? 'was' : 'were') + ' left out.' : '') + '</p>' +
      '<ul class="snaplist">' + items.map(function (it, i) {
        return '<li><label class="cb"><input type="checkbox" data-on="' + i + '"' + (it.on ? ' checked' : '') + ' aria-label="Add ' + esc(it.name) + '"></label><div class="sf">' +
          '<input class="input sname" data-name="' + i + '" value="' + esc(it.name) + '" maxlength="' + C.LIMITS.name + '" aria-label="Name">' +
          '<input class="input" data-amt="' + i + '" value="' + esc(C.plain(it.cents)) + '" inputmode="decimal" aria-label="Price">' +
          '<select class="input" data-cad="' + i + '" aria-label="How often">' + C.CADENCES.map(function (c) { return '<option value="' + c + '"' + (c === it.cadence ? ' selected' : '') + '>' + esc(C.CADENCE_LABEL[c]) + '</option>'; }).join('') + '</select></div>' +
          (it.dupe ? '<span></span><span class="small muted">Already on your list</span>' : '') + '</li>';
      }).join('') + '</ul><div id="revErr"></div><button class="btn block" type="button" id="revAdd">Add to my list</button>';
    $('#revAdd', body).onclick = function () {
      var picked = [];
      items.forEach(function (it, i) {
        if (!$('[data-on="' + i + '"]', body).checked) return;
        var cents = C.toCents($('[data-amt="' + i + '"]', body).value);
        var name = C.clean($('[data-name="' + i + '"]', body).value, C.LIMITS.name);
        if (cents && name) picked.push({ name: name, cents: cents, cadence: $('[data-cad="' + i + '"]', body).value, renews: it.renews });
      });
      if (!picked.length) return showError(new Error('Tick at least one, with a price.'), $('#revErr', body));
      addDrips(C.snapToDrips(picked, TODAY));
      closeSheet();
      toast('Added ' + plural(picked.length, 'subscription'));
    };
  }

  /** An image shrunk to ~1600px on its long side, as a JPEG. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, PHOTO_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var dataUrl = c.toDataURL('image/jpeg', 0.85);
        URL.revokeObjectURL(url);
        resolve({ type: 'image/jpeg', data: dataUrl.split(',')[1], url: dataUrl });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  /* ---------------- saving to the account: drips only ---------------- */

  function savedBody() { return { drips: state.drips.map(C.toSaved), checkedOn: state.checkedOn || TODAY }; }
  function saveNow() {
    if (!signedIn()) return openAccount('Sign in to save your list. Only the drips are saved - names, amounts, how often, your decisions and notes. Never your statement.', saveNow);
    if (state.mode !== 'mine') return toast('Check your own statement first - the example isn’t saved.');
    api('PUT', 'api/list', savedBody()).then(function (r) {
      state.saved = r.list; state.sync = true; persist(); drawStrip(); drawList(); toast('Saved to your account.');
    }).catch(function (e) { showError(e); });
  }
  function queueSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      api('PUT', 'api/list', savedBody()).then(function (r) { state.saved = r.list; }).catch(function (e) { if (e.status === 401) { state.sync = false; drawStrip(); } else toast(e.message); });
    }, 1200);
  }
  /** After sign-in: open the saved list if this phone has none, or offer to
   *  save this phone's list (showing what changed since the saved one). */
  function syncOnSignIn() {
    if (!signedIn()) return Promise.resolve();
    return api('GET', 'api/list').then(function (r) {
      state.saved = r.list;
      if (!r.list) { drawStrip(); return; }
      if (state.mode !== 'mine') {
        setMine(C.cleanList(r.list.drips, { local: true }), { report: null, since: null, checkedOn: r.list.checkedOn, sync: true });
        toast('Opened your saved list.');
        return;
      }
      if (!state.sync && state.syncedTo && state.syncedTo === state.me.email) {
        // This phone's list was saved to this account before. The account's
        // copy wins when it is newer (changed on another device).
        state.sync = true;
        if (r.list.updatedAt && (!state.localAt || r.list.updatedAt > state.localAt)) {
          setMine(C.cleanList(r.list.drips, { local: true }), { report: state.report, since: null, checkedOn: r.list.checkedOn });
        } else drawAll();
        return;
      }
      if (!state.sync) {
        state.since = Object.assign(C.compare(r.list.drips, state.drips), { on: r.list.checkedOn });
        drawAll();
      }
    }).catch(function () { /* the page works without it */ });
  }

  /* ---------------- account ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Account' : 'Sign in';
    b.onclick = function () { if (signedIn()) openSettings(); else openAccount(); };
  }

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" id="sheetClose" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    $('#sheetClose').onclick = closeSheet;
    back.onclick = closeSheet;
    if (onOpen) onOpen(s);
    var f = s.querySelector('input:not(.vh):not([type=checkbox]), textarea') || s.querySelector('button:not(.close)') || $('#sheetClose');
    setTimeout(function () { try { if (f) f.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  var FREE_LINE = 'Checking a statement, swiping and adding drips by hand are free and need no account. A free account saves your list and lets you snap a subscriptions page with AI - it comes with $2 of credit. One account works across every app on this site.';

  function openAccount(reason, then) {
    var mode = 'register';
    function draw(root) {
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
      $('#swap', root).onclick = function () { mode = mode === 'register' ? 'login' : 'register'; draw(root); };
      $('#authForm', root).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(syncOnSignIn).then(function () { toast('You’re in.'); drawAll(); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(syncOnSignIn).then(function () { drawAll(); if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      };
    }
    sheet('<div class="body"></div>', draw);
  }

  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(
      '<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div>' +
      '<p class="small muted" style="margin:6px 0 0">Snapping a subscriptions page costs a cent or two. Checking statements, swiping and saving are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.sync = false; state.saved = null; drawTop(); persist(); drawAll(); });
        };
        var pk = $('#pkEnrol', root);
        if (pk) pk.onclick = function () {
          var pw = prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        };
      });
  }
  function drawBilling(el) {
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" type="button" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button><p class="small muted">Membership covers every app on this site, runs the better model and lets you add credit.</p>';
        $('#joinM', el).onclick = function () { checkout('api/auth/billing/membership', {}); };
        return;
      }
      el.innerHTML = '<div class="row">' + (b.topUps || []).map(function (t) { return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) { btn.onclick = function () { checkout('api/auth/billing/credit', { usd: Number(btn.getAttribute('data-usd')) }); }; });
    }).catch(function () { el.innerHTML = ''; });
  }
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Checking statements, swiping, adding drips by hand and saving keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- start ---------------- */

  function boot() {
    var local = recall(K_LOCAL);
    if (local && Array.isArray(local.drips)) {
      var list = fromLocal(local);
      if (list.length) {
        state.mode = 'mine';
        state.drips = list;
        state.report = local.report && typeof local.report === 'object' && local.report.range && C.isoDay(local.report.range.from) ? local.report : null;
        state.checkedOn = C.isoDay(local.checkedOn) ? local.checkedOn : null;
        state.since = local.since && Array.isArray(local.since.added) ? local.since : null;
        state.syncedTo = typeof local.syncedTo === 'string' ? local.syncedTo : null;
        state.localAt = typeof local.at === 'string' ? local.at : null;
        drawAll();
        return;
      }
    }
    state.mode = 'sample';
    state.drips = sample().drips;
    drawAll();
  }

  drawTop();
  boot();
  loadMe().then(function () {
    if (!signedIn()) return;
    return syncOnSignIn().then(function () {
      if (/[?&](topup|member|credited)=1\b/.test(location.search)) openSettings();
    });
  });
})();
