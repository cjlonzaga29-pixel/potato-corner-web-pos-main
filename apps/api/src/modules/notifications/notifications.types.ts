/**
 * Notifications module types. Request/response shapes for this module come from
 * @potato-corner/shared where a Zod schema already exists; module-local
 * types that don't need cross-app sharing are defined here.
 */

// TODO(Phase 18 Task 6): these three interfaces don't yet match the real
// job-data shape emitted by inventory.queue.ts's low_stock_alert job
// (LowStockAlertJobData: ingredientId/ingredientName/currentStock/
// lowStockThreshold/criticalThreshold, discriminated by a `severity` field
// rather than separate low/critical job names). Fix field-for-field before
// Task 6 persists these, same issue already fixed here for
// inventory_deduction_failed/product_auto_unavailable in Task 4.
export interface LowStockNotificationPayload {
  type: 'low_stock';
  branchId: string;
  productId: string;
  currentQuantity: number;
  threshold: number;
}

export interface CriticalStockNotificationPayload {
  type: 'critical_stock';
  branchId: string;
  productId: string;
  currentQuantity: number;
  threshold: number;
}

export interface OutOfStockNotificationPayload {
  type: 'out_of_stock';
  branchId: string;
  productId: string;
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

export interface EodSummaryNotificationPayload {
  type: 'eod_summary';
  branchId: string;
  businessDate: string;
  totalSales: number;
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
