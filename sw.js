const CACHE = "mining-static-v1";
const SENSITIVE = /auth\.json|latest\.json|version\.json|command\.enc|webauthn_reg/i;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (SENSITIVE.test(url.pathname)) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok && !url.search.includes("_=")) {
        cache.put(event.request, response.clone());
      }
      return response;
    }),
  );
});
