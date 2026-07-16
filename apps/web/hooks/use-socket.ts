'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/stores/auth.store';
import { useSocketStore } from '@/stores/socket.store';

/**
 * Initializes the Socket.io connection for the current session. Room
 * assignment is handled server-side from JWT claims (see
 * apps/api/src/socket/socket.server.ts's joinRoomsForUser) — no client emit
 * needed. Disconnects when auth state clears (logout) and reconnects on the
 * next login.
 */
export function useSocket() {
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const setConnected = useSocketStore((state) => state.setConnected);
  const setReconnecting = useSocketStore((state) => state.setReconnecting);
  const isConnected = useSocketStore((state) => state.isConnected);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!accessToken || !user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      return;
    }

    const socket = getSocket(accessToken);
    socketRef.current = socket;

    function handleConnect() {
      setConnected(true);
    }

    function handleDisconnect() {
      setConnected(false);
    }

    function handleReconnectAttempt() {
      setReconnecting(true);
    }

    function handleReconnect() {
      setReconnecting(false);
    }

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    // Reconnection events live on the Manager in socket.io-client v4, not the Socket itself.
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.io.on('reconnect', handleReconnect);

    if (socket.connected) {
      handleConnect();
    } else {
      socket.connect();
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.io.off('reconnect', handleReconnect);
    };
  }, [accessToken, user, setConnected, setReconnecting]);

  const on = useCallback((event: string, handler: (...args: unknown[]) => void) => {
    socketRef.current?.on(event, handler);
  }, []);

  const off = useCallback((event: string, handler: (...args: unknown[]) => void) => {
    socketRef.current?.off(event, handler);
  }, []);

  const emit = useCallback((event: string, ...args: unknown[]) => {
    socketRef.current?.emit(event, ...args);
  }, []);

  return { isConnected, socket: socketRef.current, on, off, emit };
}
