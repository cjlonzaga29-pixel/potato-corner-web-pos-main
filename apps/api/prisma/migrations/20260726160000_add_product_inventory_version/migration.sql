-- Bumped on every ProductInventory update; source for TransactionItem.recipeVersion once transactions.service.ts is switched over.
ALTER TABLE "product_inventory" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
