-- POS-PERF-P58 — custom product types. Additive only.
--
-- No existing row is written and nothing is backfilled: products.product_type_id
-- is NULL for every built-in assignment, which means "the built-in named by
-- classification". An older API instance keeps writing classification, and what
-- it writes stays correct, so there is nothing to go stale during the overlap.

CREATE TABLE "product_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "deactivated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_types_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 60),
    -- The application computes normalized_name (normalizeProductTypeName); these
    -- refuse a value that can't have come from it.
    CONSTRAINT "product_types_normalized_name_check" CHECK (
        "normalized_name" <> '' AND "normalized_name" = btrim("normalized_name") AND "normalized_name" = lower("normalized_name")
    ),
    -- The built-ins are classification values, not rows; their names stay theirs.
    CONSTRAINT "product_types_reserved_name_check" CHECK ("normalized_name" NOT IN ('regular', 'promotional', 'seasonal'))
);

-- The composite FK target for product_type_branches.
CREATE UNIQUE INDEX "product_types_id_normalized_name_is_active_key" ON "product_types"("id", "normalized_name", "is_active");

CREATE TABLE "product_type_branches" (
    "product_type_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL,

    CONSTRAINT "product_type_branches_pkey" PRIMARY KEY ("product_type_id", "branch_id")
);

CREATE INDEX "product_type_branches_branch_id_idx" ON "product_type_branches"("branch_id");

-- One ACTIVE type per name per branch. This is what decides concurrent creates,
-- renames and reactivations: the composite FK below cascades both columns here,
-- so a rename that collides fails in its own statement. Partial, because a
-- deactivated type keeps its name and the name can be reused. Raw SQL: Prisma's
-- schema DSL cannot express a WHERE-clause index.
CREATE UNIQUE INDEX "product_type_branches_active_name_key" ON "product_type_branches"("branch_id", "normalized_name") WHERE "is_active";

ALTER TABLE "product_types" ADD CONSTRAINT "product_types_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_types" ADD CONSTRAINT "product_types_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_type_branches" ADD CONSTRAINT "product_type_branches_product_type_id_normalized_name_is_a_fkey" FOREIGN KEY ("product_type_id", "normalized_name", "is_active") REFERENCES "product_types"("id", "normalized_name", "is_active") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_type_branches" ADD CONSTRAINT "product_type_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nullable with no default, so no table rewrite. The FK is NOT VALID here and
-- validated in the next migration, which doesn't block checkout's reads.
ALTER TABLE "products" ADD COLUMN "product_type_id" TEXT;
CREATE INDEX "products_product_type_id_idx" ON "products"("product_type_id");
ALTER TABLE "products" ADD CONSTRAINT "products_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
