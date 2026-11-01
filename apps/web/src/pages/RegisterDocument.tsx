import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useUser } from '../auth';
import { DocPicker, type PickedDoc } from '../components/DocPicker';
import { ERP_KIND_LABEL, erpRecordLabel, ErpPicker, type ErpRecord } from '../components/ErpPicker';
import { FileDrop } from '../components/FileDrop';
import { Alert, ErrorAlert, Field, Loading, PageHeader, Section } from '../components/Ui';
import { useAsync, usePageTitle } from '../hooks';
import { DIRECTION_LABELS, LINK_KIND } from '../labels';
import { fmtSize, senderLabel } from '../format';
import { indentedDepartments, indentedFolders } from '../tree';
import type { Direction, Meta, TypeField } from '../types';
import type { InboxMessage } from './EmailMessage';

export default function RegisterDocumentPage() {
  usePageTitle('Înregistrare document');
  const user = useUser();
  const navigate = useNavigate();
  const meta = useAsync(() => api<Meta>('/meta'), []);
  // Deschis din „Email primit”: fișierul este atașamentul ales, iar câmpurile vin din mesaj.
  const [searchParams] = useSearchParams();
  const emailId = searchParams.get('email');
  const attachmentId = Number(searchParams.get('atasament'));
  const email = useAsync(() => (emailId ? api<InboxMessage>(`/mail/inbox/${emailId}`) : Promise.resolve(null)), [emailId]);
  const emailAttachment = email.data?.attachments.find((a) => a.id === attachmentId && a.available && !a.refusedReason);

  const [direction, setDirection] = useState<Direction>('intrat');
  const [title, setTitle] = useState('');
  const [registerId, setRegisterId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [issuer, setIssuer] = useState('');
  const [recipient, setRecipient] = useState('');
  const [summary, setSummary] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [departmentId, setDepartmentId] = useState(user.departmentId ? String(user.departmentId) : '');
  const [folderId, setFolderId] = useState('');
  const [personalData, setPersonalData] = useState(false);
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [link, setLink] = useState<PickedDoc | null>(null);
  const [linkKind, setLinkKind] = useState('raspuns_la');
  const [erpRecords, setErpRecords] = useState<ErpRecord[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!email.data) return;
    setTitle(email.data.subject);
    setIssuer(senderLabel(email.data));
    setDirection('intrat');
  }, [email.data?.id]);

  const type = meta.data?.documentTypes.find((t) => String(t.id) === typeId);
  const registers = useMemo(() => (meta.data?.registers ?? []).filter((r) => r.active
    && (r.documentTypeId === null || !typeId || String(r.documentTypeId) === typeId)
    && (r.departmentId === null || !departmentId || String(r.departmentId) === departmentId)), [meta.data, typeId, departmentId]);
  const folders = useMemo(() => indentedFolders(meta.data?.folders ?? [])
    .filter((f) => f.departmentId === null || !departmentId || String(f.departmentId) === departmentId), [meta.data, departmentId]);
  const departments = useMemo(() => indentedDepartments(meta.data?.departments ?? []), [meta.data]);
  const registerStillValid = registers.some((r) => String(r.id) === registerId);
  const folderStillValid = folders.some((f) => String(f.id) === folderId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    setError(null);
    if (!emailId && !file) { setProblem('Atașați fișierul documentului.'); return; }
    const form = new FormData();
    if (file && !emailId) form.set('file', file);
    form.set('title', title.trim());
    form.set('direction', direction);
    if (registerId && registerStillValid) form.set('registerId', registerId);
    if (issuer.trim()) form.set('issuer', issuer.trim());
    if (recipient.trim()) form.set('recipient', recipient.trim());
    if (summary.trim()) form.set('summary', summary.trim());
    if (dueDate) form.set('dueDate', dueDate);
    form.set('documentTypeId', typeId);
    if (departmentId) form.set('departmentId', departmentId);
    if (folderId && folderStillValid) form.set('folderId', folderId);
    const values = Object.fromEntries((type?.fields ?? [])
      .map((f) => [f.key, (metadata[f.key] ?? '').trim()])
      .filter(([, value]) => value));
    form.set('metadata', JSON.stringify(values));
    form.set('personalData', String(personalData));
    if (link) {
      form.set('linkToId', String(link.id));
      form.set('linkKind', linkKind);
    }
    setBusy(true);
    try {
      const res = emailId
        ? await api<{ id: number; regLabel: string | null }>(`/mail/inbox/${emailId}/register`, {
          method: 'POST',
          body: { ...Object.fromEntries(form.entries()), attachmentId },
        })
        : await api<{ id: number; regLabel: string | null }>('/documents', { method: 'POST', form });
      // Documentul există deja: o legătură ERP eșuată nu anulează înregistrarea, ci se semnalează pe fișa lui.
      let erpFailed = 0;
      for (const record of erpRecords) {
        try {
          await api(`/documents/${res.id}/erp-links`, { method: 'POST', body: { recordId: record.id } });
        } catch {
          erpFailed++;
        }
      }
      navigate(`/documente/${res.id}`, { state: { registered: res.regLabel ?? '', erpFailed } });
    } catch (err) {
      setError(err);
      window.scrollTo({ top: 0 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-page stack">
      <PageHeader title="Înregistrare document" subtitle="Numărul se alocă automat la salvare." />
      <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
      <ErrorAlert error={email.error} retry={() => void email.reload()} />
      {emailId && email.data && email.data.status !== 'nou' && <Alert kind="warning" title="Mesajul a fost deja tratat"><Link to={`/email-primit/${emailId}`}>Înapoi la mesaj</Link></Alert>}
      {emailId && email.data && !emailAttachment && email.data.status === 'nou' && <Alert kind="warning" title="Atașamentul nu se poate înregistra"><Link to={`/email-primit/${emailId}`}>Alegeți alt atașament</Link></Alert>}
      {meta.loading && !meta.data && <Loading />}
      {meta.data && (
        <form onSubmit={submit} className="stack">
          <ErrorAlert error={error} />
          {problem && <Alert kind="error">{problem}</Alert>}

          <Section title="Fișier">
            {emailId ? (
              <p>
                {emailAttachment ? <><strong>{emailAttachment.filename}</strong> ({fmtSize(emailAttachment.sizeBytes)}), din </> : 'Atașament din '}
                <Link to={`/email-primit/${emailId}`}>mesajul primit pe email</Link>.
              </p>
            ) : <FileDrop file={file} onChange={setFile} label="Fișierul documentului" required />}
          </Section>

          <Section title="Detalii document">
            <div className="form-grid">
              <fieldset className="fieldset fieldset-plain form-grid-full">
                <legend>Direcție</legend>
                <div className="radio-row">
                  {(Object.keys(DIRECTION_LABELS) as Direction[]).map((d) => (
                    <label key={d} className="radio-pill">
                      <input type="radio" name="direction" value={d} checked={direction === d} onChange={() => setDirection(d)} />
                      <span>{DIRECTION_LABELS[d]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Titlu" required className="form-grid-full">
                <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={500} />
              </Field>
              <Field label="Tip document" required>
                <select value={typeId} onChange={(e) => setTypeId(e.target.value)} required>
                  <option value="">Alegeți tipul</option>
                  {meta.data.documentTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.nomenclatorCode})</option>)}
                </select>
              </Field>
              <Field label="Departament" required>
                <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required>
                  <option value="">Alegeți departamentul</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </Field>
              <Field label="Registru" hint={registers.length === 0 ? 'Nu există un registru activ pentru alegerile făcute; documentul rămâne fără număr.' : undefined}>
                <select value={registerStillValid ? registerId : ''} onChange={(e) => setRegisterId(e.target.value)}>
                  <option value="">Fără număr de registru</option>
                  {registers.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.code})</option>)}
                </select>
              </Field>
              <Field label="Dosar">
                <select value={folderStillValid ? folderId : ''} onChange={(e) => setFolderId(e.target.value)}>
                  <option value="">Fără dosar</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </Field>
              <Field label="Emitent"><input value={issuer} onChange={(e) => setIssuer(e.target.value)} /></Field>
              <Field label="Destinatar"><input value={recipient} onChange={(e) => setRecipient(e.target.value)} /></Field>
              <Field label="Termen de soluționare"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
              <label className="check form-grid-end">
                <input type="checkbox" checked={personalData} onChange={(e) => setPersonalData(e.target.checked)} />
                <span>Conține date cu caracter personal</span>
              </label>
            </div>
          </Section>

          {type && type.fields.length > 0 && (
            <Section title={`Metadate: ${type.name}`}>
              <div className="form-grid">
                {type.fields.map((field) => (
                  <MetadataInput
                    key={field.key}
                    field={field}
                    value={metadata[field.key] ?? ''}
                    onChange={(value) => setMetadata((prev) => ({ ...prev, [field.key]: value }))}
                  />
                ))}
              </div>
            </Section>
          )}

          <Section title="Opțional: rezumat și legături" collapsible defaultOpen={summary !== '' || link !== null || erpRecords.length > 0}>
            <Field label="Rezumat">
              <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </Field>
            <div className="form-grid">
              <DocPicker value={link} onChange={setLink} label="Document legat" />
              <Field label="Tip legătură">
                <select value={linkKind} onChange={(e) => setLinkKind(e.target.value)}>
                  {Object.entries(LINK_KIND).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </Field>
            </div>
            <ErpPicker onPick={(r) => setErpRecords((list) => [...list, r])} excludeIds={erpRecords.map((r) => r.id)} />
            {erpRecords.length > 0 && (
              <ul className="row-list">
                {erpRecords.map((r) => (
                  <li key={r.id} className="row-static">
                    <span className="row-sub">{ERP_KIND_LABEL[r.kind]}</span>
                    {erpRecordLabel(r)}
                    <button type="button" className="btn btn-sm btn-link" onClick={() => setErpRecords((list) => list.filter((x) => x.id !== r.id))}>Elimină</button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-large" disabled={busy || (!!emailId && !(emailAttachment && email.data?.status === 'nou'))}>
              {busy ? 'Se înregistrează…' : 'Înregistrează documentul'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function MetadataInput({ field, value, onChange }: { field: TypeField; value: string; onChange: (value: string) => void }) {
  return (
    <Field label={field.label} required={field.required}>
      <input
        type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
        step={field.type === 'number' ? 'any' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={field.required}
      />
    </Field>
  );
}
