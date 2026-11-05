'use client';
import { io, Socket } from 'socket.io-client';
import { getToken } from './api';

let socket: Socket | null = null;
export function realtime(): Socket | null {
  if (typeof window === 'undefined' || !getToken()) return null;
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:4000', { path: '/ws', auth: (cb) => cb({ token: getToken() }), transports: ['websocket'], reconnectionDelayMax: 10_000 });
  }
  return socket;
}
