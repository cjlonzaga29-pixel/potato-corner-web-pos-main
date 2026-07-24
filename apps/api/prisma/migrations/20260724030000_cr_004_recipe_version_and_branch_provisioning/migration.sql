-- CR-004 (POS Deduction Integrity & Branch Provisioning)
-- See docs/decisions/CR-004-pos-deduction-integrity.md

-- Bumped on every master Recipe update; snapshotted onto TransactionItem.recipeVersion at sale time.
ALTER TABLE "recipes" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Frozen recipe-version snapshot per sold line item (defaults to 1 for historical rows).
ALTER TABLE "transaction_items" ADD COLUMN "recipe_version" INTEGER NOT NULL DEFAULT 1;
