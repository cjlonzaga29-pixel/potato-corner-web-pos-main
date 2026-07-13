import { io, type Socket } from 'socket.io-client';
import { SOCKET_URL } from './constants';

let socket: Socket | null = null;

/** Singleton Socket.io client. Connect lazily, once, after authentication. */
export function getSocket(accessToken: string): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      auth: { token: Buffer.from(JSON.stringify({ accessToken })).toString('base64') },
      autoConnect: false,
    });
  }
  return socket;
}
