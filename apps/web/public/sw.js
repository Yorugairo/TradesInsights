/* eslint-disable no-undef */
/**
 * Service worker — deliberately small (mobile ADR-7).
 *
 * It does exactly two things:
 *   1. Precaches the offline fallback page.
 *   2. Network-first with cache fallback for `GET /field/*`, so a crew who
 *      loaded the brief in the parking lot can still read it in the basement.
 *
 * It does NOT:
 *   - cache session-gated /app/* pages — stale account data is worse than an
 *     honest network error;
 *   - touch the entries POST — the outbox owns writes, and two mechanisms with
 *     one job is how writes get lost or doubled;
 *   - register a `sync` handler — iOS has no Background Sync API, so that code
 *     would look implemented and never run. Replay is driven from the page.
 *
 * BUMP `CACHE` ON EVERY EDIT or installed clients keep serving the old shell:
 * `activate` deletes caches whose name is not the current one, which is the
 * only eviction path here.
 */

const CACHE = "otn-shell-v1";
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL]))
      // A precache miss must not abort installation — the SW is still useful
      // for the /field/* runtime cache, and a failed install would leave the
      // client with no worker at all.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // writes belong to the outbox

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isFieldPage = url.pathname.startsWith("/field/");
  if (!isFieldPage) return; // everything else: straight to the network

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only cache a genuinely good response. Caching an error page would
        // pin "link unavailable" on the device until the next online visit.
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const offline = await caches.match(OFFLINE_URL);
        return (
          offline ??
          new Response("Offline and this page has not been opened on this device yet.", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        );
      }),
  );
});
