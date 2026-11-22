-- POS-PERF-P68 — Force Delete Branch: durable operation, fence, closure records.
--
-- Additive. No row in any existing table is changed, no branch or account is
-- deleted, and nothing is cleaned up. It:
--   * adds ShiftStatus 'terminated' (administrative end by a Force Delete; not a closure);
--   * adds branch_deletion_operations (durable, idempotent Force Delete lifecycle)
--     and branch_closure_items (read-only record of what was left unresolved);
--   * adds the fence columns on branches and the termination columns on
--     shifts and attendance_records;
--   * replaces pos_perf_p67_assert_live_branch so a fenced branch also refuses
--     new operational writes, and locks the branch row FOR SHARE instead of
--     FOR KEY SHARE, so setting the fence waits for writes already in flight
--     and every later write sees it;
--   * guards hold_orders and checkout_attempts with the same trigger.
-- Rollback floor: once any Force Delete has run, the API cannot go below P68
-- (older readers do not know ShiftStatus 'terminated').

ALTER TYPE "ShiftStatus" ADD VALUE IF NOT EXISTS 'terminated';

CREATE TABLE "branch_deletion_operations" (
  "id" TEXT NOT NULL,
  "branch_id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "plan" JSONB NOT NULL,
  "plan_hash" TEXT NOT NULL,
  "step" TEXT,
  "last_error" TEXT,
  "abort_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "branch_deletion_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "branch_deletion_operations_mode_check" CHECK ("mode" IN ('force')),
  CONSTRAINT "branch_deletion_operations_status_check" CHECK ("status" IN ('fenced', 'completed', 'aborted', 'failed'))
);
CREATE INDEX "branch_deletion_operations_branch_id_idx" ON "branch_deletion_operations"("branch_id");
-- One Force Delete in progress per branch.
CREATE UNIQUE INDEX "branch_deletion_operations_one_fenced_per_branch" ON "branch_deletion_operations"("branch_id") WHERE "status" = 'fenced';

CREATE TABLE "branch_closure_items" (
  "id" TEXT NOT NULL,
  "operation_id" TEXT NOT NULL,
  "branch_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "source_table" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "recorded_by" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reconciled_at" TIMESTAMP(3),
  "reconciled_by" TEXT,
  "reconciliation_note" TEXT,
  CONSTRAINT "branch_closure_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "branch_closure_items_operation_id_kind_source_id_key" ON "branch_closure_items"("operation_id", "kind", "source_id");
CREATE INDEX "branch_closure_items_branch_id_reconciled_at_idx" ON "branch_closure_items"("branch_id", "reconciled_at");

ALTER TABLE "branches" ADD COLUMN "deletion_fenced_at" TIMESTAMP(3), ADD COLUMN "deletion_operation_id" TEXT;
ALTER TABLE "shifts" ADD COLUMN "terminated_at" TIMESTAMP(3), ADD COLUMN "termination_operation_id" TEXT;
ALTER TABLE "attendance_records" ADD COLUMN "administratively_terminated_at" TIMESTAMP(3), ADD COLUMN "termination_operation_id" TEXT;

ALTER TABLE "branch_deletion_operations" ADD CONSTRAINT "branch_deletion_operations_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_deletion_operations" ADD CONSTRAINT "branch_deletion_operations_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_closure_items" ADD CONSTRAINT "branch_closure_items_operation_id_fkey"
  FOREIGN KEY ("operation_id") REFERENCES "branch_deletion_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_closure_items" ADD CONSTRAINT "branch_closure_items_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branch_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_closure_items" ADD CONSTRAINT "branch_closure_items_recorded_by_fkey"
  FOREIGN KEY ("recorded_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "branch_closure_items" ADD CONSTRAINT "branch_closure_items_reconciled_by_fkey"
  FOREIGN KEY ("reconciled_by") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_termination_operation_id_fkey"
  FOREIGN KEY ("termination_operation_id") REFERENCES "branch_deletion_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_termination_operation_id_fkey"
  FOREIGN KEY ("termination_operation_id") REFERENCES "branch_deletion_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Closure items are evidence: never deleted, and only the reconciliation
-- fields may be set, once.
CREATE FUNCTION "pos_perf_p68_closure_items_protect"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POS_PERF_P68_CLOSURE_ITEM_IMMUTABLE: closure items are kept permanently' USING ERRCODE = 'raise_exception';
  END IF;
  IF OLD."reconciled_at" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
     OR NEW."branch_id" IS DISTINCT FROM OLD."branch_id" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."source_table" IS DISTINCT FROM OLD."source_table" OR NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot" OR NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by"
     OR NEW."recorded_at" IS DISTINCT FROM OLD."recorded_at"
     OR NEW."reconciled_at" IS NULL OR NEW."reconciled_by" IS NULL THEN
    RAISE EXCEPTION 'POS_PERF_P68_CLOSURE_ITEM_IMMUTABLE: % can only be reconciled once', OLD."id" USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pos_perf_p68_closure_items_protect" BEFORE UPDATE OR DELETE ON "branch_closure_items"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p68_closure_items_protect"();

-- Live-branch guard, now also refusing a fenced branch. FOR SHARE conflicts
-- with the fence UPDATE (FOR NO KEY UPDATE), so the fence waits for every
-- guarded write already in flight, and a write that starts after it
-- re-reads the row and sees the fence. A distinct message lets the API tell
-- "being deleted" (the operation may still be aborted) from "deleted".
CREATE OR REPLACE FUNCTION "pos_perf_p67_assert_live_branch"(target TEXT, table_name TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  fenced TIMESTAMP(3);
BEGIN
  SELECT "deletion_fenced_at" INTO fenced FROM "branches" WHERE "id" = target FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS_PERF_P67_BRANCH_DELETED: branch % has been deleted; % cannot be written for it', target, table_name
      USING ERRCODE = 'raise_exception';
  END IF;
  IF fenced IS NOT NULL THEN
    RAISE EXCEPTION 'POS_PERF_P68_BRANCH_DELETION_IN_PROGRESS: branch % is being deleted; % cannot be written for it', target, table_name
      USING ERRCODE = 'raise_exception';
  END IF;
END;
$$;

CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "hold_orders" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "checkout_attempts" FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();
