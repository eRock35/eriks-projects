/* Parity - the page. One file, no build step.
 *
 * THE DATA IS READ HERE, IN THIS BROWSER, AND NOWHERE ELSE. Files go to a Web
 * Worker (parse-worker.js) that streams them; this page only ever holds
 * column profiles, a few preview rows and the findings. The one request that
 * carries anything about the tables is "Suggest the mapping and rules", and
 * it sends ParityCore.modelSummary - column names, types and counts, shown to
 * the person in full before it is sent.
 *
 * Every string that came from a file (a column name, a value) or from the
 * server is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.ParityCore;
  var D = window.ParityDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_RECIPE = 'parity-recipe-v1';
  var esc = C.esc, fmt = C.fmtInt, plural = C.plural;
  var TABS = [['files', '📂', 'Files'], ['map', '🔗', 'Map'], ['verdict', '✅', 'Verdict'], ['fingerprint', '🔏', 'Fingerprint'], ['report', '📤', 'Report']];
  var SIDES = ['before', 'after'];
  var CONF = { exact: ['Same name', 'c-exact'], likely: ['Likely', 'c-likely'], guess: ['Check this', 'c-guess'], ai: ['AI suggestion', 'c-ai'], yours: ['Yours', 'c-yours'], recipe: ['From recipe', 'c-yours'] };

  var state = {
    me: null,
    view: 'start',          // start | app
    tab: 'files',
    source: null,           // demo | files
    sides: { before: null, after: null },     // what the worker read: profile, preview, issues
    loading: { before: null, after: null },   // {done, total, rows}
    opts: { before: { header: 'auto', emptyNull: false }, after: { header: 'auto', emptyNull: false } },
    other: null,            // the other machine's side: {side, columns, from, name}
    recipe: null,           // {pairs: [...], key: [...]}
    learnNote: null,
    result: null,
    stale: false,
    busy: null,             // {label, done, total}
    aggView: 'like',
    open: {},               // finding index -> open
    summaryOnly: false,
    fp: { pass: '', show: false, includeValues: false, includeKeys: false, made: { before: null, after: null }, imported: [], cmp: null, lists: { before: null, after: null }, local: { before: {}, after: {} }, rowCmp: null, err: '' },
    offline: false,
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
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
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  var toastTimer = null;
  function toast(msg, ms) {
    $$('.toast').forEach(function (t) { t.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function download(name, type, text) {
    var blob = text instanceof Blob ? text : new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function stamp() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function slug() { var s = state.sides.before || state.sides.after; return 'parity-' + (s ? s.name.replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) : 'check') + '-' + stamp(); }
  function readJsonFile(file) {
    return file.text().then(function (t) { if (t.length > 8 * 1024 * 1024) throw new Error('That file is too big to be a Parity file.'); return JSON.parse(t); });
  }

  /* ---------------- the worker ---------------- */

  var worker = null, jobs = {}, nextId = 1;
  function startWorker() {
    worker = new Worker('parse-worker.js');
    worker.addEventListener('message', function (e) {
      var m = e.data || {};
      if (m.op === 'progress') return onProgress(m);
      var j = jobs[m.id];
      if (!j) return;
      delete jobs[m.id];
      if (m.op === 'done') j.resolve(m.result);
      else if (m.op === 'cancelled') j.reject(Object.assign(new Error('Stopped.'), { cancelled: true }));
      else j.reject(new Error(m.message || 'Something went wrong in the reader.'));
    });
    worker.addEventListener('error', function () { toast('The reader stopped. Reload the page to start again.', 5000); });
  }
  function run(op, payload) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      jobs[id] = { resolve: resolve, reject: reject };
      worker.postMessage(Object.assign({ op: op, id: id }, payload || {}));
    });
  }
  var PHASE = { reading: 'Reading', hashing: 'Hashing', explaining: 'Explaining what differs', learning: 'Learning rules from shared keys', finding: 'Finding rows' };
  function onProgress(m) {
    if (m.phase === 'reading') {
      state.loading[m.side] = { done: m.done, total: m.total, rows: m.rows };
      var bar = $('#prog-' + m.side);
      if (bar) {
        $('span', bar).style.width = Math.min(100, Math.round(100 * m.done / Math.max(1, m.total))) + '%';
        var t = $('#progt-' + m.side);
        if (t) t.textContent = C.fmtBytes(m.done) + ' of ' + C.fmtBytes(m.total) + ' · ' + plural(m.rows || 0, 'row');
      }
      return;
    }
    if (!state.busy) return;
    state.busy.phase = (PHASE[m.phase] || 'Working') + ' ' + m.side;
    state.busy.pct = Math.min(100, Math.round(100 * m.done / Math.max(1, m.total)));
    var b = $('#busyBar'), bt = $('#busyText');
    if (b) $('span', b).style.width = state.busy.pct + '%';
    if (bt) bt.textContent = state.busy.phase + '…';
  }

  /* ---------------- columns and the recipe ---------------- */

  function beforeCols() { return state.sides.before ? state.sides.before.columns : (state.other && state.other.side === 'before' ? state.other.columns : null); }
  function afterCols() { return state.sides.after ? state.sides.after.columns : (state.other && state.other.side === 'after' ? state.other.columns : null); }
  function bothShapes() { return Boolean(beforeCols() && afterCols()); }
  function bothFiles() { return Boolean(state.sides.before && state.sides.after); }
  /** The recipe as the worker, the files and the model see it: no notes. */
  function plainRecipe() {
    var r = state.recipe || { pairs: [], key: [] };
    return {
      parity: 'recipe', v: 1,
      pairs: r.pairs.map(function (p) { var o = { from: p.from.slice(), to: p.to.slice(), rules: C.sortRules(p.rules) }; if (p.from.length > 1 || p.to.length > 1) o.sep = p.sep === undefined ? ' ' : p.sep; return o; }),
      key: r.key.slice(),
      target: C.cleanShape(afterCols() || []),
    };
  }
  function planErrors() {
    if (!state.recipe || !bothShapes()) return ['Load both sides first.'];
    if (!state.recipe.pairs.length) return ['Pair at least one column.'];
    return C.compilePlan(plainRecipe(), beforeCols(), afterCols()).errors;
  }
  function used(side) { var u = {}; (state.recipe ? state.recipe.pairs : []).forEach(function (p) { (side === 'before' ? p.from : p.to).forEach(function (n) { u[n] = 1; }); }); return u; }
  function unmatched(side) { var cols = side === 'before' ? beforeCols() : afterCols(), u = used(side); return (cols || []).filter(function (c) { return !u[c.name]; }); }
  function colByName(side, name) { return ((side === 'before' ? beforeCols() : afterCols()) || []).filter(function (c) { return c.name === name; })[0] || null; }
  function changed() { if (state.result) state.stale = true; state.fp.cmp = null; state.fp.made = { before: null, after: null }; state.fp.lists = { before: null, after: null }; state.fp.rowCmp = null; }

  function autoMap() {
    var B = beforeCols(), A = afterCols();
    var am = C.automap(B, A);
    state.recipe = { pairs: am.pairs.map(function (p) { return { from: p.from, to: p.to, sep: p.sep, rules: [], conf: p.conf, why: p.why || '' }; }), key: C.suggestKey(am.pairs, B, A) };
    state.learnNote = null;
    changed();
    if (!bothFiles() || !state.recipe.key.length) return Promise.resolve();
    return learn();
  }
  function learn() {
    state.busy = { label: 'Learning rules', pct: 0 };
    draw();
    var rec = plainRecipe();
    return run('learn', { recipe: rec }).then(function (r) {
      var n = 0;
      r.learned.forEach(function (l) {
        var p = state.recipe.pairs[l.pair];
        if (!p) return;
        p.rules = C.sortRules(p.rules.concat(l.rules));
        p.learned = l.rules.map(function (x) { return x.rule; });
        n += l.rules.length;
      });
      state.learnNote = { rules: n, joined: r.joined };
    }).catch(function (e) { if (!e.cancelled) toast(e.message, 4200); }).then(function () { state.busy = null; changed(); draw(); });
  }

  /* ---------------- loading files ---------------- */

  function sideHint(name) {
    var n = String(name || '').toLowerCase();
    if (/(^|[^a-z])(before|old|source|src|legacy|orig|original|prod|v1|from)([^a-z]|$)/.test(n)) return 'before';
    if (/(^|[^a-z])(after|new|target|tgt|dest|migrated|v2|to)([^a-z]|$)/.test(n)) return 'after';
    return null;
  }
  /** Files dropped or picked: one goes where it was dropped; two are put
   *  before/after by their names (else in order). */
  function takeFiles(list, side) {
    var files = Array.prototype.slice.call(list || []).filter(function (f) { return f && f.size >= 0; });
    if (!files.length) return;
    if (files.length >= 2) {
      var a = files[0], b = files[1];
      if (sideHint(a.name) === 'after' || sideHint(b.name) === 'before') { var t = a; a = b; b = t; }
      loadFile('before', a); loadFile('after', b);
      return;
    }
    var f = files[0];
    if (/\.json$/i.test(f.name) && f.size < 8 * 1024 * 1024) {
      // Maybe a recipe, a shape or a fingerprint rather than data.
      return readJsonFile(f).then(function (o) { if (!importParityFile(o, f.name)) loadFile(side, f); }).catch(function () { loadFile(side, f); });
    }
    loadFile(side, f);
  }
  function loadFile(side, file) {
    if (state.source === 'demo') { state.source = 'files'; state.sides = { before: null, after: null }; state.recipe = null; state.result = null; SIDES.forEach(function (s) { worker.postMessage({ op: 'forget', side: s }); }); }
    state.source = 'files';
    state.sides[side] = null;
    state.loading[side] = { done: 0, total: file.size, rows: 0 };
    state.result = null; state.recipe = null;
    if (state.view !== 'app' || state.tab !== 'files') { state.view = 'app'; state.tab = 'files'; history.pushState(null, '', BASE + '#files'); }
    draw();
    var o = state.opts[side];
    return run('load', { side: side, file: file, header: o.header === 'auto' ? null : o.header, emptyNull: o.emptyNull }).then(function (info) {
      info.file = file;
      state.loading[side] = null;
      state.sides[side] = info;
      afterLoad();
    }).catch(function (e) {
      state.loading[side] = null;
      draw();
      if (!e.cancelled) toast(e.message, 5000);
    });
  }
  function afterLoad() {
    if (bothShapes() && !SIDES.some(function (s) { return state.loading[s]; })) {
      autoMap().then(function () { draw(); });
    }
    draw();
  }
  function reload(side) {
    var s = state.sides[side];
    if (!s || !s.file) return;
    loadFile(side, s.file);
  }
  function openDemo() {
    var d = D.build();
    state.source = 'demo';
    state.other = null;
    state.view = 'app'; state.tab = 'files';
    state.result = null; state.recipe = null;
    var files = { before: new File([d.before.text], d.before.name, { type: 'text/csv' }), after: new File([d.after.text], d.after.name, { type: 'application/x-ndjson' }) };
    SIDES.forEach(function (s) { state.sides[s] = null; state.loading[s] = { done: 0, total: files[s].size, rows: 0 }; state.opts[s] = { header: 'auto', emptyNull: false }; });
    draw();
    Promise.all(SIDES.map(function (s) {
      return run('load', { side: s, file: files[s], header: null, emptyNull: false }).then(function (info) { info.file = files[s]; state.sides[s] = info; state.loading[s] = null; });
    })).then(function () {
      return autoMap();
    }).then(function () {
      state.tab = 'map';
      history.replaceState(null, '', BASE + '#map');
      draw(); scrollTo(0, 0);
    }).catch(function (e) { toast(e.message, 5000); });
  }

  /** A JSON file someone brought: a recipe, a shape, a fingerprint or a row
   *  list. True if it was one of ours. */
  function importParityFile(o, name) {
    if (!o || typeof o !== 'object') return false;
    if (o.parity === 'fingerprint') {
      var fp = C.cleanFingerprint(o);
      if (!fp) { toast('That fingerprint could not be read.', 4000); return true; }
      fp.fileName = C.clean(name, 120);
      state.fp.imported = state.fp.imported.filter(function (x) { return x.side !== fp.side; }).concat([fp]);
      if (!afterCols() && fp.side === 'after' && fp.columns.length) state.other = { side: 'after', columns: fp.columns, from: 'fingerprint', name: fp.fileName };
      go('fingerprint'); toast('Fingerprint of the ' + fp.side + ' side loaded');
      return true;
    }
    if (o.parity === 'rows') {
      var rl = C.cleanRowList(o);
      if (!rl) { toast('That row list could not be read.', 4000); return true; }
      rl.fileName = C.clean(name, 120);
      state.fp.lists[rl.side] = rl; state.fp.rowCmp = null;
      go('fingerprint'); toast('Row list of the ' + rl.side + ' side loaded');
      return true;
    }
    if (o.parity === 'shape') {
      var side = o.side === 'before' ? 'before' : 'after';
      var cols = C.cleanShape(o.columns).map(function (c, i) { var src = o.columns[i] || {}; ['rows', 'nulls', 'empties', 'distinct'].forEach(function (k) { var n = Number(src[k]); c[k] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; }); return c; });
      if (!cols.length) { toast('That shape has no columns.', 4000); return true; }
      if (state.sides[side]) { toast('The ' + side + ' file is already loaded here - this shape is for the other machine.', 4000); return true; }
      state.other = { side: side, columns: cols, from: 'shape', name: C.clean(name, 120), rows: Number(o.rows) || 0 };
      toast('The ' + side + ' side\'s shape is loaded');
      if (bothShapes()) autoMap().then(draw);
      draw();
      return true;
    }
    if (o.parity === 'recipe' || Array.isArray(o.pairs)) { useRecipe(o, name); return true; }
    return false;
  }
  function useRecipe(o, name) {
    if (!afterCols() && Array.isArray(o.target) && o.target.length) state.other = { side: 'after', columns: C.cleanShape(o.target), from: 'recipe', name: C.clean(name || 'recipe', 120) };
    if (!bothShapes()) { toast('Load a file first - the recipe is matched to its columns.', 4000); return; }
    var r = C.cleanRecipe(o, beforeCols().map(function (c) { return c.name; }), afterCols().map(function (c) { return c.name; }));
    if (!r.recipe.pairs.length) { toast('None of that recipe\'s columns are in these files.', 4500); return; }
    state.recipe = { pairs: r.recipe.pairs.map(function (p) { p.conf = 'recipe'; return p; }), key: r.recipe.key };
    if (!state.recipe.key.length) state.recipe.key = C.suggestKey(state.recipe.pairs, beforeCols(), afterCols());
    state.learnNote = null;
    changed();
    go('map');
    toast(r.dropped ? 'Recipe used - ' + plural(r.dropped, 'pair') + ' did not fit these columns' : 'Recipe used');
  }

  /* ---------------- compare ---------------- */

  function compare() {
    var errs = planErrors();
    if (errs.length) { toast(errs[0], 4200); return; }
    state.busy = { label: 'Comparing', pct: 0, phase: 'Starting' };
    state.tab = 'verdict';
    history.pushState(null, '', BASE + '#verdict');
    draw();
    var rec = plainRecipe();
    run('compare', { recipe: rec }).then(function (res) {
      state.result = res; state.stale = false; state.open = {};
      if (res.findings.length) state.open[0] = true;
      if (state.source !== 'demo') keep(K_RECIPE, rec);
    }).catch(function (e) { if (!e.cancelled) toast(e.message, 5000); }).then(function () { state.busy = null; draw(); scrollTo(0, 0); });
  }

  /* ---------------- routing ---------------- */

  function go(tab) {
    if (tab === 'start') { state.view = 'start'; history.pushState(null, '', BASE + '#start'); draw(); scrollTo(0, 0); return; }
    state.view = 'app'; state.tab = tab;
    history.pushState(null, '', BASE + '#' + tab);
    draw(); scrollTo(0, 0);
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h === 'example') { history.replaceState(null, '', BASE + '#files'); return openDemo(); }
    if (TABS.some(function (t) { return t[0] === h; })) { state.view = 'app'; state.tab = h; return draw(); }
    state.view = 'start'; draw();
  }
  window.addEventListener('popstate', route);

  function draw() {
    closeSheet(true);
    var main = $('#main');
    document.body.classList.toggle('has-tabs', state.view === 'app');
    if (state.view !== 'app') { main.innerHTML = startHtml() + footer(); return; }
    var html = '<nav class="tabbar dk-tabbar" aria-label="Steps"><div class="tabbar-inner"><a class="rail-brand" href="./#start" data-act="home"><span aria-hidden="true">⚖️</span>Parity</a>' + TABS.map(function (t, i) {
      var on = t[0] === state.tab;
      return '<a class="tab' + (on ? ' on' : '') + '" href="#' + t[0] + '" data-act="tab" data-tab="' + t[0] + '"' + (on ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span><em class="stepn">' + (i + 1) + '</em>' + t[2] + '</a>';
    }).join('') + '</div></nav>';
    html += sourceStrip();
    html += '<div id="tab">' + tabHtml() + '</div>' + footer();
    main.innerHTML = html;
    wireTab();
  }
  function tabHtml() {
    switch (state.tab) {
      case 'map': return mapHtml();
      case 'verdict': return verdictHtml();
      case 'fingerprint': return fpHtml();
      case 'report': return reportHtml();
      default: return filesHtml();
    }
  }
  function wireTab() {
    if (state.tab === 'files') wireDrops();
    if (state.tab === 'fingerprint') drawBucketMap();
    if (state.tab === 'report') drawReportPreview();
  }
  function sourceStrip() {
    if (state.source !== 'demo') return '';
    return '<div class="strip"><p><b>Example migration</b> <span class="sub">· 2,000 made-up customers, legacy database (CSV) → warehouse (JSON Lines)</span></p><button class="btn small ghost" type="button" data-act="own">Use my own files</button></div>';
  }
  function footer() {
    return '<footer class="foot"><p>🔒 Runs entirely in this browser - your data is never uploaded.' + (state.offline ? ' Ready to work with the network off.' : '') + '</p><p>Parity compares data. It does not change it - check a finding before you act on it.</p></footer>';
  }

  /* ---------------- first run ---------------- */

  function startHtml() {
    var saved = recall(K_RECIPE);
    return '<section class="hero">' +
      '<div class="kicker"><span aria-hidden="true">⚖️</span> Parity · migration check</div>' +
      '<h1>Prove the migrated data matches.</h1>' +
      '<p>Drop the table before and after a migration - a database upgrade, a warehouse move, an ETL rewrite. Parity lines up the columns, applies your rules, and names every row that went missing, showed up twice or changed, with the exact keys.</p>' +
      '<div class="btns"><button class="btn big primary" type="button" data-act="example">Try an example migration</button><button class="btn big ghost" type="button" data-act="own">Compare my data</button></div>' +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><div><b>Runs entirely in this browser - your data is never uploaded. Works with the network off once loaded.</b><br><span class="small">Files are read on this device in the background. No account needed. Nothing is stored on a server.</span></div></div>' +
      '</section>' +
      '<div class="points">' +
      '<div class="card point"><span class="ico" aria-hidden="true">📂</span><div><h3>Two files, any size</h3><p class="muted small">CSV with any delimiter, TSV or JSON Lines, up to about 1 GB each, read in a background thread so the page never freezes.</p></div></div>' +
      '<div class="card point"><span class="ico" aria-hidden="true">🔗</span><div><h3>Renamed, split, reformatted</h3><p class="muted small">Columns are paired by name. Rules from a fixed list - trim, cents to dollars, date formats, code tables, time zones - are learned from rows that share a key. No code.</p></div></div>' +
      '<div class="card point"><span class="ico" aria-hidden="true">✅</span><div><h3>A verdict you can sign</h3><p class="muted small">Every problem ranked by rows affected, with keys and before → after. Aggregates side by side. A report in HTML, Markdown or JSON.</p></div></div>' +
      '</div>' +
      '<div class="card airgap"><div class="row spread"><div><h2>🔏 Two machines that can\'t share data?</h2><p class="muted" style="margin:0">Each side makes a <b>fingerprint</b>: row counts, column counts and salted hashes - no values. Compare the two anywhere, then narrow any difference to a handful of keys.</p></div><button class="btn ghost" type="button" data-act="fphelp">How it works</button></div></div>' +
      (saved ? '<div class="card"><div class="row spread"><p style="margin:0">Your last recipe (the mapping and rules - never data) is remembered on this device.</p><button class="btn small ghost" type="button" data-act="clearrecipe">Clear it</button></div></div>' : '');
  }

  /* ---------------- files ---------------- */

  function typeChip(c) {
    if (!c) return '';
    var t = c.type || 'text';
    return '<span class="tchip t-' + esc(t) + '" title="' + esc(C.TYPE_LABEL[t] || t) + '">' + esc(t === 'datetime' ? 'date-time' : t) + (c.format ? ' <span class="fmt">' + esc(c.format) + '</span>' : '') + '</span>';
  }
  function fileCard(side) {
    var s = state.sides[side], l = state.loading[side], o = state.opts[side];
    var label = side === 'before' ? 'Before' : 'After';
    var sub = side === 'before' ? 'The table as it was - the source, the old system.' : 'The table as it is now - the target, the new system.';
    var html = '<section class="card filecard" data-side="' + side + '"><div class="sec-head"><h2>' + (side === 'before' ? '⬅️' : '➡️') + ' ' + label + '</h2>' + (s ? '<button class="btn small ghost" type="button" data-act="replace" data-side="' + side + '">Replace</button>' : '') + '</div>';
    if (l) {
      return html + '<p class="muted">Reading in the background - the page stays usable.</p><div class="progress" id="prog-' + side + '"><span style="width:' + Math.round(100 * l.done / Math.max(1, l.total)) + '%"></span></div><p class="small muted" id="progt-' + side + '">' + esc(C.fmtBytes(l.done) + ' of ' + C.fmtBytes(l.total)) + '</p><button class="btn small ghost" type="button" data-act="cancel">Stop</button></section>';
    }
    if (!s) {
      if (state.other && state.other.side === side) {
        return html + '<div class="note"><p><b>On the other machine.</b> Using its shape from <code>' + esc(state.other.name) + '</code>: ' + plural(state.other.columns.length, 'column') + ', names and types only.</p><button class="btn small ghost" type="button" data-act="dropother">Use a file here instead</button></div></section>';
      }
      return html + '<p class="muted small">' + sub + '</p><label class="drop" data-drop="' + side + '"><span class="ico" aria-hidden="true">📄</span><b>Drop the ' + side + ' file here</b><span class="small muted">or tap to choose · CSV, TSV or JSON Lines · up to about 1 GB</span><input class="vh" type="file" data-file="' + side + '" accept=".csv,.tsv,.tab,.txt,.jsonl,.ndjson,.json,text/csv,text/plain"></label></section>';
    }
    var fmtName = s.format === 'jsonl' ? 'JSON Lines' : s.delimiter === '\t' ? 'TSV (tab)' : 'CSV (' + (s.delimiter === ',' ? 'comma' : s.delimiter === ';' ? 'semicolon' : s.delimiter === '|' ? 'pipe' : 'delimiter ' + s.delimiter) + ')';
    html += '<p class="fname"><b>' + esc(s.name) + '</b></p><ul class="facts"><li>' + esc(fmtName) + '</li><li>' + esc(C.fmtBytes(s.size)) + '</li><li><b>' + esc(fmt(s.rows)) + '</b> rows</li><li>' + esc(plural(s.columns.length, 'column')) + '</li><li class="muted">read in ' + esc((s.ms / 1000).toFixed(1)) + ' s</li></ul>';
    if (s.format !== 'jsonl' && state.source !== 'demo') {
      html += '<div class="opts"><label class="check"><input type="checkbox" data-change="header" data-side="' + side + '"' + (s.header ? ' checked' : '') + '> First row is column names' + (s.header !== s.headerGuess ? '' : ' <span class="muted small">(detected)</span>') + '</label>' +
        '<label class="check"><input type="checkbox" data-change="emptynull" data-side="' + side + '"' + (o.emptyNull ? ' checked' : '') + '> Empty cells are null <span class="muted small">(Postgres COPY style)</span></label></div>';
    }
    if (s.issues && s.issues.length) html += '<div class="note warn"><b>Read with care</b><ul>' + s.issues.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul></div>';
    html += '<details class="cols"' + (state.source === 'demo' ? '' : ' open') + '><summary>Columns and types</summary><div class="tbox"><table class="wide"><thead><tr><th>Column</th><th>Type</th><th class="r">Nulls</th><th class="r">Empty</th><th class="r">Distinct</th><th>First values</th></tr></thead><tbody>' +
      s.columns.map(function (c, i) {
        var ex = s.preview.slice(0, 3).map(function (r) { return r[i]; });
        return '<tr><td><b class="cname">' + esc(c.name) + '</b></td><td>' + typeChip(c) + (c.ambiguous ? ' <span class="small muted">or day-first</span>' : '') + '</td><td class="r">' + esc(fmt(c.nulls)) + '</td><td class="r">' + esc(fmt(c.empties)) + '</td><td class="r">' + (c.distinctApprox ? '≈' : '') + esc(fmt(c.distinct)) + '</td><td class="vals">' + ex.map(function (v) { return '<code>' + esc(C.showVal(v, 40)) + '</code>'; }).join(' ') + '</td></tr>';
      }).join('') + '</tbody></table></div></details>';
    html += '<div class="btns" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="shape" data-side="' + side + '">Save this side\'s shape</button></div>';
    return html + '</section>';
  }
  function filesHtml() {
    var ready = bothShapes() && state.recipe;
    var html = '<div class="grid two">' + fileCard('before') + fileCard('after') + '</div>';
    if (ready) html += '<div class="card next"><div class="row spread"><p style="margin:0"><b>Both sides are in.</b> ' + esc(plural(state.recipe.pairs.length, 'column pair')) + ' found' + (state.recipe.key.length ? ', key ' + esc(state.recipe.key.join(' + ')) : '') + '.</p><button class="btn" type="button" data-act="tab" data-tab="map">Next: check the mapping →</button></div></div>';
    if (!bothShapes()) {
      html += '<div class="card"><h2>Only one side on this machine?</h2><p class="muted">For an air-gapped migration: load the file you have here, and bring the other side\'s <b>shape</b> (column names and types - no values), its <b>recipe</b> or its <b>fingerprint</b>. Then make this side\'s fingerprint on the Fingerprint step.</p><label class="btn ghost filepick">Load a shape, recipe or fingerprint<input type="file" data-file="parity" accept=".json,application/json"></label></div>';
    }
    return html;
  }
  function wireDrops() {
    $$('[data-drop]').forEach(function (el) {
      var side = el.getAttribute('data-drop');
      el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('over'); });
      el.addEventListener('dragleave', function () { el.classList.remove('over'); });
      el.addEventListener('drop', function (e) { e.preventDefault(); el.classList.remove('over'); takeFiles(e.dataTransfer && e.dataTransfer.files, side); });
    });
  }
  function shapeOf(side) {
    var s = state.sides[side];
    return { parity: 'shape', v: 1, side: side, rows: s.rows, note: 'Column names, inferred types and counts only - no values. Made by Parity.', columns: C.modelSummary({ rows: s.rows, columns: s.columns }, { rows: 0, columns: [] }).before.columns };
  }

  /* ---------------- map ---------------- */

  function ruleChip(r, learned) {
    return '<span class="rchip' + (learned ? ' learned' : '') + '">' + esc(C.ruleText(r)) + (learned ? ' <span class="lt">learned</span>' : '') + '</span>';
  }
  function mapHtml() {
    if (!bothShapes()) return '<div class="card empty"><h2>Map the columns</h2><p class="muted">Load both sides first - or one file and the other side\'s shape.</p><button class="btn" type="button" data-act="tab" data-tab="files">Go to Files</button></div>';
    if (!state.recipe) return busyCard() || '<div class="card"><p>Preparing…</p></div>';
    var r = state.recipe, errs = planErrors();
    var keyOpts = r.pairs.filter(function (p) { return !p.rules.some(function (x) { return x.rule === 'ignore'; }); });
    var html = '';
    if (state.busy) html += busyCard();
    html += '<section class="card maphead"><div class="row spread"><div><h2>Map before → after</h2><p class="muted" style="margin:0">' + esc(plural(r.pairs.length, 'pair')) + ' · ' + esc(plural(unmatched('before').length, 'before column')) + ' and ' + esc(plural(unmatched('after').length, 'after column')) + ' unpaired</p></div>' +
      '<div class="btns"><button class="btn big" type="button" data-act="compare"' + (errs.length || !bothFiles() ? ' disabled' : '') + '>Compare →</button></div></div>';
    if (state.learnNote && state.learnNote.rules) html += '<p class="learn">✨ Parity learned <b>' + esc(plural(state.learnNote.rules, 'rule')) + '</b> from ' + esc(fmt(state.learnNote.joined)) + ' rows that share a key - marked <span class="lt">learned</span> below. A rule is only learned when it fixes many rows and breaks none, so a real defect stays a finding.</p>';
    else if (state.source === 'demo') html += '<p class="learn">Columns paired by name.</p>';
    if (!bothFiles()) html += '<p class="small muted">Comparing row by row needs both files here. With one file and the other side\'s shape, make a fingerprint instead.</p>';
    html += '<div class="keyrow"><label for="keySel"><b>🔑 Key</b> <span class="muted small">- the column that says which row is which</span></label><select id="keySel" class="input" data-change="key"><option value="">Choose…</option>' +
      keyOpts.map(function (p) { var k = p.to.join(' + '); var b = colByName('before', p.from[0]), a = colByName('after', p.to[0]); var uniq = p.to.length === 1 && b && a && b.distinct === b.rows - b.nulls && !b.nulls; return '<option value="' + esc(p.to[0]) + '"' + (r.key[0] === p.to[0] ? ' selected' : '') + '>' + esc(k) + (uniq ? ' (unique)' : '') + '</option>'; }).join('') + '</select></div>';
    if (errs.length) html += '<p class="err" role="alert">' + esc(errs[0]) + '</p>';
    html += '<div class="btns maptools"><button class="btn small ghost" type="button" data-act="suggest">✨ Suggest with AI</button><button class="btn small ghost" type="button" data-act="automap">Auto-map again</button><button class="btn small ghost" type="button" data-act="addpair">Add a pair</button><label class="btn small ghost filepick">Load a recipe<input type="file" data-file="parity" accept=".json,application/json"></label>' + (recall(K_RECIPE) && state.source !== 'demo' ? '<button class="btn small ghost" type="button" data-act="lastrecipe">Use my last recipe</button>' : '') + '</div></section>';
    html += '<ul class="pairs">' + r.pairs.map(function (p, i) {
      var isKey = r.key.indexOf(p.to[0]) >= 0;
      var ign = p.rules.some(function (x) { return x.rule === 'ignore'; });
      var conf = CONF[p.conf] || CONF.yours;
      var learned = p.learned || [];
      return '<li class="pair' + (ign ? ' ignored' : '') + '"><div class="pcols"><div class="pside">' + p.from.map(function (n) { return '<span class="cname">' + esc(n) + '</span> ' + typeChip(colByName('before', n)); }).join('<span class="plus">+</span>') + '</div>' +
        '<span class="arrow" aria-label="becomes">→</span><div class="pside to">' + p.to.map(function (n) { return '<span class="cname">' + esc(n) + '</span> ' + typeChip(colByName('after', n)); }).join('<span class="plus">+</span>') + (isKey ? ' <span class="keyb">🔑 key</span>' : '') + '</div></div>' +
        '<div class="pmeta"><span class="conf ' + conf[1] + '">' + esc(conf[0]) + '</span>' + (p.to.length > 1 || p.from.length > 1 ? '<span class="rchip">joined with "' + esc(p.sep === undefined ? ' ' : p.sep) + '"</span>' : '') + p.rules.map(function (x) { return ruleChip(x, learned.indexOf(x.rule) >= 0); }).join('') + (p.why ? '<span class="why small muted">' + esc(p.why) + '</span>' : '') + '</div>' +
        '<div class="pact"><button class="btn small ghost" type="button" data-act="rules" data-i="' + i + '">Rules' + (p.rules.length ? ' (' + p.rules.length + ')' : '') + '</button><button class="btn small ghost" type="button" data-act="editpair" data-i="' + i + '">Change</button></div></li>';
    }).join('') + '</ul>';
    var ub = unmatched('before'), ua = unmatched('after');
    if (ub.length || ua.length) {
      html += '<section class="card"><h2>Not paired</h2><p class="muted small">Not compared. Pair one if it should be - or leave it, if the migration dropped or added it on purpose.</p>' +
        (ub.length ? '<p><b>Only in before:</b> ' + ub.map(function (c) { return '<button class="chipbtn" type="button" data-act="pairwith" data-side="before" data-name="' + esc(c.name) + '">' + esc(c.name) + ' +</button>'; }).join(' ') + '</p>' : '') +
        (ua.length ? '<p><b>Only in after:</b> ' + ua.map(function (c) { return '<button class="chipbtn" type="button" data-act="pairwith" data-side="after" data-name="' + esc(c.name) + '">' + esc(c.name) + ' +</button>'; }).join(' ') + '</p>' : '') + '</section>';
    }
    return html;
  }

  /** The rules sheet for one pair: the fixed list, each with its settings,
   *  and a live preview on the first rows of each file. */
  function openRules(i) {
    var p = state.recipe.pairs[i];
    var has = {}; p.rules.forEach(function (r) { has[r.rule] = r; });
    var bc = colByName('before', p.from[0]), ac = colByName('after', p.to[0]);
    var dateOpts = function (sel) { return C.DATE_FORMATS.map(function (f) { return '<option' + (f === sel ? ' selected' : '') + '>' + esc(f) + '</option>'; }).join(''); };
    var mapText = has.map ? has.map.table.map(function (e) { return e[0] + ' => ' + e[1]; }).join('\n') : '';
    var rows = C.RULES.map(function (R) {
      var on = Boolean(has[R.id]), r = has[R.id] || {};
      var extra = '';
      if (R.id === 'scale') extra = '<select class="input sm" data-p="op"><option value="div100"' + (r.op !== 'mul100' ? ' selected' : '') + '>÷ 100 (cents → units)</option><option value="mul100"' + (r.op === 'mul100' ? ' selected' : '') + '>× 100 (units → cents)</option></select>';
      if (R.id === 'round') extra = '<label class="inl">places <input class="input sm num" type="number" min="0" max="10" data-p="places" value="' + esc(r.places === undefined ? 2 : r.places) + '"></label>';
      if (R.id === 'tz') extra = '<label class="inl">hours <input class="input sm num" type="number" step="0.25" min="-14" max="14" data-p="hours" value="' + esc(r.hours === undefined ? 0 : r.hours) + '"></label>';
      if (R.id === 'date') extra = '<label class="inl">from <select class="input sm" data-p="from">' + dateOpts(r.from || (bc && bc.format) || 'MM/DD/YYYY') + '</select></label><label class="inl">to <select class="input sm" data-p="to">' + dateOpts(r.to || (ac && ac.format) || 'YYYY-MM-DD') + '</select></label>';
      if (R.id === 'map') extra = '<label class="field"><span class="small">One per line: <code>before =&gt; after</code></span><textarea class="input" rows="4" data-p="table" spellcheck="false">' + esc(mapText) + '</textarea></label>';
      return '<li class="rule" data-rule="' + R.id + '"><label class="check"><input type="checkbox" data-r="' + R.id + '"' + (on ? ' checked' : '') + '> <b>' + esc(R.label) + '</b>' + (R.both ? ' <span class="small muted">(both sides)</span>' : '') + '</label><p class="small muted">' + esc(R.help) + '</p>' + (extra ? '<div class="rextra">' + extra + '</div>' : '') + '</li>';
    }).join('');
    sheet('<h2>Rules: ' + esc(p.from.join(' + ')) + ' → ' + esc(p.to.join(' + ')) + '</h2><p class="muted small">Rules shape the before value into what the after value should be. They come from this fixed list - no code runs.</p>' +
      '<div class="preview" id="rPrev"></div><ul class="rules">' + rows + '</ul><div id="rErr"></div><div class="btns"><button class="btn" type="button" id="rSave">Save rules</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>', function (root) {
      function read() {
        var out = [], bad = '';
        $$('li.rule', root).forEach(function (li) {
          var id = li.getAttribute('data-rule');
          if (!$('input[data-r]', li).checked) return;
          var r = { rule: id };
          $$('[data-p]', li).forEach(function (el) { r[el.getAttribute('data-p')] = el.value; });
          if (id === 'round') r.places = Number(r.places);
          if (id === 'tz') r.hours = Number(r.hours);
          if (id === 'map') r.table = String(r.table || '').split(/\r?\n/).map(function (l) { var m = /^(.*?)\s*(?:=>|→|\t)\s*(.*)$/.exec(l); return m ? [m[1].trim(), m[2].trim()] : null; }).filter(function (e) { return e && e[0] !== ''; });
          var c = C.cleanRule(r);
          if (!c) bad = bad || (id === 'map' ? 'Write the value map as one "before => after" per line.' : id === 'tz' ? 'A time zone offset is a number of hours between -14 and 14, not 0.' : 'Check the settings of "' + C.RULES.filter(function (x) { return x.id === id; })[0].label + '".');
          else out.push(c);
        });
        return { rules: out, bad: bad };
      }
      function preview() {
        var rr = read();
        var trial = { pairs: [{ from: p.from, to: p.to, sep: p.sep, rules: rr.rules }], key: [] };
        var plan = C.compilePlan(trial, beforeCols(), afterCols()), pp = plan.pairs[0];
        var bs = state.sides.before ? state.sides.before.preview.slice(0, 4) : [], as = state.sides.after ? state.sides.after.preview.slice(0, 4) : [];
        var bIdx = function (n) { return beforeCols().map(function (c) { return c.name; }).indexOf(n); };
        var aIdx = function (n) { return afterCols().map(function (c) { return c.name; }).indexOf(n); };
        var line = function (vals) { return vals.map(function (v) { return '<code>' + esc(C.showVal(v, 48)) + '</code>'; }).join(''); };
        var bRaw = bs.map(function (r) { return p.from.map(function (n) { return r[bIdx(n)]; }).join(' + '); });
        var bNorm = bs.map(function (r) { return C.normBefore(pp, r); });
        var aNorm = as.map(function (r) { return C.normAfter(pp, r); });
        $('#rPrev', root).innerHTML = bs.length || as.length ? '<p class="small"><b>Preview</b> <span class="muted">(the first rows of each file - not necessarily the same rows)</span></p><div class="pv"><span class="small muted">Before</span><div>' + line(bRaw) + '</div><span class="small muted">With these rules</span><div>' + line(bNorm) + '</div><span class="small muted">After, as compared</span><div>' + line(aNorm) + '</div></div>' : '';
        $('#rErr', root).innerHTML = rr.bad ? '<p class="err" role="alert">' + esc(rr.bad) + '</p>' : '';
      }
      root.addEventListener('change', preview);
      root.addEventListener('input', function (e) { if (e.target.matches('textarea, input[type=number]')) preview(); });
      preview();
      $('#rSave', root).addEventListener('click', function () {
        var rr = read();
        if (rr.bad) { $('#rErr', root).innerHTML = '<p class="err" role="alert">' + esc(rr.bad) + '</p>'; return; }
        p.rules = rr.rules; p.learned = (p.learned || []).filter(function (id) { return rr.rules.some(function (x) { return x.rule === id; }); });
        if (rr.rules.some(function (x) { return x.rule === 'ignore'; }) && state.recipe.key.indexOf(p.to[0]) >= 0) state.recipe.key = [];
        changed(); closeSheet(); draw(); toast('Rules saved');
      });
    });
  }
  /** Pair (or re-pair) columns: several on one side for a split or a join. */
  function openPair(i, pre) {
    var p = i === null ? { from: pre && pre.side === 'before' ? [pre.name] : [], to: pre && pre.side === 'after' ? [pre.name] : [], sep: ' ', rules: [] } : state.recipe.pairs[i];
    var uB = used('before'), uA = used('after');
    var list = function (side, cols, chosen, u) {
      return cols.map(function (c) {
        var mine = chosen.indexOf(c.name) >= 0, taken = u[c.name] && !mine;
        return '<label class="check' + (taken ? ' taken' : '') + '"><input type="checkbox" data-pside="' + side + '" value="' + esc(c.name) + '"' + (mine ? ' checked' : '') + '> <span class="cname">' + esc(c.name) + '</span> ' + typeChip(c) + (taken ? ' <span class="small muted">(paired)</span>' : '') + '</label>';
      }).join('');
    };
    sheet('<h2>' + (i === null ? 'Add a pair' : 'Change this pair') + '</h2><p class="muted small">Tick one column on each side for a rename. Tick two or more on one side when a column was split (full_name → first_name + last_name) or joined: they are compared joined with the separator below.</p>' +
      '<div class="grid two pairpick"><div><h3>Before</h3>' + list('before', beforeCols(), p.from, uB) + '</div><div><h3>After</h3>' + list('after', afterCols(), p.to, uA) + '</div></div>' +
      '<label class="field"><span>Separator for a split or join</span><input class="input sm" id="pSep" value="' + esc(p.sep === undefined ? ' ' : p.sep) + '" maxlength="5"></label><div id="pErr"></div>' +
      '<div class="btns"><button class="btn" type="button" id="pSave">Save</button>' + (i !== null ? '<button class="btn ghost" type="button" id="pDel">Unpair</button>' : '') + '<button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>', function (root) {
      $('#pSave', root).addEventListener('click', function () {
        var from = $$('input[data-pside=before]:checked', root).map(function (x) { return x.value; });
        var to = $$('input[data-pside=after]:checked', root).map(function (x) { return x.value; });
        var errEl = $('#pErr', root);
        if (!from.length || !to.length) { errEl.innerHTML = '<p class="err" role="alert">Tick at least one column on each side.</p>'; return; }
        if (from.length > 1 && to.length > 1) { errEl.innerHTML = '<p class="err" role="alert">Split or join - not both. Tick one column on one of the sides.</p>'; return; }
        var pairs = state.recipe.pairs.filter(function (q, j) { return j !== i && !q.from.some(function (n) { return from.indexOf(n) >= 0; }) && !q.to.some(function (n) { return to.indexOf(n) >= 0; }); });
        var np = { from: from, to: to, sep: $('#pSep', root).value, rules: i === null ? [] : p.rules, conf: 'yours', why: '' };
        pairs.splice(i === null ? pairs.length : Math.min(i, pairs.length), 0, np);
        state.recipe.pairs = pairs;
        var names = {}; pairs.forEach(function (q) { q.to.forEach(function (n) { names[n] = 1; }); });
        state.recipe.key = state.recipe.key.filter(function (k) { return names[k]; });
        changed(); closeSheet(); draw();
      });
      var del = $('#pDel', root);
      if (del) del.addEventListener('click', function () {
        state.recipe.pairs.splice(i, 1);
        var names = {}; state.recipe.pairs.forEach(function (q) { q.to.forEach(function (n) { names[n] = 1; }); });
        state.recipe.key = state.recipe.key.filter(function (k) { return names[k]; });
        changed(); closeSheet(); draw();
      });
    });
  }

  /* ---------------- verdict ---------------- */

  function busyCard() {
    if (!state.busy) return '';
    return '<section class="card busy" aria-live="polite"><div class="row spread"><b>' + esc(state.busy.label) + '</b><button class="btn small ghost" type="button" data-act="cancel">Stop</button></div><div class="progress" id="busyBar"><span style="width:' + (state.busy.pct || 0) + '%"></span></div><p class="small muted" id="busyText">' + esc((state.busy.phase || 'Starting') + '…') + '</p></section>';
  }
  var KIND_ICON = { missing: '🕳️', extra: '➕', dupkey: '👯', mismatch: '≠', notunique: '🔑' };
  function verdictHtml() {
    if (state.busy) return busyCard();
    var r = state.result;
    if (!r) {
      var errs = planErrors();
      return '<section class="card empty"><h2>Ready when you are</h2><p class="muted">' + (bothFiles() ? 'Check the mapping, then compare. It takes a few seconds for most tables.' : 'Comparing row by row needs both files on this machine. With one file, use the Fingerprint step.') + '</p>' +
        (bothFiles() ? '<button class="btn big" type="button" data-act="compare"' + (errs.length ? ' disabled' : '') + '>Compare →</button>' + (errs.length ? '<p class="err">' + esc(errs[0]) + '</p>' : '') : '<button class="btn" type="button" data-act="tab" data-tab="files">Go to Files</button>') + '</section>';
    }
    var html = '';
    if (state.stale) html += '<div class="note warn row spread"><p style="margin:0">The mapping or rules changed since this verdict.</p><button class="btn small" type="button" data-act="compare">Compare again</button></div>';
    var counts = { missing: 0, extra: 0, dupkey: 0, mismatch: 0 };
    r.findings.forEach(function (f) { if (counts[f.kind] !== undefined) counts[f.kind] += f.kind === 'mismatch' ? 1 : f.rows; });
    html += '<section class="verdict ' + (r.ok ? 'ok' : 'bad') + '"><p class="vk">' + (r.ok ? 'Verdict' : 'Verdict') + ' · key ' + esc(r.key.join(' + ')) + '</p><h1>' + esc(r.headline) + '</h1><p class="vsub">' + esc(r.sub) + '</p>' +
      '<ul class="vfacts"><li><b>' + esc(fmt(r.rows.before)) + '</b> rows before</li><li><b>' + esc(fmt(r.rows.after)) + '</b> rows after</li>' +
      (counts.missing ? '<li><b>' + esc(fmt(counts.missing)) + '</b> missing</li>' : '') + (counts.extra ? '<li><b>' + esc(fmt(counts.extra)) + '</b> extra</li>' : '') + (counts.dupkey ? '<li><b>' + esc(fmt(counts.dupkey)) + '</b> duplicated</li>' : '') + (counts.mismatch ? '<li><b>' + esc(fmt(counts.mismatch)) + '</b> column' + (counts.mismatch === 1 ? '' : 's') + ' differ</li>' : '') + '</ul>' +
      '<div class="btns"><button class="btn light" type="button" data-act="tab" data-tab="report">Sign-off report →</button><button class="btn ghostlight" type="button" data-act="tab" data-tab="map">Adjust the mapping</button></div></section>';
    if (r.findings.length) {
      html += '<h2 class="sect">Findings <span class="muted small">ranked by rows affected</span></h2>';
      r.findings.forEach(function (f, i) { html += findingHtml(f, i); });
    } else html += '<section class="card good"><h2>✓ Nothing to report</h2><p>Every key is on both sides, once, and every compared value matches under your recipe.</p></section>';
    html += aggHtml(r);
    return html;
  }
  function findingHtml(f, i) {
    var open = Boolean(state.open[i]);
    var shown = (f.examples || []).length;
    var html = '<article class="card finding k-' + esc(f.kind) + (f.info ? ' info' : '') + '"><div class="f-top"><span class="f-ico" aria-hidden="true">' + (KIND_ICON[f.kind] || '•') + '</span><div class="f-main"><h3><span class="rank">' + (i + 1) + '</span>' + esc(f.title) + '</h3><p class="f-head muted">' + esc(f.detail) + '</p>';
    if (f.patterns && f.patterns.length > 1) html += '<ul class="pats">' + f.patterns.map(function (p) { return '<li>' + esc(p.label) + ' <b>' + esc(fmt(p.rows)) + '</b></li>'; }).join('') + '</ul>';
    if (f.sampled) html += '<p class="small muted">Explained from the first ' + esc(fmt(f.sampled)) + ' differing rows.</p>';
    html += '</div><div class="f-num"><b>' + esc(fmt(f.rows)) + '</b><span>' + (f.kind === 'notunique' ? 'keys' : 'rows') + '</span></div></div>';
    html += '<div class="fix"><b>What to do</b><p>' + esc(f.fix) + '</p></div>';
    if (shown) {
      html += '<details class="cases" data-i="' + i + '"' + (open ? ' open' : '') + '><summary>' + (shown < f.rows ? 'Show the first ' + esc(shown) + ' of ' + esc(fmt(f.rows)) : 'Show ' + (shown === 1 ? 'the row' : 'all ' + esc(shown))) + '</summary><div class="tbox">' + examplesTable(f) + '</div></details>';
    }
    return html + '</article>';
  }
  function val(v) { return '<code class="v">' + esc(C.showVal(v, 80)) + '</code>'; }
  function examplesTable(f) {
    var ex = f.examples;
    if (f.kind === 'mismatch') {
      return '<table class="wide ex stack"><thead><tr><th>Key</th><th>Expected <span class="muted">(before, with rules)</span></th><th>Found <span class="muted">(after)</span></th><th>What changed</th></tr></thead><tbody>' + ex.map(function (e) {
        var rb = Array.isArray(e.rawBefore) ? e.rawBefore.join(' + ') : e.rawBefore;
        var showRaw = rb !== e.expected && !(rb === null && e.expected === null);
        return '<tr><td class="nw kc"><b>' + esc(e.key) + '</b><span class="pat-m"> · ' + esc(patLabel(e)) + '</span></td><td data-l="Expected">' + val(e.expected) + (showRaw ? '<span class="was small muted">was ' + esc(C.showVal(rb, 60)) + '</span>' : '') + '</td><td data-l="Found">' + val(e.found) + '</td><td class="pat">' + esc(patLabel(e)) + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    if (f.kind === 'dupkey' || f.kind === 'notunique') {
      return '<table class="ex"><thead><tr><th>Key</th><th class="r">Rows before</th><th class="r">Rows after</th>' + (f.kind === 'dupkey' ? '<th>Lines in the after file</th>' : '') + '</tr></thead><tbody>' + ex.map(function (e) { return '<tr><td><b>' + esc(e.key) + '</b></td><td class="r">' + esc(e.before) + '</td><td class="r">' + esc(e.after) + '</td>' + (f.kind === 'dupkey' ? '<td>' + esc((e.lines || []).join(', ')) + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table>';
    }
    var r = state.result, names = r.pairs.filter(function (p) { return !p.key; }).slice(0, 3);
    var idx = names.map(function (p) { return r.pairs.indexOf(p); });
    return '<table class="wide ex stack"><thead><tr><th>Key</th><th class="r">Line</th>' + names.map(function (p) { return '<th>' + esc((f.kind === 'missing' ? p.from : p.to).join(' + ')) + '</th>'; }).join('') + '</tr></thead><tbody>' + ex.map(function (e) {
      return '<tr><td class="nw kc"><b>' + esc(e.key) + '</b></td><td class="r" data-l="Line">' + esc(fmt(e.line)) + '</td>' + idx.map(function (j, n) { return '<td data-l="' + esc((f.kind === 'missing' ? names[n].from : names[n].to).join(' + ')) + '">' + val(e.values ? e.values[j] : null) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table>' + (f.rows > ex.length ? '<p class="small muted">And ' + esc(fmt(f.rows - ex.length)) + ' more. Line numbers count data rows in the ' + (f.kind === 'missing' ? 'before' : 'after') + ' file.</p>' : '<p class="small muted">Line numbers count data rows in the ' + (f.kind === 'missing' ? 'before' : 'after') + ' file.</p>');
  }
  function patLabel(e) {
    var n = e.n;
    switch (e.pattern) {
      case 'trunc': return 'truncated to ' + n;
      case 'shift': return 'shifted ' + (n > 0 ? '+' : '−') + Math.abs(n) + ' h';
      case 'dayshift': return 'moved ' + (n > 0 ? '+' : '−') + Math.abs(n) + ' d';
      case 'rounded': return 'rounded to ' + n + ' places';
      default: return (C.PATTERNS[e.pattern] || C.PATTERNS.other).label;
    }
  }
  function aggHtml(r) {
    var list = state.aggView === 'all' ? r.aggregates : r.likeForLike;
    var bad = list.filter(function (c) { return !c.ok; }), good = list.filter(function (c) { return c.ok; });
    var table = function (cols) {
      return '<div class="tbox"><table class="agg"><thead><tr><th>Check</th><th class="r">Before</th><th class="r">After</th><th class="r"><span class="vh">Result</span></th></tr></thead>' + cols.map(function (c) {
        return '<tbody><tr class="colrow"><th colspan="4"><span class="cname">' + esc(c.column) + '</span> ' + typeChip({ type: c.type }) + (c.key ? ' <span class="keyb">🔑 key</span>' : '') + '</th></tr>' + c.checks.map(function (x) {
          return '<tr class="' + (x.ok ? '' : 'miss') + '"><td>' + esc(x.label) + '</td><td class="r"><code>' + esc(aggVal(x.before)) + '</code></td><td class="r"><code>' + esc((x.approx ? '≈' : '') + aggVal(x.after)) + '</code></td><td class="r">' + (x.ok ? '<span class="okm" aria-label="matches">✓</span>' : '<span class="badm" aria-label="differs">✗</span>') + '</td></tr>';
        }).join('') + '</tbody>';
      }).join('') + '</table></div>';
    };
    var html = '<section class="card aggs"><div class="sec-head"><h2>Aggregates, side by side</h2><div class="seg" role="radiogroup" aria-label="Which rows"><button class="segb" type="button" role="radio" aria-checked="' + (state.aggView === 'like') + '" data-act="aggview" data-v="like">Rows on both sides</button><button class="segb" type="button" role="radio" aria-checked="' + (state.aggView === 'all') + '" data-act="aggview" data-v="all">All rows</button></div></div>' +
      '<p class="small muted">' + (state.aggView === 'like' ? 'Over rows whose key is on both sides once - so a missing or duplicated row does not drown out a changed value. A second, independent check on the findings above.' : 'Over every row of each file. Missing and duplicated rows show up here as different counts.') + '</p>';
    if (!list.length) return html + '<p>No columns compared.</p></section>';
    html += bad.length ? '<h3 class="aggh bad">✗ ' + esc(plural(bad.length, 'column')) + ' disagree</h3>' + table(bad) : '<p class="okline">✓ Every compared column agrees on every check.</p>';
    if (good.length) html += '<details class="aggok"' + (bad.length ? '' : ' open') + '><summary>✓ ' + esc(plural(good.length, 'column')) + ' agree on every check</summary>' + table(good) + '</details>';
    return html + '</section>';
  }
  function aggVal(v) { return v === null || v === undefined ? '-' : typeof v === 'number' ? fmt(v) : C.clean(v, 40); }

  /* ---------------- fingerprint ---------------- */

  function fpAvail(side) { return state.fp.made[side] || state.fp.imported.filter(function (x) { return x.side === side; })[0] || null; }
  function fpHtml() {
    var F = state.fp, prob = F.pass ? C.passphraseProblem(F.pass) : '';
    var canMake = SIDES.filter(function (s) { return state.sides[s]; });
    var errs = state.recipe ? planErrors().filter(function (e) { return !/both sides/.test(e); }) : ['Map the columns first.'];
    var html = '<section class="card fpintro"><h2>🔏 Fingerprints: compare across machines</h2><p>When before and after live on two machines that cannot share data - a regulated system, an on-prem box, an air gap - each side makes a <b>fingerprint</b>: a small file of row counts, column counts and salted hashes. <b>It holds no value from the data.</b> Compare the two anywhere. If they differ, the differences are narrowed to a few of 4,096 buckets, and <b>Find rows</b> on both sides lists just the keys in those.</p>' +
      '<ol class="steps small"><li>On the after machine: load the after file, <b>Save this side\'s shape</b> (Files step) and carry it over.</li><li>On the before machine: load the before file and that shape, check the mapping, make the <b>before fingerprint</b> and save the <b>recipe</b> (Report step).</li><li>On the after machine: load the recipe, make the <b>after fingerprint</b>.</li><li>Compare the two fingerprints on either machine.</li></ol>' +
      (state.source === 'demo' ? '<p class="small note">In the example both files are in this browser, so you can play both machines here.</p>' : '') + '</section>';
    html += '<section class="card"><h2>1 · The shared passphrase</h2><p class="small muted">Both sides type the same passphrase. It salts every hash, so someone holding a fingerprint cannot test guesses ("is customer 10457 in here?") without it. It is never saved or sent, and nothing here can recover it.</p>' +
      '<div class="passrow"><input class="input" id="fpPass" type="' + (F.show ? 'text' : 'password') + '" autocomplete="off" spellcheck="false" placeholder="four or more random words" value="' + esc(F.pass) + '" aria-label="Shared passphrase"><button class="btn small ghost" type="button" data-act="fpshow">' + (F.show ? 'Hide' : 'Show') + '</button></div>' +
      '<p class="small ' + (prob ? 'err' : 'muted') + '" id="fpPassMsg">' + esc(prob || (F.pass ? 'Good. Tell the other side by phone or in person - not in the same message as a fingerprint.' : 'At least 12 characters.')) + '</p>' +
      '<label class="check"><input type="checkbox" data-change="fpvalues"' + (F.includeValues ? ' checked' : '') + '> Include sums, minimums and maximums <span class="small muted">- off by default: these are values from your data. Turn on only if they may leave the machine.</span></label></section>';
    html += '<section class="card"><h2>2 · Make a fingerprint</h2>';
    if (!canMake.length) html += '<p class="muted">Load a file on the Files step first.</p>';
    else if (errs.length) html += '<p class="err">' + esc(errs[0]) + '</p>';
    html += '<div class="grid two">' + SIDES.map(function (s) {
      var made = F.made[s];
      if (!state.sides[s]) return '<div class="note"><b>' + (s === 'before' ? 'Before' : 'After') + '</b><p class="small muted" style="margin:0">' + (fpAvail(s) ? 'Loaded from <code>' + esc(fpAvail(s).fileName || 'a file') + '</code>.' : 'On the other machine.') + '</p></div>';
      return '<div class="note"><b>' + (s === 'before' ? 'Before' : 'After') + '</b> <span class="small muted">' + esc(state.sides[s].name) + '</span>' +
        (made ? '<p class="small">' + esc(plural(made.rows, 'row')) + ' · ' + esc(fmt(made.buckets.filter(Boolean).length)) + ' of 4,096 buckets used · ' + esc(C.fmtBytes(JSON.stringify(made).length)) + ' · ' + (made.includesValues ? '<b>includes sums, minimums and maximums</b>' : 'no values') + '</p><div class="btns"><button class="btn small" type="button" data-act="fpsave" data-side="' + s + '">Download</button><button class="btn small ghost" type="button" data-act="fppeek" data-side="' + s + '">What\'s inside</button></div>'
          : '<div class="btns" style="margin-top:8px"><button class="btn small" type="button" data-act="fpmake" data-side="' + s + '"' + (prob || !F.pass || errs.length ? ' disabled' : '') + '>Make the ' + s + ' fingerprint</button></div>') + '</div>';
    }).join('') + '</div></section>';
    var fb = fpAvail('before'), fa = fpAvail('after');
    html += '<section class="card"><div class="sec-head"><h2>3 · Compare two fingerprints</h2><label class="btn small ghost filepick">Load a fingerprint<input type="file" data-file="parity" accept=".json,application/json"></label></div>' +
      '<p class="small muted">Before: ' + (fb ? '<b>ready</b>' + (fb.fileName ? ' (' + esc(fb.fileName) + ')' : ' (made here)') : 'not yet') + ' · After: ' + (fa ? '<b>ready</b>' + (fa.fileName ? ' (' + esc(fa.fileName) + ')' : ' (made here)') : 'not yet') + '</p>' +
      (fb && fa && !F.cmp ? '<button class="btn" type="button" data-act="fpcompare">Compare the fingerprints</button>' : '') + (F.err ? '<p class="err" role="alert">' + esc(F.err) + '</p>' : '');
    if (F.cmp) html += fpResultHtml(F.cmp);
    html += '</section>';
    if (F.cmp && !F.cmp.ok && F.cmp.buckets.differ.length) html += rowsHtml();
    if (state.busy) html = busyCard() + html;
    return html;
  }
  function fpResultHtml(c) {
    var d = c.buckets.differ;
    var html = c.warnings.map(function (w) { return '<p class="note warn">' + esc(w) + '</p>'; }).join('');
    html += '<div class="verdict mini ' + (c.ok ? 'ok' : 'bad') + '"><h3>' + esc(c.headline) + '</h3><p class="vsub">' + esc(c.sub) + '</p><ul class="vfacts"><li><b>' + esc(fmt(c.rows.before)) + '</b> rows before</li><li><b>' + esc(fmt(c.rows.after)) + '</b> rows after</li><li><b>' + esc(fmt(c.buckets.same)) + '</b> buckets agree</li>' + (d.length ? '<li><b>' + esc(fmt(d.length)) + '</b> differ</li>' : '') + '</ul></div>';
    html += '<figure class="bmap"><canvas id="bucketMap" width="512" height="512" role="img" aria-label="' + esc('A map of 4,096 buckets: ' + c.buckets.same + ' agree, ' + d.length + ' differ, ' + c.buckets.empty + ' empty on both sides') + '"></canvas><figcaption class="legend"><span><i class="b-same"></i>agree</span><span><i class="b-diff"></i>differ</span><span><i class="b-empty"></i>empty</span></figcaption></figure>';
    var used = c.buckets.same + d.length;
    if (d.length && d.length * 4 > used) html += '<p class="note warn small">Most buckets differ, so many rows changed - usually one column transformed differently on one side. The aggregates below say which column; fix the recipe or the load, then make both fingerprints again. Find rows narrows best when a few rows differ in a big table.</p>';
    if (d.length) html += '<details class="aggok"><summary>The ' + esc(plural(d.length, 'differing bucket')) + '</summary><div class="tbox"><table class="ex"><thead><tr><th>Bucket</th><th class="r">Rows before</th><th class="r">Rows after</th></tr></thead><tbody>' + d.slice(0, 40).map(function (x) { return '<tr><td>' + esc(x.bucket) + '</td><td class="r">' + esc(fmt(x.before)) + '</td><td class="r">' + esc(fmt(x.after)) + '</td></tr>'; }).join('') + '</tbody></table></div>' + (d.length > 40 ? '<p class="small muted">And ' + esc(fmt(d.length - 40)) + ' more buckets.</p>' : '') + '</details>';
    if (c.aggregates.length) {
      var bad = c.aggregates.filter(function (a) { return !a.ok; });
      html += '<details class="aggok"' + (bad.length ? ' open' : '') + '><summary>Aggregates: ' + (bad.length ? esc(plural(bad.length, 'column')) + ' disagree' : 'every column agrees') + '</summary><div class="tbox"><table class="agg"><thead><tr><th>Check</th><th class="r">Before</th><th class="r">After</th><th class="r"><span class="vh">Result</span></th></tr></thead>' + c.aggregates.map(function (a) {
        return '<tbody><tr class="colrow"><th colspan="4"><span class="cname">' + esc(a.column) + '</span></th></tr>' + a.checks.map(function (x) { return '<tr class="' + (x.ok ? '' : 'miss') + '"><td>' + esc(x.label) + '</td><td class="r"><code>' + esc(aggVal(x.before)) + '</code></td><td class="r"><code>' + esc(aggVal(x.after)) + '</code></td><td class="r">' + (x.ok ? '<span class="okm">✓</span>' : '<span class="badm">✗</span>') + '</td></tr>'; }).join('') + '</tbody>';
      }).join('') + '</table></div></details>';
    }
    return html;
  }
  function rowsHtml() {
    var F = state.fp, buckets = F.cmp.buckets.differ.map(function (x) { return x.bucket; });
    var shown = buckets.slice(0, 6).join(', ') + (buckets.length > 6 ? ' and ' + (buckets.length - 6) + ' more' : '');
    var html = '<section class="card"><h2>4 · Find rows in bucket' + (buckets.length === 1 ? ' ' : 's ') + esc(shown) + '</h2><p class="small muted">Each side lists the rows in just those buckets - a salted hash of each key and of each row, no values - and the two lists say exactly which keys differ. Each machine then shows its own rows for them.</p>' +
      '<label class="check"><input type="checkbox" data-change="fpkeys"' + (F.includeKeys ? ' checked' : '') + '> Put the key values in the list <span class="small muted">- off by default. On, the other side sees the keys (for example customer ids) of these rows, and nothing else.</span></label>' +
      '<div class="grid two" style="margin-top:10px">' + SIDES.map(function (s) {
        var l = F.lists[s];
        return '<div class="note"><b>' + (s === 'before' ? 'Before' : 'After') + '</b>' + (l ? '<p class="small">' + esc(plural(l.rows.length, 'row')) + ' listed' + (l.fileName ? ' · from ' + esc(l.fileName) : '') + '</p><div class="btns">' + (l.fileName ? '' : '<button class="btn small" type="button" data-act="listsave" data-side="' + s + '">Download</button>') + '</div>'
          : state.sides[s] ? '<div class="btns" style="margin-top:8px"><button class="btn small" type="button" data-act="findrows" data-side="' + s + '">Find rows on this side</button></div>' : '<p class="small muted" style="margin:0">On the other machine - load its list.</p>') + '</div>';
      }).join('') + '</div><div class="btns" style="margin-top:10px"><label class="btn small ghost filepick">Load a row list<input type="file" data-file="parity" accept=".json,application/json"></label>' + (F.lists.before && F.lists.after && !F.rowCmp ? '<button class="btn small" type="button" data-act="listcompare">Compare the lists</button>' : '') + '</div>';
    if (F.rowCmp) {
      if (F.rowCmp.error) html += '<p class="err">' + esc(F.rowCmp.error) + '</p>';
      else {
        var d = F.rowCmp.differ;
        var by = {}; d.forEach(function (x) { by[x.label] = (by[x.label] || 0) + 1; });
        html += '<h3 class="sect">' + (d.length ? esc(plural(d.length, 'key differs', 'keys differ')) : 'No differing keys in these buckets') + '</h3>' + F.rowCmp.warnings.map(function (w) { return '<p class="note warn">' + esc(w) + '</p>'; }).join('');
        if (d.length) html += '<ul class="vfacts">' + Object.keys(by).map(function (k) { return '<li><b>' + esc(fmt(by[k])) + '</b> ' + esc(k) + '</li>'; }).join('') + '</ul>';
        if (d.length) html += '<div class="tbox"><table class="wide ex stack"><thead><tr><th>Key</th><th>What</th><th>On this machine: before</th><th>After</th></tr></thead><tbody>' + d.slice(0, 20).map(function (x) {
          var lb = F.local.before[x.k], la = F.local.after[x.k];
          var key = (lb && lb.key) || (la && la.key) || x.key;
          var vals = function (l) { return l ? l.values.slice(0, 4).map(function (v) { return '<code class="v">' + esc(C.showVal(v, 40)) + '</code>'; }).join(' ') : '<span class="muted small">-</span>'; };
          return '<tr><td class="nw kc">' + (key ? '<b>' + esc(key) + '</b>' : '<span class="muted">hash ' + esc(x.k.slice(0, 10)) + '…</span>') + '</td><td data-l="What">' + esc(x.label) + (x.status === 'dupkey' ? ' (' + esc(x.before) + ' → ' + esc(x.after) + ')' : '') + '</td><td data-l="Before, on this machine">' + vals(lb) + '</td><td data-l="After, on this machine">' + vals(la) + '</td></tr>';
        }).join('') + '</tbody></table></div>' + (d.length > 20 ? '<p class="small muted">The first 20 of ' + esc(fmt(d.length)) + ' - missing and extra rows first.</p>' : '');
      }
    }
    return html + '</section>';
  }
  function drawBucketMap() {
    var cv = $('#bucketMap');
    if (!cv || !state.fp.cmp) return;
    var cs = getComputedStyle(document.documentElement);
    var col = function (n) { return cs.getPropertyValue(n).trim() || '#888'; };
    var g = cv.getContext('2d'), N = 64, S = 8;
    var b = fpAvail('before'), a = fpAvail('after');
    g.clearRect(0, 0, 512, 512);
    for (var i = 0; i < 4096; i++) {
      var p = b.buckets[i], q = a.buckets[i];
      g.fillStyle = p === q ? (p ? col('--b-same') : col('--b-empty')) : col('--b-diff');
      g.fillRect((i % N) * S, Math.floor(i / N) * S, S - 1, S - 1);
    }
  }

  /* ---------------- report ---------------- */

  function reportHtml() {
    var r = state.result;
    var html = '';
    if (!r) html += '<section class="card empty"><h2>The sign-off report</h2><p class="muted">Compare first - the report is the verdict, written down.</p><button class="btn" type="button" data-act="tab" data-tab="verdict">Go to Verdict</button></section>';
    else {
      html += (state.stale ? '<div class="note warn">The mapping changed since this verdict - compare again before you sign off.</div>' : '') +
        '<section class="card"><div class="sec-head"><h2>Sign-off report</h2><span class="vpill ' + (r.ok ? 'ok' : 'bad') + '">' + esc(r.headline) + '</span></div>' +
        '<p class="muted small">The mapping, the rules, every check, the verdict and when it was made. Downloaded, never uploaded.</p>' +
        '<label class="check"><input type="checkbox" data-change="summary"' + (state.summaryOnly ? ' checked' : '') + '> <b>Summary only</b> <span class="small muted">- for sharing outside the team: leaves out every example, key value, sum, minimum and maximum, and value-map entries.</span></label>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="rhtml">Download HTML</button><button class="btn ghost" type="button" data-act="rmd">Markdown</button><button class="btn ghost" type="button" data-act="rjson">JSON</button>' + (state.summaryOnly ? '' : '<button class="btn ghost" type="button" data-act="rcsv">Examples (CSV)</button>') + '<button class="btn ghost" type="button" data-act="rcopy">Copy Markdown</button></div>' +
        '<div class="rprev"><iframe id="rFrame" title="Report preview" sandbox=""></iframe></div></section>';
    }
    html += '<section class="card"><h2>The recipe</h2><p class="muted small">The mapping and rules as a file - column names, rules and the after side\'s types, never a row. Reuse it on the next load, or carry it to the other machine for a fingerprint.</p>' +
      (state.recipe ? '<div class="btns"><button class="btn" type="button" data-act="recipesave">Download recipe</button><button class="btn ghost" type="button" data-act="recipecopy">Copy recipe</button><label class="btn ghost filepick">Load a recipe<input type="file" data-file="parity" accept=".json,application/json"></label></div><details class="cols"><summary>See it</summary><pre class="json">' + esc(JSON.stringify(C.toRecipe(plainRecipe(), afterCols()), null, 2)) + '</pre></details>' : '<p>Load both sides first.</p>') +
      '<p class="small muted" style="margin-top:10px">' + (recall(K_RECIPE) ? 'Your last recipe is remembered on this device (never the data). <button class="link-btn" type="button" data-act="clearrecipe">Clear it</button>' : 'After you compare your own files, the recipe is remembered on this device - never the data.') + '</p></section>';
    return html;
  }
  function drawReportPreview() {
    var f = $('#rFrame');
    if (!f || !state.result) return;
    f.srcdoc = C.toHtml(state.result, { summaryOnly: state.summaryOnly });
  }

  /* ---------------- sheets and the account ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    document.body.classList.add('sheet-open');
    s.scrollTop = 0;
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2');
    if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The auto-map and every check stay free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount('The AI suggestion uses about a cent of AI credit, so it needs a free account (it comes with $2).', retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  function sideSummary(side) {
    var s = state.sides[side];
    if (s) return { rows: s.rows, columns: s.columns };
    return { rows: state.other && state.other.rows || 0, columns: state.other ? state.other.columns : [] };
  }
  /** The one model call: shapes only, shown in full first. */
  function openSuggest() {
    if (!bothShapes()) { toast('Load both sides first.'); return; }
    var summary = C.modelSummary(sideSummary('before'), sideSummary('after'));
    var what = '<details' + (signedIn() ? ' open' : '') + ' id="sentBox"><summary><b id="sentLabel">' + (signedIn() ? 'What will be sent' : 'What would be sent') + '</b></summary><pre id="sendPre">' + esc(JSON.stringify(summary, null, 2)) + '</pre></details>';
    if (!signedIn()) {
      sheet('<h2>✨ Suggest the mapping and rules</h2><p>AI reads the two tables\' column names and types and proposes the pairs, rules and key - handy for wide tables with cryptic names. The auto-map is free and often enough.</p>' +
        '<div class="note"><p><b>It is sent names, types and counts only.</b> Never a value, never a row.</p><p class="small muted" style="margin:0">It uses about a cent of AI credit, so it needs a free account (it comes with $2). Everything else in Parity is free and needs no account.</p></div>' + what +
        '<div class="btns" style="margin-top:14px"><button class="btn" type="button" data-act="signin-suggest">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>');
      return;
    }
    sheet('<h2>✨ Suggest the mapping and rules</h2><p id="sgLead">This is <b>exactly</b> what will be sent - column names, inferred types and counts. No value from either table:</p>' + what +
      '<div id="sgErr"></div><div class="btns"><button class="btn" type="button" id="sgSend">Send and suggest</button><button class="btn ghost" type="button" data-act="closesheet" id="sgCancel">Cancel</button></div><p class="small muted" style="margin-top:8px">About a cent of AI credit. Nothing is stored.</p><div id="sgOut"></div>', function (root) {
      $('#sgSend', root).addEventListener('click', function (e) {
        var btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Thinking…';
        api('POST', 'api/suggest', { summary: summary }).then(function (r) {
          var prop = C.cleanProposal(r.proposal, beforeCols().map(function (c) { return c.name; }), afterCols().map(function (c) { return c.name; }));
          if (!prop) throw Object.assign(new Error('That answer had nothing usable in it. Try again.'), { status: 422 });
          btn.hidden = true;
          $('#sentBox', root).open = false;
          $('#sentLabel', root).textContent = 'What was sent';
          $('#sgLead', root).hidden = true;
          $('#sgCancel', root).textContent = 'Close';
          drawProposal($('#sgOut', root), prop);
          loadMe();
        }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send and suggest'; meteredError(err, $('#sgErr', root), openSuggest); });
      });
    });
  }
  function drawProposal(box, prop) {
    box.innerHTML = '<h3 class="sect">Suggestions</h3><p class="small muted">Untick any you do not want. Accepting replaces the pairs that use the same columns.' + (prop.dropped ? ' ' + esc(plural(prop.dropped, 'suggestion')) + ' named columns that are not in your files and were dropped.' : '') + '</p><ul class="sugg">' + prop.pairs.map(function (p, i) {
      return '<li><label class="check"><input type="checkbox" data-sg="' + i + '" checked> <span><span class="cname">' + esc(p.from.join(' + ')) + '</span> → <span class="cname">' + esc(p.to.join(' + ')) + '</span>' + p.rules.map(function (r) { return ruleChip(r, false); }).join('') + (p.why ? '<br><span class="small muted">' + esc(p.why) + '</span>' : '') + '</span></label></li>';
    }).join('') + '</ul>' + (prop.key.length ? '<p class="small">Key: <b>' + esc(prop.key.join(' + ')) + '</b></p>' : '') + '<div class="btns"><button class="btn" type="button" id="sgUse">Use the ticked suggestions</button></div><p class="small muted">Written by AI from names and types - check a rule before you rely on it.</p>';
    $('#sgUse', box).addEventListener('click', function () {
      var pick = $$('input[data-sg]:checked', box).map(function (x) { return prop.pairs[Number(x.getAttribute('data-sg'))]; });
      var pairs = state.recipe.pairs.filter(function (q) { return !pick.some(function (p) { return q.from.some(function (n) { return p.from.indexOf(n) >= 0; }) || q.to.some(function (n) { return p.to.indexOf(n) >= 0; }); }); });
      pick.forEach(function (p) { pairs.push({ from: p.from, to: p.to, sep: p.sep, rules: p.rules, conf: 'ai', why: p.why }); });
      state.recipe.pairs = pairs;
      var names = {}; pairs.forEach(function (q) { q.to.forEach(function (n) { names[n] = 1; }); });
      if (prop.key.length && prop.key.every(function (k) { return names[k]; })) state.recipe.key = prop.key.slice();
      state.recipe.key = state.recipe.key.filter(function (k) { return names[k]; });
      changed(); closeSheet(); draw(); toast(plural(pick.length, 'suggestion') + ' used');
    });
  }

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Nothing in Parity needs an account except "Suggest with AI", the one AI feature - a free account comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then) {
    var mode = 'register';
    function draw2(root) {
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
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (then) then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Suggest with AI costs about a cent. Reading files, mapping, the verdict, fingerprints and the report are free and need no account.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); });
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
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The auto-map, every check, fingerprints and the report keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  function openFpHelp() {
    sheet('<h2>🔏 Fingerprint mode</h2><p>For a migration where the before and after tables live on machines that must not share data.</p><ol class="steps"><li>Each side loads its own file and the same <b>recipe</b> (the mapping and rules - column names only).</li><li>Each side types the same <b>passphrase</b> and makes a fingerprint: row counts, per-column counts, and 4,096 bucket hashes, each a salted hash of the rows in it. <b>No value from the data</b> - sums, minimums and maximums only if you tick them.</li><li>Compare the two fingerprints on either machine. Equal fingerprints mean equal data under the recipe.</li><li>If some buckets differ, each side runs <b>Find rows</b> for just those buckets, and the two short lists name the keys that are missing, extra, repeated or changed.</li></ol><p class="small muted">The passphrase salts every hash, so a fingerprint cannot be checked against guesses of low-variety values (a status, a country, an id) by anyone without it.</p><div class="btns"><button class="btn" type="button" data-act="example">Try it on the example</button><button class="btn ghost" type="button" data-act="closesheet">Close</button></div>');
  }
  function peekFp(side) {
    var f = state.fp.made[side];
    var shown = Object.assign({}, f, { buckets: f.buckets.slice(0, 12).concat(['… ' + (f.buckets.length - 12) + ' more buckets']) });
    sheet('<h2>Inside the ' + esc(side) + ' fingerprint</h2><p class="muted small">Counts, column names and types, and salted hashes. ' + (f.includesValues ? '<b>It includes sums, minimums and maximums - values from your data.</b>' : 'No value from your data.') + '</p><pre class="json">' + esc(JSON.stringify(shown, null, 2)) + '</pre>');
  }

  /* ---------------- one click listener ---------------- */

  function fpMake(side) {
    var F = state.fp;
    if (C.passphraseProblem(F.pass)) { toast(C.passphraseProblem(F.pass), 4000); return; }
    state.busy = { label: 'Making the ' + side + ' fingerprint', pct: 0 };
    draw();
    run('fingerprint', { side: side, recipe: plainRecipe(), passphrase: F.pass, includeValues: F.includeValues }).then(function (fp) {
      F.made[side] = fp; F.cmp = null; F.err = '';
      F.imported = F.imported.filter(function (x) { return x.side !== side; });
    }).catch(function (e) { if (!e.cancelled) toast(e.message, 5000); }).then(function () { state.busy = null; draw(); });
  }
  function fpCompare() {
    var F = state.fp, c = C.compareFingerprints(fpAvail('before'), fpAvail('after'));
    if (c.error) { F.err = c.error; F.cmp = null; } else { F.cmp = c; F.err = ''; }
    F.lists = { before: null, after: null }; F.rowCmp = null;
    draw();
  }
  function findRows(side) {
    var F = state.fp;
    if (C.passphraseProblem(F.pass)) { toast('Type the shared passphrase first (step 1).', 4000); return; }
    state.busy = { label: 'Finding rows on the ' + side + ' side', pct: 0 };
    draw();
    run('findRows', { side: side, recipe: plainRecipe(), passphrase: F.pass, buckets: F.cmp.buckets.differ.map(function (x) { return x.bucket; }), includeKeys: F.includeKeys }).then(function (r) {
      F.lists[side] = r.list; F.rowCmp = null;
      var m = {}; r.local.forEach(function (l) { m[l.k] = l; });
      F.local[side] = m;
    }).catch(function (e) { if (!e.cancelled) toast(e.message, 5000); }).then(function () { state.busy = null; draw(); });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), side = t.getAttribute('data-side');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); go('start'); break;
      case 'example': closeSheet(); history.pushState(null, '', BASE + '#files'); openDemo(); break;
      case 'own':
        if (state.source === 'demo') { state.source = null; state.sides = { before: null, after: null }; state.recipe = null; state.result = null; SIDES.forEach(function (s) { worker.postMessage({ op: 'forget', side: s }); }); }
        go('files'); break;
      case 'tab': e.preventDefault(); go(t.getAttribute('data-tab')); break;
      case 'replace': state.sides[side] = null; worker.postMessage({ op: 'forget', side: side }); state.recipe = null; state.result = null; draw(); break;
      case 'dropother': state.other = null; state.recipe = null; draw(); break;
      case 'cancel': worker.postMessage({ op: 'cancel' }); break;
      case 'shape': download(slug() + '-' + side + '-shape.json', 'application/json', JSON.stringify(shapeOf(side), null, 2)); break;
      case 'compare': compare(); break;
      case 'automap': autoMap().then(draw); break;
      case 'lastrecipe': useRecipe(recall(K_RECIPE), 'your last recipe'); break;
      case 'clearrecipe': keep(K_RECIPE, null); toast('Cleared from this device'); draw(); break;
      case 'rules': openRules(Number(t.getAttribute('data-i'))); break;
      case 'editpair': openPair(Number(t.getAttribute('data-i'))); break;
      case 'addpair': openPair(null); break;
      case 'pairwith': openPair(null, { side: side, name: t.getAttribute('data-name') }); break;
      case 'suggest': openSuggest(); break;
      case 'signin-suggest': openAccount('Suggest with AI uses about a cent of AI credit; a free account comes with $2.', openSuggest); break;
      case 'aggview': state.aggView = t.getAttribute('data-v'); draw(); break;
      case 'fphelp': openFpHelp(); break;
      case 'fpshow': state.fp.show = !state.fp.show; draw(); break;
      case 'fpmake': fpMake(side); break;
      case 'fpsave': download(slug() + '-' + side + '-fingerprint.json', 'application/json', JSON.stringify(state.fp.made[side], null, 1)); break;
      case 'fppeek': peekFp(side); break;
      case 'fpcompare': fpCompare(); break;
      case 'findrows': findRows(side); break;
      case 'listsave': download(slug() + '-' + side + '-rows.json', 'application/json', JSON.stringify(state.fp.lists[side], null, 1)); break;
      case 'listcompare': state.fp.rowCmp = C.compareRowLists(state.fp.lists.before, state.fp.lists.after); draw(); break;
      case 'rhtml': download(slug() + '.html', 'text/html', C.toHtml(state.result, { summaryOnly: state.summaryOnly })); break;
      case 'rmd': download(slug() + '.md', 'text/markdown', C.toMarkdown(state.result, { summaryOnly: state.summaryOnly })); break;
      case 'rjson': download(slug() + '.json', 'application/json', JSON.stringify(C.toJson(state.result, { summaryOnly: state.summaryOnly }), null, 2)); break;
      case 'rcsv': download(slug() + '-examples.csv', 'text/csv', C.examplesCsv(state.result)); break;
      case 'rcopy': copy(C.toMarkdown(state.result, { summaryOnly: state.summaryOnly }), 'Markdown copied'); break;
      case 'recipesave': download(slug() + '-recipe.json', 'application/json', JSON.stringify(C.toRecipe(plainRecipe(), afterCols()), null, 2)); break;
      case 'recipecopy': copy(JSON.stringify(C.toRecipe(plainRecipe(), afterCols()), null, 2), 'Recipe copied'); break;
      default: break;
    }
  });
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d && d.matches && d.matches('details.cases')) state.open[d.getAttribute('data-i')] = d.open;
  }, true);
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('input[type=file][data-file]')) {
      var which = t.getAttribute('data-file');
      if (which === 'parity') {
        var f = t.files && t.files[0];
        if (f) readJsonFile(f).then(function (o) { if (!importParityFile(o, f.name)) toast('That is not a Parity recipe, shape, fingerprint or row list.', 4500); }).catch(function () { toast('That file is not JSON.', 4000); });
      } else takeFiles(t.files, which);
      t.value = '';
      return;
    }
    var c = t.getAttribute('data-change');
    if (!c) return;
    var side = t.getAttribute('data-side');
    if (c === 'header') { state.opts[side].header = t.checked; reload(side); }
    else if (c === 'emptynull') { state.opts[side].emptyNull = t.checked; reload(side); }
    else if (c === 'key') { state.recipe.key = t.value ? [t.value] : []; changed(); draw(); }
    else if (c === 'fpvalues') { state.fp.includeValues = t.checked; state.fp.made = { before: null, after: null }; state.fp.cmp = null; draw(); }
    else if (c === 'fpkeys') { state.fp.includeKeys = t.checked; state.fp.lists = { before: null, after: null }; state.fp.rowCmp = null; draw(); }
    else if (c === 'summary') { state.summaryOnly = t.checked; draw(); }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id !== 'fpPass') return;
    var F = state.fp, prev = F.pass;
    F.pass = e.target.value;
    if (prev !== F.pass && (F.made.before || F.made.after)) { F.made = { before: null, after: null }; F.cmp = null; F.lists = { before: null, after: null }; F.rowCmp = null; }
    var prob = F.pass ? C.passphraseProblem(F.pass) : '';
    var msg = $('#fpPassMsg');
    if (msg) { msg.textContent = prob || (F.pass ? 'Good. Tell the other side by phone or in person - not in the same message as a fingerprint.' : 'At least 12 characters.'); msg.className = 'small ' + (prob ? 'err' : 'muted'); }
    $$('[data-act=fpmake]').forEach(function (b) { b.disabled = Boolean(prob) || !F.pass; });
  });
  // A file dropped anywhere on the first run goes to the Files step.
  document.addEventListener('dragover', function (e) { if (state.view === 'start') e.preventDefault(); });
  document.addEventListener('drop', function (e) { if (state.view === 'start') { e.preventDefault(); takeFiles(e.dataTransfer && e.dataTransfer.files, 'before'); } });

  /* ---------------- offline ---------------- */

  function markOffline() {
    state.offline = true;
    var p = $('#offlinePill');
    if (p) { p.hidden = false; p.textContent = navigator.onLine === false ? 'Offline · still working' : '✓ Works offline'; }
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(function () { markOffline(); if (state.view === 'start') draw(); }).catch(function () { /* no offline copy, still works online */ });
  }
  window.addEventListener('offline', function () { if (state.offline) markOffline(); });
  window.addEventListener('online', function () { if (state.offline) markOffline(); });

  /* ---------------- start ---------------- */

  startWorker();
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  route();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
}());
