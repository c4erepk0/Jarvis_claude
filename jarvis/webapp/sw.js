// Сервис-воркер: оболочка дашборда открывается даже без сети; данные всегда берутся с сервера.
// версия одна для CACHE и для ?v= — тест tests/js/assets-version.test.mjs не даст им разойтись
const V = "31";
const CACHE = `atom-v${V}`;
const SHELL = ["./", "static/app.css", `static/app.js?v=${V}`, `static/reactor.js?v=${V}`, `static/voice.js?v=${V}`,
  `static/standalone.js?v=${V}`, "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/") || url.pathname.endsWith("/ws")) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
