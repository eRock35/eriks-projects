/* Duo Hunt - the page. Everything drawn from an upstream answer goes in
 * through textContent (el() below); nothing is ever parsed as markup that
 * came from Apple, Best Buy, storage or the URL. Links are only set from
 * DuoCore.safeUrl with a host allow-list.
 *
 * What lives on this device: the pick and ZIP (localStorage), the carrier
 * "I looked" notes (localStorage), the watch switch and this tab's last 20
 * checks (sessionStorage). Every storage access is wrapped: a private window
 * or blocked storage just means nothing is remembered.
 *
 * Apple blocks server checks, so its card links Apple's page for the exact
 * part number and opens the "Check from my iPhone" sheet: a Shortcut recipe
 * filled in with the part and the ZIP box's ZIP. Filling it sends nothing
 * anywhere; the ZIP only reaches Apple, from the phone, when the Shortcut runs.
 */
(function () {
  'use strict';
  var C = window.DuoCore;
  var BASE = location.pathname.replace(/[^/]*$/, '');

  /* ---------------- storage, wrapped ---------------- */
  function load(store, key, fallback) {
    try { var v = window[store].getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(store, key, value) {
    try { window[store].setItem(key, JSON.stringify(value)); } catch (e) { /* nothing remembered */ }
  }

  /* ---------------- state ---------------- */
  var saved = load('localStorage', 'duohunt-pick', null) || {};
  var state = {
    pick: C.cleanPick(saved) || { storage: C.DEFAULT_PICK.storage, colour: C.DEFAULT_PICK.colour, carrier: C.DEFAULT_PICK.carrier },
    zip: C.cleanZip(saved.zip) || '',
    result: null,
    checking: false,
    error: '',
    notes: C.cleanNotes(load('localStorage', 'duohunt-carriers', {})),
    history: (load('sessionStorage', 'duohunt-history', []) || []).filter(function (h) { return h && typeof h.at === 'number' && typeof h.summary === 'string'; }).slice(0, C.HISTORY_MAX),
    watching: false,
    nextAt: 0,
    meta: null,
  };

  /* ---------------- DOM helpers ---------------- */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') n.textContent = String(v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function link(href, label, cls, hosts) {
    var safe = C.safeUrl(href, hosts);
    if (!safe) return null;
    return el('a', { class: 'btn ' + (cls || ''), href: safe, target: '_blank', rel: 'noopener noreferrer' }, [label]);
  }
  var $ = function (id) { return document.getElementById(id); };
  function say(msg) { var l = $('live'); l.textContent = ''; setTimeout(function () { l.textContent = msg; }, 30); }

  /* ---------------- the picker ---------------- */
  function chips(holder, name, list, current, swatch) {
    holder.textContent = '';
    list.forEach(function (o) {
      var input = el('input', { type: 'radio', name: name, value: o.id, id: name + '-' + o.id });
      input.checked = o.id === current;
      var kids = [];
      if (swatch) kids.push(el('span', { class: 'swatch', 'aria-hidden': 'true', style: 'background:' + o.swatch }));
      kids.push(o.label);
      holder.appendChild(el('label', { class: 'chip', for: name + '-' + o.id }, [input, el('span', null, kids)]));
    });
  }
  function drawPicker() {
    chips($('storage'), 'storage', C.STORAGES, state.pick.storage);
    chips($('colour'), 'colour', C.COLOURS, state.pick.colour, true);
    chips($('carrier'), 'carrier', C.CARRIERS, state.pick.carrier);
    $('zip').value = state.zip;
    drawPickerText();
  }
  function drawPickerText() {
    var p = C.priceOf(state.pick);
    var price = $('price');
    price.textContent = '';
    price.appendChild(document.createTextNode('From $' + p.toLocaleString('en-US') + ' '));
    price.appendChild(el('small', { text: 'at Apple, before carrier deals' }));
    $('carrierHint').textContent = state.pick.carrier === 'unlocked'
      ? 'Unlocked works with any carrier. Best Buy mostly sells carrier models.'
      : C.find(C.CARRIERS, state.pick.carrier).label + ' model: Apple and Best Buy are checked for that version.';
  }
  function persist() {
    save('localStorage', 'duohunt-pick', { storage: state.pick.storage, colour: state.pick.colour, carrier: state.pick.carrier, zip: state.zip });
  }

  $('picker').addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.type === 'radio' && (t.name === 'storage' || t.name === 'colour' || t.name === 'carrier')) {
      state.pick[t.name] = t.value;
      persist();
      drawPickerText();
      // A result is about one model: a new pick needs a new check.
      if (state.result && state.result.pickKey !== pickKey()) { state.result = null; }
      drawCards();
    }
  });
  $('zip').addEventListener('input', function () {
    var z = C.cleanZip($('zip').value);
    $('zip').removeAttribute('aria-invalid');
    if (z) { state.zip = z; persist(); }
  });
  $('picker').addEventListener('submit', function (e) {
    e.preventDefault();
    check('tap');
  });
  function pickKey() { return state.pick.storage + ':' + state.pick.colour + ':' + state.pick.carrier; }

  /* ---------------- the check ---------------- */
  function check(why) {
    if (state.checking) return Promise.resolve();
    var zip = C.cleanZip($('zip').value);
    var err = $('formErr');
    if (!zip) {
      err.textContent = 'Enter a 5-digit US ZIP code.';
      err.hidden = false;
      $('zip').setAttribute('aria-invalid', 'true');
      if (why === 'tap') $('zip').focus();
      return Promise.resolve();
    }
    err.hidden = true;
    state.zip = zip; persist();
    state.checking = true;
    var btn = $('checkBtn');
    var live = C.watchPlan(state.meta).live;
    btn.disabled = true; btn.textContent = live.length ? 'Checking ' + live.join(' and ') + '…' : 'Checking…';
    drawCards();
    var prev = state.result;
    return fetch(BASE + 'api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storage: state.pick.storage, colour: state.pick.colour, carrier: state.pick.carrier, zip: zip }),
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.error) throw new Error(data.error || 'Couldn’t check right now. The store links still work.');
        return data;
      });
    }).then(function (data) {
      data.pickKey = pickKey();
      data.at = Date.now();
      var fresh = prev && prev.pickKey === data.pickKey ? C.newlyAvailable(prev, data) : [];
      state.result = data;
      state.error = '';
      state.history = C.pushHistory(state.history, { at: data.at, label: C.pickLabel(state.pick), summary: C.summary(data), hit: C.availableIn(data).length > 0 });
      save('sessionStorage', 'duohunt-history', state.history);
      var n = C.availableIn(data).length;
      say(n ? 'Found one: ' + C.summary(data) : 'Checked. ' + C.summary(data));
      if (why === 'watch' && fresh.length) alertFound(data);
      // On a phone the results are below the picker: bring them up after a tap.
      if (why === 'tap' && window.innerWidth < 1000) {
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        setTimeout(function () { $('resultsTitle').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); }, 50);
      }
    }).catch(function (e) {
      state.error = e && e.message ? e.message : 'Couldn’t check right now.';
      say(state.error);
    }).then(function () {
      state.checking = false;
      btn.disabled = false; btn.textContent = 'Check everything';
      drawCards(); drawHistory();
      if (state.watching) schedule();
    });
  }

  /* ---------------- the cards ---------------- */
  function when(at) { return el('span', { class: 'when', 'data-at': String(at), text: 'Checked ' + C.ago(at, Date.now()) }); }
  function card(opts, kids) {
    return el('article', { class: 'card src' + (opts.wide ? ' wide' : '') + (opts.carrier ? ' carrier' : '') + (opts.chosen ? ' chosen' : ''), 'aria-label': opts.name }, [
      el('div', { class: 'src-head' }, [
        el('h3', { class: 'src-name', text: opts.name }),
        el('span', { class: 'kind' + (opts.live ? ' live' : ''), text: opts.kind || (opts.live ? 'Live check' : 'Link - you check') }),
      ]),
    ].concat(kids));
  }
  function pill(kind, text) { return el('span', { class: 'pill ' + kind, text: text }); }
  function msg(text) { return text ? el('p', { class: 'src-msg', text: text }) : null; }
  function storeList(rows, kindOf) {
    return el('ul', { class: 'stores' }, rows.map(function (s) {
      var k = kindOf(s);
      return el('li', null, [
        el('span', { class: 's-name' }, [s.name, s.distance ? el('span', { class: 's-dist', text: s.distance }) : null]),
        el('span', { class: 's-stat ' + k.cls, text: k.text }),
      ]);
    }));
  }
  var APPLE_HOSTS = ['apple.com'];
  var BB_HOSTS = ['bestbuy.com'];

  /** This pick's Apple part number: from the last check of this pick, else
   *  from /api/meta. Only an Apple-shaped part is ever used. */
  function currentPart() {
    var r = state.result && state.result.pickKey === pickKey() && state.result.apple;
    var p = (r && r.part) || (state.meta && state.meta.parts ? state.meta.parts[pickKey()] : null);
    return C.validPart(p) ? p : null;
  }

  function appleCard() {
    var r = state.result && state.result.apple;
    var serverCheck = !!(state.meta && state.meta.appleServerCheck);
    var part = currentPart();
    var kids = [];
    var live = false;
    if (serverCheck && state.checking) {
      live = true;
      kids.push(pill('idle', 'Checking…'), el('div', { class: 'skeleton' }));
    } else if (r && r.state === 'ok') {
      live = true;
      var n = r.available;
      var later = r.stores.filter(function (s) { return s.status === 'quote'; }).length;
      kids.push(n ? pill('good', n + (n === 1 ? ' store has it today' : ' stores have it today'))
        : later ? pill('warn', 'Not today - later pickup dates') : pill('bad', 'None nearby today'));
      kids.push(when(r.checkedAt || state.result.at));
      if (r.stores.length) {
        kids.push(storeList(r.stores, function (s) {
          return s.status === 'available' ? { cls: 'good', text: 'Available today' } : s.status === 'quote' ? { cls: 'warn', text: s.label } : { cls: 'idle', text: 'Unavailable' };
        }));
      } else kids.push(msg('Apple listed no stores near that ZIP.'));
    } else if (r && (r.state === 'error' || r.state === 'busy')) {
      live = true;
      kids.push(pill('bad', 'Couldn’t check'));
      kids.push(msg(r.message));
    } else if (r && r.state === 'not-configured') {
      kids.push(pill('idle', 'Not set up for this model'));
      kids.push(msg(r.message));
    } else if (serverCheck && !r) {
      live = true;
      kids.push(pill('idle', 'Not checked yet'));
      kids.push(msg('Tap Check everything to see pickup at Apple Stores near your ZIP.'));
    } else {
      // The usual case: Apple blocks server checks, so nothing was asked.
      kids.push(pill('info', 'Apple blocks server checks'));
      kids.push(msg(C.APPLE_BLOCKED));
    }
    kids.push(el('div', { class: 'actions' }, [
      link(C.appleProductUrl(part), r && r.state === 'ok' && r.available ? 'Reserve on apple.com' : part ? 'See this model on Apple' : 'Open Apple’s page', 'primary', APPLE_HOSTS),
      part ? el('button', { class: 'btn', type: 'button', id: 'shortcutBtn', 'aria-haspopup': 'dialog', text: 'Check from my iPhone' }) : null,
    ]));
    return card({ name: 'Apple Store', live: live, kind: live ? null : 'Link + Shortcut', wide: true }, kids);
  }

  function bestbuyCard() {
    var r = state.result && state.result.bestbuy;
    var connected = state.meta ? state.meta.bestbuy : null;
    var kids = [];
    var live = connected !== false && !(r && r.state === 'not-connected');
    if (state.checking && live) kids.push(pill('idle', 'Checking…'), el('div', { class: 'skeleton' }));
    else if (!live) {
      kids.push(pill('info', 'Not connected yet'));
      kids.push(msg('Best Buy’s live check isn’t switched on here yet. Their site shows online and store stock for every carrier version.'));
    } else if (!r) {
      kids.push(pill('idle', 'Not checked yet'));
      kids.push(msg('Tap Check everything to see Best Buy online and at stores near your ZIP.'));
    } else if (r.state === 'ok') {
      var p = r.product;
      var st = r.stores || [];
      if (p.online || st.length) kids.push(pill('good', (p.online ? 'Online' : '') + (p.online && st.length ? ' + ' : '') + (st.length ? st.length + (st.length === 1 ? ' store' : ' stores') + ' for pickup' : '')));
      else kids.push(pill('bad', 'Sold out online and nearby'));
      kids.push(when(r.checkedAt || state.result.at));
      kids.push(el('p', { class: 'src-msg' }, [el('strong', { text: p.name }), p.price ? ' · $' + p.price.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '', p.onlineText ? ' · ' + p.onlineText : '']));
      if (st.length) kids.push(storeList(st, function (s) { return s.lowStock ? { cls: 'warn', text: 'Low stock' } : { cls: 'good', text: 'Pickup' }; }));
      else if (r.stores === null) kids.push(msg(r.storesNote));
    } else {
      kids.push(pill(r.state === 'not-listed' ? 'warn' : 'bad', r.state === 'not-listed' ? 'Not this version' : 'Couldn’t check'));
      kids.push(msg(r.message));
      if (r.checkedAt) kids.push(when(r.checkedAt));
    }
    var href = r && r.state === 'ok' ? r.link : C.BESTBUY_SEARCH;
    kids.push(el('div', { class: 'actions' }, [
      link(href, r && r.state === 'ok' ? 'Open on bestbuy.com' : 'Search Best Buy', 'primary', BB_HOSTS),
      link(C.BESTBUY_STORES, 'Best Buy stores', '', BB_HOSTS),
    ]));
    return card({ name: 'Best Buy', live: live, wide: true }, kids);
  }

  function carrierCard(id) {
    var c = C.CARRIER_LINKS[id];
    var note = state.notes[id];
    var hosts = [id === 'att' ? 'att.com' : id === 'verizon' ? 'verizon.com' : 't-mobile.com'];
    var info = [];
    var kids = info;
    if (note) {
      kids.push(note.result === 'in-stock' ? pill('good', 'You saw it in stock') : pill('idle', 'You saw nothing'));
      kids.push(el('p', { class: 'looked' }, ['You looked ', el('strong', { 'data-at': String(note.at), class: 'ago', text: C.ago(note.at, Date.now()) }), '.']));
    } else {
      kids.push(pill('info', 'Tap through to check'));
      kids.push(msg('No public stock check - their own page and stores have the answer.'));
    }
    var todo = [];
    kids = todo;
    kids.push(el('div', { class: 'actions' }, [
      link(c.product, c.name + '’s iPhone Duo page', 'primary', hosts),
      link(c.stores, 'Check in store', '', hosts),
    ]));
    kids.push(el('div', { class: 'note-row', role: 'group', 'aria-label': 'What you saw at ' + c.name }, [
      el('button', { class: 'btn' + (note && note.result === 'nothing' ? ' pressed' : ''), type: 'button', 'data-note': id, 'data-result': 'nothing', 'aria-pressed': note && note.result === 'nothing' ? 'true' : 'false', text: 'Checked - nothing' }),
      el('button', { class: 'btn' + (note && note.result === 'in-stock' ? ' pressed' : ''), type: 'button', 'data-note': id, 'data-result': 'in-stock', 'aria-pressed': note && note.result === 'in-stock' ? 'true' : 'false', text: 'In stock!' }),
    ]));
    return card({ name: c.name, live: false, carrier: true, chosen: state.pick.carrier === id }, [el('div', { class: 'c-info' }, info), el('div', { class: 'c-do' }, todo)]);
  }

  function drawCards() {
    var holder = $('cards');
    holder.textContent = '';
    if (state.error) {
      holder.appendChild(el('p', { class: 'card err', role: 'alert', text: state.error }));
    }
    holder.appendChild(appleCard());
    holder.appendChild(bestbuyCard());
    C.CARRIER_IDS.forEach(function (id) { holder.appendChild(carrierCard(id)); });
    var sub = $('resultsSub');
    if (state.result) {
      $('resultsTitle').textContent = state.result.label || C.pickLabel(state.pick);
      sub.textContent = 'Near ' + state.zip + '. ' + sourcesLine();
    } else {
      $('resultsTitle').textContent = 'Where to look';
      sub.textContent = sourcesLine();
    }
  }
  /** What is live and what is a link, said once under the heading. */
  function sourcesLine() {
    var live = C.watchPlan(state.meta).live;
    var a = live.indexOf('Apple') >= 0, b = live.indexOf('Best Buy') >= 0;
    if (a && b) return 'Apple and Best Buy are live checks; the carriers are links.';
    if (a) return 'Apple is a live check; Best Buy is a link until it’s connected, and the carriers are links.';
    if (b) return 'Best Buy is a live check. Apple blocks server checks, so its card has an iPhone Shortcut; the carriers are links.';
    return 'Apple blocks server checks, so its card has an iPhone Shortcut. Best Buy is a link until it’s connected; the carriers are links.';
  }

  $('cards').addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#shortcutBtn')) { openSheet(); return; }
    var b = e.target.closest ? e.target.closest('button[data-note]') : null;
    if (!b) return;
    var id = b.getAttribute('data-note'), result = b.getAttribute('data-result');
    if (C.CARRIER_IDS.indexOf(id) < 0) return;
    state.notes[id] = { at: Date.now(), result: result };
    save('localStorage', 'duohunt-carriers', state.notes);
    drawCards();
    say(C.CARRIER_LINKS[id].name + ': noted.');
  });

  /* ---------------- "Check from my iPhone": the Shortcut recipe ---------------- */
  var sheet = $('sheet');
  var recipe = { url: '', part: '', product: '' };
  var sheetToZip = false; // closed by "Add my ZIP": focus the ZIP box, not the opener
  function fillSheet() {
    var part = currentPart();
    var zip = C.cleanZip($('zip').value);
    recipe.part = part || '';
    recipe.url = (part && C.fulfillmentUrl(part, zip)) || '';
    recipe.product = C.appleProductUrl(part);
    var values = { label: C.pickLabel(state.pick), part: recipe.part, zip: zip || '', zipOr: zip || 'your ZIP' };
    sheet.querySelectorAll('[data-fill]').forEach(function (n) { n.textContent = values[n.getAttribute('data-fill')] || ''; });
    sheet.querySelectorAll('[data-show]').forEach(function (n) {
      var w = n.getAttribute('data-show');
      n.hidden = w === 'zip' ? !recipe.url : w === 'nozip' ? !!recipe.url : false;
    });
    $('recipeUrl').textContent = recipe.url;
    $('recipeProduct').textContent = recipe.product;
  }
  function openSheet() {
    if (!currentPart()) return;
    fillSheet();
    try { if (sheet.showModal) sheet.showModal(); else sheet.setAttribute('open', ''); } catch (e) { sheet.setAttribute('open', ''); }
    var body = sheet.querySelector('.sheet-body');
    if (body) body.scrollTop = 0;
    sheet.scrollTop = 0;
  }
  function closeSheet() {
    try { if (sheet.close) sheet.close(); else sheet.removeAttribute('open'); } catch (e) { sheet.removeAttribute('open'); }
  }
  sheet.addEventListener('close', function () {
    var b = $('shortcutBtn');
    if (b && !sheetToZip) b.focus();
    sheetToZip = false;
  });
  $('sheetClose').addEventListener('click', closeSheet);
  // A tap on the dimmed backdrop (the dialog itself, outside its body) closes it.
  sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
  $('sheetZip').addEventListener('click', function () {
    sheetToZip = true;
    closeSheet();
    $('zip').focus();
  });
  function copied(btn, ok) {
    btn.textContent = ok ? 'Copied' : 'Press and hold to copy';
    say(ok ? 'Copied.' : 'Couldn’t copy - press and hold the text to copy it.');
    setTimeout(function () { btn.textContent = 'Copy'; }, 2200);
  }
  function copyText(text, btn) {
    function fallback() {
      // Inside the dialog: while it is modal, anything outside it is inert.
      var ta = el('textarea', { readonly: true, class: 'copy-src', 'aria-hidden': 'true', tabindex: '-1' });
      ta.value = text;
      sheet.appendChild(ta);
      var ok = false;
      try { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); ok = document.execCommand('copy'); } catch (e) { ok = false; }
      sheet.removeChild(ta);
      copied(btn, ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { copied(btn, true); }, fallback);
    } else fallback();
  }
  sheet.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-copy]') : null;
    if (!b) return;
    var text = recipe[b.getAttribute('data-copy')];
    if (text) copyText(text, b);
  });

  /* ---------------- history ---------------- */
  function drawHistory() {
    var ol = $('hist');
    ol.textContent = '';
    state.history.forEach(function (h) {
      ol.appendChild(el('li', { class: h.hit ? 'hit' : '' }, [
        el('div', { class: 'h-top' }, [C.clean(h.label, 80), el('span', { class: 'h-time', 'data-at': String(h.at), text: C.ago(h.at, Date.now()) })]),
        el('div', { class: 'h-sum', text: C.clean(h.summary, 200) }),
      ]));
    });
    $('histEmpty').hidden = state.history.length > 0;
  }

  /* ---------------- "2 min ago" stays true ---------------- */
  setInterval(function () {
    var now = Date.now();
    document.querySelectorAll('[data-at]').forEach(function (n) {
      var at = Number(n.getAttribute('data-at'));
      n.textContent = (n.classList.contains('when') ? 'Checked ' : '') + C.ago(at, now);
    });
    if (state.watching) drawWatch();
  }, 1000 * 15);

  /* ---------------- watch on this tab ---------------- */
  var timer = null;
  function schedule() {
    clearTimeout(timer);
    if (!state.watching || document.visibilityState !== 'visible') return;
    state.nextAt = Date.now() + C.WATCH_MS;
    timer = setTimeout(function () { check('watch'); }, C.WATCH_MS);
    drawWatch();
  }
  function drawWatch() {
    var sw = $('watch');
    // Only what the server checks live can be watched: Best Buy once it is
    // connected (and Apple only if its server check is ever switched on).
    var plan = C.watchPlan(state.meta);
    sw.disabled = !plan.enabled;
    $('watchText').textContent = plan.text;
    if (!plan.enabled && state.watching) { state.watching = false; clearTimeout(timer); save('sessionStorage', 'duohunt-watch', false); }
    sw.setAttribute('aria-checked', state.watching ? 'true' : 'false');
    var s = $('watchStatus');
    if (!state.watching) { s.hidden = true; return; }
    s.hidden = false;
    if (document.visibilityState !== 'visible') { s.textContent = 'Paused while this tab is hidden.'; return; }
    var mins = Math.max(1, Math.ceil((state.nextAt - Date.now()) / 60000));
    s.textContent = state.checking ? 'Watching - checking now…' : 'Watching - next check in about ' + mins + ' min. Keep this tab open.';
  }
  $('watch').addEventListener('click', function () {
    if (!C.watchPlan(state.meta).enabled) return;
    state.watching = !state.watching;
    save('sessionStorage', 'duohunt-watch', state.watching);
    if (state.watching) {
      if ('Notification' in window && Notification.permission === 'default') {
        try { Notification.requestPermission(); } catch (e) { /* older Safari */ }
      }
      if (!C.cleanZip($('zip').value)) {
        state.watching = false;
        $('formErr').textContent = 'Add your ZIP first, then switch on watching.';
        $('formErr').hidden = false;
        $('zip').focus();
      } else if (!state.result || state.result.pickKey !== pickKey()) check('watch-start');
      else schedule();
    } else {
      clearTimeout(timer);
    }
    drawWatch();
  });
  document.addEventListener('visibilitychange', function () {
    if (!state.watching) return;
    if (document.visibilityState === 'visible') {
      stopFlash();
      // Back on screen: if a check is due, do it now.
      if (!state.nextAt || Date.now() >= state.nextAt) check('watch'); else { clearTimeout(timer); timer = setTimeout(function () { check('watch'); }, state.nextAt - Date.now()); }
    } else {
      clearTimeout(timer);
    }
    drawWatch();
  });

  var flashTimer = null, baseTitle = document.title;
  function stopFlash() { clearInterval(flashTimer); flashTimer = null; document.title = baseTitle; }
  function alertFound(data) {
    var text = C.summary(data);
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        var n = new Notification('iPhone Duo spotted', { body: text, icon: 'icon.svg', tag: 'duohunt' });
        n.onclick = function () { window.focus(); n.close(); };
      }
    } catch (e) { /* notifications unavailable */ }
    stopFlash();
    var on = false, ticks = 0;
    flashTimer = setInterval(function () {
      on = !on; ticks++;
      document.title = on ? '★ In stock! - Duo Hunt' : baseTitle;
      if (ticks > 60) stopFlash();
    }, 1000);
  }
  window.addEventListener('focus', stopFlash);

  /* ---------------- start ---------------- */
  drawPicker();
  drawCards();
  drawHistory();
  drawWatch();
  fetch(BASE + 'api/meta', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (m) {
    var parts = {};
    if (m && m.parts && typeof m.parts === 'object') Object.keys(m.parts).forEach(function (k) { if (C.validPart(m.parts[k])) parts[k] = m.parts[k]; });
    state.meta = { bestbuy: m.bestbuy === true, appleServerCheck: m.appleServerCheck === true, parts: parts };
    drawCards();
    // A watch left on in this tab resumes only if there is still something live to watch.
    if (load('sessionStorage', 'duohunt-watch', false) === true && state.zip && C.watchPlan(state.meta).enabled) { state.watching = true; check('watch-start'); }
    drawWatch();
  }).catch(function () { /* the cards still work as links */ });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
}());
