import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api';
import { Empty, ErrorAlert, Field, Loading, PageHeader, Section, StatusBadge } from '../../components/Ui';
import { fmtDate, plural } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';
import type { DocStatus } from '../../types';
import { CaseStatus, kindLabel, type CaseRow } from './caseTypes';

interface History {
  location: string;
  cases: (CaseRow & { applicantAddress: string | null; offenderAddress: string | null })[];
  documents: { id: number; title: string; regLabel: string | null; regDate: string | null; status: DocStatus }[];
}

export default function AddressHistoryPage() {
  usePageTitle('Istoric pe adresă');
  const [params, setParams] = useSearchParams();
  const address = params.get('adresa') ?? '';
  const [text, setText] = useState(address);
  const data = useAsync(() => (address.length >= 3 ? api<History>(`/cases/history${qs({ location: address })}`) : Promise.resolve(null)), [address]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setParams(text.trim() ? { adresa: text.trim() } : {});
  };

  return (
    <>
      <PageHeader title="Istoric pe adresă" subtitle="Petițiile, controalele și procesele-verbale de la o adresă sau un obiectiv, plus documentele care o menționează." />
      <form className="filter-box" onSubmit={submit} role="search">
        <div className="inline-row-fields">
          <Field label="Adresa sau obiectivul" hint="Fără diacritice merge la fel; scrieți strada și numărul.">
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="de exemplu: Lăpușneanu 10" />
          </Field>
          <button type="submit" className="btn btn-primary">Caută</button>
        </div>
      </form>
      <ErrorAlert error={data.error} retry={() => void data.reload()} />
      {data.loading && <Loading />}
      {data.data && (
        <>
          <Section title="Lucrări" count={data.data.cases.length}>
            {data.data.cases.length === 0 ? <Empty title="Nicio lucrare la această adresă." /> : (
              <ul className="row-list">
                {data.data.cases.map((c) => (
                  <li key={c.id} className="row-static">
                    <span className="row-sub">{fmtDate(c.receivedOn)} · {kindLabel(c.kind)} · {c.location ?? c.offenderAddress ?? c.applicantAddress}</span>
                    <Link to={`/lucrari/${c.id}`}>{c.regLabel} · {c.subject}</Link>
                    <span><CaseStatus row={c} />{c.offenderName ? ` ${c.offenderName}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Documente care menționează adresa" count={data.data.documents.length}>
            {data.data.documents.length === 0 ? <Empty title="Niciun document." /> : (
              <ul className="row-list">
                {data.data.documents.map((d) => (
                  <li key={d.id} className="row-static">
                    <span className="row-sub">{fmtDate(d.regDate)}</span>
                    <Link to={`/documente/${d.id}`}>{d.regLabel ?? 'Fără număr'} · {d.title}</Link>
                    <StatusBadge status={d.status} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <p className="hint">{plural(data.data.cases.length, 'lucrare găsită', 'lucrări găsite')}; se afișează doar cele la care aveți acces.</p>
        </>
      )}
    </>
  );
}
