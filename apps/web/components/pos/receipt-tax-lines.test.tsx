import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ReceiptTaxLines } from './receipt-tax-lines';

describe('ReceiptTaxLines (P50)', () => {
  afterEach(cleanup);

  it('ordinary sale: VATable sales net of VAT, VAT, and the non-VATable cap part from stored amounts', () => {
    render(<ReceiptTaxLines sale={{ discount_type: null, vat_amount: 53.57, vat_exempt_amount: 100, total_amount: 600 }} />);
    expect(screen.getByText('VATable sales')).toBeInTheDocument();
    expect(screen.getByText('₱446.43')).toBeInTheDocument();
    expect(screen.getByText('VAT (12%)')).toBeInTheDocument();
    expect(screen.getByText('₱53.57')).toBeInTheDocument();
    expect(screen.getByText('Non-VATable amount')).toBeInTheDocument();
    expect(screen.getByText('₱100.00')).toBeInTheDocument();
  });

  it('no non-VATable line when nothing exceeded a cap', () => {
    render(<ReceiptTaxLines sale={{ discount_type: 'promotional', vat_amount: 9.32, vat_exempt_amount: 0, total_amount: 87 }} />);
    expect(screen.getByText('₱77.68')).toBeInTheDocument();
    expect(screen.queryByText('Non-VATable amount')).not.toBeInTheDocument();
  });

  it('PWD/Senior sale: the whole stored total is shown as VAT-exempt', () => {
    render(<ReceiptTaxLines sale={{ discount_type: 'pwd', vat_amount: 0, vat_exempt_amount: 0, total_amount: 80 }} />);
    expect(screen.getByText('VAT-exempt sale (PWD/Senior)')).toBeInTheDocument();
    expect(screen.getByText('₱80.00')).toBeInTheDocument();
    expect(screen.queryByText('VATable sales')).not.toBeInTheDocument();
  });

  it('P55R3 — a calculated ₱0 VAT (PWD/Senior, legacy mode) is not mistaken for a manual total', () => {
    render(<ReceiptTaxLines sale={{ discount_type: 'pwd', calculation_mode: 'legacy_vat_v1', vat_amount: 0, vat_exempt_amount: 0, total_amount: 80 }} />);
    expect(screen.getByText('VAT-exempt sale (PWD/Senior)')).toBeInTheDocument();
    expect(screen.queryByText('VAT not calculated by this checkout')).not.toBeInTheDocument();
  });

  it('older API without vat_exempt_amount: only the VAT line, never a guessed breakdown', () => {
    render(<ReceiptTaxLines sale={{ discount_type: null, vat_amount: 12, total_amount: 112 }} />);
    expect(screen.getByText('VAT (12%)')).toBeInTheDocument();
    expect(screen.queryByText('VATable sales')).not.toBeInTheDocument();
  });

  it('P55R2 manual-total sale: says VAT was not calculated — no VATable, VAT, ₱0.00 or exempt line', () => {
    render(<ReceiptTaxLines sale={{ discount_type: 'manual', calculation_mode: 'manual_total_v1', vat_amount: null, vat_exempt_amount: null, total_amount: 450 }} />);
    expect(screen.getByTestId('receipt-tax-lines')).toHaveTextContent('VAT not calculated by this checkout');
    for (const text of ['VATable sales', 'VAT (12%)', 'VAT-exempt sale (PWD/Senior)', 'Non-VATable amount']) expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(screen.queryByText('₱0.00')).not.toBeInTheDocument();
  });

  it('P55R2 a legacy sale from a new API keeps its breakdown', () => {
    render(<ReceiptTaxLines sale={{ discount_type: null, calculation_mode: 'legacy_vat_v1', vat_amount: 7.5, vat_exempt_amount: 0, total_amount: 70 }} />);
    expect(screen.getByText('VAT (12%)')).toBeInTheDocument();
    expect(screen.getByText('₱7.50')).toBeInTheDocument();
  });
});
