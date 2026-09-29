/* Dibs - the page. One file, no build step. Every string that came from
 * outside this file (a typed name, a pasted receipt, a model's reading, a
 * table from the server) is escaped before it is drawn, and no handler is
 * written into markup (the lab's CSP allows script from this origin only).
 * The sums are dibs-core.js, the same file the server and the tests run.
 *
 * Three ways to be here:
 *   sample - the example dinner, first thing a new visitor sees. Tappable,
 *            never saved.
 *   local  - a bill on this phone only. No account; kept in localStorage.
 *   table  - a shared table at t/<code>. The host is signed in; guests are
 *            not. Everyone's phone polls every 3 s while the page is visible.
 */
(function () {
  'use strict';

  var C = window.DibsCore;
  var S = window.DibsSample;
  var QR = window.DibsQR;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_LOCAL = 'dibs-bill-v1';
  var PHOTO_PX = 1600;
  var POLL_MS = 3000;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TABLE_CODE = (function () { var m = /\/t\/([A-Za-z0-9-]{4,16})\/?$/.exec(location.pathname); return m ? m[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null; }());

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function m$(c) { return C.money(c, state.bill ? state.bill.currency : 'USD'); }

  var state = {
    me: null,          // the account, if any
    mode: 'sample',    // 'sample' | 'local' | 'table'
    bill: null, people: [], claims: {}, everyone: {}, paid: {},
    active: null,      // whose dibs a tap calls
    editing: false,
    table: null,       // {code, display, v, locked, me, host, expiresAt}
    flow: null,        // the start flow: {step, ...}
    wasOpen: null,     // unclaimed count last drawn, for "Everyone's claimed!"
    saveTimer: null, saving: false, polling: null, pollBusy: false,
    openRow: null,     // which person's breakdown is open in "who owes whom"
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // The snap route streams whitespace and so answers 200 even on
        // failure; an {error} body is a failure however it arrived.
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
    var t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 2600);
  }
  function copy(text, what) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select the text and copy it by hand.'); });
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  /** The 403 an unconfirmed free account gets, with its resend button. */
  function verifyNote(where, e) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then come back and snap it again. Typing or pasting the receipt is free meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).onclick = function () {
      var b = this; b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    };
  }

  /* ---------------- the bill's state ---------------- */

  function person(id) { for (var i = 0; i < state.people.length; i++) if (state.people[i].id === id) return state.people[i]; return null; }
  function item(id) { for (var i = 0; i < state.bill.items.length; i++) if (state.bill.items[i].id === id) return state.bill.items[i]; return null; }
  function hex(p) { return C.colorHex(p && p.color); }
  function initial(p) { var ch = Array.from(String((p && p.name) || '?'))[0] || '?'; return ch.toUpperCase(); }
  function avatar(p, extra) { return '<span class="av' + (extra ? ' ' + extra : '') + '" style="--c:' + esc(hex(p)) + '" aria-hidden="true">' + esc(initial(p)) + '</span>'; }
  function splitNow() { return C.split(state.bill, state.people, state.claims, state.everyone); }
  function canEditBill() { return state.mode === 'local' || (state.mode === 'table' && state.table.host); }
  function canActFor(pid) { return state.mode !== 'table' || state.table.host || pid === state.table.me; }
  function locked() { return state.mode === 'table' && state.table.locked && !state.table.host; }

  function setLocal(data, mode) {
    state.mode = mode;
    state.bill = C.cleanBill(data.bill);
    state.people = C.cleanPeople(data.people);
    state.claims = C.cleanClaims(data.claims, state.bill, state.people);
    state.everyone = C.cleanEveryone(data.everyone, state.bill);
    state.paid = data.paid && typeof data.paid === 'object' ? data.paid : {};
    state.active = person(data.active) ? data.active : (person(state.bill.payerId) ? state.bill.payerId : (state.people[0] || {}).id || null);
    state.table = null;
    state.editing = false;
    state.wasOpen = null;
    drawAll();
  }
  function samplePlay() { var s = S.state(); s.active = 'pana'; setLocal(s, 'sample'); }

  /** Save a phone-only bill; a table's changes go to the server instead. */
  function saveLocal() {
    if (state.mode !== 'local') return;
    keep(K_LOCAL, { bill: state.bill, people: state.people, claims: state.claims, everyone: state.everyone, paid: state.paid, active: state.active });
  }

  /* ---------------- drawing ---------------- */

  function drawAll() {
    $('#flow').hidden = !state.flow;
    $('#billView').hidden = Boolean(state.flow);
    drawStrip();
    if (state.flow) { drawFlow(); $('#sticky').hidden = true; return; }
    drawExtras();
    refresh();
  }
  /** Everything that depends on the numbers - not the inputs being typed in. */
  function refresh() {
    if (state.flow || !state.bill) return;
    var r = splitNow();
    drawHead(r); drawPeople(r); drawItems(r); drawSums(r); drawSettle(r); drawShare(); drawSticky(r);
    saveLocal();
  }

  function drawStrip() {
    var el = $('#strip');
    if (state.mode === 'sample' && !state.flow) {
      el.className = 'strip';
      el.innerHTML = '<p><b>This is an example dinner</b> - tap an item to call dibs, then split your own.</p>' +
        '<button class="btn big light" type="button" id="startBtn">Split a bill</button>';
      $('#startBtn').onclick = startFlow;
      return;
    }
    if (state.mode === 'local' && !state.flow) {
      el.className = 'strip quiet-strip';
      el.innerHTML = '<p class="small">On this phone only.</p><div class="row"><button class="btn small ghost" type="button" id="newBtn">New bill</button><button class="btn small ghost" type="button" id="exBtn">See the example</button></div>';
      $('#newBtn').onclick = function () { if (confirm('Start a new bill? This one will be cleared from this phone.')) startFlow(); };
      $('#exBtn').onclick = function () { samplePlay(); scrollTo(0, 0); };
      return;
    }
    if (state.mode === 'table' && state.table) {
      var t = state.table;
      el.className = 'strip table-strip';
      el.innerHTML = '<div class="tcode"><span class="small">Table</span><b>' + esc(t.display) + '</b></div>' +
        '<p class="small">' + (t.locked ? '🔒 Done - everyone pay up.' : (t.host ? 'You’re running this table. Friends scan the code and tap what they had.' : 'Tap what you had. Everyone’s screen updates as they go.')) + '</p>' +
        (t.host ? '<div class="row"><button class="btn small light" type="button" id="qrBtn">Show QR code</button><button class="btn small ghost-light" type="button" id="linkBtn">Copy link</button></div>' : '');
      if (t.host) {
        $('#qrBtn').onclick = showQr;
        $('#linkBtn').onclick = function () { copy(tableLink(), 'Link copied - send it to the table'); };
      }
      return;
    }
    el.className = ''; el.innerHTML = '';
  }

  function drawHead(r) {
    var b = state.bill;
    var payer = person(b.payerId);
    var el = $('#billHead');
    el.innerHTML =
      '<div class="head-row"><div class="head-title">' +
      (canEditBill() ? '<input class="title-in" id="titleIn" maxlength="' + C.LIMITS.title + '" aria-label="What the bill is for" placeholder="Dinner at…" value="' + esc(b.title) + '">' : '<h1>' + esc(b.title || 'The bill') + '</h1>') +
      '<p class="small muted">' + (payer ? avatar(payer, 'sm') + ' <b>' + esc(payer.name) + '</b> paid' : 'Nobody marked as paying yet') + ' · ' + esc(b.items.length) + ' item' + (b.items.length === 1 ? '' : 's') + '</p></div>' +
      '<div class="head-total"><span class="small muted">Total</span><b>' + esc(m$(r.grand)) + '</b></div></div>';
    var ti = $('#titleIn');
    if (ti) {
      ti.addEventListener('input', function () { state.bill.title = C.clean(ti.value, C.LIMITS.title); billChanged(true); });
    }
  }

  function drawPeople(r) {
    var el = $('#people');
    var html = state.people.map(function (p) {
      var row = r.people.filter(function (x) { return x.id === p.id; })[0];
      var mine = state.mode === 'table' && p.id === state.table.me;
      var active = p.id === state.active;
      return '<button type="button" class="chip person' + (active ? ' on' : '') + '" data-pid="' + esc(p.id) + '" aria-pressed="' + active + '" style="--c:' + esc(hex(p)) + '">' +
        avatar(p) + '<span class="pname">' + esc(p.name) + (mine ? ' <i>(you)</i>' : '') + '</span><span class="ptotal">' + esc(m$(row ? row.total : 0)) + '</span></button>';
    }).join('');
    var canAdd = (state.mode === 'local' || state.mode === 'sample' || (state.mode === 'table' && state.table.host)) && state.people.length < C.LIMITS.people;
    if (canAdd) html += '<button type="button" class="chip add" id="addPerson">+ Add</button>';
    el.innerHTML = html;
    var hint = $('#peopleHint');
    var act = person(state.active);
    if (state.mode === 'table' && !state.table.host) hint.textContent = act ? 'Tap your name to change it' : '';
    else hint.textContent = act ? 'Tapping for ' + act.name : '';
    $$('[data-pid]', el).forEach(function (b) {
      b.onclick = function () {
        var pid = b.getAttribute('data-pid');
        if (state.mode === 'table' && !state.table.host) {
          if (pid === state.table.me) editPerson(pid);
          else toggleRow(pid);
          return;
        }
        if (pid === state.active) editPerson(pid);
        else { state.active = pid; refresh(); }
      };
    });
    var add = $('#addPerson');
    if (add) add.onclick = function () { editPerson(null); };
  }

  function claimSummary(it, r) {
    var row = state.claims[it.id] || {};
    var ids = Object.keys(row).filter(function (pid) { return person(pid); });
    var sumw = ids.reduce(function (s, pid) { return s + row[pid]; }, 0);
    return { ids: ids, sumw: sumw, row: row, open: r.unclaimed.open.filter(function (o) { return o.itemId === it.id; })[0] || null };
  }

  function drawItems(r) {
    var list = $('#items');
    var b = state.bill;
    $('#editBtn').hidden = !canEditBill();
    $('#editBtn').textContent = state.editing ? 'Done' : 'Edit items';
    $('#editBtn').setAttribute('aria-pressed', String(state.editing));
    $('#itemTools').hidden = !state.editing;
    if (state.editing) { drawEditRows(list, b.items); drawUnclaimed(r); return; }
    if (!b.items.length) {
      list.innerHTML = '<li class="empty">No items yet. ' + (canEditBill() ? 'Tap <b>Edit items</b> to add them.' : '') + '</li>';
      drawUnclaimed(r);
      return;
    }
    var act = person(state.active);
    list.innerHTML = b.items.map(function (it) {
      var cs = claimSummary(it, r);
      var mineW = act ? (cs.row[act.id] || 0) : 0;
      var isOpen = Boolean(cs.open);
      var every = state.everyone[it.id];
      var who = cs.ids.map(function (pid) { var p = person(pid); return avatar(p, 'pop'); }).join('');
      var note = '';
      if (every && isOpen === false && cs.sumw < it.qty) note = 'Everyone';
      else if (every) note = 'Rest shared by everyone';
      else if (it.qty > 1 && cs.sumw < it.qty) note = cs.sumw ? cs.sumw + ' of ' + it.qty + ' claimed' : '';
      else if (it.qty > 1 && cs.sumw === it.qty && cs.ids.length > 1) {
        var us = cs.ids.map(function (pid) { return cs.row[pid]; });
        note = us.every(function (u) { return u === 1; }) ? 'One each' : us.join(' + ');
      } else if (it.qty > 1 && cs.ids.length > 1) note = 'Shared ' + cs.ids.length + ' ways';
      else if (cs.ids.length > 1) {
        var ws = cs.ids.map(function (pid) { return cs.row[pid]; });
        var even = ws.every(function (w) { return w === ws[0]; });
        note = even ? 'Split ' + cs.ids.length + ' ways' : 'Split ' + ws.join(':');
      }
      var mineCents = 0;
      if (act) { var pr = r.people.filter(function (x) { return x.id === act.id; })[0]; var ln = pr && pr.lines.filter(function (l) { return l.itemId === it.id; })[0]; mineCents = ln ? ln.cents : 0; }
      return '<li class="item' + (isOpen ? ' open' : '') + (mineW ? ' mine' : '') + '" data-iid="' + esc(it.id) + '">' +
        '<button type="button" class="tap" data-claim="' + esc(it.id) + '" aria-pressed="' + Boolean(mineW) + '"' + (locked() ? ' disabled' : '') + '>' +
        '<span class="iname">' + (it.qty > 1 ? '<span class="qty">' + esc(it.qty) + '×</span> ' : '') + esc(it.name) + '</span>' +
        '<span class="iprice">' + esc(m$(C.itemTotal(it))) + '</span>' +
        '<span class="iwho">' + (who || (isOpen ? '<span class="tag open-tag">Unclaimed</span>' : '')) + (note ? '<span class="inote">' + esc(note) + '</span>' : '') +
        (mineCents && act ? '<span class="imine" style="--c:' + esc(hex(act)) + '">' + esc(act.name) + ' ' + esc(m$(mineCents)) + '</span>' : '') + '</span>' +
        '</button>' +
        (it.qty > 1 && mineW && !locked() ? '<span class="stepper" role="group" aria-label="Units of ' + esc(it.name) + '"><button type="button" data-step="-1" data-sid="' + esc(it.id) + '" aria-label="One fewer">−</button><b>' + esc(mineW) + '</b><button type="button" data-step="1" data-sid="' + esc(it.id) + '" aria-label="One more">+</button></span>' : '') +
        '<button type="button" class="more" data-more="' + esc(it.id) + '" aria-label="Split options for ' + esc(it.name) + '">⋯</button>' +
        '</li>';
    }).join('');
    $$('[data-claim]', list).forEach(function (btn) { btn.onclick = function () { tapItem(btn.getAttribute('data-claim'), btn); }; });
    $$('[data-step]', list).forEach(function (btn) { btn.onclick = function () { stepItem(btn.getAttribute('data-sid'), Number(btn.getAttribute('data-step'))); }; });
    $$('[data-more]', list).forEach(function (btn) { btn.onclick = function () { itemSheet(btn.getAttribute('data-more')); }; });
    drawUnclaimed(r);
  }

  function drawUnclaimed(r) {
    var el = $('#unclaimed');
    var open = r.unclaimed.open;
    if (!state.bill.items.length) { el.innerHTML = ''; return; }
    if (!open.length) {
      el.innerHTML = '<p class="allclaimed">✓ Everything’s claimed</p>';
    } else {
      var canEvery = state.mode !== 'table' || state.table.host;
      el.innerHTML = '<div class="unclaimed"><p><b>' + open.length + ' item' + (open.length === 1 ? '' : 's') + ' left to claim</b> · ' + esc(m$(r.unclaimed.items)) + '</p>' +
        (canEvery ? '<button type="button" class="btn small ghost" id="everyBtn">Split what’s left among everyone</button>' : '<p class="small muted">Tap it if it was yours - or ask whoever’s running the table to split it among everyone.</p>') + '</div>';
      var eb = $('#everyBtn');
      if (eb) eb.onclick = splitRestAmongEveryone;
    }
    // "Everyone's claimed!" - once, when the last item goes.
    if (state.wasOpen !== null && state.wasOpen > 0 && open.length === 0 && state.people.length > 1) celebrate();
    state.wasOpen = open.length;
  }

  function celebrate() {
    var el = $('#celebrate');
    el.innerHTML = '<div class="party" role="status"><span aria-hidden="true">🎉</span> <b>Everyone’s claimed!</b> Here’s what each person owes.</div>';
    if (!REDUCED) {
      var burst = document.createElement('div');
      burst.className = 'burst';
      burst.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < 14; i++) {
        var s = document.createElement('span');
        s.textContent = ['🍕', '🍷', '🥗', '🍝', '🍸', '🎉', '✨'][i % 7];
        s.style.setProperty('--x', (Math.round(Math.cos(i / 14 * 6.283) * 120)) + 'px');
        s.style.setProperty('--y', (Math.round(Math.sin(i / 14 * 6.283) * 90) - 40) + 'px');
        burst.appendChild(s);
      }
      document.body.appendChild(burst);
      setTimeout(function () { burst.remove(); }, 1400);
    }
    setTimeout(function () { var s = $('#settleCard'); if (s && s.scrollIntoView && window.innerWidth < 1000) s.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); }, REDUCED ? 0 : 500);
  }

  /* ---------------- editing items (and the review of a read receipt) ---------------- */

  function drawEditRows(list, items) {
    list.innerHTML = items.map(function (it) {
      return '<li class="erow" data-eid="' + esc(it.id) + '">' +
        '<span class="qtyw"><input class="input qty-in" inputmode="numeric" aria-label="How many" value="' + esc(it.qty) + '"></span>' +
        '<input class="input name-in" maxlength="' + C.LIMITS.name + '" aria-label="Item" value="' + esc(it.name) + '">' +
        '<span class="money"><input class="input price-in" inputmode="decimal" aria-label="Price for all of them" value="' + esc(C.plain(C.itemTotal(it))) + '"></span>' +
        '<button type="button" class="x" data-del="' + esc(it.id) + '" aria-label="Remove ' + esc(it.name) + '">✕</button>' +
        '</li>';
    }).join('') || '<li class="empty">No items yet - add one below.</li>';
    $$('.erow', list).forEach(function (row) {
      var id = row.getAttribute('data-eid');
      function read() {
        var it = itemIn(items, id); if (!it) return;
        var q = Number($('.qty-in', row).value);
        var total = C.toCents($('.price-in', row).value);
        var name = C.clean($('.name-in', row).value, C.LIMITS.name);
        var bad = false;
        if (Number.isInteger(q) && q >= 1 && q <= C.LIMITS.qty) it.qty = q; else bad = true;
        if (name) it.name = name; else bad = true;
        if (total !== null && total > 0 && total % it.qty === 0 && total / it.qty <= C.LIMITS.unitMax) it.unit = total / it.qty;
        else if (total !== null && total > 0 && total <= C.LIMITS.unitMax) { it.unit = total; if (it.qty !== 1) { it.qty = 1; } }
        else bad = true;
        row.classList.toggle('bad', bad);
        if (items === state.bill.items) billChanged(false);
        else drawReviewCheck();
      }
      $$('input', row).forEach(function (inp) { inp.addEventListener('input', read); inp.addEventListener('change', function () { read(); if (items === state.bill.items) drawItems(splitNow()); }); });
      $('[data-del]', row).onclick = function () {
        var i = items.indexOf(itemIn(items, id));
        if (i >= 0) items.splice(i, 1);
        if (items === state.bill.items) { delete state.claims[id]; delete state.everyone[id]; billChanged(false); drawItems(splitNow()); }
        else drawReview();
      };
    });
  }
  function itemIn(items, id) { for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]; return null; }

  $('#editBtn').onclick = function () {
    state.editing = !state.editing;
    if (!state.editing) { state.bill = C.cleanBill(state.bill); billChanged(true); }
    refresh();
  };
  $('#addItem').onclick = function () {
    if (state.bill.items.length >= C.LIMITS.items) return toast('A bill can have ' + C.LIMITS.items + ' items.');
    state.bill.items.push({ id: C.shortId('i'), name: 'New item', unit: 100, qty: 1 });
    drawItems(splitNow());
    var rows = $$('.erow'); var last = rows[rows.length - 1];
    if (last) { var n = $('.name-in', last); n.focus(); n.select(); }
    billChanged(false);
  };
  $('#pasteMore').onclick = function () {
    sheet('<h2>Paste more lines</h2><p class="small muted">Lines with a price are added to the bill. Tax, tip and totals in here are ignored.</p><textarea class="input" id="moreBox" rows="7" placeholder="Garlic bread 7.50&#10;2 x Beer 14.00"></textarea><div id="moreErr"></div><button class="btn block" type="button" id="moreGo">Add these</button>', function (root) {
      $('#moreGo', root).onclick = function () {
        var p = C.parseReceipt($('#moreBox', root).value);
        if (!p.items.length) return showError({ message: 'No lines with a price in that.' }, $('#moreErr', root));
        var room = C.LIMITS.items - state.bill.items.length;
        state.bill.items = state.bill.items.concat(p.items.slice(0, room));
        closeSheet(); billChanged(true); drawItems(splitNow());
        toast('Added ' + Math.min(room, p.items.length) + ' item' + (p.items.length === 1 ? '' : 's'));
      };
    });
  };

  /* ---------------- claiming ---------------- */

  function tapItem(iid, btn) {
    if (locked()) return toast('The bill is locked.');
    var act = person(state.active);
    if (!act) { if (state.mode === 'table') return askName(); return editPerson(null); }
    if (!canActFor(act.id)) return;
    var cur = (state.claims[iid] || {})[act.id] || 0;
    setWeight(iid, act.id, cur ? 0 : 1);
    if (!cur && btn && !REDUCED) { var li = btn.closest('.item'); if (li) { li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash'); } }
    if (navigator.vibrate && !cur) try { navigator.vibrate(8); } catch (e) { /* ignore */ }
  }
  function stepItem(iid, by) {
    var act = person(state.active); if (!act) return;
    var it = item(iid); if (!it) return;
    var cur = (state.claims[iid] || {})[act.id] || 0;
    setWeight(iid, act.id, Math.max(0, Math.min(C.LIMITS.weight, cur + by)));
  }
  function setWeight(iid, pid, w) {
    var row = Object.assign({}, state.claims[iid] || {});
    if (w) row[pid] = w; else delete row[pid];
    if (Object.keys(row).length) state.claims[iid] = row; else delete state.claims[iid];
    refresh();
    if (state.mode === 'table') {
      api('POST', 'api/table/' + state.table.code + '/claim', { itemId: iid, pid: pid, weight: w }).then(applyTable).catch(tableError);
    }
  }
  function splitRestAmongEveryone() {
    var r = splitNow();
    var ids = r.unclaimed.open.map(function (o) { return o.itemId; });
    if (!ids.length) return;
    ids.forEach(function (id) { state.everyone[id] = true; });
    refresh();
    toast('Split among everyone');
    if (state.mode === 'table') {
      ids.reduce(function (p, id) { return p.then(function () { return api('POST', 'api/tables/' + state.table.code + '/everyone', { itemId: id, on: true }).then(applyTable); }); }, Promise.resolve()).catch(tableError);
    }
  }

  /** One line's options: shares per person (2:1), among everyone, edit. */
  function itemSheet(iid) {
    var it = item(iid); if (!it) return;
    var every = state.everyone[iid];
    function draw(root) {
      var row = state.claims[iid] || {};
      var people = state.people.filter(function (p) { return canActFor(p.id) || row[p.id]; });
      $('.body', root).innerHTML = '<h2>' + esc(it.name) + '</h2><p class="small muted">' + (it.qty > 1 ? esc(it.qty) + ' × ' + esc(m$(it.unit)) + ' = ' : '') + esc(m$(C.itemTotal(it))) + '. ' +
        (it.qty > 1 ? 'Each tap is one of the ' + esc(it.qty) + '. More shares than there are means it’s shared.' : 'More than one person? It’s split by shares - 1 and 1 is half each, 2 and 1 is two-thirds and a third.') + '</p>' +
        '<ul class="shares">' + people.map(function (p) {
          var w = row[p.id] || 0;
          var can = canActFor(p.id) && !locked();
          return '<li>' + avatar(p) + '<span class="pname">' + esc(p.name) + '</span>' +
            '<span class="stepper big" role="group" aria-label="' + esc(p.name) + '’s shares">' +
            '<button type="button" data-w="-1" data-p="' + esc(p.id) + '"' + (can && w ? '' : ' disabled') + ' aria-label="Fewer">−</button><b>' + esc(w) + '</b>' +
            '<button type="button" data-w="1" data-p="' + esc(p.id) + '"' + (can ? '' : ' disabled') + ' aria-label="More">+</button></span></li>';
        }).join('') + '</ul>' +
        (state.mode !== 'table' || state.table.host ? '<label class="check"><input type="checkbox" id="everyIn"' + (every ? ' checked' : '') + '> Split whatever’s left of it among everyone</label>' : '') +
        (canEditBill() ? '<button class="btn small ghost" type="button" id="editIt">Edit or remove this item</button>' : '');
      $$('[data-w]', root).forEach(function (b) {
        b.onclick = function () {
          var pid = b.getAttribute('data-p');
          var cur = (state.claims[iid] || {})[pid] || 0;
          setWeight(iid, pid, Math.max(0, Math.min(C.LIMITS.weight, cur + Number(b.getAttribute('data-w')))));
          draw(root);
        };
      });
      var ev = $('#everyIn', root);
      if (ev) ev.onchange = function () {
        every = ev.checked;
        if (every) state.everyone[iid] = true; else delete state.everyone[iid];
        refresh();
        if (state.mode === 'table') api('POST', 'api/tables/' + state.table.code + '/everyone', { itemId: iid, on: every }).then(applyTable).catch(tableError);
      };
      var ed = $('#editIt', root);
      if (ed) ed.onclick = function () { closeSheet(); state.editing = true; refresh(); var r = $('[data-eid="' + iid + '"] .name-in'); if (r) r.focus(); };
    }
    sheet('<div class="body"></div>', draw);
  }

  /* ---------------- people ---------------- */

  function editPerson(pid) {
    var p = pid ? person(pid) : null;
    var isHostEdit = state.mode === 'table' && state.table.host;
    var guestSelf = state.mode === 'table' && !state.table.host;
    function draw(root) {
      var colour = p ? p.color : firstFreeColor();
      $('.body', root).innerHTML = '<h2>' + (p ? (guestSelf ? 'Your name' : 'Edit ' + esc(p.name)) : 'Add someone') + '</h2>' +
        '<label class="field"><span>Name or emoji</span><input class="input" id="pName" maxlength="' + C.LIMITS.personName + '" autocomplete="off" value="' + esc(p ? p.name : '') + '" placeholder="Ana"></label>' +
        '<div class="field"><span id="colLbl">Colour</span><div class="swatches" role="radiogroup" aria-labelledby="colLbl">' + C.COLORS.map(function (c) {
          return '<button type="button" role="radio" class="sw" data-col="' + c.id + '" aria-checked="' + (c.id === colour) + '" aria-label="' + esc(c.label) + '" style="--c:' + c.hex + '"></button>';
        }).join('') + '</div></div><div id="pErr"></div>' +
        '<button class="btn block" type="button" id="pSave">' + (p ? 'Save' : 'Add') + '</button>' +
        (p && !guestSelf && p.id !== state.bill.payerId ? '<button class="btn block ghost" type="button" id="pPayer">' + esc(p.name) + ' paid the bill</button>' : '') +
        (p && (state.mode === 'local' || state.mode === 'sample' || (isHostEdit && !isHostPerson(p.id))) ? '<button class="btn block ghost danger" type="button" id="pDel">Remove ' + esc(p.name) + '</button>' : '') +
        (p && isHostEdit && tablePerson(p.id) && tablePerson(p.id).joined && !isHostPerson(p.id) ? '<button class="btn block ghost" type="button" id="pFree">Free this name for another phone</button>' : '');
      $$('[data-col]', root).forEach(function (b) { b.onclick = function () { colour = b.getAttribute('data-col'); $$('[data-col]', root).forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); }; });
      $('#pSave', root).onclick = function () {
        var name = C.cleanName($('#pName', root).value);
        if (!name) return showError({ message: 'Add a name (or an emoji).' }, $('#pErr', root));
        if (state.mode === 'table') {
          var req = p ? api('POST', 'api/table/' + state.table.code + '/person', { pid: p.id, name: name, color: colour }) : api('POST', 'api/tables/' + state.table.code + '/people', { name: name, color: colour });
          return req.then(function (v) { closeSheet(); applyTable(v); if (v.added) { state.active = v.added; refresh(); } }).catch(function (e) { showError(e, $('#pErr', root)); });
        }
        ensureLocal();
        if (p) { p.name = name; p.color = colour; }
        else {
          if (state.people.length >= C.LIMITS.people) return showError({ message: 'Up to ' + C.LIMITS.people + ' people.' }, $('#pErr', root));
          var np = { id: C.shortId('p'), name: name, color: colour };
          state.people.push(np); state.active = np.id;
          if (!state.bill.payerId) state.bill.payerId = np.id;
        }
        closeSheet(); refresh();
      };
      var py = $('#pPayer', root);
      if (py) py.onclick = function () { ensureLocal(); state.bill.payerId = p.id; delete state.paid[p.id]; closeSheet(); billChanged(true); };
      var del = $('#pDel', root);
      if (del) del.onclick = function () {
        if (!confirm('Remove ' + p.name + ' and their dibs?')) return;
        if (state.mode === 'table') return api('DELETE', 'api/tables/' + state.table.code + '/people/' + encodeURIComponent(p.id)).then(function (v) { closeSheet(); applyTable(v); }).catch(function (e) { showError(e, $('#pErr', root)); });
        ensureLocal();
        state.people = state.people.filter(function (x) { return x !== p; });
        Object.keys(state.claims).forEach(function (k) { delete state.claims[k][p.id]; if (!Object.keys(state.claims[k]).length) delete state.claims[k]; });
        delete state.paid[p.id];
        if (state.bill.payerId === p.id) state.bill.payerId = (state.people[0] || {}).id || null;
        if (state.active === p.id) state.active = (state.people[0] || {}).id || null;
        closeSheet(); refresh();
      };
      var fr = $('#pFree', root);
      if (fr) fr.onclick = function () { api('DELETE', 'api/tables/' + state.table.code + '/people/' + encodeURIComponent(p.id) + '?release=1').then(function (v) { closeSheet(); applyTable(v); toast(p.name + ' can be picked again'); }).catch(function (e) { showError(e, $('#pErr', root)); }); };
      var n = $('#pName', root);
      n.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('#pSave', root).click(); } });
    }
    sheet('<div class="body"></div>', draw);
  }
  function firstFreeColor() {
    var taken = state.people.map(function (p) { return p.color; });
    for (var i = 0; i < C.COLOR_IDS.length; i++) if (taken.indexOf(C.COLOR_IDS[i]) < 0) return C.COLOR_IDS[i];
    return C.COLOR_IDS[state.people.length % C.COLOR_IDS.length];
  }
  function tablePerson(pid) { var t = state.tablePeople || []; for (var i = 0; i < t.length; i++) if (t[i].id === pid) return t[i]; return null; }
  function isHostPerson(pid) { var p = tablePerson(pid); return Boolean(p && p.host); }

  /** The example stays the example: it can be played with (tip, people,
   *  dibs) but is never saved. "Split a bill" is the way to your own. */
  function ensureLocal() { /* nothing to do - see saveLocal */ }

  /* ---------------- tax, tip & extras ---------------- */

  var TIP_CHIPS = [0, 1500, 1800, 2000, 2200];

  function drawExtras() {
    var el = $('#extras');
    var b = state.bill;
    var edit = canEditBill() || state.mode === 'sample';
    var tip = b.tip;
    var note = C.serviceNote(b);
    el.innerHTML =
      '<div class="xrow"><label for="taxIn">Tax</label><span class="money"><input class="input" id="taxIn" inputmode="decimal" autocomplete="off" value="' + esc(C.plain(b.tax)) + '"' + (edit ? '' : ' disabled') + '></span></div>' +
      '<div class="tipbox"><div class="xrow"><span id="tipLbl">Tip</span><span class="small muted" id="tipNow"></span></div>' +
      (note ? '<p class="svc" role="note">' + esc(note) + '</p>' : '') +
      '<div class="chips" role="group" aria-labelledby="tipLbl">' + TIP_CHIPS.map(function (bp) {
        var on = tip.mode === 'percent' ? tip.bp === bp : (bp === 0 && tip.cents === 0);
        return '<button type="button" class="chip" data-tip="' + bp + '" aria-pressed="' + on + '"' + (edit ? '' : ' disabled') + '>' + (bp ? C.bpText(bp) : 'None') + '</button>';
      }).join('') +
      '<span class="pct"><input class="input" id="tipPct" inputmode="decimal" aria-label="Tip percent" placeholder="other" value="' + (tip.mode === 'percent' && TIP_CHIPS.indexOf(tip.bp) < 0 ? esc(C.bpText(tip.bp).replace('%', '')) : '') + '"' + (edit ? '' : ' disabled') + '></span>' +
      '<span class="money"><input class="input" id="tipAmt" inputmode="decimal" aria-label="Tip amount" placeholder="amount" value="' + (tip.mode === 'amount' && tip.cents ? esc(C.plain(tip.cents)) : '') + '"' + (edit ? '' : ' disabled') + '></span></div>' +
      (tip.mode === 'percent' ? '<div class="seg" role="group" aria-label="Tip on"><button type="button" data-base="subtotal" aria-pressed="' + (tip.base === 'subtotal') + '"' + (edit ? '' : ' disabled') + '>on the food &amp; drink</button><button type="button" data-base="total" aria-pressed="' + (tip.base === 'total') + '"' + (edit ? '' : ' disabled') + '>on the total with tax</button></div>' : '') +
      '<label class="check"><input type="checkbox" id="tipEven"' + (tip.even ? ' checked' : '') + (edit ? '' : ' disabled') + '> Split the tip evenly, not by what each person had</label></div>' +
      '<div id="feeRows"></div>' +
      (edit ? '<div class="row"><button type="button" class="btn small ghost" id="addFee">+ Fee or service charge</button><button type="button" class="btn small ghost" id="addDisc">+ Discount</button></div>' : '');
    drawFeeRows(edit);
    if (!edit) return;
    $('#taxIn').addEventListener('input', function (e) { var c = C.toCents(e.target.value); if (c !== null) { ensureLocal(); state.bill.tax = c; billChanged(false); } });
    $$('[data-tip]', el).forEach(function (btn) {
      btn.onclick = function () { ensureLocal(); state.bill.tip = Object.assign({}, state.bill.tip, { mode: 'percent', bp: Number(btn.getAttribute('data-tip')), onReceipt: false }); drawExtras(); billChanged(true); };
    });
    $('#tipPct').addEventListener('input', function (e) {
      var bp = C.toBp(e.target.value);
      if (bp !== null && bp <= C.LIMITS.tipMaxBp) { ensureLocal(); state.bill.tip = Object.assign({}, state.bill.tip, { mode: 'percent', bp: bp, onReceipt: false }); $$('[data-tip]', el).forEach(function (x) { x.setAttribute('aria-pressed', String(Number(x.getAttribute('data-tip')) === bp)); }); $('#tipAmt').value = ''; billChanged(false); }
    });
    $('#tipAmt').addEventListener('input', function (e) {
      var c = C.toCents(e.target.value);
      if (c !== null) { ensureLocal(); state.bill.tip = Object.assign({}, state.bill.tip, { mode: 'amount', cents: c, onReceipt: false }); $$('[data-tip]', el).forEach(function (x) { x.setAttribute('aria-pressed', 'false'); }); $('#tipPct').value = ''; billChanged(false); }
    });
    $('#tipAmt').addEventListener('change', function () { drawExtras(); });
    $$('[data-base]', el).forEach(function (btn) { btn.onclick = function () { ensureLocal(); state.bill.tip.base = btn.getAttribute('data-base'); drawExtras(); billChanged(true); }; });
    $('#tipEven').onchange = function (e) { ensureLocal(); state.bill.tip.even = e.target.checked; billChanged(true); };
    $('#addFee').onclick = function () { if (state.bill.fees.length >= C.LIMITS.fees) return; ensureLocal(); state.bill.fees.push({ id: C.shortId('f'), name: 'Service charge', cents: 100, service: true, rateBp: null }); drawExtras(); billChanged(true); focusLast('#feeRows .fee'); };
    $('#addDisc').onclick = function () { if (state.bill.discounts.length >= C.LIMITS.discounts) return; ensureLocal(); state.bill.discounts.push({ id: C.shortId('d'), name: 'Discount', cents: 100 }); drawExtras(); billChanged(true); focusLast('#feeRows .disc'); };
  }
  function focusLast(sel) { var rows = $$(sel); var r = rows[rows.length - 1]; if (r) { var i = $('input', r); i.focus(); i.select(); } }

  function drawFeeRows(edit) {
    var b = state.bill;
    var el = $('#feeRows');
    function row(kind, f) {
      return '<div class="xrow ' + kind + '" data-fid="' + esc(f.id) + '">' +
        '<input class="input fname" maxlength="' + C.LIMITS.name + '" aria-label="' + (kind === 'fee' ? 'Fee' : 'Discount') + ' name" value="' + esc(f.name) + '"' + (edit ? '' : ' disabled') + '>' +
        '<span class="money' + (kind === 'disc' ? ' minus' : '') + '"><input class="input famt" inputmode="decimal" aria-label="Amount" value="' + esc(C.plain(f.cents)) + '"' + (edit ? '' : ' disabled') + '></span>' +
        (edit ? '<button type="button" class="x" aria-label="Remove">✕</button>' : '') + '</div>';
    }
    el.innerHTML = b.fees.map(function (f) { return row('fee', f); }).join('') + b.discounts.map(function (d) { return row('disc', d); }).join('');
    if (!edit) return;
    $$('[data-fid]', el).forEach(function (r) {
      var id = r.getAttribute('data-fid');
      var list = r.classList.contains('fee') ? state.bill.fees : state.bill.discounts;
      var f = itemIn(list, id);
      $('.fname', r).addEventListener('input', function (e) { f.name = C.clean(e.target.value, C.LIMITS.name) || f.name; if (list === state.bill.fees) f.service = /service|grat/i.test(f.name); billChanged(false); });
      $('.famt', r).addEventListener('input', function (e) { var c = C.toCents(e.target.value); if (c !== null && c > 0) { f.cents = c; billChanged(false); } });
      $('.x', r).onclick = function () { list.splice(list.indexOf(f), 1); drawExtras(); billChanged(true); };
    });
  }

  function drawSums(r) {
    var t = r.totals;
    var rows = [['Food & drink', t.items]];
    if (t.tax) rows.push(['Tax', t.tax]);
    if (t.fees) rows.push(['Fees', t.fees]);
    if (t.discounts) rows.push(['Discounts', -t.discounts]);
    rows.push(['Tip' + (state.bill.tip.mode === 'percent' ? ' (' + C.bpText(state.bill.tip.bp) + ')' : ''), t.tip]);
    $('#sums').innerHTML = rows.map(function (x) { return '<div><dt>' + esc(x[0]) + '</dt><dd>' + esc(m$(x[1])) + '</dd></div>'; }).join('') +
      '<div class="grand"><dt>Total</dt><dd>' + esc(m$(r.grand)) + '</dd></div>';
    var tn = $('#tipNow'); if (tn) tn.textContent = m$(t.tip) + (state.bill.tip.even ? ' · split evenly' : ' · split by what you had');
    var ck = C.check(state.bill);
    $('#check').innerHTML = ck.status === 'none' ? '' : '<p class="ck ' + (ck.status === 'ok' ? 'ok' : 'gap') + '">' + (ck.status === 'ok' ? '✓ ' : '⚠︎ ') + esc(ck.text) + '</p>';
  }

  /* ---------------- who owes whom ---------------- */

  function payNote() { return (state.bill.title || 'Dinner') + ' - via Dibs'; }

  function drawSettle(r) {
    var b = state.bill;
    var payer = person(b.payerId);
    var el = $('#owes');
    var paid = state.mode === 'table' ? (state.tablePaid || {}) : state.paid;
    var meId = state.mode === 'table' ? state.table.me : null;
    var rows = r.people.slice().sort(function (x, y) {
      if (x.id === meId) return -1; if (y.id === meId) return 1;
      if (x.id === b.payerId) return 1; if (y.id === b.payerId) return -1;
      return 0;
    });
    el.innerHTML = rows.map(function (row) {
      var p = person(row.id);
      var isPayer = row.id === b.payerId;
      var pm = paid[row.id];
      var status = isPayer ? '<span class="tag payer">Paid the bill</span>' : pm ? (pm.confirmed ? '<span class="tag ok">Paid ✓✓</span>' : '<span class="tag ok">Says paid ✓</span>') : '';
      var open = state.openRow === row.id;
      var html = '<li class="owe' + (row.id === meId ? ' me' : '') + '">' +
        '<button type="button" class="owe-row" data-row="' + esc(row.id) + '" aria-expanded="' + open + '">' + avatar(p) +
        '<span class="oname">' + esc(p.name) + (row.id === meId ? ' <i>(you)</i>' : '') + '<small>' + (isPayer ? 'own share' : !row.total ? 'nothing claimed yet' : payer ? 'owes ' + esc(payer.name) : 'share') + '</small></span>' +
        '<span class="oamt">' + esc(m$(row.total)) + '</span></button>' + status;
      if (open) {
        html += '<dl class="brk">' + row.lines.map(function (l) {
          var it = item(l.itemId); if (!it) return '';
          return '<div><dt>' + esc(it.name) + (l.everyone ? ' (everyone)' : l.shared ? ' (shared)' : '') + '</dt><dd>' + esc(m$(l.cents)) + '</dd></div>';
        }).join('') +
          (row.tax ? '<div><dt>Tax</dt><dd>' + esc(m$(row.tax)) + '</dd></div>' : '') +
          (row.fees ? '<div><dt>Fees</dt><dd>' + esc(m$(row.fees)) + '</dd></div>' : '') +
          (row.discounts ? '<div><dt>Discounts</dt><dd>' + esc(m$(-row.discounts)) + '</dd></div>' : '') +
          (row.tip ? '<div><dt>Tip</dt><dd>' + esc(m$(row.tip)) + '</dd></div>' : '') + '</dl>';
      }
      if (!isPayer && row.total > 0 && payer) {
        var links = C.payLinks(b.handles, row.total, payNote(), b.currency);
        var showPay = state.mode === 'table' ? row.id === meId : row.id === state.active;
        if (showPay && links.length) html += '<div class="pay">' + links.map(function (l) { return payButton(l, l.label + ' ' + payer.name + ' ' + m$(row.total), 'small'); }).join('') + '</div>';
        if (canActFor(row.id) && (state.mode !== 'sample')) {
          if (state.mode === 'table' && state.table.host && row.id !== meId && pm && !pm.confirmed) {
            html += '<div class="pay"><button type="button" class="btn small" data-confirm="' + esc(row.id) + '">Confirm ' + esc(p.name) + ' paid you</button></div>';
          } else {
            var lbl = state.mode === 'table' && row.id === meId ? 'I’ve paid ' + esc(payer.name) : esc(p.name) + ' has paid';
            html += '<label class="check paidbox"><input type="checkbox" data-paid="' + esc(row.id) + '"' + (pm ? ' checked' : '') + '> ' + lbl + '</label>';
          }
        }
      }
      return html + '</li>';
    }).join('');
    if (r.unclaimed.total > 0) el.innerHTML += '<li class="owe unc"><span class="owe-row static"><span class="av open-av" aria-hidden="true">?</span><span class="oname">Unclaimed<small>' + esc(r.unclaimed.open.length) + ' item' + (r.unclaimed.open.length === 1 ? '' : 's') + ' with its tax &amp; tip</small></span><span class="oamt">' + esc(m$(r.unclaimed.total)) + '</span></span></li>';
    $$('[data-row]', el).forEach(function (btn) { btn.onclick = function () { toggleRow(btn.getAttribute('data-row')); }; });
    $$('[data-confirm]', el).forEach(function (btn) {
      btn.onclick = function () { api('POST', 'api/table/' + state.table.code + '/paid', { pid: btn.getAttribute('data-confirm'), paid: true, confirmed: true }).then(applyTable).catch(tableError); };
    });
    $$('[data-paid]', el).forEach(function (box) {
      box.onchange = function () {
        var pid = box.getAttribute('data-paid');
        var on = box.checked;
        if (state.mode === 'table') {
          api('POST', 'api/table/' + state.table.code + '/paid', { pid: pid, paid: on, confirmed: state.table.host ? true : undefined }).then(applyTable).catch(tableError);
          return;
        }
        if (on) state.paid[pid] = { at: new Date().toISOString(), confirmed: true }; else delete state.paid[pid];
        refresh();
      };
    });
    var f = C.fairness(r, b.currency);
    $('#fair').innerHTML = f && !f.even ? '<span aria-hidden="true">⚖️</span> ' + esc(f.text) : f ? '<span aria-hidden="true">⚖️</span> ' + esc(f.text) : '';
    drawHandles(payer);
    drawSummary(r);
  }
  /** A pay button: a real https link to one of the three services - or, on
   *  the example, a look-alike that goes nowhere (its handle is made up). */
  function payButton(l, text, size) {
    if (state.mode === 'sample') return '<span class="btn ' + size + ' pay-' + esc(l.service) + ' fake" aria-disabled="true" title="The example’s pay link goes nowhere">' + esc(text) + ' <i>(example)</i></span>';
    var url = C.safePayUrl(l.url);
    return url ? '<a class="btn ' + size + ' pay-' + esc(l.service) + '" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(text) + '</a>' : '';
  }
  function toggleRow(pid) { state.openRow = state.openRow === pid ? null : pid; refresh(); }

  function drawHandles(payer) {
    var el = $('#handles');
    var h = C.handlesText(state.bill.handles);
    if (!payer) { el.innerHTML = canEditBill() || state.mode === 'sample' ? '<p class="small muted">Tap someone’s name above, then “paid the bill”, to see who owes them what.</p>' : ''; return; }
    var editable = canEditBill() && (state.mode === 'local' || (state.table && state.table.me === payer.id) || (state.table && state.table.host));
    el.innerHTML = '<div class="handles"><p class="small">' + (h ? 'Pay ' + esc(payer.name) + ': ' + esc(h) : esc(payer.name) + ' hasn’t added a pay link.') + '</p>' +
      (editable ? '<button type="button" class="btn small ghost" id="handlesBtn">' + (h ? 'Change pay links' : 'Add Venmo, Cash App or PayPal') + '</button>' : '') + '</div>';
    var btn = $('#handlesBtn');
    if (btn) btn.onclick = handlesSheet;
  }

  function handlesSheet() {
    var h = state.bill.handles;
    var payer = person(state.bill.payerId);
    sheet('<h2>How should people pay ' + esc(payer ? payer.name : 'you') + '?</h2><p class="small muted">Each person gets a button that opens the app with their amount filled in. Only the handle is kept - no account details, ever.</p>' +
      '<label class="field"><span>Venmo username</span><span class="pre">@<input class="input" id="hV" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sam-lee" value="' + esc(h.venmo) + '"></span></label>' +
      '<label class="field"><span>Cash App $cashtag</span><span class="pre">$<input class="input" id="hC" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="samlee" value="' + esc(h.cashapp) + '"></span></label>' +
      '<label class="field"><span>PayPal.me name</span><span class="pre">paypal.me/<input class="input" id="hP" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="samlee" value="' + esc(h.paypal) + '"></span></label>' +
      '<div id="hErr"></div><button class="btn block" type="button" id="hSave">Save</button>', function (root) {
      $('#hSave', root).onclick = function () {
        var raw = { venmo: $('#hV', root).value.trim(), cashapp: $('#hC', root).value.trim(), paypal: $('#hP', root).value.trim() };
        var bad = [];
        var out = {};
        [['venmo', 'Venmo usernames are 5-30 letters, numbers, - or _'], ['cashapp', 'A $cashtag is up to 20 letters and numbers'], ['paypal', 'A PayPal.me name is up to 20 letters and numbers']].forEach(function (k) {
          if (!raw[k[0]]) { out[k[0]] = ''; return; }
          var v = C.handleOf(k[0], raw[k[0]]);
          if (!v) bad.push(k[1]); else out[k[0]] = v;
        });
        if (bad.length) return showError({ message: bad.join('. ') + '.' }, $('#hErr', root));
        ensureLocal();
        state.bill.handles = out;
        closeSheet(); billChanged(true);
      };
    });
  }

  function drawSummary(r) {
    var el = $('#summaryBox');
    if (!r.people.some(function (p) { return p.total > 0; })) { el.innerHTML = ''; return; }
    var text = C.summary(state.bill, r);
    el.innerHTML = '<pre class="sumtext">' + esc(text) + '</pre><button type="button" class="btn block" id="shareSum">' + (navigator.share ? 'Send to the group chat' : 'Copy for the group chat') + '</button>';
    $('#shareSum').onclick = function () {
      if (navigator.share) navigator.share({ text: text }).catch(function () { /* cancelled */ });
      else copy(text, 'Summary copied');
    };
  }

  /* ---------------- sharing with the table ---------------- */

  function drawShare() {
    var el = $('#shareCard');
    if (state.mode === 'table') {
      var t = state.table;
      if (!t.host) { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = '<h2 id="shareH">Your table</h2><div class="qrwrap"><button type="button" class="qr" id="qrSmall" aria-label="Show the QR code full screen">' + QR.svg(tableLink(), 'QR code for table ' + t.display) + '</button>' +
        '<div><p class="bigcode">' + esc(t.display) + '</p><p class="small muted">Friends scan this, or open the link and type nothing else. No account needed. The table closes by itself after 14 days.</p></div></div>' +
        '<div class="row"><button type="button" class="btn small" id="lockBtn">' + (t.locked ? 'Unlock the bill' : 'Done - everyone pay up') + '</button>' +
        '<button type="button" class="btn small ghost danger" id="delBtn">Delete table</button></div>';
      $('#qrSmall').onclick = showQr;
      $('#lockBtn').onclick = function () { api('POST', 'api/tables/' + t.code + '/lock', { locked: !t.locked }).then(function (v) { applyTable(v); toast(v.locked ? 'Locked - nobody can change their dibs now' : 'Unlocked'); }).catch(tableError); };
      $('#delBtn').onclick = function () {
        if (!confirm('Delete this table for everyone? The bill stays on this phone.')) return;
        var keepIt = { bill: state.bill, people: state.people, claims: state.claims, everyone: state.everyone, paid: {}, active: state.active };
        api('DELETE', 'api/tables/' + t.code).then(function () { keep(K_LOCAL, keepIt); location.href = BASE; }).catch(tableError);
      };
      return;
    }
    el.hidden = false;
    el.innerHTML = '<h2 id="shareH">Share with the table</h2><p class="small">Everyone scans a QR code and taps what they had on their own phone - no app, no account for them. You’ll see their dibs arrive live.</p>' +
      '<button type="button" class="btn block" id="shareBtn">' + (state.mode === 'sample' ? 'Split your own bill first' : 'Share with the table') + '</button>' +
      '<p class="small muted">Or pass this phone round: tap a name above, then what they had.</p>';
    $('#shareBtn').onclick = state.mode === 'sample' ? startFlow : shareTable;
  }

  function shareTable() {
    if (!state.bill.items.length) return toast('Add at least one item first.');
    if (!signedIn()) return openAccount('Sharing a bill with the table needs a free account for you - so the table is yours to lock or delete. Your friends won’t need one. No AI is used, so it costs nothing.', shareTable);
    var btn = $('#shareBtn'); if (btn) btn.disabled = true;
    api('POST', 'api/tables', { bill: state.bill, people: state.people, claims: state.claims, everyone: state.everyone, hostPid: state.bill.payerId || state.active })
      .then(function (v) { keep(K_LOCAL, null); location.href = BASE + 't/' + v.code; })
      .catch(function (e) { if (btn) btn.disabled = false; showError(e); });
  }
  function tableLink() { return location.origin + BASE + 't/' + state.table.code; }
  function showQr() {
    var o = document.createElement('div');
    o.className = 'qr-big'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'Table QR code');
    o.innerHTML = '<button type="button" class="btn small ghost" id="qrClose">Close</button><div class="qrbox">' + QR.svg(tableLink(), 'QR code for table ' + state.table.display) + '</div><p class="code">' + esc(state.table.display) + '</p><p>Scan to call dibs on what you had.</p>';
    document.body.appendChild(o);
    var close = function () { o.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $('#qrClose', o).onclick = close;
    o.onclick = function (e) { if (e.target === o) close(); };
    $('#qrClose', o).focus();
  }

  /* ---------------- the sticky bar: what the active person owes ---------------- */

  function drawSticky(r) {
    var el = $('#sticky');
    var pid = state.mode === 'table' && !state.table.host ? state.table.me : state.active;
    var row = r.people.filter(function (x) { return x.id === pid; })[0];
    var payer = person(state.bill.payerId);
    if (!row || state.editing) { el.hidden = true; document.body.classList.remove('has-sticky'); return; }
    el.hidden = false; document.body.classList.add('has-sticky');
    var p = person(pid);
    var isPayer = pid === state.bill.payerId;
    var you = state.mode === 'table' && pid === state.table.me;
    var paid = (state.mode === 'table' ? state.tablePaid || {} : state.paid)[pid];
    var owed = r.grand - row.total - r.unclaimed.total;
    var line = isPayer && owed > 0 ? (you ? 'You’re owed' : esc(p.name) + ' is owed')
      : isPayer || !payer ? (you ? 'Your share' : esc(p.name) + '’s share')
      : (you ? 'You owe ' : esc(p.name) + ' owes ') + esc(payer.name);
    el.innerHTML = avatar(p) + '<div class="st-text"><span class="small">' + line + '</span><b>' + esc(m$(isPayer && owed > 0 ? owed : row.total)) + '</b></div>' +
      (!isPayer && payer && row.total > 0 ? '<button type="button" class="btn small' + (paid ? ' ghost' : '') + '" id="stPay">' + (paid ? 'Paid ✓' : 'Pay ' + esc(payer.name)) + '</button>' : '<button type="button" class="btn small ghost" id="stPay">Who owes whom</button>');
    $('#stPay').onclick = function () {
      if (!isPayer && payer && row.total > 0) return paySheet(row, p, payer);
      $('#settleCard').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    };
  }

  function paySheet(row, p, payer) {
    var b = state.bill;
    var links = C.payLinks(b.handles, row.total, payNote(), b.currency);
    var paid = (state.mode === 'table' ? state.tablePaid || {} : state.paid)[row.id];
    var canMark = canActFor(row.id) && state.mode !== 'sample';
    sheet('<h2>' + esc(p.name) + ' owes ' + esc(payer.name) + '</h2><p class="payamt">' + esc(m$(row.total)) + '</p>' +
      (links.length ? '<div class="paylinks">' + links.map(function (l) { return payButton(l, 'Pay ' + m$(row.total) + ' with ' + l.label, 'block'); }).join('') + '</div><p class="small muted">Opens ' + esc(links.map(function (l) { return l.label; }).join(' or ')) + ' with ' + esc(m$(row.total)) + ' filled in where it can. Check the name before you send.</p>'
        : '<p class="muted">' + esc(payer.name) + ' hasn’t added Venmo, Cash App or PayPal - pay them however you usually do.</p>') +
      '<button type="button" class="btn block ghost" id="copyAmt">Copy ' + esc(C.plain(row.total)) + '</button>' +
      (canMark ? '<button type="button" class="btn block' + (paid ? ' ghost' : '') + '" id="markPaid">' + (paid ? 'Paid ✓ - undo' : 'I’ve paid ' + esc(payer.name)) + '</button>' : ''), function (root) {
      $('#copyAmt', root).onclick = function () { copy(C.plain(row.total), 'Amount copied'); };
      var mp = $('#markPaid', root);
      if (mp) mp.onclick = function () {
        closeSheet();
        if (state.mode === 'table') return api('POST', 'api/table/' + state.table.code + '/paid', { pid: row.id, paid: !paid }).then(function (v) { applyTable(v); if (!paid) toast('Marked as paid - ' + payer.name + ' will see it'); }).catch(tableError);
        if (paid) delete state.paid[row.id]; else state.paid[row.id] = { at: new Date().toISOString(), confirmed: true };
        refresh();
      };
    });
  }

  /* ---------------- a bill changed (items, tax, tip, payer, handles) ---------------- */

  function billChanged(redrawExtras) {
    if (redrawExtras) drawExtras();
    refresh();
    if (state.mode === 'table' && state.table.host) {
      clearTimeout(state.saveTimer);
      state.saving = true;
      state.saveTimer = setTimeout(function () {
        api('PUT', 'api/tables/' + state.table.code, { bill: state.bill }).then(function (v) { state.saving = false; applyTable(v, true); }).catch(function (e) { state.saving = false; tableError(e); });
      }, 700);
    }
  }

  /* ---------------- the table: load, poll, apply ---------------- */

  function applyTable(v, keepInputs) {
    if (!v || v.same) return;
    var first = !state.table;
    state.mode = 'table';
    state.table = { code: v.code, display: v.display, v: v.v, locked: v.locked, me: v.me, host: v.host, expiresAt: v.expiresAt };
    state.tablePeople = v.people;
    state.tablePaid = v.paid || {};
    var typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && $('#billView').contains(document.activeElement);
    if (!(state.saving || (typing && keepInputs !== false && !first))) state.bill = C.cleanBill(v.bill);
    state.people = C.cleanPeople(v.people.map(function (p) { return { id: p.id, name: p.name, color: p.color }; }));
    state.claims = C.cleanClaims(v.claims, state.bill, state.people);
    state.everyone = C.cleanEveryone(v.everyone, state.bill);
    if (!v.host) state.active = v.me;
    else if (!person(state.active)) state.active = v.me;
    if (first) { drawAll(); if (!v.me && !v.host) askName(); return; }
    drawStrip();
    if (!typing && !state.editing) drawExtras();
    refresh();
  }
  function tableError(e) {
    if (e && e.status === 404) { stopPolling(); showGone(e); return; }
    showError(e);
    pollNow();
  }
  function showGone(e) {
    $('#billView').hidden = true;
    $('#sticky').hidden = true;
    var el = $('#strip');
    el.className = 'card gone';
    el.innerHTML = '<h1>That table’s gone</h1><p>' + esc((e && e.message) || 'No table has that code.') + '</p><p class="small muted">Check the code on the screen of whoever paid - or split a bill of your own.</p><a class="btn" href="' + esc(BASE) + '">Open Dibs</a>';
  }
  function loadTable() {
    return api('GET', 'api/table/' + TABLE_CODE).then(function (v) { applyTable(v); startPolling(); }).catch(function (e) {
      if (e.status === 404 || e.status === 429) return showGone(e);
      showError(e);
    });
  }
  function pollNow() {
    if (!state.table || state.pollBusy || document.hidden) return;
    state.pollBusy = true;
    api('GET', 'api/table/' + state.table.code + '?since=' + state.table.v).then(function (v) {
      state.pollBusy = false;
      if (v.same) return;
      if (!state.saving) applyTable(v);
    }).catch(function (e) { state.pollBusy = false; if (e.status === 404) { stopPolling(); showGone(e); } });
  }
  function startPolling() { stopPolling(); if (!document.hidden) state.polling = setInterval(pollNow, POLL_MS); }
  function stopPolling() { if (state.polling) clearInterval(state.polling); state.polling = null; }
  document.addEventListener('visibilitychange', function () {
    if (!state.table) return;
    if (document.hidden) stopPolling(); else { pollNow(); startPolling(); }
  });

  /** A guest's first screen: who are you? Nothing else in the way. */
  function askName() {
    var free = (state.tablePeople || []).filter(function (p) { return !p.joined; });
    var payer = person(state.bill.payerId);
    var colour = firstFreeColor();
    sheet('<div class="body"></div>', function draw(root) {
      $('.body', root).innerHTML = '<p class="eyebrow">' + esc(state.bill.title || 'The bill') + (payer ? ' · ' + esc(payer.name) + ' paid' : '') + '</p><h2>Which one is you?</h2>' +
        (free.length ? '<div class="pick">' + free.map(function (p) { return '<button type="button" class="chip person big" data-join="' + esc(p.id) + '" style="--c:' + esc(hex(p)) + '">' + avatar(p) + '<span class="pname">' + esc(p.name) + '</span></button>'; }).join('') + '</div><p class="small muted">Not there?</p>' : '') +
        '<label class="field"><span>' + (free.length ? 'Add your name' : 'Your name or an emoji') + '</span><input class="input" id="jName" maxlength="' + C.LIMITS.personName + '" autocomplete="given-name" placeholder="Ana"></label>' +
        '<div class="swatches" role="radiogroup" aria-label="Your colour">' + C.COLORS.map(function (c) { return '<button type="button" role="radio" class="sw" data-col="' + c.id + '" aria-checked="' + (c.id === colour) + '" aria-label="' + esc(c.label) + '" style="--c:' + c.hex + '"></button>'; }).join('') + '</div>' +
        '<div id="jErr"></div><button class="btn block big" type="button" id="jGo">Join the table</button><p class="small muted">No account, no app. Your name is only shown to this table.</p>';
      $$('[data-col]', root).forEach(function (b) { b.onclick = function () { colour = b.getAttribute('data-col'); $$('[data-col]', root).forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); }; });
      function go(body) {
        api('POST', 'api/table/' + state.table.code + '/join', body).then(function (v) { closeSheet(); applyTable(v); toast('You’re in - tap what you had', 3200); }).catch(function (e) { showError(e, $('#jErr', root)); });
      }
      $$('[data-join]', root).forEach(function (b) { b.onclick = function () { go({ pid: b.getAttribute('data-join') }); }; });
      $('#jGo', root).onclick = function () { go({ name: $('#jName', root).value, color: colour }); };
      $('#jName', root).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('#jGo', root).click(); } });
    }, { noClose: true });
  }

  /* ---------------- starting a bill: snap, or type/paste ---------------- */

  function startFlow() {
    state.flow = { step: 'choose' };
    drawAll();
    scrollTo(0, 0);
  }
  function endFlow() { state.flow = null; drawAll(); }

  function drawFlow() {
    var f = state.flow;
    var el = $('#flow');
    if (f.step === 'choose') {
      el.innerHTML = '<h1>Split a bill</h1><p class="muted">Get the receipt in, then everyone calls dibs on what they had.</p>' +
        '<div class="choices"><button type="button" class="choice" id="cSnap"><span class="ci" aria-hidden="true">📸</span><b>Snap the receipt</b><span class="small muted">AI reads every line for you · free account, uses a cent or two of your $2 credit</span></button>' +
        '<button type="button" class="choice" id="cType"><span class="ci" aria-hidden="true">⌨️</span><b>Type or paste it</b><span class="small muted">Free, no account · paste the text of an emailed receipt, or type a few lines</span></button></div>' +
        '<button type="button" class="link-btn" id="cBack">' + (recall(K_LOCAL) ? 'Back to my bill' : 'Back to the example') + '</button>';
      $('#cSnap').onclick = function () { state.flow = { step: 'snap', photos: [] }; drawFlow(); };
      $('#cType').onclick = function () { state.flow = { step: 'paste' }; drawFlow(); var b = $('#pasteBox'); if (b) b.focus(); };
      $('#cBack').onclick = function () { state.flow = null; boot(); };
      return;
    }
    if (f.step === 'paste') {
      el.innerHTML = '<button type="button" class="link-btn" id="fBack">← Back</button><h1>Type or paste it</h1>' +
        '<p class="small muted">One item per line with its price. “2 x Margarita 24.00” is two margaritas. Tax, tip and total lines are read too; card numbers and dates are skipped.</p>' +
        '<textarea class="input paste" id="pasteBox" rows="10" placeholder="Burrata 16.50&#10;2 x Margarita 24.00&#10;Ribeye 42.00&#10;Tax 18.95&#10;Total 101.45"></textarea>' +
        '<div class="row"><button type="button" class="btn" id="readBtn">Read it</button><button type="button" class="btn ghost" id="exampleBtn">Try an example receipt</button></div>' +
        '<button type="button" class="link-btn" id="blankBtn">Or start empty and add items one by one</button>';
      $('#fBack').onclick = function () { state.flow = { step: 'choose' }; drawFlow(); };
      $('#readBtn').onclick = function () {
        var text = $('#pasteBox').value;
        var p = C.parseReceipt(text);
        if (!p.items.length) return toast('No lines with a price in that yet. Try “Pizza 18.00”.', 3600);
        state.flow = { step: 'review', bill: C.billFromParsed(p), skipped: p.skipped, source: 'paste' };
        drawFlow(); scrollTo(0, 0);
      };
      $('#exampleBtn').onclick = function () { $('#pasteBox').value = S.RECEIPT; $('#readBtn').click(); };
      $('#blankBtn').onclick = function () { var b = C.blankBill(); b.items = [{ id: C.shortId('i'), name: 'First item', unit: 1000, qty: 1 }]; state.flow = { step: 'review', bill: C.cleanBill(b), skipped: [], source: 'blank' }; drawFlow(); };
      return;
    }
    if (f.step === 'snap') return drawSnap(el);
    if (f.step === 'review') return drawReview();
    if (f.step === 'people') return drawPeopleStep(el);
  }

  function drawSnap(el) {
    var f = state.flow;
    if (!signedIn()) {
      el.innerHTML = '<button type="button" class="link-btn" id="fBack">← Back</button><h1>Snap the receipt</h1><p class="muted">Reading a photo uses AI, so it needs a free account - it comes with $2 of credit, and a receipt costs a cent or two. Your friends never need one.</p>' +
        '<button type="button" class="btn block" id="sIn">Sign in or create a free account</button><button type="button" class="btn block ghost" id="sType">Type or paste it instead - free</button>';
      $('#fBack').onclick = function () { state.flow = { step: 'choose' }; drawFlow(); };
      $('#sIn').onclick = function () { openAccount(null, function () { drawFlow(); }); };
      $('#sType').onclick = function () { state.flow = { step: 'paste' }; drawFlow(); };
      return;
    }
    el.innerHTML = '<button type="button" class="link-btn" id="fBack">← Back</button><h1>Snap the receipt</h1>' +
      '<p class="small muted">Flat, close and well lit. A long receipt? Take it in two photos. The photos are read once and never stored.</p>' +
      '<div class="thumbs" id="thumbs">' + f.photos.map(function (p, i) { return '<figure><img alt="Receipt photo ' + (i + 1) + '" src="' + esc(p.url) + '"><button type="button" class="x" data-rm="' + i + '" aria-label="Remove photo ' + (i + 1) + '">✕</button></figure>'; }).join('') + '</div>' +
      (f.photos.length < C.LIMITS.photos ? '<label class="btn block ghost filebtn">' + (f.photos.length ? '+ Add the other half' : '📸 Take or choose a photo') + '<input type="file" accept="image/*" capture="environment" id="snapFile" class="vh"></label>' : '') +
      '<div id="snapOut"></div>' +
      '<button type="button" class="btn block" id="snapGo"' + (f.photos.length ? '' : ' disabled') + '>Read the receipt</button><p class="small muted center">Uses AI credit - usually a cent or two.</p>';
    $('#fBack').onclick = function () { state.flow = { step: 'choose' }; drawFlow(); };
    $$('[data-rm]', el).forEach(function (b) { b.onclick = function () { f.photos.splice(Number(b.getAttribute('data-rm')), 1); drawFlow(); }; });
    var inp = $('#snapFile');
    if (inp) inp.onchange = function () {
      var file = inp.files && inp.files[0]; if (!file) return;
      shrink(file).then(function (p) { f.photos.push(p); drawFlow(); }).catch(function () { toast('That photo could not be opened. Try a JPEG or PNG.'); });
    };
    $('#snapGo').onclick = function () {
      var btn = this; btn.disabled = true;
      var out = $('#snapOut');
      out.innerHTML = '<p class="busy" role="status"><span class="spin" aria-hidden="true"></span> Reading every line… this takes about 20 seconds.</p>';
      api('POST', 'api/snap', { photos: f.photos.map(function (p) { return { type: p.type, data: p.data }; }) }).then(function (res) {
        state.flow = { step: 'review', bill: C.cleanBill(res.bill), skipped: [], note: res.note, dropped: res.dropped, source: 'snap' };
        drawFlow(); scrollTo(0, 0);
      }).catch(function (e) {
        btn.disabled = false;
        if (e.status === 402 || e.status === 401) { out.innerHTML = ''; return showError(e); }
        if (e.data && e.data.code === 'verify-email') return verifyNote(out, e);
        showError(e, out);
      });
    };
  }

  /** A photo shrunk to ~1600px on its long side, as a JPEG. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, PHOTO_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var dataUrl = c.toDataURL('image/jpeg', 0.85);
        URL.revokeObjectURL(url);
        resolve({ type: 'image/jpeg', data: dataUrl.split(',')[1], url: dataUrl });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  /** What was read, editable, with the check - before it becomes the bill. */
  function drawReview() {
    var f = state.flow;
    var el = $('#flow');
    var b = f.bill;
    var n = b.items.length;
    var why = {};
    (f.skipped || []).forEach(function (s) { why[s.why] = (why[s.why] || 0) + 1; });
    el.innerHTML = '<button type="button" class="link-btn" id="fBack">← Back</button>' +
      '<h1>' + (f.source === 'blank' ? 'Add the items' : 'Check what was read') + '</h1>' +
      (f.source !== 'blank' ? '<p class="muted">' + esc(n) + ' item' + (n === 1 ? '' : 's') + (b.title ? ' from ' + esc(b.title) : '') + '. Hold it next to the receipt: fix anything that’s wrong, then carry on.</p>' : '') +
      (f.note ? '<p class="svc" role="note">The reader says: ' + esc(f.note) + '</p>' : '') +
      (f.dropped ? '<p class="small muted">' + esc(f.dropped) + ' line' + (f.dropped === 1 ? ' had' : 's had') + ' no price that could be read and ' + (f.dropped === 1 ? 'was' : 'were') + ' left out.</p>' : '') +
      '<label class="field"><span>What’s it for?</span><input class="input" id="rTitle" maxlength="' + C.LIMITS.title + '" placeholder="Dinner at Luigi’s" value="' + esc(b.title) + '"></label>' +
      '<div class="ehead small muted"><span>Qty</span><span>Item</span><span>Price</span></div><ul class="items" id="rItems"></ul>' +
      '<button type="button" class="btn small ghost" id="rAdd">+ Add a line</button>' +
      '<div class="rsum" id="rSum"></div>' +
      (f.skipped && f.skipped.length ? '<details class="skipped"><summary>Skipped ' + esc(f.skipped.length) + ' line' + (f.skipped.length === 1 ? '' : 's') + ' (' + esc(Object.keys(why).join(', ')) + ')</summary><ul>' + f.skipped.slice(0, 60).map(function (s) { return '<li><code>' + esc(s.line) + '</code> <span class="muted">' + esc(s.why) + '</span></li>'; }).join('') + '</ul></details>' : '') +
      '<button type="button" class="btn block big" id="rGo">Looks right - who’s splitting?</button>';
    $('#fBack').onclick = function () { state.flow = { step: f.source === 'snap' ? 'snap' : 'paste', photos: [] }; drawFlow(); };
    $('#rTitle').addEventListener('input', function (e) { b.title = C.clean(e.target.value, C.LIMITS.title); });
    drawEditRows($('#rItems'), b.items);
    $('#rAdd').onclick = function () { if (b.items.length >= C.LIMITS.items) return; b.items.push({ id: C.shortId('i'), name: 'New item', unit: 100, qty: 1 }); drawReview(); var rows = $$('#rItems .erow'); var last = rows[rows.length - 1]; if (last) { $('.name-in', last).focus(); $('.name-in', last).select(); } };
    $('#rGo').onclick = function () {
      f.bill = C.cleanBill(b);
      if (!f.bill.items.length) return toast('Add at least one item.');
      state.flow = { step: 'people', bill: f.bill, people: [] };
      drawFlow(); scrollTo(0, 0);
      var i = $('#npName'); if (i) i.focus();
    };
    drawReviewCheck();
  }
  function drawReviewCheck() {
    var f = state.flow; if (!f || f.step !== 'review') return;
    var b = C.cleanBill(f.bill);
    var t = C.totals(b);
    var ck = C.check(b);
    var el = $('#rSum'); if (!el) return;
    el.innerHTML = '<dl class="sums"><div><dt>Items</dt><dd>' + esc(C.money(t.items, b.currency)) + '</dd></div>' +
      (t.tax ? '<div><dt>Tax</dt><dd>' + esc(C.money(t.tax, b.currency)) + '</dd></div>' : '') +
      b.fees.map(function (x) { return '<div><dt>' + esc(x.name) + '</dt><dd>' + esc(C.money(x.cents, b.currency)) + '</dd></div>'; }).join('') +
      b.discounts.map(function (x) { return '<div><dt>' + esc(x.name) + '</dt><dd>' + esc(C.money(-x.cents, b.currency)) + '</dd></div>'; }).join('') +
      (b.tip.onReceipt ? '<div><dt>Tip on the receipt</dt><dd>' + esc(C.money(t.tip, b.currency)) + '</dd></div>' : '') +
      (b.printed.total !== null ? '<div class="grand"><dt>Receipt says</dt><dd>' + esc(C.money(b.printed.total, b.currency)) + '</dd></div>' : '') + '</dl>' +
      (ck.status === 'none' ? '<p class="small muted">No printed total to check against - add tax and tip on the next screen.</p>' : '<p class="ck ' + (ck.status === 'ok' ? 'ok' : 'gap') + '">' + (ck.status === 'ok' ? '✓ ' : '⚠︎ ') + esc(ck.text) + '</p>') +
      (C.serviceNote(b) ? '<p class="svc">' + esc(C.serviceNote(b)) + '</p>' : '') +
      '<p class="small muted">Tax, tip and fees can be changed on the next screen.</p>';
  }

  function drawPeopleStep(el) {
    var f = state.flow;
    var colour = null;
    el.innerHTML = '<button type="button" class="link-btn" id="fBack">← Back</button><h1>Who’s splitting?</h1><p class="muted">Add everyone at the table - you first. Friends who join by QR code can add themselves too.</p>' +
      '<div class="people" id="npList">' + f.people.map(function (p, i) { return '<span class="chip person on" style="--c:' + esc(C.colorHex(p.color)) + '">' + avatar(p) + '<span class="pname">' + esc(p.name) + (i === f.payer ? ' <i>paid</i>' : '') + '</span><button type="button" class="x inchip" data-rmp="' + i + '" aria-label="Remove ' + esc(p.name) + '">✕</button></span>'; }).join('') + '</div>' +
      '<div class="addrow"><input class="input" id="npName" maxlength="' + C.LIMITS.personName + '" autocomplete="off" placeholder="' + (f.people.length ? 'Next name' : 'Your name') + '" aria-label="Name"><button type="button" class="btn" id="npAdd">Add</button></div>' +
      (f.people.length > 1 ? '<div class="field"><span id="payLbl">Who paid the bill?</span><div class="chips" role="radiogroup" aria-labelledby="payLbl">' + f.people.map(function (p, i) { return '<button type="button" class="chip" role="radio" data-payer="' + i + '" aria-checked="' + (i === f.payer) + '">' + esc(p.name) + '</button>'; }).join('') + '</div></div>' : '') +
      '<button type="button" class="btn block big" id="npGo"' + (f.people.length ? '' : ' disabled') + '>Start calling dibs →</button>' +
      '<p class="small muted center">You can add or change people later.</p>';
    $('#fBack').onclick = function () { state.flow = { step: 'review', bill: f.bill, skipped: [], source: 'back' }; drawFlow(); };
    function add() {
      var n = C.cleanName($('#npName').value);
      if (!n) return;
      if (f.people.length >= C.LIMITS.people) return toast('Up to ' + C.LIMITS.people + ' people.');
      var taken = f.people.map(function (p) { return p.color; });
      var col = C.COLOR_IDS.filter(function (c) { return taken.indexOf(c) < 0; })[0] || C.COLOR_IDS[0];
      f.people.push({ id: C.shortId('p'), name: n, color: colour || col });
      if (f.payer === undefined) f.payer = 0;
      drawFlow();
      $('#npName').focus();
    }
    $('#npAdd').onclick = add;
    $('#npName').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    $$('[data-rmp]', el).forEach(function (b) { b.onclick = function () { var i = Number(b.getAttribute('data-rmp')); f.people.splice(i, 1); if (f.payer >= f.people.length) f.payer = 0; drawFlow(); }; });
    $$('[data-payer]', el).forEach(function (b) { b.onclick = function () { f.payer = Number(b.getAttribute('data-payer')); drawFlow(); }; });
    $('#npGo').onclick = function () {
      var bill = f.bill;
      bill.payerId = (f.people[f.payer || 0] || {}).id || null;
      state.flow = null;
      setLocal({ bill: bill, people: f.people, claims: {}, everyone: {}, paid: {}, active: bill.payerId }, 'local');
      saveLocal();
      toast('Now tap what ' + ((f.people[0] || {}).name || 'you') + ' had', 3200);
      scrollTo(0, 0);
    };
  }

  /* ---------------- account ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Account' : 'Sign in';
    b.onclick = function () { if (signedIn()) openSettings(); else openAccount(); };
    $('#tablesBtn').hidden = !signedIn();
    $('#tablesBtn').onclick = openTables;
  }

  var lastFocus = null;
  function sheet(html, onOpen, opts) {
    var s = $('#sheet'), back = $('#sheetBack');
    lastFocus = document.activeElement;
    var closable = !(opts && opts.noClose);
    s.innerHTML = (closable ? '<button class="btn small ghost close" type="button" id="sheetClose" aria-label="Close">Close</button>' : '') + html;
    s.hidden = false; back.hidden = false;
    s.classList.toggle('pinned', !closable);
    if (closable) $('#sheetClose').onclick = closeSheet;
    back.onclick = closable ? closeSheet : null;
    if (onOpen) onOpen(s);
    var f = s.querySelector('input:not(.vh):not([type=checkbox]), textarea') || s.querySelector('button:not(.close)') || $('#sheetClose');
    setTimeout(function () { try { if (f) f.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden && !$('#sheet').classList.contains('pinned')) closeSheet(); });

  var FREE_LINE = 'Splitting a bill on this phone is free and needs no account. A free account lets you share a bill with the table (your friends never need one) and snap receipts with AI - it comes with $2 of credit. One account works across every app on this site.';

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
        '<p class="small muted center" style="margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).onclick = function () { mode = mode === 'register' ? 'login' : 'register'; draw(root); };
      $('#authForm', root).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); if (then) then(); else if (TABLE_CODE) loadTable(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(function () { if (then) then(); })
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      };
    }
    sheet('<div class="body"></div>', draw);
  }

  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(
      '<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div>' +
      '<p class="small muted" style="margin:6px 0 0">Snapping a receipt costs a cent or two. Splitting and sharing are free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); if (state.mode === 'table') location.reload(); });
        };
        var pk = $('#pkEnrol', root);
        if (pk) pk.onclick = function () {
          var pw = prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        };
      });
  }
  function drawBilling(el) {
    api('GET', 'api/auth/billing').then(function (b) {
      if (b.elsewhere) { el.innerHTML = '<a class="btn small ghost" href="' + esc(b.elsewhere) + '">Add credit</a>'; return; }
      if (!b.available) { el.innerHTML = ''; return; }
      if (!b.member) {
        el.innerHTML = '<button class="btn small" type="button" id="joinM">Become a member · $' + esc(b.monthlyUsd) + '/mo</button><p class="small muted">Membership covers every app on this site, runs the better model and lets you add credit.</p>';
        $('#joinM', el).onclick = function () { checkout('api/auth/billing/membership', {}); };
        return;
      }
      el.innerHTML = '<div class="row">' + (b.topUps || []).map(function (t) { return '<button class="btn small ghost" type="button" data-usd="' + esc(t.usd) + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
      $$('[data-usd]', el).forEach(function (btn) { btn.onclick = function () { checkout('api/auth/billing/credit', { usd: Number(btn.getAttribute('data-usd')) }); }; });
    }).catch(function () { el.innerHTML = ''; });
  }
  function checkout(path, body) {
    body.returnTo = BASE;
    api('POST', path, body).then(function (r) { if (r.url) location.href = r.url; }).catch(function (e) { showError(e); });
  }
  function openCredit(data) {
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">Typing or pasting a receipt, splitting it and sharing it with the table keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  function openTables() {
    sheet('<h2>My tables</h2><div id="tList"><p class="busy">Loading…</p></div>', function (root) {
      api('GET', 'api/tables').then(function (r) {
        var el = $('#tList', root);
        if (!r.tables.length) { el.innerHTML = '<p class="muted">No tables yet. Split a bill, then “Share with the table”.</p>'; return; }
        el.innerHTML = '<ul class="tlist">' + r.tables.map(function (t) {
          return '<li><a href="' + esc(BASE + 't/' + t.code) + '"><b>' + esc(t.title) + '</b><span class="small muted">' + esc(t.display) + ' · ' + esc(t.people) + ' people · ' + esc(C.money(t.grand, t.currency)) + (t.unclaimed ? ' · ' + esc(C.money(t.unclaimed, t.currency)) + ' unclaimed' : '') + (t.locked ? ' · locked' : '') + '</span></a></li>';
        }).join('') + '</ul><p class="small muted">Tables close by themselves 14 days after they’re made.</p>';
      }).catch(function (e) { showError(e, $('#tList', root)); });
    });
  }

  /* ---------------- start ---------------- */

  function boot() {
    var local = recall(K_LOCAL);
    if (local && local.bill && Array.isArray(local.people)) setLocal(local, 'local');
    else samplePlay();
  }

  drawTop();
  if (TABLE_CODE) {
    // A guest's link: straight to the table's claim screen, name prompt first.
    $('#billView').hidden = true;
    $('#strip').innerHTML = '<p class="busy" role="status">Finding the table…</p>';
    loadMe().then(loadTable);
  } else {
    boot();
    loadMe().then(function () {
      if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
    });
  }
})();
