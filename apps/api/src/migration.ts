// Ecranul „Migrare”: doar citește rulările și rapoartele produse de scripts/migrate-archive.ts.
import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import { Db } from './db.js';
import { fail, notFound, optInt, optText, toInt } from './http.js';
import { CurrentUser } from './perms.js';
import { StorageService } from './storage.js';

const RUN_COLUMNS = `id, source_name AS "sourceName", source_root AS "sourceRoot", inventory_file AS "inventoryFile", mode, status, operator,
  started_at AS "startedAt", finished_at AS "finishedAt", counts, report, report_ok AS "reportOk", report_at AS "reportAt",
  report_csv_key IS NOT NULL AS "hasCsv", report_pdf_key IS NOT NULL AS "hasPdf"`;

@Controller('admin/migration')
@UseGuards(AuthGuard)
@RequirePerm('users_admin')
export class MigrationController {
  constructor(private readonly db: Db, private readonly storage: StorageService, private readonly audit: AuditService) {}

  @Get('runs')
  async runs() {
    return (await this.db.query(`SELECT ${RUN_COLUMNS} FROM migration_runs ORDER BY id DESC LIMIT 200`)).rows;
  }

  @Get('runs/:id')
  async run(@Param('id') id: string) {
    const run = await this.db.one(`SELECT ${RUN_COLUMNS} FROM migration_runs WHERE id = $1`, [toInt(id)]);
    if (!run) notFound('Rulare inexistentă');
    return run;
  }

  /** Elementele unei rulări, implicit cele cu probleme. */
  @Get('runs/:id/items')
  async items(@Param('id') id: string, @Query() q: Record<string, string>) {
    const status = optText(q.status);
    const params: unknown[] = [toInt(id)];
    let filter = `AND (status IN ('esuat','coliziune','refuzat') OR verify_status = 'nepotrivire')`;
    if (status === 'toate') filter = '';
    else if (status) { params.push(status); filter = `AND status = $2`; }
    const total = (await this.db.one(`SELECT count(*)::int AS n FROM migration_items WHERE run_id = $1 ${filter}`, params))!.n;
    params.push(Math.min(optInt(q.limit) ?? 100, 500), Math.max(optInt(q.offset) ?? 0, 0));
    const items = (await this.db.query(
      `SELECT id, rel_path AS "relPath", size_bytes::text AS "sizeBytes", sha256, status, document_id AS "documentId", reg_label AS "regLabel", detail,
         verify_status AS "verifyStatus", verified_sha256 AS "verifiedSha256"
       FROM migration_items WHERE run_id = $1 ${filter} ORDER BY id LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    return { total, items };
  }

  @Get('runs/:id/report/:format')
  async report(@User() user: CurrentUser, @Param('id') id: string, @Param('format') format: string, @Res() res: Response) {
    if (format !== 'csv' && format !== 'pdf') notFound('Format necunoscut');
    const run = await this.db.one('SELECT report_csv_key, report_pdf_key FROM migration_runs WHERE id = $1', [toInt(id)]);
    if (!run) notFound('Rulare inexistentă');
    const key = format === 'csv' ? run.report_csv_key : run.report_pdf_key;
    if (!key) fail(404, 'Raportul nu a fost generat. Rulați comanda „report” din linia de comandă.');
    const data = await this.storage.get(key);
    await this.audit.log(user, { action: 'migrare.raport_descarcat', details: { rulare: toInt(id), format } });
    res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf');
    res.setHeader('Content-Length', data.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="raport-migrare-${toInt(id)}.${format}"`);
    res.end(data);
  }
}
