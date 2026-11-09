import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api';
import { useAuth, useUser } from '../../auth';
import { DispatchList, type Dispatch } from '../../components/Dispatches';
import { ErrorAlert, Field, Modal, Section } from '../../components/Ui';
import { fmtDateTime } from '../../format';
import { useAsync } from '../../hooks';
import type { DocDetail } from '../../types';
import { DISPATCH_METHODS, kindLabel, todayIso } from '../cases/caseTypes';

export function CancelledBanner({ doc }: { doc: DocDetail }) {
  if (doc.status !== 'anulat') return null;
  return (
    <div className="cancelled-banner" role="status">
      Înregistrarea <strong>{doc.regLabel}</strong> este anulată{doc.cancelledBy ? ` de ${doc.cancelledBy}` : ''}, la {fmtDateTime(doc.cancelledAt)}. Motiv: {doc.cancelReason}
    </div>
  );
}

export function CancelButton({ doc, onDone }: { doc: DocDetail; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!doc.canCancel) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/documents/${doc.id}/cancel`, { method: 'POST', body: { reason } });
      setOpen(false);
      onDone(`Înregistrarea ${doc.regLabel} a fost anulată. Numărul rămâne în registru.`);
    } catch (err) { setError(err); setBusy(false); }
  };
  return (
    <>
      <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>Anulează înregistrarea</button>
      {open && (
        <Modal title={`Anulează ${doc.regLabel}`} onClose={() => setOpen(false)} footer={(
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>Renunță</button>
            <button type="submit" form="anulare" className="btn btn-danger" disabled={busy}>{busy ? 'Se anulează…' : 'Anulează'}</button>
          </>
        )}>
          <form id="anulare" className="stack" onSubmit={submit}>
            <ErrorAlert error={error} />
            <p>Înregistrarea nu se șterge: numărul rămâne în registru, marcat ca anulat, cu motivul. Documentul nu mai poate fi modificat.</p>
            <Field label="Motivul anulării" required><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} /></Field>
          </form>
        </Modal>
      )}
    </>
  );
}

export function CasesOfDocument({ doc }: { doc: DocDetail }) {
  const { can } = useAuth();
  const canOpen = can('register', 'cases_all') && doc.status !== 'anulat';
  if (doc.cases.length === 0 && !canOpen) return null;
  return (
    <Section title="Lucrări" count={doc.cases.length}
      actions={canOpen ? <Link className="btn btn-sm" to={`/lucrari/nou${qs({ document: doc.id, tip: 'petitie' })}`}>Deschide lucrare</Link> : undefined}>
      {doc.cases.length === 0 ? <p className="muted">Documentul nu face parte din nicio lucrare.</p> : (
        <ul className="row-list">
          {doc.cases.map((c) => (
            <li key={c.id} className="row-static">
              <span className="row-sub">{kindLabel(c.kind)}</span>
              <Link to={`/lucrari/${c.id}`}>{c.regLabel}</Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function DispatchSection({ doc }: { doc: DocDetail }) {
  const { can } = useAuth();
  const user = useUser();
  const list = useAsync(() => api<Dispatch[]>(`/documents/${doc.id}/dispatches`), [doc.id]);
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState('posta_recomandata');
  const [recipient, setRecipient] = useState(doc.recipient ?? '');
  const [address, setAddress] = useState('');
  const [sentOn, setSentOn] = useState(todayIso());
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canDispatch = (can('register') || doc.ownerId === user.id) && doc.status !== 'anulat' && doc.direction !== 'intrat';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/documents/${doc.id}/dispatches`, { method: 'POST', body: { method, recipient, address, sentOn, tracking } });
      setAdding(false);
      setTracking('');
      await list.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  if (!canDispatch && (list.data?.length ?? 0) === 0) return null;
  return (
    <Section title="Expediere" count={list.data?.length} collapsible defaultOpen={(list.data?.length ?? 0) > 0 || adding}
      actions={canDispatch ? <button type="button" className="btn btn-sm" aria-expanded={adding} onClick={() => setAdding(!adding)}>Expediază</button> : undefined}>
      {adding && (
        <form className="inline-form" onSubmit={submit}>
          <ErrorAlert error={error} />
          <div className="form-grid">
            <Field label="Mod"><select value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(DISPATCH_METHODS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Data"><input type="date" value={sentOn} max={todayIso()} onChange={(e) => setSentOn(e.target.value)} /></Field>
            <Field label="Destinatar" required><input value={recipient} onChange={(e) => setRecipient(e.target.value)} required /></Field>
            <Field label="Adresa"><input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
            <Field label="Număr de urmărire"><input value={tracking} onChange={(e) => setTracking(e.target.value)} /></Field>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Înregistrează expedierea'}</button>
        </form>
      )}
      <ErrorAlert error={list.error} />
      {list.data && <DispatchList items={list.data} onChanged={() => void list.reload()} />}
    </Section>
  );
}
