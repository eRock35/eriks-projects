/* Whichbox - the page. One file, no build step.
 *
 * EVERYTHING STAYS ON THIS PHONE unless its owner shares a move: the moves
 * and storage inventories, their rooms and boxes in localStorage, photos of
 * open boxes in IndexedDB (shrunk through a canvas first, which drops their
 * EXIF, location included). Search, moving day, what's where, labels, room
 * signs and the CSV are worked out here by WhichboxCore. Every storage
 * access is wrapped in try/catch, and the page works - in memory - when
 * storage is unavailable.
 *
 * The requests this page makes: sign-in; sharing a move with helpers (the
 * move's name, rooms and boxes as text - never a photo) and everything a
 * shared move does; and "List what's in this box", whose payload (the one
 * photo) is shown before it is sent.
 *
 * Every string a person typed, a file held, the server answered or a model
 * wrote is escaped before it is drawn, and no handler is written into
 * markup: clicks are routed by data-act attributes from one listener (the
 * lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.WhichboxCore;
  var QR = window.WhichboxQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var ORIGIN = location.origin;
  var esc = C.esc, plural = C.plural;
  // A tag the browser reports but Intl refuses ("en-US@posix" in some
  // headless browsers) would make every date throw: fall back.
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  var K_DATA = 'whichbox-data-v1', K_PREFS = 'whichbox-prefs-v1', K_ME = 'whichbox-me-v1';

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function now() { return Date.now(); }
  function rand(n) { var a = new Uint32Array(1); try { crypto.getRandomValues(a); } catch (e) { a[0] = Math.floor(Math.random() * 4294967296); } return a[0] % n; }
  function o() { return { now: now(), rand: rand }; }
  function timeOf(isoOrMs) {
    var d = new Date(isoOrMs);
    if (!isFinite(d)) return '';
    try {
      var same = new Date().toDateString() === d.toDateString();
      return same ? d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  /* ---------------- what this phone keeps ---------------- */

  function loadData() {
    var raw = recall(K_DATA) || {};
    var seen = {};
    var moves = (Array.isArray(raw.moves) ? raw.moves : []).map(function (m) { return C.cleanMove(m, o()); })
      .filter(function (m) { if (!m || seen[m.id]) return false; seen[m.id] = 1; return true; }).slice(0, C.LIMITS.moves);
    var current = moves.some(function (m) { return m.id === raw.current; }) ? raw.current : (moves[0] ? moves[0].id : null);
    return { v: 1, moves: moves, current: current };
  }
  var data = loadData();
  var prefs = recall(K_PREFS) || {};
  if (!C.PAPERS[prefs.paper]) prefs.paper = C.paperFor(LOCALE);
  if (C.PER_PAGE.indexOf(prefs.per) < 0) prefs.per = 6;
  if (typeof prefs.contents !== 'boolean') prefs.contents = true;
  if (!prefs.lastRoom || typeof prefs.lastRoom !== 'object') prefs.lastRoom = {};
  function savePrefs() { keep(K_PREFS, prefs); }
  var meDefaults = recall(K_ME) || {};
  var storageOk = true;
  function saveLocal() {
    var ok = keep(K_DATA, data);
    if (!ok && storageOk) { storageOk = false; toast('This browser isn’t keeping things right now - your boxes will be gone when the page closes.', 5200); }
  }

  var state = {
    me: null, view: '', arg: '', q: '',
    trying: false, demo: null,
    form: null, ai: null, room: 'all', tag: 'all',
    labels: { which: 'all', room: '' },
    offline: false, busy: false,
    join: null, found: null,
  };
  function cur() {
    if (state.trying) return state.demo;
    return data.moves.find(function (m) { return m.id === data.current; }) || null;
  }
  function shared(m) { return Boolean(m && m.shared); }
  function canEdit(m) { return Boolean(m && (!m.shared || m.shared.role === 'owner')); }
  function isHelper(m) { return Boolean(m && m.shared && m.shared.role === 'helper'); }
  function setMove(m) {
    if (!m) return;
    if (state.trying || m.sample) { state.demo = m; return; }
    m.updatedAt = C.iso(now());
    var i = data.moves.findIndex(function (x) { return x.id === m.id; });
    if (i >= 0) data.moves[i] = m; else data.moves.unshift(m);
    data.current = m.id;
    saveLocal();
  }
  function removeMove(id) {
    var m = data.moves.find(function (x) { return x.id === id; });
    if (m) m.boxes.forEach(function (b) { if (b.photo) photoDel(b.id); });
    data.moves = data.moves.filter(function (x) { return x.id !== id; });
    if (data.current === id) data.current = data.moves[0] ? data.moves[0].id : null;
    saveLocal();
  }

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    var headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin', headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      state.offline = false;
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok || d.error) { var e = new Error(d.error || 'Something went wrong.'); e.status = res.status; e.data = d; throw e; }
        return d;
      });
    }, function () { state.offline = true; var e = new Error('You’re offline - that needs the internet.'); e.status = 0; e.offline = true; throw e; });
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
    toastTimer = setTimeout(function () { t.remove(); }, ms || 2800);
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
  function shareText(title, text, url) {
    if (navigator.share) return navigator.share({ title: title, text: text, url: url }).catch(function (e) { if (!e || e.name !== 'AbortError') copy(text + ' ' + url, 'Copied - paste it to your helpers.'); });
    copy(text + ' ' + url, 'Copied - paste it to your helpers.');
    return Promise.resolve();
  }
  function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'boxes'; }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function rc(move, roomId) { var r = C.roomOf(move, roomId); return C.colorHex(r ? r.color : 'stone'); }
  function roomName(move, roomId) { var r = C.roomOf(move, roomId); return r ? r.name : 'No room'; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Whichbox stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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

  /* ---------------- photos: on this phone only ---------------- */

  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        var r = indexedDB.open('whichbox', 1);
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
    return idb('readonly', function (s) { return s.get('p-' + id); }).then(function (v) {
      if (v && JPEG_URL.test(v.thumb || '') && JPEG_URL.test(v.full || '')) memPhotos[id] = v;
      return memPhotos[id] || null;
    });
  }
  function photoPut(id, p) { memPhotos[id] = p; return idb('readwrite', function (s) { return s.put(p, 'p-' + id); }); }
  function photoDel(id) { delete memPhotos[id]; return idb('readwrite', function (s) { return s.delete('p-' + id); }); }
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
  function loadImg(src) { return new Promise(function (r) { var im = new Image(); im.addEventListener('load', function () { r(im); }); im.addEventListener('error', function () { r(null); }); im.src = src; }); }
  /** A photo of the open box: 1200 px and a 240 px thumbnail, both redrawn
   *  here, so its location never leaves the camera roll. */
  function prepPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('That isn’t a photo.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        try {
          var full = redraw(img, 1200, 0.8);
          var thumb = redraw(img, 240, 0.72);
          URL.revokeObjectURL(url);
          resolve({ full: full, thumb: thumb });
        } catch (e) { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); });
      img.src = url;
    });
  }
  var PHOTO_LINE = 'The photo is shrunk on this phone, its location is removed, and it stays here - it is never shared.';

  /* ---------------- routing ---------------- */

  function route() {
    var h = C.parseHash(location.hash);
    state.view = h.view; state.arg = h.id || h.code || h.sid || '';
    state.hash = h;
    if (h.view === 'try') { startTry('move'); return; }
    if (h.view === 'tryloft') { startTry('storage'); return; }
    if (h.view === 'box') return openBoxAnywhere(h.id);
    if (h.view === 'sbox' || h.view === 'smove') return openShared(h.sid, h.id);
    if (h.view === 'join') { state.join = { code: h.code, info: null }; lookupJoin(); }
    draw();
  }
  function go(hash) {
    var target = BASE + (hash ? '#' + hash : '');
    if (location.pathname + location.hash !== target) history.pushState(null, '', target);
    route();
    scrollTo(0, 0);
  }
  window.addEventListener('popstate', route);

  /** A label's #box/<id>: this phone's moves first, then the shared moves it
   *  has joined (labels printed before a move was shared still open). */
  function openBoxAnywhere(id) {
    if (state.trying && C.boxOf(state.demo, id)) { state.view = 'box'; state.arg = id; draw(); return; }
    var m = data.moves.find(function (x) { return C.boxOf(x, id); });
    if (m) { leaveTryQuiet(); data.current = m.id; saveLocal(); state.view = 'box'; state.arg = id; draw(); if (shared(m)) refreshShared(m); return; }
    state.view = 'nobox'; draw();
  }
  function openShared(sid, bid) {
    var m = data.moves.find(function (x) { return x.shared && x.shared.id === sid; });
    if (m) {
      leaveTryQuiet(); data.current = m.id; saveLocal();
      state.view = bid ? 'box' : 'boxes'; state.arg = bid || '';
      draw();
      refreshShared(m).then(function () { draw(); });
      return;
    }
    state.view = 'join'; state.join = { code: '', info: null, sid: sid, bid: bid };
    draw();
  }

  function draw() {
    var m = cur();
    var v = state.view;
    var first = !m && ['join', 'new', 'newstorage', 'nobox'].indexOf(v) < 0;
    var tabs = $('#tabbar');
    tabs.hidden = first || !m || ['join', 'new', 'newstorage', 'nobox'].indexOf(v) >= 0;
    if (m) {
      $('#tabDayName').textContent = m.kind === 'storage' ? 'Where' : 'Moving day';
      var tab = v === 'box' || v === 'add' || v === 'edit' ? 'boxes' : v === 'where' ? 'day' : (v || 'boxes');
      $$('[data-act="tab"]', tabs).forEach(function (b) { if (b.getAttribute('data-tab') === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
      var miss = m.kind === 'move' ? C.dayCounts(m).missing.length : 0;
      var badge = $('#dayBadge'); badge.hidden = !miss; badge.textContent = String(miss);
    }
    $('#movePill').hidden = !m || first;
    document.body.classList.toggle('has-pill', Boolean(m && !first));
    if (m) $('#movePillName').textContent = m.name;
    var html;
    if (first) html = viewFirst();
    else if (v === 'join') html = viewJoin();
    else if (v === 'new' || v === 'newstorage') html = viewNew(v === 'newstorage' ? 'storage' : 'move');
    else if (v === 'nobox') html = viewNoBox();
    else if (!m) html = viewFirst();
    else if (v === 'box') html = viewBox(m);
    else if (v === 'add' || v === 'edit') html = viewForm(m);
    else if (v === 'find') html = viewFind(m);
    else if (v === 'day' || v === 'where') html = m.kind === 'storage' ? viewWhere(m) : viewDay(m);
    else if (v === 'labels') html = viewLabels(m);
    else if (v === 'more') html = viewMore(m);
    else html = viewBoxes(m);
    var lead = '';
    if (m && !first && ['join', 'new', 'newstorage', 'nobox'].indexOf(v) < 0) lead = (state.trying ? ribbon() : '') + offlineBar(m);
    $('#main').innerHTML = lead + html;
    after(m);
  }
  function after(m) {
    var v = state.view;
    if (v === 'add' || v === 'edit') bindForm(m);
    if (v === 'find') bindFind(m);
    if (v === 'labels') fitPreview();
    if (v === 'box') loadBoxPhoto(m);
    if (v === 'boxes') bindQuick();
    if (v === 'join') bindJoin();
    if (v === 'new' || v === 'newstorage') bindNew();
    if (v === 'more') bindMore(m);
    if (v === 'day') bindJump(m);
  }
  function ribbon() {
    return '<div class="ribbon" role="note"><span>' + (state.demo.kind === 'storage' ? 'A made-up loft - tap around, nothing here is saved.' : 'A made-up move, halfway through moving day - tap around, nothing here is saved.') + '</span><div class="row"><button class="btn small" type="button" data-act="tryown">Start my own</button><button class="btn small ghost" type="button" data-act="tryleave">Leave</button></div></div>';
  }
  function offlineBar(m) {
    if (!shared(m) || !state.offline) return '';
    return '<div class="offline-bar" role="status">You’re offline - this is the move as of ' + esc(timeOf(m.shared.at || now())) + '. Changing a box needs the internet.</div>';
  }

  /* ---------------- the first run ---------------- */

  function mockLabel() {
    var qr = QR ? QR.svg(ORIGIN + BASE + '#try', 'A QR code that opens the made-up move') : '';
    return '<div class="crate" aria-hidden="true"><div class="mocklabel">' +
      '<div class="mno">14</div><div class="mqr">' + qr + '</div>' +
      '<div class="mflag">OPEN FIRST</div>' +
      '<div class="mband">KITCHEN</div>' +
      '<div class="mfoot"><span>Kettle, mugs, tea, chargers +4</span><span>Larkfield → Harbour</span></div>' +
      '</div><div class="scanbubble">Box 14 · Kitchen<small>✓ Delivered</small></div></div>';
  }
  function viewFirst() {
    var dec = /^(11|12|01)$/.test(new Date().toISOString().slice(5, 7));
    return '<section class="hero" aria-labelledby="heroTitle"><div class="hero-grid"><div>' +
      '<p class="lab" style="color:var(--hero-soft)">Moving · the loft · the garage</p>' +
      '<h1 id="heroTitle">Which box is the kettle in?</h1>' +
      '<p>Number every box, list what’s inside as you pack, and print a label with a QR code and a colour for its room. Then find anything in seconds - on moving day, or when the holiday decorations come down.</p>' +
      '<div class="cta"><button class="btn big white" type="button" data-act="try">Try it - a made-up move</button>' +
      '<div class="row"><button class="btn line" type="button" data-act="newmove">Start a move</button><button class="btn line" type="button" data-act="newstorage">Just my storage boxes</button></div></div>' +
      '<p class="small" style="margin-top:12px">Free, no sign-up. It all stays on this phone.</p></div>' +
      mockLabel() + '</div></section>' +
      '<section class="card" style="margin-top:16px" aria-labelledby="howTitle"><h2 id="howTitle">How it works</h2><ol class="how">' +
      '<li><div><b>Pack and list.</b><br><span class="muted">Each box gets the next number. Pick its room, type what goes in - press Enter after each thing - and tick Fragile, Heavy or Open first. A photo of the open box if you like.</span></div></li>' +
      '<li><div><b>Print the labels.</b><br><span class="muted">Six to a page or two big ones, on Letter or A4: the number huge, the room as a coloured band in words, the flags in bold, and a QR code that opens the box. Plus a sign for each room’s door.</span></div></li>' +
      '<li><div><b>Scan it, find it.</b><br><span class="muted">Search “kettle” and get “Box 14 · Kitchen · Delivered”. Scan a label on the truck and tap Delivered. Moving day counts every room: “Kitchen: 12 of 14 delivered”.</span></div></li>' +
      '</ol></section>' +
      '<div class="grid three" style="margin-top:14px">' +
      '<section class="card feat"><span class="ic" aria-hidden="true">🚚</span><h3>Helpers on moving day</h3><p class="muted small">Share the move with a six-letter code - no accounts. Helpers see every box and where it goes, and tick it off as it comes off the truck. Photos stay on your phone.</p></section>' +
      '<section class="card feat"><span class="ic" aria-hidden="true">🎄</span><h3>The loft, the garage, the unit</h3><p class="muted small">Storage boxes with a shelf and a season: “Holiday decorations · Loft left · Box 3”. Mark one taken out, and put it back in January.</p><button class="link-btn" type="button" data-act="tryloft" style="justify-self:start">See a made-up loft →</button></section>' +
      '<section class="card feat"><span class="ic" aria-hidden="true">🔎</span><h3>Search that forgives</h3><p class="muted small">“mug” finds Mugs, “ketle” finds the kettle, “14” opens Box 14. And when nothing matches, it says which boxes have nothing listed yet.</p></section>' +
      '</div>' +
      (dec ? '<p class="note small" style="margin-top:14px"><b>Decorations coming down soon?</b> Start a storage list as you bring the boxes out of the loft - next year, the lights are in Box 1, Loft left.</p>' : '');
  }

  /* ---------------- try it ---------------- */

  function startTry(kind) {
    state.trying = true;
    state.demo = kind === 'storage' ? C.sampleStorage(o()) : C.sampleMove(o());
    state.room = 'all'; state.tag = 'all';
    state.view = kind === 'storage' ? 'boxes' : 'day'; state.arg = '';
    if (location.hash) history.replaceState(null, '', BASE);
    draw(); scrollTo(0, 0);
    say(kind === 'storage' ? 'A made-up loft. Nothing is saved.' : 'A made-up move. Nothing is saved.');
  }
  function leaveTryQuiet() { state.trying = false; state.demo = null; }
  function leaveTry() { leaveTryQuiet(); state.room = 'all'; go(''); }

  /* ---------------- starting a move ---------------- */

  function viewNew(kind) {
    var storage = kind === 'storage';
    return '<div class="sec-head"><h1>' + (storage ? 'Storage boxes' : 'Start a move') + '</h1></div>' +
      '<form class="card fields" id="newForm" autocomplete="off">' +
      (storage
        ? '<label class="field"><span>What should we call it?</span><input class="input" name="name" maxlength="' + C.LIMITS.name + '" placeholder="The loft and garage"><span class="hint">A storage unit, the basement, Grandma’s attic - one list per place works best.</span></label>'
        : '<div class="fields two"><label class="field"><span>Moving from</span><input class="input" name="from" maxlength="' + C.LIMITS.place + '" placeholder="12 Larkfield Lane"></label><label class="field"><span>Moving to</span><input class="input" name="to" maxlength="' + C.LIMITS.place + '" placeholder="4 Harbour Row"></label></div>' +
          '<label class="field"><span>A short name for the labels <span class="hint">(optional)</span></span><input class="input" name="name" maxlength="' + C.LIMITS.name + '" placeholder="Our move"><span class="hint">Printed small at the foot of every label. Leave it empty and it’s made from the streets: “Larkfield → Harbour”.</span></label>') +
      '<div class="field"><span>Rooms to start with</span><div class="chips">' + C.DEFAULT_ROOMS[storage ? 'storage' : 'move'].map(function (r) { return '<span class="rband" style="--rc:' + C.colorHex(r[1]) + '">' + esc(r[0]) + '</span>'; }).join('') + '</div><span class="hint">Rename, recolour and add rooms any time under More.</span></div>' +
      '<p class="small muted" style="margin:0">It all stays on this phone. Share it with helpers later if you want to.</p>' +
      '<div class="row"><button class="btn big" type="submit">' + (storage ? 'Start the list' : 'Start the move') + '</button><button class="btn ghost" type="button" data-act="home">Cancel</button></div></form>';
  }
  function bindNew() {
    var f = $('#newForm'); if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (data.moves.length >= C.LIMITS.moves) { toast('This phone keeps up to ' + C.LIMITS.moves + ' moves and lists. Delete an old one first (More).', 4200); return; }
      var kind = state.view === 'newstorage' ? 'storage' : 'move';
      var m = C.newMove({ kind: kind, name: f.name.value, from: f.from ? f.from.value : '', to: f.to ? f.to.value : '' }, o());
      leaveTryQuiet();
      setMove(m);
      state.form = null;
      go('add');
      toast(kind === 'storage' ? 'Started. Add the first box.' : 'Started. Box 1 is next - the kitchen is always the most boxes.', 3600);
    });
  }

  /* ---------------- boxes ---------------- */

  function statusPill(b) { return '<span class="pill s-' + esc(b.status) + '">' + esc(C.statusLabel(b.status)) + '</span>'; }
  function flagPills(b, withValuables) {
    return b.flags.filter(function (f) { return withValuables || f !== 'valuables'; }).map(function (f) { return '<span class="pill f-pill f-' + esc(f) + '">' + esc(C.flagLabel(f)) + '</span>'; }).join('');
  }
  function tileHtml(m, b) {
    return '<button class="tile" type="button" data-act="open" data-id="' + esc(b.id) + '" style="--rc:' + esc(rc(m, b.room)) + '" aria-label="' + esc(C.boxLine(m, b) + '. ' + C.itemsLine(b.items, 6)) + '">' +
      '<span class="tband">' + esc(roomName(m, b.room)) + '</span><span class="tno">' + b.no + '</span>' +
      '<span class="tits">' + (m.kind === 'storage' && b.location ? '<b>' + esc(b.location) + '</b> · ' : '') + esc(C.itemsLine(b.items, 3)) + '</span>' +
      '<span class="tfoot">' + statusPill(b) + flagPills(b, true) + (b.photo ? '<span class="pill f-pill">📷</span>' : '') + '</span></button>';
  }
  function viewBoxes(m) {
    var counts = {};
    m.boxes.forEach(function (b) { counts[b.room] = (counts[b.room] || 0) + 1; });
    if (state.room !== 'all' && !C.roomOf(m, state.room)) state.room = 'all';
    var shown = m.boxes.filter(function (b) { return state.room === 'all' || b.room === state.room; });
    var out = '<div class="sec-head"><div><h1>' + esc(m.name) + '</h1><p class="muted" style="margin:2px 0 0">' + esc(C.summaryLine(m)) + (m.to ? ' · to ' + esc(m.to) : '') + '</p></div>' +
      (canEdit(m) ? '<button class="btn" type="button" data-act="add">+ Add a box</button>' : '') + '</div>';
    if (isHelper(m)) out += '<p class="note small">You’re helping' + (sharerName(m) ? ' ' + esc(sharerName(m)) : '') + '. Open a box - or scan its label - to mark it Loaded or Delivered.</p>';
    if (!m.boxes.length) {
      return out + '<section class="card empty"><div class="ic" aria-hidden="true">📦</div><p><b>No boxes yet.</b></p><p class="muted small">' + (m.kind === 'storage' ? 'Add each box as it goes up into the loft - what’s in it, and where it sits.' : 'Start with the kitchen - it’s always the most boxes. Each one takes about ten seconds.') + '</p>' +
        (canEdit(m) ? '<div class="row" style="justify-content:center"><button class="btn big" type="button" data-act="add">Add box 1</button><button class="btn ghost" type="button" data-act="tab" data-tab="more">Import a CSV</button></div>' : '') + '</section>';
    }
    out += '<form class="quickfind" id="quickFind" role="search" style="margin-bottom:10px"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg><input class="input" type="search" id="qf" placeholder="Find something - “kettle”, “14”…" aria-label="Find something in the boxes" enterkeyhint="search"></form>';
    out += '<div class="chips scroll" role="group" aria-label="Show the boxes for" style="margin-bottom:12px"><button class="chip" type="button" data-act="room" data-room="all" aria-pressed="' + (state.room === 'all') + '">All<span class="ct">' + m.boxes.length + '</span></button>' +
      m.rooms.filter(function (r) { return counts[r.id]; }).map(function (r) { return '<button class="chip" type="button" data-act="room" data-room="' + esc(r.id) + '" aria-pressed="' + (state.room === r.id) + '" style="--rc:' + esc(C.colorHex(r.color)) + '"><span class="dot"></span>' + esc(r.name) + '<span class="ct">' + counts[r.id] + '</span></button>'; }).join('') + '</div>';
    out += '<div class="tiles">' + shown.map(function (b) { return tileHtml(m, b); }).join('') + '</div>';
    return out;
  }
  function bindQuick() {
    var f = $('#quickFind'); if (!f) return;
    f.addEventListener('submit', function (e) { e.preventDefault(); state.q = $('#qf').value; go('find'); });
  }
  function sharerName(m) { var o2 = m.shared && (m.shared.members || []).find(function (x) { return x.role === 'owner'; }); return o2 ? o2.name : ''; }

  /* ---------------- one box ---------------- */

  function viewBox(m) {
    var b = C.boxOf(m, state.arg);
    if (!b) return '<section class="card empty"><div class="ic" aria-hidden="true">🤷</div><p><b>That box isn’t in this move any more.</b></p><button class="btn" type="button" data-act="tab" data-tab="boxes">See all the boxes</button></section>';
    var hits = state.found && state.found.id === b.id ? state.found.hits : [];
    var list = m.kind === 'storage' ? C.STATUS.storage : C.STATUS.move;
    var next = C.nextStatus(m.kind, b.status);
    var idx = m.boxes.indexOf(b), prev = m.boxes[idx - 1], nxt = m.boxes[idx + 1];
    var out = '<article class="card boxhead" style="--rc:' + esc(rc(m, b.room)) + '"><div class="bband">' + esc(roomName(m, b.room)) + '</div>' +
      '<div class="bno" aria-label="Box ' + b.no + '">' + b.no + '</div><div class="bmeta">' + statusPill(b) + '<div class="row" style="gap:4px">' + flagPills(b, true) + '</div>' +
      (b.statusAt ? '<span class="tiny muted">' + esc(C.statusLabel(b.status)) + (b.by ? ' by ' + esc(b.by) : '') + ' · ' + esc(timeOf(b.statusAt)) + '</span>' : '') + '</div></article>';
    out += '<div class="grid split" style="margin-top:12px"><div class="stack">';
    // The one tap a scanned label is for.
    out += '<section class="card stack" aria-labelledby="stT"><h2 id="stT">' + (m.kind === 'storage' ? 'Where is it now?' : 'Where is it now?') + '</h2>' +
      (next ? '<button class="btn big block go" type="button" data-act="status" data-id="' + esc(b.id) + '" data-s="' + esc(next) + '">' + esc(C.STATUS_ACT[next]) + ' ✓</button>' : '<p class="note small" style="margin:0">✓ Unpacked - this one’s done.</p>') +
      '<div class="statusbar' + (list.length === 2 ? ' two' : '') + '" role="group" aria-label="Status">' + list.map(function (s) { return '<button type="button" data-act="status" data-id="' + esc(b.id) + '" data-s="' + esc(s) + '" aria-pressed="' + (b.status === s) + '">' + esc(C.statusLabel(s)) + '</button>'; }).join('') + '</div>' +
      (shared(m) ? '<p class="tiny muted" style="margin:0">Everyone helping sees this change.</p>' : '') + '</section>';
    out += '<section class="card" aria-labelledby="ctT"><div class="sec-head"><h2 id="ctT">What’s in it' + (b.items.length ? ' · ' + b.items.length : '') + '</h2>' + (canEdit(m) ? '<button class="btn small ghost" type="button" data-act="edit" data-id="' + esc(b.id) + '">Edit</button>' : '') + '</div>' +
      (b.items.length ? '<ul class="contents">' + b.items.map(function (t) { var hit = hits.indexOf(t) >= 0; return '<li' + (hit ? ' class="hit"' : '') + '>' + esc(t) + '</li>'; }).join('') + '</ul>' : '<p class="muted">Nothing listed yet.' + (canEdit(m) ? ' Edit it to add what’s inside - or list it from a photo.' : '') + '</p>') +
      (b.note ? '<p class="note small" style="margin:10px 0 0;white-space:pre-line">' + esc(b.note) + '</p>' : '') +
      (b.flags.indexOf('valuables') >= 0 ? '<p class="note small" style="margin:10px 0 0">🔒 Valuables: keep this one with you. It isn’t printed on the label.</p>' : '') +
      (m.kind === 'storage' ? '<p style="margin:10px 0 0"><b>Where:</b> ' + esc(b.location || 'not set yet') + (b.tags.length ? ' · ' + b.tags.map(esc).join(', ') : '') + '</p>' : '') + '</section>';
    out += '</div><div class="stack">';
    out += '<div id="boxPhoto"></div>';
    out += '<section class="card stack"><h2>For this box</h2><div class="row">' +
      '<button class="btn ghost" type="button" data-act="printone" data-id="' + esc(b.id) + '">🖨 Print its label</button>' +
      (canEdit(m) && !state.trying ? '<button class="btn ai ghost" type="button" data-act="aibox" data-id="' + esc(b.id) + '"> List from a photo</button>' : '') +
      (canEdit(m) ? '<button class="btn danger" type="button" data-act="delbox" data-id="' + esc(b.id) + '">Delete</button>' : '') + '</div>' +
      (shared(m) ? '<p class="tiny muted" style="margin:0">Photos stay on the phone that took them.</p>' : '') + '</section>';
    out += '<div class="boxnav">' + (prev ? '<button class="btn small ghost" type="button" data-act="open" data-id="' + esc(prev.id) + '">← Box ' + prev.no + '</button>' : '<span></span>') + (nxt ? '<button class="btn small ghost" type="button" data-act="open" data-id="' + esc(nxt.id) + '">Box ' + nxt.no + ' →</button>' : '') + '</div>';
    out += '</div></div>';
    return out;
  }
  function loadBoxPhoto(m) {
    var b = C.boxOf(m, state.arg), el = $('#boxPhoto');
    if (!b || !el || !b.photo) return;
    photoGet(b.id).then(function (p) {
      if (!p || state.view !== 'box' || state.arg !== b.id) return;
      el.innerHTML = '<section class="card stack"><h2>The photo</h2><button class="photo-btn" type="button" data-act="photo" data-id="' + esc(b.id) + '" aria-label="See the photo of box ' + b.no + ' larger"><img alt="" src="' + esc(p.thumb) + '"></button><p class="tiny muted" style="margin:0">' + esc(PHOTO_LINE) + '</p></section>';
    });
  }
  function openPhoto(id) {
    photoGet(id).then(function (p) { if (p) sheet('<h2>The photo</h2><img class="photo-full" alt="The open box" src="' + esc(p.full) + '"><p class="tiny muted">' + esc(PHOTO_LINE) + '</p>'); });
  }
  function viewNoBox() {
    return '<section class="card empty"><div class="ic" aria-hidden="true">🏷️</div><h1 style="font-size:1.4rem">That box isn’t on this phone</h1><p class="muted">Its label was printed from another phone. Ask whoever packed it - or, if the move is shared, ask them for the code and join it.</p><div class="row" style="justify-content:center"><button class="btn" type="button" data-act="joinnew">Join with a code</button><button class="btn ghost" type="button" data-act="home">Home</button></div></section>';
  }

  /* ---------------- adding and editing a box ---------------- */

  function blankForm(m) {
    var last = prefs.lastRoom[m.id];
    return { no: C.nextNo(m), room: C.roomOf(m, last) ? last : m.rooms[0].id, items: [], flags: [], note: '', location: '', tags: [], photo: null, photoChanged: false, editing: null, noOpen: false };
  }
  function formFor(m, b) { return { no: b.no, room: b.room, items: b.items.slice(), flags: b.flags.slice(), note: b.note, location: b.location, tags: b.tags.slice(), photo: null, hadPhoto: b.photo, photoChanged: false, editing: b.id, noOpen: false }; }
  function viewForm(m) {
    if (!canEdit(m)) return '<p class="note">Only whoever shared the move can add or change boxes. You can mark them Loaded or Delivered.</p>';
    if (state.view === 'edit') { var b = C.boxOf(m, state.arg); if (!b) return viewBoxes(m); if (!state.form || state.form.editing !== b.id) state.form = formFor(m, b); }
    else if (!state.form || state.form.editing) state.form = blankForm(m);
    var f = state.form;
    var storage = m.kind === 'storage';
    var out = '<form id="boxForm" class="stack" autocomplete="off">' +
      '<div class="sec-head"><div class="bigno"><b id="fNoBig">Box ' + f.no + '</b><button class="link-btn" type="button" id="fNoToggle">' + (f.noOpen ? 'Keep it' : 'Change number') + '</button></div>' +
      '<button class="btn small ghost" type="button" data-act="' + (f.editing ? 'canceledit' : 'tab') + '" data-tab="boxes">Cancel</button></div>' +
      '<label class="field" id="fNoField"' + (f.noOpen ? '' : ' hidden') + '><span>Box number</span><input class="input no" id="fNo" inputmode="numeric" pattern="[0-9]*" value="' + f.no + '" aria-describedby="fNoHint"><span class="hint" id="fNoHint">Numbers already used are refused - so two boxes never share one.</span></label>' +
      '<section class="card stack"><div class="field"><span>Goes to</span><div class="chips" role="group" aria-label="Room" id="fRooms">' + roomChips(m, f.room) + '</div>' +
      '<details class="more"><summary>Add a room</summary><div class="addrow" style="margin-top:6px"><input class="input" id="fNewRoom" maxlength="' + C.LIMITS.room + '" placeholder="Nursery, Studio, Shed…" aria-label="New room’s name"><button class="btn ghost" type="button" id="fAddRoom">Add</button></div></details></div></section>' +
      '<section class="card stack"><div class="field"><span id="fItemsLabel">What’s in it</span>' +
      '<div class="itemchips" id="fItems" aria-live="polite"></div>' +
      '<div class="addrow"><input class="input" id="fItem" maxlength="' + (C.LIMITS.item * 4) + '" placeholder="Type a thing, press Enter" aria-labelledby="fItemsLabel" enterkeyhint="enter" autocapitalize="sentences"><button class="btn ghost" type="button" id="fItemAdd">Add</button></div>' +
      '<span class="hint">Several at once: “plates, bowls, mugs”.</span>' +
      '<div class="sugg" id="fSugg" aria-label="Suggestions"></div></div></section>' +
      '<section class="card stack"><div class="field"><span>Flags</span><div class="chips" role="group" aria-label="Flags" id="fFlags">' + C.FLAGS.map(function (fl) { return '<button class="chip" type="button" data-flag="' + fl.id + '" aria-pressed="' + (f.flags.indexOf(fl.id) >= 0) + '">' + esc(fl.label) + '</button>'; }).join('') + '</div>' +
      '<p class="hint" id="fValHint"' + (f.flags.indexOf('valuables') >= 0 ? '' : ' hidden') + '>🔒 Keep valuables with you, not on the truck. This flag is never printed on the label - a label that says “valuables” tells everyone on the pavement which box to take.</p>' +
      '<p class="hint" id="fOpenHint"' + (f.flags.indexOf('openfirst') >= 0 ? '' : ' hidden') + '>The first night’s box: kettle, mugs, chargers, toilet roll, snacks, medicines, bedding, towels. It is pinned at the top of moving day.</p></div></section>';
    if (storage) {
      var locs = C.locationsUsed(m);
      out += '<section class="card stack"><label class="field"><span>Where it sits</span><input class="input" id="fLoc" maxlength="' + C.LIMITS.location + '" list="fLocs" value="' + esc(f.location) + '" placeholder="Loft left, Garage shelf 2, Bay 4"><datalist id="fLocs">' + locs.map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist></label>' +
        '<div class="field"><span>Season or kind</span><div class="chips" role="group" aria-label="Tags" id="fTags">' + tagChips(m, f.tags) + '</div></div></section>';
    }
    out += '<section class="card stack"><div class="field"><span>A photo of the open box <span class="hint">(optional)</span></span><div class="row" id="fPhotoRow"></div><p class="tiny muted" style="margin:0">' + esc(PHOTO_LINE) + '</p></div>' +
      '<label class="field"><span>Note <span class="hint">(optional)</span></span><textarea class="input" id="fNote" maxlength="' + C.LIMITS.note + '" placeholder="Lid taped twice. Goes on the top shelf.">' + esc(f.note) + '</textarea></label></section>' +
      '<div id="fErr"></div>' +
      '<div class="save-bar">' + (f.editing ? '<button class="btn" type="submit">Save changes</button><button class="btn ghost" type="button" data-act="canceledit">Cancel</button>' : '<button class="btn" type="submit" id="fSave">Save box ' + f.no + '</button><button class="btn soft" type="button" id="fSaveNext">Save, add ' + (f.no + 1) + '</button>') + '</div>' +
      '</form>';
    return out;
  }
  function roomChips(m, sel) {
    return m.rooms.map(function (r) { return '<button class="chip" type="button" data-room-pick="' + esc(r.id) + '" aria-pressed="' + (sel === r.id) + '" style="--rc:' + esc(C.colorHex(r.color)) + '"><span class="dot"></span>' + esc(r.name) + '</button>'; }).join('');
  }
  function tagChips(m, sel) {
    var all = C.TAGS.slice();
    C.whereView(m).tags.forEach(function (t) { if (!all.some(function (x) { return C.norm(x) === C.norm(t.tag); })) all.push(t.tag); });
    sel.forEach(function (t) { if (!all.some(function (x) { return C.norm(x) === C.norm(t); })) all.push(t); });
    return all.map(function (t) { var on = sel.some(function (x) { return C.norm(x) === C.norm(t); }); return '<button class="chip" type="button" data-tag-pick="' + esc(t) + '" aria-pressed="' + on + '">' + esc(t) + '</button>'; }).join('');
  }
  function bindForm(m) {
    var form = $('#boxForm'); if (!form) return;
    var f = state.form;
    var input = $('#fItem');
    function drawItems() {
      $('#fItems').innerHTML = f.items.map(function (t, i) { return '<span class="itemchip"><span>' + esc(t) + '</span><button type="button" data-rm="' + i + '" aria-label="Remove ' + esc(t) + '">×</button></span>'; }).join('');
      drawSugg();
    }
    function drawSugg() {
      var room = C.roomOf(m, f.room);
      var s = C.suggestItems(m, input.value, f.items, room, input.value ? 6 : 8);
      if (!input.value && f.flags.indexOf('openfirst') >= 0) s = C.OPEN_FIRST_IDEAS.filter(function (t) { return !f.items.some(function (x) { return C.itemKey(x) === C.itemKey(t); }); }).slice(0, 8);
      $('#fSugg').innerHTML = s.map(function (t) { return '<button type="button" data-sugg="' + esc(t) + '">' + esc(t) + '</button>'; }).join('');
    }
    function add(text) {
      var before = f.items.length;
      f.items = C.addItems(f.items, text);
      if (f.items.length >= C.LIMITS.items && before < C.LIMITS.items) toast('A box lists up to ' + C.LIMITS.items + ' things.');
      drawItems();
    }
    function drawPhoto() {
      var row = $('#fPhotoRow');
      var show = function (thumb) {
        row.innerHTML = (thumb ? '<img class="thumb" alt="The photo of this box" src="' + esc(thumb) + '">' : '') +
          '<label class="btn ghost file-btn">' + (thumb ? '📷 Another photo' : '📷 Take or choose a photo') + '<input class="vh" id="fFile" type="file" accept="image/*" capture="environment"></label>' +
          (thumb ? '<button class="btn small ghost" type="button" id="fPhotoRm">Remove</button>' : '') +
          (!state.trying ? '<button class="btn ai soft" type="button" id="fAi"> List what’s in it</button>' : '');
        $('#fFile', row).addEventListener('change', function (e) {
          var file = e.target.files[0]; if (!file) return;
          prepPhoto(file).then(function (p) { f.photo = p; f.photoChanged = true; drawPhoto(); }).catch(function (err) { showError(err, $('#fErr')); });
        });
        var rm = $('#fPhotoRm', row);
        if (rm) rm.addEventListener('click', function () { f.photo = null; f.hadPhoto = false; f.photoChanged = true; drawPhoto(); });
        var aiB = $('#fAi', row);
        if (aiB) aiB.addEventListener('click', function () { openAi({ form: true }); });
      };
      if (f.photo) return show(f.photo.thumb);
      if (f.editing && f.hadPhoto && !f.photoChanged) return photoGet(f.editing).then(function (p) { if (p) f.photo = p; show(p ? p.thumb : ''); });
      show('');
    }
    drawItems(); drawPhoto();
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) { add(input.value); input.value = ''; drawSugg(); } }
      else if (e.key === 'Backspace' && !input.value && f.items.length) { f.items.pop(); drawItems(); }
    });
    input.addEventListener('input', function () {
      if (/[,;\n]\s*$/.test(input.value)) { add(input.value); input.value = ''; }
      drawSugg();
    });
    $('#fItemAdd').addEventListener('click', function () { if (input.value.trim()) { add(input.value); input.value = ''; } input.focus(); });
    $('#fItems').addEventListener('click', function (e) { var b = e.target.closest('[data-rm]'); if (!b) return; f.items.splice(Number(b.getAttribute('data-rm')), 1); drawItems(); input.focus(); });
    $('#fSugg').addEventListener('click', function (e) { var b = e.target.closest('[data-sugg]'); if (!b) return; add(b.getAttribute('data-sugg')); input.focus(); });
    $('#fRooms').addEventListener('click', function (e) {
      var b = e.target.closest('[data-room-pick]'); if (!b) return;
      f.room = b.getAttribute('data-room-pick');
      $$('[data-room-pick]', form).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      drawSugg();
    });
    $('#fAddRoom').addEventListener('click', function () {
      var name = $('#fNewRoom').value;
      try {
        var r = C.addRoom(m, { name: name }, rand);
        if (r.move !== m) { if (!saveRooms(m, r.move.rooms)) return; m = cur(); }
        f.room = r.room.id;
        $('#fRooms').innerHTML = roomChips(m, f.room);
        $('#fNewRoom').value = '';
        drawSugg();
      } catch (err) { showError(err, $('#fErr')); }
    });
    $('#fFlags').addEventListener('click', function (e) {
      var b = e.target.closest('[data-flag]'); if (!b) return;
      var id = b.getAttribute('data-flag'), i = f.flags.indexOf(id);
      if (i >= 0) f.flags.splice(i, 1); else f.flags.push(id);
      b.setAttribute('aria-pressed', String(i < 0));
      $('#fValHint').hidden = f.flags.indexOf('valuables') < 0;
      $('#fOpenHint').hidden = f.flags.indexOf('openfirst') < 0;
      drawSugg();
    });
    var tags = $('#fTags');
    if (tags) tags.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tag-pick]'); if (!b) return;
      var t = b.getAttribute('data-tag-pick'), on = f.tags.some(function (x) { return C.norm(x) === C.norm(t); });
      f.tags = on ? f.tags.filter(function (x) { return C.norm(x) !== C.norm(t); }) : C.cleanTags(f.tags.concat([t]));
      b.setAttribute('aria-pressed', String(!on));
    });
    $('#fNoToggle').addEventListener('click', function () {
      f.noOpen = !f.noOpen;
      $('#fNoField').hidden = !f.noOpen;
      this.textContent = f.noOpen ? 'Keep it' : 'Change number';
      if (f.noOpen) $('#fNo').focus();
    });
    $('#fNo').addEventListener('input', function () {
      var n = C.intIn(this.value, 1, C.LIMITS.boxNo);
      if (n) { f.no = n; $('#fNoBig').textContent = 'Box ' + n; var s = $('#fSave'); if (s) s.textContent = 'Save box ' + n; var s2 = $('#fSaveNext'); if (s2) s2.textContent = 'Save, add ' + (n + 1); }
    });
    var note = $('#fNote'); note.addEventListener('input', function () { f.note = note.value; });
    var loc = $('#fLoc'); if (loc) loc.addEventListener('input', function () { f.location = loc.value; });
    form.addEventListener('submit', function (e) { e.preventDefault(); if (input.value.trim()) { add(input.value); input.value = ''; } saveForm(m, false); });
    var nextB = $('#fSaveNext');
    if (nextB) nextB.addEventListener('click', function () { if (input.value.trim()) { add(input.value); input.value = ''; } saveForm(m, true); });
    if (!f.editing && !f.items.length) setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }, 60);
  }
  function saveForm(m, again) {
    var f = state.form, errBox = $('#fErr');
    errBox.innerHTML = '';
    var input = { no: f.no, room: f.room, items: f.items, flags: f.flags, note: f.note, location: f.location, tags: f.tags };
    prefs.lastRoom[m.id] = f.room; savePrefs();
    var done = function (box) {
      var p = Promise.resolve();
      if (f.photoChanged) p = f.photo ? photoPut(box.id, f.photo) : photoDel(box.id);
      p.then(function () {
        var room = roomName(cur(), box.room);
        if (again) {
          state.form = blankForm(cur()); state.form.room = box.room;
          draw(); scrollTo(0, 0);
          toast('Box ' + box.no + ' saved · ' + room + '. Now box ' + state.form.no + '.', 2600);
        } else { state.form = null; go('box/' + box.id); toast(f.editing ? 'Saved.' : 'Box ' + box.no + ' saved · ' + room + '.'); }
      });
    };
    var hasPhoto = f.photo ? true : (f.editing ? Boolean(f.hadPhoto && !f.photoChanged) : false);
    if (f.editing) editBoxNow(m, C.boxOf(m, f.editing), Object.assign(input, { photo: hasPhoto })).then(done).catch(function (err) { showError(err, errBox); });
    else addBoxNow(m, Object.assign(input, { photo: hasPhoto })).then(done).catch(function (err) { showError(err, errBox); });
  }

  /* ---------------- writes: on this phone, or to a shared move ---------------- */

  /** A shared move's request. A move that has gone (stopped, expired, or
   *  this phone was removed) turns back into this phone's own copy - or,
   *  for a helper, leaves the phone. */
  function sharedApi(m, method, path, body) {
    return api(method, 'api/m/' + m.shared.id + path, body).catch(function (err) {
      if (err.status === 0) { draw(); err.message = 'Changing a shared move needs the internet. This is the copy from ' + timeOf(m.shared.at || now()) + '.'; }
      if (err.status === 404 && err.data && err.data.code === 'gone') sharedGone(m);
      throw err;
    });
  }
  function sharedGone(m) {
    var live = data.moves.find(function (x) { return x.id === m.id; });
    if (!live) return;
    if (live.shared.role === 'owner') {
      delete live.shared; saveLocal();
      toast('Sharing has ended for ' + live.name + '. Your boxes are still here - share it again to invite helpers.', 5200);
    } else {
      removeMove(live.id);
      toast('You’re no longer helping with ' + live.name + '. It was taken off this phone.', 5200);
      go('');
    }
  }
  /** Merge one box the server sent into this phone's copy (its photo flag
   *  is this phone's own), and move the version only if nothing else moved
   *  in between. */
  function mergeBox(m, box, r) {
    var live = cur(); if (!live || live.id !== m.id) live = data.moves.find(function (x) { return x.id === m.id; });
    if (!live) return null;
    var old = C.boxOf(live, box.id);
    var b = C.cleanBox(Object.assign({}, box, { photo: old ? old.photo : false }), live, o());
    var next = C.putBox(live, b);
    if (r && next.shared && next.shared.v === r.was) next.shared.v = r.v;
    setMove(next);
    return b;
  }
  function mergeView(m, view) {
    var live = data.moves.find(function (x) { return x.id === m.id; }) || m;
    var photos = {};
    live.boxes.forEach(function (b) { if (b.photo) photos[b.id] = true; });
    var next = C.cleanMove({
      id: live.id, kind: view.kind, name: view.name, from: view.from, to: view.to, rooms: view.rooms,
      boxes: view.boxes.map(function (b) { return Object.assign({}, b, { photo: Boolean(photos[b.id]) }); }),
      nextNo: view.nextNo, createdAt: live.createdAt, updatedAt: live.updatedAt, printedAt: live.printedAt,
      shared: { id: live.shared ? live.shared.id : m.shared.id, role: view.role, code: view.code, v: view.v, at: now(), members: view.members },
    }, o());
    if (!next) return live;
    var i = data.moves.findIndex(function (x) { return x.id === live.id; });
    if (i >= 0) data.moves[i] = next; else data.moves.unshift(next);
    saveLocal();
    return next;
  }
  var refreshing = null;
  function refreshShared(m) {
    if (!shared(m) || refreshing) return refreshing || Promise.resolve();
    refreshing = api('GET', 'api/m/' + m.shared.id + '?since=' + (m.shared.v || 0)).then(function (r) {
      if (r.same) { var live = data.moves.find(function (x) { return x.id === m.id; }); if (live) { live.shared.at = now(); saveLocal(); } return false; }
      mergeView(m, r.move);
      return true;
    }).catch(function (err) {
      if (err.status === 404 && err.data && err.data.code === 'gone') sharedGone(m);
      return false;
    }).then(function (changed) { refreshing = null; return changed; });
    return refreshing;
  }
  function addBoxNow(m, input) {
    if (shared(m)) {
      var body = C.shareBox(Object.assign({ id: '', status: '' }, input));
      delete body.id; delete body.status;
      return sharedApi(m, 'POST', '/box', body).then(function (r) { return mergeBox(m, r.box, r); });
    }
    try {
      var box = C.newBox(m, input, o()).box;
      setMove(C.putBox(m, box));
      return Promise.resolve(box);
    } catch (err) { return Promise.reject(err); }
  }
  function editBoxNow(m, b, input) {
    if (!b) return Promise.reject(new Error('That box isn’t in this move any more.'));
    if (shared(m)) {
      var body = {};
      ['no', 'room', 'items', 'flags', 'note', 'location', 'tags'].forEach(function (k) { if (input[k] !== undefined && JSON.stringify(input[k]) !== JSON.stringify(b[k])) body[k] = input[k]; });
      var photo = input.photo;
      var setPhoto = function (box) { var live = data.moves.find(function (x) { return x.id === m.id; }); var bb = live && C.boxOf(live, box.id); if (bb && bb.photo !== photo) { setMove(C.putBox(live, Object.assign({}, bb, { photo: photo }))); } return C.boxOf(cur(), box.id) || box; };
      if (!Object.keys(body).length) return Promise.resolve(setPhoto(b));
      return sharedApi(m, 'PATCH', '/box/' + b.id, body).then(function (r) { return setPhoto(mergeBox(m, r.box, r)); });
    }
    try {
      var next = C.editBox(m, b, input, o());
      setMove(C.putBox(m, next));
      return Promise.resolve(next);
    } catch (err) { return Promise.reject(err); }
  }
  function setStatusNow(m, b, status) {
    if (shared(m)) return sharedApi(m, 'PUT', '/box/' + b.id + '/status', { status: status }).then(function (r) { return mergeBox(m, r.box, r); });
    try {
      var next = C.setStatus(m, b, status, o());
      setMove(C.putBox(m, next));
      return Promise.resolve(next);
    } catch (err) { return Promise.reject(err); }
  }
  function deleteBoxNow(m, b) {
    var drop = function () { var live = state.trying ? state.demo : data.moves.find(function (x) { return x.id === m.id; }); if (live) setMove(C.dropBox(live, b.id)); photoDel(b.id); };
    if (shared(m)) return sharedApi(m, 'DELETE', '/box/' + b.id).then(drop);
    drop();
    return Promise.resolve();
  }
  /** Rooms are the move's own on this phone, or the shared move's (owner). */
  function saveRooms(m, rooms) {
    if (shared(m)) {
      sharedApi(m, 'PATCH', '', { rooms: rooms }).then(function (r) { mergeView(m, r.move); draw(); }).catch(function (err) { showError(err); });
      var tmp = C.clone(m); tmp.rooms = rooms; setMove(tmp);
      return true;
    }
    var next = C.clone(m); next.rooms = rooms; setMove(next);
    return true;
  }

  /* ---------------- find ---------------- */

  function viewFind(m) {
    var used = C.wordsUsed(m).slice(0, 8);
    return '<div class="sec-head"><h1>Find it</h1></div>' +
      '<form role="search" id="findForm"><label class="vh" for="findQ">Find something in the boxes</label><input class="input bigsearch" type="search" id="findQ" value="' + esc(state.q) + '" placeholder="kettle, passports, 14…" enterkeyhint="search" autocomplete="off"></form>' +
      '<div id="findOut" style="margin-top:12px"></div>' +
      (used.length ? '<div id="findTry" style="margin-top:14px"><p class="lab">Try</p><div class="chips">' + used.map(function (w) { return '<button class="chip" type="button" data-act="findword" data-w="' + esc(w.text) + '">' + esc(w.text) + '</button>'; }).join('') + '</div></div>' : '');
  }
  function resultHtml(m, r) {
    var b = r.box, others = b.items.filter(function (t) { return !r.hits.some(function (h) { return h.field === 'item' && h.text === t; }); });
    var hitItems = r.hits.filter(function (h) { return h.field === 'item'; }).map(function (h) { return '<b>' + esc(h.text) + '</b>'; });
    var why = r.hits.filter(function (h) { return h.field === 'note' || h.field === 'location' || h.field === 'tag'; }).map(function (h) { return esc(h.text); });
    var rest = others.slice(0, 4).map(esc);
    var line = hitItems.concat(rest).join(', ') + (others.length > 4 ? ' +' + (others.length - 4) : '');
    return '<button class="result" type="button" data-act="openfound" data-id="' + esc(b.id) + '" style="--rc:' + esc(rc(m, b.room)) + '"><span class="rno" aria-hidden="true">' + b.no + '</span><span><span class="rline">' + esc(C.boxLine(m, b)) + (m.kind === 'storage' && b.location ? ' · ' + esc(b.location) : '') + '</span>' +
      '<span class="rhits">' + (line || 'Nothing listed yet') + (why.length ? ' · ' + why.join(' · ') : '') + '</span></span></button>';
  }
  function drawFound(m) {
    var out = $('#findOut'); if (!out) return;
    var q = state.q.trim();
    var tryBox = $('#findTry'); if (tryBox) tryBox.hidden = Boolean(q);
    if (!q) { out.innerHTML = '<p class="muted">Search the contents, rooms and notes of all ' + plural(m.boxes.length, 'box', 'boxes') + '. Plurals, accents and small typos are fine.</p>'; return; }
    var rs = C.search(m, q);
    if (!rs.length) {
      var un = C.unlisted(m);
      out.innerHTML = '<section class="card"><p><b>Nothing listed as “' + esc(q) + '”.</b></p>' +
        (un.length ? '<p class="muted small">It might be in a box with nothing listed yet: ' + un.slice(0, 10).map(function (b) { return '<button class="link-btn" type="button" data-act="open" data-id="' + esc(b.id) + '">Box ' + b.no + ' (' + esc(roomName(m, b.room)) + ')</button>'; }).join(', ') + '.</p>' : '<p class="muted small">Every box has its contents listed - try another word.</p>') + '</section>';
      return;
    }
    out.innerHTML = '<p class="lab">' + plural(rs.length, 'box', 'boxes') + '</p>' + rs.slice(0, 60).map(function (r) { return resultHtml(m, r); }).join('');
    state.lastResults = rs;
  }
  function bindFind(m) {
    var q = $('#findQ');
    q.addEventListener('input', function () { state.q = q.value; drawFound(m); });
    $('#findForm').addEventListener('submit', function (e) { e.preventDefault(); var first = $('.result'); if (first) first.click(); });
    drawFound(m);
    setTimeout(function () { try { q.focus({ preventScroll: true }); var n = q.value.length; q.setSelectionRange(n, n); } catch (e) { /* ignore */ } }, 40);
  }

  /* ---------------- moving day ---------------- */

  // The one-tap step on a row: a tick for the move's steps, words for storage.
  var ROW_ACT = { packed: 'Packed ✓', loaded: 'Loaded ✓', delivered: 'Delivered ✓', unpacked: 'Unpacked ✓', out: 'Take out', stored: 'Put back' };
  function rowHtml(m, b, opts) {
    var next = C.nextStatus(m.kind, b.status);
    var act = opts && opts.to ? opts.to : next;
    return '<div class="brow" style="--rc:' + esc(rc(m, b.room)) + '"><button class="bn" type="button" data-act="open" data-id="' + esc(b.id) + '" aria-label="Open box ' + b.no + '">' + b.no + '</button>' +
      '<span class="bt"><b>' + esc(roomName(m, b.room)) + '</b><small><span class="st">' + esc(C.statusLabel(b.status)) + (b.by ? ' by ' + esc(b.by) : '') + '</span> · ' + esc(C.itemsLine(b.items, 3)) + '</small></span>' +
      (act && act !== b.status ? '<button class="btn small soft" type="button" data-act="status" data-id="' + esc(b.id) + '" data-s="' + esc(act) + '" aria-label="' + esc(C.STATUS_ACT[act] + ': box ' + b.no) + '">' + esc(ROW_ACT[act] || C.statusLabel(act)) + '</button>' : '<span class="pill s-' + esc(b.status) + '">✓</span>') + '</div>';
  }
  function bar(c) {
    var t = Math.max(1, c.total);
    var w = function (n) { return (n / t * 100).toFixed(1) + '%'; };
    return '<div class="stackbar" role="img" aria-label="' + esc(c.arrived + ' of ' + c.total + ' delivered, ' + c.loaded + ' on the truck') + '"><i class="unpacked" style="width:' + w(c.unpacked) + '"></i><i class="delivered" style="width:' + w(c.arrived - c.unpacked) + '"></i><i class="loaded" style="width:' + w(c.loaded) + '"></i></div>';
  }
  function viewDay(m) {
    var d = C.dayCounts(m);
    if (!d.total) return '<div class="sec-head"><h1>Moving day</h1></div><section class="card empty"><div class="ic" aria-hidden="true">🚚</div><p><b>Add some boxes first.</b></p><p class="muted small">On the day, this page counts every room as the boxes come off the truck.</p>' + (canEdit(m) ? '<button class="btn" type="button" data-act="add">Add a box</button>' : '') + '</section>';
    var all = { total: d.total, arrived: d.arrived, unpacked: m.boxes.filter(function (b) { return b.status === 'unpacked'; }).length, loaded: d.missing.length };
    var out = '<div class="sec-head"><h1>Moving day</h1>' + (m.to ? '<span class="muted small">to ' + esc(m.to) + '</span>' : '') + '</div>';
    out += '<div class="grid split"><div class="stack">';
    out += d.done ? '<section class="donecard"><div style="font-size:2rem" aria-hidden="true">🎉</div><h2>Every box is in the new place.</h2><p>' + esc(d.line) + '. Put the kettle on - it’s in ' + esc(kettleBox(m)) + '.</p></section>'
      : '<section class="card progress"><span class="big">' + d.arrived + ' <span class="muted" style="font-size:1.2rem;font-weight:800">of ' + d.total + '</span></span><span style="font-weight:800">boxes in the new place</span>' + bar(all) +
        '<div class="legend"><span class="unpacked">Unpacked ' + all.unpacked + '</span><span class="delivered">Delivered ' + (all.arrived - all.unpacked) + '</span><span class="loaded">On the truck ' + all.loaded + '</span><span>Not loaded ' + d.notLoaded.length + '</span></div></section>';
    out += '<form class="card jump" id="jump"><label class="vh" for="jumpNo">Box number</label><input class="input" id="jumpNo" inputmode="numeric" pattern="[0-9]*" placeholder="Go to box number…"><button class="btn" type="submit">Open</button></form>';
    if (d.openFirst.length) {
      out += '<section class="card" aria-labelledby="ofT"><h2 id="ofT">📌 Open first</h2><p class="muted small">The first night’s boxes - beds, the kettle, chargers. Find these before anything else.</p>' + d.openFirst.map(function (b) { return rowHtml(m, b); }).join('') + '</section>';
    }
    if (d.missing.length) {
      out += '<section class="card alertcard" aria-labelledby="msT"><h2 id="msT">Loaded but not delivered · ' + d.missing.length + '</h2><p class="muted small">On the truck - or missing. Once the truck is empty, these are the ones to look for.</p>' + d.missing.map(function (b) { return rowHtml(m, b, { to: 'delivered' }); }).join('') + '</section>';
    }
    out += '</div><div class="stack">';
    out += '<section class="card" aria-labelledby="rmT"><h2 id="rmT">Room by room</h2>' + d.rooms.map(function (c) {
      return '<div class="rrow' + (c.arrived === c.total ? ' done' : '') + '" style="--rc:' + esc(C.colorHex(c.room.color)) + '"><div class="rh"><span class="row" style="gap:8px"><span class="dot"></span>' + esc(c.line) + '</span></div>' + bar(c) +
        '<details class="more"><summary>' + plural(c.total, 'box', 'boxes') + '</summary>' + c.boxes.map(function (b) { return rowHtml(m, b); }).join('') + '</details></div>';
    }).join('') + '</section>';
    if (d.notLoaded.length) out += '<section class="card" aria-labelledby="nlT"><h2 id="nlT">Not loaded yet · ' + d.notLoaded.length + '</h2>' + d.notLoaded.map(function (b) { return rowHtml(m, b, { to: 'loaded' }); }).join('') + '</section>';
    out += '<p class="note small">📷 <b>Scanning:</b> point any phone’s camera at a label - it opens that box here, with Delivered one tap away.' + (shared(m) ? ' Helpers who have joined see the same box.' : ' Share the move (More) so helpers can scan too.') + '</p>';
    out += '</div></div>';
    return out;
  }
  function kettleBox(m) { var r = C.search(m, 'kettle')[0]; return r ? 'Box ' + r.box.no : 'one of the open-first boxes'; }
  function bindJump(m) {
    var f = $('#jump'); if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var n = C.intIn($('#jumpNo').value, 1, C.LIMITS.boxNo), b = n && C.boxByNo(m, n);
      if (b) go('box/' + b.id); else toast(n ? 'There’s no box ' + n + ' in this move.' : 'Type a box number.');
    });
  }

  /* ---------------- storage: what's where ---------------- */

  function viewWhere(m) {
    var w = C.whereView(m);
    if (!m.boxes.length) return '<div class="sec-head"><h1>What’s where</h1></div><section class="card empty"><p><b>No boxes yet.</b></p><p class="muted small">Give each box a place - “Loft left”, “Garage shelf 2” - and this page groups them.</p>' + (canEdit(m) ? '<button class="btn" type="button" data-act="add">Add a box</button>' : '') + '</section>';
    var tagOk = function (b) { return state.tag === 'all' || b.tags.some(function (t) { return C.norm(t) === C.norm(state.tag); }); };
    var out = '<div class="sec-head"><h1>What’s where</h1><span class="muted small">' + esc(C.summaryLine(m)) + '</span></div>';
    if (w.tags.length) out += '<div class="chips scroll" role="group" aria-label="Show" style="margin-bottom:12px"><button class="chip" type="button" data-act="tag" data-tag="all" aria-pressed="' + (state.tag === 'all') + '">All</button>' + w.tags.map(function (t) { return '<button class="chip" type="button" data-act="tag" data-tag="' + esc(t.tag) + '" aria-pressed="' + (C.norm(state.tag) === C.norm(t.tag)) + '">' + esc(t.tag) + '<span class="ct">' + t.n + '</span></button>'; }).join('') + '</div>';
    out += '<div class="grid two">';
    if (w.out.filter(tagOk).length) out += '<section class="card alertcard"><h2>Taken out · ' + w.out.filter(tagOk).length + '</h2><p class="muted small">Out of storage right now. Put them back when you’re done.</p>' + w.out.filter(tagOk).map(function (b) { return rowHtml(m, b, { to: 'stored' }); }).join('') + '</section>';
    w.places.forEach(function (p) {
      var bs = p.boxes.filter(tagOk); if (!bs.length) return;
      out += '<section class="card place"><h2>' + esc(p.name) + '</h2>' + bs.map(function (b) { return rowHtml(m, b); }).join('') + '</section>';
    });
    var none = w.none.filter(tagOk);
    if (none.length) out += '<section class="card"><h2>No place yet · ' + none.length + '</h2><p class="muted small">Edit a box to say where it sits.</p>' + none.map(function (b) { return rowHtml(m, b); }).join('') + '</section>';
    return out + '</div>';
  }

  /* ---------------- labels and signs ---------------- */

  function boxUrlFor(m, b) { return C.boxUrl(ORIGIN, BASE, m, b); }
  function labelBoxes(m) {
    var L = state.labels;
    if (L.which === 'one') { var b = C.boxOf(m, L.one); return b ? [b] : []; }
    if (L.which === 'new') return m.boxes.filter(function (b) { return !m.printedAt || b.createdAt > m.printedAt; });
    if (L.which === 'room') return m.boxes.filter(function (b) { return b.room === L.room; });
    return m.boxes;
  }
  function bandSvg(text, hex, w, h, fit, cls) {
    return '<svg class="' + (cls || 'lband') + '" viewBox="0 0 ' + w + ' ' + h + '" style="width:' + w + 'mm;height:' + h + 'mm" role="img" aria-label="' + esc(text) + '"><rect width="' + w + '" height="' + h + '" rx="' + (h * 0.12).toFixed(1) + '" fill="' + esc(hex) + '"/>' +
      '<text x="' + (w / 2).toFixed(1) + '" y="' + (h / 2).toFixed(1) + '" dominant-baseline="central" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-weight="900" font-size="' + fit.size + '" letter-spacing="' + (fit.size * 0.05).toFixed(2) + '" fill="#ffffff"' + (fit.squeeze ? ' textLength="' + fit.width + '" lengthAdjust="spacingAndGlyphs"' : '') + '>' + esc(text) + '</text></svg>';
  }
  function labelHtml(m, b, g) {
    var L = C.labelFor(m, b, g, { contents: prefs.contents, url: boxUrlFor(m, b) });
    var qr = QR ? QR.svg(L.url, 'QR code that opens box ' + b.no) : '';
    return '<div class="lbl" style="width:' + g.w + 'mm;height:' + g.h + 'mm;padding:' + g.pad + 'mm;row-gap:' + g.row + 'mm">' +
      '<div class="lno" style="font-size:' + L.num + 'mm"><small style="font-size:' + g.small + 'mm">Box</small>' + L.no + '</div>' +
      '<div class="lqr" style="width:' + g.qr + 'mm;height:' + g.qr + 'mm">' + qr + '</div>' +
      bandSvg(L.roomText, L.color, L.bandW, g.band, L.band) +
      '<div class="lflags" style="font-size:' + g.flag + 'mm">' + L.flags.map(function (f) { return '<b>' + esc(f) + '</b>'; }).join('') + '</div>' +
      '<div class="litems" style="font-size:' + g.item + 'mm">' + esc(L.items) + '</div>' +
      '<div class="lfoot" style="font-size:' + g.foot + 'mm"><span>' + esc(L.move) + '</span><span>' + esc(L.room) + ' · Box ' + L.no + '</span></div></div>';
  }
  function sheetsHtml(m, boxes, g) {
    var out = '';
    for (var i = 0; i < boxes.length; i += g.per) {
      out += '<div class="sheetp" style="width:' + g.innerW + 'mm;height:' + g.innerH + 'mm;grid-template-columns:repeat(' + g.cols + ',' + g.w + 'mm);grid-template-rows:repeat(' + g.rows + ',' + g.h + 'mm);gap:' + g.gap + 'mm">' +
        boxes.slice(i, i + g.per).map(function (b) { return labelHtml(m, b, g); }).join('') + '</div>';
    }
    return out;
  }
  function signHtml(m, room) {
    var s = C.signFor(m, room, prefs.paper), g = C.labelGrid(prefs.paper, 2);
    var nameFit = C.bandFit(s.name, s.w, 60);
    return '<div class="sheetp sign" style="width:' + g.innerW + 'mm;height:' + g.innerH + 'mm">' +
      bandSvg(s.text, s.color, s.w, s.bandH, s.band, 'sband') +
      '<div class="sname" style="font-size:' + Math.min(34, nameFit.size).toFixed(1) + 'mm">' + esc(s.name) + '</div>' +
      '<div class="swhat">Boxes with this colour and name go in here.</div>' +
      (s.count ? '<div class="snos">' + (s.count === 1 ? 'Box ' : 'Boxes ') + esc(C.rangeLine(s.nos)) + '</div><div class="stick"><p>Tick each one off as it arrives:</p><div class="sgrid">' + s.nos.slice(0, 60).map(function (n) { return '<span><i></i>' + n + '</span>'; }).join('') + '</div>' + (s.count > 60 ? '<p>… and ' + (s.count - 60) + ' more</p>' : '') + '</div>' : '') +
      '<div class="sfoot">' + esc(s.move) + ' · ' + plural(s.count, 'box', 'boxes') + '</div></div>';
  }
  function viewLabels(m) {
    var L = state.labels;
    if (L.which === 'room' && !C.roomOf(m, L.room)) L.room = m.rooms[0].id;
    var g = C.labelGrid(prefs.paper, prefs.per);
    var boxes = labelBoxes(m);
    var pages = Math.ceil(boxes.length / g.per);
    var since = m.printedAt ? m.boxes.filter(function (b) { return b.createdAt > m.printedAt; }).length : m.boxes.length;
    var seg = function (key, val, cur2, words) { return '<button type="button" data-act="lopt" data-k="' + esc(key) + '" data-v="' + esc(val) + '" aria-pressed="' + (String(cur2) === String(val)) + '">' + esc(words) + '</button>'; };
    var out = '<div class="sec-head"><h1>Labels</h1><span class="muted small">' + plural(m.boxes.length, 'box', 'boxes') + '</span></div>';
    out += '<div class="grid split"><div class="stack">';
    out += '<section class="card stack"><div class="field"><span>Paper</span><div class="seg" role="group" aria-label="Paper">' + seg('paper', 'letter', prefs.paper, 'Letter') + seg('paper', 'a4', prefs.paper, 'A4') + '</div></div>' +
      '<div class="field"><span>Labels per page</span><div class="seg" role="group" aria-label="Labels per page">' + seg('per', 6, prefs.per, '6 · for boxes') + seg('per', 2, prefs.per, '2 · big ones') + '</div></div>' +
      '<div class="field"><span>Which boxes</span><div class="seg" role="group" aria-label="Which boxes">' + seg('which', 'all', L.which, 'All ' + m.boxes.length) + seg('which', 'new', L.which, 'New since last print ' + since) + seg('which', 'room', L.which, 'One room') + (L.which === 'one' ? seg('which', 'one', L.which, 'Box ' + ((C.boxOf(m, L.one) || {}).no || '')) : '') + '</div>' +
      (L.which === 'room' ? '<div class="chips" style="margin-top:6px">' + m.rooms.map(function (r) { return '<button class="chip" type="button" data-act="lroom" data-room="' + esc(r.id) + '" aria-pressed="' + (L.room === r.id) + '" style="--rc:' + esc(C.colorHex(r.color)) + '"><span class="dot"></span>' + esc(r.name) + '</button>'; }).join('') + '</div>' : '') + '</div>' +
      '<label class="check"><input type="checkbox" id="lContents"' + (prefs.contents ? ' checked' : '') + '> List the contents on each label</label>' +
      '<div class="row"><button class="btn big" type="button" data-act="print"' + (boxes.length ? '' : ' disabled') + '>🖨 Print ' + plural(boxes.length, 'label') + '</button><span class="muted small">' + (boxes.length ? plural(pages, 'page') + ' of ' + g.per : 'No boxes to print') + '</span></div>' +
      '<p class="tiny muted" style="margin:0">Print at 100% (not “fit to page”). Tape a label on two sides of each box - the top gets covered when boxes are stacked.</p></section>';
    out += '</div><div class="stack"><p class="lab">Preview · page 1</p><div class="preview" id="preview"><div class="scaler" id="scaler">' + (boxes.length ? sheetsHtml(m, boxes.slice(0, g.per), g) : '<p class="muted">Pick some boxes to see their labels.</p>') + '</div></div></div></div>';
    out += '<div class="grid two" style="margin-top:14px"><section class="card stack"><h2>Room signs</h2><p class="muted small" style="margin:0">One page per room, to tape on each door of the new place - so helpers carry a box with a colour and a name straight to its room.</p><div class="row"><button class="btn ghost" type="button" data-act="signs">🖨 Print all ' + plural(m.rooms.length, 'sign') + '</button></div>' +
      '<div class="chips">' + m.rooms.map(function (r) { return '<button class="chip" type="button" data-act="sign" data-room="' + esc(r.id) + '" style="--rc:' + esc(C.colorHex(r.color)) + '"><span class="dot"></span>' + esc(r.name) + '</button>'; }).join('') + '</div></section>';
    out += '<p class="note small" style="align-self:start">' + (shared(m) ? 'The QR codes open each box for everyone who has joined this move. Someone who hasn’t is asked for the code - a label never lets a stranger in.' : 'The QR codes open each box on this phone - and, once you share the move (More), on the phone of everyone helping. Anyone else who scans one sees nothing in it.') + '</p></div>';
    return out;
  }
  function fitPreview() {
    var p = $('#preview'), s = $('#scaler'); if (!p || !s) return;
    var sheetEl = $('.sheetp', s); if (!sheetEl) return;
    var w = sheetEl.offsetWidth, h = sheetEl.offsetHeight, avail = p.clientWidth - 24;
    var k = Math.min(1, avail / w);
    s.style.transform = 'scale(' + k.toFixed(4) + ')';
    s.style.height = (h * k) + 'px'; s.style.width = (w * k) + 'px';
    var lc = $('#lContents');
    if (lc) lc.addEventListener('change', function () { prefs.contents = lc.checked; savePrefs(); draw(); });
  }
  function printNow(html, title) {
    var style = $('#pageStyle');
    if (!style) { style = document.createElement('style'); style.id = 'pageStyle'; document.head.appendChild(style); }
    style.textContent = '@page { size: ' + C.PAPERS[prefs.paper].css + ' portrait; margin: ' + C.MARGIN + 'mm; }';
    $('#print').innerHTML = html;
    var t = document.title; document.title = title;
    setTimeout(function () { try { window.print(); } catch (e) { /* the page still holds the labels */ } document.title = t; }, 60);
  }
  function printLabels(m, boxes) {
    if (!boxes.length) return;
    var g = C.labelGrid(prefs.paper, prefs.per);
    printNow(sheetsHtml(m, boxes, g), 'Whichbox labels - ' + m.name);
    if (!state.trying && state.labels.which !== 'one') { var next = C.clone(m); next.printedAt = C.iso(now()); setMove(next); }
  }
  function printSigns(m, rooms) { printNow(rooms.map(function (r) { return signHtml(m, r); }).join(''), 'Whichbox room signs - ' + m.name); }

  /* ---------------- more: the move, rooms, sharing, files ---------------- */

  function viewMore(m) {
    var counts = {};
    m.boxes.forEach(function (b) { counts[b.room] = (counts[b.room] || 0) + 1; });
    var edit = canEdit(m);
    var out = '<div class="sec-head"><h1>More</h1></div><div class="grid two"><div class="stack">';
    out += '<section class="card stack"><h2>' + (m.kind === 'storage' ? 'This list' : 'This move') + '</h2>' + (edit
      ? '<form id="moveForm" class="fields"><label class="field"><span>Name on the labels</span><input class="input" name="name" maxlength="' + C.LIMITS.name + '" value="' + esc(m.name) + '"></label>' +
        (m.kind === 'move' ? '<div class="fields two"><label class="field"><span>From</span><input class="input" name="from" maxlength="' + C.LIMITS.place + '" value="' + esc(m.from) + '"></label><label class="field"><span>To</span><input class="input" name="to" maxlength="' + C.LIMITS.place + '" value="' + esc(m.to) + '"></label></div>' : '') +
        '<div><button class="btn small" type="submit">Save</button></div></form>'
      : '<p style="margin:0"><b>' + esc(m.name) + '</b>' + (m.to ? '<br><span class="muted">To ' + esc(m.to) + '</span>' : '') + '</p>') + '</section>';
    out += '<section class="card"><h2>Rooms</h2><p class="muted small">Each room’s colour is the band on its labels and its door sign.' + (edit ? ' Tap a colour to change it.' : '') + '</p>' +
      '<div>' + m.rooms.map(function (r) {
        return '<div class="roomrow" style="--rc:' + esc(C.colorHex(r.color)) + '">' + (edit ? '<button class="sw" type="button" data-act="recolour" data-room="' + esc(r.id) + '" aria-label="Change the colour of ' + esc(r.name) + '"></button>' : '<span class="sw" aria-hidden="true"></span>') +
          '<span><b>' + esc(r.name) + '</b><small>' + plural(counts[r.id] || 0, 'box', 'boxes') + '</small></span>' +
          (edit ? '<span class="row" style="gap:4px"><button class="btn small ghost" type="button" data-act="renameroom" data-room="' + esc(r.id) + '">Rename</button>' + (counts[r.id] ? '' : '<button class="btn small danger" type="button" data-act="rmroom" data-room="' + esc(r.id) + '" aria-label="Remove ' + esc(r.name) + '">×</button>') + '</span>' : '<span></span>') + '</div>';
      }).join('') + '</div>' +
      (edit ? '<form class="addrow" id="roomForm" style="margin-top:10px"><input class="input" name="room" maxlength="' + C.LIMITS.room + '" placeholder="Add a room" aria-label="New room"><button class="btn ghost" type="submit">Add</button></form>' : '') + '</section>';
    out += '</div><div class="stack">';
    out += shareCard(m);
    out += '<section class="card stack"><h2>Spreadsheet</h2><p class="muted small" style="margin:0">Every box and what’s in it, as a CSV - made on this phone. A CSV from Whichbox can be read back in: its boxes are added to this ' + (m.kind === 'storage' ? 'list' : 'move') + ', skipping numbers already used.</p>' +
      '<div class="row"><button class="btn ghost" type="button" data-act="csvout"' + (m.boxes.length ? '' : ' disabled') + '>⬇ Download CSV</button>' + (edit && !state.trying ? '<label class="btn ghost file-btn">⬆ Add from a CSV<input class="vh" id="csvIn" type="file" accept=".csv,text/csv"></label>' : '') + '</div></section>';
    out += '<section class="card"><h2>Your moves and lists</h2>' + movesList() + '<div class="row" style="margin-top:10px"><button class="btn small ghost" type="button" data-act="newmove">+ A move</button><button class="btn small ghost" type="button" data-act="newstorage">+ Storage boxes</button><button class="btn small ghost" type="button" data-act="joinnew">Join with a code</button></div>' +
      (!state.trying ? '<div style="margin-top:12px"><button class="btn small danger" type="button" data-act="delmove">' + (isHelper(m) ? 'Leave and remove from this phone' : 'Delete ' + esc(m.name) + ' from this phone') + '</button></div>' : '') + '</section>';
    out += '<p class="small muted">Whichbox keeps everything on this phone - boxes, contents and photos - unless you share a move. Nothing is sent anywhere until you do. ' + (signedIn() ? '' : 'You don’t need an account; a free one only adds listing a box from a photo with AI.') + '</p>';
    return out + '</div></div>';
  }
  function movesList() {
    var list = state.trying ? [state.demo] : data.moves;
    return list.map(function (x) {
      var on = cur() && cur().id === x.id;
      return '<button class="mrow" type="button" data-act="switch" data-id="' + esc(x.id) + '"' + (on ? ' aria-current="true"' : '') + '><span class="tile2" aria-hidden="true">' + (x.kind === 'storage' ? '🗄️' : '🚚') + '</span><span><b>' + esc(x.name) + '</b><small>' + esc(C.summaryLine(x)) + (x.shared ? ' · ' + (x.shared.role === 'owner' ? 'shared' : 'helping') : '') + '</small></span><span class="muted" aria-hidden="true">' + (on ? '✓' : '›') + '</span></button>';
    }).join('');
  }
  function shareCard(m) {
    if (state.trying) {
      return '<section class="card stack"><h2>Helpers</h2><p class="muted small" style="margin:0">On a real move you share it with a six-letter code - no accounts. In this made-up one, Noor, Ezra and Juno are helping: the boxes say who delivered each.</p><div class="row"><button class="btn" type="button" disabled>Share with helpers</button><span class="tiny muted">For your own move</span></div></section>';
    }
    if (!m.shared) {
      return '<section class="card stack"><h2>Share with helpers</h2><p class="muted small" style="margin:0">Friends and family on moving day see every box, where it goes and what’s in it, search it all, and tick boxes off as they come off the truck. They join with a code and a first name - no account, no app.</p>' +
        '<p class="tiny muted" style="margin:0"><b>What is shared:</b> the move’s name and where it’s going, its rooms, and each box’s number, room, contents, flags, note and status - as text. <b>Never photos</b> - they stay on this phone. You can stop sharing any time.</p>' +
        '<div><button class="btn" type="button" data-act="share">Share with helpers</button></div></section>';
    }
    if (m.shared.role === 'helper') {
      var me = (m.shared.members || []).find(function (x) { return x.you; });
      return '<section class="card stack"><h2>Helping</h2><p class="muted small" style="margin:0">' + (sharerName(m) ? esc(sharerName(m)) + ' shared this move. ' : '') + 'You’re helping' + (me ? ' as ' + esc(me.name) : '') + ': open or scan a box to mark it Loaded or Delivered. Photos stay on the phone that took them.</p>' + helpersList(m, false) + '</section>';
    }
    var link = C.joinUrl(ORIGIN, BASE, m.shared.code);
    return '<section class="card stack"><h2>Shared with helpers</h2>' +
      (m.shared.code ? '<p class="muted small" style="margin:0">Helpers join with this code - or by scanning it.</p><div class="code-big">' + esc(C.formatCode(m.shared.code)) + '</div><div class="qrbox">' + (QR ? QR.svg(link, 'QR code to join this move') : '') + '</div>' +
        '<div class="row" style="justify-content:center"><button class="btn small" type="button" data-act="sharelink">Send the link</button><button class="btn small ghost" type="button" data-act="invite">Show it big</button><button class="btn small ghost" type="button" data-act="newcode">New code</button></div>' : '') +
      helpersList(m, true) +
      '<p class="tiny muted" style="margin:0">Photos stay on this phone. A shared move nobody opens for 90 days closes by itself; your boxes stay here.</p>' +
      '<div><button class="btn small danger" type="button" data-act="unshare">Stop sharing</button></div></section>';
  }
  function helpersList(m, owner) {
    var list = (m.shared.members || []);
    if (!list.length) return '';
    return '<div>' + list.map(function (x) {
      return '<div class="lrow"><span><b>' + esc(x.name) + (x.you ? ' (you)' : '') + '</b><small>' + (x.role === 'owner' ? 'Shared it' : 'Helping') + '</small></span>' + (owner && x.role !== 'owner' ? '<button class="btn small ghost" type="button" data-act="rmhelper" data-mid="' + esc(x.id) + '" aria-label="Remove ' + esc(x.name) + '">Remove</button>' : '<span></span>') + '</div>';
    }).join('') + '</div>';
  }
  function bindMore(m) {
    var f = $('#moveForm');
    if (f) f.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = { name: f.name.value };
      if (f.from) { body.from = f.from.value; body.to = f.to.value; }
      if (shared(m)) { sharedApi(m, 'PATCH', '', body).then(function (r) { mergeView(m, r.move); draw(); toast('Saved.'); }).catch(function (err) { showError(err); }); return; }
      var next = C.clone(m);
      next.name = C.plain(body.name, C.LIMITS.name) || C.defaultName(m.kind, body.from, body.to);
      if (m.kind === 'move') { next.from = C.plain(body.from, C.LIMITS.place); next.to = C.plain(body.to, C.LIMITS.place); }
      setMove(next); draw(); toast('Saved.');
    });
    var rf = $('#roomForm');
    if (rf) rf.addEventListener('submit', function (e) {
      e.preventDefault();
      try { var r = C.addRoom(m, { name: rf.room.value }, rand); if (r.move !== m) { saveRooms(m, r.move.rooms); draw(); toast(r.room.name + ' added.'); } else toast('There’s already a room called ' + r.room.name + '.'); }
      catch (err) { showError(err); }
    });
    var ci = $('#csvIn');
    if (ci) ci.addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return;
      if (file.size > C.LIMITS.csvBytes) { toast('That file is too big for a box list.'); return; }
      file.text().then(function (text) { importCsv(m, text); });
    });
  }
  function importCsv(m, text) {
    var res = C.fromCsv(text, m, o());
    if (res.error) { toast(res.error, 4200); return; }
    var added = res.move.boxes.filter(function (b) { return !C.boxOf(m, b.id); });
    var msg = plural(res.added, 'box', 'boxes') + ' added' + (res.skipped ? ' · ' + res.skipped + ' skipped (numbers already used, or unreadable)' : '') + '.';
    if (!shared(m)) { setMove(res.move); draw(); toast(msg, 4200); return; }
    saveRooms(m, res.move.rooms);
    sendBatches(cur(), added).then(function () { return refreshShared(cur()); }).then(function () { draw(); toast(msg, 4200); }).catch(function (err) { showError(err); });
  }

  /* ---------------- sharing ---------------- */

  function sendBatches(m, boxes) {
    var chunks = [];
    for (var i = 0; i < boxes.length; i += C.LIMITS.batch) chunks.push(boxes.slice(i, i + C.LIMITS.batch).map(C.shareBox));
    return chunks.reduce(function (p, c) { return p.then(function () { return api('POST', 'api/m/' + m.shared.id + '/boxes', { boxes: c }); }); }, Promise.resolve());
  }
  function openShare(m) {
    sheet('<h2>Share with helpers</h2><p class="muted">Helpers see the boxes and where they go, search them, and mark them Loaded or Delivered. Only you can change what’s in a box, delete one or remove a helper.</p>' +
      '<form id="shareForm" class="fields"><label class="field"><span>Your first name</span><input class="input" name="you" maxlength="' + C.LIMITS.helperName + '" value="' + esc(meDefaults.name || '') + '" autocomplete="given-name" required><span class="hint">So helpers see who shared it.</span></label>' +
      '<p class="note small" style="margin:0"><b>Sent to the server:</b> ' + esc(m.name) + (m.to ? ' (to ' + esc(m.to) + ')' : '') + ', ' + plural(m.rooms.length, 'room') + ' and ' + plural(m.boxes.length, 'box', 'boxes') + ' as text. <b>Not sent:</b> any photo.</p>' +
      '<div id="shErr"></div><button class="btn block" type="submit">Share it</button></form>', function (root) {
      var f = $('#shareForm', root);
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = $('button[type=submit]', f); btn.disabled = true; btn.textContent = 'Sharing…';
        var name = C.cleanName(f.you.value);
        if (!name) { btn.disabled = false; btn.textContent = 'Share it'; showError(new Error('Type your first name.'), $('#shErr', root)); return; }
        meDefaults.name = name; keep(K_ME, meDefaults);
        var sid = null;
        api('POST', 'api/moves', Object.assign(C.shareMeta(m), { you: { name: name } })).then(function (r) {
          sid = r.id;
          var live = C.clone(m); live.shared = { id: sid, role: 'owner', code: r.move.code, v: r.move.v, at: now(), members: r.move.members };
          if (m.boxes.length) btn.textContent = 'Sharing ' + plural(m.boxes.length, 'box', 'boxes') + '…';
          return sendBatches(live, m.boxes).then(function () { return api('GET', 'api/m/' + sid); }).then(function (v) {
            setMove(live); mergeView(cur(), v.move);
          });
        }).then(function () {
          closeSheet(true); draw(); openInvite(cur());
        }).catch(function (err) {
          if (sid) api('DELETE', 'api/m/' + sid).catch(function () { /* nothing to undo */ });
          btn.disabled = false; btn.textContent = 'Share it';
          showError(err, $('#shErr', root));
        });
      });
    });
  }

  /** The code, its QR and the link - shown the moment a move is shared, and
   *  from More any time after. */
  function openInvite(m) {
    if (!shared(m) || !m.shared.code) return;
    var link = C.joinUrl(ORIGIN, BASE, m.shared.code);
    sheet('<h2>Invite your helpers</h2><p class="muted">They open the link - or scan this, or type the code in Whichbox - and add a first name. No account, no app.</p>' +
      '<div class="code-big">' + esc(C.formatCode(m.shared.code)) + '</div><div class="qrbox">' + (QR ? QR.svg(link, 'QR code to join this move') : '') + '</div>' +
      '<div class="row" style="justify-content:center"><button class="btn" type="button" data-act="sharelink">Send the link</button></div>' +
      '<p class="tiny muted center" style="margin-top:10px">Box labels never carry this code: someone who scans a label without it is asked for it.</p>');
  }

  /* ---------------- joining ---------------- */

  function viewJoin() {
    var j = state.join || { code: '', info: null };
    var out = '<div class="sec-head"><h1>Join a move</h1></div>';
    if (j.sid && !j.info) out += '<p class="note">You scanned a label from a shared move. To open it, join the move: ask whoever shared it for the six-letter code - it’s on their More page.</p>';
    if (j.info) {
      var i = j.info;
      out += '<section class="card stack"><p class="lab">' + (i.kind === 'storage' ? 'Storage boxes' : 'A move') + '</p><h2 style="font-size:1.6rem">' + esc(i.name) + '</h2><p class="muted" style="margin:0">' + (i.by ? 'Shared by ' + esc(i.by) + ' · ' : '') + plural(i.boxes, 'box', 'boxes') + ' · ' + plural(i.helpers, 'helper') + '</p>' +
        (i.full ? '<p class="err">This move has as many helpers as it can take.</p>' :
          '<form id="joinForm" class="fields"><label class="field"><span>Your first name</span><input class="input" name="name" maxlength="' + C.LIMITS.helperName + '" value="' + esc(meDefaults.name || '') + '" autocomplete="given-name" required><span class="hint">Everyone sees who moved which box.</span></label><div id="jErr"></div><button class="btn big block" type="submit">Join and help</button></form>') +
        '<p class="tiny muted" style="margin:0">No account needed. You’ll see every box and can mark it Loaded or Delivered. Photos stay on the phone that took them.</p></section>';
    } else {
      out += '<form class="card fields" id="codeForm"><label class="field"><span>The code</span><input class="input code" name="code" maxlength="9" value="' + esc(C.formatCode(j.code || '')) + '" placeholder="ABC-234" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label><div id="jErr">' + (j.err ? '<p class="err" role="alert">' + esc(j.err) + '</p>' : '') + '</div><button class="btn big block" type="submit">Look it up</button></form>';
    }
    return out;
  }
  function lookupJoin() {
    var j = state.join;
    if (!j || !C.isCode(j.code)) return;
    api('GET', 'api/join/' + j.code).then(function (info) {
      j.info = info; j.err = '';
      if (info.already) { return enterShared(info.already, j.bid).then(function () { toast('You’re already helping with this move.'); }); }
      draw();
    }).catch(function (err) { j.err = err.message; j.info = null; draw(); });
  }
  function bindJoin() {
    var cf = $('#codeForm');
    if (cf) {
      cf.addEventListener('submit', function (e) { e.preventDefault(); state.join.code = C.normalizeCode(cf.code.value); if (!C.isCode(state.join.code)) { $('#jErr').innerHTML = '<p class="err" role="alert">A code is six letters and numbers, like ABC-234.</p>'; return; } lookupJoin(); });
      setTimeout(function () { try { cf.code.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 40);
    }
    var jf = $('#joinForm');
    if (jf) jf.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('button[type=submit]', jf); btn.disabled = true;
      var name = C.cleanName(jf.name.value);
      meDefaults.name = name; keep(K_ME, meDefaults);
      api('POST', 'api/join/' + state.join.code, { name: name }).then(function (r) { return enterShared(r.id, state.join.bid); })
        .then(function () { toast('You’re in. Open a box - or scan its label - to mark it delivered.', 4200); })
        .catch(function (err) { btn.disabled = false; showError(err, $('#jErr')); });
    });
  }
  /** Fetch a shared move this phone is a member of and keep it here. */
  function enterShared(sid, bid) {
    return api('GET', 'api/m/' + sid).then(function (r) {
      var have = data.moves.find(function (x) { return x.shared && x.shared.id === sid; });
      var base = have || { id: C.newId(rand, 12), createdAt: C.iso(now()), updatedAt: C.iso(now()), printedAt: '', boxes: [], shared: { id: sid } };
      if (!have) { var shell = C.cleanMove(Object.assign({}, base, { kind: r.move.kind, name: r.move.name, rooms: r.move.rooms, shared: { id: sid, role: r.move.role } }), o()); data.moves.unshift(shell); if (data.moves.length > C.LIMITS.moves) data.moves = data.moves.slice(0, C.LIMITS.moves); }
      var m = mergeView(have || data.moves[0], r.move);
      leaveTryQuiet();
      data.current = m.id; saveLocal();
      state.join = null;
      go(bid && C.boxOf(m, bid) ? 'box/' + bid : 'boxes');
    });
  }

  /* ---------------- "List what's in this box" (metered) ---------------- */

  /** The photo to send: the 1200 px copy, smaller until it fits. */
  function sendable(full) {
    var max = C.LIMITS.aiImageBytes * 4 / 3;
    var b64 = full.replace(/^data:image\/jpeg;base64,/, '');
    if (b64.length <= max) return Promise.resolve(b64);
    return loadImg(full).then(function (im) {
      var steps = [[1200, 0.66], [1000, 0.62], [800, 0.6]];
      for (var i = 0; i < steps.length; i++) { var d = redraw(im, steps[i][0], steps[i][1]).replace(/^data:image\/jpeg;base64,/, ''); if (d.length <= max) return d; }
      throw new Error('That photo is too large to send. Try another.');
    });
  }
  function openAi(target) {
    var m = cur();
    state.ai = { target: target, photo: null, proposal: null };
    var p = target.form ? Promise.resolve(state.form && state.form.photo) : (C.boxOf(m, target.id) && C.boxOf(m, target.id).photo ? photoGet(target.id) : Promise.resolve(null));
    p.then(function (ph) { state.ai.photo = ph || null; sheet('<div class="body"></div>', drawAi); });
  }
  function drawAi(root) {
    var b = $('.body', root), a = state.ai, m = cur();
    var sent = '<div class="sent">' + (a.photo ? '<img alt="" src="' + esc(a.photo.thumb) + '">' : '') + '<b>What is sent:</b> this one photo, shrunk on this phone with its location removed. Nothing else - not your move’s name or address, your rooms, or what’s already listed.<span style="display:block;clear:both"></span></div>';
    if (state.trying) {
      b.innerHTML = '<h2>List what’s in this box</h2><p>Take a photo of an open box and AI lists what it can see - up to 40 things - with the room it probably goes to and whether it looks fragile or heavy. You check the list before anything is added.</p><p class="note">This reads a real photo of your own box. Start your own move to try it.</p><button class="btn" type="button" data-act="tryown">Start my own move</button>';
      return;
    }
    if (!signedIn()) {
      b.innerHTML = '<h2>List what’s in this box</h2><p>Take a photo of an open box and AI lists what it can see - up to 40 things - with the room it probably goes to and whether it looks fragile or heavy. You check the list before anything is added.</p>' + sent +
        '<p class="note" style="margin-top:12px">This needs a free account - it comes with $2 of AI credit, and one box costs about a cent. Typing the list, labels, search and moving day stay free with no account.</p>' +
        '<div class="row" style="margin-top:12px"><button class="btn" type="button" id="aiJoin">Create a free account</button><button class="btn ghost" type="button" id="aiIn">Sign in</button></div>';
      $('#aiJoin', root).addEventListener('click', function () { openAccount('Create a free account to list boxes from a photo.', function () { openAi(a.target); }); });
      $('#aiIn', root).addEventListener('click', function () { openAccount('Sign in to list boxes from a photo.', function () { openAi(a.target); }, 'login'); });
      return;
    }
    if (a.proposal) return drawProposal(root);
    b.innerHTML = '<h2>List what’s in this box</h2>' +
      '<div class="field" style="margin:8px 0 12px"><span>A photo of the open box, from above</span><label class="btn ghost file-btn">' + (a.photo ? '📷 Another photo' : '📷 Take or choose a photo') + '<input class="vh" id="aiFile" type="file" accept="image/*" capture="environment"></label></div>' + sent +
      '<div id="aiOut" style="margin-top:12px"></div><div class="row" style="margin-top:12px"><button class="btn ai" type="button" id="aiGo"' + (a.photo ? '' : ' disabled') + '> List it</button><span class="tiny muted">About a cent of AI credit.</span></div>';
    var out = $('#aiOut', root), goB = $('#aiGo', root);
    $('#aiFile', root).addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return;
      prepPhoto(file).then(function (p) {
        a.photo = p;
        if (a.target.form && state.form) { state.form.photo = p; state.form.photoChanged = true; }
        drawAi(root);
      }).catch(function (err) { showError(err, out); });
    });
    goB.addEventListener('click', function () {
      if (!a.photo) return;
      goB.disabled = true; goB.textContent = 'Looking…';
      out.innerHTML = '<p class="muted" role="status">Looking in the box…</p>';
      sendable(a.photo.full).then(function (b64) {
        return api('POST', 'api/ai/contents', { image: { type: 'image/jpeg', data: b64 } });
      }).then(function (res) {
        a.proposal = res.proposal; drawAi(root); loadMe();
      }).catch(function (err) {
        goB.disabled = false; goB.textContent = ' List it';
        meteredError(err, out, function () { openAi(a.target); }, 'Sign in to list boxes from a photo.');
      });
    });
  }
  function drawProposal(root) {
    var b = $('.body', root), a = state.ai, p = a.proposal, m = cur();
    var suggested = C.roomForKind(m, p.room);
    var box = a.target.form ? null : C.boxOf(m, a.target.id);
    var have = a.target.form ? (state.form ? state.form.items : []) : (box ? box.items : []);
    var conf = function (c) { return '<span class="pill ' + (c === 'high' ? 's-delivered' : c === 'medium' ? 's-unpacked' : 's-loaded') + '">' + esc(c) + ' confidence</span>'; };
    b.innerHTML = '<h2>Check it, then add</h2><p class="small muted">AI-written - check every line. Nothing is added until you tap Add.</p>' +
      '<p>' + conf(p.confidence) + (p.note ? ' <span class="small muted">' + esc(p.note) + '</span>' : '') + '</p>' +
      '<div class="prop">' + p.items.map(function (t, i) {
        var dup = have.some(function (x) { return C.itemKey(x) === C.itemKey(t); });
        return '<div class="irow"><input type="checkbox" data-pi="' + i + '"' + (dup ? '' : ' checked') + ' aria-label="Add ' + esc(t) + '"><input class="input" data-pn="' + i + '" maxlength="' + C.LIMITS.item + '" value="' + esc(t) + '" aria-label="Thing ' + (i + 1) + '">' + (dup ? '<span class="tiny muted" style="grid-column:2;margin-top:-4px">Already listed - left unticked</span>' : '') + '</div>';
      }).join('') + '</div>' +
      '<div class="field" style="margin-top:12px"><span>Room</span>' + (suggested ? '<p class="small" style="margin:0">Looks like <b>' + esc(suggested.name) + '</b> ' + conf(p.roomConfidence) + '</p>' : '<p class="small muted" style="margin:0">' + (p.room === 'unsure' ? 'It couldn’t tell which room.' : 'This move has no room of that kind.') + ' Keep the one you picked.</p>') +
      (suggested ? '<label class="check"><input type="checkbox" id="ppRoom"' + (p.roomConfidence !== 'low' ? ' checked' : '') + '> Use ' + esc(suggested.name) + '</label>' : '') + '</div>' +
      (p.flags.length ? '<div class="field"><span>Flags</span>' + p.flags.map(function (f) { return '<label class="check"><input type="checkbox" data-pf="' + esc(f.id) + '"' + (f.confidence !== 'low' ? ' checked' : '') + '> ' + esc(C.flagLabel(f.id)) + ' <span class="tiny muted">(' + esc(f.confidence) + ')</span></label>'; }).join('') + '</div>' : '') +
      '<div id="ppErr"></div><div class="row" style="margin-top:12px"><button class="btn" type="button" id="ppAdd">Add</button><button class="btn ghost" type="button" id="ppBack">Try another photo</button></div>';
    var cnt = function () { var n = $$('[data-pi]', root).filter(function (c) { return c.checked; }).length; var btn = $('#ppAdd', root); btn.textContent = n ? 'Add ' + plural(n, 'thing') : 'Add'; btn.disabled = !n; };
    $$('[data-pi]', root).forEach(function (c) { c.addEventListener('change', cnt); }); cnt();
    $('#ppBack', root).addEventListener('click', function () { a.proposal = null; drawAi(root); });
    $('#ppAdd', root).addEventListener('click', function () {
      var items = $$('[data-pi]', root).filter(function (c) { return c.checked; }).map(function (c) { return $('[data-pn="' + c.getAttribute('data-pi') + '"]', root).value; });
      var flags = $$('[data-pf]', root).filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-pf'); });
      var useRoom = suggested && $('#ppRoom', root) && $('#ppRoom', root).checked;
      if (a.target.form && state.form) {
        state.form.items = C.cleanItems(state.form.items.concat(items));
        flags.forEach(function (f) { if (state.form.flags.indexOf(f) < 0) state.form.flags.push(f); });
        if (useRoom) state.form.room = suggested.id;
        closeSheet(true); draw(); toast(plural(items.length, 'thing') + ' added to the list. Check it, then save.');
        return;
      }
      if (!box) { closeSheet(true); return; }
      var input = { items: C.cleanItems(box.items.concat(items)), flags: C.cleanFlags(box.flags.concat(flags)) };
      if (useRoom) input.room = suggested.id;
      if (a.photo && !box.photo) input.photo = true;
      var ph = a.photo && !box.photo ? photoPut(box.id, a.photo) : Promise.resolve();
      ph.then(function () { return editBoxNow(m, box, input); }).then(function () { closeSheet(true); draw(); toast(plural(items.length, 'thing') + ' added to box ' + box.no + '.'); })
        .catch(function (err) { showError(err, $('#ppErr', root)); });
    });
  }

  /* ---------------- sheets and the account ---------------- */

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

  function openMoves() {
    sheet('<h2>Your moves and lists</h2>' + (data.moves.length || state.trying ? movesList() : '<p class="muted">None yet.</p>') +
      '<div class="row" style="margin-top:12px"><button class="btn small" type="button" data-act="newmove">+ A move</button><button class="btn small ghost" type="button" data-act="newstorage">+ Storage boxes</button><button class="btn small ghost" type="button" data-act="joinnew">Join with a code</button></div>' +
      (state.trying ? '' : '<div class="row" style="margin-top:8px"><button class="btn small ghost" type="button" data-act="try">See the made-up move</button><button class="btn small ghost" type="button" data-act="tryloft">See a made-up loft</button></div>'));
  }
  function openRecolour(m, roomId) {
    var r = C.roomOf(m, roomId); if (!r) return;
    sheet('<h2>' + esc(r.name) + '’s colour</h2><p class="muted small">Every colour keeps white words readable on a label - in colour and in black and white.</p><div class="swatches">' +
      C.PALETTE.map(function (p) { return '<button type="button" data-act="pickcolour" data-room="' + esc(r.id) + '" data-c="' + p.id + '" style="--rc:' + p.hex + '" aria-pressed="' + (r.color === p.id) + '" aria-label="' + esc(p.name) + '"></button>'; }).join('') + '</div>');
  }

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = state.me || { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Whichbox is free with no account, and your boxes stay on this phone. A free account adds one thing: listing a box from a photo with AI - it comes with $2 of AI credit, and one account works across every app on this site.';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (then) then(); else draw(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (then) then(); else draw(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Listing a box from a photo costs about a cent. Everything else is free.</p><div id="billing"></div></div>' +
      '<p class="small muted" style="margin-top:12px">Your boxes are not in your account - they stay on this phone, and in a shared move only if you share one.</p>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:10px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).addEventListener('click', function () { api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); draw(); }); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((d && d.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Typing the list, labels, search and moving day keep working, free.</p><div id="billing"></div>' +
      (d && d.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(d.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- clicks ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    var m = cur();
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); closeSheet(true); state.join = null; go(''); break;
      case 'tab': closeSheet(true); state.form = null; go(t.getAttribute('data-tab') === 'boxes' ? 'boxes' : t.getAttribute('data-tab')); break;
      case 'try': closeSheet(true); startTry('move'); break;
      case 'tryloft': closeSheet(true); startTry('storage'); break;
      case 'tryleave': leaveTry(); toast('That was the made-up move - nothing was saved.'); break;
      case 'tryown': closeSheet(true); leaveTryQuiet(); go('new'); break;
      case 'newmove': closeSheet(true); go('new'); break;
      case 'newstorage': closeSheet(true); go('newstorage'); break;
      case 'joinnew': closeSheet(true); state.join = { code: '', info: null }; go('join'); break;
      case 'moves': openMoves(); break;
      case 'switch': {
        closeSheet(true);
        if (state.trying && state.demo && state.demo.id === id) break;
        leaveTryQuiet(); data.current = id; saveLocal(); state.room = 'all'; state.form = null; go('boxes');
        var sw = cur(); if (shared(sw)) refreshShared(sw).then(function (ch) { if (ch) draw(); });
        break;
      }
      case 'add': state.form = null; go('add'); break;
      case 'room': state.room = t.getAttribute('data-room'); draw(); break;
      case 'tag': state.tag = t.getAttribute('data-tag'); draw(); break;
      case 'open': closeSheet(true); state.found = null; go('box/' + id); break;
      case 'openfound': {
        var r = (state.lastResults || []).find(function (x) { return x.box.id === id; });
        state.found = r ? { id: id, hits: r.hits.filter(function (h) { return h.field === 'item'; }).map(function (h) { return h.text; }) } : null;
        go('box/' + id); break;
      }
      case 'findword': state.q = t.getAttribute('data-w'); var fq = $('#findQ'); if (fq) { fq.value = state.q; drawFound(m); } break;
      case 'edit': state.form = null; go('edit/' + id); break;
      case 'canceledit': { var eid = state.form && state.form.editing; state.form = null; go(eid ? 'box/' + eid : 'boxes'); break; }
      case 'status': {
        var b = C.boxOf(m, id); if (!b) break;
        var s = t.getAttribute('data-s');
        if (b.status === s) break;
        var was = b.status;
        t.disabled = true;
        setStatusNow(m, b, s).then(function (nb) {
          draw();
          say('Box ' + b.no + ': ' + C.statusLabel(s));
          toast('Box ' + b.no + ' · ' + C.statusLabel(s) + (s === 'delivered' ? ' ✓' : ''), 3200, { label: 'Undo', fn: function () { setStatusNow(cur(), C.boxOf(cur(), nb.id) || nb, was).then(draw).catch(function (err) { showError(err); }); } });
        }).catch(function (err) { t.disabled = false; showError(err); });
        break;
      }
      case 'delbox': {
        var db2 = C.boxOf(m, id); if (!db2) break;
        if (!confirm('Delete box ' + db2.no + (shared(m) ? ' for everyone helping' : '') + '? Its label will open nothing. This can’t be undone.')) break;
        deleteBoxNow(m, db2).then(function () { go('boxes'); toast('Box ' + db2.no + ' deleted.'); }).catch(function (err) { showError(err); });
        break;
      }
      case 'photo': openPhoto(id); break;
      case 'aibox': openAi({ id: id }); break;
      case 'printone': state.labels.which = 'one'; state.labels.one = id; go('labels'); break;
      case 'lopt': {
        var k = t.getAttribute('data-k'), v = t.getAttribute('data-v');
        if (k === 'paper') prefs.paper = C.PAPERS[v] ? v : 'letter';
        if (k === 'per') prefs.per = Number(v) === 2 ? 2 : 6;
        if (k === 'which') { state.labels.which = v; if (v === 'room' && !state.labels.room) state.labels.room = m.rooms[0].id; }
        savePrefs(); draw(); break;
      }
      case 'lroom': state.labels.room = t.getAttribute('data-room'); draw(); break;
      case 'print': printLabels(m, labelBoxes(m)); break;
      case 'signs': printSigns(m, m.rooms); break;
      case 'sign': { var sr = C.roomOf(m, t.getAttribute('data-room')); if (sr) printSigns(m, [sr]); break; }
      case 'recolour': openRecolour(m, t.getAttribute('data-room')); break;
      case 'pickcolour': {
        try { var nm = C.editRoom(m, t.getAttribute('data-room'), { color: t.getAttribute('data-c') }); closeSheet(true); saveRooms(m, nm.rooms); draw(); } catch (err) { showError(err); }
        break;
      }
      case 'renameroom': {
        var rr = C.roomOf(m, t.getAttribute('data-room')); if (!rr) break;
        var nn = prompt('Rename ' + rr.name + ':', rr.name);
        if (nn === null) break;
        try { var rm = C.editRoom(m, rr.id, { name: nn }); saveRooms(m, rm.rooms); draw(); } catch (err) { showError(err); }
        break;
      }
      case 'rmroom': {
        try { var rm2 = C.removeRoom(m, t.getAttribute('data-room')); saveRooms(m, rm2.rooms); draw(); } catch (err) { showError(err); }
        break;
      }
      case 'csvout': download('whichbox-' + slug(m.name) + '.csv', 'text/csv', C.boxesCsv(m)); toast('Downloaded - made on this phone.'); break;
      case 'share': openShare(m); break;
      case 'invite': openInvite(m); break;
      case 'sharelink': shareText('Help with ' + m.name, 'Join “' + m.name + '” on Whichbox with the code ' + C.formatCode(m.shared.code) + ':', C.joinUrl(ORIGIN, BASE, m.shared.code)); break;
      case 'newcode':
        if (!confirm('Make a new code? The old one stops working at once. Helpers already in stay in.')) break;
        sharedApi(m, 'POST', '/code', {}).then(function (r) { var live = cur(); live.shared.code = r.code; saveLocal(); draw(); toast(r.msg); }).catch(function (err) { showError(err); });
        break;
      case 'rmhelper':
        if (!confirm('Remove them? They can’t open this move any more. What they ticked off stays.')) break;
        sharedApi(m, 'DELETE', '/members/' + t.getAttribute('data-mid')).then(function (r) { mergeView(m, r.move); draw(); toast('Removed.'); }).catch(function (err) { showError(err); });
        break;
      case 'unshare':
        if (!confirm('Stop sharing? The shared copy is deleted and helpers can no longer open it. Your boxes stay on this phone.')) break;
        sharedApi(m, 'DELETE', '').then(function () { var live = cur(); delete live.shared; saveLocal(); draw(); toast('Sharing stopped. Your boxes are still here.'); }).catch(function (err) { showError(err); });
        break;
      case 'delmove': {
        if (isHelper(m)) {
          if (!confirm('Stop helping with ' + m.name + ' and take it off this phone?')) break;
          api('DELETE', 'api/m/' + m.shared.id + '/me').catch(function () { /* gone already */ }).then(function () { removeMove(m.id); go(''); toast('Removed from this phone.'); });
          break;
        }
        if (!confirm('Delete ' + m.name + ' - ' + plural(m.boxes.length, 'box', 'boxes') + ' and their photos - from this phone?' + (shared(m) ? ' Sharing stops too.' : '') + ' This can’t be undone.')) break;
        (shared(m) ? api('DELETE', 'api/m/' + m.shared.id).catch(function () { /* already gone */ }) : Promise.resolve()).then(function () { removeMove(m.id); go(''); toast('Deleted.'); });
        break;
      }
      default: break;
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  // Two phones, one move: re-ask when the app comes back, and every 15
  // seconds while a shared move is on screen (one read when nothing moved).
  // A redraw waits while someone is typing.
  function busyTyping() { var a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }
  function poll() {
    var m = cur();
    if (!shared(m) || state.trying || document.visibilityState !== 'visible') return;
    refreshShared(m).then(function (changed) { if ((changed || state.offline) && $('#sheet').hidden && !busyTyping() && state.view !== 'add' && state.view !== 'edit') draw(); });
  }
  setInterval(poll, 15000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') poll(); });
  window.addEventListener('online', poll);
  drawTop();
  route();
  poll();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
