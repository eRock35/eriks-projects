/* Canon - the page. One file, no build step.
 *
 * THE CANON AND EVERY CHECK LIVE HERE. Metric definitions and schema notes
 * are kept in this browser (localStorage), and a pasted question + SQL is
 * checked against them by CanonCore, on the device. Nothing about a check is
 * sent anywhere. Requests that carry anything are: sync (signed in, the
 * canon itself), share links (signed in), and the two optional AI calls,
 * whose payloads are shown in full before they are sent.
 *
 * Every string a person typed or pasted, a file held, the server sent or a
 * model wrote is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.CanonCore;
  var D = window.CanonDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var SHARE = (/\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(location.pathname) || [])[1] || null;
  var esc = C.esc, plural = C.plural;
  var VW = C.VERDICT_WORD, VI = C.VERDICT_ICON;
  var K_CANON = 'canon-v1', K_DRAFT = 'canon-draft-v1', K_SYNC = 'canon-sync-v1', K_LINKS = 'canon-links-v1';

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  var saved = recall(K_CANON);
  var draft = recall(K_DRAFT) || {};
  var syncSaved = recall(K_SYNC) || {};
  var state = {
    me: null,
    view: 'start',
    canon: saved ? C.cleanCanon(saved) : null,
    preview: null,           // the made-up example, opened over an own canon (never saved)
    shared: null,            // the canon a share link opened (this tab only)
    shareErr: '',
    shareTab: 'defs',
    q: typeof draft.q === 'string' ? draft.q : '',
    sql: typeof draft.sql === 'string' ? draft.sql : '',
    result: null,
    picked: null,            // metric ids chosen by hand
    choosing: false,
    open: {},
    tryId: null,
    edit: null,              // the metric being edited
    editIsNew: false,
    schema: null,            // the schema notes being edited
    schemaParse: null,
    exportKind: 'md',
    importPreview: null,
    links: null,
    lastLink: null,
    base: typeof syncSaved.base === 'number' ? syncSaved.base : null,
    syncState: 'local',      // local | syncing | synced | error
    explain: null,
    draftText: '', draftBiz: '',
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
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function download(name, type, text) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function niceIso(iso) { var d = String(iso || '').slice(0, 10); return C.isDay(d) ? C.niceDay(d) : ''; }
  function canonNow() { return SHARE ? (state.shared && state.shared.canon) : (state.preview || state.canon); }
  function isSample(c) { return Boolean(c && c.sample); }
  function fname(ext) { var c = canonNow(); return 'canon-' + C.slug(c ? c.name : 'canon') + '-' + today() + ext; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. The checks stay free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }
  function meteredError(err, box, retry, why) {
    if (err.status === 401) { box.innerHTML = ''; return openAccount(why, retry); }
    if (err.status === 402) { box.innerHTML = ''; return openCredit(err.data); }
    if (err.data && err.data.code === 'verify-email') return verifyNote(box, err);
    showError(err, box);
  }

  /* ---------------- the canon on this device, and in the account ---------------- */

  var pushTimer = null;
  function saveCanon(changed) {
    if (!state.canon) { keep(K_CANON, null); return; }
    if (changed !== false) state.canon.updatedAt = Date.now();
    keep(K_CANON, state.canon);
    if (signedIn() && state.me.sync && !isSample(state.canon)) {
      clearTimeout(pushTimer);
      state.syncState = 'syncing'; drawSync();
      pushTimer = setTimeout(function () { push(0); }, 700);
    }
  }
  function setBase(b) { state.base = b; keep(K_SYNC, { base: b }); }
  function push(tries) {
    if (!state.canon || isSample(state.canon) || !signedIn()) return Promise.resolve();
    return api('PUT', 'api/canon', { canon: state.canon, base: state.base }).then(function (r) {
      state.canon = C.cleanCanon(r.canon); keep(K_CANON, state.canon); setBase(r.canon.updatedAt);
      state.syncState = 'synced'; drawSync();
    }).catch(function (err) {
      if (err.status === 409 && err.data && err.data.canon && tries < 2) {
        state.canon = C.mergeCanons(err.data.canon, state.canon); state.canon.sample = false;
        setBase(err.data.canon.updatedAt);
        return push(tries + 1).then(function () { if (state.view === 'canon') draw(); });
      }
      state.syncState = 'error'; drawSync();
    });
  }
  /** On sign-in: bring the two copies together. */
  function syncIn() {
    if (!signedIn() || !state.me.sync || SHARE) return Promise.resolve();
    state.syncState = 'syncing'; drawSync();
    return api('GET', 'api/canon').then(function (r) {
      var server = r.canon ? C.cleanCanon(r.canon) : null, local = state.canon;
      if (!server) {
        if (local && !isSample(local) && (local.metrics.length || local.tables.length)) { setBase(null); return push(0); }
        state.syncState = 'synced'; drawSync(); return null;
      }
      if (!local || isSample(local) || (!local.metrics.length && !local.tables.length)) {
        state.canon = server; state.canon.sample = false; keep(K_CANON, state.canon); setBase(server.updatedAt);
        state.syncState = 'synced'; state.preview = null; draw(); return null;
      }
      if (JSON.stringify(Object.assign({}, local, { updatedAt: 0 })) === JSON.stringify(Object.assign({}, server, { updatedAt: 0 }))) { setBase(server.updatedAt); state.syncState = 'synced'; drawSync(); return null; }
      state.canon = C.mergeCanons(server, local); state.canon.sample = false;
      setBase(server.updatedAt);
      return push(0).then(function () { draw(); });
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function syncLine() {
    var c = state.canon;
    if (state.preview) return '<span class="sync">Previewing the made-up example - nothing here is saved</span>';
    if (!c) return '';
    if (isSample(c)) return '<span class="sync">Made-up example · on this device only</span>';
    if (!signedIn()) return '<span class="sync">Saved on this device · <button class="link-btn" type="button" data-act="signin-sync">sign in to sync</button></span>';
    if (state.me && !state.me.sync) return '<span class="sync">Saved on this device (sync is unavailable right now)</span>';
    if (state.syncState === 'syncing') return '<span class="sync">Syncing…</span>';
    if (state.syncState === 'error') return '<span class="sync bad">✗ Couldn’t sync - saved on this device. <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync ok">✓ Synced to your account</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }

  /* ---------------- routing ---------------- */

  function go(hash) {
    history.pushState(null, '', (SHARE ? location.pathname : BASE) + '#' + hash);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    if (SHARE) { state.shareTab = /^#check/.test(location.hash) ? 'check' : 'defs'; state.view = 'shared'; return draw(); }
    var h = (location.hash || '').replace(/^#/, '');
    var m;
    if ((m = /^try\/([a-z-]+)$/.exec(h))) return openTry(m[1]);
    if (!canonNow() && h !== 'start') { state.view = 'start'; return draw(); }
    if (h === 'check' || h === 'canon' || h === 'export' || h === 'schema') state.view = h;
    else if (h === 'new') { state.view = 'edit'; if (!state.edit || !state.editIsNew) { state.edit = blankMetric(); state.editIsNew = true; } }
    else if ((m = /^edit\/([a-z0-9-]+)$/.exec(h))) {
      var mm = (canonNow().metrics || []).filter(function (x) { return x.id === m[1]; })[0];
      if (!mm) { state.view = 'canon'; } else { state.view = 'edit'; if (!state.edit || state.edit.id !== mm.id || state.editIsNew) { state.edit = JSON.parse(JSON.stringify(mm)); state.editIsNew = false; } }
    } else state.view = canonNow() && h !== 'start' ? 'check' : 'start';
    draw();
  }
  window.addEventListener('popstate', route);

  function draw() {
    closeSheet(true);
    var main = $('#main');
    var tab = state.view === 'edit' || state.view === 'schema' ? 'canon' : state.view;
    var showTabs = !SHARE && state.view !== 'start' && Boolean(canonNow());
    $('#tabbar').hidden = !showTabs;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var html = '';
    if (state.view === 'shared') html = sharedHtml();
    else if (state.view === 'check') html = checkHtml();
    else if (state.view === 'canon') html = canonHtml();
    else if (state.view === 'edit') html = editHtml();
    else if (state.view === 'schema') html = schemaHtml();
    else if (state.view === 'export') html = exportHtml();
    else html = startHtml();
    main.innerHTML = html;
    wire();
  }
  function wire() {
    var q = $('#q'), s = $('#sql');
    if (q) q.addEventListener('input', function () { state.q = q.value; keepDraft(); });
    if (s) s.addEventListener('input', function () { state.sql = s.value; keepDraft(); });
    if (s) s.addEventListener('keydown', function (e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runCheck(); } });
    var form = $('#editForm');
    if (form) { form.addEventListener('input', function () { readEdit(); drawHints(); }); form.addEventListener('submit', function (e) { e.preventDefault(); saveEdit(); }); drawHints(); }
    var imp = $('#importFile');
    if (imp) imp.addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) readImportFile(f); e.target.value = ''; });
    var ddlFile = $('#ddlFile');
    if (ddlFile) ddlFile.addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (!f) return; f.text().then(function (t) { var ta = $('#ddl'); if (ta) ta.value = t.slice(0, C.LIMITS.schemaTextChars); readDdl(); }); e.target.value = ''; });
  }
  function keepDraft() { if (state.preview || isSample(canonNow()) || SHARE) return; keep(K_DRAFT, { q: state.q.slice(0, 400), sql: state.sql.slice(0, 60000) }); }

  /* ---------------- shared pieces ---------------- */

  function footer() {
    return '<footer class="foot"><p>Canon checks SQL against the definitions you write; it never runs a query or sees your data.</p><p>A Challenge Lab trial · <a href="../">more experiments</a></p></footer>';
  }
  function sampleStrip() {
    var c = canonNow();
    if (SHARE || !c) return '';
    if (state.preview) return '<div class="sample-strip" role="note"><p><b>Made-up example:</b> ' + esc(D.NAME) + ' - previewed over your own canon, nothing saved.</p><div class="btns"><button class="btn small ghost" type="button" data-act="endpreview">Back to my canon</button></div></div>';
    if (!isSample(c)) return '';
    return '<div class="sample-strip" role="note"><p><b>Made-up example:</b> ' + esc(c.name) + ' is an invented coffee shop. Every number is made up.</p><div class="btns"><button class="btn small" type="button" data-act="startown">Start my own</button><button class="btn small ghost" type="button" data-act="makemine">Make this mine</button></div></div>';
  }
  function vpill(v, word) { return '<span class="vp vp-' + esc(v) + '"><span aria-hidden="true">' + (VI[v] || '•') + '</span>' + esc(word || VW[v] || v) + '</span>'; }
  function codeOr(text, fallback) { return text ? '<code>' + esc(text) + '</code>' : esc(fallback || '-'); }

  /** One metric definition, as a card. */
  function defCard(m, opts) {
    opts = opts || {};
    var h = '<article class="card mdef' + (opts.compact ? ' compact' : '') + '" id="m-' + esc(m.id) + '">';
    h += '<div class="row spread"><h3>' + esc(m.name) + '</h3>' + (opts.edit ? '<button class="btn small ghost" type="button" data-act="edit" data-id="' + esc(m.id) + '">Edit</button>' : '') + '</div>';
    if (m.synonyms.length) h += '<ul class="syn" aria-label="Also called">' + m.synonyms.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    if (m.meaning) h += '<p>' + esc(m.meaning) + '</p>';
    h += '<dl class="dl"><dt>Measure</dt><dd>' + codeOr(m.measure) + '</dd>';
    h += '<dt>Always filter</dt><dd>' + (m.filters.length ? '<ul>' + m.filters.map(function (f) { return '<li><code>' + esc(f.sql) + '</code>' + (f.keepsOut ? ' <span class="muted">keeps out ' + esc(f.keepsOut) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : '<span class="muted">none</span>') + '</dd>';
    h += '<dt>Date</dt><dd>' + (m.date.column ? '<code>' + esc(m.date.column) + '</code>' + (m.date.tz ? ' · days in ' + esc(m.date.tz) : '') : '<span class="muted">not set</span>') + '</dd>';
    if (m.grain) h += '<dt>Grain</dt><dd>' + esc(m.grain) + '</dd>';
    if (m.dimensions.length) h += '<dt>Split by</dt><dd>' + m.dimensions.map(function (d) { return '<code>' + esc(d) + '</code>'; }).join(' ') + '</dd>';
    if (!opts.compact && m.tables.length) h += '<dt>Tables</dt><dd>' + m.tables.map(function (t) { return '<code>' + esc(t) + '</code>'; }).join(' ') + '</dd>';
    if (m.owner) h += '<dt>Owner</dt><dd>' + esc(m.owner) + '</dd>';
    h += '</dl>';
    if (m.traps) h += '<p class="traps"><b>Known traps:</b> ' + esc(m.traps) + '</p>';
    return h + '</article>';
  }
  function schemaCard(c, opts) {
    opts = opts || {};
    var h = '<section class="card" id="schemaNotes"><div class="sec-head"><h2>Schema notes</h2>' + (opts.edit ? '<button class="btn small ghost" type="button" data-act="goschema">Edit schema notes</button>' : '') + '</div>';
    if (!c.tables.length && !c.relationships.length) return h + '<p class="muted">No tables yet. Add your tables, what one row is and which tables have many rows per row of another - that is how Canon spots joins that count the same order twice.</p>' + (opts.edit ? '<button class="btn small" type="button" data-act="goschema">Add tables</button>' : '') + '</section>';
    if (c.tables.length) {
      h += '<ul class="tlist">' + c.tables.map(function (t) {
        return '<li><div class="tl-head"><code>' + esc(t.name) + '</code><span class="muted small">' + (t.grain ? 'one row per ' + esc(t.grain.replace(/^one row per\s+/i, '')) : 'what one row is: not set') + (t.key ? ' · key <code>' + esc(t.key) + '</code>' : '') + '</span></div>' +
          '<p class="small">' + (t.columns.length ? esc(t.columns.slice(0, 16).join(', ')) + (t.columns.length > 16 ? ' and ' + (t.columns.length - 16) + ' more' : '') : '<span class="muted">columns not listed</span>') + '</p></li>';
      }).join('') + '</ul>';
    }
    if (c.relationships.length) {
      h += '<p class="lab" style="margin-top:14px">One-to-many</p><ul class="rels">' + c.relationships.map(function (r) { var a = C.refOfText(r.one), b = C.refOfText(r.many); return '<li>One <code>' + esc(a.table) + '</code> row has many <code>' + esc(b.table) + '</code> rows <span class="muted small">(' + esc(r.many) + ' → ' + esc(r.one) + ')</span></li>'; }).join('') + '</ul>';
    }
    return h + '</section>';
  }

  /* ---------------- first run ---------------- */

  function mockHtml() {
    return '<div class="mock" aria-hidden="true"><b>Revenue</b><div class="q">“What was revenue in Q3 2026?”</div><ul>' +
      '<li><span class="m-ok">✓</span><span>Source <code>SUM(ol.net_amount)</code></span></li>' +
      '<li><span class="m-ok">✓</span><span>Paid orders only</span></li>' +
      '<li><span class="m-bad">✗</span><span>Missing <code>refunded_at IS NULL</code></span></li>' +
      '<li><span class="m-bad">✗</span><span>Missing <code>is_test = false</code></span></li>' +
      '<li><span class="m-ok">✓</span><span>Days in New York time</span></li></ul>' +
      '<div class="v">✗ 2 problems: refunds included, test orders included</div></div>';
  }
  function startHtml() {
    var own = state.canon && !isSample(state.canon);
    var h = '<section class="hero">' + mockHtml() +
      '<p class="kicker"><span aria-hidden="true">📏</span> One definition of every metric</p>' +
      '<h1>Is the AI’s number right?</h1>' +
      '<p>Your team asks an AI for “revenue last quarter” and gets confident SQL that quietly counts refunds, test orders or the wrong date. Canon keeps one written definition of every metric - and checks each answer’s SQL against it, line by line.</p>' +
      '<div class="btns"><button class="btn primary big" type="button" data-act="try" data-id="refunds">Try the example shop</button>' +
      (own ? '<button class="btn ghost big" type="button" data-act="tab" data-tab="check">Open my canon</button>' : '<button class="btn ghost big" type="button" data-act="startown">Start my own canon</button>') + '</div>' +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><div><b>Checked on your device.</b> Nothing is sent anywhere unless you ask the AI to explain an answer or draft definitions - and then only what it shows you first.</div></div></section>';
    h += '<section class="card" style="margin-top:14px"><p class="lab">Three AI answers to check - one tap each</p><p class="muted small" style="margin:0">From ' + esc(D.NAME) + ', a made-up coffee shop with five metric definitions.</p><div class="demos">' +
      D.answers().map(function (a) {
        return '<button class="demo d-' + (a.tone === 'good' ? 'good' : 'bad') + '" type="button" data-act="try" data-id="' + esc(a.id) + '"><span class="tag">Made-up example</span><b>' + (a.tone === 'good' ? '✓ ' : '✗ ') + esc(a.title) + '</b><span>' + esc(a.blurb) + '</span></button>';
      }).join('') + '</div></section>';
    h += '<div class="grid3 how" style="margin-top:14px">' +
      [['📖', 'Write the canon', 'For each metric: its other names, the measure, the filters that always apply, the date column and its time zone, the grain and what it can be split by. Paste your DDL and AI can draft it.'],
       ['🔎', 'Check an answer', 'Paste the question and the SQL. Canon finds the metric and checks the source, filters, dates, double counting, the aggregate and the grouping - with a fix where it is safe.'],
       ['📤', 'Teach your AI', 'Export the canon as a Markdown glossary for your AI tool’s instructions, as dbt-style YAML or JSON - or share a read-only link with your team.']].map(function (s, i) {
        return '<div class="card"><div class="n" aria-hidden="true">' + (i + 1) + '</div><h2><span aria-hidden="true">' + s[0] + '</span> ' + esc(s[1]) + '</h2><p>' + esc(s[2]) + '</p></div>';
      }).join('') + '</div>';
    h += '<section class="card" style="margin-top:14px"><p class="lab">What it catches</p><ul class="chips">' +
      ['💸 Refunds counted as revenue', '🧪 Test orders and test accounts', '📅 created_at where paid_at is the canon', '🌐 Days in UTC, not your time zone', '✂️ BETWEEN cutting off the last day', '👯 A join that counts an order once per line', '➗ AVG where the canon divides', '🧭 Grouping by a dimension the metric doesn’t allow'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>';
    h += '<div class="privacy-line"><span aria-hidden="true">👀</span><div><b>Rules, not a judge.</b> Canon reads the SQL against what you wrote down. It doesn’t run the query or see your data, and “Can’t tell” means look by hand.</div></div>';
    return h + footer();
  }

  /* ---------------- the check ---------------- */

  function blankMetric() { return { id: '', name: '', synonyms: [], meaning: '', owner: '', tables: [], measure: '', filters: [{ sql: '', keepsOut: '' }], date: { column: '', tz: '' }, grain: '', dimensions: [], traps: '' }; }

  function checkHtml() {
    var c = canonNow();
    var h = sampleStrip();
    h += '<section class="card ask"><div class="sec-head"><h1>Check an answer</h1><span class="muted small">against ' + esc(c.name) + ' · ' + esc(plural(c.metrics.length, 'metric')) + '</span></div>';
    if (isSample(c) || state.preview) {
      h += '<div><p class="lab">Try an AI answer</p><ul class="tries">' + D.answers().map(function (a) { return '<li><button type="button" data-act="try" data-id="' + esc(a.id) + '" aria-pressed="' + (state.tryId === a.id) + '">' + (a.tone === 'good' ? '✓ ' : '✗ ') + esc(a.title) + '</button></li>'; }).join('') + '</ul></div>';
    }
    if (!c.metrics.length) h += '<div class="note"><p style="margin:0">This canon has no metrics yet. <button class="link-btn" type="button" data-act="new">Add your first metric</button> to check answers against it.</p></div>';
    h += '<label class="field"><span>The question</span><input class="input" id="q" maxlength="400" autocomplete="off" placeholder="What was revenue last quarter?" value="' + esc(state.q) + '"></label>';
    h += '<label class="field"><span>The SQL it came back with</span><textarea class="input code sql" id="sql" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="SELECT SUM(...) FROM ...">' + esc(state.sql) + '</textarea><small>Any dialect, comments and CTEs welcome. Checked here, on this device.</small></label>';
    h += '<div class="btns"><button class="btn" type="button" data-act="check">Check it</button><button class="btn ghost" type="button" data-act="clear">Clear</button></div></section>';
    if (state.result) h += resultHtml(state.result, c);
    else h += '<div class="privacy-line"><span aria-hidden="true">💡</span><div><b>What gets checked:</b> the column the measure reads, every required filter (in any equivalent form), the date column, its time zone and the range, joins that double count, the aggregate and the grouping.</div></div>';
    return h + footer();
  }

  function runCheck(opts) {
    opts = opts || {};
    var q = $('#q'), s = $('#sql');
    if (!opts.fromState) { if (q) state.q = q.value; if (s) state.sql = s.value; }
    keepDraft();
    var c = canonNow();
    if (!state.sql.trim()) { toast('Paste the SQL first.'); if (s) s.focus(); return; }
    state.result = C.analyze({ question: state.q, sql: state.sql }, c, { today: today(), metrics: state.picked || undefined });
    state.explain = null; state.open = {};
    draw();
    if (opts.scroll !== false) { var v = $('#verdict'); if (v) v.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
  }
  function openTry(id) {
    var a = D.answers().filter(function (x) { return x.id === id; })[0] || D.answers()[0];
    if (!state.canon) { state.canon = C.cleanCanon(D.canon()); keep(K_CANON, state.canon); }
    else if (!isSample(state.canon)) state.preview = C.cleanCanon(D.canon());
    state.q = a.question; state.sql = a.sql; state.tryId = a.id; state.picked = null; state.choosing = false;
    state.view = 'check';
    history.replaceState(null, '', BASE + '#check');
    runCheck({ scroll: false, fromState: true });
    var v = $('#verdict');
    if (v) setTimeout(function () { v.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, 30);
  }

  function resultHtml(r, c) {
    var v = r.verdict;
    var badge = v.kind === 'bad' ? '✗ ' + esc(plural(v.problems, 'problem')) : v.kind === 'ok' ? '✓ Matches the canon' : v.kind === 'unsure' ? '? Check by hand' : 'Nothing to check yet';
    var h = '<section class="card verdict k-' + esc(v.kind) + '" id="verdict" tabindex="-1" style="margin-top:14px"><span class="vbadge">' + badge + '</span><h1>' + esc(v.line) + '</h1>';
    if (r.metrics.length) {
      var how = r.metrics.map(function (m) { return m.how === 'sql' ? esc(m.name) + ' (from the SQL - the question names no metric)' : m.how === 'picked' ? esc(m.name) + ' (picked by hand)' : esc(m.name) + ' (“' + esc(m.phrase) + '” in the question)'; });
      h += '<p class="meta">Checked against ' + how.join(', ') + ' · ' + esc(C.niceDay(today())) + ' · on this device</p>';
    }
    h += againstHtml(r, c);
    if (r.notes.length) h += '<ul class="notes small">' + r.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    h += '</section>';
    if (!r.metrics.length) return h;
    var left = r.metrics.map(function (m, mi) { return metricResultHtml(m, mi); }).join('');
    var right = fixHtml(r.fix) + explainCard(r) + r.metrics.map(function (m) { var d = c.metrics.filter(function (x) { return x.id === m.id; })[0]; return d ? '<div><p class="lab" style="margin:4px 0 6px">The canon: ' + esc(d.name) + '</p>' + defCard(d, { edit: !SHARE && !state.preview, compact: true }) + '</div>' : ''; }).join('');
    return h + '<div class="dk-split dk-split-aside" style="margin-top:14px"><div class="stack">' + left + '</div><div class="stack">' + right + '</div></div>';
  }
  function againstHtml(r, c) {
    var ids = r.metrics.map(function (m) { return m.id; });
    var h = '<div><ul class="against">';
    if (state.choosing || (!r.metrics.length && c.metrics.length)) {
      h += c.metrics.map(function (m) { var on = ids.indexOf(m.id) >= 0; return '<li><button class="mchip" type="button" data-act="pick" data-id="' + esc(m.id) + '" aria-pressed="' + on + '">' + (on ? '✓ ' : '') + esc(m.name) + '</button></li>'; }).join('');
      if (state.picked) h += '<li><button class="link-btn" type="button" data-act="unpick">Match from the question again</button></li>';
    } else if (r.metrics.length) {
      h += '<li><button class="link-btn" type="button" data-act="choose">Check against a different metric</button></li>';
    }
    return h + '</ul></div>';
  }
  function metricResultHtml(m, mi) {
    var probs = m.problems, unsure = m.unsure, ok = m.checks.filter(function (x) { return x.verdict === 'match'; }).length;
    var sum = [probs ? plural(probs, 'problem') : '', unsure ? unsure + ' to check by hand' : '', ok ? ok + ' match' : ''].filter(Boolean).join(' · ');
    var h = '<section class="card"><div class="mhead"><h2>' + esc(m.name) + '</h2><span class="muted small">' + esc(sum) + '</span></div><ul class="clist">';
    m.checks.forEach(function (ck, ci) {
      var key = mi + ':' + ci;
      var open = state.open[key] !== undefined ? state.open[key] : ck.verdict !== 'match';
      h += '<li class="citem e-' + esc(ck.verdict) + '" id="ck-' + key.replace(':', '-') + '"><button class="copen" type="button" data-act="openck" data-key="' + key + '" aria-expanded="' + open + '">' +
        '<span class="ctop">' + vpill(ck.verdict) + '<span class="ct">' + titleHtml(ck.title) + '</span></span><span class="chev" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>' +
        '<span class="cwhy">' + esc(ck.why) + '</span></button>';
      if (open) {
        h += '<div class="cbody"><div class="side">' +
          (ck.sql ? '<div class="pane"><div class="ph"><span>In the SQL' + (ck.sql.note ? ' - ' + esc(ck.sql.note) : '') + '</span><span>line ' + Number(ck.sql.line) + '</span></div><pre tabindex="0">' + esc(ck.sql.text) + '</pre></div>' : '<div class="pane empty"><div class="ph"><span>In the SQL</span></div><pre>Nothing in the SQL for this.</pre></div>') +
          (ck.canon ? '<div class="pane canonpane"><div class="ph"><span>In the canon</span></div><pre tabindex="0">' + esc(ck.canon) + '</pre></div>' : '') +
          '</div></div>';
      }
      h += '</li>';
    });
    h += '</ul>';
    if (m.notChecked.length) h += '<p class="notchecked">Not checked: ' + esc(m.notChecked.join('; ')) + '.</p>';
    return h + '</section>';
  }
  /** "Required filter: orders.status = 'paid'" -> the SQL part as code. */
  function titleHtml(t) {
    var i = t.indexOf(': ');
    return i > 0 ? esc(t.slice(0, i + 1)) + ' <code>' + esc(t.slice(i + 2)) + '</code>' : esc(t);
  }
  function fixHtml(fix) {
    if (!fix || (!fix.sql && !fix.skipped.length)) return '';
    var h = '<section class="card" id="fix"><h2>Suggested fix</h2>';
    if (fix.sql) {
      h += '<p class="small muted">A suggestion - nothing is changed unless you copy it. Read it, then run it yourself.</p>';
      h += '<ul class="changes">' + fix.changes.map(function (ch) { return '<li><span class="plus" aria-hidden="true">+</span>' + esc(ch.what) + (ch.text ? ': <code>' + esc(ch.text) + '</code>' : '') + ' <span class="muted small">(line ' + Number(ch.line) + ')</span></li>'; }).join('') + '</ul>';
      h += '<div class="diff" tabindex="0" role="region" aria-label="The fixed SQL, with changed lines marked">' + fix.diff.map(function (d) { return '<div class="' + (d.k === '+' ? 'a' : d.k === '-' ? 'd' : '') + '"><span class="mk" aria-hidden="true">' + (d.k === ' ' ? '' : esc(d.k)) + '</span>' + (d.k === '+' ? '<span class="vh">added: </span>' : d.k === '-' ? '<span class="vh">removed: </span>' : '') + esc(d.t) + '</div>'; }).join('') + '</div>';
      h += '<div class="btns" style="margin-top:10px"><button class="btn small" type="button" data-act="copyfix">Copy the fixed SQL</button><button class="btn small ghost" type="button" data-act="checkfix">Check the fixed SQL</button></div>';
    }
    if (fix.skipped.length) h += '<p class="small" style="margin:12px 0 4px"><b>Not fixed automatically</b> - change these by hand:</p><ul class="skipped">' + fix.skipped.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    return h + '</section>';
  }
  function explainCard(r) {
    var h = '<section class="card" id="explainCard"><h2><span aria-hidden="true">✨</span> Explain this answer</h2>';
    if (state.explain) return h + explanationHtml(state.explain) + '</section>';
    return h + '<p class="small muted">What the SQL actually computes, in plain words, and how it differs from the canon. Sends the question, the SQL and only the ' + (r.metrics.length > 1 ? 'definitions' : 'definition') + ' it was checked against - a cent or two of AI credit.</p><button class="btn ai" type="button" data-act="explain">Explain this answer</button></section>';
  }
  function explanationHtml(x) {
    var word = { matches: '✓ It computes the canon’s metric', differs: '≠ It computes something else', unclear: '? It depends on things the SQL doesn’t show' }[x.verdict];
    var h = '<div class="expl"><p class="lab" style="margin:0">' + esc(word) + '</p><p style="margin:0">' + esc(x.computes) + '</p>';
    if (x.differences.length) h += '<ul class="diffs">' + x.differences.map(function (d) { return '<li><b>' + esc(d.what) + '</b>' + (d.canon ? '<p><span class="muted">Canon:</span> ' + esc(d.canon) + '</p>' : '') + (d.sql ? '<p><span class="muted">The SQL:</span> ' + esc(d.sql) + '</p>' : '') + (d.effect ? '<p><span class="muted">Effect:</span> ' + esc(d.effect) + '</p>' : '') + '</li>'; }).join('') + '</ul>';
    if (x.fix) h += '<p class="small" style="margin:0"><b>To match:</b> ' + esc(x.fix) + '</p>';
    return h + '<p class="small muted" style="margin:0">From an AI model - a second opinion, not a verdict. The rules above are the check.</p></div>';
  }

  /* ---------------- the canon ---------------- */

  function canonHtml() {
    var c = canonNow(), own = !state.preview;
    var h = sampleStrip();
    h += '<section class="card"><div class="sec-head"><div><p class="lab">The canon</p><h1>' + esc(c.name) + '</h1></div>' + (own ? '<button class="btn small ghost" type="button" data-act="rename">Rename</button>' : '') + '</div>';
    h += '<p class="muted" style="margin:0 0 4px">' + esc(plural(c.metrics.length, 'metric')) + ' · ' + esc(plural(c.tables.length, 'table')) + ' in the schema notes</p><p style="margin:0 0 12px" data-sync>' + syncLine() + '</p>';
    if (own) h += '<div class="btns"><button class="btn" type="button" data-act="new">+ Add a metric</button><button class="btn ai" type="button" data-act="draft">✨ Draft from my schema</button><button class="btn ghost" type="button" data-act="goschema">Schema notes</button></div>';
    h += '</section>';
    if (!c.metrics.length) h += '<section class="card" style="margin-top:14px"><h2>Write your first definition</h2><p class="muted">Start with the number people ask for most - usually revenue. Write it the way your finance team would: what to add up, which rows never count, which date it belongs to.</p><div class="btns"><button class="btn" type="button" data-act="new">Add a metric</button><button class="btn ghost" type="button" data-act="try" data-id="refunds">See the example first</button></div></section>';
    else h += '<div class="mgrid" style="margin-top:14px">' + c.metrics.map(function (m) { return defCard(m, { edit: own }); }).join('') + '</div>';
    h += '<div style="margin-top:14px">' + schemaCard(c, { edit: own }) + '</div>';
    return h + footer();
  }

  function filterRow(f, i) {
    return '<div class="frow" data-frow="' + i + '"><label class="field"><span>Condition</span><input class="input code" data-f="sql" value="' + esc(f.sql) + '" placeholder="orders.status = \'paid\'" spellcheck="false" autocapitalize="off"></label>' +
      '<label class="field"><span>Keeps out</span><input class="input" data-f="keepsOut" value="' + esc(f.keepsOut) + '" placeholder="unpaid orders" maxlength="60"></label>' +
      '<button class="btn small ghost" type="button" data-act="rmfilter" data-i="' + i + '" aria-label="Remove this filter">Remove</button></div>';
  }
  var TZS = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
  function editHtml() {
    var m = state.edit, isNew = state.editIsNew;
    var h = sampleStrip();
    h += '<section class="card"><div class="sec-head"><h1>' + (isNew ? 'A new metric' : 'Edit ' + esc(m.name || 'metric')) + '</h1><button class="btn small ghost" type="button" data-act="tab" data-tab="canon">Cancel</button></div>';
    h += '<form class="form" id="editForm" novalidate>';
    h += '<div class="two"><label class="field"><span>Name</span><input class="input" id="e-name" maxlength="60" value="' + esc(m.name) + '" placeholder="Revenue" required></label>' +
      '<label class="field"><span>Other names people use</span><input class="input" id="e-syn" value="' + esc(m.synonyms.join(', ')) + '" placeholder="sales, net sales, GMV"><small>Comma-separated. A question naming any of these is checked against this metric.</small></label></div>';
    h += '<label class="field"><span>What it means</span><textarea class="input" id="e-meaning" rows="3" maxlength="600" placeholder="Money we kept from paid orders, after discounts, before tax and shipping.">' + esc(m.meaning) + '</textarea></label>';
    h += '<div class="two"><label class="field"><span>Measure</span><input class="input code" id="e-measure" value="' + esc(m.measure) + '" placeholder="SUM(order_lines.net_amount)" spellcheck="false" autocapitalize="off"><small>The aggregate, with table.column names. A ratio works too: SUM(...) / COUNT(DISTINCT ...).</small></label>' +
      '<label class="field"><span>Source tables</span><input class="input code" id="e-tables" value="' + esc(m.tables.join(', ')) + '" placeholder="order_lines, orders" spellcheck="false" autocapitalize="off"></label></div>';
    h += '<fieldset class="field" style="border:0;padding:0;margin:0"><legend style="font-weight:700;font-size:.92rem;margin-bottom:6px">Required filters - they always apply</legend><div class="stack" id="filters">' + m.filters.map(filterRow).join('') + '</div><div><button class="btn small ghost" type="button" data-act="addfilter" style="margin-top:8px">+ Add a filter</button></div><small class="muted">One condition each: <code>orders.is_test = false</code>, <code>order_lines.refunded_at IS NULL</code>, <code>orders.status IN (\'paid\', \'shipped\')</code>. Canon accepts equivalent forms in the SQL (IS FALSE, NOT is_test, &lt;&gt; true).</small></fieldset>';
    h += '<div class="two"><label class="field"><span>Date column</span><input class="input code" id="e-date" value="' + esc(m.date.column) + '" placeholder="orders.paid_at" spellcheck="false" autocapitalize="off"></label>' +
      '<label class="field"><span>Time zone its days are in</span><input class="input" id="e-tz" list="tzs" value="' + esc(m.date.tz) + '" placeholder="America/New_York" autocapitalize="off"><datalist id="tzs">' + TZS.map(function (z) { return '<option value="' + esc(z) + '">'; }).join('') + '</datalist><small>Leave it empty or UTC when days are UTC.</small></label></div>';
    h += '<div class="two"><label class="field"><span>Grain</span><input class="input" id="e-grain" maxlength="60" value="' + esc(m.grain) + '" placeholder="one row per order line"></label>' +
      '<label class="field"><span>Can be split by</span><input class="input code" id="e-dims" value="' + esc(m.dimensions.join(', ')) + '" placeholder="orders.channel, products.category" spellcheck="false" autocapitalize="off"><small>Grouping by anything else is flagged.</small></label></div>';
    h += '<div class="two"><label class="field"><span>Owner</span><input class="input" id="e-owner" maxlength="60" value="' + esc(m.owner) + '" placeholder="Priya, Finance"></label>' +
      '<label class="field"><span>Known traps</span><textarea class="input" id="e-traps" rows="2" maxlength="1000" placeholder="orders.total includes tax and shipping - never sum it next to order lines.">' + esc(m.traps) + '</textarea></label></div>';
    h += '<div id="hints" aria-live="polite"></div><div id="editErr"></div>';
    h += '<div class="btns"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-act="tab" data-tab="canon">Cancel</button>' + (!isNew ? '<button class="btn danger" type="button" data-act="delmetric">Delete this metric</button>' : '') + '</div>';
    h += '</form></section>';
    if (isSample(canonNow())) h += '<p class="small muted" style="margin-top:10px">Edits to the made-up example stay on this device.</p>';
    return h + footer();
  }
  function readEdit() {
    var m = state.edit, v = function (id) { var el = $('#' + id); return el ? el.value : ''; };
    m.name = v('e-name'); m.synonyms = v('e-syn').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    m.meaning = v('e-meaning'); m.measure = v('e-measure'); m.tables = v('e-tables').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    m.date = { column: v('e-date').trim(), tz: v('e-tz').trim() }; m.grain = v('e-grain'); m.dimensions = v('e-dims').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    m.owner = v('e-owner'); m.traps = v('e-traps');
    m.filters = $$('[data-frow]').map(function (row) { return { sql: $('[data-f="sql"]', row).value, keepsOut: $('[data-f="keepsOut"]', row).value }; });
  }
  var hintTimer = null;
  function drawHints() {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      var box = $('#hints'); if (!box) return;
      var m = C.cleanMetric(Object.assign({}, state.edit, { filters: state.edit.filters.filter(function (f) { return f.sql.trim(); }) }), { loose: true });
      var hints = m ? C.lintMetric(canonNow(), m) : [];
      if (state.edit.date.tz && !C.cleanMetric({ name: 'x', measure: 'COUNT(*)', date: { tz: state.edit.date.tz } }).date.tz) hints.push({ text: 'Write the time zone as an IANA name, like America/New_York.' });
      box.innerHTML = hints.length ? '<ul class="hints">' + hints.map(function (x) { return '<li>' + esc(x.text) + '</li>'; }).join('') + '</ul>' : '';
    }, 180);
  }
  function saveEdit() {
    readEdit();
    var c = canonNow(), m = state.edit;
    var cleaned = C.cleanMetric(Object.assign({}, m, { filters: m.filters.filter(function (f) { return f.sql.trim(); }) }));
    if (!cleaned) { $('#editErr').innerHTML = '<p class="err" role="alert">A metric needs a name and a measure.</p>'; return; }
    var taken = {};
    c.metrics.forEach(function (x) { if (state.editIsNew || x.id !== m.id) taken[x.id] = 1; });
    if (c.metrics.some(function (x) { return x.name.toLowerCase() === cleaned.name.toLowerCase() && (state.editIsNew || x.id !== m.id); })) { $('#editErr').innerHTML = '<p class="err" role="alert">There is already a metric called ' + esc(cleaned.name) + '.</p>'; return; }
    if (state.editIsNew) { if (c.metrics.length >= C.LIMITS.metrics) { $('#editErr').innerHTML = '<p class="err" role="alert">A canon holds up to ' + C.LIMITS.metrics + ' metrics.</p>'; return; } cleaned.id = C.idFor(cleaned.name, taken); }
    else cleaned.id = m.id;
    cleaned.updatedAt = Date.now();
    var i = c.metrics.map(function (x) { return x.id; }).indexOf(cleaned.id);
    if (i >= 0) c.metrics[i] = cleaned; else c.metrics.push(cleaned);
    state.edit = null; state.result = null;
    saveCanon();
    go('canon');
    toast('Saved ' + cleaned.name + '.');
    setTimeout(function () { var el = $('#m-' + cleaned.id); if (el) el.scrollIntoView({ block: 'center' }); }, 30);
  }

  /* ---------------- schema notes ---------------- */

  function schemaHtml() {
    var c = canonNow();
    if (!state.schema) state.schema = { tables: JSON.parse(JSON.stringify(c.tables)), relationships: JSON.parse(JSON.stringify(c.relationships)) };
    var s = state.schema;
    var h = sampleStrip();
    h += '<section class="card"><div class="sec-head"><h1>Schema notes</h1><button class="btn small ghost" type="button" data-act="tab" data-tab="canon">Cancel</button></div>';
    h += '<p class="muted">Your tables, what one row of each is, its key, and which tables have many rows for one row of another. Canon uses the one-to-many links to catch joins that count the same order twice.</p>';
    h += '<details class="why"' + (s.tables.length ? '' : ' open') + '><summary>Fill it from DDL (free, on this device)</summary><label class="field"><span>CREATE TABLE statements, a DESCRIBE output, or lines like <code>orders: id, customer_id, status</code></span><textarea class="input code" id="ddl" rows="7" spellcheck="false" autocapitalize="off" placeholder="CREATE TABLE orders (&#10;  id bigint PRIMARY KEY,&#10;  customer_id bigint REFERENCES customers(id),&#10;  ...&#10;);"></textarea></label>' +
      '<div class="btns" style="margin-top:8px"><button class="btn small" type="button" data-act="readddl">Read it</button><label class="btn small ghost filepick">Choose a .sql file<input type="file" id="ddlFile" accept=".sql,.txt,.ddl,text/plain"></label></div><div id="ddlOut">' + ddlPreview() + '</div></details>';
    h += '<p class="lab" style="margin-top:16px">Tables</p><div class="stack" id="tablesEdit">' + s.tables.map(function (t, i) {
      return '<div class="frow" data-trow="' + i + '" style="grid-template-columns:minmax(0,1fr)"><div class="two" style="display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><label class="field"><span>Table</span><input class="input code" data-t="name" value="' + esc(t.name) + '" spellcheck="false" autocapitalize="off"></label><label class="field"><span>One row per</span><input class="input" data-t="grain" value="' + esc(t.grain) + '" placeholder="order"></label><label class="field"><span>Key</span><input class="input code" data-t="key" value="' + esc(t.key) + '" placeholder="id" spellcheck="false" autocapitalize="off"></label></div>' +
        '<label class="field"><span>Columns</span><textarea class="input code" data-t="columns" rows="2" spellcheck="false" autocapitalize="off" placeholder="id, customer_id, status">' + esc(t.columns.join(', ')) + '</textarea></label><div><button class="btn small ghost" type="button" data-act="rmtable" data-i="' + i + '">Remove table</button></div></div>';
    }).join('') + '</div><div><button class="btn small ghost" type="button" data-act="addtable" style="margin-top:8px">+ Add a table</button></div>';
    h += '<p class="lab" style="margin-top:16px">One-to-many</p><div class="stack" id="relsEdit">' + s.relationships.map(function (r, i) {
      return '<div class="frow" data-rrow="' + i + '"><label class="field"><span>One row of (table.key)</span><input class="input code" data-r="one" value="' + esc(r.one) + '" placeholder="orders.id" spellcheck="false" autocapitalize="off"></label><label class="field"><span>…has many of (table.column)</span><input class="input code" data-r="many" value="' + esc(r.many) + '" placeholder="order_lines.order_id" spellcheck="false" autocapitalize="off"></label><button class="btn small ghost" type="button" data-act="rmrel" data-i="' + i + '">Remove</button></div>';
    }).join('') + '</div><div><button class="btn small ghost" type="button" data-act="addrel" style="margin-top:8px">+ Add a one-to-many link</button></div>';
    h += '<div id="schemaErr"></div><div class="btns" style="margin-top:16px"><button class="btn" type="button" data-act="saveschema">Save schema notes</button><button class="btn ghost" type="button" data-act="tab" data-tab="canon">Cancel</button></div></section>';
    return h + footer();
  }
  function readSchemaForm() {
    var s = state.schema;
    s.tables = $$('[data-trow]').map(function (row) { var g = function (k) { return $('[data-t="' + k + '"]', row).value; }; return { name: g('name').trim(), grain: g('grain').trim(), key: g('key').trim(), columns: g('columns').split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean) }; });
    s.relationships = $$('[data-rrow]').map(function (row) { return { one: $('[data-r="one"]', row).value.trim(), many: $('[data-r="many"]', row).value.trim() }; });
  }
  function readDdl() {
    var ta = $('#ddl');
    state.schemaParse = C.parseSchemaText(ta ? ta.value : '');
    var out = $('#ddlOut'); if (out) out.innerHTML = ddlPreview();
  }
  function ddlPreview() {
    var p = state.schemaParse;
    if (!p) return '';
    if (!p.tables.length) return '<p class="err" role="alert">No tables found in that. Paste CREATE TABLE statements, a describe output, or one line per table: <code>orders: id, status, total</code>.</p>';
    var cols = p.tables.reduce(function (n, t) { return n + t.columns.length; }, 0), guessed = p.relationships.filter(function (r) { return r.inferred; }).length;
    return '<div class="note" style="margin-top:10px"><p style="margin:0 0 6px">Found <b>' + esc(plural(p.tables.length, 'table')) + '</b>, ' + esc(plural(cols, 'column')) + ' and ' + esc(plural(p.relationships.length, 'one-to-many link')) + (guessed ? ' (' + guessed + ' guessed from <code>_id</code> names - check them)' : '') + ': ' + esc(p.tables.map(function (t) { return t.name; }).join(', ')) + '.</p><button class="btn small" type="button" data-act="addddl">Add them to the notes</button></div>';
  }

  /* ---------------- export, import, share ---------------- */

  function exportText(kind) {
    var c = canonNow();
    if (kind === 'yaml') return C.toYaml(c, today());
    if (kind === 'json') return C.exportJson(c, today());
    return C.toMarkdown(c, today());
  }
  function exportHtml() {
    var c = canonNow(), k = state.exportKind;
    var h = sampleStrip();
    h += '<section class="card"><div class="sec-head"><h1>Teach your AI tool</h1></div>';
    h += '<p class="muted">Paste the canon into your AI tool’s custom instructions or project knowledge, so it answers with your definitions next time.</p>';
    h += '<div class="seg" role="group" aria-label="Format">' + [['md', 'Markdown'], ['yaml', 'YAML (dbt-style)'], ['json', 'JSON']].map(function (x) { return '<button type="button" data-act="exportkind" data-k="' + x[0] + '" aria-pressed="' + (k === x[0]) + '">' + esc(x[1]) + '</button>'; }).join('') + '</div>';
    h += '<p class="small muted" style="margin:10px 0">' + esc(k === 'md' ? 'A glossary written for an AI to follow: each metric’s measure, required filters, date and time zone, grain and traps.' : k === 'yaml' ? 'dbt-style: shaped like a dbt semantic layer file so it reads familiarly. It is not checked against dbt - treat it as a starting point, not a drop-in file.' : 'Everything, exactly - for a backup, or to import on another device or into a teammate’s Canon.') + '</p>';
    h += '<pre class="out" tabindex="0" role="region" aria-label="Export preview">' + esc(exportText(k)) + '</pre>';
    h += '<div class="btns" style="margin-top:10px"><button class="btn" type="button" data-act="copyexport">Copy</button><button class="btn ghost" type="button" data-act="dlexport">Download .' + (k === 'md' ? 'md' : k === 'yaml' ? 'yaml' : 'json') + '</button></div></section>';
    if (!SHARE && !state.preview) h += importHtml() + shareHtml(c);
    return h + footer();
  }
  function importHtml() {
    var p = state.importPreview;
    var h = '<section class="card" style="margin-top:14px"><h2>Import a canon (JSON)</h2><p class="muted small">A file exported from Canon - from another device or a teammate. Shown first; nothing changes until you choose.</p>';
    h += '<div class="btns"><label class="btn small ghost filepick">Choose a .json file<input type="file" id="importFile" accept=".json,application/json"></label></div>';
    if (p && p.error) h += '<p class="err" role="alert">' + esc(p.error) + '</p>';
    if (p && p.canon) {
      h += '<div class="note" style="margin-top:10px"><p style="margin:0 0 6px"><b>' + esc(p.canon.name) + '</b>: ' + esc(plural(p.counts.metrics, 'metric')) + ', ' + esc(plural(p.counts.tables, 'table')) + ', ' + esc(plural(p.counts.relationships, 'one-to-many link')) + '.</p>';
      if (p.skipped.length) h += '<p class="small" style="margin:0 0 6px">Left out: ' + esc(p.skipped.slice(0, 5).map(function (s) { return s.what + ' (' + s.why + ')'; }).join('; ')) + (p.skipped.length > 5 ? ' and ' + (p.skipped.length - 5) + ' more' : '') + '.</p>';
      h += '<div class="btns"><button class="btn small" type="button" data-act="importadd">Add to my canon</button><button class="btn small ghost" type="button" data-act="importreplace">Replace my canon</button><button class="btn small ghost" type="button" data-act="importcancel">Cancel</button></div></div>';
    }
    return h + '</section>';
  }
  function readImportFile(f) {
    if (f.size > C.LIMITS.importChars) { state.importPreview = { error: 'That file is over 1 MB - a canon is much smaller.' }; draw(); return; }
    f.text().then(function (t) {
      try { state.importPreview = C.importJson(t); } catch (e) { state.importPreview = { error: e.message }; }
      draw();
    });
  }
  function shareHtml(c) {
    var h = '<section class="card" style="margin-top:14px" id="share"><h2>Share a read-only link</h2><p class="muted small">So your team can read the definitions - no account needed to open it.</p>';
    h += '<ul class="reveals"><li><b>Shows:</b> the canon’s name, every metric definition (with the owners you wrote down) and the schema notes - as they are now, so edits you sync show up.</li><li><b>Never shows:</b> your account or email, your other links, or any question or SQL you check.</li><li>Lasts 7, 30 or 90 days. Close it any time; up to ' + C.LIMITS.sharesOpen + ' open at once. Anyone with the link can read it - treat it like a document link.</li></ul>';
    if (!signedIn()) return h + '<p style="margin-top:12px">Share links and sync need a free account (it comes with $2 of AI credit, and one account works across every app on this site).</p><button class="btn" type="button" data-act="signin-share">Create a free account</button></section>';
    if (isSample(c)) return h + '<p style="margin-top:12px">This is the made-up example. Make it yours (or start your own) to share it.</p><div class="btns"><button class="btn small" type="button" data-act="makemine">Make this mine</button></div></section>';
    if (state.me && !state.me.sync) return h + '<p class="err" style="margin-top:12px">Sharing isn’t available right now.</p></section>';
    h += '<div class="row" style="margin-top:12px"><label class="field" style="flex:0 1 180px"><span>Lasts</span><select class="input" id="shareDays">' + C.LIMITS.shareDays.map(function (d) { return '<option value="' + d + '"' + (d === 30 ? ' selected' : '') + '>' + d + ' days</option>'; }).join('') + '</select></label><button class="btn" type="button" data-act="mklink" style="align-self:end">Make a read-only link</button></div><div id="shareErr"></div>';
    if (state.lastLink) {
      h += '<div class="note" style="margin-top:12px"><p style="margin:0 0 6px"><b>Your link</b> - copy it now; it is kept on this device too.</p><div class="linkbox"><input class="input" id="linkOut" readonly value="' + esc(state.lastLink) + '" aria-label="The share link"><button class="btn small" type="button" data-act="copylink">Copy</button>' + (navigator.share ? '<button class="btn small ghost" type="button" data-act="sharelink">Share…</button>' : '') + '</div></div>';
    }
    var links = state.links;
    if (links === null) { loadLinks(); h += '<p class="muted small" style="margin-top:12px">Loading your links…</p>'; }
    else if (links.length) {
      var codes = recall(K_LINKS) || {};
      h += '<p class="lab" style="margin-top:16px">Open links</p><ul class="links">' + links.map(function (l) {
        return '<li><span class="lmeta">Made ' + esc(niceIso(l.createdAt)) + ' · closes ' + esc(niceIso(l.expiresAt)) + ' · opened ' + esc(plural(l.opens, 'time')) + '</span><span class="btns">' + (codes[l.id] ? '<button class="btn small ghost" type="button" data-act="copyold" data-id="' + esc(l.id) + '">Copy</button>' : '') + '<button class="btn small danger" type="button" data-act="closelink" data-id="' + esc(l.id) + '">Close</button></span></li>';
      }).join('') + '</ul>';
    }
    return h + '</section>';
  }
  function linkUrl(code) { return location.origin + BASE + 's/' + code; }
  function loadLinks() {
    api('GET', 'api/shares').then(function (r) { state.links = r.links; if (state.view === 'export') draw(); }).catch(function () { state.links = []; if (state.view === 'export') draw(); });
  }
  function makeLink() {
    var days = Number(($('#shareDays') || {}).value || 30);
    var b = $('[data-act="mklink"]'); if (b) b.disabled = true;
    var go2 = function () { return api('POST', 'api/shares', { days: days }); };
    (state.syncState === 'synced' ? Promise.resolve() : push(0)).then(go2).then(function (r) {
      var codes = recall(K_LINKS) || {};
      codes[r.link.id] = r.code; keep(K_LINKS, codes);
      state.lastLink = linkUrl(r.code); state.links = null;
      draw(); toast('Link made - copy it below.');
    }).catch(function (e) { if (b) b.disabled = false; showError(e, $('#shareErr')); });
  }

  /* ---------------- a shared canon (s/<code>) ---------------- */

  function sharedHtml() {
    if (state.shareErr) return '<section class="card" style="margin-top:20px"><h1>This link isn’t open</h1><p>' + esc(state.shareErr) + '</p><a class="btn" href="' + esc(BASE) + '">Make your own canon</a></section>' + footer();
    if (!state.shared) return '<section class="card" style="margin-top:20px"><p class="muted" role="status">Opening the shared canon…</p></section>';
    var c = state.shared.canon;
    var h = '<section class="card"><p class="lab"><span aria-hidden="true">📖</span> Read-only · shared with you</p><h1>' + esc(c.name) + '</h1>';
    h += '<p class="muted" style="margin:0 0 12px">' + esc(plural(c.metrics.length, 'metric')) + (c.updatedAt ? ' · updated ' + esc(C.niceDay(new Date(c.updatedAt).toISOString().slice(0, 10))) : '') + ' · this link closes ' + esc(niceIso(state.shared.expiresAt)) + '</p>';
    h += '<div class="row spread"><div class="seg" role="group" aria-label="View">' + [['defs', 'Definitions'], ['check', 'Check an answer']].map(function (x) { return '<button type="button" data-act="sharetab" data-k="' + x[0] + '" aria-pressed="' + (state.shareTab === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div><button class="btn small ghost" type="button" data-act="copymdshared">Copy as Markdown</button></div></section>';
    if (state.shareTab === 'check') {
      h += checkHtml().replace(footer(), '');
    } else {
      h += '<div class="mgrid" style="margin-top:14px">' + c.metrics.map(function (m) { return defCard(m); }).join('') + '</div>';
      h += '<div style="margin-top:14px">' + schemaCard(c) + '</div>';
    }
    h += '<div class="privacy-line"><span aria-hidden="true">📏</span><div><b>Keep your own canon.</b> Write your company’s definitions and check AI answers against them - free, on your device. <a href="' + esc(BASE) + '">Open Canon</a></div></div>';
    return h + footer();
  }
  function loadShared() {
    api('GET', 'api/s/' + SHARE).then(function (r) {
      var c = C.cleanCanon(r.canon);
      c.sample = false;
      state.shared = { canon: c, expiresAt: r.expiresAt };
      draw();
    }).catch(function (e) { state.shareErr = e.message || 'That link isn’t open any more.'; draw(); });
  }

  /* ---------------- the AI sheets ---------------- */

  function explainShown(p) {
    var out = ['Question: ' + (p.question || '(none)'), '', 'SQL:', p.sql, ''];
    p.metrics.forEach(function (m) {
      out.push('Definition: ' + m.name + (m.synonyms.length ? ' (also: ' + m.synonyms.join(', ') + ')' : ''));
      out.push('  Measure: ' + m.measure);
      m.filters.forEach(function (f) { out.push('  Required filter: ' + f.sql + (f.keepsOut ? ' (keeps out ' + f.keepsOut + ')' : '')); });
      if (m.date.column) out.push('  Date: ' + m.date.column + (m.date.tz ? ', ' + m.date.tz : ''));
      if (m.grain) out.push('  Grain: ' + m.grain);
      if (m.dimensions.length) out.push('  Dimensions: ' + m.dimensions.join(', '));
      if (m.traps) out.push('  Traps: ' + m.traps);
    });
    out.push('', 'The rules’ verdicts:');
    p.checks.forEach(function (c) { out.push('  ' + c.metric + ' / ' + c.check + ': ' + c.verdict); });
    return out.join('\n');
  }
  function openExplain() {
    var p = C.explainPayload(state.result, canonNow());
    if (!p) { toast('Check an answer against a metric first.'); return; }
    var shown = explainShown(p);
    var lead = '<p class="muted">Sends the question, the SQL and only the ' + (p.metrics.length > 1 ? esc(plural(p.metrics.length, 'definition')) : 'definition') + ' it was checked against - not the rest of your canon, not your schema notes. Nothing is stored.</p>';
    if (!signedIn()) {
      sheet('<h2>✨ Explain this answer</h2>' + lead + '<p class="small muted" style="margin:12px 0 6px"><b>Exactly what would be sent:</b></p><pre class="sent-pre" tabindex="0">' + esc(shown) + '</pre>' +
        '<p class="small muted" style="margin-top:12px">It uses a cent or two of AI credit, so it needs a free account (it comes with $2). Checking, the canon and the exports stay free, with no account.</p>' +
        '<div class="btns" style="margin-top:12px"><button class="btn" type="button" data-act="signin-explain">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button></div>');
      return;
    }
    sheet('<h2>✨ Explain this answer</h2><div id="xLead">' + lead + '</div><details class="why"><summary id="xSum">Exactly what will be sent</summary><pre class="sent-pre" tabindex="0">' + esc(shown) + '</pre></details><div id="xErr"></div><div class="btns" id="xActs" style="margin-top:10px"><button class="btn ai" type="button" id="xSend">Explain it</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div><p class="small muted" id="xCost" style="margin-top:8px">A cent or two of AI credit.</p><div id="xOut"></div>', function (root) {
      var send = $('#xSend', root);
      send.addEventListener('click', function () {
        send.disabled = true; send.textContent = 'Asking…';
        api('POST', 'api/explain', p).then(function (r) {
          state.explain = r.explanation;
          $('#xActs', root).hidden = true; $('#xLead', root).hidden = true; $('#xCost', root).hidden = true; $('#xSum', root).textContent = 'What was sent';
          $('#xOut', root).innerHTML = explanationHtml(r.explanation) + '<div class="btns" style="margin-top:12px"><button class="btn ghost" type="button" data-act="closesheet">Done</button></div>';
          var card = $('#explainCard'); if (card) card.innerHTML = '<h2><span aria-hidden="true">✨</span> Explain this answer</h2>' + explanationHtml(r.explanation);
          loadMe();
        }).catch(function (err) { send.disabled = false; send.textContent = 'Explain it'; meteredError(err, $('#xErr', root), function () { openExplain(); }, 'Explaining an answer uses a cent or two of AI credit, so it needs a free account (it comes with $2).'); });
      });
    });
  }

  function draftShown(p) {
    var out = ['Business: ' + (p.business || '(not given)'), ''];
    p.tables.forEach(function (t) { out.push(t.name + (t.key ? ' (key ' + t.key + ')' : '') + ': ' + t.columns.map(function (c) { return c.name + (c.type ? ' ' + c.type : ''); }).join(', ')); });
    if (p.relationships.length) { out.push(''); p.relationships.forEach(function (r) { out.push(r.one + ' -> many ' + r.many); }); }
    return out.join('\n');
  }
  function openDraft() {
    sheet('<h2>✨ Draft definitions from my schema</h2><p class="muted">Paste your tables and columns. Canon reads them here, on your device, and sends only the table and column names (with their types) and your one sentence - no data, nothing else you paste.</p>' +
      '<label class="field"><span>Tables and columns</span><textarea class="input code" id="dSchema" rows="7" spellcheck="false" autocapitalize="off" placeholder="CREATE TABLE orders (&#10;  id bigint PRIMARY KEY,&#10;  status text,&#10;  ...&#10;);&#10;&#10;or: orders: id, customer_id, status, total">' + esc(state.draftText) + '</textarea><small>CREATE TABLE statements, a DESCRIBE or \\d output, information_schema rows, or one line per table.</small></label>' +
      '<label class="field" style="margin-top:10px"><span>One sentence about the business</span><input class="input" id="dBiz" maxlength="400" value="' + esc(state.draftBiz) + '" placeholder="An online coffee roaster selling beans, gear and subscriptions."></label>' +
      '<div id="dRead"></div><div id="dErr"></div><div class="btns" id="dActs" style="margin-top:10px"><button class="btn ghost" type="button" id="dParse">Read it</button></div><div id="dOut"></div>', function (root) {
      var payload = null;
      $('#dParse', root).addEventListener('click', function () {
        state.draftText = $('#dSchema', root).value; state.draftBiz = $('#dBiz', root).value;
        payload = C.draftPayload(state.draftText, state.draftBiz);
        var box = $('#dRead', root);
        if (!payload) { box.innerHTML = '<p class="err" role="alert">No tables and columns found in that. Paste CREATE TABLE statements, a describe output, or lines like <code>orders: id, status, total</code>.</p>'; return; }
        var cols = payload.tables.reduce(function (n, t) { return n + t.columns.length; }, 0);
        box.innerHTML = '<div class="note" style="margin-top:10px"><p style="margin:0">Found <b>' + esc(plural(payload.tables.length, 'table')) + '</b> and ' + esc(plural(cols, 'column')) + '.</p></div><details class="why"><summary>Exactly what will be sent</summary><pre class="sent-pre" tabindex="0">' + esc(draftShown(payload)) + '</pre></details>';
        var acts = $('#dActs', root);
        if (!signedIn()) {
          acts.innerHTML = '<p class="small muted" style="width:100%;margin:0">Drafting uses a few cents of AI credit, so it needs a free account (it comes with $2). Writing definitions by hand and filling the schema notes from this are free.</p><button class="btn" type="button" data-act="signin-draft">Create a free account</button><button class="btn ghost" type="button" id="dNotes">Just add these tables to my notes</button>';
        } else {
          acts.innerHTML = '<button class="btn ai" type="button" id="dSend">Draft definitions</button><button class="btn ghost" type="button" id="dNotes">Just add the tables to my notes</button><p class="small muted" style="width:100%;margin:0">A few cents of AI credit. Nothing is saved until you choose.</p>';
          $('#dSend', root).addEventListener('click', function () { sendDraft(root, payload); });
        }
        $('#dNotes', root).addEventListener('click', function () { addNotes(C.parseSchemaText(state.draftText)); closeSheet(); go('canon'); toast('Added to the schema notes.'); });
      });
    });
  }
  function sendDraft(root, payload) {
    var send = $('#dSend', root);
    send.disabled = true; send.textContent = 'Drafting…';
    api('POST', 'api/draft', payload).then(function (r) {
      $('#dActs', root).hidden = true;
      var c = canonNow(), have = {};
      c.metrics.forEach(function (m) { have[m.name.toLowerCase()] = 1; });
      var h = '<p class="lab" style="margin-top:14px">Proposed - tick what to add</p><ul class="draft">' + r.metrics.map(function (m, i) {
        var dup = have[m.name.toLowerCase()];
        return '<li><label><input type="checkbox" data-di="' + i + '"' + (dup ? '' : ' checked') + '><span class="dbody"><b>' + esc(m.name) + '</b>' + (dup ? ' <span class="muted small">(you already have one by this name - ticking replaces it)</span>' : '') + '<span class="small">' + esc(m.meaning) + '</span><code>' + esc(m.measure) + '</code>' + (m.filters.length ? '<span class="small muted">Always: ' + esc(m.filters.map(function (f) { return f.sql; }).join(' · ')) + '</span>' : '') + (m.date.column ? '<span class="small muted">Dated by ' + esc(m.date.column) + (m.date.tz ? ' (' + esc(m.date.tz) + ')' : '') + '</span>' : '') + '</span></label></li>';
      }).join('') + '</ul>';
      if (r.dropped.length) h += '<details class="why"><summary>Dropped ' + esc(plural(r.dropped.length, 'thing')) + ' that named columns not in your schema</summary><ul class="skipped">' + r.dropped.map(function (d) { return '<li>' + esc(d.metric) + ': ' + esc(d.what) + ' - ' + esc(d.why) + '</li>'; }).join('') + '</ul></details>';
      if (r.note) h += '<p class="small muted">' + esc(r.note) + '</p>';
      h += '<label class="confirm"><input type="checkbox" id="dAlsoNotes" checked> Also add the tables to my schema notes</label>';
      h += '<div class="btns" style="margin-top:10px"><button class="btn" type="button" id="dAdd">Add to my canon</button><button class="btn ghost" type="button" data-act="closesheet">Discard</button></div><p class="small muted">Drafted by an AI model - read each one before you rely on it.</p>';
      $('#dOut', root).innerHTML = h;
      $('#dAdd', root).addEventListener('click', function () {
        var picks = $$('[data-di]', root).filter(function (x) { return x.checked; }).map(function (x) { return r.metrics[Number(x.getAttribute('data-di'))]; });
        addDrafted(picks);
        if ($('#dAlsoNotes', root).checked) addNotes(C.parseSchemaText(state.draftText));
        saveCanon();
        closeSheet(); go('canon'); toast('Added ' + plural(picks.length, 'definition') + ' - read each one over.');
      });
      loadMe();
    }).catch(function (err) { send.disabled = false; send.textContent = 'Draft definitions'; meteredError(err, $('#dErr', root), function () { openDraft(); }, 'Drafting definitions uses a few cents of AI credit, so it needs a free account (it comes with $2).'); });
  }
  function addDrafted(list) {
    var c = state.canon;
    list.forEach(function (m) {
      var i = c.metrics.map(function (x) { return x.name.toLowerCase(); }).indexOf(m.name.toLowerCase());
      var taken = {};
      c.metrics.forEach(function (x) { taken[x.id] = 1; });
      var copy2 = Object.assign({}, m, { updatedAt: Date.now() });
      if (i >= 0) { copy2.id = c.metrics[i].id; c.metrics[i] = copy2; }
      else if (c.metrics.length < C.LIMITS.metrics) { copy2.id = C.idFor(m.name, taken); c.metrics.push(copy2); }
    });
  }
  function addNotes(parsed) {
    var c = state.canon, notes = C.notesFromSchema(parsed), merged = C.cleanCanon({ name: c.name, metrics: [], tables: c.tables.concat(notes.tables.filter(function (t) { return !c.tables.some(function (x) { return x.name.toLowerCase() === t.name.toLowerCase(); }); })), relationships: c.relationships.concat(notes.relationships) });
    c.tables = merged.tables; c.relationships = merged.relationships;
    saveCanon();
  }

  /* ---------------- sheets and the account (shared shape with the lab) ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    // The shared "confirm your email" banner sits above everything at the top
    // of the page; keep the sheet (and its Close button) clear of it.
    var vb = document.getElementById('stc-verify-banner'), off = vb ? Math.max(0, vb.getBoundingClientRect().bottom) : 0;
    s.style.maxHeight = off ? 'calc(100vh - ' + Math.round((matchMedia('(min-width: 720px)').matches ? 2 : 1) * (off + 8)) + 'px)' : '';
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
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

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }

  var FREE_LINE = 'Writing the canon, checking answers and every export are free with no account. A free account adds sync, read-only share links and the two AI helpers - it comes with $2 of AI credit, and one account works across every app on this site.';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); return syncIn(); }).then(function () { state.links = null; if (then) then(); else draw(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { return syncIn(); }).then(function () { if (then) then(); else draw(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">An explanation costs a cent or two, a draft a few cents. The canon, the checks and the exports are free and need no account.</p><div id="billing"></div></div>' +
      (state.canon && !isSample(state.canon) ? '<p class="small" style="margin-top:14px">' + syncLine() + '</p><button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my canon from the account</button>' : '') +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.links = null; state.lastLink = null; drawTop(); draw(); }); });
        var fg = $('#forget', root);
        if (fg) fg.addEventListener('click', function () {
          if (!confirm('Remove the canon from your account? This device keeps its copy; every share link closes.')) return;
          api('DELETE', 'api/canon').then(function () { setBase(null); state.links = null; state.lastLink = null; keep(K_LINKS, null); closeSheet(); toast('Removed from the account. This device still has it.'); state.syncState = 'local'; draw(); }).catch(function (e) { showError(e); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The canon, the checks and the exports keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- one click listener ---------------- */

  function startOwn() {
    if (state.canon && !isSample(state.canon)) { state.preview = null; go('canon'); return; }
    state.canon = C.emptyCanon('My company'); state.preview = null; state.result = null; state.q = ''; state.sql = ''; state.tryId = null;
    saveCanon();
    go('canon');
    toast('A blank canon. Add your first metric.');
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); if (SHARE) { location.href = BASE; break; } state.preview = null; go('start'); break;
      case 'tab': state.edit = null; state.schema = null; state.schemaParse = null; go(t.getAttribute('data-tab')); break;
      case 'try': openTry(id); break;
      case 'startown': startOwn(); break;
      case 'makemine': state.canon.sample = false; state.preview = null; saveCanon(); draw(); toast('It’s yours now - rename it and change what doesn’t fit.'); break;
      case 'endpreview': state.preview = null; state.result = null; state.tryId = null; var d0 = recall(K_DRAFT) || {}; state.q = d0.q || ''; state.sql = d0.sql || ''; go('check'); break;
      case 'check': runCheck(); break;
      case 'clear': state.q = ''; state.sql = ''; state.result = null; state.tryId = null; state.picked = null; keepDraft(); draw(); var sq = $('#sql'); if (sq) sq.focus(); break;
      case 'openck': { var k = t.getAttribute('data-key'); state.open[k] = t.getAttribute('aria-expanded') !== 'true'; draw(); var b2 = $('#ck-' + k.replace(':', '-') + ' .copen'); if (b2) try { b2.focus({ preventScroll: true }); } catch (x) { /* ignore */ } break; }
      case 'choose': state.choosing = true; draw(); break;
      case 'pick': {
        var cur = state.result ? state.result.metrics.map(function (m) { return m.id; }) : [];
        var i = cur.indexOf(id);
        if (i >= 0) cur.splice(i, 1); else cur.push(id);
        state.picked = cur.length ? cur : null; state.choosing = true; runCheck({ scroll: false }); break;
      }
      case 'unpick': state.picked = null; state.choosing = false; runCheck({ scroll: false }); break;
      case 'copyfix': if (state.result && state.result.fix && state.result.fix.sql) copy(state.result.fix.sql, 'Fixed SQL copied - run it yourself.'); break;
      case 'checkfix': if (state.result && state.result.fix && state.result.fix.sql) { var qn = $('#q'); if (qn) state.q = qn.value; state.sql = state.result.fix.sql; state.tryId = null; runCheck({ fromState: true }); } break;
      case 'explain': openExplain(); break;
      case 'signin-explain': openAccount('Explaining an answer uses a cent or two of AI credit; a free account comes with $2.', function () { draw(); openExplain(); }); break;
      case 'signin-draft': openAccount('Drafting definitions uses a few cents of AI credit; a free account comes with $2.', function () { draw(); openDraft(); }); break;
      case 'signin-share': case 'signin-sync': openAccount(); break;
      case 'retrysync': push(0); break;
      case 'draft': openDraft(); break;
      case 'new': state.edit = blankMetric(); state.editIsNew = true; go('new'); break;
      case 'edit': state.edit = null; go('edit/' + id); break;
      case 'addfilter': readEdit(); if (state.edit.filters.length < C.LIMITS.filters) state.edit.filters.push({ sql: '', keepsOut: '' }); draw(); var rows = $$('[data-frow] [data-f="sql"]'); if (rows.length) rows[rows.length - 1].focus(); break;
      case 'rmfilter': readEdit(); state.edit.filters.splice(Number(t.getAttribute('data-i')), 1); draw(); break;
      case 'delmetric': {
        var name = state.edit.name || 'this metric';
        if (!confirm('Delete ' + name + ' from the canon?')) break;
        var c = canonNow(); c.metrics = c.metrics.filter(function (m) { return m.id !== state.edit.id; });
        state.edit = null; state.result = null; saveCanon(); go('canon'); toast('Deleted ' + name + '.'); break;
      }
      case 'rename': { var nn = prompt('What should this canon be called?', canonNow().name); if (nn && C.line(nn, 80)) { state.canon.name = C.line(nn, 80); saveCanon(); draw(); } break; }
      case 'goschema': state.schema = null; state.schemaParse = null; go('schema'); break;
      case 'readddl': readDdl(); break;
      case 'addddl': {
        if (!state.schemaParse) break;
        readSchemaForm();
        var notes = C.notesFromSchema(state.schemaParse), s = state.schema;
        notes.tables.forEach(function (tb) { var j = s.tables.map(function (x) { return x.name.toLowerCase(); }).indexOf(tb.name.toLowerCase()); if (j >= 0) { s.tables[j].columns = tb.columns; if (!s.tables[j].key) s.tables[j].key = tb.key; } else s.tables.push(tb); });
        notes.relationships.forEach(function (r) { if (!s.relationships.some(function (x) { return x.one.toLowerCase() === r.one.toLowerCase() && x.many.toLowerCase() === r.many.toLowerCase(); })) s.relationships.push(r); });
        state.schemaParse = null; draw(); toast('Added - fill in what one row of each table is, then save.'); break;
      }
      case 'addtable': readSchemaForm(); state.schema.tables.push({ name: '', grain: '', key: '', columns: [] }); draw(); break;
      case 'rmtable': readSchemaForm(); state.schema.tables.splice(Number(t.getAttribute('data-i')), 1); draw(); break;
      case 'addrel': readSchemaForm(); state.schema.relationships.push({ one: '', many: '' }); draw(); break;
      case 'rmrel': readSchemaForm(); state.schema.relationships.splice(Number(t.getAttribute('data-i')), 1); draw(); break;
      case 'saveschema': {
        readSchemaForm();
        var cleaned = C.cleanCanon({ name: 'x', metrics: [], tables: state.schema.tables, relationships: state.schema.relationships });
        var badRel = state.schema.relationships.filter(function (r) { return (r.one || r.many) && !cleaned.relationships.some(function (x) { return x.one === r.one.trim() && x.many === r.many.trim(); }); }).length;
        if (badRel) { $('#schemaErr').innerHTML = '<p class="err" role="alert">Write each link as table.column on both sides, two different tables (orders.id → order_lines.order_id).</p>'; break; }
        state.canon.tables = cleaned.tables; state.canon.relationships = cleaned.relationships; state.schema = null; state.result = null;
        saveCanon(); go('canon'); toast('Schema notes saved.'); break;
      }
      case 'exportkind': state.exportKind = t.getAttribute('data-k'); draw(); break;
      case 'copyexport': copy(exportText(state.exportKind), state.exportKind === 'md' ? 'Copied - paste it into your AI tool’s instructions.' : 'Copied'); break;
      case 'dlexport': download(fname(state.exportKind === 'md' ? '.md' : state.exportKind === 'yaml' ? '.yaml' : '.json'), state.exportKind === 'md' ? 'text/markdown' : state.exportKind === 'yaml' ? 'application/yaml' : 'application/json', exportText(state.exportKind)); break;
      case 'importcancel': state.importPreview = null; draw(); break;
      case 'importadd': case 'importreplace': {
        var p = state.importPreview;
        if (!p || !p.canon) break;
        if (act === 'importreplace' && !confirm('Replace your canon with ' + p.canon.name + '? Export yours first if you might want it back.')) break;
        var incoming = Object.assign({}, p.canon, { updatedAt: Date.now() });
        incoming.metrics = incoming.metrics.map(function (m) { return Object.assign({}, m, { updatedAt: Date.now() }); });
        state.canon = act === 'importreplace' || !state.canon || isSample(state.canon) ? Object.assign(incoming, { sample: false }) : Object.assign(C.mergeCanons(state.canon, incoming), { sample: false, name: state.canon.name });
        state.importPreview = null; state.preview = null; state.result = null;
        saveCanon(); go('canon'); toast('Imported.'); break;
      }
      case 'mklink': makeLink(); break;
      case 'copylink': if (state.lastLink) copy(state.lastLink, 'Link copied'); break;
      case 'sharelink': if (state.lastLink && navigator.share) navigator.share({ title: canonNow().name + ' - metric definitions', url: state.lastLink }).catch(function () { /* cancelled */ }); break;
      case 'copyold': { var codes = recall(K_LINKS) || {}; if (codes[id]) copy(linkUrl(codes[id]), 'Link copied'); break; }
      case 'closelink': {
        if (!confirm('Close this link? Anyone who has it will see “not open any more”.')) break;
        api('DELETE', 'api/shares/' + encodeURIComponent(id)).then(function () { var codes2 = recall(K_LINKS) || {}; if (codes2[id] && state.lastLink === linkUrl(codes2[id])) state.lastLink = null; delete codes2[id]; keep(K_LINKS, codes2); state.links = null; draw(); toast('Link closed.'); }).catch(function (er) { showError(er); });
        break;
      }
      case 'sharetab': state.shareTab = t.getAttribute('data-k'); history.replaceState(null, '', location.pathname + (state.shareTab === 'check' ? '#check' : '')); draw(); break;
      case 'copymdshared': if (state.shared) copy(C.toMarkdown(state.shared.canon, today()), 'Copied - paste it into your AI tool’s instructions.'); break;
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  function markOffline() { var p = $('#offlinePill'); if (p) p.hidden = false; }
  if ('serviceWorker' in navigator && !SHARE) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  if (SHARE) { var sk = $('#skip'); if (sk) sk.setAttribute('href', location.pathname + '#main'); }
  $('#acct').addEventListener('click', function () { if (signedIn()) openSettings(); else openAccount(); });
  drawTop();
  route();
  if (SHARE) loadShared();
  loadMe().then(function () {
    if (signedIn()) syncIn();
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
}());
