import type { Clock } from '@soltape/shared';
import { describe, expect, it } from 'vitest';
import { WsGateway } from '../../../src/api/gateway.js';
import { Reconciler } from '../../../src/reconcile/reconciler.js';
import { DEFAULT_THRESHOLDS } from '../../../src/reconcile/types.js';
import { LatencyWindow } from '../../../src/telemetry/latency.js';
import { silentLogger } from '../../../src/telemetry/logger.js';
import { LATENCY_BUCKETS, Telemetry } from '../../../src/telemetry/metrics.js';
import { FakeClock } from '../../support/clock.js';
import { sqrtForPoolPrice, testModel } from '../../support/model.js';

function setup() {
  const clock = new FakeClock();
  const model = testModel();
  const reconciler = new Reconciler({ model, clock, thresholds: DEFAULT_THRESHOLDS });
  const telemetry = new Telemetry();
  const gateway = new WsGateway({ model, source: reconciler, clock, logger: silentLogger, telemetry });
  reconciler.setListeners({ gateway });
  const rpc = [
    { id: 'orca' as const, stats: { updates: 0, decodeErrors: new Map<number, number>(), reconnects: new Map<string, number>() } },
    { id: 'raydium' as const, stats: { updates: 0, decodeErrors: new Map<number, number>(), reconnects: new Map<string, number>() } },
  ];
  const jupiter = { stats: { updates: 0 } };
  const pers = { depth: 3, dropped: 2 };
  telemetry.registerCollectors({
    model,
    reconciler,
    gateway,
    adapters: { rpc, jupiter },
    persistence: { queueDepth: () => pers.depth, dropped: () => pers.dropped, state: (s) => (s === 'redis' ? 'up' : 'down') },
  });
  let slot = 100;
  const feed = () => {
    for (const s of ['orca', 'raydium'] as const) {
      reconciler.onSourceState(s, 'live');
      reconciler.onSlot(s, 120, clock.mono());
    }
    reconciler.onSourceState('jupiter', 'disabled');
    for (const [i, p] of [[0, 100], [1, 100.1]] as const) reconciler.onPoolUpdate(i, sqrtForPoolPrice(model.pools[i]!, p), 1e12, 0, ++slot, clock.mono(), clock.wall(), clock.mono(), 'notification');
  };
  const text = async () => (await telemetry.scrape()).body;
  const value = (body: string, metric: string, labels: Record<string, string> = {}) => {
    const lines = body.split('\n').filter((l) => l.startsWith(metric + '{') || l.startsWith(metric + ' '));
    const line = lines.find((l) => Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)));
    return line === undefined ? undefined : Number(line.split(' ').at(-1));
  };
  return { clock, model, reconciler, telemetry, gateway, rpc, jupiter, pers, feed, text, value };
}

describe('metrics', () => {
  // @spec OBS-MET-001, OBS-MET-008
  it('exposes per-source metrics, derived from component stats at scrape time', async () => {
    const t = setup();
    t.feed();
    t.rpc[0]!.stats.updates = 7;
    t.rpc[0]!.stats.decodeErrors.set(-3, 2);
    t.rpc[1]!.stats.reconnects.set('ping_timeout', 1);
    t.jupiter.stats.updates = 4;
    t.telemetry.request('jupiter', 'jupiter_poll', 120);
    const b = await t.text();
    expect(t.value(b, 'soltape_source_updates_total', { source: 'orca' })).toBe(7);
    expect(t.value(b, 'soltape_source_updates_total', { source: 'jupiter' })).toBe(4);
    expect(t.value(b, 'soltape_source_state', { source: 'orca', state: 'live' })).toBe(1);
    expect(t.value(b, 'soltape_source_state', { source: 'jupiter', state: 'disabled' })).toBe(1);
    expect(t.value(b, 'soltape_source_liveness_age_seconds', { source: 'orca' })).toBe(0);
    expect(t.value(b, 'soltape_source_reconnects_total', { source: 'raydium', cause: 'ping_timeout' })).toBe(1);
    expect(t.value(b, 'soltape_source_request_seconds_count', { source: 'jupiter', op: 'jupiter_poll' })).toBe(1);
    expect(t.value(b, 'soltape_decode_errors_total', { source: 'orca', code: '-3' })).toBe(2);
    expect(t.value(b, 'soltape_updates_out_of_order_total', { source: 'orca' })).toBe(0);
    // Slot head 120; latest raydium pool update is slot 102.
    expect(t.value(b, 'soltape_source_slot_lag', { source: 'raydium' })).toBe(18);
    // Counters stay monotonic across scrapes as stats grow.
    t.rpc[0]!.stats.updates = 10;
    expect(t.value(await t.text(), 'soltape_source_updates_total', { source: 'orca' })).toBe(10);
  });

  // @spec OBS-MET-002
  it('exposes per-market metrics', async () => {
    const t = setup();
    t.feed();
    const b = await t.text();
    const sol = { mint: t.model.markets[0]!.mint, symbol: 'SOL' };
    expect(t.value(b, 'soltape_consolidated_sources', sol)).toBe(2);
    expect(t.value(b, 'soltape_consolidated_degraded', sol)).toBe(0);
    expect(t.value(b, 'soltape_consolidated_spread_bps', sol)).toBeCloseTo(10, 0);
    expect(t.value(b, 'soltape_consolidated_updates_total', sol)).toBe(2);
    expect(t.value(b, 'soltape_updates_suppressed_total', sol)).toBe(0);
    expect(t.value(b, 'soltape_observation_eligible', { ...sol, source: t.model.markets[0]!.venues[0]!.sourceId })).toBe(1);
    expect(t.value(b, 'soltape_observation_age_seconds', { ...sol, source: t.model.markets[0]!.venues[0]!.sourceId })).toBe(0);
  });

  // @spec OBS-MET-003, OBS-MET-004
  it('exposes gateway and persistence metrics', async () => {
    const t = setup();
    t.gateway.stats.messagesSent = 5;
    t.gateway.stats.conflated = 2;
    t.telemetry.flush('pg_consolidated', 12);
    const b = await t.text();
    expect(t.value(b, 'soltape_ws_clients')).toBe(0);
    expect(t.value(b, 'soltape_ws_messages_sent_total')).toBe(5);
    expect(t.value(b, 'soltape_ws_conflated_total')).toBe(2);
    expect(t.value(b, 'soltape_ws_slow_disconnects_total')).toBe(0);
    expect(b).toContain('soltape_http_requests_total');
    expect(b).toContain('soltape_http_request_seconds');
    expect(t.value(b, 'soltape_persist_queue_depth', { sink: 'pg_observations' })).toBe(3);
    expect(t.value(b, 'soltape_persist_dropped_total', { sink: 'pg_consolidated' })).toBe(2);
    expect(t.value(b, 'soltape_persist_state', { sink: 'redis' })).toBe(1);
    expect(t.value(b, 'soltape_persist_state', { sink: 'pg_consolidated' })).toBe(0);
    expect(t.value(b, 'soltape_persist_flush_seconds_count', { sink: 'pg_consolidated' })).toBe(1);
  });

  // @spec OBS-MET-005
  it('exposes Node.js default metrics including event-loop delay, GC and heap', async () => {
    const b = await setup().text();
    for (const m of ['nodejs_eventloop_lag_p99_seconds', 'nodejs_gc_duration_seconds', 'nodejs_heap_size_used_bytes']) expect(b).toContain(m);
    const delay = Number(/^soltape_eventloop_delay_p99_seconds (\S+)$/m.exec(b)![1]);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(0.05); // net of the sampling interval: an idle loop reads near zero
  });

  // @spec OBS-MET-006
  it('computes time-dependent gauges at scrape time, without events', async () => {
    const t = setup();
    t.feed();
    t.clock.advance(1500);
    const b = await t.text();
    expect(t.value(b, 'soltape_source_liveness_age_seconds', { source: 'orca' })).toBe(1.5);
    expect(t.value(b, 'soltape_observation_age_seconds', { mint: t.model.markets[0]!.mint, source: t.model.markets[0]!.venues[0]!.sourceId })).toBe(1.5);
  });

  // @spec OBS-MET-007
  it('uses only bounded label names on soltape metrics', async () => {
    const t = setup();
    t.feed();
    t.telemetry.decode('orca', 0.01);
    const allowed = new Set(['source', 'state', 'cause', 'code', 'mint', 'symbol', 'venue', 'op', 'sink', 'route', 'status', 'le']);
    const used = new Set<string>();
    for (const line of (await t.text()).split('\n')) {
      if (!line.startsWith('soltape_')) continue;
      for (const m of line.matchAll(/([a-z_]+)="/g)) used.add(m[1]!);
    }
    expect([...used].filter((l) => !allowed.has(l))).toEqual([]);
  });
});

describe('latency', () => {
  // @spec OBS-LAT-001, OBS-LAT-003, OBS-LAT-004
  it('records stage durations from the injected clock, internal latency only for data-triggered updates', async () => {
    let now = 0;
    const clock: Clock = { mono: () => now, wall: () => 1_700_000_000_000 };
    const t = setup();
    const calls: unknown[][] = [];
    const tel = { ...t.telemetry, emitted: (...a: unknown[]) => calls.push(a), decode() {}, request() {}, flush() {} };
    const g = new WsGateway({ model: t.model, source: t.reconciler, clock, logger: silentLogger, telemetry: tel as never, latency: new LatencyWindow(clock) });
    const c = { ...t.reconciler.consolidated(0), trigger: { source: 'orca:x', slot: 1 } } as never;
    now = 10;
    g.onConsolidated(0, c, { recvTs: 2, decodedTs: 3, reconciledTs: 7 });
    expect(calls[0]).toEqual(['orca', 1, 4, 3, 8]);
    g.onConsolidated(0, { ...(c as object), trigger: { source: 'sweep', slot: null } } as never, { recvTs: null, decodedTs: null, reconciledTs: 9 });
    expect(calls[1]).toEqual(['sweep', null, 0, 1, null]);
  });

  // @spec OBS-LAT-002, OBS-LAT-003
  it('observes histograms labelled by venue, never by pool', async () => {
    const t = setup();
    t.telemetry.decode('raydium', 0.004);
    t.telemetry.emitted('orca', 0.004, 0.01, 0.02, 0.05);
    const b = await t.text();
    expect(t.value(b, 'soltape_decode_seconds_count', { venue: 'raydium' })).toBe(1);
    expect(t.value(b, 'soltape_internal_latency_seconds_count', { venue: 'orca' })).toBe(1);
    expect(t.value(b, 'soltape_reconcile_seconds_count')).toBe(1);
    expect(t.value(b, 'soltape_fanout_seconds_count')).toBe(1);
    expect(t.value(b, 'soltape_internal_latency_seconds_sum', { venue: 'orca' })).toBeCloseTo(0.00005, 9);
  });

  // @spec OBS-LAT-005
  it('uses the specified bucket bounds from 5 µs to 50 ms', async () => {
    const t = setup();
    t.telemetry.decode('orca', 0.001);
    const les = (await t.text())
      .split('\n')
      .filter((l) => l.startsWith('soltape_decode_seconds_bucket') && l.includes('venue="orca"'))
      .map((l) => /le="([^"]+)"/.exec(l)![1]!)
      .filter((x) => x !== '+Inf')
      .map(Number);
    expect(les).toEqual(LATENCY_BUCKETS);
    expect(LATENCY_BUCKETS).toEqual([5e-6, 10e-6, 25e-6, 50e-6, 100e-6, 250e-6, 500e-6, 1e-3, 2.5e-3, 5e-3, 10e-3, 50e-3]);
  });

  // @spec OBS-LAT-006
  it('keeps exact HDR percentiles over a rolling window', () => {
    const clock = new FakeClock();
    const w = new LatencyWindow(clock, 10_000);
    for (let i = 1; i <= 1000; i++) w.record(i / 1000); // 1 µs .. 1000 µs
    const s = w.summary();
    expect(s.count).toBe(1000);
    expect(s.p50).toBeGreaterThanOrEqual(499);
    expect(s.p50).toBeLessThanOrEqual(501);
    expect(s.p99).toBeGreaterThanOrEqual(989);
    expect(s.p999).toBeGreaterThanOrEqual(998);
    clock.advance(10_000);
    w.record(0.002);
    expect(w.summary().count).toBe(1001); // previous window still included
    clock.advance(10_000);
    w.record(0.002);
    expect(w.summary().count).toBe(2); // the oldest window has rolled off
    clock.advance(25_000);
    expect(w.summary().count).toBe(0); // idle: everything stale
  });
});
