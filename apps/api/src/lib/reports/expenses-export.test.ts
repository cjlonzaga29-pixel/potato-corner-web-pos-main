// apps/api/src/lib/reports/expenses-export.test.ts
import { describe, it, expect } from 'vitest';
import zlib from 'zlib';
import { generateExpensesPdf, formatPhp, EXPENSES_EXPORT_COLUMNS, type ExpensesExportRow } from './expenses-export.js';

const SAMPLE_ROW: ExpensesExportRow = {
  incurred_at: '2026-07-30T04:00:00.000Z',
  branch: 'SM North',
  category: 'utilities',
  vendor_name: 'Meralco',
  amount: formatPhp(1234.5),
  created_by_name: 'Juan Dela Cruz',
  proof_available: 'Yes',
};

/**
 * react-pdf's rendered content streams are FlateDecode-compressed, and each
 * run of text is written as a `[<hex> kerning <hex> ...] TJ` array — a
 * literal `buffer.includes('some text')` check (the pattern pdf.test.ts uses
 * for structural checks like %PDF-/MediaBox) silently never matches
 * anything inside a stream. This inflates every stream and decodes each hex
 * string in every TJ array back to characters (dropping the kerning
 * numbers), so tests can assert on what actually got rendered instead of
 * trusting the JSX unverified.
 */
function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  let text = '';
  for (const streamMatch of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let inflated: Buffer;
    try {
      inflated = zlib.inflateSync(Buffer.from(streamMatch[1] ?? '', 'latin1'));
    } catch {
      continue; // not a FlateDecode content stream (e.g. an embedded font program)
    }
    const content = inflated.toString('latin1');
    for (const tjMatch of content.matchAll(/\[((?:<[0-9a-fA-F]+>|-?\d+(?:\.\d+)?|\s)+)\]\s*TJ/g)) {
      for (const hexMatch of (tjMatch[1] ?? '').matchAll(/<([0-9a-fA-F]+)>/g)) {
        const hex = hexMatch[1] ?? '';
        for (let i = 0; i < hex.length; i += 2) {
          text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        }
      }
    }
  }
  return text;
}

describe('formatPhp', () => {
  it('formats with a PHP prefix, thousands separator, and two decimals', () => {
    expect(formatPhp(1234.5)).toBe('PHP 1,234.50');
    expect(formatPhp(0)).toBe('PHP 0.00');
  });
});

describe('generateExpensesPdf', () => {
  it('renders a non-empty PDF buffer starting with the %PDF magic bytes', async () => {
    const buffer = await generateExpensesPdf({ page: 1, limit: 100 }, [SAMPLE_ROW], 1, 1234.5, 'SM North', 'POTATO CORNER');
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('renders the Total Expenses / Total Amount summary using the passed-in already-computed totals, not the row count', async () => {
    // totalCount/totalAmount deliberately don't match rows.length/sum(rows) —
    // proves the summary renders exactly what's passed in (the aggregate the
    // repository already computed) rather than recomputing from the visible
    // rows, which would be wrong once a report is paginated.
    const buffer = await generateExpensesPdf({ page: 1, limit: 100 }, [SAMPLE_ROW], 42, 99999.99, 'SM North', 'POTATO CORNER');
    const text = extractPdfText(buffer);
    expect(text).toContain('Total Expenses: 42');
    expect(text).toContain('Total Amount: PHP 99,999.99');
  });

  it('generates a valid PDF with a "No expense records found" message for an empty dataset instead of throwing or omitting content', async () => {
    const buffer = await generateExpensesPdf({ page: 1, limit: 100 }, [], 0, 0, 'SM North', 'POTATO CORNER');
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    expect(extractPdfText(buffer)).toContain('No expense records found for the selected period.');
  });

  it('renders "All Branches" when branchName is null (Admin export with no branch selected)', async () => {
    const buffer = await generateExpensesPdf({ page: 1, limit: 100 }, [SAMPLE_ROW], 1, 1234.5, null, 'POTATO CORNER');
    expect(extractPdfText(buffer)).toContain('All Branches');
  });

  it('renders the given brand name in the header (POTATO CORNER vs HENLIN differ per repo)', async () => {
    const buffer = await generateExpensesPdf({ page: 1, limit: 100 }, [SAMPLE_ROW], 1, 1234.5, 'SM North', 'HENLIN');
    expect(extractPdfText(buffer)).toContain('HENLIN');
  });

  it('renders the row data (branch, category, vendor, formatted amount, recorded by) in the table', async () => {
    const buffer = await generateExpensesPdf({ page: 1, limit: 100 }, [SAMPLE_ROW], 1, 1234.5, 'SM North', 'POTATO CORNER');
    const text = extractPdfText(buffer);
    expect(text).toContain('utilities');
    expect(text).toContain('Meralco');
    expect(text).toContain('PHP 1,234.50');
    expect(text).toContain('Juan Dela Cruz');
  });

  it('formats a raw ISO incurred_at into a readable Manila date instead of the raw timestamp string', async () => {
    const buffer = await generateExpensesPdf({ page: 1, limit: 100 }, [SAMPLE_ROW], 1, 1234.5, 'SM North', 'POTATO CORNER');
    // The raw ISO string must not appear verbatim in a rendered report cell.
    expect(extractPdfText(buffer)).not.toContain('2026-07-30T04:00:00.000Z');
  });

  it('handles a long vendor name and long recorded-by name without throwing, columns sized to fit', async () => {
    const rows: ExpensesExportRow[] = [
      {
        incurred_at: '2026-07-30T04:00:00.000Z',
        branch: 'SM North',
        category: 'utilities',
        vendor_name: 'A Very Long Vendor Company Name Incorporated Philippines',
        amount: formatPhp(1234.5),
        created_by_name: 'A Very Long Employee Full Name Dela Cruz',
        proof_available: 'No',
      },
    ];
    const buffer = await generateExpensesPdf({ page: 1, limit: 100 }, rows, 1, 1234.5, 'SM North', 'POTATO CORNER');
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('renders a multi-page PDF without throwing when row count spans multiple pages, repeating the header row', async () => {
    const rows: ExpensesExportRow[] = Array.from({ length: 100 }, (_, i) => ({
      incurred_at: '2026-07-30T04:00:00.000Z',
      branch: 'SM North',
      category: 'utilities',
      vendor_name: `Vendor ${i}`,
      amount: formatPhp(100 + i),
      created_by_name: 'Juan Dela Cruz',
      proof_available: i % 2 === 0 ? 'Yes' : 'No',
    }));
    const buffer = await generateExpensesPdf({ page: 1, limit: 100 }, rows, 100, 15000, 'SM North', 'POTATO CORNER');
    expect(buffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
    const boxCount = (buffer.toString('latin1').match(/\/MediaBox/g) ?? []).length;
    expect(boxCount).toBeGreaterThan(1);
  }, 60000);

  it('exports exactly the seven required columns in the required order: Date, Branch, Category, Vendor, Amount, Recorded By, Proof Available', () => {
    expect(EXPENSES_EXPORT_COLUMNS.map((c) => c.header)).toEqual([
      'Date',
      'Branch',
      'Category',
      'Vendor',
      'Amount',
      'Recorded By',
      'Proof Available',
    ]);
  });
});
