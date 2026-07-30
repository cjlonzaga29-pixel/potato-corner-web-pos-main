import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { resolveDateRangeBoundary } from '../../lib/manila-time.js';
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
    // CR-003: branchIds is the server-computed, security-relevant scope
    // (see audit.service.ts's listLogs / audit.types.ts's AuditLogFilters);
    // it always wins over the raw client-supplied branchId when present.
    ...(filters.branchIds ? { branchId: { in: filters.branchIds } } : filters.branchId && { branchId: filters.branchId }),
    ...((filters.dateFrom || filters.dateTo) && {
      createdAt: {
        // dateFrom/dateTo are bare Manila business dates (YYYY-MM-DD) —
        // `${value}T00:00:00.000Z` anchors to Manila 8:00 AM, not Manila
        // midnight, dropping that morning's audit log entries.
        ...(filters.dateFrom && { gte: resolveDateRangeBoundary(filters.dateFrom, 'start') }),
        ...(filters.dateTo && { lte: resolveDateRangeBoundary(filters.dateTo, 'end') }),
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
