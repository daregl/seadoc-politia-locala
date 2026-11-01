import { useState } from 'react';
import { api } from '../../api';
import { Alert, Badge, DefinitionList, Empty, ErrorAlert, Loading, Section, TableScroll } from '../../components/Ui';
import { fmtDateTime } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';

interface ReportData {
  conform: boolean; reasons: string[]; sourceFiles: number; imported: number; skipped: number; excluded: number; failed: number; collisions: number; refused: number; pending: number;
  verified: number; matched: number; mismatched: number; ocr: Record<string, number>; problems: { path: string; status: string; detail: string }[]; problemsTotal: number;
}
interface Run {
  id: number; sourceName: string; sourceRoot: string; mode: 'simulare' | 'import'; status: 'in_curs' | 'finalizat' | 'intrerupt'; operator: string | null;
  startedAt: string; finishedAt: string | null; counts: Record<string, number>; report: ReportData | null; reportOk: boolean | null; reportAt: string | null; hasCsv: boolean; hasPdf: boolean;
}

const STATUS_LABEL: Record<Run['status'], string> = { in_curs: 'În curs', finalizat: 'Finalizată', intrerupt: 'Întreruptă' };

function RunDetail({ run }: { run: Run }) {
  const r = run.report;
  return (
    <>
      {!r && (run.mode === 'import'
        ? <Alert kind="warning">Rularea nu are încă raport de integritate. Rulați: <code>npm run migrate:archive -w apps/api -- report {run.id}</code></Alert>
        : <Alert kind="info">Simulare: nu s-a scris nimic și nu există fișiere de verificat.</Alert>)}
      {!r && (
        <DefinitionList items={Object.entries(run.counts).map(([key, value]) => ({ label: key, value }))} />
      )}
      {r && (
        <>
          {r.conform
            ? <Alert kind="success" title="CONFORM">Toate fișierele au hash identic cu inventarul.</Alert>
            : <Alert kind="error" title="NECONFORM"><ul>{r.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></Alert>}
          <DefinitionList items={[
            { label: 'Fișiere în sursă', value: r.sourceFiles },
            { label: 'Importate', value: r.imported },
            { label: 'Importate anterior (sărite)', value: r.skipped },
            { label: 'Excluse prin mapare', value: r.excluded },
            { label: 'Eșuate', value: r.failed },
            { label: 'Coliziuni de număr', value: r.collisions },
            { label: 'Refuzate din inventar', value: r.refused },
            { label: 'Neprocesate', value: r.pending },
            { label: 'Hash-uri recalculate', value: `${r.verified}, din care ${r.matched} identice și ${r.mismatched} diferite` },
            { label: 'Stare OCR', value: Object.entries(r.ocr).map(([k, v]) => `${k}: ${v}`).join(', ') || '–' },
            { label: 'Raport generat', value: fmtDateTime(run.reportAt) },
          ]} />
          <div className="form-actions">
            {run.hasPdf && <a className="btn" href={`/api/admin/migration/runs/${run.id}/report/pdf`}>Descarcă PDF pentru semnare</a>}
            {run.hasCsv && <a className="btn" href={`/api/admin/migration/runs/${run.id}/report/csv`}>Descarcă CSV</a>}
          </div>
          {r.problems.length > 0 && (
            <>
              <h3>Erori ({r.problemsTotal})</h3>
              <ul className="row-list">
                {r.problems.map((p, i) => <li key={i} className="row-static"><span className="row-sub">{p.status}</span><span className="cell-wrap">{p.path}</span>{p.detail && <span className="row-sub">{p.detail}</span>}</li>)}
              </ul>
              {r.problemsTotal > r.problems.length && <p className="hint">Se afișează primele {r.problems.length}. Lista completă este în CSV.</p>}
            </>
          )}
        </>
      )}
    </>
  );
}

export default function AdminMigrationPage() {
  usePageTitle('Migrare');
  const runs = useAsync(() => api<Run[]>('/admin/migration/runs'), []);
  const [selected, setSelected] = useState<number | null>(null);

  if (runs.loading && !runs.data) return <Loading />;
  if (runs.error) return <ErrorAlert error={runs.error} retry={() => void runs.reload()} />;
  const list = runs.data ?? [];
  const current = list.find((r) => r.id === selected);
  return (
    <>
      <Section title="Rulări de migrare">
        <p className="hint">Ecranul doar afișează. Inventarul, maparea, importul și raportul se rulează din linia de comandă, cu <code>npm run migrate:archive</code>.</p>
        {list.length === 0 && <Empty title="Nu există rulări." />}
        {list.length > 0 && (
          <TableScroll label="Rulări de migrare">
            <table className="table table-cards">
              <caption className="visually-hidden">Rulări de migrare</caption>
              <thead><tr><th scope="col">Rulare</th><th scope="col">Sursă</th><th scope="col">Mod</th><th scope="col">Stare</th><th scope="col">Pornită</th><th scope="col">Operator</th><th scope="col">Raport</th><th scope="col"><span className="visually-hidden">Acțiuni</span></th></tr></thead>
              <tbody>
                {list.map((run) => (
                  <tr key={run.id}>
                    <td data-label="Rulare">{run.id}</td>
                    <td data-label="Sursă">{run.sourceName}</td>
                    <td data-label="Mod">{run.mode === 'import' ? 'Import' : 'Simulare'}</td>
                    <td data-label="Stare">{STATUS_LABEL[run.status]}</td>
                    <td data-label="Pornită">{fmtDateTime(run.startedAt)}</td>
                    <td data-label="Operator">{run.operator ?? '–'}</td>
                    <td data-label="Raport">
                      {run.reportOk === null ? '–' : <Badge tone={run.reportOk ? 'success' : 'danger'}>{run.reportOk ? 'Conform' : 'Neconform'}</Badge>}
                    </td>
                    <td className="cell-actions"><button type="button" className="btn btn-sm" aria-expanded={selected === run.id} onClick={() => setSelected(selected === run.id ? null : run.id)}>Detalii</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>
      {current && <Section title={`Rularea ${current.id}: ${current.sourceName}`}><RunDetail run={current} /></Section>}
    </>
  );
}
