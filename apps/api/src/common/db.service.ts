import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { config } from '../config';

export type Queryable = { query: <R extends QueryResultRow = any>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }> };

@Injectable()
export class Db implements OnModuleInit, OnModuleDestroy {
  readonly pool = new Pool({ connectionString: config().DATABASE_URL, max: config().DATABASE_POOL_MAX });

  /** node-pg does not know extension types: parse citext[] like text[]. */
  async onModuleInit() {
    const r = await this.pool.query(`SELECT typarray FROM pg_type WHERE typname = 'citext'`).catch(() => null);
    const oid = r?.rows[0]?.typarray;
    if (oid) types.setTypeParser(oid, types.getTypeParser(1009 as any));
  }

  async query<R extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<R[]> {
    return (await this.pool.query<R>(sql, params)).rows;
  }
  async one<R extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<R | undefined> {
    return (await this.query<R>(sql, params))[0];
  }

  /** Run fn in a transaction with RLS tenant context set. */
  async tx<T>(orgId: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (orgId) await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      else await client.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() { await this.pool.end(); }
}
