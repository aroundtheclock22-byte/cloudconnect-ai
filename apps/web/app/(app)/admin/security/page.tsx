'use client';
import { useState } from 'react';
import { Badge, Card, ErrorNote, PageHeader, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/useApi';
import { fmtRelative } from '@/lib/format';

export default function Security() {
  const { me, reload: reloadMe } = useAuth();
  const { data: s } = useApi<any>('/v1/security/overview');
  const { data: logs } = useApi<any[]>('/v1/audit-logs?limit=100');
  const { data: sessions, reload } = useApi<any[]>('/v1/auth/sessions');
  const { data: org } = useApi<any>('/v1/organization');
  const [mfa, setMfa] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const enable = async () => { try { await api('/v1/auth/mfa/enable', { body: { code } }); setMfa(null); reloadMe(); } catch (e) { setError((e as Error).message); } };
  const toggle = async (key: string, value: boolean) => { await api('/v1/organization', { method: 'PATCH', body: { settings: { [key]: value } } }); };

  return (
    <>
      <PageHeader title="Security & audit" subtitle="MFA, sessions, compliance controls, fraud protection and audit trail." />
      {s && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="MFA coverage" value={`${Math.round((s.mfa.mfaEnabled / Math.max(1, s.mfa.users)) * 100)}%`} hint={`${s.mfa.mfaEnabled} of ${s.mfa.users} users`} icon="shield" tone="emerald" />
        <Stat label="Active sessions" value={s.sessions.active} icon="users" />
        <Stat label="Failed logins (24h)" value={s.failedLogins.reduce((a: number, f: any) => a + f.attempts, 0)} icon="x" tone="rose" />
        <Stat label="Fraud events" value={s.fraudEvents.length} hint="toll fraud / IRSF / velocity" icon="globe" tone="amber" />
      </div>}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Your account security">
          <div className="space-y-4 text-sm">
            <div className="flex items-center justify-between"><span>Two-factor authentication</span>{me?.mfaEnabled ? <Badge color="green">Enabled</Badge> : <button className="btn-outline py-1" onClick={async () => setMfa(await api('/v1/auth/mfa/setup', { body: {} }))}>Enable</button>}</div>
            {mfa && <div className="space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60"><p>Add this key to your authenticator app:</p><code className="block break-all rounded bg-white p-2 text-xs dark:bg-slate-900">{mfa.secret}</code>
              <input className="input font-mono" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} aria-label="MFA code" /><ErrorNote error={error} /><button className="btn-primary w-full" onClick={enable}>Verify & enable</button></div>}
            <div><p className="mb-2 font-medium">Active sessions</p><ul className="space-y-2">{sessions?.map((x) => <li key={x.id} className="flex items-center justify-between gap-2 text-xs"><span className="truncate">{x.user_agent?.slice(0, 40) ?? 'Unknown device'} · {x.ip}</span><button className="text-rose-600" onClick={async () => { await api(`/v1/auth/sessions/${x.id}`, { method: 'DELETE' }); reload(); }}>Revoke</button></li>)}</ul></div>
          </div>
        </Card>
        <Card title="Organization policies">
          {org && <ul className="space-y-3 text-sm">
            {[['mfaRequired', 'Require MFA for all users'], ['recordAllCalls', 'Record all calls automatically']].map(([k, l]) => <li key={k} className="flex items-center justify-between"><span>{l}</span><input type="checkbox" defaultChecked={!!org.settings?.[k]} onChange={(e) => toggle(k, e.target.checked)} aria-label={l} /></li>)}
            <li className="flex items-center justify-between"><span>HIPAA mode (BAA)</span><Badge color={org.hipaaEnabled ? 'green' : 'gray'}>{org.hipaaEnabled ? 'On' : 'Enterprise'}</Badge></li>
            <li className="flex items-center justify-between"><span>Data residency</span><Badge color="blue">{org.dataRegion}</Badge></li>
            <li className="flex items-center justify-between"><span>Encryption at rest</span><Badge color="green">AES-256</Badge></li>
            <li className="flex items-center justify-between"><span>Voice media</span><Badge color="green">TLS + SRTP</Badge></li>
            <li className="flex items-center justify-between"><span>Allowed calling countries</span><span className="text-xs text-slate-500">{org.settings?.allowedCountries?.join(', ') ?? 'All (fraud-screened)'}</span></li>
          </ul>}
        </Card>
        <Card title="Fraud & failed logins">
          <ul className="space-y-2 text-xs">{s?.fraudEvents.slice(0, 6).map((f: any, i: number) => <li key={i} className="flex justify-between"><span><Badge color={f.action === 'blocked' ? 'red' : 'amber'}>{f.action}</Badge> {f.kind} → {f.details?.to}</span><span className="text-slate-400">{fmtRelative(f.createdAt)}</span></li>)}
            {s?.failedLogins.map((f: any) => <li key={f.ip} className="flex justify-between"><span>{f.ip}</span><span>{f.attempts} failed</span></li>)}
            {!s?.fraudEvents.length && !s?.failedLogins.length && <li className="text-slate-500">No suspicious activity.</li>}</ul>
        </Card>
      </div>
      <Card title="Audit log" className="mt-6 overflow-hidden">
        <div className="-m-5 overflow-x-auto"><table className="w-full"><thead className="bg-slate-50 dark:bg-slate-800/50"><tr><th className="th">When</th><th className="th">Actor</th><th className="th">Action</th><th className="th">Target</th><th className="th">IP</th></tr></thead>
          <tbody>{logs?.map((l) => <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800"><td className="td text-slate-500">{fmtRelative(l.createdAt)}</td><td className="td">{l.actorName ?? l.actorType}</td><td className="td font-mono text-xs">{l.action}</td><td className="td font-mono text-xs text-slate-500">{l.targetId?.slice(0, 8) ?? '—'}</td><td className="td text-slate-500">{l.ip ?? '—'}</td></tr>)}</tbody></table></div>
      </Card>
    </>
  );
}
