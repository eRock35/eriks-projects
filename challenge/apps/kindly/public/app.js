/* Kindly - the page. One file, no build step. Every string that came from
 * outside this file (a typed name, a note, an idea, a friend's wishlist
 * addition, a model's answer, anything from the server) is escaped before it
 * is drawn, and no handler is written into markup: clicks are routed by
 * data-act attributes from one listener (the lab's CSP allows script from
 * this origin only). The rules - the dates, ages and milestones, Coming up,
 * the no-repeat check, budgets, the calendar file - are kindly-core.js, the
 * same file the server and the tests run.
 *
 * Views (tabs): coming (the next 60 days), people (everyone), ideas (every
 * open idea, what is bought and waiting, what was given). No people yet: the
 * first run. A wishlist link (w/<token>) draws only the friend's page.
 *
 * Where things live: the circle in localStorage (kindly-people-v1), the
 * settings in kindly-settings-v1, the tab in kindly-tab-v1. Signed in, the
 * circle is also kept in the account.
 */
(function () {
  'use strict';

  var C = window.KindlyCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_PEOPLE = 'kindly-people-v1';
  var K_SET = 'kindly-settings-v1';
  var K_TAB = 'kindly-tab-v1';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TABS = ['coming', 'people', 'ideas'];
  var LEADS = [3, 5, 7, 10, 14, 21, 30, 45, 60];
  var SHIPS = [2, 3, 5, 7, 10, 14];
  var FRIEND = (function () {
    var rel = location.pathname.indexOf(BASE) === 0 ? location.pathname.slice(BASE.length) : '';
    var m = /^w\/([A-Za-z0-9_-]{22})$/.exec(rel);
    return m ? m[1] : null;
  }());

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() { return C.localDay(new Date()); }
  function money(c) { return C.fmtMoney(c); }
  function fmt(day) { return C.fmtDay(day, today()); }
  var plural = C.plural;
  function newId(p) { var a = new Uint8Array(9); crypto.getRandomValues(a); return p + Array.prototype.map.call(a, function (x) { return x.toString(36).padStart(2, '0'); }).join('').slice(0, 15); }

  var state = {
    me: null,
    people: [],
    tab: 'coming',
    q: '',              // the People search
    settings: { shipDays: 5 },
    form: null,         // the add / edit person form
    ai: null,           // the gift-ideas sheet
    openId: null,       // the person whose sheet is open
    armed: null,        // a delete waiting for its second tap
  };
  var main = $('#main');

  /* ---------------- plumbing ---------------- */

  function api(method, path, body, headers) {
    var h = {};
    if (body) h['Content-Type'] = 'application/json';
    for (var k in headers || {}) h[k] = headers[k];
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
  function byId(id) { for (var i = 0; i < state.people.length; i++) if (state.people[i].id === id) return state.people[i]; return null; }
  function hasSample() { return state.people.some(function (p) { return p.sample; }); }
  function copyOf(p) { return JSON.parse(JSON.stringify(p)); }
  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Your own ideas work meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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
  function confetti() {
    if (REDUCED) return;
    var box = document.createElement('div');
    box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var colours = ['#a3214a', '#5b2a86', '#f6c46a', '#17703a', '#ff8fab', '#2b4c9f'];
    for (var i = 0; i < 46; i++) {
      var p = document.createElement('i');
      p.style.left = (Math.random() * 100) + 'vw';
      p.style.background = colours[i % colours.length];
      p.style.animationDelay = (Math.random() * 0.5) + 's';
      p.style.transform = 'rotate(' + Math.round(Math.random() * 180) + 'deg)';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3200);
  }

  /* ---------------- this phone's circle ---------------- */

  function loadLocal() {
    var raw = recall(K_PEOPLE);
    var list = raw && Array.isArray(raw.people) ? raw.people : [];
    var t = today();
    state.people = list.map(function (p) { return C.cleanPerson(p, t, { keepSample: true }); }).filter(Boolean).slice(0, C.LIMITS.people);
    var s = recall(K_SET);
    if (s && typeof s === 'object' && SHIPS.indexOf(s.shipDays) >= 0) state.settings.shipDays = s.shipDays;
    var tab = recall(K_TAB);
    if (TABS.indexOf(tab) >= 0) state.tab = tab;
  }
  function saveLocal() { keep(K_PEOPLE, { v: 1, people: state.people }); }
  function syncFail(e) { if (e && e.status === 401) return; toast((e && e.message) || 'Could not save to your account - it is still on this phone.'); }
  function pushPerson(p) { if (!syncOn() || p.sample) return; api('PUT', 'api/people/' + p.id, { person: C.toSaved(p), today: today() }).catch(syncFail); }
  function dropPerson(id) { if (!syncOn() || /^sample/.test(id)) return; api('DELETE', 'api/people/' + id).catch(syncFail); }
  /** Save one person here (and in the account), cleaned the same way the
   *  server will clean it. */
  function savePerson(p, msg) {
    p.updatedAt = Date.now();
    var clean = C.cleanPerson(p, today(), { keepSample: true });
    if (!clean) return null;
    var i = state.people.findIndex(function (x) { return x.id === clean.id; });
    if (i >= 0) state.people[i] = clean; else state.people.push(clean);
    saveLocal(); pushPerson(clean);
    if (msg) { toast(msg); say(msg); }
    return clean;
  }
  /** Signed in: bring this phone's circle into the account (newer copy
   *  wins), then show what the account holds. */
  function syncIn(announce) {
    if (!syncOn()) return Promise.resolve();
    var mine = state.people.filter(function (p) { return !p.sample; });
    return api('POST', 'api/people/merge', { people: mine.map(C.toSaved), today: today() }).then(function (r) {
      var t = today();
      var server = (r.people || []).map(function (p) { return C.cleanPerson(p, t); }).filter(Boolean);
      var samples = server.length ? [] : state.people.filter(function (p) { return p.sample; });
      state.people = samples.concat(server);
      saveLocal();
      if (announce) toast(server.length ? 'Your circle now follows you to any phone you sign in on.' : 'Signed in. People you add now follow you to your other phones.');
      draw();
    }).catch(function (e) { if (e.status !== 401) toast(e.message); });
  }

  /* ---------------- small drawing helpers ---------------- */

  function av(p, big) { return '<span class="av r-' + esc(p.relationship) + (big ? ' big' : '') + '" aria-hidden="true">' + esc(C.initials(p.name)) + '</span>'; }
  function cdTile(o) {
    if (o.inDays === 0) return '<div class="cd today" aria-hidden="true"><span class="e">' + esc(o.emoji) + '</span><small>Today</small></div>';
    return '<div class="cd' + (o.nudge ? ' soon' : '') + '" aria-hidden="true"><b>' + o.inDays + '</b><small>' + (o.inDays === 1 ? 'day' : 'days') + '</small></div>';
  }
  function chipsFor(o) {
    var st = C.stageOf(o, today());
    var out = '';
    if (o.milestone) out += '<span class="chip mile">★ ' + esc(capital(o.milestone.words)) + '</span>';
    else if (o.n !== null && o.kind === 'birthday') out += '<span class="chip">Turns ' + o.n + '</span>';
    else if (o.n !== null) out += '<span class="chip">' + esc(plural(o.n, 'year')) + '</span>';
    out += '<span class="chip ' + esc(st.id) + '">' + esc(st.words) + '</span>';
    if (o.ideas && st.id !== 'ready') out += '<span class="chip info">' + esc(plural(o.ideas, 'idea')) + '</span>';
    return out;
  }
  function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function budgetLine(o) {
    var w = C.budgetWords(o);
    if (!w) return '';
    var meter = '';
    if (o.budget) {
      var pct = Math.min(100, Math.round((o.spent / o.budget) * 100));
      meter = '<span class="meter' + (o.spent > o.budget ? ' over' : '') + '" aria-hidden="true"><i style="width:' + pct + '%"></i></span>';
    }
    return '<div class="budget-line">' + meter + '<span>' + esc(w) + '</span></div>';
  }
  function occasionsFor(p) { return C.occasionsOf(p, today(), { shipDays: state.settings.shipDays }); }

  /* ---------------- the views ---------------- */

  function draw() {
    if (FRIEND) return;
    var any = state.people.length > 0;
    $('#tabbar').hidden = !any;
    $('#topAdd').hidden = !any;
    $$('#tabbar [data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (!any) { main.innerHTML = firstRun(); return; }
    var html = sampleStrip();
    if (state.tab === 'people') html += peopleView();
    else if (state.tab === 'ideas') html += ideasView();
    else html += comingView();
    main.innerHTML = html;
  }

  function firstRun() {
    return '<section class="first">' +
      '<div><div class="hero">' +
      '<p class="eyebrow">Birthdays, dates and gift ideas</p>' +
      '<h1>Never miss the people who matter, <em>and always know what to give.</em></h1>' +
      '<p class="lede">Every birthday, anniversary and gotcha day in one place, a nudge when it’s time to shop, and the gift ideas you hear all year - kept, so the scarf from July is still there in December and never given twice.</p></div>' +
      '<div class="choices">' +
      '<button class="choice primary" type="button" data-act="sample"><span class="ci" aria-hidden="true">🎁</span><span class="ct"><b>Try a sample circle</b><span>Eight made-up people with dates around today. Nothing is saved anywhere.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '<button class="choice" type="button" data-act="addperson"><span class="ci" aria-hidden="true">＋</span><span class="ct"><b>Add my first person</b><span>A name and a birthday. Fifteen seconds.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      '</div>' +
      '<div class="promise"><span class="ic" aria-hidden="true">🔒</span><div><b>Stays on your phone.</b><p>No account, no contacts upload, no ads. Nothing leaves this phone unless you send someone a wishlist link, sign in to sync, or ask AI for ideas - and AI never gets their name.</p></div></div>' +
      '</div>' +
      '<div><div class="mock" aria-hidden="true"><span class="mock-flag">★ Turns 40</span>' +
      '<div class="mock-head"><b>Coming up</b><span>next 60 days</span></div>' +
      '<div class="mock-row"><div class="cd soon"><b>4</b><small>days</small></div><span><b>🎂 Maya’s birthday</b><small>Gift ready · $34 of $60</small></span></div>' +
      '<div class="mock-row"><div class="cd"><b>11</b><small>days</small></div><span><b>🐾 Biscuit’s gotcha day</b><small>Order by Oct 28 to arrive</small></span></div>' +
      '<div class="mock-row"><div class="cd"><b>33</b><small>days</small></div><span><b>🎂 Priya’s birthday</b><small>Turns 40 · 2 ideas saved</small></span></div></div>' +
      '<h2 class="how-title">How it works</h2><ol class="how">' +
      '<li><span class="n" aria-hidden="true">🗓️</span><div><b>Add the people and their dates</b><p>Birthdays (with or without the year), anniversaries, any day that matters. Born on Feb 29? Pick Feb 28 or Mar 1.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">💡</span><div><b>Save ideas the moment you hear them</b><p>One tap on a person. A link and a price if you have them. Kindly warns you if it looks like something you gave before.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">⏰</span><div><b>Get nudged in time</b><p>Each person has a lead time, so you hear about it while you can still order - “order by Oct 26 to arrive”.</p></div></li>' +
      '<li><span class="n" aria-hidden="true">📅</span><div><b>Put the dates in your calendar</b><p>One file, every date repeating yearly, with the reminder at each person’s lead time.</p></div></li>' +
      '</ol></div></section>';
  }

  function sampleStrip() {
    if (!hasSample()) return '';
    return '<div class="strip" role="note"><p><b>🧪 A sample circle.</b> Made-up people, dates and gifts to play with - nothing is saved anywhere.</p>' +
      '<div class="row"><button class="btn small" type="button" data-act="mine">Start my own</button><button class="btn small ghost" type="button" data-act="clearsample">Clear the sample</button></div></div>';
  }

  function comingRow(o) {
    var p = byId(o.id);
    if (!p) return '';
    return '<div class="crow' + (o.milestone ? ' is-mile' : '') + '">' + cdTile(o) +
      '<div><button class="open" type="button" data-act="open" data-id="' + esc(p.id) + '"><span class="t">' + esc(o.emoji) + ' ' + esc(o.title) + '</span>' +
      '<span class="w">' + esc(C.whenWords(o, today())) + '</span></button>' +
      '<div class="chips">' + chipsFor(o) + '</div>' + budgetLine(o) +
      '<div class="row acts"><button class="btn small soft" type="button" data-act="quickidea" data-id="' + esc(p.id) + '">+ Idea</button>' +
      '<button class="btn small ghost" type="button" data-act="ai" data-id="' + esc(p.id) + '" data-key="' + esc(o.key) + '">✨ Ideas for them</button></div></div></div>';
  }
  function comingView() {
    var t = today();
    var up = C.upcoming(state.people, t, { shipDays: state.settings.shipDays });
    var week = up.filter(function (o) { return o.inDays <= 7; });
    var month = up.filter(function (o) { return o.inDays > 7 && o.inDays <= 31; });
    var later = up.filter(function (o) { return o.inDays > 31; });
    var left = '<div class="page-title"><h1>Coming up</h1><span class="muted small">The next 60 days</span></div>';
    if (!up.length) {
      var nx = C.nextAfter(state.people, t, C.LIMITS.comingDays);
      left += '<div class="quiet"><span class="e" aria-hidden="true">🌿</span><div><b>All clear for 60 days.</b><span class="small">' + (nx ? 'Next: ' + esc(nx.title) + ', ' + esc(fmt(nx.day)) + '.' : 'Add a date to someone and it will show here.') + '</span></div></div>';
    }
    [['This week', week], ['This month', month], ['Further out', later]].forEach(function (g) {
      if (!g[1].length) return;
      left += '<div class="sec"><h2>' + g[0] + '</h2><span class="ct">' + plural(g[1].length, 'date') + '</span></div><div class="rows">' + g[1].map(comingRow).join('') + '</div>';
    });
    var budgeted = up.filter(function (o) { return o.budget; });
    var bTot = budgeted.reduce(function (s, o) { return s + o.budget; }, 0);
    var sTot = up.reduce(function (s, o) { return s + o.spent; }, 0);
    var miles = up.filter(function (o) { return o.milestone; });
    var right = '<section class="card"><h2>The next 60 days</h2><div class="totals">' +
      '<div class="tot hi"><b>' + up.length + '</b><span>' + (up.length === 1 ? 'Date' : 'Dates') + '</span></div>' +
      '<div class="tot"><b>' + esc(money(sTot)) + '</b><span>Spent</span></div>' +
      '<div class="tot"><b>' + esc(bTot ? money(bTot) : '—') + '</b><span>Budgeted</span></div></div>' +
      (miles.length ? '<p class="small" style="margin:10px 0 0">★ ' + miles.map(function (o) { return esc(o.name.split(' ')[0]) + (o.kind === 'birthday' ? ' ' : ': ') + esc(o.milestone.short); }).join(' · ') + '</p>' : '') + '</section>' +
      '<section class="card"><h2>Put every date in your calendar</h2><p class="small muted">One file: each birthday and anniversary repeating every year, with a reminder at each person’s lead time and one on the day. Your phone’s calendar does the rest - nothing in the cloud writes to it, and no gift ideas go in it.</p>' +
      '<div class="row"><button class="btn" type="button" data-act="ics">📅 Download all dates</button><button class="btn small ghost" type="button" data-act="settings">Settings</button></div></section>' +
      '<section class="card"><h2>Ask them what they’d love</h2><p class="small muted">Open someone and tap <b>Ask for their wishlist</b>. They get a link with a text box - no app, no account - and what they add lands on your list, marked “from them”.</p></section>';
    return '<div class="dk-split dk-split-aside"><div>' + left + '</div><div class="dk-sticky">' + right + '</div></div>';
  }

  function nextLine(p) {
    var o = occasionsFor(p)[0];
    if (!o) return 'No dates yet';
    return o.emoji + ' ' + o.label + ' ' + C.countdown(o.inDays).toLowerCase() + (o.milestone ? ' · ' + o.milestone.short : o.kind === 'birthday' && o.n !== null ? ' · turns ' + o.n : '');
  }
  function peopleView() {
    var q = C.fold(state.q);
    var t = today();
    var list = state.people.slice().sort(function (a, b) {
      var x = occasionsFor(a)[0], y = occasionsFor(b)[0];
      var dx = x ? x.day : '9999', dy = y ? y.day : '9999';
      return dx < dy ? -1 : dx > dy ? 1 : a.name.localeCompare(b.name);
    }).filter(function (p) { return !q || C.fold(p.name).indexOf(q) >= 0; });
    void t;
    var html = '<div class="page-title"><h1>People</h1><button class="btn small" type="button" data-act="addperson">+ Add someone</button></div>';
    if (state.people.length > 6) html += '<div class="toolbar"><label class="search"><span class="vh">Find someone</span><input class="input" id="peopleSearch" type="search" placeholder="Find someone" value="' + esc(state.q) + '" autocomplete="off"></label></div>';
    html += '<div class="people dk-grid">' + list.map(function (p) {
      var open = p.ideas.filter(function (i) { return i.status === 'idea'; }).length;
      var gave = p.ideas.filter(function (i) { return i.status === 'given'; }).length;
      return '<button class="pcard open" type="button" data-act="open" data-id="' + esc(p.id) + '">' + av(p) +
        '<span><span class="t">' + esc(p.name) + '</span><span class="w">' + esc(nextLine(p)) + '</span>' +
        '<span class="chips"><span class="chip">' + esc(C.relOf(p.relationship).label) + '</span>' + (open ? '<span class="chip info">' + esc(plural(open, 'idea')) + '</span>' : '') + (gave ? '<span class="chip">' + esc(gave + ' given') + '</span>' : '') + (p.wish ? '<span class="chip them">Wishlist open</span>' : '') + '</span></span></button>';
    }).join('') + '</div>';
    if (!list.length) html += '<p class="muted">Nobody by that name.</p>';
    return html;
  }

  function ideaRow(p, i, withName) {
    var meta = [];
    if (i.price !== null) meta.push('<span>' + esc(money(i.price)) + '</span>');
    if (i.link) meta.push('<a href="' + esc(i.link) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(C.hostOf(i.link)) + ' ↗</a>');
    if (i.from === 'them') meta.push('<span class="chip them">From them</span>');
    if (i.from === 'ai') meta.push('<span class="chip ai">AI idea</span>');
    if (i.status === 'bought') meta.push('<span class="chip ready">Bought for ' + esc(occLabel(p, i.occasion)) + ' ' + esc(i.year || '') + '</span>');
    var acts = i.status === 'idea'
      ? '<button class="btn small soft" type="button" data-act="buy" data-id="' + esc(p.id) + '" data-idea="' + esc(i.id) + '">Bought it</button><button class="btn small ghost" type="button" data-act="give" data-id="' + esc(p.id) + '" data-idea="' + esc(i.id) + '">Given</button><button class="btn small ghost" type="button" data-act="delidea" data-id="' + esc(p.id) + '" data-idea="' + esc(i.id) + '" aria-label="Delete this idea">Delete</button>'
      : '<button class="btn small" type="button" data-act="give" data-id="' + esc(p.id) + '" data-idea="' + esc(i.id) + '">🎉 Given</button><button class="btn small ghost" type="button" data-act="unbuy" data-id="' + esc(p.id) + '" data-idea="' + esc(i.id) + '">Not bought</button>';
    var rep = i.status === 'idea' ? C.repeatOf(p, i.text, i.id) : null;
    return '<li class="idea' + (i.status === 'bought' ? ' is-bought' : '') + '"><div class="it">' + (withName ? '<span class="muted">' + esc(p.name) + ': </span>' : '') + esc(i.text) + '</div>' +
      (meta.length ? '<div class="im">' + meta.join('') + '</div>' : '') +
      (rep ? '<div class="repeat" role="note"><span aria-hidden="true">⚠️</span><span><b>Given before?</b> Looks like “' + esc(rep.text) + '”' + (rep.status === 'given' ? ', given in ' + esc(rep.year || 'the past') : ', already bought') + '.</span></div>' : '') +
      '<div class="row">' + acts + '</div></li>';
  }
  function occLabel(p, key) {
    var d = C.datesOf(p).filter(function (x) { return x.key === key; })[0];
    return d ? (d.kind === 'custom' ? d.label : d.label.toLowerCase()) : 'a gift';
  }
  function ideasView() {
    var html = '<div class="page-title"><h1>Gift ideas</h1><button class="btn small" type="button" data-act="quickidea">+ Idea</button></div>';
    var bought = [], open = [], gave = 0, spentYear = 0, y = Number(today().slice(0, 4));
    state.people.forEach(function (p) {
      var o = p.ideas.filter(function (i) { return i.status === 'idea'; });
      var b = p.ideas.filter(function (i) { return i.status === 'bought'; });
      if (o.length) open.push([p, o]);
      b.forEach(function (i) { bought.push([p, i]); });
      p.ideas.forEach(function (i) { if (i.status === 'given' && i.year === y) gave++; if (i.status !== 'idea' && i.year === y && i.price) spentYear += i.price; });
    });
    html += '<section class="card"><div class="totals"><div class="tot hi"><b>' + open.reduce(function (s, x) { return s + x[1].length; }, 0) + '</b><span>Ideas saved</span></div><div class="tot"><b>' + bought.length + '</b><span>Bought, not given</span></div><div class="tot"><b>' + esc(money(spentYear)) + '</b><span>Spent in ' + y + '</span></div></div>' +
      (gave ? '<p class="small muted" style="margin:10px 0 0">' + esc(plural(gave, 'gift')) + ' given so far this year.</p>' : '') + '</section>';
    if (bought.length) {
      html += '<div class="sec"><h2>Wrapped and waiting</h2><span class="ct">' + plural(bought.length, 'gift') + '</span></div><ul class="ideas">' + bought.map(function (x) { return ideaRow(x[0], x[1], true); }).join('') + '</ul>';
    }
    if (!open.length) {
      html += '<div class="note" style="margin-top:16px"><b>No ideas saved yet.</b><p class="small muted" style="margin:4px 0 0">When someone mentions something they’d love, tap <b>+ Idea</b> on them - it takes three seconds, and it will still be here in December.</p></div>';
    }
    var soon = {};
    C.upcoming(state.people, today(), { days: 400 }).forEach(function (o) { if (!(o.id in soon)) soon[o.id] = o.day; });
    open.sort(function (a, b) { var x = soon[a[0].id] || '9999', z = soon[b[0].id] || '9999'; return x < z ? -1 : x > z ? 1 : 0; });
    open.forEach(function (x) {
      var p = x[0];
      html += '<div class="group"><div class="group-head">' + av(p) + '<h3>' + esc(p.name) + '</h3><button class="link-btn small" type="button" data-act="open" data-id="' + esc(p.id) + '">Open</button></div><ul class="ideas">' + x[1].map(function (i) { return ideaRow(p, i, false); }).join('') + '</ul></div>';
    });
    return html;
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function head(title) { return '<div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2 id="sheetTitle">' + esc(title) + '</h2><button class="x" type="button" data-act="closesheet" aria-label="Close">×</button></div>'; }
  function sheet(html, bind, wide) {
    var s = $('#sheet');
    if (s.hidden) lastFocus = document.activeElement;
    s.innerHTML = html;
    s.classList.toggle('wide', Boolean(wide));
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
    state.form = null; state.ai = null; state.armed = null; state.openId = null;
    if (!noFocus && lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) { /* gone */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  /* ---------------- one person ---------------- */

  function openPerson(id, scrollTo) {
    var p = byId(id);
    if (!p) return;
    state.openId = id;
    var t = today();
    var occ = occasionsFor(p);
    var open = p.ideas.filter(function (i) { return i.status !== 'given'; }).sort(function (a, b) { return (a.status === 'bought' ? 0 : 1) - (b.status === 'bought' ? 0 : 1); });
    var given = C.givenBefore(p);
    var html = head(p.name) +
      '<div class="detail-top">' + av(p, true) + '<div><p class="muted" style="margin:0">' + esc(C.relOf(p.relationship).label) + ' · nudge ' + esc(p.leadDays ? plural(p.leadDays, 'day') + ' before' : 'on the day') + '</p>' +
      '<div class="row" style="margin-top:6px"><button class="btn small ghost" type="button" data-act="edit" data-id="' + esc(p.id) + '">Edit</button>' + (occ.length ? '<button class="btn small ghost" type="button" data-act="icsone" data-id="' + esc(p.id) + '">📅 Add to calendar</button>' : '') + '</div></div></div>';
    html += '<div class="sec" style="margin-top:6px"><h2>Their dates</h2></div>';
    if (!occ.length) html += '<p class="muted small">No dates yet. <button class="link-btn" type="button" data-act="edit" data-id="' + esc(p.id) + '">Add a birthday</button></p>';
    occ.forEach(function (o) {
      var date = C.datesOf(p).filter(function (d) { return d.key === o.key; })[0].date;
      html += '<div class="occ"><div class="oh"><b>' + esc(o.emoji) + ' ' + esc(o.label) + '</b><span class="od">' + esc(C.dateWords(date)) + '</span></div>' +
        '<div class="small" style="margin-top:4px">' + esc(fmt(o.day)) + ' (' + esc(C.WEEKDAYS[C.weekday(o.day)]) + ') · ' + esc(C.whenWords(o, t)) + '</div>' +
        '<div class="chips">' + chipsFor(o) + '</div>' + budgetLine(o) +
        '<div class="budget-row"><label class="money"><span class="vh">Budget for ' + esc(o.label) + '</span><input class="input" inputmode="decimal" id="bud-' + esc(o.key) + '" placeholder="Budget" value="' + (o.budget ? esc((o.budget / 100).toFixed(o.budget % 100 ? 2 : 0)) : '') + '"></label><button class="btn small ghost" type="button" data-act="budget" data-id="' + esc(p.id) + '" data-key="' + esc(o.key) + '">' + (o.budget ? 'Change budget' : 'Set a budget') + '</button></div></div>';
    });

    html += '<div class="sec" id="ideasSec"><h2>Gift ideas</h2><span class="ct">' + (open.length ? plural(open.length, 'idea') : '') + '</span></div>' +
      '<form class="quickadd" id="qaForm"><label><span class="vh">A gift idea for ' + esc(p.name) + '</span><input class="input" id="qaText" maxlength="' + C.LIMITS.idea + '" placeholder="Heard an idea? Type it here" autocomplete="off"></label><button class="btn" type="submit">Save</button></form>' +
      '<div id="qaRepeat"></div>' +
      '<div class="row" style="margin-top:8px"><button class="btn small ghost" type="button" data-act="quickidea" data-id="' + esc(p.id) + '">+ With a link or price</button><button class="btn small soft" type="button" data-act="ai" data-id="' + esc(p.id) + '">✨ Gift ideas for them</button></div>' +
      (open.length ? '<ul class="ideas">' + open.map(function (i) { return ideaRow(p, i, false); }).join('') + '</ul>' : '<p class="small muted" style="margin-top:8px">Nothing saved yet - ideas you hear all year go here.</p>');

    var n = p.notes || {};
    var facts = C.NOTE_FIELDS.filter(function (k) { return n[k]; }).map(function (k) {
      return '<div class="fact' + (k === 'allergies' || k === 'dislikes' ? ' warn' : '') + '"><div class="k">' + esc(C.NOTE_LABEL[k]) + '</div><div class="v">' + esc(n[k]) + '</div></div>';
    });
    if (n.hasEverything) facts.push('<div class="fact"><div class="k">Heads-up</div><div class="v">Has everything - think experiences and treats</div></div>');
    html += '<div class="sec"><h2>Notes that help</h2><button class="link-btn small" type="button" data-act="edit" data-id="' + esc(p.id) + '" data-focus="notes">Edit notes</button></div>' +
      (facts.length ? '<div class="notes">' + facts.join('') + '</div>' : '<p class="small muted">Sizes, likes, what to avoid, allergies. <button class="link-btn" type="button" data-act="edit" data-id="' + esc(p.id) + '" data-focus="notes">Add some</button></p>');

    html += '<div class="sec"><h2>Given before</h2><button class="link-btn small" type="button" data-act="pastgift" data-id="' + esc(p.id) + '">+ Add a past gift</button></div>' +
      (given.length ? '<ul class="given">' + given.map(function (i) {
        return '<li><span class="yr">' + esc(i.year || '—') + '</span><span class="gt">' + esc(i.text) + (i.occasion ? ' <span class="muted small">· ' + esc(occLabel(p, i.occasion)) + '</span>' : '') + '</span><span class="gp">' + (i.price !== null ? esc(money(i.price)) : '') + '</span></li>';
      }).join('') + '</ul>' : '<p class="small muted">Nothing yet. What you mark “Given” lands here, so nothing gets given twice.</p>');

    html += '<div class="sec"><h2>Their wishlist</h2></div><div class="wishbox" id="wishBox">' + wishHtml(p) + '</div>';
    html += '<div class="stack" style="margin-top:18px"><button class="btn danger block" type="button" data-act="delete" data-id="' + esc(p.id) + '">Delete ' + esc(p.name) + '</button></div>';
    sheet(html, function (root) {
      var form = $('#qaForm', root), txt = $('#qaText', root);
      txt.addEventListener('input', function () { $('#qaRepeat', root).innerHTML = repeatHtml(p, txt.value); });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (addIdea(p.id, { text: txt.value })) { openPerson(p.id, 'ideas'); draw(); }
      });
      if (scrollTo === 'ideas') { var s = $('#ideasSec', root); if (s) setTimeout(function () { s.scrollIntoView({ block: 'start' }); }, 40); }
    }, true);
  }
  function repeatHtml(p, text) {
    var r = text && text.trim().length > 2 ? C.repeatOf(p, text) : null;
    if (!r) return '';
    return '<div class="repeat" role="status"><span aria-hidden="true">⚠️</span><span><b>Given before?</b> You ' + (r.status === 'given' ? 'gave “' + esc(r.text) + '” in ' + esc(r.year || 'the past') : 'already bought “' + esc(r.text) + '”') + '.</span></div>';
  }

  /** Save an idea for someone. Returns the person, or null. */
  function addIdea(id, raw, quiet) {
    var p = byId(id);
    if (!p) return null;
    var text = C.cleanText(raw.text, C.LIMITS.idea);
    if (!text) { toast('Type the idea first.'); return null; }
    if (p.ideas.length >= C.LIMITS.ideas) { toast('That’s ' + C.LIMITS.ideas + ' ideas for ' + p.name + '. Delete a few old ones first.'); return null; }
    var c = copyOf(p);
    c.ideas.push({ id: raw.id || newId('i'), text: text, link: raw.link || '', price: raw.price === undefined ? null : raw.price, status: raw.status || 'idea', occasion: raw.occasion || null, year: raw.year || null, from: raw.from || 'me', addedAt: Date.now(), doneAt: raw.status && raw.status !== 'idea' ? Date.now() : null });
    var saved = savePerson(c, quiet ? null : 'Saved for ' + p.name + '.');
    return saved;
  }
  function setIdea(pid, iid, change, msg) {
    var p = byId(pid);
    if (!p) return;
    var c = copyOf(p);
    c.ideas = c.ideas.map(function (i) { return i.id === iid ? Object.assign(i, change) : i; }).filter(function (i) { return !i._del; });
    savePerson(c, msg);
  }

  /** "Bought it" / "Given": which occasion, which year, what it cost. */
  function openMark(pid, iid, to) {
    var p = byId(pid);
    var i = p && p.ideas.filter(function (x) { return x.id === iid; })[0];
    if (!i) return;
    var occ = occasionsFor(p);
    var y = Number(today().slice(0, 4));
    var html = head(to === 'given' ? 'Given - nice one' : 'Bought it') +
      '<p class="muted" style="overflow-wrap:anywhere">' + esc(i.text) + ' · for ' + esc(p.name) + '</p>' +
      '<form id="markForm">' +
      (occ.length ? '<label class="field"><span>For</span><select class="input" id="mOcc">' + occ.map(function (o) {
        var yr = to === 'given' && o.year > y && i.status === 'idea' ? o.year - 1 : o.year;
        return '<option value="' + esc(o.key) + '|' + yr + '"' + (i.occasion === o.key ? ' selected' : '') + '>' + esc(o.label) + ' ' + yr + '</option>';
      }).join('') + '<option value="|' + y + '">No particular occasion (' + y + ')</option></select></label>' : '<input type="hidden" id="mOcc" value="|' + y + '">') +
      '<label class="field"><span>What it cost <span class="hint">(optional - counts toward the budget)</span></span><span class="money"><input class="input" id="mPrice" inputmode="decimal" placeholder="0.00" value="' + (i.price !== null ? esc((i.price / 100).toFixed(2)) : '') + '"></span></label>' +
      '<button class="btn big block" type="submit">' + (to === 'given' ? '🎉 Mark as given' : 'Mark as bought') + '</button></form>' +
      '<p class="small muted" style="margin-top:10px">' + (to === 'given' ? 'It moves to “Given before”, so Kindly can warn you if a similar idea comes up again.' : 'It stays on their list as “Gift ready” until you mark it given.') + '</p>';
    sheet(html, function (root) {
      $('#markForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var v = String($('#mOcc', root).value).split('|');
        var price = C.parseMoney($('#mPrice', root).value);
        setIdea(pid, iid, { status: to, occasion: v[0] || null, year: Number(v[1]) || y, price: price, doneAt: Date.now() }, to === 'given' ? 'Given! Saved to ' + p.name + '’s history.' : 'Bought. It shows as “Gift ready”.');
        if (to === 'given') confetti();
        openPerson(pid); draw();
      });
    });
  }

  /** A gift given before Kindly: text and the year. */
  function openPastGift(pid) {
    var p = byId(pid);
    if (!p) return;
    var y = Number(today().slice(0, 4));
    var occ = C.datesOf(p);
    sheet(head('A past gift for ' + p.name) + '<p class="muted small">So it never gets given twice.</p><form id="pgForm">' +
      '<label class="field"><span>What you gave</span><input class="input" id="pgText" maxlength="' + C.LIMITS.idea + '" required autofocus placeholder="Grey cashmere scarf"></label>' +
      '<div class="two"><label class="field"><span>Year</span><select class="input" id="pgYear">' + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (k) { return '<option>' + (y - k) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>For</span><select class="input" id="pgOcc">' + occ.map(function (d) { return '<option value="' + esc(d.key) + '">' + esc(d.label) + '</option>'; }).join('') + '<option value="">Something else</option></select></label></div>' +
      '<label class="field"><span>Price <span class="hint">(optional)</span></span><span class="money"><input class="input" id="pgPrice" inputmode="decimal" placeholder="0.00"></span></label>' +
      '<button class="btn big block" type="submit">Add to “Given before”</button></form>', function (root) {
      $('#pgForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        if (addIdea(pid, { text: $('#pgText', root).value, status: 'given', year: Number($('#pgYear', root).value), occasion: $('#pgOcc', root).value || null, price: C.parseMoney($('#pgPrice', root).value) }, true)) {
          toast('Added to ' + p.name + '’s history.'); openPerson(pid); draw();
        }
      });
    });
  }

  /** The quick idea sheet: who (when not given), the idea, a link, a price. */
  function openQuickIdea(pid) {
    var who = pid ? byId(pid) : null;
    var sorted = state.people.slice().sort(function (a, b) { var x = occasionsFor(a)[0], y = occasionsFor(b)[0]; return (x ? x.day : '9999') < (y ? y.day : '9999') ? -1 : 1; });
    var sel = who ? who.id : (sorted[0] && sorted[0].id);
    sheet(head(who ? 'An idea for ' + who.name : 'Save a gift idea') + '<form id="qiForm">' +
      (who ? '' : '<div class="field"><span>For</span><div class="pills" role="group" aria-label="Who it is for">' + sorted.slice(0, 24).map(function (p) { return '<button class="pill" type="button" data-pick="' + esc(p.id) + '" aria-pressed="' + (p.id === sel) + '">' + esc(p.name) + '</button>'; }).join('') + '</div></div>') +
      '<label class="field"><span>The idea</span><input class="input" id="qiText" maxlength="' + C.LIMITS.idea + '" required autofocus placeholder="Pottery wheel taster class" autocomplete="off"></label><div id="qiRepeat"></div>' +
      '<div class="two"><label class="field"><span>Price <span class="hint">(optional)</span></span><span class="money"><input class="input" id="qiPrice" inputmode="decimal" placeholder="0.00"></span></label>' +
      '<label class="field"><span>Link <span class="hint">(optional)</span></span><input class="input" id="qiLink" type="url" inputmode="url" placeholder="https://" autocomplete="off"></label></div>' +
      '<div id="qiErr"></div><button class="btn big block" type="submit">Save the idea</button></form>', function (root) {
      var txt = $('#qiText', root);
      var check = function () { var p = byId(sel); $('#qiRepeat', root).innerHTML = p ? repeatHtml(p, txt.value) : ''; };
      txt.addEventListener('input', check);
      $$('[data-pick]', root).forEach(function (b) {
        b.addEventListener('click', function () { sel = b.getAttribute('data-pick'); $$('[data-pick]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); check(); });
      });
      $('#qiForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var linkRaw = $('#qiLink', root).value.trim();
        var link = C.cleanLink(linkRaw);
        if (linkRaw && !link) { $('#qiErr', root).innerHTML = '<p class="err" role="alert">That link doesn’t look right - it needs to start with https://</p>'; return; }
        var priceRaw = $('#qiPrice', root).value.trim();
        var price = C.parseMoney(priceRaw);
        if (priceRaw && price === null) { $('#qiErr', root).innerHTML = '<p class="err" role="alert">That price doesn’t look like an amount.</p>'; return; }
        var saved = addIdea(sel, { text: txt.value, link: link, price: price });
        if (saved) { closeSheet(true); draw(); }
      });
    });
  }

  /* ---------------- the person form ---------------- */

  function blankForm() {
    return { id: null, name: '', relationship: 'friend', bm: '', bd: '', by: '', bleap: 'feb28', am: '', ad: '', ay: '', aleap: 'feb28', dates: [], leadDays: 10, notes: { sizes: '', likes: '', dislikes: '', allergies: '', other: '', hasEverything: false } };
  }
  function openForm(id, focus) {
    var p = id ? byId(id) : null;
    var f = blankForm();
    if (p) {
      f.id = p.id; f.name = p.name; f.relationship = p.relationship; f.leadDays = p.leadDays;
      if (p.birthday) { f.bm = p.birthday.month; f.bd = p.birthday.day; f.by = p.birthday.year || ''; f.bleap = p.birthday.leap || 'feb28'; }
      if (p.anniversary) { f.am = p.anniversary.month; f.ad = p.anniversary.day; f.ay = p.anniversary.year || ''; f.aleap = p.anniversary.leap || 'feb28'; }
      f.dates = p.dates.map(function (d) { return { id: d.id, label: d.label, m: d.month, d: d.day, y: d.year || '', leap: d.leap || 'feb28' }; });
      f.notes = Object.assign({}, p.notes);
    }
    f.focus = focus || null;
    state.form = f;
    drawForm();
  }
  function monthOpts(sel) { return '<option value="">Month</option>' + C.MONTHS_LONG.map(function (m, i) { return '<option value="' + (i + 1) + '"' + (Number(sel) === i + 1 ? ' selected' : '') + '>' + m + '</option>'; }).join(''); }
  function dayOpts(m, sel) { var n = m ? C.daysInMonth(2000, Number(m)) : 31; var o = '<option value="">Day</option>'; for (var d = 1; d <= n; d++) o += '<option' + (Number(sel) === d ? ' selected' : '') + '>' + d + '</option>'; return o; }
  function dateFields(prefix, m, d, y, leap, yearHint) {
    var feb29 = Number(m) === 2 && Number(d) === 29;
    return '<div class="dategrid"><label class="field"><span>Month</span><select class="input" data-f="' + prefix + 'm">' + monthOpts(m) + '</select></label>' +
      '<label class="field"><span>Day</span><select class="input" data-f="' + prefix + 'd">' + dayOpts(m, d) + '</select></label>' +
      '<label class="field yr"><span>Year <span class="hint">' + esc(yearHint) + '</span></span><input class="input" data-f="' + prefix + 'y" inputmode="numeric" maxlength="4" placeholder="Optional" value="' + esc(y) + '"></label></div>' +
      (feb29 ? '<div class="field"><span>In years without a Feb 29, celebrate on</span><div class="seg"><button type="button" data-leap="' + prefix + '" data-v="feb28" aria-pressed="' + (leap !== 'mar1') + '">Feb 28</button><button type="button" data-leap="' + prefix + '" data-v="mar1" aria-pressed="' + (leap === 'mar1') + '">Mar 1</button></div></div>' : '');
  }
  function drawForm() {
    var f = state.form;
    var rels = C.RELATIONSHIPS.map(function (r) { return '<button class="pill" type="button" data-act="rel" data-rel="' + r.id + '" aria-pressed="' + (f.relationship === r.id) + '">' + r.emoji + ' ' + esc(r.label) + '</button>'; }).join('');
    var custom = f.dates.map(function (d, i) {
      return '<div class="dateblock"><div class="row" style="justify-content:space-between;margin-top:6px"><label class="field" style="flex:1 1 160px;margin:4px 0"><span>What’s the day?</span><input class="input" data-cl="' + i + '" maxlength="' + C.LIMITS.label + '" placeholder="Gotcha day" value="' + esc(d.label) + '"></label><button class="btn small danger" type="button" data-act="rmdate" data-i="' + i + '">Remove</button></div>' + dateFields('c' + i, d.m, d.d, d.y, d.leap, '(the first one)') + '</div>';
    }).join('');
    var n = f.notes;
    var note = function (k, ph) { return '<label class="field"><span>' + esc(C.NOTE_LABEL[k]) + '</span><input class="input" data-note="' + k + '" maxlength="' + C.LIMITS.noteField + '" placeholder="' + esc(ph) + '" value="' + esc(n[k] || '') + '"></label>'; };
    sheet(head(f.id ? 'Edit ' + f.name : 'Add someone') + '<form id="pForm" novalidate>' +
      '<label class="field"><span>Name</span><input class="input" id="fName" maxlength="' + C.LIMITS.name + '" required value="' + esc(f.name) + '"' + (f.focus ? '' : ' autofocus') + ' autocomplete="off" placeholder="Maya Ortiz"></label>' +
      '<div class="field"><span>Who are they to you?</span><div class="pills" role="group" aria-label="Relationship">' + rels + '</div></div>' +
      '<div class="dateblock"><h3 style="margin-top:10px">🎂 Birthday</h3>' + dateFields('b', f.bm, f.bd, f.by, f.bleap, '(for their age)') + '</div>' +
      '<div class="dateblock"><h3 style="margin-top:10px">💍 Anniversary <span class="hint muted">(optional)</span></h3>' + dateFields('a', f.am, f.ad, f.ay, f.aleap, '(for the count)') + '</div>' +
      custom +
      (f.dates.length < C.LIMITS.dates ? '<button class="btn small ghost" type="button" data-act="adddate">+ Another date (gotcha day, name day…)</button>' : '') +
      '<label class="field" style="margin-top:16px"><span>Start nudging me</span><select class="input" id="fLead">' + [0].concat(LEADS).map(function (d) { return '<option value="' + d + '"' + (d === f.leadDays ? ' selected' : '') + '>' + (d === 0 ? 'On the day' : d + ' days before') + '</option>'; }).join('') + '</select><span class="hint">Time to think of something and order it. 10 days is a good start.</span></label>' +
      '<h3 id="notesHead">Notes that help</h3>' + note('sizes', 'M top, 8 shoe') + note('likes', 'Ceramics, coffee, the beach') + note('dislikes', 'Scented candles') + note('allergies', 'Tree nuts') + note('other', 'Just started running') +
      '<label class="check"><input type="checkbox" id="fEvery"' + (n.hasEverything ? ' checked' : '') + '> They have everything</label>' +
      '<div id="formErr"></div>' +
      '<button class="btn big block" type="submit" style="margin-top:12px">' + (f.id ? 'Save changes' : 'Add them') + '</button></form>', function (root) {
      $('#fName', root).addEventListener('input', function (e) { f.name = e.target.value; });
      $('#fLead', root).addEventListener('change', function (e) { f.leadDays = Number(e.target.value); });
      $('#fEvery', root).addEventListener('change', function (e) { f.notes.hasEverything = e.target.checked; });
      $$('[data-note]', root).forEach(function (el) { el.addEventListener('input', function () { f.notes[el.getAttribute('data-note')] = el.value; }); });
      $$('[data-cl]', root).forEach(function (el) { el.addEventListener('input', function () { f.dates[Number(el.getAttribute('data-cl'))].label = el.value; }); });
      $$('[data-f]', root).forEach(function (el) {
        var k = el.getAttribute('data-f');
        el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
          setDateField(k, el.value);
          if (el.tagName === 'SELECT') { var y = window.scrollY, s = $('#sheet').scrollTop; drawForm(); $('#sheet').scrollTop = s; window.scrollTo(0, y); var again = $('[data-f="' + k + '"]'); if (again) again.focus(); }
        });
      });
      $$('[data-leap]', root).forEach(function (b) { b.addEventListener('click', function () { setDateField(b.getAttribute('data-leap') + 'leap', b.getAttribute('data-v')); $$('[data-leap="' + b.getAttribute('data-leap') + '"]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }); });
      $('#pForm', root).addEventListener('submit', function (e) { e.preventDefault(); submitForm(); });
      if (f.focus === 'notes') { setTimeout(function () { var h = $('#notesHead', root); if (h) h.scrollIntoView({ block: 'start' }); var i = $('[data-note="likes"]', root); if (i) i.focus({ preventScroll: true }); }, 40); }
    });
  }
  function setDateField(k, v) {
    var f = state.form;
    var m = /^c(\d+)(m|d|y|leap)$/.exec(k);
    if (m) { var d = f.dates[Number(m[1])]; if (d) d[m[2]] = v; return; }
    f[k] = v;
  }
  function formErr(msg) { var el = $('#formErr'); if (el) { el.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; el.scrollIntoView({ block: 'nearest' }); } }
  function readDate(label, m, d, y, leap) {
    if (!m && !d && !y) return { date: null };
    if (!m || !d) return { err: label + ': pick both the month and the day.' };
    var yr = String(y || '').trim();
    var t = today();
    if (yr && (!/^\d{4}$/.test(yr) || Number(yr) < 1900)) return { err: label + ': the year should look like 1986 - or leave it empty.' };
    if (yr && Number(m) === 2 && Number(d) === 29 && !C.isLeap(Number(yr))) return { err: label + ': ' + yr + ' had no Feb 29.' };
    if (yr && C.isDay(yr + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')) && (yr + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')) > t) return { err: label + ': that date hasn’t happened yet. Leave the year empty.' };
    return { date: { month: Number(m), day: Number(d), year: yr ? Number(yr) : null, leap: leap } };
  }
  function submitForm() {
    var f = state.form;
    var name = C.cleanText(f.name, C.LIMITS.name);
    if (!name) return formErr('Give them a name.');
    var b = readDate('Birthday', f.bm, f.bd, f.by, f.bleap); if (b.err) return formErr(b.err);
    var a = readDate('Anniversary', f.am, f.ad, f.ay, f.aleap); if (a.err) return formErr(a.err);
    var dates = [];
    for (var i = 0; i < f.dates.length; i++) {
      var d = f.dates[i];
      var lab = C.cleanText(d.label, C.LIMITS.label);
      var r = readDate(lab || 'The extra date', d.m, d.d, d.y, d.leap); if (r.err) return formErr(r.err);
      if (!r.date && !lab) continue;
      if (!lab) return formErr('Give the extra date a name, like “Gotcha day”.');
      if (!r.date) return formErr(lab + ': pick the month and the day.');
      dates.push(Object.assign({ id: d.id || newId('d'), label: lab }, r.date));
    }
    var prev = f.id ? byId(f.id) : null;
    if (!prev && state.people.filter(function (x) { return !x.sample; }).length >= C.LIMITS.people) return formErr('A circle keeps up to ' + C.LIMITS.people + ' people.');
    var p = prev ? copyOf(prev) : { id: newId('p'), ideas: [], budgets: {}, wish: null, createdAt: Date.now() };
    p.name = name; p.relationship = f.relationship; p.birthday = b.date; p.anniversary = a.date; p.dates = dates; p.leadDays = f.leadDays; p.notes = f.notes;
    if (!prev && hasSample()) state.people = state.people.filter(function (x) { return !x.sample; });
    var saved = savePerson(p, prev ? 'Saved.' : name + ' is in your circle.');
    closeSheet(true);
    if (!prev) state.tab = state.tab === 'ideas' ? 'ideas' : state.tab;
    draw();
    if (saved && !prev) openPerson(saved.id);
  }

  /* ---------------- "Gift ideas for them" (the one model call) ---------------- */

  function openAi(pid, key) {
    var p = byId(pid);
    if (!p) return;
    var occ = occasionsFor(p);
    var chosen = key || (occ[0] && occ[0].key) || '';
    state.ai = { pid: pid, key: chosen, ideas: null, busy: false, saved: {} };
    drawAi();
  }
  function aiOcc() { var a = state.ai, p = byId(a.pid); return occasionsFor(p).filter(function (o) { return o.key === a.key; })[0] || null; }
  function sentLine(p, o) {
    var b = C.aiBrief(p, o);
    var parts = [C.relOf(b.relationship).label.toLowerCase()];
    if (b.age !== null) parts.push('age ' + b.age);
    parts.push(o ? (o.kind === 'custom' ? b.occasionLabel || 'a special day' : o.label.toLowerCase()) + (b.years !== null ? ' (' + plural(b.years, 'year') + ')' : '') : 'no particular occasion');
    if (b.budget) parts.push('about ' + money(b.budget));
    ['likes', 'dislikes', 'sizes', 'allergies', 'other'].forEach(function (k) { if (b[k]) parts.push(C.NOTE_LABEL[k].toLowerCase() + ': ' + b[k]); });
    if (b.hasEverything) parts.push('has everything');
    return parts.join(' · ');
  }
  function drawAi() {
    var a = state.ai, p = byId(a.pid);
    if (!p) return;
    var o = aiOcc();
    var occ = occasionsFor(p);
    var html = head('Gift ideas for ' + p.name);
    if (!signedIn()) {
      html += '<p>AI can suggest five ideas from their notes - it needs a free account, which comes with $2 of AI credit (about two hundred suggestions).</p>' +
        '<p class="small muted">Everything else in Kindly stays free with no account: people, dates, your own ideas, budgets, wishlist links and the calendar.</p>' +
        '<div class="stack"><button class="btn block" type="button" data-act="signup">Create a free account</button><button class="btn ghost block" type="button" data-act="signin">I have an account</button></div>';
      return sheet(html, null, true);
    }
    html += (occ.length ? '<div class="field"><span>For</span><div class="pills" role="group" aria-label="Occasion">' + occ.map(function (x) { return '<button class="pill" type="button" data-act="aiocc" data-key="' + esc(x.key) + '" aria-pressed="' + (x.key === a.key) + '">' + esc(x.emoji + ' ' + x.label) + '</button>'; }).join('') + '</div></div>' : '') +
      '<div class="sent"><b>What AI is told:</b> ' + esc(sentLine(p, o)) + '. <b>Never their name.</b></div>' +
      (!p.notes.likes && !p.notes.other ? '<p class="small muted">Tip: a few likes in their notes make the ideas much better. <button class="link-btn" type="button" data-act="edit" data-id="' + esc(p.id) + '" data-focus="notes">Add notes</button></p>' : '') +
      '<button class="btn big block" type="button" data-act="doai"' + (a.busy ? ' disabled' : '') + '>' + (a.busy ? 'Thinking…' : a.ideas ? '✨ Five more' : '✨ Suggest five ideas') + '</button>' +
      '<div id="aiOut" aria-live="polite">' + aiResults() + '</div>';
    sheet(html, null, true);
  }
  function aiResults() {
    var a = state.ai, p = byId(a.pid);
    if (!a.ideas) return '';
    return '<div class="sugg">' + a.ideas.map(function (s, i) {
      var rep = C.repeatOf(p, s.title);
      var done = a.saved[i];
      return '<div class="sg' + (done ? ' saved' : '') + '"><div class="st"><b>' + esc(s.title) + '</b><span class="pr">' + esc(s.priceRange) + '</span></div><p>' + esc(s.why) + '</p>' +
        (rep ? '<div class="repeat"><span aria-hidden="true">⚠️</span><span><b>Given before?</b> Looks like “' + esc(rep.text) + '”' + (rep.year ? ' (' + esc(rep.year) + ')' : '') + '.</span></div>' : '') +
        '<div class="row" style="margin-top:8px">' + (done ? '<span class="chip ready saved-chip">✓ Saved to their ideas</span>' : '<button class="btn small" type="button" data-act="aisave" data-i="' + i + '">Save to their ideas</button>') +
        '<a class="btn small ghost" href="' + esc(C.searchUrl(s.searchQuery)) + '" target="_blank" rel="noopener noreferrer nofollow">Search the web ↗</a></div></div>';
    }).join('') + '</div><p class="small muted" style="margin-top:10px">Ideas from AI - check prices and stock yourself. Nothing is saved until you tap Save.</p>';
  }
  function doAi() {
    var a = state.ai, p = byId(a.pid);
    if (!a || a.busy || !p) return;
    a.busy = true; drawAi();
    api('POST', 'api/ideas', C.aiBrief(p, aiOcc())).then(function (r) {
      a.busy = false; a.ideas = r.ideas || []; a.saved = {}; drawAi();
      say(plural(a.ideas.length, 'idea') + ' ready.');
    }).catch(function (e) {
      a.busy = false; drawAi();
      var out = $('#aiOut');
      if (e.status === 403 && e.data && e.data.code === 'verify-email') return verifyNote(out, e);
      showError(e, out);
    });
  }

  /* ---------------- wishlist links ---------------- */

  function wishUrl(token) { return location.origin + BASE + 'w/' + token; }
  function wishHtml(p) {
    if (p.sample) return '<b>Ask for their wishlist</b><p class="small" style="margin:4px 0 0">On your own people, this makes a link they can open with no app and no account: it shows only their first name and a box to add ideas. What they add lands here marked “from them”. (Not for the sample.)</p>';
    if (!p.wish) return '<b>Ask for their wishlist</b><p class="small" style="margin:4px 0 8px">A link they open with no app and no account. It shows only “' + esc(C.firstName(p.name)) + '” and a box to add ideas - never your list, so surprises stay surprises. It lasts ' + C.LIMITS.wishDays + ' days.</p><button class="btn small" type="button" data-act="wishmake" data-id="' + esc(p.id) + '">Make the link</button>';
    var url = wishUrl(p.wish.token);
    return '<b>Their wishlist link is open</b><p class="small" style="margin:4px 0 0">Send it to ' + esc(C.firstName(p.name)) + '. Their ideas arrive here marked “from them” each time you open Kindly.</p>' +
      '<div class="linkout">' + esc(url) + '</div>' +
      '<div class="row"><button class="btn small" type="button" data-act="wishshare" data-id="' + esc(p.id) + '">' + (navigator.share ? 'Share the link' : 'Copy the link') + '</button><button class="btn small ghost" type="button" data-act="wishcheck" data-id="' + esc(p.id) + '">Check for new ideas</button><button class="btn small danger" type="button" data-act="wishclose" data-id="' + esc(p.id) + '">Close the link</button></div>';
  }
  function wishMake(pid) {
    var p = byId(pid);
    if (!p || p.sample) return;
    api('POST', 'api/w', { first: C.firstName(p.name), today: today() }).then(function (r) {
      var c = copyOf(p); c.wish = { token: r.token, key: r.key, at: Date.now() };
      savePerson(c, 'Link ready - send it to ' + C.firstName(p.name) + '.');
      openPerson(pid); draw();
    }).catch(function (e) { showError(e); });
  }
  function wishShare(pid) {
    var p = byId(pid);
    if (!p || !p.wish) return;
    var url = wishUrl(p.wish.token);
    var text = 'I’d love to get you something you actually want - add a few ideas here (no app needed):';
    if (navigator.share) { navigator.share({ title: 'Your wishlist', text: text, url: url }).catch(function () { /* cancelled */ }); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(text + ' ' + url).then(function () { toast('Copied - paste it into a message.'); }, function () { toast('Copy the link from the box.'); });
  }
  /** Bring a friend's additions onto the list, then let the server drop
   *  them. Returns how many arrived. */
  function wishCollect(pid, loud) {
    var p = byId(pid);
    if (!p || !p.wish || p.sample) return Promise.resolve(0);
    var hdr = { 'X-Kindly-Key': p.wish.key };
    return api('GET', 'api/w/' + p.wish.token, null, hdr).then(function (r) {
      var adds = (r.w && r.w.adds) || [];
      if (!adds.length) { if (loud) toast('Nothing new from ' + C.firstName(p.name) + ' yet.'); return 0; }
      var c = copyOf(byId(pid));
      var have = {}; c.ideas.forEach(function (i) { have[i.id] = true; });
      var n = 0;
      adds.forEach(function (x) { if (!have[x.id] && c.ideas.length < C.LIMITS.ideas) { c.ideas.push({ id: x.id, text: x.text, link: x.link || '', price: x.price, status: 'idea', from: 'them', addedAt: x.at || Date.now() }); n++; } });
      savePerson(c, n ? plural(n, 'new idea') + ' from ' + C.firstName(p.name) + '!' : null);
      return api('POST', 'api/w/' + p.wish.token + '/collect', { ids: adds.map(function (x) { return x.id; }) }, hdr).then(function () { return n; }, function () { return n; });
    }).catch(function (e) {
      if (e.status === 404) { var c = copyOf(byId(pid)); c.wish = null; savePerson(c, loud ? 'That link has closed or expired. Make a new one any time.' : null); }
      else if (loud) showError(e);
      return 0;
    });
  }
  function wishCollectAll() {
    var list = state.people.filter(function (p) { return p.wish && !p.sample; });
    if (!list.length) return;
    Promise.all(list.map(function (p) { return wishCollect(p.id, false); })).then(function (ns) {
      if (ns.some(function (n) { return n > 0; })) { if ($('#sheet').hidden) draw(); else if (state.openId) openPerson(state.openId); }
    });
  }
  function wishClose(pid) {
    var p = byId(pid);
    if (!p || !p.wish) return;
    if (state.armed !== 'wish:' + pid) { state.armed = 'wish:' + pid; toast('Tap “Close the link” again to close it for good.'); return; }
    state.armed = null;
    var w = p.wish;
    wishCollect(pid, false).then(function () {
      return api('DELETE', 'api/w/' + w.token, null, { 'X-Kindly-Key': w.key }).catch(function () { return null; });
    }).then(function () {
      var c = copyOf(byId(pid)); c.wish = null; savePerson(c, 'Closed. The link no longer opens.'); openPerson(pid); draw();
    });
  }

  /* ---------------- the friend's page (w/<token>) ---------------- */

  var friend = { w: null, added: [], err: null };
  function drawFriend() {
    $('#tabbar').hidden = true; $('#topAdd').hidden = true; $('#acct').hidden = true;
    $('.brand').setAttribute('href', BASE);
    var w = friend.w;
    if (friend.err) {
      main.innerHTML = '<section class="wish"><p class="gift" aria-hidden="true">🎁</p><h1>This link has closed</h1><p class="lede">' + esc(friend.err) + '</p><p class="fine"><a href="' + esc(BASE) + '">What is Kindly?</a></p></section>';
      return;
    }
    if (!w) { main.innerHTML = '<p class="muted center" style="margin-top:40px">Opening…</p>'; return; }
    main.innerHTML = '<section class="wish"><p class="gift" aria-hidden="true">🎁</p><h1>Hi ' + esc(w.first) + '!</h1>' +
      '<p class="lede">Someone who cares about you wants to get it right. Add a few things you’d love - big or small, a link if you have one.</p>' +
      '<section class="card"><form id="wForm"><label class="field"><span>An idea</span><input class="input" id="wText" maxlength="' + C.LIMITS.idea + '" required autofocus placeholder="A good paperback, the blue one" autocomplete="off"></label>' +
      '<div class="two"><label class="field"><span>Link <span class="hint">(optional)</span></span><input class="input" id="wLink" type="url" inputmode="url" placeholder="https://" autocomplete="off"></label>' +
      '<label class="field"><span>About <span class="hint">(optional)</span></span><span class="money"><input class="input" id="wPrice" inputmode="decimal" placeholder="25"></span></label></div>' +
      '<div id="wErr"></div><button class="btn big block" type="submit"' + (w.room ? '' : ' disabled') + '>' + (w.room ? 'Add to my wishlist' : 'The list is full - thank you!') + '</button></form>' +
      (friend.added.length ? '<ul class="added" aria-label="Added just now">' + friend.added.map(function (a) { return '<li><b>✓ Added:</b> ' + esc(a.text) + (a.price !== null && a.price !== undefined ? ' · ' + esc(money(a.price)) : '') + '</li>'; }).join('') + '</ul>' : '') + '</section>' +
      '<p class="fine">You won’t see anything else on their list, and they won’t see anything but what you add here. No account needed. This link closes on ' + esc(fmt(String(w.expiresAt).slice(0, 10))) + '.</p>' +
      '<p class="fine"><a href="' + esc(BASE) + '">Kindly</a> - never miss the people who matter.</p></section>';
    var form = $('#wForm');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('button[type=submit]', form);
      var linkRaw = $('#wLink').value.trim();
      if (linkRaw && !C.cleanLink(linkRaw)) { $('#wErr').innerHTML = '<p class="err" role="alert">That link doesn’t look right - it needs to start with https://</p>'; return; }
      btn.disabled = true;
      api('POST', 'api/w/' + FRIEND + '/add', { text: $('#wText').value, link: linkRaw, price: $('#wPrice').value }).then(function (r) {
        friend.added.push(r.added); friend.w = r.w; drawFriend(); say('Added. Add another, or close this page.'); var t = $('#wText'); if (t) t.focus();
      }).catch(function (err) {
        btn.disabled = false;
        if (err.status === 404) { friend.err = err.message; drawFriend(); return; }
        $('#wErr').innerHTML = '<p class="err" role="alert">' + esc(err.message) + '</p>';
      });
    });
  }
  function startFriend() {
    document.title = 'A wishlist - Kindly';
    drawFriend();
    api('GET', 'api/w/' + FRIEND).then(function (r) { friend.w = r.w; drawFriend(); })
      .catch(function (e) { friend.err = e.status === 404 ? e.message : 'This page could not load. Check your connection and try again.'; drawFriend(); });
  }

  /* ---------------- settings and the calendar ---------------- */

  function icsFor(people, name) {
    var list = people.filter(function (p) { return C.datesOf(p).length; });
    if (!list.length) { toast('Add a date first.'); return; }
    download(name, C.buildIcs(list, { today: today(), nowMs: Date.now() }), 'text/calendar;charset=utf-8');
    toast('Calendar file downloaded - open it to add ' + (list.length === 1 ? 'the dates' : 'every date') + '.');
  }
  function openSettings() {
    var s = state.settings;
    sheet(head('Settings') +
      '<label class="field"><span>Orders usually take</span><select class="input" id="sShip">' + SHIPS.map(function (n) { return '<option value="' + n + '"' + (n === s.shipDays ? ' selected' : '') + '>' + n + ' days to arrive</option>'; }).join('') + '</select><span class="hint">For “order by Oct 26 to arrive” on Coming up.</span></label>' +
      '<div class="stack"><button class="btn ghost block" type="button" data-act="ics">📅 Download every date (.ics)</button>' +
      '<button class="btn danger block" type="button" data-act="wipe">Clear this phone</button></div>' +
      '<p class="small muted" style="margin-top:12px">Settings stay on this phone. ' + (signedIn() ? 'Clearing this phone leaves your account’s copy alone.' : '') + '</p>', function (root) {
      $('#sShip', root).addEventListener('change', function (e) { s.shipDays = Number(e.target.value); keep(K_SET, s); draw(); });
    });
  }

  /* ---------------- the account ---------------- */

  var FREE_LINE = 'Kindly works without an account. A free account keeps your circle on all your phones and unlocks “Gift ideas for them”, with $2 of AI credit. One account works across every app on this site.';
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
    sheet(head('Account') + '<p class="small muted" style="overflow-wrap:anywhere">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><b>Your circle</b><p class="small muted" style="margin:4px 0 0">' + (syncOn() ? 'Kept in your account, so it follows you to any phone you sign in on.' : 'Syncing isn’t available right now - your circle is safe on this phone.') + '</p></div>' +
      '<div class="note"><div class="row" style="justify-content:space-between"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">“Gift ideas for them” costs about a cent. Everything else in Kindly is free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>' +
      '<p class="small muted" style="margin-top:8px">Signing out keeps this phone’s copy of your circle.</p>',
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
    sheet(head('Out of AI credit') + '<p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Your people, dates, own ideas, budgets, wishlist links and the calendar keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });

  /* ---------------- one click listener ---------------- */

  function setTab(tab) {
    if (TABS.indexOf(tab) < 0) return;
    state.tab = tab; keep(K_TAB, tab);
    closeSheet(true); draw(); scrollTo(0, 0);
    var m = $('#main'); if (m) m.focus({ preventScroll: true });
  }
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'peopleSearch') {
      state.q = e.target.value;
      var pos = e.target.selectionStart;
      draw();
      var again = $('#peopleSearch'); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (x) { /* fine */ } }
    }
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var a = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    var f = state.form;
    if (a !== 'delete' && a !== 'wipe' && a !== 'wishclose') state.armed = null;
    switch (a) {
      case 'home': e.preventDefault(); if (!FRIEND) setTab('coming'); else location.href = BASE; break;
      case 'closesheet': closeSheet(); break;
      case 'tab': setTab(t.getAttribute('data-tab')); break;
      case 'sample':
        state.people = C.sample(today(), Date.now()).concat(state.people.filter(function (p) { return !p.sample; }));
        state.tab = 'coming'; saveLocal(); draw(); scrollTo(0, 0);
        toast('🧪 A made-up circle to play with. Nothing is saved anywhere.');
        break;
      case 'clearsample':
        state.people = state.people.filter(function (p) { return !p.sample; });
        saveLocal(); draw(); scrollTo(0, 0); toast('Sample cleared.');
        break;
      case 'mine':
        state.people = state.people.filter(function (p) { return !p.sample; });
        saveLocal(); draw(); openForm(null);
        break;
      case 'addperson': openForm(null); break;
      case 'open': openPerson(id); break;
      case 'edit': openForm(id, t.getAttribute('data-focus')); break;
      case 'quickidea': openQuickIdea(id); break;
      case 'pastgift': openPastGift(id); break;
      case 'buy': openMark(id, t.getAttribute('data-idea'), 'bought'); break;
      case 'give': openMark(id, t.getAttribute('data-idea'), 'given'); break;
      case 'unbuy': setIdea(id, t.getAttribute('data-idea'), { status: 'idea', occasion: null, year: null, doneAt: null }, 'Back on the ideas list.'); if (state.openId) openPerson(id); draw(); break;
      case 'delidea': {
        var key = 'idea:' + t.getAttribute('data-idea');
        if (state.armed !== key) { state.armed = key; t.textContent = 'Tap again'; break; }
        setIdea(id, t.getAttribute('data-idea'), { _del: true }, 'Deleted.');
        if (state.openId) openPerson(id); draw();
        break;
      }
      case 'budget': {
        var bp = byId(id), k = t.getAttribute('data-key');
        var inp = $('#bud-' + k);
        if (!bp || !inp) break;
        var cents = inp.value.trim() ? C.parseMoney(inp.value) : 0;
        if (cents === null) { toast('That doesn’t look like an amount.'); break; }
        var bc = copyOf(bp); bc.budgets = Object.assign({}, bc.budgets); if (cents) bc.budgets[k] = cents; else delete bc.budgets[k];
        savePerson(bc, cents ? 'Budget set: ' + money(cents) + '.' : 'Budget removed.'); openPerson(id); draw();
        break;
      }
      case 'delete': {
        if (state.armed !== 'delete:' + id) { state.armed = 'delete:' + id; t.textContent = 'Tap again to delete'; break; }
        var dp = byId(id);
        if (dp && dp.wish) api('DELETE', 'api/w/' + dp.wish.token, null, { 'X-Kindly-Key': dp.wish.key }).catch(function () { /* it expires anyway */ });
        state.people = state.people.filter(function (p) { return p.id !== id; });
        saveLocal(); dropPerson(id); closeSheet(true); draw(); toast('Deleted.');
        break;
      }
      case 'wipe': {
        if (state.armed !== 'wipe') { state.armed = 'wipe'; t.textContent = 'Tap again to clear everyone'; break; }
        state.people = []; saveLocal(); closeSheet(true); draw(); toast('Cleared from this phone.');
        break;
      }
      case 'ics': icsFor(state.people, 'kindly-dates.ics'); break;
      case 'icsone': { var op = byId(id); if (op) icsFor([op], 'kindly-' + C.fold(op.name).replace(/ /g, '-').slice(0, 30) + '.ics'); break; }
      case 'settings': openSettings(); break;
      // the form
      case 'rel': f.relationship = t.getAttribute('data-rel'); $$('[data-act="rel"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); break;
      case 'adddate': f.dates.push({ id: null, label: '', m: '', d: '', y: '', leap: 'feb28' }); drawForm(); setTimeout(function () { var l = $$('[data-cl]'); if (l.length) l[l.length - 1].focus(); }, 40); break;
      case 'rmdate': f.dates.splice(Number(t.getAttribute('data-i')), 1); drawForm(); break;
      // AI
      case 'ai': openAi(id, t.getAttribute('data-key')); break;
      case 'aiocc': state.ai.key = t.getAttribute('data-key'); state.ai.ideas = null; drawAi(); break;
      case 'doai': doAi(); break;
      case 'aisave': {
        var ai = state.ai, i = Number(t.getAttribute('data-i')), s = ai && ai.ideas && ai.ideas[i];
        if (!s) break;
        if (addIdea(ai.pid, { text: s.title, from: 'ai' })) { ai.saved[i] = true; $('#aiOut').innerHTML = aiResults(); draw(); }
        break;
      }
      case 'signup': { var a1 = state.ai; openAccount(null, function () { if (a1) openAi(a1.pid, a1.key); }); break; }
      case 'signin': { var a2 = state.ai; openAccount(null, function () { if (a2) openAi(a2.pid, a2.key); }, true); break; }
      // wishlists
      case 'wishmake': wishMake(id); break;
      case 'wishshare': wishShare(id); break;
      case 'wishcheck': wishCollect(id, true).then(function (n) { if (n) { openPerson(id, 'ideas'); draw(); } }); break;
      case 'wishclose': wishClose(id); break;
      default: break;
    }
  });

  /* ---------------- start ---------------- */

  if (FRIEND) { startFriend(); return; }
  loadLocal();
  draw();
  loadMe().then(function () { return syncOn() ? syncIn(false) : null; }).then(wishCollectAll);
  // The day can turn while the app sits in the background, and a friend may
  // have added ideas: redraw and collect on return.
  var lastDay = today();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (today() !== lastDay) { lastDay = today(); if ($('#sheet').hidden) draw(); }
    wishCollectAll();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }
}());
