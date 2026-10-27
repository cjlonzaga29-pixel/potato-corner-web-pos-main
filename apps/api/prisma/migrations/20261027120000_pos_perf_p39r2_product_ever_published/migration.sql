-- POS-PERF-P39R2 — products.ever_published: "has successfully been available
-- on POS at least once" (status 'active' with at least one
-- branch_product_availability row on — the POS catalog's predicate at some
-- branch). Monotonic: the API sets it in the same transaction as the write
-- that makes a product live and never clears it.
--
-- Additive only: one column with a constant default (a metadata-only change,
-- no table rewrite) and one maintenance function; the next migration
-- backfills. No existing row other than products.ever_published itself, and
-- no constraint, is changed. An older API ignores the column and its inserts
-- get the default.
--
-- The backfill can only set the marker where surviving evidence proves a
-- product was live; it cannot reconstruct lost history and never dates it.
-- The same function is the reconciliation step after a deploy overlap (old
-- instances can still make products live without setting the marker):
--   SELECT pos_backfill_product_ever_published();
-- It is idempotent and only ever sets false -> true. See
-- docs/runbooks/pos-perf-p39-product-ui-consistency.md §8.

-- AlterTable
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "ever_published" BOOLEAN NOT NULL DEFAULT false;

-- Evidence, all of it from rows that only exist after a committed change:
--   1. Live now: status 'active' and a branch row on.
--   2. A branch row turned on while the product's status was 'active':
--      PRODUCT_BRANCH_AVAILABILITY_CHANGED with after_state.isAvailable = true
--      (publication, per-branch and bulk enable, branch-scoped status change),
--      or PRODUCT_REPLACED_AT_BRANCH for the copy it turned on.
--   3. A PRODUCT_STATUS_CHANGED to 'active' while one of its rows was on.
-- The status at a moment is the after_state of the last status change at or
-- before it, else the before_state of the first one after it, else the
-- current status. A row's state at a moment is its last row fact at or before
-- it (an off fact wins a tie); the removal cascade turns every row off.
-- Not evidence: deactivation events, PRODUCT_UPDATED and other generic
-- updates, the creator, lifecycle 'active' on its own, the restore cascade
-- entry (it does not record whether it turned anything on), and anything for
-- a product whose status is 'draft' now (no transition returns to draft).
-- Events come from audit_logs and audit_outbox in any delivery status; an
-- audit_logs row the outbox delivered (after_state.audit_event_id names an
-- outbox row) is skipped in favour of that outbox row, whose occurred_at is
-- the time of the change rather than of delivery.
CREATE OR REPLACE FUNCTION pos_backfill_product_ever_published(batch_size integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  marked integer := 0;
  updated integer;
  last_id text := '';
  batch_ids text[];
BEGIN
  DROP TABLE IF EXISTS pg_temp.p39r2_events, pg_temp.p39r2_row_facts, pg_temp.p39r2_status_facts, pg_temp.p39r2_evidence;

  CREATE TEMP TABLE p39r2_events ON COMMIT DROP AS
  SELECT l.action, l.entity_id, l.branch_id, l.before_state, l.after_state, l.created_at AS at
  FROM audit_logs l
  WHERE ((l.entity_type = 'branch_product_availability' AND l.action = 'PRODUCT_BRANCH_AVAILABILITY_CHANGED')
      OR (l.entity_type = 'product' AND l.action IN ('PRODUCT_STATUS_CHANGED', 'PRODUCT_REPLACED_AT_BRANCH', 'PRODUCT_CATALOG_REMOVAL_CASCADE')))
    AND NOT EXISTS (SELECT 1 FROM audit_outbox o WHERE o.event_key = l.after_state ->> 'audit_event_id')
  UNION ALL
  SELECT o.action, o.entity_id, o.branch_id, o.before_state, o.after_state, o.occurred_at
  FROM audit_outbox o
  WHERE (o.entity_type = 'branch_product_availability' AND o.action = 'PRODUCT_BRANCH_AVAILABILITY_CHANGED')
     OR (o.entity_type = 'product' AND o.action IN ('PRODUCT_STATUS_CHANGED', 'PRODUCT_REPLACED_AT_BRANCH', 'PRODUCT_CATALOG_REMOVAL_CASCADE'));
  -- Without statistics the planner joins a large event set to the availability rows by nested loop (21.7 s instead of 0.4 s at 200k events).
  ANALYZE p39r2_events;

  -- branch_id NULL = every branch (the removal cascade).
  CREATE TEMP TABLE p39r2_row_facts ON COMMIT DROP AS
  SELECT r.product_id, r.branch_id, e.at, (e.after_state -> 'isAvailable') = 'true'::jsonb AS is_on
  FROM p39r2_events e
  JOIN branch_product_availability r ON r.id = e.entity_id
  WHERE e.action = 'PRODUCT_BRANCH_AVAILABILITY_CHANGED' AND jsonb_typeof(e.after_state -> 'isAvailable') = 'boolean'
  UNION ALL
  SELECT e.entity_id, e.branch_id, e.at, true
  FROM p39r2_events e
  WHERE e.action = 'PRODUCT_REPLACED_AT_BRANCH' AND e.branch_id IS NOT NULL AND (e.after_state -> 'copyAvailableAtBranch') = 'true'::jsonb
  UNION ALL
  SELECT e.after_state ->> 'sourceProductId', e.branch_id, e.at, false
  FROM p39r2_events e
  WHERE e.action = 'PRODUCT_REPLACED_AT_BRANCH' AND e.branch_id IS NOT NULL AND e.after_state ->> 'sourceProductId' IS NOT NULL
  UNION ALL
  SELECT e.entity_id, NULL, e.at, false
  FROM p39r2_events e
  WHERE e.action = 'PRODUCT_CATALOG_REMOVAL_CASCADE';
  CREATE INDEX ON p39r2_row_facts (product_id, at);

  CREATE TEMP TABLE p39r2_status_facts ON COMMIT DROP AS
  SELECT e.entity_id AS product_id, e.at, e.before_state ->> 'status' AS before_status, e.after_state ->> 'status' AS after_status
  FROM p39r2_events e
  WHERE e.action = 'PRODUCT_STATUS_CHANGED';
  CREATE INDEX ON p39r2_status_facts (product_id, at);
  ANALYZE p39r2_row_facts;
  ANALYZE p39r2_status_facts;

  CREATE TEMP TABLE p39r2_evidence ON COMMIT DROP AS
  SELECT p.id
  FROM products p
  WHERE p.ever_published = false
    AND p.status <> 'draft'
    AND (
      -- 1. Live now.
      (p.status = 'active' AND EXISTS (SELECT 1 FROM branch_product_availability r WHERE r.product_id = p.id AND r.is_available))
      -- 2. A row turned on while the product was active.
      OR EXISTS (
        SELECT 1
        FROM p39r2_row_facts f
        WHERE f.product_id = p.id
          AND f.is_on
          AND COALESCE(
            (SELECT s.after_status FROM p39r2_status_facts s WHERE s.product_id = p.id AND s.at <= f.at ORDER BY s.at DESC LIMIT 1),
            (SELECT s.before_status FROM p39r2_status_facts s WHERE s.product_id = p.id AND s.at > f.at ORDER BY s.at ASC LIMIT 1),
            p.status::text
          ) = 'active'
      )
      -- 3. Made active while a row was on.
      OR EXISTS (
        SELECT 1
        FROM p39r2_status_facts s
        WHERE s.product_id = p.id
          AND s.after_status = 'active'
          AND EXISTS (
            SELECT 1
            FROM (SELECT DISTINCT b.branch_id FROM p39r2_row_facts b WHERE b.product_id = p.id AND b.branch_id IS NOT NULL) known
            WHERE (
              SELECT f.is_on
              FROM p39r2_row_facts f
              WHERE f.product_id = p.id AND (f.branch_id = known.branch_id OR f.branch_id IS NULL) AND f.at <= s.at
              ORDER BY f.at DESC, f.is_on ASC
              LIMIT 1
            )
          )
      )
    );

  -- Keyset batches over the evidence, so each UPDATE touches at most
  -- batch_size products. false -> true only: safe beside a live API that
  -- sets the marker itself, and safe to run again.
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch_ids
    FROM (SELECT e.id FROM p39r2_evidence e WHERE e.id > last_id ORDER BY e.id LIMIT batch_size) next_batch;
    EXIT WHEN batch_ids IS NULL;
    UPDATE products SET ever_published = true WHERE id = ANY (batch_ids) AND ever_published = false;
    GET DIAGNOSTICS updated = ROW_COUNT;
    marked := marked + updated;
    last_id := batch_ids[array_length(batch_ids, 1)];
  END LOOP;

  DROP TABLE IF EXISTS pg_temp.p39r2_events, pg_temp.p39r2_row_facts, pg_temp.p39r2_status_facts, pg_temp.p39r2_evidence;
  RETURN marked;
END;
$$;

-- The backfill runs in the next migration (20261027120100), not here: ADD
-- COLUMN holds an ACCESS EXCLUSIVE lock on products until this migration
-- commits, which would block every catalog read and checkout for as long as
-- the backfill takes.
