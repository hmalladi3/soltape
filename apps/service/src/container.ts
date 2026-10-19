import { selectDecoder, type DecoderSelection, type FrameDecoder } from '@soltape/decoder';
import { systemClock, type Clock } from '@soltape/shared';
import { asFunction, asValue, createContainer, InjectionMode, type AwilixContainer, type Resolver } from 'awilix';
import { WsGateway } from './api/gateway.js';
import type { DependencyStatus } from './api/health.js';
import type { HistoryReader } from './api/history.js';
import { ApiServer } from './api/server.js';
import type { Config } from './config/load.js';
import { JupiterAdapter } from './ingest/jupiter-adapter.js';
import { RpcHttpClient, type RpcHttp } from './ingest/rpc-http.js';
import { RpcVenueAdapter } from './ingest/rpc-adapter.js';
import { buildSkeleton, type MarketModel } from './markets/model.js';
import { Reconciler } from './reconcile/reconciler.js';
import { DEFAULT_THRESHOLDS, type ReconcileThresholds } from './reconcile/types.js';
import { noPersistence } from './runtime/placeholders.js';
import { PhaseHolder, ServiceRuntime, type PersistenceLifecycle, type RuntimeOptions, type ServerLifecycle, type Startable } from './runtime/runtime.js';
import { LatencyWindow } from './telemetry/latency.js';
import { createLogger, type Logger } from './telemetry/logger.js';

/** Everything the composition root registers. Seams can be overridden (RUN-DI-003). */
export interface Cradle {
  config: Config;
  clock: Clock;
  logger: Logger;
  decoderSelection: DecoderSelection;
  decoder: FrameDecoder;
  model: MarketModel;
  thresholds: ReconcileThresholds;
  reconciler: Reconciler;
  rpcHttp: RpcHttp;
  orcaAdapter: Startable;
  raydiumAdapter: Startable;
  jupiterAdapter: Startable;
  adapters: Startable[];
  persistence: PersistenceLifecycle;
  dependencies: DependencyStatus;
  history: HistoryReader | undefined;
  latency: LatencyWindow;
  gateway: WsGateway;
  server: ServerLifecycle;
  phase: PhaseHolder;
  exit: (code: number) => void;
  runtimeOptions: Partial<RuntimeOptions>;
  runtime: ServiceRuntime;
}

export type Overrides = { [K in keyof Cradle]?: Resolver<Cradle[K]> };

/**
 * The single composition root. Every stateful component is a singleton built from its
 * dependencies; all registrations are resolved before returning, so a wiring error fails
 * startup rather than surfacing later.
 * @spec RUN-DI-001, RUN-DI-002, RUN-DI-003
 */
export function createAppContainer(config: Config, overrides: Overrides = {}): AwilixContainer<Cradle> {
  const c = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY, strict: true });
  const s = <T>(fn: (cradle: Cradle) => T) => asFunction(fn).singleton();
  c.register({
    config: asValue(config),
    clock: asValue(systemClock),
    logger: s(({ config }) => createLogger(config.env.logLevel)),
    decoderSelection: s(({ config, logger }) => {
      const sel = selectDecoder(config.env.decoder);
      if (sel.fallbackReason) logger.warn({ reason: sel.fallbackReason }, 'native decoder unavailable; using TypeScript reference decoder');
      return sel;
    }),
    decoder: s(({ decoderSelection }) => decoderSelection.decoder),
    model: s(({ config }) => {
      const r = buildSkeleton(config.markets);
      if (!r.ok) throw new Error(r.errors.join('\n'));
      return r.value;
    }),
    thresholds: asValue(DEFAULT_THRESHOLDS),
    reconciler: s(({ model, clock, thresholds }) => new Reconciler({ model, clock, thresholds })),
    latency: s(({ clock }) => new LatencyWindow(clock)),
    gateway: s(({ model, reconciler, clock, logger, latency }) => {
      const g = new WsGateway({ model, source: reconciler, clock, logger, latency });
      reconciler.setListeners({ gateway: g });
      return g;
    }),
    rpcHttp: s(({ config, clock }) => new RpcHttpClient({ url: config.env.rpcHttpUrl, commitment: config.env.rpcCommitment, timeoutMs: 5000, clock })),
    orcaAdapter: s((d) => rpcAdapter(d, 'orca')),
    raydiumAdapter: s((d) => rpcAdapter(d, 'raydium')),
    jupiterAdapter: s(
      ({ model, reconciler, clock, logger, config }) =>
        new JupiterAdapter({ model, sink: reconciler, clock, logger, url: config.env.jupiterUrl, apiKey: config.env.jupiterApiKey }),
    ),
    adapters: s(({ model, orcaAdapter, raydiumAdapter, jupiterAdapter }) => [
      ...(model.pools.some((p) => p.venue === 'orca') ? [orcaAdapter] : []),
      ...(model.pools.some((p) => p.venue === 'raydium') ? [raydiumAdapter] : []),
      jupiterAdapter,
    ]),
    persistence: asValue(noPersistence),
    dependencies: asValue({ redis: () => 'down', postgres: () => 'down' } satisfies DependencyStatus),
    history: asValue(undefined),
    server: s(
      ({ config, model, reconciler, gateway, phase, clock, logger, decoder, dependencies, latency, history }) =>
        new ApiServer({ port: config.env.port, model, reconciler, gateway, phase, clock, logger, decoderImpl: decoder.impl, dependencies, latency, ...(history ? { history } : {}) }),
    ),
    phase: s(() => new PhaseHolder()),
    exit: asValue((code: number) => process.exit(code)),
    runtimeOptions: asValue({}),
    runtime: s(
      ({ logger, phase, persistence, reconciler, model, server, adapters, rpcHttp, exit, runtimeOptions }) =>
        new ServiceRuntime({ logger, phase, persistence, reconciler, marketCount: model.markets.length, server, adapters, closeables: [rpcHttp], exit, options: runtimeOptions }),
    ),
  });
  c.register(overrides as Record<string, Resolver<unknown>>);
  for (const name of Object.keys(c.registrations)) c.resolve(name as keyof Cradle);
  return c;
}

function rpcAdapter({ model, config, reconciler, decoder, rpcHttp, clock, logger }: Cradle, venue: 'orca' | 'raydium'): Startable {
  return new RpcVenueAdapter({
    venue,
    model,
    markets: config.markets,
    sink: reconciler,
    registry: reconciler,
    decoder,
    rpcHttp,
    wsUrl: config.env.rpcWsUrl,
    commitment: config.env.rpcCommitment,
    clock,
    logger,
  });
}
