import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage, qs } from '../../api';
import { DocPicker, type PickedDoc } from '../../components/DocPicker';
import { Alert, Badge, DefinitionList, Empty, ErrorAlert, Field, Loading, Modal, Section } from '../../components/Ui';
import { fmtDate, fmtDateTime, fmtSize } from '../../format';
import { useAsync, usePageTitle } from '../../hooks';
import type { Meta } from '../../types';
import { DispatchList, type Dispatch } from '../../components/Dispatches';
import {
  CaseDeadline, CaseStatus, CHANNELS, COMMUNICATION_METHODS, DECISIONS, DISPATCH_METHODS, EVENT_LABELS, kindLabel,
  OUTCOME_LABELS, ROLE_LABELS, todayIso, type CaseRow,
} from './caseTypes';

interface CaseObject { id: number; text: string; departmentId: number | null; departmentName: string | null; assigneeId: number | null; assigneeName: string | null; status: 'deschis' | 'solutionat'; answer: string | null }
interface CaseDocument { role: string; id: number; title: string | null; regLabel: string | null; status: string; visible: boolean; addedAt: string; addedBy: string }
interface CaseEvent { id: number; at: string; kind: string; note: string | null; data: Record<string, unknown>; userName: string | null }
interface CasePhoto { id: number; filename: string; sizeBytes: number; latitude: number | null; longitude: number | null; note: string | null; createdAt: string; createdBy: string }
interface Contravention {
  pvSeries: string; pvNumber: string; offenderName: string; offenderIdCode: string | null; offenderAddress: string | null; fact: string; legalBasis: string;
  sanction: 'amenda' | 'avertisment'; amount: number | null; minAmount: number | null; halfMinimum: number | null; agentName: string | null; observedAt: string | null;
  appliedOn: string; communicationDue: string; communicatedOn: string | null; communicationMethod: string | null; payHalfDue: string | null; paidOn: string | null;
  paidAmount: number | null; complaintFiledOn: string | null; court: string | null; courtFile: string | null; decisionOn: string | null; decisionOutcome: string | null;
  executionSentOn: string | null; executionBody: string | null; readyForExecution: boolean;
}
interface CaseDetail extends CaseRow {
  applicantAddress: string | null; applicantEmail: string | null; applicantPhone: string | null; channel: string | null; extensionReason: string | null;
  manualDueOn: string | null; resolutionNote: string | null; redirectedTo: string | null; answerCommunicatedOn: string | null; details: Record<string, string>;
  createdByName: string; createdAt: string; parentLabel: string | null; parentKind: string | null;
  children: { id: number; kind: string; regLabel: string; subject: string; status: string; outcome: string | null }[];
  objects: CaseObject[]; documents: CaseDocument[]; events: CaseEvent[]; photos: CasePhoto[]; dispatches: Dispatch[];
  templates: { id: number; code: string; name: string; caseRole: string; documentTypeId: number | null; registerId: number | null }[];
  contravention: Contravention | null;
  deadlines: { key: string; label: string; date: string; met: boolean | null }[];
  outcomes: Record<string, string>;
  canEdit: boolean; canExtend: boolean; extensionHint: string | null;
}

const money = (n: number | null) => (n == null ? '–' : `${n.toLocaleString('ro-RO', { minimumFractionDigits: 2 })} lei`);

export default function CaseDetailRoute() {
  const { id } = useParams();
  return <CaseDetailPage key={id} id={Number(id)} />;
}

type Dialog = 'close' | 'reopen' | 'extend' | 'assign' | 'note' | 'generate' | 'dispatch' | 'addDoc' | 'object' | 'cv' | null;

function CaseDetailPage({ id }: { id: number }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: c, error, loading, reload } = useAsync(() => api<CaseDetail>(`/cases/${id}`), [id]);
  const meta = useAsync(() => api<Meta>('/meta'), []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  usePageTitle(c ? c.regLabel : 'Lucrare');
  const created = (location.state as { created?: string } | null)?.created;

  const done = async (message: string) => {
    setDialog(null);
    setNotice(message);
    await reload();
  };

  if (!Number.isInteger(id)) return <Alert kind="error">Adresa lucrării nu este validă.</Alert>;
  if (error && !c) return <ErrorAlert error={error} retry={() => void reload()} />;
  if (loading && !c) return <Loading label="Se încarcă lucrarea…" />;
  if (!c) return null;
  const open = c.status === 'deschisa';
  const edit = c.canEdit && open;
  const isRequest = c.kind === 'petitie' || c.kind === 'informatii_publice';

  return (
    <div className="doc-page">
      {created && (
        <div className="registered" role="status">
          <div>
            <p className="registered-label">Lucrare înregistrată cu numărul</p>
            <p className="registered-number">{created}</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => navigate(location.pathname, { replace: true, state: null })}>Închide</button>
        </div>
      )}
      <Link to={`/lucrari${qs({ kind: c.kind })}`} className="back-link">← Lucrări</Link>
      <header className="doc-header">
        <div className="doc-header-text">
          <p className="doc-number">{c.regLabel}{c.contravention ? ` · PV ${c.contravention.pvSeries} ${c.contravention.pvNumber}` : ''}</p>
          <h1>{c.subject}</h1>
          <div className="doc-facts">
            <CaseStatus row={c} />
            <CaseDeadline row={c} />
            <span>{kindLabel(c.kind)}</span>
            <span>{c.departmentName}</span>
          </div>
        </div>
        {c.canEdit && (
          <div className="doc-header-actions case-actions">
            {open && <button type="button" className="btn" onClick={() => setDialog('assign')}>Repartizează</button>}
            {open && c.canExtend && <button type="button" className="btn" onClick={() => setDialog('extend')}>Prelungește termenul</button>}
            <button type="button" className="btn" onClick={() => setDialog('note')}>Notă</button>
            {open ? <button type="button" className="btn btn-primary" onClick={() => setDialog('close')}>Închide lucrarea</button>
              : <button type="button" className="btn" onClick={() => setDialog('reopen')}>Redeschide</button>}
          </div>
        )}
      </header>
      {notice && <Alert kind="success">{notice}</Alert>}
      <ErrorAlert error={error} retry={() => void reload()} />
      {c.anonymous && open && <Alert kind="warning">Petiție anonimă: conform art. 7 din OG 27/2002 se clasează.</Alert>}
      {c.contravention?.readyForExecution && open && (
        <Alert kind="warning" title="Procesul-verbal trebuie trimis spre executare">
          Amenda nu a fost achitată, iar termenul de plângere a trecut{c.contravention.decisionOutcome ? ' sau plângerea a fost respinsă' : ''}.
        </Alert>
      )}

      <div className="doc-grid">
        <div className="doc-col-main">
          <Section title="Date">
            <DefinitionList items={[
              { label: c.kind === 'contraventie' ? 'Data aplicării' : 'Înregistrată la', value: fmtDate(c.receivedOn) },
              { label: 'Petent', value: c.anonymous ? 'Anonim' : c.applicantName },
              { label: 'Adresa petentului', value: c.applicantAddress },
              { label: 'Email', value: c.applicantEmail },
              { label: 'Telefon', value: c.applicantPhone },
              { label: 'Mod de primire', value: c.channel ? CHANNELS[c.channel] ?? c.channel : null },
              { label: c.kind === 'control' ? 'Obiectivul' : 'Adresa / locul', value: c.location ? <Link to={`/istoric-adresa${qs({ adresa: c.location })}`}>{c.location}</Link> : null },
              { label: 'Echipa', value: c.details?.team },
              { label: 'Responsabil', value: c.assigneeName ?? 'Nerepartizată' },
              { label: 'Compartiment', value: c.departmentName },
              { label: 'Înregistrată de', value: `${c.createdByName}, ${fmtDateTime(c.createdAt)}` },
              { label: 'Răspuns comunicat la', value: fmtDate(c.answerCommunicatedOn) },
            ]} />
          </Section>

          {c.kind === 'control' && <FindingsSection c={c} editable={edit} onSaved={() => done('Constatările au fost salvate.')} />}
          {c.contravention && <ContraventionSection c={c} cv={c.contravention} editable={edit} onEdit={() => setDialog('cv')} />}

          {isRequest && (
            <Section title="Obiectele petiției" count={c.objects.length}
              actions={edit ? <button type="button" className="btn btn-sm" onClick={() => setDialog('object')}>Adaugă obiect</button> : undefined}>
              {c.objects.length === 0 ? <Empty title="Un singur obiect: cel din titlu." /> : (
                <ul className="object-list">
                  {c.objects.map((o) => <ObjectRow key={o.id} caseId={c.id} o={o} editable={edit} onChanged={() => done('Obiectul a fost actualizat.')} />)}
                </ul>
              )}
            </Section>
          )}

          <Section title="Dosarul lucrării" count={c.documents.length} actions={c.canEdit ? (
            <span className="case-actions">
              <button type="button" className="btn btn-sm" onClick={() => setDialog('addDoc')}>Adaugă document</button>
              {c.templates.length > 0 && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog('generate')}>Generează din șablon</button>}
            </span>
          ) : undefined}>
            {c.documents.length === 0 ? <Empty title="Nu există documente în dosar." /> : (
              <ul className="row-list">
                {c.documents.map((d) => (
                  <li key={d.id} className="row-static">
                    <span className="row-sub">{ROLE_LABELS[d.role] ?? d.role} · adăugat de {d.addedBy}, {fmtDate(d.addedAt)}</span>
                    {d.visible ? <Link to={`/documente/${d.id}`}>{d.regLabel ?? 'Fără număr'} · {d.title}</Link> : <span>{d.regLabel ?? 'Document'} · fără acces</span>}
                    {d.status === 'anulat' && <> <Badge tone="danger">Anulat</Badge></>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <PhotosSection c={c} editable={edit} onAdded={() => done('Fotografia a fost adăugată.')} />

          <Section title="Expediere și dovada comunicării" count={c.dispatches.length}
            actions={c.canEdit ? <button type="button" className="btn btn-sm" onClick={() => setDialog('dispatch')}>Expediază</button> : undefined}>
            <DispatchList items={c.dispatches} onChanged={() => done('Primirea a fost confirmată.')} />
          </Section>

          <Section title="Istoric" count={c.events.length} collapsible defaultOpen>
            <ol className="timeline">
              {c.events.map((e) => (
                <li key={e.id}>
                  <time dateTime={e.at}>{fmtDateTime(e.at)}</time>
                  <div>
                    <strong>{EVENT_LABELS[e.kind] ?? e.kind}</strong>{e.userName ? ` · ${e.userName}` : ' · sistem'}
                    {e.note && <div>{e.note}</div>}
                    <EventData e={e} />
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <div className="doc-col-side">
          <Section title="Termene">
            {c.deadlines.length === 0 ? <p className="muted">Fără termen legal calculat.</p> : (
              <ul className="deadline-list">
                {c.deadlines.map((d) => (
                  <li key={d.key}>
                    <span>{d.label}</span>
                    <span className="deadline-date">{fmtDate(d.date)}</span>
                    {d.met === true && <Badge tone="success">Respectat</Badge>}
                    {d.met === false && <Badge tone="danger">Depășit</Badge>}
                  </li>
                ))}
              </ul>
            )}
            {c.extensionDays > 0 && <p className="hint">Prelungit cu {c.extensionDays} zile: {c.extensionReason}</p>}
            {open && c.canEdit && !c.canExtend && c.extensionHint && (c.kind === 'petitie' || c.kind === 'informatii_publice') && <p className="hint">{c.extensionHint}.</p>}
          </Section>
          {!open && (
            <Section title="Soluția">
              <p><CaseStatus row={c} /></p>
              {c.redirectedTo && <p>Redirecționată către: <strong>{c.redirectedTo}</strong></p>}
              {c.outcome === 'conexata' && c.parentId && <p>Conexată la <Link to={`/lucrari/${c.parentId}`}>{c.parentLabel}</Link></p>}
              <p className="post-body">{c.resolutionNote}</p>
              <p className="hint">Închisă la {fmtDateTime(c.closedAt)}</p>
            </Section>
          )}
          <Section title="Lucrări legate" count={c.children.length + (c.parentId ? 1 : 0)}
            actions={c.kind === 'control' && edit ? <Link className="btn btn-sm" to={`/lucrari/nou${qs({ tip: 'contraventie', parinte: c.id })}`}>Proces-verbal nou</Link> : undefined}>
            {c.parentId && c.outcome !== 'conexata' && <p>Provine din <Link to={`/lucrari/${c.parentId}`}>{c.parentLabel}</Link> ({kindLabel(c.parentKind ?? '')})</p>}
            {c.children.length === 0 && !c.parentId && <p className="muted">Nicio lucrare legată.</p>}
            <ul className="row-list">
              {c.children.map((k) => (
                <li key={k.id} className="row-static">
                  <span className="row-sub">{kindLabel(k.kind)} · {k.status === 'deschisa' ? 'deschisă' : OUTCOME_LABELS[k.outcome ?? ''] ?? 'închisă'}</span>
                  <Link to={`/lucrari/${k.id}`}>{k.regLabel} · {k.subject}</Link>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>

      {dialog === 'close' && <CloseDialog c={c} onClose={() => setDialog(null)} onDone={() => done('Lucrarea a fost închisă.')} />}
      {dialog === 'reopen' && <SimpleDialog title="Redeschide lucrarea" label="Motivul redeschiderii" url={`/cases/${c.id}/reopen`} field="reason" submit="Redeschide" onClose={() => setDialog(null)} onDone={() => done('Lucrarea a fost redeschisă.')} />}
      {dialog === 'note' && <SimpleDialog title="Notă în istoricul lucrării" label="Nota" url={`/cases/${c.id}/notes`} field="note" submit="Adaugă nota" onClose={() => setDialog(null)} onDone={() => done('Nota a fost adăugată.')} />}
      {dialog === 'extend' && <ExtendDialog c={c} onClose={() => setDialog(null)} onDone={() => done('Termenul a fost prelungit. Generați și înștiințarea petentului din șablon.')} />}
      {dialog === 'assign' && <AssignDialog c={c} meta={meta.data} onClose={() => setDialog(null)} onDone={() => done('Lucrarea a fost repartizată.')} />}
      {dialog === 'object' && <ObjectDialog c={c} meta={meta.data} onClose={() => setDialog(null)} onDone={() => done('Obiectul a fost adăugat.')} />}
      {dialog === 'addDoc' && <AddDocDialog c={c} onClose={() => setDialog(null)} onDone={() => done('Documentul a fost adăugat la dosar.')} />}
      {dialog === 'generate' && <GenerateDialog c={c} meta={meta.data} onClose={() => setDialog(null)} onDone={(label) => done(`Documentul a fost generat și înregistrat${label ? ` cu numărul ${label}` : ''}.`)} />}
      {dialog === 'dispatch' && <DispatchDialog c={c} onClose={() => setDialog(null)} onDone={() => done('Expedierea a fost înregistrată.')} />}
      {dialog === 'cv' && c.contravention && <ContraventionDialog c={c} cv={c.contravention} onClose={() => setDialog(null)} onDone={() => done('Dosarul contravențional a fost actualizat.')} />}
    </div>
  );
}

function EventData({ e }: { e: CaseEvent }) {
  const d = e.data ?? {};
  const parts: string[] = [];
  if (e.kind === 'repartizare') parts.push(`către ${d.responsabil ?? 'nimeni'}${d.compartiment ? `, ${d.compartiment}` : ''}`);
  if (e.kind === 'prelungire' && d.zile) parts.push(`cu ${d.zile} zile`);
  if (e.kind === 'inchidere' && d.solutie) parts.push(OUTCOME_LABELS[String(d.solutie)] ?? String(d.solutie));
  if ((e.kind === 'document_generat' || e.kind === 'document_adaugat') && d.numar) parts.push(`nr. ${d.numar}`);
  if (e.kind === 'expediere' && d.mod) parts.push(DISPATCH_METHODS[String(d.mod)] ?? String(d.mod));
  if (e.kind === 'confirmare_primire' && d.primitLa) parts.push(`primit la ${fmtDate(String(d.primitLa))}`);
  if (e.kind === 'notificare_termen' || e.kind === 'escaladare') parts.push(`termen ${fmtDate(String(d.termen))}`);
  if (e.kind === 'contraventie') parts.push(Object.keys(d).map((k) => CV_FIELD_LABELS[k] ?? k).join(', '));
  if (!parts.length) return null;
  return <div className="muted">{parts.join(' · ')}</div>;
}
const CV_FIELD_LABELS: Record<string, string> = {
  communicated_on: 'comunicare', communication_method: 'mod de comunicare', paid_on: 'plată', paid_amount: 'sumă achitată', complaint_filed_on: 'plângere',
  court: 'instanță', court_file: 'dosar instanță', decision_on: 'hotărâre', decision_outcome: 'soluția instanței', execution_sent_on: 'trimitere spre executare', execution_body: 'organ de executare',
};

// Secțiuni ----------------------------------------------------------------------

function ContraventionSection({ c, cv, editable, onEdit }: { c: CaseDetail; cv: Contravention; editable: boolean; onEdit: () => void }) {
  return (
    <Section title="Dosarul contravențional" actions={editable ? <button type="button" className="btn btn-sm" onClick={onEdit}>Actualizează</button> : undefined}>
      <DefinitionList items={[
        { label: 'Proces-verbal', value: `seria ${cv.pvSeries} nr. ${cv.pvNumber}` },
        { label: 'Contravenient', value: cv.offenderName },
        { label: 'CNP / CUI', value: cv.offenderIdCode },
        { label: 'Domiciliu / sediu', value: cv.offenderAddress },
        { label: 'Fapta', value: cv.fact },
        { label: 'Temei legal', value: cv.legalBasis },
        { label: 'Constatată la', value: fmtDateTime(cv.observedAt) },
        { label: 'Agent constatator', value: cv.agentName },
        { label: 'Sancțiune', value: cv.sanction === 'amenda' ? `Amendă ${money(cv.amount)}` : 'Avertisment' },
        { label: 'Jumătate din minim', value: cv.halfMinimum != null ? money(cv.halfMinimum) : null },
        { label: 'Comunicat', value: cv.communicatedOn ? `${fmtDate(cv.communicatedOn)} · ${COMMUNICATION_METHODS[cv.communicationMethod ?? ''] ?? cv.communicationMethod}` : `Necomunicat; termen ${fmtDate(cv.communicationDue)}` },
        { label: 'Plată / plângere până la', value: fmtDate(cv.payHalfDue) },
        { label: 'Achitat', value: cv.paidOn ? `${fmtDate(cv.paidOn)}, ${money(cv.paidAmount)}` : null },
        { label: 'Plângere', value: cv.complaintFiledOn ? `${fmtDate(cv.complaintFiledOn)}${cv.court ? `, ${cv.court}` : ''}${cv.courtFile ? `, dosar ${cv.courtFile}` : ''}` : null },
        { label: 'Hotărâre', value: cv.decisionOn ? `${fmtDate(cv.decisionOn)}: ${DECISIONS[cv.decisionOutcome ?? ''] ?? cv.decisionOutcome}` : null },
        { label: 'Trimis spre executare', value: cv.executionSentOn ? `${fmtDate(cv.executionSentOn)}, ${cv.executionBody}` : null },
      ]} />
      {c.status === 'deschisa' && !cv.communicatedOn && <p className="hint">Procesul-verbal se comunică până la {fmtDate(cv.communicationDue)} (2 luni de la aplicare).</p>}
    </Section>
  );
}

function FindingsSection({ c, editable, onSaved }: { c: CaseDetail; editable: boolean; onSaved: () => void }) {
  const [findings, setFindings] = useState(c.details?.findings ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/cases/${c.id}`, { method: 'PATCH', body: { details: { findings } } });
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Section title="Constatări">
      <ErrorAlert error={error} />
      {editable ? (
        <>
          <Field label="Ce s-a constatat la fața locului"><textarea rows={5} value={findings} onChange={(e) => setFindings(e.target.value)} /></Field>
          <button type="button" className="btn" disabled={busy || findings === (c.details?.findings ?? '')} onClick={save}>{busy ? 'Se salvează…' : 'Salvează constatările'}</button>
        </>
      ) : <p className="post-body">{c.details?.findings || 'Fără constatări consemnate.'}</p>}
    </Section>
  );
}

function ObjectRow({ caseId, o, editable, onChanged }: { caseId: number; o: CaseObject; editable: boolean; onChanged: () => void }) {
  const [answer, setAnswer] = useState(o.answer ?? '');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async (status: 'deschis' | 'solutionat') => {
    setError(null);
    try {
      await api(`/cases/${caseId}/objects/${o.id}`, { method: 'PATCH', body: { answer, status } });
      setEditing(false);
      onChanged();
    } catch (err) { setError(err); }
  };
  return (
    <li>
      <div className="inline-row-fields">
        <strong className="cell-grow">{o.text}</strong>
        <Badge tone={o.status === 'solutionat' ? 'success' : 'info'}>{o.status === 'solutionat' ? 'Soluționat' : 'Deschis'}</Badge>
      </div>
      <div className="muted">{[o.departmentName, o.assigneeName].filter(Boolean).join(' · ') || 'Compartimentul lucrării'}</div>
      {o.answer && !editing && <p className="post-body">{o.answer}</p>}
      <ErrorAlert error={error} />
      {editable && !editing && <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>{o.status === 'solutionat' ? 'Modifică răspunsul' : 'Răspunde'}</button>}
      {editing && (
        <div className="inline-form">
          <Field label="Răspunsul la acest obiect"><textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} /></Field>
          <div className="case-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => save('solutionat')}>Marchează soluționat</button>
            <button type="button" className="btn btn-sm" onClick={() => save('deschis')}>Salvează ca ciornă</button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Renunță</button>
          </div>
        </div>
      )}
    </li>
  );
}

function PhotosSection({ c, editable, onAdded }: { c: CaseDetail; editable: boolean; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const position = (): Promise<GeolocationPosition | null> => new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      const pos = await position();
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set('file', file);
        if (note.trim()) form.set('note', note.trim());
        if (pos) { form.set('latitude', String(pos.coords.latitude)); form.set('longitude', String(pos.coords.longitude)); }
        await api(`/cases/${c.id}/photos`, { method: 'POST', form });
      }
      setNote('');
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!editable && c.photos.length === 0) return null;
  return (
    <Section title="Fotografii din teren" count={c.photos.length}>
      {error && <Alert kind="error">{error}</Alert>}
      {editable && (
        <div className="inline-row-fields">
          <Field label="Descriere (opțional)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="de exemplu: fațada dinspre stradă" /></Field>
          <label className="btn btn-primary">
            {busy ? 'Se încarcă…' : 'Fotografiază / alege'}
            <input type="file" accept="image/jpeg,image/png" capture="environment" multiple hidden disabled={busy} onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
      )}
      {editable && <p className="hint">Pe telefon se deschide camera. Locul se salvează dacă permiteți accesul la locație.</p>}
      {c.photos.length > 0 && (
        <div className="photo-grid">
          {c.photos.map((p) => (
            <figure key={p.id}>
              <a href={`/api/cases/${c.id}/photos/${p.id}`} target="_blank" rel="noreferrer"><img src={`/api/cases/${c.id}/photos/${p.id}`} alt={p.note ?? p.filename} loading="lazy" /></a>
              <figcaption>
                {p.note && <>{p.note}<br /></>}
                {fmtDateTime(p.createdAt)} · {p.createdBy} · {fmtSize(p.sizeBytes)}
                {p.latitude != null && p.longitude != null && <><br />GPS {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}</>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Section>
  );
}

// Dialoguri ----------------------------------------------------------------------

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(err); setBusy(false); }
  };
  return { busy, error, submit };
}

function FormDialog({ title, formId, busy, submitLabel, onClose, onSubmit, error, children, wide }: {
  title: string; formId: string; busy: boolean; submitLabel: string; onClose: () => void; onSubmit: (e: FormEvent) => void; error: unknown; children: ReactNode; wide?: boolean;
}) {
  return (
    <Modal title={title} onClose={onClose} wide={wide} footer={(
      <>
        <button type="button" className="btn" onClick={onClose}>Renunță</button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={busy}>{busy ? 'Se salvează…' : submitLabel}</button>
      </>
    )}>
      <form id={formId} className="stack" onSubmit={onSubmit}>
        <ErrorAlert error={error} />
        {children}
      </form>
    </Modal>
  );
}

function SimpleDialog({ title, label, url, field, submit: submitLabel, onClose, onDone }: { title: string; label: string; url: string; field: string; submit: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const { busy, error, submit } = useSubmit(async () => { await api(url, { method: 'POST', body: { [field]: text } }); onDone(); });
  return (
    <FormDialog title={title} formId="simplu" busy={busy} submitLabel={submitLabel} onClose={onClose} onSubmit={submit} error={error}>
      <Field label={label} required><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} required /></Field>
    </FormDialog>
  );
}

function CloseDialog({ c, onClose, onDone }: { c: CaseDetail; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState(c.anonymous ? 'clasata' : Object.keys(c.outcomes)[0]);
  const [note, setNote] = useState(c.anonymous ? 'Petiție anonimă (art. 7 din OG 27/2002).' : '');
  const [redirectedTo, setRedirectedTo] = useState('');
  const [parentId, setParentId] = useState('');
  const candidates = useAsync(() => (outcome === 'conexata' ? api<{ items: CaseRow[] }>(`/cases${qs({ kind: c.kind, limit: 200 })}`) : Promise.resolve(null)), [outcome]);
  const { busy, error, submit } = useSubmit(async () => {
    await api(`/cases/${c.id}/close`, { method: 'POST', body: { outcome, note, redirectedTo: redirectedTo || undefined, parentId: parentId || undefined } });
    onDone();
  });
  const openObjects = c.objects.filter((o) => o.status === 'deschis').length;
  return (
    <FormDialog title="Închide lucrarea" formId="inchide" busy={busy} submitLabel="Închide lucrarea" onClose={onClose} onSubmit={submit} error={error}>
      <Field label="Soluția" required>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {Object.entries(c.outcomes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      {openObjects > 0 && ['favorabil', 'nefavorabil', 'partial', 'comunicat'].includes(outcome) && <Alert kind="warning">{openObjects} obiecte nu au încă răspuns.</Alert>}
      {outcome === 'redirectionata' && <Field label="Instituția competentă" required><input value={redirectedTo} onChange={(e) => setRedirectedTo(e.target.value)} required /></Field>}
      {outcome === 'conexata' && (
        <Field label="Lucrarea la care se conexează" required hint="Petiția mai veche a aceluiași petent, cu același obiect.">
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} required>
            <option value="">Alegeți</option>
            {candidates.data?.items.filter((x) => x.id !== c.id).map((x) => <option key={x.id} value={x.id}>{x.regLabel} · {x.applicantName ?? 'anonim'} · {x.subject}</option>)}
          </select>
        </Field>
      )}
      <Field label={outcome === 'clasata' ? 'Motivul clasării' : 'Soluția, pe scurt'} required hint="Textul apare în răspunsul generat din șablon."><textarea rows={5} value={note} onChange={(e) => setNote(e.target.value)} required /></Field>
      {outcome === 'redirectionata' && <p className="hint">După închidere, generați din șablon adresa către instituție și înștiințarea petentului.</p>}
    </FormDialog>
  );
}

function ExtendDialog({ c, onClose, onDone }: { c: CaseDetail; onClose: () => void; onDone: () => void }) {
  const [days, setDays] = useState('15');
  const [reason, setReason] = useState('');
  const { busy, error, submit } = useSubmit(async () => { await api(`/cases/${c.id}/extend`, { method: 'POST', body: { days: Number(days), reason } }); onDone(); });
  return (
    <FormDialog title="Prelungește termenul" formId="prelungire" busy={busy} submitLabel="Prelungește" onClose={onClose} onSubmit={submit} error={error}>
      {c.kind === 'petitie'
        ? <Field label="Cu câte zile" required hint="Cel mult 15 zile (art. 9 din OG 27/2002)."><input type="number" min={1} max={15} value={days} onChange={(e) => setDays(e.target.value)} required /></Field>
        : <p>Termenul de răspuns devine 30 de zile de la înregistrare (art. 7 din Legea 544/2001). Solicitantul trebuie înștiințat în primele 10 zile.</p>}
      <Field label="Motivul" required><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
    </FormDialog>
  );
}

function AssignDialog({ c, meta, onClose, onDone }: { c: CaseDetail; meta: Meta | null | undefined; onClose: () => void; onDone: () => void }) {
  const [assigneeId, setAssigneeId] = useState(c.assigneeId ? String(c.assigneeId) : '');
  const [departmentId, setDepartmentId] = useState(String(c.departmentId));
  const [note, setNote] = useState('');
  const { busy, error, submit } = useSubmit(async () => { await api(`/cases/${c.id}/assign`, { method: 'POST', body: { assigneeId: assigneeId || null, departmentId, note } }); onDone(); });
  return (
    <FormDialog title="Repartizare și rezoluție" formId="repartizare" busy={busy} submitLabel="Repartizează" onClose={onClose} onSubmit={submit} error={error}>
      <Field label="Compartiment">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>{meta?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      </Field>
      <Field label="Responsabil">
        <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Nerepartizată</option>
          {meta?.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}{u.departmentName ? ` · ${u.departmentName}` : ''}</option>)}
        </select>
      </Field>
      <Field label="Rezoluția" hint="Indicațiile pentru cel care soluționează; apar în istoric și în notificare."><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDialog>
  );
}

function ObjectDialog({ c, meta, onClose, onDone }: { c: CaseDetail; meta: Meta | null | undefined; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const { busy, error, submit } = useSubmit(async () => { await api(`/cases/${c.id}/objects`, { method: 'POST', body: { text, departmentId: departmentId || undefined, assigneeId: assigneeId || undefined } }); onDone(); });
  return (
    <FormDialog title="Obiect nou al petiției" formId="obiect" busy={busy} submitLabel="Adaugă" onClose={onClose} onSubmit={submit} error={error}>
      <Field label="Obiectul" required><textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} required /></Field>
      <Field label="Compartimentul care răspunde">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">Compartimentul lucrării</option>
          {meta?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
      <Field label="Responsabil">
        <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Responsabilul lucrării</option>
          {meta?.users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </select>
      </Field>
    </FormDialog>
  );
}

function AddDocDialog({ c, onClose, onDone }: { c: CaseDetail; onClose: () => void; onDone: () => void }) {
  const [doc, setDoc] = useState<PickedDoc | null>(null);
  const [role, setRole] = useState(c.kind === 'contraventie' ? 'plangere' : 'raspuns');
  const { busy, error, submit } = useSubmit(async () => {
    if (!doc) throw new ApiError(400, 'Alegeți documentul');
    await api(`/cases/${c.id}/documents`, { method: 'POST', body: { documentId: doc.id, role } });
    onDone();
  });
  return (
    <FormDialog title="Adaugă un document înregistrat" formId="adauga-doc" busy={busy} submitLabel="Adaugă la dosar" onClose={onClose} onSubmit={submit} error={error}>
      <DocPicker value={doc} onChange={setDoc} label="Document" />
      <Field label="Rolul în dosar">
        <select value={role} onChange={(e) => setRole(e.target.value)}>{Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </Field>
      <p className="hint">Documentele noi se înregistrează întâi din <Link to="/documente/nou">Înregistrare document</Link>.</p>
    </FormDialog>
  );
}

const LONG_FIELDS = new Set(['solutie', 'constatari', 'fapta', 'motiv_prelungire', 'obiect']);
const FIELD_LABELS: Record<string, string> = {
  institutie: 'Instituția', conducator: 'Conducătorul', conducator_functie: 'Funcția conducătorului', numar_lucrare: 'Numărul lucrării', data: 'Data documentului',
  data_primirii: 'Data înregistrării', termen: 'Termen', obiect: 'Obiectul', petent: 'Petentul', adresa_petent: 'Adresa petentului', email_petent: 'Emailul petentului',
  institutie_competenta: 'Instituția competentă', solutie: 'Textul răspunsului / soluția', responsabil: 'Întocmit de', adresa: 'Adresa / obiectivul',
  zile_prelungire: 'Zile de prelungire', motiv_prelungire: 'Motivul prelungirii', echipa: 'Echipa de control', constatari: 'Constatări', pv_serie: 'Seria PV',
  pv_numar: 'Numărul PV', contravenient: 'Contravenientul', cod_contravenient: 'CNP / CUI', adresa_contravenient: 'Domiciliul contravenientului', fapta: 'Fapta',
  temei: 'Temeiul legal', sanctiune: 'Sancțiunea', amenda: 'Amenda', jumatate_minim: 'Jumătate din minim', agent: 'Agentul constatator', data_constatarii: 'Data constatării',
  data_aplicarii: 'Data aplicării', data_comunicarii: 'Data comunicării', organ_executare: 'Organul de executare', mentiune_hotarare: 'Mențiune despre hotărâre',
};

function GenerateDialog({ c, meta, onClose, onDone }: { c: CaseDetail; meta: Meta | null | undefined; onClose: () => void; onDone: (label: string | null) => void }) {
  const [templateId, setTemplateId] = useState(String(c.templates[0]?.id ?? ''));
  const fields = useAsync(() => api<{ template: { documentTypeId: number | null; registerId: number | null }; fields: { key: string; value: string }[] }>(`/cases/${c.id}/templates/${templateId}`), [templateId]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [documentTypeId, setDocumentTypeId] = useState('');
  const [registerId, setRegisterId] = useState('');
  const current = (key: string) => values[`${templateId}:${key}`] ?? fields.data?.fields.find((f) => f.key === key)?.value ?? '';
  const payload = () => Object.fromEntries((fields.data?.fields ?? []).map((f) => [f.key, current(f.key)]));
  const { busy, error, submit } = useSubmit(async () => {
    const r = await api<{ id: number; regLabel: string | null }>(`/cases/${c.id}/generate`, {
      method: 'POST',
      body: { templateId: Number(templateId), documentTypeId: documentTypeId || fields.data?.template.documentTypeId || undefined, registerId: registerId || fields.data?.template.registerId || undefined, values: payload() },
    });
    onDone(r.regLabel);
  });
  const previewUrl = `/api/cases/${c.id}/templates/${templateId}/preview${qs({ values: JSON.stringify(payload()) })}`;
  return (
    <FormDialog title="Document din șablon" formId="genereaza" busy={busy} submitLabel="Generează și înregistrează" onClose={onClose} onSubmit={submit} error={error ?? fields.error} wide>
      <Field label="Șablonul">
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{c.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      </Field>
      <div className="form-grid">
        <Field label="Tipul documentului" required={!fields.data?.template.documentTypeId}>
          <select value={documentTypeId} onChange={(e) => setDocumentTypeId(e.target.value)} required={!fields.data?.template.documentTypeId}>
            <option value="">{fields.data?.template.documentTypeId ? 'Cel din șablon' : 'Alegeți'}</option>
            {meta?.documentTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Registrul" hint="Documentul primește număr în registrul ales.">
          <select value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
            <option value="">{fields.data?.template.registerId ? 'Cel din șablon' : 'Fără număr de registru'}</option>
            {meta?.registers.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.code})</option>)}
          </select>
        </Field>
      </div>
      {fields.loading && !fields.data && <Loading />}
      {fields.data && (
        <fieldset className="fieldset">
          <legend>Câmpurile documentului</legend>
          <p className="hint">Valorile vin din lucrare; le puteți corecta înainte de generare. Un câmp gol apare ca linie de completat.</p>
          <div className="form-grid">
            {fields.data.fields.map((f) => (
              <Field key={f.key} label={FIELD_LABELS[f.key] ?? f.key} className={LONG_FIELDS.has(f.key) ? 'form-grid-full' : undefined}>
                {LONG_FIELDS.has(f.key)
                  ? <textarea rows={f.key === 'solutie' || f.key === 'constatari' ? 6 : 2} value={current(f.key)} onChange={(e) => setValues({ ...values, [`${templateId}:${f.key}`]: e.target.value })} />
                  : <input value={current(f.key)} onChange={(e) => setValues({ ...values, [`${templateId}:${f.key}`]: e.target.value })} />}
              </Field>
            ))}
          </div>
        </fieldset>
      )}
      <p><a className="btn" href={previewUrl} target="_blank" rel="noreferrer">Previzualizează PDF</a></p>
    </FormDialog>
  );
}

function DispatchDialog({ c, onClose, onDone }: { c: CaseDetail; onClose: () => void; onDone: () => void }) {
  const answerDoc = [...c.documents].reverse().find((d) => d.role === 'raspuns' || d.role === 'adresa' || d.role === 'proces_verbal');
  const [documentId, setDocumentId] = useState(answerDoc ? String(answerDoc.id) : '');
  const [method, setMethod] = useState(c.applicantEmail ? 'email' : 'posta_recomandata');
  const [recipient, setRecipient] = useState(c.contravention?.offenderName ?? c.applicantName ?? '');
  const [address, setAddress] = useState(c.contravention?.offenderAddress ?? (c.applicantEmail && method === 'email' ? c.applicantEmail : c.applicantAddress) ?? '');
  const [sentOn, setSentOn] = useState(todayIso());
  const [tracking, setTracking] = useState('');
  const [isAnswer, setIsAnswer] = useState(c.kind === 'petitie' || c.kind === 'informatii_publice');
  const { busy, error, submit } = useSubmit(async () => {
    await api(`/cases/${c.id}/dispatches`, { method: 'POST', body: { documentId: documentId || undefined, method, recipient, address, sentOn, tracking, isAnswer } });
    onDone();
  });
  return (
    <FormDialog title="Expediere" formId="expediere" busy={busy} submitLabel="Înregistrează expedierea" onClose={onClose} onSubmit={submit} error={error}>
      <Field label="Documentul expediat">
        <select value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
          <option value="">Fără document din dosar</option>
          {c.documents.filter((d) => d.visible && d.status !== 'anulat').map((d) => <option key={d.id} value={d.id}>{d.regLabel ?? 'Fără număr'} · {d.title}</option>)}
        </select>
      </Field>
      <div className="form-grid">
        <Field label="Mod"><select value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(DISPATCH_METHODS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Data expedierii"><input type="date" value={sentOn} max={todayIso()} onChange={(e) => setSentOn(e.target.value)} /></Field>
        <Field label="Destinatar" required><input value={recipient} onChange={(e) => setRecipient(e.target.value)} required /></Field>
        <Field label={method === 'email' ? 'Adresa de email' : 'Adresa'}><input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        {['posta', 'posta_recomandata', 'curier'].includes(method) && <Field label="Număr de urmărire / confirmare"><input value={tracking} onChange={(e) => setTracking(e.target.value)} /></Field>}
      </div>
      {(c.kind === 'petitie' || c.kind === 'informatii_publice') && (
        <label className="check"><input type="checkbox" checked={isAnswer} onChange={(e) => setIsAnswer(e.target.checked)} /><span>Este răspunsul către petent (intră în situația semestrială)</span></label>
      )}
      <p className="hint">Înmânarea, emailul și afișarea se consideră comunicate la data expedierii. Pentru poștă, confirmați primirea când vine confirmarea.</p>
    </FormDialog>
  );
}

function ContraventionDialog({ c, cv, onClose, onDone }: { c: CaseDetail; cv: Contravention; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({
    communicatedOn: cv.communicatedOn ?? '', communicationMethod: cv.communicationMethod ?? 'posta', paidOn: cv.paidOn ?? '', paidAmount: cv.paidAmount?.toString() ?? '',
    complaintFiledOn: cv.complaintFiledOn ?? '', court: cv.court ?? '', courtFile: cv.courtFile ?? '', decisionOn: cv.decisionOn ?? '', decisionOutcome: cv.decisionOutcome ?? '',
    executionSentOn: cv.executionSentOn ?? '', executionBody: cv.executionBody ?? '',
  });
  const set = (k: keyof typeof v, value: string) => setV({ ...v, [k]: value });
  const { busy, error, submit } = useSubmit(async () => {
    const body = Object.fromEntries(Object.entries(v).map(([k, value]) => [k, value === '' ? null : value]));
    await api(`/cases/${c.id}/contravention`, { method: 'PATCH', body });
    onDone();
  });
  const max = todayIso();
  return (
    <FormDialog title={`PV seria ${cv.pvSeries} nr. ${cv.pvNumber}`} formId="contraventie" busy={busy} submitLabel="Salvează" onClose={onClose} onSubmit={submit} error={error} wide>
      <fieldset className="fieldset">
        <legend>Comunicarea</legend>
        <div className="form-grid">
          <Field label="Comunicat la" hint={`Termen: ${fmtDate(cv.communicationDue)}`}><input type="date" min={cv.appliedOn} max={max} value={v.communicatedOn} onChange={(e) => set('communicatedOn', e.target.value)} /></Field>
          <Field label="Mod"><select value={v.communicationMethod} onChange={(e) => set('communicationMethod', e.target.value)}>{Object.entries(COMMUNICATION_METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
      </fieldset>
      {cv.sanction === 'amenda' && (
        <fieldset className="fieldset">
          <legend>Plata</legend>
          <div className="form-grid">
            <Field label="Achitat la"><input type="date" min={cv.appliedOn} max={max} value={v.paidOn} onChange={(e) => set('paidOn', e.target.value)} /></Field>
            <Field label="Suma achitată (lei)" hint={cv.halfMinimum != null ? `Jumătate din minim: ${money(cv.halfMinimum)}` : undefined}><input inputMode="decimal" value={v.paidAmount} onChange={(e) => set('paidAmount', e.target.value)} /></Field>
          </div>
        </fieldset>
      )}
      <fieldset className="fieldset">
        <legend>Plângerea și hotărârea</legend>
        <div className="form-grid">
          <Field label="Plângere depusă la"><input type="date" min={cv.appliedOn} max={max} value={v.complaintFiledOn} onChange={(e) => set('complaintFiledOn', e.target.value)} /></Field>
          <Field label="Instanța"><input value={v.court} onChange={(e) => set('court', e.target.value)} /></Field>
          <Field label="Număr dosar"><input value={v.courtFile} onChange={(e) => set('courtFile', e.target.value)} /></Field>
          <Field label="Data hotărârii"><input type="date" max={max} value={v.decisionOn} onChange={(e) => set('decisionOn', e.target.value)} /></Field>
          <Field label="Soluția instanței">
            <select value={v.decisionOutcome} onChange={(e) => set('decisionOutcome', e.target.value)}>
              <option value="">Nepronunțată</option>
              {Object.entries(DECISIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
      </fieldset>
      {cv.sanction === 'amenda' && (
        <fieldset className="fieldset">
          <legend>Executarea</legend>
          <div className="form-grid">
            <Field label="Trimis spre executare la"><input type="date" min={cv.appliedOn} max={max} value={v.executionSentOn} onChange={(e) => set('executionSentOn', e.target.value)} /></Field>
            <Field label="Organul de executare" hint="De exemplu, direcția de taxe și impozite locale."><input value={v.executionBody} onChange={(e) => set('executionBody', e.target.value)} /></Field>
          </div>
        </fieldset>
      )}
      <p className="hint">Hotărârea și plângerea se adaugă în dosar ca documente înregistrate, din „Adaugă document”.</p>
    </FormDialog>
  );
}

