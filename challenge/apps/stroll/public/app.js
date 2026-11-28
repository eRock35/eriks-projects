/* Stroll - the page. One file, no build step.
 *
 * The rules (what a passport holds, when stamping is open, how far a card
 * has got, the draw, the words on a sign) are StrollCore's; what this phone
 * remembers goes through stroll-store.js (the phone's own storage, with a
 * memory fallback). The made-up street is changed by the same rules, in memory,
 * and is never kept or sent.
 *
 * The requests this page makes: a passport (start, join with a code and a
 * first name, stamp with a counter's code, the organizer's changes, the
 * list of cards, the draw, leave, delete), a re-read every 10 seconds while
 * an ORGANIZER's page is visible (a shopper's re-reads when it comes back
 * to the front), sign-in, and the account's list of kept passports. No
 * location, no contacts, no camera stream (the phone's own camera app reads
 * a sign's square and opens this page), no notifications, no model.
 *
 * A SHOPPER'S PHONE IS NEVER SENT a counter code or a count, so this page
 * cannot show one there.
 *
 * Offline: sw.js keeps the page's own files and the store keeps the last
 * copy of the passport, so the stamps and the shops open with no signal. A
 * stamp needs the network - stamps are NOT saved up for later - and the
 * page says so.
 *
 * Every string a person typed or the server sent is escaped before it is
 * drawn, no handler is written into markup (clicks are routed by data-act
 * from one listener - the lab's CSP allows script from this origin only),
 * and no style attribute is written: a bar's width and a stamp's tilt are
 * classes.
 */
(function () {
  'use strict';

  var C = window.StrollCore;
  var D = window.StrollDemo;
  var S = window.StrollStore;
  var QR = window.StrollQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var HERE = location.origin + BASE;
  var esc = C.esc, plural = C.plural;
  var POLL_MS = 10000;
  var TABS = S.TABS;
  var OFFLINE_STAMPS = 'Getting a stamp needs a signal - stamps are not saved up for later.';
  var CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.500 4.500 4.500L19 7"/></svg>';

  var real = S.local();
  var state = {
    me: null, view: 'home', g: null, demo: null, demoRole: 'card',
    list: real.getList(), prefs: real.getPrefs(), offline: false, just: '', stale: false,
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    if (!body && method === 'POST') body = {};
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
    toastTimer = setTimeout(function () { t.remove(); }, ms || 3200);
  }
  function say(msg) { var l = $('#live'); l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); }
  function showError(err, where) {
    var msg = err && err.message ? err.message : 'Something went wrong.';
    if (err instanceof TypeError) msg = 'You look offline. ' + OFFLINE_STAMPS;
    if (where) { where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; } else toast(msg, 4500);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function localToday() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 101).slice(1) + '-' + String(d.getDate() + 100).slice(1); }
  function today() { return state.demo ? D.TODAY : localToday(); }
  function savePrefs() { real.putPrefs(state.prefs); }
  function isHost() { return Boolean(state.g && state.g.role === 'host'); }
  function tabsOf(g) { return g.role === 'host' ? S.HOST_TABS : S.CARD_TABS; }
  function remember(g) {
    if (state.demo || !g) return;
    state.list = [{ id: g.id, title: g.title, place: g.place, from: g.from, to: g.to, role: g.role }].concat(state.list.filter(function (x) { return x.id !== g.id; }));
    real.putList(state.list); state.list = real.getList();
    real.putLast(g, Date.now());
  }
  function forgetLocal(id) {
    state.list = state.list.filter(function (x) { return x.id !== id; }); real.putList(state.list);
    if (state.prefs.cur === id) { state.prefs.cur = ''; savePrefs(); real.clearLast(); }
  }
  function randCode(n) { var s = ''; for (var i = 0; i < n; i++) s += C.CODE_ALPHABET[Math.floor(Math.random() * C.CODE_ALPHABET.length)]; return s; }
  function dice(n) { return Math.floor(Math.random() * n); }

  /* ---------------- the passport on screen ---------------- */

  var pollTimer = null;
  function inside() { return Boolean(state.g && TABS.indexOf(state.view) >= 0); }
  function wantPoll() { return Boolean(inside() && !state.demo && isHost() && document.visibilityState === 'visible'); }
  function schedulePoll(ms) { clearTimeout(pollTimer); if (wantPoll()) pollTimer = setTimeout(poll, ms === undefined ? POLL_MS : ms); }
  function reread() {
    if (!inside() || state.demo) return Promise.resolve();
    var id = state.g.id;
    return api('GET', 'api/s/' + encodeURIComponent(id) + '?since=' + encodeURIComponent(state.g.t || '')).then(function (r) {
      if (!state.g || state.g.id !== id) return;
      var was = state.offline; state.offline = false;
      if (r.g) { adopt(r.g); if ($('#sheet').hidden) redraw(); else state.stale = true; } else if (was) redraw();
    }).catch(function (err) {
      if (err.status === 404) return gone(id);
      if (err instanceof TypeError && !state.offline) { state.offline = true; if ($('#sheet').hidden) redraw(); }
    });
  }
  function poll() { if (wantPoll()) reread().then(function () { schedulePoll(); }); }
  function adopt(g) { state.g = g; remember(g); }
  function gone(id) {
    forgetLocal(id);
    if (state.g && state.g.id === id) { state.g = null; closeSheet(true); go('home'); toast('That passport isn’t here any more.', 4500); }
  }
  function firstTab(g) { return g.role === 'host' ? (g.shops.length ? 'overview' : 'shops') : 'passport'; }
  function show(g, tab) {
    state.demo = null; adopt(g);
    state.prefs.cur = g.id; state.view = tab && tabsOf(g).indexOf(tab) >= 0 ? tab : firstTab(g); state.prefs.tab = state.view; savePrefs();
    history.replaceState(null, '', BASE + '#' + state.view); draw(); scrollTo(0, 0); schedulePoll();
  }
  function enter(id, tab) {
    return api('GET', 'api/s/' + encodeURIComponent(id)).then(function (r) { state.offline = false; show(r.g, tab); }).catch(function (err) {
      var last = real.getLast();
      if (err instanceof TypeError && last && last.g.id === id) { state.offline = true; show(last.g, tab); return; }
      if (err.status === 404) { forgetLocal(id); state.g = null; state.view = 'home'; draw(); toast('That passport isn’t here any more.', 4500); return; }
      state.view = 'home'; draw(); showError(err);
    });
  }
  function demoView() {
    var d = state.demo;
    state.g = state.demoRole === 'host'
      ? C.view(d.doc, { role: 'host' }, { today: D.TODAY, counts: D.counts(d.doc, d.cards) })
      : C.view(d.doc, { role: 'card', card: d.cards[0], tag: D.ME }, { today: D.TODAY });
  }
  /** An organizer's change: through the one route - or, in the example,
   *  through the same rules in memory. */
  function act(action, done) {
    if (state.demo) {
      try {
        var n = action.shops ? action.shops.length : 1, ids = [], codes = [];
        for (var i = 0; i < n; i++) ids.push(C.newId(dice, 8, 's'));
        for (var j = 0; j < n * 3 + 8; j++) codes.push(randCode(C.STAMP_LEN));
        state.demo.doc = C.patch(state.demo.doc, C.act(state.demo.doc, action, { now: D.NOW + state.demo.doc.v, today: D.TODAY, ids: ids, codes: codes }));
        state.demo.doc.v++; demoView(); redraw(); if (done) done();
      } catch (err) { showError(err, $('#formErr')); }
      return;
    }
    api('POST', 'api/s/' + encodeURIComponent(state.g.id) + '/act', { action: action }).then(function (r) { adopt(r.g); redraw(); if (done) done(); })
      .catch(function (err) { if (err.status === 404 && err.data && err.data.code === 'gone') return gone(state.g.id); showError(err, $('#formErr')); });
  }
  function stamped(g, shopId, isNew, justDone) {
    var s = C.shopOf(g, shopId), name = s ? s.name : 'that shop';
    state.just = isNew ? shopId : '';
    closeSheet(true);
    if (state.view !== 'passport') { state.view = 'passport'; history.replaceState(null, '', BASE + '#passport'); }
    draw(); state.just = '';
    var msg = isNew ? 'Stamped: ' + name + '.' + (justDone ? ' You’re in the draw!' : '') : 'You already have ' + name + '’s stamp.';
    toast(msg, 4500); say(msg);
  }
  function doStamp(code, where) {
    if (state.demo) {
      try {
        var card = state.demo.cards[0], before = C.progress(state.demo.doc, card);
        var r = C.stamp(state.demo.doc, card, code, { now: D.NOW, today: D.TODAY });
        if (r.isNew) card.stamps[r.shop] = D.NOW;
        state.demoRole = 'card'; demoView();
        stamped(state.g, r.shop, r.isNew, !before.done && state.g.me.done);
      } catch (err) { showError(err, where); }
      return Promise.resolve();
    }
    return api('POST', 'api/s/' + encodeURIComponent(state.g.id) + '/stamp', { code: code }).then(function (r) { adopt(r.g); stamped(r.g, r.shop, r.isNew, r.justDone); })
      .catch(function (err) { if (err.status === 404 && err.data && err.data.code === 'gone') return gone(state.g.id); showError(err, where); });
  }

  /* ---------------- routing and drawing ---------------- */

  function go(view) { history.pushState(null, '', BASE + '#' + view); route(); scrollTo(0, 0); }
  function route() {
    var h = location.hash.replace(/^#/, '');
    var join = /^join=([A-Za-z0-9-]{4,12})$/.exec(h);
    var st = /^stamp=([A-Za-z0-9]{6})\.([A-Za-z0-9]{4})$/.exec(h);
    if (join) { history.replaceState(null, '', BASE + '#home'); arrive(C.normalizeCode(join[1]), ''); return; }
    if (st) { history.replaceState(null, '', BASE + '#home'); arrive(C.normalizeCode(st[1]), C.normalizeCode(st[2])); return; }
    if (h === 'try') { startDemo(); return; }
    if (state.g && tabsOf(state.g).indexOf(h) >= 0) { state.view = h; if (!state.demo) { state.prefs.tab = h; savePrefs(); } }
    else if (h === 'new') state.view = 'new';
    else state.view = 'home';
    draw(); schedulePoll();
  }
  /** A scanned link: a poster's (join) or a counter's (join if need be,
   *  then stamp). */
  function arrive(code, k) {
    state.demo = null;
    if (!state.g) { state.view = 'home'; draw(); }
    api('GET', 'api/join/' + code).then(function (p) {
      if (!p.already) { joinSheet(code, k); return; }
      return enter(p.already).then(function () {
        if (!k || !state.g) return;
        if (state.g.role === 'host') {
          var hit = state.g.shops.filter(function (s) { return s.k === k; })[0];
          toast(hit ? 'That’s ' + hit.name + '’s sign - it works. Stamps are for shoppers’ passports.' : 'That code isn’t one of your shops’ any more - reprint that sign.', 6000);
        } else return doStamp(k);
      });
    }).catch(function (err) { if (!state.g) { state.view = 'home'; draw(); } showError(err); });
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }
  function redraw() { keepPlace(draw); }
  function draw() {
    var inG = inside(), role = inG ? state.g.role : '';
    $('#tabbar').hidden = !inG; $('#topnav').hidden = !inG;
    $$('[data-tab]').forEach(function (b) {
      b.hidden = b.dataset.role !== role;
      if (b.dataset.tab === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    var m = $('#main'), v = state.view;
    m.className = 'wrap' + (v === 'signs' || v === 'overview' ? '' : ' narrow');
    m.innerHTML = !inG ? (v === 'new' ? newHtml() : homeHtml())
      : v === 'overview' ? overviewHtml() : v === 'shops' ? shopsHtml() : v === 'signs' ? signsHtml() : v === 'draw' ? drawHtml()
        : v === 'perks' ? perksHtml() : v === 'about' ? aboutHtml() : passportHtml();
    document.title = (inG ? state.g.title + ' · ' : '') + 'Stroll';
    if (v === 'new' && !inG) wireNew();
  }
  function ribbon() {
    if (state.demo) return '<p class="ribbon">' + esc(D.NOTICE) + ' You are looking as ' + (isHost() ? 'Ana, the organizer' : 'a shopper with three stamps') + '. <button class="link-btn" type="button" data-act="demoswap">See it as ' + (isHost() ? 'a shopper' : 'the organizer') + '</button> · <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>';
    if (state.offline) return '<p class="ribbon" role="status">You’re offline - this is the passport as this phone last saw it. ' + esc(OFFLINE_STAMPS) + '</p>';
    return '';
  }
  function chip(kind, label) { return '<span class="chip ' + kind + '">' + esc(label) + '</span>'; }
  function headHtml(extra) {
    var g = state.g;
    return ribbon() + '<div class="g-head"><h1>' + esc(g.title) + '</h1><p class="sub">' + (g.place ? esc(g.place) + ' · ' : '') + esc(C.dateRange(g.from, g.to)) + ' · ' + esc(C.whenLine(g, today())) + '</p>' + (extra || '') + '</div>';
  }
  function twentieths(n, of) { return of > 0 ? Math.max(n > 0 ? 1 : 0, Math.min(20, Math.round(n * 20 / of))) : 0; }

  /* ---------------- home and setup ---------------- */

  function homeHtml() {
    var mine = state.list.length ? '<section class="section"><h2 class="section-title">On this phone</h2><ul class="list">' + state.list.map(function (g) {
      return '<li><button class="item" type="button" data-act="open" data-id="' + esc(g.id) + '"><span class="grow"><span class="t">' + esc(g.title) + '</span><br><span class="s">' + (g.place ? esc(g.place) + ' · ' : '') + (g.from ? esc(C.dateRange(g.from, g.to)) : '') + '</span></span>' + chip(g.role === 'host' ? 's-way' : 's-done', g.role === 'host' ? 'Organizer' : 'My passport') + '</button></li>';
    }).join('') + '</ul></section>' : '';
    return '<section class="hero"><h1>A shop-local passport for your street.</h1>' +
      '<p class="lede">A stamp at every counter, a prize at the end. Shoppers scan the sign at each shop with their phone’s camera - no app, no sign-up - and finished passports go into your prize draw. You see which shops they reached.</p>' +
      '<div class="btn-row"><button class="btn" type="button" data-act="new">Start a passport</button><button class="btn ghost" type="button" data-act="join">I have a code</button></div>' +
      '<p class="quietline"><button class="link-btn" type="button" data-act="demo">See a made-up street first</button></p></section>' + mine +
      '<section class="section"><h2 class="section-title">How it works</h2><ol class="steps">' +
      '<li><span class="n">1</span><div><b>Name it and list the shops.</b><br><span class="muted">Say how many stamps finish a passport and what the prize is. A minute, no account.</span></div></li>' +
      '<li><span class="n">2</span><div><b>Print a sign for every counter.</b><br><span class="muted">Each has its own square to scan and a four-letter code, plus one poster to start a passport.</span></div></li>' +
      '<li><span class="n">3</span><div><b>Shoppers collect stamps.</b><br><span class="muted">One per shop, with their own phone and a first name. Each shop can offer passport holders a perk.</span></div></li>' +
      '<li><span class="n">4</span><div><b>Draw the winner.</b><br><span class="muted">Every finished passport is in; the winner’s phone shows a claim code. You keep the counts: passports, stamps, and visits shop by shop.</span></div></li></ol>' +
      '<p class="small muted mt24">Free, and nobody signs in. Stroll never asks a shopper for an email or a phone number - a first name is all it keeps.</p></section>';
  }
  function strollFields(g) {
    g = g || { title: '', place: '', from: localToday(), to: localToday(), goalSet: 5, bonus: true, prize: '' };
    return '<label class="field"><span>The passport’s name</span><input class="input" name="title" maxlength="60" autocomplete="off" placeholder="Maple Street Shop Small Passport" value="' + esc(g.title) + '"></label>' +
      '<label class="field"><span>The street or town (optional)</span><input class="input" name="place" maxlength="60" autocomplete="off" placeholder="Maple Street, Riverton" value="' + esc(g.place) + '"></label>' +
      '<div class="two"><label class="field"><span>First day</span><input class="input" name="from" type="date" value="' + esc(g.from) + '"></label><label class="field"><span>Last day</span><input class="input" name="to" type="date" value="' + esc(g.to) + '"></label></div>' +
      '<label class="field"><span>Stamps that finish a passport</span><input class="input" name="goal" inputmode="numeric" maxlength="2" autocomplete="off" value="' + esc(String(g.goalSet)) + '"></label>' +
      '<label class="check"><input type="checkbox" name="bonus"' + (g.bonus ? ' checked' : '') + '><span>Every stamp after that is one more entry in the draw</span></label>' +
      '<label class="field"><span>The prize (optional)</span><input class="input" name="prize" maxlength="120" autocomplete="off" placeholder="A $100 basket from the shops" value="' + esc(g.prize) + '"></label>';
  }
  function strollBody(f) { return { title: f.title.value, place: f.place.value, from: f.from.value, to: f.to.value, goal: f.goal.value.trim(), bonus: f.bonus.checked, prize: f.prize.value }; }
  function linesOf(v) { return String(v || '').split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function newHtml() {
    return '<h1>Start a passport</h1><p class="lede mt8">You can change all of this later.</p><form id="newForm" class="mt24" novalidate>' +
      '<label class="field"><span>Your first name</span><input class="input" name="name" maxlength="20" autocomplete="given-name" value="' + esc(state.prefs.name) + '"></label>' + strollFields(null) +
      '<label class="field"><span>The shops, one to a line (add more later)</span><textarea class="input" name="shops" maxlength="2400" placeholder="Juniper &amp; Wren&#10;Dog-Eared Books&#10;Crumb Bakery"></textarea></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Make the passport</button></form>';
  }
  function wireNew() {
    var f = $('#newForm');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var b = strollBody(f); b.name = f.name.value; b.shops = linesOf(f.shops.value);
      var btn = $('button[type=submit]', f); btn.disabled = true;
      api('POST', 'api/strolls', b).then(function (r) {
        state.prefs.name = C.cleanName(f.name.value) || state.prefs.name;
        show(r.g); toast(r.g.shops.length ? 'Made. Next: print the signs.' : 'Made. Next: add the shops.', 4500);
        if (signedIn()) syncMine();
      }).catch(function (err) { btn.disabled = false; showError(err, $('#formErr')); });
    });
  }

  /* ---------------- a shopper: the passport, the shops, the prize ---------------- */

  function passportHtml() {
    var g = state.g, me = g.me, p = { of: g.shops.length, all: me.all, done: me.done, entries: me.entries, left: me.left };
    var won = g.won ? '<div class="won" role="status"><p><b>You won' + (g.prize ? ': ' + esc(g.prize) : ' the draw') + '!</b></p><p>Show this screen to ' + esc(g.host || 'the organizer') + (g.won.given ? ' - marked as handed over.' : ' to collect it. Your claim code:') + '</p><p class="code">' + esc(C.formatCode(g.won.claim)) + '</p></div>' : '';
    var count = '<p class="pp-count"><b>' + me.n + '</b><span>of ' + (me.done ? g.shops.length + ' shops stamped' : plural(g.goal, 'stamp')) + '</span></p><p class="pp-line">' + esc(me.removed ? 'The organizer removed this passport from the draw.' : C.progressLine(p)) + '</p>' +
      (me.done ? '' : '<div class="bar" role="img" aria-label="' + me.n + ' of ' + g.goal + ' stamps"><i class="p' + twentieths(me.n, g.goal) + '"></i></div>');
    var btn = !g.shops.length ? '' : me.all ? '' : g.open
      ? '<div class="stampbar"><button class="btn block" type="button" data-act="stamp">Stamp my passport</button><p class="small muted center mt8">At a counter? Scan the square on its sign with your camera - or tap here and type its four letters.</p></div>'
      : '<p class="ribbon mt24">' + esc(C.phase(g, today()) === 'before' ? 'Stamps open ' + C.dayLong(g.from) + '.' : 'This passport has ended - stamps are closed.') + '</p>';
    var grid = '<ul class="stamps">' + g.shops.map(function (s, i) {
      return '<li><span class="stamp' + (s.got ? ' got r' + (i % 5) + (state.just === s.id ? ' just' : '') : '') + '">' + (s.got ? CHECK : i + 1) + '</span><span class="nm">' + esc(s.name) + '</span><span class="st">' + (s.got ? 'Stamped' : 'Not yet') + '</span></li>';
    }).join('') + '</ul>';
    return headHtml() + won + count + btn + (g.shops.length ? grid : '<p class="empty">The organizer hasn’t added the shops yet. Check back soon.</p>');
  }
  function perksHtml() {
    var g = state.g;
    return headHtml() + '<section class="section"><h2 class="section-title">The shops</h2><p class="muted small">Show your passport at the counter for a shop’s perk.</p><ul class="list">' + g.shops.map(function (s) {
      return '<li><div class="item"><span class="grow"><span class="t">' + esc(s.name) + '</span><br><span class="s">' + esc(s.perk || 'A stamp for your passport') + '</span></span>' + chip(s.got ? 's-ok' : 's-done', s.got ? 'Stamped' : 'Not yet') + '</div></li>';
    }).join('') + '</ul>' + (g.shops.length ? '' : '<p class="empty">No shops yet.</p>') + '</section>';
  }
  function rulesHtml(g) { return '<ul class="list">' + C.rules(g).map(function (r) { return '<li><div class="item"><span class="grow">' + esc(r) + '</span></div></li>'; }).join('') + '</ul>'; }
  function aboutHtml() {
    var g = state.g, after = C.phase(g, today()) === 'after';
    var winners = g.winners.length ? '<p class="big mt16">Drawn: ' + esc(g.winners.map(function (w) { return w.name; }).join(', ')) + '</p>' + (g.won ? '<p>That’s you - your claim code is on the Passport tab.</p>' : '<p class="muted">If a winner doesn’t collect, the organizer may draw again - so it’s worth another look.</p>')
      : '<p class="mt16">' + esc(g.host || 'The organizer') + ' draws the winner ' + (after ? 'soon' : 'after ' + C.dayLong(g.to)) + '. <b>Open this page then</b>: if you win, a claim code shows here. Stroll can’t message you - it never asked for your email or your number.</p>';
    return headHtml() + '<section class="section"><h2 class="section-title">The prize</h2><p class="big">' + esc(g.prize || 'A prize draw for finished passports') + '</p>' + winners + '</section>' +
      '<section class="section"><h2 class="section-title">How it works</h2>' + rulesHtml(g) + '</section>' +
      '<section class="section"><h2 class="section-title">Your passport</h2><p class="muted small">You’re on it as <b>' + esc(g.me.name) + '</b>. It lives on this phone’s browser - open the same link here to come back to it. Nothing else about you is kept.</p>' +
      '<div class="btn-row"><button class="btn ghost small" type="button" data-act="shareshopper">Tell a friend</button><button class="btn danger small" type="button" data-act="leave">Tear up my passport</button></div></section>';
  }

  /* ---------------- the organizer ---------------- */

  function qr(url, label) { return QR ? '<div class="qrbox">' + QR.svg(url, label) + '</div>' : ''; }
  function joinUrl() { return state.demo ? HERE + '#try' : C.joinLink(HERE, state.g.code); }
  function overviewHtml() {
    var g = state.g, max = g.shops.reduce(function (m, s) { return Math.max(m, s.count); }, 0);
    var shops = g.shops.slice().sort(function (a, b) { return b.count - a.count; });
    var bars = g.shops.length ? '<ul class="shopbars">' + shops.map(function (s) {
      return '<li><div class="row"><span class="t">' + esc(s.name) + '</span><span class="n">' + s.count + '</span></div><div class="bar" aria-hidden="true"><i class="p' + twentieths(s.count, max) + '"></i></div></li>';
    }).join('') + '</ul>' : '<p class="empty">No shops yet. <button class="link-btn" type="button" data-act="tab" data-tab="shops">Add the shops</button></p>';
    var dmax = g.days.reduce(function (m, d) { return Math.max(m, d.n); }, 0);
    var days = g.days.length > 1 ? '<section class="section"><h2 class="section-title">Stamps by day</h2><ul class="shopbars">' + g.days.map(function (d) {
      return '<li><div class="row"><span class="t">' + esc(C.dayLong(d.day)) + '</span><span class="n">' + d.n + '</span></div><div class="bar" aria-hidden="true"><i class="p' + twentieths(d.n, dmax) + '"></i></div></li>';
    }).join('') + '</ul><p class="small muted mt8">Days are counted in UTC, so a late evening can land on the next day.</p></section>' : '';
    return headHtml('<p class="quietline"><button class="link-btn" type="button" data-act="details">Edit the details</button></p>') +
      '<dl class="figs"><div><dt>Passports</dt><dd>' + g.counts.cards + '</dd></div><div><dt>Stamps</dt><dd>' + g.counts.stamps + '</dd></div><div><dt>Finished</dt><dd>' + g.counts.done + '</dd></div></dl>' +
      '<p class="small muted mt8">' + plural(g.goal, 'stamp') + ' finish a passport. Counted as they happen; opening the passports recounts them exactly.</p>' +
      '<section class="section"><h2 class="section-title">Visits by shop</h2>' + bars + '<div class="addbar"><button class="btn ghost small" type="button" data-act="cards">See the passports</button></div></section>' + days +
      '<section class="section"><h2 class="section-title">Invite shoppers</h2><p class="muted small">The poster on the Signs tab carries this square. Or send the link.</p><p class="code">' + esc(C.formatCode(g.code)) + '</p>' + qr(joinUrl(), 'QR code that starts a passport') +
      '<div class="btn-row"><button class="btn small" type="button" data-act="share">Share the link</button><button class="btn ghost small" type="button" data-act="copylink">Copy the link</button></div></section>' +
      '<section class="section"><h2 class="section-title">This passport</h2><p class="muted small">It lives on this phone’s browser' + (signedIn() ? ' and on your account' : '. Sign in (free) to open it as the organizer on your other phone') + '. It deletes itself a month after its last day.</p><button class="btn danger small" type="button" data-act="delete">Delete this passport</button></section>';
  }
  function shopsHtml() {
    var g = state.g;
    return headHtml() + '<section class="section"><div class="section-title"><h2>The shops</h2><span class="tag">' + g.shops.length + ' of ' + C.LIMITS.shops + '</span></div>' +
      (g.shops.length ? '<p class="muted small">Tap a shop to add a perk, rename it or change its counter code.</p><ul class="list">' + g.shops.map(function (s) {
        return '<li><button class="item" type="button" data-act="editshop" data-id="' + esc(s.id) + '"><span class="grow"><span class="t">' + esc(s.name) + '</span><br><span class="s">' + esc(s.perk || 'No perk yet') + '</span></span><span class="kcode" aria-label="Counter code ' + esc(s.k) + '">' + esc(s.k) + '</span></button></li>';
      }).join('') + '</ul>' : '<p class="empty">Add the shops taking part. Each gets its own sign and counter code.</p>') +
      '<div class="addbar"><button class="btn" type="button" data-act="addshops">Add shops</button>' + (g.shops.length ? '<button class="btn ghost" type="button" data-act="tab" data-tab="signs">Print the signs</button>' : '') + '</div></section>';
  }
  function signHtml(s) {
    var g = state.g, x = C.sign(g, s, HERE), url = state.demo ? HERE + '#try' : x.url;
    return '<li data-sign="' + esc(s.id) + '"><div class="sign"><p class="sg-over">' + esc(x.over) + '</p><p class="sg-head">' + esc(x.head) + '</p><p class="sg-sub">' + esc(x.shop) + '</p>' +
      (x.perk ? '<p class="sg-line"><b>Passport perk:</b> ' + esc(x.perk) + '</p>' : '') + qr(url, 'QR code for a stamp at ' + x.shop) +
      '<p class="sg-line">' + esc(x.how) + '</p><p class="sg-fine">Or open your passport and type</p><p class="sg-code">' + esc(x.code) + '</p>' +
      '<p class="sg-fine">' + esc(x.when) + (x.prize ? ' · Prize: ' + esc(x.prize) : '') + '</p></div>' +
      '<div class="sign-acts"><button class="btn ghost small" type="button" data-act="print" data-id="' + esc(s.id) + '">Print this one</button></div></li>';
  }
  function posterHtml() {
    var g = state.g, x = C.poster(g, HERE);
    return '<li data-sign="poster"><div class="sign"><p class="sg-over">' + esc((x.place ? x.place + ' · ' : '') + x.when) + '</p><p class="sg-head">' + esc(x.head) + '</p>' +
      (x.prize ? '<p class="sg-sub">Win: ' + esc(x.prize) + '</p>' : '') + qr(joinUrl(), 'QR code that starts a passport') + '<p class="sg-line">' + esc(x.how) + '</p>' +
      x.rules.map(function (r) { return '<p class="sg-fine">' + esc(r) + '</p>'; }).join('') +
      (x.shops.length ? '<p class="sg-shops">' + esc(x.shops.join(' · ')) + '</p>' : '') + '</div>' +
      '<div class="sign-acts"><button class="btn ghost small" type="button" data-act="print" data-id="poster">Print the poster</button></div></li>';
  }
  function signsHtml() {
    var g = state.g;
    return headHtml() + '<section class="section"><div class="section-title noprint"><h2>Signs</h2></div><p class="muted small noprint">One poster to start a passport, and one sign for each counter. They print one to a page. A sign’s square and code are what give a stamp - keep each at its own counter.</p>' +
      '<div class="addbar noprint mb16"><button class="btn" type="button" data-act="print" data-id="">Print them all</button></div>' +
      '<ul class="signs">' + posterHtml() + g.shops.map(signHtml).join('') + '</ul></section>';
  }
  function printSigns(id) {
    $$('.signs > li').forEach(function (li) { li.classList.toggle('skip', Boolean(id) && li.dataset.sign !== id); });
    window.print();
  }
  function drawHtml() {
    var g = state.g, ph = C.phase(g, today()), full = g.winners.length >= C.LIMITS.winners;
    var winners = g.winners.length ? '<section class="section"><h2 class="section-title">' + (g.winners.length === 1 ? 'The winner' : 'The winners') + '</h2><ul class="list">' + g.winners.map(function (w, i) {
      return '<li><div class="item"><span class="grow"><span class="t">' + esc(w.name) + '</span><br><span class="s">Claim code <span class="kcode">' + esc(C.formatCode(w.claim)) + '</span>' + (g.winners.length > 1 ? ' · draw ' + (i + 1) : '') + '</span></span>' +
        (w.given ? chip('s-ok', 'Handed over') : '<button class="btn ghost small" type="button" data-act="given" data-id="' + esc(w.tag) + '">Handed over</button>') + '</div></li>';
    }).join('') + '</ul><p class="small muted mt8">The winner’s own phone shows the same claim code on their passport. Match the code before you hand the prize over. Stroll can’t contact them - if nobody collects, draw again.</p></section>' : '';
    return headHtml() + '<section class="section"><h2 class="section-title">The draw</h2><p class="big">' + esc(g.prize || 'No prize typed yet') + '</p>' +
      '<p>' + (g.counts.done ? plural(g.counts.done, 'finished passport') + ' so far.' : 'Nobody has finished a passport yet.') + ' ' + (ph === 'after' ? 'The passport has ended.' : ph === 'before' ? 'It hasn’t started.' : 'It’s still running - most organizers draw after the last day.') + '</p>' +
      rulesHtml(g) + '<div id="formErr"></div><div class="addbar"><button class="btn" type="button" data-act="draw"' + (full ? ' disabled' : '') + '>' + (g.winners.length ? 'Draw another winner' : 'Draw the winner') + '</button></div>' +
      '<p class="small muted mt16">The server rolls the dice: every entry has the same chance, a removed passport is out, and nobody wins twice.</p></section>' + winners;
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    clearTimeout(toastTimer);
    $$('.toast').forEach(function (t) { t.remove(); });
    s.innerHTML = '<button class="btn small ghost close" type="button" data-act="closesheet">Close</button><div class="body">' + html + '</div>';
    s.hidden = false; back.hidden = false; document.body.classList.add('sheet-open'); s.scrollTop = 0;
    if (onOpen) onOpen(s);
    var f = s.querySelector('h2'); if (f) f.setAttribute('tabindex', '-1');
    setTimeout(function () { try { if (f && !s.contains(document.activeElement)) f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet(quiet) {
    var s = $('#sheet');
    if (s.hidden) return;
    s.hidden = true; $('#sheetBack').hidden = true; s.innerHTML = '';
    document.body.classList.remove('sheet-open');
    // Something moved while the sheet was open.
    if (state.stale) { state.stale = false; if (inside()) redraw(); }
    if (!quiet && lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  function onSubmit(form, fn) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      try { fn(); } catch (err) { showError(err, $('#formErr')); }
    });
  }

  function detailsSheet() {
    sheet('<h2>The passport’s details</h2><form id="detForm" novalidate>' + strollFields(state.g) + '<div id="formErr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      var f = $('#detForm', root);
      onSubmit(f, function () { var b = strollBody(f); b.t = 'details'; act(b, function () { closeSheet(); toast('Saved.'); }); });
    });
  }
  function joinSheet(code, k) {
    sheet('<h2>' + (k ? 'Start your passport' : 'Open a passport') + '</h2><form id="joinForm" novalidate><label class="field"' + (code ? ' hidden' : '') + '><span>The code on the poster</span><input class="input" name="code" autocomplete="off" autocapitalize="characters" maxlength="9" placeholder="ABC-DEF" value="' + esc(code ? C.formatCode(code) : '') + '"></label>' +
      '<div id="peek"></div><label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" value="' + esc(state.prefs.name) + '"></label>' +
      '<p class="small muted hint">That’s all it asks. No email, no phone number, no app.</p>' +
      '<div id="formErr"></div><button class="btn block" type="submit">' + (k ? 'Start and get my stamp' : 'Start my passport') + '</button></form>', function (root) {
      var f = $('#joinForm', root);
      function peek() {
        var c = C.normalizeCode(f.code.value);
        if (!C.isCode(c)) { $('#peek', root).innerHTML = ''; return; }
        api('GET', 'api/join/' + c).then(function (p) {
          if (p.already) { closeSheet(true); enter(p.already); return; }
          $('#peek', root).innerHTML = '<div class="card mb16"><b>' + esc(p.title) + '</b><br><span class="small muted">' + (p.place ? esc(p.place) + ' · ' : '') + esc(p.when) + ' · ' + plural(p.shops, 'shop') + (p.goal ? ' · ' + plural(p.goal, 'stamp') + ' to enter' : '') + '</span>' + (p.prize ? '<br><span class="small">Prize: ' + esc(p.prize) + '</span>' : '') + (p.ended ? '<br><span class="small">This passport has ended.</span>' : '') + '</div>';
        }).catch(function (err) { showError(err, $('#peek', root)); });
      }
      f.code.addEventListener('input', peek); peek();
      onSubmit(f, function () {
        var c = C.normalizeCode(f.code.value);
        if (!C.isCode(c)) throw new Error('The code is six letters and numbers, like ABC-DEF.');
        api('POST', 'api/join/' + c, { name: f.name.value }).then(function (r) {
          state.prefs.name = C.cleanName(f.name.value) || state.prefs.name; savePrefs();
          closeSheet(true);
          return enter(r.id).then(function () { if (k && state.g && state.g.role === 'card') return doStamp(k); });
        }).catch(function (err) { showError(err, $('#formErr', root)); });
      });
    });
  }
  function stampSheet() {
    var g = state.g;
    var pick = state.demo ? '<h3>In the example, pick a counter to stand at</h3><div class="btn-row">' + g.shops.filter(function (s) { return !s.got; }).map(function (s) { return '<button class="btn quiet small" type="button" data-act="demostamp" data-id="' + esc(s.id) + '">' + esc(s.name) + '</button>'; }).join('') + '</div>' : '';
    sheet('<h2>Stamp my passport</h2><p class="muted">Type the four letters on the sign at the counter. (Or close this and point your camera at the sign’s square.)</p>' +
      '<form id="stampForm" novalidate><label class="field"><span>The counter’s code</span><input class="input codebox" name="code" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="4" placeholder="····"></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Stamp it</button></form>' + pick, function (root) {
      var f = $('#stampForm', root);
      onSubmit(f, function () {
        var c = C.normalizeCode(f.code.value);
        if (!C.isStamp(c)) throw new Error('The code is four letters and numbers - it’s printed big on the sign.');
        doStamp(c, $('#formErr', root));
      });
      setTimeout(function () { try { f.code.focus(); } catch (e) { /* ignore */ } }, 60);
    });
  }
  function addShopsSheet() {
    sheet('<h2>Add shops</h2><form id="addForm" novalidate><label class="field"><span>One shop to a line</span><textarea class="input" name="shops" maxlength="2400" placeholder="Juniper &amp; Wren&#10;Dog-Eared Books"></textarea></label><div id="formErr"></div><button class="btn block" type="submit">Add</button></form>', function (root) {
      var f = $('#addForm', root);
      onSubmit(f, function () {
        var list = linesOf(f.shops.value);
        if (!list.length) throw new Error('Type at least one shop.');
        act({ t: 'addshops', shops: list }, function () { closeSheet(); toast(plural(list.length, 'shop') + ' added - each has its own sign now.', 4500); });
      });
    });
  }
  function shopSheet(id) {
    var s = C.shopOf(state.g, id); if (!s) return;
    sheet('<h2>' + esc(s.name) + '</h2><form id="shopForm" novalidate><label class="field"><span>The shop’s name</span><input class="input" name="name" maxlength="40" autocomplete="off" value="' + esc(s.name) + '"></label>' +
      '<label class="field"><span>A perk for passport holders (optional)</span><input class="input" name="perk" maxlength="80" autocomplete="off" placeholder="10% off candles" value="' + esc(s.perk) + '"></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Save</button></form>' +
      '<h3>Counter code</h3><p><span class="kcode">' + esc(s.k) + '</span> · <span class="muted small">' + plural(s.count, 'stamp') + ' so far</span></p><p class="small muted">If the code has got around - people stamping without visiting - make a new one and reprint this shop’s sign. The old sign stops working.</p>' +
      '<div class="btn-row"><button class="btn ghost small" type="button" data-act="newcode" data-id="' + esc(id) + '">Make a new code</button><button class="btn danger small" type="button" data-act="delshop" data-id="' + esc(id) + '">Remove this shop</button></div>', function (root) {
      var f = $('#shopForm', root);
      onSubmit(f, function () { act({ t: 'editshop', id: id, name: f.name.value, perk: f.perk.value }, function () { closeSheet(); toast('Saved.'); }); });
    });
  }
  function cardRows(doc, cards) {
    return cards.map(function (c) { var p = C.progress(doc, c); return { tag: c.tag, name: c.name, n: p.n, done: p.done, entries: p.entries, removed: c.removed }; }).sort(function (a, b) { return b.n - a.n; });
  }
  function cardsSheet() {
    function drawList(r) {
      sheet('<h2>The passports</h2><p class="muted small">' + plural(r.total, 'passport') + (r.total > r.list.length ? ' - the ' + r.list.length + ' with the most stamps are shown' : '') + '. First names only: it is all Stroll keeps. Remove one that isn’t playing fair - it leaves the draw, and its stamps stay counted.</p>' +
        (r.list.length ? '<ul class="list">' + r.list.map(function (c) {
          return '<li><div class="item"><span class="grow"><span class="t">' + esc(c.name) + '</span><br><span class="s">' + plural(c.n, 'stamp') + (c.done ? ' · ' + plural(c.entries, 'entry', 'entries') : '') + '</span></span>' +
            (c.removed ? chip('s-due', 'Removed') : '<button class="btn danger small" type="button" data-act="kick" data-id="' + esc(c.tag) + '" data-name="' + esc(c.name) + '">Remove</button>') + '</div></li>';
        }).join('') + '</ul>' : '<p class="empty">No passports yet. Put the poster up.</p>'));
    }
    if (state.demo) { var rows = cardRows(state.demo.doc, state.demo.cards); drawList({ total: rows.length, list: rows }); return; }
    api('GET', 'api/s/' + encodeURIComponent(state.g.id) + '/cards').then(function (r) { drawList(r); reread(); }).catch(function (err) { showError(err); });
  }
  function link() { return C.joinLink(HERE, state.g.code); }
  function copy(text, ok) {
    function fallback() { var ta = document.createElement('textarea'); ta.value = text; ta.className = 'vh'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(ok); } catch (e) { toast('Could not copy - select it by hand.'); } ta.remove(); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(ok); }, fallback); else fallback();
  }
  function shareOut() {
    if (state.demo) { toast('In the example that is switched off.'); return; }
    var text = C.invite(state.g, HERE);
    if (navigator.share) navigator.share({ title: state.g.title, text: text.replace(/ Start your passport: .*$/, ''), url: link() }).catch(function () { /* cancelled */ }); else copy(text, 'Copied - paste it where your shoppers are.');
  }
  function runDraw() {
    var g = state.g;
    if (C.phase(g, today()) !== 'after' && !confirm('The passport is still running. Draw a winner now anyway?')) return;
    if (state.demo) {
      try {
        var w = C.draw(state.demo.doc, state.demo.cards, dice);
        state.demo.doc.winners[w.tag] = { name: w.name, claim: randCode(C.CODE_LEN), at: D.NOW + Object.keys(state.demo.doc.winners).length };
        state.demo.doc.v++; demoView(); redraw(); announce(w);
      } catch (err) { showError(err, $('#formErr')); }
      return;
    }
    api('POST', 'api/s/' + encodeURIComponent(g.id) + '/draw').then(function (r) { adopt(r.g); redraw(); announce(r.winner); }).catch(function (err) { showError(err, $('#formErr')); });
  }
  function announce(w) { var msg = w.name + ' wins - drawn from ' + plural(w.of, 'entry', 'entries') + ' on ' + plural(w.people, 'passport') + '.'; toast(msg, 6000); say(msg); }

  /* ---------------- the example ---------------- */

  function startDemo() {
    closeSheet(true);
    state.demo = { doc: D.doc(), cards: D.cards() }; state.demoRole = 'card'; state.offline = false; demoView(); state.view = 'passport';
    history.replaceState(null, '', BASE + '#passport'); draw(); scrollTo(0, 0);
  }
  function leaveDemo() {
    state.demo = null; state.g = null; closeSheet(true);
    if (state.prefs.cur) { enter(state.prefs.cur); return; }
    go('home');
  }

  /* ---------------- the account (only for the organizer's second phone) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }
  /** Signed in: keep the passports this phone organizes on the account,
   *  and bring the account's to this phone. */
  function syncMine() {
    if (!signedIn() || !state.me.keep) return Promise.resolve();
    var chain = Promise.resolve();
    state.list.filter(function (g) { return g.role === 'host'; }).forEach(function (g) { chain = chain.then(function () { return api('POST', 'api/s/' + encodeURIComponent(g.id) + '/keep').catch(function () { /* gone, or not ours */ }); }); });
    return chain.then(function () { return api('GET', 'api/mine'); }).then(function (r) {
      var have = {}; state.list.forEach(function (g) { have[g.id] = 1; });
      (r.list || []).forEach(function (g) { if (!have[g.id]) state.list.push(g); });
      real.putList(state.list); state.list = real.getList();
      if (state.view === 'home') keepPlace(draw);
    }).catch(function () { /* the phone's own list stands */ });
  }
  var FREE_LINE = 'Stroll is free with no account, and shoppers never need one. A free account does one thing: the passports you organize open on your other phone, as their organizer. One account works across every app on this site.';
  function openAccount() {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2><p class="muted">' + esc(FREE_LINE) + '</p>' +
        '<form id="authForm"><label class="field"><span>Your email (for your account only - never shown to shoppers or shops)</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div><button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted center mt16">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      function done() { closeSheet(); return loadMe().then(function () { toast('You’re in.'); return syncMine(); }).then(function () { keepPlace(draw); }); }
      $('#swap', root).addEventListener('click', function () { mode = mode === 'register' ? 'login' : 'register'; draw2(root); });
      $('#authForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(done).catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(done).catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('', draw2);
  }
  function openAccountSheet() {
    sheet('<h2>Account</h2><p class="small muted">' + esc(state.me.email) + '</p><p class="small">The passports you organize are kept on this account, so they open on your other phone when you sign in there. No shopper or shop ever sees this address.</p>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button">Set up Face ID for this phone</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button">Sign out</button>', function (root) {
      $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); keepPlace(draw); }); });
      var pk = $('#pkEnrol', root);
      if (pk) pk.addEventListener('click', function () {
        var pw = prompt('Your password, to confirm it is you:');
        if (!pw) return;
        Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
      });
    });
  }

  /* ---------------- wiring: one listener per kind of event ---------------- */

  function gCall(method, tail, ok) {
    if (state.demo) { toast('In the example that is switched off.'); return; }
    api(method, 'api/s/' + encodeURIComponent(state.g.id) + tail).then(ok).catch(function (er) { showError(er); });
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.dataset.act, id = el.dataset.id, s;
    if (a === 'home') { e.preventDefault(); closeSheet(true); if (state.demo) { state.demo = null; state.g = null; } go('home'); }
    else if (a === 'tab') { if (state.g) go(el.dataset.tab); }
    else if (a === 'closesheet') closeSheet();
    else if (a === 'account') { if (signedIn()) openAccountSheet(); else openAccount(); }
    else if (a === 'new') { if (state.demo) { state.demo = null; state.g = null; } go('new'); }
    else if (a === 'join') joinSheet('', '');
    else if (a === 'demo') startDemo();
    else if (a === 'leavedemo') leaveDemo();
    else if (a === 'demoswap') { state.demoRole = state.demoRole === 'host' ? 'card' : 'host'; demoView(); closeSheet(true); state.view = firstTab(state.g); history.replaceState(null, '', BASE + '#' + state.view); draw(); scrollTo(0, 0); }
    else if (a === 'open') enter(id);
    else if (a === 'stamp') stampSheet();
    else if (a === 'demostamp') { s = state.demo && state.demo.doc.shops[id]; if (s) doStamp(s.k, $('#formErr')); }
    else if (a === 'details') detailsSheet();
    else if (a === 'addshops') addShopsSheet();
    else if (a === 'editshop') shopSheet(id);
    else if (a === 'delshop') { if (confirm('Remove this shop from the passport? Stamps collected there stop counting.')) act({ t: 'delshop', id: id }, function () { closeSheet(); toast('Removed.'); }); }
    else if (a === 'newcode') { if (confirm('Make a new code for this shop? Its printed sign stops working until you reprint it.')) act({ t: 'newcode', id: id }, function () { closeSheet(); toast('New code made - reprint that shop’s sign.', 4500); }); }
    else if (a === 'given') act({ t: 'given', tag: id }, function () { toast('Marked as handed over.'); });
    else if (a === 'cards') cardsSheet();
    else if (a === 'kick') {
      if (!confirm('Remove ' + el.dataset.name + '’s passport from the draw?')) return;
      if (state.demo) { state.demo.cards.forEach(function (c) { if (c.tag === id) c.removed = true; }); demoView(); state.stale = true; cardsSheet(); return; }
      gCall('DELETE', '/cards/' + encodeURIComponent(id), function () { cardsSheet(); });
    }
    else if (a === 'draw') runDraw();
    else if (a === 'print') printSigns(id || '');
    else if (a === 'share') shareOut();
    else if (a === 'shareshopper') shareOut();
    else if (a === 'copylink') { if (state.demo) toast('In the example that is switched off.'); else copy(link(), 'Link copied.'); }
    else if (a === 'leave') { if (confirm('Tear up your passport? Your stamps are gone for good.')) gCall('DELETE', '/me', function () { forgetLocal(state.g.id); state.g = null; go('home'); toast('Torn up.'); }); }
    else if (a === 'delete') { if (confirm('Delete this passport for everyone? Every shopper’s stamps and the counts are gone for good.')) gCall('DELETE', '', function () { forgetLocal(state.g.id); state.g = null; go('home'); toast('Deleted.'); }); }
  });
  window.addEventListener('popstate', function () { closeSheet(true); route(); });
  window.addEventListener('hashchange', route);
  window.addEventListener('afterprint', function () { $$('.signs > li.skip').forEach(function (li) { li.classList.remove('skip'); }); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') { clearTimeout(pollTimer); return; }
    if (wantPoll()) schedulePoll(0); else reread();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy; online it still works */ });

  /* ---------------- boot ---------------- */

  draw();
  loadMe().then(syncMine);
  var h0 = location.hash.replace(/^#/, '');
  if (/^(join|stamp)=/.test(h0) || h0 === 'try' || h0 === 'new') route();
  else if (state.prefs.cur && h0 !== 'home') enter(state.prefs.cur, TABS.indexOf(h0) >= 0 ? h0 : state.prefs.tab);
  else route();
})();
