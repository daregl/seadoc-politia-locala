import { lazy, Suspense } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Badge, DefinitionList, ErrorAlert, Loading, PageHeader, Section } from '../components/Ui';
import { fmtDateTime } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import type { WorkflowFull, WorkflowVersion } from '../types';

const WorkflowEditor = lazy(() => import('../bpmn/WorkflowEditor'));
const DiagramViewer = lazy(() => import('../bpmn/DiagramViewer'));

export default function WorkflowDetailPage() {
  const { key } = useParams();
  usePageTitle(key ? 'Flux' : 'Flux nou');
  const flow = useAsync(() => (key ? api<WorkflowFull>(`/workflows/${encodeURIComponent(key)}`) : Promise.resolve(null)), [key]);
  const versions = useAsync(() => (key ? api<WorkflowVersion[]>(`/workflows/${encodeURIComponent(key)}/versions`) : Promise.resolve([])), [key]);

  if (flow.error && !flow.data) {
    return (
      <>
        <PageHeader title="Flux" actions={<Link className="btn" to="/fluxuri">Înapoi la fluxuri</Link>} />
        <ErrorAlert error={flow.error} retry={() => void flow.reload()} />
      </>
    );
  }
  if (flow.loading && flow.data === undefined) return <Loading label="Se încarcă fluxul…" />;
  const definition = flow.data ?? null;

  const versionList = definition && (
    <Section title="Versiuni publicate">
      <ErrorAlert error={versions.error} retry={() => void versions.reload()} />
      {versions.loading && !versions.data && <Loading />}
      {versions.data && (
        <ul className="row-list">
          {versions.data.map((v) => (
            <li key={v.version} className="row-static">
              <span className="row-title">Versiunea {v.version} {v.version === definition.version && <Badge tone="info">curentă</Badge>}</span>
              <span className="row-sub">{fmtDateTime(v.createdAt)}{v.createdBy ? ` · ${v.createdBy}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );

  if (!definition || definition.canEdit) {
    return (
      <Suspense fallback={<Loading label="Se încarcă editorul de fluxuri…" />}>
        {/* La o versiune nouă, editorul pornește curat de la XML-ul publicat. */}
        <WorkflowEditor
          key={definition ? `${definition.key}-${definition.version}` : 'nou'}
          definition={definition}
          onPublished={() => { void flow.reload(); void versions.reload(); }}
        />
        {versionList}
      </Suspense>
    );
  }

  return (
    <>
      <PageHeader
        title={definition.name}
        subtitle="Vizualizare. Nu aveți drept de editare pe acest flux."
        actions={<Link className="btn" to="/fluxuri">Înapoi la fluxuri</Link>}
      />
      <Section title="Diagrama">
        <DefinitionList items={[
          { label: 'Versiune curentă', value: definition.version },
          { label: 'Departament', value: definition.departmentName ?? 'Toate departamentele' },
          { label: 'Descriere', value: definition.description },
        ]} />
        <Suspense fallback={<Loading label="Se încarcă diagrama…" />}>
          <DiagramViewer xml={definition.xml} label={`Diagrama fluxului ${definition.name}`} />
        </Suspense>
      </Section>
      {versionList}
    </>
  );
}
