import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AuditTable } from '../components/AuditTable';
import { Empty, ErrorAlert, Field, Loading, PageHeader, Pagination } from '../components/Ui';
import { useAsync, usePageTitle } from '../hooks';
import type { AuditRow, Meta, Paged } from '../types';

const LIMIT = 50;
const FILTERS = ['documentId', 'userId', 'from', 'to'] as const;

export default function GdprPage() {
  usePageTitle('GDPR');
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const offset = Number(params.get('offset') ?? 0) || 0;
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const list = useAsync(() => {
    const send = new URLSearchParams(query);
    send.set('limit', String(LIMIT));
    // Pașii cererilor GDPR sunt tot `gdpr.*`, dar această pagină arată doar accesările de documente.
    send.set('action', 'gdpr.acces_date_personale');
    return api<Paged<AuditRow>>(`/gdpr/access-log?${send.toString()}`);
  }, [query]);

  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => { setForm(Object.fromEntries(new URLSearchParams(query).entries())); }, [query]);
  const set = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const key of FILTERS) {
      const value = form[key]?.trim();
      if (value) next.set(key, value);
    }
    setParams(next);
  };
  const goTo = (nextOffset: number) => {
    const next = new URLSearchParams(params);
    if (nextOffset) next.set('offset', String(nextOffset));
    else next.delete('offset');
    setParams(next);
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <PageHeader title="GDPR: jurnal de acces" subtitle="Cine a consultat documente cu date personale, când și de unde." actions={<Link className="btn" to="/gdpr/cereri">Cereri GDPR</Link>} />
      <form className="filter-box" onSubmit={apply}>
        <div className="form-grid form-grid-dense">
          <Field label="Document (nr. intern)">
            <input inputMode="numeric" value={form.documentId ?? ''} onChange={(e) => set('documentId', e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Utilizator">
            <select value={form.userId ?? ''} onChange={(e) => set('userId', e.target.value)}>
              <option value="">Toți utilizatorii</option>
              {meta.data?.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
          </Field>
          <Field label="De la data"><input type="date" value={form.from ?? ''} onChange={(e) => set('from', e.target.value)} /></Field>
          <Field label="Până la data"><input type="date" value={form.to ?? ''} onChange={(e) => set('to', e.target.value)} /></Field>
        </div>
        <div className="filter-actions">
          <button type="submit" className="btn btn-primary">Filtrează</button>
          {FILTERS.some((key) => params.get(key)) && <button type="button" className="btn btn-link" onClick={() => setParams({})}>Șterge filtrele</button>}
        </div>
        <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
      </form>
      <ErrorAlert error={list.error} retry={() => void list.reload()} />
      {list.loading && !list.data && <Loading />}
      {list.data && list.data.items.length === 0 && <Empty title="Nu există accesări înregistrate pentru aceste filtre." />}
      {list.data && list.data.items.length > 0 && (
        <>
          <AuditTable items={list.data.items} caption="Accesări ale documentelor cu date personale" />
          <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={goTo} />
        </>
      )}
    </>
  );
}
