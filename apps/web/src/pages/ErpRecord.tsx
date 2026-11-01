import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ERP_KIND_LABEL, erpRecordLabel, type ErpRecord } from '../components/ErpPicker';
import { DefinitionList, Empty, ErrorAlert, Loading, PageHeader, Section, StatusBadge } from '../components/Ui';
import { fmtDate } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import type { DocStatus } from '../types';

interface LinkedDocument { id: number; title: string; regLabel: string | null; regDate: string | null; status: DocStatus; viaRecordId: number; viaKind: string; viaNumber: string | null }
interface ErpDetail extends ErpRecord { documents: LinkedDocument[]; related: ErpRecord[] }

export default function ErpRecordPage() {
  const { id } = useParams();
  const record = useAsync(() => api<ErpDetail>(`/erp/records/${id}`), [id]);
  const r = record.data;
  usePageTitle(r ? erpRecordLabel(r) : 'Date ERP (import)');

  if (record.error) return <ErrorAlert error={record.error} retry={() => void record.reload()} />;
  if (!r) return <Loading />;
  return (
    <>
      <PageHeader
        title={erpRecordLabel(r)}
        subtitle={`${ERP_KIND_LABEL[r.kind]} din datele ERP importate`}
        actions={<Link className="btn" to={`/documente?erpRecordId=${r.id}`}>Caută în documente</Link>}
      />
      <Section title="Date importate">
        <DefinitionList items={[
          { label: 'Cod extern', value: r.externalId },
          ...(r.name ? [{ label: 'Denumire', value: r.name }] : []),
          ...(r.number ? [{ label: 'Număr', value: r.number }] : []),
          ...(r.taxId ? [{ label: 'CUI/CIF', value: r.taxId }] : []),
          ...(r.partnerExternalId ? [{ label: 'Partener', value: r.partnerId ? <Link to={`/erp/${r.partnerId}`}>{r.partnerName}</Link> : `${r.partnerExternalId} (neimportat)` }] : []),
          ...(r.issueDate ? [{ label: 'Data', value: fmtDate(r.issueDate) }] : []),
          ...(r.dueDate ? [{ label: 'Scadență', value: fmtDate(r.dueDate) }] : []),
          ...(r.amount ? [{ label: 'Valoare', value: `${r.amount} ${r.currency ?? ''}` }] : []),
          ...(r.status ? [{ label: 'Stare', value: r.status }] : []),
        ]} />
      </Section>
      <Section title="Documente legate">
        {r.documents.length === 0 && <Empty title="Nu există documente legate pe care le puteți vedea." />}
        {r.documents.length > 0 && (
          <ul className="row-list">
            {r.documents.map((d) => (
              <li key={`${d.id}-${d.viaRecordId}`} className="row-static">
                <Link to={`/documente/${d.id}`}>{d.regLabel ?? 'Fără număr'} · {d.title}</Link>
                {d.viaRecordId !== r.id && <span className="row-sub">prin {d.viaKind === 'factura' ? 'factura' : 'comanda'} {d.viaNumber}</span>}
                <StatusBadge status={d.status} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      {r.related.length > 0 && (
        <Section title="Facturi și comenzi ale partenerului">
          <ul className="row-list">
            {r.related.map((x) => (
              <li key={x.id} className="row-static">
                <span className="row-sub">{ERP_KIND_LABEL[x.kind]}</span>
                <Link to={`/erp/${x.id}`}>{x.number ?? x.externalId}</Link>
                <span className="row-sub">{fmtDate(x.issueDate)}{x.amount ? ` · ${x.amount} ${x.currency ?? ''}` : ''}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
