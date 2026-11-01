import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { Alert, Badge, DefinitionList, Empty, ErrorAlert, Field, Loading, Modal, PageHeader, Section, StatusBadge } from '../components/Ui';
import { fmtDate, fmtDateTime, plural } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import type { DocStatus } from '../types';
import { DeadlineBadge, GDPR_STATUS, GDPR_TYPES, isClosed, type Assignee, type GdprRequest } from './GdprRequests';

interface Decision {
  documentId: number;
  decision: string;
  note: string | null;
  retentionUntil: string | null;
  documentStatus: string;
  decidedBy: string;
  decidedAt: string;
  title: string | null;
  regLabel: string | null;
}
interface FoundDocument {
  id: number;
  title: string;
  regLabel: string | null;
  status: DocStatus;
  personalData: boolean;
  retentionUntil: string | null;
  retentionActive: boolean;
  archivedAt: string | null;
  typeName: string;
  departmentName: string;
  decision: string | null;
  decisionNote: string | null;
}
interface SearchResult { scope: string; limit: number; total: number; notVisible: number; items: FoundDocument[] }

const DECISIONS: Record<string, string> = {
  pastrare_retentie: 'Se păstrează: termen de păstrare în curs',
  eliminare_la_expirare: 'De eliminat prin arhivă, după expirarea termenului',
  fara_legatura: 'Nu privește persoana vizată',
  alta: 'Altă decizie (vezi nota)',
};

export default function GdprRequestDetailPage() {
  const { id } = useParams();
  const request = useAsync(() => api<GdprRequest & { decisions: Decision[] }>(`/gdpr/requests/${id}`), [id]);
  const r = request.data;
  usePageTitle(r ? `Cerere GDPR ${r.id}` : 'Cerere GDPR');

  if (request.loading && !r) return <Loading />;
  if (!r) return <ErrorAlert error={request.error} retry={() => void request.reload()} />;

  return (
    <>
      <p><Link to="/gdpr/cereri">← Înapoi la Cereri GDPR</Link></p>
      <PageHeader title={`Cerere de ${(GDPR_TYPES[r.type] ?? r.type).toLowerCase()}: ${r.subjectName}`} subtitle={`Cererea nr. ${r.id}, înregistrată de ${r.createdBy}.`} />
      {r.overdue && <Alert kind="error" title="Termenul legal de 30 de zile a fost depășit">Termenul a fost {fmtDate(r.dueOn)}.</Alert>}
      <div className="stack">
        <Section title="Cerere">
          <DefinitionList items={[
            { label: 'Persoana vizată', value: r.subjectName },
            { label: 'Identificator', value: r.subjectIdentifier },
            { label: 'Primită', value: fmtDate(r.receivedOn) },
            { label: 'Termen legal', value: <>{fmtDate(r.dueOn)} <DeadlineBadge request={r} /></> },
            { label: 'Închisă', value: r.closedAt ? fmtDateTime(r.closedAt) : null },
          ]} />
        </Section>
        <ResolutionForm request={r} onSaved={() => void request.reload()} />
        <DocumentSearch request={r} onDecided={() => void request.reload()} />
        <DecisionsList decisions={r.decisions} />
      </div>
    </>
  );
}

function ResolutionForm({ request, onSaved }: { request: GdprRequest; onSaved: () => void }) {
  const assignees = useAsync(() => api<Assignee[]>('/gdpr/requests/assignees'), []);
  const [status, setStatus] = useState(request.status);
  const [note, setNote] = useState(request.resolutionNote ?? '');
  const [assigneeId, setAssigneeId] = useState(request.assigneeId ? String(request.assigneeId) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setStatus(request.status);
    setNote(request.resolutionNote ?? '');
    setAssigneeId(request.assigneeId ? String(request.assigneeId) : '');
  }, [request.status, request.resolutionNote, request.assigneeId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/gdpr/requests/${request.id}`, { method: 'PATCH', body: { status, resolutionNote: note.trim() || null, assigneeId: assigneeId || null } });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Soluționare">
      <form className="stack" onSubmit={submit}>
        <ErrorAlert error={error ?? assignees.error} />
        {saved && <Alert kind="success">Modificările au fost salvate.</Alert>}
        {request.type === 'stergere' && (
          <Alert kind="info">SeaDoc nu șterge automat documente pentru o cerere. Documentele aflate în termenul de păstrare nu se pot șterge: consemnați decizia pentru fiecare document. Eliminarea se face doar prin fluxul de arhivă, după expirarea termenului.</Alert>
        )}
        <div className="form-grid">
          <Field label="Stare" required>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {Object.entries(GDPR_STATUS).map(([value, s]) => <option key={value} value={value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Responsabil">
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Nealocat</option>
              {assignees.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </select>
          </Field>
          <Field label="Notă de soluționare" required={isClosed(status)} className="form-grid-full" hint="Obligatorie la închiderea cererii.">
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează'}</button></div>
      </form>
    </Section>
  );
}

function DocumentSearch({ request, onDecided }: { request: GdprRequest; onDecided: () => void }) {
  const [all, setAll] = useState(false);
  const [searched, setSearched] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [deciding, setDeciding] = useState<FoundDocument | null>(null);
  const scope = all ? 'all' : undefined;
  const closed = isClosed(request.status);

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<SearchResult>(`/gdpr/requests/${request.id}/search${qs({ scope })}`));
      setSearched(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  // Căutarea rulează doar la cerere: fiecare rulare se înregistrează în audit.
  useEffect(() => { setSearched(false); setResult(null); }, [all]);

  return (
    <Section
      title="Documente care menționează persoana"
      actions={searched ? <a className="btn btn-sm" href={`/api/gdpr/requests/${request.id}/export${qs({ scope })}`}>Export CSV</a> : undefined}
    >
      <div className="stack">
        <p className="hint">Căutare full-text după nume{request.subjectIdentifier ? ' și identificator' : ''}. Exportul conține lista găsită și jurnalul de acces al acestor documente.</p>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <span>Toate documentele, nu doar cele marcate cu date personale</span>
        </label>
        <div><button type="button" className="btn" disabled={busy} onClick={() => void search()}>{busy ? 'Se caută…' : 'Caută documente'}</button></div>
        <ErrorAlert error={error} />
        {result && result.notVisible > 0 && (
          <Alert kind="warning" title="Rezultate incomplete">
            {plural(result.notVisible, 'document este', 'documente sunt')} în afara accesului dumneavoastră. Cererea trebuie continuată de un administrator.
          </Alert>
        )}
        {result && result.total > result.items.length && <Alert kind="warning">Se afișează primele {result.items.length} din {result.total}.</Alert>}
        {result && result.items.length === 0 && result.notVisible === 0 && <Empty title="Niciun document nu menționează persoana în acest domeniu." />}
        {result && result.items.length > 0 && (
          <div className="table-cards-wrap">
            <table className="table table-cards">
              <caption className="visually-hidden">Documente găsite</caption>
              <thead>
                <tr>
                  <th scope="col">Număr</th>
                  <th scope="col">Document</th>
                  <th scope="col">Stare</th>
                  <th scope="col">Păstrare</th>
                  <th scope="col">Decizie</th>
                  <th scope="col"><span className="visually-hidden">Acțiune</span></th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((d) => (
                  <tr key={d.id}>
                    <td data-label="Număr" className="cell-nowrap">{d.regLabel ?? '–'}</td>
                    <td data-label="Document" className="cell-grow">
                      <Link to={`/documente/${d.id}`} className="doc-title-link">{d.title}</Link>
                      <div className="muted cell-small">{d.typeName} · {d.departmentName}{d.personalData ? ' · date personale' : ''}</div>
                    </td>
                    <td data-label="Stare"><StatusBadge status={d.status} /></td>
                    <td data-label="Păstrare" className="cell-nowrap">
                      {d.retentionUntil ? fmtDate(d.retentionUntil) : d.archivedAt ? 'Permanent' : 'Neînceput'}
                      {d.retentionActive && <div><Badge tone="info">Nu se poate șterge</Badge></div>}
                    </td>
                    <td data-label="Decizie" className="cell-wrap cell-small">
                      {d.decision ? DECISIONS[d.decision] ?? d.decision : '–'}
                      {d.decisionNote && <div className="muted">{d.decisionNote}</div>}
                    </td>
                    <td className="cell-actions">
                      {!closed && <button type="button" className="btn btn-sm" onClick={() => setDeciding(d)}>Consemnează decizia</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {deciding && (
        <DecisionDialog
          requestId={request.id}
          doc={deciding}
          onClose={() => setDeciding(null)}
          onDone={() => { setDeciding(null); onDecided(); void search(); }}
        />
      )}
    </Section>
  );
}

function DecisionDialog({ requestId, doc, onClose, onDone }: { requestId: number; doc: FoundDocument; onClose: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState(doc.decision ?? (doc.retentionActive ? 'pastrare_retentie' : 'eliminare_la_expirare'));
  const [note, setNote] = useState(doc.decisionNote ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/gdpr/requests/${requestId}/decisions/${doc.id}`, { method: 'PUT', body: { decision, note: note.trim() || undefined } });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Consemnează decizia"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Renunță</button>
          <button type="submit" form="decizie-gdpr" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează decizia'}</button>
        </>
      )}
    >
      <form id="decizie-gdpr" className="stack" onSubmit={submit}>
        <ErrorAlert error={error} />
        <p><strong>{doc.title}</strong></p>
        <p className="hint">Decizia se consemnează; documentul nu se modifică și nu se șterge.</p>
        <Field label="Decizie" required>
          <select value={decision} onChange={(e) => setDecision(e.target.value)}>
            {Object.entries(DECISIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Notă" required={decision === 'alta'}><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} required={decision === 'alta'} /></Field>
      </form>
    </Modal>
  );
}

function DecisionsList({ decisions }: { decisions: Decision[] }) {
  if (decisions.length === 0) return null;
  return (
    <Section title="Decizii consemnate">
      <ul className="row-list">
        {decisions.map((d) => (
          <li key={d.documentId} className="row-static">
            <span className="row-title">{d.title ? <Link to={`/documente/${d.documentId}`}>{d.regLabel ? `${d.regLabel}: ` : ''}{d.title}</Link> : `Document #${d.documentId} (fără acces)`}</span>
            <span>{DECISIONS[d.decision] ?? d.decision}{d.note ? `. ${d.note}` : ''}</span>
            <span className="row-sub">{d.decidedBy}, {fmtDateTime(d.decidedAt)}{d.retentionUntil ? ` · păstrare până la ${fmtDate(d.retentionUntil)}` : ''}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
