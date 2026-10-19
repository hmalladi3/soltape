import type { SourceId } from '@soltape/shared';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { WsGateway } from '../api/gateway.js';
import type { MarketModel } from '../markets/model.js';
import type { Reconciler } from '../reconcile/reconciler.js';
import type { TelemetryHooks } from './hooks.js';

/** Latency buckets (seconds): 5 µs to 50 ms. */
// @spec OBS-LAT-005
export const LATENCY_BUCKETS = [5e-6, 10e-6, 25e-6, 50e-6, 100e-6, 250e-6, 500e-6, 1e-3, 2.5e-3, 5e-3, 10e-3, 50e-3];
const REQUEST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const SOURCE_STATES = ['disabled', 'connecting', 'live', 'stale', 'down'] as const;
const SOURCES: readonly SourceId[] = ['orca', 'raydium', 'jupiter'];
const LOOP_RESOLUTION_MS = 1;

/** What the collectors read at scrape time. Counters are derived from component stats. */
export interface MetricSources {
  model: MarketModel;
  reconciler: Reconciler;
  gateway: WsGateway;
  adapters: {
    rpc: { id: SourceId; stats: { updates: number; decodeErrors: Map<number, number>; reconnects: Map<string, number> } }[];
    jupiter?: { stats: { updates: number } };
  };
  persistence?: {
    queueDepth(sink: 'redis' | 'pg_observations' | 'pg_consolidated'): number;
    dropped(sink: 'pg_observations' | 'pg_consolidated'): number;
    state(sink: 'redis' | 'postgres'): 'up' | 'down';
  };
}

/**
 * The Prometheus registry. Hot paths only call the `TelemetryHooks` (histogram observations).
 * Every counter is derived at scrape time from statistics the components already keep, and
 * every time-dependent gauge is computed at scrape time (OBS-MET-006).
 * @spec OBS-MET-001, OBS-MET-002, OBS-MET-003, OBS-MET-004, OBS-MET-005, OBS-MET-006, OBS-MET-007, OBS-MET-008
 */
export class Telemetry implements TelemetryHooks {
  readonly registry = new Registry();
  private readonly decodeH: Histogram<'venue'>;
  private readonly reconcileH: Histogram;
  private readonly fanoutH: Histogram;
  private readonly internalH: Histogram<'venue'>;
  private readonly requestH: Histogram<'source' | 'op'>;
  private readonly flushH: Histogram<'sink'>;
  readonly httpRequests: Counter<'route' | 'status'>;
  readonly httpSeconds: Histogram<'route'>;
  private readonly decodeChild: Record<string, { observe(v: number): void }>;
  private readonly internalChild: Record<string, { observe(v: number): void }>;
  private readonly loop: ReturnType<typeof monitorEventLoopDelay>;

  constructor() {
    const r = this.registry;
    collectDefaultMetrics({ register: r, eventLoopMonitoringPrecision: 10 });
    const h = <L extends string>(name: string, help: string, labelNames: L[], buckets = LATENCY_BUCKETS) => new Histogram<L>({ name, help, labelNames, buckets, registers: [r] });
    this.decodeH = h('soltape_decode_seconds', 'Frame receipt to decoded (t1 - t0)', ['venue']);
    this.reconcileH = h('soltape_reconcile_seconds', 'Decoded to consolidated (t2 - t1), emitted updates only', []);
    this.fanoutH = h('soltape_fanout_seconds', 'Consolidated to last WebSocket write (t3 - t2)', []);
    this.internalH = h('soltape_internal_latency_seconds', 'Frame receipt to last WebSocket write (t3 - t0), emitted updates only', ['venue']);
    this.requestH = h('soltape_source_request_seconds', 'Outbound request duration', ['source', 'op'], REQUEST_BUCKETS);
    this.flushH = h('soltape_persist_flush_seconds', 'Persistence flush duration', ['sink'], REQUEST_BUCKETS);
    this.httpRequests = new Counter({ name: 'soltape_http_requests_total', help: 'HTTP requests', labelNames: ['route', 'status'], registers: [r] });
    this.httpSeconds = h('soltape_http_request_seconds', 'HTTP request duration', ['route'], [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.1, 0.5, 2]);
    this.decodeChild = Object.fromEntries(SOURCES.map((s) => [s, this.decodeH.labels(s)]));
    this.internalChild = Object.fromEntries(['orca', 'raydium', 'jupiter', 'sweep'].map((s) => [s, this.internalH.labels(s)]));
    // Node's histogram reports the sampling interval plus lateness; subtract the interval so the
    // gauge is the actual event-loop delay (the default nodejs_eventloop_lag_* metrics include it).
    this.loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.loop.enable();
    const loop = this.loop;
    new Gauge({
      name: 'soltape_eventloop_delay_p99_seconds',
      help: 'p99 event-loop delay since the previous scrape, net of the 1 ms sampling interval',
      registers: [r],
      collect() {
        const p99 = loop.count > 0 ? loop.percentile(99) : Number.NaN;
        this.set(Number.isFinite(p99) ? Math.max(0, p99 / 1e9 - LOOP_RESOLUTION_MS / 1000) : 0);
        loop.reset();
      },
    });
  }

  // ---- hot-path hooks (milliseconds in, seconds recorded) ---------------------------------

  // @spec OBS-LAT-002
  decode(venue: SourceId, ms: number): void {
    this.decodeChild[venue]!.observe(ms / 1000);
  }

  request(source: SourceId, op: string, ms: number): void {
    this.requestH.labels(source, op).observe(ms / 1000);
  }

  /** @spec OBS-LAT-003, OBS-LAT-004 */
  emitted(venue: 'orca' | 'raydium' | 'jupiter' | 'sweep', _decodeMs: number | null, reconcileMs: number, fanoutMs: number, internalMs: number | null): void {
    this.reconcileH.observe(reconcileMs / 1000);
    this.fanoutH.observe(fanoutMs / 1000);
    if (internalMs !== null) this.internalChild[venue]!.observe(internalMs / 1000);
  }

  flush(sink: 'redis' | 'pg_observations' | 'pg_consolidated', ms: number): void {
    this.flushH.labels(sink).observe(ms / 1000);
  }

  // ---- scrape-time collectors --------------------------------------------------------------

  registerCollectors(src: MetricSources): void {
    const r = this.registry;
    const counter = (name: string, help: string, labelNames: string[], read: () => [Record<string, string>, number][]) => {
      const last = new Map<string, number>();
      new Counter({
        name,
        help,
        labelNames,
        registers: [r],
        collect() {
          for (const [labels, value] of read()) {
            const key = JSON.stringify(labels);
            const delta = value - (last.get(key) ?? 0);
            if (delta > 0) this.inc(labels, delta);
            else if (!last.has(key)) this.inc(labels, 0);
            last.set(key, value);
          }
        },
      });
    };
    const gauge = (name: string, help: string, labelNames: string[], read: () => [Record<string, string>, number][]) =>
      new Gauge({
        name,
        help,
        labelNames,
        registers: [r],
        collect() {
          this.reset();
          for (const [labels, value] of read()) this.set(labels, value);
        },
      });
    const rec = src.reconciler;
    const markets = src.model.markets;

    // Per source
    counter('soltape_source_updates_total', 'Updates delivered by each source', ['source'], () => [
      ...src.adapters.rpc.map((a): [Record<string, string>, number] => [{ source: a.id }, a.stats.updates]),
      ...(src.adapters.jupiter ? [[{ source: 'jupiter' }, src.adapters.jupiter.stats.updates] as [Record<string, string>, number]] : []),
    ]);
    gauge('soltape_source_state', '1 for the current state of each source', ['source', 'state'], () =>
      SOURCES.flatMap((s) => {
        const st = rec.sourceStatus(s).state;
        return SOURCE_STATES.map((x): [Record<string, string>, number] => [{ source: s, state: x }, x === st ? 1 : 0]);
      }),
    );
    gauge('soltape_source_liveness_age_seconds', 'Age of the last liveness signal', ['source'], () =>
      SOURCES.flatMap((s): [Record<string, string>, number][] => {
        const a = rec.sourceStatus(s).lastEventAgeMs;
        return a === null ? [] : [[{ source: s }, a / 1000]];
      }),
    );
    counter('soltape_source_reconnects_total', 'Reconnects by cause', ['source', 'cause'], () =>
      src.adapters.rpc.flatMap((a) => [...a.stats.reconnects].map(([cause, n]): [Record<string, string>, number] => [{ source: a.id, cause }, n])),
    );
    gauge('soltape_source_slot_lag', "Venue slot head minus its latest account update's slot", ['source'], () =>
      (['orca', 'raydium'] as const).flatMap((s): [Record<string, string>, number][] => {
        const lag = rec.slotLag(s);
        return lag === null ? [] : [[{ source: s }, lag]];
      }),
    );
    counter('soltape_decode_errors_total', 'Frames rejected by the decoder, by status code', ['source', 'code'], () =>
      src.adapters.rpc.flatMap((a) => [...a.stats.decodeErrors].map(([code, n]): [Record<string, string>, number] => [{ source: a.id, code: String(code) }, n])),
    );
    counter('soltape_updates_out_of_order_total', 'Pool updates discarded for a lower slot', ['source'], () =>
      (['orca', 'raydium'] as const).map((s): [Record<string, string>, number] => [{ source: s }, rec.outOfOrderCount(s)]),
    );

    // Per market
    const obsGauge = (name: string, help: string, pick: (o: ReturnType<Reconciler['observations']>[number]) => number | null) =>
      gauge(name, help, ['mint', 'symbol', 'source'], () =>
        markets.flatMap((m) =>
          rec.observations(m.index).flatMap((o): [Record<string, string>, number][] => {
            const v = pick(o);
            return v === null ? [] : [[{ mint: m.mint, symbol: m.symbol, source: o.source }, v]];
          }),
        ),
      );
    obsGauge('soltape_observation_age_seconds', 'Age of each observation', (o) => (o.ageMs === null ? null : o.ageMs / 1000));
    obsGauge('soltape_observation_eligible', '1 if the observation counts toward the price', (o) => (o.eligible ? 1 : 0));
    const marketGauge = (name: string, help: string, pick: (m: number) => number | null) =>
      gauge(name, help, ['mint', 'symbol'], () =>
        markets.flatMap((m): [Record<string, string>, number][] => {
          const v = pick(m.index);
          return v === null ? [] : [[{ mint: m.mint, symbol: m.symbol }, v]];
        }),
      );
    marketGauge('soltape_consolidated_sources', 'Eligible sources in the consolidated price', (m) => (rec.available(m) ? (rec.consolidated(m)?.sources.length ?? 0) : 0));
    marketGauge('soltape_consolidated_degraded', '1 if fewer sources than configured contribute', (m) => (rec.available(m) ? (rec.consolidated(m)?.degraded ? 1 : 0) : 1));
    marketGauge('soltape_consolidated_spread_bps', 'Spread across eligible sources', (m) => (rec.available(m) ? (rec.consolidated(m)?.spreadBps ?? null) : null));
    counter('soltape_consolidated_updates_total', 'Consolidated updates emitted', ['mint', 'symbol'], () =>
      markets.map((m): [Record<string, string>, number] => [{ mint: m.mint, symbol: m.symbol }, rec.emittedCount(m.index)]),
    );
    counter('soltape_updates_suppressed_total', 'Inputs that changed nothing (no emission)', ['mint', 'symbol'], () =>
      markets.map((m): [Record<string, string>, number] => [{ mint: m.mint, symbol: m.symbol }, rec.suppressedCount(m.index)]),
    );

    // Gateway
    const g = src.gateway.stats;
    gauge('soltape_ws_clients', 'Connected WebSocket clients', [], () => [[{}, g.clients]]);
    counter('soltape_ws_messages_sent_total', 'WebSocket messages sent', [], () => [[{}, g.messagesSent]]);
    counter('soltape_ws_conflated_total', 'Updates deferred or overwritten for congested clients', [], () => [[{}, g.conflated]]);
    counter('soltape_ws_slow_disconnects_total', 'Clients closed for staying congested', [], () => [[{}, g.slowDisconnects]]);

    // Persistence
    const p = src.persistence;
    if (p) {
      const sinks = ['redis', 'pg_observations', 'pg_consolidated'] as const;
      gauge('soltape_persist_queue_depth', 'Rows (or markets, for redis) waiting to be written', ['sink'], () =>
        sinks.map((s): [Record<string, string>, number] => [{ sink: s }, p.queueDepth(s)]),
      );
      counter('soltape_persist_dropped_total', 'Rows dropped (queue full or failed batch)', ['sink'], () =>
        (['pg_observations', 'pg_consolidated'] as const).map((s): [Record<string, string>, number] => [{ sink: s }, p.dropped(s)]),
      );
      gauge('soltape_persist_state', '1 if the sink is up', ['sink'], () =>
        sinks.map((s): [Record<string, string>, number] => [{ sink: s }, p.state(s === 'redis' ? 'redis' : 'postgres') === 'up' ? 1 : 0]),
      );
    }
  }

  async scrape(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
