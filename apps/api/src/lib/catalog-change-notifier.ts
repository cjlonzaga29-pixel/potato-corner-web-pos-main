import { SOCKET_EVENTS } from '@potato-corner/shared';
import { notifyBranch } from './notify.js';

/**
 * POS-PERF-P69R — tells open POS terminals that their branch's catalog may
 * have changed, so they refetch it instead of waiting for the 30-minute
 * refresh. Call only after the write has committed.
 *
 * - Branch-scoped: one `catalog:changed` per affected branch room, payload
 *   `{ branch_id }` only. Terminals refetch `GET /api/products/catalog`
 *   (authenticate + branchGuard); the event is never catalog data.
 * - Coalesced: every branch queued within COALESCE_MS goes out once, so a
 *   product-builder burst (details, sizes, flavors, publish) is one event per
 *   branch, not one per request. Terminals debounce again on their side.
 * - Single process: Socket.io runs on the in-memory adapter (one API
 *   instance). Terminals that miss an event recover on socket reconnect and
 *   through the catalog query's own fallback interval.
 */
export const CATALOG_CHANGE_COALESCE_MS = 300;

const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  const branchIds = [...pending];
  pending.clear();
  for (const branchId of branchIds) {
    notifyBranch(branchId, SOCKET_EVENTS.CATALOG_CHANGED, { branch_id: branchId });
  }
}

export function queueCatalogChanged(branchIds: Iterable<string | null | undefined>): void {
  for (const branchId of branchIds) {
    if (typeof branchId === 'string' && branchId.length > 0) pending.add(branchId);
  }
  if (pending.size === 0 || timer) return;
  timer = setTimeout(flush, CATALOG_CHANGE_COALESCE_MS);
  // Never keep a process (or a test run) alive just to send a hint.
  timer.unref?.();
}

/** Tests only: sends anything queued now. */
export function flushCatalogChangedForTests(): void {
  if (timer) clearTimeout(timer);
  flush();
}
