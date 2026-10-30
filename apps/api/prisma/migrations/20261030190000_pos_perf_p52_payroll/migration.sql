-- POS-PERF-P52 — attendance-based payroll settings, runs and reports.
-- Purely additive: four new enums and seven new tables. No existing table,
-- column or row is altered, and nothing is backfilled — no rate, no payroll
-- policy and no payroll run is created for existing branches or employees
-- (they stay visibly "not configured" until a supervisor/admin saves one).
-- Foreign keys are ON DELETE RESTRICT: payroll history is never removed by a
-- cascade. Rules: docs/runbooks/pos-perf-p52-payroll-settings-and-reports.md

-- CreateEnum
CREATE TYPE "PayrollPeriodType" AS ENUM ('semi_monthly', 'monthly');

-- CreateEnum
CREATE TYPE "PayrollBreakTreatment" AS ENUM ('paid', 'unpaid', 'paid_up_to_limit');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('draft', 'finalized', 'superseded', 'discarded');

-- CreateEnum
CREATE TYPE "PayrollAdjustmentKind" AS ENUM ('earning', 'deduction');

-- CreateTable
CREATE TABLE "payroll_policies" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "period_type" "PayrollPeriodType" NOT NULL,
    "semi_monthly_first_end_day" INTEGER,
    "break_treatment" "PayrollBreakTreatment" NOT NULL,
    "paid_break_limit_minutes" INTEGER,
    "change_reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_pay_rates" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "hourly_rate" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,
    "void_reason" TEXT,

    CONSTRAINT "employee_pay_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'draft',
    "revision_of_id" TEXT,
    "revision_number" INTEGER NOT NULL DEFAULT 1,
    "revision_reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finalized_at" TIMESTAMP(3),
    "finalized_by" TEXT,
    "finalized_by_name" TEXT,
    "fingerprint" VARCHAR(64),
    "policy_snapshot" JSONB,
    "rate_snapshot" JSONB,
    "issue_snapshot" JSONB,
    "scope_acknowledged_at" TIMESTAMP(3),
    "basic_pay_total" DECIMAL(14,2),
    "earnings_total" DECIMAL(14,2),
    "deductions_total" DECIMAL(14,2),
    "calculated_total" DECIMAL(14,2),
    "superseded_at" TIMESTAMP(3),
    "superseded_by_id" TEXT,
    "discarded_at" TIMESTAMP(3),
    "discarded_by" TEXT,
    "discard_reason" TEXT,
    "paid_at" TIMESTAMP(3),
    "paid_by" TEXT,
    "paid_by_name" TEXT,
    "paid_reference" TEXT,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_run_lines" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "employee_name" TEXT NOT NULL,
    "employee_code" TEXT,
    "payable_ms" BIGINT NOT NULL,
    "basic_pay" DECIMAL(14,2) NOT NULL,
    "earnings_adjustments" DECIMAL(14,2) NOT NULL,
    "deductions" DECIMAL(14,2) NOT NULL,
    "calculated_total" DECIMAL(14,2) NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_run_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "kind" "PayrollAdjustmentKind" NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "documentation_ref" TEXT,
    "copied_from_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,
    "void_reason" TEXT,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_issue_resolutions" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "issue_key" VARCHAR(200) NOT NULL,
    "note" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_issue_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_attendance_claims" (
    "id" TEXT NOT NULL,
    "attendance_record_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "payroll_attendance_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_policies_branch_id_version_key" ON "payroll_policies"("branch_id", "version");

-- CreateIndex
CREATE INDEX "employee_pay_rates_employee_id_branch_id_effective_from_idx" ON "employee_pay_rates"("employee_id", "branch_id", "effective_from");

-- CreateIndex
CREATE INDEX "employee_pay_rates_branch_id_idx" ON "employee_pay_rates"("branch_id");

-- CreateIndex
CREATE INDEX "payroll_runs_branch_id_period_start_period_end_idx" ON "payroll_runs"("branch_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "payroll_runs_revision_of_id_idx" ON "payroll_runs"("revision_of_id");

-- CreateIndex
CREATE INDEX "payroll_run_lines_employee_id_idx" ON "payroll_run_lines"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_run_lines_run_id_employee_id_key" ON "payroll_run_lines"("run_id", "employee_id");

-- CreateIndex
CREATE INDEX "payroll_adjustments_run_id_employee_id_idx" ON "payroll_adjustments"("run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_issue_resolutions_run_id_issue_key_key" ON "payroll_issue_resolutions"("run_id", "issue_key");

-- CreateIndex
CREATE INDEX "payroll_attendance_claims_run_id_idx" ON "payroll_attendance_claims"("run_id");

-- CreateIndex
CREATE INDEX "payroll_attendance_claims_attendance_record_id_idx" ON "payroll_attendance_claims"("attendance_record_id");

-- AddForeignKey
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_rates" ADD CONSTRAINT "employee_pay_rates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_rates" ADD CONSTRAINT "employee_pay_rates_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_revision_of_id_fkey" FOREIGN KEY ("revision_of_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run_lines" ADD CONSTRAINT "payroll_run_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_issue_resolutions" ADD CONSTRAINT "payroll_issue_resolutions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_attendance_claims" ADD CONSTRAINT "payroll_attendance_claims_attendance_record_id_fkey" FOREIGN KEY ("attendance_record_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_attendance_claims" ADD CONSTRAINT "payroll_attendance_claims_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Database-level guarantees Prisma cannot express (partial unique indexes,
-- CHECK constraints). `prisma migrate diff` ignores both, same as P51.
-- ---------------------------------------------------------------------------

-- Policy shape: the cutoff day exists exactly for semi-monthly periods, the
-- paid-break limit exactly for the "paid up to limit" treatment.
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_version_positive" CHECK ("version" >= 1);
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_cutoff_shape" CHECK (
  ("period_type" = 'semi_monthly' AND "semi_monthly_first_end_day" BETWEEN 1 AND 27)
  OR ("period_type" = 'monthly' AND "semi_monthly_first_end_day" IS NULL)
);
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_break_limit_shape" CHECK (
  ("break_treatment" = 'paid_up_to_limit' AND "paid_break_limit_minutes" BETWEEN 0 AND 720)
  OR ("break_treatment" <> 'paid_up_to_limit' AND "paid_break_limit_minutes" IS NULL)
);

-- Rates: strictly positive (no zero-rate default), void fields all-or-none,
-- at most one live rate per employee, branch and effective date.
ALTER TABLE "employee_pay_rates" ADD CONSTRAINT "employee_pay_rates_rate_positive" CHECK ("hourly_rate" > 0);
ALTER TABLE "employee_pay_rates" ADD CONSTRAINT "employee_pay_rates_void_consistent" CHECK (
  ("voided_at" IS NULL AND "voided_by" IS NULL AND "void_reason" IS NULL)
  OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND "void_reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "employee_pay_rates_one_active_per_date" ON "employee_pay_rates"("employee_id", "branch_id", "effective_from") WHERE "voided_at" IS NULL;

-- Runs: ordered period; a finalized/superseded run always carries its
-- snapshot; "paid" can only be recorded on a run that was finalized.
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_period_order" CHECK ("period_end" >= "period_start");
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_finalized_snapshot" CHECK (
  "status" NOT IN ('finalized', 'superseded')
  OR ("finalized_at" IS NOT NULL AND "finalized_by" IS NOT NULL AND "fingerprint" IS NOT NULL
      AND "policy_snapshot" IS NOT NULL AND "rate_snapshot" IS NOT NULL AND "calculated_total" IS NOT NULL
      AND "scope_acknowledged_at" IS NOT NULL)
);
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_paid_after_finalized" CHECK ("paid_at" IS NULL OR "finalized_at" IS NOT NULL);
-- One open draft and one finalized run per branch and period; one open
-- revision draft per finalized run. Overlapping (non-identical) periods are
-- refused by the service under the per-branch advisory lock.
CREATE UNIQUE INDEX "payroll_runs_one_draft_per_period" ON "payroll_runs"("branch_id", "period_start", "period_end") WHERE "status" = 'draft';
CREATE UNIQUE INDEX "payroll_runs_one_finalized_per_period" ON "payroll_runs"("branch_id", "period_start", "period_end") WHERE "status" = 'finalized';
CREATE UNIQUE INDEX "payroll_runs_one_open_revision" ON "payroll_runs"("revision_of_id") WHERE "status" = 'draft' AND "revision_of_id" IS NOT NULL;

-- Adjustments: positive amounts (direction comes from kind), a reason
-- always, a documentation reference for every deduction.
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_reason_present" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_deduction_documented" CHECK (
  "kind" <> 'deduction' OR ("documentation_ref" IS NOT NULL AND length(btrim("documentation_ref")) > 0)
);

-- One unreleased payroll claim per attendance record: a shift can never be
-- in two live finalized payrolls.
CREATE UNIQUE INDEX "payroll_attendance_claims_one_active_per_record" ON "payroll_attendance_claims"("attendance_record_id") WHERE "released_at" IS NULL;
