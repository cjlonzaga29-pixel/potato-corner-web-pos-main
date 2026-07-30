# Rollback: 20260731000000_add_shift_review

Status: migration has **not** been applied to any database. This document is
prepared in advance so a rollback procedure exists before the migration is
ever run. Do not execute anything in this document unless the migration has
actually been applied and a rollback is genuinely needed.

## What this migration does

Additive only:

- `CREATE TYPE "ShiftReviewPhase"` (`opening`, `closing`)
- `CREATE TYPE "ShiftReviewStatus"` (`pending`, `approved`, `rejected`)
- `CREATE TABLE "shift_reviews"` with FKs to `shifts` (`ON DELETE CASCADE`) and
  `users` (`ON DELETE SET NULL`)
- Indexes on `shift_id`, `status`, `phase`, `reviewed_by`, `created_at`, plus a
  unique index on `(shift_id, phase)`
- A backfill `INSERT ... SELECT` that creates two `pending` rows (`opening`,
  `closing`) for every pre-existing row in `shifts`

No existing table is altered, no column is dropped, and no existing data is
rewritten. `shift_reviews` is a brand-new table — the entire risk surface of
a rollback is deleting rows from that one table.

## Before rolling back: verification query

Run this first to see exactly what would be lost. If `approved_or_rejected`
is non-zero, review records — including reviewer identity, notes, and
timestamps — will be permanently destroyed by the rollback below.

```sql
SELECT
  count(*) AS total_rows,
  count(*) FILTER (WHERE status = 'pending') AS pending,
  count(*) FILTER (WHERE status IN ('approved', 'rejected')) AS approved_or_rejected,
  min(created_at) AS earliest_row,
  max(reviewed_at) AS latest_review
FROM shift_reviews;
```

## Backup requirement

**Do not run the rollback against production without a fresh backup or
export of `shift_reviews` first.** A backup is mandatory, not optional, if
`approved_or_rejected` above is greater than zero.

```sql
-- Snapshot the table before dropping anything
CREATE TABLE shift_reviews_backup_20260731 AS TABLE shift_reviews;
```

Confirm the snapshot row count matches `total_rows` from the verification
query before proceeding.

## Rollback order

Foreign keys and indexes are dropped implicitly when their owning table is
dropped, so the only required statements are:

```sql
-- 1. Drop the table (also drops its FKs, PK, and all five indexes)
DROP TABLE IF EXISTS "shift_reviews";

-- 2. Drop the enum types — ONLY if no other table/column still references them.
--    Neither type is used anywhere else in this schema today, but re-check
--    with the query below before dropping in case a later migration added
--    a second consumer.
DROP TYPE IF EXISTS "ShiftReviewStatus";
DROP TYPE IF EXISTS "ShiftReviewPhase";
```

Check for other consumers of the enum types before the `DROP TYPE` step:

```sql
SELECT c.relname AS table_name, a.attname AS column_name
FROM pg_attribute a
JOIN pg_class c ON a.attrelid = c.oid
JOIN pg_type t ON a.atttypid = t.oid
WHERE t.typname IN ('ShiftReviewPhase', 'ShiftReviewStatus')
  AND c.relname <> 'shift_reviews';
```

If this returns any rows, stop — do not drop the type, only the table.

## Warning

**Rolling back deletes every review record**: who approved or rejected each
shift's opening/closing count, their notes, and when they did it. This is
audit trail data. Once dropped, it is unrecoverable except from the backup
table created above (or a database snapshot). Treat this as a destructive
action requiring the same sign-off as any other production data deletion,
not a routine migration revert.

## After rollback

Also revert the application code that depends on `shift_reviews`
(`cash.repository.ts`'s `createShift` review-row creation, `reviewShift`,
`listPendingReviews`, the `/review/:phase` and `/reviews` routes, and the
`ShiftReview*` web components) — leaving the code deployed against a dropped
table will turn every shift-open and every review action into a 500 error.
