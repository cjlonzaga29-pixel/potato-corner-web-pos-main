import { z } from 'zod';
import { EXPENSE_CATEGORY } from '../constants/status.js';

const expenseCategoryValues = Object.values(EXPENSE_CATEGORY) as [string, ...string[]];

export const createExpenseSchema = z.object({
  branch_id: z.uuid(),
  category: z.enum(expenseCategoryValues),
  amount: z.coerce.number().positive().max(9999999999.99),
  vendor_name: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  incurred_at: z.iso.datetime(),
});

export const updateExpenseSchema = createExpenseSchema.partial();

export const expenseListQuerySchema = z.object({
  branch_id: z.uuid().optional(),
  category: z.enum(expenseCategoryValues).optional(),
  date_from: z.iso.date().optional(),
  date_to: z.iso.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const expenseResponseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  branch_name: z.string(),
  category: z.enum(expenseCategoryValues),
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
