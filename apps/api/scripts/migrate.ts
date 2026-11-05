import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/** Forward-only SQL migrations, each applied in a transaction and recorded in schema_migrations. */
export async function migrate(url = process.env.DATABASE_URL ?? 'postgres://cloudconnect:cloudconnect@localhost:5432/cloudconnect', log = console.log) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`SELECT pg_advisory_lock(727274)`); // one migrator at a time (k8s Job + replicas)
    const done = new Set((await client.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
    const dir = join(__dirname, '..', 'db', 'migrations');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      log(`applying ${f}`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, f), 'utf8'));
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(727274)`).catch(() => undefined);
    await client.end();
  }
}
if (require.main === module) migrate().then(() => console.log('migrations complete')).catch((e) => { console.error(e); process.exit(1); });
