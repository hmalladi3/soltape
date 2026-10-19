import { readFileSync } from 'node:fs';
import type { MarketsFile } from '@soltape/shared';
import { describe, expect, it } from 'vitest';
import { buildSkeleton, resolveVenue } from '../../src/markets/model.js';
import { POOL_FACTS, factsMap } from '../support/facts.js';

const markets = JSON.parse(readFileSync(new URL('../../../../config/markets.json', import.meta.url), 'utf8')) as MarketsFile;

describe('model skeleton and per-venue resolution', () => {
  // @spec ING-RPC-002, ING-RPC-004
  it('builds indexes from config alone, then resolves one venue at a time', () => {
    const r = buildSkeleton(markets);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value;
    expect(m.pools.every((p) => !p.resolved)).toBe(true);
    expect(resolveVenue(m, 'orca', factsMap())).toEqual([]);
    expect(m.pools.filter((p) => p.resolved).every((p) => p.venue === 'orca')).toBe(true);
    expect(m.pools.filter((p) => p.venue === 'raydium').every((p) => !p.resolved)).toBe(true);
    expect(m.markets[2]!.venues[0]!.legs.map((l) => l.invert)).toEqual([true, false]);
  });

  // @spec ING-RPC-005
  it('reports the pools of a failed observation so they can be marked misconfigured', () => {
    const r = buildSkeleton(markets);
    if (!r.ok) throw new Error();
    const facts = factsMap(POOL_FACTS.filter((p) => p.address !== 'C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz'));
    const errs = resolveVenue(r.value, 'orca', facts);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.pools).toEqual([r.value.poolIndexByAddress.get('C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz')]);
  });

  it('rejects a pool configured under two venues', () => {
    const m = structuredClone(markets);
    m.markets[1]!.venues.raydium = { route: ['C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz', '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv'] };
    expect(buildSkeleton(m).ok).toBe(false);
  });
});
