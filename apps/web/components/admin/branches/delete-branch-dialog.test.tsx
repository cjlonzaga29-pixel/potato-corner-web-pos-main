import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { BranchResponse } from '@potato-corner/shared';

const { mockEligibility, mockDelete, mockToast, mockPush } = vi.hoisted(() => ({
  mockEligibility: vi.fn(),
  mockDelete: vi.fn(),
  mockToast: { success: vi.fn(), message: vi.fn(), error: vi.fn() },
  mockPush: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: mockToast }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock('@/hooks/queries/use-branches', () => ({
  useBranchDeletionEligibility: mockEligibility,
  useDeleteBranch: () => ({ mutateAsync: mockDelete, isPending: false }),
}));

import { DeleteBranchDialog } from './delete-branch-dialog';

const VERSION = '2026-11-20T03:04:05.678Z';
const TOKEN = 'f'.repeat(64);
const BRANCH = { id: '00000000-0000-4000-8000-0000000000b1', name: 'SM North', code: 'PC-QC-001' } as unknown as BranchResponse;

function deletable(overrides: Record<string, unknown> = {}) {
  return {
    branch_id: BRANCH.id,
    can_delete: true,
    blocked_reason: null,
    blockers: [],
    history_retained: { sales: 12, shifts: 1, expenses: 0 },
    removed: { branch_accounts: 1, staff_and_supervisor_access: 3 },
    confirmation: { name: 'SM North', code: 'PC-QC-001', version: VERSION, confirmation_token: TOKEN },
    ...overrides,
  };
}

const refetch = vi.fn();
function eligibilityReturns(data: unknown) {
  mockEligibility.mockReturnValue({ isLoading: false, isError: false, data, refetch });
}

function renderDialog(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

function confirm(name = 'SM North', code = 'PC-QC-001') {
  fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/branch code/i), { target: { value: code } });
  fireEvent.click(screen.getByRole('checkbox'));
}

const deleteButton = () => screen.getByRole('button', { name: /permanently delete branch/i });

beforeEach(() => {
  mockDelete.mockResolvedValue({ deleted: true, outcome: 'deleted' });
  refetch.mockResolvedValue({ data: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DeleteBranchDialog (POS-PERF-P67)', () => {
  it('names the branch, says it is irreversible, and lists what stays and what goes', () => {
    eligibilityReturns(deletable());
    renderDialog(<DeleteBranchDialog open onOpenChange={vi.fn()} branch={BRANCH} />);
    expect(screen.getByRole('heading', { name: 'Permanently delete SM North?' })).toBeInTheDocument();
    expect(screen.getByText(/can’t be undone in the application/)).toBeInTheDocument();
    expect(screen.getByText(/12 sales, 1 shift\./)).toBeInTheDocument();
    expect(screen.getByText(/Everyone’s access to this branch \(3\)/)).toBeInTheDocument();
    expect(screen.queryByText(/destroys/i)).toBeNull();
  });

  it('enables Delete only with the name, the exact code and the acknowledgment', () => {
    eligibilityReturns(deletable());
    renderDialog(<DeleteBranchDialog open onOpenChange={vi.fn()} branch={BRANCH} />);
    expect(deleteButton()).toBeDisabled();
    confirm('sm  north', 'pc-qc-001');
    expect(deleteButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/branch code/i), { target: { value: 'PC-QC-001' } });
    expect(deleteButton()).toBeEnabled();
  });

  it('sends the typed values with the version and the server-issued token, then leaves the page', async () => {
    eligibilityReturns(deletable());
    const onOpenChange = vi.fn();
    renderDialog(<DeleteBranchDialog open onOpenChange={onOpenChange} branch={BRANCH} />);
    confirm();
    fireEvent.click(deleteButton());
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin/branches'));
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith({ confirm_name: 'SM North', confirm_code: 'PC-QC-001', version: VERSION, confirmation_token: TOKEN });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancel sends nothing', () => {
    eligibilityReturns(deletable());
    const onOpenChange = vi.fn();
    renderDialog(<DeleteBranchDialog open onOpenChange={onOpenChange} branch={BRANCH} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('shows blockers with what to do and offers no delete', () => {
    eligibilityReturns(
      deletable({
        can_delete: false,
        blocked_reason: 'open_operations',
        blockers: [{ code: 'open_shifts', count: 1, message: 'Close every open shift and count its cash.' }],
      }),
    );
    renderDialog(<DeleteBranchDialog open onOpenChange={vi.fn()} branch={BRANCH} />);
    expect(screen.getByText(/Close every open shift and count its cash\. \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /permanently delete branch/i })).toBeNull();
  });

  it('a lost response is reported as success once the server says the branch is gone', async () => {
    eligibilityReturns(deletable());
    mockDelete.mockRejectedValue(new Error('Network error'));
    refetch.mockResolvedValue({ data: { blocked_reason: 'already_deleted' } });
    renderDialog(<DeleteBranchDialog open onOpenChange={vi.fn()} branch={BRANCH} />);
    confirm();
    fireEvent.click(deleteButton());
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Branch deleted. Its history was kept.'));
    expect(mockPush).toHaveBeenCalledWith('/admin/branches');
  });

  it('a refused delete shows the server message and stays open', async () => {
    eligibilityReturns(deletable());
    mockDelete.mockRejectedValue(new Error('This branch changed after the dialog opened. Review the details and confirm again.'));
    const onOpenChange = vi.fn();
    renderDialog(<DeleteBranchDialog open onOpenChange={onOpenChange} branch={BRANCH} />);
    confirm();
    fireEvent.click(deleteButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('This branch changed after the dialog opened');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
