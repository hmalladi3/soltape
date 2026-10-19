import type { Result } from './types.js';

export interface DirectVenue {
  pool: string;
}
export interface RouteVenue {
  route: [string, string];
}
export type PoolVenueConfig = DirectVenue | RouteVenue;

export interface MarketConfig {
  symbol: string;
  mint: string;
  venues: {
    orca?: PoolVenueConfig;
    raydium?: PoolVenueConfig;
    jupiter?: Record<string, never>;
  };
}

export interface MarketsFile {
  quote: { symbol: string; mint: string };
  markets: MarketConfig[];
}

/** True when `s` is base58 that decodes to exactly 32 bytes. */
export function isPubkey(_s: string): boolean {
  return false; // Phase 5 stub
}

/**
 * Validates a parsed markets file (RUN-CFG-004..006): shape, base58 keys, unique symbols
 * and mints. Returns every error found. Route venue membership and route chaining are
 * checked against on-chain mints at boot (see apps/service markets model).
 */
export function parseMarketsFile(_input: unknown): Result<MarketsFile> {
  return { ok: false, errors: ['not implemented'] }; // Phase 5 stub
}
