'use client';
import { useState } from 'react';
import { Badge, Card, PageHeader, Skeleton, Stat } from '@/components/ui';
import { BarChart, Meter } from '@/components/charts';
import { useApi } from '@/lib/useApi';
import { fmtDuration, fmtMoney } from '@/lib/format';

const FLAG = (cc: string) => cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌐';

export default function Analytics() {
  const [days, setDays] = useState(14);
  const { data: c } = useApi<any>(`/v1/analytics/calls?days=${days}`, [days]);
  const { data: ai } = useApi<any>(`/v1/analytics/ai?days=${days}`, [days]);
  const { data: users } = useApi<any[]>(`/v1/analytics/users?days=${days}`, [days]);
  const { data: sms } = useApi<any[]>(`/v1/analytics/messaging?days=${days}`, [days]);
  const smsByDay = Object.values((sms ?? []).reduce((acc: any, r: any) => { acc[r.day] ??= { day: r.day, sent: 0, received: 0 }; acc[r.day].sent += r.sent; acc[r.day].received += r.received; return acc; }, {}));
  const maxHour = Math.max(1, ...(c?.hourly ?? []).map((h: any) => h.calls));
  return (
    <>
      <PageHeader title="Analytics" subtitle="Calls, queues, messaging, users, geography and AI insights." actions={
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">{[7, 14, 30, 90].map((d) => <button key={d} onClick={() => setDays(d)} className={`rounded-md px-3 py-1 text-sm ${days === d ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : ''}`}>{d}d</button>)}</div>} />
      {!c ? <Skeleton className="h-32" /> : (<>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Total calls" value={c.totals.total.toLocaleString()} hint={`${c.totals.inbound} in · ${c.totals.outbound} out`} icon="phone" />
          <Stat label="Answer rate" value={`${c.totals.answerRate}%`} hint={`${c.totals.missed} missed`} icon="check" tone="emerald" />
          <Stat label="Avg duration" value={fmtDuration(c.totals.avgDuration)} hint={`Speed to answer ${c.totals.avgSpeedToAnswer}s`} icon="calls" tone="violet" />
          <Stat label="Call spend" value={fmtMoney(c.totals.costCents)} hint={`${Math.round(c.totals.totalSeconds / 60).toLocaleString()} minutes`} icon="card" tone="amber" />
        </div>
        <div className="mt-6 grid gap-6 xl:grid-cols-3">
          <Card title="Daily calls" className="xl:col-span-2"><BarChart data={c.series} keys={['answered', 'missed']} colors={['#3b6cf6', '#fb7185']} label={(x) => new Date(x.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} /></Card>
          <Card title="Busiest hours">
            <div className="flex h-44 items-end gap-0.5">{Array.from({ length: 24 }, (_, h) => { const v = c.hourly.find((x: any) => x.hour === h)?.calls ?? 0; return <div key={h} title={`${h}:00 — ${v} calls`} className="flex-1 rounded-t bg-violet-400/80" style={{ height: `${(v / maxHour) * 100}%`, minHeight: 2 }} />; })}</div>
            <div className="mt-1 flex justify-between text-[10px] text-slate-400"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div>
          </Card>
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card title="Queue / routing performance">
            <table className="w-full"><thead><tr><th className="th pl-0">Destination</th><th className="th">Calls</th><th className="th">Answered</th><th className="th">Avg wait</th></tr></thead>
              <tbody>{c.queues.map((q: any) => <tr key={q.node} className="border-t border-slate-100 dark:border-slate-800"><td className="td pl-0 font-medium capitalize">{q.node}</td><td className="td">{q.calls}</td><td className="td"><div className="flex items-center gap-2"><span className="w-10">{Math.round((q.answered / q.calls) * 100)}%</span><div className="w-20"><Meter value={q.answered} max={q.calls} color="#10b981" /></div></div></td><td className="td">{q.avgWait}s</td></tr>)}</tbody></table>
          </Card>
          <Card title="Geographic report">
            <ul className="space-y-2.5">{c.byCountry.map((g: any) => <li key={g.country} className="flex items-center gap-3 text-sm"><span className="text-lg">{FLAG(g.country)}</span><span className="w-10 font-medium">{g.country}</span><div className="flex-1"><Meter value={g.calls} max={c.byCountry[0].calls} /></div><span className="w-12 text-right tabular-nums">{g.calls}</span><span className="w-16 text-right tabular-nums text-slate-500">{fmtMoney(g.costCents)}</span></li>)}</ul>
          </Card>
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Card title="SMS usage" className="lg:col-span-1">{smsByDay.length ? <BarChart data={smsByDay as any[]} keys={['sent', 'received']} colors={['#10b981', '#93b4fd']} height={150} label={(x) => new Date(x.day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} /> : <p className="text-sm text-slate-500">No SMS in this period.</p>}</Card>
          <Card title="AI: trending keywords" action={<Badge color="violet">AI</Badge>}><div className="flex flex-wrap gap-2">{ai?.keywords.map((k: any) => <span key={k.keyword} className="rounded-full bg-violet-50 px-2.5 py-1 text-xs text-violet-800 dark:bg-violet-900/30 dark:text-violet-200" style={{ fontSize: 11 + Math.min(k.n, 20) * 0.25 }}>{k.keyword} <span className="opacity-60">{k.n}</span></span>)}</div></Card>
          <Card title="AI: top coaching opportunities"><ul className="space-y-2 text-sm">{ai?.coaching.map((t: any) => <li key={t.tip} className="flex justify-between gap-3"><span>{t.tip}</span><Badge>{t.n}</Badge></li>)}</ul></Card>
        </div>
        <Card title="User activity" className="mt-6">
          <div className="overflow-x-auto"><table className="w-full"><thead><tr><th className="th pl-0">User</th><th className="th">Department</th><th className="th">Calls</th><th className="th">Talk time</th><th className="th">Messages</th><th className="th">AI score</th></tr></thead>
            <tbody>{users?.map((u) => <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800"><td className="td pl-0 font-medium">{u.name}</td><td className="td text-slate-500">{u.department ?? '—'}</td><td className="td">{u.calls}</td><td className="td">{fmtDuration(u.talkSeconds)}</td><td className="td">{u.messages}</td><td className="td">{u.avgScore || '—'}</td></tr>)}</tbody></table></div>
        </Card>
      </>)}
    </>
  );
}
