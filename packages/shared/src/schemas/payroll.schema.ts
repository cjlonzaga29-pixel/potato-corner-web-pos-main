import { z } from 'zod';

/**
 * POS-PERF-P52 — attendance-based payroll (basic time-based pay only).
 * Rules: docs/runbooks/pos-perf-p52-payroll-settings-and-reports.md
 *
 * Money crosses the wire as decimal strings ("123.45"), never JS numbers,
 * so no client or server step ever does floating-point money arithmetic.
 */

export const PAYROLL_PERIOD_TYPES = ['semi_monthly', 'monthly'] as const;
export type PayrollPeriodType = (typeof PAYROLL_PERIOD_TYPES)[number];

export const PAYROLL_BREAK_TREATMENTS = ['paid', 'unpaid', 'paid_up_to_limit'] as const;
export type PayrollBreakTreatment = (typeof PAYROLL_BREAK_TREATMENTS)[number];

export const PAYROLL_RUN_STATUSES = ['draft', 'finalized', 'superseded', 'discarded'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const PAYROLL_EARNING_CATEGORIES = ['allowance', 'bonus', 'other_earning'] as const;
export const PAYROLL_DEDUCTION_CATEGORIES = ['documented_deduction'] as const;

/** What this payroll does NOT calculate — shown in the UI, the finalize dialog and every export. */
export const PAYROLL_EXCLUSIONS = [
  'SSS, PhilHealth and Pag-IBIG contributions',
  'Withholding tax',
  'Overtime premium',
  'Holiday and rest-day premium',
  'Night-shift differential',
  '13th-month pay and leave conversion',
] as const;

export const PAYROLL_TOTAL_LABEL = 'Calculated total (before statutory items)';

const dateKey = z.iso.date();
/** Positive peso amount with at most 2 decimals, as a string — parsed to integer centavos server-side. */
const pesoString = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter an amount like 75 or 75.50 (at most 2 decimals)');
const reasonText = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500);

export const payrollPolicyInputSchema = z
  .object({
    timezone: z.string().trim().min(1).max(64),
    period_type: z.enum(PAYROLL_PERIOD_TYPES),
    semi_monthly_first_end_day: z.number().int().min(1).max(27).nullable().optional(),
    break_treatment: z.enum(PAYROLL_BREAK_TREATMENTS),
    paid_break_limit_minutes: z.number().int().min(0).max(720).nullable().optional(),
    /** The policy version the editor loaded (0 = none existed). Mismatch → 409 STALE_POLICY. */
    expected_version: z.number().int().min(0),
    change_reason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.period_type === 'semi_monthly' && (value.semi_monthly_first_end_day ?? null) === null) {
      ctx.addIssue({ code: 'custom', path: ['semi_monthly_first_end_day'], message: 'Choose the first cutoff day' });
    }
    if (value.period_type === 'monthly' && (value.semi_monthly_first_end_day ?? null) !== null) {
      ctx.addIssue({ code: 'custom', path: ['semi_monthly_first_end_day'], message: 'Monthly periods have no cutoff day' });
    }
    if (value.break_treatment === 'paid_up_to_limit' && (value.paid_break_limit_minutes ?? null) === null) {
      ctx.addIssue({ code: 'custom', path: ['paid_break_limit_minutes'], message: 'Enter the paid break minutes per shift' });
    }
    if (value.break_treatment !== 'paid_up_to_limit' && (value.paid_break_limit_minutes ?? null) !== null) {
      ctx.addIssue({ code: 'custom', path: ['paid_break_limit_minutes'], message: 'Only used with "paid up to a limit"' });
    }
  });

export const payRateCreateSchema = z.object({
  employee_id: z.uuid(),
  effective_from: dateKey,
  hourly_rate: pesoString,
  reason: reasonText,
  /** Newest live rate id the editor saw for this employee at this branch (null = none). Mismatch → 409 STALE_RATES. */
  expected_latest_rate_id: z.uuid().nullable(),
});

export const payRateVoidSchema = z.object({
  reason: reasonText,
  expected_latest_rate_id: z.uuid().nullable(),
});

export const payrollRunCreateSchema = z.object({
  period_start: dateKey,
  period_end: dateKey,
});

export const payrollRunQuerySchema = z.object({
  employee_id: z.uuid().optional(),
});

export const payrollAdjustmentCreateSchema = z
  .object({
    employee_id: z.uuid(),
    kind: z.enum(['earning', 'deduction']),
    category: z.enum([...PAYROLL_EARNING_CATEGORIES, ...PAYROLL_DEDUCTION_CATEGORIES]),
    amount: pesoString,
    reason: reasonText,
    documentation_ref: z.string().trim().max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const earning = (PAYROLL_EARNING_CATEGORIES as readonly string[]).includes(value.category);
    if (value.kind === 'earning' && !earning) {
      ctx.addIssue({ code: 'custom', path: ['category'], message: 'Choose an earning category' });
    }
    if (value.kind === 'deduction' && earning) {
      ctx.addIssue({ code: 'custom', path: ['category'], message: 'Choose a deduction category' });
    }
    if (value.kind === 'deduction' && !(value.documentation_ref && value.documentation_ref.trim().length > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentation_ref'],
        message: 'A deduction needs a reference to its written authorization or document',
      });
    }
  });

export const payrollVoidSchema = z.object({ reason: reasonText });

export const payrollResolutionCreateSchema = z.object({
  issue_key: z.string().min(1).max(200),
  note: reasonText,
});

export const payrollFinalizeSchema = z.object({
  expected_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  /** The reviewer confirms the listed exclusions and remaining warnings. Must be literally true. */
  acknowledge_scope: z.literal(true),
});

export const payrollReviseSchema = z.object({ reason: reasonText });

export const payrollMarkPaidSchema = z.object({
  paid_reference: z.string().trim().max(200).optional(),
});

export const payrollExportQuerySchema = z.object({
  format: z.enum(['csv', 'pdf']),
  employee_id: z.uuid().optional(),
});

export type PayrollPolicyInput = z.infer<typeof payrollPolicyInputSchema>;
export type PayRateCreateInput = z.infer<typeof payRateCreateSchema>;
export type PayRateVoidInput = z.infer<typeof payRateVoidSchema>;
export type PayrollRunCreateInput = z.infer<typeof payrollRunCreateSchema>;
export type PayrollAdjustmentCreateInput = z.infer<typeof payrollAdjustmentCreateSchema>;
export type PayrollResolutionCreateInput = z.infer<typeof payrollResolutionCreateSchema>;
export type PayrollFinalizeInput = z.infer<typeof payrollFinalizeSchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface PayrollPolicyView {
  version: number;
  timezone: string;
  period_type: PayrollPeriodType;
  semi_monthly_first_end_day: number | null;
  break_treatment: PayrollBreakTreatment;
  paid_break_limit_minutes: number | null;
  change_reason: string | null;
  created_by_name: string;
  created_at: string;
}

export interface PayrollSettingsResponse {
  branch: { id: string; name: string };
  policy: PayrollPolicyView | null;
  history: PayrollPolicyView[];
  regular_shift_minutes: number;
  exclusions: readonly string[];
}

export interface PayRateView {
  id: string;
  effective_from: string;
  hourly_rate: string;
  /** Display only: hourly ÷ 60, 4 decimals. The hourly rate is the source of truth. */
  per_minute_display: string;
  reason: string;
  created_by_name: string;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

export interface PayRateEmployeeView {
  employee_id: string;
  name: string;
  employee_code: string | null;
  /** current = active assignment at this branch now; former = only a past assignment here. */
  assignment: 'current' | 'former';
  employee_active: boolean;
  current_rate: PayRateView | null;
  latest_rate_id: string | null;
  rates: PayRateView[];
}

export interface PayRatesResponse {
  branch: { id: string; name: string };
  today: string | null;
  employees: PayRateEmployeeView[];
}

export type PayrollIssueSeverity = 'blocking' | 'special_pay' | 'warning' | 'info';

export interface PayrollIssue {
  key: string;
  code: string;
  severity: PayrollIssueSeverity;
  message: string;
  employee_id: string | null;
  attendance_record_id: string | null;
  business_date: string | null;
  /** Special-pay only: the reviewer's resolution, if recorded. */
  resolution: { note: string; by: string; at: string } | null;
}

export interface PayrollBreakDetail {
  started_at: string | null;
  ended_at: string | null;
  minutes: string;
  paid_minutes: string;
  unpaid_minutes: string;
  source: 'interval' | 'legacy_total';
}

export interface PayrollSegmentDetail {
  start: string | null;
  end: string | null;
  business_date: string;
  payable_ms: number;
  hourly_rate: string | null;
  rate_id: string | null;
}

export interface PayrollShiftDetail {
  attendance_record_id: string;
  business_date: string;
  clock_in: string;
  clock_out: string | null;
  span_ms: number;
  break_source: 'intervals' | 'legacy_total' | 'none';
  breaks: PayrollBreakDetail[];
  break_ms: number;
  unpaid_break_ms: number;
  payable_ms: number;
  segments: PayrollSegmentDetail[];
  corrected: { by: string | null; reason: string | null } | null;
  note: string | null;
  issue_codes: string[];
}

export interface PayrollRateLine {
  hourly_rate: string;
  rate_id: string;
  effective_from: string;
  payable_ms: number;
  amount: string;
}

export interface PayrollAdjustmentView {
  id: string;
  kind: 'earning' | 'deduction';
  category: string;
  amount: string;
  reason: string;
  documentation_ref: string | null;
  copied_from_id: string | null;
  created_by_name: string;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}

export interface PayrollEmployeeResult {
  employee_id: string;
  name: string;
  employee_code: string | null;
  payable_ms: number;
  rate_lines: PayrollRateLine[];
  basic_pay: string;
  earnings_adjustments: string;
  deductions: string;
  calculated_total: string;
  shifts: PayrollShiftDetail[];
  adjustments: PayrollAdjustmentView[];
  issue_keys: string[];
  /** Revisions only: the superseded run's total for this employee (null if absent there). */
  previous_total: string | null;
}

export interface PayrollTotals {
  basic_pay: string;
  earnings_adjustments: string;
  deductions: string;
  calculated_total: string;
  payable_ms: number;
}

export interface PayrollRunSummary {
  id: string;
  branch_id: string;
  period_start: string;
  period_end: string;
  status: PayrollRunStatus;
  revision_number: number;
  revision_of_id: string | null;
  revision_reason: string | null;
  superseded_by_id: string | null;
  created_at: string;
  finalized_at: string | null;
  finalized_by_name: string | null;
  paid_at: string | null;
  paid_by_name: string | null;
  paid_reference: string | null;
  calculated_total: string | null;
}

export interface PayrollRunDetail extends PayrollRunSummary {
  branch_name: string;
  /** 'live' = draft recalculated now; 'finalized_snapshot' = stored at finalization, never recalculated. */
  basis: 'live' | 'finalized_snapshot';
  calculated_at: string;
  fingerprint: string | null;
  policy: PayrollPolicyView | null;
  totals: PayrollTotals;
  employees: PayrollEmployeeResult[];
  issues: PayrollIssue[];
  blocking_count: number;
  can_finalize: boolean;
  exclusions: readonly string[];
  total_label: string;
  /** Finalized runs only: attendance changed after finalization (records corrected/removed). Use a revision. */
  source_changes: Array<{ attendance_record_id: string; employee_id: string; change: string }>;
  employee_filter: string | null;
}

export interface PayrollPeriodOption {
  period_start: string;
  period_end: string;
  label: string;
  runs: PayrollRunSummary[];
}

export interface PayrollPeriodsResponse {
  configured: boolean;
  periods: PayrollPeriodOption[];
  runs: PayrollRunSummary[];
}
