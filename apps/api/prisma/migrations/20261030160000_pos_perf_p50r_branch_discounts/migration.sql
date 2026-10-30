-- POS-PERF-P50R — cashier-selected custom discounts and a per-sale tax snapshot.
-- See docs/runbooks/pos-perf-p50-vat-settings-and-calculation-review.md §11.
--
-- Additive only, no backfill:
--   * promotions.application_mode has a constant default ('automatic'), so
--     every existing promotion keeps its P49 behavior (metadata-only on
--     PostgreSQL 11+, no rewrite of a small table).
--   * transactions.tax_snapshot is nullable with no default: metadata-only,
--     no scan of the checkout hot table, existing sales stay NULL (they keep
--     reading their stored amounts, as before).
-- Branch discount overrides and branch VAT registration are SystemSetting
-- rows (existing table), so they need no schema change.
-- An older API ignores both columns: its inserts leave tax_snapshot NULL,
-- but it does not know application_mode, so it would treat a
-- cashier_selected discount as automatic. Before rolling the API back,
-- disable every cashier_selected discount (runbook §11 rollback step).

-- CreateEnum
CREATE TYPE "PromotionApplicationMode" AS ENUM ('automatic', 'cashier_selected');

-- AlterTable
ALTER TABLE "promotions" ADD COLUMN "application_mode" "PromotionApplicationMode" NOT NULL DEFAULT 'automatic';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "tax_snapshot" JSONB;
