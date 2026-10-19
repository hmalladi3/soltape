import type { PoolClient } from 'pg';

/** Advisory lock key shared by migrations and partition maintenance ("solt" in ASCII; fits a JS number exactly). */
export const ADVISORY_LOCK_KEY = 0x736f6c74;

/**
 * Ordered, append-only SQL migrations. Hand-written because declarative partitioning
 * (PARTITION BY RANGE, DEFAULT partitions) is not modelled by Drizzle's generator.
 */
// @spec PER-PG-001, PER-PG-002
export const MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: '0001_history_tables',
    sql: `
      CREATE TABLE observations (
        ts        timestamptz      NOT NULL,
        mint      text             NOT NULL,
        source    text             NOT NULL,
        price     double precision NOT NULL,
        size      double precision,
        slot      bigint,
        eligible  boolean          NOT NULL,
        reason    text
      ) PARTITION BY RANGE (ts);
      CREATE TABLE observations_default PARTITION OF observations DEFAULT;
      CREATE INDEX observations_mint_ts ON observations (mint, ts);

      CREATE TABLE consolidated (
        ts           timestamptz      NOT NULL,
        mint         text             NOT NULL,
        price        double precision NOT NULL,
        spread_bps   double precision NOT NULL,
        n_sources    smallint         NOT NULL,
        degraded     boolean          NOT NULL,
        disagreement boolean          NOT NULL,
        slot         bigint,
        sources      text[]           NOT NULL
      ) PARTITION BY RANGE (ts);
      CREATE TABLE consolidated_default PARTITION OF consolidated DEFAULT;
      CREATE INDEX consolidated_mint_ts ON consolidated (mint, ts);
    `,
  },
];

/**
 * Applies pending migrations in one transaction under the advisory lock.
 * @returns ids applied by this call
 * @spec PER-PG-006, PER-PG-007
 */
export async function migrate(client: PoolClient): Promise<string[]> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query('CREATE TABLE IF NOT EXISTS soltape_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ id: string }>('SELECT id FROM soltape_migrations')).rows.map((r) => r.id));
    const applied: string[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query(m.sql);
      await client.query('INSERT INTO soltape_migrations (id) VALUES ($1)', [m.id]);
      applied.push(m.id);
    }
    await client.query('COMMIT');
    return applied;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
