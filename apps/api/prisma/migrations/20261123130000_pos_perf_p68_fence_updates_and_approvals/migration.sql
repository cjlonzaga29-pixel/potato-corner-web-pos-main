-- POS-PERF-P68 follow-up (multi-process race verification). Additive: no row
-- is changed, no table or column is added, nothing existing is replaced.
--
-- 1. Inventory approval requests are now guarded like every other branch
--    write. Before this, a count or correction could be submitted for a
--    fenced branch (making Force Delete abort), or committed between the
--    finalize plan read and its commit, leaving a PENDING request on a
--    deleted branch with no closure item.
CREATE TRIGGER "pos_perf_p67_live_branch" BEFORE INSERT OR UPDATE OF "branch_id" ON "inventory_approval_requests"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p67_require_live_branch"();

-- 2. The fence also refuses status-only writes that never insert a guarded
--    row: a void of a sale whose deduction is still pending (sale status,
--    job cancel, reservation release), or a stock quantity change. It only
--    refuses while the branch row exists AND is fenced: history of an
--    already-deleted branch is not affected, and Force Delete finalize never
--    updates these columns (it terminates shifts, attendance, checkout
--    attempts, jobs and approvals, then deletes the branch). FOR SHARE makes
--    the fence wait for such writes already in flight, as for inserts.
CREATE FUNCTION "pos_perf_p68_refuse_fenced_branch_update"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fenced TIMESTAMP(3);
BEGIN
  SELECT "deletion_fenced_at" INTO fenced FROM "branches" WHERE "id" = NEW."branch_id" FOR SHARE;
  IF FOUND AND fenced IS NOT NULL THEN
    RAISE EXCEPTION 'POS_PERF_P68_BRANCH_DELETION_IN_PROGRESS: branch % is being deleted; % cannot be written for it', NEW."branch_id", TG_TABLE_NAME
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pos_perf_p68_fenced_update" BEFORE UPDATE OF "status" ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p68_refuse_fenced_branch_update"();
CREATE TRIGGER "pos_perf_p68_fenced_update" BEFORE UPDATE OF "quantity_on_hand", "quantity_reserved" ON "inventory_stocks"
  FOR EACH ROW EXECUTE FUNCTION "pos_perf_p68_refuse_fenced_branch_update"();
