import { Link } from 'react-router-dom';
import { fmtDateTime, shortHash } from '../format';
import { auditLabel } from '../labels';
import type { AuditRow } from '../types';

function detailsText(details: AuditRow['details']): string {
  if (!details) return '';
  return Object.entries(details)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join('; ');
}

export function AuditTable({ items, caption }: { items: AuditRow[]; caption: string }) {
  return (
    <div className="table-cards-wrap">
      <table className="table table-cards table-audit">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Nr.</th>
            <th scope="col">Moment</th>
            <th scope="col">Utilizator</th>
            <th scope="col">Acțiune</th>
            <th scope="col">Document</th>
            <th scope="col">IP</th>
            <th scope="col">Detalii</th>
            <th scope="col">Amprentă</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => {
            const details = detailsText(row.details);
            return (
              <tr key={String(row.seq)}>
                <td data-label="Nr.">{String(row.seq)}</td>
                <td data-label="Moment" className="cell-nowrap">{fmtDateTime(row.at)}</td>
                <td data-label="Utilizator">{row.username ?? 'Sistem'}</td>
                <td data-label="Acțiune">
                  {auditLabel(row.action)}
                  <div><code className="code-small">{row.action}</code></div>
                </td>
                <td data-label="Document">
                  {row.documentId ? <Link to={`/documente/${row.documentId}`}>#{row.documentId}</Link> : '–'}
                </td>
                <td data-label="IP">{row.ip || '–'}</td>
                <td data-label="Detalii" className="cell-wrap cell-small">{details || '–'}</td>
                <td data-label="Amprentă" title={row.hash}><code className="code-small">{shortHash(row.hash)}</code></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
