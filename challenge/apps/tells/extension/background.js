/* Tells extension - the background service worker.
 *
 * Every call to the Tells API goes through here: a content script runs under
 * the page's origin and CORS, the worker runs under the extension's with host
 * permission for the Tells site only. It authenticates with the device key
 * from the options page (Authorization: Bearer), so the check is charged to
 * that account exactly as if it were made on the site.
 *
 * Written for Chrome AND for Safari's converter (xcrun
 * safari-web-extension-converter): the `browser` namespace when there is one,
 * else `chrome`; promise-style calls; no offscreen documents (a picture is
 * shrunk with OffscreenCanvas in the worker where that exists, else the
 * original is sent if it is small enough, else only its metadata is read);
 * the right-click menu is optional (iOS has none - the toolbar popup offers
 * the same checks).
 */
'use strict';

importScripts('tells-core.js', 'tells-meta.js');

var api = globalThis.browser || globalThis.chrome;
var DEFAULT_BASE = 'https://challenge.strongtechnicalconsulting.com/tells/';
var PREVIEW_MAX = 1024;
var SEND_ORIGINAL_MAX = 3.5 * 1024 * 1024;
var IMAGE_MAX = 8 * 1024 * 1024;

function settings() {
  return api.storage.local.get(['key', 'base']).then(function (v) {
    v = v || {};
    var base = typeof v.base === 'string' && /^(https:\/\/[^\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*)\/$/.test(v.base) ? v.base : DEFAULT_BASE;
    return { key: typeof v.key === 'string' ? v.key.trim() : '', base: base };
  });
}

/** POST to the Tells API as the device key's account. */
function call(path, body) {
  return settings().then(function (s) {
    if (!s.key) return { error: 'Add your Tells device key in the extension’s options first (Tells → Settings → Device keys).', needKey: true };
    return fetch(s.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.key },
      body: JSON.stringify(body),
      credentials: 'omit',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.error) {
          var msg = data.error || ('Tells answered ' + res.status + '.');
          if (res.status === 402) msg += ' Top up on the Tells page.';
          return { error: msg, status: res.status };
        }
        return data;
      });
    }, function () { return { error: 'Tells could not be reached. Check your connection.' }; });
  });
}

/* ---------------- images ---------------- */

function toBase64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(s);
}

/** The picture's bytes: fetched with this extension's host permission (the
 *  LinkedIn and X image hosts are granted; anywhere else asks first). */
function imageBytes(url) {
  if (/^data:image\/[a-z+.-]+;base64,/i.test(url)) {
    var bin = atob(url.split(',')[1] || '');
    var b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return Promise.resolve(b);
  }
  if (!/^https:\/\//i.test(url)) return Promise.reject(new Error('Tells only reads https images.'));
  return fetch(url, { credentials: 'omit' }).then(function (res) {
    if (!res.ok) throw new Error('The image could not be downloaded (' + res.status + ').');
    var len = Number(res.headers.get('content-length') || 0);
    if (len > IMAGE_MAX) throw new Error('That image is over 8 MB.');
    return res.arrayBuffer();
  }).then(function (buf) {
    if (buf.byteLength > IMAGE_MAX) throw new Error('That image is over 8 MB.');
    return new Uint8Array(buf);
  });
}

/** A ~1024 px JPEG for the visual read, drawn in the worker. Null when this
 *  browser has no OffscreenCanvas (older Safari): then the original goes if
 *  it is small and a type the model reads. */
function preview(bytes, type) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
    return Promise.resolve(bytes.length <= SEND_ORIGINAL_MAX && /^image\/(jpeg|png|webp|gif)$/.test(type || '') ? toBase64(bytes) : null);
  }
  return createImageBitmap(new Blob([bytes], { type: type || 'image/jpeg' })).then(function (bmp) {
    var scale = Math.min(1, PREVIEW_MAX / Math.max(bmp.width, bmp.height));
    var c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  }).then(function (blob) { return blob.arrayBuffer(); }).then(function (buf) { return toBase64(new Uint8Array(buf)); }, function () { return null; });
}

/** Metadata (free, here) plus a preview for a visual read the person may ask
 *  for. Nothing is sent anywhere until they do. */
function inspectImage(url) {
  return imageBytes(url).then(function (bytes) {
    var meta = self.TellsMeta.scan(bytes);
    return preview(bytes, meta.format).then(function (p) {
      return { meta: meta, preview: p, note: p ? null : 'This picture could not be shrunk here, so only its metadata was read.' };
    });
  }).catch(function (e) { return { error: String(e && e.message || e) }; });
}

function needsPermission(url) {
  if (!/^https:\/\//i.test(url) || !api.permissions || !api.permissions.contains) return Promise.resolve(false);
  var origin = new URL(url).origin + '/*';
  return api.permissions.contains({ origins: [origin] }).then(function (has) { return !has; }, function () { return false; });
}

/* ---------------- messages ---------------- */

api.runtime.onMessage.addListener(function (msg, _sender, reply) {
  if (!msg || typeof msg !== 'object') return false;
  var answer = null;
  if (msg.type === 'check' && (msg.kind === 'deep' || msg.kind === 'originality')) {
    answer = call('api/check/' + msg.kind, { text: String(msg.text || '').slice(0, 20000) });
  } else if (msg.type === 'visual' && typeof msg.preview === 'string') {
    answer = call('api/check/picture', { preview: { data: msg.preview } });
  } else if (msg.type === 'image' && typeof msg.url === 'string') {
    answer = needsPermission(msg.url).then(function (need) {
      if (need) return { error: 'To read images from this site, open the Tells options and allow image checks on any site.' };
      return inspectImage(msg.url);
    });
  } else if (msg.type === 'options') {
    answer = Promise.resolve(api.runtime.openOptionsPage()).then(function () { return { ok: true }; }, function () { return { ok: false }; });
  } else if (msg.type === 'settings') {
    answer = settings().then(function (s) { return { hasKey: Boolean(s.key), base: s.base }; });
  }
  if (!answer) return false;
  answer.then(reply, function (e) { reply({ error: String(e && e.message || e) }); });
  return true;
});

/* ---------------- the right-click menu (not on iOS) ---------------- */

var FILES = ['tells-core.js', 'ui.js', 'content.js'];

/** Make sure the panel code is in the tab. On LinkedIn and X it already is;
 *  elsewhere the menu click granted activeTab for exactly this. */
function inject(tabId) {
  return api.scripting.executeScript({ target: { tabId: tabId }, files: FILES }).then(function () { return true; }, function () { return false; });
}
function tell(tabId, msg) {
  return inject(tabId).then(function () { return api.tabs.sendMessage(tabId, msg); }).catch(function () { /* a page we cannot draw on (the store, settings) */ });
}

if (api.contextMenus && api.contextMenus.onClicked) {
  api.runtime.onInstalled.addListener(function () {
    try {
      Promise.resolve(api.contextMenus.removeAll()).then(function () {
        api.contextMenus.create({ id: 'tells-selection', title: 'Check selected text with Tells', contexts: ['selection'] });
        api.contextMenus.create({ id: 'tells-image', title: 'Check this image with Tells', contexts: ['image'] });
        api.contextMenus.create({ id: 'tells-page', title: 'Check this page with Tells', contexts: ['page'] });
      });
    } catch (e) { /* menus are optional */ }
  });
  api.contextMenus.onClicked.addListener(function (info, tab) {
    if (!tab || tab.id == null) return;
    if (info.menuItemId === 'tells-selection') tell(tab.id, { type: 'show-text', text: info.selectionText || '' });
    else if (info.menuItemId === 'tells-page') tell(tab.id, { type: 'show-page' });
    else if (info.menuItemId === 'tells-image' && info.srcUrl) {
      var url = info.srcUrl;
      // Asked synchronously inside the click, which is the user gesture a
      // permission prompt needs. Already granted (LinkedIn's and X's image
      // hosts are) resolves at once without a prompt.
      var ask = Promise.resolve(true);
      if (api.permissions && api.permissions.request && /^https:\/\//i.test(url)) {
        try { ask = Promise.resolve(api.permissions.request({ origins: [new URL(url).origin + '/*'] })).catch(function () { return false; }); } catch (e) { ask = Promise.resolve(false); }
      }
      ask.then(function (ok) {
        if (!ok) return tell(tab.id, { type: 'show-image', result: { error: 'Tells needs permission to read images from this site. You can allow it in the Tells options.' } });
        return inspectImage(url).then(function (result) { return tell(tab.id, { type: 'show-image', result: result }); });
      });
    }
  });
}
