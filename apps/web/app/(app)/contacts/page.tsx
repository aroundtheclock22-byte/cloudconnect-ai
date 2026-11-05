'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Avatar, Badge, Card, Empty, ErrorNote, Field, Modal, PageHeader } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { useSoftphone } from '@/components/Softphone';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { fmtPhone } from '@/lib/format';

export default function ContactsPage() { return <Suspense><Contacts /></Suspense>; }

function Contacts() {
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [tab, setTab] = useState<'contacts' | 'directory'>('contacts');
  const { data, reload } = useApi<any>(`/v1/contacts?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`, [q]);
  const { data: dir } = useApi<any[]>('/v1/directory');
  const { data: dups, reload: reloadDups } = useApi<any[]>('/v1/contacts/duplicates');
  const [modal, setModal] = useState<'new' | 'import' | null>(null);
  const phone = useSoftphone();
  const fav = async (c: any) => { await api(`/v1/contacts/${c.id}`, { method: 'PATCH', body: { favorite: !c.favorite } }); reload(); };
  const exportCsv = async () => { const csv = await api<string>('/v1/contacts/export.csv', { raw: true }); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'contacts.csv'; a.click(); };
  const merge = async (ids: string[]) => { await api('/v1/contacts/merge', { body: { primaryId: ids[0], duplicateIds: ids.slice(1) } }); reload(); reloadDups(); };
  const filteredDir = dir?.filter((u) => !q || `${u.firstName} ${u.lastName} ${u.extension} ${u.department}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHeader title="Contacts" subtitle="Personal & shared contacts, company directory and CRM sync." actions={<>
        <button className="btn-outline" onClick={() => setModal('import')}><Icon name="upload" className="h-4 w-4" />Import</button>
        <button className="btn-outline" onClick={exportCsv}><Icon name="download" className="h-4 w-4" />Export</button>
        <button className="btn-primary" onClick={() => setModal('new')}><Icon name="plus" className="h-4 w-4" />Add contact</button></>} />
      {dups && dups.length > 0 && tab === 'contacts' && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <span className="font-medium">{dups.length} possible duplicate{dups.length > 1 ? 's' : ''} found.</span>
          {dups.slice(0, 3).map((d) => <button key={d.matchKey} className="underline" onClick={() => merge(d.contactIds)}>Merge {d.matchKey}</button>)}
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        {(['contacts', 'directory'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={tab === t ? 'btn bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'btn-outline'}>{t === 'contacts' ? 'Contacts' : 'Company directory'}</button>)}
        <input className="input ml-auto max-w-xs" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
      </div>
      <Card>
        {tab === 'contacts' ? (!data?.data.length ? <Empty icon="contacts" title="No contacts">Import a CSV or connect your CRM.</Empty> : (
          <div className="overflow-x-auto"><table className="w-full"><thead className="bg-slate-50 dark:bg-slate-800/50"><tr><th className="th">Name</th><th className="th">Company</th><th className="th">Phone</th><th className="th">Email</th><th className="th">Tags</th><th className="th" /></tr></thead>
            <tbody>{data.data.map((c: any) => (
              <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="td"><div className="flex items-center gap-3"><Avatar name={`${c.firstName} ${c.lastName}`.trim() || '?'} size="sm" /><span className="font-medium">{c.firstName} {c.lastName}</span><button onClick={() => fav(c)} aria-label="Toggle favorite"><Icon name="star" className={c.favorite ? 'h-4 w-4 fill-amber-400 text-amber-400' : 'h-4 w-4 text-slate-300'} /></button></div></td>
                <td className="td text-slate-500">{c.company ?? '—'}</td>
                <td className="td">{c.phones[0] ? fmtPhone(c.phones[0]) : '—'}</td>
                <td className="td text-slate-500">{c.emails[0] ?? '—'}</td>
                <td className="td"><div className="flex gap-1">{c.tags.map((t: string) => <Badge key={t} color={t === 'vip' ? 'amber' : 'gray'}>{t}</Badge>)}</div></td>
                <td className="td text-right">{c.phones[0] && <button className="btn-ghost p-1.5" onClick={() => phone.dial(c.phones[0])} aria-label={`Call ${c.firstName}`}><Icon name="phone" className="h-4 w-4" /></button>}</td>
              </tr>))}</tbody></table></div>
        )) : (
          <ul className="grid gap-px bg-slate-100 dark:bg-slate-800 sm:grid-cols-2 lg:grid-cols-3">
            {filteredDir?.map((u) => (
              <li key={u.id} className="flex items-center gap-3 bg-white p-4 dark:bg-slate-900">
                <Avatar name={`${u.firstName} ${u.lastName}`} presence={u.presence} />
                <div className="min-w-0 flex-1"><p className="truncate font-medium">{u.firstName} {u.lastName}</p><p className="truncate text-xs text-slate-500">{u.title ?? u.department} · Ext. {u.extension}</p></div>
                <button className="btn-ghost p-1.5" onClick={() => phone.dial(u.extension)} aria-label={`Call ${u.firstName}`}><Icon name="phone" className="h-4 w-4" /></button>
              </li>))}
          </ul>
        )}
      </Card>
      <NewContact open={modal === 'new'} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); reloadDups(); }} />
      <ImportCsv open={modal === 'import'} onClose={() => setModal(null)} onDone={() => { reload(); reloadDups(); }} />
    </>
  );
}

function NewContact({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ firstName: '', lastName: '', company: '', phone: '', email: '', tags: '', shared: false });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try { await api('/v1/contacts', { body: { firstName: f.firstName, lastName: f.lastName, company: f.company || undefined, phones: f.phone ? [f.phone] : [], emails: f.email ? [f.email] : [], tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), shared: f.shared } }); setF({ firstName: '', lastName: '', company: '', phone: '', email: '', tags: '', shared: false }); onSaved(); }
    catch (e) { setError((e as Error).message); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="Add contact" footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name"><input className="input" value={f.firstName} onChange={set('firstName')} /></Field>
        <Field label="Last name"><input className="input" value={f.lastName} onChange={set('lastName')} /></Field>
        <Field label="Company"><input className="input" value={f.company} onChange={set('company')} /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
        <div className="col-span-2"><Field label="Email"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field></div>
        <div className="col-span-2"><Field label="Tags (comma-separated)"><input className="input" value={f.tags} onChange={set('tags')} /></Field></div>
        <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.shared} onChange={(e) => setF({ ...f, shared: e.target.checked })} />Share with my company</label>
      </div>
      <div className="mt-3"><ErrorNote error={error} /></div>
    </Modal>
  );
}

function ImportCsv({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => { try { setResult(await api('/v1/contacts/import', { body: { csv, skipDuplicates: true } })); onDone(); } catch (e) { setError((e as Error).message); } };
  return (
    <Modal open={open} onClose={() => { setResult(null); onClose(); }} title="Import contacts" footer={<><button className="btn-ghost" onClick={onClose}>Close</button><button className="btn-primary" onClick={run} disabled={!csv}>Import</button></>}>
      <p className="mb-3 text-sm text-slate-500">Columns: first_name, last_name, company, email, phone, tags. Duplicates (by phone/email) are skipped.</p>
      <input type="file" accept=".csv,text/csv" className="mb-3 text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} aria-label="CSV file" />
      <textarea className="input font-mono text-xs" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="first_name,last_name,phone&#10;Jane,Doe,+14155550100" />
      {result && <p className="mt-3 text-sm text-emerald-700">Imported {result.imported}, skipped {result.skipped} duplicates, {result.invalid} invalid.</p>}
      <ErrorNote error={error} />
    </Modal>
  );
}
