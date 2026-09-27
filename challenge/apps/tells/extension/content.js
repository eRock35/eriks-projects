/* Tells extension - the content script.
 *
 * On LinkedIn and X it adds a small "Tells" button to each post. Clicking it
 * reads THAT post's text (and its image addresses) from the page - the
 * expanded text if LinkedIn already has it in the DOM; nothing is clicked on
 * your behalf - and opens a panel with the free quick scan straight away.
 * A deep read, an originality check or a visual read happen only when you
 * press their buttons, through the extension's background worker.
 *
 * Elsewhere it is injected only when you use the right-click menu or the
 * toolbar popup (activeTab), and then only draws the panel.
 *
 * Built to fail quietly: if the sites change their markup, the buttons stop
 * appearing and nothing else breaks. The panel lives in a closed Shadow DOM so
 * the site's CSS cannot break it and ours cannot touch the site.
 */
(function () {
  'use strict';
  if (window.__tellsContent) return;
  window.__tellsContent = true;

  var api = globalThis.browser || globalThis.chrome;
  var Core = window.TellsCore;
  var UI = window.TellsUI;
  if (!api || !Core || !UI) return;

  var SITES = [
    {
      id: 'linkedin', host: /(^|\.)linkedin\.com$/,
      posts: ['div.feed-shared-update-v2', 'div[data-urn^="urn:li:activity"]', 'article[data-activity-urn]', 'div[data-id^="urn:li:activity"]'],
      text: ['.update-components-update-v2__commentary', '.feed-shared-inline-show-more-text', '.update-components-text', '.feed-shared-text', '[data-test-id="main-feed-activity-card__commentary"]'],
      images: ['.update-components-image img', '.feed-shared-image img', '.update-components-image__image'],
    },
    {
      id: 'x', host: /(^|\.)(x|twitter)\.com$/,
      posts: ['article[data-testid="tweet"]'],
      text: ['[data-testid="tweetText"]'],
      images: ['[data-testid="tweetPhoto"] img'],
    },
  ];
  var site = SITES.filter(function (s) { return s.host.test(location.hostname); })[0] || null;
  var DONE = 'data-tells';

  function first(rootEl, sels) {
    for (var i = 0; i < sels.length; i++) { try { var n = rootEl.querySelector(sels[i]); if (n) return n; } catch (e) { /* bad selector */ } }
    return null;
  }

  /** The post's own text, without the "…see more" control. */
  function postText(post) {
    var el = first(post, site.text);
    if (!el) return '';
    var t = String(el.innerText || el.textContent || '');
    return Core.clean(t.replace(/\n?…\s*(see more|more)\s*$/i, '').replace(/\n{3,}/g, '\n\n').trim(), Core.LIMITS.text);
  }
  function postImages(post) {
    var out = [];
    site.images.forEach(function (sel) {
      try {
        Array.prototype.forEach.call(post.querySelectorAll(sel), function (img) {
          var src = img.currentSrc || img.src;
          if (/^https:\/\//.test(src) && out.indexOf(src) < 0 && out.length < 4) out.push(src);
        });
      } catch (e) { /* ignore */ }
    });
    return out;
  }

  /* ---------------- the per-post button ---------------- */

  function addButton(post) {
    var anchor = first(post, site.text);
    var host = document.createElement('span');
    host.setAttribute(DONE, 'btn');
    host.style.cssText = 'display:block;text-align:right;margin:2px 12px 0;line-height:0';
    var shadow = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = ':host{all:initial}button{font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#3b1d6e;background:#f3eefc;border:1px solid #c9b8ee;border-radius:99px;padding:4px 9px;cursor:pointer}button:hover{background:#e9e0fa}button:focus-visible{outline:2px solid #3b1d6e;outline-offset:2px}';
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = '🔎 Tells';
    b.title = 'Check this post for tells of AI';
    b.setAttribute('aria-label', 'Check this post with Tells');
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      openPanel({ text: postText(post), images: postImages(post) });
    });
    shadow.appendChild(style); shadow.appendChild(b);
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
    else post.insertBefore(host, post.firstChild);
  }

  function sweep() {
    if (!site) return;
    site.posts.forEach(function (sel) {
      var list;
      try { list = document.querySelectorAll(sel); } catch (e) { return; }
      Array.prototype.forEach.call(list, function (post) {
        try {
          if (post.hasAttribute(DONE)) return;
          // One button per post: skip one nested in, or wrapping, a post we did.
          if (post.parentElement && post.parentElement.closest('[' + DONE + '="post"]')) { post.setAttribute(DONE, 'inner'); return; }
          if (post.querySelector('[' + DONE + '="post"]')) { post.setAttribute(DONE, 'outer'); return; }
          if (!first(post, site.text)) return; // not rendered yet; the observer will come back
          post.setAttribute(DONE, 'post');
          addButton(post);
        } catch (e) { /* fail quietly */ }
      });
    });
  }

  var queued = false;
  function queue() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; sweep(); });
  }

  /* ---------------- the panel ---------------- */

  var panel = null;
  var state = null;

  function hasKey() {
    return api.storage.local.get('key').then(function (v) { return Boolean(v && v.key); }, function () { return false; });
  }
  function send(msg) {
    return new Promise(function (resolve) {
      try {
        var p = api.runtime.sendMessage(msg, function (r) { resolve(r || { error: (api.runtime.lastError && api.runtime.lastError.message) || 'No answer from Tells.' }); });
        if (p && typeof p.then === 'function') p.then(resolve, function (e) { resolve({ error: String(e && e.message || e) }); });
      } catch (e) { resolve({ error: 'Tells could not be reached. Reload the page.' }); }
    });
  }

  function ensurePanel() {
    if (panel) return panel;
    var host = document.createElement('div');
    host.setAttribute(DONE, 'panel');
    host.style.cssText = 'position:fixed;top:72px;right:16px;z-index:2147483647;width:min(400px,calc(100vw - 32px));max-height:calc(100vh - 96px)';
    var shadow = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = UI.CSS + '\n.wrap{background:#fbfaf7;border:1px solid #d6d0e8;border-radius:16px;box-shadow:0 12px 40px rgba(20,10,40,.25);max-height:calc(100vh - 96px);overflow:auto;padding:12px 14px}.head{display:flex;justify-content:space-between;align-items:center;font:700 14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#15171c;margin-bottom:6px}.x{all:unset;cursor:pointer;font-size:18px;line-height:1;padding:4px 8px;color:#3d414a;border-radius:8px}.x:focus-visible{outline:2px solid #3b1d6e}';
    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Tells result');
    var head = document.createElement('div');
    head.className = 'head';
    var title = document.createElement('span');
    title.textContent = '🔎 Tells';
    var close = document.createElement('button');
    close.className = 'x'; close.textContent = '×'; close.setAttribute('aria-label', 'Close Tells');
    close.addEventListener('click', closePanel);
    head.appendChild(title); head.appendChild(close);
    var body = document.createElement('div');
    wrap.appendChild(head); wrap.appendChild(body);
    shadow.appendChild(style); shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
    panel = { host: host, body: body, close: close };
    return panel;
  }
  function closePanel() { if (panel) { panel.host.remove(); panel = null; } }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel) closePanel(); }, true);

  function draw() {
    if (!panel || !state) return;
    UI.render(panel.body, state);
  }

  function run(kind) {
    if (!state || state.busy[kind]) return;
    state.busy[kind] = true; state.error = null; draw();
    var msg = kind === 'visual'
      ? { type: 'visual', preview: state.preview }
      : { type: 'check', kind: kind, text: state.text };
    send(msg).then(function (r) {
      state.busy[kind] = false;
      if (r.error) state.error = r.error;
      else if (kind === 'deep') state.deep = r.deep;
      else if (kind === 'originality') state.originality = r.originality;
      else if (kind === 'visual') state.visual = r.visual;
      draw();
    });
  }

  function checkImage(src) {
    state.busy.visual = false; state.error = null;
    state.images = [];
    state.text = ''; state.quick = null; state.deep = null; state.originality = null;
    state.meta = null; state.visual = null;
    UI.render(panel.body, Object.assign({}, state, { note: 'Reading the image’s metadata…' }));
    send({ type: 'image', url: src }).then(function (r) { showImage(r); });
  }

  function showImage(r) {
    ensurePanel();
    state = state || baseState();
    state.text = ''; state.quick = null; state.deep = null; state.originality = null; state.images = [];
    state.meta = r.meta || null; state.visual = null; state.preview = r.preview || null;
    state.error = r.error || null;
    state.actions.visual = state.preview ? function () { run('visual'); } : null;
    if (!state.preview && !r.error) state.error = r.note || null;
    draw();
  }

  function baseState() {
    return {
      busy: {}, hasKey: false, images: [],
      actions: {
        deep: function () { run('deep'); },
        originality: function () { run('originality'); },
        image: checkImage,
        options: function () { send({ type: 'options' }); },
      },
    };
  }

  function openPanel(input) {
    ensurePanel();
    state = baseState();
    state.text = input.text || '';
    state.images = input.images || [];
    state.quick = state.text ? Core.scan(state.text) : null;
    if (!state.text && !state.images.length) state.error = 'Tells could not find the text of this post. Select it and use the right-click menu instead.';
    draw();
    hasKey().then(function (k) { state.hasKey = k; draw(); });
    try { panel.close.focus(); } catch (e) { /* ignore */ }
  }

  /** What "check this page" reads when you have not selected anything. */
  function pageText() {
    var sel = String(window.getSelection() || '').trim();
    if (sel) return sel;
    var main = document.querySelector('article') || document.querySelector('main') || document.body;
    return String((main && main.innerText) || '').trim();
  }

  api.runtime.onMessage.addListener(function (msg, _sender, reply) {
    try {
      if (!msg || typeof msg !== 'object') return false;
      if (msg.type === 'show-text') { openPanel({ text: Core.clean(msg.text || '', Core.LIMITS.text).trim() }); reply({ ok: true }); }
      else if (msg.type === 'show-page') { openPanel({ text: Core.clean(pageText(), Core.LIMITS.text) }); reply({ ok: true }); }
      else if (msg.type === 'show-image') { showImage(msg.result || {}); reply({ ok: true }); }
    } catch (e) { reply({ error: 'Tells could not draw here.' }); }
    return false;
  });

  if (site) {
    sweep();
    try { new MutationObserver(queue).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { /* fail quietly */ }
  }
}());
