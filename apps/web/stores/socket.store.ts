import { create } from 'zustand';

interface SocketState {
  isConnected: boolean;
  isReconnecting: boolean;
  lastConnectedAt: Date | null;
  setConnected: (isConnected: boolean) => void;
  setReconnecting: (isReconnecting: boolean) => void;
}

/** Shared Socket.io connection status — pure state, no socket.io logic. The socket lifecycle itself lives in hooks/use-socket.ts. */
export const useSocketStore = create<SocketState>((set) => ({
  isConnected: false,
  isReconnecting: false,
  lastConnectedAt: null,
  setConnected: (isConnected) =>
    set({ isConnected, isReconnecting: false, ...(isConnected && { lastConnectedAt: new Date() }) }),
  setReconnecting: (isReconnecting) => set({ isReconnecting }),
}));
