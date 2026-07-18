# Pilot On-Call Runbook

## 1. Purpose and Scope

This runbook governs on-call coverage for the Phase 20 pilot branch deployment — the first live branch running real transactions on the Potato Corner POS platform. It is scoped **only** to the 3-day pilot monitoring window described in Task 16 of `docs/superpowers/plans/2026-07-19-phase20-pilot-deployment.md`. It does not cover steady-state, multi-branch operations — a separate runbook should be written before general rollout.

## 2. Pilot Window Dates

**TBD at pilot time.** To be filled in immediately before Task 16 cutover:

- Pilot start (go-live): `TBD — YYYY-MM-DD HH:MM PHT`
- Pilot end (handoff to steady-state or rollback decision): `TBD — YYYY-MM-DD HH:MM PHT`
- Pilot branch name/ID: `TBD`

## 3. On-Call Contact

**TBD — named person required before go-live.** Per the Pilot Readiness Definition, cutover cannot proceed until this section is filled in and the person has confirmed reachability.

| Role | Name | Phone | Email | Backup |
|---|---|---|---|---|
| Primary on-call (Super Admin) | TBD | TBD | TBD | TBD |
| Secondary/backup on-call | TBD | TBD | TBD | TBD |

The primary on-call must keep their phone reachable (ringer on, not silent) for the full pilot window, including outside normal business hours.

## 4. Monitoring Dashboards

| System | Purpose | URL |
|---|---|---|
| Render | API service health, logs, restarts | `https://dashboard.render.com/PLACEHOLDER` |
| Vercel | Frontend deploys, build/runtime logs | `https://vercel.com/PLACEHOLDER` |
| Supabase | Database health, connection pool, query performance | `https://supabase.com/dashboard/project/PLACEHOLDER` |
| Upstash | Redis (BullMQ queues, session blacklist) health | `https://console.upstash.com/PLACEHOLDER` |
| Resend | Transactional email delivery status | `https://resend.com/PLACEHOLDER` |
| Sentry | Error tracking and alerting (see §5) | `https://sentry.io/organizations/PLACEHOLDER` |
| UptimeRobot | Uptime/availability checks | `https://uptimerobot.com/dashboard#PLACEHOLDER` |

Replace all `PLACEHOLDER` values with real project/org URLs before go-live.

## 5. Alert Routing

### Sentry — configured

Sentry is integrated in the API (`apps/api/src/server.ts`, `apps/api/src/app.ts`) and initializes when `SENTRY_DSN` is set. It captures unhandled exceptions, Redis connection errors, and BullMQ worker failures (`fraud.queue.ts`, `report.queue.ts`).

Before go-live:
1. Confirm `SENTRY_DSN` is set in the Render production environment (not just `.env.example`).
2. In the Sentry project dashboard, configure an alert rule that notifies the on-call contact (§3) via email and/or SMS/push for any new issue during the pilot window.
3. Assign the on-call person as the Sentry project owner or add them to the on-call alert recipient list for the duration of the pilot.

If Sentry alerting is not yet wired to a real recipient, the on-call person must manually check the Sentry dashboard (§4) at least once per hour during business hours of the pilot window.

### PostHog — not configured

PostHog does not appear anywhere in this codebase, `.env.example` files, or the approved architecture/stack documents. It is not part of this project's approved stack and is not used for alerting. No PostHog-based alert routing exists or is planned for this pilot.

Usage anomalies (unexpected transaction volume drops, unusual error rates) must instead be caught via:
- Manual review of Render/Supabase dashboards (§4).
- Sentry error volume (§5, Sentry section).
- Direct reports from pilot branch staff via the communication channel (§10).

## 6. Issue Severity Classification

| Severity | Definition | Example |
|---|---|---|
| P0 | System down — no transactions possible at the pilot branch | API unreachable, DB connection pool exhausted, frontend fails to load |
| P1 | Partial outage — some flows broken | Payment recording fails, offline sync broken, PWD/Senior discount calculation wrong |
| P2 | Degraded performance or non-critical feature broken | Slow POS response, report export failing, clock-in UI glitch |
| P3 | Cosmetic or low-impact issue | UI misalignment, non-blocking console warning, minor copy issue |

## 7. Escalation Path Per Severity

- **P0:** On-call contacts pilot branch staff immediately to pause POS use if needed → on-call begins rollback assessment (§8) within 15 minutes → if unresolved in 30 minutes, escalate to backup on-call and engineering.
- **P1:** On-call investigates within 30 minutes → notify pilot branch staff of the affected flow and workaround if any → fix-forward or rollback decision within 2 hours.
- **P2:** On-call logs the issue via the communication channel (§10), investigates within same business day, no immediate pilot-branch notification required unless it worsens.
- **P3:** Logged for post-pilot follow-up; no immediate action required during the pilot window.

Any issue that cannot be resolved by the primary on-call within its target window escalates to the backup on-call (§3).

## 8. Rollback Decision Criteria and Authority

**Authority:** Only the on-call Super Admin (primary, or backup if primary is unreachable) may authorize a rollback or pause-pilot decision. No other role (Supervisor, Staff) has rollback authority.

**Rollback vs. fix-forward:**
- Rollback when the issue is P0/P1, the fix is not immediately obvious, and pilot branch operations are meaningfully disrupted.
- Fix-forward when the issue is isolated, a fix can be verified in staging within the escalation window (§7), and the pilot branch can continue operating (manually or in a degraded mode) in the meantime.
- Data corruption of any severity always triggers immediate rollback consideration — never fix-forward against corrupted production data.

**Rollback procedure per layer** (per master-execution-plan.md §10.4 decision tree, applied without modification):
1. **Frontend-only issue:** One-click Vercel rollback to the previous deployment.
2. **API issue without DB change:** One-click Render rollback to the previous deployment.
3. **API issue with DB change:** Apply the tested down-migration, then rollback Render; if the migration cannot be reversed, fix-forward instead.
4. **Data corruption:** Supabase point-in-time recovery (PITR).

**Pause-pilot state:** If a rollback is authorized, the pilot branch reverts to its pre-pilot manual process. The on-call Super Admin notifies pilot branch staff directly (in person or by phone — do not rely solely on the communication channel for this). Root-cause fix work happens off the live branch, in staging. The pilot resumes only after the fix is verified in staging and the on-call Super Admin re-authorizes go-live.

## 9. Synthetic Error Test Procedure (Pre-Go-Live Smoke Test)

Run this before go-live to confirm alerting actually reaches the on-call contact:

1. Confirm `SENTRY_DSN` is set in the Render production environment.
2. Trigger a controlled, non-destructive test error in the production API (e.g., hit a known dev-only diagnostic endpoint if one exists, or coordinate a deliberate one-off exception via a code path already covered by existing Sentry captures such as the Redis reconnect handler) — do this only during a maintenance window with no real pilot traffic.
3. Confirm the error appears in the Sentry dashboard (§4) within a few minutes.
4. Confirm the on-call contact (§3) actually receives the alert notification (email/SMS/push, per whatever channel was configured in §5).
5. If the alert does not arrive, fix the alert rule configuration before proceeding to go-live — do not go live with unverified alerting.
6. Record the test result (pass/fail, timestamp, who ran it) in the communication channel (§10).

## 10. Communication Channel During Pilot

**TBD — to be named at pilot time.** Recommended default: a dedicated Slack/messaging channel or group chat including the on-call Super Admin, backup on-call, and pilot branch staff, used for:
- Reporting any issue (any severity) as it's noticed.
- Logging rollback/fix-forward decisions and their rationale.
- Recording the synthetic error test result (§9).

All P0/P1 issues reported here must also be escalated per §7 — the channel is a record, not a substitute for direct escalation.

## 11. End-of-Pilot Handoff Procedure

At the end of the 3-day pilot window:
1. On-call Super Admin compiles a summary of all issues encountered (severity, resolution, whether rollback/fix-forward was used) from the communication channel (§10).
2. Confirm final transaction data at the pilot branch reconciles (no data loss, no unresolved P0/P1 issues open).
3. Decide, with the pilot branch and engineering stakeholders, whether to extend pilot monitoring, proceed to broader rollout, or pause for further fixes.
4. Archive the pilot issue summary alongside this runbook for reference by the next pilot or rollout phase.
5. Stand down dedicated on-call coverage once the decision in step 3 is made and communicated.
