import type { MarketsFile, PoolVenue, Result, SourceId } from '@soltape/shared';

/** On-chain facts about a pool, from boot validation. */
export interface PoolFacts {
  address: string;
  /** Venue derived from the account owner program. */
  venue: PoolVenue;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
}

export interface Pool extends PoolFacts {
  index: number;
  /** `<venue>:<address>`, used as a trigger and in route attribution. */
  sourceId: string;
}

/** One hop of a direct pool or route. Leg price = pAB, or 1/pAB when `invert`. */
export interface Leg {
  pool: number;
  /** True when the leg's input token is the pool's token B (so the output/quote side is A). */
  invert: boolean;
}

export interface VenueObservationDef {
  /** Index within the market's `venues` array. */
  index: number;
  venue: SourceId;
  kind: 'pool' | 'route' | 'aggregator';
  legs: Leg[];
  /** Attribution id: `orca:<pool>`, `orca:route(<p1>,<p2>)`, `jupiter`. */
  sourceId: string;
}

export interface Market {
  index: number;
  symbol: string;
  mint: string;
  venues: VenueObservationDef[];
}

export interface MarketModel {
  quote: { symbol: string; mint: string };
  markets: Market[];
  pools: Pool[];
  /** poolIndex -> indexes of markets whose observations use the pool. */
  poolUsers: number[][];
  poolIndexByAddress: ReadonlyMap<string, number>;
  marketIndexByMint: ReadonlyMap<string, number>;
}

/**
 * Resolves the markets file against on-chain pool facts: checks that every direct pool
 * pairs the market mint with the quote mint, that every route chains market → X → quote,
 * and that route legs belong to the route's venue (RUN-CFG-004, RUN-CFG-005, ING-RPC-002).
 * Assigns dense indexes and computes leg orientation.
 */
export function buildModel(_markets: MarketsFile, _facts: ReadonlyMap<string, PoolFacts>): Result<MarketModel> {
  return { ok: false, errors: ['not implemented'] }; // Phase 5 stub
}
