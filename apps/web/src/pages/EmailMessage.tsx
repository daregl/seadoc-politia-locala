import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Alert, Badge, DefinitionList, ErrorAlert, Field, Loading, Modal, PageHeader, Section } from '../components/Ui';
import { fmtDateTime, fmtSize, senderLabel } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { INBOX_STATUS, type InboxItem } from './EmailInbox';

export interface InboxAttachment { id: number; filename: string; mime: string | null; sizeBytes: number; refusedReason: string | null; available: boolean }
export interface InboxMessage extends InboxItem {
  toText: string | null;
  bodyText: string;
  bodyTruncated: boolean;
  importNote: string | null;
  attachmentId: number | null;
  discardReason: string | null;
  handledAt: string | null;
  handledBy: string | null;
  attachments: InboxAttachment[];
}

export default function EmailMessagePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const message = useAsync(() => api<InboxMessage>(`/mail/inbox/${id}`), [id]);
  const m = message.data;
  usePageTitle(m?.subject || 'Email primit');
  const usable = m?.attachments.filter((a) => a.available && !a.refusedReason) ?? [];
  const [chosen, setChosen] = useState<number | null>(null);
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => {
    if (usable.length === 1) setChosen(usable[0].id);
  }, [usable.length, usable[0]?.id]);

  if (message.loading && !m) return <Loading />;
  if (!m) return <ErrorAlert error={message.error} retry={() => void message.reload()} />;

  const open = m.status === 'nou';
  return (
    <>
      <p><Link to="/email-primit">← Înapoi la Email primit</Link></p>
      <PageHeader
        title={m.subject || '(fără subiect)'}
        actions={open ? <button type="button" className="btn" onClick={() => setDiscarding(true)}>Renunță la mesaj</button> : undefined}
      />
      <ErrorAlert error={message.error} />
      {m.importNote && <Alert kind="warning">{m.importNote}</Alert>}
      {m.status === 'inregistrat' && (
        <Alert kind="success" title="Mesaj înregistrat">
          {m.documentId != null
            ? <>Document: <Link to={`/documente/${m.documentId}`}>{m.regLabel ?? `#${m.documentId}`}</Link>.</>
            : 'Documentul este într-un departament la care nu aveți acces.'}
          {m.handledBy ? ` De ${m.handledBy}, ${fmtDateTime(m.handledAt)}.` : ''}
        </Alert>
      )}
      {m.status === 'renuntat' && (
        <Alert kind="info" title="S-a renunțat la acest mesaj">
          <p>{m.handledBy ? `${m.handledBy}, ${fmtDateTime(m.handledAt)}.` : ''} Originalul rămâne în căsuța de email.</p>
          {m.discardReason && <p>Motiv: {m.discardReason}</p>}
        </Alert>
      )}
      <div className="stack">
        <Section title="Mesaj">
          <DefinitionList items={[
            { label: 'De la', value: senderLabel(m) },
            { label: 'Către', value: m.toText },
            { label: 'Trimis', value: fmtDateTime(m.sentAt) },
            { label: 'Preluat', value: fmtDateTime(m.importedAt) },
            { label: 'Stare', value: <Badge tone={INBOX_STATUS[m.status].tone}>{INBOX_STATUS[m.status].label}</Badge> },
          ]} />
          <p className="hint">Adresa expeditorului este cea declarată în mesaj și nu este verificată. Se afișează doar textul mesajului, niciodată HTML.</p>
          <div className="mail-body">{m.bodyText || <span className="muted">Mesajul nu are text.</span>}</div>
          {m.bodyTruncated && <p className="hint">Textul a fost scurtat; versiunea completă este în căsuța de email.</p>}
        </Section>

        <Section title="Atașamente">
          {m.attachments.length === 0 && <p className="muted">Mesajul nu are atașamente, deci nu se poate înregistra de aici.</p>}
          {m.attachments.length > 0 && (
            <ul className="row-list">
              {m.attachments.map((a) => {
                const canPick = open && a.available && !a.refusedReason;
                const name = (
                  <>
                    <span className="row-title">{a.filename}</span>
                    <span className="row-sub">
                      {fmtSize(a.sizeBytes)}
                      {a.refusedReason && <> · <Badge tone="danger">Refuzat</Badge> {a.refusedReason}</>}
                      {!a.refusedReason && !a.available && ' · nu mai este păstrat'}
                      {a.id === m.attachmentId && <> · <Badge tone="success">Înregistrat</Badge></>}
                    </span>
                  </>
                );
                return (
                  <li key={a.id} className="mail-attachment">
                    {canPick ? (
                      <label className="check">
                        <input type="radio" name="atasament" checked={chosen === a.id} onChange={() => setChosen(a.id)} />
                        <span className="mail-attachment-name">{name}</span>
                      </label>
                    ) : <span className="mail-attachment-name">{name}</span>}
                    {a.available && !a.refusedReason && <a className="btn btn-sm" href={`/api/mail/inbox/${m.id}/attachments/${a.id}`}>Descarcă</a>}
                  </li>
                );
              })}
            </ul>
          )}
          {open && usable.length > 0 && (
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={chosen === null}
                onClick={() => navigate(`/documente/nou?email=${m.id}&atasament=${chosen}`)}
              >
                Înregistrează atașamentul ales
              </button>
            </div>
          )}
        </Section>
      </div>
      {discarding && <DiscardDialog id={m.id} onClose={() => setDiscarding(false)} onDone={() => { setDiscarding(false); void message.reload(); }} />}
    </>
  );
}

function DiscardDialog({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/mail/inbox/${id}/discard`, { method: 'POST', body: { reason: reason.trim() || undefined } });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Renunță la mesaj"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Înapoi</button>
          <button type="submit" form="renuntare-email" className="btn btn-danger" disabled={busy}>{busy ? 'Se salvează…' : 'Renunță la mesaj'}</button>
        </>
      )}
    >
      <form id="renuntare-email" className="stack" onSubmit={submit}>
        <ErrorAlert error={error} />
        <p>Atașamentele se șterg din SeaDoc și mesajul nu se mai poate înregistra. Originalul rămâne în căsuța de email.</p>
        <Field label="Motiv (opțional)"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
