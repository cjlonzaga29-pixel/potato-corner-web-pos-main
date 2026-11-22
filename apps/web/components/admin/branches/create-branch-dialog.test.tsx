import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const { mockCreate, mockToast } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: mockToast }));
vi.mock('@/hooks/queries/use-branches', async () => {
  class BranchRequestError extends Error {
    constructor(
      message: string,
      readonly code: string | null,
      readonly details: unknown,
    ) {
      super(message);
    }
    get field() {
      return (this.details as { field?: string } | null)?.field ?? null;
    }
  }
  return {
    BranchRequestError,
    useCreateBranch: () => ({ mutateAsync: mockCreate, isPending: false }),
  };
});

import { CreateBranchDialog } from './create-branch-dialog';
import { BranchRequestError } from '@/hooks/queries/use-branches';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fill() {
  fireEvent.change(screen.getByLabelText(/branch name/i), { target: { value: 'Demo Mall' } });
  fireEvent.change(screen.getByLabelText(/^city/i), { target: { value: 'Manila' } });
  fireEvent.change(screen.getByLabelText(/address/i), { target: { value: '123 Rizal Street' } });
  fireEvent.change(screen.getByLabelText(/username/i), {
    target: { value: 'demo@potatocorner.test' },
  });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'Password1!' } });
  fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'Password1!' } });
}

describe('CreateBranchDialog email conflicts (POS-PERF-P68)', () => {
  it('shows the server reason beside Username and keeps every typed value', async () => {
    mockCreate.mockRejectedValue(
      new BranchRequestError(
        'This email still belongs to a leftover branch login (account abc).',
        'EMAIL_HELD_BY_LEFTOVER_ACCOUNT',
        { field: 'account.email' },
      ),
    );
    const onOpenChange = vi.fn();
    render(<CreateBranchDialog open onOpenChange={onOpenChange} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create Branch' }));
    expect(await screen.findByText(/leftover branch login/)).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toHaveValue('demo@potatocorner.test');
    expect(screen.getByLabelText(/branch name/i)).toHaveValue('Demo Mall');
    await waitFor(() => expect(onOpenChange).not.toHaveBeenCalledWith(false));
    expect(mockToast.success).not.toHaveBeenCalled();
  });
});
