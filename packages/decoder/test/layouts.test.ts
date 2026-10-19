import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getWhirlpoolDecoder } from '@orca-so/whirlpools-client';
import { describe, expect, it } from 'vitest';
import { Layout, Out, Status } from '../src/contract.js';
import { accountFrame, bytes, implementations, newOut, raydiumPools, whirlpools } from './helpers.js';

const require = createRequire(import.meta.url);
const raydium = require('@raydium-io/raydium-sdk-v2') as {
  PoolInfoLayout: { decode(b: Buffer): Record<string, { toString(): string; toBase58?(): string } & unknown> };
};

interface RaydiumPool {
  sqrtPriceX64: { toString(): string };
  liquidity: { toString(): string };
  tickCurrent: number;
  mintA: { toBase58(): string };
  mintB: { toBase58(): string };
  mintDecimalsA: number;
  mintDecimalsB: number;
}

const disc = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);

describe.each(implementations)('layouts (%s)', (_name, dec) => {
  // @spec DEC-LAY-001
  it('identifies layouts by sha256("account:<Name>")[..8] discriminators', () => {
    for (const p of whirlpools) expect(Buffer.from(p.data, 'base64').subarray(0, 8)).toEqual(disc('Whirlpool'));
    for (const p of raydiumPools) expect(Buffer.from(p.data, 'base64').subarray(0, 8)).toEqual(disc('PoolState'));
    const out = newOut();
    expect(dec.decodeNotification(bytes(accountFrame(whirlpools[0]!.data)), out)).toBe(Status.ACCOUNT);
    expect(out[Out.LAYOUT]).toBe(Layout.WHIRLPOOL);
    expect(dec.decodeNotification(bytes(accountFrame(raydiumPools[0]!.data)), out)).toBe(Status.ACCOUNT);
    expect(out[Out.LAYOUT]).toBe(Layout.RAYDIUM_CLMM);
  });

  // @spec DEC-LAY-002, DEC-LAY-004
  it.each(whirlpools.map((p) => [p.address, p] as const))('matches the Orca SDK for Whirlpool %s', (_a, p) => {
    const sdk = getWhirlpoolDecoder().decode(Buffer.from(p.data, 'base64'));
    const out = newOut();
    expect(dec.decodeNotification(bytes(accountFrame(p.data)), out)).toBe(Status.ACCOUNT);
    expect(out[Out.SQRT]).toBe(Number(sdk.sqrtPrice) * 2 ** -64);
    expect(out[Out.LIQ]).toBe(Number(sdk.liquidity));
    expect(out[Out.TICK]).toBe(sdk.tickCurrentIndex);
  });

  // @spec DEC-LAY-003, DEC-LAY-004
  it.each(raydiumPools.map((p) => [p.address, p] as const))('matches the Raydium SDK for CLMM pool %s', (_a, p) => {
    const sdk = raydium.PoolInfoLayout.decode(Buffer.from(p.data, 'base64')) as unknown as RaydiumPool;
    const out = newOut();
    expect(dec.decodeNotification(bytes(accountFrame(p.data)), out)).toBe(Status.ACCOUNT);
    expect(out[Out.SQRT]).toBe(Number(BigInt(sdk.sqrtPriceX64.toString())) * 2 ** -64);
    expect(out[Out.LIQ]).toBe(Number(BigInt(sdk.liquidity.toString())));
    expect(out[Out.TICK]).toBe(sdk.tickCurrent);
  });

  // @spec DEC-LAY-005
  it.each(whirlpools.map((p) => [p.address, p] as const))('decodeAccount returns full pool info for Whirlpool %s', (_a, p) => {
    const raw = Buffer.from(p.data, 'base64');
    const sdk = getWhirlpoolDecoder().decode(raw);
    const r = dec.decodeAccount(raw, 'orca');
    expect(r.status).toBe(Status.ACCOUNT);
    expect(r.info).toEqual({
      layout: Layout.WHIRLPOOL,
      mintA: sdk.tokenMintA,
      mintB: sdk.tokenMintB,
      sqrtRatio: Number(sdk.sqrtPrice) * 2 ** -64,
      liquidity: Number(sdk.liquidity),
      tick: sdk.tickCurrentIndex,
      sizeUnexpected: false,
    });
  });

  // @spec DEC-LAY-005
  it.each(raydiumPools.map((p) => [p.address, p] as const))('decodeAccount returns full pool info for CLMM pool %s', (_a, p) => {
    const raw = Buffer.from(p.data, 'base64');
    const sdk = raydium.PoolInfoLayout.decode(raw) as unknown as RaydiumPool;
    const r = dec.decodeAccount(raw, 'raydium');
    expect(r.status).toBe(Status.ACCOUNT);
    expect(r.info).toEqual({
      layout: Layout.RAYDIUM_CLMM,
      mintA: sdk.mintA.toBase58(),
      mintB: sdk.mintB.toBase58(),
      decimalsA: sdk.mintDecimalsA,
      decimalsB: sdk.mintDecimalsB,
      sqrtRatio: Number(BigInt(sdk.sqrtPriceX64.toString())) * 2 ** -64,
      liquidity: Number(BigInt(sdk.liquidity.toString())),
      tick: sdk.tickCurrent,
      sizeUnexpected: false,
    });
  });

  // @spec DEC-LAY-005
  it('decodeAccount returns a typed error when the layout does not match the venue', () => {
    expect(dec.decodeAccount(Buffer.from(whirlpools[0]!.data, 'base64'), 'raydium').status).toBe(Status.UNKNOWN_LAYOUT);
    expect(dec.decodeAccount(new Uint8Array(4), 'orca').status).toBe(Status.BAD_LENGTH);
  });
});
