import { createHash } from 'node:crypto';
import { base58Encode } from '@soltape/decoder';
import type { MarketsFile } from '@soltape/shared';
import type { Fixture, FixtureAccount } from './fixture.js';

/** Deterministic 32-byte pubkey for synthetic benchmark accounts. */
export function syntheticKey(kind: string, i: number): string {
  return base58Encode(createHash('sha256').update(`soltape-bench:${kind}:${i}`).digest());
}

const SOL = 'So11111111111111111111111111111111111111112';
const MINT_A_OFFSET = { orca: 101, raydium: 73 } as const;
export const SQRT_OFFSET = { orca: 65, raydium: 253 } as const;

export interface BenchPool {
  address: string;
  venue: 'orca' | 'raydium';
  owner: string;
  data: Buffer;
}

export interface BenchSet {
  markets: MarketsFile;
  pools: BenchPool[];
  /** Every account getMultipleAccounts may be asked for (pools and mints). */
  accounts: Map<string, { owner: string; data: Buffer }>;
}

/**
 * Builds `n` synthetic markets, each priced by one Orca and one Raydium pool cloned from the
 * fixture's SOL/USDC pools, with the base-mint field rewritten to a unique synthetic mint
 * (market mints must be unique). Synthetic mint accounts copy the SOL mint (9 decimals).
 * @spec RPL-SRV-007
 */
export function buildBenchSet(fx: Fixture, n: number): BenchSet {
  const quote = fx.header.markets.quote;
  const sol = fx.header.markets.markets.find((m) => m.mint === SOL);
  const orcaT = sol?.venues.orca && 'pool' in sol.venues.orca ? fx.accounts.get(sol.venues.orca.pool) : undefined;
  const rayT = sol?.venues.raydium && 'pool' in sol.venues.raydium ? fx.accounts.get(sol.venues.raydium.pool) : undefined;
  const solMint = fx.accounts.get(SOL);
  const usdc = fx.accounts.get(quote.mint);
  if (!orcaT || !rayT || !solMint || !usdc) throw new Error('fixture lacks the SOL/USDC pools or mint accounts needed for synthetic markets');
  const clone = (t: FixtureAccount, venue: 'orca' | 'raydium', address: string, mint: string): BenchPool => {
    const data = Buffer.from(t.data, 'base64');
    Buffer.from(bs58ToBytes(mint)).copy(data, MINT_A_OFFSET[venue]);
    return { address, venue, owner: t.owner, data };
  };
  const pools: BenchPool[] = [];
  const accounts = new Map<string, { owner: string; data: Buffer }>([[quote.mint, { owner: usdc.owner, data: Buffer.from(usdc.data, 'base64') }]]);
  const markets: MarketsFile['markets'] = [];
  for (let k = 0; k < n; k++) {
    const mint = syntheticKey('mint', k);
    const o = clone(orcaT, 'orca', syntheticKey('orca', k), mint);
    const r = clone(rayT, 'raydium', syntheticKey('raydium', k), mint);
    pools.push(o, r);
    accounts.set(mint, { owner: solMint.owner, data: Buffer.from(solMint.data, 'base64') });
    accounts.set(o.address, o);
    accounts.set(r.address, r);
    markets.push({ symbol: `B${String(k).padStart(4, '0')}`, mint, venues: { orca: { pool: o.address }, raydium: { pool: r.address } } });
  }
  return { markets: { quote, markets }, pools, accounts };
}

/** Scales the pool's sqrt price by (1 + delta), keeping it a valid u128. */
export function perturbSqrt(data: Buffer, venue: 'orca' | 'raydium', delta: number): Buffer {
  const out = Buffer.from(data);
  const off = SQRT_OFFSET[venue];
  const v = out.readBigUInt64LE(off) + (out.readBigUInt64LE(off + 8) << 64n);
  const scaled = (v * BigInt(Math.round((1 + delta) * 1e9))) / 1_000_000_000n;
  out.writeBigUInt64LE(scaled & ((1n << 64n) - 1n), off);
  out.writeBigUInt64LE(scaled >> 64n, off + 8);
  return out;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58ToBytes(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
