-- TASK 93: persist which Product Options a customer actually chose per
-- transaction line, so it survives to the API response and receipt. Mirrors
-- selected_flavors (added in 20260724183216) -- a nullable JSONB snapshot
-- column, additive only, no backfill needed for historical rows.
ALTER TABLE "transaction_items" ADD COLUMN     "selected_options" JSONB;
