/* Sorted - the page. One file, no build step.
 *
 * EVERYTHING ABOUT YOUR THINGS STAYS ON THIS DEVICE: the items and piles in
 * localStorage, the photos in IndexedDB (shrunk through a canvas first,
 * which drops their EXIF, location included), the tally and the recap
 * image worked out here by SortedCore. Every storage access is wrapped in
 * try/catch, and the page works - in memory - when storage is unavailable.
 *
 * The requests this page makes: sign-in; "up for grabs" links (made signed
 * in, with only what the person ticks: a name, a note they write for
 * friends, a price from the Sell pile, a small thumbnail only when "include
 * photo" is left ticked); a friend's claim page; and the optional price
 * estimate, whose payload (the one photo, its name and condition) is shown
 * before it is sent.
 *
 * Every string a person typed, a friend sent, the server answered or a
 * model wrote is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.SortedCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var RM = matchMedia('(prefers-reduced-motion: reduce)');
  var LOCALE = navigator.language || 'en-US';
  var K_DATA = 'sorted-data-v1', K_PREFS = 'sorted-prefs-v1';

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function now() { return Date.now(); }
  function uid() {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '', a = new Uint8Array(10);
    try { crypto.getRandomValues(a); } catch (e) { for (var j = 0; j < 10; j++) a[j] = Math.floor(Math.random() * 256); }
    for (var i = 0; i < 10; i++) out += abc[a[i] % 36];
    return out;
  }
  function ctx(extra) { var o = { nowMs: now(), today: today() }; if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); return o; }

  /* ---------------- what this device keeps ---------------- */

  var prefs = recall(K_PREFS) || {};
  if (!C.isCurrency(prefs.currency)) prefs.currency = C.currencyFor(LOCALE);
  function savePrefs() { keep(K_PREFS, prefs); }
  function cur() { return prefs.currency; }
  function money(c) { return C.money(c, cur(), LOCALE); }

  function loadData() {
    var raw = recall(K_DATA) || {};
    var o = ctx();
    return {
      v: 1,
      items: (Array.isArray(raw.items) ? raw.items : []).map(function (it) { return C.cleanItem(it, o); }).filter(Boolean).slice(0, C.LIMITS.items),
      sprints: (Array.isArray(raw.sprints) ? raw.sprints : []).map(C.cleanSprint).filter(Boolean).slice(-300),
      bags: (Array.isArray(raw.bags) ? raw.bags : []).map(C.cleanBag).filter(Boolean).slice(-C.LIMITS.bags),
      active: C.isId(raw.active) ? raw.active : null,
      links: raw.links && typeof raw.links === 'object' ? raw.links : {},
    };
  }
  var data = loadData();
  var book = C.deckOf(data.items);
  var storageOk = true;
  function byCreated(a, b) { return (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1); }
  function items() { return Object.keys(book.items).map(function (k) { return book.items[k]; }).sort(byCreated); }
  function save() {
    data.items = items();
    var ok = keep(K_DATA, data);
    if (!ok && storageOk) { storageOk = false; toast('This browser isn’t keeping things right now - they’ll be gone when the page closes.', 5200); }
  }
  function putItem(it) { book.items[it.id] = it; save(); }
  function edit(id, fn) { var it = book.items[id]; if (!it) return null; var next = JSON.parse(JSON.stringify(it)); fn(next); book.items[id] = C.cleanItem(next, ctx()) || it; save(); return book.items[id]; }
  function sprintOf(id) { return data.sprints.find(function (s) { return s.id === id; }) || null; }
  function setSprint(s) { var i = data.sprints.findIndex(function (x) { return x.id === s.id; }); if (i >= 0) data.sprints[i] = s; else data.sprints.push(s); save(); }

  var state = {
    me: null, mode: 'app', view: 'home', arg: '', pile: 'sell',
    tryDeck: null, tryStart: 0, tryHistory: 0,
    askPrice: null,
    thumbs: {}, thumbsLoaded: false,
    grabs: null, grabsErr: '', making: null,
    friend: { code: '', grab: null, err: '', offline: false, busy: '' },
    recap: null,
    coach: !prefs.coachDone,
    timers: [],
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok || d.error) { var e = new Error(d.error || 'Something went wrong.'); e.status = res.status; e.data = d; throw e; }
        return d;
      });
    }, function () { var e = new Error('You’re offline - that needs the internet.'); e.status = 0; e.offline = true; throw e; });
  }
  var toastTimer = null;
  function toast(msg, ms, action) {
    $$('.toast').forEach(function (t) { t.remove(); });
    clearTimeout(toastTimer);
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status');
    var span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
    if (action) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = action.label;
      b.addEventListener('click', function () { t.remove(); action.fn(); });
      t.appendChild(b);
    }
    document.body.appendChild(t);
    toastTimer = setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function say(msg) { var l = $('#live'); if (l) { l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); } }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied.'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function download(name, type, content) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function buzz() { try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* not on this device */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function fine() { return matchMedia('(pointer: fine)').matches; }
  function clearTimers() { state.timers.forEach(function (t) { clearInterval(t); clearTimeout(t); }); state.timers = []; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Sorting stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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

  /** A row of big numbers with their words under them. */
  function statsHtml(rows) {
    return '<div class="stats">' + rows.map(function (r) { return '<div class="stat"><b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span></div>'; }).join('') + '</div>';
  }

  /* ---------------- photos: on this device only ---------------- */

  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        var r = indexedDB.open('sorted', 1);
        r.addEventListener('upgradeneeded', function () { try { r.result.createObjectStore('photos'); } catch (e) { /* exists */ } });
        r.addEventListener('success', function () { resolve(r.result); });
        r.addEventListener('error', function () { resolve(null); });
        r.addEventListener('blocked', function () { resolve(null); });
      } catch (e) { resolve(null); }
    });
    return dbP;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (resolve) {
        try {
          var tx = d.transaction('photos', mode);
          var req = fn(tx.objectStore('photos'));
          tx.addEventListener('complete', function () { resolve(req && req.result !== undefined ? req.result : null); });
          tx.addEventListener('error', function () { resolve(null); });
          tx.addEventListener('abort', function () { resolve(null); });
        } catch (e) { resolve(null); }
      });
    });
  }
  var JPEG_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
  var memPhotos = {};
  function photoGet(id) {
    if (memPhotos[id]) return Promise.resolve(memPhotos[id]);
    return idb('readonly', function (s) { return s.get(id); }).then(function (v) {
      if (v && JPEG_URL.test(v.thumb || '') && JPEG_URL.test(v.full || '')) memPhotos[id] = v;
      return memPhotos[id] || null;
    });
  }
  function photoPut(id, p) { memPhotos[id] = p; state.thumbs[id] = p.thumb; return idb('readwrite', function (s) { return s.put(p, id); }); }
  function photoDel(id) { delete memPhotos[id]; delete state.thumbs[id]; return idb('readwrite', function (s) { return s.delete(id); }); }
  /** A photo redrawn through a canvas at `max` px (which drops its EXIF,
   *  location included). */
  function redraw(img, max, q) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, s = Math.min(1, max / Math.max(w, h));
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
    var g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);
  }
  function prepPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('That isn’t a photo.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        try {
          var full = redraw(img, 1200, 0.82);
          var thumb = redraw(img, 240, 0.74);
          URL.revokeObjectURL(url);
          resolve({ full: full, thumb: thumb });
        } catch (e) { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); });
      img.src = url;
    });
  }
  function loadThumbs() {
    var want = items().filter(function (it) { return it.photo && !state.thumbs[it.id]; });
    if (!want.length) { state.thumbsLoaded = true; return Promise.resolve(false); }
    return Promise.all(want.map(function (it) { return photoGet(it.id).then(function (p) { if (p) state.thumbs[it.id] = p.thumb; }); }))
      .then(function () { state.thumbsLoaded = true; return true; });
  }
  function thumbHtml(it, cls) {
    var t = state.thumbs[it.id];
    return '<span class="' + (cls || 'thumb') + '" aria-hidden="true">' + (t ? '<img alt="" src="' + esc(t) + '">' : '<span class="emo">' + esc(it.emoji) + '</span>') + '</span>';
  }

  /* ---------------- routing ---------------- */

  var VIEWS = ['home', 'try', 'sprint', 'sort', 'piles', 'tally', 'grabs', 'recap'];
  function route() {
    var rel = location.pathname.slice(BASE.length);
    var m = /^g\/([A-Za-z0-9_-]{22})$/.exec(rel);
    if (m) { state.mode = 'friend'; state.friend.code = m[1]; $('#acct').hidden = true; drawFriend(); loadFriend(); return; }
    var h = (location.hash || '').replace(/^#/, '').split('/');
    state.view = VIEWS.indexOf(h[0]) >= 0 ? h[0] : 'home';
    state.arg = h[1] || '';
    if (state.view === 'piles' && C.DECISION_IDS.indexOf(state.arg) >= 0) state.pile = state.arg;
    if (state.view === 'sprint' && data.active) {
      var s = sprintOf(data.active);
      if (!s || s.endedAt) data.active = null;
    }
    draw();
  }
  function go(hash) {
    var target = BASE + (hash ? '#' + hash : '');
    if (location.pathname + location.hash !== target) history.pushState(null, '', target);
    route();
    scrollTo(0, 0);
  }
  window.addEventListener('popstate', route);

  function draw() {
    clearTimers();
    if (state.mode === 'friend') return drawFriend();
    var list = items();
    var tabs = $('#tabbar');
    var first = !list.length && (state.view === 'home' || state.view === 'try');
    tabs.hidden = first;
    var tabView = state.view === 'recap' ? 'sprint' : state.view === 'sprint' ? 'sort' : state.view;
    $$('[data-act="tab"]', tabs).forEach(function (b) { if (b.getAttribute('data-tab') === tabView) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var waiting = C.queue(book).length, badge = $('#sortBadge');
    badge.hidden = !waiting; badge.textContent = waiting > 99 ? '99+' : String(waiting);
    var main = $('#main');
    var html = ({ home: first ? viewFirst : viewHome, try: viewTry, sprint: viewSprint, sort: viewSort, piles: viewPiles, tally: viewTally, grabs: viewGrabs, recap: viewRecap })[state.view]();
    main.innerHTML = html;
    after();
  }
  function after() {
    var top = $('.scard.front');
    if (top) bindSwipe(top);
    var add = $('#quickName');
    if (add) {
      add.addEventListener('input', function () { var p = $('#quickEmoji'); if (p && !p.getAttribute('data-picked')) p.textContent = C.emojiFor(add.value); });
      add.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); quickAdd(); } });
    }
    $$('input[type=file][data-photos]').forEach(function (inp) {
      inp.addEventListener('change', function () { var files = Array.prototype.slice.call(inp.files || []); inp.value = ''; addPhotos(files, inp.getAttribute('data-photos')); });
    });
    var askIn = $('#askIn');
    if (askIn) askIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveAsk(askIn.value); } });
    if (state.view === 'sprint') startTick();
    if (state.view === 'grabs') { pollGrabs(); }
    if (state.view === 'tally') { var sel = $('#curSel'); if (sel) sel.addEventListener('change', function () { prefs.currency = sel.value; savePrefs(); draw(); }); }
    if (!state.thumbsLoaded) loadThumbs().then(function (changed) { if (changed) draw(); });
  }

  /* ---------------- the first run ---------------- */

  function viewFirst() {
    return '<section class="hero" aria-labelledby="heroTitle"><div class="hero-grid"><div>' +
      '<h1 id="heroTitle">Sorted</h1>' +
      '<p class="lead">Keep, sell, donate or toss - one swipe at a time.</p>' +
      '<p>Clearing a closet, the garage, a kid’s outgrown clothes and toys, or a whole home before a move? Decide fast, then actually get it out of the house - and watch the clutter go and the cash add up.</p>' +
      '<div class="row" style="margin-top:14px"><button class="btn big" type="button" data-act="try">Try it - a made-up closet</button><button class="btn big ghost" type="button" data-act="sprint">Start a 10-minute sprint</button></div>' +
      '<p class="quiet">Free, no sign-up. Everything stays on this phone.</p></div>' +
      '<div class="mock" aria-hidden="true"><div class="mcard b1"><span class="emo">👖</span></div><div class="mcard b2"><span class="emo">🧸</span></div><div class="mcard front"><span class="emo">🧥</span><span>Winter coat</span></div>' +
      '<div class="dirs"><span class="l">← Toss</span><span class="r">Keep →</span><span class="u">↑ Sell</span><span class="d">↓ Donate</span></div></div>' +
      '</div></section>' +
      '<section class="card" style="margin-top:16px" aria-labelledby="howTitle"><h2 id="howTitle">How it works</h2><ol class="steps">' +
      '<li><div><b>Pick a room, set ten minutes.</b><br><span class="muted">Closet, kitchen, kids’ room, garage - one small corner at a time beats a whole weekend you never start.</span></div></li>' +
      '<li><div><b>One swipe per thing.</b><br><span class="muted">Right to keep, left to toss, up to sell, down to donate. Not sure? It goes in the Maybe box for 30 days.</span></div></li>' +
      '<li><div><b>Get it out of the house.</b><br><span class="muted">Listing text for the sell pile, bags ticked off for the charity shop, and a link so friends can claim things before they go.</span></div></li>' +
      '</ol><div class="row" style="margin-top:12px"><button class="btn ghost" type="button" data-act="add">Or add things one at a time</button></div></section>';
  }

  /* ---------------- home ---------------- */

  function viewHome() {
    var list = items(), t = C.tally(list, data.bags, { today: today(), currency: cur(), locale: LOCALE });
    var waiting = C.queue(book).length, due = C.maybeDue(list, today()), drops = C.priceDrops(list, today());
    var st = C.streak(sprintDays(), today());
    var out = '<div class="sec-head"><h1>Your clear-out</h1><button class="btn small ghost" type="button" data-act="add">+ Add things</button></div>';
    out += '<section class="card"><p class="lab">So far</p>' + statsHtml([[t.out, 'out of the house'], [money(t.made), 'made'], [t.bagsDonated, t.bagsDonated === 1 ? 'bag donated' : 'bags donated']]) +
      '<p class="muted small">' + plural(t.sorted, 'thing') + ' sorted · ' + t.leaving + ' leaving · ' + t.kept + ' kept' + (t.waiting ? ' · ' + t.waiting + ' waiting' : '') + '</p>' +
      '<div class="row"><button class="btn big" type="button" data-act="sprint">Start a 10-minute sprint</button>' + (waiting ? '<button class="btn big ghost" type="button" data-act="tab" data-tab="sort">Sort ' + waiting + ' waiting</button>' : '') + '</div></section>';
    if (due.length) out += '<div class="nudge" style="margin-top:14px" role="status"><span class="emo" aria-hidden="true">🤔</span><div><b>' + (due.length === 1 ? 'One thing in the Maybe box is' : due.length + ' things in the Maybe box are') + ' due.</b> Haven’t needed ' + (due.length === 1 ? 'it' : 'them') + ' in 30 days? Time to let go. <button class="link-btn" type="button" data-act="pile" data-pile="maybe">Open the box</button></div></div>';
    if (drops.length) out += '<div class="drop" style="margin-top:14px"><span><b>' + (drops.length === 1 ? esc(drops[0].name) + ' has' : drops.length + ' listings have') + ' been up for over a week.</b> A 15% drop often gets things moving.</span><button class="btn small ghost" type="button" data-act="pile" data-pile="sell">See</button></div>';
    var rooms = C.roomStats(list);
    out += '<div class="grid two" style="margin-top:14px"><section class="card"><h2>The piles</h2><div class="rows">' + ['sell', 'donate', 'toss', 'maybe', 'keep'].map(C.decisionOf).map(function (d) {
      var n = list.filter(function (it) { return it.decision === d.id; }).length;
      var sub = d.id === 'sell' ? (function () { var s = C.sellSummary(list); return s.sold ? s.sold + ' sold · ' + money(s.made) : s.listed ? s.listed + ' listed' : 'Asking ' + money(s.asking); }()) : d.id === 'donate' ? plural(data.bags.length, 'bag') : d.id === 'maybe' ? (due.length ? due.length + ' due' : 'Opens in time') : d.id === 'toss' ? list.filter(function (it) { return it.decision === 'toss' && it.outAt; }).length + ' gone' : 'Staying home';
      return '<button class="irow" type="button" data-act="pile" data-pile="' + d.id + '"><span class="thumb"><span class="emo" aria-hidden="true">' + d.icon + '</span></span><span><b>' + esc(d.label) + '</b><span class="muted">' + esc(sub) + '</span></span><span class="end"><span class="pill ' + d.id + '">' + n + '</span></span></button>';
    }).join('') + '</div></section>';
    out += '<section class="card"><h2>Rooms</h2>' + (rooms.length ? '<div class="stack">' + rooms.map(roomBar).join('') + '</div>' : '<p class="muted">Rooms fill in as you sort.</p>') +
      '<div class="streak" style="margin-top:14px"><span class="emo" aria-hidden="true">' + (st.current ? '🔥' : '🌱') + '</span><span>' + streakLine(st) + '</span></div></section></div>';
    out += '<section class="card" style="margin-top:14px"><div class="row spread"><div><h2 style="margin:0">Up for grabs</h2><p class="muted small" style="margin:4px 0 0">Before the donate bag goes, let friends claim what they want - they need no account.</p></div><button class="btn ghost" type="button" data-act="tab" data-tab="grabs">Make a link</button></div></section>';
    return out;
  }
  function roomBar(r) {
    var pct = r.total ? Math.round(r.leaving / r.total * 100) : 0, kp = r.total ? Math.round((r.sorted - r.leaving) / r.total * 100) : 0;
    return '<div class="rbar"><div class="row spread"><b>' + esc(r.emoji) + ' ' + esc(r.label) + '</b><span class="small muted">' + esc(r.sorted ? r.sorted + ' sorted, ' + r.leaving + ' leaving' : r.waiting + ' waiting') + '</span></div><div class="track" aria-hidden="true"><i class="lv" style="width:' + pct + '%"></i><i class="kp" style="width:' + kp + '%"></i></div></div>';
  }
  function sprintDays() {
    var list = items();
    return data.sprints.filter(function (s) { return list.some(function (it) { return it.sprint === s.id && it.decision; }); }).map(function (s) { return s.day; });
  }
  function streakLine(st) {
    if (!st.current) return st.best ? 'Your best run was ' + plural(st.best, 'day') + ' with a sprint. Ten minutes today starts a new one.' : 'Do a sprint on a few days in a row and a streak shows here. No pressure.';
    if (st.pending) return plural(st.current, 'day') + ' in a row with a sprint - ten minutes today keeps it going.';
    return plural(st.current, 'day') + ' in a row with a sprint. Nice and steady.';
  }

  /* ---------------- the deck ---------------- */

  // Which deck the deck views use: the sample in "Try it", the real one
  // everywhere else (filtered to the running sprint during a sprint).
  function deckNow() { return state.view === 'try' ? state.tryDeck : book; }
  function setDeck(d) { if (state.view === 'try') state.tryDeck = d; else { book = d; save(); } }
  function queueNow() {
    var d = deckNow();
    if (!d) return [];
    return state.view === 'sprint' && data.active ? C.queue(d, data.active) : C.queue(d);
  }
  var DIRS = { keep: '→', toss: '←', sell: '↑', donate: '↓', maybe: 'M' };
  function cardHtml(it, top, countLabel) {
    var photo = state.thumbs[it.id];
    return '<div class="scard' + (top ? ' front' : ' next') + '"' + (top ? ' tabindex="0" role="group" aria-roledescription="card" aria-label="' + esc(it.name + '. Swipe or choose below.') + '" data-id="' + esc(it.id) + '"' : ' aria-hidden="true"') + '>' +
      (top ? '<span class="stamp keep">Keep</span><span class="stamp toss">Toss</span><span class="stamp sell">Sell</span><span class="stamp donate">Donate</span>' : '') +
      '<span class="tag pill plain">' + esc(C.roomOf(it.room).emoji + ' ' + C.roomOf(it.room).label) + '</span>' +
      (top && countLabel ? '<span class="count">' + esc(countLabel) + '</span>' : '') +
      (photo ? '<img class="photo" alt="" src="' + esc(photo) + '" draggable="false">' : '<span class="big emo" aria-hidden="true">' + esc(it.emoji) + '</span>') +
      '<span class="nm">' + esc(it.name) + '</span>' +
      ((it.note || it.cond || it.paid) ? '<span class="meta">' + esc([C.conditionLabel(it.cond), it.note, it.paid ? 'paid ' + money(it.paid) : ''].filter(Boolean).join(' · ')) + '</span>' : '') +
      (top && state.coach && state.view === 'try' ? '<span class="coach" aria-hidden="true">Drag me ↔ ↕</span>' : '') +
      '</div>';
  }
  function choicesHtml() {
    var order = ['toss', 'donate', 'maybe', 'sell', 'keep'];
    return '<div class="choices" role="group" aria-label="Decide">' + order.map(function (id) {
      var d = C.decisionOf(id);
      return '<button class="choice ' + id + '" type="button" data-act="decide" data-d="' + id + '" aria-keyshortcuts="' + (id === 'maybe' ? 'M' : d.key) + '"><span class="emo" aria-hidden="true">' + d.icon + '</span><b>' + esc(d.label) + '</b><span class="k" aria-hidden="true">' + DIRS[id] + '</span></button>';
    }).join('') + '</div>';
  }
  function deckHtml(q, countLabel, emptyHtml) {
    var top = q[0], next = q[1];
    var deck = '<div class="deck" id="deck">' + (top ? '<span class="edge l" aria-hidden="true">← Toss</span><span class="edge r" aria-hidden="true">Keep →</span>' : '') +
      (next ? cardHtml(next, false) : '') + (top ? cardHtml(top, true, countLabel) : (emptyHtml || '')) + '</div>';
    var hist = deckNow() && deckNow().history.length;
    return '<div class="deck-wrap">' + (state.view === 'sprint' ? '' : askHtml()) + deck + (top ? choicesHtml() : '') +
      '<div class="deck-foot">' + (hist ? '<button class="btn small ghost" type="button" data-act="undo" aria-keyshortcuts="U">↶ Undo</button>' : '') +
      (top && state.view !== 'try' ? '<button class="btn small ghost" type="button" data-act="item" data-id="' + esc(top.id) + '">Edit this one</button>' : '') +
      (top && fine() ? '<span class="small muted">Arrow keys to swipe · M for maybe · U to undo</span>' : '') + '</div></div>';
  }
  function askHtml() {
    if (!state.askPrice) return '';
    var it = (deckNow() || { items: {} }).items[state.askPrice];
    if (!it) { state.askPrice = null; return ''; }
    var picks = [500, 1000, 2000, 5000, 10000];
    return '<div class="price-ask" role="group" aria-label="Asking price"><span><b>Sell</b> · What would you ask for ' + esc(it.name) + '? <span class="muted small">Optional - you can change it later.</span></span>' +
      '<div class="scroller">' + picks.map(function (c) { return '<button class="chip" type="button" data-act="askprice" data-v="' + c + '">' + esc(money(c)) + '</button>'; }).join('') + '</div>' +
      '<div class="row"><label class="vh" for="askIn">Another price</label><input class="input" id="askIn" inputmode="decimal" placeholder="Another price" style="max-width:160px"><button class="btn small" type="button" data-act="asksave">Save</button><button class="btn small ghost" type="button" data-act="askskip">Skip</button></div></div>';
  }
  function saveAsk(v) {
    var id = state.askPrice; state.askPrice = null;
    var c = typeof v === 'number' ? v : C.readMoney(v);
    if (id && c !== null) {
      if (state.view === 'try') { var t = state.tryDeck.items[id]; if (t) { t.sell = Object.assign({}, t.sell || {}, { ask: c }); } }
      else edit(id, function (it) { it.sell = Object.assign({}, it.sell || {}, { ask: c }); });
      toast('Asking ' + money(c) + '.');
    }
    draw();
  }

  function decideTop(decision, viaSwipe) {
    var q = queueNow(), it = q[0];
    if (!it) return;
    var el = $('.scard.front');
    var done = function () {
      var d = deckNow();
      var o = ctx();
      setDeck(C.decide(d, it.id, decision, o));
      if (state.coach && state.view === 'try') { state.coach = false; prefs.coachDone = true; savePrefs(); }
      buzz();
      var left = queueNow().length;
      var dd = C.decisionOf(decision);
      say(it.name + ': ' + dd.label + '. ' + (left ? plural(left, 'thing') + ' left.' : 'That’s all of them.'));
      // Deciding the next card answers an open price question with "skip".
      state.askPrice = decision === 'sell' && state.view !== 'try' && !(deckNow().items[it.id].sell || {}).ask ? it.id : null;
      if (state.view !== 'try') toast(dd.icon + ' ' + it.name + ' - ' + dd.label, 3200, { label: 'Undo', fn: undoLast });
      draw();
      if (!left && state.view === 'try') finishTry();
      var t = $('.scard.front'); if (t && fine()) try { t.focus({ preventScroll: true }); } catch (e) { /* fine */ }
      else if (!left && state.view === 'sprint' && fine()) { var qn = $('#quickName'); if (qn) qn.focus(); }
    };
    if (!el || RM.matches || viaSwipe === 'done') return done();
    fly(el, decision, 0, 0, done);
  }
  function undoLast() {
    var d = deckNow();
    if (!d || !d.history.length) return;
    var r = C.undo(d);
    setDeck(r.deck);
    state.askPrice = null;
    var it = r.deck.items[r.id];
    say('Undone: ' + (it ? it.name : 'that') + ' is back on top.');
    if (state.view === 'recap' || (state.view === 'try' && state.recap)) state.recap = null;
    draw();
  }
  function fly(el, decision, dx, dy, done) {
    var stamp = el.querySelector('.stamp.' + decision);
    $$('.stamp', el).forEach(function (s) { s.style.opacity = s === stamp ? '1' : '0'; });
    el.classList.add('anim');
    var w = Math.max(innerWidth, 600), h = Math.max(innerHeight, 700);
    var t = decision === 'keep' ? 'translate(' + w + 'px,' + dy + 'px) rotate(28deg)'
      : decision === 'toss' ? 'translate(' + -w + 'px,' + dy + 'px) rotate(-28deg)'
        : decision === 'sell' ? 'translate(' + dx + 'px,' + -h + 'px) rotate(-6deg)'
          : decision === 'donate' ? 'translate(' + dx + 'px,' + h + 'px) rotate(6deg)'
            : 'scale(.4)';
    if (decision === 'maybe') el.style.opacity = '0';
    el.style.transform = t;
    var called = false;
    var fin = function () { if (called) return; called = true; done(); };
    el.addEventListener('transitionend', fin, { once: true });
    setTimeout(fin, 340);
  }
  function bindSwipe(el) {
    var start = null, last = null, prev = null, moved = false;
    var threshold = function () { return Math.min(130, Math.max(80, el.offsetWidth * 0.28)); };
    var stamps = {};
    $$('.stamp', el).forEach(function (s) { stamps[s.className.split(' ')[1]] = s; });
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button > 0) return;
      start = { x: e.clientX, y: e.clientY }; last = { x: e.clientX, y: e.clientY, t: performance.now() }; prev = last; moved = false;
      try { el.setPointerCapture(e.pointerId); } catch (x) { /* fine */ }
      el.classList.remove('anim');
    });
    el.addEventListener('pointermove', function (e) {
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
      prev = last; last = { x: e.clientX, y: e.clientY, t: performance.now() };
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (RM.matches ? 0 : dx / 16) + 'deg)';
      var hint = C.dragHint(dx, dy, threshold());
      Object.keys(stamps).forEach(function (k) { stamps[k].style.opacity = hint.decision === k ? String(Math.min(1, hint.strength * 1.15)) : '0'; });
      var coach = el.querySelector('.coach'); if (coach && moved) coach.remove();
    });
    function end(e, cancelled) {
      if (!start) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      var dt = Math.max(1, last.t - prev.t), vx = (last.x - prev.x) / dt, vy = (last.y - prev.y) / dt;
      start = null;
      var d = cancelled ? null : C.dragDecision(dx, dy, { threshold: threshold(), vx: vx, vy: vy });
      if (d) { fly(el, d, dx, dy, function () { decideTop(d, 'done'); }); return; }
      el.classList.add('anim');
      el.style.transform = '';
      Object.keys(stamps).forEach(function (k) { stamps[k].style.opacity = '0'; });
    }
    el.addEventListener('pointerup', function (e) { end(e, false); });
    el.addEventListener('pointercancel', function (e) { end(e, true); });
  }

  /* ---------------- try it ---------------- */

  function startTry() {
    state.tryDeck = C.deckOf(C.sampleCloset(ctx()));
    state.tryStart = now();
    state.recap = null;
    state.askPrice = null;
    go('try');
  }
  function finishTry() {
    var list = Object.keys(state.tryDeck.items).map(function (k) { return state.tryDeck.items[k]; });
    state.recap = { items: list, ms: now() - state.tryStart, kind: 'try' };
    draw();
    celebrate();
  }
  function viewTry() {
    if (!state.tryDeck) { state.tryDeck = C.deckOf(C.sampleCloset(ctx())); state.tryStart = now(); }
    var all = Object.keys(state.tryDeck.items).length, q = C.queue(state.tryDeck);
    var head = '<div class="sec-head"><h1>Try it</h1><span class="ribbon">Made-up example closet</span></div>';
    if (!q.length && state.recap && state.recap.kind === 'try') return head + recapHtml(state.recap.items, state.recap.ms, { kind: 'try' });
    return head + '<p class="muted">Twelve things from a pretend closet. Drag each card - or tap a button below it. Nothing here is saved.</p>' +
      deckHtml(q, (all - q.length + 1) + ' of ' + all);
  }

  /* ---------------- recap ---------------- */

  function recapHtml(list, ms, o) {
    var r = C.recap(list, ms, { currency: cur(), locale: LOCALE });
    var emo = function (id) { return list.filter(function (it) { return it.decision === id; }).map(function (it) { return it.emoji; }).join(''); };
    var piles = ['donate', 'sell', 'toss', 'maybe', 'keep'].filter(function (id) { return r.counts[id]; }).map(function (id) {
      var d = C.decisionOf(id);
      return '<div class="pile"><b>' + r.counts[id] + '</b>' + esc(d.icon + ' ' + d.label) + (id === 'sell' && r.sellCents ? ' · about ' + esc(money(r.sellCents)) : '') + '<div class="emo" aria-hidden="true">' + esc(emo(id)) + '</div></div>';
    }).join('');
    var tail;
    if (o.kind === 'try') {
      tail = '<p style="margin-top:12px">That’s the whole idea: one decision at a time, and a pile for each that actually leaves the house.</p>' +
        '<div class="row" style="justify-content:center"><button class="btn big" type="button" data-act="sprint">Start my own 10-minute sprint</button><button class="btn big ghost" type="button" data-act="try">Try again</button></div>';
    } else {
      var room = C.roomStats(items()).find(function (x) { return x.room === o.room; });
      var st = C.streak(sprintDays(), today());
      tail = (room ? '<p style="margin-top:12px">' + esc(room.line) + '</p>' : '') + '<p>' + esc(st.current ? (st.current > 1 ? '🔥 ' : '') + streakLine(st) : '') + '</p>' +
        '<div class="row" style="justify-content:center"><button class="btn big" type="button" data-act="room" data-room="' + esc(o.room) + '">Another 10 minutes here</button><button class="btn big ghost" type="button" data-act="tab" data-tab="piles">See the piles</button></div>' +
        (r.leaving ? '<p class="small" style="margin-top:10px">Next: <button class="link-btn" style="color:#ffffff" type="button" data-act="tab" data-tab="grabs">offer the donate pile to friends first</button></p>' : '');
    }
    return '<section class="recap" aria-labelledby="recapTitle"><p class="emo" style="font-size:2.6rem;margin:0" aria-hidden="true">🎉</p><h2 id="recapTitle">' + esc(plural(r.count, 'thing')) + ' in ' + esc(C.minutesWord(ms)) + '</h2>' +
      '<p class="line">' + esc(r.parts.join(', ') || 'Nothing decided this time - that’s fine.') + '</p><div class="piles">' + piles + '</div>' + tail + '</section>';
  }
  function viewRecap() {
    var s = sprintOf(state.arg);
    if (!s) return '<div class="empty card"><span class="emo" aria-hidden="true">🤷</span><p>That sprint isn’t on this device.</p><button class="btn" type="button" data-act="sprint">Start a sprint</button></div>';
    var list = items().filter(function (it) { return it.sprint === s.id; });
    return '<div class="sec-head"><h1>' + esc(C.roomOf(s.room).label) + ' sprint</h1><span class="muted small">' + esc(C.shortDay(s.day)) + '</span></div>' + recapHtml(list, C.sprintElapsed(s, now()), { kind: 'sprint', room: s.room });
  }
  function celebrate() {
    if (RM.matches) return;
    var box = document.createElement('div'); box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var cols = ['#19663f', '#9b2c1c', '#7a4f00', '#7a2f8f', '#284b8c', '#f5c75e', '#6fd3a8'];
    for (var i = 0; i < 46; i++) {
      var p = document.createElement('i');
      p.style.left = (Math.random() * 100) + '%'; p.style.background = cols[i % cols.length];
      p.style.animationDelay = (Math.random() * 0.6) + 's'; p.style.animationDuration = (1.8 + Math.random() * 1.2) + 's';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3600);
  }

  /* ---------------- sprints ---------------- */

  function viewSprint() {
    var s = data.active ? sprintOf(data.active) : null;
    if (!s) {
      var rooms = C.roomStats(items());
      return '<div class="sec-head"><h1>A 10-minute sprint</h1></div><p class="muted">Pick a room. The timer starts at once - add each thing you pick up and swipe it. Pause any time; nothing beeps.</p>' +
        '<div class="rooms">' + C.ROOMS.map(function (r) {
          var st = rooms.find(function (x) { return x.room === r.id; });
          return '<button class="room-btn" type="button" data-act="room" data-room="' + r.id + '"><span class="emo" aria-hidden="true">' + r.emoji + '</span><b>' + esc(r.label) + '</b><span class="muted">' + esc(st ? st.sorted + ' sorted, ' + st.leaving + ' leaving' : 'Not started') + '</span></button>';
        }).join('') + '</div>';
    }
    var left = C.sprintLeft(s, now()), over = left === 0, paused = Boolean(s.pausedAt);
    var mine = items().filter(function (it) { return it.sprint === s.id; });
    var decided = mine.filter(function (it) { return it.decision; });
    var q = C.queue(book, s.id);
    var pct = Math.round((1 - left / s.durationMs) * 100);
    var head = '<div class="sprintbar' + (paused ? ' paused' : '') + (over ? ' over' : '') + '" id="timer"><span class="clock" id="clock" role="timer" aria-live="off">' + (over ? 'Time!' : C.clock(left)) + '</span>' +
      '<div class="bar" aria-hidden="true"><i id="clockBar" style="width:' + pct + '%"></i></div>' +
      (over ? '' : '<button class="btn small ghost icon-btn" type="button" data-act="' + (paused ? 'resume' : 'pause') + '" aria-label="' + (paused ? 'Resume' : 'Pause') + '">' + (paused ? '▶' : '❚❚') + '</button>') + '<button class="btn small" type="button" data-act="finish">Finish</button></div>' +
      (over ? '<div class="nudge" role="status"><span class="emo" aria-hidden="true">⏱️</span><div><b>That’s ten minutes.</b> Finish the one in your hand, then see what you did. <div class="row" style="margin-top:8px"><button class="btn small" type="button" data-act="finish">See my recap</button><button class="btn small ghost" type="button" data-act="extend">5 more minutes</button></div></div></div>' : '') +
      (paused ? '<p class="small muted center" style="margin:0" role="status">Paused - the clock waits for you.</p>' : '');
    var addBar = '<section class="addbar" aria-label="Add the next thing"><div class="row" style="flex-wrap:nowrap;gap:8px"><button class="addemo emo" id="quickEmoji" type="button" data-act="emoji" aria-label="Choose a picture">📦</button>' +
      '<label class="vh" for="quickName">What is it?</label><input class="input" id="quickName" autocomplete="off" enterkeyhint="done" maxlength="' + C.LIMITS.name + '" placeholder="What’s next? A coat, a mug…">' +
      '<label class="btn small ghost icon-btn" title="Add photos" style="flex:none"><span aria-hidden="true">📷</span><span class="vh">Add photos</span><input type="file" accept="image/*" multiple data-photos="sprint" hidden></label>' +
      '<button class="btn small" type="button" data-act="quickadd">Add</button></div><p class="tiny muted" style="margin:6px 0 0">Photos are shrunk on this phone and their location is removed. They stay here.</p></section>';
    var counts = plural(decided.length, 'thing') + ' sorted · ' + decided.filter(C.leaving).length + ' leaving';
    var empty = '<div class="addcard" aria-hidden="true"><span class="preview emo">' + (decided.length ? '✨' : '👋') + '</span><p class="center"><b>' + (decided.length ? 'Sorted! What’s next?' : 'Pick something up.') + '</b><br><span class="muted">Type its name above - or snap a few photos - and it lands here to swipe.</span></p></div>';
    return '<div class="sec-head"><div><h1 style="margin:0">' + esc(C.roomOf(s.room).emoji + ' ' + C.roomOf(s.room).label) + ' sprint</h1><p class="small muted" style="margin:2px 0 0" id="sprintCount">' + esc(counts) + '</p></div>' + (decided.length ? '<span class="recent">' + decided.slice(-8).map(function (it) { return '<span class="pill ' + it.decision + '">' + esc(it.emoji) + '<span class="vh"> ' + esc(it.name + ': ' + C.decisionOf(it.decision).label) + '</span></span>'; }).join('') + '</span>' : '') + '</div>' +
      '<div class="stack sprint">' + head + (state.askPrice ? askHtml() : addBar) + '<div class="sprint-grid">' + deckHtml(q, q.length > 1 ? q.length + ' to sort' : '', empty) +
      (decided.length ? '<aside class="card" aria-labelledby="soFar"><h2 id="soFar">This sprint so far</h2><div class="rows">' + decided.slice().reverse().map(function (it) { var d = C.decisionOf(it.decision); return '<button class="irow" type="button" data-act="item" data-id="' + esc(it.id) + '">' + thumbHtml(it) + '<span><b>' + esc(it.name) + '</b></span><span class="end"><span class="pill ' + it.decision + '">' + esc(d.icon + ' ' + d.label) + '</span></span></button>'; }).join('') + '</div></aside>' : '') + '</div></div>';
  }
  function startSprint(room) {
    var o = ctx({ id: uid() });
    var s = C.newSprint(room, o);
    data.active = s.id; prefs.room = s.room; savePrefs();
    setSprint(s);
    say('Ten minutes, starting now.');
    go('sprint');
    if (fine()) { var qn = $('#quickName'); if (qn) qn.focus(); }
  }
  function startTick() {
    var s = data.active ? sprintOf(data.active) : null;
    if (!s || s.endedAt) return;
    var wasOver = C.sprintLeft(s, now()) === 0;
    var t = setInterval(function () {
      var cs = sprintOf(data.active);
      if (!cs) return;
      var left = C.sprintLeft(cs, now());
      var c = $('#clock'), bar = $('#clockBar');
      if (c) c.textContent = left ? C.clock(left) : 'Time!';
      if (bar) bar.style.width = Math.round((1 - left / cs.durationMs) * 100) + '%';
      if (!left && !wasOver) { wasOver = true; say('That’s ten minutes. Finish the one in your hand.'); var y = scrollY; draw(); scrollTo(0, y); }
    }, 1000);
    state.timers.push(t);
  }
  function quickAdd() {
    var inp = $('#quickName'); if (!inp) return;
    var name = C.line(inp.value, C.LIMITS.name);
    if (!name) { inp.focus(); toast('Type what it is first - or snap a photo.'); return; }
    var pickEl = $('#quickEmoji'), picked = pickEl && pickEl.getAttribute('data-picked');
    var s = sprintOf(data.active);
    var it = C.newItem({ name: name, emoji: picked || null, room: s ? s.room : (prefs.room || 'other') }, ctx({ id: uid(), sprint: s ? s.id : null }));
    if (!it) return;
    if (items().length >= C.LIMITS.items) { toast('This device holds ' + C.LIMITS.items + ' things. Clear some old ones first.'); return; }
    putItem(it);
    inp.value = '';
    say('Added ' + it.name + '. Swipe it.');
    draw();
    var t = $('.scard.front'); if (t && fine()) try { t.focus({ preventScroll: true }); } catch (e) { /* fine */ }
    if (!fine() && document.activeElement) try { document.activeElement.blur(); } catch (e) { /* fine */ }
  }
  /** One item per photo, one at a time - a phone decoding a dozen photos at
   *  once runs out of memory, and one bad file must not stop the rest. */
  function addPhotos(files, where, fromSheet) {
    files = files.filter(function (f) { return /^image\//.test(f.type || ''); }).slice(0, 24);
    if (!files.length) return;
    var s = where === 'sprint' ? sprintOf(data.active) : null;
    var room = s ? s.room : (state.addRoom || prefs.room || 'other');
    var nameIn = $('#quickName') || $('#addName');
    var typed = nameIn ? C.line(nameIn.value, C.LIMITS.name) : '';
    var n = 0, failed = 0;
    var next = function () {
      if (!files.length) {
        if (nameIn) nameIn.value = '';
        toast(failed ? plural(n, 'photo') + ' added, ' + failed + ' could not be read.' : plural(n, 'thing') + ' added from photos.' + (n > 1 || !typed ? ' Name them any time.' : ''));
        if (fromSheet) fromSheet(); else draw();
        return;
      }
      var f = files.shift();
      toast('Adding ' + (n + failed + 1) + '…', 8000);
      prepPhoto(f).then(function (p) {
        var name = (typed && n === 0) ? typed : 'Something from the ' + C.roomOf(room).label.toLowerCase();
        var it = C.newItem({ name: name, room: room, photo: true }, ctx({ id: uid(), sprint: s ? s.id : null }));
        return photoPut(it.id, p).then(function () { putItem(it); n++; });
      }).catch(function () { failed++; }).then(next);
    };
    next();
  }

  /* ---------------- sort (everything waiting) ---------------- */

  function viewSort() {
    var q = C.queue(book);
    var empty = '<div class="addcard"><span class="preview emo" aria-hidden="true">✨</span><p class="center"><b>Nothing waiting.</b><br><span class="muted">Add a few things, or start a sprint in one room.</span></p><div class="row" style="justify-content:center"><button class="btn" type="button" data-act="sprint">Start a sprint</button><button class="btn ghost" type="button" data-act="add">Add things</button></div></div>';
    return '<div class="sec-head"><h1>Sort</h1><button class="btn small ghost" type="button" data-act="add">+ Add things</button></div>' +
      (q.length ? '<p class="muted">' + plural(q.length, 'thing') + ' waiting. Right to keep, left to toss, up to sell, down to donate.</p>' : '') +
      deckHtml(q, q.length + ' left', empty);
  }

  /* ---------------- add things ---------------- */

  function openAdd() {
    state.addRoom = prefs.room || 'closet';
    var picked = null, added = 0;
    function body(root) {
      $('.body', root).innerHTML = '<h2>Add things</h2><p class="muted small">Quick is fine: a name is enough. Add as many as you like, then sort them.</p>' +
        '<p class="lab" style="margin-top:12px">Room</p><div class="seg" role="group" aria-label="Room">' + C.ROOMS.map(function (r) { return '<button type="button" data-room="' + r.id + '" aria-pressed="' + (state.addRoom === r.id) + '">' + r.emoji + ' ' + esc(r.label) + '</button>'; }).join('') + '</div>' +
        '<div class="row" style="flex-wrap:nowrap;margin-top:12px"><button class="emo" type="button" id="addEmoji" aria-label="Choose a picture" style="min-width:56px;min-height:56px;border-radius:14px;border:2px solid var(--line);background:var(--card);font-size:32px;cursor:pointer">📦</button>' +
        '<label class="field" style="flex:1;margin:0"><span class="vh">What is it?</span><input class="input" id="addName" autocomplete="off" enterkeyhint="done" maxlength="' + C.LIMITS.name + '" placeholder="What is it? A lamp, a coat…"></label></div>' +
        '<details style="margin-top:10px"><summary class="link-btn" style="display:inline-flex;align-items:center">More: what you paid, condition, a note</summary>' +
        '<label class="field"><span>What you paid <span class="hint">(optional)</span></span><span class="money-in"><input class="input" id="addPaid" inputmode="decimal" placeholder="' + esc(money(2500)) + '"></span></label>' +
        '<label class="field"><span>Condition</span><select class="input" id="addCond"><option value="">Not sure</option>' + C.CONDITIONS.map(function (c) { return '<option value="' + c.id + '">' + esc(c.label) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>A note <span class="hint">(for you - friends never see it)</span></span><textarea class="input" id="addNote" maxlength="' + C.LIMITS.note + '"></textarea></label></details>' +
        '<div id="addErr"></div><div class="row" style="margin-top:12px"><button class="btn" type="button" id="addGo">Add</button>' +
        '<label class="btn ghost"><span aria-hidden="true">📷</span> Photos<input type="file" accept="image/*" multiple id="addPhotos" hidden></label>' +
        '<button class="btn ghost" type="button" id="addDone">' + (added ? 'Sort them now (' + C.queue(book).length + ')' : 'Done') + '</button></div>' +
        '<p class="tiny muted" style="margin-top:8px">Photos are shrunk on this phone and their location is removed. They stay on this device.</p>';
      var nm = $('#addName', root), em = $('#addEmoji', root);
      if (picked) em.textContent = picked;
      nm.addEventListener('input', function () { if (!picked) em.textContent = C.emojiFor(nm.value); });
      nm.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go1(); } });
      em.addEventListener('click', function () { pickEmoji(picked || C.emojiFor(nm.value), function (e) { picked = e; em.textContent = e; }); });
      $$('[data-room]', root).forEach(function (b) { b.addEventListener('click', function () { state.addRoom = b.getAttribute('data-room'); prefs.room = state.addRoom; savePrefs(); $$('[data-room]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }); });
      $('#addGo', root).addEventListener('click', go1);
      $('#addDone', root).addEventListener('click', function () { closeSheet(); if (added) go('sort'); else draw(); });
      var ph = $('#addPhotos', root);
      ph.addEventListener('change', function () { var files = Array.prototype.slice.call(ph.files || []); ph.value = ''; addPhotos(files, 'add', function () { added++; body(root); }); });
      setTimeout(function () { try { nm.focus(); } catch (e) { /* fine */ } }, 60);
    }
    function go1() {
      var root = $('#sheet');
      var name = C.line($('#addName', root).value, C.LIMITS.name);
      if (!name) { $('#addErr', root).innerHTML = '<p class="err" role="alert">Give it a name - a word or two is plenty.</p>'; return; }
      if (items().length >= C.LIMITS.items) { $('#addErr', root).innerHTML = '<p class="err" role="alert">This device holds ' + C.LIMITS.items + ' things. Clear some old ones first.</p>'; return; }
      var it = C.newItem({ name: name, emoji: picked, room: state.addRoom, paid: $('#addPaid', root) ? $('#addPaid', root).value : null, cond: $('#addCond', root) ? $('#addCond', root).value : '', note: $('#addNote', root) ? $('#addNote', root).value : '' }, ctx({ id: uid() }));
      putItem(it);
      added++; picked = null;
      toast('Added ' + it.name + '.');
      say('Added ' + it.name + '.');
      body(root);
    }
    sheet('<div class="body"></div>', body);
  }
  function pickEmoji(current, then) {
    var panel = document.createElement('div');
    panel.className = 'card';
    panel.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:75;width:min(560px,94vw);max-height:80vh;overflow:auto';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', 'Choose a picture');
    panel.innerHTML = '<div class="row spread"><h2 style="margin:0">Choose a picture</h2><button class="btn small ghost" type="button" id="emoClose">Close</button></div><div class="emoji-grid" style="margin-top:10px">' +
      C.EMOJI.map(function (e) { return '<button type="button" data-e="' + esc(e[0]) + '" aria-pressed="' + (e[0] === current) + '" aria-label="' + esc(e[1]) + '" title="' + esc(e[1]) + '"><span class="emo">' + esc(e[0]) + '</span></button>'; }).join('') + '</div>';
    var back = document.createElement('div'); back.className = 'sheet-back'; back.style.zIndex = '74';
    document.body.appendChild(back); document.body.appendChild(panel);
    var close = function () { panel.remove(); back.remove(); };
    back.addEventListener('click', close);
    $('#emoClose', panel).addEventListener('click', close);
    $$('[data-e]', panel).forEach(function (b) { b.addEventListener('click', function () { then(b.getAttribute('data-e')); close(); }); });
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    var cur0 = $('[aria-pressed="true"]', panel) || $('[data-e]', panel); try { cur0.focus(); } catch (e) { /* fine */ }
  }

  /* ---------------- one item ---------------- */

  function openItem(id) {
    var it = book.items[id];
    if (!it) return;
    var picked = it.emoji, decision = it.decision;
    sheet('<div class="body"></div>', function (root) {
      var b = $('.body', root);
      b.innerHTML = '<div id="itemPhoto"></div><h2>' + esc(it.name) + '</h2>' +
        '<div class="row" style="flex-wrap:nowrap"><button class="emo" type="button" id="itEmoji" aria-label="Choose a picture" style="min-width:56px;min-height:56px;border-radius:14px;border:2px solid var(--line);background:var(--card);font-size:32px;cursor:pointer">' + esc(picked) + '</button>' +
        '<label class="field" style="flex:1;margin:0"><span class="vh">Name</span><input class="input" id="itName" maxlength="' + C.LIMITS.name + '" value="' + esc(it.name) + '"></label></div>' +
        '<p class="lab" style="margin-top:12px">Decision</p><div class="seg" role="group" aria-label="Decision">' + C.DECISIONS.map(function (d) { return '<button type="button" data-dec="' + d.id + '" aria-pressed="' + (decision === d.id) + '">' + d.icon + ' ' + esc(d.label) + '</button>'; }).join('') + '<button type="button" data-dec="" aria-pressed="' + (!decision) + '">Not yet</button></div>' +
        '<label class="field"><span>Room</span><select class="input" id="itRoom">' + C.ROOMS.map(function (r) { return '<option value="' + r.id + '"' + (r.id === it.room ? ' selected' : '') + '>' + esc(r.label) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Condition</span><select class="input" id="itCond"><option value="">Not sure</option>' + C.CONDITIONS.map(function (c) { return '<option value="' + c.id + '"' + (c.id === it.cond ? ' selected' : '') + '>' + esc(c.label) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>What you paid <span class="hint">(optional)</span></span><input class="input" id="itPaid" inputmode="decimal" value="' + esc(it.paid ? (it.paid / 100).toFixed(it.paid % 100 ? 2 : 0) : '') + '"></label>' +
        '<label class="field"><span>A note <span class="hint">(for you - friends never see it)</span></span><textarea class="input" id="itNote" maxlength="' + C.LIMITS.note + '">' + esc(it.note) + '</textarea></label>' +
        '<div class="row" style="margin-top:4px"><button class="btn small ghost ai" type="button" data-act="estimate" data-id="' + esc(it.id) + '"> What could this sell for?</button></div>' +
        '<label class="btn small ghost" style="margin-top:8px"><span aria-hidden="true">📷</span> ' + (it.photo ? 'Change the photo' : 'Add a photo') + '<input type="file" accept="image/*" id="itPhoto" hidden></label> ' +
        (it.photo ? '<button class="btn small ghost" type="button" id="itNoPhoto">Remove the photo</button>' : '') +
        '<div id="itErr"></div><div class="row" style="margin-top:14px"><button class="btn" type="button" id="itSave">Save</button><button class="btn ghost" type="button" id="itDel">Delete it</button></div>';
      if (it.photo) photoGet(it.id).then(function (p) { var box = $('#itemPhoto', root); if (p && box) box.innerHTML = '<img class="sheet-photo" alt="" src="' + esc(p.full) + '">'; });
      $('#itEmoji', root).addEventListener('click', function () { pickEmoji(picked, function (e) { picked = e; $('#itEmoji', root).textContent = e; }); });
      $$('[data-dec]', root).forEach(function (x) { x.addEventListener('click', function () { decision = x.getAttribute('data-dec') || null; $$('[data-dec]', root).forEach(function (y) { y.setAttribute('aria-pressed', String(y === x)); }); }); });
      $('#itSave', root).addEventListener('click', function () {
        var name = C.line($('#itName', root).value, C.LIMITS.name);
        if (!name) { $('#itErr', root).innerHTML = '<p class="err" role="alert">It needs a name.</p>'; return; }
        var o = ctx();
        if (decision !== it.decision) {
          if (decision) book = C.decide(book, it.id, decision, o);
          else { book.items[it.id] = Object.assign({}, book.items[it.id], { decision: null, decidedAt: null, decidedDay: null, outAt: null, outDay: null }); }
        }
        edit(it.id, function (x) { x.name = name; x.emoji = picked; x.room = $('#itRoom', root).value; x.cond = $('#itCond', root).value; x.paid = C.readMoney($('#itPaid', root).value); x.note = $('#itNote', root).value; });
        closeSheet(); draw(); toast('Saved.');
      });
      $('#itDel', root).addEventListener('click', function () {
        if (!confirm('Delete ' + it.name + ' from this device?')) return;
        delete book.items[it.id]; save(); if (it.photo) photoDel(it.id);
        closeSheet(); draw(); toast('Deleted.');
      });
      var ph = $('#itPhoto', root);
      ph.addEventListener('change', function () {
        var f = ph.files && ph.files[0]; ph.value = '';
        if (!f) return;
        prepPhoto(f).then(function (p) { return photoPut(it.id, p).then(function () { edit(it.id, function (x) { x.photo = true; }); closeSheet(); openItem(it.id); draw(); }); }).catch(function (e) { showError(e, $('#itErr', root)); });
      });
      var np = $('#itNoPhoto', root);
      if (np) np.addEventListener('click', function () { photoDel(it.id); edit(it.id, function (x) { x.photo = false; }); closeSheet(); openItem(it.id); draw(); });
    });
  }

  /* ---------------- the piles ---------------- */

  function viewPiles() {
    var list = items();
    var tabs = '<div class="pile-tabs" role="group" aria-label="Piles">' + ['sell', 'donate', 'toss', 'maybe', 'keep'].map(function (id) {
      var d = C.decisionOf(id), n = list.filter(function (it) { return it.decision === id; }).length;
      return '<button type="button" class="' + id + '" data-act="pile" data-pile="' + id + '" aria-pressed="' + (state.pile === id) + '">' + d.icon + ' ' + esc(d.label) + ' · ' + n + '</button>';
    }).join('') + '</div>';
    var body = ({ sell: pileSell, donate: pileDonate, toss: pileToss, maybe: pileMaybe, keep: pileKeep })[state.pile](list.filter(function (it) { return it.decision === state.pile; }), list);
    return '<div class="sec-head"><h1>The piles</h1><button class="btn small ghost" type="button" data-act="add">+ Add things</button></div>' + tabs + body;
  }
  function emptyPile(id) {
    var d = C.decisionOf(id);
    return '<div class="card empty"><span class="emo" aria-hidden="true">' + d.icon + '</span><p>Nothing ' + esc(d.verb) + ' yet.</p><p class="muted small">Swipe ' + ({ keep: 'right', toss: 'left', sell: 'up', donate: 'down', maybe: '- or tap Maybe -' })[id] + ' on a card and it lands here.</p><button class="btn ghost" type="button" data-act="sprint">Start a sprint</button></div>';
  }
  function irow(it, sub, end) {
    return '<button class="irow" type="button" data-act="item" data-id="' + esc(it.id) + '">' + thumbHtml(it) + '<span><b>' + esc(it.name) + '</b><span class="muted">' + esc(sub || C.roomOf(it.room).label) + '</span></span><span class="end">' + (end || '') + '</span></button>';
  }
  function pileSell(rows, list) {
    if (!rows.length) return emptyPile('sell');
    var s = C.sellSummary(list), drops = C.priceDrops(list, today());
    var out = '<section class="card">' + statsHtml([[money(s.made), 'made'], [s.sold, 'sold'], [s.listed, 'listed'], [s.toList, 'to list']]) +
      '<p class="muted small" style="margin:10px 0 0">' + (s.asking ? 'Still asking ' + esc(money(s.asking)) + ' in all. ' : '') + '<button class="link-btn" type="button" data-act="tab" data-tab="grabs">Offer them to friends first</button>, with the price shown.</p></section>';
    if (drops.length) out += '<section class="card" style="margin-top:12px"><h2>Price drops to try</h2><p class="muted small">Listed for over a week with no sale. Taking 15% off often gets things moving.</p><div class="rows">' + drops.map(function (d) {
      return '<div class="drop"><span><b>' + esc(d.emoji + ' ' + d.name) + '</b> · ' + d.days + ' days at ' + esc(money(d.from)) + '</span><button class="btn small" type="button" data-act="dropprice" data-id="' + esc(d.id) + '">Drop to ' + esc(money(d.to)) + '</button></div>';
    }).join('') + '</div></section>';
    C.SELL_STATUS.forEach(function (st) {
      var group = rows.filter(function (it) { return (it.sell || {}).status === st.id; });
      if (!group.length) return;
      out += '<section style="margin-top:14px"><h2>' + esc(st.label) + ' · ' + group.length + '</h2><div class="rows">' + group.map(function (it) {
        var sl = it.sell || {};
        var sub = [sl.where ? C.whereLabel(sl.where) : '', st.id === 'listed' && sl.listedDay ? 'since ' + C.shortDay(sl.listedDay) : '', st.id === 'sold' && sl.soldDay ? C.shortDay(sl.soldDay) : ''].filter(Boolean).join(' · ') || C.roomOf(it.room).label;
        var price = st.id === 'sold' ? (sl.sold ? money(sl.sold) : 'Sold') : (sl.ask ? money(sl.ask) : 'No price yet');
        return '<div class="stack" style="gap:6px">' + irow(it, sub, '<span class="pill ' + (st.id === 'sold' ? 'ok' : 'sell') + '">' + esc(price) + '</span>') + '<div class="row" style="padding-left:6px">' +
          '<button class="btn small ghost" type="button" data-act="sellsheet" data-id="' + esc(it.id) + '">' + (st.id === 'to-list' ? 'Price and list it' : st.id === 'listed' ? 'Mark sold' : 'Edit') + '</button>' +
          '<button class="btn small ghost" type="button" data-act="copylisting" data-id="' + esc(it.id) + '">Copy listing</button>' +
          (st.id === 'unsold' ? '<button class="btn small" type="button" data-act="todonate" data-id="' + esc(it.id) + '">Move to Donate</button>' : '') + '</div></div>';
      }).join('') + '</div></section>';
    });
    return out;
  }
  function openSell(id) {
    var it = book.items[id]; if (!it) return;
    var sl = Object.assign({ ask: null, where: '', url: '', status: 'to-list', sold: null }, it.sell || {});
    var status = sl.status, where = sl.where;
    sheet('<div class="body"></div>', function (root) {
      var b = $('.body', root);
      var amt = function (c) { return c ? (c / 100).toFixed(c % 100 ? 2 : 0) : ''; };
      b.innerHTML = '<h2>' + esc(it.emoji + ' ' + it.name) + '</h2>' +
        '<label class="field"><span>Asking price</span><input class="input" id="slAsk" inputmode="decimal" value="' + esc(amt(sl.ask)) + '" placeholder="' + esc(money(2000)) + '" style="max-width:200px"></label>' +
        '<button class="btn small ghost ai" type="button" data-act="estimate" data-id="' + esc(it.id) + '"> What could this sell for?</button>' +
        '<p class="lab" style="margin-top:14px">Where you’ll list it</p><div class="seg" role="group" aria-label="Where">' + C.WHERE.map(function (w) { return '<button type="button" data-where="' + w.id + '" aria-pressed="' + (where === w.id) + '">' + esc(w.label) + '</button>'; }).join('') + '</div>' +
        '<label class="field"><span>Link to the listing <span class="hint">(optional, https only)</span></span><input class="input" id="slUrl" inputmode="url" value="' + esc(sl.url) + '" placeholder="https://"></label>' +
        '<p class="lab">Status</p><div class="seg" role="group" aria-label="Status">' + C.SELL_STATUS.map(function (s) { return '<button type="button" data-st="' + s.id + '" aria-pressed="' + (status === s.id) + '">' + esc(s.label) + '</button>'; }).join('') + '</div>' +
        '<label class="field" id="soldBox"' + (status === 'sold' ? '' : ' hidden') + '><span>Sold for</span><input class="input" id="slSold" inputmode="decimal" value="' + esc(amt(sl.sold || sl.ask)) + '" style="max-width:200px"></label>' +
        '<div id="slErr"></div><div class="row" style="margin-top:12px"><button class="btn" type="button" id="slSave">Save</button><button class="btn ghost" type="button" data-act="copylisting" data-id="' + esc(it.id) + '">Copy listing</button><button class="btn ghost" type="button" data-act="itemfull" data-id="' + esc(it.id) + '">Edit the item</button></div>' +
        '<p class="tiny muted" style="margin-top:8px">The listing text is made here from the name, condition, price and your note - check it before you paste it.</p>';
      $$('[data-where]', root).forEach(function (x) { x.addEventListener('click', function () { where = where === x.getAttribute('data-where') ? '' : x.getAttribute('data-where'); $$('[data-where]', root).forEach(function (y) { y.setAttribute('aria-pressed', String(y.getAttribute('data-where') === where)); }); }); });
      $$('[data-st]', root).forEach(function (x) { x.addEventListener('click', function () { status = x.getAttribute('data-st'); $$('[data-st]', root).forEach(function (y) { y.setAttribute('aria-pressed', String(y === x)); }); $('#soldBox', root).hidden = status !== 'sold'; }); });
      $('#slSave', root).addEventListener('click', function () {
        var urlRaw = $('#slUrl', root).value.trim(), url = C.cleanUrl(urlRaw);
        if (urlRaw && !url) { $('#slErr', root).innerHTML = '<p class="err" role="alert">Links must start with https:// - or leave it empty.</p>'; return; }
        var d = today();
        var toDonate = status === 'unsold' && confirm('It didn’t sell. Move it to the Donate pile?');
        edit(it.id, function (x) {
          var prev = x.sell || {};
          x.sell = Object.assign({}, prev, { ask: C.readMoney($('#slAsk', root).value), where: where, url: url, status: status });
          if (status === 'listed' && prev.status !== 'listed') x.sell.listedDay = d;
          if (status === 'sold') { x.sell.sold = C.readMoney($('#slSold', root).value); x.sell.soldDay = prev.soldDay || d; if (!x.outAt) { x.outAt = now(); x.outDay = d; } }
          else if (prev.status === 'sold') { x.sell.sold = null; x.sell.soldDay = null; x.outAt = null; x.outDay = null; }
        });
        if (toDonate) { book = C.decide(book, it.id, 'donate', ctx()); save(); }
        closeSheet(); draw();
        if (status === 'sold') { celebrate(); toast('Sold! ' + money(book.items[it.id].sell.sold || 0) + ' made.'); } else toast(toDonate ? 'Moved to Donate.' : 'Saved.');
      });
    });
  }
  function pileDonate(rows) {
    if (!rows.length) return emptyPile('donate');
    var bagRows = C.bagRows(rows, data.bags);
    var loose = rows.filter(function (it) { return !it.donate || !it.donate.bag || !data.bags.some(function (b) { return b.id === it.donate.bag; }); });
    var out = '<section class="card"><h2>Bags and boxes</h2><p class="muted small">Bag them up, then tick each one off when it’s dropped off. Out of the car boot means out of the house.</p><div class="rows">' +
      bagRows.map(function (b) {
        return '<div class="bag' + (b.droppedDay ? ' done' : '') + '"><span class="emo" aria-hidden="true">' + (b.droppedDay ? '✅' : '🛍️') + '</span><span><b>Bag ' + b.n + ': ' + plural(b.count, 'item') + '</b>' + (b.droppedDay ? ' - dropped off ✓ <span class="muted">' + esc(C.shortDay(b.droppedDay)) + '</span>' : '') + '</span>' +
          (b.droppedDay ? '<button class="btn small ghost" type="button" data-act="bagundo" data-bag="' + esc(b.id) + '">Not yet</button>' : '<button class="btn small" type="button" data-act="bagdrop" data-bag="' + esc(b.id) + '">Dropped off</button>') + '</div>';
      }).join('') + '</div>' +
      (loose.length ? '<div class="row" style="margin-top:10px"><span class="small">' + plural(loose.length, 'thing') + ' not in a bag yet.</span><button class="btn small" type="button" data-act="bagup">Put ' + (loose.length === 1 ? 'it' : 'them') + ' in Bag ' + (data.bags.reduce(function (n, b) { return Math.max(n, b.n); }, 0) + 1) + '</button></div>' : '') +
      '</section>';
    out += '<section class="card" style="margin-top:12px"><div class="row spread"><h2 style="margin:0">Up for grabs first?</h2><button class="btn small ghost" type="button" data-act="tab" data-tab="grabs">Make a link</button></div><p class="muted small" style="margin:6px 0 0">Send friends a link before the bags go - they claim what they want, no account needed.</p></section>';
    out += '<section style="margin-top:14px"><div class="row spread"><h2 style="margin:0">Everything in the pile</h2><span class="row"><button class="btn small ghost" type="button" data-act="copydonations">Copy the list</button><button class="btn small ghost" type="button" data-act="csvdonations">Download CSV</button></span></div>' +
      '<p class="small muted" style="margin:6px 0 10px">Keep your donation receipt; values are your own estimates.</p><div class="rows">' +
      rows.map(function (it) {
        var bag = it.donate && it.donate.bag ? data.bags.find(function (b) { return b.id === it.donate.bag; }) : null;
        var v = it.donate && it.donate.value;
        return irow(it, (bag ? 'Bag ' + bag.n + (bag.droppedDay ? ' · dropped off' : '') : 'Not in a bag') + (it.cond ? ' · ' + C.conditionLabel(it.cond) : ''), '<span class="pill ' + (bag && bag.droppedDay ? 'ok' : 'donate') + '">' + esc(v ? 'est. ' + money(v) : 'Add value') + '</span>');
      }).join('') + '</div></section>';
    return out;
  }
  function openDonate(id) {
    var it = book.items[id]; if (!it) return;
    var dn = it.donate || {};
    sheet('<div class="body"></div>', function (root) {
      $('.body', root).innerHTML = '<h2>' + esc(it.emoji + ' ' + it.name) + '</h2>' +
        '<label class="field"><span>Bag</span><select class="input" id="dnBag"><option value="">Not in a bag yet</option>' + data.bags.map(function (b) { return '<option value="' + esc(b.id) + '"' + (dn.bag === b.id ? ' selected' : '') + '>Bag ' + b.n + (b.droppedDay ? ' (dropped off)' : '') + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Your estimated value <span class="hint">(optional, for your own records)</span></span><input class="input" id="dnVal" inputmode="decimal" value="' + esc(dn.value ? (dn.value / 100).toFixed(dn.value % 100 ? 2 : 0) : '') + '" style="max-width:200px"></label>' +
        '<p class="small muted">Keep your donation receipt; values are your own estimates.</p>' +
        '<div class="row" style="margin-top:12px"><button class="btn" type="button" id="dnSave">Save</button><button class="btn ghost" type="button" data-act="itemfull" data-id="' + esc(it.id) + '">Edit the item</button></div>';
      $('#dnSave', root).addEventListener('click', function () {
        var bagId = $('#dnBag', root).value || null, bag = data.bags.find(function (b) { return b.id === bagId; });
        edit(it.id, function (x) { x.donate = { bag: bagId, value: C.readMoney($('#dnVal', root).value) }; if (bag && bag.droppedDay && !x.outAt) { x.outAt = now(); x.outDay = bag.droppedDay; } if (!bag || !bag.droppedDay) { x.outAt = null; x.outDay = null; } });
        closeSheet(); draw(); toast('Saved.');
      });
    });
  }
  function pileToss(rows) {
    if (!rows.length) return emptyPile('toss');
    var gone = rows.filter(C.isOut).length;
    return '<section class="card">' + statsHtml([[gone + ' of ' + rows.length, 'gone']]) + '<p class="small">' + esc(C.TOSS_RULES_LINE) + '</p>' +
      (gone < rows.length ? '<button class="btn small" type="button" data-act="allgone">Mark them all gone</button>' : '') + '</section>' +
      C.tossGroups(rows).map(function (g) {
        return '<section class="card tip" style="margin-top:12px"><h2>' + esc(g.title) + '</h2><p class="small">' + esc(g.text) + '</p><div class="rows">' + g.items.map(function (it) {
          return '<div class="row" style="flex-wrap:nowrap">' + '<div style="flex:1;min-width:0">' + irow(it, it.outAt ? 'Gone ' + C.shortDay(it.outDay) : C.roomOf(it.room).label) + '</div>' +
            (it.outAt ? '<button class="btn small ghost" type="button" data-act="notgone" data-id="' + esc(it.id) + '">Undo</button>' : '<button class="btn small" type="button" data-act="gone" data-id="' + esc(it.id) + '">Gone ✓</button>') + '</div>';
        }).join('') + '</div></section>';
      }).join('');
  }
  function pileMaybe(rows, list) {
    if (!rows.length) return emptyPile('maybe');
    var t = today(), next = C.maybeNext(list, t), due = C.maybeDue(list, t);
    var out = '<section class="card"><p>Things you weren’t sure about go in a box with a date 30 days out. Haven’t needed them by then? They go.</p>' +
      (next ? '<div class="row"><button class="btn small ghost" type="button" data-act="maybeics">📅 Add a reminder for ' + esc(C.shortDay(next.day)) + '</button><span class="tiny muted">A calendar file, made on this phone.</span></div>' : '') + '</section>';
    if (due.length) out += '<section class="dueback" style="margin-top:12px" role="status"><b>' + (due.length === 1 ? 'One thing is' : due.length + ' things are') + ' due.</b> Thirty days without needing ' + (due.length === 1 ? 'it' : 'them') + '. Let ' + (due.length === 1 ? 'it' : 'them') + ' go? <div class="row" style="margin-top:8px"><button class="btn small" type="button" data-act="maybeall" data-d="donate">Donate ' + (due.length === 1 ? 'it' : 'them all') + '</button></div></section>';
    out += '<div class="rows" style="margin-top:14px">' + rows.sort(function (a, b) { return a.maybe.until < b.maybe.until ? -1 : 1; }).map(function (it) {
      var s = C.maybeState(it, t);
      return '<div class="stack" style="gap:6px">' + irow(it, s.line, '<span class="pill ' + (s.due ? 'warn' : 'maybe') + '">' + (s.due ? 'Due' : s.left + 'd') + '</span>') +
        (s.due ? '<div class="row" style="padding-left:6px"><button class="btn small ghost" type="button" data-act="maybego" data-id="' + esc(it.id) + '" data-d="keep">I needed it - keep</button><button class="btn small" type="button" data-act="maybego" data-id="' + esc(it.id) + '" data-d="donate">Donate</button><button class="btn small ghost" type="button" data-act="maybego" data-id="' + esc(it.id) + '" data-d="sell">Sell</button><button class="btn small ghost" type="button" data-act="maybego" data-id="' + esc(it.id) + '" data-d="toss">Toss</button></div>' : '') + '</div>';
    }).join('') + '</div>';
    return out;
  }
  function pileKeep(rows) {
    if (!rows.length) return emptyPile('keep');
    return '<section class="card"><p>These are staying. If you change your mind, open one and pick again.</p></section><div class="rows" style="margin-top:12px">' + rows.map(function (it) { return irow(it, C.roomOf(it.room).label + (it.decidedDay ? ' · kept ' + C.shortDay(it.decidedDay) : '')); }).join('') + '</div>';
  }

  /* ---------------- the tally ---------------- */

  function chartSvg(byWeek) {
    var W = 440, H = 230, pad = 22, bw = (W - pad * 2) / byWeek.length, max = Math.max(4, byWeek.reduce(function (m, w) { return Math.max(m, w.total); }, 0));
    var order = ['keep', 'toss', 'sell', 'donate', 'maybe'];
    var desc = byWeek.filter(function (w) { return w.total; }).map(function (w) { return 'week of ' + w.label + ': ' + w.total + ' (' + order.filter(function (k) { return w[k]; }).map(function (k) { return w[k] + ' ' + C.decisionOf(k).label.toLowerCase(); }).join(', ') + ')'; }).join('; ') || 'nothing sorted in these weeks yet';
    var bars = byWeek.map(function (w, i) {
      var x = pad + i * bw + bw * 0.18, wd = bw * 0.64, y = H - pad, segs = '';
      order.forEach(function (k) {
        if (!w[k]) return;
        var h = (w[k] / max) * (H - pad * 2);
        y -= h;
        segs += '<rect class="sw-' + k + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + wd.toFixed(1) + '" height="' + Math.max(1, h - 1).toFixed(1) + '" rx="3"></rect>';
      });
      return segs + (w.total ? '<text x="' + (x + wd / 2).toFixed(1) + '" y="' + (y - 5).toFixed(1) + '" text-anchor="middle">' + w.total + '</text>' : '') +
        '<text x="' + (x + wd / 2).toFixed(1) + '" y="' + (H - 9) + '" text-anchor="middle">' + esc(w.label) + '</text>';
    }).join('');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Things sorted each week, by pile: ' + desc) + '"><line class="ax" x1="' + pad + '" x2="' + (W - pad) + '" y1="' + (H - pad) + '" y2="' + (H - pad) + '"></line>' + bars + '</svg>' +
      '<div class="legend" aria-hidden="true">' + order.map(function (k) { return '<span><i class="sw-' + k + '"></i>' + esc(C.decisionOf(k).label) + '</span>'; }).join('') + '</div>';
  }
  function viewTally() {
    var list = items(), t = C.tally(list, data.bags, { today: today(), currency: cur(), locale: LOCALE }), st = C.streak(sprintDays(), today());
    var out = '<div class="sec-head"><h1>The tally</h1></div>';
    out += '<section class="card"><p class="lab">So far</p>' + statsHtml([[t.out, t.out === 1 ? 'thing out of the house' : 'things out of the house'], [money(t.made), 'made'], [t.bagsDonated, t.bagsDonated === 1 ? 'bag donated' : 'bags donated']]) +
      '<p class="muted small">' + plural(t.sorted, 'thing') + ' sorted · ' + t.leaving + ' leaving · ' + t.kept + ' kept · ' + t.maybe + ' in the Maybe box</p>' +
      '<div class="streak"><span class="emo" aria-hidden="true">' + (st.current ? '🔥' : '🌱') + '</span><span>' + esc(streakLine(st)) + (st.best > 1 ? ' Best: ' + plural(st.best, 'day') + '.' : '') + '</span></div></section>';
    out += '<div class="grid two" style="margin-top:14px"><section class="card"><h2>By week</h2>' + chartSvg(t.byWeek) + '</section>' +
      '<section class="card"><h2>By room</h2>' + (t.rooms.length ? '<div class="stack">' + t.rooms.map(roomBar).join('') + '</div><p class="tiny muted" style="margin-top:8px">The darker part of each bar is what’s leaving; the lighter part is what you kept.</p>' : '<p class="muted">Rooms fill in as you sort.</p>') + '</section></div>';
    out += '<section class="card" style="margin-top:14px"><h2>Your recap image</h2><p class="muted small">A picture of your progress to share - drawn on this phone, never uploaded.</p>' +
      '<label class="check"><input type="checkbox" id="recapPhotos"' + (state.recapPhotos ? ' checked' : '') + '> Include a few of my photos</label>' +
      '<div class="row"><button class="btn" type="button" data-act="recapimg">' + (state.recapUrl ? 'Draw it again' : 'Make my recap image') + '</button>' + (state.recapUrl ? '<button class="btn" type="button" data-act="recapshare">' + (canShareFiles() ? 'Share it' : 'Download it') + '</button>' : '') + '</div>' +
      (state.recapUrl ? '<img class="recap-img" alt="Your recap image: ' + esc(t.headline) + '" src="' + esc(state.recapUrl) + '">' : '') + '</section>';
    out += '<section class="card" style="margin-top:14px"><h2>This device</h2><label class="field"><span>Currency</span><select class="input" id="curSel" style="max-width:220px">' + C.CURRENCIES.map(function (c) { return '<option' + (c === cur() ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>' +
      '<p class="small muted">Everything here is kept in this browser only. Clearing your browser’s data clears it.</p><button class="btn small ghost" type="button" data-act="clearall">Clear everything on this device</button></section>';
    return out;
  }
  function canShareFiles() {
    try { return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; }
  }

  /** The recap image: 1080 x 1350, drawn here on a canvas. No photo on it
   *  unless the box is ticked. Never uploaded. */
  function drawRecap() {
    var list = items(), t = C.tally(list, data.bags, { today: today(), currency: cur(), locale: LOCALE });
    var withPhotos = Boolean($('#recapPhotos') && $('#recapPhotos').checked);
    state.recapPhotos = withPhotos;
    var photos = withPhotos ? list.filter(function (it) { return it.photo && C.leaving(it); }).slice(-6) : [];
    return Promise.all(photos.map(function (it) { return photoGet(it.id).then(function (p) { return p ? loadImg(p.thumb) : null; }); })).then(function (imgs) {
      imgs = imgs.filter(Boolean);
      var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350;
      var g = cv.getContext('2d');
      var grad = g.createLinearGradient(0, 0, 1080, 1350); grad.addColorStop(0, '#0b4f3d'); grad.addColorStop(1, '#4f2163');
      g.fillStyle = grad; g.fillRect(0, 0, 1080, 1350);
      var F = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      // the mark: a card with a tick, between four arrows
      g.fillStyle = '#fffdf8'; roundRect(g, 96, 84, 68, 88, 14); g.fill();
      g.strokeStyle = '#0f6b52'; g.lineWidth = 9; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(113, 130); g.lineTo(126, 143); g.lineTo(148, 116); g.stroke();
      g.fillStyle = '#fffdf8';
      [[130, 66, 0, -1], [130, 190, 0, 1], [78, 128, -1, 0], [182, 128, 1, 0]].forEach(function (a) {
        g.beginPath();
        if (a[2] === 0) { g.moveTo(a[0], a[1] + a[3] * 8); g.lineTo(a[0] - 9, a[1] - a[3] * 4); g.lineTo(a[0] + 9, a[1] - a[3] * 4); }
        else { g.moveTo(a[0] + a[2] * 8, a[1]); g.lineTo(a[0] - a[2] * 4, a[1] - 9); g.lineTo(a[0] - a[2] * 4, a[1] + 9); }
        g.closePath(); g.fill();
      });
      g.fillStyle = '#e2f3ea'; g.font = '800 46px ' + F; g.textBaseline = 'middle'; g.fillText('Sorted', 214, 130);
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#ffffff'; g.font = '900 250px ' + F; g.fillText(fit(g, String(t.out), 900), 76, 450);
      g.font = '800 60px ' + F; g.fillText(t.out === 1 ? 'thing out of the house' : 'things out of the house', 84, 535);
      var stats = [[money(t.made), 'made'], [String(t.bagsDonated), t.bagsDonated === 1 ? 'bag donated' : 'bags donated'], [String(t.sorted), 'sorted']];
      stats.forEach(function (s, i) {
        var x = 84 + i * 316;
        g.fillStyle = 'rgba(255,255,255,.12)'; roundRect(g, x, 590, 290, 160, 28); g.fill();
        g.fillStyle = '#ffffff'; g.font = '900 68px ' + F; g.fillText(fit(g, s[0], 250), x + 26, 676);
        g.fillStyle = '#e2f3ea'; g.font = '700 32px ' + F; g.fillText(s[1], x + 26, 722);
      });
      var y = 800;
      t.rooms.slice().sort(function (a, b) { return b.leaving - a.leaving; }).slice(0, 3).forEach(function (r) {
        g.fillStyle = '#ffffff'; g.font = '800 38px ' + F; g.fillText(fit(g, r.label, 400), 84, y + 36);
        g.fillStyle = '#e2f3ea'; g.font = '700 28px ' + F; g.fillText(r.leaving + ' of ' + r.total + ' leaving', 84, y + 74);
        g.fillStyle = 'rgba(255,255,255,.2)'; roundRect(g, 520, y + 22, 476, 30, 15); g.fill();
        g.fillStyle = '#6fd3a8'; roundRect(g, 520, y + 22, Math.max(30, 476 * (r.total ? r.leaving / r.total : 0)), 30, 15); g.fill();
        y += 104;
      });
      if (imgs.length) {
        var sz = Math.min(140, Math.floor((912 - (imgs.length - 1) * 12) / imgs.length));
        imgs.forEach(function (im, i) { var x = 84 + i * (sz + 12); g.save(); roundRect(g, x, 1220 - sz, sz, sz, 20); g.clip(); var s = Math.max(sz / im.width, sz / im.height); g.drawImage(im, x + (sz - im.width * s) / 2, 1220 - sz + (sz - im.height * s) / 2, im.width * s, im.height * s); g.restore(); });
      } else {
        var emo = list.filter(C.leaving).slice(-9).map(function (it) { return it.emoji; }).join('');
        g.font = '78px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; g.fillStyle = '#ffffff'; g.fillText(fit(g, emo, 912), 84, 1196);
      }
      g.fillStyle = '#e2f3ea'; g.font = '700 30px ' + F; g.fillText('Decluttered with Sorted · ' + fit(g, location.host + BASE.replace(/\/$/, ''), 560), 84, 1290);
      return new Promise(function (resolve) { cv.toBlob(function (b) { resolve(b); }, 'image/png'); });
    }).then(function (blob) {
      if (!blob) throw new Error('This browser couldn’t draw the image.');
      if (state.recapUrl) URL.revokeObjectURL(state.recapUrl);
      state.recapBlob = blob; state.recapUrl = URL.createObjectURL(blob);
      draw();
      toast(canShareFiles() ? 'Drawn - tap Share it.' : 'Drawn - tap Download it.');
    });
  }
  function loadImg(src) { return new Promise(function (r) { var im = new Image(); im.addEventListener('load', function () { r(im); }); im.addEventListener('error', function () { r(null); }); im.src = src; }); }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function fit(g, s, max) { s = String(s); if (g.measureText(s).width <= max) return s; var cps = Array.from(s); while (cps.length > 1 && g.measureText(cps.join('') + '…').width > max) cps.pop(); return cps.join('') + '…'; }
  function shareRecap() {
    if (!state.recapBlob) return;
    var file = new File([state.recapBlob], 'sorted-recap.png', { type: 'image/png' });
    if (canShareFiles()) {
      navigator.share({ files: [file], title: 'My clear-out' }).catch(function (e) { if (!e || e.name !== 'AbortError') download('sorted-recap.png', 'image/png', state.recapBlob); });
    } else download('sorted-recap.png', 'image/png', state.recapBlob);
  }

  /* ---------------- the price estimate (metered) ---------------- */

  function imageFor(it) {
    if (!it.photo) return Promise.resolve(null);
    return photoGet(it.id).then(function (p) {
      if (!p) return null;
      var data64 = p.full.replace(/^data:image\/jpeg;base64,/, '');
      if (data64.length <= 700000) return { type: 'image/jpeg', data: data64, preview: p.thumb };
      return loadImg(p.full).then(function (im) { var smaller = redraw(im, 1000, 0.7); return { type: 'image/jpeg', data: smaller.replace(/^data:image\/jpeg;base64,/, ''), preview: p.thumb }; });
    });
  }
  function openEstimate(id) {
    var it = book.items[id]; if (!it) return;
    imageFor(it).then(function (img) {
      var payload = C.estimatePayload(it, img ? { type: img.type, data: img.data } : null, cur());
      sheet('<div class="body"></div>', function (root) {
        var b = $('.body', root);
        var sent = '<div class="sent">' + (img ? '<img alt="" src="' + esc(img.preview) + '">' : '') + '<b>What is sent:</b> ' + (img ? 'this photo (shrunk on this phone, location removed), ' : '') + 'the name “' + esc(it.name) + '”' + (it.cond ? ' and the condition “' + esc(C.conditionLabel(it.cond)) + '”' : '') + ', and your currency (' + esc(payload.currency) + '). Nothing else - not your room, your note or what you paid.<span style="display:block;clear:both"></span></div>';
        if (!signedIn()) {
          b.innerHTML = '<h2>What could this sell for?</h2><p>An AI looks at ' + (img ? 'the photo and ' : '') + 'the name and gives a realistic second-hand range, a listing title and three tips.</p>' + sent +
            '<p class="note" style="margin-top:12px">Estimates need a free account - it comes with $2 of AI credit, and one estimate costs about a cent. Sorting, the piles and everything else stay free with no account.</p>' +
            '<div class="row" style="margin-top:12px"><button class="btn" type="button" id="estJoin">Create a free account</button><button class="btn ghost" type="button" id="estIn">Sign in</button></div>';
          $('#estJoin', root).addEventListener('click', function () { openAccount('Create a free account for price estimates.', function () { openEstimate(id); }); });
          $('#estIn', root).addEventListener('click', function () { openAccount('Sign in for price estimates.', function () { openEstimate(id); }, 'login'); });
          return;
        }
        b.innerHTML = '<h2>What could this sell for?</h2>' + sent + (img ? '' : '<p class="small muted" style="margin-top:8px">No photo, so the estimate comes from the name alone. Add a photo for a better one.</p>') +
          '<div id="estOut" style="margin-top:12px"></div><div class="row" style="margin-top:12px"><button class="btn ai" type="button" id="estGo"> Estimate it</button><span class="tiny muted">About a cent of AI credit.</span></div>';
        var outBox = $('#estOut', root), btn = $('#estGo', root);
        btn.addEventListener('click', function () {
          btn.disabled = true; btn.textContent = 'Looking…';
          outBox.innerHTML = '<p class="muted" role="status">Looking at it…</p>';
          api('POST', 'api/ai/estimate', payload).then(function (r) {
            var e = r.estimate;
            btn.hidden = true;
            var mid = Math.round((e.low + e.high) / 200) * 100;
            outBox.innerHTML = '<div class="est"><span class="range">' + esc(money(e.low)) + ' – ' + esc(money(e.high)) + '</span><span><span class="pill ' + (e.confidence === 'high' ? 'ok' : e.confidence === 'medium' ? 'sell' : 'warn') + '">' + esc(e.confidence) + ' confidence</span></span>' +
              (e.reason ? '<p style="margin:0">' + esc(e.reason) + '</p>' : '') + (e.title ? '<p style="margin:0"><b>Listing title:</b> ' + esc(e.title) + '</p>' : '') +
              (e.tips.length ? '<ul style="margin:0;padding-left:20px">' + e.tips.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
              '<p class="small" style="margin:0"><b>An estimate - check sold listings</b> for the same thing before you price it.</p></div>' +
              '<div class="row" style="margin-top:10px">' + (mid ? '<button class="btn small" type="button" id="estUse">Ask ' + esc(money(mid)) + '</button>' : '') + (e.title && e.title !== it.name ? '<button class="btn small ghost" type="button" id="estTitle">Use the title as its name</button>' : '') + '</div>';
            var use = $('#estUse', root);
            if (use) use.addEventListener('click', function () {
              edit(it.id, function (x) { x.estimate = { low: e.low, high: e.high, currency: e.currency, confidence: e.confidence, title: e.title }; x.sell = Object.assign({}, x.sell || {}, { ask: mid }); });
              if (book.items[it.id].decision !== 'sell') { book = C.decide(book, it.id, 'sell', ctx({ ask: mid })); save(); }
              closeSheet(); draw(); toast('Asking ' + money(mid) + '.');
            });
            var tt = $('#estTitle', root);
            if (tt) tt.addEventListener('click', function () { edit(it.id, function (x) { x.name = e.title; }); tt.disabled = true; tt.textContent = 'Renamed'; draw(); });
            loadMe();
          }).catch(function (err) {
            btn.disabled = false; btn.textContent = ' Estimate it';
            meteredError(err, outBox, function () { openEstimate(id); }, 'Sign in for price estimates.');
          });
        });
      });
    });
  }

  /* ---------------- up for grabs: the owner ---------------- */

  function linkUrl(code) { return location.origin + BASE + 'g/' + code; }
  function viewGrabs() {
    var out = '<div class="sec-head"><h1>Up for grabs</h1></div>';
    if (!signedIn()) {
      return out + '<section class="card"><p class="lead" style="font-weight:800;font-size:1.1rem">Before the bags go to the charity shop, let friends and family claim what they want.</p>' +
        '<ol class="steps" style="margin-top:12px"><li><div><b>Pick things from your Donate and Sell piles.</b><br><span class="muted">Up to 40, with a photo only if you leave it ticked.</span></div></li>' +
        '<li><div><b>Send the link.</b><br><span class="muted">Friends open it with no account and tap “I’ll take it” - first come, first served.</span></div></li>' +
        '<li><div><b>See who wants what.</b><br><span class="muted">Mark things collected; the link closes itself after the days you choose.</span></div></li></ol>' +
        '<p class="note" style="margin-top:12px">Making a link needs a free account (so it can be closed and deleted from any device). Friends never need one, and sorting stays free with no account.</p>' +
        '<div class="row" style="margin-top:12px"><button class="btn" type="button" data-act="signin">Create a free account</button><button class="btn ghost" type="button" data-act="signin-login">Sign in</button></div></section>';
    }
    if (state.me && state.me.grabs === false) return out + '<section class="card"><p>Up for grabs isn’t available right now. Everything else works on your phone.</p></section>';
    var pool = items().filter(function (it) { return (it.decision === 'donate' && !it.outAt) || (it.decision === 'sell' && it.sell && it.sell.status !== 'sold'); });
    var links = state.grabs || [];
    var open = links.filter(function (l) { return l.status === 'open'; }).length;
    out += '<p class="muted">Friends see only what you tick: the name, the note you write here, the price if it’s for sale, and the photo if you leave it ticked. Nothing else about you but the name you choose below.</p>';
    if (state.grabsErr) out += '<p class="err" role="alert">' + esc(state.grabsErr) + '</p>';
    var make;
    if (open >= C.LIMITS.grabsOpen) make = '<section class="card"><p style="margin:0">You have ' + open + ' open links - close one to make another.</p></section>';
    else if (!pool.length) make = '<section class="card empty"><span class="emo" aria-hidden="true">🎁</span><p>Nothing in the Donate or Sell piles yet.</p><p class="muted small">Swipe things down to donate (or up to sell), then come back to offer them to friends first.</p><button class="btn ghost" type="button" data-act="sprint">Start a sprint</button></section>';
    else make = makeLinkHtml(pool);
    if (state.making) make += '<p class="muted" role="status">' + esc(state.making) + '</p>';
    if (state.grabs === null) return out + '<p class="muted" role="status">Loading your links…</p>' + make;
    if (!links.length) return out + make;
    return out + '<h2>Your links</h2><div class="stack">' + links.map(linkCardHtml).join('') + '</div>' +
      (open >= C.LIMITS.grabsOpen || !pool.length ? '<div style="margin-top:16px">' + make + '</div>' : '<details class="card" style="margin-top:16px"' + (state.makeOpen ? ' open' : '') + '><summary class="link-btn" style="display:inline-flex;align-items:center">Make another link</summary>' + make.replace(/^<section class="card">/, '<section>') + '</details>');
    return out;
  }
  function makeLinkHtml(pool) {
    var rows = pool.slice(0, 80).map(function (it, i) {
      var on = it.decision === 'donate' && i < C.LIMITS.grabItems;
      var price = it.decision === 'sell' && it.sell && it.sell.ask ? money(it.sell.ask) : '';
      return '<div class="pick"><input type="checkbox" data-pick="' + esc(it.id) + '"' + (on ? ' checked' : '') + ' aria-label="' + esc('Include ' + it.name) + '">' + thumbHtml(it, 'pthumb') +
        '<div style="min-width:0"><b class="wrapt">' + esc(it.name) + '</b> <span class="pill ' + it.decision + '">' + esc(C.decisionOf(it.decision).label + (price ? ' · ' + price : '')) + '</span>' +
        '<div class="sub"><label class="vh" for="gn-' + esc(it.id) + '">Note friends see</label><input class="input" id="gn-' + esc(it.id) + '" data-gnote="' + esc(it.id) + '" maxlength="' + C.LIMITS.grabNote + '" placeholder="A note for friends" value="' + esc(C.conditionLabel(it.cond)) + '" style="min-height:44px;flex:1;min-width:150px">' +
        (it.photo ? '<label class="check small"><input type="checkbox" data-gphoto="' + esc(it.id) + '" checked> Include photo</label>' : '') + '</div></div></div>';
    }).join('');
    return '<section class="card"><h2>Make a link</h2>' +
      '<label class="field"><span>Your message</span><input class="input" id="gTitle" maxlength="' + C.LIMITS.grabTitle + '" value="' + esc(C.GRAB_TITLE_DEFAULT) + '"></label>' +
      '<div class="grid two"><label class="field"><span>Show my name as</span><input class="input" id="gFrom" maxlength="' + C.LIMITS.grabFrom + '" placeholder="' + esc(C.FRIEND) + '" value="' + esc(prefs.from || '') + '"></label>' +
      '<label class="field"><span>Open for</span><select class="input" id="gDays">' + [1, 2, 3, 5, 7, 10, 14].map(function (d) { return '<option value="' + d + '"' + (d === C.LIMITS.grabDaysDefault ? ' selected' : '') + '>' + plural(d, 'day') + '</option>'; }).join('') + '</select></label></div>' +
      '<p class="lab" style="margin-top:6px">What’s up for grabs <span class="muted" style="text-transform:none;letter-spacing:0">(up to ' + C.LIMITS.grabItems + ')</span></p><div class="rows">' + rows + '</div>' +
      '<div id="gErr"></div><div class="row" style="margin-top:12px"><button class="btn" type="button" data-act="grabmake">Make the link</button><span class="tiny muted">First name or “A friend” only - never your email.</span></div></section>';
  }
  function linkCardHtml(l) {
    var mine = data.links[l.id];
    var claimed = l.items.filter(function (i) { return i.claim; }).length;
    var left = Math.max(0, Math.ceil((Date.parse(l.expiresAt) - now()) / 86400000));
    var pill = l.status === 'open' ? '<span class="pill ok">Open · ' + (left <= 1 ? 'closes within a day' : left + ' days left') + '</span>' : l.status === 'closed' ? '<span class="pill plain">Closed</span>' : '<span class="pill warn">Expired</span>';
    return '<section class="card glink" id="link-' + esc(l.id) + '"><div class="row spread"><b class="wrapt">' + esc(l.title) + '</b>' + pill + '</div>' +
      '<p class="small muted" style="margin:0">From “' + esc(l.from) + '” · ' + claimed + ' of ' + l.items.length + ' claimed' + (l.status !== 'open' ? ' · friends can’t open it now; it’s deleted ' + C.LIMITS.grabKeepDays + ' days after it closed' : '') + '</p>' +
      (l.status === 'open' ? (mine && mine.code ? '<div class="linkbox"><code>' + esc(linkUrl(mine.code)) + '</code><button class="btn small" type="button" data-act="grabcopy" data-id="' + esc(l.id) + '">Copy</button>' + (navigator.share ? '<button class="btn small ghost" type="button" data-act="grabshare" data-id="' + esc(l.id) + '">Share</button>' : '') + '</div>' : '<p class="tiny muted">The link itself is on the device that made it - it is never stored on the server.</p>') : '') +
      '<div class="rows">' + l.items.map(function (i) {
        var t = mine && mine.map && mine.map[i.id] ? state.thumbs[mine.map[i.id]] : null;
        return '<div class="claim"><span class="thumb" aria-hidden="true">' + (t ? '<img alt="" src="' + esc(t) + '">' : '<span class="emo">' + esc(i.emoji) + '</span>') + '</span>' +
          '<span style="min-width:0"><b class="wrapt">' + esc(i.name) + '</b><br><span class="small ' + (i.claim ? '' : 'muted') + '">' + (i.claim ? (i.claim.collected ? '✓ Collected by ' : '🙋 ') + esc(i.claim.name) + (i.claim.collected ? '' : ' wants it') : 'Not claimed') + (i.price ? ' · ' + esc(C.money(i.price, l.currency, LOCALE)) : '') + '</span></span>' +
          '<span class="row" style="gap:6px;justify-content:flex-end">' + (i.claim ? (i.claim.collected ? '<button class="btn small ghost" type="button" data-act="grabcollect" data-g="' + esc(l.id) + '" data-i="' + esc(i.id) + '" data-v="0">Undo</button>' : '<button class="btn small" type="button" data-act="grabcollect" data-g="' + esc(l.id) + '" data-i="' + esc(i.id) + '" data-v="1">Collected</button><button class="btn small ghost" type="button" data-act="grabrelease" data-g="' + esc(l.id) + '" data-i="' + esc(i.id) + '">Release</button>') : '') + '</span></div>';
      }).join('') + '</div>' +
      '<div class="row">' + (l.status === 'open' ? '<button class="btn small ghost" type="button" data-act="grabclose" data-id="' + esc(l.id) + '">Close it now</button>' : '') + '<button class="btn small ghost" type="button" data-act="grabdelete" data-id="' + esc(l.id) + '">Delete the link</button></div></section>';
  }
  function loadGrabs() {
    if (!signedIn()) return Promise.resolve();
    state.grabsAt = now();
    return api('GET', 'api/grabs').then(function (r) {
      var before = JSON.stringify(state.grabs);
      state.grabs = r.links; state.grabsErr = '';
      syncCollected(r.links);
      if (state.view === 'grabs' && before !== JSON.stringify(state.grabs) && !$('#gTitle:focus, [data-gnote]:focus, #gFrom:focus')) { var y = scrollY; draw(); scrollTo(0, y); }
    }).catch(function (e) { if (e.status === 401) { state.me = { signedIn: false }; drawTop(); } state.grabsErr = e.offline ? 'You’re offline - claims show when you’re back online.' : e.message; if (state.grabs === null) state.grabs = []; if (state.view === 'grabs' && !$('#gTitle:focus, [data-gnote]:focus')) draw(); });
  }
  /** Collected on a link: out of the house here too (sold, at its price, if it came from the Sell pile). */
  function syncCollected(links) {
    var changed = false;
    links.forEach(function (l) {
      var m = data.links[l.id] && data.links[l.id].map;
      if (!m) return;
      l.items.forEach(function (i) {
        var it = m[i.id] && book.items[m[i.id]];
        if (!it || !i.claim || !i.claim.collected || it.outAt) return;
        edit(it.id, function (x) {
          x.outAt = now(); x.outDay = today();
          if (x.decision === 'sell') { x.sell = Object.assign({}, x.sell || {}, { status: 'sold', sold: i.price || null, soldDay: today() }); }
        });
        changed = true;
      });
    });
    return changed;
  }
  function pollGrabs() {
    if (!signedIn()) return;
    if (!state.grabsAt || now() - state.grabsAt > 4000) loadGrabs();
    var t = setInterval(function () { if (document.visibilityState === 'visible') loadGrabs(); }, 30000);
    state.timers.push(t);
  }
  function makeLink() {
    var picks = $$('[data-pick]').filter(function (x) { return x.checked; }).map(function (x) { return x.getAttribute('data-pick'); });
    var err = $('#gErr');
    if (!picks.length) { err.innerHTML = '<p class="err" role="alert">Tick at least one thing.</p>'; return; }
    if (picks.length > C.LIMITS.grabItems) { err.innerHTML = '<p class="err" role="alert">A link can hold ' + C.LIMITS.grabItems + ' things - untick ' + (picks.length - C.LIMITS.grabItems) + '.</p>'; return; }
    var chosen = picks.map(function (id) { return book.items[id]; }).filter(Boolean);
    var withPhoto = {};
    $$('[data-gphoto]').forEach(function (x) { if (x.checked) withPhoto[x.getAttribute('data-gphoto')] = true; });
    var notes = {};
    $$('[data-gnote]').forEach(function (x) { notes[x.getAttribute('data-gnote')] = x.value; });
    prefs.from = C.cleanName($('#gFrom').value, C.LIMITS.grabFrom); savePrefs();
    var body = {
      title: $('#gTitle').value, from: prefs.from || C.FRIEND, days: Number($('#gDays').value), currency: cur(),
      items: chosen.map(function (it) { return { name: it.name, note: notes[it.id] || '', emoji: it.emoji, price: it.decision === 'sell' && it.sell && it.sell.ask ? it.sell.ask : null, photo: Boolean(it.photo && withPhoto[it.id]) }; }),
    };
    var btn = $('[data-act="grabmake"]'); btn.disabled = true; btn.textContent = 'Making the link…';
    api('POST', 'api/grabs', body).then(function (r) {
      var map = {};
      r.grab.items.forEach(function (gi, i) { map[gi.id] = chosen[i].id; });
      data.links[r.grab.id] = { code: r.code, map: map };
      save();
      var ups = r.grab.items.filter(function (gi) { return gi.photo; });
      var n = 0;
      var next = function () {
        if (!ups.length) {
          state.making = null; toast('Link made - copy it or share it.');
          return loadGrabs().then(function () { draw(); var el = document.getElementById('link-' + r.grab.id); if (el) try { el.scrollIntoView({ block: 'start', behavior: RM.matches ? 'auto' : 'smooth' }); } catch (x) { /* fine */ } });
        }
        var gi = ups.shift();
        n++;
        state.making = 'Adding photos ' + n + ' of ' + (n + ups.length) + '…'; draw();
        return photoGet(map[gi.id]).then(function (p) {
          if (!p) return null;
          return api('PUT', 'api/grabs/' + r.grab.id + '/items/' + gi.id + '/thumb', { thumb: p.thumb.replace(/^data:image\/jpeg;base64,/, '') }).catch(function () { return null; });
        }).then(next);
      };
      return next();
    }).catch(function (e) { state.making = null; btn.disabled = false; btn.textContent = 'Make the link'; if (e.status === 401) return openAccount('Sign in to make a link.'); showError(e, err); });
  }
  function grabAct(path, method, body, msg) {
    return api(method, path, body).then(function (r) { if (msg) toast(msg); return loadGrabs().then(function () { draw(); return r; }); }).catch(function (e) { showError(e); });
  }

  /* ---------------- up for grabs: a friend's page ---------------- */

  function drawFriend() {
    clearTimers();
    $('#tabbar').hidden = true;
    var f = state.friend, main = $('#main');
    var html;
    if (f.err) {
      html = '<section class="card empty"><span class="emo" aria-hidden="true">' + (f.offline ? '📡' : '📦') + '</span><h1 style="font-size:1.4rem">' + (f.offline ? 'This list needs the internet' : 'This list isn’t open any more') + '</h1><p class="muted">' + esc(f.offline ? 'It shows what’s still up for grabs right now, so it can’t work offline. Reconnect and try again.' : /isn’t open any more/.test(f.err) ? 'It may have been closed, or it expired. Ask whoever sent it - they may have a new link.' : f.err) + '</p>' +
        (f.offline ? '<button class="btn" type="button" data-act="freload">Try again</button>' : '') + '</section>' + friendFoot();
    } else if (!f.grab) {
      html = '<section class="card"><p class="muted" role="status">Opening the list…</p></section>';
    } else {
      var g = f.grab, left = Math.max(0, Math.ceil((Date.parse(g.expiresAt) - now()) / 86400000));
      var free = g.items.filter(function (i) { return i.state === 'free'; }).length, mine = g.items.filter(function (i) { return i.state === 'mine'; }).length;
      html = '<section class="hero" style="padding:20px 18px"><p class="lab" style="color:var(--hero-soft)">🎁 Up for grabs from ' + esc(g.from) + '</p><h1 style="font-size:1.6rem">“' + esc(g.title) + '”</h1>' +
        '<p>' + free + ' of ' + g.items.length + ' still free · open ' + (left <= 1 ? 'for less than a day' : 'for ' + left + ' more days') + '. First come, first served - tap “I’ll take it” and ' + esc(g.from === C.FRIEND ? 'they' : g.from) + ' will see your first name.</p>' +
        (prefs.claimName ? '<p class="small" style="margin:0">Claiming as <b>' + esc(prefs.claimName) + '</b> · <button class="link-btn" style="color:#ffffff" type="button" data-act="claimname">change</button></p>' : '') + '</section>' +
        (mine ? '<p class="small" style="margin-top:12px">You’ve claimed ' + plural(mine, 'thing') + '. Sort out when to collect with ' + esc(g.from === C.FRIEND ? 'them' : g.from) + ' directly.</p>' : '') +
        '<div class="stack" style="margin-top:14px">' + g.items.map(function (i) {
          var price = i.price ? C.money(i.price, g.currency, LOCALE) : '';
          var acts = i.state === 'free' ? '<button class="btn" type="button" data-act="claim" data-i="' + esc(i.id) + '"' + (f.busy === i.id ? ' disabled' : '') + '>I’ll take it</button>'
            : i.state === 'mine' ? '<span class="pill keep">✓ Yours' + (i.claimName ? ', ' + esc(i.claimName) : '') + '</span>' + (i.collected ? '<span class="pill ok">Collected</span>' : '<button class="btn small ghost" type="button" data-act="unclaim" data-i="' + esc(i.id) + '">Changed my mind</button>')
              : '<span class="pill plain">Taken</span>';
          return '<div class="gitem ' + i.state + '"><span class="thumb" aria-hidden="true">' + (i.photo ? '<img alt="" loading="lazy" src="api/g/' + esc(f.code) + '/thumb/' + esc(i.id) + '">' : '<span class="emo">' + esc(i.emoji) + '</span>') + '</span>' +
            '<div style="min-width:0"><div class="nm">' + esc(i.name) + (i.state === 'taken' ? '<span class="vh"> - taken</span>' : '') + '</div>' + (i.note ? '<div class="small muted wrapt">' + esc(i.note) + '</div>' : '') + (price ? '<div><span class="pill sell">' + esc(price) + '</span></div>' : '') + '</div>' +
            '<div class="acts">' + acts + '</div></div>';
        }).join('') + '</div>' + friendFoot();
    }
    main.innerHTML = html;
    if (f.grab) {
      var t = setInterval(function () { if (document.visibilityState === 'visible') loadFriend(true); }, 45000);
      state.timers.push(t);
    }
  }
  function friendFoot() {
    return '<section class="card" style="margin-top:18px"><p style="margin:0"><b>🧺 Sorted</b> - keep, sell, donate or toss, one swipe at a time. <a href="./">Sort your own things</a> - free, and it stays on your phone.</p></section>';
  }
  function loadFriend(quiet) {
    var f = state.friend;
    return api('GET', 'api/g/' + f.code).then(function (r) {
      var changed = JSON.stringify(f.grab) !== JSON.stringify(r.grab);
      f.grab = r.grab; f.err = ''; f.offline = false;
      if (changed || !quiet) drawFriend();
    }).catch(function (e) {
      if (e.offline || e.status === 0) { f.offline = true; f.err = 'offline'; } else { f.offline = false; f.err = e.message; f.grab = null; }
      drawFriend();
    });
  }
  function askClaimName(then) {
    sheet('<div class="body"></div>', function (root) {
      $('.body', root).innerHTML = '<h2>Your first name</h2><p class="muted small">So they know who it’s for. Just a first name - it’s remembered on this phone for next time.</p>' +
        '<label class="field"><span class="vh">First name</span><input class="input" id="cnIn" maxlength="' + C.LIMITS.claimName + '" autocomplete="given-name" value="' + esc(prefs.claimName || '') + '"></label><div id="cnErr"></div>' +
        '<button class="btn block" type="button" id="cnGo">Save</button>';
      var inp = $('#cnIn', root);
      var goName = function () {
        var n = C.cleanName(inp.value, C.LIMITS.claimName);
        if (!n) { $('#cnErr', root).innerHTML = '<p class="err" role="alert">A first name, please - letters are fine.</p>'; return; }
        prefs.claimName = n; savePrefs(); closeSheet(); if (then) then(); else drawFriend();
      };
      $('#cnGo', root).addEventListener('click', goName);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); goName(); } });
      setTimeout(function () { try { inp.focus(); } catch (e) { /* fine */ } }, 60);
    });
  }
  function claim(iid) {
    if (!prefs.claimName) return askClaimName(function () { claim(iid); });
    var f = state.friend;
    f.busy = iid; drawFriend();
    api('POST', 'api/g/' + f.code + '/items/' + iid + '/claim', { name: prefs.claimName }).then(function (r) {
      f.busy = ''; f.grab = r.grab; drawFriend(); buzz();
      var it = r.grab.items.find(function (x) { return x.id === iid; });
      toast('It’s yours' + (it ? ': ' + it.name : '') + '!'); say('Claimed.');
    }).catch(function (e) {
      f.busy = '';
      if (e.status === 409) { toast(e.message, 4600); return loadFriend(); }
      if (e.status === 404) return loadFriend();
      drawFriend(); showError(e);
    });
  }
  function unclaim(iid) {
    var f = state.friend;
    api('DELETE', 'api/g/' + f.code + '/items/' + iid + '/claim').then(function (r) { f.grab = r.grab; drawFriend(); toast('Let go - it’s free for someone else.'); }).catch(function (e) { showError(e); loadFriend(); });
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
    s.style.maxHeight = off ? 'calc(100vh - ' + Math.round((matchMedia('(min-width: 900px)').matches ? 2 : 1) * (off + 8)) + 'px)' : '';
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
  $('#sheetBack').addEventListener('click', function () { closeSheet(); });

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = state.me || { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Sorting, the piles, sprints and the tally are free with no account, and stay on this device. A free account lets you make up-for-grabs links and adds price estimates - it comes with $2 of AI credit, and one account works across every app on this site.';
  function openAccount(reason, then, start) {
    var mode = start === 'login' ? 'login' : 'register';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); state.grabs = null; if (then) then(); else draw(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { state.grabs = null; if (then) then(); else draw(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">A price estimate costs about a cent. Sorting, the piles and the tally are free and stay on this device.</p><div id="billing"></div></div>' +
      '<p class="small muted" style="margin-top:12px">Your things are not in your account - they stay on this device. The account holds only your up-for-grabs links.</p>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; state.grabs = null; drawTop(); draw(); }); });
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
  function openCredit(d) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((d && d.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Sorting, the piles and everything else keep working, free.</p><div id="billing"></div>' +
      (d && d.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(d.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- clicks ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); if (state.mode === 'friend') { location.href = BASE; break; } go(''); break;
      case 'tab': closeSheet(true); go(t.getAttribute('data-tab') === 'home' ? '' : t.getAttribute('data-tab')); break;
      case 'try': startTry(); break;
      case 'sprint': closeSheet(true); state.recap = null; go('sprint'); break;
      case 'room': startSprint(t.getAttribute('data-room')); break;
      case 'pause': setSprint(C.pauseSprint(sprintOf(data.active), now())); say('Paused.'); draw(); break;
      case 'resume': setSprint(C.resumeSprint(sprintOf(data.active), now())); say('Going again.'); draw(); break;
      case 'extend': setSprint(C.extendSprint(sprintOf(data.active), now())); say('Five more minutes.'); draw(); break;
      case 'finish': {
        var s = sprintOf(data.active);
        if (!s) break;
        setSprint(C.endSprint(s, now()));
        data.active = null; save();
        go('recap/' + s.id);
        if (items().some(function (it) { return it.sprint === s.id && it.decision; })) celebrate();
        break;
      }
      case 'quickadd': quickAdd(); break;
      case 'emoji': {
        var qe = $('#quickEmoji'), qn = $('#quickName');
        pickEmoji(qe.getAttribute('data-picked') || C.emojiFor(qn ? qn.value : ''), function (em) { qe.textContent = em; qe.setAttribute('data-picked', em); if (qn) qn.focus(); });
        break;
      }
      case 'add': openAdd(); break;
      case 'decide': decideTop(t.getAttribute('data-d')); break;
      case 'undo': undoLast(); break;
      case 'askprice': saveAsk(Number(t.getAttribute('data-v'))); break;
      case 'asksave': saveAsk(($('#askIn') || {}).value); break;
      case 'askskip': state.askPrice = null; draw(); break;
      case 'item': {
        var it0 = book.items[id];
        if (!it0) break;
        if (state.view === 'piles' && it0.decision === 'sell') openSell(id);
        else if (state.view === 'piles' && it0.decision === 'donate') openDonate(id);
        else openItem(id);
        break;
      }
      case 'itemfull': closeSheet(true); openItem(id); break;
      case 'pile': state.pile = t.getAttribute('data-pile'); go('piles/' + state.pile); break;
      case 'sellsheet': openSell(id); break;
      case 'copylisting': { var li = book.items[id]; if (li) copy(C.listingText(li, { currency: cur(), locale: LOCALE }), 'Listing copied - paste it into your listing.'); break; }
      case 'todonate': book = C.decide(book, id, 'donate', ctx()); save(); draw(); toast('Moved to Donate.', 3200, { label: 'Undo', fn: undoLast }); break;
      case 'dropprice': { var dp = C.priceDrops(items(), today()).find(function (x) { return x.id === id; }); if (dp) { edit(id, function (x) { x.sell.ask = dp.to; x.sell.droppedDay = today(); }); draw(); toast('Now ' + money(dp.to) + ' - update your listing too.'); } break; }
      case 'estimate': closeSheet(true); openEstimate(id); break;
      case 'bagup': {
        var n = data.bags.reduce(function (m, b) { return Math.max(m, b.n); }, 0) + 1;
        var bag = { id: uid(), n: n, droppedDay: null, where: '' };
        data.bags.push(bag);
        items().filter(function (it) { return it.decision === 'donate' && (!it.donate || !it.donate.bag || !data.bags.some(function (b) { return b.id === it.donate.bag; })); }).forEach(function (it) { edit(it.id, function (x) { x.donate = Object.assign({ value: null }, x.donate || {}, { bag: bag.id }); }); });
        save(); draw(); toast('Bag ' + n + ' packed.');
        break;
      }
      case 'bagdrop': case 'bagundo': {
        var bg = data.bags.find(function (b) { return b.id === t.getAttribute('data-bag'); });
        if (!bg) break;
        var dropped = act === 'bagdrop';
        bg.droppedDay = dropped ? today() : null;
        items().filter(function (it) { return it.decision === 'donate' && it.donate && it.donate.bag === bg.id; }).forEach(function (it) { edit(it.id, function (x) { x.outAt = dropped ? now() : null; x.outDay = dropped ? today() : null; }); });
        save(); draw();
        if (dropped) { toast('Bag ' + bg.n + ' dropped off ✓'); celebrate(); }
        break;
      }
      case 'copydonations': copy(C.donationText(items(), data.bags, { currency: cur(), locale: LOCALE }), 'List copied.'); break;
      case 'csvdonations': download('sorted-donations-' + today() + '.csv', 'text/csv', C.donationCsv(items(), data.bags, { currency: cur() })); toast('Downloaded - made on this device.'); break;
      case 'gone': edit(id, function (x) { x.outAt = now(); x.outDay = today(); }); draw(); toast('Gone ✓'); break;
      case 'notgone': edit(id, function (x) { x.outAt = null; x.outDay = null; }); draw(); break;
      case 'allgone': items().filter(function (it) { return it.decision === 'toss' && !it.outAt; }).forEach(function (it) { edit(it.id, function (x) { x.outAt = now(); x.outDay = today(); }); }); draw(); toast('All gone ✓'); celebrate(); break;
      case 'maybego': { var md = t.getAttribute('data-d'); book = C.decide(book, id, md, ctx()); save(); draw(); toast(md === 'keep' ? 'Kept - it earned its place.' : 'Let go: ' + C.decisionOf(md).label + '.', 3200, { label: 'Undo', fn: undoLast }); break; }
      case 'maybeall': C.maybeDue(items(), today()).forEach(function (it) { book = C.decide(book, it.id, 'donate', ctx()); }); save(); draw(); toast('Moved to Donate.'); break;
      case 'maybeics': { var nx = C.maybeNext(items(), today()); if (nx) { download('sorted-maybe-box-' + nx.day + '.ics', 'text/calendar', C.maybeIcs(nx.day, nx.items.map(function (it) { return it.name; }), ctx())); toast('Open the file to add it to your calendar.'); } break; }
      case 'recapimg': t.disabled = true; drawRecap().catch(function (err) { t.disabled = false; showError(err); }); break;
      case 'recapshare': shareRecap(); break;
      case 'clearall': {
        if (!confirm('Clear everything Sorted keeps on this device - things, photos, piles and sprints? This can’t be undone.')) break;
        items().forEach(function (it) { if (it.photo) photoDel(it.id); });
        book = C.deckOf([]); data.sprints = []; data.bags = []; data.active = null; data.links = {}; save();
        state.recapUrl = null; state.recapBlob = null;
        go(''); toast('Cleared.');
        break;
      }
      case 'signin': openAccount('Create a free account to make up-for-grabs links. Friends never need one.', function () { draw(); }); break;
      case 'signin-login': openAccount('Sign in to make up-for-grabs links.', function () { draw(); }, 'login'); break;
      case 'grabmake': makeLink(); break;
      case 'grabcopy': { var lc = data.links[id]; if (lc) copy(linkUrl(lc.code), 'Link copied - paste it into your group chat.'); break; }
      case 'grabshare': { var ls = data.links[id], lg = (state.grabs || []).find(function (x) { return x.id === id; }); if (ls && navigator.share) navigator.share({ title: 'Up for grabs', text: lg ? lg.title : 'Anything you want?', url: linkUrl(ls.code) }).catch(function () { /* cancelled */ }); break; }
      case 'grabclose': if (confirm('Close this link now? Friends won’t be able to open it, and you’ll still see who claimed what.')) grabAct('api/grabs/' + id + '/close', 'POST', {}, 'Closed.'); break;
      case 'grabdelete': if (confirm('Delete this link, its list and its photos? Friends won’t be able to open it.')) grabAct('api/grabs/' + id, 'DELETE', null, 'Deleted.').then(function () { delete data.links[id]; save(); }); break;
      case 'grabcollect': grabAct('api/grabs/' + t.getAttribute('data-g') + '/items/' + t.getAttribute('data-i') + '/collected', 'POST', { collected: t.getAttribute('data-v') === '1' }, t.getAttribute('data-v') === '1' ? 'Collected ✓ - out of the house.' : null); break;
      case 'grabrelease': if (confirm('Release this claim? It becomes free for someone else.')) grabAct('api/grabs/' + t.getAttribute('data-g') + '/items/' + t.getAttribute('data-i') + '/claim', 'DELETE', null, 'Released.'); break;
      case 'claim': claim(t.getAttribute('data-i')); break;
      case 'unclaim': unclaim(t.getAttribute('data-i')); break;
      case 'claimname': askClaimName(); break;
      case 'freload': state.friend.err = ''; drawFriend(); loadFriend(); break;
      default: break;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && $('#sheet').hidden && deckNow() && ['try', 'sort', 'sprint'].indexOf(state.view) >= 0 && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) { e.preventDefault(); undoLast(); }
      return;
    }
    if (!$('#sheet').hidden || state.mode === 'friend' || ['try', 'sort', 'sprint'].indexOf(state.view) < 0) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable) || document.querySelector('.emoji-grid')) return;
    var map = { ArrowRight: 'keep', ArrowLeft: 'toss', ArrowUp: 'sell', ArrowDown: 'donate', m: 'maybe', M: 'maybe' };
    if (map[e.key] && $('.scard.front')) { e.preventDefault(); decideTop(map[e.key]); }
    else if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undoLast(); }
  });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill && state.mode !== 'friend') pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (state.mode === 'friend') { if (state.friend.grab) loadFriend(true); return; }
    if (state.view === 'grabs') loadGrabs();
    else if (state.view === 'home' || state.view === 'piles') draw();
  });
  drawTop();
  route();
  if (state.mode !== 'friend') loadMe().then(function () {
    if (signedIn()) loadGrabs();
    if (state.view === 'grabs') draw();
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
