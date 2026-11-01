/* Sieve - the page. One file, no build step.
 *
 * EVERY TEST CASE STAYS ON THIS DEVICE. Cases can hold real secrets and
 * personal data, so they are written, imported, run, scored, attacked and
 * exported here: SieveCore does the work in a worker (sieve-worker.js) under
 * the watchdog in sieve-runner.js, so a user's catastrophic regex costs a
 * second and a half, never the tab. Nothing about a case or a match is ever
 * sent anywhere. The requests this page makes: sign-in, the account's rule
 * set (patterns and settings only, when signed in), and the one optional AI
 * call, whose payload - a category code and one sentence - is shown before
 * it is sent.
 *
 * Browser storage is opt-in: "Keep this on this device" (off by default,
 * with Clear). Every access is wrapped in try/catch.
 *
 * Every string a file held, a person typed, the server sent or a model wrote
 * is escaped before it is drawn (esc, or vis/paint, which escape every
 * character and draw invisible ones as visible marks), and no handler is
 * written into markup: clicks are routed by data-act attributes from one
 * listener (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.SieveCore;
  var D = window.SieveDemo;
  var R = window.SieveRunner;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var OW = C.OUTCOME_WORD, OI = C.OUTCOME_ICON;
  var K_STORE = 'sieve-v1';

  function recall() { try { return JSON.parse(localStorage.getItem(K_STORE) || 'null'); } catch (e) { return null; } }
  function keepNow(v) { try { if (v == null) localStorage.removeItem(K_STORE); else localStorage.setItem(K_STORE, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function newId(pre) { return pre + Math.random().toString(36).slice(2, 9); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  function demoWs() { return { rules: D.rules(C.defaults), cases: cleanList(D.cases()), history: [], seq: 41, attackAdded: false }; }
  function ownWs() { return { rules: C.defaults(), cases: [], history: [], seq: 1, attackAdded: false }; }
  function cleanList(list) { return (list || []).slice(0, C.LIMITS.cases).map(function (c, i) { return C.cleanCase(c, i).case; }).filter(Boolean); }

  var state = {
    me: null,
    view: 'start',
    ws: null,
    W: { demo: null, own: null },
    run: null, runWs: null, running: false,
    attack: null, attackStale: true, attackBusy: false,
    filter: 'problems', cfilter: 'all', cquery: '', shown: 60, cshown: 80,
    keep: false, hint: false, zeroSeen: false,
    syncBase: null, syncState: 'local', conflictOpen: false,
    openDet: {}, importing: null,
    cache: {}
  };
  function ws() { return state.ws ? state.W[state.ws] : null; }

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
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
    toastTimer = setTimeout(function () { t.remove(); }, ms || 2400);
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
  function isWide() { return matchMedia('(min-width: 1000px)').matches; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Sieve stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    var b = $('#resend', where);
    b.addEventListener('click', function () {
      b.disabled = true;
      fetch((e.data && e.data.resend) || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    });
  }

  /* ---------------- drawing text: every character escaped, the invisible ones made visible ---------------- */

  var INV = C.INVISIBLE;
  function vis(s, inline) {
    var out = '';
    Array.from(String(s)).forEach(function (ch) {
      if (ch === '\n') out += inline ? ' <span class="nl" aria-hidden="true">⏎</span> ' : '<span class="nl" aria-hidden="true">⏎</span>\n';
      else if (INV.test(ch)) { var nm = C.charName(ch); out += '<span class="inv" title="' + esc(nm) + '">' + (/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/.test(ch) ? 'BIDI' : 'ZW') + '<span class="vh"> (' + esc(nm) + ')</span></span>'; }
      else out += esc(ch);
    });
    return out;
  }
  var PRIORITY = ['leak', 'extra', 'block', 'exp', 'allow', 'flag', 'hit'];
  /** A text cut into runs by what covers them, each run drawn with the strongest mark. */
  function paint(text, layers, inline) {
    return C.segments(text, layers).map(function (g) {
      var k = PRIORITY.filter(function (p) { return g.on.indexOf(p) >= 0; })[0];
      return k ? '<span class="s-' + k + '">' + vis(g.t, inline) + '</span>' : vis(g.t, inline);
    }).join('');
  }
  function shift(list, by, lo, hi) { return (list || []).map(function (r) { return [Math.max(lo, r[0]) - by, Math.min(hi, r[1]) - by]; }).filter(function (r) { return r[1] > r[0]; }); }
  /** A short piece of a case's text, centred on what matters, marked. */
  function excerpt(c, r, max) {
    max = max || 170;
    var layers = layersOf(c, r);
    var focus = (layers.leak[0] || layers.extra[0] || layers.block[0] || layers.exp[0] || layers.hit[0] || [0, 0])[0];
    var a = Math.max(0, Math.min(focus - 40, c.text.length - max)), z = Math.min(c.text.length, a + max);
    var L = {};
    Object.keys(layers).forEach(function (k) { L[k] = shift(layers[k], a, a, z); });
    return (a > 0 ? '…' : '') + paint(c.text.slice(a, z), L, true) + (z < c.text.length ? '…' : '');
  }
  function layersOf(c, r) {
    var L = { exp: c.spans.slice(), leak: [], extra: [], block: [], allow: [], flag: [], hit: [] };
    if (!r) return L;
    r.leaked.forEach(function (k) { L.leak.push(c.spans[k]); });
    L.extra = r.extra.slice();
    r.dets.forEach(function (d) {
      var x = [d.s, d.e];
      if (d.allowed) L.allow.push(x);
      else if (d.act === 'flag') L.flag.push(x);
      else if (d.act === 'block' && r.actual === 'block') (r.outcome === 'break' && !c.spans.some(function (sp) { return sp[0] < x[1] && x[0] < sp[1]; }) ? L.extra : L.hit).push(x);
      else L.hit.push(x);
    });
    return L;
  }
  function opill(o, word) { return '<span class="op op-' + esc(o) + '"><span aria-hidden="true">' + (OI[o] || '•') + '</span>' + esc(word || OW[o] || o) + '</span>'; }
  var EXP_WORD = { pass: 'Pass untouched', redact: 'Redact', block: 'Block' };
  function dirWord(d) { return d === 'out' ? 'Output' : 'Input'; }

  /* ---------------- the checker: a worker under a watchdog, or this page without user regexes ---------------- */

  var runner = null;
  try {
    if (window.Worker) runner = R.create({ spawn: function () { return new Worker('sieve-worker.js'); }, ruleMs: C.LIMITS.ruleMs, runMs: C.LIMITS.runMs });
  } catch (e) { runner = null; }
  var local = null;
  function call(op, data) {
    if (runner) return runner.call(op, data);
    if (!local) local = C.createEngine();
    var d = Object.assign({ noUserRegex: true }, data);
    return new Promise(function (resolve, reject) { setTimeout(function () { try { var out = local[op](d, null); if (out && typeof out === 'object') out.timedOut = []; resolve(out); } catch (err) { reject(err); } }, 0); });
  }
  var pushedCases = null;
  function ensureCases() {
    var w = ws();
    if (pushedCases === w.cases) return Promise.resolve();
    pushedCases = w.cases;
    return call('cases', { cases: w.cases });
  }

  var runTimer = null, runSeq = 0, pillTimer = null;
  function schedule(ms) { clearTimeout(runTimer); runTimer = setTimeout(runNow, ms == null ? 250 : ms); }
  function setPill(t) { var p = $('#runPill'); if (p) p.textContent = t || ''; }
  function runNow(then) {
    var w = ws();
    if (!w) return Promise.resolve();
    var mine = ++runSeq, wsName = state.ws;
    state.running = true;
    clearTimeout(pillTimer);
    pillTimer = setTimeout(function () { if (state.running) setPill('Scoring…'); }, 300);
    return ensureCases().then(function () { return call('run', { rules: w.rules }); }).then(function (out) {
      if (mine !== runSeq || wsName !== state.ws) return;
      state.running = false; setPill('');
      var before = state.run && state.runWs === wsName ? state.run.score : null;
      state.run = out; state.runWs = wsName;
      state.attackStale = true;
      if (w.cases.length) w.history = C.pushHistory(w.history, out.score, C.rulesSig(w.rules, w.cases.length));
      saveSoon();
      afterRun(before);
      if (then) then(out, before);
    }).catch(function (err) {
      if (err && err.code === 'replaced') return;
      state.running = false; setPill('');
      toast(err.message, 4200);
    });
  }
  function rulesChanged(structural) {
    if (structural) redrawRules();
    schedule();
    saveSoon();
    if (state.ws === 'own') pushSoon();
  }
  function casesChanged() {
    schedule(0);
    saveSoon();
  }

  /* ---------------- keeping it on this device, only if asked ---------------- */

  var saveTimer = null;
  function saveSoon() { if (!state.keep) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function wsSnap(w, withCases) { return w ? { rules: w.rules, cases: withCases ? w.cases : [], history: w.history, seq: w.seq, attackAdded: w.attackAdded } : null; }
  function saveNow() {
    if (!state.keep) return;
    var snap = { v: 1, ws: state.ws, hint: state.hint, zeroSeen: state.zeroSeen, syncBase: state.syncBase, own: wsSnap(state.W.own, true), demo: wsSnap(state.W.demo, true) };
    if (keepNow(snap)) return;
    snap.own = wsSnap(state.W.own, false); snap.demo = wsSnap(state.W.demo, false);
    if (keepNow(snap)) { toast('This test set is too big to keep on this device - the rules and the chart are kept.', 5200); return; }
    toast('This browser would not keep it - everything is still open here.', 4200);
  }
  function clearKept() { keepNow(null); }

  /* ---------------- routing ---------------- */

  function go(hash) {
    history.pushState(null, '', BASE + '#' + hash);
    route(); scrollTo(0, 0);
  }
  function route() {
    closeSheet(true);
    var h = (location.hash || '').replace(/^#/, '');
    state.view = state.ws && /^(score|rules|cases|attack|export)$/.test(h) ? h : 'start';
    if (state.view === 'rules' && isWide()) state.view = 'score';
    draw();
  }
  window.addEventListener('popstate', route);
  matchMedia('(min-width: 1000px)').addEventListener('change', function () { if (state.view === 'rules' && isWide()) state.view = 'score'; if (state.view !== 'start') draw(); });

  function draw() {
    closeSheet(true);
    var main = $('#main');
    $('#tabbar').hidden = state.view === 'start';
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var html;
    if (state.view === 'score') html = isWide() ? '<div class="tune">' + rulesPaneHtml() + '<div id="scoreWrap">' + scorePaneHtml() + '</div></div>' : scorePaneHtml();
    else if (state.view === 'rules') html = rulesPaneHtml();
    else if (state.view === 'cases') html = casesHtml();
    else if (state.view === 'attack') html = attackHtml();
    else if (state.view === 'export') html = exportHtml();
    else html = startHtml();
    main.innerHTML = html + footer();
    wire();
    drawRuleStats();
    animateBars();
    if (state.view === 'attack' && state.attackStale && !state.attackBusy && ws() && ws().cases.length) runAttack();
  }
  function footer() {
    return '<footer class="foot"><p>Sieve scores rules; it never sees your agent. Test cases and matches never leave this device.</p><p>A Challenge Lab trial · <a href="../">more experiments</a></p></footer>';
  }
  function animateBars() {
    requestAnimationFrame(function () { $$('.bar > i[data-w]').forEach(function (b) { b.style.width = b.getAttribute('data-w') + '%'; }); });
  }
  /** After a run: redraw only what depends on the score, so a rule being typed keeps its focus. */
  function afterRun(before) {
    if (!results()) return;
    if (state.view === 'score') {
      var wrap = isWide() ? $('#scoreWrap') : $('#main');
      if (wrap) {
        var y = scrollY;
        if (isWide()) wrap.innerHTML = scorePaneHtml(); else { wrap.innerHTML = scorePaneHtml() + footer(); }
        scrollTo(0, y);
      }
    }
    if (state.view === 'cases') { var list = $('#caseList'); if (list) list.innerHTML = caseListHtml(); }
    if (state.view === 'export') { var ex = $('#reportOut'); if (ex) ex.textContent = reportText(); }
    if (state.view === 'attack' && !state.attackBusy) runAttack();
    drawRuleStats();
    var s = state.run.score;
    if (state.ws === 'demo' && s.total && !s.leak && !s.partial && !s.break && !state.zeroSeen) { state.zeroSeen = true; saveSoon(); toast('0 leaks, 0 breaks. Now attack your rules →', 4200); }
    if (before && (before.leak !== s.leak || before.break !== s.break || before.partial !== s.partial) && state.lastApplied) {
      toast(state.lastApplied + ' · ' + C.scoreLine(s), 3000);
    }
    state.lastApplied = null;
  }

  /* ---------------- first run ---------------- */

  function mockHtml() {
    return '<div class="mock" aria-hidden="true"><div class="mh"><b>Juniper support agent</b><span>40 cases</span></div>' +
      '<div class="mt"><div class="m-l"><span>0</span>Leaks</div><div class="m-b"><span>0</span>Breaks</div><div class="m-c"><span>40</span>Correct</div></div><ul>' +
      '<li><span class="mk">✓</span><span><b>Turn on the Luhn check</b> - order number <mark>4111-2222-3333-4444</mark> fails it</span></li>' +
      '<li><span class="mk">✓</span><span><b>Allow-list ORD-\\d{16}</b> - −3 breaks</span></li>' +
      '<li><span class="mk">✓</span><span><b>Normaliser on</b> - full-width digits and zero-width tricks caught</span></li></ul></div>';
  }
  function startHtml() {
    var h = '<section class="hero">' + mockHtml() +
      '<p class="kicker"><span aria-hidden="true">🛡\uFE0F</span> Guardrail tuning</p>' +
      '<h1>Tune your agent’s guardrails until nothing leaks.</h1>' +
      '<p>And nothing legit gets blocked. Sieve runs your filter rules over a labelled test set and scores every message: <b>Leak</b>, <b>Break</b> or <b>Correct</b> - then suggests the fix and shows what it would change.</p>' +
      '<div class="btns"><button class="btn primary big" type="button" data-act="demo">Try the demo</button><button class="btn ghost big" type="button" data-act="own">Start with my own rules</button></div>' +
      (state.ws ? '<p style="margin-top:12px"><button class="btn small ghost" type="button" data-act="tab" data-tab="score">Back to ' + (state.ws === 'demo' ? 'the demo' : 'your rules') + '</button></p>' : '') +
      '<div class="trust"><span class="ico" aria-hidden="true">🔒</span><div><b>Nothing leaves this device.</b> Test cases often hold real secrets, so they are checked here, in your browser - never uploaded, never sent to an AI. Free, no sign-in.</div></div></section>';
    h += '<div class="grid3 how" style="margin-top:14px">' +
      [['🧪', 'A labelled test set', 'Messages going in to your agent and coming out of it, each marked pass, redact or block - with the sensitive parts selected. Import CSV or JSONL, or write them.'],
       ['📊', 'A score on every change', 'Every rule change re-runs the set in a moment: leaks (a secret got through), breaks (legit text blocked or redacted), and a chart of both heading to zero.'],
       ['🛠\uFE0F', 'Fixes, previewed', 'Turn on the Luhn check, allow-list your order ids, normalise look-alike characters - each suggestion simulated first: “−2 breaks, no new leaks”.']].map(function (s, i) {
        return '<div class="card"><div class="n" aria-hidden="true">' + (i + 1) + '</div><h2><span aria-hidden="true">' + s[0] + '</span> ' + esc(s[1]) + '</h2><p>' + esc(s[2]) + '</p></div>';
      }).join('') + '</div>';
    h += '<section class="card" style="margin-top:14px"><p class="lab">What it checks</p><ul class="chips">' +
      ['💳 Cards, with the Luhn check', '🏦 IBANs, with mod-97', '🪪 US SSNs, impossible ones skipped', '📧 Email addresses', '📞 Phone numbers (NANP, E.164)', '🔑 AWS, GitHub, Slack and Stripe keys', '🗝\uFE0F Private key blocks', '🎫 JWTs, header checked', '🌐 IPv4', '✍\uFE0F Your own regexes and keyword lists', '✅ An allow-list that wins', '🥷 Ten evasion tricks'].map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>';
    h += '<div class="privacy-line"><span aria-hidden="true">⏱</span><div><b>Your regexes can’t freeze the page.</b> They run in a background worker with a time limit; one that backtracks for ever is stopped, named, and skipped.</div></div>';
    return h;
  }

  /* ---------------- workspaces ---------------- */

  function useWs(name, fresh) {
    if (fresh || !state.W[name]) state.W[name] = name === 'demo' ? demoWs() : ownWs();
    state.ws = name;
    state.run = null; state.runWs = null; state.attack = null; state.attackStale = true;
    state.filter = 'problems'; state.cfilter = 'all'; state.cquery = ''; state.shown = 60;
    pushedCases = null;
    saveSoon();
    runNow();
  }
  function wsStrip() {
    if (state.ws === 'demo') return '<div class="ws"><p><b>Juniper Outfitters</b> · a made-up support agent with a naive guardrail. Every value in it is fake.</p><button class="btn small ghost" type="button" data-act="own">Switch to my own rules</button></div>';
    var w = ws();
    return '<div class="ws"><p><b>' + esc(w.rules.name || 'Your rules') + '</b> · ' + esc(plural(w.cases.length, 'test case')) + ' · checked on this device</p><button class="btn small ghost" type="button" data-act="demo">Open the demo</button></div>';
  }

  /* ---------------- the score ---------------- */

  function results() { return state.run && state.runWs === state.ws ? state.run : null; }
  function resultOf(id) { var r = results(); if (!r) return null; for (var i = 0; i < r.results.length; i++) if (r.results[i].id === id) return r.results[i]; return null; }
  function caseOf(id) { var w = ws(); for (var i = 0; i < w.cases.length; i++) if (w.cases[i].id === id) return w.cases[i]; return null; }

  function scorePaneHtml() {
    var w = ws(), run = results();
    var h = '<div class="stack" id="scorePane">' + wsStrip();
    if (!w.cases.length) {
      return h + '<section class="card empty"><h1>Nothing to score yet</h1><p class="muted">Add test cases: the messages your agent sees and says, each labelled pass, redact or block.</p><div class="btns" style="justify-content:center"><button class="btn" type="button" data-act="newcase">Write a case</button><button class="btn ghost" type="button" data-act="import">Import CSV or JSONL</button><button class="btn ghost" type="button" data-act="ai">✨ Write tricky test cases</button></div><p class="small muted" style="margin-top:12px">Or <button class="link-btn" type="button" data-act="copydemo">start from the demo’s 40 cases</button> and tune your own rules against them.</p></section>' + (isWide() ? '' : rulesTeaser()) + '</div>';
    }
    if (!run) return h + '<section class="card"><p class="muted" style="margin:0">Scoring ' + esc(plural(w.cases.length, 'case')) + ' on this device…</p></section></div>';
    var s = run.score;
    var tiles = [['leak', s.leak, 'Leaks'], ['partial', s.partial, 'Partial'], ['break', s.break, 'Breaks'], ['correct', s.correct, 'Correct of ' + s.total]].filter(function (t) { return t[0] !== 'partial' || s.partial; });
    h += '<section class="card board" aria-label="Score"><div class="sec-head"><h1>Score</h1><span class="small muted">' + esc(plural(onCount(w.rules), 'rule')) + ' on · ' + esc(plural(s.total, 'case')) + '</span></div>' +
      '<div class="tiles' + (tiles.length === 4 ? ' four' : '') + '">' + tiles.map(function (t) {
        return '<button class="tile t-' + t[0] + '" type="button" data-act="filter" data-f="' + t[0] + '" aria-pressed="' + (state.filter === t[0]) + '"><b>' + t[1] + '</b><span>' + esc(t[2]) + '</span></button>';
      }).join('') + '</div>' +
      '<p class="scoreline">' + esc(C.scoreLine(s)) + (s.flagged ? ' · <span class="tagp flag">' + s.flagged + ' flagged</span>' : '') + '</p>' + chartHtml(w.history) + '</section>';
    var missing = (run.skipped || []).length + (run.errors || []).length;
    if (!s.leak && !s.partial && !s.break) h += '<div class="zero" role="status"><span class="ico" aria-hidden="true">🎉</span><div><p><b>0 leaks, 0 breaks.</b> Every message in the set does what you labelled it to' + (missing ? ' - with ' + esc(plural(missing, 'rule')) + ' not run (below)' : '') + '.</p><p class="small muted">Now see what gets past them: Sieve rewrites each value ten ways people hide it.</p><p style="margin-top:8px"><button class="btn small" type="button" data-act="tab" data-tab="attack">Attack my rules →</button></p></div></div>';
    h += hintHtml(run);
    h += noticesHtml(run);
    h += suggCard(run);
    h += resultsCard(run);
    h += byRuleHtml(run) + byKindHtml(run);
    if (!isWide()) h += rulesTeaser();
    return h + '</div>';
  }
  function rulesTeaser() { return '<section class="card"><div class="row spread"><div><h2 style="margin:0">Rules</h2><p class="small muted" style="margin:4px 0 0">' + esc(plural(onCount(ws().rules), 'rule')) + ' on · change one and the score re-runs.</p></div><button class="btn small" type="button" data-act="tab" data-tab="rules">Tune the rules</button></div></section>'; }
  function onCount(r) { return C.DET_IDS.filter(function (id) { return r.det[id].on; }).length + r.custom.filter(function (c) { return c.on; }).length; }

  function chartHtml(hist) {
    if (!hist || hist.length < 2) return '<p class="small muted" style="margin:0">Change a rule and a chart of leaks and breaks starts here - the last ' + C.LIMITS.history + ' runs.</p>';
    var n = hist.length, max = Math.max(1, Math.max.apply(null, hist.map(function (x) { return Math.max(x.leak, x.brk); })));
    var X = function (i) { return (n === 1 ? 150 : 6 + i * (288 / (n - 1))).toFixed(1); }, Y = function (v) { return (94 - (v / max) * 84).toFixed(1); };
    var line = function (k) { return hist.map(function (x, i) { return X(i) + ',' + Y(x[k]); }).join(' '); };
    var last = hist[n - 1], first = hist[0];
    return '<div class="chart"><svg viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="Leaks went from ' + first.leak + ' to ' + last.leak + ' and breaks from ' + first.brk + ' to ' + last.brk + ' over the last ' + n + ' runs">' +
      '<line class="grid" x1="0" y1="94" x2="300" y2="94"/><line class="grid" x1="0" y1="10" x2="300" y2="10"/>' +
      '<polyline class="l-break" stroke-dasharray="6 4" points="' + line('brk') + '"/><polyline class="l-leak" points="' + line('leak') + '"/>' +
      '<circle class="d-break" cx="' + X(n - 1) + '" cy="' + Y(last.brk) + '" r="3.5"/><circle class="d-leak" cx="' + X(n - 1) + '" cy="' + Y(last.leak) + '" r="3.5"/></svg>' +
      '<p class="legend"><span><i class="k-leak"></i>Leaks ' + first.leak + ' → ' + last.leak + '</span><span><i class="k-break"></i>Breaks ' + first.brk + ' → ' + last.brk + '</span><span>last ' + esc(plural(n, 'run')) + '</span></p></div>';
  }

  function firstBreak(run) { for (var i = 0; i < run.results.length; i++) if (run.results[i].outcome === 'break') return run.results[i]; return null; }
  function hintHtml(run) {
    if (state.ws !== 'demo' || state.hint) return '';
    var b = firstBreak(run);
    if (!b) return '';
    var c = caseOf(b.id), d = b.dets.filter(function (x) { return !x.allowed && x.act !== 'flag'; })[0];
    var fix = run.suggestions.filter(function (s) { return s.ids.indexOf(b.id) >= 0; })[0];
    return '<div class="hint" role="note"><span class="ico" aria-hidden="true">👋</span><div><p><b>Start with the first Break.</b> ' + (d ? esc(d.name) + ' ' + (b.actual === 'block' ? 'blocked' : 'redacted') + ' “' + esc(c.text.slice(d.s, d.e)) + '” in a message that is fine. ' : '') + (fix ? 'Sieve’s fix: <b>' + esc(fix.title) + '</b> (' + esc(fix.line) + ').' : '') + '</p>' +
      '<div class="btns"><button class="btn small" type="button" data-act="case" data-id="' + esc(b.id) + '">Show me why</button>' + (fix ? '<button class="btn small ghost" type="button" data-act="apply" data-sid="' + esc(fix.id) + '">Apply that fix</button>' : '') + '<button class="btn small ghost" type="button" data-act="hintoff">Got it</button></div></div></div>';
  }
  function noticesHtml(run) {
    var h = '';
    (run.timedOut || []).forEach(function (t) {
      h += '<div class="notice" role="alert"><span aria-hidden="true">⏱</span><div><p><b>“' + esc(t.name) + '” took longer than ' + (t.ms / 1000).toFixed(1) + ' s and was skipped.</b> A pattern with a repeat inside a repeat, like (a+)+ or (\\w+\\s?)*, can backtrack for ever on the wrong text. Rewrite it, then <button class="link-btn" type="button" data-act="retryrx" data-k="' + esc(t.key) + '">try it again</button>.</p></div></div>';
    });
    (run.errors || []).forEach(function (e) {
      h += '<div class="notice" role="alert"><span aria-hidden="true">⚠</span><div><p><b>“' + esc(e.name) + '” is not a valid regex</b> and was skipped: ' + esc(e.error) + '</p></div></div>';
    });
    if (!runner) h += '<div class="notice"><span aria-hidden="true">ℹ</span><div><p>This browser has no background workers, so your own regexes are not run (they can’t be stopped safely here). Built-in detectors and keyword lists work.</p></div></div>';
    return h;
  }
  function suggItem(s, hot) {
    var worse = s.effect.break > 0;
    return '<li class="' + (hot ? 'hot' : '') + '"><span class="st">' + esc(s.title) + '</span>' + (s.why ? '<span class="sw">' + esc(s.why) + '</span>' : '') +
      '<span class="se"><span class="eff' + (worse ? ' worse' : '') + '">' + esc(s.line) + '</span></span><button class="btn small" type="button" data-act="apply" data-sid="' + esc(s.id) + '">Apply</button></li>';
  }
  function suggCard(run) {
    var list = run.suggestions;
    if (!list.length) {
      var s = run.score;
      if (!s.leak && !s.partial && !s.break) return '';
      return '<section class="card"><h2>Suggested fixes</h2><p class="muted" style="margin:0">No single safe change fixes what is left. Open a Leak to see what no rule caught - a custom rule usually does it - or check that its label is right.</p></section>';
    }
    var all = state.showAllSugg;
    return '<section class="card"><div class="sec-head"><h2>Suggested fixes</h2><span class="small muted">Each one simulated against all ' + esc(plural(run.score.total, 'case')) + ' first</span></div><ul class="sugg">' + list.slice(0, all ? 12 : 4).map(function (x) { return suggItem(x); }).join('') + '</ul>' +
      '<div class="btns" style="margin-top:10px">' + (list.length > 1 ? '<button class="btn small" type="button" data-act="fixall">Apply every safe fix</button>' : '') + (list.length > 4 ? '<button class="btn small ghost" type="button" data-act="allsugg">' + (all ? 'Show fewer' : 'Show all ' + list.length) + '</button>' : '') + '</div></section>';
  }
  var FILTERS = [['problems', 'Problems'], ['leak', OI.leak + ' Leaks'], ['partial', OI.partial + ' Partial'], ['break', OI.break + ' Breaks'], ['correct', OI.correct + ' Correct'], ['all', 'All']];
  function inFilter(r) {
    if (state.filter === 'all') return true;
    if (state.filter === 'problems') return r.outcome !== 'correct';
    return r.outcome === state.filter;
  }
  var ORDER = { leak: 0, partial: 1, break: 2, correct: 3 };
  function resultsCard(run) {
    var counts = { problems: 0, all: run.results.length, leak: 0, partial: 0, break: 0, correct: 0 };
    run.results.forEach(function (r) { counts[r.outcome]++; if (r.outcome !== 'correct') counts.problems++; });
    var list = run.results.filter(inFilter).slice().sort(function (a, b) { return state.filter === 'all' ? 0 : ORDER[a.outcome] - ORDER[b.outcome] || a.i - b.i; });
    var h = '<section class="card"><div class="sec-head"><h2>Every case</h2><span class="small muted">Tap one for the side-by-side</span></div><div class="filters" role="group" aria-label="Show">' +
      FILTERS.filter(function (f) { return f[0] !== 'partial' || counts.partial; }).map(function (f) { return '<button type="button" data-act="filter" data-f="' + f[0] + '" aria-pressed="' + (state.filter === f[0]) + '">' + esc(f[1]) + ' <span class="n">' + counts[f[0]] + '</span></button>'; }).join('') + '</div>';
    if (!list.length) return h + '<p class="muted empty" style="margin:0">' + (state.filter === 'problems' ? 'No problems - every case does what its label says.' : 'None here.') + '</p></section>';
    h += '<ul class="rlist">' + list.slice(0, state.shown).map(rowHtml).join('') + '</ul>';
    if (list.length > state.shown) h += '<button class="btn small ghost more" type="button" data-act="more">Show ' + Math.min(60, list.length - state.shown) + ' more of ' + (list.length - state.shown) + '</button>';
    return h + '</section>';
  }
  function rowHtml(r) {
    var c = caseOf(r.id);
    if (!c) return '';
    return '<li><button class="rrow e-' + r.outcome + '" type="button" data-act="case" data-id="' + esc(c.id) + '">' + opill(r.outcome) +
      '<span><span class="rm"><span>' + esc(c.id) + '</span><span>' + dirWord(c.dir) + '</span><span>expected ' + esc(c.expect) + '</span>' + (c.trick ? '<span class="tagp gold">' + esc(C.TRICKS[c.trick].label) + '</span>' : '') + (r.dets.some(function (d) { return d.act === 'flag' && !d.allowed; }) ? '<span class="tagp flag">flagged</span>' : '') + '</span><span class="rt">' + excerpt(c, r) + '</span></span>' +
      '<span class="rw">' + esc(r.why) + '</span></button></li>';
  }
  function byRuleHtml(run) {
    var rows = Object.keys(run.score.rules).map(function (k) { return run.score.rules[k]; }).filter(function (x) { return x.on && (x.hits || x.allowed || x.key.indexOf('a:') !== 0); });
    rows = rows.filter(function (x) { return x.on; });
    return '<details class="why card"><summary>By rule - what each one caught and broke</summary><div class="tablewrap" tabindex="0" role="region" aria-label="By rule"><table class="t"><thead><tr><th>Rule</th><th>Action</th><th>Checks</th><th class="r">Matches</th><th class="r">Caught</th><th class="r">Breaks</th></tr></thead><tbody>' +
      rows.map(function (x) {
        if (x.key.indexOf('a:') === 0) return '<tr><td class="name">' + esc(x.name) + '</td><td>Allow</td><td>—</td><td class="r">' + x.allowed + ' let through</td><td class="r">—</td><td class="r">—</td></tr>';
        return '<tr><td class="name">' + esc(x.name) + '</td><td>' + esc(C.ACT_WORD[x.act]) + '</td><td>' + esc(C.DIR_SHORT[x.dir]) + '</td><td class="r">' + x.hits + '</td><td class="r">' + x.caught + '</td><td class="r">' + x.breaks + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      (run.score.uncaught.length ? '<p class="small" style="margin:10px 0 0"><b>' + esc(plural(run.score.uncaught.length, 'sensitive span')) + ' no rule caught</b>: ' + esc(run.score.uncaught.slice(0, 12).map(function (u) { return u.id + ' (' + C.CATS[u.cat].toLowerCase() + ')'; }).join(', ')) + (run.score.uncaught.length > 12 ? '…' : '') + '</p>' : '') + '</details>';
  }
  function pct(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }
  function byKindHtml(run) {
    var cats = run.score.cats;
    return '<details class="why card"><summary>By kind - precision and recall</summary><p class="small muted" style="margin:0 0 8px">Recall: of the sensitive spans of each kind, how many were caught. Precision: of what the rules of each kind matched, how much was sensitive.</p><div class="tablewrap" tabindex="0" role="region" aria-label="Precision and recall"><table class="t"><thead><tr><th>Kind</th><th class="r">Sensitive spans</th><th class="r">Caught</th><th class="r">Recall</th><th class="r">Precision</th></tr></thead><tbody>' +
      C.CAT_KEYS.filter(function (k) { return cats[k].spans || cats[k].tp + cats[k].fp; }).map(function (k) { var x = cats[k]; return '<tr><td class="name">' + esc(C.CATS[k]) + '</td><td class="r">' + x.spans + '</td><td class="r">' + x.caught + '</td><td class="r">' + pct(x.recall) + '</td><td class="r">' + pct(x.precision) + '</td></tr>'; }).join('') +
      '</tbody></table></div></details>';
  }

  /* ---------------- one case, side by side ---------------- */

  function guardrailHtml(c, r) {
    if (r.actual === 'block') {
      var by = r.dets.filter(function (d) { return !d.allowed && d.act === 'block'; }).map(function (d) { return d.name; }).filter(function (x, i, a) { return a.indexOf(x) === i; });
      var L = layersOf(c, r);
      return '<div class="refused' + (c.expect === 'block' ? ' ok' : '') + '"><span>⛔ Refused by ' + esc(by.join(', ')) + '</span></div><pre class="txt">' + paint(c.text, { extra: L.extra, hit: L.hit, exp: c.spans, allow: L.allow, flag: L.flag }) + '</pre>';
    }
    var reds = r.red.map(function (x) { return [x[0], x[1]]; });
    var leak = r.leaked.map(function (k) { return c.spans[k]; });
    var flags = [], allows = [];
    r.dets.forEach(function (d) { if (d.allowed) allows.push([d.s, d.e]); else if (d.act === 'flag') flags.push([d.s, d.e]); });
    var out = '', segs = C.segments(c.text, { red: reds, leak: leak, flag: flags, allow: allows });
    var doneRed = {};
    segs.forEach(function (g) {
      if (g.on.indexOf('red') >= 0) {
        var range = reds.filter(function (x) { return g.s >= x[0] && g.e <= x[1]; })[0];
        var key = range[0] + ':' + range[1];
        if (doneRed[key]) return;
        doneRed[key] = true;
        var det = r.dets.filter(function (d) { return !d.allowed && d.act === 'redact' && d.s <= range[0] && d.e > range[0]; })[0] || r.dets.filter(function (d) { return !d.allowed && d.act === 'redact' && d.s < range[1] && d.e > range[0]; })[0];
        var bad = r.extra.some(function (x) { return x[0] === range[0] && x[1] === range[1]; });
        out += '<span class="redact' + (bad ? ' bad' : '') + '" title="' + esc((bad ? 'Redacted, but not sensitive: ' : 'Redacted: ') + c.text.slice(range[0], range[1])) + '">[REDACTED:' + esc(det ? det.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) : 'rule') + ']</span>';
        return;
      }
      var k = g.on.indexOf('leak') >= 0 ? 'leak' : g.on.indexOf('allow') >= 0 ? 'allow' : g.on.indexOf('flag') >= 0 ? 'flag' : '';
      out += k ? '<span class="s-' + k + '">' + vis(g.t) + '</span>' : vis(g.t);
    });
    return (r.actual === 'pass' ? '<div class="refused' + (c.expect === 'pass' ? ' ok' : '') + '"><span>' + (c.expect === 'pass' ? '✓ Went through untouched' : '! Went through - nothing was hidden') + '</span></div>' : '') + '<pre class="txt">' + out + '</pre>';
  }
  function expectedHtml(c) {
    var head = c.expect === 'pass' ? '<div class="refused ok"><span>✓ Should go through untouched</span></div>' : c.expect === 'block' ? '<div class="refused ok"><span>⛔ Should be refused whole</span></div>' : '<div class="refused ok"><span>Should go through with the marked parts redacted</span></div>';
    return head + '<pre class="txt">' + paint(c.text, { exp: c.spans }) + '</pre>';
  }
  function keyline(c, r) {
    var k = [];
    if (c.spans.length) k.push('<span><span class="s-exp">marked</span> sensitive</span>');
    if (r.leaked.length) k.push('<span><span class="s-leak">got through</span> leak</span>');
    if (r.actual === 'redact' && r.red.length > r.extra.length) k.push('<span><span class="redact">[REDACTED]</span> hidden</span>');
    if (r.extra.length) k.push('<span><span class="redact bad">[REDACTED]</span> hidden, but not sensitive</span>');
    if (r.actual === 'block' && r.outcome === 'break') k.push('<span><span class="s-extra">matched</span> fired on legit text</span>');
    if (r.dets.some(function (d) { return d.allowed; })) k.push('<span><span class="s-allow">allowed</span> by the allow-list</span>');
    if (r.dets.some(function (d) { return d.act === 'flag' && !d.allowed; })) k.push('<span><span class="s-flag">flagged</span> counted, let through</span>');
    return k.length ? '<p class="keyline" style="margin-top:8px">' + k.join('') + '</p>' : '';
  }
  function navList() {
    var run = results();
    if (!run) return [];
    return run.results.filter(inFilter).slice().sort(function (a, b) { return state.filter === 'all' ? 0 : ORDER[a.outcome] - ORDER[b.outcome] || a.i - b.i; }).map(function (r) { return r.id; });
  }
  function openCase(id) {
    var c = caseOf(id), r = resultOf(id), run = results();
    if (!c || !r) return;
    var fixes = run.suggestions.filter(function (s) { return s.ids.indexOf(id) >= 0; });
    var list = navList(), at = list.indexOf(id);
    var fired = r.dets.slice().sort(function (a, b) { return a.s - b.s; });
    var h = '<div class="row" style="gap:8px">' + opill(r.outcome) + '<span class="small muted">' + esc(c.id) + ' · ' + dirWord(c.dir) + ' · expected ' + esc(c.expect) + ', got ' + esc(r.actual) + '</span></div>' +
      '<h2 style="margin-top:8px">' + esc(r.why) + '</h2>' + (c.note ? '<p class="small muted">' + esc(c.note) + '</p>' : '') +
      '<div class="panes"><div class="pane"><p class="lab">Expected</p>' + expectedHtml(c) + '</div><div class="pane"><p class="lab">What the guardrail did</p>' + guardrailHtml(c, r) + '</div></div>' +
      keyline(c, r);
    if (fired.length) h += '<p class="lab" style="margin-top:12px">What fired</p><ul class="fired">' + fired.map(function (d) {
      return '<li><span><b>' + esc(d.name) + '</b> · ' + (d.allowed ? 'let through by the allow-list' : esc(C.ACT_WORD[d.act])) + '</span><span class="mono-t">' + vis(c.text.slice(d.s, d.e), true) + '</span></li>';
    }).join('') + '</ul>';
    else h += '<p class="small muted" style="margin-top:12px">No rule matched anything in this message.</p>';
    if (fixes.length) h += '<p class="lab" style="margin-top:12px">This would fix it</p><ul class="sugg">' + fixes.slice(0, 3).map(function (s) { return suggItem(s, true); }).join('') + '</ul>';
    else if (r.outcome !== 'correct') h += '<p class="small muted" style="margin-top:12px">' + (r.outcome === 'break' ? 'No single safe fix. Try an allow-list entry for this text, or turn the rule’s context words on.' : 'No built-in detector catches this as written. Write a custom rule for it on the Rules tab - or, if it is not sensitive, change its label.') + '</p>';
    h += '<div class="btns" style="margin-top:14px"><button class="btn ghost" type="button" data-act="editcase" data-id="' + esc(c.id) + '">Edit this case</button>' +
      (at > 0 ? '<button class="btn ghost" type="button" data-act="case" data-id="' + esc(list[at - 1]) + '">← Previous</button>' : '') +
      (at >= 0 && at < list.length - 1 ? '<button class="btn ghost" type="button" data-act="case" data-id="' + esc(list[at + 1]) + '">Next →</button>' : '') + '</div>';
    sheet(h);
  }

  /* ---------------- the rules ---------------- */

  function rulesPaneHtml() {
    var w = ws(), r = w.rules;
    var h = '<div class="rulespane stack" id="rulesPane">';
    if (!isWide()) h += wsStrip();
    h += '<section class="card"><div class="sec-head"><h2>Rules</h2><span class="small muted">Re-scored as you change them</span></div>' +
      '<label class="field"><span>Name</span><input class="input" data-r="name" maxlength="60" value="' + esc(r.name) + '" placeholder="Support agent guardrail" autocomplete="off"></label>' +
      '<p class="small" data-sync style="margin:8px 0 0">' + syncLine() + '</p></section>';
    // The normaliser
    var anyN = C.NORM_KEYS.some(function (k) { return r.normalise[k]; });
    h += '<section class="card rgroup"><div class="row spread"><h2 style="margin:0">Normaliser</h2><label class="toggle"><input type="checkbox" data-r="normall"' + (r.normalise.nfkc && r.normalise.zw && r.normalise.homo ? ' checked' : '') + '><span class="tr"></span><span class="vh">Normaliser on</span></label></div>' +
      '<p class="small muted" style="margin:0">Before the rules read a message, fold the characters people use to slip past them. Matches are still marked on the text as it arrived.</p>' +
      '<div data-sugg-for="norm"></div><div class="opts">' + C.NORM_KEYS.map(function (k) { return '<label class="check"><input type="checkbox" data-r="norm:' + k + '"' + (r.normalise[k] ? ' checked' : '') + '><span>' + esc(C.NORM_WORDS[k]) + '</span></label>'; }).join('') + '</div>' + (anyN ? '' : '') + '</section>';
    // Detectors
    h += '<section class="card rgroup"><h2>Detectors</h2>' + C.DET_IDS.map(detHtml).join('') + '</section>';
    // Custom rules
    h += '<section class="card rgroup"><div class="row spread"><h2 style="margin:0">Your own rules</h2><span class="small muted">' + r.custom.length + ' of ' + C.LIMITS.custom + '</span></div>' +
      '<div data-sugg-for="custom"></div>' + r.custom.map(customHtml).join('') +
      (r.custom.length < C.LIMITS.custom ? '<div class="btns"><button class="btn small ghost" type="button" data-act="addrx">+ A regex</button><button class="btn small ghost" type="button" data-act="addwords">+ A keyword list</button></div>' : '') + '</section>';
    // Allow-list
    h += '<section class="card rgroup"><div class="row spread"><h2 style="margin:0">Allow-list</h2><span class="small muted">Wins over every rule</span></div>' +
      '<p class="small muted" style="margin:0">A match that overlaps an allow-list match is dropped: your order ids, your own support address.</p><div data-sugg-for="allow"></div>' + r.allow.map(allowHtml).join('') +
      (r.allow.length < C.LIMITS.allow ? '<div class="btns"><button class="btn small ghost" type="button" data-act="addallow">+ A pattern</button><button class="btn small ghost" type="button" data-act="addallowtext">+ Exact text</button></div>' : '') + '</section>';
    return h + '</div>';
  }
  function mini(path, opts, cur, label) {
    return '<div class="mini" role="group" aria-label="' + esc(label) + '">' + opts.map(function (o) { return '<button type="button" data-act="rpick" data-r="' + esc(path) + '" data-v="' + esc(o[0]) + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>';
  }
  function dirSel(path, cur) {
    return '<select class="input slim" data-r="' + esc(path) + '" aria-label="Checks">' + C.DIRS.map(function (d) { return '<option value="' + d + '"' + (cur === d ? ' selected' : '') + '>' + esc(d === 'both' ? 'In and out' : d === 'in' ? 'Input only' : 'Output only') + '</option>'; }).join('') + '</select>';
  }
  var ACT_OPTS = [['redact', 'Redact'], ['block', 'Block'], ['flag', 'Flag']];
  function detHtml(id) {
    var d = C.DET[id], o = ws().rules.det[id], p = esc('det:' + id + ':');
    var opt = function (k) { return d.opts.indexOf(k) >= 0; };
    var chk = function (k, words) { return '<label class="check"><input type="checkbox" data-r="' + p + k + '"' + (o[k] ? ' checked' : '') + '><span>' + esc(words || C.OPT_WORD[k]) + '</span></label>'; };
    var h = '<div class="det' + (o.on ? '' : ' off') + '" id="det-' + esc(id) + '"><div class="dh"><label class="toggle"><input type="checkbox" data-r="' + p + 'on"' + (o.on ? ' checked' : '') + '><span class="tr"></span><span class="vh">' + esc(d.label) + ' on</span></label>' +
      '<div class="dn">' + esc(d.label) + '<small>' + esc(d.example) + '</small></div>' +
      '<div class="dctl">' + mini(p + 'act', ACT_OPTS, o.act, 'Action') + dirSel(p + 'dir', o.dir) + '<span class="stat" data-stat="d:' + id + '"></span></div></div>' +
      '<div data-sugg-for="d:' + id + '"></div>';
    var body = '';
    if (id === 'phone') body += '<div class="field"><span>Formats</span>' + mini(p + 'mode', [['strict', 'NANP and E.164 formats'], ['loose', 'Any run of digits']], o.mode, 'Formats') + '</div>';
    if (opt('luhn')) body += chk('luhn');
    if (opt('lines')) body += chk('lines');
    if (opt('mod97')) body += chk('mod97');
    if (opt('strict')) body += chk('strict');
    if (opt('seps')) body += '<div class="field"><span>Separators</span>' + mini(p + 'seps', [['dash', 'Dashes only'], ['any', 'Dashes, spaces or dots']], o.seps, 'Separators') + '</div>';
    if (opt('alg')) body += chk('alg');
    if (opt('priv')) body += chk('priv');
    if (opt('wb')) body += chk('wb');
    if (opt('min')) body += '<label class="field"><span>' + (id === 'card' || id === 'phone' ? 'Minimum digits' : 'Minimum characters after the prefix') + '</span><input class="input" type="number" inputmode="numeric" data-r="' + p + 'min" min="' + d.minRange[0] + '" max="' + d.minRange[1] + '" value="' + esc(o.min) + '"></label>';
    if (opt('ctx')) body += chk('ctx') + '<label class="field"><span>Context words, one per line</span><textarea class="input" data-r="' + p + 'words" rows="3" spellcheck="false">' + esc(o.words.join('\n')) + '</textarea><small>A match counts only when one of these is within</small></label><label class="field"><span>…this many characters</span><input class="input" type="number" inputmode="numeric" data-r="' + p + 'near" min="5" max="200" value="' + esc(o.near) + '"></label>';
    if (body) h += '<details data-open="' + id + '"' + (state.openDet[id] ? ' open' : '') + '><summary>Options</summary><div class="opts">' + body + '</div></details>';
    return h + '</div>';
  }
  var CAT_OPTS = C.CAT_KEYS.filter(function (k) { return k !== 'other'; });
  function customHtml(c) {
    var p = esc('cu:' + c.id + ':');
    var comp = c.kind === 'regex' ? C.compileRegex(c.src, c.flags) : null;
    var h = '<div class="custom' + (c.on ? '' : ' off') + '" id="cu-' + esc(c.id) + '"><div class="ch"><label class="toggle"><input type="checkbox" data-r="' + p + 'on"' + (c.on ? ' checked' : '') + '><span class="tr"></span><span class="vh">On</span></label>' +
      '<input class="input" data-r="' + p + 'name" maxlength="' + C.LIMITS.nameChars + '" value="' + esc(c.name) + '" aria-label="Rule name" autocomplete="off"><button class="btn small danger" type="button" data-act="cudel" data-id="' + esc(c.id) + '" aria-label="Remove ' + esc(c.name) + '">Remove</button></div>';
    if (c.kind === 'regex') {
      h += '<label class="field"><span>Pattern (JavaScript regex)</span><input class="input rx" data-r="' + p + 'src" maxlength="' + C.LIMITS.source + '" value="' + esc(c.src) + '" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="\\bGC-[A-Z0-9]{4}-[A-Z0-9]{4}\\b"></label>' +
        '<label class="check"><input type="checkbox" data-r="' + p + 'flag-i"' + (c.flags.indexOf('i') >= 0 ? ' checked' : '') + '><span>Ignore case</span></label>';
    } else {
      h += '<label class="field"><span>Keywords, one per line</span><textarea class="input" data-r="' + p + 'words" rows="3" spellcheck="false">' + esc(c.words.join('\n')) + '</textarea></label>' +
        '<label class="check"><input type="checkbox" data-r="' + p + 'wb"' + (c.wb ? ' checked' : '') + '><span>Whole words only</span></label><label class="check"><input type="checkbox" data-r="' + p + 'cs"' + (c.cs ? ' checked' : '') + '><span>Match case</span></label>';
    }
    h += '<div class="row">' + mini(p + 'act', ACT_OPTS, c.act, 'Action') + dirSel(p + 'dir', c.dir) +
      '<select class="input slim" data-r="' + p + 'cat" aria-label="Kind">' + CAT_OPTS.map(function (k) { return '<option value="' + k + '"' + (c.cat === k ? ' selected' : '') + '>' + esc('Kind: ' + C.CATS[k]) + '</option>'; }).join('') + '</select></div>' +
      '<p class="warn" data-warn="u:' + esc(c.id) + '">' + esc(comp && comp.error ? 'Not a valid regex: ' + comp.error : c.kind === 'regex' && C.riskyRegex(c.src) ? 'This pattern repeats a group that itself repeats - it can backtrack for ever. Sieve will stop it after ' + (C.LIMITS.ruleMs / 1000) + ' s if it does.' : '') + '</p>' +
      '<span class="stat" data-stat="u:' + esc(c.id) + '"></span></div>';
    return h;
  }
  function allowHtml(a) {
    var p = esc('al:' + a.id + ':');
    var comp = a.kind === 'regex' ? C.compileRegex(a.src, a.flags) : null;
    return '<div class="custom' + (a.on ? '' : ' off') + '" id="al-' + esc(a.id) + '"><div class="ch"><label class="toggle"><input type="checkbox" data-r="' + p + 'on"' + (a.on ? ' checked' : '') + '><span class="tr"></span><span class="vh">On</span></label>' +
      '<input class="input" data-r="' + p + 'name" maxlength="' + C.LIMITS.nameChars + '" value="' + esc(a.name) + '" aria-label="Entry name" autocomplete="off"><button class="btn small danger" type="button" data-act="aldel" data-id="' + esc(a.id) + '" aria-label="Remove ' + esc(a.name) + '">Remove</button></div>' +
      '<label class="field"><span>' + (a.kind === 'regex' ? 'Pattern (JavaScript regex)' : 'Exact text (any case)') + '</span><input class="input rx" data-r="' + p + 'src" maxlength="' + C.LIMITS.source + '" value="' + esc(a.src) + '" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="' + (a.kind === 'regex' ? '\\bORD-\\d{8}\\b' : 'help at your domain') + '"></label>' +
      '<p class="warn" data-warn="a:' + esc(a.id) + '">' + esc(comp && comp.error ? 'Not a valid regex: ' + comp.error : '') + '</p><span class="stat" data-stat="a:' + esc(a.id) + '"></span></div>';
  }
  /** Rule stats and the suggestions for each rule, drawn in place after a run. */
  function drawRuleStats() {
    var run = results();
    $$('[data-stat]').forEach(function (el) {
      var k = el.getAttribute('data-stat'), x = run && run.score.rules[k];
      if (!x) { el.textContent = ''; return; }
      if (k.indexOf('a:') === 0) { el.innerHTML = x.allowed ? '<span class="good">' + esc(plural(x.allowed, 'match', 'matches')) + ' let through</span>' : 'nothing let through yet'; return; }
      if (!x.on) { el.textContent = ''; return; }
      if (run.skipped.some(function (q) { return q.key === k; })) { el.innerHTML = '<span class="bad">skipped - see above</span>'; return; }
      if (run.errors.some(function (q) { return q.key === k; })) { el.innerHTML = '<span class="bad">not run - the pattern has an error</span>'; return; }
      el.innerHTML = esc(plural(x.hits, 'match', 'matches')) + (x.caught ? ' · <span class="good">' + x.caught + ' caught</span>' : '') + (x.breaks ? ' · <span class="bad">' + esc(plural(x.breaks, 'break')) + '</span>' : '');
    });
    $$('[data-sugg-for]').forEach(function (el) {
      var k = el.getAttribute('data-sugg-for');
      var list = run ? run.suggestions.filter(function (s) {
        var p = s.patch;
        if (k === 'norm') return Boolean(p.normalise);
        if (k === 'allow') return Boolean(p.addAllow);
        if (k === 'custom') return Boolean(p.custom);
        if (k.indexOf('d:') === 0) return Boolean(p.det && p.det[k.slice(2)]) && Object.keys(p.det).length === 1;
        return false;
      }) : [];
      el.innerHTML = list.slice(0, 2).map(function (s) { return '<div class="dsugg"><p><b>Suggested:</b> ' + esc(s.title) + '</p>' + (s.why ? '<p class="small muted">' + esc(s.why) + '</p>' : '') + '<div class="row"><span class="eff' + (s.effect.break > 0 ? ' worse' : '') + '">' + esc(s.line) + '</span><button class="btn small" type="button" data-act="apply" data-sid="' + esc(s.id) + '">Apply</button></div></div>'; }).join('');
    });
    if (run) (run.timedOut || []).forEach(function (t) {
      ws().rules.custom.concat(ws().rules.allow).forEach(function (c) {
        if ('r:' + (c.flags || '') + '/' + c.src !== t.key) return;
        var el = $('[data-warn="' + (ws().rules.custom.indexOf(c) >= 0 ? 'u:' : 'a:') + c.id + '"]');
        if (el) el.textContent = 'Timed out: this pattern ran for more than ' + (t.ms / 1000).toFixed(1) + ' s on your test set and was skipped. Rewrite it without a repeat inside a repeat.';
      });
    });
  }
  function redrawRules() {
    var pane = $('#rulesPane');
    if (!pane) return;
    var y = scrollY, inner = pane.scrollTop;
    var holder = document.createElement('div');
    holder.innerHTML = rulesPaneHtml();
    pane.replaceWith(holder.firstChild);
    wire();
    drawRuleStats();
    var again = $('#rulesPane'); if (again) again.scrollTop = inner;
    scrollTo(0, y);
  }

  function setRule(path, el) {
    var w = ws(), r = w.rules, parts = path.split(':');
    var val = el.type === 'checkbox' ? el.checked : el.value;
    var structural = false;
    if (path === 'name') r.name = C.line(val, 60);
    else if (path === 'normall') { ['nfkc', 'zw', 'homo'].forEach(function (k) { r.normalise[k] = val; }); if (!val) { r.normalise.url = false; r.normalise.b64 = false; } structural = true; }
    else if (parts[0] === 'norm') { r.normalise[parts[1]] = val; structural = true; }
    else if (parts[0] === 'det') {
      var o = r.det[parts[1]], k = parts[2];
      if (k === 'words') o.words = String(val).split(/\n|,/).map(function (x) { return C.line(x, 30); }).filter(Boolean).slice(0, C.LIMITS.ctxWords);
      else if (k === 'near' || k === 'min') { var n = parseInt(val, 10); if (!isFinite(n)) return; o[k] = n; }
      else o[k] = val;
      if (k === 'on') { var row = $('#det-' + parts[1]); if (row) row.classList.toggle('off', !val); }
    } else if (parts[0] === 'cu' || parts[0] === 'al') {
      var list = parts[0] === 'cu' ? r.custom : r.allow, item = list.filter(function (x) { return x.id === parts[1]; })[0];
      if (!item) return;
      var key = parts[2];
      if (key === 'flag-i') item.flags = val ? 'i' : '';
      else if (key === 'words') item.words = String(val).split('\n').map(function (x) { return C.line(x, C.LIMITS.wordChars); }).filter(Boolean).slice(0, C.LIMITS.words);
      else if (key === 'name') item.name = C.line(val, C.LIMITS.nameChars);
      else if (key === 'src') item.src = String(val).slice(0, C.LIMITS.source);
      else item[key] = val;
      if (key === 'on') { var box = $('#' + (parts[0] === 'cu' ? 'cu-' : 'al-') + item.id); if (box) box.classList.toggle('off', !val); }
      if (key === 'src' || key === 'flag-i') {
        var warn = $('[data-warn="' + (parts[0] === 'cu' ? 'u:' : 'a:') + item.id + '"]');
        var comp = C.compileRegex(item.src, item.flags);
        if (warn && item.kind !== 'text') warn.textContent = comp.error ? 'Not a valid regex: ' + comp.error : parts[0] === 'cu' && C.riskyRegex(item.src) ? 'This pattern repeats a group that itself repeats - it can backtrack for ever. Sieve will stop it after ' + (C.LIMITS.ruleMs / 1000) + ' s if it does.' : '';
      }
    }
    rulesChanged(structural);
  }
  function applyPatchNow(patch, title) {
    var w = ws();
    w.rules = C.applyPatch(w.rules, patch);
    state.lastApplied = 'Applied';
    if (state.view === 'score' || state.view === 'rules') redrawRules();
    schedule(0);
    saveSoon();
    if (state.ws === 'own') pushSoon();
  }
  function findSugg(id) { var run = results(); return run ? run.suggestions.filter(function (s) { return s.id === id; })[0] : null; }

  /* ---------------- the test set ---------------- */

  var CFILTERS = [['all', 'All'], ['in', 'Input'], ['out', 'Output'], ['pass', 'Pass'], ['redact', 'Redact'], ['block', 'Block'], ['attack', 'From the attack'], ['ai', 'AI-written']];
  function casesHtml() {
    var w = ws();
    var h = wsStrip() + '<section class="card"><div class="sec-head"><h1>Test set</h1><span class="small muted">' + esc(plural(w.cases.length, 'case')) + ' of ' + C.LIMITS.cases.toLocaleString() + ' · each up to 8 KB</span></div>' +
      '<div class="cbar"><button class="btn small" type="button" data-act="newcase">+ Write a case</button><button class="btn small ghost" type="button" data-act="import">Import or paste</button><button class="btn small ai" type="button" data-act="ai">✨ Write tricky test cases</button>' + (w.cases.length ? '<button class="btn small danger" type="button" data-act="clearcases">Remove all</button>' : '') + '</div>' +
      '<div id="importBox">' + (state.importing ? importHtml() : '') + '</div>' + keepHtml() + '</section>';
    h += '<section class="card"><div class="filters" role="group" aria-label="Show">' + CFILTERS.map(function (f) {
      var n = w.cases.filter(function (c) { return cMatch(c, f[0]); }).length;
      return (f[0] === 'attack' || f[0] === 'ai') && !n ? '' : '<button type="button" data-act="cfilter" data-f="' + f[0] + '" aria-pressed="' + (state.cfilter === f[0]) + '">' + esc(f[1]) + ' <span class="n">' + n + '</span></button>';
    }).join('') + '</div><label class="field" style="margin:8px 0 10px"><span class="vh">Search the test set</span><input class="input" id="cq" type="search" placeholder="Search the text, the id or the note" value="' + esc(state.cquery) + '" autocomplete="off"></label><ul class="rlist" id="caseList">' + caseListHtml() + '</ul></section>';
    return h;
  }
  function cMatch(c, f) { return f === 'all' || c.dir === f || c.expect === f || c.src === f; }
  function caseListHtml() {
    var w = ws(), q = state.cquery.toLowerCase();
    var list = w.cases.filter(function (c) { return cMatch(c, state.cfilter) && (!q || c.text.toLowerCase().indexOf(q) >= 0 || c.id.toLowerCase().indexOf(q) >= 0 || String(c.note || '').toLowerCase().indexOf(q) >= 0); });
    if (!list.length) return '<li class="muted empty">' + (w.cases.length ? 'No case matches.' : 'No cases yet - write one, import a file or let the AI write tricky ones.') + '</li>';
    var out = list.slice(0, state.cshown).map(function (c) {
      var r = resultOf(c.id);
      return '<li><button class="crow" type="button" data-act="editcase" data-id="' + esc(c.id) + '"><span class="rm"><span class="tagp">' + esc(EXP_WORD[c.expect]) + '</span><span class="tagp">' + dirWord(c.dir) + '</span>' + (r ? opill(r.outcome) : '') + '<span class="small muted">' + esc(c.id) + '</span>' + (c.src === 'ai' ? '<span class="tagp gold">AI-written</span>' : '') + (c.trick ? '<span class="tagp gold">' + esc(C.TRICKS[c.trick].label) + '</span>' : '') + '</span><span class="rt">' + excerpt(c, null, 220) + '</span></button></li>';
    }).join('');
    if (list.length > state.cshown) out += '<li><button class="btn small ghost more" type="button" data-act="cmore">Show ' + Math.min(80, list.length - state.cshown) + ' more</button></li>';
    return out;
  }
  function keepHtml() {
    return '<div class="note" style="margin-top:12px"><label class="check"><input type="checkbox" id="keepBox"' + (state.keep ? ' checked' : '') + '><span>Keep this on this device<small>Rules, test cases and the chart, in this browser only. Off by default - test cases can hold real data.</small></span></label>' + (state.keep ? '<button class="btn small ghost" type="button" data-act="clearkept">Clear it from this device</button>' : '') + '</div>';
  }
  function importHtml() {
    var im = state.importing;
    var h = '<div class="stack" style="margin-top:12px">';
    if (im.read) {
      var r = im.read, n = { pass: 0, redact: 0, block: 0 };
      r.cases.forEach(function (c) { n[c.expect]++; });
      h += '<div class="note"><p style="margin:0"><b>Read ' + esc(plural(r.cases.length, 'case')) + '</b> from ' + esc(im.name) + ' (' + esc(r.format.toUpperCase()) + '): ' + n.pass + ' to pass, ' + n.redact + ' to redact, ' + n.block + ' to block.' + (r.skipped ? ' ' + esc(plural(r.skipped, 'row')) + ' left out.' : '') + '</p>' +
        (r.problems.length ? '<ul class="notes">' + r.problems.slice(0, 8).map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
        (r.cases.length ? '<div class="btns" style="margin-top:10px"><button class="btn small" type="button" data-act="importadd">Add them</button><button class="btn small ghost" type="button" data-act="importreplace">Replace the test set</button><button class="btn small ghost" type="button" data-act="importcancel">Cancel</button></div>' : '<div class="btns" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="importcancel">Close</button></div>') + '</div>';
      return h + '</div>';
    }
    h += '<div class="drop" data-drop="1"><b>Choose a CSV, JSONL or JSON file</b><span class="small muted">Columns: <code>text</code>, <code>direction</code> (input / output), <code>expect</code> (pass / redact / block), <code>spans</code> as start-end pairs (<code>12-31;40-44</code>) or the sensitive text itself, separated by <code>|</code>. Read on this device - never uploaded.</span><span class="btn small filepick">Choose a file<input type="file" id="importFile" accept=".csv,.jsonl,.json,.txt,text/csv,application/json"></span></div>' +
      '<label class="field"><span>Or paste it</span><textarea class="input code" id="importPaste" rows="5" spellcheck="false" placeholder="text,direction,expect,spans&#10;&quot;Card is 4111 1111 1111 1111&quot;,input,block,4111 1111 1111 1111"></textarea></label>' +
      '<div class="btns"><button class="btn small" type="button" data-act="importread">Read it</button><button class="btn small ghost" type="button" data-act="importcancel">Cancel</button></div><div id="importErr"></div>';
    return h + '</div>';
  }
  function readImport(text, name) {
    if (text.length > C.LIMITS.cases * C.LIMITS.caseBytes + 65536) { $('#importErr').innerHTML = '<p class="err">That is more than the test set can hold - split it.</p>'; return; }
    var w = ws();
    var r = C.parseCases(text, { first: w.seq });
    state.importing = { read: r, name: name };
    $('#importBox').innerHTML = importHtml();
    wire();
    $('#importBox').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function addCases(list, replace) {
    var w = ws();
    var ids = {};
    if (replace) w.cases = [];
    w.cases.forEach(function (c) { ids[c.id] = true; });
    var room = C.LIMITS.cases - w.cases.length, added = 0;
    list.slice(0, Math.max(0, room)).forEach(function (c) {
      var x = Object.assign({}, c);
      while (!x.id || ids[x.id]) x.id = 'c' + (w.seq++);
      ids[x.id] = true;
      w.cases.push(x); added++;
    });
    w.cases = w.cases.slice();
    casesChanged();
    return { added: added, left: list.length - added };
  }

  function openEditor(id) {
    var w = ws(), c = id ? caseOf(id) : null;
    var d = c ? { text: c.text, dir: c.dir, expect: c.expect, spans: c.spans.map(function (s) { return s.slice(); }), note: c.note || '' } : { text: '', dir: 'in', expect: 'redact', spans: [], note: '' };
    var seg = function (name, opts, cur) { return '<div class="seg" role="group" aria-label="' + esc(name) + '">' + opts.map(function (o) { return '<button type="button" data-ed="' + esc(name) + '" data-v="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>'; };
    sheet('<h2>' + (c ? 'Case ' + esc(c.id) : 'A new test case') + '</h2>' +
      '<label class="field"><span>The message</span><textarea class="input" id="edText" rows="6" spellcheck="false" maxlength="9000">' + esc(d.text) + '</textarea><small>Select the sensitive part, then mark it. Up to 8 KB.</small></label>' +
      '<div class="btns" style="margin-top:8px"><button class="btn small" type="button" id="edMark">Mark the selection as sensitive</button><button class="btn small ghost" type="button" id="edFind">Find likely spans</button></div>' +
      '<ul class="spanchips" id="edSpans" style="margin-top:8px" aria-label="Marked spans"></ul>' +
      '<div class="field" style="margin-top:12px"><span>Direction</span>' + seg('dir', [['in', 'Input to the agent'], ['out', 'Output from the agent']], d.dir) + '</div>' +
      '<div class="field" style="margin-top:10px"><span>Expected</span>' + seg('expect', [['pass', 'Pass untouched'], ['redact', 'Redact the marked parts'], ['block', 'Block it whole']], d.expect) + '</div>' +
      '<label class="field" style="margin-top:10px"><span>Note (optional)</span><input class="input" id="edNote" maxlength="' + C.LIMITS.noteChars + '" value="' + esc(d.note) + '" autocomplete="off"></label>' +
      '<div class="field" style="margin-top:10px"><span>Preview</span><pre class="txt" id="edPrev"></pre></div>' +
      '<div id="edErr"></div><div class="btns" style="margin-top:10px"><button class="btn" type="button" id="edSave">' + (c ? 'Save' : 'Add to the test set') + '</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button>' + (c ? '<button class="btn danger" type="button" id="edDel">Delete</button>' : '') + '</div>',
      function (root) {
        var ta = $('#edText', root), last = d.text;
        function drawSpans() {
          $('#edSpans', root).innerHTML = d.spans.map(function (s, i) { return '<li><span>' + vis(d.text.slice(s[0], s[1]), true) + '</span><button type="button" data-rm="' + i + '" aria-label="Unmark">×</button></li>'; }).join('');
          $('#edPrev', root).innerHTML = d.text ? paint(d.text, { exp: d.expect === 'pass' ? [] : d.spans }) : '<span class="muted">The message, with the marked parts highlighted.</span>';
          $$('[data-rm]', root).forEach(function (b) { b.addEventListener('click', function () { d.spans.splice(+b.getAttribute('data-rm'), 1); drawSpans(); }); });
        }
        ta.addEventListener('input', function () {
          var t = C.caseText(ta.value);
          // Keep each mark on its text, wherever an edit moved it.
          d.spans = d.spans.map(function (s) { var sub = last.slice(s[0], s[1]), at = t.indexOf(sub, Math.max(0, s[0] - 200)); if (at < 0) at = t.indexOf(sub); return at >= 0 && sub ? [at, at + sub.length] : null; }).filter(Boolean);
          d.text = t; last = t; drawSpans();
        });
        $('#edMark', root).addEventListener('click', function () {
          var a = ta.selectionStart, z = ta.selectionEnd;
          if (z <= a) { toast('Select the sensitive part of the message first.'); return; }
          d.text = C.caseText(ta.value); last = d.text;
          d.spans = C.mergeRanges(d.spans.concat([[a, z]])).slice(0, C.LIMITS.spans);
          if (d.expect === 'pass') { d.expect = 'redact'; $$('[data-ed="expect"]', root).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === 'redact')); }); }
          drawSpans();
        });
        $('#edFind', root).addEventListener('click', function () {
          d.text = C.caseText(ta.value); last = d.text;
          var found = C.likelySpans(d.text);
          if (!found.length) { toast('The built-in detectors find nothing here. Select it by hand.'); return; }
          d.spans = C.mergeRanges(d.spans.concat(found)).slice(0, C.LIMITS.spans);
          drawSpans();
          toast('Marked ' + plural(found.length, 'likely span') + ' - check ' + (found.length === 1 ? 'it' : 'them') + '.');
        });
        $$('[data-ed]', root).forEach(function (b) {
          b.addEventListener('click', function () {
            var k = b.getAttribute('data-ed');
            d[k] = b.getAttribute('data-v');
            $$('[data-ed="' + k + '"]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
            drawSpans();
          });
        });
        $('#edSave', root).addEventListener('click', function () {
          var raw = { id: c ? c.id : 'c' + w.seq, text: C.caseText(ta.value), dir: d.dir, expect: d.expect, spans: d.spans, note: $('#edNote', root).value, src: c ? c.src : 'you', trick: c ? c.trick : undefined };
          var res = C.cleanCase(raw);
          if (res.error) { $('#edErr', root).innerHTML = '<p class="err" role="alert">' + esc(res.error === 'no text' ? 'Write the message first.' : res.error === 'over 8 KB' ? 'That message is over 8 KB.' : res.error) + '</p>'; return; }
          if (res.case.expect !== 'pass' && !res.case.spans.length) { $('#edErr', root).innerHTML = '<p class="err" role="alert">Mark what is sensitive, so Sieve can tell a leak from a catch - or choose Pass untouched.</p>'; return; }
          if (c) { w.cases = w.cases.map(function (x) { return x.id === c.id ? res.case : x; }); }
          else { if (w.cases.length >= C.LIMITS.cases) { $('#edErr', root).innerHTML = '<p class="err">The test set is full.</p>'; return; } w.seq++; w.cases = w.cases.concat([res.case]); }
          closeSheet();
          casesChanged();
          if (state.view === 'cases') draw();
          toast(c ? 'Saved - re-scoring.' : 'Added - re-scoring.');
        });
        var del = $('#edDel', root);
        if (del) del.addEventListener('click', function () { w.cases = w.cases.filter(function (x) { return x.id !== c.id; }); closeSheet(); casesChanged(); if (state.view === 'cases') draw(); toast('Deleted.'); });
        drawSpans();
        setTimeout(function () { try { if (!c) ta.focus(); } catch (e) { /* ignore */ } }, 60);
      });
  }

  /* ---------------- attack my rules ---------------- */

  function runAttack() {
    var w = ws();
    if (!w || !w.cases.length) return;
    state.attackBusy = true;
    var wsName = state.ws;
    ensureCases().then(function () { return call('attack', { rules: w.rules }); }).then(function (out) {
      state.attackBusy = false;
      if (wsName !== state.ws) return;
      state.attack = out; state.attackStale = false;
      if (state.view === 'attack') { var y = scrollY; draw(); scrollTo(0, y); }
    }).catch(function (err) { state.attackBusy = false; if (err && err.code === 'replaced') return; toast(err.message, 4200); });
  }
  function attackHtml() {
    var w = ws(), a = state.attack, r = w.rules;
    var h = wsStrip() + '<section class="card"><div class="sec-head"><h1>Attack my rules</h1><span class="small muted">Deterministic, on this device</span></div>' +
      '<p>From every sensitive case your rules catch now, Sieve writes the same value ten ways people hide it - spaced digits, full-width characters, zero-width characters, look-alike letters, base64, split across lines, URL-encoded, reversed, written as words - and runs your rules on them.</p>';
    if (!w.cases.length) return h + '<p class="muted">Add test cases first: the attack starts from what your rules already catch.</p></section>';
    if (!a || state.attackStale) return h + '<p class="muted" style="margin:0">Attacking…</p></section>';
    if (!a.tried) return h + '<p class="muted" style="margin:0">Nothing to attack yet: no sensitive case is caught by your rules right now. Fix the leaks on the Score tab first.</p></section>';
    var pctOf = function (n) { return a.tried ? Math.round((n / a.tried) * 100) : 0; };
    var full = r.normalise.nfkc && r.normalise.zw && r.normalise.homo, deep = full && r.normalise.url && r.normalise.b64;
    h += '<p class="scoreline" style="font-size:1.15rem">' + esc(a.survive + ' of ' + a.tried + ' variants get through') + ' <span class="small muted">(from ' + esc(plural(a.from, 'case')) + ')</span></p>' +
      '<div class="bars" style="margin-top:10px">' +
      '<div class="barrow"><span class="lbl">Your rules as they are</span><span class="val">' + a.survive + '</span><div class="bar"><i data-w="' + pctOf(a.survive) + '"></i></div></div>' +
      '<div class="barrow"><span class="lbl">With the normaliser (NFKC, zero-width, look-alikes)</span><span class="val">' + a.normSurvive + '</span><div class="bar b-norm"><i data-w="' + pctOf(a.normSurvive) + '"></i></div></div>' +
      '<div class="barrow"><span class="lbl">…and decoding %-escapes and base64</span><span class="val">' + a.deepSurvive + '</span><div class="bar b-deep"><i data-w="' + pctOf(a.deepSurvive) + '"></i></div></div></div>' +
      '<div class="btns" style="margin-top:12px">' + (!full ? '<button class="btn small" type="button" data-act="normon">Turn on the normaliser (−' + (a.survive - a.normSurvive) + ')</button>' : '<span class="tagp" style="align-self:center">✓ Normaliser on</span>') +
      (!deep ? '<button class="btn small ghost" type="button" data-act="normdeep">Also decode %-escapes and base64 (−' + (Math.max(0, (full ? a.survive : a.normSurvive) - a.deepSurvive)) + ')</button>' : '') + '</div>' +
      '<p class="small muted" style="margin:10px 0 0">No normaliser reads words or reversed text. What still gets through is the case for blocking on the output side, or keeping secrets out of the agent’s reach.</p>';
    h += '<div class="tablewrap" style="margin-top:12px" tabindex="0" role="region" aria-label="By trick"><table class="t"><thead><tr><th>Trick</th><th class="r">Tried</th><th class="r">Get through</th><th class="r">With normaliser</th><th class="r">With decoding</th></tr></thead><tbody>' +
      a.tricks.map(function (t) { return '<tr><td class="name">' + esc(t.label) + '</td><td class="r">' + t.tried + '</td><td class="r">' + t.now + '</td><td class="r">' + t.norm + '</td><td class="r">' + t.deep + '</td></tr>'; }).join('') + '</tbody></table></div>';
    var survOn = w.attackAdded;
    h += '<div class="note" style="margin-top:12px"><label class="check"><input type="checkbox" id="survBox"' + (survOn ? ' checked' : '') + (a.survive || survOn ? '' : ' disabled') + '><span>Add the ' + esc(plural(a.survive, 'survivor')) + ' to the test set<small>They come in labelled as their originals were, so the score shows them as leaks to fix. Untick to take them out again.</small></span></label></div></section>';
    if (a.survivors.length) {
      var by = {};
      a.survivors.forEach(function (s) { (by[s.v.trick] = by[s.v.trick] || []).push(s); });
      h += '<section class="card"><h2>What gets through</h2>' + C.TRICK_IDS.filter(function (t) { return by[t]; }).map(function (t) {
        return '<details class="why"><summary>' + esc(C.TRICKS[t].label) + ' · ' + by[t].length + '</summary><ul class="surv">' + by[t].slice(0, 40).map(function (s) {
          return '<li><span class="rm small muted">from ' + esc(s.v.from) + ' · ' + dirWord(s.v.dir) + (s.normCatches ? ' · <span class="tagp">the normaliser catches it</span>' : s.deepCatches ? ' · <span class="tagp">decoding catches it</span>' : '') + '</span><pre class="txt">' + paint(s.v.text, { leak: s.v.spans }) + '</pre></li>';
        }).join('') + '</ul></details>';
      }).join('') + '</section>';
    }
    return h;
  }

  /* ---------------- export ---------------- */

  function reportText() {
    var run = results();
    return run ? C.reportMarkdown(ws().cases, ws().rules, run, today()) : 'Run the test set first.';
  }
  function exportHtml() {
    var w = ws();
    var h = wsStrip() + '<div class="sec-head"><h1>Export</h1><span class="small muted">🔒 Made on this device · CSV cells starting = + - @ get a \' so a spreadsheet never runs them</span></div><div class="stack">';
    h += '<section class="card"><h2>The rule set</h2><p class="small muted">JSON: detectors, your regexes and keyword lists, the allow-list, actions and directions. Import it here on another device, or keep it with your agent’s code.</p><div class="btns"><button class="btn small" type="button" data-act="dlrules">Download sieve-rules.json</button><button class="btn small ghost" type="button" data-act="copyrules">Copy</button><span class="btn small ghost filepick">Import a rule set<input type="file" id="rulesFile" accept=".json,application/json"></span></div><details class="why"><summary>Preview</summary><pre class="out">' + esc(C.exportRules(w.rules)) + '</pre></details></section>';
    h += '<section class="card"><h2>The run, as a report</h2><p class="small muted">Markdown: the score, the rules, every leak and break. Values are masked and shortened (41••••11), so it can be shared.</p><div class="btns"><button class="btn small" type="button" data-act="dlreport">Download the report</button><button class="btn small ghost" type="button" data-act="copyreport">Copy</button></div><details class="why"><summary>Preview</summary><pre class="out wrapit" id="reportOut">' + esc(reportText()) + '</pre></details></section>';
    h += '<section class="card"><h2>The test set</h2><p class="small muted">JSONL or CSV, with the spans as start-end pairs. These hold your test cases as written - real values stay in them, so keep the file where you keep secrets.</p><div class="btns"><button class="btn small" type="button" data-act="dljsonl"' + (w.cases.length ? '' : ' disabled') + '>Download JSONL</button><button class="btn small ghost" type="button" data-act="dlcsv"' + (w.cases.length ? '' : ' disabled') + '>Download CSV</button></div></section>';
    h += '<section class="card"><h2>On this device</h2>' + keepHtml() + '</section>';
    return h + '</div>';
  }

  /* ---------------- the account, sync and the AI ---------------- */

  var pushTimer = null;
  function pushSoon() {
    if (!signedIn() || !state.me.sync || state.ws !== 'own') return;
    clearTimeout(pushTimer);
    state.syncState = 'syncing'; drawSync();
    pushTimer = setTimeout(function () { pushRules(); }, 800);
  }
  function pushRules(base) {
    if (!signedIn() || !state.W.own) return Promise.resolve();
    var r = state.W.own.rules;
    return api('PUT', 'api/rules', { rules: r, base: base !== undefined ? base : state.syncBase }).then(function (out) {
      state.syncBase = out.rules.updatedAt; state.syncState = 'synced'; saveSoon(); drawSync();
    }).catch(function (err) {
      if (err.status === 409 && err.data && err.data.rules) return openConflict(err.data.rules);
      state.syncState = 'error'; state.syncErr = err.message; drawSync();
    });
  }
  function pristine(r) { var a = C.cleanRules(r).rules, b = C.defaults(); delete a.updatedAt; return JSON.stringify(a) === JSON.stringify(b); }
  function syncIn() {
    if (!signedIn() || !state.me.sync) return Promise.resolve();
    return api('GET', 'api/rules').then(function (out) {
      var acc = out.rules, own = state.W.own;
      if (!acc) { state.syncBase = null; if (own && !pristine(own.rules)) return pushRules(null); state.syncState = 'synced'; drawSync(); return null; }
      if (!own) { state.W.own = ownWs(); own = state.W.own; }
      if (pristine(own.rules)) { own.rules = C.cleanRules(acc).rules; state.syncBase = acc.updatedAt; state.syncState = 'synced'; if (state.ws === 'own') { redrawRules(); schedule(0); } drawSync(); saveSoon(); return null; }
      if (state.syncBase === acc.updatedAt) return pushRules();
      var a = JSON.stringify(Object.assign(C.cleanRules(acc).rules, { updatedAt: 0 })), b = JSON.stringify(Object.assign(C.cleanRules(own.rules).rules, { updatedAt: 0 }));
      if (a === b) { state.syncBase = acc.updatedAt; state.syncState = 'synced'; drawSync(); return null; }
      return openConflict(acc);
    }).catch(function () { state.syncState = 'error'; drawSync(); });
  }
  function openConflict(acc) {
    if (state.conflictOpen) return;
    state.conflictOpen = true;
    var own = state.W.own.rules, a = C.cleanRules(acc).rules;
    var desc = function (r) { return esc(plural(onCount(r), 'rule')) + ' on, ' + esc(plural(r.custom.length, 'custom rule')) + ', ' + esc(plural(r.allow.length, 'allow-list entry', 'allow-list entries')); };
    sheet('<h2>Your rules changed on another device</h2><p class="muted">The copy in your account is newer than the one this device last saw.</p><div class="note"><p style="margin:0"><b>This device:</b> ' + desc(own) + '</p><p style="margin:6px 0 0"><b>Your account:</b> ' + desc(a) + '</p></div>' +
      '<div class="btns" style="margin-top:12px"><button class="btn" type="button" id="cfMerge">Merge them</button><button class="btn ghost" type="button" id="cfTake">Use the account’s copy</button><button class="btn ghost" type="button" id="cfKeep">Keep this device’s</button></div><p class="small muted" style="margin-top:8px">Merging keeps this device’s settings and adds the custom rules and allow-list entries only the account has.</p>', function (root) {
      var done = function (rules, msg) { state.conflictOpen = false; closeSheet(); state.W.own.rules = rules; if (state.ws === 'own') { if (state.view === 'score' || state.view === 'rules') redrawRules(); schedule(0); } toast(msg); };
      $('#cfMerge', root).addEventListener('click', function () { var m = C.mergeRules(a, own); done(m.rules, 'Merged' + (m.added ? ': ' + plural(m.added, 'rule') + ' added from the other device.' : '.')); pushRules(acc.updatedAt); });
      $('#cfTake', root).addEventListener('click', function () { done(a, 'Using the account’s copy.'); state.syncBase = acc.updatedAt; state.syncState = 'synced'; drawSync(); saveSoon(); });
      $('#cfKeep', root).addEventListener('click', function () { done(own, 'Keeping this device’s rules.'); pushRules(acc.updatedAt); });
    });
  }
  function syncLine() {
    if (state.ws === 'demo') return '<span class="sync muted small">The demo’s rules stay on this device. <button class="link-btn" type="button" data-act="own">Your own rules</button> can follow your account.</span>';
    if (!signedIn()) return '<span class="sync muted small">Kept in this tab' + (state.keep ? ' and on this device' : '') + ' · <button class="link-btn" type="button" data-act="signin">sign in to keep the rules in your account</button> (never the test cases)</span>';
    if (state.me && !state.me.sync) return '<span class="sync muted small">Saving to the account is unavailable right now - the rules are on this device.</span>';
    if (state.syncState === 'syncing') return '<span class="sync muted small">Saving the rules to your account…</span>';
    if (state.syncState === 'error') return '<span class="sync small err">Couldn’t save the rules to your account' + (state.syncErr ? ': ' + esc(state.syncErr) : '') + ' <button class="link-btn" type="button" data-act="retrysync">Try again</button></span>';
    return '<span class="sync small" style="color:var(--ok);font-weight:700">✓ Rules saved to your account - never a test case or a match</span>';
  }
  function drawSync() { $$('[data-sync]').forEach(function (el) { el.innerHTML = syncLine(); }); }

  function openAi() {
    var body = { category: 'lookalike', about: '' };
    function payload() { var b = { category: body.category }; if (body.about) b.about = body.about; return b; }
    sheet('<h2>✨ Write tricky test cases</h2><p class="muted small">The AI proposes up to 20 labelled cases for one kind of data, using only obviously fake values - documented test cards, keys with EXAMPLE in them, example.com addresses, 555-01xx phones. You check each label, then add the ones you want.</p>' +
      '<div class="field"><span>What kind</span><div class="seg" role="group" aria-label="What kind">' + Object.keys(C.AI_CATS).map(function (k) { return '<button type="button" data-cat="' + k + '" aria-pressed="' + (body.category === k) + '">' + esc(C.AI_CATS[k].label) + '</button>'; }).join('') + '</div></div>' +
      '<label class="field" style="margin-top:10px"><span>Your agent, in one sentence (optional)</span><input class="input" id="aiAbout" maxlength="' + C.LIMITS.aboutChars + '" placeholder="A support bot for an outdoor shop" autocomplete="off"><small>⚠ Don’t paste data. Describe the agent in words - a description with an address, a number or a key in it is refused, here and on the server.</small></label>' +
      '<div class="note" style="margin-top:12px"><p style="margin:0"><b>Exactly what is sent:</b> <code id="aiPay"></code></p><p class="small muted" style="margin:6px 0 0">Nothing else - none of your test cases, rules or results.</p></div>' +
      '<div id="aiErr"></div><div class="btns" id="aiActs" style="margin-top:10px"></div><div id="aiOut"></div>', function (root) {
      function drawPay() { $('#aiPay', root).textContent = JSON.stringify(payload()); }
      function drawActs() {
        var acts = $('#aiActs', root);
        if (!signedIn()) {
          acts.innerHTML = '<p class="small muted" style="width:100%;margin:0">This uses about a cent of AI credit, so it needs a free account (it comes with $2). Everything else in Sieve is free with no account.</p><button class="btn" type="button" id="aiSignin">Create a free account</button><button class="btn ghost" type="button" data-act="closesheet">Not now</button>';
          $('#aiSignin', root).addEventListener('click', function () { openAccount('Writing test cases uses about a cent of AI credit; a free account comes with $2.', openAi); });
          return;
        }
        acts.innerHTML = '<button class="btn ai" type="button" id="aiGo">Write the cases</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button>';
        $('#aiGo', root).addEventListener('click', send);
      }
      function send() {
        var chk = C.aiRequest(payload());
        if (chk.error) { $('#aiErr', root).innerHTML = '<p class="err" role="alert">' + esc(chk.error) + '</p>'; $('#aiErr', root).scrollIntoView({ block: 'nearest' }); return; }
        $('#aiErr', root).innerHTML = '';
        var go = $('#aiGo', root); go.disabled = true; go.textContent = 'Writing…';
        api('POST', 'api/ai/cases', payload()).then(function (out) { go.disabled = false; go.textContent = 'Write more'; propose(out); }).catch(function (err) {
          go.disabled = false; go.textContent = 'Write the cases';
          if (err.status === 401) return openAccount('Sign in to write test cases.', openAi);
          if (err.status === 402) return openCredit(err.data);
          if (err.data && err.data.code === 'verify-email') return verifyNote($('#aiErr', root), err);
          showError(err, $('#aiErr', root));
        });
      }
      function propose(out) {
        var box = $('#aiOut', root);
        box.innerHTML = '<p class="ailabel" style="margin-top:14px">✨ AI-written - check the labels</p>' + (out.dropped && out.dropped.length ? '<p class="small muted">' + esc(plural(out.dropped.length, 'case')) + ' left out: ' + esc(out.dropped.slice(0, 3).join(' ')) + '</p>' : '') +
          '<ul class="proposal">' + out.cases.map(function (c, i) {
            return '<li><input type="checkbox" id="pp' + i + '" checked><label for="pp' + i + '"><span class="rm"><span class="tagp">' + esc(EXP_WORD[c.expect]) + '</span><span class="tagp">' + dirWord(c.dir) + '</span></span><span class="rt">' + paint(c.text, { exp: c.spans }, true) + '</span>' + (c.note ? '<span class="small muted">' + esc(c.note) + '</span>' : '') + '</label></li>';
          }).join('') + '</ul><div class="btns" style="margin-top:10px"><button class="btn" type="button" id="ppAdd">Add the ticked cases</button></div>';
        var lbl = $('.ailabel', box); if (lbl) lbl.scrollIntoView({ block: 'start', behavior: 'smooth' });
        $('#ppAdd', root).addEventListener('click', function () {
          var pick = out.cases.filter(function (c, i) { return $('#pp' + i, root).checked; }).map(function (c) { var r = C.cleanCase(Object.assign({}, c, { id: '' })); return r.case ? Object.assign(r.case, { id: '', src: 'ai' }) : null; }).filter(Boolean);
          if (!pick.length) { toast('Tick at least one.'); return; }
          var res = addCases(pick, false);
          closeSheet();
          if (state.view === 'cases') draw();
          toast('Added ' + plural(res.added, 'AI-written case') + ' - re-scoring.');
        });
      }
      $$('[data-cat]', root).forEach(function (b) { b.addEventListener('click', function () { body.category = b.getAttribute('data-cat'); $$('[data-cat]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); drawPay(); }); });
      $('#aiAbout', root).addEventListener('input', function (e) { body.about = C.line(e.target.value, C.LIMITS.aboutChars); drawPay(); });
      drawPay(); drawActs();
    });
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
    setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    document.body.classList.remove('sheet-open');
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { state.conflictOpen = false; closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; drawSync(); }

  var FREE_LINE = 'Rules, test cases, scoring, the attack and every export are free with no account, and never leave this device. A free account keeps your rule set across devices (never your test cases) and adds “Write tricky test cases” - it comes with $2 of AI credit, and one account works across every app on this site.';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); return syncIn(); }).then(function () { if (then) then(); else if (state.view !== 'start') draw(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { return syncIn(); }).then(function () { if (then) then(); else if (state.view !== 'start') draw(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Writing a set of test cases costs about a cent. Rules, scoring, the attack and exports are free and never leave this device.</p><div id="billing"></div></div>' +
      '<p class="small" style="margin-top:14px" data-sync>' + syncLine() + '</p>' +
      '<button class="btn ghost block" id="forget" type="button" style="margin-top:6px">Remove my rules from the account</button>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.syncBase = null; drawTop(); if (state.view !== 'start') draw(); }); });
        $('#forget', root).addEventListener('click', function () {
          if (!confirm('Remove your rules from the account? This device keeps its copy.')) return;
          api('DELETE', 'api/rules').then(function () { state.syncBase = null; state.syncState = 'local'; closeSheet(); toast('Removed from the account. This device still has them.'); }).catch(function (e) { showError(e); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Rules, scoring, the attack and exports keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring ---------------- */

  var typeTimer = null;
  // Each element is wired once, however many times part of a view is redrawn around it.
  function once(el) { if (!el || el.getAttribute('data-wired')) return false; el.setAttribute('data-wired', '1'); return true; }
  function wire() {
    $$('[data-r]').forEach(function (el) {
      if (el.tagName === 'BUTTON' || !once(el)) return;
      var ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, function () {
        if (ev === 'input') { clearTimeout(typeTimer); typeTimer = setTimeout(function () { setRule(el.getAttribute('data-r'), el); }, 120); }
        else setRule(el.getAttribute('data-r'), el);
      });
    });
    $$('details[data-open]').forEach(function (d) { if (once(d)) d.addEventListener('toggle', function () { state.openDet[d.getAttribute('data-open')] = d.open; }); });
    var cq = $('#cq');
    if (once(cq)) cq.addEventListener('input', function () { state.cquery = cq.value; state.cshown = 80; $('#caseList').innerHTML = caseListHtml(); });
    var kb = $('#keepBox');
    if (once(kb)) kb.addEventListener('change', function () {
      state.keep = kb.checked;
      if (kb.checked) { saveNow(); toast('Kept on this device. Clear it any time.'); } else { clearKept(); toast('Nothing is kept on this device now.'); }
      draw();
    });
    var sb = $('#survBox');
    if (once(sb)) sb.addEventListener('change', function () { toggleSurvivors(sb.checked); });
    var f = $('#importFile');
    if (once(f)) f.addEventListener('change', function (e) { var file = e.target.files && e.target.files[0]; e.target.value = ''; if (file) readFileNow(file); });
    $$('[data-drop]').forEach(function (z) {
      if (!once(z)) return;
      z.addEventListener('dragover', function (e) { e.preventDefault(); z.classList.add('over'); });
      z.addEventListener('dragleave', function () { z.classList.remove('over'); });
      z.addEventListener('drop', function (e) { e.preventDefault(); z.classList.remove('over'); var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (file) readFileNow(file); });
    });
    var rf = $('#rulesFile');
    if (once(rf)) rf.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0]; e.target.value = '';
      if (!file) return;
      if (file.size > 256 * 1024) { toast('That file is too big to be a rule set.'); return; }
      file.text().then(function (t) {
        var r = C.importRules(t);
        if (r.error) { toast(r.error, 4200); return; }
        if (!confirm('Replace the current rules with the ones in ' + file.name + '?')) return;
        ws().rules = r.rules; rulesChanged(false); draw(); toast('Rules imported - re-scoring.');
      });
    });
  }
  function readFileNow(file) {
    if (file.size > C.LIMITS.cases * C.LIMITS.caseBytes + 65536) { $('#importErr').innerHTML = '<p class="err">That file is more than the test set can hold - split it.</p>'; return; }
    file.text().then(function (t) { readImport(t, file.name); }, function () { $('#importErr').innerHTML = '<p class="err">That file could not be read.</p>'; });
  }
  function toggleSurvivors(on) {
    var w = ws(), a = state.attack;
    if (on && a) {
      var list = a.survivors.map(function (s) { var r = C.cleanCase(Object.assign({}, s.v, { src: 'attack' })); return r.case; }).filter(Boolean);
      w.cases = w.cases.filter(function (c) { return c.src !== 'attack'; });
      var res = addCases(list, false);
      w.attackAdded = true;
      toast('Added ' + plural(res.added, 'survivor') + ' - they show as leaks on the Score tab.', 3000);
    } else {
      w.cases = w.cases.filter(function (c) { return c.src !== 'attack'; });
      w.attackAdded = false;
      casesChanged();
      toast('The survivors are out of the test set again.');
    }
    state.attackStale = true;
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    var w = ws();
    switch (act) {
      case 'closesheet': state.conflictOpen = false; closeSheet(); break;
      case 'home': e.preventDefault(); go(''); break;
      case 'tab': go(t.getAttribute('data-tab')); break;
      case 'demo': useWs('demo', false); go('score'); break;
      case 'own': useWs('own', false); go('score'); syncIn(); break;
      case 'copydemo': addCases(cleanList(D.cases()).map(function (c) { return Object.assign(c, { src: 'demo' }); }), false); toast('The demo’s 40 cases are in your test set - re-scoring against your rules.'); draw(); break;
      case 'filter': state.filter = state.filter === t.getAttribute('data-f') && t.classList.contains('tile') ? 'problems' : t.getAttribute('data-f'); state.shown = 60; afterRun(null); break;
      case 'more': state.shown += 60; afterRun(null); break;
      case 'case': openCase(id); break;
      case 'editcase': openEditor(id); break;
      case 'newcase': openEditor(null); break;
      case 'apply': { var s = findSugg(t.getAttribute('data-sid')); if (s) { closeSheet(); applyPatchNow(s.patch, s.title); } break; }
      case 'fixall':
        t.disabled = true;
        call('fixall', { rules: w.rules }).then(function (out) {
          if (!out.applied.length) { toast('Nothing safe left to apply.'); return; }
          w.rules = out.rules; state.lastApplied = 'Applied ' + plural(out.applied.length, 'fix', 'fixes');
          redrawRules(); schedule(0); saveSoon(); if (state.ws === 'own') pushSoon();
        }).catch(function (err) { if (!err || err.code !== 'replaced') toast(err.message, 4200); });
        break;
      case 'allsugg': state.showAllSugg = !state.showAllSugg; afterRun(null); break;
      case 'hintoff': state.hint = true; saveSoon(); afterRun(null); break;
      case 'retryrx': if (runner) runner.retry(t.getAttribute('data-k')); schedule(0); break;
      case 'rpick': {
        var grp = t.parentNode;
        $$('button', grp).forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); });
        setRule(t.getAttribute('data-r'), { type: 'button', value: t.getAttribute('data-v') });
        break;
      }
      case 'addrx': w.rules.custom.push({ id: newId('u'), name: 'Custom rule ' + (w.rules.custom.length + 1), kind: 'regex', src: '', flags: '', words: [], wb: true, cs: false, cat: 'custom', act: 'redact', dir: 'both', on: true }); rulesChanged(true); focusLast('#rulesPane .custom:last-of-type input.rx'); break;
      case 'addwords': w.rules.custom.push({ id: newId('u'), name: 'Keyword list ' + (w.rules.custom.length + 1), kind: 'words', src: '', flags: '', words: [], wb: true, cs: false, cat: 'custom', act: 'flag', dir: 'both', on: true }); rulesChanged(true); focusLast('#rulesPane .custom:last-of-type textarea'); break;
      case 'cudel': w.rules.custom = w.rules.custom.filter(function (c) { return c.id !== id; }); rulesChanged(true); break;
      case 'addallow': w.rules.allow.push({ id: newId('a'), name: 'Allow ' + (w.rules.allow.length + 1), kind: 'regex', src: '', flags: '', on: true }); rulesChanged(true); focusLast('#rulesPane .custom:last-of-type input.rx'); break;
      case 'addallowtext': w.rules.allow.push({ id: newId('a'), name: 'Allow ' + (w.rules.allow.length + 1), kind: 'text', src: '', flags: '', on: true }); rulesChanged(true); focusLast('#rulesPane .custom:last-of-type input.rx'); break;
      case 'aldel': w.rules.allow = w.rules.allow.filter(function (a) { return a.id !== id; }); rulesChanged(true); break;
      case 'cfilter': state.cfilter = t.getAttribute('data-f'); state.cshown = 80; draw(); break;
      case 'cmore': state.cshown += 80; $('#caseList').innerHTML = caseListHtml(); break;
      case 'import': if (state.view !== 'cases') { state.importing = {}; go('cases'); } else { state.importing = {}; $('#importBox').innerHTML = importHtml(); wire(); } break;
      case 'importread': { var pv = $('#importPaste'); if (!pv || !pv.value.trim()) { $('#importErr').innerHTML = '<p class="err">Paste the rows first, or choose a file.</p>'; break; } readImport(pv.value, 'what you pasted'); break; }
      case 'importadd': case 'importreplace': {
        if (act === 'importreplace' && w.cases.length && !confirm('Replace all ' + w.cases.length + ' cases?')) break;
        var res = addCases(state.importing.read.cases.map(function (c) { return Object.assign(c, { id: '', src: 'import' }); }), act === 'importreplace');
        state.importing = null; draw();
        toast('Added ' + plural(res.added, 'case') + (res.left ? ' (' + res.left + ' did not fit)' : '') + ' - re-scoring.');
        break;
      }
      case 'importcancel': state.importing = null; $('#importBox').innerHTML = ''; break;
      case 'clearcases': if (confirm('Remove all ' + w.cases.length + ' test cases from this ' + (state.ws === 'demo' ? 'demo' : 'workspace') + '?')) { w.cases = []; w.attackAdded = false; casesChanged(); draw(); } break;
      case 'ai': openAi(); break;
      case 'normon': applyPatchNow({ normalise: C.FULL_NORM }, 'the normaliser'); state.attackStale = true; break;
      case 'normdeep': applyPatchNow({ normalise: C.DEEP_NORM }, 'the normaliser with decoding'); state.attackStale = true; break;
      case 'dlrules': download('sieve-rules.json', 'application/json', C.exportRules(w.rules)); toast('Downloaded - made on this device.'); break;
      case 'copyrules': copy(C.exportRules(w.rules), 'Rule set copied.'); break;
      case 'dlreport': download('sieve-report-' + today() + '.md', 'text/markdown', reportText()); break;
      case 'copyreport': copy(reportText(), 'Report copied.'); break;
      case 'dljsonl': download('sieve-test-set.jsonl', 'application/x-ndjson', C.exportJsonl(w.cases)); break;
      case 'dlcsv': download('sieve-test-set.csv', 'text/csv', C.exportCsv(w.cases)); break;
      case 'clearkept': clearKept(); state.keep = false; draw(); toast('Cleared from this device.'); break;
      case 'signin': openAccount(); break;
      case 'retrysync': pushRules(); break;
      default: break;
    }
  });
  function focusLast(sel) { setTimeout(function () { var els = $$(sel); var el = els[els.length - 1]; if (el) try { el.focus(); } catch (e) { /* ignore */ } }, 30); }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) { state.conflictOpen = false; closeSheet(); }
  });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  drawTop();

  // What was kept comes back only if this device was asked to keep it.
  var kept = recall();
  if (kept && kept.v === 1) {
    state.keep = true;
    state.hint = kept.hint === true; state.zeroSeen = kept.zeroSeen === true;
    state.syncBase = typeof kept.syncBase === 'number' ? kept.syncBase : null;
    ['own', 'demo'].forEach(function (k) {
      var x = kept[k];
      if (!x) return;
      var base = k === 'demo' ? demoWs() : ownWs();
      state.W[k] = { rules: C.cleanRules(x.rules).rules, cases: Array.isArray(x.cases) && x.cases.length ? cleanList(x.cases) : base.cases, history: C.cleanHistory(x.history), seq: Number(x.seq) || base.seq, attackAdded: x.attackAdded === true };
    });
    if (kept.ws === 'own' || kept.ws === 'demo') { state.ws = kept.ws; if (!state.W[state.ws]) state.W[state.ws] = state.ws === 'demo' ? demoWs() : ownWs(); runNow(); }
  }
  route();
  loadMe().then(function () {
    if (signedIn() && state.W.own) syncIn();
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
