import { z } from 'zod';

/**
 * POS-PERF-P60 — supervisor-created expense types (Bills, Rent, ...). A type is a
 * label: it never receives stock, pays anyone or moves cash. See
 * docs/runbooks/pos-perf-p60-expense-types.md.
 */
const MAX_EXPENSE_TYPE_NAME = 60;
const MAX_EXPENSE_TYPE_BRANCHES = 100;

/**
 * The one definition of "the same name": compatibility forms folded, outer
 * whitespace dropped, inner whitespace collapsed, case ignored. The database's
 * unique index compares the stored result of this, never the display name.
 */
export function normalizeExpenseTypeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** These name the ledger's own views. The database refuses them too. */
const RESERVED_NAMES = new Set(['all', 'all expenses', 'legacy', 'unassigned']);

export function isReservedExpenseTypeName(name: string): boolean {
  return RESERVED_NAMES.has(normalizeExpenseTypeName(name));
}

const expenseTypeNameSchema = z
  .string()
  .transform((name) => name.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, 'Enter a name')
      .max(MAX_EXPENSE_TYPE_NAME, `Use at most ${MAX_EXPENSE_TYPE_NAME} characters`)
      .refine((name) => !isReservedExpenseTypeName(name), { message: 'All, All Expenses, Legacy and Unassigned are the names of ledger views' }),
  );

const expenseTypeDescriptionSchema = z.string().trim().max(300, 'Use at most 300 characters');

const expenseTypeBranchIdsSchema = z.array(z.uuid()).min(1, 'Select at least one branch').max(MAX_EXPENSE_TYPE_BRANCHES);

export const createExpenseTypeSchema = z.object({
  name: expenseTypeNameSchema,
  description: expenseTypeDescriptionSchema.optional(),
  branch_ids: expenseTypeBranchIdsSchema,
});

/** branch_ids is the whole new scope. A branch that has an expense of this type can't be removed: see the service. */
export const updateExpenseTypeSchema = z.object({
  name: expenseTypeNameSchema.optional(),
  description: expenseTypeDescriptionSchema.nullable().optional(),
  branch_ids: expenseTypeBranchIdsSchema.optional(),
  expected_version: z.number().int().positive(),
});

export const expenseTypeTransitionSchema = z.object({ expected_version: z.number().int().positive() });

export const expenseTypeListQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  include_inactive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(true),
});

export const expenseTypeResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  version: z.number().int(),
  /** Only the branches the caller can access. */
  branches: z.array(z.object({ branch_id: z.uuid(), branch_name: z.string() })),
  /** Branches in the type's scope that the caller can't access. */
  other_branch_count: z.number().int(),
  /** A supervisor whose live assignments cover the type's whole scope. */
  can_manage: z.boolean(),
  /** Across the caller's accessible branches. */
  expense_count: z.number().int(),
});

export const expenseTypeListResponseSchema = z.object({ types: z.array(expenseTypeResponseSchema) });
