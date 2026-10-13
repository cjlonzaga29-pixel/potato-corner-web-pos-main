import type { CatalogResourceType } from '@potato-corner/shared';

export class CatalogAssignmentError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'CatalogAssignmentError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface CreateCatalogAssignmentInput {
  resource_type: CatalogResourceType;
  resource_id: string;
  supervisor_id: string;
  reason: string;
}

/** Common shape every resource-type-specific lookup resolves to. */
export interface ResourceOwnershipSnapshot {
  exists: boolean;
  createdBy: string | null;
  managedBy: string | null;
  label: string;
  /** Set only for a branch-exclusive Product; null for branch-agnostic catalog/master data. */
  exclusiveBranchId: string | null;
}

export interface DependentSummaryRow {
  resourceType: CatalogResourceType;
  count: number;
  distinctOtherManagers: number;
}
