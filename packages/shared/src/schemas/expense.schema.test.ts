import { describe, it, expect } from 'vitest';
import { createExpenseSchema } from './expense.schema.js';

const VALID_INPUT = {
  branch_id: '11111111-1111-4111-8111-111111111111',
  category: 'utilities',
  amount: 1500,
  incurred_at: '2026-07-30',
};

describe('createExpenseSchema — incurred_at contract', () => {
  it('accepts a Manila business date (YYYY-MM-DD)', () => {
    const result = createExpenseSchema.safeParse(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it('accepts a month/day boundary date', () => {
    expect(createExpenseSchema.safeParse({ ...VALID_INPUT, incurred_at: '2026-12-31' }).success).toBe(true);
  });

  it('accepts a leap day', () => {
    expect(createExpenseSchema.safeParse({ ...VALID_INPUT, incurred_at: '2028-02-29' }).success).toBe(true);
  });

  it('rejects an invalid calendar date', () => {
    expect(createExpenseSchema.safeParse({ ...VALID_INPUT, incurred_at: '2026-02-30' }).success).toBe(false);
  });

  it('rejects a full ISO datetime string — the field is date-only, the API resolves Manila midnight itself', () => {
    const result = createExpenseSchema.safeParse({ ...VALID_INPUT, incurred_at: '2026-07-30T00:00:00.000Z' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(createExpenseSchema.safeParse({ ...VALID_INPUT, incurred_at: '' }).success).toBe(false);
  });
});
