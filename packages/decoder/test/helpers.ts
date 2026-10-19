import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OUT_LEN, type FrameDecoder } from '../src/contract.js';
import { loadNativeDecoder } from '../src/native.js';
import { referenceDecoder } from '../src/reference.js';

export interface AccountFixture {
  address: string;
  slot: number;
  owner: string;
  space: number;
  data: string;
}
export interface Fixtures {
  pools: AccountFixture[];
  mints: AccountFixture[];
}

export const fixtures: Fixtures = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/accounts.json', import.meta.url)), 'utf8')) as Fixtures;

export const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
export const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

export const whirlpools = fixtures.pools.filter((p) => p.owner === WHIRLPOOL_PROGRAM);
export const raydiumPools = fixtures.pools.filter((p) => p.owner === RAYDIUM_CLMM_PROGRAM);

export const nativeDecoder: FrameDecoder = loadNativeDecoder();
export const implementations: [string, FrameDecoder][] = [
  ['native', nativeDecoder],
  ['reference', referenceDecoder],
];

export const newOut = (): Float64Array => new Float64Array(OUT_LEN).fill(Number.NaN);
export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface AccountFrameOptions {
  sub?: unknown;
  slot?: unknown;
  data?: unknown;
  /** Emit keys in reverse order at every level (JSON key order is not guaranteed). */
  reverseKeys?: boolean;
  extra?: Record<string, unknown>;
}

/** Builds an `accountNotification` frame in the exact shape Solana RPC sends. */
export function accountFrame(dataB64: string, opts: AccountFrameOptions = {}): string {
  const value = {
    data: 'data' in opts ? opts.data : [dataB64, 'base64'],
    executable: false,
    lamports: 13645859,
    owner: RAYDIUM_CLMM_PROGRAM,
    rentEpoch: Number.MAX_SAFE_INTEGER,
    space: Buffer.from(dataB64, 'base64').length,
  };
  const frame = {
    jsonrpc: '2.0',
    method: 'accountNotification',
    params: {
      result: { context: { slot: opts.slot ?? 372000123 }, value },
      subscription: opts.sub ?? 42,
    },
    ...opts.extra,
  };
  return opts.reverseKeys ? JSON.stringify(reverseDeep(frame)) : JSON.stringify(frame);
}

export function slotFrame(slot: number, sub = 7): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'slotNotification',
    params: { result: { parent: slot - 1, root: slot - 32, slot }, subscription: sub },
  });
}

function reverseDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseDeep);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, x]) => [k, reverseDeep(x)]),
    );
  }
  return v;
}

/** Reads a little-endian u128 at `offset`. */
export function u128(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset) + (buf.readBigUInt64LE(offset + 8) << 64n);
}

export function withU128(dataB64: string, offset: number, value: bigint): string {
  const b = Buffer.from(dataB64, 'base64');
  b.writeBigUInt64LE(value & ((1n << 64n) - 1n), offset);
  b.writeBigUInt64LE(value >> 64n, offset + 8);
  return b.toString('base64');
}

export function withI32(dataB64: string, offset: number, value: number): string {
  const b = Buffer.from(dataB64, 'base64');
  b.writeInt32LE(value, offset);
  return b.toString('base64');
}

export function resized(dataB64: string, length: number): string {
  const b = Buffer.from(dataB64, 'base64');
  const out = Buffer.alloc(length);
  b.copy(out, 0, 0, Math.min(length, b.length));
  return out.toString('base64');
}
