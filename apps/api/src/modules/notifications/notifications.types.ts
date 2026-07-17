/**
 * Notifications module types. Request/response shapes for this module come from
 * @potato-corner/shared where a Zod schema already exists; module-local
 * types that don't need cross-app sharing are defined here.
 */

// Matches inventory.queue.ts's LowStockAlertJobData field-for-field (fixed
// in Task 6 — previously used a productId/currentQuantity/threshold shape
// that didn't match the real job data). All three share one job, discriminated
// by currentStock/severity at persistence time in notification.queue.ts, not
// by separate job names — inventory.queue.ts only ever enqueues 'low_stock_alert'.
export interface LowStockNotificationPayload {
  type: 'low_stock';
  branchId: string;
  ingredientId: string;
  ingredientName: string;
  currentStock: number;
  lowStockThreshold: number;
  criticalThreshold: number;
}

export interface CriticalStockNotificationPayload {
  type: 'critical_stock';
  branchId: string;
  ingredientId: string;
  ingredientName: string;
  currentStock: number;
  lowStockThreshold: number;
  criticalThreshold: number;
}

export interface OutOfStockNotificationPayload {
  type: 'out_of_stock';
  branchId: string;
  ingredientId: string;
  ingredientName: string;
  currentStock: number;
  lowStockThreshold: number;
  criticalThreshold: number;
}

export interface ProductAutoUnavailableNotificationPayload {
  type: 'product_auto_unavailable';
  branchId: string;
  triggeredByIngredientId: string;
  triggeredByIngredientName: string;
  affectedFlavors: { flavorId: string; name: string }[];
  affectedProducts: { productId: string; name: string }[];
}

export interface CashVarianceFlaggedNotificationPayload {
  type: 'cash_variance_flagged';
  shiftId: string;
  branchId: string;
  expectedAmount: number;
  actualAmount: number;
  variance: number;
  flaggedBy: string;
}

export interface VoidRequestedNotificationPayload {
  type: 'void_requested';
  branchId: string;
  transactionNumber: string;
  requestedByUserId: string;
  amount: number;
  reason: string | null;
}

export interface LargeAdjustmentApprovalNeededNotificationPayload {
  type: 'large_adjustment_approval_needed';
  branchId: string;
  adjustmentId: string;
  requestedByUserId: string;
  amount: number;
}

export interface FraudAlertCreatedNotificationPayload {
  type: 'fraud_alert_created';
  branchId: string;
  alertId: string;
  severity: string;
}

export interface InventoryDeductionFailedNotificationPayload {
  type: 'inventory_deduction_failed';
  transactionId: string;
  branchId: string;
  error: string;
}

export interface OfflineTransactionsSyncedNotificationPayload {
  type: 'offline_transactions_synced';
  branchId: string;
  syncedCount: number;
}

// branchId/totalSales scope this row to one branch (Notification.branch_id is
// non-nullable — see Task 3's committed migration); one job is enqueued per
// active branch (Task 8), each carrying the same company-wide totals
// (totalRevenue/transactionCount/voidCount/unresolvedCashVarianceCount/
// openFraudAlertsCreatedTodayCount/branchRevenue) so every recipient sees
// full context regardless of which branch a given row is tagged with.
export interface EodSummaryNotificationPayload {
  type: 'eod_summary';
  branchId: string;
  businessDate: string;
  totalSales: number;
  totalRevenue: number;
  transactionCount: number;
  voidCount: number;
  unresolvedCashVarianceCount: number;
  openFraudAlertsCreatedTodayCount: number;
  branchRevenue: { branchId: string; branchName: string; revenue: number }[];
}

export type NotificationPayload =
  | LowStockNotificationPayload
  | CriticalStockNotificationPayload
  | OutOfStockNotificationPayload
  | ProductAutoUnavailableNotificationPayload
  | CashVarianceFlaggedNotificationPayload
  | VoidRequestedNotificationPayload
  | LargeAdjustmentApprovalNeededNotificationPayload
  | FraudAlertCreatedNotificationPayload
  | InventoryDeductionFailedNotificationPayload
  | OfflineTransactionsSyncedNotificationPayload
  | EodSummaryNotificationPayload;

export type NotificationType = NotificationPayload['type'];

// branchId is required, matching the Notification Prisma model's non-nullable
// branch_id column — every current NotificationPayload variant carries a real
// branchId, so there's no company-wide/null case to support yet.
export interface CreateNotificationData {
  type: NotificationType;
  payload: NotificationPayload;
  recipientUserId: string;
  branchId: string;
}

/** Mirrors FraudError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class NotificationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

export interface NotificationPagination {
  page: number;
  limit: number;
}
