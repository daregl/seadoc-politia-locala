import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { FileDrop } from '../../components/FileDrop';
import { Alert, Badge, ErrorAlert, Section } from '../../components/Ui';
import { fmtDateTime, fmtSize, shortHash } from '../../format';
import { OCR_STATUS } from '../../labels';
import type { DocDetail, DocVersion } from '../../types';

export function OcrBadges({ version }: { version: DocVersion }) {
  const status = OCR_STATUS[version.ocrStatus] ?? { label: version.ocrStatus, tone: 'neutral' as const };
  const pending = version.ocrStatus === 'in_asteptare' || version.ocrStatus === 'in_lucru';
  return (
    <span className="badge-row">
      <Badge tone={status.tone}>
        {pending && <span className="spinner spinner-inline" aria-hidden="true" />}
        {status.label}
      </Badge>
      {version.ocrUsed && <Badge tone="neutral">Recunoaștere OCR</Badge>}
      {version.hasSearchable && <Badge tone="success">PDF căutabil generat</Badge>}
    </span>
  );
}

export function VersionsSection({ doc, selected, onSelect, onUploaded }: {
  doc: DocDetail; selected: number; onSelect: (versionNo: number) => void; onUploaded: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) { setProblem('Alegeți un fișier.'); return; }
    setProblem(null);
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const form = new FormData();
      form.set('file', file);
      const created = await api<{ versionNo: number }>(`/documents/${doc.id}/versions`, { method: 'POST', form });
      setFile(null);
      setShowUpload(false);
      setDone(`Versiunea ${created.versionNo} a fost încărcată. Textul se extrage automat.`);
      await onUploaded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Versiuni"
      count={doc.versions.length}
      collapsible
      defaultOpen={doc.versions.length > 1 || showUpload || done !== null}
      actions={doc.canAddVersion ? (
        <button type="button" className="btn btn-sm" aria-expanded={showUpload} onClick={() => setShowUpload(!showUpload)}>Versiune nouă</button>
      ) : undefined}
    >
      {done && <Alert kind="success">{done}</Alert>}
      {showUpload && (
        <form className="inline-form" onSubmit={upload}>
          <ErrorAlert error={error} />
          {problem && <Alert kind="error">{problem}</Alert>}
          <FileDrop file={file} onChange={setFile} label="Fișierul versiunii noi" required />
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se încarcă…' : 'Încarcă versiunea'}</button>
        </form>
      )}
      <ul className="version-list">
        {doc.versions.map((v) => (
          <li key={v.id} className={v.versionNo === selected ? 'version version-selected' : 'version'}>
            <div className="version-main">
              <strong>Versiunea {v.versionNo}</strong>
              <span className="version-file">{v.filename}</span>
              <span className="muted cell-small">
                {fmtSize(v.sizeBytes)} · {v.createdBy} · {fmtDateTime(v.createdAt)}
              </span>
              <span className="muted cell-small" title={v.sha256}>SHA-256: {shortHash(v.sha256)}</span>
              <OcrBadges version={v} />
            </div>
            {v.versionNo !== selected
              ? <button type="button" className="btn btn-sm" onClick={() => onSelect(v.versionNo)}>Previzualizează</button>
              : <span className="muted cell-small">Afișată</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
