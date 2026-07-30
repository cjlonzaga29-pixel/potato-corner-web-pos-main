import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ExpensesView } from './expenses-view';

const { mockUseBranchStore, mockUseExpenses, mockUseCreateExpense, mockUseExpensesRealtimeSync, mockMutateAsync } = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseExpenses: vi.fn(),
  mockUseCreateExpense: vi.fn(),
  mockUseExpensesRealtimeSync: vi.fn(),
  mockMutateAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpenses: mockUseExpenses,
  useCreateExpense: mockUseCreateExpense,
  useExpensesRealtimeSync: mockUseExpensesRealtimeSync,
}));

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExpensesView — create expense', () => {
  it('submits incurred_at as a bare Manila date (YYYY-MM-DD), matching the API contract', async () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: BRANCH_ID }),
    );
    mockUseExpenses.mockReturnValue({ data: { expenses: [], total: 0, total_amount: 0 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseCreateExpense.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });

    render(<ExpensesView />);

    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /^save expense$/i }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          branch_id: BRANCH_ID,
          incurred_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });

    const [payload] = mockMutateAsync.mock.calls[0] as [{ incurred_at: string }];
    expect(payload.incurred_at).not.toContain('T');
  });
});
