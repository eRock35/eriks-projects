/* Doorbuster - the page. One file, no build step.
 *
 * The rules (what a deal costs and makes, the break-even, the verdict, the
 * safer shapes, the sign's words, the tally and the wrap-up) are
 * DoorbusterCore's; what this phone remembers goes through
 * doorbuster-store.js (localStorage, with a memory fallback). The made-up
 * shop is changed by the same rules, in memory, and is never kept or sent.
 *
 * The requests this page makes: a sale (start, join with a code and a first
 * name, every change through one route, poll every 5 seconds while the page
 * is visible and a sale is on screen, leave, remove, delete), sign-in, the
 * account's list of kept sales, and - signed in, when the owner asks - one
 * read of a price list into draft items. No location, no contacts, no
 * camera stream, no notifications.
 *
 * A STAFF PHONE IS NEVER SENT a cost, a usual figure or a margin, so this
 * page cannot show one there: everything it draws for staff comes from
 * prices alone (C.offer, C.sign).
 *
 * Offline: sw.js keeps the page's own files and the store keeps the last
 * copy of the sale, so the deals, the signs and the last counts open with
 * no signal. A tap on the tally needs the network - taps are NOT saved up
 * for later - and the page says so.
 *
 * Every string a person typed or the server sent is escaped before it is
 * drawn, no handler is written into markup (clicks are routed by data-act
 * from one listener - the lab's CSP allows script from this origin only),
 * and no style attribute is written: a bar's width is a class.
 */
(function () {
  'use strict';

  var C = window.DoorbusterCore;
  var D = window.DoorbusterDemo;
  var S = window.DoorbusterStore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var POLL_MS = 5000;
  var TABS = S.TABS;
  var HONEST = 'Every “usual” here is your own number, so every result is an estimate - not a forecast, and not advice.';
  var OFFLINE_TAPS = 'Taps on the tally need a signal - they are not saved up for later.';

  var real = S.local();
  var state = {
    me: null, view: 'home', g: null, demo: null, demoMe: D.ME,
    list: real.getList(), prefs: real.getPrefs(),
    offline: false, seenAt: 0, memo: null, n: 0, stale: false,
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
    if (err instanceof TypeError) msg = 'You look offline. The deals and the signs still open; ' + OFFLINE_TAPS.charAt(0).toLowerCase() + OFFLINE_TAPS.slice(1);
    if (where) { where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>'; } else toast(msg, 4500);
  }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function localToday() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 101).slice(1) + '-' + String(d.getDate() + 100).slice(1); }
  function today() { return state.demo ? D.TODAY : localToday(); }
  function savePrefs() { real.putPrefs(state.prefs); }
  function remember(g) {
    if (state.demo || !g) return;
    state.list = [{ id: g.id, shop: g.shop, title: g.title, from: g.from, to: g.to }].concat(state.list.filter(function (x) { return x.id !== g.id; }));
    real.putList(state.list); state.list = real.getList();
    real.putLast(g, Date.now());
  }
  function forgetLocal(id) {
    state.list = state.list.filter(function (x) { return x.id !== id; }); real.putList(state.list);
    if (state.prefs.cur === id) { state.prefs.cur = ''; savePrefs(); real.clearLast(); }
  }
  function dealById(id) { return C.dealById(state.g, id); }
  function itemById(id) { return C.itemById(state.g, id); }
  function M(c) { return C.money(c, state.g.cur); }
  /** The owner's report on a deal, worked out once per draw. Never called
   *  on a staff phone: it has no costs to work from. */
  function rep(d) {
    var key = state.g.id + ':' + state.g.v;
    if (!state.memo || state.memo.key !== key) state.memo = { key: key, r: {} };
    if (!state.memo.r[d.id]) state.memo.r[d.id] = C.report(state.g, d);
    return state.memo.r[d.id];
  }
  function parseBox(input, label, allowEmpty) {
    var raw = input.value.trim();
    if (!raw && allowEmpty) return null;
    var c = C.parseMoney(raw);
    if (c === null) throw new Error(label + ': type an amount like 12.50.');
    return c;
  }
  function parseCount(input, label, allowEmpty) {
    var raw = input.value.trim();
    if (!raw && allowEmpty) return null;
    if (!/^\d{1,6}$/.test(raw)) throw new Error(label + ': type a whole number.');
    return Number(raw);
  }

  /* ---------------- the sale on screen ---------------- */

  var pollTimer = null;
  function wantPoll() { return Boolean(state.g && !state.demo && document.visibilityState === 'visible' && TABS.indexOf(state.view) >= 0); }
  function schedulePoll(ms) { clearTimeout(pollTimer); if (wantPoll()) pollTimer = setTimeout(poll, ms === undefined ? POLL_MS : ms); }
  function poll() {
    if (!wantPoll()) return;
    var id = state.g.id;
    api('GET', 'api/s/' + encodeURIComponent(id) + '?since=' + state.g.v).then(function (r) {
      if (!state.g || state.g.id !== id) return;
      var was = state.offline; state.offline = false; state.seenAt = Date.now();
      if (r.g) { adopt(r.g); if ($('#sheet').hidden) redraw(); else state.stale = true; } else if (was) redraw();
      schedulePoll();
    }).catch(function (err) {
      if (err && err.status === 404) { gone(id); return; }
      if (!state.offline) { state.offline = true; redraw(); }
      schedulePoll(POLL_MS * 2);
    });
  }
  function adopt(g) { state.g = g; state.memo = null; remember(g); }
  function gone(id) {
    forgetLocal(id); state.g = null; closeSheet(true);
    toast('That sale isn’t here any more.', 5000); go('home');
  }
  function firstTab(g) { return !g.deals.length && g.owner ? 'items' : C.phase(g, today()).k === 'before' && g.owner ? 'deals' : 'today'; }
  function enter(id, tab) {
    return api('GET', 'api/s/' + encodeURIComponent(id)).then(function (r) {
      state.demo = null; adopt(r.g); state.prefs.cur = id; savePrefs(); state.seenAt = Date.now(); state.offline = false;
      if (signedIn() && state.me.keep) api('POST', 'api/s/' + encodeURIComponent(id) + '/keep').catch(function () { /* the phone still has it */ });
      go(tab || firstTab(r.g));
    }).catch(function (err) {
      if (err && err.status === 404) { forgetLocal(id); toast(err.message, 5000); go('home'); return; }
      // No signal: the last copy this phone has.
      var last = real.getLast();
      if (err instanceof TypeError && last && last.g.id === id) {
        state.demo = null; state.g = last.g; state.memo = null; state.offline = true; state.seenAt = last.at;
        state.view = tab || 'today'; draw(); schedulePoll(POLL_MS * 2);
        return;
      }
      showError(err);
    });
  }
  function demoView() { state.g = C.view(state.demo, state.demoMe); state.memo = null; }
  /** One door for every change. In the example it runs the same rules here. */
  function act(action, done) {
    if (state.demo) {
      try {
        var ids = [];
        for (var i = 0; i < C.LIMITS.batch; i++) ids.push((action.t === 'adddeal' ? 'd' : 'i') + 'demo' + String(1000 + (state.n++)));
        state.demo = C.patch(state.demo, C.act(state.demo, state.demoMe, action, { now: D.NOW + state.n, ids: ids, today: D.TODAY }));
        demoView();
        if (done) done({ id: ids[0] });
        redraw();
      } catch (e) { showError(e, $('#formErr')); }
      return;
    }
    api('POST', 'api/s/' + encodeURIComponent(state.g.id) + '/act', { action: action }).then(function (r) {
      state.offline = false; adopt(r.g); if (done) done(r); redraw(); schedulePoll();
    }).catch(function (err) {
      if (err && err.status === 404 && err.data && err.data.code === 'gone') { gone(state.g.id); return; }
      showError(err, $('#formErr'));
    });
  }

  /* ---------------- routing and drawing ---------------- */

  function go(view) { history.pushState(null, '', BASE + '#' + view); route(); scrollTo(0, 0); }
  function route() {
    var h = location.hash.replace(/^#/, '');
    var join = /^join=([A-Za-z0-9-]{4,12})$/.exec(h);
    if (join) { history.replaceState(null, '', BASE + '#home'); state.view = 'home'; draw(); joinSheet(C.normalizeCode(join[1])); return; }
    if (h === 'try') { startDemo(); return; }
    if (TABS.indexOf(h) >= 0 && state.g) { state.view = h; if (!state.demo) { state.prefs.tab = h; savePrefs(); } }
    else if (h === 'new') state.view = 'new';
    else state.view = 'home';
    draw(); schedulePoll();
  }
  function keepPlace(fn) { var y = scrollY; fn(); scrollTo(0, y); }
  function redraw() { keepPlace(draw); }
  function draw() {
    var inG = TABS.indexOf(state.view) >= 0 && state.g;
    $('#tabbar').hidden = !inG; $('#topnav').hidden = !inG;
    $$('[data-tab]').forEach(function (b) { if (b.dataset.tab === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var m = $('#main');
    m.className = 'wrap' + (state.view === 'home' || state.view === 'team' || state.view === 'new' ? ' narrow' : '');
    m.innerHTML = !inG ? (state.view === 'new' ? newHtml() : homeHtml()) : state.view === 'deals' ? dealsHtml() : state.view === 'items' ? itemsHtml() : state.view === 'signs' ? signsHtml() : state.view === 'team' ? teamHtml() : todayHtml();
    document.title = (inG ? state.g.title + ' · ' : '') + 'Doorbuster';
    if (state.view === 'new') wireNew();
  }
  function ribbon() {
    if (state.demo) return '<p class="ribbon">' + esc(D.NOTICE) + ' You are looking as ' + (state.g.owner ? 'Ana, the owner' : 'Theo, at the counter - no costs, no margins') + '. <button class="link-btn" type="button" data-act="demoswap">See it as ' + (state.g.owner ? 'staff' : 'the owner') + '</button> · <button class="link-btn" type="button" data-act="leavedemo">Leave the example</button></p>';
    if (state.offline) return '<p class="ribbon" role="status">You’re offline - this is the sale as this phone last saw it. ' + esc(OFFLINE_TAPS) + '</p>';
    return '';
  }
  function dot(m) { return '<span class="dot c' + (m.c % C.COLORS.length) + '" aria-hidden="true">' + esc(C.initials(m.name)) + '</span>'; }
  function chip(status, label) {
    var cls = { good: 's-ok', tight: 's-late', bad: 's-due', loss: 's-due', stock: 's-due', way: 's-way' }[status] || '';
    return '<span class="chip ' + cls + '">' + esc(label) + '</span>';
  }
  function whenLine(g) { return C.dateRange(g.from, g.to); }
  /** What the shopper gets, in a line - from prices alone. */
  function offerLine(d) {
    var o = C.offer(state.g, d), bits = [];
    if (!o.ok) return 'This deal needs editing.';
    if (d.kind === 'pct' || d.kind === 'amount') bits.push('Now ' + M(o.pay) + ', usually ' + M(o.full));
    else if (d.kind === 'multi') bits.push(o.units + ' for ' + M(o.pay) + ', usually ' + M(o.full));
    else if (d.kind === 'bundle') bits.push(M(o.pay) + ' together, separately ' + M(o.full));
    else bits.push(M(d.save) + ' off ' + M(d.spend) + ' or more');
    if (d.limit) bits.push('limit ' + d.limit + ' per customer');
    if (d.wsl) bits.push('while supplies last');
    return bits.join(' · ');
  }

  /* ---------------- home and setup ---------------- */

  function homeHtml() {
    var list = state.list.map(function (g) {
      return '<li><button class="item" type="button" data-act="open" data-id="' + esc(g.id) + '"><span class="grow"><span class="t">' + esc(g.title) + '</span><br><span class="s">' + esc(g.shop) + (g.from && g.to ? ' · ' + esc(C.dateRange(g.from, g.to)) : '') + '</span></span><span class="tag">Open</span></button></li>';
    }).join('');
    return '<section class="hero"><h1>Will this deal make money?</h1>' +
      '<p class="lede">Type the deal you’re thinking of. Doorbuster shows what it does to your margin, how many you have to sell before it makes you a cent more, and kinder shapes of the same deal - then prints the sign and keeps count at the counter.</p>' +
      '<div class="btn-row"><button class="btn" type="button" data-act="new">Build a sale</button><button class="btn ghost" type="button" data-act="join">Join with a code</button></div>' +
      '<p class="mt16 mb0"><button class="link-btn" type="button" data-act="demo">See a made-up gift shop, mid-sale</button></p></section>' +
      (list ? '<section class="section"><div class="section-title"><h2>Your sales</h2></div><ul class="list">' + list + '</ul></section>' : '') +
      '<section class="section"><h2>How it works</h2><ol class="steps">' +
      '<li><span class="n">1</span><span><b>Add what you sell:</b> the price, what it costs you, and how many you’d usually sell over those days. No account.</span></li>' +
      '<li><span class="n">2</span><span><b>Build the deal</b> - percent off, an amount off, buy 2 get 1, a bundle, spend and save - and read the break-even: “you need to sell 45, 2.3x your usual”.</span></li>' +
      '<li><span class="n">3</span><span><b>Try a kinder shape.</b> Each deal comes with up to three others worked out from your own items, to apply in a tap and undo.</span></li>' +
      '<li><span class="n">4</span><span><b>Print the sign, then tap +1 at the counter.</b> Staff join with one link and see prices and stock - never your costs. Afterwards: what the sale really made.</span></li></ol></section>' +
      '<section class="section"><p class="small muted">' + esc(HONEST) + ' ' + esc(C.WAS_RULE) + '</p><p class="small muted">Free, with no sign-in. Doorbuster keeps a shop’s name, first names, items and counts - never a phone number, an email address or anything about a customer. The owner can delete a sale at once, and it is deleted by itself a month after its last day. Once it has loaded, the page opens without a signal; the tally needs one.</p></section>';
  }
  function seg(name, opts, sel) {
    return '<div class="seg" role="group" data-seg="' + name + '">' + opts.map(function (o) { return '<button type="button" data-val="' + esc(o[0]) + '" aria-pressed="' + (o[0] === sel) + '">' + esc(o[1]) + '</button>'; }).join('') + '<input type="hidden" name="' + name + '" value="' + esc(sel) + '"></div>';
  }
  function wireSegs(root, onChange) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('.seg[data-seg] button'); if (!b) return;
      var box = b.parentNode;
      $$('button', box).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      $('input', box).value = b.dataset.val;
      if (onChange) onChange(box.dataset.seg, b.dataset.val);
    });
  }
  function saleFields(g) {
    var from = g ? g.from : localToday(), to = g ? g.to : C.addDays(localToday(), 3);
    return '<label class="field"><span>Shop name (it goes on the signs)</span><input class="input" name="shop" maxlength="40" value="' + esc(g ? g.shop : '') + '"></label>' +
      '<label class="field"><span>The sale’s name</span><input class="input" name="title" maxlength="40" placeholder="Black Friday weekend" value="' + esc(g ? g.title : '') + '"></label>' +
      '<div class="two"><label class="field"><span>First day</span><input class="input" type="date" name="from" value="' + esc(from) + '"></label>' +
      '<label class="field"><span>Last day</span><input class="input" type="date" name="to" value="' + esc(to) + '"></label></div>' +
      '<p class="small muted hint">Up to 14 days - this is about one short promotion.</p>' +
      '<div class="field"><span>Prices in</span>' + seg('cur', C.CURRENCIES.map(function (c) { return [c, c]; }), g ? g.cur : '$') + '</div>' +
      '<label class="field"><span>Your usual margin on everything else (%)</span><input class="input" name="margin" inputmode="numeric" maxlength="2" value="' + esc(String(g ? g.margin : 50)) + '"></label>' +
      '<p class="small muted hint">Of every ' + esc(g ? g.cur : '$') + '10 of ordinary shopping, how much is left after what the goods cost you? 50 means half. Used only for loss leaders and spend-and-save.</p>';
  }
  function saleBody(f) { return { shop: f.shop.value, title: f.title.value, from: f.from.value, to: f.to.value, cur: f.cur.value, margin: f.margin.value.trim() === '' ? 50 : Number(f.margin.value) }; }
  function newHtml() {
    return '<section class="g-head"><h1>Build a sale</h1><p class="sub">A minute, no account. Then add your items and try a deal.</p></section>' +
      '<form id="newForm" class="mt24" novalidate>' +
      '<label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" value="' + esc(state.prefs.name) + '"></label>' +
      saleFields(null) +
      '<div id="formErr"></div><button class="btn block" type="submit">Start the sale</button></form>' +
      '<p class="small muted mt16">' + esc(HONEST) + '</p>';
  }
  function wireNew() {
    var f = $('#newForm'); if (!f) return;
    wireSegs(f);
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = saleBody(f); body.name = f.name.value;
      var btn = $('button[type=submit]', f); btn.disabled = true;
      api('POST', 'api/sales', body).then(function (r) {
        state.prefs.name = C.cleanName(body.name); state.prefs.cur = r.id; savePrefs();
        state.demo = null; adopt(r.g); state.seenAt = Date.now();
        if (signedIn() && state.me.keep) api('POST', 'api/s/' + encodeURIComponent(r.id) + '/keep').catch(function () { /* the phone still has it */ });
        go('items'); toast('Now add what you sell.', 4500);
      }).catch(function (err) { btn.disabled = false; showError(err, $('#formErr')); });
    });
  }

  /* ---------------- today: the plan, the tally, the verdict ---------------- */

  function headHtml() {
    var g = state.g, ph = C.phase(g, today());
    var when = ph.k === 'before' ? 'starts ' + C.dayLong(g.from) : ph.k === 'after' ? 'ended ' + C.dayLong(g.to) : 'day ' + ph.day + ' of ' + ph.days;
    return ribbon() + '<section class="g-head"><h1>' + esc(g.title) + '</h1><p class="sub">' + esc(g.shop + ' · ' + whenLine(g) + ' · ' + when) + '</p></section>';
  }
  function stockLine(d) {
    var g = state.g;
    if (d.room === null) return '';
    var fix = g.owner && d.items.length ? ' <button class="link-btn" type="button" data-act="stock" data-id="' + esc(d.items[0]) + '">Correct the stock</button>' : '';
    if (d.room < 1) return '<p class="tally-stock">' + chip('bad', 'None left') + '<span>Pull the sign.' + (g.owner ? '' : ' If the shelf says otherwise, ask the owner to correct the stock.') + '</span>' + fix + '</p>';
    return '<p class="tally-stock"><span><b class="num">' + d.room + '</b> left - pull the sign at 0.</span>' + fix + '</p>';
  }
  function tallyHtml(d) {
    var g = state.g, canUndo = d.count > 0 && (g.owner || d.mine > 0), title = C.dealTitle(g, d), html;
    html = '<li class="tally"><div class="tally-head"><span class="t">' + esc(title) + '</span><span class="s">' + esc(offerLine(d)) + '</span></div>' +
      '<div class="tally-row"><b class="count" aria-label="' + esc(d.count + ' counted') + '">' + d.count + '</b>' +
      '<button class="plus" type="button" data-act="tally" data-id="' + esc(d.id) + '" data-n="1" aria-label="' + esc('Count one: ' + title) + '"' + (d.room !== null && d.room < 1 ? ' disabled' : '') + '>+1</button>' +
      '<button class="minus" type="button" data-act="tally" data-id="' + esc(d.id) + '" data-n="-1" aria-label="' + esc('Undo one: ' + title) + '"' + (canUndo ? '' : ' disabled') + '>−1</button></div>';
    if (g.owner) { var r = rep(d), p = C.progress(g, d, r); html += '<div class="bar" aria-hidden="true"><i class="p' + p.p + '"></i></div><p class="tally-line">' + esc(p.line) + '</p>'; }
    return html + stockLine(d) + '</li>';
  }
  function planRow(d) {
    var g = state.g, r = g.owner ? rep(d) : null;
    return '<li class="item"><span class="grow"><span class="t">' + esc(C.dealTitle(g, d)) + '</span><br><span class="s">' + esc(offerLine(d)) + '</span>' + (r && r.ok ? '<br><span class="s">' + esc(r.verdict) + '</span>' : '') + '</span>' + (r && r.ok ? '<span class="chips">' + chip(r.status, r.label) + '</span>' : '') + '</li>';
  }
  function todayHtml() {
    var g = state.g, ph = C.phase(g, today()), html = headHtml();
    if (!g.deals.length) {
      return html + (g.owner
        ? '<p class="empty">No deals yet. Add what you sell, then build a deal and see whether it pays.</p><div class="btn-row"><button class="btn" type="button" data-act="' + (g.items.length ? 'adddeal' : 'additem') + '">' + (g.items.length ? 'Build a deal' : 'Add an item') + '</button></div>'
        : '<p class="empty">The owner hasn’t added a deal yet. This page fills in by itself when they do.</p>');
    }
    if (ph.k === 'before') {
      return html + '<section class="section"><p class="big">Starts ' + esc(C.dayLong(g.from)) + '.</p><p class="muted">The tally opens here on the day: one big +1 for each deal, on every phone at the counter.</p></section>' +
        '<section class="section"><div class="section-title"><h2>The plan</h2><span class="muted small">' + esc(plural(g.deals.length, 'deal')) + '</span></div><ul class="list">' + g.deals.map(planRow).join('') + '</ul>' +
        (g.owner ? '<p class="small muted mt16">' + esc(HONEST) + '</p>' : '') + '</section>';
    }
    if (ph.k === 'after') {
      if (!g.owner) {
        return html + '<section class="section"><p class="big">The sale is over.</p><ul class="list">' + g.deals.map(function (d) { return '<li class="item"><span class="grow"><span class="t">' + esc(C.dealTitle(g, d)) + '</span><br><span class="s">' + esc(offerLine(d)) + '</span></span><b class="num">' + d.count + '</b></li>'; }).join('') + '</ul></section>';
      }
      var w = C.wrapUp(g);
      return html + '<section class="section"><div class="section-title"><h2>The verdict</h2></div><p class="big">' + esc(w.text) + '</p><p class="small muted">' + esc(w.note) + '</p></section>' +
        '<section class="section"><ul class="list">' + w.rows.map(function (r) {
          return '<li class="item"><span class="grow"><span class="t">' + esc(r.title) + '</span><br><span class="s">' + esc(r.text) + '</span><br><span class="s">' + esc(r.next) + '</span></span><span class="chips">' + chip(r.status, { good: 'Paid off', bad: 'Fell short', loss: 'A cost' }[r.status]) + '</span></li>';
        }).join('') + '</ul><p class="small muted mt16">This sale and everything in it is deleted on ' + esc(C.dayLong(g.keptUntil)) + '.</p></section>';
    }
    return html + (g.owner ? '<p class="card mt16 small">' + esc(C.paceLine(g, today())) + '</p>' : '') +
      '<section class="section"><div class="section-title"><h2>Tally</h2><span class="muted small">Tap +1 for every one sold</span></div><ul class="tallies">' + g.deals.map(tallyHtml).join('') + '</ul>' +
      '<p class="small muted mt16">' + esc(OFFLINE_TAPS) + ' −1 undoes a tap of your own.</p></section>';
  }

  /* ---------------- deals ---------------- */

  function figsHtml(d, r) {
    var per = r.noun ? ' <small>a ' + esc(r.noun === 'use' ? 'new basket' : r.noun) + '</small>' : ' <small>each</small>';
    var be = r.breakEven === null ? '—' : esc(C.countOf(r.breakEven, r.noun)) + (r.x10 !== null ? ' <small>' + esc(C.times(r.x10)) + ' usual</small>' : '');
    return '<dl class="figs"><div><dt>' + (d.kind === 'spend' ? 'On a ' + esc(M(d.spend)) + ' basket' : 'Shopper pays') + '</dt><dd>' + esc(M(r.pay)) + ' <small>saves ' + r.pct + '%</small></dd></div>' +
      '<div><dt>You make</dt><dd>' + esc(M(r.after)) + per + '</dd></div>' +
      '<div><dt>' + (d.kind === 'spend' ? 'Without the offer' : 'A usual sale makes') + '</dt><dd>' + esc(M(r.before)) + '</dd></div>' +
      '<div><dt>Break-even</dt><dd>' + be + '</dd></div></dl>';
  }
  function flagHtml(d, f) {
    var g = state.g, acts = '', id = esc(d.id);
    if (f.k === 'was') acts = '<button class="btn small ghost" type="button" data-act="set" data-id="' + id + '" data-k="was" data-v="1">Yes, I really charged it</button>';
    if (f.k === 'limit') acts = '<button class="btn small ghost" type="button" data-act="set" data-id="' + id + '" data-k="limit" data-v="2">Limit 2 per customer</button>';
    if (f.k === 'ending') acts = C.endings(g, d).map(function (e) { return '<button class="btn small ghost" type="button" data-act="set" data-id="' + id + '" data-k="end" data-v="' + e.end + '">' + esc(M(e.price)) + (e.breakEven !== null ? ' <span class="tag">break-even ' + e.breakEven + '</span>' : '') + '</button>'; }).join('');
    return '<li>' + chip(f.soft ? '' : 'tight', f.soft ? 'Note' : 'Check') + esc(f.text) + (acts ? '<div class="flag-acts">' + acts + '</div>' : '') + '</li>';
  }
  function dealCard(d) {
    var g = state.g, r = rep(d), id = esc(d.id);
    if (!r.ok) return '<article class="card deal"><div class="deal-top"><h3>' + esc(C.KIND_NAMES[d.kind]) + '</h3>' + chip('bad', 'Needs editing') + '</div><p class="verdict">' + esc(r.verdict) + '</p><div class="deal-acts"><button class="btn small ghost" type="button" data-act="editdeal" data-id="' + id + '">Edit</button><button class="btn small danger" type="button" data-act="deldeal" data-id="' + id + '">Remove</button></div></article>';
    var alts = C.alternatives(g, d), locked = d.count > 0;
    var html = '<article class="card deal"><div class="deal-top"><h3>' + esc(C.dealTitle(g, d)) + '</h3>' + chip(r.status, r.label) + '</div>' +
      '<p class="verdict">' + esc(r.verdict) + '</p>' + figsHtml(d, r) +
      r.lines.map(function (l) { return '<p class="small">' + esc(l) + '</p>'; }).join('') + '<p class="small muted">' + esc(r.model) + '</p>' +
      '<h4>What is it for?</h4><div class="seg goals" role="group">' + C.GOALS.map(function (k) { return '<button type="button" data-act="set" data-id="' + id + '" data-k="goal" data-v="' + k + '" aria-pressed="' + (d.goal === k) + '">' + esc(C.GOAL_NAMES[k]) + '</button>'; }).join('') + '</div>';
    if (d.end) html += '<p class="small">Rounded to ' + esc(M(r.pay)) + '. <button class="link-btn" type="button" data-act="set" data-id="' + id + '" data-k="end" data-v="">Back to the exact price</button></p>';
    if (r.flags.length) html += '<h4>Before the sign goes up</h4><ul class="flags">' + r.flags.map(function (f) { return flagHtml(d, f); }).join('') + '</ul>';
    html += '<h4>Same pull, kinder to your margin</h4>';
    if (d.undo) html += '<p class="small">' + (d.alt ? 'You took a suggestion: ' + esc(d.alt) : 'You took a suggestion.') + ' <button class="link-btn" type="button" data-act="undo" data-id="' + id + '">Undo - back to the deal you had</button></p>';
    if (locked && alts.length) {
      // Sales are counted, so the shape stays: a cap can still be applied,
      // the other shapes are for next time.
      html += alts.map(function (a, i) { return a.k === 'limit' ? '<button class="fix" type="button" data-act="alt" data-id="' + id + '" data-n="' + i + '" data-k="limit">' + esc(a.label) + '</button>' : '<p class="small">Next time: ' + esc(a.label) + '</p>'; }).join('') +
        '<p class="small muted mb0">This deal has sales counted, so its shape stays as it is for this sale.</p>';
    } else if (alts.length) html += alts.map(function (a, i) { return '<button class="fix" type="button" data-act="alt" data-id="' + id + '" data-n="' + i + '" data-k="' + esc(a.k) + '">' + esc(a.label) + '</button>'; }).join('');
    else html += '<p class="small muted mb0">Nothing kinder can be made from your items - this is already the gentlest version of this deal.</p>';
    return html + '<div class="deal-acts"><button class="btn small ghost" type="button" data-act="editdeal" data-id="' + id + '">Edit</button><button class="btn small ghost" type="button" data-act="tab" data-tab="signs">Its sign</button><button class="btn small danger" type="button" data-act="deldeal" data-id="' + id + '">Remove</button></div></article>';
  }
  function dealsHtml() {
    var g = state.g, html = headHtml();
    if (!g.owner) {
      return html + '<section class="section"><div class="section-title"><h2>' + esc(plural(g.deals.length, 'deal')) + '</h2></div>' + (g.deals.length ? '<ul class="list">' + g.deals.map(function (d) {
        return '<li class="item"><span class="grow"><span class="t">' + esc(C.dealTitle(g, d)) + '</span><br><span class="s">' + esc(offerLine(d)) + '</span>' + (C.overlaps(g, d).length ? '<br><span class="s">Cannot be combined with other offers.</span>' : '') + '</span><span class="tag num">' + d.count + ' sold</span></li>';
      }).join('') + '</ul>' : '<p class="empty">The owner hasn’t added a deal yet.</p>') + '</section>';
    }
    if (!g.items.length) return html + '<p class="empty">A deal is built on your items. Add what you sell first - the price, what it costs you, and how many you’d usually sell.</p><div class="btn-row"><button class="btn" type="button" data-act="additem">Add an item</button></div>';
    if (!g.deals.length) return html + '<p class="empty">No deals yet. Type the one you’re thinking of and see whether it pays.</p><div class="btn-row"><button class="btn" type="button" data-act="adddeal">Build a deal</button></div>';
    return html + '<section class="section">' + g.deals.map(dealCard).join('') + '<div class="addbar"><button class="btn" type="button" data-act="adddeal">Build another deal</button></div>' +
      '<p class="small muted mt24">' + esc(HONEST) + ' ' + esc(C.WAS_RULE) + '</p></section>';
  }

  /* ---------------- items ---------------- */

  function itemsHtml() {
    var g = state.g, html = headHtml();
    var rows = g.items.map(function (it) {
      var inner = '<span class="grow"><span class="t">' + esc(it.name) + '</span><br><span class="s num">' + esc(C.itemLine(it, g.cur)) + '</span></span>';
      return g.owner ? '<li><button class="item" type="button" data-act="edititem" data-id="' + esc(it.id) + '">' + inner + '<span class="tag">Edit</span></button></li>' : '<li class="item">' + inner + '</li>';
    }).join('');
    return html + '<section class="section"><div class="section-title"><h2>' + esc(plural(g.items.length, 'item')) + '</h2></div>' +
      (rows ? '<ul class="list">' + rows + '</ul>' : '<p class="empty">' + (g.owner ? 'Nothing here yet. Add the things you’re thinking of putting on sale - and one or two that sell well at full price.' : 'The owner hasn’t added any items yet.') + '</p>') +
      (g.owner ? '<div class="addbar"><button class="btn" type="button" data-act="additem">Add an item</button><button class="btn ghost" type="button" data-act="read">Fill from a price list</button>' + (g.items.length ? '<button class="btn ghost" type="button" data-act="adddeal">Build a deal</button>' : '') + '</div>' +
        '<p class="small muted mt24">“Usually” is how many you’d sell over these ' + esc(plural(C.phase(g, today()).days, 'day')) + ' with no deal - your own honest guess. Everything is worked out from it.</p>' : '') + '</section>';
  }

  /* ---------------- signs ---------------- */

  function signHtml(d) {
    var g = state.g, s = C.sign(g, d);
    if (!s) return '';
    return '<li data-sign="' + esc(d.id) + '"><article class="sign"><p class="sg-shop">' + esc(s.shop) + '</p><p class="sg-head">' + esc(s.head) + '</p>' + (s.sub ? '<p class="sg-sub">' + esc(s.sub) + '</p>' : '') +
      s.lines.map(function (l) { return '<p class="sg-line">' + esc(l) + '</p>'; }).join('') +
      (s.fine.length ? '<p class="sg-fine">' + esc(s.fine.join(' · ')) + '</p>' : '') + '<p class="sg-foot">' + esc(s.title + ' · ' + s.dates) + '</p></article>' +
      '<div class="sign-acts"><button class="btn small" type="button" data-act="print" data-id="' + esc(d.id) + '">Print this sign</button><button class="btn small ghost" type="button" data-act="copypost" data-id="' + esc(d.id) + '">Copy as a post</button><button class="btn small ghost" type="button" data-act="copytext" data-id="' + esc(d.id) + '">Copy one line</button></div>' +
      (g.owner && d.kind !== 'spend' && !d.was ? '<p class="small muted mt8 noprint">No “was” price or “you save” on this one yet - tick the question on the deal if the usual price is one you really charged.</p>' : '') + '</li>';
  }
  function signsHtml() {
    var g = state.g, html = headHtml();
    if (!g.deals.length) return html + '<p class="empty">Each deal gets a sign here: a shelf card to print, a post and a one-line text to copy.</p>';
    return html + '<section class="section"><div class="section-title noprint"><h2>Signs</h2>' + (g.deals.length > 1 ? '<button class="link-btn" type="button" data-act="print">Print all, one a page</button>' : '') + '</div>' +
      '<p class="small muted noprint">Drawn from each deal’s own numbers - a percentage is rounded down, never up. ' + esc(C.WAS_RULE) + '</p><ul class="signs">' + g.deals.map(signHtml).join('') + '</ul></section>';
  }
  function printSigns(id) {
    $$('.signs > li').forEach(function (li) { li.classList.toggle('skip', Boolean(id) && li.dataset.sign !== id); });
    window.print();
  }

  /* ---------------- team ---------------- */

  function teamHtml() {
    var g = state.g;
    var people = g.members.filter(function (m) { return !m.left; }).map(function (m) {
      return '<li class="item">' + dot(m) + '<span class="grow"><span class="t">' + esc(m.name) + (m.me ? ' <span class="tag">you</span>' : '') + (m.host ? ' <span class="tag">owner</span>' : '') + '</span><br><span class="s">' + (m.host ? 'Sees everything, changes everything' : 'Sees deals, prices, the tally and stock') + '</span></span>' +
        (g.owner && !m.me ? '<button class="link-btn" type="button" data-act="kick" data-id="' + esc(m.id) + '" data-name="' + esc(m.name) + '">Remove</button>' : '') + '</li>';
    }).join('');
    return headHtml() +
      '<section class="section"><div class="section-title"><h2>Bring in the counter</h2></div><p class="muted">Anyone with the link or the code gets the tally on their phone, with a first name and no account. <b>Staff see the deals, the prices, the tally and the stock - never what things cost you, your margins, a break-even or a profit.</b> Those are never sent to their phones.</p>' +
      '<p class="code">' + esc(C.formatCode(g.code)) + '</p><div class="btn-row"><button class="btn" type="button" data-act="share">Send the link</button><button class="btn ghost" type="button" data-act="copycode">Copy the link</button></div></section>' +
      '<section class="section"><div class="section-title"><h2>Who’s on it</h2></div><ul class="list">' + people + '</ul></section>' +
      '<section class="section"><div class="section-title"><h2>This sale</h2></div><p class="small muted">' + esc(g.shop + ' · ' + whenLine(g) + (g.owner ? ' · usual margin ' + g.margin + '%' : '') + '. Doorbuster keeps a shop’s name, first names, items and counts only - no email address, no phone number and nothing about a customer. It is deleted for everyone a month after the last day (' + C.dayLong(g.keptUntil) + '), or now if the owner deletes it.') + '</p>' +
      '<div class="btn-row">' + (g.owner ? '<button class="btn ghost small" type="button" data-act="details">Change the days or the names</button><button class="btn danger small" type="button" data-act="delete">Delete this sale</button>' : '<button class="btn danger small" type="button" data-act="leave">Leave this sale</button>') + '</div></section>';
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
    // Something moved on another phone while the sheet was open.
    if (state.stale) { state.stale = false; if (state.g && TABS.indexOf(state.view) >= 0) redraw(); }
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
  function box(label, name, val, mode, max) { return '<label class="field"><span>' + label + '</span><input class="input" name="' + name + '" inputmode="' + (mode || 'decimal') + '" maxlength="' + (max || 10) + '" autocomplete="off" value="' + esc(val === null || val === undefined ? '' : String(val)) + '"></label>'; }

  function detailsSheet() {
    var g = state.g;
    sheet('<h2>The sale’s details</h2><form id="detForm" novalidate>' + saleFields(g) + '<div id="formErr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      var f = $('#detForm', root); wireSegs(f);
      onSubmit(f, function () { var b = saleBody(f); b.t = 'details'; act(b, function () { closeSheet(); toast('Saved.'); }); });
    });
  }
  function joinSheet(code) {
    sheet('<h2>Join a sale</h2><form id="joinForm" novalidate><label class="field"><span>The code</span><input class="input" name="code" autocomplete="off" autocapitalize="characters" maxlength="9" placeholder="ABC-DEF" value="' + esc(code ? C.formatCode(code) : '') + '"></label>' +
      '<div id="peek"></div><label class="field"><span>Your first name</span><input class="input" name="name" autocomplete="given-name" maxlength="20" value="' + esc(state.prefs.name) + '"></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Join</button></form>', function (root) {
      var f = $('#joinForm', root);
      function peek() {
        var c = C.normalizeCode(f.code.value);
        if (!C.isCode(c)) { $('#peek', root).innerHTML = ''; return; }
        api('GET', 'api/join/' + c).then(function (p) {
          if (p.already) { closeSheet(true); enter(p.already, 'today'); return; }
          $('#peek', root).innerHTML = '<div class="card mb16"><b>' + esc(p.title) + '</b><br><span class="small muted">' + esc(p.shop) + ' · ' + esc(p.when) + ' · ' + plural(p.members, 'person', 'people') + ' in</span></div><p></p>';
        }).catch(function (err) { showError(err, $('#peek', root)); });
      }
      f.code.addEventListener('input', peek); peek();
      onSubmit(f, function () {
        var c = C.normalizeCode(f.code.value);
        if (!C.isCode(c)) throw new Error('The code is six letters and numbers, like ABC-DEF.');
        api('POST', 'api/join/' + c, { name: f.name.value }).then(function (r) {
          state.prefs.name = C.cleanName(f.name.value) || state.prefs.name; savePrefs();
          closeSheet(true); return enter(r.id, 'today');
        }).catch(function (err) { showError(err, $('#formErr', root)); });
      });
    });
  }
  function link() { return location.origin + BASE + '#join=' + state.g.code; }
  function copy(text, ok) {
    function fallback() { var ta = document.createElement('textarea'); ta.value = text; ta.className = 'vh'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(ok); } catch (e) { toast('Could not copy - select it by hand.'); } ta.remove(); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(ok); }, fallback); else fallback();
  }

  /* ---- an item ---- */

  function itemSheet(id) {
    var g = state.g, it = id ? itemById(id) : null;
    if (id && !it) return;
    var days = C.phase(g, today()).days;
    sheet('<h2>' + (it ? esc(it.name) : 'New item') + '</h2><form id="itemForm" novalidate>' +
      '<label class="field"><span>Item</span><input class="input" name="name" maxlength="40" value="' + esc(it ? it.name : '') + '"' + (it ? '' : ' placeholder="Soy candle"') + '></label>' +
      '<div class="two">' + box('Usual price (' + esc(g.cur) + ')', 'price', it ? C.moneyField(it.price) : '') + box('It costs you (' + esc(g.cur) + ')', 'cost', it ? C.moneyField(it.cost) : '') + '</div>' +
      '<div class="two">' + box('Usually sold in ' + esc(plural(days, 'day')), 'base', it ? it.base : '', 'numeric', 6) + box('Stock on hand (optional)', 'stock', it && it.stock !== null ? it.stock : '', 'numeric', 6) + '</div>' +
      '<p class="small muted hint">“Usually sold” is how many you’d sell over the sale’s days with no deal. Stock is what you have when it starts' + (it && it.sold ? ' (' + it.sold + ' counted as sold so far)' : '') + '.</p>' +
      '<div id="formErr"></div><button class="btn block" type="submit">' + (it ? 'Save' : 'Add it') + '</button>' +
      (it ? '<button class="btn danger block" type="button" data-act="delitem" data-id="' + esc(id) + '">Remove this item</button>' : '') + '</form>', function (root) {
      var f = $('#itemForm', root);
      onSubmit(f, function () {
        var item = { name: f.name.value, price: parseBox(f.price, 'Usual price'), cost: parseBox(f.cost, 'What it costs you'), base: parseCount(f.base, 'Usually sold'), stock: parseCount(f.stock, 'Stock on hand', true) };
        if (it) act({ t: 'edititem', id: id, item: item }, function () { closeSheet(); toast('Saved - every deal on it was worked out again.'); });
        else act({ t: 'additem', item: item }, function () { closeSheet(); toast(item.name.trim() + ' added.'); });
      });
    });
  }
  function stockSheet(id) {
    var it = itemById(id); if (!it) return;
    sheet('<h2>How many ' + esc(it.name) + ' are really left?</h2><p class="muted">Count the shelf and type it. The tally has ' + it.sold + ' as sold' + (it.left !== null ? ', which leaves ' + it.left : '') + '.</p><form id="stockForm" novalidate>' + box('Left right now (empty to stop keeping stock)', 'left', it.left === null ? '' : it.left, 'numeric', 6) +
      '<div id="formErr"></div><button class="btn block" type="submit">Save</button></form>', function (root) {
      var f = $('#stockForm', root);
      onSubmit(f, function () { act({ t: 'stock', id: id, left: parseCount(f.left, 'Left', true) }, function () { closeSheet(); toast('Stock corrected.'); }); });
    });
  }

  /* ---- a deal ---- */

  var KIND_HELP = { pct: '30% off the candles', amount: '$5 off a scarf', multi: 'Buy 2, get 1 free - or get 1 half price', bundle: 'Two to four items for one price', spend: 'Spend $50, get $10 off' };
  function kindSheet() {
    sheet('<h2>What kind of deal?</h2><p class="muted">Pick the shape. You’ll see what it does to your margin before anything goes on a sign.</p><div class="kinds">' +
      C.KINDS.map(function (k) { return '<button class="kind" type="button" data-act="newdeal" data-kind="' + k + '"><b>' + esc(C.KIND_NAMES[k]) + '</b><span>' + esc(KIND_HELP[k].replace(/\$/g, state.g.cur)) + '</span></button>'; }).join('') + '</div>');
  }
  function itemSelect(label, name, sel, optional) {
    var g = state.g;
    return '<label class="field"><span>' + label + '</span><select class="input" name="' + name + '">' + (optional ? '<option value="">-</option>' : '') + g.items.map(function (it) { return '<option value="' + esc(it.id) + '"' + (it.id === sel ? ' selected' : '') + '>' + esc(it.name + ' - ' + M(it.price)) + '</option>'; }).join('') + '</select></label>';
  }
  function dealSheet(kind, id) {
    var g = state.g, d = id ? dealById(id) : null;
    if (id && !d) return;
    if (d) kind = d.kind;
    if (kind !== 'spend' && g.items.length < (kind === 'bundle' ? 2 : 1)) { sheet('<h2>' + esc(C.KIND_NAMES[kind]) + '</h2><p>' + (kind === 'bundle' ? 'A bundle needs at least two items.' : 'Add an item first.') + '</p><button class="btn block" type="button" data-act="additem">Add an item</button>'); return; }
    var x = d || { items: [], pct: 30, off: 0, n: 2, m: 1, mpct: 100, price: 0, spend: 0, save: 0, basket: 0, baskets: 0, clear: 0, limit: 0, wsl: false, goal: 'more', was: false, end: '' };
    var cur = esc(g.cur), body = '';
    if (kind === 'pct') body = itemSelect('On', 'i0', x.items[0]) + box('Percent off (5 to 90)', 'pct', x.pct, 'numeric', 2);
    else if (kind === 'amount') body = itemSelect('On', 'i0', x.items[0]) + box('Amount off (' + cur + ')', 'off', x.off ? C.moneyField(x.off) : '');
    else if (kind === 'multi') {
      body = itemSelect('On', 'i0', x.items[0]) + '<div class="two">' + box('Buy', 'n', x.n, 'numeric', 2) + box('Get', 'm', x.m, 'numeric', 2) + '</div>' +
        '<label class="field"><span>The extra ones are</span><select class="input" name="mpct">' + [[100, 'Free'], [50, 'Half price'], [25, '25% off'], [20, '20% off'], [10, '10% off']].map(function (o) { return '<option value="' + o[0] + '"' + (x.mpct === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + (d && [100, 50, 25, 20, 10].indexOf(x.mpct) < 0 ? '<option value="' + x.mpct + '" selected>' + x.mpct + '% off</option>' : '') + '</select></label>';
    } else if (kind === 'bundle') {
      body = itemSelect('The item people come for', 'i0', x.items[0]) + itemSelect('With', 'i1', x.items[1] || (g.items[1] && g.items[1].id)) + itemSelect('And (optional)', 'i2', x.items[2] || '', true) + itemSelect('And (optional)', 'i3', x.items[3] || '', true) + box('All together for (' + cur + ')', 'price', x.price ? C.moneyField(x.price) : '');
    } else {
      body = '<div class="two">' + box('Spend at least (' + cur + ')', 'spend', x.spend ? C.moneyField(x.spend) : '') + box('Get off (' + cur + ')', 'save', x.save ? C.moneyField(x.save) : '') + '</div>' +
        box('Your usual basket - what one shopper spends (' + cur + ')', 'basket', x.basket ? C.moneyField(x.basket) : '') +
        '<div class="two">' + box('Baskets you’d usually ring up over these days', 'baskets', d ? x.baskets : '', 'numeric', 6) + box('How many of those already reach the spend', 'clear', d ? x.clear : '', 'numeric', 6) + '</div>' +
        '<p class="small muted hint">Those baskets get the money off for nothing - it is the first thing this deal has to earn back.</p>';
    }
    sheet('<h2>' + esc(C.KIND_NAMES[kind]) + '</h2><form id="dealForm" novalidate>' + body +
      box('Limit per customer (empty for none)', 'limit', x.limit || '', 'numeric', 2) +
      '<label class="check"><input type="checkbox" name="wsl"' + (x.wsl ? ' checked' : '') + '><span>While supplies last</span></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">' + (d ? 'Save' : 'See what it does') + '</button></form>', function (root) {
      var f = $('#dealForm', root);
      onSubmit(f, function () {
        var deal = { kind: kind, items: [], limit: parseCount(f.limit, 'Limit per customer', true) || 0, wsl: f.wsl.checked, goal: x.goal, was: x.was, end: x.end };
        if (kind !== 'spend') deal.items = ['i0', 'i1', 'i2', 'i3'].map(function (n) { return f[n] ? f[n].value : ''; }).filter(Boolean);
        if (kind === 'pct') deal.pct = parseCount(f.pct, 'Percent off');
        else if (kind === 'amount') deal.off = parseBox(f.off, 'Amount off');
        else if (kind === 'multi') { deal.n = parseCount(f.n, 'Buy'); deal.m = parseCount(f.m, 'Get'); deal.mpct = Number(f.mpct.value); }
        else if (kind === 'bundle') deal.price = parseBox(f.price, 'All together for');
        else { deal.spend = parseBox(f.spend, 'Spend at least'); deal.save = parseBox(f.save, 'Get off'); deal.basket = parseBox(f.basket, 'Your usual basket'); deal.baskets = parseCount(f.baskets, 'Usual baskets'); deal.clear = parseCount(f.clear, 'Baskets that already reach the spend'); }
        if (d) act({ t: 'editdeal', id: id, deal: deal }, function () { closeSheet(); toast('Saved - worked out again.'); });
        else act({ t: 'adddeal', deal: deal }, function () { closeSheet(); if (state.view !== 'deals') go('deals'); toast('Here’s what it does.'); });
      });
    });
  }

  /* ---- fill from a price list (signed in; the one model call) ---- */

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) { reject(new Error('Choose a photo or screenshot (an image).')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.addEventListener('load', function () {
        var k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve({ type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85) });
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That image could not be opened. Try a screenshot.')); });
      img.src = url;
    });
  }
  function draftsSheet(drafts) {
    var g = state.g, cur = esc(g.cur);
    sheet('<h2>Check these, then add them</h2><p class="muted">A draft read from your list - nothing is saved yet. Fix anything that is wrong, fill in a missing price or cost, and untick what you don’t want.</p><form id="draftForm" novalidate><ul class="drafts">' +
      drafts.map(function (r, i) {
        return '<li><label class="check"><input type="checkbox" name="on' + i + '" checked><span>Add this one</span></label><label class="field"><span>Item</span><input class="input" name="name' + i + '" maxlength="40" value="' + esc(r.name) + '"></label>' +
          '<div class="two">' + box('Price (' + cur + ')', 'price' + i, r.price === null ? '' : C.moneyField(r.price)) + box('Costs you (' + cur + ')', 'cost' + i, r.cost === null ? '' : C.moneyField(r.cost)) + '</div></li>';
      }).join('') + '</ul><p class="small muted">They go in with “usually sold” at 0 - open each one afterwards and type your usual number, or no break-even can be worked out.</p>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Add the ticked items</button></form>', function (root) {
      var f = $('#draftForm', root);
      onSubmit(f, function () {
        var items = [];
        drafts.forEach(function (r, i) {
          if (!f['on' + i].checked) return;
          var label = f['name' + i].value.trim() || 'Item ' + (i + 1);
          items.push({ name: f['name' + i].value, price: parseBox(f['price' + i], label + ' - price'), cost: parseBox(f['cost' + i], label + ' - cost'), base: 0, stock: null });
        });
        if (!items.length) throw new Error('Tick at least one item.');
        act({ t: 'additems', items: items }, function () { closeSheet(); toast(plural(items.length, 'item') + ' added. Now type how many you usually sell.', 5000); });
      });
    });
  }
  function readSheet() {
    if (state.demo) { draftsSheet(D.drafts()); return; }
    if (!signedIn()) {
      sheet('<h2>Fill from a price list</h2><p>Paste a price list or a supplier invoice, or add a photo of one, and Doorbuster reads the items, prices and costs into a draft you check before anything is saved.</p><p class="muted">Reading it uses AI, which costs money to run - so this one step needs a free account. Everything else in Doorbuster works without one, and typing an item in takes a few seconds.</p>' +
        '<button class="btn block" type="button" data-act="account">Create a free account or sign in</button><button class="btn ghost block" type="button" data-act="additem">Type an item in instead</button>');
      return;
    }
    sheet('<h2>Fill from a price list</h2><p class="muted">Paste the list, or add a photo or screenshot of it. It is read once and not kept; you check the draft before anything is saved.</p>' +
      '<form id="readForm" novalidate><label class="field"><span>Paste the list</span><textarea class="input" name="text" maxlength="8000" placeholder="Soy candle 22.00…"></textarea></label>' +
      '<label class="field"><span>Or a photo or screenshot of it</span><input class="input" type="file" name="photo" accept="image/*"></label>' +
      '<div id="formErr"></div><button class="btn block" type="submit">Read it</button><button class="btn ghost block" type="button" data-act="additem">Type an item in instead</button></form>', function (root) {
      $('#readForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f), file = f.photo.files && f.photo.files[0];
        var body = {};
        if (!file && !f.text.value.trim()) { showError(new Error('Paste the list, or add a photo of it.'), $('#formErr', root)); return; }
        btn.disabled = true; btn.textContent = 'Reading…';
        (file ? shrink(file).then(function (p) { body.photo = p; }) : Promise.resolve(body.text = f.text.value)).then(function () { return api('POST', 'api/read', body); })
          .then(function (r) { draftsSheet(r.drafts); })
          .catch(function (err) { btn.disabled = false; btn.textContent = 'Read it'; showError(err, $('#formErr', root)); });
      });
    });
  }

  /* ---------------- the example ---------------- */

  function startDemo() {
    closeSheet(true);
    state.demo = D.doc(); state.demoMe = D.ME; demoView(); state.view = 'today';
    history.replaceState(null, '', BASE + '#today'); draw(); scrollTo(0, 0);
  }
  function leaveDemo() {
    state.demo = null; state.g = null; state.memo = null; closeSheet(true);
    if (state.prefs.cur) { enter(state.prefs.cur); return; }
    go('home');
  }

  /* ---------------- the account (only for a second phone, and the one AI step) ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }
  /** Signed in: keep this phone's sales on the account, and bring the
   *  account's to this phone. */
  function syncMine() {
    if (!signedIn() || !state.me.keep) return Promise.resolve();
    var chain = Promise.resolve();
    state.list.forEach(function (g) { chain = chain.then(function () { return api('POST', 'api/s/' + encodeURIComponent(g.id) + '/keep').catch(function () { /* gone, or not ours */ }); }); });
    return chain.then(function () { return api('GET', 'api/mine'); }).then(function (r) {
      var have = {}; state.list.forEach(function (g) { have[g.id] = 1; });
      (r.list || []).forEach(function (g) { if (!have[g.id]) state.list.push(g); });
      real.putList(state.list); state.list = real.getList();
      if (state.view === 'home') keepPlace(draw);
    }).catch(function () { /* the phone's own list stands */ });
  }
  var FREE_LINE = 'Doorbuster is free with no account. A free account does two things: your sales open on your other phone, as their owner, and you can fill items in from a price list. One account works across every app on this site.';
  function openAccount() {
    var mode = 'register';
    function draw2(root) {
      $('.body', root).innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2><p class="muted">' + esc(FREE_LINE) + '</p>' +
        '<form id="authForm"><label class="field"><span>Your email (for your account only - never shown to your staff)</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
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
    sheet('<h2>Account</h2><p class="small muted">' + esc(state.me.email) + '</p><p class="small">Your sales are kept on this account, so they open on your other phone when you sign in there. Nobody on a sale ever sees this address.</p>' +
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
  function signOf(id) { var d = dealById(id); return d ? C.sign(state.g, d) : null; }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.dataset.act, id = el.dataset.id, d, s;
    if (a === 'home') { e.preventDefault(); closeSheet(true); if (state.demo) { state.demo = null; state.g = null; } go('home'); }
    else if (a === 'tab') { if (state.g) go(el.dataset.tab); }
    else if (a === 'closesheet') closeSheet();
    else if (a === 'account') { if (signedIn()) openAccountSheet(); else openAccount(); }
    else if (a === 'new') { if (state.demo) { state.demo = null; state.g = null; } go('new'); }
    else if (a === 'join') joinSheet('');
    else if (a === 'demo') startDemo();
    else if (a === 'leavedemo') leaveDemo();
    else if (a === 'demoswap') { state.demoMe = state.demoMe === D.ME ? D.STAFF : D.ME; demoView(); closeSheet(true); if (state.view !== 'today') go('today'); else redraw(); }
    else if (a === 'open') enter(id);
    else if (a === 'additem') itemSheet(null);
    else if (a === 'edititem') itemSheet(id);
    else if (a === 'delitem') { if (confirm('Remove this item from the sale?')) act({ t: 'delitem', id: id }, function () { closeSheet(); toast('Removed.'); }); }
    else if (a === 'stock') stockSheet(id);
    else if (a === 'read') readSheet();
    else if (a === 'adddeal') kindSheet();
    else if (a === 'newdeal') dealSheet(el.dataset.kind, null);
    else if (a === 'editdeal') dealSheet(null, id);
    else if (a === 'deldeal') { if (confirm('Remove this deal? Its tally goes with it.')) act({ t: 'deldeal', id: id }, function () { toast('Removed.'); }); }
    else if (a === 'set') {
      var k = el.dataset.k, v = el.dataset.v;
      act({ t: 'set', id: id, k: k, v: k === 'was' ? v === '1' : k === 'limit' ? Number(v) : v }, function () { if (k === 'was') toast('The sign now shows the “was” price and the saving.', 4500); else if (k === 'end') toast(v ? 'Rounded - the break-even moved with it.' : 'Back to the exact price.'); });
    }
    else if (a === 'alt') act({ t: 'alt', id: id, n: Number(el.dataset.n), k: el.dataset.k }, function () { toast('Changed. Undo is on the deal.', 4500); });
    else if (a === 'undo') act({ t: 'undo', id: id }, function () { toast('Back to the deal you had.'); });
    else if (a === 'tally') {
      d = dealById(id);
      var n = Number(el.dataset.n), title = d ? C.dealTitle(state.g, d) : '';
      act({ t: 'tally', id: id, n: n }, function () { var now = dealById(id); say(title + ': ' + (now ? now.count : '')); });
    }
    else if (a === 'print') printSigns(id || '');
    else if (a === 'copypost') { s = signOf(id); if (s) copy(s.post, 'Copied - paste it where you post.'); }
    else if (a === 'copytext') { s = signOf(id); if (s) copy(s.text, 'Copied - one line, ready to text.'); }
    else if (a === 'details') detailsSheet();
    else if (a === 'share') {
      var text = 'Join the tally for ' + state.g.title + ' at ' + state.g.shop + ':';
      if (navigator.share) navigator.share({ title: 'Doorbuster - ' + state.g.title, text: text, url: link() }).catch(function () { /* cancelled */ }); else copy(text + ' ' + link(), 'Link copied - send it to the counter.');
    }
    else if (a === 'copycode') copy(link(), 'Link copied - send it to the counter.');
    else if (a === 'kick') { if (confirm('Remove ' + el.dataset.name + ' from this sale? What they counted stays counted.')) gCall('DELETE', '/members/' + encodeURIComponent(id), function (r) { adopt(r.g); redraw(); }); }
    else if (a === 'leave') { if (confirm('Leave this sale? You can rejoin with the code.')) gCall('DELETE', '/me', function () { forgetLocal(state.g.id); state.g = null; go('home'); toast('You left.'); }); }
    else if (a === 'delete') { if (confirm('Delete this sale for everyone? The items, the deals and the tally are gone for good.')) gCall('DELETE', '', function () { forgetLocal(state.g.id); state.g = null; go('home'); toast('Deleted.'); }); }
  });
  window.addEventListener('popstate', function () { closeSheet(true); route(); });
  window.addEventListener('hashchange', route);
  window.addEventListener('afterprint', function () { $$('.signs > li.skip').forEach(function (li) { li.classList.remove('skip'); }); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedulePoll(0); else clearTimeout(pollTimer); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy; online it still works */ });

  /* ---------------- boot ---------------- */

  draw();
  loadMe().then(syncMine);
  var h0 = location.hash.replace(/^#/, '');
  if (/^join=/.test(h0) || h0 === 'try' || h0 === 'new') route();
  else if (state.prefs.cur && h0 !== 'home') enter(state.prefs.cur, TABS.indexOf(h0) >= 0 ? h0 : null);
  else route();
})();
