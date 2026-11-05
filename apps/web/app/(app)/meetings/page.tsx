'use client';
import { useState } from 'react';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHeader } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { fmtTime } from '@/lib/format';

export default function Meetings() {
  const { data, reload } = useApi<any[]>('/v1/meetings');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', start: '', duration: 30, mode: 'meeting', waitingRoom: true, autoRecord: false, passcode: '', invitees: '' });
  const [error, setError] = useState<string | null>(null);
  const create = async (instant = false) => {
    setError(null);
    try {
      const start = instant ? new Date() : new Date(f.start);
      const m = await api('/v1/meetings', { body: { title: instant ? 'Instant meeting' : f.title, mode: f.mode, waitingRoom: f.waitingRoom, autoRecord: f.autoRecord, passcode: f.passcode || undefined,
        scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + f.duration * 60_000).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        invitees: f.invitees.split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email })) } });
      setOpen(false); reload();
      if (instant) window.open(`/meet/${m.joinCode}`, '_blank');
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <>
      <PageHeader title="Meetings" subtitle="HD video, screen sharing, webinars, AI notes and live captions." actions={<>
        <button className="btn-outline" onClick={() => setOpen(true)}><Icon name="plus" className="h-4 w-4" />Schedule</button>
        <button className="btn-primary" onClick={() => create(true)}><Icon name="video" className="h-4 w-4" />Meet now</button></>} />
      <Card>
        {!data?.length ? <Empty icon="video" title="No meetings scheduled" /> : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">{data.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-4 p-5">
              <div className="flex h-12 w-12 flex-col items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-200">
                <span className="text-[10px] font-semibold uppercase">{m.scheduledStart ? new Date(m.scheduledStart).toLocaleDateString(undefined, { month: 'short' }) : 'Now'}</span>
                <span className="text-lg font-semibold leading-none">{m.scheduledStart ? new Date(m.scheduledStart).getDate() : '•'}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{m.title}</p>
                <p className="text-sm text-slate-500">{m.scheduledStart ? fmtTime(m.scheduledStart) : 'Unscheduled'} · Code {m.joinCode.replace(/(\d{3})(\d{3})(\d+)/, '$1 $2 $3')}</p>
                <div className="mt-1 flex gap-1">{m.mode === 'webinar' && <Badge color="violet">Webinar</Badge>}{m.waitingRoom && <Badge>Waiting room</Badge>}{m.autoRecord && <Badge color="red">Auto-record</Badge>}{m.endedAt && <Badge color="gray">Ended</Badge>}</div>
              </div>
              <a className="btn-ghost" href={`/v1/meetings/${m.joinCode}/ics`}><Icon name="download" className="h-4 w-4" />.ics</a>
              <button className="btn-outline" onClick={() => navigator.clipboard?.writeText(`${location.origin}/meet/${m.joinCode}`)}>Copy link</button>
              {!m.endedAt && <a className="btn-primary" href={`/meet/${m.joinCode}`} target="_blank">Join</a>}
            </li>))}</ul>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Schedule meeting" footer={<><button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" onClick={() => create()} disabled={!f.title || !f.start}>Schedule</button></>}>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
          <Field label="Start"><input className="input" type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
          <Field label="Duration (min)"><input className="input" type="number" min={15} step={15} value={f.duration} onChange={(e) => setF({ ...f, duration: Number(e.target.value) })} /></Field>
          <Field label="Type"><select className="input" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="meeting">Meeting</option><option value="webinar">Webinar</option></select></Field>
          <Field label="Passcode (optional)"><input className="input" value={f.passcode} onChange={(e) => setF({ ...f, passcode: e.target.value })} /></Field>
          <div className="col-span-2"><Field label="Invitees (emails, comma-separated)"><input className="input" value={f.invitees} onChange={(e) => setF({ ...f, invitees: e.target.value })} /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.waitingRoom} onChange={(e) => setF({ ...f, waitingRoom: e.target.checked })} />Waiting room</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.autoRecord} onChange={(e) => setF({ ...f, autoRecord: e.target.checked })} />Record automatically</label>
        </div>
        <div className="mt-3"><ErrorNote error={error} /></div>
      </Modal>
    </>
  );
}
