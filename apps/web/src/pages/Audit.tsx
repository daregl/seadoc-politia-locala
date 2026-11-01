import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { AuditTable } from '../components/AuditTable';
import { Alert, Empty, ErrorAlert, Field, Loading, PageHeader, Pagination } from '../components/Ui';
import { fmtNumber } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { AUDIT_ACTIONS } from '../labels';
import type { AuditRow, AuditVerify, Meta, Paged } from '../types';

const LIMIT = 50;
const FILTERS = ['documentId', 'userId', 'action', 'from', 'to'] as const;

export default function AuditPage() {
  usePageTitle('Audit');
  const { can } = useAuth();
  const full = can('audit_all');
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const offset = Number(params.get('offset') ?? 0) || 0;
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const list = useAsync(() => {
    const send = new URLSearchParams(query);
    send.set('limit', String(LIMIT));
    return api<Paged<AuditRow>>(`/audit?${send.toString()}`);
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

  const exportQuery = qs(Object.fromEntries(FILTERS.map((key) => [key, params.get(key)])));
  const actions = Object.entries(AUDIT_ACTIONS).filter(([code]) => full || code.startsWith('arhiva.'));

  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<unknown>(null);
  const runVerify = async () => {
    setVerifying(true);
    setVerifyError(null);
    setVerify(null);
    try {
      setVerify(await api<AuditVerify>('/audit/verify'));
    } catch (err) {
      setVerifyError(err);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Audit"
        subtitle={full
          ? 'Orice modificare ulterioară a unui rând devine detectabilă.'
          : 'Contul dumneavoastră vede doar acțiunile din arhivă.'}
        actions={(
          <>
            <a className="btn" href={`/api/audit/export${exportQuery}`}>Export CSV</a>
            {full && (
              <button type="button" className="btn btn-primary" onClick={runVerify} disabled={verifying}>
                {verifying ? 'Se verifică…' : 'Verifică lanțul'}
              </button>
            )}
          </>
        )}
      />
      <ErrorAlert error={verifyError} />
      {verify && verify.ok && (
        <Alert kind="success" title="Lanțul de audit este integru">
          Au fost verificate {fmtNumber(verify.checked)} înregistrări și nu a fost găsită nicio alterare.
        </Alert>
      )}
      {verify && !verify.ok && (
        <Alert kind="error" title="Lanțul de audit a fost alterat">
          Prima neconcordanță apare la înregistrarea nr. {String(verify.brokenAt)}, din {fmtNumber(verify.checked)} verificate. Sesizați responsabilul de securitate.
        </Alert>
      )}

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
          <Field label="Acțiune">
            <select value={form.action ?? ''} onChange={(e) => set('action', e.target.value)}>
              <option value="">Toate acțiunile</option>
              {actions.map(([code, label]) => <option key={code} value={code}>{label} ({code})</option>)}
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
      {list.data && list.data.items.length === 0 && <Empty title="Nicio înregistrare nu corespunde filtrelor." />}
      {list.data && list.data.items.length > 0 && (
        <>
          <AuditTable items={list.data.items} caption="Înregistrări din jurnalul de audit" />
          <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={goTo} />
        </>
      )}
    </>
  );
}
