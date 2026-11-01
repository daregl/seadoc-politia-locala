import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import DiagramViewer, { type ViewerServices } from '../bpmn/DiagramViewer';
import { Badge, Empty, ErrorAlert, Loading, PageHeader, Section } from '../components/Ui';
import { fmtDateTime } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { INSTANCE_STATUS, TASK_KIND, TASK_STATUS } from '../labels';
import type { StepStatus, WorkflowInstance } from '../types';

const STEP_INFO: Record<StepStatus, { label: string; marker: string; symbol: string; tone: 'success' | 'info' | 'danger' | 'neutral' }> = {
  finalizat: { label: 'Finalizat', marker: 'wf-done', symbol: '✓', tone: 'success' },
  activ: { label: 'În lucru', marker: 'wf-active', symbol: '●', tone: 'info' },
  respins: { label: 'Respins', marker: 'wf-rejected', symbol: '✕', tone: 'danger' },
  anulat: { label: 'Anulat', marker: 'wf-cancelled', symbol: '–', tone: 'neutral' },
};
const ELEMENT_TYPES: Record<string, string> = {
  startEvent: 'Eveniment de start',
  endEvent: 'Eveniment de final',
  userTask: 'Sarcină',
  exclusiveGateway: 'Poartă exclusivă',
  parallelGateway: 'Poartă paralelă',
};

function paint({ canvas, registry, overlays }: ViewerServices, instance: WorkflowInstance) {
  // Un pas poate apărea de mai multe ori într-o buclă; contează ultima trecere.
  const latest = new Map(instance.steps.map((s) => [s.elementId, s.status]));
  const overdue = new Set(instance.tasks.filter((t) => t.overdue).map((t) => t.elementId));
  for (const element of registry.getAll()) {
    if (element.type === 'label' || !element.parent) continue;
    if (element.waypoints) {
      const source = element.source && latest.get(element.source.id);
      const passed = source === 'finalizat' && element.target && latest.has(element.target.id);
      canvas.addMarker(element, passed ? 'wf-done' : 'wf-untouched');
      continue;
    }
    const status = latest.get(element.id);
    if (!status) {
      canvas.addMarker(element, 'wf-untouched');
      continue;
    }
    const info = STEP_INFO[status];
    canvas.addMarker(element, info.marker);
    const chip = document.createElement('div');
    const late = status === 'activ' && overdue.has(element.id);
    chip.className = `wf-chip wf-chip-${late ? 'danger' : info.tone}`;
    chip.textContent = `${info.symbol} ${late ? 'Termen depășit' : info.label}`;
    overlays.add(element, 'wf-status', { position: { top: -26, left: 0 }, html: chip, scale: { min: 0.8, max: 1.2 } });
  }
}

export default function DocumentWorkflowPage() {
  usePageTitle('Diagrama fluxului');
  const { id } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => api<{ instances: WorkflowInstance[] }>(`/documents/${id}/workflow`), [id],
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const instances = useMemo(() => data?.instances ?? [], [data]);
  useEffect(() => { setSelectedId(null); }, [id]);
  const instance = instances.find((i) => i.id === selectedId) ?? instances[0];

  return (
    <>
      <PageHeader
        title="Diagrama fluxului"
        actions={<Link className="btn" to={`/documente/${id}`}>Înapoi la document</Link>}
      />
      <ErrorAlert error={error} retry={() => void reload()} />
      {loading && !data && <Loading label="Se încarcă fluxul…" />}
      {data && instances.length === 0 && (
        <Empty title="Documentul nu a intrat încă într-un flux.">
          <p>Fluxul se pornește din <Link to={`/documente/${id}`}>fișa documentului</Link>.</p>
        </Empty>
      )}
      {instances.length > 1 && (
        <div className="tabs" role="group" aria-label="Instanțe de flux, cea mai nouă prima">
          {instances.map((item) => (
            <button
              key={item.id}
              type="button"
              className={instance?.id === item.id ? 'tab tab-active' : 'tab'}
              aria-pressed={instance?.id === item.id}
              onClick={() => setSelectedId(item.id)}
            >
              {item.name} · {fmtDateTime(item.startedAt)}
            </button>
          ))}
        </div>
      )}
      {instance && <InstanceView key={instance.id} instance={instance} />}
    </>
  );
}

function InstanceView({ instance }: { instance: WorkflowInstance }) {
  const decorate = useCallback((services: ViewerServices) => paint(services, instance), [instance]);
  const status = INSTANCE_STATUS[instance.status] ?? { label: instance.status, tone: 'neutral' as const };
  return (
    <>
      <Section
        title={`${instance.name} (versiunea ${instance.version})`}
        actions={<Badge tone={status.tone}>{status.label}</Badge>}
      >
        <p className="muted">
          Pornit de {instance.startedBy} la {fmtDateTime(instance.startedAt)}
          {instance.finishedAt ? `, încheiat la ${fmtDateTime(instance.finishedAt)}` : ''}.
        </p>
        <DiagramViewer xml={instance.xml} label={`Diagrama fluxului ${instance.name}. Starea fiecărui pas este în tabelele de mai jos.`} decorate={decorate} />
        <ul className="legend" aria-label="Legendă">
          <li><span className="legend-swatch legend-done" aria-hidden="true">✓</span>Finalizat (verde)</li>
          <li><span className="legend-swatch legend-active" aria-hidden="true">●</span>În lucru (albastru)</li>
          <li><span className="legend-swatch legend-rejected" aria-hidden="true">✕</span>Respins (roșu)</li>
          <li><span className="legend-swatch legend-cancelled" aria-hidden="true">–</span>Anulat (gri, cu etichetă)</li>
          <li><span className="legend-swatch legend-untouched" aria-hidden="true" />Neparcurs (gri, fără etichetă)</li>
        </ul>
      </Section>

      <Section title="Sarcini">
        {instance.tasks.length === 0 ? <Empty title="Fluxul nu are încă sarcini." /> : (
          <div className="table-cards-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th scope="col">Pas</th>
                  <th scope="col">Tip</th>
                  <th scope="col">Titular</th>
                  <th scope="col">Stare</th>
                  <th scope="col">Termen</th>
                  <th scope="col">Finalizată</th>
                  <th scope="col">Comentariu</th>
                </tr>
              </thead>
              <tbody>
                {instance.tasks.map((task) => (
                  <tr key={task.id}>
                    <td data-label="Pas">{task.name}</td>
                    <td data-label="Tip">{TASK_KIND[task.kind] ?? task.kind}</td>
                    <td data-label="Titular">{task.assignee}</td>
                    <td data-label="Stare"><Badge tone={TASK_STATUS[task.status]?.tone ?? 'neutral'}>{TASK_STATUS[task.status]?.label ?? task.status}</Badge></td>
                    <td data-label="Termen">
                      {fmtDateTime(task.dueAt, 'fără termen')}
                      {task.overdue && <> <Badge tone="danger">Depășit</Badge></>}
                    </td>
                    <td data-label="Finalizată">{fmtDateTime(task.completedAt)}</td>
                    <td data-label="Comentariu" className="cell-wrap">{task.comment || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Pași parcurși">
        {instance.steps.length === 0 ? <Empty title="Fluxul nu are încă pași parcurși." /> : (
          <div className="table-cards-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th scope="col">Pas</th>
                  <th scope="col">Element</th>
                  <th scope="col">Stare</th>
                  <th scope="col">Început</th>
                  <th scope="col">Încheiat</th>
                </tr>
              </thead>
              <tbody>
                {instance.steps.map((step, index) => {
                  const info = STEP_INFO[step.status];
                  return (
                    <tr key={`${step.elementId}-${index}`}>
                      <td data-label="Pas">{step.name || '–'}</td>
                      <td data-label="Element">{ELEMENT_TYPES[step.elementType] ?? step.elementType}</td>
                      <td data-label="Stare"><Badge tone={info?.tone ?? 'neutral'}>{info?.label ?? step.status}</Badge></td>
                      <td data-label="Început">{fmtDateTime(step.startedAt)}</td>
                      <td data-label="Încheiat">{fmtDateTime(step.finishedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
