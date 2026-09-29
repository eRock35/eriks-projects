/* Hike - the page. One file, no build step. Every string that came from
 * outside this file (a model's draft, a snapped menu, a saved plan, a typed
 * name) is escaped before it is drawn, and no handler is written into markup
 * (the lab's CSP allows script from this origin only). The sums are
 * hike-core.js, the same file the server and the tests run. */
(function () {
  'use strict';

  var C = window.HikeCore;
  var S = window.HikeSample;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_DRAFT = 'hike-draft-v1';
  var K_OPEN = 'hike-open-v1';
  var PHOTO_PX = 1600;

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parts(p) { return (p || []).map(function (x) { return x.b !== undefined ? '<b>' + esc(x.b) + '</b>' : esc(x.t); }).join(''); }
  function partsText(p) { return (p || []).map(function (x) { return x.b !== undefined ? x.b : x.t; }).join(''); }
  function newId() { return 'l' + Math.random().toString(36).slice(2, 10); }

  var state = {
    me: null,
    kind: 'sample',     // 'sample' | 'local' (this device only) | 'saved'
    id: null,           // a saved plan's id
    plan: null,         // the plan being worked on (the cleaned shape; the tracker as typed text)
    dirty: false,
    saving: false,
    board: 'after',
    show: 'ai',         // which announcement is on screen when an AI draft exists
    replaced: [],
    announcing: false,
    snap: [],           // [{name, type, data, url}]
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // The two AI routes stream whitespace and so answer 200 even on
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
  function sym() { return C.symbolOf(state.plan.settings.currency); }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  /** The 403 an unconfirmed free account gets, with its resend button. */
  function verifyNote(where, e, what) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then come back and ' + esc(what) + ' again. Nothing you typed is lost - and the free templates work meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).onclick = function () {
      var b = this; b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    };
  }

  /* ---------------- the plan ---------------- */

  /** A cleaned plan as the page edits it: tracker values as typed text. */
  function forPage(p) {
    var plan = C.cleanPlan(p, today());
    var rev = plan.tracker.mode === 'revenue';
    var raw = (p && p.tracker) || {};
    // Keep what was typed when it came from this page; numbers become text.
    plan.tracker = {
      mode: plan.tracker.mode,
      baseline: typeof raw.baseline === 'string' ? raw.baseline : plan.tracker.baseline === null ? '' : (rev ? C.plainMoney(plan.tracker.baseline) : C.groups(plan.tracker.baseline)),
      entries: (Array.isArray(raw.entries) ? raw.entries : []).slice(0, C.LIMITS.tracker).map(function (e) {
        var v = e && e.value;
        return { week: C.isoDay(e && e.week) || '', value: typeof v === 'string' ? v : typeof v === 'number' ? (rev ? C.plainMoney(v) : C.groups(v)) : '' };
      }),
    };
    return plan;
  }
  function samplePlan() { return forPage(S.plan(today())); }
  function blankPlan() {
    var t = today();
    return forPage({
      name: '', meter: { unit: 'customers', costMode: 'cost', whatIf: 50 }, lines: [], settings: { target: 800, style: 'cafe', holdUnder: true },
      rollout: { notice: t, effective: C.addDays(t, 30), grandfatherWeeks: 0 }, announce: { tone: 'warm' }, tracker: { mode: 'units', baseline: '', entries: [] },
    });
  }

  function setPlan(plan, kind, id) {
    state.plan = plan; state.kind = kind; state.id = id || null; state.dirty = false;
    state.show = 'ai'; state.replaced = [];
    keep(K_OPEN, kind === 'saved' ? { id: id } : null);
    fillAll();
    drawAll();
  }

  var saveTimer = null;
  /** Something changed: keep it on this device, and a saved plan saves itself. */
  function changed() {
    if (state.kind === 'sample') return;
    keep(K_DRAFT, { plan: state.plan, kind: state.kind, id: state.id, at: new Date().toISOString() });
    if (state.kind === 'saved') {
      state.dirty = true; drawIntro();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(savePlan, 1200);
    } else drawIntro();
  }

  function savePlan() {
    if (!signedIn()) return openAccount('Saving a plan to come back to needs a free account. Your plan stays on this device meanwhile.');
    if (state.saving) { clearTimeout(saveTimer); saveTimer = setTimeout(savePlan, 800); return; }
    state.saving = true; drawIntro();
    var req = state.kind === 'saved' ? api('PUT', 'api/plans/' + encodeURIComponent(state.id), state.plan) : api('POST', 'api/plans', state.plan);
    req.then(function (r) {
      state.saving = false;
      var first = state.kind !== 'saved';
      state.kind = 'saved'; state.id = r.plan.id; state.dirty = false;
      if (first) { state.plan.name = r.plan.name; keep(K_OPEN, { id: r.plan.id }); toast('Saved to your account'); }
      keep(K_DRAFT, { plan: state.plan, kind: 'saved', id: state.id, at: new Date().toISOString() });
      drawIntro();
    }).catch(function (e) { state.saving = false; drawIntro(); showError(e); });
  }

  /* ---------------- the top of the page ---------------- */

  function drawIntro() {
    var el = $('#intro');
    if (state.kind === 'sample') {
      el.className = 'intro';
      el.innerHTML = '<p><b>This is an example café</b> - try the sliders, then make it yours.</p><button class="btn small" type="button" id="startOwn">Start my own</button>';
      $('#startOwn').onclick = startOwn;
      return;
    }
    el.className = 'intro mine';
    var name = state.plan.name || (state.plan.announce.business ? state.plan.announce.business + ' price rise' : 'My price rise');
    var status = state.kind === 'local'
      ? (signedIn() ? 'On this device only' : 'Kept on this device · sign in to save it')
      : (state.saving ? 'Saving…' : state.dirty ? 'Unsaved changes' : 'Saved');
    el.innerHTML = '<p><span class="plan-name">' + esc(name) + '</span><br><span class="status">' + esc(status) + '</span></p>' +
      (state.kind === 'local' ? '<button class="btn small" type="button" id="saveIt">' + (signedIn() ? 'Save to my account' : 'Sign in to save') + '</button>' : '') +
      '<button class="btn small ghost" type="button" id="toSample">See the example</button>';
    var s = $('#saveIt'); if (s) s.onclick = savePlan;
    $('#toSample').onclick = function () { setPlan(samplePlan(), 'sample'); window.scrollTo(0, 0); };
  }

  function startOwn() {
    var had = recall(K_DRAFT);
    if (had && had.plan && had.kind === 'local' && (had.plan.lines || []).length && !confirm('Start a new plan? The one on this device will be replaced. (Sign in to save plans you want to keep.)')) return;
    setPlan(blankPlan(), 'local');
    changed();
    openPaste(true);
  }

  /* ---------------- the break-even meter ---------------- */

  function fillMeter() {
    var m = state.plan.meter;
    $('#mPrice').value = m.price; $('#mCost').value = m.cost; $('#mMargin').value = m.margin; $('#mVolume').value = m.volume; $('#mNew').value = m.newPrice;
    $('#mUnit').innerHTML = C.UNITS.map(function (u) { return '<option value="' + u + '"' + (u === m.unit ? ' selected' : '') + '>' + esc(u.charAt(0).toUpperCase() + u.slice(1)) + '/mo</option>'; }).join('');
    $('#mUnit').value = m.unit;
    drawCostMode();
    document.documentElement.style.setProperty('--sym', '"' + sym() + '"');
  }
  function drawCostMode() {
    var margin = state.plan.meter.costMode === 'margin';
    $('#costWrap').hidden = margin; $('#marginWrap').hidden = !margin;
    $('#costLbl').textContent = margin ? 'Margin' : 'Cost per sale';
    $('#costMode').textContent = margin ? 'use cost instead' : 'use margin %';
  }

  function meterNow() { return C.breakEven(C.meterFrom(state.plan.meter), sym()); }

  function drawMeter() {
    var m = C.meterFrom(state.plan.meter);
    var be = C.breakEven(m, sym());
    var h = $('#headline');
    h.innerHTML = parts(be.parts);
    h.className = 'headline' + (be.status === 'ok' ? '' : ' quiet');
    // 1 in N, drawn: N dots, one of them gone.
    var dots = $('#dots');
    if (be.oneIn && be.oneIn <= 24) {
      var html = '';
      for (var i = 0; i < be.oneIn; i++) html += '<i' + (i === be.oneIn - 1 ? ' class="lost"' : '') + '></i>';
      dots.innerHTML = html;
    } else dots.innerHTML = '';
    $('#working').textContent = be.working || 'Enter your price now, what each sale costs you and your new price, and the working shows here.';

    // The new-price slider: from today's price to 40% over it.
    var r = $('#newRange');
    if (m.price) {
      var step = m.price < 2000 ? 5 : m.price < 10000 ? 25 : 100;
      var max = Math.max(Math.ceil(m.price * 1.4 / step) * step, m.newPrice || 0);
      r.disabled = false; r.min = String(m.price); r.max = String(max); r.step = String(step);
      var v = m.newPrice !== null && m.newPrice >= m.price ? m.newPrice : m.price;
      r.value = String(v);
      r.style.setProperty('--pos', ((v - m.price) * 100 / (max - m.price)) + '%');
      var pct = m.newPrice ? ' - ' + (m.newPrice >= m.price ? '' : 'a cut of ') + C.bpText(Math.abs(Math.round((m.newPrice - m.price) * 10000 / m.price))) + (m.newPrice >= m.price ? ' more' : '') : '';
      r.setAttribute('aria-valuetext', (m.newPrice ? C.money(m.newPrice, sym()) : C.money(m.price, sym())) + pct);
    } else { r.disabled = true; r.style.setProperty('--pos', '0%'); r.setAttribute('aria-valuetext', 'Enter your price now first'); }
    drawRaiseChips(m);

    // What if I lose ___%?
    var lr = $('#lossRange');
    var ok = be.status === 'ok' && be.lossPm !== null && m.volume;
    lr.disabled = !ok;
    var maxLoss = ok ? Math.min(500, Math.max(100, Math.ceil(be.lossPm * 2 / 50) * 50)) : 200;
    lr.max = String(maxLoss);
    var loss = state.plan.meter.whatIf === null || state.plan.meter.whatIf === undefined ? 50 : Math.min(state.plan.meter.whatIf, maxLoss);
    lr.value = String(loss);
    $('#lossOut').textContent = C.pmText(loss);
    var d = $('#deltaOut');
    if (ok) {
      var pc = C.profitChange(be, loss, sym());
      d.textContent = pc.text;
      d.className = 'delta ' + (pc.sign > 0 ? 'up' : pc.sign < 0 ? 'down' : '');
      lr.style.setProperty('--be', Math.min(100, be.lossPm * 100 / maxLoss) + '%');
      lr.setAttribute('aria-valuetext', 'Lose ' + C.pmText(loss) + ' of ' + be.unit + ': ' + pc.text + '. Break-even is ' + C.pmText(be.lossPm) + '.');
      var at = Math.min(100, be.lossPm * 100 / maxLoss);
      $('#lossScale').innerHTML = '<span>0%</span><span class="be" style="left:' + at.toFixed(1) + '%">break-even ' + esc(C.pmText(be.lossPm)) + '</span><span class="end">' + esc(C.pmText(maxLoss)) + '</span>';
    } else {
      d.textContent = ''; d.className = 'delta';
      lr.style.setProperty('--be', '100%');
      lr.setAttribute('aria-valuetext', 'Needs your cost per sale and sales a month');
      $('#lossScale').innerHTML = '<span>' + esc(be.status === 'ok' ? 'Add your ' + be.unit + ' a month to see it in dollars.' : 'Needs a price, a cost and a new price above today’s.') + '</span>';
    }
  }
  function drawRaiseChips(m) {
    var el = $('#raiseChips');
    if (!m.price) { el.innerHTML = ''; return; }
    var pl = C.priceList(state.plan.lines, state.plan.settings);
    var opts = [500, 800, 1000, 1500].map(function (bp) { return { bp: bp, label: '+' + C.bpText(bp) }; });
    if (pl.blended && pl.blended.bp > 0) opts.push({ bp: pl.blended.bp, label: 'My list: +' + C.bpText(Math.round(pl.blended.bp / 10) * 10) });
    el.innerHTML = opts.map(function (o) {
      var price = Math.round(m.price * (10000 + o.bp) / 10000);
      return '<button class="chip" type="button" data-price="' + price + '" aria-pressed="' + (m.newPrice === price) + '">' + esc(o.label) + '</button>';
    }).join('');
    $$('[data-price]', el).forEach(function (b) {
      b.onclick = function () { setNewPrice(Number(b.getAttribute('data-price'))); };
    });
  }
  function setNewPrice(cents) {
    state.plan.meter.newPrice = C.plainMoney(cents).replace(/^(\d+)$/, '$1.00').replace(/(\.\d)$/, '$10');
    $('#mNew').value = state.plan.meter.newPrice;
    drawMeter(); drawTracker(); changed();
  }

  /* ---------------- the price list ---------------- */

  function fillList() {
    var s = state.plan.settings;
    $('#target').value = C.bpText(s.target).replace('%', '');
    $('#style').innerHTML = C.STYLES.map(function (st) { return '<option value="' + st.id + '"' + (st.id === s.style ? ' selected' : '') + '>' + esc(st.label) + '</option>'; }).join('');
    $('#holdUnder').checked = s.holdUnder;
  }

  function priced() { return C.priceList(state.plan.lines, state.plan.settings); }

  function drawList() {
    var pl = priced(), S$ = sym();
    var fmt = C.priceFormat(pl.rows, S$);
    var sum = $('#listSummary');
    if (!pl.rows.length) {
      sum.hidden = true;
      $('#rows').innerHTML = '<p class="empty">No prices yet. Paste your list, snap the menu or add a line - Hike rounds each one and keeps it under the round numbers.</p>';
      $('#boardWrap').hidden = true;
      return;
    }
    sum.hidden = false;
    var b = pl.blended, c = pl.counts;
    var html = '<div class="row" style="gap:4px 10px"><span class="big">' + esc(C.bpText(Math.round(b.bp / 10) * 10)) + '</span><span class="vs">blended raise · target ' + esc(C.bpText(b.target)) + '</span></div>' +
      '<p class="small muted">' + (b.weighted ? 'Weighted by each line’s sales a month.' : 'A simple average - add sales a month to every line to weight it by what sells.') +
      ' ' + c.raised + ' raised' + (c.locked ? ' · ' + c.locked + ' kept' : '') + (c.held ? ' · ' + c.held + ' held under a round number' : '') + (c.crosses ? ' · ' + c.crosses + ' crossing one' : '') + '.</p>';
    if (pl.list && pl.list.lossPm !== null) {
      html += '<p>Across the list you could lose up to <b>' + (pl.list.oneIn ? '1 in ' + pl.list.oneIn : 'under 0.1%') + '</b> sales (' + esc(C.pmText(pl.list.lossPm)) + ') and still make more. If nobody leaves: <b>+' + esc(C.dollars(pl.list.gain, S$, 'down')) + ' a month</b>.</p>';
    } else if (!pl.list) {
      html += '<p class="small muted">Add a cost and sales a month to every line to see the break-even for the whole list.</p>';
    }
    if (b.bp + 50 < b.target) {
      var t = C.targetFor(state.plan.lines, state.plan.settings, b.target);
      html += '<p class="tip">Rounding and kept prices pull it under your target.' + (t && t !== b.target ? ' To reach ' + esc(C.bpText(b.target)) + ' overall with this rounding, <button class="link-btn tiny" type="button" id="useTarget" data-t="' + t + '">set the target to ' + esc(C.bpText(t)) + '</button>.' : '') + '</p>';
    }
    if (b.bp > b.target + 200) {
      var top = pl.rows.filter(function (r) { return !r.manual && !r.locked; }).sort(function (x, y) { return y.pctBp - x.pctBp; })[0];
      if (top && top.pctBp > b.target + 300) html += '<p class="tip">This rounding pushes it over your target - ' + esc(top.name) + ' goes up ' + esc(C.bpText(Math.round(top.pctBp / 10) * 10)) + '. Try a finer rounding, or tap a line to set its price by hand.</p>';
    }
    sum.innerHTML = html;
    var ut = $('#useTarget'); if (ut) ut.onclick = function () { state.plan.settings.target = Number(ut.getAttribute('data-t')); fillList(); listChanged(); };

    var out = [], sec;
    pl.rows.forEach(function (r) {
      if (r.section && r.section !== sec) { out.push('<div class="sechead">' + esc(r.section) + '</div>'); sec = r.section; }
      var flags = [];
      if (r.locked) flags.push('<span class="tag locked">Kept at ' + esc(fmt(r.old)) + '</span>');
      if (r.held) flags.push('<span class="tag held">Held under ' + esc(C.money(r.held, S$, true)) + '</span><button class="link-btn tiny" type="button" data-cross="' + esc(r.id) + '">Let it go to ' + esc(fmt(r.target)) + '</button>');
      if (r.crosses) flags.push('<span class="tag cross">Crosses ' + esc(C.money(r.crosses, S$, true)) + '</span>' + (r.hold === false ? '<button class="link-btn tiny" type="button" data-hold="' + esc(r.id) + '">Hold it under</button>' : r.noRoom ? '<span class="small muted">no room under it</span>' : ''));
      if (r.manual) flags.push('<span class="tag">Set by hand</span>');
      out.push('<div class="line">' +
        '<button class="lock" type="button" data-lock="' + esc(r.id) + '" aria-pressed="' + r.locked + '" aria-label="' + esc((r.locked ? 'Unlock ' : 'Keep the price of ') + r.name) + '" title="' + (r.locked ? 'Kept at today’s price - tap to raise it' : 'Keep this price') + '">' + (r.locked ? '🔒' : '🔓') + '</button>' +
        '<button class="open" type="button" data-edit="' + esc(r.id) + '" aria-label="' + esc('Edit ' + r.name + ': ' + fmt(r.old) + (r.change ? ' to ' + fmt(r.price) : ', kept')) + '">' +
        '<span class="nm">' + esc(r.name) + '</span>' +
        '<span class="px">' + (r.change ? '<span class="old">' + esc(fmt(r.old)) + ' →</span> <span class="new">' + esc(fmt(r.price)) + '</span><span class="chg">+' + esc(C.changeText(r.change, S$)) + ' · ' + esc(C.bpText(Math.round(r.pctBp / 10) * 10)) + '</span>' : '<span class="new">' + esc(fmt(r.old)) + '</span><span class="chg">no change</span>') + '</span>' +
        '</button>' +
        (flags.length ? '<div class="flags over">' + flags.join('') + '</div>' : '') +
        '</div>');
    });
    $('#rows').innerHTML = out.join('');
    $$('[data-lock]').forEach(function (btn) { btn.onclick = function () { var l = lineById(btn.getAttribute('data-lock')); l.locked = !l.locked; listChanged(); focusAfter('[data-lock="' + l.id + '"]'); }; });
    $$('[data-edit]').forEach(function (btn) { btn.onclick = function () { editLine(btn.getAttribute('data-edit')); }; });
    $$('[data-cross]').forEach(function (btn) { btn.onclick = function () { lineById(btn.getAttribute('data-cross')).hold = false; listChanged(); }; });
    $$('[data-hold]').forEach(function (btn) { btn.onclick = function () { lineById(btn.getAttribute('data-hold')).hold = true; listChanged(); }; });
    $('#boardWrap').hidden = false;
    drawBoard(pl);
  }
  function focusAfter(sel) { var t = document.querySelector(sel); if (t) try { t.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  function lineById(id) { return state.plan.lines.filter(function (l) { return l.id === id; })[0]; }
  function listChanged() { drawList(); drawMeter(); drawPieces(); drawSummaryField(); changed(); }

  function boardTitle() { return state.plan.announce.business || (state.kind === 'sample' ? S.BUSINESS : 'Price list'); }
  function drawBoard(pl) {
    var fmt = C.priceFormat(pl.rows, sym()), after = state.board === 'after', out = [], sec;
    out.push('<p class="title">' + esc(boardTitle()) + '</p>');
    pl.rows.forEach(function (r) {
      if (r.section && r.section !== sec) { out.push('<h4>' + esc(r.section) + '</h4>'); sec = r.section; }
      out.push('<div class="bl"><span>' + esc(r.name) + '</span><span class="d"></span><span class="p' + (after && r.change ? ' moved' : '') + '">' + esc(fmt(after ? r.price : r.old)) + '</span></div>');
    });
    $('#board').innerHTML = out.join('');
    $('#board').setAttribute('aria-label', (after ? 'After: ' : 'Before: ') + 'the menu board');
    $$('[data-board]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-board') === state.board)); });
  }
  function printList() {
    var pl = priced(), fmt = C.priceFormat(pl.rows, sym()), out = ['<h1>' + esc(boardTitle()) + '</h1>'], sec;
    pl.rows.forEach(function (r) {
      if (r.section && r.section !== sec) { out.push('<h2>' + esc(r.section) + '</h2>'); sec = r.section; }
      out.push('<div class="bl"><span>' + esc(r.name) + '</span><span class="d"></span><span>' + esc(fmt(r.price)) + '</span></div>');
    });
    var eff = state.plan.rollout.effective;
    if (C.isoDay(eff)) out.push('<p class="foot">Prices from ' + esc(C.fmtDate(eff)) + '</p>');
    $('#printArea').innerHTML = out.join('');
    window.print();
  }

  function editLine(id) {
    var l = id ? lineById(id) : null;
    var S$ = sym();
    sheet('<h2>' + (l ? 'Edit ' + esc(l.name) : 'Add a line') + '</h2>' +
      '<label class="field"><span>Name</span><input class="input" id="eName" maxlength="60" value="' + esc(l ? l.name : '') + '"></label>' +
      '<div class="grid2"><label class="field"><span>Price now</span><span class="money"><input class="input" id="ePrice" inputmode="decimal" value="' + esc(l ? C.plainMoney(l.price) : '') + '"></span></label>' +
      '<label class="field"><span>Cost per sale <span class="hint-inline">optional</span></span><span class="money"><input class="input" id="eCost" inputmode="decimal" value="' + esc(l && l.cost !== null ? C.plainMoney(l.cost) : '') + '"></span></label></div>' +
      '<div class="grid2"><label class="field"><span>Sales a month <span class="hint-inline">optional</span></span><input class="input" id="eVol" inputmode="numeric" value="' + esc(l && l.volume !== null ? C.groups(l.volume) : '') + '"></label>' +
      '<label class="field"><span>New price by hand <span class="hint-inline">optional</span></span><span class="money"><input class="input" id="eManual" inputmode="decimal" value="' + esc(l && l.manual ? C.plainMoney(l.manual) : '') + '"></span></label></div>' +
      '<label class="switch"><input type="checkbox" id="eLock"' + (l && l.locked ? ' checked' : '') + '><span class="knob" aria-hidden="true"></span><span>Keep this price<span class="hint">For the item regulars judge you on - the $3 coffee.</span></span></label>' +
      '<label class="switch"><input type="checkbox" id="eHold"' + (!l || l.hold !== false ? ' checked' : '') + '><span class="knob" aria-hidden="true"></span><span>Hold under round numbers</span></label>' +
      '<div id="eErr"></div>' +
      '<div class="row"><button class="btn" type="button" id="eOk">' + (l ? 'Save' : 'Add') + '</button>' + (l ? '<button class="btn ghost danger" type="button" id="eDel">Remove line</button>' : '') + '</div>',
      function (root) {
        $$('.money', root).forEach(function (m) { m.style.setProperty('--sym', '"' + S$ + '"'); });
        $('#eOk', root).onclick = function () {
          var name = C.clean($('#eName', root).value, C.LIMITS.lineName);
          var price = C.toCents($('#ePrice', root).value);
          var costTxt = $('#eCost', root).value.trim(), volTxt = $('#eVol', root).value.trim(), manTxt = $('#eManual', root).value.trim();
          var cost = costTxt ? C.toCents(costTxt) : null, vol = volTxt ? C.toCount(volTxt) : null, manual = manTxt ? C.toCents(manTxt) : null;
          var err = !name ? 'Give it a name.' : !price ? 'Enter today’s price, like 4.50.' : costTxt && cost === null ? 'The cost should be an amount, like 1.20.' : volTxt && vol === null ? 'Sales a month is a whole number.' : manTxt && (manual === null || manual <= price) ? 'A price by hand has to be above today’s price.' : '';
          if (err) { $('#eErr', root).innerHTML = '<p class="err" role="alert">' + esc(err) + '</p>'; return; }
          if (!l && state.plan.lines.length >= C.LIMITS.lines) { $('#eErr', root).innerHTML = '<p class="err" role="alert">A plan keeps up to ' + C.LIMITS.lines + ' lines.</p>'; return; }
          var next = { id: l ? l.id : newId(), name: name, price: price, cost: cost, volume: vol, manual: manual, locked: $('#eLock', root).checked, hold: $('#eHold', root).checked, section: l ? l.section : null };
          if (l) state.plan.lines[state.plan.lines.indexOf(l)] = next; else state.plan.lines.push(next);
          closeSheet(); listChanged();
        };
        var del = $('#eDel', root);
        if (del) del.onclick = function () { state.plan.lines.splice(state.plan.lines.indexOf(l), 1); closeSheet(); listChanged(); toast('Removed ' + l.name); };
      });
  }

  function openPaste(focus) {
    $('#pastePanel').hidden = false;
    $('#pasteBtn').setAttribute('aria-expanded', 'true');
    if (focus) {
      $('#list').scrollIntoView({ block: 'start' });
      setTimeout(function () { try { $('#pasteBox').focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 60);
    }
  }
  function readPaste() {
    var r = C.parseList($('#pasteBox').value);
    var out = $('#pasteOut');
    if (!r.lines.length) { out.innerHTML = '<p class="err" role="alert">No prices found. Put each item on its own line with its price, like “Latte 4.50”.</p>'; return; }
    var have = state.plan.lines.length;
    out.innerHTML = '<div class="note"><p style="margin-top:0"><b>Read ' + r.lines.length + ' line' + (r.lines.length === 1 ? '' : 's') + '.</b>' +
      (r.skipped.length ? ' Skipped ' + r.skipped.length + ' without a price: ' + r.skipped.slice(0, 3).map(function (s) { return '“' + esc(s) + '”'; }).join(', ') + (r.skipped.length > 3 ? '…' : '') + '.' : '') + '</p>' +
      (r.notes.length ? '<p class="small muted">' + r.notes.slice(0, 3).map(esc).join(' ') + '</p>' : '') +
      '<div class="row">' + (have ? '<button class="btn small" type="button" id="pReplace">Replace my ' + have + ' lines</button><button class="btn small ghost" type="button" id="pAdd">Add to them</button>' : '<button class="btn small" type="button" id="pReplace">Use these</button>') + '</div></div>';
    function apply(replace) {
      var lines = r.lines.map(function (l) { return { id: newId(), name: l.name, price: l.price, cost: l.cost, volume: l.volume, section: l.section, locked: false, hold: true }; });
      var next = C.cleanLines((replace ? [] : state.plan.lines).concat(lines));
      if (!replace && next.length < state.plan.lines.length + lines.length) toast('A plan keeps up to ' + C.LIMITS.lines + ' lines.');
      state.plan.lines = next;
      if (replace || !have) state.plan.settings.currency = r.currency;
      fillMeter();
      $('#pasteBox').value = ''; out.innerHTML = ''; $('#pastePanel').hidden = true; $('#pasteBtn').setAttribute('aria-expanded', 'false');
      listChanged();
      toast('Added ' + lines.length + ' line' + (lines.length === 1 ? '' : 's'));
      $('#list').scrollIntoView({ block: 'start' });
    }
    $('#pReplace').onclick = function () { apply(true); };
    var add = $('#pAdd'); if (add) add.onclick = function () { apply(false); };
  }

  /* ---------------- snap the menu (AI) ---------------- */

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, PHOTO_PX / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        var data = cv.toDataURL('image/jpeg', 0.82);
        resolve({ name: file.name, type: 'image/jpeg', data: data.slice(data.indexOf(',') + 1), url: url });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('“' + file.name + '” could not be opened. Try a JPEG or PNG photo.')); };
      img.src = url;
    });
  }

  function openSnap() {
    if (!signedIn()) return openAccount('Snapping a menu uses AI to read the prices, so it needs a free account - it comes with $2 of credit. Pasting a list is free without one.');
    state.snap.forEach(function (p) { URL.revokeObjectURL(p.url); });
    state.snap = [];
    sheet('<h2>Snap the menu</h2><p class="small muted">Up to ' + C.LIMITS.photos + ' photos of your menu or price board. The prices are read once and the photos are never stored.</p>' +
      '<label class="drop"><input id="snapFiles" type="file" accept="image/*" multiple class="vh"><span><b>Choose or take photos</b><br><span class="small muted">Straight on, well lit, close enough to read</span></span></label>' +
      '<div class="thumbs" id="snapThumbs"></div><div id="snapOut" aria-live="polite"></div><div class="row" id="snapAct" style="margin-top:10px"></div>', function (root) {
      $('#snapFiles', root).onchange = function (e) {
        var files = Array.prototype.slice.call(e.target.files || []);
        var room = C.LIMITS.photos - state.snap.length;
        if (files.length > room) toast('Up to ' + C.LIMITS.photos + ' photos at a time.');
        var chain = Promise.resolve();
        files.slice(0, Math.max(0, room)).forEach(function (f) {
          chain = chain.then(function () { return shrink(f); }).then(function (p) { state.snap.push(p); drawSnap(root); }).catch(function (err) { toast(err.message, 4000); });
        });
        e.target.value = '';
      };
      drawSnap(root);
    });
  }
  function drawSnap(root) {
    $('#snapThumbs', root).innerHTML = state.snap.map(function (p, i) {
      return '<figure><img src="' + esc(p.url) + '" alt="Menu photo ' + (i + 1) + '"><button type="button" data-rm="' + i + '" aria-label="Remove photo ' + (i + 1) + '">×</button></figure>';
    }).join('');
    $$('[data-rm]', root).forEach(function (b) { b.onclick = function () { var i = Number(b.getAttribute('data-rm')); URL.revokeObjectURL(state.snap[i].url); state.snap.splice(i, 1); drawSnap(root); }; });
    var act = $('#snapAct', root);
    act.innerHTML = '<button class="btn" type="button" id="snapGo"' + (state.snap.length ? '' : ' disabled') + '>Read the prices</button><span class="small muted">Uses AI credit - usually a cent or two.</span>';
    $('#snapGo', root).onclick = function () { doSnap(root); };
  }
  function doSnap(root) {
    var out = $('#snapOut', root), act = $('#snapAct', root);
    act.innerHTML = '';
    out.innerHTML = '<p class="busy">Reading ' + state.snap.length + ' photo' + (state.snap.length === 1 ? '' : 's') + '… this takes a few seconds.</p>';
    api('POST', 'api/snap', { photos: state.snap.map(function (p) { return { type: p.type, data: p.data }; }) }).then(function (r) {
      loadMe();
      reviewSnap(root, r);
    }).catch(function (e) {
      drawSnap(root);
      if (e.status === 401 || e.status === 402) { out.innerHTML = ''; closeSheet(); return showError(e); }
      if (e.data && e.data.code === 'verify-email') return verifyNote(out, e, 'snap the menu');
      out.innerHTML = '<p class="err" role="alert">' + esc(e.message) + '</p>';
    });
  }
  function reviewSnap(root, r) {
    var cur = r.currency && r.currency !== 'other' ? r.currency : state.plan.settings.currency;
    var S$ = C.symbolOf(cur);
    root.querySelector('#snapThumbs').innerHTML = '';
    var have = state.plan.lines.length;
    $('#snapOut', root).innerHTML = '<p><b>Read ' + r.lines.length + ' price' + (r.lines.length === 1 ? '' : 's') + '.</b> Check them against the menu - untick anything wrong' + (r.dropped ? ' (' + r.dropped + ' unreadable line' + (r.dropped === 1 ? ' was' : 's were') + ' left out)' : '') + '.' + (r.currency === 'other' ? ' The currency wasn’t clear - the numbers are as printed.' : '') + '</p>' +
      '<ul class="review">' + r.lines.map(function (l, i) {
        return '<li><input type="checkbox" checked data-i="' + i + '" aria-label="Keep ' + esc(l.name) + '"><input class="input" data-n="' + i + '" value="' + esc(l.name) + '" aria-label="Name" maxlength="60"><span class="money" style="--sym:&quot;' + esc(S$) + '&quot;"><input class="input" data-p="' + i + '" value="' + esc(C.plainMoney(l.price)) + '" inputmode="decimal" aria-label="Price"></span></li>';
      }).join('') + '</ul><div id="snapErr"></div>';
    $('#snapAct', root).innerHTML = (have ? '<button class="btn" type="button" id="sReplace">Replace my ' + have + ' lines</button><button class="btn ghost" type="button" id="sAdd">Add to them</button>' : '<button class="btn" type="button" id="sReplace">Add to my price list</button>');
    function apply(replace) {
      var lines = [], bad = 0;
      r.lines.forEach(function (l, i) {
        if (!root.querySelector('[data-i="' + i + '"]').checked) return;
        var name = C.clean(root.querySelector('[data-n="' + i + '"]').value, C.LIMITS.lineName), price = C.toCents(root.querySelector('[data-p="' + i + '"]').value);
        if (!name || !price) { bad++; return; }
        lines.push({ id: newId(), name: name, price: price, section: l.section, locked: false, hold: true, cost: null, volume: null });
      });
      if (bad) { $('#snapErr', root).innerHTML = '<p class="err" role="alert">' + bad + ' ticked line' + (bad === 1 ? ' needs' : 's need') + ' a name and a price.</p>'; return; }
      state.plan.lines = C.cleanLines((replace ? [] : state.plan.lines).concat(lines));
      if (r.currency && r.currency !== 'other' && (replace || !have)) state.plan.settings.currency = r.currency;
      state.snap.forEach(function (p) { URL.revokeObjectURL(p.url); }); state.snap = [];
      closeSheet(); fillMeter(); listChanged();
      toast('Added ' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + ' - add costs and sales to see the break-even');
      $('#list').scrollIntoView({ block: 'start' });
    }
    $('#sReplace', root).onclick = function () { apply(true); };
    var add = $('#sAdd', root); if (add) add.onclick = function () { apply(false); };
  }

  /* ---------------- the announcement ---------------- */

  function fillAnnounce() {
    var a = state.plan.announce;
    $('#aBiz').value = a.business;
    $('#aType').innerHTML = C.BUSINESS_TYPES.map(function (t) { return '<option value="' + esc(t) + '"' + (t === a.type ? ' selected' : '') + '>' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + '</option>'; }).join('');
    $('#aReasons').innerHTML = C.REASONS.map(function (r) { return '<button class="chip" type="button" data-reason="' + r.id + '" aria-pressed="' + (a.reasons.indexOf(r.id) >= 0) + '">' + esc(r.label) + '</button>'; }).join('');
    $$('[data-reason]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-reason'), list = state.plan.announce.reasons, i = list.indexOf(id);
        if (i >= 0) list.splice(i, 1); else list.push(id);
        b.setAttribute('aria-pressed', String(i < 0));
        $('#sinceWrap').hidden = list.indexOf('since') < 0;
        drawPieces(); changed();
      };
    });
    $('#sinceWrap').hidden = a.reasons.indexOf('since') < 0;
    $('#aSince').value = a.since;
    $('#aOther').value = a.other; drawOtherCount();
    $('#aTone').innerHTML = C.TONES.map(function (t) { return '<button type="button" data-tone="' + t + '" aria-pressed="' + (t === a.tone) + '">' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + '</button>'; }).join('');
    $$('[data-tone]').forEach(function (b) {
      b.onclick = function () { state.plan.announce.tone = b.getAttribute('data-tone'); $$('[data-tone]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); drawPieces(); changed(); };
    });
    $('#aGrand').value = a.grandfather;
    $('#aVoice').value = a.voice;
    drawSummaryField();
  }
  function drawOtherCount() { var n = $('#aOther').value.length; $('#otherCount').textContent = n ? n + ' / ' + C.LIMITS.reasons : ''; }
  function autoSummary() { return C.changeSummary(priced(), sym()); }
  function autoGrand() {
    var r = state.plan.rollout;
    return r.grandfatherWeeks ? 'Existing clients keep their current prices until ' + C.fmtShort(C.addDays(r.effective, r.grandfatherWeeks * 7)) + '.' : '';
  }
  function drawSummaryField() {
    var a = state.plan.announce, box = $('#aSummary');
    if (document.activeElement !== box) box.value = a.summary || autoSummary();
    box.placeholder = 'Most prices go up 25¢ to 50¢. Drip coffee stays at $3.00.';
    $('#sumReset').hidden = !a.summary;
    var g = $('#aGrand');
    g.placeholder = autoGrand() || 'Existing clients keep their current prices until Dec 1.';
  }
  function effectiveAnnounce() {
    var a = JSON.parse(JSON.stringify(state.plan.announce));
    a.summary = a.summary || autoSummary();
    a.grandfather = a.grandfather || autoGrand();
    return a;
  }
  function facts() {
    var pl = priced(), fmt = C.priceFormat(pl.rows, sym());
    return { effective: state.plan.rollout.effective, kept: pl.rows.filter(function (r) { return r.locked; }).map(function (r) { return { name: r.name, price: fmt(r.old) }; }) };
  }

  function drawAnnActions() {
    var el = $('#annActions');
    if (state.announcing) { el.innerHTML = '<p class="busy">Writing it in your words… about ten seconds.</p>'; return; }
    if (!signedIn()) {
      el.innerHTML = '<button class="btn" type="button" id="aiGo">✨ Sign in to write it with AI</button><span class="small muted">Free templates below - no account needed.</span>';
      $('#aiGo').onclick = function () { openAccount('Writing the announcement in your voice uses AI, so it needs a free account - it comes with $2 of credit. The templates below stay free without one.'); };
      return;
    }
    el.innerHTML = '<button class="btn" type="button" id="aiGo">✨ ' + (state.plan.draft ? 'Write it again with AI' : 'Write it with AI') + '</button><span class="small muted">About a cent of AI credit. It uses only what you’ve given it.</span>';
    $('#aiGo').onclick = doAnnounce;
  }
  function doAnnounce() {
    var out = $('#annOut');
    out.innerHTML = '';
    state.announcing = true; drawAnnActions();
    api('POST', 'api/announce', { announce: effectiveAnnounce(), lines: state.plan.lines, settings: state.plan.settings, rollout: state.plan.rollout }).then(function (r) {
      state.announcing = false;
      state.plan.draft = r.draft; state.show = 'ai'; state.replaced = r.replaced || [];
      drawAnnActions(); drawPieces(); changed(); loadMe();
      $('#pieces').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }).catch(function (e) {
      state.announcing = false; drawAnnActions();
      if (e.status === 401 || e.status === 402) return showError(e);
      if (e.data && e.data.code === 'verify-email') return verifyNote(out, e, 'press Write it with AI');
      out.innerHTML = '<p class="err" role="alert">' + esc(e.message) + '</p>';
    });
  }

  function drawPieces() {
    var ai = Boolean(state.plan.draft) && state.show === 'ai';
    var d = ai ? state.plan.draft : C.templates(effectiveAnnounce(), facts());
    var html = '<div class="source' + (ai ? ' ai' : '') + '"><span>' + (ai ? '<b>Written with AI</b> from your inputs - read every word before you send it.' : '<b>Free template</b>, filled from what you entered above.') + '</span>' +
      (state.plan.draft ? '<button class="link-btn tiny" type="button" id="swapSrc">' + (ai ? 'Show the free template' : 'Show the AI draft') + '</button>' : '') + '</div>';
    if (ai && state.replaced.length) {
      html += '<div class="warn">' + state.replaced.map(function (x) { return 'The AI’s version of ' + esc(x.label) + ' mentioned ' + esc(x.figures.join(', ')) + ', which you didn’t give - so that piece is the template instead.'; }).join(' ') + '</div>';
    }
    function piece(key, title, count, body) {
      return '<div class="piece"><div class="piece-top"><h3>' + esc(title) + '</h3><span class="row"><span class="count">' + esc(count) + '</span><button class="btn small ghost" type="button" data-copy="' + key + '">Copy</button></span></div>' + body + '</div>';
    }
    html += piece('sign', 'Sign for the door', d.sign.length + ' / 280', '<div class="doorsign">' + esc(d.sign) + '</div>');
    html += piece('staffScript', 'Counter script', d.staffScript.length + ' answers', '<ul class="qa">' + d.staffScript.map(function (q) { return '<li><div class="q">“' + esc(q.question) + '”</div><div class="a">' + esc(q.answer) + '</div></li>'; }).join('') + '</ul>');
    html += piece('email', 'Email to customers', '', '<p class="subj">' + esc(d.email.subject) + '</p><div class="body">' + esc(d.email.body) + '</div>');
    html += piece('social', 'Social post', d.social.length + ' / 600', '<div class="body">' + esc(d.social) + '</div>');
    html += piece('text', 'Text to regulars', d.text.length + ' / 320', '<div class="sms">' + esc(d.text) + '</div>');
    $('#pieces').innerHTML = html;
    var sw = $('#swapSrc'); if (sw) sw.onclick = function () { state.show = ai ? 'template' : 'ai'; drawPieces(); };
    var texts = {
      sign: d.sign, social: d.social, text: d.text,
      email: 'Subject: ' + d.email.subject + '\n\n' + d.email.body,
      staffScript: d.staffScript.map(function (q) { return 'Q: ' + q.question + '\nA: ' + q.answer; }).join('\n\n'),
    };
    $$('[data-copy]', $('#pieces')).forEach(function (b) { b.onclick = function () { copy(texts[b.getAttribute('data-copy')], 'Copied'); }; });
  }

  /* ---------------- rollout ---------------- */

  function fillRollout() {
    var r = state.plan.rollout;
    $('#rNotice').value = r.notice; $('#rEffective').value = r.effective;
    $('#rGrand').innerHTML = [0, 2, 4, 8, 12, 26].map(function (w) { return '<option value="' + w + '"' + (w === r.grandfatherWeeks ? ' selected' : '') + '>' + (w ? 'for ' + w + ' weeks' : 'No - everyone at once') + '</option>'; }).join('');
  }
  function drawRollout() {
    var t = today();
    var ro = C.rollout(state.plan.rollout, t);
    $('#rollWarn').innerHTML = ro.warnings.map(function (w) { return '<div class="warn" role="status">' + esc(w) + '</div>'; }).join('') +
      (ro.ok ? '<p class="small muted">' + ro.noticeDays + ' days’ notice.</p>' : '');
    $('#timeline').innerHTML = ro.items.map(function (it) {
      var d = new Date(it.date + 'T00:00:00Z');
      var n = C.daysBetween(t, it.date);
      var when = n < 0 ? '<span class="when done">done</span>' : n === 0 ? '<span class="when today">today</span>' : '<span class="when">' + (n === 1 ? 'tomorrow' : 'in ' + (n < 60 ? n + ' days' : Math.round(n / 7) + ' weeks')) + '</span>';
      return '<li class="' + (it.kind === 'effective' ? 'key' : '') + '"><span class="date" aria-hidden="true"><span class="m">' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + '</span><span class="d">' + d.getUTCDate() + '</span><span class="y">' + d.getUTCFullYear() + '</span></span>' +
        '<span><span class="t">' + esc(it.title) + '</span> ' + when + '<br><span class="vh">' + esc(C.fmtDate(it.date)) + '. </span><span class="r">' + esc(it.detail) + '</span></span></li>';
    }).join('');
  }
  function downloadIcs() {
    var ro = C.rollout(state.plan.rollout, today());
    var name = state.plan.announce.business || state.plan.name || 'My price rise';
    var body = C.ics({ name: name, planKey: state.id || name, items: ro.items, now: new Date().toISOString() });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar;charset=utf-8' }));
    a.download = C.icsFilename(name);
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Calendar file downloaded - open it to add the dates');
  }

  /* ---------------- did it work? ---------------- */

  function fillTracker() {
    var t = state.plan.tracker;
    $$('[data-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === t.mode)); });
    $('#tBase').value = t.baseline;
    drawTrackerLabels();
    drawWeeks();
  }
  function unitWord() { return state.plan.meter.unit || 'customers'; }
  function drawTrackerLabels() {
    var rev = state.plan.tracker.mode === 'revenue';
    $('#baseLbl').textContent = rev ? 'A typical week’s revenue before the change' : 'A typical week before the change (' + unitWord() + ')';
    $('#baseWrap').className = rev ? 'money' : '';
    $('#tBase').placeholder = rev ? '5,040' : '600';
  }
  function drawWeeks() {
    var t = state.plan.tracker, rev = t.mode === 'revenue';
    var rows = t.entries.map(function (e, i) {
      return '<li><input class="input" type="date" data-wk="' + i + '" value="' + esc(e.week) + '" aria-label="Week ' + (i + 1) + ' starting"><span class="' + (rev ? 'money' : '') + '"><input class="input" data-wv="' + i + '" inputmode="decimal" value="' + esc(e.value) + '" aria-label="Week ' + (i + 1) + (rev ? ' revenue' : ' ' + unitWord()) + '"></span><button class="x" type="button" data-wx="' + i + '" aria-label="Remove week ' + (i + 1) + '">×</button></li>';
    });
    $('#weeks').innerHTML = t.entries.length ? '<ul class="weeks"><li class="head"><span>Week starting</span><span>' + (rev ? 'Revenue' : esc(unitWord().charAt(0).toUpperCase() + unitWord().slice(1))) + '</span><span></span></li>' + rows.join('') + '</ul>' : '';
    $$('[data-wk]').forEach(function (inp) { inp.onchange = function () { t.entries[Number(inp.getAttribute('data-wk'))].week = inp.value; drawTracker(); changed(); }; });
    $$('[data-wv]').forEach(function (inp) { inp.oninput = function () { t.entries[Number(inp.getAttribute('data-wv'))].value = inp.value; drawTracker(); changed(); }; });
    $$('[data-wx]').forEach(function (b) { b.onclick = function () { t.entries.splice(Number(b.getAttribute('data-wx')), 1); drawWeeks(); drawTracker(); changed(); }; });
    $('#addWeek').disabled = t.entries.length >= C.LIMITS.tracker;
  }
  function drawTracker() {
    var be = meterNow();
    var v = C.verdict(state.plan.tracker, be, sym());
    var el = $('#verdict');
    el.className = 'verdict ' + (v.status === 'ahead' ? 'ahead' : v.status === 'behind' ? 'behind' : '');
    el.innerHTML = '<p class="say">' + parts(v.parts) + '</p>' + (v.note ? '<p class="small">' + esc(v.note) + '</p>' : '') + (v.explain && v.changePm !== null ? '<p class="small muted">' + esc(v.explain) + '</p>' : '');
    drawChart(v);
  }
  function drawChart(v) {
    var el = $('#chart');
    var pts = v.points || [];
    if (!v.baseline || !pts.length) { el.innerHTML = ''; return; }
    var rev = v.mode === 'revenue', S$ = sym();
    var fmt = function (n) { return rev ? C.dollars(n, S$, 'nearest') : C.groups(Math.round(n)); };
    var vals = pts.map(function (p) { return p.value; }).concat([v.baseline]);
    if (v.line) vals.push(v.line);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var span = Math.max(hi - lo, hi * 0.04, 1);
    lo = Math.max(0, lo - span * 0.35); hi = hi + span * 0.25;
    var W = 340, H = 170, L = 8, R = 92, T = 12, Bt = 24;
    var x = function (i) { return L + (pts.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (pts.length - 1)); };
    var y = function (val) { return T + (H - T - Bt) * (1 - (val - lo) / (hi - lo)); };
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Weekly ' + (rev ? 'revenue' : unitWord()) + ' after the change: ' + pts.map(function (p) { return C.fmtShort(p.week) + ' ' + fmt(p.value); }).join(', ') + '. Before: ' + fmt(v.baseline) + (v.line ? '. Break-even: ' + fmt(v.line) : '') + '.') + '">';
    out += '<line class="baseline" x1="' + L + '" x2="' + (W - R + 4) + '" y1="' + y(v.baseline).toFixed(1) + '" y2="' + y(v.baseline).toFixed(1) + '"/><text x="' + (W - R + 8) + '" y="' + (y(v.baseline) + 4).toFixed(1) + '">Before ' + esc(fmt(v.baseline)) + '</text>';
    if (v.line) out += '<line class="beline" x1="' + L + '" x2="' + (W - R + 4) + '" y1="' + y(v.line).toFixed(1) + '" y2="' + y(v.line).toFixed(1) + '"/><text class="be" x="' + (W - R + 8) + '" y="' + (y(v.line) + 4).toFixed(1) + '">Break-even ' + esc(fmt(v.line)) + '</text>';
    if (pts.length > 1) out += '<polyline fill="none" stroke="var(--plum)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="' + pts.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p.value).toFixed(1); }).join(' ') + '"/>';
    pts.forEach(function (p, i) {
      out += '<g><title>' + esc('Week of ' + C.fmtShort(p.week) + ': ' + fmt(p.value)) + '</title><circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="5" fill="var(--plum)" stroke="var(--card)" stroke-width="2"/><circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="14" fill="transparent"/></g>';
      if (pts.length <= 8 || i === 0 || i === pts.length - 1) out += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(C.fmtShort(p.week)) + '</text>';
    });
    out += '</svg>';
    el.innerHTML = '<div class="chart-key"><span>Weekly ' + esc(rev ? 'revenue' : unitWord()) + ' since the change</span>' + (v.line ? '<span><i></i>break-even: below this line, the raise costs you</span>' : '') + '</div>' + out;
  }
  function addWeek() {
    var t = state.plan.tracker;
    var last = t.entries.length ? t.entries[t.entries.length - 1].week : null;
    var week = C.isoDay(last) ? C.addDays(last, 7) : (C.isoDay(state.plan.rollout.effective) || today());
    t.entries.push({ week: week, value: '' });
    drawWeeks(); drawTracker(); changed();
    var inp = $('[data-wv="' + (t.entries.length - 1) + '"]'); if (inp) inp.focus();
  }

  /* ---------------- everything ---------------- */

  function fillAll() { fillMeter(); fillList(); fillAnnounce(); fillRollout(); fillTracker(); $('#pastePanel').hidden = true; $('#pasteBtn').setAttribute('aria-expanded', 'false'); $('#annOut').innerHTML = ''; }
  function drawAll() { drawIntro(); drawMeter(); drawList(); drawAnnActions(); drawPieces(); drawRollout(); drawTracker(); }

  /* ---------------- plans ---------------- */

  function openPlans() {
    var local = recall(K_DRAFT);
    sheet('<h2>Plans</h2><div id="planList"><p class="busy">Loading…</p></div>', function (root) {
      var list = $('#planList', root);
      function draw(saved, limit) {
        var rows = [];
        if (local && local.plan && local.kind === 'local') rows.push('<li><span><span class="nm">' + esc(local.plan.name || (local.plan.announce && local.plan.announce.business) || 'My price rise') + '</span><br><span class="small muted">On this device · not saved yet</span></span><span class="acts"><button class="btn small" type="button" data-local="1">Open</button></span></li>');
        (saved || []).forEach(function (p) {
          rows.push('<li><span><span class="nm">' + esc(p.name) + '</span><br><span class="small muted">' + p.lines + ' line' + (p.lines === 1 ? '' : 's') + (p.blendedBp !== null ? ' · +' + esc(C.bpText(Math.round(p.blendedBp / 10) * 10)) : '') + (p.weeks ? ' · ' + p.weeks + ' week' + (p.weeks === 1 ? '' : 's') + ' tracked' : '') + '</span></span>' +
            '<span class="acts"><button class="btn small" type="button" data-open="' + esc(p.id) + '">Open</button><button class="btn small ghost" type="button" data-more="' + esc(p.id) + '" aria-label="' + esc('More for ' + p.name) + '">⋯</button></span></li>');
        });
        rows.push('<li><span><span class="nm">The example café</span><br><span class="small muted">Maple Street Coffee · always here</span></span><span class="acts"><button class="btn small ghost" type="button" data-sample="1">Open</button></span></li>');
        list.innerHTML = '<ul class="plans">' + rows.join('') + '</ul>' +
          (saved ? '<p class="small muted">' + saved.length + ' of ' + limit + ' saved. A plan keeps your prices, dates, words and tracker - never a photo.</p>' : '<p class="small muted">Sign in to save plans and come back to them on any device.</p>') +
          '<div class="row"><button class="btn" type="button" id="newPlan">Start a new plan</button>' + (saved ? '' : '<button class="btn ghost" type="button" id="pSign">Sign in</button>') + '</div>';
        $$('[data-open]', root).forEach(function (b) { b.onclick = function () { openSaved(b.getAttribute('data-open')); }; });
        $$('[data-more]', root).forEach(function (b) { b.onclick = function () { planMenu(saved.filter(function (p) { return p.id === b.getAttribute('data-more'); })[0]); }; });
        var lb = $('[data-local]', root); if (lb) lb.onclick = function () { closeSheet(); setPlan(forPage(local.plan), 'local'); window.scrollTo(0, 0); };
        $('[data-sample]', root).onclick = function () { closeSheet(); setPlan(samplePlan(), 'sample'); window.scrollTo(0, 0); };
        $('#newPlan', root).onclick = function () { closeSheet(); startOwn(); };
        var ps = $('#pSign', root); if (ps) ps.onclick = function () { closeSheet(); openAccount(); };
      }
      if (!signedIn()) return draw(null);
      api('GET', 'api/plans').then(function (r) { draw(r.plans, r.limit); }).catch(function (e) { showError(e, list); });
    });
  }
  function openSaved(id) {
    api('GET', 'api/plans/' + encodeURIComponent(id)).then(function (r) { closeSheet(); setPlan(forPage(r.plan), 'saved', r.plan.id); window.scrollTo(0, 0); }).catch(function (e) { showError(e); });
  }
  function planMenu(p) {
    sheet('<h2>' + esc(p.name) + '</h2><label class="field"><span>Name</span><input class="input" id="rn" maxlength="80" value="' + esc(p.name) + '"></label><div id="rnErr"></div>' +
      '<div class="row"><button class="btn" type="button" id="rnOk">Rename</button><button class="btn ghost" type="button" id="dup">Duplicate</button><button class="btn ghost danger" type="button" id="del">Delete</button></div>', function (root) {
      $('#rnOk', root).onclick = function () {
        api('PATCH', 'api/plans/' + encodeURIComponent(p.id), { name: $('#rn', root).value }).then(function (r) {
          if (state.id === p.id) { state.plan.name = r.plan.name; drawIntro(); }
          toast('Renamed'); openPlans();
        }).catch(function (e) { showError(e, $('#rnErr', root)); });
      };
      $('#dup', root).onclick = function () { api('POST', 'api/plans/' + encodeURIComponent(p.id) + '/duplicate').then(function () { toast('Duplicated'); openPlans(); }).catch(function (e) { showError(e, $('#rnErr', root)); }); };
      $('#del', root).onclick = function () {
        if (!confirm('Delete “' + p.name + '” - its prices, words and tracker? This cannot be undone.')) return;
        api('DELETE', 'api/plans/' + encodeURIComponent(p.id)).then(function () {
          toast('Deleted');
          if (state.id === p.id) { keep(K_DRAFT, null); setPlan(samplePlan(), 'sample'); }
          openPlans();
        }).catch(function (e) { showError(e, $('#rnErr', root)); });
      };
    });
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
    $('#plansBtn').onclick = openPlans;
  }

  var lastFocus = null;
  function sheet(html, onOpen) {
    var s = $('#sheet'), back = $('#sheetBack');
    lastFocus = document.activeElement;
    s.innerHTML = '<button class="btn small ghost close" type="button" id="sheetClose" aria-label="Close">Close</button>' + html;
    s.hidden = false; back.hidden = false;
    $('#sheetClose').onclick = closeSheet;
    back.onclick = closeSheet;
    if (onOpen) onOpen(s);
    var f = s.querySelector('input:not(.vh), select, textarea, button:not(.close)') || $('#sheetClose');
    setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  var FREE_LINE = 'The break-even, the price list, the templates, the rollout and the tracker are free and need no account. Snapping a menu and writing the announcement with AI need a free account - it comes with $2 of credit. One account works across every app on this site.';

  function openAccount(reason) {
    var mode = 'register';
    function draw(root) {
      root.querySelector('.body').innerHTML =
        '<h2>' + (mode === 'register' ? 'Create a free account' : 'Welcome back') + '</h2>' +
        '<p class="muted">' + esc(reason || FREE_LINE) + '</p>' +
        '<form id="authForm">' +
        '<label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required></label>' +
        '<label class="field"><span>Password' + (mode === 'register' ? ' (10+ characters)' : '') + '</span><input class="input" name="password" type="password" autocomplete="' + (mode === 'register' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'register' ? 10 : 1) + '"></label>' +
        '<div id="authErr"></div>' +
        '<button class="btn block" type="submit">' + (mode === 'register' ? 'Create free account' : 'Sign in') + '</button></form>' +
        (pkOk() && mode === 'login' ? '<button class="btn ghost block" id="pkBtn" type="button" style="margin-top:10px">Sign in with Face ID / passkey</button>' : '') +
        '<p class="small muted" style="text-align:center;margin-top:12px">' + (mode === 'register' ? 'Already have an account? <button class="link-btn" id="swap" type="button">Sign in</button>' : 'New here? <button class="link-btn" id="swap" type="button">Create an account</button>') + '</p>';
      $('#swap', root).onclick = function () { mode = mode === 'register' ? 'login' : 'register'; draw(root); };
      $('#authForm', root).onsubmit = function (e) {
        e.preventDefault();
        var f = e.target, btn = $('button[type=submit]', f);
        btn.disabled = true;
        api('POST', 'api/auth/' + (mode === 'register' ? 'register' : 'login'), { email: f.email.value, password: f.password.value })
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); afterSignIn(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(afterSignIn)
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      };
    }
    sheet('<div class="body"></div>', draw);
  }
  /** Signed in: a plan made on this device is offered to the account. */
  function afterSignIn() {
    drawAnnActions(); drawIntro();
    if (state.kind === 'local' && signedIn() && (state.plan.lines.length || state.plan.announce.business || state.plan.meter.price)) {
      sheet('<h2>Save this plan to your account?</h2><p class="muted">You made “' + esc(state.plan.name || state.plan.announce.business || 'My price rise') + '” on this device. Save it to come back to it anywhere.</p><div class="row"><button class="btn" type="button" id="offerYes">Save it</button><button class="btn ghost" type="button" id="offerNo">Not now</button></div>', function (root) {
        $('#offerYes', root).onclick = function () { closeSheet(); savePlan(); };
        $('#offerNo', root).onclick = closeSheet;
      });
    }
  }

  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(
      '<h2>Account</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div>' +
      '<p class="small muted" style="margin:6px 0 0">Snapping a menu or writing the announcement costs a cent or two. Everything else is free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () {
            closeSheet(); state.me = { signedIn: false }; drawTop();
            if (state.kind === 'saved') { keep(K_DRAFT, null); keep(K_OPEN, null); setPlan(samplePlan(), 'sample'); } else { drawAnnActions(); drawIntro(); }
          });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The break-even, the price list, the templates, the rollout and your saved plans keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring ---------------- */

  function meterInput(key, sel) {
    $(sel).addEventListener('input', function (e) { state.plan.meter[key] = e.target.value; drawMeter(); drawTracker(); changed(); });
  }
  meterInput('price', '#mPrice'); meterInput('cost', '#mCost'); meterInput('margin', '#mMargin'); meterInput('volume', '#mVolume'); meterInput('newPrice', '#mNew');
  $('#mUnit').onchange = function (e) { state.plan.meter.unit = e.target.value; drawMeter(); drawTrackerLabels(); drawWeeks(); drawTracker(); changed(); };
  $('#costMode').onclick = function () { var m = state.plan.meter; m.costMode = m.costMode === 'margin' ? 'cost' : 'margin'; drawCostMode(); drawMeter(); drawTracker(); changed(); var t = m.costMode === 'margin' ? $('#mMargin') : $('#mCost'); t.focus(); };
  $('#newRange').addEventListener('input', function (e) { setNewPrice(Number(e.target.value)); });
  $('#lossRange').addEventListener('input', function (e) { state.plan.meter.whatIf = Number(e.target.value); drawMeter(); changed(); });

  $('#target').addEventListener('input', function (e) {
    var bp = C.toBp(e.target.value);
    if (bp !== null && bp >= C.LIMITS.targetMin && bp <= C.LIMITS.targetMax) { state.plan.settings.target = bp; listChanged(); }
  });
  $('#target').addEventListener('blur', function () { $('#target').value = C.bpText(state.plan.settings.target).replace('%', ''); });
  $('#style').onchange = function (e) { state.plan.settings.style = e.target.value; listChanged(); };
  $('#holdUnder').onchange = function (e) { state.plan.settings.holdUnder = e.target.checked; listChanged(); };
  $('#pasteBtn').onclick = function () { var open = $('#pastePanel').hidden; $('#pastePanel').hidden = !open; $('#pasteBtn').setAttribute('aria-expanded', String(open)); if (open) $('#pasteBox').focus(); };
  $('#readPaste').onclick = readPaste;
  $('#pasteSample').onclick = function () { $('#pasteBox').value = S.PASTE; readPaste(); };
  $('#snapBtn').onclick = openSnap;
  $('#addBtn').onclick = function () { editLine(null); };
  $$('[data-board]').forEach(function (b) { b.onclick = function () { state.board = b.getAttribute('data-board'); drawBoard(priced()); }; });
  $('#copyList').onclick = function () { var pl = priced(); copy(C.listText(pl.rows, sym()), 'New price list copied'); };
  $('#copyChanges').onclick = function () { var pl = priced(); copy(C.listText(pl.rows, sym(), 'changes'), 'Changes copied'); };
  $('#printBtn').onclick = printList;

  function annInput(key, sel) {
    $(sel).addEventListener('input', function (e) { state.plan.announce[key] = e.target.value; if (key === 'other') drawOtherCount(); if (key === 'business') drawBoard(priced()); drawPieces(); changed(); });
  }
  annInput('business', '#aBiz'); annInput('other', '#aOther'); annInput('grandfather', '#aGrand'); annInput('voice', '#aVoice');
  $('#aSince').addEventListener('input', function (e) { state.plan.announce.since = /^(19|20)\d{2}$/.test(e.target.value.trim()) ? e.target.value.trim() : ''; drawPieces(); changed(); });
  $('#aType').onchange = function (e) { state.plan.announce.type = e.target.value; changed(); };
  $('#aSummary').addEventListener('input', function (e) {
    var v = e.target.value;
    state.plan.announce.summary = v.trim() === autoSummary() ? '' : v;
    $('#sumReset').hidden = !state.plan.announce.summary;
    drawPieces(); changed();
  });
  $('#sumReset').onclick = function () { state.plan.announce.summary = ''; $('#aSummary').value = autoSummary(); $('#sumReset').hidden = true; drawPieces(); changed(); };

  function rollInput(sel, key, num) {
    $(sel).addEventListener('change', function (e) {
      var v = num ? Number(e.target.value) : e.target.value;
      if (!num && !C.isoDay(v)) return;
      state.plan.rollout[key] = v;
      drawRollout(); drawSummaryField(); drawPieces(); changed();
    });
  }
  rollInput('#rNotice', 'notice'); rollInput('#rEffective', 'effective'); rollInput('#rGrand', 'grandfatherWeeks', true);
  $('#icsBtn').onclick = downloadIcs;

  $$('[data-mode]').forEach(function (b) {
    b.onclick = function () {
      var t = state.plan.tracker, mode = b.getAttribute('data-mode');
      if (mode === t.mode) return;
      if ((t.baseline || t.entries.some(function (e) { return e.value; })) && !confirm('Switch to ' + (mode === 'revenue' ? 'revenue' : 'sales') + '? The numbers entered so far are cleared - they mean something different.')) return;
      t.mode = mode; t.baseline = ''; t.entries.forEach(function (e) { e.value = ''; });
      fillTracker(); drawTracker(); changed();
    };
  });
  $('#tBase').addEventListener('input', function (e) { state.plan.tracker.baseline = e.target.value; drawTracker(); changed(); });
  $('#addWeek').onclick = addWeek;

  /* ---------------- start ---------------- */

  // The example opens first, always, unless this device has a plan in
  // progress - then that plan (the example is one tap away in Plans).
  var draft = recall(K_DRAFT);
  if (draft && draft.plan && draft.kind === 'local') setPlan(forPage(draft.plan), 'local');
  else setPlan(samplePlan(), 'sample');
  drawTop();
  loadMe().then(function () {
    drawAnnActions(); drawIntro();
    var open = recall(K_OPEN);
    if (signedIn() && open && open.id && state.kind === 'sample') {
      api('GET', 'api/plans/' + encodeURIComponent(open.id)).then(function (r) { setPlan(forPage(r.plan), 'saved', r.plan.id); }).catch(function () { keep(K_OPEN, null); });
    }
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
})();
