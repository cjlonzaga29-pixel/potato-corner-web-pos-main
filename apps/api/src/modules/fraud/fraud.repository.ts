import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { FraudAlertFilters, UpdateFraudAlertStatusData } from './fraud.types.js';

/**
 * branch is a real FK relation (fraud_alerts.branch_id -> branches.id) so it
 * can be included directly. employee_id has no such relation in the schema
 * — it's a bare column with no FK to users — so employee names are resolved
 * separately via findEmployeeNamesByIds rather than an include here.
 */
const fraudAlertInclude = {
  branch: { select: { id: true, name: true } },
} satisfies Prisma.FraudAlertInclude;

function buildWhere(filters: FraudAlertFilters): Prisma.FraudAlertWhereInput {
  return {
    ...(filters.branchId && { branchId: filters.branchId }),
    ...(filters.status && { status: filters.status }),
    ...(filters.severity && { severity: filters.severity }),
    ...(filters.alertType && { alertType: filters.alertType }),
  };
}

/**
 * Fraud repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const fraudRepository = {
  async findAll(filters: FraudAlertFilters) {
    const where = buildWhere(filters);
    const [alerts, total] = await Promise.all([
      prisma.fraudAlert.findMany({
        where,
        include: fraudAlertInclude,
        // createdAt DESC primary, severity DESC secondary — Postgres native
        // enums sort by declaration order (low, medium, high, critical), so
        // 'desc' puts critical first among rows created at the same time.
        orderBy: [{ createdAt: 'desc' }, { severity: 'desc' }],
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.fraudAlert.count({ where }),
    ]);
    return { alerts, total };
  },

  findById(id: string) {
    return prisma.fraudAlert.findUnique({ where: { id }, include: fraudAlertInclude });
  },

  updateStatus(id: string, data: UpdateFraudAlertStatusData) {
    return prisma.fraudAlert.update({
      where: { id },
      data: {
        status: data.status,
        ...(data.investigatedBy !== undefined && { investigatedBy: data.investigatedBy }),
        ...(data.dismissalReason !== undefined && { dismissalReason: data.dismissalReason }),
      },
      include: fraudAlertInclude,
    });
  },

  /** Batch lookup for the response's employee_name field — see the note on fraudAlertInclude above. */
  findEmployeeNamesByIds(employeeIds: string[]) {
    if (employeeIds.length === 0) return Promise.resolve([]);
    return prisma.user.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, firstName: true, lastName: true },
    });
  },
};
