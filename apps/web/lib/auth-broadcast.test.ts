import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { broadcastLogout, subscribeToLogout } from './auth-broadcast';

const STORAGE_KEY = 'pc_auth_logout_at';

beforeEach(() => {
  window.localStorage.clear();
});

describe('broadcastLogout / subscribeToLogout (BroadcastChannel path)', () => {
  it('delivers a broadcastLogout() call to a subscribeToLogout listener', async () => {
    const onLogout = vi.fn();
    const unsubscribe = subscribeToLogout(onLogout);

    broadcastLogout();

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    unsubscribe();
  });

  it('stops delivering messages after unsubscribe', async () => {
    const onLogout = vi.fn();
    const unsubscribe = subscribeToLogout(onLogout);
    unsubscribe();

    broadcastLogout();

    // Give any (unwanted) async delivery a chance to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onLogout).not.toHaveBeenCalled();
  });
});

describe('broadcastLogout / subscribeToLogout (storage-event fallback)', () => {
  it('writes a localStorage key when BroadcastChannel is unavailable', () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    // @ts-expect-error simulating an older browser without BroadcastChannel
    delete globalThis.BroadcastChannel;
    try {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
      broadcastLogout();
      expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    } finally {
      globalThis.BroadcastChannel = originalBroadcastChannel;
    }
  });

  it('invokes the listener on a matching storage event but ignores unrelated keys', () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    // @ts-expect-error simulating an older browser without BroadcastChannel
    delete globalThis.BroadcastChannel;
    try {
      const onLogout = vi.fn();
      const unsubscribe = subscribeToLogout(onLogout);

      // Same-window localStorage writes never self-fire a 'storage' event —
      // that only happens in OTHER tabs/windows, which is exactly the
      // real-world delivery this synthetic event stands in for.
      window.dispatchEvent(new StorageEvent('storage', { key: 'something_else', newValue: 'x' }));
      expect(onLogout).not.toHaveBeenCalled();

      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: String(Date.now()) }));
      expect(onLogout).toHaveBeenCalledTimes(1);

      unsubscribe();
    } finally {
      globalThis.BroadcastChannel = originalBroadcastChannel;
    }
  });
});
