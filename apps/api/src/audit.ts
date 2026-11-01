import { Injectable } from '@nestjs/common';
import { Db, Queryable } from './db.js';
import { CurrentUser } from './perms.js';

export interface AuditEntry {
  action: string;
  documentId?: number | null;
  details?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: Db) {}

  async log(user: Pick<CurrentUser, 'id' | 'username'> & { ip?: string } | null, entry: AuditEntry, client: Queryable = this.db) {
    await client.query(
      `INSERT INTO audit_log (seq, at, user_id, username, action, document_id, ip, details, prev_hash, hash)
       VALUES (0, now(), $1, $2, $3, $4, $5, $6, '', '')`,
      [user?.id ?? null, user?.username ?? 'sistem', entry.action, entry.documentId ?? null, user?.ip ?? null, JSON.stringify(entry.details ?? {})],
    );
  }

  /** Recalculează lanțul de hash-uri; întoarce primul rând alterat, dacă există. */
  async verifyChain(): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
    const r = await this.db.one(
      `WITH chain AS (
         SELECT a.seq, a.hash, a.prev_hash,
                lag(a.hash, 1, '') OVER (ORDER BY a.seq) AS expected_prev,
                audit_row_hash(a.prev_hash, a) AS expected_hash
         FROM audit_log a)
       SELECT count(*)::int AS checked,
              min(seq) FILTER (WHERE prev_hash <> expected_prev OR hash <> expected_hash) AS broken
       FROM chain`,
    );
    return { ok: r.broken == null, checked: r.checked, brokenAt: r.broken == null ? null : Number(r.broken) };
  }
}
