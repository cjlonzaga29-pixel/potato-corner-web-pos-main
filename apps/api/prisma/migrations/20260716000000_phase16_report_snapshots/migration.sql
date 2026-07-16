-- apps/api/prisma/migrations/20260716000000_phase16_report_snapshots/migration.sql
CREATE TYPE "ReportType" AS ENUM (
  'DAILY_SALES',
  'SHIFT_SUMMARY',
  'CASH_RECONCILIATION',
  'VOID_REFUND',
  'DISCOUNT_COMPLIANCE',
  'INVENTORY_MOVEMENT',
  'ATTENDANCE_SUMMARY',
  'FRAUD_ALERT_SUMMARY',
  'PRODUCT_PERFORMANCE',
  'FLAVOR_PERFORMANCE',
  'EMPLOYEE_PERFORMANCE',
  'INVENTORY_VALUATION',
  'BRANCH_COMPARISON'
);

CREATE TABLE "report_snapshots" (
  "id" TEXT NOT NULL,
  "report_type" "ReportType" NOT NULL,
  "branch_id" TEXT,
  "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL,
  "parameters" JSONB NOT NULL DEFAULT '{}',

  CONSTRAINT "report_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_snapshots_report_type_branch_id_computed_at_idx"
  ON "report_snapshots" ("report_type", "branch_id", "computed_at" DESC);

CREATE INDEX "report_snapshots_computed_at_idx"
  ON "report_snapshots" ("computed_at");
