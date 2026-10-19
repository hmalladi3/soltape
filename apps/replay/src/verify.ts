import { OUT_LEN, Out, Status, type FrameDecoder } from '@soltape/decoder';

/** The official SDK view of a pool account: what the decoders must agree with. */
export interface SdkPool {
  sqrtPrice: bigint;
  liquidity: bigint;
  tick: number;
}
export type SdkDecode = (venue: 'orca' | 'raydium', data: Buffer) => SdkPool;

/**
 * Checks one recorded account frame: native and reference decoders must return ACCOUNT with
 * bit-identical slots 0-6, and agree with the venue SDK on sqrt price, liquidity and tick.
 * @returns null when consistent, otherwise a description of the disagreement.
 * @spec RPL-REC-004
 */
export function verifyFrame(body: string, venue: 'orca' | 'raydium', data: Buffer, native: FrameDecoder, reference: FrameDecoder, sdk: SdkDecode): string | null {
  const frame = Buffer.from(body);
  const a = new Float64Array(OUT_LEN);
  const b = new Float64Array(OUT_LEN);
  const sa = native.decodeNotification(frame, a);
  const sb = reference.decodeNotification(frame, b);
  if (sa !== Status.ACCOUNT || sb !== Status.ACCOUNT) return `status native=${sa} reference=${sb}`;
  for (let i = 0; i <= Out.SIZE_UNEXPECTED; i++) if (!Object.is(a[i], b[i])) return `slot ${i}: native=${a[i]} reference=${b[i]}`;
  const s = sdk(venue, data);
  const sqrt = Number(s.sqrtPrice) * 2 ** -64;
  if (a[Out.SQRT] !== sqrt) return `sqrt ratio: decoder=${a[Out.SQRT]} sdk=${sqrt}`;
  if (a[Out.LIQ] !== Number(s.liquidity)) return `liquidity: decoder=${a[Out.LIQ]} sdk=${Number(s.liquidity)}`;
  if (a[Out.TICK] !== s.tick) return `tick: decoder=${a[Out.TICK]} sdk=${s.tick}`;
  return null;
}

/** Loads the official Orca and Raydium SDK decoders (dev dependencies of the recorder only). */
export async function loadSdkDecode(): Promise<SdkDecode> {
  const { getWhirlpoolDecoder } = await import('@orca-so/whirlpools-client');
  const { createRequire } = await import('node:module');
  const ray = createRequire(import.meta.url)('@raydium-io/raydium-sdk-v2') as {
    PoolInfoLayout: { decode(b: Buffer): { sqrtPriceX64: { toString(): string }; liquidity: { toString(): string }; tickCurrent: number } };
  };
  const whirl = getWhirlpoolDecoder();
  return (venue, data) => {
    if (venue === 'orca') {
      const w = whirl.decode(data);
      return { sqrtPrice: w.sqrtPrice, liquidity: w.liquidity, tick: w.tickCurrentIndex };
    }
    const r = ray.PoolInfoLayout.decode(data);
    return { sqrtPrice: BigInt(r.sqrtPriceX64.toString()), liquidity: BigInt(r.liquidity.toString()), tick: r.tickCurrent };
  };
}
