import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Alert, Badge, Empty, ErrorAlert, Field, Loading, Pagination } from '../../components/Ui';
import { fmtDateTime } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';
import type { Tone } from '../../labels';

interface OutboxRow {
  id: number;
  toAddress: string;
  userName: string;
  subject: string;
  kind: string;
  documentId: number | null;
  status: 'in_asteptare' | 'trimis' | 'esuat' | 'ignorat';
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}
interface MailStatus {
  smtp: { enabled: boolean; host: string | null; from: string | null; appUrl: string | null };
  counts: Partial<Record<OutboxRow['status'], number>>;
}

const STATUS: Record<OutboxRow['status'], { label: string; tone: Tone }> = {
  in_asteptare: { label: 'În așteptare', tone: 'info' },
  trimis: { label: 'Trimis', tone: 'success' },
  esuat: { label: 'Eșuat', tone: 'danger' },
  ignorat: { label: 'Ignorat', tone: 'neutral' },
};
const LIMIT = 25;

export default function EmailOutboxPage() {
  usePageTitle('Coada de email');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const mail = useAsync(() => api<MailStatus>('/mail/status'), []);
  const list = useAsync(() => {
    const send = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (status) send.set('status', status);
    return api<{ total: number; items: OutboxRow[] }>(`/mail/outbox?${send.toString()}`);
  }, [status, offset]);
  const [error, setError] = useState<unknown>(null);

  const retry = async (id: number) => {
    setError(null);
    try {
      await api(`/mail/outbox/${id}/retry`, { method: 'POST' });
      await Promise.all([list.reload(), mail.reload()]);
    } catch (err) {
      setError(err);
    }
  };
  const failed = mail.data?.counts.esuat ?? 0;

  return (
    <div className="stack">
      <ErrorAlert error={mail.error ?? list.error ?? error} />
      {mail.data && !mail.data.smtp.enabled && <Alert kind="info" title="Emailul este dezactivat">Fără SMTP_HOST, notificările rămân doar în aplicație și nu se pune nimic în coadă.</Alert>}
      {mail.data?.smtp.enabled && <p className="hint">Server: {mail.data.smtp.host} · Expeditor: {mail.data.smtp.from}{mail.data.smtp.appUrl ? ` · Linkuri către ${mail.data.smtp.appUrl}` : ' · APP_URL nu este setat, emailurile nu au link'}</p>}
      {failed > 0 && <Alert kind="error" title={failed === 1 ? '1 email nu a putut fi trimis' : `${failed} emailuri nu au putut fi trimise`}>Motivul apare în listă. După remedierea problemei, le puteți retrimite.</Alert>}
      <div className="filter-box">
        <div className="form-grid form-grid-dense">
          <Field label="Stare">
            <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
              <option value="">Toate stările</option>
              {Object.entries(STATUS).map(([value, s]) => <option key={value} value={value}>{s.label} ({mail.data?.counts[value as OutboxRow['status']] ?? 0})</option>)}
            </select>
          </Field>
        </div>
      </div>
      {list.loading && !list.data && <Loading />}
      {list.data && list.data.items.length === 0 && <Empty title="Coada este goală pentru această stare." />}
      {list.data && list.data.items.length > 0 && (
        <>
          <div className="table-cards-wrap">
            <table className="table table-cards">
              <caption className="visually-hidden">Coada de email</caption>
              <thead>
                <tr>
                  <th scope="col">Creat</th>
                  <th scope="col">Destinatar</th>
                  <th scope="col">Subiect</th>
                  <th scope="col">Stare</th>
                  <th scope="col">Detalii</th>
                  <th scope="col"><span className="visually-hidden">Acțiune</span></th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Creat" className="cell-nowrap">{fmtDateTime(row.createdAt)}</td>
                    <td data-label="Destinatar" className="cell-wrap">{row.userName}<div className="muted cell-small">{row.toAddress}</div></td>
                    <td data-label="Subiect" className="cell-grow cell-wrap">
                      {row.documentId ? <Link to={`/documente/${row.documentId}`}>{row.subject}</Link> : row.subject}
                    </td>
                    <td data-label="Stare"><Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge></td>
                    <td data-label="Detalii" className="cell-wrap cell-small">
                      {row.status === 'trimis' && fmtDateTime(row.sentAt)}
                      {row.attempts > 0 && row.status !== 'trimis' && <div>Încercări: {row.attempts}</div>}
                      {row.status === 'in_asteptare' && row.attempts > 0 && <div>Următoarea: {fmtDateTime(row.nextAttemptAt)}</div>}
                      {row.lastError && <div className="muted">{row.lastError}</div>}
                    </td>
                    <td className="cell-actions">
                      {row.status === 'esuat' && <button type="button" className="btn btn-sm" onClick={() => void retry(row.id)}>Retrimite</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
        </>
      )}
    </div>
  );
}
