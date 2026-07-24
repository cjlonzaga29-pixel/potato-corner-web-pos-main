import { recipesRepository } from './recipes.repository.js';
import { RecipeError, type DeductionLine } from './recipes.types.js';
import { productsRepository } from '../products/products.repository.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };

interface RecipeRow {
  id: string;
  productVariantId: string;
  ingredientId: string;
  flavorId: string | null;
  quantity: { toNumber(): number };
  unit: string;
  ingredient: { name: string; branchId: string };
  flavor: { name: string } | null;
}

/** Master Recipe rows carry `version` (CR-004); BranchRecipeOverride rows don't. */
interface MasterRecipeRow extends RecipeRow {
  version: number;
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

/** CR-004: master recipe responses carry `version`; BranchRecipeOverride responses (toOverrideResponse below) don't. */
function toMasterRecipeResponse(row: MasterRecipeRow) {
  return { ...toRecipeResponse(row), version: row.version };
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
 * CR-004: a master Recipe row's ingredientId points at one specific branch's
 * Ingredient (Ingredient has no branch-neutral identity — see
 * docs/decisions/CR-004-pos-deduction-integrity.md). A sale at any *other*
 * branch must resolve that row to its own equivalent Ingredient (matched by
 * name — the same match findIngredientByBranchAndName and idempotent branch
 * provisioning both use), never deduct against the pinned branch's stock.
 * A no-op (zero extra queries) when the row's own ingredient already belongs
 * to the selling branch, which covers every single-branch deployment and
 * every recipe an admin happened to create against that branch's ingredient.
 */
async function resolveIngredientForBranch(branchId: string, row: RecipeRow): Promise<{ id: string; name: string }> {
  if (row.ingredient.branchId === branchId) {
    return { id: row.ingredientId, name: row.ingredient.name };
  }
  const resolved = await inventoryRepository.findIngredientByBranchAndName(branchId, row.ingredient.name);
  if (!resolved) {
    throw new RecipeError(
      'INGREDIENT_NOT_PROVISIONED',
      `Ingredient "${row.ingredient.name}" has not been provisioned at this branch yet — add it under branch inventory before selling this item here`,
      409,
    );
  }
  return { id: resolved.id, name: resolved.name };
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
 *
 * When branchId is given, master rows are resolved to that branch's own
 * Ingredient first (CR-004, resolveIngredientForBranch) — branch override
 * rows are exempt since a branch account can only ever create an override
 * against its own branch's ingredients in the first place.
 */
export async function computeDeduction(input: ComputeDeductionInput): Promise<DeductionLine[]> {
  const masterRows = (await recipesRepository.findMasterRows(input.productVariantId, input.flavorId)) as RecipeRow[];
  const masterBase = masterRows.filter((r) => r.flavorId === null);
  const masterFlavor = masterRows.filter((r) => r.flavorId !== null);

  const map = new Map<string, DeductionLine>();
  for (const row of masterBase) {
    const ingredient = input.branchId ? await resolveIngredientForBranch(input.branchId, row) : { id: row.ingredientId, name: row.ingredient.name };
    map.set(ingredient.id, {
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      quantity: row.quantity.toNumber(),
      unit: row.unit,
      source: 'master_base',
    });
  }
  for (const row of masterFlavor) {
    const ingredient = input.branchId ? await resolveIngredientForBranch(input.branchId, row) : { id: row.ingredientId, name: row.ingredient.name };
    map.set(ingredient.id, {
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
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

/**
 * CR-004: transactions.service.ts calls this before pricing a cart line —
 * a sale must never be recorded for a variant with zero master recipe rows,
 * since computeDeduction would silently return an empty deduction list
 * (i.e. "sell it for free, deduct nothing") rather than signal that no one
 * has configured the recipe yet.
 */
export async function assertRecipeExists(productVariantId: string): Promise<void> {
  const exists = await recipesRepository.hasActiveRecipeForVariant(productVariantId);
  if (!exists) {
    throw new RecipeError(
      'RECIPE_MISSING',
      'This product variant has no recipe configured — a sale cannot be recorded until Super Admin adds one',
      422,
    );
  }
}

/** CR-004: the master recipe version snapshotted onto TransactionItem.recipeVersion at sale time. */
export function getRecipeVersion(productVariantId: string, flavorId: string | null): Promise<number> {
  return recipesRepository.getMaxVersionForSelection(productVariantId, flavorId);
}

/** CR-004: the ingredient identities branchesService.createBranch provisions a new branch with. */
export function listDistinctIngredientIdentities(): Promise<{ name: string; unit: string }[]> {
  return recipesRepository.findDistinctIngredientIdentities();
}

export const recipesService = {
  async listRecipes(productVariantId: string) {
    const rows = (await recipesRepository.findByVariant(productVariantId)) as MasterRecipeRow[];
    return rows.map(toMasterRecipeResponse);
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
    })) as MasterRecipeRow;
    const response = toMasterRecipeResponse(created);

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
    const existing = (await recipesRepository.findRecipeById(recipeId)) as MasterRecipeRow | null;
    if (!existing) throw new RecipeError('RECIPE_NOT_FOUND', 'Recipe not found', 404);

    const updated = (await recipesRepository.updateRecipe(recipeId, data)) as MasterRecipeRow;
    const response = toMasterRecipeResponse(updated);

    await recordAuditLog({
      action: 'RECIPE_UPDATED',
      entityType: 'recipe',
      entityId: recipeId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toMasterRecipeResponse(existing),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteRecipe(recipeId: string, actor: ActorContext, ipAddress: string | null) {
    const existing = (await recipesRepository.findRecipeById(recipeId)) as MasterRecipeRow | null;
    if (!existing) throw new RecipeError('RECIPE_NOT_FOUND', 'Recipe not found', 404);

    await recipesRepository.deleteRecipe(recipeId);

    await recordAuditLog({
      action: 'RECIPE_DELETED',
      entityType: 'recipe',
      entityId: recipeId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toMasterRecipeResponse(existing),
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

    // CR-004: a branch override must reference an Ingredient owned by that
    // same branch — otherwise it would silently deduct another branch's
    // stock the same way an unresolved master recipe used to (see
    // computeDeduction/resolveIngredientForBranch above).
    const ingredient = await inventoryRepository.findIngredientById(data.ingredient_id);
    if (!ingredient || ingredient.branchId !== data.branch_id) {
      throw new RecipeError('INGREDIENT_NOT_IN_BRANCH', 'ingredient_id must belong to the same branch as branch_id', 422);
    }

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
