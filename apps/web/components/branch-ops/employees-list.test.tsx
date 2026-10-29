import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { EmployeeResponse } from '@potato-corner/shared';

const { mockUseEmployees, mockUsePinStatus } = vi.hoisted(() => ({
  mockUseEmployees: vi.fn(),
  mockUsePinStatus: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/queries/use-employees', () => ({ useEmployees: mockUseEmployees }));
vi.mock('@/hooks/queries/use-staff-pin', () => ({ useStaffPinStatus: mockUsePinStatus }));
vi.mock('@/stores/branch.store', () => ({
  useBranchStore: (selector: (s: { activeBranchId: string }) => unknown) => selector({ activeBranchId: 'branch-1' }),
}));
vi.mock('@/components/supervisor/employees/create-employee-dialog', () => ({ SupervisorCreateEmployeeDialog: () => null }));
vi.mock('@/components/supervisor/employees/edit-employee-dialog', () => ({ SupervisorEditEmployeeDialog: () => null }));
vi.mock('@/components/supervisor/employees/set-employee-status-dialog', () => ({ SetEmployeeStatusDialog: () => null }));
vi.mock('@/components/supervisor/employees/manage-staff-pin-dialog', () => ({ ManageStaffPinDialog: () => null }));
vi.mock('@/components/supervisor/employees/remove-employee-dialog', () => ({ RemoveEmployeeDialog: () => null }));

import { EmployeesList } from './employees-list';

function employee(id: string, first: string, role: 'staff' | 'supervisor', branch = 'branch-1'): EmployeeResponse {
  return {
    id,
    first_name: first,
    last_name: 'Test',
    role,
    status: 'active',
    position: role === 'staff' ? 'Cashier' : null,
    employment_type: 'regular',
    last_login_at: null,
    branch_assignments: [{ branch_id: branch, branch_name: branch, branch_code: branch, assigned_at: '2026-10-01T00:00:00.000Z' }],
  } as unknown as EmployeeResponse;
}

const PIN_BY_ID: Record<string, { has_pin: boolean; is_active: boolean } | undefined> = {
  withPin: { has_pin: true, is_active: true },
  noPin: { has_pin: false, is_active: false },
  pinOff: { has_pin: true, is_active: false },
};

beforeEach(() => {
  mockUseEmployees.mockReturnValue({
    data: {
      employees: [
        employee('withPin', 'Wanda', 'staff'),
        employee('noPin', 'Nora', 'staff'),
        employee('pinOff', 'Otto', 'staff'),
        employee('sup', 'Sam', 'supervisor'),
        employee('other', 'Olga', 'staff', 'branch-2'),
      ],
      total: 5,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUsePinStatus.mockImplementation((id: string, enabled: boolean) => ({
    isLoading: false,
    isError: false,
    data: enabled ? PIN_BY_ID[id] : undefined,
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function rowOf(name: string): HTMLElement {
  return screen.getByText(`${name} Test`).closest('tr') as HTMLElement;
}

describe('EmployeesList PIN and management actions (POS-PERF-P47)', () => {
  it('labels PIN state without exposing it and matches the button to it', () => {
    render(<EmployeesList basePath="/supervisor" />);
    expect(within(rowOf('Wanda')).getByText('PIN set')).toBeInTheDocument();
    expect(within(rowOf('Wanda')).getByRole('button', { name: 'Reset PIN for Wanda Test' })).toBeInTheDocument();
    expect(within(rowOf('Nora')).getByText('No PIN')).toBeInTheDocument();
    expect(within(rowOf('Nora')).getByRole('button', { name: 'Set PIN for Nora Test' })).toBeInTheDocument();
    expect(within(rowOf('Otto')).getByText('PIN off')).toBeInTheDocument();
    expect(within(rowOf('Otto')).getByRole('button', { name: 'Set PIN for Otto Test' })).toBeInTheDocument();
  });

  it('shows Edit and Delete for staff rows, and no management actions for a supervisor row', () => {
    render(<EmployeesList basePath="/supervisor" />);
    expect(within(rowOf('Nora')).getByRole('button', { name: 'Edit Nora Test' })).toBeInTheDocument();
    expect(within(rowOf('Nora')).getByRole('button', { name: 'Delete or deactivate Nora Test' })).toBeInTheDocument();
    const sam = rowOf('Sam');
    expect(within(sam).getByText('Managed by Super Admin')).toBeInTheDocument();
    expect(within(sam).queryByRole('button')).not.toBeInTheDocument();
  });

  it('never queries PIN status for non-staff rows', () => {
    render(<EmployeesList basePath="/supervisor" />);
    expect(mockUsePinStatus).toHaveBeenCalledWith('sup', false);
  });

  it('scopes the list to the active branch and never shows another branch’s rows', () => {
    render(<EmployeesList basePath="/supervisor" />);
    expect(mockUseEmployees).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'branch-1' }), { enabled: true });
    expect(screen.queryByText('Olga Test')).not.toBeInTheDocument();
  });
});
