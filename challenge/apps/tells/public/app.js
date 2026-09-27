/* Tells - the page. One file, no build step. Every string that came from
 * outside this file (pasted text, a fetched page, a file's metadata, a
 * model's reasons, a source's title) is escaped before it is drawn. */
(function () {
  'use strict';

  var Core = window.TellsCore;
  var Meta = window.TellsMeta;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = Core.escapeHtml;
  var BASE = new URL('.', document.baseURI).pathname;
  var K_HIST = 'tells-history-v1';
  var PREVIEW_PX = 1024;
  var FRAME_PX = 768;
  var FRAMES = 6;
  var LOCAL_FILE_MAX = 60 * 1024 * 1024;     // pictures read on this device
  var VIDEO_WINDOW = 16 * 1024 * 1024;        // head and tail scanned in a video

  var state = {
    me: null,
    tab: 'text',
    busy: {},
    r: null,          // the current result: {kind, text, quick, deep, originality, meta, visual, page, sample, frames}
    samples: null,
    picture: null,    // {name, url, preview (base64)}
    video: null,      // {name, frames: [{data, t, url}]}
  };

  /* ---------------- plumbing ---------------- */

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        // Long checks stream whitespace and so answer 200 even on failure;
        // an {error} body is a failure however it arrived.
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
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast(what || 'Copied'); }, function () { toast('Select it and copy it by hand.'); });
  }
  function recall(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function keep(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function signedIn() { return Boolean(state.me && state.me.signedIn); }
  function pkOk() { return Boolean(window.Passkey && Passkey.supported() && !/\.run\.app$/.test(location.hostname)); }
  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(s);
  }
  function blobB64(blob) { return blob.arrayBuffer().then(function (b) { return b64(new Uint8Array(b)); }); }
  function mb(n) { return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (Math.round(n / 104857.6) / 10) + ' MB'; }

  function showError(err, where) {
    if (err && err.status === 402) return openCredit(err.data);
    if (err && err.status === 401) return openAccount('Sign in to keep going.');
    var msg = (err && err.message) || 'Something went wrong.';
    if (where) where.innerHTML = '<p class="err" role="alert">' + esc(msg) + '</p>';
    else toast(msg, 4200);
  }

  /* ---------------- account ---------------- */

  function loadMe() {
    return api('GET', 'api/me').then(function (me) { state.me = me; drawTop(); return me; })
      .catch(function () { state.me = { signedIn: false }; drawTop(); return state.me; });
  }
  function drawTop() {
    var b = $('#acct');
    b.textContent = signedIn() ? 'Settings' : 'Sign in';
    b.onclick = function () { if (signedIn()) openSettings(); else openAccount(); };
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
    var f = s.querySelector('input, button:not(.close)') || $('#sheetClose');
    setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function closeSheet() {
    $('#sheet').hidden = true; $('#sheetBack').hidden = true; $('#sheet').innerHTML = '';
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) { /* ignore */ }
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  var FREE_LINE = 'The quick scan and the metadata scan are always free and never need an account. A deep read, the originality check and a visual read use AI, so they need a free account: it comes with $2 of credit, enough for well over a hundred deep reads. One account works across every app on this site.';

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
          .then(function () { closeSheet(); return loadMe(); }).then(function () { toast('You’re in.'); drawAll(); })
          .catch(function (err) { btn.disabled = false; showError(err, $('#authErr', root)); });
      };
      var pk = $('#pkBtn', root);
      if (pk) pk.onclick = function () {
        Passkey.signIn(BASE + 'api/auth/passkey').then(function () { closeSheet(); return loadMe(); }).then(drawAll)
          .catch(function (err) { if (!Passkey.cancelled(err)) showError(err, $('#authErr', root)); });
      };
    }
    sheet('<div class="body"></div>', draw);
  }

  function openSettings() {
    var me = state.me, b = me.budget || {};
    var left = b.unlimited ? 'Unlimited' : '$' + Number(b.remainingUsd || 0).toFixed(2) + ' left';
    sheet(
      '<h2>Settings</h2><p class="small muted">' + esc(me.email) + ' · ' + (me.tier === 'paid' ? 'member model' : 'free model') + '</p>' +
      '<div class="note"><div class="row spread"><b>AI credit</b><span>' + esc(left) + '</span></div>' +
      '<p class="small muted" style="margin:6px 0 0">A deep read costs about a cent, an originality check about 5¢ (web searches are most of it), a visual read under a cent. The quick scan and metadata are free.</p><div id="billing"></div></div>' +
      '<h3 style="margin-top:16px">Device keys</h3>' +
      '<p class="small muted">For the Chrome extension and the iPhone Shortcut: a key lets them check things as you, charged to this account. It is shown once; Tells keeps only a scrambled fingerprint of it. Up to 5.</p>' +
      '<ul class="devices" id="devList"><li class="muted small">Loading…</li></ul>' +
      '<div class="row"><input class="input" id="devLabel" maxlength="40" placeholder="Name it, e.g. “Work laptop”"><button class="btn small" id="devMake" type="button">Make a key</button></div>' +
      '<div id="devNew"></div>' +
      (pkOk() ? '<button class="btn ghost block" id="pkEnrol" type="button" style="margin-top:14px">Set up Face ID for this device</button>' : '') +
      '<button class="btn ghost block" id="signOut" type="button" style="margin-top:10px">Sign out</button>',
      function (root) {
        drawDevices(root);
        drawBilling($('#billing', root));
        $('#devMake', root).onclick = function () {
          var btn = this; btn.disabled = true;
          api('POST', 'api/devices', { label: $('#devLabel', root).value }).then(function (r) {
            btn.disabled = false; $('#devLabel', root).value = '';
            $('#devNew', root).innerHTML = '<div class="note warn" role="status"><b>Copy it now: it will not be shown again.</b><div class="keybox" id="newKey" style="margin:8px 0">' + esc(r.key) + '</div><button class="btn small" id="copyKey" type="button">Copy key</button></div>';
            $('#copyKey', root).onclick = function () { copy(r.key, 'Key copied'); };
            drawDevices(root);
          }).catch(function (e) { btn.disabled = false; showError(e, $('#devNew', root)); });
        };
        $('#signOut', root).onclick = function () {
          api('POST', 'api/auth/logout').then(function () { closeSheet(); state.me = { signedIn: false }; drawTop(); drawAll(); });
        };
        var pk = $('#pkEnrol', root);
        if (pk) pk.onclick = function () {
          var pw = prompt('Your password, to confirm it is you:');
          if (!pw) return;
          Passkey.enrol({ password: pw }, BASE + 'api/auth/passkey').then(function () { toast('Face ID is set up.'); }).catch(function (e) { if (!Passkey.cancelled(e)) showError(e); });
        };
      });
  }
  function drawDevices(root) {
    api('GET', 'api/devices').then(function (r) {
      var ul = $('#devList', root);
      if (!r.devices.length) { ul.innerHTML = '<li class="muted small">No device keys yet.</li>'; return; }
      ul.innerHTML = r.devices.map(function (d) {
        return '<li><span><b>' + esc(d.label) + '</b><br><span class="small muted">Made ' + esc(String(d.createdAt).slice(0, 10)) + (d.lastUsedAt ? ' · last used ' + esc(String(d.lastUsedAt).slice(0, 10)) : ' · not used yet') + '</span></span>' +
          '<button class="btn small ghost" type="button" data-revoke="' + esc(d.id) + '">Revoke</button></li>';
      }).join('');
      $$('[data-revoke]', ul).forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Revoke “' + b.closest('li').querySelector('b').textContent + '”? Anything using it stops working at once.')) return;
          api('DELETE', 'api/devices/' + encodeURIComponent(b.getAttribute('data-revoke'))).then(function () { toast('Revoked'); drawDevices(root); }).catch(function (e) { showError(e); });
        };
      });
    }).catch(function (e) { showError(e, $('#devList', root)); });
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
    sheet('<h2>Out of AI credit</h2><p class="muted">' + esc((data && data.detail) || 'Your AI credit is spent.') + '</p><p class="small muted">The quick scan and the metadata scan keep working, free.</p><div id="billing"></div>',
      function (root) { drawBilling($('#billing', root)); });
  }

  /* ---------------- tabs ---------------- */

  function setTab(tab, focus) {
    state.tab = tab;
    $$('[role=tab]').forEach(function (b) {
      var on = b.getAttribute('data-tab') === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    $$('[role=tabpanel]').forEach(function (p) { p.hidden = p.id !== 'panel-' + tab; });
    drawActions();
  }
  $$('[role=tab]').forEach(function (b, i, all) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
    b.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      setTab(all[(i + d + all.length) % all.length].getAttribute('data-tab'), true);
    });
  });

  /* ---------------- text ---------------- */

  var textEl = $('#text');
  var pending = false;
  function onText() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      var t = textEl.value;
      var n = Core.words(t).length;
      $('#count').textContent = n + (n === 1 ? ' word' : ' words');
      if (!t.trim()) { if (state.r && state.r.kind === 'text') { state.r = null; drawResult(); } drawActions(); return; }
      var text = Core.clean(t, Core.LIMITS.text).trim();
      if (state.r && state.r.kind === 'text' && state.r.text === text && !state.r.sample) return;
      state.r = { kind: 'text', text: text, quick: Core.scan(text) };
      drawResult(); drawActions();
    });
  }
  textEl.addEventListener('input', onText);

  function loadSamples() {
    if (state.samples) return Promise.resolve(state.samples);
    return api('GET', 'api/samples').then(function (s) { state.samples = s; return s; });
  }
  $$('[data-sample]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-sample');
      loadSamples().then(function (s) {
        if (id === 'picture') {
          state.r = { kind: 'picture', sample: true, meta: s.picture.meta, visual: s.picture.visual, name: s.picture.name };
        } else {
          var p = s.posts.filter(function (x) { return x.id === id; })[0];
          textEl.value = p.text;
          $('#count').textContent = Core.words(p.text).length + ' words';
          state.r = { kind: 'text', sample: true, sampleTitle: p.title, text: p.text, quick: p.quick, deep: p.deep, originality: p.originality };
        }
        drawResult(); drawActions();
        scrollToResult();
      }).catch(function (e) { showError(e); });
    });
  });

  /* ---------------- the metered checks ---------------- */

  var origBox = { checked: false };
  function deep() {
    var r = state.r;
    if (!r || !r.text) return;
    if (!signedIn()) return openAccount();
    state.busy.deep = true; drawActions(); drawResult();
    var text = r.text;
    var wantOrig = origBox.checked && !r.originality;
    if (wantOrig) originality();
    api('POST', 'api/check/deep', { text: text }).then(function (d) {
      if (state.r !== r) return;
      r.deep = d.deep; r.quick = d.quick || r.quick; r.sample = false;
      remember(r);
    }).catch(function (e) { showError(e); }).then(function () { state.busy.deep = false; drawActions(); drawResult(); loadMe(); });
  }
  function originality() {
    var r = state.r;
    if (!r || !r.text) return;
    if (!signedIn()) return openAccount();
    state.busy.originality = true; drawActions(); drawResult();
    api('POST', 'api/check/originality', { text: r.text }).then(function (d) {
      if (state.r !== r) return;
      r.originality = d.originality; r.sample = false;
      remember(r);
    }).catch(function (e) { showError(e); }).then(function () { state.busy.originality = false; drawActions(); drawResult(); loadMe(); });
  }
  function visual() {
    var r = state.r;
    if (!r) return;
    if (!signedIn()) return openAccount();
    var req = r.kind === 'video'
      ? api('POST', 'api/check/video', { frames: (state.video.frames || []).map(function (f) { return { data: f.data, t: f.t }; }) })
      : r.kind === 'link'
        ? api('POST', 'api/check/link-image', { url: r.page.image })
        : api('POST', 'api/check/picture', { preview: { data: state.picture.preview } });
    state.busy.visual = true; drawActions(); drawResult();
    req.then(function (d) {
      if (state.r !== r) return;
      r.visual = d.visual;
      if (r.kind === 'link') { r.imageMeta = d.meta; r.imageNote = d.note; }
      remember(r);
    }).catch(function (e) { showError(e); }).then(function () { state.busy.visual = false; drawActions(); drawResult(); loadMe(); });
  }

  function drawActions() {
    var el = $('#actions');
    var r = state.r, b = state.busy;
    var html = '';
    var paid = signedIn() ? '' : ' · sign in';
    var textReady = r && r.text && (r.kind === 'text' || r.kind === 'link') && !r.sample;
    var tabHasIt = r && ((state.tab === 'text' && r.kind === 'text') || (state.tab === 'link' && r.kind === 'link') || (state.tab === 'picture' && r.kind === 'picture') || (state.tab === 'video' && r.kind === 'video'));
    if (tabHasIt && textReady) {
      html += r.deep ? '' : '<button class="btn" type="button" id="aDeep"' + (b.deep ? ' disabled' : '') + '>' + (b.deep ? 'Reading…' : 'Deep read' + paid) + '</button>';
      if (!r.originality) {
        html += r.deep || b.deep
          ? '<button class="btn ghost" type="button" id="aOrig"' + (b.originality ? ' disabled' : '') + '>' + (b.originality ? 'Searching…' : 'Check originality (web search)' + paid) + '</button>'
          : '<label class="check-opt"><input type="checkbox" id="aOrigBox"' + (origBox.checked ? ' checked' : '') + '> Check originality too (uses web search)</label>';
      }
    }
    var canVisual = tabHasIt && !r.sample && !r.visual && ((r.kind === 'picture' && state.picture && state.picture.preview) || (r.kind === 'video' && state.video && state.video.frames && state.video.frames.length) || (r.kind === 'link' && r.page && r.page.image));
    if (canVisual) html += '<button class="btn' + (r.kind === 'link' ? ' ghost' : '') + '" type="button" id="aVis"' + (b.visual ? ' disabled' : '') + '>' + (b.visual ? 'Looking…' : (r.kind === 'link' ? 'Check the page’s image' : r.kind === 'video' ? 'Visual read of ' + state.video.frames.length + ' frames' : 'Visual read') + ' (weak signal)' + paid) + '</button>';
    el.innerHTML = html;
    var bd = $('#aDeep'), bo = $('#aOrig'), box = $('#aOrigBox'), bv = $('#aVis');
    if (bd) bd.onclick = deep;
    if (bo) bo.onclick = originality;
    if (box) box.onchange = function () { origBox.checked = box.checked; };
    if (bv) bv.onclick = visual;
  }

  /* ---------------- link ---------------- */

  function fetchLink() {
    var url = $('#url').value.trim();
    var info = $('#linkInfo');
    if (!url) return;
    if (/^http:\/\//i.test(url)) { info.innerHTML = '<p class="err">Tells only fetches https:// links. Try the https:// version, or paste the text.</p>'; return; }
    if (!signedIn()) { info.innerHTML = '<p class="note">Reading a link makes our server fetch the page, so it needs a free account (it uses no credit). <button class="link-btn" type="button" id="linkSign">Sign in or create one</button>. Or paste the text in the Text tab: that needs nothing.</p>'; $('#linkSign').onclick = function () { openAccount(); }; return; }
    state.busy.link = true;
    info.innerHTML = '<p class="busy">Fetching the page…</p>';
    api('POST', 'api/check/link', { url: url }).then(function (p) {
      state.busy.link = false;
      state.r = { kind: 'link', page: p, text: p.text || '', quick: p.quick };
      var html = '<div class="note"><b>' + esc(p.title || p.host) + '</b><br><span class="small muted">' + esc(p.host) + (p.published ? ' · ' + esc(p.published) : '') + (p.cut ? ' · long page: the first 20,000 characters are checked' : '') + '</span></div>';
      if (p.wall) {
        html += '<div class="note warn" role="status"><b>' + esc(p.wall.message) + '</b>' + (p.wall.preview ? '<br><span class="small">The page did share this preview line publicly:</span><blockquote class="small">' + esc(p.wall.preview) + '</blockquote><button class="btn small ghost" type="button" id="usePreview">Scan the preview line</button>' : '') + '</div>';
      }
      info.innerHTML = html;
      var up = $('#usePreview');
      if (up) up.onclick = function () { setTab('text'); textEl.value = p.wall.preview; onText(); };
      if (p.text) remember(state.r);
      drawResult(); drawActions();
    }).catch(function (e) { state.busy.link = false; showError(e, info); });
  }
  $('#fetch').addEventListener('click', fetchLink);
  $('#url').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fetchLink(); } });

  /* ---------------- picture ---------------- */

  function drop(label, input, onFile) {
    label.addEventListener('dragover', function (e) { e.preventDefault(); label.classList.add('over'); });
    label.addEventListener('dragleave', function () { label.classList.remove('over'); });
    label.addEventListener('drop', function (e) { e.preventDefault(); label.classList.remove('over'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
    input.addEventListener('change', function () { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  }

  /** A downscaled JPEG for the model. The ORIGINAL's metadata is read
   *  separately: a canvas redraw strips it, which is the point here. */
  function shrink(src, max, quality) {
    var w = src.videoWidth || src.naturalWidth || src.width, h = src.videoHeight || src.naturalHeight || src.height;
    var k = Math.min(1, max / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise(function (res, rej) { c.toBlob(function (b) { if (b) res(b); else rej(new Error('Could not draw the picture.')); }, 'image/jpeg', quality); });
  }
  function loadImage(url) {
    return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = function () { rej(new Error('decode')); }; i.src = url; });
  }

  function onPicture(file) {
    var info = $('#picInfo');
    if (file.size > LOCAL_FILE_MAX) { info.innerHTML = '<p class="err">That file is over 60 MB. Try a smaller one.</p>'; return; }
    if (state.picture && state.picture.url) URL.revokeObjectURL(state.picture.url);
    var url = URL.createObjectURL(file);
    state.picture = { name: file.name, url: url, preview: null };
    info.innerHTML = '<p class="busy">Reading the metadata on this device…</p>';
    file.arrayBuffer().then(function (buf) {
      var meta = Meta.scan(new Uint8Array(buf), { size: file.size, name: file.name });
      state.r = { kind: 'picture', name: file.name, meta: meta };
      drawResult();
      return loadImage(url).then(function (img) {
        return shrink(img, PREVIEW_PX, 0.85).then(blobB64).then(function (p) { state.picture.preview = p; });
      }).then(function () {
        info.innerHTML = '<img class="thumb" alt="The picture you chose" src="' + esc(url) + '"><p class="small muted">' + esc(file.name) + ' · ' + mb(file.size) + '. The metadata was read here. A visual read sends a 1024-pixel copy (no metadata) to be looked at once.</p>';
      }, function () {
        info.innerHTML = '<p class="note">This browser cannot open ' + esc(file.name) + ' to draw it (HEIC opens in Safari). Its metadata was still read; the visual read needs a picture the browser can show.</p>';
      });
    }).then(function () { remember(state.r); drawActions(); drawResult(); }).catch(function (e) { showError(e, info); });
  }
  drop($('#picDrop'), $('#pic'), onPicture);

  /* ---------------- video ---------------- */

  function slice(file, a, b) { return file.slice(a, b).arrayBuffer().then(function (x) { return new Uint8Array(x); }); }

  /** Which parts of the file to scan: the first and last 16 MB, plus any
   *  C2PA/XMP uuid box and the moov box wherever they sit, found by walking
   *  the top-level box headers 16 bytes at a time (MP4 and MOV). */
  function videoChunks(file) {
    var size = file.size, chunks = [], boxes = [];
    var head = Math.min(size, VIDEO_WINDOW);
    return slice(file, 0, head).then(function (h) {
      chunks.push({ offset: 0, bytes: h });
      if (size > head) return slice(file, Math.max(head, size - VIDEO_WINDOW), size).then(function (t) { chunks.push({ offset: Math.max(head, size - VIDEO_WINDOW), bytes: t }); });
    }).then(function () {
      var fmt = Meta.sniff(chunks[0].bytes);
      if (!/video\/(mp4|quicktime)/.test(fmt || '')) return;
      var at = 0, n = 0;
      function step() {
        if (at >= size || n++ > 64) return Promise.resolve();
        return slice(file, at, Math.min(size, at + 32)).then(function (hd) {
          var box = Meta.bmffBoxes(hd, at, 1)[0];
          if (!box || !isFinite(box.size)) return;
          boxes.push(box);
          at += box.size;
          return step();
        });
      }
      return step().then(function () {
        var want = boxes.filter(function (b) { return (b.type === 'uuid' || b.type === 'moov' || b.type === 'meta') && b.size <= 32 * 1024 * 1024 && (b.start >= head && b.start + b.size <= size); });
        return Promise.all(want.map(function (b) {
          return slice(file, b.start, b.start + b.size).then(function (bytes) { chunks.push({ offset: b.start, bytes: bytes, box: b.type }); });
        }));
      });
    }).then(function () { return chunks; });
  }

  function seek(v, t) {
    return new Promise(function (res, rej) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; rej(new Error('seek')); } }, 6000);
      v.onseeked = function () { if (!done) { done = true; clearTimeout(timer); res(); } };
      v.currentTime = t;
    });
  }
  function frames(url) {
    var v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    return new Promise(function (res, rej) {
      var timer = setTimeout(function () { rej(new Error('decode')); }, 10000);
      v.onloadeddata = function () { clearTimeout(timer); res(); };
      v.onerror = function () { clearTimeout(timer); rej(new Error('decode')); };
    }).then(function () {
      var d = v.duration;
      if (!isFinite(d) || d <= 0) throw new Error('decode');
      var out = [], i = 0;
      function next() {
        if (i >= FRAMES) return Promise.resolve(out);
        var t = Math.round(d * (i + 0.5) / FRAMES * 10) / 10;
        i++;
        return seek(v, t).then(function () { return shrink(v, FRAME_PX, 0.8); }).then(function (blob) {
          return blobB64(blob).then(function (data) { out.push({ data: data, t: t, url: URL.createObjectURL(blob) }); });
        }).then(next);
      }
      return next();
    });
  }

  function onVideo(file) {
    var info = $('#vidInfo');
    if (state.video) (state.video.frames || []).forEach(function (f) { URL.revokeObjectURL(f.url); });
    state.video = { name: file.name, frames: [] };
    info.innerHTML = '<p class="busy">Reading the metadata on this device…</p>';
    videoChunks(file).then(function (chunks) {
      var meta = Meta.scan(chunks, { size: file.size, name: file.name });
      state.r = { kind: 'video', name: file.name, meta: meta };
      drawResult();
      info.innerHTML = '<p class="busy">Taking 6 still frames…</p>';
      var url = URL.createObjectURL(file);
      return frames(url).then(function (fr) {
        state.video.frames = fr;
        info.innerHTML = '<p class="small muted">' + esc(file.name) + ' · ' + mb(file.size) + '. Metadata read from ' + (meta.scanned.partial ? 'the first and last 16 MB and the file’s metadata boxes' : 'the whole file') + ', on this device. A visual read sends only these ' + fr.length + ' frames.</p>' +
          '<div class="frames">' + fr.map(function (f, i) { return '<figure><img alt="Frame ' + (i + 1) + '" src="' + esc(f.url) + '"><figcaption>Frame ' + (i + 1) + ' · ' + esc(f.t) + 's</figcaption></figure>'; }).join('') + '</div>';
      }, function () {
        info.innerHTML = '<p class="note">This browser cannot decode ' + esc(file.name) + ', so no frames could be taken for a visual read. Its metadata was still read.</p>';
      }).then(function () { URL.revokeObjectURL(url); });
    }).then(function () { remember(state.r); drawActions(); drawResult(); }).catch(function (e) { showError(e, info); });
  }
  drop($('#vidDrop'), $('#vid'), onVideo);

  /* ---------------- the result ---------------- */

  function scrollToResult() {
    if (window.matchMedia('(min-width: 1000px)').matches) return;
    var el = $('#result');
    if (el && el.firstChild) el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  var STRENGTH = { low: 'Low', medium: 'Medium', high: 'High' };

  function meterHtml(c, r) {
    var driver = { deep: 'the deep read', quick: 'the quick scan only', visual: 'the visual read (a weak signal)', meta: 'the file’s metadata (a strong signal)' }[c.driver];
    return '<div class="card meter-card">' +
      (r.sample ? '<p class="sample-note">Sample result — made up for this page, no AI was used</p>' : '') +
      '<h2>Reads as AI</h2>' +
      '<div class="score-row"><span class="score">' + c.score + '</span><span class="score-of">/ 100</span><span class="level">' + esc(Core.levelWord(c.score)) + '</span></div>' +
      '<div class="bar" role="img" aria-label="' + esc('Likelihood ' + c.score + ' out of 100; likely between ' + c.lo + ' and ' + c.hi + '; ' + c.confidence + ' confidence') + '"><div class="band" style="left:' + c.lo + '%;width:' + Math.max(2, c.hi - c.lo) + '%"></div><div class="dot" style="left:calc(' + c.score + '% - 2px)"></div></div>' +
      '<div class="scale" aria-hidden="true"><span>0 · no tells</span><span>100 · many tells</span></div>' +
      '<p style="margin-top:10px"><span class="pill">' + esc(STRENGTH[c.confidence] || c.confidence) + ' confidence</span> <span class="small muted">likely ' + c.lo + '–' + c.hi + ' · from ' + esc(driver) + '</span></p>' +
      (c.camera ? '<p class="small">The file’s metadata points to a camera (not proof: it is easy to write).</p>' : '') +
      '<p class="limits">' + esc(Core.LIMITS_LINE) + '</p>' +
      '</div>';
  }

  function highlightHtml(text, spans) {
    var byId = {};
    spans.forEach(function (s) { byId[s.id] = s; });
    return Core.segments(text, spans).map(function (seg) {
      if (!seg.ids.length) return esc(seg.text);
      var hits = seg.ids.map(function (id) { return byId[id]; });
      var strength = Core.strongest(hits.map(function (h) { return h.strength; })) || 'low';
      var label = STRENGTH[strength] + ' signal: ' + hits.map(function (h) { return h.label + '. ' + h.reason; }).join(' ');
      return '<mark class="s-' + strength + '" tabindex="0" role="button" data-ids="' + esc(seg.ids.join(' ')) + '" aria-label="' + esc(label) + '">' + esc(seg.text) + '</mark>';
    }).join('');
  }

  function textCard(r) {
    var spans = (r.deep ? r.deep.spans : r.quick ? r.quick.hits : []) || [];
    var from = r.deep ? 'the deep read' : 'the quick scan';
    return '<div class="card"><h2>' + (spans.length ? 'The passages' : 'No passages flagged') + '</h2>' +
      '<p class="small muted">' + (spans.length ? 'Highlighted by ' + from + '. Tap or focus one for its reason.' : 'Nothing in ' + from + ' matched the usual tells.') + '</p>' +
      (spans.length ? '<div class="legend" aria-hidden="true"><span><mark class="s-low">low</mark> dotted</span><span><mark class="s-medium">medium</mark> dashed</span><span><mark class="s-high">high</mark> solid</span></div>' : '') +
      '<div class="hl-text" id="hlText">' + highlightHtml(r.text, spans) + '</div>' +
      '<div class="why" id="why" aria-live="polite" hidden></div>' +
      (r.quick && r.quick.tooShort ? '<p class="small muted">Short texts give very little to go on; treat any score here as a guess.</p>' : '') +
      '</div>';
  }

  function quickGroup(q) {
    var seen = {}, items = [];
    q.hits.forEach(function (h) {
      if (seen[h.rule]) { seen[h.rule].n++; return; }
      seen[h.rule] = { n: 1, h: h };
      items.push(seen[h.rule]);
    });
    var li = items.map(function (x) { return '<li><span class="k">' + esc(x.h.label) + (x.n > 1 ? ' ×' + x.n : '') + '</span> — ' + esc(x.h.reason) + '</li>'; });
    (q.signals || []).forEach(function (s) { li.push('<li><span class="k">' + esc(s.label) + '</span> — ' + esc(s.reason) + '</li>'); });
    return '<div class="group"><h3>Quick scan <span class="tag">free · low confidence</span></h3>' +
      (li.length ? '<ul class="sig">' + li.join('') + '</ul>' : '<p class="muted">None of the usual tells.</p>') +
      '<p class="small muted">' + esc(q.how) + '</p></div>';
  }
  function deepGroup(d) {
    return '<div class="group"><h3>Deep read <span class="tag">' + esc(d.confidence) + ' confidence</span></h3>' +
      '<p>' + esc(d.summary) + '</p>' +
      (d.humanSigns && d.humanSigns.length ? '<p class="small"><b>Signs of a person:</b> ' + d.humanSigns.map(esc).join(' · ') + '</p>' : '') +
      (d.dropped ? '<p class="small muted">' + d.dropped + ' quote' + (d.dropped === 1 ? '' : 's') + ' the model gave ' + (d.dropped === 1 ? 'was' : 'were') + ' not in your text and ' + (d.dropped === 1 ? 'was' : 'were') + ' left out.</p>' : '') +
      '</div>';
  }
  function metaGroup(m, title) {
    var strong = m.points === 'ai';
    return '<div class="group"><h3>' + esc(title || 'Metadata') + ' <span class="tag' + (strong ? ' strong' : '') + '">' + (strong ? 'strong signal' : 'read on this device') + '</span></h3>' +
      m.findings.map(function (f) {
        var cls = f.points === 'ai' && f.strength === 'strong' ? 'strong' : f.points === 'camera' ? 'camera' : '';
        var tag = f.points === 'ai' && f.strength === 'strong' ? 'Strong signal' : f.points === 'camera' ? 'Points to a camera' : 'Note';
        return '<div class="find ' + cls + '"><span class="k">' + esc(tag) + ':</span> ' + esc(f.label) + (f.detail ? '<br><span class="small">' + esc(f.detail) + '</span>' : '') + '</div>';
      }).join('') +
      (m.c2pa ? '<p class="small">Content Credentials are read, not verified here. <a href="https://contentcredentials.org/verify" target="_blank" rel="noopener noreferrer">Check the file at contentcredentials.org/verify</a>.</p>' : '') +
      (m.scanned && m.scanned.partial ? '<p class="small muted">Scanned ' + mb(m.scanned.bytes) + ' of ' + mb(m.scanned.of) + ': the start, the end and the metadata boxes.</p>' : '') +
      (m.points !== 'ai' ? '<p class="small muted">' + esc(Core.METADATA_NOTE) + '</p>' : '') +
      '</div>';
  }
  function visualGroup(v) {
    return '<div class="group"><h3>Visual read <span class="tag">a weak signal</span></h3>' +
      '<p><b>' + v.likelihood + '/100</b>, ' + esc(v.confidence) + ' confidence. ' + esc(v.summary) + '</p>' +
      (v.artefacts.length ? '<ul class="sig">' + v.artefacts.map(function (a) { return '<li><span class="k">' + (a.frame != null ? 'Frame ' + (a.frame + 1) + ', ' : '') + esc(a.where) + '</span> — ' + esc(a.what) + '</li>'; }).join('') + '</ul>' : '') +
      '<p class="small muted">' + esc(Core.VISUAL_NOTE) + '</p></div>';
  }
  function originalityCard(o, busy) {
    if (busy && !o) return '<div class="card"><h2>Originality</h2><p class="busy">Searching the web for earlier work…</p></div>';
    if (!o) return '';
    var OV = { idea: 'same idea', phrasing: 'same wording', 'near-copy': 'near-copy' };
    return '<div class="card"><h2>Originality</h2>' +
      '<div class="score-row"><span class="orig-score">' + o.score + '</span><span class="score-of">/ 100 original</span><span class="pill">' + esc(STRENGTH[o.confidence] || o.confidence) + ' confidence</span></div>' +
      '<p class="small muted">Scored separately from “reads as AI”: a person can write something unoriginal, and a model can say something new.</p>' +
      '<p>' + esc(o.summary) + '</p>' +
      (o.sources.length ? o.sources.map(function (s) {
        return '<div class="src">' + (/^https:\/\//.test(s.url) ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title) + '</a>' : esc(s.title)) +
          '<span class="ov">' + esc(OV[s.overlap] || s.overlap) + '</span>' +
          '<div class="small muted">' + esc(s.host) + (s.date ? ' · ' + esc(s.date) : '') + (s.matched === false ? ' · not matched to a search result, open it before relying on it' : '') + '</div>' +
          (s.note ? '<div class="small">' + esc(s.note) + '</div>' : '') + '</div>';
      }).join('') : '<p class="note">' + esc(Core.ORIGINAL_NONE) + ' That is not the same as proven original.</p>') +
      (o.adds ? '<p><b>What it adds:</b> ' + esc(o.adds) + '</p>' : '') +
      '</div>';
  }

  function drawResult() {
    var el = $('#result');
    var r = state.r;
    if (!r) { el.innerHTML = ''; return; }
    var meta = r.meta || r.imageMeta || null;
    var c = Core.combine({ quick: r.quick, deep: r.deep, meta: meta, visual: r.visual });
    var html = c ? meterHtml(c, r) : '';
    if (r.kind === 'link' && r.page && r.page.wall && !r.text) html = '<div class="card"><h2>Nothing to check on that page</h2><p>' + esc(r.page.wall.message) + '</p></div>';
    if (r.text) html += textCard(r);
    var groups = '';
    if (state.busy.deep) groups += '<div class="group"><h3>Deep read</h3><p class="busy">Reading… this can take up to a minute.</p></div>';
    else if (r.deep) groups += deepGroup(r.deep);
    if (r.quick) groups += quickGroup(r.quick);
    if (meta) groups += metaGroup(meta, r.kind === 'link' ? 'The page’s image: metadata' : 'Metadata');
    if (r.imageNote) groups += '<p class="small muted">' + esc(r.imageNote) + '</p>';
    if (state.busy.visual) groups += '<div class="group"><h3>Visual read</h3><p class="busy">Looking…</p></div>';
    else if (r.visual) groups += visualGroup(r.visual);
    if (groups) html += '<div class="card"><h2>Signals</h2>' + groups + '</div>';
    html += originalityCard(r.originality, state.busy.originality);
    if (!signedIn() && !r.sample && (r.text || r.kind !== 'text')) {
      html += '<div class="card"><h2>Want a closer look?</h2><p class="muted">' + esc(FREE_LINE) + '</p><button class="btn" type="button" id="rSign">Create a free account</button></div>';
    }
    el.innerHTML = html;
    var sb = $('#rSign');
    if (sb) sb.onclick = function () { openAccount(); };
    wireMarks(r);
  }

  function wireMarks(r) {
    var box = $('#hlText'), why = $('#why');
    if (!box) return;
    var spans = (r.deep ? r.deep.spans : r.quick ? r.quick.hits : []) || [];
    var byId = {};
    spans.forEach(function (s) { byId[s.id] = s; });
    function show(m) {
      $$('mark.on', box).forEach(function (x) { x.classList.remove('on'); });
      m.classList.add('on');
      why.innerHTML = m.getAttribute('data-ids').split(' ').map(function (id) {
        var h = byId[id];
        return h ? '<p><b>' + esc(h.label) + '</b> <span class="pill">' + esc(STRENGTH[h.strength] || h.strength) + '</span> ' + esc(h.reason) + '</p>' : '';
      }).join('');
      why.hidden = false;
    }
    box.addEventListener('click', function (e) { var m = e.target.closest('mark'); if (m) show(m); });
    box.addEventListener('keydown', function (e) { var m = e.target.closest('mark'); if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); show(m); } });
  }

  /* ---------------- history: this browser only ---------------- */

  function remember(r) {
    if (!r || r.sample) return;
    var meta = r.meta || r.imageMeta;
    var c = Core.combine({ quick: r.quick, deep: r.deep, meta: meta, visual: r.visual });
    if (!c) return;
    var label = r.kind === 'link' ? (r.page.title || r.page.host) : r.kind === 'text' ? r.text.replace(/\s+/g, ' ').slice(0, 70) : r.name;
    var list = (recall(K_HIST) || []).filter(function (h) { return h && h.label !== label; });
    list.unshift({ at: new Date().toISOString(), kind: r.kind, label: String(label || '').slice(0, 80), score: c.score, confidence: c.confidence, original: r.originality ? r.originality.score : null });
    keep(K_HIST, list.slice(0, 12));
    drawHistory();
  }
  function drawHistory() {
    var list = recall(K_HIST) || [];
    $('#history').hidden = !list.length;
    $('#histList').innerHTML = list.map(function (h) {
      return '<li><b>' + esc(h.score) + '/100</b> <span class="small muted">(' + esc(h.confidence) + ')</span> · ' + esc(h.kind) + ' · ' + esc(h.label) + (h.original != null ? ' · original ' + esc(h.original) : '') + ' <span class="small muted">' + esc(String(h.at).slice(0, 10)) + '</span></li>';
    }).join('');
  }
  $('#clearHist').onclick = function () { keep(K_HIST, null); drawHistory(); };

  /* ---------------- add to browser ---------------- */

  function loadBookmarklet() {
    api('GET', 'api/bookmarklet').then(function (b) {
      var a = $('#bm');
      a.setAttribute('href', b.href);
      a.addEventListener('click', function (e) { e.preventDefault(); toast('Drag it to your bookmarks bar, then use it on another page.'); });
      $('#copyBm').onclick = function () { copy(b.href, 'Bookmark code copied'); };
    }).catch(function () { /* the section still explains the other ways */ });
  }

  /* ---------------- ?q= from the bookmarklet, Shortcut or share target ---------------- */

  /**
   * Text or a link handed over in the address. It runs the FREE quick scan
   * only - a crafted link must never spend anyone's credit - and then the
   * address is cleaned so a reload or the history does not carry it.
   */
  function fromAddress() {
    var q = Core.parseQ(location.search);
    if (!q) return false;
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* ignore */ }
    var from = { bookmarklet: 'your bookmark', shortcut: 'the Shortcut', extension: 'the extension' }[q.src] || 'a link';
    var banner = '<p class="note" role="status">Opened from ' + esc(from) + '. Only the free quick scan ran; nothing that uses credit happens until you tap.' + (q.cut ? ' The selection was long, so it was cut to fit.' : '') + '</p>';
    if (q.kind === 'text') {
      setTab('text');
      textEl.value = q.value;
      state.r = { kind: 'text', text: q.value, quick: Core.scan(q.value) };
      $('#count').textContent = Core.words(q.value).length + ' words';
      $('#actions').insertAdjacentHTML('beforebegin', banner);
    } else {
      setTab('link');
      $('#url').value = q.value;
      $('#linkInfo').innerHTML = banner + (q.https ? '' : '<p class="err">Tells only fetches https:// links.</p>');
      // Reading a page is free (no model): signed in, it goes straight away.
      if (q.https && signedIn()) fetchLink();
    }
    return true;
  }

  /* ---------------- start ---------------- */

  function drawAll() { drawActions(); drawResult(); drawHistory(); }

  $('#limitsLine').textContent = Core.LIMITS_LINE;
  loadMe().then(function () {
    if (!fromAddress()) drawAll(); else { drawAll(); }
    if (location.hash === '#settings') { if (signedIn()) openSettings(); else openAccount('Sign in to make a device key for the extension or the Shortcut.'); }
  });
  loadBookmarklet();
  drawHistory();
}());
