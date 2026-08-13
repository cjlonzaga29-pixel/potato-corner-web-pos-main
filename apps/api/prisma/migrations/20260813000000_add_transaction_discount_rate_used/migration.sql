-- Task 209.xx: configurable existing POS discount rates. Every completed
-- transaction must snapshot the actual discount percentage applied at
-- checkout time (transactions.service.ts computeAmounts), independent of
-- whatever a supervisor later changes the configured PWD/Senior/Employee/
-- Promotional rate to in Discount Settings. Without this column, receipts
-- and the Discount Compliance report would have no way to show a sale's
-- true historical rate once the setting changes.
--
-- Nullable, no backfill: every existing row predates this feature and never
-- had a "rate used" concept — NULL correctly means "unknown/legacy", never
-- "0%". New transactions always populate it going forward.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "discount_rate_used" DECIMAL(5,2);
