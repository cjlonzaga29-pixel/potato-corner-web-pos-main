/**
 * POS-PERF-P21 — a terminal-local order reference ("#01", "#02", …) shown to
 * the cashier the instant Checkout is clicked, well before the server has
 * assigned (or even seen) a real receipt number. This is deliberately NOT
 * the receipt/transaction number (transaction_number IS the receipt number
 * — see CLAUDE.md): it exists purely so a cashier juggling several pending
 * orders (via Next Customer) can tell them apart on this device, and must
 * never be presented as if it were the official BIR receipt number.
 *
 * Persisted as a simple monotonically increasing per-branch counter so a
 * reference stays stable across a reload (the same counter value is never
 * reused) and distinct across every order currently pending on this
 * terminal. It intentionally never resets (unlike the offline receipt
 * sequence, which resets nightly by design) — this counter has no BIR
 * numbering requirement to satisfy, only "never collide locally".
 */
function counterStorageKey(branchId: string): string {
  return `pos:order-ref-counter:${branchId}`;
}

export function nextOrderRef(branchId: string): number {
  try {
    const raw = localStorage.getItem(counterStorageKey(branchId));
    const current = raw ? Number.parseInt(raw, 10) : 0;
    const next = (Number.isFinite(current) ? current : 0) + 1;
    localStorage.setItem(counterStorageKey(branchId), String(next));
    return next;
  } catch {
    // localStorage unavailable (private mode, quota) — fall back to a
    // same-tab-unique value. It won't survive a reload, but a reload under
    // this condition already has no durable detached-sale storage either
    // (see lib/detached-sales.ts writeDetachedSales), so nothing regresses.
    return Date.now() % 1000;
  }
}

/** `#01`, `#02`, … `#123` — always at least 2 digits, never truncated past that. */
export function formatOrderRef(orderRef: number): string {
  return `#${String(orderRef).padStart(2, '0')}`;
}
