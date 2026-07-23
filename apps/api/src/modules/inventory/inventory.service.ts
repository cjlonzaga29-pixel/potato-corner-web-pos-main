import { Prisma } from '@prisma/client';
import { MOVEMENT_TYPE, SOCKET_EVENTS, type MovementType } from '@potato-corner/shared';
import type {
  CreateIngredientInput,
  UpdateIngredientInput,
  StockInInput,
  AdjustIngredientInput,
  WasteIngredientInput,
  TransferIngredientInput,
  PhysicalCountSubmission,
} from '@potato-corner/shared';
import { inventoryRepository } from './inventory.repository.js';
import { IngredientError, LARGE_ADJUSTMENT_APPROVAL_THRESHOLD_PHP } from './inventory.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { enqueueRawNotificationJob, enqueueNotification } from '../../queues/notification.queue.js';
import { notifyBranch } from '../../lib/notify.js';

type ActorContext = { id: string; role: string };

/** Structural zero, matching the {toNumber(): number} shape every Decimal-bearing field uses — avoids importing the Prisma namespace into the service layer. */
const ZERO_STOCK = { toNumber: () => 0 };

interface IngredientRow {
  id: string;
  branchId: string;
  name: string;
  unit: string;
  lowStockThreshold: { toNumber(): number };
  criticalThreshold: { toNumber(): number };
  unitCost: { toNumber(): number } | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MovementRow {
  id: string;
  branchId: string;
  ingredientId: string;
  ingredient: { name: string };
  movementType: string;
  quantityChange: { toNumber(): number };
  quantityBefore: { toNumber(): number };
  quantityAfter: { toNumber(): number };
  referenceId: string | null;
  notes: string | null;
  imageProofUrl: string | null;
  imageProofType: string | null;
  approvedBy: string | null;
  recordedBy: string | null;
  createdAt: Date;
}

function toIngredientResponse(ingredient: IngredientRow, currentStock: { toNumber(): number }) {
  return {
    id: ingredient.id,
    branch_id: ingredient.branchId,
    name: ingredient.name,
    unit: ingredient.unit,
    current_stock: currentStock.toNumber(),
    low_stock_threshold: ingredient.lowStockThreshold.toNumber(),
    critical_threshold: ingredient.criticalThreshold.toNumber(),
    unit_cost: ingredient.unitCost?.toNumber() ?? null,
    created_at: ingredient.createdAt.toISOString(),
    updated_at: ingredient.updatedAt.toISOString(),
  };
}

function toMovementResponse(row: MovementRow) {
  return {
    id: row.id,
    branch_id: row.branchId,
    ingredient_id: row.ingredientId,
    ingredient_name: row.ingredient.name,
    movement_type: row.movementType,
    quantity_change: row.quantityChange.toNumber(),
    quantity_before: row.quantityBefore.toNumber(),
    quantity_after: row.quantityAfter.toNumber(),
    reference_id: row.referenceId,
    notes: row.notes,
    image_proof_url: row.imageProofUrl,
    image_proof_type: row.imageProofType,
    approved_by: row.approvedBy,
    recorded_by: row.recordedBy,
    created_at: row.createdAt.toISOString(),
  };
}

function classifyStatus(currentStock: number, lowThreshold: number, criticalThreshold: number): 'ok' | 'low' | 'critical' {
  if (currentStock <= criticalThreshold) return 'critical';
  if (currentStock <= lowThreshold) return 'low';
  return 'ok';
}

/**
 * Same low_stock_alert job the sale-deduction worker enqueues (queues/inventory.queue.ts's
 * processSaleDeduction) — reused here so a direct movement (stock-in/adjust/waste/transfer)
 * gets the identical decoupled alert delivery a sale-triggered deduction already gets,
 * instead of a second, divergent notification path. Fire-and-forget: a queue outage must
 * never fail an already-committed movement.
 */
async function notifyIfLowStock(params: {
  branchId: string;
  ingredientId: string;
  ingredientName: string;
  quantityAfter: { toNumber(): number };
  lowStockThreshold: { toNumber(): number };
  criticalThreshold: { toNumber(): number };
}): Promise<void> {
  const currentStock = params.quantityAfter.toNumber();
  const lowThreshold = params.lowStockThreshold.toNumber();
  if (currentStock > lowThreshold) return;

  try {
    await enqueueRawNotificationJob('low_stock_alert', {
      branchId: params.branchId,
      ingredientId: params.ingredientId,
      ingredientName: params.ingredientName,
      currentStock,
      lowStockThreshold: lowThreshold,
      criticalThreshold: params.criticalThreshold.toNumber(),
      severity: currentStock <= params.criticalThreshold.toNumber() ? 'critical' : 'low',
    });
  } catch (error) {
    console.error(`Failed to enqueue low-stock alert for ingredient ${params.ingredientId}:`, error);
  }
}

/** Shared by getBranchInventory and getBranchAlerts so the latter is always a strict filter of the former, never a second, divergent query. */
async function buildBranchInventoryRows(branchId: string) {
  const rows = await inventoryRepository.findAllIngredients(branchId);
  const stockMap = await inventoryRepository.getCurrentStockMap(rows.map((r) => r.id));

  return rows.map((r) => {
    const stock = (stockMap.get(r.id) ?? ZERO_STOCK).toNumber();
    const lowThreshold = r.lowStockThreshold.toNumber();
    const criticalThreshold = r.criticalThreshold.toNumber();
    return {
      ingredient_id: r.id,
      name: r.name,
      unit: r.unit,
      current_stock: stock,
      low_stock_threshold: lowThreshold,
      critical_threshold: criticalThreshold,
      status: classifyStatus(stock, lowThreshold, criticalThreshold),
    };
  });
}

export const inventoryService = {
  async listIngredients(branchId: string | undefined) {
    const rows = await inventoryRepository.findAllIngredients(branchId);
    const stockMap = await inventoryRepository.getCurrentStockMap(rows.map((r) => r.id));
    return { ingredients: rows.map((r) => toIngredientResponse(r, stockMap.get(r.id) ?? ZERO_STOCK)) };
  },

  async getIngredientById(id: string) {
    const ingredient = await inventoryRepository.findIngredientById(id);
    if (!ingredient) throw new IngredientError('INGREDIENT_NOT_FOUND', 'Ingredient not found', 404);
    const currentStock = await inventoryRepository.getCurrentStock(id);
    return toIngredientResponse(ingredient, currentStock);
  },

  async createIngredient(data: CreateIngredientInput, actor: ActorContext, ipAddress: string | null) {
    let created;
    try {
      created = await inventoryRepository.createIngredient({
        branchId: data.branch_id,
        name: data.name,
        unit: data.unit,
        currentStock: data.current_stock,
        lowStockThreshold: data.low_stock_threshold,
        criticalThreshold: data.critical_threshold,
        unitCost: data.unit_cost,
      });
    } catch (error) {
      // Maps the (branch_id, name) WHERE deleted_at IS NULL partial unique
      // index violation (see schema.prisma's Ingredient model) to a real
      // domain error instead of letting it fall through to a bare 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new IngredientError('INGREDIENT_NAME_TAKEN', `An ingredient named "${data.name}" already exists at this branch`, 409);
      }
      throw error;
    }

    // Route the initial stock through the ledger too, same as every other
    // stock change — current_stock is never trusted as a standalone value.
    if (data.current_stock > 0) {
      await inventoryRepository.appendMovement({
        branchId: created.branchId,
        ingredientId: created.id,
        movementType: MOVEMENT_TYPE.STOCK_IN,
        quantityChange: data.current_stock,
        notes: 'Initial stock recorded at ingredient creation',
        recordedBy: actor.id,
      });
    }

    const currentStock = await inventoryRepository.getCurrentStock(created.id);
    const response = toIngredientResponse(created, currentStock);

    await recordAuditLog({
      action: 'INGREDIENT_CREATED',
      entityType: 'ingredient',
      entityId: created.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: data.branch_id,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateIngredient(id: string, data: UpdateIngredientInput, actor: ActorContext, ipAddress: string | null) {
    const existing = await inventoryRepository.findIngredientById(id);
    if (!existing) throw new IngredientError('INGREDIENT_NOT_FOUND', 'Ingredient not found', 404);

    const updated = await inventoryRepository.updateIngredient(id, {
      name: data.name,
      unit: data.unit,
      lowStockThreshold: data.low_stock_threshold,
      criticalThreshold: data.critical_threshold,
      unitCost: data.unit_cost,
    });

    // Update never touches stock, so before/after share the same derived value.
    const currentStock = await inventoryRepository.getCurrentStock(id);
    const response = toIngredientResponse(updated, currentStock);

    await recordAuditLog({
      action: 'INGREDIENT_UPDATED',
      entityType: 'ingredient',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: existing.branchId,
      beforeState: toIngredientResponse(existing, currentStock),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteIngredient(id: string, actor: ActorContext, ipAddress: string | null) {
    const existing = await inventoryRepository.findIngredientById(id);
    if (!existing) throw new IngredientError('INGREDIENT_NOT_FOUND', 'Ingredient not found', 404);

    await inventoryRepository.softDeleteIngredient(id);

    await recordAuditLog({
      action: 'INGREDIENT_DELETED',
      entityType: 'ingredient',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: existing.branchId,
      beforeState: { name: existing.name, branch_id: existing.branchId },
      ipAddress,
    });
  },

  async stockIn(ingredientId: string, data: StockInInput, actor: ActorContext, ipAddress: string | null) {
    const ingredient = await inventoryRepository.findIngredientById(ingredientId);
    if (!ingredient) throw new IngredientError('INGREDIENT_NOT_FOUND', 'Ingredient not found', 404);

    const movement = await inventoryRepository.appendMovement({
      branchId: ingredient.branchId,
      ingredientId,
      movementType: MOVEMENT_TYPE.STOCK_IN,
      quantityChange: data.quantity,
      notes: data.supplier_reference
        ? `Supplier ref: ${data.supplier_reference}${data.notes ? ` — ${data.notes}` : ''}`
        : data.notes,
      recordedBy: actor.id,
    });
    const response = toMovementResponse(movement);

    await recordAuditLog({
      action: 'INVENTORY_STOCK_IN',
      entityType: 'inventory_movement',
      entityId: movement.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: ingredient.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(ingredient.branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    await notifyIfLowStock({
      branchId: ingredient.branchId,
      ingredientId,
      ingredientName: ingredient.name,
      quantityAfter: movement.quantityAfter,
      lowStockThreshold: ingredient.lowStockThreshold,
      criticalThreshold: ingredient.criticalThreshold,
    });

    return response;
  },

  async adjustIngredient(ingredientId: string, data: AdjustIngredientInput, actor: ActorContext, ipAddress: string | null) {
    const ingredient = await inventoryRepository.findIngredientById(ingredientId);
    if (!ingredient) throw new IngredientError('INGREDIENT_NOT_FOUND', 'Ingredient not found', 404);

    if (data.quantity_delta < 0) {
      const currentStock = await inventoryRepository.getCurrentStock(ingredientId);
      if (currentStock.toNumber() + data.quantity_delta < 0) {
        throw new IngredientError('INSUFFICIENT_STOCK', 'Adjustment would take stock below zero', 409);
      }
    }

    const movement = await inventoryRepository.appendMovement({
      branchId: ingredient.branchId,
      ingredientId,
      movementType: MOVEMENT_TYPE.MANUAL_ADJUSTMENT,
      quantityChange: data.quantity_delta,
      notes: `Reason: ${data.reason_code}${data.notes ? ` — ${data.notes}` : ''}`,
      recordedBy: actor.id,
    });
    const response = toMovementResponse(movement);

    await recordAuditLog({
      action: 'INVENTORY_ADJUSTED',
      entityType: 'inventory_movement',
      entityId: movement.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: ingredient.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(ingredient.branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    await notifyIfLowStock({
      branchId: ingredient.branchId,
      ingredientId,
      ingredientName: ingredient.name,
      quantityAfter: movement.quantityAfter,
      lowStockThreshold: ingredient.lowStockThreshold,
      criticalThreshold: ingredient.criticalThreshold,
    });

    // Phase 20 Task 5: real financial stakes at the pilot branch — a manual
    // adjustment moving ≥ LARGE_ADJUSTMENT_APPROVAL_THRESHOLD_PHP worth of
    // stock needs Supervisor/Super Admin visibility. unitCost is optional on
    // an ingredient (not every ingredient has a recorded cost yet), so an
    // unset cost can never itself trigger the notification.
    if (ingredient.unitCost) {
      const amount = Math.abs(data.quantity_delta) * ingredient.unitCost.toNumber();
      if (amount >= LARGE_ADJUSTMENT_APPROVAL_THRESHOLD_PHP) {
        try {
          await enqueueNotification('large_adjustment_approval_needed', {
            type: 'large_adjustment_approval_needed',
            branchId: ingredient.branchId,
            adjustmentId: movement.id,
            requestedByUserId: actor.id,
            amount,
          });
        } catch (error) {
          console.error(`Failed to enqueue large-adjustment approval notification for movement ${movement.id}:`, error);
        }
      }
    }

    return response;
  },

  async wasteIngredient(ingredientId: string, data: WasteIngredientInput, actor: ActorContext, ipAddress: string | null) {
    const ingredient = await inventoryRepository.findIngredientById(ingredientId);
    if (!ingredient) throw new IngredientError('INGREDIENT_NOT_FOUND', 'Ingredient not found', 404);

    const currentStock = await inventoryRepository.getCurrentStock(ingredientId);
    if (currentStock.toNumber() - data.quantity < 0) {
      throw new IngredientError('INSUFFICIENT_STOCK', 'Waste quantity exceeds current stock', 409);
    }

    const movement = await inventoryRepository.appendMovement({
      branchId: ingredient.branchId,
      ingredientId,
      movementType: MOVEMENT_TYPE.WASTE,
      quantityChange: -data.quantity,
      notes: `Reason: ${data.reason_code}${data.notes ? ` — ${data.notes}` : ''}`,
      imageProofUrl: data.image_proof_url,
      imageProofType: data.image_proof_type,
      recordedBy: actor.id,
    });
    const response = toMovementResponse(movement);

    await recordAuditLog({
      action: 'INVENTORY_WASTE_RECORDED',
      entityType: 'inventory_movement',
      entityId: movement.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: ingredient.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(ingredient.branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    await notifyIfLowStock({
      branchId: ingredient.branchId,
      ingredientId,
      ingredientName: ingredient.name,
      quantityAfter: movement.quantityAfter,
      lowStockThreshold: ingredient.lowStockThreshold,
      criticalThreshold: ingredient.criticalThreshold,
    });

    return response;
  },

  async getBranchInventory(branchId: string) {
    const ingredients = await buildBranchInventoryRows(branchId);
    return { branch_id: branchId, ingredients };
  },

  async getBranchAlerts(branchId: string) {
    const rows = await buildBranchInventoryRows(branchId);
    const alerts = rows
      .filter((r) => r.status !== 'ok')
      .map((r) => ({
        ingredient_id: r.ingredient_id,
        name: r.name,
        unit: r.unit,
        current_stock: r.current_stock,
        threshold: r.status === 'critical' ? r.critical_threshold : r.low_stock_threshold,
        severity: r.status as 'low' | 'critical',
      }));
    return { branch_id: branchId, alerts };
  },

  async submitPhysicalCount(branchId: string, data: PhysicalCountSubmission, actor: ActorContext, ipAddress: string | null) {
    // Sequential, not Promise.all — each count row both reads and writes the
    // same ledger, and a branch's ingredient list is small (same reasoning
    // as branchesRepository.branchStats' in-application low-stock count).
    const results = [];
    for (const count of data.counts) {
      const ingredient = await inventoryRepository.findIngredientById(count.ingredient_id);
      if (!ingredient || ingredient.branchId !== branchId) {
        throw new IngredientError('INGREDIENT_NOT_FOUND', `Ingredient ${count.ingredient_id} not found in this branch`, 404);
      }

      const previousStock = await inventoryRepository.getCurrentStock(count.ingredient_id);
      const previousQuantity = previousStock.toNumber();
      const variance = count.counted_quantity - previousQuantity;

      if (variance !== 0) {
        await inventoryRepository.appendMovement({
          branchId,
          ingredientId: count.ingredient_id,
          movementType: MOVEMENT_TYPE.PHYSICAL_COUNT,
          quantityChange: variance,
          notes: data.notes,
          recordedBy: actor.id,
        });
      }

      results.push({
        ingredient_id: count.ingredient_id,
        counted_quantity: count.counted_quantity,
        previous_quantity: previousQuantity,
        variance,
      });
    }

    const response = { branch_id: branchId, results, submitted_at: new Date().toISOString() };

    await recordAuditLog({
      action: 'INVENTORY_PHYSICAL_COUNT_SUBMITTED',
      entityType: 'inventory_movement',
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    return response;
  },

  async transferStock(branchId: string, data: TransferIngredientInput, actor: ActorContext, ipAddress: string | null) {
    if (data.to_branch_id === branchId) {
      throw new IngredientError('INVALID_TRANSFER', 'Cannot transfer stock to the same branch', 422);
    }

    const sourceIngredient = await inventoryRepository.findIngredientById(data.ingredient_id);
    if (!sourceIngredient || sourceIngredient.branchId !== branchId) {
      throw new IngredientError('INGREDIENT_NOT_FOUND', 'Ingredient not found in the source branch', 404);
    }

    // The destination ingredient must already exist at the target branch —
    // auto-creating it here would risk silently mismatched units/thresholds.
    const destinationIngredient = await inventoryRepository.findIngredientByBranchAndName(data.to_branch_id, sourceIngredient.name);
    if (!destinationIngredient) {
      throw new IngredientError(
        'DESTINATION_INGREDIENT_NOT_FOUND',
        `No ingredient named "${sourceIngredient.name}" exists at the destination branch — create it there first`,
        422,
      );
    }

    const sourceStock = await inventoryRepository.getCurrentStock(data.ingredient_id);
    if (sourceStock.toNumber() - data.quantity < 0) {
      throw new IngredientError('INSUFFICIENT_STOCK', 'Transfer quantity exceeds current stock at the source branch', 409);
    }

    const { transferOut, transferIn } = await inventoryRepository.transferStock({
      fromBranchId: branchId,
      fromIngredientId: data.ingredient_id,
      toBranchId: data.to_branch_id,
      toIngredientId: destinationIngredient.id,
      quantity: data.quantity,
      notes: data.notes,
      recordedBy: actor.id,
    });

    const response = {
      ingredient_id: data.ingredient_id,
      to_branch_id: data.to_branch_id,
      to_ingredient_id: destinationIngredient.id,
      quantity: data.quantity,
      transfer_out: toMovementResponse(transferOut),
      transfer_in: toMovementResponse(transferIn),
    };

    await recordAuditLog({
      action: 'INVENTORY_TRANSFERRED',
      entityType: 'inventory_movement',
      entityId: transferOut.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(branchId, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);
    notifyBranch(data.to_branch_id, SOCKET_EVENTS.INVENTORY_MOVEMENT_RECORDED, response);

    await notifyIfLowStock({
      branchId,
      ingredientId: data.ingredient_id,
      ingredientName: sourceIngredient.name,
      quantityAfter: transferOut.quantityAfter,
      lowStockThreshold: sourceIngredient.lowStockThreshold,
      criticalThreshold: sourceIngredient.criticalThreshold,
    });
    await notifyIfLowStock({
      branchId: data.to_branch_id,
      ingredientId: destinationIngredient.id,
      ingredientName: destinationIngredient.name,
      quantityAfter: transferIn.quantityAfter,
      lowStockThreshold: destinationIngredient.lowStockThreshold,
      criticalThreshold: destinationIngredient.criticalThreshold,
    });

    return response;
  },

  async getMovements(
    branchId: string,
    filters: { ingredientId?: string; movementType?: MovementType; fromDate?: Date; toDate?: Date; page: number; limit: number },
  ) {
    const { movements, total } = await inventoryRepository.findMovements(branchId, filters);
    return {
      movements: movements.map(toMovementResponse),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },
};
