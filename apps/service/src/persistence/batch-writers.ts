import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { consolidated, observations, type ConsolidatedRow, type ObservationRow } from './schema.js';

/**
 * Ways to write one history batch. Both take the same rows and do one round trip; they differ
 * only in how much work happens on the event loop to encode the batch. Measured in
 * docs/perf.md (iteration 2): the ORM path spends most of its time in per-value checks, so
 * the sink uses `insertUnnest`. The ORM path is kept for the A/B benchmark.
 */
export type BatchWriter = 'drizzle' | 'unnest';

export type Table = 'observations' | 'consolidated';
type Row<T extends Table> = T extends 'observations' ? ObservationRow : ConsolidatedRow;

/** A: Drizzle multi-row INSERT (one bound parameter per value). */
export async function insertDrizzle<T extends Table>(db: NodePgDatabase, table: T, rows: Row<T>[]): Promise<void> {
  if (table === 'observations') await db.insert(observations).values(rows as ObservationRow[]);
  else await db.insert(consolidated).values(rows as ConsolidatedRow[]);
}

const SEP = '\u001f';

/**
 * One parameterized INSERT … SELECT FROM unnest(column arrays): one bound parameter per column
 * however many rows (also well clear of Postgres's 65,535-parameter limit).
 * @spec PER-PG-012
 */
export async function insertUnnest<T extends Table>(client: pg.Pool | pg.PoolClient, table: T, rows: Row<T>[]): Promise<void> {
  if (table === 'observations') {
    const r = rows as ObservationRow[];
    await client.query(
      `INSERT INTO observations (ts, mint, source, price, size, slot, eligible, reason)
       SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::float8[], $5::float8[], $6::int8[], $7::bool[], $8::text[])`,
      [
        r.map((x) => x.ts),
        r.map((x) => x.mint),
        r.map((x) => x.source),
        r.map((x) => x.price),
        r.map((x) => x.size ?? null),
        r.map((x) => x.slot ?? null),
        r.map((x) => x.eligible),
        r.map((x) => x.reason ?? null),
      ],
    );
  } else {
    const r = rows as ConsolidatedRow[];
    await client.query(
      `INSERT INTO consolidated (ts, mint, price, spread_bps, n_sources, degraded, disagreement, slot, sources)
       SELECT ts, mint, price, spread_bps, n_sources, degraded, disagreement, slot, string_to_array(sources, E'\\x1f')
       FROM unnest($1::timestamptz[], $2::text[], $3::float8[], $4::float8[], $5::int2[], $6::bool[], $7::bool[], $8::int8[], $9::text[])
         AS t(ts, mint, price, spread_bps, n_sources, degraded, disagreement, slot, sources)`,
      [
        r.map((x) => x.ts),
        r.map((x) => x.mint),
        r.map((x) => x.price),
        r.map((x) => x.spreadBps),
        r.map((x) => x.nSources),
        r.map((x) => x.degraded),
        r.map((x) => x.disagreement),
        r.map((x) => x.slot ?? null),
        r.map((x) => x.sources.join(SEP)),
      ],
    );
  }
}
