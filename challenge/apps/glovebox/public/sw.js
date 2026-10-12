/* Glovebox - the service worker. It keeps the app's own files so the page
 * (the warning-light finder above all, and a buyer's history page) opens
 * with no signal once it has been opened once: a dashboard light comes on
 * in car parks and on country roads, not next to good wifi.
 *
 * Network first, cache as the fallback: online, every load gets the current
 * files (and refreshes the cache); offline, the cached copy answers. Only
 * this app's own files under its own scope - never api/ (the account and the
 * one AI call need the network and must never be answered from a cache), and
 * never another app's (the lab shares this origin). Caches are named
 * glovebox-*, and only those are ever deleted. A history link's report is in
 * the fragment, which is never part of a request, so it is never cached.
 */
var CACHE = 'glovebox-shell-v1';
var SHELL = ['./', 'history', 'app.css', 'desktop.css', 'app.js', 'history.js', 'glovebox-core.js', 'glovebox-lights.js', 'demo.js', 'passkey-client.js', 'verify-banner.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('glovebox-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
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
  if (!nav && SHELL.indexOf(rel) < 0) return;
  var page = rel === 'history' || rel === 'history.html' ? scope + 'history' : scope;
  var keyReq = nav ? new Request(url.origin + page) : new Request(url.origin + url.pathname);
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok && res.type === 'basic') { var copy = res.clone(); caches.open(CACHE).then(function (c) { return c.put(keyReq, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(keyReq).then(function (hit) { return hit || caches.match(new Request(url.origin + scope)); });
  }));
});
