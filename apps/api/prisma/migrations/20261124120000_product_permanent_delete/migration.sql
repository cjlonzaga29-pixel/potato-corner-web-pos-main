-- Product permanent delete — history keeps its own product identity.
--
-- Before: transaction_items, hold_order_items and product_change_logs held
-- RESTRICT foreign keys to products/product_variants, so a product that was
-- ever sold, held or edited through the builder could not be deleted at all.
--
-- After:
-- * Those five foreign keys are dropped. The columns stay exactly as they are:
--   every existing row keeps its original product_id/product_variant_id (the
--   historical identity), next to the name/price/deduction snapshots that
--   receipts, refunds, voids and reports already read. No row is changed.
-- * New rows still need a live product. A BEFORE INSERT (or id change) trigger
--   locks the products and product_variants rows FOR KEY SHARE, exactly as a
--   foreign-key check would, so a sale or hold racing a delete either commits
--   first (and the delete waits for it) or waits for the delete and then fails
--   with PRODUCT_PERMANENTLY_DELETED instead of a bare 500.
-- * raise_exception (P0001), not foreign_key_violation: Prisma reports a 23503
--   as a generic P2003 without the message, and the API must tell this apart
--   (same reasoning as POS-PERF-P67's live-branch guard).
-- * hold_order_items gets an index on product_id for the delete's held-order check.
--
-- NOT additive: it removes five foreign keys and replaces their insert half with
-- triggers (the delete half is restored by 20261124130000_product_delete_history_guard).
-- No data is rewritten and no product is deleted here.
-- Rollback constraint: once any product has been permanently deleted, these
-- foreign keys cannot be re-added (history rows name ids that no longer exist).

ALTER TABLE "transaction_items" DROP CONSTRAINT "transaction_items_product_id_fkey";
ALTER TABLE "transaction_items" DROP CONSTRAINT "transaction_items_product_variant_id_fkey";
ALTER TABLE "hold_order_items" DROP CONSTRAINT "hold_order_items_product_id_fkey";
ALTER TABLE "hold_order_items" DROP CONSTRAINT "hold_order_items_product_variant_id_fkey";
ALTER TABLE "product_change_logs" DROP CONSTRAINT "product_change_logs_product_variant_id_fkey";

CREATE INDEX "hold_order_items_product_id_idx" ON "hold_order_items"("product_id");

CREATE FUNCTION "product_delete_assert_live_product"(product TEXT, variant TEXT, table_name TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF product IS NOT NULL THEN
    PERFORM 1 FROM "products" WHERE "id" = product FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_PERMANENTLY_DELETED: product % no longer exists; % cannot be written for it', product, table_name
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  IF variant IS NOT NULL THEN
    PERFORM 1 FROM "product_variants" WHERE "id" = variant FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_PERMANENTLY_DELETED: product variant % no longer exists; % cannot be written for it', variant, table_name
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION "product_delete_require_live_line"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
     OR NEW."product_variant_id" IS DISTINCT FROM OLD."product_variant_id" THEN
    PERFORM "product_delete_assert_live_product"(NEW."product_id", NEW."product_variant_id", TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "product_delete_require_live_variant"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."product_variant_id" IS DISTINCT FROM OLD."product_variant_id" THEN
    PERFORM "product_delete_assert_live_product"(NULL, NEW."product_variant_id", TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "product_delete_live_product" BEFORE INSERT OR UPDATE OF "product_id", "product_variant_id" ON "transaction_items" FOR EACH ROW EXECUTE FUNCTION "product_delete_require_live_line"();
CREATE TRIGGER "product_delete_live_product" BEFORE INSERT OR UPDATE OF "product_id", "product_variant_id" ON "hold_order_items" FOR EACH ROW EXECUTE FUNCTION "product_delete_require_live_line"();
CREATE TRIGGER "product_delete_live_product" BEFORE INSERT OR UPDATE OF "product_variant_id" ON "product_change_logs" FOR EACH ROW EXECUTE FUNCTION "product_delete_require_live_variant"();
