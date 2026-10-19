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
  /** False until on-chain facts (mints, decimals) have been applied by `resolveVenue`. */
  resolved: boolean;
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
export function poolAddresses(markets: MarketsFile, venue?: PoolVenue): string[] {
  const seen = new Set<string>();
  for (const m of markets.markets) {
    for (const v of ['orca', 'raydium'] as const) {
      const cfg = m.venues[v];
      if (!cfg || (venue && v !== venue)) continue;
      for (const a of 'pool' in cfg ? [cfg.pool] : cfg.route) seen.add(a);
    }
  }
  return [...seen];
}

/** A pool or observation that failed resolution against on-chain facts. */
export interface ResolveError {
  /** Pool indexes involved (marked misconfigured when found after boot). */
  pools: number[];
  message: string;
}

/**
 * Builds the model structure from config alone: dense pool and market indexes, venue
 * observation definitions, and pool users. Pool mints, decimals and leg orientation are
 * unknown (`resolved: false`) until `resolveVenue` runs with on-chain facts, so the service
 * can start before any RPC venue is reachable (RUN-LIFE-005).
 */
export function buildSkeleton(markets: MarketsFile): Result<MarketModel> {
  const errors: string[] = [];
  const pools: Pool[] = [];
  const poolIndexByAddress = new Map<string, number>();
  const poolFor = (address: string, venue: PoolVenue): number => {
    let i = poolIndexByAddress.get(address);
    if (i === undefined) {
      i = pools.length;
      poolIndexByAddress.set(address, i);
      pools.push({ address, venue, mintA: '', mintB: '', decimalsA: Number.NaN, decimalsB: Number.NaN, index: i, sourceId: `${venue}:${address}`, resolved: false });
    } else if (pools[i]!.venue !== venue) {
      errors.push(`pool ${address} is configured under both ${pools[i]!.venue} and ${venue}`);
    }
    return i;
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
      const addrs = 'pool' in cfg ? [cfg.pool] : cfg.route;
      venues.push({
        index: venues.length,
        venue,
        kind: 'pool' in cfg ? 'pool' : 'route',
        legs: addrs.map((a) => ({ pool: poolFor(a, venue), invert: false })),
        sourceId: 'pool' in cfg ? `${venue}:${cfg.pool}` : `${venue}:route(${cfg.route.join(',')})`,
      });
    }
    return { index, symbol: m.symbol, mint: m.mint, venues };
  });
  if (errors.length) return { ok: false, errors };
  const poolUsers = pools.map((p) => out.filter((m) => m.venues.some((v) => v.legs.some((l) => l.pool === p.index))).map((m) => m.index));
  return {
    ok: true,
    value: { quote: { ...markets.quote }, markets: out, pools, poolUsers, poolIndexByAddress, marketIndexByMint: new Map(out.map((m) => [m.mint, m.index])) },
  };
}

/**
 * Resolves one venue's pools against on-chain facts, in place: every pool must exist and be
 * owned by the venue; every direct pool must pair the market mint with the quote mint; every
 * route must chain market → X → quote. Fills mints, decimals and leg orientation and marks
 * pools resolved. Observations that fail are left unresolved and reported.
 * @spec ING-RPC-002, ING-RPC-004, RUN-CFG-004, RUN-CFG-005
 */
export function resolveVenue(model: MarketModel, venue: PoolVenue, facts: ReadonlyMap<string, PoolFacts>): ResolveError[] {
  const errors: ResolveError[] = [];
  const quote = model.quote.mint;
  const factErrors = new Map<number, string>();
  for (const p of model.pools) {
    if (p.venue !== venue) continue;
    const f = facts.get(p.address);
    if (!f) factErrors.set(p.index, `pool ${p.address} was not found on-chain`);
    else if (f.venue !== venue) factErrors.set(p.index, `pool ${p.address} is a ${f.venue} pool, configured under ${venue}`);
  }
  for (const [pool, message] of factErrors) errors.push({ pools: [pool], message });

  for (const m of model.markets) {
    for (const v of m.venues) {
      if (v.venue !== venue) continue;
      const where = `${m.symbol}/${venue}`;
      if (v.legs.some((l) => factErrors.has(l.pool))) continue;
      const invert: boolean[] = [];
      let at = m.mint;
      let failed: string | null = null;
      for (let i = 0; i < v.legs.length && !failed; i++) {
        const f = facts.get(model.pools[v.legs[i]!.pool]!.address)!;
        if (f.mintA === at) {
          invert.push(false);
          at = f.mintB;
        } else if (f.mintB === at) {
          invert.push(true);
          at = f.mintA;
        } else {
          failed = `${where}: pool ${f.address} (${f.mintA}/${f.mintB}) does not contain ${at}`;
          break;
        }
        if (i < v.legs.length - 1 && (at === quote || at === m.mint)) failed = `${where}: route leg ${f.address} must lead to an intermediate mint, not ${at}`;
      }
      if (!failed && at !== quote) failed = `${where}: ${v.kind === 'pool' ? 'pool' : 'route'} ${v.legs.map((l) => model.pools[l.pool]!.address).join(' → ')} ends in ${at}, not the quote mint ${quote}`;
      if (failed) {
        errors.push({ pools: v.legs.map((l) => l.pool), message: failed });
        continue;
      }
      v.legs.forEach((l, i) => {
        l.invert = invert[i]!;
        const f = facts.get(model.pools[l.pool]!.address)!;
        Object.assign(model.pools[l.pool]!, { mintA: f.mintA, mintB: f.mintB, decimalsA: f.decimalsA, decimalsB: f.decimalsB, resolved: true });
      });
    }
  }
  return errors;
}

/**
 * Skeleton plus resolution of every venue: the one-shot form used when all on-chain facts
 * are already known. Returns every error found.
 */
export function buildModel(markets: MarketsFile, facts: ReadonlyMap<string, PoolFacts>): Result<MarketModel> {
  const sk = buildSkeleton(markets);
  if (!sk.ok) return sk;
  const errors = (['orca', 'raydium'] as const).flatMap((v) => resolveVenue(sk.value, v, facts)).map((e) => e.message);
  return errors.length ? { ok: false, errors } : sk;
}
