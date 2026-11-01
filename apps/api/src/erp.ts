// Date ERP importate din fișiere: parteneri, facturi, comenzi și legătura lor cu documentele.
// Existența unui API Nexus ERP nu este confirmată; ErpConnector marchează locul unde s-ar adăuga.
import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import { decodeCsv, parseCsv, parseDate, RawTable } from './csv.js';
import { Db } from './db.js';
import { DocumentsService, UploadFile } from './documents.js';
import { badRequest, conflict, notFound, optInt, optText, toInt } from './http.js';
import { CurrentUser, visibleSql } from './perms.js';

export type ErpKind = 'partener' | 'factura' | 'comanda';
const KINDS: ErpKind[] = ['partener', 'factura', 'comanda'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ERRORS_RETURNED = 200;

/** Câmpurile fiecărui tip. `required`: fără ele rândul se respinge. */
const FIELDS: Record<ErpKind, { key: string; label: string; required?: boolean; type?: 'date' | 'amount' }[]> = {
  partener: [
    { key: 'externalId', label: 'Cod extern', required: true },
    { key: 'name', label: 'Denumire', required: true },
    { key: 'taxId', label: 'CUI/CIF' },
    { key: 'status', label: 'Stare' },
  ],
  factura: [
    { key: 'externalId', label: 'Cod extern', required: true },
    { key: 'number', label: 'Număr factură', required: true },
    { key: 'partnerExternalId', label: 'Cod extern partener' },
    { key: 'issueDate', label: 'Data emiterii', type: 'date' },
    { key: 'dueDate', label: 'Scadență', type: 'date' },
    { key: 'amount', label: 'Valoare', type: 'amount' },
    { key: 'currency', label: 'Monedă' },
    { key: 'status', label: 'Stare' },
  ],
  comanda: [
    { key: 'externalId', label: 'Cod extern', required: true },
    { key: 'number', label: 'Număr comandă', required: true },
    { key: 'partnerExternalId', label: 'Cod extern partener' },
    { key: 'issueDate', label: 'Data comenzii', type: 'date' },
    { key: 'dueDate', label: 'Termen', type: 'date' },
    { key: 'amount', label: 'Valoare', type: 'amount' },
    { key: 'currency', label: 'Monedă' },
    { key: 'status', label: 'Stare' },
  ],
};

/** Sursa de date ERP. Există doar implementarea pentru fișiere; un conector API s-ar adăuga aici când se știe că există. */
export interface ErpConnector {
  readonly id: string;
  /** Citește datele sursei ca tabel, înainte de maparea coloanelor. */
  read(input: { data: Buffer }): Promise<RawTable>;
}

export class CsvErpConnector implements ErpConnector {
  readonly id = 'csv';
  async read({ data }: { data: Buffer }): Promise<RawTable> {
    if (data.includes(0)) badRequest('Fișierul nu este un CSV: conține date binare. Pentru Excel, salvați foaia ca CSV.');
    return parseCsv(decodeCsv(data));
  }
}

/** Valoarea ca text numeric: acceptă 1.234,56 și 1,234.56. Ultimul separator este cel zecimal. */
export function parseAmount(value: string): string | null {
  const clean = value.replace(/[\s ]/g, '');
  if (!/^-?[\d.,]+$/.test(clean) || !/\d/.test(clean)) return null;
  const lastDot = clean.lastIndexOf('.');
  const lastComma = clean.lastIndexOf(',');
  let normal: string;
  if (lastDot >= 0 && lastComma >= 0) {
    normal = lastDot > lastComma ? clean.replace(/,/g, '') : clean.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    normal = clean.indexOf(',') === lastComma ? clean.replace(',', '.') : clean.replace(/,/g, '');
  } else {
    normal = clean.indexOf('.') === lastDot ? clean : clean.replace(/\./g, '');
  }
  const n = Number(normal);
  return Number.isFinite(n) && Math.abs(n) < 1e16 ? normal : null;
}

export interface ImportResult {
  kind: ErpKind; dryRun: boolean; totalRows: number; created: number; updated: number; unchanged: number; rejected: number;
  errors: { line: number; reason: string }[]; errorsTruncated: boolean; unknownPartners: number;
}

const RECORD_COLUMNS = `r.id, r.kind, r.external_id AS "externalId", r.source, r.name, r.number, r.tax_id AS "taxId",
  r.partner_external_id AS "partnerExternalId", p.id AS "partnerId", p.name AS "partnerName",
  r.issue_date::text AS "issueDate", r.due_date::text AS "dueDate", r.amount::text AS amount, r.currency, r.status, r.updated_at AS "updatedAt"`;
const RECORD_FROM = `FROM erp_records r LEFT JOIN erp_records p ON p.kind = 'partener' AND p.external_id = r.partner_external_id`;

@Injectable()
export class ErpService {
  /** Sursele disponibile. Nu există încă niciun conector API. */
  readonly connectors: Record<string, ErpConnector> = { csv: new CsvErpConnector() };

  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  async preview(file: UploadFile | undefined) {
    if (!file) badRequest('Atașați un fișier');
    const table = await this.connectors.csv.read({ data: file!.buffer });
    if (!table.columns.length) badRequest('Fișierul nu are antet');
    return {
      columns: table.columns,
      sample: table.rows.slice(0, 10).map((r) => r.cells),
      totalRows: table.rows.length,
      malformed: table.malformed.length,
      fields: FIELDS,
    };
  }

  private cleanMapping(kind: ErpKind, raw: unknown, columns: string[]): Record<string, number> {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { badRequest('Maparea coloanelor nu este validă'); }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return badRequest('Maparea coloanelor nu este validă');
    const known = new Map(FIELDS[kind].map((f) => [f.key, f]));
    const out: Record<string, number> = {};
    for (const [key, column] of Object.entries(parsed as Record<string, unknown>)) {
      if (!known.has(key)) badRequest(`Câmp necunoscut în mapare: ${key}`);
      if (column === null || column === '') continue;
      const index = columns.indexOf(String(column));
      if (index < 0) badRequest(`Coloana „${String(column)}” nu există în fișier`);
      out[key] = index;
    }
    for (const field of FIELDS[kind]) {
      if (field.required && out[field.key] === undefined) badRequest(`Mapați coloana pentru câmpul obligatoriu „${field.label}”`);
    }
    return out;
  }

  /** Idempotent după (tip, cod extern): reimportul aceluiași fișier nu schimbă nimic. Valorile goale nu șterg datele existente. */
  async importFile(user: CurrentUser, file: UploadFile | undefined, input: { kind?: unknown; mapping?: unknown; dryRun?: unknown }): Promise<ImportResult> {
    if (!file) badRequest('Atașați un fișier');
    const kind = input.kind as ErpKind;
    if (!KINDS.includes(kind)) badRequest('Tip de date ERP invalid');
    const dryRun = input.dryRun === true || input.dryRun === 'true';
    const table = await this.connectors.csv.read({ data: file!.buffer });
    if (!table.columns.length) badRequest('Fișierul nu are antet');
    const mapping = this.cleanMapping(kind, input.mapping, table.columns);

    const errors = [...table.malformed];
    const accepted: { line: number; values: Record<string, string | null> }[] = [];
    const seen = new Set<string>();
    for (const row of table.rows) {
      const values: Record<string, string | null> = {};
      let problem: string | null = null;
      for (const field of FIELDS[kind]) {
        const index = mapping[field.key];
        const text = index === undefined ? null : optText(row.cells[index]);
        if (field.required && !text) { problem = `Lipsește „${field.label}”`; break; }
        if (text && field.type === 'date') {
          values[field.key] = parseDate(text);
          if (!values[field.key]) { problem = `Dată invalidă în „${field.label}”: ${text.slice(0, 40)}`; break; }
        } else if (text && field.type === 'amount') {
          values[field.key] = parseAmount(text);
          if (!values[field.key]) { problem = `Valoare invalidă în „${field.label}”: ${text.slice(0, 40)}`; break; }
        } else {
          values[field.key] = text;
        }
      }
      if (!problem && seen.has(values.externalId!)) problem = `Cod extern duplicat în fișier: ${values.externalId!.slice(0, 80)}`;
      if (problem) { errors.push({ line: row.line, reason: problem }); continue; }
      seen.add(values.externalId!);
      accepted.push({ line: row.line, values });
    }
    errors.sort((a, b) => a.line - b.line);

    const result = await this.db.tx(async (c) => {
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      for (const { values } of accepted) {
        const existing = (await c.query(
          `SELECT id, name, number, tax_id, partner_external_id, issue_date::text AS issue_date, due_date::text AS due_date, amount::numeric AS amount, currency, status
           FROM erp_records WHERE kind = $1 AND external_id = $2 FOR UPDATE`, [kind, values.externalId])).rows[0];
        if (!existing) {
          created++;
          if (dryRun) continue;
          await c.query(
            `INSERT INTO erp_records (kind, external_id, source, name, number, tax_id, partner_external_id, issue_date, due_date, amount, currency, status)
             VALUES ($1,$2,'csv',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [kind, values.externalId, values.name ?? null, values.number ?? null, values.taxId ?? null, values.partnerExternalId ?? null,
              values.issueDate ?? null, values.dueDate ?? null, values.amount ?? null, values.currency ?? null, values.status ?? null]);
          continue;
        }
        const pairs: [string, string | null | undefined, unknown][] = [
          ['name', values.name, existing.name], ['number', values.number, existing.number], ['tax_id', values.taxId, existing.tax_id],
          ['partner_external_id', values.partnerExternalId, existing.partner_external_id], ['issue_date', values.issueDate, existing.issue_date],
          ['due_date', values.dueDate, existing.due_date], ['currency', values.currency, existing.currency], ['status', values.status, existing.status],
        ];
        const changes = pairs.filter(([, next, current]) => next != null && next !== current);
        const amountChanged = values.amount != null && (existing.amount == null || Number(existing.amount) !== Number(values.amount));
        if (!changes.length && !amountChanged) { unchanged++; continue; }
        updated++;
        if (dryRun) continue;
        const sets = changes.map(([col], i) => `${col} = $${i + 2}`);
        const params: unknown[] = [existing.id, ...changes.map(([, next]) => next)];
        if (amountChanged) { params.push(values.amount); sets.push(`amount = $${params.length}`); }
        await c.query(`UPDATE erp_records SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
      }
      const referenced = [...new Set(accepted.map((a) => a.values.partnerExternalId).filter(Boolean))] as string[];
      const known = referenced.length
        ? (await c.query(`SELECT external_id FROM erp_records WHERE kind = 'partener' AND external_id = ANY($1)`, [referenced])).rows.map((r) => r.external_id)
        : [];
      const totals = { created, updated, unchanged, rejected: errors.length, unknownPartners: referenced.length - known.length };
      // O singură intrare pe import, nu una pe rând.
      if (!dryRun) await this.audit.log(user, { action: 'erp.import', details: { tip: kind, sursa: 'csv', fisier: file!.originalname.slice(0, 200), ...totals } }, c);
      return totals;
    });
    return {
      kind, dryRun, totalRows: table.rows.length + table.malformed.length, ...result,
      errors: errors.slice(0, MAX_ERRORS_RETURNED), errorsTruncated: errors.length > MAX_ERRORS_RETURNED,
    };
  }

  async search(q: Record<string, string | undefined>) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.kind) {
      if (!KINDS.includes(q.kind as ErpKind)) badRequest('Tip de date ERP invalid');
      params.push(q.kind);
      where.push(`r.kind = $${params.length}`);
    }
    const text = optText(q.q);
    if (text) {
      params.push(`%${text.replace(/[%_\\]/g, '\\$&')}%`);
      const p = `$${params.length}`;
      where.push(`(unaccent(coalesce(r.name,'')) ILIKE unaccent(${p}) OR r.number ILIKE ${p} OR r.external_id ILIKE ${p} OR r.tax_id ILIKE ${p}
        OR unaccent(coalesce(p.name,'')) ILIKE unaccent(${p}))`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await this.db.one(`SELECT count(*)::int AS n ${RECORD_FROM} ${clause}`, params))!.n;
    params.push(Math.min(optInt(q.limit) ?? 50, 200), Math.max(optInt(q.offset) ?? 0, 0));
    const items = (await this.db.query(
      `SELECT ${RECORD_COLUMNS} ${RECORD_FROM} ${clause} ORDER BY r.kind, coalesce(r.name, r.number), r.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    return { total, items };
  }

  /** Doar documentele pe care utilizatorul le poate vedea; nici numărul celorlalte nu se afișează. */
  async detail(user: CurrentUser, id: number) {
    const record = await this.db.one(`SELECT ${RECORD_COLUMNS} ${RECORD_FROM} WHERE r.id = $1`, [id]);
    if (!record) notFound('Înregistrare ERP inexistentă');
    const params: unknown[] = [id];
    const visible = visibleSql(user, params);
    const documents = (await this.db.query(
      `SELECT DISTINCT d.id, d.title, d.reg_label AS "regLabel", d.reg_date AS "regDate", d.status, l.record_id AS "viaRecordId", r.kind AS "viaKind", r.number AS "viaNumber"
       FROM document_erp_links l JOIN documents d ON d.id = l.document_id JOIN erp_records r ON r.id = l.record_id
       LEFT JOIN erp_records p ON p.kind = 'partener' AND p.external_id = r.partner_external_id
       WHERE $1::int IN (r.id, p.id) AND ${visible} ORDER BY d.id DESC LIMIT 500`, params)).rows;
    const related = record.kind === 'partener'
      ? (await this.db.query(`SELECT ${RECORD_COLUMNS} ${RECORD_FROM} WHERE r.partner_external_id = $1 ORDER BY r.issue_date DESC NULLS LAST, r.id DESC LIMIT 200`, [record.externalId])).rows
      : [];
    return { ...record, documents, related };
  }

  async linksOf(documentId: number) {
    return (await this.db.query(
      `SELECT ${RECORD_COLUMNS}, l.created_at AS "linkedAt" ${RECORD_FROM} JOIN document_erp_links l ON l.record_id = r.id
       WHERE l.document_id = $1 ORDER BY r.kind, r.id`, [documentId])).rows;
  }
}

@Controller('erp')
@UseGuards(AuthGuard)
export class ErpController {
  constructor(private readonly erp: ErpService) {}

  @Get('records')
  search(@Query() q: Record<string, string>) {
    return this.erp.search(q);
  }

  @Get('records/:id')
  detail(@User() user: CurrentUser, @Param('id') id: string) {
    return this.erp.detail(user, toInt(id));
  }

  @Post('import/preview') @HttpCode(200) @RequirePerm('users_admin')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  preview(@UploadedFile() file: UploadFile) {
    return this.erp.preview(file);
  }

  @Post('import') @HttpCode(200) @RequirePerm('users_admin')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  importFile(@User() user: CurrentUser, @UploadedFile() file: UploadFile, @Body() body: { kind?: unknown; mapping?: unknown; dryRun?: unknown }) {
    return this.erp.importFile(user, file, body);
  }
}

@Controller('documents/:id/erp-links')
@UseGuards(AuthGuard)
export class DocumentErpController {
  constructor(private readonly db: Db, private readonly docs: DocumentsService, private readonly audit: AuditService, private readonly erp: ErpService) {}

  @Get()
  async list(@User() user: CurrentUser, @Param('id') id: string) {
    await this.docs.requireVisible(user, toInt(id));
    return this.erp.linksOf(toInt(id));
  }

  @Post() @HttpCode(200)
  async add(@User() user: CurrentUser, @Param('id') id: string, @Body() body: { recordId?: unknown }) {
    const doc = await this.docs.requireVisible(user, toInt(id));
    if (['arhivat', 'eliminat'].includes(doc.status)) conflict('Documentul arhivat nu se mai poate modifica');
    const recordId = toInt(body?.recordId, 'înregistrare ERP');
    const record = await this.db.one('SELECT id, kind, external_id FROM erp_records WHERE id = $1', [recordId]);
    if (!record) notFound('Înregistrare ERP inexistentă');
    await this.db.tx(async (c) => {
      const added = await c.query(
        'INSERT INTO document_erp_links (document_id, record_id, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [doc.id, recordId, user.id]);
      if (added.rowCount) await this.audit.log(user, { action: 'erp.legatura', documentId: doc.id, details: { inregistrare: recordId, tip: record.kind, codExtern: record.external_id } }, c);
    });
    return this.erp.linksOf(doc.id);
  }

  @Delete(':recordId') @HttpCode(200)
  async remove(@User() user: CurrentUser, @Param('id') id: string, @Param('recordId') recordId: string) {
    const doc = await this.docs.requireVisible(user, toInt(id));
    if (['arhivat', 'eliminat'].includes(doc.status)) conflict('Documentul arhivat nu se mai poate modifica');
    await this.db.tx(async (c) => {
      const removed = await c.query('DELETE FROM document_erp_links WHERE document_id = $1 AND record_id = $2', [doc.id, toInt(recordId)]);
      if (removed.rowCount) await this.audit.log(user, { action: 'erp.legatura_stearsa', documentId: doc.id, details: { inregistrare: toInt(recordId) } }, c);
    });
    return this.erp.linksOf(doc.id);
  }
}
