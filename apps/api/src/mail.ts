import { Controller, Get, HttpCode, Injectable, Logger, OnModuleDestroy, Param, Post, Query, UseGuards } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import './config.js';
import { Db, Queryable } from './db.js';
import { conflict, notFound, optInt, optText, toInt } from './http.js';
import { CurrentUser } from './perms.js';

// Citite la fiecare folosire: fără SMTP_HOST, emailul este dezactivat și nu se pune nimic în coadă.
export interface SmtpSettings { host: string; port: number; secure: boolean; user: string | null; pass: string | null; from: string }

export const isLoopback = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(host);

export function smtpSettings(): SmtpSettings | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER?.trim() || null;
  return {
    host,
    port: Number(process.env.SMTP_PORT || (secure ? 465 : 587)),
    secure,
    user,
    pass: process.env.SMTP_PASS || null,
    from: process.env.SMTP_FROM?.trim() || (user?.includes('@') ? user : `SeaDoc <no-reply@${host}>`),
  };
}

const appUrl = (): string | null => {
  const raw = process.env.APP_URL?.trim().replace(/\/+$/, '');
  return raw && /^https?:\/\/[^\s]+$/i.test(raw) ? raw : null;
};

/** O singură linie, fără caractere de control: nimic dintr-un titlu nu poate deveni antet. */
export function oneLine(value: string, max = 300): string {
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Motivul pentru care nu se livrează la această adresă, sau null dacă se poate livra.
 * Câmpul din cont este text liber: o virgulă l-ar transforma în mai mulți destinatari.
 */
export function undeliverableReason(address: string): string | null {
  const match = /^([^\s@<>(),;:"\\[\]\x00-\x1f\x7f]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.?)$/i.exec(address);
  if (!match) return 'Adresă de email invalidă';
  const domain = match[2].toLowerCase().replace(/\.$/, '');
  if (domain === 'invalid' || domain.endsWith('.invalid')) return 'Domeniu .invalid: nu se livrează';
  return null;
}

export function composeEmail(title: string, refs: { documentId?: number | null }) {
  const line = oneLine(title);
  const base = appUrl();
  const target = refs.documentId != null ? `/documente/${refs.documentId}` : '/sarcini';
  const body = [
    line,
    '',
    base ? `Deschideți în SeaDoc: ${base}${target}` : 'Autentificați-vă în SeaDoc pentru detalii.',
    '',
    'Mesaj automat. Nu răspundeți la acest email.',
  ].join('\n');
  return { subject: `[SeaDoc] ${line}`, body };
}

/** Doar un INSERT pe clientul tranzacției: nicio operație de rețea, iar anularea tranzacției anulează și emailul. */
export async function enqueueEmail(client: Queryable, userId: number, kind: string, title: string, refs: { documentId?: number; taskId?: number }) {
  if (!smtpSettings()) return;
  const user = (await client.query('SELECT email, active FROM users WHERE id = $1', [userId])).rows[0];
  const address = user?.active ? optText(user.email) : null;
  if (!address) return;
  const reason = undeliverableReason(address);
  const { subject, body } = composeEmail(title, refs);
  await client.query(
    `INSERT INTO email_outbox (user_id, to_address, subject, body, kind, document_id, task_id, status, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, address, subject, body, kind, refs.documentId ?? null, refs.taskId ?? null, reason ? 'ignorat' : 'in_asteptare', reason]);
}

export const MAX_ATTEMPTS = 8;
const RETRY_BASE_SECONDS = 60;
const RETRY_CAP_SECONDS = 3600;
// Rezervarea rândului: dacă procesul moare în timpul trimiterii, mesajul redevine scadent după acest interval.
const LEASE_SECONDS = 300;
const retryDelay = (attempts: number) => Math.min(RETRY_BASE_SECONDS * 2 ** (attempts - 1), RETRY_CAP_SECONDS);

/** Respingerea definitivă a destinatarului; orice altceva (rețea, 4xx, autentificare) se reîncearcă. */
function isPermanent(err: any): boolean {
  return err?.code === 'EENVELOPE' && err.responseCode >= 500 && err.responseCode < 600;
}
const CONNECTION_ERRORS = new Set(['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'EAUTH', 'ETLS', 'EREQUIRETLS', 'ENOAUTH']);

@Injectable()
export class MailWorker implements OnModuleDestroy {
  private readonly log = new Logger('Email');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<DrainResult> | null = null;
  private stopped = false;

  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  start() {
    if (!smtpSettings()) {
      this.log.log('Email dezactivat: SMTP_HOST nu este setat');
      return;
    }
    const tick = () => { void this.drain().catch((err) => this.log.error(`Coada de email: ${String(err)}`)); };
    this.timer = setInterval(tick, Number(process.env.MAIL_POLL_MS ?? 15_000));
    this.timer.unref();
    tick();
  }

  /** Trimite ce este scadent. O singură rulare la un moment dat. */
  drain(): Promise<DrainResult> {
    if (this.stopped) return Promise.resolve(emptyDrain());
    this.running ??= this.work().finally(() => { this.running = null; });
    return this.running;
  }

  private async work(): Promise<DrainResult> {
    const result = emptyDrain();
    const smtp = smtpSettings();
    if (!smtp) return result;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      // Parola nu circulă necriptat decât pe interfața locală.
      requireTLS: !smtp.secure && !!smtp.user && !isLoopback(smtp.host),
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      while (!this.stopped) {
        const row = await this.claim();
        if (!row) break;
        if (await this.deliver(transport, smtp, row, result)) break;
      }
    } finally {
      transport.close();
    }
    return result;
  }

  private async claim() {
    return (await this.db.query(
      `UPDATE email_outbox SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $1)
       WHERE id = (SELECT id FROM email_outbox WHERE status = 'in_asteptare' AND next_attempt_at <= now()
                   ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`, [LEASE_SECONDS])).rows[0];
  }

  /** Întoarce true când serverul pare indisponibil și nu are rost să continuăm acum. */
  private async deliver(transport: Transporter, smtp: SmtpSettings, row: any, result: DrainResult): Promise<boolean> {
    // A doua verificare, chiar lângă trimitere: un rând .invalid nu ajunge niciodată la server.
    const reason = undeliverableReason(row.to_address);
    if (reason) {
      await this.db.query(`UPDATE email_outbox SET status = 'ignorat', last_error = $2 WHERE id = $1`, [row.id, reason]);
      result.skipped++;
      return false;
    }
    if (row.attempts > MAX_ATTEMPTS) {
      await this.giveUp(row, 'Numărul maxim de încercări a fost depășit după o întrerupere');
      result.failed++;
      return false;
    }
    try {
      await transport.sendMail({
        from: smtp.from,
        to: row.to_address,
        subject: oneLine(row.subject, 400),
        text: row.body,
        // Plicul este explicit: destinatarul nu se deduce din antete.
        envelope: { from: bareAddress(smtp.from), to: row.to_address },
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 500);
      if (isPermanent(err) || row.attempts >= MAX_ATTEMPTS) {
        await this.giveUp(row, message);
        result.failed++;
      } else {
        await this.db.query(
          `UPDATE email_outbox SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`,
          [row.id, message, retryDelay(row.attempts)]);
        result.retried++;
      }
      this.log.warn(`Email ${row.id}, încercarea ${row.attempts}: ${message}`);
      return CONNECTION_ERRORS.has(err?.code);
    }
    await this.db.tx(async (c) => {
      await c.query(`UPDATE email_outbox SET status = 'trimis', sent_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
      await this.audit.log(null, { action: 'email.trimis', documentId: row.document_id, details: { coada: row.id, destinatar: row.user_id, tip: row.kind, incercari: row.attempts } }, c);
    });
    result.sent++;
    return false;
  }

  private async giveUp(row: any, message: string) {
    await this.db.tx(async (c) => {
      await c.query(`UPDATE email_outbox SET status = 'esuat', last_error = $2 WHERE id = $1`, [row.id, message]);
      await this.audit.log(null, { action: 'email.esuat', documentId: row.document_id, details: { coada: row.id, destinatar: row.user_id, tip: row.kind, incercari: row.attempts, eroare: message } }, c);
    });
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }
}

export interface DrainResult { sent: number; retried: number; failed: number; skipped: number }
const emptyDrain = (): DrainResult => ({ sent: 0, retried: 0, failed: 0, skipped: 0 });

function bareAddress(from: string): string {
  const match = /<([^<>]+)>\s*$/.exec(from);
  return match ? match[1] : from;
}

@Controller('mail')
@UseGuards(AuthGuard)
@RequirePerm('users_admin')
export class MailAdminController {
  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  /** Starea trimiterii; parola nu apare niciodată aici. */
  @Get('status')
  async status() {
    const smtp = smtpSettings();
    const counts = (await this.db.query('SELECT status, count(*)::int AS n FROM email_outbox GROUP BY status')).rows;
    return {
      smtp: { enabled: !!smtp, host: smtp?.host ?? null, from: smtp?.from ?? null, appUrl: appUrl() },
      counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
    };
  }

  @Get('outbox')
  async outbox(@Query() q: Record<string, string>) {
    const status = optText(q.status);
    const limit = Math.min(Math.max(optInt(q.limit, 'limită') ?? 50, 1), 200);
    const offset = Math.max(optInt(q.offset, 'deplasare') ?? 0, 0);
    const total = (await this.db.one('SELECT count(*)::int AS n FROM email_outbox WHERE $1::text IS NULL OR status = $1', [status])).n;
    const items = (await this.db.query(
      `SELECT o.id, o.to_address AS "toAddress", u.full_name AS "userName", o.subject, o.kind, o.document_id AS "documentId", o.status, o.attempts,
              o.next_attempt_at AS "nextAttemptAt", o.last_error AS "lastError", o.created_at AS "createdAt", o.sent_at AS "sentAt"
       FROM email_outbox o JOIN users u ON u.id = o.user_id
       WHERE $1::text IS NULL OR o.status = $1 ORDER BY o.id DESC LIMIT $2 OFFSET $3`, [status, limit, offset])).rows;
    return { total, items };
  }

  @Post('outbox/:id/retry') @HttpCode(200)
  async retry(@User() user: CurrentUser, @Param('id') id: string) {
    const outboxId = toInt(id);
    return this.db.tx(async (c) => {
      const row = (await c.query('SELECT status FROM email_outbox WHERE id = $1 FOR UPDATE', [outboxId])).rows[0];
      if (!row) notFound('Mesajul nu există în coadă');
      if (row.status !== 'esuat') conflict('Se pot retrimite doar mesajele eșuate');
      await c.query(`UPDATE email_outbox SET status = 'in_asteptare', attempts = 0, next_attempt_at = now() WHERE id = $1`, [outboxId]);
      await this.audit.log(user, { action: 'email.retrimitere', details: { coada: outboxId } }, c);
      return { ok: true };
    });
  }
}
