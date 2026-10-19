import type { DependencyState, DependencyStatus } from '../api/health.js';
import type { Consolidated, ConsolidatedListener, EmitStamps, RestoredMarket } from '../reconcile/types.js';
import type { PersistenceLifecycle } from '../runtime/runtime.js';
import type { PgHistory } from './pg-history.js';
import type { RedisLatestStore } from './redis-latest.js';

/**
 * Both sinks behind one lifecycle, one reconciler listener and one dependency report.
 * Neither sink's state affects the live feed (HLD Goal 3).
 */
export class Persistence implements PersistenceLifecycle, DependencyStatus, ConsolidatedListener {
  constructor(private readonly d: { redisStore: RedisLatestStore; history: PgHistory; restoreInto: (entries: RestoredMarket[]) => void }) {}

  startBackground(): void {
    this.d.redisStore.start();
    this.d.history.start();
  }

  async restore(): Promise<void> {
    this.d.restoreInto(await this.d.redisStore.restore());
  }

  async flush(deadlineMs: number): Promise<{ unflushed: number }> {
    let t: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all([this.d.history.drain(), this.d.redisStore.flush()]), new Promise<void>((r) => (t = setTimeout(r, deadlineMs)))]);
    clearTimeout(t);
    return { unflushed: this.d.history.pending() };
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.d.redisStore.close(), this.d.history.close()]);
  }

  redis(): DependencyState {
    return this.d.redisStore.state();
  }

  postgres(): DependencyState {
    return this.d.history.state();
  }

  onConsolidated(market: number, c: Consolidated, _stamps: EmitStamps): void {
    this.d.redisStore.onConsolidated(market);
    this.d.history.onConsolidated(market, c);
  }

  onUnavailable(market: number): void {
    this.d.redisStore.onUnavailable(market);
  }
}
