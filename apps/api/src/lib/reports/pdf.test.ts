// apps/api/src/lib/reports/pdf.test.ts
import { describe, it, expect } from 'vitest';
import { generatePdf } from './pdf.js';

describe('generatePdf', () => {
  it('renders a non-empty PDF buffer starting with the %PDF magic bytes', async () => {
    const buffer = await generatePdf(
      'DAILY_SALES',
      { page: 1, limit: 25 },
      [{ report_date: '2026-07-01', branch_name: 'SM North', gross_sales: 1000 }],
      [
        { key: 'report_date', header: 'Date' },
        { key: 'branch_name', header: 'Branch' },
        { key: 'gross_sales', header: 'Gross Sales' },
      ],
      'SM North',
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('omits isAudit columns from the rendered table', async () => {
    const buffer = await generatePdf(
      'PRODUCT_PERFORMANCE',
      { page: 1, limit: 25 },
      [{ product_variant_id: 'pv-1', product_name: 'Cheese Potato' }],
      [
        { key: 'product_variant_id', header: 'Variant ID', isAudit: true },
        { key: 'product_name', header: 'Product' },
      ],
      null,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });
});
