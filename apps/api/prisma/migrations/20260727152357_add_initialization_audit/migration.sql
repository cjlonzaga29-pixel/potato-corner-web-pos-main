-- CreateEnum
CREATE TYPE "InitializationType" AS ENUM ('REFERENCE_DATA');

-- CreateEnum
CREATE TYPE "InitializationExecutionMode" AS ENUM ('DRY_RUN', 'APPLY', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "InitializationRunStatus" AS ENUM ('PLANNED', 'DRY_RUN_VALIDATED', 'APPLYING', 'APPLIED', 'APPLY_FAILED', 'ROLLBACK_ASSESSING', 'ROLLBACK_BLOCKED', 'ROLLING_BACK', 'ROLLED_BACK', 'ROLLBACK_PARTIAL', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "InitializationEntityType" AS ENUM ('INVENTORY_CATEGORY', 'UNIT_OF_MEASURE', 'UNIT_CONVERSION');

-- CreateEnum
CREATE TYPE "InitializationAction" AS ENUM ('VALIDATED', 'CREATED', 'REUSED', 'SKIPPED', 'BLOCKED', 'FAILED');

-- CreateEnum
CREATE TYPE "InitializationRollbackEligibility" AS ENUM ('ELIGIBLE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "InitializationRollbackStatus" AS ENUM ('NOT_ASSESSED', 'ELIGIBLE', 'BLOCKED', 'ROLLED_BACK', 'ROLLBACK_FAILED');

-- CreateEnum
CREATE TYPE "InitializationApplyStatus" AS ENUM ('PENDING', 'COMMITTED', 'ROLLED_BACK_ATTEMPT_FAILED');

-- CreateTable
CREATE TABLE "initialization_runs" (
    "id" TEXT NOT NULL,
    "migration_batch" TEXT NOT NULL,
    "initialization_type" "InitializationType" NOT NULL,
    "manifest_version" INTEGER NOT NULL,
    "manifest_fingerprint" TEXT NOT NULL,
    "manifest_snapshot" JSONB NOT NULL,
    "manifest_entry_key_version" INTEGER NOT NULL DEFAULT 1,
    "fingerprint_version" INTEGER NOT NULL DEFAULT 1,
    "decimal_canonicalization_version" INTEGER NOT NULL DEFAULT 1,
    "target_environment" TEXT NOT NULL,
    "execution_mode" "InitializationExecutionMode" NOT NULL,
    "status" "InitializationRunStatus" NOT NULL,
    "initiated_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "dry_run_report_fingerprint" TEXT,
    "apply_report_fingerprint" TEXT,
    "rollback_report_fingerprint" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "initialization_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "initialization_records" (
    "id" TEXT NOT NULL,
    "initialization_run_id" TEXT NOT NULL,
    "manifest_entry_key" TEXT NOT NULL,
    "entity_type" "InitializationEntityType" NOT NULL,
    "entity_id" TEXT,
    "action" "InitializationAction" NOT NULL,
    "created_by_run" BOOLEAN NOT NULL,
    "reused_existing" BOOLEAN NOT NULL,
    "preexisting_fingerprint" TEXT,
    "resulting_fingerprint" TEXT,
    "current_verification_fingerprint" TEXT,
    "apply_status" "InitializationApplyStatus" NOT NULL DEFAULT 'PENDING',
    "rollback_eligibility" "InitializationRollbackEligibility",
    "rollback_status" "InitializationRollbackStatus" NOT NULL DEFAULT 'NOT_ASSESSED',
    "rollback_blocked_reason" TEXT,
    "rolled_back_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "initialization_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "initialization_runs_target_environment_status_idx" ON "initialization_runs"("target_environment", "status");

-- CreateIndex
CREATE INDEX "initialization_runs_manifest_fingerprint_idx" ON "initialization_runs"("manifest_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "initialization_runs_migration_batch_key" ON "initialization_runs"("migration_batch");

-- CreateIndex
CREATE INDEX "initialization_records_entity_type_entity_id_idx" ON "initialization_records"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "initialization_records_rollback_eligibility_idx" ON "initialization_records"("rollback_eligibility");

-- CreateIndex
CREATE UNIQUE INDEX "initialization_records_initialization_run_id_manifest_entry_key" ON "initialization_records"("initialization_run_id", "manifest_entry_key");

-- AddForeignKey
ALTER TABLE "initialization_runs" ADD CONSTRAINT "initialization_runs_initiated_by_fkey" FOREIGN KEY ("initiated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "initialization_records" ADD CONSTRAINT "initialization_records_initialization_run_id_fkey" FOREIGN KEY ("initialization_run_id") REFERENCES "initialization_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Secondary resolved-target duplicate-protection index (CR-009 "Manifest-entry
-- provenance identity (resolved)"). Prisma cannot express a partial unique
-- index, so it is added here as raw SQL. Guards against two different
-- manifest entries within one run resolving to the same target row; the
-- primary (initialization_run_id, manifest_entry_key) unique index above is
-- what actually prevents duplicate BLOCKED/SKIPPED/FAILED rows, since
-- Postgres treats each NULL entity_id as distinct.
CREATE UNIQUE INDEX "initialization_records_run_entity_target_key"
ON "initialization_records" ("initialization_run_id", "entity_type", "entity_id")
WHERE "entity_id" IS NOT NULL;
