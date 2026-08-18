import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ViewExpenseReceiptDialog, type ExpenseReceiptProofData } from './view-expense-receipt-dialog';

function expenseProof(overrides: Partial<ExpenseReceiptProofData> = {}): ExpenseReceiptProofData {
  return {
    id: 'expense-1',
    receiptUrl: 'https://storage.example.com/expense-receipts/expense-1.jpg?token=abc',
    branchName: 'Test Branch',
    categoryLabel: 'Supplies',
    vendorName: null,
    amount: 3220,
    incurredAt: '2026-08-18T00:00:00.000Z',
    createdByName: 'CJ Lonzaga',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ViewExpenseReceiptDialog', () => {
  it('is closed when expense is null', () => {
    render(<ViewExpenseReceiptDialog expense={null} onOpenChange={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.queryByText('Expense Receipt')).not.toBeInTheDocument();
  });

  it('opens with the title, receipt image, and metadata when an expense is provided', () => {
    render(<ViewExpenseReceiptDialog expense={expenseProof()} onOpenChange={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.getByText('Expense Receipt')).toBeInTheDocument();
    const image = screen.getByAltText('Expense receipt for Test Branch') as HTMLImageElement;
    expect(image).toBeInTheDocument();
    expect(image.src).toBe('https://storage.example.com/expense-receipts/expense-1.jpg?token=abc');
    expect(screen.getByText('Test Branch')).toBeInTheDocument();
    expect(screen.getByText(/Supplies/)).toBeInTheDocument();
    expect(screen.getByText(/Recorded by CJ Lonzaga/)).toBeInTheDocument();
  });

  it('shows a loading spinner before the receipt image finishes loading', () => {
    render(<ViewExpenseReceiptDialog expense={expenseProof()} onOpenChange={vi.fn()} onRetry={vi.fn()} />);

    const image = screen.getByAltText('Expense receipt for Test Branch');
    expect(image.className).toContain('hidden');
  });

  it('reveals the image once it finishes loading', () => {
    render(<ViewExpenseReceiptDialog expense={expenseProof()} onOpenChange={vi.fn()} onRetry={vi.fn()} />);

    const image = screen.getByAltText('Expense receipt for Test Branch');
    fireEvent.load(image);

    expect(image.className).not.toContain('hidden');
  });

  it('shows an error state with a Retry action when the receipt image fails to load', () => {
    const onRetry = vi.fn();
    render(<ViewExpenseReceiptDialog expense={expenseProof()} onOpenChange={vi.fn()} onRetry={onRetry} />);

    const image = screen.getByAltText('Expense receipt for Test Branch');
    fireEvent.error(image);

    expect(screen.getByText('Unable to load receipt. Please try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenChange(false) when the dialog close button is clicked', () => {
    const onOpenChange = vi.fn();
    render(<ViewExpenseReceiptDialog expense={expenseProof()} onOpenChange={onOpenChange} onRetry={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) on Escape', () => {
    const onOpenChange = vi.fn();
    render(<ViewExpenseReceiptDialog expense={expenseProof()} onOpenChange={onOpenChange} onRetry={vi.fn()} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
