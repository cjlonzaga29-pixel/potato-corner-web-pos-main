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

/** Where each role lands after login/refresh — the single source of truth for both apps/web/middleware.ts and apps/web/lib/constants.ts. */
export const ROLE_DASHBOARDS: Record<Role, string> = {
  super_admin: '/admin/dashboard',
  supervisor: '/supervisor/dashboard',
  branch: '/branch/dashboard',
  staff: '/branch/terminal',
};
