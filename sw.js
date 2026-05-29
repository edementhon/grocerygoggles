// Service worker: cache the app shell so the PWA opens offline.
// Scans still need network (the Gemini call is never cached).
// CACHE_VERSION is bumped automatically by deploy.sh on every deploy.
const CACHE_VERSION = "gg-2026-05-29-timing";

const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./db.js",
  "./nutrition.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs. The cross-origin Gemini API goes straight to network.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).catch(() => {
        // Offline navigation falls back to the cached app shell.
        if (req.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      });
    })
  );
});
