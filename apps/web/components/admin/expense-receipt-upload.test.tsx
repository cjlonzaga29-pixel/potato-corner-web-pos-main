import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ExpenseReceiptUpload } from './expense-receipt-upload';

const { mockUseUploadExpenseReceipt, mockUseDeleteExpenseReceipt } = vi.hoisted(() => ({
  mockUseUploadExpenseReceipt: vi.fn(),
  mockUseDeleteExpenseReceipt: vi.fn(),
}));

vi.mock('@/hooks/queries/use-expenses', () => ({
  useUploadExpenseReceipt: mockUseUploadExpenseReceipt,
  useDeleteExpenseReceipt: mockUseDeleteExpenseReceipt,
}));

function jpegFile(name = 'receipt.jpg', size = 1024, type = 'image/jpeg'): File {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

beforeEach(() => {
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL: vi.fn() });
  mockUseUploadExpenseReceipt.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false });
  mockUseDeleteExpenseReceipt.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ExpenseReceiptUpload', () => {
  it('renders the "Upload Receipt" button when there is no current receipt', () => {
    render(<ExpenseReceiptUpload expenseId="expense-1" currentReceiptUrl={null} />);

    expect(screen.getByRole('button', { name: /Upload Receipt/ })).toBeInTheDocument();
  });

  it('renders a thumbnail with Replace and Delete when currentReceiptUrl is present', () => {
    render(<ExpenseReceiptUpload expenseId="expense-1" currentReceiptUrl="https://example.com/receipt.webp" />);

    expect(screen.getByAltText('Receipt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Replace/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeInTheDocument();
  });

  it('rejects a file over 5MB with an inline error', () => {
    render(<ExpenseReceiptUpload expenseId="expense-1" currentReceiptUrl={null} />);

    const input = document.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    if (!input) throw new Error('file input not found');

    const tooLarge = jpegFile('big.jpg', 6 * 1024 * 1024);
    fireEvent.change(input, { target: { files: [tooLarge] } });

    expect(screen.getByText('Image must be 5MB or smaller')).toBeInTheDocument();
  });

  it('rejects an unsupported MIME type with an inline error', () => {
    render(<ExpenseReceiptUpload expenseId="expense-1" currentReceiptUrl={null} />);

    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error('file input not found');

    const badType = jpegFile('receipt.gif', 1024, 'image/gif');
    fireEvent.change(input, { target: { files: [badType] } });

    expect(screen.getByText('Image must be JPEG, PNG, or WebP')).toBeInTheDocument();
  });

  it('calls onSuccess after a successful upload', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseUploadExpenseReceipt.mockReturnValue({ mutateAsync, isPending: false });
    const onSuccess = vi.fn();

    render(<ExpenseReceiptUpload expenseId="expense-1" currentReceiptUrl={null} onSuccess={onSuccess} />);

    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error('file input not found');
    fireEvent.change(input, { target: { files: [jpegFile()] } });

    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(onSuccess).toHaveBeenCalled();
  });

  it('opens a confirmation dialog on Delete; Cancel does nothing', () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseDeleteExpenseReceipt.mockReturnValue({ mutateAsync, isPending: false });

    render(<ExpenseReceiptUpload expenseId="expense-1" currentReceiptUrl="https://example.com/receipt.webp" />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete receipt?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('calls the delete mutation when the confirmation is confirmed', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseDeleteExpenseReceipt.mockReturnValue({ mutateAsync, isPending: false });

    render(<ExpenseReceiptUpload expenseId="expense-1" currentReceiptUrl="https://example.com/receipt.webp" />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Receipt' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  });
});
