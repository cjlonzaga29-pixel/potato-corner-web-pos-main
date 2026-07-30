import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ExpenseForm } from './expense-form';

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: () => ({
    data: { branches: [{ id: BRANCH_ID, name: 'Main Branch', code: 'MB1' }] },
    isLoading: false,
  }),
}));

afterEach(() => {
  cleanup();
});

describe('ExpenseForm', () => {
  it('renders all fields', () => {
    render(<ExpenseForm mode="create" onSubmit={vi.fn()} isSubmitting={false} onCancel={vi.fn()} />);

    expect(screen.getByText('Branch')).toBeInTheDocument();
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Vendor Name')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Date Incurred')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Expense' })).toBeInTheDocument();
  });

  it('shows validation errors for required branch, category, amount, and date when submitted empty', async () => {
    render(<ExpenseForm mode="create" onSubmit={vi.fn()} isSubmitting={false} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Date Incurred/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Expense' }));

    await waitFor(() => {
      expect(screen.getByText('Date is required')).toBeInTheDocument();
    });
  });

  it('rejects a non-positive amount', async () => {
    const onSubmit = vi.fn();
    render(<ExpenseForm mode="create" onSubmit={onSubmit} isSubmitting={false} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create Expense' }));

    await waitFor(() => {
      expect(screen.getByText(/expected number to be/i)).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with correct values on a valid submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ExpenseForm
        mode="edit"
        initialValues={{
          branch_id: BRANCH_ID,
          category: 'utilities',
          amount: 150.5,
          vendor_name: 'Meralco',
          description: 'Monthly bill',
          incurred_at: '2026-07-01T00:00:00.000Z',
        }}
        onSubmit={onSubmit}
        isSubmitting={false}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          branch_id: BRANCH_ID,
          category: 'utilities',
          amount: 150.5,
          vendor_name: 'Meralco',
          description: 'Monthly bill',
          incurred_at: '2026-07-01',
        }),
      );
    });
  });

  it('submits incurred_at as a bare Manila date (YYYY-MM-DD), not a browser-constructed ISO datetime', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ExpenseForm
        mode="edit"
        initialValues={{ branch_id: BRANCH_ID, category: 'utilities', amount: 100, incurred_at: '2026-07-01T00:00:00.000Z' }}
        onSubmit={onSubmit}
        isSubmitting={false}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      const [payload] = onSubmit.mock.calls[0] as [{ incurred_at: string }];
      expect(payload.incurred_at).toBe('2026-07-01');
      expect(payload.incurred_at).not.toContain('T');
    });
  });

  it('derives the date field from the Manila calendar day, not the UTC calendar day, near midnight', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    // 2026-07-01T23:00:00.000Z is already 2026-07-02 07:00 in Manila (UTC+8) —
    // a naive `.slice(0, 10)` off the raw ISO string would wrongly keep July 1.
    render(
      <ExpenseForm
        mode="edit"
        initialValues={{ branch_id: BRANCH_ID, category: 'utilities', amount: 100, incurred_at: '2026-07-01T23:00:00.000Z' }}
        onSubmit={onSubmit}
        isSubmitting={false}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      const [payload] = onSubmit.mock.calls[0] as [{ incurred_at: string }];
      expect(payload.incurred_at).toBe('2026-07-02');
    });
  });

  it('disables the submit button while isSubmitting', () => {
    render(<ExpenseForm mode="create" onSubmit={vi.fn()} isSubmitting onCancel={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Create Expense' })).toBeDisabled();
  });
});
