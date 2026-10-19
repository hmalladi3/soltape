import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceDecoder } from '@soltape/decoder';
import { asFunction, asValue } from 'awilix';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { createAppContainer } from '../../../src/container.js';
import { silentLogger } from '../../../src/telemetry/logger.js';
import { FakeClock } from '../../support/clock.js';

const markets = JSON.parse(readFileSync(new URL('../../../../../config/markets.json', import.meta.url), 'utf8'));
const config = () => {
  const r = loadConfig({ DECODER: 'ts' }, markets);
  if (!r.ok) throw new Error(r.errors.join());
  return r.value;
};
const base = { logger: asValue(silentLogger), exit: asValue(() => {}) };

describe('composition root', () => {
  // @spec RUN-DI-001
  it('builds every stateful component once (singletons)', () => {
    const c = createAppContainer(config(), base);
    expect(c.resolve('reconciler')).toBe(c.resolve('reconciler'));
    expect(c.resolve('orcaAdapter')).toBe(c.cradle.adapters[0]);
    expect(c.cradle.adapters.map((a) => a.id)).toEqual(['orca', 'raydium', 'jupiter']);
  });

  // @spec RUN-DI-002
  it('fails at construction when any registration cannot be built', () => {
    expect(() =>
      createAppContainer(config(), {
        ...base,
        rpcHttp: asFunction(() => {
          throw new Error('wiring broke');
        }).singleton(),
      }),
    ).toThrow(/wiring broke/);
  });

  // @spec RUN-DI-003
  it('lets tests replace seams without changing component code', () => {
    const clock = new FakeClock();
    const c = createAppContainer(config(), { ...base, clock: asValue(clock), decoder: asValue(referenceDecoder) });
    expect(c.cradle.decoder.impl).toBe('reference');
    c.cradle.reconciler.onSourceState('orca', 'live');
    clock.advance(2001);
    expect(c.cradle.reconciler.sourceStatus('orca').state).toBe('stale');
  });

  // @spec RUN-DEC-002
  it('fails construction when DECODER=native and the addon cannot load', () => {
    const r = loadConfig({ DECODER: 'native' }, markets);
    if (!r.ok) throw new Error();
    // The native addon exists in this checkout, so simulate its absence through the seam.
    expect(() =>
      createAppContainer(r.value, {
        ...base,
        decoderSelection: asFunction(() => {
          throw new Error('Cannot find module soltape-decoder.linux-x64-gnu.node');
        }).singleton(),
      }),
    ).toThrow(/Cannot find module/);
  });
});

describe('time discipline', () => {
  // @spec RUN-DI-004
  it('reads time only through the injected Clock in service code', () => {
    const root = fileURLToPath(new URL('../../../src', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const src = readFileSync(p, 'utf8');
          if (/\b(Date\.now|performance\.now|process\.hrtime)\s*\(/.test(src)) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
