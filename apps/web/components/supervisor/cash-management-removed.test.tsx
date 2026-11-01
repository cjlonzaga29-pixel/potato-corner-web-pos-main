import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CashManagementRemoved } from './cash-management-removed';

describe('CashManagementRemoved (POS-PERF-P56)', () => {
  it('explains the change and links somewhere useful, without reading any cash data', () => {
    render(<CashManagementRemoved />);
    expect(screen.getByText(/Cash Management has moved out/)).toBeInTheDocument();
    expect(screen.getByText(/No shift or cash record was changed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Reports' })).toHaveAttribute('href', '/supervisor/reports');
    expect(screen.getByRole('link', { name: 'Back to Dashboard' })).toHaveAttribute('href', '/supervisor/dashboard');
  });
});
