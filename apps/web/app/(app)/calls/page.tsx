'use client';
import clsx from 'clsx';
import { useState } from 'react';
import { Badge, Card, Empty, PageHeader, Skeleton } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useSoftphone } from '@/components/Softphone';
import { useApi } from '@/lib/useApi';
import { api } from '@/lib/api';
import { fmtDuration, fmtPhone, fmtTime } from '@/lib/format';

const SENT: Record<string, 'green' | 'red' | 'gray' | 'amber'> = { positive: 'green', negative: 'red', neutral: 'gray', mixed: 'amber' };

export default function Calls() {
  const [filter, setFilter] = useState<{ direction?: string; status?: string; q?: string }>({});
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  const { data, loading } = useApi<any>(`/v1/calls?limit=50&${qs}`, [qs]);
  const [sel, setSel] = useState<string | null>(null);
  const phone = useSoftphone();

  return (
    <>
      <PageHeader title="Calls" subtitle="Call history, recordings and AI insights." />
      <div className="mb-4 flex flex-wrap gap-2">
        {[{ k: undefined, l: 'All' }, { k: 'inbound', l: 'Inbound' }, { k: 'outbound', l: 'Outbound' }].map((o) => (
          <button key={o.l} onClick={() => setFilter({ ...filter, direction: o.k })} className={clsx('btn', filter.direction === o.k ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'btn-outline')}>{o.l}</button>
        ))}
        <button onClick={() => setFilter({ ...filter, status: filter.status === 'no_answer' ? undefined : 'no_answer' })} className={clsx('btn', filter.status === 'no_answer' ? 'bg-rose-600 text-white' : 'btn-outline')}>Missed</button>
        <input className="input ml-auto max-w-xs" placeholder="Filter by number" onChange={(e) => setFilter({ ...filter, q: e.target.value.replace(/[^\d+]/g, '') || undefined })} aria-label="Filter by number" />
      </div>
      <div className="grid gap-6 xl:grid-cols-5">
        <Card className={clsx('overflow-hidden', sel ? 'xl:col-span-3' : 'xl:col-span-5')}>
          {loading && !data ? <div className="space-y-2 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}</div> : !data?.data.length ? <Empty icon="phone" title="No calls yet">Calls you make and receive appear here.</Empty> : (
            <div className="overflow-x-auto"><table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-800/50"><tr><th className="th">Contact</th><th className="th">Agent</th><th className="th">When</th><th className="th">Duration</th><th className="th">AI</th><th className="th" /></tr></thead>
              <tbody>{data.data.map((c: any) => {
                const missed = c.direction === 'inbound' && !c.answeredAt && c.status !== 'rejected';
                const other = c.direction === 'inbound' ? c.from : c.to;
                return (
                  <tr key={c.id} onClick={() => setSel(c.id)} className={clsx('cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40', sel === c.id && 'bg-brand-50/60 dark:bg-brand-900/20')}>
                    <td className="td"><div className="flex items-center gap-2.5"><Icon name={missed ? 'missed' : c.direction === 'inbound' ? 'incoming' : 'outgoing'} className={clsx('h-4 w-4', missed ? 'text-rose-500' : 'text-slate-400')} /><span className="font-medium">{fmtPhone(other)}</span>{c.status === 'voicemail' && <Badge color="violet">voicemail</Badge>}</div></td>
                    <td className="td text-slate-500">{c.userName ?? '—'}</td>
                    <td className="td text-slate-500">{fmtTime(c.startedAt)}</td>
                    <td className="td tabular-nums">{c.answeredAt ? fmtDuration(c.durationSeconds) : '—'}</td>
                    <td className="td">{c.sentiment ? <Badge color={SENT[c.sentiment]}>{c.sentiment} · {c.callScore}</Badge> : <span className="text-slate-300">—</span>}</td>
                    <td className="td text-right"><button className="btn-ghost p-1.5" onClick={(e) => { e.stopPropagation(); phone.dial(other); }} aria-label={`Call ${other}`}><Icon name="phone" className="h-4 w-4" /></button></td>
                  </tr>);
              })}</tbody></table></div>
          )}
        </Card>
        {sel && <CallDetail id={sel} onClose={() => setSel(null)} />}
      </div>
    </>
  );
}

function CallDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: c, reload } = useApi<any>(`/v1/calls/${id}`, [id]);
  const [busy, setBusy] = useState(false);
  if (!c) return <Card className="xl:col-span-2"><Skeleton className="m-5 h-64" /></Card>;
  const analyze = async () => { setBusy(true); try { await api(`/v1/calls/${id}/analyze`, { body: {} }); await reload(); } finally { setBusy(false); } };
  return (
    <Card className="xl:col-span-2" title="Call details" action={<button className="btn-ghost p-1" onClick={onClose} aria-label="Close details"><Icon name="x" className="h-4 w-4" /></button>}>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-xs text-slate-500">From</dt><dd className="font-medium">{fmtPhone(c.from)}</dd></div>
        <div><dt className="text-xs text-slate-500">To</dt><dd className="font-medium">{fmtPhone(c.to)}</dd></div>
        <div><dt className="text-xs text-slate-500">Status</dt><dd className="capitalize">{c.status.replace('_', ' ')}</dd></div>
        <div><dt className="text-xs text-slate-500">Duration</dt><dd>{fmtDuration(c.durationSeconds)}</dd></div>
        {c.mosScore && <div><dt className="text-xs text-slate-500">Quality (MOS)</dt><dd>{c.mosScore}</dd></div>}
        {c.routingPath?.length > 0 && <div className="col-span-2"><dt className="text-xs text-slate-500">Routing path</dt><dd className="mt-1 flex flex-wrap items-center gap-1">{c.routingPath.map((n: string, i: number) => <span key={i} className="flex items-center gap-1"><Badge color="blue">{n}</Badge>{i < c.routingPath.length - 1 && '→'}</span>)}</dd></div>}
      </dl>
      {c.recordings?.length > 0 && <div className="mt-4 flex items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60"><Icon name="play" className="h-4 w-4 text-brand-600" />Recording · {fmtDuration(c.recordings[0].durationSeconds)}</div>}
      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div className="flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-semibold"><Icon name="sparkles" className="h-4 w-4 text-violet-500" />AI insights</h3>
          {c.transcript && <button className="btn-ghost text-xs" onClick={analyze} disabled={busy}>{busy ? 'Analyzing…' : 'Re-analyze'}</button>}</div>
        {c.insights ? (
          <div className="mt-3 space-y-3 text-sm">
            <p>{c.insights.summary}</p>
            <div className="flex flex-wrap gap-2"><Badge color={SENT[c.insights.sentiment]}>Sentiment: {c.insights.sentiment}</Badge><Badge color="blue">Score {c.insights.callScore}/100</Badge></div>
            {c.insights.actionItems?.length > 0 && <div><p className="text-xs font-medium text-slate-500">Action items</p><ul className="mt-1 list-disc space-y-1 pl-5">{c.insights.actionItems.map((a: any, i: number) => <li key={i}>{a.text}</li>)}</ul></div>}
            {c.insights.keywords?.length > 0 && <div className="flex flex-wrap gap-1">{c.insights.keywords.map((k: string) => <Badge key={k}>{k}</Badge>)}</div>}
            {c.insights.coaching?.length > 0 && <div className="rounded-lg bg-violet-50 p-3 dark:bg-violet-900/20"><p className="text-xs font-semibold text-violet-700 dark:text-violet-300">Coaching</p><ul className="mt-1 list-disc space-y-0.5 pl-5 text-violet-900 dark:text-violet-200">{c.insights.coaching.map((t: string) => <li key={t}>{t}</li>)}</ul></div>}
          </div>
        ) : <p className="mt-2 text-sm text-slate-500">No transcript for this call yet.</p>}
        {c.transcript && <details className="mt-4 text-sm"><summary className="cursor-pointer font-medium text-slate-600">Transcript</summary><p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">{c.transcript.text}</p></details>}
      </div>
    </Card>
  );
}
