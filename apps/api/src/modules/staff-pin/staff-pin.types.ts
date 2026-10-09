import type { InventoryApprovalOperation } from '@potato-corner/shared';
export type { InventoryApprovalOperation };

/** Mirrors InventoryApprovalError/UniversalInventoryError — every module maps its own domain errors to HTTP status via its router's error handler. */
export class StaffPinError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StaffPinError';
  }
}

export interface VerifyPinDraft {
  branchId: string;
  pin: string;
  operation: InventoryApprovalOperation;
  inventoryItemId?: string;
  quantity?: number;
  unitId?: string;
  reasonCode?: string;
  notes?: string;
}

/** The result of consuming a verification token — resolved responsible-staff identity, bound to the exact payload it was issued for. */
export interface ConsumedVerification {
  responsibleStaffUserId: string;
  responsibleStaffName: string;
  pinVerifiedAt: Date;
}

export interface ConsumeVerificationInput {
  token: string;
  actorUserId: string;
  branchId: string;
  operation: InventoryApprovalOperation;
  inventoryItemId?: string;
  quantity?: number;
  unitId?: string;
  reasonCode?: string;
  notes?: string;
}
