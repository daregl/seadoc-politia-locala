import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { fmtDate } from '../format';
import { useAsync } from '../hooks';
import {
  AgentCertificate, agentCertificates, agentRequestSignature, agentSignatureState, agentStatus, AgentStatus, storeToken,
} from '../signing-agent';
import type { SignatureCheck } from '../types';
import { Alert, ErrorAlert, Field, Loading } from './Ui';

export interface CertificateSignResult {
  signatureId: number;
  versionNo: number;
  sha256: string;
  testCertificate: boolean;
  signature: SignatureCheck;
  task: { taskId: number; status: string; instanceStatus: string } | null;
}

interface PrepareReply { sessionId: string; digestHex: string; label: string; expiresAt: string }
interface SigningConfig { agentOrigin: string; trustRootsConfigured: boolean }

/** Mesajul de după semnare spune exact ce s-a stabilit, nu mai mult. */
export function signedMessage(r: CertificateSignResult): string {
  const parts = [`Documentul a fost semnat cu certificat. A rezultat versiunea ${r.versionNo}.`];
  if (r.testCertificate) parts.push('Certificatul este de test: semnătura nu are valoare juridică.');
  const chain = r.signature.chain?.message ?? 'lanț de încredere neverificat';
  parts.push(`${chain.charAt(0).toUpperCase()}${chain.slice(1)}.`);
  parts.push('Statutul calificat eIDAS și revocarea certificatului nu au fost verificate.');
  return parts.join(' ');
}

export function CertificateSign({ taskId, documentId, comment, onSigned, onCancel }: {
  taskId?: number;
  documentId?: number;
  comment?: string;
  onSigned: (result: CertificateSignResult) => void;
  onCancel?: () => void;
}) {
  const config = useAsync(() => api<SigningConfig>('/signing/config'), []);
  const origin = config.data?.agentOrigin;
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [certificates, setCertificates] = useState<AgentCertificate[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [chosen, setChosen] = useState('');
  const [pairing, setPairing] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [step, setStep] = useState<'alegere' | 'pregatire' | 'confirmare' | 'finalizare'>('alegere');
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  const detect = useCallback(async () => {
    if (!origin) return;
    setError(null);
    setStatus(null);
    const next = await agentStatus(origin);
    setStatus(next);
    if (next !== 'asociat') return;
    try {
      const list = await agentCertificates(origin);
      setCertificates(list.certificates);
      setProblems(list.problems);
      setChosen((cur) => cur || (list.certificates.find((c) => !c.expired)?.id ?? ''));
    } catch (err) {
      setError(err);
    }
  }, [origin]);
  useEffect(() => { void detect(); }, [detect]);

  const sign = async () => {
    const certificate = certificates.find((c) => c.id === chosen);
    if (!origin || !certificate) return;
    setError(null);
    setStep('pregatire');
    try {
      const prepared = await api<PrepareReply>('/signing/prepare', { method: 'POST', body: { taskId, documentId, certificatePem: certificate.certPem } });
      const request = await agentRequestSignature(origin, { certificateId: certificate.id, digestHex: prepared.digestHex, label: prepared.label });
      setConfirmUrl(request.confirmUrl);
      setStep('confirmare');
      // Starea vine doar de la agent; pagina de confirmare este pe originea lui.
      for (;;) {
        await new Promise((resolve) => { setTimeout(resolve, 1500); });
        if (cancelled.current) return;
        const state = await agentSignatureState(origin, request.requestId);
        if (state.status === 'asteapta') continue;
        if (state.status !== 'semnat' || !state.cms) throw new Error(state.message ?? 'Semnătura nu s-a făcut.');
        setStep('finalizare');
        const result = await api<CertificateSignResult>(`/signing/sessions/${prepared.sessionId}/complete`, { method: 'POST', body: { cms: state.cms, comment } });
        if (!cancelled.current) onSigned(result);
        return;
      }
    } catch (err) {
      if (!cancelled.current) {
        setError(err);
        setStep('alegere');
        setConfirmUrl(null);
      }
    }
  };

  if (config.error) return <ErrorAlert error={config.error} retry={() => void config.reload()} />;
  if (!origin || status === null) return <Loading label="Se caută agentul local…" />;

  if (status === 'absent') {
    return (
      <Alert kind="info" title="Agentul local nu răspunde">
        <p>Semnătura cu certificat folosește un program de pe calculatorul dumneavoastră, care ține legătura cu tokenul. Semnătura internă rămâne disponibilă.</p>
        <ol>
          <li>Instalați agentul din <code>apps/agent</code> (vezi instrucțiunile lui) și porniți-l cu <code>seadoc-agent start</code>.</li>
          <li>Permiteți această adresă: <code>seadoc-agent origin add {window.location.origin}</code>.</li>
          <li>Când browserul cere acces la rețeaua locală, permiteți-l pentru acest site.</li>
        </ol>
        {!window.isSecureContext && <p><strong>Această pagină nu este servită prin HTTPS.</strong> Chrome refuză automat accesul la agent din pagini HTTP. SeaDoc trebuie instalat cu HTTPS.</p>}
        <button type="button" className="btn btn-sm" onClick={() => void detect()}>Caută din nou</button>
      </Alert>
    );
  }

  if (status === 'neasociat') {
    return (
      <form onSubmit={(e) => { e.preventDefault(); storeToken(pairing.trim()); setPairing(''); void detect(); }}>
        <Alert kind="info" title="Agentul trebuie asociat cu acest browser">
          <p>Rulați <code>seadoc-agent pair</code> pe acest calculator și copiați aici tokenul afișat.</p>
        </Alert>
        <Field label="Token de asociere" required>
          <input type="password" value={pairing} onChange={(e) => setPairing(e.target.value)} autoComplete="off" required />
        </Field>
        <button type="submit" className="btn btn-sm">Asociază</button>
      </form>
    );
  }

  const selected = certificates.find((c) => c.id === chosen);
  const working = step !== 'alegere';
  return (
    <div>
      <ErrorAlert error={error} />
      {problems.map((p) => <Alert key={p} kind="warning">{p}</Alert>)}
      {certificates.length === 0 && (
        <Alert kind="warning" title="Agentul nu are niciun certificat">
          Adăugați unul cu <code>seadoc-agent import-p12</code> sau configurați tokenul cu <code>seadoc-agent pkcs11</code>.
          <button type="button" className="btn btn-sm" onClick={() => void detect()}>Caută din nou</button>
        </Alert>
      )}
      {certificates.length > 0 && (
        <Field label="Certificat" required>
          <select value={chosen} onChange={(e) => setChosen(e.target.value)} disabled={working}>
            {certificates.map((c) => (
              <option key={c.id} value={c.id} disabled={c.expired}>
                {c.subject}{c.testCertificate ? ' (certificat de test)' : ''}{c.expired ? ' (expirat)' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      {selected && (
        <p className="hint">
          Emitent: {selected.issuer}. Valabil până la {fmtDate(selected.validTo)}.
        </p>
      )}
      {selected?.testCertificate && (
        <Alert kind="warning" title="Certificat de test">
          Acesta este un certificat de test. Semnătura se poate verifica tehnic, dar nu are valoare juridică.
        </Alert>
      )}
      <p className="hint">
        Se adaugă o semnătură în PDF și rezultă o versiune nouă a documentului, cu același conținut. Aplicația nu stabilește dacă certificatul este calificat eIDAS și nu verifică revocarea lui.
      </p>
      {step === 'pregatire' && <Loading label="Se pregătește documentul…" />}
      {step === 'finalizare' && <Loading label="Se verifică semnătura și se salvează documentul…" />}
      {step === 'confirmare' && confirmUrl && (
        <Alert kind="info" title="Confirmați semnătura în agent">
          <p>Deschideți pagina agentului, verificați datele și introduceți PIN-ul acolo. PIN-ul nu ajunge la această aplicație.</p>
          <a className="btn btn-primary" href={confirmUrl} target="_blank" rel="noopener noreferrer">Deschide confirmarea în agent</a>
          <Loading label="Se așteaptă confirmarea…" />
        </Alert>
      )}
      <div className="preview-actions">
        <button type="button" className="btn btn-success" onClick={() => void sign()} disabled={working || !selected || selected.expired}>
          Semnează cu certificatul
        </button>
        {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={step === 'finalizare'}>Renunță</button>}
      </div>
    </div>
  );
}
