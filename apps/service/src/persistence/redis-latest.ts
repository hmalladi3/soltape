import type { Clock } from '@soltape/shared';
import { Redis } from 'ioredis';
import type { MarketModel } from '../markets/model.js';
import type { Consolidated, ConsolidatedListener, ObservationListener, ObservationView, RestoredMarket } from '../reconcile/types.js';
import type { Logger } from '../telemetry/logger.js';
import { restConsolidated } from '../api/views.js';

export const SCHEMA_VERSION = 1;
export const marketKey = (mint: string) => `soltape:v${SCHEMA_VERSION}:market:${mint}`;
export const META_KEY = `soltape:v${SCHEMA_VERSION}:meta`;

/** Where the store reads current state at flush time. */
export interface LatestStateSource {
  consolidated(market: number): Consolidated | null;
  observations(market: number): ObservationView[];
}

export interface RedisLatestOptions {
  flushMs: number;
  ttlMs: number;
}

export const DEFAULT_REDIS_OPTIONS: RedisLatestOptions = { flushMs: 100, ttlMs: 24 * 3_600_000 };

/**
 * Latest-value snapshot in Redis, for warm restarts (and future read replicas). Writes are
 * coalesced: a dirty bit per market, flushed every `flushMs` from the *current* state in one
 * pipeline. Memory and write rate never depend on the update rate. See persistence.md.
 * @spec PER-COM-001
 */
export class RedisLatestStore implements ConsolidatedListener, ObservationListener {
  readonly stats = { flushes: 0, written: 0, skipped: 0, restoreIgnored: 0 };
  private readonly redis: Redis;
  private readonly dirty: Uint8Array;
  private dirtyCount = 0;
  private flushing = false;
  private timer: NodeJS.Timeout | undefined;
  private wasReady = false;
  private readonly o: RedisLatestOptions;
  private readonly log: Logger;

  constructor(
    private readonly d: { url: string; model: MarketModel; source: LatestStateSource; clock: Clock; logger: Logger; options?: Partial<RedisLatestOptions> },
  ) {
    this.o = { ...DEFAULT_REDIS_OPTIONS, ...d.options };
    this.log = d.logger.child({ component: 'persistence', sink: 'redis' });
    this.dirty = new Uint8Array(d.model.markets.length);
    // @spec PER-RDS-003
    this.redis = new Redis(d.url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(30_000, 200 * 2 ** Math.min(times, 8)),
    });
    this.redis.on('error', (err) => this.log.debug({ err }, 'redis error'));
    // @spec PER-RDS-004
    this.redis.on('ready', () => {
      if (this.wasReady) this.markAll();
      this.wasReady = true;
      this.log.info({}, 'redis up');
    });
    this.redis.on('end', () => this.log.warn({}, 'redis connection ended'));
  }

  state(): 'up' | 'down' {
    return this.redis.status === 'ready' ? 'up' : 'down';
  }

  /** Connects in the background and starts the flush timer. Never throws. */
  start(): void {
    this.redis.connect().catch((err: unknown) => this.log.warn({ err }, 'redis unavailable; will retry'));
    this.timer = setInterval(() => void this.flush(), this.o.flushMs);
    this.timer.unref();
  }

  // @spec PER-RDS-001
  onConsolidated(market: number): void {
    this.mark(market);
  }
  onUnavailable(market: number): void {
    this.mark(market);
  }
  onObservation(market: number): void {
    this.mark(market);
  }

  private mark(market: number): void {
    if (this.dirty[market] === 0) {
      this.dirty[market] = 1;
      this.dirtyCount++;
    }
  }

  private markAll(): void {
    for (let m = 0; m < this.dirty.length; m++) this.mark(m);
  }

  /** Writes every dirty market's current state in one pipeline. At most one flush in flight. */
  // @spec PER-RDS-002
  async flush(): Promise<void> {
    if (this.flushing || this.dirtyCount === 0) return;
    if (this.state() !== 'up') {
      this.stats.skipped++;
      return;
    }
    this.flushing = true;
    const markets: number[] = [];
    for (let m = 0; m < this.dirty.length; m++) if (this.dirty[m] === 1) markets.push(m);
    for (const m of markets) this.dirty[m] = 0;
    this.dirtyCount -= markets.length;
    try {
      const p = this.redis.pipeline();
      for (const m of markets) {
        const mint = this.d.model.markets[m]!.mint;
        const fields: Record<string, string> = { updatedAt: String(this.d.clock.wall()) };
        const c = this.d.source.consolidated(m);
        if (c) fields['consolidated'] = JSON.stringify({ ...restConsolidated(c), trigger: c.trigger });
        for (const o of this.d.source.observations(m)) if (!o.restored) fields[`src:${o.source}`] = JSON.stringify(o);
        p.hset(marketKey(mint), fields);
        p.pexpire(marketKey(mint), this.o.ttlMs);
      }
      p.hset(META_KEY, { schema: String(SCHEMA_VERSION) });
      const res = await p.exec();
      if (res?.some(([err]) => err)) throw res.find(([err]) => err)![0]!;
      this.stats.flushes++;
      this.stats.written += markets.length;
    } catch (err) {
      for (const m of markets) this.mark(m);
      this.log.debug({ err }, 'redis flush failed; will retry');
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Reads the snapshot of every configured market for display-only warm restore.
   * Malformed, wrong-schema or unknown-source entries are ignored and counted.
   * @spec PER-RDS-005, PER-RDS-006
   */
  async restore(waitMs = 450): Promise<RestoredMarket[]> {
    // startBackground() has usually begun connecting already; wait for that connection
    // rather than starting a second one (ioredis rejects connect() while connecting).
    if (this.redis.status === 'wait') this.redis.connect().catch(() => undefined);
    if (this.state() !== 'up') await this.whenReady(waitMs);
    if (this.state() !== 'up') return [];
    const schema = await this.redis.hget(META_KEY, 'schema');
    if (schema !== null && schema !== String(SCHEMA_VERSION)) return [];
    const p = this.redis.pipeline();
    for (const m of this.d.model.markets) p.hgetall(marketKey(m.mint));
    const res = (await p.exec()) ?? [];
    const out: RestoredMarket[] = [];
    this.d.model.markets.forEach((m, i) => {
      const [err, hash] = res[i] ?? [null, null];
      if (err || !hash || typeof hash !== 'object' || Object.keys(hash).length === 0) return;
      const h = hash as Record<string, string>;
      const configured = new Set(m.venues.map((v) => v.sourceId));
      let consolidated: Consolidated | null = null;
      if (h['consolidated'] !== undefined) {
        const c = parseJson(h['consolidated']);
        if (isConsolidated(c, m.mint)) consolidated = c;
        else this.stats.restoreIgnored++;
      }
      const sources: ObservationView[] = [];
      for (const [k, v] of Object.entries(h)) {
        if (!k.startsWith('src:')) continue;
        const o = parseJson(v);
        if (configured.has(k.slice(4)) && isObservation(o)) sources.push(o);
        else this.stats.restoreIgnored++;
      }
      if (consolidated || sources.length) out.push({ mint: m.mint, consolidated, sources });
    });
    return out;
  }

  private whenReady(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.redis.off('ready', done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.redis.once('ready', done);
    });
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    if (this.redis.status === 'ready') await this.flush();
    this.redis.disconnect();
  }
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isConsolidated(v: unknown, mint: string): v is Consolidated {
  const c = v as Partial<Consolidated> | undefined;
  return !!c && c.mint === mint && typeof c.price === 'number' && Array.isArray(c.sources) && Array.isArray(c.excluded) && typeof c.updatedAt === 'string' && typeof c.seq === 'number';
}

function isObservation(v: unknown): v is ObservationView {
  const o = v as Partial<ObservationView> | undefined;
  return !!o && typeof o.source === 'string' && typeof o.venue === 'string' && 'price' in o && typeof o.eligible === 'boolean';
}
