/* Again - the page. One file, no build step.
 *
 * EVERYTHING STAYS ON THIS DEVICE unless the person says otherwise: the
 * places, dishes, verdicts and the Want to try list in localStorage, dish
 * photos in IndexedDB (shrunk through a canvas first, which drops their
 * EXIF, location included), and "I'm here", browsing, the stats and the
 * share card worked out here by AgainCore. Every storage access is wrapped
 * in try/catch, and the page works - in memory - when storage is
 * unavailable.
 *
 * The requests this page makes: sign-in; sync of the LIST (never a photo),
 * only when the person turns it on in Settings; a share link of one city's
 * "Order again" list, only when they make one (its payload is shown first);
 * a friend opening such a link; and the optional menu reader, whose payload
 * is shown before it is sent.
 *
 * Every string a person typed, a file held, a friend's link carried, the
 * server answered or a model wrote is escaped before it is drawn, and no
 * handler is written into markup: clicks are routed by data-act attributes
 * from one listener (the lab's CSP allows script from this origin only).
 */
(function () {
  'use strict';

  var C = window.AgainCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  // A tag the browser reports but Intl refuses ("en-US@posix" in some
  // headless browsers) would make every date and amount throw: fall back.
  var LOCALE = (function () { try { return Intl.getCanonicalLocales(navigator.language || 'en-US')[0] || 'en-US'; } catch (e) { return 'en-US'; } }());
  var K_DATA = 'again-data-v1', K_PREFS = 'again-prefs-v1', K_SYNC = 'again-sync-v1', K_LINKS = 'again-links-v1';

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function now() { return Date.now(); }
  function newId() {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '', a = new Uint8Array(12);
    try { crypto.getRandomValues(a); } catch (e) { for (var j = 0; j < 12; j++) a[j] = Math.floor(Math.random() * 256); }
    for (var i = 0; i < 12; i++) out += abc[a[i] % 36];
    return out;
  }
  function ctx() { return { nowMs: now(), today: today(), newId: newId, currency: cur(), locale: LOCALE }; }

  /* ---------------- what this device keeps ---------------- */

  var prefs = recall(K_PREFS) || {};
  if (!C.isCurrency(prefs.currency)) prefs.currency = C.currencyFor(LOCALE);
  prefs.from = C.cleanPerson(prefs.from);
  function savePrefs() { keep(K_PREFS, prefs); }
  function cur() { return prefs.currency; }
  function money(c) { return C.money(c, cur(), LOCALE); }

  function loadData() {
    var raw = recall(K_DATA) || {};
    var r = C.cleanList({ places: raw.places, dishes: raw.dishes, wants: raw.wants, deleted: raw.deleted }, { nowMs: now(), today: today() });
    return r.list;
  }
  var data = loadData();
  var sync = recall(K_SYNC) || {};
  if (typeof sync.version !== 'number') sync.version = null;
  sync.dirty = sync.dirty === true;
  var links = recall(K_LINKS) || {};
  if (!links || typeof links !== 'object' || Array.isArray(links)) links = {};
  Object.keys(links).forEach(function (k) { if (!/^[A-Za-z0-9_-]{32}$/.test(k) || !/^[A-Za-z0-9_-]{22}$/.test(String(links[k]))) delete links[k]; });
  var storageOk = true;
  function saveLocal() {
    var ok = keep(K_DATA, data);
    if (!ok && storageOk) { storageOk = false; toast('This browser isn’t keeping things right now - they’ll be gone when the page closes.', 5200); }
  }
  function save() {
    saveLocal();
    if (prefs.sync) { sync.dirty = true; keep(K_SYNC, sync); schedulePush(); }
  }

  var state = {
    me: null, view: 'home', arg: '', q: '',
    trying: false, tryData: null,
    thumbs: {},
    log: null, reader: null,
    browse: { city: '', cuisine: '', mode: 'places', q: '', picked: false },
    card: { url: null, blob: null, photos: false, city: '' },
    share: null,
    syncBusy: false, syncErr: '',
  };
  function D() { return state.trying ? state.tryData : data; }
  function setD(next) {
    if (state.trying) { state.tryData = next; return; }
    data = next; save();
  }
  function findPlace(id) { return D().places.find(function (p) { return p.id === id; }) || null; }
  function findDish(id) { return D().dishes.find(function (d) { return d.id === id; }) || null; }
  function findWant(id) { return D().wants.find(function (w) { return w.id === id; }) || null; }

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
  function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'list'; }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function vpill(v) { var x = C.verdictOf(v); return '<span class="pill v-' + esc(x.id) + '">' + esc(x.emoji + ' ' + x.label) + '</span>'; }
  function placeSub(p) { return [p.area, p.city].filter(Boolean).join(' · '); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Everything else in Again stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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

  /* ---------------- photos: on this device only ---------------- */

  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        var r = indexedDB.open('again', 1);
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
  function photoGet(key) {
    if (memPhotos[key]) return Promise.resolve(memPhotos[key]);
    return idb('readonly', function (s) { return s.get(key); }).then(function (v) {
      if (v && JPEG_URL.test(v.thumb || '') && JPEG_URL.test(v.full || '')) memPhotos[key] = v;
      return memPhotos[key] || null;
    });
  }
  function photoPut(key, p) { memPhotos[key] = p; state.thumbs[key] = p.thumb; return idb('readwrite', function (s) { return s.put(p, key); }); }
  function photoDel(key) { delete memPhotos[key]; delete state.thumbs[key]; return idb('readwrite', function (s) { return s.delete(key); }); }
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
  /** A photo, redrawn here at `max` px and as a 240 px thumbnail. */
  function prepPhoto(file, max) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('That isn’t a photo.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        try {
          var full = max === 1600 ? redraw(img, 1600, 0.82) : redraw(img, 1200, 0.8);
          var thumb = redraw(img, 240, 0.74);
          URL.revokeObjectURL(url);
          resolve({ full: full, thumb: thumb });
        } catch (e) { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); });
      img.src = url;
    });
  }
  /** Thumbnails for the dishes on screen; redraws once when they arrive. */
  function wantThumbs(dishes) {
    var keys = dishes.filter(function (d) { return d.photo && !state.thumbs['d-' + d.id]; }).map(function (d) { return 'd-' + d.id; });
    if (!keys.length) return;
    Promise.all(keys.map(function (k) { return photoGet(k).then(function (p) { if (p) state.thumbs[k] = p.thumb; return Boolean(p); }); }))
      .then(function (got) { if (got.some(Boolean) && $('#sheet').hidden) draw(); });
  }
  function thumbOf(d) { return d.photo ? state.thumbs['d-' + d.id] || '' : ''; }

  /* ---------------- routing ---------------- */

  var VIEWS = ['home', 'place', 'log', 'want', 'browse', 'settings', 'try'];
  var SHARE_PATH = /^s\/([A-Za-z0-9_-]{22})$/;
  function shareCode() { var m = SHARE_PATH.exec(location.pathname.slice(BASE.length)); return m ? m[1] : ''; }
  function route() {
    if (shareCode()) { state.view = 'share'; if (!state.share || state.share.code !== shareCode()) loadShare(shareCode()); draw(); return; }
    var h = (location.hash || '').replace(/^#/, '').split('/');
    var v = VIEWS.indexOf(h[0]) >= 0 ? h[0] : 'home';
    if (v === 'try') { startTry(); return; }
    state.view = v;
    state.arg = h[1] || '';
    if (v === 'log' && (!state.log || state.log.forPlace !== state.arg)) state.log = blankLog(state.arg);
    draw();
  }
  function go(hash) {
    var target = BASE + (hash ? '#' + hash : '');
    if (location.pathname + location.hash !== target) history.pushState(null, '', target);
    route();
    scrollTo(0, 0);
  }
  window.addEventListener('popstate', route);

  function first() { return !state.trying && !data.places.length && !data.wants.length && state.view === 'home'; }
  function draw() {
    var tabs = $('#tabbar');
    tabs.hidden = first() || state.view === 'share';
    var tabFor = state.view === 'place' ? 'home' : state.view;
    $$('[data-act="tab"]', tabs).forEach(function (b) { if (b.getAttribute('data-tab') === tabFor) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var open = D().wants.filter(function (w) { return !w.done; }).length, badge = $('#wantBadge');
    badge.hidden = !open; badge.textContent = open > 99 ? '99+' : String(open);
    var html = ({ home: first() ? viewFirst : viewHome, place: viewPlace, log: viewLog, want: viewWant, browse: viewBrowse, settings: viewSettings, share: viewShare })[state.view]();
    $('#main').innerHTML = (state.trying && state.view !== 'share' ? ribbon() : '') + html;
    after();
  }
  function after() {
    if (state.view === 'home' && !first()) bindHome();
    if (state.view === 'log') bindLog();
    if (state.view === 'browse') bindBrowse();
    if (state.view === 'settings') bindSettings();
  }

  /* ---------------- the first run ---------------- */

  function viewFirst() {
    return '<section class="hero" aria-labelledby="heroTitle"><div class="hero-grid"><div>' +
      '<p class="lab" style="color:var(--hero-soft)">A memory for eating out</p>' +
      '<h1 id="heroTitle">Remember what you loved - and order it again.</h1>' +
      '<p>“What did we get here that we loved?” Log a dish in two taps - ❤️ order again, 👍 fine, 👎 skip. Next time you’re there, Again shows you what to get, and what to skip.</p>' +
      '<div class="cta"><button class="btn big white" type="button" data-act="try">Try it - a made-up list</button><button class="btn big line" type="button" data-act="addfirst">Add a place I loved</button></div>' +
      '<p class="small" style="margin-top:12px">Free, no sign-up. It all stays on this phone.</p></div>' +
      '<div class="mock" aria-hidden="true">' +
      '<div class="mtop"><span class="mtile">🍝</span><span><small>You’re at</small><b>Orzolino</b></span></div>' +
      '<div class="msec"><p class="lab love">❤️ Order again</p><div class="big">Cacio e pepe <span class="x">×3</span></div><div class="big">The burrata</div></div>' +
      '<div class="msec"><p class="lab skip">👎 Skip</p><div class="meh">Tiramisu <i>- too sweet</i></div></div>' +
      '<div class="msec"><p class="lab friend">💬 Friends said try</p><div class="meh">The carbonara <i>- from Alex</i></div></div>' +
      '</div></div></section>' +
      '<section class="card" style="margin-top:16px" aria-labelledby="howTitle"><h2 id="howTitle">How it works</h2><ol class="how">' +
      '<li><div><b>Log it before the bill comes.</b><br><span class="muted">Pick the place, type each dish and tap how it was. A note if you like - “ask for it spicy” - and a photo that stays on your phone.</span></div></li>' +
      '<li><div><b>Open it when you’re back.</b><br><span class="muted">Search the place - “orzolino”, “hickory and hush”, even “ozrolino” - and get one card: what to order again, what was fine, what to skip.</span></div></li>' +
      '<li><div><b>Keep what friends swear by.</b><br><span class="muted">“The mole at Casa Lunaria - from Priya.” When you try it, one tap says whether Priya was right.</span></div></li>' +
      '</ol></section>' +
      '<div class="grid three" style="margin-top:14px">' +
      '<section class="card feat"><span class="ic" aria-hidden="true">📍</span><h3>“I’m here”</h3><p class="muted small">One big card per place, read in a glance at the table: the ❤️ dishes biggest, the soggy fries marked to skip, the last visit and who you were with.</p></section>' +
      '<section class="card feat"><span class="ic" aria-hidden="true">🔖</span><h3>Want to try</h3><p class="muted small">Notes apps and photo rolls are where recommendations go to die. Here they wait with who said it and when - and show up when you’re at the place.</p></section>' +
      '<section class="card feat"><span class="ic" aria-hidden="true">🏙️</span><h3>Your city, your favourites</h3><p class="muted small">Every ❤️ in Riverton, anything with short rib, your favourite cuisine - and a “top dishes” card or a link to send a friend who’s visiting.</p></section>' +
      '</div>';
  }

  /* ---------------- try it ---------------- */

  function startTry() {
    state.trying = true;
    state.tryData = C.sample(ctx());
    state.view = 'home'; state.q = '';
    var target = BASE + '#try';
    if (location.pathname + location.hash !== target) history.replaceState(null, '', target);
    draw(); scrollTo(0, 0);
    say('A made-up list is open. Nothing you do here is saved.');
  }
  function leaveTry(quiet) {
    state.trying = false; state.tryData = null; state.log = null;
    if (!quiet) go('');
  }
  function ribbon() {
    return '<div class="ribbon" role="note"><span>A made-up list - ten places in two cities. Nothing you do here is saved.</span><span class="row"><button class="btn small" type="button" data-act="tryadd">Start my own</button><button class="btn small ghost" type="button" data-act="tryleave">Leave</button></span></div>';
  }

  /* ---------------- home: where are you eating? ---------------- */

  function lastShort(p) {
    var lv = C.lastVisit(C.dishesAt(D(), p.id));
    return lv ? C.ago(lv.day, today()) : 'not logged yet';
  }
  function placeRow(p, act) {
    var c = C.cuisineOf(p.cuisine), loves = C.dishesAt(D(), p.id).filter(function (d) { return d.verdict === 'again'; }).length;
    return '<button class="prow" type="button" data-act="' + esc(act || 'place') + '" data-id="' + esc(p.id) + '"><span class="tile" aria-hidden="true">' + esc(c.emoji) + '</span>' +
      '<span><span class="pname">' + esc(p.name) + '</span><span class="psub">' + esc(placeSub(p) || c.label) + '</span></span>' +
      '<span class="pmeta">' + (loves ? esc('❤️ ' + loves) : '') + '<br><span class="muted">' + esc(lastShort(p)) + '</span></span></button>';
  }
  function resultsHtml(q) {
    var d = D(), rows = C.searchPlaces(d, q);
    var out = '';
    if (!C.fold(q)) {
      if (!rows.length) return '<section class="card empty" style="margin-top:12px"><div class="ic" aria-hidden="true">🍽️</div><p class="muted">No places yet. Log the first one - it takes seconds.</p><button class="btn" type="button" data-act="tab" data-tab="log">Log a visit</button></section>';
      out += '<h2 class="lab" style="margin-top:14px">Recent</h2>' + rows.slice(0, 8).map(function (r) { return placeRow(r.place); }).join('');
      if (rows.length > 8) out += '<p class="small" style="margin-top:10px"><button class="link-btn" type="button" data-act="tab" data-tab="browse">All ' + plural(rows.length, 'place') + '</button></p>';
      return out;
    }
    out += rows.slice(0, 8).map(function (r) { return placeRow(r.place); }).join('');
    var fq = C.fold(q);
    var wants = d.wants.filter(function (w) { return !w.done && C.matchScore(fq, C.fold(w.place)) >= 58 && !d.places.some(function (p) { return C.fold(p.name) === C.fold(w.place); }); }).slice(0, 3);
    wants.forEach(function (w) {
      out += '<button class="prow" type="button" data-act="tab" data-tab="want"><span class="tile" aria-hidden="true">🔖</span><span><span class="pname">' + esc(w.place) + '</span><span class="psub">' + esc((w.from ? w.from + ' said try ' : 'On your Want to try: ') + (w.dish || 'it')) + '</span></span><span class="pmeta muted">Want to try</span></button>';
    });
    if (!rows.length && !wants.length) out += '<p class="muted" style="margin:12px 0 0">No place matches “' + esc(q) + '”.</p>';
    out += '<button class="newplace" type="button" data-act="newplace" data-name="' + esc(C.plain(q, C.LIMITS.place)) + '"><span aria-hidden="true">＋</span><span>Log a visit to “' + esc(C.plain(q, C.LIMITS.place)) + '”</span></button>';
    return out;
  }
  function viewHome() {
    var d = D(), t = today();
    var open = d.wants.filter(function (w) { return !w.done; });
    var out = '<div class="sec-head"><h1>Where are you eating?</h1></div>' +
      '<div class="search-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' +
      '<input class="input search" id="q" type="search" placeholder="Search your places" autocomplete="off" autocapitalize="none" enterkeyhint="search" aria-label="Search your places - by name, neighbourhood, city or cuisine" value="' + esc(state.q) + '"></div>' +
      '<p class="tiny muted" style="margin:6px 4px 0">Try a name, a neighbourhood, a city or a cuisine - accents, “the” and “&amp;” don’t matter, and a typo is fine.</p>' +
      '<div id="results">' + resultsHtml(state.q) + '</div>';
    if (open.length) out += '<section class="card" style="margin-top:14px"><div class="row spread"><div><h2 style="margin:0">🔖 ' + esc(plural(open.length, 'pick') + ' from friends to try') + '</h2><p class="small muted" style="margin:2px 0 0">' + esc(open.slice(0, 2).map(C.wantTitle).join(' · ')) + '</p></div><button class="btn small ghost" type="button" data-act="tab" data-tab="want">See them</button></div></section>';
    var s = C.stats(d, { today: t });
    if (d.dishes.length) out += '<p class="small muted" style="margin-top:14px">' + esc(plural(s.places, 'place') + ' · ' + plural(s.dishes, 'dish', 'dishes') + ' · ' + s.again + ' to order again') + ' · <button class="link-btn" type="button" data-act="tab" data-tab="browse">Browse</button></p>';
    return out;
  }
  function bindHome() {
    var q = $('#q'); if (!q) return;
    q.addEventListener('input', function () { state.q = q.value; $('#results').innerHTML = resultsHtml(state.q); });
    q.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var first1 = $('#results .prow[data-act="place"]');
      if (first1) { e.preventDefault(); openPlace(first1.getAttribute('data-id')); }
    });
  }
  function openPlace(id) { state.q = ''; go('place/' + id); }

  /* ---------------- I'm here: one place, at a glance ---------------- */

  function dishRow(d, kind) {
    var t = thumbOf(d), count = C.times(d);
    return '<button class="dish" type="button" data-act="dish" data-id="' + esc(d.id) + '"><span><span class="dn">' + esc(d.name) + '</span>' + (d.note ? '<span class="dnote">' + esc(d.note) + '</span>' : '') + '</span>' +
      '<span class="side">' + (kind === 'again' && count > 1 ? '<span class="times" aria-label="' + esc('ordered ' + count + ' times') + '">×' + count + '</span>' : '') + (t ? '<img class="thumb" alt="" src="' + esc(t) + '">' : '') + '</span></button>';
  }
  function viewPlace() {
    var p = findPlace(state.arg);
    if (!p) return '<section class="card empty"><div class="ic" aria-hidden="true">🍽️</div><p>That place isn’t here any more.</p><button class="btn" type="button" data-act="home">Back to my places</button></section>';
    var card = C.hereCard(p, D(), ctx());
    wantThumbs(card.again.concat(card.fine, card.skip));
    var out = '<div class="grid split"><article class="here" aria-labelledby="hereName">' +
      '<header class="here-top"><span class="tile" aria-hidden="true">' + esc(card.cuisine.emoji) + '</span><div><small>You’re at</small><h1 id="hereName">' + esc(p.name) + '</h1>' +
      '<p>' + esc([placeSub(p), card.cuisine.label].filter(Boolean).join(' · ')) + '</p><p>' + esc(card.lastText + (card.visits > 1 ? ' · ' + card.visits + ' visits' : '')) + '</p></div></header>';
    out += '<section class="hsec love" aria-labelledby="secLove"><h2 id="secLove">❤️ Order again</h2>' + (card.again.length ? card.again.map(function (d) { return dishRow(d, 'again'); }).join('') : '<p class="none">Nothing marked ❤️ here yet - tap “I’m having…” and log tonight’s.</p>') + '</section>';
    if (card.fine.length) out += '<section class="hsec fine" aria-labelledby="secFine"><h2 id="secFine">👍 Fine</h2>' + card.fine.map(function (d) { return dishRow(d, 'fine'); }).join('') + '</section>';
    if (card.skip.length) out += '<section class="hsec skip" aria-labelledby="secSkip"><h2 id="secSkip">👎 Skip</h2>' + card.skip.map(function (d) { return dishRow(d, 'skip'); }).join('') + '</section>';
    if (card.friends.length) {
      out += '<section class="hsec friends" aria-labelledby="secFriends"><h2 id="secFriends">💬 Friends said try</h2>' + card.friends.map(function (w) {
        return '<div class="friend"><span><b>' + esc(w.dish || 'This place') + '</b> <span class="muted small">' + esc((w.from ? 'from ' + w.from : 'from a shared list') + ' · ' + C.shortDay(w.day, today())) + '</span>' + (w.note ? '<span class="dnote">' + esc(w.note) + '</span>' : '') + '</span>' +
          '<button class="btn small soft" type="button" data-act="trywant" data-id="' + esc(w.id) + '">Tried it</button></div>';
      }).join('') + '</section>';
    }
    out += '<div class="here-acts"><button class="btn" type="button" data-act="log" data-id="' + esc(p.id) + '">I’m having…</button><button class="btn ghost ai" type="button" data-act="reader" data-id="' + esc(p.id) + '"> Read the menu</button></div></article>';
    // Visits: the days, and who was there.
    var days = {};
    C.dishesAt(D(), p.id).forEach(function (d) { d.orders.forEach(function (x) { var e = days[x.day] || (days[x.day] = { day: x.day, with: [], n: 0 }); e.n++; x.with.forEach(function (nm) { if (e.with.indexOf(nm) < 0) e.with.push(nm); }); }); });
    var visits = Object.keys(days).sort().reverse().map(function (k) { return days[k]; });
    out += '<div class="stack">';
    if (visits.length) {
      out += '<section class="card"><h2>Visits</h2>' + visits.slice(0, 12).map(function (v) {
        return '<div class="lrow"><span><b>' + esc(C.shortDay(v.day, today())) + '</b> <span class="muted small">' + esc(v.with.length ? 'with ' + C.listNames(v.with) : 'just you, or nobody noted') + '</span></span><span class="small muted">' + esc(plural(v.n, 'dish', 'dishes')) + '</span></div>';
      }).join('') + '</section>';
    }
    out += '<div class="row"><button class="btn small ghost" type="button" data-act="editplace" data-id="' + esc(p.id) + '">Edit this place</button><button class="btn small ghost" type="button" data-act="home">All my places</button></div></div></div>';
    return out;
  }

  /* ---------------- a dish ---------------- */

  function openDish(id) {
    var d = findDish(id); if (!d) return;
    var p = findPlace(d.placeId);
    var vb = function (v) { var x = C.verdictOf(v); return '<button class="vbtn ' + esc(v) + '" type="button" data-v="' + esc(v) + '" aria-pressed="' + (d.verdict === v) + '"><span class="e" aria-hidden="true">' + esc(x.emoji) + '</span><small>' + esc(x.label) + '</small></button>'; };
    var orders = d.orders.map(function (x) { return esc(C.shortDay(x.day, today()) + (x.with.length ? ' with ' + C.listNames(x.with) : '')); }).join(' · ');
    sheet('<h2>' + esc(d.name) + '</h2><p class="small muted">' + esc((p ? p.name : '') + ' · ' + 'ordered ' + plural(C.times(d), 'time')) + '</p>' +
      '<div class="vbtns" id="dsV" role="group" aria-label="Verdict">' + C.VERDICT_IDS.map(vb).join('') + '</div>' +
      '<div class="stack" style="margin-top:12px"><label class="field"><span>Name</span><input class="input" id="dsName" maxlength="80" value="' + esc(d.name) + '"></label>' +
      '<label class="field"><span>Note <span class="hint">one line - “ask for it spicy”</span></span><input class="input" id="dsNote" maxlength="140" value="' + esc(d.note) + '"></label>' +
      '<label class="field"><span>Price</span><input class="input" id="dsPrice" inputmode="decimal" style="max-width:160px" placeholder="' + esc(C.decimal(1800)) + '" value="' + esc(d.price !== null ? C.decimal(d.price) : '') + '"></label>' +
      '<div class="field"><span>Photo</span><div id="dsPhoto" class="row"></div><label class="btn small ghost file-btn">📷 ' + (d.photo ? 'Replace the photo' : 'Add a photo') + '<input class="vh" id="dsFile" type="file" accept="image/*"></label><span class="tiny muted">Shrunk on this phone, its location removed, and kept only here.</span></div>' +
      '<p class="small muted">' + orders + '</p></div>' +
      '<div id="dsErr"></div><div class="row" style="margin-top:8px"><button class="btn" type="button" id="dsSave">Save</button><button class="btn ghost" type="button" id="dsDel">Delete this dish</button></div>', function (root) {
      var verdict = d.verdict, photo = null;
      $$('[data-v]', root).forEach(function (b) { b.addEventListener('click', function () { verdict = b.getAttribute('data-v'); $$('[data-v]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }); });
      if (d.photo) photoGet('d-' + d.id).then(function (ph) { if (ph) $('#dsPhoto', root).innerHTML = '<img alt="' + esc('Photo of ' + d.name) + '" src="' + esc(ph.full) + '" class="big-photo" style="max-height:220px"><button class="btn small ghost" type="button" id="dsNoPhoto">Remove the photo</button>'; var np = $('#dsNoPhoto', root); if (np) np.addEventListener('click', function () { photo = 'remove'; $('#dsPhoto', root).innerHTML = '<span class="small muted">The photo goes when you save.</span>'; }); });
      $('#dsFile', root).addEventListener('change', function (e) {
        prepPhoto(e.target.files[0]).then(function (ph) { photo = ph; $('#dsPhoto', root).innerHTML = '<img alt="" src="' + esc(ph.thumb) + '" style="width:72px;height:72px;object-fit:cover;border-radius:10px"><span class="small muted">Kept on this phone when you save.</span>'; })
          .catch(function (err) { showError(err, $('#dsErr', root)); });
      });
      $('#dsSave', root).addEventListener('click', function () {
        var price = $('#dsPrice', root).value.trim();
        if (price && C.readMoney(price) === null) { $('#dsErr', root).innerHTML = '<p class="err">That price doesn’t read as an amount.</p>'; return; }
        var next = C.editDish(d, { verdict: verdict, name: $('#dsName', root).value, note: $('#dsNote', root).value, price: price, photo: photo === 'remove' ? false : (photo ? true : d.photo) }, ctx());
        var done = function () { var dd = D(); setD(Object.assign({}, dd, { dishes: dd.dishes.map(function (x) { return x.id === d.id ? next : x; }) })); closeSheet(true); draw(); toast('Saved.'); };
        if (photo === 'remove') { if (!state.trying) photoDel('d-' + d.id); done(); }
        else if (photo && typeof photo === 'object') { if (state.trying) { memPhotos['d-' + d.id] = photo; state.thumbs['d-' + d.id] = photo.thumb; done(); } else photoPut('d-' + d.id, photo).then(done); }
        else done();
      });
      $('#dsDel', root).addEventListener('click', function () {
        if (!confirm('Delete “' + d.name + '”' + (d.photo ? ' and its photo' : '') + '? This can’t be undone.')) return;
        var prev = D();
        setD(C.removeIds(prev, [d.id], ctx()));
        if (d.photo && !state.trying) photoDel('d-' + d.id);
        closeSheet(true); draw(); toast('Deleted.');
      });
    });
  }

  function openEditPlace(id) {
    var p = findPlace(id); if (!p) return;
    var pick = p.cuisine;
    sheet('<h2>Edit ' + esc(p.name) + '</h2><div class="stack">' +
      '<label class="field"><span>Name</span><input class="input" id="epName" maxlength="60" value="' + esc(p.name) + '"></label>' +
      '<div class="row"><label class="field" style="flex:1 1 160px"><span>Neighbourhood</span><input class="input" id="epArea" maxlength="40" value="' + esc(p.area) + '"></label><label class="field" style="flex:1 1 160px"><span>City</span><input class="input" id="epCity" maxlength="40" value="' + esc(p.city) + '"></label></div>' +
      '<div class="field"><span>Cuisine</span><div class="cuisines" id="epCu">' + C.CUISINES.map(function (c) { return '<button class="chip" type="button" data-cu="' + esc(c.id) + '" aria-pressed="' + (pick === c.id) + '">' + esc(c.emoji + ' ' + c.label) + '</button>'; }).join('') + '</div></div>' +
      '</div><div id="epErr"></div><div class="row" style="margin-top:12px"><button class="btn" type="button" id="epSave">Save</button><button class="btn ghost" type="button" id="epDel">Delete this place</button></div>', function (root) {
      $('#epCu', root).addEventListener('click', function (e) { var b = e.target.closest('[data-cu]'); if (!b) return; pick = b.getAttribute('data-cu'); $$('[data-cu]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); });
      $('#epSave', root).addEventListener('click', function () {
        var next = C.editPlace(p, { name: $('#epName', root).value, area: $('#epArea', root).value, city: $('#epCity', root).value, cuisine: pick }, ctx());
        var dd = D(); setD(Object.assign({}, dd, { places: dd.places.map(function (x) { return x.id === p.id ? next : x; }) }));
        closeSheet(true); draw(); toast('Saved.');
      });
      $('#epDel', root).addEventListener('click', function () {
        var n = C.dishesAt(D(), p.id).length;
        if (!confirm('Delete ' + p.name + (n ? ' and its ' + plural(n, 'dish', 'dishes') + ' (and their photos)' : '') + '? This can’t be undone.')) return;
        if (!state.trying) C.dishesAt(D(), p.id).forEach(function (d) { if (d.photo) photoDel('d-' + d.id); });
        setD(C.removePlace(D(), p.id, ctx()));
        closeSheet(true); go(''); toast('Deleted.');
      });
    });
  }

  /* ---------------- logging a visit: seconds, not minutes ---------------- */

  function blankLog(placeId) {
    return { forPlace: placeId || '', placeId: findPlace(placeId) ? placeId : '', q: '', place: { name: '', area: '', city: '', cuisine: '' }, day: today(), with: [], items: [], photos: {}, more: -1, allCu: false };
  }
  function knownPeople() {
    var seen = {}, out = [];
    D().dishes.slice().sort(function (a, b) { return C.lastDay(a) < C.lastDay(b) ? 1 : -1; }).forEach(function (d) { d.orders.forEach(function (x) { x.with.forEach(function (n) { var k = C.fold(n); if (!seen[k]) { seen[k] = 1; out.push(n); } }); }); });
    return out.slice(0, 12);
  }
  function usedCities() { return C.citiesOf(D()).map(function (c) { return c.city; }); }
  function vbtn(v, extra) { var x = C.verdictOf(v); return '<button class="vbtn ' + esc(v) + '" type="button" data-qv="' + esc(v) + '"' + (extra || '') + '><span class="e" aria-hidden="true">' + esc(x.emoji) + '</span><small>' + esc(x.label) + '</small></button>'; }
  function viewLog() {
    var L = state.log, p = findPlace(L.placeId);
    var out = '<div class="sec-head"><h1>' + (p ? 'At ' + esc(p.name) : 'Log a visit') + '</h1>' + (p ? '<button class="btn small ghost" type="button" data-act="place" data-id="' + esc(p.id) + '">Back to the card</button>' : '') + '</div><div class="log-grid"><div class="stack">';
    out += '<section class="card stack" aria-labelledby="whereH"><h2 id="whereH" style="margin:0">Where</h2>';
    if (p) {
      out += '<div class="picked"><span class="tile" aria-hidden="true">' + esc(C.cuisineOf(p.cuisine).emoji) + '</span><div><b>' + esc(p.name) + '</b><div class="small muted">' + esc(placeSub(p)) + '</div></div><button class="link-btn" type="button" data-act="logchange">Change</button></div>';
    } else {
      out += '<div class="search-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg><input class="input search" id="lq" type="search" autocomplete="off" placeholder="Pick a place, or type a new one" aria-label="The place" value="' + esc(L.q) + '"></div><div id="lres">' + logResults() + '</div>';
    }
    out += '</section>';
    out += '<section class="card stack" aria-labelledby="hadH"><h2 id="hadH" style="margin:0">What did you have?</h2><div class="quick">' +
      '<input class="input" id="lDish" maxlength="80" placeholder="Cacio e pepe" autocomplete="off" enterkeyhint="next" aria-label="A dish">' +
      '<div class="vbtns" role="group" aria-label="Add it as">' + C.VERDICT_IDS.map(function (v) { return vbtn(v); }).join('') + '</div>' +
      '<p class="tiny muted" style="margin:0">Type it, then tap how it was. One tap per dish.</p></div>';
    var known = p ? C.dishesAt(D(), p.id).slice().sort(function (a, b) { return (a.verdict === 'again' ? 0 : 1) - (b.verdict === 'again' ? 0 : 1) || C.times(b) - C.times(a); }) : [];
    if (known.length) out += '<div class="field"><span>Had one of these again? <span class="hint">tap to add it</span></span><div class="known">' + known.slice(0, 16).map(function (d) { return '<button class="chip" type="button" data-known="' + esc(d.id) + '">' + esc(C.verdictOf(d.verdict).emoji + ' ' + d.name) + '</button>'; }).join('') + '</div></div>';
    out += '<div class="items" id="lItems">' + itemsHtml() + '</div></section></div><div class="stack">';
    var y = C.addDays(today(), -1);
    out += '<section class="card stack" aria-labelledby="whenH"><h2 id="whenH" style="margin:0">When, and who with</h2>' +
      '<div class="row"><div class="seg" role="group" aria-label="When"><button type="button" data-day="' + esc(today()) + '" aria-pressed="' + (L.day === today()) + '">Today</button><button type="button" data-day="' + esc(y) + '" aria-pressed="' + (L.day === y) + '">Yesterday</button></div><input class="input" id="lDay" type="date" max="' + esc(today()) + '" value="' + esc(L.day) + '" style="max-width:180px" aria-label="The day"></div>' +
      '<div class="field"><span>Who was there <span class="hint">first names, if you like</span></span><div class="known" id="lWith">' + peopleHtml() + '</div>' +
      '<div class="row"><input class="input" id="lPerson" maxlength="24" placeholder="Add a name" style="flex:1 1 160px" autocomplete="off" aria-label="A first name"><button class="btn small ghost" type="button" id="lPersonAdd">Add</button></div></div></section>';
    out += '<div id="lErr"></div><button class="btn big block" type="button" id="lSave">' + esc(saveLabel()) + '</button>' +
      '<button class="btn ghost block ai" type="button" data-act="reader" data-id="' + esc(L.placeId) + '"> Read the menu instead</button></div></div>';
    return out;
  }
  function peopleHtml() {
    var L = state.log, people = knownPeople();
    L.with.forEach(function (n) { if (!people.some(function (x) { return C.fold(x) === C.fold(n); })) people.unshift(n); });
    return people.map(function (n) { var on = L.with.some(function (x) { return C.fold(x) === C.fold(n); }); return '<button class="chip person" type="button" data-person="' + esc(n) + '" aria-pressed="' + on + '">' + esc(n) + '</button>'; }).join('');
  }
  function logResults() {
    var L = state.log, q = L.q, d = D();
    var rows = C.searchPlaces(d, q).slice(0, q ? 5 : 4);
    var out = rows.map(function (r) { return placeRow(r.place, 'logpick'); }).join('');
    if (C.fold(q)) {
      var cities = usedCities();
      if (!L.place.city && cities.length === 1) L.place.city = cities[0];
      out += '<div class="note stack" style="margin-top:10px"><b>New place: ' + esc(C.plain(q, C.LIMITS.place)) + '</b>' +
        '<div class="row"><label class="field" style="flex:1 1 150px"><span>Neighbourhood</span><input class="input" id="lArea" maxlength="40" value="' + esc(L.place.area) + '" placeholder="Old Mill"></label>' +
        '<label class="field" style="flex:1 1 150px"><span>City</span><input class="input" id="lCity" maxlength="40" value="' + esc(L.place.city) + '" placeholder="Riverton" list="cityList"></label></div>' +
        '<datalist id="cityList">' + cities.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
        '<div class="field"><span>Cuisine</span><div class="cuisines" id="lCu">' + cuisineChips() + '</div></div></div>';
    }
    return out;
  }
  function cuisineChips() {
    var L = state.log, used = C.cuisinesOf(D()).map(function (c) { return c.id; });
    var common = ['italian', 'mexican', 'japanese', 'noodles', 'chinese', 'indian', 'thai', 'american', 'pizza', 'cafe'];
    var show = L.allCu ? C.CUISINE_IDS : used.concat(common.filter(function (x) { return used.indexOf(x) < 0; })).slice(0, 10);
    if (L.place.cuisine && show.indexOf(L.place.cuisine) < 0) show = [L.place.cuisine].concat(show);
    return show.map(function (id) { var c = C.cuisineOf(id); return '<button class="chip" type="button" data-cu="' + esc(c.id) + '" aria-pressed="' + (L.place.cuisine === c.id) + '">' + esc(c.emoji + ' ' + c.label) + '</button>'; }).join('') +
      (L.allCu ? '' : '<button class="chip" type="button" data-cu="__more">More…</button>');
  }
  function itemsHtml() {
    var L = state.log;
    if (!L.items.length) return '';
    return L.items.map(function (it, i) {
      var open = L.more === i;
      var sub = [it.note, it.price ? money(C.readMoney(it.price) || 0) : '', L.photos[i] ? '📷' : ''].filter(Boolean).join(' · ');
      return '<div class="irow"><button class="link-btn nm" type="button" data-imore="' + i + '" style="text-align:left;text-decoration:none;color:var(--text)" aria-expanded="' + open + '">' + esc(it.name) + '<small>' + esc(sub || 'Note, price, photo') + '</small></button>' +
        '<span class="vmini" role="group" aria-label="' + esc('How ' + it.name + ' was') + '">' + C.VERDICT_IDS.map(function (v) { var y = C.verdictOf(v); return '<button type="button" class="' + esc(v) + '" data-iv="' + i + '" data-v="' + esc(v) + '" aria-pressed="' + (it.verdict === v) + '" aria-label="' + esc(y.label) + '">' + esc(y.emoji) + '</button>'; }).join('') + '</span>' +
        (open ? '<div class="extra"><label class="field"><span>Note</span><input class="input" data-inote="' + i + '" maxlength="140" value="' + esc(it.note) + '" placeholder="Ask for it spicy"></label>' +
          '<div class="row"><label class="field" style="flex:0 1 150px"><span>Price</span><input class="input" data-iprice="' + i + '" inputmode="decimal" value="' + esc(it.price || '') + '" placeholder="' + esc(C.decimal(1800)) + '"></label>' +
          '<label class="btn small ghost file-btn" style="align-self:end">📷 ' + (L.photos[i] ? 'Replace photo' : 'Photo') + '<input class="vh" type="file" accept="image/*" data-iphoto="' + i + '"></label></div>' +
          '<p class="tiny muted" style="margin:0">Photos are shrunk on this phone and their location is removed. They stay on this phone.</p>' +
          '<button class="btn small ghost" type="button" data-irm="' + i + '" style="justify-self:start">' + esc('Remove ' + it.name) + '</button></div>' : '') +
        '</div>';
    }).join('');
  }
  function saveLabel() { var n = state.log.items.length; return n ? 'Save · ' + plural(n, 'dish', 'dishes') : 'Save'; }
  function redrawItems() { var box = $('#lItems'); if (box) box.innerHTML = itemsHtml(); var s = $('#lSave'); if (s) s.textContent = saveLabel(); }
  function bindLog() {
    var L = state.log;
    var lq = $('#lq');
    if (lq) {
      lq.addEventListener('input', function () { L.q = lq.value; L.place.name = lq.value; $('#lres').innerHTML = logResults(); });
      $('#lres').addEventListener('input', function (e) { if (e.target.id === 'lArea') L.place.area = e.target.value; if (e.target.id === 'lCity') L.place.city = e.target.value; });
      $('#lres').addEventListener('click', function (e) {
        var b = e.target.closest('[data-cu]'); if (!b) return;
        if (b.getAttribute('data-cu') === '__more') { L.allCu = true; $('#lCu').innerHTML = cuisineChips(); return; }
        L.place.cuisine = b.getAttribute('data-cu'); $$('#lCu [data-cu]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      });
    }
    $$('[data-day]').forEach(function (b) { b.addEventListener('click', function () { L.day = b.getAttribute('data-day'); $('#lDay').value = L.day; $$('[data-day]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }); });
    $('#lDay').addEventListener('change', function (e) { if (C.isDay(e.target.value)) L.day = e.target.value; $$('[data-day]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-day') === L.day)); }); });
    $('#lWith').addEventListener('click', function (e) {
      var b = e.target.closest('[data-person]'); if (!b) return;
      var n = b.getAttribute('data-person'), i = L.with.findIndex(function (x) { return C.fold(x) === C.fold(n); });
      if (i >= 0) L.with.splice(i, 1); else if (L.with.length < C.LIMITS.with) L.with.push(n);
      b.setAttribute('aria-pressed', String(i < 0));
    });
    var addPerson = function () {
      var n = C.cleanPerson($('#lPerson').value); if (!n) { $('#lPerson').value = ''; return; }
      if (!L.with.some(function (x) { return C.fold(x) === C.fold(n); }) && L.with.length < C.LIMITS.with) L.with.push(n);
      $('#lWith').innerHTML = peopleHtml(); $('#lPerson').value = ''; $('#lPerson').focus();
    };
    $('#lPersonAdd').addEventListener('click', addPerson);
    $('#lPerson').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } });
    var dish = $('#lDish');
    var add = function (v) {
      if (!C.hasWord(C.plain(dish.value, C.LIMITS.dish))) { dish.focus(); say('Type the dish first.'); return; }
      var name = C.plain(dish.value, C.LIMITS.dish);
      var before = L.items.length;
      L.items = C.quickAdd(L.items, name, v).map(function (x) { return x.note === undefined ? Object.assign({ note: '', price: '' }, x) : x; });
      dish.value = ''; dish.focus(); redrawItems();
      say((L.items.length > before ? 'Added ' : 'Changed ') + name + ': ' + C.verdictOf(v).label + '.');
    };
    $$('[data-qv]').forEach(function (b) { b.addEventListener('click', function () { add(b.getAttribute('data-qv')); }); });
    dish.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (C.hasWord(dish.value)) { var f = $('[data-qv="again"]'); if (f) f.focus(); say('Now tap how it was.'); } } });
    $$('[data-known]').forEach(function (b) { b.addEventListener('click', function () { var d = findDish(b.getAttribute('data-known')); if (!d) return; L.items = C.quickAdd(L.items, d.name, d.verdict).map(function (x) { return x.note === undefined ? Object.assign({ note: '', price: '' }, x) : x; }); redrawItems(); say('Added ' + d.name + '.'); }); });
    var box = $('#lItems');
    box.addEventListener('click', function (e) {
      var t = e.target.closest('[data-iv],[data-irm],[data-imore]'); if (!t) return;
      if (t.hasAttribute('data-iv')) { var i = Number(t.getAttribute('data-iv')); L.items[i] = Object.assign({}, L.items[i], { verdict: t.getAttribute('data-v') }); redrawItems(); return; }
      if (t.hasAttribute('data-irm')) { var j = Number(t.getAttribute('data-irm')); L.items.splice(j, 1); var ph = {}; Object.keys(L.photos).forEach(function (k) { var n = Number(k); if (n < j) ph[n] = L.photos[k]; else if (n > j) ph[n - 1] = L.photos[k]; }); L.photos = ph; L.more = -1; redrawItems(); return; }
      var m = Number(t.getAttribute('data-imore')); L.more = L.more === m ? -1 : m; redrawItems();
      var f = $('[data-inote="' + m + '"]'); if (f) f.focus();
    });
    box.addEventListener('input', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-inote')) L.items[Number(t.getAttribute('data-inote'))].note = t.value;
      if (t.hasAttribute('data-iprice')) L.items[Number(t.getAttribute('data-iprice'))].price = t.value;
    });
    box.addEventListener('change', function (e) {
      var t = e.target; if (!t.hasAttribute('data-iphoto')) return;
      var i = Number(t.getAttribute('data-iphoto'));
      prepPhoto(t.files[0]).then(function (ph) { L.photos[i] = ph; redrawItems(); }).catch(function (err) { showError(err, $('#lErr')); });
    });
    $('#lSave').addEventListener('click', saveLog);
  }
  function saveLog() {
    var L = state.log, err = $('#lErr');
    var pending = C.plain(($('#lDish') || {}).value || '', C.LIMITS.dish);
    if (C.hasWord(pending) && !L.items.some(function (x) { return C.dishKey(x.name) === C.dishKey(pending); })) { err.innerHTML = '<p class="err" role="alert">' + esc('Tap ❤️, 👍 or 👎 for “' + pending + '” first - or clear it.') + '</p>'; return; }
    for (var k = 0; k < L.items.length; k++) if (L.items[k].price && C.readMoney(L.items[k].price) === null) { err.innerHTML = '<p class="err" role="alert">' + esc('The price for ' + L.items[k].name + ' doesn’t read as an amount.') + '</p>'; return; }
    var input = { placeId: L.placeId || '', place: L.placeId ? null : { name: L.q, area: L.place.area, city: L.place.city, cuisine: L.place.cuisine || 'other' }, day: L.day, with: L.with, items: L.items.map(function (it, i) { return { name: it.name, verdict: it.verdict, note: it.note, price: it.price, photo: Boolean(L.photos[i]) }; }) };
    var prev = D();
    var r = C.logVisit(prev, input, ctx());
    if (r.error) { err.innerHTML = '<p class="err" role="alert">' + esc(r.error) + '</p>'; return; }
    var writes = [];
    L.items.forEach(function (it, i) {
      var ph = L.photos[i]; if (!ph) return;
      var dd = r.data.dishes.find(function (x) { return x.placeId === r.place.id && C.dishKey(x.name) === C.dishKey(it.name); });
      if (!dd) return;
      if (state.trying) { memPhotos['d-' + dd.id] = ph; state.thumbs['d-' + dd.id] = ph.thumb; } else writes.push(photoPut('d-' + dd.id, ph));
    });
    var n = L.items.length, place = r.place, settled = C.settleWants(r.data, place.id, r.touched, ctx());
    Promise.all(writes).then(function () {
      setD(settled.data);
      state.log = null;
      go('place/' + place.id);
      toast('Saved ' + plural(n, 'dish', 'dishes') + ' at ' + place.name + '.' + (settled.lines.length ? ' ' + settled.lines.join(' · ') : ''), 4800, { label: 'Undo', fn: function () { setD(prev); draw(); say('Undone.'); } });
    });
  }

  /* ---------------- want to try ---------------- */

  function wantRow(w) {
    var p = D().places.find(function (x) { return C.fold(x.name) === C.fold(w.place) && (!w.city || !x.city || C.cityKey(x.city) === C.cityKey(w.city)); });
    return '<div class="wrow"><div class="what">' + esc(C.wantTitle(w)) + '</div>' +
      '<div class="who">' + esc((w.from ? 'from ' + w.from : w.via === 'link' ? 'from a shared list' : 'your own note') + ' · ' + C.ago(w.day, today()) + ([w.area, w.city].filter(Boolean).length ? ' · ' + [w.area, w.city].filter(Boolean).join(', ') : '')) + '</div>' +
      (w.note ? '<p class="say">“' + esc(w.note) + '”</p>' : '') +
      '<div class="acts"><button class="btn small" type="button" data-act="trywant" data-id="' + esc(w.id) + '">Tried it</button>' + (p ? '<button class="btn small ghost" type="button" data-act="place" data-id="' + esc(p.id) + '">I’m here</button>' : '') + '<button class="btn small ghost" type="button" data-act="delwant" data-id="' + esc(w.id) + '">Remove</button></div></div>';
  }
  function viewWant() {
    var d = D(), open = d.wants.filter(function (w) { return !w.done; }), tried = d.wants.filter(function (w) { return w.done; }).sort(function (a, b) { return a.done.day < b.done.day ? 1 : -1; });
    var out = '<div class="sec-head"><h1>Want to try</h1><button class="btn small" type="button" data-act="addwant">+ A friend’s pick</button></div>' +
      '<p class="muted">Dishes and places friends recommended, with who said it and when. Try one, tap how it was, and it joins your list.</p>';
    if (!open.length) out += '<section class="card empty"><div class="ic" aria-hidden="true">🔖</div><p class="muted">Nothing waiting. Next time someone says “you have to try the…”, add it here.</p><button class="btn" type="button" data-act="addwant">Add a friend’s pick</button></section>';
    var byCity = {};
    open.forEach(function (w) { var k = C.cityKey(w.city) || '~'; (byCity[k] = byCity[k] || { city: w.city || 'Anywhere', list: [] }).list.push(w); });
    Object.keys(byCity).sort().forEach(function (k) {
      var g = byCity[k];
      out += '<section class="card" style="margin-top:12px"><h2>' + esc(g.city) + ' <span class="muted small">' + esc(plural(g.list.length, 'pick')) + '</span></h2>' + g.list.sort(function (a, b) { return a.day < b.day ? 1 : -1; }).map(wantRow).join('') + '</section>';
    });
    if (tried.length) {
      out += '<section class="card" style="margin-top:12px"><h2>Tried</h2>' + tried.map(function (w) {
        return '<div class="tried"><b>' + esc(C.triedLine(w, w.done.verdict)) + '</b><span class="muted small">' + esc(C.wantTitle(w) + ' · ' + C.shortDay(w.done.day, today())) + '</span></div>';
      }).join('') + '</section>';
    }
    return out;
  }
  function openAddWant() {
    var d = D(), cities = usedCities();
    sheet('<h2>A friend’s pick</h2><p class="small muted">Who said what, so you remember when you’re there.</p><div class="stack">' +
      '<label class="field"><span>The dish <span class="hint">optional - “the mole”</span></span><input class="input" id="awDish" maxlength="80" autocomplete="off"></label>' +
      '<label class="field"><span>The place</span><input class="input" id="awPlace" maxlength="60" autocomplete="off" list="awPlaces"></label>' +
      '<datalist id="awPlaces">' + d.places.map(function (p) { return '<option value="' + esc(p.name) + '">'; }).join('') + '</datalist>' +
      '<div class="row"><label class="field" style="flex:1 1 150px"><span>Neighbourhood</span><input class="input" id="awArea" maxlength="40"></label><label class="field" style="flex:1 1 150px"><span>City</span><input class="input" id="awCity" maxlength="40" list="awCities"' + (cities.length === 1 ? ' value="' + esc(cities[0]) + '"' : '') + '></label></div>' +
      '<datalist id="awCities">' + cities.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
      '<label class="field"><span>Who said it <span class="hint">a first name</span></span><input class="input" id="awFrom" maxlength="24" autocomplete="off"></label>' +
      '<label class="field"><span>What they said <span class="hint">optional</span></span><input class="input" id="awNote" maxlength="140" placeholder="Get it with the handmade tortillas"></label>' +
      '</div><div id="awErr"></div><button class="btn block" type="button" id="awSave" style="margin-top:12px">Save to Want to try</button>', function (root) {
      $('#awPlace', root).addEventListener('change', function () { var p = d.places.find(function (x) { return x.name === $('#awPlace', root).value; }); if (p) { $('#awArea', root).value = p.area; $('#awCity', root).value = p.city; } });
      $('#awSave', root).addEventListener('click', function () {
        if (D().wants.length >= C.LIMITS.wants) { $('#awErr', root).innerHTML = '<p class="err">That’s ' + C.LIMITS.wants + ' picks - remove a few tried ones first.</p>'; return; }
        var r = C.newWant({ dish: $('#awDish', root).value, place: $('#awPlace', root).value, area: $('#awArea', root).value, city: $('#awCity', root).value, from: $('#awFrom', root).value, note: $('#awNote', root).value }, ctx());
        if (r.error) { $('#awErr', root).innerHTML = '<p class="err" role="alert">' + esc(r.error) + '</p>'; return; }
        var dd = D(); setD(Object.assign({}, dd, { wants: dd.wants.concat([r.want]) }));
        closeSheet(true); go('want'); toast('Saved to Want to try.');
      });
    });
  }
  function openTryWant(id) {
    var w = findWant(id); if (!w) return;
    sheet('<h2>How was ' + esc(w.dish ? w.dish.replace(/^the\s+/i, 'the ') : w.place) + '?</h2><p class="small muted">' + esc(C.wantTitle(w) + (w.from ? ' - from ' + w.from : '')) + '</p>' +
      '<div class="vbtns" role="group" aria-label="How it was">' + C.VERDICT_IDS.map(function (v) { var x = C.verdictOf(v); return '<button class="vbtn ' + esc(v) + '" type="button" data-tv="' + esc(v) + '"><span class="e" aria-hidden="true">' + esc(x.emoji) + '</span><small>' + esc(x.label) + '</small></button>'; }).join('') + '</div>' +
      '<p class="tiny muted" style="margin-top:10px">' + (w.dish ? 'It goes on your list at ' + esc(w.place) + ', logged today.' : esc(w.place) + ' joins your places - then log what you had.') + '</p>', function (root) {
      $$('[data-tv]', root).forEach(function (b) {
        b.addEventListener('click', function () {
          var prev = D(), r = C.tryWant(prev, w.id, b.getAttribute('data-tv'), ctx());
          if (r.error) { toast(r.error); return; }
          setD(r.data); closeSheet(true);
          if (!w.dish) { state.log = blankLog(r.place.id); go('log/' + r.place.id); }
          else draw();
          toast(r.line, 4200, { label: 'Open ' + r.place.name, fn: function () { openPlace(r.place.id); } });
        });
      });
    });
  }

  /* ---------------- browse ---------------- */

  function viewBrowse() {
    var d = D(), B = state.browse, cities = C.citiesOf(d);
    if (B.city && !cities.some(function (c) { return c.key === C.cityKey(B.city); })) B.city = '';
    if (!B.picked && !B.city && cities.length) {
      // Opens on the city of the most recent visit, so its ❤️ list, card and link are one tap away.
      var recent = C.searchPlaces(d, '')[0];
      B.city = recent && recent.place.city ? recent.place.city : cities[0].city;
    }
    var cu = C.cuisinesOf(d, B.city);
    if (B.cuisine && !cu.some(function (c) { return c.id === B.cuisine; })) B.cuisine = '';
    var out = '<div class="sec-head"><h1>Browse</h1><span class="muted">' + esc(plural(d.places.length, 'place') + ' · ' + plural(d.dishes.length, 'dish', 'dishes')) + '</span></div>';
    if (!d.places.length) return out + '<section class="card empty"><div class="ic" aria-hidden="true">🏙️</div><p class="muted">Your places, cities and favourite dishes show up here once you log a visit.</p><button class="btn" type="button" data-act="tab" data-tab="log">Log a visit</button></section>';
    out += '<div class="chips" role="group" aria-label="City"><button class="chip" type="button" data-city="" aria-pressed="' + (!B.city) + '">Everywhere<span class="ct">' + d.places.length + '</span></button>' + cities.map(function (c) { return '<button class="chip" type="button" data-city="' + esc(c.city) + '" aria-pressed="' + (C.cityKey(B.city) === c.key) + '">' + esc(c.city) + '<span class="ct">' + c.places + '</span></button>'; }).join('') + '</div>';
    if (cu.length > 1) out += '<div class="chips" role="group" aria-label="Cuisine"><button class="chip" type="button" data-cuis="" aria-pressed="' + (!B.cuisine) + '">Any cuisine</button>' + cu.map(function (c) { return '<button class="chip" type="button" data-cuis="' + esc(c.id) + '" aria-pressed="' + (B.cuisine === c.id) + '">' + esc(c.emoji + ' ' + c.label) + '<span class="ct">' + c.places + '</span></button>'; }).join('') + '</div>';
    out += '<div class="seg modes" role="group" aria-label="Show"><button type="button" data-mode="places" aria-pressed="' + (B.mode === 'places') + '">Places</button><button type="button" data-mode="again" aria-pressed="' + (B.mode === 'again') + '">❤️ Again</button><button type="button" data-mode="search" aria-pressed="' + (B.mode === 'search') + '">Dishes</button></div>';
    out += '<div class="grid split"><div>';
    if (B.mode === 'places') {
      var rows = C.placesIn(d, { city: B.city, cuisine: B.cuisine });
      out += rows.length ? rows.map(function (r) { return placeRow(r.place); }).join('') : '<p class="muted">No places here yet.</p>';
    } else if (B.mode === 'again') {
      var groups = C.againList(d, { city: B.city, cuisine: B.cuisine }), total = groups.reduce(function (a, g) { return a + g.dishes.length; }, 0);
      out += '<section class="card"><h2>' + esc('Every ❤️ ' + (B.city ? 'in ' + B.city : 'everywhere')) + ' <span class="muted small">' + total + '</span></h2>' + (groups.length ? groups.map(function (g) {
        return '<div class="group"><h3>' + esc(C.cuisineOf(g.place.cuisine).emoji + ' ' + g.place.name) + ' <span class="muted small">' + esc(g.place.area) + '</span></h3>' + g.dishes.map(function (x) {
          return '<button class="drow" type="button" data-act="place" data-id="' + esc(g.place.id) + '"><span><b>' + esc(x.name) + '</b>' + (x.note ? '<small>' + esc(x.note) + '</small>' : '') + '</span><span class="times">' + esc(C.times(x) > 1 ? '×' + C.times(x) : '❤️') + '</span></button>';
        }).join('') + '</div>';
      }).join('') : '<p class="muted">Nothing marked ❤️ ' + esc(B.city ? 'in ' + B.city : 'yet') + '.</p>') + '</section>';
    } else {
      out += '<div class="search-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg><input class="input search" id="dq" type="search" autocomplete="off" placeholder="Anything with… short rib" aria-label="Search dishes" value="' + esc(B.q) + '"></div><div id="dres" style="margin-top:10px">' + dishResults() + '</div>';
    }
    out += '</div><div class="stack">' + statsCard() + cardSection() + linkSection() + '</div></div>';
    return out;
  }
  function dishResults() {
    var B = state.browse;
    if (!C.fold(B.q)) return '<p class="muted small">Search every dish you’ve logged ' + esc(B.city ? 'in ' + B.city : 'anywhere') + ' - “short rib”, “tacos”, “spicy”.</p>';
    var rows = C.searchDishes(D(), B.q, { city: B.city });
    if (!rows.length) return '<p class="muted">Nothing with “' + esc(B.q) + '” yet.</p>';
    return '<section class="card">' + rows.slice(0, 40).map(function (r) {
      return '<button class="drow" type="button" data-act="place" data-id="' + esc(r.place.id) + '"><span><b>' + esc(r.dish.name) + '</b><small>' + esc(r.place.name + ' · ' + placeSub(r.place) + (r.dish.note ? ' · ' + r.dish.note : '')) + '</small></span>' + vpill(r.dish.verdict) + '</button>';
    }).join('') + '</section>';
  }
  function statsCard() {
    var s = C.stats(D(), { today: today() });
    var top = s.topDish;
    return '<section class="card"><h2>' + esc(s.year) + ' so far</h2><div class="stats">' +
      '<div class="stat hi"><b>' + s.placesThisYear + '</b><span>' + (s.placesThisYear === 1 ? 'place' : 'places') + ' tried this year' + (s.newPlacesThisYear ? ' (' + s.newPlacesThisYear + ' new)' : '') + '</span></div>' +
      '<div class="stat"><b>' + s.visitsThisYear + '</b><span>' + (s.visitsThisYear === 1 ? 'visit' : 'visits') + ' this year</span></div>' +
      '<div class="stat"><b class="word">' + esc(s.favCuisine ? s.favCuisine.emoji + ' ' + s.favCuisine.label : '-') + '</b><span>favourite cuisine' + (s.favCuisine ? ' · ' + esc(plural(s.favCuisine.loves, 'dish', 'dishes')) + ' ❤️' : '') + '</span></div>' +
      '<div class="stat"><b>' + s.hitRate + '%</b><span>of dishes you’d order again</span></div></div>' +
      (top ? '<p style="margin:12px 0 0"><span class="muted small">Ordered again most</span><br><b>' + esc(top.dish.name) + '</b> <span class="muted">' + esc('at ' + top.place.name + (top.times > 1 ? ' · ' + top.times + ' times' : '')) + '</span></p>' : '') +
      '</section>';
  }

  /* ---------------- the share card: drawn here, never uploaded ---------------- */

  function cardSection() {
    var B = state.browse, K = state.card;
    if (!B.city) return '<section class="card"><h2>Share card</h2><p class="muted small">Pick a city above to make a “My top dishes in …” image to send a friend.</p></section>';
    var tops = C.topDishes(D(), B.city, 6);
    if (!tops.length) return '<section class="card"><h2>Share card</h2><p class="muted small">Mark a dish ❤️ in ' + esc(B.city) + ' to make a card.</p></section>';
    var fresh = K.url && K.city === B.city;
    return '<section class="card"><h2>' + esc('My top dishes in ' + B.city) + '</h2><p class="muted small">An image to send a friend - drawn on this phone, never uploaded. Dish and place names only; no notes, prices or names.</p>' +
      '<label class="check"><input type="checkbox" id="cardPhotos"' + (K.photos ? ' checked' : '') + '> Include my dish photos</label>' +
      '<div class="row"><button class="btn" type="button" data-act="cardimg">' + (fresh ? 'Draw it again' : 'Make the image') + '</button>' + (fresh ? '<button class="btn" type="button" data-act="cardshare">' + (canShareFiles() ? 'Share it' : 'Download it') + '</button>' : '') + '</div>' +
      (fresh ? '<img class="share-img" alt="' + esc('My top dishes in ' + B.city + ': ' + tops.map(function (t) { return t.dish.name + ' at ' + t.place.name; }).join(', ')) + '" src="' + esc(K.url) + '">' : '') + '</section>';
  }
  function canShareFiles() {
    try { return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; }
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function fit(g, s, max) { s = String(s); if (g.measureText(s).width <= max) return s; var cps = Array.from(s); while (cps.length > 1 && g.measureText(cps.join('') + '…').width > max) cps.pop(); return cps.join('') + '…'; }
  /** "My top dishes in <city>": 1080 x 1350, drawn here on a canvas. Dish
   *  and place names only; photos only when the box is ticked. */
  function drawCard() {
    var B = state.browse, K = state.card, city = B.city;
    var withPhotos = Boolean($('#cardPhotos') && $('#cardPhotos').checked);
    K.photos = withPhotos;
    var tops = C.topDishes(D(), city, 6);
    var pics = withPhotos ? Promise.all(tops.map(function (t) { return t.dish.photo ? photoGet('d-' + t.dish.id).then(function (ph) { return ph ? loadImg(ph.thumb) : null; }) : Promise.resolve(null); })) : Promise.resolve(tops.map(function () { return null; }));
    return pics.then(function (imgs) {
      var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350;
      var g = cv.getContext('2d');
      var grad = g.createLinearGradient(0, 0, 1080, 1350); grad.addColorStop(0, '#b4231a'); grad.addColorStop(1, '#0e5a63');
      g.fillStyle = grad; g.fillRect(0, 0, 1080, 1350);
      var F = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      g.fillStyle = '#ffffff'; roundRect(g, 84, 84, 96, 96, 26); g.fill();
      // The header's mark - a heart with a turn-around arrow - scaled from its 32-unit box.
      g.save(); g.translate(84, 84); g.scale(3, 3);
      g.fillStyle = '#b4231a'; g.beginPath(); g.moveTo(16, 25); g.bezierCurveTo(9, 20, 6, 16.5, 6, 12.5); g.bezierCurveTo(6, 9.5, 8.3, 7.5, 11, 7.5); g.bezierCurveTo(13, 7.5, 15, 8.7, 16, 10.5); g.bezierCurveTo(17, 8.7, 19, 7.5, 21, 7.5); g.bezierCurveTo(23.7, 7.5, 26, 9.5, 26, 12.5); g.bezierCurveTo(26, 16.5, 23, 20, 16, 25); g.closePath(); g.fill();
      g.restore();
      g.fillStyle = '#ffffff'; g.font = '800 50px ' + F; g.textBaseline = 'middle'; g.fillText('Again', 206, 116);
      g.fillStyle = '#fde8e4'; g.font = '700 32px ' + F; g.fillText('What to order, remembered', 206, 160);
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#ffffff'; g.font = '900 76px ' + F; g.fillText(fit(g, 'My top dishes', 912), 84, 314);
      g.font = '900 76px ' + F; g.fillText(fit(g, 'in ' + city, 912), 84, 398);
      var y = 456, rowH = tops.length > 5 ? 118 : 132;
      tops.forEach(function (t, i) {
        g.fillStyle = 'rgba(255,255,255,.16)'; roundRect(g, 84, y, 912, rowH - 16, 28); g.fill();
        var im = imgs[i], tx = 120;
        if (im) {
          g.save(); roundRect(g, 104, y + 14, rowH - 44, rowH - 44, 18); g.clip();
          var s = Math.max((rowH - 44) / im.width, (rowH - 44) / im.height);
          g.drawImage(im, 104 + ((rowH - 44) - im.width * s) / 2, y + 14 + ((rowH - 44) - im.height * s) / 2, im.width * s, im.height * s);
          g.restore(); tx = 104 + rowH - 44 + 24;
        } else {
          g.fillStyle = '#ffffff'; g.font = '900 40px ' + F; g.fillText(String(i + 1), 112, y + (rowH - 16) / 2 + 14);
          tx = 170;
        }
        var maxW = 996 - tx - 120;
        // Two lines centred in the row's box (rowH - 16 tall).
        var mid = y + (rowH - 16) / 2;
        g.fillStyle = '#ffffff'; g.font = '850 44px ' + F; g.fillText(fit(g, t.dish.name, maxW), tx, mid - 4);
        g.fillStyle = '#fde8e4'; g.font = '650 30px ' + F; g.fillText(fit(g, t.place.name + (t.place.area ? ' · ' + t.place.area : ''), maxW), tx, mid + 36);
        var n = C.times(t.dish), badge = n > 1 ? '×' + n : '';
        if (badge) { g.font = '900 34px ' + F; var bw = g.measureText(badge).width + 34; g.fillStyle = '#ffffff'; roundRect(g, 996 - 26 - bw, y + rowH / 2 - 36, bw, 56, 28); g.fill(); g.fillStyle = '#8f1b13'; g.fillText(badge, 996 - 26 - bw + 17, y + rowH / 2 + 4); }
        y += rowH;
      });
      g.fillStyle = '#fde8e4'; g.font = '700 30px ' + F; g.fillText('Remembered with Again · ' + fit(g, location.host + BASE.replace(/\/$/, ''), 560), 84, 1290);
      return new Promise(function (resolve) { cv.toBlob(function (b) { resolve(b); }, 'image/png'); });
    }).then(function (blob) {
      if (!blob) throw new Error('This browser couldn’t draw the image.');
      if (K.url) URL.revokeObjectURL(K.url);
      K.blob = blob; K.url = URL.createObjectURL(blob); K.city = city;
      draw();
      toast(canShareFiles() ? 'Drawn - tap Share it.' : 'Drawn - tap Download it.');
    });
  }
  function shareCard() {
    var K = state.card; if (!K.blob) return;
    var name = 'again-' + slug(K.city) + '.png';
    var file = new File([K.blob], name, { type: 'image/png' });
    if (canShareFiles()) navigator.share({ files: [file], title: 'My top dishes in ' + K.city }).catch(function (e) { if (!e || e.name !== 'AbortError') download(name, 'image/png', K.blob); });
    else download(name, 'image/png', K.blob);
  }

  /* ---------------- share links (signed in): one city's ❤️ list ---------------- */

  function linkSection() {
    var B = state.browse;
    if (!B.city) return '';
    var pay = C.sharePayload(D(), B.city, {});
    if (!pay.places.length) return '';
    return '<section class="card"><h2>' + esc('Send a friend your ❤️ list for ' + B.city) + '</h2><p class="muted small">A read-only link anyone can open, no account needed - for a friend visiting ' + esc(B.city) + '. ' + esc(plural(pay.places.length, 'place') + ', ' + plural(pay.places.reduce(function (a, p) { return a + p.dishes.length; }, 0), 'dish', 'dishes')) + '.</p>' +
      '<button class="btn soft" type="button" data-act="sharelink">Make a link</button></section>';
  }
  function openShareLink() {
    var city = state.browse.city;
    if (state.trying) { sheet('<h2>Share links are for your own list</h2><p>This is the made-up list. Start your own, then send a friend your real favourites.</p><button class="btn" type="button" data-act="tryadd">Start my own</button>'); return; }
    if (!signedIn()) {
      sheet('<h2>' + esc('Send your ❤️ list for ' + city) + '</h2><p>A link a friend can open with no account. Making one needs a free account, so you can close it later.</p><p class="small muted">Your list itself stays on this phone; only what you choose to share goes into the link.</p><div class="row"><button class="btn" type="button" id="slJoin">Create a free account</button><button class="btn ghost" type="button" id="slIn">Sign in</button></div>', function (root) {
        $('#slJoin', root).addEventListener('click', function () { openAccount('Create a free account to make a share link.', openShareLink); });
        $('#slIn', root).addEventListener('click', function () { openAccount('Sign in to make a share link.', openShareLink, 'login'); });
      });
      return;
    }
    var opts = { skip: false, days: 14 };
    function preview(root) {
      var pay = C.sharePayload(D(), city, { skip: opts.skip, from: $('#slFrom', root) ? $('#slFrom', root).value : prefs.from });
      var n = pay.places.reduce(function (a, p) { return a + p.dishes.length; }, 0);
      $('#slPrev', root).innerHTML = '<b>' + esc(plural(pay.places.length, 'place') + ' · ' + plural(n, 'dish', 'dishes')) + '</b><ul>' + pay.places.slice(0, 12).map(function (p) { return '<li>' + esc(p.name + ': ' + p.dishes.map(function (x) { return C.verdictOf(x.verdict).emoji + ' ' + x.name; }).join(', ')) + '</li>'; }).join('') + (pay.places.length > 12 ? '<li>…</li>' : '') + '</ul>';
      return pay;
    }
    sheet('<h2>' + esc('Send your ❤️ list for ' + city) + '</h2>' +
      '<div class="sent" id="slPrev"></div>' +
      '<p class="small" style="margin-top:10px"><b>What the link shows:</b> place names, neighbourhoods and cuisines, dish names, ❤️ (and 👎 if you tick it) and your one-line notes. <b>Never prices, who you were with, dates or photos.</b> It holds a copy of the list as it is now; anyone with the link can open it until it expires or you close it.</p>' +
      '<label class="check"><input type="checkbox" id="slSkip"> Also what to skip 👎</label>' +
      '<label class="field" style="margin:6px 0"><span>The name your friend sees <span class="hint">a first name, optional</span></span><input class="input" id="slFrom" maxlength="24" value="' + esc(prefs.from) + '" autocomplete="given-name"></label>' +
      '<div class="field"><span>Open for</span><div class="seg days4" id="slDays" role="group" aria-label="Open for">' + [1, 7, 14, 30].map(function (days) { return '<button type="button" data-days="' + days + '" aria-pressed="' + (days === opts.days) + '">' + plural(days, 'day') + '</button>'; }).join('') + '</div></div>' +
      '<div id="slOut" style="margin-top:12px"></div><button class="btn block" type="button" id="slGo" style="margin-top:8px">Make the link</button>', function (root) {
      preview(root);
      $('#slSkip', root).addEventListener('change', function (e) { opts.skip = e.target.checked; preview(root); });
      $('#slDays', root).addEventListener('click', function (e) { var b = e.target.closest('[data-days]'); if (!b) return; opts.days = Number(b.getAttribute('data-days')); $$('[data-days]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); });
      $('#slGo', root).addEventListener('click', function () {
        var go2 = $('#slGo', root), pay = preview(root);
        prefs.from = C.cleanPerson($('#slFrom', root).value); savePrefs();
        go2.disabled = true; go2.textContent = 'Making it…';
        api('POST', 'api/shares', { city: pay.city, from: prefs.from, days: opts.days, places: pay.places }).then(function (r) {
          links[r.link.id] = r.code; keep(K_LINKS, links);
          var url = location.origin + BASE + r.path;
          go2.hidden = true;
          $('#slOut', root).innerHTML = '<p class="small"><b>Your link</b> - open until ' + esc(new Date(r.link.expiresAt).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' })) + '. Close it any time in Settings.</p><div class="linkbox">' + esc(url) + '</div><div class="row" style="margin-top:8px"><button class="btn" type="button" id="slCopy">Copy the link</button>' + (navigator.share ? '<button class="btn ghost" type="button" id="slShare">Share…</button>' : '') + '</div>';
          $('#slCopy', root).addEventListener('click', function () { copy(url, 'Copied - send it to a friend.'); });
          var sh = $('#slShare', root); if (sh) sh.addEventListener('click', function () { navigator.share({ title: 'My ❤️ list for ' + pay.city, url: url }).catch(function () { /* cancelled */ }); });
        }).catch(function (err) { go2.disabled = false; go2.textContent = 'Make the link'; showError(err, $('#slOut', root)); });
      });
    });
  }

  /* ---------------- a friend's link (no account) ---------------- */

  function loadShare(code) {
    state.share = { code: code, status: 'loading', data: null, saved: {} };
    api('GET', 'api/s/' + code).then(function (r) {
      if (!state.share || state.share.code !== code) return;
      state.share.status = 'ok'; state.share.data = r.share; state.share.expiresAt = r.expiresAt;
      draw();
    }).catch(function (err) {
      if (!state.share || state.share.code !== code) return;
      state.share.status = err.offline ? 'offline' : err.status === 404 ? 'gone' : 'error'; state.share.error = err.message;
      draw();
    });
  }
  function viewShare() {
    var S = state.share;
    var start = '<section class="card" style="margin-top:14px"><h2>Keep your own list</h2><p class="muted small">Again remembers what you loved at every place - free, no account, and it stays on your phone.</p><button class="btn" type="button" data-act="home">Start my own Again list</button></section>';
    if (!S || S.status === 'loading') return '<p class="muted" role="status">Opening the list…</p>';
    if (S.status === 'offline') return '<section class="card empty"><div class="ic" aria-hidden="true">📶</div><h1>This list needs the internet</h1><p class="muted">A friend’s list is opened from the link each time, so it can’t open offline. Reconnect and reload the page.</p></section>';
    if (S.status === 'gone') return '<section class="card empty"><div class="ic" aria-hidden="true">🍽️</div><h1>This list isn’t open any more</h1><p class="muted">It may have been closed, or it expired. Ask whoever sent it for a new link.</p></section>' + start;
    if (S.status === 'error') return '<section class="card empty"><div class="ic" aria-hidden="true">🍽️</div><h1>This list can’t open right now</h1><p class="muted">' + esc(S.error) + '</p></section>' + start;
    var sh = S.data, n = sh.places.reduce(function (a, p) { return a + p.dishes.length; }, 0);
    var out = '<div class="friend-head"><p class="lab" style="color:var(--hero-soft)">' + esc((sh.from ? sh.from + '’s' : 'A friend’s') + ' Order again list') + '</p><h1>' + esc(sh.city) + '</h1><p>' + esc(plural(n, 'dish', 'dishes') + ' at ' + plural(sh.places.length, 'place') + (S.expiresAt ? ' · open until ' + new Date(S.expiresAt).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' }) : '')) + '</p></div>' +
      '<p class="small muted">Read-only. Tap “Save” on anything you want to try - it goes on your own phone’s Want to try list, and nothing is sent anywhere.</p>' +
      '<div class="row"><button class="btn small" type="button" data-act="saveall">Save all to my Want to try</button></div>';
    sh.places.forEach(function (p, pi) {
      out += '<section class="card splace"><h2>' + esc(C.cuisineOf(p.cuisine).emoji + ' ' + p.name) + ' <span class="muted small">' + esc([p.area, C.cuisineOf(p.cuisine).label].filter(Boolean).join(' · ')) + '</span></h2>' + p.dishes.map(function (d, di) {
        var saved = S.saved[pi + '-' + di] || C.hasWant(data.wants, d.name, p.name);
        return '<div class="sdish"><span><b>' + esc(C.verdictOf(d.verdict).emoji + ' ' + d.name) + '</b>' + (d.note ? '<small>' + esc(d.note) + '</small>' : '') + (d.verdict === 'skip' ? '<small>' + esc((sh.from || 'They') + ' would skip this one') + '</small>' : '') + '</span>' +
          (d.verdict === 'skip' ? '<span></span>' : (saved ? '<span class="pill t-ok">Saved ✓</span>' : '<button class="btn small soft" type="button" data-act="savewant" data-p="' + pi + '" data-d="' + di + '" aria-label="' + esc('Save ' + d.name + ' to my Want to try') + '">🔖 Save</button>')) + '</div>';
      }).join('') + '</section>';
    });
    return out + start;
  }
  function saveFromShare(pi, di, quiet) {
    var S = state.share; if (!S || !S.data) return false;
    var p = S.data.places[pi], d = p && p.dishes[di];
    if (!d || d.verdict === 'skip') return false;
    if (C.hasWant(data.wants, d.name, p.name)) { S.saved[pi + '-' + di] = true; return false; }
    if (data.wants.length >= C.LIMITS.wants) { if (!quiet) toast('Your Want to try list is full - remove a few first.'); return false; }
    var w = C.wantFromShare(S.data, pi, di, ctx()); if (!w) return false;
    data = Object.assign({}, data, { wants: data.wants.concat([w]) }); save();
    S.saved[pi + '-' + di] = true;
    return true;
  }

  /* ---------------- "Read the menu" (signed in, metered) ---------------- */

  /** The photo to send: redrawn at 1600 px, smaller until it fits. */
  function sendable(full) {
    var max = C.LIMITS.aiImageBytes * 4 / 3;
    var b64 = full.replace(/^data:image\/jpeg;base64,/, '');
    if (b64.length <= max) return Promise.resolve(b64);
    return loadImg(full).then(function (im) {
      var steps = [[1600, 0.7], [1400, 0.66], [1200, 0.62], [1000, 0.6]];
      for (var i = 0; i < steps.length; i++) { var d = redraw(im, steps[i][0], steps[i][1]).replace(/^data:image\/jpeg;base64,/, ''); if (d.length <= max) return d; }
      throw new Error('That photo is too large to send. Try a closer photo of one page of the menu.');
    });
  }
  function openReader(placeId) {
    state.reader = { placeId: findPlace(placeId) ? placeId : '', photo: null, ask: false, menu: null, verdicts: {}, sent: 0 };
    sheet('<div class="body"></div>', drawReader);
  }
  function drawReader(root) {
    var b = $('.body', root), r = state.reader, p = findPlace(r.placeId);
    var hist = C.historyFor(D(), { exceptPlaceId: r.placeId });
    var sentBox = '<div class="sent">' + (r.photo ? '<img alt="" src="' + esc(r.photo.thumb) + '">' : '') + '<b>What is sent:</b> this menu photo, shrunk on this phone with its location removed' +
      (r.ask && hist.length ? ', and these ' + plural(hist.length, 'dish', 'dishes') + ' of yours from other places - names, cuisines and verdicts only:<ul>' + hist.map(function (h) { return '<li>' + esc(h.dish + (h.cuisine ? ' (' + C.cuisineOf(h.cuisine).label + ')' : '') + ' ' + C.verdictOf(h.verdict).emoji) + '</li>'; }).join('') + '</ul>' : '. ') +
      '<b>Never a place name, who you ate with, a date, a price or a note.</b><span style="display:block;clear:both"></span></div>';
    if (!signedIn()) {
      b.innerHTML = '<h2>Read the menu</h2><p>Take a photo of the menu and AI lists the dishes on it - then tap ❤️ 👍 👎 for what you had. Ask “What should I order?” and it picks up to three, from what you loved and skipped elsewhere.</p>' + sentBox +
        '<p class="note" style="margin-top:12px">This needs a free account - it comes with $2 of AI credit, and one menu costs about a cent. Logging by hand, “I’m here” and everything else stay free with no account.</p>' +
        '<div class="row" style="margin-top:12px"><button class="btn" type="button" id="rdJoin">Create a free account</button><button class="btn ghost" type="button" id="rdIn">Sign in</button></div>';
      $('#rdJoin', root).addEventListener('click', function () { openAccount('Create a free account to read menus.', function () { openReader(r.placeId); }); });
      $('#rdIn', root).addEventListener('click', function () { openAccount('Sign in to read menus.', function () { openReader(r.placeId); }, 'login'); });
      return;
    }
    if (r.menu) return drawMenu(root);
    b.innerHTML = '<h2>Read the menu' + (p ? ' at ' + esc(p.name) : '') + '</h2>' +
      '<div class="field" style="margin:8px 0 12px"><span>A photo of the menu</span><label class="btn ghost file-btn">' + (r.photo ? '📷 Choose another' : '📷 Take or choose a photo') + '<input class="vh" id="rdFile" type="file" accept="image/*"></label></div>' +
      '<label class="check"><input type="checkbox" id="rdAsk"' + (r.ask ? ' checked' : '') + (hist.length ? '' : ' disabled') + '> <span>What should I order? <span class="small muted">' + (hist.length ? 'Up to three picks from this menu, from what you loved and skipped elsewhere.' : 'Log a few dishes at other places first - the picks come from them.') + '</span></span></label>' +
      sentBox + '<div id="rdOut" style="margin-top:12px"></div><div class="row" style="margin-top:12px"><button class="btn ai" type="button" id="rdGo"' + (r.photo ? '' : ' disabled') + '> Read it</button><span class="tiny muted">About a cent of AI credit.</span></div>';
    var out = $('#rdOut', root), go2 = $('#rdGo', root);
    $('#rdAsk', root).addEventListener('change', function (e) { r.ask = e.target.checked; drawReader(root); });
    $('#rdFile', root).addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return;
      prepPhoto(file, 1600).then(function (ph) { r.photo = ph; drawReader(root); }).catch(function (err) { showError(err, out); });
    });
    go2.addEventListener('click', function () {
      if (!r.photo) return;
      go2.disabled = true; go2.textContent = 'Reading…';
      out.innerHTML = '<p class="muted" role="status">Reading the menu…</p>';
      sendable(r.photo.full).then(function (b64) {
        var body = { image: { type: 'image/jpeg', data: b64 } };
        if (r.ask && hist.length) body.history = hist;
        r.sent = body.history ? body.history.length : 0;
        return api('POST', 'api/ai/menu', body);
      }).then(function (res) {
        r.menu = res.menu; r.verdicts = {}; drawReader(root); loadMe();
      }).catch(function (err) {
        go2.disabled = false; go2.textContent = ' Read it';
        meteredError(err, out, function () { openReader(r.placeId); }, 'Sign in to read menus.');
      });
    });
  }
  function drawMenu(root) {
    var b = $('.body', root), r = state.reader, m = r.menu, p = findPlace(r.placeId);
    var picked = {};
    m.picks.forEach(function (x) { picked[x.index] = true; });
    var places = D().places.slice().sort(function (a, c) { return C.fold(a.name) < C.fold(c.name) ? -1 : 1; });
    b.innerHTML = '<h2>' + (p ? 'The menu at ' + esc(p.name) : 'The menu') + '</h2><p class="small muted">Read by AI - check the names. Tap how it was for what you ate; nothing is added until you tap Add.</p>' +
      '<p><span class="pill ' + (m.confidence === 'high' ? 't-ok' : 't-warn') + '">' + esc(m.confidence + ' confidence') + '</span>' + (m.note ? ' <span class="small muted">' + esc(m.note) + '</span>' : '') + '</p>' +
      (m.picks.length ? '<div class="picks"><h3>What to order</h3><ol>' + m.picks.map(function (x) { return '<li><b>' + esc(x.name) + '</b>' + (x.reason ? '<span>' + esc(x.reason) + '</span>' : '') + '</li>'; }).join('') + '</ol></div>' : (m.asked ? '<p class="note small">No picks this time - nothing on this menu lined up with what you loved.</p>' : '')) +
      (m.currency && m.currency !== cur() ? '<p class="note small">These prices look like ' + esc(m.currency) + '. Again shows amounts in ' + esc(cur()) + ' - change it in Settings if that’s wrong.</p>' : '') +
      (p ? '' : '<label class="field" style="margin:10px 0"><span>Where are you?</span><select class="input" id="mWhere"><option value="">Somewhere new…</option>' + places.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name + (x.city ? ' · ' + x.city : '')) + '</option>'; }).join('') + '</select></label>' +
        '<div class="row" id="mNew"><label class="field" style="flex:1 1 160px"><span>Place name</span><input class="input" id="mName" maxlength="60"></label><label class="field" style="flex:1 1 140px"><span>City</span><input class="input" id="mCity" maxlength="40" list="mCities"></label><datalist id="mCities">' + usedCities().map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist></div>') +
      '<div class="card" id="mList" style="margin-top:10px;padding:8px 12px">' + m.dishes.map(function (d, i) {
        return '<div class="mrow' + (picked[i] ? ' pick' : '') + '"><div class="nm">' + (picked[i] ? '<span class="tag-pick">Pick</span>' : '') + '<input class="input" data-mn="' + i + '" maxlength="80" value="' + esc(d.name) + '" aria-label="' + esc('Dish ' + (i + 1)) + '"><small>' + esc([d.desc, d.price !== null ? money(d.price) : ''].filter(Boolean).join(' · ')) + '</small></div>' +
          '<span class="vmini" role="group" aria-label="' + esc('How ' + d.name + ' was') + '">' + C.VERDICT_IDS.map(function (v) { var y = C.verdictOf(v); return '<button type="button" class="' + esc(v) + '" data-mv="' + i + '" data-v="' + esc(v) + '" aria-pressed="false" aria-label="' + esc(y.label) + '">' + esc(y.emoji) + '</button>'; }).join('') + '</span></div>';
      }).join('') + '</div>' +
      '<div id="mErr"></div><div class="row sheet-foot"><button class="btn" type="button" id="mAdd" disabled>Add</button><button class="btn ghost" type="button" id="mBack">Read another</button></div>' +
      '<p class="tiny muted" style="margin-top:8px">The menu photo isn’t kept - only the dishes you add.</p>';
    var cnt = function () { var n = Object.keys(r.verdicts).length; var a = $('#mAdd', root); a.disabled = !n; a.textContent = n ? 'Add ' + plural(n, 'dish', 'dishes') : 'Add'; };
    $('#mList', root).addEventListener('click', function (e) {
      var t = e.target.closest('[data-mv]'); if (!t) return;
      var i = t.getAttribute('data-mv'), v = t.getAttribute('data-v');
      if (r.verdicts[i] === v) delete r.verdicts[i]; else r.verdicts[i] = v;
      $$('[data-mv="' + i + '"]', root).forEach(function (x) { x.setAttribute('aria-pressed', String(r.verdicts[i] === x.getAttribute('data-v'))); });
      cnt();
    });
    var wh = $('#mWhere', root);
    if (wh) wh.addEventListener('change', function () { $('#mNew', root).hidden = Boolean(wh.value); });
    $('#mBack', root).addEventListener('click', function () { state.reader = { placeId: r.placeId, photo: null, ask: r.ask, menu: null, verdicts: {} }; drawReader(root); });
    $('#mAdd', root).addEventListener('click', function () {
      var items = Object.keys(r.verdicts).map(function (i) { return { name: $('[data-mn="' + i + '"]', root).value, verdict: r.verdicts[i], price: m.dishes[i].price }; });
      var placeId = r.placeId || (wh ? wh.value : '');
      var input = placeId ? { placeId: placeId, day: today(), items: items } : { place: { name: $('#mName', root).value, city: $('#mCity', root).value, cuisine: 'other' }, day: today(), items: items };
      var prev = D(), res = C.logVisit(prev, input, ctx());
      if (res.error) { $('#mErr', root).innerHTML = '<p class="err" role="alert">' + esc(res.error) + '</p>'; return; }
      var settled = C.settleWants(res.data, res.place.id, res.touched, ctx());
      setD(settled.data); closeSheet(true); state.reader = null;
      go('place/' + res.place.id);
      toast('Added ' + plural(items.length, 'dish', 'dishes') + ' at ' + res.place.name + '.' + (settled.lines.length ? ' ' + settled.lines.join(' · ') : ''), 4800, { label: 'Undo', fn: function () { setD(prev); draw(); } });
    });
  }

  /* ---------------- settings, export, import, sync ---------------- */

  function syncCard() {
    var out = '<section class="card stack" id="syncCard"><h2>Phone and laptop</h2>';
    if (!signedIn()) return out + '<p>Your list lives on this device. With a free account you can turn on sync, so a phone and a laptop see the same places and dishes.</p><div class="row"><button class="btn" type="button" data-act="signin">Create a free account</button><button class="btn ghost" type="button" data-act="signin-login">Sign in</button></div></section>';
    if (!state.me.sync) return out + '<p class="muted">Sync isn’t available right now. Your list is safe on this device.</p></section>';
    var plain2 = '<p class="small">Sync stores your list - places, dishes, verdicts, notes, prices, the days you went and the first names of who was there, and your Want to try - in the lab’s database, so your other device can see it. <b>Photos stay on this phone.</b> It is filed under a code made from your account, never your email.</p>';
    if (!prefs.sync) return out + plain2 + '<button class="btn" type="button" data-act="syncon">Turn on sync</button></section>';
    var when = sync.at ? 'Last saved ' + new Date(sync.at).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not saved yet';
    return out + '<p><span class="pill t-ok">Sync is on</span> <span class="small muted">' + esc(when) + (sync.dirty ? ' · changes waiting' : '') + '</span></p>' + (state.syncErr ? '<p class="err small">' + esc(state.syncErr) + '</p>' : '') + plain2 +
      '<div class="row"><button class="btn small" type="button" data-act="syncnow">Sync now</button><button class="btn small ghost" type="button" data-act="syncoff">Turn off</button><button class="btn small ghost" type="button" data-act="syncdel">Turn off and delete the account copy</button></div></section>';
  }
  function linksCard() {
    if (!signedIn() || !state.me.sync) return '';
    return '<section class="card stack"><h2>Your share links</h2><p class="small muted">Read-only lists you sent friends. Closing one stops it working at once.</p><div id="linkList"><p class="muted small">Loading…</p></div></section>';
  }
  function loadLinks() {
    var box = $('#linkList'); if (!box) return;
    api('GET', 'api/shares').then(function (r) {
      if (!$('#linkList')) return;
      if (!r.links.length) { box.innerHTML = '<p class="muted small">No open links. Make one from Browse - pick a city, then “Make a link”.</p>'; return; }
      box.innerHTML = r.links.map(function (l) {
        var code = links[l.id];
        return '<div class="lrow"><span><b>' + esc(l.city) + '</b> <span class="small muted">' + esc(plural(l.dishes, 'dish', 'dishes') + ' · opened ' + plural(l.opens, 'time') + ' · open until ' + new Date(l.expiresAt).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' })) + '</span></span><span class="row">' +
          (code ? '<button class="btn small ghost" type="button" data-act="copylink" data-id="' + esc(l.id) + '">Copy</button>' : '') + '<button class="btn small ghost" type="button" data-act="closelink" data-id="' + esc(l.id) + '">Close link</button></span></div>';
      }).join('') + '<p class="tiny muted" style="margin-top:6px">' + esc(r.links.length + ' of ' + r.max + ' open.') + '</p>';
    }).catch(function (err) { if ($('#linkList')) box.innerHTML = '<p class="err small">' + esc(err.message) + '</p>'; });
  }
  function viewSettings() {
    var out = '<div class="sec-head"><h1>Settings</h1></div><div class="grid two">';
    out += '<section class="card stack"><h2>This device</h2><label class="field"><span>Currency for prices</span><select class="input" id="curSel" style="max-width:220px">' + C.CURRENCIES.map(function (c) { return '<option' + (c === cur() ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label></section>';
    out += syncCard() + linksCard();
    out += '<section class="card stack"><h2>Your data</h2><p class="small muted">Everything but the photos, made on this device: JSON to bring back here or to another browser, CSV for a spreadsheet.</p>' +
      '<div class="row"><button class="btn" type="button" data-act="jsonout">Export JSON</button><button class="btn ghost" type="button" data-act="csvout">Export CSV</button><label class="btn ghost file-btn">Import a file<input type="file" id="fileIn" accept=".json,.csv,application/json,text/csv" class="vh"></label></div><div id="fileMsg"></div></section>';
    out += '<section class="card stack"><h2>Privacy</h2><p class="small">Everything is kept in this browser: your list in its storage, photos in its database. Clearing your browser’s data clears it. Photos are shrunk on this phone and their location is removed; they never leave it.</p>' +
      (state.trying ? '' : '<button class="btn small ghost" type="button" data-act="clearall">Clear everything on this device</button>') + '</section>';
    return out + '</div>';
  }
  function bindSettings() {
    var sel = $('#curSel'); if (sel) sel.addEventListener('change', function () { prefs.currency = sel.value; savePrefs(); draw(); });
    var inp = $('#fileIn');
    if (inp) inp.addEventListener('change', function () {
      var file = inp.files[0]; inp.value = ''; if (!file) return;
      if (file.size > C.LIMITS.jsonBytes) { $('#fileMsg').innerHTML = '<p class="err">That file is over 3 MB.</p>'; return; }
      var rd = new FileReader();
      rd.addEventListener('load', function () { importFile(String(rd.result || ''), /\.json$/i.test(file.name) || /json/.test(file.type)); });
      rd.readAsText(file);
    });
    loadLinks();
  }
  function importFile(text, isJson) {
    var r = isJson || /^\s*\{/.test(text) ? C.fromJson(text, ctx()) : C.fromCsv(text, ctx()), msg = $('#fileMsg');
    if (r.error) { msg.innerHTML = '<p class="err" role="alert">' + esc(r.error) + '</p>'; return; }
    if (state.trying) leaveTry(true);
    var l = r.list, have = {}; data.places.concat(data.dishes, data.wants).forEach(function (x) { have[x.id] = 1; });
    var same = l.places.concat(l.dishes, l.wants).filter(function (x) { return have[x.id]; }).length;
    sheet('<h2>Import ' + esc(plural(l.places.length, 'place') + ' and ' + plural(l.dishes.length, 'dish', 'dishes')) + '?</h2><p>' + esc((l.wants.length ? plural(l.wants.length, 'pick') + ' to try as well. ' : '') + (same ? plural(same, 'thing') + ' already here will be replaced by the file’s copy. ' : '') + (r.skipped ? plural(r.skipped, 'row') + ' could not be read and will be left out.' : '')) + '</p>' +
      '<div class="row"><button class="btn" type="button" id="imGo">Import</button><button class="btn ghost" type="button" data-act="closesheet">Cancel</button></div>', function (root) {
      $('#imGo', root).addEventListener('click', function () { data = C.importInto(data, l, ctx()); save(); closeSheet(); go(''); toast('Imported.'); });
    });
  }

  /* sync: the list, never a photo */
  var pushTimer = null;
  function syncOn() { return Boolean(prefs.sync && signedIn() && state.me.sync); }
  function schedulePush() { clearTimeout(pushTimer); if (syncOn()) pushTimer = setTimeout(push, 1200); }
  function mine() { return C.syncPayload(data); }
  function localFlags() { var m = {}; data.dishes.forEach(function (d) { m[d.id] = d.photo; }); return m; }
  function setList(l, flags) {
    var clean = C.cleanList(l, ctx()).list, f = flags || localFlags();
    clean.dishes.forEach(function (d) { d.photo = f[d.id] === true; });
    data = clean;
  }
  function syncDone(version) { sync.version = version; sync.dirty = false; sync.at = now(); keep(K_SYNC, sync); state.syncErr = ''; }
  function push() {
    if (!syncOn() || state.syncBusy) return Promise.resolve();
    state.syncBusy = true;
    return api('PUT', 'api/list', { list: mine(), base: sync.version }).then(function (r) {
      state.syncBusy = false; syncDone(r.version);
      if (state.view === 'settings') draw();
    }).catch(function (err) {
      state.syncBusy = false;
      if (err.status === 409 && err.data) return openConflict(err.data);
      state.syncErr = err.offline ? 'Offline - your changes will be saved when you’re back online.' : err.message;
      if (state.view === 'settings') draw();
    });
  }
  function pull() {
    if (!syncOn()) return Promise.resolve();
    return api('GET', 'api/list').then(function (r) {
      if (!r.list) { sync.version = null; return push(); }
      if (r.version === sync.version) return sync.dirty ? push() : null;
      if (!sync.dirty && (sync.version !== null || !data.places.length)) { setList(r.list); saveLocal(); syncDone(r.version); if ($('#sheet').hidden && state.view !== 'log') draw(); return null; }
      return openConflict(r);
    }).catch(function (err) { state.syncErr = err.offline ? 'Offline right now.' : err.message; if (state.view === 'settings') draw(); });
  }
  function openConflict(d) {
    var o = ctx(), theirs = C.cleanList(d.list, o).list, merged = C.mergeLists(mine(), d.list, o);
    var line2 = function (l) { return plural(l.places.length, 'place') + ' · ' + plural(l.dishes.length, 'dish', 'dishes'); };
    sheet('<h2>Your list changed on another device</h2><p>This device and your account copy don’t match. Which should both keep?</p>' +
      '<div class="choice3"><button class="btn ghost" type="button" id="cfTheirs"><span>Use theirs</span><small>' + esc(line2(theirs)) + '</small></button>' +
      '<button class="btn ghost" type="button" id="cfMine"><span>Keep mine</span><small>' + esc(line2(data)) + '</small></button>' +
      '<button class="btn" type="button" id="cfMerge"><span>Merge by item</span><small>' + esc(line2(merged)) + '</small></button></div>' +
      '<p class="tiny muted" style="margin-top:10px">Merging keeps every place, dish and pick from both, and the later edit of anything changed on both. Photos are never synced, so they stay where they are.</p>', function (root) {
      $('#cfTheirs', root).addEventListener('click', function () { setList(d.list); saveLocal(); syncDone(d.version); closeSheet(); draw(); toast('Using the account copy.'); });
      $('#cfMine', root).addEventListener('click', function () { sync.version = d.version; sync.dirty = true; closeSheet(); push().then(function () { toast('Kept this device’s list.'); }); });
      $('#cfMerge', root).addEventListener('click', function () { setList(merged); saveLocal(); sync.version = d.version; sync.dirty = true; closeSheet(); draw(); push().then(function () { toast('Merged.'); }); });
    });
  }
  function turnSyncOn() {
    prefs.sync = true; savePrefs();
    if (data.places.length || data.wants.length) sync.dirty = true;
    keep(K_SYNC, sync);
    pull().then(function () { if (state.view === 'settings') draw(); });
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

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = state.me || { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() { $('#acct').textContent = signedIn() ? 'Account' : 'Sign in'; }

  var FREE_LINE = 'Again is free with no account, and your list stays on this device. A free account adds sync between a phone and a laptop (only if you turn it on), share links for friends and the menu reader - it comes with $2 of AI credit, and one account works across every app on this site.';
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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (prefs.sync) pull(); if (then) then(); else draw(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      });
      var pk = $('#pkBtn', root);
      if (pk) pk.addEventListener('click', function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (prefs.sync) pull(); if (then) then(); else draw(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      });
    }
    sheet('<div class="body"></div>', draw2);
  }
  function openAccountSheet() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet('<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Reading a menu costs about a cent. Everything else is free.</p><div id="billing"></div></div>' +
      '<p class="small muted" style="margin-top:12px">' + (prefs.sync ? 'Sync is on: your list (never your photos) is kept with this account.' : 'Your list is not in your account - it stays on this device unless you turn on sync in Settings.') + '</p>' +
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((d && d.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Logging by hand, “I’m here” and everything else keep working, free.</p><div id="billing"></div>' +
      (d && d.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(d.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- clicks ---------------- */

  function bindBrowse() {
    var B = state.browse;
    $$('[data-city]').forEach(function (b) { b.addEventListener('click', function () { B.city = b.getAttribute('data-city'); B.cuisine = ''; B.picked = true; draw(); }); });
    $$('[data-cuis]').forEach(function (b) { b.addEventListener('click', function () { B.cuisine = b.getAttribute('data-cuis'); draw(); }); });
    $$('[data-mode]').forEach(function (b) { b.addEventListener('click', function () { B.mode = b.getAttribute('data-mode'); draw(); if (B.mode === 'search') { var f = $('#dq'); if (f) f.focus(); } }); });
    var dq = $('#dq');
    if (dq) dq.addEventListener('input', function () { B.q = dq.value; $('#dres').innerHTML = dishResults(); });
    wantThumbs(D().dishes.filter(function (d) { return d.photo; }).slice(0, 12));
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); closeSheet(true); if (state.view === 'share') { location.assign(BASE); break; } go(''); break;
      case 'tab': closeSheet(true); go(t.getAttribute('data-tab') === 'home' ? '' : t.getAttribute('data-tab')); break;
      case 'try': startTry(); break;
      case 'tryleave': leaveTry(); toast('That was the made-up list - nothing was saved.'); break;
      case 'tryadd': case 'addfirst': closeSheet(true); leaveTry(true); state.log = blankLog(''); go('log'); break;
      case 'place': closeSheet(true); openPlace(id); break;
      case 'newplace': state.log = blankLog(''); state.log.q = t.getAttribute('data-name') || ''; state.log.place.name = state.log.q; state.q = ''; go('log'); break;
      case 'log': state.log = blankLog(id); go('log/' + id); break;
      case 'logpick': state.log.placeId = id; state.log.q = ''; draw(); { var f = $('#lDish'); if (f) f.focus(); } break;
      case 'logchange': state.log.placeId = ''; state.log.forPlace = ''; draw(); { var g = $('#lq'); if (g) g.focus(); } break;
      case 'dish': openDish(id); break;
      case 'editplace': openEditPlace(id); break;
      case 'reader': openReader(id); break;
      case 'addwant': openAddWant(); break;
      case 'trywant': openTryWant(id); break;
      case 'delwant': {
        var w = findWant(id); if (!w) break;
        var prevW = D(); setD(C.removeIds(prevW, [id], ctx())); draw();
        toast('Removed.', 3600, { label: 'Undo', fn: function () { setD(prevW); draw(); } });
        break;
      }
      case 'cardimg': t.disabled = true; drawCard().catch(function (err) { t.disabled = false; showError(err); }); break;
      case 'cardshare': shareCard(); break;
      case 'sharelink': openShareLink(); break;
      case 'savewant': { if (saveFromShare(Number(t.getAttribute('data-p')), Number(t.getAttribute('data-d')))) toast('Saved to your Want to try - on this phone.'); draw(); break; }
      case 'saveall': {
        var S = state.share, n = 0;
        if (S && S.data) S.data.places.forEach(function (p, pi) { p.dishes.forEach(function (d, di) { if (saveFromShare(pi, di, true)) n++; }); });
        toast(n ? 'Saved ' + plural(n, 'dish', 'dishes') + ' to your Want to try.' : 'They’re all on your list already.'); draw();
        break;
      }
      case 'copylink': { var code = links[id]; if (code) copy(location.origin + BASE + 's/' + code, 'Copied.'); break; }
      case 'closelink':
        if (!confirm('Close this link? Anyone who opens it will be told it isn’t open any more.')) break;
        api('DELETE', 'api/shares/' + encodeURIComponent(id)).then(function () { delete links[id]; keep(K_LINKS, links); loadLinks(); toast('Closed.'); }).catch(function (err) { showError(err); });
        break;
      case 'jsonout': download('again-' + today() + '.json', 'application/json', C.toJson(D(), ctx())); toast('Downloaded - made on this device.'); break;
      case 'csvout': download('again-' + today() + '.csv', 'text/csv', C.dataCsv(D(), ctx())); toast('Downloaded - made on this device.'); break;
      case 'signin': openAccount('Create a free account to sync your list between devices.', function () { draw(); }); break;
      case 'signin-login': openAccount('Sign in to sync your list between devices.', function () { draw(); }, 'login'); break;
      case 'syncon': turnSyncOn(); break;
      case 'syncnow': pull().then(function () { toast(sync.dirty ? 'Saving…' : 'Up to date.'); }); break;
      case 'syncoff': prefs.sync = false; savePrefs(); draw(); toast('Sync is off. The account copy is still there.'); break;
      case 'syncdel':
        if (!confirm('Turn sync off and delete the copy in your account? This device keeps its list.')) break;
        api('DELETE', 'api/list').then(function () { prefs.sync = false; savePrefs(); sync = { version: null, dirty: false }; keep(K_SYNC, sync); draw(); toast('The account copy is deleted.'); }).catch(function (err) { showError(err); });
        break;
      case 'clearall': {
        if (!confirm('Clear everything Again keeps on this device - places, dishes, picks and photos? This can’t be undone.')) break;
        data.dishes.forEach(function (d) { if (d.photo) photoDel('d-' + d.id); });
        data = { places: [], dishes: [], wants: [], deleted: [] }; saveLocal();
        prefs.sync = false; savePrefs(); sync = { version: null, dirty: false }; keep(K_SYNC, sync);
        state.card = { url: null, blob: null, photos: false, city: '' };
        go(''); toast('Cleared.');
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
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (syncOn()) pull();
  });
  drawTop();
  route();
  loadMe().then(function () {
    if (syncOn()) pull();
    if (state.view === 'settings') draw();
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
