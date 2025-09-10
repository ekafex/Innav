const CACHE = "indoor-nav-v3";
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

  // Only handle same-origin
  if (url.origin !== location.origin) return;

  // Use request.destination to classify:
  // - cache-first for the "app shell" (document/script/style/json/svg)
  // - network-first for big 360 images under /media/
  const dest = request.destination; // 'document','script','style','image','audio','font','manifest',''
  const isAppShell =
    dest === "document" || dest === "script" || dest === "style" ||
    dest === "manifest" ||
    url.pathname.endsWith(".json") || url.pathname.endsWith(".svg");

  const isMedia = url.pathname.includes("/media/");

  if (isAppShell) {
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
        const res = await fetch(request, { cache: "no-store" });
        return res;
      } catch {
        const cached = await caches.match(request);
        return cached || Response.error();
      }
    })());
  }
});
