/** On-chain venues decoded from pool accounts. */
export type PoolVenue = 'orca' | 'raydium';
/** Every price source. */
export type SourceId = PoolVenue | 'jupiter';
export const SOURCE_IDS: readonly SourceId[] = ['orca', 'raydium', 'jupiter'];

/** Adapter-reported connection state (the registry derives `stale` on top). */
export type AdapterState = 'disabled' | 'connecting' | 'live' | 'down';
/** Source state as judged by the reconciler's registry. */
export type SourceState = AdapterState | 'stale';

/** All time is read through this seam. */
// @spec RUN-DI-004
export interface Clock {
  /** Monotonic milliseconds (performance.now() in production). */
  mono(): number;
  /** Wall-clock epoch milliseconds (Date.now() in production). */
  wall(): number;
}

export const systemClock: Clock = {
  mono: () => performance.now(),
  wall: () => Date.now(),
};

export type Result<T, E = string[]> = { ok: true; value: T } | { ok: false; errors: E };
