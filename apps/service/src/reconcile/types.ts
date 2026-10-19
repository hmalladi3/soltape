import type { SourceId, SourceState } from '@soltape/shared';

export type ExclusionReason =
  'source_disabled' | 'misconfigured' | 'no_data' | 'source_down' | 'source_stale' | 'source_recovering' | 'decode_error' | 'expired' | 'invalid_value' | 'outlier';

export interface Exclusion {
  source: string;
  reason: ExclusionReason;
  /** 1-based failing leg for route observations (REC-ELIG-002). */
  leg?: number;
}

export interface Trigger {
  source: string;
  slot: number | null;
}

export interface Consolidated {
  mint: string;
  symbol: string;
  quote: string;
  price: number;
  sources: string[];
  excluded: Exclusion[];
  spreadBps: number;
  degraded: boolean;
  disagreement: boolean;
  slot: number | null;
  /** ISO-8601 wall-clock time of the evaluation. */
  updatedAt: string;
  seq: number;
  trigger: Trigger;
  /** Present and true only on display-only values (unavailable market or restored). */
  stale?: true;
  restored?: true;
}

export interface LegView {
  pool: string;
  price: number | null;
  slot: number | null;
  ageMs: number | null;
}

export interface ObservationView {
  source: string;
  venue: SourceId;
  kind: 'pool' | 'route' | 'aggregator';
  sourceState: SourceState;
  price: number | null;
  size: number | null;
  slot: number | null;
  /** Wall-clock epoch ms of receipt, or null. */
  receivedAt: number | null;
  ageMs: number | null;
  eligible: boolean;
  reason: ExclusionReason | null;
  leg?: number;
  legs?: LegView[];
  restored?: true;
}

/** Monotonic stage stamps of the input that triggered an emission (OBS-LAT-003). */
export interface EmitStamps {
  recvTs: number | null;
  decodedTs: number | null;
  reconciledTs: number;
}

export interface ConsolidatedListener {
  onConsolidated(market: number, c: Consolidated, stamps: EmitStamps): void;
  onUnavailable(market: number, lastKnown: Consolidated | null): void;
}

export interface ObservationListener {
  onObservation(market: number, venueIndex: number, o: ObservationView): void;
}

export type PoolUpdateKind = 'notification' | 'snapshot' | 'revalidation';

/** What source adapters report (ING-SRC-001). Hot-path methods take scalars, not objects. */
export interface SourceSink {
  onPoolUpdate(pool: number, sqrtRatio: number, liquidity: number, tick: number, slot: number, recvTs: number, recvWall: number, decodedTs: number, kind: PoolUpdateKind): void;
  onQuote(market: number, price: number, blockId: number | null, recvTs: number, recvWall: number): void;
  onSlot(source: SourceId, slot: number | null, recvTs: number): void;
  onSourceState(source: SourceId, state: 'disabled' | 'connecting' | 'live' | 'down'): void;
  onPoolSuspect(pool: number): void;
  onPoolMisconfigured(pool: number, reason?: string): void;
}

export interface ReconcileThresholds {
  slotSilenceMs: number;
  jupiterPollMs: number;
  jupiterMaxSlotLag: number;
  recoveryHoldMs: number;
  obsMaxAgeMs: number;
  outlierBps: number;
  depthBand: number;
  sweepMs: number;
}

export const DEFAULT_THRESHOLDS: ReconcileThresholds = {
  slotSilenceMs: 2000,
  jupiterPollMs: 2000,
  jupiterMaxSlotLag: 150,
  recoveryHoldMs: 1000,
  obsMaxAgeMs: 60_000,
  outlierBps: 100,
  depthBand: 0.01,
  sweepMs: 250,
};

export interface SourceStatus {
  state: SourceState;
  /** ms since the source's last liveness event, or null if none. */
  lastEventAgeMs: number | null;
  /** Monotonic time the source became stale, or null when not stale. */
  staleSince: number | null;
}

/** A value restored from Redis at boot: display only (REC-ELIG-003). */
export interface RestoredMarket {
  mint: string;
  consolidated: Consolidated | null;
  sources: ObservationView[];
}
