import type { PayrollEmployeeResult, PayRateEmployeeView, PayRatesResponse, PayrollPeriodOption, PayrollPolicyView, PayrollRunDetail, PayrollRunSummary, PayrollSettingsResponse } from '@potato-corner/shared';

/** POS-PERF-P66 — shared builders for the payroll component tests (test-only). */

export const EXCLUSIONS = ['SSS, PhilHealth and Pag-IBIG contributions', 'Withholding tax'];

export const POLICY: PayrollPolicyView = {
  version: 3,
  timezone: 'Asia/Manila',
  period_type: 'semi_monthly',
  semi_monthly_first_end_day: 15,
  break_treatment: 'unpaid',
  paid_break_limit_minutes: null,
  change_reason: null,
  created_by_name: 'Sol',
  created_at: '2026-10-01T00:00:00.000Z',
};

export function settingsFor(policy: PayrollPolicyView | null, branch = { id: 'b1', name: 'North' }): PayrollSettingsResponse {
  return { branch, policy, history: policy ? [policy] : [], regular_shift_minutes: 480, exclusions: EXCLUSIONS };
}

export function employeeRate(overrides: Partial<PayRateEmployeeView> = {}): PayRateEmployeeView {
  return {
    employee_id: 'e1',
    name: 'Ana Reyes',
    employee_code: 'E-1',
    assignment: 'current',
    employee_active: true,
    current_rate: null,
    latest_rate_id: null,
    rates: [],
    ...overrides,
  };
}

export function ratesFor(employees: PayRateEmployeeView[], branch = { id: 'b1', name: 'North' }): PayRatesResponse {
  return { branch, today: '2026-11-22', employees };
}

export function runSummary(overrides: Partial<PayrollRunSummary> = {}): PayrollRunSummary {
  return {
    id: 'run-1',
    branch_id: 'b1',
    period_start: '2026-10-16',
    period_end: '2026-10-31',
    status: 'draft',
    revision_number: 1,
    revision_of_id: null,
    revision_reason: null,
    superseded_by_id: null,
    created_at: '2026-10-30T00:00:00.000Z',
    finalized_at: null,
    finalized_by_name: null,
    paid_at: null,
    paid_by_name: null,
    paid_reference: null,
    calculated_total: null,
    ...overrides,
  };
}

export function period(start: string, end: string, runs: PayrollRunSummary[] = []): PayrollPeriodOption {
  return { period_start: start, period_end: end, label: `${start} to ${end}`, runs };
}

export function baseEmployee(overrides: Partial<PayrollEmployeeResult> = {}): PayrollEmployeeResult {
  return {
    employee_id: 'e1',
    name: 'Ana Reyes',
    employee_code: 'E-1',
    payable_ms: 8 * 3_600_000,
    rate_lines: [{ hourly_rate: '80.00', rate_id: 'r1', effective_from: '2026-01-01', payable_ms: 8 * 3_600_000, amount: '640.00' }],
    basic_pay: '640.00',
    earnings_adjustments: '0.00',
    deductions: '0.00',
    calculated_total: '640.00',
    shifts: [],
    adjustments: [],
    issue_keys: [],
    previous_total: null,
    ...overrides,
  };
}

export function runDetail(overrides: Partial<PayrollRunDetail> = {}): PayrollRunDetail {
  return {
    ...runSummary(),
    branch_name: 'North',
    basis: 'live',
    calculated_at: '2026-10-30T11:55:00.000Z',
    fingerprint: 'a'.repeat(64),
    policy: null,
    totals: { basic_pay: '640.00', earnings_adjustments: '0.00', deductions: '0.00', calculated_total: '640.00', payable_ms: 8 * 3_600_000 },
    employees: [baseEmployee()],
    issues: [],
    blocking_count: 0,
    can_finalize: true,
    exclusions: EXCLUSIONS,
    total_label: 'Calculated total (before statutory items)',
    source_changes: [],
    employee_filter: null,
    ...overrides,
  };
}
