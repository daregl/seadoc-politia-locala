import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Alert, Empty, ErrorAlert, Field, Loading, PageHeader, Pagination } from '../../components/Ui';
import { fmtDate, plural } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';
import { CASE_KINDS, CaseDeadline, CaseStatus, type CaseKind, type CaseRow } from './caseTypes';

const LIMIT = 25;

export default function CasesPage() {
  usePageTitle('Lucrări');
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const kind = params.get('kind') ?? '';
  const offset = Number(params.get('offset') ?? 0) || 0;
  const list = useAsync(() => {
    const send = new URLSearchParams(query);
    send.set('limit', String(LIMIT));
    if (!send.has('status')) send.set('status', 'deschisa');
    if (send.get('status') === 'toate') send.delete('status');
    return api<{ total: number; overdue: number; items: CaseRow[] }>(`/cases?${send.toString()}`);
  }, [query]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.delete('offset');
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  const goTo = (n: number) => {
    const next = new URLSearchParams(params);
    if (n) next.set('offset', String(n));
    else next.delete('offset');
    setParams(next);
    window.scrollTo({ top: 0 });
  };
  const canRegister = can('register', 'cases_all');

  return (
    <>
      <PageHeader
        title="Lucrări"
        subtitle="Petiții, cereri de informații publice, dosare contravenționale și acțiuni de control, cu termenele legale."
        actions={(
          <>
            {can('reports', 'cases_all') && <Link className="btn" to="/lucrari/raport-petitii">Situația semestrială</Link>}
            <Link className="btn btn-primary" to={`/lucrari/nou${kind ? `?tip=${kind}` : canRegister ? '' : '?tip=contraventie'}`}>Lucrare nouă</Link>
          </>
        )}
      />
      <nav className="tabs" aria-label="Tip de lucrare">
        <button type="button" className={kind === '' ? 'tab tab-active' : 'tab'} onClick={() => setFilter('kind', '')}>Toate</button>
        {(Object.keys(CASE_KINDS) as CaseKind[]).map((k) => (
          <button key={k} type="button" className={kind === k ? 'tab tab-active' : 'tab'} onClick={() => setFilter('kind', k)}>{CASE_KINDS[k].plural}</button>
        ))}
      </nav>
      {list.data && list.data.overdue > 0 && params.get('overdue') !== '1' && (
        <Alert kind="error" title={`${plural(list.data.overdue, 'lucrare are', 'lucrări au')} termenul depășit`}>
          <button type="button" className="btn btn-sm alert-action" onClick={() => setFilter('overdue', '1')}>Arată-le</button>
        </Alert>
      )}
      <div className="filter-box">
        <div className="form-grid form-grid-dense">
          <Field label="Caută">
            <input type="search" defaultValue={params.get('q') ?? ''} placeholder="Număr, petent, obiect, adresă, PV"
              onKeyDown={(e) => { if (e.key === 'Enter') setFilter('q', (e.target as HTMLInputElement).value.trim()); }}
              onBlur={(e) => { if (e.target.value.trim() !== (params.get('q') ?? '')) setFilter('q', e.target.value.trim()); }} />
          </Field>
          <Field label="Stare">
            <select value={params.get('status') ?? 'deschisa'} onChange={(e) => setFilter('status', e.target.value === 'deschisa' ? '' : e.target.value)}>
              <option value="deschisa">Deschise</option>
              <option value="inchisa">Închise</option>
              <option value="toate">Toate</option>
            </select>
          </Field>
          <label className="check form-grid-end">
            <input type="checkbox" checked={params.get('mine') === '1'} onChange={(e) => setFilter('mine', e.target.checked ? '1' : '')} />
            <span>Doar ale mele</span>
          </label>
          <label className="check form-grid-end">
            <input type="checkbox" checked={params.get('overdue') === '1'} onChange={(e) => setFilter('overdue', e.target.checked ? '1' : '')} />
            <span>Termen depășit</span>
          </label>
          {(kind === '' || kind === 'contraventie') && (
            <label className="check form-grid-end">
              <input type="checkbox" checked={params.get('readyForExecution') === '1'} onChange={(e) => setFilter('readyForExecution', e.target.checked ? '1' : '')} />
              <span>De trimis spre executare</span>
            </label>
          )}
        </div>
      </div>
      <ErrorAlert error={list.error} retry={() => void list.reload()} />
      {list.loading && !list.data && <Loading />}
      {list.data && list.data.items.length === 0 && <Empty title="Nu există lucrări pentru aceste filtre." />}
      {list.data && list.data.items.length > 0 && (
        <>
          <div className="table-cards-wrap">
            <table className="table table-cards">
              <caption className="visually-hidden">Lucrări</caption>
              <thead>
                <tr>
                  <th scope="col">Număr</th>
                  <th scope="col">Obiect</th>
                  <th scope="col">Petent / contravenient</th>
                  <th scope="col">Înregistrată</th>
                  <th scope="col">Termen</th>
                  <th scope="col">Stare</th>
                  <th scope="col">Responsabil</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.id} className={r.overdue ? 'row-overdue' : undefined}>
                    <td data-label="Număr" className="cell-nowrap">
                      <Link to={`/lucrari/${r.id}`} className="doc-title-link">{r.regLabel}</Link>
                      {r.pvLabel && <div className="muted">PV {r.pvLabel}</div>}
                    </td>
                    <td data-label="Obiect" className="cell-grow">
                      <Link to={`/lucrari/${r.id}`} className="doc-title-link">{r.subject}</Link>
                      <div className="muted">{CASE_KINDS[r.kind].label}{r.location ? ` · ${r.location}` : ''}</div>
                    </td>
                    <td data-label="Petent">{r.offenderName ?? (r.anonymous ? 'Anonim' : r.applicantName) ?? '–'}</td>
                    <td data-label="Înregistrată" className="cell-nowrap">{fmtDate(r.receivedOn)}</td>
                    <td data-label="Termen">
                      <span className="cell-nowrap">{fmtDate(r.dueOn)}</span>
                      <div><CaseDeadline row={r} /></div>
                    </td>
                    <td data-label="Stare"><CaseStatus row={r} /></td>
                    <td data-label="Responsabil">{r.assigneeName ?? <span className="muted">Nerepartizată</span>}<div className="muted">{r.departmentName}</div></td>
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
