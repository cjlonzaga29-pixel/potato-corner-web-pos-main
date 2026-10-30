import { describe, it, expect } from 'vitest';
import type { PayrollEmployeeResult, PayrollRunDetail } from '@potato-corner/shared';
import { buildPayrollCsv, buildPayrollPdf, csvCell, payrollExportFilename, statusLabel, wrapLongTokens } from './payroll-export.js';

function employee(i: number, name: string): PayrollEmployeeResult {
  return {
    employee_id: `emp-${i}`,
    name,
    employee_code: `E-${i}`,
    payable_ms: 8 * 3_600_000,
    rate_lines: [{ hourly_rate: '80.00', rate_id: 'r', effective_from: '2026-01-01', payable_ms: 8 * 3_600_000, amount: '640.00' }],
    basic_pay: '640.00',
    earnings_adjustments: '0.00',
    deductions: '0.00',
    calculated_total: '640.00',
    shifts: Array.from({ length: 6 }, (_, d) => ({
      attendance_record_id: `rec-${i}-${d}`,
      business_date: `2026-10-${String(16 + d).padStart(2, '0')}`,
      clock_in: `2026-10-${String(16 + d).padStart(2, '0')}T00:00:00.000Z`,
      clock_out: `2026-10-${String(16 + d).padStart(2, '0')}T09:00:00.000Z`,
      span_ms: 9 * 3_600_000,
      break_source: 'intervals' as const,
      breaks: [{ started_at: '2026-10-16T04:00:00.000Z', ended_at: '2026-10-16T05:00:00.000Z', minutes: '60.00', paid_minutes: '0.00', unpaid_minutes: '60.00', source: 'interval' as const }],
      break_ms: 3_600_000,
      unpaid_break_ms: 3_600_000,
      payable_ms: 8 * 3_600_000,
      segments: [],
      corrected: null,
      note: null,
      issue_codes: [],
    })),
    adjustments: [
      {
        id: `a-${i}`,
        kind: 'earning',
        category: 'allowance',
        amount: '10.00',
        reason: '=cmd|"/C calc"!A0',
        documentation_ref: null,
        copied_from_id: null,
        created_by_name: '@admin',
        created_at: '2026-10-30T00:00:00.000Z',
        voided_at: null,
        void_reason: null,
      },
    ],
    issue_keys: [],
    previous_total: null,
  };
}

function detail(overrides: Partial<PayrollRunDetail> = {}): PayrollRunDetail {
  const employees = [
    employee(1, '=HYPERLINK("http://x") Formula'),
    employee(2, 'Maria Concepcion Evangelista de los Santos-Villanueva-Montemayor-Esperanza'),
    ...Array.from({ length: 30 }, (_, i) => employee(i + 3, `Staff Member ${i + 3}`)),
  ];
  return {
    id: 'run',
    branch_id: 'b',
    period_start: '2026-10-16',
    period_end: '2026-10-31',
    status: 'finalized',
    revision_number: 1,
    revision_of_id: null,
    revision_reason: null,
    superseded_by_id: null,
    created_at: '2026-10-30T00:00:00.000Z',
    finalized_at: '2026-10-30T00:00:00.000Z',
    finalized_by_name: 'Sol North',
    paid_at: null,
    paid_by_name: null,
    paid_reference: null,
    calculated_total: '20480.00',
    branch_name: 'North',
    basis: 'finalized_snapshot',
    calculated_at: '2026-10-30T00:00:00.000Z',
    fingerprint: 'f'.repeat(64),
    policy: { version: 1, timezone: 'Asia/Manila', period_type: 'semi_monthly', semi_monthly_first_end_day: 15, break_treatment: 'unpaid', paid_break_limit_minutes: null, change_reason: null, created_by_name: 'Sol', created_at: '2026-10-01T00:00:00.000Z' },
    totals: { basic_pay: '20480.00', earnings_adjustments: '320.00', deductions: '0.00', calculated_total: '20800.00', payable_ms: 32 * 8 * 3_600_000 },
    employees,
    issues: [],
    blocking_count: 0,
    can_finalize: false,
    exclusions: ['Withholding tax'],
    total_label: 'Calculated total (before statutory items)',
    source_changes: [],
    employee_filter: null,
    ...overrides,
  };
}

describe('payroll export', () => {
  it('neutralises spreadsheet formulas in text but keeps numbers numeric', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('-12.00', true)).toBe('-12.00');
    expect(csvCell('-12.00')).toBe("'-12.00");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });

  it('CSV: every free-text cell is escaped and totals equal the record', () => {
    const csv = buildPayrollCsv(detail()).toString('utf-8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"") Formula"`);
    expect(csv).toContain(`"'=cmd|""/C calc""!A0"`);
    expect(csv).toContain("'@admin");
    const total = csv.split('\r\n').find((l) => l.startsWith('TOTAL,'));
    expect(total?.split(',').slice(5, 9)).toEqual(['20480.00', '320.00', '0.00', '20800.00']);
    // No identifiers beyond name/code are ever written.
    expect(csv).not.toMatch(/sss|philhealth|pag-?ibig|tin\b|pin/i);
  });

  it('labels drafts as drafts everywhere', () => {
    const d = detail({ status: 'draft', basis: 'live' });
    expect(statusLabel(d)).toBe('DRAFT — NOT FINALIZED');
    expect(buildPayrollCsv(d).toString('utf-8').split('\r\n')[0]).toContain('DRAFT — NOT FINALIZED');
    expect(payrollExportFilename(d, 'pdf')).toMatch(/_DRAFT\.pdf$/);
    expect(payrollExportFilename(detail(), 'csv')).toMatch(/_FINAL\.csv$/);
  });

  it('PDF: renders a multi-page document with long names', async () => {
    const pdf = await buildPayrollPdf(detail());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(2);
    expect(wrapLongTokens('Evangelista-de-los-Santos-Villanueva')).toContain('\u200B');
  }, 60_000);
});
