import { useState, type FormEvent } from 'react';
import { api } from '../../api';
import { Alert, Badge, ErrorAlert, Field, Loading, Section } from '../../components/Ui';
import { useAsync, usePageTitle } from '../../hooks';
import type { Meta } from '../../types';
import { CASE_KINDS, ROLE_LABELS } from '../cases/caseTypes';

interface Template {
  id: number; code: string; name: string; caseKind: string | null; caseRole: string; title: string; body: string;
  documentTypeId: number | null; registerId: number | null; active: boolean; fields: string[];
}
interface Institution { name: string; address: string; phone: string; email: string; leader: string; leaderTitle: string }

export default function TemplatesAdmin() {
  usePageTitle('Șabloane');
  const list = useAsync(() => api<Template[]>('/templates'), []);
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [selected, setSelected] = useState<number | 'nou' | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const current = selected === 'nou' ? null : list.data?.find((t) => t.id === selected) ?? null;

  return (
    <div className="stack">
      <InstitutionForm />
      <Section title="Șabloane de documente" count={list.data?.length}
        actions={<button type="button" className="btn btn-sm" onClick={() => setSelected('nou')}>Șablon nou</button>}>
        <p className="hint">Câmpurile se scriu între acolade duble, de exemplu {'{{petent}}'}. La generare se completează din lucrare și pot fi corectate înainte de înregistrare.</p>
        {saved && <Alert kind="success">{saved}</Alert>}
        <ErrorAlert error={list.error} />
        {list.loading && !list.data && <Loading />}
        <ul className="row-list">
          {list.data?.map((t) => (
            <li key={t.id}>
              <button type="button" className="row-link" onClick={() => setSelected(t.id)}>
                <span className="row-title">{t.name} {!t.active && <Badge tone="neutral">Inactiv</Badge>}</span>
                <span className="row-sub">{t.caseKind ? CASE_KINDS[t.caseKind as keyof typeof CASE_KINDS]?.label : 'Orice lucrare'} · {ROLE_LABELS[t.caseRole] ?? t.caseRole} · {t.code}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
      {selected != null && (
        <TemplateForm key={String(selected)} template={current} meta={meta.data}
          onDone={async (msg) => { setSelected(null); setSaved(msg); await list.reload(); }} onCancel={() => setSelected(null)} />
      )}
    </div>
  );
}

function InstitutionForm() {
  const data = useAsync(() => api<Institution>('/templates/institution'), []);
  const [v, setV] = useState<Institution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  const value = v ?? data.data;
  if (!value) return data.loading ? <Loading /> : <ErrorAlert error={data.error} />;
  const set = (k: keyof Institution, x: string) => { setV({ ...value, [k]: x }); setOk(false); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await api('/templates/institution', { method: 'PUT', body: value }); setOk(true); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Section title="Antetul instituției">
      <form onSubmit={submit}>
        <ErrorAlert error={error} />
        {ok && <Alert kind="success">Datele instituției au fost salvate.</Alert>}
        <div className="form-grid">
          <Field label="Denumirea" required><input value={value.name} onChange={(e) => set('name', e.target.value)} required /></Field>
          <Field label="Adresa"><input value={value.address} onChange={(e) => set('address', e.target.value)} /></Field>
          <Field label="Telefon"><input value={value.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="Email"><input value={value.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Conducătorul"><input value={value.leader} onChange={(e) => set('leader', e.target.value)} /></Field>
          <Field label="Funcția conducătorului"><input value={value.leaderTitle} onChange={(e) => set('leaderTitle', e.target.value)} /></Field>
        </div>
        <button type="submit" className="btn" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează antetul'}</button>
      </form>
    </Section>
  );
}

function TemplateForm({ template, meta, onDone, onCancel }: { template: Template | null; meta: Meta | null | undefined; onDone: (msg: string) => void; onCancel: () => void }) {
  const [v, setV] = useState({
    code: template?.code ?? '', name: template?.name ?? '', caseKind: template?.caseKind ?? '', caseRole: template?.caseRole ?? 'adresa',
    title: template?.title ?? '', body: template?.body ?? '', documentTypeId: template?.documentTypeId?.toString() ?? '', registerId: template?.registerId?.toString() ?? '',
    active: template?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof v, x: string | boolean) => setV({ ...v, [k]: x });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { ...v, caseKind: v.caseKind || null, documentTypeId: v.documentTypeId || null, registerId: v.registerId || null };
    try {
      if (template) await api(`/templates/${template.id}`, { method: 'PUT', body });
      else await api('/templates', { method: 'POST', body });
      onDone(template ? 'Șablonul a fost salvat.' : 'Șablonul a fost creat.');
    } catch (err) { setError(err); setBusy(false); }
  };
  return (
    <Section title={template ? `Șablon: ${template.name}` : 'Șablon nou'}>
      <form className="stack" onSubmit={submit}>
        <ErrorAlert error={error} />
        <div className="form-grid">
          {!template && <Field label="Cod" required hint="Litere mici, cifre și _"><input value={v.code} onChange={(e) => set('code', e.target.value)} required /></Field>}
          <Field label="Denumire" required><input value={v.name} onChange={(e) => set('name', e.target.value)} required /></Field>
          <Field label="Tip de lucrare">
            <select value={v.caseKind} onChange={(e) => set('caseKind', e.target.value)}>
              <option value="">Oricare</option>
              {Object.entries(CASE_KINDS).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}
            </select>
          </Field>
          <Field label="Rol în dosar"><select value={v.caseRole} onChange={(e) => set('caseRole', e.target.value)}>{Object.entries(ROLE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Tip de document implicit">
            <select value={v.documentTypeId} onChange={(e) => set('documentTypeId', e.target.value)}>
              <option value="">Se alege la generare</option>
              {meta?.documentTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Registru implicit">
            <select value={v.registerId} onChange={(e) => set('registerId', e.target.value)}>
              <option value="">Se alege la generare</option>
              {meta?.registers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Titlul documentului" required><input value={v.title} onChange={(e) => set('title', e.target.value)} required /></Field>
        <Field label="Textul" required hint={template ? `Câmpuri folosite: ${template.fields.join(', ')}` : undefined}>
          <textarea rows={18} value={v.body} onChange={(e) => set('body', e.target.value)} required style={{ fontFamily: 'var(--mono)', fontSize: 13 }} />
        </Field>
        <label className="check"><input type="checkbox" checked={v.active} onChange={(e) => set('active', e.target.checked)} /><span>Activ</span></label>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel}>Renunță</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : 'Salvează șablonul'}</button>
        </div>
      </form>
    </Section>
  );
}
