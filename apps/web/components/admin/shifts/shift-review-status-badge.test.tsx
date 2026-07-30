import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShiftReviewStatusBadge } from './shift-review-status-badge';

describe('ShiftReviewStatusBadge', () => {
  it.each([
    ['pending', 'Pending'],
    ['approved', 'Approved'],
    ['rejected', 'Rejected'],
  ])('renders the %s status as "%s"', (status, label) => {
    render(<ShiftReviewStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
