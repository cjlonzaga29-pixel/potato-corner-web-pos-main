import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('humanizes the status label', () => {
    render(<StatusBadge status="temporarily_unavailable" type="product" />);
    expect(screen.getByText('Temporarily Unavailable')).toBeInTheDocument();
  });

  it('maps a known status to its domain-specific variant class', () => {
    render(<StatusBadge status="active" type="shift" />);
    expect(screen.getByText('Active').className).toContain('bg-success/15');
  });

  it('maps flagged shift status to the critical variant class', () => {
    render(<StatusBadge status="flagged" type="shift" />);
    expect(screen.getByText('Flagged').className).toContain('bg-destructive/15');
  });

  it('falls back to the default variant for an unrecognized status', () => {
    render(<StatusBadge status="mystery" type="general" />);
    expect(screen.getByText('Mystery').className).toContain('bg-primary');
  });

  it('is case-insensitive when matching the status map', () => {
    render(<StatusBadge status="ACTIVE" type="employee" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('maps a voided transaction status to the critical variant class', () => {
    render(<StatusBadge status="voided" type="transaction" />);
    expect(screen.getByText('Voided').className).toContain('bg-destructive/15');
  });
});
