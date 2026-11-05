'use client';
import { useState } from 'react';
import { Badge, Card, ErrorNote, Field, Modal, PageHeader } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { fmtRelative } from '@/lib/format';

const EVENTS = ['call.ringing', 'call.answered', 'call.completed', 'call.missed', 'call.recording.ready', 'call.analyzed', 'voicemail.received', 'message.received', 'message.sent', 'meeting.started', 'meeting.ended', 'user.created', 'number.purchased'];
const label = (p: string) => p.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').replace('Hubspot', 'HubSpot').replace('Quickbooks', 'QuickBooks').replace('365', '365');

export default function Integrations() {
  const { data: ints, reload } = useApi<any[]>('/v1/integrations');
  const { data: keys, reload: reloadKeys } = useApi<any[]>('/v1/auth/api-keys');
  const { data: hooks, reload: reloadHooks } = useApi<any[]>('/v1/webhooks');
  const [connect, setConnect] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [hook, setHook] = useState({ url: '', events: ['call.completed'] });
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doConnect = async () => { await api('/v1/integrations', { body: { provider: connect, credentials: { accessToken: token } } }); setConnect(null); setToken(''); reload(); };
  const createKey = async () => { const k = await api('/v1/auth/api-keys', { body: { name: `Key ${new Date().toLocaleDateString()}`, scopes: [] } }); setNewKey(k.key); reloadKeys(); };
  const createHook = async () => { setError(null); try { const h = await api('/v1/webhooks', { body: hook }); setSecret(h.secret); reloadHooks(); } catch (e) { setError((e as Error).message); } };

  return (
    <>
      <PageHeader title="Integrations & API" subtitle="CRM, collaboration, productivity apps, webhooks, REST & GraphQL API." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ints?.map((i) => (
          <div key={i.provider} className="card flex flex-col p-4">
            <div className="flex items-center justify-between"><p className="font-semibold">{label(i.provider)}</p>{i.connected ? <Badge color="green">Connected</Badge> : <Badge>{i.category}</Badge>}</div>
            <p className="mt-2 flex-1 text-xs text-slate-500">{i.capabilities.map((c: string) => c.replace(/_/g, ' ')).join(' · ')}</p>
            {i.connected ? <button className="btn-ghost mt-3 text-xs text-rose-600" onClick={async () => { await api(`/v1/integrations/${i.provider}`, { method: 'DELETE' }); reload(); }}>Disconnect</button> : <button className="btn-outline mt-3" onClick={() => setConnect(i.provider)}>Connect</button>}
          </div>))}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="API keys" action={<button className="btn-outline py-1" onClick={createKey}><Icon name="plus" className="h-4 w-4" />New key</button>}>
          {newKey && <div className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">Copy now — shown only once:<code className="mt-1 block break-all text-xs">{newKey}</code></div>}
          <ul className="space-y-2 text-sm">{keys?.map((k) => <li key={k.id} className="flex items-center justify-between"><span><code>{k.prefix}…</code> <span className="text-slate-500">{k.name}</span></span><span className="flex items-center gap-3 text-xs text-slate-500">{k.last_used_at ? `used ${fmtRelative(k.last_used_at)}` : 'never used'}<button className="text-rose-600" onClick={async () => { await api(`/v1/auth/api-keys/${k.id}`, { method: 'DELETE' }); reloadKeys(); }}>Revoke</button></span></li>)}</ul>
          <div className="mt-4 rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">curl -H &quot;Authorization: Bearer cc_live_…&quot; https://api.cloudconnect.ai/v1/calls</div>
          <p className="mt-2 text-xs text-slate-500">REST reference: <a className="text-brand-600" href="/docs" target="_blank">/docs</a> (OpenAPI) · GraphQL endpoint: <code>/graphql</code></p>
        </Card>
        <Card title="Webhooks">
          <ul className="mb-4 space-y-2 text-sm">{hooks?.map((h) => <li key={h.id} className="flex items-center justify-between gap-2"><span className="truncate">{h.url}</span><span className="flex items-center gap-2"><Badge>{h.events.length} events</Badge><button className="text-xs text-rose-600" onClick={async () => { await api(`/v1/webhooks/${h.id}`, { method: 'DELETE' }); reloadHooks(); }}>Delete</button></span></li>)}</ul>
          <Field label="Endpoint URL (https)"><input className="input" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} placeholder="https://example.com/webhooks/cloudconnect" /></Field>
          <div className="mt-2 flex flex-wrap gap-1.5">{EVENTS.map((e) => <label key={e} className="flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-xs dark:border-slate-700"><input type="checkbox" checked={hook.events.includes(e)} onChange={(ev) => setHook({ ...hook, events: ev.target.checked ? [...hook.events, e] : hook.events.filter((x) => x !== e) })} />{e}</label>)}</div>
          <div className="mt-3"><ErrorNote error={error} /></div>
          {secret && <p className="mt-2 text-xs">Signing secret (HMAC-SHA256, header <code>X-CloudConnect-Signature</code>): <code className="break-all">{secret}</code></p>}
          <button className="btn-primary mt-3" onClick={createHook} disabled={!hook.url || !hook.events.length}>Add webhook</button>
        </Card>
      </div>
      <Modal open={!!connect} onClose={() => setConnect(null)} title={`Connect ${connect ? label(connect) : ''}`} footer={<><button className="btn-ghost" onClick={() => setConnect(null)}>Cancel</button><button className="btn-primary" onClick={doConnect} disabled={!token}>Connect</button></>}>
        <p className="mb-3 text-sm text-slate-500">In production this launches the provider&apos;s OAuth consent screen. Credentials are encrypted with AES-256-GCM before storage.</p>
        <Field label="Access token / API key"><input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
      </Modal>
    </>
  );
}
