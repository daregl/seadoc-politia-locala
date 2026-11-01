import { useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { CertificateSign, signedMessage } from '../../components/CertificateSign';
import { Alert, Badge, Empty, ErrorAlert, Section } from '../../components/Ui';
import { fmtDateTime, shortHash } from '../../format';
import type { DocDetail, DocSignature } from '../../types';
import { PdfSignatureChecks } from './PdfSignatureChecks';

interface VerifyRow { id: number; kind: string; valid: boolean; certificate?: { verdict: string; chain: string | null; message: string; testIndicators: string[] } }

function VerifyBadge({ row, doc }: { row: VerifyRow; doc: DocDetail }) {
  if (!row.valid) {
    return <Badge tone="danger">{doc.status === 'eliminat' ? 'Nu se poate verifica: fișierul a fost eliminat' : 'Nevalabilă: conținutul, sigiliul sau semnătura diferă'}</Badge>;
  }
  if (row.kind !== 'certificat') return <Badge tone="success">Valabilă: conținutul și sigiliul corespund</Badge>;
  return row.certificate?.chain === 'verificat'
    ? <Badge tone="success">Corectă criptografic, lanț verificat</Badge>
    : <Badge tone="warning">Corectă criptografic; lanț de încredere neverificat</Badge>;
}

const kindLabel = (s: DocSignature) => (s.kind === 'certificat' ? 'Semnătură cu certificat' : 'Semnătură electronică internă');

export function SignaturesSection({ doc, onSigned }: { doc: DocDetail; onSigned?: (message: string) => void }) {
  const { can } = useAuth();
  const [results, setResults] = useState<Record<number, VerifyRow> | null>(null);
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const rows = await api<VerifyRow[]>(`/documents/${doc.id}/signatures/verify`);
      setResults(Object.fromEntries(rows.map((r) => [r.id, r])));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Semnături"
      count={doc.signatures.length}
      collapsible
      defaultOpen={doc.signatures.length > 0}
      actions={doc.signatures.length > 0
        ? <button type="button" className="btn btn-sm" onClick={verify} disabled={busy}>{busy ? 'Se verifică…' : 'Verifică'}</button>
        : undefined}
    >
      <ErrorAlert error={error} />
      {doc.signatures.length === 0 && <Empty title="Documentul nu are semnături." />}
      {doc.signatures.length > 0 && (
        <ul className="row-list">
          {doc.signatures.map((s) => (
            <li key={s.id} className="row-static">
              <span className="row-title">{s.signer}</span>
              <span className="row-sub">{kindLabel(s)} · versiunea {s.versionNo} · {fmtDateTime(s.signedAt)}</span>
              {s.kind === 'certificat' && (
                <>
                  <span className="row-sub">Certificat: {s.certificateSubject}. Emitent: {s.certificateIssuer}.</span>
                  {s.testIndicators.length > 0 && <span className="row-meta"><Badge tone="warning">Certificat de test: fără valoare juridică</Badge></span>}
                </>
              )}
              <span className="row-sub" title={s.sha256}>SHA-256: {shortHash(s.sha256)}</span>
              {results && s.id in results && (
                <span className="row-meta"><VerifyBadge row={results[s.id]} doc={doc} /></span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Semnătura internă confirmă în SeaDoc identitatea semnatarului și versiunea semnată. Nu este o semnătură electronică calificată.
      </p>
      <PdfSignatureChecks doc={doc} />
      {can('sign_qualified') && doc.canAddVersion && doc.status !== 'in_flux' && (
        <div className="sign-qualified">
          {!signing && <button type="button" className="btn btn-sm" onClick={() => setSigning(true)}>Semnătură cu certificat</button>}
          {signing && (
            <CertificateSign
              documentId={doc.id}
              onCancel={() => setSigning(false)}
              onSigned={(result) => { setSigning(false); onSigned?.(signedMessage(result)); }}
            />
          )}
        </div>
      )}
      {doc.status === 'in_flux' && <Alert kind="info">Cât timp documentul este în flux, semnătura cu certificat se aplică din sarcina de semnare.</Alert>}
    </Section>
  );
}

