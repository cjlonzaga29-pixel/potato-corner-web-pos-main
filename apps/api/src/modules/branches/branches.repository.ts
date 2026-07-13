import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import type { BranchListFilters, CreateBranchData, UpdateBranchData } from './branches.types.js';

const activeAssignmentsInclude = {
  userAssignments: {
    where: { removedAt: null },
    select: {
      id: true,
      userId: true,
      branchId: true,
      assignedAt: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
    },
  },
} satisfies Prisma.BranchInclude;

function buildWhere(filters: Pick<BranchListFilters, 'status' | 'city' | 'search' | 'ids'>): Prisma.BranchWhereInput {
  return {
    ...(filters.status && { status: filters.status }),
    ...(filters.city && { city: { contains: filters.city, mode: 'insensitive' } }),
    ...(filters.ids && { id: { in: filters.ids } }),
    ...(filters.search && {
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { code: { contains: filters.search, mode: 'insensitive' } },
      ],
    }),
  };
}

/**
 * Branches repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const branchesRepository = {
  async findAll(filters: BranchListFilters) {
    const where = buildWhere(filters);

    const [branches, total] = await Promise.all([
      prisma.branch.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: 'desc' },
        include: activeAssignmentsInclude,
      }),
      prisma.branch.count({ where }),
    ]);

    return { branches, total };
  },

  findById(id: string) {
    return prisma.branch.findUnique({
      where: { id },
      include: activeAssignmentsInclude,
    });
  },

  findByIds(ids: string[]) {
    return prisma.branch.findMany({
      where: { id: { in: ids } },
      include: activeAssignmentsInclude,
      orderBy: { createdAt: 'desc' },
    });
  },

  findByCode(code: string) {
    return prisma.branch.findUnique({ where: { code } });
  },

  create(data: CreateBranchData) {
    return prisma.branch.create({
      data: {
        name: data.name,
        code: data.code as string,
        address: data.address,
        city: data.city,
        gpsLatitude: data.gpsLatitude,
        gpsLongitude: data.gpsLongitude,
        gpsRadiusMeters: data.gpsRadiusMeters,
        status: data.status,
      },
      include: activeAssignmentsInclude,
    });
  },

  update(id: string, data: UpdateBranchData) {
    return prisma.branch.update({
      where: { id },
      data,
      include: activeAssignmentsInclude,
    });
  },

  getActiveAssignments(branchId: string) {
    return prisma.userBranchAssignment.findMany({
      where: { branchId, removedAt: null },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } } },
      orderBy: { assignedAt: 'desc' },
    });
  },

  findActiveAssignment(userId: string, branchId: string) {
    return prisma.userBranchAssignment.findFirst({
      where: { userId, branchId, removedAt: null },
    });
  },

  assignUser(userId: string, branchId: string) {
    return prisma.userBranchAssignment.create({
      data: { userId, branchId, assignedAt: new Date(), removedAt: null },
    });
  },

  removeUserAssignment(assignmentId: string) {
    return prisma.userBranchAssignment.update({
      where: { id: assignmentId },
      data: { removedAt: new Date() },
    });
  },

  getUserActiveBranches(userId: string) {
    return prisma.userBranchAssignment.findMany({
      where: { userId, removedAt: null },
      include: { branch: true },
    });
  },

  findUserById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  countActiveShifts(branchId: string) {
    return prisma.shift.count({ where: { branchId, status: 'active' } });
  },

  async branchStats(branchId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [activeShiftsCount, todayTransactions, activeStaffCount, ingredients] = await Promise.all([
      prisma.shift.count({ where: { branchId, status: 'active' } }),
      prisma.transaction.aggregate({
        where: { branchId, createdAt: { gte: startOfDay }, status: 'completed' },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      prisma.userBranchAssignment.count({
        where: { branchId, removedAt: null, user: { role: 'staff' } },
      }),
      // Prisma's filter API can't compare two columns of the same row
      // (currentStock <= lowStockThreshold) without raw SQL, which this
      // project avoids — branch ingredient lists are small, so counting
      // in application code is simpler and stays within the ORM.
      prisma.ingredient.findMany({
        where: { branchId },
        select: { currentStock: true, lowStockThreshold: true },
      }),
    ]);

    const lowStockIngredientCount = ingredients.filter(
      (ingredient) => ingredient.currentStock.lessThanOrEqualTo(ingredient.lowStockThreshold),
    ).length;

    return {
      activeShiftsCount,
      todayTransactionCount: todayTransactions._count._all,
      todayRevenue: Number(todayTransactions._sum.totalAmount ?? 0),
      activeStaffCount,
      lowStockIngredientCount,
    };
  },

  /**
   * Atomically allocates the next branch number for a city prefix — two
   * concurrent requests can never receive the same number because Redis
   * INCR is a single atomic operation server-side.
   */
  async generateBranchCode(city: string): Promise<string> {
    const citySlug = city
      .trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 3);
    const key = `branch_code_counter:${citySlug}`;
    const next = await redis.incr(key);
    return `PC-${citySlug}-${String(next).padStart(3, '0')}`;
  },
};
