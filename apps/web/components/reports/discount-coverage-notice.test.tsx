import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DiscountCoverageNotice } from './discount-coverage-notice';

describe('DiscountCoverageNotice', () => {
  afterEach(cleanup);

  it('reports complete totals when the API returned every summary row, including exactly the page size', () => {
    render(<DiscountCoverageNotice rowsReturned={100} rowsTotal={100} transactionCount={40} />);
    expect(screen.getByText('Totals cover all 40 matching discounted sales.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('labels totals partial only when the API says more summary rows exist', () => {
    render(<DiscountCoverageNotice rowsReturned={100} rowsTotal={101} transactionCount={40} />);
    expect(screen.getByRole('alert')).toHaveTextContent('cover only the first 100 of 101 summary rows');
    expect(screen.queryByText(/Totals cover all/)).not.toBeInTheDocument();
  });

  it.each([
    [2_000, null],
    [2_001, 'PDF holds the newest 2,000 sales, and 2,001 match'],
    [10_000, 'PDF holds the newest 2,000 sales, and 10,000 match'],
    [10_001, 'PDF holds the newest 2,000 sales; CSV holds the newest 10,000 sales, and 10,001 match'],
  ])('warns about export limits only above them: %i sales', (transactionCount, expected) => {
    render(<DiscountCoverageNotice rowsReturned={1} rowsTotal={1} transactionCount={transactionCount} showExportLimits />);
    if (expected) expect(screen.getByRole('status')).toHaveTextContent(expected);
    else expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('never mentions row limits for exports that list summary rows', () => {
    render(<DiscountCoverageNotice rowsReturned={1} rowsTotal={1} transactionCount={20_000} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
