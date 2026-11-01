import { api } from '../../api';
import { Alert, ErrorAlert, Loading } from '../../components/Ui';
import { useAsync } from '../../hooks';
import type { DocVersion, OfficePreviewReply } from '../../types';

// HTML-ul este curățat pe server; cadrul fără scripturi și regula de mai jos sunt a doua linie de apărare.
const FRAME_CSP = `default-src 'none'; img-src data:; style-src 'unsafe-inline'`;
const FRAME_STYLE = `body{font:15px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#fff;margin:16px;overflow-wrap:anywhere}
table{border-collapse:collapse;margin:8px 0 20px}td,th{border:1px solid #bbb;padding:3px 7px;vertical-align:top;white-space:pre-wrap}
img{max-width:100%;height:auto}h2{font-size:17px;margin:18px 0 8px}section+section{border-top:1px solid #ddd;margin-top:16px}`;

const frameDocument = (html: string) =>
  `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${FRAME_STYLE}</style></head><body>${html}</body></html>`;

export function OfficePreview({ documentId, version }: { documentId: number; version: DocVersion }) {
  const { data, error, loading, reload } = useAsync(
    () => api<OfficePreviewReply>(`/documents/${documentId}/preview?version=${version.versionNo}`), [documentId, version.versionNo]);
  if (loading && !data) return <Loading label="Se pregătește previzualizarea…" />;
  if (error) return <ErrorAlert error={error} retry={() => void reload()} />;
  if (!data) return null;
  if (data.kind !== 'html') return <Alert kind="info">{data.message}</Alert>;
  return (
    <>
      {data.notes.map((note) => <p key={note} className="hint">{note}</p>)}
      <iframe
        className="preview-frame"
        title={`Previzualizare: ${version.filename}`}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={frameDocument(data.html)}
      />
    </>
  );
}
