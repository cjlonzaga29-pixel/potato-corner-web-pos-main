/**
 * POS-PERF-P48 — links into the transfer page. The query string only
 * pre-fills the form: the page ignores branches outside the signed-in
 * user's active branch list, and the API re-authorizes source (branchGuard)
 * and destination (getTransferDestinationBranchIds) on every request.
 */
export interface TransferPrefill {
  fromBranchId?: string | null;
  toBranchId?: string | null;
  inventoryItemId?: string | null;
}

export function transferPrepareHref(basePath: string, prefill: TransferPrefill = {}): string {
  const params = new URLSearchParams();
  if (prefill.toBranchId) params.set('to_branch_id', prefill.toBranchId);
  if (prefill.fromBranchId) params.set('from_branch_id', prefill.fromBranchId);
  if (prefill.inventoryItemId) params.set('inventory_item_id', prefill.inventoryItemId);
  const query = params.toString();
  return `${basePath}/inventory/transfer${query ? `?${query}` : ''}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads a prefill id from the URL; anything that isn't a UUID is dropped rather than sent anywhere. */
export function readPrefillId(params: URLSearchParams | { get(name: string): string | null }, name: string): string {
  const value = params.get(name);
  return value && UUID_PATTERN.test(value) ? value : '';
}
