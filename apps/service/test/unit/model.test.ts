import { readFileSync } from 'node:fs';
import type { MarketsFile } from '@soltape/shared';
import { describe, expect, it } from 'vitest';
import { buildModel } from '../../src/markets/model.js';
import { MINT, POOL_FACTS, factsMap } from '../support/facts.js';

const markets = JSON.parse(readFileSync(new URL('../../../../config/markets.json', import.meta.url), 'utf8')) as MarketsFile;

describe('buildModel', () => {
  // @spec ING-RPC-002, ING-RPC-004
  it('resolves the committed markets against on-chain facts with dense indexes and leg orientation', () => {
    const r = buildModel(markets, factsMap());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value;
    expect(m.markets.map((x) => x.symbol)).toEqual(['SOL', 'JUP', 'JTO', 'BONK', 'WIF']);
    expect(m.pools).toHaveLength(10);
    expect(m.pools.map((p) => p.index)).toEqual([...Array(10).keys()]);
    const sol = m.markets[0]!;
    expect(sol.venues.map((v) => [v.venue, v.kind, v.sourceId])).toEqual([
      ['orca', 'pool', 'orca:HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ'],
      ['raydium', 'pool', 'raydium:2QdhepnKRTLjjSqPL1PtKNwqrUkoLee5Gqs8bvZhRdMv'],
      ['jupiter', 'aggregator', 'jupiter'],
    ]);
    const solOrcaPool = m.poolIndexByAddress.get('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ')!;
    expect(sol.venues[0]!.legs).toEqual([{ pool: solOrcaPool, invert: false }]);
    // JUP/SOL has JUP as token A: not inverted. SOL/JTO has SOL as token A: inverted for JTO.
    const jup = m.markets[1]!;
    expect(jup.venues[0]!.legs.map((l) => l.invert)).toEqual([false, false]);
    expect(jup.venues[0]!.sourceId).toBe('orca:route(C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz,HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ)');
    const jto = m.markets[2]!;
    expect(jto.venues[0]!.legs.map((l) => l.invert)).toEqual([true, false]);
    // The SOL/USDC Whirlpool is used by every market's orca observation.
    expect(m.poolUsers[solOrcaPool]).toEqual([0, 1, 2, 3, 4]);
    expect(m.marketIndexByMint.get(MINT.WIF)).toBe(4);
  });

  // @spec ING-RPC-002
  it('rejects a direct pool whose mints are not the market mint and the quote mint', () => {
    const m = structuredClone(markets);
    m.markets[0]!.venues.orca = { pool: 'C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz' }; // JUP/SOL
    const r = buildModel(m, factsMap());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz/);
  });

  // @spec RUN-CFG-004
  it('rejects a route that does not end in the quote mint', () => {
    const m = structuredClone(markets);
    m.markets[1]!.venues.orca = { route: ['C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz', '2UhFnySoJi6c89aydGAGS7ZRemo2dbkFRhvSJqDX4gHJ'] }; // JUP/SOL then SOL/JTO
    expect(buildModel(m, factsMap()).ok).toBe(false);
  });

  // @spec RUN-CFG-004
  it('rejects a route whose legs do not chain through a shared mint', () => {
    const m = structuredClone(markets);
    m.markets[1]!.venues.orca = { route: ['C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz', 'C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz'] };
    expect(buildModel(m, factsMap()).ok).toBe(false);
  });

  // @spec RUN-CFG-005
  it('rejects a route whose legs belong to another venue', () => {
    const m = structuredClone(markets);
    m.markets[1]!.venues.orca = { route: ['C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz', '2QdhepnKRTLjjSqPL1PtKNwqrUkoLee5Gqs8bvZhRdMv'] }; // raydium SOL/USDC leg
    const r = buildModel(m, factsMap());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/2QdhepnKRTLjjSqPL1PtKNwqrUkoLee5Gqs8bvZhRdMv/);
  });

  // @spec ING-RPC-002
  it('rejects a pool configured under a venue that does not own it', () => {
    const m = structuredClone(markets);
    m.markets[0]!.venues.raydium = { pool: 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ' }; // an Orca pool
    expect(buildModel(m, factsMap()).ok).toBe(false);
  });

  // @spec ING-RPC-002
  it('reports a missing pool (no on-chain facts)', () => {
    const facts = factsMap(POOL_FACTS.filter((p) => p.address !== 'D6NdKrKNQPmRZCCnG1GqXtF7MMoHB7qR6GU5TkG59Qz1'));
    const r = buildModel(markets, facts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/D6NdKrKNQPmRZCCnG1GqXtF7MMoHB7qR6GU5TkG59Qz1/);
  });
});
