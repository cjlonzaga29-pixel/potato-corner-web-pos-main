-- POS-PERF-P60 — supervisor-created expense types. Additive only.
--
-- No existing row is written and nothing is backfilled: nothing about a past
-- expense says reliably which type it belongs to, so expenses.expense_type_id
-- stays NULL on all of them, which means "legacy, read through category". An older
-- API keeps writing category and what it writes stays correct.

CREATE TABLE "expense_types" (
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

    CONSTRAINT "expense_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expense_types_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 60),
    -- The application computes normalized_name (normalizeExpenseTypeName); these
    -- refuse a value that can't have come from it.
    CONSTRAINT "expense_types_normalized_name_check" CHECK (
        "normalized_name" <> '' AND "normalized_name" = btrim("normalized_name") AND "normalized_name" = lower("normalized_name")
    ),
    -- These name the ledger's own views.
    CONSTRAINT "expense_types_reserved_name_check" CHECK ("normalized_name" NOT IN ('all', 'all expenses', 'legacy', 'unassigned'))
);

-- The composite FK target for expense_type_branches.
CREATE UNIQUE INDEX "expense_types_id_normalized_name_is_active_key" ON "expense_types"("id", "normalized_name", "is_active");

CREATE TABLE "expense_type_branches" (
    "expense_type_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL,

    CONSTRAINT "expense_type_branches_pkey" PRIMARY KEY ("expense_type_id", "branch_id")
);

CREATE INDEX "expense_type_branches_branch_id_idx" ON "expense_type_branches"("branch_id");

-- One ACTIVE type per name per branch. This is what decides concurrent creates,
-- renames and reactivations: the composite FK below cascades both columns here,
-- so a rename that collides fails in its own statement. Partial, because a
-- deactivated type keeps its name and the name can be reused. Raw SQL: Prisma's
-- schema DSL cannot express a WHERE-clause index.
CREATE UNIQUE INDEX "expense_type_branches_active_name_key" ON "expense_type_branches"("branch_id", "normalized_name") WHERE "is_active";

ALTER TABLE "expense_types" ADD CONSTRAINT "expense_types_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_types" ADD CONSTRAINT "expense_types_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "expense_type_branches" ADD CONSTRAINT "expense_type_branches_expense_type_id_normalized_name_is_a_fkey" FOREIGN KEY ("expense_type_id", "normalized_name", "is_active") REFERENCES "expense_types"("id", "normalized_name", "is_active") ON DELETE CASCADE ON UPDATE CASCADE;
-- Cascade, as expenses.branch_id already is: permanently deleting a branch keeps working.
ALTER TABLE "expense_type_branches" ADD CONSTRAINT "expense_type_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable with no default, so no table rewrite. The FK and CHECK are NOT VALID here
-- and validated in the next migration, which doesn't block reads of expenses.
ALTER TABLE "expenses" ADD COLUMN "expense_type_id" TEXT;
ALTER TABLE "expenses" ADD COLUMN "expense_type_name" TEXT;
CREATE INDEX "expenses_expense_type_id_incurred_at_idx" ON "expenses"("expense_type_id", "incurred_at");
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_expense_type_id_fkey" FOREIGN KEY ("expense_type_id") REFERENCES "expense_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
-- A typed expense always carries the name it was recorded under.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_expense_type_name_check" CHECK (("expense_type_id" IS NULL) = ("expense_type_name" IS NULL)) NOT VALID;

ALTER TABLE "expense_idempotency_keys" ADD COLUMN "request_hash" TEXT;
