import type { TransactionResponse } from '@potato-corner/shared';
import { apiClient } from '@/lib/api-client';
import type { SaleSnapshot } from '@/components/pos/sale-status-modal';

/**
 * POS-PERF-P15R3 — a dropped HTTP response (timeout, connection drop,
 * reload/browser-close mid-request) proves nothing about whether the
 * checkout it belonged to actually committed server-side: the original
 * request can still be mid-flight on the server and commit a moment later.
 *
 * This used to be resolved by polling GET /by-idempotency-key across a
 * bounded (~17s) client-side window and then *assuming* a persistent
 * "not found" meant "safe to mint a replacement key". That assumption was
 * the bug: a request can legitimately still be running past any client-
 * chosen window (slow DB, GC pause, long lock wait), and minting a
 * replacement key out from under it risked a second, duplicate sale.
 *
 * The server now tracks every checkout attempt's fate durably (see
 * apps/api .../transactions.service.ts claimCheckoutAttempt and
 * CheckoutAttempt in schema.prisma) and the by-idempotency-key endpoint
 * reports one of three genuinely distinct, authoritative states instead of
 * a bare "found or not":
 *   - 'committed' — the sale exists; show it.
 *   - 'failed'    — the original attempt was definitively rejected before
 *                   any commit (or confirmed rolled back); safe to mint a
 *                   replacement key immediately, no waiting required.
 *   - 'in_progress' — the attempt is still live, or its fate simply isn't
 *                   known yet; the caller MUST keep this same key and
 *                   recheck later. Never treated as safe to remint.
 * A single check is now a meaningful, authoritative answer — there is
 * nothing left for client-side polling to accomplish, so none remains.
 */

export type ResolveCheckoutOutcome =
  | { status: 'found'; transaction: TransactionResponse }
  | { status: 'not-found' }
  /** Still unresolved server-side — keep the same idempotency key and recheck; never mint a replacement. */
  | { status: 'in-progress' }
  /** The check itself couldn't get a conclusive answer (network error, etc.) — the original attempt's fate is still unknown, not "safe". */
  | { status: 'unknown' };

interface ByIdempotencyKeyResponseData {
  status: 'committed' | 'failed' | 'in_progress';
  transaction?: TransactionResponse;
}

/**
 * POS-PERF-P15R3 — the exact set of error codes createTransaction can throw
 * that PROVE nothing was inserted under the submitted idempotency key: every
 * one of them is a validation rejection thrown before the sale's own
 * $transaction ever starts, or (CHECKOUT_TIMEOUT) a path Prisma/Postgres
 * guarantees rolled back. This is an ALLOWLIST, not a blocklist — the old
 * version of this check (isInconclusive = every error EXCEPT NETWORK_ERROR/
 * UNREADABLE_RESPONSE) was the bug: any server error this list doesn't
 * explicitly vouch for — a 500 from an unrelated bug, a post-commit
 * exception, a proxy/gateway error relayed as a generic JSON body, a future
 * error code nobody updated this list for — must default to "proves
 * nothing", never "safe". Deliberately excludes CHECKOUT_ATTEMPT_IN_PROGRESS
 * and CHECKOUT_ATTEMPT_LOST_LEASE: both prove THIS specific request didn't
 * commit, but the *key itself* is still (or was just) owned by some other
 * in-flight attempt, so minting a replacement would be exactly the bug this
 * revision removes — those must stay on the "keep the key, recheck" path
 * same as a genuine network failure.
 */
const DEFINITE_NO_COMMIT_CODES = new Set([
  // Pre-cart-resolution validation (branch/shift/payment/discount policy).
  'INVALID_SHIFT',
  'SHIFT_CLOSED',
  'PAYMENT_PROOF_REQUIRED',
  'DISCOUNT_TYPE_NOT_SUPPORTED',
  'DISCOUNT_ID_REQUIRED',
  'DISCOUNT_TYPE_DISABLED',
  'INSUFFICIENT_CASH_TENDERED',
  // Cart/catalog resolution (resolveCartItems/readinessRejection) — all
  // thrown before the sale's own $transaction ever opens.
  'PRODUCT_UNAVAILABLE',
  'PRODUCT_OPTION_NOT_AVAILABLE',
  'FLAVOR_SLOTS_INVALID',
  'FLAVOR_SELECTION_REQUIRED',
  'FLAVOR_NOT_AVAILABLE_FOR_VARIANT',
  'RECIPE_MISSING',
  'MIX_MAX_SLOT_INCOMPLETE',
  // Thrown inside the $transaction callback itself (stock reservation) —
  // still safe, since throwing there rolls back the whole interactive
  // transaction, including the sale insert.
  'INSUFFICIENT_STOCK',
  // Idempotency/fencing outcomes that are specifically about THIS request
  // never having inserted anything (not to be confused with
  // CHECKOUT_ATTEMPT_IN_PROGRESS/_LOST_LEASE below, which prove the same
  // about this request but must NOT be treated as safe to abandon the key).
  'IDEMPOTENCY_KEY_REUSE',
  'CHECKOUT_ATTEMPT_CONTENTION',
  // Prisma-guaranteed-rolled-back timeout (P2028).
  'CHECKOUT_TIMEOUT',
  // Request-shape rejections from middleware, before the service is ever called.
  'VALIDATION_ERROR',
  'BRANCH_NOT_ASSIGNED',
]);

/** True only for a server error code on the audited allowlist above — see its doc comment for why this must be an allowlist, not "everything except network/unreadable". */
export function isDefiniteNoCommitErrorCode(code: string | undefined): boolean {
  return code !== undefined && DEFINITE_NO_COMMIT_CODES.has(code);
}

/**
 * POS-PERF-P15R4 — branchId is required (not optional context): the server
 * now durably fences a key that comes back with nothing found yet (see
 * transactions.service.ts resolveCheckoutAttempt's doc comment), and that
 * fencing row needs an owning branch exactly like a real checkout claim
 * would. Every caller already knows its own branch — this is always
 * checked from within that branch's own terminal session.
 */
export async function resolveCheckoutAttempt(idempotencyKey: string, branchId: string): Promise<ResolveCheckoutOutcome> {
  const response = await apiClient<ByIdempotencyKeyResponseData>(
    `/api/transactions/by-idempotency-key/${idempotencyKey}?branch_id=${encodeURIComponent(branchId)}`,
  );

  if (response.data) {
    if (response.data.status === 'committed' && response.data.transaction) {
      return { status: 'found', transaction: response.data.transaction };
    }
    if (response.data.status === 'failed') return { status: 'not-found' };
    return { status: 'in-progress' };
  }

  const code = typeof response.error === 'string' ? response.error : response.error?.code;
  if (code === 'IDEMPOTENCY_KEY_NOT_FOUND') return { status: 'not-found' };
  // Network error, auth hiccup, an error reaching this otherwise-safe read
  // endpoint, etc. — this check made no progress at all, so it must not be
  // conflated with a confirmed "not found".
  return { status: 'unknown' };
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
