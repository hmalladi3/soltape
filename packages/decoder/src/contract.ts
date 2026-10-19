// Decoder contract shared by the native addon and the TypeScript reference decoder.
// Values mirror native/core/src/contract.rs and are part of the FFI contract.
// See docs/llds/frame-decoder.md.

export const Status = {
  ACCOUNT: 1,
  SLOT: 2,
  OTHER: 0,
  MALFORMED_JSON: -1,
  BAD_ENCODING: -2,
  BAD_LENGTH: -3,
  UNKNOWN_LAYOUT: -4,
  INVALID_VALUE: -5,
  PANIC: -6,
} as const;
export type StatusCode = (typeof Status)[keyof typeof Status];

export const Out = {
  SUB: 0,
  SLOT: 1,
  LAYOUT: 2,
  SQRT: 3,
  LIQ: 4,
  TICK: 5,
  SIZE_UNEXPECTED: 6,
} as const;
export const OUT_LEN = 8;

export const Layout = { WHIRLPOOL: 1, RAYDIUM_CLMM: 2 } as const;
export type LayoutId = (typeof Layout)[keyof typeof Layout];

export const MAX_ACCOUNT_LEN = 4096;

export type Venue = 'orca' | 'raydium';

export interface PoolInfo {
  layout: number;
  mintA: string;
  mintB: string;
  decimalsA?: number;
  decimalsB?: number;
  sqrtRatio: number;
  liquidity: number;
  tick: number;
  sizeUnexpected: boolean;
}

export interface DecodeAccountResult {
  status: number;
  info?: PoolInfo;
}

export interface FrameDecoder {
  readonly impl: 'native' | 'reference';
  /** Hot path: decodes a raw JSON-RPC notification frame into `out`; returns a status code. */
  decodeNotification(frame: Uint8Array, out: Float64Array): number;
  /** Cold path: decodes raw (already base64-decoded) pool account bytes. */
  decodeAccount(data: Uint8Array, venue: Venue): DecodeAccountResult;
}
