Scaffold a new backend module following this project's established pattern.

**Purpose:** generate the four-file skeleton (`router.ts`, `service.ts`, `repository.ts`, `types.ts`) for a new domain module under `apps/api/src/modules/<name>/`, matching the pattern used by the 16 modules created in Phase 0.

**Preconditions:** the module's domain is covered by a Zod schema in `packages/shared/src/schemas/` (create one first if it doesn't exist yet — router validation depends on it).

**Steps:**
1. Create `apps/api/src/modules/<name>/<name>.types.ts` — module-local types only; anything shared with the frontend belongs in `packages/shared` instead.
2. Create `apps/api/src/modules/<name>/<name>.repository.ts` — all Prisma calls for this module live here, importing the singleton from `apps/api/src/lib/prisma.ts`.
3. Create `apps/api/src/modules/<name>/<name>.service.ts` — business logic, calling the repository, never Prisma directly.
4. Create `apps/api/src/modules/<name>/<name>.router.ts` — Express routes; every route runs `validate(schema)` → `authenticate` → `authorize(...)` (+ `branch-guard` if branch-scoped) before calling the service.
5. Register the router in `apps/api/src/app.ts` under `/api/<name>`.

**Naming:** kebab-case folder and file names matching `<name>`, e.g. `modules/discounts/discounts.router.ts`.
