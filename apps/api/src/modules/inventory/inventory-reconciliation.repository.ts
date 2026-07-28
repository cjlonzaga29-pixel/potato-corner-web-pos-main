import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { OutboxStatusCounts } from './inventory-reconciliation.types.js';

const ACCEPTED_STATUSES = ['AUTO_MATCHED', 'MANUALLY_MATCHED'] as const;

export interface AcceptedMappingRow {
  legacyIngredientId: string;
  inventoryItemId: string;
  branchId: string;
}

export interface UnacceptedMappingRow {
  legacyIngredientId: string;
  mappingStatus: string;
}

export interface IngredientMovementAggregate {
  ingredientId: string;
  sum: Prisma.Decimal;
  maxCreatedAt: Date;
}

export const inventoryReconciliationRepository = {
  /** Accepted (AUTO_MATCHED/MANUALLY_MATCHED, non-null inventoryItemId) mappings, joined to the legacy ingredient's branch. */
  async findAcceptedMappings(): Promise<AcceptedMappingRow[]> {
    const rows = await prisma.inventoryIdentityMapping.findMany({
      where: { mappingStatus: { in: [...ACCEPTED_STATUSES] }, inventoryItemId: { not: null } },
      select: { legacyIngredientId: true, inventoryItemId: true, legacyIngredient: { select: { branchId: true } } },
    });
    return rows
      .filter((row): row is typeof row & { inventoryItemId: string } => row.inventoryItemId !== null)
      .map((row) => ({
        legacyIngredientId: row.legacyIngredientId,
        inventoryItemId: row.inventoryItemId,
        branchId: row.legacyIngredient.branchId,
      }));
  },

  /** Mappings that exist but never reached an accepted status — PENDING/AMBIGUOUS/REJECTED, or a null inventoryItemId despite an accepted status. */
  async findUnacceptedMappingsByIngredientIds(ingredientIds: string[]): Promise<Map<string, string>> {
    if (ingredientIds.length === 0) return new Map();
    const rows = await prisma.inventoryIdentityMapping.findMany({
      where: { legacyIngredientId: { in: ingredientIds } },
      select: { legacyIngredientId: true, mappingStatus: true, inventoryItemId: true },
    });
    const map = new Map<string, string>();
    for (const row of rows) {
      const accepted = (ACCEPTED_STATUSES as readonly string[]).includes(row.mappingStatus) && row.inventoryItemId !== null;
      if (!accepted) map.set(row.legacyIngredientId, row.mappingStatus);
    }
    return map;
  },

  /** Ingredients (id, name, branchId) that have at least one recorded movement. */
  async findIngredientsWithMovements(): Promise<Array<{ id: string; name: string; branchId: string }>> {
    const ingredientIds = await prisma.inventoryMovement.groupBy({ by: ['ingredientId'] });
    if (ingredientIds.length === 0) return [];
    return prisma.ingredient.findMany({
      where: { id: { in: ingredientIds.map((row) => row.ingredientId) } },
      select: { id: true, name: true, branchId: true },
    });
  },

  /** Per-ingredient sum of quantityChange and the latest movement createdAt — the rebuild watermark source. */
  async aggregateMovementsByIngredient(ingredientIds: string[]): Promise<Map<string, IngredientMovementAggregate>> {
    if (ingredientIds.length === 0) return new Map();
    const rows = await prisma.inventoryMovement.groupBy({
      by: ['ingredientId'],
      where: { ingredientId: { in: ingredientIds } },
      _sum: { quantityChange: true },
      _max: { createdAt: true },
    });
    const map = new Map<string, IngredientMovementAggregate>();
    for (const row of rows) {
      map.set(row.ingredientId, {
        ingredientId: row.ingredientId,
        sum: row._sum.quantityChange ?? new Prisma.Decimal(0),
        // groupBy only returns a row when at least one movement matched, so _max.createdAt is never null here.
        maxCreatedAt: row._max.createdAt ?? new Date(0),
      });
    }
    return map;
  },

  async findAllStockRows() {
    return prisma.inventoryStock.findMany();
  },

  async getOutboxStatusCounts(): Promise<OutboxStatusCounts> {
    const rows = await prisma.inventoryProjectionOutbox.groupBy({ by: ['status'], _count: { _all: true } });
    const counts: OutboxStatusCounts = { pending: 0, processing: 0, deferred: 0, stuck: 0, processed: 0 };
    for (const row of rows) {
      counts[row.status] = row._count._all;
    }
    return counts;
  },

  /**
   * Applies one rebuild plan row: creates a missing InventoryStock row,
   * updates+bumps version on a changed one, or (for `unchanged`) only
   * refreshes the `rebuiltThroughAt` watermark so the projection worker's
   * double-apply guard covers every movement folded into this computation —
   * never bumping `version` when quantityOnHand didn't actually change.
   */
  async upsertStockRow(params: {
    branchId: string;
    inventoryItemId: string;
    expectedQuantity: Prisma.Decimal;
    action: 'create' | 'update' | 'unchanged';
    rebuiltThroughAt: Date;
  }, tx: Prisma.TransactionClient) {
    if (params.action === 'create') {
      await tx.inventoryStock.create({
        data: {
          branchId: params.branchId,
          inventoryItemId: params.inventoryItemId,
          quantityOnHand: params.expectedQuantity,
          version: 1,
          rebuiltThroughAt: params.rebuiltThroughAt,
        },
      });
      return;
    }

    const data: Prisma.InventoryStockUpdateInput = { rebuiltThroughAt: params.rebuiltThroughAt };
    if (params.action === 'update') {
      data.quantityOnHand = params.expectedQuantity;
      data.version = { increment: 1 };
    }
    await tx.inventoryStock.update({
      where: { branchId_inventoryItemId: { branchId: params.branchId, inventoryItemId: params.inventoryItemId } },
      data,
    });
  },

  async deleteOrphan(branchId: string, inventoryItemId: string, tx: Prisma.TransactionClient) {
    await tx.inventoryStock.delete({ where: { branchId_inventoryItemId: { branchId, inventoryItemId } } });
  },

  async runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(fn);
  },
};
