'use client';
import { useState } from 'react';
import { Badge, Card, ErrorNote, PageHeader, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { fmtMoney } from '@/lib/format';

export default function Billing() {
  const { data: sub, reload } = useApi<any>('/v1/billing/subscription');
  const { data: preview, reload: reloadPreview } = useApi<any>('/v1/billing/invoice-preview');
  const { data: plans } = useApi<any[]>('/v1/billing/plans');
  const { data: invoices } = useApi<any[]>('/v1/billing/invoices');
  const { data: rates } = useApi<any[]>('/v1/billing/rates');
  const [interval, setInterval] = useState<'month' | 'year'>('year');
  const [seats, setSeats] = useState<number | ''>('');
  const [coupon, setCoupon] = useState('');
  const [error, setError] = useState<string | null>(null);
  const choose = async (planId: string) => {
    setError(null);
    try {
      const r = await api('/v1/billing/checkout', { body: { planId, interval, seats: Number(seats || sub?.seats || 1), coupon: coupon || undefined } });
      if (r.url) window.location.href = r.url; else { reload(); reloadPreview(); }
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <>
      <PageHeader title="Billing" subtitle="Plans, usage, invoices and international rates." actions={<button className="btn-outline" onClick={() => api('/v1/billing/portal', { body: {} }).then((r) => (window.location.href = r.url)).catch((e) => setError(e.message))}>Manage payment methods</button>} />
      <ErrorNote error={error} />
      {sub && preview && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Current plan" value={<span className="capitalize">{sub.planId}</span>} hint={<><Badge color={sub.status === 'active' ? 'green' : 'amber'}>{sub.status}</Badge> billed {sub.interval}ly</>} icon="card" />
          <Stat label="Seats" value={`${sub.activeUsers} / ${sub.seats}`} hint="active users / licensed" icon="users" tone="violet" />
          <Stat label="Estimated next invoice" value={fmtMoney(preview.totalCents, preview.currency)} hint={`Period ends ${new Date(preview.periodEnd).toLocaleDateString()}`} icon="chart" tone="emerald" />
        </div>
      )}
      {preview && (
        <Card title="Current period" className="mt-6">
          <table className="w-full text-sm"><tbody>
            {preview.lines.map((l: any) => <tr key={l.description} className="border-b border-slate-100 dark:border-slate-800"><td className="py-2">{l.description}</td><td className="py-2 text-right tabular-nums text-slate-500">{l.quantity.toLocaleString()} × {fmtMoney(l.unitCents)}</td><td className="w-28 py-2 text-right tabular-nums">{fmtMoney(l.amountCents)}</td></tr>)}
            {preview.discountCents > 0 && <tr><td className="py-2 text-emerald-600">Discount</td><td /><td className="py-2 text-right text-emerald-600">−{fmtMoney(preview.discountCents)}</td></tr>}
            <tr><td className="py-2">Tax</td><td /><td className="py-2 text-right tabular-nums">{fmtMoney(preview.taxCents)}</td></tr>
            <tr className="font-semibold"><td className="py-2">Total</td><td /><td className="py-2 text-right tabular-nums">{fmtMoney(preview.totalCents)}</td></tr>
          </tbody></table>
        </Card>
      )}
      <div className="mb-4 mt-8 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Plans</h2>
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">{(['month', 'year'] as const).map((i) => <button key={i} onClick={() => setInterval(i)} className={`rounded-md px-3 py-1 text-sm ${interval === i ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : ''}`}>{i === 'month' ? 'Monthly' : 'Annual (save ~20%)'}</button>)}</div>
        <input className="input w-24" type="number" min={1} placeholder="Seats" value={seats} onChange={(e) => setSeats(e.target.value ? Number(e.target.value) : '')} aria-label="Seats" />
        <input className="input w-36" placeholder="Coupon code" value={coupon} onChange={(e) => setCoupon(e.target.value)} aria-label="Coupon code" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {plans?.map((p) => (
          <div key={p.id} className={`card flex flex-col p-5 ${sub?.planId === p.id ? 'ring-2 ring-brand-500' : ''}`}>
            <p className="font-semibold">{p.name}</p>
            <p className="mt-2 text-3xl font-semibold">{fmtMoney(interval === 'year' ? p.annualPerUserCents : p.monthlyPerUserCents)}<span className="text-sm font-normal text-slate-500">/user/mo</span></p>
            <ul className="mt-4 flex-1 space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
              <li>{p.includedMinutesPerUser.toLocaleString()} domestic min/user</li><li>{p.includedSmsPerUser.toLocaleString()} SMS/user</li><li>Meetings up to {p.maxMeetingParticipants}</li>
              <li className="text-xs text-slate-500">{p.features.includes('*') ? (p.features.includes('-sso') ? 'Everything except SSO & HIPAA' : 'Everything incl. SSO, HIPAA, SLA') : p.features.map((f: string) => f.replace(/_/g, ' ')).join(' · ')}</li>
            </ul>
            <button className={sub?.planId === p.id ? 'btn-outline mt-4' : 'btn-primary mt-4'} onClick={() => choose(p.id)}>{sub?.planId === p.id ? 'Update' : 'Choose'}</button>
          </div>))}
      </div>
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card title="Invoices">{invoices?.length ? <ul className="space-y-2 text-sm">{invoices.map((i) => <li key={i.id} className="flex justify-between"><span>{i.number} · {new Date(i.createdAt).toLocaleDateString()}</span><span className="flex gap-3">{fmtMoney(i.totalCents, i.currency)}<Badge color={i.status === 'paid' ? 'green' : 'amber'}>{i.status}</Badge></span></li>)}</ul> : <p className="text-sm text-slate-500">No invoices yet.</p>}</Card>
        <Card title="International rates (per minute)"><div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">{rates?.map((r) => <div key={r.prefix} className="flex justify-between"><span>{r.country} <span className="text-xs text-slate-400">+{r.prefix}</span></span><span className="tabular-nums">{r.perMinuteCents ? `${r.perMinuteCents}¢` : 'Included'}</span></div>)}</div></Card>
      </div>
    </>
  );
}
