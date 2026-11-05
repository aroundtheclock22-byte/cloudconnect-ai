'use client';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageHeader } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { realtime } from '@/lib/realtime';
import { useApi } from '@/lib/useApi';
import { fmtPhone, fmtRelative } from '@/lib/format';

export default function Messages() {
  const { me } = useAuth();
  const [tab, setTab] = useState<'sms' | 'chat'>('sms');
  const { data: convs, reload } = useApi<any[]>(`/v1/conversations?kind=${tab === 'sms' ? 'sms' : 'team_chat'}`, [tab]);
  const { data: dms } = useApi<any[]>(tab === 'chat' ? '/v1/conversations?kind=direct_chat' : null, [tab]);
  const { data: dir } = useApi<any[]>('/v1/directory');
  const [sel, setSel] = useState<any | null>(null);
  const [compose, setCompose] = useState(false);
  const list = [...(convs ?? []), ...(tab === 'chat' ? dms ?? [] : [])];
  const name = (c: any) => c.kind.includes('chat') ? (c.title ?? c.participants.filter((p: string) => p !== me?.id).map((p: string) => { const u = dir?.find((d) => d.id === p); return u ? `${u.firstName} ${u.lastName}` : 'Teammate'; }).join(', ')) : (c.contactName ?? fmtPhone(c.participants[0]));

  useEffect(() => { const s = realtime(); const h = () => reload(); s?.on('message.received', h); return () => { s?.off('message.received', h); }; }, [reload]);

  return (
    <>
      <PageHeader title="Messages" subtitle="Business texting and team chat." actions={<button className="btn-primary" onClick={() => setCompose(true)}><Icon name="plus" className="h-4 w-4" />New message</button>} />
      <section className="card grid h-[calc(100vh-13rem)] min-h-[480px] grid-cols-1 overflow-hidden md:grid-cols-[320px_1fr]">
        <div className={clsx('flex flex-col border-r border-slate-100 dark:border-slate-800', sel && 'hidden md:flex')}>
          <div className="flex gap-1 border-b border-slate-100 p-2 dark:border-slate-800">
            {(['sms', 'chat'] as const).map((t) => <button key={t} onClick={() => { setTab(t); setSel(null); }} className={clsx('btn flex-1', tab === t ? 'bg-slate-100 dark:bg-slate-800' : 'btn-ghost')}>{t === 'sms' ? 'SMS' : 'Team chat'}</button>)}
          </div>
          <ul className="flex-1 overflow-y-auto">
            {!list.length && <Empty icon="message" title="No conversations" />}
            {list.map((c) => (
              <li key={c.id}><button onClick={() => setSel(c)} className={clsx('flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40', sel?.id === c.id && 'bg-brand-50/60 dark:bg-brand-900/20')}>
                <Avatar name={name(c) || '#'} />
                <span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="truncate font-medium">{name(c)}</span><span className="shrink-0 text-xs text-slate-400">{fmtRelative(c.lastMessageAt)}</span></span>
                  <span className="flex items-center gap-2"><span className="truncate text-sm text-slate-500">{c.lastMessage}</span>{c.unread > 0 && <span className="ml-auto rounded-full bg-brand-600 px-1.5 text-xs font-medium text-white">{c.unread}</span>}</span></span>
              </button></li>
            ))}
          </ul>
        </div>
        {sel ? <Thread conv={sel} title={name(sel)} onBack={() => setSel(null)} onSent={reload} /> : <div className="hidden items-center justify-center md:flex"><Empty icon="message" title="Select a conversation" /></div>}
      </section>
      <Compose open={compose} onClose={() => setCompose(false)} onSent={() => { setCompose(false); reload(); }} />
    </>
  );
}

function Thread({ conv, title, onBack, onSent }: { conv: any; title: string; onBack: () => void; onSent: () => void }) {
  const { me } = useAuth();
  const { data: msgs, reload } = useApi<any[]>(`/v1/conversations/${conv.id}/messages`, [conv.id]);
  const [body, setBody] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const chat = conv.kind.includes('chat');
  useEffect(() => { end.current?.scrollIntoView(); api(`/v1/conversations/${conv.id}/read`, { body: {} }).catch(() => undefined); }, [msgs, conv.id]);
  useEffect(() => {
    const s = realtime(); if (!s) return;
    const onMsg = (e: any) => e.data.conversationId === conv.id && reload();
    const onType = (e: any) => e.conversationId === conv.id && setTyping(e.typing);
    s.on('message.received', onMsg); s.on('typing', onType);
    return () => { s.off('message.received', onMsg); s.off('typing', onType); };
  }, [conv.id, reload]);

  const send = async () => {
    if (!body.trim()) return;
    setError(null);
    try {
      await api(chat ? `/v1/chats/${conv.id}/messages` : '/v1/messages', { body: chat ? { body } : { to: conv.participants, from: conv.number, body } });
      setBody(''); setSuggestions([]); reload(); onSent();
    } catch (e) { setError((e as Error).message); }
  };
  const suggest = async () => setSuggestions((await api(`/v1/conversations/${conv.id}/suggest-replies`, { body: {} })).suggestions);
  const onType = (v: string) => { setBody(v); if (chat) realtime()?.emit('typing', { conversationId: conv.id, participants: conv.participants, typing: v.length > 0 }); };

  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <button className="btn-ghost p-1 md:hidden" onClick={onBack} aria-label="Back">←</button>
        <Avatar name={title || '#'} /><div><p className="font-medium">{title}</p><p className="text-xs text-slate-500">{chat ? `${conv.participants.length} members` : `via ${fmtPhone(conv.number)}`}</p></div>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50/60 p-4 dark:bg-slate-950/40">
        {msgs?.map((m) => {
          const mine = chat ? m.senderUserId === me?.id : m.direction === 'outbound';
          return (
            <div key={m.id} className={clsx('flex', mine ? 'justify-end' : 'justify-start')}>
              <div className={clsx('max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm', mine ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md bg-white dark:bg-slate-800')}>
                <p className="whitespace-pre-wrap">{m.body}</p>
                {m.media?.length > 0 && <p className="mt-1 text-xs opacity-80">📎 {m.media.length} attachment(s)</p>}
                <p className={clsx('mt-0.5 text-[10px]', mine ? 'text-white/70' : 'text-slate-400')}>{fmtRelative(m.createdAt)}{mine && ` · ${m.readAt ? 'Read' : m.status}`}{m.status === 'scheduled' && ' ⏰'}</p>
              </div>
            </div>);
        })}
        {typing && <p className="text-xs italic text-slate-400">typing…</p>}
        <div ref={end} />
      </div>
      <footer className="border-t border-slate-100 p-3 dark:border-slate-800">
        {suggestions.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{suggestions.map((s) => <button key={s} onClick={() => setBody(s)} className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-left text-xs text-violet-800 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-900/30 dark:text-violet-200">{s}</button>)}</div>}
        <ErrorNote error={error} />
        <div className="flex gap-2">
          {!chat && <button className="btn-outline px-2.5" onClick={suggest} title="AI reply suggestions" aria-label="AI reply suggestions"><Icon name="sparkles" className="h-4 w-4 text-violet-500" /></button>}
          <input className="input" placeholder="Type a message" value={body} onChange={(e) => onType(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} aria-label="Message" />
          <button className="btn-primary" onClick={send} aria-label="Send"><Icon name="send" className="h-4 w-4" /></button>
        </div>
      </footer>
    </div>
  );
}

function Compose({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: () => void }) {
  const [f, setF] = useState({ to: '', body: '', scheduledAt: '', bulk: false });
  const [seg, setSeg] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: templates } = useApi<any[]>(open ? '/v1/sms-templates' : null, [open]);
  useEffect(() => { if (f.body) api('/v1/messages/segments', { body: { body: f.body } }).then(setSeg).catch(() => undefined); else setSeg(null); }, [f.body]);
  const send = async () => {
    setError(null);
    const to = f.to.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
    try {
      if (f.bulk || to.length > 10) await api('/v1/messages/bulk', { body: { name: `Broadcast ${new Date().toLocaleString()}`, body: f.body, to, ...(f.scheduledAt ? { scheduledAt: new Date(f.scheduledAt).toISOString() } : {}) } });
      else await api('/v1/messages', { body: { to, body: f.body, ...(f.scheduledAt ? { scheduledAt: new Date(f.scheduledAt).toISOString() } : {}) } });
      setF({ to: '', body: '', scheduledAt: '', bulk: false }); onSent();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New text message" footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={send} disabled={!f.to || !f.body}>{f.scheduledAt ? 'Schedule' : 'Send'}</button></>}>
      <div className="space-y-4">
        <Field label="To (comma-separated for group / broadcast)"><textarea className="input" rows={2} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="+1 415 555 0100" /></Field>
        {templates && templates.length > 0 && <Field label="Template"><select className="input" onChange={(e) => setF({ ...f, body: templates.find((t) => t.id === e.target.value)?.body ?? f.body })}><option value="">—</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
        <Field label="Message"><textarea className="input" rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        {seg && <p className="text-xs text-slate-500">{seg.length} chars · {seg.encoding} · {seg.segments} segment{seg.segments > 1 ? 's' : ''}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Schedule (optional)"><input className="input" type="datetime-local" value={f.scheduledAt} onChange={(e) => setF({ ...f, scheduledAt: e.target.value })} /></Field>
          <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.bulk} onChange={(e) => setF({ ...f, bulk: e.target.checked })} />Send individually (broadcast)</label>
        </div>
        <p className="text-xs text-slate-500"><Badge>Compliance</Badge> Recipients who replied STOP are skipped automatically.</p>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
