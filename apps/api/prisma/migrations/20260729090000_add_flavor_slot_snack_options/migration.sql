-- CreateTable
CREATE TABLE "product_flavor_slot_snack_options" (
    "id" TEXT NOT NULL,
    "flavor_slot_id" TEXT NOT NULL,
    "snack_product_variant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_flavor_slot_snack_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_flavor_slot_snack_options_flavor_slot_id_idx" ON "product_flavor_slot_snack_options"("flavor_slot_id");

-- CreateIndex
CREATE INDEX "product_flavor_slot_snack_options_snack_product_variant_id_idx" ON "product_flavor_slot_snack_options"("snack_product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_flavor_slot_snack_options_flavor_slot_id_snack_pro_key" ON "product_flavor_slot_snack_options"("flavor_slot_id", "snack_product_variant_id");

-- AddForeignKey
ALTER TABLE "product_flavor_slot_snack_options" ADD CONSTRAINT "product_flavor_slot_snack_options_flavor_slot_id_fkey" FOREIGN KEY ("flavor_slot_id") REFERENCES "product_flavor_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_flavor_slot_snack_options" ADD CONSTRAINT "product_flavor_slot_snack_options_snack_product_variant_id_fkey" FOREIGN KEY ("snack_product_variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
