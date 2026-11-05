'use client';
import clsx from 'clsx';
import { ReactNode } from 'react';
import { Icon } from './Icon';
import { initials } from '@/lib/format';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('card', className)}>
      {title && <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 dark:border-slate-800"><h2 className="text-sm font-semibold">{title}</h2>{action}</header>}
      <div className={title ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, icon, tone = 'brand' }: { label: string; value: ReactNode; hint?: ReactNode; icon: string; tone?: 'brand' | 'rose' | 'emerald' | 'amber' | 'violet' }) {
  const tones = { brand: 'bg-brand-50 text-brand-600 dark:bg-brand-900/40', rose: 'bg-rose-50 text-rose-600 dark:bg-rose-900/30', emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30', amber: 'bg-amber-50 text-amber-600 dark:bg-amber-900/30', violet: 'bg-violet-50 text-violet-600 dark:bg-violet-900/30' };
  return (
    <div className="card flex items-start gap-4 p-5">
      <div className={clsx('rounded-lg p-2.5', tones[tone])}><Icon name={icon} /></div>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}

const BADGE: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-900/30 dark:text-emerald-300', red: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-900/30 dark:text-rose-300',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-900/30 dark:text-amber-300', blue: 'bg-brand-50 text-brand-700 ring-brand-600/20 dark:bg-brand-900/30 dark:text-brand-300',
  gray: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300', violet: 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-900/30 dark:text-violet-300',
};
export function Badge({ children, color = 'gray' }: { children: ReactNode; color?: keyof typeof BADGE }) {
  return <span className={clsx('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', BADGE[color])}>{children}</span>;
}

export const PRESENCE_COLOR: Record<string, string> = { available: 'bg-emerald-500', on_call: 'bg-rose-500', busy: 'bg-rose-500', in_meeting: 'bg-violet-500', dnd: 'bg-rose-700', away: 'bg-amber-400', offline: 'bg-slate-300' };
export function Avatar({ name, presence, size = 'md' }: { name: string; presence?: string; size?: 'sm' | 'md' | 'lg' }) {
  const s = { sm: 'h-7 w-7 text-[10px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-sm' }[size];
  return (
    <span className="relative inline-flex shrink-0">
      <span className={clsx('inline-flex items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-violet-500 font-semibold text-white', s)}>{initials(name)}</span>
      {presence && <span className={clsx('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white dark:ring-slate-900', PRESENCE_COLOR[presence] ?? 'bg-slate-300')} title={presence} />}
    </span>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="rounded-full bg-slate-100 p-3 text-slate-400 dark:bg-slate-800"><Icon name={icon} className="h-6 w-6" /></div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 dark:border-slate-800">
          <h3 className="font-semibold">{title}</h3>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="label">{label}</span>{children}</label>;
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">{error}</p> : null;
}

export function Skeleton({ className }: { className?: string }) { return <div className={clsx('animate-pulse rounded bg-slate-200 dark:bg-slate-800', className)} />; }
