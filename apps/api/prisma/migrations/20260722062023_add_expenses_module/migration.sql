-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('utilities', 'supplies', 'staff_meals', 'miscellaneous');

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "vendor_name" TEXT,
    "description" TEXT,
    "receipt_url" TEXT,
    "receipt_key" TEXT,
    "incurred_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expense_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expenses_branch_id_incurred_at_idx" ON "expenses"("branch_id", "incurred_at");

-- CreateIndex
CREATE INDEX "expenses_created_by_idx" ON "expenses"("created_by");

-- CreateIndex
CREATE INDEX "expenses_deleted_at_idx" ON "expenses"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "expense_idempotency_keys_key_key" ON "expense_idempotency_keys"("key");

-- CreateIndex
CREATE INDEX "expense_idempotency_keys_user_id_created_at_idx" ON "expense_idempotency_keys"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
