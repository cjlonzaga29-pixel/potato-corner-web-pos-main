import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { EmployeeResponse } from '@potato-corner/shared';

const { mockEligibility, mockDelete, mockForget, mockToast } = vi.hoisted(() => ({
  mockEligibility: vi.fn(),
  mockDelete: vi.fn(),
  mockForget: vi.fn(),
  mockToast: { success: vi.fn(), message: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('@/hooks/queries/use-employees', () => {
  class EmployeeApiError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    EmployeeApiError,
    forgetDeletedEmployee: mockForget,
    useEmployeeDeletionEligibility: mockEligibility,
    useDeleteEmployee: () => ({ mutateAsync: mockDelete, isPending: false }),
  };
});

import { RemoveEmployeeDialog } from './remove-employee-dialog';
import { EmployeeApiError } from '@/hooks/queries/use-employees';

const NO_HISTORY = { sales: 0, shifts: 0, attendance: 0, audit: 0, inventory: 0, expenses: 0, catalog: 0, settings: 0, pin_use: 0, payroll: 0 };
const NO_PREREQUISITES = {
  open_shifts: [],
  open_attendance: [],
  held_orders: 0,
  pending_inventory_approvals: 0,
  branches: [{ id: 'b1', name: 'SM North' }],
  branches_left_without_supervisor: [],
  unpaid_payroll: [],
};
const VERSION = '2026-11-20T03:04:05.678Z';
const CONFIRMATION = { name: 'Ana Reyes', version: VERSION };

const EMPLOYEE = {
  id: '00000000-0000-4000-8000-0000000000e1',
  first_name: 'Ana',
  last_name: 'Reyes',
  role: 'staff',
  status: 'active',
} as unknown as EmployeeResponse;

function deletable(overrides: Record<string, unknown> = {}) {
  return {
    can_delete: true,
    blocked_reason: null,
    mode: 'permanent',
    references: { ...NO_HISTORY, sales: 12, attendance: 3 },
    prerequisites: NO_PREREQUISITES,
    confirmation: CONFIRMATION,
    ...overrides,
  };
}

const refetch = vi.fn();
function eligibilityReturns(data: unknown) {
  mockEligibility.mockReturnValue({ isLoading: false, isError: false, data, refetch });
}

function renderDialog(ui: ReactElement) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function confirm(name = 'Ana Reyes') {
  fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: name } });
  fireEvent.click(screen.getByRole('checkbox'));
}

beforeEach(() => {
  mockDelete.mockResolvedValue({ deleted: true, outcome: 'deleted' });
  refetch.mockResolvedValue({ data: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RemoveEmployeeDialog (POS-PERF-P66 permanent delete)', () => {
  it('states plainly what is removed and what stays, including history counts', () => {
    eligibilityReturns(deletable());
    renderDialog(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} />);
    expect(screen.getByText(/Permanently delete Ana Reyes\? This cannot be undone in the application\./)).toBeInTheDocument();
    expect(screen.getByText(/Past business records will remain, but this account cannot be restored\./)).toBeInTheDocument();
    expect(screen.getByText(/Branch access \(SM North\)/)).toBeInTheDocument();
    expect(screen.getByText(/12 sales or checkouts, 3 attendance records/)).toBeInTheDocument();
    expect(screen.queryByText(/backup/i)).toBeNull();
  });

  it('enables Delete only after the exact name is typed and the acknowledgment is ticked, then sends both', async () => {
    eligibilityReturns(deletable());
    const onDeleted = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog(<RemoveEmployeeDialog open onOpenChange={onOpenChange} employee={EMPLOYEE} onDeleted={onDeleted} />);
    const button = screen.getByRole('button', { name: 'Delete permanently' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: 'Ana Reye' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/to confirm/i), { target: { value: '  ana   REYES ' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(mockDelete).toHaveBeenCalledWith({ confirm_name: '  ana   REYES ', version: VERSION });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Cancel sends nothing', () => {
    eligibilityReturns(deletable());
    const onOpenChange = vi.fn();
    renderDialog(<RemoveEmployeeDialog open onOpenChange={onOpenChange} employee={EMPLOYEE} />);
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('a double click sends one request', async () => {
    eligibilityReturns(deletable());
    let resolve: (value: unknown) => void = () => undefined;
    mockDelete.mockReturnValue(new Promise((r) => (resolve = r)));
    renderDialog(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} />);
    confirm();
    const button = screen.getByRole('button', { name: 'Delete permanently' });
    fireEvent.click(button);
    fireEvent.click(button);
    resolve({ deleted: true, outcome: 'deleted' });
    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
  });

  it('a lost response is checked with the server and reported as deleted when it went through', async () => {
    eligibilityReturns(deletable());
    mockDelete.mockRejectedValue(new TypeError('Failed to fetch'));
    refetch.mockResolvedValue({ data: { ...deletable(), can_delete: false, blocked_reason: 'already_deleted', confirmation: null } });
    const onDeleted = vi.fn();
    renderDialog(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} onDeleted={onDeleted} />);
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(mockForget).toHaveBeenCalled();
    expect(mockToast.success).toHaveBeenCalledWith('Account permanently deleted');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a server refusal inline and keeps the dialog open; a changed account clears the typed name', async () => {
    eligibilityReturns(deletable());
    mockDelete.mockRejectedValue(new EmployeeApiError('This account changed after the dialog opened.', 'EMPLOYEE_CHANGED'));
    refetch.mockResolvedValue({ data: deletable() });
    const onOpenChange = vi.fn();
    renderDialog(<RemoveEmployeeDialog open onOpenChange={onOpenChange} employee={EMPLOYEE} />);
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByText('This account changed after the dialog opened.')).toBeInTheDocument();
    expect(screen.getByLabelText(/to confirm/i)).toHaveValue('');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('explains open work and unpaid payroll with what to do, and offers no Delete', () => {
    eligibilityReturns(
      deletable({
        can_delete: false,
        blocked_reason: 'open_operations',
        prerequisites: {
          ...NO_PREREQUISITES,
          open_shifts: [{ id: 's1', branch_name: 'SM North' }],
          unpaid_payroll: [{ branch_id: 'b1', branch_name: 'SM North', first_date: '2026-11-16', last_date: '2026-11-19', records: 4 }],
        },
      }),
    );
    renderDialog(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} />);
    expect(screen.getByText(/Close the open shift at SM North/)).toBeInTheDocument();
    expect(screen.getByText(/Finalize payroll at SM North for the hours recorded from Nov 16, 2026 to Nov 19, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
  });

  it('never offers Delete for a branch account or through a server that cannot confirm it', () => {
    eligibilityReturns(deletable({ can_delete: false, blocked_reason: 'branch_account', confirmation: null }));
    renderDialog(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} />);
    expect(screen.getByText(/Branch accounts follow their branch/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
    cleanup();

    // A pre-P66 API: offers the old keep-the-row removal and no confirmation.
    eligibilityReturns({ can_delete: true, blocked_reason: null, mode: 'remove_keep_history', references: NO_HISTORY, prerequisites: NO_PREREQUISITES });
    renderDialog(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} />);
    expect(screen.getByText(/can’t confirm a permanent delete right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
  });

  it('reports an account that is already deleted', () => {
    eligibilityReturns({ can_delete: false, blocked_reason: 'already_deleted', references: null, mode: null, prerequisites: null, confirmation: null });
    renderDialog(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} />);
    expect(screen.getByText(/already been permanently deleted/)).toBeInTheDocument();
  });
});
