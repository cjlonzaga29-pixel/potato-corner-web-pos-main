import { recipesRepository } from './recipes.repository.js';
import { RecipeError, type DeductionLine } from './recipes.types.js';
import { productsRepository } from '../products/products.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };

interface RecipeRow {
  id: string;
  productVariantId: string;
  ingredientId: string;
  flavorId: string | null;
  quantity: { toNumber(): number };
  unit: string;
  ingredient: { name: string };
  flavor: { name: string } | null;
}

interface OverrideRow extends RecipeRow {
  branchId: string;
  reason: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function toRecipeResponse(row: RecipeRow) {
  return {
    id: row.id,
    product_variant_id: row.productVariantId,
    ingredient_id: row.ingredientId,
    ingredient_name: row.ingredient.name,
    flavor_id: row.flavorId,
    flavor_name: row.flavor?.name ?? null,
    quantity: row.quantity.toNumber(),
    unit: row.unit,
  };
}

function toOverrideResponse(row: OverrideRow) {
  return {
    ...toRecipeResponse(row),
    branch_id: row.branchId,
    reason: row.reason,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

interface CreateRecipeInput {
  product_variant_id: string;
  ingredient_id: string;
  flavor_id?: string | null;
  quantity: number;
  unit: string;
}

interface UpdateRecipeInput {
  quantity?: number;
  unit?: string;
}

interface CreateOverrideInput {
  branch_id: string;
  ingredient_id: string;
  flavor_id?: string | null;
  quantity: number;
  unit: string;
  reason: string;
}

interface UpdateOverrideInput {
  quantity?: number;
  unit?: string;
  reason: string;
}

interface ComputeDeductionInput {
  productVariantId: string;
  flavorId: string | null;
  quantitySold: number;
  branchId?: string;
}

/**
 * CR-001 Phase 7.5 deduction algorithm. Preserves the original master-only
 * behavior (architecture doc §7.1 steps 1-4) exactly when branchId is
 * omitted or the branch has no overrides — branch overrides are layered on
 * top last and only replace/add matching ingredient rows, never remove
 * master rows outright.
 *
 * Layering order (each step may replace a same-ingredient_id entry from the
 * step before it, or add a new one):
 *   1. master base      (flavor_id IS NULL)
 *   2. master flavor     (flavor_id = selected) — overrides same-ingredient master base
 *   3. branch base        — overrides same-ingredient result so far
 *   4. branch flavor       — overrides same-ingredient result so far
 */
export async function computeDeduction(input: ComputeDeductionInput): Promise<DeductionLine[]> {
  const masterRows = (await recipesRepository.findMasterRows(input.productVariantId, input.flavorId)) as RecipeRow[];
  const masterBase = masterRows.filter((r) => r.flavorId === null);
  const masterFlavor = masterRows.filter((r) => r.flavorId !== null);

  const map = new Map<string, DeductionLine>();
  for (const row of masterBase) {
    map.set(row.ingredientId, {
      ingredient_id: row.ingredientId,
      ingredient_name: row.ingredient.name,
      quantity: row.quantity.toNumber(),
      unit: row.unit,
      source: 'master_base',
    });
  }
  for (const row of masterFlavor) {
    map.set(row.ingredientId, {
      ingredient_id: row.ingredientId,
      ingredient_name: row.ingredient.name,
      quantity: row.quantity.toNumber(),
      unit: row.unit,
      source: 'master_flavor',
    });
  }

  if (input.branchId) {
    const overrideRows = (await recipesRepository.findOverrideRows(
      input.productVariantId,
      input.branchId,
      input.flavorId,
    )) as RecipeRow[];
    const branchBase = overrideRows.filter((r) => r.flavorId === null);
    const branchFlavor = overrideRows.filter((r) => r.flavorId !== null);

    for (const row of branchBase) {
      map.set(row.ingredientId, {
        ingredient_id: row.ingredientId,
        ingredient_name: row.ingredient.name,
        quantity: row.quantity.toNumber(),
        unit: row.unit,
        source: 'branch_base',
      });
    }
    for (const row of branchFlavor) {
      map.set(row.ingredientId, {
        ingredient_id: row.ingredientId,
        ingredient_name: row.ingredient.name,
        quantity: row.quantity.toNumber(),
        unit: row.unit,
        source: 'branch_flavor',
      });
    }
  }

  return Array.from(map.values()).map((line) => ({ ...line, quantity: line.quantity * input.quantitySold }));
}

export const recipesService = {
  async listRecipes(productVariantId: string) {
    const rows = (await recipesRepository.findByVariant(productVariantId)) as RecipeRow[];
    return rows.map(toRecipeResponse);
  },

  async createRecipe(data: CreateRecipeInput, actor: ActorContext, ipAddress: string | null) {
    const variant = await productsRepository.findVariantById(data.product_variant_id);
    if (!variant) throw new RecipeError('VARIANT_NOT_FOUND', 'Product variant not found', 404);

    const created = (await recipesRepository.createRecipe({
      productVariantId: data.product_variant_id,
      ingredientId: data.ingredient_id,
      flavorId: data.flavor_id ?? null,
      quantity: data.quantity,
      unit: data.unit,
    })) as RecipeRow;
    const response = toRecipeResponse(created);

    await recordAuditLog({
      action: 'RECIPE_CREATED',
      entityType: 'recipe',
      entityId: created.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateRecipe(recipeId: string, data: UpdateRecipeInput, actor: ActorContext, ipAddress: string | null) {
    const existing = (await recipesRepository.findRecipeById(recipeId)) as RecipeRow | null;
    if (!existing) throw new RecipeError('RECIPE_NOT_FOUND', 'Recipe not found', 404);

    const updated = (await recipesRepository.updateRecipe(recipeId, data)) as RecipeRow;
    const response = toRecipeResponse(updated);

    await recordAuditLog({
      action: 'RECIPE_UPDATED',
      entityType: 'recipe',
      entityId: recipeId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toRecipeResponse(existing),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteRecipe(recipeId: string, actor: ActorContext, ipAddress: string | null) {
    const existing = (await recipesRepository.findRecipeById(recipeId)) as RecipeRow | null;
    if (!existing) throw new RecipeError('RECIPE_NOT_FOUND', 'Recipe not found', 404);

    await recipesRepository.deleteRecipe(recipeId);

    await recordAuditLog({
      action: 'RECIPE_DELETED',
      entityType: 'recipe',
      entityId: recipeId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toRecipeResponse(existing),
      ipAddress,
    });
  },

  async simulateDeduction(input: {
    product_variant_id: string;
    flavor_id?: string | null;
    quantity_sold: number;
    branch_id?: string;
  }) {
    const lines = await computeDeduction({
      productVariantId: input.product_variant_id,
      flavorId: input.flavor_id ?? null,
      quantitySold: input.quantity_sold,
      branchId: input.branch_id,
    });
    return {
      product_variant_id: input.product_variant_id,
      flavor_id: input.flavor_id ?? null,
      branch_id: input.branch_id ?? null,
      quantity_sold: input.quantity_sold,
      lines,
    };
  },

  // --- CR-001 branch overrides (no approval; audit-logged) ---

  async listOverrides(productVariantId: string, branchId: string) {
    const rows = (await recipesRepository.findOverridesByVariantAndBranch(productVariantId, branchId)) as OverrideRow[];
    return rows.map(toOverrideResponse);
  },

  async createOverride(
    productVariantId: string,
    data: CreateOverrideInput,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const variant = await productsRepository.findVariantById(productVariantId);
    if (!variant) throw new RecipeError('VARIANT_NOT_FOUND', 'Product variant not found', 404);

    const created = (await recipesRepository.createOverride({
      branchId: data.branch_id,
      productVariantId,
      ingredientId: data.ingredient_id,
      flavorId: data.flavor_id ?? null,
      quantity: data.quantity,
      unit: data.unit,
      reason: data.reason,
      createdBy: actor.id,
    })) as OverrideRow;
    const response = toOverrideResponse(created);

    await recordAuditLog({
      action: 'BRANCH_RECIPE_OVERRIDE_CREATED',
      entityType: 'branch_recipe_override',
      entityId: created.id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: data.branch_id,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateOverride(overrideId: string, branchId: string, data: UpdateOverrideInput, actor: ActorContext, ipAddress: string | null) {
    const existing = (await recipesRepository.findOverrideById(overrideId)) as OverrideRow | null;
    if (!existing || existing.branchId !== branchId) {
      throw new RecipeError('RECIPE_OVERRIDE_NOT_FOUND', 'Branch recipe override not found', 404);
    }

    const updated = (await recipesRepository.updateOverride(overrideId, {
      quantity: data.quantity,
      unit: data.unit,
      reason: data.reason,
    })) as OverrideRow;
    const response = toOverrideResponse(updated);

    await recordAuditLog({
      action: 'BRANCH_RECIPE_OVERRIDE_UPDATED',
      entityType: 'branch_recipe_override',
      entityId: overrideId,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      beforeState: toOverrideResponse(existing),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteOverride(overrideId: string, branchId: string, actor: ActorContext, ipAddress: string | null) {
    const existing = (await recipesRepository.findOverrideById(overrideId)) as OverrideRow | null;
    if (!existing || existing.branchId !== branchId) {
      throw new RecipeError('RECIPE_OVERRIDE_NOT_FOUND', 'Branch recipe override not found', 404);
    }

    await recipesRepository.deleteOverride(overrideId);

    await recordAuditLog({
      action: 'BRANCH_RECIPE_OVERRIDE_DELETED',
      entityType: 'branch_recipe_override',
      entityId: overrideId,
      actorId: actor.id,
      actorRole: actor.role,
      branchId,
      beforeState: toOverrideResponse(existing),
      ipAddress,
    });
  },
};
