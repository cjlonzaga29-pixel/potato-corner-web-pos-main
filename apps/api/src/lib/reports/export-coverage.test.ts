import { describe, expect, it } from 'vitest';
import { generateCsv } from './csv.js';
import { generatePdf } from './pdf.js';
import { buildExportFilename } from './export-filename.js';
import { discountExportCoverage } from './export-coverage.js';

const rows = [
  { discount_amount: 0.1, created_at: '2026-07-02T02:00:00.000Z' },
  { discount_amount: 0.2, created_at: '2026-07-01T02:00:00.000Z' },
];

describe('discountExportCoverage', () => {
  it('a complete file names every matching sale and a total for all of them, with no floating-point drift', () => {
    const coverage = discountExportCoverage(rows, false);
    expect(coverage.partial).toBe(false);
    expect(coverage.note).toBe('Coverage: all 2 matching discounted sales. Total Discount Amount for all of them: PHP 0.30.');
  });

  it('a partial file gives its date span and says its total is for the exported rows only', () => {
    const coverage = discountExportCoverage(rows, true);
    expect(coverage.partial).toBe(true);
    expect(coverage.note).toContain('PARTIAL EXPORT');
    expect(coverage.note).toContain('newest 2 matching');
    expect(coverage.note).toContain('Jul');
    expect(coverage.note).toContain('NOT in this file');
    expect(coverage.note).toContain('these exported rows only: PHP 0.30');
  });

  it('no rows reads as complete', () => {
    expect(discountExportCoverage([], false).note).toContain('all 0 matching');
  });
});

describe('partial labelling inside the file', () => {
  const columns = [{ key: 'discount_amount' as const, header: 'Discount Amount' }];

  it('a CSV notice is one quoted first line above unchanged headers', () => {
    const note = discountExportCoverage(rows, true).note;
    const lines = generateCsv(rows, columns, note).toString('utf-8').split('\n');
    expect(lines[0]?.startsWith('"PARTIAL EXPORT')).toBe(true);
    expect(lines.slice(1)).toEqual(['Discount Amount', '0.1', '0.2']);
  });

  it('without a notice the CSV is byte-identical to before', () => {
    expect(generateCsv(rows, columns).toString('utf-8')).toBe('Discount Amount\n0.1\n0.2');
  });

  it('the filename marks a partial file and leaves a complete one alone', () => {
    const filters = { dateFrom: new Date('2026-07-01T00:00:00.000Z'), dateTo: new Date('2026-07-02T00:00:00.000Z'), page: 1, limit: 100 };
    expect(buildExportFilename('DISCOUNT_COMPLIANCE', 'csv', filters)).toBe('DiscountReport_2026-07-01_to_2026-07-02.csv');
    expect(buildExportFilename('DISCOUNT_COMPLIANCE', 'pdf', filters, { partial: true })).toBe('DiscountReport_2026-07-01_to_2026-07-02_PARTIAL.pdf');
  });
});

describe('large PDFs', () => {
  const columns = [{ key: 'receipt' as const, header: 'Receipt #' }];
  const makeRows = (n: number) => Array.from({ length: n }, (_, i) => ({ receipt: `R-${i}` }));
  const pageCount = (buffer: Buffer) => (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;

  it('above 100 rows still renders every sheet, with a group boundary adding at most a part-empty one', async () => {
    const filters = { page: 1, limit: 100 };
    const onePage = await generatePdf('DISCOUNT_COMPLIANCE', filters, makeRows(100), columns, null);
    const split = await generatePdf('DISCOUNT_COMPLIANCE', filters, makeRows(101), columns, null);
    expect(pageCount(split)).toBeGreaterThanOrEqual(pageCount(onePage));
    expect(pageCount(split)).toBeLessThanOrEqual(pageCount(onePage) * 2);
  }, 60_000);

  it('an empty report still renders its header page', async () => {
    const empty = await generatePdf('DISCOUNT_COMPLIANCE', { page: 1, limit: 100 }, [], columns, null);
    expect(pageCount(empty)).toBe(1);
  });
});
