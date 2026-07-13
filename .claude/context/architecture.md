# Architecture Context

Full detail: `docs/architecture/final-approved-architecture.md` and `docs/architecture/master-execution-plan.md`. This file is a fast-loading summary for grounding a session — read the full docs before implementing anything non-trivial.

## Module boundaries

Backend is a modular monolith (`apps/api/src/modules/*`), 16 domains: auth, branches, products, flavors, recipes, inventory, transactions, discounts, receipts, employees, attendance, cash, reports, notifications, audit, fraud. Modules call each other via direct function calls in-process — never HTTP between modules. BullMQ (`apps/api/src/queues/*`) handles only async work that must not block an API response (inventory deduction, notifications, report pre-compute, nightly fraud detection).

Frontend is one Next.js app with four route groups delivering three role-based interfaces: `(auth)`, `(admin)` [Super Admin], `(supervisor)`, `(pos)` [Staff]. Route protection is enforced in `apps/web/middleware.ts` before a protected page renders.

## Request flow (prose)

Client → `apps/web/lib/api-client.ts` (attaches in-memory access token) → Express `apps/api/src/app.ts` → per-route middleware chain (`authenticate` → `authorize` → `branch-guard` where branch-scoped → `validate(zodSchema)`) → module service → module repository → Prisma → Postgres. Side effects that shouldn't block the response (inventory deduction, notifications) are enqueued to BullMQ instead of awaited inline.

## Offline-sync model

POS terminal caches the product catalog in Dexie/IndexedDB (`apps/web/lib/offline/cache.ts`), refreshed on connect and every 30 minutes. Offline transactions get a provisional number (`PC-[BRANCH]-[DATE]-OFFLINE-[LOCAL_SEQ]`, per-device daily counter, resets at midnight), queued in `apps/web/lib/offline/db.ts`, and drained in chronological order by `apps/web/lib/offline/sync-queue.ts` once connectivity returns — the server then assigns the official `transaction_number`.

## Realtime model

Socket.io, room-per-branch (`apps/api/src/socket/rooms.ts`), Super Admin joins every room. Event names are shared constants (`packages/shared/src/constants/events.ts`) — the server and client must never hardcode event-name strings independently.
