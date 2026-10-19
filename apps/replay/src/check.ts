import { poolAddresses } from '@soltape/service/markets/model.js';
import type { MarketsFile } from '@soltape/shared';
import type { Fixture } from './fixture.js';

/**
 * Lists every pool or mint in the markets file that the fixture cannot replay (no boot
 * snapshot). Pools that never traded during the recording are warnings, not failures.
 * @spec RPL-REC-005
 */
export function fixtureCoverage(markets: MarketsFile, fx: Fixture): string[] {
  return coverage(markets, fx).missing;
}

export function coverage(markets: MarketsFile, fx: Fixture): { missing: string[]; warnings: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];
  const framed = new Set(fx.frames.map((f) => f.address));
  for (const p of poolAddresses(markets)) {
    if (!fx.accounts.has(p)) missing.push(`${p}: no boot snapshot`);
    else if (!framed.has(p)) warnings.push(`${p}: no account frame (pool did not trade during the recording; replay serves its snapshot)`);
  }
  for (const mint of new Set([markets.quote.mint, ...markets.markets.map((m) => m.mint)])) {
    if (!fx.accounts.has(mint)) missing.push(`${mint}: no mint account`);
  }
  return { missing, warnings };
}
