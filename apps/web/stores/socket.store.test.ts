import { describe, it, expect, beforeEach } from 'vitest';
import { useSocketStore } from './socket.store';

beforeEach(() => {
  useSocketStore.setState({ isConnected: false, isReconnecting: false, lastConnectedAt: null });
});

describe('useSocketStore', () => {
  it('starts disconnected with no last-connected timestamp', () => {
    const state = useSocketStore.getState();
    expect(state.isConnected).toBe(false);
    expect(state.isReconnecting).toBe(false);
    expect(state.lastConnectedAt).toBeNull();
  });

  it('setConnected(true) flips isConnected', () => {
    useSocketStore.getState().setConnected(true);
    expect(useSocketStore.getState().isConnected).toBe(true);
  });

  it('setConnected(false) flips isConnected back', () => {
    useSocketStore.getState().setConnected(true);
    useSocketStore.getState().setConnected(false);
    expect(useSocketStore.getState().isConnected).toBe(false);
  });

  it('setReconnecting(true) flips isReconnecting', () => {
    useSocketStore.getState().setReconnecting(true);
    expect(useSocketStore.getState().isReconnecting).toBe(true);
  });

  it('setReconnecting(false) flips isReconnecting back', () => {
    useSocketStore.getState().setReconnecting(true);
    useSocketStore.getState().setReconnecting(false);
    expect(useSocketStore.getState().isReconnecting).toBe(false);
  });
});
