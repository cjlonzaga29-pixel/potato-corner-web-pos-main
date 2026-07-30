import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ReviewShiftDialog } from './review-shift-dialog';

const mutateAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/queries/use-shifts', () => ({
  useReviewShift: () => ({ mutateAsync, isPending: false }),
}));

beforeEach(() => {
  mutateAsync.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ReviewShiftDialog', () => {
  it('renders the phase label in the title', () => {
    render(<ReviewShiftDialog open onOpenChange={vi.fn()} shiftId="shift-1" phase="opening" />);

    expect(screen.getByText('Review Opening Count')).toBeInTheDocument();
  });

  it('disables both approve and reject until the notes reach the 50-character minimum', () => {
    render(<ReviewShiftDialog open onOpenChange={vi.fn()} shiftId="shift-1" phase="closing" />);

    const approveButton = screen.getByRole('button', { name: /approve/i });
    const rejectButton = screen.getByRole('button', { name: /reject/i });
    const textarea = screen.getByPlaceholderText(/explain your approve\/reject decision/i);

    expect(approveButton).toBeDisabled();
    expect(rejectButton).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'too short' } });
    expect(approveButton).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'x'.repeat(50) } });
    expect(approveButton).not.toBeDisabled();
    expect(rejectButton).not.toBeDisabled();
  });

  it('submits the approve decision with trimmed notes and the correct phase', async () => {
    render(<ReviewShiftDialog open onOpenChange={vi.fn()} shiftId="shift-1" phase="opening" />);

    const textarea = screen.getByPlaceholderText(/explain your approve\/reject decision/i);
    fireEvent.change(textarea, { target: { value: `  ${'x'.repeat(50)}  ` } });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ approved: true, notes: 'x'.repeat(50) }));
  });

  it('submits the reject decision', async () => {
    render(<ReviewShiftDialog open onOpenChange={vi.fn()} shiftId="shift-1" phase="closing" />);

    fireEvent.change(screen.getByPlaceholderText(/explain your approve\/reject decision/i), { target: { value: 'x'.repeat(50) } });
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ approved: false, notes: 'x'.repeat(50) }));
  });
});
