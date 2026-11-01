import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Database, Plus } from 'lucide-react';
import { api } from '../../api';
import { ERP_KIND_LABEL, erpRecordLabel, ErpPicker, type ErpRecord } from '../../components/ErpPicker';
import { Alert, Empty, ErrorAlert, Loading, Section } from '../../components/Ui';
import { useAsync } from '../../hooks';
import type { DocDetail } from '../../types';

/** Partenerii, facturile și comenzile legate de document, din datele ERP importate. */
export function ErpSection({ doc }: { doc: DocDetail }) {
  const location = useLocation();
  const failedAtCreate = (location.state as { erpFailed?: number } | null)?.erpFailed ?? 0;
  const links = useAsync(() => api<ErpRecord[]>(`/documents/${doc.id}/erp-links`), [doc.id]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const add = async (record: ErpRecord) => {
    setError(null);
    try {
      links.setData(await api<ErpRecord[]>(`/documents/${doc.id}/erp-links`, { method: 'POST', body: { recordId: record.id } }));
    } catch (err) {
      setError(err);
    }
  };
  const remove = async (record: ErpRecord) => {
    setError(null);
    try {
      links.setData(await api<ErpRecord[]>(`/documents/${doc.id}/erp-links/${record.id}`, { method: 'DELETE' }));
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Section
      title="Date ERP (import)"
      icon={Database}
      count={links.data?.length ?? 0}
      collapsible
      defaultOpen={!!links.data?.length || adding || failedAtCreate > 0}
      actions={doc.canEdit ? (
        <button type="button" className="btn btn-sm" aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus size={15} aria-hidden="true" />Adaugă</button>
      ) : undefined}
    >
      {failedAtCreate > 0 && <Alert kind="warning">Documentul s-a înregistrat, dar {failedAtCreate === 1 ? 'o legătură ERP nu s-a putut salva' : `${failedAtCreate} legături ERP nu s-au putut salva`}. Adăugați-le din nou.</Alert>}
      <ErrorAlert error={error ?? links.error} />
      {adding && <ErpPicker onPick={(r) => void add(r)} excludeIds={links.data?.map((r) => r.id)} />}
      {links.loading && !links.data && <Loading />}
      {links.data?.length === 0 && !adding && <Empty title="Documentul nu este legat de date ERP." />}
      {!!links.data?.length && (
        <ul className="row-list">
          {links.data.map((r) => (
            <li key={r.id} className="row-static">
              <span className="row-sub">{ERP_KIND_LABEL[r.kind]}</span>
              <Link to={`/erp/${r.id}`}>{erpRecordLabel(r)}</Link>
              {doc.canEdit && <button type="button" className="btn btn-sm btn-link" onClick={() => void remove(r)}>Elimină</button>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
