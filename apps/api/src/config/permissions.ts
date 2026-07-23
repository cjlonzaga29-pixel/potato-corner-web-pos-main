/**
 * Authoritative reference for the middleware chain each endpoint requires
 * (Architecture doc §3.4). Not consumed programmatically by the routers —
 * routers wire up the actual middleware directly — this exists so the
 * required chain for any given action can be looked up in one place rather
 * than re-derived from reading every router file.
 */
export const PERMISSIONS = {
  // Auth — no middleware required except where noted
  AUTH_LOGIN: 'public',
  AUTH_REFRESH: 'public',
  AUTH_LOGOUT: 'authenticate',

  // Branch management
  BRANCH_LIST: 'adminOrSupervisor',
  BRANCH_CREATE: 'adminOnly',
  BRANCH_UPDATE: 'adminOnly',
  BRANCH_DELETE: 'adminOnly',

  // Product management
  PRODUCT_LIST: 'adminOrSupervisor',
  PRODUCT_CREATE: 'adminOnly',
  PRODUCT_UPDATE: 'adminOnly',
  PRODUCT_STATUS_CHANGE: 'adminOrSupervisor',
  PRODUCT_IMAGE_UPLOAD: 'adminOnly',
  PRODUCT_BRANCH_AVAILABILITY: 'adminOrSupervisor',
  VARIANT_CREATE: 'adminOnly',
  VARIANT_UPDATE: 'adminOnly',

  // Flavor management
  FLAVOR_LIST: 'adminOrSupervisor',
  FLAVOR_CREATE: 'adminOnly',
  FLAVOR_UPDATE: 'adminOnly',
  FLAVOR_BRANCH_AVAILABILITY: 'adminOrSupervisor',

  // CR-001 — product requests (supervisor submits, Super Admin approves)
  PRODUCT_REQUEST_SUBMIT: 'supervisorOnly',
  PRODUCT_REQUEST_LIST: 'adminOrSupervisor + role-scoped',
  PRODUCT_REQUEST_REVIEW: 'adminOnly',

  // CR-002 — flavor requests (supervisor submits, Super Admin approves)
  FLAVOR_REQUEST_SUBMIT: 'supervisorOnly',
  FLAVOR_REQUEST_LIST: 'adminOrSupervisor + role-scoped',
  FLAVOR_REQUEST_REVIEW: 'adminOnly',

  // CR-001 — branch price overrides (supervisor submits, Super Admin approves)
  PRICE_OVERRIDE_SUBMIT: 'supervisorOnly',
  PRICE_OVERRIDE_LIST: 'adminOrSupervisor + role-scoped',
  PRICE_OVERRIDE_REVIEW: 'adminOnly',

  // Inventory
  INVENTORY_VIEW: 'adminOrSupervisor',
  INVENTORY_ADJUST: 'adminOrSupervisor',
  INVENTORY_STOCK_IN: 'adminOrSupervisor',
  INGREDIENT_CREATE: 'adminOnly',
  INGREDIENT_LIST: 'adminOrSupervisor',

  // Recipes (Phase 7 foundation + CR-001 branch overrides)
  RECIPE_LIST: 'adminOrSupervisor',
  RECIPE_CREATE: 'adminOnly',
  RECIPE_UPDATE: 'adminOnly',
  RECIPE_DELETE: 'adminOnly',
  RECIPE_SIMULATE: 'adminOrSupervisor',
  RECIPE_OVERRIDE_LIST: 'adminOrSupervisor',
  RECIPE_OVERRIDE_CREATE: 'supervisorOnly',
  RECIPE_OVERRIDE_UPDATE: 'supervisorOnly',
  RECIPE_OVERRIDE_DELETE: 'supervisorOnly',

  // Transactions — staff requires shift-guard
  TRANSACTION_CREATE: 'allRoles + shiftGuard',
  TRANSACTION_VOID_REQUEST: 'allRoles + shiftGuard',
  TRANSACTION_VOID_APPROVE: 'adminOrSupervisor',

  // Shifts
  SHIFT_OPEN: 'adminOrSupervisor',
  SHIFT_CLOSE: 'allRoles',
  SHIFT_VIEW: 'adminOrSupervisor',

  // Employees
  EMPLOYEE_LIST: 'adminOrSupervisor',
  EMPLOYEE_CREATE: 'adminOnly',
  EMPLOYEE_UPDATE: 'adminOnly',
  EMPLOYEE_DEACTIVATE: 'adminOnly',

  // Attendance
  ATTENDANCE_CLOCK_IN: 'allRoles',
  ATTENDANCE_CLOCK_OUT: 'allRoles',
  ATTENDANCE_CORRECT: 'adminOrSupervisor',
  ATTENDANCE_VIEW: 'adminOrSupervisor',

  // Cash management
  CASH_COUNT_OPEN: 'allRoles',
  CASH_COUNT_CLOSE: 'allRoles',
  CASH_VARIANCE_APPROVE: 'adminOrSupervisor',

  // Reports
  REPORT_VIEW: 'adminOrSupervisor',
  REPORT_EXPORT: 'adminOrSupervisor',

  // Fraud alerts
  FRAUD_ALERT_VIEW: 'adminOnly',
  FRAUD_ALERT_INVESTIGATE: 'adminOnly',
  FRAUD_ALERT_DISMISS: 'adminOnly',

  // Audit logs
  AUDIT_LOG_VIEW: 'adminOnly',

  // System configuration
  SYSTEM_CONFIG: 'adminOnly',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
