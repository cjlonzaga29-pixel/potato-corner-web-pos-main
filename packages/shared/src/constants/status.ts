/**
 * Const-object "enums" for every status/type field in the schema.
 * Values match the architecture doc's CHECK constraint value lists exactly.
 */

export const PRODUCT_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  TEMPORARILY_UNAVAILABLE: 'temporarily_unavailable',
  DISCONTINUED: 'discontinued',
  ARCHIVED: 'archived',
} as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];

/** Alias matching Phase 6's task naming (PRODUCT_STATUSES) — same values as PRODUCT_STATUS, kept as one source of truth. */
export const PRODUCT_STATUSES = PRODUCT_STATUS;

/** Shared by branch_price_overrides, product_requests — every CR-001 approval workflow uses this same three-state shape. */
export const REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
export type RequestStatus = (typeof REQUEST_STATUS)[keyof typeof REQUEST_STATUS];

export const FLAVOR_AVAILABILITY_REASONS = {
  OUT_OF_STOCK: 'out_of_stock',
  MANUAL_UNAVAILABLE: 'manual_unavailable',
} as const;
export type FlavorAvailabilityReason =
  (typeof FLAVOR_AVAILABILITY_REASONS)[keyof typeof FLAVOR_AVAILABILITY_REASONS];

export const BRANCH_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  CLOSED: 'closed',
} as const;
export type BranchStatus = (typeof BRANCH_STATUS)[keyof typeof BRANCH_STATUS];

export const EMPLOYMENT_TYPE = {
  REGULAR: 'regular',
  CONTRACTUAL: 'contractual',
  PART_TIME: 'part_time',
} as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPE)[keyof typeof EMPLOYMENT_TYPE];

/** Alias matching Phase 5's task naming (EMPLOYMENT_TYPES) — same values as EMPLOYMENT_TYPE, kept as one source of truth. */
export const EMPLOYMENT_TYPES = EMPLOYMENT_TYPE;

export const EMPLOYEE_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[keyof typeof EMPLOYEE_STATUS];

export const TRANSACTION_STATUS = {
  COMPLETED: 'completed',
  VOIDED: 'voided',
  REFUNDED: 'refunded',
} as const;
export type TransactionStatus = (typeof TRANSACTION_STATUS)[keyof typeof TRANSACTION_STATUS];

export const PAYMENT_METHOD = {
  CASH: 'cash',
  GCASH: 'gcash',
} as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];

export const DISCOUNT_TYPE = {
  PWD: 'pwd',
  SENIOR_CITIZEN: 'senior_citizen',
  EMPLOYEE: 'employee',
  MANAGER_OVERRIDE: 'manager_override',
  PROMOTIONAL: 'promotional',
} as const;
export type DiscountType = (typeof DISCOUNT_TYPE)[keyof typeof DISCOUNT_TYPE];

export const INVENTORY_DEDUCTION_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type InventoryDeductionStatus =
  (typeof INVENTORY_DEDUCTION_STATUS)[keyof typeof INVENTORY_DEDUCTION_STATUS];

export const SHIFT_STATUS = {
  ACTIVE: 'active',
  CLOSED: 'closed',
  FLAGGED: 'flagged',
} as const;
export type ShiftStatus = (typeof SHIFT_STATUS)[keyof typeof SHIFT_STATUS];

export const DENOMINATION_COUNT_TYPE = {
  OPENING: 'opening',
  CLOSING: 'closing',
} as const;
export type DenominationCountType =
  (typeof DENOMINATION_COUNT_TYPE)[keyof typeof DENOMINATION_COUNT_TYPE];

export const MOVEMENT_TYPE = {
  STOCK_IN: 'stock_in',
  SALE_DEDUCTION: 'sale_deduction',
  MANUAL_ADJUSTMENT: 'manual_adjustment',
  WASTE: 'waste',
  PHYSICAL_COUNT: 'physical_count',
  TRANSFER_IN: 'transfer_in',
  TRANSFER_OUT: 'transfer_out',
} as const;
export type MovementType = (typeof MOVEMENT_TYPE)[keyof typeof MOVEMENT_TYPE];

export const IMAGE_PROOF_TYPE = {
  LIVE_CAPTURE: 'live_capture',
  GALLERY_UPLOAD: 'gallery_upload',
} as const;
export type ImageProofType = (typeof IMAGE_PROOF_TYPE)[keyof typeof IMAGE_PROOF_TYPE];

/** Reason codes for a manual_adjustment InventoryMovement (Phase 8). */
export const ADJUSTMENT_REASON = {
  COUNT_CORRECTION: 'count_correction',
  DAMAGED: 'damaged',
  EXPIRED: 'expired',
  SUPPLIER_ERROR: 'supplier_error',
  OTHER: 'other',
} as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASON)[keyof typeof ADJUSTMENT_REASON];

/** Reason codes for a waste InventoryMovement (Phase 8) — distinct from adjustment reasons per the spec. */
export const WASTE_REASON = {
  SPOILAGE: 'spoilage',
  PREPARATION_ERROR: 'preparation_error',
  DROPPED: 'dropped',
  EXPIRED: 'expired',
  OTHER: 'other',
} as const;
export type WasteReason = (typeof WASTE_REASON)[keyof typeof WASTE_REASON];

export const GPS_STATUS = {
  WITHIN_RADIUS: 'within_radius',
  OUTSIDE_RADIUS: 'outside_radius',
  NO_GPS_DATA: 'no_gps_data',
} as const;
export type GpsStatus = (typeof GPS_STATUS)[keyof typeof GPS_STATUS];

export const ATTENDANCE_STATUS = {
  PRESENT: 'present',
  CORRECTED: 'corrected',
} as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUS)[keyof typeof ATTENDANCE_STATUS];

export const FRAUD_ALERT_SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;
export type FraudAlertSeverity = (typeof FRAUD_ALERT_SEVERITY)[keyof typeof FRAUD_ALERT_SEVERITY];

export const FRAUD_ALERT_STATUS = {
  OPEN: 'open',
  INVESTIGATING: 'investigating',
  DISMISSED: 'dismissed',
  ESCALATED: 'escalated',
} as const;
export type FraudAlertStatus = (typeof FRAUD_ALERT_STATUS)[keyof typeof FRAUD_ALERT_STATUS];

export const REPORT_TYPE = {
  DAILY_SALES: 'DAILY_SALES',
  SHIFT_SUMMARY: 'SHIFT_SUMMARY',
  CASH_RECONCILIATION: 'CASH_RECONCILIATION',
  VOID_REFUND: 'VOID_REFUND',
  DISCOUNT_COMPLIANCE: 'DISCOUNT_COMPLIANCE',
  INVENTORY_MOVEMENT: 'INVENTORY_MOVEMENT',
  ATTENDANCE_SUMMARY: 'ATTENDANCE_SUMMARY',
  FRAUD_ALERT_SUMMARY: 'FRAUD_ALERT_SUMMARY',
  PRODUCT_PERFORMANCE: 'PRODUCT_PERFORMANCE',
  FLAVOR_PERFORMANCE: 'FLAVOR_PERFORMANCE',
  EMPLOYEE_PERFORMANCE: 'EMPLOYEE_PERFORMANCE',
  INVENTORY_VALUATION: 'INVENTORY_VALUATION',
  BRANCH_COMPARISON: 'BRANCH_COMPARISON',
  AUDIT_LOG: 'AUDIT_LOG',
} as const;
export type ReportType = (typeof REPORT_TYPE)[keyof typeof REPORT_TYPE];
