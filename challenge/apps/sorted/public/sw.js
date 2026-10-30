/* Sorted - the service worker. It keeps the app's own files so the page
 * loads, and works, with the network off once it has loaded once: adding
 * things, the deck, sprints, the piles, the tally and the recap image never
 * need the network - only signing in, up-for-grabs links and the optional
 * price estimate do.
 *
 * Network first, cache as the fallback: online, every load gets the current
 * files (and refreshes the cache); offline, the cached copy answers. Only
 * this app's own files under its own scope - never api/ (the account, the
 * links and the AI need the network and must never be answered from a
 * cache), never a friend's g/ page (it is somebody's live list: offline it
 * says so instead), and never another app's (the lab shares this origin).
 * Caches are named sorted-*, and only those are ever deleted. Nothing a
 * person adds - no item, no photo - is ever put in a cache: only these files.
 */
var CACHE = 'sorted-shell-v1';
var SHELL = ['./', 'app.css', 'desktop.css', 'app.js', 'sorted-core.js', 'passkey-client.js', 'verify-banner.js', 'icon.svg', 'manifest.webmanifest'];
var OFFLINE_CLAIM = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sorted - offline</title></head>' +
  '<body style="margin:0;font:17px/1.5 system-ui,sans-serif;background:#f5f6f1;color:#17211c;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center">' +
  '<div style="max-width:420px"><div style="font-size:48px">🧺</div><h1 style="font-size:1.4rem">This list needs the internet</h1>' +
  '<p style="color:#4c5852">It shows what is still up for grabs right now, so it can’t open offline. Reconnect and reload the page.</p></div></body></html>';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('sorted-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
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
  if (rel.indexOf('g/') === 0) {
    if (!nav) return;
    e.respondWith(fetch(req).catch(function () { return new Response(OFFLINE_CLAIM, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }));
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
