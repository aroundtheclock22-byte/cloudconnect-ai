'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useState } from 'react';
import { ADMIN_ROLES, useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { Icon } from './Icon';
import { Avatar, PRESENCE_COLOR } from './ui';
import { SoftphoneProvider, useSoftphone } from './Softphone';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { href: '/calls', label: 'Calls', icon: 'phone' },
  { href: '/messages', label: 'Messages', icon: 'message' },
  { href: '/voicemail', label: 'Voicemail', icon: 'voicemail' },
  { href: '/contacts', label: 'Contacts', icon: 'contacts' },
  { href: '/meetings', label: 'Meetings', icon: 'video' },
  { href: '/analytics', label: 'Analytics', icon: 'chart', roles: [...ADMIN_ROLES, 'MANAGER', 'SUPERVISOR', 'BILLING_ADMIN'] },
];
const ADMIN = [
  { href: '/admin/users', label: 'Users & teams', icon: 'users' },
  { href: '/admin/numbers', label: 'Phone numbers', icon: 'hash' },
  { href: '/admin/routing', label: 'Call routing & IVR', icon: 'flow' },
  { href: '/admin/billing', label: 'Billing', icon: 'card', roles: ['COMPANY_OWNER', 'BILLING_ADMIN'] },
  { href: '/admin/security', label: 'Security & audit', icon: 'shield' },
  { href: '/admin/integrations', label: 'Integrations & API', icon: 'plug' },
];
const PRESENCES = ['available', 'busy', 'in_meeting', 'away', 'dnd'];

export function Shell({ children }: { children: ReactNode }) {
  return <SoftphoneProvider><Frame>{children}</Frame></SoftphoneProvider>;
}

function Frame({ children }: { children: ReactNode }) {
  const { me, logout, can } = useAuth();
  const path = usePathname();
  const phone = useSoftphone();
  const [presence, setPresence] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  if (!me) return <div className="flex h-screen items-center justify-center text-sm text-slate-500">Loading…</div>;
  const current = presence ?? me.presence;
  const isAdmin = can(...ADMIN_ROLES, 'BILLING_ADMIN');

  const link = (n: { href: string; label: string; icon: string }) => (
    <Link key={n.href} href={n.href} onClick={() => setMobileNav(false)} className={clsx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', path.startsWith(n.href) ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800')}>
      <Icon name={n.icon} className="h-[18px] w-[18px]" />{n.label}
    </Link>
  );

  return (
    <div className="flex min-h-screen">
      <aside className={clsx('fixed inset-y-0 left-0 z-30 w-64 flex-col border-r border-slate-200 bg-white px-3 py-4 dark:border-slate-800 dark:bg-slate-900 lg:flex', mobileNav ? 'flex' : 'hidden')}>
        <Link href="/dashboard" className="mb-6 flex items-center gap-2 px-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-600 to-violet-600 text-white"><Icon name="phone" className="h-4 w-4" /></span>
          <span className="font-semibold tracking-tight">CloudConnect <span className="text-brand-600">AI</span></span>
        </Link>
        <nav className="space-y-0.5">{NAV.filter((n) => !n.roles || can(...n.roles)).map(link)}</nav>
        {isAdmin && (<>
          <p className="mb-1 mt-6 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Admin</p>
          <nav className="space-y-0.5">{ADMIN.filter((n) => can(...(n.roles ?? ADMIN_ROLES))).map(link)}</nav>
        </>)}
        <div className="mt-auto rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
          <p className="font-medium">{me.organization.name}</p>
          <p className="mt-0.5 capitalize text-slate-500">{me.organization.plan_id} plan · {me.organization.subscription_status}</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 sm:px-6">
          <button className="btn-ghost p-2 lg:hidden" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation"><Icon name="menu" /></button>
          <div className="relative hidden max-w-md flex-1 sm:block">
            <Icon name="search" className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input className="input pl-9" placeholder="Search contacts, calls, messages…" aria-label="Search" onKeyDown={(e) => { if (e.key === 'Enter') window.location.href = `/contacts?q=${encodeURIComponent((e.target as HTMLInputElement).value)}`; }} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button className="btn-primary bg-emerald-600 hover:bg-emerald-700" onClick={() => phone.setOpen(!phone.open)}><Icon name="keypad" className="h-4 w-4" /><span className="hidden sm:inline">Dial</span></button>
            <div className="relative">
              <button className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setMenu(!menu)} aria-label="Account menu">
                <Avatar name={`${me.firstName} ${me.lastName}`} presence={current} size="sm" />
                <span className="hidden text-left text-sm leading-tight md:block"><span className="block font-medium">{me.firstName} {me.lastName}</span><span className="block text-xs text-slate-500">Ext. {me.extension}</span></span>
              </button>
              {menu && (
                <div className="card absolute right-0 mt-2 w-56 p-1.5 shadow-lg">
                  <p className="px-2.5 py-1.5 text-xs font-medium text-slate-500">Set status</p>
                  {PRESENCES.map((p) => (
                    <button key={p} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm capitalize hover:bg-slate-100 dark:hover:bg-slate-800" onClick={async () => { await api('/v1/me/presence', { method: 'PUT', body: { status: p } }); setPresence(p); setMenu(false); }}>
                      <span className={clsx('h-2.5 w-2.5 rounded-full', PRESENCE_COLOR[p])} />{p.replace('_', ' ')}{current === p && <Icon name="check" className="ml-auto h-4 w-4 text-brand-600" />}
                    </button>
                  ))}
                  <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
                  <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20" onClick={logout}><Icon name="logout" className="h-4 w-4" />Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
