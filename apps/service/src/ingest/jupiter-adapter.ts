import type { Clock } from '@soltape/shared';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import type { MarketModel } from '../markets/model.js';
import type { SourceSink } from '../reconcile/types.js';
import type { Logger } from '../telemetry/logger.js';
import { retryAfterMs } from './backoff.js';

export interface JupiterOptions {
  intervalMs: number;
  timeoutMs: number;
  failsToDown: number;
  maxIntervalMs: number;
}

export const DEFAULT_JUPITER_OPTIONS: JupiterOptions = { intervalMs: 2000, timeoutMs: 2000, failsToDown: 3, maxIntervalMs: 30_000 };

export interface JupiterAdapterDeps {
  model: MarketModel;
  sink: SourceSink;
  clock: Clock;
  logger: Logger;
  url: string;
  apiKey: string | undefined;
  options?: Partial<JupiterOptions>;
  fetch?: typeof fetch;
}

const entrySchema = z.object({
  usdPrice: z.number().positive(),
  blockId: z.number().int().nonnegative().nullable().optional(),
});
const bodySchema = z.record(z.string(), z.unknown());

/**
 * Polls Jupiter Price API v3 for every tracked mint plus the quote mint, converting USD
 * prices into the quote unit with the quote's price from the same response.
 * See docs/llds/ingest-sources.md § Jupiter Adapter.
 * @spec ING-SRC-001
 */
export class JupiterAdapter {
  readonly id = 'jupiter' as const;
  readonly stats = { polls: 0, failures: 0, rateLimited: 0 };

  private readonly d: JupiterAdapterDeps;
  private readonly o: JupiterOptions;
  private readonly log: Logger;
  private readonly ids: string;
  private interval: number;
  private consecutiveFailures = 0;
  private state: 'disabled' | 'connecting' | 'live' | 'down' = 'connecting';
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private inflight: Promise<void> | undefined;
  /** Own keep-alive pool, closed on stop (RUN-LIFE-012). */
  private readonly agent = new Agent({ keepAliveTimeout: 30_000 });

  constructor(deps: JupiterAdapterDeps) {
    this.d = deps;
    this.o = { ...DEFAULT_JUPITER_OPTIONS, ...deps.options };
    this.log = deps.logger.child({ component: 'ingest', source: 'jupiter' });
    this.interval = this.o.intervalMs;
    const mints = deps.model.markets.filter((m) => m.venues.some((v) => v.venue === 'jupiter')).map((m) => m.mint);
    this.ids = [...mints, deps.model.quote.mint].join(',');
  }

  // @spec ING-JUP-001
  async start(): Promise<void> {
    if (!this.d.apiKey) {
      this.state = 'disabled';
      this.d.sink.onSourceState('jupiter', 'disabled');
      return;
    }
    this.d.sink.onSourceState('jupiter', 'connecting');
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inflight;
    await this.agent.close();
  }

  /** Single-flight: the next poll is scheduled only after the previous one settles. */
  // @spec ING-JUP-002
  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inflight = this.poll().finally(() => {
        this.inflight = undefined;
        this.schedule(this.interval);
      });
    }, ms);
  }

  // @spec ING-JUP-002, ING-JUP-003, ING-JUP-010, ING-JUP-011
  private async poll(): Promise<void> {
    this.stats.polls++;
    const f = this.d.fetch ?? (undiciFetch as unknown as typeof fetch);
    let res: Response;
    try {
      res = await f(`${this.d.url}?ids=${this.ids}`, {
        headers: { 'x-api-key': this.d.apiKey! },
        signal: AbortSignal.timeout(this.o.timeoutMs),
        dispatcher: this.agent,
      } as unknown as RequestInit);
    } catch (err) {
      return this.failed(err instanceof DOMException && err.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    const recvTs = this.d.clock.mono();
    const recvWall = this.d.clock.wall();
    if (res.status === 429) {
      this.stats.rateLimited++;
      await res.body?.cancel();
      const ra = retryAfterMs(res.headers.get('retry-after'), recvWall);
      this.interval = ra !== null ? Math.max(this.o.intervalMs, ra) : Math.min(this.o.maxIntervalMs, this.interval * 2);
      return this.failed('rate_limited');
    }
    if (!res.ok) {
      await res.body?.cancel();
      return this.failed(`http_${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return this.failed('invalid_json');
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success || Array.isArray(body)) return this.failed('invalid_body');
    this.succeeded(parsed.data, recvTs, recvWall);
  }

  // @spec ING-JUP-004, ING-JUP-005, ING-JUP-006, ING-JUP-007, ING-JUP-009
  private succeeded(body: Record<string, unknown>, recvTs: number, recvWall: number): void {
    this.consecutiveFailures = 0;
    this.interval = Math.max(this.o.intervalMs, Math.floor(this.interval / 2));
    const entry = (mint: string) => {
      const r = entrySchema.safeParse(Object.hasOwn(body, mint) ? body[mint] : undefined);
      return r.success ? r.data : null;
    };
    const quote = entry(this.d.model.quote.mint);
    let blockId: number | null = null;
    for (const m of [this.d.model.quote.mint, ...this.d.model.markets.map((x) => x.mint)]) {
      const e = entry(m);
      if (e?.blockId != null && (blockId === null || e.blockId > blockId)) blockId = e.blockId;
    }
    if (this.state !== 'live') {
      this.state = 'live';
      this.d.sink.onSourceState('jupiter', 'live');
    }
    this.d.sink.onSlot('jupiter', blockId, recvTs);
    if (!quote) {
      this.log.warn({}, 'Jupiter response lacks a valid quote-mint entry; no prices this poll');
      return;
    }
    for (const m of this.d.model.markets) {
      if (!m.venues.some((v) => v.venue === 'jupiter')) continue;
      const e = entry(m.mint);
      if (!e) continue;
      this.d.sink.onQuote(m.index, e.usdPrice / quote.usdPrice, e.blockId ?? null, recvTs, recvWall);
    }
  }

  private failed(reason: string): void {
    this.stats.failures++;
    this.consecutiveFailures++;
    this.log.debug({ reason, consecutive: this.consecutiveFailures }, 'Jupiter poll failed');
    if (this.consecutiveFailures >= this.o.failsToDown && this.state !== 'down') {
      this.state = 'down';
      this.d.sink.onSourceState('jupiter', 'down');
      this.log.warn({ reason }, `Jupiter down after ${this.consecutiveFailures} consecutive failures`);
    }
  }
}
