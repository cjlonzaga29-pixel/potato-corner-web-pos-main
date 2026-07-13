# API Contracts

No endpoints are implemented yet — `apps/api/src/modules/*/[module].router.ts` are Phase 0 skeletons. This document records the conventions every endpoint must follow once implemented (Master Execution Plan §7.1), so contracts stay consistent as modules land in later phases.

## Conventions

- REST, plural nouns, no verbs in paths: `GET /api/products`, `GET /api/products/:id`, `POST /api/products`, `PATCH /api/products/:id` (not `PUT`), `DELETE /api/products/:id` (soft delete → `archived`).
- Nested resources: `GET /api/branches/:id/inventory`, `POST /api/branches/:id/inventory/adjustments`.
- Every response shape: `{ data, error, meta }` (see `app.ts` and every hand-written middleware skeleton in `apps/api/src/middleware/`).
- Every endpoint validates its payload with a Zod schema from `@potato-corner/shared` via the `validate` middleware before business logic runs.
- Every protected endpoint runs `authenticate` → `authorize` (+ `branch-guard` where the resource is branch-scoped) before the route handler.
- No direct Prisma calls in routers — always through the module's repository layer.

## Endpoint contracts

To be filled in module-by-module as each backend module is implemented, starting with `auth` in Phase 1. Each module's request/response schemas already exist in `packages/shared/src/schemas/` where scaffolded in Phase 0 — routers should import and reuse them rather than redefining shapes inline.
