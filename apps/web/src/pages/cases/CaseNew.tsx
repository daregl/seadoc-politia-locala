import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth, useUser } from '../../auth';
import { DocPicker, type PickedDoc } from '../../components/DocPicker';
import { Alert, ErrorAlert, Field, Loading, PageHeader, Section } from '../../components/Ui';
import { useAsync, usePageTitle } from '../../hooks';
import type { DocDetail, Meta } from '../../types';
import { CASE_KINDS, CHANNELS, COMMUNICATION_METHODS, todayIso, type CaseKind, type CaseRow } from './caseTypes';

export default function CaseNewPage() {
  usePageTitle('Lucrare nouă');
  const { can } = useAuth();
  const user = useUser();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const canRegister = can('register', 'cases_all');
  const allowed = (Object.keys(CASE_KINDS) as CaseKind[]).filter((k) => canRegister || k === 'contraventie' || k === 'control');
  const initialKind = (params.get('tip') as CaseKind) ?? allowed[0];
  const [kind, setKind] = useState<CaseKind>(allowed.includes(initialKind) ? initialKind : allowed[0]);
  const meta = useAsync(() => api<Meta>('/meta'), []);

  const [subject, setSubject] = useState('');
  const [applicantName, setApplicantName] = useState('');
  const [applicantAddress, setApplicantAddress] = useState('');
  const [applicantEmail, setApplicantEmail] = useState('');
  const [applicantPhone, setApplicantPhone] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [channel, setChannel] = useState('scris');
  const [location, setLocation] = useState('');
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [departmentId, setDepartmentId] = useState(user.departmentId ? String(user.departmentId) : '');
  const [assigneeId, setAssigneeId] = useState('');
  const [doc, setDoc] = useState<PickedDoc | null>(null);
  const [objects, setObjects] = useState<string[]>([]);
  const [team, setTeam] = useState(user.fullName);
  const [manualDueOn, setManualDueOn] = useState('');
  const [cv, setCv] = useState({
    pvSeries: '', pvNumber: '', offenderName: '', offenderIdCode: '', offenderAddress: '', fact: '', legalBasis: '',
    sanction: 'amenda', amount: '', minAmount: '', observedAt: '', communicatedOn: '', communicationMethod: 'inmanare',
  });
  const setCvField = (key: keyof typeof cv, value: string) => setCv({ ...cv, [key]: value });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Lucrarea deschisă din fișa unui document: documentul devine principal, iar datele lui se preiau.
  const fromDocument = Number(params.get('document')) || null;
  // Procesul-verbal întocmit la o acțiune de control: se leagă de control și preia locul.
  const parentId = Number(params.get('parinte')) || null;
  const parent = useAsync(() => (parentId ? api<CaseRow>(`/cases/${parentId}`) : Promise.resolve(null)), [parentId]);
  useEffect(() => {
    if (parent.data?.location) setLocation((v) => v || parent.data!.location!);
  }, [parent.data]);
  useEffect(() => {
    if (!fromDocument) return;
    api<DocDetail>(`/documents/${fromDocument}`).then((d) => {
      setDoc({ id: d.id, title: d.title, regLabel: d.regLabel });
      if (d.issuer) setApplicantName((v) => v || d.issuer!);
      setSubject((v) => v || d.summary || d.title);
      if (d.regDate) setReceivedOn(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date(d.regDate)));
    }).catch(setError);
  }, [fromDocument]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        kind, subject: subject.trim() || undefined, receivedOn, departmentId: departmentId || undefined, assigneeId: assigneeId || undefined,
        location: location.trim() || undefined, documentId: doc?.id, parentId: parentId ?? undefined,
      };
      if (kind === 'petitie' || kind === 'informatii_publice') {
        Object.assign(body, {
          applicantName: anonymous ? undefined : applicantName.trim(), applicantAddress: applicantAddress.trim(), applicantEmail: applicantEmail.trim(),
          applicantPhone: applicantPhone.trim(), anonymous, channel, objects: objects.map((o) => o.trim()).filter(Boolean),
        });
      }
      if (kind === 'control') Object.assign(body, { manualDueOn: manualDueOn || undefined, details: { team } });
      if (kind === 'contraventie') {
        body.contravention = {
          ...cv, amount: cv.sanction === 'amenda' ? cv.amount : undefined, minAmount: cv.sanction === 'amenda' ? cv.minAmount : undefined,
          observedAt: cv.observedAt ? new Date(cv.observedAt).toISOString() : undefined, appliedOn: receivedOn,
          communicatedOn: cv.communicatedOn || undefined, communicationMethod: cv.communicatedOn ? cv.communicationMethod : undefined,
        };
      }
      const created = await api<CaseRow>('/cases', { method: 'POST', body });
      navigate(`/lucrari/${created.id}`, { state: { created: created.regLabel } });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (meta.loading && !meta.data) return <Loading />;
  const isRequest = kind === 'petitie' || kind === 'informatii_publice';

  return (
    <>
      <Link to="/lucrari" className="back-link">← Lucrări</Link>
      <PageHeader title="Lucrare nouă" subtitle="Numărul și termenul legal se stabilesc automat la înregistrare." />
      {parent.data && <Alert kind="info">Se leagă de {parent.data.regLabel}: {parent.data.subject}</Alert>}
      <ErrorAlert error={error ?? meta.error} />
      <form className="stack" onSubmit={submit}>
        <Section title="Tipul lucrării">
          <div className="choice-row" role="radiogroup" aria-label="Tipul lucrării">
            {allowed.map((k) => (
              <label key={k} className={`choice ${kind === k ? 'choice-active' : ''}`}>
                <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                <span>{CASE_KINDS[k].short}</span>
              </label>
            ))}
          </div>
          {kind === 'petitie' && <p className="hint">Termen: 30 de zile de la înregistrare, prelungibil cu cel mult 15. Redirecționarea se face în 5 zile.</p>}
          {kind === 'informatii_publice' && <p className="hint">Termen: 10 zile, sau 30 de zile pentru informații complexe, cu înștiințare în primele 10 zile. Refuzul motivat se comunică în 5 zile.</p>}
          {kind === 'contraventie' && <p className="hint">Procesul-verbal se comunică în cel mult 2 luni de la aplicare. Plata a jumătate din minim și plângerea: 15 zile de la comunicare.</p>}
        </Section>

        {isRequest && (
          <Section title={kind === 'petitie' ? 'Petentul' : 'Solicitantul'}>
            <div className="form-grid">
              {kind === 'petitie' && (
                <label className="check form-grid-end">
                  <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
                  <span>Petiție anonimă (se clasează, conform art. 7 din OG 27/2002)</span>
                </label>
              )}
              {!anonymous && <Field label="Nume și prenume / denumire" required><input value={applicantName} onChange={(e) => setApplicantName(e.target.value)} required /></Field>}
              {!anonymous && <Field label="Adresa de corespondență"><input value={applicantAddress} onChange={(e) => setApplicantAddress(e.target.value)} /></Field>}
              {!anonymous && <Field label="Email"><input type="email" value={applicantEmail} onChange={(e) => setApplicantEmail(e.target.value)} /></Field>}
              {!anonymous && <Field label="Telefon"><input value={applicantPhone} onChange={(e) => setApplicantPhone(e.target.value)} /></Field>}
              <Field label="Mod de primire">
                <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {Object.entries(CHANNELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
            </div>
          </Section>
        )}

        {kind === 'contraventie' && (
          <Section title="Procesul-verbal">
            <div className="form-grid">
              <Field label="Seria" required><input value={cv.pvSeries} onChange={(e) => setCvField('pvSeries', e.target.value)} required autoCapitalize="characters" /></Field>
              <Field label="Numărul" required><input value={cv.pvNumber} onChange={(e) => setCvField('pvNumber', e.target.value)} required inputMode="numeric" /></Field>
              <Field label="Contravenient (persoană sau firmă)" required><input value={cv.offenderName} onChange={(e) => setCvField('offenderName', e.target.value)} required /></Field>
              <Field label="CNP / CUI"><input value={cv.offenderIdCode} onChange={(e) => setCvField('offenderIdCode', e.target.value)} autoComplete="off" /></Field>
              <Field label="Domiciliu / sediu" className="form-grid-full"><input value={cv.offenderAddress} onChange={(e) => setCvField('offenderAddress', e.target.value)} /></Field>
              <Field label="Descrierea faptei" required className="form-grid-full"><textarea rows={3} value={cv.fact} onChange={(e) => setCvField('fact', e.target.value)} required /></Field>
              <Field label="Temeiul legal (act normativ, articol)" required className="form-grid-full"><input value={cv.legalBasis} onChange={(e) => setCvField('legalBasis', e.target.value)} required /></Field>
              <Field label="Data și ora constatării"><input type="datetime-local" value={cv.observedAt} onChange={(e) => setCvField('observedAt', e.target.value)} /></Field>
              <Field label="Sancțiunea">
                <select value={cv.sanction} onChange={(e) => setCvField('sanction', e.target.value)}>
                  <option value="amenda">Amendă</option>
                  <option value="avertisment">Avertisment</option>
                </select>
              </Field>
              {cv.sanction === 'amenda' && <Field label="Amenda aplicată (lei)" required><input value={cv.amount} onChange={(e) => setCvField('amount', e.target.value)} inputMode="decimal" required /></Field>}
              {cv.sanction === 'amenda' && <Field label="Minimul amenzii din actul normativ (lei)" hint="Pentru calculul a jumătate din minim."><input value={cv.minAmount} onChange={(e) => setCvField('minAmount', e.target.value)} inputMode="decimal" /></Field>}
              <Field label="Comunicat la data" hint="Dacă a fost înmânat la constatare, aceeași zi."><input type="date" value={cv.communicatedOn} onChange={(e) => setCvField('communicatedOn', e.target.value)} /></Field>
              {cv.communicatedOn && (
                <Field label="Mod de comunicare">
                  <select value={cv.communicationMethod} onChange={(e) => setCvField('communicationMethod', e.target.value)}>
                    {Object.entries(COMMUNICATION_METHODS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
              )}
            </div>
          </Section>
        )}

        <Section title="Lucrarea">
          <div className="form-grid">
            <Field label={kind === 'control' ? 'Tema controlului' : kind === 'contraventie' ? 'Obiect (implicit: fapta)' : 'Obiectul'} required={kind !== 'contraventie'} className="form-grid-full">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} required={kind !== 'contraventie'} />
            </Field>
            <Field label={kind === 'contraventie' ? 'Locul constatării' : kind === 'control' ? 'Obiectivul / adresa' : 'Adresa la care se referă'} required={kind === 'control'}
              hint="Folosită la istoricul pe adresă." className="form-grid-full">
              <input value={location} onChange={(e) => setLocation(e.target.value)} required={kind === 'control'} />
            </Field>
            <Field label={kind === 'contraventie' ? 'Data aplicării sancțiunii' : 'Data înregistrării'} required>
              <input type="date" value={receivedOn} max={todayIso()} onChange={(e) => setReceivedOn(e.target.value)} required />
            </Field>
            {kind === 'control' && <Field label="Termen de finalizare"><input type="date" value={manualDueOn} onChange={(e) => setManualDueOn(e.target.value)} /></Field>}
            {kind === 'control' && <Field label="Echipa de control" className="form-grid-full"><input value={team} onChange={(e) => setTeam(e.target.value)} /></Field>}
            <Field label="Compartiment">
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">Compartimentul meu</option>
                {meta.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Responsabil" hint={kind === 'contraventie' || kind === 'control' ? 'Implicit dumneavoastră.' : 'Se poate repartiza și ulterior, cu rezoluție.'}>
              <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">{kind === 'contraventie' || kind === 'control' ? 'Eu' : 'Nerepartizată'}</option>
                {meta.data?.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}{u.departmentName ? ` · ${u.departmentName}` : ''}</option>)}
              </select>
            </Field>
          </div>
          <DocPicker value={doc} onChange={setDoc} label="Documentul înregistrat (opțional)" />
        </Section>

        {isRequest && (
          <Section title="Obiecte multiple" actions={<button type="button" className="btn btn-sm" onClick={() => setObjects([...objects, ''])}>Adaugă obiect</button>}>
            {objects.length === 0 && <p className="hint">Dacă petiția are mai multe capete, adăugați câte un obiect; fiecare primește răspunsul lui.</p>}
            {objects.map((o, i) => (
              <div key={i} className="inline-row-fields">
                <Field label={`Obiectul ${i + 1}`} className="cell-grow"><input value={o} onChange={(e) => setObjects(objects.map((x, j) => (j === i ? e.target.value : x)))} /></Field>
                <button type="button" className="btn btn-sm" onClick={() => setObjects(objects.filter((_, j) => j !== i))}>Elimină</button>
              </div>
            ))}
          </Section>
        )}

        {anonymous && <Alert kind="info">Petiția anonimă se înregistrează, apoi se închide cu soluția „Clasată”.</Alert>}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Se înregistrează…' : 'Înregistrează lucrarea'}</button>
          <Link className="btn" to="/lucrari">Renunță</Link>
        </div>
      </form>
    </>
  );
}
