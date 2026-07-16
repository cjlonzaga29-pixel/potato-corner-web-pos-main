import { describe, it, expect, beforeEach } from 'vitest';
import { useSocketStore } from './socket.store';

beforeEach(() => {
  useSocketStore.setState({ isConnected: false, isReconnecting: false });
});

describe('useSocketStore', () => {
  it('starts disconnected and not reconnecting', () => {
    const state = useSocketStore.getState();
    expect(state.isConnected).toBe(false);
    expect(state.isReconnecting).toBe(false);
  });

  it('setConnected(true) marks connected and clears reconnecting', () => {
    useSocketStore.getState().setReconnecting(true);
    useSocketStore.getState().setConnected(true);
    const state = useSocketStore.getState();
    expect(state.isConnected).toBe(true);
    expect(state.isReconnecting).toBe(false);
  });

  it('setConnected(false) marks disconnected', () => {
    useSocketStore.getState().setConnected(true);
    useSocketStore.getState().setConnected(false);
    expect(useSocketStore.getState().isConnected).toBe(false);
  });

  it('setReconnecting(true) marks reconnecting without touching isConnected', () => {
    useSocketStore.getState().setReconnecting(true);
    const state = useSocketStore.getState();
    expect(state.isReconnecting).toBe(true);
    expect(state.isConnected).toBe(false);
  });
});
