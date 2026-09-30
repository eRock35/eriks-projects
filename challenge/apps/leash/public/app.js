/* Leash - the page. One file, no build step. Every string that came from
 * outside this file (a model's reading, a saved agent, a typed name) is
 * escaped before it is drawn, and no handler is written into markup (the
 * lab's CSP allows script from this origin only). The sums are
 * leash-core.js, the same file the server and the tests run. */
(function () {
  'use strict';

  var C = window.LeashCore;
  var S = window.LeashSample;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var BASE = new URL('.', document.baseURI).pathname;
  var K_DRAFT = 'leash-draft-v1';
  var K_OPEN = 'leash-open-v1';
  var DRILL_SECS = 60;
  var RM = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function parts(p) { return (p || []).map(function (x) { return x.b !== undefined ? '<b>' + esc(x.b) + '</b>' : esc(x.t); }).join(''); }
  function partsText(p) { return (p || []).map(function (x) { return x.b !== undefined ? x.b : x.t; }).join(''); }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function shortDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  }

  var state = {
    me: null,
    kind: 'sample',     // 'sample' | 'local' (this device only) | 'saved'
    id: null,
    agent: null,        // {name, profile, charter, drills}
    dirty: false,
    saving: false,
    tab: 'pick',
    reading: null,      // the AI's reading, under review
    busy: false,
    shownScore: 0,
    moreFixes: false,
    drill: { phase: 'idle' },
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // The AI route streams whitespace and so answers 200 even on
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
    var old = $('.toast'); if (old) old.remove();
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
  function reduced() { return Boolean(RM.matches); }
  function P() { return state.agent.profile; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }
  /** The 403 an unconfirmed free account gets, with its resend button. */
  function verifyNote(where, e, what) {
    where.innerHTML = '<div class="note" role="alert"><p class="err" style="margin-top:0">' + esc(e.message) + '</p><p class="small muted">Open the link in that email, then come back and ' + esc(what) + ' again. Nothing you pasted is lost - and ticking what it can do by hand works meanwhile.</p><button class="btn small ghost" type="button" id="resend">Send the link again</button></div>';
    $('#resend', where).onclick = function () {
      var b = this; b.disabled = true;
      fetch(e.data.resend || (BASE + 'api/auth/verify/send'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { b.textContent = 'Sent - check your inbox'; }, function () { b.disabled = false; });
    };
  }

  /* ---------------- the agent ---------------- */

  function sampleAgent() { return C.cleanAgent({ name: S.NAME, profile: S.profile(), charter: S.charter(), drills: S.drills() }); }
  function blankAgent() { return C.cleanAgent({ name: '', profile: C.blankProfile(), charter: {}, drills: [] }); }

  function setAgent(agent, kind, id) {
    state.agent = C.cleanAgent(agent); state.kind = kind; state.id = id || null; state.dirty = false;
    state.reading = null; state.moreFixes = false;
    stopDrill(); state.drill = { phase: 'idle' };
    keep(K_OPEN, kind === 'saved' ? { id: id } : null);
    fillAll();
    drawAll(true);
  }

  var saveTimer = null;
  /** Something changed: keep it on this device, and a saved agent saves itself. */
  function changed() {
    if (state.kind === 'sample') { drawIntro(); return; }
    keep(K_DRAFT, { agent: state.agent, kind: state.kind, id: state.id, at: new Date().toISOString() });
    if (state.kind === 'saved') {
      state.dirty = true; drawIntro();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveAgent, 1200);
    } else drawIntro();
  }

  function saveAgent() {
    if (!signedIn()) return openAccount('Saving an agent to come back to needs a free account. Your work stays on this device meanwhile.');
    if (state.saving) { clearTimeout(saveTimer); saveTimer = setTimeout(saveAgent, 800); return; }
    state.saving = true; drawIntro();
    var body = { name: state.agent.name || P().name, profile: P(), charter: state.agent.charter, drills: state.agent.drills };
    var req = state.kind === 'saved' ? api('PUT', 'api/agents/' + encodeURIComponent(state.id), body) : api('POST', 'api/agents', body);
    req.then(function (r) {
      state.saving = false;
      var first = state.kind !== 'saved';
      state.kind = 'saved'; state.id = r.agent.id; state.dirty = false;
      state.agent.name = r.agent.name; state.agent.drills = r.agent.drills;
      if (first) { keep(K_OPEN, { id: r.agent.id }); toast('Saved to your account'); }
      keep(K_DRAFT, { agent: state.agent, kind: 'saved', id: state.id, at: new Date().toISOString() });
      drawIntro();
    }).catch(function (e) { state.saving = false; drawIntro(); showError(e); });
  }

  /* ---------------- the top of the page ---------------- */

  function drawIntro() {
    var el = $('#intro');
    if (state.kind === 'sample') {
      el.className = 'intro';
      el.innerHTML = '<p><span class="tagx">Example</span><b>' + esc(S.NAME) + '</b> <span class="made">(a made-up shop)</span><br>This is an example support agent - try the fixes, then check your own.</p>';
      return;
    }
    el.className = 'intro mine';
    var name = state.agent.name || P().name || 'My AI agent';
    var status = state.kind === 'local'
      ? (signedIn() ? 'On this device only' : 'Kept on this device · sign in to save it')
      : (state.saving ? 'Saving…' : state.dirty ? 'Unsaved changes' : 'Saved');
    el.innerHTML = '<p><span class="agent-name">' + esc(name) + '</span><br><span class="status">' + esc(status) + '</span></p>' +
      (state.kind === 'local' ? '<button class="btn small" type="button" id="saveIt">' + (signedIn() ? 'Save to my account' : 'Sign in to save') + '</button>' : '') +
      '<button class="btn small ghost" type="button" id="toSample">See the example</button>';
    var s = $('#saveIt'); if (s) s.onclick = saveAgent;
    $('#toSample').onclick = function () { setAgent(sampleAgent(), 'sample'); window.scrollTo(0, 0); };
  }

  function startOwn() {
    var had = recall(K_DRAFT);
    if (had && had.agent && had.kind === 'local' && had.agent.profile && Object.keys(had.agent.profile.caps || {}).length) {
      setAgent(had.agent, 'local');
      toast('Your agent on this device - the example is under Agents.');
    } else {
      setAgent(blankAgent(), 'local');
      changed();
    }
    setTab('pick');
    var p = $('#profile');
    p.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
    setTimeout(function () { $('#pName').focus({ preventScroll: true }); }, reduced() ? 0 : 450);
  }

  /* ---------------- the ring and the worst day ---------------- */

  var R = 82, CIRC = 2 * Math.PI * R;
  function buildRing() {
    var arcs = C.GROUPS.map(function (g) { return '<circle class="arc ' + g.id + '" data-g="' + g.id + '" cx="100" cy="100" r="' + R + '" fill="none" stroke-width="20" stroke-dasharray="0 ' + CIRC + '" stroke-dashoffset="0"/>'; }).join('');
    $('#ring').innerHTML = '<svg viewBox="0 0 200 200" aria-hidden="true" focusable="false"><circle class="track" cx="100" cy="100" r="' + R + '" fill="none" stroke-width="20"/>' + arcs + '</svg>' +
      '<div class="mid" aria-hidden="true"><span class="num" id="ringNum">0</span><span class="of">of 100</span><span class="band low" id="ringBand">Low</span></div>';
  }
  function drawRing(sc, instant) {
    var visible = sc.groups.filter(function (g) { return g.points > 0; }).length;
    var at = 0;
    sc.groups.forEach(function (g) {
      var el = $('.arc[data-g="' + g.id + '"]');
      var len = CIRC * g.points / 100;
      var gap = visible > 1 && len > 6 ? 3 : 0;
      el.setAttribute('stroke-dasharray', Math.max(0, len - gap).toFixed(2) + ' ' + CIRC.toFixed(2));
      el.setAttribute('stroke-dashoffset', (-at).toFixed(2));
      at += len;
    });
    var band = $('#ringBand');
    band.className = 'band ' + sc.band.id; band.textContent = sc.band.label;
    $('#ring').setAttribute('aria-label', C.ringText(sc));
    tweenNumber($('#ringNum'), state.shownScore, sc.score, instant);
    state.shownScore = sc.score;
  }
  var tweenId = 0;
  function tweenNumber(el, from, to, instant) {
    var id = ++tweenId;
    if (instant || reduced() || from === to) { el.textContent = String(to); return; }
    var t0 = null, dur = 650;
    function step(ts) {
      if (id !== tweenId) return;
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function drawHero(instant) {
    var sc = C.score(P());
    drawRing(sc, instant);
    $('#legend').innerHTML = sc.groups.slice().sort(function (a, b) { return b.points - a.points; }).map(function (g) {
      return '<li class="' + (g.points ? '' : 'zero') + '"><i class="dot-' + g.id + (g.points ? '' : ' off') + '"></i>' + esc(g.label) + ' <b>' + g.points + '</b></li>';
    }).join('');
    var w = C.worstDay(P());
    var el = $('#worst');
    el.className = 'worst' + (w.empty || !w.items.length ? ' quiet' : '');
    el.innerHTML = parts(w.parts);
    var notes = w.notes.slice();
    if (w.more.length) notes.unshift('Also, alone: ' + w.more.map(function (it) { return partsText(it.parts); }).join('; ') + '.');
    $('#notes').innerHTML = notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
    var cta = $('#heroCta');
    if (state.kind === 'sample') {
      cta.innerHTML = '<button class="btn big block" type="button" id="checkMine">Check my agent</button><p class="sub">Free, no account: tick what it can do. Or paste its prompt and let AI map it.</p>';
      $('#checkMine').onclick = startOwn;
    } else if (!Object.keys(P().caps).length) {
      cta.innerHTML = '<a class="btn block" href="#profile">Tick what it can do ↓</a>';
    } else cta.innerHTML = '';
    drawGroupPoints(sc);
    var js = $('#jumpScore');
    js.innerHTML = '<span class="n">' + sc.score + '</span> ' + esc(sc.band.label);
    js.className = 'jump-score ' + sc.band.id;
    js.setAttribute('aria-label', 'Blast radius ' + sc.score + ', ' + sc.band.label + '. Go to the score.');
  }

  /* ---------------- fixes ---------------- */

  function drawFixes() {
    var list = C.fixes(P());
    var box = $('#fixList');
    if (!Object.keys(P().caps).length) { box.innerHTML = '<p class="fix-empty">Nothing is switched on yet, so there is nothing to fix. Tick what it can do and the fixes that matter most show here, each with the points it takes off.</p>'; return; }
    if (!list.length) { box.innerHTML = '<p class="fix-empty">Nothing on our list would move the score now. Keep the charter current and run the drill now and then.</p>'; return; }
    var show = state.moreFixes ? list : list.slice(0, 3);
    box.innerHTML = '<ul class="fixlist">' + show.map(function (f) {
      return '<li data-fix="' + esc(f.id) + '"><span class="ft">' + esc(f.text) + '</span><span class="fx"><span class="pts" aria-label="' + esc('takes off ' + f.delta + ' points') + '">−' + f.delta + '</span><button class="btn small" type="button" data-apply="' + esc(f.id) + '">Apply</button></span></li>';
    }).join('') + '</ul>' +
      (list.length > 3 ? '<button class="link-btn" type="button" id="moreFixes">' + (state.moreFixes ? 'Show the top three' : 'Show ' + (list.length - 3) + ' more') + '</button>' : '') +
      '<p class="fix-foot">Each number is the score with that one change, re-worked. They overlap, so applying two will not always add up.</p>';
    $$('[data-apply]', box).forEach(function (b) { b.onclick = function () { applyFix(b.getAttribute('data-apply'), b); }; });
    var more = $('#moreFixes'); if (more) more.onclick = function () { state.moreFixes = !state.moreFixes; drawFixes(); };
  }
  function applyFix(id, btn) {
    var before = C.score(P()).score;
    state.agent.profile = C.applyFix(P(), id);
    var after = C.score(P()).score;
    if (btn) {
      var li = btn.closest('li');
      if (li) { li.classList.add('applied'); btn.outerHTML = '<span class="done">✓ Applied</span>'; }
    }
    drawHero();
    fillCapRows();
    fillProfileFields();
    drawCharter();
    changed();
    toast('Blast radius ' + before + ' → ' + after + (C.bandOf(after).id !== C.bandOf(before).id ? ' · now ' + C.bandOf(after).label : ''));
    setTimeout(drawFixes, reduced() ? 0 : 700);
    if (state.drill.phase === 'result') drawDrill();
  }

  /* ---------------- the profile ---------------- */

  function fillProfileFields() {
    var p = P();
    $('#pName').value = p.name; $('#pDoes').value = p.does;
    $('#pTalks').innerHTML = C.TALKS.map(function (t) { return '<button type="button" class="chip" data-talk="' + t.id + '" aria-pressed="' + (p.talksTo.indexOf(t.id) >= 0) + '">' + esc(t.label) + '</button>'; }).join('');
    $$('[data-talk]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-talk'), list = P().talksTo, i = list.indexOf(id);
        if (i >= 0) list.splice(i, 1); else list.push(id);
        b.setAttribute('aria-pressed', String(i < 0));
        drawCharter(); changed();
      };
    });
    $('#pWatch').innerHTML = C.WATCH.map(function (w) { return '<option value="' + w.id + '">' + esc(w.label) + '</option>'; }).join('');
    $('#pWatch').value = p.watch.mode;
    $('#everyWrap').hidden = p.watch.mode !== 'checks';
    $('#pEvery').value = p.watch.everyHours;
    $('#pRate').value = p.rate;
  }

  function limitValue(cat, v) { return v === null || v === undefined ? '' : cat.unit === 'money' ? C.plainMoney(v) : C.groups(v); }
  function capRowHtml(cat) {
    var c = P().caps[cat.id];
    var auto = c ? c.autonomy : 'off';
    var seg = '<div class="seg auto" role="group" aria-label="' + esc(cat.label + ': how free is it') + '">' + ['off', 'ask', 'alone'].map(function (v) {
      return '<button type="button" data-v="' + v + '" aria-pressed="' + (auto === v) + '">' + (v === 'off' ? 'Off' : v === 'ask' ? 'Asks first' : 'Alone') + '</button>';
    }).join('') + '</div>';
    var body = '';
    if (c) {
      var lims = cat.unit === 'money'
        ? '<label class="field"><span>Most per ' + esc(cat.one) + '</span><span class="money-in"><input class="input" data-lim="perAction" inputmode="decimal" autocomplete="off" placeholder="no limit" value="' + esc(limitValue(cat, c.perAction)) + '"></span></label>' +
          '<label class="field"><span>Most per day</span><span class="money-in"><input class="input" data-lim="perDay" inputmode="decimal" autocomplete="off" placeholder="no limit" value="' + esc(limitValue(cat, c.perDay)) + '"></span></label>'
        : '<label class="field wide"><span>Most ' + esc(cat.noun) + ' a day</span><input class="input" data-lim="perDay" inputmode="numeric" autocomplete="off" placeholder="no limit" value="' + esc(limitValue(cat, c.perDay)) + '"></label>';
      var undo = cat.undo === false ? '' : '<div class="wide undo-row"><span id="u-' + cat.id + '">Can it be undone?</span><div class="seg" role="group" aria-labelledby="u-' + cat.id + '">' + C.UNDO.map(function (u) {
        return '<button type="button" data-undo="' + u + '" aria-pressed="' + (c.undo === u) + '">' + (u === 'yes' ? 'Yes' : u === 'partly' ? 'Partly' : 'No') + '</button>';
      }).join('') + '</div></div>';
      body = '<div class="cap-body">' + lims +
        '<p class="fieldline wide" data-limerr hidden>Digits only - for example 500. Blank means no limit.</p>' +
        '<label class="switch wide"><input type="checkbox" data-logged' + (c.logged ? ' checked' : '') + '><span class="knob" aria-hidden="true"></span><span>Logged with enough detail to replay</span></label>' +
        undo + '</div>';
    }
    return '<div class="cap-top"><div><div class="cap-name">' + esc(cat.label) + '</div><p class="cap-desc">' + esc(cat.desc) + '</p></div>' + seg + '</div>' + body;
  }
  function buildChecklist() {
    $('#checklist').innerHTML = C.GROUPS.map(function (g) {
      return '<div class="group" data-group="' + g.id + '"><h3 class="group-h"><span class="gl"><i class="dot-' + g.id + '"></i>' + esc(g.label) + '</span><span class="gp" data-gp="' + g.id + '"></span></h3>' +
        C.CATALOG.filter(function (c) { return c.group === g.id; }).map(function (cat) { return '<div class="cap" data-cap="' + cat.id + '"></div>'; }).join('') + '</div>';
    }).join('');
    fillCapRows();
  }
  function fillCapRows() { C.CATALOG.forEach(function (cat) { fillCapRow(cat.id); }); drawGroupPoints(); }
  function fillCapRow(id) {
    var cat = C.BY_ID[id], el = $('.cap[data-cap="' + id + '"]');
    if (!el) return;
    el.innerHTML = capRowHtml(cat);
    el.classList.toggle('on', Boolean(P().caps[id]));
    wireCapRow(el, cat);
  }
  function capChanged(id) {
    drawHero(); drawFixes(); drawCharter(); changed();
    if (state.drill.phase === 'idle') drawDrill();
  }
  function wireCapRow(el, cat) {
    $$('.seg.auto button', el).forEach(function (b) {
      b.onclick = function () {
        var v = b.getAttribute('data-v'), caps = P().caps;
        if (v === 'off') delete caps[cat.id];
        else if (caps[cat.id]) caps[cat.id].autonomy = v;
        else caps[cat.id] = C.cleanCap(cat, { autonomy: v, logged: false, undo: cat.undo });
        fillCapRow(cat.id);
        var again = $('.cap[data-cap="' + cat.id + '"] .seg.auto button[data-v="' + v + '"]'); if (again) again.focus();
        capChanged(cat.id);
      };
    });
    $$('[data-lim]', el).forEach(function (inp) {
      inp.addEventListener('input', function () {
        var which = inp.getAttribute('data-lim'), c = P().caps[cat.id], raw = inp.value.trim();
        var v = raw === '' ? null : cat.unit === 'money' ? C.toCents(raw) : C.toCount(raw);
        var bad = raw !== '' && v === null;
        inp.setAttribute('aria-invalid', String(bad));
        var anyBad = $$('[data-lim]', el).some(function (x) { return x.getAttribute('aria-invalid') === 'true'; });
        $('[data-limerr]', el).hidden = !anyBad;
        if (bad) return;
        c[which] = v;
        capChanged(cat.id);
      });
    });
    var lg = $('[data-logged]', el);
    if (lg) lg.onchange = function () { P().caps[cat.id].logged = lg.checked; capChanged(cat.id); };
    $$('[data-undo]', el).forEach(function (b) {
      b.onclick = function () {
        P().caps[cat.id].undo = b.getAttribute('data-undo');
        $$('[data-undo]', el).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        capChanged(cat.id);
      };
    });
  }
  function drawGroupPoints(sc) {
    sc = sc || C.score(P());
    sc.groups.forEach(function (g) { var el = $('[data-gp="' + g.id + '"]'); if (el) el.textContent = g.points ? g.points + ' pts' : ''; });
    // Each switched-on capability's share of the score, for the row title.
    var weights = sc.caps.map(function (c) { return c.raw; });
    var pts = C.allocate(sc.score, weights);
    sc.caps.forEach(function (c, i) { var el = $('.cap[data-cap="' + c.id + '"] .cap-name'); if (el) el.setAttribute('data-pts', pts[i] + ' pts'); });
  }

  function setTab(t) {
    state.tab = t;
    $('#tabPick').setAttribute('aria-selected', String(t === 'pick'));
    $('#tabPaste').setAttribute('aria-selected', String(t === 'paste'));
    $('#panelPick').hidden = t !== 'pick';
    $('#panelPaste').hidden = t !== 'paste';
  }

  /* ---------------- read my agent (AI) ---------------- */

  function drawCount() { $('#pasteCount').textContent = C.groups($('#pasteBox').value.length) + ' / ' + C.groups(C.LIMITS.text); }
  function readPaste() {
    var out = $('#readOut');
    var text = $('#pasteBox').value;
    if (text.trim().length < C.LIMITS.textMin) { out.innerHTML = '<p class="err" role="alert">Paste a few lines at least: the system prompt, the tools, or the runbook.</p>'; return; }
    if (!signedIn()) return openAccount('Reading a prompt uses AI, so it needs a free account - it comes with $2 of credit. Ticking what it can do is free and needs no account.');
    if (state.busy) return;
    state.busy = true; $('#readBtn').disabled = true;
    out.innerHTML = '<p class="busy">Reading it - this takes a few seconds…</p>';
    api('POST', 'api/read', { text: text }).then(function (r) {
      state.busy = false; $('#readBtn').disabled = false;
      state.reading = r; drawReview();
      loadMe();
    }).catch(function (e) {
      state.busy = false; $('#readBtn').disabled = false;
      if (e.status === 403 && e.data && e.data.code === 'verify-email') return verifyNote(out, e, 'read it');
      if (e.status === 402) { out.innerHTML = ''; return openCredit(e.data); }
      showError(e, out);
    });
  }
  function guessLine(f) {
    var cat = C.BY_ID[f.id], bits = [f.autonomy === 'ask' ? 'Asks a human first' : 'Acts alone'];
    if (f.perAction !== null) bits.push('up to ' + C.dollars(f.perAction) + ' per ' + cat.one);
    if (f.perDay !== null) bits.push(C.limitText(cat, f.perDay) + ' a day');
    if (f.perAction === null && f.perDay === null) bits.push('no limit found');
    bits.push(f.confidence + ' confidence');
    return bits.join(' · ');
  }
  function drawReview() {
    var r = state.reading, out = $('#readOut');
    if (!r) { out.innerHTML = ''; return; }
    var n = r.found.length;
    out.innerHTML = '<h3 style="margin-top:14px">We found ' + n + ' capabilit' + (n === 1 ? 'y' : 'ies') + (n ? ' - apply?' : '') + '</h3>' +
      (r.unverified ? '<p class="warn">' + r.unverified + ' quote' + (r.unverified === 1 ? ' was' : 's were') + ' not found word for word in what you pasted. Check ' + (r.unverified === 1 ? 'it' : 'them') + ' before you apply.</p>' : '') +
      '<ul class="review">' + r.found.map(function (f, i) {
        var cat = C.BY_ID[f.id];
        return '<li class="' + (f.verified ? '' : 'unverified') + '"><label class="rv-head"><input type="checkbox" data-take="' + i + '" checked><span><span class="rv-name">' + esc(cat.label) + '</span><br><span class="rv-meta">' + esc(guessLine(f)) + '</span></span></label>' +
          (f.quote ? '<blockquote>' + esc(f.quote) + '</blockquote>' : '') +
          (f.verified ? '<p class="ok">✓ Found word for word in your text</p>' : '<p class="unv">⚠ Not found word for word in your text - the AI may have paraphrased. Check it.</p>') + '</li>';
      }).join('') + '</ul>' +
      (r.risks.length ? '<h3>Also worth a look</h3><p class="small muted">Not on the checklist, but the text shows them:</p><ul class="risks">' + r.risks.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
      '<p class="small muted">Applying sets each one\'s autonomy and limits. Logging and undo start at "not logged" and the usual answer - set them in the checklist.</p>' +
      '<div class="row">' + (n ? '<button class="btn" type="button" id="applyRead">Apply ' + n + ' to the profile</button>' : '') + '<button class="btn ghost" type="button" id="dropRead">Discard</button></div>';
    var ap = $('#applyRead');
    if (ap) {
      var count = function () { var k = $$('[data-take]', out).filter(function (x) { return x.checked; }).length; ap.textContent = 'Apply ' + k + ' to the profile'; ap.disabled = !k; };
      $$('[data-take]', out).forEach(function (x) { x.onchange = count; });
      ap.onclick = function () {
        var take = $$('[data-take]', out).filter(function (x) { return x.checked; }).map(function (x) { return r.found[Number(x.getAttribute('data-take'))]; });
        state.agent.profile = C.applyFindings(P(), take);
        state.reading = null; out.innerHTML = '';
        fillCapRows(); drawHero(); drawFixes(); drawCharter(); drawDrill(); changed();
        setTab('pick');
        toast('Applied ' + take.length + ' - now check logging and undo for each.', 3600);
        $('#radius').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
      };
    }
    $('#dropRead').onclick = function () { state.reading = null; out.innerHTML = ''; };
  }

  /* ---------------- the drill ---------------- */

  var tick = null;
  function stopDrill() { if (tick) { clearInterval(tick); tick = null; } }

  function drawDrill() {
    var d = state.drill, box = $('#drillBody');
    if (d.phase === 'round') return drawRound();
    if (d.phase === 'result') return drawResult();
    var on = Object.keys(P().caps).length;
    var hist = state.agent.drills || [];
    var last = hist[hist.length - 1];
    box.innerHTML = '<div class="drill-intro"><p><b>Three things go wrong. You have 60 seconds for each.</b> Pick what you would do. The cards come from what your agent can do, and the score comes from how ready you really are - your kill switch, logs, approvals, limits and undo - not just your answers.</p></div>' +
      '<div class="drill-go">' + (on ? '<button class="btn big" type="button" id="drillGo">Start the drill</button>' : '<button class="btn big" type="button" disabled>Start the drill</button><span class="small muted">Switch on what it can do first.</span>') + '</div>' +
      (last ? '<p class="small">Last drill (' + esc(shortDate(last.at)) + '): <b>' + last.readiness + '</b> ready · best call on ' + last.calls + ' of ' + last.rounds + '.</p>' +
        (hist.length > 1 ? '<div class="history" aria-hidden="true">' + hist.slice(-20).map(function (h) { return '<i style="height:' + Math.max(3, Math.round(h.readiness * 0.44)) + 'px"></i>'; }).join('') + '</div><p class="hist-cap">Readiness, last ' + Math.min(20, hist.length) + ' drills</p>' : '') : '');
    var go = $('#drillGo');
    if (go) go.onclick = startDrill;
  }
  function startDrill() {
    var seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    var dealt = C.deal(P(), seed);
    if (!dealt.length) return;
    state.drill = { phase: 'round', dealt: dealt, picks: [], k: 0, left: DRILL_SECS * 1000, paused: false, answered: false, started: Date.now() };
    drawRound(true);
    $('#drill').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
    runClock();
  }
  function runClock() {
    stopDrill();
    var d = state.drill;
    d.lastTs = Date.now();
    tick = setInterval(function () {
      if (d !== state.drill || d.phase !== 'round' || d.answered) return stopDrill();
      if (d.paused) { d.lastTs = Date.now(); return; }
      var t = Date.now();
      d.left -= t - d.lastTs; d.lastTs = t;
      if (d.left <= 0) { d.left = 0; drawClock(); choose(null); return; }
      drawClock();
    }, 250);
  }
  function drawClock() {
    var d = state.drill, secs = Math.ceil(d.left / 1000);
    var s = $('#secs'), bar = $('#bar');
    if (!s) return;
    s.textContent = secs + 's';
    var cls = secs <= 10 ? 'crit' : secs <= 20 ? 'low' : '';
    s.className = 'secs ' + cls; bar.className = 'bar ' + cls;
    $('i', bar).style.width = (100 * d.left / (DRILL_SECS * 1000)).toFixed(1) + '%';
  }
  function drawRound(focus) {
    var d = state.drill, box = $('#drillBody');
    var dealt = d.dealt[d.k];
    var ev = C.evaluate(dealt, P(), state.agent.charter);
    var cat = ev.focus ? C.BY_ID[ev.focus] : null;
    var pick = d.picks[d.k];
    box.innerHTML = '<div class="round-top"><span class="round-n">Card ' + (d.k + 1) + ' of ' + d.dealt.length + '</span>' +
      '<span class="clock">' + (d.answered ? '' : '<span class="secs" id="secs" aria-hidden="true"></span><button class="btn small ghost" type="button" id="pause">' + (d.paused ? 'Resume' : 'Pause') + '</button>') + '</span></div>' +
      (d.answered ? '' : '<div class="bar" id="bar" role="progressbar" aria-label="Time left" aria-valuemin="0" aria-valuemax="60"><i></i></div>') +
      '<div class="scenario">' + (cat ? '<span class="focus">' + esc(cat.label) + '</span>' : '<span class="focus">Any agent</span>') + '<h3>' + esc(ev.title) + '</h3><p>' + esc(ev.text) + '</p></div>' +
      (d.paused && !d.answered ? '<p class="small muted">Paused. Talk it through, then resume to answer.</p>' : '') +
      '<ul class="choices">' + ev.responses.map(function (r, j) {
        var cls = '';
        if (d.answered) { if (r.i === ev.best) cls += ' best'; if (pick === r.i) cls += ' picked'; }
        var verdict = !d.answered ? '' : r.i === ev.best ? (pick === r.i ? 'Best call' : 'Best call here') : pick === r.i ? (r.works ? 'Helps, but not the best' : 'Does not work here') : '';
        return '<li><button class="choice' + cls + '" type="button" data-pick="' + r.i + '"' + (d.answered || d.paused ? ' disabled' : '') + '><span class="k">' + 'ABCD'.charAt(j) + '</span><span>' + esc(r.text) +
          (d.answered ? (verdict ? '<span class="verdict"> · ' + esc(verdict) + '</span>' : '') + '<span class="what">' + esc(r.outcome) + '</span>' : '') + '</span></button></li>';
      }).join('') + '</ul>' +
      (d.answered ? '<p class="round-note">' + esc(d.timedOut ? 'Time ran out - in a real incident, it is still running.' : pick === ev.best ? 'Best call.' : 'Not the best call for this agent.') + ' Readiness on this card: ' + ev.prep.points + '/100.</p>' +
        '<div class="row"><button class="btn" type="button" id="nextCard">' + (d.k + 1 < d.dealt.length ? 'Next card →' : 'See how ready you are') + '</button></div>' : '');
    if (!d.answered) {
      drawClock();
      $('#pause').onclick = function () { d.paused = !d.paused; drawRound(); if (!d.paused) { var b = $('[data-pick]'); if (b) b.focus(); } else $('#pause').focus(); };
      $$('[data-pick]', box).forEach(function (b) { b.onclick = function () { choose(Number(b.getAttribute('data-pick'))); }; });
      if (focus) { var first = $('[data-pick]', box); if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 30); }
    } else {
      $('#nextCard').onclick = nextCard;
      $('#nextCard').focus({ preventScroll: true });
    }
  }
  function choose(i) {
    var d = state.drill;
    if (d.phase !== 'round' || d.answered) return;
    stopDrill();
    d.picks[d.k] = i; d.answered = true; d.timedOut = i === null;
    drawRound();
  }
  function nextCard() {
    var d = state.drill;
    if (d.k + 1 < d.dealt.length) {
      d.k++; d.answered = false; d.timedOut = false; d.left = DRILL_SECS * 1000; d.paused = false;
      drawRound(true); runClock();
      return;
    }
    finishDrill();
  }
  function finishDrill() {
    var d = state.drill;
    var res = C.result(d.dealt, d.picks, P(), state.agent.charter);
    d.phase = 'result'; d.res = res; d.fresh = true;
    var rec = { at: new Date().toISOString(), readiness: res.readiness, calls: res.calls, rounds: res.rounds.length };
    state.agent.drills = C.cleanDrills((state.agent.drills || []).concat([rec]));
    if (state.kind === 'saved' && signedIn()) {
      api('POST', 'api/agents/' + encodeURIComponent(state.id) + '/drills', { readiness: rec.readiness, calls: rec.calls, rounds: rec.rounds })
        .then(function (r) { state.agent.drills = r.agent.drills; keep(K_DRAFT, { agent: state.agent, kind: 'saved', id: state.id, at: new Date().toISOString() }); })
        .catch(function () { toast('The drill result could not be saved.'); });
    } else changed();
    drawDrill();
  }
  function drawResult() {
    var d = state.drill, res = d.res, box = $('#drillBody');
    var cls = res.readiness >= 80 ? 'ready' : res.readiness >= 50 ? 'shaky' : 'not';
    box.innerHTML = '<div class="stamp"><span class="score">' + res.readiness + '</span><span><span class="small muted">ready out of 100</span><br><span class="word ' + cls + (d.fresh && !reduced() ? ' anim' : '') + '">' + esc(res.label) + '</span></span></div>' +
      '<p><b>Best call on ' + res.calls + ' of ' + res.rounds.length + '.</b> ' + esc(res.readiness >= 80 ? 'Your charter and limits would carry you through a bad day.' : 'Readiness is what you had in place, not just what you picked - the fixes below raise it.') + '</p>' +
      '<ul class="rounds">' + res.rounds.map(function (r) { return '<li><span>' + esc(r.title) + (r.timedOut ? ' · time ran out' : r.bestCall ? ' · best call' : '') + '</span><b>' + r.prep + '</b></li>'; }).join('') + '</ul>' +
      (res.saves.length ? '<h3>What would have saved you</h3><ul class="saves">' + res.saves.slice(0, d.allSaves ? res.saves.length : 4).map(function (s, i) {
        var done = s.kind === 'fix' && JSON.stringify(C.applyFix(P(), s.fix)) === JSON.stringify(C.cleanProfile(P()));
        return '<li><span>' + esc(s.text) + '</span>' + (done ? '<span class="done">✓ Done</span>' : '<button class="btn small ' + (s.kind === 'fix' ? '' : 'ghost') + '" type="button" data-save="' + i + '">' + (s.kind === 'fix' ? 'Apply' : 'Fill it in') + '</button>') + '</li>';
      }).join('') + '</ul>' + (res.saves.length > 4 && !d.allSaves ? '<button class="link-btn" type="button" id="allSaves">Show ' + (res.saves.length - 4) + ' more</button>' : '') : '<p>Nothing on our list would have saved you more. Nicely done.</p>') +
      '<div class="row"><button class="btn" type="button" id="again">Run another drill</button><button class="btn ghost" type="button" id="drillDone">Done</button></div>';
    d.fresh = false;
    $$('[data-save]', box).forEach(function (b) {
      b.onclick = function () {
        var s = res.saves[Number(b.getAttribute('data-save'))];
        if (s.kind === 'fix') { applyFix(s.fix); b.outerHTML = '<span class="done">✓ Done</span>'; return; }
        var map = { killOwner: '#cOwner', killHow: '#cHow', review: '#cReview', logRetention: '#cRetention' };
        var f = $(map[s.field] || '#cOwner');
        $('#charter').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
        setTimeout(function () { f.focus({ preventScroll: true }); f.classList.add('flash'); setTimeout(function () { f.classList.remove('flash'); }, 1300); }, reduced() ? 0 : 450);
      };
    });
    var all = $('#allSaves'); if (all) all.onclick = function () { d.allSaves = true; drawResult(); };
    $('#again').onclick = startDrill;
    $('#drillDone').onclick = function () { state.drill = { phase: 'idle' }; drawDrill(); };
  }

  /* ---------------- the charter ---------------- */

  function fillCharter() {
    var ch = state.agent.charter;
    $('#cOwner').value = ch.killOwner; $('#cHow').value = ch.killHow; $('#cSpeed').value = ch.killSpeed; $('#cRetention').value = ch.logRetention;
    $('#cReview').innerHTML = '<option value="">Not set</option>' + C.CADENCE.map(function (c) { return '<option value="' + c.id + '">' + esc(c.label) + '</option>'; }).join('');
    $('#cReview').value = ch.review;
  }
  function tbd(v) { return v ? esc(v) : '<span class="tbd">not set yet</span>'; }
  function charterHtml(m, print) {
    var H = print ? ['h1', 'h2'] : ['h3', 'h4'];
    function items(list) { return list.length ? '<ul>' + list.map(function (x) { return '<li><b>' + esc(x.label) + '</b> - ' + esc(x.detail) + '</li>'; }).join('') + '</ul>' : '<ul><li>Nothing.</li></ul>'; }
    return '<' + H[0] + '>' + esc(m.title) + '</' + H[0] + '>' +
      m.summary.map(function (s) { return '<p class="sum">' + esc(s) + '</p>'; }).join('') +
      '<p class="sum">' + (m.asOf ? 'Written ' + esc(m.asOf) + '. ' : '') + 'Blast radius today: ' + esc(m.blast) + '.</p>' +
      '<' + H[1] + '>What it may do alone</' + H[1] + '>' + items(m.alone) +
      '<' + H[1] + '>What needs a human first</' + H[1] + '>' + items(m.ask) +
      (m.off.length ? '<' + H[1] + '>Not allowed</' + H[1] + '><p class="small">' + esc(m.off.join('; ')) + '.</p>' : '') +
      '<' + H[1] + '>The kill switch</' + H[1] + '><ul><li>Owner: ' + tbd(m.kill.owner) + '</li><li>How: ' + tbd(m.kill.how) + '</li><li>How fast: ' + tbd(m.kill.speed) + '</li></ul>' +
      '<' + H[1] + '>Logs</' + H[1] + '><ul><li>Logged in enough detail to replay: ' + (m.logs.logged.length ? esc(m.logs.logged.join(', ')) : 'nothing yet') + '</li>' +
      (m.logs.unlogged.length ? '<li>Not logged to replay: ' + esc(m.logs.unlogged.join(', ')) + '</li>' : '') + '<li>Kept for: ' + tbd(m.logs.retention) + '</li></ul>' +
      '<' + H[1] + '>Review</' + H[1] + '><ul><li>' + tbd(m.review) + ': re-check what it can do, its limits and this charter.</li></ul>' +
      '<' + H[1] + '>The first hour if something goes wrong</' + H[1] + '><ol>' + m.firstHour.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      (print ? '<p class="disc">' + esc(C.DISCLAIMER) + '</p>' : '');
  }
  function drawCharter() {
    $('#charterDoc').innerHTML = charterHtml(C.charter(P(), state.agent.charter, today()), false);
  }
  function charterName() { return (P().name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent'; }
  function markdown() { return C.charterMarkdown(P(), state.agent.charter, today()); }

  /* ---------------- everything ---------------- */

  function fillAll() {
    fillProfileFields(); buildChecklist(); fillCharter(); setTab('pick');
    $('#readOut').innerHTML = '';
  }
  function drawAll(instant) { drawIntro(); drawHero(instant); drawFixes(); drawDrill(); drawCharter(); }

  /* ---------------- agents ---------------- */

  function openAgents() {
    var local = recall(K_DRAFT);
    sheet('<h2>Agents</h2><div id="agentList"><p class="busy">Loading…</p></div>', function (root) {
      var list = $('#agentList', root);
      function draw(saved, limit) {
        var rows = [];
        if (local && local.agent && local.kind === 'local') rows.push('<li><span><span class="nm">' + esc(local.agent.name || (local.agent.profile && local.agent.profile.name) || 'My AI agent') + '</span><br><span class="small muted">On this device · not saved yet</span></span><span class="acts"><button class="btn small" type="button" data-local="1">Open</button></span></li>');
        (saved || []).forEach(function (a) {
          rows.push('<li><span><span class="nm">' + esc(a.name) + '</span><br><span class="small muted">' + esc(a.score + ' · ' + a.band) + ' · ' + a.caps + ' capabilit' + (a.caps === 1 ? 'y' : 'ies') + (a.readiness !== null ? ' · drill ' + a.readiness : '') + '</span></span>' +
            '<span class="acts"><button class="btn small" type="button" data-open="' + esc(a.id) + '">Open</button><button class="btn small ghost" type="button" data-more="' + esc(a.id) + '" aria-label="' + esc('More for ' + a.name) + '">⋯</button></span></li>');
        });
        rows.push('<li><span><span class="nm">The example</span><br><span class="small muted">' + esc(S.NAME) + ' · always here</span></span><span class="acts"><button class="btn small ghost" type="button" data-sample="1">Open</button></span></li>');
        list.innerHTML = '<ul class="agents">' + rows.join('') + '</ul>' +
          (saved ? '<p class="small muted">' + saved.length + ' of ' + limit + ' saved. An agent keeps its profile, charter and drill scores - never what you pasted for the AI to read.</p>' : '<p class="small muted">Sign in to save agents and come back to them on any device.</p>') +
          '<div class="row"><button class="btn" type="button" id="newAgent">Check a new agent</button>' + (saved ? '' : '<button class="btn ghost" type="button" id="aSign">Sign in</button>') + '</div>';
        $$('[data-open]', root).forEach(function (b) { b.onclick = function () { openSaved(b.getAttribute('data-open')); }; });
        $$('[data-more]', root).forEach(function (b) { b.onclick = function () { agentMenu(saved.filter(function (a) { return a.id === b.getAttribute('data-more'); })[0]); }; });
        var lb = $('[data-local]', root); if (lb) lb.onclick = function () { closeSheet(); setAgent(local.agent, 'local'); window.scrollTo(0, 0); };
        $('[data-sample]', root).onclick = function () { closeSheet(); setAgent(sampleAgent(), 'sample'); window.scrollTo(0, 0); };
        $('#newAgent', root).onclick = function () {
          if (local && local.kind === 'local' && local.agent && Object.keys((local.agent.profile || {}).caps || {}).length && !confirm('Start a new agent? The one on this device will be replaced. (Sign in to save the ones you want to keep.)')) return;
          closeSheet(); keep(K_DRAFT, null); startOwn();
        };
        var sg = $('#aSign', root); if (sg) sg.onclick = function () { closeSheet(); openAccount(); };
      }
      if (!signedIn()) return draw(null);
      api('GET', 'api/agents').then(function (r) { draw(r.agents, r.limit); }).catch(function (e) { showError(e, list); });
    });
  }
  function openSaved(id) {
    api('GET', 'api/agents/' + encodeURIComponent(id)).then(function (r) { closeSheet(); setAgent(r.agent, 'saved', r.agent.id); window.scrollTo(0, 0); }).catch(function (e) { showError(e); });
  }
  function agentMenu(a) {
    sheet('<h2>' + esc(a.name) + '</h2><label class="field"><span>Name</span><input class="input" id="rn" maxlength="80" value="' + esc(a.name) + '"></label><div id="rnErr"></div>' +
      '<div class="row"><button class="btn" type="button" id="rnOk">Rename</button><button class="btn ghost" type="button" id="dup">Duplicate</button><button class="btn ghost danger" type="button" id="del">Delete</button></div>', function (root) {
      $('#rnOk', root).onclick = function () {
        api('PATCH', 'api/agents/' + encodeURIComponent(a.id), { name: $('#rn', root).value }).then(function (r) {
          if (state.id === a.id) { state.agent.name = r.agent.name; drawIntro(); }
          toast('Renamed'); openAgents();
        }).catch(function (e) { showError(e, $('#rnErr', root)); });
      };
      $('#dup', root).onclick = function () { api('POST', 'api/agents/' + encodeURIComponent(a.id) + '/duplicate').then(function () { toast('Duplicated'); openAgents(); }).catch(function (e) { showError(e, $('#rnErr', root)); }); };
      $('#del', root).onclick = function () {
        if (!confirm('Delete “' + a.name + '” - its profile, charter and drill scores? This cannot be undone.')) return;
        api('DELETE', 'api/agents/' + encodeURIComponent(a.id)).then(function () {
          toast('Deleted');
          if (state.id === a.id) { keep(K_DRAFT, null); setAgent(sampleAgent(), 'sample'); }
          openAgents();
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
    $('#agentsBtn').onclick = openAgents;
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
    var f = s.querySelector('input, select, textarea, button:not(.close)') || $('#sheetClose');
    setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  var FREE_LINE = 'The checklist, the score, the worst day, the fixes, the drill and the charter are free and need no account. Reading a prompt with AI needs a free account - it comes with $2 of credit. One account works across every app on this site.';

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
  /** Signed in: an agent made on this device is offered to the account. */
  function afterSignIn() {
    drawIntro();
    if (state.kind === 'local' && signedIn() && (Object.keys(P().caps).length || P().name)) {
      sheet('<h2>Save this agent to your account?</h2><p class="muted">You checked “' + esc(state.agent.name || P().name || 'My AI agent') + '” on this device. Save it to come back to it anywhere - its profile, charter and drill scores, never anything you pasted.</p><div class="row"><button class="btn" type="button" id="offerYes">Save it</button><button class="btn ghost" type="button" id="offerNo">Not now</button></div>', function (root) {
        $('#offerYes', root).onclick = function () { closeSheet(); saveAgent(); };
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
      '<p class="small muted" style="margin:6px 0 0">Reading a prompt costs a cent or two. Everything else is free.</p><div id="billing"></div></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawBilling($('#billing', root));
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () {
            closeSheet(); state.me = { signedIn: false }; drawTop();
            if (state.kind === 'saved') { keep(K_DRAFT, null); keep(K_OPEN, null); setAgent(sampleAgent(), 'sample'); } else drawIntro();
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && (data.detail || data.error)) || 'Your AI credit is spent.') + '</p><p class="small muted">The checklist, the score, the fixes, the drill, the charter and your saved agents keep working, free.</p><div id="billing"></div>' +
      (data && data.topUpUrl ? '<p><a class="btn small ghost" href="' + esc(data.topUpUrl) + '">Top up</a></p>' : ''),
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- wiring ---------------- */

  $('#pName').addEventListener('input', function (e) { P().name = e.target.value; if (state.kind !== 'saved') state.agent.name = e.target.value; drawCharter(); changed(); });
  $('#pDoes').addEventListener('input', function (e) { P().does = e.target.value; drawCharter(); changed(); });
  $('#pWatch').onchange = function (e) {
    P().watch.mode = e.target.value;
    $('#everyWrap').hidden = e.target.value !== 'checks';
    drawHero(); drawFixes(); drawCharter(); changed();
  };
  $('#pEvery').addEventListener('input', function (e) {
    var n = C.toCount(e.target.value);
    e.target.setAttribute('aria-invalid', String(n === null || n < 1 || n > 168));
    if (n === null || n < 1 || n > 168) return;
    P().watch.everyHours = n; drawHero(); drawFixes(); drawCharter(); changed();
  });
  $('#pRate').addEventListener('input', function (e) {
    var n = C.toCount(e.target.value);
    e.target.setAttribute('aria-invalid', String(n === null || n < 1));
    if (n === null || n < 1) return;
    P().rate = Math.min(n, C.LIMITS.maxRate); drawHero(); changed();
  });
  $('#tabPick').onclick = function () { setTab('pick'); };
  $('#tabPaste').onclick = function () { setTab('paste'); $('#pasteBox').focus(); };
  $$('[role=tab]').forEach(function (t) {
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var next = state.tab === 'pick' ? 'paste' : 'pick';
      setTab(next); $(next === 'pick' ? '#tabPick' : '#tabPaste').focus();
    });
  });
  $('#pasteBox').addEventListener('input', drawCount);
  $('#pasteSample').onclick = function () { $('#pasteBox').value = S.PROMPT; drawCount(); $('#pasteBox').focus(); };
  $('#readBtn').onclick = readPaste;

  function charterInput(sel, key) {
    $(sel).addEventListener('input', function (e) { state.agent.charter[key] = e.target.value; drawCharter(); changed(); });
  }
  charterInput('#cOwner', 'killOwner'); charterInput('#cHow', 'killHow'); charterInput('#cSpeed', 'killSpeed'); charterInput('#cRetention', 'logRetention');
  $('#cReview').onchange = function (e) { state.agent.charter.review = e.target.value; drawCharter(); changed(); };
  $('#copyMd').onclick = function () { copy(markdown(), 'Charter copied as Markdown'); };
  $('#dlMd').onclick = function () {
    var blob = new Blob([markdown()], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'charter-' + charterName() + '.md';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  $('#printBtn').onclick = function () {
    $('#printArea').innerHTML = charterHtml(C.charter(P(), state.agent.charter, today()), true);
    window.print();
  };
  window.addEventListener('beforeprint', function () { $('#printArea').innerHTML = charterHtml(C.charter(P(), state.agent.charter, today()), true); });

  $('#howList').innerHTML = C.HOW.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('');
  $('#disclaim').textContent = C.DISCLAIMER;
  buildRing();

  /* ---------------- start ---------------- */

  // The example opens first, always, unless this device has an agent in
  // progress - then that one (the example is one tap away in Agents).
  var draft = recall(K_DRAFT);
  if (draft && draft.agent && draft.kind === 'local') setAgent(draft.agent, 'local');
  else setAgent(sampleAgent(), 'sample');
  drawTop();
  loadMe().then(function () {
    drawIntro();
    var open = recall(K_OPEN);
    if (signedIn() && open && open.id && state.kind === 'sample') {
      api('GET', 'api/agents/' + encodeURIComponent(open.id)).then(function (r) { setAgent(r.agent, 'saved', r.agent.id); }).catch(function () { keep(K_OPEN, null); });
    }
    if (/[?&](topup|member|credited)=1\b/.test(location.search) && signedIn()) openSettings();
  });
})();
