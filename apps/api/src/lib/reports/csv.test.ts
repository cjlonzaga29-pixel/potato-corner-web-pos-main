// apps/api/src/lib/reports/csv.test.ts
import { describe, it, expect } from 'vitest';
import { generateCsv } from './csv.js';
import { DAILY_SALES_TRANSACTION_COLUMNS, REPORT_COLUMNS } from '../../modules/reports/reports.columns.js';

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

  it('P55R3 — a Daily Sales export whose period has manual-total sales labels its VAT total as covering VAT-calculated sales only; a historical export keeps "VAT"', () => {
    const day = { report_date: '2026-10-30', branch_id: 'b', branch_name: 'Main', gross_sales: 500, discount_total: 0, refund_total: 0, vat_total: 53.57, net_sales: 500, expense_total: 0, net_operating_result: 500, completed_count: 1, voided_count: 0, refunded_count: 0, tax_not_calculated_count: 0, tax_not_calculated_sales: 0 };
    const historical = generateCsv([day] as never, REPORT_COLUMNS.DAILY_SALES).toString('utf-8').split('\n');
    expect(historical[0]).toBe('Date,Branch,Gross Sales,Discounts,Refunds,VAT,Net Sales,Operating Expenses,Net Operating Result,Completed,Voided,Refunded,_Branch ID');

    const manualOnly = { ...day, report_date: '2026-10-31', vat_total: 0, tax_not_calculated_count: 1, tax_not_calculated_sales: 500 };
    const mixed = generateCsv([day, manualOnly] as never, REPORT_COLUMNS.DAILY_SALES).toString('utf-8').split('\n');
    expect(mixed[0]).toBe('Date,Branch,Gross Sales,Discounts,Refunds,VAT (VAT-calculated sales only),Net Sales,Operating Expenses,Net Operating Result,Completed,Voided,Refunded,Sales Without VAT Calculation,Amount Paid Without VAT Calculation,_Branch ID');
    expect(mixed[2]).toBe('2026-10-31,Main,500,0,0,0,500,0,500,1,0,0,1,500,b');
  });
});
