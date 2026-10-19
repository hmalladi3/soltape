import type { Clock } from '@soltape/shared';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Bucket, HistoryBucket, HistoryReader } from '../api/history.js';
import { BUCKETS } from '../api/history.js';
import type { MarketModel } from '../markets/model.js';
import type { Consolidated, ConsolidatedListener, ObservationListener, ObservationView } from '../reconcile/types.js';
import type { Logger } from '../telemetry/logger.js';
import { migrate } from './migrations.js';
import { DAY_MS, maintainPartitions, startOfDayUtc, type MaintenanceReport } from './partitions.js';
import { consolidated, observations, type ConsolidatedRow, type ObservationRow } from './schema.js';

export interface PgHistoryOptions {
  queueMax: number;
  batchRows: number;
  flushMs: number;
  retryDelayMs: number;
  maintenanceMs: number;
  retentionDays: number;
  writerPoolMax: number;
  readerPoolMax: number;
  connectTimeoutMs: number;
  writeStatementTimeoutMs: number;
  readStatementTimeoutMs: number;
  reconnectMs: number;
}

export const DEFAULT_PG_OPTIONS: PgHistoryOptions = {
  queueMax: 50_000,
  batchRows: 1_000,
  flushMs: 250,
  retryDelayMs: 1_000,
  maintenanceMs: 3_600_000,
  retentionDays: 7,
  writerPoolMax: 4,
  readerPoolMax: 2,
  connectTimeoutMs: 2_000,
  writeStatementTimeoutMs: 5_000,
  readStatementTimeoutMs: 2_000,
  reconnectMs: 2_000,
};

/** Fixed-capacity FIFO that drops the oldest item when full (PER-PG-013). */
export class Ring<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private n = 0;
  constructor(readonly capacity: number) {
    this.buf = new Array<T | undefined>(capacity);
  }
  get size(): number {
    return this.n;
  }
  /** @returns true if the oldest item was dropped to make room. */
  push(item: T): boolean {
    const dropped = this.n === this.capacity;
    if (dropped) {
      this.head = (this.head + 1) % this.capacity;
      this.n--;
    }
    this.buf[(this.head + this.n) % this.capacity] = item;
    this.n++;
    return dropped;
  }
  take(max: number): T[] {
    const k = Math.min(max, this.n);
    const out = new Array<T>(k);
    for (let i = 0; i < k; i++) {
      out[i] = this.buf[this.head]!;
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
    }
    this.n -= k;
    return out;
  }
}

type Table = 'pg_observations' | 'pg_consolidated';

/**
 * Rolling history in Postgres: daily range partitions, a bounded batch writer per table and a
 * separate read pool for /history. Never on the hot path and never a startup dependency.
 * See docs/llds/persistence.md.
 * @spec PER-COM-001, PER-COM-002
 */
export class PgHistory implements ConsolidatedListener, ObservationListener, HistoryReader {
  readonly stats = {
    dropped: { pg_observations: 0, pg_consolidated: 0 } as Record<Table, number>,
    written: { pg_observations: 0, pg_consolidated: 0 } as Record<Table, number>,
    lastMaintenance: null as MaintenanceReport | null,
  };
  private readonly o: PgHistoryOptions;
  private readonly writer: pg.Pool;
  private readonly reader: pg.Pool;
  private readonly db: NodePgDatabase;
  private readonly queues: Record<Table, Ring<ObservationRow | ConsolidatedRow>>;
  private readonly inflight: Record<Table, Promise<void> | null> = { pg_observations: null, pg_consolidated: null };
  private up = false;
  private migrated = false;
  private connecting: Promise<boolean> | null = null;
  private stopped = false;
  private flushTimer: NodeJS.Timeout | undefined;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly log: Logger;

  constructor(
    private readonly d: { url: string; model: MarketModel; clock: Clock; logger: Logger; options?: Partial<PgHistoryOptions> },
  ) {
    this.o = { ...DEFAULT_PG_OPTIONS, ...d.options };
    this.log = d.logger.child({ component: 'persistence', sink: 'postgres' });
    // @spec PER-PG-015
    this.writer = new pg.Pool({
      connectionString: d.url,
      max: this.o.writerPoolMax,
      connectionTimeoutMillis: this.o.connectTimeoutMs,
      options: `-c statement_timeout=${this.o.writeStatementTimeoutMs}`,
    });
    // @spec PER-PG-016
    this.reader = new pg.Pool({
      connectionString: d.url,
      max: this.o.readerPoolMax,
      connectionTimeoutMillis: this.o.connectTimeoutMs,
      options: `-c statement_timeout=${this.o.readStatementTimeoutMs}`,
    });
    // Idle-client errors (e.g. the server restarting) must never crash the process.
    this.writer.on('error', (err) => this.log.debug({ err }, 'idle writer client error'));
    this.reader.on('error', (err) => this.log.debug({ err }, 'idle reader client error'));
    this.db = drizzle(this.writer);
    this.queues = { pg_observations: new Ring(this.o.queueMax), pg_consolidated: new Ring(this.o.queueMax) };
  }

  state(): 'up' | 'down' {
    return this.up ? 'up' : 'down';
  }

  pending(): number {
    return this.queues.pg_observations.size + this.queues.pg_consolidated.size;
  }

  /** Connects, migrates and maintains partitions in the background; retries until it works. */
  start(): void {
    void this.ensureReady();
    this.flushTimer = setInterval(() => void this.flushAll(), this.o.flushMs);
    this.flushTimer.unref();
    this.maintenanceTimer = setInterval(() => void this.maintain().catch(() => undefined), this.o.maintenanceMs);
    this.maintenanceTimer.unref();
  }

  // ---- enqueue (hot-path adjacent: O(1), never awaits) -----------------------------------

  // @spec PER-PG-011
  onConsolidated(_market: number, c: Consolidated): void {
    this.push('pg_consolidated', {
      ts: new Date(c.updatedAt),
      mint: c.mint,
      price: c.price,
      spreadBps: c.spreadBps,
      nSources: c.sources.length,
      degraded: c.degraded,
      disagreement: c.disagreement,
      slot: c.slot,
      sources: c.sources,
    });
  }

  onUnavailable(): void {
    // No price, no row: outages appear in history as gaps.
  }

  // @spec PER-PG-010
  onObservation(market: number, _venue: number, o: ObservationView): void {
    if (o.price === null || o.restored) return;
    this.push('pg_observations', {
      ts: new Date(o.receivedAt ?? this.d.clock.wall()),
      mint: this.d.model.markets[market]!.mint,
      source: o.source,
      price: o.price,
      size: o.size,
      slot: o.slot,
      eligible: o.eligible,
      reason: o.reason,
    });
  }

  // @spec PER-PG-013
  private push(table: Table, row: ObservationRow | ConsolidatedRow): void {
    if (this.queues[table].push(row)) this.stats.dropped[table]++;
    if (this.queues[table].size >= this.o.batchRows) void this.flush(table);
  }

  // ---- flushing ---------------------------------------------------------------------------

  async flushAll(): Promise<void> {
    await Promise.all([this.flush('pg_observations'), this.flush('pg_consolidated')]);
  }

  /** Drains both queues completely (used at shutdown). */
  async drain(): Promise<void> {
    while (this.pending() > 0 && !this.stopped) {
      const before = this.pending();
      await this.flushAll();
      await Promise.all(Object.values(this.inflight));
      if (this.pending() >= before && !this.up) return;
    }
  }

  // @spec PER-PG-012, PER-PG-014
  private flush(table: Table): Promise<void> {
    if (this.inflight[table] || this.queues[table].size === 0) return this.inflight[table] ?? Promise.resolve();
    const run = (async () => {
      const batch = this.queues[table].take(this.o.batchRows);
      if (!(await this.insertWithRetry(table, batch))) {
        this.stats.dropped[table] += batch.length;
        this.markDown('flush failed after retry');
      } else {
        this.stats.written[table] += batch.length;
      }
    })().finally(() => (this.inflight[table] = null));
    this.inflight[table] = run;
    return run;
  }

  private async insertWithRetry(table: Table, batch: (ObservationRow | ConsolidatedRow)[]): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.o.retryDelayMs));
      try {
        if (!this.up && !(await this.ensureReady())) continue;
        if (table === 'pg_observations') await this.db.insert(observations).values(batch as ObservationRow[]);
        else await this.db.insert(consolidated).values(batch as ConsolidatedRow[]);
        return true;
      } catch (err) {
        this.log.debug({ err, table, attempt }, 'history insert failed');
      }
    }
    return false;
  }

  private markDown(reason: string): void {
    if (!this.up) return;
    this.up = false;
    this.log.warn({ reason }, 'history sink down');
  }

  /**
   * Migrates (once) and maintains partitions before the sink is marked up, so partitions
   * always exist before the first flush after any outage.
   */
  private ensureReady(): Promise<boolean> {
    this.connecting ??= (async () => {
      try {
        const client = await this.writer.connect();
        try {
          if (!this.migrated) {
            const applied = await migrate(client);
            if (applied.length) this.log.info({ applied }, 'migrations applied');
            this.migrated = true;
          }
          this.stats.lastMaintenance = await maintainPartitions(client, this.d.clock.wall(), this.o.retentionDays);
        } finally {
          client.release();
        }
        this.up = true;
        this.log.info({ defaultRows: this.stats.lastMaintenance.defaultRows }, 'history sink up');
        return true;
      } catch (err) {
        this.log.warn({ err: String(err) }, this.migrated ? 'history sink unavailable' : 'history migration failed; live feed unaffected');
        if (!this.stopped && !this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.ensureReady();
          }, this.o.reconnectMs);
          this.reconnectTimer.unref();
        }
        return false;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  async maintain(): Promise<MaintenanceReport> {
    const client = await this.writer.connect();
    try {
      this.stats.lastMaintenance = await maintainPartitions(client, this.d.clock.wall(), this.o.retentionDays);
      return this.stats.lastMaintenance;
    } finally {
      client.release();
    }
  }

  // ---- reads (HistoryReader) ---------------------------------------------------------------

  available(): boolean {
    return this.up;
  }

  retentionStartMs(): number {
    return startOfDayUtc(this.d.clock.wall()) - this.o.retentionDays * DAY_MS;
  }

  /** Bucketed OHLC from consolidated history via `date_bin`; empty buckets are omitted. */
  // @spec PER-PG-016
  async query(mint: string, fromMs: number, toMs: number, bucket: Bucket): Promise<HistoryBucket[]> {
    const res = await this.reader.query<{ t: Date; open: number; high: number; low: number; close: number; samples: string }>(
      `SELECT date_bin(make_interval(secs => $4::double precision), ts, TIMESTAMPTZ 'epoch') AS t,
              (array_agg(price ORDER BY ts ASC))[1]  AS open,
              max(price) AS high,
              min(price) AS low,
              (array_agg(price ORDER BY ts DESC))[1] AS close,
              count(*) AS samples
         FROM consolidated
        WHERE mint = $1 AND ts >= $2 AND ts < $3
        GROUP BY 1 ORDER BY 1`,
      [mint, new Date(fromMs), new Date(toMs), BUCKETS[bucket] / 1000],
    );
    return res.rows.map((r) => ({ t: r.t.toISOString(), open: r.open, high: r.high, low: r.low, close: r.close, samples: Number(r.samples) }));
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.flushTimer);
    clearInterval(this.maintenanceTimer);
    clearTimeout(this.reconnectTimer);
    await Promise.all(Object.values(this.inflight));
    await Promise.allSettled([this.writer.end(), this.reader.end()]);
  }
}
