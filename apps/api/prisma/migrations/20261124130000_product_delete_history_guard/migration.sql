-- Product permanent delete, part 2 — history guard for every other delete path.
--
-- 20261124120000_product_permanent_delete dropped five foreign keys
-- (transaction_items.product_id / product_variant_id, hold_order_items.product_id /
-- product_variant_id, product_change_logs.product_variant_id). That also removed
-- the only thing that stopped ANY other delete of a product or size with history:
-- the API version deployed before this release still runs a plain
-- `DELETE /api/products/:id` cascade and a size delete with no history check, so
-- during a rollout (old instance still serving) or after a code rollback it could
-- remove a sold or held product with none of the permanent-delete checks, locks
-- or audit.
--
-- This migration puts the refusal back in the database for every path except the
-- audited permanent delete:
-- * BEFORE DELETE on products and product_variants: when the row is still named
--   by a sale line, held-order line or (for a size) a change log, the delete is
--   refused with SQLSTATE 23503 (foreign_key_violation) and the original
--   constraint name. Prisma reports that as P2003, exactly what the dropped
--   foreign keys raised, so the old API keeps answering 409
--   PRODUCT_HAS_DEPENDENCIES / VARIANT_HAS_DEPENDENCIES as before.
-- * The check runs after the row is locked by the DELETE itself, so a sale line
--   inserted concurrently (its live-product trigger holds FOR KEY SHARE on the
--   row) is committed and seen, as with a real foreign key.
-- * Only the permanent-delete transaction bypasses it, by setting the
--   transaction-local `pc.product_permanent_delete` to 'on' after its own
--   authority and blocker checks (set_config(..., true) ends with the
--   transaction, so it works through the transaction pooler and never leaks).
-- * New sale and held-order lines must also name a size that belongs to the line's
--   product. The checkout and hold paths already enforce this; the database now
--   does too, for new rows only (historical rows are never re-checked).
--
-- No data is changed. Indexes used: transaction_items(product_variant_id),
-- hold_order_items(product_id), product_change_logs(product_variant_id, version).
-- The two unindexed checks (transaction_items.product_id, hold_order_items.
-- product_variant_id) cost what the dropped foreign keys' checks cost.

CREATE FUNCTION "product_delete_guard_history"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('pc.product_permanent_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'products' THEN
    IF EXISTS (SELECT 1 FROM "transaction_items" WHERE "product_id" = OLD."id") THEN
      RAISE EXCEPTION 'update or delete on table "products" violates foreign key constraint "transaction_items_product_id_fkey" on table "transaction_items"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'transaction_items_product_id_fkey', TABLE = 'transaction_items';
    END IF;
    IF EXISTS (SELECT 1 FROM "hold_order_items" WHERE "product_id" = OLD."id") THEN
      RAISE EXCEPTION 'update or delete on table "products" violates foreign key constraint "hold_order_items_product_id_fkey" on table "hold_order_items"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'hold_order_items_product_id_fkey', TABLE = 'hold_order_items';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "transaction_items" WHERE "product_variant_id" = OLD."id") THEN
      RAISE EXCEPTION 'update or delete on table "product_variants" violates foreign key constraint "transaction_items_product_variant_id_fkey" on table "transaction_items"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'transaction_items_product_variant_id_fkey', TABLE = 'transaction_items';
    END IF;
    IF EXISTS (SELECT 1 FROM "hold_order_items" WHERE "product_variant_id" = OLD."id") THEN
      RAISE EXCEPTION 'update or delete on table "product_variants" violates foreign key constraint "hold_order_items_product_variant_id_fkey" on table "hold_order_items"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'hold_order_items_product_variant_id_fkey', TABLE = 'hold_order_items';
    END IF;
    IF EXISTS (SELECT 1 FROM "product_change_logs" WHERE "product_variant_id" = OLD."id") THEN
      RAISE EXCEPTION 'update or delete on table "product_variants" violates foreign key constraint "product_change_logs_product_variant_id_fkey" on table "product_change_logs"'
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'product_change_logs_product_variant_id_fkey', TABLE = 'product_change_logs';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "product_delete_guard_history" BEFORE DELETE ON "products" FOR EACH ROW EXECUTE FUNCTION "product_delete_guard_history"();
CREATE TRIGGER "product_delete_guard_history" BEFORE DELETE ON "product_variants" FOR EACH ROW EXECUTE FUNCTION "product_delete_guard_history"();

-- New lines: live product (unchanged), live size (unchanged), and the size belongs to the product.
CREATE OR REPLACE FUNCTION "product_delete_require_live_line"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
     OR NEW."product_variant_id" IS DISTINCT FROM OLD."product_variant_id" THEN
    PERFORM "product_delete_assert_live_product"(NEW."product_id", NEW."product_variant_id", TG_TABLE_NAME);
    IF NEW."product_id" IS NOT NULL AND NEW."product_variant_id" IS NOT NULL THEN
      PERFORM 1 FROM "product_variants" WHERE "id" = NEW."product_variant_id" AND "product_id" = NEW."product_id";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_VARIANT_MISMATCH: product variant % does not belong to product %; % cannot be written', NEW."product_variant_id", NEW."product_id", TG_TABLE_NAME
          USING ERRCODE = 'raise_exception';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
