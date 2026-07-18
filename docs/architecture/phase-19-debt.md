# Phase 19 — Production Hardening Debt

Captured items discovered during earlier phases that Phase 19 should address.

## Development Environment (from Phase 18)

### Prisma migrations on Windows — DIRECT_URL requirement
- `prisma migrate dev` and `prisma migrate diff --from-url` hang silently
  when `DIRECT_URL` points at PgBouncer transaction-mode pooler (port 6543)
- Root cause: transaction-mode pooler cannot grant session-level operations
  Prisma migrate requires (CREATE DATABASE for shadow DB, advisory locks)
- Fix per environment:
  - Local dev on IPv4-only network: `DIRECT_URL` = Session Pooler (5432)
  - CI (GitHub Actions, IPv6-capable): `DIRECT_URL` = raw direct connection (5432)
  - Runtime `DATABASE_URL`: Transaction Pooler (6543) works for both
- Three-URL pattern per environment should be codified in `.env.example`

### Turbo access violation on Windows
- `turbo run type-check` crashes with `0xC0000005` access violation
- Reproduces in both Git Bash and native PowerShell — not a shell issue
- Workaround: `pnpm --filter @potato-corner/api run type-check` directly
- Needs investigation (turbo version / cache corruption / Windows compatibility)
  before relying on `pnpm type-check` root command in local dev

### Prisma commands under Git Bash / Node 24
- Known upstream issues: prisma/prisma#27300, #24975
- Not the root cause of Phase 18 Task 3's original hang (that was the
  DIRECT_URL/pooler-mode issue above), but worth documenting
- If encountered in future: run Prisma commands via native PowerShell

### CLAUDE.md migration rule — ✅ resolved Phase 19 Task 3
Database & Migration Safety three-URL pattern (`DATABASE_URL` / `DIRECT_URL` /
`PRODUCTION_DATABASE_URL_DIRECT`) codified in `.claude/CLAUDE.md`, driven by
the Phase 18 phantom-migration incident.

### Web lint — ✅ resolved Phase 19 Task 4

### Phantom migration incident (`20260717183737_add_recipe_unique_constraint`) — ✅ resolved Phase 19 Task 3
Rolled back per the incident write-up now captured in `.claude/CLAUDE.md`'s
Database & Migration Safety section.

### Supabase dashboard "Last migration" indicator — needs confirmation, not yet verified
- Working hypothesis, **not yet confirmed**: the dashboard's Database →
  Migrations panel tracks Supabase-CLI migrations only, and since this
  project uses Prisma exclusively, the panel would show "No migrations"
  even when `_prisma_migrations` and the real schema are fully up to date
- `prisma migrate status` reports "Database schema is up to date! 14
  migrations found" against the project referenced by this repo's
  `SUPABASE_URL` (`nliuhztaezaujzgtsrwp`), which is strong but indirect
  evidence for the hypothesis
- Direct confirmation via `information_schema.tables` in the Supabase SQL
  Editor was requested and is still outstanding as of 2026-07-17 — do not
  treat this as settled until that comes back
- Once confirmed either way: if true, prefer `prisma migrate status` (or
  querying `_prisma_migrations` directly) over the dashboard panel for
  verifying migration state

## From Phase 17 handoff (previously identified, still open)
- ~~Render vs Railway confusion in deploy-production.yml~~ — ✅ resolved Phase 19 Task 1
- ~~PROJECT_STATUS.md contradictions about deploy platform~~ — ✅ resolved Phase 19 Task 1
- apps/web/.env.example references outdated Railway URL
- next.config.ts:15 comment references "Vercel vs Railway"
- railway.json + apps/api/Dockerfile status unclear vs CI workflow
- ~~Postgres service container missing from CI (105 integration tests skip)~~ — ✅ resolved Phase 19 Task 2
- ~~Phase 12/14/15 verification audit needed~~ — ✅ resolved Phase 19 Task 10

## Dormant notification producers (from Phase 18 Session A)

Notification handlers implemented and ready, but no producer currently
enqueues these types.

- ~~`large_adjustment_approval_needed`~~ — ✅ resolved Phase 20 Task 5:
  producer wired to the inventory adjustment large-value threshold
  workflow; both Supervisor and Super Admin receive the notification.

- ~~`offline_transactions_synced`~~ — ✅ resolved Phase 20 Task 4:
  offline sync batch endpoint implemented, notification now fires on
  successful sync.

## Phase 20 carry-forward items (still open, gated on Task 3)

- Staff clock-in UI gap — ✅ resolved Phase 20 Task 7 (`apps/web/app/(pos)/clock-in/page.tsx`, commit `0f60053`).
- Hold orders backend — ✅ resolved Phase 20 Task 2.
- Dormant `large_adjustment_approval_needed` producer — ✅ resolved Phase 20 Task 5 (see above).
- Dormant `offline_transactions_synced` producer — ✅ resolved Phase 20 Task 4 (see above).
- `notification-bell.tsx` no consuming hook — still open. Component (`apps/web/components/shared/notification-bell.tsx`) is presentational-only by design; callers (`pos-header.tsx`, `supervisor-sidebar.tsx`, `admin-sidebar.tsx`) render it with no `notifications` prop passed, so it always shows empty. No hook wires it to the socket `notification` event or a TanStack Query source yet.
- `HASH_KEY` in Render — still open (Task 3, production environment configuration).

## Phase 20 debt

- **Playwright supervisor + staff login tests time out on waitForURL
  despite backend + manual browser verification succeeding**
  - Discovered: Phase 20 Task 10 (2026-07-18)
  - Symptom: 2 of 5 pilot-smoke tests fail with waitForURL timeout
    at 30s after successful login form submission
  - Verified NOT broken: backend auth (all 3 accounts return 200 +
    correct role + must_change_password=false), frontend redirect
    logic (ROLE_DASHBOARDS map, middleware ownership), manual browser
    testing in incognito (all 3 roles reach dashboards)
  - Static analysis inconclusive — requires headed Playwright trace
    against a throwaway test account to diagnose
  - Impact: Test-infra only. Does not affect real users.
  - Deferred to: Phase 21 test hardening
  - Remediation plan: create dedicated E2E test accounts (separate
    from pilot users), run supervisor test with trace: 'on' in
    headed mode, inspect network + navigation timeline at timeout

## Skills usage discrepancy (from Phase 18 Session A)

Plan doc header at docs/superpowers/plans/2026-07-17-phase18-notifications-eod-summary.md
references "REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
superpowers:executing-plans". Session A operated without invoking those
Skills — TDD cycle performed manually. Future planning sessions should
either align on Skill usage or update plan docs to remove Skill references
when working under sessions that disable them.
