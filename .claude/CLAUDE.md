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

## Task Completion Handoff Protocol

At the end of every completed task (feature, fix, refactor, or verification), generate a **Handoff Command Block** the user can paste into a new Claude Code chat to resume or hand off the work.

### When to generate

- After every successful commit + push + CI green
- After a task is marked complete via user confirmation ("all done", "verified", "complete")
- After a session-ending decision ("pause", "end session", "stop here")

### Handoff Command Block format

Output a fenced markdown block titled `## 📋 Next-Chat Handoff Command` containing:

1. **Context summary** (3-5 lines max)
   - Last commit hash + message
   - What was just completed
   - Current git state (clean/dirty, branch, ahead/behind origin)

2. **Ready-to-paste Claude Code command** with a STRICT TOKEN MODE header, containing:
   - `CRITICAL FIRST STEP: cd potato-corner-web-pos-main` + verify pwd + `git log --oneline -3`
   - Expected repo state (specific commit hash to verify HEAD matches)
   - Immediate next action(s) available (verify / test / continue to next feature)
   - Any pending manual steps (approval at GitHub Actions, env vars to add to Vercel, etc.)

3. **Known blockers or context** the next session needs
   - Pending CI approvals
   - Rate limit windows to respect
   - Tech debt introduced or discovered
   - Dependencies on external actions

### Example structure

```markdown
## 📋 Next-Chat Handoff Command

**Last commit:** `abc1234` — feat(x): shipped feature X
**Status:** Pushed to main, CI awaiting approval
**Git state:** Clean working tree, on main, 1 commit ahead of origin

Paste this into a new Claude Code session to resume:

​```
claude "
STRICT TOKEN MODE
======================================================================
- No skills, no subagents
- Minimize tokens aggressively
- Do NOT print .env or credential contents

CRITICAL FIRST STEP: cd potato-corner-web-pos-main. Verify pwd + git log --oneline -3 shows abc1234 at top.

CONTEXT: Just shipped [feature X]. Awaiting user approval at GitHub Actions for deployment.

AVAILABLE NEXT ACTIONS:
1. Verify deployment: gh run watch <id> --exit-status
2. Run production Playwright suite for regression check
3. Proceed to next roadmap step: [Step Y]

PENDING MANUAL STEPS:
- User must approve deployment at github.com/[org]/[repo]/actions
- [Any env vars to add]

TECH DEBT INTRODUCED (if any):
- [List]
"
​```
