import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { CreateEmployeeDialog } from './create-employee-dialog';

const mutateAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/queries/use-employees', () => ({
  useCreateEmployee: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: () => ({
    data: { branches: [{ id: 'branch-1', name: 'Main Branch', code: 'MB1' }] },
    isLoading: false,
  }),
}));

// Radix Dialog portals into document.body — without explicit cleanup, a
// later test's queries can match DOM left over from an earlier render.
afterEach(() => {
  cleanup();
});

describe('CreateEmployeeDialog', () => {
  it('surfaces field validation errors on Next instead of silently doing nothing', async () => {
    render(<CreateEmployeeDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Regression guard for the zod v4 / @hookform/resolvers v3 mismatch:
    // that combination threw inside the resolver instead of returning
    // field errors, so form.trigger() never resolved `valid` and the
    // dialog looked frozen on step 1 with no feedback at all.
    await waitFor(() => {
      expect(screen.getAllByText('Minimum 2 characters').length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument();
  });

  it('advances to step 2 once step 1 fields are valid', async () => {
    render(<CreateEmployeeDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Juan'), { target: { value: 'Juan' } });
    fireEvent.change(screen.getByPlaceholderText('Dela Cruz'), { target: { value: 'Dela Cruz' } });
    fireEvent.change(screen.getByPlaceholderText('juan.delacruz@potatocorner.com'), {
      target: { value: 'juan.delacruz@potatocorner.com' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => {
      expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument();
    });
  });
});
