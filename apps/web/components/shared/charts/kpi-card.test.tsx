import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { KpiCard } from './kpi-card';

describe('KpiCard', () => {
  afterEach(cleanup);

  it('formats the value with its prefix by default', () => {
    render(<KpiCard title="VAT Collected" value={53.57} prefix="₱" />);
    expect(screen.getByText('53.57')).toBeInTheDocument();
    expect(screen.getByText(/₱/)).toBeInTheDocument();
  });

  it('POS-PERF-P55R3 — valueText replaces the number and its prefix (no "₱0" for a figure that does not exist)', () => {
    render(<KpiCard title="VAT Collected" value={0} prefix="₱" valueText="Not calculated" />);
    expect(screen.getByText('Not calculated')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText(/₱/)).not.toBeInTheDocument();
  });

  it('POS-PERF-P55R3 — caption is always visible under the value', () => {
    render(<KpiCard title="VAT Collected" value={53.57} prefix="₱" caption="VAT-calculated sales only — excludes 1 manual-total sale" />);
    expect(screen.getByText('VAT-calculated sales only — excludes 1 manual-total sale')).toBeVisible();
  });
});
