import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { ActionNotice } from '../../components/TaskActions';
import { Empty, ErrorAlert, Field, Loading, Modal } from '../../components/Ui';
import { plural } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';
import type { DocumentType, Meta, TypeField } from '../../types';

const FIELD_TYPES: { value: TypeField['type']; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'date', label: 'Dată' },
  { value: 'number', label: 'Număr' },
];

export default function DocumentTypesPage() {
  usePageTitle('Tipuri de document');
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [editing, setEditing] = useState<DocumentType | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <div className="toolbar">
        <p className="hint toolbar-grow">Câmpurile de metadate se configurează aici, fără programare, și apar automat în formularul de înregistrare și în căutarea avansată.</p>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>Tip nou</button>
      </div>
      <ActionNotice message={notice} onDismiss={() => setNotice(null)} />
      <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
      {meta.loading && !meta.data && <Loading />}
      {meta.data && meta.data.documentTypes.length === 0 && <Empty title="Nu există tipuri de document." />}
      {meta.data && meta.data.documentTypes.length > 0 && (
        <div className="table-cards-wrap">
          <table className="table table-cards">
            <caption className="visually-hidden">Tipuri de document</caption>
            <thead>
              <tr>
                <th scope="col">Denumire</th>
                <th scope="col">Nomenclator</th>
                <th scope="col">Păstrare</th>
                <th scope="col">Metadate</th>
                <th scope="col"><span className="visually-hidden">Acțiune</span></th>
              </tr>
            </thead>
            <tbody>
              {meta.data.documentTypes.map((t) => (
                <tr key={t.id}>
                  <td data-label="Denumire" className="cell-grow"><strong>{t.name}</strong></td>
                  <td data-label="Nomenclator">{t.nomenclatorCode}</td>
                  <td data-label="Păstrare">{t.retentionYears === null ? 'Permanent' : plural(t.retentionYears, 'an', 'ani')}</td>
                  <td data-label="Metadate" className="cell-wrap">{t.fields.length ? t.fields.map((f) => f.label).join(', ') : '–'}</td>
                  <td className="cell-actions"><button type="button" className="btn btn-sm" onClick={() => setEditing(t)}>Editează</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <TypeDialog
          type={editing === 'new' ? null : editing}
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

const toKey = (label: string) => {
  const key = label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  return /^[a-z]/.test(key) ? key : key ? `c_${key}`.slice(0, 50) : '';
};

interface DraftField extends TypeField { uid: number; keyEdited: boolean; existing: boolean }

function TypeDialog({ type, onClose, onSaved }: { type: DocumentType | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [name, setName] = useState(type?.name ?? '');
  const [code, setCode] = useState(type?.nomenclatorCode ?? '');
  const [years, setYears] = useState(type?.retentionYears === null || type?.retentionYears === undefined ? '' : String(type.retentionYears));
  const [nextUid, setNextUid] = useState(1000);
  const [fields, setFields] = useState<DraftField[]>(() => (type?.fields ?? []).map((f, i) => ({
    ...f, required: !!f.required, uid: i, keyEdited: true, existing: true,
  })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const patch = (uid: number, change: Partial<DraftField>) => setFields((prev) => prev.map((f) => (f.uid === uid ? { ...f, ...change } : f)));
  const add = () => {
    setFields((prev) => [...prev, { uid: nextUid, key: '', label: '', type: 'text', required: false, keyEdited: false, existing: false }]);
    setNextUid(nextUid + 1);
  };
  const move = (uid: number, delta: number) => setFields((prev) => {
    const index = prev.findIndex((f) => f.uid === uid);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= prev.length) return prev;
    const next = prev.slice();
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      nomenclatorCode: code.trim(),
      retentionYears: years === '' ? null : Number(years),
      fields: fields.map(({ key, label, type: fieldType, required }) => ({ key, label: label.trim(), type: fieldType, required: !!required })),
    };
    try {
      if (type) await api(`/admin/document-types/${type.id}`, { method: 'PATCH', body });
      else await api('/admin/document-types', { method: 'POST', body });
      onSaved(type ? 'Tipul de document a fost actualizat.' : 'Tipul de document a fost creat.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={type ? `Editare: ${type.name}` : 'Tip de document nou'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Renunță</button>
          <button type="submit" form="type-form" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează'}</button>
        </>
      )}
    >
      <form id="type-form" onSubmit={submit}>
        <ErrorAlert error={error} />
        <div className="form-grid">
          <Field label="Denumire" required><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Indicativ nomenclator" required><input value={code} onChange={(e) => setCode(e.target.value)} required /></Field>
          <Field label="Termen de păstrare (ani)" hint="Gol înseamnă păstrare permanentă.">
            <input type="number" min={0} max={200} step={1} value={years} onChange={(e) => setYears(e.target.value)} />
          </Field>
        </div>
        <fieldset className="fieldset">
          <legend>Câmpuri de metadate (fără programare)</legend>
          {fields.length === 0 && <p className="muted">Acest tip nu are încă metadate proprii.</p>}
          <ul className="field-builder">
            {fields.map((field, index) => (
              <li key={field.uid} className="field-builder-row">
                <Field label="Etichetă" required>
                  <input
                    value={field.label}
                    required
                    onChange={(e) => patch(field.uid, { label: e.target.value, ...(field.keyEdited ? {} : { key: toKey(e.target.value) }) })}
                  />
                </Field>
                <Field label="Cheie" hint={field.existing ? 'Schimbarea cheii nu migrează valorile existente.' : undefined}>
                  <input
                    value={field.key}
                    required
                    pattern="[a-z][a-z0-9_]{0,49}"
                    title="Litere mici fără diacritice, cifre și liniuță de subliniere; începe cu o literă"
                    spellCheck={false}
                    autoCapitalize="none"
                    onChange={(e) => patch(field.uid, { key: e.target.value, keyEdited: true })}
                  />
                </Field>
                <Field label="Tip">
                  <select value={field.type} onChange={(e) => patch(field.uid, { type: e.target.value as TypeField['type'] })}>
                    {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
                <label className="check field-builder-check">
                  <input type="checkbox" checked={!!field.required} onChange={(e) => patch(field.uid, { required: e.target.checked })} />
                  <span>Obligatoriu</span>
                </label>
                <span className="btn-row field-builder-actions">
                  <button type="button" className="btn btn-sm" disabled={index === 0} onClick={() => move(field.uid, -1)}>Sus<span className="visually-hidden">: {field.label}</span></button>
                  <button type="button" className="btn btn-sm" disabled={index === fields.length - 1} onClick={() => move(field.uid, 1)}>Jos<span className="visually-hidden">: {field.label}</span></button>
                  <button type="button" className="btn btn-sm" onClick={() => setFields((prev) => prev.filter((f) => f.uid !== field.uid))}>Elimină<span className="visually-hidden">: {field.label}</span></button>
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-sm" onClick={add}>Adaugă câmp</button>
        </fieldset>
      </form>
    </Modal>
  );
}
