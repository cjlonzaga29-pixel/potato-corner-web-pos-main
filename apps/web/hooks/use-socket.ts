'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { ROLES } from '@potato-corner/shared';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/stores/auth.store';
import { useSocketStore } from '@/stores/socket.store';

/**
 * Initializes the Socket.io connection and joins the correct room(s) for
 * the current user's role (Architecture doc §3.5 room model): super_admin
 * joins 'admin', supervisor joins one room per assigned branch, staff
 * joins their single branch room. Disconnects when auth state clears
 * (logout) and reconnects on the next login.
 */
export function useSocket() {
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!accessToken || !user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setIsConnected(false);
      return;
    }

    const socket = getSocket(accessToken);
    socketRef.current = socket;

    function handleConnect() {
      setIsConnected(true);
      useSocketStore.getState().setConnected(true);
      if (!user) return;
      if (user.role === ROLES.SUPER_ADMIN) {
        socket.emit('join', 'admin');
      } else if (user.role === ROLES.SUPERVISOR) {
        user.branchIds.forEach((branchId) => socket.emit('join', branchId));
      } else {
        const [branchId] = user.branchIds;
        if (branchId) socket.emit('join', branchId);
      }
    }

    function handleDisconnect() {
      setIsConnected(false);
      useSocketStore.getState().setConnected(false);
    }

    function handleReconnectAttempt() {
      useSocketStore.getState().setReconnecting(true);
    }

    function handleReconnectFailed() {
      useSocketStore.getState().setReconnecting(false);
    }

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.io.on('reconnect_failed', handleReconnectFailed);

    if (socket.connected) {
      handleConnect();
    } else {
      socket.connect();
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.io.off('reconnect_failed', handleReconnectFailed);
    };
  }, [accessToken, user]);

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
