'use client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, refresh, setToken } from './api';

export interface Me { id: string; email: string; firstName: string; lastName: string; role: string; extension?: string; presence: string; mfaEnabled: boolean;
  organization: { id: string; name: string; timezone: string; currency: string; plan_id: string; subscription_status: string } }

const Ctx = createContext<{ me: Me | null; loading: boolean; reload: () => Promise<void>; logout: () => Promise<void>; can: (...roles: string[]) => boolean }>(null as any);

export const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'ADMINISTRATOR'];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const path = usePathname();

  const reload = useCallback(async () => {
    try { setMe(await api<Me>('/v1/auth/me')); } catch { setMe(null); }
  }, []);

  useEffect(() => {
    (async () => {
      if (await refresh()) await reload();
      setLoading(false);
    })();
  }, [reload]);

  useEffect(() => {
    if (!loading && !me && !path.startsWith('/login') && !path.startsWith('/meet')) router.replace('/login');
  }, [loading, me, path, router]);

  const logout = async () => { await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined); setToken(null); setMe(null); router.replace('/login'); };
  const can = (...roles: string[]) => !!me && (roles.includes(me.role) || me.role === 'SUPER_ADMIN');
  return <Ctx.Provider value={{ me, loading, reload, logout, can }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
