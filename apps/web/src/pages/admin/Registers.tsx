import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { ActionNotice } from '../../components/TaskActions';
import { Badge, Empty, ErrorAlert, Field, Loading, Modal } from '../../components/Ui';
import { useAsync, usePageTitle } from '../../hooks';
import type { Meta, Register } from '../../types';

export default function RegistersPage() {
  usePageTitle('Registre');
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [editing, setEditing] = useState<Register | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const departmentName = (id: number | null) => meta.data?.departments.find((d) => d.id === id)?.name ?? 'Toate';
  const typeName = (id: number | null) => meta.data?.documentTypes.find((t) => t.id === id)?.name ?? 'Toate';

  return (
    <>
      <div className="toolbar toolbar-end">
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')} disabled={!meta.data}>Registru nou</button>
      </div>
      <ActionNotice message={notice} onDismiss={() => setNotice(null)} />
      <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
      {meta.loading && !meta.data && <Loading />}
      {meta.data && meta.data.registers.length === 0 && <Empty title="Nu există registre." />}
      {meta.data && meta.data.registers.length > 0 && (
        <div className="table-cards-wrap">
          <table className="table table-cards">
            <caption className="visually-hidden">Registre</caption>
            <thead>
              <tr>
                <th scope="col">Denumire</th>
                <th scope="col">Cod</th>
                <th scope="col">Departament</th>
                <th scope="col">Tip document</th>
                <th scope="col">Stare</th>
                <th scope="col"><span className="visually-hidden">Acțiune</span></th>
              </tr>
            </thead>
            <tbody>
              {meta.data.registers.map((r) => (
                <tr key={r.id}>
                  <td data-label="Denumire" className="cell-grow"><strong>{r.name}</strong></td>
                  <td data-label="Cod"><code>{r.code}</code></td>
                  <td data-label="Departament">{departmentName(r.departmentId)}</td>
                  <td data-label="Tip document">{typeName(r.documentTypeId)}</td>
                  <td data-label="Stare"><Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Activ' : 'Inactiv'}</Badge></td>
                  <td className="cell-actions"><button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>Editează</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && meta.data && (
        <RegisterDialog
          register={editing === 'new' ? null : editing}
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

function RegisterDialog({ register, meta, onClose, onSaved }: {
  register: Register | null; meta: Meta; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(register?.name ?? '');
  const [code, setCode] = useState(register?.code ?? '');
  const [departmentId, setDepartmentId] = useState(String(register?.departmentId ?? ''));
  const [documentTypeId, setDocumentTypeId] = useState(String(register?.documentTypeId ?? ''));
  const [active, setActive] = useState(register?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      code: code.trim(),
      departmentId: departmentId ? Number(departmentId) : null,
      documentTypeId: documentTypeId ? Number(documentTypeId) : null,
      active,
    };
    try {
      if (register) await api(`/admin/registers/${register.id}`, { method: 'PATCH', body });
      else await api('/admin/registers', { method: 'POST', body });
      onSaved(register ? 'Registrul a fost actualizat.' : 'Registrul a fost creat.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={register ? `Editare: ${register.name}` : 'Registru nou'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Renunță</button>
          <button type="submit" form="register-form" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează'}</button>
        </>
      )}
    >
      <form id="register-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <Field label="Denumire" required><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Cod" required hint="Apare în numărul de înregistrare, de exemplu REG-00012/2026."><input value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} /></Field>
        <Field label="Departament">
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Toate departamentele</option>
            {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Tip document">
          <select value={documentTypeId} onChange={(e) => setDocumentTypeId(e.target.value)}>
            <option value="">Toate tipurile</option>
            {meta.documentTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Registru activ</span>
        </label>
      </form>
    </Modal>
  );
}
