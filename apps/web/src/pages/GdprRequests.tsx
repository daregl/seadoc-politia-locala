import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Alert, Badge, Empty, ErrorAlert, Field, Loading, Modal, PageHeader, Pagination } from '../components/Ui';
import { fmtDate, plural } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import type { Tone } from '../labels';

export interface GdprRequest {
  id: number;
  type: string;
  subjectName: string;
  subjectIdentifier: string | null;
  receivedOn: string;
  dueOn: string;
  status: string;
  resolutionNote: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
  overdue: boolean;
  daysLeft: number;
}
export interface Assignee { id: number; fullName: string }

export const GDPR_TYPES: Record<string, string> = {
  acces: 'Acces',
  rectificare: 'Rectificare',
  stergere: 'Ștergere',
  restrictionare: 'Restricționare',
  opozitie: 'Opoziție',
  portabilitate: 'Portabilitate',
};
export const GDPR_STATUS: Record<string, { label: string; tone: Tone }> = {
  inregistrata: { label: 'Înregistrată', tone: 'info' },
  in_lucru: { label: 'În lucru', tone: 'warning' },
  solutionata: { label: 'Soluționată', tone: 'success' },
  respinsa: { label: 'Respinsă', tone: 'neutral' },
};
export const isClosed = (status: string) => status === 'solutionata' || status === 'respinsa';

export function DeadlineBadge({ request }: { request: Pick<GdprRequest, 'status' | 'overdue' | 'daysLeft'> }) {
  if (isClosed(request.status)) return null;
  if (request.overdue) return <Badge tone="danger">Depășit cu {plural(-request.daysLeft, 'zi', 'zile')}</Badge>;
  if (request.daysLeft === 0) return <Badge tone="warning">Expiră azi</Badge>;
  if (request.daysLeft <= 7) return <Badge tone="warning">Mai are {plural(request.daysLeft, 'zi', 'zile')}</Badge>;
  return <Badge tone="neutral">Mai are {plural(request.daysLeft, 'zi', 'zile')}</Badge>;
}

const LIMIT = 25;

export default function GdprRequestsPage() {
  usePageTitle('Cereri GDPR');
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const offset = Number(params.get('offset') ?? 0) || 0;
  const list = useAsync(() => {
    const send = new URLSearchParams(query);
    send.set('limit', String(LIMIT));
    return api<{ total: number; overdue: number; items: GdprRequest[] }>(`/gdpr/requests?${send.toString()}`);
  }, [query]);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.delete('offset');
    if (value) next.set(key, value);
    else next.delete(key);
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
      <p><Link to="/gdpr">← Înapoi la jurnalul de acces GDPR</Link></p>
      <PageHeader
        title="Cereri GDPR"
        subtitle="Cererile persoanelor vizate. Termenul legal este de 30 de zile de la primire."
        actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>Cerere nouă</button>}
      />
      {list.data && list.data.overdue > 0 && (
        <Alert kind="error" title={`${plural(list.data.overdue, 'cerere are', 'cereri au')} termenul depășit`}>
          <button type="button" className="btn btn-sm alert-action" onClick={() => setFilter('overdue', '1')}>Arată-le</button>
        </Alert>
      )}
      <div className="filter-box">
        <div className="form-grid form-grid-dense">
          <Field label="Stare">
            <select value={params.get('status') ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Toate stările</option>
              {Object.entries(GDPR_STATUS).map(([value, s]) => <option key={value} value={value}>{s.label}</option>)}
            </select>
          </Field>
          <label className="check form-grid-end">
            <input type="checkbox" checked={params.get('overdue') === '1'} onChange={(e) => setFilter('overdue', e.target.checked ? '1' : '')} />
            <span>Doar cu termen depășit</span>
          </label>
        </div>
      </div>
      <ErrorAlert error={list.error} retry={() => void list.reload()} />
      {list.loading && !list.data && <Loading />}
      {list.data && list.data.items.length === 0 && <Empty title="Nu există cereri pentru aceste filtre." />}
      {list.data && list.data.items.length > 0 && (
        <>
          <div className="table-cards-wrap">
            <table className="table table-cards">
              <caption className="visually-hidden">Cereri ale persoanelor vizate</caption>
              <thead>
                <tr>
                  <th scope="col">Nr.</th>
                  <th scope="col">Persoana vizată</th>
                  <th scope="col">Tip</th>
                  <th scope="col">Primită</th>
                  <th scope="col">Termen</th>
                  <th scope="col">Stare</th>
                  <th scope="col">Responsabil</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.id} className={r.overdue ? 'row-overdue' : undefined}>
                    <td data-label="Nr.">{r.id}</td>
                    <td data-label="Persoana vizată" className="cell-grow"><Link to={`/gdpr/cereri/${r.id}`} className="doc-title-link">{r.subjectName}</Link></td>
                    <td data-label="Tip">{GDPR_TYPES[r.type] ?? r.type}</td>
                    <td data-label="Primită" className="cell-nowrap">{fmtDate(r.receivedOn)}</td>
                    <td data-label="Termen">
                      <span className="cell-nowrap">{fmtDate(r.dueOn)}</span>
                      <div><DeadlineBadge request={r} /></div>
                    </td>
                    <td data-label="Stare"><Badge tone={GDPR_STATUS[r.status]?.tone ?? 'neutral'}>{GDPR_STATUS[r.status]?.label ?? r.status}</Badge></td>
                    <td data-label="Responsabil">{r.assigneeName ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={goTo} />
        </>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`/gdpr/cereri/${id}`)} />}
    </>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const assignees = useAsync(() => api<Assignee[]>('/gdpr/requests/assignees'), []);
  const [type, setType] = useState('acces');
  const [subjectName, setSubjectName] = useState('');
  const [subjectIdentifier, setSubjectIdentifier] = useState('');
  const [receivedOn, setReceivedOn] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date()));
  const [assigneeId, setAssigneeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<GdprRequest>('/gdpr/requests', {
        method: 'POST',
        body: { type, subjectName: subjectName.trim(), subjectIdentifier: subjectIdentifier.trim() || undefined, receivedOn, assigneeId: assigneeId || undefined },
      });
      onCreated(r.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Cerere nouă"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Renunță</button>
          <button type="submit" form="cerere-gdpr" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Înregistrează cererea'}</button>
        </>
      )}
    >
      <form id="cerere-gdpr" className="stack" onSubmit={submit}>
        <ErrorAlert error={error ?? assignees.error} />
        <Field label="Tip cerere" required>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(GDPR_TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Numele persoanei vizate" required><input value={subjectName} onChange={(e) => setSubjectName(e.target.value)} required /></Field>
        <Field label="Identificator" hint="CNP, număr de marcă sau altă valoare după care persoana apare în documente.">
          <input value={subjectIdentifier} onChange={(e) => setSubjectIdentifier(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Data primirii" required hint="Termenul de 30 de zile se calculează din această dată.">
          <input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} required />
        </Field>
        <Field label="Responsabil">
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Nealocat</option>
            {assignees.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </select>
        </Field>
      </form>
    </Modal>
  );
}
