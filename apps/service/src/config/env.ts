import type { Result } from '@soltape/shared';

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

/** Parses and validates process environment (RUN-CFG-001..003). Returns every error found. */
export function parseEnv(_env: Readonly<Record<string, string | undefined>>): Result<EnvConfig> {
  return { ok: false, errors: ['not implemented'] }; // Phase 5 stub
}
