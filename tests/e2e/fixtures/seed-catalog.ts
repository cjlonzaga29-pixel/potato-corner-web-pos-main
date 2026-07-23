import type { APIRequestContext } from '@playwright/test';
import { TEST_USERS } from './test-users';
import { apiLogin, authedGet, createProductViaRequest } from './api-helpers';

/**
 * apps/api/prisma/seed.ts only seeds the branch and the three role
 * accounts — no product catalog. The POS terminal (tests/e2e/pos-workflow
 * spec) needs at least one sellable variant to add to the cart, so this
 * creates one via the real supervisor product-request + admin-approval
 * flow (not direct Prisma access, and not a direct POST /api/products —
 * that endpoint was removed in the Super Admin IA restructure, so this is
 * now the one true path a product takes in production too).
 *
 * Two variants, both whole-peso prices, chosen so the resulting totals stay
 * whole numbers and are easy to assert against by hand:
 * - "Classic" ₱56.00 — used for the plain cash-payment flow.
 * - "Deluxe" ₱112.00 — used for the PWD/Senior discount + VAT flow, chosen
 *   so vatable base (112 / 1.12 = 100.00) lands on a clean number too.
 * Both variants are added with zero flavors so the terminal adds them to
 * the cart on a single tap, no flavor-picker modal in the way.
 */
export const CATALOG_FIXTURE = {
  productName: 'E2E Test Item',
  classicVariantName: 'Classic',
  classicPrice: 56.0,
  deluxeVariantName: 'Deluxe',
  deluxePrice: 112.0,
};

/**
 * Logs in as the seeded admin + supervisor, creates the fixture product +
 * two variants via a product request approved on the spot, and returns the
 * branch id both seeded non-admin accounts are assigned to. Call once per
 * spec file in `test.beforeAll`, not per-test — this hits real write
 * endpoints.
 */
export async function seedCatalog(request: APIRequestContext, baseURL: string): Promise<{ branchId: string }> {
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);

  // Branch is seeded by name/code ("Main Branch" / MAIN01) — fetched by
  // listing branches rather than hardcoding an id that could drift.
  const branchList = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', admin.accessToken);
  const branch = branchList.data?.branches.find((b) => b.code === 'MAIN01');
  if (!branch) {
    throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  }

  await createProductViaRequest(request, baseURL, {
    branchId: branch.id,
    supervisorAccessToken: supervisor.accessToken,
    adminAccessToken: admin.accessToken,
    proposedName: CATALOG_FIXTURE.productName,
    variants: [
      { name: CATALOG_FIXTURE.classicVariantName, size_label: 'Regular', base_price: CATALOG_FIXTURE.classicPrice },
      { name: CATALOG_FIXTURE.deluxeVariantName, size_label: 'Large', base_price: CATALOG_FIXTURE.deluxePrice },
    ],
  });

  return { branchId: branch.id };
}
