import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useUser } from '../auth';
import { ActionNotice } from '../components/TaskActions';
import { Alert, Badge, Empty, ErrorAlert, Field, Loading, Modal, PageHeader, Pagination, StatusBadge } from '../components/Ui';
import { fmtDate, fmtDateTime } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { PROPOSAL_STATUS } from '../labels';
import type { ArchiveItem, Meta, Paged, Proposal } from '../types';

const LIMIT = 25;

export default function ArchivePage() {
  usePageTitle('Arhivă');
  const [params, setParams] = useSearchParams();
  const tab = params.get('vedere') === 'propuneri' ? 'proposals' : 'list';
  const [notice, setNotice] = useState<string | null>(null);
  const proposals = useAsync(() => api<Proposal[]>('/archive/proposals'), []);
  const open = proposals.data?.filter((p) => p.status === 'propusa').length ?? 0;

  return (
    <>
      <PageHeader title="Arhivă" subtitle="Documente arhivate, conform nomenclatorului și termenelor de păstrare. Eliminarea cere propunere și decizie din partea a două persoane diferite." />
      <div className="tabs" role="group" aria-label="Secțiuni arhivă">
        <button type="button" className={tab === 'list' ? 'tab tab-active' : 'tab'} aria-pressed={tab === 'list'} onClick={() => setParams({})}>Documente arhivate</button>
        <button type="button" className={tab === 'proposals' ? 'tab tab-active' : 'tab'} aria-pressed={tab === 'proposals'} onClick={() => setParams({ vedere: 'propuneri' })}>
          Propuneri de eliminare{open > 0 ? ` (${open})` : ''}
        </button>
      </div>
      <ActionNotice message={notice} onDismiss={() => setNotice(null)} />
      {tab === 'list'
        ? <ArchiveList onProposed={(m) => { setNotice(m); void proposals.reload(); }} />
        : <ProposalsList proposals={proposals} onDecided={setNotice} />}
    </>
  );
}

function ArchiveList({ onProposed }: { onProposed: (message: string) => void }) {
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const offset = Number(params.get('offset') ?? 0) || 0;
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const list = useAsync(() => {
    const send = new URLSearchParams(query);
    send.set('limit', String(LIMIT));
    return api<Paged<ArchiveItem>>(`/archive?${send.toString()}`);
  }, [query]);
  const [text, setText] = useState(params.get('q') ?? '');
  const [typeId, setTypeId] = useState(params.get('typeId') ?? '');
  const [expired, setExpired] = useState(params.get('expired') === '1');
  const [proposing, setProposing] = useState<ArchiveItem | null>(null);

  useEffect(() => {
    const current = new URLSearchParams(query);
    setText(current.get('q') ?? '');
    setTypeId(current.get('typeId') ?? '');
    setExpired(current.get('expired') === '1');
  }, [query]);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (text.trim()) next.set('q', text.trim());
    if (typeId) next.set('typeId', typeId);
    if (expired) next.set('expired', '1');
    setParams(next);
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
      <form className="filter-box" onSubmit={apply}>
        <div className="form-grid form-grid-dense">
          <Field label="Căutare"><input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Text sau număr de înregistrare" /></Field>
          <Field label="Tip document">
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Toate tipurile</option>
              {meta.data?.documentTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.nomenclatorCode})</option>)}
            </select>
          </Field>
          <label className="check form-grid-end">
            <input type="checkbox" checked={expired} onChange={(e) => setExpired(e.target.checked)} />
            <span>Doar cu termen de păstrare expirat</span>
          </label>
        </div>
        <div className="filter-actions"><button type="submit" className="btn btn-primary">Filtrează</button></div>
        <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
      </form>
      <ErrorAlert error={list.error} retry={() => void list.reload()} />
      {list.loading && !list.data && <Loading />}
      {list.data && list.data.items.length === 0 && <Empty title="Niciun document arhivat nu corespunde filtrelor." />}
      {list.data && list.data.items.length > 0 && (
        <>
          <div className="table-cards-wrap">
            <table className="table table-cards">
              <caption className="visually-hidden">Documente arhivate</caption>
              <thead>
                <tr>
                  <th scope="col">Număr</th>
                  <th scope="col">Document</th>
                  <th scope="col">Nomenclator</th>
                  <th scope="col">Arhivat</th>
                  <th scope="col">Păstrare până la</th>
                  <th scope="col">Stare</th>
                  <th scope="col"><span className="visually-hidden">Acțiune</span></th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Număr" className="cell-nowrap">{item.regLabel ?? '–'}</td>
                    <td data-label="Document" className="cell-grow">
                      <Link to={`/documente/${item.id}`} className="doc-title-link">{item.title}</Link>
                      <div className="muted cell-small">{item.typeName}</div>
                    </td>
                    <td data-label="Nomenclator">{item.nomenclatorCode}</td>
                    <td data-label="Arhivat" className="cell-nowrap">{fmtDate(item.archivedAt)}</td>
                    <td data-label="Păstrare până la" className="cell-nowrap">
                      {fmtDate(item.retentionUntil, 'Permanent')}
                      {item.expired && <> <Badge tone="warning">Expirat</Badge></>}
                    </td>
                    <td data-label="Stare">
                      <span className="badge-row">
                        <StatusBadge status={item.status} />
                        {item.proposalStatus && <Badge tone={PROPOSAL_STATUS[item.proposalStatus]?.tone ?? 'neutral'}>{PROPOSAL_STATUS[item.proposalStatus]?.label ?? item.proposalStatus}</Badge>}
                      </span>
                    </td>
                    <td className="cell-actions">
                      {item.expired && item.proposalStatus !== 'propusa' && (
                        <button type="button" className="btn btn-sm" onClick={() => setProposing(item)}>Propune eliminarea</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={goTo} />
        </>
      )}
      {proposing && (
        <ProposeDialog
          item={proposing}
          onClose={() => setProposing(null)}
          onDone={() => {
            setProposing(null);
            onProposed('Propunerea de eliminare a fost înregistrată. Decizia aparține altei persoane cu drept de arhivă.');
            void list.reload();
          }}
        />
      )}
    </>
  );
}

function ProposeDialog({ item, onClose, onDone }: { item: ArchiveItem; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/archive/proposals', { method: 'POST', body: { documentId: item.id, reason: reason.trim() || undefined } });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Propunere de eliminare"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Renunță</button>
          <button type="submit" form="propose-form" className="btn btn-primary" disabled={busy}>{busy ? 'Se trimite…' : 'Trimite propunerea'}</button>
        </>
      )}
    >
      <form id="propose-form" onSubmit={submit}>
        <p><strong>{item.regLabel ?? 'Fără număr'}</strong> · {item.title}</p>
        <p className="muted">Termen de păstrare expirat la {fmtDate(item.retentionUntil)}.</p>
        <ErrorAlert error={error} />
        <Field label="Motiv (opțional)">
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function ProposalsList({ proposals, onDecided }: {
  proposals: ReturnType<typeof useAsync<Proposal[]>>; onDecided: (message: string) => void;
}) {
  const user = useUser();
  const [deciding, setDeciding] = useState<{ proposal: Proposal; approve: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const decide = async () => {
    if (!deciding) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/archive/proposals/${deciding.proposal.id}/decide`, { method: 'POST', body: { approve: deciding.approve } });
      onDecided(deciding.approve
        ? 'Eliminarea a fost aprobată. Fișierele au fost șterse; metadatele și amprentele rămân.'
        : 'Propunerea de eliminare a fost respinsă. Documentul rămâne în arhivă.');
      setDeciding(null);
      await proposals.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ErrorAlert error={proposals.error} retry={() => void proposals.reload()} />
      {proposals.loading && !proposals.data && <Loading />}
      {proposals.data && proposals.data.length === 0 && <Empty title="Nu există propuneri de eliminare." />}
      {proposals.data && proposals.data.length > 0 && (
        <div className="table-cards-wrap">
          <table className="table table-cards">
            <caption className="visually-hidden">Propuneri de eliminare</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Păstrare până la</th>
                <th scope="col">Propusă de</th>
                <th scope="col">Motiv</th>
                <th scope="col">Stare</th>
                <th scope="col"><span className="visually-hidden">Decizie</span></th>
              </tr>
            </thead>
            <tbody>
              {proposals.data.map((p) => {
                const own = p.proposedBy === user.fullName;
                const status = PROPOSAL_STATUS[p.status];
                return (
                  <tr key={p.id}>
                    <td data-label="Document" className="cell-grow">
                      <Link to={`/documente/${p.documentId}`} className="doc-title-link">{p.regLabel ?? 'Fără număr'} · {p.title}</Link>
                    </td>
                    <td data-label="Păstrare până la" className="cell-nowrap">{fmtDate(p.retentionUntil, 'Permanent')}</td>
                    <td data-label="Propusă de">{p.proposedBy}<div className="muted cell-small">{fmtDateTime(p.proposedAt)}</div></td>
                    <td data-label="Motiv" className="cell-wrap">{p.reason || '–'}</td>
                    <td data-label="Stare">
                      <Badge tone={status?.tone ?? 'neutral'}>{status?.label ?? p.status}</Badge>
                      {p.decidedBy && <div className="muted cell-small">{p.decidedBy}, {fmtDateTime(p.decidedAt)}</div>}
                    </td>
                    <td className="cell-actions">
                      {p.status === 'propusa' && (own
                        ? <span className="muted cell-small">Decide altă persoană</span>
                        : (
                          <span className="btn-row">
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => { setError(null); setDeciding({ proposal: p, approve: true }); }}>Aprobă eliminarea</button>
                            <button type="button" className="btn btn-sm" onClick={() => { setError(null); setDeciding({ proposal: p, approve: false }); }}>Respinge</button>
                          </span>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {deciding && (
        <Modal
          title={deciding.approve ? 'Aprobare eliminare' : 'Respingere propunere'}
          onClose={() => setDeciding(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDeciding(null)} disabled={busy}>Renunță</button>
              <button type="button" className={deciding.approve ? 'btn btn-danger' : 'btn btn-primary'} onClick={decide} disabled={busy}>
                {busy ? 'Se trimite…' : deciding.approve ? 'Aprobă eliminarea' : 'Respinge propunerea'}
              </button>
            </>
          )}
        >
          <ErrorAlert error={error} />
          <p><strong>{deciding.proposal.regLabel ?? 'Fără număr'}</strong> · {deciding.proposal.title}</p>
          {deciding.approve
            ? <Alert kind="warning">Fișierele documentului se șterg definitiv din stocare. Documentul devine „Eliminat”; metadatele și amprentele rămân pentru audit. Acțiunea nu poate fi anulată.</Alert>
            : <p>Documentul rămâne în arhivă.</p>}
        </Modal>
      )}
    </>
  );
}
