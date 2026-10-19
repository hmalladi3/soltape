import type { SourceId } from '@soltape/shared';
import { describe, expect, it, vi } from 'vitest';
import { Reconciler } from '../../src/reconcile/reconciler.js';
import { DEFAULT_THRESHOLDS, type Consolidated, type ConsolidatedListener, type EmitStamps, type ObservationView, type PoolUpdateKind } from '../../src/reconcile/types.js';
import { FakeClock } from '../support/clock.js';
import { sqrtForPoolPrice, testModel } from '../support/model.js';

type Ev =
  { kind: 'consolidated'; by: string; market: number; c: Consolidated; stamps: EmitStamps } | { kind: 'unavailable'; by: string; market: number; lastKnown: Consolidated | null };

const SOL = 0;
const JUP = 1;
const JTO = 2;

function setup() {
  const clock = new FakeClock();
  const model = testModel();
  const rec = new Reconciler({ model, clock, thresholds: DEFAULT_THRESHOLDS });
  const events: Ev[] = [];
  const obs: { market: number; venue: number; o: ObservationView }[] = [];
  const listener = (by: string): ConsolidatedListener => ({
    onConsolidated: (market, c, stamps) => events.push({ kind: 'consolidated', by, market, c: structuredClone(c), stamps: { ...stamps } }),
    onUnavailable: (market, lastKnown) => events.push({ kind: 'unavailable', by, market, lastKnown: structuredClone(lastKnown) }),
  });
  rec.setListeners({
    gateway: listener('gateway'),
    persistence: listener('persistence'),
    observations: [{ onObservation: (market, venue, o) => obs.push({ market, venue, o: structuredClone(o) }) }],
  });
  let slot = 1000;
  const h = {
    clock,
    model,
    rec,
    events,
    obs,
    get slot() {
      return slot;
    },
    gw: () => events.filter((e) => e.by === 'gateway'),
    lastC: (market: number) => {
      const e = events.filter((x): x is Extract<Ev, { kind: 'consolidated' }> => x.kind === 'consolidated' && x.by === 'gateway' && x.market === market).at(-1);
      return e?.c;
    },
    state(source: SourceId, state: 'disabled' | 'connecting' | 'live' | 'down') {
      rec.onSourceState(source, state);
    },
    /** Marks sources live and gives each a fresh liveness signal. */
    live(...sources: SourceId[]) {
      for (const s of sources) {
        rec.onSourceState(s, 'live');
        rec.onSlot(s, slot, clock.mono());
      }
    },
    heartbeat(...sources: SourceId[]) {
      slot += 1;
      for (const s of sources.length ? sources : (['orca', 'raydium', 'jupiter'] as SourceId[])) rec.onSlot(s, slot, clock.mono());
    },
    pool(index: number, priceBperA: number, o: { liq?: number; tick?: number; slot?: number; kind?: PoolUpdateKind; sqrt?: number } = {}) {
      const p = model.pools[index]!;
      rec.onPoolUpdate(
        index,
        o.sqrt ?? sqrtForPoolPrice(p, priceBperA),
        o.liq ?? 1e12,
        o.tick ?? 0,
        o.slot ?? ++slot,
        clock.mono(),
        clock.wall(),
        clock.mono(),
        o.kind ?? 'notification',
      );
    },
    quote(market: number, price: number, blockId: number | null = slot) {
      rec.onQuote(market, price, blockId, clock.mono(), clock.wall());
    },
    tick(ms: number) {
      clock.advance(ms);
    },
    /** All three sources live with SOL at 100 / 100.2 / 100.1. */
    solThree() {
      h.live('orca', 'raydium', 'jupiter');
      h.pool(0, 100);
      h.pool(1, 100.2);
      h.quote(SOL, 100.1);
    },
    /** Reason of the named observation; fails the test if the observation does not exist. */
    excludedReason(market: number, source: string) {
      const o = rec.observations(market).find((x) => x.source === source);
      if (!o) throw new Error(`no observation ${source} in market ${market}`);
      return o.reason;
    },
  };
  return h;
}

const ORCA_SOL = 'orca:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const RAY_SOL = 'raydium:3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv';

describe('source liveness', () => {
  // @spec REC-LIVE-001
  it('treats an RPC venue as live while its last slot notification is at most 2,000 ms old', () => {
    const h = setup();
    h.live('orca');
    h.pool(0, 100);
    h.tick(2000);
    h.rec.sweep();
    expect(h.rec.sourceStatus('orca').state).toBe('live');
    expect(h.excludedReason(SOL, ORCA_SOL)).toBeNull();
    h.tick(1);
    h.rec.sweep();
    expect(h.rec.sourceStatus('orca').state).toBe('stale');
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('source_stale');
  });

  // @spec REC-LIVE-001
  it('measures RPC liveness from the transition to live before the first slot notification', () => {
    const h = setup();
    h.state('orca', 'live');
    h.pool(0, 100);
    h.tick(2000);
    h.rec.sweep();
    expect(h.rec.sourceStatus('orca').state).toBe('live');
    h.tick(1);
    h.rec.sweep();
    expect(h.rec.sourceStatus('orca').state).toBe('stale');
  });

  // @spec REC-LIVE-002
  it('treats Jupiter as stale once its last successful poll is older than 3x the configured interval', () => {
    const h = setup();
    h.live('jupiter');
    h.quote(SOL, 100);
    h.tick(6000);
    h.rec.sweep();
    expect(h.rec.sourceStatus('jupiter').state).toBe('live');
    h.tick(1);
    h.rec.sweep();
    expect(h.rec.sourceStatus('jupiter').state).toBe('stale');
  });

  // @spec REC-LIVE-002
  it('treats Jupiter as stale when its blockId lags the RPC slot head by more than 150 slots', () => {
    const h = setup();
    h.live('orca', 'jupiter');
    h.rec.onSlot('orca', 10_000, h.clock.mono());
    h.rec.onSlot('jupiter', 9_850, h.clock.mono());
    h.rec.sweep();
    expect(h.rec.sourceStatus('jupiter').state).toBe('live');
    h.rec.onSlot('jupiter', 9_849, h.clock.mono());
    h.rec.sweep();
    expect(h.rec.sourceStatus('jupiter').state).toBe('stale');
  });

  // @spec REC-LIVE-002
  it('skips the Jupiter lag check when no RPC venue has reported a slot', () => {
    const h = setup();
    h.state('jupiter', 'live');
    h.rec.onSlot('jupiter', 5, h.clock.mono());
    h.rec.sweep();
    expect(h.rec.sourceStatus('jupiter').state).toBe('live');
  });

  // @spec REC-LIVE-002
  it('ignores the lag check for polls without a blockId', () => {
    const h = setup();
    h.live('orca', 'jupiter');
    h.rec.onSlot('orca', 10_000, h.clock.mono());
    h.rec.onSlot('jupiter', null, h.clock.mono());
    h.rec.sweep();
    expect(h.rec.sourceStatus('jupiter').state).toBe('live');
  });

  // @spec REC-LIVE-003
  it('publishes the stale transition with the time it became stale', () => {
    const h = setup();
    h.live('raydium');
    h.tick(2001);
    h.rec.sweep();
    const st = h.rec.sourceStatus('raydium');
    expect(st.state).toBe('stale');
    expect(st.staleSince).toBe(h.clock.mono());
    expect(st.lastEventAgeMs).toBe(2001);
  });

  // @spec REC-LIVE-004
  it('holds a recovered source ineligible as source_recovering for 1,000 ms', () => {
    const h = setup();
    h.solThree();
    h.state('orca', 'down');
    h.live('orca');
    h.pool(0, 100);
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('source_recovering');
    h.tick(999);
    h.heartbeat();
    h.rec.sweep();
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('source_recovering');
    h.tick(1);
    h.heartbeat();
    h.rec.sweep();
    expect(h.excludedReason(SOL, ORCA_SOL)).toBeNull();
  });

  // @spec REC-LIVE-004
  it('restarts the hold if the source drops again during it', () => {
    const h = setup();
    h.solThree();
    h.state('orca', 'down');
    h.live('orca');
    h.tick(600);
    h.state('orca', 'down');
    h.live('orca');
    h.tick(600);
    h.heartbeat();
    h.rec.sweep();
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('source_recovering');
  });

  // @spec REC-LIVE-004
  it('applies no hold on the first transition to live after boot', () => {
    const h = setup();
    h.state('orca', 'connecting');
    h.live('orca');
    h.pool(0, 100);
    expect(h.excludedReason(SOL, ORCA_SOL)).toBeNull();
  });

  // @spec REC-LIVE-005
  it('excludes a source immediately when it goes down', () => {
    const h = setup();
    h.solThree();
    h.state('orca', 'down');
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('source_down');
  });

  // @spec REC-LIVE-006
  it('re-evaluates affected markets immediately on a source state change', () => {
    const h = setup();
    h.solThree();
    const before = h.gw().length;
    h.state('raydium', 'down');
    const after = h.gw().slice(before);
    expect(after.length).toBeGreaterThan(0);
    const c = h.lastC(SOL)!;
    expect(c.trigger).toEqual({ source: 'state:raydium', slot: null });
    expect(c.excluded).toContainEqual({ source: RAY_SOL, reason: 'source_down' });
  });
});

describe('pool state', () => {
  // @spec REC-POOL-001
  it('discards updates with a lower slot and counts them; accepts equal slots', () => {
    const h = setup();
    h.live('orca');
    h.pool(0, 100, { slot: 500 });
    h.pool(0, 120, { slot: 499 });
    expect(h.rec.observations(SOL)[0]!.price).toBeCloseTo(100, 9);
    h.pool(0, 101, { slot: 500 });
    expect(h.rec.observations(SOL)[0]!.price).toBeCloseTo(101, 9);
  });

  // @spec REC-POOL-002
  it('refreshes receive time without moving the slot for an identical revalidation from a lagging node', () => {
    const h = setup();
    h.live('orca');
    const sqrt = sqrtForPoolPrice(h.model.pools[0]!, 100);
    h.rec.onPoolUpdate(0, sqrt, 5e11, -22649, 500, h.clock.mono(), h.clock.wall(), h.clock.mono(), 'notification');
    h.tick(30_000);
    h.heartbeat('orca');
    h.rec.onPoolUpdate(0, sqrt, 5e11, -22649, 498, h.clock.mono(), h.clock.wall(), h.clock.mono(), 'revalidation');
    const o = h.rec.observations(SOL)[0]!;
    expect(o.slot).toBe(500);
    expect(o.ageMs).toBe(0);
  });

  // @spec REC-POOL-002
  it('discards a lower-slot revalidation whose fields differ', () => {
    const h = setup();
    h.live('orca');
    const p = h.model.pools[0]!;
    h.rec.onPoolUpdate(0, sqrtForPoolPrice(p, 100), 5e11, -22649, 500, h.clock.mono(), h.clock.wall(), h.clock.mono(), 'notification');
    h.tick(30_000);
    h.rec.onPoolUpdate(0, sqrtForPoolPrice(p, 101), 5e11, -22648, 498, h.clock.mono(), h.clock.wall(), h.clock.mono(), 'revalidation');
    const o = h.rec.observations(SOL)[0]!;
    expect(o.price).toBeCloseTo(100, 9);
    expect(o.ageMs).toBe(30_000);
  });

  // @spec REC-POOL-002
  it('does not apply the refresh rule to lower-slot notifications', () => {
    const h = setup();
    h.live('orca');
    const sqrt = sqrtForPoolPrice(h.model.pools[0]!, 100);
    h.rec.onPoolUpdate(0, sqrt, 5e11, 1, 500, h.clock.mono(), h.clock.wall(), h.clock.mono(), 'notification');
    h.tick(10_000);
    h.rec.onPoolUpdate(0, sqrt, 5e11, 1, 499, h.clock.mono(), h.clock.wall(), h.clock.mono(), 'notification');
    expect(h.rec.observations(SOL)[0]!.ageMs).toBe(10_000);
  });

  // @spec REC-POOL-003
  it('marks a pool suspect until its next accepted update', () => {
    const h = setup();
    h.solThree();
    h.rec.onPoolSuspect(0);
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('decode_error');
    h.pool(0, 100.05);
    expect(h.excludedReason(SOL, ORCA_SOL)).toBeNull();
  });

  // @spec REC-POOL-004
  it('keeps a misconfigured pool ineligible for the process lifetime', () => {
    const h = setup();
    h.solThree();
    h.rec.onPoolMisconfigured(0);
    h.pool(0, 100);
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('misconfigured');
    expect(h.rec.isPoolMisconfigured(0)).toBe(true);
  });
});

describe('normalization', () => {
  // @spec REC-NORM-001
  it('prices a direct pool as sqrtRatio^2 x 10^(decBase - decQuote)', () => {
    const h = setup();
    h.live('orca');
    // Real SOL/USDC Whirlpool reading: raw ratio^2 0.10386110892093045 with SOL(9)/USDC(6).
    h.pool(0, 0, { sqrt: Math.sqrt(0.10386110892093045) });
    expect(h.rec.observations(SOL)[0]!.price).toBeCloseTo(103.86110892093045, 9);
  });

  // @spec REC-NORM-001, REC-NORM-004
  it('inverts a leg whose quote side is token A', () => {
    const h = setup();
    h.live('orca');
    h.pool(4, 232.85); // pool 4 is SOL/JTO: 232.85 JTO per SOL, so JTO = 1/232.85 SOL
    h.pool(0, 100);
    expect(h.rec.observations(JTO)[0]!.price).toBeCloseTo(100 / 232.85, 9);
  });

  // @spec REC-NORM-002
  it('estimates depth as the smaller one-sided quote amount for a 1% move at active liquidity', () => {
    const h = setup();
    h.live('orca');
    const p = h.model.pools[0]!;
    const L = 231136491993;
    const sqrt = sqrtForPoolPrice(p, 100);
    h.pool(0, 100, { liq: L });
    const expected = (L * sqrt * (1 - 1 / Math.sqrt(1.01))) / 10 ** p.decimalsB;
    expect(h.rec.observations(SOL)[0]!.size).toBeCloseTo(expected, 6);
  });

  // @spec REC-NORM-002
  it('estimates depth in token A units when the quote side is A', () => {
    const h = setup();
    h.live('orca');
    const p = h.model.pools[4]!; // SOL/JTO, used inverted: leg output token is SOL (A)
    const L = 26935487355324;
    const sqrt = sqrtForPoolPrice(p, 232.85);
    h.pool(4, 232.85, { liq: L });
    h.pool(0, 100, { liq: 1e30 }); // effectively infinite second leg
    const legDepthSol = (L * (1 / sqrt) * (1 - 1 / Math.sqrt(1.01))) / 10 ** p.decimalsA;
    expect(h.rec.observations(JTO)[0]!.size).toBeCloseTo(legDepthSol * 100, 3);
  });

  // @spec REC-NORM-003
  it('recomputes every route using a pool when that pool updates', () => {
    const h = setup();
    h.live('orca');
    h.pool(2, 0.0028); // JUP/SOL
    h.pool(0, 100);
    expect(h.rec.observations(JUP)[0]!.price).toBeCloseTo(0.28, 9);
    h.pool(0, 110);
    expect(h.rec.observations(JUP)[0]!.price).toBeCloseTo(0.308, 9);
    expect(h.rec.observations(SOL)[0]!.price).toBeCloseTo(110, 9);
  });

  // @spec REC-NORM-004
  it('derives route slot, receive time, depth and source id from its legs', () => {
    const h = setup();
    h.live('orca');
    h.pool(2, 0.0028, { slot: 700, liq: 1e13 });
    h.tick(500);
    h.pool(0, 100, { slot: 705, liq: 1e12 });
    const o = h.rec.observations(JUP)[0]!;
    expect(o.source).toBe('orca:route(C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz,Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE)');
    expect(o.kind).toBe('route');
    expect(o.slot).toBe(700);
    expect(o.ageMs).toBe(500);
    const p2 = h.model.pools[2]!;
    const p0 = h.model.pools[0]!;
    const leg1 = ((1e13 * sqrtForPoolPrice(p2, 0.0028) * (1 - 1 / Math.sqrt(1.01))) / 10 ** p2.decimalsB) * 100;
    const leg2 = (1e12 * sqrtForPoolPrice(p0, 100) * (1 - 1 / Math.sqrt(1.01))) / 10 ** p0.decimalsB;
    expect(o.size).toBeCloseTo(Math.min(leg1, leg2), 3);
    expect(o.legs?.map((l) => l.slot)).toEqual([700, 705]);
  });

  // @spec REC-NORM-005
  it('records Jupiter quotes with null depth', () => {
    const h = setup();
    h.live('jupiter');
    h.quote(SOL, 100.1, 1234);
    const o = h.rec.observations(SOL).find((x) => x.source === 'jupiter')!;
    expect(o).toMatchObject({ price: 100.1, size: null, slot: 1234, kind: 'aggregator', eligible: true });
  });
});

describe('eligibility', () => {
  // @spec REC-ELIG-001
  it('reports source_disabled for a disabled source before any other check', () => {
    const h = setup();
    h.state('jupiter', 'disabled');
    expect(h.excludedReason(SOL, 'jupiter')).toBe('source_disabled');
  });

  // @spec REC-ELIG-001
  it('reports no_data before anything is received', () => {
    const h = setup();
    h.live('orca');
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('no_data');
  });

  // @spec REC-ELIG-001
  it('reports expired once an observation is older than 60 s while the source stays live', () => {
    const h = setup();
    h.live('orca');
    h.pool(0, 100);
    for (let t = 0; t < 60_000; t += 1000) {
      h.tick(1000);
      h.heartbeat('orca');
    }
    h.rec.sweep();
    expect(h.excludedReason(SOL, ORCA_SOL)).toBeNull();
    h.tick(1);
    h.heartbeat('orca');
    h.rec.sweep();
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('expired');
  });

  // @spec REC-ELIG-001
  it.each([
    ['zero price', 0],
    ['infinite price', Number.POSITIVE_INFINITY],
    ['NaN price', Number.NaN],
  ])('reports invalid_value for a %s', (_label, price) => {
    const h = setup();
    h.live('jupiter');
    h.quote(SOL, price);
    expect(h.excludedReason(SOL, 'jupiter')).toBe('invalid_value');
  });

  // @spec REC-ELIG-001
  it('reports invalid_value for a pool whose sqrt ratio normalizes to zero', () => {
    const h = setup();
    h.live('orca');
    h.pool(0, 0, { sqrt: 0 });
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('invalid_value');
  });

  // @spec REC-ELIG-001
  it('applies checks in order: misconfigured wins over source_down', () => {
    const h = setup();
    h.solThree();
    h.rec.onPoolMisconfigured(0);
    h.state('orca', 'down');
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('misconfigured');
  });

  // @spec REC-ELIG-002
  it('reports a failing route leg with an unchanged reason code and a 1-based leg field', () => {
    const h = setup();
    h.live('orca');
    h.pool(2, 0.0028);
    h.pool(0, 100);
    h.rec.onPoolSuspect(0);
    const o = h.rec.observations(JUP)[0]!;
    expect(o.reason).toBe('decode_error');
    expect(o.leg).toBe(2);
  });

  // @spec REC-ELIG-002
  it('reports no_data with the leg when one leg never arrived', () => {
    const h = setup();
    h.live('orca');
    h.pool(0, 100);
    const o = h.rec.observations(JUP)[0]!;
    expect(o.reason).toBe('no_data');
    expect(o.leg).toBe(1);
  });

  // @spec REC-ELIG-003
  it('never treats restored values as eligible', () => {
    const h = setup();
    h.live('orca', 'raydium', 'jupiter');
    const restored: Consolidated = {
      mint: h.model.markets[SOL]!.mint,
      symbol: 'SOL',
      quote: 'USDC',
      price: 99,
      sources: [ORCA_SOL],
      excluded: [],
      spreadBps: 0,
      degraded: false,
      disagreement: false,
      slot: 1,
      updatedAt: '2026-10-19T13:00:00.000Z',
      seq: 9,
      trigger: { source: ORCA_SOL, slot: 1 },
    };
    h.rec.restore([{ mint: restored.mint, consolidated: restored, sources: [] }]);
    expect(h.rec.available(SOL)).toBe(false);
    expect(h.rec.consolidated(SOL)).toMatchObject({ price: 99, stale: true, restored: true });
    expect(h.excludedReason(SOL, ORCA_SOL)).toBe('no_data');
  });
});

describe('consolidation', () => {
  // @spec REC-CONS-001, REC-CONS-002
  it('rejects an outlier beyond 100 bps of the median of three and prices the rest by median', () => {
    const h = setup();
    h.live('orca', 'raydium', 'jupiter');
    h.pool(0, 100);
    h.pool(1, 100.5);
    h.quote(SOL, 103);
    const c = h.lastC(SOL)!;
    expect(c.excluded).toContainEqual({ source: 'jupiter', reason: 'outlier' });
    expect(c.price).toBeCloseTo(100.25, 9);
    expect(c.sources.sort()).toEqual([ORCA_SOL, RAY_SOL].sort());
  });

  // @spec REC-CONS-002
  it('uses the middle value for an odd count', () => {
    const h = setup();
    h.solThree();
    expect(h.lastC(SOL)!.price).toBeCloseTo(100.1, 9);
  });

  // @spec REC-CONS-003
  it('keeps two diverging observations, prices the midpoint and flags disagreement', () => {
    const h = setup();
    h.live('orca', 'raydium');
    h.state('jupiter', 'disabled');
    h.pool(0, 100);
    h.pool(1, 102);
    const c = h.lastC(SOL)!;
    expect(c.price).toBeCloseTo(101, 9);
    expect(c.disagreement).toBe(true);
    expect(c.sources).toHaveLength(2);
  });

  // @spec REC-CONS-003
  it('does not flag two observations within 100 bps', () => {
    const h = setup();
    h.live('orca', 'raydium');
    h.state('jupiter', 'disabled');
    h.pool(0, 100);
    h.pool(1, 100.9);
    expect(h.lastC(SOL)!.disagreement).toBe(false);
  });

  // @spec REC-CONS-004
  it('flags disagreement when outlier rejection leaves one observation', () => {
    const h = setup();
    h.live('orca', 'raydium', 'jupiter');
    h.pool(0, 95);
    h.pool(1, 105);
    h.quote(SOL, 100);
    const c = h.lastC(SOL)!;
    expect(c.sources).toEqual(['jupiter']);
    expect(c.price).toBeCloseTo(100, 9);
    expect(c.disagreement).toBe(true);
  });

  // @spec REC-CONS-005
  it('reports sources, exclusions, spread, slot, degraded, trigger and stamps', () => {
    const h = setup();
    h.live('orca', 'raydium', 'jupiter');
    h.pool(0, 100, { slot: 2000 });
    h.quote(SOL, 100.1, 1990);
    h.pool(1, 100.2, { slot: 2001 });
    const e = h
      .gw()
      .filter((x): x is Extract<Ev, { kind: 'consolidated' }> => x.kind === 'consolidated')
      .at(-1)!;
    const c = e.c;
    expect(c.mint).toBe(h.model.markets[SOL]!.mint);
    expect(c.symbol).toBe('SOL');
    expect(c.quote).toBe('USDC');
    expect(c.spreadBps).toBeCloseTo(((100.2 - 100) / 100.1) * 1e4, 6);
    expect(c.slot).toBe(2001);
    expect(c.degraded).toBe(false);
    expect(c.excluded).toEqual([]);
    expect(c.trigger).toEqual({ source: RAY_SOL, slot: 2001 });
    expect(c.updatedAt).toBe(new Date(h.clock.wall()).toISOString());
    expect(e.stamps.recvTs).toBe(h.clock.mono());
    expect(e.stamps.decodedTs).toBe(h.clock.mono());
  });

  // @spec REC-CONS-005
  it('names the leg pool as trigger for a route-driven update', () => {
    const h = setup();
    h.live('orca');
    h.pool(2, 0.0028, { slot: 3000 });
    h.pool(0, 100, { slot: 3001 });
    expect(h.lastC(JUP)!.trigger).toEqual({ source: ORCA_SOL, slot: 3001 });
  });

  // @spec REC-CONS-005
  it('uses jupiter with its blockId as trigger for quotes', () => {
    const h = setup();
    h.live('jupiter');
    h.quote(SOL, 100, 4242);
    expect(h.lastC(SOL)!.trigger).toEqual({ source: 'jupiter', slot: 4242 });
  });

  // @spec REC-CONS-005
  it('does not count disabled sources toward degraded, but lists them as excluded', () => {
    const h = setup();
    h.live('orca', 'raydium');
    h.state('jupiter', 'disabled');
    h.pool(0, 100);
    h.pool(1, 100.1);
    const c = h.lastC(SOL)!;
    expect(c.degraded).toBe(false);
    expect(c.excluded).toEqual([{ source: 'jupiter', reason: 'source_disabled' }]);
  });

  // @spec REC-CONS-005
  it('is degraded when an enabled source is not contributing', () => {
    const h = setup();
    h.solThree();
    h.state('raydium', 'down');
    expect(h.lastC(SOL)!.degraded).toBe(true);
  });

  // @spec REC-CONS-006
  it('marks a market unavailable, retains the last value as stale and emits unavailable once', () => {
    const h = setup();
    h.live('orca');
    h.state('raydium', 'disabled');
    h.state('jupiter', 'disabled');
    h.pool(0, 100);
    expect(h.rec.available(SOL)).toBe(true);
    h.state('orca', 'down');
    expect(h.rec.available(SOL)).toBe(false);
    expect(h.rec.consolidated(SOL)).toMatchObject({ price: expect.closeTo(100, 9), stale: true });
    const un = h.gw().filter((e) => e.kind === 'unavailable' && e.market === SOL);
    expect(un).toHaveLength(1);
    h.rec.sweep();
    expect(h.gw().filter((e) => e.kind === 'unavailable' && e.market === SOL)).toHaveLength(1);
  });

  // @spec REC-CONS-006
  it('emits nothing for a market that was never available', () => {
    const h = setup();
    h.live('orca');
    h.state('orca', 'down');
    h.rec.sweep();
    expect(h.gw().filter((e) => e.market === SOL)).toEqual([]);
    expect(h.rec.consolidated(SOL)).toBeNull();
  });

  // @spec REC-CONS-007
  it('suppresses an evaluation that changes nothing but the slot', () => {
    const h = setup();
    h.solThree();
    const n = h.gw().length;
    h.pool(0, 100);
    expect(h.gw().length).toBe(n);
    expect(h.rec.suppressedCount(SOL)).toBe(1);
  });

  // @spec REC-CONS-008
  it('increments seq on every emission', () => {
    const h = setup();
    h.solThree();
    const s1 = h.lastC(SOL)!.seq;
    h.quote(SOL, 100.15); // moves the median from 100.1 to 100.15
    expect(h.lastC(SOL)!.seq).toBe(s1 + 1);
  });

  // @spec REC-CONS-009
  it('computes medians without Array.prototype.sort', () => {
    const h = setup();
    const spy = vi.spyOn(Array.prototype, 'sort');
    try {
      h.solThree();
      h.pool(1, 100.3);
      h.rec.sweep();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('sweep, emission order and lifecycle', () => {
  // @spec REC-SWP-001
  it('drops a silent source on sweep with trigger sweep', () => {
    const h = setup();
    h.solThree();
    h.tick(2001);
    h.heartbeat('orca', 'jupiter');
    h.rec.sweep();
    const c = h.lastC(SOL)!;
    expect(c.trigger).toEqual({ source: 'sweep', slot: null });
    expect(c.excluded).toContainEqual({ source: RAY_SOL, reason: 'source_stale' });
  });

  // @spec REC-SWP-001
  it('emits nothing on sweep when eligibility did not change', () => {
    const h = setup();
    h.solThree();
    const n = h.gw().length;
    h.tick(100);
    h.rec.sweep();
    expect(h.gw().length).toBe(n);
  });

  // @spec REC-EMIT-001
  it('invokes the gateway before persistence for consolidated and unavailable events', () => {
    const h = setup();
    h.live('orca');
    h.state('raydium', 'disabled');
    h.state('jupiter', 'disabled');
    h.pool(0, 100);
    h.state('orca', 'down');
    const seq = h.events.map((e) => `${e.kind}:${e.by}`);
    expect(seq).toEqual(['consolidated:gateway', 'consolidated:persistence', 'unavailable:gateway', 'unavailable:persistence']);
  });

  // @spec REC-EMIT-002
  it('notifies observation listeners on price, eligibility or reason changes only', () => {
    const h = setup();
    h.live('orca');
    h.pool(0, 100);
    const n = h.obs.filter((x) => x.market === SOL && x.venue === 0).length;
    expect(n).toBeGreaterThan(0);
    h.pool(0, 100);
    expect(h.obs.filter((x) => x.market === SOL && x.venue === 0).length).toBe(n);
    h.pool(0, 100.5);
    expect(h.obs.filter((x) => x.market === SOL && x.venue === 0).length).toBe(n + 1);
    h.state('orca', 'down');
    expect(h.obs.filter((x) => x.market === SOL && x.venue === 0).at(-1)!.o.reason).toBe('source_down');
  });

  // @spec REC-LIFE-001
  it('emits nothing after freeze, whatever arrives', () => {
    const h = setup();
    h.solThree();
    const n = h.events.length;
    h.rec.freeze();
    h.state('orca', 'down');
    h.state('raydium', 'down');
    h.state('jupiter', 'down');
    h.pool(0, 120);
    h.tick(10_000);
    h.rec.sweep();
    expect(h.events.length).toBe(n);
  });
});
