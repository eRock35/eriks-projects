/* Firstday - the service worker. It keeps the app's own files so the sample
 * hire and the welcome page open with a weak signal (a train, a
 * basement).
 *
 * Network first, cache as the fallback. Only this app's own files under its
 * own scope - never api/ (plans and the account need the network and must
 * never be answered from a cache), never a plan or link page (p/, l/), and never
 * another app's (the lab shares this origin). Caches are named firstday-*, and
 * only those are ever deleted.
 */
var CACHE = 'firstday-shell-v1';
var SHELL = ['./', 'app.css', 'desktop.css', 'app.js', 'firstday-core.js', 'passkey-client.js', 'verify-banner.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf('firstday-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
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
  if (rel.indexOf('api/') === 0 || rel.indexOf('p/') === 0 || rel.indexOf('l/') === 0) return;
  var nav = req.mode === 'navigate';
  if (!nav && SHELL.indexOf(rel) < 0) return;
  var keyReq = nav ? new Request(url.origin + scope) : new Request(url.origin + url.pathname);
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok && res.type === 'basic') { var copy = res.clone(); caches.open(CACHE).then(function (c) { return c.put(keyReq, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(keyReq).then(function (hit) { return hit || caches.match(new Request(url.origin + scope)); });
  }));
});
