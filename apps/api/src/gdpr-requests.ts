import { Body, Controller, Get, HttpCode, Injectable, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import { Db, Queryable } from './db.js';
import { badRequest, conflict, csvCell, notFound, optInt, optText, toInt } from './http.js';
import { CurrentUser, visibleSql } from './perms.js';

const TYPES = ['acces', 'rectificare', 'stergere', 'restrictionare', 'opozitie', 'portabilitate'];
const STATUSES = ['inregistrata', 'in_lucru', 'solutionata', 'respinsa'];
const CLOSED = ['solutionata', 'respinsa'];
const DECISIONS = ['pastrare_retentie', 'eliminare_la_expirare', 'fara_legatura', 'alta'];
const SEARCH_LIMIT = 500;
const EXPORT_LIMIT = 5000;
const ACCESS_EXPORT_LIMIT = 100_000;
// Toate acțiunile care arată că cineva a consultat documentul.
const ACCESS_ACTIONS = ['gdpr.acces_date_personale', 'document.vizualizare', 'document.previzualizare', 'document.descarcare', 'arhiva.consultare'];
const TODAY = `(now() AT TIME ZONE 'Europe/Bucharest')::date`;

const REQUEST_COLUMNS = `r.id, r.type, r.subject_name AS "subjectName", r.subject_identifier AS "subjectIdentifier",
  r.received_on::text AS "receivedOn", r.due_on::text AS "dueOn", r.status, r.resolution_note AS "resolutionNote",
  r.assignee_id AS "assigneeId", a.full_name AS "assigneeName", c.full_name AS "createdBy", r.created_at AS "createdAt", r.closed_at AS "closedAt",
  (r.status NOT IN ('solutionata','respinsa') AND r.due_on < ${TODAY}) AS overdue, (r.due_on - ${TODAY}) AS "daysLeft"`;
const REQUEST_FROM = `FROM gdpr_requests r LEFT JOIN users a ON a.id = r.assignee_id JOIN users c ON c.id = r.created_by`;

function requiredText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? optText(value) : null;
  if (!text) badRequest(`Câmp obligatoriu: ${field}`);
  return text as string;
}

function checkedDate(value: unknown): string {
  const text = requiredText(value, 'data primirii');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) badRequest('Data primirii este invalidă');
  return text;
}

function checkedType(value: unknown): string {
  if (!TYPES.includes(String(value))) badRequest('Tip de cerere invalid');
  return String(value);
}

/** Numele se caută ca termeni separați, în orice ordine; operatorii căutării web nu au sens aici. */
function nameTerms(name: string): string {
  return name.split(/\s+/).map((word) => word.replace(/["']/g, '').replace(/^-+/, '')).filter((word) => word && word.toLowerCase() !== 'or').join(' ');
}

/** Identificatorul se caută exact, ca expresie. */
const identifierTerms = (identifier: string) => `"${identifier.replace(/"/g, ' ')}"`;

@Injectable()
export class GdprRequestService {
  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  private async checkedAssignee(c: Queryable, value: unknown): Promise<number | null> {
    const id = optInt(value, 'responsabil');
    if (id == null) return null;
    const ok = await c.query(
      `SELECT 1 FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id AND p.permission = 'audit_all'
       WHERE u.id = $1 AND u.active AND coalesce(p.allowed, u.role = 'admin')`, [id]);
    if (!ok.rowCount) badRequest('Responsabilul trebuie să fie un utilizator activ cu drept de audit');
    return id;
  }

  async assignees() {
    return (await this.db.query(
      `SELECT u.id, u.full_name AS "fullName" FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id AND p.permission = 'audit_all'
       WHERE u.active AND coalesce(p.allowed, u.role = 'admin') ORDER BY u.full_name`)).rows;
  }

  async list(q: Record<string, string | undefined>) {
    const status = optText(q.status);
    if (status && !STATUSES.includes(status)) badRequest('Stare invalidă');
    const overdueOnly = q.overdue === '1';
    const limit = Math.min(Math.max(optInt(q.limit, 'limită') ?? 25, 1), 200);
    const offset = Math.max(optInt(q.offset, 'deplasare') ?? 0, 0);
    const where = `($1::text IS NULL OR r.status = $1) AND (NOT $2::boolean OR (r.status NOT IN ('solutionata','respinsa') AND r.due_on < ${TODAY}))`;
    const total = (await this.db.one(`SELECT count(*)::int AS n FROM gdpr_requests r WHERE ${where}`, [status, overdueOnly])).n;
    const overdue = (await this.db.one(`SELECT count(*)::int AS n FROM gdpr_requests r WHERE r.status NOT IN ('solutionata','respinsa') AND r.due_on < ${TODAY}`)).n;
    const items = (await this.db.query(
      `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE ${where} ORDER BY overdue DESC, r.status IN ('solutionata','respinsa'), r.due_on, r.id DESC LIMIT $3 OFFSET $4`,
      [status, overdueOnly, limit, offset])).rows;
    return { total, overdue, items };
  }

  private async fetch(client: Queryable, id: number) {
    const row = (await client.query(`SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE r.id = $1`, [id])).rows[0];
    if (!row) notFound('Cererea nu există');
    return row;
  }

  async create(user: CurrentUser, body: Record<string, unknown>) {
    const type = checkedType(body.type);
    const subjectName = requiredText(body.subjectName, 'numele persoanei vizate');
    const receivedOn = checkedDate(body.receivedOn);
    return this.db.tx(async (c) => {
      await this.rejectFuture(c, receivedOn);
      const assignee = await this.checkedAssignee(c, body.assigneeId);
      const id = (await c.query(
        `INSERT INTO gdpr_requests (type, subject_name, subject_identifier, received_on, assignee_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [type, subjectName, optText(body.subjectIdentifier), receivedOn, assignee, user.id])).rows[0].id;
      // Numele și identificatorul nu intră în jurnalul imuabil: acolo nu s-ar mai putea rectifica sau șterge.
      await this.audit.log(user, { action: 'gdpr.cerere_creata', details: { cerere: id, tip: type, primita: receivedOn, responsabil: assignee } }, c);
      return this.fetch(c, id);
    });
  }

  private async rejectFuture(c: Queryable, date: string) {
    const r = (await c.query(`SELECT $1::date > ${TODAY} AS future`, [date])).rows[0];
    if (r.future) badRequest('Data primirii nu poate fi în viitor');
  }

  async detail(user: CurrentUser, id: number) {
    const request = await this.fetch(this.db, id);
    const params: unknown[] = [id];
    const visible = visibleSql(user, params);
    const decisions = (await this.db.query(
      `SELECT g.document_id AS "documentId", g.decision, g.note, g.retention_until::text AS "retentionUntil", g.document_status AS "documentStatus",
              u.full_name AS "decidedBy", g.decided_at AS "decidedAt", CASE WHEN ${visible} THEN d.title END AS title, CASE WHEN ${visible} THEN d.reg_label END AS "regLabel"
       FROM gdpr_request_decisions g JOIN documents d ON d.id = g.document_id JOIN users u ON u.id = g.decided_by
       WHERE g.request_id = $1 ORDER BY g.decided_at`, params)).rows;
    await this.audit.log(user, { action: 'gdpr.cerere_consultata', details: { cerere: id } });
    return { ...request, decisions };
  }

  async update(user: CurrentUser, id: number, body: Record<string, unknown>) {
    const has = (key: string) => Object.hasOwn(body, key);
    return this.db.tx(async (c) => {
      const before = (await c.query('SELECT * FROM gdpr_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) notFound('Cererea nu există');
      const values: Record<string, unknown> = {};
      if (has('type')) values.type = checkedType(body.type);
      if (has('subjectName')) values.subject_name = requiredText(body.subjectName, 'numele persoanei vizate');
      if (has('subjectIdentifier')) values.subject_identifier = optText(body.subjectIdentifier);
      if (has('receivedOn')) {
        values.received_on = checkedDate(body.receivedOn);
        await this.rejectFuture(c, values.received_on as string);
      }
      if (has('assigneeId')) values.assignee_id = await this.checkedAssignee(c, body.assigneeId);
      if (has('resolutionNote')) values.resolution_note = optText(body.resolutionNote);
      if (has('status')) {
        if (!STATUSES.includes(String(body.status))) badRequest('Stare invalidă');
        values.status = String(body.status);
      }
      const status = (values.status ?? before.status) as string;
      const note = has('resolutionNote') ? values.resolution_note : before.resolution_note;
      if (CLOSED.includes(status) && !note) badRequest('Notați soluția înainte de a închide cererea');
      if (values.status !== undefined && values.status !== before.status) {
        values.closed_at = CLOSED.includes(status) ? new Date() : null;
      }
      const cols = Object.keys(values);
      if (cols.length) {
        await c.query(`UPDATE gdpr_requests SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...cols.map((col) => values[col])]);
      }
      await this.audit.log(user, {
        action: 'gdpr.cerere_modificata',
        details: { cerere: id, campuri: cols, stare: status, stareAnterioara: before.status, responsabil: has('assigneeId') ? values.assignee_id : undefined },
      }, c);
      return this.fetch(c, id);
    });
  }

  /** Documentele care menționează persoana, prin aceeași căutare full-text ca lista de documente. */
  private async findDocuments(user: CurrentUser, request: { subjectName: string; subjectIdentifier: string | null }, all: boolean, requestId: number, limit: number) {
    const params: unknown[] = [requestId];
    const name = nameTerms(request.subjectName);
    const matches: string[] = [];
    if (name) {
      params.push(name);
      matches.push(`d.search @@ websearch_to_tsquery('seadoc', $${params.length})`);
    }
    if (request.subjectIdentifier) {
      params.push(identifierTerms(request.subjectIdentifier));
      matches.push(`d.search @@ websearch_to_tsquery('seadoc', $${params.length})`);
    }
    if (!matches.length) return { items: [], total: 0, notVisible: 0 };
    const where = `(${matches.join(' OR ')})${all ? '' : ' AND d.personal_data'}`;
    // Numărul documentelor fără acces rămâne vizibil: o cerere legală nu trebuie să pară rezolvată pe jumătate de căutare.
    const everyone = (await this.db.one(`SELECT count(*)::int AS n FROM documents d WHERE $1::int IS NOT NULL AND ${where}`, params)).n;
    const visible = visibleSql(user, params);
    const total = (await this.db.one(`SELECT count(*)::int AS n FROM documents d WHERE $1::int IS NOT NULL AND ${where} AND ${visible}`, params)).n;
    params.push(limit);
    const items = (await this.db.query(
      `SELECT d.id, d.title, d.reg_label AS "regLabel", d.status, d.personal_data AS "personalData", d.retention_until::text AS "retentionUntil", d.archived_at AS "archivedAt",
              t.name AS "typeName", dep.name AS "departmentName",
              (d.status <> 'eliminat' AND (d.retention_until IS NULL OR d.retention_until >= ${TODAY})) AS "retentionActive",
              g.decision, g.note AS "decisionNote"
       FROM documents d
       JOIN document_types t ON t.id = d.document_type_id JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN gdpr_request_decisions g ON g.document_id = d.id AND g.request_id = $1
       WHERE ${where} AND ${visible} ORDER BY d.created_at DESC, d.id DESC LIMIT $${params.length}`, params)).rows;
    return { items, total, notVisible: everyone - total };
  }

  async search(user: CurrentUser, id: number, all: boolean) {
    const request = await this.fetch(this.db, id);
    const found = await this.findDocuments(user, request, all, id, SEARCH_LIMIT);
    // Doar numărul de rezultate: numele persoanei nu ajunge în jurnalul imuabil.
    await this.audit.log(user, { action: 'gdpr.cerere_cautare', details: { cerere: id, domeniu: all ? 'toate' : 'date_personale', rezultate: found.total, faraAcces: found.notVisible } });
    return { scope: all ? 'all' : 'personal', limit: SEARCH_LIMIT, ...found };
  }

  async exportCsv(user: CurrentUser, id: number, all: boolean, res: Response) {
    const request = await this.fetch(this.db, id);
    const found = await this.findDocuments(user, request, all, id, EXPORT_LIMIT);
    const log = found.items.length ? (await this.db.query(
      `SELECT a.seq, a.at, a.username, a.action, a.document_id, a.ip FROM audit_log a
       WHERE a.document_id = ANY($1::int[]) AND a.action = ANY($2::text[]) ORDER BY a.seq LIMIT ${ACCESS_EXPORT_LIMIT}`,
      [found.items.map((d) => d.id), ACCESS_ACTIONS])).rows : [];
    const row = (cells: unknown[]) => cells.map(csvCell).join(';');
    const lines = [
      row(['Cerere GDPR', request.id, 'Tip', request.type, 'Primită', request.receivedOn, 'Termen', request.dueOn]),
      row(['Persoana vizată', request.subjectName, 'Identificator', request.subjectIdentifier]),
      row(['Domeniu', all ? 'Toate documentele' : 'Doar documente cu date personale', 'Documente fără acces', found.notVisible]),
      '',
      row(['Documente găsite']),
      row(['Document', 'Număr', 'Titlu', 'Tip document', 'Departament', 'Stare', 'Date personale', 'Păstrare până la', 'Decizie', 'Notă decizie']),
      ...found.items.map((d) => row([d.id, d.regLabel, d.title, d.typeName, d.departmentName, d.status, d.personalData ? 'da' : 'nu', d.retentionUntil, d.decision, d.decisionNote])),
      '',
      row(['Jurnal de acces']),
      row(['Secvență', 'Moment', 'Utilizator', 'Acțiune', 'Document', 'IP']),
      ...log.map((a) => row([a.seq, new Date(a.at).toISOString(), a.username, a.action, a.document_id, a.ip])),
    ];
    await this.audit.log(user, { action: 'gdpr.cerere_export', details: { cerere: id, domeniu: all ? 'toate' : 'date_personale', documente: found.items.length, accesari: log.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cerere-gdpr-${id}.csv"`);
    res.end('﻿' + lines.join('\r\n'));
  }

  /** Consemnează ce s-a hotărât pentru document. Documentul nu se modifică și nu se șterge niciodată de aici. */
  async decide(user: CurrentUser, id: number, documentId: number, body: { decision?: unknown; note?: unknown }) {
    const decision = String(body.decision);
    if (!DECISIONS.includes(decision)) badRequest('Decizie invalidă');
    const note = optText(body.note);
    if (decision === 'alta' && !note) badRequest('Descrieți decizia în notă');
    return this.db.tx(async (c) => {
      const request = (await c.query('SELECT status FROM gdpr_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!request) notFound('Cererea nu există');
      if (CLOSED.includes(request.status)) conflict('Cererea este închisă; redeschideți-o pentru a schimba o decizie');
      const params: unknown[] = [documentId];
      const visible = visibleSql(user, params);
      const doc = (await c.query(`SELECT d.status, d.retention_until::text AS retention_until FROM documents d WHERE d.id = $1 AND ${visible}`, params)).rows[0];
      if (!doc) notFound('Document inexistent sau fără acces');
      await c.query(
        `INSERT INTO gdpr_request_decisions (request_id, document_id, decision, note, retention_until, document_status, decided_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (request_id, document_id) DO UPDATE SET decision = excluded.decision, note = excluded.note, retention_until = excluded.retention_until,
           document_status = excluded.document_status, decided_by = excluded.decided_by, decided_at = now()`,
        [id, documentId, decision, note, doc.retention_until, doc.status, user.id]);
      await this.audit.log(user, { action: 'gdpr.cerere_decizie', documentId, details: { cerere: id, decizie: decision, pastrarePanaLa: doc.retention_until, stareDocument: doc.status } }, c);
      return { ok: true, decision, note, retentionUntil: doc.retention_until, documentStatus: doc.status };
    });
  }
}

@Controller('gdpr/requests')
@UseGuards(AuthGuard)
@RequirePerm('audit_all')
export class GdprRequestsController {
  constructor(private readonly requests: GdprRequestService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.requests.list(q);
  }

  @Post()
  create(@User() user: CurrentUser, @Body() body: Record<string, unknown>) {
    return this.requests.create(user, body);
  }

  @Get('assignees')
  assignees() {
    return this.requests.assignees();
  }

  @Get(':id')
  detail(@User() user: CurrentUser, @Param('id') id: string) {
    return this.requests.detail(user, toInt(id));
  }

  @Patch(':id')
  update(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.requests.update(user, toInt(id), body);
  }

  @Get(':id/search')
  search(@User() user: CurrentUser, @Param('id') id: string, @Query('scope') scope?: string) {
    return this.requests.search(user, toInt(id), scope === 'all');
  }

  @Get(':id/export')
  export(@User() user: CurrentUser, @Param('id') id: string, @Query('scope') scope: string | undefined, @Res() res: Response) {
    return this.requests.exportCsv(user, toInt(id), scope === 'all', res);
  }

  @Put(':id/decisions/:documentId') @HttpCode(200)
  decide(@User() user: CurrentUser, @Param('id') id: string, @Param('documentId') documentId: string, @Body() body: { decision?: unknown; note?: unknown }) {
    return this.requests.decide(user, toInt(id), toInt(documentId), body);
  }
}
