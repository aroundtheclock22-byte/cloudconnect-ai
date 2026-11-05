'use client';
import clsx from 'clsx';
import { Badge, Card, Empty, PageHeader, Skeleton } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useSoftphone } from '@/components/Softphone';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { fmtDuration, fmtPhone, fmtRelative } from '@/lib/format';

export default function Voicemail() {
  const { data, setData, loading } = useApi<any[]>('/v1/voicemails');
  const phone = useSoftphone();
  const mark = async (id: string, isRead: boolean) => { await api(`/v1/voicemails/${id}`, { method: 'PATCH', body: { isRead } }); setData((d) => d?.map((v) => v.id === id ? { ...v, isRead } : v) ?? null); };
  const remove = async (id: string) => { await api(`/v1/voicemails/${id}`, { method: 'DELETE' }); setData((d) => d?.filter((v) => v.id !== id) ?? null); };
  const play = async (id: string) => { const r = await api(`/v1/voicemails/${id}/audio`); mark(id, true); if (/^https?:/.test(r.url)) new Audio(r.url).play().catch(() => undefined); };
  return (
    <>
      <PageHeader title="Visual voicemail" subtitle="Transcribed and summarized by AI. Also delivered to your email." actions={<Badge color="blue">{data?.filter((v) => !v.isRead).length ?? 0} unread</Badge>} />
      <Card>
        {loading && !data ? <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div> : !data?.length ? <Empty icon="voicemail" title="No voicemails" /> : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.map((v) => (
              <li key={v.id} className={clsx('flex flex-col gap-3 p-5 sm:flex-row sm:items-start', !v.isRead && 'bg-brand-50/40 dark:bg-brand-900/10')}>
                <button className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white hover:bg-brand-700" onClick={() => play(v.id)} aria-label="Play voicemail"><Icon name="play" className="h-4 w-4" /></button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className={clsx('font-medium', !v.isRead && 'font-semibold')}>{v.contactName ?? fmtPhone(v.from)}</span><span className="text-xs text-slate-500">{fmtRelative(v.createdAt)} · {fmtDuration(v.durationSeconds)}</span>{!v.isRead && <Badge color="blue">New</Badge>}</div>
                  {v.aiSummary && <p className="mt-1 flex items-start gap-1.5 text-sm"><Icon name="sparkles" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />{v.aiSummary}</p>}
                  {v.transcript && <p className="mt-1 text-sm italic text-slate-500">“{v.transcript}”</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button className="btn-outline" onClick={() => phone.dial(v.from)}><Icon name="phone" className="h-4 w-4" />Call back</button>
                  <button className="btn-ghost" onClick={() => mark(v.id, !v.isRead)}>{v.isRead ? 'Mark unread' : 'Mark read'}</button>
                  <button className="btn-ghost text-rose-600" onClick={() => remove(v.id)} aria-label="Delete voicemail"><Icon name="x" className="h-4 w-4" /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
