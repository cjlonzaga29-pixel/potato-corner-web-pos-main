/**
 * POS-PERF-P62 — removes API responses the service worker stored before P62.
 *
 * next-pwa's default runtime caching kept every same-origin GET /api/* response
 * for 24 hours in a cache named "apis", keyed by URL alone, and served it when
 * the network was slow or offline. The Authorization header is not part of the
 * key, so one user's response could be shown to the next user of the device.
 * next.config.ts now sends /api/* to the network only; this deletes what an
 * upgraded browser still holds, and runs again whenever the identity changes.
 *
 * Only API responses are touched. The precache, static assets, and the offline
 * sale queue, drafts and catalog snapshot (Dexie, lib/offline/db.ts) are not.
 */
export const LEGACY_API_CACHE_NAME = 'apis';

function isApiUrl(url: string): boolean {
  try {
    return new URL(url, 'http://local').pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

export async function purgeApiResponseCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    await caches.delete(LEGACY_API_CACHE_NAME);
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (isApiUrl(request.url)) await cache.delete(request);
      }
    }
  } catch {
    // Cache Storage unavailable (private mode, blocked storage): nothing was stored.
  }
}
