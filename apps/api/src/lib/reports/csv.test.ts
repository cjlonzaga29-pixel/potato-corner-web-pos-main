// apps/api/src/lib/reports/csv.test.ts
import { describe, it, expect } from 'vitest';
import { generateCsv } from './csv.js';
import { DAILY_SALES_TRANSACTION_COLUMNS } from '../../modules/reports/reports.columns.js';

describe('generateCsv', () => {
  it('builds a header row from visible columns and escapes commas/quotes/newlines', () => {
    const buffer = generateCsv(
      [{ name: 'Cheese, Bacon "Deluxe"', amount: 199.5 }],
      [{ key: 'name', header: 'Name' }, { key: 'amount', header: 'Amount' }],
    );
    const csv = buffer.toString('utf-8');
    expect(csv).toBe('Name,Amount\n"Cheese, Bacon ""Deluxe""",199.5');
  });

  it('appends audit-only columns at the end with an underscore-prefixed header', () => {
    const buffer = generateCsv(
      [{ name: 'Regular', id: 'pv-1', created_at: '2026-07-01T00:00:00.000Z' }],
      [
        { key: 'name', header: 'Name' },
        { key: 'id', header: 'ID', isAudit: true },
        { key: 'created_at', header: 'Created At', isAudit: true },
      ],
    );
    const csv = buffer.toString('utf-8');
    expect(csv).toBe('Name,_ID,_Created At\nRegular,pv-1,2026-07-01T00:00:00.000Z');
  });

  it('renders null/undefined fields as empty strings', () => {
    const buffer = generateCsv([{ reason: null }], [{ key: 'reason', header: 'Reason' }]);
    expect(buffer.toString('utf-8')).toBe('Reason\n');
  });

  it('neutralizes formula-injection payloads in free-text fields', () => {
    const buffer = generateCsv(
      [
        { reason: '=SUM(A1:A9)' },
        { reason: '+1+1' },
        { reason: '-2+3+cmd' },
        { reason: '@SUM(A1)' },
        { reason: 'normal text' },
      ],
      [{ key: 'reason', header: 'Reason' }],
    );
    const rows = buffer.toString('utf-8').split('\n');
    expect(rows).toEqual(['Reason', "'=SUM(A1:A9)", "'+1+1", "'-2+3+cmd", "'@SUM(A1)", 'normal text']);
  });

  it('does not neutralize a genuine negative number', () => {
    const buffer = generateCsv([{ variance: -50.25 }], [{ key: 'variance', header: 'Variance' }]);
    expect(buffer.toString('utf-8')).toBe('Variance\n-50.25');
  });

  it('P55R2 — an export of VAT-calculated sales keeps its pre-P55R2 columns; a manual-total sale adds the Tax Calculation column with a blank VAT', () => {
    const legacy = { receipt_number: 'R1', payment_method: 'cash', total_amount: 112, vat_amount: 12, tax_calculation: null, discount_amount: 0, discount_type: null, discount_id_reference: null, created_at: 'd', cashier_name: 'Ana' };
    const legacyCsv = generateCsv([legacy] as never, DAILY_SALES_TRANSACTION_COLUMNS).toString('utf-8');
    expect(legacyCsv.split('\n')[0]).toBe('Receipt #,Payment,Total,VAT,Discount,Discount Type,Customer ID / Reference,Date,Cashier');
    expect(legacyCsv.split('\n')[1]).toBe('R1,cash,112,12,0,,,d,Ana');

    const manual = { ...legacy, receipt_number: 'R2', total_amount: 450, vat_amount: null, tax_calculation: 'Not calculated (manual total)', discount_amount: 50, discount_type: 'manual' };
    const mixed = generateCsv([legacy, manual] as never, DAILY_SALES_TRANSACTION_COLUMNS).toString('utf-8').split('\n');
    expect(mixed[0]).toBe('Receipt #,Payment,Total,VAT,Tax Calculation,Discount,Discount Type,Customer ID / Reference,Date,Cashier');
    expect(mixed[1]).toBe('R1,cash,112,12,,0,,,d,Ana');
    expect(mixed[2]).toBe('R2,cash,450,,Not calculated (manual total),50,manual,,d,Ana');
  });
});
