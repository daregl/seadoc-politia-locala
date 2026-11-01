import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAuth, useUser } from '../../auth';
import { Alert, ErrorAlert, Field, Loading, Section } from '../../components/Ui';
import { useAsync } from '../../hooks';
import type { DocDetail, WorkflowSummary } from '../../types';

export function WorkflowSection({ doc, onStarted }: { doc: DocDetail; onStarted: (message: string) => void }) {
  const { can } = useAuth();
  const user = useUser();
  const mayStart = doc.canEdit && doc.status !== 'in_flux' && (can('register') || doc.ownerId === user.id);
  const flows = useAsync(() => (mayStart ? api<WorkflowSummary[]>('/workflows') : Promise.resolve([])), [mayStart]);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!key) { setProblem('Alegeți fluxul de pornit.'); return; }
    setProblem(null);
    setBusy(true);
    setError(null);
    try {
      await api(`/workflows/${encodeURIComponent(key)}/start`, { method: 'POST', body: { documentId: doc.id } });
      setKey('');
      onStarted('Fluxul a pornit. Titularii primului pas au primit sarcini și notificări.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Flux de lucru"
      actions={<Link to={`/documente/${doc.id}/flux`} className="panel-link">Diagrama</Link>}
    >
      {doc.status === 'in_flux' && <p className="muted">Documentul este într-un flux activ. Starea fiecărui pas se vede în diagramă.</p>}
      {!mayStart && doc.status !== 'in_flux' && (
        <p className="muted">{doc.canEdit ? 'Fluxul poate fi pornit de registratură sau de proprietarul documentului.' : 'Un document arhivat nu mai poate intra într-un flux.'}</p>
      )}
      {mayStart && (
        <form onSubmit={start} className="inline-row">
          <ErrorAlert error={flows.error} retry={() => void flows.reload()} />
          <ErrorAlert error={error} />
          {problem && <Alert kind="error">{problem}</Alert>}
          {flows.loading && !flows.data && <Loading label="Se încarcă fluxurile…" />}
          {flows.data && flows.data.length === 0 && <p className="muted">Nu există fluxuri publicate.</p>}
          {flows.data && flows.data.length > 0 && (
            <div className="inline-row-fields">
              <Field label="Flux de pornit">
                <select value={key} onChange={(e) => setKey(e.target.value)}>
                  <option value="">Alegeți fluxul</option>
                  {flows.data.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.name} (v{f.version}{f.departmentName ? `, ${f.departmentName}` : ''})
                    </option>
                  ))}
                </select>
              </Field>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se pornește…' : 'Pornește fluxul'}</button>
            </div>
          )}
        </form>
      )}
    </Section>
  );
}
