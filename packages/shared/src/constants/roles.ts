/** User roles. Const object, not a native TS enum, per project code standards. */
export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  SUPERVISOR: 'supervisor',
  BRANCH: 'branch',
  STAFF: 'staff',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  supervisor: 'Supervisor',
  branch: 'Branch Account',
  staff: 'Staff',
};

/**
 * Where each role lands after login/refresh — the single source of truth
 * for both apps/web/middleware.ts and apps/web/lib/constants.ts.
 *
 * Task 120: `branch` (the Branch Account) lands on its own dashboard, same
 * as every other role — it stays authenticated as itself for the whole
 * session (sidebar, header, every /branch page). "Who's working?" is no
 * longer a login-time redirect target: it's inline STATE 1 of the POS
 * Terminal's own state machine (apps/web/app/(branch)/branch/terminal/page.tsx),
 * reached by navigating there like any other branch page, not by
 * authenticating as a different user. `staff` sessions (a genuine Employee
 * login, e.g. via PIN) still go straight to the terminal, unchanged.
 */
export const ROLE_DASHBOARDS: Record<Role, string> = {
  super_admin: '/admin/dashboard',
  supervisor: '/supervisor/dashboard',
  branch: '/branch/dashboard',
  staff: '/branch/terminal',
};
