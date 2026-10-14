-- AlterTable
ALTER TABLE "products" ADD COLUMN     "forked_from_product_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "products_forked_from_product_id_exclusive_branch_id_key" ON "products"("forked_from_product_id", "exclusive_branch_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_forked_from_product_id_fkey" FOREIGN KEY ("forked_from_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
