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
  ManualDiscountTypeSaveError: class extends Error {},
}));
vi.mock('@/hooks/use-selected-branch', () => ({
  useSelectedBranch: () => ({ availableBranches: [{ id: 'branch-1', name: 'North' }] }),
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

  it('creates a type with name and switches only; a statutory name is refused before saving', () => {
    render(<ManualDiscountTypesSection />);
    expect(screen.getByTestId('manual-types-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New discount type/ }));
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Senior Citizen' } });
    expect(document.getElementById('manual-type-name-error')).toHaveTextContent(/set by law/);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.change(name, { target: { value: 'Loyalty card' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Require proof photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(mockCreate).toHaveBeenCalledWith({ branch_id: 'branch-1', name: 'Loyalty card', apply_to_pos: true, require_proof: true }, expect.anything());
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
    expect(mockUpdate).toHaveBeenCalledWith({ id: '11111111-1111-4111-8111-111111111111', expected_version: 4, require_proof: false }, expect.anything());
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
