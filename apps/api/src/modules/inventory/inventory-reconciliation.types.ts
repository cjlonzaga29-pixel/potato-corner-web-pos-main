import type { Prisma } from '@prisma/client';

/**
 * CR-010A.3 — the projection key: InventoryStock is keyed by
 * (branchId, inventoryItemId), and an accepted InventoryIdentityMapping is
 * what routes one or more legacy Ingredient ledgers into that key.
 */
export interface ProjectionKey {
  branchId: string;
  inventoryItemId: string;
}

export interface MatchedEntry extends ProjectionKey {
  legacyIngredientIds: string[];
  quantity: Prisma.Decimal;
}

export interface MissingStockEntry extends ProjectionKey {
  legacyIngredientIds: string[];
  expectedQuantity: Prisma.Decimal;
}

export interface DriftEntry extends ProjectionKey {
  legacyIngredientIds: string[];
  expectedQuantity: Prisma.Decimal;
  actualQuantity: Prisma.Decimal;
  drift: Prisma.Decimal;
}

export interface UnresolvedMappingEntry {
  branchId: string;
  ingredientId: string;
  ingredientName: string;
  reason: 'no_mapping' | 'pending' | 'ambiguous' | 'rejected';
}

export interface OrphanStockEntry extends ProjectionKey {
  quantityOnHand: Prisma.Decimal;
}

export interface ReconciliationReport {
  matched: MatchedEntry[];
  missingStock: MissingStockEntry[];
  drift: DriftEntry[];
  unresolvedMapping: UnresolvedMappingEntry[];
  orphanStock: OrphanStockEntry[];
}

export interface OutboxStatusCounts {
  pending: number;
  processing: number;
  deferred: number;
  stuck: number;
  processed: number;
}

/** Every status other than `processed` still has a movement whose effect isn't yet reflected in InventoryStock. */
export function unprocessedOutboxCount(counts: OutboxStatusCounts): number {
  return counts.pending + counts.processing + counts.deferred + counts.stuck;
}

export interface RebuildPlanRow extends ProjectionKey {
  legacyIngredientIds: string[];
  expectedQuantity: Prisma.Decimal;
  currentQuantity: Prisma.Decimal | null;
  currentVersion: number | null;
  action: 'create' | 'update' | 'unchanged';
  /** Latest InventoryMovement.createdAt folded into expectedQuantity — written to InventoryStock.rebuiltThroughAt for this row. */
  movementCutoff: Date;
}

export interface RebuildPlan {
  rows: RebuildPlanRow[];
  orphans: OrphanStockEntry[];
  outboxCounts: OutboxStatusCounts;
  rebuildCutoff: Date;
}

export interface RebuildResult extends RebuildPlan {
  created: number;
  updated: number;
  unchanged: number;
  orphansDeleted: number;
  applied: boolean;
}
