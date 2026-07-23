-- CreateTable
CREATE TABLE "branch_payment_method_configs" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "cash_enabled" BOOLEAN NOT NULL DEFAULT true,
    "gcash_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_payment_method_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branch_payment_method_configs_branch_id_key" ON "branch_payment_method_configs"("branch_id");

-- CreateIndex
CREATE INDEX "branch_payment_method_configs_branch_id_idx" ON "branch_payment_method_configs"("branch_id");

-- AddForeignKey
ALTER TABLE "branch_payment_method_configs" ADD CONSTRAINT "branch_payment_method_configs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_payment_method_configs" ADD CONSTRAINT "branch_payment_method_configs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
