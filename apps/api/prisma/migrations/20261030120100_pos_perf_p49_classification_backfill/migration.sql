-- POS-PERF-P49 — classification backfill + FK validation.
--
-- 1. Existing products keep their meaning: is_seasonal = true -> 'seasonal',
--    everything else stays at the column default 'regular'. Only the new
--    column is written; prices, status, availability, ever_published and
--    version are untouched (no updated_at bump either: this is not an edit).
--    Idempotent; also the reconciliation step after a deploy overlap in
--    which an older API instance changed is_seasonal without classification
--    (see the runbook §5).
UPDATE "products"
SET "classification" = 'seasonal'
WHERE "is_seasonal" = true AND "classification" = 'regular';

-- 2. Validate the NOT VALID foreign key from 20261030120000. Takes SHARE
--    UPDATE EXCLUSIVE on transaction_items, which does not block checkout
--    inserts. Every pre-P49 row has promotion_id NULL.
ALTER TABLE "transaction_items" VALIDATE CONSTRAINT "transaction_items_promotion_id_fkey";
