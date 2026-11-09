import { Link } from 'react-router-dom';
import { api, qs } from '../../api';
import { Section } from '../../components/Ui';
import { fmtDate } from '../../format';
import { useAsync } from '../../hooks';
import { CASE_KINDS, CaseDeadline, type CaseKind, type CaseRow } from './caseTypes';

interface CasesDash {
  scope: 'institutie' | 'serviciu' | 'personal';
  byDepartment: boolean;
  byKind: { kind: CaseKind; open: number; overdue: number; dueSoon: number; readyForExecution: number }[];
  urgent: CaseRow[];
  breakdown: { label: string; open: number; overdue: number }[];
  unassigned: number;
  closedThisMonth: number;
}

const SCOPE_TITLE = { institutie: 'Lucrări: toată instituția', serviciu: 'Lucrări: compartimentul meu', personal: 'Lucrările mele' };

/** Conducerea vede instituția pe compartimente, șeful de serviciu pe oameni, execuția doar lucrările proprii. */
export function CasesDashboard() {
  const { data } = useAsync(() => api<CasesDash>('/cases/dashboard'), []);
  if (!data) return null;
  const total = data.byKind.reduce((n, k) => n + k.open, 0);
  if (total === 0 && data.closedThisMonth === 0 && data.scope === 'personal') return null;
  const overdue = data.byKind.reduce((n, k) => n + k.overdue, 0);
  const mine = data.scope === 'personal' ? { mine: '1' } : {};
  return (
    <Section title={SCOPE_TITLE[data.scope]} actions={<Link className="panel-link" to={`/lucrari${qs(mine)}`}>Toate lucrările</Link>}>
      <div className="stat-row">
        <Link className="stat-cell" to={`/lucrari${qs(mine)}`}><b>{total}</b><span>deschise</span></Link>
        <Link className={overdue ? 'stat-cell stat-cell-alert' : 'stat-cell'} to={`/lucrari${qs({ ...mine, overdue: '1' })}`}><b>{overdue}</b><span>cu termen depășit</span></Link>
        {data.byKind.filter((k) => k.open > 0).map((k) => (
          <Link key={k.kind} className="stat-cell" to={`/lucrari${qs({ ...mine, kind: k.kind })}`}>
            <b>{k.open}</b><span>{CASE_KINDS[k.kind].plural.toLowerCase()}{k.readyForExecution ? `, ${k.readyForExecution} de trimis la executare` : ''}</span>
          </Link>
        ))}
        {data.scope !== 'personal' && <div className="stat-cell"><b>{data.unassigned}</b><span>nerepartizate</span></div>}
        <div className="stat-cell"><b>{data.closedThisMonth}</b><span>închise luna aceasta</span></div>
      </div>
      {data.urgent.length > 0 && (
        <>
          <h3>Termene apropiate sau depășite</h3>
          <ul className="row-list">
            {data.urgent.map((c) => (
              <li key={c.id}>
                <Link to={`/lucrari/${c.id}`} className="row-link ledger-row">
                  <span className={c.overdue ? 'ledger-when ledger-when-late' : 'ledger-when'}>{fmtDate(c.dueOn, 'executare')}</span>
                  <span className="ledger-body">
                    <span className="row-title">{c.regLabel} · {c.subject}</span>
                    <span className="row-sub">{CASE_KINDS[c.kind].label} · {c.assigneeName ?? 'nerepartizată'} <CaseDeadline row={c} /></span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.breakdown.length > 0 && (
        <table className="table">
          <caption className="visually-hidden">Repartizare</caption>
          <thead><tr><th scope="col">{data.byDepartment ? 'Compartiment' : 'Responsabil'}</th><th scope="col">Deschise</th><th scope="col">Termen depășit</th></tr></thead>
          <tbody>{data.breakdown.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.open}</td><td>{b.overdue || ''}</td></tr>)}</tbody>
        </table>
      )}
    </Section>
  );
}
