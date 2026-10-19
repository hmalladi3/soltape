import type { PoolClient } from 'pg';
import { ADVISORY_LOCK_KEY } from './migrations.js';
import { HISTORY_TABLES, type HistoryTable } from './schema.js';

export const DAY_MS = 86_400_000;
export const startOfDayUtc = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const dayName = (table: HistoryTable, dayStart: number) => `${table}_${new Date(dayStart).toISOString().slice(0, 10).replaceAll('-', '')}`;
const iso = (ms: number) => new Date(ms).toISOString();

export interface MaintenanceReport {
  created: string[];
  moved: { partition: string; rows: number }[];
  dropped: string[];
  defaultRows: Record<HistoryTable, number>;
}

/**
 * Ensures daily partitions for today and the next `aheadDays` days, moving any rows that
 * landed in the DEFAULT partition for those ranges into the new partition in the same
 * transaction (Postgres refuses to create a partition that overlaps DEFAULT rows). Drops
 * daily partitions that end before the retention window. Runs under the advisory lock.
 * @spec PER-PG-003, PER-PG-004, PER-PG-005, PER-PG-006
 */
export async function maintainPartitions(client: PoolClient, nowWall: number, retentionDays: number, aheadDays = 2): Promise<MaintenanceReport> {
  const report: MaintenanceReport = { created: [], moved: [], dropped: [], defaultRows: { observations: 0, consolidated: 0 } };
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);
    const today = startOfDayUtc(nowWall);
    for (const table of HISTORY_TABLES) {
      const existing = new Set(
        (
          await client.query<{ name: string }>(
            `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = $1`,
            [table],
          )
        ).rows.map((r) => r.name),
      );
      for (let d = 0; d <= aheadDays; d++) {
        const from = today + d * DAY_MS;
        const name = dayName(table, from);
        if (existing.has(name)) continue;
        const range = `FOR VALUES FROM ('${iso(from)}') TO ('${iso(from + DAY_MS)}')`;
        const stray = Number((await client.query(`SELECT count(*)::int AS n FROM ${table}_default WHERE ts >= $1 AND ts < $2`, [iso(from), iso(from + DAY_MS)])).rows[0].n);
        if (stray === 0) {
          await client.query(`CREATE TABLE ${name} PARTITION OF ${table} ${range}`);
        } else {
          await client.query(`CREATE TABLE ${name} (LIKE ${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
          await client.query(`WITH moved AS (DELETE FROM ${table}_default WHERE ts >= $1 AND ts < $2 RETURNING *) INSERT INTO ${name} SELECT * FROM moved`, [iso(from), iso(from + DAY_MS)]);
          await client.query(`ALTER TABLE ${table} ATTACH PARTITION ${name} ${range}`);
          report.moved.push({ partition: name, rows: stray });
        }
        report.created.push(name);
        existing.add(name);
      }
      const cutoff = today - retentionDays * DAY_MS;
      for (const name of existing) {
        const m = /_(\d{4})(\d{2})(\d{2})$/.exec(name);
        if (!m) continue; // never the DEFAULT partition
        const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + DAY_MS;
        if (end <= cutoff) {
          await client.query(`DROP TABLE ${name}`);
          report.dropped.push(name);
        }
      }
      report.defaultRows[table] = Number((await client.query(`SELECT count(*)::int AS n FROM ${table}_default`)).rows[0].n);
    }
    await client.query('COMMIT');
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
