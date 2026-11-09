import { Badge } from '../../components/Ui';
import { plural } from '../../format';
import type { Tone } from '../../labels';

export type CaseKind = 'petitie' | 'informatii_publice' | 'contraventie' | 'control';

export const CASE_KINDS: Record<CaseKind, { label: string; plural: string; short: string }> = {
  petitie: { label: 'Petiție', plural: 'Petiții', short: 'Petiție (OG 27/2002)' },
  informatii_publice: { label: 'Cerere de informații publice', plural: 'Cereri Legea 544', short: 'Cerere Legea 544/2001' },
  contraventie: { label: 'Dosar contravențional', plural: 'Contravenții', short: 'Proces-verbal (OG 2/2001)' },
  control: { label: 'Acțiune de control', plural: 'Controale', short: 'Acțiune de control' },
};
export const kindLabel = (kind: string) => CASE_KINDS[kind as CaseKind]?.label ?? kind;

export const OUTCOME_LABELS: Record<string, string> = {
  favorabil: 'Soluționată favorabil', nefavorabil: 'Soluționată nefavorabil', partial: 'Parțial favorabil', redirectionata: 'Redirecționată',
  clasata: 'Clasată', conexata: 'Conexată', comunicat: 'Informații comunicate', refuz: 'Refuz motivat', inexistenta: 'Informații inexistente',
  achitat: 'Amenda achitată', executare: 'Trimis spre executare', anulat_instanta: 'PV anulat de instanță', avertisment: 'Avertisment',
  prescris: 'Executare prescrisă', fara_deficiente: 'Fără deficiențe', masuri_dispuse: 'Măsuri dispuse', sanctiuni_aplicate: 'Sancțiuni aplicate',
};

export const CHANNELS: Record<string, string> = {
  scris: 'Scris, la registratură', email: 'Email', posta: 'Poștă', telefon: 'Telefon', audienta: 'Audiență', verbal: 'Verbal', oficiu: 'Din oficiu',
};
export const ROLE_LABELS: Record<string, string> = {
  principal: 'Document principal', raspuns: 'Răspuns', adresa: 'Adresă', proces_verbal: 'Proces-verbal', plangere: 'Plângere',
  hotarare: 'Hotărâre', dovada: 'Dovadă', anexa: 'Anexă', alt: 'Alt document',
};
export const DISPATCH_METHODS: Record<string, string> = {
  posta: 'Poștă', posta_recomandata: 'Poștă recomandată cu confirmare', email: 'Email', curier: 'Curier', inmanare: 'Înmânare', fax: 'Fax', afisare: 'Afișare',
};
export const COMMUNICATION_METHODS: Record<string, string> = { inmanare: 'Înmânare la constatare', posta: 'Poștă cu confirmare', afisare: 'Afișare la domiciliu' };
export const DECISIONS: Record<string, string> = {
  plangere_respinsa: 'Plângere respinsă', plangere_admisa: 'Plângere admisă, PV anulat', admisa_partial: 'Admisă parțial, amendă redusă',
  inlocuire_avertisment: 'Amenda înlocuită cu avertisment',
};
export const EVENT_LABELS: Record<string, string> = {
  inregistrare: 'Înregistrare', modificare: 'Date modificate', repartizare: 'Repartizare', prelungire: 'Termen prelungit', inchidere: 'Închidere',
  redeschidere: 'Redeschidere', nota: 'Notă', obiect_adaugat: 'Obiect adăugat', obiect_solutionat: 'Obiect soluționat', obiect_modificat: 'Obiect modificat',
  document_adaugat: 'Document adăugat', document_generat: 'Document generat', fotografie: 'Fotografie', contraventie: 'Dosar contravențional',
  expediere: 'Expediere', confirmare_primire: 'Confirmare de primire', notificare_termen: 'Notificare: termen apropiat', escaladare: 'Escaladare: termen depășit',
};

export interface CaseRow {
  id: number;
  kind: CaseKind;
  regLabel: string;
  subject: string;
  applicantName: string | null;
  anonymous: boolean;
  location: string | null;
  receivedOn: string;
  status: 'deschisa' | 'inchisa';
  outcome: string | null;
  departmentId: number;
  departmentName: string;
  assigneeId: number | null;
  assigneeName: string | null;
  dueOn: string | null;
  daysLeft: number | null;
  overdue: boolean;
  extensionDays: number;
  closedAt: string | null;
  parentId: number | null;
  pvLabel: string | null;
  offenderName: string | null;
  readyForExecution: boolean;
}

export function CaseStatus({ row }: { row: Pick<CaseRow, 'status' | 'outcome'> }) {
  if (row.status === 'deschisa') return <Badge tone="info">Deschisă</Badge>;
  const tone: Tone = ['clasata', 'conexata', 'redirectionata'].includes(row.outcome ?? '') ? 'neutral' : row.outcome === 'refuz' || row.outcome === 'nefavorabil' ? 'warning' : 'success';
  return <Badge tone={tone}>{OUTCOME_LABELS[row.outcome ?? ''] ?? 'Închisă'}</Badge>;
}

export function CaseDeadline({ row }: { row: Pick<CaseRow, 'status' | 'overdue' | 'daysLeft' | 'dueOn' | 'readyForExecution'> }) {
  if (row.status !== 'deschisa') return null;
  if (row.readyForExecution) return <Badge tone="warning">De trimis spre executare</Badge>;
  if (row.dueOn == null || row.daysLeft == null) return null;
  if (row.overdue) return <Badge tone="danger">Depășit cu {plural(-row.daysLeft, 'zi', 'zile')}</Badge>;
  if (row.daysLeft === 0) return <Badge tone="warning">Expiră azi</Badge>;
  if (row.daysLeft <= 3) return <Badge tone="warning">Mai are {plural(row.daysLeft, 'zi', 'zile')}</Badge>;
  return <Badge tone="neutral">Mai are {plural(row.daysLeft, 'zi', 'zile')}</Badge>;
}

export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date());
