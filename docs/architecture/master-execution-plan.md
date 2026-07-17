# Master Execution Plan — Enterprise Implementation Guide

**Version:** 1.0 Final | **Status:** Approved for Implementation

Consolidates the approved technology stack, toolchain, project structure, development standards, testing strategy, deployment pipeline, and the 20-phase development roadmap. This document organizes what `docs/architecture/final-approved-architecture.md` decided into an executable sequence — it does not redesign anything.

## Final Technology Stack

Each concern has exactly one tool — no two libraries compete for the same responsibility (see the actual `package.json` files for pinned versions, some of which were resolved during Phase 0 scaffolding where this document predates current npm majors — see the "Phase 0 version decisions" note below).

| Concern | Tool |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS |
| Components | shadcn/ui |
| Animations | Magic UI |
| Icons | Lucide |
| Client state | Zustand |
| Server state | TanStack Query |
| Forms | React Hook Form |
| Validation | Zod |
| Tables | TanStack Table |
| Charts (primary) | Recharts |
| Charts (widgets) | Tremor |
| Toasts | Sonner |
| Database | PostgreSQL via Supabase |
| ORM | Prisma |
| File storage | Supabase Storage |
| Queue | BullMQ |
| Cache/sessions | Upstash Redis |
| Realtime | Socket.io |
| Offline storage | Dexie.js |
| Unit/integration tests | Vitest |
| End-to-end tests | Playwright |
| Load testing | k6 *(Phase 19 addition — no load-testing tool was named before this; see `tests/load/README.md`)* |
| Error tracking | Sentry |
| Product analytics | PostHog |
| Deployment (frontend) | Vercel |
| Deployment (backend) | Render.com |
| DNS/CDN | Cloudflare |
| CI/CD | GitHub Actions |

**Phase 0 version decisions** (this document predates current npm majors; resolved with the user during Phase 0 planning — see `docs/decisions/README.md`): Zod v4, Express 5, `@ducanh2912/next-pwa` (maintained fork of the doc-named `shadowwalker/next-pwa`), Tailwind CSS v3 (the required folder structure names `tailwind.config.ts`, a v3-era artifact), Prisma 5.x (matching this document's own Context7 reference to "Prisma 5 query syntax").

State-management separation rule (never crossed): data from the database → TanStack Query. Data that lives in the browser only (cart, shift, UI state, branch context, identity cache, offline sync status) → Zustand.

## Project Folder Structure

The monorepo structure is implemented exactly as specified — see the actual repository tree rather than duplicating it here. Reference: `pnpm-workspace.yaml`, `apps/web/`, `apps/api/`, `packages/shared/`, `packages/config/`.

## Development Standards

kebab-case files/folders, PascalCase components, camelCase hooks/utilities. REST conventions (plural nouns, no verbs, `PATCH` not `PUT`). Conventional commits (`feat|fix|docs|test|refactor|chore|perf`, imperative mood). Branch strategy: `main` (production, protected) ← `staging` (protected) ← `develop` ← `feature/*`/`fix/*`/`hotfix/*`. PRs require passing CI + architecture-doc reference; two approvals for anything touching auth, payments, or audit logging.

TypeScript strict, no `any`, no `!` without a justifying comment. Function components only, one per file, `[ComponentName]Props` interface naming. Every API handler validates with Zod, returns `{ data, error, meta }`, never leaks stack traces, routes all DB access through the repository layer. Async operations wrapped in try/catch, errors logged to Sentry before responding; operational errors → 4xx with specifics, system errors → 500 generic + Sentry.

## Development Roadmap — 20 Phases

| Phase | Goal |
|---|---|
| 0 | Environment and repository setup — monorepo, CI/CD, Prisma schema, seed data, every service configured end to end |
| 1 | Authentication foundation — JWT RS256, refresh rotation, lockout, PIN login, route-protection middleware |
| 2 | Role-based access control — authenticate/authorize/branch-guard/shift-guard middleware, full permission-boundary tests |
| 3 | Shared component library — shadcn/ui, DataTable (TanStack Table), shared forms/loading/error states, chart wrappers |
| 4 | Branch management — CRUD, GPS radius config, branch code generation (Redis INCR), supervisor assignment, branch selector |
| 5 | Employee management — govt ID encryption, CRUD, deactivation-while-shift-active handling |
| 6 | Product catalog management — products/variants/flavors, lifecycle state machine, branch availability, image upload |
| 7 | Recipe management — **go/no-go gate**: recipe deduction algorithm unit tests must be signed off before Phase 8 |
| 8 | Inventory management core — BullMQ deduction queue, retry policy, out-of-stock cascade, adjustment/waste/physical-count/transfer workflows |
| 9 | POS terminal — shift and cash — shift API, denomination opening count, shift guard, Zustand shift store |
| 10 | POS terminal — transactions — cart, discount + VAT calc, cash/GCash payment, hold orders, offline processing, receipts |
| 11 | POS terminal — closing and reconciliation — closing count, variance approval, cashier handover detection |
| 12 | Attendance system — clock in/out, GPS validation, time-delta flagging, break tracking, correction workflow |
| 13 | Real-time WebSocket layer — Socket.io + Redis adapter, room management, all event broadcasts, activity feed |
| 14 | Supervisor dashboard — operations panel, approval queues, inventory/attendance/shift panels, branch-level reports |
| 15 | Super Admin dashboard — company KPIs, branch rankings, fraud alert investigation UI, catalog/employee/system config |
| 16 | ✅ **Done** (PR #7, 2026-07-17) — Reporting system — all 13 report types, 15-minute pre-compute jobs, CSV/PDF export, access audit logging |
| 17 | ✅ **Done** (PR #7, 2026-07-17) — Fraud detection system — nightly job, all 7 detection rules, investigate/dismiss/escalate workflow |
| 18 | ✅ **Done** — Notifications and EOD summary — delivery pipeline, EOD job at 11:59 PM |
| 19 | ✅ **Done** — Production testing and hardening — full Playwright suite, load testing, offline/sync edge cases, security audit, minimum-device PWA testing |
| 20 | 🟡 **In Progress** — Pilot branch deployment — production config, recipe testing protocol sign-off, 3-day Super Admin on-call, feedback collection |

Sequencing rationale: auth gates everything → RBAC must be proven before the features it protects → shared components before feature UI → data foundation (branches/employees/products/recipes/inventory) before the POS → POS before dashboards → dashboards before reports. The POS terminal reaches functional state before significant investment in admin interfaces, since every other feature depends on data the POS generates.

## Testing Strategy

Unit-tested (business correctness > coverage %): recipe deduction algorithm (every edge case), PWD/Senior VAT formula, cash variance calculation, fraud detection rule logic, offline provisional receipt number generation, inventory cascade logic, discount precedence, all Zod schemas. Target: 80% line coverage, weighted toward business logic.

Integration-tested against a real test database: API auth/authorization, full transaction creation flow, inventory deduction job execution, attendance clock-in + GPS validation, cash count + variance, report data accuracy.

End-to-end (Playwright, two device projects — mobile POS + desktop admin): full login for all three roles, shift open → transaction → shift close, cash/GCash payment, PWD discount + VAT verification, hold order lifecycle, void + approval, stock-in recording, attendance clock-in with GPS, variance approval, offline processing + reconnect sync.

## Deployment Strategy

Four environments: Development (local), Preview (Vercel/Render PR environments), Staging (`staging.potatocorner.app`), Production (`app.potatocorner.app`). Three separate Supabase projects (dev/staging/production) — schema changes only via Prisma Migrate, never the Supabase dashboard directly.

Rollback decision tree: frontend-only issue → one-click Vercel rollback; API issue without DB change → one-click Render rollback; API issue with DB change → apply the tested down-migration then rollback Render, or fix-forward if the migration can't be reversed; data corruption → Supabase point-in-time recovery.

## Monitoring

Sentry: unhandled errors (frontend + backend), BullMQ job failures, WebSocket errors, tagged with user/branch context; alert on any new error type, >10 errors/min, or any transaction-path error. Performance thresholds: 2s general API, 500ms transaction endpoint. PostHog (frontend only, anonymized): login funnel, transaction completion funnel, feature adoption, offline-mode frequency — product-improvement signal only, never operational monitoring (that's Sentry's job).

## Claude Code Workflow

`.claude/CLAUDE.md` is the master project-rules file, read at the start of every session. Custom commands: `/new-module`, `/review-security`, `/generate-tests`, `/check-architecture` (see `.claude/commands/`). Durable context docs live in `.claude/context/`. Task breakdown pattern for any feature larger than one function: Feature → Module → Dependencies → Backend tasks (repository/service/router) → Frontend tasks (query hook/store change/component) → Tests (unit/integration/e2e).

## Production Readiness Checklist

Security, database, performance, offline, business-logic, operations, monitoring, and deployment checklists — see Final Approved Architecture Part 16 for the four critical pre-Phase-0 items (all confirmed complete) and this document's own high-priority list for what must be confirmed before the Phase 20 pilot launch.
