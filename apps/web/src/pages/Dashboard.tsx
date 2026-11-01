import { Link } from 'react-router-dom';
import { CalendarClock, CircleCheck, Clock, FileText, ListChecks, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { useUser } from '../auth';
import { TaskIcon } from '../components/Brand';
import { Badge, Empty, ErrorAlert, Loading, Section, StatusBadge } from '../components/Ui';
import { fmtDate, fmtDateTime, fmtNumber } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { TASK_KIND } from '../labels';
import type { Dashboard } from '../types';

const TZ = 'Europe/Bucharest';
const todayFmt = new Intl.DateTimeFormat('ro-RO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const hourFmt = new Intl.DateTimeFormat('ro-RO', { timeZone: TZ, hour: 'numeric', hour12: false });

function greeting(now: Date): string {
  const hour = Number(hourFmt.format(now));
  if (hour >= 5 && hour < 11) return 'Bună dimineața';
  if (hour >= 11 && hour < 18) return 'Bună ziua';
  return 'Bună seara';
}

export default function DashboardPage() {
  usePageTitle('Acasă');
  const user = useUser();
  const { data, error, loading, reload } = useAsync(() => api<Dashboard>('/dashboard'), []);
  const now = new Date();

  return (
    <>
      <header className="greeting">
        <h1>{greeting(now)}, {user.fullName}</h1>
        <p>{todayFmt.format(now)}</p>
      </header>
      <ErrorAlert error={error} retry={() => void reload()} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="stats">
            <Link to="/sarcini" className="stat">
              <span className="icon-chip" aria-hidden="true"><ListChecks size={21} /></span>
              <span className="stat-text">
                <span className="stat-value">{fmtNumber(data.counts.openTasks)}</span>
                <span className="stat-label">Sarcini deschise</span>
              </span>
            </Link>
            <Link to="/sarcini" className={`stat ${data.counts.overdueTasks > 0 ? 'stat-alert' : ''}`}>
              <span className={`icon-chip ${data.counts.overdueTasks > 0 ? 'icon-chip-danger' : 'icon-chip-neutral'}`} aria-hidden="true">
                {data.counts.overdueTasks > 0 ? <TriangleAlert size={21} /> : <Clock size={21} />}
              </span>
              <span className="stat-text">
                <span className="stat-value">{fmtNumber(data.counts.overdueTasks)}</span>
                <span className="stat-label">Cu termen depășit</span>
              </span>
            </Link>
            <Link to="/documente" className="stat">
              <span className="icon-chip icon-chip-neutral" aria-hidden="true"><FileText size={21} /></span>
              <span className="stat-text">
                <span className="stat-value">{fmtNumber(data.counts.pending)}</span>
                <span className="stat-label">Documente în așteptare</span>
              </span>
            </Link>
          </div>
          <div className="dash-grid">
            <div className="dash-col">
              <Section title="De făcut" icon={ListChecks} actions={<Link className="panel-link" to="/sarcini">Toate sarcinile</Link>}>
                {data.tasks.length === 0 ? <Empty icon={CircleCheck} title="Nu aveți sarcini deschise." /> : (
                  <ul className="row-list">
                    {data.tasks.slice(0, 8).map((task) => (
                      <li key={task.id}>
                        <Link to={`/documente/${task.documentId}#sarcina`} className="row-link row-with-icon">
                          <TaskIcon kind={task.kind} tone={task.overdue ? 'danger' : 'primary'} />
                          <span className="row-body">
                            <span className="row-title">{task.name}</span>
                            <span className="row-sub">{task.regLabel ?? 'Fără număr'} · {task.documentTitle}</span>
                            <span className="row-meta">
                              <span className="muted">{TASK_KIND[task.kind] ?? task.kind}</span>
                              {task.dueAt && <span className="muted">· Termen: {fmtDateTime(task.dueAt)}</span>}
                              {task.overdue && <Badge tone="danger">Termen depășit</Badge>}
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
            <div className="dash-col">
              <Section title="Termene săptămâna aceasta" icon={CalendarClock}>
                {data.dueThisWeek.length === 0 ? <Empty icon={CalendarClock} title="Niciun termen în această săptămână." /> : (
                  <ul className="row-list">
                    {data.dueThisWeek.map((item, index) => (
                      <li key={`${item.kind}-${item.id ?? item.documentId}-${index}`}>
                        <Link to={`/documente/${item.documentId}`} className="row-link">
                          <span className="row-title">{item.title}</span>
                          <span className="row-sub">
                            {item.kind === 'sarcina' ? 'Sarcină' : 'Document'} · {item.kind === 'sarcina' ? fmtDateTime(item.dueAt) : fmtDate(item.dueAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
              <Section title="Documente în așteptare" icon={FileText} actions={<Link className="panel-link" to="/documente">Toate</Link>}>
                {data.pendingDocuments.length === 0 ? <Empty icon={FileText} title="Nu există documente în așteptare." /> : (
                  <ul className="row-list">
                    {data.pendingDocuments.slice(0, 6).map((doc) => (
                      <li key={doc.id}>
                        <Link to={`/documente/${doc.id}`} className="row-link">
                          <span className="row-title">{doc.title}</span>
                          <span className="row-meta">
                            <StatusBadge status={doc.status} />
                            <span className="muted">{doc.regLabel ?? 'Fără număr'} · {fmtDate(doc.createdAt)}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </div>
        </>
      )}
    </>
  );
}
