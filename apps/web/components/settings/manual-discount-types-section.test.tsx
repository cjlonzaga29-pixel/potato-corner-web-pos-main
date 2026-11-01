import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ManualDiscountTypeResponse } from '@potato-corner/shared';

/**
 * POS-PERF-P55 — Settings → Discount types: name + Apply to POS + Require
 * proof photo, Edit and Deactivate; statutory names refused in the editor;
 * turning a required proof off needs an explicit confirmation; read-only for
 * anyone but a supervisor; edits carry the loaded version.
 */
const { mockCreate, mockUpdate, mockDeactivate, typesState, authState } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockDeactivate: vi.fn(),
  typesState: { data: [] as ManualDiscountTypeResponse[] },
  authState: { role: 'supervisor' },
}));

vi.mock('@/hooks/queries/use-manual-discount-types', () => ({
  useManualDiscountTypes: () => ({ data: typesState.data, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useCreateManualDiscountType: () => ({ mutate: mockCreate, isPending: false }),
  useUpdateManualDiscountType: () => ({ mutate: mockUpdate, isPending: false }),
  useDeactivateManualDiscountType: () => ({ mutate: mockDeactivate, isPending: false }),
  useDiscountEligibleProducts: (branchIds: string[]) => ({
    data: branchIds.length > 0 ? [{ id: 'p1', name: 'Fries' }, { id: 'p2', name: 'Fries Large' }, { id: 'p3', name: 'Water' }] : undefined,
    isError: false,
    refetch: vi.fn(),
  }),
  ManualDiscountTypeSaveError: class extends Error {},
}));
vi.mock('@/hooks/use-selected-branch', () => ({
  useSelectedBranch: () => ({ availableBranches: [{ id: 'branch-1', name: 'North' }, { id: 'branch-2', name: 'South' }] }),
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { role: authState.role } }) }));

const { ManualDiscountTypesSection } = await import('./manual-discount-types-section');

function type(overrides: Partial<ManualDiscountTypeResponse> = {}): ManualDiscountTypeResponse {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    branch_id: 'branch-1',
    name: 'Employee',
    apply_to_pos: true,
    require_proof: true,
    is_active: true,
    version: 4,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    deactivated_at: null,
    sale_count: 2,
    can_edit: true,
    amount_mode: 'manual',
    fixed_amount: null,
    product_scope: 'all',
    product_ids: [],
    branch_ids: ['branch-1'],
    ...overrides,
  };
}

beforeEach(() => {
  authState.role = 'supervisor';
  typesState.data = [];
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockDeactivate.mockReset();
});
afterEach(() => cleanup());

describe('ManualDiscountTypesSection', () => {
  it('lists types with their switches, use count and deactivated history; no rate or amount anywhere', () => {
    typesState.data = [type(), type({ id: '2', name: 'Old promo', is_active: false, can_edit: false, sale_count: 7, apply_to_pos: false })];
    render(<ManualDiscountTypesSection />);
    const row = screen.getByTestId('manual-type-11111111-1111-4111-8111-111111111111');
    expect(within(row).getByText('Employee')).toBeInTheDocument();
    expect(within(row).getByText('On POS')).toBeInTheDocument();
    expect(within(row).getByText('Proof photo required')).toBeInTheDocument();
    expect(within(row).getByText('Used in 2 sales')).toBeInTheDocument();
    expect(screen.getByText(/Old promo — kept for 7 past sales/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('creates a staff-entered type by default; a statutory-looking name gets a notice, not a refusal', () => {
    render(<ManualDiscountTypesSection />);
    expect(screen.getByTestId('manual-types-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New discount type/ }));
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Senior Citizen' } });
    expect(document.getElementById('manual-type-name-notice')).toHaveTextContent(/does not apply or verify/);
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    fireEvent.change(name, { target: { value: 'Loyalty card' } });
    expect(document.getElementById('manual-type-name-notice')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Require proof photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(mockCreate).toHaveBeenCalledWith(
      { branch_ids: ['branch-1'], name: 'Loyalty card', apply_to_pos: true, require_proof: true, amount_mode: 'manual', fixed_amount: null, product_scope: 'all', product_ids: [] },
      expect.anything(),
    );
  });

  it('a fixed amount is required, and saved as entered', () => {
    render(<ManualDiscountTypesSection />);
    fireEvent.click(screen.getByRole('button', { name: /New discount type/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Voucher' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Fixed peso amount' }));
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Amount (₱)'), { target: { value: '10%' } });
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Amount (₱)'), { target: { value: '25.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ amount_mode: 'fixed', fixed_amount: 25.5 });
  });

  it('branches: select all, clear, count and partial state', () => {
    render(<ManualDiscountTypesSection />);
    fireEvent.click(screen.getByRole('button', { name: /New discount type/ }));
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument();
    const all = screen.getByRole('checkbox', { name: 'Select all 2 branches' });
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    fireEvent.click(all);
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();
    expect(all).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Everywhere' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByText('0 of 2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('products: Select all during a search covers those results only; earlier ticks stay', () => {
    render(<ManualDiscountTypesSection />);
    fireEvent.click(screen.getByRole('button', { name: /New discount type/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Limited' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Only the products I choose' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Water' }));
    fireEvent.change(screen.getByPlaceholderText('Search products…'), { target: { value: 'fries' } });
    expect(screen.getByText(/applies to these search results only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all 2 products shown' }));
    expect(screen.getByText('3 of 3 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const sent = mockCreate.mock.calls[0]?.[0] as { product_scope: string; product_ids: string[] };
    expect(sent.product_scope).toBe('selected');
    expect([...sent.product_ids].sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('turning a required proof off needs an explicit confirmation, and the save carries the loaded version', () => {
    typesState.data = [type()];
    render(<ManualDiscountTypesSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Require proof photo' }));
    expect(screen.getByText(/currently requires a proof photo/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm proof photo is no longer required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: '11111111-1111-4111-8111-111111111111', expected_version: 4, require_proof: false, branch_ids: ['branch-1'] }),
      expect.anything(),
    );
  });

  it('deactivates after a confirmation that says history is kept', () => {
    typesState.data = [type()];
    render(<ManualDiscountTypesSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(screen.getByText(/Past sales that used it keep their records and proof photos/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Deactivate' }));
    expect(mockDeactivate).toHaveBeenCalledWith({ id: '11111111-1111-4111-8111-111111111111', expected_version: 4 });
  });

  it('is read-only for a Super Admin', () => {
    authState.role = 'super_admin';
    typesState.data = [type({ can_edit: false })];
    render(<ManualDiscountTypesSection />);
    expect(screen.queryByRole('button', { name: /New discount type/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByText('Discount types are managed by the supervisors of each branch.')).toBeInTheDocument();
  });
});
