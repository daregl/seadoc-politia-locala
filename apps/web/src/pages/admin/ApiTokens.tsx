import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api';
import { Alert, Badge, Empty, ErrorAlert, Field, Loading, Section } from '../../components/Ui';
import { fmtDate, fmtDateTime } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';
import type { Meta } from '../../types';

interface Token { id: number; name: string; prefix: string; userId: number; username: string; userName: string; expiresOn: string | null; createdAt: string; createdBy: string; lastUsedAt: string | null; revokedAt: string | null }

export default function ApiTokensAdmin() {
  usePageTitle('API');
  const list = useAsync(() => api<Token[]>('/admin/api-tokens'), []);
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [name, setName] = useState('');
  const [userId, setUserId] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('/admin/api-tokens', { method: 'POST', body: { name, userId, expiresOn: expiresOn || undefined } });
      setCreated(r.token);
      setName('');
      await list.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const revoke = async (t: Token) => {
    if (!window.confirm(`Revocați tokenul „${t.name}”? Integrarea nu va mai funcționa.`)) return;
    try { await api(`/admin/api-tokens/${t.id}`, { method: 'DELETE' }); await list.reload(); } catch (err) { setError(errorMessage(err)); }
  };

  return (
    <div className="stack">
      <Section title="Token nou pentru o integrare">
        <p className="hint">Contabilitatea, HR-ul, serverul de email sau serviciul de semnătură apelează API-ul REST cu antetul <code>Authorization: Bearer &lt;token&gt;</code>. Tokenul are drepturile contului ales; creați un cont separat pentru fiecare integrare. Documentația este în <code>docs/API.md</code>.</p>
        <form onSubmit={submit}>
          <ErrorAlert error={error ?? meta.error} />
          <div className="form-grid">
            <Field label="Denumirea integrării" required><input value={name} onChange={(e) => setName(e.target.value)} required placeholder="de exemplu: Contabilitate" /></Field>
            <Field label="Contul folosit" required>
              <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
                <option value="">Alegeți</option>
                {meta.data?.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
            </Field>
            <Field label="Expiră la"><input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} /></Field>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se creează…' : 'Creează tokenul'}</button>
        </form>
        {created && (
          <Alert kind="warning" title="Copiați tokenul acum; nu se mai afișează">
            <p className="token-once">{created}</p>
          </Alert>
        )}
      </Section>
      <Section title="Tokenuri" count={list.data?.length}>
        {list.loading && !list.data && <Loading />}
        {list.data?.length === 0 && <Empty title="Nu există tokenuri." />}
        <ul className="row-list">
          {list.data?.map((t) => (
            <li key={t.id} className="row-static">
              <span className="row-title">{t.name} <code>{t.prefix}…</code> {t.revokedAt ? <Badge tone="neutral">Revocat</Badge> : <Badge tone="success">Activ</Badge>}</span>
              <span className="row-sub">Cont: {t.userName} ({t.username}) · creat de {t.createdBy}, {fmtDate(t.createdAt)} · folosit ultima dată: {fmtDateTime(t.lastUsedAt, 'niciodată')}{t.expiresOn ? ` · expiră ${fmtDate(t.expiresOn)}` : ''}</span>
              {!t.revokedAt && <span><button type="button" className="btn btn-sm btn-danger" onClick={() => revoke(t)}>Revocă</button></span>}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
