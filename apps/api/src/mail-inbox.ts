import { Body, Controller, Get, HttpCode, HttpException, Injectable, Logger, OnModuleDestroy, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import crypto from 'node:crypto';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import { config } from './config.js';
import { Db, Queryable } from './db.js';
import { detectMime, DocumentsService, NewDocument } from './documents.js';
import { badRequest, conflict, notFound, optInt, optText, toInt } from './http.js';
import { isLoopback, oneLine } from './mail.js';
import { CurrentUser, visibleSql } from './perms.js';
import { StorageService } from './storage.js';

export interface ImapSettings { host: string; port: number; secure: boolean; user: string; pass: string; mailbox: string }

export function imapSettings(): ImapSettings | null {
  const host = process.env.IMAP_HOST?.trim();
  const user = process.env.IMAP_USER?.trim();
  if (!host || !user) return null;
  const secure = process.env.IMAP_SECURE !== 'false';
  return {
    host,
    port: Number(process.env.IMAP_PORT || (secure ? 993 : 143)),
    secure,
    user,
    pass: process.env.IMAP_PASS ?? '',
    mailbox: process.env.IMAP_MAILBOX?.trim() || 'INBOX',
  };
}

/** Căsuța înseamnă contul și serverul: după o schimbare de server, UID-urile vechi nu mai spun nimic. */
const accountKey = (s: ImapSettings) => `${s.user}@${s.host}/${s.mailbox}`;

const BATCH = 50;
const MAX_BODY_CHARS = 1_000_000;
const MAX_ATTACHMENTS = 100;
// Un mesaj conține atașamente codate base64, deci cu aproximativ o treime mai mari decât fișierele.
const maxMessageBytes = () => Number(process.env.IMAP_MAX_MESSAGE_BYTES || Math.ceil(config.maxUploadBytes * 1.4) + 10 * 1024 * 1024);
const clean = (value: string) => value.replaceAll('\0', '');
const mb = (bytes: number) => Math.ceil(bytes / (1024 * 1024));

/** Antetele vin din afară: o valoare ieșită din tipar nu are voie să blocheze coada de preluare. */
const safeDate = (value: unknown): Date | null => {
  const date = value instanceof Date ? value : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  return year >= 1970 && year <= 2100 ? date : null;
};
const cleanMessageId = (value: unknown) => optText(oneLine(clean(String(value ?? '')), 1000));
// Amprenta, nu valoarea: un Message-ID foarte lung nu ar încăpea în indexul unic.
const midKey = (messageId: string) => `mid:${crypto.createHash('sha256').update(messageId).digest('hex')}`;

function cleanFilename(raw: string | undefined, index: number): string {
  const name = oneLine(clean(raw ?? '').split(/[\\/]/).pop() ?? '', 255);
  return name && name !== '.' && name !== '..' ? name : `atasament-${index + 1}`;
}

export interface ParsedAttachment { filename: string; declaredMime: string; content: Buffer }
export interface ParsedMessage {
  messageId: string | null; fromName: string | null; fromAddress: string | null; toText: string | null;
  subject: string; sentAt: Date | null; bodyText: string; bodyTruncated: boolean; attachments: ParsedAttachment[];
}

/** Din mesaj rămân doar text și atașamente. HTML-ul este convertit în text de mailparser și apoi aruncat. */
export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 2_000_000 });
  const from = parsed.from?.value?.[0];
  const to = Array.isArray(parsed.to) ? parsed.to.map((a) => a.text).join(', ') : parsed.to?.text;
  const text = clean(parsed.text ?? '');
  return {
    messageId: cleanMessageId(parsed.messageId),
    fromName: optText(oneLine(clean(from?.name ?? ''))),
    fromAddress: optText(oneLine(clean(from?.address ?? ''))),
    toText: optText(oneLine(clean(to ?? ''), 1000)),
    subject: oneLine(clean(parsed.subject ?? ''), 500),
    sentAt: safeDate(parsed.date),
    bodyText: text.slice(0, MAX_BODY_CHARS),
    bodyTruncated: text.length > MAX_BODY_CHARS,
    attachments: parsed.attachments.map((a, i) => ({ filename: cleanFilename(a.filename, i), declaredMime: a.contentType, content: a.content })),
  };
}

/** Aceeași validare ca la încărcare; întoarce tipul stabilit sau motivul refuzului. */
export function checkAttachment(att: ParsedAttachment): { mime: string } | { reason: string } {
  if (att.content.length > config.maxUploadBytes) return { reason: `Depășește limita de ${mb(config.maxUploadBytes)} MB` };
  try {
    return { mime: detectMime({ originalname: att.filename, mimetype: att.declaredMime, buffer: att.content, size: att.content.length }, att.filename) };
  } catch (err) {
    if (err instanceof HttpException) return { reason: String((err.getResponse() as { message?: unknown }).message ?? 'Fișier neacceptat') };
    throw err;
  }
}

export interface PollResult { imported: number; duplicates: number; refusedAttachments: number; remaining: boolean }

@Injectable()
export class ImapImporter implements OnModuleDestroy {
  private readonly log = new Logger('IMAP');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<PollResult> | null = null;
  private stopped = false;

  constructor(private readonly db: Db, private readonly storage: StorageService, private readonly audit: AuditService) {}

  start() {
    if (!imapSettings()) {
      this.log.log('Preluarea din email este dezactivată: IMAP_HOST nu este setat');
      return;
    }
    const tick = () => { void this.poll().catch((err) => this.log.warn(`Preluare IMAP: ${String(err?.message ?? err)}`)); };
    this.timer = setInterval(tick, Number(process.env.IMAP_POLL_MS ?? 60_000));
    this.timer.unref();
    tick();
  }

  /** O singură rulare la un moment dat. Eroarea de conexiune rămâne vizibilă în starea căsuței. */
  poll(): Promise<PollResult> {
    if (this.stopped) return Promise.resolve({ imported: 0, duplicates: 0, refusedAttachments: 0, remaining: false });
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<PollResult> {
    const result: PollResult = { imported: 0, duplicates: 0, refusedAttachments: 0, remaining: false };
    const s = imapSettings();
    if (!s) return result;
    await this.db.query(
      `INSERT INTO email_imap_state (mailbox, last_poll_at) VALUES ($1, now())
       ON CONFLICT (mailbox) DO UPDATE SET last_poll_at = now()`, [accountKey(s)]);
    const client = new ImapFlow({
      host: s.host,
      port: s.port,
      secure: s.secure,
      // Fără TLS implicit, STARTTLS devine obligatoriu în afara interfeței locale.
      doSTARTTLS: !s.secure && !isLoopback(s.host) ? true : undefined,
      auth: { user: s.user, pass: s.pass },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 120_000,
    });
    // Fără acest ascultător, o eroare de socket ar opri tot procesul.
    client.on('error', (err: Error) => this.log.warn(`Conexiune IMAP: ${err.message}`));
    try {
      await client.connect();
      const lock = await client.getMailboxLock(s.mailbox);
      try {
        await this.sync(client, accountKey(s), result);
      } finally {
        lock.release();
      }
      await client.logout();
      await this.db.query(`UPDATE email_imap_state SET last_success_at = now(), last_error = NULL WHERE mailbox = $1`, [accountKey(s)]);
      return result;
    } catch (err: any) {
      client.close();
      await this.recordFailure(accountKey(s), String(err?.responseText ?? err?.message ?? err).slice(0, 500));
      throw err;
    }
  }

  /** Doar trecerea din funcțional în eroare ajunge în audit, altfel o pană ar umple jurnalul. */
  private async recordFailure(mailbox: string, message: string) {
    await this.db.tx(async (c) => {
      const before = (await c.query('SELECT last_error FROM email_imap_state WHERE mailbox = $1 FOR UPDATE', [mailbox])).rows[0];
      await c.query('UPDATE email_imap_state SET last_error = $2 WHERE mailbox = $1', [mailbox, message]);
      if (!before?.last_error) await this.audit.log(null, { action: 'email.import_esuat', details: { casuta: mailbox.slice(mailbox.lastIndexOf('/') + 1), eroare: message } }, c);
    });
  }

  private async sync(client: ImapFlow, mailbox: string, result: PollResult) {
    const box = client.mailbox as Exclude<ImapFlow['mailbox'], false | undefined>;
    const uidvalidity = String(box.uidValidity);
    const state = await this.db.one('SELECT uidvalidity, last_uid FROM email_imap_state WHERE mailbox = $1', [mailbox]);
    const known = state?.uidvalidity != null && String(state.uidvalidity) === uidvalidity;
    const lastUid = known ? Number(state.last_uid) : 0;

    // Prima rulare (sau UIDVALIDITY schimbat): doar necititele, nu tot istoricul căsuței. Apoi, tot ce are UID mai mare.
    const found = known
      ? await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })
      : await client.search({ seen: false }, { uid: true });
    // `N:*` întoarce mereu ultimul mesaj, chiar dacă are UID mai mic decât N (RFC 3501).
    const uids = (found || []).filter((uid) => !known || uid > lastUid).sort((a, b) => a - b);
    const batch = uids.slice(0, BATCH);
    result.remaining = uids.length > batch.length;

    if (batch.length) {
      const items = await client.fetchAll(batch.join(','), { uid: true, size: true, envelope: true }, { uid: true });
      items.sort((a, b) => a.uid - b.uid);
      for (const item of items) {
        if (this.stopped) { result.remaining = true; return; }
        await this.importOne(client, mailbox, uidvalidity, known, item, result);
      }
    }
    if (!known && !result.remaining) {
      // Poziția se fixează abia când toate necititele au fost preluate; altfel, următoarea rulare le ia pe restul.
      const next = Number(box.uidNext ?? 1) - 1;
      const top = Math.max(next, batch.at(-1) ?? 0);
      await this.db.query(
        `UPDATE email_imap_state SET uidvalidity = $2, last_uid = $3 WHERE mailbox = $1`, [mailbox, uidvalidity, top]);
    }
  }

  private async importOne(client: ImapFlow, mailbox: string, uidvalidity: string, advance: boolean, item: any, result: PollResult) {
    const uid = item.uid as number;
    const envelopeId = cleanMessageId(item.envelope?.messageId);
    const envelopeInfo = () => ({
      messageId: envelopeId,
      fromName: optText(oneLine(clean(item.envelope?.from?.[0]?.name ?? ''))),
      fromAddress: optText(oneLine(clean(item.envelope?.from?.[0]?.address ?? ''))),
      toText: null,
      subject: oneLine(clean(item.envelope?.subject ?? ''), 500),
      sentAt: safeDate(item.envelope?.date),
      bodyText: '',
      bodyTruncated: false,
      attachments: [] as ParsedAttachment[],
    });

    if (envelopeId && await this.isKnown(midKey(envelopeId))) {
      await this.finishDuplicate(client, mailbox, uid, advance, result);
      return;
    }

    let message: ParsedMessage;
    let note: string | null = null;
    let key: string;
    if (Number(item.size ?? 0) > maxMessageBytes()) {
      // Prea mare pentru a fi adus în memorie: rămâne doar antetul, iar originalul rămâne pe server.
      message = envelopeInfo();
      note = `Mesajul are ${mb(item.size)} MB, peste limita de preluare de ${mb(maxMessageBytes())} MB. Nu a fost descărcat; consultați-l direct în căsuța de email.`;
      key = envelopeId ? midKey(envelopeId) : `size:${uidvalidity}:${uid}`;
    } else {
      const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!fetched || !fetched.source) return; // Șters între timp de pe server.
      const raw = fetched.source;
      const sha = crypto.createHash('sha256').update(raw).digest('hex');
      try {
        message = await parseMessage(raw);
        key = message.messageId ? midKey(message.messageId) : `sha:${sha}`;
      } catch (err) {
        this.log.warn(`Mesajul UID ${uid} nu a putut fi citit: ${String(err)}`);
        message = envelopeInfo();
        note = 'Conținutul mesajului nu a putut fi citit; consultați-l direct în căsuța de email.';
        key = envelopeId ? midKey(envelopeId) : `sha:${sha}`;
      }
    }
    if (await this.isKnown(key)) {
      await this.finishDuplicate(client, mailbox, uid, advance, result);
      return;
    }

    const stored: { att: ParsedAttachment; mime: string | null; reason: string | null; storageKey: string | null; sha256: string }[] = [];
    try {
      for (const [index, att] of message.attachments.entries()) {
        const check = index >= MAX_ATTACHMENTS ? { reason: `Mesajul are peste ${MAX_ATTACHMENTS} de atașamente` } : checkAttachment(att);
        const sha256 = crypto.createHash('sha256').update(att.content).digest('hex');
        if ('reason' in check) stored.push({ att, mime: null, reason: check.reason, storageKey: null, sha256 });
        else stored.push({ att, mime: check.mime, reason: null, storageKey: await this.storage.put(att.content), sha256 });
      }
      const inserted = await this.db.tx(async (c) => {
        const row = (await c.query(
          `INSERT INTO email_inbox (mailbox, uidvalidity, uid, dedupe_key, message_id, from_name, from_address, to_text, subject, sent_at, body_text, body_truncated, import_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id`,
          [mailbox, uidvalidity, uid, key, message.messageId, message.fromName, message.fromAddress, message.toText, message.subject, message.sentAt, message.bodyText, message.bodyTruncated, note])).rows[0];
        if (advance) await this.advance(c, mailbox, uid);
        if (!row) return null;
        for (const s of stored) {
          await c.query(
            `INSERT INTO email_inbox_attachments (inbox_id, filename, mime, size_bytes, sha256, storage_key, refused_reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [row.id, s.att.filename, s.mime, s.att.content.length, s.sha256, s.storageKey, s.reason]);
          if (s.reason) await this.audit.log(null, { action: 'email.atasament_refuzat', details: { mesaj: row.id, motiv: s.reason } }, c);
        }
        // Expeditorul și subiectul nu intră în jurnalul imuabil: pot fi date personale.
        await this.audit.log(null, { action: 'email.importat', details: { mesaj: row.id, atasamente: stored.length, refuzate: stored.filter((s) => s.reason).length } }, c);
        return row;
      });
      if (!inserted) {
        await this.removeStored(stored);
        result.duplicates++;
      } else {
        result.imported++;
        result.refusedAttachments += stored.filter((s) => s.reason).length;
      }
    } catch (err) {
      await this.removeStored(stored);
      throw err;
    }
    await this.markSeen(client, uid);
  }

  private async removeStored(stored: { storageKey: string | null }[]) {
    for (const s of stored) if (s.storageKey) await this.storage.remove(s.storageKey);
  }

  private async isKnown(key: string) {
    return !!(await this.db.one('SELECT 1 AS x FROM email_inbox WHERE dedupe_key = $1', [key]));
  }

  private advance(c: Queryable, mailbox: string, uid: number) {
    return c.query('UPDATE email_imap_state SET last_uid = GREATEST(last_uid, $2) WHERE mailbox = $1', [mailbox, uid]);
  }

  private async finishDuplicate(client: ImapFlow, mailbox: string, uid: number, advance: boolean, result: PollResult) {
    if (advance) await this.advance(this.db, mailbox, uid);
    await this.audit.log(null, { action: 'email.duplicat', details: { uid } });
    result.duplicates++;
    await this.markSeen(client, uid);
  }

  /** Doar `\Seen`. Mesajele nu se mută și nu se marchează pentru ștergere pe server. */
  private async markSeen(client: ImapFlow, uid: number) {
    try {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } catch (err) {
      this.log.warn(`Mesajul UID ${uid} nu a putut fi marcat citit: ${String(err)}`);
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }
}

const MESSAGE_COLUMNS = `m.id, m.from_name AS "fromName", m.from_address AS "fromAddress", m.to_text AS "toText", m.subject, m.sent_at AS "sentAt",
  m.imported_at AS "importedAt", m.status, m.import_note AS "importNote", m.handled_at AS "handledAt", h.full_name AS "handledBy"`;

const REGISTER_FIELDS = ['title', 'direction', 'registerId', 'issuer', 'recipient', 'summary', 'dueDate', 'documentTypeId', 'departmentId', 'folderId', 'metadata', 'personalData', 'linkToId', 'linkKind'] as const;

@Injectable()
export class InboxService {
  constructor(private readonly db: Db, private readonly storage: StorageService, private readonly audit: AuditService, private readonly docs: DocumentsService) {}

  async imapStatus() {
    const s = imapSettings();
    if (!s) return { enabled: false, mailbox: null, lastPollAt: null, lastSuccessAt: null, lastError: null };
    const state = await this.db.one(
      `SELECT last_poll_at AS "lastPollAt", last_success_at AS "lastSuccessAt", last_error AS "lastError" FROM email_imap_state WHERE mailbox = $1`, [accountKey(s)]);
    return { enabled: true, mailbox: s.mailbox, lastPollAt: state?.lastPollAt ?? null, lastSuccessAt: state?.lastSuccessAt ?? null, lastError: state?.lastError ?? null };
  }

  /** Legătura către document apare doar pentru cine are acces la document. */
  private documentColumns(user: CurrentUser, params: unknown[]) {
    const visible = visibleSql(user, params);
    return `m.document_id IS NOT NULL AS registered,
      CASE WHEN ${visible} THEN m.document_id END AS "documentId",
      CASE WHEN ${visible} THEN d.reg_label END AS "regLabel"`;
  }

  async list(user: CurrentUser, q: Record<string, string | undefined>) {
    const status = optText(q.status);
    if (status && !['nou', 'inregistrat', 'renuntat'].includes(status)) badRequest('Stare invalidă');
    const limit = Math.min(Math.max(optInt(q.limit, 'limită') ?? 25, 1), 200);
    const offset = Math.max(optInt(q.offset, 'deplasare') ?? 0, 0);
    const total = (await this.db.one('SELECT count(*)::int AS n FROM email_inbox WHERE $1::text IS NULL OR status = $1', [status])).n;
    const params: unknown[] = [status, limit, offset];
    const documentColumns = this.documentColumns(user, params);
    const items = (await this.db.query(
      `SELECT ${MESSAGE_COLUMNS}, ${documentColumns},
         (SELECT count(*)::int FROM email_inbox_attachments a WHERE a.inbox_id = m.id) AS "attachmentCount",
         (SELECT count(*)::int FROM email_inbox_attachments a WHERE a.inbox_id = m.id AND a.refused_reason IS NOT NULL) AS "refusedCount"
       FROM email_inbox m LEFT JOIN users h ON h.id = m.handled_by LEFT JOIN documents d ON d.id = m.document_id
       WHERE $1::text IS NULL OR m.status = $1 ORDER BY m.id DESC LIMIT $2 OFFSET $3`, params)).rows;
    return { total, items, imap: await this.imapStatus() };
  }

  async detail(user: CurrentUser, id: number) {
    const params: unknown[] = [id];
    const documentColumns = this.documentColumns(user, params);
    const message = await this.db.one(
      `SELECT ${MESSAGE_COLUMNS}, ${documentColumns}, m.body_text AS "bodyText", m.body_truncated AS "bodyTruncated", m.attachment_id AS "attachmentId", m.discard_reason AS "discardReason"
       FROM email_inbox m LEFT JOIN users h ON h.id = m.handled_by LEFT JOIN documents d ON d.id = m.document_id WHERE m.id = $1`, params);
    if (!message) notFound('Mesajul nu există');
    const attachments = (await this.db.query(
      `SELECT id, filename, mime, size_bytes::int AS "sizeBytes", refused_reason AS "refusedReason", storage_key IS NOT NULL AS available
       FROM email_inbox_attachments WHERE inbox_id = $1 ORDER BY id`, [id])).rows;
    await this.audit.log(user, { action: 'email.vizualizare', documentId: message!.documentId ?? null, details: { mesaj: id } });
    return { ...message, attachments };
  }

  async download(user: CurrentUser, id: number, attachmentId: number, res: Response) {
    const att = await this.db.one('SELECT * FROM email_inbox_attachments WHERE id = $1 AND inbox_id = $2', [attachmentId, id]);
    if (!att) notFound('Atașamentul nu există');
    if (!att.storage_key) conflict(att.refused_reason ? `Atașament refuzat: ${att.refused_reason}` : 'Atașamentul nu mai este păstrat');
    const data = await this.storage.get(att.storage_key);
    await this.audit.log(user, { action: 'email.atasament_descarcat', details: { mesaj: id, atasament: attachmentId } });
    res.setHeader('Content-Type', att.mime);
    res.setHeader('Content-Length', data.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    // Întotdeauna descărcare: conținutul vine din afara organizației.
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
    res.end(data);
  }

  /**
   * Trece prin DocumentsService.create, cu aceleași validări ca formularul obișnuit. Mesajul se marchează
   * în tranzacția documentului: la conflict nu rămâne nici document, nici număr de registru consumat.
   */
  async register(user: CurrentUser, id: number, body: Record<string, unknown>) {
    const attachmentId = toInt(body.attachmentId, 'atașament');
    const message = await this.db.one('SELECT status FROM email_inbox WHERE id = $1', [id]);
    if (!message) notFound('Mesajul nu există');
    if (message!.status !== 'nou') conflict('Mesajul a fost deja tratat');
    const att = await this.db.one('SELECT * FROM email_inbox_attachments WHERE id = $1 AND inbox_id = $2', [attachmentId, id]);
    if (!att) notFound('Atașamentul nu există');
    if (att.refused_reason) badRequest(`Atașament refuzat: ${att.refused_reason}`);
    if (!att.storage_key) conflict('Atașamentul nu mai este păstrat');
    const buffer = await this.storage.get(att.storage_key);
    const input: Record<string, unknown> = { direction: 'intrat' };
    for (const field of REGISTER_FIELDS) if (body[field] !== undefined) input[field] = body[field];
    const file = {
      // DocumentsService refac numele din latin1, așa cum îl primește de la multer.
      originalname: Buffer.from(att.filename, 'utf8').toString('latin1'),
      mimetype: att.mime,
      buffer,
      size: buffer.length,
    };
    return this.docs.create(user, input as NewDocument, file, async (c, doc) => {
      const updated = await c.query(
        `UPDATE email_inbox SET status = 'inregistrat', document_id = $2, attachment_id = $3, handled_by = $4, handled_at = now() WHERE id = $1 AND status = 'nou'`,
        [id, doc.id, attachmentId, user.id]);
      if (!updated.rowCount) conflict('Mesajul a fost deja tratat');
      await this.audit.log(user, { action: 'email.inregistrat', documentId: doc.id, details: { mesaj: id, atasament: attachmentId } }, c);
    });
  }

  /** Copia locală a atașamentelor se șterge; mesajul original rămâne pe serverul de email. */
  async discard(user: CurrentUser, id: number, body: { reason?: unknown }) {
    const keys = await this.db.tx(async (c) => {
      const row = (await c.query('SELECT status FROM email_inbox WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!row) notFound('Mesajul nu există');
      if (row.status !== 'nou') conflict('Mesajul a fost deja tratat');
      const files = (await c.query('SELECT storage_key FROM email_inbox_attachments WHERE inbox_id = $1 AND storage_key IS NOT NULL', [id])).rows;
      await c.query('UPDATE email_inbox_attachments SET storage_key = NULL WHERE inbox_id = $1', [id]);
      await c.query(
        `UPDATE email_inbox SET status = 'renuntat', discard_reason = $2, handled_by = $3, handled_at = now() WHERE id = $1`,
        [id, optText(body?.reason), user.id]);
      await this.audit.log(user, { action: 'email.renuntat', details: { mesaj: id, atasamente: files.length } }, c);
      return files.map((f) => f.storage_key as string);
    });
    for (const key of keys) await this.storage.remove(key);
    return { ok: true };
  }
}

@Controller('mail/inbox')
@UseGuards(AuthGuard)
@RequirePerm('register')
export class InboxController {
  constructor(private readonly inbox: InboxService, private readonly importer: ImapImporter) {}

  @Get()
  list(@User() user: CurrentUser, @Query() q: Record<string, string>) {
    return this.inbox.list(user, q);
  }

  @Post('poll') @HttpCode(200)
  async poll() {
    if (!imapSettings()) conflict('Preluarea din email nu este configurată');
    try {
      return await this.importer.poll();
    } catch (err: any) {
      throw new HttpException({ message: `Căsuța de email nu poate fi citită: ${String(err?.responseText ?? err?.message ?? 'eroare necunoscută')}` }, 502);
    }
  }

  @Get(':id')
  detail(@User() user: CurrentUser, @Param('id') id: string) {
    return this.inbox.detail(user, toInt(id));
  }

  @Get(':id/attachments/:attachmentId')
  download(@User() user: CurrentUser, @Param('id') id: string, @Param('attachmentId') attachmentId: string, @Res() res: Response) {
    return this.inbox.download(user, toInt(id), toInt(attachmentId), res);
  }

  @Post(':id/register')
  register(@User() user: CurrentUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.inbox.register(user, toInt(id), body);
  }

  @Post(':id/discard') @HttpCode(200)
  discard(@User() user: CurrentUser, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    return this.inbox.discard(user, toInt(id), body);
  }
}
