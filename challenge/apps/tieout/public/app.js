/* Tieout - the page. One file, no build step. Every string that came from
 * outside this file (a model's reading, a CSV, a typed cell, what this
 * browser kept) is escaped before it is drawn, and no handler is written
 * into markup (the lab's CSP allows script from this origin only). Every
 * number that decides anything - the checks, the diagnosis, the fixes, the
 * CSV reader, the exports - is tieout-core.js, the same file the server and
 * the tests run.
 *
 * Where a statement lives:
 *   example - the two made-up statements. Edits work while the page is open
 *             and are never kept; "Start the example again" resets one.
 *   device  - one converted from a PDF or photos, or checked from a CSV:
 *             kept in this browser's localStorage (every access in
 *             try/catch) until it is removed. Never sent anywhere again.
 * The PDF or photos themselves are held in memory only while the page is
 * open, so "Re-read this page" can send the same file once more.
 */
(function () {
  'use strict';

  var C = window.TieoutCore;
  var S = window.TieoutSample;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LOCAL = 'tieout-v1';
  var PHOTO_PX = 2000;
  var MARK = { fail: '✕', look: '!', pass: '✓' };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var state = {
    me: null,
    list: [],          // statements kept on this device
    examples: {},      // kind -> the example as edited while the page is open
    st: null,          // the statement on screen
    where: null,       // 'example' | 'device'
    view: 'home',      // 'home' | 'stmt' | 'csv' | 'working'
    filter: 'all',     // 'all' | 'flagged'
    files: {},         // statement id -> {kind, files} - memory only, for a re-read
    rereading: null,   // the page being read again
    hit: null,         // a row to highlight after "Show row"
    fixes: [],         // the fixes drawn on screen, by index
    csv: null,         // the CSV checker's working state
    work: null,        // the conversion in progress
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // The reads stream whitespace and so answer 200 even on failure; an
        // {error} body is a failure however it arrived.
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
    var o = opts || {};
    $$('.toast').forEach(function (x) { x.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status');
    var span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
    if (o.undo) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Undo';
      b.onclick = function () { t.remove(); o.undo(); };
      t.appendChild(b);
    }
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, o.ms || (o.undo ? 6000 : 3000));
  }
  function say(msg) { var l = $('#live'); if (l) { l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); } }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, { ms: 4500 });
  }
  /** The 403 an unconfirmed free account gets, with its resend button. */
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note look" role="alert"><p><b>' + esc(e.message) + '</b></p><p class="small">Open the link in that email, then come back and convert. Checking a CSV and the examples are free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).onclick = function () {
      var b = this; b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    };
  }

  /* ---------------- statements on this device ---------------- */

  function loadDevice() {
    var l = recall(K_LOCAL);
    var out = [];
    (l && Array.isArray(l.statements) ? l.statements : []).slice(0, C.LIMITS.statements).forEach(function (raw) {
      try { var st = C.cleanStatement(raw); if (st.src !== 'example') out.push(st); } catch (e) { /* skip a broken one */ }
    });
    state.list = out;
  }
  function saveDevice() {
    if (!keep(K_LOCAL, { v: 1, statements: state.list })) toast('This browser is out of room - export and remove an old statement.', { ms: 5000 });
  }
  function exampleOf(kind) {
    if (!state.examples[kind]) state.examples[kind] = S.statement(kind);
    return state.examples[kind];
  }
  function kindOf(st) { return st.id === 'example-card' ? 'card' : 'checking'; }
  /** The statement on screen changed: keep it where it lives. */
  function setStatement(st) {
    state.st = st;
    if (state.where === 'example') state.examples[kindOf(st)] = st;
    else {
      var i = -1;
      state.list.forEach(function (x, j) { if (x.id === st.id) i = j; });
      if (i >= 0) state.list[i] = st; else state.list.unshift(st);
      saveDevice();
    }
  }
  function addToDevice(st) {
    state.list = [st].concat(state.list.filter(function (x) { return x.id !== st.id; }));
    if (state.list.length > C.LIMITS.statements) {
      state.list = state.list.slice(0, C.LIMITS.statements);
      toast('This browser keeps the newest ' + C.LIMITS.statements + ' statements.');
    }
    saveDevice();
  }
  function removeFromDevice(id) {
    state.list = state.list.filter(function (x) { return x.id !== id; });
    delete state.files[id];
    saveDevice();
  }

  /* ---------------- views ---------------- */

  function render() {
    drawTop();
    if (state.view === 'stmt' && state.st) drawStatement();
    else if (state.view === 'csv') drawCsv();
    else if (state.view === 'working') drawWorking();
    else drawHome();
  }
  function go(view, push) {
    state.view = view;
    if (push !== false) { try { history.pushState({ v: view }, ''); } catch (e) { /* ignore */ } }
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', function () {
    if (state.view === 'working') return;
    state.view = 'home'; state.st = null; render();
  });

  function verdictChip(st) {
    var r = C.check(st);
    var cls = r.status === 'ties' ? 'ties' : r.status === 'off' ? 'off' : 'incomplete';
    return '<span class="chip ' + cls + ' verdict-chip">' + (r.status === 'ties' ? '✓ ' : r.status === 'off' ? '✕ ' : '! ') + esc(r.status === 'ties' ? 'Ties out' : r.headline) + '</span>';
  }

  function drawHome() {
    var cardEx = exampleOf('card'), chkEx = exampleOf('checking');
    var mine = state.list;
    var view = $('#view');
    view.innerHTML =
      (mine.length ? '<section class="card mine" aria-labelledby="mineH"><div class="sec-head"><h2 id="mineH">On this device</h2>' +
        (mine.length > 1 ? '<button class="btn small ghost" type="button" id="exportAll">Export together</button>' : '') + '</div><ul>' +
        mine.slice(0, 6).map(function (st) { return '<li>' + stmtButton(st, 'device') + '</li>'; }).join('') + '</ul>' +
        (mine.length > 6 ? '<p class="small muted" style="margin:8px 0 0">' + (mine.length - 6) + ' more under Statements.</p>' : '') + '</section>' : '') +
      '<div class="homegrid">' +
        '<section class="hero" aria-labelledby="heroH">' +
          '<p class="kicker">Bank statement PDF → CSV</p>' +
          '<h1 id="heroH">Any bank statement PDF to a clean CSV - proven to tie out to the penny.</h1>' +
          '<p class="lede">Tieout reads the statement, then checks every row against the statement’s own arithmetic. If a number was misread, it names the row and offers the fix<span class="wide-only"> - it never hands over numbers it can’t prove</span>.</p>' +
          '<ul class="proofline" aria-label="What it checks"><li>Opening + rows = closing</li><li>Running balance, row by row</li><li>Dates and page breaks</li></ul>' +
          '<button class="btn big start" type="button" id="convertBtn">Convert your statement</button>' +
          '<p class="alt">PDF or photos of the pages · free account · a few cents each</p>' +
          '<p class="alt">Already have a CSV? <button class="link-btn" type="button" id="csvBtn">Check and clean it - free, no account</button></p>' +
        '</section>' +
        '<section class="card" aria-labelledby="exH"><h2 id="exH">Try an example statement</h2><p class="small muted">Made up. No account, no AI - the checks run right here.</p>' +
          '<div class="ex-grid">' +
            '<button class="ex" type="button" data-ex="checking"><span class="ico" aria-hidden="true">🏦</span><b>Business checking · September</b><span class="sub">' + chkEx.rows.length + ' rows on 3 pages, with a misread row to catch</span>' + verdictChip(chkEx) + '</button>' +
            '<button class="ex" type="button" data-ex="card"><span class="ico" aria-hidden="true">💳</span><b>Business credit card · September</b><span class="sub">' + cardEx.rows.length + ' rows on 2 pages, no running balance</span>' + verdictChip(cardEx) + '</button>' +
          '</div>' +
          '<div class="note small" style="margin:12px 0 0"><b>Why “proven”:</b> a statement carries its own arithmetic - the opening balance plus every row is the closing balance, and most print a balance after each day. A misread digit breaks it, and the break says where.</div>' +
        '</section>' +
      '</div>' +
      '<section class="card how" aria-labelledby="howH" style="margin-top:14px"><h2 id="howH">How it works</h2><ol>' +
        '<li><span class="n" aria-hidden="true">1</span><div><b>Read</b><p>Drop in a statement PDF (up to ' + C.LIMITS.pages + ' pages) or photos of its pages. AI reads every row - date, description, amount, the printed balance - from any bank’s layout. No per-bank template to break.</p></div></li>' +
        '<li><span class="n" aria-hidden="true">2</span><div><b>Prove</b><p>The checks are plain arithmetic, run on your device: the total, the running balance row by row, dates in the period, repeats across page breaks. Off by a cent? It names the row - a slipped decimal, a flipped sign, two digits swapped, a missed line.</p></div></li>' +
        '<li><span class="n" aria-hidden="true">3</span><div><b>Export</b><p>Fix it in one tap or edit any cell, then download CSV, QuickBooks Online, Xero or OFX - one statement or a run of months, with a warning where one month doesn’t meet the next.</p></div></li>' +
      '</ol></section>' +
      '<section class="card priv" aria-labelledby="privH"><h2 id="privH">What happens to your statement</h2><ul class="small">' +
        '<li><b>Sent once</b> to Claude (Anthropic’s AI) to read the rows - and only when you convert a PDF or photos.</li>' +
        '<li><b>Not kept by Tieout</b> - not the file, not the rows, not on any server. Rows stay in this browser until you remove them.</li>' +
        '<li><b>Account numbers masked</b> to their last four digits, whatever the statement prints.</li>' +
        '<li><b>A CSV never leaves this device</b> - checking one makes no request at all.</li>' +
      '</ul></section>';
    $('#convertBtn').onclick = function () { openUpload(); };
    $('#csvBtn').onclick = function () { openCsv(); };
    $$('[data-ex]', view).forEach(function (b) { b.onclick = function () { openStatement(exampleOf(b.getAttribute('data-ex')), 'example'); }; });
    $$('[data-open]', view).forEach(function (b) { b.onclick = function () { var st = byId(b.getAttribute('data-open')); if (st) openStatement(st, 'device'); }; });
    var ea = $('#exportAll'); if (ea) ea.onclick = function () { openExport(state.list.map(function (x) { return x.id; })); };
  }
  function byId(id) { for (var i = 0; i < state.list.length; i++) if (state.list[i].id === id) return state.list[i]; return null; }
  function stmtButton(st, where) {
    return '<button class="ex" type="button" data-open="' + esc(st.id) + '" data-where="' + where + '"><span class="ico" aria-hidden="true">' + (C.isLiability(st.type) ? '💳' : '🏦') + '</span><b>' + esc(C.label(st)) + '</b><span class="sub">' + esc(C.fmtPeriod(st.start, st.end) + ' · ' + plural(st.rows.length, 'row')) + '</span>' + verdictChip(st) + '</button>';
  }

  function openStatement(st, where) {
    state.st = st; state.where = where; state.filter = 'all'; state.hit = null; state.rereading = null;
    go('stmt');
    var r = C.check(st);
    say(r.headline + '. ' + r.sub);
  }

  /* ---------------- one statement ---------------- */

  function drawStatement() {
    var st = state.st, r = C.check(st), liab = C.isLiability(st.type), cur = st.currency;
    state.fixes = [];
    var fixBtn = function (fx, cls) {
      if (!fx) return '';
      state.fixes.push(fx);
      return '<button class="btn small ' + (cls || '') + '" type="button" data-fix="' + (state.fixes.length - 1) + '">' + esc(fx.label) + '</button>';
    };
    var pages = C.pagesOf(st);
    var flaggedIds = Object.keys(r.flags);
    var view = $('#view');
    var where = state.where === 'example' ? 'Example - made up; your changes here are not kept' : st.src === 'csv' ? 'From a CSV · kept in this browser only' : 'Read from ' + (st.src === 'photo' ? 'photos' : 'a PDF') + (st.name ? ' (' + st.name + ')' : '') + ' · kept in this browser only';
    var primaryRow = r.primary && (r.primary.row || r.primary.before);
    view.innerHTML =
      '<div class="st-head"><div style="min-width:0"><h1>' + esc(C.label(st)) + '</h1>' +
        '<p class="meta">' + esc(C.TYPE_LABEL[st.type] + ' · ' + C.fmtPeriod(st.start, st.end) + ' · ' + st.currency + ' · ' + plural(st.rows.length, 'row') + (pages.length ? ' · ' + plural(pages.length, 'page') : '')) + '</p>' +
        '<p class="where">' + esc(where) + '</p></div>' +
        '<div class="row"><button class="btn small ghost" type="button" id="backBtn">‹ Back</button><button class="btn small ghost" type="button" id="detailsBtn">Details</button></div></div>' +
      '<div class="st-grid">' +
        '<aside class="st-side" aria-label="Does it tie out">' +
          '<section class="verdict ' + r.status + '" id="verdict" aria-live="polite"><p class="big">' + esc(r.headline) + '</p><p class="why">' + esc(r.sub) + '</p>' +
            (r.primary ? '<div class="row">' + fixBtn(r.primary) + (primaryRow ? '<button class="btn small ghost" type="button" id="showRow">Show row ' + C.rowNo(st, primaryRow) + '</button>' : '') + '</div>' : '') +
            (r.status === 'ties' ? '<button class="btn block" type="button" id="exportBtn">Export</button>' : '') +
          '</section>' +
          proofHtml(st, r, liab, cur) +
          '<section class="card" aria-labelledby="chkH"><h2 id="chkH">Checks</h2><ul class="checks">' + r.checks.slice().sort(function (a, b) { return rank(a.status) - rank(b.status); }).map(function (c) {
            return '<li class="' + c.status + '"><span class="mk ' + c.status + '" aria-hidden="true">' + MARK[c.status] + '</span><div><span class="ct">' + esc(c.title) + ' <span class="vh">(' + (c.status === 'pass' ? 'passes' : c.status === 'look' ? 'worth a look' : 'to fix') + ')</span></span><p>' + esc(c.text) + '</p>' +
              (c.fixes && c.fixes.length && c.status !== 'pass' ? '<div class="fixes">' + c.fixes.slice(0, 3).map(function (f) { return fixBtn(f, 'ghost'); }).join('') + '</div>' : '') + '</div></li>';
          }).join('') + '</ul></section>' +
          (st.notes && st.notes.length ? '<div class="note notes"><b>From the reading:</b><ul>' + st.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>' : '') +
          '<div class="side-acts">' + (r.status !== 'ties' ? '<button class="btn block ghost" type="button" id="exportBtn">Export</button>' : '') +
            (state.where === 'example' ? '<button class="btn block ghost" type="button" id="resetEx">Start the example again</button>' : '<button class="btn block ghost" type="button" id="removeSt">Remove from this browser</button>') + '</div>' +
        '</aside>' +
        '<section class="st-main card" aria-labelledby="rowsH">' +
          '<div class="tbl-tools"><h2 id="rowsH" style="margin:0">Rows</h2><div class="seg" role="group" aria-label="Show">' +
            '<button type="button" data-filter="all" aria-pressed="' + (state.filter === 'all') + '">All ' + st.rows.length + '</button>' +
            '<button type="button" data-filter="flagged" aria-pressed="' + (state.filter === 'flagged') + '">To look at ' + flaggedIds.length + '</button></div></div>' +
          '<p class="small muted" style="margin:0 0 8px">Tap any cell to change it - the checks run again as you type it in. Tap a row’s number to add or remove a row.</p>' +
          tableHtml(st, r, pages) +
          '<button class="btn small ghost addrow" type="button" id="addRow">+ Add a row at the end</button>' +
        '</section>' +
      '</div>';

    $('#backBtn').onclick = function () { history.length > 1 ? history.back() : go('home'); };
    $('#detailsBtn').onclick = openDetails;
    $$('[data-fix]', view).forEach(function (b) { b.onclick = function () { applyFix(state.fixes[Number(b.getAttribute('data-fix'))]); }; });
    var sr = $('#showRow'); if (sr) sr.onclick = function () { showRow(primaryRow); };
    $$('#exportBtn', view).forEach(function (b) { b.onclick = function () { openExport([st.id]); }; });
    var rs = $('#resetEx'); if (rs) rs.onclick = function () { var k = kindOf(st); state.examples[k] = S.statement(k); state.st = state.examples[k]; drawStatement(); toast('The example is back as it was read.'); };
    var rm = $('#removeSt'); if (rm) rm.onclick = function () { confirmRemove(st); };
    $$('[data-filter]', view).forEach(function (b) { b.onclick = function () { state.filter = b.getAttribute('data-filter'); drawStatement(); }; });
    $('#addRow').onclick = function () { insertRow(null); };
    $$('[data-reread]', view).forEach(function (b) { b.onclick = function () { rereadPage(Number(b.getAttribute('data-reread'))); }; });
    if (state.hit) {
      var hit = $('tr[data-row="' + state.hit + '"]');
      if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'center' });
    }
  }
  function rank(s) { return { fail: 0, look: 1, pass: 2 }[s]; }

  function proofHtml(st, r, liab, cur) {
    var edit = function (field, cents, labelText) {
      return '<span class="ed-wrap" data-headwrap="' + field + '"><button class="ed" type="button" data-head="' + field + '" aria-label="' + esc(labelText) + ' - tap to change">' + (cents === null ? 'Type it in' : esc(C.money(cents, cur))) + '</button></span>';
    };
    var nIn = st.rows.filter(function (x) { return x.amount !== null && x.amount > 0; }).length;
    var nOut = st.rows.filter(function (x) { return x.amount !== null && x.amount < 0; }).length;
    var diffCls = r.diff === null ? '' : r.diff === 0 ? 'good' : 'bad';
    return '<section class="card proof" aria-labelledby="proofH"><h2 id="proofH">The proof</h2><dl>' +
      '<dt>' + (liab ? 'Previous balance' : 'Opening balance') + '</dt><dd>' + edit('opening', st.opening, liab ? 'Previous balance' : 'Opening balance') + '</dd>' +
      '<dt>' + (liab ? 'Payments and credits' : 'Money in') + ' <small>' + plural(nIn, 'row') + '</small></dt><dd>' + (liab ? '− ' : '+ ') + esc(C.fmtAbs(r.moneyIn)) + '</dd>' +
      '<dt>' + (liab ? 'Purchases and charges' : 'Money out') + ' <small>' + plural(nOut, 'row') + '</small></dt><dd>' + (liab ? '+ ' : '− ') + esc(C.fmtAbs(r.moneyOut)) + '</dd>' +
      '<div class="sum" style="display:contents"><dt>The rows come to</dt><dd>' + (r.computed === null ? '-' : esc(C.money(r.computed, cur))) + '</dd></div>' +
      '<dt>' + (liab ? 'New balance' : 'Closing balance') + ' <small>as printed</small></dt><dd>' + edit('closing', st.closing, liab ? 'New balance' : 'Closing balance') + '</dd>' +
      '<div class="diff ' + diffCls + '" style="display:contents"><dt>Difference</dt><dd>' + (r.diff === null ? '-' : r.diff === 0 ? '0.00 ✓' : esc((r.diff > 0 ? '+' : '−') + C.fmtAbs(r.diff))) + '</dd></div>' +
      '</dl>' + (r.balances.printed ? '<p class="small muted" style="margin:8px 0 0">' + esc(r.balances.matched + ' of ' + r.balances.printed + ' printed balances follow from the rows before them.') + '</p>' : '') + '</section>';
  }

  function tableHtml(st, r, pages) {
    var year = (st.end || st.start || '').slice(0, 4);
    var reread = st.src === 'pdf' || st.src === 'photo' || state.where === 'example';
    var only = state.filter === 'flagged';
    var html = '<table class="rows"><colgroup><col class="c-n"><col class="c-d"><col><col class="c-a"><col class="c-b"></colgroup><thead><tr><th>#</th><th>Date</th><th>Description</th><th class="r">Amount</th><th class="r">Balance</th></tr></thead><tbody>';
    var lastPage = 'none', shown = 0;
    st.rows.forEach(function (row, i) {
      var flags = r.flags[row.id] || [];
      if (only && !flags.length) return;
      if (pages.length && row.page !== lastPage) {
        lastPage = row.page;
        var count = st.rows.filter(function (x) { return x.page === row.page; }).length;
        var busy = state.rereading === row.page;
        html += '<tr class="pg"><th colspan="5"><div class="pgbar"><span>Page ' + esc(row.page || '?') + ' <span class="muted">· ' + plural(count, 'row') + '</span></span>' +
          (reread && row.page ? (busy ? '<span class="small"><span class="spin" aria-hidden="true"></span> Reading page ' + row.page + ' again…</span>' : '<button class="btn small ghost" type="button" data-reread="' + row.page + '">Re-read this page</button>') : '') + '</div></th></tr>';
      }
      shown++;
      var fail = flags.some(function (f) { return f.status === 'fail'; });
      var look = !fail && flags.length;
      var amtBad = row.amount === null || flags.some(function (f) { return f.fixes.some(function (x) { return (x.op === 'amount' || x.op === 'delete') && x.row === row.id; }); });
      var balBad = flags.some(function (f) { return /^Balance doesn/.test(f.text) || f.fixes.some(function (x) { return x.op === 'balance'; }); });
      var dateLook = flags.some(function (f) { return /outside the statement period|back in time/.test(f.text); });
      var cell = function (field, textShown, cls, aria) {
        return '<button class="cell ' + (cls || '') + '" type="button" data-cell="' + field + '" data-row="' + esc(row.id) + '" aria-label="' + esc(aria) + '">' + esc(textShown) + '</button>';
      };
      var n = i + 1;
      html += '<tr class="r0' + (fail ? ' flagged' : look ? ' looked' : '') + (state.hit === row.id ? ' hit' : '') + '" data-row="' + esc(row.id) + '">' +
        '<td class="t-n"><button class="rn" type="button" data-rowmenu="' + esc(row.id) + '" aria-label="Row ' + n + ' - add or remove">' + n + '</button></td>' +
        '<td class="t-d">' + cell('date', row.date ? C.fmtDay(row.date, year) : 'No date', !row.date ? 'bad' : dateLook ? 'lookc' : '', 'Row ' + n + ' date ' + (row.date || 'missing')) + '</td>' +
        '<td class="t-s">' + cell('desc', row.desc || 'No description', row.desc ? '' : 'empty', 'Row ' + n + ' description') + '</td>' +
        '<td class="t-a r">' + cell('amount', row.amount === null ? 'No amount' : C.signed(row.amount), amtBad ? 'bad' : row.amount > 0 ? 'in' : '', 'Row ' + n + ' amount ' + (row.amount === null ? 'missing' : (row.amount > 0 ? 'money in ' : 'money out ') + C.fmtAbs(row.amount))) + '</td>' +
        '<td class="t-b r">' + cell('balance', row.balance === null ? '' : (row.balance < 0 ? '−' : '') + C.fmtAbs(row.balance), balBad ? 'bad' : row.balance === null ? 'none' : '', 'Row ' + n + ' printed balance ' + (row.balance === null ? 'none' : C.fmtAbs(row.balance))) + '</td></tr>';
      if (flags.length) {
        html += '<tr class="flag"><td colspan="5">' + flags.map(function (f) {
          return '<div class="flagbox"><span class="mk ' + f.status + '" aria-hidden="true">' + MARK[f.status] + '</span><div><span>' + esc(f.text) + '</span>' +
            (f.fixes.length ? '<div class="fx">' + f.fixes.map(function (fx) { state.fixes.push(fx); return '<button class="btn small ghost" type="button" data-fix="' + (state.fixes.length - 1) + '">' + esc(fx.label) + '</button>'; }).join('') + '</div>' : '') + '</div></div>';
        }).join('') + '</td></tr>';
      }
    });
    html += '</tbody></table>';
    if (!shown) html += '<p class="empty-rows">' + (only ? 'Nothing to look at - every row reads cleanly.' : 'No rows yet. Add one, or re-read a page.') + '</p>';
    return html;
  }

  /* ---------------- changing a statement ---------------- */

  function change(next, message) {
    var before = state.st;
    var was = C.check(before).status;
    setStatement(next);
    var r = C.check(next);
    drawStatement();
    var v = $('#verdict');
    if (v && was !== r.status) { v.classList.add('flash'); }
    say(r.headline + '. ' + r.sub);
    if (message !== false) {
      var tail = r.status === 'ties' && was !== 'ties' ? ' - ties out ✓' : r.status === 'off' && was === 'ties' ? ' - now off by ' + C.money(Math.abs(r.diff || 0), next.currency) : '';
      toast((message || 'Changed') + tail, { undo: function () { setStatement(before); drawStatement(); say(C.check(before).headline); } });
    }
  }
  function applyFix(fx) {
    if (!fx) return;
    var next = C.applyFix(state.st, fx);
    state.hit = fx.row || null;
    var n = fx.row ? C.rowNo(state.st, fx.row) : 0;
    var msg = fx.op === 'amount' ? 'Row ' + n + ' is now ' + C.signed(fx.value)
      : fx.op === 'balance' ? 'Row ' + n + '’s balance is now ' + C.fmtAbs(fx.value)
      : fx.op === 'delete' ? 'Removed row ' + n
      : fx.op === 'insert' ? 'Added a ' + C.fmtAbs(fx.value) + ' row'
      : (fx.op === 'opening' ? 'Opening' : 'Closing') + ' balance is now ' + C.fmtAbs(fx.value);
    change(next, msg);
  }
  function showRow(id) {
    state.filter = 'all'; state.hit = id; drawStatement();
    var b = $('tr[data-row="' + id + '"] [data-cell="amount"]'); if (b) try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); }
  }
  function insertRow(beforeId, after) {
    var st = state.st, at = -1;
    st.rows.forEach(function (r, i) { if (r.id === beforeId) at = i; });
    var target = after ? st.rows[at + 1] : st.rows[at];
    var near = st.rows[at] || st.rows[st.rows.length - 1] || {};
    if (st.rows.length >= C.LIMITS.rows) return toast('A statement holds up to ' + C.LIMITS.rows + ' rows.');
    var next = C.applyFix(st, { op: 'insert', before: target ? target.id : null, value: null, date: near.date || st.end, desc: 'New row' });
    // The new row has no amount: open its amount cell straight away.
    var added = next.rows.filter(function (x) { return !st.rows.some(function (y) { return y.id === x.id; }); })[0];
    state.hit = added ? added.id : null;
    change(next, false);
    if (added) openCell($('tr[data-row="' + added.id + '"] [data-cell="amount"]'));
  }
  function deleteRow(id) {
    var n = C.rowNo(state.st, id);
    change(C.applyFix(state.st, { op: 'delete', row: id }), 'Removed row ' + n);
  }

  /* inline editing: a cell button becomes an input; Enter or leaving it
     keeps the value, Escape puts it back. */
  function editValue(row, field) {
    if (field === 'date') return row.date || '';
    if (field === 'desc') return row.desc || '';
    if (field === 'amount') return row.amount === null ? '' : C.plain(row.amount);
    return row.balance === null ? '' : C.plain(row.balance);
  }
  function openCell(btn) {
    if (!btn) return;
    var id = btn.getAttribute('data-row'), field = btn.getAttribute('data-cell');
    var row = null;
    state.st.rows.forEach(function (x) { if (x.id === id) row = x; });
    if (!row) return;
    var td = btn.parentNode;
    var inp = document.createElement('input');
    inp.className = 'cell-in' + (field === 'amount' || field === 'balance' ? ' r' : '');
    inp.value = editValue(row, field);
    inp.setAttribute('aria-label', btn.getAttribute('aria-label'));
    if (field === 'amount' || field === 'balance') { inp.inputMode = 'decimal'; inp.placeholder = field === 'amount' ? '-1240.00' : 'none'; }
    if (field === 'date') inp.placeholder = 'YYYY-MM-DD';
    td.innerHTML = '';
    td.appendChild(inp);
    inp.focus(); inp.select();
    var done = false;
    var commit = function (move) {
      if (done) return;
      var res = C.editCell(state.st, id, field, inp.value);
      if (res.error) {
        var e = td.querySelector('.cell-err');
        if (!e) { e = document.createElement('div'); e.className = 'cell-err'; e.setAttribute('role', 'alert'); td.appendChild(e); }
        e.textContent = res.error;
        inp.focus();
        return;
      }
      done = true;
      var same = JSON.stringify(res.statement.rows) === JSON.stringify(state.st.rows);
      if (same) { drawStatement(); refocus(id, field, move); return; }
      state.hit = id;
      change(res.statement, false);
      refocus(id, field, move);
    };
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(0); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; drawStatement(); refocus(id, field, 0); }
      else if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? -1 : 1); }
    });
    inp.addEventListener('blur', function () { setTimeout(function () { if (!done && document.body.contains(inp)) commit(null); }, 0); });
  }
  var FIELDS = ['date', 'desc', 'amount', 'balance'];
  function refocus(id, field, move) {
    var cells = $$('#view [data-cell]');
    var at = -1;
    cells.forEach(function (c, i) { if (c.getAttribute('data-row') === id && c.getAttribute('data-cell') === field) at = i; });
    if (at < 0) return;
    if (move === 1 || move === -1) {
      var nb = cells[at + move];
      if (nb) { openCell(nb); return; }
    }
    if (move !== null) try { cells[at].focus({ preventScroll: true }); } catch (e) { cells[at].focus(); }
  }
  void FIELDS;
  function openHead(btn) {
    var field = btn.getAttribute('data-head');
    var wrap = btn.parentNode;
    var inp = document.createElement('input');
    inp.className = 'cell-in r'; inp.inputMode = 'decimal'; inp.style.width = '150px';
    var cents = state.st[field];
    inp.value = cents === null ? '' : C.plain(cents);
    inp.setAttribute('aria-label', btn.getAttribute('aria-label'));
    wrap.innerHTML = ''; wrap.appendChild(inp); inp.focus(); inp.select();
    var done = false;
    var commit = function () {
      if (done) return;
      var res = C.editHead(state.st, field, inp.value);
      if (res.error) { toast(res.error); inp.focus(); return; }
      done = true;
      if (res.statement[field] === state.st[field]) return drawStatement();
      change(res.statement, (field === 'opening' ? 'Opening' : 'Closing') + ' balance changed');
    };
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; drawStatement(); }
    });
    inp.addEventListener('blur', function () { setTimeout(function () { if (!done && document.body.contains(inp)) commit(); }, 0); });
  }
  document.addEventListener('click', function (e) {
    if (state.view !== 'stmt') return;
    var t = e.target.closest ? e.target.closest('[data-cell], [data-head], [data-rowmenu]') : null;
    if (!t || !$('#view').contains(t)) return;
    if (t.hasAttribute('data-cell')) openCell(t);
    else if (t.hasAttribute('data-head')) openHead(t);
    else rowMenu(t.getAttribute('data-rowmenu'));
  });
  function rowMenu(id) {
    var st = state.st, n = C.rowNo(st, id), row = st.rows[n - 1];
    if (!row) return;
    sheet('<h2>Row ' + n + '</h2><p class="muted">' + esc((row.date ? C.fmtDay(row.date, (st.end || '').slice(0, 4)) + ' · ' : '') + (row.desc || 'No description') + (row.amount !== null ? ' · ' + C.signed(row.amount) : '')) + '</p>' +
      '<div style="display:grid;gap:8px"><button class="btn ghost block" type="button" id="insAbove">Add a row above</button><button class="btn ghost block" type="button" id="insBelow">Add a row below</button><button class="btn danger block" type="button" id="delRow">Remove this row</button></div>', function (root) {
      $('#insAbove', root).onclick = function () { closeSheet(); insertRow(id); };
      $('#insBelow', root).onclick = function () { closeSheet(); insertRow(id, true); };
      $('#delRow', root).onclick = function () { closeSheet(); deleteRow(id); };
    });
  }
  function confirmRemove(st) {
    sheet('<h2>Remove this statement?</h2><p>' + esc(C.label(st)) + ' leaves this browser. Nothing else holds a copy, so export it first if you need it.</p><div class="row"><button class="btn danger" type="button" id="yesRm">Remove it</button><button class="btn ghost" type="button" id="noRm">Keep it</button></div>', function (root) {
      $('#yesRm', root).onclick = function () { closeSheet(); removeFromDevice(st.id); go('home'); toast('Removed from this browser.'); };
      $('#noRm', root).onclick = closeSheet;
    });
  }
  function openDetails() {
    var st = state.st;
    sheet('<h2>Statement details</h2><p class="small muted">As read from the statement - change anything that was read wrong. The period decides which dates are flagged.</p>' +
      '<label class="field"><span>Bank or card issuer</span><input class="input" id="dBank" maxlength="' + C.LIMITS.bank + '"></label>' +
      '<div class="grid2"><label class="field"><span>Account type</span><select class="input" id="dType">' + C.TYPES.map(function (t) { return '<option value="' + t + '"' + (st.type === t ? ' selected' : '') + '>' + esc(C.TYPE_LABEL[t]) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Last four digits</span><input class="input" id="dLast4" inputmode="numeric" maxlength="4" autocomplete="off"></label></div>' +
      '<div class="grid2"><label class="field"><span>Period from</span><input class="input" id="dStart" type="date"></label><label class="field"><span>Period to</span><input class="input" id="dEnd" type="date"></label></div>' +
      '<label class="field"><span>Currency</span><select class="input" id="dCur">' + C.CURRENCIES.map(function (c) { return '<option' + (st.currency === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>' +
      '<div id="dErr"></div><button class="btn block" type="button" id="dSave">Save</button>', function (root) {
      $('#dBank', root).value = st.bank; $('#dLast4', root).value = st.last4; $('#dStart', root).value = st.start || ''; $('#dEnd', root).value = st.end || '';
      $('#dSave', root).onclick = function () {
        var s = st, steps = [['bank', $('#dBank', root).value], ['type', $('#dType', root).value], ['last4', $('#dLast4', root).value], ['start', $('#dStart', root).value], ['end', $('#dEnd', root).value], ['currency', $('#dCur', root).value]];
        for (var i = 0; i < steps.length; i++) {
          var res = C.editHead(s, steps[i][0], steps[i][1]);
          if (res.error) return showError(new Error(res.error), $('#dErr', root));
          s = res.statement;
        }
        closeSheet();
        change(s, 'Details saved');
      };
    });
  }

  /* ---------------- converting a statement (the one model call) ---------------- */

  var PRIVACY = '<div class="note small priv-note"><b>What is sent:</b> the file, once, to Claude (Anthropic’s AI) to read the rows. <b>What is kept:</b> nothing by Tieout - not the file, not the rows. Account numbers come back as their last four digits. The rows live in this browser until you remove them.</div>';

  function openUpload() {
    if (!signedIn()) {
      sheet('<h2>Convert a statement</h2><p class="muted">Reading a PDF or photos uses AI, so it needs a free account. It comes with $2 of credit; a statement costs a few cents.</p>' +
        '<p class="small muted">The examples and checking a CSV you already have are free, with no account.</p>' + PRIVACY +
        '<button class="btn block" type="button" id="uIn">Sign in or create a free account</button><button class="btn ghost block" type="button" id="uCsv" style="margin-top:10px">Check a CSV instead - free</button>', function (root) {
        $('#uIn', root).onclick = function () { openAccount(null, openUpload); };
        $('#uCsv', root).onclick = function () { closeSheet(); openCsv(); };
      });
      return;
    }
    var picked = [];
    function draw(root) {
      var body = $('.body', root);
      var pdf = picked.filter(function (p) { return p.kind === 'pdf'; })[0];
      var photos = picked.filter(function (p) { return p.kind === 'photo'; });
      body.innerHTML = '<h2>Convert a statement</h2>' +
        '<p class="small muted"><b>A PDF</b> of one statement (up to 10 MB and ' + C.LIMITS.pages + ' pages), <b>or photos</b> of its pages - up to ' + C.LIMITS.photos + ', one per page, in order.</p>' +
        '<div class="drop" id="drop"><p style="margin:0"><b>Drop the statement here</b></p><label class="btn ghost">Choose a file<input type="file" accept="application/pdf,.pdf,image/*" multiple id="upFile" class="vh"></label></div>' +
        (picked.length ? '<ul class="picked">' + picked.map(function (p, i) { return '<li><span>' + (p.kind === 'pdf' ? '📄 ' : '🖼️ Page ' + (i + 1) + ': ') + esc(p.name) + ' <span class="small muted">' + esc(sizeText(p.size)) + '</span></span><button type="button" class="ibtn" data-rmp="' + i + '" aria-label="Remove ' + esc(p.name) + '">✕</button></li>'; }).join('') + '</ul>' : '') +
        '<div id="upErr"></div>' +
        '<button class="btn block big" type="button" id="upGo"' + (picked.length ? '' : ' disabled') + '>' + (pdf ? 'Convert and check' : photos.length ? 'Convert ' + plural(photos.length, 'page') + ' and check' : 'Convert and check') + '</button>' +
        '<p class="small muted center">Uses AI credit - a few cents. Usually 30-90 seconds.</p>' + PRIVACY;
      var inp = $('#upFile', body);
      inp.onchange = function () { add(inp.files, root); inp.value = ''; };
      var drop = $('#drop', body);
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) add(e.dataTransfer.files, root); });
      $$('[data-rmp]', body).forEach(function (b) { b.onclick = function () { picked.splice(Number(b.getAttribute('data-rmp')), 1); draw(root); }; });
      $('#upGo', body).onclick = function () {
        if (!picked.length) return;
        closeSheet();
        convert({ kind: pdf ? 'pdf' : 'photo', files: pdf ? [pdf.file] : photos.map(function (p) { return p.file; }), name: pdf ? pdf.name : plural(photos.length, 'photo') });
      };
    }
    function add(fileList, root) {
      var problems = [];
      Array.prototype.slice.call(fileList || []).forEach(function (file) {
        var isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
        var isImg = /^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) || /\.(jpe?g|png|webp|heic)$/i.test(file.name);
        if (!isPdf && !isImg) { problems.push(file.name + ' isn’t a PDF or a photo.' + (/\.(csv|txt)$/i.test(file.name) ? ' Use “Check a CSV” for a CSV - free.' : '')); return; }
        if (isPdf && file.size > C.LIMITS.pdfBytes) { problems.push(file.name + ' is over 10 MB - download just the one statement.'); return; }
        var hasPdf = picked.some(function (p) { return p.kind === 'pdf'; });
        var nPhotos = picked.filter(function (p) { return p.kind === 'photo'; }).length;
        if (isPdf && (hasPdf || nPhotos)) { problems.push('One statement at a time: one PDF, or photos of its pages.'); return; }
        if (isImg && hasPdf) { problems.push('One statement at a time: one PDF, or photos of its pages.'); return; }
        if (isImg && nPhotos >= C.LIMITS.photos) { problems.push('Up to ' + C.LIMITS.photos + ' photos - one per page.'); return; }
        picked.push({ kind: isPdf ? 'pdf' : 'photo', name: C.clean(file.name, 80), size: file.size, file: file });
      });
      draw(root);
      if (problems.length) showError(new Error(problems.slice(0, 3).join(' ')), $('#upErr', root));
    }
    sheet('<div class="body"></div>', draw);
  }
  function sizeText(n) { return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function bodyFor(job, page) {
    if (job.kind === 'pdf') {
      return readBase64(job.files[0]).then(function (b64) {
        if (!/^JVBERi0/.test(b64)) throw new Error('That file isn’t a PDF.');
        return { pdf: { data: b64 } };
      });
    }
    var list = page ? [job.files[page - 1]].filter(Boolean) : job.files;
    if (!list.length) return Promise.reject(new Error('There’s no photo for page ' + page + '.'));
    return Promise.all(list.map(shrink)).then(function (photos) { return { photos: photos }; });
  }
  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(new Error('That file could not be opened.')); };
      r.readAsDataURL(file);
    });
  }
  /** A photo shrunk to ~2000px on its long side, as a JPEG: small print stays legible. */
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
        resolve({ type: 'image/jpeg', data: dataUrl.split(',')[1] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be opened. Try a JPEG or PNG.')); };
      img.src = url;
    });
  }

  function convert(job) {
    state.work = { job: job, since: Date.now(), step: 0, error: null };
    go('working');
    bodyFor(job).then(function (body) {
      body.name = job.name;
      if (state.work) { state.work.step = 1; drawWorking(); }
      return api('POST', 'api/read', body);
    }).then(function (res) {
      var st = C.cleanStatement(res.statement);
      st.notes = (res.notes || []).slice(0, C.LIMITS.notes);
      addToDevice(st);
      state.files[st.id] = { kind: job.kind, files: job.files };
      stopWork();
      state.st = st; state.where = 'device'; state.filter = 'all'; state.hit = null;
      state.view = 'stmt';
      try { history.replaceState({ v: 'stmt' }, ''); } catch (e) { /* ignore */ }
      render(); window.scrollTo(0, 0);
      var r = C.check(st);
      say(r.headline + '. ' + r.sub);
      toast(r.status === 'ties' ? 'Read and proven - it ties out.' : r.status === 'off' ? 'Read - and the check caught something.' : 'Read - a figure is still needed to prove it.');
    }).catch(function (e) {
      if (!state.work) return;
      if (e.status === 401) { stopWork(); go('home'); return openAccount('Sign in to convert a statement.', openUpload); }
      if (e.status === 402) { stopWork(); go('home'); return openCredit(e.data); }
      state.work.error = e;
      drawWorking();
    });
  }
  var workTimer = null;
  function stopWork() { clearInterval(workTimer); workTimer = null; state.work = null; }
  function drawWorking() {
    var w = state.work, view = $('#view');
    if (!w) { state.view = 'home'; return drawHome(); }
    if (w.error) {
      clearInterval(workTimer); workTimer = null;
      view.innerHTML = '<section class="card working"><h1>That didn’t work</h1><div id="workErr"></div><div class="row" style="justify-content:center;margin-top:12px"><button class="btn" type="button" id="wAgain">Try again</button><button class="btn ghost" type="button" id="wBack">Back</button></div></section>';
      if (w.error.data && w.error.data.code === 'verify-email') verifyNote($('#workErr'), w.error);
      else $('#workErr').innerHTML = '<p class="err" role="alert">' + esc(w.error.message) + '</p><p class="small muted">Nothing was kept, and a failed reading isn’t charged for more than the attempt.</p>';
      $('#wAgain').onclick = function () { var j = w.job; stopWork(); convert(j); };
      $('#wBack').onclick = function () { stopWork(); go('home'); };
      return;
    }
    var secs = Math.round((Date.now() - w.since) / 1000);
    var steps = ['Getting the file ready on this device', 'Reading every row - usually 30-90 seconds', 'Checking the arithmetic, on this device'];
    view.innerHTML = '<section class="card working" aria-busy="true"><span class="spin" aria-hidden="true"></span><h1>Reading ' + esc(w.job.name) + '…</h1><p class="muted" id="wSecs">' + plural(secs, 'second') + '</p>' +
      '<ol>' + steps.map(function (s, i) { return '<li class="' + (i === w.step ? 'now' : '') + '">' + (i < w.step ? '✓ ' : '') + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="small muted" style="margin-top:14px">Keep this page open. The file is read once and not kept.</p></section>';
    if (!workTimer) workTimer = setInterval(function () {
      var el = $('#wSecs');
      if (!state.work || state.work.error || !el) return;
      el.textContent = plural(Math.round((Date.now() - state.work.since) / 1000), 'second');
    }, 1000);
  }

  /* ---------------- re-read one page ---------------- */

  /** The running balance just before `page`'s first row, from what is printed. */
  function balanceBefore(st, page) {
    if (st.opening === null) return null;
    var bal = st.opening, dir = C.dirOf(st.type);
    for (var i = 0; i < st.rows.length; i++) {
      var r = st.rows[i];
      if (r.page === page) return bal;
      if (r.amount === null) return null;
      bal += dir * r.amount;
      if (r.balance !== null) bal = r.balance;
    }
    return bal;
  }
  function rereadPage(page) {
    var st = state.st;
    if (state.where === 'example') {
      sheet('<h2>Re-read page ' + page + '</h2><p>On your own statements this sends the same file again for a second, careful reading of just this page - about a cent - and puts its rows in place of the old ones.</p><p class="small muted">In the example it’s simulated, with no AI: page ' + page + ' comes back as the statement prints it.</p><button class="btn block" type="button" id="rrGo">Re-read page ' + page + ' (example)</button>', function (root) {
        $('#rrGo', root).onclick = function () {
          closeSheet();
          var right = S.statement(kindOf(st), true).rows.filter(function (r) { return r.page === page; });
          finishReread(page, { rows: right, pageTotals: null, notes: [] });
        };
      });
      return;
    }
    var have = state.files[st.id];
    var count = st.rows.filter(function (r) { return r.page === page; }).length;
    var go2 = function () {
      if (!signedIn()) return openAccount('Sign in to re-read a page.', function () { rereadPage(page); });
      sheet('<h2>Re-read page ' + page + '?</h2><p>A second, careful reading of just this page with AI - about a cent. Its ' + plural(count, 'row') + ' (and any changes you made to them) are replaced; every other page stays as it is.</p>' + PRIVACY + '<button class="btn block" type="button" id="rrGo">Re-read page ' + page + '</button>', function (root) {
        $('#rrGo', root).onclick = function () { closeSheet(); sendReread(page); };
      });
    };
    if (have) return go2();
    sheet('<h2>Choose the statement again</h2><p>Tieout doesn’t keep your file, so to read page ' + page + ' again, choose the same ' + (st.src === 'photo' ? 'photos' : 'PDF') + ' once more.</p><label class="btn block">Choose ' + (st.src === 'photo' ? 'the photos' : 'the PDF') + '<input type="file" class="vh" id="rrFile" ' + (st.src === 'photo' ? 'accept="image/*" multiple' : 'accept="application/pdf,.pdf"') + '></label><div id="rrErr"></div>', function (root) {
      $('#rrFile', root).onchange = function () {
        var files = Array.prototype.slice.call(this.files || []);
        if (!files.length) return;
        if (st.src === 'pdf' && !/pdf/i.test(files[0].type + files[0].name)) return showError(new Error('That isn’t a PDF.'), $('#rrErr', root));
        state.files[st.id] = { kind: st.src === 'photo' ? 'photo' : 'pdf', files: st.src === 'photo' ? files.slice(0, C.LIMITS.photos) : [files[0]] };
        closeSheet(); go2();
      };
    });
  }
  function sendReread(page) {
    var st = state.st, job = state.files[st.id];
    state.rereading = page; drawStatement();
    bodyFor(job, job.kind === 'photo' ? page : null).then(function (body) {
      body.page = page;
      body.type = st.type; body.currency = st.currency;
      var y = Number((st.end || st.start || '').slice(0, 4)); if (y) body.year = y;
      var before = balanceBefore(st, page); if (before !== null) body.before = before;
      return api('POST', 'api/reread', body);
    }).then(function (res) {
      if (state.st && state.st.id === st.id) finishReread(page, { rows: res.rows, pageTotals: res.pageTotals, notes: res.notes });
    }).catch(function (e) {
      state.rereading = null;
      if (state.st && state.st.id === st.id) drawStatement();
      if (e.data && e.data.code === 'verify-email') { sheet('<div id="vn"></div>', function (root) { verifyNote($('#vn', root), e); }); return; }
      showError(e);
    });
  }
  function finishReread(page, res) {
    state.rereading = null;
    var out = C.replacePage(state.st, page, (res.rows || []).map(function (r) { return { date: r.date, desc: r.desc, amount: r.amount, balance: r.balance }; }), res.pageTotals);
    state.hit = null;
    change(out.statement, 'Page ' + page + ' read again: ' + plural(out.now, 'row') + ', ' + (out.changed ? out.changed + ' different' : 'nothing different'));
  }

  /* ---------------- checking a CSV (free, nothing sent) ---------------- */

  function sampleCsv() {
    var st = S.statement('checking', true);
    var lines = ['Account Name,Business Checking ...4417', 'Statement Period,09/01/2026 - 09/30/2026', '', 'Posting Date,Description,Amount,Type,Balance'];
    var bal = st.opening, rows = [];
    st.rows.forEach(function (r) { bal += r.amount; rows.push([C.fmtDate(r.date, 'MM/DD/YYYY'), r.desc, C.plain(r.amount), r.amount < 0 ? 'DEBIT' : 'CREDIT', C.plain(bal)]); });
    rows.reverse().forEach(function (r) { lines.push(r.map(C.csvCell).join(',')); });
    return lines.join('\n') + '\n';
  }
  function openCsv() {
    state.csv = { text: '', an: null, name: '' };
    go('csv');
  }
  function drawCsv() {
    var cs = state.csv || (state.csv = { text: '', an: null, name: '' });
    var view = $('#view');
    if (!cs.an) {
      view.innerHTML = '<div class="st-head"><div><h1>Check a bank CSV</h1><p class="meta">Free · no account · nothing leaves this device</p></div><button class="btn small ghost" type="button" id="cBack">‹ Back</button></div>' +
        '<section class="card" style="max-width:760px"><p>Bank exports go wrong quietly: a missing row, a sign the wrong way round, a file that imports zero rows with no reason given. Tieout reads the CSV your bank gave you, runs the same checks as a converted statement, and says exactly what it could and couldn’t read.</p>' +
        '<div class="drop" id="cDrop"><p style="margin:0"><b>Drop a .csv here</b></p><label class="btn ghost">Choose a CSV<input type="file" accept=".csv,text/csv,text/plain,.txt" class="vh" id="cFile"></label></div>' +
        '<label class="field"><span>…or paste it</span><textarea class="input" id="cText" spellcheck="false" placeholder="Date,Description,Amount,Balance"></textarea></label>' +
        '<div id="cErr"></div><div class="row"><button class="btn" type="button" id="cRead">Read it</button><button class="btn ghost" type="button" id="cSample">Try a sample CSV</button></div></section>';
      $('#cText').value = cs.text;
      $('#cBack').onclick = function () { history.length > 1 ? history.back() : go('home'); };
      $('#cSample').onclick = function () { $('#cText').value = sampleCsv(); cs.name = 'sample-checking.csv'; readCsv(); };
      $('#cRead').onclick = function () { readCsv(); };
      var f = $('#cFile');
      f.onchange = function () { if (f.files && f.files[0]) loadCsvFile(f.files[0]); f.value = ''; };
      var drop = $('#cDrop');
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) loadCsvFile(e.dataTransfer.files[0]); });
      return;
    }
    var an = cs.an, m = cs.map;
    var opts = function (key) {
      return '<option value="-1">' + (key === 'desc' || key === 'balance' || key === 'debit' || key === 'credit' || key === 'amount' ? '(none)' : '(pick one)') + '</option>' + an.header.map(function (h, i) { return '<option value="' + i + '"' + (m[key] === i ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join('');
    };
    var eg = function (key) { var b = an.body[0]; return Number.isInteger(m[key]) && m[key] >= 0 && b ? 'e.g. ' + C.clean(b[m[key]], 40) : ''; };
    var sel = function (key, label) { return '<label class="field"><span>' + label + '</span><select class="input" data-map="' + key + '">' + opts(key) + '</select><span class="eg">' + esc(eg(key)) + '</span></label>'; };
    var res = cs.result;
    view.innerHTML = '<div class="st-head"><div><h1>Check a bank CSV</h1><p class="meta">' + esc((cs.name ? cs.name + ' · ' : '') + plural(an.body.length, 'line') + (an.headerRow >= 0 ? ' under the header on line ' + (an.headerRow + 1) : ' · no header found - columns guessed by shape')) + '</p></div><button class="btn small ghost" type="button" id="cRestart">‹ Another file</button></div>' +
      '<section class="card" style="max-width:860px"><h2>1. Which column is which?</h2><p class="small muted">Worked out from the header - change anything that’s wrong. Use either one amount column, or debit and credit columns.</p>' +
      '<div class="mapgrid">' + sel('date', 'Date') + sel('desc', 'Description') + sel('amount', 'Amount') + sel('balance', 'Balance (if the file has one)') + sel('debit', 'Debit / money out') + sel('credit', 'Credit / money in') + '</div>' +
      '<label class="field"><span>Amount signs</span><select class="input" id="cSign"><option value="auto">Work it out' + (res && res.sign ? ' (' + (res.sign === 'in-positive' ? 'money in is positive' : 'money out is positive') + ')' : '') + '</option><option value="in-positive"' + (cs.sign === 'in-positive' ? ' selected' : '') + '>Money in is positive (most bank accounts)</option><option value="out-positive"' + (cs.sign === 'out-positive' ? ' selected' : '') + '>Money out is positive (many card exports)</option></select></label>' +
      '<h2 style="margin-top:6px">2. The account</h2><div class="grid2"><label class="field"><span>Account type</span><select class="input" id="cType">' + C.TYPES.map(function (t) { return '<option value="' + t + '"' + (cs.type === t ? ' selected' : '') + '>' + esc(C.TYPE_LABEL[t]) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Currency</span><select class="input" id="cCur">' + C.CURRENCIES.map(function (c) { return '<option' + ((cs.currency || 'USD') === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Bank (optional)</span><input class="input" id="cBank" maxlength="' + C.LIMITS.bank + '"></label><label class="field"><span>Last four (optional)</span><input class="input" id="cLast4" inputmode="numeric" maxlength="4"></label>' +
      '<label class="field"><span>Opening balance</span><input class="input" id="cOpen" inputmode="decimal" placeholder="' + (Number.isInteger(m.balance) && m.balance >= 0 ? 'From the balance column' : 'From the statement') + '"><small>The balance before the first row.</small></label>' +
      '<label class="field"><span>Closing balance</span><input class="input" id="cClose" inputmode="decimal" placeholder="' + (Number.isInteger(m.balance) && m.balance >= 0 ? 'From the balance column' : 'From the statement') + '"><small>Without both, the rows can be cleaned but not proven.</small></label></div>' +
      '<div id="cErr"></div>' +
      (res && res.statement ? '<h2>3. What was read</h2><p class="small">' + esc(plural(res.statement.rows.length, 'row') + ' read' + (res.skipped ? ', ' + res.skipped + ' skipped' : '') + ' · ' + C.fmtPeriod(res.statement.start, res.statement.end)) + '</p>' + (res.problems.length ? '<div class="note look small">' + res.problems.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div>' : '') + previewHtml(res.statement) : '') +
      '<button class="btn big block" type="button" id="cCheck" style="margin-top:8px">Check it</button></section>';
    $('#cBank').value = cs.bank || ''; $('#cLast4').value = cs.last4 || ''; $('#cOpen').value = cs.opening || ''; $('#cClose').value = cs.closing || '';
    $('#cRestart').onclick = function () { state.csv = { text: '', an: null, name: '' }; drawCsv(); };
    var collect = function () {
      $$('[data-map]', view).forEach(function (s) { m[s.getAttribute('data-map')] = Number(s.value); });
      cs.sign = $('#cSign').value; cs.type = $('#cType').value; cs.currency = $('#cCur').value;
      cs.bank = $('#cBank').value; cs.last4 = $('#cLast4').value; cs.opening = $('#cOpen').value; cs.closing = $('#cClose').value;
    };
    var attempt = function () {
      collect();
      var r = C.fromCsv(an, m, { sign: cs.sign, type: cs.type, currency: cs.currency, bank: cs.bank, last4: cs.last4, opening: cs.opening, closing: cs.closing, name: cs.name, at: new Date().toISOString() });
      if (r.error) { cs.result = null; return { error: r.error }; }
      cs.result = r;
      return r;
    };
    $$('[data-map], #cSign, #cType', view).forEach(function (s) { s.onchange = function () { var r = attempt(); drawCsv(); if (r.error) showError(new Error(r.error), $('#cErr')); }; });
    $('#cCheck').onclick = function () {
      var r = attempt();
      if (r.error) return showError(new Error(r.error), $('#cErr'));
      var st = r.statement;
      st.notes = r.problems.concat(['Amount signs: ' + (r.sign === 'in-positive' ? 'money in is positive' : 'money out is positive') + (cs.sign === 'auto' ? ' (worked out from the file)' : '') + '.']).slice(0, C.LIMITS.notes);
      st = C.cleanStatement(st);
      addToDevice(st);
      state.csv = null;
      state.st = st; state.where = 'device'; state.filter = 'all'; state.hit = null;
      state.view = 'stmt';
      try { history.replaceState({ v: 'stmt' }, ''); } catch (e) { /* ignore */ }
      render(); window.scrollTo(0, 0);
      var chk = C.check(st);
      say(chk.headline + '. ' + chk.sub);
    };
  }
  function previewHtml(st) {
    var rows = st.rows.slice(0, 5);
    return '<table class="preview"><thead><tr><th style="width:92px">Date</th><th>Description</th><th class="r" style="width:110px">Amount</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + esc(C.fmtDay(r.date, (st.end || '').slice(0, 4))) + '</td><td>' + esc(r.desc) + '</td><td class="r">' + esc(C.signed(r.amount)) + '</td></tr>'; }).join('') + '</tbody></table>' +
      (st.rows.length > 5 ? '<p class="small muted">…and ' + (st.rows.length - 5) + ' more.</p>' : '');
  }
  function loadCsvFile(file) {
    if (file.size > C.LIMITS.csvBytes) return showError(new Error('That file is over 5 MB - export one statement period at a time.'), $('#cErr'));
    if (/\.pdf$/i.test(file.name) || /pdf/.test(file.type)) return showError(new Error('That’s a PDF - use “Convert your statement” for a PDF.'), $('#cErr'));
    var r = new FileReader();
    r.onload = function () { $('#cText').value = String(r.result || ''); state.csv.name = C.clean(file.name, 80); readCsv(); };
    r.onerror = function () { showError(new Error('That file could not be opened.'), $('#cErr')); };
    r.readAsText(file);
  }
  function readCsv() {
    var cs = state.csv;
    var t = $('#cText').value;
    cs.text = t;
    var an = C.analyzeCsv(t);
    if (an.error) return showError(new Error(an.error), $('#cErr'));
    cs.an = an;
    cs.map = { date: -1, desc: -1, amount: -1, debit: -1, credit: -1, balance: -1 };
    Object.keys(an.mapping).forEach(function (k) { cs.map[k] = an.mapping[k]; });
    // The account type from the lines above the header only - a "CARD
    // PAYMENT" row in the data says nothing about what the account is.
    var above = an.preamble || '';
    cs.sign = 'auto'; cs.currency = 'USD';
    cs.type = /credit ?card|visa|mastercard|amex|card ?member/i.test(above) ? 'credit-card' : /savings/i.test(above) ? 'savings' : 'checking';
    var r = C.fromCsv(an, cs.map, { sign: 'auto', type: cs.type });
    cs.result = r.error ? null : r;
    drawCsv();
    if (r.error) showError(new Error(r.error), $('#cErr'));
    window.scrollTo(0, 0);
  }

  /* ---------------- export ---------------- */

  function allKnown() {
    var out = state.list.slice();
    if (state.where === 'example' && state.st) out.unshift(state.st);
    return out;
  }
  function openExport(ids) {
    var known = allKnown();
    var sel = {};
    (ids || []).forEach(function (id) { sel[id] = true; });
    var fmt = recall('tieout-format') || 'csv';
    if (!C.FORMATS[fmt]) fmt = 'csv';
    var cols = 'signed', dateFmt = null, anyway = false;
    function draw(root) {
      var body = $('.body', root);
      var chosen = known.filter(function (s) { return sel[s.id]; });
      var ch = C.chain(chosen);
      var unproven = chosen.filter(function (s) { var r = C.check(s); return r.status !== 'ties' || r.fails; });
      var df = dateFmt || (fmt === 'csv' ? 'YYYY-MM-DD' : (chosen[0] && /GBP|EUR|AUD|NZD|ZAR|INR/.test(chosen[0].currency)) ? 'DD/MM/YYYY' : 'MM/DD/YYYY');
      var opt = function (k, label, hint) { return '<label class="opt' + (fmt === k ? ' on' : '') + '"><input type="radio" name="fmt" value="' + k + '"' + (fmt === k ? ' checked' : '') + '><b>' + esc(label) + '</b><small>' + esc(hint) + '</small></label>'; };
      body.innerHTML = '<h2>Export</h2>' +
        '<fieldset class="opts"><legend>Statements</legend>' + known.map(function (s) {
          return '<label class="cb"><input type="checkbox" data-pick="' + esc(s.id) + '"' + (sel[s.id] ? ' checked' : '') + '><span>' + esc(C.label(s)) + ' ' + verdictChip(s) + '</span></label>';
        }).join('') + '</fieldset>' +
        (unproven.length ? '<div class="note fail"><p><b>' + esc(unproven.map(function (s) { var r = C.check(s); return C.label(s) + (r.status === 'off' ? ' is ' + r.headline.toLowerCase() : r.fails ? ' has ' + plural(r.fails, 'thing') + ' to fix' : ' can’t be proven yet'); }).join('; ')) + '.</b> Tieout doesn’t hand over numbers it can’t prove - fix ' + (unproven.length === 1 ? 'it' : 'them') + ' first, or say you know.</p><label class="cb"><input type="checkbox" id="xAnyway"' + (anyway ? ' checked' : '') + '><span>Export anyway - I’ll reconcile it myself</span></label></div>' : '') +
                (ch.warnings.length ? ch.warnings.map(function (w) { return '<div class="note ' + w.status + ' small" role="note"><p>' + (w.status === 'fail' ? '<b>Doesn’t follow:</b> ' : '') + esc(w.text) + '</p></div>'; }).join('') : chosen.length > 1 ? '<div class="note pass small"><p>✓ Each month’s closing balance is the next month’s opening, with no gap in the dates.</p></div>' : '') +
        '<fieldset class="opts"><legend>Format</legend>' + opt('csv', 'CSV', 'Any spreadsheet. Date, description, amount, balance, account, page.') + opt('qbo', 'QuickBooks Online', 'Bank upload format: Date, Description, Amount - or Credit and Debit.') + opt('xero', 'Xero', 'Statement import: *Date, *Amount, Payee, Description, Reference, Check Number.') + opt('ofx', 'OFX', 'Direct import into QuickBooks, Xero, Wave and most accounting software.') + '</fieldset>' +
        (C.FORMATS[fmt].split ? '<fieldset class="opts"><legend>Amounts</legend><label class="opt' + (cols === 'signed' ? ' on' : '') + '"><input type="radio" name="cols" value="signed"' + (cols === 'signed' ? ' checked' : '') + '><b>One signed column</b><small>Money out negative, money in positive.</small></label><label class="opt' + (cols === 'split' ? ' on' : '') + '"><input type="radio" name="cols" value="split"' + (cols === 'split' ? ' checked' : '') + '><b>' + (fmt === 'qbo' ? 'Credit and debit columns' : 'Debit and credit columns') + '</b><small>Both positive, as many ledgers want them.</small></label></fieldset>' : '') +
        (fmt !== 'ofx' ? '<label class="field"><span>Dates</span><select class="input" id="xDate">' + C.DATE_FORMATS.map(function (d) { return '<option' + (d === df ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></label>' : '') +
'<div id="xErr"></div><button class="btn big block" type="button" id="xGo"' + (!chosen.length || (unproven.length && !anyway) ? ' disabled' : '') + '>' + (chosen.length ? 'Download ' + esc(C.FORMATS[fmt].label) + (chosen.length > 1 ? ' (' + chosen.length + ' statements)' : '') : 'Pick a statement') + '</button>' +
        '<p class="small muted center" style="margin-top:8px">Made on this device - nothing is sent.</p>';
      $$('[data-pick]', body).forEach(function (c) { c.onchange = function () { sel[c.getAttribute('data-pick')] = c.checked; draw(root); }; });
      $$('input[name=fmt]', body).forEach(function (c) { c.onchange = function () { fmt = c.value; keep('tieout-format', fmt); dateFmt = null; draw(root); }; });
      $$('input[name=cols]', body).forEach(function (c) { c.onchange = function () { cols = c.value; draw(root); }; });
      var xd = $('#xDate', body); if (xd) xd.onchange = function () { dateFmt = xd.value; };
      var xa = $('#xAnyway', body); if (xa) xa.onchange = function () { anyway = xa.checked; draw(root); };
      $('#xGo', body).onclick = function () {
        var list = known.filter(function (s) { return sel[s.id]; });
        if (!list.length) return;
        var text = C.exportAs(fmt, list, { columns: cols, dateFormat: xd ? xd.value : df, now: new Date().toISOString() });
        download(C.fileName(fmt, list), text, C.FORMATS[fmt].type);
        closeSheet();
        toast('Downloaded ' + C.FORMATS[fmt].label + ' - ' + plural(list.reduce(function (n, s) { return n + s.rows.length; }, 0), 'row') + '.');
      };
    }
    sheet('<div class="body"></div>', draw);
  }

  /* ---------------- statements list ---------------- */

  function openStatements() {
    function draw(root) {
      var body = $('.body', root);
      body.innerHTML = '<h2>Statements</h2><div class="row" style="margin-bottom:12px"><button class="btn" type="button" id="lConv">Convert a statement</button><button class="btn ghost" type="button" id="lCsv">Check a CSV</button></div>' +
        '<h3>In this browser</h3>' + (state.list.length ? '<ul class="slist">' + state.list.map(function (s) {
          return '<li><button class="open" type="button" data-lopen="' + esc(s.id) + '"><b>' + esc(C.label(s)) + '</b><span>' + esc(C.fmtPeriod(s.start, s.end) + ' · ' + plural(s.rows.length, 'row')) + '</span>' + verdictChip(s) + '</button><div class="row"><button class="btn small ghost" type="button" data-ldel="' + esc(s.id) + '">Remove</button></div></li>';
        }).join('') + '</ul>' + (state.list.length > 1 ? '<button class="btn ghost block" type="button" id="lExport">Export several together</button><button class="link-btn" type="button" id="lClear">Remove them all from this browser</button>' : '') : '<p class="muted">None yet. Statements you convert or check stay here, in this browser only.</p>') +
        '<h3 style="margin-top:14px">Examples</h3><ul class="slist">' + ['checking', 'card'].map(function (k) { var s = exampleOf(k); return '<li><button class="open" type="button" data-lex="' + k + '"><b>' + esc(C.label(s)) + '</b><span>Made up</span>' + verdictChip(s) + '</button></li>'; }).join('') + '</ul>';
      $('#lConv', body).onclick = function () { closeSheet(); openUpload(); };
      $('#lCsv', body).onclick = function () { closeSheet(); openCsv(); };
      $$('[data-lopen]', body).forEach(function (b) { b.onclick = function () { var s = byId(b.getAttribute('data-lopen')); closeSheet(); if (s) openStatement(s, 'device'); }; });
      $$('[data-lex]', body).forEach(function (b) { b.onclick = function () { closeSheet(); openStatement(exampleOf(b.getAttribute('data-lex')), 'example'); }; });
      $$('[data-ldel]', body).forEach(function (b) {
        b.onclick = function () {
          if (b.getAttribute('data-sure') !== '1') { b.setAttribute('data-sure', '1'); b.textContent = 'Tap again to remove'; b.classList.add('danger'); return; }
          var id = b.getAttribute('data-ldel');
          removeFromDevice(id);
          if (state.st && state.st.id === id) { state.st = null; state.view = 'home'; render(); }
          draw(root); toast('Removed from this browser.');
        };
      });
      var le = $('#lExport', body); if (le) le.onclick = function () { closeSheet(); openExport(state.list.map(function (s) { return s.id; })); };
      var lc = $('#lClear', body); if (lc) lc.onclick = function () {
        if (lc.getAttribute('data-sure') !== '1') { lc.setAttribute('data-sure', '1'); lc.textContent = 'Tap again to remove all ' + state.list.length; return; }
        state.list = []; state.files = {}; saveDevice();
        if (state.where === 'device') { state.st = null; state.view = 'home'; }
        render(); draw(root); toast('Removed from this browser.');
      };
    }
    sheet('<div class="body"></div>', draw);
  }

  /* ---------------- sheets and the account ---------------- */

  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Account' : 'Sign in';
    b.onclick = function () { if (signedIn()) openSettings(); else openAccount(); };
    $('#stmtsBtn').onclick = openStatements;
  }

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    $$('.toast').forEach(function (x) { x.remove(); });
    lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" id="sheetClose" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    $('#sheetClose').onclick = closeSheet;
    back.onclick = closeSheet;
    if (onOpen) onOpen(s);
    var f = s.querySelector('input:not(.vh):not([type=checkbox]):not([type=radio]), textarea') || s.querySelector('button:not(.close)') || $('#sheetClose');
    setTimeout(function () { try { if (f) f.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  var FREE_LINE = 'The examples, checking a CSV, the review and every export are free with no account. A free account converts statement PDFs and photos with AI - it comes with $2 of credit. One account works across every app on this site.';

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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); drawTop(); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { drawTop(); if (then) then(); })
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
      '<p class="small muted" style="margin:6px 0 0">Converting a statement costs a few cents; re-reading a page about a cent. Checking, editing and exporting are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The examples, checking a CSV, the review and every export keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }

  /* ---------------- start ---------------- */

  loadDevice();
  try { history.replaceState({ v: 'home' }, ''); } catch (e) { /* ignore */ }
  render();
  loadMe().then(function () {
    if (signedIn() && /[?&](topup|member|credited)=1\b/.test(location.search)) openSettings();
  });
  // Tests and screenshots drive the page by hash: #example-checking, #csv.
  var h = location.hash.replace('#', '');
  if (h === 'example-checking' || h === 'example-card') openStatement(exampleOf(h === 'example-card' ? 'card' : 'checking'), 'example');
  else if (h === 'csv') openCsv();
})();
