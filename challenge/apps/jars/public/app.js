/* Jars - the page. One file, no build step.
 *
 * EVERYTHING LIVES ON THIS PHONE. The family is kept in localStorage
 * (jars-family-v1): the children, their jars, goals and history, the
 * currency, and the grown-up PIN as a salted hash. Every rule - paydays, the
 * split, interest, goals, the moves, the CSV, the calendar file, the
 * grandparents' snapshot - is JarsCore, run here. This page makes NO request
 * of its own: no account call, no AI (there is none), nothing that takes a
 * child. (The shared verify banner, loaded beside it like every lab app's,
 * asks the account service whether someone signed in elsewhere has an
 * address to confirm; it sends nothing about the family.)
 *
 * Every string that was typed (a name, a note, a goal), imported, or came in
 * a link is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.JarsCore;
  var D = window.JarsDemo;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_HOME = 'jars-family-v1';
  var esc = C.esc, plural = C.plural;
  var TZ = (function () { try { return C.cleanTz(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { return 'UTC'; } })();
  var LOCALE = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
  var REDUCED = (function () { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } })();
  var TABS = [['jars', '🫙', 'Jars'], ['goals', '🎯', 'Goals'], ['share', '💌', 'Share'], ['family', '👪', 'Grown-ups']];
  var UNLOCK_MS = 2 * 60 * 1000;
  var DEMO_PIN = '1234';

  var state = {
    view: 'start',            // start | app
    tab: 'jars',              // jars | goals | share | family | kid | chart
    source: null,             // demo | mine
    mine: null,               // {kids, pinMode, pin}
    demo: null,
    settings: null,
    kidId: null,
    form: null,               // the add/edit-a-child draft
    editId: null,             // which child the form edits (null = new)
    share: { hide: false, link: null, forKey: null },
    chartKid: 'all',
    unlockedUntil: 0,
    pinFails: 0,
    lockUntil: 0,
    gift: null,               // a gift note waiting to be added
    day: null,
    storageWarned: false,
    queue: [],                // celebrations to show after the payday sheet
  };

  /* ---------------- plumbing ---------------- */

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  var toastTimer = null;
  function toast(msg, ms, buttons) {
    $$('.toast').forEach(function (t) { t.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast' + (buttons && buttons.length ? '' : ' plain'); t.setAttribute('role', 'status');
    var m = document.createElement('span'); m.className = 'tmsg'; m.textContent = msg; t.appendChild(m);
    (buttons || []).forEach(function (b) {
      var x = document.createElement('button');
      x.type = 'button'; x.className = 'btn small light'; x.textContent = b.label;
      x.addEventListener('click', function () { t.remove(); b.run(); });
      t.appendChild(x);
    });
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || (buttons && buttons.length ? 8000 : 3000));
  }
  function copyText(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the link and copy it by hand.'); });
  }
  function download(name, type, text) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------------- the family ---------------- */

  function today() { return C.localDate(Date.now(), TZ); }
  function isDemo() { return state.source === 'demo'; }
  function fam() { return isDemo() ? state.demo : state.mine; }
  function kids() { var f = fam(); return f ? f.kids : []; }
  function kid() { var ks = kids(); return ks.filter(function (k) { return k.id === state.kidId; })[0] || ks[0] || null; }
  function cur() { return state.settings.currency; }
  function ctx() { return { today: today(), currency: cur(), locale: LOCALE }; }
  function S(m) { return C.short(m, cur(), LOCALE); }
  function M(m) { return C.money(m, cur(), LOCALE); }
  function poss(name) { return name + '’s'; }

  function loadMine() {
    var raw = recall(K_HOME);
    state.settings = C.cleanSettings(raw && raw.settings, LOCALE);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.kids)) return null;
    var c = { today: today() };
    var list = raw.kids.map(function (x) { return C.cleanKid(x, c); }).filter(Boolean).slice(0, C.LIMITS.kids);
    var pin = C.cleanPinRecord(raw.pin);
    var mode = raw.pinMode === 'off' ? 'off' : raw.pinMode === 'on' && pin ? 'on' : 'unset';
    if (C.isKidId(raw.kidId)) state.kidId = raw.kidId;
    return { kids: list, pinMode: mode, pin: mode === 'on' ? pin : null };
  }
  function persist() {
    if (!state.mine) return;
    var s = state.settings;
    var ok = keep(K_HOME, { v: 1, settings: { currency: s.currency, curAuto: s.curAuto }, pinMode: state.mine.pinMode, pin: state.mine.pin, kids: state.mine.kids, kidId: isDemo() ? null : state.kidId });
    if (!ok && !state.storageWarned) {
      state.storageWarned = true;
      toast('This browser won’t let Jars save (private browsing?). Changes last until the tab closes - export a file to keep them.', 6000);
    }
  }
  function ensureMine() {
    if (!state.mine) state.mine = { kids: [], pinMode: 'unset', pin: null };
    return state.mine;
  }
  function replaceKid(nk) {
    var f = fam();
    f.kids = f.kids.map(function (k) { return k.id === nk.id ? nk : k; });
  }
  function save() { if (!isDemo()) persist(); }

  /** Paydays for every child, then goals reached. Returns what was paid. */
  function runPaydays() {
    var f = fam();
    if (!f) return [];
    var t = today();
    var paid = [];
    f.kids = f.kids.map(function (k) {
      var r = C.runPaydays(k, t);
      var nk = r.kid;
      if (r.paid.length) paid.push({ kid: nk, paid: r.paid, skipped: r.skipped });
      var cr = C.checkReached(nk, t);
      if (cr.reached) { nk = cr.kid; state.queue.push({ kidId: nk.id, goalId: cr.reached.id }); }
      return nk;
    });
    if (paid.length || state.queue.length) save();
    return paid;
  }
  function afterOpen() {
    var paid = runPaydays();
    if (state.view === 'app' && (paid.length || state.queue.length)) draw();
    if (paid.length) paydaySheet(paid);
    else nextCelebration();
  }
  function openDemo() {
    state.demo = D.build(today(), cur());
    state.demo.pinMode = 'demo';
    state.source = 'demo';
    state.kidId = state.demo.kids[0].id;
    state.queue = [];
    resetShare();
    go('jars');
    afterOpen();
  }
  function openMine() {
    ensureMine();
    state.source = 'mine';
    var ks = state.mine.kids;
    if (!ks.some(function (k) { return k.id === state.kidId; })) state.kidId = ks.length ? ks[0].id : null;
    resetShare();
    if (!ks.length) { newKidForm(); return; }
    go('jars');
    afterOpen();
  }
  function resetShare() { state.share.link = null; state.share.forKey = null; }

  /* ---------------- the grown-up PIN: a speed bump, not a lock ---------------- */

  function pinMode() { var f = fam(); return f ? f.pinMode : 'unset'; }
  /** Run `then` once a grown-up has said yes: straight away when this phone
   *  has no PIN or it was entered in the last two minutes; otherwise the
   *  keypad (or, the first time, setting one up). */
  function grownUp(reason, then) {
    var mode = pinMode();
    if (mode === 'off' || Date.now() < state.unlockedUntil) return then();
    if (mode === 'on' || mode === 'demo') return pinSheet(reason, then);
    return pinSetupSheet(reason, then);
  }
  function keypadHtml() {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    return '<div class="pindots" id="pinDots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>' +
      '<p class="vh" id="pinCount" aria-live="polite"></p>' +
      '<div class="keypad" role="group" aria-label="PIN keypad">' + keys.map(function (k) {
        if (!k) return '<span class="key blank"></span>';
        return '<button class="key" type="button" data-key="' + (k === '⌫' ? 'back' : k) + '" aria-label="' + (k === '⌫' ? 'Delete' : k) + '">' + k + '</button>';
      }).join('') + '</div>';
  }
  /** Wire a keypad: digits by tap or keyboard, `done(pin)` at four. */
  function wireKeypad(root, done) {
    var pin = '';
    function show() {
      $$('#pinDots span', root).forEach(function (s, i) { s.classList.toggle('on', i < pin.length); });
      var c = $('#pinCount', root); if (c) c.textContent = pin.length + ' of 4';
    }
    function press(k) {
      if (k === 'back') pin = pin.slice(0, -1);
      else if (pin.length < 4) pin += k;
      show();
      if (pin.length === 4) { var p = pin; pin = ''; setTimeout(function () { done(p, function () { show(); }); }, 120); }
    }
    root.addEventListener('click', function (e) { var b = e.target.closest('[data-key]'); if (b) press(b.getAttribute('data-key')); });
    function onKey(e) {
      if ($('#sheet').hidden || !root.contains($('#pinDots'))) { document.removeEventListener('keydown', onKey); return; }
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); } else if (e.key === 'Backspace') { e.preventDefault(); press('back'); }
    }
    document.addEventListener('keydown', onKey);
    show();
  }
  function shake(root) { var d = $('#pinDots', root); if (!d) return; d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); }
  function pinSheet(reason, then) {
    var demo = pinMode() === 'demo';
    sheet('<h2>🔒 Grown-up PIN</h2><p class="center"><b>' + esc(reason) + '</b></p>' +
      (demo ? '<p class="note center small">In the example, the PIN is <b>1234</b>.</p>' : '') +
      keypadHtml() + '<p class="err center" id="pinErr" role="alert"></p>' +
      '<p class="speedbump">A speed bump for little fingers, not security.</p>' +
      (demo ? '' : '<p class="center"><button class="link-btn" type="button" id="forgot">Forgot it?</button></p>'),
    function (root) {
      wireKeypad(root, function (pin, reset) {
        var e = $('#pinErr', root);
        if (Date.now() < state.lockUntil) { e.textContent = 'Too many tries - wait ' + Math.ceil((state.lockUntil - Date.now()) / 1000) + ' seconds.'; reset(); return; }
        var check = demo ? Promise.resolve(pin === DEMO_PIN) : C.checkPin(pin, state.mine.pin);
        check.then(function (ok) {
          if (ok) { state.pinFails = 0; state.unlockedUntil = Date.now() + UNLOCK_MS; closeSheet(true); then(); return; }
          state.pinFails++;
          shake(root);
          if (state.pinFails >= 5) { state.pinFails = 0; state.lockUntil = Date.now() + 30000; e.textContent = 'Too many tries - wait 30 seconds.'; }
          else e.textContent = 'Not quite - try again.';
          reset();
        });
      });
      var f = $('#forgot', root);
      if (f) f.addEventListener('click', function () { forgotSheet(reason, then); });
    });
  }
  function pinSetupSheet(reason, then) {
    var first = null;
    sheet('<h2>🔒 Set a grown-up PIN</h2><p>' + esc(reason) + ' Pick four digits the kids don’t know. Jars asks for them before anything that <b>adds money</b> or <b>takes from Save</b>.</p>' +
      '<p class="center" id="pinStep"><b>Choose a PIN</b></p>' + keypadHtml() + '<p class="err center" id="pinErr" role="alert"></p>' +
      '<p class="speedbump">A speed bump for little fingers, not security: it’s kept only on this phone, as a scrambled hash, and anyone holding the phone can clear it.</p>' +
      '<button class="btn ghost block" type="button" id="noPin">No PIN on this phone</button>',
    function (root) {
      wireKeypad(root, function (pin, reset) {
        if (first === null) { first = pin; $('#pinStep', root).innerHTML = '<b>Again, to be sure</b>'; $('#pinErr', root).textContent = ''; reset(); return; }
        if (pin !== first) { first = null; shake(root); $('#pinStep', root).innerHTML = '<b>Choose a PIN</b>'; $('#pinErr', root).textContent = 'Those didn’t match - start again.'; reset(); return; }
        C.hashPin(pin).then(function (rec) {
          ensureMine(); state.mine.pinMode = 'on'; state.mine.pin = rec; persist();
          state.unlockedUntil = Date.now() + UNLOCK_MS;
          closeSheet(true); toast('PIN set. It’s only on this phone.'); then();
        }, function () { $('#pinErr', root).textContent = 'This browser can’t keep a PIN - try another.'; reset(); });
      });
      $('#noPin', root).addEventListener('click', function () {
        ensureMine(); state.mine.pinMode = 'off'; state.mine.pin = null; persist();
        closeSheet(true); toast('No PIN - you can set one in Grown-ups any time.'); then();
      });
    });
  }
  /** Forgotten PIN: the grown-ups question kids' apps use. */
  function forgotSheet(reason, then) {
    var a = 6 + Math.floor(Math.random() * 7), b = 6 + Math.floor(Math.random() * 7);
    sheet('<h2>Forgot the PIN?</h2><p>Answer this and the PIN is removed, then you can choose a new one.</p>' +
      '<form id="gateForm"><label class="field"><span>Grown-ups only: what’s ' + a + ' × ' + b + '?</span><input class="input money" name="ans" inputmode="numeric" autocomplete="off" required></label><p class="err" id="gateErr" role="alert"></p><button class="btn block" type="submit">Remove the PIN</button></form>' +
      '<p class="small muted">Yes, a determined kid who knows their times tables could do this too. That’s why it’s a speed bump, not a lock.</p>',
    function (root) {
      $('#gateForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        if (Number(e.target.ans.value.trim()) !== a * b) { $('#gateErr', root).textContent = 'Not quite.'; return; }
        state.mine.pinMode = 'unset'; state.mine.pin = null; persist();
        pinSetupSheet(reason, then);
      });
    });
  }

  /* ---------------- moves, with undo ---------------- */

  /** Try a move on a copy first (the rules are pure), so a mistake is shown
   *  in the sheet before anyone is asked for a PIN. */
  function tryAct(kind, opts) {
    var k = kid();
    try { C.act(k, kind, opts, ctx()); return null; } catch (e) { return e.message; }
  }
  function doAct(kind, opts) {
    var k = kid();
    if (!k) return;
    var r;
    try { r = C.act(k, kind, opts, ctx()); } catch (e) { toast(e.message, 4000); return; }
    var nk = r.kid;
    var cr = C.checkReached(nk, today());
    if (cr.reached) { nk = cr.kid; state.queue.push({ kidId: nk.id, goalId: cr.reached.id }); }
    replaceKid(nk);
    save();
    closeSheet(true);
    draw();
    if (cr.reached) { nextCelebration(); return; }
    var token = r.token;
    toast(r.msg, 8000, [{ label: 'Undo', run: function () { undoAct(token); } }]);
  }
  function undoAct(token) {
    var k = kids().filter(function (x) { return x.id === token.id; })[0];
    if (!k) return;
    try { replaceKid(C.undo(k, token)); } catch (e) { toast(e.message); return; }
    save(); draw(); toast('Undone.');
  }

  /* ---------------- routing ---------------- */

  function go(tab) {
    if (tab === 'start') { state.view = 'start'; history.pushState(null, '', BASE + '#start'); draw(); scrollTo(0, 0); return; }
    state.view = 'app'; state.tab = tab;
    history.pushState(null, '', BASE + '#' + tab);
    draw(); scrollTo(0, 0);
    var m = $('#main'); if (m && tab !== 'kid') try { m.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    var first = false;
    if (!state.source && state.mine && state.mine.kids.length) { state.source = 'mine'; first = true; }
    if (h.indexOf('gift/') === 0) {
      // A grandparent's gift note opened on this phone: the jars first (with
      // any payday due), then the note to add - behind the grown-up PIN.
      var g = C.readGift(location.hash);
      history.replaceState(null, '', BASE + '#jars');
      if (state.source) { runPaydays(); state.view = 'app'; state.tab = 'jars'; } else state.view = 'start';
      draw();
      if (g) giftSheet(g); else toast('That gift note can’t be read - ask for it again.', 5000);
      return;
    }
    if (h === 'example') { history.replaceState(null, '', BASE + '#jars'); openDemo(); return; }
    if (state.source && (TABS.some(function (t) { return t[0] === h; }) || h === 'chart')) { state.view = 'app'; state.tab = h; }
    else if (h === 'start' || !state.source) state.view = 'start';
    else { state.view = 'app'; state.tab = 'jars'; }
    draw();
    if (first) afterOpen();
  }
  window.addEventListener('popstate', route);

  function draw() {
    var main = $('#main');
    document.body.classList.toggle('has-tabs', state.view === 'app');
    document.body.classList.toggle('no-tabs', state.view !== 'app');
    if (state.view !== 'app') { main.innerHTML = startHtml() + footer(); return; }
    var on = state.tab === 'kid' || state.tab === 'chart' ? 'family' : state.tab;
    var html = '<nav class="tabbar dk-tabbar noprint" aria-label="Sections"><div class="tabbar-inner">' + TABS.map(function (t) {
      var o = t[0] === on;
      return '<a class="tab' + (o ? ' on' : '') + '" href="#' + t[0] + '" data-act="tab" data-tab="' + t[0] + '"' + (o ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span>' + t[2] + '</a>';
    }).join('') + '</div></nav>';
    if (isDemo()) html += '<div class="strip noprint"><p><b>The example family.</b> Tap away - nothing here is saved. The grown-up PIN is 1234.</p><button class="btn small light" type="button" data-act="mine">Set up my kids</button></div>';
    var body = state.tab === 'jars' ? jarsHtml() : state.tab === 'goals' ? goalsHtml() : state.tab === 'share' ? shareHtml() :
      state.tab === 'kid' ? kidFormHtml() : state.tab === 'chart' ? chartHtml() : familyHtml();
    // Forms and the share page keep a reading width on a desktop.
    if (state.tab === 'goals' || state.tab === 'share' || state.tab === 'kid') body = '<div class="narrow">' + body + '</div>';
    main.innerHTML = html + body + footer();
    wire();
  }
  function footer() {
    return '<footer class="foot small muted noprint"><p>Everything stays on this phone - no account, no AI, nothing uploaded. Jars keeps the count; the real money stays with you.</p><p>Part of the <a href="../">Challenge Lab</a>.</p></footer>';
  }
  function wire() {
    if (state.tab === 'kid') wireKidForm();
    if (state.tab === 'goals') wireGoalForm();
  }

  /* ---------------- first run ---------------- */

  function heroJars() {
    return '<div class="jars-row" aria-hidden="true">' + [['spend', 0.55], ['save', 0.8], ['give', 0.35]].map(function (x) {
      return '<div class="jar-col j-' + x[0] + '"><p class="jar-name">' + C.JAR_ICON[x[0]] + ' ' + C.JAR_LABEL[x[0]] + '</p>' + C.jarSvg(x[0], x[1], { uid: 'h' + x[0], seed: x[0].length * 5 }) + '</div>';
    }).join('') + '</div>';
  }
  function startHtml() {
    var have = state.mine && state.mine.kids.length;
    return '<section class="hero">' + heroJars() +
      '<h1>Pocket money in three jars.</h1>' +
      '<p class="lede">Spend, save, give - and watch the savings grow. For kids about 5 to 12, with the pocket money you already give. Payday runs itself, and they can see how many paydays until the thing they want.</p></section>' +
      '<div class="choices">' +
      (have ? '<button class="choice primary" type="button" data-act="mine"><span class="ci" aria-hidden="true">🫙</span><span class="ct"><b>Our jars</b><span>' + esc(C.nameList(state.mine.kids.map(function (k) { return k.name; }))) + ' · on this phone</span></span><span class="chev" aria-hidden="true">›</span></button>' : '') +
      '<button class="choice' + (have ? '' : ' primary') + '" type="button" data-act="example"><span class="ci" aria-hidden="true">👀</span><span class="ct"><b>See an example family</b><span>Maya, 9, is six paydays from a LEGO set. Leo, 6, has nearly got his sticker book.</span></span><span class="chev" aria-hidden="true">›</span></button>' +
      (have ? '' : '<button class="choice" type="button" data-act="setup"><span class="ci" aria-hidden="true">🧒</span><span class="ct"><b>Set up my kids</b><span>On this phone. No account, nothing uploaded.</span></span><span class="chev" aria-hidden="true">›</span></button>') +
      '</div>' +
      '<section class="card"><h2>How it works</h2><ol class="steps">' +
      '<li><span class="sn">1</span><span><b>Set the pocket money and the split.</b> Say 50% to spend, 40% to save, 10% to give - or your own. The three always add up.</span></li>' +
      '<li><span class="sn">2</span><span><b>Payday runs itself.</b> Open Jars on or after payday and the money drops into the jars - even weeks you missed, never twice.</span></li>' +
      '<li><span class="sn">3</span><span><b>Spend, give, save for something big.</b> A goal shows “about 6 more paydays”, optional Bank of Mum &amp; Dad interest makes saving visible, and a grown-up PIN guards anything that adds money or dips into Save.</span></li>' +
      '</ol></section>' +
      '<section class="card promise"><span class="pi" aria-hidden="true">🔐</span><div><h2>Nothing about your kids leaves this phone</h2><p class="muted" style="margin:0">No account, no AI, no server. You keep the real money - coins in a drawer or your own bank - and Jars keeps the count. Grandparents get a link only if you make one.</p></div></section>';
  }

  /* ---------------- the child switcher ---------------- */

  function kidsBar(withAdd) {
    var ks = kids();
    if (!ks.length) return '';
    var k = kid();
    return '<div class="kids noprint" role="group" aria-label="Children">' + ks.map(function (x) {
      return '<button class="kidchip" type="button" data-act="kid" data-id="' + esc(x.id) + '" aria-pressed="' + (x.id === k.id) + '"><span class="avatar c-' + esc(x.colour) + '" aria-hidden="true">' + esc(x.emoji) + '</span><span>' + esc(x.name) + '</span></button>';
    }).join('') + (withAdd && !isDemo() && ks.length < C.LIMITS.kids ? '<button class="kidchip add" type="button" data-act="setup">+ Add a child</button>' : '') + '</div>';
  }

  /* ---------------- Jars (the kid's screen) ---------------- */

  function jarSub(k, j) {
    if (j === 'spend') return 'to spend';
    if (j === 'save') { var g = C.activeGoal(k); return g ? 'for ' + g.name : 'saving up'; }
    return k.cause ? 'for ' + k.cause : 'to give away';
  }
  function lastPay(k) { for (var i = k.history.length - 1; i >= 0; i--) if (k.history[i].k === 'pay') return k.history[i]; return null; }
  function paydayLine(k) {
    var t = today();
    var lp = lastPay(k);
    if (lp && lp.d === t) {
      var parts = { spend: lp.a.spend, save: lp.a.save - (lp.int || 0), give: lp.a.give };
      return '<div class="payday fresh" role="status"><span class="pi" aria-hidden="true">💰</span><div><p><b>' + esc(C.payLine({ d: lp.d, parts: parts }, cur(), LOCALE, t)) + '</b></p>' +
        (lp.int ? '<p>' + esc(C.interestLine(lp.int, cur(), LOCALE)) + ' 🏦</p>' : '') + '</div></div>';
    }
    if (!k.weekly) return '<div class="payday"><span class="pi" aria-hidden="true">📅</span><p class="muted">No pocket money set yet - a grown-up can set it in Grown-ups.</p></div>';
    var n = C.nextPayday(k, C.addDays(t, 1));
    var p = C.splitAmount(k.weekly, k.split);
    return '<div class="payday"><span class="pi" aria-hidden="true">📅</span><div><p><b>Next payday ' + esc(C.aheadLabel(n, t)) + '</b> · ' + esc(S(k.weekly)) + '</p><p class="muted small">' + esc(S(p.spend) + ' spend, ' + S(p.save) + ' save, ' + S(p.give) + ' give') + '</p></div></div>';
  }
  function jarsHtml() {
    var k = kid();
    if (!k) return emptyHtml();
    var f = C.fills(k);
    var head = kidsBar(true) +
      '<section class="kidhead c-' + esc(k.colour) + '"><span class="avatar big" aria-hidden="true">' + esc(k.emoji) + '</span><div class="kh"><h1>' + esc(poss(k.name)) + ' jars</h1><p>' + esc(M(C.total(k))) + ' in all</p></div></section>' +
      paydayLine(k) +
      '<div class="jars-row">' + C.JARS.map(function (j) {
        return '<button class="jar-col j-' + j + '" type="button" data-act="jar" data-jar="' + j + '" aria-label="' + esc(C.JAR_LABEL[j] + ' jar: ' + M(k.jars[j]) + '. Open its history.') + '"><span class="jar-name"><span aria-hidden="true">' + C.JAR_ICON[j] + '</span> ' + C.JAR_LABEL[j] + '</span>' +
          C.jarSvg(j, f[j], { uid: k.id + j, seed: k.id.charCodeAt(2) + j.length }) + '<span class="jar-amt">' + esc(S(k.jars[j])) + '</span><span class="jar-sub">' + esc(jarSub(k, j)) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="moves">' +
      '<button class="kbtn j-spend" type="button" data-act="spend"><span class="ki" aria-hidden="true">🛍️</span>Spend</button>' +
      '<button class="kbtn j-give" type="button" data-act="give"><span class="ki" aria-hidden="true">💝</span>Give</button>' +
      '<button class="kbtn" type="button" data-act="move"><span class="ki" aria-hidden="true">🔁</span>Move</button>' +
      '<button class="kbtn grown" type="button" data-act="add"><span class="ki" aria-hidden="true">➕</span>Add money <span class="lock" aria-label="needs a grown-up">🔒</span></button>' +
      '</div>';
    return '<div class="kidgrid"><div>' + head + '</div><aside class="side">' + goalCard(k) + interestCard(k) + activityCard(k) + '</aside></div>';
  }
  function emptyHtml() {
    return '<div class="card center"><p class="bigemoji" aria-hidden="true">🫙</p><p><b>No children yet.</b></p><p class="muted small">Add one - it takes a minute - and payday starts on the day you choose.</p><button class="btn" type="button" data-act="setup">Add a child</button></div>';
  }
  function goalCard(k) {
    var st = C.goalStatus(k, today());
    if (!st) return '<section class="card"><h2>🎯 What are you saving for?</h2><p class="muted">Pick something - a toy, a game, a day out - and Jars shows how many paydays it takes.</p><button class="btn" type="button" data-act="tab" data-tab="goals">Add a goal</button></section>';
    var g = st.goal;
    var extra = '';
    if (st.reached) {
      extra = '<p class="geta">You’ve got enough! 🎉</p><div class="btns"><button class="btn" type="button" data-act="buy" data-gid="' + esc(g.id) + '">Buy it <span class="lock" aria-label="needs a grown-up">🔒</span></button></div>';
    } else {
      extra = '<p class="geta">' + esc(C.etaWords(st)) + (st.date ? ' · ' + esc(C.dayLabel(st.date, today())) : '') + '</p>' +
        (k.interest.on && st.weeks && st.plainWeeks && st.plainWeeks !== st.weeks ? '<p class="small muted" style="margin:2px 0 0">Without interest it would be ' + esc(plural(st.plainWeeks, 'payday')) + '.</p>' : '');
    }
    return '<section class="card' + (st.reached ? ' reached' : '') + '"><div class="goal"><div class="ringwrap">' + C.ringSvg(st.pct, g.emoji) + '</div><div class="gb"><p class="eyebrow">Saving for</p><h2>' + esc(g.name) + '</h2>' +
      '<p class="gpct">' + esc(S(st.saved) + ' of ' + S(g.price)) + ' · ' + st.pct + '%</p>' + extra + '</div></div></section>';
  }
  function chartSvg(k) {
    var pr = C.projection(k, 12);
    var W = 340, H = 168, L = 8, R = 92, T = 14, B = 26;
    var lo = Math.min.apply(null, pr.without), hi = Math.max.apply(null, pr.with);
    if (hi === lo) hi = lo + 1;
    var x = function (i) { return L + (i * (W - L - R)) / 12; };
    var y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
    var path = function (arr) { return arr.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' '); };
    var label = 'In 12 weeks Save reaches ' + M(pr.with[12]) + ' with interest, ' + M(pr.without[12]) + ' without.';
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label) + '">' +
      '<line class="ax" x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '"/>' +
      '<path class="lo" d="' + path(pr.without) + '"/><path class="lw" d="' + path(pr.with) + '"/>' +
      '<circle class="dot" cx="' + x(12).toFixed(1) + '" cy="' + y(pr.with[12]).toFixed(1) + '" r="5"/>' +
      '<text class="tw" x="' + (x(12) + 8).toFixed(1) + '" y="' + (y(pr.with[12]) + 5).toFixed(1) + '">' + esc(S(pr.with[12])) + '</text>' +
      '<text x="' + (x(12) + 8).toFixed(1) + '" y="' + Math.max(y(pr.without[12]) + 5, y(pr.with[12]) + 22).toFixed(1) + '">' + esc(S(pr.without[12])) + '</text>' +
      '<text x="' + L + '" y="' + (H - 6) + '">now</text><text x="' + (x(6) - 16).toFixed(1) + '" y="' + (H - 6) + '">6 weeks</text><text x="' + (x(12) - 44).toFixed(1) + '" y="' + (H - 6) + '">12 weeks</text></svg>';
  }
  function interestCard(k) {
    if (!k.interest.on) return '';
    var pr = C.projection(k, 12);
    var lp = lastPay(k);
    var rate = (k.interest.bp / 100).toString().replace(/\.0+$/, '');
    return '<section class="card j-save"><h2>🏦 Bank of Mum &amp; Dad</h2><p><b>' + esc(rate) + '% a week</b> on Save, paid on payday' + (k.interest.cap ? ' (up to ' + esc(S(k.interest.cap)) + ' a week)' : '') + '.</p>' +
      (lp && lp.int ? '<p class="okbox">' + esc(C.interestLine(lp.int, cur(), LOCALE)) + '</p>' : '') +
      chartSvg(k) +
      '<p class="legend"><span><span class="lk" aria-hidden="true"></span>With interest</span><span><span class="lk dash" aria-hidden="true"></span>Without</span></p>' +
      '<p style="margin-top:8px">In 12 weeks: <b>' + esc(S(pr.with[12])) + '</b> with interest, ' + esc(S(pr.without[12])) + ' without. Interest adds <b>' + esc(S(pr.extra)) + '</b>.</p>' +
      '<p class="small muted" style="margin:0">That’s far more than a real bank pays - it’s set high on purpose so a child can see interest working. Grown-ups choose the rate.</p></section>';
  }
  function actRow(e, k) {
    var d = C.describe(e, k, cur(), LOCALE);
    var amt = d.move ? S(d.amount) : (d.amount > 0 ? '+' + S(d.amount) : '−' + S(-d.amount));
    return '<li><span class="ai" aria-hidden="true">' + esc(d.icon) + '</span><span class="ab"><span class="at">' + esc(d.title) + '</span><span class="aw">' + esc(capital(C.whenLabel(e.d, today()))) + (d.jar ? ' · ' + C.JAR_LABEL[d.jar] : '') + '</span></span><span class="aa ' + (d.move ? '' : d.amount > 0 ? 'in' : 'out') + '">' + esc(amt) + '</span></li>';
  }
  function capital(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function activityCard(k) {
    var list = k.history.slice(-8).reverse();
    if (!list.length) return '';
    return '<section class="card"><h2>What happened</h2><ul class="acts">' + list.map(function (e) { return actRow(e, k); }).join('') + '</ul></section>';
  }

  /* ---------------- sheets for the moves ---------------- */

  function jarSheet(j) {
    var k = kid(); if (!k) return;
    var hist = C.jarHistory(k, j).slice(0, 25);
    var acts = j === 'spend' ? '<button class="kbtn j-spend" type="button" data-act="spend"><span class="ki" aria-hidden="true">🛍️</span>Spend</button><button class="kbtn" type="button" data-act="move" data-from="spend" data-to="save"><span class="ki" aria-hidden="true">🐷</span>Move to Save</button>'
      : j === 'give' ? '<button class="kbtn j-give" type="button" data-act="give"><span class="ki" aria-hidden="true">💝</span>Give</button><button class="kbtn" type="button" data-act="move" data-from="give"><span class="ki" aria-hidden="true">🔁</span>Move <span class="lock">🔒</span></button>'
        : '<button class="kbtn" type="button" data-act="tab" data-tab="goals"><span class="ki" aria-hidden="true">🎯</span>Goals</button><button class="kbtn" type="button" data-act="move" data-from="save" data-to="spend"><span class="ki" aria-hidden="true">🔁</span>Move <span class="lock">🔒</span></button>';
    var about = j === 'spend' ? 'Money to spend on whatever ' + k.name + ' likes.' : j === 'save' ? 'Money being saved up' + (C.activeGoal(k) ? ' for the ' + C.activeGoal(k).name : '') + '. Taking money out needs a grown-up.' : 'Money to give away' + (k.cause ? ' - for ' + k.cause : '') + '.';
    sheet('<div class="j-' + j + '"><h2><span aria-hidden="true">' + C.JAR_ICON[j] + '</span> ' + esc(poss(k.name)) + ' ' + C.JAR_LABEL[j] + ' jar</h2>' +
      '<p class="jar-amt" style="text-align:left">' + esc(M(k.jars[j])) + '</p><p class="muted">' + esc(about) + '</p>' +
      '<div class="moves">' + acts + '</div>' +
      '<h3>History</h3>' + (hist.length ? '<ul class="acts">' + hist.map(function (e) {
        var d = C.describe(e, k, cur(), LOCALE);
        var v = e.a[j];
        return '<li><span class="ai" aria-hidden="true">' + esc(d.icon) + '</span><span class="ab"><span class="at">' + esc(d.title) + '</span><span class="aw">' + esc(capital(C.whenLabel(e.d, today()))) + '</span></span><span class="aa ' + (v > 0 ? 'in' : 'out') + '">' + esc((v > 0 ? '+' : '−') + S(Math.abs(v))) + '</span></li>';
      }).join('') + '</ul>' : '<p class="muted">Nothing yet.</p>') +
      '<p class="small"><button class="link-btn" type="button" data-act="fix" data-jar="' + j + '">Count the real coins? Correct this jar <span class="lock">🔒</span></button></p></div>');
  }
  function amountField(label, max) {
    return '<label class="field"><span>' + esc(label) + (max !== undefined ? ' <small>(' + esc(S(max)) + ' in the jar)</small>' : '') + '</span><input class="input money" name="amount" inputmode="decimal" autocomplete="off" placeholder="' + esc(C.money(0, cur(), LOCALE)) + '" required></label>';
  }
  var WHAT_CHIPS = [['🍬', 'Sweets'], ['🧸', 'A toy'], ['📚', 'A book'], ['🎮', 'A game'], ['🍦', 'A treat'], ['🎟️', 'A day out']];
  function spendSheet(jar) {
    var k = kid(); if (!k) return;
    var isGive = jar === 'give';
    if (!k.jars[jar]) { toast(poss(k.name) + ' ' + C.JAR_LABEL[jar] + ' jar is empty.', 3500); return; }
    sheet('<div class="j-' + jar + '"><h2><span aria-hidden="true">' + C.JAR_ICON[jar] + '</span> ' + (isGive ? 'Give from ' : 'Spend from ') + esc(poss(k.name)) + ' ' + C.JAR_LABEL[jar] + ' jar</h2>' +
      '<form id="mvForm">' + amountField('How much?', k.jars[jar]) +
      (isGive ? '<label class="field"><span>To whom?</span><input class="input" name="to" maxlength="40" value="' + esc(k.cause) + '" placeholder="the animal shelter"></label>'
        : '<fieldset class="field"><legend>On what?</legend><div class="chips">' + WHAT_CHIPS.map(function (c) { return '<button class="chip" type="button" data-what="' + esc(c[1]) + '" aria-pressed="false"><span aria-hidden="true">' + c[0] + '</span>' + esc(c[1]) + '</button>'; }).join('') + '</div>' +
          '<input class="input" name="what" maxlength="40" placeholder="Or type it" aria-label="What was it?"></fieldset>') +
      '<p class="err" id="mvErr" role="alert"></p><button class="btn block" type="submit">' + (isGive ? 'Give it 💝' : 'Spend it') + '</button></form></div>',
    function (root) {
      $$('[data-what]', root).forEach(function (b) {
        b.addEventListener('click', function () { $$('[data-what]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); root.querySelector('[name=what]').value = b.getAttribute('data-what'); });
      });
      $('#mvForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target;
        var amount = C.parseMoney(f.amount.value, cur());
        var opts = isGive ? { amount: amount, to: f.to.value } : { amount: amount, what: f.what.value };
        var bad = amount === null ? 'Type an amount, like ' + C.inputValue(120, cur()) + '.' : tryAct(jar, opts);
        if (bad) { $('#mvErr', root).textContent = bad; return; }
        doAct(jar, opts);
      });
    });
  }
  function moveSheet(from, to) {
    var k = kid(); if (!k) return;
    var mv = { from: from || 'spend', to: to || (from === 'save' ? 'spend' : 'save') };
    if (mv.to === mv.from) mv.to = mv.from === 'save' ? 'spend' : 'save';
    function segs(name, val) {
      return '<div class="seg" role="radiogroup" aria-label="' + (name === 'from' ? 'From' : 'To') + '">' + C.JARS.map(function (j) {
        return '<button class="segb" type="button" role="radio" data-mv="' + name + '" data-v="' + j + '" aria-checked="' + (val === j) + '"><span aria-hidden="true">' + C.JAR_ICON[j] + '</span>' + C.JAR_LABEL[j] + '<small>' + esc(S(k.jars[j])) + '</small></button>';
      }).join('') + '</div>';
    }
    function body(root) {
      var gated = C.needsGrownUp('move', mv);
      $('.body', root).innerHTML = '<h2>🔁 Move between ' + esc(poss(k.name)) + ' jars</h2><form id="mvForm"><fieldset class="field"><legend>From</legend>' + segs('from', mv.from) + '</fieldset><fieldset class="field"><legend>To</legend>' + segs('to', mv.to) + '</fieldset>' +
        amountField('How much?') + '<p class="err" id="mvErr" role="alert"></p>' +
        '<p class="small muted">' + (gated ? '🔒 Taking money out of ' + C.JAR_LABEL[mv.from] + ' needs a grown-up.' : mv.to === 'save' ? 'Moving money into Save is always allowed. Good thinking!' : 'Moving between Spend and Give is up to you.') + '</p>' +
        '<button class="btn block" type="submit">Move it' + (gated ? ' 🔒' : '') + '</button></form>';
      $$('[data-mv]', root).forEach(function (b) {
        b.addEventListener('click', function () {
          var which = b.getAttribute('data-mv'), v = b.getAttribute('data-v');
          var keepAmt = root.querySelector('[name=amount]').value;
          mv[which] = v;
          if (mv.from === mv.to) { var other = C.JARS.filter(function (j) { return j !== v; }); mv[which === 'from' ? 'to' : 'from'] = which === 'from' ? (v === 'save' ? 'spend' : 'save') : (other[0]); }
          body(root);
          root.querySelector('[name=amount]').value = keepAmt;
        });
      });
      $('#mvForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var amount = C.parseMoney(e.target.amount.value, cur());
        var opts = { from: mv.from, to: mv.to, amount: amount };
        var bad = amount === null ? 'Type an amount, like ' + C.inputValue(200, cur()) + '.' : tryAct('move', opts);
        if (bad) { $('#mvErr', root).textContent = bad; return; }
        if (C.needsGrownUp('move', opts)) grownUp('Moving money out of ' + C.JAR_LABEL[mv.from] + ' needs a grown-up.', function () { doAct('move', opts); });
        else doAct('move', opts);
      });
    }
    sheet('<div class="body"></div>', body);
  }
  function addSheet(pre) {
    var k = kid(); if (!k) return;
    var p = pre || {};
    var a = { why: p.why || 'birthday', into: p.into || 'split' };
    sheet('<h2>➕ Add money to ' + esc(poss(k.name)) + ' jars</h2><form id="addForm">' +
      '<fieldset class="field"><legend>Why?</legend><div class="chips">' + C.ADD_WHY.map(function (w) { return '<button class="chip" type="button" data-why="' + w.id + '" aria-pressed="' + (a.why === w.id) + '"><span aria-hidden="true">' + w.icon + '</span>' + esc(w.label) + '</button>'; }).join('') + '</div></fieldset>' +
      '<label class="field"><span>A note <small>(optional)</small></span><input class="input" name="note" maxlength="80" value="' + esc(p.note || '') + '" placeholder="Birthday money from Grandma"></label>' +
      amountField('How much?') +
      '<fieldset class="field"><legend>Into</legend><div class="seg" role="radiogroup" aria-label="Into">' +
      [['split', 'Split it', '']].concat(C.JARS.map(function (j) { return [j, C.JAR_ICON[j] + ' ' + C.JAR_LABEL[j], 'all of it']; })).map(function (o) {
        return '<button class="segb" type="button" role="radio" data-into="' + o[0] + '" aria-checked="' + (a.into === o[0]) + '">' + esc(o[1]) + '<small>' + esc(o[0] === 'split' ? k.split.spend + '/' + k.split.save + '/' + k.split.give : o[2]) + '</small></button>';
      }).join('') + '</div></fieldset>' +
      '<p class="preview-line" id="addPrev" aria-live="polite"></p><p class="err" id="addErr" role="alert"></p><button class="btn block" type="submit">Add it</button></form>',
    function (root) {
      var form = $('#addForm', root);
      if (p.amount) form.amount.value = C.inputValue(p.amount, cur());
      function prev() {
        var amt = C.parseMoney(form.amount.value, cur());
        var el = $('#addPrev', root);
        if (!amt) { el.textContent = ''; return; }
        if (a.into === 'split') { var s = C.splitAmount(amt, k.split); el.textContent = '→ ' + S(s.spend) + ' spend, ' + S(s.save) + ' save, ' + S(s.give) + ' give'; }
        else el.textContent = '→ all ' + S(amt) + ' to ' + C.JAR_LABEL[a.into];
      }
      $$('[data-why]', root).forEach(function (b) { b.addEventListener('click', function () { a.why = b.getAttribute('data-why'); $$('[data-why]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }); });
      $$('[data-into]', root).forEach(function (b) { b.addEventListener('click', function () { a.into = b.getAttribute('data-into'); $$('[data-into]', root).forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); prev(); }); });
      form.amount.addEventListener('input', prev);
      prev();
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var amount = C.parseMoney(form.amount.value, cur());
        var opts = { amount: amount, why: a.why, note: form.note.value, into: a.into };
        var bad = amount === null ? 'Type an amount, like ' + C.inputValue(1000, cur()) + '.' : tryAct('add', opts);
        if (bad) { $('#addErr', root).textContent = bad; return; }
        doAct('add', opts);
      });
    });
  }
  function fixSheet(j) {
    var k = kid(); if (!k) return;
    sheet('<h2>✏️ Correct ' + esc(poss(k.name)) + ' ' + C.JAR_LABEL[j] + ' jar</h2><p class="muted">Counted the real coins and they don’t match? Type what’s really there. It’s noted in the history as a correction.</p>' +
      '<form id="fixForm"><label class="field"><span>What’s really in it</span><input class="input money" name="amount" inputmode="decimal" value="' + esc(C.inputValue(k.jars[j], cur()) || '0') + '"></label><p class="err" id="fixErr" role="alert"></p><button class="btn block" type="submit">Set it</button></form>',
    function (root) {
      $('#fixForm', root).addEventListener('submit', function (e) {
        e.preventDefault();
        var v = e.target.amount.value.trim();
        var amount = v === '0' || v === '' ? 0 : C.parseMoney(v, cur());
        var opts = { jar: j, amount: amount };
        var bad = amount === null ? 'Type an amount.' : tryAct('fix', opts);
        if (bad) { $('#fixErr', root).textContent = bad; return; }
        doAct('fix', opts);
      });
    });
  }

  /* ---------------- payday, goals reached ---------------- */

  function paydaySheet(list) {
    var t = today();
    sheet('<div class="celebrate"><p class="bigemoji" aria-hidden="true">💰</p><h2>Payday!</h2></div><ul class="paid">' + list.map(function (x) {
      var k = x.kid, last = x.paid[x.paid.length - 1];
      var interest = x.paid.reduce(function (s, p) { return s + p.interest; }, 0);
      var totalIn = x.paid.reduce(function (s, p) { return s + p.total; }, 0);
      return '<li><span class="avatar c-' + esc(k.colour) + '" aria-hidden="true">' + esc(k.emoji) + '</span><div class="pb"><b>' + esc(k.name) + '</b>' +
        '<p>' + esc(C.payLine(last, cur(), LOCALE, t)) + '</p>' +
        (x.paid.length > 1 ? '<p class="small muted">' + esc('Caught up ' + plural(x.paid.length, 'payday') + ' since ' + C.dateLabel(x.paid[0].d, t) + ' - ' + S(totalIn) + ' in all.') + '</p>' : '') +
        (x.skipped ? '<p class="small muted">' + esc('Paydays from more than two years ago were not paid back.') + '</p>' : '') +
        (interest ? '<p class="earned">' + esc(C.interestLine(interest, cur(), LOCALE)) + '</p>' : '') + '</div></li>';
    }).join('') + '</ul><button class="btn block" type="button" id="yay">Yay! 🎉</button>', function (root) {
      $('#yay', root).addEventListener('click', function () { closeSheet(); nextCelebration(); });
    });
    if (!REDUCED) confetti(40);
  }
  function nextCelebration() {
    var c = state.queue.shift();
    if (!c) return;
    var k = kids().filter(function (x) { return x.id === c.kidId; })[0];
    var g = k && k.goals.filter(function (x) { return x.id === c.goalId && !x.bought; })[0];
    if (!g) return nextCelebration();
    state.kidId = k.id;
    if (state.tab === 'jars') draw();
    sheet('<div class="celebrate"><div class="ringwrap">' + C.ringSvg(100, g.emoji) + '</div><h2>🎉 ' + esc(k.name) + ' did it!</h2>' +
      '<p>There’s enough in Save for the <b>' + esc(g.name) + '</b> (' + esc(S(g.price)) + ').</p>' +
      (REDUCED ? '<p class="stars" aria-hidden="true">⭐⭐⭐</p>' : '') + '</div>' +
      '<button class="btn block" type="button" data-act="buy" data-gid="' + esc(g.id) + '">Buy it now <span class="lock" aria-label="needs a grown-up">🔒</span></button>' +
      '<button class="btn ghost block" type="button" data-act="closesheet">Keep saving for now</button>');
    confetti(110);
  }
  function confetti(n) {
    if (REDUCED) return;
    var box = $('#confetti');
    if (!box) return;
    var colours = ['#ff9b5c', '#52d17f', '#f07acb', '#ffd166', '#8f6bff', '#4cc3ff'];
    for (var i = 0; i < n; i++) {
      var p = document.createElement('i');
      p.style.left = (Math.random() * 100).toFixed(2) + 'vw';
      p.style.background = colours[i % colours.length];
      p.style.animationDelay = (Math.random() * 0.7).toFixed(2) + 's';
      p.style.animationDuration = (2.2 + Math.random() * 1.4).toFixed(2) + 's';
      p.style.transform = 'rotate(' + Math.floor(Math.random() * 360) + 'deg)';
      box.appendChild(p);
    }
    setTimeout(function () { box.innerHTML = ''; }, 4500);
  }
  function buyGoal(gid) {
    var k = kid(); if (!k) return;
    var g = k.goals.filter(function (x) { return x.id === gid; })[0];
    if (!g) return;
    var bad = tryAct('buy', { gid: gid });
    if (bad) { toast(bad, 4000); return; }
    grownUp('Buying the ' + g.name + ' takes ' + S(g.price) + ' out of Save.', function () { doAct('buy', { gid: gid }); });
  }

  /* ---------------- Goals ---------------- */

  function goalsHtml() {
    var k = kid();
    if (!k) return emptyHtml();
    var t = today();
    var open = k.goals.filter(function (g) { return !g.bought; });
    var done = k.goals.filter(function (g) { return g.bought; }).reverse();
    var active = C.activeGoal(k);
    var h = kidsBar(false) + '<div class="sec-head"><h1>🎯 ' + esc(poss(k.name)) + ' goals</h1></div>' + goalCard(k);
    var others = open.filter(function (g) { return !active || g.id !== active.id; });
    if (others.length) {
      h += '<section class="card"><h2>Up next</h2><p class="small muted">Goals share the Save jar - it fills up for the active one. Swap any time.</p><ul class="glist">' + others.map(function (g) {
        // Queued behind the active goal: Save has to cover both.
        var weeks = C.paydaysTo(k, g.price + (active ? active.price : 0), true);
        var when = active ? (weeks ? ' · about ' + plural(weeks, 'payday') + ', after the ' + active.name : '') : (weeks === 0 ? ' · enough saved already' : weeks ? ' · about ' + plural(weeks, 'payday') : '');
        return '<li class="gitem"><span class="ge" aria-hidden="true">' + esc(g.emoji) + '</span><span class="gt"><b>' + esc(g.name) + '</b><span>' + esc(S(g.price) + when) + '</span></span>' +
          '<button class="btn small ghost" type="button" data-act="setgoal" data-gid="' + esc(g.id) + '">Make it the goal</button><button class="btn small ghost" type="button" data-act="delgoal" data-gid="' + esc(g.id) + '" aria-label="' + esc('Remove ' + g.name) + '">✕</button></li>';
      }).join('') + '</ul></section>';
    }
    if (active) h += '<p class="small"><button class="link-btn danger" type="button" data-act="delgoal" data-gid="' + esc(active.id) + '">Remove “' + esc(active.name) + '”</button></p>';
    h += '<section class="card"><h2>Add a goal</h2><form id="goalForm">' +
      '<label class="field"><span>What is it?</span><input class="input" name="name" maxlength="30" placeholder="LEGO set" required></label>' +
      '<fieldset class="field"><legend>Pick a picture</legend><div class="emo" role="radiogroup" aria-label="Picture">' + C.GOAL_EMOJI.map(function (e, i) { return '<button class="segb" type="button" role="radio" data-gemoji="' + e + '" aria-checked="' + (i === 0) + '" aria-label="' + e + '">' + e + '</button>'; }).join('') + '</div></fieldset>' +
      '<label class="field"><span>How much does it cost?</span><input class="input money" name="price" inputmode="decimal" autocomplete="off" required></label>' +
      '<p class="preview-line" id="goalPrev" aria-live="polite"></p><p class="err" id="goalErr" role="alert"></p><button class="btn block" type="submit">Add the goal</button></form></section>';
    if (done.length) h += '<section class="card"><h2>Got it! 🎉</h2><ul class="glist">' + done.map(function (g) { return '<li class="gitem"><span class="ge" aria-hidden="true">' + esc(g.emoji) + '</span><span class="gt"><b>' + esc(g.name) + '</b><span>' + esc(S(g.price) + ' · bought ' + C.dateLabel(g.bought, t)) + '</span></span></li>'; }).join('') + '</ul></section>';
    return h;
  }
  function wireGoalForm() {
    var form = $('#goalForm'); if (!form) return;
    var emoji = C.GOAL_EMOJI[0];
    $$('[data-gemoji]', form).forEach(function (b) { b.addEventListener('click', function () { emoji = b.getAttribute('data-gemoji'); $$('[data-gemoji]', form).forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); }); });
    form.price.addEventListener('input', function () {
      var k = kid(); var p = C.parseMoney(form.price.value, cur());
      var w = p ? C.paydaysTo(k, p, true) : null;
      $('#goalPrev').textContent = !p ? '' : w === 0 ? 'There’s enough in Save already!' : w ? 'About ' + plural(w, 'payday') + ' of saving.' : 'Nothing goes to Save yet - a grown-up can change the split.';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var k = kid();
      var price = C.parseMoney(form.price.value, cur());
      if (!price) { $('#goalErr').textContent = 'Type the price, like ' + C.inputValue(2500, cur()) + '.'; return; }
      try {
        var nk = C.addGoal(k, { name: form.name.value, emoji: emoji, price: price }, { today: today() });
        var cr = C.checkReached(nk, today());
        if (cr.reached) { nk = cr.kid; state.queue.push({ kidId: nk.id, goalId: cr.reached.id }); }
        replaceKid(nk); save(); draw(); toast('Goal added: ' + form.name.value.trim() + '.');
        nextCelebration();
      } catch (err) { $('#goalErr').textContent = err.message; }
    });
  }

  /* ---------------- Share: the grandparents' link ---------------- */

  function shareHtml() {
    var k = kid();
    if (!k) return emptyHtml();
    var t = today();
    var snap = C.cleanSnapshot(C.packSnapshot(k, { today: t, hide: state.share.hide, currency: cur() }));
    var key = k.id + ':' + k.rev + ':' + state.share.hide + ':' + t;
    var link = state.share.forKey === key ? state.share.link : null;
    var h = kidsBar(false) + '<div class="sec-head"><h1>💌 Share with grandparents</h1></div>' +
      '<section class="card"><p>A <b>read-only snapshot</b> of ' + esc(poss(k.name)) + ' jars, goal and where the money went - for Grandma, Grandpa or anyone you’d show the jars to.</p>' +
      '<p class="small muted">It travels <b>inside the link itself</b>: nothing is stored on a server, and nothing about ' + esc(k.name) + ' leaves this phone unless you send it. It doesn’t update - send a fresh link whenever you like.</p>' +
      '<label class="toggle"><input type="checkbox" data-opt="hide"' + (state.share.hide ? ' checked' : '') + '><span>Hide the amounts<br><span class="small muted">The jars show how full they are, the goal shows %.</span></span></label>' +
      (link ? '<p class="linkbox" id="linkBox">' + esc(link) + '</p><div class="btns"><button class="btn" type="button" data-act="copylink">Copy the link</button>' + (navigator.share ? '<button class="btn ghost" type="button" data-act="sharelink">Share…</button>' : '') + '<a class="btn ghost" href="' + esc(link) + '" target="_blank" rel="noopener">Open it</a></div>'
        : '<button class="btn block" type="button" data-act="mklink">Make the link</button>') + '</section>' +
      '<h2 style="margin-top:20px">What they’ll see</h2><div class="snap">' + (snap ? C.snapshotHtml(snap, { locale: LOCALE }) : '') + '</div>' +
      '<section class="card"><h2>🎁 Got a gift note back?</h2><p class="small muted">The grandparents’ page lets them write a <b>gift note</b> - “£10 for Maya, for the LEGO”. It’s a note, never real money: no money moves through Jars. Give or receive the real money the way you always do, then paste the note here (or open their link on this phone) to add it to the jars.</p>' +
      '<form id="pasteForm"><label class="field"><span>Paste the note or its link</span><textarea class="input" name="code" rows="3" autocomplete="off" spellcheck="false"></textarea></label><p class="err" id="pasteErr" role="alert"></p><button class="btn" type="submit">Read the note</button></form></section>';
    return h;
  }
  function makeLink() {
    var k = kid(); if (!k) return;
    var t = today();
    var p = C.packSnapshot(k, { today: t, hide: state.share.hide, currency: cur() });
    C.encodeSnapshot(p).then(function (frag) {
      if (!frag) { toast('That snapshot is too big for one link.'); return; }
      state.share.link = location.origin + BASE + 'gran#' + frag;
      state.share.forKey = k.id + ':' + k.rev + ':' + state.share.hide + ':' + t;
      draw();
    }, function () { toast('This browser couldn’t make the link.'); });
  }
  function giftSheet(g) {
    var ks = kids();
    if (!ks.length) {
      sheet('<h2>💌 A gift note</h2><p>' + esc((g.from || 'Someone') + ' is sending ' + C.money(g.amount, g.currency, LOCALE) + (g.kid ? ' for ' + g.kid : '') + '.') + '</p>' + (g.message ? '<p class="note">“' + esc(g.message) + '”</p>' : '') +
        '<p class="muted">Open this on the phone that keeps the jars to add it. It’s a note, not money - nothing moves until a grown-up adds it.</p>');
      return;
    }
    var match = ks.filter(function (k) { return g.kid && k.name.toLowerCase() === g.kid.toLowerCase(); })[0] || kid() || ks[0];
    var pick = { kidId: match.id, into: g.into };
    var curWarn = g.currency !== cur() ? '<p class="warnbox">This note is in ' + esc(g.currency) + ' and the jars are in ' + esc(cur()) + '. The number is added as it is - change it below if you need to.</p>' : '';
    function body(root) {
      var k = ks.filter(function (x) { return x.id === pick.kidId; })[0];
      $('.body', root).innerHTML = '<h2>💌 A gift note' + (g.from ? ' from ' + esc(g.from) : '') + '</h2>' +
        '<p class="bigemoji" aria-hidden="true">🎁</p><p class="center"><b>' + esc(C.money(g.amount, g.currency, LOCALE)) + (g.kid ? ' for ' + esc(g.kid) : '') + '</b></p>' +
        (g.message ? '<p class="note">“' + esc(g.message) + '”</p>' : '') +
        '<p class="small muted">A note, not money - nothing has moved. Add it once the real money has been given.</p>' + curWarn +
        '<fieldset class="field"><legend>Whose jars?</legend><div class="seg" role="radiogroup" aria-label="Whose jars">' + ks.map(function (x) { return '<button class="segb" type="button" role="radio" data-gk="' + esc(x.id) + '" aria-checked="' + (x.id === pick.kidId) + '">' + esc(x.emoji) + ' ' + esc(x.name) + '</button>'; }).join('') + '</div></fieldset>' +
        '<fieldset class="field"><legend>Into</legend><div class="seg" role="radiogroup" aria-label="Into">' + C.GIFT_INTO.map(function (j) { return '<button class="segb" type="button" role="radio" data-gi="' + j + '" aria-checked="' + (pick.into === j) + '">' + (j === 'split' ? 'Split it<small>' + esc(k.split.spend + '/' + k.split.save + '/' + k.split.give) + '</small>' : C.JAR_ICON[j] + ' ' + C.JAR_LABEL[j]) + '</button>'; }).join('') + '</div></fieldset>' +
        '<p class="err" id="giftErr" role="alert"></p><button class="btn block" type="button" id="giftAdd">Add it to ' + esc(poss(k.name)) + ' jars 🔒</button><button class="btn ghost block" type="button" data-act="closesheet">Not now</button>';
      $$('[data-gk]', root).forEach(function (b) { b.addEventListener('click', function () { pick.kidId = b.getAttribute('data-gk'); body(root); }); });
      $$('[data-gi]', root).forEach(function (b) { b.addEventListener('click', function () { pick.into = b.getAttribute('data-gi'); body(root); }); });
      $('#giftAdd', root).addEventListener('click', function () {
        state.kidId = pick.kidId;
        var note = C.clean((g.from ? 'From ' + g.from : 'A gift') + (g.message ? ': ' + g.message : ''), C.LIMITS.note);
        var opts = { amount: g.amount, why: 'gift', note: note, into: pick.into };
        var bad = tryAct('add', opts);
        if (bad) { $('#giftErr', root).textContent = bad; return; }
        grownUp('Adding a gift needs a grown-up.', function () { doAct('add', opts); if (state.view === 'app') { state.tab = 'jars'; draw(); } });
      });
    }
    sheet('<div class="body"></div>', body);
  }

  /* ---------------- Grown-ups ---------------- */

  function familyHtml() {
    var ks = kids();
    var t = today();
    var held = 0, inM = 0, outM = 0;
    var sums = ks.map(function (k) { var s = C.monthSummary(k, t); held += C.total(k); inM += s.in; outM += s.out; return s; });
    var month = new Date(Date.parse(t + 'T00:00:00Z')).toLocaleString(LOCALE, { month: 'long', timeZone: 'UTC' });
    var h = '<div class="sec-head"><h1>👪 Grown-ups</h1>' + (isDemo() || ks.length >= C.LIMITS.kids ? '' : '<button class="btn small" type="button" data-act="setup">+ Add a child</button>') + '</div>' +
      '<p class="muted">You’re the bank. The real money stays with you - coins in a drawer, or your own account - and Jars keeps the count.</p>';
    if (!ks.length) return h + emptyHtml() + toolsHtml();
    h += '<div class="stats"><div class="stat"><b>' + esc(M(held)) + '</b><span>held for the kids</span></div><div class="stat"><b>' + esc(M(inM)) + '</b><span>came in during ' + esc(month) + '</span></div><div class="stat"><b>' + esc(M(outM)) + '</b><span>went out during ' + esc(month) + '</span></div></div>';
    h += '<div class="twocol">' + ks.map(function (k) {
      var st = C.goalStatus(k, t);
      var n = C.nextPayday(k, C.addDays(t, 1));
      return '<section class="card"><div class="fkid"><span class="avatar big c-' + esc(k.colour) + '" aria-hidden="true">' + esc(k.emoji) + '</span><div class="fb"><h2>' + esc(k.name) + (k.age ? ' <span class="muted small">· ' + k.age + '</span>' : '') + '</h2>' +
        '<p style="margin:0"><b>' + esc(M(C.total(k))) + '</b></p><div class="mini">' + C.JARS.map(function (j) { return '<span class="jtag j-' + j + '"><span aria-hidden="true">' + C.JAR_ICON[j] + '</span>' + C.JAR_LABEL[j] + ' ' + esc(S(k.jars[j])) + '</span>'; }).join('') + '</div>' +
        '<p class="small muted" style="margin:8px 0 0">' + esc((k.weekly ? S(k.weekly) + ' every ' + C.DAYS[k.payday] + ' · ' + k.split.spend + '/' + k.split.save + '/' + k.split.give : 'No pocket money set') + (k.interest.on ? ' · ' + (k.interest.bp / 100) + '% a week interest' : '')) + '</p>' +
        (k.weekly ? '<p class="small muted" style="margin:0">' + esc('Next payday ' + C.dayLabel(n, t)) + '</p>' : '') +
        (st ? '<p class="small" style="margin:4px 0 0">' + esc(st.goal.emoji + ' ' + st.goal.name + ': ' + st.pct + '% · ' + C.etaWords(st)) + '</p>' : '') + '</div></div>' +
        '<div class="btns"><button class="btn small" type="button" data-act="editkid" data-id="' + esc(k.id) + '">Edit 🔒</button><button class="btn small ghost" type="button" data-act="chart" data-id="' + esc(k.id) + '">🖨️ Money chart</button><button class="btn small ghost" type="button" data-act="resetkid" data-id="' + esc(k.id) + '">Reset 🔒</button>' + (isDemo() ? '' : '<button class="btn small ghost danger" type="button" data-act="delkid" data-id="' + esc(k.id) + '">Remove 🔒</button>') + '</div></section>';
    }).join('') + '</div>';
    h += '<section class="card"><h2>This ' + esc(month) + '</h2><div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">Child</th><th scope="col">Pocket money</th><th scope="col">Interest</th><th scope="col">Added</th><th scope="col">Spent</th><th scope="col">Given</th><th scope="col">Bought</th></tr></thead><tbody>' +
      ks.map(function (k, i) { var s = sums[i]; return '<tr><th scope="row">' + esc(k.name) + '</th><td>' + esc(S(s.pocket)) + '</td><td>' + esc(S(s.interest)) + '</td><td>' + esc(S(s.added)) + '</td><td>' + esc(S(s.spent)) + '</td><td>' + esc(S(s.given)) + '</td><td>' + esc(S(s.bought)) + '</td></tr>'; }).join('') +
      '</tbody></table></div><p class="small muted" style="margin:8px 0 0">Moves between jars aren’t money in or out, so they aren’t counted here.</p></section>';
    return h + toolsHtml();
  }
  function toolsHtml() {
    var demo = isDemo();
    var mode = pinMode();
    var opts = C.CURRENCIES.map(function (c) { return '<option value="' + c + '"' + (c === cur() ? ' selected' : '') + '>' + c + ' - ' + esc(C.money(C.decimals(c) ? 240 : 600, c, LOCALE)) + '</option>'; }).join('');
    return '<section class="card"><h2>Tools</h2><ul class="menu">' +
      '<li><button type="button" data-act="ics"><span class="mi" aria-hidden="true">📅</span><span>Paydays in my calendar<small>A .ics file: each child’s payday every week for six months, and goals on their expected day. No reminders are sent - your calendar does that.</small></span></button></li>' +
      '<li><button type="button" data-act="chart" data-id="all"><span class="mi" aria-hidden="true">🖨️</span><span>Money charts for the fridge<small>One page per child: the split, the next paydays and a ladder to colour in toward the goal.</small></span></button></li>' +
      '<li><button type="button" data-act="paste"><span class="mi" aria-hidden="true">💌</span><span>Paste a gift note<small>From the grandparents’ page.</small></span></button></li>' +
      '<li><button type="button" data-act="csv"><span class="mi" aria-hidden="true">📊</span><span>Export a spreadsheet (CSV)<small>Every payday, spend, gift and move.</small></span></button></li>' +
      (demo ? '' : '<li><button type="button" data-act="export"><span class="mi" aria-hidden="true">💾</span><span>Export everything (JSON)<small>To move to a new phone. The PIN stays here.</small></span></button></li>' +
        '<li><label class="mbtn"><span class="mi" aria-hidden="true">📂</span><span>Import a Jars file<small>Replaces what’s on this phone (asks a grown-up first).</small></span><input type="file" accept="application/json,.json" data-file="import" class="vh"></label></li>') +
      '</ul>' +
      '<label class="field"><span>Currency <small>(from this phone’s region, or choose)</small></span><select class="input" id="curSel"><option value="auto"' + (state.settings.curAuto ? ' selected' : '') + '>Automatic (' + esc(C.currencyFor(state.settings.region)) + ')</option>' + opts + '</select></label>' +
      '<p class="small muted" style="margin-top:-6px">Changing it changes the symbol, not the amounts - nothing is converted.</p>' +
      (demo ? '' : '<h3>🔒 Grown-up PIN</h3><p class="small muted">' + (mode === 'on' ? 'On. Asked for before anything that adds money or takes from Save.' : mode === 'off' ? 'Off - anyone can add money or take from Save.' : 'Not set yet - Jars asks the first time it’s needed.') + ' A speed bump for little fingers, not security: it lives only on this phone, as a hash.</p><div class="btns">' +
        (mode === 'on' ? '<button class="btn small ghost" type="button" data-act="pinchange">Change the PIN</button><button class="btn small ghost" type="button" data-act="pinoff">Turn it off</button>' : '<button class="btn small ghost" type="button" data-act="pinchange">Set a PIN</button>') + '</div>' +
        '<h3>Delete</h3><p class="small muted">Everything is on this phone only - deleting it here deletes it.</p><button class="btn small ghost danger" type="button" data-act="wipe">Delete everything on this phone</button>') +
      '</section>' +
      '<section class="card promise"><span class="pi" aria-hidden="true">🔐</span><div><h2>Where your family’s data lives</h2><p class="small muted" style="margin:0">On this phone, in this browser - nowhere else. Jars has no account, no AI and no server copy; first names only, by design. A grandparents’ link carries one child’s snapshot inside the link, and only when you make one. Clearing this browser’s data deletes the jars, so export a file now and then.</p></div></section>';
  }

  /* ---------------- add / edit a child ---------------- */

  function newKidForm() {
    var t = today();
    state.editId = null;
    var used = (state.mine ? state.mine.kids : []).map(function (k) { return k.colour; });
    state.form = {
      name: '', emoji: C.AVATARS[(state.mine ? state.mine.kids.length : 0) % C.AVATARS.length], colour: C.COLOUR_IDS.filter(function (c) { return used.indexOf(c) < 0; })[0] || 'berry', age: null,
      weekly: 500, payday: 6, split: C.cleanSplit(C.DEFAULT_SPLIT), cause: '',
      interest: { on: false, bp: 200, cap: 0 }, starting: { spend: 0, save: 0, give: 0 }, startNow: false, today: t,
    };
    if (isDemo() || !state.source) { ensureMine(); state.source = 'mine'; }
    state.view = 'app'; state.tab = 'kid';
    history.pushState(null, '', BASE + '#kid');
    draw(); scrollTo(0, 0);
  }
  function editKidForm(id) {
    var k = kids().filter(function (x) { return x.id === id; })[0];
    if (!k) return;
    grownUp('Changing ' + poss(k.name) + ' pocket money needs a grown-up.', function () {
      state.editId = k.id;
      state.form = { name: k.name, emoji: k.emoji, colour: k.colour, age: k.age, weekly: k.weekly, payday: k.payday, split: C.cleanSplit(k.split), cause: k.cause, interest: Object.assign({}, k.interest) };
      state.view = 'app'; state.tab = 'kid';
      history.pushState(null, '', BASE + '#kid');
      draw(); scrollTo(0, 0);
    });
  }
  function splitHtml(f) {
    var p = C.splitAmount(f.weekly, f.split);
    return '<div class="splitbar" aria-hidden="true">' + C.JARS.map(function (j) { return '<span class="j-' + j + '" style="width:' + f.split[j] + '%"></span>'; }).join('') + '</div>' +
      '<div class="split">' + C.JARS.map(function (j) {
        return '<label class="slide j-' + j + '"><span class="sl"><span><span aria-hidden="true">' + C.JAR_ICON[j] + '</span> ' + C.JAR_LABEL[j] + '</span><span class="pc" data-pc="' + j + '">' + f.split[j] + '%</span><span class="am" data-am="' + j + '">' + esc(S(p[j])) + '</span></span>' +
          '<input type="range" min="0" max="100" step="5" value="' + f.split[j] + '" data-split="' + j + '" aria-label="' + C.JAR_LABEL[j] + ' percent"></label>';
      }).join('') + '</div><p class="small muted" style="margin:6px 0 0">Always adds up to 100%. Odd pennies go to Save, so nothing goes missing.</p>';
  }
  function kidFormHtml() {
    var f = state.form;
    if (!f) { newKidForm(); return ''; }
    var editing = Boolean(state.editId);
    var isPayday = !editing && C.weekdayOf(today()) === f.payday;
    var ages = '<option value="">-</option>'; for (var a = 3; a <= 17; a++) ages += '<option value="' + a + '"' + (f.age === a ? ' selected' : '') + '>' + a + '</option>';
    var rule = C.short(100 * (f.age || 8), cur(), LOCALE);
    return '<div class="sec-head"><h1>' + (editing ? 'Edit ' + esc(f.name || 'child') : 'Add a child') + '</h1><button class="btn small ghost" type="button" data-act="formcancel">Cancel</button></div>' +
      '<form id="kidForm" class="card" novalidate>' +
      '<div class="two"><label class="field"><span>First name</span><input class="input" name="name" maxlength="20" autocomplete="off" value="' + esc(f.name) + '" required><small>First names or a nickname only - it stays on this phone, and it’s all Jars needs.</small></label>' +
      '<label class="field"><span>Age <small>(optional)</small></span><select class="input" name="age">' + ages + '</select></label></div>' +
      '<fieldset class="field"><legend>Their picture</legend><div class="emo" role="radiogroup" aria-label="Picture">' + C.AVATARS.map(function (e) { return '<button class="segb" type="button" role="radio" data-f="emoji" data-v="' + e + '" aria-checked="' + (f.emoji === e) + '" aria-label="' + e + '">' + e + '</button>'; }).join('') + '</div></fieldset>' +
      '<fieldset class="field"><legend>Their colour</legend><div class="swatches" role="radiogroup" aria-label="Colour">' + C.COLOURS.map(function (c) { return '<button class="swatch" type="button" role="radio" data-f="colour" data-v="' + c.id + '" aria-checked="' + (f.colour === c.id) + '"><span class="dot c-' + c.id + '" aria-hidden="true"></span>' + esc(c.name) + '</button>'; }).join('') + '</div></fieldset>' +
      '<h2 style="margin-top:20px">💰 Pocket money</h2>' +
      '<label class="field"><span>How much a week?</span><input class="input money" name="weekly" inputmode="decimal" autocomplete="off" value="' + esc(C.inputValue(f.weekly, cur())) + '"><small>A common rule of thumb is about ' + esc(C.short(100, cur(), LOCALE)) + ' a week for each year of age (' + esc(rule) + ' at ' + (f.age || 8) + ') - your family, your rules.</small></label>' +
      '<fieldset class="field"><legend>Payday</legend><div class="seg week" role="radiogroup" aria-label="Payday">' + [1, 2, 3, 4, 5, 6, 0].map(function (d) { return '<button class="segb" type="button" role="radio" data-f="payday" data-v="' + d + '" aria-checked="' + (f.payday === d) + '">' + C.DAYS3[d] + '</button>'; }).join('') + '</div>' +
      (editing ? '<small>Moving payday never pays twice in a week: the next one is at least a week after the last.</small>' : '') + '</fieldset>' +
      '<fieldset class="field"><legend>The split</legend>' + splitHtml(f) +
      '<div class="chips" style="margin-top:8px">' + [[50, 40, 10], [60, 30, 10], [40, 40, 20], [34, 33, 33]].map(function (s) { return '<button class="chip" type="button" data-preset="' + s.join(',') + '">' + s.join(' / ') + '</button>'; }).join('') + '</div></fieldset>' +
      '<label class="field"><span>💝 The Give jar is for <small>(optional)</small></span><input class="input" name="cause" maxlength="40" value="' + esc(f.cause) + '" placeholder="the animal shelter"></label>' +
      '<h2 style="margin-top:20px">🏦 Bank of Mum &amp; Dad</h2>' +
      '<label class="toggle"><input type="checkbox" name="intOn"' + (f.interest.on ? ' checked' : '') + '> Pay interest on Save every payday</label>' +
      (f.interest.on ? '<fieldset class="field"><legend>How much a week?</legend><div class="seg" role="radiogroup" aria-label="Rate">' + C.RATES.map(function (r) { return '<button class="segb" type="button" role="radio" data-f="bp" data-v="' + r + '" aria-checked="' + (f.interest.bp === r) + '">' + (r / 100) + '%</button>'; }).join('') + '</div>' +
        '<small>Deliberately generous - 2% a week is far more than any real bank pays - so a child can actually see it grow. It’s your money, so you choose.</small></fieldset>' +
        '<label class="field"><span>Most it pays in a week <small>(blank = no limit)</small></span><input class="input" name="cap" inputmode="decimal" value="' + esc(C.inputValue(f.interest.cap, cur())) + '"></label>' : '') +
      (editing ? '' : '<h2 style="margin-top:20px">🫙 Already has money? <small class="muted">(optional)</small></h2><div class="three">' + C.JARS.map(function (j) { return '<label class="field"><span>' + C.JAR_ICON[j] + ' ' + C.JAR_LABEL[j] + '</span><input class="input" name="st_' + j + '" inputmode="decimal" value="' + esc(C.inputValue(f.starting[j], cur())) + '"></label>'; }).join('') + '</div>' +
        (isPayday ? '<label class="toggle"><input type="checkbox" name="startNow"' + (f.startNow ? ' checked' : '') + '> Today is payday - pay this week’s now</label>' : '<p class="small muted">The first payday is ' + esc(C.dayLabel(C.nextPayday({ start: C.addDays(today(), 1), paidThrough: null, payday: f.payday }, today()), today())) + '.</p>')) +
      '<p class="err" id="kidErr" role="alert"></p><div class="btns"><button class="btn" type="submit">' + (editing ? 'Save changes' : 'Add ' + esc(f.name || 'them')) + '</button><button class="btn ghost" type="button" data-act="formcancel">Cancel</button></div></form>';
  }
  function readKidForm(form) {
    var f = state.form;
    f.name = form.name.value;
    f.age = form.age.value ? Number(form.age.value) : null;
    var w = form.weekly.value.trim() === '' ? 0 : C.parseMoney(form.weekly.value, cur());
    f.weeklyBad = w === null || w > C.LIMITS.maxWeekly;
    if (!f.weeklyBad) f.weekly = w;
    f.cause = form.cause.value;
    f.interest.on = form.intOn.checked;
    if (form.cap) { var c = form.cap.value.trim() === '' ? 0 : C.parseMoney(form.cap.value, cur()); f.capBad = c === null; if (c !== null) f.interest.cap = Math.min(c, C.LIMITS.maxWeekly); }
    if (f.starting) C.JARS.forEach(function (j) { var el = form['st_' + j]; if (!el) return; var v = el.value.trim() === '' ? 0 : C.parseMoney(el.value, cur()); f.startBad = f.startBad || v === null; if (v !== null) f.starting[j] = v; });
    if (form.startNow) f.startNow = form.startNow.checked;
  }
  function wireKidForm() {
    var form = $('#kidForm'); if (!form) return;
    var f = state.form;
    function refreshSplit() {
      var p = C.splitAmount(f.weekly, f.split);
      C.JARS.forEach(function (j) {
        var r = $('[data-split="' + j + '"]', form); if (r) r.value = f.split[j];
        var pc = $('[data-pc="' + j + '"]', form); if (pc) pc.textContent = f.split[j] + '%';
        var am = $('[data-am="' + j + '"]', form); if (am) am.textContent = S(p[j]);
        var bar = $('.splitbar .j-' + j, form); if (bar) bar.style.width = f.split[j] + '%';
      });
    }
    $$('[data-split]', form).forEach(function (r) {
      r.addEventListener('input', function () { f.split = C.rebalance(f.split, r.getAttribute('data-split'), Number(r.value), 5); refreshSplit(); });
    });
    $$('[data-preset]', form).forEach(function (b) {
      b.addEventListener('click', function () { var v = b.getAttribute('data-preset').split(',').map(Number); f.split = C.cleanSplit({ spend: v[0], save: v[1], give: v[2] }); refreshSplit(); });
    });
    form.weekly.addEventListener('input', function () { var w = C.parseMoney(form.weekly.value, cur()); if (w !== null && w <= C.LIMITS.maxWeekly) { f.weekly = w; refreshSplit(); } });
    form.intOn.addEventListener('change', function () { readKidForm(form); if (f.interest.on && !f.interest.cap) f.interest.cap = f.weekly; draw(); });
    $$('[data-f]', form).forEach(function (b) {
      b.addEventListener('click', function () {
        readKidForm(form);
        var k = b.getAttribute('data-f'), v = b.getAttribute('data-v');
        if (k === 'payday') f.payday = Number(v); else if (k === 'bp') f.interest.bp = Number(v); else f[k] = v;
        var y = window.scrollY; draw(); window.scrollTo(0, y);
      });
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      f.startBad = false;
      readKidForm(form);
      var err = $('#kidErr');
      if (!C.cleanName(f.name)) { err.textContent = 'Give them a name - a first name or a nickname is all Jars needs.'; form.name.focus(); return; }
      if (f.weeklyBad) { err.textContent = 'The pocket money doesn’t look like an amount (most is ' + M(C.LIMITS.maxWeekly) + ' a week).'; return; }
      if (f.capBad || f.startBad) { err.textContent = 'One of the amounts doesn’t look right.'; return; }
      var c = { today: today() };
      try {
        if (state.editId) {
          var old = kids().filter(function (x) { return x.id === state.editId; })[0];
          var nk = C.editKid(old, f, c);
          replaceKid(nk); state.kidId = nk.id; save();
          state.form = null; state.editId = null;
          go('family'); toast('Saved.');
        } else {
          var k = C.newKid(f, c);
          ensureMine(); state.mine.kids.push(k); state.source = 'mine'; state.kidId = k.id; persist();
          state.form = null;
          go('jars');
          toast(k.name + '’s jars are ready.');
          afterOpen();
        }
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  /* ---------------- the fridge chart ---------------- */

  function chartHtml() {
    var t = today();
    var list = state.chartKid === 'all' ? kids() : kids().filter(function (k) { return k.id === state.chartKid; });
    var h = '<div class="sec-head noprint"><h1>🖨️ Money chart</h1><div class="row"><button class="btn small" type="button" data-act="print">Print</button><button class="btn small ghost" type="button" data-act="tab" data-tab="family">Back</button></div></div>' +
      '<p class="small muted noprint">For the fridge. Payday still runs itself in Jars - the chart is something to tick and colour in.</p>';
    return h + list.map(function (k) {
      var p = C.splitAmount(k.weekly, k.split);
      var st = C.goalStatus(k, t);
      var n = C.nextPayday(k, C.addDays(t, 1));
      var rows = ''; for (var i = 0; i < 8; i++) { var d = C.addDays(n, 7 * i); rows += '<tr><td>' + esc(C.dayLabel(d, t)) + '</td><td>' + esc(S(p.spend)) + '</td><td>' + esc(S(p.save)) + '</td><td>' + esc(S(p.give)) + '</td><td><span class="tick" aria-label="tick box"></span></td></tr>'; }
      var ladder = '';
      if (st && !st.reached && st.weeks) {
        var steps = Math.min(st.weeks, 26);
        for (var j = 0; j < steps; j++) ladder += '<div class="rung' + (j === steps - 1 ? ' goal-rung' : '') + '"><span>' + esc(C.dayLabel(C.addDays(n, 7 * j), t)) + '</span><span class="re" aria-hidden="true">' + (j === steps - 1 ? esc(st.goal.emoji) : '') + '</span></div>';
      }
      return '<section class="fridge"><div class="snap-head"><span class="avatar big c-' + esc(k.colour) + '" aria-hidden="true">' + esc(k.emoji) + '</span><div><h1>' + esc(poss(k.name)) + ' Money Chart</h1><p class="muted">' + esc(k.weekly ? S(k.weekly) + ' pocket money every ' + C.DAYS[k.payday] : 'Pocket money') + '</p></div></div>' +
        '<div class="jars-row">' + C.JARS.map(function (j) { return '<div class="jar-col j-' + j + '"><p class="jar-name"><span aria-hidden="true">' + C.JAR_ICON[j] + '</span> ' + C.JAR_LABEL[j] + '</p>' + C.jarSvg(j, k.split[j] / 100, { uid: 'f' + k.id + j, seed: 3 }) + '<p class="jar-amt">' + k.split[j] + '%</p><p class="jar-sub">' + esc(S(p[j]) + ' a week') + '</p></div>'; }).join('') + '</div>' +
        (st ? '<h2 style="margin-top:16px">' + (st.reached ? '🎉 Got enough for the ' + esc(st.goal.name) + '!' : 'Saving for: ' + esc(st.goal.emoji + ' ' + st.goal.name) + ' (' + esc(S(st.goal.price)) + ')') + '</h2>' +
          (ladder ? '<p class="muted">Colour one in each payday - the last one is the ' + esc(st.goal.name) + '!</p><div class="ladder">' + ladder + '</div>' : '') : '') +
        '<h2 style="margin-top:16px">The next paydays</h2><table class="tbl"><thead><tr><th scope="col">Payday</th><th scope="col">🛍️ Spend</th><th scope="col">🐷 Save</th><th scope="col">💝 Give</th><th scope="col">Paid</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="fridge-foot">Printed ' + esc(C.dateLabel(t)) + ' from Jars. ' + esc(k.cause ? 'The Give jar is for ' + k.cause + '.' : '') + '</p></section>';
    }).join('');
  }

  /* ---------------- sheets ---------------- */

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    if (s.hidden) lastFocus = document.activeElement;
    $$('.toast').forEach(function (t) { t.remove(); });
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

  function confirmSheet(title, text, label, run) {
    sheet('<h2>' + esc(title) + '</h2><p class="muted">' + esc(text) + '</p><div class="btns"><button class="btn" type="button" id="cfGo">' + esc(label) + '</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>', function (root) {
      $('#cfGo', root).addEventListener('click', function () { closeSheet(true); run(); });
    });
  }
  function importFile(file) {
    if (!file) return;
    if (file.size > C.LIMITS.importBytes) { toast('That file is too big to be a Jars export.'); return; }
    var r = new FileReader();
    r.onload = function () {
      var res;
      try { res = C.importFamily(String(r.result), { today: today(), locale: LOCALE }); } catch (e) { toast(e.message, 4500); return; }
      if (!res.kids.length) { toast('No children in that file.'); return; }
      var go2 = function () {
        ensureMine();
        state.mine.kids = res.kids; state.settings = res.settings; state.source = 'mine'; state.kidId = res.kids[0].id;
        persist(); go('jars');
        toast('Imported ' + plural(res.kids.length, 'child', 'children') + (res.dropped ? ' (' + res.dropped + ' couldn’t be read)' : '') + '.', 4500);
        afterOpen();
      };
      var have = state.mine && state.mine.kids.length;
      if (have) grownUp('Importing replaces the jars on this phone.', function () { confirmSheet('Replace the jars on this phone?', 'The ' + plural(state.mine.kids.length, 'child', 'children') + ' here now will be replaced by the ' + plural(res.kids.length, 'child', 'children') + ' in the file.', 'Replace', go2); });
      else go2();
    };
    r.readAsText(file);
  }

  /* ---------------- one click listener ---------------- */

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (el.tagName === 'A') e.preventDefault();
    var id = el.getAttribute('data-id');
    switch (act) {
      case 'home': closeSheet(true); go('start'); break;
      case 'tab': closeSheet(true); go(el.getAttribute('data-tab')); break;
      case 'example': openDemo(); break;
      case 'mine': openMine(); break;
      case 'setup': closeSheet(true); newKidForm(); break;
      case 'formcancel': {
        var wasEdit = Boolean(state.editId);
        state.form = null; state.editId = null;
        if (kids().length) go(wasEdit ? 'family' : 'jars'); else { state.source = null; go('start'); }
        break;
      }
      case 'kid': state.kidId = id; resetShare(); save(); draw(); break;
      case 'jar': jarSheet(el.getAttribute('data-jar')); break;
      case 'spend': spendSheet('spend'); break;
      case 'give': spendSheet('give'); break;
      case 'move': moveSheet(el.getAttribute('data-from'), el.getAttribute('data-to')); break;
      case 'add': closeSheet(true); grownUp('Adding money needs a grown-up.', function () { addSheet(); }); break;
      case 'fix': { var j = el.getAttribute('data-jar'); closeSheet(true); grownUp('Correcting a jar needs a grown-up.', function () { fixSheet(j); }); break; }
      case 'buy': closeSheet(true); buyGoal(el.getAttribute('data-gid')); break;
      case 'setgoal': { var k0 = kid(); replaceKid(C.setGoal(k0, el.getAttribute('data-gid'))); var cr = C.checkReached(kid(), today()); if (cr.reached) { replaceKid(cr.kid); state.queue.push({ kidId: cr.kid.id, goalId: cr.reached.id }); } save(); draw(); nextCelebration(); break; }
      case 'delgoal': {
        var k1 = kid(), gid = el.getAttribute('data-gid');
        var g1 = k1.goals.filter(function (x) { return x.id === gid; })[0];
        if (g1) confirmSheet('Remove “' + g1.name + '”?', 'The money stays in Save - only the goal goes.', 'Remove', function () { var before = kid(); replaceKid(C.removeGoal(before, gid)); save(); draw(); toast('Goal removed.', 8000, [{ label: 'Undo', run: function () { replaceKid(before); save(); draw(); } }]); });
        break;
      }
      case 'closesheet': closeSheet(); break;
      case 'mklink': makeLink(); break;
      case 'copylink': copyText(state.share.link, 'Link copied - send it to the grandparents'); break;
      case 'sharelink': { var k2 = kid(); navigator.share({ title: (k2 ? poss(k2.name) : 'The') + ' jars', text: 'A look at ' + (k2 ? poss(k2.name) : 'the') + ' pocket-money jars - and what they’re saving for.', url: state.share.link }).catch(function () { /* cancelled */ }); break; }
      case 'paste': go('share'); setTimeout(function () { var t = $('#pasteForm textarea'); if (t) { t.scrollIntoView({ block: 'center' }); t.focus(); } }, 60); break;
      case 'editkid': editKidForm(id || (kid() && kid().id)); break;
      case 'chart': state.chartKid = id || 'all'; go('chart'); break;
      case 'print': window.print(); break;
      case 'ics': {
        var r = C.icsFor(kids(), { today: today(), currency: cur(), locale: LOCALE, now: Date.now() });
        if (!r.events) { toast('No paydays to add - set some pocket money first.'); break; }
        download('jars-paydays.ics', 'text/calendar', r.text);
        toast(plural(r.events, 'event') + ' in the file - open it to add them to your calendar.', 4500);
        break;
      }
      case 'csv': download('jars-' + today() + '.csv', 'text/csv', C.csvFor(kids(), { currency: cur() })); break;
      case 'export': if (state.mine) download('jars-family-' + today() + '.json', 'application/json', C.exportFamily({ settings: state.settings, kids: state.mine.kids })); break;
      case 'resetkid': {
        var k3 = kids().filter(function (x) { return x.id === id; })[0]; if (!k3) break;
        grownUp('Resetting ' + poss(k3.name) + ' jars needs a grown-up.', function () {
          confirmSheet('Reset ' + poss(k3.name) + ' jars?', 'Empties all three jars and clears the history. The name, pocket money, split and goals stay, and the next payday is the next one from today. Export a file first if you might want the history.', 'Reset', function () {
            var before = k3;
            var t = today();
            var nk = C.cleanKid(Object.assign({}, k3, { jars: { spend: 0, save: 0, give: 0 }, history: [], paidThrough: C.weekdayOf(t) === k3.payday ? t : k3.paidThrough, start: C.addDays(t, 1), goals: k3.goals.filter(function (g) { return !g.bought; }).map(function (g) { return Object.assign({}, g, { reached: null }); }), rev: k3.rev + 1 }), { today: t });
            replaceKid(nk); save(); draw();
            toast(poss(k3.name) + ' jars are empty.', 8000, [{ label: 'Undo', run: function () { replaceKid(before); save(); draw(); } }]);
          });
        });
        break;
      }
      case 'delkid': {
        var k4 = kids().filter(function (x) { return x.id === id; })[0]; if (!k4) break;
        grownUp('Removing ' + k4.name + ' needs a grown-up.', function () {
          confirmSheet('Remove ' + k4.name + '?', poss(k4.name) + ' jars, goals and history leave this phone. Export a file first if you might want them.', 'Remove', function () {
            var before = state.mine.kids.slice();
            state.mine.kids = state.mine.kids.filter(function (x) { return x.id !== k4.id; });
            state.kidId = state.mine.kids.length ? state.mine.kids[0].id : null;
            persist();
            if (state.mine.kids.length) draw(); else go('start');
            toast(k4.name + ' removed.', 8000, [{ label: 'Undo', run: function () { state.mine.kids = before; state.source = 'mine'; state.kidId = k4.id; persist(); go('family'); } }]);
          });
        });
        break;
      }
      case 'pinchange': grownUp('Changing the PIN needs the old one.', function () { pinSetupSheet('Choose the new PIN.', function () { draw(); }); }); break;
      case 'pinoff': grownUp('Turning the PIN off needs the PIN.', function () { state.mine.pinMode = 'off'; state.mine.pin = null; persist(); draw(); toast('PIN off.'); }); break;
      case 'wipe':
        grownUp('Deleting everything needs a grown-up.', function () {
          confirmSheet('Delete everything?', 'Removes ' + plural(kids().length, 'child', 'children') + ', every jar, goal and payday from this phone. This can’t be undone - export a file first if you might want them back.', 'Delete everything', function () {
            state.mine = null; keep(K_HOME, null); state.source = null; state.kidId = null; state.unlockedUntil = 0;
            go('start'); toast('Deleted from this phone.');
          });
        });
        break;
      default: break;
    }
  });
  document.addEventListener('submit', function (e) {
    if (e.target.id === 'pasteForm') {
      e.preventDefault();
      var g = C.readGift(e.target.code.value);
      if (!g) { $('#pasteErr').textContent = 'That doesn’t look like a Jars gift note. Paste the whole note or link.'; return; }
      e.target.code.value = '';
      giftSheet(g);
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute('data-file') === 'import') { importFile(t.files && t.files[0]); t.value = ''; return; }
    if (t.id === 'curSel') {
      if (t.value === 'auto') { state.settings.curAuto = true; state.settings.currency = C.currencyFor(state.settings.region); }
      else if (C.cleanCur(t.value)) { state.settings.curAuto = false; state.settings.currency = t.value; }
      if (isDemo()) state.demo = Object.assign(D.build(today(), cur()), { pinMode: 'demo' });
      persist(); resetShare(); draw(); return;
    }
    if (t.getAttribute && t.getAttribute('data-opt') === 'hide') { state.share.hide = t.checked; resetShare(); draw(); }
  });

  /* ---------------- a new day ---------------- */

  // "Today" is the phone's. When the date turns while the page is open (or
  // it comes back from the background on a new day), payday runs and the
  // jars redraw - and the example is rebuilt around the new today.
  function checkDay() {
    var t = today();
    if (t === state.day) return;
    state.day = t;
    if (isDemo()) { state.demo = Object.assign(D.build(t, cur()), { pinMode: 'demo' }); }
    if (state.view === 'app' && $('#sheet').hidden && state.tab !== 'kid') { draw(); afterOpen(); }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkDay(); });
  setInterval(function () { if (!document.hidden) checkDay(); }, 60000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* no offline copy, still works online */ });
  }

  /* ---------------- start ---------------- */

  state.mine = loadMine();
  state.day = today();
  route();
}());
