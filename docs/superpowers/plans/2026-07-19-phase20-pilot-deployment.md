# Phase 20 — Pilot Branch Deployment

**Status:** Planning — pending GO COMMIT before implementation begins.
**Scope statement (master-execution-plan.md, roadmap line 82):** "Pilot branch deployment — production config, recipe testing protocol sign-off, 3-day Super Admin on-call, feedback collection."

This document sequences what `docs/architecture/final-approved-architecture.md` and `docs/architecture/master-execution-plan.md` already decided into an executable Phase 20 plan. Nothing here redesigns prior decisions.

## Locked Decisions (carried forward, not open for reconsideration)

1. Render = backend deployment, Vercel = frontend deployment, Supabase = database, Upstash = Redis, Resend = email — all confirmed, no re-litigation.
2. No new libraries without a formal change request.
3. No schema changes without explicit justification (Prisma Migrate only, never the Supabase dashboard directly).
4. Dormant notification producers stay dormant unless a phase explicitly scopes them in — Phase 20 explicitly scopes in `large_adjustment_approval_needed` (Task 5) and offline-sync (Task 4); all other dormant producers remain dormant.
5. k6 load-testing suite exists from Phase 19 Task 7 (`tests/load/`) — reused, not rebuilt.
6. Playwright E2E suite exists from Phase 19 Task 6 but has never been run live — Task 10 runs it, does not rewrite it.
7. Migration safety three-URL pattern (`DATABASE_URL` / `DIRECT_URL` / `PRODUCTION_DATABASE_URL_DIRECT`) applies without exception — verify the actual connection target before every `prisma migrate` command, per the Phase 18 phantom-migration incident.
8. Recipe deduction algorithm, PWD/Senior VAT formula, transaction_number=receipt_number, and offline receipt number format are unmodifiable without explicit instruction.
9. State management separation (DB data → TanStack Query, browser-only state → Zustand) holds for any new UI work (Task 7).
10. JWT structure is unmodifiable.

## Carry-Forward Reconciliation

| # | Item | Source | Disposition |
|---|---|---|---|
| 1 | Hold orders backend (Phase 10 scope, never implemented) | Session brief | In scope — Task 2 |
| 2 | Offline-sync backend endpoint | Session brief + Phase 19 §12 | In scope — Task 4 |
| 3 | `large_adjustment_approval_needed` notification producer/workflow | Session brief + Phase 19 §12 | In scope — Task 5 |
| 4 | PWA icons + real-device PWA verification | Session brief | In scope — Task 6 |
| 5 | Staff clock-in UI (no page exists anywhere in the frontend) | Session brief + confirmed by Phase 19 Task 10 audit | In scope — Task 7, full implementation, not gap-closing |
| 6 | Branch rankings on dashboard homepage | Session brief | **Not a gap** — see Task 8 finding below; closed as documentation, no code change |
| 7 | Real user emails / accounts | Session brief | In scope — Task 9 |
| 8 | HASH_KEY verification | Session brief | In scope — Task 9 |
| 9 | Supabase dashboard migration-indicator hypothesis | Phase 19 §12 only | Deferred — informational/low-risk per Phase 19's own classification, does not block pilot |
| 10 | Phase 19 Task 5 unresolved critical/high security findings | Phase 19 §12 only | **None found** — Task 12 is verification-only |
| 11 | Phase 19 Task 10 gaps requiring code changes | Phase 19 §12 only | **Only gap is item 5 above (clock-in UI), already folded into Task 7** — Task 13 is verification-only |

**Recipe testing protocol** (named in the roadmap line, undefined in any governing doc): defined below under Task 1. Sign-off location: **PR comment on the Phase 20 merge PR**.

---

## Tasks

### Task 1 — Define & execute Recipe Testing Protocol
**Description:** Pilot-branch staff run one real transaction per active product/flavor combination sold at that branch, exercising the live recipe deduction algorithm (`.claude/CLAUDE.md` base → flavor-override → multiply → deduct sequence). Expected vs. actual ingredient deductions are compared per transaction.
**Files:** none (operational protocol, executed against the already-deployed system); results and sign-off recorded as a PR comment on the Phase 20 merge PR, not a new file.
**Acceptance criteria:** every active product/flavor combination at the pilot branch tested at least once; zero unexplained deduction discrepancies, or each discrepancy triaged and fixed before go-live; Super Admin sign-off posted as a PR comment before Task 16 (cutover).

### Task 2 — Hold Orders backend implementation
**Description:** Implement per `final-approved-architecture.md` line 126 exactly: max 3 held orders per terminal, 15-minute expiry, non-blocking toast on expiry, `held_order_expired` audit log event, no supervisor action required. This is Phase 10 scope that was never built.
**Files:** `apps/api/src/modules/pos/pos.router.ts`, `pos.service.ts`, `pos.repository.ts`, `pos.types.ts`; corresponding Zod schemas in `packages/shared`; new Vitest unit tests (expiry timer, 3-order limit) and a live run of the existing hold-order-lifecycle E2E spec (already scoped in Task 6/master-execution-plan.md's Testing Strategy).
**Acceptance criteria:** unit tests cover expiry and limit logic; hold-order-lifecycle E2E flow passes against staging; no supervisor-approval step introduced (matches the architecture doc's explicit "no supervisor action required").

### Task 3 — Production environment configuration
**Description:** Stand up the third Supabase project (production, alongside existing dev/staging), verify `DATABASE_URL`/`DIRECT_URL`/`PRODUCTION_DATABASE_URL_DIRECT` are each pointed at their correct target per CLAUDE.md's three-URL rule — print/verify host before any `prisma migrate` command — deploy `main` to Render (backend) and Vercel (frontend) production targets, configure Sentry and PostHog for production.
**Files:** external service configuration (Render/Vercel/Supabase/Upstash/Resend dashboards); `.env.example` updated only if a new variable is introduced (none expected).
**Acceptance criteria:** all five services live and connected; the actual `DIRECT_URL` host is verified against the intended production project immediately before the first `prisma migrate deploy` — not assumed from memory, per the Phase 18 incident that motivated this rule.

### Task 4 — Offline-sync backend endpoint
**Description:** Implement the reconnect-sync reconciliation endpoint that Phase 19 Task 8 confirmed was missing (offline logic itself was validated and works; only the backend endpoint was deferred). This unblocks the `offline_transactions_synced` notification, currently dormant for lack of a producer.
**Files:** new or extended module under `apps/api/src/modules/` (exact location TBD at session start — confirm whether an existing `sync` or `offline` module stub exists before creating a new one); offline receipt number reconciliation must preserve the `PC-[BRANCH]-[DATE]-OFFLINE-[LOCAL_SEQ]` → official number replacement rule from CLAUDE.md.
**Acceptance criteria:** offline processing + reconnect sync E2E flow (already scoped in Testing Strategy) exercises the real endpoint end-to-end; `offline_transactions_synced` notification fires on successful sync.

### Task 5 — `large_adjustment_approval_needed` notification
**Description:** Wire the dormant notification producer for real, scoped in explicitly for Phase 20 per Locked Decision 4 above, since the pilot branch will generate real inventory adjustments with real financial stakes.
**Files:** inventory adjustment module (producer side — likely `apps/api/src/modules/inventory/inventory.service.ts` or equivalent, confirm exact location at session start), notifications module (consumer/dispatch, confirm delivery pipeline status from Phase 18 scope).
**Acceptance criteria:** an adjustment above the defined threshold triggers the notification end-to-end to the correct role (Supervisor/Super Admin per branch context).

### Task 6 — PWA hardening: icons + real-device verification
**Description:** Complete the PWA icon set and run install/offline verification on actual pilot-branch hardware (not emulation), building on the Phase 19 Task 9 minimum-device checklist which was emulation-only.
**Files:** `apps/web/public/icons/*`, `apps/web/public/manifest.json` (or equivalent PWA manifest location).
**Acceptance criteria:** installable on the actual pilot device(s); offline mode confirmed functional per the Phase 19 Task 8 hardening checklist, now on real hardware.

### Task 7 — Staff clock-in UI (full implementation)
**Description:** Confirmed by direct search (`find apps/web -name "*.tsx" | xargs grep -l -i clock`) and by the Phase 19 Task 10 verification audit: **no staff-facing clock-in/clock-out page exists anywhere in the frontend.** Existing clock-related files are all admin/supervisor-facing views (`(admin)/admin/attendance/page.tsx`, `(supervisor)/supervisor/attendance/page.tsx`) or the correction/override dialog — none let a staff member create the attendance record itself. The Phase 12 attendance backend (GPS validation, time-delta flagging) is otherwise complete and correct per the audit. This is full implementation, not gap-closing.
**Files:** new page under `apps/web/app/(pos)/` (or a new `(staff)` route group if that's the established pattern — confirm against existing route groups at session start: `(admin)`, `(pos)`, `(supervisor)` are the three currently present); corresponding query hook/store per the state-management separation rule (clock state during an active session → Zustand; historical attendance data → TanStack Query); new component tests.
**Acceptance criteria:** staff can clock in/out with GPS validation from the actual POS terminal UI; attendance clock-in-with-GPS E2E flow (already scoped in Testing Strategy) has a real page to exercise instead of a stub.

### Task 8 — Branch rankings (verification only, no code change)
**Description:** Phase 19 Task 10 audit confirmed branch rankings are **not missing** — they exist as `admin/reports/page.tsx`'s "Branch Comparison" tab (`BranchComparisonReportRow`, one of the 13 Phase 16 report types). The dashboard homepage itself (`DashboardBranchGrid`) is a flat status grid without ranking, which the audit called "a reasonable implementation choice, not a gap." No code change is planned; this task is closed as documentation only.
**Files:** none.
**Acceptance criteria:** none — closed by this plan doc recording the audit's finding. If the user wants rankings surfaced on the homepage specifically (not just Reports), that requires an explicit scope decision outside this plan.

### Task 9 — Real user onboarding
**Description:** Create real Super Admin / Supervisor / Staff accounts for the pilot branch with real emails, verify Resend delivery works with the production HASH_KEY, issue credentials via a secure channel, walk pilot staff through first login + PIN setup.
**Files:** none (data/config only — account creation via existing admin flows, no new code).
**Acceptance criteria:** all pilot-branch users can log in; password/PIN reset flow verified live against production; Resend delivers to real inboxes.

### Task 10 — Live Playwright E2E run against staging
**Description:** The Phase 19 Task 6 suite was authored but never run live. Run it now against staging with production-equivalent configuration, including the two new flows this plan adds real pages/endpoints for (hold orders — Task 2, offline reconnect sync — Task 4, staff clock-in — Task 7).
**Files:** `playwright.config.ts` (env target only, no new specs expected beyond what Task 2/4/7 already require).
**Acceptance criteria:** full suite green against staging across both device projects (mobile POS + desktop admin), zero `test.skip` remaining.

### Task 11 — k6 load test execution against staging
**Description:** Run the existing `tests/load/` k6 suite (Phase 19 Task 7) against staging under pilot-realistic load. Phase 19 authored the scripts but recording results against the documented thresholds (2s general API, 500ms transaction endpoint) was left open.
**Files:** none (`tests/load/` already exists).
**Acceptance criteria:** results recorded against both thresholds; any breach documented as debt with a fix-or-accept decision before go-live.

### Task 12 — Security audit residuals (verification-only)
**Description:** Phase 19 Task 5's audit (`docs/security/2026-07-17-phase19-task5-security-audit.md`) found **no critical or high findings.** Two informational/low-severity notes exist, both already effectively addressed: (1) `requirePasswordChange` middleware isn't retrofitted onto Phase 1–4 routers (branches, products, flavors, recipes, inventory, product-requests, price-overrides) — the middleware's own doc comment already documents this as an intentional scope decision, tracked separately in `PROJECT_STATUS.md` §19 Medium item 6; (2) `discounts.router.ts` is an unimplemented stub with zero routes and therefore no attack surface — actual PWD/Senior discount logic lives in and was audited via `transactions.router.ts`. **No fix required for Phase 20.** This task is verification-only: confirm both notes are still accurate at Phase 20 session start (no regressions since Phase 19).
**Files:** none expected.
**Acceptance criteria:** written confirmation that no new critical/high findings exist since Phase 19 Task 5; the two informational notes re-confirmed as still low-risk/unchanged.

### Task 13 — Phase 19 Task 10 audit gaps (verification-only)
**Description:** The Phase 19 Task 10 verification audit (`docs/security/2026-07-17-phase19-task10-phase-verification-audit.md`) found Phases 14/15 fully match the architecture doc with no code-level gaps, and Phase 12's backend is complete and correct. Its **only** finding was the missing staff clock-in UI — already captured above as Task 7. There is no separate code-change work for this task.
**Files:** none.
**Acceptance criteria:** confirm at Phase 20 session start that no new gaps have emerged since Phase 19 Task 10 (e.g., via a quick diff-check against `final-approved-architecture.md` Phases 12/14/15 sections if any code changed in the interim); otherwise close as already resolved by Task 7.

### Task 14 — 3-day Super Admin on-call setup
**Description:** Define the on-call schedule for the pilot window, route Sentry/PostHog alerts to the on-call Super Admin, define escalation path and rollback authority.
**Files:** new `docs/runbooks/2026-phase20-pilot-on-call.md` (or equivalent — naming TBD at session start).
**Acceptance criteria:** on-call Super Admin confirmed reachable; alert routing tested with a synthetic error before go-live; escalation path documented.

### Task 15 — Feedback collection mechanism
**Description:** Define how pilot-branch feedback is captured and routed back to the team during the 3-day pilot window.
**Files:** TBD at session start — likely a lightweight form or structured doc, not new application code (PostHog is explicitly product-analytics-only per CLAUDE.md/master-execution-plan.md, not a feedback-collection tool).
**Acceptance criteria:** mechanism live and communicated to pilot staff before Task 16 cutover.

### Task 16 — Pilot go-live cutover
**Description:** Pilot branch begins using the production system for real transactions.
**Files:** none.
**Acceptance criteria:** first real transaction processed successfully; Task 1 recipe-protocol sign-off posted before cutover; all Pilot Readiness criteria (below) met.

---

## Pilot Readiness Definition (go/no-go gate before Task 16)

All of the following must hold:
- Tasks 1–15 acceptance criteria met, or explicitly deferred with written justification (mirroring the Phase 19 exit-criteria pattern).
- CI green (lint / type-check / test / build).
- Task 12 confirms zero unresolved critical/high security findings.
- Task 11 k6 results within documented thresholds, or breaches explicitly accepted in writing.
- Task 10 Playwright suite green against staging.
- Rollback drill executed at least once in staging before go-live.
- Task 14 on-call schedule confirmed staffed and alert routing tested.
- Task 1 recipe testing protocol sign-off posted as a PR comment on the Phase 20 merge PR.

## Rollback Plan If Pilot Fails

Per master-execution-plan.md's Deployment Strategy decision tree, applied without modification:
- Frontend-only issue → one-click Vercel rollback.
- API issue without DB change → one-click Render rollback.
- API issue with DB change → apply the tested down-migration then rollback Render, or fix-forward if the migration can't be reversed.
- Data corruption → Supabase point-in-time recovery.

Pilot-specific addition: a documented "pause pilot" state — the branch reverts to its pre-pilot process, the Super Admin notifies branch staff directly, root-cause fix happens off the live branch (staging), and the pilot resumes only after the fix is verified in staging.

## Estimated Session Breakdown

- **Session A:** Task 1 (recipe protocol design) + Task 2 (hold orders backend)
- **Session B:** Task 3 (production config) + Task 4 (offline-sync endpoint)
- **Session C:** Task 5 (adjustment notification) + Task 7 (staff clock-in UI)
- **Session D:** Task 6 (PWA icons + real-device verification) + Task 9 (real user onboarding)
- **Session E:** Task 10 (live E2E run) + Task 11 (k6 run)
- **Session F:** Task 12 + Task 13 (verification-only re-confirmations) + Task 14 (on-call setup)
- **Session G:** Task 15 (feedback mechanism) + Task 1 execution (recipe protocol run + sign-off) + Task 16 (cutover), followed by the 3-day on-call monitoring window (calendar time, not a coding session)

Task 8 requires no session — closed by this document.
