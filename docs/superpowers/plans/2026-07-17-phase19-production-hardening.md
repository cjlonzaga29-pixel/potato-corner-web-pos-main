# Phase 19 — Production Hardening

## 1. Objective

Bring the platform from "all 20-phase feature work merged" to "provably safe to hand to a real pilot branch": close known CI/deploy/doc debt, get the E2E suite from stub to real coverage of every critical flow named in the master execution plan's Testing Strategy, run a first load test against a stack that has never been load-tested, run a security audit against the standards this repo already declares, and verify offline/PWA behavior on constrained devices — all without touching business logic, schema, or the approved stack beyond one explicit, called-out addition (k6).

## 2. Why This Phase Exists

- Phase 18 shipped clean (633/0, 0 typecheck errors, Render green) but shipped alongside a phantom-migration incident that reached a real Supabase connection string — Phase 19 is where the prevention rule gets written down, not just fixed in the moment.
- The E2E suite has existed as scaffolding since early phases but was never filled in — Phase 20's pilot sign-off depends on these flows being provably correct, not just unit-tested.
- CI currently cannot exercise ~105 integration tests because there's no database for them to run against — a phase that claims "production hardening" without fixing this is hardening against a partial signal.
- Deploy-platform documentation has drifted (Railway references against a Render-only reality) — carrying that into Phase 20's pilot runbook risks someone following a stale doc during an incident.
- No load test has ever been run against this stack — the pilot phase is the first time real concurrent users hit it, and Phase 19 is the last checkpoint before that happens.

## 3. Inputs / Governing Documents (authority order)

1. `.claude/CLAUDE.md`
2. `docs/architecture/final-approved-architecture.md`
3. `docs/architecture/master-execution-plan.md`
4. `docs/architecture/phase-19-debt.md`
5. `.claude/commands/review-security.md`
6. `.github/workflows/ci.yml`
7. `tests/e2e/playwright.config.ts` and existing spec files
8. This session's brief

## 4. Locked Decisions

1. **No casual Prisma/schema changes this phase.** The Phase 18 phantom-migration incident (local `prisma migrate` run against a prod connection string, resolved as `--rolled-back`) makes this a hard rule. Any task that appears to need a schema change must justify it explicitly and get separate sign-off before touching `prisma/schema.prisma` or running a migrate command.
2. **Backend deploy target is Render.** Railway references found in docs/config are stale debt, not an active second target. Phase 19 corrects the ambiguity; it does not stand up or configure Railway.
3. **Dormant notification producers stay dormant.** `large_adjustment_approval_needed` and `offline_transactions_synced` have handlers but no producers. Phase 19 does not invent the adjustment-approval or offline-sync-reconciliation business workflows that would feed them.
4. **Secrets verification targets the real deploy environment.** `HASH_KEY` and other required secrets get checked against Render's actual runtime environment (not local `.env`, not assumed from `.env.example`).
5. **Load testing tool: k6**, added as an explicit Phase 19 change-request to the approved stack (master-execution-plan.md's stack table currently names no load-testing tool).
6. **Offline/sync scope is hardening-only.** Task 8 tests and hardens whatever offline/Dexie logic already exists. If the offline-sync backend endpoint doesn't exist, that gets documented and deferred to Phase 20 — Phase 19 does not build it.

## 5. Current Verified Baseline

- Phase 18 merged as `2bb106a` ("Phase 18: Notifications & EOD Summary (#9)"), branch `main`, working tree clean.
- 633 tests passing / 0 failed, 0 typecheck errors as of Phase 18 close.
- Render deploy confirmed green after the phantom-migration incident was resolved.
- `tests/e2e/` exists with a real `playwright.config.ts` (two device projects: "POS Terminal (Mobile)" on Galaxy Tab S4, "Admin Dashboard (Desktop)" on Desktop Chrome) — but `auth.spec.ts`, `cash-management.spec.ts`, `inventory.spec.ts`, and `pos-workflow.spec.ts` are each a single `test.skip(...)` stub with a `TODO(Phase N)` comment and zero assertions. Structurally scaffolded, functionally empty.
- `.github/workflows/ci.yml` has a `services:` block — it contains only `redis:7-alpine`. No `postgres` service exists. CI currently runs by copying `apps/api/.env.example` to `apps/api/.env`; that file's `DATABASE_URL`/`DIRECT_URL`/`TEST_DATABASE_URL` all point at placeholder Supabase hosts (`db.[PROJECT].supabase.co`), which is consistent with `phase-19-debt.md`'s note that ~105 integration tests skip in CI today.
- `.claude/commands/review-security.md` exists and defines a concrete 7-step audit procedure (auth/authorize middleware presence, Zod validation, no raw SQL, gov-ID encryption via `apps/api/src/lib/encryption.ts`, no hardcoded secrets, no stack-trace leaks, findings ranked by severity).

## 6. Scope

**In scope:**
- Doc/config consistency cleanup (Render vs Railway, `PROJECT_STATUS.md`, `.env.example`, `next.config.ts` comment)
- CI: add a real `postgres` service container and wire `DATABASE_URL`/`DIRECT_URL` so previously-skipped integration tests run
- CLAUDE.md migration-safety rule (phantom-migration prevention)
- Web lint cleanup to zero warnings
- Security audit via the existing `review-security` command, applied across auth/payment/gov-ID-touching files
- Writing real Playwright specs for all critical flows named in master-execution-plan.md's Testing Strategy section, replacing the four stub files and adding any missing flow files
- First-ever k6 load test against representative endpoints (transaction creation, auth, inventory deduction)
- Offline/PWA hardening validation against what already exists (Dexie + `@ducanh2912/next-pwa`), including minimum-device testing
- Read-only verification audit of Phases 12/14/15 against their architecture doc sections

**Out of scope / deferred to Phase 20:**
- Building the offline-sync backend endpoint if Task 8 finds it missing
- Adjustment-approval workflow for `large_adjustment_approval_needed`
- Standing up Railway as an actual second deploy target
- Supabase dashboard migration-indicator hypothesis confirmation (low-risk, informational)
- Any schema/migration work not strictly required to fix CI's Postgres wiring

## 7. Task Breakdown

### Task 1 — Deployment/doc/config consistency cleanup
**Type:** debt-removal
**Description:** Resolve the Render-vs-Railway confusion across docs and config so Phase 20's pilot runbook doesn't inherit it. Confirm Render is the sole backend deploy target per `.claude/CLAUDE.md`'s stack table and `deploy-production.yml`/`deploy-staging.yml`'s existence; correct or remove contradicting references.
**Files likely touched:** `docs/PROJECT_STATUS.md` (exact contradiction location to be confirmed at session start), `apps/web/.env.example` (outdated Railway URL), `apps/web/next.config.ts:15` (comment referencing "Vercel vs Railway"), `railway.json` (delete if unused, or document actual purpose if still needed), `.github/workflows/deploy-production.yml`.
**Acceptance criteria:** repo-wide search for "Railway" returns zero unintentional hits, or each remaining hit is a deliberate documented note explaining why; `PROJECT_STATUS.md` states one deploy platform per app with no contradiction; `next.config.ts:15` comment reflects the real decision.
**Risks/notes:** `railway.json`'s actual status is unconfirmed — could be genuinely dead, or could be a leftover from an earlier evaluated-and-rejected option. Confirm before deleting.

### Task 2 — CI database service wiring for skipped integration tests
**Type:** debt-removal
**Description:** Add a real `postgres` service container to `.github/workflows/ci.yml` (currently only `redis` exists) and point `DATABASE_URL`/`DIRECT_URL` at it for the CI run, following the three-URL pooler pattern documented in `phase-19-debt.md` (CI is IPv6-capable, so raw direct connection on 5432 applies there — this is different from the local-dev IPv4 workaround).
**Files likely touched:** `.github/workflows/ci.yml`.
**Acceptance criteria:** `services:` block includes a `postgres` container with a health check; CI env vars point `DATABASE_URL`/`DIRECT_URL` at it instead of the Supabase placeholder from `.env.example`; the ~105 integration tests that currently skip now execute and pass in the CI run.
**Risks/notes:** Migration step needs to run against the CI Postgres before tests execute (`prisma migrate deploy` or equivalent) — this is CI-local schema setup, not a Locked-Decision-1 violation, but must be scoped carefully to avoid touching real environments.

### Task 3 — CLAUDE.md migration-safety prevention rule
**Type:** debt-removal
**Description:** Add a short, concrete rule to `.claude/CLAUDE.md` preventing recurrence of the Phase 18 phantom-migration incident: never run `prisma migrate dev`/`diff` against a connection string that isn't explicitly verified as the local/dev shadow DB.
**Files likely touched:** `.claude/CLAUDE.md`.
**Acceptance criteria:** rule is present under an appropriate section, references the three-URL pattern from `phase-19-debt.md`, and is specific enough to be checkable (not vague caution language).
**Risks/notes:** none — additive doc change only.

### Task 4 — Web lint warning cleanup
**Type:** debt-removal
**Description:** Clear pre-existing `apps/web` lint warnings flagged as debt from Phase 18.
**Files likely touched:** TBD — requires running `pnpm --filter web lint` at session start to enumerate; not run during this planning pass since file writes were disabled.
**Acceptance criteria:** `pnpm --filter web lint` (or the repo's equivalent root command, pending the Turbo Windows access-violation workaround noted in `phase-19-debt.md`) returns 0 warnings, 0 errors.
**Risks/notes:** must use `pnpm --filter @potato-corner/web run lint` directly if `turbo run lint` reproduces the `0xC0000005` access violation noted for `type-check`.

### Task 5 — Security audit using `.claude/commands/review-security.md`
**Type:** verification/audit, with fixes as new hardening work where findings are actionable
**Description:** Run the existing 7-step `review-security` procedure against every router/middleware file touching authentication, payments, or government IDs. Confirm `authenticate`/`authorize`/branch-guard ordering, Zod validation coverage, no raw SQL, gov-ID encryption via `apps/api/src/lib/encryption.ts`, no hardcoded secrets, no stack-trace leaks in error responses.
**Files likely touched:** primarily `apps/api/src/modules/*/*.router.ts`, `apps/api/src/middleware/*`; fixes only where findings are concrete and in-scope for hardening (not new features).
**Acceptance criteria:** every file in scope has a documented pass/fail against each of the 7 checklist items; all critical/high findings fixed or explicitly deferred to Phase 20 with a written reason.
**Risks/notes:** scope must stay bounded to auth/payment/gov-ID-touching files per the command's own precondition — do not turn this into a full-repo audit.

### Task 6 — Full Playwright suite authorship (existing specs are test.skip stubs)
**Type:** new hardening work (despite scaffolding existing, current coverage is zero)
**Description:** Full Playwright suite authorship (existing specs are test.skip stubs). This is not an expansion of working coverage — all four existing spec files are single `test.skip` placeholders with zero assertions. Authorship covers every flow named in master-execution-plan.md's Testing Strategy section: login for all three roles; shift open → transaction → shift close; cash/GCash payment; PWD discount + VAT verification; hold order lifecycle; void + approval; stock-in recording; attendance clock-in with GPS; variance approval; offline processing + reconnect sync. Given the volume and the fact that none of it exists yet in working form, authorship spans multiple sessions (see Session Breakdown) rather than a single pass.
**Files likely touched:** `tests/e2e/auth.spec.ts`, `tests/e2e/cash-management.spec.ts`, `tests/e2e/inventory.spec.ts`, `tests/e2e/pos-workflow.spec.ts`, `tests/e2e/fixtures/*`, plus new spec files for flows without an existing stub (e.g. attendance clock-in, offline reconnect sync — confirm exact gaps at session start).
**Acceptance criteria:** every flow listed above has a passing spec (not `test.skip`); suite runs green under both configured device projects where applicable; suite runs green in CI, not just locally.
**Risks/notes:** largest task in the phase by volume — spans multiple sessions by design (see Session Breakdown). Requires test fixtures/seed data per role; coordinate with Task 2's CI Postgres wiring since E2E flows exercising real transactions need a real DB.

### Task 7 — Load testing with k6
**Type:** new hardening work
**Description:** Author k6 scripts against representative high-traffic endpoints — transaction creation (the declared 500ms performance threshold from master-execution-plan.md's Monitoring section), auth/login, and inventory deduction — and run them against a non-production environment.
**Files likely touched:** new `tests/load/` directory (naming TBD at session start — no existing convention), possibly a new CI-optional workflow step (manually triggered, not on every PR).
**Acceptance criteria:** k6 scripts exist and run against a target environment; results are recorded against the documented performance thresholds (2s general API, 500ms transaction endpoint per master-execution-plan.md's Monitoring section); failures or threshold breaches are documented as debt if not fixed same-session.
**Risks/notes:** must not run against production or a real Supabase project — needs a safe target (local, staging, or a scoped dev environment). This is a new stack addition per Locked Decision 5 and should be reflected in master-execution-plan.md's stack table as a change-request note.

### Task 8 — Offline/PWA hardening-only edge-case validation
**Type:** verification/audit, hardening only (per Locked Decision 6)
**Description:** Test and harden whatever offline/Dexie/service-worker logic already exists in `apps/web`. Validate offline cart/transaction queuing, provisional offline receipt numbering (`PC-[BRANCH]-[DATE]-OFFLINE-[LOCAL_SEQ]` per CLAUDE.md), and reconnect behavior — without building a missing sync endpoint.
**Files likely touched:** `apps/web` service worker config, Dexie schema/hooks, offline sync UI state (Zustand per the state-management separation rule).
**Acceptance criteria:** existing offline logic is exercised and either confirmed working or has documented bugs filed as debt; if the backend sync-reconciliation endpoint is confirmed missing (as `phase-19-debt.md` suggests it may be), that gets documented and explicitly deferred to Phase 20 — not built this session.
**Risks/notes:** highest chance of scope pressure toward "just build the endpoint since it's right there" — Locked Decision 6 exists specifically to prevent that; hold the line and defer instead.

### Task 9 — Minimum-device PWA testing checklist
**Type:** new hardening work
**Description:** Verify PWA install flow, offline shell load, and service worker update behavior against a locked minimum-device profile: Android-class device, ~2GB RAM, 4-core CPU, Chrome stable. Baseline verification is Playwright device emulation matching this profile; real-device verification is optional (run if hardware is available, not a blocker for task completion).
**Files likely touched:** `tests/e2e/playwright.config.ts` — add a device-emulation project matching the locked profile (~2GB RAM / 4-core CPU / Chrome stable) if not already covered by the existing "POS Terminal (Mobile)" Galaxy Tab S4 project.
**Acceptance criteria:** documented pass/fail per checklist item against the locked device profile; failures filed as debt if not fixed same-session.
**Risks/notes:** none outstanding — device profile is locked (see §4 note below); only open item is whether real hardware matching the profile is available, which does not block the emulation-based pass.

### Task 10 — Verification audit for Phases 12/14/15
**Type:** verification/audit (read-only)
**Description:** Confirm that Phase 12 (attendance), Phase 14 (supervisor dashboard), and Phase 15 (super admin dashboard) shipped code matches their corresponding sections of `final-approved-architecture.md`. Carried forward from Phase 17 handoff debt.
**Files likely touched:** none (read-only verification) unless discrepancies are found and explicitly scoped as fixes.
**Acceptance criteria:** written confirmation per phase, or a list of gaps filed as new debt items.
**Risks/notes:** must stay read-only per its own nature — this is an audit, not a re-implementation pass, even if gaps are found.

## 8. Deliverables

- Updated `.claude/CLAUDE.md` with the migration-safety rule
- Corrected deploy-platform docs/config (no unintentional Railway references)
- `.github/workflows/ci.yml` with a working `postgres` service and no skipped integration tests
- `apps/web` lint passing clean
- A security audit report (findings + fixes or documented deferrals)
- A fully populated `tests/e2e/` suite covering every flow in master-execution-plan.md's Testing Strategy, passing in CI
- k6 load test scripts + a results summary against documented performance thresholds
- Offline/PWA validation notes, with any endpoint gaps explicitly deferred to Phase 20
- A minimum-device PWA testing checklist with results
- A Phase 12/14/15 verification report

## 9. Session Breakdown

- **Session A:** Task 1 + Task 2 + Task 3 (doc/CI/CLAUDE.md debt cleanup — low risk, no new dependencies, unblocks Task 6's DB-dependent specs)
- **Session B:** Task 4 + Task 5 (lint + security audit)
- **Session C:** Task 6, part 1 — Auth + POS core flows (login for all three roles; shift open → transaction → shift close; cash/GCash payment; PWD discount + VAT verification)
- **Session D:** Task 6, part 2 — Cash management + inventory + role matrix (cash count/variance approval/handover detection; stock-in + adjustment + out-of-stock cascade; hold order lifecycle; void + approval; role-permission boundary coverage across all three roles)
- **Session E (if required):** Task 6, part 3 — Offline + edge cases (attendance clock-in with GPS; offline processing + reconnect sync; any remaining flow gaps from parts 1–2), plus Task 7 + Task 8 (k6 load testing + offline hardening)
- **Session F:** Task 9 + Task 10 (device testing + verification audit, phase closeout)

## 10. Risks / Open Questions

- Task 6's true size: with all four spec files at zero real coverage rather than partially built, authorship is split across Sessions C, D, and E (see §9) rather than compressed into one. Flag remaining sub-splits for re-estimation once flow-by-flow breakdown starts within each session.
- Task 1's exact `PROJECT_STATUS.md` contradiction location wasn't re-verified in this fact-finding pass (carried forward from Phase 17 handoff notes) — confirm at Session A start.
- Task 2's CI Postgres wiring needs a migration-apply step before tests run; exact command (`prisma migrate deploy` vs. `db push`) should be decided against Locked Decision 1 (no casual schema changes) — this is CI-environment setup, not a schema change, but the distinction should be stated explicitly in the CI diff's commit message to avoid ambiguity later.

## 11. Exit Criteria

Phase 19 is complete when:
- All 10 tasks have either met their acceptance criteria or have findings explicitly filed as Phase 20 debt with written justification
- CI runs the full test suite (unit, integration, and E2E) with zero skips due to missing infrastructure
- `pnpm run lint`, `pnpm run type-check`, `pnpm run test`, and `pnpm run build` are all green
- Security audit findings are at zero unresolved critical/high items
- k6 load test results are recorded against documented thresholds, with any breaches either fixed or filed as Phase 20 debt
- No unintentional Railway references remain in docs/config
- `.claude/CLAUDE.md` contains the migration-safety rule

## 12. Carry-Forward to Phase 20

- Offline-sync backend endpoint (if Task 8 confirms it's missing) — `offline_transactions_synced` notification stays dormant until this exists
- `large_adjustment_approval_needed` notification producer / adjustment-approval workflow
- Supabase dashboard migration-indicator hypothesis — still unconfirmed as of this writing, low risk, informational only
- Any Task 5 critical/high security findings not fixed same-session
- Any Task 6 flow specs that can't be completed within the phase's session budget
- Any Task 10 gaps found in Phase 12/14/15 that require actual code changes (audit itself stays read-only; fixes are Phase 20 scope unless trivial)
