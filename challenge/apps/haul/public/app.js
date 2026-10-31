/* Haul - the page. One file, no build step.
 *
 * EVERYTHING ABOUT THE HAUL STAYS ON THIS DEVICE: the trick-or-treaters (a
 * first name or nickname and a costume), every count, the trades, the ration
 * plans and the set-aside piles in localStorage; the haul card drawn here on
 * a canvas. Every storage access is wrapped in try/catch, and the page works
 * - in memory - when storage is unavailable.
 *
 * The requests this page makes: sign-in, and the optional "Count it from a
 * photo", whose payload (the one photo, shrunk here with its location
 * removed) is shown before it is sent. Nothing else leaves the device.
 *
 * Every string a person typed, the server answered or a model wrote is
 * escaped before it is drawn, and no handler is written into markup: clicks
 * are routed by data-act attributes from one listener (the lab's CSP allows
 * script from this origin only).
 */
(function () {
  'use strict';

  var C = window.HaulCore;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var esc = C.esc, plural = C.plural;
  var RM = matchMedia('(prefers-reduced-motion: reduce)');
  var K_DATA = 'haul-data-v1', K_PREFS = 'haul-prefs-v1';

  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function uid(len) {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '', n = len || 10, a = new Uint8Array(n);
    try { crypto.getRandomValues(a); } catch (e) { for (var j = 0; j < n; j++) a[j] = Math.floor(Math.random() * 256); }
    for (var i = 0; i < n; i++) out += abc[a[i] % 36];
    return out;
  }

  /* ---------------- what this device keeps ---------------- */

  var prefs = recall(K_PREFS) || {};
  function savePrefs() { keep(K_PREFS, prefs); }
  var real = C.cleanFamily(recall(K_DATA));
  var storageOk = true;
  function save() {
    var ok = keep(K_DATA, real);
    if (!ok && storageOk) { storageOk = false; toast('This browser isn’t keeping things right now - the counts will be gone when the page closes.', 5200); }
  }

  var state = {
    trial: null, view: 'home', kid: typeof prefs.kid === 'string' ? prefs.kid : null,
    q: '', cat: 'all', undo: [],
    ta: null, tb: null, oa: {}, ob: {},
    setup: { avatar: C.AVATARS[0][0] },
    card: { who: null, names: null, blob: null, url: null },
    showAllAside: false, lastEat: null, lastRemoved: null,
    buyN: null, me: null, photo: null, prop: null,
  };
  /** The family on screen: the made-up one while trying it, else the real one. */
  function fam() { return state.trial || real; }
  function setFam(f) { if (state.trial) state.trial = f; else { real = f; save(); } }
  function kids() { return fam().kids; }
  function kidOf(id) { return C.kidById(fam(), id); }
  function activeKid() {
    var k = kidOf(state.kid) || kids()[0] || null;
    if (k && state.kid !== k.id) { state.kid = k.id; if (!state.trial) { prefs.kid = k.id; savePrefs(); } }
    return k;
  }
  function setKid(id) { if (!kidOf(id)) return; state.kid = id; if (!state.trial) { prefs.kid = id; savePrefs(); } }
  function nameOf(k) { return C.displayName(k, kids()); }
  function day() { return today(); }

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
    }, function () { var e = new Error('You’re offline - that needs the internet. Counting by tapping still works.'); e.status = 0; e.offline = true; throw e; });
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
  function download(name, type, content) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function buzz() { try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) { /* not on this device */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then try again. Counting by tapping stays free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
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
  function celebrate(big) {
    if (RM.matches) return;
    var box = document.createElement('div'); box.className = 'confetti'; box.setAttribute('aria-hidden', 'true');
    var bits = ['🍬', '🍭', '🍫', '🎃', '⭐', '🍬', '👻', '🍭'];
    for (var i = 0; i < (big ? 30 : 16); i++) {
      var p = document.createElement('i');
      p.textContent = bits[i % bits.length]; p.className = 'emo';
      p.style.left = (Math.random() * 100) + '%';
      p.style.animationDelay = (Math.random() * 0.6) + 's'; p.style.animationDuration = (1.8 + Math.random() * 1.2) + 's';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3600);
  }

  /* ---------------- small pieces of markup ---------------- */

  function statsHtml(rows) {
    return '<div class="stats">' + rows.map(function (r) { return '<div class="stat"><b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span></div>'; }).join('') + '</div>';
  }
  function barOnly(t) {
    var bar = C.catBar(t);
    return '<div class="catbar" role="img" aria-label="' + esc(bar.filter(function (b) { return b.n; }).map(function (b) { return b.label + ' ' + b.n; }).join(', ') || 'Nothing counted yet') + '">' +
      bar.map(function (b) { return b.n ? '<i class="sw-' + b.cat + '" style="width:' + b.pct + '%"></i>' : ''; }).join('') + '</div>';
  }
  function legendHtml(t) {
    return '<div class="legend" aria-hidden="true">' + C.catBar(t).filter(function (b) { return b.n; }).map(function (b) { return '<span><i class="sw-' + b.cat + '"></i>' + esc(b.label) + ' ' + b.n + '</span>'; }).join('') + '</div>';
  }
  function barHtml(t) { return barOnly(t) + legendHtml(t); }
  /** A row of children to pick from. */
  function kidChips(act, selected, except) {
    var list = kids().filter(function (k) { return k.id !== except; });
    if (list.length < 2 && act !== 'tb' && act !== 'ta') return '';
    return '<div class="kids" role="group" aria-label="Who">' + list.map(function (k) {
      return '<button type="button" data-act="' + act + '" data-id="' + esc(k.id) + '" aria-pressed="' + (k.id === selected) + '"><span class="emo" aria-hidden="true">' + esc(k.avatar) + '</span><span>' + esc(nameOf(k)) + '</span></button>';
    }).join('') + '</div>';
  }
  function trialRibbon() {
    if (!state.trial) return '';
    return '<div class="ribbon" role="note"><span><b>Try it:</b> a made-up haul for Leo and Maya. Tap anything - nothing is saved.</span><button class="btn small" type="button" data-act="own">Count my own haul</button></div>';
  }
  var TEAL = '<div class="teal-line"><span class="emo" aria-hidden="true">🩵</span><span class="small"><b>Spotted a teal pumpkin on a porch?</b> That house has non-food treats too - stickers, pencils, little toys - so every kid gets something.</span></div>';

  /* ---------------- the first run ---------------- */

  function scene() {
    var stars = [[8, 18, 0], [22, 56, .6], [40, 10, 1.2], [58, 40, .3], [76, 70, 1.8], [90, 30, .9], [14, 84, 2.1], [66, 12, 1.5]].map(function (s) {
      return '<span class="star" style="left:' + s[0] + '%;top:' + s[1] + '%;animation-delay:' + s[2] + 's"></span>';
    }).join('');
    return '<div class="scene" aria-hidden="true"><span class="moon"></span>' + stars +
      '<svg class="bat" viewBox="0 0 64 32"><g class="wing"><path d="M32 15C26 5 14 2 2 8c6 2 8 6 8 10 4-3 8-3 10 0 2-3 6-3 8 0z" fill="#12061f" stroke="#ffe2c9" stroke-opacity=".55" stroke-width="1"/><path d="M32 15c6-10 18-13 30-7-6 2-8 6-8 10-4-3-8-3-10 0-2-3-6-3-8 0z" fill="#12061f" stroke="#ffe2c9" stroke-opacity=".55" stroke-width="1"/></g><ellipse cx="32" cy="17" rx="5" ry="7" fill="#12061f"/><path d="M28.5 11l1.2-4.5 2.3 3 2.3-3 1.2 4.5z" fill="#12061f"/><circle cx="30.3" cy="15" r="1" fill="#ffd166"/><circle cx="33.7" cy="15" r="1" fill="#ffd166"/></svg>' +
      '<svg class="pumpkin" viewBox="0 0 200 190"><path d="M104 44c-3-20 5-32 22-38" stroke="#4d7c0f" stroke-width="11" fill="none" stroke-linecap="round"/><ellipse cx="64" cy="114" rx="52" ry="70" fill="#d9480f"/><ellipse cx="136" cy="114" rx="52" ry="70" fill="#d9480f"/><ellipse cx="100" cy="114" rx="56" ry="76" fill="#f97316"/><path d="M64 100h24l-12-22zM112 100h24l-12-22z" fill="#ffd166"/><path d="M54 128c20 32 72 32 92 0l-13 5-8 13-9-12-10 13-10-13-10 13-9-12-8 12z" fill="#ffd166"/></svg>' +
      '<span class="candy emo" style="left:6%">🍬</span><span class="candy emo" style="left:22%;animation-delay:.5s">🍭</span><span class="candy emo" style="right:20%;animation-delay:1s">🍫</span><span class="candy emo" style="right:4%;animation-delay:1.5s">⭐</span></div>';
  }
  function viewFirst() {
    return '<div class="stack">' +
      '<section class="hero"><div class="hero-grid"><div>' +
      '<h1>Tip out the bag.</h1>' +
      '<p class="lead">Count it, sort it, trade it fair - and make it last.</p>' +
      '<p>Big tap-to-count tiles for every kind of candy, a fair-trade meter for siblings, a pieces-a-day plan that says when the stash runs out - and a haul card to show your friends.</p>' +
      '<div class="row" style="margin-top:14px"><button class="btn big" type="button" data-act="start">Count my haul</button><button class="btn big ghost" type="button" data-act="try">Try it</button></div>' +
      '<p class="quiet">Free. No sign-in. Everything stays on this device.</p>' +
      '</div>' + scene() + '</div></section>' +
      '<section class="card"><h2>How it works</h2><ol class="steps">' +
      '<li><div><b>Tip out the bag.</b> Add each trick-or-treater, then tap a tile for every piece - hold a tile (or tap −) to take one back.</div></li>' +
      '<li><div><b>Trade fair.</b> Two of you pick what you offer, and the meter says when it’s even: “Leo’s 2 peanut butter cups for Maya’s 6 lollipops is fair.”</div></li>' +
      '<li><div><b>Make it last.</b> Pick how many a day and Haul says when the stash runs out - “The stash lasts until Sun Nov 22” - with an Eat one button that keeps count.</div></li>' +
      '</ol></section>' +
      '<div class="grid two">' +
      feat('🃏', 'A haul card to share', 'Total pieces, full-size bars, the top three, the rarest find and a fun title - “The Chocolate Baron”, “Sour Specialist”. Drawn on this phone, never uploaded.') +
      feat('🛡️', 'Set aside for allergies', 'Mark the candy your family can’t have and it goes in a set-aside pile - kept out of the plan, and never handed over in a trade. You choose; Haul makes no allergy claims.') +
      feat('🧙', 'Switch Witch or buyback', 'Trading candy in for a toy or a little money? Set the deal and Haul works out what N pieces are worth - and which ones go first.') +
      feat('📷', 'Count it from a photo', 'Spread it out, snap one photo, and an AI proposes the counts for you to check. Needs a free account; everything else needs none.') +
      '</div>' + TEAL +
      '</div>';
  }
  function feat(emo, title, body) {
    return '<div class="card feat"><span class="emo" aria-hidden="true">' + esc(emo) + '</span><div><h3>' + esc(title) + '</h3><p class="small muted" style="margin:0">' + esc(body) + '</p></div></div>';
  }

  /* ---------------- adding trick-or-treaters ---------------- */

  function avatarGrid(selected, act) {
    return '<div class="avatars" role="group" aria-label="Costume">' + C.AVATARS.map(function (a) {
      return '<button type="button" class="emo" data-act="' + act + '" data-a="' + esc(a[0]) + '" aria-pressed="' + (selected === a[0]) + '" aria-label="' + esc(a[1]) + '">' + esc(a[0]) + '</button>';
    }).join('') + '</div>';
  }
  function viewKids() {
    var list = kids(), full = list.length >= C.LIMITS.kids;
    return '<div class="stack" style="max-width:720px;margin:0 auto">' + trialRibbon() +
      '<div><h1>Who went trick-or-treating?</h1><p class="muted">Add each trick-or-treater with a first name or a nickname - or just their costume. Names stay on this device.</p></div>' +
      (full ? '<p class="note">That’s ' + C.LIMITS.kids + ' trick-or-treaters - the most one device keeps.</p>' :
        '<div class="card"><label class="field" style="margin-top:0"><span>First name or nickname <span class="hint">(optional)</span></span><input class="input" id="kidName" maxlength="' + C.LIMITS.name + '" autocomplete="off" autocapitalize="words" enterkeyhint="done"></label>' +
        '<p class="field" style="margin-bottom:6px"><span>Pick a costume</span></p>' + avatarGrid(state.setup.avatar, 'setav') +
        '<button class="btn big block" type="button" data-act="addkid" style="margin-top:14px">Add trick-or-treater</button></div>') +
      (list.length ? '<div class="kid-list">' + list.map(function (k) {
        var t = C.totals(k, fam());
        return '<div class="kid-row"><span class="av emo" aria-hidden="true">' + esc(k.avatar) + '</span><div><b>' + esc(nameOf(k)) + '</b><div class="small muted">' + plural(t.total, 'piece') + '</div></div><button class="btn small ghost" type="button" data-act="editkid" data-id="' + esc(k.id) + '">Edit</button></div>';
      }).join('') + '</div><button class="btn big block" type="button" data-act="tab" data-tab="count">Start counting →</button>' : '') +
      '</div>';
  }
  function addKid() {
    if (kids().length >= C.LIMITS.kids) return;
    var inp = $('#kidName');
    var raw = inp ? inp.value : '';
    var name = C.cleanName(raw, C.LIMITS.name);
    if (raw.trim() && !name) { toast('Use letters or numbers for a name - or leave it blank and go by the costume.'); return; }
    var kid = C.newKid(name, state.setup.avatar, uid(10));
    var f = fam();
    setFam(Object.assign({}, f, { kids: f.kids.concat([kid]) }));
    setKid(kid.id);
    var used = kids().map(function (k) { return k.avatar; });
    var next = C.AVATARS.filter(function (a) { return used.indexOf(a[0]) < 0; })[0];
    state.setup.avatar = next ? next[0] : C.AVATARS[0][0];
    say(nameOf(kid) + ' added.');
    draw();
    var again = $('#kidName'); if (again) again.focus();
  }
  function openEditKid(id) {
    var k = kidOf(id); if (!k) return;
    var av = k.avatar;
    sheet('<div class="body"></div>', function (root) {
      var b = $('.body', root);
      function paint() {
        b.innerHTML = '<h2>Edit ' + esc(nameOf(k)) + '</h2>' +
          '<label class="field"><span>First name or nickname <span class="hint">(optional)</span></span><input class="input" id="ekName" maxlength="' + C.LIMITS.name + '" autocomplete="off" value="' + esc(k.name) + '"></label>' +
          '<p class="field" style="margin-bottom:6px"><span>Costume</span></p>' + avatarGrid(av, 'ekav') +
          '<div id="ekErr"></div><div class="row" style="margin-top:14px"><button class="btn" type="button" id="ekSave">Save</button><button class="btn ghost" type="button" id="ekDel">Remove</button></div>';
        $$('[data-act="ekav"]', b).forEach(function (x) { x.addEventListener('click', function (e) { e.stopPropagation(); av = x.getAttribute('data-a'); var keepName = $('#ekName', b).value; paint(); $('#ekName', b).value = keepName; }); });
        $('#ekSave', b).addEventListener('click', function () {
          var raw = $('#ekName', b).value, nm = C.cleanName(raw, C.LIMITS.name);
          if (raw.trim() && !nm) { $('#ekErr', b).innerHTML = '<p class="err">Use letters or numbers for a name - or leave it blank.</p>'; return; }
          var f = fam(), cur = C.kidById(f, k.id);
          setFam(Object.assign({}, f, { kids: f.kids.map(function (x) { return x.id === k.id ? C.cleanKid(Object.assign({}, cur, { name: nm, avatar: av }), f.custom) : x; }) }));
          closeSheet(); draw(); toast('Saved.');
        });
        $('#ekDel', b).addEventListener('click', function () {
          if (!confirm('Remove ' + nameOf(k) + ' and their count from this device?')) return;
          var f = fam();
          setFam(C.cleanFamily(Object.assign({}, f, { kids: f.kids.filter(function (x) { return x.id !== k.id; }) })));
          state.undo = state.undo.filter(function (s) { return s.kid !== k.id; });
          state.oa = {}; state.ob = {};
          closeSheet(); draw(); toast('Removed.');
        });
      }
      paint();
    });
  }

  /* ---------------- home ---------------- */

  function viewHome() {
    var f = fam(), list = kids();
    var all = C.totals(C.familyKid(f), f);
    var aside = list.reduce(function (s, k) { return s + C.totals(k, f).aside; }, 0);
    return '<div class="stack">' + trialRibbon() +
      '<div class="sec-head"><h1>' + (list.length > 1 ? 'The family haul' : 'The haul') + '</h1><span class="muted small">' + esc(C.dayLabel(C.dayNum(day()))) + '</span></div>' +
      (list.length > 1 ? '<div class="card"><div class="kid-head" style="grid-template-columns:minmax(0,1fr) auto"><div><b>Everyone together</b><div class="small muted">' + esc(C.titleFor(all).title) + '</div></div><div class="big-n">' + all.total + '<small>pieces</small></div></div><div style="margin-top:10px">' + barHtml(all) + '</div>' +
        '<div style="margin-top:10px">' + statsHtml([[String(all.full), 'full-size'], [String(all.kinds), 'kinds'], [String(aside), 'set aside']]) + '</div></div>' : '') +
      '<div class="grid two">' + list.map(kidCard).join('') + '</div>' +
      '<div class="row">' + (list.length < C.LIMITS.kids ? '<button class="btn ghost" type="button" data-act="go" data-v="kids">＋ Add a trick-or-treater</button>' : '') +
      '<button class="btn soft ai" type="button" data-act="photo"> Count it from a photo</button>' +
      '<button class="btn ghost" type="button" data-act="go" data-v="aside">🛡️ Set aside</button>' +
      '<button class="btn ghost" type="button" data-act="go" data-v="settings">⚙️ Grown-ups</button></div>' +
      TEAL + '</div>';
  }
  function kidCard(k) {
    var f = fam(), t = C.totals(k, f), p = C.plan(k, f, day()), tp = C.top(k, f, 3);
    return '<article class="card kid-card"><div class="kid-head"><span class="av emo" aria-hidden="true">' + esc(k.avatar) + '</span><div><h2>' + esc(nameOf(k)) + '</h2><span class="small muted">' + esc(C.titleFor(t).title) + '</span></div><div class="big-n">' + t.total + '<small>pieces</small></div></div>' +
      (t.total ? barHtml(t) : '<p class="small muted" style="margin:0">Nothing counted yet - tip out the bag.</p>') +
      (tp.length ? '<p class="small" style="margin:0"><b>Top:</b> ' + tp.map(function (x) { return '<span class="emo" aria-hidden="true">' + esc(x.emoji) + '</span> ' + esc(x.name) + ' ' + x.n; }).join(' · ') + '</p>' : '') +
      (t.total ? '<p class="small" style="margin:0">' + esc(p.todayWords) + (p.lastLabel ? ' · lasts until ' + esc(p.lastLabel) : '') + '</p>' : '') +
      (t.aside ? '<p style="margin:0"><span class="pill teal">' + plural(t.aside, 'piece') + ' set aside</span></p>' : '') +
      '<div class="row"><button class="btn small" type="button" data-act="countkid" data-id="' + esc(k.id) + '">Count</button><button class="btn small ghost" type="button" data-act="cardkid" data-id="' + esc(k.id) + '">Haul card</button><button class="btn small ghost" type="button" data-act="plankid" data-id="' + esc(k.id) + '">Make it last</button></div></article>';
  }

  /* ---------------- counting ---------------- */

  function tileHtml(cd, n) {
    return '<div class="tile' + (n ? ' has' : '') + '" data-tile="' + esc(cd.id) + '" data-cat="' + esc(cd.cat) + '">' +
      '<button class="tile-main" type="button" data-act="plus" data-id="' + esc(cd.id) + '" aria-label="' + esc(cd.name + ': ' + n + '. Add one') + '"><span class="emo" aria-hidden="true">' + esc(cd.emoji) + '</span><span class="nm">' + esc(cd.name) + '</span></button>' +
      '<b class="n" aria-hidden="true">' + n + '</b>' +
      '<button class="tile-minus" type="button" data-act="minus" data-id="' + esc(cd.id) + '" aria-label="' + esc('Take one ' + cd.one + ' away') + '">−</button></div>';
  }
  function viewCount() {
    var f = fam(), k = activeKid(), t = C.totals(k, f);
    var custom = f.custom;
    var sections = C.CATS.map(function (cat) {
      var list = C.catalog(custom).filter(function (cd) { return cd.cat === cat.id; });
      return '<section data-sec="' + cat.id + '"><h2 class="cat-title"><i class="sw-' + cat.id + '" aria-hidden="true"></i>' + esc(cat.label) + '</h2><div class="tiles" style="margin-top:8px">' + list.map(function (cd) { return tileHtml(cd, k.counts[cd.id] || 0); }).join('') + '</div></section>';
    }).join('');
    var chips = [['all', 'All'], ['have', 'In the bag']].concat(C.CATS.map(function (c) { return [c.id, c.label]; }));
    return '<div class="stack">' + trialRibbon() + kidChips('pickkid', k.id) +
      '<div class="count-head"><div class="count-top"><span class="av emo" aria-hidden="true">' + esc(k.avatar) + '</span><div style="min-width:0"><div class="who">' + esc(nameOf(k)) + '</div><div class="tiny muted">Tap to add. Hold or − to take back.</div></div>' +
      '<button class="btn small ghost" type="button" data-act="undo" id="undoBtn"' + (undoFor(k.id) ? '' : ' disabled') + '>↶ Undo</button><div class="total" id="cTotal" aria-live="polite">' + t.total + '<small>pieces</small></div></div>' +
      '<div class="catbar-only" id="cBarTop">' + barOnly(t) + '</div></div>' +
      '<div id="cLegend">' + legendHtml(t) + '</div>' +
      '<input class="input" id="q" type="search" placeholder="Find a candy…" aria-label="Find a candy" autocomplete="off" value="' + esc(state.q) + '">' +
      '<div class="cats" role="group" aria-label="Show">' + chips.map(function (c) { return '<button class="chip" type="button" data-act="cat" data-v="' + c[0] + '" aria-pressed="' + (state.cat === c[0]) + '">' + esc(c[1]) + '</button>'; }).join('') + '</div>' +
      '<div class="row"><button class="btn small soft ai" type="button" data-act="photo"> Count it from a photo</button><button class="btn small ghost" type="button" data-act="go" data-v="aside">🛡️ Set aside</button><button class="btn small ghost" type="button" data-act="cardkid" data-id="' + esc(k.id) + '">🃏 Haul card</button></div>' +
      '<div id="tiles" class="stack">' + sections +
      '<div class="tiles"><div class="tile other"><button class="tile-main" type="button" data-act="other"><span class="emo" aria-hidden="true">＋</span><span class="nm">Other…</span></button></div></div>' +
      '<p class="note" id="noMatch" hidden>Nothing called that here. <button class="link-btn" type="button" data-act="other">Add it as Other</button></p></div>' +
      '</div>';
  }
  function undoFor(kidId) {
    for (var i = state.undo.length - 1; i >= 0; i--) if (state.undo[i].kid === kidId) return state.undo[i];
    return null;
  }
  function applyFilter() {
    var k = activeKid(); if (!k) return;
    var f = fam(), any = false;
    $$('[data-sec]').forEach(function (sec) {
      var shown = 0;
      $$('.tile[data-tile]', sec).forEach(function (el) {
        var cd = C.candyOf(el.getAttribute('data-tile'), f.custom);
        if (!cd) return;
        var n = k.counts[cd.id] || 0;
        var ok = cd && C.matches(cd, state.q) && (state.cat === 'all' || (state.cat === 'have' ? n > 0 : state.cat === cd.cat));
        el.hidden = !ok; if (ok) shown++;
      });
      sec.hidden = !shown; if (shown) any = true;
    });
    var nm = $('#noMatch'); if (nm) nm.hidden = any || !state.q;
  }
  var MILESTONES = [25, 50, 100, 150, 200, 300];
  /** One tap on a tile: +1 or -1, patched in place (no redraw, so the grid
   *  never jumps under a thumb). */
  function countTap(id, d) {
    var k = activeKid(); if (!k) return;
    var before = C.totals(k, fam()).total;
    var delta = {}; delta[id] = d;
    var r = C.adjust(fam(), k.id, delta);
    if (!Object.keys(r.applied).length) { if (d < 0) toast('None of those to take back.'); return; }
    setFam(r.fam);
    state.undo = C.pushUndo(state.undo, { kid: k.id, applied: r.applied });
    patchCount(id, d);
    buzz();
    var after = C.totals(activeKid(), fam()).total;
    MILESTONES.forEach(function (m) { if (before < m && after >= m) { toast(m + ' pieces! What a haul.'); celebrate(m >= 100); } });
  }
  function patchCount(id, d) {
    var k = activeKid(), f = fam(), t = C.totals(k, f);
    var el = document.querySelector('.tile[data-tile="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (el) {
      var n = k.counts[id] || 0, cd = C.candyOf(id, f.custom);
      el.classList.toggle('has', n > 0);
      $('.n', el).textContent = String(n);
      $('.tile-main', el).setAttribute('aria-label', cd.name + ': ' + n + '. Add one');
      if (d > 0 && !RM.matches) {
        el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
        var p = document.createElement('span'); p.className = 'plus1'; p.textContent = '+1'; p.setAttribute('aria-hidden', 'true');
        el.appendChild(p); setTimeout(function () { p.remove(); }, 650);
      }
      say((d > 0 ? 'Added. ' : 'Taken back. ') + cd.name + ': ' + n);
    }
    var tot = $('#cTotal');
    if (tot) { tot.innerHTML = t.total + '<small>pieces</small>'; if (!RM.matches) { tot.classList.remove('pop'); void tot.offsetWidth; tot.classList.add('pop'); } }
    var bar = $('#cBarTop'); if (bar) bar.innerHTML = barOnly(t);
    var lg = $('#cLegend'); if (lg) lg.innerHTML = legendHtml(t);
    var ub = $('#undoBtn'); if (ub) ub.disabled = !undoFor(k.id);
    if (state.cat === 'have') applyFilter();
  }
  function undoLast() {
    var k = activeKid(); if (!k) return;
    var step = undoFor(k.id);
    if (!step) { toast('Nothing to undo.'); return; }
    state.undo.splice(state.undo.lastIndexOf(step), 1);
    setFam(C.undoStep(fam(), step));
    if (state.view === 'count') { Object.keys(step.applied).forEach(function (id) { patchCount(id, 0); }); }
    else draw();
    toast('Undone.');
  }
  function openOther() {
    var cat = 'choc';
    sheet('<div class="body"></div>', function (root) {
      var b = $('.body', root);
      function paint(name) {
        b.innerHTML = '<h2>Add another kind</h2><p class="muted">Not on the list? Give it a name and a group - it gets its own tile.</p>' +
          '<label class="field"><span>What is it?</span><input class="input" id="oName" maxlength="' + C.LIMITS.customName + '" autocomplete="off" value="' + esc(name) + '"></label>' +
          '<p class="field" style="margin-bottom:6px"><span>Which group?</span></p><div class="seg" role="group" aria-label="Group">' + C.CATS.map(function (c) { return '<button type="button" data-oc="' + c.id + '" aria-pressed="' + (cat === c.id) + '">' + esc(c.label) + '</button>'; }).join('') + '</div>' +
          '<div id="oErr"></div><button class="btn big block" type="button" id="oSave" style="margin-top:14px">Add it (+1)</button>';
        $$('[data-oc]', b).forEach(function (x) { x.addEventListener('click', function () { cat = x.getAttribute('data-oc'); paint($('#oName', b).value); }); });
        $('#oSave', b).addEventListener('click', function () {
          var nm = C.cleanName($('#oName', b).value, C.LIMITS.customName);
          if (!nm) { $('#oErr', b).innerHTML = '<p class="err">Give it a name with letters or numbers.</p>'; return; }
          var known = C.knownByName(nm);
          var f = fam();
          var cd = known || C.findCustom(f.custom, nm, cat);
          if (!cd) {
            if (f.custom.length >= C.LIMITS.custom) { $('#oErr', b).innerHTML = '<p class="err">That’s ' + C.LIMITS.custom + ' extra kinds - the most Haul keeps. Use the closest tile instead.</p>'; return; }
            cd = C.customCandy(nm, cat, 'x' + uid(8));
            setFam(Object.assign({}, f, { custom: f.custom.concat([cd]) }));
          }
          closeSheet();
          state.q = ''; state.cat = 'all';
          draw();
          countTap(cd.id, 1);
          toast((known ? 'That one’s on the list - ' : 'Added ') + cd.name + ' +1');
        });
      }
      paint(state.q);
    });
  }

  /* ---------------- fair trade ---------------- */

  function viewTrade() {
    var f = fam(), list = kids();
    if (list.length < 2) {
      return '<div class="stack">' + trialRibbon() + '<div class="empty card"><span class="emo" aria-hidden="true">🤝</span><h1>Fair trade</h1><p class="muted">Trading needs two trick-or-treaters on this device - a brother, a sister, a cousin, a friend from the street.</p><button class="btn big" type="button" data-act="go" data-v="kids">＋ Add a trick-or-treater</button></div></div>';
    }
    if (!kidOf(state.ta)) state.ta = list[0].id;
    if (!kidOf(state.tb) || state.tb === state.ta) state.tb = list.filter(function (k) { return k.id !== state.ta; })[0].id;
    var A = kidOf(state.ta), B = kidOf(state.tb);
    var chk = C.tradeCheck(f, A.id, B.id, state.oa, state.ob);
    state.oa = chk.ga || {}; state.ob = chk.gb || {};
    return '<div class="stack">' + trialRibbon() +
      '<div><h1>Fair trade</h1><p class="muted">Each of you taps what you offer. The meter says when it’s even - and a gift is fine too, if you both say so.</p></div>' +
      (list.length > 2 ? '<div class="card"><p class="lab">Who’s trading?</p>' + kidChips('ta', A.id) + '<p class="lab" style="margin-top:10px">with</p>' + kidChips('tb', B.id, A.id) + '</div>' : '') +
      '<div class="trade-grid stack">' + sideHtml(A, B, state.oa, 'a') + sideHtml(B, A, state.ob, 'b') + '</div>' +
      meterHtml(chk, A, B) +
      logHtml() +
      '<p class="small muted">Points: ' + C.CATS.map(function (c) { return esc(c.label) + ' ' + f.values[c.id]; }).join(' · ') + '. <button class="link-btn" type="button" data-act="go" data-v="settings">Change them</button></p>' +
      '</div>';
  }
  function meterHtml(chk, A, B) {
    var sum = chk.va + chk.vb;
    var pos = sum ? Math.max(5, Math.min(95, 50 - ((chk.va - chk.vb) / sum) * 50)) : 50;
    var can = chk.state === 'fair' || chk.state === 'leans';
    var label = chk.state === 'fair' ? 'Swap! 🤝' : chk.state === 'leans' ? 'Swap anyway (a gift)' : 'Swap';
    var pts = function (v) { return C.points(v).replace(' points', ' pts').replace(' point', ' pt'); };
    return '<section class="meter m-' + esc(chk.state) + '" aria-live="polite">' +
      '<div class="mrow"><span class="mside"><span class="emo" aria-hidden="true">' + esc(A.avatar) + '</span><b>' + esc(pts(chk.va)) + '</b></span>' +
      '<div class="scale" role="img" aria-label="' + esc(nameOf(A) + ' ' + C.points(chk.va) + ', ' + nameOf(B) + ' ' + C.points(chk.vb)) + '"><span class="zone"></span><span class="needle" style="left:' + pos.toFixed(1) + '%"></span></div>' +
      '<span class="mside"><b>' + esc(pts(chk.vb)) + '</b><span class="emo" aria-hidden="true">' + esc(B.avatar) + '</span></span></div>' +
      '<p class="verdict">' + (chk.state === 'fair' ? '✓ ' : '') + esc(chk.words) + '</p>' +
      (chk.hint ? '<p class="small" style="margin:0">' + esc(chk.hint) + '</p>' : '') +
      '<div class="row"><button class="btn" type="button" data-act="swap"' + (can ? '' : ' disabled') + '>' + esc(label) + '</button>' +
      (C.pieces(chk.ga || {}) + C.pieces(chk.gb || {}) ? '<button class="btn ghost" type="button" data-act="clearoffer">Clear</button>' : '') + '</div></section>';
  }
  function sideHtml(kid, other, offer, side) {
    var f = fam();
    var list = C.catalog(f.custom).filter(function (cd) { return kid.counts[cd.id] > 0; });
    var on = C.pieces(offer);
    return '<section class="card"><h2><span class="emo" aria-hidden="true">' + esc(kid.avatar) + '</span> ' + esc(nameOf(kid)) + ' gives</h2>' +
      '<p class="small muted">' + (on ? esc(plural(on, 'piece') + ' · ' + C.points(C.offerValue(offer, f))) : 'Tap what ' + esc(nameOf(kid)) + ' offers.') + '</p>' +
      (list.length ? '<div class="offer-grid">' + list.map(function (cd) {
        var have = kid.counts[cd.id], n = offer[cd.id] || 0, blocked = other.aside.indexOf(cd.id) >= 0, mine = kid.aside.indexOf(cd.id) >= 0;
        var sub = blocked ? nameOf(other) + ' sets these aside' : n ? 'Offering ' + n + ' of ' + have : have + ' · ' + C.points(C.valueOf(cd.id, f)) + ' each';
        return '<div class="offer-wrap"><button class="ochip" type="button" data-act="offer" data-side="' + side + '" data-id="' + esc(cd.id) + '" aria-pressed="' + (n > 0) + '"' + (blocked ? ' disabled' : '') + '>' +
          '<span class="emo" aria-hidden="true">' + esc(cd.emoji) + '</span><b>' + esc(cd.name) + '</b><small>' + esc(sub) + '</small>' + (mine ? '<span class="pill teal tag">set aside</span>' : '') + '</button>' +
          (n ? '<b class="offer-n" aria-hidden="true">' + n + '</b><button class="offer-minus" type="button" data-act="unoffer" data-side="' + side + '" data-id="' + esc(cd.id) + '" aria-label="' + esc('One less ' + cd.one) + '">−</button>' : '') + '</div>';
      }).join('') + '</div>' : '<p class="muted">Nothing to trade yet - count first.</p>') + '</section>';
  }
  function logHtml() {
    var f = fam(), t = f.trades.slice(-10).reverse();
    if (!t.length) return '';
    return '<section class="card"><h2>Trade log</h2><div class="log">' + t.map(function (x, i) {
      return '<div class="log-row"><p><span class="tiny muted">' + esc(x.at ? C.dayLabel(C.dayNum(dayOf(x.at))) : '') + '</span><br>' + (x.fair ? '✓ ' : '🎁 ') + esc(x.words) + '</p>' +
        (i === 0 ? '<button class="btn small ghost" type="button" data-act="untrade" data-id="' + esc(x.id) + '">Undo</button>' : '') + '</div>';
    }).join('') + '</div></section>';
  }
  function dayOf(ms) { var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function offerTap(side, id, d) {
    var k = kidOf(side === 'a' ? state.ta : state.tb); if (!k) return;
    var o = side === 'a' ? state.oa : state.ob;
    var n = Math.max(0, Math.min(k.counts[id] || 0, (o[id] || 0) + d));
    if (d > 0 && n === (o[id] || 0)) { toast('That’s all of them.'); return; }
    if (n) o[id] = n; else delete o[id];
    draw();
  }
  function doSwap() {
    var f = fam(), chk = C.tradeCheck(f, state.ta, state.tb, state.oa, state.ob);
    var r = C.applyTrade(f, state.ta, state.tb, state.oa, state.ob, Date.now(), uid(10));
    if (!r) { toast(chk.words); return; }
    setFam(r.fam);
    state.oa = {}; state.ob = {};
    draw();
    if (r.trade.fair) celebrate(false);
    toast(r.trade.fair ? 'Swapped - a fair trade!' : 'Swapped - what a kind gift.', 3600, { label: 'Undo', fn: function () { undoTrade(r.trade.id); } });
  }
  function undoTrade(id) {
    var next = C.undoTrade(fam(), id);
    if (!next) { toast('That one can’t be undone - some of those pieces have moved on.'); return; }
    setFam(next); draw(); toast('Trade undone.');
  }

  /* ---------------- make it last ---------------- */

  function viewPlan() {
    var f = fam(), k = activeKid(), p = C.plan(k, f, day()), b = f.buyback;
    var dots = '';
    if (p.todayOn) for (var i = 0; i < Math.min(p.perDay, 12); i++) dots += '<i class="' + (i < p.eatenToday ? 'on' : '') + '"></i>';
    var nEat = C.eatable(k, f).length;
    var maxN = p.edible;
    if (state.buyN === null || state.buyN > maxN) state.buyN = Math.min(maxN, b.mode === 'prize' ? b.pieces : Math.min(20, maxN));
    return '<div class="stack">' + trialRibbon() + kidChips('pickkid', k.id) +
      '<div><h1>Make it last</h1><p class="muted">Agree on how many a day together - then Haul keeps count, so nobody has to argue about it.</p></div>' +
      '<div class="plan-grid stack">' +
      '<section class="today"><p class="lab" style="color:var(--hero-soft);margin:0">' + esc(nameOf(k)) + ' · today</p><h2>' + esc(p.todayWords) + '</h2>' +
      (dots ? '<div class="dots" aria-hidden="true">' + dots + '</div>' : '') +
      (p.over ? '<p>That’s today’s pieces. More tomorrow!</p>' : '') +
      '<div class="row"><button class="btn big" type="button" data-act="eat"' + (nEat ? '' : ' disabled') + '>Eat one 😋</button>' + (state.lastEat && state.lastEat.kid === k.id ? '<button class="btn ghost" type="button" data-act="uneat">Undo</button>' : '') + '</div>' +
      (nEat ? '' : '<p>' + esc(p.words) + '</p>') + '</section>' +
      '<section class="card"><h2>How many a day?</h2>' +
      '<label class="field"><span>Pieces a day: <b id="perDayOut">' + p.perDay + '</b></span><input type="range" id="perDay" min="0" max="' + C.LIMITS.perDayMax + '" step="1" value="' + p.perDay + '"></label>' +
      '<p class="field" style="margin-bottom:6px"><span>Which days?</span></p><div class="days" role="group" aria-label="Days">' + C.WD.map(function (w, i) { return '<button type="button" data-act="day" data-v="' + i + '" aria-pressed="' + (p.days[i] === true) + '">' + w + '</button>'; }).join('') + '</div>' +
      '<div class="row" style="margin-top:6px"><button class="link-btn" type="button" data-act="days" data-v="all">Every day</button><button class="link-btn" type="button" data-act="days" data-v="school">School nights</button><button class="link-btn" type="button" data-act="days" data-v="weekend">Weekends</button></div>' +
      '<p class="lasts" id="lastsOut">' + esc(p.words) + '</p><p class="small muted" id="lastsSub">' + esc(lastsSub(p)) + '</p>' +
      '<div class="week" id="weekOut">' + weekHtml(p) + '</div></section></div>' +
      buybackHtml(k, p) + '</div>';
  }
  function lastsSub(p) {
    if (!p.edible || p.never) return p.aside || p.nonFood ? notCounted(p) : '';
    return plural(p.candyDays, 'candy day') + ' at ' + p.perDay + ' a day · ' + plural(p.edible, 'piece') + ' to go' + (p.aside || p.nonFood ? '. ' + notCounted(p) : '');
  }
  function notCounted(p) {
    var bits = [];
    if (p.aside) bits.push(plural(p.aside, 'set-aside piece'));
    if (p.nonFood) bits.push(p.nonFood + ' not for eating');
    return 'Not counted: ' + bits.join(' and ') + '.';
  }
  function weekHtml(p) {
    return p.upcoming.map(function (u, i) { return '<div class="' + (u.on ? '' : 'off') + '"><span>' + (i === 0 ? 'Today' : esc(u.label)) + '</span><b>' + (u.on ? u.n : '–') + '</b></div>'; }).join('');
  }
  function patchPlanPreview(perDay) {
    var k = activeKid(); if (!k) return;
    var tmp = C.setPlan(fam(), k.id, { perDay: perDay });
    var p = C.plan(C.kidById(tmp, k.id), tmp, day());
    $('#perDayOut').textContent = String(perDay);
    $('#lastsOut').textContent = p.words;
    $('#lastsSub').textContent = lastsSub(p);
    $('#weekOut').innerHTML = weekHtml(p);
  }
  function buybackHtml(k, p) {
    var b = fam().buyback, n = state.buyN || 0;
    var pick = C.tradeInPick(k, fam(), n);
    return '<section class="card"><h2>🧙 Switch Witch or buyback <span class="pill plain">optional</span></h2>' +
      '<p class="small muted">Some families trade candy in for a toy or a little money. A grown-up sets the deal. Set-aside candy and things nobody eats stay put; the lowest-points pieces go first, so favourites stay.</p>' +
      '<div class="seg" role="group" aria-label="Deal"><button type="button" data-act="bbmode" data-v="cents" aria-pressed="' + (b.mode === 'cents') + '">Cents a piece</button><button type="button" data-act="bbmode" data-v="prize" aria-pressed="' + (b.mode === 'prize') + '">A prize</button></div>' +
      (b.mode === 'cents'
        ? '<label class="field"><span>Cents a piece</span><input class="input" id="bbCents" type="number" inputmode="numeric" min="0" max="' + C.LIMITS.centsMax + '" step="1" value="' + b.cents + '" style="max-width:160px"></label>'
        : '<div class="grid two"><label class="field"><span>The prize</span><input class="input" id="bbPrize" maxlength="' + C.LIMITS.prize + '" value="' + esc(b.prize) + '"></label><label class="field"><span>Pieces it takes</span><input class="input" id="bbPieces" type="number" inputmode="numeric" min="1" max="' + C.LIMITS.prizePieces + '" value="' + b.pieces + '"></label></div>') +
      (p.edible ? '<label class="field"><span>Trade in: <b id="bbNOut">' + n + '</b> pieces</span><input type="range" id="bbN" min="0" max="' + p.edible + '" step="1" value="' + n + '"></label>' +
        '<p class="lasts" id="bbWords">' + esc(C.buybackWords(b, n)) + '</p>' +
        '<p class="goes" id="bbGoes">' + esc(goesWords(pick)) + '</p>' +
        '<button class="btn" type="button" data-act="tradein"' + (n ? '' : ' disabled') + '>Trade them in</button>'
        : '<p class="muted">Nothing left to trade in.</p>') + '</section>';
  }
  function goesWords(pick) {
    var f = fam();
    if (!C.pieces(pick)) return 'Slide to pick how many.';
    return 'These go: ' + C.describeOffer(pick, f, 4) + '.';
  }
  function patchBuyback() {
    var k = activeKid(), b = fam().buyback, n = state.buyN || 0;
    var o = $('#bbNOut'); if (o) o.textContent = String(n);
    var w = $('#bbWords'); if (w) w.textContent = C.buybackWords(b, n);
    var g = $('#bbGoes'); if (g) g.textContent = goesWords(C.tradeInPick(k, fam(), n));
    var btn = $('[data-act="tradein"]'); if (btn) btn.disabled = !n;
  }
  function openEat() {
    var k = activeKid(), f = fam(), p = C.plan(k, f, day()), list = C.eatable(k, f);
    sheet('<div class="body"></div>', function (root) {
      var b = $('.body', root);
      function grid() {
        return '<div class="eat-grid">' + list.map(function (x) { return '<button type="button" data-eat="' + esc(x.id) + '"><span class="emo" aria-hidden="true">' + esc(x.emoji) + '</span><span>' + esc(x.name) + '</span><small>' + x.n + ' left</small></button>'; }).join('') + '</div>';
      }
      function bind() {
        $$('[data-eat]', b).forEach(function (x) {
          x.addEventListener('click', function () {
            var id = x.getAttribute('data-eat'), t = day();
            var next = C.eatOne(fam(), k.id, id, t);
            if (!next) return;
            setFam(next);
            state.lastEat = { kid: k.id, id: id, day: t };
            closeSheet(); draw();
            var p2 = C.plan(activeKid(), fam(), t);
            toast('Enjoy! ' + (p2.todayOn ? (p2.leftToday ? p2.leftToday + ' left today.' : 'That’s today’s last one.') : ''), 3200, { label: 'Undo', fn: uneatLast });
          });
        });
      }
      if ((p.over || !p.todayOn) && !p.never) {
        b.innerHTML = '<h2>' + (p.todayOn ? 'That’s today’s ' + p.perDay : 'Today is a day off') + '</h2><p class="muted">' + (p.todayOn ? 'More tomorrow! ' : '') + 'A grown-up can say yes to one more.</p><button class="btn big block" type="button" id="yes">Grown-up says yes</button>';
        $('#yes', b).addEventListener('click', function () { b.innerHTML = '<h2>Pick one</h2>' + grid(); bind(); });
      } else {
        b.innerHTML = '<h2>Which one?</h2><p class="muted">' + esc(p.todayWords) + '</p>' + grid();
        bind();
      }
    });
  }
  function uneatLast() {
    var e = state.lastEat; if (!e) return;
    setFam(C.uneat(fam(), e.kid, e.id, e.day));
    state.lastEat = null; draw(); toast('Put back.');
  }

  /* ---------------- set aside ---------------- */

  function viewAside() {
    var f = fam(), k = activeKid(), pile = C.asidePile(k, f), n = pile.reduce(function (s, r) { return s + r.n; }, 0);
    var list = C.catalog(f.custom).filter(function (cd) { return state.showAllAside || k.counts[cd.id] > 0 || k.aside.indexOf(cd.id) >= 0; });
    return '<div class="stack">' + trialRibbon() + kidChips('pickkid', k.id) +
      '<div><h1>Set aside</h1><p class="muted">Tap the kinds ' + esc(nameOf(k)) + ' sets aside. They go in a set-aside pile: left out of the daily plan, never handed to ' + esc(nameOf(k)) + ' in a trade - and still there to trade away.</p></div>' +
      '<div class="note"><p><b>You choose what goes in this pile.</b> Haul has no allergy or ingredient information of its own - it only keeps the choices you make here.</p><p style="margin:0"><b>Always read the label - recipes and sizes change.</b></p></div>' +
      '<section class="pile"><b class="h">' + esc(nameOf(k)) + '’s set-aside pile: ' + plural(n, 'piece') + '</b>' +
      (pile.length ? '<span>' + pile.map(function (r) { return '<span class="emo" aria-hidden="true">' + esc(r.emoji) + '</span> ' + esc(r.name) + ' ' + r.n; }).join(' · ') + '</span>' : '<span class="small">Nothing in it yet.</span>') +
      '<div class="row">' + (n ? '<button class="btn small" type="button" data-act="handover">Hand it to a grown-up</button>' : '') + (kids().length > 1 && k.aside.length ? '<button class="btn small ghost" type="button" data-act="asideall">Same for everyone</button>' : '') + '</div></section>' +
      (list.length ? '<div class="aside-grid">' + list.map(function (cd) {
        var on = k.aside.indexOf(cd.id) >= 0, have = k.counts[cd.id] || 0;
        return '<button type="button" data-act="aside" data-id="' + esc(cd.id) + '" aria-pressed="' + on + '"><span class="emo" aria-hidden="true">' + esc(cd.emoji) + '</span><b>' + esc(cd.name) + '</b><small>' + (on ? 'Set aside' : 'Keep') + (have ? ' · ' + have : '') + '</small></button>';
      }).join('') + '</div>' : '<p class="muted">Nothing counted yet - or show every kind to choose ahead.</p>') +
      '<label class="check"><input type="checkbox" id="asideAll"' + (state.showAllAside ? ' checked' : '') + '> Show every kind, not just what’s in the bag</label>' +
      '<p class="small muted">Trading tip: set-aside candy can still be swapped away for something else - try <button class="link-btn" type="button" data-act="tab" data-tab="trade">Trade</button>.</p>' +
      TEAL + '</div>';
  }

  /* ---------------- the haul card ---------------- */

  function cardWho() {
    var w = state.card.who;
    if (w === 'family' && kids().length > 1) return w;
    if (kidOf(w)) return w;
    var k = activeKid();
    return k ? k.id : null;
  }
  function viewCard() {
    var f = fam(), who = cardWho();
    if (state.card.names === null) state.card.names = C.cardNamesDefault(f, who);
    var d = C.cardData(f, who, { names: state.card.names });
    var anyName = who === 'family' ? kids().some(function (k) { return k.name; }) : Boolean(kidOf(who) && kidOf(who).name);
    var opts = kids().map(function (k) { return [k.id, k.avatar, nameOf(k)]; });
    if (kids().length > 1) opts.push(['family', '👪', 'Whole family']);
    var canShare = canShareFiles();
    return '<div class="stack" style="max-width:760px;margin:0 auto">' + trialRibbon() +
      '<div><h1>The haul card</h1><p class="muted">Pick who it’s for, draw it, then share it. Drawn on this phone, never uploaded.</p></div>' +
      (opts.length > 1 ? '<div class="kids" role="group" aria-label="Card for">' + opts.map(function (o) { return '<button type="button" data-act="cardwho" data-id="' + esc(o[0]) + '" aria-pressed="' + (o[0] === who) + '"><span class="emo" aria-hidden="true">' + esc(o[1]) + '</span><span>' + esc(o[2]) + '</span></button>'; }).join('') + '</div>' : '') +
      (anyName ? '<label class="check"><input type="checkbox" id="cardNames"' + (state.card.names ? ' checked' : '') + '> Show ' + (who === 'family' ? 'names' : 'the name') + ' on the card</label>' : '') +
      (state.card.url ? '<img class="card-img" alt="The haul card, ready to share" src="' + esc(state.card.url) + '">' : previewHtml(d)) +
      '<div class="row">' + (state.card.blob ? '<button class="btn big" type="button" data-act="sharecard">' + (canShare ? 'Share it' : 'Download it') + '</button><button class="btn big ghost" type="button" data-act="drawcard">Draw it again</button>'
        : '<button class="btn big" type="button" data-act="drawcard">Draw the card</button>') + '</div>' +
      '<p class="small muted">' + (state.card.blob ? (canShare ? 'Share sends the picture from this phone - it’s never uploaded anywhere.' : 'It downloads as a picture made on this device - never uploaded.') : 'Two taps: draw it, then share it.') + '</p>' +
      '</div>';
  }
  function previewHtml(d) {
    var rows = d.kind === 'family'
      ? d.kids.map(function (k) { return '<div><span class="emo" aria-hidden="true">' + esc(k.avatar) + '</span><span>' + esc(k.name) + '</span><b>' + k.total + '</b></div>'; }).join('')
      : d.top.map(function (x) { return '<div><span class="emo" aria-hidden="true">' + esc(x.emoji) + '</span><span>' + esc(x.name) + '</span><b>×' + x.n + '</b></div>'; }).join('');
    return '<section class="cardview" aria-label="Card preview"><div class="emo" style="font-size:2.6rem" aria-hidden="true">' + esc(d.avatar) + '</div>' +
      '<p class="small" style="margin:0;color:#ffe2c9;font-weight:800">' + esc(d.heading) + '</p>' +
      '<p class="t">' + esc(d.title) + '</p><p class="l">' + esc(d.line) + '</p>' +
      '<div class="n">' + d.total + '</div><p class="l" style="font-weight:800">pieces</p>' +
      '<div class="stats3"><div><b>' + d.full + '</b><span>full-size</span></div><div><b>' + d.kinds + '</b><span>kinds</span></div><div><b class="emo">' + esc(d.rarest ? d.rarest.emoji : '–') + '</b><span>' + esc(d.rarest ? 'rarest: ' + d.rarest.name : 'rarest find') + '</span></div></div>' +
      (rows ? '<div class="topl"><p class="small" style="margin:0;color:#ffe2c9;font-weight:800">' + (d.kind === 'family' ? 'Who brought what' : 'Top three') + '</p>' + rows + '</div>' : '') + '</section>';
  }
  function canShareFiles() {
    try { return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch (e) { return false; }
  }
  var STARS = [[80, 420, .5, 3], [210, 520, .8, 2], [990, 360, .6, 3], [880, 560, .9, 2], [520, 70, .7, 3], [400, 300, .5, 2], [1020, 900, .4, 2], [60, 980, .5, 2], [700, 40, .8, 2], [300, 40, .6, 3], [960, 1120, .5, 3], [40, 1200, .4, 2]];
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  /** The largest font size from `big` down to `small` that fits, then set. */
  function shrink(g, s, max, big, small, weight, fam0) {
    for (var px = big; px >= small; px -= 2) { g.font = weight + ' ' + px + 'px ' + fam0; if (g.measureText(String(s)).width <= max) return; }
  }
  /** Up to `lines` lines of words that fit `max`, the last cut with an ellipsis. */
  function wrap(g, s, max, lines) {
    var words = String(s).split(' '), out = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var next = cur ? cur + ' ' + words[i] : words[i];
      if (g.measureText(next).width <= max || !cur) { cur = next; continue; }
      out.push(cur); cur = words[i];
      if (out.length === lines - 1) { cur = words.slice(i).join(' '); break; }
    }
    if (cur) out.push(cur);
    return out.slice(0, lines).map(function (l) { return fit(g, l, max); });
  }
  function fit(g, s, max) { s = String(s); if (g.measureText(s).width <= max) return s; var cps = Array.from(s); while (cps.length > 1 && g.measureText(cps.join('') + '…').width > max) cps.pop(); return cps.join('') + '…'; }
  function drawPumpkin(g, cx, cy, s) {
    g.save(); g.translate(cx, cy); g.scale(s, s);
    g.strokeStyle = '#4d7c0f'; g.lineWidth = 12; g.lineCap = 'round';
    g.beginPath(); g.moveTo(4, -70); g.quadraticCurveTo(0, -100, 26, -110); g.stroke();
    [[-36, '#d9480f', 52, 70], [36, '#d9480f', 52, 70], [0, '#f97316', 56, 77]].forEach(function (e) { g.fillStyle = e[1]; g.beginPath(); g.ellipse(e[0], 0, e[2], e[3], 0, 0, Math.PI * 2); g.fill(); });
    g.fillStyle = '#ffd166';
    [[-24, -14], [24, -14]].forEach(function (p) { g.beginPath(); g.moveTo(p[0] - 12, p[1] + 10); g.lineTo(p[0] + 12, p[1] + 10); g.lineTo(p[0], p[1] - 12); g.closePath(); g.fill(); });
    g.beginPath(); g.moveTo(-46, 14); g.quadraticCurveTo(0, 62, 46, 14); g.lineTo(33, 19); g.lineTo(25, 32); g.lineTo(16, 20); g.lineTo(6, 33); g.lineTo(-4, 20); g.lineTo(-14, 33); g.lineTo(-23, 20); g.lineTo(-31, 32); g.lineTo(-38, 19); g.closePath(); g.fill();
    g.restore();
  }
  function drawBat(g, x, y, s) {
    g.save(); g.translate(x, y); g.scale(s, s); g.fillStyle = '#0b0314';
    g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(-14, -26, -44, -30, -70, -14); g.bezierCurveTo(-56, -10, -52, 0, -52, 10); g.bezierCurveTo(-42, 2, -32, 2, -26, 10); g.bezierCurveTo(-20, 2, -10, 2, 0, 10);
    g.bezierCurveTo(10, 2, 20, 2, 26, 10); g.bezierCurveTo(32, 2, 42, 2, 52, 10); g.bezierCurveTo(52, 0, 56, -10, 70, -14); g.bezierCurveTo(44, -30, 14, -26, 0, 0); g.fill();
    g.beginPath(); g.ellipse(0, 4, 10, 15, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  /** The haul card: 1080 x 1350, drawn here on a canvas. Never uploaded. */
  function drawCard() {
    var d = C.cardData(fam(), cardWho(), { names: state.card.names });
    if (!d) return Promise.reject(new Error('Pick who the card is for.'));
    var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350;
    var g = cv.getContext('2d');
    if (!g) return Promise.reject(new Error('This browser couldn’t draw the card.'));
    var F = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    var E = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    var sky = g.createLinearGradient(0, 0, 0, 1350); sky.addColorStop(0, '#3a0d63'); sky.addColorStop(0.55, '#1f0a3a'); sky.addColorStop(1, '#120524');
    g.fillStyle = sky; g.fillRect(0, 0, 1080, 1350);
    STARS.forEach(function (s) { g.globalAlpha = s[2]; g.fillStyle = '#fff3d6'; g.beginPath(); g.arc(s[0], s[1], s[3], 0, Math.PI * 2); g.fill(); });
    g.globalAlpha = 1;
    var glow = g.createRadialGradient(930, 150, 20, 930, 150, 170); glow.addColorStop(0, 'rgba(255,231,176,.55)'); glow.addColorStop(1, 'rgba(255,231,176,0)');
    g.fillStyle = glow; g.fillRect(740, 0, 340, 340);
    g.fillStyle = '#ffe7b0'; g.beginPath(); g.arc(930, 150, 64, 0, Math.PI * 2); g.fill();
    drawBat(g, 860, 292, 0.75); drawBat(g, 720, 64, 0.5);
    drawPumpkin(g, 170, 200, 1.25);
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffb35c'; g.font = '900 40px ' + F; g.fillText('HAUL', 300, 140);
    g.fillStyle = '#ffffff'; shrink(g, d.heading, 560, 58, 40, '900', F); g.fillText(fit(g, d.heading, 560), 300, 210);
    g.font = '64px ' + E; g.fillText(fit(g, d.avatar, 500), 300, 290);
    // the title
    g.fillStyle = 'rgba(255,154,61,.16)'; roundRect(g, 72, 340, 936, 150, 34); g.fill();
    g.strokeStyle = '#ff9a3d'; g.lineWidth = 4; roundRect(g, 72, 340, 936, 150, 34); g.stroke();
    g.fillStyle = '#ffb35c'; g.font = '900 66px ' + F; g.fillText(fit(g, d.title, 860), 110, 418);
    g.fillStyle = '#ffe2c9'; g.font = '700 32px ' + F; g.fillText(fit(g, d.line, 860), 110, 466);
    // the big number
    g.fillStyle = '#ffffff'; g.font = '900 250px ' + F;
    var num = fit(g, String(d.total), 640); g.fillText(num, 76, 740);
    var w = g.measureText(num).width;
    g.font = '800 64px ' + F; g.fillText('pieces', Math.min(76 + w + 26, 760), 730);
    // three stats
    var stats = [[String(d.full), 'full-size'], [String(d.kinds), 'kinds'], [d.rarest ? d.rarest.emoji : '–', d.rarest ? d.rarest.name : 'rarest find']];
    stats.forEach(function (s, i) {
      var x = 72 + i * 318;
      g.fillStyle = 'rgba(255,255,255,.1)'; roundRect(g, x, 790, 300, 170, 28); g.fill();
      g.fillStyle = '#ffffff'; g.font = (i === 2 ? '68px ' + E : '900 76px ' + F); g.fillText(fit(g, s[0], 260), x + 26, 878);
      if (i === 2 && d.rarest) { g.fillStyle = '#ffb35c'; g.font = '800 26px ' + F; g.fillText('RAREST FIND', x + 112, 850); }
      g.fillStyle = '#ffe2c9'; g.font = '700 30px ' + F; g.fillText(fit(g, s[1], 256), x + 26, 930);
    });
    // the list
    g.fillStyle = '#ffe2c9'; g.font = '800 32px ' + F;
    g.fillText(d.kind === 'family' ? 'Who brought what' : 'Top three', 76, 1030);
    var rows = d.kind === 'family' ? d.kids.map(function (k) { return [k.avatar, k.name, String(k.total)]; }) : d.top.map(function (x) { return [x.emoji, x.name, '×' + x.n]; });
    if (d.kind === 'family') {
      rows.slice(0, 6).forEach(function (r, i) {
        var x = 76 + (i % 2) * 468, y = 1090 + Math.floor(i / 2) * 62;
        g.fillStyle = '#ffffff'; g.font = '46px ' + E; g.fillText(r[0], x, y);
        g.font = '800 38px ' + F; g.fillText(fit(g, r[1], 260), x + 66, y - 4);
        g.fillStyle = '#ffb35c'; g.font = '900 40px ' + F; g.textAlign = 'right'; g.fillText(r[2], x + 420, y - 4); g.textAlign = 'left';
      });
      if (rows.length <= 4 && d.top.length) {
        var ty = rows.length <= 2 ? 1180 : 1240;
        g.fillStyle = '#ffe2c9'; g.font = '800 30px ' + F; g.fillText('Top three:', 76, ty);
        var tx = 250;
        d.top.forEach(function (x) {
          g.fillStyle = '#ffffff'; g.font = '44px ' + E; g.fillText(x.emoji, tx, ty + 4);
          g.font = '900 34px ' + F; g.fillText('×' + x.n, tx + 56, ty); tx += 56 + g.measureText('×' + x.n).width + 40;
        });
      }
    } else {
      rows.forEach(function (r, i) {
        var x = 76 + i * 318;
        g.fillStyle = '#ffffff'; g.font = '72px ' + E; g.fillText(r[0], x, 1120);
        g.font = '800 30px ' + F;
        var ln = wrap(g, r[1], 290, 2);
        ln.forEach(function (l, j) { g.fillText(l, x, 1166 + j * 34); });
        g.fillStyle = '#ffb35c'; g.font = '900 38px ' + F; g.fillText(r[2], x, 1166 + ln.length * 34 + 8);
      });
    }
    g.fillStyle = '#ffe2c9'; g.font = '700 28px ' + F;
    g.fillText(fit(g, 'Counted with Haul · ' + location.host + BASE.replace(/\/$/, ''), 930), 76, 1300);
    return new Promise(function (resolve) { cv.toBlob(function (b) { resolve(b); }, 'image/png'); }).then(function (blob) {
      if (!blob) throw new Error('This browser couldn’t draw the card.');
      if (state.card.url) URL.revokeObjectURL(state.card.url);
      state.card.blob = blob; state.card.url = URL.createObjectURL(blob);
      draw();
      celebrate(true);
      toast(canShareFiles() ? 'Drawn - tap Share it.' : 'Drawn - tap Download it.');
    });
  }
  function resetCard() { if (state.card.url) URL.revokeObjectURL(state.card.url); state.card.blob = null; state.card.url = null; }
  function shareCard() {
    if (!state.card.blob) return;
    var file = new File([state.card.blob], 'haul-card.png', { type: 'image/png' });
    if (canShareFiles()) {
      navigator.share({ files: [file], title: 'Our Halloween haul' }).catch(function (e) { if (!e || e.name !== 'AbortError') download('haul-card.png', 'image/png', state.card.blob); });
    } else download('haul-card.png', 'image/png', state.card.blob);
  }

  /* ---------------- grown-ups ---------------- */

  function viewSettings() {
    var f = fam();
    return '<div class="stack" style="max-width:760px;margin:0 auto">' + trialRibbon() + '<h1>Grown-ups</h1>' +
      '<section class="card"><h2>Trade points</h2><p class="small muted">How much each kind is worth in a trade. Change them to suit your house - a full-size bar might be worth more on your street.</p><div class="vals">' +
      C.CATS.map(function (c) { return '<div class="vrow"><b><i class="sw-' + c.id + '" style="width:12px;height:12px;border-radius:4px;display:inline-block" aria-hidden="true"></i>' + esc(c.label) + '</b><span class="stepper"><button type="button" data-act="val" data-id="' + c.id + '" data-v="-0.5" aria-label="' + esc('Less for ' + c.label) + '">−</button><output>' + f.values[c.id] + '</output><button type="button" data-act="val" data-id="' + c.id + '" data-v="0.5" aria-label="' + esc('More for ' + c.label) + '">+</button></span></div>'; }).join('') +
      '</div><button class="btn small ghost" type="button" data-act="valreset" style="margin-top:10px">Back to the usual points</button></section>' +
      '<section class="card"><h2>Trick-or-treaters</h2>' + (kids().length ? '<div class="kid-list">' + kids().map(function (k) { return '<div class="kid-row"><span class="av emo" aria-hidden="true">' + esc(k.avatar) + '</span><b>' + esc(nameOf(k)) + '</b><button class="btn small ghost" type="button" data-act="editkid" data-id="' + esc(k.id) + '">Edit</button></div>'; }).join('') + '</div>' : '') +
      (kids().length < C.LIMITS.kids ? '<button class="btn ghost" type="button" data-act="go" data-v="kids" style="margin-top:10px">＋ Add a trick-or-treater</button>' : '') + '</section>' +
      '<section class="card"><h2>What Haul keeps</h2><p class="small">Everything - names, counts, trades, plans and set-aside choices - stays in this browser on this device. Nothing is uploaded. The only thing that ever leaves is one photo, when you choose “Count it from a photo” (it needs a free account), and it isn’t kept.</p>' +
      (state.trial ? '<p class="small muted">You’re trying the made-up haul - nothing here is saved.</p>' : '<button class="btn ghost" type="button" data-act="clearall">Clear everything on this device</button>') + '</section></div>';
  }

  /* ---------------- "Count it from a photo" (metered) ---------------- */

  function redraw(img, max, q) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, s = Math.min(1, max / Math.max(w, h));
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
    var g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', q);
  }
  /** The photo, redrawn through a canvas at 1200 px - which drops its EXIF,
   *  location included - and made smaller still if it is over the limit. */
  function prepPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('That isn’t a photo.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.addEventListener('load', function () {
        try {
          var full = redraw(img, 1200, 0.82);
          if ((full.length - 23) * 0.75 > C.LIMITS.aiImageBytes - 4096) full = redraw(img, 1000, 0.7);
          if ((full.length - 23) * 0.75 > C.LIMITS.aiImageBytes - 4096) full = redraw(img, 800, 0.6);
          URL.revokeObjectURL(url);
          resolve({ data: full.replace(/^data:image\/jpeg;base64,/, ''), preview: redraw(img, 240, 0.7) });
        } catch (e) { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); }
      });
      img.addEventListener('error', function () { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); });
      img.src = url;
    });
  }
  function openPhoto() {
    var k = activeKid();
    if (!k) { go('kids'); return; }
    state.photo = null; state.prop = null;
    sheet('<div class="body"></div>', function (root) { drawPhoto(root); });
  }
  function drawPhoto(root) {
    var b = $('.body', root), k = activeKid(), nm = nameOf(k);
    var sent = '<div class="sent">' + (state.photo ? '<img alt="" src="' + esc(state.photo.preview) + '">' : '') + '<b>What is sent:</b> this one photo, shrunk on this phone and with its location removed. Nothing else - not ' + esc(C.possessive(nm)) + ' name, not the counts. The photo isn’t kept.<span style="display:block;clear:both"></span></div>';
    var intro = '<h2>Count it from a photo</h2><p>Spread the candy out so pieces don’t overlap, take one photo from above, and an AI counts it onto ' + esc(C.possessive(nm)) + ' list. You check every number before anything changes.</p>';
    if (!signedIn()) {
      b.innerHTML = intro + sent + '<p class="note" style="margin-top:12px">Counting from a photo needs a free account - it comes with $2 of AI credit, and one photo costs about a cent or two. Counting by tapping, trading, the plan and the card stay free with no account.</p>' +
        '<div class="row" style="margin-top:12px"><button class="btn" type="button" id="pJoin">Create a free account</button><button class="btn ghost" type="button" id="pIn">Sign in</button></div>';
      $('#pJoin', root).addEventListener('click', function () { openAccount('Create a free account to count from a photo.', openPhoto); });
      $('#pIn', root).addEventListener('click', function () { openAccount('Sign in to count from a photo.', openPhoto, 'login'); });
      return;
    }
    b.innerHTML = intro + sent +
      '<label class="btn ghost block" style="margin-top:12px"><input type="file" accept="image/*" id="photoIn" class="vh">' + (state.photo ? 'Choose a different photo' : '📷 Take or choose a photo') + '</label>' +
      '<div id="pOut" style="margin-top:12px"></div>' +
      (state.photo ? '<div class="row" style="margin-top:12px"><button class="btn big ai" type="button" id="pGo"> Count it</button><span class="tiny muted">About a cent or two of AI credit.</span></div>' : '');
    $('#photoIn', root).addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      prepPhoto(file).then(function (p) { state.photo = p; drawPhoto(root); }).catch(function (err) { showError(err, $('#pOut', root)); });
    });
    var go2 = $('#pGo', root);
    if (go2) go2.addEventListener('click', function () {
      go2.disabled = true; go2.textContent = 'Counting…';
      $('#pOut', root).innerHTML = '<p class="muted" role="status">Counting the pieces…</p>';
      api('POST', 'api/ai/count', { image: { type: 'image/jpeg', data: state.photo.data } }).then(function (r) {
        state.prop = { kid: k.id, confidence: r.proposal.confidence, note: r.proposal.note, rows: r.proposal.counts.map(function (x) { return { id: x.id, n: x.n, on: true }; }).concat(r.proposal.others.map(function (x) { return { other: true, name: x.name, cat: x.cat, n: x.n, on: true }; })) };
        drawProposal(root);
        loadMe();
      }).catch(function (err) {
        go2.disabled = false; go2.textContent = ' Count it';
        meteredError(err, $('#pOut', root), openPhoto, 'Sign in to count from a photo.');
      });
    });
  }
  function drawProposal(root) {
    var b = $('.body', root), pr = state.prop, k = kidOf(pr.kid), f = fam();
    if (!k) { closeSheet(); return; }
    var sum = pr.rows.reduce(function (s, r) { return s + (r.on ? r.n : 0); }, 0);
    b.innerHTML = '<h2>Check the count</h2>' +
      '<p><span class="pill ' + (pr.confidence === 'high' ? 'ok' : pr.confidence === 'medium' ? 'warn' : 'bad') + '">' + esc(pr.confidence) + ' confidence</span></p>' +
      (pr.note ? '<p class="small">' + esc(pr.note) + '</p>' : '') +
      '<p class="small muted">Fix any number, untick anything that’s wrong, then add it. Nothing changes until you tap Add.</p>' +
      '<div class="prop">' + pr.rows.map(function (r, i) {
        var cd = r.other ? null : C.candyOf(r.id, f.custom);
        var label = r.other ? 'Other: ' + r.name : cd.name, emo = r.other ? C.catOf(r.cat).emoji : cd.emoji;
        return '<div class="prow"><input type="checkbox" data-pon="' + i + '"' + (r.on ? ' checked' : '') + ' aria-label="' + esc('Include ' + label) + '"><span class="emo" aria-hidden="true">' + esc(emo) + '</span><b>' + esc(label) + '</b>' +
          '<span class="stepper"><button type="button" data-pstep="' + i + '" data-v="-1" aria-label="' + esc('One less ' + label) + '">−</button><output>' + r.n + '</output><button type="button" data-pstep="' + i + '" data-v="1" aria-label="' + esc('One more ' + label) + '">+</button></span></div>';
      }).join('') + '</div>' +
      '<div class="row" style="margin-top:14px"><button class="btn big" type="button" id="pAdd"' + (sum ? '' : ' disabled') + '>Add ' + plural(sum, 'piece') + ' to ' + esc(C.possessive(nameOf(k))) + ' haul</button><button class="btn ghost" type="button" id="pNo">Discard</button></div>' +
      '<p class="tiny muted">An AI count - it can miss pieces under others. Tap tiles afterwards to fix anything.</p>';
    $$('[data-pon]', b).forEach(function (x) { x.addEventListener('change', function () { pr.rows[Number(x.getAttribute('data-pon'))].on = x.checked; drawProposal(root); }); });
    $$('[data-pstep]', b).forEach(function (x) {
      x.addEventListener('click', function () {
        var r = pr.rows[Number(x.getAttribute('data-pstep'))];
        r.n = Math.max(0, Math.min(C.LIMITS.aiPerCandy, r.n + Number(x.getAttribute('data-v'))));
        if (!r.n) r.on = false; else r.on = true;
        drawProposal(root);
      });
    });
    $('#pNo', b).addEventListener('click', function () { state.prop = null; closeSheet(); toast('Discarded - nothing changed.'); });
    $('#pAdd', b).addEventListener('click', function () {
      var res = C.applyProposal(fam(), k.id, pr.rows.filter(function (r) { return r.on && r.n > 0; }), function () { return 'x' + uid(8); });
      setFam(res.fam);
      state.undo = C.pushUndo(state.undo, { kid: k.id, applied: res.applied });
      var n = Object.keys(res.applied).reduce(function (s, id) { return s + res.applied[id]; }, 0);
      state.prop = null; state.photo = null;
      setKid(k.id);
      closeSheet(); draw(); celebrate(false);
      toast('Added ' + plural(n, 'piece') + ' from the photo.' + (res.skipped ? ' ' + res.skipped + ' didn’t fit as new kinds.' : ''), 4200, { label: 'Undo', fn: undoLast });
    });
  }

  /* ---------------- routing ---------------- */

  var VIEWS = ['home', 'kids', 'count', 'trade', 'plan', 'card', 'aside', 'settings'];
  function route() {
    var h = (location.hash || '').replace(/^#/, '').split('/');
    state.view = VIEWS.indexOf(h[0]) >= 0 ? h[0] : 'home';
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
    var has = kids().length > 0;
    var view = state.view;
    if (!has && view !== 'kids') view = 'first';
    var tabs = $('#tabbar');
    tabs.hidden = !has;
    var tabView = ({ aside: 'count', kids: 'home', settings: 'home' })[view] || view;
    $$('[data-act="tab"]', tabs).forEach(function (b) { if (b.getAttribute('data-tab') === tabView) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var focus = document.activeElement && document.activeElement.closest ? document.activeElement.closest('[data-act]') : null;
    var key = focus && $('#main').contains(focus) ? [focus.getAttribute('data-act'), focus.getAttribute('data-id'), focus.getAttribute('data-side'), focus.getAttribute('data-v')] : null;
    $('#main').innerHTML = ({ first: viewFirst, home: viewHome, kids: viewKids, count: viewCount, trade: viewTrade, plan: viewPlan, card: viewCard, aside: viewAside, settings: viewSettings })[view]();
    after(view);
    if (key) {
      var sel = '[data-act="' + key[0] + '"]' + (key[1] ? '[data-id="' + cssq(key[1]) + '"]' : '') + (key[2] ? '[data-side="' + cssq(key[2]) + '"]' : '') + (key[3] ? '[data-v="' + cssq(key[3]) + '"]' : '');
      var again = $('#main ' + sel);
      if (again && !again.disabled) try { again.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }
  function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function after(view) {
    if (view === 'count') {
      applyFilter();
      var q = $('#q');
      q.addEventListener('input', function () { state.q = q.value; applyFilter(); });
    }
    if (view === 'kids') {
      var kn = $('#kidName');
      if (kn) kn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addKid(); } });
    }
    if (view === 'plan') {
      var pd = $('#perDay');
      pd.addEventListener('input', function () { patchPlanPreview(Number(pd.value)); });
      pd.addEventListener('change', function () { setFam(C.setPlan(fam(), activeKid().id, { perDay: Number(pd.value) })); draw(); });
      var bn = $('#bbN');
      if (bn) bn.addEventListener('input', function () { state.buyN = Number(bn.value); patchBuyback(); });
      var bc = $('#bbCents');
      if (bc) bc.addEventListener('change', function () { setFam(C.setBuyback(fam(), { cents: Math.round(Number(bc.value)) })); draw(); });
      var bp = $('#bbPrize');
      if (bp) bp.addEventListener('change', function () { setFam(C.setBuyback(fam(), { prize: bp.value })); draw(); });
      var bq = $('#bbPieces');
      if (bq) bq.addEventListener('change', function () { setFam(C.setBuyback(fam(), { pieces: Math.round(Number(bq.value)) })); draw(); });
    }
    if (view === 'card') {
      var cn = $('#cardNames');
      if (cn) cn.addEventListener('change', function () { state.card.names = cn.checked; resetCard(); draw(); });
    }
    if (view === 'aside') {
      var aa = $('#asideAll');
      aa.addEventListener('change', function () { state.showAllAside = aa.checked; draw(); });
    }
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

  var FREE_LINE = 'Counting, trading, the plan, set-aside and the haul card are free with no account, and stay on this device. A free account adds “Count it from a photo” - it comes with $2 of AI credit, and one account works across every app on this site.';
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
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div><p class="small muted" style="margin:6px 0 0">Counting from a photo costs about a cent or two. Everything else is free and stays on this device.</p><div id="billing"></div></div>' +
      '<p class="small muted" style="margin-top:12px">Your haul is not in your account - it stays on this device.</p>' +
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((d && d.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Counting by tapping and everything else keep working, free.</p><div id="billing"></div>' +
      (d && d.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(d.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- long-press to take one back ---------------- */

  var lp = { t: null, fired: false, x: 0, y: 0 };
  document.addEventListener('pointerdown', function (e) {
    var b = e.target.closest && e.target.closest('.tile-main[data-act="plus"]');
    if (!b) return;
    lp.fired = false; lp.x = e.clientX; lp.y = e.clientY;
    clearTimeout(lp.t);
    var id = b.getAttribute('data-id');
    lp.t = setTimeout(function () { lp.fired = true; countTap(id, -1); }, 520);
  });
  function lpCancel() { clearTimeout(lp.t); }
  document.addEventListener('pointerup', lpCancel);
  document.addEventListener('pointercancel', lpCancel);
  document.addEventListener('pointermove', function (e) { if (Math.abs(e.clientX - lp.x) + Math.abs(e.clientY - lp.y) > 12) lpCancel(); });
  document.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('.tile-main')) e.preventDefault(); });

  /* ---------------- clicks ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act'), id = t.getAttribute('data-id');
    switch (act) {
      case 'closesheet': closeSheet(); break;
      case 'home': e.preventDefault(); closeSheet(true); go(''); break;
      case 'tab': closeSheet(true); go(t.getAttribute('data-tab') === 'home' ? '' : t.getAttribute('data-tab')); break;
      case 'go': closeSheet(true); go(t.getAttribute('data-v')); break;
      case 'start': state.trial = null; go('kids'); break;
      case 'try': state.trial = C.sample(); state.kid = 'sampleleo'; state.undo = []; state.oa = {}; state.ob = {}; state.ta = null; state.tb = null; resetCard(); state.card.who = null; state.card.names = null; go(''); break;
      case 'own': state.trial = null; state.kid = prefs.kid || null; state.undo = []; state.oa = {}; state.ob = {}; state.ta = null; state.tb = null; resetCard(); state.card.who = null; state.card.names = null; go(kids().length ? '' : 'kids'); break;
      case 'setav': state.setup.avatar = t.getAttribute('data-a'); { var keepName = ($('#kidName') || {}).value || ''; draw(); var kn = $('#kidName'); if (kn) kn.value = keepName; } break;
      case 'addkid': addKid(); break;
      case 'editkid': openEditKid(id); break;
      case 'pickkid': setKid(id); state.lastEat = state.lastEat && state.lastEat.kid === id ? state.lastEat : null; state.buyN = null; draw(); break;
      case 'countkid': setKid(id); go('count'); break;
      case 'cardkid': setKid(id); state.card.who = id; state.card.names = null; resetCard(); go('card'); break;
      case 'plankid': setKid(id); state.buyN = null; go('plan'); break;
      case 'plus': if (lp.fired) { lp.fired = false; break; } countTap(id, 1); break;
      case 'minus': countTap(id, -1); break;
      case 'undo': undoLast(); break;
      case 'cat': state.cat = t.getAttribute('data-v'); $$('[data-act="cat"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); }); applyFilter(); break;
      case 'other': openOther(); break;
      case 'photo': closeSheet(true); openPhoto(); break;
      case 'ta': state.ta = id; if (state.tb === id) state.tb = null; state.oa = {}; state.ob = {}; draw(); break;
      case 'tb': state.tb = id; state.ob = {}; state.oa = {}; draw(); break;
      case 'offer': offerTap(t.getAttribute('data-side'), id, 1); break;
      case 'unoffer': offerTap(t.getAttribute('data-side'), id, -1); break;
      case 'clearoffer': state.oa = {}; state.ob = {}; draw(); break;
      case 'swap': doSwap(); break;
      case 'untrade': undoTrade(id); break;
      case 'eat': openEat(); break;
      case 'uneat': uneatLast(); break;
      case 'day': {
        var k = activeKid(), days = k.plan.days.slice(), i = Number(t.getAttribute('data-v'));
        days[i] = !days[i];
        setFam(C.setPlan(fam(), k.id, { days: days })); draw(); break;
      }
      case 'days': {
        var preset = ({ all: [1, 1, 1, 1, 1, 1, 1], school: [1, 1, 1, 1, 1, 0, 0], weekend: [1, 0, 0, 0, 0, 0, 1] })[t.getAttribute('data-v')];
        setFam(C.setPlan(fam(), activeKid().id, { days: preset.map(Boolean) })); draw(); break;
      }
      case 'bbmode': setFam(C.setBuyback(fam(), { mode: t.getAttribute('data-v') })); state.buyN = null; draw(); break;
      case 'tradein': {
        var kk = activeKid(), n = state.buyN || 0, b0 = fam().buyback;
        if (!n || !confirm('Trade in ' + n + ' pieces? ' + C.buybackWords(b0, n))) break;
        var r = C.tradeIn(fam(), kk.id, n);
        if (!r) break;
        setFam(r.fam); state.lastRemoved = { kid: kk.id, removed: r.removed, field: 'tradedIn' }; state.buyN = null; draw();
        toast('Traded in ' + plural(r.n, 'piece') + '.', 4200, { label: 'Undo', fn: giveBackLast });
        break;
      }
      case 'aside': setFam(C.toggleAside(fam(), activeKid().id, id)); draw(); break;
      case 'asideall': if (confirm('Use ' + nameOf(activeKid()) + '’s set-aside choices for everyone?')) { setFam(C.asideForAll(fam(), activeKid().id)); draw(); toast('Same set-aside choices for everyone.'); } break;
      case 'handover': {
        var kh = activeKid(), h = C.handOver(fam(), kh.id);
        if (!h) break;
        setFam(h.fam); state.lastRemoved = { kid: kh.id, removed: h.removed, field: 'handed' }; draw();
        toast('Handed over: ' + plural(h.n, 'piece') + '.', 4200, { label: 'Undo', fn: giveBackLast });
        break;
      }
      case 'cardwho': state.card.who = id; state.card.names = null; resetCard(); if (id !== 'family') setKid(id); draw(); break;
      case 'drawcard': t.disabled = true; drawCard().catch(function (err) { t.disabled = false; showError(err); }); break;
      case 'sharecard': shareCard(); break;
      case 'val': {
        var f0 = fam(), patch = {};
        patch[id] = Math.max(0, Math.min(C.LIMITS.valueMax, f0.values[id] + Number(t.getAttribute('data-v'))));
        setFam(C.setValues(f0, patch)); draw(); break;
      }
      case 'valreset': setFam(C.setValues(fam(), C.DEFAULT_VALUES)); draw(); toast('Back to the usual points.'); break;
      case 'clearall':
        if (!confirm('Clear everything Haul keeps on this device - every trick-or-treater, count, trade and plan? This can’t be undone.')) break;
        real = C.emptyFamily(); save(); state.undo = []; state.oa = {}; state.ob = {}; resetCard(); prefs = {}; savePrefs(); state.kid = null;
        go(''); toast('Cleared.');
        break;
      default: break;
    }
  });
  function giveBackLast() {
    var r = state.lastRemoved; if (!r) return;
    setFam(C.giveBack(fam(), r.kid, r.removed, r.field)); state.lastRemoved = null; draw(); toast('Put back.');
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && $('#sheet').hidden && state.view === 'count' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) { e.preventDefault(); undoLast(); }
  });

  /* ---------------- start ---------------- */

  function markOffline() { var pill = $('#offlinePill'); if (pill) pill.hidden = false; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function () { return navigator.serviceWorker.ready; }).then(markOffline).catch(function () { /* still works online */ });
  }
  $('#acct').addEventListener('click', function () { if (signedIn()) openAccountSheet(); else openAccount(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && (state.view === 'home' || state.view === 'plan')) draw(); });
  drawTop();
  route();
  loadMe().then(function () {
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openAccountSheet();
  });
}());
