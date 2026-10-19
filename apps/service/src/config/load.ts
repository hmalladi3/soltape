import { parseMarketsFile, type MarketsFile, type Result } from '@soltape/shared';
import { parseEnv, type EnvConfig } from './env.js';

export interface Config {
  readonly env: Readonly<EnvConfig>;
  readonly markets: Readonly<MarketsFile>;
}

/**
 * Validates env and markets together and returns one deeply frozen config, or all
 * errors from both.
 * @spec RUN-CFG-001, RUN-CFG-002, RUN-CFG-007
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>, marketsJson: unknown): Result<Config> {
  const e = parseEnv(env);
  const m = parseMarketsFile(marketsJson);
  const errors = [...(e.ok ? [] : e.errors), ...(m.ok ? [] : m.errors)];
  if (!e.ok || !m.ok) return { ok: false, errors };
  return { ok: true, value: deepFreeze({ env: e.value, markets: structuredClone(m.value) }) };
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}
