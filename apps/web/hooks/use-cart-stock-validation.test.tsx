import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { CartAvailabilityCheckInput, CartAvailabilityResult } from '@potato-corner/shared';
import { cartLineKey, useCartStore, type PosCartItem } from '@/stores/cart.store';
import { useCartStockValidation } from './use-cart-stock-validation';

// POS-PERF-P41 — the optimistic stock pre-check against the real cart store,
// with every availability answer released by hand so request order, overlap
// and out-of-order arrival are controlled exactly.

interface Deferred {
  resolve: (value: CartAvailabilityResult) => void;
  reject: (error: Error) => void;
}

const OK: CartAvailabilityResult = { ok: true, shortfalls: [] };
const SHORT: CartAvailabilityResult = { ok: false, shortfalls: [{ inventory_item_id: 'i-potato', item_name: 'Potato', available: 100, required: 400 }] };

const water: PosCartItem = { product_id: 'p-water', product_variant_id: 'v-water', quantity: 1 };
const friesSmall: PosCartItem = { product_id: 'p-fries', product_variant_id: 'v-fries-s', quantity: 1 };

function setup({ timeoutMs }: { timeoutMs?: number } = {}) {
  const calls: { input: CartAvailabilityCheckInput; answer: Deferred }[] = [];
  const check = vi.fn(
    (input: CartAvailabilityCheckInput) =>
      new Promise<CartAvailabilityResult>((resolve, reject) => {
        calls.push({ input, answer: { resolve, reject } });
      }),
  );
  const onShortfall = vi.fn();
  const onUnavailable = vi.fn();
  const hook = renderHook(
    ({ branchId, sessionKey }: { branchId: string; sessionKey: string }) =>
      useCartStockValidation({
        branchId,
        sessionKey,
        check,
        getItems: () => useCartStore.getState().items,
        rollbackUnconfirmed: (unconfirmed) => useCartStore.getState().rollbackUnconfirmed(unconfirmed),
        onShortfall,
        onUnavailable,
        timeoutMs,
      }),
    { initialProps: { branchId: 'branch-1', sessionKey: 'cashier-1' } },
  );
  return { hook, calls, check, onShortfall, onUnavailable };
}

type Hook = ReturnType<typeof setup>['hook'];

function tapAdd(hook: Hook, item: PosCartItem) {
  act(() => {
    useCartStore.getState().addItem(item);
    hook.result.current.noteIncrease(cartLineKey(item), item.quantity);
  });
}

function setQuantity(hook: Hook, item: PosCartItem, quantity: number) {
  act(() => {
    const index = useCartStore.getState().items.findIndex((line) => cartLineKey(line) === cartLineKey(item));
    const current = useCartStore.getState().items[index];
    if (!current) throw new Error('line not in cart');
    useCartStore.getState().updateItemQuantity(index, quantity);
    if (quantity <= 0) hook.result.current.noteRemoved(cartLineKey(current));
    else if (quantity > current.quantity) hook.result.current.noteIncrease(cartLineKey(current), quantity - current.quantity);
    else hook.result.current.noteDecrease(cartLineKey(current), current.quantity - quantity);
  });
}

/** Lets the scheduled (setTimeout 0) check start, or a settled answer's follow-up run. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Waits real time — for the per-check timeout, which tests set to a few ms. */
async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function answer(calls: ReturnType<typeof setup>['calls'], index: number, result: CartAvailabilityResult | Error) {
  await act(async () => {
    const call = calls[index];
    if (!call) throw new Error(`no request #${index}`);
    if (result instanceof Error) call.answer.reject(result);
    else call.answer.resolve(result);
  });
  await flush();
}

const quantityOf = (item: PosCartItem) => useCartStore.getState().items.find((line) => cartLineKey(line) === cartLineKey(item))?.quantity ?? 0;

beforeEach(() => {
  useCartStore.setState({ items: [], heldOrders: [] });
});

describe('useCartStockValidation', () => {
  it('applies every rapid tap at once and covers them with one follow-up request, not one per tap', async () => {
    const { hook, calls } = setup();
    tapAdd(hook, water);
    await flush();
    expect(calls).toHaveLength(1);
    expect(hook.result.current.status).toBe('checking');
    for (let i = 0; i < 4; i++) tapAdd(hook, water);
    await flush();
    // Every tap is already in the cart; nothing new is sent while one request is in flight.
    expect(quantityOf(water)).toBe(5);
    expect(calls).toHaveLength(1);
    expect(hook.result.current.pendingKeys.has(cartLineKey(water))).toBe(true);

    await answer(calls, 0, OK);
    // The answer was for quantity 1 — stale, so the cart as it is now (5) is checked once.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input.lines).toEqual([{ product_variant_id: 'v-water', quantity: 5 }]);
    await answer(calls, 1, OK);
    expect(quantityOf(water)).toBe(5);
    expect(hook.result.current.status).toBe('idle');
    expect(hook.result.current.pendingKeys.size).toBe(0);
    expect(hook.result.current.hasUnresolved()).toBe(false);
  });

  it('on a shortfall takes back only the unconfirmed units and leaves confirmed lines alone', async () => {
    const { hook, calls, onShortfall } = setup();
    tapAdd(hook, friesSmall);
    tapAdd(hook, friesSmall);
    await flush();
    await answer(calls, 0, OK);
    expect(quantityOf(friesSmall)).toBe(2);

    const friesLarge: PosCartItem = { product_id: 'p-fries', product_variant_id: 'v-fries-l', quantity: 1 };
    tapAdd(hook, friesLarge);
    setQuantity(hook, friesSmall, 3);
    await flush();
    // Shared ingredient: the whole cart is in the one request.
    expect(calls[1]?.input.lines).toEqual([
      { product_variant_id: 'v-fries-s', quantity: 3 },
      { product_variant_id: 'v-fries-l', quantity: 1 },
    ]);
    await answer(calls, 1, SHORT);
    expect(quantityOf(friesSmall)).toBe(2);
    expect(quantityOf(friesLarge)).toBe(0);
    // Names exactly what was taken back, per line, so the cashier can tell which additions were undone.
    expect(onShortfall).toHaveBeenCalledWith(['Potato'], 2, [
      { item: { ...friesSmall, quantity: 3 }, units: 1 },
      { item: friesLarge, units: 1 },
    ]);
    expect(hook.result.current.status).toBe('idle');
  });

  it('an OK for an older, smaller cart confirms what it covered, so a later shortfall takes back only the newer taps', async () => {
    const { hook, calls, onShortfall } = setup();
    tapAdd(hook, friesSmall);
    await flush();
    tapAdd(hook, friesSmall);
    tapAdd(hook, friesSmall);
    await answer(calls, 0, OK);
    expect(calls[1]?.input.lines).toEqual([{ product_variant_id: 'v-fries-s', quantity: 3 }]);
    await answer(calls, 1, SHORT);
    expect(quantityOf(friesSmall)).toBe(1);
    expect(onShortfall).toHaveBeenCalledWith(['Potato'], 2, [{ item: { ...friesSmall, quantity: 3 }, units: 2 }]);
  });

  it('ignores an out-of-order shortfall for an older cart and keeps the latest intent', async () => {
    const { hook, calls, onShortfall } = setup();
    tapAdd(hook, water);
    await flush();
    tapAdd(hook, water);
    await answer(calls, 0, SHORT);
    expect(onShortfall).not.toHaveBeenCalled();
    expect(quantityOf(water)).toBe(2);
    await answer(calls, 1, OK);
    expect(quantityOf(water)).toBe(2);
    expect(onShortfall).not.toHaveBeenCalled();
  });

  it('never resurrects a line removed while its check was pending', async () => {
    const { hook, calls, onShortfall } = setup();
    tapAdd(hook, water);
    await flush();
    setQuantity(hook, water, 0);
    await answer(calls, 0, SHORT);
    expect(useCartStore.getState().items).toEqual([]);
    expect(onShortfall).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(hook.result.current.status).toBe('idle');
  });

  it('a decrease cancels unconfirmed units first, so a later shortfall keeps the confirmed quantity', async () => {
    const { hook, calls } = setup();
    tapAdd(hook, { ...water, quantity: 3 });
    await flush();
    await answer(calls, 0, OK);
    setQuantity(hook, water, 4);
    setQuantity(hook, water, 5);
    setQuantity(hook, water, 4);
    await flush();
    await answer(calls, 1, SHORT);
    expect(quantityOf(water)).toBe(3);
  });

  it('discards an answer that lands after the cart was cleared', async () => {
    const { hook, calls, onShortfall } = setup();
    tapAdd(hook, water);
    await flush();
    act(() => useCartStore.getState().clearCart());
    tapAdd(hook, friesSmall);
    await answer(calls, 0, SHORT);
    expect(onShortfall).not.toHaveBeenCalled();
    expect(useCartStore.getState().items.map((line) => line.product_variant_id)).toEqual(['v-fries-s']);
    expect(calls[1]?.input.lines).toEqual([{ product_variant_id: 'v-fries-s', quantity: 1 }]);
  });

  it('never applies an answer across a cashier or branch switch, and re-checks under the new session', async () => {
    const { hook, calls, check, onShortfall } = setup();
    tapAdd(hook, water);
    await flush();
    hook.rerender({ branchId: 'branch-1', sessionKey: 'cashier-2' });
    await flush();
    await answer(calls, 0, SHORT);
    expect(onShortfall).not.toHaveBeenCalled();
    expect(quantityOf(water)).toBe(1);
    expect(check).toHaveBeenCalledTimes(2);

    hook.rerender({ branchId: 'branch-2', sessionKey: 'cashier-2' });
    await answer(calls, 1, SHORT);
    expect(onShortfall).not.toHaveBeenCalled();
    expect(calls[2]?.input.branch_id).toBe('branch-2');
    await answer(calls, 2, OK);
    expect(quantityOf(water)).toBe(1);
  });

  it('fails open on a network error, says so, and can be checked again', async () => {
    const { hook, calls, onUnavailable } = setup();
    tapAdd(hook, water);
    await flush();
    await answer(calls, 0, new Error('Failed to fetch'));
    expect(quantityOf(water)).toBe(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toBe('unverified');
    expect(hook.result.current.hasUnresolved()).toBe(false);

    act(() => hook.result.current.recheck());
    await flush();
    expect(calls).toHaveLength(2);
    await answer(calls, 1, OK);
    expect(hook.result.current.status).toBe('idle');
  });

  it('sends Mix & Max slots and add-on option ids for every line', async () => {
    const { hook, calls } = setup();
    const mixMax: PosCartItem = {
      product_id: 'p-mix',
      product_variant_id: 'v-mix',
      selected_flavors: [{ slot_index: 1, snack_product_variant_id: 'v-snack', flavor_id: 'f-cheese' }],
      quantity: 1,
    };
    const cheesy: PosCartItem = {
      product_id: 'p-cheesy',
      product_variant_id: 'v-cheesy',
      selected_options: [{ option_group_id: 'g', option_group_name: 'Add-ons', option_id: 'o-cheese', option_name: 'Extra Cheese', price_adjustment: 15 }],
      quantity: 2,
    };
    tapAdd(hook, mixMax);
    tapAdd(hook, cheesy);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      branch_id: 'branch-1',
      lines: [
        { product_variant_id: 'v-mix', selected_flavors: mixMax.selected_flavors, quantity: 1 },
        { product_variant_id: 'v-cheesy', selected_option_ids: ['o-cheese'], quantity: 2 },
      ],
    });
  });

  it('reports unresolved work synchronously until the answer for the current cart is applied', async () => {
    const { hook, calls } = setup();
    expect(hook.result.current.hasUnresolved()).toBe(false);
    tapAdd(hook, water);
    expect(hook.result.current.hasUnresolved()).toBe(true);
    await flush();
    expect(hook.result.current.hasUnresolved()).toBe(true);
    await answer(calls, 0, OK);
    expect(hook.result.current.hasUnresolved()).toBe(false);
  });

  // POS-PERF-P41R — failure modes of the check itself. Each one is advisory
  // (fail-open: the cart is kept and Charge comes back), never a shortfall.
  describe('when the check itself fails', () => {
    function expectFailedOpen(hook: Hook, onShortfall: ReturnType<typeof setup>['onShortfall']) {
      expect(hook.result.current.status).toBe('unverified');
      expect(hook.result.current.pendingKeys.size).toBe(0);
      expect(hook.result.current.hasUnresolved()).toBe(false);
      expect(onShortfall).not.toHaveBeenCalled();
    }

    it('times out a check that never answers, keeps the cart, and releases Charge', async () => {
      const { hook, calls, onShortfall, onUnavailable } = setup({ timeoutMs: 20 });
      tapAdd(hook, water);
      tapAdd(hook, water);
      await flush();
      expect(hook.result.current.hasUnresolved()).toBe(true);
      await wait(40);
      expect(calls).toHaveLength(1);
      expect(quantityOf(water)).toBe(2);
      expect(onUnavailable).toHaveBeenCalledTimes(1);
      expectFailedOpen(hook, onShortfall);
    });

    it('ignores the timed-out request when it finally answers, even after a retry is in flight', async () => {
      const { hook, calls, onShortfall } = setup({ timeoutMs: 20 });
      tapAdd(hook, water);
      await flush();
      await wait(40);
      act(() => hook.result.current.recheck());
      await flush();
      expect(calls).toHaveLength(2);
      expect(hook.result.current.status).toBe('checking');

      // The abandoned first request answers out of order — it must not take anything back.
      await answer(calls, 0, SHORT);
      expect(quantityOf(water)).toBe(1);
      expect(onShortfall).not.toHaveBeenCalled();
      expect(hook.result.current.status).toBe('checking');

      await answer(calls, 1, OK);
      expect(hook.result.current.status).toBe('idle');
      expect(hook.result.current.hasUnresolved()).toBe(false);
      expect(quantityOf(water)).toBe(1);
    });

    it.each([
      ['an empty object', {}],
      ['ok: false with no shortfall list', { ok: false }],
      ['ok: false with an empty shortfall list', { ok: false, shortfalls: [] }],
      ['a string', 'OK'],
      ['null', null],
    ])('treats a malformed answer (%s) as unavailable, not as a shortfall', async (_label, malformed) => {
      const { hook, calls, onShortfall, onUnavailable } = setup();
      tapAdd(hook, water);
      tapAdd(hook, friesSmall);
      await flush();
      await answer(calls, 0, malformed as unknown as CartAvailabilityResult);
      expect(quantityOf(water)).toBe(1);
      expect(quantityOf(friesSmall)).toBe(1);
      expect(onUnavailable).toHaveBeenCalledTimes(1);
      expectFailedOpen(hook, onShortfall);
    });

    it('treats an expired session (refresh failed, the request rejects) as unavailable and recovers on retry', async () => {
      const { hook, calls, onShortfall, onUnavailable } = setup();
      tapAdd(hook, water);
      await flush();
      await answer(calls, 0, new Error('Your session has expired. Please sign in again.'));
      expect(quantityOf(water)).toBe(1);
      expect(onUnavailable).toHaveBeenCalledTimes(1);
      expectFailedOpen(hook, onShortfall);

      act(() => hook.result.current.recheck());
      await flush();
      expect(hook.result.current.hasUnresolved()).toBe(true);
      await answer(calls, 1, SHORT);
      // A forced re-check with nothing unconfirmed never takes anything back: the
      // lines were already in the cart, so a shortfall is reported, not undone.
      expect(quantityOf(water)).toBe(1);
      expect(onShortfall).toHaveBeenCalledWith(['Potato'], 0, []);
      expect(hook.result.current.status).toBe('idle');
      expect(hook.result.current.hasUnresolved()).toBe(false);
    });
  });

  it('interleaved + and − while a check is pending end at the exact intended quantity and payload', async () => {
    const { hook, calls, onShortfall } = setup();
    tapAdd(hook, water);
    await flush();
    setQuantity(hook, water, 2);
    setQuantity(hook, water, 3);
    setQuantity(hook, water, 2);
    setQuantity(hook, water, 3);
    await flush();
    expect(calls).toHaveLength(1);
    expect(quantityOf(water)).toBe(3);

    await answer(calls, 0, OK);
    expect(calls[1]?.input.lines).toEqual([{ product_variant_id: 'v-water', quantity: 3 }]);
    await answer(calls, 1, SHORT);
    // The OK covered 1; the 2 units added after it are the only ones taken back.
    expect(quantityOf(water)).toBe(1);
    expect(onShortfall).toHaveBeenCalledWith(['Potato'], 2, [{ item: { ...water, quantity: 3 }, units: 2 }]);
    expect(hook.result.current.hasUnresolved()).toBe(false);
  });

  it('a late OK never resurrects a line removed and re-added smaller in the meantime', async () => {
    const { hook, calls } = setup();
    tapAdd(hook, { ...water, quantity: 3 });
    await flush();
    setQuantity(hook, water, 0);
    tapAdd(hook, water);
    await answer(calls, 0, OK);
    // An OK for 3 also covers 1, so nothing is left to check and nothing is raised back to 3.
    expect(quantityOf(water)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(hook.result.current.hasUnresolved()).toBe(false);
  });
});
