# API Contracts Context

Full detail: `docs/architecture/api-contracts.md`. No endpoints are implemented yet as of Phase 0 — this file records the conventions so Phase 1+ endpoints stay consistent from the first one written.

## Response shape

Every endpoint returns `{ data, error, meta }` — see the pattern already used in the Phase 0 skeletons (`apps/api/src/app.ts` health check, `apps/api/src/middleware/*`). Never return a bare object or array at the top level.

## Route conventions

Plural nouns, no verbs, nested resources for branch-scoped data (`GET /api/branches/:id/inventory`), `PATCH` not `PUT` for partial updates, `DELETE` means soft-delete to `archived`/`deleted_at`, never a hard delete.

## Middleware chain order

`validate(schema)` → `authenticate` → `authorize(...)` → `branch-guard(...)` (only for branch-scoped resources) → handler. Getting this order wrong (e.g. authorizing before validating) can leak information about valid payload shapes to unauthenticated requests.

## Schema reuse

Request/response schemas live in `packages/shared/src/schemas/` — a router should import an existing schema, not redefine an inline Zod shape. If a module needs a schema that doesn't exist yet, add it to `packages/shared` first so the frontend can share the exact same validation and inferred type.
