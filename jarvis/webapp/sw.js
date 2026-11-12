// Сервис-воркер: оболочка дашборда открывается даже без сети; данные всегда берутся с сервера.
const CACHE = "jarvis-v14";
const SHELL = ["./", "static/app.css?v=14", "static/app.js?v=14", "static/reactor.js?v=14", "static/voice.js?v=14",
  "static/standalone.js?v=14", "static/vault-template.json?v=14", "manifest.webmanifest"];

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
