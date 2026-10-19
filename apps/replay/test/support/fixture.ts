import { readFileSync } from 'node:fs';
import type { MarketsFile } from '@soltape/shared';
import { FIXTURE_VERSION, type Fixture, type FixtureAccount, type FixtureFrame, type FixtureSlot } from '../../src/fixture.js';
import { accountFrame } from '../../src/frames.js';

const accounts = JSON.parse(readFileSync(new URL('../../../../packages/decoder/fixtures/accounts.json', import.meta.url), 'utf8')) as {
  pools: { address: string; owner: string; data: string; slot: number }[];
  mints: { address: string; owner: string; data: string; slot: number }[];
};
export const markets = JSON.parse(readFileSync(new URL('../../../../config/markets.json', import.meta.url), 'utf8')) as MarketsFile;
export const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

/** A small fixture: boot accounts for every pool and mint, and `framesPerPool` frames per pool, 50 ms apart. */
export function smallFixture(framesPerPool = 3, durationMs = 1000): Fixture {
  const acc = new Map<string, FixtureAccount>();
  for (const a of [...accounts.pools, ...accounts.mints]) acc.set(a.address, { kind: 'account', address: a.address, owner: a.owner, data: a.data, slot: 1000 });
  const frames: FixtureFrame[] = [];
  const slots: FixtureSlot[] = [];
  let t = 0;
  let slot = 1000;
  for (let k = 0; k < framesPerPool; k++) {
    for (const p of accounts.pools) {
      t += 50_000;
      slot++;
      const v = { data: p.data, lamports: 1, owner: p.owner, space: Buffer.from(p.data, 'base64').length };
      frames.push({ kind: 'frame', t, venue: p.owner === ORCA ? 'orca' : 'raydium', address: p.address, slot, ...v, body: accountFrame(v, 7, slot) });
      slots.push({ kind: 'slot', t, venue: 'orca', slot });
    }
  }
  return {
    header: { kind: 'header', version: FIXTURE_VERSION, recordedAt: '2026-10-19T00:00:00Z', durationMs: Math.max(durationMs, t / 1000 + 1), recorderVersion: '1', commit: 'test', programIds: { orca: ORCA, raydium: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' }, markets, synthetic: { jupiter: true } },
    accounts: acc,
    frames,
    slots,
    jupiter: [{ kind: 'jupiter', t: 0, body: JSON.stringify({ So11111111111111111111111111111111111111112: { usdPrice: 104, blockId: 1000 }, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { usdPrice: 1, blockId: 1000 } }) }],
  };
}
