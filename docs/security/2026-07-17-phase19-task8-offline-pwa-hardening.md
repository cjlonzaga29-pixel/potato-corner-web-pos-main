# Phase 19 Task 8 — Offline/PWA Hardening

Hardening-only per the Phase 19 plan and Locked Decision 6: validates and fixes what already exists in `apps/web`'s offline/Dexie/service-worker layer. Does not build the missing offline-sync backend endpoint (there isn't one missing — see below) or any new feature.

## Scope reviewed

`apps/web/lib/offline/db.ts`, `cache.ts`, `sync-queue.ts`; `apps/web/hooks/use-offline.ts`; `apps/web/hooks/queries/use-products.ts` (`useCatalog`); `apps/web/app/layout.tsx`; `apps/web/public/manifest.json` + `public/icons/`; `apps/web/next.config.ts`'s `@ducanh2912/next-pwa` config; `apps/web/components/pos/pos-header.tsx` and `apps/web/app/(pos)/layout.tsx`.

## Correction to earlier Phase 19 planning

The Task 8 description in the Phase 19 plan doc assumed the offline-sync backend endpoint might not exist. It does: `POST /api/transactions` is the same endpoint used for both online and synced-offline transactions — `sync-queue.ts`'s `syncOfflineTransactions()` replays each queued payload against it directly, and `tests/e2e/offline-sync.spec.ts` (Task 6) exercises this end-to-end. There is no separate reconciliation endpoint to build.

## Fixes applied (hardening, not new features)

### 1. Offline receipt-number date used UTC, not Asia/Manila local time — fixed
`lib/offline/sync-queue.ts`'s `nextOfflineSequence()` and `enqueueOfflineTransaction()` both used `Date.prototype.toISOString().slice(0, 10)`, which is always UTC. CLAUDE.md's locked Offline Receipt Numbers rule requires the sequence to "reset to 1 at midnight" — UTC midnight is 8am in Manila, so any transaction between local midnight and 8am would have used the previous day's sequence counter and the previous day's date in the receipt number itself. This is also inconsistent with this codebase's other explicit Asia/Manila business-day conventions (`apps/api/src/queues/eod.queue.ts`, `fraud.queue.ts`).

**Fix:** added `manilaDateString()` using `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' })`, used in both places. **Verified, not just authored** — added `lib/offline/sync-queue.test.ts` (3 tests: UTC/Manila-date mismatch case, same-date case, exact-midnight-rollover case) and ran it via `vitest run`: all 3 pass. This is the one piece of Task 8 work actually executed this session, unlike the E2E/k6 authoring elsewhere in Phase 19.

### 2. PWA manifest was never linked — fixed
`public/manifest.json` exists and is well-formed, but Next.js only auto-serves a manifest placed at `app/manifest.ts`/`.json`, not one under `public/` — and `app/layout.tsx`'s `metadata` object had no `manifest` field and no `<link rel="manifest">` anywhere. The browser had no way to discover the manifest at all, meaning the PWA install prompt could never appear regardless of any other PWA criteria being met.

**Fix:** added `manifest: '/manifest.json'` to `layout.tsx`'s `metadata` export. Type-checked clean (`tsc --noEmit`, exit 0).

### 3. Catalog cache had no periodic refresh — fixed
`cache.ts`'s own comment states the offline product-catalog cache must be "refreshed on connect and at least every 30 minutes during active use" (Architecture doc §10.1), and `lib/constants.ts` already declares `PRODUCT_CACHE_REFRESH_MINUTES = 30` — but nothing consumed that constant. `useCatalog`'s TanStack Query config had `staleTime: 60_000` and no `refetchInterval`, so a terminal session that stayed mounted without a refocus/reconnect event to trigger a refetch would sit on a stale cached catalog indefinitely past that first minute, not the required 30-minute ceiling.

**Fix:** added `refetchInterval: PRODUCT_CACHE_REFRESH_MINUTES * 60 * 1000` to `useCatalog` in `hooks/queries/use-products.ts`. Type-checked clean.

## Findings documented, not fixed (need real assets or runtime verification)

### 4. PWA icons don't exist — blocks actual installability, needs real assets
`public/manifest.json` references `/icons/icon-192x192.png` and `/icons/icon-512x512.png`. Neither file exists — `public/icons/` contains only a `README.md` that already flags this: *"PWA icon assets ... are not generated in Phase 0 — add real branded icons here before Phase 19 PWA testing."* Fixing the manifest link (item 2 above) makes the manifest discoverable, but Chrome's installability criteria require at least one valid icon ≥192px, so install will still fail until real branded PNGs are added. This is a design/branding dependency, not something to fabricate — flagging prominently for whoever owns brand assets, and as a known blocker for Task 9's "PWA install" checklist item specifically (other Task 9 items — offline shell load, service worker update behavior — don't depend on icons and remain testable).

### 5. `next-pwa`'s `reloadOnOnline: true` may race the app's own reconnect-sync trigger
`next.config.ts` sets `reloadOnOnline: true` on `@ducanh2912/next-pwa`, which forces a full page reload on the browser's `online` event (standard workbox/next-pwa behavior, to guarantee fresh content after being offline). `use-offline.ts` **also** listens for the same `online` event to trigger `syncOfflineTransactions()`, which drains the local transaction queue. If next-pwa's reload fires before the app's own sync completes, an in-flight sync could be interrupted mid-drain — a transaction might be posted successfully but the local Dexie record never marked `syncedAt` before the page reloads, or the reload could abort the fetch outright depending on timing.

Not fixed this session: which listener actually wins is a real browser/timing question (event-listener registration order between next-pwa's injected script and this app's own React `useEffect`) that can't be resolved by reading source — it needs to be observed on a real device. **Flagged explicitly for Task 9** to specifically test: queue a transaction offline, reconnect, and confirm the queue drains completely rather than reloading mid-sync and leaving a transaction stuck `pending`.

## Verification status

Items 1–3 are code changes: item 1 has a real, executed, passing unit test; items 2–3 are type-checked clean but have no dedicated test (item 2 has no automated way to assert "manifest is linked" without a browser; item 3 would need a fake-timers-based test, and `fake-indexeddb`/timer-mocking infrastructure for this specific hook isn't set up — adding it was judged out of scope for a one-line config fix). Items 4–5 are documented findings requiring, respectively, real design assets and real-device testing — both explicitly Task 9's job, not Task 8's.
