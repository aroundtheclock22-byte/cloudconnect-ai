'use client';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { refresh } from '@/lib/api';
export default function OAuthCallback() {
  const { reload } = useAuth();
  useEffect(() => { refresh().then(reload).then(() => { window.location.href = '/dashboard'; }); }, [reload]);
  return <p className="p-10 text-center text-sm text-slate-500">Signing you in…</p>;
}
