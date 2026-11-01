import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useUser } from '../auth';
import { Empty, ErrorAlert, Field, Loading, PageHeader, Section, StatusBadge } from '../components/Ui';
import { fmtDateTime, fmtHours, fmtNumber, plural } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import { DOC_STATUS } from '../labels';
import type { DocStatus, Meta, ReportSummary } from '../types';

const STATUS_ORDER = Object.keys(DOC_STATUS) as DocStatus[];

export default function ReportsPage() {
  usePageTitle('Rapoarte');
  const user = useUser();
  const isAdmin = user.role === 'admin';
  const [departmentId, setDepartmentId] = useState('');
  const meta = useAsync(() => (isAdmin ? api<Meta>('/meta') : Promise.resolve(null)), [isAdmin]);
  const { data, error, loading, reload } = useAsync(
    () => api<ReportSummary>(`/reports/summary${qs({ departmentId })}`), [departmentId],
  );

  const pivot = useMemo(() => {
    const rows = new Map<string, Partial<Record<DocStatus, number>>>();
    for (const row of data?.byStatus ?? []) {
      rows.set(row.departmentName, { ...rows.get(row.departmentName), [row.status]: row.count });
    }
    const list = [...rows.entries()].map(([name, counts]) => ({
      name, counts, total: Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0),
    }));
    const statuses = STATUS_ORDER.filter((s) => list.some((r) => r.counts[s]));
    const max = Math.max(1, ...list.map((r) => r.total));
    return { list, statuses, max };
  }, [data]);
  const maxHours = Math.max(1, ...(data?.resolution ?? []).map((r) => r.avgHours ?? 0));

  return (
    <>
      <PageHeader
        title="Rapoarte"
        subtitle={isAdmin ? 'Situația documentelor și a sarcinilor pe departamente.' : `Date pentru departamentul ${user.departmentName ?? 'dumneavoastră'}.`}
      />
      {isAdmin && (
        <div className="filter-box filter-inline">
          <Field label="Departament">
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Toate departamentele</option>
              {meta.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <ErrorAlert error={meta.error} retry={() => void meta.reload()} />
        </div>
      )}
      <ErrorAlert error={error} retry={() => void reload()} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Section title="Documente pe stări și departamente">
            {pivot.list.length === 0 ? <Empty title="Nu există documente." /> : (
              <div className="table-scroll" role="region" aria-label="Documente pe stări și departamente" tabIndex={0}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Departament</th>
                      {pivot.statuses.map((s) => <th scope="col" key={s} className="cell-num"><StatusBadge status={s} /></th>)}
                      <th scope="col" className="cell-num">Total</th>
                      <th scope="col" className="cell-bar"><span className="visually-hidden">Proporție</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pivot.list.map((row) => (
                      <tr key={row.name}>
                        <th scope="row">{row.name}</th>
                        {pivot.statuses.map((s) => <td key={s} className="cell-num">{fmtNumber(row.counts[s] ?? 0)}</td>)}
                        <td className="cell-num"><strong>{fmtNumber(row.total)}</strong></td>
                        <td className="cell-bar" aria-hidden="true">
                          <span className="bar"><span className="bar-fill" style={{ width: `${(row.total / pivot.max) * 100}%` }} /></span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Timp mediu de soluționare a fluxurilor">
            {data.resolution.length === 0 ? <Empty title="Nu există fluxuri încheiate." /> : (
              <div className="table-scroll" role="region" aria-label="Timp mediu de soluționare" tabIndex={0}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Departament</th>
                      <th scope="col" className="cell-num">Fluxuri încheiate</th>
                      <th scope="col" className="cell-num">Timp mediu</th>
                      <th scope="col" className="cell-bar"><span className="visually-hidden">Proporție</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.resolution.map((row) => (
                      <tr key={row.departmentName}>
                        <th scope="row">{row.departmentName}</th>
                        <td className="cell-num">{fmtNumber(row.count)}</td>
                        <td className="cell-num">{fmtHours(row.avgHours)}</td>
                        <td className="cell-bar" aria-hidden="true">
                          <span className="bar"><span className="bar-fill" style={{ width: `${((row.avgHours ?? 0) / maxHours) * 100}%` }} /></span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title={`Sarcini cu termen depășit${data.overdue.length ? ` (${plural(data.overdue.length, 'sarcină', 'sarcini')})` : ''}`}>
            {data.overdue.length === 0 ? <Empty title="Nu există sarcini cu termen depășit." /> : (
              <div className="table-cards-wrap">
                <table className="table table-cards">
                  <thead>
                    <tr>
                      <th scope="col">Document</th>
                      <th scope="col">Titular</th>
                      <th scope="col">Termen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.overdue.map((row) => (
                      <tr key={row.taskId}>
                        <td data-label="Document" className="cell-grow"><Link to={`/documente/${row.documentId}`}>{row.title}</Link></td>
                        <td data-label="Titular">{row.assignee}</td>
                        <td data-label="Termen" className="cell-nowrap">{fmtDateTime(row.dueAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}
