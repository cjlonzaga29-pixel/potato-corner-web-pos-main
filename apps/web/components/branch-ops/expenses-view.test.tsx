import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ExpensesView } from './expenses-view';

const TYPE_ID = '223e4567-e89b-12d3-a456-426614174000';

const {
  mockUseBranchStore,
  mockUseExpenses,
  mockUseCreateExpense,
  mockUseUploadExpenseReceiptForExpense,
  mockUseExpensesRealtimeSync,
  mockUseExpenseSummary,
  mockUseExpenseTypes,
  mockUseSearchParams,
  mockExportMutate,
  mockMutateAsync,
  mockUploadMutateAsync,
} = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseExpenses: vi.fn(),
  mockUseCreateExpense: vi.fn(),
  mockUseUploadExpenseReceiptForExpense: vi.fn(),
  mockUseExpensesRealtimeSync: vi.fn(),
  mockUseExpenseSummary: vi.fn(),
  mockUseExpenseTypes: vi.fn(),
  mockUseSearchParams: vi.fn(),
  mockExportMutate: vi.fn(),
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
  useExpenseSummary: mockUseExpenseSummary,
}));

vi.mock('@/hooks/queries/use-expense-types', () => ({
  useExpenseTypes: mockUseExpenseTypes,
  useCreateExpenseType: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateExpenseType: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetExpenseTypeActive: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useRequestExport: () => ({ mutate: mockExportMutate, isPending: false }),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: mockUseSearchParams,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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

function activeType(overrides: Record<string, unknown> = {}) {
  return { id: TYPE_ID, name: 'Bills', description: null, is_active: true, version: 1, branches: [{ branch_id: BRANCH_ID, branch_name: 'Main' }], other_branch_count: 0, can_manage: false, expense_count: 0, ...overrides };
}

beforeEach(() => {
  // Add Expense from a type's own view preselects that type.
  mockUseSearchParams.mockReturnValue(new URLSearchParams(`expense_type_id=${TYPE_ID}`));
  mockUseExpenseTypes.mockReturnValue({ data: [activeType()], isLoading: false, isSuccess: true, isError: false, refetch: vi.fn() });
  mockUseExpenseSummary.mockReturnValue({ data: { total: 0, total_amount: 0, groups: [] }, isLoading: false, isError: false, refetch: vi.fn() });
});

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
          expense_type_id: TYPE_ID,
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

describe('ExpensesView — expense types', () => {
  function setup(activeBranchId = BRANCH_ID) {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId }));
    mockUseExpenses.mockReturnValue({ data: { expenses: [], total: 0, total_amount: 0 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockMutateAsync.mockResolvedValue({ id: 'expense-1' });
    mockUseCreateExpense.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockUseUploadExpenseReceiptForExpense.mockReturnValue({ mutateAsync: mockUploadMutateAsync, isPending: false });
    return render(<ExpensesView />);
  }

  function fillAndSave() {
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /^save expense$/i }));
  }

  it('asks the server for the selected view, with its filters, its own page and its full total', () => {
    mockUseExpenses.mockReturnValue({ data: { expenses: [], total: 73, total_amount: 9000.5 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: BRANCH_ID }));
    mockUseCreateExpense.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockUseUploadExpenseReceiptForExpense.mockReturnValue({ mutateAsync: mockUploadMutateAsync, isPending: false });
    render(<ExpensesView />);

    expect(mockUseExpenses).toHaveBeenCalledWith(expect.objectContaining({ branch_id: BRANCH_ID, expense_type_id: TYPE_ID, page: 1, limit: 25 }));
    expect(screen.getByTestId('expense-view-total')).toHaveTextContent('across 73 records');
    expect(screen.getByTestId('expense-view-total')).toHaveTextContent('9,000.50');
  });

  it('All Expenses drops the type filter; a type card sets it', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /all expenses/i }));
    const lastFilters = mockUseExpenses.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastFilters.expense_type_id).toBeUndefined();
    expect(lastFilters.unassigned).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: /bills/i }));
    expect(mockUseExpenses.mock.calls.at(-1)?.[0]).toMatchObject({ expense_type_id: TYPE_ID });
  });

  it('shows a Legacy / Unassigned card only when such records exist, and it filters to them', () => {
    mockUseExpenseSummary.mockReturnValue({
      data: { total: 2, total_amount: 300, groups: [{ key: 'legacy:utilities', kind: 'legacy', expense_type_id: null, category: 'utilities', name: 'Utilities (legacy)', is_active: null, count: 2, total_amount: 300 }] },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    setup();
    fireEvent.click(screen.getByRole('button', { name: /legacy \/ unassigned/i }));
    expect(mockUseExpenses.mock.calls.at(-1)?.[0]).toMatchObject({ unassigned: true });
  });

  it('a failed type list or summary never reads as zero, and All Expenses still works', () => {
    mockUseExpenseTypes.mockReturnValue({ data: undefined, isLoading: false, isSuccess: false, isError: true, refetch: vi.fn() });
    mockUseExpenseSummary.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
    setup();
    expect(screen.getByTestId('expense-types-error')).toBeInTheDocument();
    expect(screen.getByTestId('expense-summary-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /all expenses/i })).toHaveTextContent('Total unavailable');
  });

  it('labels a deactivated type and keeps it reachable', () => {
    mockUseExpenseTypes.mockReturnValue({ data: [activeType({ is_active: false })], isLoading: false, isSuccess: true, isError: false, refetch: vi.fn() });
    setup();
    expect(screen.getByTestId('expense-view-header')).toHaveTextContent('Deactivated');
    expect(screen.getByTestId('expense-view-header')).toHaveTextContent('Its records stay here and in every total');
  });

  it('shows who can act when a branch has no active types, without offering a fake category', () => {
    mockUseExpenseTypes.mockReturnValue({ data: [], isLoading: false, isSuccess: true, isError: false, refetch: vi.fn() });
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
    setup();
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    expect(screen.getByTestId('no-active-expense-types')).toHaveTextContent('Ask your Supervisor');
    expect(screen.getByRole('button', { name: /^save expense$/i })).toBeDisabled();
  });

  it('does not preselect a type that is not active here', () => {
    mockUseExpenseTypes.mockImplementation(({ includeInactive }: { includeInactive: boolean }) => ({
      data: includeInactive ? [activeType({ is_active: false })] : [],
      isLoading: false,
      isSuccess: true,
      isError: false,
      refetch: vi.fn(),
    }));
    setup();
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250' } });
    expect(screen.getByRole('button', { name: /^save expense$/i })).toBeDisabled();
  });

  it('two fast clicks submit once', async () => {
    let resolve!: (value: { id: string }) => void;
    setup();
    mockMutateAsync.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '250' } });
    const save = screen.getByRole('button', { name: /^save expense$/i });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    resolve({ id: 'expense-1' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^save expense$/i })).not.toBeInTheDocument());
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('after a failure the form keeps what was typed, shows why, and a retry reuses the same key', async () => {
    setup();
    mockMutateAsync.mockRejectedValueOnce(new Error('Network request failed'));
    fillAndSave();
    expect(await screen.findByTestId('expense-save-error')).toHaveTextContent('Network request failed');
    expect(screen.getByLabelText('Amount')).toHaveValue(250);

    fireEvent.click(screen.getByRole('button', { name: /^save expense$/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(2));
    const [first, second] = mockMutateAsync.mock.calls as [[{ idempotencyKey: string }], [{ idempotencyKey: string }]];
    expect(first[0].idempotencyKey).toBeTruthy();
    expect(second[0].idempotencyKey).toBe(first[0].idempotencyKey);
  });

  it('a new dialog gets a new key', async () => {
    setup();
    fillAndSave();
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^save expense$/i })).not.toBeInTheDocument());
    fillAndSave();
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(2));
    const [first, second] = mockMutateAsync.mock.calls as [[{ idempotencyKey: string }], [{ idempotencyKey: string }]];
    expect(second[0].idempotencyKey).not.toBe(first[0].idempotencyKey);
  });

  it('switching branches starts over: no type filter or open dialog carries across', () => {
    const OTHER_BRANCH = '323e4567-e89b-12d3-a456-426614174000';
    const view = setup();
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    expect(screen.getByRole('button', { name: /^save expense$/i })).toBeInTheDocument();

    mockUseSearchParams.mockReturnValue(new URLSearchParams(`branch_id=${BRANCH_ID}&expense_type_id=${TYPE_ID}`));
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: OTHER_BRANCH }));
    view.rerender(<ExpensesView />);

    expect(screen.queryByRole('button', { name: /^save expense$/i })).not.toBeInTheDocument();
    const lastFilters = mockUseExpenses.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastFilters.branch_id).toBe(OTHER_BRANCH);
    expect(lastFilters.expense_type_id).toBeUndefined();
  });

  it('exports what the view shows, through the server', () => {
    mockUseExpenses.mockReturnValue({ data: { expenses: [], total: 5, total_amount: 50 }, isLoading: false, isError: false, refetch: vi.fn() });
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: BRANCH_ID }));
    mockUseCreateExpense.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
    mockUseUploadExpenseReceiptForExpense.mockReturnValue({ mutateAsync: mockUploadMutateAsync, isPending: false });
    render(<ExpensesView />);
    fireEvent.click(screen.getByRole('button', { name: /^csv$/i }));
    expect(mockExportMutate).toHaveBeenCalledWith(
      expect.objectContaining({ report_type: 'EXPENSES', format: 'csv', filters: expect.objectContaining({ branch_id: BRANCH_ID, expense_type_id: TYPE_ID }) }),
    );
  });
});
