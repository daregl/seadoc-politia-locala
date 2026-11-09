import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import crypto from 'node:crypto';
import { AuditService } from './audit.js';
import { AuthGuard, RequirePerm, User } from './auth.js';
import { Db } from './db.js';
import { DocumentsService } from './documents.js';
import { badRequest, conflict, forbidden, notFound, optInt, optText, toInt } from './http.js';
import { NotificationService } from './notifications.js';
import { can, CurrentUser } from './perms.js';

const KINDS = ['anunt', 'procedura'];
const TODAY = `(now() AT TIME ZONE 'Europe/Bucharest')::date`;

/** Un anunț pentru toată instituția sau pentru un compartiment; expiratele și retrasele nu se mai arată. */
const AUDIENCE = (uid: string, dep: string) => `(p.department_id IS NULL OR p.department_id = ${dep}
  OR p.published_by = ${uid})`;

@Controller('intranet')
@UseGuards(AuthGuard)
export class IntranetController {
  constructor(private readonly db: Db, private readonly audit: AuditService, private readonly notifications: NotificationService, private readonly docs: DocumentsService) {}

  @Get()
  async list(@User() user: CurrentUser, @Query() q: Record<string, string | undefined>) {
    const kind = optText(q.kind);
    if (kind && !KINDS.includes(kind)) badRequest('Tip invalid');
    const all = q.all === '1' && can(user, 'intranet_publish');
    const params: unknown[] = [user.id, user.departmentId ?? -1, kind];
    const where = all
      ? '($3::text IS NULL OR p.kind = $3)'
      : `($3::text IS NULL OR p.kind = $3) AND p.withdrawn_at IS NULL AND (p.expires_on IS NULL OR p.expires_on >= ${TODAY}) AND ${AUDIENCE('$1', '$2')}`;
    const rows = (await this.db.query(
      `SELECT p.id, p.kind, p.title, p.body, p.department_id AS "departmentId", dep.name AS "departmentName", p.pinned, p.requires_ack AS "requiresAck",
              p.expires_on::text AS "expiresOn", p.published_at AS "publishedAt", u.full_name AS "publishedBy", p.withdrawn_at AS "withdrawnAt",
              p.document_id AS "documentId", d.reg_label AS "documentLabel", d.title AS "documentTitle",
              r.read_at AS "readAt", r.acknowledged_at AS "acknowledgedAt",
              (SELECT count(*)::int FROM intranet_reads x WHERE x.post_id = p.id AND x.acknowledged_at IS NOT NULL) AS "ackCount"
       FROM intranet_posts p JOIN users u ON u.id = p.published_by LEFT JOIN departments dep ON dep.id = p.department_id
       LEFT JOIN documents d ON d.id = p.document_id LEFT JOIN intranet_reads r ON r.post_id = p.id AND r.user_id = $1
       WHERE ${where} AND $2::int IS NOT NULL
       ORDER BY p.pinned DESC, p.published_at DESC LIMIT 200`, params)).rows;
    return rows;
  }

  @Post() @RequirePerm('intranet_publish')
  async publish(@User() user: CurrentUser, @Body() body: Record<string, unknown>) {
    const kind = String(body.kind ?? 'anunt');
    if (!KINDS.includes(kind)) badRequest('Tip invalid');
    const title = optText(body.title);
    const text = optText(body.body);
    if (!title) badRequest('Câmp obligatoriu: titlul');
    if (!text) badRequest('Câmp obligatoriu: textul');
    const departmentId = optInt(body.departmentId, 'compartiment');
    // Șeful de serviciu publică doar pentru compartimentul lui; anunțurile generale le dă conducerea,
    // adică șefii compartimentului din care se subordonează alte compartimente.
    if (user.role !== 'admin' && departmentId !== user.departmentId) {
      const leadership = user.departmentId != null && (await this.db.one('SELECT 1 FROM departments WHERE parent_id = $1 LIMIT 1', [user.departmentId])) != null;
      if (!leadership) forbidden('Puteți publica doar pentru compartimentul dumneavoastră');
    }
    const expiresOn = optText(body.expiresOn);
    if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) badRequest('Data expirării este invalidă');
    const documentId = optInt(body.documentId, 'document');
    if (documentId != null) await this.docs.requireVisible(user, documentId);
    return this.db.tx(async (c) => {
      const p = (await c.query(
        `INSERT INTO intranet_posts (kind, title, body, department_id, document_id, pinned, requires_ack, expires_on, published_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [kind, title, text, departmentId, documentId, body.pinned === true, body.requiresAck === true, expiresOn, user.id])).rows[0];
      const audience = (await c.query(
        `SELECT id FROM users WHERE active AND id <> $1 AND ($2::int IS NULL OR department_id = $2)`, [user.id, departmentId])).rows;
      const label = kind === 'procedura' ? 'Procedură nouă' : 'Anunț';
      for (const u of audience) await this.notifications.send(u.id, 'intranet', `${label}: ${title}`, { link: `/intranet#post-${p.id}` }, c);
      await this.audit.log(user, { action: 'intranet.publicat', documentId, details: { anunt: p.id, tip: kind, compartiment: departmentId, destinatari: audience.length } }, c);
      return { id: p.id, notified: audience.length };
    });
  }

  @Post(':id/read') @HttpCode(200)
  async read(@User() user: CurrentUser, @Param('id') id: string, @Body() body: { acknowledge?: boolean }) {
    const post = await this.db.one(
      `SELECT p.* FROM intranet_posts p WHERE p.id = $1 AND p.withdrawn_at IS NULL AND ${AUDIENCE('$2', '$3')}`, [toInt(id), user.id, user.departmentId ?? -1]);
    if (!post) notFound('Anunțul nu există');
    const ack = body.acknowledge === true;
    await this.db.query(
      `INSERT INTO intranet_reads (post_id, user_id, acknowledged_at) VALUES ($1,$2,CASE WHEN $3 THEN now() END)
       ON CONFLICT (post_id, user_id) DO UPDATE SET acknowledged_at = coalesce(intranet_reads.acknowledged_at, excluded.acknowledged_at)`,
      [post.id, user.id, ack]);
    if (ack) await this.audit.log(user, { action: 'intranet.luat_la_cunostinta', details: { anunt: post.id } });
    return { ok: true };
  }

  @Get(':id/acknowledgements') @RequirePerm('intranet_publish')
  async acks(@Param('id') id: string) {
    return (await this.db.query(
      `SELECT u.full_name AS "fullName", dep.name AS "departmentName", r.read_at AS "readAt", r.acknowledged_at AS "acknowledgedAt"
       FROM intranet_reads r JOIN users u ON u.id = r.user_id LEFT JOIN departments dep ON dep.id = u.department_id
       WHERE r.post_id = $1 ORDER BY r.acknowledged_at NULLS LAST, u.full_name`, [toInt(id)])).rows;
  }

  @Delete(':id') @RequirePerm('intranet_publish')
  async withdraw(@User() user: CurrentUser, @Param('id') id: string) {
    const post = await this.db.one('SELECT * FROM intranet_posts WHERE id = $1', [toInt(id)]);
    if (!post) notFound('Anunțul nu există');
    if (user.role !== 'admin' && post.published_by !== user.id) forbidden('Puteți retrage doar ce ați publicat');
    if (post.withdrawn_at) conflict('Anunțul este deja retras');
    await this.db.query('UPDATE intranet_posts SET withdrawn_at = now() WHERE id = $1', [post.id]);
    await this.audit.log(user, { action: 'intranet.retras', details: { anunt: post.id } });
    return { ok: true };
  }
}

export const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Tokenuri pentru sistemele care se integrează prin API: se văd o singură dată, la creare. */
@Controller('admin/api-tokens')
@UseGuards(AuthGuard)
@RequirePerm('users_admin')
export class ApiTokensController {
  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  @Get()
  async list() {
    return (await this.db.query(
      `SELECT t.id, t.name, t.prefix, t.user_id AS "userId", u.username, u.full_name AS "userName", t.expires_on::text AS "expiresOn",
              t.created_at AS "createdAt", c.full_name AS "createdBy", t.last_used_at AS "lastUsedAt", t.revoked_at AS "revokedAt"
       FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN users c ON c.id = t.created_by ORDER BY t.revoked_at NULLS FIRST, t.id DESC`)).rows;
  }

  @Post()
  async create(@User() user: CurrentUser, @Body() body: Record<string, unknown>) {
    const name = optText(body.name);
    if (!name) badRequest('Câmp obligatoriu: denumirea integrării');
    const userId = toInt(body.userId, 'cont');
    const target = await this.db.one('SELECT id, username, active FROM users WHERE id = $1', [userId]);
    if (!target?.active) badRequest('Contul trebuie să existe și să fie activ');
    const expiresOn = optText(body.expiresOn);
    if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) badRequest('Data expirării este invalidă');
    const token = `sd_${crypto.randomBytes(30).toString('base64url')}`;
    const r = (await this.db.query(
      `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_on, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, name, tokenHash(token), token.slice(0, 10), expiresOn, user.id])).rows[0];
    await this.audit.log(user, { action: 'admin.token_api_creat', details: { token: r.id, cont: target.username, denumire: name } });
    return { id: r.id, token };
  }

  @Delete(':id')
  async revoke(@User() user: CurrentUser, @Param('id') id: string) {
    const r = await this.db.query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id', [toInt(id)]);
    if (!r.rowCount) notFound('Tokenul nu există sau este deja revocat');
    await this.audit.log(user, { action: 'admin.token_api_revocat', details: { token: toInt(id) } });
    return { ok: true };
  }
}
