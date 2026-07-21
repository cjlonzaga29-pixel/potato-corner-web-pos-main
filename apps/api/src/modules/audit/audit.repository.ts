import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { AuditLogFilters } from './audit.types.js';

const auditLogInclude = {
  actor: { select: { id: true, firstName: true, lastName: true, email: true } },
  branch: { select: { id: true, name: true } },
} satisfies Prisma.AuditLogInclude;

function buildWhere(filters: AuditLogFilters): Prisma.AuditLogWhereInput {
  return {
    ...(filters.action && { action: filters.action }),
    ...(filters.entityType && { entityType: filters.entityType }),
    ...(filters.entityId && { entityId: filters.entityId }),
    ...(filters.actorId && { actorId: filters.actorId }),
    ...(filters.branchId && { branchId: filters.branchId }),
    ...((filters.dateFrom || filters.dateTo) && {
      createdAt: {
        ...(filters.dateFrom && { gte: new Date(`${filters.dateFrom}T00:00:00.000Z`) }),
        ...(filters.dateTo && { lte: new Date(`${filters.dateTo}T23:59:59.999Z`) }),
      },
    }),
  };
}

/**
 * Audit repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const auditRepository = {
  async findAll(filters: AuditLogFilters) {
    const where = buildWhere(filters);
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: auditLogInclude,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      prisma.auditLog.count({ where }),
    ]);
    return { logs, total };
  },
};
