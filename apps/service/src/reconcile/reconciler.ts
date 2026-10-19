import type { Clock, SourceId, SourceState } from '@soltape/shared';
import type { MarketModel, VenueObservationDef } from '../markets/model.js';
import type {
  Consolidated,
  ConsolidatedListener,
  Exclusion,
  ExclusionReason,
  LegView,
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

/** Reason codes as small integers for allocation-free change detection. 0 = eligible. */
const REASONS: readonly (ExclusionReason | null)[] = [
  null,
  'source_disabled',
  'misconfigured',
  'no_data',
  'source_down',
  'source_stale',
  'source_recovering',
  'decode_error',
  'expired',
  'invalid_value',
  'outlier',
];
const R = {
  OK: 0,
  DISABLED: 1,
  MISCONFIGURED: 2,
  NO_DATA: 3,
  DOWN: 4,
  STALE: 5,
  RECOVERING: 6,
  DECODE_ERROR: 7,
  EXPIRED: 8,
  INVALID: 9,
  OUTLIER: 10,
} as const;

const SOURCES: readonly SourceId[] = ['orca', 'raydium', 'jupiter'];
const SRC_INDEX: Record<SourceId, number> = { orca: 0, raydium: 1, jupiter: 2 };
const JUPITER = 2;

type AdapterState = 'disabled' | 'connecting' | 'live' | 'down';

/** Mutable per-source registry state. */
interface SourceRec {
  adapter: AdapterState;
  judged: SourceState;
  liveSince: number;
  /** RPC: last slot notification. Jupiter: last successful poll. */
  lastEventTs: number;
  lastSlot: number;
  lastBlockId: number | null;
  holdStart: number;
  staleSince: number | null;
  outOfOrder: number;
}

/**
 * The single place of judgement: source liveness, observation eligibility, and the
 * consolidated price per market. Hot-path state lives in preallocated typed arrays indexed
 * by pool, market and observation; objects are only allocated when an output changes.
 * See docs/llds/reconciliation.md.
 */
export class Reconciler implements SourceSink {
  private readonly model: MarketModel;
  private readonly clock: Clock;
  private readonly t: ReconcileThresholds;
  /** 1 - 1/sqrt(1 + band): depth factor for a one-sided move of `depthBand`. */
  private readonly depthK: number;

  private gateway: ConsolidatedListener | undefined;
  private persistence: ConsolidatedListener | undefined;
  private observers: ObservationListener[] = [];
  private frozen = false;
  private timer: NodeJS.Timeout | undefined;

  // Sources
  private readonly src: SourceRec[];
  /** Markets using each source index. */
  private readonly sourceUsers: number[][];

  // Pools
  private readonly pSqrt: Float64Array;
  private readonly pLiq: Float64Array;
  private readonly pTick: Float64Array;
  private readonly pSlot: Float64Array;
  private readonly pRecv: Float64Array;
  private readonly pWall: Float64Array;
  private readonly pSeen: Uint8Array;
  private readonly pSuspect: Uint8Array;
  private readonly pMisconf: Uint8Array;
  private readonly pMisconfReason = new Map<number, string>();
  /** 10^(decimalsA - decimalsB) per pool. */
  private readonly pScale: Float64Array;

  // Jupiter quotes per market
  private readonly qPrice: Float64Array;
  private readonly qSlot: Float64Array;
  private readonly qRecv: Float64Array;
  private readonly qWall: Float64Array;
  private readonly qSeen: Uint8Array;

  // Observations (flat: obsBase[m] + venue index)
  private readonly obsBase: Int32Array;
  private readonly oPrice: Float64Array;
  private readonly oSize: Float64Array;
  private readonly oSlot: Float64Array;
  private readonly oRecv: Float64Array;
  private readonly oWall: Float64Array;
  private readonly oReason: Uint8Array;
  private readonly oLeg: Uint8Array;
  /** Last values reported to observation listeners. */
  private readonly nPrice: Float64Array;
  private readonly nReason: Uint8Array;
  private readonly nLeg: Uint8Array;
  private readonly nSeen: Uint8Array;

  // Markets
  private readonly mAvailable: Uint8Array;
  private readonly mEmitted: Uint8Array;
  private readonly mSeq: Float64Array;
  private readonly mSuppressed: Float64Array;
  private readonly mLastPrice: Float64Array;
  private readonly mLastDegraded: Uint8Array;
  private readonly mLastDisagree: Uint8Array;
  /** Per observation: last emitted reason*16+leg (0 = eligible). */
  private readonly sigReason: Int32Array;
  private readonly mLast: (Consolidated | null)[];
  private readonly mRestored: (RestoredMarket | null)[];

  /** Median scratch (no allocation). */
  private readonly scratch = new Float64Array(16);

  constructor({ model, clock, thresholds }: ReconcilerDeps) {
    this.model = model;
    this.clock = clock;
    this.t = thresholds;
    this.depthK = 1 - 1 / Math.sqrt(1 + thresholds.depthBand);

    const now = clock.mono();
    this.src = SOURCES.map(() => ({
      adapter: 'connecting' as AdapterState,
      judged: 'connecting' as SourceState,
      liveSince: now,
      lastEventTs: Number.NaN,
      lastSlot: Number.NaN,
      lastBlockId: null,
      holdStart: Number.NEGATIVE_INFINITY,
      staleSince: null,
      outOfOrder: 0,
    }));
    this.sourceUsers = SOURCES.map((s) => model.markets.filter((m) => m.venues.some((v) => v.venue === s)).map((m) => m.index));

    const nP = model.pools.length;
    this.pSqrt = new Float64Array(nP);
    this.pLiq = new Float64Array(nP);
    this.pTick = new Float64Array(nP);
    this.pSlot = new Float64Array(nP);
    this.pRecv = new Float64Array(nP);
    this.pWall = new Float64Array(nP);
    this.pSeen = new Uint8Array(nP);
    this.pSuspect = new Uint8Array(nP);
    this.pMisconf = new Uint8Array(nP);
    this.pScale = Float64Array.from(model.pools, (p) => 10 ** (p.decimalsA - p.decimalsB));

    const nM = model.markets.length;
    this.qPrice = new Float64Array(nM);
    this.qSlot = new Float64Array(nM).fill(Number.NaN);
    this.qRecv = new Float64Array(nM);
    this.qWall = new Float64Array(nM);
    this.qSeen = new Uint8Array(nM);

    this.obsBase = new Int32Array(nM);
    let nObs = 0;
    for (const m of model.markets) {
      this.obsBase[m.index] = nObs;
      nObs += m.venues.length;
    }
    this.oPrice = new Float64Array(nObs);
    this.oSize = new Float64Array(nObs);
    this.oSlot = new Float64Array(nObs);
    this.oRecv = new Float64Array(nObs);
    this.oWall = new Float64Array(nObs);
    this.oReason = new Uint8Array(nObs);
    this.oLeg = new Uint8Array(nObs);
    this.nPrice = new Float64Array(nObs);
    this.nReason = new Uint8Array(nObs);
    this.nLeg = new Uint8Array(nObs);
    this.nSeen = new Uint8Array(nObs);
    this.sigReason = new Int32Array(nObs);

    this.mAvailable = new Uint8Array(nM);
    this.mEmitted = new Uint8Array(nM);
    this.mSeq = new Float64Array(nM);
    this.mSuppressed = new Float64Array(nM);
    this.mLastPrice = new Float64Array(nM);
    this.mLastDegraded = new Uint8Array(nM);
    this.mLastDisagree = new Uint8Array(nM);
    this.mLast = model.markets.map(() => null);
    this.mRestored = model.markets.map(() => null);
  }

  /** Gateway is always invoked before persistence. */
  // @spec REC-EMIT-001
  setListeners(l: { gateway?: ConsolidatedListener; persistence?: ConsolidatedListener; observations?: ObservationListener[] }): void {
    this.gateway = l.gateway;
    this.persistence = l.persistence;
    this.observers = l.observations ?? [];
  }

  // -------------------------------------------------------------------------------------
  // Source sink (ING-SRC-001)

  // @spec REC-POOL-001, REC-POOL-002, REC-NORM-003
  onPoolUpdate(
    pool: number,
    sqrtRatio: number,
    liquidity: number,
    tick: number,
    slot: number,
    recvTs: number,
    recvWall: number,
    decodedTs: number,
    kind: PoolUpdateKind,
  ): void {
    if (this.frozen) return;
    if (this.pSeen[pool] === 1 && slot < this.pSlot[pool]!) {
      const identical = kind === 'revalidation' && sqrtRatio === this.pSqrt[pool] && liquidity === this.pLiq[pool] && tick === this.pTick[pool];
      if (!identical) {
        this.src[SRC_INDEX[this.model.pools[pool]!.venue]]!.outOfOrder++;
        return;
      }
      this.pRecv[pool] = recvTs;
      this.pWall[pool] = recvWall;
    } else {
      // Decimals are known once the pool is resolved, which precedes its first update.
      if (this.pSeen[pool] !== 1) this.pScale[pool] = 10 ** (this.model.pools[pool]!.decimalsA - this.model.pools[pool]!.decimalsB);
      this.pSqrt[pool] = sqrtRatio;
      this.pLiq[pool] = liquidity;
      this.pTick[pool] = tick;
      this.pSlot[pool] = slot;
      this.pRecv[pool] = recvTs;
      this.pWall[pool] = recvWall;
      this.pSeen[pool] = 1;
      this.pSuspect[pool] = 0;
    }
    const users = this.model.poolUsers[pool]!;
    const trigger = this.model.pools[pool]!.sourceId;
    for (let i = 0; i < users.length; i++) this.evaluate(users[i]!, trigger, slot, recvTs, decodedTs, true);
  }

  onQuote(market: number, price: number, blockId: number | null, recvTs: number, recvWall: number): void {
    if (this.frozen) return;
    this.qPrice[market] = price;
    this.qSlot[market] = blockId ?? Number.NaN;
    this.qRecv[market] = recvTs;
    this.qWall[market] = recvWall;
    this.qSeen[market] = 1;
    this.evaluate(market, 'jupiter', blockId, recvTs, null, true);
  }

  onSlot(source: SourceId, slot: number | null, recvTs: number): void {
    if (this.frozen) return;
    const s = this.src[SRC_INDEX[source]]!;
    s.lastEventTs = recvTs;
    if (source === 'jupiter') s.lastBlockId = slot;
    else if (slot !== null && !(slot <= s.lastSlot)) s.lastSlot = slot;
    this.judgeAll(this.clock.mono());
  }

  // @spec REC-LIVE-006
  onSourceState(source: SourceId, state: AdapterState): void {
    if (this.frozen) return;
    const i = SRC_INDEX[source];
    const s = this.src[i]!;
    if (state === 'live' && s.adapter !== 'live') s.liveSince = this.clock.mono();
    s.adapter = state;
    this.judgeAll(this.clock.mono());
    const users = this.sourceUsers[i]!;
    const trigger = `state:${source}`;
    for (let k = 0; k < users.length; k++) this.evaluate(users[k]!, trigger, null, null, null, false);
  }

  // @spec REC-POOL-003
  onPoolSuspect(pool: number): void {
    if (this.frozen) return;
    this.pSuspect[pool] = 1;
    this.reevaluatePool(pool);
  }

  // @spec REC-POOL-004
  onPoolMisconfigured(pool: number, reason = 'failed validation'): void {
    if (this.frozen) return;
    this.pMisconf[pool] = 1;
    this.pMisconfReason.set(pool, reason);
    this.reevaluatePool(pool);
  }

  private reevaluatePool(pool: number): void {
    const users = this.model.poolUsers[pool]!;
    for (let i = 0; i < users.length; i++) this.evaluate(users[i]!, 'sweep', null, null, null, false);
  }

  // -------------------------------------------------------------------------------------
  // Lifecycle

  /** Re-evaluates liveness and expiry for every market. */
  // @spec REC-SWP-001
  sweep(): void {
    if (this.frozen) return;
    this.judgeAll(this.clock.mono());
    for (let m = 0; m < this.model.markets.length; m++) this.evaluate(m, 'sweep', null, null, null, false);
  }

  start(): void {
    if (this.timer || this.frozen) return;
    this.timer = setInterval(() => this.sweep(), this.t.sweepMs);
    this.timer.unref();
  }

  // @spec REC-LIFE-001
  freeze(): void {
    this.frozen = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // @spec REC-ELIG-003
  restore(entries: readonly RestoredMarket[]): void {
    for (const e of entries) {
      const m = this.model.marketIndexByMint.get(e.mint);
      if (m !== undefined) this.mRestored[m] = e;
    }
  }

  // -------------------------------------------------------------------------------------
  // Queries

  consolidated(market: number): Consolidated | null {
    const last = this.mLast[market];
    if (last) return this.mAvailable[market] === 1 ? last : { ...last, stale: true };
    const r = this.mRestored[market]?.consolidated;
    return r ? { ...r, stale: true, restored: true } : null;
  }

  available(market: number): boolean {
    return this.mAvailable[market] === 1;
  }

  observations(market: number): ObservationView[] {
    const now = this.clock.mono();
    const m = this.model.markets[market]!;
    return m.venues.map((v) => this.view(market, v, now));
  }

  sourceStatus(source: SourceId): SourceStatus {
    const now = this.clock.mono();
    this.judgeAll(now);
    const s = this.src[SRC_INDEX[source]]!;
    return {
      state: s.judged,
      lastEventAgeMs: Number.isNaN(s.lastEventTs) ? null : now - s.lastEventTs,
      staleSince: s.staleSince,
    };
  }

  isPoolMisconfigured(pool: number): boolean {
    return this.pMisconf[pool] === 1;
  }

  /** Pools marked misconfigured, with the validation message (for /health). */
  misconfiguredPools(): { pool: string; venue: SourceId; reason: string }[] {
    return [...this.pMisconfReason].map(([i, reason]) => ({ pool: this.model.pools[i]!.address, venue: this.model.pools[i]!.venue, reason }));
  }

  suppressedCount(market: number): number {
    return this.mSuppressed[market]!;
  }

  outOfOrderCount(source: SourceId): number {
    return this.src[SRC_INDEX[source]]!.outOfOrder;
  }

  // -------------------------------------------------------------------------------------
  // Liveness (REC-LIVE-*)

  // @spec REC-LIVE-001, REC-LIVE-002, REC-LIVE-003, REC-LIVE-004, REC-LIVE-005
  private judgeAll(now: number): void {
    // Highest slot reported by any RPC venue (NaN until one reports).
    const a = this.src[0]!.lastSlot;
    const b = this.src[1]!.lastSlot;
    const head = Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b);
    for (let i = 0; i < this.src.length; i++) {
      const s = this.src[i]!;
      const prev = s.judged;
      let next: SourceState;
      if (s.adapter !== 'live') next = s.adapter;
      else if (i === JUPITER) {
        const ref = Number.isNaN(s.lastEventTs) ? s.liveSince : s.lastEventTs;
        const fresh = now - ref <= 3 * this.t.jupiterPollMs;
        const lagging = s.lastBlockId !== null && !Number.isNaN(head) && head - s.lastBlockId > this.t.jupiterMaxSlotLag;
        next = fresh && !lagging ? 'live' : 'stale';
      } else {
        const ref = Number.isNaN(s.lastEventTs) ? s.liveSince : Math.max(s.lastEventTs, s.liveSince);
        next = now - ref <= this.t.slotSilenceMs ? 'live' : 'stale';
      }
      if (next === 'live' && (prev === 'stale' || prev === 'down')) s.holdStart = now;
      if (next === 'stale' && prev !== 'stale') s.staleSince = now;
      else if (next !== 'stale') s.staleSince = null;
      s.judged = next;
    }
  }

  private sourceReason(i: number, now: number): number {
    const s = this.src[i]!;
    switch (s.judged) {
      case 'disabled':
        return R.DISABLED;
      case 'stale':
        return R.STALE;
      case 'live':
        return now - s.holdStart < this.t.recoveryHoldMs ? R.RECOVERING : R.OK;
      default:
        return R.DOWN;
    }
  }

  // -------------------------------------------------------------------------------------
  // Observations (REC-NORM-*, REC-ELIG-*)

  /** Computes one observation into the flat arrays; eligibility checks 1-7. */
  // @spec REC-NORM-001, REC-NORM-002, REC-NORM-004, REC-NORM-005, REC-ELIG-001, REC-ELIG-002
  private computeObs(g: number, v: VenueObservationDef, market: number, now: number): void {
    this.oLeg[g] = 0;
    const si = SRC_INDEX[v.venue];
    if (this.src[si]!.judged === 'disabled') return this.setReason(g, R.DISABLED, 0);
    if (v.kind === 'aggregator') {
      if (this.qSeen[market] !== 1) return this.setReason(g, R.NO_DATA, 0);
      const price = this.qPrice[market]!;
      this.oPrice[g] = price;
      this.oSize[g] = Number.NaN;
      this.oSlot[g] = this.qSlot[market]!;
      this.oRecv[g] = this.qRecv[market]!;
      this.oWall[g] = this.qWall[market]!;
      const sr = this.sourceReason(si, now);
      if (sr !== R.OK) return this.setReason(g, sr, 0);
      if (now - this.oRecv[g]! > this.t.obsMaxAgeMs) return this.setReason(g, R.EXPIRED, 0);
      if (!(Number.isFinite(price) && price > 0)) return this.setReason(g, R.INVALID, 0);
      return this.setReason(g, R.OK, 0);
    }

    const legs = v.legs;
    const route = v.kind === 'route';
    const legNo = (i: number) => (route ? i + 1 : 0);
    for (let i = 0; i < legs.length; i++) if (this.pMisconf[legs[i]!.pool] === 1) return this.setReason(g, R.MISCONFIGURED, legNo(i));
    for (let i = 0; i < legs.length; i++) if (this.pSeen[legs[i]!.pool] !== 1) return this.setReason(g, R.NO_DATA, legNo(i));

    // Price, depth (in quote units), slot and receive time across legs.
    let price = 1;
    let slot = Number.POSITIVE_INFINITY;
    let recv = Number.POSITIVE_INFINITY;
    let wall = Number.POSITIVE_INFINITY;
    for (let i = 0; i < legs.length; i++) {
      const p = legs[i]!.pool;
      price *= this.legPrice(legs[i]!.pool, legs[i]!.invert);
      if (this.pSlot[p]! < slot) slot = this.pSlot[p]!;
      if (this.pRecv[p]! < recv) recv = this.pRecv[p]!;
      if (this.pWall[p]! < wall) wall = this.pWall[p]!;
    }
    let size = Number.POSITIVE_INFINITY;
    let downstream = 1; // product of the prices of legs after leg i
    for (let i = legs.length - 1; i >= 0; i--) {
      const leg = legs[i]!;
      const d = this.legDepth(leg.pool, leg.invert) * downstream;
      if (d < size) size = d;
      downstream *= this.legPrice(leg.pool, leg.invert);
    }
    this.oPrice[g] = price;
    this.oSize[g] = size;
    this.oSlot[g] = slot;
    this.oRecv[g] = recv;
    this.oWall[g] = wall;

    const sr = this.sourceReason(si, now);
    if (sr !== R.OK) return this.setReason(g, sr, 0);
    for (let i = 0; i < legs.length; i++) if (this.pSuspect[legs[i]!.pool] === 1) return this.setReason(g, R.DECODE_ERROR, legNo(i));
    for (let i = 0; i < legs.length; i++) {
      if (now - this.pRecv[legs[i]!.pool]! > this.t.obsMaxAgeMs) return this.setReason(g, R.EXPIRED, legNo(i));
    }
    if (!(Number.isFinite(price) && price > 0 && Number.isFinite(size) && size >= 0)) return this.setReason(g, R.INVALID, 0);
    return this.setReason(g, R.OK, 0);
  }

  private setReason(g: number, reason: number, leg: number): void {
    this.oReason[g] = reason;
    this.oLeg[g] = leg;
  }

  /** Price of the leg's output token per input token. */
  private legPrice(pool: number, invert: boolean): number {
    const s = this.pSqrt[pool]!;
    const pAB = s * s * this.pScale[pool]!;
    return invert ? 1 / pAB : pAB;
  }

  /** Active-liquidity depth for a one-sided move of `depthBand`, in the leg's output token. */
  private legDepth(pool: number, invert: boolean): number {
    const p = this.model.pools[pool]!;
    const s = this.pSqrt[pool]!;
    const L = this.pLiq[pool]!;
    return invert ? (L * (1 / s) * this.depthK) / 10 ** p.decimalsA : (L * s * this.depthK) / 10 ** p.decimalsB;
  }

  // -------------------------------------------------------------------------------------
  // Consolidation (REC-CONS-*)

  // @spec REC-CONS-001, REC-CONS-002, REC-CONS-003, REC-CONS-004, REC-CONS-006, REC-CONS-007, REC-CONS-008
  private evaluate(
    market: number,
    triggerSource: string,
    triggerSlot: number | null,
    recvTs: number | null,
    decodedTs: number | null,
    isData: boolean,
  ): void {
    if (this.frozen) return;
    const now = this.clock.mono();
    const m = this.model.markets[market]!;
    const base = this.obsBase[market]!;
    const n = m.venues.length;

    let candidates = 0;
    for (let v = 0; v < n; v++) {
      this.computeObs(base + v, m.venues[v]!, market, now);
      if (this.oReason[base + v] === R.OK) candidates++;
    }

    // Outlier rejection against the median of all candidates (n >= 3).
    const band = this.t.outlierBps / 1e4;
    if (candidates >= 3) {
      const med = this.median(base, n);
      for (let v = 0; v < n; v++) {
        const g = base + v;
        if (this.oReason[g] === R.OK && Math.abs(this.oPrice[g]! - med) / med > band) this.setReason(g, R.OUTLIER, 0);
      }
    }

    let eligible = 0;
    let enabled = 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let slot = Number.NEGATIVE_INFINITY;
    for (let v = 0; v < n; v++) {
      const g = base + v;
      if (this.src[SRC_INDEX[m.venues[v]!.venue]]!.judged !== 'disabled') enabled++;
      if (this.oReason[g] !== R.OK) continue;
      eligible++;
      const p = this.oPrice[g]!;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
      if (m.venues[v]!.kind !== 'aggregator' && this.oSlot[g]! > slot) slot = this.oSlot[g]!;
    }

    this.notifyObservations(market, now);

    if (eligible === 0) {
      if (this.mAvailable[market] === 1) {
        this.mAvailable[market] = 0;
        this.mEmitted[market] = 0;
        const lastKnown = this.mLast[market] ? { ...this.mLast[market], stale: true as const } : null;
        this.gateway?.onUnavailable(market, lastKnown);
        this.persistence?.onUnavailable(market, lastKnown);
      }
      return;
    }

    const price = this.median(base, n);
    const disagreement = (eligible === 2 && (hi - lo) / ((hi + lo) / 2) > band) || (candidates >= 3 && eligible === 1);
    const degraded = eligible < enabled;

    // Change detection without allocation.
    let changed = this.mEmitted[market] !== 1 || price !== this.mLastPrice[market] || degraded !== (this.mLastDegraded[market] === 1) || disagreement !== (this.mLastDisagree[market] === 1);
    for (let v = 0; v < n && !changed; v++) {
      const g = base + v;
      if (this.sigReason[g] !== this.oReason[g]! * 16 + this.oLeg[g]!) changed = true;
    }
    if (!changed) {
      if (isData) this.mSuppressed[market]!++;
      return;
    }

    for (let v = 0; v < n; v++) this.sigReason[base + v] = this.oReason[base + v]! * 16 + this.oLeg[base + v]!;
    this.mEmitted[market] = 1;
    this.mAvailable[market] = 1;
    this.mLastPrice[market] = price;
    this.mLastDegraded[market] = degraded ? 1 : 0;
    this.mLastDisagree[market] = disagreement ? 1 : 0;
    this.mSeq[market]!++;

    const c = this.buildConsolidated(market, price, lo, hi, slot, degraded, disagreement, triggerSource, triggerSlot);
    this.mLast[market] = c;
    const stamps = { recvTs, decodedTs, reconciledTs: this.clock.mono() };
    this.gateway?.onConsolidated(market, c, stamps);
    this.persistence?.onConsolidated(market, c, stamps);
  }

  /** Median of eligible observations in [base, base+n), via in-place insertion sort. */
  // @spec REC-CONS-009
  private median(base: number, n: number): number {
    const a = this.scratch;
    let k = 0;
    for (let v = 0; v < n; v++) {
      if (this.oReason[base + v] !== R.OK) continue;
      const x = this.oPrice[base + v]!;
      let j = k++;
      while (j > 0 && a[j - 1]! > x) {
        a[j] = a[j - 1]!;
        j--;
      }
      a[j] = x;
    }
    return k % 2 === 1 ? a[(k - 1) / 2]! : (a[k / 2 - 1]! + a[k / 2]!) / 2;
  }

  // @spec REC-CONS-005
  private buildConsolidated(
    market: number,
    price: number,
    lo: number,
    hi: number,
    slot: number,
    degraded: boolean,
    disagreement: boolean,
    triggerSource: string,
    triggerSlot: number | null,
  ): Consolidated {
    const m = this.model.markets[market]!;
    const base = this.obsBase[market]!;
    const sources: string[] = [];
    const excluded: Exclusion[] = [];
    for (const v of m.venues) {
      const g = base + v.index;
      if (this.oReason[g] === R.OK) sources.push(v.sourceId);
      else excluded.push(this.exclusion(v.sourceId, g));
    }
    return {
      mint: m.mint,
      symbol: m.symbol,
      quote: this.model.quote.symbol,
      price,
      sources,
      excluded,
      spreadBps: ((hi - lo) / price) * 1e4,
      degraded,
      disagreement,
      slot: Number.isFinite(slot) ? slot : null,
      updatedAt: new Date(this.clock.wall()).toISOString(),
      seq: this.mSeq[market]!,
      trigger: { source: triggerSource, slot: triggerSlot },
    };
  }

  private exclusion(source: string, g: number): Exclusion {
    const e: Exclusion = { source, reason: REASONS[this.oReason[g]!]! };
    if (this.oLeg[g]! > 0) e.leg = this.oLeg[g]!;
    return e;
  }

  // @spec REC-EMIT-002
  private notifyObservations(market: number, now: number): void {
    if (this.observers.length === 0) return;
    const m = this.model.markets[market]!;
    const base = this.obsBase[market]!;
    for (const v of m.venues) {
      const g = base + v.index;
      const price = this.priceOf(g);
      if (this.nSeen[g] === 1 && Object.is(price, this.nPrice[g]) && this.nReason[g] === this.oReason[g] && this.nLeg[g] === this.oLeg[g]) continue;
      this.nSeen[g] = 1;
      this.nPrice[g] = price;
      this.nReason[g] = this.oReason[g]!;
      this.nLeg[g] = this.oLeg[g]!;
      const view = this.view(market, v, now, false);
      for (const o of this.observers) o.onObservation(market, v.index, view);
    }
  }

  /** Observation price, or NaN when it cannot be computed (no data on some leg). */
  private priceOf(g: number): number {
    const r = this.oReason[g]!;
    return r === R.DISABLED || r === R.NO_DATA || r === R.MISCONFIGURED ? Number.NaN : this.oPrice[g]!;
  }

  // @spec REC-ELIG-003
  private view(market: number, v: VenueObservationDef, now: number, recompute = true): ObservationView {
    const g = this.obsBase[market]! + v.index;
    if (recompute) {
      this.judgeAll(now);
      this.evaluateQuietly(market, now);
    }
    const src = this.src[SRC_INDEX[v.venue]]!;
    const price = this.priceOf(g);
    const hasData = !Number.isNaN(price);
    const view: ObservationView = {
      source: v.sourceId,
      venue: v.venue,
      kind: v.kind,
      sourceState: src.judged,
      price: hasData ? price : null,
      size: hasData && !Number.isNaN(this.oSize[g]!) ? this.oSize[g]! : null,
      slot: hasData && !Number.isNaN(this.oSlot[g]!) ? this.oSlot[g]! : null,
      receivedAt: hasData ? this.oWall[g]! : null,
      ageMs: hasData ? now - this.oRecv[g]! : null,
      eligible: this.oReason[g] === R.OK,
      reason: REASONS[this.oReason[g]!]!,
    };
    if (this.oLeg[g]! > 0) view.leg = this.oLeg[g]!;
    if (v.kind === 'route') view.legs = v.legs.map((l): LegView => this.legView(l.pool, l.invert, now));
    if (!hasData) {
      const r = this.mRestored[market]?.sources.find((s) => s.source === v.sourceId);
      if (r) return { ...r, sourceState: src.judged, eligible: false, reason: view.reason, restored: true };
    }
    return view;
  }

  private legView(pool: number, invert: boolean, now: number): LegView {
    const seen = this.pSeen[pool] === 1;
    return {
      pool: this.model.pools[pool]!.address,
      price: seen ? this.legPrice(pool, invert) : null,
      slot: seen ? this.pSlot[pool]! : null,
      ageMs: seen ? now - this.pRecv[pool]! : null,
    };
  }

  /** Refreshes observation state for a read without emitting (reads must not have side effects). */
  private evaluateQuietly(market: number, now: number): void {
    const m = this.model.markets[market]!;
    const base = this.obsBase[market]!;
    let candidates = 0;
    for (const v of m.venues) {
      this.computeObs(base + v.index, v, market, now);
      if (this.oReason[base + v.index] === R.OK) candidates++;
    }
    if (candidates >= 3) {
      const med = this.median(base, m.venues.length);
      const band = this.t.outlierBps / 1e4;
      for (const v of m.venues) {
        const g = base + v.index;
        if (this.oReason[g] === R.OK && Math.abs(this.oPrice[g]! - med) / med > band) this.setReason(g, R.OUTLIER, 0);
      }
    }
  }
}
