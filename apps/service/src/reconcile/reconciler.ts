import type { Clock, SourceId } from '@soltape/shared';
import type { MarketModel } from '../markets/model.js';
import type {
  Consolidated,
  ConsolidatedListener,
  ObservationListener,
  ObservationView,
  PoolUpdateKind,
  ReconcileThresholds,
  RestoredMarket,
  SourceSink,
  SourceStatus,
} from './types.js';

export interface ReconcilerDeps {
  model: MarketModel;
  clock: Clock;
  thresholds: ReconcileThresholds;
}

/**
 * The single place of judgement: source liveness, observation eligibility, and the
 * consolidated price per market. See docs/llds/reconciliation.md.
 */
export class Reconciler implements SourceSink {
  constructor(_deps: ReconcilerDeps) {}

  /** Gateway is always invoked before persistence (REC-EMIT-001). */
  setListeners(_l: { gateway?: ConsolidatedListener; persistence?: ConsolidatedListener; observations?: ObservationListener[] }): void {}

  onPoolUpdate(_pool: number, _sqrtRatio: number, _liquidity: number, _tick: number, _slot: number, _recvTs: number, _recvWall: number, _decodedTs: number, _kind: PoolUpdateKind): void {}
  onQuote(_market: number, _price: number, _blockId: number | null, _recvTs: number, _recvWall: number): void {}
  onSlot(_source: SourceId, _slot: number | null, _recvTs: number): void {}
  onSourceState(_source: SourceId, _state: 'disabled' | 'connecting' | 'live' | 'down'): void {}
  onPoolSuspect(_pool: number): void {}
  onPoolMisconfigured(_pool: number): void {}

  /** Re-evaluates liveness and expiry; runs every `sweepMs` once started (REC-SWP-001). */
  sweep(): void {}
  start(): void {}
  /** Stops the sweep and all emissions (REC-LIFE-001). */
  freeze(): void {}

  restore(_entries: readonly RestoredMarket[]): void {}

  consolidated(_market: number): Consolidated | null {
    return null;
  }
  available(_market: number): boolean {
    return false;
  }
  observations(_market: number): ObservationView[] {
    return [];
  }
  sourceStatus(_source: SourceId): SourceStatus {
    return { state: 'connecting', lastEventAgeMs: null, staleSince: null };
  }
  isPoolMisconfigured(_pool: number): boolean {
    return false;
  }
  /** Inputs that produced no emission because nothing changed (REC-CONS-007). */
  suppressedCount(_market: number): number {
    return 0;
  }
}
