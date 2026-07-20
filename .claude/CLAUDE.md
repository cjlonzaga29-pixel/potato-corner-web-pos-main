# Potato Corner POS — Claude Code Project Rules

**Last verified:** 2026-07-20 (see `docs/SYSTEM_OVERVIEW.md` for authoritative current state)

## Project Overview

Enterprise Web POS and Branch Management Platform for the Potato Corner franchise. Multi-branch QSR operation in the Philippines. Three role-based interfaces (Super Admin, Supervisor, Staff POS) from one Next.js codebase.

Full specifications: `docs/architecture/final-approved-architecture.md` (business rules, database schema, algorithms) and `docs/architecture/master-execution-plan.md` (stack, standards, 20-phase roadmap). Nothing in those documents is open for discussion without a formal change request — implement what they say, don't redesign it.

**Current status:** Phases 0–19 complete (through production hardening), plus CR-001 (product catalog refactor + branch recipe overrides, layered on top of Phase 7). Phase 20 (pilot branch deployment) is in progress — recipe testing protocol, hold orders backend, offline sync batch endpoint, and the large-adjustment approval producer are done; production environment config, PWA device verification, staff clock-in UI, and pilot cutover remain open. External services (Supabase, Render, Vercel, Resend) are live and wired. Upstash/Redis was fully removed in Phase 21 (see "Recent phases" below).

**Recent phases (post Phase 20, not yet reflected above):**
- Phase 20.5 — refresh-token race fix: Postgres advisory lock + rotation-result cache (commit `9507200`).
- Phase 21 — Redis eradication: locks/blacklist/queues migrated to Postgres-native (`pg-lock.ts`, `id-counter.ts`, `job-runner.ts`) (commit `28a2956`).
- Phase 21.5 — restored a Postgres rotation-result cache that Phase 21 had inadvertently dropped (commit `6116ff1`).

## Architecture

- Monorepo: pnpm workspaces + Turborepo
- Frontend: Next.js 15 App Router, React 19, TypeScript, Tailwind CSS v3, shadcn/ui
- Backend: Node.js Express 5 modular monolith, TypeScript
- Database: PostgreSQL via Supabase Pro, Prisma ORM
- Queue: Postgres-native job runner (`apps/api/src/lib/job-runner.ts`) — replaced BullMQ/Upstash Redis in Phase 21
- Realtime: Socket.io, single in-memory adapter — no Redis adapter (removed Phase 21); does not horizontally scale past one instance
- Offline: Service Worker (`@ducanh2912/next-pwa`) + Dexie.js IndexedDB

## Critical Business Rules — Never Modify Without Explicit Instruction

**Recipe Deduction Algorithm**
```
Step 1: Collect base ingredients (flavor_id IS NULL)
Step 2: Collect flavor-specific ingredients (flavor_id = selected)
Step 3: Flavor-specific quantity overrides base for same ingredient
Step 4: Multiply all quantities by items sold
Step 5: Deduct atomically
```

**PWD/Senior Citizen VAT Formula**

Per RA 9994 / RA 10754, PWD and Senior Citizen sales are true VAT-exempt transactions — VAT is never charged, not even added back after the discount (updated 2026-07-21, commit 4 of the P1 discount fix; superseded the prior "VAT still charged on discounted base" formula).

```
VATable base = total ÷ 1.12
Discount = VATable base × 0.20
Discounted base = VATable base - discount
Total = discounted base (no VAT added — fully exempt)
```

**Transaction Number**
`transaction_number` IS the receipt number. Same field. Same value everywhere. No separate receipt number exists.

**Offline Receipt Numbers**
Format: `PC-[BRANCH]-[DATE]-OFFLINE-[LOCAL_SEQ]`. Resets to 1 at midnight. Replaced with the official number after sync.

**JWT Structure**
```
Super Admin: { user_id, role, email }
Supervisor:  { user_id, role, email, branch_ids: [uuid, ...] }
Staff:       { user_id, role, email, branch_ids: [uuid] }
```

## Code Standards

- TypeScript strict mode, no `any`, no `!` without a comment explaining why it's safe
- kebab-case files and folders, PascalCase components, camelCase hooks/utilities
- One component per file
- Zod validates every API request payload (schemas live in `packages/shared`)
- No direct Prisma calls in routers — always through the repository layer
- Server Components by default in Next.js App Router, `"use client"` only when needed
- Conventional commits (`feat|fix|docs|test|refactor|chore|perf`, imperative mood)

## Module Structure

Each backend module (`apps/api/src/modules/<name>/`) contains: `<name>.router.ts`, `<name>.service.ts`, `<name>.repository.ts`, `<name>.types.ts`.

## Database & Migration Safety

Never run `prisma migrate dev` or `prisma migrate diff --from-url` against a connection string that isn't explicitly verified as the local/dev shadow DB. This project uses a three-URL pattern, and mixing them up is the one mistake that reaches production data directly:

- `DATABASE_URL` → Transaction Pooler (runtime, port 6543)
- `DIRECT_URL` → Session Pooler (local dev, port 5432)
- `PRODUCTION_DATABASE_URL_DIRECT` → raw direct connection (CI only, port 5432)

Reason this rule exists: during Phase 18, `prisma migrate dev` was run locally against a connection string that turned out to be the production Supabase project, not the local shadow DB, creating a phantom migration (`20260717183737_add_recipe_unique_constraint`) that had to be resolved as `--rolled-back`. Always verify `DIRECT_URL`'s actual target — print it or check the host in the connection string — before running any `prisma migrate` command, every time, even when you're confident which environment you're in.

## State Management Separation

Data from the database → TanStack Query. Data that lives in the browser only (POS cart, shift state, UI state, branch context, auth identity cache, offline sync status) → Zustand. These responsibilities never overlap.

## Do Not

- Add libraries not in the approved stack
- Modify the authentication JWT structure
- Change the database schema without a Prisma migration
- Use raw SQL instead of Prisma
- Store secrets in code
- Create API routes in Next.js — all API logic lives in the Express backend (`apps/web/app/api/health` is the sole exception, a liveness probe)
