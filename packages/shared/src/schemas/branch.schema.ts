import { z } from 'zod';
import { BRANCH_STATUS, type BranchStatus } from '../constants/status.js';

const branchStatusValues = Object.values(BRANCH_STATUS) as [BranchStatus, ...BranchStatus[]];

const paymentBreakdownEntrySchema = z.object({
  total: z.number(),
  count: z.number().int(),
});

export const paymentBreakdownSchema = z.object({
  cash: paymentBreakdownEntrySchema,
  gcash: paymentBreakdownEntrySchema,
  maya: paymentBreakdownEntrySchema,
  other: paymentBreakdownEntrySchema,
});

/** PC-[CITY_SHORT]-[NUMBER] — CITY_SHORT is 2-5 uppercase letters, NUMBER is zero-padded to 3 digits. */
export const branchCodeSchema = z
  .string()
  .regex(/^PC-[A-Z]{2,5}-[0-9]{3}$/, 'Branch code must match PC-[CITY]-[NUM], e.g. PC-MNL-001');

/**
 * Task 174 — Branch Employee Authorization: creating a branch's login
 * account is optional at the schema layer (existing branches created before
 * this fix, and any future branch-then-assign-supervisor-only flow, have no
 * account), but when provided, branchesService.createBranch creates the
 * branch row and this account in the SAME database transaction — no more
 * two-step create-branch-then-create-account flow that can leave an orphan
 * branch with no login if the second call fails.
 */
export const createBranchAccountSchema = z.object({
  email: z.email('Must be a valid email'),
  password: z.string().min(8, 'Minimum 8 characters'),
});

export const createBranchSchema = z.object({
  name: z.string().min(2).max(100),
  // Omitted entirely -> auto-generated (branches.service.ts). Provided -> validated against branchCodeSchema and uniqueness.
  code: branchCodeSchema.optional(),
  address: z.string().min(5),
  city: z.string().min(2),
  gpsLatitude: z.number().min(-90).max(90).optional(),
  gpsLongitude: z.number().min(-180).max(180).optional(),
  gpsRadiusMeters: z.number().int().min(10).max(1000).default(100),
  status: z.enum(branchStatusValues).default('active'),
  account: createBranchAccountSchema.optional(),
});

/** Code is deliberately absent — branch codes are immutable after creation (locked rule). */
export const updateBranchSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  address: z.string().min(5).optional(),
  city: z.string().min(2).optional(),
  gpsLatitude: z.number().min(-90).max(90).optional(),
  gpsLongitude: z.number().min(-180).max(180).optional(),
  gpsRadiusMeters: z.number().int().min(10).max(1000).optional(),
  status: z.enum(branchStatusValues).optional(),
  gcashQrUrl: z.string().nullable().optional(),
  gcashQrKey: z.string().nullable().optional(),
});

export const changeBranchStatusSchema = z.object({
  status: z.enum(branchStatusValues),
});

export const branchResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
  address: z.string(),
  city: z.string(),
  gpsLatitude: z.number().nullable(),
  gpsLongitude: z.number().nullable(),
  gpsRadiusMeters: z.number(),
  status: z.enum(branchStatusValues),
  gcashQrUrl: z.string().nullable(),
  gcashQrKey: z.string().nullable(),
  activeSupervisorCount: z.number().int(),
  activeStaffCount: z.number().int(),
  currentStatusLabel: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const branchListResponseSchema = z.object({
  branches: z.array(branchResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const assignSupervisorSchema = z.object({
  userId: z.uuid(),
});

export const bulkAssignGcashQrSchema = z.object({
  branchIds: z.array(z.uuid()).min(1).max(50),
});

export const branchAssignmentResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  branchId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.email(),
  role: z.string(),
  assignedAt: z.iso.datetime(),
});

export const branchStatsResponseSchema = z.object({
  activeShiftsCount: z.number().int(),
  todayTransactionCount: z.number().int(),
  todayGrossSales: z.number(),
  todayDiscountTotal: z.number(),
  todayRefundTotal: z.number(),
  todayNetSales: z.number(),
  todayVat: z.number(),
  todayCogs: z.number(),
  todayGrossProfit: z.number(),
  todayExpenses: z.number(),
  todayNetProfit: z.number(),
  // True when any component's cost couldn't be resolved (no InventoryStock/InventoryItem
  // unit cost captured or currently available) — the audit's "Estimated Net Profit" rule.
  isNetProfitEstimated: z.boolean(),
  missingCostItemCount: z.number().int(),
  paymentBreakdown: paymentBreakdownSchema,
  activeStaffCount: z.number().int(),
  staffTimedInCount: z.number().int(),
  lowStockIngredientCount: z.number().int(),
});
