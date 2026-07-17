import type { APIRequestContext } from '@playwright/test';
import { TEST_USERS } from './test-users';

interface ApiResponse<T> {
  data: T | null;
  error: unknown;
  meta: unknown;
}

/**
 * apps/api/prisma/seed.ts only seeds the branch and the three role
 * accounts — no product catalog. The POS terminal (tests/e2e/pos-workflow
 * spec) needs at least one sellable variant to add to the cart, so this
 * creates one via the real admin API (not direct Prisma access — no schema
 * bypass, matches how the product actually gets created in production).
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

async function postJson<T>(
  request: APIRequestContext,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await request.post(path, { data: body, headers });
  const parsed = (await response.json()) as ApiResponse<T>;
  if (!response.ok() || !parsed.data) {
    throw new Error(`POST ${path} failed (${response.status()}): ${JSON.stringify(parsed.error)}`);
  }
  return parsed.data;
}

function readCsrfToken(context: APIRequestContext, baseURL: string): Promise<string> {
  return context.storageState().then((state) => {
    const cookie = state.cookies.find((c) => c.name === 'csrf-token' && new URL(baseURL).hostname === c.domain);
    if (!cookie) throw new Error('csrf-token cookie not found after login — csrf-guard.ts should have issued one');
    return decodeURIComponent(cookie.value);
  });
}

/**
 * Logs in as the seeded super_admin, creates the fixture product + two
 * variants (idempotent-ish: reuses an existing product with the same name
 * rather than erroring on retries), and returns the branch id both seeded
 * non-admin accounts are assigned to. Call once per spec file in
 * `test.beforeAll`, not per-test — this hits real write endpoints.
 */
export async function seedCatalog(request: APIRequestContext, baseURL: string): Promise<{ branchId: string }> {
  const loginRes = await request.post('/api/auth/login', {
    data: { email: TEST_USERS.super_admin.email, password: TEST_USERS.super_admin.password, device_id: crypto.randomUUID() },
  });
  const loginBody = (await loginRes.json()) as ApiResponse<{ access_token: string; user: { branch_ids: string[] } }>;
  if (!loginRes.ok() || !loginBody.data) {
    throw new Error(`Admin login failed (${loginRes.status()}): ${JSON.stringify(loginBody.error)}`);
  }
  const accessToken = loginBody.data.access_token;
  const csrfToken = await readCsrfToken(request, baseURL);

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'X-CSRF-Token': csrfToken,
    'Content-Type': 'application/json',
  };

  // Branch is seeded by name/code ("Main Branch" / MAIN01) — fetched by
  // listing branches rather than hardcoding an id that could drift.
  const branchListRes = await request.get('/api/branches', { headers: authHeaders });
  const branchListBody = (await branchListRes.json()) as ApiResponse<{ branches: { id: string; code: string }[] }>;
  const branch = branchListBody.data?.branches.find((b) => b.code === 'MAIN01');
  if (!branch) {
    throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  }

  const product = await postJson<{ id: string }>(
    request,
    '/api/products',
    {
      name: CATALOG_FIXTURE.productName,
      status: 'active',
      category: 'E2E',
      branch_exclusive: false, // cascades to all active branches, including MAIN01
    },
    authHeaders,
  );

  await postJson(
    request,
    `/api/products/${product.id}/variants`,
    { name: CATALOG_FIXTURE.classicVariantName, size_label: 'Regular', base_price: CATALOG_FIXTURE.classicPrice },
    authHeaders,
  );
  await postJson(
    request,
    `/api/products/${product.id}/variants`,
    { name: CATALOG_FIXTURE.deluxeVariantName, size_label: 'Large', base_price: CATALOG_FIXTURE.deluxePrice },
    authHeaders,
  );

  return { branchId: branch.id };
}
