import { ApiError } from './errors.js';

export const BUCKETS = { '1s': 1_000, '10s': 10_000, '1m': 60_000, '5m': 300_000, '1h': 3_600_000 } as const;
export type Bucket = keyof typeof BUCKETS;
export const MAX_BUCKETS = 2000;

export interface HistoryBucket {
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  samples: number;
}

/** Reads bucketed consolidated history (implemented by the Postgres sink, persistence.md). */
export interface HistoryReader {
  available(): boolean;
  /** Wall-clock ms of the oldest retained data (start of the oldest daily partition). */
  retentionStartMs(): number;
  /** Non-empty buckets only, oldest first. Rejects on failure or the 2 s query timeout. */
  query(mint: string, fromMs: number, toMs: number, bucket: Bucket): Promise<HistoryBucket[]>;
}

const WINDOW = /^(\d{1,5})(s|m|h|d)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export interface HistoryQuery {
  fromMs: number;
  toMs: number;
  bucket: Bucket;
  clamped: boolean;
}

/**
 * Parses `window` (e.g. `1h`, `30m`, `7d`; default `1h`) and `bucket` (default `1m`),
 * clamps the range to retention, and enforces the bucket-count limit.
 * @spec API-REST-006, API-REST-007
 */
export function parseHistoryQuery(q: Record<string, unknown>, nowWall: number, retentionStartMs: number): HistoryQuery {
  const window = q['window'] ?? '1h';
  const bucket = q['bucket'] ?? '1m';
  const w = typeof window === 'string' ? WINDOW.exec(window) : null;
  if (!w || Number(w[1]) === 0) throw new ApiError(400, 'INVALID_QUERY', 'window must look like 30s, 15m, 1h or 7d');
  if (typeof bucket !== 'string' || !(bucket in BUCKETS)) throw new ApiError(400, 'INVALID_QUERY', `bucket must be one of ${Object.keys(BUCKETS).join(', ')}`);
  const span = Number(w[1]) * UNIT_MS[w[2] as keyof typeof UNIT_MS];
  const b = bucket as Bucket;
  let fromMs = nowWall - span;
  let clamped = false;
  if (fromMs < retentionStartMs) {
    fromMs = retentionStartMs;
    clamped = true;
  }
  if ((nowWall - fromMs) / BUCKETS[b] > MAX_BUCKETS) throw new ApiError(400, 'INVALID_QUERY', `window/bucket would produce more than ${MAX_BUCKETS} buckets`);
  return { fromMs, toMs: nowWall, bucket: b, clamped };
}
