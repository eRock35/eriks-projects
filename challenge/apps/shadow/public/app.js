/* Shadow - the page. One file, no build step. Every string that came from
 * outside this file (a merchant name from a statement, an app name from an
 * export, a typed note, a staff request, a model's reading, a saved
 * inventory) is escaped before it is drawn, and no handler is written into
 * markup (the lab's CSP allows script from this origin only). The sums are
 * shadow-core.js, the same file the server and the tests run.
 *
 * A CARD STATEMENT OR SIGN-IN EXPORT NEVER LEAVES THIS PAGE. It is read here,
 * by ShadowCore, into tools. The only things this file ever sends: the
 * inventory (tools through C.toSaved, the fixes applied, a name) when a
 * signed-in person saves; a staff request through a request link; vendor
 * terms someone pasted to be read; decisions; sign-in forms. test/run.js
 * holds that by reading this file.
 *
 * Three ways to be here:
 *   sample - Harbor County Library, made up, the first thing a visitor sees.
 *            Every fix, the radar and the request queue work on it locally.
 *   mine   - the person's own inventory: on this device (localStorage, tools
 *            only, every access in try/catch), and in their account once
 *            saved (up to three).
 *   ask    - r/<link>: a staff member's "Can I use this?" page. No account.
 */
(function () {
  'use strict';

  var C = window.ShadowCore;
  var S = window.ShadowSample;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LOCAL = 'shadow-v1';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TODAY = (function () { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }());
  var RID = (function () {
    var p = location.pathname;
    if (p.indexOf(BASE) !== 0) return null;
    var m = /^r\/([A-Za-z0-9_-]{22})\/?$/.exec(p.slice(BASE.length));
    return m ? m[1] : null;
  }());
  var BAND_RING = { Low: '#6ee7a0', Watch: '#fcd34d', High: '#fdba74', Severe: '#fca5a5' };
  var KIND_LABEL = { company: 'Company', school: 'School or district', nonprofit: 'Nonprofit', public: 'Public agency' };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function m$(c) { return C.money(c, { whole: true }); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function emojiOf(t) { return (C.CATS[t.cat] || C.CATS.other).emoji; }

  var state = {
    me: null,
    mode: 'sample',      // 'sample' | 'mine'
    view: 'main',        // 'main' | 'import'
    org: { name: '', kind: 'company' },
    tools: [],
    done: [],
    requests: [],        // the example's queue; a saved org's comes from the server
    orgId: null,
    link: null,
    queue: null,
    orgs: [],
    filter: 'all',
    sort: 'risk',
    allFixes: false,
    history: [],
    found: { card: null, access: null, list: null, reports: [] },
    accessKind: 'google',
    review: null,
    reviewFor: '',
    saveTimer: null,
    syncedTo: null,
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // The terms route streams whitespace and so answers 200 even on
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
    setTimeout(function () { t.remove(); }, ms || 2800);
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function download(name, type, text) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
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
    where.innerHTML = '<div class="note" role="alert"><p class="err">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then come back and try again. Everything else in Shadow is free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).onclick = function () {
      var b = this; b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    };
  }

  /* ---------------- the data ---------------- */

  var sampleCache = null;
  function sampleBuild() {
    if (!sampleCache) sampleCache = S.build(TODAY);
    return JSON.parse(JSON.stringify(sampleCache));
  }
  function loadSample() {
    var b = sampleBuild();
    state.mode = 'sample';
    state.org = { name: b.org.name, kind: b.org.kind };
    state.tools = b.tools;
    state.done = [];
    state.requests = b.requests;
    state.orgId = null; state.link = null; state.queue = null;
    state.history = [];
  }
  /** The person's own inventory, from this device or an account. */
  function setMine(org, opts) {
    var o = opts || {};
    state.mode = 'mine';
    state.org = { name: C.clean(org.name, 80) || 'Our organisation', kind: KIND_LABEL[org.kind] ? org.kind : 'company' };
    state.tools = C.cleanTools(org.tools);
    state.done = Array.isArray(org.done) ? org.done.slice(0, C.LIMITS.done) : [];
    state.orgId = o.orgId || null;
    state.link = o.link || null;
    state.open = o.open || 0;
    state.queue = null;
    state.requests = [];
    state.history = [];
  }
  function persist(localOnly) {
    if (state.mode !== 'mine') return;
    keep(K_LOCAL, { v: 1, org: state.org, tools: state.tools.map(C.toSaved).filter(Boolean), done: state.done, orgId: state.orgId, syncedTo: state.orgId && signedIn() ? state.me.email : null, at: new Date().toISOString() });
    if (!localOnly && state.orgId && signedIn()) queueSave();
  }
  function savedBody() { return { name: state.org.name, kind: state.org.kind, tools: state.tools.map(C.toSaved), done: state.done }; }
  function queueSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      api('PUT', 'api/orgs/' + state.orgId, savedBody()).then(function (r) { state.link = r.link; state.open = r.open; drawStrip(); })
        .catch(function (e) { if (e.status === 404) { state.orgId = null; persist(); drawAll(); } toast(e.message + ' It is still on this device.', 4200); });
    }, 1200);
  }
  function setTools(tools, opts) {
    state.tools = C.cleanTools(tools);
    persist();
    drawMain(opts);
  }
  function findTool(id) { return state.tools.filter(function (t) { return t.id === id; })[0] || null; }
  function patchTool(id, patch) {
    setTools(state.tools.map(function (t) { return t.id === id ? Object.assign({}, t, patch) : t; }));
  }

  /* ---------------- drawing ---------------- */

  function drawAll() {
    drawStrip();
    var imp = state.view === 'import';
    $('#strip').hidden = imp;
    $('#importView').hidden = !imp;
    $('#mainView').hidden = imp;
    if (imp) { drawImport(); return; }
    drawMain();
  }
  function drawMain(opts) {
    drawHero(opts && opts.from);
    drawFixes();
    drawRadar();
    drawRequests();
    drawInventory();
    drawTermsTools();
  }

  function drawStrip() {
    var el = $('#strip');
    el.className = 'strip';
    if (state.mode === 'sample') {
      el.innerHTML = '<p class="eyebrow">Example · ' + esc(S.ORG.blurb) + '</p><h1>' + esc(S.ORG.name) + '</h1>' +
        '<p>This is an example library system - try the fixes, then check your own.</p>' +
        '<div class="strip-actions"><button class="btn big" type="button" id="findBtn">🔦 Find our tools</button></div>' +
        '<p class="quiet">Your card statement and sign-in export are read on this device. Nothing is uploaded.</p>';
    } else {
      var where = state.orgId && signedIn() ? 'Saved to your account' : 'On this device only';
      el.innerHTML = '<p class="eyebrow">Your inventory · ' + esc(where) + '</p><h1>' + esc(state.org.name) + '</h1>' +
        '<div class="strip-actions">' +
        '<button class="btn" type="button" id="findBtn">🔦 Find more tools</button>' +
        (!state.orgId ? '<button class="btn ghost" type="button" id="saveBtn">Save to my account (free)</button>' : '') +
        '<button class="btn ghost" type="button" id="orgMenu">Rename or start over</button>' +
        '</div>' +
        (!state.orgId ? '<p class="quiet">Saving keeps the inventory - never the files - and gives you a request link for staff.</p>' : '');
      var sb = $('#saveBtn', el);
      if (sb) sb.onclick = saveToAccount;
      $('#orgMenu', el).onclick = openOrgMenu;
    }
    $('#findBtn', el).onclick = function () { state.view = 'import'; drawAll(); window.scrollTo(0, 0); };
    var ob = $('#orgBtn');
    ob.hidden = !(signedIn() && state.orgs.length);
    ob.textContent = state.orgs.length > 1 ? 'Inventories (' + state.orgs.length + ')' : 'My inventory';
    ob.onclick = openOrgs;
  }

  function ringSvg(score, band) {
    var r = 46, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
    return '<svg viewBox="0 0 112 112" aria-hidden="true"><circle class="track" cx="56" cy="56" r="' + r + '" fill="none" stroke-width="12"></circle>' +
      '<circle class="arc" cx="56" cy="56" r="' + r + '" fill="none" stroke="' + BAND_RING[band] + '" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"></circle></svg>';
  }
  function headlineHtml(h) {
    if (!h.tools) return 'No tools yet. <b>Find your tools</b> from a card statement, a sign-in export or a list.';
    var parts = ['<b>' + plural(h.tools, 'tool') + '</b>'];
    var rest = [];
    rest.push('<b>' + h.unapproved + ' nobody approved</b>');
    rest.push('<b>' + h.custNoContract + ' holding customer data with no contract</b>');
    var tail = '<b>' + m$(h.noOwnerSpendCents) + ' a year</b> on tools without an owner.';
    return parts[0] + ' - ' + rest.join(', ') + ', ' + tail;
  }
  function drawHero(from) {
    var sc = C.scoreAll(state.tools), h = C.headline(state.tools);
    var el = $('#hero');
    el.innerHTML = '<div class="hero-top"><div class="ring" role="img" aria-label="Shadow score ' + sc.score + ' out of 100, ' + sc.band + '">' + ringSvg(from !== undefined ? from : sc.score, sc.band) +
      '<div class="num"><b id="scoreNum">' + (from !== undefined ? from : sc.score) + '</b><span>' + esc(sc.band) + '</span></div></div>' +
      '<p class="headline">' + headlineHtml(h) + '</p></div>' +
      (h.tools ? '<p class="hero-meta">Out of 100, higher is riskier · ' + m$(h.spendCents) + ' a year in all' + (h.studentsNoDpa ? ' · ' + plural(h.studentsNoDpa, 'tool holds', 'tools hold') + ' student records with no DPA' : '') + ' · <a href="#howH" id="howLink" style="color:#ffffff">How we worked this out</a></p>' : '');
    var hl = $('#howLink', el);
    if (hl) hl.onclick = function (e) { e.preventDefault(); var d = $('#howCard details'); if (d) d.open = true; $('#howCard').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' }); };
    if (from !== undefined && from !== sc.score) countTo(from, sc.score, sc.band);
  }
  function countTo(from, to, band) {
    var arc = $('#hero .arc'), num = $('#scoreNum');
    var r = 46, c = 2 * Math.PI * r;
    if (REDUCED) { num.textContent = to; arc.setAttribute('stroke-dashoffset', (c * (1 - to / 100)).toFixed(1)); return; }
    requestAnimationFrame(function () { arc.setAttribute('stroke-dashoffset', (c * (1 - to / 100)).toFixed(1)); });
    var start = null;
    function stepAnim(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / 600);
      num.textContent = Math.round(from + (to - from) * p);
      if (p < 1) requestAnimationFrame(stepAnim);
    }
    requestAnimationFrame(stepAnim);
  }

  /* ---------------- the fix list ---------------- */

  function drawFixes() {
    var el = $('#fixCard');
    var all = C.topFixes(C.fixes(state.tools));
    var shown = state.allFixes ? all : all.slice(0, 3);
    var html = '<div class="head"><h2 id="fixH">Fix these first</h2>' + (state.history.length ? '<button class="btn small ghost" type="button" id="undoFix">Undo</button>' : '') + '</div>';
    if (!state.tools.length) html += '<p class="muted">Find your tools first - the fixes that lower your score most will show here.</p>';
    else if (!all.length) html += '<p class="muted">Nothing left that moves the score by a tenth of a point. Keep the inventory current: check the card and sign-ins each quarter.</p>';
    else html += '<p class="small muted">Ranked by how much each lowers your Shadow score. Apply marks it done.</p>';
    shown.forEach(function (f) {
      html += '<div class="fix"><div class="t">' + esc(f.text) + '</div><div class="acts"><span class="delta" aria-label="lowers the score by ' + f.delta + ' points">−' + f.delta + '</span>' +
        '<button class="btn small" type="button" data-fix="' + esc(f.id) + '">Apply</button></div><p class="why">' + esc(f.why) + '</p></div>';
    });
    if (all.length > 3) html += '<button class="link-btn" type="button" id="moreFix">' + (state.allFixes ? 'Show the top three' : 'Show ' + (all.length - 3) + ' more') + '</button>';
    if (state.done.length) {
      html += '<details><summary>Done (' + state.done.length + ')</summary><ul class="done-list">' + state.done.slice(0, 30).map(function (d) { return '<li>' + esc(d.text) + '</li>'; }).join('') + '</ul></details>';
    }
    el.innerHTML = html;
    $$('[data-fix]', el).forEach(function (b) {
      b.onclick = function () {
        var f = all.filter(function (x) { return x.id === b.getAttribute('data-fix'); })[0];
        if (!f) return;
        if (f.kind === 'owner') return askOwner(f);
        applyFixNow(f);
      };
    });
    var more = $('#moreFix', el);
    if (more) more.onclick = function () { state.allFixes = !state.allFixes; drawFixes(); };
    var undo = $('#undoFix', el);
    if (undo) undo.onclick = function () {
      var prev = state.history.pop();
      if (!prev) return;
      var from = C.scoreAll(state.tools).score;
      state.done = prev.done;
      setTools(prev.tools, { from: from });
      toast('Undone.');
    };
  }
  function applyFixNow(f, opts) {
    var from = C.scoreAll(state.tools).score;
    state.history.push({ tools: state.tools, done: state.done.slice() });
    if (state.history.length > 30) state.history.shift();
    var text = f.kind === 'owner' && opts && opts.owner ? 'Named ' + C.clean(opts.owner, 60) + ' owner of ' + f.toolName : f.text.replace(/ - .*$/, '');
    state.done = [{ id: f.id, text: text, at: TODAY }].concat(state.done.filter(function (d) { return d.id !== f.id; })).slice(0, C.LIMITS.done);
    var next = C.applyFix(state.tools, f, opts);
    setTools(next, { from: from });
    var to = C.scoreAll(state.tools).score;
    toast('Done. ' + from + ' → ' + to + (state.mode === 'sample' ? ' (example only)' : ''));
  }
  function askOwner(f) {
    sheet('<h2>Who owns ' + esc(f.toolName) + '?</h2><p class="muted">The person who decides on renewals, offboarding and what goes in it.</p>' +
      '<form id="ownForm"><label class="field"><span>Name (and team)</span><input class="input" name="owner" maxlength="60" required placeholder="e.g. Dana Ruiz (IT)"></label>' +
      '<button class="btn block" type="submit">Name them owner</button></form>', function (root) {
      $('#ownForm', root).onsubmit = function (e) {
        e.preventDefault();
        var v = C.clean(e.target.owner.value, 60);
        if (!v) return;
        closeSheet();
        applyFixNow(f, { owner: v });
      };
    });
  }

  /* ---------------- the radar ---------------- */

  function drawRadar() {
    var el = $('#radarCard');
    var items = C.radar(state.tools, TODAY);
    var html = '<div class="head"><h2 id="radarH">Trials &amp; renewals</h2>' + (items.some(function (i) { return i.days >= 0; }) ? '<button class="btn small ghost" type="button" id="icsBtn">Add to calendar</button>' : '') + '</div>';
    if (!items.length) html += '<p class="muted">Nothing converts, renews or ends in the next 60 days' + (state.tools.length ? '.' : ' - yet.') + '</p>';
    else html += '<p class="small muted">The next 60 days.</p>';
    items.slice(0, 8).forEach(function (it) {
      var soon = it.days <= 7;
      html += '<div class="rad"><div class="when' + (soon ? ' soon' : '') + '"><b>' + (it.days < 0 ? '!' : it.days) + '</b><span>' + (it.days < 0 ? 'past' : it.days === 1 ? 'day' : 'days') + '</span></div>' +
        '<div><p class="t">' + esc(it.kind === 'trial' ? it.toolName + ': ' + it.title : it.title) + '</p><p>' + esc(it.detail) + '</p></div></div>';
    });
    if (items.length > 8) html += '<p class="small muted">And ' + (items.length - 8) + ' more.</p>';
    el.innerHTML = html;
    var b = $('#icsBtn', el);
    if (b) b.onclick = function () {
      download('shadow-trials-and-renewals.ics', 'text/calendar;charset=utf-8', C.ics({ tools: state.tools, today: TODAY }));
      toast('Calendar file ready - open it to add the reminders.');
    };
  }

  /* ---------------- "Can I use this?" requests ---------------- */

  function linkUrl() { return state.link ? location.origin + BASE + 'r/' + state.link.rid : ''; }
  function reqHtml(r, owner) {
    var data = (r.data || []).map(function (d) { return '<span class="chip c-plain">' + esc(C.DATA_LABEL[d]) + '</span>'; }).join(' ');
    var trial = { yes: 'Trial already running', no: 'No trial yet', unsure: 'Not sure about a trial' }[r.trial] || '';
    var html = '<div class="req"><div class="row spread"><span class="t">' + esc(r.tool) + '</span>' +
      (r.status === 'open' ? '<span class="chip w-warn">Waiting</span>' : r.status === 'approved' ? '<span class="chip w-ok">Approved</span>' : '<span class="chip w-bad">Declined</span>') + '</div>' +
      '<p class="meta">' + (owner ? 'From ' + esc(r.name) + ' · ' : '') + esc(trial) + (r.users ? ' · ' + plural(r.users, 'person', 'people') : '') + (r.at ? ' · ' + esc(C.fmtDate(String(r.at).slice(0, 10))) : '') + '</p>' +
      (r.why ? '<p class="why">“' + esc(r.why) + '”</p>' : '') + (data ? '<div class="row">' + data + '</div>' : '') +
      (r.conditions ? '<p class="small"><b>Conditions:</b> ' + esc(r.conditions) + '</p>' : '');
    if (owner && r.status === 'open') {
      html += '<label class="field" style="margin-top:10px"><span>Conditions (optional)</span><textarea class="input" maxlength="400" data-cond="' + esc(r.id) + '" placeholder="e.g. Business plan with SSO; no patron data until the DPA is signed"></textarea></label>' +
        '<div class="row"><button class="btn small" type="button" data-decide="approve" data-q="' + esc(r.id) + '">Approve</button><button class="btn small ghost" type="button" data-decide="decline" data-q="' + esc(r.id) + '">Decline</button></div>';
    }
    return html + '</div>';
  }
  function drawRequests() {
    var el = $('#reqCard');
    var html = '<div class="head"><h2 id="reqH">“Can I use this?” requests</h2></div>';
    var list = [];
    if (state.mode === 'sample') {
      html += '<p class="small muted">Staff ask before they sign up: no account needed, just your link. You approve with conditions or decline, and the inventory updates itself.</p>' +
        '<div class="linkbox"><code>…/shadow/r/your-own-link</code><button class="btn small ghost" type="button" id="previewAsk">See what staff see</button></div>';
      list = state.requests;
    } else if (!state.orgId) {
      html += '<p class="muted">Save your inventory to a free account and you get a link staff can use to ask before they sign up for anything - no account needed for them.</p><button class="btn small" type="button" id="saveForLink">Save and get our link</button>';
    } else if (state.link) {
      html += '<p class="small muted">Share this with staff (an intranet page, the onboarding checklist, the IT channel). Anyone with it can ask; only you see the queue.</p>' +
        '<div class="linkbox"><code>' + esc(linkUrl()) + '</code><button class="btn small ghost" type="button" id="copyLink">Copy</button></div>' +
        '<div class="row"><a class="btn small ghost" href="' + esc(BASE + 'r/' + state.link.rid) + '" target="_blank" rel="noopener">Open as staff</a>' +
        '<button class="btn small ghost" type="button" id="pauseLink">' + (state.link.accepting ? 'Pause the link' : 'Reopen the link') + '</button></div>' +
        (state.link.accepting ? '' : '<p class="small err">Paused: the link says so and takes no new requests.</p>');
      list = state.queue || [];
      if (state.queue === null) { html += '<p class="small muted">Loading the queue…</p>'; loadQueue(); }
    }
    var open = list.filter(function (r) { return r.status === 'open'; });
    var decided = list.filter(function (r) { return r.status !== 'open' && r.status !== 'withdrawn'; }).slice(0, 5);
    if (state.mode === 'sample' || state.orgId) {
      html += '<h3 style="margin-top:12px">' + (open.length ? plural(open.length, 'request') + ' waiting' : 'Nothing waiting') + '</h3>';
      html += open.map(function (r) { return reqHtml(r, true); }).join('');
      if (decided.length) html += '<details><summary>Decided (' + decided.length + ')</summary>' + decided.map(function (r) { return reqHtml(r, true); }).join('') + '</details>';
    }
    el.innerHTML = html;
    var pv = $('#previewAsk', el);
    if (pv) pv.onclick = previewAsk;
    var sl = $('#saveForLink', el);
    if (sl) sl.onclick = saveToAccount;
    var cp = $('#copyLink', el);
    if (cp) cp.onclick = function () {
      var url = linkUrl();
      if (navigator.share && /iPhone|iPad|Android/.test(navigator.userAgent)) { navigator.share({ title: 'Ask before you sign up', url: url }).catch(function () { /* cancelled */ }); return; }
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { toast('Link copied.'); }, function () { toast(url, 6000); });
    };
    var pl = $('#pauseLink', el);
    if (pl) pl.onclick = function () {
      api('PATCH', 'api/orgs/' + state.orgId + '/link', { accepting: !state.link.accepting }).then(function (r) { state.link = r.link; drawRequests(); }).catch(function (e) { showError(e); });
    };
    $$('[data-decide]', el).forEach(function (b) {
      b.onclick = function () {
        var qid = b.getAttribute('data-q'), decision = b.getAttribute('data-decide');
        var cond = $('[data-cond="' + qid + '"]', el);
        decide(qid, decision, cond ? cond.value : '', b);
      };
    });
  }
  function loadQueue() {
    if (!state.orgId) return;
    api('GET', 'api/orgs/' + state.orgId + '/requests').then(function (r) { state.queue = r.requests; drawRequests(); })
      .catch(function () { state.queue = []; drawRequests(); });
  }
  function decide(qid, decision, conditions, btn) {
    var cond = C.clean(conditions, C.LIMITS.conditions);
    if (state.mode === 'sample') {
      var req = state.requests.filter(function (r) { return r.id === qid; })[0];
      if (!req) return;
      var from = C.scoreAll(state.tools).score;
      var fold = C.applyDecision(state.tools, req, decision, cond, TODAY);
      req.status = decision === 'approve' ? 'approved' : 'declined';
      req.conditions = cond;
      setTools(fold.tools, { from: from });
      toast(decision === 'approve' ? req.tool + ' is in the inventory as Approved.' : 'Declined' + (fold.added ? ' - its trial is on the radar.' : '.'));
      return;
    }
    if (btn) btn.disabled = true;
    api('POST', 'api/orgs/' + state.orgId + '/requests/' + qid, { decision: decision, conditions: cond }).then(function (r) {
      var from = C.scoreAll(state.tools).score;
      state.queue = null;
      state.tools = C.cleanTools(r.org.tools);
      persist(true);
      drawMain({ from: from });
      toast(decision === 'approve' ? r.request.tool + ' is in the inventory as Approved.' : 'Declined.');
    }).catch(function (e) { if (btn) btn.disabled = false; showError(e); });
  }

  /* ---------------- the inventory ---------------- */

  var FILTERS = [
    ['all', 'All'], ['unapproved', 'Not approved'], ['personal', 'Personal data'], ['noowner', 'No owner'], ['radar', 'Trials & renewals'], ['check', 'Check these'],
  ];
  function flagsOf(t) {
    var f = [];
    if (C.personal(t) && !t.dpa) f.push('No DPA');
    if (t.contract === 'none' && (C.personal(t) || t.spendCents >= 100000)) f.push('No contract');
    if (!t.sso && (t.users || 0) >= 2) f.push('No SSO');
    if (!t.owner) f.push('No owner');
    var w = C.riskWords(t.scopes)[0];
    if (w && C.RISKS[t.scopes[0]].w >= 0.7) f.push('Can ' + w);
    return f;
  }
  function drawInventory() {
    var el = $('#invCard');
    var sc = C.scoreAll(state.tools);
    var radarIds = {};
    C.radar(state.tools, TODAY).forEach(function (r) { radarIds[r.id] = 1; });
    var list = state.tools.filter(function (t) {
      switch (state.filter) {
        case 'unapproved': return t.status === 'unapproved';
        case 'personal': return C.personal(t);
        case 'noowner': return !t.owner;
        case 'radar': return Boolean(radarIds[t.id]) || Boolean(t.trial && !t.trial.converted);
        case 'check': return t.probable;
        default: return true;
      }
    });
    var by = {
      risk: function (a, b) { return sc.tools[b.id].raw - sc.tools[a.id].raw; },
      spend: function (a, b) { return b.spendCents - a.spendCents; },
      users: function (a, b) { return (b.users || 0) - (a.users || 0); },
      name: function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; },
    }[state.sort];
    list.sort(function (a, b) { return by(a, b) || (a.name < b.name ? -1 : 1); });
    var html = '<div class="head"><h2 id="invH">The inventory <span class="small muted">(' + state.tools.length + ')</span></h2>' +
      '<label class="vh" for="sortSel">Sort</label><select class="input" id="sortSel" style="width:auto">' +
      [['risk', 'Riskiest first'], ['spend', 'Most spend'], ['users', 'Most users'], ['name', 'A–Z']].map(function (o) { return '<option value="' + o[0] + '"' + (state.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="filters" role="group" aria-label="Show">' + FILTERS.map(function (f) { return '<button type="button" data-filter="' + f[0] + '" aria-pressed="' + (state.filter === f[0]) + '">' + esc(f[1]) + '</button>'; }).join('') + '</div>';
    if (!list.length) html += '<p class="muted" style="padding:10px 0">' + (state.tools.length ? 'Nothing here with that filter.' : 'No tools yet.') + '</p>';
    list.forEach(function (t) {
      var r = sc.tools[t.id];
      var flags = flagsOf(t);
      html += '<button class="tool" type="button" data-tool="' + esc(t.id) + '"><span class="em" aria-hidden="true">' + emojiOf(t) + '</span>' +
        '<span><span class="nm">' + esc(t.name) + '</span></span>' +
        '<span class="rt"><span class="chip b-' + r.band + '">' + r.score + ' ' + r.band + '</span><small>' + (t.spendCents ? m$(t.spendCents) + '/yr' : (t.trial && !t.trial.converted ? 'trial' : 'no card spend')) + '</small></span>' +
        '<span class="sub"><span class="chip s-' + t.status + '">' + esc(C.STATUS_LABEL[t.status]) + '</span> ' +
        (t.probable ? '<span class="probable">Probably software - check</span> · ' : '') +
        esc((C.CATS[t.cat] || C.CATS.other).label) + (t.users ? ' · ' + plural(t.users, 'user') : '') +
        (flags.length ? '<br><span class="flagline">' + esc(flags.join(' · ')) + '</span>' : '') + '</span></button>';
    });
    html += '<div class="inv-tools"><button class="btn small" type="button" id="addTool">Add a tool</button><button class="btn small ghost" type="button" id="csvBtn"' + (state.tools.length ? '' : ' disabled') + '>Export CSV</button></div>';
    el.innerHTML = html;
    $('#sortSel', el).onchange = function () { state.sort = this.value; drawInventory(); };
    $$('[data-filter]', el).forEach(function (b) { b.onclick = function () { state.filter = b.getAttribute('data-filter'); drawInventory(); }; });
    $$('[data-tool]', el).forEach(function (b) { b.onclick = function () { openTool(b.getAttribute('data-tool')); }; });
    $('#addTool', el).onclick = addToolSheet;
    $('#csvBtn', el).onclick = function () {
      download((state.org.name || 'inventory').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() + '-software.csv', 'text/csv;charset=utf-8', C.toCsv(state.tools));
    };
  }

  function seg(name, opts, value) {
    return '<div class="seg' + (opts.length === 3 ? ' three' : '') + '" role="group" data-seg="' + name + '">' + opts.map(function (o) { return '<button type="button" data-v="' + o[0] + '" aria-pressed="' + (value === o[0]) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>';
  }
  function factorRows(t) {
    var r = C.toolRisk(t), f = r.factors;
    var rows = [
      ['Status: ' + C.STATUS_LABEL[t.status], '×' + f.status.toFixed(2)],
      ['Data it touches', '×' + f.data.toFixed(2)],
      ['Access granted', '×' + f.access.toFixed(2)],
      ['Users', '×' + f.users.toFixed(2)],
      ['Spend', '×' + f.spend.toFixed(2)],
      ['Contract', '×' + f.contract.toFixed(2)],
      ['DPA', '×' + f.dpa.toFixed(2)],
      ['SSO', '×' + f.sso.toFixed(2)],
      ['Owner', '×' + f.owner.toFixed(2)],
    ];
    return '<table class="factors"><tbody>' + rows.map(function (x) { return '<tr><td>' + esc(x[0]) + '</td><td>' + x[1] + '</td></tr>'; }).join('') +
      '<tr><td>40 × all of that = ' + r.raw.toFixed(0) + ' → 100 × (1 − e<sup>−' + r.raw.toFixed(0) + '/100</sup>)</td><td><span class="chip b-' + r.band + '">' + r.score + ' ' + r.band + '</span></td></tr></tbody></table>';
  }
  function openTool(id) {
    var t = findTool(id);
    if (!t) return;
    var words = C.riskWords(t.scopes);
    sheet('<h2>' + emojiOf(t) + ' ' + esc(t.name) + '</h2>' +
      (t.probable ? '<div class="note"><p class="probable" style="margin:0 0 6px">Probably software - check</p><p class="small muted" style="margin:0 0 8px">Found on the card by its name and billing pattern, not in our table of known tools.</p><button class="btn small ghost" type="button" id="confirmSw">Yes, it’s software</button></div>' : '') +
      '<div id="toolScore"></div>' +
      '<p class="field"><span style="display:block;font-weight:700;font-size:.88rem;margin-bottom:4px">Status</span>' + seg('status', [['approved', 'Approved'], ['review', 'Under review'], ['unapproved', 'Not approved'], ['retiring', 'Retiring']], t.status) + '</p>' +
      '<label class="field"><span>Owner</span><input class="input" data-f="owner" maxlength="60" value="' + esc(t.owner) + '" placeholder="Who decides on it"></label>' +
      '<p class="field"><span style="display:block;font-weight:700;font-size:.88rem;margin-bottom:4px">Contract</span>' + seg('contract', [['none', 'None'], ['clickthrough', 'Click-through'], ['signed', 'Signed']], t.contract) + '</p>' +
      '<div class="two"><label class="field"><span>Contract ends</span><input class="input" type="date" data-f="contractEnd" value="' + esc(t.contractEnd || '') + '"></label>' +
      '<label class="field"><span>Renews</span><input class="input" type="date" data-f="renewal" value="' + esc(t.renewal || '') + '"></label></div>' +
      '<div class="field"><span style="display:block;font-weight:700;font-size:.88rem;margin-bottom:4px">Data it touches</span><div class="checks">' +
      C.DATA.map(function (d) { return '<label><input type="checkbox" data-data="' + d + '"' + (t.data.indexOf(d) >= 0 ? ' checked' : '') + '>' + esc(C.DATA_LABEL[d]) + '</label>'; }).join('') + '</div></div>' +
      '<label class="toggle"><span>Data-processing agreement (DPA) signed</span><input type="checkbox" data-b="dpa"' + (t.dpa ? ' checked' : '') + '></label>' +
      '<label class="toggle"><span>Signs in through SSO</span><input type="checkbox" data-b="sso"' + (t.sso ? ' checked' : '') + '></label>' +
      '<div class="two" style="margin-top:10px"><label class="field"><span>Spend a year ($)</span><input class="input" inputmode="decimal" data-f="spend" value="' + esc(t.spendCents ? C.plain(t.spendCents) : '') + '"></label>' +
      '<label class="field"><span>Users</span><input class="input" inputmode="numeric" data-f="users" value="' + esc(t.users === null ? '' : t.users) + '"></label></div>' +
      '<label class="field"><span>Category</span><select class="input" data-f="cat">' + C.CAT_IDS.map(function (c) { return '<option value="' + c + '"' + (t.cat === c ? ' selected' : '') + '>' + esc(C.CATS[c].emoji + ' ' + C.CATS[c].label) + '</option>'; }).join('') + '</select></label>' +
      (words.length ? '<div class="note"><b>Access people granted it</b><ul class="scopes">' + words.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul><p class="small muted" style="margin:0">From the sign-in export. Revoke in your admin console, then mark it here.</p>' +
        '<button class="btn small ghost" type="button" id="cutScopes">I cut the broad access</button></div>' : '') +
      (t.trial ? '<p class="small"><b>Trial:</b> started ' + esc(C.fmtDate(t.trial.start)) + (t.trial.converted ? ', converted ' + esc(C.fmtDate(t.trial.converts)) : ', converts ' + (t.trial.estimated ? 'about ' : '') + esc(C.fmtDate(t.trial.converts))) + '.</p>' : '') +
      '<label class="field"><span>Notes</span><textarea class="input" data-f="notes" maxlength="600">' + esc(t.notes) + '</textarea></label>' +
      '<p class="small muted">Found in: ' + esc(t.sources.map(function (s) { return C.SOURCE_LABEL[s]; }).join(', ') || 'added here') + '</p>' +
      '<div class="row"><button class="btn small ghost" type="button" id="readTerms">Read their terms (AI)</button><button class="btn small danger" type="button" id="delTool">Remove from inventory</button></div>',
      function (root) {
        function cur() { return findTool(id); }
        function refresh() {
          var x = cur();
          if (!x) return;
          var r = C.toolRisk(x), box = $('#toolScore', root), open = box.querySelector('details') && box.querySelector('details').open;
          box.innerHTML = '<details' + (open ? ' open' : '') + '><summary><span class="chip b-' + r.band + '">' + r.score + ' ' + r.band + '</span>&nbsp; How this tool scores</summary>' + factorRows(x) + '</details>';
        }
        refresh();
        function set(patch) { patchTool(id, patch); refresh(); }
        $$('[data-seg]', root).forEach(function (g) {
          $$('button', g).forEach(function (b) {
            b.onclick = function () {
              $$('button', g).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
              var p = {}; p[g.getAttribute('data-seg')] = b.getAttribute('data-v'); set(p);
            };
          });
        });
        $$('[data-f]', root).forEach(function (inp) {
          inp.onchange = function () {
            var f = inp.getAttribute('data-f'), v = inp.value;
            if (f === 'spend') { var c = v.trim() === '' ? 0 : C.toCents(v); if (c === null) { toast('Type what it costs a year as a number, like 1200.'); return; } set({ spendCents: c }); return; }
            if (f === 'users') { set({ users: v.trim() === '' ? null : C.int(v) }); return; }
            var p = {}; p[f] = f === 'contractEnd' || f === 'renewal' ? (C.isoDay(v) ? v : null) : v; set(p);
          };
        });
        $$('[data-data]', root).forEach(function (cb) {
          cb.onchange = function () {
            var d = $$('[data-data]', root).filter(function (x) { return x.checked; }).map(function (x) { return x.getAttribute('data-data'); });
            if (cb.checked && cb.getAttribute('data-data') === 'none') { d = ['none']; $$('[data-data]', root).forEach(function (x) { x.checked = x === cb; }); }
            else if (cb.checked) { d = d.filter(function (x) { return x !== 'none'; }); var n = $('[data-data="none"]', root); if (n) n.checked = false; }
            set({ data: d });
          };
        });
        $$('[data-b]', root).forEach(function (cb) { cb.onchange = function () { var p = {}; p[cb.getAttribute('data-b')] = cb.checked; set(p); }; });
        var cs = $('#cutScopes', root);
        if (cs) cs.onclick = function () { var x = cur(); set({ scopes: x.scopes.filter(function (r) { return C.RISKS[r].w < 0.7; }) }); cs.disabled = true; cs.textContent = 'Marked as cut'; };
        var cf = $('#confirmSw', root);
        if (cf) cf.onclick = function () { set({ probable: false }); cf.closest('.note').remove(); };
        $('#readTerms', root).onclick = function () { closeSheet(); state.reviewFor = id; var v = $('#termsVendor'); if (v) v.value = cur().name; var c = $('#termsCard'); c.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' }); setTimeout(function () { var ta = $('#termsText'); if (ta) ta.focus(); }, 400); };
        $('#delTool', root).onclick = function () {
          if (!confirm('Remove ' + cur().name + ' from the inventory?')) return;
          closeSheet();
          setTools(state.tools.filter(function (x) { return x.id !== id; }));
          toast('Removed.');
        };
      }, { focusClose: true });
  }
  function addToolSheet() {
    sheet('<h2>Add a tool</h2><form id="handForm">' +
      '<label class="field"><span>Name</span><input class="input" name="name" maxlength="60" required placeholder="e.g. Notion"></label>' +
      '<div class="two"><label class="field"><span>Spend a year ($)</span><input class="input" name="spend" inputmode="decimal" placeholder="0"></label>' +
      '<label class="field"><span>Users</span><input class="input" name="users" inputmode="numeric"></label></div>' +
      '<label class="field"><span>Owner</span><input class="input" name="owner" maxlength="60"></label>' +
      '<div id="handErr"></div><button class="btn block" type="submit">Add it</button></form>', function (root) {
      $('#handForm', root).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target;
        var r = C.handTool({ name: f.name.value, spend: f.spend.value, users: f.users.value, owner: f.owner.value }, TODAY);
        if (r.error) { $('#handErr', root).innerHTML = '<p class="err">' + esc(r.error) + '</p>'; return; }
        startMineIfSample();
        var m = C.mergeInto(state.tools, [r.tool]);
        closeSheet();
        setTools(m.tools);
        toast(m.added.length ? r.tool.name + ' added as Not approved - tap it to fill in the rest.' : 'Already on the list - updated.');
      };
    });
  }
  /** Adding anything to the example starts the person's own inventory. */
  function startMineIfSample(name) {
    if (state.mode !== 'sample') return;
    setMine({ name: name || 'Our organisation', kind: 'company', tools: [], done: [] });
  }

  /* ---------------- find the tools (read on this device, nothing uploaded) ---------------- */

  function readFiles(list, kind) {
    var files = Array.prototype.slice.call(list || []).slice(0, C.LIMITS.files);
    var total = files.reduce(function (n, f) { return n + f.size; }, 0);
    if (total > C.LIMITS.bytes) { importNote(kind, 'Those files add up to more than 5 MB. Download a shorter date range.'); return; }
    Promise.all(files.map(function (f) {
      return new Promise(function (resolve) {
        var r = new FileReader();
        r.onload = function () { resolve({ name: f.name, text: String(r.result || '') }); };
        r.onerror = function () { resolve({ name: f.name, text: '' }); };
        r.readAsText(f);
      });
    })).then(function (texts) { readTexts(texts, kind); });
  }
  function readTexts(texts, kind) {
    if (kind === 'card') {
      var p = C.parseStatements(texts);
      if (p.error) { importNote('card', p.error); return; }
      var found = C.findSoftware(p.transactions, { today: TODAY });
      state.found.card = found.tools;
      var sk = p.skipped;
      importNote('card', 'Read ' + plural(found.considered, 'charge') + (p.range ? ' from ' + C.fmtDate(p.range.from, TODAY.slice(0, 4)) + ' to ' + C.fmtDate(p.range.to, TODAY.slice(0, 4)) : '') + ': ' + plural(found.tools.length, 'software tool') +
        (found.tools.filter(function (t) { return t.trial && !t.trial.converted; }).length ? ', ' + plural(found.tools.filter(function (t) { return t.trial && !t.trial.converted; }).length, 'trial') : '') +
        '. Not software: ' + found.notSoftware + '. Skipped ' + (sk.payments + sk.refunds + sk.transfers + sk.interest + sk.moneyIn) + ' payments, refunds and transfers' + (sk.unreadable ? ' and ' + sk.unreadable + ' unreadable rows' : '') + '.', true);
    } else {
      var apps = [], builtin = 0, err = null, rows = 0;
      texts.forEach(function (t) {
        var a = C.parseAccess(t.text);
        if (a.error) { err = a.error; return; }
        apps = apps.concat(a.apps); builtin += a.builtin; rows += a.rows;
      });
      if (!apps.length) { importNote('access', err || 'No third-party apps were found in that export.'); return; }
      state.found.access = C.mergeSources([apps]);
      importNote('access', 'Read ' + plural(rows, 'row') + ': ' + plural(state.found.access.length, 'third-party app') + (builtin ? '. Left out ' + builtin + ' of Google’s and Microsoft’s own' : '') + '.', true);
    }
    drawFound();
  }
  function importNote(kind, msg, ok) {
    var el = $('#note-' + kind);
    if (el) el.innerHTML = '<p class="' + (ok ? 'small' : 'err') + '" role="status">' + esc(msg) + '</p>';
  }
  function foundTools() {
    return C.mergeSources([state.found.card || [], state.found.access || [], state.found.list || []]);
  }
  function drawFound() {
    var el = $('#found');
    if (!el) return;
    var tools = foundTools();
    if (!tools.length) { el.innerHTML = ''; return; }
    var have = {};
    if (state.mode === 'mine') state.tools.forEach(function (t) { have[t.key] = 1; });
    el.innerHTML = '<div class="card"><h2>Found ' + plural(tools.length, 'tool') + '</h2><p class="small muted">Untick anything that isn’t software you pay for or sign in to. Nothing has left this device.</p>' +
      tools.map(function (t) {
        return '<label class="pick"><input type="checkbox" data-pick="' + esc(t.key) + '" checked><span><b>' + esc(t.name) + '</b><br><span class="small muted">' + esc((C.CATS[t.cat] || C.CATS.other).label) +
          (t.users ? ' · ' + plural(t.users, 'user') : '') + (t.trial && !t.trial.converted ? ' · trial' : '') + (have[t.key] ? ' · already listed - will update' : '') + '</span>' +
          (t.probable ? '<br><span class="probable">Probably software - check</span>' : '') + '</span><span class="small">' + (t.spendCents ? esc(m$(t.spendCents)) + '/yr' : '') + '</span></label>';
      }).join('') +
      (state.mode === 'sample' ? '<label class="field" style="margin-top:12px"><span>Your organisation’s name</span><input class="input" id="orgName" maxlength="80" placeholder="e.g. Maple Street School"></label>' +
        '<div class="field"><span style="display:block;font-weight:700;font-size:.88rem;margin-bottom:4px">What kind</span>' + seg('kind', [['company', 'Company'], ['school', 'School'], ['nonprofit', 'Nonprofit'], ['public', 'Public agency']], 'company') + '</div>' : '') +
      '<button class="btn block big" type="button" id="addFound">Add to ' + (state.mode === 'sample' ? 'our new inventory' : esc(state.org.name)) + '</button></div>';
    var kind = 'company';
    $$('[data-seg="kind"] button', el).forEach(function (b) { b.onclick = function () { kind = b.getAttribute('data-v'); $$('[data-seg="kind"] button', el).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }; });
    $('#addFound', el).onclick = function () {
      var picked = {};
      $$('[data-pick]', el).forEach(function (cb) { if (cb.checked) picked[cb.getAttribute('data-pick')] = 1; });
      var chosen = tools.filter(function (t) { return picked[t.key]; });
      if (!chosen.length) { toast('Tick at least one tool.'); return; }
      var name = $('#orgName', el) ? C.clean($('#orgName', el).value, 80) : '';
      if (state.mode === 'sample') { setMine({ name: name || 'Our organisation', kind: kind, tools: [], done: [] }); }
      var m = C.mergeInto(state.tools, chosen);
      state.found = { card: null, access: null, list: null, reports: [] };
      state.view = 'main';
      state.tools = m.tools;
      persist();
      drawAll();
      window.scrollTo(0, 0);
      toast('Added ' + plural(m.added.length, 'tool') + (m.updated.length ? ', updated ' + m.updated.length : '') + '.');
    };
  }
  function dropZone(kind, label) {
    return '<label class="drop" data-drop="' + kind + '"><span aria-hidden="true">📄</span><b>' + esc(label) + '</b><span class="small muted">CSV, up to 6 files</span>' +
      '<input class="vh" type="file" accept=".csv,text/csv,.txt,text/plain" multiple data-file="' + kind + '"></label>';
  }
  var ACCESS_STEPS = {
    google: ['Sign in to the Google Admin console as an admin.', 'Security → Access and data control → API controls → Manage third-party app access (the "Accessed apps" list).', 'Download the list as CSV - or export the OAuth token log from Reporting - and drop it here.'],
    microsoft: ['Sign in to the Microsoft Entra admin center.', 'Enterprise apps → All applications (or Sign-in logs for who used what).', 'Download as CSV and drop it here.'],
  };
  function drawImport() {
    var el = $('#importView');
    el.innerHTML = '<div class="card"><div class="head"><h2>🔦 Find your tools</h2><button class="btn small ghost" type="button" id="backMain">Back</button></div>' +
      '<p class="promise">🔒 Read on this device. Nothing is uploaded.</p>' +
      '<p class="small muted">Use one way or all three - the same tool found twice becomes one row. Spend comes from the card, users and access from the sign-in export.</p></div>' +
      '<div class="ways">' +
      '<div class="way"><h3>💳 Card or expense CSV</h3><ol class="steps"><li>Sign in to your company card or expense tool.</li><li>Download transactions as CSV - 6 to 12 months.</li><li>Drop the file here.</li></ol>' +
      dropZone('card', 'Choose the card CSV') + '<button class="link-btn" type="button" data-paste="card">or paste the CSV text</button><div data-pastebox="card"></div><div id="note-card"></div></div>' +
      '<div class="way"><h3>🔑 Sign-in export</h3><div class="tabs" role="group" aria-label="Which admin console">' +
      '<button type="button" data-ak="google" aria-pressed="' + (state.accessKind === 'google') + '">Google Workspace</button><button type="button" data-ak="microsoft" aria-pressed="' + (state.accessKind === 'microsoft') + '">Microsoft 365</button></div>' +
      '<ol class="steps" id="akSteps">' + ACCESS_STEPS[state.accessKind].map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      dropZone('access', 'Choose the export') + '<button class="link-btn" type="button" data-paste="access">or paste the CSV text</button><div data-pastebox="access"></div><div id="note-access"></div></div>' +
      '<div class="way"><h3>📝 Paste a list</h3><ol class="steps"><li>Ask each team what they sign in to.</li><li>One tool a line.</li><li>Add them.</li></ol>' +
      '<label class="vh" for="listText">Tool names</label><textarea class="input" id="listText" placeholder="Notion&#10;Calendly&#10;Canva"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="btn small" type="button" id="listAdd">Add these</button><button class="btn small ghost" type="button" id="handAdd">Add one by hand</button></div><div id="note-list"></div></div>' +
      '</div><div class="found" id="found"></div>';
    $('#backMain', el).onclick = function () { state.view = 'main'; drawAll(); };
    $$('[data-file]', el).forEach(function (inp) { inp.onchange = function () { readFiles(inp.files, inp.getAttribute('data-file')); inp.value = ''; }; });
    $$('[data-drop]', el).forEach(function (z) {
      z.ondragover = function (e) { e.preventDefault(); z.classList.add('over'); };
      z.ondragleave = function () { z.classList.remove('over'); };
      z.ondrop = function (e) { e.preventDefault(); z.classList.remove('over'); readFiles(e.dataTransfer.files, z.getAttribute('data-drop')); };
    });
    $$('[data-paste]', el).forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-paste');
        var box = $('[data-pastebox="' + k + '"]', el);
        box.innerHTML = '<label class="vh" for="paste-' + k + '">CSV text</label><textarea class="input" id="paste-' + k + '" placeholder="Paste the CSV, header row included"></textarea><button class="btn small" type="button" style="margin-top:8px">Read it</button>';
        $('button', box).onclick = function () { readTexts([{ name: 'pasted.csv', text: $('textarea', box).value }], k); };
        $('textarea', box).focus();
      };
    });
    $$('[data-ak]', el).forEach(function (b) {
      b.onclick = function () {
        state.accessKind = b.getAttribute('data-ak');
        $$('[data-ak]', el).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        $('#akSteps', el).innerHTML = ACCESS_STEPS[state.accessKind].map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
      };
    });
    $('#listAdd', el).onclick = function () {
      var r = C.parseList($('#listText', el).value);
      if (!r.tools.length) { importNote('list', 'Type at least one tool name.'); return; }
      state.found.list = r.tools;
      importNote('list', plural(r.tools.length, 'tool') + ' from your list' + (r.over ? ' (the first ' + C.LIMITS.listLines + ')' : '') + '.', true);
      drawFound();
    };
    $('#handAdd', el).onclick = addToolSheet;
    drawFound();
  }

  /* ---------------- read a vendor's terms (AI, signed in) ---------------- */

  var termsDrawn = false;
  function drawTerms() {
    var el = $('#termsCard');
    el.innerHTML = '<div class="head"><h2 id="termsH">Read a vendor’s terms</h2><span class="chip c-beam">AI · free account</span></div>' +
      '<p class="small muted">Paste their privacy policy, terms of service or DPA. Shadow answers eight questions - does it train AI on your data, how long they keep it, where, who else touches it, breach notice, a DPA, renewal and cancellation - each with the sentence it came from, checked word for word against what you pasted.</p>' +
      '<label class="field"><span>Vendor</span><input class="input" id="termsVendor" maxlength="60" list="toolNames" placeholder="e.g. Notewise"></label><datalist id="toolNames"></datalist>' +
      '<label class="field"><span>Their text</span><textarea class="input" id="termsText" maxlength="' + C.LIMITS.termsText + '" placeholder="Paste the privacy policy, terms or DPA"></textarea></label>' +
      '<div class="row spread"><span class="small muted" id="termsCount">0 / ' + C.LIMITS.termsText.toLocaleString('en-US') + '</span><button class="link-btn" type="button" id="termsExample">Paste an example</button></div>' +
      '<button class="btn block" type="button" id="termsGo">Read it</button>' +
      '<p class="small legal" style="margin-top:10px">Not legal advice - read the contract.</p><p class="small muted">The text is read once and never kept. Signed out, this asks you to sign in; the free credit covers it.</p>' +
      '<div id="termsOut" aria-live="polite"></div>';
    termsDrawn = true;
    var ta = $('#termsText', el);
    ta.oninput = function () { $('#termsCount', el).textContent = ta.value.length.toLocaleString('en-US') + ' / ' + C.LIMITS.termsText.toLocaleString('en-US'); };
    $('#termsExample', el).onclick = function () { ta.value = S.TERMS_EXAMPLE; $('#termsVendor', el).value = 'Notewise'; ta.oninput(); };
    $('#termsGo', el).onclick = readTerms;
    drawTermsTools();
  }
  function drawTermsTools() {
    var dl = $('#toolNames');
    if (dl) dl.innerHTML = state.tools.slice(0, 200).map(function (t) { return '<option value="' + esc(t.name) + '"></option>'; }).join('');
  }
  function readTerms() {
    var out = $('#termsOut'), ta = $('#termsText'), btn = $('#termsGo');
    var text = ta.value, vendor = C.clean($('#termsVendor').value, 60);
    if (text.trim().length < C.LIMITS.termsMin) { out.innerHTML = '<p class="err">Paste the vendor’s privacy policy, terms or DPA - at least a few paragraphs.</p>'; return; }
    if (!signedIn()) { openAccount('Reading a vendor’s terms uses AI, so it needs a free account - it comes with $2 of credit, which covers many readings. Everything else in Shadow is free without one.', readTerms); return; }
    btn.disabled = true; btn.textContent = 'Reading… (up to a minute)';
    out.innerHTML = '';
    api('POST', 'api/terms', { text: text, vendor: vendor }).then(function (r) {
      state.review = r.review;
      drawReview(vendor);
    }).catch(function (e) {
      if (e.status === 403 && e.data && e.data.code === 'verify-email') return verifyNote(out, e);
      showError(e, out);
    }).then(function () { btn.disabled = false; btn.textContent = 'Read it'; });
  }
  function drawReview(vendor) {
    var r = state.review, out = $('#termsOut');
    if (!r || !out) return;
    var key = C.toolKey(vendor || r.vendor);
    var tool = state.tools.filter(function (t) { return t.key === key; })[0];
    var html = '<h3 style="margin-top:14px">' + esc(r.vendor || vendor || 'Their terms') + '</h3>' + (r.summary ? '<p>' + esc(r.summary) + '</p>' : '') +
      (r.unverified ? '<p class="unverified" role="alert">⚠ ' + plural(r.unverified, 'quote was', 'quotes were') + ' not found word for word in what you pasted - check ' + (r.unverified === 1 ? 'it' : 'them') + ' against the text.</p>' : '');
    r.items.forEach(function (it) {
      html += '<div class="term"><div class="q"><b>' + esc(it.label) + '</b><span class="chip w-' + it.worry + '">' + esc(it.answer) + '</span></div>' +
        (it.detail ? '<p class="small" style="margin:4px 0 0">' + esc(it.detail) + '</p>' : '') +
        (it.quote ? '<blockquote>“' + esc(it.quote) + '”</blockquote>' + (it.verified ? '<span class="verified">✓ Found word for word in the text</span>' : '<span class="unverified">⚠ Not found in the text - check it</span>') : '<span class="small muted">The text doesn’t say.</span>') +
        ' <span class="small muted">· ' + esc(it.confidence) + ' confidence</span></div>';
    });
    html += '<p class="small legal">Not legal advice - read the contract.</p>';
    if (tool) html += '<button class="btn small ghost" type="button" id="toNotes">Add this to ' + esc(tool.name) + '’s notes</button>';
    out.innerHTML = html;
    var tn = $('#toNotes', out);
    if (tn) tn.onclick = function () {
      var line = C.termsNote(r, TODAY);
      var dpaNo = r.items.filter(function (i) { return i.key === 'dpa'; })[0];
      patchTool(tool.id, { notes: C.clean((line + ' ' + tool.notes).trim(), C.LIMITS.notes) });
      tn.disabled = true; tn.textContent = 'Added to notes';
      if (dpaNo && dpaNo.answer === 'yes' && !tool.dpa) toast('They offer a DPA - ask for it, then tick DPA on ' + tool.name + '.', 4200);
    };
  }

  /* ---------------- how we worked this out ---------------- */

  function drawHow() {
    var el = $('#howCard');
    el.innerHTML = '<details class="how"><summary><h2 id="howH" style="margin:0">How we worked this out</h2></summary>' +
      '<p>Each tool gets a risk from 0 to 100. Every factor is 1 when the tool is in good shape and grows as it gets worse, so making one thing worse can never lower a score:</p>' +
      '<ul><li><b>Status</b>: approved ×0.3, retiring ×0.45, under review ×0.65, not approved ×1.</li>' +
      '<li><b>Data it touches</b>: the most sensitive kind - student records or health ×1, customer, employee or financial ×0.8, confidential ×0.5, none ×0.1, not set yet ×0.5 - plus 0.1 for each further kind of personal data (at most ×1.3).</li>' +
      '<li><b>Access</b> from the sign-in export: 1 + how broad the grants are (0 to 1: "read all mail" 0.9, "read and write all files" 0.9, calendars 0.35-0.5, sign-in only 0.05).</li>' +
      '<li><b>Users</b>: 1 + 0.5 × log<sub>10</sub>(1 + users) / 2, at most ×1.5.</li>' +
      '<li><b>Spend</b>: 1 + 0.3 × log(1 + dollars a year) / log(20,001), at most ×1.3.</li>' +
      '<li><b>Contract</b>: none ×1.3, click-through ×1.15, signed ×1. <b>DPA</b>: holding personal data without one ×1.35 (×1.5 for student or health records).</li>' +
      '<li><b>SSO</b>: ×1.15 without it when two or more people use it. <b>Owner</b>: ×1.15 with nobody named.</li></ul>' +
      '<p>Raw risk = 40 × all of those; the tool’s score = 100 × (1 − e<sup>−raw/100</sup>).</p>' +
      '<p><b>The Shadow score</b> leans on your ten riskiest tools - that is where a breach comes from - and on the average, so a messy estate can’t hide behind them: R = ¾ × (the average raw risk of the ten riskiest, empty places counting 0) + ¼ × (the average over every tool); score = 100 × (1 − e<sup>−R/100</sup>). Bands: Low under 25, Watch 25+, High 50+, Severe 75+.</p>' +
      '<p><b>The fixes</b> are each applied to a copy and re-scored; the number is exactly how far the score drops, to a tenth of a point. The first three are the best fix for three different tools.</p>' +
      '<p><b>Finding tools</b>: a curated table of ' + C.KNOWN.length + ' business services maps messy card descriptors to a name and the data such a tool usually holds - change it if yours is different. Anything else counts as software only with a strong hint in its name (.io, .ai, "software", "subscription"…) or a weak one and a regular bill, and is marked "probably software - check". A trial is a charge of $1 or less followed by the full price, or still alone and recent - most trials run ' + C.TRIAL_DAYS + ' days, so the conversion date is an estimate.</p>' +
      '<p class="small muted">A score is a way to choose what to do first, not a verdict. Shadow can miss a tool paid on another card, and a descriptor can hide two services under one name.</p></details>';
  }

  /* ---------------- a staff member's request page ---------------- */

  function askFormHtml(orgName, preview) {
    return '<p class="ask-org">' + esc(orgName) + (preview ? ' · preview' : '') + '</p><h2>Can I use this?</h2>' +
      '<p class="muted">Ask before you sign up, so ' + esc(orgName) + ' can check the tool and the data it would hold. No account needed.</p>' +
      '<form id="askForm"><label class="field"><span>Which tool?</span><input class="input" name="tool" maxlength="60" required placeholder="e.g. StoryLoom"></label>' +
      '<label class="field"><span>What would you use it for?</span><textarea class="input" name="why" maxlength="400" style="min-height:90px"></textarea></label>' +
      '<div class="field"><span style="display:block;font-weight:700;font-size:.88rem;margin-bottom:4px">What data would go in it?</span><div class="checks">' +
      C.DATA.map(function (d) { return '<label><input type="checkbox" name="data" value="' + d + '">' + esc(C.DATA_LABEL[d]) + '</label>'; }).join('') + '</div></div>' +
      '<div class="field"><span style="display:block;font-weight:700;font-size:.88rem;margin-bottom:4px">Already started a trial?</span>' + seg('trial', [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']], 'no') + '</div>' +
      '<div class="two"><label class="field"><span>How many people?</span><input class="input" name="users" inputmode="numeric"></label>' +
      '<label class="field"><span>Your name</span><input class="input" name="name" maxlength="60" required></label></div>' +
      '<div id="askErr"></div><button class="btn block big" type="submit">Send the request</button></form>';
  }
  function bindAskForm(root, onSend) {
    var trial = 'no';
    $$('[data-seg="trial"] button', root).forEach(function (b) {
      b.onclick = function () { trial = b.getAttribute('data-v'); $$('[data-seg="trial"] button', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); };
    });
    $('#askForm', root).onsubmit = function (e) {
      e.preventDefault();
      var f = e.target;
      var body = { tool: f.tool.value, why: f.why.value, data: $$('input[name=data]', f).filter(function (x) { return x.checked; }).map(function (x) { return x.value; }), trial: trial, users: f.users.value, name: f.name.value };
      var c = C.cleanRequest(body);
      if (c.error) { $('#askErr', root).innerHTML = '<p class="err">' + esc(c.error) + '</p>'; return; }
      onSend(body, f);
    };
  }
  function previewAsk() {
    sheet('<div id="askBox">' + askFormHtml(S.ORG.name, true) + '</div>', function (root) {
      bindAskForm(root, function (body) {
        var c = C.cleanRequest(body).request;
        state.requests.unshift(Object.assign({ id: 'qpreview' + Date.now().toString(16).slice(-8), status: 'open', at: TODAY }, c));
        closeSheet();
        drawRequests();
        toast('Sent - it’s in the queue below. (Example only: nothing left this device.)', 4200);
      });
    });
  }
  function renderAsk() {
    document.title = 'Ask before you sign up - Shadow';
    $('#mainView').hidden = true; $('#strip').hidden = true; $('#importView').hidden = true;
    $('#acct').hidden = true; $('#orgBtn').hidden = true;
    var el = $('#askView');
    el.hidden = false;
    el.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
    api('GET', 'api/r/' + RID).then(function (r) { drawAsk(r); }).catch(function (e) {
      el.innerHTML = '<div class="card"><h2>That link doesn’t work</h2><p class="muted">' + esc(e.message) + '</p></div>';
    });
  }
  function drawAsk(r) {
    var el = $('#askView');
    var mineHtml = (r.mine || []).length ? '<div class="card"><h2>Your requests</h2>' + r.mine.map(function (q) {
      return reqHtml(q, false).replace(/<\/div>$/, '') + (q.status === 'open' ? '<button class="btn small ghost" type="button" data-withdraw="' + esc(q.id) + '">Withdraw</button>' : '') + '</div>';
    }).join('') + '<p class="small muted">Only this browser sees these. ' + esc(r.org.name) + '’s IT or ops lead sees each request and your name.</p></div>' : '';
    el.innerHTML = '<div class="card">' + (r.accepting ? askFormHtml(r.org.name, false) : '<p class="ask-org">' + esc(r.org.name) + '</p><h2>Not taking requests right now</h2><p class="muted">Ask your IT or operations lead directly.</p>') + '</div>' + mineHtml;
    if (r.accepting) bindAskForm(el, function (body, f) {
      var btn = $('button[type=submit]', f); btn.disabled = true;
      api('POST', 'api/r/' + RID, body).then(function (res) {
        toast('Sent. You’ll see the answer here.');
        drawAsk({ org: r.org, accepting: r.accepting, mine: res.mine });
      }).catch(function (e) { btn.disabled = false; showError(e, $('#askErr', el)); });
    });
    $$('[data-withdraw]', el).forEach(function (b) {
      b.onclick = function () {
        api('DELETE', 'api/r/' + RID + '/' + b.getAttribute('data-withdraw')).then(function (res) { drawAsk({ org: r.org, accepting: r.accepting, mine: res.mine }); }).catch(function (e) { showError(e); });
      };
    });
  }

  /* ---------------- inventories in the account ---------------- */

  function saveToAccount() {
    if (!signedIn()) { openAccount('Saving keeps your inventory - never the files - in a free account, and gives you a request link for staff. One account works across every app on this site.', saveToAccount); return; }
    if (state.orgId) return;
    api('POST', 'api/orgs', savedBody()).then(function (r) {
      state.orgId = r.org.id; state.link = r.link; state.queue = null;
      persist();
      return loadOrgList();
    }).then(function () { drawAll(); toast('Saved. Your request link is under “Can I use this?”.'); })
      .catch(function (e) { showError(e); });
  }
  function loadOrgList() {
    return api('GET', 'api/orgs').then(function (r) { state.orgs = r.orgs || []; drawStrip(); return state.orgs; }).catch(function () { state.orgs = []; return []; });
  }
  function openOrg(id) {
    return api('GET', 'api/orgs/' + id).then(function (r) {
      setMine(r.org, { orgId: r.org.id, link: r.link, open: r.open });
      persist();
      state.view = 'main';
      drawAll();
    });
  }
  function openOrgs() {
    sheet('<h2>Your inventories</h2><div id="orgList"></div>' +
      (state.orgs.length < C.LIMITS.orgs ? '<button class="btn block ghost" type="button" id="newOrg" style="margin-top:12px">Start a new inventory</button>' : '<p class="small muted">An account keeps up to ' + C.LIMITS.orgs + '.</p>'), function (root) {
      $('#orgList', root).innerHTML = state.orgs.map(function (o) {
        return '<button class="tool" type="button" data-org="' + esc(o.id) + '"><span class="em" aria-hidden="true">🏢</span><span><span class="nm">' + esc(o.name) + '</span></span><span class="rt"><span class="chip b-' + esc(o.band) + '">' + o.score + ' ' + esc(o.band) + '</span></span><span class="sub">' + plural(o.tools, 'tool') + (o.id === state.orgId ? ' · open now' : '') + '</span></button>';
      }).join('');
      $$('[data-org]', root).forEach(function (b) { b.onclick = function () { closeSheet(); openOrg(b.getAttribute('data-org')).catch(function (e) { showError(e); }); }; });
      var n = $('#newOrg', root);
      if (n) n.onclick = function () { closeSheet(); keep(K_LOCAL, null); loadSample(); state.view = 'import'; drawAll(); };
    });
  }
  function openOrgMenu() {
    sheet('<h2>' + esc(state.org.name) + '</h2><label class="field"><span>Name</span><input class="input" id="renameIn" maxlength="80" value="' + esc(state.org.name) + '"></label>' +
      '<button class="btn block" type="button" id="renameGo">Save the name</button>' +
      '<button class="btn block ghost" type="button" id="seeExample" style="margin-top:10px">Look at the example again</button>' +
      '<button class="btn block danger" type="button" id="dropOrg" style="margin-top:10px">' + (state.orgId ? 'Delete this inventory and its requests' : 'Clear this inventory from this device') + '</button>', function (root) {
      $('#renameGo', root).onclick = function () { var v = C.clean($('#renameIn', root).value, 80); if (!v) return; state.org.name = v; persist(); closeSheet(); drawStrip(); };
      $('#seeExample', root).onclick = function () { closeSheet(); persist(); loadSample(); drawAll(); window.scrollTo(0, 0); toast('Your inventory is kept - “Find our tools” or sign in to get back to it.', 4200); };
      $('#dropOrg', root).onclick = function () {
        if (!confirm(state.orgId ? 'Delete this inventory, its request link and every request? This cannot be undone.' : 'Clear this inventory from this device?')) return;
        var go = state.orgId ? api('DELETE', 'api/orgs/' + state.orgId) : Promise.resolve();
        go.then(function () { keep(K_LOCAL, null); closeSheet(); loadSample(); return signedIn() ? loadOrgList() : null; })
          .then(function () { drawAll(); toast('Deleted.'); }).catch(function (e) { showError(e); });
      };
    });
  }
  function syncOnSignIn() {
    if (!signedIn()) return Promise.resolve();
    return loadOrgList().then(function (orgs) {
      if (state.mode === 'mine' && !state.orgId) { drawAll(); return; }
      if (!orgs.length) return;
      var want = state.orgId && orgs.some(function (o) { return o.id === state.orgId; }) ? state.orgId : orgs[0].id;
      if (state.mode === 'mine' && state.orgId && state.syncedTo && state.syncedTo !== state.me.email) want = orgs[0].id;
      return openOrg(want);
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
  function sheet(html, onOpen, opts) {
    var s = $('#sheet'), back = $('#sheetBack');
    lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" id="sheetClose" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    $('#sheetClose').onclick = closeSheet;
    back.onclick = closeSheet;
    if (onOpen) onOpen(s);
    var f = opts && opts.focusClose ? $('#sheetClose') : (s.querySelector('input:not(.vh):not([type=checkbox]):not([type=date]), textarea') || s.querySelector('button:not(.close)') || $('#sheetClose'));
    setTimeout(function () { try { if (f) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  var FREE_LINE = 'Finding tools, the score, the fixes, the radar and requests are free. A free account saves up to three inventories (never the files), gives you a request link for staff, and lets you read vendors’ terms with AI - it comes with $2 of credit. One account works across every app on this site.';

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
      '<p class="small muted" style="margin:6px 0 0">Reading a vendor’s terms costs a few cents. Finding tools, the score, the fixes and requests are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () {
            closeSheet();
            // A saved inventory lives in the account: leave nothing of it on a
            // shared computer.
            if (state.orgId) { keep(K_LOCAL, null); loadSample(); }
            state.me = { signedIn: false }; state.orgs = [];
            drawTop(); drawAll();
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Finding tools, the score, the fixes, the radar and requests keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- start ---------------- */

  function boot() {
    var local = recall(K_LOCAL);
    if (local && Array.isArray(local.tools) && local.org) {
      setMine(local.org, { orgId: typeof local.orgId === 'string' && /^o[0-9a-f]{12}$/.test(local.orgId) ? local.orgId : null });
      state.done = Array.isArray(local.done) ? local.done.filter(function (d) { return d && typeof d.id === 'string'; }).map(function (d) { return { id: d.id, text: C.clean(d.text, 200), at: C.isoDay(d.at) ? d.at : null }; }) : [];
      state.syncedTo = typeof local.syncedTo === 'string' ? local.syncedTo : null;
    } else {
      loadSample();
    }
    drawHow();
    drawTerms();
    drawAll();
  }

  if (RID) {
    renderAsk();
    return;
  }
  drawTop();
  boot();
  loadMe().then(function () {
    if (!signedIn()) {
      // Saved to an account but signed out here: the account has it.
      if (state.mode === 'mine' && state.orgId && state.syncedTo) { keep(K_LOCAL, null); loadSample(); drawAll(); }
      return;
    }
    return syncOnSignIn().then(function () {
      if (/[?&](topup|member|credited)=1\b/.test(location.search)) openSettings();
    });
  });
})();
