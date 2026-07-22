import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import ExpenseDetailPage from './page';
import type { ExpenseFormValues } from '@/components/admin/expense-form';
import type { ExpenseRow } from '@/hooks/queries/use-expenses';

const { mockPush, mockUseExpense, mockUseUpdateExpense, mockUseAuth, mockUpdateMutateAsync } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseExpense: vi.fn(),
  mockUseUpdateExpense: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUpdateMutateAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpense: mockUseExpense,
  useUpdateExpense: mockUseUpdateExpense,
}));

vi.mock('@/components/admin/expense-form', () => ({
  ExpenseForm: ({ onSubmit }: { onSubmit: (values: ExpenseFormValues) => Promise<void> }) => (
    <button
      type="button"
      onClick={() =>
        void onSubmit({
          branch_id: 'branch-1',
          category: 'utilities',
          amount: 100,
          incurred_at: '2026-07-01T00:00:00.000Z',
        })
      }
    >
      Submit Form
    </button>
  ),
}));

vi.mock('@/components/admin/expense-delete-dialog', () => ({
  ExpenseDeleteDialog: ({ open }: { open: boolean }) => (open ? <div>Delete Dialog Open</div> : null),
}));

vi.mock('@/components/admin/expense-receipt-upload', () => ({
  ExpenseReceiptUpload: () => <div>Receipt Upload Widget</div>,
}));

function expense(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: 'expense-1',
    branch_id: 'branch-1',
    branch_name: 'Main Branch',
    category: 'utilities',
    amount: 100,
    vendor_name: null,
    description: null,
    receipt_url: null,
    incurred_at: '2026-07-01T00:00:00.000Z',
    created_by: 'user-1',
    created_by_name: 'Juan Dela Cruz',
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockUseExpense.mockReturnValue({ data: expense(), isLoading: false, isError: false, refetch: vi.fn() });
  mockUseUpdateExpense.mockReturnValue({ mutateAsync: mockUpdateMutateAsync, isPending: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExpenseDetailPage', () => {
  it('shows the delete button for super_admin', async () => {
    mockUseAuth.mockReturnValue({ user: { role: 'super_admin' } });

    await act(async () => {
      render(<ExpenseDetailPage params={Promise.resolve({ expenseId: 'expense-1' })} />);
    });

    expect(screen.getByRole('button', { name: 'Delete Expense' })).toBeInTheDocument();
  });

  it('hides the delete button for supervisor', async () => {
    mockUseAuth.mockReturnValue({ user: { role: 'supervisor' } });

    await act(async () => {
      render(<ExpenseDetailPage params={Promise.resolve({ expenseId: 'expense-1' })} />);
    });

    expect(screen.queryByRole('button', { name: 'Delete Expense' })).not.toBeInTheDocument();
  });

  it('calls useUpdateExpense on form submit', async () => {
    mockUseAuth.mockReturnValue({ user: { role: 'super_admin' } });

    await act(async () => {
      render(<ExpenseDetailPage params={Promise.resolve({ expenseId: 'expense-1' })} />);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Submit Form' }));

    await vi.waitFor(() =>
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ branch_id: 'branch-1', amount: 100 })),
    );
  });
});
