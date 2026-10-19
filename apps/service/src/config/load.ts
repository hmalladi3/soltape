import type { MarketsFile, Result } from '@soltape/shared';
import type { EnvConfig } from './env.js';

export interface Config {
  readonly env: Readonly<EnvConfig>;
  readonly markets: Readonly<MarketsFile>;
}

/**
 * Validates env and markets together and returns one deeply frozen config, or all errors
 * from both (RUN-CFG-001, RUN-CFG-002, RUN-CFG-007).
 */
export function loadConfig(_env: Readonly<Record<string, string | undefined>>, _marketsJson: unknown): Result<Config> {
  return { ok: false, errors: ['not implemented'] }; // Phase 5 stub
}
