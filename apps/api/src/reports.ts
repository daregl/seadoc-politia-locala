import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import { Db } from './db.js';
import { csvCell, optInt, optText } from './http.js';
import { can, CurrentUser } from './perms.js';

const MAX_EXPORT_ROWS = 100_000;

interface AuditFilter {
  /** Grup de acțiuni la care e limitată interogarea, indiferent de parametri. */
  only?: string;
}

function auditWhere(q: Record<string, string | undefined>, filter: AuditFilter) {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.only) add(`a.action LIKE ?`, `${filter.only}.%`);
  const documentId = optInt(q.documentId, 'document');
  if (documentId != null) add('a.document_id = ?', documentId);
  const userId = optInt(q.userId, 'utilizator');
  if (userId != null) add('a.user_id = ?', userId);
  // `arhiva` înseamnă toate acțiunile `arhiva.*`; `arhiva.eliminare` doar acțiunea exactă.
  const action = optText(q.action);
  if (action) {
    params.push(action, `${action.replace(/[%_\\]/g, '\\$&')}.%`);
    where.push(`(a.action = $${params.length - 1} OR a.action LIKE $${params.length})`);
  }
  if (optText(q.from)) add('a.at >= ?::date', q.from);
  if (optText(q.to)) add(`a.at < ?::date + 1`, q.to);
  return { params, clause: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

const auditFilterFor = (user: CurrentUser): AuditFilter => (can(user, 'audit_all') ? {} : { only: 'arhiva' });

const AUDIT_COLUMNS = `a.seq, a.at, a.username, a.action, a.document_id AS "documentId", a.ip, a.details, a.hash`;

async function auditPage(db: Db, q: Record<string, string | undefined>, filter: AuditFilter) {
  const { params, clause } = auditWhere(q, filter);
  const total = (await db.one(`SELECT count(*)::int AS n FROM audit_log a ${clause}`, params)).n;
  const limit = Math.min(Math.max(optInt(q.limit, 'limită') ?? 50, 1), 500);
  const offset = Math.max(optInt(q.offset, 'deplasare') ?? 0, 0);
  const rows = (await db.query(
    `SELECT ${AUDIT_COLUMNS} FROM audit_log a ${clause} ORDER BY a.seq DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset])).rows;
  return { total, items: rows.map((r) => ({ ...r, seq: Number(r.seq) })) };
}

@Controller('audit')
@UseGuards(AuthGuard)
export class AuditController {
  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  @Get() @RequirePerm('audit_all', 'archive_journal')
  list(@User() user: CurrentUser, @Query() q: Record<string, string>) {
    return auditPage(this.db, q, auditFilterFor(user));
  }

  @Get('export') @RequirePerm('audit_all', 'archive_journal')
  async export(@User() user: CurrentUser, @Query() q: Record<string, string>, @Res() res: Response) {
    const { params, clause } = auditWhere(q, auditFilterFor(user));
    const rows = (await this.db.query(
      `SELECT ${AUDIT_COLUMNS} FROM audit_log a ${clause} ORDER BY a.seq LIMIT ${MAX_EXPORT_ROWS}`, params)).rows;
    const header = ['Secvență', 'Moment', 'Utilizator', 'Acțiune', 'Document', 'IP', 'Detalii', 'Hash'];
    const lines = [
      header.map(csvCell).join(';'),
      ...rows.map((r) => [r.seq, new Date(r.at).toISOString(), r.username, r.action, r.documentId, r.ip, JSON.stringify(r.details), r.hash].map(csvCell).join(';')),
    ];
    await this.audit.log(user, { action: 'audit.export', details: { randuri: rows.length, filtre: q } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="jurnal-audit.csv"');
    res.end('﻿' + lines.join('\r\n'));
  }

  @Get('verify') @RequirePerm('audit_all')
  verify() {
    return this.audit.verifyChain();
  }
}

@Controller('gdpr')
@UseGuards(AuthGuard)
export class GdprController {
  constructor(private readonly db: Db) {}

  @Get('access-log') @RequirePerm('audit_all')
  accessLog(@Query() q: Record<string, string>) {
    return auditPage(this.db, q, { only: 'gdpr' });
  }
}

@Controller('reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(private readonly db: Db) {}

  @Get('summary') @RequirePerm('reports')
  async summary(@User() user: CurrentUser, @Query('departmentId') departmentId?: string) {
    // În afara administratorilor, raportul e mereu limitat la departamentul propriu, orice ar cere interogarea.
    const scope = user.role === 'admin' ? optInt(departmentId, 'departament') : (user.departmentId ?? -1);
    const [byStatus, resolution, overdue] = await Promise.all([
      this.db.query(
        `SELECT dep.name AS "departmentName", d.status, count(*)::int AS count
         FROM documents d JOIN departments dep ON dep.id = d.department_id
         WHERE $1::int IS NULL OR d.department_id = $1
         GROUP BY dep.name, d.status ORDER BY dep.name, d.status`, [scope]),
      this.db.query(
        `SELECT dep.name AS "departmentName",
                round((avg(extract(epoch FROM i.finished_at - i.started_at)) / 3600)::numeric, 2)::float8 AS "avgHours",
                count(*)::int AS count
         FROM workflow_instances i
         JOIN documents d ON d.id = i.document_id
         JOIN departments dep ON dep.id = d.department_id
         WHERE i.finished_at IS NOT NULL AND ($1::int IS NULL OR d.department_id = $1)
         GROUP BY dep.name ORDER BY dep.name`, [scope]),
      this.db.query(
        `SELECT t.id AS "taskId", t.document_id AS "documentId", d.title, u.full_name AS assignee, t.due_at AS "dueAt"
         FROM tasks t
         JOIN documents d ON d.id = t.document_id
         JOIN users u ON u.id = t.assignee_id
         WHERE t.status = 'deschisa' AND t.due_at < now() AND ($1::int IS NULL OR d.department_id = $1)
         ORDER BY t.due_at LIMIT 200`, [scope]),
    ]);
    return { byStatus: byStatus.rows, resolution: resolution.rows, overdue: overdue.rows };
  }
}
