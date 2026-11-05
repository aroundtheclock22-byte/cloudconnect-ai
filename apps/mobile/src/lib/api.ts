/**
 * Mobile API client. Tokens live in the iOS Keychain / Android Keystore (expo-secure-store);
 * GET responses are cached for offline use and mutations are queued while offline.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

export const API_URL: string = (Constants.expoConfig?.extra as any)?.apiUrl ?? 'http://localhost:4000';
let access: string | null = null;

export async function saveSession(s: { accessToken: string; refreshToken: string }) {
  access = s.accessToken;
  await SecureStore.setItemAsync('refreshToken', s.refreshToken, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}
export async function clearSession() { access = null; await SecureStore.deleteItemAsync('refreshToken'); }
export const accessToken = () => access;

async function refresh(): Promise<boolean> {
  const rt = await SecureStore.getItemAsync('refreshToken');
  if (!rt) return false;
  const r = await fetch(`${API_URL}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
  if (!r.ok) { await clearSession(); return false; }
  await saveSession(await r.json());
  return true;
}
export const restoreSession = refresh;

const OUTBOX = 'cc:outbox';
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; offlineQueue?: boolean } = {}): Promise<T> {
  const method = opts.method ?? (opts.body ? 'POST' : 'GET');
  const online = (await NetInfo.fetch()).isConnected !== false;
  if (!online) {
    if (method === 'GET') { const c = await AsyncStorage.getItem(`cc:cache:${path}`); if (c) return JSON.parse(c); throw new Error('Offline'); }
    if (opts.offlineQueue) { const q = JSON.parse((await AsyncStorage.getItem(OUTBOX)) ?? '[]'); q.push({ path, method, body: opts.body }); await AsyncStorage.setItem(OUTBOX, JSON.stringify(q)); return { queued: true } as T; }
    throw new Error('Offline');
  }
  const go = () => fetch(`${API_URL}${path}`, { method, headers: { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let r = await go();
  if (r.status === 401 && (await refresh())) r = await go();
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
  const data = r.status === 204 ? undefined : await r.json();
  if (method === 'GET') AsyncStorage.setItem(`cc:cache:${path}`, JSON.stringify(data)).catch(() => undefined);
  return data as T;
}

/** Replays mutations queued while offline (e.g. SMS composed on the subway). */
export async function flushOutbox() {
  const q: any[] = JSON.parse((await AsyncStorage.getItem(OUTBOX)) ?? '[]');
  if (!q.length) return;
  const remaining = [];
  for (const m of q) { try { await api(m.path, { method: m.method, body: m.body }); } catch { remaining.push(m); } }
  await AsyncStorage.setItem(OUTBOX, JSON.stringify(remaining));
}
NetInfo.addEventListener((s) => { if (s.isConnected) flushOutbox().catch(() => undefined); });
