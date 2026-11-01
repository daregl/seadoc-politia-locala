import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { ActionNotice } from '../../components/TaskActions';
import { Empty, ErrorAlert, Field, Loading, Section } from '../../components/Ui';
import { useAsync, usePageTitle } from '../../hooks';
import { indentedFolders, walkTree } from '../../tree';
import type { Meta } from '../../types';

export default function FoldersPage() {
  usePageTitle('Dosare');
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tree = useMemo(() => walkTree(meta.data?.folders ?? []), [meta.data]);
  const options = useMemo(() => indentedFolders(meta.data?.folders ?? []), [meta.data]);
  const departmentName = (id: number | null) => meta.data?.departments.find((d) => d.id === id)?.name;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/admin/folders', {
        method: 'POST',
        body: { name: name.trim(), parentId: parentId ? Number(parentId) : null, departmentId: departmentId ? Number(departmentId) : null },
      });
      setName('');
      setNotice('Dosarul a fost creat.');
      await meta.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ActionNotice message={notice} onDismiss={() => setNotice(null)} />
      <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
      <Section title="Dosar nou">
        <form onSubmit={submit}>
          <ErrorAlert error={error} />
          <div className="form-grid">
            <Field label="Denumire" required><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
            <Field label="În dosarul">
              <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">Nivel superior</option>
                {options.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Departament">
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">Toate departamentele</option>
                {meta.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Creează dosarul'}</button>
        </form>
      </Section>
      <Section title="Dosare existente">
        {meta.loading && !meta.data && <Loading />}
        {meta.data && tree.length === 0 && <Empty title="Nu există dosare." />}
        {tree.length > 0 && (
          <ul className="tree">
            {tree.map(({ item, depth }) => (
              <li key={item.id} className="tree-row" style={{ marginInlineStart: `${depth * 1.5}rem` }}>
                <div className="tree-text">
                  <strong>{item.name}</strong>
                  <span className="muted cell-small">{departmentName(item.departmentId) ?? 'Toate departamentele'}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
