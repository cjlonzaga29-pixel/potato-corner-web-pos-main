import { inventoryRepository } from './inventory.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };

interface CreateIngredientInput {
  branch_id: string;
  name: string;
  unit: string;
  current_stock: number;
  low_stock_threshold: number;
  critical_threshold: number;
  unit_cost?: number;
}

function toIngredientResponse(ingredient: {
  id: string;
  branchId: string;
  name: string;
  unit: string;
  currentStock: { toNumber(): number };
  lowStockThreshold: { toNumber(): number };
  criticalThreshold: { toNumber(): number };
  unitCost: { toNumber(): number } | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: ingredient.id,
    branch_id: ingredient.branchId,
    name: ingredient.name,
    unit: ingredient.unit,
    current_stock: ingredient.currentStock.toNumber(),
    low_stock_threshold: ingredient.lowStockThreshold.toNumber(),
    critical_threshold: ingredient.criticalThreshold.toNumber(),
    unit_cost: ingredient.unitCost?.toNumber() ?? null,
    created_at: ingredient.createdAt.toISOString(),
    updated_at: ingredient.updatedAt.toISOString(),
  };
}

export const inventoryService = {
  async listIngredients(branchId: string | undefined) {
    const rows = await inventoryRepository.findAllIngredients(branchId);
    return { ingredients: rows.map(toIngredientResponse) };
  },

  async createIngredient(data: CreateIngredientInput, actor: ActorContext, ipAddress: string | null) {
    const created = await inventoryRepository.createIngredient({
      branchId: data.branch_id,
      name: data.name,
      unit: data.unit,
      currentStock: data.current_stock,
      lowStockThreshold: data.low_stock_threshold,
      criticalThreshold: data.critical_threshold,
      unitCost: data.unit_cost,
    });
    const response = toIngredientResponse(created);

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
};
