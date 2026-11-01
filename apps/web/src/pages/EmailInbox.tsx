import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Alert, Badge, Empty, ErrorAlert, Loading, PageHeader, Pagination } from '../components/Ui';
import { fmtDateTime, plural } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import type { Tone } from '../labels';

export interface ImapStatus { enabled: boolean; mailbox: string | null; lastPollAt: string | null; lastSuccessAt: string | null; lastError: string | null }
export interface InboxItem {
  id: number;
  fromName: string | null;
  fromAddress: string | null;
  subject: string;
  sentAt: string | null;
  importedAt: string;
  status: 'nou' | 'inregistrat' | 'renuntat';
  registered: boolean;
  documentId: number | null;
  regLabel: string | null;
  attachmentCount: number;
  refusedCount: number;
}
interface InboxList { total: number; items: InboxItem[]; imap: ImapStatus }

export const INBOX_STATUS: Record<InboxItem['status'], { label: string; tone: Tone }> = {
  nou: { label: 'De tratat', tone: 'info' },
  inregistrat: { label: 'Înregistrat', tone: 'success' },
  renuntat: { label: 'Renunțat', tone: 'neutral' },
};

const LIMIT = 25;
const VIEWS = [
  { value: '', label: 'Toate' },
  { value: 'nou', label: 'De tratat' },
  { value: 'inregistrat', label: 'Înregistrate' },
  { value: 'renuntat', label: 'Renunțate' },
];

export default function EmailInboxPage() {
  usePageTitle('Email primit');
  const [params, setParams] = useSearchParams();
  const status = params.get('stare') ?? 'nou';
  const offset = Number(params.get('offset') ?? 0) || 0;
  const list = useAsync(() => {
    const send = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (status) send.set('status', status);
    return api<InboxList>(`/mail/inbox?${send.toString()}`);
  }, [status, offset]);
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState<unknown>(null);
  const [pollNotice, setPollNotice] = useState<string | null>(null);

  const imap = list.data?.imap;

  const pollNow = async () => {
    setPolling(true);
    setPollError(null);
    setPollNotice(null);
    try {
      const r = await api<{ imported: number; duplicates: number; refusedAttachments: number }>('/mail/inbox/poll', { method: 'POST' });
      setPollNotice(r.imported === 0
        ? 'Nu există mesaje noi.'
        : `${plural(r.imported, 'mesaj preluat', 'mesaje preluate')}${r.refusedAttachments ? `, ${plural(r.refusedAttachments, 'atașament refuzat', 'atașamente refuzate')}` : ''}.`);
    } catch (err) {
      setPollError(err);
    } finally {
      setPolling(false);
      void list.reload();
    }
  };

  const goTo = (nextOffset: number) => {
    const next = new URLSearchParams(params);
    if (nextOffset) next.set('offset', String(nextOffset));
    else next.delete('offset');
    setParams(next);
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <PageHeader
        title="Email primit"
        subtitle="Mesajele din căsuța registraturii. Alegeți atașamentul și înregistrați-l ca document, sau renunțați la mesaj."
        actions={imap?.enabled ? (
          <button type="button" className="btn" disabled={polling} onClick={() => void pollNow()}>{polling ? 'Se verifică…' : 'Verifică acum'}</button>
        ) : undefined}
      />
      {imap && !imap.enabled && <Alert kind="info" title="Preluarea din email nu este configurată">Administratorul trebuie să seteze conexiunea IMAP. Până atunci nu apar mesaje noi.</Alert>}
      {imap?.lastError && <Alert kind="warning" title="Căsuța de email nu a putut fi citită">{imap.lastError}{imap.lastSuccessAt ? ` Ultima citire reușită: ${fmtDateTime(imap.lastSuccessAt)}.` : ''}</Alert>}
      <ErrorAlert error={pollError} />
      {pollNotice && <Alert kind="success">{pollNotice}</Alert>}
      <div className="tabs" role="group" aria-label="Filtru după stare">
        {VIEWS.map((view) => (
          <button
            key={view.value}
            type="button"
            className={status === view.value ? 'tab tab-active' : 'tab'}
            aria-pressed={status === view.value}
            onClick={() => setParams({ stare: view.value })}
          >
            {view.label}
          </button>
        ))}
      </div>
      <ErrorAlert error={list.error} retry={() => void list.reload()} />
      {list.loading && !list.data && <Loading />}
      {list.data && list.data.items.length === 0 && <Empty title="Nu există mesaje în această vedere." />}
      {list.data && list.data.items.length > 0 && (
        <>
          <div className="table-cards-wrap">
            <table className="table table-cards">
              <caption className="visually-hidden">Mesaje primite pe email</caption>
              <thead>
                <tr>
                  <th scope="col">Primit</th>
                  <th scope="col">Expeditor</th>
                  <th scope="col">Subiect</th>
                  <th scope="col">Atașamente</th>
                  <th scope="col">Stare</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Primit" className="cell-nowrap">{fmtDateTime(item.sentAt ?? item.importedAt)}</td>
                    <td data-label="Expeditor" className="cell-wrap">
                      {item.fromName ?? item.fromAddress ?? 'Necunoscut'}
                      {item.fromName && item.fromAddress && <div className="muted cell-small">{item.fromAddress}</div>}
                    </td>
                    <td data-label="Subiect" className="cell-grow">
                      <Link to={`/email-primit/${item.id}`} className="doc-title-link">{item.subject || '(fără subiect)'}</Link>
                    </td>
                    <td data-label="Atașamente">
                      {item.attachmentCount}
                      {item.refusedCount > 0 && <> <Badge tone="warning">{plural(item.refusedCount, 'refuzat', 'refuzate')}</Badge></>}
                    </td>
                    <td data-label="Stare">
                      <Badge tone={INBOX_STATUS[item.status].tone}>{INBOX_STATUS[item.status].label}</Badge>
                      {item.documentId != null && <div className="cell-small"><Link to={`/documente/${item.documentId}`}>{item.regLabel ?? `Document #${item.documentId}`}</Link></div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={goTo} />
        </>
      )}
    </>
  );
}
