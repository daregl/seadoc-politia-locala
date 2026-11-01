import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { ERP_KIND_LABEL, type ErpKind, type ErpRecord } from '../components/ErpPicker';
import { Alert, Badge, Empty, ErrorAlert, Field, Loading, PageHeader, Pagination, Section, TableScroll } from '../components/Ui';
import { fmtDate, plural } from '../format';
import { useAsync, usePageTitle } from '../hooks';
import type { Paged } from '../types';

const LIMIT = 25;

interface FieldDef { key: string; label: string; required?: boolean }
interface Preview { columns: string[]; sample: string[][]; totalRows: number; malformed: number; fields: Record<ErpKind, FieldDef[]> }
interface ImportResult {
  kind: ErpKind; dryRun: boolean; totalRows: number; created: number; updated: number; unchanged: number; rejected: number;
  errors: { line: number; reason: string }[]; errorsTruncated: boolean; unknownPartners: number;
}

/** Potrivire după denumirea coloanei; administratorul o vede și o poate schimba înainte de import. */
const GUESSES: Record<string, RegExp> = {
  externalId: /^(cod|id|cod.?extern|external.?id|cod.?(partener|client|factura|comanda))$/i,
  name: /^(denumire|nume|partener|client|furnizor)$/i,
  number: /^(num[aă]r|nr\.?|serie.*num[aă]r|num[aă]r.*(factur|comand).*)$/i,
  taxId: /^(cui|cif|cod.?fiscal)$/i,
  partnerExternalId: /(cod.?partener|cod.?client|partener|client|furnizor)/i,
  issueDate: /^(data|data.?(emiterii|facturii|comenzii)|emitere)$/i,
  dueDate: /^(scaden[tț][aă]|termen|data.?scaden[tț]ei)$/i,
  amount: /^(valoare|total|suma|sum[aă])$/i,
  currency: /^(moned[aă]|valut[aă]|currency)$/i,
  status: /^(stare|status)$/i,
};
function guessMapping(fields: FieldDef[], columns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const hit = columns.find((c) => GUESSES[field.key]?.test(c.trim()) && !Object.values(out).includes(c));
    if (hit) out[field.key] = hit;
  }
  return out;
}

function ImportPanel({ onImported }: { onImported: () => void }) {
  const [kind, setKind] = useState<ErpKind>('partener');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setPreview(null);
    setResult(null);
    setError(null);
    if (!file) return;
    let active = true;
    (async () => {
      const form = new FormData();
      form.set('file', file);
      setBusy(true);
      try {
        const res = await api<Preview>('/erp/import/preview', { method: 'POST', form });
        if (active) setPreview(res);
      } catch (err) {
        if (active) setError(err);
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => { active = false; };
  }, [file]);

  const fields = useMemo(() => preview?.fields[kind] ?? [], [preview, kind]);
  useEffect(() => { if (preview) setMapping(guessMapping(fields, preview.columns)); }, [preview, fields]);
  const missing = fields.filter((f) => f.required && !mapping[f.key]);

  const run = async (dryRun: boolean) => {
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    form.set('kind', kind);
    form.set('mapping', JSON.stringify(mapping));
    form.set('dryRun', String(dryRun));
    setBusy(true);
    setError(null);
    try {
      const res = await api<ImportResult>('/erp/import', { method: 'POST', form });
      setResult(res);
      if (!dryRun) onImported();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Import din fișier CSV">
      <div className="form-grid">
        <Field label="Ce conține fișierul" required>
          <select value={kind} onChange={(e) => { setKind(e.target.value as ErpKind); setResult(null); }}>
            {Object.entries(ERP_KIND_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </Field>
        <Field label="Fișierul exportat" required hint="Un rând de antet, separator punct și virgulă, virgulă sau tab. Din Excel: „Salvare ca”, format CSV.">
          <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
      </div>
      <ErrorAlert error={error} />
      {preview && (
        <>
          <h3>Corespondența coloanelor</h3>
          <p>{plural(preview.totalRows, 'rând citit', 'rânduri citite')}{preview.malformed ? `, ${plural(preview.malformed, 'rând deteriorat', 'rânduri deteriorate')}` : ''}.</p>
          <div className="form-grid">
            {fields.map((field) => (
              <Field key={field.key} label={field.label} required={field.required}>
                <select value={mapping[field.key] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [field.key]: e.target.value }))}>
                  <option value="">Nu se importă</option>
                  {preview.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
            ))}
          </div>
          {preview.sample.length > 0 && (
            <TableScroll label="Primele rânduri din fișier">
              <table className="table">
                <caption className="visually-hidden">Primele rânduri din fișier</caption>
                <thead><tr>{preview.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                <tbody>{preview.sample.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </TableScroll>
          )}
          {missing.length > 0 && <Alert kind="warning">Alegeți coloana pentru: {missing.map((f) => f.label).join(', ')}.</Alert>}
          <div className="form-actions">
            <button type="button" className="btn" disabled={busy || missing.length > 0} onClick={() => void run(true)}>Simulează</button>
            <button type="button" className="btn btn-primary" disabled={busy || missing.length > 0} onClick={() => void run(false)}>{busy ? 'Se lucrează…' : 'Importă'}</button>
          </div>
        </>
      )}
      {result && (
        <div aria-live="polite">
          <Alert kind={result.rejected ? 'warning' : 'success'} title={result.dryRun ? 'Rezultatul simulării; nu s-a salvat nimic' : 'Import încheiat'}>
            Noi: {result.created} · actualizate: {result.updated} · neschimbate: {result.unchanged} · respinse: {result.rejected}
            {result.unknownPartners > 0 && ` · parteneri încă neimportați: ${result.unknownPartners}`}
          </Alert>
          {result.errors.length > 0 && (
            <ul className="row-list">
              {result.errors.map((e, i) => <li key={i} className="row-static"><span className="row-sub">Linia {e.line}</span>{e.reason}</li>)}
              {result.errorsTruncated && <li className="row-static">Se afișează doar primele {result.errors.length} erori.</li>}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

export default function ErpPage() {
  usePageTitle('Date ERP (import)');
  const { can } = useAuth();
  const [kind, setKind] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const list = useAsync(() => api<Paged<ErpRecord>>(`/erp/records${qs({ q, kind, limit: LIMIT, offset })}`), [q, kind, offset]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setOffset(0);
    setQ(text.trim());
  };

  return (
    <>
      <PageHeader title="Date ERP (import)" subtitle="Parteneri, facturi și comenzi încărcate din fișiere exportate, pentru legarea cu documentele." />
      <Alert kind="info">Datele sunt la zi doar până la ultimul import. Nu există o conexiune directă cu sistemul ERP.</Alert>
      {can('users_admin') && <ImportPanel onImported={() => void list.reload()} />}
      <Section title="Înregistrări">
        <form className="form-grid" onSubmit={submit} role="search">
          <Field label="Caută">
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Denumire, număr, CUI sau cod extern" />
          </Field>
          <Field label="Tip">
            <select value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
              <option value="">Toate</option>
              {Object.entries(ERP_KIND_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </Field>
          <div className="form-actions"><button type="submit" className="btn">Caută</button></div>
        </form>
        <ErrorAlert error={list.error} retry={() => void list.reload()} />
        {list.loading && !list.data && <Loading />}
        {list.data?.items.length === 0 && <Empty title="Nu există înregistrări." />}
        {!!list.data?.items.length && (
          <TableScroll label="Date ERP importate">
            <table className="table table-cards">
              <caption className="visually-hidden">Date ERP importate</caption>
              <thead>
                <tr><th scope="col">Tip</th><th scope="col">Cod extern</th><th scope="col">Denumire sau număr</th><th scope="col">Partener</th><th scope="col">Data</th><th scope="col">Valoare</th></tr>
              </thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Tip"><Badge>{ERP_KIND_LABEL[r.kind]}</Badge></td>
                    <td data-label="Cod extern">{r.externalId}</td>
                    <td data-label="Denumire sau număr"><Link to={`/erp/${r.id}`}>{r.name ?? r.number}</Link></td>
                    <td data-label="Partener">{r.partnerId ? <Link to={`/erp/${r.partnerId}`}>{r.partnerName}</Link> : r.partnerExternalId ?? '–'}</td>
                    <td data-label="Data">{fmtDate(r.issueDate)}</td>
                    <td data-label="Valoare">{r.amount ? `${r.amount} ${r.currency ?? ''}` : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        {list.data && <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
      </Section>
    </>
  );
}
