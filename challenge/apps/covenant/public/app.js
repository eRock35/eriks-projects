/* Covenant - the page. One file, no build step. Every string that came from
 * outside this file (a model's reading, a saved loan, a typed name) is
 * escaped before it is drawn, and no handler is written into markup (the
 * lab's CSP allows script from this origin only). The sums are
 * covenant-core.js, the same file the server and the tests run. */
(function () {
  'use strict';

  var C = window.CovenantCore;
  var Sample = window.CovenantSample;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LAST = 'covenant-last-reading-v1';
  var K_OPEN = 'covenant-open-v1';
  var PHOTO_PX = 1600;

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  var state = {
    me: null,
    loan: null,        // {kind: 'sample'|'reading'|'saved', id, name, loan, covenants, fye, from, periods, note, unverified}
    period: null,      // the period the health check is on
    draft: {},         // {field: typed text} for that period
    allDeadlines: false,
    explainAll: false,
    open: {},          // covenant id -> {explain: bool, quote: bool}
    readTab: 'text',
    photos: [],        // [{name, type, data, url}]
    reading: false,
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // The read streams whitespace and so answers 200 even on failure; an
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
  function toast(msg, ms) {
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

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }

  /* ---------------- the loan in view ---------------- */

  function sampleLoan() {
    var cleaned = C.cleanCovenants(Sample.RAW).covenants;
    var found = C.matcher(Sample.TEXT);
    cleaned.forEach(function (c) { c.verified = found(c.quote); c.from = 'text'; });
    var periods = {};
    Object.keys(Sample.PERIODS).forEach(function (k) { periods[k] = { inputs: C.cleanInputs(Sample.PERIODS[k]) }; });
    return { kind: 'sample', name: Sample.NAME, loan: Sample.LOAN, covenants: cleaned, fye: Sample.FYE, from: 'text', periods: periods, calName: 'Riverbend Bakery loan (example)' };
  }

  function currentPeriodLabel() {
    var d = new Date();
    return d.getFullYear() + ' Q' + (Math.floor(d.getMonth() / 3) + 1);
  }

  /** Show a loan: the example, a fresh reading or a saved one. */
  function show(loan, opts) {
    state.loan = loan;
    state.open = {};
    // The example opens with one customer explanation showing, so the
    // feature lenders' staff would use is visible without a tap.
    if (loan.kind === 'sample' && loan.covenants[0]) state.open[loan.covenants[0].id] = { explain: true };
    state.allDeadlines = false;
    var keys = C.sortPeriods(Object.keys(loan.periods || {}));
    var want = opts && opts.period;
    state.period = want && loan.periods[want] ? want : (loan.kind === 'sample' ? Sample.PERIOD : (keys[keys.length - 1] || currentPeriodLabel()));
    loadDraft();
    keep(K_OPEN, loan.kind === 'saved' ? { id: loan.id } : null);
    $('#readView').hidden = true;
    $('#loanView').hidden = false;
    drawAll();
  }

  function loadDraft() {
    var saved = state.loan.periods && state.loan.periods[state.period];
    var inputs = saved ? C.cleanInputs(saved.inputs) : {};
    state.draft = {};
    C.FIELDS.forEach(function (f) { state.draft[f.key] = inputs[f.key] === null || inputs[f.key] === undefined ? '' : C.plainMoney(inputs[f.key]); });
  }

  function inputsNow() {
    var raw = {};
    Object.keys(state.draft).forEach(function (k) { raw[k] = state.draft[k]; });
    return C.cleanInputs(raw);
  }

  function drawAll() {
    // Results lead when there are numbers to judge (the example's story);
    // with none yet, the boxes to type them in come first.
    var res = $('#results'), inp = $('#inputs');
    var now = inputsNow(), any = Object.keys(now).some(function (k) { return now[k] !== null; });
    if (any) res.after(inp); else inp.after(res);
    drawIntro();
    drawHead();
    drawPeriodBar();
    drawInputs();
    drawResults();
    drawDeadlines();
    drawChecklist();
    drawGlance();
  }

  /* ---------------- first run and the head of the page ---------------- */

  function drawIntro() {
    var el = $('#intro');
    var L = state.loan;
    if (L.kind === 'sample') {
      el.innerHTML = '<p><b>This is an example loan</b> - try it, then read your own.</p>' +
        '<button class="btn big" type="button" id="introRead">Read my loan</button>';
      $('#introRead').onclick = openRead;
      return;
    }
    el.innerHTML = '';
  }

  function drawHead() {
    var L = state.loan, el = $('#loanHead');
    var badge = L.kind === 'sample' ? '<span class="badge">Example</span>' : L.kind === 'saved' ? '<span class="badge saved">Saved</span>' : '<span class="badge new">New reading · not saved</span>';
    var title = L.kind === 'saved' ? L.name : (L.loan.borrower || L.name);
    var sub = [L.loan.amount, L.loan.type].filter(Boolean).join(' · ');
    var facts = [L.loan.lender ? 'Lender <b>' + esc(L.loan.lender) + '</b>' : '', L.loan.maturity ? 'Matures <b>' + esc(L.loan.maturity) + '</b>' : '', L.kind === 'saved' && L.loan.borrower ? 'Borrower <b>' + esc(L.loan.borrower) + '</b>' : '']
      .filter(Boolean).map(function (f) { return '<li>' + f + '</li>'; }).join('');
    var bits = [];
    if (L.kind === 'reading') {
      var n = L.covenants.length, u = L.unverified || 0;
      bits.push('<div class="note reading-bar" role="status"><span class="e" aria-hidden="true">' + (L.from === 'photo' ? '📷' : '📄') + '</span><div><b>Read from your ' + (L.from === 'photo' ? 'photos' : 'text') + ': ' + n + ' covenant' + (n === 1 ? '' : 's') + '.</b> ' +
        (u ? esc(u + (u === 1 ? ' quote was' : ' quotes were') + ' not found in what you gave us - ' + (u === 1 ? 'it is' : 'they are') + ' marked below; check ' + (u === 1 ? 'it' : 'them') + ' against the agreement.') : (L.from === 'photo' ? 'Every quote was found in what we read off the pages - still check them against the pages.' : 'Every quote was found word for word in your text.')) +
        (L.note ? ' ' + esc(L.note) : '') +
        '<br><span class="small muted">The agreement itself was not kept. Saving keeps only this list and the numbers you enter.</span></div></div>');
    }
    var actions = [];
    if (L.kind === 'reading') actions.push('<button class="btn" type="button" id="saveLoan">' + (signedIn() ? 'Save this loan' : 'Sign in to save it') + '</button>');
    if (L.kind === 'saved') actions.push('<button class="btn small ghost" type="button" id="renameLoan">Rename</button>', '<button class="btn small ghost" type="button" id="deleteLoan">Delete</button>');
    if (L.kind !== 'sample') actions.push('<button class="btn small ghost" type="button" id="toSample">See the example</button>');
    if (L.kind === 'sample' && signedIn()) actions.push('<button class="btn small ghost" type="button" id="saveSample">Save a copy to try check-ins</button>');
    el.innerHTML = badge +
      '<h1 id="loanName">' + esc(title) + '</h1>' + (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') +
      (facts ? '<ul class="facts">' + facts + '</ul>' : '') +
      bits.join('') +
      (actions.length ? '<div class="head-actions">' + actions.join('') + '</div>' : '') +
      '<p class="disclaim">Not legal or financial advice - your loan agreement is what counts.</p>';
    var s = $('#saveLoan'); if (s) s.onclick = saveReading;
    var r = $('#renameLoan'); if (r) r.onclick = renameLoan;
    var d = $('#deleteLoan'); if (d) d.onclick = deleteLoan;
    var t = $('#toSample'); if (t) t.onclick = function () { show(sampleLoan()); window.scrollTo(0, 0); };
    var ss = $('#saveSample'); if (ss) ss.onclick = function () {
      ss.disabled = true;
      api('POST', 'api/loans', { sample: true }).then(function (r2) { toast('Saved a copy of the example'); openSaved(r2.loan); refreshLoansBtn(); })
        .catch(function (e) { ss.disabled = false; showError(e); });
    };
  }

  /* ---------------- at a glance ---------------- */

  function drawGlance() {
    var L = state.loan;
    var h = C.health(L.covenants, inputsNow());
    var dl = C.deadlines(L.covenants, { today: today(), fyeMonth: L.fye });
    var tiles = [];
    // Health: the worst result leads.
    var order = ['breach', 'tight', 'missing', 'cant', 'pass', 'manual'];
    var worst = h.results.slice().sort(function (a, b) { return order.indexOf(a.status) - order.indexOf(b.status); })[0];
    if (!h.results.length) {
      tiles.push(tile('health', 'info', 'Health check', 'No financial tests', 'This loan sets no ratio tests to check.'));
    } else if (worst.status === 'breach' || worst.status === 'tight') {
      var words = [];
      if (h.counts.breach) words.push(h.counts.breach + ' in breach');
      if (h.counts.tight) words.push(h.counts.tight + ' tight');
      if (h.counts.pass) words.push(h.counts.pass + ' comfortable');
      tiles.push(tile('health', worst.status, 'Health check', words.join(' · '), shortName(worst) + ' ' + worst.valueText + ' vs ' + worst.threshold.replace(/^at (least|most) /, '') + ' - ' + (worst.status === 'breach' ? 'fails the test' : shortRoom(worst))));
    } else if (worst.status === 'missing') {
      tiles.push(tile('health', 'info', 'Health check', 'Add your numbers', h.results.length + ' financial test' + (h.results.length === 1 ? '' : 's') + ' to check - it’s free.'));
    } else {
      tiles.push(tile('health', 'pass', 'Health check', h.counts.pass ? 'All ' + h.counts.pass + ' comfortable' : 'Check by hand', h.counts.pass ? 'Every test you can check has room to spare.' : 'These tests need the agreement’s own definitions.'));
    }
    if (dl.length) {
      tiles.push(tile('deadlines', dl[0].inDays <= 14 ? 'tight' : 'info', 'Next deadline', C.fmtDate(dl[0].due).replace(/, \d{4}$/, '') + ' · ' + C.inWords(dl[0].inDays).toLowerCase(), dl[0].title));
    } else {
      tiles.push(tile('deadlines', 'info', 'Deadlines', 'None dated', 'No report in this loan has a deadline we could date.'));
    }
    var byKind = {};
    L.covenants.forEach(function (c) { byKind[c.kind] = (byKind[c.kind] || 0) + 1; });
    var kindWords = { financial: ['financial test', 'financial tests'], reporting: ['report', 'reports'], negative: ['limit', 'limits'], affirmative: ['duty', 'duties'], insurance: ['insurance', 'insurance'], other: ['other', 'other'] };
    var parts = C.KINDS.filter(function (k) { return byKind[k]; }).map(function (k) { return byKind[k] + ' ' + kindWords[k][byKind[k] === 1 ? 0 : 1]; });
    var unv = L.covenants.filter(function (c) { return !c.verified; }).length;
    tiles.push(tile('checklist', unv ? 'tight' : 'info', 'Covenants', L.covenants.length + ' to keep', unv ? unv + ' to check against the agreement' : parts.join(' · ')));
    $('#glance').innerHTML = tiles.join('');
    $$('#glance .tile').forEach(function (b) {
      b.onclick = function () { var t = document.getElementById(b.getAttribute('data-to')); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
    });
  }
  function shortName(r) {
    var m = /\(([^)]+)\)$/.exec(r.name);
    return m && m[1].length <= 6 ? m[1] : r.name.replace(/ \(.*\)$/, '');
  }
  function shortRoom(r) {
    var m = /by (\$[\d,]+)/.exec(r.headroom);
    return m ? m[1] + ' of room' : 'close to the line';
  }
  function tile(to, cls, k, v, s) {
    return '<button type="button" class="tile ' + cls + '" data-to="' + to + '"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span><span class="s">' + esc(s) + '</span></button>';
  }

  /* ---------------- the health check ---------------- */

  function drawPeriodBar() {
    var L = state.loan, el = $('#periodBar');
    var keys = C.sortPeriods(Object.keys(L.periods || {}));
    var fin = L.covenants.filter(C.isChecked);
    if (!fin.length) { el.innerHTML = ''; return; }
    var opts = keys.slice();
    if (opts.indexOf(state.period) < 0) opts.push(state.period);
    opts = C.sortPeriods(opts);
    var html = '<div class="periodbar">' +
      '<label class="field"><span>Period</span><select class="input" id="periodSel">' +
      opts.slice().reverse().map(function (p) { return '<option value="' + esc(p) + '"' + (p === state.period ? ' selected' : '') + '>' + esc(periodName(p)) + (L.kind === 'saved' && !(L.periods && L.periods[p]) ? ' · not saved yet' : '') + '</option>'; }).join('') +
      (L.kind !== 'sample' ? '<option value="__new">Another period…</option>' : '') +
      '</select></label>';
    if (L.kind === 'sample') html += '<p class="hint small muted">Example numbers for a bakery. Change any of them below and watch the checks move.</p>';
    else if (L.kind === 'reading') html += '<p class="hint small muted">Enter the numbers for a period - last 12 months works for most tests. Saving the loan keeps them.</p>';
    html += '</div>';
    el.innerHTML = html;
    $('#periodSel').onchange = function (e) {
      if (e.target.value === '__new') return pickPeriod();
      state.period = e.target.value; loadDraft(); drawPeriodBar(); drawInputs(); drawResults(); drawGlance(); drawChecklist();
    };
  }
  function periodName(p) {
    var m = /^(\d{4}) (Q[1-4]|FY)$/.exec(p);
    if (!m) return p;
    return m[2] === 'FY' ? 'Fiscal year ' + m[1] : m[1] + ' ' + m[2] + ' (last 12 months)';
  }

  function pickPeriod() {
    var y = new Date().getFullYear();
    var years = [y + 1, y, y - 1, y - 2, y - 3, y - 4];
    sheet('<h2>Add a period</h2><p class="muted small">Lenders test most ratios on a year of numbers: the fiscal year, or the last 12 months to a quarter end.</p>' +
      '<div class="row"><label class="field" style="flex:1"><span>Year</span><select class="input" id="pY">' + years.map(function (v) { return '<option' + (v === y ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></label>' +
      '<label class="field" style="flex:1"><span>Period</span><select class="input" id="pQ"><option value="Q1">Q1</option><option value="Q2">Q2</option><option value="Q3">Q3</option><option value="Q4">Q4</option><option value="FY">Full fiscal year</option></select></label></div>' +
      '<button class="btn block" type="button" id="pOk">Use this period</button>', function (root) {
      $('#pQ', root).value = 'Q' + (Math.floor(new Date().getMonth() / 3) + 1);
      $('#pOk', root).onclick = function () {
        var p = C.cleanPeriod($('#pY', root).value + ' ' + $('#pQ', root).value);
        closeSheet();
        if (!p) return;
        state.period = p; loadDraft(); drawPeriodBar(); drawInputs(); drawResults(); drawGlance(); drawChecklist();
      };
    });
    drawPeriodBar();
  }

  function drawInputs() {
    var L = state.loan, el = $('#inputs');
    var keys = C.fieldsFor(L.covenants);
    if (!keys.length) {
      el.innerHTML = '<p class="muted small" style="grid-column:1/-1">This loan has no financial tests Covenant can work out. Any it has are listed under “Every covenant” to check by hand.</p>';
      $('#health .saverow') && $('#health .saverow').remove();
      return;
    }
    el.innerHTML = '<h3 class="subhead" style="grid-column:1/-1">' + esc(L.kind === 'sample' ? 'The bakery’s numbers - try changing them' : 'Your numbers for ' + periodName(state.period)) + '</h3>' + keys.map(function (k) {
      var f = C.FIELD[k];
      return '<label class="field" data-field="' + k + '"><span>' + esc(f.label) + '</span><span class="money"><input class="input" inputmode="decimal" autocomplete="off" id="in-' + k + '" value="' + esc(state.draft[k] || '') + '" placeholder="0" aria-describedby="hint-' + k + '"></span><span class="hint" id="hint-' + k + '">' + esc(f.hint) + '</span></label>';
    }).join('');
    keys.forEach(function (k) {
      var input = $('#in-' + k);
      input.oninput = function () {
        state.draft[k] = input.value;
        var bad = input.value.trim() !== '' && C.toCents(input.value, C.FIELD[k].negative) === null;
        input.closest('.field').classList.toggle('bad', bad);
        input.setAttribute('aria-invalid', bad ? 'true' : 'false');
        drawResults(); drawGlance(); drawChips(); drawSaveRow();
      };
      input.onblur = function () {
        var c = C.toCents(input.value, C.FIELD[k].negative);
        if (c !== null) { input.value = C.plainMoney(c); state.draft[k] = input.value; }
      };
    });
    drawSaveRow();
  }

  function drawSaveRow() {
    var L = state.loan;
    var row = $('#health .saverow');
    if (L.kind !== 'saved') { if (row) row.remove(); return; }
    if (!row) { row = document.createElement('div'); row.className = 'saverow'; $('#inputs').after(row); }
    var saved = L.periods[state.period];
    var now = inputsNow(), dirty = !saved;
    if (saved) {
      var s = C.cleanInputs(saved.inputs);
      C.fieldsFor(L.covenants).forEach(function (k) { if (s[k] !== now[k]) dirty = true; });
    }
    row.innerHTML = '<button class="btn" type="button" id="savePeriod"' + (dirty ? '' : ' disabled') + '>' + (dirty ? 'Save numbers for ' + esc(state.period) : 'Saved for ' + esc(state.period)) + '</button>' +
      (saved ? '<button class="btn small ghost" type="button" id="dropPeriod">Delete this period</button>' : '');
    $('#savePeriod').onclick = savePeriod;
    var d = $('#dropPeriod'); if (d) d.onclick = dropPeriod;
  }

  function drawResults() {
    var L = state.loan, el = $('#results');
    var fin = L.covenants.filter(function (c) { return c.kind === 'financial'; });
    if (!fin.length) { el.innerHTML = ''; return; }
    var inputs = inputsNow();
    el.innerHTML = fin.map(function (c) {
      var r = C.evaluate(c, inputs);
      var hist = C.history(c, L.periods || {});
      var st = r.status;
      var html = '<article class="res ' + st + '" aria-label="' + esc(r.name + ': ' + C.STATUS_LABEL[st]) + '">' +
        '<div class="res-top"><div><h3>' + esc(r.name) + '</h3><span class="sec">' + esc(c.section ? '§ ' + c.section : '') + (c.testedWhen ? (c.section ? ' · ' : '') + esc(C.TESTED_LABEL[c.testedWhen]) : '') + '</span></div>' +
        '<span class="pill ' + st + '">' + esc(C.STATUS_LABEL[st]) + '</span></div>';
      if (r.valueText) html += '<div class="bigrow"><span class="big">' + esc(r.valueText) + '</span><span class="vs">needs ' + esc(r.threshold) + '</span></div>' + gauge(r);
      else if (r.threshold) html += '<div class="bigrow"><span class="vs">Needs ' + esc(r.threshold) + '</span></div>';
      html += '<p class="room">' + esc(r.headroom) + '</p>';
      if (r.also) html += '<p class="also">' + esc(r.also) + '</p>';
      if (hist.length >= 2) html += spark(hist, c);
      if (r.formula || r.definition) {
        html += '<details class="how"><summary>How we worked this out</summary>' +
          (r.formula ? '<p>' + esc(r.formula) + (r.status === 'tight' ? ' “Tight” means within 10% of the line.' : '') + '</p>' : '') +
          (r.definition ? '<p class="def"><b>Your agreement defines it:</b> ' + esc(r.definition) + '</p>' : '') +
          '<p class="small muted">The agreement’s own definitions govern. If it counts EBITDA or debt differently from your books, use its way.</p></details>';
      }
      return html + '</article>';
    }).join('');
  }

  function gauge(r) {
    if (!r.gauge) return '';
    var g = r.gauge, v = Math.max(0, g.value), t = g.threshold;
    var top = Math.max(v, t) * 1.35 || 1;
    var fill = Math.min(100, (v / top) * 100), mark = Math.min(100, (t / top) * 100);
    var fmt = function (n) { return r.valueText.indexOf('$') >= 0 ? C.money(Math.round(n), true) : C.trimNum(n) + 'x'; };
    return '<div class="gauge ' + r.status + '" aria-hidden="true"><div class="fill" style="width:' + fill.toFixed(1) + '%"></div><div class="mark" style="left:calc(' + mark.toFixed(1) + '% - 1px)"></div></div>' +
      '<div class="gauge-scale" aria-hidden="true"><span>0</span><span>line at ' + esc(fmt(t)) + '</span></div>';
  }

  /** A small line of the covenant's value over saved periods, with the
   *  threshold dashed. Only numbers go into the SVG. */
  function spark(hist, c) {
    var W = 300, H = 56, pad = 6;
    var vals = hist.map(function (h) { return h.value; });
    var t = c.threshold ? (c.threshold.unit === '$' ? c.threshold.value * 100 : c.threshold.unit === '%' ? c.threshold.value / 100 : c.threshold.value) : null;
    var all = t === null ? vals : vals.concat([t]);
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi === lo) { hi += 1; lo -= 1; }
    var span = hi - lo; lo -= span * 0.12; hi += span * 0.12;
    var x = function (i) { return pad + (i * (W - 2 * pad)) / Math.max(1, hist.length - 1); };
    var y = function (v) { return pad + (H - 2 * pad) * (1 - (v - lo) / (hi - lo)); };
    var pts = hist.map(function (h, i) { return x(i).toFixed(1) + ',' + y(h.value).toFixed(1); }).join(' ');
    var label = (c.metric ? C.METRIC_DEF[c.metric].name : c.title) + ' over ' + hist.length + ' periods: ' + hist.map(function (h) { return h.period + ' ' + h.text; }).join(', ');
    return '<div class="spark"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '">' +
      (t !== null ? '<line class="thr" x1="0" x2="' + W + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '"/>' : '') +
      '<polyline class="line" points="' + pts + '"/>' +
      hist.map(function (h, i) { return '<circle class="dot' + (i === hist.length - 1 ? ' last' : '') + '" cx="' + x(i).toFixed(1) + '" cy="' + y(h.value).toFixed(1) + '" r="3.5"/>'; }).join('') +
      '</svg><div class="spark-labels"><span>' + esc(hist[0].period + ' · ' + hist[0].text) + '</span><span>' + esc(hist[hist.length - 1].period + ' · ' + hist[hist.length - 1].text) + '</span></div>' +
      (t !== null ? '<div class="spark-key" aria-hidden="true">Dashed line: the ' + esc(c.threshold.unit === '$' ? C.money(Math.round(t), true) : C.trimNum(t) + 'x') + ' limit</div>' : '') + '</div>';
  }

  /* ---------------- deadlines ---------------- */

  function drawDeadlines() {
    var L = state.loan;
    var sel = $('#fye');
    sel.innerHTML = C.MONTHS_LONG.map(function (m, i) { return '<option value="' + (i + 1) + '"' + (i + 1 === L.fye ? ' selected' : '') + '>' + m + '</option>'; }).join('');
    sel.onchange = function () { changeFye(Number(sel.value)); };
    var items = C.deadlines(L.covenants, { today: today(), fyeMonth: L.fye });
    var el = $('#deadList');
    if (!items.length) {
      var undated = L.covenants.filter(function (c) { return c.kind === 'reporting'; });
      el.innerHTML = '<p class="muted">' + (undated.length ? 'This loan’s reports don’t say when they are due in a way we could date. They are listed under “Every covenant”.' : 'No reports with deadlines were found in this loan.') + '</p>';
      return;
    }
    var rows = state.allDeadlines ? items.map(function (it) { return { next: it, later: [] }; }) : C.nextEach(items);
    var short = function (d) { return C.fmtDate(d).replace(/, \d{4}$/, ''); };
    el.innerHTML = '<ul class="dl">' + rows.map(function (row) {
      var it = row.next, d = it.due;
      var then = row.later.length ? '<div class="then">Then ' + esc(row.later.slice(0, 3).map(short).join(', ')) + (row.later.length > 3 ? ' and ' + (row.later.length - 3) + ' more' : '') + '</div>' : '';
      return '<li><span class="date" aria-hidden="true"><span class="m">' + esc(C.fmtDate(d).slice(0, 3)) + '</span><span class="d">' + Number(d.slice(8, 10)) + '</span><span class="y">' + esc(d.slice(0, 4)) + '</span></span>' +
        '<div><div class="t">' + esc(it.title) + ' <span class="when' + (it.inDays <= 14 ? ' soon' : '') + '">' + esc(C.inWords(it.inDays)) + '</span></div>' +
        '<div class="r"><span class="vh">Due ' + esc(C.fmtDate(d)) + '. </span>' + esc(it.rule) + (it.section ? ' · § ' + esc(it.section) : '') + '</div>' + then + '</div></li>';
    }).join('') + '</ul>' +
      '<div class="dl-actions"><button class="btn" type="button" id="icsBtn">Add all ' + items.length + ' dates to my calendar</button>' +
      (rows.length < items.length || state.allDeadlines ? '<button class="btn small ghost" type="button" id="moreDl">' + (state.allDeadlines ? 'Next of each only' : 'Every date (' + items.length + ')') + '</button>' : '') + '</div>' +
      '<p class="small muted">The next 12 months, worked out from your fiscal year end. The calendar file has a reminder a week before each. Your agreement is what counts - check the dates there.</p>';
    $('#icsBtn').onclick = function () { downloadIcs(items); };
    var more = $('#moreDl'); if (more) more.onclick = function () { state.allDeadlines = !state.allDeadlines; drawDeadlines(); };
  }

  function downloadIcs(items) {
    var L = state.loan;
    var name = L.calName || L.name;
    var text = C.ics(items, { name: name, loanKey: L.id || L.name, now: new Date().toISOString() });
    var blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = C.icsFilename(L.kind === 'sample' ? 'riverbend-example' : name);
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Calendar file ready - open it to add the dates');
  }

  function changeFye(m) {
    var L = state.loan;
    L.fye = C.cleanFye(m);
    drawDeadlines(); drawGlance();
    if (L.kind === 'saved') api('PATCH', 'api/loans/' + encodeURIComponent(L.id), { fye: L.fye }).then(function () { toast('Fiscal year end saved'); }).catch(function (e) { showError(e); });
    if (L.kind === 'reading') keepReading();
  }

  /* ---------------- the checklist ---------------- */

  function drawChecklist() {
    var L = state.loan;
    $('#checkH').textContent = 'Every covenant (' + L.covenants.length + ')';
    var btn = $('#explainAll');
    btn.setAttribute('aria-pressed', state.explainAll ? 'true' : 'false');
    btn.textContent = state.explainAll ? 'Hide customer explanations' : 'Show customer explanations';
    btn.onclick = function () { state.explainAll = !state.explainAll; state.open = {}; drawChecklist(); };
    var inputs = inputsNow();
    $('#groups').innerHTML = C.KINDS.map(function (k) {
      var list = L.covenants.filter(function (c) { return c.kind === k; });
      if (!list.length) return '';
      return '<div class="group"><h3>' + esc(C.KIND_LABEL[k]) + '</h3>' + list.map(function (c) { return card(c, inputs); }).join('') + '</div>';
    }).join('');
    $$('#groups [data-explain]').forEach(function (b) {
      b.onclick = function () { var id = b.getAttribute('data-explain'); var o = state.open[id] || {}; o.explain = !isOpen(id, 'explain'); state.open[id] = o; redrawCard(id); };
    });
    $$('#groups [data-quote]').forEach(function (b) {
      b.onclick = function () { var id = b.getAttribute('data-quote'); var o = state.open[id] || {}; o.quote = !isOpen(id, 'quote'); state.open[id] = o; redrawCard(id); };
    });
    $$('#groups [data-copy]').forEach(function (b) {
      b.onclick = function () { var c = byId(b.getAttribute('data-copy')); if (c) copy(c.explainToCustomer, 'Explanation copied'); };
    });
  }
  function isOpen(id, what) {
    var o = state.open[id];
    if (o && o[what] !== undefined) return o[what];
    return what === 'explain' ? state.explainAll : false;
  }
  function byId(id) { return state.loan.covenants.filter(function (c) { return c.id === id; })[0] || null; }
  function redrawCard(id) {
    var c = byId(id), el = document.getElementById('cov-' + id);
    if (!c || !el) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = card(c, inputsNow());
    var fresh = wrap.firstChild;
    el.replaceWith(fresh);
    $$('[data-explain]', fresh).forEach(function (b) { b.onclick = function () { var o = state.open[id] || {}; o.explain = !isOpen(id, 'explain'); state.open[id] = o; redrawCard(id); var t = document.querySelector('#cov-' + id + ' [data-explain]'); if (t) t.focus(); }; });
    $$('[data-quote]', fresh).forEach(function (b) { b.onclick = function () { var o = state.open[id] || {}; o.quote = !isOpen(id, 'quote'); state.open[id] = o; redrawCard(id); var t = document.querySelector('#cov-' + id + ' [data-quote]'); if (t) t.focus(); }; });
    $$('[data-copy]', fresh).forEach(function (b) { b.onclick = function () { copy(c.explainToCustomer, 'Explanation copied'); }; });
  }
  /** Just the status chips on financial cards, while numbers are typed. */
  function drawChips() {
    var inputs = inputsNow();
    state.loan.covenants.forEach(function (c) {
      if (!C.isChecked(c)) return;
      var el = document.querySelector('#cov-' + c.id + ' .pill');
      if (!el) return;
      var r = C.evaluate(c, inputs);
      el.className = 'pill ' + r.status;
      el.textContent = C.STATUS_LABEL[r.status] + (r.valueText ? ' · ' + r.valueText : '');
    });
  }

  function card(c, inputs) {
    var chips = [];
    if (c.threshold) chips.push('<span class="tag num">' + esc(C.chipText(c)) + '</span>');
    if (c.testedWhen) chips.push('<span class="tag">' + esc(C.TESTED_LABEL[c.testedWhen]) + '</span>');
    if (c.dueRule) chips.push('<span class="tag">Due ' + esc(c.dueRule.daysAfter + ' days after ' + { fiscal_year_end: 'year end', quarter_end: 'quarter end', month_end: 'month end' }[c.dueRule.of]) + '</span>');
    if (C.isChecked(c)) {
      var r = C.evaluate(c, inputs);
      chips.push('<span class="pill ' + r.status + '">' + esc(C.STATUS_LABEL[r.status] + (r.valueText ? ' · ' + r.valueText : '')) + '</span>');
    }
    var flags = '';
    if (!c.verified) {
      flags += '<div class="flag" role="note"><span aria-hidden="true">⚠️</span><span><b>Not found in your ' + (c.from === 'photo' ? 'pages' : 'text') + '.</b> We couldn’t find these words in what you gave us, so this one may be misread. Check it against the agreement before relying on it.</span></div>';
    } else if (c.from === 'photo') {
      flags += '<div class="flag" role="note"><span aria-hidden="true">📷</span><span><b>Read from a photo</b> - check it against the page.</span></div>';
    }
    if (c.confidence === 'low' && c.verified) flags += '<div class="flag" role="note"><span aria-hidden="true">🔍</span><span><b>Low confidence.</b> The reading was unsure about this one - check the numbers and dates.</span></div>';
    var ex = isOpen(c.id, 'explain'), qo = isOpen(c.id, 'quote');
    var html = '<article class="cov" id="cov-' + esc(c.id) + '">' +
      '<div class="cov-top"><h4>' + esc(c.title) + '</h4>' + (c.section ? '<span class="sect">§ ' + esc(c.section) + '</span>' : '') + '</div>' +
      (chips.length ? '<div class="chips">' + chips.join('') + '</div>' : '') +
      (c.plain ? '<p>' + esc(c.plain) + '</p>' : '') + flags +
      '<div class="cov-actions">' +
      (c.explainToCustomer ? '<button class="toggle" type="button" data-explain="' + esc(c.id) + '" aria-expanded="' + ex + '" aria-controls="ex-' + esc(c.id) + '">Explain it to a customer</button>' : '') +
      (c.quote ? '<button class="toggle" type="button" data-quote="' + esc(c.id) + '" aria-expanded="' + qo + '" aria-controls="q-' + esc(c.id) + '">Exact wording</button>' : '') +
      '</div>';
    if (c.explainToCustomer && ex) {
      html += '<div class="explain" id="ex-' + esc(c.id) + '"><div class="who">What to tell the customer</div><p>' + esc(c.explainToCustomer) + '</p>' +
        '<button class="btn small" type="button" data-copy="' + esc(c.id) + '">Copy</button></div>';
    }
    if (c.quote && qo) {
      html += '<blockquote class="quote" id="q-' + esc(c.id) + '">“' + esc(c.quote) + '”<cite>' + (c.section ? 'Section ' + esc(c.section) + ' · ' : '') + (c.verified ? (c.from === 'photo' ? 'as read from your photo' : 'found word for word in your text') : 'not found in what you gave us') + '</cite></blockquote>' +
        (c.definitionNotes && c.kind !== 'financial' ? '<p class="small muted">' + esc(c.definitionNotes) + '</p>' : '');
    }
    return html + '</article>';
  }

  /* ---------------- reading your own loan ---------------- */

  function openRead() {
    $('#loanView').hidden = true;
    $('#readView').hidden = false;
    drawReadActions();
    window.scrollTo(0, 0);
    setTimeout(function () { var t = state.readTab === 'text' ? $('#agreement') : $('#tab-photos'); try { t.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 50);
  }
  function closeRead() {
    $('#readView').hidden = true;
    $('#loanView').hidden = false;
  }

  function setTab(tab) {
    state.readTab = tab;
    $$('[role=tab]').forEach(function (b) {
      var on = b.getAttribute('data-tab') === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    $('#panel-text').hidden = tab !== 'text';
    $('#panel-photos').hidden = tab !== 'photos';
    drawReadActions();
  }

  function drawCount() {
    var n = $('#agreement').value.length;
    $('#count').textContent = n.toLocaleString('en-US') + ' character' + (n === 1 ? '' : 's');
  }

  function drawThumbs() {
    $('#thumbs').innerHTML = state.photos.map(function (p, i) {
      return '<figure><img src="' + esc(p.url) + '" alt="Page ' + (i + 1) + '"><button type="button" data-rm="' + i + '" aria-label="Remove page ' + (i + 1) + '">×</button><figcaption>Page ' + (i + 1) + '</figcaption></figure>';
    }).join('');
    $$('#thumbs [data-rm]').forEach(function (b) {
      b.onclick = function () { var i = Number(b.getAttribute('data-rm')); URL.revokeObjectURL(state.photos[i].url); state.photos.splice(i, 1); drawThumbs(); drawReadActions(); };
    });
  }

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, PHOTO_PX / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        var data = cv.toDataURL('image/jpeg', 0.82);
        resolve({ name: file.name, type: 'image/jpeg', data: data.slice(data.indexOf(',') + 1), url: url });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('“' + file.name + '” could not be opened. Try a JPEG or PNG photo.')); };
      img.src = url;
    });
  }

  function addPhotos(files) {
    var room = C.LIMITS.photos - state.photos.length;
    var list = Array.prototype.slice.call(files || []).slice(0, Math.max(0, room));
    if (files && files.length > room) toast('Up to ' + C.LIMITS.photos + ' pages at a time.');
    var chain = Promise.resolve();
    list.forEach(function (f) {
      chain = chain.then(function () { return shrink(f); }).then(function (p) { state.photos.push(p); drawThumbs(); drawReadActions(); })
        .catch(function (e) { toast(e.message, 4000); });
    });
  }

  function drawReadActions() {
    var el = $('#readActions');
    var ready = state.readTab === 'text' ? $('#agreement').value.trim().length >= C.LIMITS.minText : state.photos.length > 0;
    if (state.reading) { el.innerHTML = ''; return; }
    if (!signedIn()) {
      el.innerHTML = '<button class="btn big" type="button" id="goRead">Sign in to read it</button><span class="small muted">Free account · $2 of AI credit to start</span>';
      $('#goRead').onclick = function () { openAccount('Reading your loan uses AI, so it needs a free account - it comes with $2 of credit, enough for many readings. The example, the health check and the deadlines stay free without one.'); };
      return;
    }
    el.innerHTML = '<button class="btn big" type="button" id="goRead"' + (ready ? '' : ' disabled') + '>Read my loan</button>' +
      (ready ? '' : '<span class="small muted">' + (state.readTab === 'text' ? 'Paste at least ' + C.LIMITS.minText + ' characters' : 'Add a photo of at least one page') + '</span>');
    $('#goRead').onclick = doRead;
  }

  function doRead() {
    var out = $('#readOut');
    var body;
    if (state.readTab === 'text') body = { text: $('#agreement').value };
    else body = { photos: state.photos.map(function (p) { return { type: p.type, data: p.data }; }) };
    state.reading = true; drawReadActions();
    out.innerHTML = '<p class="busy">Reading your ' + (body.photos ? body.photos.length + ' page' + (body.photos.length === 1 ? '' : 's') : 'agreement') + '… a long agreement takes a minute or two. Keep this page open.</p>';
    api('POST', 'api/read', body).then(function (r) {
      state.reading = false;
      out.innerHTML = '';
      var rd = r.reading;
      var L = { kind: 'reading', name: defaultName(rd.loan), loan: rd.loan, covenants: rd.covenants, fye: 12, from: rd.from, periods: {}, note: rd.note, unverified: rd.unverified };
      keep(K_LAST, { loan: L, at: new Date().toISOString() });
      show(L);
      window.scrollTo(0, 0);
      loadMe();
    }).catch(function (e) {
      state.reading = false; drawReadActions();
      if (e.status === 401 || e.status === 402) { out.innerHTML = ''; return showError(e); }
      if (e.data && e.data.code === 'verify-email') {
        out.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then come back and press Read again. Nothing you pasted is lost.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
        $('#resend').onclick = function () {
          var b = this; b.disabled = true;
          fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
        };
        return;
      }
      out.innerHTML = '<div class="note" role="alert"><p class="err" style="margin:0">' + esc(e.message) + '</p></div>';
    });
  }
  function defaultName(loan) {
    var who = loan.borrower || 'My business';
    return (who + (loan.lender ? ' · ' + loan.lender : '')).slice(0, 80);
  }
  function keepReading() {
    if (state.loan && state.loan.kind === 'reading') keep(K_LAST, { loan: state.loan, at: new Date().toISOString() });
  }

  /* ---------------- saving and saved loans ---------------- */

  function saveReading() {
    if (!signedIn()) return openAccount('Sign in to save this loan and come back each quarter. Only the list of covenants and your numbers are kept - never the agreement.');
    var L = state.loan, btn = $('#saveLoan');
    btn.disabled = true;
    var inputs = inputsNow(), any = Object.keys(inputs).some(function (k) { return inputs[k] !== null; });
    api('POST', 'api/loans', { name: L.name, loan: L.loan, covenants: L.covenants, fye: L.fye, from: L.from, period: any ? state.period : null, inputs: any ? inputs : null })
      .then(function (r) { keep(K_LAST, null); toast('Saved'); openSaved(r.loan); refreshLoansBtn(); })
      .catch(function (e) { btn.disabled = false; showError(e); });
  }

  function openSaved(loan, period) {
    show({ kind: 'saved', id: loan.id, name: loan.name, loan: loan.loan, covenants: loan.covenants, fye: loan.fye, from: loan.from, periods: loan.periods }, { period: period });
  }

  function savePeriod() {
    var L = state.loan, btn = $('#savePeriod');
    btn.disabled = true;
    api('PUT', 'api/loans/' + encodeURIComponent(L.id) + '/periods/' + encodeURIComponent(state.period), { inputs: inputsNow() })
      .then(function (r) { toast('Saved ' + state.period); L.periods = r.loan.periods; drawPeriodBar(); drawSaveRow(); drawResults(); })
      .catch(function (e) { btn.disabled = false; showError(e); });
  }
  function dropPeriod() {
    var L = state.loan;
    if (!confirm('Delete the numbers saved for ' + state.period + '?')) return;
    api('DELETE', 'api/loans/' + encodeURIComponent(L.id) + '/periods/' + encodeURIComponent(state.period))
      .then(function (r) { toast('Deleted'); L.periods = r.loan.periods; var keys = C.sortPeriods(Object.keys(L.periods)); state.period = keys[keys.length - 1] || currentPeriodLabel(); loadDraft(); drawPeriodBar(); drawInputs(); drawResults(); drawGlance(); drawChecklist(); })
      .catch(function (e) { showError(e); });
  }
  function renameLoan() {
    var L = state.loan;
    sheet('<h2>Rename this loan</h2><label class="field"><span>Name</span><input class="input" id="nm" maxlength="80" value="' + esc(L.name) + '"></label><div id="nmErr"></div><button class="btn block" type="button" id="nmOk">Save</button>', function (root) {
      $('#nmOk', root).onclick = function () {
        api('PATCH', 'api/loans/' + encodeURIComponent(L.id), { name: $('#nm', root).value })
          .then(function (r) { L.name = r.loan.name; closeSheet(); drawHead(); toast('Renamed'); })
          .catch(function (e) { showError(e, $('#nmErr', root)); });
      };
    });
  }
  function deleteLoan() {
    var L = state.loan;
    if (!confirm('Delete “' + L.name + '” and every period saved for it? This cannot be undone.')) return;
    api('DELETE', 'api/loans/' + encodeURIComponent(L.id)).then(function () { toast('Deleted'); show(sampleLoan()); refreshLoansBtn(); }).catch(function (e) { showError(e); });
  }

  function openLoans() {
    var last = recall(K_LAST);
    sheet('<h2>My loans</h2><div id="loanList"><p class="busy">Loading…</p></div>', function (root) {
      api('GET', 'api/loans').then(function (r) {
        var rows = [];
        if (last && last.loan) rows.push('<li><span><span class="nm">' + esc(last.loan.name) + '</span><br><span class="small muted">Last reading · not saved yet</span></span><button class="btn small" type="button" data-last="1">Open</button></li>');
        r.loans.forEach(function (l) {
          rows.push('<li><span><span class="nm">' + esc(l.name) + '</span><br><span class="small muted">' + l.covenants + ' covenant' + (l.covenants === 1 ? '' : 's') + (l.latest ? ' · latest ' + esc(l.latest) : ' · no numbers yet') + '</span></span><button class="btn small" type="button" data-open="' + esc(l.id) + '">Open</button></li>');
        });
        rows.push('<li><span><span class="nm">The example loan</span><br><span class="small muted">Riverbend Bakery · always here</span></span><button class="btn small ghost" type="button" data-sample="1">Open</button></li>');
        $('#loanList', root).innerHTML = '<ul class="loans">' + rows.join('') + '</ul>' +
          '<p class="small muted">' + r.loans.length + ' of ' + C.LIMITS.loans + ' saved. A saved loan keeps its covenant list and your numbers - never the agreement.</p>' +
          '<button class="btn block" type="button" id="newRead">Read another loan</button>';
        $$('[data-open]', root).forEach(function (b) {
          b.onclick = function () { api('GET', 'api/loans/' + encodeURIComponent(b.getAttribute('data-open'))).then(function (x) { closeSheet(); openSaved(x.loan); window.scrollTo(0, 0); }).catch(function (e) { showError(e); }); };
        });
        var lb = $('[data-last]', root); if (lb) lb.onclick = function () { closeSheet(); show(last.loan); window.scrollTo(0, 0); };
        $('[data-sample]', root).onclick = function () { closeSheet(); show(sampleLoan()); window.scrollTo(0, 0); };
        $('#newRead', root).onclick = function () { closeSheet(); openRead(); };
      }).catch(function (e) { showError(e, $('#loanList', root)); });
    });
  }
  function refreshLoansBtn() { $('#loansBtn').hidden = !signedIn(); }

  /* ---------------- account ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Account' : 'Sign in';
    b.onclick = function () { if (signedIn()) openSettings(); else openAccount(); };
    $('#loansBtn').onclick = openLoans;
    refreshLoansBtn();
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
    var f = s.querySelector('input, select, button:not(.close)') || $('#sheetClose');
    setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  var FREE_LINE = 'The example, the health check, the deadlines and the calendar file are free and need no account. Reading your own loan uses AI, so it needs a free account - it comes with $2 of credit. One account works across every app on this site.';

  function openAccount(reason) {
    var mode = 'register';
    function draw(root) {
      root.querySelector('.body').innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted" style="text-align:center;margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).onclick = function () { mode = mode === 'register' ? 'login' : 'register'; draw(root); };
      $('#authForm', root).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); afterSignIn(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(afterSignIn)
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      };
    }
    sheet('<div class="body"></div>', draw);
  }
  function afterSignIn() {
    drawReadActions();
    if (state.loan) drawHead();
  }

  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(
      '<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div>' +
      '<p class="small muted" style="margin:6px 0 0">Reading a loan usually costs a few cents; a long one or several photos can reach 10¢. The health check, deadlines and calendar are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); if (state.loan.kind === 'saved') show(sampleLoan()); else afterSignIn(); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The example, the health check, the deadlines and your saved loans keep working, free.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring ---------------- */

  $$('[role=tab]').forEach(function (b, i, all) {
    b.onclick = function () { setTab(b.getAttribute('data-tab')); };
    b.onkeydown = function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var n = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      setTab(n.getAttribute('data-tab')); n.focus();
    };
  });
  $('#agreement').oninput = function () { drawCount(); drawReadActions(); };
  $('#useSample').onclick = function () { $('#agreement').value = Sample.TEXT; drawCount(); drawReadActions(); };
  $('#photos').onchange = function (e) { addPhotos(e.target.files); e.target.value = ''; };
  var drop = $('#drop');
  drop.addEventListener('dragover', function (e) { e.preventDefault(); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); addPhotos(e.dataTransfer.files); });
  $('#readBack').onclick = function () { closeRead(); window.scrollTo(0, 0); };

  show(sampleLoan());
  drawTop();
  loadMe().then(function () {
    afterSignIn();
    var open = recall(K_OPEN);
    if (signedIn() && open && open.id) {
      api('GET', 'api/loans/' + encodeURIComponent(open.id)).then(function (r) { openSaved(r.loan); }).catch(function () { keep(K_OPEN, null); });
    }
    if (/[?&]read=1\b/.test(location.search)) openRead();
  });
})();
