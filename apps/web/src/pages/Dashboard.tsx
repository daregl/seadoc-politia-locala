import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorAlert, Loading, Section, StatusBadge } from '../components/Ui';
import { fmtDate, fmtDateTime, plural } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { TASK_KIND } from '../labels';
import type { Dashboard } from '../types';
import { CasesDashboard } from './cases/CasesDashboard';

const todayFmt = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', weekday: 'long', day: 'numeric', month: 'long' });

export default function DashboardPage() {
  usePageTitle('Acasă');
  const { data, error, loading, reload } = useAsync(() => api<Dashboard>('/dashboard'), []);

  const open = data?.counts.openTasks ?? 0;
  const overdue = data?.counts.overdueTasks ?? 0;
  const hasTasks = (data?.tasks.length ?? 0) > 0;

  return (
    <>
      <header className="page-header">
        <div className="page-header-text">
          <h1>{!data ? 'Acasă' : open === 0 ? 'Nu aveți sarcini de rezolvat' : `${plural(open, 'sarcină', 'sarcini')} de rezolvat`}</h1>
          {overdue > 0 && <p className="page-subtitle page-subtitle-alert">{plural(overdue, 'sarcină', 'sarcini')} cu termenul depășit</p>}
        </div>
        <p className="page-date">{todayFmt.format(new Date())}</p>
      </header>
      <ErrorAlert error={error} retry={() => void reload()} />
      <CasesDashboard />
      {loading && !data && <Loading />}
      {data && (
        <div className={hasTasks ? 'dash-grid' : 'dash-grid dash-grid-even'}>
          {hasTasks && (
            <div className="dash-col">
              <Section title="Sarcini" actions={<Link className="panel-link" to="/sarcini">Toate sarcinile</Link>}>
                <ul className="row-list">
                  {data.tasks.slice(0, 8).map((task) => (
                    <li key={task.id}>
                      <Link to={`/documente/${task.documentId}#sarcina`} className="row-link ledger-row">
                        <span className={task.overdue ? 'ledger-when ledger-when-late' : 'ledger-when'}>
                          {task.dueAt ? fmtDate(task.dueAt) : 'fără termen'}
                        </span>
                        <span className="ledger-body">
                          <span className="row-title">{task.name}</span>
                          <span className="row-sub">{TASK_KIND[task.kind] ?? task.kind} · {task.regLabel ?? 'Fără număr'} · {task.documentTitle}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Section>
            </div>
          )}
          {hasTasks ? (
            <div className="dash-col">
              <DueThisWeek data={data} />
              <PendingDocuments data={data} />
            </div>
          ) : (
            <>
              <PendingDocuments data={data} />
              <DueThisWeek data={data} />
            </>
          )}
        </div>
      )}
    </>
  );
}

function DueThisWeek({ data }: { data: Dashboard }) {
  return (
    <Section title="Termene săptămâna aceasta">
      {data.dueThisWeek.length === 0 ? <Empty title="Niciun termen." /> : (
        <ul className="row-list">
          {data.dueThisWeek.map((item, index) => (
            <li key={`${item.kind}-${item.id ?? item.documentId}-${index}`}>
              <Link to={`/documente/${item.documentId}`} className="row-link ledger-row">
                <span className="ledger-when">{fmtDate(item.dueAt)}</span>
                <span className="ledger-body">
                  <span className="row-title">{item.title}</span>
                  {item.kind === 'sarcina' && <span className="row-sub">Sarcină, până la {fmtDateTime(item.dueAt)}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function PendingDocuments({ data }: { data: Dashboard }) {
  return (
    <Section title="Documente în așteptare" count={data.counts.pending} actions={<Link className="panel-link" to="/documente">Toate documentele</Link>}>
      {data.pendingDocuments.length === 0 ? <Empty title="Niciun document." /> : (
        <ul className="row-list">
          {data.pendingDocuments.slice(0, 6).map((doc) => (
            <li key={doc.id}>
              <Link to={`/documente/${doc.id}`} className="row-link">
                <span className="reg-no">{doc.regLabel ?? 'Fără număr'}</span>
                <span className="row-title">{doc.title}</span>
                <span className="row-meta"><StatusBadge status={doc.status} /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
