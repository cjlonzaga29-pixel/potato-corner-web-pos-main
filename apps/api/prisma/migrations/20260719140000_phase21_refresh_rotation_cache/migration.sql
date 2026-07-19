-- CreateTable
CREATE TABLE "refresh_token_rotation_cache" (
    "id" TEXT NOT NULL,
    "original_token_hash" TEXT NOT NULL,
    "cached_access_token" TEXT NOT NULL,
    "cached_refresh_token" TEXT NOT NULL,
    "cached_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_rotation_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_rotation_cache_original_token_hash_key" ON "refresh_token_rotation_cache"("original_token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_rotation_cache_created_at_idx" ON "refresh_token_rotation_cache"("created_at");
