import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { DISPATCH_METHODS, todayIso } from '../pages/cases/caseTypes';
import { fmtDate } from '../format';
import { Badge, Empty, ErrorAlert, Field, Modal } from './Ui';

export interface Dispatch {
  id: number; documentId: number | null; documentLabel: string | null; method: string; recipient: string; address: string | null; sentOn: string;
  tracking: string | null; note: string | null; deliveredOn: string | null; proofFilename: string | null; createdBy: string;
}

export function DispatchList({ items, onChanged }: { items: Dispatch[]; onChanged: () => void }) {
  const [confirming, setConfirming] = useState<Dispatch | null>(null);
  if (items.length === 0) return <Empty title="Nu s-a expediat nimic." />;
  return (
    <>
      <ul className="row-list">
        {items.map((x) => (
          <li key={x.id} className="row-static">
            <span className="row-sub">{fmtDate(x.sentOn)} · {DISPATCH_METHODS[x.method] ?? x.method}{x.tracking ? ` · ${x.tracking}` : ''}{x.documentLabel ? ` · ${x.documentLabel}` : ''}</span>
            <span>{x.recipient}{x.address ? `, ${x.address}` : ''}</span>
            <span>
              {x.deliveredOn ? <Badge tone="success">Comunicat la {fmtDate(x.deliveredOn)}</Badge> : <Badge tone="warning">Așteaptă confirmarea</Badge>}
              {' '}{x.proofFilename && <a href={`/api/dispatches/${x.id}/proof`} target="_blank" rel="noreferrer">Dovada</a>}
              {' '}{(!x.deliveredOn || !x.proofFilename) && <button type="button" className="btn btn-sm" onClick={() => setConfirming(x)}>{x.deliveredOn ? 'Încarcă dovada' : 'Confirmă primirea'}</button>}
            </span>
          </li>
        ))}
      </ul>
      {confirming && <DeliverDialog x={confirming} onClose={() => setConfirming(null)} onDone={() => { setConfirming(null); onChanged(); }} />}
    </>
  );
}


function DeliverDialog({ x, onClose, onDone }: { x: Dispatch; onClose: () => void; onDone: () => void }) {
  const [deliveredOn, setDeliveredOn] = useState(x.deliveredOn ?? todayIso());
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('deliveredOn', deliveredOn);
      if (file) form.set('file', file);
      await api(`/dispatches/${x.id}/delivered`, { method: 'POST', form });
      onDone();
    } catch (err) { setError(err); setBusy(false); }
  };
  return (
    <Modal title="Confirmarea primirii" onClose={onClose} footer={(
      <>
        <button type="button" className="btn" onClick={onClose}>Renunță</button>
        <button type="submit" form="primire" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează'}</button>
      </>
    )}>
      <form id="primire" className="stack" onSubmit={submit}>
      <ErrorAlert error={error} />
      <Field label="Primit de destinatar la"><input type="date" value={deliveredOn} max={todayIso()} onChange={(e) => setDeliveredOn(e.target.value)} /></Field>
      <Field label="Dovada (confirmarea de primire scanată, PDF sau fotografie)">
        <input type="file" accept="application/pdf,image/jpeg,image/png" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      </form>
    </Modal>
  );
}

