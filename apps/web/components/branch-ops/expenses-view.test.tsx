import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ExpensesView } from './expenses-view';

const {
  mockUseBranchStore,
  mockUseExpenses,
  mockUseCreateExpense,
  mockUseUploadExpenseReceiptForExpense,
  mockUseExpensesRealtimeSync,
  mockMutateAsync,
  mockUploadMutateAsync,
} = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseExpenses: vi.fn(),
  mockUseCreateExpense: vi.fn(),
  mockUseUploadExpenseReceiptForExpense: vi.fn(),
  mockUseExpensesRealtimeSync: vi.fn(),
  mockMutateAsync: vi.fn().mockResolvedValue({ id: 'expense-1' }),
  mockUploadMutateAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpenses: mockUseExpenses,
  useCreateExpense: mockUseCreateExpense,
  useUploadExpenseReceiptForExpense: mockUseUploadExpenseReceiptForExpense,
  useExpensesRealtimeSync: mockUseExpensesRealtimeSync,
}));

// ImageUpload's own capture/compress/validate/retry behavior (camera, canvas,
// MIME/size validation) is already covered end-to-end by image-upload.test.tsx —
// stubbed here to a single button, same approach as create-product-dialog.test.tsx.
vi.mock('@/components/shared/forms/image-upload', () => ({
  ImageUpload: ({ onImageSelected, label }: { onImageSelected: (file: File) => void | Promise<void>; label?: string }) => (
    <button type="button" onClick={() => onImageSelected(new File(['fake'], 'receipt.jpg', { type: 'image/jpeg' }))}>
      {label ?? 'Receipt'}
    </button>
  ),
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
    mockUseUploadExpenseReceiptForExpense.mockReturnValue({ mutateAsync: mockUploadMutateAsync, isPending: false });

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

describe('ExpensesView — receipt proof upload', () => {
  function setup() {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: BRANCH_ID }),
    );
    mockUseExpenses.mockReturnValue({ data: { expenses: [], total: 0, total_amount: 0 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockMutateAsync.mockResolvedValue({ id: 'expense-1' });
    mockUseCreateExpense.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockUseUploadExpenseReceiptForExpense.mockReturnValue({ mutateAsync: mockUploadMutateAsync, isPending: false });
    render(<ExpensesView />);
  }

  it('creates the expense without attempting an upload when no receipt is staged', async () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /^save expense$/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockUploadMutateAsync).not.toHaveBeenCalled();
  });

  it('stages a receipt via ImageUpload and uploads it to the newly created expense on submit', async () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /receipt \/ expense proof/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save expense$/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1));
    const [uploadArgs] = mockUploadMutateAsync.mock.calls[0] as [{ expenseId: string; file: File }];
    expect(uploadArgs.expenseId).toBe('expense-1');
    expect(uploadArgs.file.name).toBe('receipt.jpg');
  });

  it('keeps the expense recorded and offers Retry Photo Upload when the post-create upload fails, without creating the expense a second time', async () => {
    mockUploadMutateAsync.mockRejectedValueOnce(new Error('Network error'));
    setup();

    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /receipt \/ expense proof/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save expense$/i }));

    await waitFor(() => expect(screen.getByText(/expense was recorded, but the receipt photo could not be uploaded/i)).toBeInTheDocument());
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);

    const retryButton = screen.getByRole('button', { name: /retry photo upload/i });
    mockUploadMutateAsync.mockResolvedValueOnce(undefined);
    fireEvent.click(retryButton);

    await waitFor(() => expect(mockUploadMutateAsync).toHaveBeenCalledTimes(2));
    // Retry re-uses the already-created expense — createExpense is never called a second time.
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    const secondCallArgs = mockUploadMutateAsync.mock.calls[1] as [{ expenseId: string; file: File }];
    expect(secondCallArgs[0].expenseId).toBe('expense-1');
  });

  it('Continue Without Photo closes the dialog after a failed upload without retrying', async () => {
    mockUploadMutateAsync.mockRejectedValueOnce(new Error('Network error'));
    setup();

    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /receipt \/ expense proof/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save expense$/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /continue without photo/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continue without photo/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /^save expense$|retry photo upload/i })).not.toBeInTheDocument());
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe('ExpensesView — receipt proof viewing', () => {
  function setup(receiptUrl: string | null) {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: BRANCH_ID }),
    );
    mockUseExpenses.mockReturnValue({
      data: {
        expenses: [
          {
            id: 'expense-1',
            branch_id: BRANCH_ID,
            branch_name: 'Main Branch',
            category: 'utilities',
            amount: 1250.5,
            vendor_name: 'Meralco',
            description: null,
            receipt_url: receiptUrl,
            incurred_at: '2026-08-18T00:00:00.000Z',
            created_by: 'user-1',
            created_by_name: 'Juan Dela Cruz',
            created_at: '2026-08-18T00:00:00.000Z',
          },
        ],
        total: 1,
        total_amount: 1250.5,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockUseCreateExpense.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockUseUploadExpenseReceiptForExpense.mockReturnValue({ mutateAsync: mockUploadMutateAsync, isPending: false });
    render(<ExpensesView />);
  }

  it('shows "No Proof" when the expense has no receipt', () => {
    setup(null);
    expect(screen.getByText('No Proof')).toBeInTheDocument();
  });

  it('opens the receipt in an in-page modal — scoped to the branch\'s own expense — instead of a new tab', () => {
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    setup('https://storage.example.com/branch-receipt.jpg');

    fireEvent.click(screen.getByRole('button', { name: 'View Proof' }));

    expect(screen.getByText('Expense Receipt')).toBeInTheDocument();
    expect(screen.getByAltText('Expense receipt for Main Branch')).toBeInTheDocument();
    expect(windowOpenSpy).not.toHaveBeenCalled();

    windowOpenSpy.mockRestore();
  });
});
