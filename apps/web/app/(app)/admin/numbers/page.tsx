'use client';
import { useState } from 'react';
import { Badge, Card, ErrorNote, Field, Modal, PageHeader } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { fmtMoney, fmtPhone } from '@/lib/format';

const COUNTRIES = [['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['AU', 'Australia'], ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['MX', 'Mexico'], ['BR', 'Brazil'], ['IN', 'India'], ['JP', 'Japan'], ['SG', 'Singapore'], ['IE', 'Ireland'], ['NL', 'Netherlands']];

export default function Numbers() {
  const { data, reload } = useApi<any[]>('/v1/numbers');
  const { data: flows } = useApi<any[]>('/v1/routing-flows');
  const { data: users } = useApi<any>('/v1/users?limit=200');
  const { data: ports, reload: reloadPorts } = useApi<any[]>('/v1/numbers/port-requests');
  const [buy, setBuy] = useState(false);
  const [port, setPort] = useState(false);
  const [s, setS] = useState({ country: 'US', type: 'local', areaCode: '', vanity: '', temporaryDays: '' });
  const [results, setResults] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [p, setP] = useState({ numbers: '', losingCarrier: '', accountNumber: '', pin: '' });

  const search = async () => { setError(null); try { setResults(await api(`/v1/numbers/available?${new URLSearchParams(Object.entries({ country: s.country, type: s.type, areaCode: s.areaCode, vanity: s.vanity }).filter(([, v]) => v) as any)}`)); } catch (e) { setError((e as Error).message); } };
  const purchase = async (e164: string) => { try { await api('/v1/numbers', { body: { e164, vanity: s.vanity || undefined, temporaryDays: s.temporaryDays ? Number(s.temporaryDays) : undefined } }); setBuy(false); setResults(null); reload(); } catch (e) { setError((e as Error).message); } };
  const update = async (id: string, body: object) => { await api(`/v1/numbers/${id}`, { method: 'PATCH', body }); reload(); };
  const release = async (id: string) => { if (confirm('Release this number? It may not be recoverable.')) { await api(`/v1/numbers/${id}`, { method: 'DELETE' }); reload(); } };
  const submitPort = async () => { try { await api('/v1/numbers/port-requests', { body: { ...p, numbers: p.numbers.split(/[,\n]/).map((n) => n.trim()).filter(Boolean), pin: p.pin || undefined } }); setPort(false); reloadPorts(); } catch (e) { setError((e as Error).message); } };

  return (
    <>
      <PageHeader title="Phone numbers" subtitle="Local, toll-free, vanity, international and temporary numbers." actions={<><button className="btn-outline" onClick={() => setPort(true)}>Port numbers</button><button className="btn-primary" onClick={() => setBuy(true)}><Icon name="plus" className="h-4 w-4" />Get a number</button></>} />
      <Card className="overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full"><thead className="bg-slate-50 dark:bg-slate-800/50"><tr><th className="th">Number</th><th className="th">Type</th><th className="th">Label</th><th className="th">Routing</th><th className="th">Assigned to</th><th className="th">Monthly</th><th className="th" /></tr></thead>
          <tbody>{data?.map((n) => (
            <tr key={n.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="td font-medium">{fmtPhone(n.e164)} <span className="ml-1 text-xs text-slate-400">{n.country}</span></td>
              <td className="td"><Badge color={n.type === 'toll_free' ? 'violet' : n.type === 'international' ? 'blue' : n.type === 'temporary' ? 'amber' : 'gray'}>{n.type.replace('_', '-')}</Badge></td>
              <td className="td"><input className="input py-1 text-xs" defaultValue={n.label ?? ''} onBlur={(e) => e.target.value !== (n.label ?? '') && update(n.id, { label: e.target.value || null })} aria-label="Label" /></td>
              <td className="td"><select className="input py-1 text-xs" value={n.routingFlowId ?? ''} onChange={(e) => update(n.id, { routingFlowId: e.target.value || null })} aria-label="Routing flow"><option value="">Direct to user</option>{flows?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></td>
              <td className="td"><select className="input py-1 text-xs" value={n.assignedUserId ?? ''} onChange={(e) => update(n.id, { assignedUserId: e.target.value || null })} aria-label="Assigned user"><option value="">Company</option>{users?.data.map((u: any) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select></td>
              <td className="td tabular-nums">{fmtMoney(n.monthlyCostCents)}</td>
              <td className="td text-right"><button className="btn-ghost text-xs text-rose-600" onClick={() => release(n.id)}>Release</button></td>
            </tr>))}</tbody></table></div>
      </Card>
      {ports && ports.length > 0 && <Card title="Port requests" className="mt-6"><ul className="space-y-2 text-sm">{ports.map((r) => <li key={r.id} className="flex justify-between"><span>{r.numbers.join(', ')} from {r.losingCarrier}</span><Badge color="amber">{r.status}</Badge></li>)}</ul></Card>}
      <Modal open={buy} onClose={() => setBuy(false)} title="Get a phone number">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Country"><select className="input" value={s.country} onChange={(e) => setS({ ...s, country: e.target.value })}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
          <Field label="Type"><select className="input" value={s.type} onChange={(e) => setS({ ...s, type: e.target.value })}><option value="local">Local</option><option value="toll_free">Toll-free</option></select></Field>
          <Field label="Area code"><input className="input" value={s.areaCode} onChange={(e) => setS({ ...s, areaCode: e.target.value })} placeholder="415" /></Field>
          <Field label="Vanity word"><input className="input" value={s.vanity} onChange={(e) => setS({ ...s, vanity: e.target.value })} placeholder="FLOWERS" /></Field>
          <Field label="Temporary (days, optional)"><input className="input" type="number" min={1} max={90} value={s.temporaryDays} onChange={(e) => setS({ ...s, temporaryDays: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn-primary w-full" onClick={search}><Icon name="search" className="h-4 w-4" />Search</button></div>
        </div>
        <div className="mt-3"><ErrorNote error={error} /></div>
        {results && <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">{results.map((r) => <li key={r.e164} className="flex items-center justify-between px-3 py-2 text-sm"><span><span className="font-medium">{fmtPhone(r.e164)}</span> <span className="text-slate-500">{r.locality}</span></span><span className="flex items-center gap-3"><span className="text-slate-500">{fmtMoney(r.monthlyCostCents)}/mo</span><button className="btn-outline py-1" onClick={() => purchase(r.e164)}>Buy</button></span></li>)}</ul>}
      </Modal>
      <Modal open={port} onClose={() => setPort(false)} title="Port numbers to CloudConnect" footer={<><button className="btn-ghost" onClick={() => setPort(false)}>Cancel</button><button className="btn-primary" onClick={submitPort}>Submit request</button></>}>
        <div className="space-y-3">
          <Field label="Numbers (one per line)"><textarea className="input" rows={3} value={p.numbers} onChange={(e) => setP({ ...p, numbers: e.target.value })} /></Field>
          <Field label="Current carrier"><input className="input" value={p.losingCarrier} onChange={(e) => setP({ ...p, losingCarrier: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Account number"><input className="input" value={p.accountNumber} onChange={(e) => setP({ ...p, accountNumber: e.target.value })} /></Field><Field label="Port-out PIN"><input className="input" type="password" value={p.pin} onChange={(e) => setP({ ...p, pin: e.target.value })} /></Field></div>
          <p className="text-xs text-slate-500">We’ll email a Letter of Authorization (LOA) for e-signature. Typical FOC: 5–10 business days.</p>
        </div>
      </Modal>
    </>
  );
}
