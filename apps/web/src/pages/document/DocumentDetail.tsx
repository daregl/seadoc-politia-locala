import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Star } from 'lucide-react';
import { api, errorMessage, qs } from '../../api';
import { useAuth } from '../../auth';
import { ActionNotice, TaskActions } from '../../components/TaskActions';
import { Alert, Badge, DefinitionList, Empty, ErrorAlert, Loading, Section, StatusBadge } from '../../components/Ui';
import { fmtDate, fmtDateTime } from '../../format';
import { useAsync, useInterval, usePageTitle } from '../../hooks';
import { DIRECTION_LABELS, DUPLICATE_KIND, TASK_KIND } from '../../labels';
import type { DocDetail, DocDuplicate, DocStatusResponse, Task } from '../../types';
import { DocPreview } from './DocPreview';
import { ErpSection } from './ErpSection';
import { LinksSection } from './LinksSection';
import { RetentionSection } from './RetentionSection';
import { SignaturesSection } from './SignaturesSection';
import { OcrBadges, VersionsSection } from './VersionsSection';
import { WorkflowSection } from './WorkflowSection';

const isPending = (status: string) => status === 'in_asteptare' || status === 'in_lucru';

export default function DocumentDetailRoute() {
  const { id } = useParams();
  return <DocumentDetailPage key={id} id={Number(id)} />;
}

function DocumentDetailPage({ id }: { id: number }) {
  const { can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: doc, error, loading, reload, setData } = useAsync(() => api<DocDetail>(`/documents/${id}`), [id]);
  const tasks = useAsync(() => api<Task[]>(`/tasks${qs({ scope: 'open' })}`), [id]);
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [favError, setFavError] = useState<string | null>(null);
  const taskRef = useRef<HTMLDivElement>(null);
  usePageTitle(doc ? doc.regLabel ?? doc.title : 'Fișa documentului');

  const registered = (location.state as { registered?: string } | null)?.registered;
  const myTasks = (tasks.data ?? []).filter((t) => t.documentId === id);

  useEffect(() => {
    if (location.hash === '#sarcina' && myTasks.length > 0) taskRef.current?.scrollIntoView({ block: 'start' });
  }, [location.hash, myTasks.length]);

  // Versiunea cea mai nouă este prima în listă.
  const latest = doc?.versions[0];
  const version = doc?.versions.find((v) => v.versionNo === selected) ?? latest;
  const polling = !!doc?.versions.some((v) => isPending(v.ocrStatus));

  useInterval(async () => {
    try {
      const status = await api<DocStatusResponse>(`/documents/${id}/status`);
      setData((prev) => {
        const current = prev as DocDetail;
        return {
          ...current,
          duplicates: status.duplicates,
          versions: current.versions.map((v) => {
            const next = status.versions.find((s) => s.versionNo === v.versionNo);
            return next ? { ...v, ...next } : v;
          }),
        };
      });
    } catch {
      // O eroare trecătoare nu oprește interogarea; o sesiune pierdută este tratată în api.ts.
    }
  }, 3000, polling);

  const toggleFavorite = async () => {
    if (!doc) return;
    setFavError(null);
    try {
      await api(`/documents/${doc.id}/favorite`, { method: doc.favorite ? 'DELETE' : 'PUT' });
      setData({ ...doc, favorite: !doc.favorite });
    } catch (err) {
      setFavError(errorMessage(err));
    }
  };

  const afterAction = (message: string) => {
    setNotice(message);
    void reload();
    void tasks.reload();
  };

  if (!Number.isInteger(id)) return <Alert kind="error">Adresa documentului nu este validă.</Alert>;
  if (error && !doc) return <ErrorAlert error={error} retry={() => void reload()} />;
  if (loading && !doc) return <Loading label="Se încarcă documentul…" />;
  if (!doc || !version) return <Empty title="Documentul nu are versiuni." />;

  const metadataRows = doc.type.fields.map((f) => ({ label: f.label, value: fmtMeta(doc.metadata?.[f.key], f.type) }));
  const canSeeAudit = can('audit_all') || can('archive_journal');

  return (
    <div className="doc-page">
      {registered !== undefined && (
        <div className="registered" role="status">
          <div>
            <p className="registered-label">Document înregistrat cu numărul</p>
            <p className="registered-number">{registered || 'fără număr de registru'}</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => navigate(location.pathname, { replace: true, state: null })}>Închide</button>
        </div>
      )}

      <Link to="/documente" className="back-link">← Documente</Link>

      <header className="doc-header">
        <div className="doc-header-text">
          <p className="doc-number">{doc.regLabel ?? 'Fără număr de registru'}</p>
          <h1>{doc.title}</h1>
          <div className="doc-facts">
            <StatusBadge status={doc.status} />
            {doc.personalData && <Badge tone="warning">Date personale</Badge>}
            <span>{doc.type.name}</span>
            <span>{doc.department}</span>
          </div>
        </div>
        <div className="doc-header-actions">
          {canSeeAudit && <Link className="btn" to={`/audit${qs({ documentId: doc.id })}`} aria-label="Audit document">Audit</Link>}
          <button
            type="button"
            className="btn btn-icon"
            aria-pressed={doc.favorite}
            aria-label={doc.favorite ? 'Elimină de la favorite' : 'Adaugă la favorite'}
            title={doc.favorite ? 'Elimină de la favorite' : 'Adaugă la favorite'}
            onClick={toggleFavorite}
          >
            <Star className="star-icon" size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <ActionNotice message={notice} onDismiss={() => setNotice(null)} />
      {favError && <Alert kind="error">{favError}</Alert>}
      {error ? <ErrorAlert error={error} retry={() => void reload()} /> : null}
      <ErrorAlert error={tasks.error} retry={() => void tasks.reload()} />

      {myTasks.length > 0 && (
        <div id="sarcina" ref={taskRef} className="my-tasks">
          {myTasks.map((task) => (
            <section key={task.id} className="my-task" aria-label={`Sarcina mea: ${task.name}`}>
              <div className="my-task-head">
                <div>
                  <p className="my-task-kicker">Sarcina dumneavoastră: {TASK_KIND[task.kind] ?? task.kind}</p>
                  <h2>{task.name}</h2>
                </div>
                <div className="my-task-due">
                  {task.overdue && <Badge tone="danger">Termen depășit</Badge>}
                  {task.dueAt && <span className="muted">Termen: {fmtDateTime(task.dueAt)}</span>}
                </div>
              </div>
              {task.comment && (
                <p className="task-card-comment">
                  <strong>{task.kind === 'completare' ? 'Informații cerute: ' : 'Comentariu: '}</strong>{task.comment}
                </p>
              )}
              <TaskActions task={task} onDone={afterAction} />
            </section>
          ))}
        </div>
      )}

      {doc.duplicates.length > 0 && <DuplicatesWarning duplicates={doc.duplicates} />}

      <div className="doc-grid">
        <div className="doc-col-main">
          <Section
            title={doc.versions.length > 1 ? `Document: versiunea ${version.versionNo}` : 'Document'}
            actions={<span aria-live="polite">{version.ocrStatus !== 'finalizat' && version.ocrStatus !== 'neaplicabil' && <OcrBadges version={version} />}</span>}
          >
            <DocPreview doc={doc} version={version} />
          </Section>
          <VersionsSection doc={doc} selected={version.versionNo} onSelect={setSelected} onUploaded={async () => { setSelected(null); await reload(); }} />
          <LinksSection doc={doc} onChanged={reload} />
          <ErpSection doc={doc} />
        </div>
        <div className="doc-col-side">
          <Section title="Detalii">
            <DefinitionList items={[
              { label: 'Data înregistrării', value: fmtDateTime(doc.regDate) },
              { label: 'Registru', value: doc.register },
              { label: 'Direcție', value: doc.direction ? DIRECTION_LABELS[doc.direction] : null },
              { label: 'Emitent', value: doc.issuer },
              { label: 'Destinatar', value: doc.recipient },
              { label: 'Termen', value: fmtDate(doc.dueDate) },
              { label: 'Dosar', value: doc.folder },
              { label: 'Proprietar', value: doc.owner },
              { label: 'Creat la', value: fmtDateTime(doc.createdAt) },
              ...metadataRows,
            ]} />
            {doc.summary && (
              <div className="doc-summary">
                <h3>Rezumat</h3>
                <p>{doc.summary}</p>
              </div>
            )}
          </Section>
          <WorkflowSection doc={doc} onStarted={afterAction} />
          <SignaturesSection doc={doc} onSigned={afterAction} />
          <RetentionSection doc={doc} onArchived={afterAction} />
        </div>
      </div>
    </div>
  );
}

function fmtMeta(value: string | undefined, type: string): string | null {
  if (!value) return null;
  return type === 'date' ? fmtDate(value) : value;
}

function DuplicatesWarning({ duplicates }: { duplicates: DocDuplicate[] }) {
  // Același document poate apărea pe mai multe criterii: se afișează o singură dată.
  const visible = [...new Map(duplicates.filter((d) => !d.restricted).map((d) => [d.id, d])).values()];
  const kindsOf = (id: DocDuplicate['id']) => duplicates.filter((d) => d.id === id).map((d) => DUPLICATE_KIND[d.kind] ?? d.kind).join(', ');
  const hasRestricted = duplicates.some((d) => d.restricted);
  return (
    <Alert kind="warning" title="Atenție: posibil duplicat">
      {visible.length > 0 && (
        <ul className="alert-list">
          {visible.map((d) => (
            <li key={d.id}>
              <Link to={`/documente/${d.id}`}>{d.regLabel ?? 'Fără număr'} · {d.title}</Link>
              {' '}({kindsOf(d.id)})
            </li>
          ))}
        </ul>
      )}
      {hasRestricted && <p>Există un document similar la care nu aveți acces.</p>}
    </Alert>
  );
}
