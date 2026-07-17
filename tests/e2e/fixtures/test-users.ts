/**
 * Matches apps/api/prisma/seed.ts exactly — these are the only accounts
 * guaranteed to exist against a freshly seeded database. super_admin has no
 * branch assignment (assignBranch: false in seed.ts); supervisor and staff
 * are both assigned to the seeded "Main Branch" (code MAIN01).
 */
export const TEST_USERS = {
  super_admin: {
    email: 'admin@potatocorner.test',
    password: 'SuperAdmin123',
    role: 'super_admin' as const,
    dashboardPath: '/admin/dashboard',
  },
  supervisor: {
    email: 'supervisor@potatocorner.test',
    password: 'Supervisor123',
    role: 'supervisor' as const,
    dashboardPath: '/supervisor/dashboard',
  },
  staff: {
    email: 'staff@potatocorner.test',
    password: 'Staff123',
    role: 'staff' as const,
    dashboardPath: '/terminal',
  },
} as const;

export type TestUserKey = keyof typeof TEST_USERS;
