import { useState } from 'react';
import { Archive } from 'lucide-react';
import { api } from '../../api';
import { DefinitionList, ErrorAlert, Modal, Section } from '../../components/Ui';
import { fmtDate, plural } from '../../format';
import type { DocDetail } from '../../types';

const retentionText = (years: number | null) => (years === null ? 'Păstrare permanentă' : plural(years, 'an', 'ani'));

export function RetentionSection({ doc, onArchived }: { doc: DocDetail; onArchived: (message: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const archive = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/documents/${doc.id}/archive`, { method: 'POST' });
      setConfirm(false);
      onArchived('Documentul a fost închis și arhivat.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Arhivare și păstrare"
      icon={Archive}
      collapsible
      defaultOpen={doc.canArchive || !!doc.archivedAt}
      actions={doc.canArchive
        ? <button type="button" className="btn btn-sm" onClick={() => setConfirm(true)}>Arhivează</button>
        : undefined}
    >
      <DefinitionList items={[
        { label: 'Indicativ nomenclator', value: doc.type.nomenclatorCode },
        { label: 'Termen de păstrare', value: retentionText(doc.type.retentionYears) },
        { label: 'Arhivat la', value: fmtDate(doc.archivedAt) },
        { label: 'Se păstrează până la', value: doc.archivedAt ? fmtDate(doc.retentionUntil, 'Permanent') : 'Se stabilește la arhivare' },
      ]} />
      {confirm && (
        <Modal
          title="Închidere și arhivare"
          onClose={() => setConfirm(false)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setConfirm(false)} disabled={busy}>Renunță</button>
              <button type="button" className="btn btn-primary" onClick={archive} disabled={busy}>{busy ? 'Se arhivează…' : 'Arhivează'}</button>
            </>
          )}
        >
          <ErrorAlert error={error} />
          <p>După arhivare, documentul nu mai poate fi modificat și nu mai primește versiuni noi.</p>
          <p>Termen de păstrare: <strong>{retentionText(doc.type.retentionYears)}</strong>, de la data arhivării.</p>
        </Modal>
      )}
    </Section>
  );
}
