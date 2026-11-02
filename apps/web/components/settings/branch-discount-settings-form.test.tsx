import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { BranchDiscountSettingsResponse } from '@potato-corner/shared';

/**
 * POS-PERF-P50R — one branch's Discounts form: organization default vs
 * branch value per field, statutory bounds explained, the required-choice
 * switch, VAT registration shown as an explicit assumption (Super Admin
 * records it; non-VAT cannot be chosen), stale-save explanation.
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
  it('starts on the organization defaults; Save is disabled until something changes', () => {
    render(<BranchDiscountSettingsForm data={data()} />);
    expect(screen.getByLabelText('PWD')).toBeDisabled();
    expect(screen.getByLabelText('Employee')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save for Main' })).toBeDisabled();
    expect(within(screen.getByTestId('branch-row-senior')).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByTestId('branch-row-senior')).toHaveTextContent('exactly 20%');
  });

  it('sets a branch Employee rate and the required choice, sending the version it loaded', () => {
    render(<BranchDiscountSettingsForm data={data()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Employee uses the organization default' }));
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Cashier must choose a discount' }));
    // The preview recomputes with the branch values (₱112 − 10% = ₱100.80).
    expect(screen.getByTestId('discount-preview')).toHaveTextContent('Employee (10%)');
    expect(screen.getByTestId('discount-preview')).toHaveTextContent('₱100.80');
    fireEvent.click(screen.getByRole('button', { name: 'Save for Main' }));
    expect(mockSave).toHaveBeenCalledWith(
      { pwdPercentage: null, employee: { percentage: 10, isEnabled: true }, requireDiscountChoice: true, expectedUpdatedAt: null },
      expect.any(Object),
    );
  });

  it('PWD can be raised but not set below 20%; the preview shows the amount to pay', () => {
    render(<BranchDiscountSettingsForm data={data()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'PWD uses the organization default' }));
    fireEvent.change(screen.getByLabelText('PWD'), { target: { value: '15' } });
    expect(screen.getByText(/does not allow less than 20%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save for Main' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('PWD'), { target: { value: '25' } });
    // ₱112 → 25% statutory calculation → ₱75.00 (computeSaleTax, unchanged).
    const preview = screen.getByTestId('discount-preview');
    const pwdRow = within(preview).getByText('PWD (25%)').closest('tr') as HTMLElement;
    expect(pwdRow).toHaveTextContent('₱75.00');
    fireEvent.click(screen.getByRole('button', { name: 'Save for Main' }));
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ pwdPercentage: 25, employee: null }), expect.any(Object));
  });

  it('returning a field to the organization default sends null for it', () => {
    render(
      <BranchDiscountSettingsForm
        data={data({ override: { employee: { percentage: 5, isEnabled: false }, pwdPercentage: null, requireDiscountChoice: false }, updatedAt: SAVED_AT })}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Employee uses the organization default' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save for Main' }));
    expect(mockSave).toHaveBeenCalledWith({ pwdPercentage: null, employee: null, requireDiscountChoice: false, expectedUpdatedAt: SAVED_AT }, expect.any(Object));
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
