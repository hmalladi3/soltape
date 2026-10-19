import { isPubkey } from '@soltape/shared';
import type { MarketModel } from '../markets/model.js';
import { ApiError } from './errors.js';

export type MintLookup = { ok: true; market: number } | { ok: false; code: 'INVALID_MINT' | 'MINT_NOT_TRACKED' };

/** Resolves a `:mint` parameter: a configured symbol (case-insensitive) or a tracked base58 mint. */
// @spec API-HTTP-002, API-HTTP-003, API-HTTP-004
export function lookupMint(model: MarketModel, param: string): MintLookup {
  const bySymbol = model.markets.find((m) => m.symbol.toUpperCase() === param.toUpperCase());
  if (bySymbol) return { ok: true, market: bySymbol.index };
  if (!isPubkey(param)) return { ok: false, code: 'INVALID_MINT' };
  const m = model.marketIndexByMint.get(param);
  return m === undefined ? { ok: false, code: 'MINT_NOT_TRACKED' } : { ok: true, market: m };
}

export function resolveMintOrThrow(model: MarketModel, param: string): number {
  const r = lookupMint(model, param);
  if (r.ok) return r.market;
  if (r.code === 'INVALID_MINT') throw new ApiError(400, 'INVALID_MINT', `${JSON.stringify(param)} is not a base58 mint address or a tracked symbol`);
  throw new ApiError(404, 'MINT_NOT_TRACKED', `Mint ${param} is not tracked`);
}
