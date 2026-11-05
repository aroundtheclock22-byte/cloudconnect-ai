'use client';
import { useState } from 'react';
import { Avatar, Badge, Card, ErrorNote, Field, Modal, PageHeader } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/useApi';
import { fmtRelative } from '@/lib/format';

const ROLES = ['COMPANY_OWNER', 'ADMINISTRATOR', 'BILLING_ADMIN', 'MANAGER', 'SUPERVISOR', 'AGENT', 'RECEPTIONIST', 'EMPLOYEE', 'READ_ONLY'];
const label = (r: string) => r.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default function Users() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const { data, reload } = useApi<any>(`/v1/users?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`, [q]);
  const { data: teams, reload: reloadTeams } = useApi<any[]>('/v1/teams');
  const [invite, setInvite] = useState(false);
  const [f, setF] = useState({ email: '', firstName: '', lastName: '', role: 'EMPLOYEE', department: '' });
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<any>(null);
  const [team, setTeam] = useState('');

  const submit = async () => { setError(null); try { setCreated(await api('/v1/users', { body: { ...f, department: f.department || undefined } })); reload(); } catch (e) { setError((e as Error).message); } };
  const setRole = async (id: string, role: string) => { try { await api(`/v1/users/${id}`, { method: 'PATCH', body: { role } }); reload(); } catch (e) { alert((e as Error).message); } };
  const suspend = async (u: any) => { await api(`/v1/users/${u.id}`, { method: 'PATCH', body: { status: u.status === 'suspended' ? 'active' : 'suspended' } }); reload(); };
  const addTeam = async () => { if (!team) return; await api('/v1/teams', { body: { name: team } }); setTeam(''); reloadTeams(); };

  return (
    <>
      <PageHeader title="Users & teams" subtitle={`${data?.total ?? 0} users · unlimited extensions`} actions={<button className="btn-primary" onClick={() => { setInvite(true); setCreated(null); }}><Icon name="plus" className="h-4 w-4" />Invite user</button>} />
      <div className="grid gap-6 xl:grid-cols-4">
        <Card className="overflow-hidden xl:col-span-3">
          <div className="border-b border-slate-100 p-3 dark:border-slate-800"><input className="input max-w-xs" placeholder="Search name, email or extension" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" /></div>
          <div className="overflow-x-auto"><table className="w-full"><thead className="bg-slate-50 dark:bg-slate-800/50"><tr><th className="th">User</th><th className="th">Ext.</th><th className="th">Role</th><th className="th">Status</th><th className="th">MFA</th><th className="th">Last login</th><th className="th" /></tr></thead>
            <tbody>{data?.data.map((u: any) => (
              <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="td"><div className="flex items-center gap-3"><Avatar name={`${u.firstName} ${u.lastName}`} presence={u.presence} size="sm" /><div><p className="font-medium">{u.firstName} {u.lastName}</p><p className="text-xs text-slate-500">{u.email}</p></div></div></td>
                <td className="td font-mono">{u.extension}</td>
                <td className="td"><select className="input py-1 text-xs" value={u.role} disabled={u.id === me?.id} onChange={(e) => setRole(u.id, e.target.value)} aria-label="Role">{ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></td>
                <td className="td"><Badge color={u.status === 'active' ? 'green' : u.status === 'invited' ? 'amber' : 'red'}>{u.status}</Badge></td>
                <td className="td">{u.mfaEnabled ? <Badge color="green">On</Badge> : <Badge>Off</Badge>}</td>
                <td className="td text-slate-500">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : 'Never'}</td>
                <td className="td text-right">{u.id !== me?.id && <button className="btn-ghost text-xs" onClick={() => suspend(u)}>{u.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button>}</td>
              </tr>))}</tbody></table></div>
        </Card>
        <Card title="Teams">
          <ul className="space-y-2 text-sm">{teams?.map((t) => <li key={t.id} className="flex justify-between"><span className="font-medium">{t.name}</span><span className="text-slate-500">{t.memberIds.length} members</span></li>)}</ul>
          <div className="mt-4 flex gap-2"><input className="input" placeholder="New team" value={team} onChange={(e) => setTeam(e.target.value)} aria-label="New team name" /><button className="btn-outline" onClick={addTeam}>Add</button></div>
        </Card>
      </div>
      <Modal open={invite} onClose={() => setInvite(false)} title="Invite user" footer={created ? <button className="btn-primary" onClick={() => setInvite(false)}>Done</button> : <><button className="btn-ghost" onClick={() => setInvite(false)}>Cancel</button><button className="btn-primary" onClick={submit}>Send invite</button></>}>
        {created ? (
          <div className="space-y-2 text-sm"><p>✅ Invitation sent to <b>{created.email}</b>. Extension <b>{created.extension}</b> assigned.</p>{created.tempPassword && <p className="rounded bg-amber-50 p-2 text-amber-900">Dev mode temporary password: <code>{created.tempPassword}</code></p>}</div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name"><input className="input" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
            <Field label="Last name"><input className="input" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
            <div className="col-span-2"><Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field></div>
            <Field label="Role"><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
            <Field label="Department"><input className="input" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
            <div className="col-span-2"><ErrorNote error={error} /></div>
          </div>
        )}
      </Modal>
    </>
  );
}
