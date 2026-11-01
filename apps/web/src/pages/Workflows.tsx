import { Link } from 'react-router-dom';
import { Plus, Workflow } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorAlert, Loading, PageHeader } from '../components/Ui';
import { fmtDate } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import type { WorkflowSummary } from '../types';

export default function WorkflowsPage() {
  usePageTitle('Fluxuri');
  const { can } = useAuth();
  const { data, error, loading, reload } = useAsync(() => api<WorkflowSummary[]>('/workflows'), []);
  return (
    <>
      <PageHeader
        title="Fluxuri"
        actions={can('workflow_edit') ? <Link to="/fluxuri/nou" className="btn btn-primary"><Plus size={17} aria-hidden="true" />Flux nou</Link> : undefined}
      />
      <ErrorAlert error={error} retry={() => void reload()} />
      {loading && !data && <Loading />}
      {data && data.length === 0 && <Empty icon={Workflow} title="Nu există fluxuri publicate." />}
      {data && data.length > 0 && (
        <div className="table-cards-wrap">
          <table className="table table-cards">
            <caption className="visually-hidden">Lista fluxurilor</caption>
            <thead>
              <tr>
                <th scope="col">Denumire</th>
                <th scope="col">Departament</th>
                <th scope="col">Versiune</th>
                <th scope="col">Publicat</th>
                <th scope="col"><span className="visually-hidden">Acțiune</span></th>
              </tr>
            </thead>
            <tbody>
              {data.map((flow) => (
                <tr key={flow.key}>
                  <td data-label="Denumire" className="cell-grow">
                    <Link to={`/fluxuri/${encodeURIComponent(flow.key)}`} className="doc-title-link">{flow.name}</Link>
                    {flow.description && <div className="muted cell-small">{flow.description}</div>}
                  </td>
                  <td data-label="Departament">{flow.departmentName ?? 'Toate departamentele'}</td>
                  <td data-label="Versiune">{flow.version}</td>
                  <td data-label="Publicat">{fmtDate(flow.createdAt)}</td>
                  <td className="cell-actions">
                    <Link to={`/fluxuri/${encodeURIComponent(flow.key)}`} className="btn btn-sm">{flow.canEdit ? 'Editează' : 'Vizualizează'}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
