// AUTHORED, NOT EXECUTED: k6 is not installed in the environment this was
// written in, and there is no local Postgres/Redis/running API to point it
// at anyway (see phase-19-debt.md). Never actually run.
//
// Run: k6 run --env BASE_URL=https://staging.example.com tests/load/scenarios/auth-login.js
// (BASE_URL must point at a non-production environment — never load-test prod.)
//
// IMPORTANT CONSTRAINT, not a script bug: apps/api/src/middleware/rate-
// limiter.ts's loginLimiter caps POST /api/auth/login at 10 requests per
// 15 minutes PER IP. A k6 run from a single machine is a single IP, so any
// VU/duration combination that adds up to more than 10 login attempts in a
// 15-minute window will start getting 429s from the rate limiter itself,
// not from login logic under load — that would measure the rate limiter,
// not the login endpoint. This script is deliberately sized to stay under
// that budget (5 VUs x 1 iteration = 5 requests) to get one clean latency
// reading. Testing login behavior at real scale would require either a
// distributed-IP k6 run (cloud execution) or a load-test-specific
// environment with loginLimiter's limit raised — that's an infrastructure
// decision for whoever owns the load-test environment, not something to
// fake around in the script.
import { check, sleep } from 'k6';
import { login } from '../lib/auth.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const EMAIL = __ENV.LOGIN_EMAIL || 'staff@potatocorner.test';
const PASSWORD = __ENV.LOGIN_PASSWORD || 'Staff123';

export const options = {
  vus: 5,
  iterations: 5,
  thresholds: {
    // master-execution-plan.md's Monitoring section: 2s general API threshold.
    http_req_duration: ['p(95)<2000'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const session = login(BASE_URL, EMAIL, PASSWORD);
  check(session, { 'received an access token': (s) => Boolean(s.accessToken) });
  sleep(1);
}
