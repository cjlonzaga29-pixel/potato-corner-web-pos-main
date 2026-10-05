import type { TransactionResponse } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import type { SaleSnapshot } from '@/components/pos/sale-status-modal';

/**
 * POS-PERF-P15R2 — a dropped HTTP response (timeout, connection drop,
 * reload/browser-close mid-request) proves nothing about whether the
 * checkout it belonged to actually committed server-side: the original
 * request can still be mid-flight on the server and commit a moment later.
 * This module resolves that uncertainty against the database itself
 * (GET /api/transactions/by-idempotency-key/:key — a plain read, safe to
 * poll) instead of letting the terminal assume "no response" means "safe to
 * start a different checkout under a new key".
 *
 * A single immediate check isn't enough either — if the original request's
 * insert genuinely hasn't landed yet, one check races it and can still lose.
 * resolveCheckoutAttempt polls across a bounded window before concluding
 * "not found", trading a few seconds of latency on the rare uncertain path
 * for never minting a second checkout out from under an attempt that was
 * always going to land.
 */

const POLL_DELAYS_MS = [1200, 2000, 3000, 4500, 6000];

export type ResolveCheckoutOutcome =
  | { status: 'found'; transaction: TransactionResponse }
  | { status: 'not-found' }
  /** The check itself couldn't get a conclusive answer (network error on every attempt) — the original attempt's fate is still unknown, not "safe". */
  | { status: 'unknown' };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveCheckoutAttempt(idempotencyKey: string): Promise<ResolveCheckoutOutcome> {
  for (let attempt = 0; attempt <= POLL_DELAYS_MS.length; attempt++) {
    const response = await apiClient<TransactionResponse>(`/api/transactions/by-idempotency-key/${idempotencyKey}`);
    if (response.data) return { status: 'found', transaction: response.data };

    const code = typeof response.error === 'string' ? response.error : response.error?.code;
    if (code !== 'IDEMPOTENCY_KEY_NOT_FOUND') {
      // Network error, auth hiccup, etc. — this check made no progress at
      // all, so it must not be conflated with a confirmed "not found".
      return { status: 'unknown' };
    }

    if (attempt < POLL_DELAYS_MS.length) {
      await sleep(POLL_DELAYS_MS[attempt] as number);
    }
  }
  return { status: 'not-found' };
}

/** Keyed per-branch so two devices/shifts on the same branch never clobber each other's in-flight attempt. No cart/payment contents are ever stored — only the opaque key a status check is made against. */
function pendingAttemptStorageKey(branchId: string): string {
  return `pos:pending-checkout:${branchId}`;
}

export function savePendingCheckoutAttempt(branchId: string, idempotencyKey: string): void {
  try {
    localStorage.setItem(pendingAttemptStorageKey(branchId), JSON.stringify({ idempotencyKey, savedAt: Date.now() }));
  } catch {
    // localStorage unavailable (private mode, quota) — reload-recovery is
    // best-effort; the in-session fingerprint guard still covers same-tab edits.
  }
}

export function clearPendingCheckoutAttempt(branchId: string): void {
  try {
    localStorage.removeItem(pendingAttemptStorageKey(branchId));
  } catch {
    // ignore
  }
}

export function readPendingCheckoutAttempt(branchId: string): { idempotencyKey: string; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(pendingAttemptStorageKey(branchId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { idempotencyKey?: unknown; savedAt?: unknown };
    if (typeof parsed.idempotencyKey !== 'string' || typeof parsed.savedAt !== 'number') return null;
    return { idempotencyKey: parsed.idempotencyKey, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

/** Rebuilds the sale-confirmation snapshot from the resolved server record, for the reload/browser-close recovery path where the client's own cart state (and so the original SaleSnapshot) no longer exists. */
export function transactionToSaleSnapshot(transaction: TransactionResponse): SaleSnapshot {
  return {
    items: (transaction.items ?? []).map((item) => ({
      id: item.id,
      productName: item.product_name,
      variantName: item.variant_name,
      flavorName: item.flavor_name,
      quantity: item.quantity,
      lineTotal: item.line_total,
      optionSelections: item.selected_options.map((option) => ({
        option_id: option.option_id,
        option_name: option.option_name,
        price_adjustment: option.price_adjustment,
      })),
    })),
    subtotal: transaction.subtotal,
    discountAmount: transaction.discount_amount,
    discountType: transaction.discount_type,
    vatAmount: transaction.vat_amount,
    totalAmount: transaction.total_amount,
    paymentMethod: transaction.payment_method,
    cashTendered: transaction.cash_tendered,
    changeGiven: transaction.change_given,
  };
}
