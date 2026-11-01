import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { ActionNotice } from '../../components/TaskActions';
import { Empty, ErrorAlert, Field, Loading, Modal } from '../../components/Ui';
import { useAsync, usePageTitle } from '../../hooks';
import { indentedDepartments, walkTree } from '../../tree';
import type { Department, Meta } from '../../types';

export default function OrganizationPage() {
  usePageTitle('Organigramă');
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [editing, setEditing] = useState<Department | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tree = useMemo(() => walkTree(meta.data?.departments ?? []), [meta.data]);

  return (
    <>
      <div className="toolbar toolbar-end">
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')} disabled={!meta.data}>Departament nou</button>
      </div>
      <ActionNotice message={notice} onDismiss={() => setNotice(null)} />
      <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
      {meta.loading && !meta.data && <Loading />}
      {meta.data && tree.length === 0 && <Empty title="Organigrama este goală." />}
      {tree.length > 0 && (
        <ul className="tree">
          {tree.map(({ item, depth }) => (
            <li key={item.id} className="tree-row" style={{ marginInlineStart: `${depth * 1.5}rem` }}>
              <div className="tree-text">
                <strong>{item.name}</strong>
                <span className="muted cell-small">{item.managerName ? `Manager: ${item.managerName}` : 'Fără manager desemnat'}</span>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setEditing(item)}>Editează<span className="visually-hidden"> {item.name}</span></button>
            </li>
          ))}
        </ul>
      )}
      {editing && meta.data && (
        <DepartmentDialog
          department={editing === 'new' ? null : editing}
          meta={meta.data}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            void meta.reload();
          }}
        />
      )}
    </>
  );
}

function DepartmentDialog({ department, meta, onClose, onSaved }: {
  department: Department | null; meta: Meta; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(department?.name ?? '');
  const [parentId, setParentId] = useState(String(department?.parentId ?? ''));
  const [managerId, setManagerId] = useState(String(department?.managerId ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const parents = useMemo(
    () => indentedDepartments(meta.departments).filter((d) => d.id !== department?.id),
    [meta.departments, department],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      parentId: parentId ? Number(parentId) : null,
      managerId: managerId ? Number(managerId) : null,
    };
    try {
      if (department) await api(`/admin/departments/${department.id}`, { method: 'PATCH', body });
      else await api('/admin/departments', { method: 'POST', body });
      onSaved(department ? 'Departamentul a fost actualizat.' : 'Departamentul a fost creat.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={department ? `Editare: ${department.name}` : 'Departament nou'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Renunță</button>
          <button type="submit" form="department-form" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează'}</button>
        </>
      )}
    >
      <form id="department-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Denumire" required><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Subordonat lui">
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Nivel superior</option>
            {parents.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </Field>
        <Field label="Manager" hint="Primește sarcinile de tip „manager departament” și escaladările de termen.">
          <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">Fără manager</option>
            {meta.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}{u.jobTitle ? `, ${u.jobTitle}` : ''}</option>)}
          </select>
        </Field>
      </form>
    </Modal>
  );
}
