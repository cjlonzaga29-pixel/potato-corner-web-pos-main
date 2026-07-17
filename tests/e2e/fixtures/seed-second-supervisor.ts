import type { APIRequestContext } from '@playwright/test';
import { TEST_USERS } from './test-users';
import { apiLogin, authedPost } from './api-helpers';

export const SECOND_SUPERVISOR = {
  email: 'e2e-supervisor-2@potatocorner.test',
  password: 'E2eSupervisor2Pass',
};

/**
 * The seeded fixtures only include one supervisor (Marco Reyes,
 * apps/api/prisma/seed.ts), which is enough for most flows but not for
 * cashier-handover detection (cash.service.ts closeShift: a supervisor who
 * did not open the shift, and isn't super_admin, gets SHIFT_UNAUTHORIZED_
 * CLOSE) — that needs a second supervisor account assigned to the same
 * branch. Created via the real admin API, idempotent against re-runs via
 * employees.router.ts's EMAIL_ALREADY_EXISTS check (swallowed here).
 */
export async function seedSecondSupervisor(request: APIRequestContext, baseURL: string, branchId: string): Promise<void> {
  const { accessToken } = await apiLogin(request, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);

  const result = await authedPost(request, baseURL, '/api/employees', accessToken, {
    email: SECOND_SUPERVISOR.email,
    first_name: 'Second',
    last_name: 'Supervisor',
    role: 'supervisor',
    employment_type: 'regular',
    branch_ids: [branchId],
    initial_password: SECOND_SUPERVISOR.password,
  });

  if (result.status !== 201 && result.status !== 409) {
    throw new Error(`Failed to seed second supervisor (${result.status}): ${JSON.stringify(result.error)}`);
  }
}
