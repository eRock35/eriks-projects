/* Again - the service worker. It keeps the app's own files so the page
 * loads, and works, with the network off once it has loaded once: logging a
 * visit, "I'm here", Want to try, browsing, the stats, the share card and
 * the exports never need the network - only signing in, sync, making a
 * share link, a friend's link and the optional menu reader do.
 *
 * Network first, cache as the fallback: online, every load gets the current
 * files (and refreshes the cache); offline, the cached copy answers. Only
 * this app's own files under its own scope - never api/ (the account, sync,
 * links and the AI need the network and must never be answered from a
 * cache), never a friend's s/ page (it is somebody's live link: offline it
 * says so instead), and never another app's (the lab shares this origin).
 * Caches are named again-*, and only those are ever deleted. Nothing a
 * person adds - no dish, no photo - is ever put in a cache: only these files.
 */
var CACHE = 'again-shell-v1';
var SHELL = ['./', 'app.css', 'desktop.css', 'app.js', 'again-core.js', 'passkey-client.js', 'verify-banner.js', 'icon.svg', 'manifest.webmanifest'];
var OFFLINE_LIST = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Again - offline</title></head>' +
  '<body style="margin:0;font:17px/1.5 system-ui,sans-serif;background:#faf7f3;color:#1d1915;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center">' +
  '<div style="max-width:420px"><div style="font-size:48px">🍽️</div><h1 style="font-size:1.4rem">This list needs the internet</h1>' +
  '<p style="color:#5a5047">A friend’s list is opened from its link each time, so it can’t open offline. Reconnect and reload the page.</p></div></body></html>';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('again-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var scope = new URL(self.registration.scope).pathname;
  if (url.pathname.indexOf(scope) !== 0) return;
  var rel = url.pathname.slice(scope.length);
  if (rel.indexOf('api/') === 0) return;
  var nav = req.mode === 'navigate';
  if (rel.indexOf('s/') === 0) {
    if (!nav) return;
    e.respondWith(fetch(req).catch(function () { return new Response(OFFLINE_LIST, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }));
    return;
  }
  if (!nav && SHELL.indexOf(rel) < 0) return;
  var keyReq = nav ? new Request(scope) : new Request(url.origin + url.pathname);
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok && res.type === 'basic') { var copy = res.clone(); caches.open(CACHE).then(function (c) { return c.put(keyReq, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(keyReq).then(function (hit) { return hit || caches.match(new Request(scope)); });
  }));
});
