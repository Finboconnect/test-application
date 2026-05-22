const APP_VERSION = "2026-05-22-2";
const CACHE_NAME = `kanban-static-${APP_VERSION}`;
const ASSETS = [
  "./",
  "./index.html",
  `./style.css?v=${APP_VERSION}`,
  `./script.js?v=${APP_VERSION}`,
  `./db.js?v=${APP_VERSION}`,
  `./boards.js?v=${APP_VERSION}`,
  `./theme.js?v=${APP_VERSION}`,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(ASSETS);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") self.skipWaiting();
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fetchPromise = (async () => {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  })();

  return cached || fetchPromise;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put("./index.html", response.clone());
    return response;
  } catch {
    const cached = await cache.match("./index.html", { ignoreSearch: true });
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    (async () => {
      try {
        return await cacheFirst(request);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        return cached || Response.error();
      }
    })(),
  );
});
