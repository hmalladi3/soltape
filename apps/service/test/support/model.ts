import type { Leg, Market, MarketModel, Pool, VenueObservationDef } from '../../src/markets/model.js';
import { MINT, POOL_FACTS } from './facts.js';

/**
 * Hand-built model (independent of buildModel) for reconciler tests:
 *   market 0 SOL: orca direct (pool 0), raydium direct (pool 1), jupiter
 *   market 1 JUP: orca route [pool 2 JUP/SOL, pool 0], raydium route [pool 3, pool 1], jupiter
 *   market 2 JTO: orca route [pool 4 SOL/JTO inverted, pool 0], raydium route [pool 5 inverted, pool 1], jupiter
 */
export function testModel(): MarketModel {
  const pools: Pool[] = POOL_FACTS.slice(0, 6).map((p, index) => ({ ...p, index, sourceId: `${p.venue}:${p.address}`, resolved: true }));
  const direct = (index: number, venue: 'orca' | 'raydium', pool: number): VenueObservationDef => ({
    index,
    venue,
    kind: 'pool',
    legs: [{ pool, invert: false }],
    sourceId: pools[pool]!.sourceId,
  });
  const route = (index: number, venue: 'orca' | 'raydium', legs: Leg[]): VenueObservationDef => ({
    index,
    venue,
    kind: 'route',
    legs,
    sourceId: `${venue}:route(${legs.map((l) => pools[l.pool]!.address).join(',')})`,
  });
  const jup = (index: number): VenueObservationDef => ({ index, venue: 'jupiter', kind: 'aggregator', legs: [], sourceId: 'jupiter' });
  const markets: Market[] = [
    { index: 0, symbol: 'SOL', mint: MINT.SOL, venues: [direct(0, 'orca', 0), direct(1, 'raydium', 1), jup(2)] },
    {
      index: 1,
      symbol: 'JUP',
      mint: MINT.JUP,
      venues: [
        route(0, 'orca', [
          { pool: 2, invert: false },
          { pool: 0, invert: false },
        ]),
        route(1, 'raydium', [
          { pool: 3, invert: false },
          { pool: 1, invert: false },
        ]),
        jup(2),
      ],
    },
    {
      index: 2,
      symbol: 'JTO',
      mint: MINT.JTO,
      venues: [
        route(0, 'orca', [
          { pool: 4, invert: true },
          { pool: 0, invert: false },
        ]),
        route(1, 'raydium', [
          { pool: 5, invert: true },
          { pool: 1, invert: false },
        ]),
        jup(2),
      ],
    },
  ];
  const poolUsers = pools.map((p) => markets.filter((m) => m.venues.some((v) => v.legs.some((l) => l.pool === p.index))).map((m) => m.index));
  return {
    quote: { symbol: 'USDC', mint: MINT.USDC },
    markets,
    pools,
    poolUsers,
    poolIndexByAddress: new Map(pools.map((p) => [p.address, p.index])),
    marketIndexByMint: new Map(markets.map((m) => [m.mint, m.index])),
  };
}

/** Raw sqrt ratio giving `price` (token B per token A, decimal-adjusted) for a pool. */
export function sqrtForPoolPrice(pool: Pool, priceBperA: number): number {
  return Math.sqrt(priceBperA / 10 ** (pool.decimalsA - pool.decimalsB));
}
