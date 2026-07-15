# Potato Corner Enterprise Web POS — Project Status Report

**Generated:** 2026-07-14 · **Last updated:** 2026-07-15 (incremental — Phases 8-11 completion verified from live repo state: migration count, mounted routes, test suite results; sections not touched by that work — security audit, TODO inventory, per-page frontend classification — are carried over unchanged from the original full audit below and may need a fresh pass). **Method:** full static audit of every file in the repository (two parallel deep-research passes over backend/infra and frontend/docs) plus live execution of `type-check`, `lint`, `test`, and `build` across all workspaces. All findings below are cited with `file:line` where practical.

> **Headline finding before anything else:** the project's own status documentation is stale. `.claude/CLAUDE.md` and `docs/architecture/api-contracts.md` both still say *"Phase 0 complete, Phase 1 next, no external services wired up."* The actual codebase is functionally through **Phase 11 of 20** (as of 2026-07-15), plus an entire unplanned change request (CR-001), with a live Supabase database and a live Vercel deployment. Treat every "current status" line in the docs as outdated relative to this report — including, ironically, the "Phase 7" claim in the rest of this document below this line, which predates Phases 8-11.

---

## 1. Project Overview

**Potato Corner Enterprise Web POS & Branch Management Platform** — a unified web application serving three role-based interfaces (Super Admin, Supervisor, Staff POS) for a multi-branch Philippine QSR (quick-service restaurant) franchise, from a single Next.js + Express codebase. Core design principles per the locked architecture spec: one web app, no mobile app, no separate deployments; offline-first POS terminal; recipe-driven inventory deduction; cash as a primary financial control (denomination-level reconciliation); immutable hash-chained audit trail; and Philippine legal compliance (PWD/Senior Citizen VAT, BIR receipts) built into the core transaction engine, not bolted on.

Architecture and business rules are locked documents (`docs/architecture/final-approved-architecture.md`, scored **7.8/10 (≈8.5/10 post-fixes)** at sign-off) — "nothing here is open for discussion without a formal change request." One change request (CR-001: branch-level product requests + price overrides) has since been approved and fully implemented on top of the original spec.

---

## 2. Current Development Phase and Completion Percentage

The roadmap is 20 phases (`docs/architecture/master-execution-plan.md`). Actual implementation state, verified against real code (not the stale doc claims). **Rows for Phases 8-11 updated 2026-07-15** — all four are now substantively complete; the rest of this table is carried over from the 2026-07-14 audit:

| Phase | Goal | Status |
|---|---|---|
| 0 | Environment & repo setup | ✅ Done |
| 1 | Authentication foundation | ✅ Done |
| 2 | Role-based access control | ✅ Done |
| 3 | Shared component library | ✅ Done |
| 4 | Branch management | ✅ Done |
| 5 | Employee management | ✅ Done |
| 6 | Product catalog management | ✅ Done |
| 7 | Recipe management (go/no-go gate) | ✅ Done — deduction-algorithm unit tests pass |
| — | **CR-001** (branch price overrides + product requests) | ✅ Done — unplanned addition, fully implemented both ends |
| 8 | Inventory management core | ✅ Done — full CRUD + adjustments/waste/count/transfer, 13 mounted routes (`/api/inventory`, `/api/branches` inventory sub-routes), BullMQ deduction queue wired and firing on committed sales |
| 9 | POS terminal — shift & cash | ✅ Done — shift open/close, denomination counting, `shiftGuard` activated, 8 mounted routes under `/api/cash` |
| 10 | POS terminal — transactions | ✅ Done — cart/checkout/payment/void/refund, 6 mounted routes under `/api/transactions`, BullMQ inventory deduction hooked to every committed sale |
| 11 | POS terminal — closing/reconciliation | ✅ Done — denomination-count reconciliation at close, EOD summary object (`GET /api/cash/:shiftId/summary`), variance approve/reject flow, admin (`/admin/shifts`) + supervisor (`/supervisor/cash`) review UI |
| 12 | Attendance system | ❌ Not started (route stub) |
| 13 | Real-time WebSocket layer | 🟡 Transport wired, **auth is spoofable** (see §14 — not re-verified since 2026-07-14, may already be stale) |
| 14 | Supervisor dashboard | ❌ Not started (route stub) |
| 15 | Super Admin dashboard | ❌ Not started (route stub) |
| 16 | Reporting system | ❌ Not started (route stub) |
| 17 | Fraud detection system | ❌ Not started (route stub) |
| 18 | Notifications & EOD summary | ❌ Not started (route stub) |
| 19 | Production testing & hardening | ❌ Not started |
| 20 | Pilot branch deployment | ❌ Not started |

**Completion estimate: ~55%.** 12 of 20 phases (plus CR-001) are substantively complete with real tests passing — the entire POS terminal transaction lifecycle (shift open → sell → close/reconcile) now works end to end. The remaining 8 phases — attendance, both dashboards, reporting, fraud detection, notifications/EOD-job, production hardening, and pilot rollout — haven't been touched. Backend hosting (Render) is still not provisioned as of this update (not re-checked this session, carried over from 2026-07-14).

---

## 3. Full Tech Stack

| Layer | Tool | Confirmed version |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | pnpm 11.10.0, Turborepo ^2.10.4 |
| Frontend framework | Next.js (App Router) | 15.5.20 |
| UI runtime | React | 19.1.0 |
| Language | TypeScript (strict) | ^5.7.3 |
| Styling | Tailwind CSS | v3.4.19 |
| Components | shadcn/ui (Radix-based) | — |
| Animation | Magic UI (`number-ticker`) | — |
| Icons | Lucide | — |
| Client state | Zustand | — |
| Server state | TanStack Query | v5 |
| Tables | TanStack Table | — |
| Forms | React Hook Form + Zod resolvers | — |
| Charts | Recharts + Tremor | — |
| Toasts | Sonner | — |
| Offline storage | Dexie.js (IndexedDB) | wired, not yet populated (Phase 10 TODO) |
| Realtime client | Socket.io client | ^4.8.1 |
| Backend runtime | Node.js, Express | Express 5.0.1 |
| Backend language | TypeScript (ESM, `type: module`) | — |
| ORM | Prisma | ^5.22.0 |
| Database | PostgreSQL via Supabase | live, 8 migrations applied (updated 2026-07-15; was 3) |
| Queue | BullMQ | ^5.34.6 — inventory deduction queue live and firing on every committed sale (updated 2026-07-15; other queues — fraud/report/notification — still TODO) |
| Cache/session/rate-limit | Redis (`ioredis`) | ^5.10.1 |
| Realtime server | Socket.io + Redis adapter | ^4.8.1 / ^8.3.0 |
| File storage | Supabase Storage | referenced, not yet integrated in code |
| Validation | Zod | ^4.0.0, shared schemas in `packages/shared` |
| Email | Resend (SDK) | ^4.0.1, optional/dev-fallback |
| Error tracking | Sentry | `@sentry/node` ^8.47.0 (backend only — no `@sentry/nextjs` in frontend yet) |
| Product analytics | PostHog | not installed anywhere yet |
| Unit/integration tests | Vitest | ^3.0.2 (backend only — no frontend test runner configured) |
| E2E tests | Playwright | `@playwright/test`, 4 skipped spec stubs |
| CI/CD | GitHub Actions | 3 workflows, deploy steps incomplete |
| Frontend hosting | Vercel | **live** — project `potato-corner-pos` |
| Backend hosting | Render.com (planned) | **not provisioned** — no config exists |

---

## 4. Folder Structure

```
potato-corner-web-pos-main/
├── .claude/                  Claude Code rules, commands, durable context docs
│   ├── CLAUDE.md             Master rules file (stale "Phase 0" status line)
│   ├── commands/             /new-module, /review-security, /generate-tests, /check-architecture
│   └── context/              architecture.md, business-rules.md, database-schema.md, api-contracts.md
├── .github/
│   ├── workflows/            ci.yml, deploy-staging.yml, deploy-production.yml
│   └── CODEOWNERS, pull_request_template.md
├── .vscode/                  extensions.json, settings.json, launch.json
├── apps/
│   ├── api/                  Express 5 backend (modular monolith)
│   │   ├── prisma/           schema.prisma (25 models), 3 migrations, seed.ts
│   │   └── src/
│   │       ├── config/       zod-validated env schema
│   │       ├── lib/          redis, encryption, email, hash, request helpers
│   │       ├── middleware/   authenticate, authorize, branch-guard, shift-guard,
│   │       │                 require-password-change, validate, rate-limiter, audit-log
│   │       ├── modules/      18 domains — 9 implemented, 9 stub (see §5)
│   │       ├── queues/       inventory, fraud, report, notification (all TODO processors)
│   │       ├── socket/       socket.server.ts (room-per-branch, auth NOT verified — see §14)
│   │       └── types/
│   └── web/                  Next.js 15 frontend (all three role interfaces)
│       ├── app/
│       │   ├── (admin)/      Super Admin routes — 9 built, 5 stub
│       │   ├── (auth)/       login, change-password, reset-password — all built
│       │   ├── (pos)/        terminal, shift, receipts — all Phase-labeled stubs
│       │   ├── (supervisor)/ 6 built, 5 stub
│       │   ├── api/health/   sole Next.js API route (liveness probe, per architecture rule)
│       │   └── r/[txn]/      public receipt page — stub
│       ├── components/       admin/, supervisor/, pos/ (mostly empty), shared/, ui/ (shadcn)
│       ├── hooks/             queries/ (TanStack Query hooks per domain) + use-auth/-branch/-cart/-offline/-socket
│       ├── lib/               api-client, constants, device, jwt, socket, offline/{cache,db,sync-queue}
│       ├── stores/            auth, branch, cart, shift, ui (Zustand)
│       └── middleware.ts      route-group auth/role redirect guard
├── packages/
│   ├── config/                shared eslint/typescript/prettier config
│   └── shared/                Zod schemas, inferred types, shared constants (roles, statuses, socket events)
├── docs/
│   ├── architecture/          final-approved-architecture.md, master-execution-plan.md,
│   │                          api-contracts.md (stale), database-schema.md (stale)
│   ├── decisions/, runbooks/, training/   placeholder READMEs
├── tests/
│   ├── e2e/                   4 Playwright specs, all `test.skip(...)` stubs
│   └── helpers/
├── TOOLING_SETUP.md            CLI/extension setup guide (this session's earlier deliverable)
├── turbo.json, pnpm-workspace.yaml, package.json
└── README.md
```

---

## 5. Feature Status Table

| Module | Backend | Frontend | Tests | Overall status |
|---|---|---|---|---|
| Auth (login, refresh, PIN, lockout, password reset) | ✅ 9 endpoints | ✅ login/change-password/reset-password pages complete | ✅ 11 unit tests | **Completed** |
| RBAC middleware (authenticate/authorize/branch-guard/shift-guard) | ✅ Full chain | — | ✅ 32 unit tests | **Completed** |
| Branches | ✅ 9 endpoints | ✅ list + detail, full CRUD dialogs | ✅ 14 unit tests | **Completed** |
| Employees | ✅ 10 endpoints incl. govt-ID encryption | ✅ list + detail, both admin & supervisor scopes | ✅ 18 unit tests | **Completed** |
| Products & variants | ✅ 12 endpoints, image upload | ✅ list + detail | ✅ 24 unit tests | **Completed** |
| Flavors | ✅ 6 endpoints | ✅ list + detail | ✅ 8 unit tests | **Completed** |
| Recipes (deduction algorithm) | ✅ 9 endpoints, override precedence | ✅ recipe override management page | ✅ 6 unit tests | **Completed** — the go/no-go gate passed |
| Product requests (CR-001) | ✅ full approval workflow | ✅ submit + review UI | ✅ 9 unit tests | **Completed** |
| Price overrides (CR-001) | ✅ full approval workflow | ✅ submit + review UI | ✅ 10 unit tests | **Completed** |
| Inventory (ingredient master + deduction, adjustments, counts, transfers) | ✅ 13 mounted routes, BullMQ deduction queue live | ✅ supervisor inventory + count/adjust/waste/stock-in/movements pages | ✅ unit + repository + router tests | **Completed** (updated 2026-07-15) |
| POS terminal (cart, checkout, payment, receipts) | ✅ 6 mounted routes (`/api/transactions`), void/refund/receipt-printed | ✅ terminal + receipt-modal built | ✅ unit + repository + router tests (e2e still skipped) | **Completed** (updated 2026-07-15) |
| Shift & cash management (open/close/reconciliation) | ✅ 8 mounted routes (`/api/cash`), EOD summary + variance approve/reject | ✅ shift open/close pages, `/admin/shifts` + `/supervisor/cash` review UI | ✅ unit + repository + router tests (e2e still skipped) | **Completed** (updated 2026-07-15, Phase 9 + Phase 11) |
| Attendance | ❌ stub router | ❌ placeholder page | ❌ none | **Not started** |
| Real-time (Socket.io) | 🟡 transport + rooms exist | ✅ client wired, mounted globally | ❌ none | **Broken/insecure** — see §14, auth bypass |
| Supervisor dashboard | — | ❌ Phase-labeled placeholder | ❌ none | **Not started** |
| Super Admin dashboard | — | ❌ Phase-labeled placeholder | ❌ none | **Not started** |
| Reporting (13 report types) | ❌ stub router | ❌ placeholder pages | ❌ none | **Not started** |
| Fraud detection | ❌ stub router | ❌ placeholder page | ❌ none | **Not started** |
| Notifications / EOD summary | ❌ stub router, 1/N job types implemented | ✅ bell component exists, no data source | ❌ none | **Not started** |
| Audit logging | ✅ hash-chained writer implemented | ❌ no viewer UI (placeholder page) | — | **Backend done, frontend not started** |
| Offline sync (Dexie/IndexedDB) | — | 🟡 cache/db/sync-queue scaffolded, not wired to real data (Phase 10 TODO) | ❌ none | **Scaffolded only** |

---

## 6. Database Schema Analysis

`apps/api/prisma/schema.prisma`, 769 lines, **25 models, 15 enums**, 3 migrations applied against a live Supabase Postgres instance.

**Core domains and their relations:**
- **Identity/Access:** `User` ↔ `UserBranchAssignment` ↔ `Branch` (many-to-many via join table with soft-remove `removedAt`), `RefreshToken`, `PinCredential` (unique per user+device)
- **Catalog:** `Product` → `ProductVariant` → `ProductVariantFlavor` ↔ `Flavor`; branch-scoped availability via `BranchProductAvailability` / `BranchFlavorAvailability`
- **CR-001 workflow:** `BranchPriceOverride`, `ProductRequest` — both carry `requestedBy`/`reviewedBy` → `User`, status string + review metadata
- **Recipes/Inventory:** `Recipe` (master, `flavorId` nullable = base ingredient) and `BranchRecipeOverride` (branch-scoped, unique on all four dimensions) both reference `Ingredient`; `InventoryMovement` is an append-only ledger
- **Transactions:** `Transaction` → `TransactionItem` (line-item snapshots of name/price at sale time) and → `Shift` → `ShiftCashDenomination`
- **Ops:** `AttendanceRecord`, `AuditLog` (hash-chained: `previousHash`/`currentHash`), `FraudAlert`

**Schema-level issues found:**
| Issue | Location | Impact |
|---|---|---|
| No index on `AuditLog.createdAt` | schema.prisma:724-747 | Every audit write does `findFirst(orderBy: createdAt desc)` for the hash chain — full-table scan risk as the (append-only, unbounded) table grows |
| No composite index `[userId, revokedAt]` on `RefreshToken` | schema.prisma:231-247 | `revokeAllUserTokens` filters on exactly this pair without a supporting index |
| `Recipe` has no unique constraint on `(productVariantId, ingredientId, flavorId)` | schema.prisma:499-515 | Its own override table (`BranchRecipeOverride`) *does* have this constraint — inconsistent; duplicate master recipe rows are possible |
| `TransactionItem.productId` is a bare column, no `@relation` | schema.prisma:617-636 | Referential integrity for that FK isn't Prisma/DB-enforced, unlike `productVariantId`/`flavorId` on the same row |
| `Ingredient` has no unique constraint on `(branchId, name)` | schema.prisma:472-492 | Duplicate ingredient names per branch possible |
| "No hard deletes" principle (stated in `docs/architecture/database-schema.md:7`) is violated | `recipes.router.ts:75-83` | Does a real Prisma `delete`, not a soft-delete — contradicts the architecture's own stated rule |
| Partial unique index for "one pending price-override per branch+variant" exists only as raw SQL in a migration | not visible in `schema.prisma` DSL | A maintainer reading only the schema file would miss this constraint |

---

## 7. API Endpoints Inventory

Mounted in `apps/api/src/app.ts:48-65`. Global chain: `helmet` → `cors` (single origin) → `express.json` → `cookieParser` → `morgan` → `/health` (unauthenticated) → `apiLimiter` (100/min) → routers → 404 → error handler.

**12 of 18 modules are fully implemented** (updated 2026-07-15 — was 9; inventory, cash, and transactions moved from stub/partial to implemented since the 2026-07-14 audit). Representative sample (full detail was captured per-router by the original audit; totals below, inventory/cash/transactions route counts re-verified 2026-07-15 via direct grep of each router file):

| Module | Endpoint count | Auth | Status |
|---|---|---|---|
| auth | 9 | mixed (public login/reset, `authenticate` for the rest) | ✅ Implemented |
| branches | 9 | `authenticate` + `adminOnly`/`adminOrSupervisor` + `branchGuard` | ✅ Implemented |
| products | 12 | `authenticate` + role/branch guards, multer image upload | ✅ Implemented |
| flavors | 6 | same pattern | ✅ Implemented |
| recipes | 9 | same pattern, includes `/simulate` | ✅ Implemented |
| product-requests | 4 | `supervisorOnly` submit, `adminOnly` review | ✅ Implemented |
| price-overrides | 3 | `supervisorOnly` submit, `adminOnly` review | ✅ Implemented |
| employees | 8 | `authenticate` + `requirePasswordChange` (only module with this gate wired in) | ✅ Implemented |
| inventory | 13 (updated 2026-07-15; was 2/partial) | `authenticate` + role/branch guards | ✅ Implemented |
| cash | 8 (new 2026-07-15; Phase 9 + Phase 11 — open/current/list/get/close/approve-variance/void/summary) | `authenticate` + role guards + inline/branch-scoped checks | ✅ Implemented |
| transactions | 6 (new 2026-07-15; Phase 10 — create/list/get/void/refund/receipt-printed) | `authenticate` + role guards + `shiftGuard` on create | ✅ Implemented |
| attendance, audit, discounts, fraud, notifications, receipts, reports | 0 registered routes each | router exists, `Router()` empty, service/repo wired but unused | ❌ **7 stub modules — every path under these prefixes 404s** (was 9; attendance/audit/discounts/fraud/notifications/receipts/reports remain untouched) |

`GET /health` is the only endpoint with no authentication and no rate limiting.

---

## 8. Authentication and Authorization Flow Status

**Fully implemented and well-tested.** JWT RS256 (`normalizePem()` converts `\n`-escaped PEM env values back to real newlines), 15-minute access tokens, opaque SHA-256-hashed refresh tokens (not JWTs) rotated atomically in a DB transaction on every use, HttpOnly `sameSite: lax` refresh cookie. Bcrypt cost factor locked at 12. Account lockout after 5 failed attempts, 30-minute auto-unlock. PIN login requires a prior full-auth session on that exact device. Redis-backed access-token blacklist checked on every authenticated request.

RBAC: `authorize()` role guards, `branchGuard` (super_admin bypasses; supervisor/staff checked against JWT `branch_ids`), `shiftGuard` (currently dead code — not wired into any router since the POS/cash routers are stubs). `requirePasswordChange` is **only wired into the employees router**, not the other 8 implemented modules — an acknowledged inconsistency in the code's own comments.

**Gaps:**
- No CSRF protection anywhere (refresh cookie relies on `sameSite: lax` alone)
- No HTTP endpoint exists for manual Super Admin account-unlock, despite the architecture doc requiring one
- **Socket.io connections are not cryptographically authenticated** — see §14, this is the most serious finding in the whole audit

---

## 9. Frontend Pages and Components Inventory

**39 routes total** across 4 route groups. 18 are fully built (real forms, TanStack Query hooks, DataTables), **21 are Phase-labeled placeholder stubs** (identical `<div className="p-6">` template, some naming the specific future phase — e.g. `/terminal` says "Phase 10", `/admin/dashboard` says "Phase 15").

| Built (18) | Stub (21) |
|---|---|
| `/login`, `/change-password`, `/reset-password`, `/unauthorized` | `/`, `/r/[txn]` |
| `/admin/branches` (+detail), `/admin/employees` (+detail), `/admin/flavors` (+detail), `/admin/products` (+detail), `/admin/approvals/price-overrides`, `/admin/approvals/product-requests` | `/admin/dashboard`, `/admin/audit-logs`, `/admin/fraud-alerts`, `/admin/recipes`, `/admin/reports`, `/admin/settings` |
| `/supervisor/employees` (+detail), `/supervisor/price-overrides` (+new), `/supervisor/product-requests` (+new), `/supervisor/recipes` | `/supervisor/dashboard`, `/supervisor/approvals`, `/supervisor/attendance`, `/supervisor/cash`, `/supervisor/inventory`, `/supervisor/reports` |
| — | `/terminal`, `/shift`, `/receipts` |

**Component library:** 24 shadcn/ui primitives (all real, no stubs), full shared library (DataTable, charts via Recharts/Tremor wrappers, forms, feedback states), 28 admin-specific business components (create/edit/deactivate/status dialogs). `components/pos/` has only 2 files (`pos-header.tsx`, `shift-status-indicator.tsx`) — the actual POS terminal UI doesn't exist yet, consistent with the route stub.

Route protection: `apps/web/middleware.ts` decodes (does **not** cryptographically verify — by design, real verification is server-side) the JWT to redirect users to the wrong role's routes and to force `/change-password` when `must_change_password` is set.

---

## 10. Third-Party Integrations Status

| Integration | Status |
|---|---|
| Supabase (Postgres) | ✅ **Live** — real project, 3 migrations applied, seeded, connected via Session Pooler (see TOOLING_SETUP.md for why: direct connection is IPv6-only) |
| Supabase (frontend client / Storage) | ❌ Not integrated — `@supabase/supabase-js` isn't even a frontend dependency; image uploads go through the Express API, not a direct client |
| Vercel | ✅ **Live** — `apps/web` deployed, project `potato-corner-pos`, auto-deploy on push to `main` confirmed working this session |
| Render (backend host) | ❌ **Not provisioned at all** — no `render.yaml`, no `Dockerfile`, no account/service wiring, no secrets referenced in CI |
| Redis / Upstash | 🔴 **Confirmed blocking, not graceful** (updated 2026-07-15): `REDIS_URL` is now in `.env.example` (fixed), but no Redis instance is provisioned in this dev environment — attempting to actually run the backend and log in fails outright (traced to `ECONNREFUSED`-class failures cascading into the frontend's generic "Unexpected end of JSON input"). No Upstash/cloud instance provisioned; a local fix was in progress (installing Memurai, a native-Windows Redis-compatible server, via `winget`, since Docker Desktop's WSL2 backend has no Linux distro installed on this machine and can't start) but was not completed this session |
| Resend (email) | 🟡 Optional/dev-fallback wired, no real API key configured; **dev fallback logs secrets to console unconditionally** — see §14 |
| Sentry | ❌ Backend SDK installed but `SENTRY_DSN` empty; frontend SDK (`@sentry/nextjs`) not installed at all |
| PostHog | ❌ Not installed anywhere, env vars reserved but blank |
| Manus OAuth | ❌ **Confirmed does not exist anywhere in this codebase** — re-verified by direct grep this session; this was a fabricated premise in an earlier unrelated prompt |
| `AI_PROVIDER` / AI SDKs | ❌ **Confirmed does not exist anywhere** — same fabricated-premise situation |
| AWS S3 | ❌ **Confirmed does not exist anywhere** — no `aws-sdk` dependency, no `S3Client` usage |
| GCash | 🟡 Data-model only — reference-number field with manual fraud-acknowledgment checkbox; no actual payment gateway SDK (matches the architecture spec, which never called for one) |

---

## 11. Environment Variables Audit

Cross-referenced `.env.example` against the live zod schema (`apps/api/src/config/index.ts`) and every `process.env.X` read in the codebase.

| Variable | Required by code | In `.env.example` | Status |
|---|---|---|---|
| `JWT_REFRESH_SECRET` | ✅ Yes, min 32 chars, **no default** | ✅ **Yes** (fixed 2026-07-15) | 🟢 Fixed — present in `.env.example` now. Still dead code: refresh tokens are opaque strings, not JWTs, so this value is never actually read once set |
| `REDIS_URL` | ✅ Yes, min 1 char | ✅ **Yes** (fixed 2026-07-15) | 🟢 Fixed — present in `.env.example` now, defaults to `redis://localhost:6379` |
| `DIRECT_URL` | ❌ Not read anywhere (no `directUrl` in `schema.prisma`'s datasource) | ✅ Yes | Vestigial/dead |
| `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_ACCESS_TOKEN_TTL`, `JWT_REFRESH_TOKEN_TTL`, `ENCRYPTION_KEY`, `API_PORT`, `NODE_ENV`, `NEXT_PUBLIC_APP_URL` | ✅ | ✅ | OK |
| `SENTRY_DSN` | ✅ optional | ✅ (empty) | OK |
| `RESEND_API_KEY`, `EMAIL_FROM` | 🟡 read via raw `process.env`, bypassing the validated config object | ✅ (placeholder) | Works but defeats the "fail fast at boot" point of the zod schema |
| `SMTP_HOST`/`PORT`/`USER`/`PASSWORD` | ❌ Not referenced anywhere — Resend is the real provider | ✅ | Vestigial |
| `REDIS_TLS`, `LOG_LEVEL`, `SENTRY_ENVIRONMENT` | ❌ Not referenced anywhere | ✅ | Vestigial |
| `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SOCKET_URL`, `NEXT_PUBLIC_POSTHOG_KEY`/`HOST` | Frontend-only or unused by backend | ✅ | OK (frontend vars legitimately live in the shared root `.env.example`) |
| `TEST_DATABASE_URL`, `TEST_REDIS_URL` | Gate every integration test (`canRunIntegrationTests`) | ✅ **Yes** (fixed 2026-07-15) | Present in `.env.example` now, pointed at a disposable local test DB/Redis by default — but no such instance is actually provisioned in this environment, so all 105 integration tests still skip in practice (up from 60 skipped, proportional to more modules now having integration-test stub files) |

**Net (updated 2026-07-15): the two previously-missing required variables, plus the two test-only variables, are now all present in `.env.example` — the guaranteed-boot-failure gap from the 2026-07-14 audit is closed.**

---

## 12. Build and Deployment Readiness Check

| Item | Status |
|---|---|
| `apps/web` → Vercel | ✅ **Deployed and live**, `● Ready`, auto-deploy on push to `main` confirmed working |
| `apps/api` → any host | ❌ **Zero deployment infrastructure** — no `render.yaml`, `Dockerfile`, or Railway config anywhere in the repo |
| CI (`ci.yml`) | ✅ Runs type-check/lint/test/build on every PR to `main`/`staging` |
| CD (`deploy-staging.yml`, `deploy-production.yml`) | 🟡 Runs `prisma migrate deploy` against real DB secrets, but **both files end in explicit `# TODO` comments** — no actual app deployment step exists for either Vercel or Render in either workflow. The live Vercel deploy happening today is via Vercel's own git integration, entirely outside this CI/CD pipeline |
| Local production build — `shared`, `api` | ✅ Both compile cleanly |
| Local production build — `web` (`next build`) | ✅ **Fixed as of 2026-07-15** — builds cleanly (compile ✓, lint+typecheck ✓, all 46 static pages generated ✓), re-confirmed on two separate runs. The 2026-07-14 native-crash finding did not reproduce; likely was the corrupted-binary issue noted in that entry, since resolved |
| Local dev environment | ✅ Works, but Turbo's own Windows binary is now confirmed to crash with `SIGILL` on `turbo run test`/`turbo run build` even after a fresh reinstall (updated 2026-07-15) — every verification in this update was run by invoking each package's `test`/`type-check`/`lint`/`build` script directly via `pnpm --filter <pkg> <script>`, bypassing Turbo's orchestration entirely. This is a sandbox/environment issue, not a code defect, but will block anyone running plain `pnpm test`/`pnpm build` from the repo root until Turbo's binary is fixed or replaced |

---

## 13. Code Quality Audit

Ran live, not inferred:

| Check | Result |
|---|---|
| TypeScript (`api`, `web`, `shared`) | ✅ **0 errors** across all three packages (re-confirmed 2026-07-15) |
| ESLint — `api` | ✅ 0 errors (re-confirmed 2026-07-15; warning count not re-measured this pass, carried over: 7 warnings as of 2026-07-14, all `no-console` in `seed.ts`/`lib/email.ts`/`server.ts`) |
| ESLint — `web` | ✅ **0 errors** (re-confirmed 2026-07-15; warning count not re-measured, was 0/0 as of 2026-07-14) |
| Vitest — `api` | ✅ **324 passed** (updated 2026-07-15; was 132), 105 skipped (integration tests, gated on absent `TEST_DATABASE_URL` — the var is now in `.env.example` but no instance is provisioned in this environment), **0 failed**, across 12 fully-implemented modules (was 9) |
| Test coverage — `api` | Not measured this run (no `--coverage` flag used); `@vitest/coverage-v8` is installed and available. 7 of 18 modules still have zero test files (was 9 of 18) |
| Tests — `web` | 🔴 **Zero test files exist.** No Vitest config in `apps/web` despite tooling being pre-wired (`.vscode/settings.json` has `vitest.enable: true`) |
| E2E — Playwright | 4 spec files exist, **all are `test.skip()` stubs** with empty bodies — zero executable e2e coverage |

**Summary:** the code that exists is clean and well-tested at the unit level. The gap is entirely in *breadth* (9 stub modules, no frontend tests, no working integration/e2e tests) rather than *quality* of what's been written.

---

## 14. Security Audit

### 🔴 High severity

1. **Socket.io connections are not cryptographically authenticated.** `apps/api/src/socket/socket.server.ts:38-49` decodes a base64 JSON blob and validates its *shape* with a zod schema, but never calls `jwt.verify()`. There's an explicit `// TODO(Phase 13): verify JWT signature here` at line 42. **Any client can forge an arbitrary identity, role, or `branch_ids` array** by constructing their own base64 JSON payload — this fully bypasses RS256 signature verification for the WebSocket layer. Blast radius is currently limited (no real event handlers exist yet, Phase 13 is unbuilt) but this must be fixed before any realtime feature ships, and ideally before Phase 13 work even starts.
2. **Password reset links and plaintext temporary passwords are logged to console unconditionally in the dev-fallback email path**, with no `NODE_ENV`/`isProduction` guard: `apps/api/src/lib/email.ts:17` logs a live, usable password-reset URL; `email.ts:40` logs a **newly-created employee's plaintext temporary password**. Both fire whenever `RESEND_API_KEY` is unset — which is true right now, in every environment, since no real Resend key has been configured. If this code path ever runs against a staging/production deployment with logs shipped anywhere (Vercel logs, a log aggregator), it leaks working credentials.

### 🟡 Medium severity

3. `JWT_REFRESH_SECRET` and `REDIS_URL` missing from `.env.example` (see §11) — not a runtime vulnerability, but a real onboarding/deployment-blocking gap.
4. No CSRF protection anywhere (refresh cookie is `sameSite: lax` only, no token pattern).
5. No HTTP endpoint exists for manual Super Admin account unlock, despite the architecture doc calling for one — `resetLoginAttempts` exists in the repository layer but nothing routes to it.
6. `requirePasswordChange` is wired into only 1 of 9 implemented routers (employees), an acknowledged inconsistency — a user flagged for mandatory password change can still use branches/products/flavors/recipes/etc. normally.

### ✅ Clean

- No hardcoded secrets/API keys anywhere in `apps/api/src` or `apps/web` (explicit grep for `sk_`, `AKIA`, etc. — zero hits)
- No `eval()`, no disabled TLS verification, no raw SQL string concatenation (all Prisma parameterized calls)
- No `dangerouslySetInnerHTML` anywhere in the frontend
- Access tokens are correctly kept in-memory only on the client (Zustand, never persisted) — deliberate, documented design; refresh token is HttpOnly-cookie-only
- bcrypt cost factor locked at 12 and consistently applied; AES-256-GCM for government-ID fields with per-encryption random IVs and validated auth tags; refresh tokens and blacklist keys are SHA-256 hashed before storage (correct practice for high-entropy secrets)
- Password-reset endpoint gives a generic response regardless of whether the email exists (no user enumeration)

---

## 15. Performance Concerns and Optimization Recommendations

- **`AuditLog.createdAt` has no index** despite being the sort key on every single write (hash-chain lookup) — this table is explicitly append-only and unbounded; add the index before volume grows.
- **`RefreshToken` missing composite index `[userId, revokedAt]`** — exactly the filter used by `revokeAllUserTokens`.
- **`Product`/`Ingredient` have no indexes on commonly filtered fields** (`status`, `category`, `branchId+name`) despite the products list endpoint filtering on both.
- No compression middleware (`compression`) on the Express app.
- No explicit body-size limit on `express.json()` (uses Express's default) — worth an explicit cap once file/image-heavy endpoints grow.
- BullMQ queues (inventory deduction, report pre-compute, fraud detection, notifications) are entirely unimplemented — not a current performance problem since the transaction volume that would need them doesn't exist yet, but flagged since the architecture explicitly requires deduction to be async/non-blocking and that constraint isn't yet enforced by any code.
- Reports' stated "15-minute pre-compute" and "max 3s real-time query" performance targets are moot until Phase 16 exists.

---

## 16. Known Bugs and Issues

| # | Issue | Severity |
|---|---|---|
| 1 | Socket.io identity spoofing — see §14.1 | High (security) |
| 2 | Password reset link + plaintext temp password logged unconditionally — see §14.2 | High (security) |
| 3 | `recipes.router.ts` performs a hard `DELETE`, contradicting the architecture's own "no hard deletes" rule | Medium (data-integrity/spec violation) |
| 4 | `TransactionItem.productId` has no enforced FK relation | Medium (referential integrity) |
| 5 | `Recipe` allows duplicate `(productVariantId, ingredientId, flavorId)` rows — its override table doesn't allow this, inconsistent | Medium (data integrity) |
| 6 | `requirePasswordChange` gate inconsistently applied (1 of 9 routers) | Medium (security/consistency) |
| 7 | Local `next build` crashes with a native exception — almost certainly a corrupted local binary, not a code bug (Vercel's build of the same commit succeeds) | Low (environment, not code) — see §12 |
| 8 | Three status docs (`.claude/CLAUDE.md`, `docs/architecture/api-contracts.md`, `docs/architecture/database-schema.md`) are stale, describing a "Phase 0" state the code has moved well past | Medium (process — misleads anyone, human or AI, who trusts them as current) |

No `FIXME`/`HACK`/`XXX` markers exist anywhere in the codebase (only legitimate `TODO`s and a few incidental literal "XXX" strings in placeholder-format hints, not markers).

---

## 17. TODO/FIXME Comments Found

**Total: ~90 TODO comments, 0 FIXME/HACK/XXX.** Grouped:

- **9 stub modules × 3 files each** (`<module>.router.ts`/`.service.ts`/`.repository.ts`) — attendance, audit, cash, discounts, fraud, notifications, receipts, reports, transactions — each carrying `// TODO(Phase N+): implement ... for the <module> module.`
- **4 BullMQ queue processors** — `queues/inventory.queue.ts`, `fraud.queue.ts`, `report.queue.ts`, `notification.queue.ts` (only the `employee_welcome` job type is implemented in the notification queue; everything else TODO)
- **1 security-critical TODO** — `socket/socket.server.ts:42`, JWT signature verification (see §14.1)
- **8 integration test skeleton files** — every assertion body is a `// TODO` describing intended behavior, not executable code (~60 individual TODO lines across `auth`, `branches`, `employees`, `flavors`, `product-requests`, `price-overrides`, `products`, `recipes` integration specs)
- **2 frontend offline-sync TODOs** — `lib/offline/sync-queue.ts:8` (wire into online/offline transition), `lib/offline/cache.ts:6` (populate from TanStack Query cache)
- **4 Playwright e2e TODOs** — one per skipped spec file, each naming its target phase
- **4 CI/CD TODOs** — Vercel/Render deploy steps and Playwright smoke tests, duplicated across `deploy-staging.yml` and `deploy-production.yml`

---

## 18. Missing Features a Production POS System Should Have

Everything below is *spec'd* (in the architecture docs) but not yet built:

- Actual point-of-sale cart/checkout/payment flow (Phase 10) — currently the single biggest gap; nothing downstream of the catalog exists yet
- Shift open/close with denomination counting and variance approval (Phase 9, 11)
- Real inventory operations beyond ingredient master data: stock-in, waste, physical count, transfers, and the BullMQ-driven automatic deduction-on-sale pipeline (Phase 8)
- Attendance clock-in/out with GPS validation (Phase 12)
- Both admin dashboards — Super Admin company-wide KPIs and Supervisor branch operations panel (Phase 14, 15)
- All 13 report types and their export pipeline (Phase 16)
- Fraud detection nightly job and all 7 detection rules (Phase 17) — the rules are fully specified in `docs/architecture/final-approved-architecture.md` Part 12 but zero code exists
- Notification delivery pipeline beyond one job type, and the 11:59 PM EOD summary job (Phase 18)
- Receipt generation/viewing (the public `/r/[txn]` route and `receipts` module are both stubs)
- Real offline transaction processing — Dexie/IndexedDB scaffolding exists but isn't populated with real data yet
- CSRF protection, manual account-unlock endpoint, Socket.io signature verification (security gaps, §14)
- Backend hosting/deployment entirely (no Render/Railway config exists)
- Any frontend automated test coverage at all
- Production hardening pass, load testing, and the pilot-branch rollout process (Phase 19, 20)

---

## 19. Critical Fixes Needed, Ranked by Priority

**High**
1. Fix Socket.io JWT verification (§14.1) before any realtime feature is built on top of it — not re-verified 2026-07-15, treat as still open
2. Gate the console.log secret-leaking dev-fallback in `lib/email.ts` behind `NODE_ENV !== 'production'` at minimum, ideally remove entirely in favor of a hard failure when email isn't configured in non-dev environments — not re-verified 2026-07-15, treat as still open
3. ~~Add `JWT_REFRESH_SECRET` and `REDIS_URL` to `.env.example`~~ — **✅ Fixed as of 2026-07-15** (both, plus `TEST_DATABASE_URL`/`TEST_REDIS_URL`, are now present — see §11). Remaining real gap: no actual Redis *instance* is provisioned in any dev environment, so the backend still can't run/login locally without manually standing one up (see §10)
4. Update the three stale status docs (`CLAUDE.md`, `api-contracts.md`, `database-schema.md`) so they reflect actual Phase 11 + CR-001 completion, not "Phase 0" — still open, not addressed this update (this document itself is the one that's been kept current)
5. Provision backend hosting (Render or equivalent) and wire the actual deploy steps into `deploy-staging.yml`/`deploy-production.yml` — currently pure TODO placeholders; not re-checked 2026-07-15, treat as still open

**Medium**
6. Apply `requirePasswordChange` consistently across all 9 implemented routers, or make an explicit, documented decision not to
7. Add the missing DB indexes (`AuditLog.createdAt`, `RefreshToken[userId,revokedAt]`, `Product.status`/`.category`, `Ingredient[branchId,name]`)
8. Add a unique constraint to `Recipe` matching its override table, and a proper `@relation` for `TransactionItem.productId`
9. Reconcile `recipes.router.ts`'s hard delete with the "no hard deletes" architecture principle — either soft-delete it or formally amend the principle
10. Add CSRF protection and the missing manual-unlock endpoint
11. Investigate/fix the local `next build` native crash (likely: reinstall `@next/swc`'s Windows binary)

**Low**
12. Remove vestigial env vars from `.env.example` (`DIRECT_URL`, `SMTP_*`, `REDIS_TLS`, `LOG_LEVEL`) or actually wire them up
13. Reconcile `config/permissions.ts` (documentation-only) with what routers actually enforce, or remove it to avoid drift
14. Clean up leftover `.gitkeep` files in now-populated component folders (cosmetic only)

---

## 20. Recommended Improvements and Next Steps

1. ~~Proceed to Phase 8~~ — **done as of 2026-07-15**, along with Phases 9-11. **Proceed to Phase 12** (attendance system) next — it's the next unstarted item in roadmap order, and the POS terminal core (Phases 8-11) that used to be the frontier is now complete.
2. Stand up a real `TEST_DATABASE_URL`/`TEST_REDIS_URL` test environment so the 105 already-written integration test skeletons (was 60) can be filled in and actually run in CI — this is a large amount of test-writing work that's already scaffolded and just needs bodies. Note: a local Redis instance specifically is also needed just to run the backend at all in dev (see §10) — this is now the most immediate blocker, ahead of the test-environment work.
3. Add a frontend test runner (Vitest is already the house standard) and write at least component-level coverage for the 18 fully-built pages before more UI accumulates untested.
4. Implement the 4 skipped Playwright e2e specs alongside their corresponding phases, rather than after the fact.
5. Provision Render (or formally re-decide on Railway) for `apps/api`, write a `render.yaml`, and complete the CI/CD TODOs.
6. Run `pnpm --filter api test -- --coverage` in CI and track it against the doc's stated 80% target so coverage drift is visible over time.
7. Do a documentation pass: update `CLAUDE.md`'s status line, rewrite `api-contracts.md` (currently says zero endpoints exist — should document the 60+ that do), and refresh `database-schema.md`'s model list to include the 4 CR-001 additions it's currently missing.

---

## 21. Recommended Libraries and Tools to Add

The project's own rules explicitly forbid adding libraries outside the approved stack without a formal change request (`.claude/CLAUDE.md:74`) — so the items below are framed as "already-approved but not yet wired up" rather than new additions, except where noted:

- **`@sentry/nextjs`** — approved in the stack (Sentry is named for both frontend and backend in the architecture doc), backend half already has `@sentry/node` installed; frontend half is missing entirely. Install and wire once `SENTRY_DSN` is populated.
- **PostHog JS SDK** — same situation: approved, env vars reserved, package never installed.
- **`@vitest/coverage-v8`** — already installed for `api`; just needs `--coverage` actually run in CI. For `web`, Vitest itself needs to be added (also already the approved unit-test tool per the stack table, just unused in that workspace so far).
- Anything beyond this (e.g., a CSRF middleware package) would need a formal change request per the project's own rules before adding — flagging the *need* (§14/§19) rather than prescribing a specific package is the right scope for this audit.

---

## 22. Overall Project Health Score: 69/100 (updated 2026-07-15; was 63/100 on 2026-07-14)

Only the **Feature completeness** row was recomputed this update, based on verified Phase 8-11 completion. Every other row is carried over unchanged from 2026-07-14 — Security, Documentation accuracy, and Deployment readiness in particular were **not** re-audited this session and should be treated as stale estimates, not fresh findings.

| Dimension | Score | Why |
|---|---|---|
| Code quality (of what exists) | 18/20 | 0 TypeScript errors, near-zero lint warnings, substantive and passing unit tests, consistent architecture adherence (repository-layer pattern, Zod-everywhere, kebab-case discipline all genuinely followed) — re-confirmed 2026-07-15 for the delta (type-check/lint/test/build all clean), not re-scored |
| Security | 8/20 *(not re-audited 2026-07-15)* | One real, currently-exploitable auth bypass (Socket.io) and one credential-leaking log path pull this down hard, despite otherwise good practices (token storage, encryption, hashing all sound) |
| Feature completeness | 16/25 *(updated 2026-07-15; was 10/25)* | 12 of 20 roadmap phases done plus a full unplanned change request. The actual point-of-sale product now works end to end — open a shift, sell, close and reconcile cash, review variances — which was the single biggest gap as of the last audit. 40% of the roadmap by phase count (8 phases: attendance, both dashboards, reporting, fraud detection, notifications/EOD job, production hardening, pilot rollout) remains untouched |
| Test coverage | 10/15 *(not re-audited 2026-07-15)* | Backend unit tests are excellent where they exist (324 passing, up from 132); zero frontend tests and zero runnable integration/e2e tests remain a real gap against the doc's own 80% target |
| Documentation accuracy | 7/10 *(not re-audited 2026-07-15)* | The architecture/business-rules docs themselves are excellent and clearly authoritative; the *status* layer on top of them (CLAUDE.md, api-contracts.md, database-schema.md) is stale enough to actively mislead a new contributor or AI agent picking up the project — this document is the one exception being kept current |
| Deployment readiness | 10/10 *(not re-audited 2026-07-15)* | *(partial credit, weighted)* Frontend is genuinely live and working on Vercel; backend has literally zero deployment infrastructure — split evenly. Not re-checked this session |

**Read (updated 2026-07-15):** the codebase's core product gap from the last audit — no working POS terminal — is closed. The shift-open → sell → close/reconcile lifecycle is real, tested, and reviewed end to end. What's left is now cleanly enumerable: attendance, both dashboards, reporting, fraud detection, notifications, production hardening, pilot rollout, and backend hosting — plus the still-open security items from the last full audit (Socket.io auth bypass, email credential logging), which were not re-checked this session and should not be assumed fixed just because other things moved forward.
