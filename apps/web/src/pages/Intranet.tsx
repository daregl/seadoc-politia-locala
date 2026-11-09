import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useAuth, useUser } from '../auth';
import { DocPicker, type PickedDoc } from '../components/DocPicker';
import { Alert, Badge, Empty, ErrorAlert, Field, Loading, Modal, PageHeader, Section } from '../components/Ui';
import { fmtDate, fmtDateTime } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import type { Meta } from '../types';

interface Post {
  id: number; kind: 'anunt' | 'procedura'; title: string; body: string; departmentId: number | null; departmentName: string | null; pinned: boolean;
  requiresAck: boolean; expiresOn: string | null; publishedAt: string; publishedBy: string; withdrawnAt: string | null; documentId: number | null;
  documentLabel: string | null; documentTitle: string | null; readAt: string | null; acknowledgedAt: string | null; ackCount: number;
}

export default function IntranetPage() {
  usePageTitle('Intranet');
  const { can } = useAuth();
  const [kind, setKind] = useState('');
  const posts = useAsync(() => api<Post[]>(`/intranet${kind ? `?kind=${kind}` : ''}`), [kind]);
  const [creating, setCreating] = useState(false);
  const [acks, setAcks] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canPublish = can('intranet_publish');

  const acknowledge = async (p: Post) => {
    setError(null);
    try {
      await api(`/intranet/${p.id}/read`, { method: 'POST', body: { acknowledge: true } });
      await posts.reload();
    } catch (err) { setError(errorMessage(err)); }
  };
  const withdraw = async (p: Post) => {
    if (!window.confirm(`Retrageți „${p.title}”?`)) return;
    try {
      await api(`/intranet/${p.id}`, { method: 'DELETE' });
      await posts.reload();
    } catch (err) { setError(errorMessage(err)); }
  };

  return (
    <>
      <PageHeader title="Intranet" subtitle="Anunțuri și proceduri interne, cu aceleași conturi."
        actions={canPublish ? <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>Publică</button> : undefined} />
      <nav className="tabs" aria-label="Tip">
        {[['', 'Toate'], ['anunt', 'Anunțuri'], ['procedura', 'Proceduri']].map(([v, l]) => (
          <button key={v} type="button" className={kind === v ? 'tab tab-active' : 'tab'} onClick={() => setKind(v)}>{l}</button>
        ))}
      </nav>
      {error && <Alert kind="error">{error}</Alert>}
      <ErrorAlert error={posts.error} retry={() => void posts.reload()} />
      {posts.loading && !posts.data && <Loading />}
      {posts.data?.length === 0 && <Empty title="Nu există anunțuri." />}
      {posts.data && posts.data.length > 0 && (
        <Section title={kind === 'procedura' ? 'Proceduri' : kind === 'anunt' ? 'Anunțuri' : 'Toate'}>
          {posts.data.map((p) => (
            <article key={p.id} id={`post-${p.id}`} className={p.pinned ? 'post post-pinned' : 'post'}>
              <div className="doc-facts">
                <Badge tone={p.kind === 'procedura' ? 'info' : 'neutral'}>{p.kind === 'procedura' ? 'Procedură' : 'Anunț'}</Badge>
                {p.pinned && <Badge tone="warning">Fixat</Badge>}
                <span>{p.departmentName ?? 'Toată instituția'}</span>
                <span>{p.publishedBy}, {fmtDateTime(p.publishedAt)}</span>
                {p.expiresOn && <span>valabil până la {fmtDate(p.expiresOn)}</span>}
              </div>
              <h2>{p.title}</h2>
              <p className="post-body">{p.body}</p>
              {p.documentId && <p>Document: <Link to={`/documente/${p.documentId}`}>{p.documentLabel ?? 'Fără număr'} · {p.documentTitle}</Link></p>}
              <div className="case-actions">
                {p.requiresAck && (p.acknowledgedAt
                  ? <Badge tone="success">Luat la cunoștință, {fmtDateTime(p.acknowledgedAt)}</Badge>
                  : <button type="button" className="btn btn-sm btn-primary" onClick={() => acknowledge(p)}>Am luat la cunoștință</button>)}
                {canPublish && p.requiresAck && <button type="button" className="btn btn-sm" onClick={() => setAcks(p)}>Confirmări ({p.ackCount})</button>}
                {canPublish && <button type="button" className="btn btn-sm" onClick={() => withdraw(p)}>Retrage</button>}
              </div>
            </article>
          ))}
        </Section>
      )}
      {creating && <PublishDialog onClose={() => setCreating(false)} onDone={async () => { setCreating(false); await posts.reload(); }} />}
      {acks && <AcksDialog post={acks} onClose={() => setAcks(null)} />}
    </>
  );
}

function PublishDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const user = useUser();
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [kind, setKind] = useState('anunt');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [departmentId, setDepartmentId] = useState(user.role === 'admin' ? '' : String(user.departmentId ?? ''));
  const [pinned, setPinned] = useState(false);
  const [requiresAck, setRequiresAck] = useState(false);
  const [expiresOn, setExpiresOn] = useState('');
  const [doc, setDoc] = useState<PickedDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/intranet', { method: 'POST', body: { kind, title, body, departmentId: departmentId || null, pinned, requiresAck, expiresOn: expiresOn || undefined, documentId: doc?.id } });
      onDone();
    } catch (err) { setError(err); setBusy(false); }
  };
  return (
    <Modal title="Publică în Intranet" onClose={onClose} wide footer={(
      <>
        <button type="button" className="btn" onClick={onClose}>Renunță</button>
        <button type="submit" form="publica" className="btn btn-primary" disabled={busy}>{busy ? 'Se publică…' : 'Publică și notifică'}</button>
      </>
    )}>
      <form id="publica" className="stack" onSubmit={submit}>
        <ErrorAlert error={error ?? meta.error} />
        <div className="form-grid">
          <Field label="Tip"><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="anunt">Anunț</option><option value="procedura">Procedură</option></select></Field>
          <Field label="Pentru">
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} disabled={user.role !== 'admin'}>
              <option value="">Toată instituția</option>
              {meta.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Valabil până la"><input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} /></Field>
        </div>
        <Field label="Titlu" required><input value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        <Field label="Text" required><textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} required /></Field>
        <DocPicker value={doc} onChange={setDoc} label="Document atașat (opțional)" />
        <label className="check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /><span>Fixat în partea de sus</span></label>
        <label className="check"><input type="checkbox" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} /><span>Cere confirmarea luării la cunoștință</span></label>
      </form>
    </Modal>
  );
}

function AcksDialog({ post, onClose }: { post: Post; onClose: () => void }) {
  const rows = useAsync(() => api<{ fullName: string; departmentName: string | null; readAt: string; acknowledgedAt: string | null }[]>(`/intranet/${post.id}/acknowledgements`), [post.id]);
  return (
    <Modal title={`Confirmări: ${post.title}`} onClose={onClose}>
      <ErrorAlert error={rows.error} />
      {rows.data?.length === 0 && <Empty title="Nicio confirmare încă." />}
      <ul className="row-list">
        {rows.data?.map((r) => (
          <li key={r.fullName} className="row-static">
            <span>{r.fullName}{r.departmentName ? ` · ${r.departmentName}` : ''}</span>
            <span className="row-sub">{r.acknowledgedAt ? `confirmat ${fmtDateTime(r.acknowledgedAt)}` : 'neconfirmat'}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
