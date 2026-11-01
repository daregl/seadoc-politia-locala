import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api';
import { DocPicker, type PickedDoc } from '../../components/DocPicker';
import { ActionNotice } from '../../components/TaskActions';
import { Alert, Empty, ErrorAlert, Field, Loading, Section } from '../../components/Ui';
import { useAsync, usePageTitle } from '../../hooks';
import { indentedDepartments, indentedFolders } from '../../tree';
import type { Grant, GrantScope, Meta } from '../../types';

const SCOPES: Record<GrantScope, string> = {
  document: 'Document',
  folder: 'Dosar',
  type: 'Tip de document',
  department: 'Departament',
};

export default function GrantsPage() {
  usePageTitle('Acces controlat');
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [userId, setUserId] = useState('');
  const grants = useAsync(
    () => (userId ? api<Grant[]>(`/admin/grants${qs({ userId })}`) : Promise.resolve([])),
    [userId],
  );
  const [scope, setScope] = useState<GrantScope>('department');
  const [targetId, setTargetId] = useState('');
  const [doc, setDoc] = useState<PickedDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const targets = useMemo(() => {
    if (!meta.data) return [];
    if (scope === 'folder') return indentedFolders(meta.data.folders);
    if (scope === 'department') return indentedDepartments(meta.data.departments);
    if (scope === 'type') return meta.data.documentTypes.map((t) => ({ id: t.id, label: t.name }));
    return [];
  }, [meta.data, scope]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const target = scope === 'document' ? doc?.id : Number(targetId);
    if (!target) { setProblem('Alegeți ținta accesului.'); return; }
    setProblem(null);
    setBusy(true);
    setError(null);
    try {
      await api('/admin/grants', { method: 'POST', body: { userId: Number(userId), scope, targetId: target } });
      setTargetId('');
      setDoc(null);
      setNotice('Accesul a fost acordat.');
      await grants.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (grant: Grant) => {
    setError(null);
    try {
      await api(`/admin/grants/${grant.id}`, { method: 'DELETE' });
      setNotice('Accesul a fost revocat.');
      await grants.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <ActionNotice message={notice} onDismiss={() => setNotice(null)} />
      <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
      <div className="filter-box filter-inline">
        <Field label="Utilizator">
          <select value={userId} onChange={(e) => { setUserId(e.target.value); setNotice(null); }}>
            <option value="">Alegeți utilizatorul</option>
            {meta.data?.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}{u.departmentName ? ` (${u.departmentName})` : ''}</option>)}
          </select>
        </Field>
      </div>
      {!userId && <Alert kind="info">Alegeți un utilizator pentru a-i vedea și modifica accesul suplimentar. Accesul acordat aici se adaugă celui dat de rol și departament.</Alert>}
      {userId && (
        <>
          <Section title="Acordă acces">
            <form onSubmit={add}>
              <ErrorAlert error={error} />
              {problem && <Alert kind="error">{problem}</Alert>}
              <div className="form-grid">
                <Field label="Tip de acces">
                  <select value={scope} onChange={(e) => { setScope(e.target.value as GrantScope); setTargetId(''); setDoc(null); }}>
                    {(Object.keys(SCOPES) as GrantScope[]).map((s) => <option key={s} value={s}>{SCOPES[s]}</option>)}
                  </select>
                </Field>
                {scope === 'document'
                  ? <DocPicker value={doc} onChange={setDoc} label="Document" />
                  : (
                    <Field label={SCOPES[scope]}>
                      <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                        <option value="">Alegeți</option>
                        {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                    </Field>
                  )}
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Acordă accesul'}</button>
            </form>
          </Section>
          <Section title="Acces acordat">
            <ErrorAlert error={grants.error} retry={() => void grants.reload()} />
            {grants.loading && !grants.data && <Loading />}
            {grants.data && grants.data.length === 0 && <Empty title="Utilizatorul nu are acces suplimentar." />}
            {grants.data && grants.data.length > 0 && (
              <ul className="row-list">
                {grants.data.map((g) => (
                  <li key={g.id} className="row-static row-with-action">
                    <span>
                      <span className="row-sub">{SCOPES[g.scope] ?? g.scope}</span>{' '}
                      {g.scope === 'document'
                        ? <Link to={`/documente/${g.targetId}`}>{g.targetName ?? `#${g.targetId}`}</Link>
                        : <strong>{g.targetName ?? `#${g.targetId}`}</strong>}
                    </span>
                    <button type="button" className="btn btn-sm" onClick={() => void remove(g)}>Revocă<span className="visually-hidden"> {g.targetName}</span></button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </>
  );
}
