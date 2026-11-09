import { Controller, Get, HttpCode, Injectable, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, User } from './auth.js';
import { Db, Queryable } from './db.js';
import { toInt } from './http.js';
import { enqueueEmail } from './mail.js';
import { CurrentUser } from './perms.js';

@Injectable()
export class NotificationService {
  constructor(private readonly db: Db) {}

  async send(userId: number, kind: string, title: string, refs: { documentId?: number; taskId?: number; link?: string } = {}, client: Queryable = this.db) {
    await client.query('INSERT INTO notifications (user_id, kind, title, document_id, task_id, link) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, kind, title, refs.documentId ?? null, refs.taskId ?? null, refs.link ?? null]);
    await enqueueEmail(client, userId, kind, title, refs);
  }
}

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@User() user: CurrentUser) {
    const rows = (await this.db.query(
      `SELECT id, kind, title, document_id AS "documentId", task_id AS "taskId", link, read_at AS "readAt", created_at AS "createdAt"
       FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50`, [user.id])).rows;
    const unread = (await this.db.one('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [user.id])).n;
    return { unread, items: rows };
  }

  @Post('read-all') @HttpCode(200)
  async readAll(@User() user: CurrentUser) {
    await this.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
    return { ok: true };
  }

  @Post(':id/read') @HttpCode(200)
  async read(@Param('id') id: string, @User() user: CurrentUser) {
    await this.db.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2', [toInt(id), user.id]);
    return { ok: true };
  }
}
