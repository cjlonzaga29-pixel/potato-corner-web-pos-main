import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ExpenseDeleteDialog } from './expense-delete-dialog';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/queries/use-expenses', async () => {
  const actual = await vi.importActual<object>('@/hooks/queries/use-expenses');
  return { ...actual, useDeleteExpense: () => ({ mutateAsync, isPending: false }) };
});

const expense = {
  id: 'expense-1',
  branch_id: 'branch-1',
  branch_name: 'Main Branch',
  category: 'utilities' as const,
  amount: 250,
  vendor_name: 'Meralco',
  description: null,
  receipt_url: null,
  incurred_at: '2026-07-01T00:00:00.000Z',
  created_by: 'user-1',
  created_by_name: 'Juan Dela Cruz',
  created_at: '2026-07-01T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
  mutateAsync.mockClear();
  mockPush.mockClear();
});

describe('ExpenseDeleteDialog', () => {
  it('renders a summary of the expense being deleted', () => {
    render(<ExpenseDeleteDialog open onOpenChange={vi.fn()} expense={expense} />);

    expect(screen.getByText(/Utilities/)).toBeInTheDocument();
    expect(screen.getByText('Main Branch')).toBeInTheDocument();
    expect(screen.getByText('Meralco')).toBeInTheDocument();
  });

  it('keeps the confirm button disabled until DELETE is typed', () => {
    render(<ExpenseDeleteDialog open onOpenChange={vi.fn()} expense={expense} />);

    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'DELETE' } });
    expect(confirmButton).toBeEnabled();
  });

  it('calls the delete mutation when confirmed', async () => {
    render(<ExpenseDeleteDialog open onOpenChange={vi.fn()} expense={expense} />);

    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mockPush).toHaveBeenCalledWith('/admin/expenses');
  });
});
