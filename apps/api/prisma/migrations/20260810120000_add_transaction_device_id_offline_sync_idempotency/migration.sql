-- Task 209.47: offline sale idempotency. A queued offline sale can be
-- retried/resynced by the client (dropped connection, tab closed before the
-- 'synced' ack arrived) — nothing before this migration stops that retry
-- from creating a second Transaction row (second receipt, second inventory
-- deduction) for the same real sale. The DB becomes the final authority via
-- a composite unique index on (branch_id, device_id, offline_provisional_number).
--
-- device_id is new in this migration and is NULL on every existing row, and
-- Postgres never treats two NULLs as equal for uniqueness purposes -- so the
-- new index cannot conflict with any pre-existing data. The duplicate-check
-- guard below is still run first, defensively, in case this migration is
-- ever adapted to backfill device_id from another source later.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "device_id" TEXT;

-- Duplicate-precondition guard: fail the migration loudly instead of
-- silently deleting/merging rows if any (branch_id, device_id,
-- offline_provisional_number) triple with both device_id and
-- offline_provisional_number non-null is already duplicated. Cannot fire
-- today (device_id was just added as all-NULL above) -- this exists so a
-- future edit of this migration (e.g. adding a backfill step) fails fast
-- instead of silently violating the invariant.
DO $$
DECLARE
  duplicate_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT branch_id, device_id, offline_provisional_number
    FROM "transactions"
    WHERE device_id IS NOT NULL AND offline_provisional_number IS NOT NULL
    GROUP BY branch_id, device_id, offline_provisional_number
    HAVING COUNT(*) > 1
  ) dupes;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Task 209.47 migration aborted: % duplicate (branch_id, device_id, offline_provisional_number) group(s) already exist in transactions -- resolve manually before adding the unique index', duplicate_count;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "transactions_branch_device_offline_number_key" ON "transactions"("branch_id", "device_id", "offline_provisional_number");
