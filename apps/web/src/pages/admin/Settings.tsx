import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { Alert, ErrorAlert, Field, Loading, Section } from '../../components/Ui';
import { useAsync, usePageTitle } from '../../hooks';
import type { AdminSettings, PasswordPolicy } from '../../types';

export default function SettingsPage() {
  usePageTitle('Securitate');
  const settings = useAsync(() => api<AdminSettings>('/admin/settings'), []);
  return (
    <>
      <ErrorAlert error={settings.error} retry={() => void settings.reload()} />
      {settings.loading && !settings.data && <Loading />}
      {settings.data && (
        <>
          <PolicyForm policy={settings.data.passwordPolicy} />
          <NetworksForm networks={settings.data.internalNetworks} />
        </>
      )}
    </>
  );
}

function PolicyForm({ policy }: { policy: PasswordPolicy }) {
  const [form, setForm] = useState({
    minLength: String(policy.minLength),
    expiryDays: String(policy.expiryDays),
    maxFailedAttempts: String(policy.maxFailedAttempts),
    lockMinutes: String(policy.lockMinutes),
  });
  const [requireComplexity, setRequireComplexity] = useState(policy.requireComplexity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const set = (key: keyof typeof form, value: string) => { setForm((prev) => ({ ...prev, [key]: value })); setSaved(false); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('/admin/settings/password-policy', {
        method: 'PUT',
        body: {
          minLength: Number(form.minLength),
          requireComplexity,
          expiryDays: Number(form.expiryDays),
          maxFailedAttempts: Number(form.maxFailedAttempts),
          lockMinutes: Number(form.lockMinutes),
        },
      });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Politica de parole">
      <form onSubmit={submit}>
        <ErrorAlert error={error} />
        {saved && <Alert kind="success">Politica de parole a fost salvată.</Alert>}
        <div className="form-grid">
          <Field label="Lungime minimă" hint="Între 8 și 128 de caractere.">
            <input type="number" min={8} max={128} value={form.minLength} onChange={(e) => set('minLength', e.target.value)} required />
          </Field>
          <Field label="Expirare (zile)" hint="0 înseamnă că parola nu expiră.">
            <input type="number" min={0} max={3650} value={form.expiryDays} onChange={(e) => set('expiryDays', e.target.value)} required />
          </Field>
          <Field label="Încercări eșuate până la blocare">
            <input type="number" min={1} max={100} value={form.maxFailedAttempts} onChange={(e) => set('maxFailedAttempts', e.target.value)} required />
          </Field>
          <Field label="Durata blocării (minute)">
            <input type="number" min={1} max={10080} value={form.lockMinutes} onChange={(e) => set('lockMinutes', e.target.value)} required />
          </Field>
          <label className="check form-grid-full">
            <input type="checkbox" checked={requireComplexity} onChange={(e) => { setRequireComplexity(e.target.checked); setSaved(false); }} />
            <span>Cere litere mici, litere mari, cifre și un caracter special</span>
          </label>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează politica'}</button>
      </form>
    </Section>
  );
}

function NetworksForm({ networks }: { networks: string[] }) {
  const [text, setText] = useState(networks.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setText(networks.join('\n')); }, [networks]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api<{ networks: string[] }>('/admin/settings/internal-networks', {
        method: 'PUT',
        body: { networks: text.split(/\s+/).map((v) => v.trim()).filter(Boolean) },
      });
      setText(res.networks.join('\n'));
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Rețele interne">
      <form onSubmit={submit}>
        <ErrorAlert error={error} />
        {saved && <Alert kind="success">Lista de rețele a fost salvată.</Alert>}
        <Field label="Rețele, câte una pe linie (format CIDR)" hint="Autentificarea dintr-o adresă din afara acestor rețele cere verificarea în doi pași.">
          <textarea rows={6} className="input-mono" value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} spellCheck={false} />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează rețelele'}</button>
      </form>
    </Section>
  );
}
