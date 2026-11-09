import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api';
import { ErrorAlert, Field, Loading, PageHeader, Section } from '../../components/Ui';
import { fmtDate } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';
import { CHANNELS } from './caseTypes';

interface Report {
  year: number; semester: number; from: string; to: string; institution: string;
  totals: { total: number; open: number; inTerm: number; overTerm: number; extended: number; anonymous: number; multipleObjects: number; communicated: number };
  byOutcome: { outcome: string; label: string; count: number }[];
  byDepartment: { department: string; total: number; open: number; overTerm: number }[];
  byChannel: { channel: string; count: number }[];
  byMonth: { month: string; count: number }[];
}

export default function PetitionReportPage() {
  usePageTitle('Situația semestrială a petițiilor');
  const now = new Date();
  const [params, setParams] = useSearchParams();
  const year = Number(params.get('an')) || now.getFullYear();
  const semester = Number(params.get('semestru')) || (now.getMonth() < 6 ? 1 : 2);
  const r = useAsync(() => api<Report>(`/cases/reports/petitions${qs({ year, semester })}`), [year, semester]);
  const t = r.data?.totals;

  return (
    <>
      <Link to="/lucrari?kind=petitie" className="back-link no-print">← Petiții</Link>
      <PageHeader
        title={`Situația petițiilor, semestrul ${semester} ${year}`}
        subtitle={r.data ? `${r.data.institution} · ${fmtDate(r.data.from)} – ${fmtDate(r.data.to)} · art. 13 din OG 27/2002` : undefined}
        actions={(
          <span className="case-actions no-print">
            <a className="btn" href={`/api/cases/reports/petitions/csv${qs({ year, semester })}`}>Descarcă CSV</a>
            <button type="button" className="btn btn-primary" onClick={() => window.print()}>Tipărește</button>
          </span>
        )}
      />
      <div className="filter-box no-print">
        <div className="form-grid form-grid-dense">
          <Field label="Anul"><input type="number" value={year} min={2000} max={2100} onChange={(e) => setParams({ an: e.target.value, semestru: String(semester) })} /></Field>
          <Field label="Semestrul">
            <select value={semester} onChange={(e) => setParams({ an: String(year), semestru: e.target.value })}>
              <option value={1}>I (ianuarie – iunie)</option>
              <option value={2}>II (iulie – decembrie)</option>
            </select>
          </Field>
        </div>
      </div>
      <ErrorAlert error={r.error} retry={() => void r.reload()} />
      {r.loading && !r.data && <Loading />}
      {r.data && t && (
        <div className="stack">
          <div className="stat-row">
            <Stat label="Petiții înregistrate" value={t.total} />
            <Stat label="Soluționate în termen" value={t.inTerm} />
            <Stat label="Cu termen depășit" value={t.overTerm} alert={t.overTerm > 0} />
            <Stat label="În curs" value={t.open} />
            <Stat label="Termen prelungit" value={t.extended} />
            <Stat label="Răspuns comunicat" value={t.communicated} />
            <Stat label="Anonime" value={t.anonymous} />
            <Stat label="Cu obiect multiplu" value={t.multipleObjects} />
          </div>
          <Section title="După soluție">
            <table className="table"><thead><tr><th scope="col">Soluție</th><th scope="col">Număr</th></tr></thead>
              <tbody>{r.data.byOutcome.map((o) => <tr key={o.outcome}><td>{o.label}</td><td>{o.count}</td></tr>)}
                {t.open > 0 && <tr><td>În curs de soluționare</td><td>{t.open}</td></tr>}</tbody>
            </table>
          </Section>
          <Section title="După compartiment">
            <table className="table"><thead><tr><th scope="col">Compartiment</th><th scope="col">Total</th><th scope="col">În curs</th><th scope="col">Termen depășit</th></tr></thead>
              <tbody>{r.data.byDepartment.map((d) => <tr key={d.department}><td>{d.department}</td><td>{d.total}</td><td>{d.open}</td><td>{d.overTerm}</td></tr>)}</tbody>
            </table>
          </Section>
          <Section title="După modul de primire">
            <table className="table"><thead><tr><th scope="col">Mod</th><th scope="col">Număr</th></tr></thead>
              <tbody>{r.data.byChannel.map((ch) => <tr key={ch.channel}><td>{CHANNELS[ch.channel] ?? ch.channel}</td><td>{ch.count}</td></tr>)}</tbody>
            </table>
          </Section>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return <div className={alert ? 'stat-cell stat-cell-alert' : 'stat-cell'}><b>{value}</b><span>{label}</span></div>;
}
