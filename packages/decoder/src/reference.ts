// TypeScript reference decoder: the same contract as the native addon, with bit-identical
// output on every input (DEC-PAR-001). Not used on the hot path unless the addon is missing.
// See docs/llds/frame-decoder.md and native/core/src/frame.rs for the shared semantics.
import { createHash } from 'node:crypto';
import { base58Encode } from './base58.js';
import { Layout, MAX_ACCOUNT_LEN, Out, Status, type DecodeAccountResult, type FrameDecoder, type PoolInfo, type Venue } from './contract.js';

const MAX_B64_LEN = 5464;
const TWO_POW_NEG_64 = 2 ** -64;
const MIN_TICK = -443_636;
const MAX_TICK = 443_636;

/** Anchor account discriminator: `sha256("account:<Name>")[..8]`. */
const discriminator = (name: string) => new Uint8Array(createHash('sha256').update(`account:${name}`).digest().subarray(0, 8));
const WHIRLPOOL_DISCRIMINATOR = discriminator('Whirlpool');
const RAYDIUM_POOL_STATE_DISCRIMINATOR = discriminator('PoolState');

interface LayoutSpec {
  layout: number;
  size: number;
  minLen: number;
  liquidity: number;
  sqrtPrice: number;
  tick: number;
  mintA: number;
  mintB: number;
  decimals: [number, number] | null;
  minSqrt: bigint;
  maxSqrt: bigint;
}

const WHIRLPOOL: LayoutSpec = {
  layout: Layout.WHIRLPOOL,
  size: 653,
  minLen: 213,
  liquidity: 49,
  sqrtPrice: 65,
  tick: 81,
  mintA: 101,
  mintB: 181,
  decimals: null,
  minSqrt: 4_295_048_016n,
  maxSqrt: 79_226_673_515_401_279_992_447_579_055n,
};

const RAYDIUM: LayoutSpec = {
  layout: Layout.RAYDIUM_CLMM,
  size: 1544,
  minLen: 273,
  liquidity: 237,
  sqrtPrice: 253,
  tick: 269,
  mintA: 73,
  mintB: 105,
  decimals: [233, 234],
  minSqrt: 4_295_048_016n,
  maxSqrt: 79_226_673_521_066_979_257_578_248_091n,
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Own-property read: JSON.parse objects can carry keys like `__proto__` or `constructor`. */
const get = (o: Obj, k: string): Json | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

// @spec DEC-REF-001, DEC-REF-002, DEC-PAR-001
export const referenceDecoder: FrameDecoder = {
  impl: 'reference',
  decodeNotification(frame: Uint8Array, out: Float64Array): number {
    try {
      return decodeNotification(frame, out);
    } catch {
      // @spec DEC-REF-003 — the one sanctioned catch point, mirroring native catch_unwind.
      return Status.PANIC;
    }
  },
  decodeAccount(data: Uint8Array, venue: Venue): DecodeAccountResult {
    try {
      return decodeAccount(data, venue);
    } catch {
      return { status: Status.PANIC };
    }
  },
};

// @spec DEC-FRAME-001, DEC-FRAME-002, DEC-FRAME-003, DEC-FRAME-004, DEC-FRAME-005, DEC-FRAME-009, DEC-FRAME-010
function decodeNotification(frame: Uint8Array, out: Float64Array): number {
  if (!(frame instanceof Uint8Array)) throw new TypeError('frame must be a Uint8Array');
  out[Out.SUB] = -1;
  let top: Json;
  try {
    top = JSON.parse(utf8.decode(frame)) as Json;
  } catch {
    return Status.MALFORMED_JSON;
  }
  if (strictRejects(top)) return Status.MALFORMED_JSON;
  if (!isObj(top)) return Status.OTHER;
  const method = get(top, 'method');
  if (method === 'accountNotification') return account(top, out);
  if (method === 'slotNotification') return slot(top, out);
  return Status.OTHER;
}

function account(top: Obj, out: Float64Array): number {
  const p = get(top, 'params');
  if (!isObj(p)) return Status.MALFORMED_JSON;
  const r = get(p, 'result');
  if (!isObj(r)) return Status.MALFORMED_JSON;
  const c = get(r, 'context');
  const v = get(r, 'value');
  if (!isObj(c) || !isObj(v)) return Status.MALFORMED_JSON;
  const sub = id(get(p, 'subscription'));
  const slotNo = id(get(c, 'slot'));
  if (sub === null || slotNo === null || !Object.hasOwn(v, 'data')) return Status.MALFORMED_JSON;
  out[Out.SUB] = sub;
  const data = get(v, 'data');
  if (!Array.isArray(data) || data.length !== 2 || typeof data[0] !== 'string' || data[1] !== 'base64') {
    return Status.BAD_ENCODING;
  }
  const b64 = data[0];
  if (Buffer.byteLength(b64, 'utf8') > MAX_B64_LEN) return Status.BAD_LENGTH;
  const bytes = decodeBase64Strict(b64);
  if (bytes === null) return Status.BAD_ENCODING;
  if (bytes.length > MAX_ACCOUNT_LEN) return Status.BAD_LENGTH;
  const spec = specFor(bytes);
  if (typeof spec === 'number') return spec;
  const f = readPrice(spec, bytes);
  if (typeof f === 'number') return f;
  out[Out.SLOT] = slotNo;
  out[Out.LAYOUT] = spec.layout;
  out[Out.SQRT] = f.sqrtRatio;
  out[Out.LIQ] = f.liquidity;
  out[Out.TICK] = f.tick;
  out[Out.SIZE_UNEXPECTED] = f.sizeUnexpected ? 1 : 0;
  return Status.ACCOUNT;
}

function slot(top: Obj, out: Float64Array): number {
  const p = get(top, 'params');
  if (!isObj(p)) return Status.MALFORMED_JSON;
  const r = get(p, 'result');
  if (!isObj(r)) return Status.MALFORMED_JSON;
  const sub = id(get(p, 'subscription'));
  const s = id(get(r, 'slot'));
  if (sub === null || s === null) return Status.MALFORMED_JSON;
  out[Out.SUB] = sub;
  out[Out.SLOT] = s;
  return Status.SLOT;
}

/** A non-negative integer ≤ 2^53 - 1; `-0` is normalized to `0`. */
function id(v: Json | undefined): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v + 0 : null;
}

/** Canonical, padded standard base64 only (matches Rust's `STANDARD` engine). */
function decodeBase64Strict(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return b.toString('base64') === s ? b : null;
}

/**
 * Mirrors the only inputs where serde rejects text that JSON.parse accepts: keys that serde
 * cannot represent (unpaired surrogates) in objects the decoder walks, and scalar values it
 * cannot represent (unpaired surrogates, numbers overflowing f64) at positions where it
 * expects an object or the `data` array. See native/core/src/frame.rs.
 */
function strictRejects(top: Json): boolean {
  const unrepresentableScalar = (v: Json | undefined) => (typeof v === 'string' && !v.isWellFormed()) || (typeof v === 'number' && !Number.isFinite(v));
  const badKeys = (o: Obj) => Object.keys(o).some((k) => !k.isWellFormed());
  const container = (v: Json | undefined, children?: (o: Obj) => boolean): boolean => {
    if (unrepresentableScalar(v)) return true;
    if (!isObj(v)) return false;
    return badKeys(v) || (children?.(v) ?? false);
  };
  return container(top, (t) =>
    container(get(t, 'params'), (p) => container(get(p, 'result'), (r) => container(get(r, 'context')) || container(get(r, 'value'), (v) => container(get(v, 'data'))))),
  );
}

function specFor(bytes: Uint8Array): LayoutSpec | number {
  if (bytes.length < 8) return Status.BAD_LENGTH;
  const disc = bytes.subarray(0, 8);
  const spec = eq(disc, WHIRLPOOL_DISCRIMINATOR) ? WHIRLPOOL : eq(disc, RAYDIUM_POOL_STATE_DISCRIMINATOR) ? RAYDIUM : null;
  if (spec === null) return Status.UNKNOWN_LAYOUT;
  if (bytes.length < spec.minLen) return Status.BAD_LENGTH;
  return spec;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function u128(b: Uint8Array, off: number): bigint {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return v.getBigUint64(off, true) | (v.getBigUint64(off + 8, true) << 64n);
}

function i32(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(off, true);
}

interface PriceFields {
  sqrtRatio: number;
  liquidity: number;
  tick: number;
  sizeUnexpected: boolean;
}

function readPrice(spec: LayoutSpec, b: Uint8Array): PriceFields | number {
  const sqrt = u128(b, spec.sqrtPrice);
  const tick = i32(b, spec.tick);
  if (sqrt < spec.minSqrt || sqrt > spec.maxSqrt || tick < MIN_TICK || tick > MAX_TICK) return Status.INVALID_VALUE;
  return {
    // Number(bigint) rounds to nearest, ties to even, exactly like Rust's `u128 as f64`.
    sqrtRatio: Number(sqrt) * TWO_POW_NEG_64,
    liquidity: Number(u128(b, spec.liquidity)),
    tick,
    sizeUnexpected: b.length !== spec.size,
  };
}

// @spec DEC-LAY-005
function decodeAccount(data: Uint8Array, venue: Venue): DecodeAccountResult {
  const spec = specFor(data);
  if (typeof spec === 'number') return { status: spec };
  if (spec.layout !== (venue === 'orca' ? Layout.WHIRLPOOL : Layout.RAYDIUM_CLMM)) return { status: Status.UNKNOWN_LAYOUT };
  const f = readPrice(spec, data);
  if (typeof f === 'number') return { status: f };
  const info: PoolInfo = {
    layout: spec.layout,
    mintA: base58Encode(data.subarray(spec.mintA, spec.mintA + 32)),
    mintB: base58Encode(data.subarray(spec.mintB, spec.mintB + 32)),
    sqrtRatio: f.sqrtRatio,
    liquidity: f.liquidity,
    tick: f.tick,
    sizeUnexpected: f.sizeUnexpected,
  };
  if (spec.decimals) {
    info.decimalsA = data[spec.decimals[0]]!;
    info.decimalsB = data[spec.decimals[1]]!;
  }
  return { status: Status.ACCOUNT, info };
}
