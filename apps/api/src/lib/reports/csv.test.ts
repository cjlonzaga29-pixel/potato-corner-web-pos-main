// apps/api/src/lib/reports/csv.test.ts
import { describe, it, expect } from 'vitest';
import { generateCsv } from './csv.js';

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
});
