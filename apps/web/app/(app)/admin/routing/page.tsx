'use client';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { FlowNode, RoutingAction, RoutingFlow, step, validateFlow } from '@cloudconnect/shared';
import { Badge, Card, ErrorNote, PageHeader } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

const NODE_META: Record<string, { icon: string; color: string; label: string }> = {
  schedule: { icon: 'globe', color: 'border-sky-300 bg-sky-50 dark:bg-sky-900/20', label: 'Business hours' },
  language_select: { icon: 'globe', color: 'border-teal-300 bg-teal-50 dark:bg-teal-900/20', label: 'Language' },
  menu: { icon: 'keypad', color: 'border-brand-300 bg-brand-50 dark:bg-brand-900/20', label: 'IVR menu' },
  ring_group: { icon: 'users', color: 'border-emerald-300 bg-emerald-50 dark:bg-emerald-900/20', label: 'Ring / hunt group' },
  forward: { icon: 'transfer', color: 'border-amber-300 bg-amber-50 dark:bg-amber-900/20', label: 'Forward' },
  voicemail: { icon: 'voicemail', color: 'border-violet-300 bg-violet-50 dark:bg-violet-900/20', label: 'Voicemail' },
  say: { icon: 'message', color: 'border-slate-300 bg-slate-50 dark:bg-slate-800', label: 'Announcement' },
  queue: { icon: 'calls', color: 'border-orange-300 bg-orange-50 dark:bg-orange-900/20', label: 'Call queue' },
  ai_receptionist: { icon: 'sparkles', color: 'border-fuchsia-300 bg-fuchsia-50 dark:bg-fuchsia-900/20', label: 'AI receptionist' },
  hangup: { icon: 'hangup', color: 'border-rose-300 bg-rose-50 dark:bg-rose-900/20', label: 'Hang up' },
};

const TEMPLATES: Record<string, (id: string) => FlowNode> = {
  menu: (id) => ({ id, type: 'menu', prompt: 'For sales press 1.', options: {}, maxRetries: 2 }),
  ring_group: (id) => ({ id, type: 'ring_group', name: 'New group', strategy: 'simultaneous', ringTimeoutSeconds: 20, targets: [], onNoAnswer: id }),
  voicemail: (id) => ({ id, type: 'voicemail', mailboxId: '', transcribe: true }),
  say: (id) => ({ id, type: 'say', text: 'Thank you for calling.', next: id }),
  forward: (id) => ({ id, type: 'forward', to: '+1' }),
  ai_receptionist: (id) => ({ id, type: 'ai_receptionist', agentId: 'main', fallback: id }),
  hangup: (id) => ({ id, type: 'hangup' }),
};

function edges(n: FlowNode): [string, string][] {
  switch (n.type) {
    case 'schedule': return [['open', n.open], ['closed', n.closed], ...(n.holiday ? [['holiday', n.holiday] as [string, string]] : [])];
    case 'menu': return [...Object.entries(n.options).map(([d, t]) => [`press ${d}`, t] as [string, string]), ...(n.onTimeout ? [['timeout', n.onTimeout] as [string, string]] : []), ...(n.onInvalid ? [['invalid', n.onInvalid] as [string, string]] : [])];
    case 'language_select': return [...Object.entries(n.options).map(([d, o]) => [`${d}: ${o.language}`, o.next] as [string, string]), ['timeout', n.onTimeout]];
    case 'ring_group': return [['no answer', n.onNoAnswer]];
    case 'say': return [['then', n.next]];
    case 'forward': return n.onNoAnswer ? [['no answer', n.onNoAnswer]] : [];
    case 'queue': return [['timeout', n.onTimeout]];
    case 'ai_receptionist': return [['fallback', n.fallback]];
    default: return [];
  }
}

function describe(n: FlowNode): string {
  switch (n.type) {
    case 'schedule': return `${n.schedule.timezone} · ${Object.keys(n.schedule.hours).join(', ')} · ${n.schedule.holidays?.length ?? 0} holidays`;
    case 'menu': return n.prompt;
    case 'language_select': return n.prompt;
    case 'ring_group': return `${n.strategy.replace('_', ' ')} · ${n.targets.length} members · ${n.ringTimeoutSeconds}s`;
    case 'forward': return `→ ${n.to}`;
    case 'voicemail': return n.transcribe === false ? 'No transcription' : 'Transcribed + AI summary';
    case 'say': return n.text;
    case 'queue': return `Queue ${n.queueId}`;
    case 'ai_receptionist': return `Agent “${n.agentId}” answers, routes, books & takes messages`;
    default: return '';
  }
}

export default function Routing() {
  const { data: flows, reload } = useApi<any[]>('/v1/routing-flows');
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoutingFlow | null>(null);
  const [name, setName] = useState('');
  const [json, setJson] = useState('');
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (flows?.length && !selId) setSelId(flows[0].id); }, [flows, selId]);
  useEffect(() => { const f = flows?.find((x) => x.id === selId); if (f) { setDraft(f.definition); setName(f.name); setJson(JSON.stringify(f.definition, null, 2)); } }, [selId, flows]);
  const errors = useMemo(() => (draft ? validateFlow(draft) : []), [draft]);

  const order = useMemo(() => {
    if (!draft) return [];
    const seen: string[] = []; const queue = [draft.entry];
    while (queue.length) { const id = queue.shift()!; if (seen.includes(id) || !draft.nodes[id]) continue; seen.push(id); edges(draft.nodes[id]).forEach(([, t]) => queue.push(t)); }
    return [...seen, ...Object.keys(draft.nodes).filter((k) => !seen.includes(k))];
  }, [draft]);

  const save = async () => {
    setError(null); setSaved(false);
    try {
      const def = mode === 'json' ? JSON.parse(json) : draft;
      if (selId) await api(`/v1/routing-flows/${selId}`, { method: 'PUT', body: { name, definition: def, published: true } });
      else { const r = await api('/v1/routing-flows', { body: { name, definition: def, published: true } }); setSelId(r.id); }
      setSaved(true); reload();
    } catch (e) { setError((e as any).body?.errors?.join('; ') ?? (e as Error).message); }
  };
  const newFlow = () => {
    const def: RoutingFlow = { id: 'flow', name: 'New flow', entry: 'welcome', nodes: { welcome: { id: 'welcome', type: 'say', text: 'Thanks for calling.', next: 'bye' }, bye: { id: 'bye', type: 'hangup' } } };
    setSelId(null); setDraft(def); setName('New flow'); setJson(JSON.stringify(def, null, 2));
  };
  const addNode = (type: string) => {
    if (!draft) return;
    let i = 1; while (draft.nodes[`${type}_${i}`]) i++;
    const id = `${type}_${i}`;
    const next = { ...draft, nodes: { ...draft.nodes, [id]: TEMPLATES[type](id) } };
    setDraft(next); setJson(JSON.stringify(next, null, 2));
  };
  const updateNode = (id: string, patch: Partial<FlowNode>) => {
    if (!draft) return;
    const next = { ...draft, nodes: { ...draft.nodes, [id]: { ...draft.nodes[id], ...patch } as FlowNode } };
    setDraft(next); setJson(JSON.stringify(next, null, 2));
  };

  return (
    <>
      <PageHeader title="Call routing & IVR" subtitle="Auto receptionist, IVR phone trees, ring & hunt groups, business hours, holidays and AI receptionist." actions={<><button className="btn-outline" onClick={newFlow}><Icon name="plus" className="h-4 w-4" />New flow</button><button className="btn-primary" onClick={save} disabled={!draft}>Save & publish</button></>} />
      <div className="grid gap-6 xl:grid-cols-[220px_1fr_320px]">
        <Card title="Flows"><ul className="space-y-1">{flows?.map((f) => <li key={f.id}><button onClick={() => setSelId(f.id)} className={clsx('w-full rounded-md px-2.5 py-1.5 text-left text-sm', selId === f.id ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-900/30 dark:text-brand-200' : 'hover:bg-slate-50 dark:hover:bg-slate-800')}>{f.name}<span className="ml-1 text-xs text-slate-400">v{f.version}</span></button></li>)}</ul></Card>
        <Card title={draft ? undefined : 'Select a flow'}>
          {draft && (<div className="p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <input className="input max-w-xs font-medium" value={name} onChange={(e) => setName(e.target.value)} aria-label="Flow name" />
              <div className="ml-auto flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">{(['visual', 'json'] as const).map((m) => <button key={m} onClick={() => { if (m === 'visual') { try { setDraft(JSON.parse(json)); } catch { setError('Invalid JSON'); return; } } setMode(m); }} className={clsx('rounded-md px-3 py-1 text-sm capitalize', mode === m && 'bg-slate-900 text-white dark:bg-white dark:text-slate-900')}>{m}</button>)}</div>
            </div>
            {errors.length > 0 ? <div className="mb-3 rounded-lg bg-rose-50 p-3 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">{errors.map((e) => <p key={e}>• {e}</p>)}</div> : <p className="mb-3 text-xs text-emerald-600">✓ Flow is valid</p>}
            <ErrorNote error={error} />{saved && <p className="mb-2 text-sm text-emerald-600">Saved and published.</p>}
            {mode === 'json' ? <textarea className="input h-[520px] font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} aria-label="Flow JSON" spellCheck={false} /> : (<>
              <div className="mb-4 flex flex-wrap gap-2">{Object.keys(TEMPLATES).map((t) => <button key={t} className="btn-outline py-1 text-xs" onClick={() => addNode(t)}><Icon name={NODE_META[t].icon} className="h-3.5 w-3.5" />{NODE_META[t].label}</button>)}</div>
              <ol className="space-y-3">{order.map((id) => {
                const n = draft.nodes[id]; const m = NODE_META[n.type];
                return (
                  <li key={id} className={clsx('rounded-xl border-l-4 p-4', m.color)}>
                    <div className="flex items-center gap-2"><Icon name={m.icon} className="h-4 w-4" /><span className="text-sm font-semibold">{m.label}</span><code className="text-xs text-slate-500">{id}</code>{id === draft.entry && <Badge color="green">entry</Badge>}
                      <select className="ml-auto rounded border border-slate-200 bg-white px-1 text-xs dark:border-slate-700 dark:bg-slate-900" value="" onChange={(e) => { if (e.target.value === 'entry') setDraft({ ...draft, entry: id }); if (e.target.value === 'delete') { const { [id]: _, ...rest } = draft.nodes; setDraft({ ...draft, nodes: rest }); } }} aria-label="Node actions"><option value="">⋯</option><option value="entry">Make entry</option><option value="delete">Delete</option></select></div>
                    {n.type === 'menu' || n.type === 'say' ? <textarea className="input mt-2 text-sm" rows={2} value={n.type === 'menu' ? n.prompt : n.text} onChange={(e) => updateNode(id, n.type === 'menu' ? { prompt: e.target.value } : { text: e.target.value } as any)} aria-label="Prompt" /> : <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{describe(n)}</p>}
                    {n.type === 'ring_group' && <select className="input mt-2 max-w-xs py-1 text-xs" value={n.strategy} onChange={(e) => updateNode(id, { strategy: e.target.value } as any)} aria-label="Ring strategy">{['simultaneous', 'sequential', 'round_robin', 'longest_idle'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>}
                    <div className="mt-2 flex flex-wrap gap-1.5">{edges(n).map(([l, t]) => <span key={l} className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs shadow-sm dark:bg-slate-900">{l} → <b className={draft.nodes[t] ? '' : 'text-rose-600'}>{t}</b></span>)}</div>
                  </li>);
              })}</ol>
            </>)}
          </div>)}
        </Card>
        {draft && <Simulator flow={draft} />}
      </div>
    </>
  );
}

/** Runs the same routing engine the API uses, in the browser, so admins can test before publishing. */
function Simulator({ flow }: { flow: RoutingFlow }) {
  const [from, setFrom] = useState('+12125550123');
  const [when, setWhen] = useState(() => new Date().toISOString().slice(0, 16));
  const [log, setLog] = useState<{ action: RoutingAction; input?: string }[]>([]);
  const [cont, setCont] = useState<{ node?: string; attempt?: number; language?: string } | null>(null);
  const run = (digits?: string, c = cont) => {
    try {
      const a = step(flow, c?.node, { from, to: '+1', now: new Date(when), digits, attempt: c?.attempt, language: c?.language });
      setLog((l) => [...l, { action: a, input: digits }]);
      const t = 'then' in a ? a.then : null;
      setCont(t ? { node: t.nodeId, attempt: t.attempt, language: t.language } : null);
    } catch (e) { setLog((l) => [...l, { action: { kind: 'say', text: `Error: ${(e as Error).message}`, language: 'en', then: { nodeId: '' } } }]); setCont(null); }
  };
  const last = log[log.length - 1]?.action;
  const start = () => { setLog([]); setCont(null); setTimeout(() => run(undefined, null), 0); };
  return (
    <Card title="Test call simulator">
      <div className="space-y-2">
        <input className="input text-sm" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Caller number" />
        <input className="input text-sm" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Call time" />
        <button className="btn-primary w-full" onClick={start}><Icon name="phone" className="h-4 w-4" />Simulate inbound call</button>
      </div>
      <ol className="mt-4 space-y-2 text-xs">{log.map((l, i) => (
        <li key={i} className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/60">
          {l.input !== undefined && <p className="mb-1 text-slate-500">Caller pressed: <b>{l.input || '(nothing)'}</b></p>}
          <p className="font-semibold uppercase tracking-wide text-brand-600">{l.action.kind}</p>
          {'text' in l.action && <p>“{l.action.text}”</p>}{'prompt' in l.action && <p>“{l.action.prompt}”</p>}
          {l.action.kind === 'dial' && <p>Ringing: {l.action.targets.join(', ')}</p>}
          {l.action.kind === 'voicemail' && <p>Mailbox {l.action.mailboxId}</p>}
          {l.action.kind === 'reject' && <p>Reason: {l.action.reason}</p>}
        </li>))}</ol>
      {last?.kind === 'gather' && <div className="mt-3 grid grid-cols-4 gap-1">{['1', '2', '3', '0', '9', '*', '#'].map((d) => <button key={d} className="btn-outline py-1" onClick={() => run(d)}>{d}</button>)}<button className="btn-outline py-1 text-[10px]" onClick={() => run('')}>none</button></div>}
      {(last?.kind === 'say' || last?.kind === 'dial') && cont && <button className="btn-outline mt-3 w-full text-xs" onClick={() => run()}>{last.kind === 'dial' ? 'No answer → continue' : 'Continue'}</button>}
    </Card>
  );
}
