import { Link } from 'react-router-dom';
import { api } from '../api';
import { useUser } from '../auth';
import { Badge, Empty, ErrorAlert, Loading, PageHeader, Section, StatusBadge } from '../components/Ui';
import { fmtDate, fmtDateTime, fmtNumber } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { TASK_KIND } from '../labels';
import type { Dashboard } from '../types';

export default function DashboardPage() {
  usePageTitle('Panou');
  const user = useUser();
  const { data, error, loading, reload } = useAsync(() => api<Dashboard>('/dashboard'), []);

  return (
    <>
      <PageHeader title="Panou" subtitle={`Bun venit, ${user.fullName}.`} />
      <ErrorAlert error={error} retry={() => void reload()} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="stats">
            <Link to="/sarcini" className="stat">
              <span className="stat-value">{fmtNumber(data.counts.openTasks)}</span>
              <span className="stat-label">Sarcini deschise</span>
            </Link>
            <Link to="/sarcini" className={`stat ${data.counts.overdueTasks > 0 ? 'stat-alert' : ''}`}>
              <span className="stat-value">{fmtNumber(data.counts.overdueTasks)}</span>
              <span className="stat-label">Cu termen depășit</span>
            </Link>
            <Link to="/documente" className="stat">
              <span className="stat-value">{fmtNumber(data.counts.pending)}</span>
              <span className="stat-label">Documente în așteptare</span>
            </Link>
          </div>
          <div className="dash-grid">
            <Section title="Sarcinile mele" actions={<Link to="/sarcini">Toate sarcinile</Link>}>
              {data.tasks.length === 0 ? <Empty title="Nu aveți sarcini deschise." /> : (
                <ul className="row-list">
                  {data.tasks.slice(0, 8).map((task) => (
                    <li key={task.id}>
                      <Link to={`/documente/${task.documentId}#sarcina`} className="row-link">
                        <span className="row-title">{task.name}</span>
                        <span className="row-sub">{task.regLabel ?? 'Fără număr'} · {task.documentTitle}</span>
                        <span className="row-meta">
                          <Badge tone="info">{TASK_KIND[task.kind] ?? task.kind}</Badge>
                          {task.overdue && <Badge tone="danger">Termen depășit</Badge>}
                          {task.dueAt && <span className="muted">Termen: {fmtDateTime(task.dueAt)}</span>}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Documente în așteptare" actions={<Link to="/documente">Toate documentele</Link>}>
              {data.pendingDocuments.length === 0 ? <Empty title="Nu există documente în așteptare." /> : (
                <ul className="row-list">
                  {data.pendingDocuments.slice(0, 8).map((doc) => (
                    <li key={doc.id}>
                      <Link to={`/documente/${doc.id}`} className="row-link">
                        <span className="row-title">{doc.title}</span>
                        <span className="row-sub">{doc.regLabel ?? 'Fără număr'} · {fmtDate(doc.createdAt)}</span>
                        <span className="row-meta"><StatusBadge status={doc.status} /></span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Termene în săptămâna curentă">
              {data.dueThisWeek.length === 0 ? <Empty title="Niciun termen în această săptămână." /> : (
                <ul className="row-list">
                  {data.dueThisWeek.map((item, index) => (
                    <li key={`${item.kind}-${item.id ?? item.documentId}-${index}`}>
                      <Link to={`/documente/${item.documentId}`} className="row-link">
                        <span className="row-title">{item.title}</span>
                        <span className="row-meta">
                          <Badge>{item.kind === 'sarcina' ? 'Sarcină' : 'Document'}</Badge>
                          <span className="muted">{item.kind === 'sarcina' ? fmtDateTime(item.dueAt) : fmtDate(item.dueAt)}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </>
      )}
    </>
  );
}
