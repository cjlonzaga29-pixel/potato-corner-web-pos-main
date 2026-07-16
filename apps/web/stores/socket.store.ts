import { create } from 'zustand';

interface SocketState {
  isConnected: boolean;
  isReconnecting: boolean;
  setConnected: (isConnected: boolean) => void;
  setReconnecting: (isReconnecting: boolean) => void;
}

/**
 * Global Socket.io connection status — browser-only UI state (State
 * Management Separation rule), populated by useSocket()'s connection
 * lifecycle so any component (e.g. the supervisor dashboard's connection
 * dot) can read it without mounting its own socket listeners.
 */
export const useSocketStore = create<SocketState>((set) => ({
  isConnected: false,
  isReconnecting: false,
  setConnected: (isConnected) => set({ isConnected, isReconnecting: false }),
  setReconnecting: (isReconnecting) => set({ isReconnecting }),
}));
