// AUTHORED, NOT EXECUTED: k6 is not installed in the environment this was
// written in, and there is no local Postgres/Redis/running API to point it
// at anyway (see phase-19-debt.md). Never actually run.
//
// Run: k6 run --env BASE_URL=https://staging.example.com tests/load/scenarios/transaction-create.js
// (BASE_URL must point at a non-production environment — never load-test
// prod, and never point this at the real Supabase project used by CI.)
//
// Covers master-execution-plan.md's Monitoring section transaction-endpoint
// threshold (500ms) directly. There is no separate "inventory deduction"
// endpoint to load-test on its own — transactions.service.ts's
// createTransaction enqueues deduction onto BullMQ asynchronously
// (queues/inventory.queue.ts, best-effort, failure doesn't block the
// transaction response) rather than exposing a synchronous HTTP endpoint,
// so this script exercises that pipeline indirectly by generating real
// transaction volume, not as a separate scenario.
//
// IMPORTANT CONSTRAINT, not a script bug: apps/api/src/middleware/rate-
// limiter.ts's apiLimiter caps authenticated requests at 100/min PER USER
// (keyed by user_id, not IP). Running many VUs against the one seeded staff
// account would measure that per-user rate limiter, not the transaction
// endpoint. setup() below creates one throwaway staff account per VU
// through the real admin API (same pattern as tests/e2e/fixtures/
// seed-second-supervisor.ts) specifically so each VU has its own 100/min
// budget — this is a real design requirement for this test to mean
// anything, not incidental setup.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { login, authedHeaders } from '../lib/auth.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'admin@potatocorner.test';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'SuperAdmin123';
const SUPERVISOR_EMAIL = __ENV.SUPERVISOR_EMAIL || 'supervisor@potatocorner.test';
const SUPERVISOR_PASSWORD = __ENV.SUPERVISOR_PASSWORD || 'Supervisor123';
const VU_COUNT = Number(__ENV.VUS || 10);
const PRODUCT_PRICE = 25.0;

export const options = {
  vus: VU_COUNT,
  duration: __ENV.DURATION || '30s',
  thresholds: {
    // master-execution-plan.md's Monitoring section: 500ms transaction-endpoint threshold.
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const admin = login(BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  const supervisor = login(BASE_URL, SUPERVISOR_EMAIL, SUPERVISOR_PASSWORD);

  const branchesRes = http.get(`${BASE_URL}/api/branches`, { headers: authedHeaders(admin) });
  const branch = branchesRes.json('data.branches').find((b) => b.code === 'MAIN01');
  if (!branch) throw new Error('Seeded "Main Branch" (MAIN01) not found — run apps/api/prisma/seed.ts against this environment first');

  // Direct POST /api/products was removed in the Super Admin IA restructure
  // — a product now only comes from a supervisor's product request approved
  // by an admin, so setup goes through that same real flow.
  const requestRes = http.post(
    `${BASE_URL}/api/product-requests`,
    JSON.stringify({
      branch_id: branch.id,
      proposed_name: 'k6 Load Test Item',
      proposed_category: 'Load Test',
      proposed_variants: [{ name: 'Standard', size_label: 'Regular', base_price: PRODUCT_PRICE }],
      request_reason: 'k6 load-test setup — seeds the product this scenario adds to every transaction.',
    }),
    { headers: authedHeaders(supervisor) },
  );
  const requestId = requestRes.json('data.id');
  if (!requestId) throw new Error(`Failed to submit k6 product request: ${requestRes.status} ${requestRes.body}`);

  const reviewRes = http.post(
    `${BASE_URL}/api/product-requests/${requestId}/review`,
    JSON.stringify({ action: 'approve' }),
    { headers: authedHeaders(admin) },
  );
  const productId = reviewRes.json('data.created_product_id');
  if (!productId) throw new Error(`Failed to approve k6 product request: ${reviewRes.status} ${reviewRes.body}`);

  const productDetailRes = http.get(`${BASE_URL}/api/products/${productId}`, { headers: authedHeaders(admin) });
  const variantId = productDetailRes.json('data.variants').find((v) => v.name === 'Standard').id;

  // One throwaway staff account per VU — see file header for why this
  // isn't optional. 409 (already exists) is tolerated for idempotent re-runs.
  // Employee creation is supervisorOnly (Super Admin IA restructure moved
  // employee management fully to Supervisor), so this uses the supervisor
  // session, not admin.
  const staffAccounts = [];
  for (let i = 0; i < VU_COUNT; i++) {
    const email = `k6-staff-${i}@potatocorner.test`;
    const password = `K6LoadStaff${i}Pass`;
    const createRes = http.post(
      `${BASE_URL}/api/employees`,
      JSON.stringify({
        email,
        first_name: 'K6',
        last_name: `Staff${i}`,
        role: 'staff',
        employment_type: 'regular',
        branch_ids: [branch.id],
        initial_password: password,
      }),
      { headers: authedHeaders(supervisor) },
    );
    if (createRes.status !== 201 && createRes.status !== 409) {
      throw new Error(`Failed to seed k6 staff account ${email}: ${createRes.status} ${createRes.body}`);
    }
    staffAccounts.push({ email, password });
  }

  const shiftRes = http.post(
    `${BASE_URL}/api/cash/open`,
    JSON.stringify({
      branch_id: branch.id,
      cashier_id: supervisor.userId,
      starting_cash: 100000, // large opening float — this run may generate a lot of cash transactions
      denominations: [{ denomination: 1000, quantity: 100 }],
    }),
    { headers: authedHeaders(supervisor) },
  );
  const shiftId = shiftRes.json('data.id');
  if (!shiftId) throw new Error(`Failed to open load-test shift: ${shiftRes.status} ${shiftRes.body}`);

  return { branchId: branch.id, variantId, shiftId, staffAccounts };
}

export default function (data) {
  const account = data.staffAccounts[__VU % data.staffAccounts.length];
  const session = login(BASE_URL, account.email, account.password);

  const res = http.post(
    `${BASE_URL}/api/transactions`,
    JSON.stringify({
      branch_id: data.branchId,
      shift_id: data.shiftId,
      items: [{ product_variant_id: data.variantId, quantity: 1 }],
      payment_method: 'cash',
      cash_tendered: PRODUCT_PRICE,
      is_offline_transaction: false,
    }),
    { headers: authedHeaders(session) },
  );

  check(res, {
    'transaction created (201)': (r) => r.status === 201,
    'total_amount matches product price': (r) => r.json('data.total_amount') === PRODUCT_PRICE,
  });

  sleep(1);
}

// Deliberately no teardown() that closes the shift or deletes the k6-staff-*
// accounts — a load-test environment's data isn't expected to stay clean
// between runs the way the E2E fixtures' shared dev/CI database is. Whoever
// owns the load-test environment should decide the reset strategy (fresh
// DB per run vs. a cleanup script) rather than this script silently picking
// one.
