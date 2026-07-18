/**
 * Phase 20 Task 11 — pilot load smoke test.
 *
 * Purpose: prove the Render backend can handle realistic pilot traffic
 * (20 concurrent users, 3 minutes sustained) without breaking the pilot
 * SLOs, before the pilot go-live cutover. Read-only endpoints only — no
 * order creation, payment, shift open, or any other write operation.
 *
 * Design note: production enforces POST /api/auth/login at 10 req/15min
 * per IP, and a global 100 req/min limiter keyed by user_id once
 * authenticated. Running 20 fresh logins per iteration from one shared
 * account/IP would trip those anti-abuse controls and produce a false
 * BLOCKER verdict that reflects rate limiting, not real capacity. To
 * avoid that:
 *   - Each VU logs in exactly once (cached in module scope, which is
 *     per-VU in k6) and reuses that session for the whole run.
 *   - VUs alternate across two role-appropriate accounts (K6_TEST_EMAIL /
 *     K6_TEST_PASSWORD and the optional _2 pair) to spread both the
 *     login-per-IP budget and the per-user_id API budget. If only the
 *     first pair is supplied, every VU falls back to it.
 * This means login-path capacity at full 20-concurrent is NOT what this
 * test validates — only steady-state authenticated-read and token-refresh
 * capacity is. See the Task 11 report for the login-path caveat.
 *
 * How to run:
 *   $env:K6_TEST_EMAIL = "<supervisor-or-admin pilot email>"
 *   $env:K6_TEST_PASSWORD = "<pilot password>"
 *   # optional second account to spread rate-limit load:
 *   $env:K6_TEST_EMAIL_2 = "<second supervisor-or-admin pilot email>"
 *   $env:K6_TEST_PASSWORD_2 = "<second pilot password>"
 *   k6 run tests/load/pilot-smoke.k6.js
 *
 *   Dry run: k6 run --vus 1 --duration 10s tests/load/pilot-smoke.k6.js
 *
 * How to interpret results:
 *   - http_req_duration{endpoint:login} is the public-endpoint SLO (p95 < 400ms).
 *   - http_req_duration{endpoint:branches|products|catalog|refresh} are the
 *     authenticated-read SLO (p95 < 800ms).
 *   - http_req_failed and checks must stay under 1% failed / over 99% passed.
 *   - A 429 rate concentrated on the login endpoint or in the first ~30s
 *     is expected rate-limiter behavior, not a capacity finding — see the
 *     design note above.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.PLAYWRIGHT_BASE_URL || 'https://potatorenovare.com';

const PRIMARY_EMAIL = __ENV.K6_TEST_EMAIL;
const PRIMARY_PASSWORD = __ENV.K6_TEST_PASSWORD;
const SECONDARY_EMAIL = __ENV.K6_TEST_EMAIL_2 || PRIMARY_EMAIL;
const SECONDARY_PASSWORD = __ENV.K6_TEST_PASSWORD_2 || PRIMARY_PASSWORD;

if (!PRIMARY_EMAIL || !PRIMARY_PASSWORD) {
  throw new Error(
    'K6_TEST_EMAIL and K6_TEST_PASSWORD env vars are required (supervisor or admin pilot account — staff role cannot read /api/branches or /api/products). Aborting before making any requests.',
  );
}

export const options = {
  // k6 resets the cookie jar at the start of every iteration by default.
  // Each VU's session here relies on the refresh_token HttpOnly cookie set
  // by /api/auth/login surviving into later iterations (only the access
  // token is cached in module scope) — without this, every refresh call
  // after a VU's first iteration fails with REFRESH_MISSING regardless of
  // backend capacity.
  noCookiesReset: true,
  stages: [
    { duration: '30s', target: 5 },
    { duration: '30s', target: 20 },
    { duration: '3m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<800'],
    'http_req_duration{endpoint:login}': ['p(95)<400'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Module-level state is isolated per-VU in k6, so this persists across
// iterations of the same VU without leaking between VUs.
let session = null;

function login() {
  const useSecondary = __VU % 2 === 0;
  const email = useSecondary ? SECONDARY_EMAIL : PRIMARY_EMAIL;
  const password = useSecondary ? SECONDARY_PASSWORD : PRIMARY_PASSWORD;
  const deviceId = uuidv4();

  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email, password, device_id: deviceId }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'login' } },
  );

  const ok = check(res, {
    'login: status 200': (r) => r.status === 200,
    'login: has access_token': (r) => {
      try {
        return !!r.json('data.access_token');
      } catch (e) {
        return false;
      }
    },
  });

  if (!ok) {
    return null;
  }

  return { accessToken: res.json('data.access_token'), deviceId };
}

function authHeaders() {
  return { headers: { Authorization: `Bearer ${session.accessToken}` } };
}

export default function () {
  if (!session) {
    session = login();
    if (!session) {
      // Login failed (e.g. rate limited) — don't crash the VU, back off and retry next iteration.
      sleep(5);
      return;
    }
  }

  let branchId = null;

  const branchesRes = http.get(`${BASE_URL}/api/branches`, {
    ...authHeaders(),
    tags: { endpoint: 'branches' },
  });
  check(branchesRes, { 'branches: status 200': (r) => r.status === 200 });
  if (branchesRes.status === 200) {
    try {
      const branches = branchesRes.json('data.branches');
      if (Array.isArray(branches) && branches.length > 0) {
        branchId = branches[0].id;
      }
    } catch (e) {
      // leave branchId null; catalog call below is skipped
    }
  }
  sleep(1 + Math.random());

  const productsRes = http.get(`${BASE_URL}/api/products`, {
    ...authHeaders(),
    tags: { endpoint: 'products' },
  });
  check(productsRes, { 'products: status 200': (r) => r.status === 200 });
  sleep(1 + Math.random());

  // No /api/products/categories endpoint exists in this codebase; the
  // equivalent read for pilot browsing is the POS catalog view, scoped
  // to a branch obtained from the /api/branches call above.
  if (branchId) {
    const catalogRes = http.get(`${BASE_URL}/api/products/catalog?branch_id=${branchId}`, {
      ...authHeaders(),
      tags: { endpoint: 'catalog' },
    });
    check(catalogRes, { 'catalog: status 200': (r) => r.status === 200 });
  }

  const refreshRes = http.post(
    `${BASE_URL}/api/auth/refresh`,
    JSON.stringify({ device_id: session.deviceId }),
    { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'refresh' } },
  );
  const refreshOk = check(refreshRes, { 'refresh: status 200': (r) => r.status === 200 });
  if (refreshOk) {
    try {
      session.accessToken = refreshRes.json('data.access_token');
    } catch (e) {
      // keep old token; next authenticated call will fail and surface as a check failure
    }
  }
  sleep(2 + Math.random());
}
