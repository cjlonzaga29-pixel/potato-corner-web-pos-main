import { z } from 'zod';
import { BRANCH_STATUS, type BranchStatus } from '../constants/status.js';

const branchStatusValues = Object.values(BRANCH_STATUS) as [BranchStatus, ...BranchStatus[]];

/** PC-[CITY_SHORT]-[NUMBER] — CITY_SHORT is 2-5 uppercase letters, NUMBER is zero-padded to 3 digits. */
export const branchCodeSchema = z
  .string()
  .regex(/^PC-[A-Z]{2,5}-[0-9]{3}$/, 'Branch code must match PC-[CITY]-[NUM], e.g. PC-MNL-001');

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
  todayRevenue: z.number(),
  todayGrossSales: z.number(),
  todayVat: z.number(),
  todayExpenses: z.number(),
  todayNetProfit: z.number(),
  activeStaffCount: z.number().int(),
  lowStockIngredientCount: z.number().int(),
});
