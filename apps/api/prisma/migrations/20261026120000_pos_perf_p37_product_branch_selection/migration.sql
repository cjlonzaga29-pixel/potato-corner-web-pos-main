-- POS-PERF-P37 — "create once, select multiple branches".
-- Additive only: existing rows default to false (unchanged behavior). True
-- marks a supervisor-created shared product whose branch_product_availability
-- rows are its explicit branch selection; see schema.prisma's Product model.
ALTER TABLE "products" ADD COLUMN "branch_selection_scoped" BOOLEAN NOT NULL DEFAULT false;
