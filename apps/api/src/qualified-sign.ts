// Verificarea semnăturilor din PDF la cerere și semnătura cu certificat în două faze.
// Agentul local semnează amprenta; serverul nu vede niciodată cheia sau PIN-ul.
import { Body, Controller, Get, HttpCode, Injectable, Logger, OnModuleDestroy, OnModuleInit, Param, Post, Query, UseGuards } from '@nestjs/common';
import crypto, { X509Certificate } from 'node:crypto';
import { AuditService } from './audit.js';
import { AuthGuard, User } from './auth.js';
import { asBuffer, detachedCopy, runInWorker, WorkerLimitError } from './bounded-worker.js';
import { config } from './config.js';
import { Db, Queryable } from './db.js';
import { DocumentsService, signatureSeal } from './documents.js';
import { badRequest, conflict, fail, forbidden, notFound, optInt, optText, toInt } from './http.js';
import { can, CurrentUser } from './perms.js';
import type { CompletionResult, SignatureReport } from './pdf-signatures.js';
import { loadTrustRoots, VERIFY_LIMITS, verifyPdfBytes } from './pdf-verify-run.js';
import { StorageService } from './storage.js';
import { WorkflowEngine } from './workflow-engine.js';

const MAX_CERT_PEM_CHARS = 32_768;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OCR_PENDING = new Set(['in_asteptare', 'in_lucru']);

/** Amprenta unei semnături cu certificat leagă și certificatul de rândul din baza de date. */
export const certificateSeal = (documentId: number, versionId: number, signerId: number, sha256: string, certSha256: string, signedAt: string) =>
  signatureSeal(documentId, versionId, signerId, `${sha256}|${certSha256}`, signedAt);

function parseCertificate(pem: unknown): X509Certificate {
  if (typeof pem !== 'string' || !pem.includes('BEGIN CERTIFICATE') || pem.length > MAX_CERT_PEM_CHARS) badRequest('Certificatul lipsește sau este invalid');
  try {
    return new X509Certificate(pem as string);
  } catch {
    return badRequest('Certificatul lipsește sau este invalid');
  }
}

@Injectable()
export class QualifiedSignService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Semnături');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
    private readonly engine: WorkflowEngine,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.purgeExpired().catch((err) => this.log.error(`Curățarea sesiunilor: ${(err as Error).message}`)), 10 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** PDF-urile pregătite și nefinalizate nu rămân în stocare. */
  async purgeExpired() {
    const rows = (await this.db.query(
      `WITH old AS (SELECT id, storage_key FROM signing_sessions WHERE status = 'pregatita' AND expires_at < now() FOR UPDATE)
       UPDATE signing_sessions s SET status = 'expirata', storage_key = NULL FROM old WHERE s.id = old.id RETURNING old.storage_key AS key`)).rows;
    for (const r of rows) if (r.key) await this.storage.remove(r.key);
  }

  // Verificarea la cerere ---------------------------------------------------------------------------

  async verifyVersion(user: CurrentUser, documentId: number, versionNo: number | null) {
    const doc = await this.docs.requireVisible(user, documentId);
    const v = await this.db.one(
      `SELECT id, version_no, mime, storage_key FROM document_versions WHERE document_id = $1 AND ($2::int IS NULL OR version_no = $2) ORDER BY version_no DESC LIMIT 1`,
      [documentId, versionNo]);
    if (!v) notFound('Versiune inexistentă');
    if (!v.storage_key) fail(410, 'Fișierul a fost eliminat la expirarea termenului de păstrare');
    if (v.mime !== 'application/pdf') badRequest('Semnăturile se verifică doar pe fișiere PDF');
    // Se verifică fișierul original: PDF-ul căutabil este refăcut de aplicație și nu mai poartă semnăturile primite.
    const report = await verifyPdfBytes(await this.storage.get(v.storage_key));
    const saved = await this.db.tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO pdf_signature_checks (document_id, version_id, checked_by, status, report) VALUES ($1,$2,$3,$4,$5) RETURNING id, checked_at`,
        [documentId, v.id, user.id, report.status, JSON.stringify(report)])).rows[0];
      await this.audit.log(user, {
        action: 'document.verificare_semnaturi', documentId,
        details: { versiune: v.version_no, stare: report.status, rezultate: report.signatures.map((s) => s.verdict), sha256: report.fileSha256 },
      }, c);
      if (doc.personal_data) await this.audit.log(user, { action: 'gdpr.acces_date_personale', documentId, details: { versiune: v.version_no, verificareSemnaturi: true } }, c);
      return row;
    });
    return { id: saved.id, versionNo: v.version_no, checkedAt: saved.checked_at, checkedBy: user.fullName, report };
  }

  async listChecks(user: CurrentUser, documentId: number) {
    await this.docs.requireVisible(user, documentId);
    return (await this.db.query(
      `SELECT DISTINCT ON (c.version_id) c.id, v.version_no AS "versionNo", c.checked_at AS "checkedAt", u.full_name AS "checkedBy", c.report
       FROM pdf_signature_checks c JOIN document_versions v ON v.id = c.version_id JOIN users u ON u.id = c.checked_by
       WHERE c.document_id = $1 ORDER BY c.version_id DESC, c.id DESC`, [documentId])).rows;
  }

  // Faza 1: pregătirea ---------------------------------------------------------------------------------

  private async checkTask(user: CurrentUser, taskId: number, documentId: number | null, client: Queryable = this.db) {
    const task = (await client.query('SELECT id, document_id, assignee_id, kind, status FROM tasks WHERE id = $1', [taskId])).rows[0];
    if (!task || (documentId != null && task.document_id !== documentId)) notFound('Sarcină inexistentă');
    if (task.assignee_id !== user.id) forbidden('Doar titularul sarcinii poate semna');
    if (task.kind !== 'semnare') badRequest('Doar sarcinile de semnare se finalizează cu semnătură');
    if (task.status !== 'deschisa') conflict('Sarcina nu mai este deschisă');
    return task;
  }

  async prepare(user: CurrentUser, input: { documentId?: unknown; taskId?: unknown; certificatePem?: unknown }) {
    if (!can(user, 'sign_qualified')) forbidden('Contul nu are dreptul de a semna cu certificat');
    const taskId = optInt(input.taskId, 'sarcină');
    let documentId = optInt(input.documentId, 'document');
    if (taskId != null) documentId = (await this.checkTask(user, taskId, documentId)).document_id;
    if (documentId == null) badRequest('Alegeți documentul de semnat');
    const doc = await this.docs.requireVisible(user, documentId!);
    if (['arhivat', 'eliminat'].includes(doc.status)) conflict('Documentul arhivat nu se mai poate semna');
    if (taskId == null) {
      // În flux, conținutul se semnează doar pe sarcina de semnare; în afara lui, ca la o versiune nouă.
      if (doc.status === 'in_flux') forbidden('Documentul este într-un flux: semnați din sarcina de semnare');
      if (!(await this.docs.canAddVersion(user, doc))) forbidden('Nu puteți semna acest document');
    }
    const cert = parseCertificate(input.certificatePem);
    const now = Date.now();
    if (new Date(cert.validFrom).getTime() > now || new Date(cert.validTo).getTime() < now) badRequest('Certificatul ales nu este în perioada de valabilitate');

    const v = await this.db.one(
      `SELECT id, version_no, filename, mime, storage_key, searchable_key, ocr_status FROM document_versions WHERE document_id = $1 ORDER BY version_no DESC LIMIT 1`, [documentId]);
    if (!v?.storage_key) fail(410, 'Fișierul a fost eliminat la expirarea termenului de păstrare');
    if (!v.searchable_key && v.mime !== 'application/pdf') badRequest('Se pot semna doar fișiere PDF. Acest fișier nu are nici PDF căutabil.');
    if (OCR_PENDING.has(v.ocr_status)) conflict('Extragerea textului este în curs. Încercați din nou după finalizarea ei.');

    await this.purgeExpired();
    const previous = (await this.db.query(
      `WITH old AS (SELECT id, storage_key FROM signing_sessions WHERE status = 'pregatita' AND user_id = $1 AND document_id = $2 FOR UPDATE)
       UPDATE signing_sessions s SET status = 'anulata', storage_key = NULL FROM old WHERE s.id = old.id RETURNING old.storage_key AS key`, [user.id, documentId])).rows;
    for (const r of previous) if (r.key) await this.storage.remove(r.key);

    const source = detachedCopy(await this.storage.get(v.searchable_key ?? v.storage_key));
    let prepared: { pdf: Uint8Array; byteRange: number[]; contentsStart: number; contentsEnd: number; digestHex: string };
    try {
      prepared = await runInWorker('pdf-prepare', { data: source, signingTime: new Date().toISOString() }, VERIFY_LIMITS, [source.buffer]);
    } catch (err) {
      if (err instanceof WorkerLimitError) {
        if (err.kind === 'ocupat') fail(503, err.message);
        badRequest(`PDF-ul nu poate fi pregătit pentru semnare: ${err.message}`);
      }
      throw err;
    }
    const key = await this.storage.put(asBuffer(prepared.pdf));
    const id = crypto.randomUUID();
    const certSha = crypto.createHash('sha256').update(cert.raw).digest('hex');
    const ttl = config.signSessionTtlSeconds;
    try {
      const row = (await this.db.query(
        `INSERT INTO signing_sessions (id, user_id, document_id, task_id, base_version_id, storage_key, digest_hex, contents_start, contents_end, certificate_sha256, certificate_pem, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + make_interval(secs => $12)) RETURNING expires_at`,
        [id, user.id, documentId, taskId, v.id, key, prepared.digestHex, prepared.contentsStart, prepared.contentsEnd, certSha, cert.toString(), ttl])).rows[0];
      await this.audit.log(user, { action: 'semnatura.pregatita', documentId, details: { sesiune: id, sarcina: taskId, versiune: v.version_no, certificat: certSha, amprenta: prepared.digestHex } });
      return {
        sessionId: id,
        digestAlgorithm: 'SHA-256',
        digestHex: prepared.digestHex,
        byteRange: prepared.byteRange,
        expiresAt: row.expires_at,
        documentId,
        taskId,
        versionNo: v.version_no,
        filename: v.filename,
        label: `${doc.reg_label ? `${doc.reg_label} · ` : ''}${doc.title}`.slice(0, 200),
      };
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
  }

  // Faza 2: finalizarea ---------------------------------------------------------------------------------

  async complete(user: CurrentUser, sessionId: string, input: { cms?: unknown; comment?: unknown }) {
    if (!SESSION_ID.test(sessionId)) notFound('Sesiune de semnare inexistentă');
    const session = await this.db.one('SELECT * FROM signing_sessions WHERE id = $1', [sessionId]);
    if (!session) notFound('Sesiune de semnare inexistentă');
    if (session.user_id !== user.id) {
      await this.audit.log(user, { action: 'semnatura.sesiune_straina', documentId: session.document_id, details: { sesiune: sessionId } });
      forbidden('Sesiunea de semnare aparține altui utilizator');
    }
    if (!can(user, 'sign_qualified')) forbidden('Contul nu are dreptul de a semna cu certificat');
    await this.docs.requireVisible(user, session.document_id);
    if (session.status !== 'pregatita') {
      if (session.status === 'expirata') fail(410, 'Sesiunea de semnare a expirat. Reluați semnarea.');
      conflict('Sesiunea de semnare a fost deja încheiată');
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      await this.purgeExpired();
      fail(410, 'Sesiunea de semnare a expirat. Reluați semnarea.');
    }
    if (typeof input.cms !== 'string' || !input.cms || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.cms)) badRequest('Semnătura lipsește sau nu este în format base64');
    const cms = Buffer.from(input.cms as string, 'base64');
    if (cms.length > (Number(session.contents_end) - Number(session.contents_start) - 2) / 2) badRequest('Semnătura depășește spațiul rezervat în PDF');

    const prepared = detachedCopy(await this.storage.get(session.storage_key));
    const cmsCopy = detachedCopy(cms);
    let outcome: CompletionResult & { signed?: Uint8Array };
    try {
      outcome = await runInWorker('pdf-complete', {
        prepared, cms: cmsCopy, contentsStart: Number(session.contents_start), contentsEnd: Number(session.contents_end),
        expectedDigestHex: session.digest_hex, declaredCertSha256: session.certificate_sha256, roots: await loadTrustRoots(),
      }, VERIFY_LIMITS, [prepared.buffer, cmsCopy.buffer]);
    } catch (err) {
      if (err instanceof WorkerLimitError) {
        if (err.kind === 'ocupat') fail(503, err.message);
        badRequest('Semnătura primită nu a putut fi verificată');
      }
      throw err;
    }
    if (!outcome.ok) {
      await this.audit.log(user, { action: 'semnatura.respinsa', documentId: session.document_id, details: { sesiune: sessionId, motiv: outcome.message } });
      badRequest(outcome.message);
      return undefined as never;
    }
    const signed = asBuffer(outcome.signed as unknown as Uint8Array);
    const report = outcome.signature;
    const sha256 = crypto.createHash('sha256').update(signed).digest('hex');
    const key = await this.storage.put(signed);
    const comment = optText(input.comment);
    try {
      const write = (c: Queryable) => this.writeSigned(c, user, session, signed.length, sha256, key, report, sessionId);
      let task: { taskId: number; status: string; instanceStatus: string } | null = null;
      let written: { signatureId: number; versionId: number; versionNo: number };
      if (session.task_id != null) {
        const done = await this.engine.signTaskWith(user, session.task_id, comment, async (c) => {
          const w = await write(c);
          return { id: w.signatureId, written: w };
        });
        written = done.signature.written;
        task = { taskId: done.taskId, status: done.status, instanceStatus: done.instanceStatus };
      } else {
        written = await this.db.tx(async (c) => {
          const doc = (await c.query('SELECT status FROM documents WHERE id = $1 FOR UPDATE', [session.document_id])).rows[0];
          if (['arhivat', 'eliminat'].includes(doc.status)) conflict('Documentul arhivat nu se mai poate semna');
          if (doc.status === 'in_flux') conflict('Documentul a intrat într-un flux: semnați din sarcina de semnare');
          return write(c);
        });
      }
      await this.storage.remove(session.storage_key);
      return { ...written, sha256, task, signature: report, testCertificate: report.testIndicators.length > 0 };
    } catch (err) {
      await this.storage.remove(key);
      throw err;
    }
  }

  /** Calea dedicată pentru PDF-ul semnat: o semnătură nu este o schimbare de conținut. */
  private async writeSigned(c: Queryable, user: CurrentUser, session: any, size: number, sha256: string, key: string, report: SignatureReport, sessionId: string) {
    const claimed = await c.query(
      `UPDATE signing_sessions SET status = 'finalizata', storage_key = NULL, completed_at = now() WHERE id = $1 AND status = 'pregatita' AND expires_at >= now() RETURNING id`, [sessionId]);
    if (!claimed.rowCount) conflict('Sesiunea de semnare a fost deja încheiată sau a expirat');
    const latest = (await c.query(
      `SELECT id, version_no, filename, text_content, ocr_used FROM document_versions WHERE document_id = $1 ORDER BY version_no DESC LIMIT 1`, [session.document_id])).rows[0];
    if (latest.id !== session.base_version_id) conflict('Între timp a apărut o versiune nouă a documentului. Reluați semnarea.');
    const versionNo = latest.version_no + 1;
    const filename = /-semnat\.pdf$/i.test(latest.filename) ? latest.filename : `${latest.filename.replace(/\.[^.]+$/, '')}-semnat.pdf`;
    // Textul rămâne al versiunii semnate: PDF-ul nu mai trece prin OCR, care l-ar rescrie și ar strica semnătura.
    const version = (await c.query(
      `INSERT INTO document_versions (document_id, version_no, filename, mime, size_bytes, sha256, storage_key, ocr_status, ocr_used, text_content, created_by)
       VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,'finalizat',$7,$8,$9) RETURNING id`,
      [session.document_id, versionNo, filename, size, sha256, key, latest.ocr_used, latest.text_content, user.id])).rows[0];
    const signedAt = new Date().toISOString();
    const seal = certificateSeal(session.document_id, version.id, user.id, sha256, session.certificate_sha256, signedAt);
    const signature = (await c.query(
      `INSERT INTO signatures (document_id, version_id, signer_id, kind, sha256, signed_at, seal, certificate_subject, certificate_issuer, certificate_serial, certificate_sha256, certificate_pem, test_indicators, chain_status, verdict)
       VALUES ($1,$2,$3,'certificat',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [session.document_id, version.id, user.id, sha256, signedAt, seal, report.signer?.subject ?? null, report.signer?.issuer ?? null, report.signer?.serial ?? null,
        session.certificate_sha256, session.certificate_pem, JSON.stringify(report.testIndicators), report.chain?.status ?? null, report.verdict])).rows[0];
    await this.audit.log(user, {
      action: 'document.semnatura_certificat', documentId: session.document_id,
      details: { semnatura: signature.id, versiune: versionNo, sha256, certificat: session.certificate_sha256, titular: report.signer?.subject, lant: report.chain?.status, sarcina: session.task_id },
    }, c);
    return { signatureId: signature.id as number, versionId: version.id as number, versionNo: versionNo as number };
  }
}

@Controller('signing')
@UseGuards(AuthGuard)
export class SigningController {
  constructor(private readonly service: QualifiedSignService) {}

  @Get('config')
  async signingConfig() {
    return { agentOrigin: config.agentOrigin, sessionTtlSeconds: config.signSessionTtlSeconds, trustRootsConfigured: (await loadTrustRoots()).length > 0 };
  }

  @Post('prepare') @HttpCode(200)
  prepare(@User() user: CurrentUser, @Body() body: { documentId?: unknown; taskId?: unknown; certificatePem?: unknown }) {
    return this.service.prepare(user, body);
  }

  @Post('sessions/:id/complete') @HttpCode(200)
  complete(@User() user: CurrentUser, @Param('id') id: string, @Body() body: { cms?: unknown; comment?: unknown }) {
    return this.service.complete(user, id, body);
  }
}

@Controller('documents')
@UseGuards(AuthGuard)
export class PdfSignaturesController {
  constructor(private readonly service: QualifiedSignService) {}

  @Get(':id/pdf-signatures')
  list(@User() user: CurrentUser, @Param('id') id: string) {
    return this.service.listChecks(user, toInt(id));
  }

  @Post(':id/pdf-signatures/verify') @HttpCode(200)
  verify(@User() user: CurrentUser, @Param('id') id: string, @Query('version') version?: string) {
    return this.service.verifyVersion(user, toInt(id), optInt(version));
  }
}
