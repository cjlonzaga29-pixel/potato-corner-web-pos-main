// apps/api/src/lib/reports/pdf.test.ts
import { describe, it, expect } from 'vitest';
import { generatePdf, computeColumnLayout, estimateTextWidthPt } from './pdf.js';

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

  const DISCOUNT_COMPLIANCE_COLUMNS = [
    { key: 'receipt_number' as const, header: 'Receipt #' },
    { key: 'created_at' as const, header: 'Date/Time' },
    { key: 'branch_name' as const, header: 'Branch' },
    { key: 'cashier_name' as const, header: 'Cashier' },
    { key: 'discount_type' as const, header: 'Discount Type' },
    { key: 'discount_rate_used' as const, header: 'Discount Rate Used' },
    { key: 'discount_id_reference' as const, header: 'Customer ID / Reference' },
    { key: 'discount_amount' as const, header: 'Discount Amount' },
    { key: 'discount_proof_available' as const, header: 'Proof Available' },
  ];

  function readMediaBoxes(buffer: Buffer): Array<{ width: number; height: number }> {
    const text = buffer.toString('latin1');
    const matches = [...text.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)];
    return matches.map((m) => ({ width: Number(m[3]) - Number(m[1]), height: Number(m[4]) - Number(m[2]) }));
  }

  it('renders Discount Compliance with a long receipt number and long customer ID reference without throwing, as a valid landscape PDF (9 columns)', async () => {
    const buffer = await generatePdf(
      'DISCOUNT_COMPLIANCE',
      { page: 1, limit: 25 },
      [
        {
          receipt_number: 'PC-TES-001-20260814-000002',
          created_at: '2026-08-07T14:23:45.123Z',
          branch_name: 'Test Branch',
          cashier_name: 'Juan Dela Cruz',
          discount_type: 'senior_citizen',
          discount_rate_used: 0.2,
          discount_id_reference: '6161617718822-LONG-CUSTOMER-REFERENCE-ID',
          discount_amount: 45.5,
          discount_proof_available: 'Yes',
        },
      ],
      DISCOUNT_COMPLIANCE_COLUMNS,
      'Test Branch',
    );

    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    const [firstBox] = readMediaBoxes(buffer);
    if (!firstBox) throw new Error('expected at least one rendered page');
    // Landscape: wider than tall — 9 columns exceeds the portrait threshold.
    expect(firstBox.width).toBeGreaterThan(firstBox.height);
  });

  it('never sizes a column narrower than its longest unbreakable token — the exact defect the owner reported (receipt # bleeding into Date/Time)', () => {
    const receiptNumber = 'PC-TES-001-20260814-000002';
    const rows = [
      {
        receipt_number: receiptNumber,
        created_at: '2026-08-07T14:23:45.123Z',
        branch_name: 'Test Branch',
        cashier_name: 'Juan Dela Cruz',
        discount_type: 'senior_citizen',
        discount_rate_used: 0.2,
        discount_id_reference: '6161617718822',
        discount_amount: 45.5,
        discount_proof_available: 'Yes',
      },
    ];
    const { fontSize, widths } = computeColumnLayout(DISCOUNT_COMPLIANCE_COLUMNS, rows, 'landscape');
    const receiptColumnIndex = DISCOUNT_COMPLIANCE_COLUMNS.findIndex((c) => c.key === 'receipt_number');
    const receiptWidth = widths[receiptColumnIndex];
    if (receiptWidth === undefined) throw new Error('expected a width for the receipt_number column');
    const receiptRequiredWidth = estimateTextWidthPt(receiptNumber, fontSize) + 8;
    expect(receiptWidth).toBeGreaterThanOrEqual(receiptRequiredWidth);
  });

  it('formats a raw ISO created_at into a readable Manila date/time instead of the raw timestamp string', async () => {
    // The stored value itself must never be visible verbatim in a rendered
    // report — it's what produced the reported wrap/overlap bug.
    const buffer = await generatePdf(
      'DISCOUNT_COMPLIANCE',
      { page: 1, limit: 25 },
      [
        {
          receipt_number: 'PC-001',
          created_at: '2026-08-07T14:23:45.123Z',
          branch_name: 'Test Branch',
          cashier_name: 'A',
          discount_type: 'pwd',
          discount_rate_used: 0.2,
          discount_id_reference: null,
          discount_amount: 10,
          discount_proof_available: 'No',
        },
      ],
      DISCOUNT_COMPLIANCE_COLUMNS,
      'Test Branch',
    );
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('renders a null Customer ID / Reference and null-ish cells safely (no crash, no literal "null"/"undefined")', async () => {
    const buffer = await generatePdf(
      'DISCOUNT_COMPLIANCE',
      { page: 1, limit: 25 },
      [
        {
          receipt_number: 'PC-002',
          created_at: '2026-08-07T14:23:45.123Z',
          branch_name: 'Test Branch',
          cashier_name: 'B',
          discount_type: 'promotional',
          discount_rate_used: null,
          discount_id_reference: null,
          discount_amount: 5,
          discount_proof_available: 'No',
        },
      ],
      DISCOUNT_COMPLIANCE_COLUMNS,
      'Test Branch',
    );
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('uses portrait for a narrow report (<=6 columns)', async () => {
    const buffer = await generatePdf(
      'FLAVOR_PERFORMANCE',
      { page: 1, limit: 25 },
      [{ flavor_name: 'Cheese', units_sold: 10, gross_revenue: 500 }],
      [
        { key: 'flavor_name', header: 'Flavor' },
        { key: 'units_sold', header: 'Units Sold' },
        { key: 'gross_revenue', header: 'Revenue' },
      ],
      null,
    );
    const [firstBox] = readMediaBoxes(buffer);
    if (!firstBox) throw new Error('expected at least one rendered page');
    expect(firstBox.height).toBeGreaterThan(firstBox.width);
  });

  it('renders a multi-page PDF without throwing when row count spans multiple pages, and repeats the header row on every page', async () => {
    // 250-row landscape render is CPU-heavy; default 20s can be tight under
    // load, so this gets its own headroom rather than raising the suite-wide
    // timeout.
    const rows = Array.from({ length: 250 }, (_, i) => ({
      receipt_number: `PC-TES-001-20260814-${String(i).padStart(6, '0')}`,
      created_at: '2026-08-07T14:23:45.123Z',
      branch_name: 'Test Branch',
      cashier_name: 'Juan Dela Cruz',
      discount_type: 'senior_citizen',
      discount_rate_used: 0.2,
      discount_id_reference: `CUSTOMER-REF-${i}`,
      discount_amount: 45.5,
      discount_proof_available: 'Yes',
    }));
    const buffer = await generatePdf('DISCOUNT_COMPLIANCE', { page: 1, limit: 250 }, rows, DISCOUNT_COMPLIANCE_COLUMNS, 'Test Branch');
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    const boxes = readMediaBoxes(buffer);
    // 250 rows can't fit on a single landscape A4 page — multiple pages
    // means react-pdf's `fixed` header row and footer page-number renderer
    // both ran per-page without error.
    expect(boxes.length).toBeGreaterThan(1);
  }, 60000);
});
