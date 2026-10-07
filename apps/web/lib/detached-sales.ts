import type { CreateTransactionInput, TransactionResponse } from '@potato-corner/shared';
import type { SaleSnapshot } from '@/components/pos/sale-status-modal';

/**
 * POS-PERF-P19 — a checkout the cashier detached from by tapping "New Sale"
 * while the original request was still saving (sale-status-modal.tsx's
 * 'saving' phase). Detaching never cancels or alters the submitted request
 * — it only stops that one request's eventual success/failure from
 * reopening or overwriting whatever cart/modal the cashier has moved on to.
 * See checkout-recovery.ts for the single-slot "frontmost" attempt this
 * complements: that mechanism still owns the common case (cashier waits for
 * the popup to resolve before doing anything else); this one exists only
 * for attempts the cashier has explicitly stopped watching.
 *
 * `payload` is the exact CreateTransactionInput (with its idempotency_key)
 * that was already sent — kept so Retry-from-panel can resubmit the literal
 * same request under the same key rather than trying to reconstruct it from
 * a cart that may no longer exist. This is not "sensitive payment detail":
 * it is exactly what the server already received (cash tendered/payment
 * proof *keys*, never card numbers — this POS never collects those), so
 * retaining it locally adds no new exposure. No credentials, access tokens,
 * or raw proof image bytes are ever part of it.
 */
export interface DetachedSale {
  idempotencyKey: string;
  snapshot: SaleSnapshot;
  payload: CreateTransactionInput;
  status: 'saving' | 'success' | 'error';
  transaction: TransactionResponse | null;
  errorMessage: string | null;
  /** True once a check has confirmed the server definitely never committed anything under this key (see checkout-recovery.ts isDefiniteNoCommitErrorCode / resolveAndFenceCheckoutAttempt) — Retry-from-panel can resubmit immediately; otherwise it must resolve first. */
  safeToRetryDirectly: boolean;
  createdAt: number;
}

/**
 * Bounded backlog — requirement is "do not silently accept unlimited
 * orders". Five concurrent unresolved (saving/error) detached sales is far
 * beyond what one cashier queues up in practice (each one represents an
 * entire customer's order they've already walked away from); past that,
 * the terminal blocks further "New Sale during saving" detaches until the
 * cashier resolves one, surfaced via canDetachAnotherSale below.
 */
export const MAX_DETACHED_SALES = 5;

function storageKey(branchId: string): string {
  return `pos:detached-sales:${branchId}`;
}

export function readDetachedSales(branchId: string): DetachedSale[] {
  try {
    const raw = localStorage.getItem(storageKey(branchId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DetachedSale[];
  } catch {
    return [];
  }
}

/**
 * Returns whether the write actually persisted. Unlike checkout-recovery.ts's
 * savePendingCheckoutAttempt (which is allowed to be best-effort — it only
 * backs up an idempotency key an in-flight request already carries), a
 * failed write here means the DetachedSale record about to replace this
 * cart would have no durable copy anywhere once the cart is cleared. Callers
 * that are about to clear a cart on the strength of this write MUST check
 * this return value first.
 */
export function writeDetachedSales(branchId: string, entries: DetachedSale[]): boolean {
  try {
    localStorage.setItem(storageKey(branchId), JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function upsertDetachedSale(branchId: string, entry: DetachedSale): { entries: DetachedSale[]; persisted: boolean } {
  const current = readDetachedSales(branchId);
  const next = [...current.filter((e) => e.idempotencyKey !== entry.idempotencyKey), entry];
  const persisted = writeDetachedSales(branchId, next);
  return { entries: next, persisted };
}

export function removeDetachedSale(branchId: string, idempotencyKey: string): DetachedSale[] {
  const next = readDetachedSales(branchId).filter((e) => e.idempotencyKey !== idempotencyKey);
  writeDetachedSales(branchId, next);
  return next;
}

/** Unresolved = still occupying a backlog slot; 'success' entries are resolved and don't count. */
export function countUnresolvedDetachedSales(entries: DetachedSale[]): number {
  return entries.filter((e) => e.status === 'saving' || e.status === 'error').length;
}

export function canDetachAnotherSale(branchId: string): boolean {
  return countUnresolvedDetachedSales(readDetachedSales(branchId)) < MAX_DETACHED_SALES;
}
