import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock, CircleCheck, History, Workflow } from 'lucide-react';
import { api, qs } from '../api';
import { TaskIcon } from '../components/Brand';
import { ActionNotice, TaskActions } from '../components/TaskActions';
import { Badge, Empty, ErrorAlert, Loading, PageHeader } from '../components/Ui';
import { fmtDateTime } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { TASK_KIND, TASK_STATUS } from '../labels';
import type { Task } from '../types';

export default function TasksPage() {
  usePageTitle('Sarcinile mele');
  const [params, setParams] = useSearchParams();
  const scope = params.get('stare') === 'finalizate' ? 'done' : 'open';
  const tasks = useAsync(() => api<Task[]>(`/tasks${qs({ scope })}`), [scope]);
  const [notice, setNotice] = useState<string | null>(null);

  const select = (next: 'open' | 'done') => {
    setNotice(null);
    setParams(next === 'done' ? { stare: 'finalizate' } : {}, { replace: true });
  };

  return (
    <>
      <PageHeader title="Sarcinile mele" />
      <div className="tabs" role="group" aria-label="Filtrare sarcini">
        <button type="button" className={scope === 'open' ? 'tab tab-active' : 'tab'} aria-pressed={scope === 'open'} onClick={() => select('open')}>Deschise</button>
        <button type="button" className={scope === 'done' ? 'tab tab-active' : 'tab'} aria-pressed={scope === 'done'} onClick={() => select('done')}>Finalizate</button>
      </div>
      <ActionNotice message={notice} onDismiss={() => setNotice(null)} />
      <ErrorAlert error={tasks.error} retry={() => void tasks.reload()} />
      {tasks.loading && !tasks.data && <Loading />}
      {tasks.data && tasks.data.length === 0 && (
        <Empty
          icon={scope === 'open' ? CircleCheck : History}
          title={scope === 'open' ? 'Nu aveți sarcini deschise.' : 'Nu aveți sarcini finalizate.'}
        />
      )}
      {tasks.data && tasks.data.length > 0 && (
        <ul className="task-list">
          {tasks.data.map((task) => (
            <li key={task.id} className={`task-card ${task.overdue && scope === 'open' ? 'task-card-overdue' : ''}`}>
              <div className="task-card-main">
                <TaskIcon kind={task.kind} tone={task.overdue && scope === 'open' ? 'danger' : 'primary'} />
                <div className="task-card-body">
                  <h2 className="task-card-title">{task.name}</h2>
                  <p className="task-card-doc">
                    <Link to={`/documente/${task.documentId}`}>
                      {task.regLabel ?? 'Fără număr'} · {task.documentTitle}
                    </Link>
                  </p>
                  <p className="task-card-meta">
                    <span>{TASK_KIND[task.kind] ?? task.kind}</span>
                    <span><Workflow size={14} aria-hidden="true" />{task.workflowName}</span>
                    {task.dueAt && <span><CalendarClock size={14} aria-hidden="true" />Termen: {fmtDateTime(task.dueAt)}</span>}
                  </p>
                  <div className="task-card-badges">
                    {(scope === 'done' || task.status !== 'deschisa') && (
                      <Badge tone={TASK_STATUS[task.status]?.tone ?? 'neutral'}>{TASK_STATUS[task.status]?.label ?? task.status}</Badge>
                    )}
                    {task.overdue && scope === 'open' && <Badge tone="danger">Termen depășit</Badge>}
                  </div>
                  {task.comment && (
                    <p className="task-card-comment">
                      <strong>{task.kind === 'completare' ? 'Informații cerute: ' : 'Comentariu: '}</strong>{task.comment}
                    </p>
                  )}
                </div>
              </div>
              {scope === 'open' && (
                <div className="task-card-actions">
                  <TaskActions task={task} onDone={(message) => { setNotice(message); void tasks.reload(); }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
