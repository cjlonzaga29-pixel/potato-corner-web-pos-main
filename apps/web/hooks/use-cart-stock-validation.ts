import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CartAvailabilityCheckInput, CartAvailabilityResult } from '@potato-corner/shared';
import { cartLineKey, type PosCartItem } from '@/stores/cart.store';

export type CartStockStatus = 'idle' | 'checking' | 'unverified';

/** A line a shortfall took units back from, as it was just before. */
export interface TakenBackLine {
  item: PosCartItem;
  units: number;
}

/**
 * POS-PERF-P41R — the request has no timeout of its own, and Charge waits for
 * the answer, so one hung request (a stalled API, an exhausted pool) would hold
 * Charge forever. Past this it counts as unavailable, like a network error.
 */
export const STOCK_CHECK_TIMEOUT_MS = 10_000;

function quantitiesByKey(items: PosCartItem[]): Map<string, number> {
  return new Map(items.map((item) => [cartLineKey(item), item.quantity]));
}

/** Only a well-formed answer can confirm or take back units; anything else is treated as the check failing. */
function isAvailabilityResult(value: unknown): value is CartAvailabilityResult {
  if (typeof value !== 'object' || value === null) return false;
  const { ok, shortfalls } = value as { ok?: unknown; shortfalls?: unknown };
  if (typeof ok !== 'boolean' || !Array.isArray(shortfalls)) return false;
  if (!ok && shortfalls.length === 0) return false;
  return shortfalls.every((shortfall: unknown) => typeof shortfall === 'object' && shortfall !== null && typeof (shortfall as { item_name?: unknown }).item_name === 'string');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Stock check timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
  /** A shortfall for the current cart: `removed` unconfirmed units were already taken back out of it, `takenBack` says from which lines. */
  onShortfall: (itemNames: string[], removed: number, takenBack: TakenBackLine[]) => void;
  /** The check itself failed (network/API, timeout, malformed answer). The cart is kept as-is — the reservation at checkout is still the final guard. */
  onUnavailable: () => void;
  timeoutMs?: number;
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
export function useCartStockValidation({
  branchId,
  sessionKey,
  check,
  getItems,
  rollbackUnconfirmed,
  onShortfall,
  onUnavailable,
  timeoutMs = STOCK_CHECK_TIMEOUT_MS,
}: UseCartStockValidationOptions) {
  const unconfirmedRef = useRef(new Map<string, number>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<CartStockStatus>('idle');
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceRef = useRef(false);
  const epochRef = useRef(0);
  const disposedRef = useRef(false);
  const latest = useRef({ branchId, sessionKey, check, getItems, rollbackUnconfirmed, onShortfall, onUnavailable, timeoutMs });
  useLayoutEffect(() => {
    latest.current = { branchId, sessionKey, check, getItems, rollbackUnconfirmed, onShortfall, onUnavailable, timeoutMs };
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
      const answer: unknown = await withTimeout(latest.current.check({ branch_id: requestBranchId, lines: toAvailabilityLines(snapshot) }), latest.current.timeoutMs);
      result = isAvailabilityResult(answer) ? answer : null;
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
    // Whatever a callback does, the pending marks (and so Charge) must be released.
    try {
      if (!result) {
        setStatus('unverified');
        latest.current.onUnavailable();
      } else if (!result.ok) {
        const takenBack = snapshot.flatMap((item) => {
          const units = Math.min(unconfirmed[cartLineKey(item)] ?? 0, item.quantity);
          return units > 0 ? [{ item, units }] : [];
        });
        const removed = latest.current.rollbackUnconfirmed(unconfirmed);
        setStatus('idle');
        latest.current.onShortfall([...new Set(result.shortfalls.map((s) => s.item_name))], removed, takenBack);
      } else {
        setStatus('idle');
      }
    } finally {
      publish();
    }
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
