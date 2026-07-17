// AUTHORED, NOT EXECUTED: no local Postgres/Redis instance is available in
// the environment this was written in (see phase-19-debt.md) — never run
// against a live app.
//
// New file — "void + approval" is named in master-execution-plan.md's
// Testing Strategy. Reading transactions.service.ts's voidTransaction found
// no separate approval/pending state: voiding is immediate, gated only by
// adminOrSupervisor at the router level (transactions.router.ts), and
// treated as a fraud signal downstream (Phase 17) rather than something
// requiring a second sign-off step. "Approval" here means "only a
// privileged role may do this," not a two-phase workflow — this spec tests
// exactly that RBAC boundary plus the void itself.
//
// API-only: grepped the whole frontend for a void-transaction UI
// (useVoidTransaction is defined in hooks/queries/use-transactions.ts but
// is imported by zero pages — dead code, same shape as the dormant
// notification producers in phase-19-debt.md) and found none.
import { test, expect } from '@playwright/test';
import { TEST_USERS } from './fixtures/test-users';
import { apiLogin, authedGet, authedPost } from './fixtures/api-helpers';

const VOID_PRODUCT = { name: 'E2E Void Item', variantName: 'Standard', price: 30.0 };

let branchId: string;
let shiftId: string;

test.beforeAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);

  const branches = await authedGet<{ branches: { id: string; code: string }[] }>(request, '/api/branches', admin.accessToken);
  const branch = branches.data?.branches.find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts first');
  branchId = branch.id;

  const product = await authedPost<{ id: string }>(request, url, '/api/products', admin.accessToken, {
    name: VOID_PRODUCT.name,
    status: 'active',
    category: 'E2E',
    branch_exclusive: false,
  });
  if (!product.data?.id) throw new Error(`Failed to create void test product: ${JSON.stringify(product.error)}`);
  const variant = await authedPost<{ id: string }>(request, url, `/api/products/${product.data.id}/variants`, admin.accessToken, {
    name: VOID_PRODUCT.variantName,
    size_label: 'Regular',
    base_price: VOID_PRODUCT.price,
  });
  if (!variant.data?.id) throw new Error(`Failed to create void test variant: ${JSON.stringify(variant.error)}`);

  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
  const shift = await authedPost<{ id: string }>(request, url, '/api/cash/open', supervisor.accessToken, {
    branch_id: branchId,
    cashier_id: supervisor.userId,
    starting_cash: 200,
    denominations: [{ denomination: 200, quantity: 1 }],
  });
  if (!shift.data?.id) throw new Error(`Failed to open shift for void test: ${JSON.stringify(shift.error)}`);
  shiftId = shift.data.id;
});

test.afterAll(async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
  await authedPost(request, url, `/api/cash/${shiftId}/close`, supervisor.accessToken, {
    denominations: [{ denomination: 200, quantity: 1 }],
  });
});

test('staff cannot void a transaction — only supervisor/super_admin may', async ({ request, baseURL }) => {
  const url = baseURL ?? 'http://localhost:3000';
  const admin = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
  const products = await authedGet<{ products: { id: string; name: string }[] }>(request, '/api/products', admin.accessToken);
  const product = products.data?.products.find((p) => p.name === VOID_PRODUCT.name);
  if (!product) throw new Error('Void test product not found — beforeAll should have created it');
  const detail = await authedGet<{ variants: { id: string; name: string }[] }>(request, `/api/products/${product.id}`, admin.accessToken);
  const variant = detail.data?.variants.find((v) => v.name === VOID_PRODUCT.variantName);
  if (!variant) throw new Error('Void test variant not found — beforeAll should have created it');

  const staff = await apiLogin(request, TEST_USERS.staff.email, TEST_USERS.staff.password);
  const created = await authedPost<{ id: string }>(request, url, '/api/transactions', staff.accessToken, {
    branch_id: branchId,
    shift_id: shiftId,
    items: [{ product_variant_id: variant.id, quantity: 1 }],
    payment_method: 'cash',
    cash_tendered: VOID_PRODUCT.price,
    is_offline_transaction: false,
  });
  const transactionId = created.data?.id;
  if (!transactionId) throw new Error(`Failed to create test transaction: ${JSON.stringify(created.error)}`);

  const staffVoidAttempt = await authedPost(request, url, `/api/transactions/${transactionId}/void`, staff.accessToken, {
    void_reason: 'E2E: staff should not be able to do this.',
  });
  expect(staffVoidAttempt.status).toBe(403);
  expect(staffVoidAttempt.error).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });

  const supervisor = await apiLogin(request, TEST_USERS.supervisor.email, TEST_USERS.supervisor.password);
  const supervisorVoid = await authedPost<{ status: string; void_reason: string }>(
    request,
    url,
    `/api/transactions/${transactionId}/void`,
    supervisor.accessToken,
    { void_reason: 'E2E: supervisor void — inventory deduction is deliberately not reversed per transactions.service.ts.' },
  );
  expect(supervisorVoid.status).toBe(200);
  expect(supervisorVoid.data?.status).toBe('voided');

  const secondVoidAttempt = await authedPost(request, url, `/api/transactions/${transactionId}/void`, supervisor.accessToken, {
    void_reason: 'E2E: voiding an already-voided transaction should fail.',
  });
  expect(secondVoidAttempt.status).toBe(409);
  expect(secondVoidAttempt.error).toMatchObject({ code: 'TRANSACTION_ALREADY_VOIDED' });
});
