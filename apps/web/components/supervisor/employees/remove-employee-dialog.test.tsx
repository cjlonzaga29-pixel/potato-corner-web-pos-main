import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { EmployeeResponse } from '@potato-corner/shared';

const { mockEligibility, mockDelete, mockSetStatus } = vi.hoisted(() => ({
  mockEligibility: vi.fn(),
  mockDelete: vi.fn(),
  mockSetStatus: vi.fn(),
}));

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
    useEmployeeDeletionEligibility: mockEligibility,
    useDeleteEmployee: () => ({ mutateAsync: mockDelete, isPending: false }),
    useSetEmployeeStatus: () => ({ mutateAsync: mockSetStatus, isPending: false }),
  };
});

import { RemoveEmployeeDialog } from './remove-employee-dialog';
import { EmployeeApiError } from '@/hooks/queries/use-employees';

const NO_HISTORY = { sales: 0, shifts: 0, attendance: 0, audit: 0, inventory: 0, expenses: 0, catalog: 0, settings: 0, pin_use: 0 };

const EMPLOYEE = {
  id: '00000000-0000-4000-8000-0000000000e1',
  first_name: 'Ana',
  last_name: 'Reyes',
  role: 'staff',
  status: 'active',
} as unknown as EmployeeResponse;

beforeEach(() => {
  mockDelete.mockResolvedValue({ deleted: true });
  mockSetStatus.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RemoveEmployeeDialog (POS-PERF-P47)', () => {
  it('offers permanent delete only after explicit confirmation when there is no history', async () => {
    mockEligibility.mockReturnValue({ isLoading: false, isError: false, data: { can_delete: true, blocked_reason: null, references: NO_HISTORY } });
    const onDeleted = vi.fn();
    const onOpenChange = vi.fn();
    render(<RemoveEmployeeDialog open onOpenChange={onOpenChange} employee={EMPLOYEE} onDeleted={onDeleted} />);

    const deleteButton = screen.getByRole('button', { name: 'Delete permanently' });
    expect(deleteButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(deleteButton);
    await waitFor(() => expect(mockDelete).toHaveBeenCalled());
    expect(onDeleted).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('button', { name: /Deactivate/ })).not.toBeInTheDocument();
  });

  it('never offers delete for someone with history; offers Deactivate (keep history) with a required reason', async () => {
    mockEligibility.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { can_delete: false, blocked_reason: 'has_history', references: { ...NO_HISTORY, sales: 12, attendance: 1 } },
    });
    render(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} />);

    expect(screen.queryByRole('button', { name: 'Delete permanently' })).not.toBeInTheDocument();
    expect(screen.getByText(/12 sales or checkouts, 1 attendance record/)).toBeInTheDocument();
    const deactivate = screen.getByRole('button', { name: 'Deactivate (keep history)' });
    expect(deactivate).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Resigned end of October' } });
    fireEvent.click(deactivate);
    await waitFor(() =>
      expect(mockSetStatus).toHaveBeenCalledWith({ status: 'inactive', reason: 'Resigned end of October', acknowledge_active_shift: false }),
    );
  });

  it('asks for an active-shift acknowledgement inline instead of failing', async () => {
    mockEligibility.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { can_delete: false, blocked_reason: 'has_history', references: { ...NO_HISTORY, shifts: 1 } },
    });
    mockSetStatus.mockRejectedValueOnce(new EmployeeApiError('active shift', 'ACTIVE_SHIFT_ACKNOWLEDGMENT_REQUIRED'));
    render(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} />);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Resigned end of October' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate (keep history)' }));
    expect(await screen.findByText(/has an active shift/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate (keep history)' })).toBeDisabled();
  });

  it('shows the server error inline when delete is refused', async () => {
    mockEligibility.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { can_delete: true, blocked_reason: null, references: NO_HISTORY },
      refetch: vi.fn(),
    });
    mockDelete.mockRejectedValueOnce(new EmployeeApiError('This person has recorded history', 'EMPLOYEE_HAS_HISTORY'));
    render(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={EMPLOYEE} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This person has recorded history');
  });

  it('explains that an already-inactive person with history needs nothing more', () => {
    mockEligibility.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { can_delete: false, blocked_reason: 'has_history', references: { ...NO_HISTORY, audit: 2 } },
    });
    render(<RemoveEmployeeDialog open onOpenChange={vi.fn()} employee={{ ...EMPLOYEE, status: 'inactive' } as EmployeeResponse} />);
    expect(screen.getByText(/Already inactive/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Deactivate/ })).not.toBeInTheDocument();
  });
});
