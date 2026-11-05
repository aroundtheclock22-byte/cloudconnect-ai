'use client';
/** Browser API client: access token in memory, refresh token in an httpOnly cookie. */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export function setToken(t: string | null) { accessToken = t; }
export function getToken() { return accessToken; }

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) { super(message); }
}

export async function refresh(): Promise<boolean> {
  refreshing ??= fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(async (r) => { if (!r.ok) return false; setToken((await r.json()).accessToken); return true; })
    .catch(() => false)
    .finally(() => { setTimeout(() => (refreshing = null), 0); });
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const doFetch = () => fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), credentials: 'include',
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let res = await doFetch();
  if (res.status === 401 && !path.startsWith('/v1/auth/')) {
    if (await refresh()) res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = Array.isArray(body.message) ? body.message.join(', ') : body.message ?? res.statusText;
    throw new ApiError(res.status, msg, body);
  }
  if (res.status === 204) return undefined as T;
  if (opts.raw) return (await res.text()) as T;
  return res.json();
}
