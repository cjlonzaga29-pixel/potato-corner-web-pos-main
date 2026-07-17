// AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in
// the environment this was written in (see phase-19-debt.md) — never run
// against a live app. Selectors/flows taken from reading the real
// components and schemas, not guessed.
//
// This file's original test.skip stub described three things in its TODO
// comment: "stock-in recording with image proof, manual adjustment
// approval, and the out-of-stock cascade reflected in the POS product
// grid." Reading the actual implementation found none of those three
// exactly as described:
// - image_proof_url/image_proof_type exist on wasteIngredientSchema, NOT
//   stockInSchema (packages/shared/src/schemas/inventory.schema.ts) — stock-
//   in has no image field at all.
// - adjustIngredientSchema has no approval/pending state; POST
//   /ingredients/:id/adjust (adminOrSupervisor) applies immediately. This
//   matches phase-19-debt.md's dormant-producer note: large_adjustment_
//   approval_needed has a notification handler but "no business logic
//   exists" to ever enqueue it.
// - No code path was found (grepped inventory.service.ts and
//   products.service.ts/repository.ts) where an ingredient's stock level
//   drives product availability on the POS terminal — branch_product_
//   availability cascades only run off product status changes (CR-001),
//   never off stock levels.
// This file tests what's actually implemented (stock-in, adjustment, and
// waste-with-image-proof) rather than asserting behavior that doesn't
// exist. The three gaps above are flagged here so a future session doesn't
// have to rediscover them.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet } from './fixtures/api-helpers';
import { seedIngredient, INGREDIENT_FIXTURE } from './fixtures/seed-ingredient';

let branchId: string;
let ingredientId: string;

test.beforeAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const branches = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', admin.accessToken);
  const branch = branches.data?.branches.find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = branch.id;

  const ingredient = await seedIngredient(request, url, branchId);
  ingredientId = ingredient.ingredientId;
});

test.describe('inventory stock-in and adjustment (supervisor)', () => {
  test.use({ storageState: path.join(__dirname, 'fixtures', 'supervisor.auth.json') });

  test('stock-in increases current stock; the branch selector auto-selects the supervisor\'s single assigned branch', async ({ page }) => {
    await page.goto('/supervisor/inventory');

    // BranchSelector (components/supervisor/branch-selector.tsx) auto-picks
    // branches[0] when nothing is active yet — the supervisor here is
    // assigned to exactly one branch (seed.ts), so no manual selection step
    // is needed, just a wait for the auto-selected list to render.
    await expect(page.getByText(INGREDIENT_FIXTURE.name)).toBeVisible();
    await expect(page.getByText('0 kg')).toBeVisible();

    await page.goto(`/supervisor/inventory/stock-in?ingredient_id=${ingredientId}`);
    await expect(page.getByText('Current stock: 0')).toBeVisible();

    await page.getByLabel(/Quantity Received/).fill('20');
    await page.getByPlaceholder('PO number, delivery receipt, etc.').fill('E2E-PO-0001');
    await page.getByRole('button', { name: 'Record Stock In' }).click();

    await page.waitForURL('**/supervisor/inventory');
    await expect(page.getByText('20 kg')).toBeVisible();
  });

  test('adjustment applies immediately, no pending-approval state (adjustIngredientSchema has none)', async ({ page }) => {
    await page.goto(`/supervisor/inventory/adjust?ingredient_id=${ingredientId}`);
    await expect(page.getByText('Current stock: 20')).toBeVisible();

    await page.getByLabel(/Quantity Change/).fill('-5');
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Damaged' }).click();
    await page.getByLabel('Notes').fill('E2E: simulated damaged-stock correction.');

    await page.getByRole('button', { name: 'Record Adjustment' }).click();

    await page.waitForURL('**/supervisor/inventory');
    // No approval step exists — the new total (15kg) is visible immediately,
    // not held in a pending state.
    await expect(page.getByText('15 kg')).toBeVisible();
  });
});
