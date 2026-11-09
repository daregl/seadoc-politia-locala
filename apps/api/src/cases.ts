import { Body, Controller, Get, HttpCode, Injectable, Logger, OnModuleDestroy, Param, Patch, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import crypto from 'node:crypto';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import { config } from './config.js';
import { Db, Queryable } from './db.js';
import { detectMime, DocumentsService, UploadFile } from './documents.js';
import { badRequest, conflict, csvCell, forbidden, notFound, optInt, optText, toInt } from './http.js';
import { NotificationService } from './notifications.js';
import { fillTemplate, Letterhead, renderLetter, templateFields } from './pdf-render.js';
import { can, CurrentUser, visibleSql } from './perms.js';
import { StorageService } from './storage.js';

export const CASE_KINDS = ['petitie', 'informatii_publice', 'contraventie', 'control'] as const;
type CaseKind = typeof CASE_KINDS[number];

const PREFIX: Record<CaseKind, string> = { petitie: 'P', informatii_publice: 'I', contraventie: 'DC', control: 'AC' };
const KIND_LABEL: Record<CaseKind, string> = {
  petitie: 'Petiție', informatii_publice: 'Cerere Legea 544/2001', contraventie: 'Dosar contravențional', control: 'Acțiune de control',
};
/** Termenul legal, în zile calendaristice de la înregistrare. */
const BASE_DAYS: Record<CaseKind, number | null> = { petitie: 30, informatii_publice: 10, contraventie: null, control: null };

export const OUTCOMES: Record<CaseKind, Record<string, string>> = {
  petitie: {
    favorabil: 'Soluționată favorabil', nefavorabil: 'Soluționată nefavorabil', partial: 'Soluționată parțial favorabil',
    redirectionata: 'Redirecționată', clasata: 'Clasată', conexata: 'Conexată',
  },
  informatii_publice: {
    comunicat: 'Informații comunicate', partial: 'Comunicate parțial', refuz: 'Refuz motivat',
    redirectionata: 'Redirecționată', inexistenta: 'Informații inexistente',
  },
  contraventie: {
    achitat: 'Amenda achitată', executare: 'Trimis spre executare', anulat_instanta: 'PV anulat de instanță',
    avertisment: 'Avertisment, fără alte măsuri', prescris: 'Executarea prescrisă',
  },
  control: { fara_deficiente: 'Fără deficiențe', masuri_dispuse: 'Măsuri dispuse', sanctiuni_aplicate: 'Sancțiuni aplicate' },
};
const ROLES = ['principal', 'raspuns', 'adresa', 'proces_verbal', 'plangere', 'hotarare', 'dovada', 'anexa', 'alt'];
const DISPATCH_METHODS = ['posta', 'posta_recomandata', 'email', 'curier', 'inmanare', 'fax', 'afisare'];
const COMMUNICATION_METHODS = ['inmanare', 'posta', 'afisare'];
const DECISIONS = ['plangere_respinsa', 'plangere_admisa', 'admisa_partial', 'inlocuire_avertisment'];
const PHOTO_MIME = new Set(['image/jpeg', 'image/png']);
const REMIND_DAYS = 3;

const TODAY = `(now() AT TIME ZONE 'Europe/Bucharest')::date`;
/** Termenul instituției: soluționarea, sau comunicarea procesului-verbal (2 luni de la aplicare). */
const DUE = `(CASE
  WHEN c.manual_due_on IS NOT NULL THEN c.manual_due_on
  WHEN c.kind = 'contraventie' THEN CASE WHEN cv.communicated_on IS NULL THEN (cv.applied_on + interval '2 months')::date END
  WHEN c.base_days IS NULL THEN NULL
  ELSE c.received_on + c.base_days + c.extension_days END)`;
/** Amenda neachitată, necontestată în 15 zile de la comunicare sau cu plângerea respinsă. */
const READY_EXEC = `(cv.case_id IS NOT NULL AND c.status = 'deschisa' AND cv.sanction = 'amenda' AND cv.paid_on IS NULL AND cv.execution_sent_on IS NULL
  AND ((cv.complaint_filed_on IS NULL AND cv.communicated_on IS NOT NULL AND cv.communicated_on + 15 < ${TODAY})
       OR cv.decision_outcome IN ('plangere_respinsa','admisa_partial')))`;

const LIST_COLUMNS = `c.id, c.kind, c.reg_label AS "regLabel", c.subject, c.applicant_name AS "applicantName", c.anonymous, c.location,
  c.received_on::text AS "receivedOn", c.status, c.outcome, c.department_id AS "departmentId", dep.name AS "departmentName",
  c.assignee_id AS "assigneeId", a.full_name AS "assigneeName", ${DUE}::text AS "dueOn", (${DUE} - ${TODAY}) AS "daysLeft",
  (c.status = 'deschisa' AND ${DUE} < ${TODAY}) AS overdue, c.extension_days AS "extensionDays", c.closed_at AS "closedAt", c.parent_id AS "parentId",
  CASE WHEN cv.case_id IS NOT NULL THEN cv.pv_series || ' ' || cv.pv_number END AS "pvLabel", cv.offender_name AS "offenderName",
  ${READY_EXEC} AS "readyForExecution"`;
const LIST_FROM = `FROM cases c JOIN departments dep ON dep.id = c.department_id LEFT JOIN users a ON a.id = c.assignee_id
  LEFT JOIN case_contraventions cv ON cv.case_id = c.id`;

const like = (text: string) => `%${text.replace(/[%_\\]/g, '\\$&')}%`;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
function optDate(value: unknown, field: string): string | null {
  const text = optText(value);
  if (text == null) return null;
  if (!isDate(text)) badRequest(`Dată invalidă: ${field}`);
  return text;
}
function optAmount(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) badRequest(`Sumă invalidă: ${field}`);
  return Math.round(n * 100) / 100;
}
function required(value: unknown, field: string): string {
  const text = optText(value);
  if (!text) badRequest(`Câmp obligatoriu: ${field}`);
  return text as string;
}
const checkKind = (value: unknown): CaseKind => {
  if (!CASE_KINDS.includes(value as CaseKind)) badRequest('Tip de lucrare invalid');
  return value as CaseKind;
};
export const roDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '');
const roDateTime = (value: Date | string | null | undefined) =>
  value ? new Date(value).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'short', timeStyle: 'short' }) : '';
const money = (n: number | string | null | undefined) => (n == null ? '' : Number(n).toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const addMonths = (iso: string, months: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date());

/** Cine vede lucrarea: registratura și administratorul pe toate, șeful pe ale serviciului, ceilalți pe ale lor. */
/** Compartimentul și toate compartimentele subordonate lui, după organigramă (UNION oprește un eventual ciclu). */
const deptTree = (param: string) =>
  `(WITH RECURSIVE t AS (SELECT id FROM departments WHERE id = ${param} UNION SELECT d.id FROM departments d JOIN t ON d.parent_id = t.id) SELECT id FROM t)`;

export function caseVisibleSql(user: CurrentUser, params: unknown[], alias = 'c'): string {
  if (can(user, 'cases_all')) return 'TRUE';
  params.push(user.id);
  const uid = `$${params.length}`;
  const parts = [
    `${alias}.created_by = ${uid}`,
    `${alias}.assignee_id = ${uid}`,
    `EXISTS (SELECT 1 FROM case_objects o WHERE o.case_id = ${alias}.id AND o.assignee_id = ${uid})`,
    `EXISTS (SELECT 1 FROM departments md WHERE md.id = ${alias}.department_id AND md.manager_id = ${uid})`,
  ];
  if (user.role === 'manager' && user.departmentId != null) {
    params.push(user.departmentId);
    // Șeful vede și compartimentele subordonate; conducerea, toată instituția.
    const tree = deptTree(`$${params.length}`);
    parts.push(`${alias}.department_id IN ${tree}`);
    parts.push(`EXISTS (SELECT 1 FROM case_objects o WHERE o.case_id = ${alias}.id AND o.department_id IN ${tree})`);
  }
  return `(${parts.join(' OR ')})`;
}

@Injectable()
export class CasesService implements OnModuleDestroy {
  private readonly log = new Logger('Lucrari');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    private readonly docs: DocumentsService,
  ) {}

  // Acces -----------------------------------------------------------------------

  async requireCase(user: CurrentUser, id: number, client: Queryable = this.db, lock = false) {
    const params: unknown[] = [id];
    const visible = caseVisibleSql(user, params);
    // Datele calendaristice se citesc ca text: un Date JavaScript le-ar muta după fusul orar al serverului.
    const row = (await client.query(
      `SELECT c.*, c.received_on::text AS received_on, c.manual_due_on::text AS manual_due_on
       FROM cases c WHERE c.id = $1 AND ${visible}${lock ? ' FOR UPDATE OF c' : ''}`, params)).rows[0];
    if (!row) notFound('Lucrarea nu există sau nu aveți acces');
    return row;
  }

  private async canEdit(user: CurrentUser, row: any): Promise<boolean> {
    if (can(user, 'cases_all') || row.created_by === user.id || row.assignee_id === user.id) return true;
    if (user.role === 'manager' && user.departmentId != null && row.department_id != null
      && (await this.db.one(`SELECT 1 AS x WHERE $1::int IN ${deptTree('$2::int')}`, [row.department_id, user.departmentId]))) return true;
    const manager = await this.db.one('SELECT 1 AS x FROM departments WHERE id = $1 AND manager_id = $2', [row.department_id, user.id]);
    if (manager) return true;
    return !!(await this.db.one('SELECT 1 AS x FROM case_objects WHERE case_id = $1 AND assignee_id = $2', [row.id, user.id]));
  }

  private async requireEditable(user: CurrentUser, id: number, client: Queryable, opts: { open?: boolean } = { open: true }) {
    const row = await this.requireCase(user, id, client, true);
    if (!(await this.canEdit(user, row))) forbidden('Nu puteți modifica această lucrare');
    if (opts.open !== false && row.status !== 'deschisa') conflict('Lucrarea este închisă; redeschideți-o întâi');
    return row;
  }

  private async event(c: Queryable, caseId: number, user: CurrentUser | null, kind: string, note: string | null = null, data: Record<string, unknown> = {}) {
    await c.query('INSERT INTO case_events (case_id, user_id, kind, note, data) VALUES ($1,$2,$3,$4,$5)', [caseId, user?.id ?? null, kind, note, JSON.stringify(data)]);
  }

  private async checkedUser(c: Queryable, value: unknown, field: string): Promise<number | null> {
    const id = optInt(value, field);
    if (id == null) return null;
    const ok = await c.query('SELECT 1 FROM users WHERE id = $1 AND active', [id]);
    if (!ok.rowCount) badRequest(`Utilizator inexistent sau inactiv: ${field}`);
    return id;
  }

  private async checkedDepartment(c: Queryable, value: unknown): Promise<number | null> {
    const id = optInt(value, 'compartiment');
    if (id == null) return null;
    const ok = await c.query('SELECT 1 FROM departments WHERE id = $1', [id]);
    if (!ok.rowCount) badRequest('Compartiment inexistent');
    return id;
  }

  private async nextNumber(c: Queryable, kind: CaseKind) {
    const row = (await c.query(
      `INSERT INTO case_counters (kind, year, last_number) VALUES ($1, extract(year FROM now() AT TIME ZONE 'Europe/Bucharest')::int, 1)
       ON CONFLICT (kind, year) DO UPDATE SET last_number = case_counters.last_number + 1 RETURNING year, last_number`, [kind])).rows[0];
    return { year: row.year as number, number: row.last_number as number, label: `${PREFIX[kind]}-${String(row.last_number).padStart(5, '0')}/${row.year}` };
  }

  // Listă și detaliu -------------------------------------------------------------

  async list(user: CurrentUser, q: Record<string, string | undefined>) {
    const params: unknown[] = [];
    const where = [caseVisibleSql(user, params)];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
    if (optText(q.kind)) add('c.kind = ?', checkKind(q.kind));
    if (optText(q.status)) add('c.status = ?', q.status === 'inchisa' ? 'inchisa' : 'deschisa');
    if (q.overdue === '1') where.push(`c.status = 'deschisa' AND ${DUE} < ${TODAY}`);
    if (q.readyForExecution === '1') where.push(READY_EXEC);
    if (q.mine === '1') add('(c.assignee_id = ? OR EXISTS (SELECT 1 FROM case_objects o WHERE o.case_id = c.id AND o.assignee_id = ?))', user.id);
    if (optInt(q.departmentId) != null) add('c.department_id = ?', optInt(q.departmentId));
    if (optInt(q.assigneeId) != null) add('c.assignee_id = ?', optInt(q.assigneeId));
    if (optText(q.from)) add('c.received_on >= ?::date', optDate(q.from, 'de la'));
    if (optText(q.to)) add('c.received_on <= ?::date', optDate(q.to, 'până la'));
    const text = optText(q.q);
    if (text) {
      add(`(c.reg_label ILIKE ? OR unaccent(c.subject) ILIKE unaccent(?) OR unaccent(coalesce(c.applicant_name,'')) ILIKE unaccent(?)
            OR unaccent(coalesce(c.location,'')) ILIKE unaccent(?) OR unaccent(coalesce(cv.offender_name,'')) ILIKE unaccent(?)
            OR (cv.pv_series || ' ' || cv.pv_number) ILIKE ? OR cv.pv_number ILIKE ?)`, like(text));
    }
    const limit = Math.min(Math.max(optInt(q.limit) ?? 25, 1), 200);
    const offset = Math.max(optInt(q.offset) ?? 0, 0);
    const clause = where.join(' AND ');
    const total = (await this.db.one(`SELECT count(*)::int AS n ${LIST_FROM} WHERE ${clause}`, params)).n;
    const overdue = (await this.db.one(`SELECT count(*)::int AS n ${LIST_FROM} WHERE ${clause} AND c.status = 'deschisa' AND ${DUE} < ${TODAY}`, params)).n;
    params.push(limit, offset);
    const items = (await this.db.query(
      `SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE ${clause}
       ORDER BY c.status = 'inchisa', (c.status = 'deschisa' AND ${DUE} < ${TODAY}) DESC, ${DUE} NULLS LAST, c.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    if (text) await this.audit.log(user, { action: 'lucrare.cautare', details: { rezultate: total } });
    return { total, overdue, items };
  }

  private async fetchRow(client: Queryable, id: number) {
    return (await client.query(`SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE c.id = $1`, [id])).rows[0];
  }

  async detail(user: CurrentUser, id: number) {
    const row = await this.requireCase(user, id);
    const base = await this.fetchRow(this.db, id);
    const extra = await this.db.one(
      `SELECT c.applicant_address AS "applicantAddress", c.applicant_email AS "applicantEmail", c.applicant_phone AS "applicantPhone",
              c.channel, c.base_days AS "baseDays", c.extension_reason AS "extensionReason", c.manual_due_on::text AS "manualDueOn",
              c.resolution_note AS "resolutionNote", c.redirected_to AS "redirectedTo", c.answer_communicated_on::text AS "answerCommunicatedOn",
              c.details, cu.full_name AS "createdByName", c.created_at AS "createdAt", p.reg_label AS "parentLabel", p.kind AS "parentKind"
       FROM cases c JOIN users cu ON cu.id = c.created_by LEFT JOIN cases p ON p.id = c.parent_id WHERE c.id = $1`, [id]);
    const children = (await this.db.query(
      `SELECT c.id, c.kind, c.reg_label AS "regLabel", c.subject, c.status, c.outcome FROM cases c WHERE c.parent_id = $1 ORDER BY c.id`, [id])).rows;
    const objects = (await this.db.query(
      `SELECT o.id, o.text, o.department_id AS "departmentId", d.name AS "departmentName", o.assignee_id AS "assigneeId", u.full_name AS "assigneeName",
              o.status, o.answer, o.solved_at AS "solvedAt"
       FROM case_objects o LEFT JOIN departments d ON d.id = o.department_id LEFT JOIN users u ON u.id = o.assignee_id WHERE o.case_id = $1 ORDER BY o.id`, [id])).rows;
    const docParams: unknown[] = [id];
    const docVisible = visibleSql(user, docParams);
    const documents = (await this.db.query(
      `SELECT cd.role, d.id, CASE WHEN ${docVisible} THEN d.title END AS title, d.reg_label AS "regLabel", d.status, ${docVisible} AS visible,
              cd.added_at AS "addedAt", u.full_name AS "addedBy"
       FROM case_documents cd JOIN documents d ON d.id = cd.document_id JOIN users u ON u.id = cd.added_by
       WHERE cd.case_id = $1 ORDER BY cd.added_at, d.id`, docParams)).rows;
    const events = (await this.db.query(
      `SELECT e.id, e.at, e.kind, e.note, e.data, u.full_name AS "userName" FROM case_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.case_id = $1 ORDER BY e.id`, [id])).rows;
    const photos = (await this.db.query(
      `SELECT p.id, p.filename, p.mime, p.size_bytes::int AS "sizeBytes", p.sha256, p.latitude, p.longitude, p.note, p.created_at AS "createdAt", u.full_name AS "createdBy"
       FROM case_photos p JOIN users u ON u.id = p.created_by WHERE p.case_id = $1 ORDER BY p.id`, [id])).rows;
    const dispatches = await this.dispatchesFor('case_id', id);
    const cv = await this.db.one(
      `SELECT cv.*, cv.applied_on::text AS applied_on, cv.communicated_on::text AS communicated_on, cv.paid_on::text AS paid_on,
              cv.complaint_filed_on::text AS complaint_filed_on, cv.decision_on::text AS decision_on, cv.execution_sent_on::text AS execution_sent_on,
              ag.full_name AS agent_name
       FROM case_contraventions cv LEFT JOIN users ag ON ag.id = cv.agent_id WHERE cv.case_id = $1`, [id]);
    const templates = (await this.db.query(
      `SELECT id, code, name, case_role AS "caseRole", document_type_id AS "documentTypeId", register_id AS "registerId"
       FROM document_templates WHERE active AND (case_kind = $1 OR case_kind IS NULL) ORDER BY id`, [row.kind])).rows;
    const canEdit = await this.canEdit(user, row);
    await this.audit.log(user, { action: 'lucrare.consultata', details: { lucrare: id, numar: row.reg_label } });
    return {
      ...base, ...extra, children, objects, documents, events, photos, dispatches, templates,
      contravention: cv ? this.contraventionView(cv) : null,
      deadlines: this.deadlines(row, cv, base.dueOn),
      outcomes: OUTCOMES[row.kind as CaseKind],
      canEdit,
      canExtend: canEdit && row.status === 'deschisa' && this.extensionProblem(row) == null,
      extensionHint: this.extensionProblem(row),
    };
  }

  private contraventionView(cv: any) {
    const halfMin = cv.min_amount != null ? Number(cv.min_amount) / 2 : null;
    const payDue = cv.communicated_on ? addDays(cv.communicated_on, 15) : null;
    const today = todayIso();
    const ready = cv.sanction === 'amenda' && !cv.paid_on && !cv.execution_sent_on
      && ((!cv.complaint_filed_on && payDue != null && payDue < today) || ['plangere_respinsa', 'admisa_partial'].includes(cv.decision_outcome));
    return {
      pvSeries: cv.pv_series, pvNumber: cv.pv_number, offenderName: cv.offender_name, offenderIdCode: cv.offender_id_code, offenderAddress: cv.offender_address,
      fact: cv.fact, legalBasis: cv.legal_basis, sanction: cv.sanction, amount: cv.amount == null ? null : Number(cv.amount),
      minAmount: cv.min_amount == null ? null : Number(cv.min_amount), halfMinimum: halfMin,
      agentId: cv.agent_id, agentName: cv.agent_name, observedAt: cv.observed_at, appliedOn: cv.applied_on,
      communicationDue: addMonths(cv.applied_on, 2), communicatedOn: cv.communicated_on, communicationMethod: cv.communication_method,
      payHalfDue: payDue, complaintDue: payDue, paidOn: cv.paid_on, paidAmount: cv.paid_amount == null ? null : Number(cv.paid_amount),
      complaintFiledOn: cv.complaint_filed_on, court: cv.court, courtFile: cv.court_file, decisionOn: cv.decision_on, decisionOutcome: cv.decision_outcome,
      executionSentOn: cv.execution_sent_on, executionBody: cv.execution_body, readyForExecution: ready,
    };
  }

  /** Termenele afișate pe fișă; `met` spune dacă s-a încadrat (null = încă deschis). */
  private deadlines(row: any, cv: any, dueOn: string | null) {
    const received: string = row.received_on;
    const closed = row.closed_at ? new Date(row.closed_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' }) : null;
    const out: { key: string; label: string; date: string; met: boolean | null }[] = [];
    const met = (date: string, doneOn: string | null) => (doneOn ? doneOn <= date : null);
    if (row.kind === 'petitie') {
      out.push({ key: 'solutionare', label: row.extension_days ? `Soluționare (30 + ${row.extension_days} zile)` : 'Soluționare (30 de zile)', date: dueOn!, met: met(dueOn!, closed) });
      if (row.status === 'deschisa' || row.outcome === 'redirectionata') {
        out.push({ key: 'redirectionare', label: 'Redirecționare, dacă nu e de competența instituției (5 zile)', date: addDays(received, 5), met: row.outcome === 'redirectionata' ? met(addDays(received, 5), closed) : null });
      }
    }
    if (row.kind === 'informatii_publice') {
      out.push({ key: 'raspuns', label: row.extension_days ? 'Răspuns, termen prelungit (30 de zile)' : 'Răspuns (10 zile)', date: dueOn!, met: met(dueOn!, closed) });
      if (row.status === 'deschisa' || row.outcome === 'refuz') out.push({ key: 'refuz', label: 'Refuz motivat (5 zile)', date: addDays(received, 5), met: row.outcome === 'refuz' ? met(addDays(received, 5), closed) : null });
    }
    if (row.kind === 'contraventie' && cv) {
      out.push({ key: 'comunicare', label: 'Comunicarea procesului-verbal (2 luni)', date: addMonths(cv.applied_on, 2), met: cv.communicated_on ? cv.communicated_on <= addMonths(cv.applied_on, 2) : null });
      if (cv.communicated_on) out.push({ key: 'plata', label: 'Plata a jumătate din minim și plângerea (15 zile de la comunicare)', date: addDays(cv.communicated_on, 15), met: null });
    }
    if (row.kind === 'control' && row.manual_due_on) {
      const due: string = row.manual_due_on;
      out.push({ key: 'finalizare', label: 'Finalizarea controlului', date: due, met: met(due, closed) });
    }
    return out;
  }

  private extensionProblem(row: any): string | null {
    if (row.kind === 'petitie') return row.extension_days > 0 ? 'Termenul a fost deja prelungit' : null;
    if (row.kind === 'informatii_publice') {
      if (row.extension_days > 0) return 'Termenul a fost deja prelungit la 30 de zile';
      const received: string = row.received_on;
      if (addDays(received, 10) < todayIso()) return 'Prelungirea se comunică în primele 10 zile; termenul a trecut';
      return null;
    }
    return 'Termenul acestui tip de lucrare nu se prelungește';
  }

  // Înregistrare ----------------------------------------------------------------

  async create(user: CurrentUser, body: Record<string, any>) {
    const kind = checkKind(body.kind);
    if ((kind === 'petitie' || kind === 'informatii_publice') && !can(user, 'register') && !can(user, 'cases_all')) {
      forbidden('Petițiile și cererile de informații se înregistrează la registratură');
    }
    const anonymous = body.anonymous === true;
    const applicantName = optText(body.applicantName);
    if ((kind === 'informatii_publice' || (kind === 'petitie' && !anonymous)) && !applicantName) badRequest('Câmp obligatoriu: numele petentului');
    const receivedOn = optDate(body.receivedOn, 'data înregistrării') ?? todayIso();
    if (receivedOn > todayIso()) badRequest('Data înregistrării nu poate fi în viitor');
    const location = optText(body.location);
    if (kind === 'control' && !location) badRequest('Câmp obligatoriu: obiectivul sau adresa controlului');
    const manualDueOn = kind === 'control' ? optDate(body.manualDueOn, 'termen') : null;
    const cv = kind === 'contraventie' ? this.parseContravention(body.contravention ?? {}, receivedOn) : null;
    const subject = optText(body.subject) ?? (cv ? `${cv.fact.slice(0, 120)}` : null);
    if (!subject) badRequest('Câmp obligatoriu: obiectul');
    const objects: { text: string; departmentId?: unknown; assigneeId?: unknown }[] = Array.isArray(body.objects)
      ? body.objects.map((o: unknown) => (typeof o === 'string' ? { text: o } : (o as any))).filter((o: any) => optText(o?.text))
      : [];
    const details = typeof body.details === 'object' && body.details ? body.details : {};

    return this.db.tx(async (c) => {
      const departmentId = (await this.checkedDepartment(c, body.departmentId)) ?? user.departmentId;
      if (departmentId == null) badRequest('Câmp obligatoriu: compartimentul');
      const assigneeId = (await this.checkedUser(c, body.assigneeId, 'responsabil')) ?? (kind === 'contraventie' || kind === 'control' ? user.id : null);
      const documentId = optInt(body.documentId, 'document');
      if (documentId != null) await this.docs.requireVisible(user, documentId);
      const parentId = optInt(body.parentId, 'lucrare părinte');
      if (parentId != null) await this.requireCase(user, parentId, c);
      const n = await this.nextNumber(c, kind);
      const id = (await c.query(
        `INSERT INTO cases (kind, reg_year, reg_number, reg_label, subject, applicant_name, applicant_address, applicant_email, applicant_phone, anonymous,
           channel, location, received_on, base_days, manual_due_on, department_id, assignee_id, parent_id, details, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [kind, n.year, n.number, n.label, subject, anonymous ? null : applicantName, optText(body.applicantAddress), optText(body.applicantEmail),
          optText(body.applicantPhone), anonymous, optText(body.channel), location, receivedOn, BASE_DAYS[kind], manualDueOn, departmentId, assigneeId,
          parentId, JSON.stringify(details), user.id])).rows[0].id;
      for (const o of objects) {
        await c.query('INSERT INTO case_objects (case_id, text, department_id, assignee_id) VALUES ($1,$2,$3,$4)',
          [id, optText(o.text), await this.checkedDepartment(c, o.departmentId), await this.checkedUser(c, o.assigneeId, 'responsabil obiect')]);
      }
      if (documentId != null) await c.query('INSERT INTO case_documents (case_id, document_id, role, added_by) VALUES ($1,$2,$3,$4)', [id, documentId, 'principal', user.id]);
      if (cv) {
        const agentId = (await this.checkedUser(c, cv.agentId, 'agent constatator')) ?? user.id;
        await c.query(
          `INSERT INTO case_contraventions (case_id, pv_series, pv_number, offender_name, offender_id_code, offender_address, fact, legal_basis, sanction,
             amount, min_amount, agent_id, observed_at, applied_on, communicated_on, communication_method)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, cv.pvSeries, cv.pvNumber, cv.offenderName, cv.offenderIdCode, cv.offenderAddress, cv.fact, cv.legalBasis, cv.sanction,
            cv.amount, cv.minAmount, agentId, cv.observedAt, cv.appliedOn, cv.communicatedOn, cv.communicationMethod]);
      }
      await this.event(c, id, user, 'inregistrare', null, { numar: n.label, tip: kind, obiecte: objects.length, document: documentId });
      await this.audit.log(user, { action: 'lucrare.inregistrata', documentId, details: { lucrare: id, numar: n.label, tip: kind } }, c);
      if (assigneeId != null && assigneeId !== user.id) {
        await this.notifications.send(assigneeId, 'lucrare_repartizata', `Vi s-a repartizat ${KIND_LABEL[kind].toLowerCase()} ${n.label}`, { link: `/lucrari/${id}` }, c);
      }
      return this.fetchRow(c, id);
    });
  }

  private parseContravention(raw: Record<string, unknown>, receivedOn: string) {
    const sanction = String(raw.sanction ?? 'amenda');
    if (!['amenda', 'avertisment'].includes(sanction)) badRequest('Sancțiune invalidă');
    const amount = optAmount(raw.amount, 'amendă');
    if (sanction === 'amenda' && amount == null) badRequest('Câmp obligatoriu: cuantumul amenzii');
    const appliedOn = optDate(raw.appliedOn, 'data aplicării') ?? receivedOn;
    if (appliedOn > todayIso()) badRequest('Data aplicării nu poate fi în viitor');
    const observedAt = optText(raw.observedAt);
    if (observedAt && Number.isNaN(Date.parse(observedAt))) badRequest('Data constatării este invalidă');
    const communicationMethod = optText(raw.communicationMethod);
    if (communicationMethod && !COMMUNICATION_METHODS.includes(communicationMethod)) badRequest('Mod de comunicare invalid');
    const communicatedOn = optDate(raw.communicatedOn, 'data comunicării');
    if (communicatedOn && communicatedOn < appliedOn) badRequest('Comunicarea nu poate fi înaintea aplicării');
    return {
      pvSeries: required(raw.pvSeries, 'seria procesului-verbal').toUpperCase(),
      pvNumber: required(raw.pvNumber, 'numărul procesului-verbal'),
      offenderName: required(raw.offenderName, 'contravenientul'),
      offenderIdCode: optText(raw.offenderIdCode),
      offenderAddress: optText(raw.offenderAddress),
      fact: required(raw.fact, 'descrierea faptei'),
      legalBasis: required(raw.legalBasis, 'temeiul legal'),
      sanction, amount: sanction === 'amenda' ? amount : null,
      minAmount: sanction === 'amenda' ? optAmount(raw.minAmount, 'minimul amenzii') : null,
      agentId: raw.agentId, observedAt, appliedOn,
      communicatedOn, communicationMethod: communicatedOn ? communicationMethod ?? 'inmanare' : null,
    };
  }

  // Modificări -------------------------------------------------------------------

  async update(user: CurrentUser, id: number, body: Record<string, any>) {
    const has = (k: string) => Object.hasOwn(body, k);
    return this.db.tx(async (c) => {
      const row = await this.requireEditable(user, id, c);
      const values: Record<string, unknown> = {};
      if (has('subject')) values.subject = required(body.subject, 'obiectul');
      if (has('applicantName')) values.applicant_name = optText(body.applicantName);
      if (has('applicantAddress')) values.applicant_address = optText(body.applicantAddress);
      if (has('applicantEmail')) values.applicant_email = optText(body.applicantEmail);
      if (has('applicantPhone')) values.applicant_phone = optText(body.applicantPhone);
      if (has('channel')) values.channel = optText(body.channel);
      if (has('location')) values.location = optText(body.location);
      if (has('manualDueOn')) {
        if (row.kind !== 'control') badRequest('Termenul acestei lucrări este cel legal');
        values.manual_due_on = optDate(body.manualDueOn, 'termen');
      }
      if (has('details')) {
        if (typeof body.details !== 'object' || !body.details) badRequest('Detalii invalide');
        values.details = JSON.stringify({ ...row.details, ...body.details });
      }
      const cols = Object.keys(values);
      if (!cols.length) return this.fetchRow(c, id);
      await c.query(`UPDATE cases SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...cols.map((k) => values[k])]);
      await this.event(c, id, user, 'modificare', null, { campuri: cols });
      await this.audit.log(user, { action: 'lucrare.modificata', details: { lucrare: id, campuri: cols } }, c);
      return this.fetchRow(c, id);
    });
  }

  /** Repartizarea, cu rezoluția scrisă de șef. */
  async assign(user: CurrentUser, id: number, body: { assigneeId?: unknown; departmentId?: unknown; note?: unknown }) {
    return this.db.tx(async (c) => {
      const row = await this.requireEditable(user, id, c);
      const assigneeId = await this.checkedUser(c, body.assigneeId, 'responsabil');
      const departmentId = (await this.checkedDepartment(c, body.departmentId)) ?? row.department_id;
      const note = optText(body.note);
      await c.query('UPDATE cases SET assignee_id = $2, department_id = $3 WHERE id = $1', [id, assigneeId, departmentId]);
      const names = await c.query('SELECT (SELECT full_name FROM users WHERE id = $1) AS a, (SELECT name FROM departments WHERE id = $2) AS d', [assigneeId, departmentId]);
      await this.event(c, id, user, 'repartizare', note, { responsabil: names.rows[0].a, compartiment: names.rows[0].d });
      await this.audit.log(user, { action: 'lucrare.repartizata', details: { lucrare: id, responsabil: assigneeId, compartiment: departmentId } }, c);
      if (assigneeId != null && assigneeId !== user.id) {
        await this.notifications.send(assigneeId, 'lucrare_repartizata', `Vi s-a repartizat lucrarea ${row.reg_label}${note ? `: ${note}` : ''}`, { link: `/lucrari/${id}` }, c);
      }
      return this.fetchRow(c, id);
    });
  }

  async extend(user: CurrentUser, id: number, body: { days?: unknown; reason?: unknown }) {
    return this.db.tx(async (c) => {
      const row = await this.requireEditable(user, id, c);
      const problem = this.extensionProblem(row);
      if (problem) conflict(problem);
      const reason = required(body.reason, 'motivul prelungirii');
      let days: number;
      if (row.kind === 'petitie') {
        days = toInt(body.days, 'zile');
        if (days < 1 || days > 15) badRequest('Termenul petiției se prelungește cu cel mult 15 zile');
      } else {
        days = 20; // de la 10 la 30 de zile
      }
      await c.query('UPDATE cases SET extension_days = $2, extension_reason = $3, reminded_at = NULL, escalated_at = NULL WHERE id = $1', [id, days, reason]);
      await this.event(c, id, user, 'prelungire', reason, { zile: days });
      await this.audit.log(user, { action: 'lucrare.termen_prelungit', details: { lucrare: id, zile: days } }, c);
      return this.fetchRow(c, id);
    });
  }

  async close(user: CurrentUser, id: number, body: { outcome?: unknown; note?: unknown; redirectedTo?: unknown; parentId?: unknown }) {
    return this.db.tx(async (c) => {
      const row = await this.requireEditable(user, id, c);
      const outcome = String(body.outcome ?? '');
      if (!Object.hasOwn(OUTCOMES[row.kind as CaseKind], outcome)) badRequest('Soluție invalidă pentru acest tip de lucrare');
      const note = required(body.note, 'soluția sau motivul');
      let redirectedTo: string | null = null;
      let parentId: number | null = row.parent_id;
      if (outcome === 'redirectionata') redirectedTo = required(body.redirectedTo, 'instituția competentă');
      if (outcome === 'conexata') {
        parentId = toInt(body.parentId, 'lucrarea la care se conexează');
        if (parentId === id) badRequest('O lucrare nu se poate conexa la ea însăși');
        const parent = await this.requireCase(user, parentId, c);
        if (parent.kind !== row.kind) badRequest('Se conexează doar lucrări de același tip');
        if (parent.parent_id === id) badRequest('Lucrările s-ar conexa una la alta');
      }
      if (['favorabil', 'nefavorabil', 'partial', 'comunicat'].includes(outcome)) {
        const open = (await c.query(`SELECT count(*)::int AS n FROM case_objects WHERE case_id = $1 AND status = 'deschis'`, [id])).rows[0].n;
        if (open > 0) conflict(`Mai sunt ${open} obiecte ale petiției fără răspuns`);
      }
      if (row.kind === 'contraventie' && outcome === 'achitat') {
        const cv = (await c.query('SELECT paid_on FROM case_contraventions WHERE case_id = $1', [id])).rows[0];
        if (!cv?.paid_on) conflict('Înregistrați întâi data plății');
      }
      if (row.kind === 'contraventie' && outcome === 'executare') {
        const cv = (await c.query('SELECT execution_sent_on FROM case_contraventions WHERE case_id = $1', [id])).rows[0];
        if (!cv?.execution_sent_on) conflict('Înregistrați întâi trimiterea spre executare');
      }
      await c.query(
        `UPDATE cases SET status = 'inchisa', outcome = $2, resolution_note = $3, redirected_to = $4, parent_id = $5, closed_at = now() WHERE id = $1`,
        [id, outcome, note, redirectedTo, parentId]);
      await this.event(c, id, user, 'inchidere', note, { solutie: outcome, redirectionataCatre: redirectedTo, conexataLa: outcome === 'conexata' ? parentId : undefined });
      await this.audit.log(user, { action: 'lucrare.inchisa', details: { lucrare: id, numar: row.reg_label, solutie: outcome } }, c);
      return this.fetchRow(c, id);
    });
  }

  async reopen(user: CurrentUser, id: number, body: { reason?: unknown }) {
    return this.db.tx(async (c) => {
      const row = await this.requireEditable(user, id, c, { open: false });
      if (row.status !== 'inchisa') conflict('Lucrarea este deja deschisă');
      const reason = required(body.reason, 'motivul redeschiderii');
      await c.query(`UPDATE cases SET status = 'deschisa', outcome = NULL, closed_at = NULL, reminded_at = NULL, escalated_at = NULL WHERE id = $1`, [id]);
      await this.event(c, id, user, 'redeschidere', reason, { solutieAnterioara: row.outcome });
      await this.audit.log(user, { action: 'lucrare.redeschisa', details: { lucrare: id, numar: row.reg_label, solutieAnterioara: row.outcome } }, c);
      return this.fetchRow(c, id);
    });
  }

  async addNote(user: CurrentUser, id: number, body: { note?: unknown }) {
    return this.db.tx(async (c) => {
      await this.requireEditable(user, id, c, { open: false });
      const note = required(body.note, 'nota');
      await this.event(c, id, user, 'nota', note);
      return { ok: true };
    });
  }

  // Obiecte multiple --------------------------------------------------------------

  async addObject(user: CurrentUser, id: number, body: { text?: unknown; departmentId?: unknown; assigneeId?: unknown }) {
    return this.db.tx(async (c) => {
      const row = await this.requireEditable(user, id, c);
      if (row.kind !== 'petitie' && row.kind !== 'informatii_publice') badRequest('Doar petițiile și cererile au obiecte multiple');
      const text = required(body.text, 'obiectul');
      const departmentId = await this.checkedDepartment(c, body.departmentId);
      const assigneeId = await this.checkedUser(c, body.assigneeId, 'responsabil');
      const o = (await c.query('INSERT INTO case_objects (case_id, text, department_id, assignee_id) VALUES ($1,$2,$3,$4) RETURNING id', [id, text, departmentId, assigneeId])).rows[0];
      await this.event(c, id, user, 'obiect_adaugat', text, { obiect: o.id });
      if (assigneeId != null && assigneeId !== user.id) {
        await this.notifications.send(assigneeId, 'lucrare_repartizata', `Vi s-a repartizat un obiect al lucrării ${row.reg_label}`, { link: `/lucrari/${id}` }, c);
      }
      return { id: o.id };
    });
  }

  async updateObject(user: CurrentUser, id: number, objectId: number, body: { status?: unknown; answer?: unknown; assigneeId?: unknown; departmentId?: unknown }) {
    const has = (k: string) => Object.hasOwn(body, k);
    return this.db.tx(async (c) => {
      const row = await this.requireEditable(user, id, c);
      const o = (await c.query('SELECT * FROM case_objects WHERE id = $1 AND case_id = $2 FOR UPDATE', [objectId, id])).rows[0];
      if (!o) notFound('Obiectul nu există');
      const values: Record<string, unknown> = {};
      if (has('answer')) values.answer = optText(body.answer);
      if (has('assigneeId')) values.assignee_id = await this.checkedUser(c, body.assigneeId, 'responsabil');
      if (has('departmentId')) values.department_id = await this.checkedDepartment(c, body.departmentId);
      if (has('status')) {
        const status = String(body.status);
        if (!['deschis', 'solutionat'].includes(status)) badRequest('Stare invalidă');
        values.status = status;
        values.solved_at = status === 'solutionat' ? new Date() : null;
        if (status === 'solutionat' && !(has('answer') ? values.answer : o.answer)) badRequest('Scrieți răspunsul la acest obiect');
      }
      const cols = Object.keys(values);
      if (cols.length) await c.query(`UPDATE case_objects SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1`, [objectId, ...cols.map((k) => values[k])]);
      await this.event(c, id, user, values.status === 'solutionat' ? 'obiect_solutionat' : 'obiect_modificat', o.text, { obiect: objectId, campuri: cols });
      if (values.assignee_id != null && values.assignee_id !== o.assignee_id && values.assignee_id !== user.id) {
        await this.notifications.send(values.assignee_id as number, 'lucrare_repartizata', `Vi s-a repartizat un obiect al lucrării ${row.reg_label}`, { link: `/lucrari/${id}` }, c);
      }
      return { ok: true };
    });
  }

  // Documente, fotografii --------------------------------------------------------

  async addDocument(user: CurrentUser, id: number, body: { documentId?: unknown; role?: unknown }) {
    return this.db.tx(async (c) => {
      await this.requireEditable(user, id, c, { open: false });
      const documentId = toInt(body.documentId, 'document');
      const role = String(body.role ?? 'anexa');
      if (!ROLES.includes(role)) badRequest('Rol invalid pentru document');
      const doc = await this.docs.requireVisible(user, documentId);
      await c.query('INSERT INTO case_documents (case_id, document_id, role, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (case_id, document_id) DO UPDATE SET role = excluded.role',
        [id, documentId, role, user.id]);
      await this.event(c, id, user, 'document_adaugat', null, { document: documentId, numar: doc.reg_label, rol: role });
      await this.audit.log(user, { action: 'lucrare.document_adaugat', documentId, details: { lucrare: id, rol: role } }, c);
      return { ok: true };
    });
  }

  async addPhoto(user: CurrentUser, id: number, file: UploadFile | undefined, body: Record<string, unknown>) {
    if (!file) badRequest('Atașați o fotografie');
    const name = Buffer.from(file!.originalname, 'latin1').toString('utf8');
    const mime = detectMime(file!, name);
    if (!PHOTO_MIME.has(mime)) badRequest('Fotografia trebuie să fie JPEG sau PNG');
    const lat = body.latitude == null || body.latitude === '' ? null : Number(body.latitude);
    const lng = body.longitude == null || body.longitude === '' ? null : Number(body.longitude);
    if (lat != null && !(Number.isFinite(lat) && Math.abs(lat) <= 90)) badRequest('Latitudine invalidă');
    if (lng != null && !(Number.isFinite(lng) && Math.abs(lng) <= 180)) badRequest('Longitudine invalidă');
    const key = await this.storage.put(file!.buffer);
    const sha256 = crypto.createHash('sha256').update(file!.buffer).digest('hex');
    try {
      return await this.db.tx(async (c) => {
        await this.requireEditable(user, id, c);
        const p = (await c.query(
          `INSERT INTO case_photos (case_id, filename, mime, size_bytes, sha256, storage_key, latitude, longitude, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [id, name, mime, file!.size, sha256, key, lat, lng, optText(body.note), user.id])).rows[0];
        await this.event(c, id, user, 'fotografie', optText(body.note), { fotografie: p.id, sha256, gps: lat != null && lng != null });
        await this.audit.log(user, { action: 'lucrare.fotografie', details: { lucrare: id, fotografie: p.id, sha256 } }, c);
        return { id: p.id, sha256 };
      });
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
  }

  async photo(user: CurrentUser, id: number, photoId: number, res: Response) {
    await this.requireCase(user, id);
    const p = await this.db.one('SELECT * FROM case_photos WHERE id = $1 AND case_id = $2', [photoId, id]);
    if (!p) notFound('Fotografia nu există');
    const data = await this.storage.get(p.storage_key);
    await this.audit.log(user, { action: 'lucrare.fotografie_vizualizata', details: { lucrare: id, fotografie: photoId } });
    res.setHeader('Content-Type', p.mime);
    res.setHeader('Content-Length', data.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(p.filename)}`);
    res.end(data);
  }

  // Contravenții -------------------------------------------------------------------

  async updateContravention(user: CurrentUser, id: number, body: Record<string, unknown>) {
    const has = (k: string) => Object.hasOwn(body, k);
    return this.db.tx(async (c) => {
      const row = await this.requireEditable(user, id, c);
      if (row.kind !== 'contraventie') badRequest('Lucrarea nu este un dosar contravențional');
      const cv = (await c.query(
        `SELECT *, applied_on::text AS applied_on, communicated_on::text AS communicated_on, complaint_filed_on::text AS complaint_filed_on,
                paid_on::text AS paid_on, decision_on::text AS decision_on, execution_sent_on::text AS execution_sent_on
         FROM case_contraventions WHERE case_id = $1 FOR UPDATE`, [id])).rows[0];
      const v: Record<string, unknown> = {};
      const date = (key: string, col: string, label: string) => { if (has(key)) v[col] = optDate(body[key], label); };
      date('communicatedOn', 'communicated_on', 'data comunicării');
      date('paidOn', 'paid_on', 'data plății');
      date('complaintFiledOn', 'complaint_filed_on', 'data plângerii');
      date('decisionOn', 'decision_on', 'data hotărârii');
      date('executionSentOn', 'execution_sent_on', 'data trimiterii spre executare');
      if (has('communicationMethod')) {
        const m = optText(body.communicationMethod);
        if (m && !COMMUNICATION_METHODS.includes(m)) badRequest('Mod de comunicare invalid');
        v.communication_method = m;
      }
      if (has('paidAmount')) v.paid_amount = optAmount(body.paidAmount, 'suma achitată');
      if (has('court')) v.court = optText(body.court);
      if (has('courtFile')) v.court_file = optText(body.courtFile);
      if (has('executionBody')) v.execution_body = optText(body.executionBody);
      if (has('decisionOutcome')) {
        const d = optText(body.decisionOutcome);
        if (d && !DECISIONS.includes(d)) badRequest('Soluția instanței este invalidă');
        v.decision_outcome = d;
      }
      const after = { ...cv, ...v } as any;
      const today = todayIso();
      for (const [col, label] of [['communicated_on', 'Comunicarea'], ['paid_on', 'Plata'], ['complaint_filed_on', 'Plângerea'], ['decision_on', 'Hotărârea'], ['execution_sent_on', 'Trimiterea spre executare']] as const) {
        const value = after[col];
        if (value && value > today) badRequest(`${label} nu poate fi în viitor`);
        if (value && value < cv.applied_on) badRequest(`${label} nu poate fi înaintea aplicării procesului-verbal`);
      }
      if (after.communicated_on && !after.communication_method) v.communication_method = 'posta';
      if ((after.decision_on || after.decision_outcome) && !after.complaint_filed_on) badRequest('Înregistrați întâi plângerea');
      if (after.decision_outcome && !after.decision_on) badRequest('Completați data hotărârii');
      if (after.execution_sent_on && after.paid_on) badRequest('Amenda achitată nu se trimite spre executare');
      if (after.execution_sent_on && !after.execution_body) badRequest('Completați organul de executare');
      if (after.execution_sent_on && cv.sanction !== 'amenda') badRequest('Avertismentul nu se trimite spre executare');
      const cols = Object.keys(v);
      if (!cols.length) return { ok: true };
      await c.query(`UPDATE case_contraventions SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE case_id = $1`, [id, ...cols.map((k) => v[k])]);
      const changed = Object.fromEntries(cols.map((k) => [k, v[k]]));
      await this.event(c, id, user, 'contraventie', null, changed);
      await this.audit.log(user, { action: 'lucrare.contraventie_actualizata', details: { lucrare: id, campuri: cols } }, c);
      return { ok: true };
    });
  }

  // Expediere și dovada comunicării ----------------------------------------------

  async dispatchesFor(column: 'case_id' | 'document_id', id: number) {
    return (await this.db.query(
      `SELECT x.id, x.document_id AS "documentId", d.reg_label AS "documentLabel", x.case_id AS "caseId", x.method, x.recipient, x.address,
              x.sent_on::text AS "sentOn", x.tracking, x.note, x.delivered_on::text AS "deliveredOn", x.proof_filename AS "proofFilename",
              x.proof_sha256 AS "proofSha256", u.full_name AS "createdBy", x.created_at AS "createdAt"
       FROM dispatches x JOIN users u ON u.id = x.created_by LEFT JOIN documents d ON d.id = x.document_id
       WHERE x.${column} = $1 ORDER BY x.sent_on, x.id`, [id])).rows;
  }

  async createDispatch(user: CurrentUser, target: { caseId?: number; documentId?: number }, body: Record<string, unknown>) {
    const method = String(body.method ?? '');
    if (!DISPATCH_METHODS.includes(method)) badRequest('Mod de expediere invalid');
    const recipient = required(body.recipient, 'destinatarul');
    const sentOn = optDate(body.sentOn, 'data expedierii') ?? todayIso();
    if (sentOn > todayIso()) badRequest('Data expedierii nu poate fi în viitor');
    return this.db.tx(async (c) => {
      let caseId: number | null = null;
      let documentId: number | null = target.documentId ?? optInt(body.documentId, 'document');
      if (target.caseId != null) {
        await this.requireEditable(user, target.caseId, c, { open: false });
        caseId = target.caseId;
        if (documentId != null) {
          const inCase = await c.query('SELECT 1 FROM case_documents WHERE case_id = $1 AND document_id = $2', [caseId, documentId]);
          if (!inCase.rowCount) badRequest('Documentul expediat trebuie să facă parte din lucrare');
        }
      }
      if (documentId != null) {
        const doc = await this.docs.requireVisible(user, documentId);
        if (doc.status === 'anulat') conflict('Documentul anulat nu se expediază');
        if (target.documentId != null && !can(user, 'register') && doc.owner_id !== user.id) forbidden('Expedierea o face registratura sau proprietarul documentului');
      }
      const x = (await c.query(
        `INSERT INTO dispatches (document_id, case_id, method, recipient, address, sent_on, tracking, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [documentId, caseId, method, recipient, optText(body.address), sentOn, optText(body.tracking), optText(body.note), user.id])).rows[0];
      // Înmânarea și emailul sunt comunicate în ziua trimiterii; poșta, la confirmarea de primire.
      const immediate = ['inmanare', 'email', 'afisare'].includes(method);
      if (immediate) await c.query('UPDATE dispatches SET delivered_on = sent_on WHERE id = $1', [x.id]);
      if (caseId != null && body.isAnswer === true) {
        await c.query('UPDATE cases SET answer_communicated_on = $2 WHERE id = $1', [caseId, sentOn]);
      }
      if (caseId != null) await this.event(c, caseId, user, 'expediere', optText(body.note), { expediere: x.id, mod: method, document: documentId, raspuns: body.isAnswer === true });
      await this.audit.log(user, { action: 'document.expediat', documentId, details: { expediere: x.id, lucrare: caseId, mod: method } }, c);
      return { id: x.id };
    });
  }

  async confirmDelivery(user: CurrentUser, dispatchId: number, body: Record<string, unknown>, file: UploadFile | undefined) {
    const x = await this.db.one('SELECT *, sent_on::text AS sent_on FROM dispatches WHERE id = $1', [dispatchId]);
    if (!x) notFound('Expedierea nu există');
    if (x.case_id != null) await this.requireCase(user, x.case_id);
    else await this.docs.requireVisible(user, x.document_id);
    const deliveredOn = optDate(body.deliveredOn, 'data primirii') ?? todayIso();
    if (deliveredOn < x.sent_on) badRequest('Primirea nu poate fi înaintea expedierii');
    let key: string | null = null;
    let proof: { name: string; mime: string; sha: string } | null = null;
    if (file) {
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const mime = detectMime(file, name);
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(mime)) badRequest('Dovada trebuie să fie PDF, JPEG sau PNG');
      key = await this.storage.put(file.buffer);
      proof = { name, mime, sha: crypto.createHash('sha256').update(file.buffer).digest('hex') };
    }
    try {
      return await this.db.tx(async (c) => {
        await c.query(
          `UPDATE dispatches SET delivered_on = $2, proof_filename = coalesce($3, proof_filename), proof_mime = coalesce($4, proof_mime),
             proof_sha256 = coalesce($5, proof_sha256), proof_key = coalesce($6, proof_key) WHERE id = $1`,
          [dispatchId, deliveredOn, proof?.name ?? null, proof?.mime ?? null, proof?.sha ?? null, key]);
        if (x.proof_key && key) await this.storage.remove(x.proof_key);
        if (x.case_id != null) await this.event(c, x.case_id, user, 'confirmare_primire', null, { expediere: dispatchId, primitLa: deliveredOn, dovada: proof?.sha ?? null });
        await this.audit.log(user, { action: 'document.confirmare_primire', documentId: x.document_id, details: { expediere: dispatchId, primitLa: deliveredOn, sha256: proof?.sha ?? null } }, c);
        return { ok: true };
      });
    } catch (err) {
      if (key) await this.storage.remove(key);
      throw err;
    }
  }

  async proof(user: CurrentUser, dispatchId: number, res: Response) {
    const x = await this.db.one('SELECT * FROM dispatches WHERE id = $1', [dispatchId]);
    if (!x?.proof_key) notFound('Nu există dovadă încărcată');
    if (x.case_id != null) await this.requireCase(user, x.case_id);
    else await this.docs.requireVisible(user, x.document_id);
    const data = await this.storage.get(x.proof_key);
    res.setHeader('Content-Type', x.proof_mime);
    res.setHeader('Content-Length', data.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(x.proof_filename)}`);
    res.end(data);
  }

  // Documente din șabloane ---------------------------------------------------------

  async institution(): Promise<Letterhead & { leader?: string; leaderTitle?: string }> {
    return (await this.db.one(`SELECT value FROM settings WHERE key = 'institution'`))?.value ?? { name: 'Instituția' };
  }

  private async templateValues(user: CurrentUser, caseId: number): Promise<Record<string, string>> {
    const row = await this.db.one(
      `SELECT c.*, c.received_on::text AS received_on, ${DUE}::text AS due_on, a.full_name AS assignee_name
       FROM cases c LEFT JOIN users a ON a.id = c.assignee_id LEFT JOIN case_contraventions cv ON cv.case_id = c.id WHERE c.id = $1`, [caseId]);
    const cv = await this.db.one(
      `SELECT cv.*, cv.applied_on::text AS applied_on, cv.communicated_on::text AS communicated_on, cv.decision_on::text AS decision_on, ag.full_name AS agent_name
       FROM case_contraventions cv LEFT JOIN users ag ON ag.id = cv.agent_id WHERE cv.case_id = $1`, [caseId]);
    const inst = await this.institution();
    const details = row.details ?? {};
    const values: Record<string, string> = {
      institutie: inst.name ?? '', conducator: inst.leader ?? '', conducator_functie: inst.leaderTitle ?? '',
      numar_lucrare: row.reg_label, data: roDate(todayIso()), data_primirii: roDate(row.received_on), termen: roDate(row.due_on),
      obiect: row.subject, petent: row.applicant_name ?? '', adresa_petent: row.applicant_address ?? '', email_petent: row.applicant_email ?? '',
      institutie_competenta: row.redirected_to ?? '', solutie: row.resolution_note ?? '', responsabil: row.assignee_name ?? user.fullName,
      adresa: row.location ?? '', zile_prelungire: row.extension_days ? String(row.extension_days) : '', motiv_prelungire: row.extension_reason ?? '',
      echipa: String(details.team ?? ''), constatari: String(details.findings ?? ''),
    };
    if (cv) {
      Object.assign(values, {
        pv_serie: cv.pv_series, pv_numar: cv.pv_number, contravenient: cv.offender_name, cod_contravenient: cv.offender_id_code ?? '',
        adresa_contravenient: cv.offender_address ?? '', fapta: cv.fact, temei: cv.legal_basis,
        sanctiune: cv.sanction === 'amenda' ? `amendă contravențională în cuantum de ${money(cv.amount)} lei` : 'avertisment',
        amenda: money(cv.amount), jumatate_minim: cv.min_amount == null ? '' : money(Number(cv.min_amount) / 2),
        agent: cv.agent_name ?? '', data_constatarii: roDateTime(cv.observed_at), data_aplicarii: roDate(cv.applied_on),
        data_comunicarii: roDate(cv.communicated_on), organ_executare: cv.execution_body ?? '',
        mentiune_hotarare: cv.decision_outcome === 'plangere_respinsa' ? `; plângerea a fost respinsă prin hotărârea din ${roDate(cv.decision_on)}` : '',
      });
    }
    return values;
  }

  private async template(id: number) {
    const t = await this.db.one('SELECT * FROM document_templates WHERE id = $1 AND active', [id]);
    if (!t) notFound('Șablonul nu există sau este inactiv');
    return t;
  }

  async templateFieldsFor(user: CurrentUser, caseId: number, templateId: number) {
    const row = await this.requireCase(user, caseId);
    const t = await this.template(templateId);
    if (t.case_kind && t.case_kind !== row.kind) badRequest('Șablonul nu se potrivește tipului de lucrare');
    const values = await this.templateValues(user, caseId);
    const fields = [...new Set([...templateFields(t.title), ...templateFields(t.body)])];
    return {
      template: { id: t.id, name: t.name, documentTypeId: t.document_type_id, registerId: t.register_id, caseRole: t.case_role },
      fields: fields.map((key) => ({ key, value: values[key] ?? '' })),
    };
  }

  private async render(user: CurrentUser, caseId: number, templateId: number, overrides: unknown) {
    const row = await this.requireCase(user, caseId);
    const t = await this.template(templateId);
    if (t.case_kind && t.case_kind !== row.kind) badRequest('Șablonul nu se potrivește tipului de lucrare');
    const values = await this.templateValues(user, caseId);
    if (overrides && typeof overrides === 'object') {
      for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
        if (/^[a-z0-9_]+$/.test(k) && typeof v === 'string') values[k] = v.slice(0, 20_000);
      }
    }
    const inst = await this.institution();
    const title = fillTemplate(t.title, values);
    const pdf = await renderLetter(inst, title, fillTemplate(t.body, values), `${row.reg_label} · generat de SeaDoc`);
    return { row, t, title, pdf };
  }

  async preview(user: CurrentUser, caseId: number, templateId: number, rawValues: string | undefined, res: Response) {
    let overrides: unknown = null;
    if (rawValues) {
      try { overrides = JSON.parse(rawValues); } catch { badRequest('Valori invalide'); }
    }
    const { pdf } = await this.render(user, caseId, templateId, overrides);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline; filename="previzualizare.pdf"');
    res.end(pdf);
  }

  /** Documentul generat se înregistrează și intră în lucrare, în aceeași tranzacție. */
  async generate(user: CurrentUser, caseId: number, body: { templateId?: unknown; documentTypeId?: unknown; registerId?: unknown; title?: unknown; values?: unknown }) {
    const templateId = toInt(body.templateId, 'șablon');
    const row0 = await this.requireCase(user, caseId);
    if (!(await this.canEdit(user, row0))) forbidden('Nu puteți modifica această lucrare');
    const { row, t, title, pdf } = await this.render(user, caseId, templateId, body.values);
    const documentTypeId = optInt(body.documentTypeId, 'tip document') ?? t.document_type_id;
    if (documentTypeId == null) badRequest('Alegeți tipul documentului');
    const registerId = optInt(body.registerId, 'registru') ?? t.register_id;
    const recipient = t.code.includes('institutie') ? row.redirected_to : row.kind === 'contraventie'
      ? (await this.db.one('SELECT offender_name FROM case_contraventions WHERE case_id = $1', [caseId]))?.offender_name : row.applicant_name;
    const inst = await this.institution();
    const fileTitle = optText(body.title) ?? title;
    const safe = fileTitle.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'document';
    let created: { id: number; regLabel: string | null } | null = null;
    await this.docs.create(user, {
      title: fileTitle, direction: t.case_role === 'proces_verbal' ? 'intern' : 'iesit', registerId: registerId ?? undefined,
      issuer: inst.name, recipient: recipient ?? undefined, summary: `Generat din șablonul „${t.name}” pentru lucrarea ${row.reg_label}`,
      documentTypeId, departmentId: row.department_id, personalData: true,
    }, { originalname: `${safe}.pdf`, mimetype: 'application/pdf', buffer: pdf, size: pdf.length }, async (c, doc) => {
      created = doc;
      await c.query('INSERT INTO case_documents (case_id, document_id, role, added_by) VALUES ($1,$2,$3,$4)', [caseId, doc.id, t.case_role, user.id]);
      await this.event(c, caseId, user, 'document_generat', t.name, { document: doc.id, numar: doc.regLabel, sablon: t.code });
    }, { trusted: true });
    return created!;
  }

  // Rapoarte, istoric, panou ---------------------------------------------------------

  /** Situația semestrială a petițiilor (art. 13 din O.G. 27/2002). */
  async petitionReport(user: CurrentUser, yearRaw: unknown, semesterRaw: unknown) {
    if (!can(user, 'reports') && !can(user, 'cases_all')) forbidden();
    const year = toInt(yearRaw ?? new Date().getFullYear(), 'an');
    const semester = toInt(semesterRaw ?? 1, 'semestru');
    if (![1, 2].includes(semester)) badRequest('Semestrul este 1 sau 2');
    const from = `${year}-${semester === 1 ? '01-01' : '07-01'}`;
    const to = `${year}-${semester === 1 ? '06-30' : '12-31'}`;
    const params: unknown[] = [from, to];
    const visible = caseVisibleSql(user, params);
    const where = `c.kind = 'petitie' AND c.received_on BETWEEN $1 AND $2 AND ${visible}`;
    const totals = await this.db.one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE c.status = 'deschisa')::int AS open,
              count(*) FILTER (WHERE c.status = 'inchisa' AND c.closed_at::date <= ${DUE})::int AS "inTerm",
              count(*) FILTER (WHERE (c.status = 'inchisa' AND c.closed_at::date > ${DUE}) OR (c.status = 'deschisa' AND ${DUE} < ${TODAY}))::int AS "overTerm",
              count(*) FILTER (WHERE c.extension_days > 0)::int AS extended,
              count(*) FILTER (WHERE c.anonymous)::int AS anonymous,
              count(*) FILTER (WHERE (SELECT count(*) FROM case_objects o WHERE o.case_id = c.id) > 1)::int AS "multipleObjects",
              count(*) FILTER (WHERE c.answer_communicated_on IS NOT NULL)::int AS communicated
       ${LIST_FROM} WHERE ${where}`, params);
    const byOutcome = (await this.db.query(
      `SELECT c.outcome, count(*)::int AS n ${LIST_FROM} WHERE ${where} AND c.status = 'inchisa' GROUP BY c.outcome ORDER BY n DESC`, params)).rows
      .map((r) => ({ outcome: r.outcome, label: OUTCOMES.petitie[r.outcome] ?? r.outcome, count: r.n }));
    const byDepartment = (await this.db.query(
      `SELECT dep.name AS department, count(*)::int AS total, count(*) FILTER (WHERE c.status = 'deschisa')::int AS open,
              count(*) FILTER (WHERE (c.status = 'inchisa' AND c.closed_at::date > ${DUE}) OR (c.status = 'deschisa' AND ${DUE} < ${TODAY}))::int AS "overTerm"
       ${LIST_FROM} WHERE ${where} GROUP BY dep.name ORDER BY total DESC`, params)).rows;
    const byChannel = (await this.db.query(
      `SELECT coalesce(c.channel, 'nespecificat') AS channel, count(*)::int AS count ${LIST_FROM} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, params)).rows;
    const byMonth = (await this.db.query(
      `SELECT to_char(c.received_on, 'YYYY-MM') AS month, count(*)::int AS count ${LIST_FROM} WHERE ${where} GROUP BY 1 ORDER BY 1`, params)).rows;
    await this.audit.log(user, { action: 'raport.petitii_semestrial', details: { an: year, semestru: semester } });
    return { year, semester, from, to, institution: (await this.institution()).name, totals, byOutcome, byDepartment, byChannel, byMonth };
  }

  async petitionReportCsv(user: CurrentUser, year: unknown, semester: unknown, res: Response) {
    const r = await this.petitionReport(user, year, semester);
    const row = (cells: unknown[]) => cells.map(csvCell).join(';');
    const t = r.totals;
    const lines = [
      row([`Situația petițiilor, semestrul ${r.semester} ${r.year}`, r.institution]),
      row(['Perioada', roDate(r.from), roDate(r.to)]), '',
      row(['Indicator', 'Număr']),
      row(['Petiții înregistrate', t.total]), row(['Soluționate în termen', t.inTerm]), row(['Cu termen depășit', t.overTerm]),
      row(['În curs', t.open]), row(['Cu termen prelungit', t.extended]), row(['Anonime', t.anonymous]),
      row(['Cu obiect multiplu', t.multipleObjects]), row(['Cu răspuns comunicat', t.communicated]), '',
      row(['Soluție', 'Număr']), ...r.byOutcome.map((o) => row([o.label, o.count])), '',
      row(['Compartiment', 'Total', 'În curs', 'Termen depășit']), ...r.byDepartment.map((d) => row([d.department, d.total, d.open, d.overTerm])), '',
      row(['Mod de primire', 'Număr']), ...r.byChannel.map((ch) => row([ch.channel, ch.count])),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="petitii-${r.year}-S${r.semester}.csv"`);
    res.end('﻿' + lines.join('\r\n'));
  }

  /** Tot ce s-a întâmplat la o adresă sau un obiectiv: lucrări și documente. */
  async history(user: CurrentUser, rawLocation: unknown) {
    const location = optText(rawLocation);
    if (!location || location.length < 3) badRequest('Scrieți cel puțin 3 caractere din adresă');
    const terms = location!.split(/[\s,.;]+/).filter((w) => w.length >= 2).slice(0, 8);
    const params: unknown[] = [];
    const visible = caseVisibleSql(user, params);
    const conds = terms.map((term) => {
      params.push(like(term));
      const p = `$${params.length}`;
      return `(unaccent(coalesce(c.location,'')) ILIKE unaccent(${p}) OR unaccent(coalesce(c.applicant_address,'')) ILIKE unaccent(${p})
               OR unaccent(coalesce(cv.offender_address,'')) ILIKE unaccent(${p}))`;
    });
    const cases = (await this.db.query(
      `SELECT ${LIST_COLUMNS}, c.applicant_address AS "applicantAddress", cv.offender_address AS "offenderAddress"
       ${LIST_FROM} WHERE ${visible} AND ${conds.join(' AND ')} ORDER BY c.received_on DESC, c.id DESC LIMIT 200`, params)).rows;
    const docParams: unknown[] = [terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' ')];
    const docVisible = visibleSql(user, docParams);
    const documents = (await this.db.query(
      `SELECT d.id, d.title, d.reg_label AS "regLabel", d.reg_date AS "regDate", d.status, d.direction
       FROM documents d WHERE d.search @@ websearch_to_tsquery('seadoc', $1) AND d.status <> 'eliminat' AND ${docVisible}
       ORDER BY d.created_at DESC LIMIT 50`, docParams)).rows;
    await this.audit.log(user, { action: 'lucrare.istoric_adresa', details: { lucrari: cases.length, documente: documents.length } });
    return { location, cases, documents };
  }

  /** Panoul pe roluri: conducerea vede instituția, șeful de serviciu compartimentul, execuția lucrările proprii. */
  async dashboard(user: CurrentUser) {
    // Conducerea (compartimentul rădăcină, cu subordonate) vede instituția; un șef cu subordonate le vede pe compartimente.
    const manager = user.role === 'manager' && user.departmentId != null && !can(user, 'cases_all');
    const tree = manager ? await this.db.one(
      `SELECT parent_id IS NULL AS root, EXISTS (SELECT 1 FROM departments s WHERE s.parent_id = d.id) AS subordinates FROM departments d WHERE d.id = $1`, [user.departmentId]) : null;
    const scope: 'institutie' | 'serviciu' | 'personal' = can(user, 'cases_all') || (tree?.root && tree.subordinates) ? 'institutie' : manager ? 'serviciu' : 'personal';
    const byDepartment = can(user, 'cases_all') || !!tree?.subordinates;
    const params: unknown[] = [];
    let where: string;
    if (can(user, 'cases_all')) where = 'TRUE';
    else if (manager) { params.push(user.departmentId); where = `c.department_id IN ${deptTree('$1')}`; }
    else { params.push(user.id); where = `(c.assignee_id = $1 OR EXISTS (SELECT 1 FROM case_objects o WHERE o.case_id = c.id AND o.assignee_id = $1 AND o.status = 'deschis'))`; }
    const open = `c.status = 'deschisa' AND ${where}`;
    const byKind = (await this.db.query(
      `SELECT c.kind, count(*)::int AS open, count(*) FILTER (WHERE ${DUE} < ${TODAY})::int AS overdue,
              count(*) FILTER (WHERE ${DUE} BETWEEN ${TODAY} AND ${TODAY} + ${REMIND_DAYS})::int AS "dueSoon",
              count(*) FILTER (WHERE ${READY_EXEC})::int AS "readyForExecution"
       ${LIST_FROM} WHERE ${open} GROUP BY c.kind`, params)).rows;
    const urgent = (await this.db.query(
      `SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE ${open} AND (${DUE} <= ${TODAY} + ${REMIND_DAYS} OR ${READY_EXEC})
       ORDER BY ${DUE} NULLS LAST, c.id LIMIT 15`, params)).rows;
    let breakdown: any[] = [];
    if (byDepartment) {
      breakdown = (await this.db.query(
        `SELECT dep.name AS label, count(*)::int AS open, count(*) FILTER (WHERE ${DUE} < ${TODAY})::int AS overdue
         ${LIST_FROM} WHERE ${open} GROUP BY dep.name ORDER BY overdue DESC, open DESC`, params)).rows;
    } else if (manager) {
      breakdown = (await this.db.query(
        `SELECT coalesce(a.full_name, 'Nerepartizate') AS label, count(*)::int AS open, count(*) FILTER (WHERE ${DUE} < ${TODAY})::int AS overdue
         ${LIST_FROM} WHERE ${open} GROUP BY a.full_name ORDER BY overdue DESC, open DESC`, params)).rows;
    }
    const unassigned = scope === 'personal' ? 0 : (await this.db.one(`SELECT count(*)::int AS n FROM cases c WHERE ${open} AND c.assignee_id IS NULL`, params)).n;
    const closedThisMonth = (await this.db.one(
      `SELECT count(*)::int AS n FROM cases c WHERE c.status = 'inchisa' AND ${where} AND c.closed_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Bucharest')`, params)).n;
    return { scope, byDepartment, byKind, urgent, breakdown, unassigned, closedThisMonth };
  }

  // Termene: notificare și escaladare -------------------------------------------------

  startScheduler() {
    const tick = () => { void this.checkDeadlines().catch((err) => this.log.error(`Termene lucrări: ${String(err)}`)); };
    this.timer = setInterval(tick, config.schedulerMs);
    this.timer.unref();
    tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async checkDeadlines() {
    const soon = (await this.db.query(
      `SELECT c.id, c.reg_label, c.assignee_id, d.manager_id, ${DUE}::text AS due
       FROM cases c JOIN departments d ON d.id = c.department_id LEFT JOIN case_contraventions cv ON cv.case_id = c.id
       WHERE c.status = 'deschisa' AND c.reminded_at IS NULL AND ${DUE} BETWEEN ${TODAY} AND ${TODAY} + ${REMIND_DAYS}`)).rows;
    for (const r of soon) {
      await this.db.tx(async (c) => {
        const to = r.assignee_id ?? r.manager_id;
        if (to) await this.notifications.send(to, 'lucrare_termen', `Termenul lucrării ${r.reg_label} expiră la ${roDate(r.due)}`, { link: `/lucrari/${r.id}` }, c);
        await c.query('UPDATE cases SET reminded_at = now() WHERE id = $1', [r.id]);
        await this.event(c, r.id, null, 'notificare_termen', null, { termen: r.due });
      });
    }
    const late = (await this.db.query(
      `SELECT c.id, c.reg_label, c.assignee_id, d.manager_id, ${DUE}::text AS due
       FROM cases c JOIN departments d ON d.id = c.department_id LEFT JOIN case_contraventions cv ON cv.case_id = c.id
       WHERE c.status = 'deschisa' AND c.escalated_at IS NULL AND ${DUE} < ${TODAY}`)).rows;
    for (const r of late) {
      await this.db.tx(async (c) => {
        const title = `Termen depășit: lucrarea ${r.reg_label} (termen ${roDate(r.due)})`;
        const people = new Set([r.assignee_id, r.manager_id].filter((x) => x != null));
        for (const to of people) await this.notifications.send(to, 'lucrare_escaladare', title, { link: `/lucrari/${r.id}` }, c);
        await c.query('UPDATE cases SET escalated_at = now() WHERE id = $1', [r.id]);
        await this.event(c, r.id, null, 'escaladare', null, { termen: r.due, sef: r.manager_id });
        await this.audit.log(null, { action: 'lucrare.escaladata', details: { lucrare: r.id, termen: r.due } }, c);
      });
    }
    return { reminded: soon.length, escalated: late.length };
  }
}

@Controller('cases')
@UseGuards(AuthGuard)
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  list(@User() user: CurrentUser, @Query() q: Record<string, string>) { return this.cases.list(user, q); }

  @Post()
  create(@User() user: CurrentUser, @Body() body: Record<string, unknown>) { return this.cases.create(user, body); }

  @Get('dashboard')
  dashboard(@User() user: CurrentUser) { return this.cases.dashboard(user); }

  @Get('history')
  history(@User() user: CurrentUser, @Query('location') location?: string) { return this.cases.history(user, location); }

  @Get('reports/petitions')
  report(@User() user: CurrentUser, @Query() q: Record<string, string>) { return this.cases.petitionReport(user, q.year, q.semester); }

  @Get('reports/petitions/csv')
  reportCsv(@User() user: CurrentUser, @Query() q: Record<string, string>, @Res() res: Response) { return this.cases.petitionReportCsv(user, q.year, q.semester, res); }

  @Get(':id')
  detail(@User() user: CurrentUser, @Param('id') id: string) { return this.cases.detail(user, toInt(id)); }

  @Patch(':id')
  update(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.update(user, toInt(id), body); }

  @Post(':id/assign') @HttpCode(200)
  assign(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.assign(user, toInt(id), body); }

  @Post(':id/extend') @HttpCode(200)
  extend(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.extend(user, toInt(id), body); }

  @Post(':id/close') @HttpCode(200)
  close(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.close(user, toInt(id), body); }

  @Post(':id/reopen') @HttpCode(200)
  reopen(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.reopen(user, toInt(id), body); }

  @Post(':id/notes') @HttpCode(200)
  note(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.addNote(user, toInt(id), body); }

  @Post(':id/objects')
  addObject(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.addObject(user, toInt(id), body); }

  @Patch(':id/objects/:objectId')
  updateObject(@User() user: CurrentUser, @Param('id') id: string, @Param('objectId') objectId: string, @Body() body: Record<string, unknown>) {
    return this.cases.updateObject(user, toInt(id), toInt(objectId), body);
  }

  @Post(':id/documents') @HttpCode(200)
  addDocument(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.addDocument(user, toInt(id), body); }

  @Post(':id/photos')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes } }))
  addPhoto(@User() user: CurrentUser, @Param('id') id: string, @UploadedFile() file: UploadFile, @Body() body: Record<string, unknown>) {
    return this.cases.addPhoto(user, toInt(id), file, body);
  }

  @Get(':id/photos/:photoId')
  photo(@User() user: CurrentUser, @Param('id') id: string, @Param('photoId') photoId: string, @Res() res: Response) {
    return this.cases.photo(user, toInt(id), toInt(photoId), res);
  }

  @Patch(':id/contravention')
  contravention(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.updateContravention(user, toInt(id), body); }

  @Post(':id/dispatches')
  dispatch(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.createDispatch(user, { caseId: toInt(id) }, body); }

  @Get(':id/templates/:templateId')
  fields(@User() user: CurrentUser, @Param('id') id: string, @Param('templateId') templateId: string) {
    return this.cases.templateFieldsFor(user, toInt(id), toInt(templateId));
  }

  @Get(':id/templates/:templateId/preview')
  preview(@User() user: CurrentUser, @Param('id') id: string, @Param('templateId') templateId: string, @Query('values') values: string | undefined, @Res() res: Response) {
    return this.cases.preview(user, toInt(id), toInt(templateId), values, res);
  }

  @Post(':id/generate')
  generate(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.cases.generate(user, toInt(id), body); }
}

/** Expedierea documentelor din registratură, în afara unei lucrări. */
@Controller()
@UseGuards(AuthGuard)
export class DispatchController {
  constructor(private readonly cases: CasesService, private readonly docs: DocumentsService) {}

  @Get('documents/:id/dispatches')
  async list(@User() user: CurrentUser, @Param('id') id: string) {
    await this.docs.requireVisible(user, toInt(id));
    return this.cases.dispatchesFor('document_id', toInt(id));
  }

  @Post('documents/:id/dispatches')
  create(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.cases.createDispatch(user, { documentId: toInt(id) }, body);
  }

  @Post('dispatches/:id/delivered') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes } }))
  delivered(@User() user: CurrentUser, @Param('id') id: string, @UploadedFile() file: UploadFile | undefined, @Body() body: Record<string, unknown>) {
    return this.cases.confirmDelivery(user, toInt(id), body, file);
  }

  @Get('dispatches/:id/proof')
  proof(@User() user: CurrentUser, @Param('id') id: string, @Res() res: Response) { return this.cases.proof(user, toInt(id), res); }
}

/** Șabloanele și datele instituției se administrează din aplicație, fără furnizor. */
@Controller('templates')
@UseGuards(AuthGuard)
export class TemplatesController {
  constructor(private readonly db: Db, private readonly audit: AuditService, private readonly cases: CasesService) {}

  @Get()
  async list() {
    const rows = (await this.db.query(
      `SELECT id, code, name, case_kind AS "caseKind", case_role AS "caseRole", title, body, document_type_id AS "documentTypeId",
              register_id AS "registerId", active, updated_at AS "updatedAt" FROM document_templates ORDER BY case_kind NULLS LAST, id`)).rows;
    return rows.map((r) => ({ ...r, fields: [...new Set([...templateFields(r.title), ...templateFields(r.body)])] }));
  }

  @Get('institution')
  institution() { return this.cases.institution(); }

  @Put('institution') @RequirePerm('users_admin')
  async setInstitution(@User() user: CurrentUser, @Body() body: Record<string, unknown>) {
    const value = {
      name: required(body.name, 'denumirea instituției'), address: optText(body.address) ?? '', phone: optText(body.phone) ?? '',
      email: optText(body.email) ?? '', leader: optText(body.leader) ?? '', leaderTitle: optText(body.leaderTitle) ?? '',
    };
    await this.db.query(`INSERT INTO settings (key, value) VALUES ('institution', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [JSON.stringify(value)]);
    await this.audit.log(user, { action: 'admin.institutie', details: { denumire: value.name } });
    return value;
  }

  private async values(body: Record<string, unknown>) {
    const caseKind = optText(body.caseKind);
    if (caseKind && !CASE_KINDS.includes(caseKind as CaseKind)) badRequest('Tip de lucrare invalid');
    const caseRole = String(body.caseRole ?? 'adresa');
    if (!ROLES.includes(caseRole)) badRequest('Rol invalid');
    return {
      name: required(body.name, 'denumirea'), case_kind: caseKind, case_role: caseRole, title: required(body.title, 'titlul'), body: required(body.body, 'textul'),
      document_type_id: optInt(body.documentTypeId, 'tip document'), register_id: optInt(body.registerId, 'registru'), active: body.active !== false,
    };
  }

  @Post() @RequirePerm('users_admin')
  async create(@User() user: CurrentUser, @Body() body: Record<string, unknown>) {
    const v = await this.values(body);
    const code = required(body.code, 'codul').toLowerCase();
    if (!/^[a-z0-9_]{3,40}$/.test(code)) badRequest('Codul are 3–40 caractere: litere mici, cifre și _');
    const r = (await this.db.query(
      `INSERT INTO document_templates (code, name, case_kind, case_role, title, body, document_type_id, register_id, active, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [code, v.name, v.case_kind, v.case_role, v.title, v.body, v.document_type_id, v.register_id, v.active, user.id])).rows[0];
    await this.audit.log(user, { action: 'admin.sablon', details: { sablon: r.id, cod: code, operatie: 'creat' } });
    return { id: r.id };
  }

  @Put(':id') @RequirePerm('users_admin')
  async update(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const v = await this.values(body);
    const r = await this.db.query(
      `UPDATE document_templates SET name = $2, case_kind = $3, case_role = $4, title = $5, body = $6, document_type_id = $7, register_id = $8,
         active = $9, updated_by = $10, updated_at = now() WHERE id = $1`,
      [toInt(id), v.name, v.case_kind, v.case_role, v.title, v.body, v.document_type_id, v.register_id, v.active, user.id]);
    if (!r.rowCount) notFound('Șablonul nu există');
    await this.audit.log(user, { action: 'admin.sablon', details: { sablon: toInt(id), operatie: 'modificat' } });
    return { ok: true };
  }
}
