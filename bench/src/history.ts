import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { insertDrizzle, insertUnnest } from '@soltape/service/persistence/batch-writers.js';
import { from as copyFrom } from 'pg-copy-streams';
import { migrate } from '@soltape/service/persistence/migrations.js';
import { maintainPartitions } from '@soltape/service/persistence/partitions.js';
import type { ConsolidatedRow, ObservationRow } from '@soltape/service/persistence/schema.js';
import { appendSummary } from './report.js';

/**
 * History-writer microbenchmark for the optimization loop: event-loop CPU and wall time per
 * 1,000-row batch for each writer, interleaved against a real Postgres, with an A/A pair.
 * Usage: DATABASE_URL=... node bench/dist/history.js [batches=40] [rows=1000] [--summary]
 */
async function main(): Promise<void> {
  const batches = Number(process.argv[2] ?? 40);
  const rowsPer = Number(process.argv[3] ?? 1000);
  const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] ?? 'postgres://soltape:soltape@127.0.0.1:5432/soltape', max: 4 });
  const c = await pool.connect();
  await migrate(c);
  await maintainPartitions(c, Date.now(), 7);
  c.release();
  const db = drizzle(pool);
  const now = Date.now();
  const cons = (k: number): ConsolidatedRow[] =>
    Array.from({ length: rowsPer }, (_, i) => ({
      ts: new Date(now + k * rowsPer + i),
      mint: 'So11111111111111111111111111111111111111112',
      price: 104 + i / 1e4,
      spreadBps: 0.7,
      nSources: 2,
      degraded: false,
      disagreement: false,
      slot: 458_000_000 + i,
      sources: ['orca:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', 'raydium:route(a,b)'],
    }));
  const obs = (k: number): ObservationRow[] =>
    Array.from({ length: rowsPer }, (_, i) => ({
      ts: new Date(now + k * rowsPer + i),
      mint: 'So11111111111111111111111111111111111111112',
      source: 'orca:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
      price: 104 + i / 1e4,
      size: 123456.7,
      slot: 458_000_000 + i,
      eligible: true,
      reason: null,
    }));
  type BatchWriter = 'drizzle' | 'unnest' | 'copy';
  const variants: { name: string; w: BatchWriter }[] = [
    { name: 'A drizzle insert', w: 'drizzle' },
    { name: "A' (A/A noise floor)", w: 'drizzle' },
    { name: 'B unnest insert', w: 'unnest' },
    { name: 'C COPY text', w: 'copy' },
  ];
  const acc = variants.map(() => ({ cpu: 0, wall: 0 }));
  const run = async (w: BatchWriter, k: number) => {
    const rc = cons(k);
    const ro = obs(k);
    if (w === 'drizzle') {
      await insertDrizzle(db, 'consolidated', rc);
      await insertDrizzle(db, 'observations', ro);
    } else if (w === 'unnest') {
      await insertUnnest(pool, 'consolidated', rc);
      await insertUnnest(pool, 'observations', ro);
    } else {
      await copyRows(pool, 'consolidated', rc);
      await copyRows(pool, 'observations', ro);
    }
  };
  for (const v of variants) await run(v.w, 0); // warm up every path
  for (let b = 1; b <= batches; b++) {
    const order = b % 2 === 0 ? variants.map((_, i) => i) : variants.map((_, i) => variants.length - 1 - i);
    for (const i of order) {
      const t = process.cpuUsage();
      const w0 = performance.now();
      await run(variants[i]!.w, b * variants.length + i);
      const d = process.cpuUsage(t);
      acc[i]!.cpu += d.user + d.system;
      acc[i]!.wall += performance.now() - w0;
    }
  }
  const rows = variants.map((v, i) => `| ${v.name} | ${(acc[i]!.cpu / batches / 1000).toFixed(2)} | ${(acc[i]!.wall / batches).toFixed(1)} |`);
  const md = `### History writes: ${rowsPer} consolidated + ${rowsPer} observation rows per batch, ${batches} batches per variant\n\n| Writer | ms CPU on the event loop / batch | ms wall / batch |\n|---|---:|---:|\n${rows.join('\n')}\n`;
  console.log(md);
  if (process.argv.includes('--summary')) appendSummary(md);
  await pool.end();
}

/* COPY candidate (measured, not shipped: see docs/perf.md iteration 2). */
/** COPY text-format escaping for one field (backslash, tab, newline, carriage return). */
function esc(v: string): string {
  return /[\\\t\n\r]/.test(v) ? v.replace(/[\\\t\n\r]/g, (c) => (c === '\\' ? '\\\\' : c === '\t' ? '\\t' : c === '\n' ? '\\n' : '\\r')) : v;
}
const num = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '\\N' : String(v));
const txt = (v: string | null | undefined) => (v === null || v === undefined ? '\\N' : esc(v));
/** Postgres array literal for text[]: every element quoted, quotes and backslashes escaped. */
const arr = (xs: readonly string[]) => esc(`{${xs.map((x) => `"${x.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(',')}}`);

/** C: COPY FROM STDIN, text format: rows encoded into one string by plain concatenation. */
async function copyRows(pool: pg.Pool, table: 'observations' | 'consolidated', rows: (ObservationRow | ConsolidatedRow)[]): Promise<void> {
  let body = '';
  if (table === 'observations') {
    for (const x of rows as ObservationRow[]) {
      body += `${x.ts.toISOString()}\t${txt(x.mint)}\t${txt(x.source)}\t${num(x.price)}\t${num(x.size)}\t${num(x.slot)}\t${x.eligible ? 't' : 'f'}\t${txt(x.reason)}\n`;
    }
  } else {
    for (const x of rows as ConsolidatedRow[]) {
      body += `${x.ts.toISOString()}\t${txt(x.mint)}\t${num(x.price)}\t${num(x.spreadBps)}\t${num(x.nSources)}\t${x.degraded ? 't' : 'f'}\t${x.disagreement ? 't' : 'f'}\t${num(x.slot)}\t${arr(x.sources)}\n`;
    }
  }
  const cols =
    table === 'observations' ? '(ts, mint, source, price, size, slot, eligible, reason)' : '(ts, mint, price, spread_bps, n_sources, degraded, disagreement, slot, sources)';
  const client = await pool.connect();
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = client.query(copyFrom(`COPY ${table} ${cols} FROM STDIN`));
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.end(body);
    });
  } finally {
    client.release();
  }
}

void main();
