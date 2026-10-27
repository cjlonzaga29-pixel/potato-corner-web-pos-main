-- POS-PERF-P39R2 — backfill products.ever_published from surviving evidence
-- (see pos_backfill_product_ever_published in 20261027120000). Its own
-- migration so that it runs after the previous one has committed and
-- released ADD COLUMN's ACCESS EXCLUSIVE lock on products: this one only
-- reads audit_logs, audit_outbox and branch_product_availability and takes
-- row locks only on the products it marks (false -> true): reads, including
-- the POS catalog and checkout, never wait for it, and a write to one of those
-- product rows waits at most until it commits. Idempotent; it is also the
-- reconciliation step after a deploy overlap.
SELECT pos_backfill_product_ever_published();
