import { z } from 'zod';
import { EXPENSE_CATEGORY, type ExpenseCategory } from '../constants/status.js';

const expenseCategoryValues = Object.values(EXPENSE_CATEGORY) as [string, ...string[]];

/**
 * POS-PERF-P60 — expenses.category is required by the column and by an older API
 * reading the row, so a typed expense stores this. Nothing reads it from a typed
 * row: see expenseDisplayName and buildWhere (expenses.repository.ts).
 */
export const EXPENSE_TYPED_CATEGORY: ExpenseCategory = EXPENSE_CATEGORY.MISCELLANEOUS;

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  utilities: 'Utilities',
  supplies: 'Supplies',
  staff_meals: 'Staff Meals',
  miscellaneous: 'Miscellaneous',
};

/** A legacy expense's only label, kept apart from a same-named type. */
export function legacyExpenseCategoryLabel(category: string): string {
  return `${EXPENSE_CATEGORY_LABELS[category as ExpenseCategory] ?? category} (legacy)`;
}

/** The name an expense was recorded under. Never read the placeholder category of a typed expense. */
export function expenseDisplayName(expense: { expense_type_id?: string | null; expense_type_name?: string | null; category: string }): string {
  return expense.expense_type_id && expense.expense_type_name ? expense.expense_type_name : legacyExpenseCategoryLabel(expense.category);
}

/** The fields without the type-or-category rule, for a form to extend. */
export const expenseFieldsSchema = z.object({
  branch_id: z.uuid(),
  /** Set by a client older than POS-PERF-P60 only: it records a legacy expense. */
  category: z.enum(expenseCategoryValues).optional(),
  expense_type_id: z.uuid().optional(),
  amount: z.coerce.number().positive().max(9999999999.99),
  vendor_name: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  // Manila business date, e.g. "2026-07-30" — a date-only field, never a
  // full ISO timestamp. The API resolves it against Asia/Manila (see
  // manilaDateStringToUtc) so it isn't misread as UTC midnight.
  incurred_at: z.iso.date(),
});

const NOT_BOTH = 'Send an expense type or a legacy category, not both';

export const createExpenseSchema = expenseFieldsSchema.superRefine((data, ctx) => {
  if (data.expense_type_id && data.category) {
    ctx.addIssue({ code: 'custom', path: ['expense_type_id'], message: NOT_BOTH });
  } else if (!data.expense_type_id && !data.category) {
    ctx.addIssue({ code: 'custom', path: ['expense_type_id'], message: 'Choose an expense type' });
  }
});

export const updateExpenseSchema = expenseFieldsSchema.partial().superRefine((data, ctx) => {
  if (data.expense_type_id && data.category) ctx.addIssue({ code: 'custom', path: ['expense_type_id'], message: NOT_BOTH });
});

/**
 * One ledger, one set of filters: the list, the summary and the exports all apply
 * these through buildWhere. `category` and `unassigned` only ever match legacy expenses.
 */
const expenseLedgerFilterShape = {
  branch_id: z.uuid().optional(),
  expense_type_id: z.uuid().optional(),
  category: z.enum(expenseCategoryValues).optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  date_from: z.iso.date().optional(),
  date_to: z.iso.date().optional(),
};

const refineTypeFilter = (data: { expense_type_id?: string; category?: string; unassigned?: boolean }, ctx: z.RefinementCtx) => {
  if (data.expense_type_id && (data.category || data.unassigned)) {
    ctx.addIssue({ code: 'custom', path: ['expense_type_id'], message: 'A type filter cannot be combined with a legacy filter' });
  }
};

export const expenseListQuerySchema = z
  .object({
    ...expenseLedgerFilterShape,
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(25),
  })
  .superRefine(refineTypeFilter);

export const expenseSummaryQuerySchema = z.object(expenseLedgerFilterShape).superRefine(refineTypeFilter);

export const expenseResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  category: z.enum(expenseCategoryValues),
  /** Null on a legacy expense. */
  expense_type_id: z.uuid().nullable(),
  /** The name recorded on this expense. */
  expense_type_name: z.string().nullable(),
  /** The type's name today, which may differ from the recorded one. */
  expense_type_current_name: z.string().nullable(),
  expense_type_is_active: z.boolean().nullable(),
  amount: z.number(),
  vendor_name: z.string().nullable(),
  description: z.string().nullable(),
  receipt_url: z.string().nullable(),
  incurred_at: z.iso.datetime(),
  created_by: z.uuid(),
  created_by_name: z.string(),
  created_at: z.iso.datetime(),
});

export const expenseListResponseSchema = z.object({
  expenses: z.array(expenseResponseSchema),
  total: z.number().int(),
  total_amount: z.number(),
  page: z.number().int(),
  limit: z.number().int(),
});

/** One line of a breakdown. A type is grouped by id, so same-named types stay apart; a legacy line by its category. */
export const expenseSummaryGroupSchema = z.object({
  key: z.string(),
  kind: z.enum(['type', 'legacy']),
  expense_type_id: z.uuid().nullable(),
  category: z.enum(expenseCategoryValues).nullable(),
  /** The type's current name, or the legacy category's label. */
  name: z.string(),
  /** Null for a legacy line. */
  is_active: z.boolean().nullable(),
  count: z.number().int(),
  total_amount: z.number(),
});

export const expenseSummaryResponseSchema = z.object({
  total: z.number().int(),
  total_amount: z.number(),
  groups: z.array(expenseSummaryGroupSchema),
});
