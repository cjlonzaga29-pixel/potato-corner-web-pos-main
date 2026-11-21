import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import type { PayRatesResponse, PayrollPeriodsResponse, PayrollRunDetail, PayrollRunSummary, PayrollSettingsResponse } from '@potato-corner/shared';
import { POLICY, baseEmployee, employeeRate, period, ratesFor, runDetail, runSummary, settingsFor } from './payroll-test-fixtures';

/**
 * POS-PERF-P66 — the simplified Supervisor payroll flow: one Payroll Settings
 * entry, a setup checklist when needed, then period → review → finalize.
 */

type Query<T> = { data: T | undefined; isLoading: boolean; isError: boolean; error: Error | null; refetch: () => void };

const h = vi.hoisted(() => {
  const mutation = () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, variables: undefined, error: null as Error | null });
  return {
    store: { activeBranchId: 'b1' as string | null, activeBranch: null as { name: string } | null },
    periods: {} as Record<string, unknown>,
    settings: {} as Record<string, unknown>,
    rates: {} as Record<string, unknown>,
    runs: {} as Record<string, unknown>,
    create: mutation(),
    savePolicy: mutation(),
    createRate: mutation(),
    finalize: mutation(),
    exporter: mutation(),
    action: mutation(),
  };
});

vi.mock('@/hooks/queries/use-payroll', () => {
  class PayrollApiError extends Error {
    constructor(
      message: string,
      public readonly code: string | null,
      public readonly details?: unknown,
    ) {
      super(message);
    }
  }
  const loading = { data: undefined, isLoading: true, isError: false, error: null, refetch: () => undefined };
  return {
    PayrollApiError,
    usePayrollPeriods: (b: string) => h.periods[b] ?? loading,
    usePayrollSettings: (b: string) => h.settings[b] ?? loading,
    usePayRates: (b: string) => h.rates[b] ?? loading,
    usePayrollRun: (b: string, r: string) => h.runs[`${b}:${r}`] ?? loading,
    useCreatePayrollRun: () => h.create,
    useSavePayrollPolicy: () => h.savePolicy,
    useCreatePayRate: () => h.createRate,
    useVoidPayRate: () => h.action,
    useFinalizePayroll: () => h.finalize,
    usePayrollExport: () => h.exporter,
    usePayrollRunAction: () => h.action,
    useResolvePayrollIssue: () => h.action,
    useAddPayrollAdjustment: () => h.action,
    useVoidPayrollAdjustment: () => h.action,
  };
});
vi.mock('@/stores/branch.store', () => ({ useBranchStore: <T,>(select: (s: typeof h.store) => T) => select(h.store) }));
vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: () => ({ data: { branches: [{ id: 'b1', name: 'North', code: 'N' }, { id: 'b2', name: 'South', code: 'S' }] } }),
}));
vi.mock('@/components/reports/reports-section-tabs', () => ({ ReportsSectionTabs: () => <nav aria-label="Reports sections" /> }));
vi.mock('@/components/shared/branch-combobox', () => ({
  BranchCombobox: ({ branches, value, onChange }: { branches: Array<{ id: string; name: string }>; value?: string; onChange: (v: string) => void }) => (
    <select aria-label="Branch" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select…</option>
      {branches.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  ),
}));

const { PayrollPage } = await import('./payroll-page');
const { PayrollRunView } = await import('./payroll-run-view');
const { PayrollApiError } = await import('@/hooks/queries/use-payroll');

function ok<T>(data: T): Query<T> {
  return { data, isLoading: false, isError: false, error: null, refetch: vi.fn() };
}

const OCT_2 = period('2026-10-16', '2026-10-31');
const NOV_1 = period('2026-11-01', '2026-11-15');

function setBranch(branchId: string, opts: { configured: boolean; policy?: typeof POLICY | null; rates?: PayRatesResponse; periods?: PayrollPeriodsResponse['periods']; runs?: Record<string, PayrollRunDetail> }) {
  h.periods[branchId] = ok<PayrollPeriodsResponse>({ configured: opts.configured, periods: opts.periods ?? [], runs: [] });
  h.settings[branchId] = ok<PayrollSettingsResponse>(settingsFor(opts.policy === undefined ? POLICY : opts.policy, { id: branchId, name: branchId }));
  h.rates[branchId] = ok(opts.rates ?? ratesFor([employeeRate({ current_rate: rate('95.00', '2026-11-01') })], { id: branchId, name: branchId }));
  for (const [runId, detail] of Object.entries(opts.runs ?? {})) h.runs[`${branchId}:${runId}`] = ok(detail);
}

function rate(hourly: string, from: string) {
  return { id: `rate-${hourly}`, effective_from: from, hourly_rate: hourly, per_minute_display: '1.5833', reason: 'Set', created_by_name: 'Sol', created_at: '2026-10-01T00:00:00.000Z', voided_at: null, void_reason: null };
}

function chooseSelectOption(label: RegExp | string, option: RegExp | string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  h.store.activeBranchId = 'b1';
  h.store.activeBranch = { name: 'North' };
  for (const map of [h.periods, h.settings, h.rates, h.runs]) for (const k of Object.keys(map)) delete map[k];
  h.create.error = null;
});
afterEach(cleanup);

describe('Payroll page — one Payroll Settings entry', () => {
  it('has a single Payroll Settings button, no settings tab, and shows the branch once', () => {
    setBranch('b1', { configured: true, periods: [NOV_1, OCT_2] });
    render(<PayrollPage scope="supervisor" />);
    expect(screen.getAllByRole('button', { name: /Payroll Settings/ })).toHaveLength(1);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getAllByTestId('payroll-branch')).toHaveLength(1);
    expect(screen.getByTestId('payroll-branch').textContent).toMatch(/North/);
    expect(screen.getByText(/Attendance-based basic pay\. Statutory deductions, contributions and taxes are not included/)).toBeTruthy();
  });
});

describe('Payroll page — setup when needed', () => {
  it('shows a checklist for missing setup, opens the existing settings form and returns to payroll after saving', () => {
    setBranch('b1', { configured: false, policy: null, rates: ratesFor([employeeRate()]) });
    render(<PayrollPage scope="supervisor" />);

    const checklist = screen.getByTestId('payroll-setup-checklist');
    expect(checklist.getAttribute('data-ready')).toBe('false');
    for (const id of ['policy', 'period', 'breaks', 'rates']) expect(screen.getByTestId(`payroll-setup-${id}`).getAttribute('data-ready')).toBe('false');
    expect(within(checklist).getByText(/Their hours are not paid at ₱0/)).toBeTruthy();
    expect(screen.getByTestId('payroll-not-configured')).toBeTruthy();
    // Missing setup is never shown as zero pay, and no review step appears.
    expect(screen.queryByText('₱0.00')).toBeNull();
    expect(screen.queryByText('Choose pay period')).toBeNull();

    fireEvent.click(within(checklist).getByRole('button', { name: 'Set up branch payroll policy' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Payroll Settings' })).toBeTruthy();
    expect(screen.getByText('Not configured')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Business timezone'), { target: { value: 'Asia/Manila' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Monthly' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Breaks are unpaid' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    const [input, callbacks] = h.savePolicy.mutate.mock.calls[0] as [Record<string, unknown>, { onSuccess: () => void }];
    expect(input).toMatchObject({ timezone: 'Asia/Manila', period_type: 'monthly', break_treatment: 'unpaid', expected_version: 0 });

    act(() => callbacks.onSuccess());
    expect(screen.getByRole('heading', { level: 1, name: 'Payroll' })).toBeTruthy();
    expect(screen.getByTestId('payroll-setup-checklist')).toBeTruthy();
  });

  it('offers a direct Set rate action for staff without a rate, using the existing rate dialog', () => {
    setBranch('b1', { configured: true, periods: [NOV_1, OCT_2], rates: ratesFor([employeeRate()]) });
    render(<PayrollPage scope="supervisor" />);
    expect(screen.getByTestId('payroll-setup-rates').getAttribute('data-ready')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Set rate for Ana Reyes' }));
    expect(within(screen.getByRole('dialog')).getByText('Add hourly rate')).toBeTruthy();
  });

  it('collapses the checklist to one line when setup is ready', () => {
    setBranch('b1', { configured: true, periods: [NOV_1, OCT_2] });
    render(<PayrollPage scope="supervisor" />);
    const checklist = screen.getByTestId('payroll-setup-checklist');
    expect(checklist.tagName).toBe('DETAILS');
    expect(checklist.getAttribute('data-ready')).toBe('true');
    expect(within(checklist).getByText('Payroll setup is ready')).toBeTruthy();
  });
});

describe('Payroll page — choose period, review, finalize', () => {
  it('prepares a draft for the chosen period, reviews it and finalizes only after explicit confirmation', () => {
    setBranch('b1', { configured: true, periods: [NOV_1, OCT_2], runs: { 'run-9': runDetail({ id: 'run-9', period_start: '2026-11-01', period_end: '2026-11-15' }) } });
    render(<PayrollPage scope="supervisor" />);

    // Readable period labels with their status.
    expect(screen.getByRole('combobox', { name: 'Pay period' }).textContent).toMatch(/Oct 16–31, 2026 · Not started/);
    chooseSelectOption('Pay period', /Nov 1–15, 2026/);
    expect(screen.getByTestId('payroll-period-status').textContent).toBe('Not started');

    fireEvent.click(screen.getByRole('button', { name: 'Prepare draft payroll' }));
    const [input, callbacks] = h.create.mutate.mock.calls[0] as [{ period_start: string; period_end: string }, { onSuccess: (run: PayrollRunSummary) => void }];
    expect(input).toEqual({ period_start: '2026-11-01', period_end: '2026-11-15' });
    act(() => callbacks.onSuccess(runSummary({ id: 'run-9' })));

    expect(screen.getByText(/Review payroll · Nov 1–15, 2026/)).toBeTruthy();
    expect(screen.getByText(/Draft calculated Oct 30, 2026, 7:55 PM/)).toBeTruthy();
    const finalizeButton = screen.getByRole('button', { name: 'Finalize payroll…' });
    fireEvent.click(finalizeButton);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/North, Nov 1–15, 2026/)).toBeTruthy();
    expect(h.finalize.mutate).not.toHaveBeenCalled();
    expect((within(dialog).getByRole('button', { name: 'Finalize' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(h.finalize.mutate).not.toHaveBeenCalled();
  });

  it('keeps the chosen period after a failed request and after a trip to Payroll Settings', () => {
    setBranch('b1', { configured: true, periods: [NOV_1, OCT_2] });
    const { rerender } = render(<PayrollPage scope="supervisor" />);
    chooseSelectOption('Pay period', /Nov 1–15, 2026/);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare draft payroll' }));
    const error = new PayrollApiError('The server is busy.', 'SERVICE_UNAVAILABLE');
    h.create.error = error;
    const [, callbacks] = h.create.mutate.mock.calls[0] as [unknown, { onError: (e: Error) => void }];
    act(() => callbacks.onError(error));
    rerender(<PayrollPage scope="supervisor" />);
    expect(screen.getByRole('alert').textContent).toMatch(/The draft was not prepared\. The server is busy\./);
    expect(screen.getByRole('combobox', { name: 'Pay period' }).textContent).toMatch(/Nov 1–15, 2026/);

    fireEvent.click(screen.getByRole('button', { name: /Payroll Settings/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to payroll' })[0] as HTMLElement);
    expect(screen.getByRole('combobox', { name: 'Pay period' }).textContent).toMatch(/Nov 1–15, 2026/);
  });

  it('keeps policy form entries when saving fails', () => {
    setBranch('b1', { configured: true, periods: [OCT_2] });
    render(<PayrollPage scope="supervisor" />);
    fireEvent.click(screen.getByRole('button', { name: /Payroll Settings/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Paid up to a limit per shift' }));
    fireEvent.change(screen.getByLabelText('Paid break minutes per shift'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Reason for change (optional)'), { target: { value: 'New rule' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(h.savePolicy.mutate).toHaveBeenCalledTimes(1);
    // The request failed (onSuccess never runs): still on Settings with the entries intact.
    expect(screen.getByRole('heading', { level: 1, name: 'Payroll Settings' })).toBeTruthy();
    expect((screen.getByLabelText('Paid break minutes per shift') as HTMLInputElement).value).toBe('20');
    expect((screen.getByLabelText('Reason for change (optional)') as HTMLInputElement).value).toBe('New rule');
  });

  it('shows the rates in effect during the period, not today’s rate, and explains a rate change', () => {
    const detail = runDetail({
      employees: [
        {
          ...baseEmployee(),
          rate_lines: [
            { hourly_rate: '75.00', rate_id: 'r1', effective_from: '2026-10-01', payable_ms: 4 * 3_600_000, amount: '300.00' },
            { hourly_rate: '80.00', rate_id: 'r2', effective_from: '2026-10-20', payable_ms: 4 * 3_600_000, amount: '320.00' },
          ],
          basic_pay: '620.00',
          calculated_total: '620.00',
        },
      ],
    });
    setBranch('b1', { configured: true, periods: [NOV_1, period('2026-10-16', '2026-10-31', [runSummary()])], runs: { 'run-1': detail } });
    render(<PayrollPage scope="supervisor" />);
    const table = screen.getByTestId('payroll-review-table');
    expect(within(table).getByText(/₱75\.00\/h/)).toBeTruthy();
    expect(within(table).getByText(/₱80\.00\/h/)).toBeTruthy();
    expect(within(table).getByText(/from Oct 20, 2026/)).toBeTruthy();
    expect(within(table).getByText(/The rate changed during this period/)).toBeTruthy();
    // Today's rate (₱95.00) from settings is not used in the review.
    expect(within(table).queryByText(/₱95\.00/)).toBeNull();
    // The review table is the employee list: no second employee list on the page.
    expect(screen.queryByTestId('payroll-employees')).toBeNull();
  });

  it('marks time without a rate as needing a rate instead of zero pay', () => {
    const detail = runDetail({
      can_finalize: false,
      blocking_count: 1,
      issues: [{ key: 'k1', code: 'RATE_MISSING', severity: 'blocking', message: 'No hourly rate', employee_id: 'e1', attendance_record_id: null, business_date: '2026-10-16', resolution: null }],
      employees: [{ ...baseEmployee(), rate_lines: [], basic_pay: '0.00', calculated_total: '0.00', issue_keys: ['k1'] }],
    });
    setBranch('b1', { configured: true, periods: [NOV_1, period('2026-10-16', '2026-10-31', [runSummary()])], runs: { 'run-1': detail } });
    render(<PayrollPage scope="supervisor" />);
    const table = screen.getByTestId('payroll-review-table');
    expect(within(table).getByText('Needs a rate')).toBeTruthy();
    expect(within(table).getByText('No rate for this period')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Finalize payroll…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens a finalized run read-only: no finalize, discard or adjustment controls', () => {
    const finalized = runSummary({ status: 'finalized', finalized_by_name: 'Sol North', calculated_total: '640.00' });
    setBranch('b1', {
      configured: true,
      periods: [NOV_1, period('2026-10-16', '2026-10-31', [finalized])],
      runs: { 'run-1': runDetail({ status: 'finalized', basis: 'finalized_snapshot', finalized_by_name: 'Sol North', can_finalize: false }) },
    });
    render(<PayrollPage scope="supervisor" />);
    expect(screen.getByTestId('payroll-period-status').textContent).toBe('Finalized');
    expect(screen.getByText(/Read-only\. Finalized by Sol North/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Finalize payroll…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prepare draft payroll' })).toBeNull();
    fireEvent.click(within(screen.getByTestId('payroll-review-table')).getByRole('button', { name: 'Details for Ana Reyes' }));
    expect(screen.queryByRole('button', { name: /Add adjustment/ })).toBeNull();
  });
});

describe('Payroll page — branch isolation', () => {
  it('never shows the previous branch’s payroll after switching branches', () => {
    setBranch('b1', { configured: true, periods: [NOV_1, period('2026-10-16', '2026-10-31', [runSummary()])], runs: { 'run-1': runDetail() } });
    const { rerender } = render(<PayrollPage scope="supervisor" />);
    expect(within(screen.getByTestId('payroll-review-table')).getByText('Ana Reyes')).toBeTruthy();

    // South has not loaded yet.
    h.store.activeBranchId = 'b2';
    h.store.activeBranch = { name: 'South' };
    rerender(<PayrollPage scope="supervisor" />);
    expect(screen.queryByText('Ana Reyes')).toBeNull();
    expect(screen.getByText(/Loading payroll/)).toBeTruthy();
    expect(screen.getByTestId('payroll-branch').textContent).toMatch(/South/);

    // South loads with its own (empty) periods: still nothing from North.
    setBranch('b2', { configured: true, periods: [period('2026-11-01', '2026-11-15'), period('2026-10-16', '2026-10-31')] });
    rerender(<PayrollPage scope="supervisor" />);
    expect(screen.queryByText('Ana Reyes')).toBeNull();
    expect(screen.queryByTestId('payroll-review-table')).toBeNull();
  });

  it('refuses to render a run whose branch does not match the selected branch', () => {
    h.runs['b2:run-1'] = ok(runDetail({ branch_id: 'b1' }));
    render(<PayrollRunView branchId="b2" runId="run-1" onOpenRun={vi.fn()} />);
    expect(screen.queryByText('Ana Reyes')).toBeNull();
    expect(screen.getByText('Could not load this payroll')).toBeTruthy();
  });

  it('keeps the Admin payroll report working with its own branch picker', () => {
    setBranch('b2', { configured: true, periods: [NOV_1, period('2026-10-16', '2026-10-31', [runSummary({ branch_id: 'b2' })])], runs: { 'run-1': runDetail({ branch_id: 'b2' }) } });
    render(<PayrollPage scope="admin" />);
    expect(screen.getByText('Select a branch')).toBeTruthy();
    expect(screen.queryByTestId('payroll-branch')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Branch' }), { target: { value: 'b2' } });
    expect(within(screen.getByTestId('payroll-review-table')).getByText('Ana Reyes')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Payroll Settings/ })).toHaveLength(1);
  });
});

describe('Payroll page — accessibility and phone layout', () => {
  it('uses native, focusable buttons for the primary controls', () => {
    setBranch('b1', { configured: true, periods: [NOV_1, period('2026-10-16', '2026-10-31', [runSummary()])], runs: { 'run-1': runDetail() } });
    render(<PayrollPage scope="supervisor" />);
    const controls = [
      screen.getByRole('button', { name: /Payroll Settings/ }),
      screen.getByRole('combobox', { name: 'Pay period' }),
      within(screen.getByTestId('payroll-review-table')).getByRole('button', { name: 'Details for Ana Reyes' }),
      screen.getByRole('button', { name: 'Finalize payroll…' }),
    ];
    for (const control of controls) {
      expect(control.tagName).toBe('BUTTON');
      control.focus();
      expect(document.activeElement).toBe(control);
    }
    const details = within(screen.getByTestId('payroll-review-table')).getByRole('button', { name: 'Details for Ana Reyes' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Payroll details for Ana Reyes' }));
  });

  it('renders readable cards on phones and a compact table from md up', () => {
    setBranch('b1', { configured: true, periods: [NOV_1, period('2026-10-16', '2026-10-31', [runSummary()])], runs: { 'run-1': runDetail() } });
    render(<PayrollPage scope="supervisor" />);
    const cards = screen.getByTestId('payroll-review-cards');
    const table = screen.getByTestId('payroll-review-table');
    expect(cards.className).toMatch(/\bmd:hidden\b/);
    expect(table.className).toMatch(/\bhidden\b/);
    expect(table.className).toMatch(/\bmd:block\b/);
    expect(within(cards).getByText('Ana Reyes')).toBeTruthy();
    expect(within(cards).getByText('Recorded hours')).toBeTruthy();
    expect(within(cards).getByRole('button', { name: 'Details for Ana Reyes' })).toBeTruthy();
  });
});
