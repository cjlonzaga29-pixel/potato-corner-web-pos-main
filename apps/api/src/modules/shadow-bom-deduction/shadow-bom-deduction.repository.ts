import type { Prisma, ShadowBomComparisonClassification } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { PersistedComparison, ShadowBomReportFilters } from './shadow-bom-deduction.types.js';

export interface AcceptedMappingWithBaseUnit {
  inventoryItemId: string;
  baseUnitId: string;
  baseUnitCode: string;
}

export interface ActiveComponentRow {
  inventoryItemId: string;
  quantityRequired: Prisma.Decimal;
  baseUnitId: string;
  /** Null for rows with no recipe unit recorded (pre-CR-011.2 or backfill-created) — treated as already-base-unit by the caller. */
  recipeUnitId: string | null;
}

function reportWhere(filters: ShadowBomReportFilters): Prisma.ShadowBomComparisonWhereInput {
  return {
    ...(filters.branchId !== undefined && { branchId: filters.branchId }),
    ...(filters.productVariantId !== undefined && { productVariantId: filters.productVariantId }),
    ...(filters.classification !== undefined && { classification: filters.classification as ShadowBomComparisonClassification }),
    ...((filters.since !== undefined || filters.until !== undefined) && {
      comparedAt: {
        ...(filters.since !== undefined && { gte: filters.since }),
        ...(filters.until !== undefined && { lte: filters.until }),
      },
    }),
  };
}

/**
 * Read/write layer for CR-012.1's shadow comparison. The only writes here
 * are to ShadowBomComparison itself (append-only, idempotent-by-upsert) --
 * nothing in this module ever touches InventoryMovement, InventoryStock, or
 * ProductInventory.
 */
export const shadowBomDeductionRepository = {
  /**
   * Idempotent by the (transaction_id, sale_line_id) unique constraint: a
   * duplicate `runShadowComparison` call for the same sale line (e.g. a
   * retried outbox-less fire-and-forget call) overwrites the same row
   * rather than creating a second one.
   */
  upsertComparison(data: PersistedComparison) {
    const shared = {
      branchId: data.branchId,
      productVariantId: data.productVariantId,
      legacyCalculation: data.legacyCalculation as Prisma.InputJsonValue,
      bomCalculation: (data.bomCalculation ?? undefined) as Prisma.InputJsonValue | undefined,
      classification: data.classification as ShadowBomComparisonClassification,
      errorDetails: (data.errorDetails ?? undefined) as Prisma.InputJsonValue | undefined,
      comparedAt: new Date(),
    };
    return prisma.shadowBomComparison.upsert({
      where: { transactionId_saleLineId: { transactionId: data.transactionId, saleLineId: data.saleLineId } },
      create: { transactionId: data.transactionId, saleLineId: data.saleLineId, ...shared },
      update: { ...shared },
    });
  },

  /**
   * A legacy ingredient only counts as resolvable for shadow-comparison
   * purposes under the same rule inventoryProjectionRepository.findAcceptedMapping
   * uses for live projection: AUTO_MATCHED/MANUALLY_MATCHED status AND a
   * non-null inventoryItemId. PENDING/AMBIGUOUS/REJECTED, or no mapping row
   * at all, both resolve to null here.
   */
  async findAcceptedMappingWithBaseUnit(legacyIngredientId: string): Promise<AcceptedMappingWithBaseUnit | null> {
    const mapping = await prisma.inventoryIdentityMapping.findUnique({
      where: { legacyIngredientId },
      select: {
        inventoryItemId: true,
        mappingStatus: true,
        inventoryItem: { select: { baseUnitId: true, baseUnit: { select: { code: true } } } },
      },
    });
    if (!mapping || !mapping.inventoryItemId || !mapping.inventoryItem) return null;
    if (mapping.mappingStatus !== 'AUTO_MATCHED' && mapping.mappingStatus !== 'MANUALLY_MATCHED') return null;
    return {
      inventoryItemId: mapping.inventoryItemId,
      baseUnitId: mapping.inventoryItem.baseUnitId,
      baseUnitCode: mapping.inventoryItem.baseUnit.code,
    };
  },

  /** Active (non-soft-deleted, isActive) ProductComponent rows for a variant, already expressed in each InventoryItem's own base unit. */
  async findActiveComponentsForVariant(
    productVariantId: string,
    flavorId?: string | null,
    selectedOptionIds?: string[],
  ): Promise<ActiveComponentRow[]> {
    const rows = await prisma.productComponent.findMany({
      where: {
        productVariantId,
        deletedAt: null,
        isActive: true,
        AND: [
          flavorId ? { OR: [{ flavorId: null }, { flavorId }] } : { flavorId: null },
          selectedOptionIds && selectedOptionIds.length > 0
            ? { OR: [{ productOptionId: null }, { productOptionId: { in: selectedOptionIds } }] }
            : { productOptionId: null },
        ],
      },
      select: { inventoryItemId: true, quantityRequired: true, recipeUnitId: true, inventoryItem: { select: { baseUnitId: true } } },
    });
    return rows.map((row) => ({
      inventoryItemId: row.inventoryItemId,
      quantityRequired: row.quantityRequired,
      baseUnitId: row.inventoryItem.baseUnitId,
      recipeUnitId: row.recipeUnitId,
    }));
  },

  async buildSummary(filters: ShadowBomReportFilters) {
    const where = reportWhere(filters);
    const [total, grouped, affectedProducts, affectedBranches] = await Promise.all([
      prisma.shadowBomComparison.count({ where }),
      prisma.shadowBomComparison.groupBy({ by: ['classification'], where, _count: { _all: true } }),
      prisma.shadowBomComparison.findMany({
        where: { ...where, classification: { not: 'MATCH' } },
        distinct: ['productVariantId'],
        select: { productVariantId: true },
      }),
      prisma.shadowBomComparison.findMany({
        where: { ...where, classification: { not: 'MATCH' } },
        distinct: ['branchId'],
        select: { branchId: true },
      }),
    ]);

    const countsByClassification = Object.fromEntries(grouped.map((g) => [g.classification, g._count._all])) as Record<string, number>;
    const matchCount = countsByClassification.MATCH ?? 0;

    return {
      total,
      matchCount,
      countsByClassification,
      affectedProductVariantIds: affectedProducts.map((p) => p.productVariantId),
      affectedBranchIds: affectedBranches.map((b) => b.branchId),
    };
  },

  async findDetails(filters: ShadowBomReportFilters, page: number, pageSize: number) {
    const where = reportWhere(filters);
    const [rows, total] = await Promise.all([
      prisma.shadowBomComparison.findMany({
        where,
        orderBy: { comparedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.shadowBomComparison.count({ where }),
    ]);
    return { rows, total };
  },
};
