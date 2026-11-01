import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth, useUser } from '../auth';
import { CertificateSign, signedMessage } from './CertificateSign';
import { useAsync } from '../hooks';
import { APPROVE_LABEL, TASK_KIND } from '../labels';
import type { AssigneeOptions, Task } from '../types';
import { Alert, ErrorAlert, Field, Loading, Modal } from './Ui';

type DialogKind = 'approve' | 'sign' | 'reject' | 'redirect' | 'request_info';
type TaskRef = Pick<Task, 'id' | 'kind' | 'name' | 'status'>;

const CONFIRM_QUESTION: Record<Task['kind'], string> = {
  avizare: 'Confirmați avizarea documentului?',
  aprobare: 'Confirmați aprobarea documentului?',
  semnare: 'Confirmați semnarea documentului?',
  informare: 'Confirmați că ați luat la cunoștință?',
  completare: 'Confirmați că ați transmis informațiile cerute?',
};

/** Acțiunile titularului pe o sarcină; serverul verifică din nou dreptul și titularul. */
export function TaskActions({ task, onDone }: { task: TaskRef; onDone: (message: string) => void }) {
  const { can } = useAuth();
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  if (task.status === 'asteapta_completare') {
    return <p className="task-note">Sarcina așteaptă completarea cerută inițiatorului și revine la dumneavoastră după aceea.</p>;
  }
  if (task.status !== 'deschisa') return null;
  if (task.kind !== 'completare' && !can('approve')) {
    return <p className="task-note">Contul dumneavoastră nu are dreptul de avizare și aprobare.</p>;
  }

  const fullFlow = task.kind === 'avizare' || task.kind === 'aprobare' || task.kind === 'semnare';
  const done = (message: string) => { setDialog(null); onDone(message); };
  return (
    <div className="task-actions">
      <div className="task-actions-main">
        <button
          type="button"
          className="btn btn-success btn-action"
          onClick={() => setDialog(task.kind === 'semnare' ? 'sign' : 'approve')}
        >
          {APPROVE_LABEL[task.kind]}
        </button>
        {fullFlow && (
          <button type="button" className="btn btn-danger btn-action" onClick={() => setDialog('reject')}>Respinge</button>
        )}
      </div>
      {task.kind !== 'completare' && (
        <div className="task-actions-more">
          <button type="button" className="btn btn-sm" onClick={() => setDialog('redirect')}>Redirecționează</button>
          {fullFlow && <button type="button" className="btn btn-sm" onClick={() => setDialog('request_info')}>Cere informații</button>}
        </div>
      )}
      {dialog === 'approve' && <ApproveDialog task={task} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'sign' && <SignDialog task={task} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'reject' && <CommentDialog task={task} action="reject" onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'request_info' && <CommentDialog task={task} action="request_info" onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'redirect' && <RedirectDialog task={task} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

interface DialogProps { task: TaskRef; onClose: () => void; onDone: (message: string) => void }

function useTaskAction(taskId: number) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const send = async (body: Record<string, unknown>, opts: { credentialCheck?: boolean } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/tasks/${taskId}/action`, { method: 'POST', body, credentialCheck: opts.credentialCheck });
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, send };
}

function DialogFooter({ formId, busy, label, onClose, tone = 'primary' }: {
  formId: string; busy: boolean; label: string; onClose: () => void; tone?: 'primary' | 'success' | 'danger';
}) {
  return (
    <>
      <button type="button" className="btn" onClick={onClose} disabled={busy}>Renunță</button>
      <button type="submit" form={formId} className={`btn btn-${tone}`} disabled={busy}>
        {busy ? 'Se trimite…' : label}
      </button>
    </>
  );
}

function ApproveDialog({ task, onClose, onDone }: DialogProps) {
  const { busy, error, send } = useTaskAction(task.id);
  const [comment, setComment] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await send({ action: 'approve', comment: comment.trim() || undefined })) {
      onDone(`Sarcina „${task.name}” a fost finalizată.`);
    }
  };
  return (
    <Modal
      title={`${TASK_KIND[task.kind]}: ${task.name}`}
      onClose={onClose}
      footer={<DialogFooter formId="task-approve" busy={busy} label={APPROVE_LABEL[task.kind]} tone="success" onClose={onClose} />}
    >
      <form id="task-approve" onSubmit={submit}>
        <p>{CONFIRM_QUESTION[task.kind]}</p>
        <ErrorAlert error={error} />
        <Field label="Comentariu (opțional)">
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function SignDialog({ task, onClose, onDone }: DialogProps) {
  const { can } = useAuth();
  const { busy, error, send } = useTaskAction(task.id);
  const [kind, setKind] = useState<'interna' | 'certificat'>('interna');
  const [password, setPassword] = useState('');
  const [comment, setComment] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await send({ action: 'sign', password, comment: comment.trim() || undefined }, { credentialCheck: true });
    if (ok) onDone('Documentul a fost semnat cu semnătură electronică internă.');
    else setPassword('');
  };
  return (
    <Modal
      title="Semnare document"
      onClose={onClose}
      footer={kind === 'interna'
        ? <DialogFooter formId="task-sign" busy={busy} label="Semnează" tone="success" onClose={onClose} />
        : <button type="button" className="btn" onClick={onClose}>Renunță</button>}
    >
      <form id="task-sign" onSubmit={submit}>
        <ErrorAlert error={error} />
        <fieldset className="fieldset">
          <legend>Tip semnătură</legend>
          <label className="choice">
            <input type="radio" name="sign-kind" checked={kind === 'interna'} onChange={() => setKind('interna')} />
            <span>
              <strong>Semnătură electronică internă</strong>
              <span className="hint">Confirmată cu parola contului. Se înregistrează amprenta SHA-256 a versiunii curente, autorul și momentul semnării.</span>
            </span>
          </label>
          <label className={can('sign_qualified') ? 'choice' : 'choice choice-disabled'}>
            <input type="radio" name="sign-kind" checked={kind === 'certificat'} disabled={!can('sign_qualified')} onChange={() => setKind('certificat')} />
            <span>
              <strong>Semnătură cu certificat</strong>
              <span className="hint">
                {can('sign_qualified')
                  ? 'Cu certificatul de pe token sau din fișier, prin agentul local. Semnătura se adaugă în PDF.'
                  : 'Contul dumneavoastră nu are dreptul de a semna cu certificat.'}
              </span>
            </span>
          </label>
        </fieldset>
        {kind === 'interna' && (
          <Field label="Parola contului, pentru confirmare" required>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
          </Field>
        )}
        <Field label="Comentariu (opțional)">
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </form>
      {kind === 'certificat' && (
        <CertificateSign taskId={task.id} comment={comment.trim() || undefined} onSigned={(result) => onDone(signedMessage(result))} />
      )}
    </Modal>
  );
}

function CommentDialog({ task, action, onClose, onDone }: DialogProps & { action: 'reject' | 'request_info' }) {
  const { busy, error, send } = useTaskAction(task.id);
  const [comment, setComment] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const reject = action === 'reject';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!comment.trim()) { setProblem(reject ? 'Motivul respingerii este obligatoriu.' : 'Scrieți ce informații sunt necesare.'); return; }
    setProblem(null);
    if (await send({ action, comment: comment.trim() })) {
      onDone(reject ? 'Sarcina a fost respinsă.' : 'Cererea de informații a fost trimisă inițiatorului.');
    }
  };
  return (
    <Modal
      title={reject ? `Respingere: ${task.name}` : `Cerere de informații: ${task.name}`}
      onClose={onClose}
      footer={<DialogFooter formId="task-comment" busy={busy} label={reject ? 'Respinge' : 'Trimite cererea'} tone={reject ? 'danger' : 'primary'} onClose={onClose} />}
    >
      <form id="task-comment" onSubmit={submit} noValidate>
        <ErrorAlert error={error} />
        <Field
          label={reject ? 'Motivul respingerii' : 'Informațiile cerute'}
          required
          error={problem ?? undefined}
          hint={reject ? undefined : 'Inițiatorul primește o sarcină de completare. Sarcina dumneavoastră revine după finalizarea ei.'}
        >
          <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} required autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function RedirectDialog({ task, onClose, onDone }: DialogProps) {
  const me = useUser();
  const { busy, error, send } = useTaskAction(task.id);
  // Doar persoanele cu drept de aprobare pot primi o sarcină redirecționată.
  const meta = useAsync(() => api<AssigneeOptions>('/workflows/assignee-options'), []);
  const [filter, setFilter] = useState('');
  const [userId, setUserId] = useState('');
  const [comment, setComment] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const users = useMemo(() => {
    const term = filter.trim().toLocaleLowerCase('ro');
    return (meta.data?.users ?? [])
      .filter((u) => u.id !== me.id)
      .filter((u) => !term || `${u.fullName} ${u.jobTitle ?? ''} ${u.departmentName ?? ''}`.toLocaleLowerCase('ro').includes(term))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ro'));
  }, [meta.data, filter, me.id]);

  useEffect(() => {
    if (userId && !users.some((u) => String(u.id) === userId)) setUserId('');
  }, [users, userId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId) { setProblem('Alegeți utilizatorul căruia îi redirecționați sarcina.'); return; }
    setProblem(null);
    if (await send({ action: 'redirect', targetUserId: Number(userId), comment: comment.trim() || undefined })) {
      onDone('Sarcina a fost redirecționată.');
    }
  };
  return (
    <Modal
      title={`Redirecționare: ${task.name}`}
      onClose={onClose}
      footer={<DialogFooter formId="task-redirect" busy={busy} label="Redirecționează" onClose={onClose} />}
    >
      <form id="task-redirect" onSubmit={submit} noValidate>
        <ErrorAlert error={error} />
        {meta.loading && !meta.data && <Loading label="Se încarcă lista de utilizatori…" />}
        <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
        {meta.data && (
          <>
            <Field label="Caută utilizator">
              <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Nume, funcție sau departament" autoComplete="off" />
            </Field>
            <Field label="Utilizator" required error={problem ?? undefined}>
              <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
                <option value="">Alegeți ({users.length})</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}{u.jobTitle ? `, ${u.jobTitle}` : ''}{u.departmentName ? ` (${u.departmentName})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Comentariu (opțional)">
              <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
            </Field>
          </>
        )}
      </form>
    </Modal>
  );
}

/** Mesajul de confirmare de după o acțiune, cu anunț pentru cititoarele de ecran. */
export function ActionNotice({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <Alert kind="success">
      <span className="notice-row">
        <span>{message}</span>
        <button type="button" className="btn btn-sm" onClick={onDismiss}>Închide</button>
      </span>
    </Alert>
  );
}

