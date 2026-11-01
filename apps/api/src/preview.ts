// Previzualizarea fișierelor Office în browser. Conversia și curățarea HTML-ului sunt în preview-convert.ts.
import { Controller, Get, Injectable, Param, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.js';
import { AuthGuard, User } from './auth.js';
import { detachedCopy, runInWorker, WorkerLimitError } from './bounded-worker.js';
import { DocumentsService } from './documents.js';
import { Db } from './db.js';
import { fail, notFound, optInt, toInt } from './http.js';
import { CurrentUser } from './perms.js';
import type { OfficePreview } from './preview-convert.js';
import { StorageService } from './storage.js';

const OOXML = /(wordprocessingml|spreadsheetml|presentationml)/;
const LEGACY = new Set(['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint']);
const PREVIEW_LIMITS = { timeoutMs: 45_000, maxOldMb: 384 };

export type PreviewResult =
  | ({ kind: 'html' } & OfficePreview)
  | { kind: 'descarcare'; message: string };

@Injectable()
export class PreviewService {
  constructor(private readonly db: Db, private readonly docs: DocumentsService, private readonly storage: StorageService, private readonly audit: AuditService) {}

  async preview(user: CurrentUser, documentId: number, versionNo: number | null): Promise<PreviewResult> {
    const doc = await this.docs.requireVisible(user, documentId);
    const v = await this.db.one(
      `SELECT version_no, mime, storage_key FROM document_versions WHERE document_id = $1 AND ($2::int IS NULL OR version_no = $2) ORDER BY version_no DESC LIMIT 1`, [documentId, versionNo]);
    if (!v) notFound('Versiune inexistentă');
    if (!v.storage_key) fail(410, 'Fișierul a fost eliminat la expirarea termenului de păstrare');
    if (LEGACY.has(v.mime)) {
      return { kind: 'descarcare', message: 'Formatele binare vechi (.doc, .xls, .ppt) nu se previzualizează în browser. Descărcați fișierul și deschideți-l în aplicația instalată.' };
    }
    if (!OOXML.test(v.mime)) return { kind: 'descarcare', message: 'Acest tip de fișier nu are previzualizare Office.' };
    const data = detachedCopy(await this.storage.get(v.storage_key));
    let result: OfficePreview;
    try {
      result = await runInWorker<OfficePreview>('office-preview', { data, mime: v.mime }, PREVIEW_LIMITS, [data.buffer]);
    } catch (err) {
      if (err instanceof WorkerLimitError && err.kind === 'ocupat') fail(503, err.message);
      if (err instanceof WorkerLimitError) fail(422, `Fișierul nu poate fi previzualizat: ${err.message} Descărcați-l pentru a-l deschide.`);
      throw err;
    }
    const details = { versiune: v.version_no, format: result.format };
    await this.audit.log(user, { action: doc.status === 'arhivat' ? 'arhiva.consultare' : 'document.previzualizare', documentId, details });
    if (doc.personal_data) await this.audit.log(user, { action: 'gdpr.acces_date_personale', documentId, details });
    return { kind: 'html', ...result };
  }
}

@Controller('documents')
@UseGuards(AuthGuard)
export class PreviewController {
  constructor(private readonly service: PreviewService) {}

  @Get(':id/preview')
  preview(@User() user: CurrentUser, @Param('id') id: string, @Query('version') version?: string) {
    return this.service.preview(user, toInt(id), optInt(version));
  }
}
