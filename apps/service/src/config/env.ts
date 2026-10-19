import type { Result } from '@soltape/shared';
import { z } from 'zod';

export interface EnvConfig {
  port: number;
  rpcHttpUrl: string;
  rpcWsUrl: string;
  rpcCommitment: 'processed' | 'confirmed' | 'finalized';
  jupiterApiKey: string | undefined;
  jupiterUrl: string;
  redisUrl: string;
  databaseUrl: string;
  decoder: 'auto' | 'native' | 'ts';
  marketsFile: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  historyRetentionDays: number;
}

export const ENV_DEFAULTS = {
  port: 8080,
  rpcHttpUrl: 'https://api.mainnet-beta.solana.com',
  rpcWsUrl: 'wss://api.mainnet-beta.solana.com',
  rpcCommitment: 'processed',
  jupiterUrl: 'https://api.jup.ag/price/v3',
  redisUrl: 'redis://redis:6379',
  databaseUrl: 'postgres://soltape:soltape@postgres:5432/soltape',
  decoder: 'auto',
  marketsFile: 'config/markets.json',
  logLevel: 'info',
  historyRetentionDays: 7,
} as const satisfies Omit<EnvConfig, 'jupiterApiKey'>;

const url = (...protocols: string[]) =>
  z.string().refine(
    (s) => {
      try {
        return protocols.includes(new URL(s).protocol);
      } catch {
        return false;
      }
    },
    { message: `must be a ${protocols.map((p) => p.replace(':', '://')).join(' or ')} URL` },
  );
const int = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, `must be an integer between ${min} and ${max}`)
    .transform(Number)
    .pipe(z.number().int().min(min, `must be an integer between ${min} and ${max}`).max(max, `must be an integer between ${min} and ${max}`));

/** One schema entry per variable: env name → config key, parser, default. */
const vars = {
  PORT: ['port', int(0, 65535)],
  RPC_HTTP_URL: ['rpcHttpUrl', url('http:', 'https:')],
  RPC_WS_URL: ['rpcWsUrl', url('ws:', 'wss:')],
  RPC_COMMITMENT: ['rpcCommitment', z.enum(['processed', 'confirmed', 'finalized'])],
  JUPITER_URL: ['jupiterUrl', url('http:', 'https:')],
  REDIS_URL: ['redisUrl', url('redis:', 'rediss:')],
  DATABASE_URL: ['databaseUrl', url('postgres:', 'postgresql:')],
  DECODER: ['decoder', z.enum(['auto', 'native', 'ts'])],
  MARKETS_FILE: ['marketsFile', z.string().min(1)],
  LOG_LEVEL: ['logLevel', z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])],
  HISTORY_RETENTION_DAYS: ['historyRetentionDays', int(1, 365)],
} as const satisfies Record<string, readonly [keyof EnvConfig, z.ZodType]>;

/**
 * Parses and validates the process environment, applying documented defaults.
 * Returns every error found. An empty `JUPITER_API_KEY` counts as unset.
 * @spec RUN-CFG-001, RUN-CFG-002, RUN-CFG-003
 */
export function parseEnv(env: Readonly<Record<string, string | undefined>>): Result<EnvConfig> {
  const errors: string[] = [];
  const out: Record<string, unknown> = { ...ENV_DEFAULTS, jupiterApiKey: env['JUPITER_API_KEY'] || undefined };
  for (const [name, [key, schema]] of Object.entries(vars)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const r = schema.safeParse(raw);
    if (r.success) out[key] = r.data;
    else errors.push(`${name}: ${r.error.issues[0]?.message ?? 'invalid'} (got ${JSON.stringify(raw)})`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out as unknown as EnvConfig };
}
