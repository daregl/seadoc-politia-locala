import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { Alert, ErrorAlert, Field, Loading } from '../components/Ui';
import { useAsync, usePageTitle } from '../hooks';
import type { AuthResponse, MfaEnrolment } from '../types';

export default function LoginPage() {
  const { status, notice } = useAuth();
  const location = useLocation();
  usePageTitle('Autentificare');

  if (status === 'ok') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/autentificare' ? from : '/panou'} replace />;
  }

  return (
    <div className="auth-page">
      <aside className="auth-brand">
        <div>
          <p className="auth-logo">SeaDoc</p>
          <p className="auth-lead">Management electronic al documentelor</p>
          <ul className="auth-features">
            <li>Registratură cu numerotare automată</li>
            <li>Fluxuri de avizare și aprobare</li>
            <li>Arhivă cu termene de păstrare</li>
            <li>Jurnal de audit protejat la modificare</li>
          </ul>
        </div>
        <p className="auth-vendor">Seamore Systems</p>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          {status === 'loading' && <Loading label="Se verifică sesiunea…" />}
          {status === 'unavailable' && <Unavailable />}
          {status === 'anon' && <PasswordStep notice={notice} />}
          {status === 'mfa' && <TotpStep />}
          {status === 'mfa_enrol' && <EnrolStep />}
          {status === 'change_password' && <ChangePasswordStep />}
        </div>
      </main>
    </div>
  );
}

function Unavailable() {
  const { refresh } = useAuth();
  return (
    <>
      <h1>Serviciu indisponibil</h1>
      <Alert kind="error">Serverul SeaDoc nu poate fi contactat momentan.</Alert>
      <button type="button" className="btn btn-primary btn-block" onClick={() => void refresh()}>Încearcă din nou</button>
    </>
  );
}

const SSO_ERRORS: Record<string, string> = {
  eroare: 'Autentificarea unică nu a reușit. Încercați din nou.',
  refuzat: 'Furnizorul de autentificare a refuzat cererea.',
  necunoscut: 'Contul nu poate fi folosit pentru autentificare unică. Contactați administratorul.',
  blocat: 'Cont blocat temporar după încercări eșuate. Încercați mai târziu.',
  indisponibil: 'Furnizorul de autentificare nu este disponibil momentan.',
};

/** Butonul apare doar dacă serverul are OIDC configurat. */
function SsoButton() {
  const location = useLocation();
  const sso = useAsync(() => api<{ oidc: boolean; label: string | null }>('/auth/sso', { silentAuth: true }), []);
  if (!sso.data?.oidc) return null;
  const from = (location.state as { from?: string } | null)?.from;
  const href = `/api/auth/oidc/start${from ? `?returnTo=${encodeURIComponent(from)}` : ''}`;
  return <a className="btn btn-block" href={href}>{sso.data.label}</a>;
}

function PasswordStep({ notice }: { notice: string | null }) {
  const { applyResponse } = useAuth();
  const ssoError = SSO_ERRORS[new URLSearchParams(useLocation().search).get('sso') ?? ''];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      applyResponse(await api<AuthResponse>('/auth/login', {
        method: 'POST', body: { username, password }, credentialCheck: true, silentAuth: true,
      }));
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <h1>Autentificare</h1>
      <p className="auth-intro">Introduceți datele contului de serviciu.</p>
      {notice && !error && <Alert kind="warning">{notice}</Alert>}
      {ssoError && !error && <Alert kind="error">{ssoError}</Alert>}
      <ErrorAlert error={error} />
      <Field label="Utilizator">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
        />
      </Field>
      <Field label="Parolă">
        <span className="input-with-action">
          <input
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <button type="button" className="btn btn-ghost" aria-pressed={show} onClick={() => setShow(!show)}>
            {show ? 'Ascunde' : 'Afișează'}
          </button>
        </span>
      </Field>
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Se verifică…' : 'Continuă'}
      </button>
      <SsoButton />
    </form>
  );
}

function CodeForm({ submitLabel, children }: { submitLabel: string; children?: ReactNode }) {
  const { applyResponse } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastTried = useRef('');

  const verify = async (value: string) => {
    if (busy) return;
    lastTried.current = value;
    setBusy(true);
    setError(null);
    try {
      applyResponse(await api<AuthResponse>('/auth/mfa/verify', {
        method: 'POST', body: { code: value }, credentialCheck: true,
      }));
    } catch (err) {
      setError(err);
      setCode('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (code.length === 6) void verify(code); }}>
      {children}
      <ErrorAlert error={error} />
      <Field label="Cod de verificare" hint="Codul din aplicația de autentificare, 6 cifre. Se schimbă la fiecare 30 de secunde.">
        <input
          ref={inputRef}
          className="code-input"
          value={code}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, '').slice(0, 6);
            setCode(next);
            if (next.length === 6 && next !== lastTried.current) void verify(next);
          }}
          inputMode="numeric"
          pattern="[0-9]{6}"
          autoComplete="one-time-code"
          required
          autoFocus
        />
      </Field>
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>
        {busy ? 'Se verifică…' : submitLabel}
      </button>
      <CancelLogin />
    </form>
  );
}

function CancelLogin() {
  const { logout } = useAuth();
  return (
    <button type="button" className="btn btn-link btn-block" onClick={() => void logout()}>
      Renunță și revino la autentificare
    </button>
  );
}

function TotpStep() {
  return (
    <CodeForm submitLabel="Verifică și intră">
      <p className="auth-step">Verificare în doi pași</p>
      <h1>Introduceți codul</h1>
      <p className="auth-intro">Deschideți aplicația de autentificare de pe telefon și introduceți codul afișat pentru SeaDoc.</p>
    </CodeForm>
  );
}

function EnrolStep() {
  const [data, setData] = useState<MfaEnrolment | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [qrFailed, setQrFailed] = useState(false);
  // Fiecare apel generează alt secret, deci cererea pornește o singură dată pe montare.
  const started = useRef(false);

  const start = async () => {
    setError(null);
    try {
      setData(await api<MfaEnrolment>('/auth/mfa/enrol', { method: 'POST' }));
    } catch (err) {
      setError(err);
    }
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, []);

  if (error) return (
    <>
      <h1>Configurare verificare în doi pași</h1>
      <ErrorAlert error={error} retry={() => void start()} />
      <CancelLogin />
    </>
  );
  if (!data) return <Loading label="Se pregătește configurarea…" />;
  const grouped = data.secret.match(/.{1,4}/g)?.join(' ') ?? data.secret;
  return (
    <CodeForm submitLabel="Activează și intră">
      <p className="auth-step">Prima autentificare</p>
      <h1>Configurați verificarea în doi pași</h1>
      <ol className="auth-steps">
        <li>Instalați o aplicație de autentificare pe telefon (de exemplu Google Authenticator sau Microsoft Authenticator).</li>
        <li>Scanați codul QR de mai jos sau introduceți manual cheia.</li>
        <li>Scrieți codul de 6 cifre afișat de aplicație.</li>
      </ol>
      <div className="enrol-qr">
        {qrFailed
          ? <Alert kind="warning">Codul QR nu a putut fi afișat. Folosiți cheia de mai jos.</Alert>
          : <img src={data.qr} width={196} height={196} alt="Cod QR pentru aplicația de autentificare" onError={() => setQrFailed(true)} />}
        <div className="enrol-secret">
          <span className="field-label">Cheie pentru introducere manuală</span>
          <code>{grouped}</code>
        </div>
      </div>
    </CodeForm>
  );
}

function ChangePasswordStep() {
  const { applyResponse, user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) { setError('Cele două parole noi nu coincid.'); return; }
    setBusy(true);
    setError(null);
    try {
      applyResponse(await api<AuthResponse>('/auth/password', {
        method: 'POST', body: { current, next }, credentialCheck: true,
      }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <p className="auth-step">Schimbare obligatorie</p>
      <h1>Alegeți o parolă nouă</h1>
      <p className="auth-intro">Parola contului {user ? <strong>{user.username}</strong> : null} trebuie schimbată înainte de a continua.</p>
      {error && <Alert kind="error">{error}</Alert>}
      <input type="text" className="visually-hidden" tabIndex={-1} aria-hidden="true" autoComplete="username" value={user?.username ?? ''} readOnly />
      <Field label="Parola curentă">
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus />
      </Field>
      <Field label="Parola nouă" hint="Trebuie să respecte politica instituției: lungime minimă, litere mici și mari, cifre și un caracter special.">
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
      </Field>
      <Field label="Repetați parola nouă">
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
      </Field>
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Se salvează…' : 'Schimbă parola'}
      </button>
      <CancelLogin />
    </form>
  );
}
