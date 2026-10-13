import type { CatalogResourceType } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import type { DependentSummaryRow, ResourceOwnershipSnapshot } from './catalog-assignment.types.js';

/**
 * POS-PERF-P35R — one switch per concern (ownership lookup, CAS update,
 * dependent counting) rather than a single generic "any model" helper:
 * each catalog/inventory-definition model has a different label field and a
 * different notion of "what references it", so a fully generic abstraction
 * would just hide that difference behind indirection, not remove it.
 */

async function findOwnership(resourceType: CatalogResourceType, resourceId: string): Promise<ResourceOwnershipSnapshot> {
  switch (resourceType) {
    case 'PRODUCT': {
      const row = await prisma.product.findUnique({
        where: { id: resourceId },
        select: { name: true, createdBy: true, managedBy: true, exclusiveBranchId: true, branchExclusive: true },
      });
      if (!row) return emptySnapshot();
      return {
        exists: true,
        createdBy: row.createdBy,
        managedBy: row.managedBy,
        label: row.name,
        exclusiveBranchId: row.branchExclusive ? row.exclusiveBranchId : null,
      };
    }
    case 'PRODUCT_CATEGORY': {
      const row = await prisma.productCategory.findUnique({ where: { id: resourceId }, select: { name: true, createdBy: true, managedBy: true } });
      return row ? { exists: true, createdBy: row.createdBy, managedBy: row.managedBy, label: row.name, exclusiveBranchId: null } : emptySnapshot();
    }
    case 'PRODUCT_OPTION_GROUP': {
      const row = await prisma.productOptionGroup.findUnique({ where: { id: resourceId }, select: { name: true, createdBy: true, managedBy: true } });
      return row ? { exists: true, createdBy: row.createdBy, managedBy: row.managedBy, label: row.name, exclusiveBranchId: null } : emptySnapshot();
    }
    case 'PRODUCT_OPTION': {
      const row = await prisma.productOption.findUnique({ where: { id: resourceId }, select: { name: true, createdBy: true, managedBy: true } });
      return row ? { exists: true, createdBy: row.createdBy, managedBy: row.managedBy, label: row.name, exclusiveBranchId: null } : emptySnapshot();
    }
    case 'INVENTORY_CATEGORY': {
      const row = await prisma.inventoryCategory.findUnique({ where: { id: resourceId }, select: { name: true, createdBy: true, managedBy: true } });
      return row ? { exists: true, createdBy: row.createdBy, managedBy: row.managedBy, label: row.name, exclusiveBranchId: null } : emptySnapshot();
    }
    case 'UNIT_OF_MEASURE': {
      const row = await prisma.unitOfMeasure.findUnique({ where: { id: resourceId }, select: { name: true, createdBy: true, managedBy: true } });
      return row ? { exists: true, createdBy: row.createdBy, managedBy: row.managedBy, label: row.name, exclusiveBranchId: null } : emptySnapshot();
    }
    case 'UNIT_CONVERSION': {
      const row = await prisma.unitConversion.findUnique({
        where: { id: resourceId },
        select: { createdBy: true, managedBy: true, fromUnit: { select: { code: true } }, toUnit: { select: { code: true } } },
      });
      return row
        ? { exists: true, createdBy: row.createdBy, managedBy: row.managedBy, label: `${row.fromUnit.code} -> ${row.toUnit.code}`, exclusiveBranchId: null }
        : emptySnapshot();
    }
    case 'INVENTORY_ITEM': {
      const row = await prisma.inventoryItem.findUnique({ where: { id: resourceId }, select: { name: true, createdBy: true, managedBy: true } });
      return row ? { exists: true, createdBy: row.createdBy, managedBy: row.managedBy, label: row.name, exclusiveBranchId: null } : emptySnapshot();
    }
  }
}

function emptySnapshot(): ResourceOwnershipSnapshot {
  return { exists: false, createdBy: null, managedBy: null, label: '', exclusiveBranchId: null };
}

/**
 * Compare-and-swap managedBy update: the WHERE clause pins the row to the
 * exact previousManagedBy value read just before this call, so Postgres
 * only applies the write if nothing else changed it in between — a single
 * atomic UPDATE, no advisory lock or raw SQL needed. Returns false (no row
 * matched) when a concurrent assignment won the race; the caller surfaces
 * that as a conflict rather than silently overwriting it.
 */
async function casUpdateManagedBy(
  resourceType: CatalogResourceType,
  resourceId: string,
  previousManagedBy: string | null,
  newManagedBy: string,
): Promise<boolean> {
  const where = { id: resourceId, managedBy: previousManagedBy } as const;
  const data = { managedBy: newManagedBy };
  let count: number;
  switch (resourceType) {
    case 'PRODUCT':
      count = (await prisma.product.updateMany({ where, data })).count;
      break;
    case 'PRODUCT_CATEGORY':
      count = (await prisma.productCategory.updateMany({ where, data })).count;
      break;
    case 'PRODUCT_OPTION_GROUP':
      count = (await prisma.productOptionGroup.updateMany({ where, data })).count;
      break;
    case 'PRODUCT_OPTION':
      count = (await prisma.productOption.updateMany({ where, data })).count;
      break;
    case 'INVENTORY_CATEGORY':
      count = (await prisma.inventoryCategory.updateMany({ where, data })).count;
      break;
    case 'UNIT_OF_MEASURE':
      count = (await prisma.unitOfMeasure.updateMany({ where, data })).count;
      break;
    case 'UNIT_CONVERSION':
      count = (await prisma.unitConversion.updateMany({ where, data })).count;
      break;
    case 'INVENTORY_ITEM':
      count = (await prisma.inventoryItem.updateMany({ where, data })).count;
      break;
  }
  return count === 1;
}

/**
 * How many other catalog records reference this one, and across how many
 * distinct effective managers (managedBy ?? createdBy, excluding NULL and
 * the record being reassigned itself) — the shared-reference-protection
 * signal shown in the impact preview before an assignment is confirmed.
 */
async function countDependents(resourceType: CatalogResourceType, resourceId: string): Promise<DependentSummaryRow[]> {
  switch (resourceType) {
    case 'PRODUCT_CATEGORY': {
      const rows = await prisma.product.findMany({ where: { categoryId: resourceId }, select: { createdBy: true, managedBy: true } });
      return [summarize('PRODUCT', rows)];
    }
    case 'PRODUCT_OPTION_GROUP': {
      const options = await prisma.productOption.findMany({ where: { optionGroupId: resourceId }, select: { createdBy: true, managedBy: true } });
      return [summarize('PRODUCT_OPTION', options)];
    }
    case 'INVENTORY_CATEGORY': {
      const items = await prisma.inventoryItem.findMany({ where: { categoryId: resourceId }, select: { createdBy: true, managedBy: true } });
      return [summarize('INVENTORY_ITEM', items)];
    }
    case 'UNIT_OF_MEASURE': {
      const items = await prisma.inventoryItem.findMany({ where: { baseUnitId: resourceId }, select: { createdBy: true, managedBy: true } });
      const conversions = await prisma.unitConversion.findMany({
        where: { OR: [{ fromUnitId: resourceId }, { toUnitId: resourceId }] },
        select: { createdBy: true, managedBy: true },
      });
      return [summarize('INVENTORY_ITEM', items), summarize('UNIT_CONVERSION', conversions)];
    }
    case 'PRODUCT':
    case 'PRODUCT_OPTION':
    case 'UNIT_CONVERSION':
    case 'INVENTORY_ITEM':
      return [];
  }
}

function summarize(resourceType: CatalogResourceType, rows: { createdBy: string | null; managedBy: string | null }[]): DependentSummaryRow {
  const managers = new Set(rows.map((r) => r.managedBy ?? r.createdBy).filter((m): m is string => m !== null));
  return { resourceType, count: rows.length, distinctOtherManagers: managers.size };
}

async function findEligibleSupervisor(supervisorId: string) {
  return prisma.user.findUnique({
    where: { id: supervisorId },
    select: { id: true, role: true, isActive: true, firstName: true, lastName: true },
  });
}

async function createAssignmentRecord(data: {
  resourceType: CatalogResourceType;
  resourceId: string;
  previousManagedBy: string | null;
  newManagedBy: string;
  assignedBy: string;
  reason: string;
  branchId: string | null;
}) {
  return prisma.catalogManagementAssignment.create({ data });
}

async function findUserLabel(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  return user ? `${user.firstName} ${user.lastName}` : null;
}

async function listAssignmentHistory(resourceType: CatalogResourceType, resourceId: string) {
  return prisma.catalogManagementAssignment.findMany({
    where: { resourceType, resourceId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Records of the given type that currently have no explicit manager
 * (managedBy IS NULL) — the Super Admin assignment UI's starting point, so
 * an operator does not need to already know a resource_id by heart. Not
 * every resourceType with managedBy=NULL is unreachable for its creator
 * (createdBy may still resolve it) — this list surfaces both, since a
 * Super Admin may want to re-home a record even when its creator could
 * already edit it (e.g. that creator left the company).
 */
async function listUnmanaged(resourceType: CatalogResourceType, page: number, limit: number) {
  const skip = (page - 1) * limit;
  switch (resourceType) {
    case 'PRODUCT': {
      const where = { managedBy: null } as const;
      const [rows, total] = await Promise.all([
        prisma.product.findMany({ where, select: { id: true, name: true, createdBy: true }, skip, take: limit, orderBy: { createdAt: 'asc' } }),
        prisma.product.count({ where }),
      ]);
      return { rows: rows.map((r) => ({ id: r.id, label: r.name, createdBy: r.createdBy })), total };
    }
    case 'PRODUCT_CATEGORY': {
      const where = { managedBy: null } as const;
      const [rows, total] = await Promise.all([
        prisma.productCategory.findMany({ where, select: { id: true, name: true, createdBy: true }, skip, take: limit, orderBy: { createdAt: 'asc' } }),
        prisma.productCategory.count({ where }),
      ]);
      return { rows: rows.map((r) => ({ id: r.id, label: r.name, createdBy: r.createdBy })), total };
    }
    case 'PRODUCT_OPTION_GROUP': {
      const where = { managedBy: null } as const;
      const [rows, total] = await Promise.all([
        prisma.productOptionGroup.findMany({ where, select: { id: true, name: true, createdBy: true }, skip, take: limit, orderBy: { createdAt: 'asc' } }),
        prisma.productOptionGroup.count({ where }),
      ]);
      return { rows: rows.map((r) => ({ id: r.id, label: r.name, createdBy: r.createdBy })), total };
    }
    case 'PRODUCT_OPTION': {
      const where = { managedBy: null } as const;
      const [rows, total] = await Promise.all([
        prisma.productOption.findMany({ where, select: { id: true, name: true, createdBy: true }, skip, take: limit, orderBy: { createdAt: 'asc' } }),
        prisma.productOption.count({ where }),
      ]);
      return { rows: rows.map((r) => ({ id: r.id, label: r.name, createdBy: r.createdBy })), total };
    }
    case 'INVENTORY_CATEGORY': {
      const where = { managedBy: null } as const;
      const [rows, total] = await Promise.all([
        prisma.inventoryCategory.findMany({ where, select: { id: true, name: true, createdBy: true }, skip, take: limit, orderBy: { createdAt: 'asc' } }),
        prisma.inventoryCategory.count({ where }),
      ]);
      return { rows: rows.map((r) => ({ id: r.id, label: r.name, createdBy: r.createdBy })), total };
    }
    case 'UNIT_OF_MEASURE': {
      const where = { managedBy: null } as const;
      const [rows, total] = await Promise.all([
        prisma.unitOfMeasure.findMany({ where, select: { id: true, name: true, createdBy: true }, skip, take: limit, orderBy: { createdAt: 'asc' } }),
        prisma.unitOfMeasure.count({ where }),
      ]);
      return { rows: rows.map((r) => ({ id: r.id, label: r.name, createdBy: r.createdBy })), total };
    }
    case 'UNIT_CONVERSION': {
      const where = { managedBy: null } as const;
      const [rows, total] = await Promise.all([
        prisma.unitConversion.findMany({
          where,
          select: { id: true, createdBy: true, fromUnit: { select: { code: true } }, toUnit: { select: { code: true } } },
          skip,
          take: limit,
          orderBy: { createdAt: 'asc' },
        }),
        prisma.unitConversion.count({ where }),
      ]);
      return { rows: rows.map((r) => ({ id: r.id, label: `${r.fromUnit.code} -> ${r.toUnit.code}`, createdBy: r.createdBy })), total };
    }
    case 'INVENTORY_ITEM': {
      const where = { managedBy: null } as const;
      const [rows, total] = await Promise.all([
        prisma.inventoryItem.findMany({ where, select: { id: true, name: true, createdBy: true }, skip, take: limit, orderBy: { createdAt: 'asc' } }),
        prisma.inventoryItem.count({ where }),
      ]);
      return { rows: rows.map((r) => ({ id: r.id, label: r.name, createdBy: r.createdBy })), total };
    }
  }
}

export const catalogAssignmentRepository = {
  findOwnership,
  casUpdateManagedBy,
  countDependents,
  findEligibleSupervisor,
  createAssignmentRecord,
  findUserLabel,
  listAssignmentHistory,
  listUnmanaged,
};
