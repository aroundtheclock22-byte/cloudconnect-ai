'use client';
import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Icon } from '@/components/Icon';
import { ErrorNote, Field } from '@/components/ui';

export default function Login() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [f, setF] = useState({ email: '', password: '', orgName: '', firstName: '', lastName: '', mfaCode: '' });
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { me, reload } = useAuth();
  const router = useRouter();
  useEffect(() => { if (me) router.replace('/dashboard'); }, [me, router]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = mode === 'login'
        ? await api('/v1/auth/login', { body: { email: f.email, password: f.password, ...(mfa ? { mfaCode: f.mfaCode } : {}) } })
        : await api('/v1/auth/signup', { body: { email: f.email, password: f.password, orgName: f.orgName, firstName: f.firstName, lastName: f.lastName, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      if (r.mfaRequired) { setMfa(true); return; }
      setToken(r.accessToken);
      await reload();
      router.replace('/dashboard');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  const sso = async (p: string) => { try { const r = await api(`/v1/auth/oauth/${p}`); if (r.url) window.location.href = r.url; else setError(r.error); } catch (e) { setError((e as Error).message); } };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-700 via-brand-600 to-violet-700 p-12 text-white lg:flex lg:flex-col">
        <div className="flex items-center gap-2 text-lg font-semibold"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15"><Icon name="phone" /></span>CloudConnect AI</div>
        <div className="mt-auto max-w-md">
          <h2 className="text-4xl font-semibold leading-tight">Every call, text and meeting — one AI‑powered platform.</h2>
          <ul className="mt-8 space-y-3 text-white/85">
            {['Business numbers in 190+ countries', 'AI receptionist, summaries & coaching', 'HD voice, SMS, video & team chat', 'Enterprise security: SSO, MFA, audit logs'].map((t) => <li key={t} className="flex items-center gap-2"><Icon name="check" className="h-4 w-4" />{t}</li>)}
          </ul>
        </div>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4">
          <div>
            <h1 className="text-2xl font-semibold">{mode === 'login' ? 'Sign in' : 'Start your free trial'}</h1>
            <p className="mt-1 text-sm text-slate-500">{mode === 'login' ? 'Welcome back.' : '14 days free. No credit card required.'}</p>
          </div>
          {mode === 'signup' && (<>
            <Field label="Company name"><input className="input" required value={f.orgName} onChange={set('orgName')} /></Field>
            <div className="grid grid-cols-2 gap-3"><Field label="First name"><input className="input" required value={f.firstName} onChange={set('firstName')} /></Field><Field label="Last name"><input className="input" value={f.lastName} onChange={set('lastName')} /></Field></div>
          </>)}
          <Field label="Work email"><input className="input" type="email" autoComplete="email" required value={f.email} onChange={set('email')} /></Field>
          <Field label="Password"><input className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required value={f.password} onChange={set('password')} /></Field>
          {mfa && <Field label="Authentication code"><input className="input font-mono tracking-widest" inputMode="numeric" pattern="\d{6}" maxLength={6} autoFocus required value={f.mfaCode} onChange={set('mfaCode')} /></Field>}
          <ErrorNote error={error} />
          <button className="btn-primary w-full py-2.5" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? (mfa ? 'Verify' : 'Sign in') : 'Create account'}</button>
          <div className="relative py-2 text-center text-xs text-slate-400"><span className="bg-slate-50 px-2 dark:bg-slate-950">or continue with</span><div className="absolute inset-x-0 top-1/2 -z-10 border-t border-slate-200 dark:border-slate-800" /></div>
          <div className="grid grid-cols-3 gap-2">{['google', 'microsoft', 'apple'].map((p) => <button type="button" key={p} className="btn-outline capitalize" onClick={() => sso(p)}>{p}</button>)}</div>
          <p className="text-center text-sm text-slate-500">
            {mode === 'login' ? <>New to CloudConnect? <button type="button" className="font-medium text-brand-600" onClick={() => setMode('signup')}>Create an account</button></> : <>Already have an account? <button type="button" className="font-medium text-brand-600" onClick={() => setMode('login')}>Sign in</button></>}
          </p>
        </form>
      </div>
    </div>
  );
}
