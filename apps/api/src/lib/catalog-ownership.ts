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
