-- Adds an optional cashier-facing POS button label to product_option_groups,
-- distinct from the existing internal admin `name`. When null/blank, POS
-- falls back to `name`. Additive only.

-- AlterTable
ALTER TABLE "product_option_groups" ADD COLUMN "pos_button_label" TEXT;
