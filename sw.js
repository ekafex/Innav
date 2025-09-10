const CACHE = "indoor-nav-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./data/floor.svg",
  "./data/graph.json",
  "./data/media_map.json",
  "./data/aliases.json",
  "./data/walkable.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k === CACHE ? null : caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Cache-first for app shell & data; network-first for media/
  const isAppAsset =
    url.origin === location.origin &&
    (url.pathname.endsWith(".html") ||
     url.pathname.endsWith(".css") ||
     url.pathname.endsWith(".js") ||
     url.pathname.startsWith("/data/") ||
     url.pathname.endsWith(".svg"));

  const isMedia = url.origin === location.origin && url.pathname.startsWith("/media/");

  if (isAppAsset) {
    e.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const res = await fetch(request);
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
      return res;
    })());
  } else if (isMedia) {
    e.respondWith((async () => {
      try {
        const res = await fetch(request);
        return res;
      } catch {
        const cached = await caches.match(request);
        return cached || Response.error();
      }
    })());
  }
});

