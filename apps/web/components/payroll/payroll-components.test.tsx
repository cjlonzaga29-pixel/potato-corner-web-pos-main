import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import type { PayRateEmployeeView, PayrollRunDetail, PayrollSettingsResponse } from '@potato-corner/shared';

const hooks = vi.hoisted(() => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false, variables: undefined });
  return {
    savePolicy: mutation(),
    createRate: mutation(),
    finalize: mutation(),
    exporter: mutation(),
    action: mutation(),
    resolve: mutation(),
    usePayrollRun: vi.fn(),
  };
});

vi.mock('@/hooks/queries/use-payroll', () => {
  class PayrollApiError extends Error {
    constructor(
      message: string,
      public readonly code: string | null,
    ) {
      super(message);
    }
  }
  return {
    PayrollApiError,
    useSavePayrollPolicy: () => hooks.savePolicy,
    useCreatePayRate: () => hooks.createRate,
    useFinalizePayroll: () => hooks.finalize,
    usePayrollExport: () => hooks.exporter,
    usePayrollRunAction: () => hooks.action,
    useResolvePayrollIssue: () => hooks.resolve,
    useAddPayrollAdjustment: () => hooks.action,
    useVoidPayrollAdjustment: () => hooks.action,
    usePayrollRun: hooks.usePayrollRun,
  };
});

const { PayrollPolicyForm } = await import('./payroll-policy-form');
const { PayrollRateDialog } = await import('./payroll-rate-dialog');
const { PayrollRunView } = await import('./payroll-run-view');
const { PayrollApiError } = await import('@/hooks/queries/use-payroll');

const EXCLUSIONS = ['SSS, PhilHealth and Pag-IBIG contributions', 'Withholding tax'];

function settings(policy: PayrollSettingsResponse['policy']): PayrollSettingsResponse {
  return { branch: { id: 'b1', name: 'North' }, policy, history: policy ? [policy] : [], regular_shift_minutes: 480, exclusions: EXCLUSIONS };
}

function runDetail(overrides: Partial<PayrollRunDetail> = {}): PayrollRunDetail {
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
    branch_name: 'North',
    basis: 'live',
    calculated_at: '2026-10-30T00:00:00.000Z',
    fingerprint: 'a'.repeat(64),
    policy: null,
    totals: { basic_pay: '640.00', earnings_adjustments: '0.00', deductions: '0.00', calculated_total: '640.00', payable_ms: 8 * 3_600_000 },
    employees: [
      {
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
      },
    ],
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

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('PayrollPolicyForm', () => {
  it('pre-selects nothing for an unconfigured branch and refuses to save without explicit choices', () => {
    render(<PayrollPolicyForm branchId="b1" settings={settings(null)} />);
    expect(screen.getByText('Not configured')).toBeTruthy();
    for (const radio of screen.getAllByRole('radio')) expect(radio.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(screen.getByRole('alert').textContent).toMatch(/timezone/i);
    expect(hooks.savePolicy.mutate).not.toHaveBeenCalled();
  });

  it('saves the explicit choices with the loaded version (stale-write guard)', () => {
    render(
      <PayrollPolicyForm
        branchId="b1"
        settings={settings({ version: 3, timezone: 'Asia/Manila', period_type: 'semi_monthly', semi_monthly_first_end_day: 15, break_treatment: 'unpaid', paid_break_limit_minutes: null, change_reason: null, created_by_name: 'Sol', created_at: '2026-10-01T00:00:00.000Z' })}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /Paid up to a limit/ }));
    fireEvent.change(screen.getByLabelText('Paid break minutes per shift'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(hooks.savePolicy.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ expected_version: 3, break_treatment: 'paid_up_to_limit', paid_break_limit_minutes: 15, period_type: 'semi_monthly', semi_monthly_first_end_day: 15 }),
    );
  });
});

describe('PayrollRateDialog', () => {
  const employee: PayRateEmployeeView = {
    employee_id: 'e1',
    name: 'Ana Reyes',
    employee_code: 'E-1',
    assignment: 'current',
    employee_active: true,
    current_rate: null,
    latest_rate_id: 'rate-latest',
    rates: [],
  };

  it('derives the per-minute preview and sends the latest rate id it saw', () => {
    render(<PayrollRateDialog branchId="b1" employee={employee} today="2026-10-30" onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Hourly rate (₱)'), { target: { value: '75.50' } });
    expect(screen.getByText(/≈ ₱1\.2583 per minute/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Annual increase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rate' }));
    expect(hooks.createRate.mutate).toHaveBeenCalledWith(
      { employee_id: 'e1', effective_from: '2026-10-30', hourly_rate: '75.50', reason: 'Annual increase', expected_latest_rate_id: 'rate-latest' },
      expect.anything(),
    );
  });

  it('does not allow a zero rate', () => {
    render(<PayrollRateDialog branchId="b1" employee={employee} today="2026-10-30" onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Hourly rate (₱)'), { target: { value: '0.00' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'oops' } });
    expect((screen.getByRole('button', { name: 'Add rate' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('PayrollRunView', () => {
  function show(detail: PayrollRunDetail) {
    hooks.usePayrollRun.mockReturnValue({ data: detail, isLoading: false, isError: false, error: null });
    render(<PayrollRunView branchId="b1" runId="run-1" onOpenRun={vi.fn()} />);
  }

  it('labels a draft as not finalized, lists the exclusions and never calls it net pay', () => {
    show(runDetail());
    expect(screen.getAllByText('Draft — not finalized').length).toBeGreaterThan(0);
    expect(screen.getByText(/Not included: SSS, PhilHealth and Pag-IBIG contributions; Withholding tax/)).toBeTruthy();
    expect(screen.getAllByText('Calculated total (before statutory items)').length).toBeGreaterThan(0);
    expect(screen.queryByText(/net pay/i)?.textContent ?? '').toMatch(/not statutory net pay/i);
    expect(screen.queryByRole('button', { name: /Mark as paid/ })).toBeNull();
  });

  it('disables Finalize while blocking items remain', () => {
    show(runDetail({ can_finalize: false, blocking_count: 2, issues: [{ key: 'k', code: 'RATE_MISSING', severity: 'blocking', message: 'No hourly rate', employee_id: 'e1', attendance_record_id: null, business_date: '2026-10-16', resolution: null }] }));
    expect((screen.getByRole('button', { name: 'Finalize…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/2 item\(s\) must be resolved/)).toBeTruthy();
  });

  it('requires the scope acknowledgement, sends the reviewed fingerprint and explains a stale preview', () => {
    show(runDetail());
    fireEvent.click(screen.getByRole('button', { name: 'Finalize…' }));
    const dialog = screen.getByRole('dialog');
    const finalize = within(dialog).getByRole('button', { name: 'Finalize' }) as HTMLButtonElement;
    expect(finalize.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(finalize);
    const [input, callbacks] = hooks.finalize.mutate.mock.calls[0] as [{ expected_fingerprint: string }, { onError: (e: Error) => void }];
    expect(input).toEqual({ expected_fingerprint: 'a'.repeat(64) });
    act(() => callbacks.onError(new PayrollApiError('changed', 'STALE_PREVIEW')));
    expect(within(screen.getByRole('dialog')).getByText(/The figures changed after you opened this payroll/)).toBeTruthy();
  });

  it('shows a finalized record as stored, with Revise and Mark as paid but no Finalize', () => {
    show(runDetail({ status: 'finalized', basis: 'finalized_snapshot', finalized_by_name: 'Sol North', can_finalize: false, calculated_total: '640.00' }));
    expect(screen.getByText('Finalized')).toBeTruthy();
    expect(screen.getByText('Not marked paid')).toBeTruthy();
    expect(screen.getByText(/does not change when attendance, rates or settings change/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finalize…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revise…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark as paid…' })).toBeTruthy();
  });

  it('warns when attendance changed after finalization', () => {
    show(runDetail({ status: 'finalized', basis: 'finalized_snapshot', can_finalize: false, source_changes: [{ attendance_record_id: 'r', employee_id: 'e1', change: 'Corrected' }] }));
    expect(screen.getByText('Attendance changed after finalization')).toBeTruthy();
  });

  it('opens the employee drilldown from the keyboard-reachable Details button', () => {
    show(runDetail());
    fireEvent.click(screen.getByRole('button', { name: 'Details for Ana Reyes' }));
    expect(screen.getByRole('region', { name: 'Rate breakdown' })).toBeTruthy();
    expect(screen.getByText(/8h 0m × ₱80.00\/h/)).toBeTruthy();
  });
});
