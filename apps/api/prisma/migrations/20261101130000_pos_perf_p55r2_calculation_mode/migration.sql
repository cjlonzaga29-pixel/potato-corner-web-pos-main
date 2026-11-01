-- POS-PERF-P55R2 — record how each sale's amounts were calculated.
-- Additive: one nullable column with no default (metadata-only, no table
-- rewrite) and a CHECK added NOT VALID (no scan; validated separately in
-- 20261101130100). Existing rows stay NULL = recorded before P55R2, all of
-- them VAT-calculated. No existing value is changed.
ALTER TABLE "transactions" ADD COLUMN "calculation_mode" TEXT;

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_calculation_mode_check"
  CHECK ("calculation_mode" IS NULL OR "calculation_mode" IN ('legacy_vat_v1', 'manual_total_v1'))
  NOT VALID;
