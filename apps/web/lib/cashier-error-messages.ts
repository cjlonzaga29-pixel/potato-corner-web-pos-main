/**
 * POS-PERF-P22 — a single, consistent cashier-facing wording mapper for
 * every checkout-failure surface (the live SaleStatusModal error phase, the
 * Orders panel's Needs Action entries, and their toasts). Takes an error
 * *code* — either a real server code from TransactionApiError, or one of
 * the synthetic codes below for an outcome that never came from the
 * server's own error response (a dropped network call, a still-in-flight
 * attempt, a confirmed rollback discovered via a later resolve rather than
 * the original request's own catch) — plus the existing detail string
 * already produced at the call site, and returns a short cashier-readable
 * title alongside that same detail, unchanged.
 *
 * Deliberately never invents or reformats quantities: every `detail` passed
 * in already came straight from the server (e.g. transactions.service.ts's
 * "Insufficient stock for X: need N, have M available") or from an existing,
 * audited local message — this module only adds a clear headline on top.
 */

export interface CashierFailureDisplay {
  title: string;
  detail: string;
}

/** No CheckoutAttempt row could be reached/read — genuinely uncertain, never "not saved". */
export const CONNECTION_UNCERTAIN = 'CONNECTION_UNCERTAIN';
/** Server confirmed the attempt is still live — not failed, just not done yet. */
export const STILL_PROCESSING = 'STILL_PROCESSING';
/** Server confirmed (via resolve, not the original request's own catch) that nothing committed — safe to retry. */
export const NOT_SAVED_SAFE_TO_RETRY = 'NOT_SAVED_SAFE_TO_RETRY';

const CONNECTION_UNCERTAIN_TITLE = 'Connection problem — checking order status';

const TITLES: Record<string, string> = {
  INSUFFICIENT_STOCK: 'Not enough stock',
  [CONNECTION_UNCERTAIN]: CONNECTION_UNCERTAIN_TITLE,
  [STILL_PROCESSING]: 'Still processing — not failed',
  [NOT_SAVED_SAFE_TO_RETRY]: 'Not saved — safe to retry',
  INVALID_SHIFT: 'Shift not open',
  SHIFT_CLOSED: 'Shift closed',
  PAYMENT_PROOF_REQUIRED: 'Payment proof required',
  DISCOUNT_TYPE_NOT_SUPPORTED: 'Discount not allowed',
  DISCOUNT_ID_REQUIRED: 'Discount not allowed',
  DISCOUNT_TYPE_DISABLED: 'Discount not allowed',
  INSUFFICIENT_CASH_TENDERED: 'Cash tendered too low',
  PRODUCT_UNAVAILABLE: 'Item unavailable',
  PRODUCT_OPTION_NOT_AVAILABLE: 'Item option unavailable',
  FLAVOR_SLOTS_INVALID: 'Flavor selection invalid',
  FLAVOR_SELECTION_REQUIRED: 'Flavor selection required',
  FLAVOR_NOT_AVAILABLE_FOR_VARIANT: 'Flavor unavailable',
  RECIPE_MISSING: 'Item unavailable',
  MIX_MAX_SLOT_INCOMPLETE: 'Item selection incomplete',
  VALIDATION_ERROR: 'Order details invalid',
  BRANCH_NOT_ASSIGNED: 'Branch not assigned',
  IDEMPOTENCY_KEY_REUSE: 'Duplicate order blocked',
  CHECKOUT_ATTEMPT_CONTENTION: 'Order already being processed',
  CHECKOUT_TIMEOUT: 'Request timed out — not saved',
};

/** Real server codes that prove only that THIS request made no progress, not that anything failed or succeeded — the network/uncertain bucket, same as the synthetic codes above. */
const NETWORK_OR_CONTENDED_CODES = new Set(['NETWORK_ERROR', 'UNREADABLE_RESPONSE', 'CHECKOUT_ATTEMPT_IN_PROGRESS', 'CHECKOUT_ATTEMPT_LOST_LEASE']);

/**
 * Maps a code (real or synthetic — see above) to a cashier-readable title
 * for the given detail message. Never guesses: an unrecognized code falls
 * back to a generic, non-committal title rather than a specific but
 * possibly-wrong one.
 */
export function describeCashierFailure(code: string | null | undefined, detail: string): CashierFailureDisplay {
  if (code && NETWORK_OR_CONTENDED_CODES.has(code)) {
    return { title: CONNECTION_UNCERTAIN_TITLE, detail };
  }
  const title = code ? TITLES[code] : undefined;
  if (title) {
    return { title, detail };
  }
  return { title: "Couldn't save sale", detail };
}
