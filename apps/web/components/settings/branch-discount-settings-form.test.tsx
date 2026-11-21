import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { BranchDiscountSettingsResponse } from '@potato-corner/shared';

/**
 * POS-PERF-P50R — one branch's Discounts form. POS-PERF-P63 — VAT retired:
 * only the required-choice switch remains; stored override rates are re-sent
 * unchanged on save; stale-save explanation; read-only for non-editors.
 */
const { mockSave, mockSaveTax, MockSettingsSaveError } = vi.hoisted(() => {
  class MockSettingsSaveError extends Error {
    constructor(
      message: string,
      public readonly code: string | null,
    ) {
      super(message);
    }
  }
  return { mockSave: vi.fn(), mockSaveTax: vi.fn(), MockSettingsSaveError };
});

vi.mock('@/hooks/queries/use-settings', () => ({
  useUpdateBranchDiscountSettings: () => ({ mutate: mockSave, isPending: false }),
  useUpdateBranchTaxProfile: () => ({ mutate: mockSaveTax, isPending: false }),
  SettingsSaveError: MockSettingsSaveError,
}));

const { BranchDiscountSettingsForm } = await import('./branch-discount-settings-form');

const BRANCH = '33333333-3333-4333-8333-333333333333';
const SAVED_AT = '2026-10-30T01:00:00.000Z';

function data(overrides: Partial<BranchDiscountSettingsResponse> = {}): BranchDiscountSettingsResponse {
  return {
    branchId: BRANCH,
    branchName: 'Main',
    organization: {
      pwd: { percentage: 20, isEnabled: true },
      senior_citizen: { percentage: 20, isEnabled: true },
      employee: { percentage: 20, isEnabled: true },
      updatedAt: null,
    },
    override: null,
    effective: {
      pwd: { percentage: 20, isEnabled: true, source: 'statute' },
      senior_citizen: { percentage: 20, isEnabled: true, source: 'statute' },
      employee: { percentage: 20, isEnabled: true, source: 'organization' },
      requireDiscountChoice: false,
    },
    taxProfile: { branchId: BRANCH, vatRegistration: 'unconfirmed', note: null, calculatedAs: 'vat_registered', updatedAt: null, updatedBy: null },
    updatedAt: null,
    updatedBy: null,
    canEdit: true,
    canEditTaxProfile: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BranchDiscountSettingsForm (P50R)', () => {
  // POS-PERF-P63 — VAT retired: the PWD/Senior/Employee rate editors and the
  // statutory preview are gone. Only the required-choice switch remains.
  it('renders only the "Cashier must choose a discount" switch; no rate inputs or preview', () => {
    render(<BranchDiscountSettingsForm data={data()} />);
    const form = screen.getByTestId(`branch-discount-form-${BRANCH}`);
    expect(within(form).getByRole('switch', { name: 'Cashier must choose a discount' })).toBeInTheDocument();
    expect(within(form).getAllByRole('switch')).toHaveLength(1);
    expect(within(form).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(form).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(form).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('PWD')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Employee')).not.toBeInTheDocument();
    expect(screen.queryByTestId('branch-row-senior')).not.toBeInTheDocument();
    expect(screen.queryByTestId('branch-row-pwd')).not.toBeInTheDocument();
    expect(screen.queryByTestId('branch-row-employee')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discount-preview')).not.toBeInTheDocument();
    expect(form.textContent).not.toMatch(/Senior Citizen|\bPWD\b|RA 9994|RA 10754/);
  });

  it('Save is disabled until the switch changes, and enabled again only while it differs', () => {
    render(<BranchDiscountSettingsForm data={data()} />);
    const save = screen.getByRole('button', { name: 'Save for Main' });
    expect(save).toBeDisabled();
    const toggle = screen.getByRole('switch', { name: 'Cashier must choose a discount' });
    fireEvent.click(toggle);
    expect(save).toBeEnabled();
    fireEvent.click(toggle);
    expect(save).toBeDisabled();
  });

  it('with no override, saves null rates plus the new requireDiscountChoice and the version it loaded', () => {
    render(<BranchDiscountSettingsForm data={data()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Cashier must choose a discount' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save for Main' }));
    expect(mockSave).toHaveBeenCalledWith(
      { pwdPercentage: null, employee: null, requireDiscountChoice: true, expectedUpdatedAt: null },
      expect.any(Object),
    );
  });

  it('re-sends the stored override rates unchanged (never reset), changing only requireDiscountChoice', () => {
    render(
      <BranchDiscountSettingsForm
        data={data({ override: { employee: { percentage: 5, isEnabled: false }, pwdPercentage: 25, requireDiscountChoice: true }, updatedAt: SAVED_AT })}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'Cashier must choose a discount' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save for Main' }));
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith(
      { pwdPercentage: 25, employee: { percentage: 5, isEnabled: false }, requireDiscountChoice: false, expectedUpdatedAt: SAVED_AT },
      expect.any(Object),
    );
  });

  it('POS-PERF-P59 — no VAT registration section or VAT wording, for a Super Admin either', () => {
    render(<BranchDiscountSettingsForm data={data({ canEditTaxProfile: true })} />);
    expect(screen.queryByText(/registration/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bVAT\b|VAT-exempt/);
  });

  it('a stale save explains that someone else changed the branch', () => {
    mockSave.mockImplementationOnce((_input: unknown, options: { onError: (error: Error) => void }) => options.onError(new MockSettingsSaveError('changed', 'SETTINGS_CHANGED')));
    render(<BranchDiscountSettingsForm data={data()} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Cashier must choose a discount' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save for Main' }));
    expect(screen.getByTestId('branch-discount-conflict')).toHaveTextContent("Someone else changed Main's discounts");
  });

  it('read-only when the caller cannot edit', () => {
    render(<BranchDiscountSettingsForm data={data({ canEdit: false })} />);
    expect(screen.queryByRole('button', { name: 'Save for Main' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Cashier must choose a discount' })).toBeDisabled();
  });
});
