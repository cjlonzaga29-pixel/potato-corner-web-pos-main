import { describe, it, expect } from 'vitest';
import { createExpenseSchema, expenseDisplayName, expenseListQuerySchema, updateExpenseSchema } from './expense.schema.js';
import { createExpenseTypeSchema, normalizeExpenseTypeName } from './expense-type.schema.js';

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

const TYPE_ID = '22222222-2222-4222-8222-222222222222';
const WITHOUT_CATEGORY = { branch_id: VALID_INPUT.branch_id, amount: 1500, incurred_at: '2026-07-30' };

describe('POS-PERF-P60 type or legacy category', () => {
  it('a new expense names a type', () => {
    expect(createExpenseSchema.safeParse({ ...WITHOUT_CATEGORY, expense_type_id: TYPE_ID }).success).toBe(true);
  });

  it('an old client\'s category alone is accepted, so it records a legacy expense', () => {
    expect(createExpenseSchema.safeParse(VALID_INPUT).success).toBe(true);
  });

  it('neither is refused with a message the user can act on, never a made-up category', () => {
    const result = createExpenseSchema.safeParse(WITHOUT_CATEGORY);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Choose an expense type');
  });

  it('both are refused, on create and on edit', () => {
    expect(createExpenseSchema.safeParse({ ...VALID_INPUT, expense_type_id: TYPE_ID }).success).toBe(false);
    expect(updateExpenseSchema.safeParse({ category: 'utilities', expense_type_id: TYPE_ID }).success).toBe(false);
  });

  it('an edit may send neither', () => {
    expect(updateExpenseSchema.safeParse({ amount: 10 }).success).toBe(true);
  });

  it('a type filter can\'t be combined with a legacy filter', () => {
    expect(expenseListQuerySchema.safeParse({ expense_type_id: TYPE_ID, category: 'utilities' }).success).toBe(false);
    expect(expenseListQuerySchema.safeParse({ expense_type_id: TYPE_ID, unassigned: 'true' }).success).toBe(false);
  });

  it('a typed expense reads as its recorded name, and a legacy one is labelled as legacy', () => {
    expect(expenseDisplayName({ expense_type_id: TYPE_ID, expense_type_name: 'Bills', category: 'miscellaneous' })).toBe('Bills');
    expect(expenseDisplayName({ expense_type_id: null, expense_type_name: null, category: 'staff_meals' })).toBe('Staff Meals (legacy)');
    // An older API omits the type fields altogether.
    expect(expenseDisplayName({ category: 'utilities' })).toBe('Utilities (legacy)');
  });
});

describe('POS-PERF-P60 expense type names', () => {
  it('folds case, spacing and compatibility forms into one identity', () => {
    expect(normalizeExpenseTypeName('  Product\u00a0  PURCHASES ')).toBe('product purchases');
  });

  it('stores the tidied name and refuses a blank or a view\'s own name', () => {
    expect(createExpenseTypeSchema.parse({ name: '  Rent   Due ', branch_ids: [TYPE_ID] }).name).toBe('Rent Due');
    expect(createExpenseTypeSchema.safeParse({ name: '   ', branch_ids: [TYPE_ID] }).success).toBe(false);
    expect(createExpenseTypeSchema.safeParse({ name: 'all expenses', branch_ids: [TYPE_ID] }).success).toBe(false);
    expect(createExpenseTypeSchema.safeParse({ name: 'LEGACY', branch_ids: [TYPE_ID] }).success).toBe(false);
  });

  it('needs at least one branch', () => {
    expect(createExpenseTypeSchema.safeParse({ name: 'Rent', branch_ids: [] }).success).toBe(false);
  });
});
