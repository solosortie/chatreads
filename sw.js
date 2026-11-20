/* Chat's Bookshelf service worker
   - app shell: network-first (fresh after a deploy), falls back to cache offline
   - fonts / icons / book covers: cache-first
   - /api/*: never touched (the app has its own offline queue) */
const VERSION = "v1";
const SHELL = "shelf-shell-" + VERSION;
const STATIC = "shelf-static-" + VERSION;
const COVERS = "shelf-covers-" + VERSION;
const SHELL_FILES = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest"];
const STATIC_FILES = ["/fonts/fraunces.woff2", "/fonts/nunito.woff2", "/icons/favicon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];
const MAX_COVERS = 150;

self.addEventListener("install", (e) => {
  e.waitUntil(
    Promise.all([
      caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)),
      caches.open(STATIC).then((c) => c.addAll(STATIC_FILES)),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, STATIC, COVERS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(request, cacheName, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const fallback = () => caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match("/index.html"));
    const timer = setTimeout(() => {
      fallback().then((hit) => { if (hit && !settled) { settled = true; resolve(hit); } });
    }, timeoutMs);
    fetch(request).then((res) => {
      clearTimeout(timer);
      if (res && res.ok) { const copy = res.clone(); caches.open(cacheName).then((c) => c.put(request, copy)); }
      if (!settled) { settled = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fallback().then((hit) => { if (!settled) { settled = true; resolve(hit || Response.error()); } });
    });
  });
}

function cacheFirst(request, cacheName, limit) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res && (res.ok || res.type === "opaque")) {
          cache.put(request, res.clone());
          if (limit) cache.keys().then((keys) => { if (keys.length > limit) cache.delete(keys[0]); });
        }
        return res;
      });
    })
  );
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname === "covers.openlibrary.org") {
    e.respondWith(cacheFirst(req, COVERS, MAX_COVERS).catch(() => Response.error()));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(cacheFirst(req, STATIC));
    return;
  }
  if (req.mode === "navigate" || SHELL_FILES.includes(url.pathname)) {
    e.respondWith(networkFirst(req, SHELL, 3000));
  }
});
