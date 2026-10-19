import { z } from 'zod';
import type { Result } from './types.js';

export interface DirectVenue {
  pool: string;
}
export interface RouteVenue {
  route: [string, string];
}
export type PoolVenueConfig = DirectVenue | RouteVenue;

export interface MarketConfig {
  symbol: string;
  mint: string;
  venues: {
    orca?: PoolVenueConfig;
    raydium?: PoolVenueConfig;
    jupiter?: Record<string, never>;
  };
}

export interface MarketsFile {
  quote: { symbol: string; mint: string };
  markets: MarketConfig[];
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map(Array.from(B58, (c, i) => [c, BigInt(i)] as const));

/** True when `s` is base58 that decodes to exactly 32 bytes. */
export function isPubkey(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  let n = 0n;
  let zeros = 0;
  let leading = true;
  for (const c of s) {
    const d = B58_INDEX.get(c);
    if (d === undefined) return false;
    if (leading && d === 0n) zeros++;
    else leading = false;
    n = n * 58n + d;
  }
  const bodyBytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
  return zeros + bodyBytes === 32;
}

const pubkey = z.string().refine(isPubkey, { message: 'must be a base58-encoded 32-byte public key' });
const poolVenue = z.union([z.strictObject({ pool: pubkey }), z.strictObject({ route: z.tuple([pubkey, pubkey]) })], {
  error: 'must be { "pool": <address> } or { "route": [<address>, <address>] }',
});
const symbol = z.string().regex(/^[A-Za-z0-9]{1,16}$/, 'must be 1-16 letters or digits');

const marketsSchema = z
  .strictObject({
    quote: z.strictObject({ symbol, mint: pubkey }),
    markets: z
      .array(
        z.strictObject({
          symbol,
          mint: pubkey,
          venues: z
            .strictObject({ orca: poolVenue.optional(), raydium: poolVenue.optional(), jupiter: z.strictObject({}).optional() })
            .refine((v) => Object.keys(v).length > 0, 'must configure at least one venue'),
        }),
      )
      .min(1, 'must declare at least one market'),
  })
  .superRefine((file, ctx) => {
    const seen = (key: (m: (typeof file.markets)[number]) => string, what: string) => {
      const first = new Map<string, number>();
      file.markets.forEach((m, i) => {
        const k = key(m);
        const j = first.get(k);
        if (j === undefined) first.set(k, i);
        else ctx.addIssue({ code: 'custom', path: ['markets', i], message: `duplicate ${what} "${k}" (also markets[${j}])` });
      });
    };
    seen((m) => m.symbol.toUpperCase(), 'symbol');
    seen((m) => m.mint, 'mint');
    file.markets.forEach((m, i) => {
      if (m.mint === file.quote.mint) ctx.addIssue({ code: 'custom', path: ['markets', i, 'mint'], message: 'must not be the quote mint' });
    });
  });

/** Formats zod issues as `path: message` lines. */
export function formatIssues(issues: readonly z.core.$ZodIssue[], prefix = ''): string[] {
  return issues.map((i) => {
    const path = i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('');
    return `${prefix}${path.replace(/^\./, '') || '(root)'}: ${i.message}`;
  });
}

/**
 * Validates a parsed markets file: shape, base58 keys, unique symbols (case-insensitive)
 * and mints. Returns every error found. Route venue membership and mint chaining are
 * checked against on-chain facts at boot (apps/service markets model).
 * @spec RUN-CFG-004, RUN-CFG-006
 */
export function parseMarketsFile(input: unknown): Result<MarketsFile> {
  const r = marketsSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data as MarketsFile } : { ok: false, errors: formatIssues(r.error.issues, 'markets file ') };
}
