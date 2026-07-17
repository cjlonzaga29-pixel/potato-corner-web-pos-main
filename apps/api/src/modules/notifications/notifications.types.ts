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
