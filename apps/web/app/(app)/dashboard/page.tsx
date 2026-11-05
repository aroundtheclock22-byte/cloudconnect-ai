'use client';
import { Badge, Card, PageHeader, Skeleton, Stat } from '@/components/ui';
import { BarChart, Donut, Meter } from '@/components/charts';
import { useApi } from '@/lib/useApi';
import { useAuth } from '@/lib/auth';
import { fmtDuration, fmtMoney } from '@/lib/format';
import { useEffect } from 'react';

export default function Dashboard() {
  const { me } = useAuth();
  const { data: d, reload } = useApi<any>('/v1/analytics/dashboard');
  const { data: calls } = useApi<any>('/v1/analytics/calls?days=14');
  useEffect(() => { const t = setInterval(reload, 15_000); return () => clearInterval(t); }, [reload]); // live refresh
  const hour = new Date().getHours();
  return (
    <>
      <PageHeader title={`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${me?.firstName}`} subtitle="Here's what's happening across your phone system today." actions={<Badge color="green">● Live</Badge>} />
      {!d ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div> : (<>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Active calls" value={d.live.activeCalls} hint={`${d.live.ringing} ringing · ${d.users.onCall} agents on call`} icon="phone" />
          <Stat label="Missed today" value={d.today.missed} hint={`${d.today.answerRate}% answer rate`} icon="missed" tone="rose" />
          <Stat label="SMS today" value={d.sms.sent + d.sms.received} hint={`${d.sms.sent} sent · ${d.sms.received} received`} icon="message" tone="emerald" />
          <Stat label={d.revenue ? 'Usage this month' : 'Avg call'} value={d.revenue ? fmtMoney(d.revenue.usageCents) : fmtDuration(d.today.avgDuration)} hint={`${d.today.total} calls today`} icon={d.revenue ? 'card' : 'calls'} tone="amber" />
        </div>
        <div className="mt-6 grid gap-6 xl:grid-cols-3">
          <Card title="Call volume (14 days)" className="xl:col-span-2" action={<div className="flex gap-3 text-xs text-slate-500"><span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand-500" />Answered</span><span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-rose-400" />Missed</span></div>}>
            {calls ? <BarChart data={calls.series} keys={['answered', 'missed']} colors={['#3b6cf6', '#fb7185']} label={(x) => new Date(x.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} /> : <Skeleton className="h-52" />}
          </Card>
          <Card title="AI insights (7 days)" action={<Badge color="violet">AI</Badge>}>
            <Donut segments={[{ label: 'Positive', value: d.ai.positive, color: '#10b981' }, { label: 'Negative', value: d.ai.negative, color: '#f43f5e' }, { label: 'Neutral / mixed', value: Math.max(0, d.ai.analyzed - d.ai.positive - d.ai.negative), color: '#94a3b8' }]} />
            <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60"><p className="text-xs text-slate-500">Avg call score</p><p className="text-xl font-semibold">{d.ai.avgScore}<span className="text-sm text-slate-400">/100</span></p></div>
              <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60"><p className="text-xs text-slate-500">Est. CSAT</p><p className="text-xl font-semibold">{d.ai.csat}<span className="text-sm text-slate-400">/5</span></p></div>
            </div>
          </Card>
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Card title="Top agents (7 days)" className="lg:col-span-2">
            <table className="w-full"><thead><tr><th className="th pl-0">Agent</th><th className="th">Calls</th><th className="th">Talk time</th><th className="th">AI score</th></tr></thead>
              <tbody>{d.topAgents.map((a: any) => (
                <tr key={a.id} className="border-t border-slate-100 dark:border-slate-800"><td className="td pl-0 font-medium">{a.name}</td><td className="td tabular-nums">{a.calls}</td><td className="td tabular-nums">{fmtDuration(a.talkSeconds)}</td>
                  <td className="td"><div className="flex items-center gap-2"><span className="w-8 tabular-nums">{a.avgScore}</span><div className="w-24"><Meter value={a.avgScore} color={a.avgScore >= 75 ? '#10b981' : a.avgScore >= 60 ? '#f59e0b' : '#f43f5e'} /></div></div></td></tr>
              ))}</tbody></table>
          </Card>
          <Card title="Call quality & network">
            <dl className="space-y-4 text-sm">
              <div><div className="flex justify-between"><dt>MOS score</dt><dd className="font-semibold tabular-nums">{d.quality.mos}</dd></div><Meter value={Number(d.quality.mos)} max={5} color="#10b981" /></div>
              <div><div className="flex justify-between"><dt>Jitter</dt><dd className="tabular-nums">{d.quality.jitter} ms</dd></div><Meter value={50 - d.quality.jitter} max={50} color="#3b6cf6" /></div>
              <div><div className="flex justify-between"><dt>Packet loss</dt><dd className="tabular-nums">{d.quality.packetLoss}%</dd></div><Meter value={5 - Number(d.quality.packetLoss)} max={5} color="#8b5cf6" /></div>
            </dl>
            <ul className="mt-5 space-y-2 border-t border-slate-100 pt-4 text-sm dark:border-slate-800">
              {Object.entries(d.networkStatus).map(([k, v]) => <li key={k} className="flex items-center justify-between capitalize">{k}<Badge color="green">{String(v)}</Badge></li>)}
            </ul>
          </Card>
        </div>
      </>)}
    </>
  );
}
