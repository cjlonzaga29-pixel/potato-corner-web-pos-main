import type { ImageProofType } from '@potato-corner/shared';

/** Mirrors UniversalInventoryError/IngredientError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class InventoryApprovalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InventoryApprovalError';
  }
}

export type InventoryApprovalTarget = 'UNIVERSAL_ITEM' | 'LEGACY_INGREDIENT';
export type InventoryApprovalOperation = 'RECEIVING' | 'ADJUSTMENT' | 'PHYSICAL_COUNT' | 'WASTE';
export type InventoryApprovalStatus = 'PENDING' | 'APPROVED' | 'RETURNED' | 'CANCELLED';

/** POS-PERF-P29 — resolved server-side from a StaffPinVerification token, never from a client-supplied id. Attached to every submit*Data variant below. */
export interface StaffPinResolution {
  responsibleStaffUserId: string;
  responsibleStaffName: string;
  pinVerifiedAt: Date;
}

/** POS-PERF-P29 — evidence is now a pre-submit blocking upload (InventoryEvidenceUpload), resolved to a storage key/type before the request row is created. */
export interface ResolvedEvidence {
  proofKey: string;
  proofType: ImageProofType;
}

export interface SubmitReceivingData {
  target: InventoryApprovalTarget;
  branchId: string;
  inventoryItemId?: string;
  legacyIngredientId?: string;
  enteredQuantity: number;
  enteredUnitId?: string;
  totalCost?: number;
  deliveryReference?: string;
  notes?: string;
  staffPin?: StaffPinResolution;
  evidence?: ResolvedEvidence;
}

export interface SubmitAdjustmentData {
  target: InventoryApprovalTarget;
  branchId: string;
  inventoryItemId?: string;
  legacyIngredientId?: string;
  quantityDelta: number;
  reasonCode: string;
  notes?: string;
  staffPin?: StaffPinResolution;
  evidence?: ResolvedEvidence;
}

export interface SubmitWasteData {
  target: InventoryApprovalTarget;
  branchId: string;
  inventoryItemId?: string;
  legacyIngredientId?: string;
  quantity: number;
  enteredUnitId?: string;
  reasonCode: string;
  notes?: string;
  /**
   * Mandatory in practice for every UNIVERSAL_ITEM waste submission —
   * wasteInventoryStockSchema's verification_token is required at the
   * schema level, so universal-inventory.router.ts always resolves and
   * passes one. Optional here only so the legacy /ingredients/:id/waste
   * route (POS-PERF-P29R3 — see inventory.router.ts) can route a
   * LEGACY_INGREDIENT waste through this same Pending Review queue without
   * one: that system predates P29 and never collected a PIN at all (see
   * requestRequiresStaffVerification's doc comment in
   * inventory-approval.service.ts — it never required one for
   * LEGACY_INGREDIENT, for any operation).
   */
  staffPin?: StaffPinResolution;
  evidence?: ResolvedEvidence;
}

export interface SubmitPhysicalCountData {
  target: InventoryApprovalTarget;
  branchId: string;
  counts: { inventoryItemId?: string; legacyIngredientId?: string; countedQuantity: number }[];
  notes?: string;
}

export interface CorrectRequestData {
  enteredQuantity?: number;
  enteredUnitId?: string;
  totalCost?: number;
  deliveryReference?: string;
  quantityDelta?: number;
  countedQuantity?: number;
  reasonCode?: string;
  notes?: string;
  /** POS-PERF-P29R2 — mandatory for RECEIVING/ADJUSTMENT/WASTE corrections (resolved server-side, same as on initial submission); never applicable to PHYSICAL_COUNT. */
  staffPin?: StaffPinResolution;
  evidence?: ResolvedEvidence;
}

export interface ListApprovalFilters {
  branchId?: string;
  status?: InventoryApprovalStatus;
  submittedByUserId?: string;
  page: number;
  limit: number;
}

export type { ImageProofType };
