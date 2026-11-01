import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { api, fileUrl } from '../../api';
import { Alert, ErrorAlert, Loading } from '../../components/Ui';
import { useAsync } from '../../hooks';
import type { DocDetail, DocVersion } from '../../types';
import { OfficePreview } from './OfficePreview';

type View = 'pdf' | 'original' | 'image' | 'office' | 'text';

const LEGACY_OFFICE = new Set(['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint']);

// Browserele de pe telefon de obicei nu afișează PDF într-un iframe.
const pdfInline = (): boolean => navigator.pdfViewerEnabled !== false;

export function DocPreview({ doc, version }: { doc: DocDetail; version: DocVersion }) {
  const isLatest = doc.versions[0]?.versionNo === version.versionNo;
  const isPdf = version.mime === 'application/pdf';
  const isImage = version.mime === 'image/png' || version.mime === 'image/jpeg';
  const isOffice = /officedocument/.test(version.mime);
  const isLegacy = LEGACY_OFFICE.has(version.mime);
  const isTiff = version.mime === 'image/tiff';
  const canInlinePdf = useMemo(pdfInline, []);
  const hasPdf = isPdf || version.hasSearchable;
  const pending = version.ocrStatus === 'in_asteptare' || version.ocrStatus === 'in_lucru';

  const views = useMemo(() => {
    const out: { key: View; label: string }[] = [];
    if (hasPdf && canInlinePdf) out.push({ key: 'pdf', label: version.hasSearchable ? 'PDF căutabil' : 'PDF' });
    if (isPdf && version.hasSearchable && canInlinePdf) out.push({ key: 'original', label: 'PDF original' });
    if (isImage) out.push({ key: 'image', label: 'Imagine' });
    if (isOffice) out.push({ key: 'office', label: 'Previzualizare' });
    out.push({ key: 'text', label: 'Text extras' });
    return out;
  }, [hasPdf, canInlinePdf, isPdf, isImage, isOffice, version.hasSearchable]);

  const [view, setView] = useState<View>(views[0].key);
  // La schimbarea versiunii sau când apare PDF-ul căutabil se revine la prima vizualizare disponibilă.
  useEffect(() => { setView(views[0].key); }, [views, version.versionNo]);

  if (!version.hasFile) {
    return <Alert kind="warning">Fișierul a fost eliminat la expirarea termenului de păstrare. Metadatele și amprentele rămân în sistem.</Alert>;
  }

  const pdfUrl = fileUrl(doc.id, { version: version.versionNo, kind: version.hasSearchable ? 'searchable' : 'original' });
  const originalUrl = fileUrl(doc.id, { version: version.versionNo, kind: 'original' });
  const download = fileUrl(doc.id, { version: version.versionNo, kind: 'original', download: true });
  const nativeApp = !hasPdf && !isImage && !isOffice;

  return (
    <div className="preview">
      <div className="preview-toolbar">
        {views.length > 1 && (
          <div className="tabs tabs-small" role="group" aria-label="Mod de vizualizare">
            {views.map((v) => (
              <button key={v.key} type="button" className={view === v.key ? 'tab tab-active' : 'tab'} aria-pressed={view === v.key} onClick={() => setView(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
        )}
        <div className="preview-actions">
          {hasPdf && (
            <a className="btn btn-sm" href={pdfUrl} target="_blank" rel="noopener" aria-label={version.hasSearchable ? 'Deschide PDF-ul căutabil' : 'Deschide PDF-ul'}>
              <ExternalLink size={15} aria-hidden="true" />Deschide
            </a>
          )}
          {isImage && !hasPdf && <a className="btn btn-sm" href={originalUrl} target="_blank" rel="noopener"><ExternalLink size={15} aria-hidden="true" />Deschide</a>}
          <a className={nativeApp ? 'btn btn-sm btn-primary' : 'btn btn-sm'} href={download}>
            <Download size={15} aria-hidden="true" />{nativeApp ? 'Descarcă și deschide în aplicație' : 'Descarcă originalul'}
          </a>
          {version.hasSearchable && (
            <a className="btn btn-sm" href={fileUrl(doc.id, { version: version.versionNo, kind: 'searchable', download: true })}><Download size={15} aria-hidden="true" />PDF căutabil</a>
          )}
        </div>
      </div>
      {view === 'pdf' && <iframe className="preview-frame" src={pdfUrl} title={`Previzualizare: ${version.filename}`} />}
      {view === 'original' && <iframe className="preview-frame" src={originalUrl} title={`Original: ${version.filename}`} />}
      {view === 'image' && <img className="preview-image" src={originalUrl} alt={`Previzualizare: ${version.filename}`} />}
      {view === 'office' && <OfficePreview documentId={doc.id} version={version} />}
      {view === 'text' && !isLatest && <p className="hint">Textul afișat provine din ultima versiune a documentului, nu din versiunea {version.versionNo}.</p>}
      {view === 'text' && <ExtractedText documentId={doc.id} pending={pending} statusKey={`${version.versionNo}-${version.ocrStatus}`} failed={version.ocrStatus === 'esuat'} />}
      {isLegacy && <Alert kind="info">Formatele binare vechi (.doc, .xls, .ppt) nu se previzualizează în browser și nu au text extras. Descărcați fișierul și deschideți-l în aplicația instalată.</Alert>}
      {isTiff && !hasPdf && <p className="hint">Browserele nu afișează TIFF. După OCR, documentul apare aici ca PDF căutabil.</p>}
      {nativeApp && !isLegacy && !isTiff && <p className="hint">Acest tip de fișier nu se poate previzualiza în browser. Mai sus este textul extras; fișierul se deschide cu aplicația instalată pe calculator.</p>}
      {hasPdf && !canInlinePdf && <p className="hint">Browserul de pe acest dispozitiv nu afișează PDF în pagină. Folosiți butonul de deschidere sau textul extras.</p>}
    </div>
  );
}

function ExtractedText({ documentId, pending, failed, statusKey }: { documentId: number; pending: boolean; failed: boolean; statusKey: string }) {
  const { data, error, loading, reload } = useAsync(() => api<{ text: string | null }>(`/documents/${documentId}/text`), [documentId, statusKey]);
  const text = data?.text?.trim();
  if (error) return <ErrorAlert error={error} retry={() => void reload()} />;
  if (loading && !data) return <Loading label="Se încarcă textul extras…" />;
  if (text) return <pre className="preview-text" tabIndex={0}>{text}</pre>;
  if (pending) return <Alert kind="info">Textul este în curs de extragere și va apărea aici automat.</Alert>;
  if (failed) return <Alert kind="warning">Extragerea textului a eșuat pentru acest fișier. Fișierul original rămâne disponibil.</Alert>;
  return <Alert kind="info">Fișierul nu conține text care să poată fi extras.</Alert>;
}
