import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';

export type Queryable = {
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
};

@Injectable()
export class Db implements OnApplicationShutdown {
  readonly pool = new pg.Pool({ connectionString: config.databaseUrl, max: 12 });

  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]) {
    return this.pool.query<T>(text, params as any[]);
  }

  async one<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<T | undefined> {
    return (await this.query<T>(text, params)).rows[0];
  }

  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    await this.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())');
    const done = new Set((await this.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(config.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
      await this.tx(async (c) => {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
    }
  }

  // Ultima fază de oprire: serviciile de fundal și cererile în curs mai au nevoie de conexiuni până aici.
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
