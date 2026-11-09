import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import crypto from 'node:crypto';
import { AuditService } from './audit.js';
import { AuthGuard, AuthService, RequirePerm, User } from './auth.js';
import { config } from './config.js';
import { Db, Queryable } from './db.js';
import { badRequest, conflict, csvCell, fail, forbidden, notFound, optInt, optText, toInt } from './http.js';
import { OcrService } from './ocr.js';
import { can, CurrentUser, visibleSql } from './perms.js';
import { verifyPdfBytes } from './pdf-verify-run.js';
import { StorageService } from './storage.js';

export interface UploadFile { originalname: string; mimetype: string; buffer: Buffer; size: number }

const ALLOWED_MIME = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
]);
const INLINE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff', txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
};
const OOXML_MIME = /officedocument/;
const OLE_MIME = new Set(['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint']);
const fixName = (name: string) => Buffer.from(name, 'latin1').toString('utf8');

/** Tipul se stabilește după extensie și conținut, nu după ce declară browserul. */
export function detectMime(file: UploadFile, name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const mime = Object.hasOwn(EXT_MIME, ext) ? EXT_MIME[ext] : null;
  if (!mime || !ALLOWED_MIME.has(mime)) return badRequest(`Tip de fișier neacceptat: ${ext || 'fără extensie'}`);
  const head = file.buffer.subarray(0, 4).toString('latin1');
  const invalid = (label: string) => badRequest(`Fișierul nu este un ${label} valid`);
  if (mime === 'application/pdf' && head !== '%PDF') invalid('PDF');
  if (mime === 'image/png' && !head.startsWith('\x89PNG')) invalid('PNG');
  if (mime === 'image/jpeg' && !head.startsWith('\xff\xd8')) invalid('JPEG');
  if (mime === 'image/tiff' && head !== 'II*\0' && head !== 'MM\0*') invalid('TIFF');
  if (OOXML_MIME.test(mime) && !head.startsWith('PK')) invalid('document Office');
  if (OLE_MIME.has(mime) && head !== '\xd0\xcf\x11\xe0') invalid('document Office');
  if (mime === 'text/plain' && file.buffer.includes(0)) invalid('fișier text');
  return mime;
}

export interface NewDocument {
  title?: string; direction?: string; registerId?: unknown; issuer?: string; recipient?: string; summary?: string; dueDate?: string;
  documentTypeId?: unknown; departmentId?: unknown; folderId?: unknown; metadata?: unknown; personalData?: unknown;
  linkToId?: unknown; linkKind?: string; confidential?: unknown;
}

export const LINK_KINDS = ['raspuns_la', 'anexa_la', 'conex'];
const CLOSED_DOC = ['arhivat', 'eliminat', 'anulat'];

const LIST_COLUMNS = `d.id, d.title, d.direction, d.reg_label AS "regLabel", d.reg_date AS "regDate", d.issuer, d.recipient, d.status,
  d.due_date AS "dueDate", d.created_at AS "createdAt", d.personal_data AS "personalData", d.confidential,
  t.name AS "typeName", dep.name AS "departmentName", f.name AS "folderName",
  EXISTS (SELECT 1 FROM favorites fv WHERE fv.document_id = d.id AND fv.user_id = $1) AS favorite`;
const LIST_JOINS = `FROM documents d
  JOIN document_types t ON t.id = d.document_type_id
  JOIN departments dep ON dep.id = d.department_id
  LEFT JOIN folders f ON f.id = d.folder_id`;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly ocr: OcrService,
    private readonly auth: AuthService,
  ) {
    this.ocr.afterProcess = (versionId) => this.detectDuplicates(versionId);
  }

  /** `trusted`: documentul îl generează aplicația dintr-o lucrare la care utilizatorul are deja drept, fără dreptul de registratură. */
  async create(user: CurrentUser, input: NewDocument, file: UploadFile | undefined, inTx?: (c: Queryable, doc: { id: number; regLabel: string | null }) => Promise<void>, opts: { trusted?: boolean } = {}) {
    if (!opts.trusted && !can(user, 'register')) forbidden();
    const title = optText(input.title);
    if (!title) badRequest('Titlul este obligatoriu');
    if (!file) badRequest('Atașați un fișier');
    const name = fixName(file!.originalname);
    const mime = detectMime(file!, name);
    const typeId = toInt(input.documentTypeId, 'tip document');
    const departmentId = optInt(input.departmentId) ?? user.departmentId;
    if (departmentId == null) badRequest('Departamentul este obligatoriu');
    const type = await this.db.one('SELECT * FROM document_types WHERE id = $1', [typeId]);
    if (!type) badRequest('Tip de document inexistent');
    const metadata = this.validateMetadata(type, input.metadata);
    const direction = optText(input.direction) ?? 'intern';
    if (!['intrat', 'iesit', 'intern'].includes(direction)) badRequest('Tip de înregistrare invalid');
    const dueDate = optText(input.dueDate);
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) badRequest('Termen invalid');
    const registerId = optInt(input.registerId, 'registru');
    const linkToId = optInt(input.linkToId, 'legătură');
    const linkKind = linkToId == null ? null : optText(input.linkKind) ?? 'raspuns_la';
    if (linkKind && !LINK_KINDS.includes(linkKind)) badRequest('Tip de legătură invalid');
    if (linkToId != null) await this.requireVisible(user, linkToId);
    const key = await this.storage.put(file!.buffer);
    const sha256 = crypto.createHash('sha256').update(file!.buffer).digest('hex');

    try {
      return await this.db.tx(async (c) => {
        const number = registerId == null ? null : await this.nextNumber(c, registerId);
        const doc = (await c.query(
          `INSERT INTO documents (title, direction, register_id, reg_number, reg_year, reg_label, reg_date, issuer, recipient, summary, due_date,
             document_type_id, department_id, folder_id, owner_id, metadata, personal_data, confidential)
           VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $3::int IS NULL THEN NULL ELSE now() END,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING id, reg_label AS "regLabel"`,
          [title, direction, registerId, number?.number ?? null, number?.year ?? null, number?.label ?? null,
            optText(input.issuer), optText(input.recipient), optText(input.summary), dueDate, typeId, departmentId, optInt(input.folderId, 'dosar'), user.id,
            JSON.stringify(metadata), input.personalData === true || input.personalData === 'true',
            input.confidential === true || input.confidential === 'true'])).rows[0];
        const version = (await c.query(
          `INSERT INTO document_versions (document_id, version_no, filename, mime, size_bytes, sha256, storage_key, created_by)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [doc.id, name, mime, file!.size, sha256, key, user.id])).rows[0];
        if (linkToId != null) await c.query('INSERT INTO document_links VALUES ($1,$2,$3)', [doc.id, linkToId, linkKind]);
        await this.audit.log(user, { action: 'document.inregistrat', documentId: doc.id, details: { numar: doc.regLabel, fisier: name, sha256 } }, c);
        await inTx?.(c, doc);
        return { id: doc.id, regLabel: doc.regLabel, versionId: version.id };
      });
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
  }

  private validateMetadata(type: any, raw: unknown): Record<string, string> {
    let parsed: unknown = raw ?? {};
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw || '{}'); } catch { badRequest('Metadate invalide'); }
    }
    const values = parsed as Record<string, unknown>;
    const clean: Record<string, string> = {};
    for (const field of type.fields as { key: string; label: string; type?: string; required?: boolean }[]) {
      const value = optText(values[field.key]);
      if (field.required && !value) badRequest(`Câmp obligatoriu: ${field.label}`);
      if (!value) continue;
      if (field.type === 'number' && !Number.isFinite(Number(value))) badRequest(`Câmpul ${field.label} trebuie să fie un număr`);
      if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) badRequest(`Câmpul ${field.label} trebuie să fie o dată`);
      clean[field.key] = value;
    }
    return clean;
  }

  private async nextNumber(c: Queryable, registerId: number) {
    const reg = (await c.query('SELECT code FROM registers WHERE id = $1 AND active', [registerId])).rows[0];
    if (!reg) badRequest('Registru inexistent');
    const row = (await c.query(
      `INSERT INTO register_counters (register_id, year, last_number)
       VALUES ($1, extract(year FROM now() AT TIME ZONE 'Europe/Bucharest')::int, 1)
       ON CONFLICT (register_id, year) DO UPDATE SET last_number = register_counters.last_number + 1
       RETURNING year, last_number`, [registerId])).rows[0];
    return { number: row.last_number as number, year: row.year as number, label: `${reg.code}-${String(row.last_number).padStart(5, '0')}/${row.year}` };
  }

  /** Accesul de citire nu dă dreptul de a înlocui fișierul. */
  async canAddVersion(user: CurrentUser, doc: any): Promise<boolean> {
    if (CLOSED_DOC.includes(doc.status)) return false;
    // Cât timp fluxul rulează, conținutul avizat nu se schimbă, decât la o cerere de completare.
    if (doc.status === 'in_flux') {
      return !!(await this.db.one(
        `SELECT 1 AS x FROM tasks WHERE document_id = $1 AND assignee_id = $2 AND kind = 'completare' AND status = 'deschisa'`, [doc.id, user.id]));
    }
    if (user.role === 'admin' || doc.owner_id === user.id) return true;
    const sameDepartment = doc.department_id === user.departmentId;
    return sameDepartment && (user.role === 'manager' || can(user, 'register'));
  }

  async addVersion(user: CurrentUser, documentId: number, file: UploadFile | undefined) {
    const doc = await this.requireVisible(user, documentId);
    if (CLOSED_DOC.includes(doc.status)) conflict('Documentul arhivat sau anulat nu se mai poate modifica');
    if (!(await this.canAddVersion(user, doc))) forbidden('Nu puteți încărca o versiune nouă pentru acest document');
    if (!file) badRequest('Atașați un fișier');
    const name = fixName(file!.originalname);
    const mime = detectMime(file!, name);
    const key = await this.storage.put(file!.buffer);
    const sha256 = crypto.createHash('sha256').update(file!.buffer).digest('hex');
    try {
      return await this.db.tx(async (c) => {
        await c.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [documentId]);
        const no = (await c.query('SELECT coalesce(max(version_no), 0) + 1 AS n FROM document_versions WHERE document_id = $1', [documentId])).rows[0].n;
        const v = (await c.query(
          `INSERT INTO document_versions (document_id, version_no, filename, mime, size_bytes, sha256, storage_key, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, version_no AS "versionNo"`,
          [documentId, no, name, mime, file!.size, sha256, key, user.id])).rows[0];
        await this.audit.log(user, { action: 'document.versiune_noua', documentId, details: { versiune: no, fisier: name, sha256 } }, c);
        return v;
      });
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
  }

  /** Lucrările din care face parte documentul; doar numărul și tipul, fără date despre petent. */
  async casesOf(documentId: number) {
    return (await this.db.query(
      `SELECT c.id, c.kind, c.reg_label AS "regLabel", cd.role FROM case_documents cd JOIN cases c ON c.id = cd.case_id
       WHERE cd.document_id = $1 ORDER BY c.id`, [documentId])).rows;
  }

  /** Anularea păstrează numărul în registru, cu motivul; documentul nu se mai poate modifica după aceea. */
  async cancel(user: CurrentUser, id: number, reason: unknown) {
    if (!can(user, 'register')) forbidden();
    const text = optText(reason);
    if (!text || text.length < 5) badRequest('Scrieți motivul anulării (cel puțin 5 caractere)');
    const doc = await this.requireVisible(user, id);
    if (doc.reg_label == null) conflict('Documentul nu are număr de înregistrare');
    if (doc.status === 'in_flux') conflict('Documentul este într-un flux; opriți întâi fluxul');
    if (!['inregistrat', 'aprobat', 'respins'].includes(doc.status)) conflict('Documentul nu mai poate fi anulat în starea curentă');
    return this.db.tx(async (c) => {
      await c.query(`UPDATE documents SET status = 'anulat', cancel_reason = $2, cancelled_at = now(), cancelled_by = $3 WHERE id = $1`, [id, text, user.id]);
      await this.audit.log(user, { action: 'document.anulat', documentId: id, details: { numar: doc.reg_label, motiv: text, stareAnterioara: doc.status } }, c);
      return { ok: true, status: 'anulat', cancelReason: text };
    });
  }

  async requireVisible(user: CurrentUser, id: number) {
    const params: unknown[] = [id];
    const where = visibleSql(user, params);
    const doc = await this.db.one(`SELECT d.* FROM documents d WHERE d.id = $1 AND ${where}`, params);
    if (!doc) notFound('Document inexistent sau fără acces');
    return doc;
  }

  async list(user: CurrentUser, q: Record<string, string | undefined>) {
    const params: unknown[] = [user.id];
    const where: string[] = [];
    where.push(visibleSql(user, params));
    let rank = '';
    let headline = 'NULL::text AS snippet';
    const text = optText(q.q);
    if (text) {
      params.push(text);
      const p = `$${params.length}`;
      // Numărul de registru se caută și parțial; textul prin indexul full-text.
      params.push(`%${text.replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(d.search @@ websearch_to_tsquery('seadoc', ${p}) OR d.reg_label ILIKE $${params.length})`);
      rank = `ts_rank(d.search, websearch_to_tsquery('seadoc', ${p})) DESC,`;
      headline = `ts_headline('seadoc', d.content_text, websearch_to_tsquery('seadoc', ${p}), 'MaxFragments=1,MaxWords=24,MinWords=8,StartSel=<mark>,StopSel=</mark>') AS snippet`;
    }
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (optText(q.number)) add(`d.reg_label ILIKE ?`, `%${String(q.number).replace(/[%_\\]/g, '\\$&')}%`);
    if (optText(q.from)) add(`d.created_at >= ?::date`, q.from);
    if (optText(q.to)) add(`d.created_at < ?::date + 1`, q.to);
    if (optInt(q.typeId) != null) add('d.document_type_id = ?', optInt(q.typeId));
    if (optInt(q.departmentId) != null) add('d.department_id = ?', optInt(q.departmentId));
    if (optInt(q.folderId) != null) add('d.folder_id = ?', optInt(q.folderId));
    if (optText(q.status)) add('d.status = ?', q.status);
    if (optText(q.direction)) add('d.direction = ?', q.direction);
    // Documentele legate de o înregistrare ERP; pentru un partener, și cele legate de facturile sau comenzile lui.
    if (optInt(q.erpRecordId) != null) add(`d.id IN (SELECT l.document_id FROM document_erp_links l JOIN erp_records r ON r.id = l.record_id
      LEFT JOIN erp_records p ON p.kind = 'partener' AND p.external_id = r.partner_external_id WHERE ?::int IN (r.id, p.id))`, optInt(q.erpRecordId));
    if (optText(q.issuer)) add(`unaccent(coalesce(d.issuer,'')) ILIKE unaccent(?)`, `%${String(q.issuer).replace(/[%_\\]/g, '\\$&')}%`);
    if (q.favorites === '1') where.push(`EXISTS (SELECT 1 FROM favorites fv2 WHERE fv2.document_id = d.id AND fv2.user_id = $1)`);
    // Metadate: meta.camp=valoare
    for (const [key, value] of Object.entries(q)) {
      if (key.startsWith('meta.') && optText(value)) {
        params.push(key.slice(5));
        params.push(`%${String(value).replace(/[%_\\]/g, '\\$&')}%`);
        where.push(`unaccent(coalesce(d.metadata->>$${params.length - 1},'')) ILIKE unaccent($${params.length})`);
      }
    }
    const limit = Math.min(optInt(q.limit) ?? 50, 200);
    const offset = Math.max(optInt(q.offset) ?? 0, 0);
    const clause = where.join(' AND ');
    // $1 (utilizatorul curent) e folosit doar de coloana `favorite`; și aici trebuie să aibă un tip.
    const total = (await this.db.one(`SELECT count(*)::int AS n FROM documents d WHERE $1::int IS NOT NULL AND ${clause}`, params)).n;
    params.push(limit, offset);
    const rows = (await this.db.query(
      // Extrasul se calculează doar pentru pagina afișată: ts_headline e scump, iar în SELECT-ul
      // cu ORDER BY PostgreSQL l-ar calcula pentru toate rezultatele înainte de sortare.
      `SELECT ${LIST_COLUMNS}, ${headline} ${LIST_JOINS}
       JOIN (SELECT d.id, row_number() OVER (ORDER BY ${rank} d.created_at DESC, d.id DESC) AS pos
             FROM documents d WHERE ${clause}
             ORDER BY pos LIMIT $${params.length - 1} OFFSET $${params.length}) page ON page.id = d.id
       ORDER BY page.pos`, params)).rows;
    if (text) await this.audit.log(user, { action: 'cautare', details: { text, rezultate: total } });
    return { total, items: rows };
  }

  async detail(user: CurrentUser, id: number) {
    const doc = await this.requireVisible(user, id);
    const versions = (await this.db.query(
      `SELECT v.id, v.version_no AS "versionNo", v.filename, v.mime, v.size_bytes::int AS "sizeBytes", v.sha256, v.ocr_status AS "ocrStatus", v.ocr_used AS "ocrUsed",
              v.searchable_key IS NOT NULL AS "hasSearchable", v.storage_key IS NOT NULL AS "hasFile",
              v.created_at AS "createdAt", u.full_name AS "createdBy"
       FROM document_versions v JOIN users u ON u.id = v.created_by WHERE v.document_id = $1 ORDER BY v.version_no DESC`, [id])).rows;
    const linkParams: unknown[] = [id];
    const linkVisible = visibleSql(user, linkParams);
    const links = (await this.db.query(
      `SELECT l.kind, CASE WHEN l.from_id = $1 THEN 'catre' ELSE 'de_la' END AS dir, d.id, d.title, d.reg_label AS "regLabel"
       FROM document_links l JOIN documents d ON d.id = CASE WHEN l.from_id = $1 THEN l.to_id ELSE l.from_id END
       WHERE (l.from_id = $1 OR l.to_id = $1) AND ${linkVisible}`, linkParams)).rows;
    const type = await this.db.one('SELECT id, name, nomenclator_code AS "nomenclatorCode", retention_years AS "retentionYears", fields FROM document_types WHERE id = $1', [doc.document_type_id]);
    const names = await this.db.one(
      `SELECT dep.name AS department, u.full_name AS owner, r.name AS register, f.name AS folder, cu.full_name AS "cancelledBy"
       FROM documents d JOIN departments dep ON dep.id = d.department_id JOIN users u ON u.id = d.owner_id
       LEFT JOIN registers r ON r.id = d.register_id LEFT JOIN folders f ON f.id = d.folder_id LEFT JOIN users cu ON cu.id = d.cancelled_by WHERE d.id = $1`, [id]);
    const favorite = !!(await this.db.one('SELECT 1 AS x FROM favorites WHERE user_id = $1 AND document_id = $2', [user.id, id]));
    const signatures = (await this.db.query(
      `SELECT s.id, s.kind, s.sha256, s.signed_at AS "signedAt", u.full_name AS signer, v.version_no AS "versionNo",
              s.certificate_subject AS "certificateSubject", s.certificate_issuer AS "certificateIssuer",
              s.test_indicators AS "testIndicators", s.chain_status AS "chainStatus", s.verdict
       FROM signatures s JOIN users u ON u.id = s.signer_id JOIN document_versions v ON v.id = s.version_id WHERE s.document_id = $1 ORDER BY s.id`, [id])).rows;
    await this.audit.log(user, { action: doc.status === 'arhivat' ? 'arhiva.consultare' : 'document.vizualizare', documentId: id });
    if (doc.personal_data) await this.audit.log(user, { action: 'gdpr.acces_date_personale', documentId: id });
    return {
      id: doc.id, title: doc.title, direction: doc.direction, regLabel: doc.reg_label, regDate: doc.reg_date, issuer: doc.issuer, recipient: doc.recipient,
      summary: doc.summary, dueDate: doc.due_date, status: doc.status, metadata: doc.metadata, personalData: doc.personal_data, createdAt: doc.created_at,
      confidential: doc.confidential, cancelReason: doc.cancel_reason, cancelledAt: doc.cancelled_at, cancelledBy: names.cancelledBy,
      cases: await this.casesOf(id),
      canCancel: can(user, 'register') && ['inregistrat', 'aprobat', 'respins'].includes(doc.status) && doc.reg_label != null,
      archivedAt: doc.archived_at, retentionUntil: doc.retention_until, type, ...names, ownerId: doc.owner_id, departmentId: doc.department_id,
      favorite, versions, links, signatures, duplicates: await this.duplicatesOf(user, id),
      canEdit: !CLOSED_DOC.includes(doc.status),
      canAddVersion: await this.canAddVersion(user, doc),
      canArchive: !['arhivat', 'eliminat', 'in_flux', 'anulat'].includes(doc.status) && (can(user, 'archive') || doc.owner_id === user.id || (user.role === 'manager' && doc.department_id === user.departmentId)),
    };
  }

  async duplicatesOf(user: CurrentUser, id: number) {
    const params: unknown[] = [id];
    const visible = visibleSql(user, params);
    const rows = (await this.db.query(
      `SELECT DISTINCT ON (m.match_document_id, m.match_kind) m.match_kind AS kind, m.score, d.id, d.title, d.reg_label AS "regLabel", ${visible} AS visible
       FROM duplicate_matches m JOIN documents d ON d.id = m.match_document_id WHERE m.document_id = $1
       ORDER BY m.match_document_id, m.match_kind, m.version_id DESC`, params)).rows;
    // Un duplicat fără acces apare doar ca avertisment, fără titlu sau legătură.
    return rows.map((r) => (r.visible ? { kind: r.kind, score: r.score, id: r.id, title: r.title, regLabel: r.regLabel } : { kind: r.kind, score: r.score, restricted: true }));
  }

  async detectDuplicates(versionId: number) {
    const v = await this.db.one(
      `SELECT v.id, v.document_id, v.sha256, left(v.text_content, 20000) AS body, v.filename, d.title
       FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = $1`, [versionId]);
    if (!v) return;
    const insert = (matchId: number, kind: string, score: number) => this.db.query(
      `INSERT INTO duplicate_matches VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [v.id, v.document_id, matchId, kind, score]);
    const same = await this.db.query(
      `SELECT DISTINCT document_id FROM document_versions WHERE sha256 = $1 AND document_id <> $2`, [v.sha256, v.document_id]);
    for (const r of same.rows) await insert(r.document_id, 'amprenta', 1);
    const byName = await this.db.query(
      `SELECT id, similarity(title, $1) AS s FROM documents WHERE id <> $2 AND status <> 'eliminat' AND title % $1 AND similarity(title, $1) > 0.6 ORDER BY s DESC LIMIT 5`, [v.title, v.document_id]);
    for (const r of byName.rows) await insert(r.id, 'denumire', r.s);
    if (v.body.trim().length >= 80) {
      // Prefiltru full-text cu termenii documentului, apoi similaritate pe text.
      const byText = await this.db.query(
        `SELECT id, similarity(left(content_text, 20000), $1) AS s FROM documents
         WHERE id <> $2 AND status <> 'eliminat' AND length(content_text) >= 80
           AND length(content_text) BETWEEN length($1) / 2 AND length($1) * 2
           AND similarity(left(content_text, 20000), $1) > 0.7
         ORDER BY s DESC LIMIT 5`, [v.body, v.document_id]);
      for (const r of byText.rows) await insert(r.id, 'text', r.s);
    }
    const flagged = await this.db.one('SELECT count(*)::int AS n FROM duplicate_matches WHERE version_id = $1', [v.id]);
    if (flagged.n > 0) await this.audit.log(null, { action: 'document.duplicat_detectat', documentId: v.document_id, details: { potriviri: flagged.n } });
  }

  async file(user: CurrentUser, documentId: number, versionNo: number | null, kind: string, download: boolean, res: Response) {
    const doc = await this.requireVisible(user, documentId);
    const v = await this.db.one(
      `SELECT * FROM document_versions WHERE document_id = $1 AND ($2::int IS NULL OR version_no = $2) ORDER BY version_no DESC LIMIT 1`, [documentId, versionNo]);
    if (!v) notFound('Versiune inexistentă');
    if (!v.storage_key) fail(410, 'Fișierul a fost eliminat la expirarea termenului de păstrare');
    const useSearchable = kind !== 'original' && v.searchable_key;
    const data = await this.storage.get(useSearchable ? v.searchable_key : v.storage_key);
    const mime = useSearchable ? 'application/pdf' : v.mime;
    const filename = useSearchable ? v.filename.replace(/\.[^.]+$/, '') + '-cautabil.pdf' : v.filename;
    const inline = !download && INLINE_MIME.has(mime);
    await this.audit.log(user, { action: doc.status === 'arhivat' ? 'arhiva.consultare' : download ? 'document.descarcare' : 'document.previzualizare', documentId, details: { versiune: v.version_no } });
    if (doc.personal_data) await this.audit.log(user, { action: 'gdpr.acces_date_personale', documentId, details: { versiune: v.version_no } });
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', data.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(data);
  }

  async signInternal(user: CurrentUser, documentId: number, password: string, client: Queryable = this.db) {
    const u = (await client.query('SELECT username, auth_source, password_hash, locked_until FROM users WHERE id = $1', [user.id])).rows[0];
    if (u.locked_until && new Date(u.locked_until) > new Date()) fail(423, 'Cont blocat temporar după încercări eșuate. Încercați mai târziu.');
    if (!(await this.auth.confirmPassword(u, password))) fail(401, 'Parola de confirmare este incorectă');
    const v = (await client.query('SELECT id, sha256 FROM document_versions WHERE document_id = $1 ORDER BY version_no DESC LIMIT 1', [documentId])).rows[0];
    const signedAt = new Date().toISOString();
    const seal = signatureSeal(documentId, v.id, user.id, v.sha256, signedAt);
    const s = (await client.query(
      `INSERT INTO signatures (document_id, version_id, signer_id, kind, sha256, signed_at, seal) VALUES ($1,$2,$3,'interna',$4,$5,$6) RETURNING id`,
      [documentId, v.id, user.id, v.sha256, signedAt, seal])).rows[0];
    await this.audit.log(user, { action: 'document.semnatura_interna', documentId, details: { semnatura: s.id, sha256: v.sha256 } }, client);
    return s;
  }

  /** Parola greșită la semnare contează la blocarea contului, ca la autentificare. */
  async registerSignFailure(user: CurrentUser) {
    const policy = (await this.db.one(`SELECT value FROM settings WHERE key = 'password_policy'`))!.value;
    await this.db.query(
      `UPDATE users SET
         locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
         failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END
       WHERE id = $1`, [user.id, policy.maxFailedAttempts, policy.lockMinutes]);
  }

  async verifySignatures(user: CurrentUser, documentId: number) {
    await this.requireVisible(user, documentId);
    const rows = (await this.db.query(
      `SELECT s.*, s.signed_at, v.sha256 AS version_sha, v.storage_key FROM signatures s JOIN document_versions v ON v.id = s.version_id WHERE s.document_id = $1 ORDER BY s.id`, [documentId])).rows;
    const out = [];
    for (const s of rows) {
      const isCertificate = s.kind === 'certificat';
      const sealed = isCertificate ? `${s.sha256}|${s.certificate_sha256}` : s.sha256;
      const expected = signatureSeal(documentId, s.version_id, s.signer_id, sealed, new Date(s.signed_at).toISOString());
      let contentOk = false;
      // Semnătura cu certificat se verifică și criptografic, pe PDF-ul stocat; rezultatul nu spune nimic despre statutul calificat.
      let certificate: Record<string, unknown> | undefined;
      if (s.storage_key) {
        const data = await this.storage.get(s.storage_key);
        contentOk = crypto.createHash('sha256').update(data).digest('hex') === s.sha256;
        if (isCertificate) {
          const report = await verifyPdfBytes(data);
          const own = report.signatures.filter((r) => r.signer?.sha256 === s.certificate_sha256).pop();
          contentOk = contentOk && !!own?.digestMatches && !!own?.cmsSignatureValid;
          certificate = { verdict: own?.verdict ?? 'negasita', chain: own?.chain?.status ?? null, message: own?.chain?.message ?? report.message, testIndicators: own?.testIndicators ?? [] };
        }
      }
      const seal = Buffer.from(s.seal, 'hex');
      const exp = Buffer.from(expected, 'hex');
      out.push({ id: s.id, kind: s.kind, valid: contentOk && seal.length === exp.length && crypto.timingSafeEqual(seal, exp), ...(certificate ? { certificate } : {}) });
    }
    return out;
  }
}

export function signatureSeal(documentId: number, versionId: number, signerId: number, sha256: string, signedAt: string) {
  return crypto.createHmac('sha256', config.signatureSecret).update([documentId, versionId, signerId, sha256, signedAt].join('|')).digest('hex');
}

@Controller('documents')
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(private readonly docs: DocumentsService, private readonly db: Db, private readonly audit: AuditService) {}

  @Get()
  list(@User() user: CurrentUser, @Query() q: Record<string, string>) {
    return this.docs.list(user, q);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes } }))
  create(@User() user: CurrentUser, @Body() body: NewDocument, @UploadedFile() file: UploadFile) {
    return this.docs.create(user, body, file);
  }

  @Get(':id')
  detail(@User() user: CurrentUser, @Param('id') id: string) {
    return this.docs.detail(user, toInt(id));
  }

  @Get(':id/status')
  async status(@User() user: CurrentUser, @Param('id') id: string) {
    await this.docs.requireVisible(user, toInt(id));
    return { versions: (await this.db.query(`SELECT version_no AS "versionNo", ocr_status AS "ocrStatus", ocr_used AS "ocrUsed", searchable_key IS NOT NULL AS "hasSearchable" FROM document_versions WHERE document_id = $1 ORDER BY version_no DESC`, [toInt(id)])).rows, duplicates: await this.docs.duplicatesOf(user, toInt(id)) };
  }

  @Get(':id/text')
  async text(@User() user: CurrentUser, @Param('id') id: string) {
    const doc = await this.docs.requireVisible(user, toInt(id));
    if (doc.status === 'arhivat') await this.audit.log(user, { action: 'arhiva.consultare', documentId: doc.id, details: { text: true } });
    if (doc.personal_data) await this.audit.log(user, { action: 'gdpr.acces_date_personale', documentId: doc.id, details: { text: true } });
    return { text: doc.content_text };
  }

  @Get(':id/file')
  file(@User() user: CurrentUser, @Param('id') id: string, @Query() q: Record<string, string>, @Res() res: Response) {
    return this.docs.file(user, toInt(id), optInt(q.version), q.kind ?? 'searchable', q.download === '1', res);
  }

  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes } }))
  addVersion(@User() user: CurrentUser, @Param('id') id: string, @UploadedFile() file: UploadFile) {
    return this.docs.addVersion(user, toInt(id), file);
  }

  @Put(':id/favorite') @HttpCode(200)
  async favorite(@User() user: CurrentUser, @Param('id') id: string) {
    await this.docs.requireVisible(user, toInt(id));
    await this.db.query('INSERT INTO favorites (user_id, document_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, toInt(id)]);
    return { favorite: true };
  }

  @Delete(':id/favorite') @HttpCode(200)
  async unfavorite(@User() user: CurrentUser, @Param('id') id: string) {
    await this.db.query('DELETE FROM favorites WHERE user_id = $1 AND document_id = $2', [user.id, toInt(id)]);
    return { favorite: false };
  }

  @Post(':id/links') @HttpCode(200)
  async link(@User() user: CurrentUser, @Param('id') id: string, @Body() body: { toId?: unknown; kind?: string }) {
    const doc = await this.docs.requireVisible(user, toInt(id));
    if (CLOSED_DOC.includes(doc.status)) conflict('Documentul arhivat sau anulat nu se mai poate modifica');
    const toId = toInt(body.toId, 'document');
    await this.docs.requireVisible(user, toId);
    if (toId === doc.id) badRequest('Un document nu se poate lega de el însuși');
    if (!LINK_KINDS.includes(String(body.kind))) badRequest('Tip de legătură invalid');
    await this.db.query('INSERT INTO document_links VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [doc.id, toId, body.kind]);
    await this.audit.log(user, { action: 'document.legatura', documentId: doc.id, details: { catre: toId, tip: body.kind } });
    return { ok: true };
  }

  @Post(':id/cancel') @HttpCode(200)
  cancel(@User() user: CurrentUser, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    return this.docs.cancel(user, toInt(id), body.reason);
  }

  @Get(':id/signatures/verify')
  verify(@User() user: CurrentUser, @Param('id') id: string) {
    return this.docs.verifySignatures(user, toInt(id));
  }

  @Get('export/register') @RequirePerm('register')
  async exportRegister(@User() user: CurrentUser, @Query() q: Record<string, string>, @Res() res: Response) {
    const registerId = toInt(q.registerId, 'registru');
    const year = optInt(q.year) ?? new Date().getFullYear();
    const params: unknown[] = [registerId, year];
    const visible = visibleSql(user, params);
    const rows = (await this.db.query(
      `SELECT d.reg_label, d.reg_date, d.direction, d.title, d.issuer, d.recipient, t.name AS type_name, dep.name AS department, d.status, d.cancel_reason
       FROM documents d JOIN document_types t ON t.id = d.document_type_id JOIN departments dep ON dep.id = d.department_id
       WHERE d.register_id = $1 AND d.reg_year = $2 AND ${visible} ORDER BY d.reg_number`, params)).rows;
    const header = ['Număr', 'Data', 'Tip înregistrare', 'Titlu', 'Emitent', 'Destinatar', 'Tip document', 'Departament', 'Stare', 'Motivul anulării'];
    const lines = [header.map(csvCell).join(';'), ...rows.map((r) => [r.reg_label, new Date(r.reg_date).toLocaleDateString('ro-RO', { timeZone: 'Europe/Bucharest' }), r.direction, r.title, r.issuer, r.recipient, r.type_name, r.department, r.status, r.cancel_reason].map(csvCell).join(';'))];
    await this.audit.log(user, { action: 'registru.export', details: { registru: registerId, an: year, randuri: rows.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="registru-${registerId}-${year}.csv"`);
    res.end('﻿' + lines.join('\r\n'));
  }
}

