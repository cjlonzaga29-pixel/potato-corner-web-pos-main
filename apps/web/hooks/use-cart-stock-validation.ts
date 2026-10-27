import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CartAvailabilityCheckInput, CartAvailabilityResult } from '@potato-corner/shared';
import { cartLineKey, type PosCartItem } from '@/stores/cart.store';

export type CartStockStatus = 'idle' | 'checking' | 'unverified';

function quantitiesByKey(items: PosCartItem[]): Map<string, number> {
  return new Map(items.map((item) => [cartLineKey(item), item.quantity]));
}

/** The whole cart as the availability check reads it — add-on options included, since checkout deducts their mapped ingredients too. */
export function toAvailabilityLines(items: PosCartItem[]): CartAvailabilityCheckInput['lines'] {
  return items.map((item) => ({
    product_variant_id: item.product_variant_id,
    flavor_id: item.flavor_id ?? undefined,
    selected_flavors: item.selected_flavors,
    ...(item.selected_options && item.selected_options.length > 0 ? { selected_option_ids: item.selected_options.map((option) => option.option_id) } : {}),
    quantity: item.quantity,
  }));
}

interface UseCartStockValidationOptions {
  branchId: string | null | undefined;
  /** Whoever is selling right now (cashier/employee id). A result checked under another session is never applied. */
  sessionKey: string | null;
  check: (input: CartAvailabilityCheckInput) => Promise<CartAvailabilityResult>;
  /** The cart as it is right now (not a render's snapshot) — an answer only counts while this still returns the array it was asked about. */
  getItems: () => PosCartItem[];
  /** Takes the given unconfirmed units back out of the cart, by cartLineKey; returns how many were removed. */
  rollbackUnconfirmed: (unconfirmed: Record<string, number>) => number;
  /** A shortfall for the current cart: `removed` unconfirmed units were already taken back out of it. */
  onShortfall: (itemNames: string[], removed: number) => void;
  /** The check itself failed (network/API). The cart is kept as-is — the reservation at checkout is still the final guard. */
  onUnavailable: () => void;
}

/**
 * POS-PERF-P41 — optimistic cart stock pre-check.
 *
 * A tap changes the cart immediately and records how many units of that line
 * aren't confirmed yet (noteIncrease). One whole-cart check runs at a time;
 * taps made while it is in flight are covered by a single re-check of the
 * cart as it is when the answer lands, never by one request per tap. An
 * answer only counts for the exact cart, branch and cashier it was asked
 * about — anything else (a newer edit, a cleared or held cart, a branch or
 * cashier switch) discards it and, if units are still unconfirmed, checks
 * again. An OK for an older cart still confirms what that cart contained
 * (any quantity at or below it fits), so only units added after it stay
 * unconfirmed.
 *
 * On a shortfall only the unconfirmed units are taken back. Decreases and
 * removals reduce what's unconfirmed first, so a rollback can never re-add a
 * removed line or undo a newer decrease. A failed check keeps the cart
 * (fail-open, same as before P41) and reports itself as unverified until a
 * later check succeeds — checkout's atomic reservation stays the real guard.
 */
export function useCartStockValidation({ branchId, sessionKey, check, getItems, rollbackUnconfirmed, onShortfall, onUnavailable }: UseCartStockValidationOptions) {
  const unconfirmedRef = useRef(new Map<string, number>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<CartStockStatus>('idle');
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceRef = useRef(false);
  const epochRef = useRef(0);
  const disposedRef = useRef(false);
  const latest = useRef({ branchId, sessionKey, check, getItems, rollbackUnconfirmed, onShortfall, onUnavailable });
  useLayoutEffect(() => {
    latest.current = { branchId, sessionKey, check, getItems, rollbackUnconfirmed, onShortfall, onUnavailable };
  });

  const publish = useCallback(() => setPendingKeys(new Set(unconfirmedRef.current.keys())), []);

  const runRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback(() => {
    setStatus('checking');
    if (disposedRef.current || inFlightRef.current || timerRef.current) return;
    // Next macrotask, so every tap handled in this same event loop turn is in one request.
    timerRef.current = setTimeout(() => void runRef.current(), 0);
  }, []);

  useLayoutEffect(() => {
    runRef.current = run;
  });
  const run = async () => {
    timerRef.current = null;
    if (inFlightRef.current) return;
    const { branchId: requestBranchId, sessionKey: requestSessionKey } = latest.current;
    const snapshot = latest.current.getItems();
    const force = forceRef.current;
    forceRef.current = false;
    if (!requestBranchId || snapshot.length === 0 || (unconfirmedRef.current.size === 0 && !force)) {
      unconfirmedRef.current.clear();
      publish();
      setStatus((current) => (current === 'checking' ? 'idle' : current));
      return;
    }
    const epoch = epochRef.current;
    inFlightRef.current = true;
    let result: CartAvailabilityResult | null = null;
    try {
      result = await latest.current.check({ branch_id: requestBranchId, lines: toAvailabilityLines(snapshot) });
    } catch {
      result = null;
    } finally {
      inFlightRef.current = false;
    }
    const stale =
      epoch !== epochRef.current ||
      latest.current.branchId !== requestBranchId ||
      latest.current.sessionKey !== requestSessionKey ||
      latest.current.getItems() !== snapshot;
    if (stale) {
      const sameSession = epoch === epochRef.current && latest.current.branchId === requestBranchId && latest.current.sessionKey === requestSessionKey;
      if (sameSession && result?.ok) {
        const sent = quantitiesByKey(snapshot);
        const now = quantitiesByKey(latest.current.getItems());
        for (const [key, units] of unconfirmedRef.current) {
          const stillUnconfirmed = Math.min(units, Math.max(0, (now.get(key) ?? 0) - (sent.get(key) ?? 0)));
          if (stillUnconfirmed > 0) unconfirmedRef.current.set(key, stillUnconfirmed);
          else unconfirmedRef.current.delete(key);
        }
        publish();
      }
      if (force) forceRef.current = true;
      schedule();
      return;
    }
    const unconfirmed = Object.fromEntries(unconfirmedRef.current);
    unconfirmedRef.current.clear();
    if (!result) {
      setStatus('unverified');
      latest.current.onUnavailable();
    } else if (!result.ok) {
      const removed = latest.current.rollbackUnconfirmed(unconfirmed);
      setStatus('idle');
      latest.current.onShortfall([...new Set(result.shortfalls.map((s) => s.item_name))], removed);
    } else {
      setStatus('idle');
    }
    publish();
  };

  const noteIncrease = useCallback(
    (key: string, units: number) => {
      if (units <= 0) return;
      unconfirmedRef.current.set(key, (unconfirmedRef.current.get(key) ?? 0) + units);
      publish();
      schedule();
    },
    [publish, schedule],
  );

  const noteDecrease = useCallback(
    (key: string, units: number) => {
      const current = unconfirmedRef.current.get(key);
      if (current === undefined) return;
      if (current - units > 0) unconfirmedRef.current.set(key, current - units);
      else unconfirmedRef.current.delete(key);
      publish();
    },
    [publish],
  );

  const noteRemoved = useCallback(
    (key: string) => {
      if (!unconfirmedRef.current.delete(key)) return;
      publish();
    },
    [publish],
  );

  /** Re-check the cart as it is (e.g. after an unverified result), even with nothing unconfirmed. */
  const recheck = useCallback(() => {
    forceRef.current = true;
    schedule();
  }, [schedule]);

  // A branch or cashier switch invalidates whatever is in flight; anything still unconfirmed is checked again under the new session.
  const sessionRef = useRef({ branchId, sessionKey });
  useEffect(() => {
    if (sessionRef.current.branchId === branchId && sessionRef.current.sessionKey === sessionKey) return;
    sessionRef.current = { branchId, sessionKey };
    epochRef.current += 1;
    if (unconfirmedRef.current.size > 0) schedule();
  }, [branchId, sessionKey, schedule]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      epochRef.current += 1;
    };
  }, []);

  /** Synchronous — for the Charge guard, which can't wait for a re-render. */
  const hasUnresolved = useCallback(() => unconfirmedRef.current.size > 0 || inFlightRef.current || timerRef.current !== null, []);

  return { status, pendingKeys, noteIncrease, noteDecrease, noteRemoved, recheck, hasUnresolved };
}
