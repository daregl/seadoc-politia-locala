import { useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, DefinitionList, ErrorAlert } from '../../components/Ui';
import { fmtDateTime, shortHash } from '../../format';
import { useAsync } from '../../hooks';
import type { Tone } from '../../labels';
import type { DocDetail, PdfSignatureCheckRow, SignatureCheck } from '../../types';

const VERDICTS: Record<SignatureCheck['verdict'], { label: string; tone: Tone }> = {
  valida: { label: 'Corectă criptografic, lanț verificat', tone: 'success' },
  lant_neverificat: { label: 'Corectă criptografic; lanț de încredere neverificat', tone: 'warning' },
  lant_invalid: { label: 'Lanț de certificate nevalabil', tone: 'danger' },
  modificat_dupa_semnare: { label: 'Fișierul conține modificări după semnătură', tone: 'warning' },
  certificat_nevalabil: { label: 'Certificat în afara perioadei de valabilitate', tone: 'danger' },
  alterata: { label: 'Conținutul a fost modificat', tone: 'danger' },
  semnatura_invalida: { label: 'Semnătura nu se verifică', tone: 'danger' },
  structura_invalida: { label: 'Structură invalidă', tone: 'danger' },
  nesuportata: { label: 'Format neverificat', tone: 'neutral' },
};

const yesNo = (value: boolean | null, unknown = 'nu s-a putut stabili') => (value === null ? unknown : value ? 'da' : 'nu');

function SignatureCard({ s }: { s: SignatureCheck }) {
  const verdict = VERDICTS[s.verdict];
  const items = [
    { label: 'Titular', value: s.signer?.subject ?? 'necunoscut' },
    { label: 'Emitent', value: s.signer?.issuer ?? 'necunoscut' },
    { label: 'Valabilitate certificat', value: s.signer ? `${fmtDateTime(s.signer.validFrom)} – ${fmtDateTime(s.signer.validTo)}` : '–' },
    { label: 'Valabil la momentul semnării', value: yesNo(s.certificateValidAtSigning) },
    { label: 'Moment declarat al semnării', value: s.signingTime ? `${fmtDateTime(s.signingTime.value)} (${s.signingTime.note})` : 'nedeclarat' },
    { label: 'Amprenta corespunde octeților semnați', value: yesNo(s.digestMatches) },
    { label: 'Semnătura CMS se verifică', value: yesNo(s.cmsSignatureValid) },
    { label: 'Acoperă tot fișierul', value: s.coversWholeFile ? 'da' : `nu (${s.bytesAfterSignature} octeți după semnătură)` },
    { label: 'Lanț de încredere', value: s.chain?.message ?? 'lanț de încredere neverificat' },
    { label: 'Revocare', value: s.revocation.message },
    { label: 'Statut calificat', value: s.qualified.message },
  ];
  if (s.timestamp.message) items.push({ label: 'Marcă temporală', value: s.timestamp.message });
  return (
    <li className="row-static">
      <span className="row-title">{s.signer?.commonName ?? s.fieldName ?? `Semnătura ${s.index}`}</span>
      <span className="row-meta">
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
        {s.testIndicators.length > 0 && <Badge tone="warning">Certificat de test</Badge>}
      </span>
      <span className="row-sub">{s.message}</span>
      {s.testIndicators.length > 0 && <span className="row-sub">Motiv: {s.testIndicators.join('; ')}.</span>}
      {s.issues.map((issue) => <span key={issue} className="row-sub">{issue}</span>)}
      <details>
        <summary>Detalii</summary>
        <DefinitionList items={items} />
      </details>
    </li>
  );
}

/** Verificarea semnăturilor din fișierul PDF, la cerere. Rezultatul rămâne salvat pe versiune. */
export function PdfSignatureChecks({ doc }: { doc: DocDetail }) {
  const latest = doc.versions[0];
  const checks = useAsync(() => api<PdfSignatureCheckRow[]>(`/documents/${doc.id}/pdf-signatures`), [doc.id, latest?.versionNo]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!latest?.hasFile || latest.mime !== 'application/pdf') return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/documents/${doc.id}/pdf-signatures/verify?version=${latest.versionNo}`, { method: 'POST' });
      await checks.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const current = checks.data?.find((c) => c.versionNo === latest.versionNo);
  return (
    <div className="fieldset">
      <div className="row-meta">
        <strong>Semnăturile din fișierul PDF</strong>
        <button type="button" className="btn btn-sm" onClick={() => void run()} disabled={busy}>
          {busy ? 'Se verifică…' : current ? 'Verifică din nou' : 'Verifică semnăturile din PDF'}
        </button>
      </div>
      <ErrorAlert error={error ?? checks.error} />
      {current && (
        <>
          <p className="hint">
            Versiunea {current.versionNo}, verificată la {fmtDateTime(current.checkedAt)} de {current.checkedBy}. SHA-256: {shortHash(current.report.fileSha256)}.
          </p>
          {current.report.status !== 'cu_semnaturi' && (
            <Alert kind={current.report.status === 'fara_semnaturi' ? 'info' : 'warning'}>{current.report.message}</Alert>
          )}
          {current.report.notes.map((n) => <p key={n} className="hint">{n}</p>)}
          {current.report.signatures.length > 0 && (
            <ul className="row-list">{current.report.signatures.map((s) => <SignatureCard key={s.index} s={s} />)}</ul>
          )}
          {current.report.signatures.length > 0 && current.report.trustRootsConfigured === 0 && (
            <p className="hint">Nu este configurată nicio rădăcină de încredere (TRUST_ROOTS_DIR), deci niciun lanț nu poate fi confirmat.</p>
          )}
        </>
      )}
    </div>
  );
}
