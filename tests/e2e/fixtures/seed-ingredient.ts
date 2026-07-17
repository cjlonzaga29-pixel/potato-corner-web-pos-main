import type { APIRequestContext } from '@playwright/test';
import { TEST_USERS } from './test-users';
import { apiLogin, authedPost } from './api-helpers';

export const INGREDIENT_FIXTURE = {
  name: 'E2E Test Flour',
  unit: 'kg',
};

/**
 * apps/web/app/(supervisor)/supervisor/inventory/page.tsx: "Ingredients are
 * created by an admin" — POST /api/inventory/ingredients is adminOnly
 * (inventory.router.ts), no supervisor-facing creation UI exists. Created
 * here the same way a real admin would, through the real API.
 */
export async function seedIngredient(request: APIRequestContext, baseURL: string, branchId: string): Promise<{ ingredientId: string }> {
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);

  const result = await authedPost<{ id: string }>(request, baseURL, '/api/inventory/ingredients', admin.accessToken, {
    branch_id: branchId,
    name: INGREDIENT_FIXTURE.name,
    unit: INGREDIENT_FIXTURE.unit,
    current_stock: 0,
    low_stock_threshold: 5,
    critical_threshold: 2,
  });

  if (!result.data?.id) {
    throw new Error(`Failed to seed ingredient (${result.status}): ${JSON.stringify(result.error)}`);
  }
  return { ingredientId: result.data.id };
}
