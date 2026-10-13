import { branchesRepository } from '../modules/branches/branches.repository.js';

/**
 * POS-PERF-P35R — shared ownership resolution for every catalog/
 * inventory-definition record that carries both createdBy (original
 * creator provenance, immutable here) and managedBy (explicit Super Admin
 * assignment, see catalog-assignment module). The effective manager is
 * managedBy when set, else createdBy — never a write to createdBy itself.
 */
export interface CatalogOwnedRecord {
  createdBy: string | null;
  managedBy?: string | null;
}

export function effectiveCatalogManager(record: CatalogOwnedRecord): string | null {
  return record.managedBy ?? record.createdBy ?? null;
}

export function isCatalogManager(record: CatalogOwnedRecord, actorId: string): boolean {
  return effectiveCatalogManager(record) === actorId;
}

/**
 * POS-PERF-P35R4 — isCatalogManager alone is a point-in-time ownership
 * check: it proves actorId was granted managedBy/createdBy at some point,
 * never that the grant is still operationally valid now. For a
 * branch-exclusive Product/Variant, createAssignment only let that grant
 * happen because the supervisor had an active branch assignment to
 * exclusiveBranchId at assignment time (see catalog-assignment.service.ts) —
 * if that branch assignment is revoked afterward, the catalog grant must
 * stop working too, not keep bypassing branch scope on managedBy alone.
 * Branch-agnostic catalog/inventory records (no exclusiveBranchId) have
 * nothing to re-check here and fall through to the plain ownership result.
 */
export async function isCatalogManagerForProduct(
  record: CatalogOwnedRecord & { branchExclusive: boolean; exclusiveBranchId: string | null },
  actorId: string,
): Promise<boolean> {
  if (!isCatalogManager(record, actorId)) return false;
  if (!record.branchExclusive || !record.exclusiveBranchId) return true;
  const activeBranchIds = await branchesRepository.findAllActiveBranchIds(actorId);
  return activeBranchIds.includes(record.exclusiveBranchId);
}
