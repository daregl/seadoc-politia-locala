import { Body, Controller, Get, HttpCode, Injectable, Logger, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import { Db } from './db.js';
import { DocumentsService } from './documents.js';
import { badRequest, conflict, forbidden, notFound, optInt, optText, toInt } from './http.js';
import { can, CurrentUser } from './perms.js';
import { StorageService } from './storage.js';

const TODAY = `(now() AT TIME ZONE 'Europe/Bucharest')::date`;

@Injectable()
export class ArchiveService {
  private readonly log = new Logger('Arhivă');

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly docs: DocumentsService,
  ) {}

  /** Închide și arhivează documentul. După acest pas, declanșatoarele din baza de date îl fac imuabil. */
  async archive(user: CurrentUser, id: number) {
    // Arhivarul lucrează pe toate documentele, inclusiv pe cele pe care nu le vede încă în liste.
    if (!can(user, 'archive')) {
      const visible = await this.docs.requireVisible(user, id);
      const allowed = visible.owner_id === user.id || (user.role === 'manager' && visible.department_id === user.departmentId);
      if (!allowed) forbidden();
    }
    return this.db.tx(async (c) => {
      const doc = (await c.query(
        `SELECT d.id, d.status, d.reg_label, t.retention_years
         FROM documents d JOIN document_types t ON t.id = d.document_type_id WHERE d.id = $1 FOR UPDATE OF d`, [id])).rows[0];
      if (!doc) notFound('Document inexistent sau fără acces');
      if (['arhivat', 'eliminat'].includes(doc.status)) conflict('Documentul este deja arhivat');
      const active = await c.query(`SELECT 1 FROM workflow_instances WHERE document_id = $1 AND status = 'activ'`, [id]);
      if (active.rowCount || doc.status === 'in_flux') conflict('Documentul are un flux activ');
      // Textul nu mai poate fi indexat după arhivare, așa că extragerea trebuie să se fi încheiat.
      const pending = await c.query(`SELECT 1 FROM document_versions WHERE document_id = $1 AND ocr_status IN ('in_asteptare','in_lucru')`, [id]);
      if (pending.rowCount) conflict('Documentul este încă în procesare OCR. Reîncercați peste câteva momente.');
      const row = (await c.query(
        `UPDATE documents SET status = 'arhivat', closed_at = coalesce(closed_at, now()), archived_at = now(),
           retention_until = ${TODAY} + make_interval(years => $2::int)
         WHERE id = $1 RETURNING id, status, archived_at AS "archivedAt", retention_until::text AS "retentionUntil"`, [id, doc.retention_years])).rows[0];
      await this.audit.log(user, {
        action: 'arhiva.arhivare', documentId: id,
        details: { numar: doc.reg_label, pastrareAni: doc.retention_years, pastrareaPanaLa: row.retentionUntil },
      }, c);
      return row;
    });
  }

  async list(user: CurrentUser, q: Record<string, string | undefined>) {
    const params: unknown[] = [];
    const where = [`d.status IN ('arhivat','eliminat')`];
    const text = optText(q.q);
    if (text) {
      params.push(text);
      const tsquery = `$${params.length}`;
      params.push(`%${text.replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(d.search @@ websearch_to_tsquery('seadoc', ${tsquery}) OR d.reg_label ILIKE $${params.length})`);
    }
    const typeId = optInt(q.typeId, 'tip document');
    if (typeId != null) {
      params.push(typeId);
      where.push(`d.document_type_id = $${params.length}`);
    }
    if (q.expired === '1') where.push(`d.status = 'arhivat' AND d.retention_until < ${TODAY}`);
    const clause = where.join(' AND ');
    const total = (await this.db.one(`SELECT count(*)::int AS n FROM documents d WHERE ${clause}`, params)).n;
    const limit = Math.min(Math.max(optInt(q.limit, 'limită') ?? 50, 1), 200);
    const offset = Math.max(optInt(q.offset, 'deplasare') ?? 0, 0);
    params.push(limit, offset);
    const items = (await this.db.query(
      `SELECT d.id, d.title, d.reg_label AS "regLabel", d.status, t.name AS "typeName", t.nomenclator_code AS "nomenclatorCode",
              d.archived_at AS "archivedAt", d.retention_until::text AS "retentionUntil",
              (d.status = 'arhivat' AND coalesce(d.retention_until < ${TODAY}, false)) AS expired,
              (SELECT p.status FROM elimination_proposals p WHERE p.document_id = d.id ORDER BY p.id DESC LIMIT 1) AS "proposalStatus"
       FROM documents d JOIN document_types t ON t.id = d.document_type_id
       WHERE ${clause} ORDER BY d.archived_at DESC NULLS LAST, d.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
    if (text) await this.audit.log(user, { action: 'arhiva.cautare', details: { text, rezultate: total } });
    return { total, items };
  }

  async proposals() {
    return (await this.db.query(
      `SELECT p.id, p.document_id AS "documentId", d.title, d.reg_label AS "regLabel", d.retention_until::text AS "retentionUntil", p.reason,
              u.full_name AS "proposedBy", p.proposed_at AS "proposedAt", p.status, x.full_name AS "decidedBy", p.decided_at AS "decidedAt"
       FROM elimination_proposals p
       JOIN documents d ON d.id = p.document_id
       JOIN users u ON u.id = p.proposed_by
       LEFT JOIN users x ON x.id = p.decided_by
       ORDER BY p.status = 'propusa' DESC, p.id DESC`)).rows;
  }

  async propose(user: CurrentUser, documentId: number, reason: string | null) {
    return this.db.tx(async (c) => {
      const doc = (await c.query(
        `SELECT id, status, retention_until, coalesce(retention_until < ${TODAY}, false) AS expired FROM documents WHERE id = $1 FOR UPDATE`, [documentId])).rows[0];
      if (!doc) notFound('Document inexistent');
      if (doc.status !== 'arhivat') conflict('Se pot propune spre eliminare doar documente arhivate');
      if (doc.retention_until == null) conflict('Documentul are păstrare permanentă și nu poate fi eliminat');
      if (!doc.expired) conflict('Termenul de păstrare nu a expirat');
      const open = await c.query(`SELECT 1 FROM elimination_proposals WHERE document_id = $1 AND status = 'propusa'`, [documentId]);
      if (open.rowCount) conflict('Există deja o propunere deschisă pentru acest document');
      const p = (await c.query(
        `INSERT INTO elimination_proposals (document_id, proposed_by, reason) VALUES ($1,$2,$3) RETURNING id, status`,
        [documentId, user.id, reason])).rows[0];
      await this.audit.log(user, { action: 'arhiva.propunere_eliminare', documentId, details: { propunere: p.id, motiv: reason } }, c);
      return { id: p.id, documentId, status: p.status };
    });
  }

  /**
   * Regula celor patru ochi: decide altcineva decât cel care a propus. Tot ce ține de document se
   * schimbă într-o tranzacție; fișierele se șterg abia după commit, ca un rollback să nu piardă date.
   */
  async decide(user: CurrentUser, proposalId: number, approve: boolean) {
    const outcome = await this.db.tx(async (c) => {
      const p = (await c.query('SELECT * FROM elimination_proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
      if (!p) notFound('Propunere inexistentă');
      if (p.status !== 'propusa') conflict('Propunerea a fost deja soluționată');
      if (p.proposed_by === user.id) forbidden('Decizia trebuie luată de altă persoană decât cea care a propus eliminarea');
      await c.query('UPDATE elimination_proposals SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1',
        [proposalId, approve ? 'aprobata' : 'respinsa', user.id]);
      if (!approve) {
        await this.audit.log(user, { action: 'arhiva.propunere_respinsa', documentId: p.document_id, details: { propunere: proposalId } }, c);
        return { documentId: p.document_id as number, keys: [] as string[] };
      }
      const doc = (await c.query('SELECT status FROM documents WHERE id = $1 FOR UPDATE', [p.document_id])).rows[0];
      if (doc.status !== 'arhivat') conflict('Documentul nu mai este în arhivă');
      const versions = (await c.query(
        'SELECT version_no, sha256, storage_key, searchable_key FROM document_versions WHERE document_id = $1 ORDER BY version_no', [p.document_id])).rows;
      await c.query(
        `UPDATE document_versions SET storage_key = NULL, searchable_key = NULL, text_content = '' WHERE document_id = $1`, [p.document_id]);
      // Același UPDATE: declanșatorul refuză orice altă modificare a unui document arhivat.
      await c.query(`UPDATE documents SET status = 'eliminat', content_text = '' WHERE id = $1`, [p.document_id]);
      await this.audit.log(user, {
        action: 'arhiva.eliminare', documentId: p.document_id,
        details: { propunere: proposalId, propusDe: p.proposed_by, versiuni: versions.map((v) => ({ versiune: v.version_no, sha256: v.sha256 })) },
      }, c);
      return {
        documentId: p.document_id as number,
        keys: versions.flatMap((v) => [v.storage_key, v.searchable_key]).filter(Boolean) as string[],
      };
    });

    for (const key of outcome.keys) {
      try {
        await this.storage.remove(key);
      } catch (err) {
        // Documentul e deja eliminat logic; rămâne doar un fișier criptat de curățat manual.
        this.log.error(`Fișierul ${key} nu a putut fi șters: ${(err as Error).message}`);
        await this.audit.log(user, { action: 'arhiva.stergere_fisier_esuata', documentId: outcome.documentId, details: { cheie: key } });
      }
    }
    return { id: proposalId, documentId: outcome.documentId, status: approve ? 'aprobata' : 'respinsa' };
  }
}

@Controller()
@UseGuards(AuthGuard)
export class ArchiveController {
  constructor(private readonly archive: ArchiveService) {}

  @Post('documents/:id/archive') @HttpCode(200)
  archiveDocument(@User() user: CurrentUser, @Param('id') id: string) {
    return this.archive.archive(user, toInt(id));
  }

  @Get('archive') @RequirePerm('archive')
  list(@User() user: CurrentUser, @Query() q: Record<string, string>) {
    return this.archive.list(user, q);
  }

  @Get('archive/proposals') @RequirePerm('archive')
  proposals() {
    return this.archive.proposals();
  }

  @Post('archive/proposals') @RequirePerm('archive')
  propose(@User() user: CurrentUser, @Body() body: { documentId?: unknown; reason?: unknown }) {
    return this.archive.propose(user, toInt(body.documentId, 'document'), optText(body.reason));
  }

  @Post('archive/proposals/:id/decide') @RequirePerm('archive') @HttpCode(200)
  decide(@User() user: CurrentUser, @Param('id') id: string, @Body() body: { approve?: unknown }) {
    if (typeof body.approve !== 'boolean') badRequest('Câmp invalid: approve');
    return this.archive.decide(user, toInt(id), body.approve as boolean);
  }
}
