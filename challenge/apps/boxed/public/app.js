/* Boxed - the page. One file, no build step. Every string that came from
 * outside this file (a model's reading, a typed name, a saved file) is
 * escaped before it is drawn, and no handler is written into markup (the
 * lab's CSP allows script from this origin only). The checks, sums, roll-up,
 * calendar and CSVs are boxed-core.js - the same file the server and the
 * tests run.
 *
 * Three kinds of client file:
 *   sample  - the made-up example, the first thing a visitor sees. Edits
 *             work and are never kept.
 *   local   - signed out: kept in this browser's localStorage (every access
 *             in try/catch), the same fields a saved file holds.
 *   account - signed in: saved to the account, changes save themselves.
 *
 * What is never kept anywhere, here included: the PDFs and photos (sent once
 * to be read), and the partner's name and TIN (shown beside a reading while
 * this page is open, then gone - C.toSaved does not copy them).
 */
(function () {
  'use strict';

  var C = window.BoxedCore;
  var S = window.BoxedSample;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LOCAL = 'boxed-v1';
  var PHOTO_PX = 2000;
  var TODAY = (function () { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }());
  var DEFAULT_YEAR = Number(TODAY.slice(0, 4)) - 1;
  var MARK = { fail: '✕', look: '!', pass: '✓' };
  var WORD = { fail: 'to fix', look: 'to look at', pass: 'pass' };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function m$(c) { return C.money(c); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  var state = {
    me: null,
    file: null,          // the client file on screen
    view: 'client',      // 'client' | 'k1'
    tab: 'k1s',          // 'k1s' | 'rollup' | 'missing'
    k1Id: null,
    openRoll: null,
    queue: [],           // reading progress: [{name, status, msg, k1Id}]
    queueBusy: false,
    partners: {},        // k1Id -> the partner as read (this page only)
    notes: {},           // k1Id -> what the reading left out
    saving: null,        // 'saving' | 'saved' | 'error'
    saveTimer: null,
    timer: null,         // {id, since} - time spent reviewing a K-1
    editedToast: {},
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // The read streams whitespace and so answers 200 even on failure;
        // an {error} body is a failure however it arrived.
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
    setTimeout(function () { t.remove(); }, ms || 2800);
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
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
    else toast(msg, 4200);
  }
  /** The 403 an unconfirmed free account gets, with its resend button. */
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then come back and read them. Typing a K-1 in is free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).onclick = function () {
      var b = this; b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    };
  }

  /* ---------------- client files ---------------- */

  function fileFrom(where, raw, id) {
    var f = C.cleanFile(raw);
    return { id: id || raw.id || null, where: where, label: f.label, taxYear: f.taxYear, k1s: f.k1s, expected: f.expected, updatedAt: raw.updatedAt || null };
  }
  function sampleFile() {
    var f = fileFrom('sample', S.client(), 'sample');
    f.k1s.forEach(function (k) { state.partners[k.id] = S.PARTNER; });
    return f;
  }
  function savedShape(f) {
    return { label: f.label, taxYear: f.taxYear, k1s: f.k1s.map(C.toSaved).filter(Boolean), expected: f.expected };
  }
  function localFiles() {
    var l = recall(K_LOCAL);
    return l && Array.isArray(l.files) ? l.files.filter(function (x) { return x && typeof x.id === 'string'; }) : [];
  }
  function writeLocal(files, current) {
    keep(K_LOCAL, { v: 1, files: files, current: current === undefined ? (state.file ? state.file.id : null) : current });
  }
  function k1ById(id) { var f = state.file; for (var i = 0; i < f.k1s.length; i++) if (f.k1s[i].id === id) return f.k1s[i]; return null; }
  function yearK1s() { return C.yearK1s(state.file); }

  /** Something in the file changed: keep it where it lives. */
  function touch() {
    var f = state.file;
    if (!f || f.where === 'sample') return;
    if (f.where === 'local') {
      var files = localFiles().filter(function (x) { return x.id !== f.id; });
      files.unshift(Object.assign({ id: f.id }, savedShape(f), { updatedAt: new Date().toISOString() }));
      writeLocal(files.slice(0, C.LIMITS.clients), f.id);
      return;
    }
    clearTimeout(state.saveTimer);
    setSaving('saving');
    state.saveTimer = setTimeout(function () {
      var id = f.id;
      api('PUT', 'api/clients/' + encodeURIComponent(id), savedShape(f)).then(function () {
        if (state.file && state.file.id === id) setSaving('saved');
      }).catch(function (e) {
        setSaving('error');
        if (e.status === 401) openAccount('Your session ended - sign in to keep saving this client file.');
        else toast(e.message, 4200);
      });
    }, 900);
  }
  function setSaving(s) {
    state.saving = s;
    var el = $('#saveState');
    if (el && state.file) el.textContent = 'Tax year ' + state.file.taxYear + ' · ' + savingText();
  }
  function savingText() {
    var f = state.file;
    if (!f) return '';
    if (f.where === 'sample') return 'Example - your changes here are not kept';
    if (f.where === 'local') return signedIn() ? 'On this device only' : 'On this device - sign in to keep it in your account';
    return state.saving === 'saving' ? 'Saving…' : state.saving === 'error' ? 'Not saved - check your connection' : 'Saved to your account';
  }

  function openFile(f) {
    stopTimer();
    state.file = f;
    state.view = 'client';
    state.k1Id = null;
    state.openRoll = null;
    state.saving = null;
    // Only the pointer to the open file; an account file's contents stay
    // in the account.
    writeLocal(localFiles(), f.where === 'sample' ? 'sample' : f.id);
    render();
  }

  /* ---------------- drawing ---------------- */

  function render() {
    drawTop();
    drawStrip();
    if (state.view === 'k1' && k1ById(state.k1Id)) drawReview();
    else { state.view = 'client'; drawClient(); }
  }

  function drawStrip() {
    var el = $('#strip');
    var f = state.file;
    if (f.where === 'sample') {
      el.className = 'strip ex-strip';
      el.innerHTML = '<p class="ex"><span aria-hidden="true">🗂️ </span><b>This is an example client</b> - tap a K-1 to see how it was read and checked.</p>' +
        '<div><button class="btn big start" type="button" id="startBtn">Start a client</button>' +
        '<div class="alt"><span>then read K-1 PDFs with AI, or</span><button class="link-btn" type="button" id="typeBtn">type one in - free</button></div></div>';
      $('#startBtn').onclick = function () { startClient(); };
      $('#typeBtn').onclick = function () { startClient('type'); };
      return;
    }
    el.className = 'strip own';
    el.innerHTML = '<div><h1>' + esc(f.label) + '</h1><p class="where" id="saveState"></p></div>' +
      '<div class="acts"><button class="btn small ghost" type="button" id="renameBtn">Rename</button><button class="btn small ghost" type="button" id="nextYearBtn">Next year</button></div>';
    $('#saveState').textContent = 'Tax year ' + f.taxYear + ' · ' + savingText();
    $('#renameBtn').onclick = function () { renameSheet(f); };
    $('#nextYearBtn').onclick = function () { duplicateFile(f); };
  }

  function drawClient() {
    var f = state.file;
    var b = C.board(f, TODAY);
    var ks = yearK1s();
    var miss = C.missing(f, TODAY);
    var stillMissing = miss.filter(function (x) { return !x.received; });
    var view = $('#view');
    var pct = function (n) { return b.received ? Math.round(100 * n / b.received) : 0; };
    var step = function (n, w) { return '<li><span class="n">' + n + '</span><span class="w">' + w + '</span><span class="bar" aria-hidden="true"><i style="width:' + pct(n) + '%"></i></span></li>'; };
    var savedLine = b.counted
      ? 'Time saved assumes about ' + C.MINUTES_BY_HAND + ' minutes to key a K-1 by hand. Here ' + plural(b.counted, 'K-1 was', 'K-1s were') + ' read for you and checked in ' + C.minutesText(b.spentSecs) + ' - ' + C.duration(b.savedSecs) + ' saved.'
      : 'Time saved assumes about ' + C.MINUTES_BY_HAND + ' minutes to key a K-1 by hand, less the time you spend checking each one here.';
    var headline = '<b>' + b.received + '</b> received · <b>' + b.checked + '</b> checked' + (b.missing ? ' · <b>' + b.missing + '</b> still missing' : '') + (b.savedSecs >= 60 ? ' · ' + esc(C.duration(b.savedSecs)) + ' saved' : '');

    view.innerHTML =
      '<div class="topgrid">' +
        '<section class="card board" aria-label="Status board"><p class="kicker">Tax year ' + esc(f.taxYear) + ' · status</p>' +
        '<p class="headline">' + headline + '</p>' +
        '<ol class="pipe" aria-label="Where each K-1 is">' + step(b.received, 'Received') + step(b.read, 'Read') + step(b.checked, 'Checked') + step(b.exported, 'Exported') + '</ol>' +
        '<p class="saved">' + esc(savedLine) + '</p></section>' +
        '<section class="card attn" aria-labelledby="attnH">' + attentionHtml(ks, stillMissing) + '</section>' +
      '</div>' +
      '<section class="card queue" id="queueCard" aria-label="Reading" hidden></section>' +
      '<div class="tabs" role="tablist" aria-label="Client file">' +
        tabBtn('k1s', 'K-1s <span class="cnt">' + ks.length + '</span>') + tabBtn('rollup', 'Roll-up') + tabBtn('missing', 'Missing <span class="cnt">' + stillMissing.length + '</span>') +
      '</div>' +
      '<section class="card" id="tabPanel" role="tabpanel" aria-labelledby="tab-' + state.tab + '"></section>';

    $$('[data-open]', view).forEach(function (x) { x.onclick = function () { openReview(x.getAttribute('data-open')); }; });
    $$('[data-gotab]', view).forEach(function (x) { x.onclick = function () { setTab(x.getAttribute('data-gotab')); var t = $('#tabPanel'); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'start' }); }; });
    $$('.tabs [role=tab]', view).forEach(function (x) {
      x.onclick = function () { setTab(x.getAttribute('data-tab')); };
      x.onkeydown = function (e) {
        var order = ['k1s', 'rollup', 'missing'];
        var i = order.indexOf(state.tab);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setTab(order[(i + (e.key === 'ArrowRight' ? 1 : 2)) % 3]); var t = $('#tab-' + state.tab); if (t) t.focus(); }
      };
    });
    drawQueue();
    drawTab();
  }
  function tabBtn(id, html) {
    var on = state.tab === id;
    return '<button type="button" role="tab" id="tab-' + id + '" data-tab="' + id + '" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '">' + html + '</button>';
  }
  function setTab(t) {
    state.tab = t;
    $$('.tabs [role=tab]').forEach(function (x) { var on = x.getAttribute('data-tab') === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; });
    var p = $('#tabPanel'); if (p) p.setAttribute('aria-labelledby', 'tab-' + t);
    drawTab();
  }
  function drawTab() {
    if (state.tab === 'rollup') drawRollup();
    else if (state.tab === 'missing') drawMissing();
    else drawK1s();
  }

  var LOOK_PHRASE = { final: 'a final K-1', amended: 'an amended K-1', ptp: 'a PTP', k3: 'a K-3 to expect', yoy: 'big swings from last year', stmt: '“see statement” lines', conf: 'values read with low confidence', lVsBoxes: 'Item L vs the boxes', box19: 'distributions vs withdrawals', itemJ: 'share changes', code: 'a missing code', itemL: 'an incomplete Item L', empty: 'K-1s not read yet' };
  function attentionHtml(ks, stillMissing) {
    var items = [];
    var lookers = 0, phrases = [];
    var firstLook = null;
    ks.forEach(function (k) {
      var ch = C.checksFor(k, state.file);
      ch.forEach(function (c) {
        if (c.status === 'fail') {
          var what = c.short ? c.title + ' on ' + (k.p.name || 'an unnamed K-1') + ': ' + c.short : c.title + ' on ' + (k.p.name || 'an unnamed K-1');
          items.push('<li class="fail"><button type="button" data-open="' + esc(k.id) + '"><span class="mk fail" aria-hidden="true">✕</span><span><b>' + esc(what) + '</b><br><span class="small">Fix it before you key it - tap to see the figures.</span></span><span class="go" aria-hidden="true">›</span></button></li>');
        }
      });
      var looks = ch.filter(function (c) { return c.status === 'look'; });
      if (looks.length && !ch.some(function (c) { return c.status === 'fail'; })) {
        lookers++;
        if (!firstLook) firstLook = k.id;
        looks.forEach(function (c) { var p = LOOK_PHRASE[c.id.split(':')[0]]; if (p && phrases.indexOf(p) < 0) phrases.push(p); });
      }
    });
    if (stillMissing.length) {
      var od = stillMissing.filter(function (x) { return x.overdue; }).length;
      items.push('<li><button type="button" data-gotab="missing"><span class="mk look" aria-hidden="true">!</span><span><b>' + esc(plural(stillMissing.length, 'K-1') + ' still missing') + '</b>' + (od ? ' <span class="overdue">(' + od + ' overdue)</span>' : '') + '<br><span class="small">' + esc(stillMissing.slice(0, 2).map(function (x) { return x.name; }).join(', ') + (stillMissing.length > 2 ? ' and ' + (stillMissing.length - 2) + ' more' : '')) + '</span></span><span class="go" aria-hidden="true">›</span></button></li>');
    }
    if (lookers) {
      items.push('<li><button type="button" data-open="' + esc(firstLook) + '"><span class="mk look" aria-hidden="true">!</span><span><b>' + esc(plural(lookers, 'K-1 has', 'K-1s have') + ' something to look at') + '</b><br><span class="small">' + esc(phrases.slice(0, 4).join(', ')) + '</span></span><span class="go" aria-hidden="true">›</span></button></li>');
    }
    if (!items.length) {
      return '<h2 id="attnH">Needs you</h2><p class="ok">' + (ks.length ? 'Nothing failing and nothing missing.' : 'Nothing yet - add this client’s K-1s below.') + '</p>';
    }
    return '<h2 id="attnH">Needs you</h2><ul>' + items.join('') + '</ul>';
  }

  /* ---------------- the K-1 list ---------------- */

  function rank(r) { return { fail: 0, look: 1, pass: 2 }[r]; }
  function k1Summary(k) {
    var ch = C.checksFor(k, state.file);
    return C.summarize(ch);
  }
  function rowHtml(k, prior) {
    var s = k1Summary(k);
    var srcWord = { pdf: 'PDF', photo: 'Photos', manual: 'Typed in' }[k.src] || '';
    var chips = (k.final ? '<span class="chip final">Final</span>' : '') + (k.amended ? '<span class="chip amended">Amended</span>' : '') + (k.p.ptp ? '<span class="chip ptp">PTP</span>' : '') + (k.k3 ? '<span class="chip k3">K-3</span>' : '');
    var b1 = C.sumBox(k, '1');
    var sumWord = k.stage === 'received' ? 'not read yet' : s.fail ? s.fail + ' to fix' : s.look ? s.look + ' to look at' : 'all pass';
    var res = k.stage === 'received' ? 'look' : s.result;
    return '<li><button type="button" class="k1row' + (prior ? ' prior' : '') + '" data-open="' + esc(k.id) + '">' +
      '<span class="mk ' + res + '" aria-hidden="true">' + MARK[res] + '</span>' +
      '<span class="nm">' + esc(k.p.name || 'Unnamed partnership') + '</span>' +
      '<span class="stage">' + esc(prior ? 'Tax year ' + k.taxYear : C.STAGE_LABEL[k.stage]) + '</span>' +
      '<span class="sub"><span class="word ' + res + '"><b>' + esc(sumWord) + '</b></span>' +
      (k.p.ein4 ? '<span>EIN ' + esc(C.maskEin(k.p.ein4)) + '</span>' : '') + (srcWord ? '<span>' + srcWord + '</span>' : '') +
      (b1 !== null ? '<span>Box 1 ' + esc(m$(b1)) + '</span>' : '') + chips + '</span></button></li>';
  }
  function drawK1s() {
    var el = $('#tabPanel');
    var ks = yearK1s().slice().sort(function (a, b) {
      // Work still to do first: received, failing, read but not checked;
      // then the checked ones - each worst first.
      var w = function (k) { var r = rank(k1Summary(k).result); return k.stage === 'received' ? -1 : r === 0 ? 0 : k.stage === 'read' ? 1 + r : 4 + r; };
      return (w(a) - w(b)) || (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0);
    });
    var prior = C.priorK1s(state.file);
    el.innerHTML = '<div class="sec-head"><h2>K-1s for ' + esc(state.file.taxYear) + '</h2><span class="small muted">To do first · tap one to review it</span></div>' +
      (ks.length ? '<ul class="k1list">' + ks.map(function (k) { return rowHtml(k); }).join('') + '</ul>' : '<p class="muted">No K-1s in this file yet. Read them from PDFs or photos, or type one in.</p>') +
      '<div class="adds"><button class="btn" type="button" id="readBtn">Read K-1s with AI</button><button class="btn ghost" type="button" id="typeBtn2">Type one in</button></div>' +
      '<p class="small muted" style="margin-top:8px">Reading uses AI credit (a few cents a K-1) and a free account. Typing one in is free, with or without an account.</p>' +
      (prior.length ? '<details><summary class="prior-h"><b>Last year’s K-1s</b> (' + prior.length + ') - for year-over-year checks</summary><ul class="k1list">' + prior.map(function (k) { return rowHtml(k, true); }).join('') + '</ul></details>' : '');
    $$('[data-open]', el).forEach(function (x) { x.onclick = function () { openReview(x.getAttribute('data-open')); }; });
    $('#readBtn', el).onclick = function () { openUpload(); };
    $('#typeBtn2', el).onclick = function () { typeOne(); };
  }

  /* ---------------- the roll-up ---------------- */

  function drawRollup() {
    var el = $('#tabPanel');
    var f = state.file;
    var rows = C.rollup(f);
    var n = yearK1s().length;
    if (!rows.length) {
      el.innerHTML = '<h2>Roll-up</h2><p class="muted">Every box and code summed across this client’s K-1s appears here once there are some.</p>';
      return;
    }
    var key = function (r) { return r.box + '|' + (r.code || ''); };
    var WANT = ['1|', '2|', '20|Z', '13|H', '16|', '9a|', '5|'];
    var headline = WANT.map(function (w) { return rows.filter(function (r) { return key(r) === w; })[0]; }).filter(Boolean).slice(0, 4);
    el.innerHTML = '<div class="sec-head"><h2>Roll-up · ' + esc(plural(n, 'K-1')) + '</h2><span class="small muted">Every box and code, summed in cents</span></div>' +
      (headline.length ? '<ul class="sentences">' + headline.map(function (r) { return '<li>' + esc(C.rollupSentence(r)) + '</li>'; }).join('') + '</ul>' : '') +
      '<table class="rtable"><thead><tr><th>Line</th><th class="amt">Total · K-1s</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var open = state.openRoll === key(r);
        var total = r.check ? 'Checked' : r.values ? m$(r.total) : 'See stmt';
        return '<tr class="rrow' + (open ? ' open' : '') + '"><td colspan="2"><button type="button" data-roll="' + esc(key(r)) + '" aria-expanded="' + open + '">' +
          '<span class="ln">' + esc(r.box) + (r.code ? ' ' + esc(r.code) : '') + '</span>' +
          '<span class="ds">' + esc(r.label) + '<small>' + esc(plural(r.n, 'K-1')) + (r.stmts ? ' · ' + r.stmts + ' “see statement”' : '') + '</small></span>' +
          '<span class="tt">' + esc(total) + '</span></button>' +
          (open ? '<ul class="drill">' + r.items.map(function (it) { return '<li><button type="button" data-open="' + esc(it.id) + '"><span>' + esc(it.name) + '</span><span>' + esc(r.check ? 'Checked' : it.cents !== null ? m$(it.cents) : 'See stmt') + '</span></button></li>'; }).join('') + '</ul>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="exports"><button class="btn" type="button" id="csvAll">Download CSV - every box</button><button class="btn ghost" type="button" id="csvRoll">Roll-up CSV</button><button class="btn ghost" type="button" id="printBtn">Print summary</button></div>' +
      '<p class="small muted" style="margin-top:8px">One row per K-1 per box and code (with Items J, K and L), plain CSV for any spreadsheet. Downloading marks the checked K-1s exported.</p>';
    $$('[data-roll]', el).forEach(function (b) { b.onclick = function () { var k = b.getAttribute('data-roll'); state.openRoll = state.openRoll === k ? null : k; drawRollup(); var x = $('[data-roll="' + k.replace(/"/g, '') + '"]'); if (x) x.focus(); }; });
    $$('[data-open]', el).forEach(function (x) { x.onclick = function () { openReview(x.getAttribute('data-open')); }; });
    $('#csvAll', el).onclick = function () { download(C.fileSlug(f.label) + '-' + f.taxYear + '-k1s.csv', C.k1Csv(f), 'text/csv;charset=utf-8'); markExported(); };
    $('#csvRoll', el).onclick = function () { download(C.fileSlug(f.label) + '-' + f.taxYear + '-rollup.csv', C.rollupCsv(f), 'text/csv;charset=utf-8'); markExported(); };
    $('#printBtn', el).onclick = printSummary;
  }
  function markExported() {
    var n = 0;
    yearK1s().forEach(function (k) { if (k.stage === 'checked') { k.stage = 'exported'; n++; } });
    if (n) { touch(); drawClient(); toast('Downloaded. ' + plural(n, 'checked K-1') + ' marked exported.'); } else toast('Downloaded.');
  }

  /* ---------------- what's missing ---------------- */

  function drawMissing() {
    var el = $('#tabPanel');
    var f = state.file;
    // Still missing first (soonest due first), then what has arrived.
    var miss = C.missing(f, TODAY).sort(function (a, b) { return (a.received - b.received) || (a.received ? 0 : (a.due < b.due ? -1 : a.due > b.due ? 1 : 0)); });
    var still = miss.filter(function (x) { return !x.received; });
    var priorNames = C.priorK1s(f).filter(function (k) { return !k.final && !miss.some(function (x) { return C.partnershipKey(x.name) === C.partnershipKey(k.p.name); }); });
    el.innerHTML = '<div class="sec-head"><h2>What’s missing</h2><span class="small muted">' + (miss.length ? esc(still.length + ' of ' + miss.length + ' expected K-1s') : 'No expected list yet') + '</span></div>' +
      '<p class="note small">March 15 is the deadline for calendar-year partnerships, so that is the default. Many K-1s arrive later, and extensions to September 15 are common - change any date.</p>' +
      (still.length ? '<div class="row" style="margin-bottom:12px"><button class="btn" type="button" id="chaseBtn">Copy chase list</button><button class="btn ghost" type="button" id="icsAll">Reminders for all (.ics)</button></div>' : '') +
      (miss.length ? '<ul class="misslist">' + miss.map(function (x, i) {
        if (x.received) return '<li class="got"><span class="mn">' + esc(x.name) + '</span><span class="mrow small"><span class="word pass"><b>✓ Received</b></span>' + (x.ein4 ? '<span class="muted">EIN ' + esc(C.maskEin(x.ein4)) + '</span>' : '') + '<button class="link-btn" type="button" data-open="' + esc(x.k1Id) + '">Open K-1</button></span></li>';
        return '<li><span class="mn">' + esc(x.name) + '</span>' +
          '<span class="mrow small"><span class="word look"><b>Missing</b></span>' + (x.overdue ? '<span class="overdue">Overdue</span>' : '') + (x.ein4 ? '<span class="muted">EIN ' + esc(C.maskEin(x.ein4)) + '</span>' : '') + '</span>' +
          '<span class="mrow"><label class="small">Expected by <input class="fin" type="date" data-due="' + i + '" value="' + esc(x.due) + '" aria-label="Expected date for ' + esc(x.name) + '"></label></span>' +
          '<span class="mrow"><button class="btn small ghost" type="button" data-ics="' + i + '">Reminder (.ics)</button><button class="btn small ghost" type="button" data-got="' + i + '">It arrived</button><button class="btn small ghost" type="button" data-rmexp="' + i + '" aria-label="Stop expecting ' + esc(x.name) + '">Remove</button></span></li>';
      }).join('') + '</ul>' : '<p class="muted">Add the partnerships you expect K-1s from - paste last year’s list, one per line.</p>') +
      (priorNames.length ? '<button class="btn ghost block" type="button" id="rollFwd">Expect last year’s ' + esc(plural(priorNames.length, 'partnership')) + ' again</button>' : '') +
      '<label class="field" style="margin-top:12px"><span>Add expected partnerships (one per line)</span><textarea class="input" id="expAdd" placeholder="Northgate Real Estate Fund III LP&#10;Bluefield Energy Partners LP"></textarea></label>' +
      '<button class="btn ghost" type="button" id="expGo">Add to the list</button><div id="expErr"></div>';
    $$('[data-open]', el).forEach(function (x) { x.onclick = function () { openReview(x.getAttribute('data-open')); }; });
    $$('[data-due]', el).forEach(function (inp) {
      inp.onchange = function () {
        var x = miss[Number(inp.getAttribute('data-due'))];
        var e = expectedFor(x);
        if (e && C.isoDay(inp.value)) { e.due = inp.value; touch(); drawClient(); }
      };
    });
    $$('[data-ics]', el).forEach(function (b) { b.onclick = function () { var x = miss[Number(b.getAttribute('data-ics'))]; downloadIcs([x], C.fileSlug(x.name)); }; });
    $$('[data-got]', el).forEach(function (b) { b.onclick = function () { arrived(miss[Number(b.getAttribute('data-got'))]); }; });
    $$('[data-rmexp]', el).forEach(function (b) {
      b.onclick = function () { var x = miss[Number(b.getAttribute('data-rmexp'))]; f.expected = f.expected.filter(function (e) { return e !== expectedFor(x); }); touch(); drawClient(); toast('No longer expecting ' + x.name + '.'); };
    });
    var cb = $('#chaseBtn', el);
    if (cb) cb.onclick = function () { copyText(C.chaseText(f, TODAY), 'Chase list copied - paste it into an email.'); };
    var ia = $('#icsAll', el);
    if (ia) ia.onclick = function () { downloadIcs(still, 'missing-k1s'); };
    var rf = $('#rollFwd', el);
    if (rf) rf.onclick = function () { addExpected(priorNames.map(function (k) { return { name: k.p.name, ein4: k.p.ein4 }; })); };
    $('#expGo', el).onclick = function () {
      var lines = $('#expAdd', el).value.split(/\r?\n/).map(function (s) { return C.clean(s, C.LIMITS.name); }).filter(Boolean);
      if (!lines.length) return showError(new Error('Type at least one partnership name.'), $('#expErr', el));
      addExpected(lines.map(function (n) { return { name: n }; }));
    };
  }
  function expectedFor(x) {
    var key = C.partnershipKey(x.name);
    for (var i = 0; i < state.file.expected.length; i++) if (C.partnershipKey(state.file.expected[i].name) === key) return state.file.expected[i];
    return null;
  }
  function addExpected(list) {
    var f = state.file;
    var have = {};
    f.expected.forEach(function (e) { have[C.partnershipKey(e.name)] = true; });
    var added = 0;
    list.forEach(function (x) {
      var e = C.cleanExpected({ name: x.name, ein4: x.ein4, due: C.defaultDue(f.taxYear) }, f.taxYear);
      if (!e || have[C.partnershipKey(e.name)] || f.expected.length >= C.LIMITS.expected) return;
      have[C.partnershipKey(e.name)] = true; f.expected.push(e); added++;
    });
    touch(); drawClient();
    toast(added ? 'Now expecting ' + plural(added, 'more K-1') + '.' : 'Those were already on the list.');
  }
  /** A missing K-1 arrived: it joins the list as Received, ready to read or type. */
  function arrived(x) {
    var f = state.file;
    if (f.k1s.length >= C.LIMITS.k1s) return toast('This client file is full (' + C.LIMITS.k1s + ' K-1s).');
    var k = C.blankK1(f.taxYear);
    k.p.name = x.name; k.p.ein4 = x.ein4 || ''; k.stage = 'received';
    f.k1s.push(k);
    touch();
    openReview(k.id);
    toast('Marked received. Read it or type the boxes in.');
  }
  function downloadIcs(items, name) {
    var f = state.file;
    download(C.fileSlug(name) + '-k1-reminder.ics', C.ics(items, { label: f.label, taxYear: f.taxYear, fileKey: f.id || f.label }), 'text/calendar;charset=utf-8');
  }
  function copyText(text, ok) {
    var done = function () { toast(ok); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, ok); });
    else fallbackCopy(text, ok);
  }
  function fallbackCopy(text, ok) {
    sheet('<h2>Chase list</h2><p class="small muted">Copy this into an email.</p><textarea class="input" id="copyBox" rows="8" readonly></textarea>', function (root) {
      var t = $('#copyBox', root); t.value = text; t.focus(); t.select();
      try { if (document.execCommand('copy')) toast(ok); } catch (e) { /* the box is there to copy by hand */ }
    });
  }

  /* ---------------- the review ---------------- */

  function openReview(id) {
    if (!k1ById(id)) return;
    stopTimer();
    state.view = 'k1';
    state.k1Id = id;
    try { if (!/^#k1-/.test(location.hash)) history.pushState({ k1: id }, '', '#k1-' + id); else history.replaceState({ k1: id }, '', '#k1-' + id); } catch (e) { /* ignore */ }
    render();
    startTimer(id);
    scrollTo(0, 0);
    var h = $('#rvTitle'); if (h) h.focus();
  }
  function closeReview(viaHistory) {
    stopTimer();
    state.view = 'client';
    state.k1Id = null;
    if (!viaHistory) { try { if (/^#k1-/.test(location.hash)) history.back(); } catch (e) { /* ignore */ } }
    render();
  }
  window.addEventListener('popstate', function () {
    if (state.view === 'k1' && !/^#k1-/.test(location.hash)) closeReview(true);
    else if (/^#k1-/.test(location.hash) && state.file && k1ById(location.hash.slice(4))) { state.view = 'k1'; state.k1Id = location.hash.slice(4); render(); }
  });

  // Time spent reviewing a K-1 while the page is in view, for the honest
  // time-saved figure. Capped at the minutes it would take by hand.
  function startTimer(id) { state.timer = { id: id, since: document.hidden ? null : Date.now() }; }
  function stopTimer() {
    var t = state.timer;
    state.timer = null;
    if (!t || !t.since || !state.file) return;
    var k = k1ById(t.id);
    if (!k || k.stage === 'checked' || k.stage === 'exported') return;
    var secs = Math.round((Date.now() - t.since) / 1000);
    if (secs > 0) { k.reviewSecs = Math.min((k.reviewSecs || 0) + secs, C.MINUTES_BY_HAND * 60); touch(); }
  }
  document.addEventListener('visibilitychange', function () {
    var t = state.timer;
    if (!t) return;
    if (document.hidden) { var id = t.id; stopTimer(); state.timer = { id: id, since: null }; } else t.since = Date.now();
  });

  function neighbours() {
    var ks = yearK1s();
    var i = -1;
    ks.forEach(function (k, j) { if (k.id === state.k1Id) i = j; });
    return { prev: i > 0 ? ks[i - 1] : null, next: i >= 0 && i < ks.length - 1 ? ks[i + 1] : null, all: ks };
  }

  function drawReview() {
    var k = k1ById(state.k1Id);
    var nb = neighbours();
    var srcWord = { pdf: 'read from a PDF', photo: 'read from photos', manual: 'typed in by hand' }[k.src];
    var isPrior = k.taxYear !== state.file.taxYear;
    $('#view').innerHTML =
      '<div class="rv-head"><button class="btn small ghost" type="button" id="backBtn">‹ All K-1s</button>' +
      '<div class="rv-nav"><button class="btn small ghost" type="button" id="prevBtn"' + (nb.prev ? '' : ' disabled') + ' aria-label="Previous K-1">‹ Prev</button><button class="btn small ghost" type="button" id="nextBtn"' + (nb.next ? '' : ' disabled') + ' aria-label="Next K-1">Next ›</button></div></div>' +
      '<h1 id="rvTitle" tabindex="-1">' + esc(k.p.name || 'Unnamed partnership') + '</h1>' +
      '<p class="small muted" id="rvSub"></p>' +
      (k.stage === 'received' ? '<div class="note"><p><b>Received - not read yet.</b> Read it with AI, or type the boxes into the form below.</p><div class="row"><button class="btn small" type="button" id="readThis">Read this K-1 with AI</button></div></div>' : '') +
      (isPrior ? '<p class="note small">This is last year’s K-1 (tax year ' + esc(k.taxYear) + '), kept in this file for the year-over-year checks.</p>' : '') +
      '<div class="rv-grid"><aside class="card rv-checks" id="checksPanel" aria-label="Checks"></aside><section class="rv-form" id="formPanel" aria-label="The K-1"></section></div>';
    $('#backBtn').onclick = function () { closeReview(); };
    $('#prevBtn').onclick = function () { if (nb.prev) openReview(nb.prev.id); };
    $('#nextBtn').onclick = function () { if (nb.next) openReview(nb.next.id); };
    var rt = $('#readThis'); if (rt) rt.onclick = function () { openUpload(k.id); };
    drawSub();
    drawChecks();
    drawForm();
  }
  function drawSub() {
    var k = k1ById(state.k1Id);
    var el = $('#rvSub');
    if (!el || !k) return;
    var srcWord = { pdf: 'Read from a PDF', photo: 'Read from photos', manual: 'Typed in by hand' }[k.src];
    el.textContent = 'Tax year ' + (k.taxYear || state.file.taxYear) + ' · ' + srcWord + ' · ' + C.STAGE_LABEL[k.stage] + (k.p.ein4 ? ' · EIN ' + C.maskEin(k.p.ein4) : '');
  }

  function drawChecks() {
    var k = k1ById(state.k1Id);
    var el = $('#checksPanel');
    if (!el || !k) return;
    var clean = C.cleanK1(k);
    var checks = C.sortChecks(C.checkK1(clean, { prior: C.priorFor(clean, state.file.k1s) }));
    var s = C.summarize(checks);
    var bad = checks.filter(function (c) { return c.status !== 'pass'; });
    var good = checks.filter(function (c) { return c.status === 'pass'; });
    var nb = neighbours();
    var nextToCheck = null;
    nb.all.forEach(function (x) { if (!nextToCheck && x.id !== k.id && (x.stage === 'read' || x.stage === 'received')) nextToCheck = x; });
    var notes = state.notes[k.id] || [];
    var li = function (c) {
      return '<li class="' + c.status + '"><span class="mk ' + c.status + '" aria-hidden="true">' + MARK[c.status] + '</span><div><span class="ct"><span class="vh">' + esc(WORD[c.status]) + ': </span>' + esc(c.title) + '</span><p>' + esc(c.text) + '</p>' +
        (targetOf(c) ? '<button class="link-btn pgbtn" type="button" data-show="' + esc(c.id) + '">Show on the form' + (c.page ? ' · page ' + esc(c.page) : '') + '</button>' : (c.page ? '<span class="pgtag">Page ' + esc(c.page) + '</span>' : '')) + '</div></li>';
    };
    var checked = k.stage === 'checked' || k.stage === 'exported';
    el.innerHTML = '<h2>Checks</h2>' +
      '<p class="rv-sum">' + (s.fail ? '<span class="word fail">' + s.fail + ' to fix</span>' : '') + (s.look ? '<span class="word look">' + s.look + ' to look at</span>' : '') + '<span class="word pass">' + s.pass + ' pass</span></p>' +
      (bad.length ? '<ul class="checks">' + bad.map(li).join('') + '</ul>' : '<p class="ok">Every check passes.</p>') +
      (good.length ? '<details class="passes"' + (bad.length ? '' : ' open') + '><summary>' + esc(plural(good.length, 'check passes', 'checks pass')) + '</summary><ul class="checks">' + good.map(li).join('') + '</ul></details>' : '') +
      (notes.length ? '<div class="note readnotes"><b>Left out of the reading:</b><ul>' + notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>' : '') +
      '<div class="markbar">' +
      (k.stage === 'received' ? '' : checked
        ? '<p class="ok" style="margin:0">✓ ' + esc(C.STAGE_LABEL[k.stage]) + '</p><button class="btn ghost" type="button" id="uncheckBtn">Mark not checked</button>'
        : '<button class="btn big" type="button" id="checkBtn">Mark checked</button>') +
      (nextToCheck ? '<button class="btn ghost" type="button" id="nextCheck">Next to check: ' + esc(nextToCheck.p.name || 'unnamed') + ' ›</button>' : '') +
      '<button class="btn ghost small" type="button" id="delK1">Remove this K-1</button></div>';
    $$('[data-show]', el).forEach(function (b) { b.onclick = function () { showOnForm(b.getAttribute('data-show'), checks); }; });
    var cb = $('#checkBtn', el);
    if (cb) cb.onclick = function () {
      stopTimer();
      k.stage = 'checked';
      touch(); drawChecks(); drawSub();
      toast(s.fail ? 'Marked checked - with ' + plural(s.fail, 'check') + ' still failing.' : 'Marked checked.');
      var n = $('#nextCheck'); if (n) n.focus();
    };
    var ub = $('#uncheckBtn', el);
    if (ub) ub.onclick = function () { k.stage = 'read'; touch(); drawChecks(); drawSub(); startTimer(k.id); };
    var nc = $('#nextCheck', el);
    if (nc) nc.onclick = function () { openReview(nextToCheck.id); };
    $('#delK1', el).onclick = function () {
      sheet('<h2>Remove this K-1?</h2><p>' + esc(k.p.name || 'This K-1') + ' and its figures leave this client file.</p><div class="row"><button class="btn danger" type="button" id="yesDel">Remove it</button><button class="btn ghost" type="button" id="noDel">Keep it</button></div>', function (root) {
        $('#noDel', root).onclick = closeSheet;
        $('#yesDel', root).onclick = function () {
          state.file.k1s = state.file.k1s.filter(function (x) { return x !== k; });
          delete state.partners[k.id];
          touch(); closeSheet(); closeReview(); toast('Removed.');
        };
      });
    };
  }

  /** Where on the form a check points. */
  function targetOf(c) {
    var id = c.id;
    var map = { itemL: '[data-item="l.ending"]', lVsBoxes: '[data-item="l.currentYear"]', box19: '[data-item="l.withdrawals"]', itemJ: '[data-item="j.profitEnd"]', final: '[data-f="final"]', amended: '[data-f="amended"]', ptp: '[data-f="ptp"]', k3: '[data-check="16"]', box4: '[data-boxc="4c"]', box6b: '[data-boxc="6b"]' };
    if (map[id]) return map[id];
    var p = id.split(':');
    if (p[0] === 'code') return '[data-boxc="' + p[1] + '"]';
    if (p[0] === 'stmt' || p[0] === 'conf' || p[0] === 'yoy') {
      if (/^[jkl]\./.test(p[1])) return '[data-item="' + p[1] + '"]';
      var m = /^(\d+[a-c]?)/.exec(p[1] || '');
      return m ? '[data-boxc="' + m[1] + '"]' : null;
    }
    return null;
  }
  function showOnForm(id, checks) {
    var c = checks.filter(function (x) { return x.id === id; })[0];
    var sel = c && targetOf(c);
    var el = sel && $(sel, $('#formPanel'));
    if (!el) return;
    var cell = el.closest('.bxc, .fld, td') || el;
    if (cell.scrollIntoView) cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
    var focusable = el.matches('input, select') ? el : $('input', el);
    if (focusable) setTimeout(function () { try { focusable.focus({ preventScroll: true }); } catch (e) { focusable.focus(); } }, 250);
  }

  /* ---------------- the form ---------------- */

  function pageTag(page, conf) {
    if (!page && conf !== 'low') return '';
    return '<span class="pgtag' + (conf === 'low' ? ' low' : '') + '">' + (page ? 'p.' + esc(page) : '') + (conf === 'low' ? ' · low' : '') + '</span>';
  }
  function hintText(page, conf, src) {
    if (src === 'manual' && !page) return 'Typed in.';
    if (!page && !conf) return 'Typed or changed by you.';
    return (page ? 'Read from page ' + page + ' of the ' + (src === 'photo' ? 'photos' : 'file') : 'Read') + (conf ? ' · ' + conf + ' confidence' : '') + (conf === 'low' ? ' - check it against the page' : '') + '.';
  }

  function drawForm() {
    var k = k1ById(state.k1Id);
    var el = $('#formPanel');
    var partner = state.partners[k.id];
    var yr = k.taxYear || state.file.taxYear;
    var itemIn = function (key) {
      var f = C.ITEM[key];
      var v = C.fieldValue(k, key);
      var a = k.at[key] || {};
      var shown = v === null ? '' : f.kind === 'pct' ? C.pctText(v, true) : C.formMoney(v);
      return '<input class="fin amt' + (a.c === 'low' ? ' low' : '') + '" data-item="' + key + '" value="' + esc(shown) + '" inputmode="decimal" autocomplete="off" aria-label="Item ' + f.item + ', ' + esc(f.label) + (f.kind === 'pct' ? ', percent' : '') + '">' +
        '<span class="hint">' + esc(hintText(a.p, a.c, k.src)) + '</span>';
    };
    var trow = function (label, a, b) { return '<tr><td>' + esc(label) + '</td><td>' + itemIn(a) + '</td><td>' + itemIn(b) + '</td></tr>'; };
    var lrow = function (key, label) { return '<tr><td>' + esc(label) + '</td><td colspan="2">' + itemIn(key) + '</td></tr>'; };
    var col = function (n) { return C.BOXES.filter(function (b) { return b.col === n; }).map(function (b) { return boxHtml(k, b); }).join(''); };
    var entity = partner && partner.type ? partner.type.replace(/_/g, ' ') : '';

    el.innerHTML = '<div class="k1form">' +
      '<div class="fhead"><div class="t1"><b>Schedule K-1</b> (Form 1065)<small>Department of the Treasury · Internal Revenue Service</small></div>' +
      '<div class="t2"><span class="yr">' + esc(yr) + '</span><small>Partner’s Share of Income, Deductions, Credits, etc.</small></div>' +
      '<div class="flags"><label class="cb"><input type="checkbox" data-f="final"' + (k.final ? ' checked' : '') + '> Final K-1</label><label class="cb"><input type="checkbox" data-f="amended"' + (k.amended ? ' checked' : '') + '> Amended K-1</label></div></div>' +
      '<div class="fbody"><div class="fcol">' +
        '<section class="part"><h3><span class="pn">Part I</span> Information About the Partnership</h3>' +
          '<div class="fld"><span class="fl">A</span><div class="fx"><span>Partnership’s EIN (last four only)</span><span class="ein"><span class="mask" aria-hidden="true">••-•••</span><input class="fin" data-f="ein4" value="' + esc(k.p.ein4) + '" inputmode="numeric" maxlength="4" autocomplete="off" aria-label="Partnership EIN, last four digits"></span></div></div>' +
          '<div class="fld"><span class="fl">B</span><div class="fx"><span>Partnership’s name</span><input class="fin" data-f="name" value="' + esc(k.p.name) + '" maxlength="' + C.LIMITS.name + '" autocomplete="off" aria-label="Partnership name"></div></div>' +
          '<div class="fld"><span class="fl">C</span><div class="fx"><span>IRS center where partnership filed return</span><input class="fin" data-f="center" value="' + esc(k.p.center) + '" maxlength="40" autocomplete="off" aria-label="IRS center"></div></div>' +
          '<div class="fld"><span class="fl">D</span><div class="fx"><label class="cb"><input type="checkbox" data-f="ptp"' + (k.p.ptp ? ' checked' : '') + '> Publicly traded partnership (PTP)</label></div></div>' +
        '</section>' +
        '<section class="part"><h3><span class="pn">Part II</span> Information About the Partner</h3>' +
          '<div class="fld"><span class="fl">E</span><div class="fx"><span>Partner’s identifying number</span>' + (partner && partner.tin ? '<b>' + esc(partner.tin) + '</b>' : '<span class="kept">Not kept</span>') + '</div></div>' +
          '<div class="fld"><span class="fl">F</span><div class="fx"><span>Partner’s name</span>' + (partner && partner.name ? '<b>' + esc(partner.name) + '</b>' : '<span class="kept">Not kept</span>') + '</div></div>' +
          (partner ? '<div class="fld"><span class="fl">G-I</span><div class="fx"><span>' + esc([partner.general === true ? 'General partner' : partner.general === false ? 'Limited partner' : '', partner.foreign === true ? 'Foreign' : partner.foreign === false ? 'Domestic' : '', entity].filter(Boolean).join(' · ') || 'Not read') + '</span></div></div>' : '') +
          '<p class="small muted" style="margin:6px 10px">Boxed never stores a partner’s name, TIN or address' + (partner ? ' - these are shown from this reading only, and only the last four of the TIN.' : '.') + '</p>' +
          '<div class="fld"><span class="fl">J</span><div class="fx"><span>Partner’s share of profit, loss, and capital (%)</span><table class="itbl"><thead><tr><th></th><th>Beginning</th><th>Ending</th></tr></thead><tbody>' +
            trow('Profit', 'j.profitBeg', 'j.profitEnd') + trow('Loss', 'j.lossBeg', 'j.lossEnd') + trow('Capital', 'j.capitalBeg', 'j.capitalEnd') + '</tbody></table></div></div>' +
          '<div class="fld"><span class="fl">K</span><div class="fx"><span>Partner’s share of liabilities</span><table class="itbl"><thead><tr><th></th><th>Beginning</th><th>Ending</th></tr></thead><tbody>' +
            trow('Nonrecourse', 'k.nonrecourseBeg', 'k.nonrecourseEnd') + trow('Qualified nonrecourse financing', 'k.qualifiedBeg', 'k.qualifiedEnd') + trow('Recourse', 'k.recourseBeg', 'k.recourseEnd') + '</tbody></table></div></div>' +
          '<div class="fld"><span class="fl">L</span><div class="fx"><span>Partner’s capital account analysis</span><table class="itbl"><tbody>' +
            lrow('l.beginning', 'Beginning capital account') + lrow('l.contributed', 'Capital contributed during the year') + lrow('l.currentYear', 'Current year net income (loss)') +
            lrow('l.other', 'Other increase (decrease)') + lrow('l.withdrawals', 'Withdrawals and distributions ( )') + lrow('l.ending', 'Ending capital account') + '</tbody></table>' +
            '<label class="small" style="display:flex;gap:8px;align-items:center;margin-top:6px">Basis <select class="fin" data-f="basis" style="width:auto" aria-label="Capital account basis"><option value="">Not shown</option>' + C.BASES.map(function (b) { return '<option value="' + b + '"' + (k.l.basis === b ? ' selected' : '') + '>' + esc(C.BASIS_LABEL[b]) + '</option>'; }).join('') + '</select></label></div></div>' +
        '</section>' +
      '</div><div class="fcol">' +
        '<section class="part"><h3><span class="pn">Part III</span> Partner’s Share of Current Year Income, Deductions, Credits, and Other Items</h3>' +
        '<div class="p3"><div class="p3col">' + col(1) + '</div><div class="p3col">' + col(2) + '</div></div></section>' +
      '</div></div></div>' +
      '<p class="small muted" style="margin-top:8px">Amounts as the form prints them: (1,250) is a loss. Tap a value to see the page it came from. Every change re-runs the checks.</p>';
  }

  function boxHtml(k, b) {
    var rows = [];
    k.lines.forEach(function (l, i) { if (l.box === b.box) rows.push(i); });
    var has = rows.length > 0;
    var head = '<div class="bxh"><span class="bn">' + esc(b.box) + '</span><span class="bl">' + esc(b.label) + '</span></div>';
    if (b.kind === 'check') {
      var on = k[C.CHECK_BOXES[b.box]];
      return '<div class="bxc' + (on ? ' has' : ' empty') + '" data-boxc="' + b.box + '"><label class="cb"><input type="checkbox" data-check="' + b.box + '"' + (on ? ' checked' : '') + '><span><b>' + esc(b.box) + '</b> <span class="bl">' + esc(b.label) + '</span></span></label></div>';
    }
    var amount = function (i, l) {
      var shown = l.cents === null ? '' : C.formMoney(l.cents);
      return '<input class="fin amt' + (l.conf === 'low' ? ' low' : '') + '" data-line="' + i + '" data-part="amt" value="' + esc(shown) + '" placeholder="' + (l.stmt ? 'STMT' : '') + '" inputmode="decimal" autocomplete="off" aria-label="Box ' + esc(b.box) + (l.code ? ' code ' + esc(l.code) : '') + ' amount">';
    };
    // Under each line: where it was read (page, confidence) on the left,
    // "see statement" and remove on the right - 44px targets, never wrapped
    // under the amount.
    var tools = function (i, l, removable) {
      return '<div class="ltools">' + pageTag(l.page, l.conf) + '<span class="rowtools"><button type="button" class="ibtn" data-stmt="' + i + '" aria-pressed="' + Boolean(l.stmt) + '" aria-label="Box ' + esc(b.box) + (l.code ? ' code ' + esc(l.code) : '') + ' says see statement">STMT</button>' +
        (removable ? '<button type="button" class="ibtn" data-rm="' + i + '" aria-label="Remove box ' + esc(b.box) + (l.code ? ' code ' + esc(l.code) : '') + '">✕</button>' : '') + '</span></div>';
    };
    var body = '';
    if (b.kind === 'coded') {
      body = rows.map(function (i) {
        var l = k.lines[i];
        return '<div class="cline"><div class="crow"><input class="fin code" data-line="' + i + '" data-part="code" value="' + esc(l.code || '') + '" maxlength="2" autocomplete="off" autocapitalize="characters" aria-label="Box ' + esc(b.box) + ' code">' + amount(i, l) + '</div>' +
          '<span class="cdesc">' + esc(l.code ? l.code + ' · ' + C.codeLabel(b.box, l.code) : 'Type the code letter') + '</span>' +
          '<span class="hint">' + esc(hintText(l.page, l.conf, k.src)) + '</span>' + tools(i, l, true) + '</div>';
      }).join('') + '<button type="button" class="addcode" data-addcode="' + esc(b.box) + '">+ Add a code</button>';
    } else if (has) {
      body = rows.map(function (i) {
        var l = k.lines[i];
        return '<div class="cline"><div class="arow">' + amount(i, l) + '</div><span class="hint">' + esc(hintText(l.page, l.conf, k.src)) + '</span>' + tools(i, l, rows.length > 1) + '</div>';
      }).join('');
    } else {
      body = '<div class="arow"><input class="fin amt" data-newbox="' + esc(b.box) + '" value="" inputmode="decimal" autocomplete="off" aria-label="Box ' + esc(b.box) + ', ' + esc(b.label) + '"></div>';
    }
    return '<div class="bxc' + (has ? ' has' : ' empty') + '" data-boxc="' + esc(b.box) + '">' + head + body + '</div>';
  }

  /** A change on the form: the K-1 is updated and the checks run again. */
  function edited(k) {
    if (k.stage === 'checked' || k.stage === 'exported') {
      k.stage = 'read';
      startTimer(k.id);
      if (!state.editedToast[k.id]) { state.editedToast[k.id] = true; toast('Changed after it was checked - mark it checked again when you’re done.', 3800); }
    }
    if (k.stage === 'received') k.stage = 'read';
    drawChecks(); drawSub();
    touch();
  }
  function onFormInput(e) {
    var t = e.target;
    var k = k1ById(state.k1Id);
    if (!k || !t.matches('input, select')) return;
    var f = t.getAttribute('data-f');
    if (f === 'name') { k.p.name = C.clean(t.value, C.LIMITS.name); $('#rvTitle').textContent = k.p.name || 'Unnamed partnership'; return edited(k); }
    if (f === 'ein4') { var d = t.value.replace(/\D/g, '').slice(0, 4); if (t.value !== d) t.value = d; k.p.ein4 = d.length === 4 ? d : ''; return edited(k); }
    if (f === 'center') { k.p.center = C.clean(t.value, 40); return edited(k); }
    var item = t.getAttribute('data-item');
    if (item) {
      var spec = C.ITEM[item];
      var v = t.value.trim() === '' ? null : (spec.kind === 'pct' ? C.toPct(t.value) : C.toCents(t.value));
      if (v === null && t.value.trim() !== '') { t.classList.add('bad'); return; }
      t.classList.remove('bad', 'low');
      var p = item.split('.');
      k[p[0]][p[1]] = v;
      if (k.at[item]) k.at[item] = { p: k.at[item].p, c: null };
      return edited(k);
    }
    var nb = t.getAttribute('data-newbox');
    if (nb) {
      var c = t.value.trim() === '' ? null : C.toCents(t.value);
      if (c === null) { if (t.value.trim() !== '') t.classList.add('bad'); return; }
      t.classList.remove('bad');
      k.lines.push({ box: nb, code: null, cents: c, stmt: false, page: null, conf: null });
      t.removeAttribute('data-newbox');
      t.setAttribute('data-line', String(k.lines.length - 1));
      t.setAttribute('data-part', 'amt');
      return edited(k);
    }
    var li = t.getAttribute('data-line');
    if (li !== null) {
      var l = k.lines[Number(li)];
      if (!l) return;
      if (t.getAttribute('data-part') === 'code') {
        var code = t.value.trim().toUpperCase();
        if (code === '') { l.code = null; t.classList.remove('bad'); }
        else if (C.cleanCode(code)) { l.code = code; t.classList.remove('bad'); }
        else { t.classList.add('bad'); return; }
        var desc = t.closest('.cline') && $('.cdesc', t.closest('.cline'));
        if (desc) desc.textContent = l.code ? l.code + ' · ' + C.codeLabel(l.box, l.code) : 'Type the code letter';
        return edited(k);
      }
      var cents = t.value.trim() === '' ? null : C.toCents(t.value);
      if (cents === null && t.value.trim() !== '') { t.classList.add('bad'); return; }
      t.classList.remove('bad', 'low');
      l.cents = cents; l.conf = null;
      return edited(k);
    }
  }
  function onFormChange(e) {
    var t = e.target;
    var k = k1ById(state.k1Id);
    if (!k) return;
    var f = t.getAttribute('data-f');
    if (f === 'final' || f === 'amended') { k[f] = t.checked; return edited(k); }
    if (f === 'ptp') { k.p.ptp = t.checked; return edited(k); }
    if (f === 'basis') { k.l.basis = C.BASES.indexOf(t.value) >= 0 ? t.value : null; return edited(k); }
    var cb = t.getAttribute('data-check');
    if (cb) { k[C.CHECK_BOXES[cb]] = t.checked; return edited(k); }
  }
  function onFormBlur(e) {
    var t = e.target;
    var cell = t.closest && t.closest('.bxc, td, .fld');
    if (cell) cell.classList.remove('focused');
    if (!t.matches || !t.matches('input.amt') || t.classList.contains('bad')) return;
    var k = k1ById(state.k1Id);
    var item = t.getAttribute('data-item');
    if (item) { var v = C.fieldValue(k, item); t.value = v === null ? '' : C.ITEM[item].kind === 'pct' ? C.pctText(v, true) : C.formMoney(v); return; }
    var li = t.getAttribute('data-line');
    if (li !== null && k.lines[Number(li)]) { var l = k.lines[Number(li)]; t.value = l.cents === null ? '' : C.formMoney(l.cents); }
  }
  function onFormFocus(e) {
    var t = e.target;
    $$('.focused', $('#formPanel')).forEach(function (x) { x.classList.remove('focused'); });
    $$('.hint.on', $('#formPanel')).forEach(function (x) { x.classList.remove('on'); });
    if (!t.matches || !t.matches('input.fin')) return;
    var next = t.nextElementSibling;
    if (next && next.classList.contains('hint')) { next.classList.add('on'); return; }
    // A Part III line: its hint sits in the same line's block.
    var line = t.closest('.cline');
    var h = line && $('.hint', line);
    if (h) h.classList.add('on');
  }
  function onFormClick(e) {
    var b = e.target.closest('button');
    var k = k1ById(state.k1Id);
    if (!b || !k) return;
    if (b.hasAttribute('data-stmt')) { var l = k.lines[Number(b.getAttribute('data-stmt'))]; if (l) { l.stmt = !l.stmt; edited(k); redrawFormKeepingPlace(b); } return; }
    if (b.hasAttribute('data-rm')) { k.lines.splice(Number(b.getAttribute('data-rm')), 1); edited(k); redrawFormKeepingPlace(b); return; }
    if (b.hasAttribute('data-addcode')) {
      if (k.lines.length >= C.LIMITS.lines) return toast('A K-1 holds up to ' + C.LIMITS.lines + ' lines here.');
      var box = b.getAttribute('data-addcode');
      k.lines.push({ box: box, code: null, cents: null, stmt: false, page: null, conf: null });
      var idx = k.lines.length - 1;
      drawForm();
      var inp = $('[data-line="' + idx + '"][data-part="code"]', $('#formPanel'));
      if (inp) inp.focus();
    }
  }
  function redrawFormKeepingPlace(btn) {
    var cell = btn.closest('.bxc');
    var box = cell && cell.getAttribute('data-boxc');
    drawForm();
    var again = box && $('[data-boxc="' + box + '"]', $('#formPanel'));
    var f = again && $('input', again);
    if (f) f.focus();
  }
  // One set of listeners for the form, whatever is drawn in it.
  document.addEventListener('input', function (e) { if (e.target.closest && e.target.closest('#formPanel')) onFormInput(e); });
  document.addEventListener('change', function (e) { if (e.target.closest && e.target.closest('#formPanel')) onFormChange(e); });
  document.addEventListener('focusout', function (e) { if (e.target.closest && e.target.closest('#formPanel')) onFormBlur(e); });
  document.addEventListener('focusin', function (e) { if (e.target.closest && e.target.closest('#formPanel')) onFormFocus(e); });
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#formPanel')) onFormClick(e); });

  /* ---------------- new K-1s: typed ---------------- */

  function typeOne() {
    if (state.file.where === 'sample') return startClient('type');
    var f = state.file;
    if (f.k1s.length >= C.LIMITS.k1s) return toast('This client file is full (' + C.LIMITS.k1s + ' K-1s). Start another file.');
    var k = C.blankK1(f.taxYear);
    f.k1s.push(k);
    touch();
    openReview(k.id);
    setTimeout(function () { var n = $('[data-f="name"]'); if (n) n.focus(); }, 60);
  }

  /* ---------------- new K-1s: read with AI ---------------- */

  function openUpload(replaceId) {
    if (state.file.where === 'sample') return startClient('read');
    if (!signedIn()) {
      sheet('<h2>Read K-1s with AI</h2><p class="muted">Reading a K-1 uses AI, so it needs a free account. It comes with $2 of credit, and a K-1 costs a few cents.</p>' +
        '<p class="small muted">The checks, the roll-up, what’s missing, exports and typing K-1s in are free, with no account.</p>' +
        '<button class="btn block" type="button" id="uIn">Sign in or create a free account</button><button class="btn ghost block" type="button" id="uType" style="margin-top:10px">Type one in instead - free</button>', function (root) {
        $('#uIn', root).onclick = function () { openAccount(null, function () { openUpload(replaceId); }); };
        $('#uType', root).onclick = function () { closeSheet(); typeOne(); };
      });
      return;
    }
    var picked = [];
    var single = Boolean(replaceId);
    function draw(root) {
      var body = $('.body', root);
      var pdfs = picked.filter(function (p) { return p.kind === 'pdf'; });
      var photos = picked.filter(function (p) { return p.kind === 'photo'; });
      var jobs = pdfs.length + (photos.length ? 1 : 0);
      body.innerHTML = '<h2>' + (single ? 'Read this K-1 with AI' : 'Read K-1s with AI') + '</h2>' +
        '<p class="small muted"><b>PDFs:</b> one K-1 per file' + (single ? '' : ', up to ' + C.LIMITS.files + ' at a time') + ' (10 MB and 30 pages each - statements included). <b>Or photos</b> of one K-1, up to ' + C.LIMITS.photos + ' pages.</p>' +
        '<p class="small muted">Read once and not kept. The partner’s TIN comes back as its last four digits only.</p>' +
        '<div class="drop" id="drop"><p style="margin:0"><b>Drop K-1 PDFs here</b></p><label class="btn ghost">Choose files<input type="file" accept="application/pdf,.pdf,image/*" multiple id="upFile" class="vh"></label></div>' +
        (picked.length ? '<ul class="picked">' + picked.map(function (p, i) { return '<li><span>' + (p.kind === 'pdf' ? '📄 ' : '🖼️ ') + esc(p.name) + ' <span class="small muted">' + esc(sizeText(p.size)) + '</span></span><button type="button" class="ibtn" data-rmp="' + i + '" aria-label="Remove ' + esc(p.name) + '">✕</button></li>'; }).join('') + '</ul>' : '') +
        (photos.length ? '<p class="small muted">' + esc(plural(photos.length, 'photo')) + ' will be read together as one K-1.</p>' : '') +
        '<div id="upErr"></div>' +
        '<button class="btn block big" type="button" id="upGo"' + (jobs ? '' : ' disabled') + '>' + (jobs ? 'Read ' + plural(jobs, 'K-1') : 'Read them') + '</button>' +
        '<p class="small muted center">Uses AI credit - a few cents a K-1. Each one takes 20-60 seconds.</p>';
      var inp = $('#upFile', body);
      inp.onchange = function () { add(inp.files, root); inp.value = ''; };
      var drop = $('#drop', body);
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) add(e.dataTransfer.files, root); });
      $$('[data-rmp]', body).forEach(function (b) { b.onclick = function () { picked.splice(Number(b.getAttribute('data-rmp')), 1); draw(root); }; });
      $('#upGo', body).onclick = function () {
        var list = [];
        pdfs.forEach(function (p) { list.push({ name: p.name, kind: 'pdf', files: [p.file], replaceId: single ? replaceId : null }); });
        if (photos.length) list.push({ name: photos.length === 1 ? photos[0].name : plural(photos.length, 'photo') + ' of one K-1', kind: 'photo', files: photos.map(function (p) { return p.file; }), replaceId: single ? replaceId : null });
        closeSheet();
        enqueue(list);
      };
    }
    function add(fileList, root) {
      var err = $('#upErr', root);
      err.innerHTML = '';
      var problems = [];
      Array.prototype.slice.call(fileList || []).forEach(function (file) {
        var isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
        var isImg = /^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) || /\.(jpe?g|png|webp|heic)$/i.test(file.name);
        if (!isPdf && !isImg) { problems.push(file.name + ' isn’t a PDF or a photo.'); return; }
        if (isPdf && file.size > C.LIMITS.pdfBytes) { problems.push(file.name + ' is over 10 MB - save just the K-1 and its statements.'); return; }
        var pdfCount = picked.filter(function (p) { return p.kind === 'pdf'; }).length;
        var photoCount = picked.filter(function (p) { return p.kind === 'photo'; }).length;
        if (isPdf && (single ? pdfCount + photoCount >= 1 : pdfCount >= C.LIMITS.files)) { problems.push(single ? 'One file for this K-1.' : 'Up to ' + C.LIMITS.files + ' PDFs at a time.'); return; }
        if (isImg && (photoCount >= C.LIMITS.photos || (single && pdfCount))) { problems.push('Up to ' + C.LIMITS.photos + ' photos of one K-1.'); return; }
        picked.push({ kind: isPdf ? 'pdf' : 'photo', name: C.clean(file.name, 80), size: file.size, file: file });
      });
      draw(root);
      if (problems.length) showError(new Error(problems.slice(0, 3).join(' ')), $('#upErr', root));
    }
    sheet('<div class="body"></div>', draw);
  }
  function sizeText(n) { return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function enqueue(list) {
    list.forEach(function (j) { j.status = 'queued'; j.msg = ''; state.queue.push(j); });
    state.tab = 'k1s';
    if (state.view !== 'client') closeReview();
    else drawClient();
    var q = $('#queueCard'); if (q && q.scrollIntoView) q.scrollIntoView({ block: 'nearest' });
    runQueue();
  }
  function drawQueue() {
    var el = $('#queueCard');
    if (!el) return;
    if (!state.queue.length) { el.hidden = true; return; }
    el.hidden = false;
    var done = state.queue.filter(function (j) { return j.status === 'done'; }).length;
    var busy = state.queue.some(function (j) { return j.status === 'reading' || j.status === 'queued'; });
    el.innerHTML = '<div class="sec-head"><h2>' + (busy ? 'Reading ' + (done + 1 > state.queue.length ? state.queue.length : done + 1) + ' of ' + state.queue.length + '…' : 'Read ' + done + ' of ' + state.queue.length) + '</h2>' + (busy ? '' : '<button class="btn small ghost" type="button" id="qClear">Clear</button>') + '</div>' +
      '<div id="qNote"></div><ul>' + state.queue.map(function (j, i) {
        var icon = j.status === 'reading' ? '<span class="spin" aria-hidden="true"></span>' : j.status === 'done' ? '<span class="mk ' + esc(j.result || 'pass') + '" aria-hidden="true">' + MARK[j.result || 'pass'] + '</span>' : j.status === 'error' ? '<span class="mk fail" aria-hidden="true">✕</span>' : '<span class="mk" aria-hidden="true">·</span>';
        var word = j.status === 'reading' ? 'Reading… about 20-60 seconds' : j.status === 'queued' ? 'Waiting' : j.status === 'stopped' ? 'Not read' : j.status === 'error' ? j.msg : j.msg;
        return '<li>' + icon + '<span class="qn"><b>' + esc(j.label || j.name) + '</b><br><span class="qs">' + esc(word) + '</span></span>' + (j.status === 'done' && j.k1Id ? '<button class="btn small ghost" type="button" data-qopen="' + esc(j.k1Id) + '">Review</button>' : '') + '</li>';
      }).join('') + '</ul>';
    $$('[data-qopen]', el).forEach(function (b) { b.onclick = function () { openReview(b.getAttribute('data-qopen')); }; });
    var qc = $('#qClear', el); if (qc) qc.onclick = function () { state.queue = []; drawQueue(); };
    if (state.queueNote) state.queueNote($('#qNote', el));
  }
  function runQueue() {
    if (state.queueBusy) return;
    var job = state.queue.filter(function (j) { return j.status === 'queued'; })[0];
    if (!job) { state.queueBusy = false; return; }
    state.queueBusy = true;
    job.status = 'reading';
    refreshQueue();
    bodyFor(job).then(function (body) {
      body.taxYear = state.file.taxYear;
      return api('POST', 'api/read', body);
    }).then(function (res) {
      addReading(job, res);
    }).catch(function (e) {
      if (e.status === 401 || e.status === 402 || (e.data && e.data.code === 'verify-email')) {
        job.status = 'error'; job.msg = e.status === 402 ? 'Out of AI credit' : e.status === 401 ? 'Sign in to read it' : 'Confirm your email first';
        state.queue.forEach(function (j) { if (j.status === 'queued') j.status = 'stopped'; });
        if (e.data && e.data.code === 'verify-email') state.queueNote = function (where) { verifyNote(where, e); };
        else showError(e);
      } else { job.status = 'error'; job.msg = e.message || 'That one could not be read.'; }
    }).then(function () {
      state.queueBusy = false;
      refreshQueue();
      runQueue();
    });
  }
  function refreshQueue() {
    if (state.view === 'client') { if (state.tab === 'k1s' && state.queue.every(function (j) { return j.status !== 'reading'; })) drawClient(); else drawQueue(); }
  }
  function bodyFor(job) {
    if (job.kind === 'pdf') {
      return readBase64(job.files[0]).then(function (b64) {
        if (!/^JVBERi0/.test(b64)) throw new Error('That file isn’t a PDF.');
        return { pdf: { data: b64 } };
      });
    }
    return Promise.all(job.files.map(shrink)).then(function (photos) { return { photos: photos }; });
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
  /** A reading joins the client file: as a new K-1, or in place of the
   *  Received placeholder for the same partnership. */
  function addReading(job, res) {
    var f = state.file;
    var k = C.cleanK1(res.k1);
    if (!k) throw new Error('That reading came back empty.');
    if (!k.taxYear) k.taxYear = f.taxYear;
    k.stage = 'read';
    var key = C.partnershipKey(k.p.name);
    var placeholder = null;
    f.k1s.forEach(function (x) {
      if (placeholder) return;
      if (job.replaceId ? x.id === job.replaceId : (x.stage === 'received' && x.taxYear === k.taxYear && ((k.p.ein4 && x.p.ein4 === k.p.ein4) || (key && C.partnershipKey(x.p.name) === key)))) placeholder = x;
    });
    var dupe = !placeholder && f.k1s.some(function (x) { return x.taxYear === k.taxYear && key && C.partnershipKey(x.p.name) === key; });
    if (placeholder) { k.id = placeholder.id; f.k1s[f.k1s.indexOf(placeholder)] = k; }
    else {
      if (f.k1s.length >= C.LIMITS.k1s) throw new Error('This client file is full (' + C.LIMITS.k1s + ' K-1s).');
      f.k1s.push(k);
    }
    if (res.partner) state.partners[k.id] = res.partner;
    var notes = (res.notes || []).slice();
    if (res.note) notes.unshift(res.note);
    state.notes[k.id] = notes;
    var s = C.summarize(C.checksFor(k, f));
    job.status = 'done'; job.k1Id = k.id; job.result = s.result;
    job.label = k.p.name || job.name;
    job.msg = (s.fail ? s.fail + ' to fix' : s.look ? s.look + ' to look at' : 'All checks pass') + (dupe ? ' · this partnership already had a K-1 here' : '') + (k.taxYear !== f.taxYear ? ' · tax year ' + k.taxYear : '');
    touch();
  }

  /* ---------------- starting, switching, saving client files ---------------- */

  function startClient(then) {
    sheet('<h2>Start a client</h2><p class="small muted">A client file holds one tax year of K-1s. Give it a label you’ll recognise - Boxed doesn’t need the client’s name or SSN.</p>' +
      '<label class="field"><span>Label</span><input class="input" id="nLabel" maxlength="' + C.LIMITS.label + '" placeholder="Client A - ' + DEFAULT_YEAR + '" autocomplete="off"></label>' +
      '<label class="field"><span>Tax year</span><input class="input" id="nYear" inputmode="numeric" maxlength="4" value="' + DEFAULT_YEAR + '"></label>' +
      '<label class="field"><span>K-1s you expect (optional, one per line)</span><textarea class="input" id="nExp" placeholder="Paste last year’s list of partnerships"></textarea></label>' +
      '<div id="nErr"></div>' +
      '<button class="btn block big" type="button" id="nRead">Start and read K-1s with AI</button>' +
      '<button class="btn ghost block" type="button" id="nType" style="margin-top:10px">Start and type one in - free</button>' +
      (signedIn() ? '<p class="small muted center" style="margin-top:10px">Saved to your account as you go.</p>' : '<p class="small muted center" style="margin-top:10px">Kept on this device. Sign in (free) to keep it in your account.</p>'),
      function (root) {
        var go = function (next) {
          var label = C.clean($('#nLabel', root).value, C.LIMITS.label) || ('Client - ' + ($('#nYear', root).value || DEFAULT_YEAR));
          var year = C.cleanYear($('#nYear', root).value);
          if (!year) return showError(new Error('The tax year is a year, like ' + DEFAULT_YEAR + '.'), $('#nErr', root));
          var exp = $('#nExp', root).value.split(/\r?\n/).map(function (s) { return { name: C.clean(s, C.LIMITS.name), due: C.defaultDue(year) }; }).filter(function (x) { return x.name; });
          var raw = { label: label, taxYear: year, k1s: [], expected: exp.slice(0, C.LIMITS.expected) };
          createFile(raw).then(function () {
            closeSheet();
            if (next === 'read') openUpload(); else typeOne();
          }).catch(function (e) { showError(e, $('#nErr', root)); });
        };
        $('#nRead', root).onclick = function () { go('read'); };
        $('#nType', root).onclick = function () { go('type'); };
        if (then === 'type') $('#nType', root).classList.remove('ghost');
      });
  }
  function createFile(raw) {
    if (signedIn()) {
      return api('POST', 'api/clients', raw).then(function (r) { openFile(fileFrom('account', r.client, r.client.id)); state.saving = 'saved'; drawStrip(); });
    }
    var files = localFiles();
    if (files.length >= C.LIMITS.clients) return Promise.reject(new Error('This device keeps up to ' + C.LIMITS.clients + ' client files. Delete one first.'));
    var f = fileFrom('local', raw, 'l' + C.newId('').slice(0, 12));
    files.unshift(Object.assign({ id: f.id }, savedShape(f), { updatedAt: new Date().toISOString() }));
    writeLocal(files, f.id);
    openFile(f);
    return Promise.resolve();
  }
  function renameSheet(f) {
    sheet('<h2>Rename</h2><label class="field"><span>Label</span><input class="input" id="rnLabel" maxlength="' + C.LIMITS.label + '"></label><div id="rnErr"></div><button class="btn block" type="button" id="rnGo">Save</button>', function (root) {
      var inp = $('#rnLabel', root); inp.value = f.label;
      $('#rnGo', root).onclick = function () {
        var label = C.clean(inp.value, C.LIMITS.label);
        if (!label) return showError(new Error('Give it a label.'), $('#rnErr', root));
        f.label = label;
        if (f.where === 'account') api('PATCH', 'api/clients/' + encodeURIComponent(f.id), { label: label }).then(function () { closeSheet(); drawStrip(); }).catch(function (e) { showError(e, $('#rnErr', root)); });
        else { touch(); closeSheet(); drawStrip(); }
      };
    });
  }
  function duplicateFile(f) {
    var go = function () {
      if (f.where === 'account') {
        return api('POST', 'api/clients/' + encodeURIComponent(f.id) + '/duplicate').then(function (r) { closeSheet(); openFile(fileFrom('account', r.client, r.client.id)); state.tab = 'missing'; drawClient(); toast('Started ' + r.client.label + '.'); }).catch(function (e) { showError(e); });
      }
      var next = C.nextYear(f);
      createFile(next).then(function () { closeSheet(); state.tab = 'missing'; drawClient(); toast('Started ' + next.label + '.'); }).catch(function (e) { showError(e); });
    };
    sheet('<h2>Start ' + esc(f.taxYear + 1) + ' from this file?</h2><p>A new client file for tax year ' + esc(f.taxYear + 1) + ': this year’s K-1s come along as last year’s (for the year-over-year checks), and every partnership is expected again by March 15' + (f.k1s.some(function (k) { return k.final; }) ? ' - except those whose K-1 was final' : '') + '.</p><button class="btn block" type="button" id="dupGo">Start ' + esc(f.taxYear + 1) + '</button>', function (root) { $('#dupGo', root).onclick = go; });
  }

  function openClients() {
    var draw = function (root, list, err) {
      var body = $('.body', root);
      var locals = localFiles();
      var cur = state.file ? state.file.id : null;
      var item = function (id, where, label, sub, actions) {
        return '<li class="' + (id === cur ? 'on' : '') + '"><button class="open" type="button" data-openf="' + esc(where + ':' + id) + '"><b>' + esc(label) + '</b><span class="small muted">' + esc(sub) + '</span></button>' + (actions ? '<div class="row">' + actions + '</div>' : '') + '</li>';
      };
      body.innerHTML = '<h2>Clients</h2>' +
        '<button class="btn block" type="button" id="cNew">Start a client</button>' +
        (signedIn() ? '<h3 style="margin-top:16px">In your account</h3>' + (err ? '<p class="err">' + esc(err) + '</p>' : list === null ? '<p class="muted"><span class="spin" aria-hidden="true"></span> Loading…</p>' : list.length ? '<ul class="clist">' + list.map(function (c) {
          return item(c.id, 'account', c.label, 'Tax year ' + c.taxYear + ' · ' + plural(c.k1s, 'K-1') + ' · ' + c.checked + ' checked' + (c.missing ? ' · ' + c.missing + ' missing' : '') + (c.fails ? ' · ' + c.fails + ' to fix' : ''),
            '<button class="btn small ghost" type="button" data-dupa="' + esc(c.id) + '">Next year</button><button class="btn small ghost" type="button" data-dela="' + esc(c.id) + '">Delete</button>');
        }).join('') + '</ul><p class="small muted">' + list.length + ' of ' + C.LIMITS.clients + ' client files.</p>' : '<p class="muted">None yet.</p>') : '') +
        (locals.length ? '<h3 style="margin-top:16px">On this device</h3><ul class="clist">' + locals.map(function (c) {
          var n = (c.k1s || []).filter(function (k) { return k && k.taxYear === c.taxYear; }).length;
          return item(c.id, 'local', c.label, 'Tax year ' + c.taxYear + ' · ' + plural(n, 'K-1'), (signedIn() ? '<button class="btn small" type="button" data-up="' + esc(c.id) + '">Save to my account</button>' : '') + '<button class="btn small ghost" type="button" data-dell="' + esc(c.id) + '">Delete</button>');
        }).join('') + '</ul>' : '') +
        '<h3 style="margin-top:16px">Example</h3><ul class="clist">' + item('sample', 'sample', 'Example client - tax year ' + S.YEAR, 'Made up - 8 K-1s, 2 missing') + '</ul>' +
        (signedIn() ? '' : '<p class="small muted">Signed out, client files stay on this device. <button class="link-btn" type="button" id="cIn">Sign in (free)</button> to keep them in your account.</p>');
      $('#cNew', body).onclick = function () { closeSheet(); startClient(); };
      var ci = $('#cIn', body); if (ci) ci.onclick = function () { openAccount(null, openClients); };
      $$('[data-openf]', body).forEach(function (b) {
        b.onclick = function () {
          var p = b.getAttribute('data-openf').split(':');
          if (p[0] === 'sample') { closeSheet(); openFile(sampleFile()); return; }
          if (p[0] === 'local') { var raw = localFiles().filter(function (x) { return x.id === p[1]; })[0]; if (raw) { closeSheet(); openFile(fileFrom('local', raw, raw.id)); } return; }
          api('GET', 'api/clients/' + encodeURIComponent(p[1])).then(function (r) { closeSheet(); openFile(fileFrom('account', r.client, r.client.id)); state.saving = 'saved'; drawStrip(); }).catch(function (e) { showError(e); });
        };
      });
      $$('[data-dupa]', body).forEach(function (b) {
        b.onclick = function () { b.disabled = true; api('POST', 'api/clients/' + encodeURIComponent(b.getAttribute('data-dupa')) + '/duplicate').then(function (r) { closeSheet(); openFile(fileFrom('account', r.client, r.client.id)); state.tab = 'missing'; drawClient(); toast('Started ' + r.client.label + '.'); }).catch(function (e) { b.disabled = false; showError(e); }); };
      });
      $$('[data-dela]', body).forEach(function (b) {
        b.onclick = function () {
          if (b.getAttribute('data-sure') !== '1') { b.setAttribute('data-sure', '1'); b.textContent = 'Tap again to delete'; b.classList.add('danger'); return; }
          var id = b.getAttribute('data-dela');
          api('DELETE', 'api/clients/' + encodeURIComponent(id)).then(function () {
            if (state.file && state.file.id === id) openFile(sampleFile());
            load(root); toast('Deleted.');
          }).catch(function (e) { showError(e); });
        };
      });
      $$('[data-dell]', body).forEach(function (b) {
        b.onclick = function () {
          if (b.getAttribute('data-sure') !== '1') { b.setAttribute('data-sure', '1'); b.textContent = 'Tap again to delete'; b.classList.add('danger'); return; }
          var id = b.getAttribute('data-dell');
          writeLocal(localFiles().filter(function (x) { return x.id !== id; }), state.file && state.file.id === id ? 'sample' : undefined);
          if (state.file && state.file.id === id) openFile(sampleFile());
          draw(root, list); toast('Deleted from this device.');
        };
      });
      $$('[data-up]', body).forEach(function (b) {
        b.onclick = function () {
          var id = b.getAttribute('data-up');
          var raw = localFiles().filter(function (x) { return x.id === id; })[0];
          if (!raw) return;
          b.disabled = true;
          api('POST', 'api/clients', savedShape(fileFrom('local', raw, id))).then(function (r) {
            writeLocal(localFiles().filter(function (x) { return x.id !== id; }), r.client.id);
            if (state.file && state.file.id === id) { openFile(fileFrom('account', r.client, r.client.id)); state.saving = 'saved'; drawStrip(); }
            load(root); toast('Saved to your account.');
          }).catch(function (e) { b.disabled = false; showError(e); });
        };
      });
    };
    var load = function (root) {
      draw(root, signedIn() ? null : []);
      if (signedIn()) api('GET', 'api/clients').then(function (r) { draw(root, r.clients); }).catch(function (e) { draw(root, [], e.message); });
    };
    sheet('<div class="body"></div>', load);
  }

  /* ---------------- printing ---------------- */

  function printSummary() {
    var f = state.file;
    var b = C.board(f, TODAY);
    var ks = yearK1s();
    var rows = C.rollup(f);
    var miss = C.missing(f, TODAY).filter(function (x) { return !x.received; });
    $('#printArea').innerHTML = '<h1>' + esc(f.label) + ' - Schedule K-1 summary, tax year ' + esc(f.taxYear) + '</h1>' +
      '<p>' + esc(C.boardLine(b)) + ' · printed ' + esc(C.fmtDate(TODAY)) + '</p>' +
      '<h2>K-1s</h2><table><thead><tr><th>Partnership</th><th>EIN</th><th>Stage</th><th>Checks</th><th>Flags</th></tr></thead><tbody>' +
      ks.map(function (k) { var s = k1Summary(k); return '<tr><td>' + esc(k.p.name) + '</td><td>' + esc(C.maskEin(k.p.ein4)) + '</td><td>' + esc(C.STAGE_LABEL[k.stage]) + '</td><td>' + esc(s.fail ? s.fail + ' to fix' : s.look ? s.look + ' to look at' : 'all pass') + '</td><td>' + esc([k.final ? 'Final' : '', k.amended ? 'Amended' : '', k.p.ptp ? 'PTP' : '', k.k3 ? 'K-3' : ''].filter(Boolean).join(', ')) + '</td></tr>'; }).join('') + '</tbody></table>' +
      '<h2>Roll-up</h2><table><thead><tr><th>Line</th><th>Description</th><th class="r">Total</th><th class="r">K-1s</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + esc(r.box + (r.code ? ' ' + r.code : '')) + '</td><td>' + esc(r.label) + '</td><td class="r">' + esc(r.check ? 'Checked' : r.values ? m$(r.total) : 'See statement') + '</td><td class="r">' + r.n + '</td></tr>'; }).join('') + '</tbody></table>' +
      (miss.length ? '<h2>Still missing</h2><ul>' + miss.map(function (x) { return '<li>' + esc(x.name) + ' - expected by ' + esc(C.fmtDate(x.due)) + '</li>'; }).join('') + '</ul>' : '') +
      '<p><small>Prepared with Boxed. Boxed reads and checks K-1s; it is not tax advice, and you are responsible for what you file.</small></p>';
    window.print();
  }

  /* ---------------- sheets and the account ---------------- */

  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Account' : 'Sign in';
    b.onclick = function () { if (signedIn()) openSettings(); else openAccount(); };
    $('#clientsBtn').onclick = openClients;
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

  var FREE_LINE = 'The checks, the roll-up, what’s missing, exports and typing K-1s in are free with no account. A free account keeps client files and reads K-1s with AI - it comes with $2 of credit. One account works across every app on this site.';

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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); render(); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { render(); if (then) then(); })
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
      '<p class="small muted" style="margin:6px 0 0">Reading a K-1 costs a few cents. The checks, roll-up, exports and saving are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () {
            closeSheet(); state.me = { signedIn: false };
            if (state.file && state.file.where === 'account') openFile(sampleFile()); else render();
          });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The checks, the roll-up, what’s missing, exports and typing K-1s in keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }

  /* ---------------- start ---------------- */

  function boot() {
    var l = recall(K_LOCAL);
    var cur = l && typeof l.current === 'string' ? l.current : null;
    var raw = cur && cur !== 'sample' ? localFiles().filter(function (x) { return x.id === cur; })[0] : null;
    if (raw) { try { state.file = fileFrom('local', raw, raw.id); } catch (e) { state.file = null; } }
    if (!state.file) state.file = sampleFile();
    render();
  }

  drawTop();
  boot();
  loadMe().then(function () {
    var l = recall(K_LOCAL);
    var cur = l && typeof l.current === 'string' ? l.current : '';
    if (signedIn() && /^c[a-z0-9]{12}$/.test(cur) && state.file.where === 'sample') {
      api('GET', 'api/clients/' + cur).then(function (r) { openFile(fileFrom('account', r.client, r.client.id)); state.saving = 'saved'; drawStrip(); }).catch(function () { /* gone: stay on the example */ });
    }
    drawStrip();
    if (signedIn() && /[?&](topup|member|credited)=1\b/.test(location.search)) openSettings();
  });
})();
