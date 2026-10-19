import type { Clock, SourceId, SourceState } from '@soltape/shared';
import type { MarketModel } from '../markets/model.js';
import type { Reconciler } from '../reconcile/reconciler.js';
import type { PhaseHolder } from '../runtime/runtime.js';

export type DependencyState = 'up' | 'down';
export interface DependencyStatus {
  redis(): DependencyState;
  postgres(): DependencyState;
}

export type HealthStatus = 'starting' | 'ok' | 'degraded' | 'down' | 'stopping';

export interface Health {
  status: HealthStatus;
  uptimeS: number;
  decoder: 'native' | 'reference';
  sources: { id: SourceId; state: SourceState; lastEventAgeMs?: number }[];
  dependencies: { redis: DependencyState; postgres: DependencyState };
  markets: { available: number; unavailable: number };
  misconfigured: { pool: string; venue: SourceId; reason: string }[];
}

export interface HealthDeps {
  model: MarketModel;
  reconciler: Reconciler;
  phase: PhaseHolder;
  clock: Clock;
  startedAt: number;
  decoderImpl: 'native' | 'reference';
  dependencies: DependencyStatus;
}

/**
 * Health reflects the feed's ability to serve prices. Disabled sources and datastore
 * outages are reported but do not change the status.
 * @spec API-HLTH-001, API-HLTH-002, API-HLTH-003, API-HLTH-004, API-HLTH-005
 */
export function computeHealth(d: HealthDeps): { http: number; body: Health } {
  const configured = (['orca', 'raydium', 'jupiter'] as const).filter((s) => d.model.markets.some((m) => m.venues.some((v) => v.venue === s)));
  const sources = configured.map((id) => {
    const st = d.reconciler.sourceStatus(id);
    return st.lastEventAgeMs === null || st.state === 'disabled' ? { id, state: st.state } : { id, state: st.state, lastEventAgeMs: Math.round(st.lastEventAgeMs) };
  });
  const available = d.model.markets.filter((m) => d.reconciler.available(m.index)).length;
  const unavailable = d.model.markets.length - available;
  const misconfigured = d.reconciler.misconfiguredPools();
  const enabledNotLive = sources.some((s) => s.state !== 'disabled' && s.state !== 'live');

  let status: HealthStatus;
  if (d.phase.phase === 'stopping') status = 'stopping';
  else if (d.phase.phase === 'starting') status = 'starting';
  else if (available === 0) status = 'down';
  else if (enabledNotLive || unavailable > 0 || misconfigured.length > 0) status = 'degraded';
  else status = 'ok';

  return {
    http: status === 'down' || status === 'stopping' ? 503 : 200,
    body: {
      status,
      uptimeS: Math.round((d.clock.mono() - d.startedAt) / 1000),
      decoder: d.decoderImpl,
      sources,
      dependencies: { redis: d.dependencies.redis(), postgres: d.dependencies.postgres() },
      markets: { available, unavailable },
      misconfigured,
    },
  };
}
