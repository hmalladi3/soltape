import { readFileSync } from 'node:fs';
import { isPubkey, parseMarketsFile, type MarketsFile } from '@soltape/shared';
import { describe, expect, it } from 'vitest';
import { ENV_DEFAULTS, parseEnv } from '../../src/config/env.js';
import { loadConfig } from '../../src/config/load.js';

const markets = JSON.parse(readFileSync(new URL('../../../../config/markets.json', import.meta.url), 'utf8')) as MarketsFile;
const clone = (): MarketsFile => structuredClone(markets);

describe('environment', () => {
  // @spec RUN-CFG-003
  it('applies documented defaults for unset variables', () => {
    const r = parseEnv({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ ...ENV_DEFAULTS, jupiterApiKey: undefined });
  });

  // @spec RUN-CFG-001
  it('parses provided values', () => {
    const r = parseEnv({
      PORT: '9000',
      RPC_COMMITMENT: 'confirmed',
      JUPITER_API_KEY: 'k',
      DECODER: 'native',
      HISTORY_RETENTION_DAYS: '3',
      LOG_LEVEL: 'debug',
    });
    expect(r.ok && r.value).toMatchObject({ port: 9000, rpcCommitment: 'confirmed', jupiterApiKey: 'k', decoder: 'native', historyRetentionDays: 3, logLevel: 'debug' });
  });

  // @spec RUN-CFG-002
  it('reports every invalid variable, not just the first', () => {
    const r = parseEnv({ PORT: 'eighty', DECODER: 'fast', RPC_WS_URL: 'not a url', HISTORY_RETENTION_DAYS: '0' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/PORT/);
    expect(r.errors.join('\n')).toMatch(/DECODER/);
    expect(r.errors.join('\n')).toMatch(/RPC_WS_URL/);
    expect(r.errors.join('\n')).toMatch(/HISTORY_RETENTION_DAYS/);
  });

  // @spec RUN-CFG-001
  it('treats an empty JUPITER_API_KEY as unset', () => {
    const r = parseEnv({ JUPITER_API_KEY: '' });
    expect(r.ok && r.value.jupiterApiKey).toBeUndefined();
  });
});

describe('markets file', () => {
  // @spec RUN-CFG-001
  it('accepts the committed markets file', () => {
    const r = parseMarketsFile(markets);
    expect(r.ok).toBe(true);
  });

  // @spec RUN-CFG-004
  it.each([
    ['venue with neither pool nor route', (m: MarketsFile) => ((m.markets[0]!.venues as Record<string, unknown>).orca = {})],
    ['venue with both pool and route', (m: MarketsFile) => ((m.markets[0]!.venues as Record<string, unknown>).orca = { pool: markets.markets[0]!.venues.raydium && 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', route: ['Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv'] })],
    ['route with one leg', (m: MarketsFile) => ((m.markets[1]!.venues as Record<string, unknown>).orca = { route: ['C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz'] })],
    ['route with three legs', (m: MarketsFile) => ((m.markets[1]!.venues as Record<string, unknown>).orca = { route: ['C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz', 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'] })],
    ['jupiter with options', (m: MarketsFile) => ((m.markets[0]!.venues as Record<string, unknown>).jupiter = { x: 1 })],
    ['unknown venue', (m: MarketsFile) => ((m.markets[0]!.venues as Record<string, unknown>).phoenix = { pool: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE' })],
    ['market with no venues', (m: MarketsFile) => (m.markets[0]!.venues = {})],
  ])('rejects a %s', (_label, mutate) => {
    const m = clone();
    mutate(m);
    expect(parseMarketsFile(m).ok).toBe(false);
  });

  // @spec RUN-CFG-006
  it('rejects duplicate symbols and duplicate mints, reporting both', () => {
    const m = clone();
    m.markets[1]!.symbol = 'SOL';
    m.markets[2]!.mint = m.markets[0]!.mint;
    const r = parseMarketsFile(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/symbol.*SOL/i);
    expect(r.errors.join('\n')).toMatch(/mint/i);
  });

  // @spec RUN-CFG-006
  it.each([
    ['too short', '11111'],
    ['invalid character 0', 'So1111111111111111111111111111111111111111O'],
    ['33 bytes', '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxvzz'],
  ])('rejects a pool address that is %s', (_label, addr) => {
    const m = clone();
    m.markets[0]!.venues.orca = { pool: addr };
    expect(parseMarketsFile(m).ok).toBe(false);
  });

  // @spec RUN-CFG-006
  it('validates base58 32-byte keys', () => {
    expect(isPubkey('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isPubkey('11111111111111111111111111111111')).toBe(true);
    expect(isPubkey('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE')).toBe(true);
    expect(isPubkey('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'.slice(0, 41))).toBe(false); // 30 bytes
    expect(isPubkey('0JPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ')).toBe(false);
    expect(isPubkey('')).toBe(false);
  });
});

describe('loadConfig', () => {
  // @spec RUN-CFG-002
  it('returns errors from env and markets together', () => {
    const m = clone();
    m.markets[1]!.symbol = 'SOL';
    const r = loadConfig({ PORT: 'x' }, m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /PORT/.test(e))).toBe(true);
    expect(r.errors.some((e) => /SOL/.test(e))).toBe(true);
  });

  // @spec RUN-CFG-007
  it('returns a deeply frozen config', () => {
    const r = loadConfig({}, clone());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.env)).toBe(true);
    expect(Object.isFrozen(r.value.markets.markets[0]!.venues)).toBe(true);
    expect(() => {
      (r.value.env as { port: number }).port = 1;
    }).toThrow();
  });
});
