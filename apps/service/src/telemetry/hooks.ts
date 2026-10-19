import type { SourceId } from '@soltape/shared';

/**
 * Hot-path observation points. Implementations must be O(1) and allocation-free; all stamps
 * passed in come from the injected Clock as plain numbers.
 * @spec OBS-LAT-001
 */
export interface TelemetryHooks {
  /** Decode duration of one RPC frame, in milliseconds (t1 - t0). */
  decode(venue: SourceId, ms: number): void;
  /** One outbound request (RPC snapshot/revalidate/validate, Jupiter poll), in milliseconds. */
  request(source: SourceId, op: 'jupiter_poll' | 'snapshot' | 'revalidate' | 'validate', ms: number): void;
  /** Stage durations of one emitted consolidated update, in milliseconds. */
  emitted(venue: 'orca' | 'raydium' | 'jupiter' | 'sweep', decodeMs: number | null, reconcileMs: number, fanoutMs: number, internalMs: number | null): void;
  /** One persistence flush, in milliseconds. */
  flush(sink: 'redis' | 'pg_observations' | 'pg_consolidated', ms: number): void;
}

export const noTelemetry: TelemetryHooks = { decode() {}, request() {}, emitted() {}, flush() {} };
