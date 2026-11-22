import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BranchResponse } from '@potato-corner/shared';

const { mockPlan, mockStart, mockStatus, mockAbort, mockToast, mockPush } = vi.hoisted(() => ({
  mockPlan: vi.fn(),
  mockStart: vi.fn(),
  mockStatus: vi.fn(),
  mockAbort: vi.fn(),
  mockToast: { success: vi.fn(), message: vi.fn(), error: vi.fn() },
  mockPush: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: mockToast }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock('@/hooks/queries/use-branch-force-deletion', () => ({
  useForceDeletionPlan: mockPlan,
  startForceDeletion: mockStart,
  fetchForceDeletionStatus: mockStatus,
  abortForceDeletion: mockAbort,
}));

import { ForceDeleteBranchDialog } from './force-delete-branch-dialog';

const BRANCH = {
  id: '00000000-0000-4000-8000-0000000000b2',
  name: 'Demo Mall',
  code: 'PC-DEM-001',
} as unknown as BranchResponse;
const PLAN = {
  branch_id: BRANCH.id,
  in_progress_operation_id: null,
  groups: [
    {
      kind: 'open_shift',
      count: 1,
      outcome: 'shift_terminated_uncounted',
      explanation: 'Open shifts are ended as "terminated".',
      examples: ['Shift abc'],
    },
    {
      kind: 'stock_balance',
      count: 2,
      outcome: 'stock_unresolved',
      explanation: 'Stock is NOT zeroed.',
      examples: ['Potato: on hand 3'],
    },
  ],
  history_retained: { sales: 4 },
  removed: { branch_accounts: 1 },
  offline_notice: 'The server cannot see or delete sales queued on terminals that are offline.',
  confirmation: {
    name: 'Demo Mall',
    code: 'PC-DEM-001',
    version: '2026-11-22T01:00:00.000Z',
    plan_keys: ['a', 'b', 'c'],
    plan_hash: '1'.repeat(64),
    confirmation_token: '2'.repeat(64),
  },
};
const refetch = vi.fn();

function renderDialog(onOpenChange = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ForceDeleteBranchDialog open onOpenChange={onOpenChange} branch={BRANCH} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

function confirmAll() {
  fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: ' demo  mall ' } });
  fireEvent.change(screen.getByLabelText(/branch code/i), { target: { value: 'PC-DEM-001' } });
  fireEvent.click(screen.getByRole('checkbox'));
}

const forceButton = () => screen.getByRole('button', { name: /force delete branch/i });

beforeEach(() => {
  window.sessionStorage.clear();
  mockPlan.mockReturnValue({ isLoading: false, isError: false, data: PLAN, refetch });
  mockStatus.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ForceDeleteBranchDialog (POS-PERF-P68)', () => {
  it('shows every group, what happens to it and the offline limit', () => {
    renderDialog();
    expect(screen.getByText(/1 × open shift/)).toBeInTheDocument();
    expect(screen.getByText(/2 × stock balance/)).toBeInTheDocument();
    expect(screen.getByText(/Stock is NOT zeroed/)).toBeInTheDocument();
    expect(screen.getByText(/cannot see or delete sales queued/)).toBeInTheDocument();
    expect(screen.getByText(/branch login’s email can be used again for a new account/)).toBeInTheDocument();
  });

  it('needs the typed name, code and acknowledgment; Cancel sends nothing', () => {
    const onOpenChange = renderDialog();
    expect(forceButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: 'Demo Mall' } });
    fireEvent.change(screen.getByLabelText(/branch code/i), { target: { value: 'pc-dem-001' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(forceButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('sends the exact plan with one operation id, and finishes on completion', async () => {
    mockStart.mockResolvedValue({
      operation_id: 'op',
      branch_id: BRANCH.id,
      status: 'completed',
      step: 'completed',
      abort_reason: null,
      last_error: null,
      closure_item_count: 3,
      created_at: null,
      completed_at: null,
    });
    renderDialog();
    confirmAll();
    fireEvent.click(forceButton());
    fireEvent.click(forceButton());
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin/branches'));
    expect(mockStart).toHaveBeenCalledTimes(1);
    const [, body] = mockStart.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({
      plan_keys: ['a', 'b', 'c'],
      plan_hash: PLAN.confirmation.plan_hash,
      acknowledge: true,
    });
    expect(body.operation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('after a lost response it asks about the same operation instead of reporting failure', async () => {
    mockStart.mockRejectedValue(new Error('Network error'));
    mockStatus.mockResolvedValue({
      operation_id: 'op',
      branch_id: BRANCH.id,
      status: 'completed',
      step: 'completed',
      abort_reason: null,
      last_error: null,
      closure_item_count: 1,
      created_at: null,
      completed_at: null,
    });
    renderDialog();
    confirmAll();
    fireEvent.click(forceButton());
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin/branches'));
    const sentId = (mockStart.mock.calls[0] as [string, { operation_id: string }])[1].operation_id;
    expect(mockStatus).toHaveBeenLastCalledWith(sentId);
  });

  it('shows the server reason when the plan changed and nothing was deleted', async () => {
    mockStart.mockRejectedValue(
      new Error('Open work at this branch changed after the dialog opened. Nothing was changed.'),
    );
    renderDialog();
    confirmAll();
    fireEvent.click(forceButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing was changed/);
    expect(mockPush).not.toHaveBeenCalled();
    expect(refetch).toHaveBeenCalled();
  });
});
