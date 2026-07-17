/**
 * Notifications module types. Request/response shapes for this module come from
 * @potato-corner/shared where a Zod schema already exists; module-local
 * types that don't need cross-app sharing are defined here.
 */

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
  productId: string;
  reason: string;
}

export interface CashVarianceFlaggedNotificationPayload {
  type: 'cash_variance_flagged';
  branchId: string;
  shiftId: string;
  varianceAmount: number;
}

export interface VoidRequestedNotificationPayload {
  type: 'void_requested';
  branchId: string;
  transactionNumber: string;
  requestedByUserId: string;
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
  branchId: string;
  transactionNumber: string;
  productId: string;
  reason: string;
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
