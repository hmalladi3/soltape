import type { MarketsFile, PoolVenue, PoolVenueConfig, Result, SourceId } from '@soltape/shared';

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
  /** True when the leg's input token is the pool's token B (so its output side is A). */
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

const VENUE_ORDER = ['orca', 'raydium', 'jupiter'] as const;

/** Every pool address referenced by a markets file, in first-seen order. */
export function poolAddresses(markets: MarketsFile): string[] {
  const seen = new Set<string>();
  for (const m of markets.markets) {
    for (const v of [m.venues.orca, m.venues.raydium]) if (v) for (const a of 'pool' in v ? [v.pool] : v.route) seen.add(a);
  }
  return [...seen];
}

/**
 * Resolves the markets file against on-chain pool facts: every direct pool must pair the
 * market mint with the quote mint, every route must chain market → X → quote, and every
 * pool must be owned by the venue it is configured under. Assigns dense indexes and leg
 * orientation. Returns every error found.
 * @spec ING-RPC-002, ING-RPC-004, RUN-CFG-004, RUN-CFG-005
 */
export function buildModel(markets: MarketsFile, facts: ReadonlyMap<string, PoolFacts>): Result<MarketModel> {
  const errors: string[] = [];
  const pools: Pool[] = [];
  const poolIndexByAddress = new Map<string, number>();
  const quote = markets.quote.mint;

  const poolIndex = (address: string, venue: PoolVenue, where: string): Pool | null => {
    const f = facts.get(address);
    if (!f) {
      errors.push(`${where}: pool ${address} was not found on-chain`);
      return null;
    }
    if (f.venue !== venue) {
      errors.push(`${where}: pool ${address} is a ${f.venue} pool, configured under ${venue}`);
      return null;
    }
    let i = poolIndexByAddress.get(address);
    if (i === undefined) {
      i = pools.length;
      poolIndexByAddress.set(address, i);
      pools.push({ ...f, index: i, sourceId: `${venue}:${address}` });
    }
    return pools[i]!;
  };

  /** Leg converting `from` into the pool's other mint; null if the pool lacks `from`. */
  const legFrom = (p: Pool, from: string): { leg: Leg; to: string } | null => {
    if (p.mintA === from) return { leg: { pool: p.index, invert: false }, to: p.mintB };
    if (p.mintB === from) return { leg: { pool: p.index, invert: true }, to: p.mintA };
    return null;
  };

  const resolveVenue = (symbol: string, mint: string, venue: PoolVenue, cfg: PoolVenueConfig): { legs: Leg[]; sourceId: string } | null => {
    const where = `${symbol}/${venue}`;
    const addrs = 'pool' in cfg ? [cfg.pool] : cfg.route;
    const resolved = addrs.map((a) => poolIndex(a, venue, where));
    if (resolved.some((p) => p === null)) return null;
    const legs: Leg[] = [];
    let at = mint;
    for (const p of resolved as Pool[]) {
      const step = legFrom(p, at);
      if (!step) {
        errors.push(`${where}: pool ${p.address} (${p.mintA}/${p.mintB}) does not contain ${at}`);
        return null;
      }
      legs.push(step.leg);
      at = step.to;
      if (legs.length < addrs.length && (at === quote || at === mint)) {
        errors.push(`${where}: route leg ${p.address} must lead to an intermediate mint, not ${at}`);
        return null;
      }
    }
    if (at !== quote) {
      errors.push(`${where}: ${'pool' in cfg ? `pool ${cfg.pool}` : `route ${cfg.route.join(' → ')}`} ends in ${at}, not the quote mint ${quote}`);
      return null;
    }
    const sourceId = 'pool' in cfg ? `${venue}:${cfg.pool}` : `${venue}:route(${cfg.route.join(',')})`;
    return { legs, sourceId };
  };

  const out: Market[] = markets.markets.map((m, index) => {
    const venues: VenueObservationDef[] = [];
    for (const venue of VENUE_ORDER) {
      if (venue === 'jupiter') {
        if (m.venues.jupiter) venues.push({ index: venues.length, venue, kind: 'aggregator', legs: [], sourceId: 'jupiter' });
        continue;
      }
      const cfg = m.venues[venue];
      if (!cfg) continue;
      const r = resolveVenue(m.symbol, m.mint, venue, cfg);
      if (r) venues.push({ index: venues.length, venue, kind: 'pool' in cfg ? 'pool' : 'route', legs: r.legs, sourceId: r.sourceId });
    }
    return { index, symbol: m.symbol, mint: m.mint, venues };
  });
  if (errors.length) return { ok: false, errors };

  const poolUsers = pools.map((p) => out.filter((m) => m.venues.some((v) => v.legs.some((l) => l.pool === p.index))).map((m) => m.index));
  return {
    ok: true,
    value: {
      quote: { ...markets.quote },
      markets: out,
      pools,
      poolUsers,
      poolIndexByAddress,
      marketIndexByMint: new Map(out.map((m) => [m.mint, m.index])),
    },
  };
}
