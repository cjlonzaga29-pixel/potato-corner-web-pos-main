# Backup & Restore Runbook — Supabase PostgreSQL

**Scope:** Potato Corner Enterprise Web POS — production and staging Supabase Postgres databases.
**Status of this document:** Drafted from `docs/architecture/final-approved-architecture.md`, `docs/architecture/master-execution-plan.md`, and `PROJECT_STATUS.md` only. Any line marked **UNVERIFIED** requires confirmation in the live Supabase dashboard before this runbook can be treated as operationally accurate. No connection strings, project refs, or credentials appear below — replace every `<placeholder>` with the real value at time of use, from a secrets manager or `.env`, never committed to source.

---

## 1. Backup Strategy Overview

Per the locked architecture spec (`final-approved-architecture.md`, Part 2 — Tech Stack): "PostgreSQL 15 via Supabase, PgBouncer pooling, `pgcrypto` + `uuid-ossp` extensions, Prisma Migrate, automated daily backups with point-in-time recovery, monthly restoration test."

Three separate Supabase projects exist by design — development, staging, production (`master-execution-plan.md`, Environments) — schema changes are applied only via Prisma Migrate, never the Supabase dashboard directly. This runbook covers backup/restore for the **staging** and **production** projects; the development project is not backed up (local/disposable).

Layered backup strategy:

| Layer | Mechanism | Owner | Frequency |
|---|---|---|---|
| 1 — Continuous | Supabase PITR (WAL archiving) | Supabase Pro platform | Continuous (per-transaction) |
| 2 — Scheduled snapshot | Supabase automated daily backup | Supabase Pro platform | Daily |
| 3 — Manual/offsite | `pg_dump` logical backup | Engineering (manual or CI cron) | On-demand + pre-migration |
| 4 — Validation | Restore drill to a disposable/staging target | Engineering | Quarterly (this runbook) — architecture doc states monthly as the target cadence; quarterly is the floor, see §9 |

Current production status per `PROJECT_STATUS.md` §10: Supabase Postgres is **live** (project `potato-corner-pos`-adjacent backend, connected via Session Pooler — direct connection is IPv6-only), 14 migrations applied as of 2026-07-17. Whether Pro-tier PITR and the "automated daily backups" line from the architecture doc are actually **enabled** on this specific live project is **UNVERIFIED — requires dashboard confirmation** (Supabase Dashboard → Project → Database → Backups).

---

## 2. Supabase Automated Backups (Pro Tier)

Supabase Pro tier includes automated daily backups of the full Postgres cluster, retained on a rolling window, without requiring any application-level configuration — this is a platform feature, not something this codebase implements or triggers.

What the architecture doc commits to:
- **Tier:** Supabase Pro (`master-execution-plan.md`, Part 2 — Infrastructure: "Supabase Pro in `ap-southeast-1` (Singapore)")
- **Cadence:** Daily automated backups (architecture doc, Part 2 — Tech Stack)
- **Region:** `ap-southeast-1` (Singapore)

What must be confirmed operationally (**UNVERIFIED — requires dashboard confirmation** for each):
- [ ] Production project is actually on the Pro plan (not Free/Team-default) — backups differ materially by tier
- [ ] Daily backup retention window (Supabase Pro's documented default retention; confirm in-dashboard, do not assume)
- [ ] Backup schedule/time-of-day and whether it's configurable at this tier
- [ ] Whether backups are region-local (`ap-southeast-1`) or replicated elsewhere
- [ ] Staging project's backup tier/status — the architecture doc does not distinguish staging from production on backup entitlement, and staging may be provisioned on a lower tier

Where to check: Supabase Dashboard → select project → **Database → Backups**. Record findings by updating this section with a real confirmation date once checked — do not leave this runbook silently stale.

---

## 3. Point-in-Time Recovery (PITR)

The architecture doc names PITR explicitly twice:
- Part 2 — Tech Stack: "automated daily backups **with point-in-time recovery**"
- Part 8 (rollback decision tree, `master-execution-plan.md`): "data corruption → Supabase point-in-time recovery"

PITR allows restoring the database to any timestamp within the retained WAL window (not just to a daily snapshot boundary), which is the correct tool for:
- Accidental `DELETE`/`UPDATE` without a `WHERE` clause
- A bad migration that corrupted data (as opposed to schema) after `prisma migrate deploy`
- Any incident where the exact "last known good" moment is known or can be bisected to

**UNVERIFIED — requires dashboard confirmation:**
- [ ] PITR is enabled (it is a paid add-on on some Supabase tiers, not automatically bundled with every Pro project — confirm entitlement, not just plan name)
- [ ] Retention window in days (commonly 7 or 14 on Supabase Pro's PITR add-on — confirm the actual configured value)
- [ ] Earliest recoverable timestamp currently available (visible in-dashboard)

### PITR restore procedure (high-level — confirm exact UI flow at time of use, Supabase's console changes)

1. In Supabase Dashboard → **Database → Backups → Point in Time Recovery**, select the target timestamp.
2. Supabase provisions recovery **into a new project** (it does not overwrite the live project in place) — confirm this is still Supabase's current behavior before relying on it in an incident.
3. Validate the recovered project against the checklist in §5 before treating it as trustworthy.
4. Cut over application connection strings (`DATABASE_URL`, `DIRECT_URL`) only after validation passes — this is a credential/config change to production, requires the same change-control as any prod deploy.
5. Decommission the old project only after the business has confirmed the cutover is stable (retain it read-only for a rollback window first).

This is a destructive, production-affecting operation. Do not execute against the live production project without explicit authorization from whoever owns the incident — see §6 Disaster Recovery Plan for escalation.

---

## 4. Manual Logical Backup (pg_dump)

A `pg_dump` fallback is required for scenarios PITR doesn't cover well: pre-migration safety snapshots, exporting a subset for local debugging, or an offsite/portable copy independent of the Supabase platform.

### Connection

Per `TOOLING_SETUP.md` (referenced in `PROJECT_STATUS.md` §10), this project connects via **Session Pooler**, not the direct connection string, because the direct connection is IPv6-only and many local/CI networks are IPv4-only. Use the pooler connection string for `pg_dump` unless running from an IPv6-capable network.

```bash
# Example only — replace every placeholder, never commit real values.
# Prefer the Session Pooler host/port from the Supabase dashboard connection info,
# not the direct db.<project-ref>.supabase.co host, unless IPv6 connectivity is confirmed.

pg_dump \
  --host=<supabase-pooler-host> \
  --port=<pooler-port> \
  --username=<pg-username> \
  --dbname=<database-name> \
  --format=custom \
  --file="backup-$(date +%Y%m%d-%H%M%S).dump" \
  --no-owner \
  --no-privileges

# Password is supplied via PGPASSWORD env var or a .pgpass file — never as a CLI argument
# (CLI args are visible in `ps`/shell history). Example:
#   PGPASSWORD=<password> pg_dump ...
```

Flags rationale:
- `--format=custom`: enables selective restore and works with `pg_restore -j` (parallel restore) for large databases
- `--no-owner --no-privileges`: avoids failing a restore into a target where the original Supabase-managed roles don't exist (e.g., a local or staging target)

### When to run a manual dump (in addition to any scheduled job)

- Immediately before applying a `prisma migrate deploy` against production, when the migration includes destructive operations (column drops, type changes) — this is a fast, local safety net on top of platform PITR, not a replacement for it
- Before the quarterly restore test (§9), to have a known-good artifact for validation
- On-demand, if an incident requires taking a portable snapshot before further platform-level recovery actions

**UNVERIFIED — requires confirmation:** whether a scheduled `pg_dump` job (CI cron, Render cron, etc.) currently exists anywhere in this repo. A grep of `.github/workflows/` for a backup-specific job was not performed as part of this task (out of file-access scope); if one exists it supersedes the "manual only" framing above and should be cross-referenced here.

### Storage of manual dumps

Manual dump files contain full production data, including PII (employee government-ID fields per the architecture's encryption-at-rest design, customer discount data) — treat them as production secrets:
- Never commit to git
- Store only in an access-controlled location (encrypted bucket, password-managed vault attachment) with the same access tier as production credentials
- Delete or rotate out per whatever data-retention policy the business defines — not specified in the architecture docs reviewed for this task, **UNVERIFIED — requires a policy decision**, not just a technical check

---

## 5. Restore Procedure (Staging Validation)

Never restore directly into production to "test" a backup. Always restore into a disposable or staging target first.

### 5.1 Restore a `pg_dump` custom-format file

```bash
# Target should be a disposable local Postgres instance or the staging Supabase project
# — never production, and never a target holding data you still need.

pg_restore \
  --host=<target-host> \
  --port=<target-port> \
  --username=<pg-username> \
  --dbname=<target-database-name> \
  --clean --if-exists \
  --no-owner --no-privileges \
  --jobs=4 \
  backup-<timestamp>.dump
```

### 5.2 Post-restore validation checklist

Run before declaring a restore trustworthy — applies to both a `pg_dump` restore and a PITR-recovered project:

- [ ] `prisma migrate status` against the restored database reports "up to date" (matches migration count expected at the backup's timestamp — 14 migrations as of 2026-07-17 per `PROJECT_STATUS.md`, but this number will drift; check the actual current count, don't hardcode)
- [ ] Row counts on core tables (`Transaction`, `Shift`, `AuditLog`, `User`) are non-zero and roughly consistent with expectations for the backup's timestamp
- [ ] `AuditLog` hash chain is intact for at least the most recent N rows (the architecture's audit trail is hash-chained — a broken chain post-restore indicates a partial/corrupt restore, not just missing rows)
- [ ] Application (`apps/api`) boots against the restored database with `DATABASE_URL`/`DIRECT_URL` pointed at it, and `GET /health` returns healthy
- [ ] A representative read query per core module (auth, branches, transactions, inventory) succeeds without error
- [ ] No orphaned foreign keys / referential integrity errors reported by Prisma on connect

Only after all checks pass should this restore be considered validated — for the quarterly test (§9) or for an actual incident cutover.

---

## 6. Disaster Recovery Plan

### 6.1 Scenario matrix

| Scenario | Primary recovery path | Reference |
|---|---|---|
| Frontend-only issue (bad Vercel deploy) | One-click Vercel rollback | `master-execution-plan.md` rollback decision tree |
| API issue, no DB schema change | One-click Render rollback | Same |
| API issue **with** DB schema change | Apply tested down-migration, then rollback Render deploy; if the migration can't be cleanly reversed, fix-forward instead | Same — **note:** `PROJECT_STATUS.md` §12 states backend hosting is actually on Railway as of PR #7 (2026-07-17), not Render as the architecture doc assumes — this is a **known doc/reality mismatch**, not something to silently reconcile here; treat "Render" in the source doc as "current backend host" until the architecture doc is formally updated |
| Data corruption (bad data, not bad schema) | Supabase point-in-time recovery (§3) | Same |
| Full project loss / Supabase outage in region | Restore latest daily backup or PITR into a new Supabase project in the same or a failover region; requires manual DNS/connection-string cutover | Not explicitly specified in source docs — **UNVERIFIED**, no documented cross-region failover plan exists yet |

### 6.2 Escalation

Not specified in the allowed source files (no on-call rotation, paging tool, or named owner is documented in `final-approved-architecture.md`, `master-execution-plan.md`, or `PROJECT_STATUS.md`). **UNVERIFIED — requires a decision from the team** on who is authorized to trigger a production PITR restore or approve a fix-forward vs. rollback call. Until that's defined, treat any production restore as requiring explicit sign-off from the project owner before execution.

### 6.3 Preconditions before touching production during an incident

1. Confirm the incident is actually data/DB-related (rule out application-layer bugs first — cheaper to fix-forward)
2. Take a fresh manual `pg_dump` (§4) of the current (even if corrupted) state before any restore — you may need to diff or recover specific rows from the pre-restore state later
3. Identify the target recovery timestamp as precisely as possible (check `AuditLog` for the first anomalous entry)
4. Follow §3 or §5 depending on whether PITR or a logical dump is the source
5. Run the full validation checklist (§5.2) before cutover
6. Communicate downtime/cutover window to stakeholders — channel not specified in reviewed docs, **UNVERIFIED**

---

## 7. RTO / RPO Definition

Not explicitly stated as numeric targets in `final-approved-architecture.md` or `master-execution-plan.md` as reviewed for this task — the source docs commit to backup *mechanisms* (daily + PITR) but not to formal recovery-time/recovery-point SLAs. The figures below are **derived, not sourced** from the mechanisms actually committed to, and must be ratified by the project owner before being treated as a real SLA:

| Metric | Derived target | Basis |
|---|---|---|
| **RPO (Recovery Point Objective)** | ≤ the PITR WAL-retention granularity (effectively near-zero — PITR is continuous) for incidents caught quickly; ≤ 24 hours if only the daily snapshot is usable (PITR window exceeded or disabled) | Derived from "automated daily backups with point-in-time recovery" — actual number depends on §3's unverified retention window |
| **RTO (Recovery Time Objective)** | Not derivable from source docs — depends on unverified factors: PITR restore provisioning time for this specific database size (Supabase does not publish a fixed SLA for this), plus manual cutover and validation time (§5.2 checklist) | **UNVERIFIED — requires a dashboard test run (§9) to measure actual restore duration before any RTO number can be trusted** |

**Action item, not yet done:** run one real restore drill and record actual wall-clock time end-to-end (trigger → validated → cut over) to replace the "not derivable" RTO line with a measured number. This is the single most important gap in this runbook as drafted.

---

## 8. Monitoring & Alerting Checklist

Backup-specific monitoring is not currently described as implemented anywhere in the reviewed docs. `PROJECT_STATUS.md` §10 confirms Sentry backend SDK is installed but `SENTRY_DSN` is empty, and no monitoring tool beyond that is wired for infrastructure-level events (backup success/failure is a platform-level event, not something the application code observes).

Checklist of what should exist (mark each as configured once verified — none are confirmed as of this draft):

- [ ] **UNVERIFIED** — Supabase's own backup-failure notifications are enabled (Dashboard → Project Settings → notification preferences, if offered at the current tier)
- [ ] **UNVERIFIED** — An external check confirms daily backup completion (e.g., a scheduled job that queries Supabase's Management API for the latest backup timestamp and alerts if it's stale) — no such job was found in `.github/workflows/` per this task's scope, but a full workflow audit was not performed
- [ ] **UNVERIFIED** — PITR WAL-archiving health/lag is monitored (not just "backup exists" but "continuous recovery is actually current")
- [ ] **UNVERIFIED** — Alert routing target is defined (Slack/email/PagerDuty) — no alerting tool beyond Sentry (DSN unconfigured) appears anywhere in the audited stack
- [ ] Disk/storage growth on the Supabase project is tracked, since backup size and restore time both scale with it — no baseline currently exists in reviewed docs

---

## 9. Quarterly Restore Test Checklist

The architecture doc specifies a **monthly** restoration test as the target cadence (`final-approved-architecture.md`, Part 2: "...monthly restoration test"). This runbook's title task specifies quarterly; treat **quarterly as the floor cadence, monthly as the documented target** — do not silently downgrade the architecture's stated requirement without a formal change request per the project's own governance rule (`.claude/CLAUDE.md`: "Nothing in those documents is open for discovery without a formal change request").

Run this checklist at minimum quarterly, ideally monthly per the architecture doc:

1. [ ] Select the most recent daily automated backup (or a fresh manual `pg_dump`, §4) as the test artifact
2. [ ] Restore it into a disposable target — never staging or production directly, unless staging is explicitly designated disposable for this purpose
3. [ ] Run the full post-restore validation checklist (§5.2)
4. [ ] Record wall-clock restore duration (feeds the RTO measurement gap flagged in §7)
5. [ ] Confirm `prisma migrate status` matches the expected migration count for that backup's timestamp
6. [ ] Spot-check the `AuditLog` hash chain integrity (see §5.2)
7. [ ] Tear down the disposable restore target — do not leave a second copy of production data running indefinitely
8. [ ] Document the test date, artifact used, duration, and pass/fail outcome in this file's §9 log below (append, don't overwrite history)
9. [ ] If any step fails, treat it as a P1/incident-adjacent finding — a restore test failure means the DR plan is currently unproven, not just "a test failed"

### Test log

| Date | Artifact tested | Target | Duration | Result | Notes |
|---|---|---|---|---|---|
| _(none recorded yet)_ | — | — | — | — | This runbook is newly created (2026-07-17); no restore test has been logged against it yet. First entry here is the action item that closes the RTO gap in §7. |

---

## Open items requiring a decision or dashboard confirmation before this runbook is fully operational

1. Confirm Supabase Pro tier + PITR add-on entitlement and retention window on the live production project (§2, §3)
2. Confirm staging project's backup tier — may differ from production (§2)
3. Reconcile the Render-vs-Railway backend hosting mismatch between the architecture doc and current reality, at the source document, not just here (§6.1)
4. Define escalation/ownership for who can authorize a production restore (§6.2)
5. Run one real restore drill to convert the RTO line in §7 from "not derivable" to a measured number
6. Decide and document a retention/deletion policy for manual `pg_dump` artifacts, given they contain PII (§4)
7. Confirm whether any automated `pg_dump` cron already exists in CI — not checked in this pass, out of this task's file-access scope (§4)

---

Ready for review — confirm to proceed to implementation commit.
