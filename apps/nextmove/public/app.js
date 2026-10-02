/*
 * Next Move - the page.
 *
 * Signed out it draws the made-up example (sample.js) on every tab, with no
 * request beyond /api/me. Signed in it draws the person's own matches,
 * companies, pay data and week from the API, or the set-up flow when they
 * have not set up yet. No inline script, no inline handlers: every handler
 * is attached here, and every string from the server goes through esc().
 */
(function () {
  'use strict';

  var S = window.NextMoveSample;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_TAB = 'nextmove-tab';
  var WIDE = window.matchMedia ? window.matchMedia('(min-width: 1000px)') : { matches: false };

  var VERDICT = { strong: 'Strong fit', worth_a_look: 'Worth a look', stretch: 'Stretch', skip: 'Skip' };
  var PROVIDER = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' };
  var SOURCE = { greenhouse: 'the company’s Greenhouse board', lever: 'the company’s Lever board', ashby: 'the company’s Ashby board', websearch: 'the weekly web search' };
  var EVENT_SRC = { sec: 'SEC filing', gdelt: 'News', websearch: 'Web search' };
  var SENIORITY = [['', 'Any level'], ['entry', 'Entry level'], ['mid', 'Mid-level'], ['senior', 'Senior'], ['staff', 'Staff / principal'], ['manager', 'Manager'], ['director', 'Director'], ['vp', 'VP'], ['c_level', 'C-level']];
  var STATE_NAME = { REMOTE: 'Remote', OTHER: 'Elsewhere' };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function k$(n) { return n === null || n === undefined ? '—' : '$' + (n >= 1000 ? Math.round(n / 1000) + 'k' : Math.round(n)); }
  function full$(n) { return n === null || n === undefined ? '—' : '$' + Math.round(n).toLocaleString('en-US'); }
  function payText(f) {
    if (!f.payMin && !f.payMax) return '';
    var cur = f.payCurrency && f.payCurrency !== 'USD' ? ' ' + f.payCurrency : '';
    if (f.payMin && f.payMax && f.payMin !== f.payMax) return k$(f.payMin) + '–' + k$(f.payMax).replace('$', '') + cur;
    return (f.payMin ? 'from ' + k$(f.payMin) : 'up to ' + k$(f.payMax)) + cur;
  }
  function ago(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '';
    var h = Math.round((Date.now() - t) / 36e5);
    if (h < 1) return 'just now';
    if (h < 24) return h + 'h ago';
    var d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }
  function until(iso) {
    var h = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 36e5));
    return h < 1 ? 'within the hour' : h < 24 ? 'in ' + plural(h, 'hour') : 'tomorrow';
  }
  function safeHref(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }

  var state = {
    me: null,
    mode: 'sample',          // 'sample' | 'live' | 'setup'
    tab: 'today',
    profile: null,
    fits: null, companies: null, comps: null, digest: null, nextRun: null, lastRun: null,
    sel: null,               // selected fit id
    filter: { verdict: 'all', remote: false, pay: false },
    setup: null,             // the set-up flow's draft
    loading: {},
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // Two routes stream whitespace and so answer 200 even on failure; an
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
    $$('.toast').forEach(function (x) { x.remove(); });
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 3000);
  }
  function recall(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function keep(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    if (err && err.status === 403 && err.data && err.data.code === 'verify-email' && where) return verifyNote(where, err);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then come back. Everything that is not AI works meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).onclick = function () {
      var b = this; b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    };
  }

  /* ---------------- data ---------------- */

  function data() {
    if (state.mode === 'sample') return { fits: S.fits, companies: S.companies, comps: S.comps, digest: S.digest, profile: { targets: S.profile.targets, watchlist: S.watchlist }, sample: true };
    return { fits: state.fits, companies: state.companies, comps: state.comps, digest: state.digest, profile: state.profile, sample: false };
  }

  function loadTab(tab, force) {
    if (state.mode !== 'live') return Promise.resolve();
    var key = { today: 'fits', companies: 'companies', comp: 'comps', week: 'digest' }[tab];
    if (!force && state[key] !== null) return Promise.resolve();
    state.loading[tab] = true;
    var path = { today: 'api/today', companies: 'api/companies', comp: 'api/comp', week: 'api/week' }[tab];
    return api('GET', path).then(function (r) {
      if (tab === 'today') { state.fits = r.fits || []; state.nextRun = r.nextRun; state.lastRun = r.lastRun; }
      if (tab === 'companies') { state.companies = r.companies || []; state.nextRun = r.nextRun; }
      if (tab === 'comp') state.comps = r.comps || [];
      if (tab === 'week') state.digest = r.digest;
    }).catch(function (e) {
      state[key] = undefined;
      state.loadError = e.message;
    }).then(function () { state.loading[tab] = false; });
  }

  /* ---------------- render ---------------- */

  function render() {
    drawTop();
    drawStrip();
    if (state.mode === 'setup') { $('#tabs').innerHTML = ''; drawSetup(); return; }
    drawTabs();
    drawView();
  }

  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Account' : 'Sign in';
    b.onclick = function () { if (signedIn()) openSettings(); else openAccount(); };
    var pb = $('#profileBtn');
    pb.hidden = !(signedIn() && state.mode === 'live');
    pb.onclick = function () { startSetup(1); };
    $('#privacyBtn').onclick = openPrivacy;
  }

  function drawStrip() {
    var el = $('#strip');
    var d = data();
    if (state.mode === 'setup') {
      el.innerHTML = '<div class="strip"><span class="kicker">Set up</span><h1>Three steps to your first matches</h1><p>Your background, the roles you are aiming for, and the companies to watch. Every day after that, new roles are scored against you.</p></div>';
      return;
    }
    if (d.sample) {
      el.innerHTML = '<div class="strip"><span class="kicker">Example</span><h1>' + esc(S.who) + '</h1>' +
        '<p>Every person, company and number on this page is made up - it shows what Next Move does with yours. Each day it reads the career boards of the companies you watch, scores the new roles against your background, and quotes the posting for why.</p>' +
        '<div class="stats"><div class="stat"><b>' + S.fits.length + '</b><span>new matches</span></div><div class="stat"><b>' + S.fits.filter(function (f) { return f.verdict === 'strong'; }).length + '</b><span>strong fits</span></div><div class="stat"><b>' + S.watchlist.length + '</b><span>companies watched</span></div></div>' +
        '<div class="row"><button class="btn light" id="startBtn" type="button">Set up yours - free</button><button class="link-btn" id="howBtn" type="button">How it works</button></div></div>';
      $('#startBtn').onclick = function () { if (signedIn()) startSetup(1); else openAccount('Create a free account to set up your own. It comes with $2 of AI credit - a day of scoring costs a few cents.', function () { startSetup(1); }); };
      $('#howBtn').onclick = openHow;
      return;
    }
    var fits = state.fits || [];
    var week = fits.filter(function (f) { return Date.now() - Date.parse(f.scoredAt) < 7 * 864e5; });
    var strong = week.filter(function (f) { return f.verdict === 'strong'; }).length;
    var watching = (state.profile && state.profile.watchlist || []).length;
    var titles = (state.profile && state.profile.targets && state.profile.targets.titles || []).join(' · ');
    el.innerHTML = '<div class="strip"><span class="kicker">Your next move</span><h1>' + esc(titles || 'Your matches') + '</h1>' +
      '<div class="stats"><div class="stat"><b>' + week.length + '</b><span>matches this week</span></div><div class="stat"><b>' + strong + '</b><span>strong fits</span></div><div class="stat"><b>' + watching + '</b><span>companies watched</span></div></div>' +
      '<p>' + (state.nextRun ? 'Next scan ' + esc(until(state.nextRun)) + ' (11:15 UTC daily).' : 'Scanned daily at 11:15 UTC.') + (state.lastRun && state.lastRun.skipped === 'no-credit' ? ' <b>The last run skipped you: your AI credit is spent.</b>' : '') + (state.lastRun && state.lastRun.skipped === 'unverified' ? ' <b>The last run skipped you: confirm your email to use the free credit.</b>' : '') + '</p>' +
      '<div class="row"><button class="btn light" id="editBtn" type="button">Edit profile</button></div></div>';
    $('#editBtn').onclick = function () { startSetup(1); };
  }

  var TABS = [['today', 'Today'], ['companies', 'Companies'], ['comp', 'Pay'], ['week', 'This week']];
  function drawTabs() {
    var el = $('#tabs');
    el.innerHTML = TABS.map(function (t) {
      var on = state.tab === t[0];
      return '<button role="tab" type="button" id="tab-' + t[0] + '" aria-controls="view" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>';
    }).join('');
    $$('[role=tab]', el).forEach(function (b) {
      b.onclick = function () { setTab(b.getAttribute('data-tab')); };
      b.onkeydown = function (e) {
        var i = TABS.findIndex(function (t) { return t[0] === state.tab; });
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
          setTab(n); var x = $('#tab-' + n); if (x) x.focus();
        }
      };
    });
  }
  function setTab(t) {
    state.tab = t; keep(K_TAB, t);
    drawTabs();
    drawView();
    if (state.mode === 'live') loadTab(t).then(function () { if (state.tab === t) { drawView(); if (t === 'today') drawStrip(); } });
  }

  function drawView() {
    var el = $('#view');
    el.setAttribute('role', 'tabpanel');
    el.setAttribute('aria-labelledby', 'tab-' + state.tab);
    var d = data();
    var key = { today: 'fits', companies: 'companies', comp: 'comps', week: 'digest' }[state.tab];
    if (!d.sample && d[key] === null) { el.innerHTML = '<div class="card empty"><p class="muted">Loading…</p></div>'; return; }
    if (!d.sample && d[key] === undefined) { el.innerHTML = '<div class="card empty"><h2>That did not load</h2><p class="muted">' + esc(state.loadError || 'Try again in a moment.') + '</p><button class="btn small ghost" id="retry" type="button">Try again</button></div>'; $('#retry').onclick = function () { state[key] = null; setTab(state.tab); }; return; }
    if (state.tab === 'today') drawToday(el, d);
    else if (state.tab === 'companies') drawCompanies(el, d);
    else if (state.tab === 'comp') drawComp(el, d);
    else drawWeek(el, d);
  }

  /* ---------------- Today ---------------- */

  function filtered(d) {
    var floor = d.profile && d.profile.targets ? d.profile.targets.compFloor : null;
    return (d.fits || []).filter(function (f) {
      if (state.filter.verdict !== 'all' && f.verdict !== state.filter.verdict) return false;
      if (state.filter.remote && !f.remote) return false;
      if (state.filter.pay && floor && !((f.payMax || f.payMin || 0) >= floor)) return false;
      return true;
    });
  }

  function ring(f, big) {
    return '<div class="score ring-' + esc(f.verdict) + (big ? ' big' : '') + '" style="--p:' + Math.max(0, Math.min(100, Number(f.score) || 0)) + '" aria-hidden="true"><span>' + esc(f.score) + '</span></div>';
  }

  function drawToday(el, d) {
    var all = d.fits || [];
    if (!all.length) {
      var watching = (d.profile && d.profile.watchlist || []).length;
      el.innerHTML = '<div class="card empty"><h2>No matches yet</h2>' +
        '<p class="muted">' + (watching ? 'Next Move scans the ' + plural(watching, 'company', 'companies') + ' you watch ' + (state.nextRun ? esc(until(state.nextRun)) : 'daily') + ' and scores the best new roles against your background.' : 'Add companies to watch and the roles you want, and matches arrive with the next daily scan.') + '</p>' +
        (watching ? '<p><button class="btn" id="scoreNow" type="button">Score my top matches now</button></p><p class="small muted">Reads your companies’ boards now and scores the best ' + (state.me && state.me.tier === 'paid' ? '8' : '3') + ' - a few cents from your AI credit. Once a day.</p><div id="scoreMsg"></div>' : '<p><button class="btn" id="goSetup" type="button">Add companies to watch</button></p>') + '</div>';
      var sn = $('#scoreNow');
      if (sn) sn.onclick = scoreNow;
      var gs = $('#goSetup');
      if (gs) gs.onclick = function () { startSetup(3); };
      return;
    }
    var list = filtered(d).sort(function (a, b) { return b.score - a.score; });
    var floor = d.profile && d.profile.targets ? d.profile.targets.compFloor : null;
    if (!list.some(function (f) { return f.postingId === state.sel; })) state.sel = list.length ? list[0].postingId : null;
    var chip = function (key, val, label) {
      var on = key === 'verdict' ? state.filter.verdict === val : state.filter[key];
      return '<button class="chip" type="button" aria-pressed="' + Boolean(on) + '" data-f="' + key + '" data-v="' + esc(val) + '">' + esc(label) + '</button>';
    };
    var counts = {};
    all.forEach(function (f) { counts[f.verdict] = (counts[f.verdict] || 0) + 1; });
    el.innerHTML = '<div class="chips" role="group" aria-label="Filter matches">' +
      chip('verdict', 'all', 'All ' + all.length) + chip('verdict', 'strong', 'Strong ' + (counts.strong || 0)) + chip('verdict', 'worth_a_look', 'Worth a look ' + (counts.worth_a_look || 0)) + chip('verdict', 'stretch', 'Stretch ' + (counts.stretch || 0)) +
      chip('remote', true, 'Remote') + (floor ? chip('pay', true, 'Pays ' + k$(floor) + '+') : '') + '</div>' +
      '<div class="today' + (WIDE.matches ? ' split' : '') + '"><ul class="fitlist" aria-label="Matches">' + (list.length ? list.map(rowHtml).join('') : '<li class="card empty"><p class="muted">Nothing matches these filters.</p></li>') + '</ul>' +
      (WIDE.matches ? '<div class="card detail" id="detail" aria-live="polite"></div>' : '') + '</div>';
    $$('.chip', el).forEach(function (c) {
      c.onclick = function () {
        var k = c.getAttribute('data-f');
        if (k === 'verdict') state.filter.verdict = c.getAttribute('data-v');
        else state.filter[k] = !state.filter[k];
        drawToday(el, d);
      };
    });
    $$('[data-fit]', el).forEach(function (b) {
      b.onclick = function () {
        state.sel = b.getAttribute('data-fit');
        if (WIDE.matches) { $$('[data-fit]', el).forEach(function (x) { x.setAttribute('aria-current', String(x === b)); }); drawDetail($('#detail'), findFit(d, state.sel), d); }
        else openFit(findFit(d, state.sel), d);
      };
    });
    if (WIDE.matches && state.sel) drawDetail($('#detail'), findFit(d, state.sel), d);
  }
  function findFit(d, id) { var l = d.fits || []; for (var i = 0; i < l.length; i++) if (l[i].postingId === id) return l[i]; return null; }

  function rowHtml(f, plain) {
    var pay = payText(f);
    return '<li class="fitrow"><button type="button" data-fit="' + esc(f.postingId) + '" aria-current="' + Boolean(!plain && WIDE.matches && f.postingId === state.sel) + '">' + ring(f) +
      '<span><span class="t">' + esc(f.title) + '</span><span class="meta" style="display:block">' + esc(f.company) + (f.location ? ' · ' + esc(f.location) : '') + '</span>' +
      '<span class="tags"><span class="badge v-' + esc(f.verdict) + '">' + esc(VERDICT[f.verdict] || '') + ' · ' + esc(f.score) + '</span>' + (pay ? '<span class="badge v-skip">' + esc(pay) + '</span>' : '') + (f.remote ? '<span class="badge v-skip">Remote</span>' : '') + (f.source === 'websearch' ? '<span class="badge v-skip">Web search</span>' : '') + '</span></span></button></li>';
  }

  function detailHtml(f, d) {
    if (!f) return '<p class="muted">Pick a match to see why.</p>';
    var pay = payText(f);
    var href = safeHref(f.url);
    return '<div class="head">' + ring(f, true) + '<div><h2>' + esc(f.title) + '</h2><div class="meta-line">' + esc(f.company) + (f.location ? ' · ' + esc(f.location) : '') + (f.remote ? ' · Remote' : '') + '</div>' +
      '<div class="row" style="margin-top:6px"><span class="badge v-' + esc(f.verdict) + '">' + esc(VERDICT[f.verdict] || '') + '</span>' + (pay ? '<span class="pay">' + esc(pay) + ' <span class="src">posted</span></span>' : '<span class="src">No pay posted</span>') + '</div></div></div>' +
      (f.strengths.length ? '<h3>Why it fits</h3><ul class="why">' + f.strengths.map(function (s) { return '<li>' + esc(s.point) + '<q>' + esc(s.quote) + '</q></li>'; }).join('') + '</ul>' : '') +
      (f.gaps.length ? '<h3>Gaps to address</h3><ul class="gaps">' + f.gaps.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul>' : '') +
      (f.positioning ? '<h3>How to position yourself</h3><p class="position">' + esc(f.positioning) + '</p>' : '') +
      '<div class="row" style="margin-top:14px">' + (href ? '<a class="btn" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">Open the posting ↗</a>' : '<span class="badge v-skip">' + (d.sample ? 'Example posting - no link' : 'No link') + '</span>') + '</div>' +
      '<p class="small muted" style="margin-top:12px">Scored ' + esc(ago(f.scoredAt)) + ' from ' + esc(SOURCE[f.source] || 'a public board') + '. Quotes are the posting’s own words, checked against it. An AI’s read of fit - a starting point, not a verdict.</p>';
  }
  function drawDetail(el, f, d) { if (el) el.innerHTML = detailHtml(f, d); }
  function openFit(f, d) { sheet('<div class="detail">' + detailHtml(f, d) + '</div>'); }

  function scoreNow() {
    var b = $('#scoreNow'), msg = $('#scoreMsg');
    b.disabled = true; b.textContent = 'Reading boards and scoring…';
    api('POST', 'api/score-now', {}).then(function (r) {
      toast(r.scored ? 'Scored ' + plural(r.scored, 'match', 'matches') + '.' : 'Nothing new cleared the bar yet - ' + plural(r.postings, 'posting') + ' read.');
      state.fits = null; return loadTab('today', true);
    }).then(function () { render(); }).catch(function (e) { b.disabled = false; b.textContent = 'Score my top matches now'; showError(e, msg); });
  }

  /* ---------------- Companies ---------------- */

  function drawCompanies(el, d) {
    var list = d.companies || [];
    if (!list.length) {
      el.innerHTML = '<div class="card empty"><h2>No companies yet</h2><p class="muted">Add the companies you would move to - by name or careers page link.</p><button class="btn" id="goSetup" type="button">Add companies</button></div>';
      $('#goSetup').onclick = function () { startSetup(3); };
      return;
    }
    el.innerHTML = '<div class="sec-head"><h2>Companies you watch</h2>' + (d.sample ? '' : '<button class="btn small ghost" id="addCo" type="button">Add or remove</button>') + '</div><div class="cogrid">' + list.map(function (c) {
      var board = c.found ? '<span class="badge v-worth_a_look">' + esc(PROVIDER[c.provider] || 'Public') + ' board</span>' : '<span class="badge v-skip">No public board found</span>';
      return '<article class="card co"><div class="row spread"><h3 style="margin:0">' + esc(c.name) + '</h3>' + board + '</div>' +
        (c.found ? '<div class="nums"><div><b class="num">' + (c.openCount === null ? '—' : esc(c.openCount)) + '</b><span>open roles</span></div><div><b class="num">' + (c.newThisWeek === null ? '—' : esc(c.newThisWeek)) + '</b><span>new this week</span></div></div>' +
          (c.lastFetchedAt ? '' : '<p class="small muted">First read with the next daily scan.</p>') + (c.lastError ? '<p class="small err">The last read failed: ' + esc(c.lastError) + '</p>' : '') +
          (c.newest && c.newest.length ? '<ul class="roles">' + c.newest.map(function (r) { var h = safeHref(r.url); return '<li>' + (h ? '<a href="' + esc(h) + '" target="_blank" rel="noopener noreferrer">' + esc(r.title) + '</a>' : esc(r.title)) + (r.location ? ' <span class="muted">· ' + esc(r.location) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : '')
          : '<p class="small muted">Its roles come from the weekly web search; filings and news are watched daily.</p>') +
        '<h3 style="margin:14px 0 4px;font-size:.92rem">Filings and news</h3>' +
        (c.events && c.events.length ? '<ul class="events">' + c.events.map(function (e) { var h = safeHref(e.url); return '<li><span class="badge e-' + esc(e.type) + '">' + esc(e.typeLabel) + '</span> <span class="src">' + esc(EVENT_SRC[e.source] || '') + ' · ' + esc(ago(e.at)) + '</span><span class="h">' + (h ? '<a href="' + esc(h) + '" target="_blank" rel="noopener noreferrer">' + esc(e.headline) + '</a>' : esc(e.headline)) + '</span></li>'; }).join('') + '</ul>' : '<p class="small muted">Nothing in the last 30 days.</p>') +
        '</article>';
    }).join('') + '</div>' + (d.sample ? '<p class="small muted">Example companies and events - none of them are real.</p>' : '');
    var a = $('#addCo');
    if (a) a.onclick = function () { startSetup(3); };
  }

  /* ---------------- Pay ---------------- */

  function rangeRows(rows, labelOf, lo, hi, threshold) {
    var span = Math.max(1, hi - lo);
    var pos = function (v) { return Math.max(0, Math.min(100, ((v - lo) / span) * 100)); };
    return '<ul class="ranges">' + rows.map(function (r) {
      var enough = r.enough !== false && (r.n === null || r.n >= threshold) && r.p50;
      var lab = '<span class="lab">' + labelOf(r) + '<small>' + (r.n === null ? (r.employment ? esc(Number(r.employment).toLocaleString('en-US')) + ' employed' : '') : 'n = ' + esc(r.n)) + '</small></span>';
      if (!enough) return '<li class="range thin">' + lab + '<span><span class="track" aria-hidden="true"></span><span class="vals">Not enough data (fewer than ' + threshold + ')</span></span></li>';
      var both = r.p25 && r.p75;
      var desc = both ? k$(r.p25) + ' to ' + k$(r.p75) + ', median ' + k$(r.p50) : 'median ' + k$(r.p50);
      return '<li class="range">' + lab + '<span><span class="track" role="img" aria-label="' + esc(desc) + '">' + (both ? '<span class="iqr" style="left:' + pos(r.p25) + '%;width:' + Math.max(1, pos(r.p75) - pos(r.p25)) + '%"></span>' : '') + '<span class="mid" style="left:' + pos(r.p50) + '%"></span></span><span class="vals num">' + (both ? esc(k$(r.p25)) + ' – <b>' + esc(k$(r.p50)) + '</b> – ' + esc(k$(r.p75)) : 'median <b>' + esc(k$(r.p50)) + '</b>' + (r.p25 ? ' · from ' + esc(k$(r.p25)) : '') + (r.p75 ? ' · to ' + esc(k$(r.p75)) : '') + ' <span class="src">(the rest not published)</span>') + '</span></span></li>';
    }).join('') + '</ul>';
  }

  function compCard(c, sample) {
    var th = c.threshold || 10;
    var all = [c.posted.all].concat(c.posted.byState, c.posted.byQuarter, [c.h1b.all], c.h1b.byState, c.h1b.byCity, c.h1b.byYear).filter(function (r) { return r && r.n >= th && r.p25 && r.p75; });
    if (c.oews && c.oews.national) all.push({ p25: c.oews.national.p25, p75: c.oews.national.p75 });
    var lo = all.length ? Math.min.apply(null, all.map(function (r) { return r.p25; })) : 0;
    var hi = all.length ? Math.max.apply(null, all.map(function (r) { return r.p75; })) : 1;
    lo = Math.floor(lo * 0.92 / 10000) * 10000; hi = Math.ceil(hi * 1.05 / 10000) * 10000;
    var headline = function (s, what) {
      if (!s || !(s.n >= th) || !s.p50) return '<p class="muted">Not enough data yet - ' + esc(plural(s ? s.n : 0, what[0], what[1])) + ', and ' + th + ' are needed before a figure is shown.</p>';
      return '<div class="kv"><div><span>Median</span><b class="num">' + esc(full$(s.p50)) + '</b></div><div><span>Middle half</span><b class="num">' + esc(k$(s.p25)) + ' – ' + esc(k$(s.p75)) + '</b></div><div><span>Sample</span><b class="num">' + esc(s.n) + '</b></div></div>';
    };
    var stateLab = function (r) { return esc(STATE_NAME[r.state] || r.state || '—'); };
    var trend = c.posted.recent && c.posted.prior && c.posted.recent.p50 && c.posted.prior.p50 && c.posted.prior.n >= th
      ? '<p class="small muted">Last 30 days: median ' + esc(k$(c.posted.recent.p50)) + ' across ' + esc(plural(c.posted.recent.n, 'posting')) + ', against ' + esc(k$(c.posted.prior.p50)) + ' before.</p>' : '';
    return '<article class="card comp"><h2>' + esc(c.title) + '</h2><p class="small muted">Role compared as “' + esc(c.titleNorm) + '”, every grade together. Annual base pay, USD.</p>' +
      '<div class="srcblock"><h3>Posted ranges</h3><p class="src">Pay ranges in job postings on public career boards, last 12 months (midpoint of each range)</p>' + headline(c.posted.all, ['posting', 'postings']) + trend +
        (c.posted.byState.length ? '<h4 class="small" style="margin:10px 0 0">By state</h4>' + rangeRows(c.posted.byState, stateLab, lo, hi, th) : '') +
        (c.posted.byQuarter.length ? '<h4 class="small" style="margin:12px 0 0">Over time</h4>' + rangeRows(c.posted.byQuarter, function (r) { return esc(r.quarter); }, lo, hi, th) : '') + '</div>' +
      '<div class="srcblock"><h3>H-1B filings</h3><p class="src">Wages employers offered on certified, full-time Labor Condition Applications (US Department of Labor), last 3 fiscal years</p>' + headline(c.h1b.all, ['filing', 'filings']) +
        (c.h1b.byState.length ? '<h4 class="small" style="margin:10px 0 0">By state</h4>' + rangeRows(c.h1b.byState, stateLab, lo, hi, th) : '') +
        (c.h1b.byCity.length ? '<h4 class="small" style="margin:12px 0 0">By city</h4>' + rangeRows(c.h1b.byCity, function (r) { return esc(r.city) + (r.state ? ', ' + esc(r.state) : ''); }, lo, hi, th) : '') +
        (c.h1b.byYear.length ? '<h4 class="small" style="margin:12px 0 0">Over time</h4>' + rangeRows(c.h1b.byYear, function (r) { return 'FY' + esc(r.year); }, lo, hi, th) : '') + '</div>' +
      (c.oews ? '<div class="srcblock"><h3>Occupation benchmark</h3><p class="src">BLS Occupational Employment and Wage Statistics, ' + esc(c.oews.year) + ': ' + esc(c.oews.occupation) + ' (SOC ' + esc(c.oews.soc) + ') - all employers, every level</p>' +
        (c.oews.national ? '<div class="kv"><div><span>US median</span><b class="num">' + esc(full$(c.oews.national.p50)) + '</b></div><div><span>Middle half</span><b class="num">' + esc(k$(c.oews.national.p25)) + ' – ' + esc(k$(c.oews.national.p75)) + '</b></div>' + (c.oews.national.employment ? '<div><span>Employed</span><b class="num">' + esc(Number(c.oews.national.employment).toLocaleString('en-US')) + '</b></div>' : '') + '</div>' : '') +
        (c.oews.byState.length ? rangeRows(c.oews.byState.map(function (r) { return { state: r.state, n: null, employment: r.employment, p25: r.p25, p50: r.p50, p75: r.p75, enough: Boolean(r.p50) }; }), stateLab, lo, hi, 0) : '') + '</div>' : '') +
      (sample ? '<p class="small muted" style="margin-top:12px">Example figures - made up.</p>' : '') + '</article>';
  }

  function drawComp(el, d) {
    var list = d.comps || [];
    if (!list.length) {
      el.innerHTML = '<div class="card empty"><h2>No target titles yet</h2><p class="muted">Add the titles you are aiming for and their pay shows here: posted ranges, H-1B filings and the BLS benchmark.</p><button class="btn" id="goSetup" type="button">Add target titles</button></div>';
      $('#goSetup').onclick = function () { startSetup(2); };
      return;
    }
    el.innerHTML = '<p class="small muted">Three public sources, never mixed: what postings say, what H-1B filings show employers offering, and the government’s occupation benchmark. A figure appears only with ' + esc(list[0].threshold || 10) + ' or more data points behind it.</p><div class="comp-cols">' + list.map(function (c) { return compCard(c, d.sample); }).join('') + '</div>';
  }

  /* ---------------- This week ---------------- */

  function drawWeek(el, d) {
    var g = d.digest;
    if (!g) { el.innerHTML = '<div class="card empty"><p class="muted">Your week builds as matches arrive.</p></div>'; return; }
    var c = g.counts || {};
    var types = c.byType || {};
    el.innerHTML = '<div class="week week-cols"><div>' +
      '<div class="card"><h2>This week</h2><div class="big3"><div><b class="num">' + esc(c.fits || 0) + '</b><span>matches scored</span></div><div><b class="num">' + esc(c.strong || 0) + '</b><span>strong fits</span></div><div><b class="num">' + esc(c.events || 0) + '</b><span>company events</span></div></div>' +
      (g.costUsd ? '<p class="small muted" style="margin-top:8px">Scoring cost $' + esc(Number(g.costUsd).toFixed(2)) + ' of AI credit this week.</p>' : '') + '</div>' +
      '<div class="card"><h2>Best matches</h2>' + ((g.topFits || []).length ? '<ul class="fitlist">' + g.topFits.map(function (f) { return rowHtml(f, true); }).join('') + '</ul>' : '<p class="muted">No matches this week yet.</p>') + '</div></div><div>' +
      '<div class="card"><h2>Pay moves</h2>' + ((g.compMoves || []).length ? '<ul class="plain">' + g.compMoves.map(function (m) { return '<li><b>' + esc(m.title) + '</b>: posted median ' + esc(k$(m.recent)) + ', ' + (m.pct >= 0 ? 'up ' : 'down ') + esc(Math.abs(m.pct)) + '% on ' + esc(k$(m.prior)) + ' before <span class="src">(' + esc(m.nRecent) + ' vs ' + esc(m.nPrior) + ' postings)</span></li>'; }).join('') + '</ul>' : '<p class="muted">Not enough new postings with pay this month to call a move.</p>') + '</div>' +
      '<div class="card"><h2>At your companies</h2>' + (Object.keys(types).length ? '<p class="row">' + Object.keys(types).map(function (t) { return '<span class="badge e-' + esc(t) + '">' + esc(({ layoff: 'Layoffs', exec_change: 'Leadership', acquisition: 'Deals', funding: 'Funding', earnings: 'Earnings', other: 'News' })[t] || 'News') + ' ' + esc(types[t]) + '</span>'; }).join('') + '</p>' : '') +
      ((g.events || []).length ? '<ul class="plain">' + g.events.map(function (e) { var h = safeHref(e.url); return '<li><span class="badge e-' + esc(e.type) + '">' + esc(e.typeLabel) + '</span> <span class="src">' + esc(ago(e.at)) + '</span><br>' + (h ? '<a href="' + esc(h) + '" target="_blank" rel="noopener noreferrer">' + esc(e.headline) + '</a>' : esc(e.headline)) + '</li>'; }).join('') + '</ul>' : '<p class="muted">Quiet week.</p>') + '</div>' +
      '<p class="small muted">' + (d.sample ? 'Example week - made up.' : 'A digest is built every Sunday; email delivery is coming.') + '</p></div></div>';
    $$('[data-fit]', el).forEach(function (b) { b.onclick = function () { openFit(findWeekFit(g, b.getAttribute('data-fit')), d); }; });
  }
  function findWeekFit(g, id) { var l = g.topFits || []; for (var i = 0; i < l.length; i++) if (l[i].postingId === id) return l[i]; return null; }

  /* ---------------- set-up ---------------- */

  function startSetup(step) {
    if (!signedIn()) return openAccount('Create a free account to set up your own.', function () { startSetup(step); });
    closeSheet();
    var p = state.profile || {};
    state.setup = {
      step: step || 1,
      how: p.background && (p.background.headline || (p.background.skills || []).length) ? 'type' : 'paste',
      background: JSON.parse(JSON.stringify(p.background || { headline: '', summary: '', skills: [], roles: [], industries: [], education: [] })),
      targets: JSON.parse(JSON.stringify(p.targets || { titles: [], seniority: null, locations: [], remote: 'remote_ok', compFloor: null })),
      watchlist: (p.watchlist || []).slice(),
      extracted: false,
    };
    state.mode = 'setup';
    render();
    window.scrollTo(0, 0);
  }

  function drawSetup() {
    var st = state.setup;
    var el = $('#view');
    el.removeAttribute('role');
    var steps = '<ol class="steps" aria-label="Step ' + st.step + ' of 3">' + [1, 2, 3].map(function (i) { return '<li class="' + (i <= st.step ? 'on' : '') + '"></li>'; }).join('') + '</ol>';
    var nav = '<div class="row spread" style="margin-top:16px">' + (st.step > 1 ? '<button class="btn ghost" id="back" type="button">Back</button>' : (state.profile && state.profile.onboarded ? '<button class="btn ghost" id="cancel" type="button">Cancel</button>' : '<button class="btn ghost" id="cancel" type="button">See the example</button>')) +
      '<button class="btn" id="next" type="button">' + (st.step < 3 ? 'Next' : 'Done - show my matches') + '</button></div><div id="setupErr"></div>';
    if (st.step === 1) el.innerHTML = '<div class="card">' + steps + '<h2>Your background</h2><p class="muted">What Next Move scores each role against. Paste your resume or upload it to have it read for you (a cent or two of AI credit), or type it in.</p>' + bgHtml(st) + nav + '</div>';
    else if (st.step === 2) el.innerHTML = '<div class="card">' + steps + '<h2>What you are aiming for</h2>' + targetsHtml(st.targets) + nav + '</div>';
    else el.innerHTML = '<div class="card">' + steps + '<h2>Companies to watch</h2><p class="muted">Type a company name, or paste its careers page link (Greenhouse, Lever and Ashby boards are read directly). Roles matching your titles at other companies are scored too.</p>' + watchHtml(st) + nav + '</div>';
    wireSetup(el, st);
  }

  function bgHtml(st) {
    var b = st.background;
    var seg = function (k, l) { return '<button class="chip" type="button" aria-pressed="' + (st.how === k) + '" data-how="' + k + '">' + l + '</button>'; };
    var form = '<label class="field"><span>Headline</span><input class="input" id="bgHeadline" maxlength="160" value="' + esc(b.headline) + '" placeholder="e.g. Director of Analytics, healthcare"></label>' +
      '<label class="field"><span>Summary</span><textarea class="input" id="bgSummary" maxlength="1200" placeholder="A few sentences on your experience and results.">' + esc(b.summary) + '</textarea></label>' +
      '<label class="field"><span>Skills</span><input class="input" id="bgSkills" value="' + esc((b.skills || []).join(', ')) + '" placeholder="SQL, forecasting, team leadership"><small>Comma-separated. These are matched against each posting.</small></label>' +
      '<label class="field"><span>Roles</span><textarea class="input" id="bgRoles" placeholder="Director of Analytics, Example Health, 4 years">' + esc((b.roles || []).map(function (r) { return [r.title, r.company, r.years ? r.years + ' years' : ''].filter(Boolean).join(', ') + (r.highlights ? ' - ' + r.highlights : ''); }).join('\n')) + '</textarea><small>One per line: title, company, years - and a result after a dash.</small></label>' +
      '<label class="field"><span>Years of experience</span><input class="input" id="bgYears" inputmode="numeric" value="' + esc(b.yearsExperience || '') + '"></label>';
    var input = st.how === 'paste'
      ? '<label class="field"><span>Paste your resume</span><textarea class="input" id="resumeText" placeholder="Paste the text of your resume here."></textarea><small>Read once and not kept - only the background below is saved.</small></label><button class="btn ghost" id="readText" type="button">Read it for me</button>'
      : st.how === 'pdf'
        ? '<label class="field"><span>Upload your resume (PDF)</span><input class="input" id="resumeFile" type="file" accept="application/pdf"><small>Read once and not kept. Up to 8 MB.</small></label><button class="btn ghost" id="readPdf" type="button">Read it for me</button>'
        : '';
    return '<div class="seg" role="group" aria-label="How to add your background">' + seg('paste', 'Paste resume') + seg('pdf', 'Upload PDF') + seg('type', 'Type it') + '</div>' + input + '<div id="readMsg"></div>' +
      (st.how === 'type' || st.extracted || b.headline ? '<div id="bgForm" style="margin-top:14px">' + (st.extracted ? '<p class="note small">Read from your resume - check it and change anything. Contact details are never kept.</p>' : '') + form + '</div>' : '');
  }

  function targetsHtml(t) {
    var r = function (v, l) { return '<label class="radio"><input type="radio" name="remote" value="' + v + '"' + (t.remote === v ? ' checked' : '') + '> ' + l + '</label>'; };
    return '<label class="field"><span>Titles you are aiming for</span><textarea class="input" id="tTitles" style="min-height:96px" placeholder="Director of Analytics&#10;Head of Data">' + esc((t.titles || []).join('\n')) + '</textarea><small>One per line, up to 5. Similar titles match too.</small></label>' +
      '<label class="field"><span>Level</span><select class="input" id="tLevel">' + SENIORITY.map(function (s) { return '<option value="' + s[0] + '"' + ((t.seniority || '') === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>Locations</span><input class="input" id="tLocs" value="' + esc((t.locations || []).join('; ')) + '" placeholder="Atlanta, GA; New York, NY"><small>Separate with semicolons.</small></label>' +
      '<fieldset class="field" style="border:0;padding:0;margin:0 0 12px"><legend style="font-weight:650;font-size:.92rem;margin-bottom:4px;padding:0">Remote</legend>' + r('remote_ok', 'Remote or my locations') + r('remote_only', 'Remote only') + r('onsite_only', 'On site in my locations') + '</fieldset>' +
      '<label class="field"><span>Pay floor (annual base, USD)</span><input class="input" id="tFloor" inputmode="numeric" value="' + esc(t.compFloor || '') + '" placeholder="185000"><small>Roles posting less are ranked down; roles posting no pay are not.</small></label>';
  }

  function watchHtml(st) {
    return '<div class="row" style="align-items:stretch"><label class="vh" for="coInput">Company or careers link</label><input class="input" id="coInput" style="flex:1 1 220px" placeholder="Stripe, or https://jobs.lever.co/…"><button class="btn" id="coAdd" type="button">Add</button></div><div id="coMsg" aria-live="polite"></div>' +
      (st.watchlist.length ? '<ul class="watch">' + st.watchlist.map(function (w) {
        return '<li><span class="who"><b>' + esc(w.name) + '</b><span class="small muted">' + (w.provider ? esc(PROVIDER[w.provider]) + ' board found' + (w.openCount !== null && w.openCount !== undefined ? ' · ' + esc(w.openCount) + ' open roles' : '') : 'No public careers board found - filings and news only') + '</span></span><button class="btn small ghost" type="button" data-rm="' + esc(w.companyKey) + '" aria-label="Stop watching ' + esc(w.name) + '">Remove</button></li>';
      }).join('') + '</ul>' : '<p class="small muted" style="margin-top:10px">Nothing yet. Five to fifteen companies is a good start.</p>');
  }

  function readBgForm(st) {
    if (!$('#bgForm')) return;
    var b = st.background;
    b.headline = $('#bgHeadline').value;
    b.summary = $('#bgSummary').value;
    b.skills = $('#bgSkills').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    b.yearsExperience = Number($('#bgYears').value) || null;
    b.roles = $('#bgRoles').value.split(/\n+/).map(function (line) {
      var parts = line.split(' - ');
      var bits = parts[0].split(',').map(function (s) { return s.trim(); });
      var years = bits[2] ? parseFloat(bits[2]) : null;
      return { title: bits[0] || '', company: bits[1] || '', years: isFinite(years) ? years : null, highlights: parts.slice(1).join(' - ').trim() };
    }).filter(function (r) { return r.title; });
  }
  function readTargets(st) {
    st.targets.titles = $('#tTitles').value.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    st.targets.seniority = $('#tLevel').value || null;
    st.targets.locations = $('#tLocs').value.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
    var r = $('input[name=remote]:checked');
    st.targets.remote = r ? r.value : 'remote_ok';
    st.targets.compFloor = $('#tFloor').value;
  }

  function wireSetup(el, st) {
    var err = $('#setupErr', el);
    var back = $('#back', el), cancel = $('#cancel', el);
    if (back) back.onclick = function () { if (st.step === 1) return; if (st.step === 2) readTargets(st); st.step--; drawSetup(); window.scrollTo(0, 0); };
    if (cancel) cancel.onclick = function () { state.mode = state.profile && state.profile.onboarded ? 'live' : 'sample'; render(); };
    $$('[data-how]', el).forEach(function (b) { b.onclick = function () { readBgForm(st); st.how = b.getAttribute('data-how'); drawSetup(); }; });
    var rt = $('#readText', el);
    if (rt) rt.onclick = function () { readResume({ text: $('#resumeText').value }, rt); };
    var rp = $('#readPdf', el);
    if (rp) rp.onclick = function () {
      var f = $('#resumeFile').files[0];
      if (!f) return showError(new Error('Choose a PDF first.'), $('#readMsg'));
      if (f.size > 8 * 1024 * 1024) return showError(new Error('That PDF is over 8 MB. Paste the text instead.'), $('#readMsg'));
      var r = new FileReader();
      r.onload = function () { readResume({ pdf: { data: String(r.result).split(',')[1] || '' } }, rp); };
      r.readAsDataURL(f);
    };
    var add = $('#coAdd', el);
    if (add) {
      var go = function () {
        var v = $('#coInput').value.trim();
        if (!v) return;
        add.disabled = true; $('#coMsg').innerHTML = '<p class="small muted">Looking for ' + esc(v) + '’s careers board…</p>';
        api('POST', 'api/watchlist', { input: v }).then(function (r) {
          st.watchlist.push(r.added);
          state.profile = null;
          drawSetup();
          $('#coMsg').innerHTML = '<p class="small">' + esc(r.message) + '</p>';
          $('#coInput').focus();
        }).catch(function (e) { add.disabled = false; showError(e, $('#coMsg')); });
      };
      add.onclick = go;
      $('#coInput').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    }
    $$('[data-rm]', el).forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-rm');
        b.disabled = true;
        api('DELETE', 'api/watchlist/' + encodeURIComponent(k), {}).then(function () {
          st.watchlist = st.watchlist.filter(function (w) { return w.companyKey !== k; });
          drawSetup();
        }).catch(function (e) { b.disabled = false; showError(e); });
      };
    });
    $('#next', el).onclick = function () {
      var btn = this;
      if (st.step === 1) {
        readBgForm(st);
        var b = st.background;
        if (!b.headline && !b.summary && !(b.skills || []).length && !(b.roles || []).length) return showError(new Error('Add your background first - paste, upload or type it.'), err);
        st.step = 2; drawSetup(); window.scrollTo(0, 0); return;
      }
      if (st.step === 2) {
        readTargets(st);
        if (!st.targets.titles.length) return showError(new Error('Add at least one title you are aiming for.'), err);
        btn.disabled = true;
        api('PUT', 'api/profile', { background: st.background, targets: st.targets }).then(function (r) {
          state.profile = r.profile; st.step = 3; drawSetup(); window.scrollTo(0, 0);
        }).catch(function (e) { btn.disabled = false; showError(e, err); });
        return;
      }
      state.mode = 'live';
      state.fits = state.companies = state.comps = state.digest = null;
      state.tab = st.watchlist.length ? 'today' : 'companies';
      loadProfile().then(function () { return loadTab(state.tab, true); }).then(render);
      render();
    };
  }

  function readResume(body, btn) {
    var st = state.setup;
    var msg = $('#readMsg');
    btn.disabled = true; btn.textContent = 'Reading…';
    msg.innerHTML = '<p class="small muted">Reading your resume - this takes a few seconds.</p>';
    api('POST', 'api/profile/extract', body).then(function (r) {
      st.background = r.background; st.extracted = true; st.how = 'type';
      if (r.suggested) {
        if (!st.targets.titles.length && r.suggested.titles) st.targets.titles = r.suggested.titles.slice(0, 3);
        if (!st.targets.seniority && r.suggested.seniority) st.targets.seniority = r.suggested.seniority;
      }
      drawSetup();
      toast('Read. Check your background below.');
    }).catch(function (e) { btn.disabled = false; btn.textContent = 'Read it for me'; showError(e, msg); });
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" id="sheetClose" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    $('#sheetClose').onclick = closeSheet;
    back.onclick = closeSheet;
    if (onOpen) onOpen(s);
    var f = s.querySelector('input:not([type=hidden]), textarea') || s.querySelector('button:not(.close)') || $('#sheetClose');
    setTimeout(function () { try { if (f) f.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  function openHow() {
    sheet('<h2>How Next Move works</h2><ol>' +
      '<li><b>You set it up once:</b> your background (pasted, uploaded or typed), the titles you want, and the companies you would move to.</li>' +
      '<li><b>Every day</b> it reads those companies’ public career boards, SEC filings and the news, and ranks every new role against you - for free.</li>' +
      '<li><b>The best few</b> are scored by AI against your background: a score, the posting’s own words for why, the gaps, and how to position yourself. A few cents each, from your AI credit.</li>' +
      '<li><b>Every week</b> a web search looks for roles the boards missed, and your week is summed up - plus what the pay data says for your titles.</li></ol>' +
      '<p class="small muted">Free accounts get 3-5 scored matches a day on Haiku; members get up to 20 on Sonnet. Pay data comes from postings, H-1B filings and BLS - never from LinkedIn, Indeed or Glassdoor, which are never scraped.</p>');
  }

  function openPrivacy() {
    sheet('<h2>How your data is kept</h2>' +
      '<p><b>Your background</b> - pasted, uploaded or typed - is stored only in your Next Move profile, under your account. An uploaded resume is read once by the AI and not kept; contact details in it are never saved.</p>' +
      '<p><b>Your matches</b> are stored with a keyed code in place of your account - never your name, email or account id - beside the public postings, filings and pay data they were scored against.</p>' +
      '<p><b>Nothing is shared</b>, and nothing about you is logged. Postings, filings and pay data are public records.</p>' +
      '<p><b>Delete</b> from your Account removes your profile, your weekly digests and every match score. Your sign-in account itself covers every app on this site and is deleted separately.</p>' +
      '<p class="small"><a href="https://strongtechnicalconsulting.com/privacy">The full privacy policy</a></p>');
  }

  var FREE_LINE = 'The example works with no account. A free account sets up your own and comes with $2 of AI credit; a day of scoring costs a few cents. One account works across every app on this site.';
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
        '<p class="small muted" style="margin-top:12px;text-align:center">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).onclick = function () { mode = mode === 'register' ? 'login' : 'register'; draw(root); };
      $('#authForm', root).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return afterSignIn(); }).then(function () { toast('You’re in.'); if (then && state.mode !== 'live') then(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return afterSignIn(); }).then(function () { if (then && state.mode !== 'live') then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      };
    }
    sheet('<div class="body"></div>', draw);
  }

  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(
      '<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member: up to 20 scored matches a day, Sonnet' : 'free: up to 5 scored matches a day, Haiku') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div>' +
      '<p class="small muted" style="margin:6px 0 0">Each scored match costs about a cent; reading a resume one or two. The ranking, companies, pay data and digest are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>' +
      '<div class="note" style="margin-top:18px"><b>Delete my Next Move data</b><p class="small muted" style="margin:4px 0 10px">Removes your profile, background, watchlist, weekly digests and every match score. Your sign-in account stays.</p><button class="btn small danger" id="delData" type="button">Delete my data</button><div id="delMsg"></div></div>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.mode = 'sample'; state.profile = null; render(); });
        };
        var pk = $('#pkEnrol', root);
        if (pk) pk.onclick = function () {
          var pw = window.prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        };
        $('#delData', root).onclick = function () {
          var btn = this;
          if (btn.getAttribute('data-sure') !== '1') { btn.setAttribute('data-sure', '1'); btn.textContent = 'Tap again to delete everything'; return; }
          btn.disabled = true;
          api('DELETE', 'api/me', { confirm: 'delete' }).then(function (r) {
            closeSheet();
            toast('Deleted: your profile, ' + plural(r.digestsDeleted, 'digest') + ' and ' + plural(r.fitsDeleted, 'match score') + '.', 5000);
            state.profile = null; state.fits = state.companies = state.comps = state.digest = null; state.mode = 'sample';
            return loadMe().then(render);
          }).catch(function (e) { btn.disabled = false; showError(e, $('#delMsg', root)); });
        };
      });
  }
  function drawBilling(el) {
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(safeHref(b.elsewhere)) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" type="button" id="joinM" style="margin-top:10px">Become a member · $' + esc(b.monthlyUsd) + '/mo</button><p class="small muted">Membership covers every app on this site, runs the better model and lets you add credit.</p>';
        $('#joinM', el).onclick = function () { checkout('api/auth/billing/membership', {}); };
        return;
      }
      el.innerHTML = '<div class="row" style="margin-top:10px">' + (b.topUps || []).map(function (t) { return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) { btn.onclick = function () { checkout('api/auth/billing/credit', { usd: Number(btn.getAttribute('data-usd')) }); }; });
    }).catch(function () { el.innerHTML = ''; });
  }
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(d) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((d && d.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Your companies, pay data and digest keep working, free. Daily scoring resumes when you add credit.</p><div id="billing"></div>' +
      (d && d.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(safeHref(d.topUpUrl) || d.topUpUrl.replace(/[^?=&a-z0-9]/gi, '')) + '">Top up</a></p>' : ''),
    function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- start ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; return me; })
      .catch(function () { state.me = { signedIn: false }; return state.me; });
  }
  function loadProfile() {
    return api('GET', 'api/profile').then(function (r) { state.profile = r.profile; state.nextRun = r.nextRun; return r.profile; });
  }
  function afterSignIn() {
    return loadMe().then(function () {
      if (!signedIn()) { render(); return null; }
      return loadProfile().then(function (p) {
        if (p.onboarded) {
          state.mode = 'live';
          state.fits = state.companies = state.comps = state.digest = null;
          render();
          return loadTab(state.tab, true).then(render);
        }
        render();
        return null;
      });
    }).catch(function () { render(); });
  }

  var saved = recall(K_TAB);
  if (saved && TABS.some(function (t) { return t[0] === saved; })) state.tab = saved;
  render();
  afterSignIn().then(function () {
    if (signedIn() && /[?&](topup|member|credited)=1\b/.test(location.search)) openSettings();
  });
  if (WIDE.addEventListener) WIDE.addEventListener('change', function () { if (state.mode !== 'setup') drawView(); });
})();
