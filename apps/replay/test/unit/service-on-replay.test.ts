import { loadConfig } from '@soltape/service/config/load.js';
import { createAppContainer } from '@soltape/service/container.js';
import { silentLogger } from '@soltape/service/telemetry/logger.js';
import { asValue } from 'awilix';
import { afterEach, expect, it } from 'vitest';
import { ReplayServer } from '../../src/server.js';
import { waitFor } from '../../../service/test/support/fake-rpc.js';
import { markets, smallFixture } from '../support/fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

// @spec RPL-FLT-001, RPL-FLT-006
it('runs the unchanged service against replay: three sources, degraded on a dropped venue, recovered on restore', async () => {
  const replay = new ReplayServer({ fixture: smallFixture(3, 1500), mode: 'realtime', port: 0, host: '127.0.0.1', logger: silentLogger });
  await replay.start();
  cleanup.push(() => replay.stop());
  const base = `http://127.0.0.1:${replay.port}`;
  const cfg = loadConfig(
    {
      RPC_HTTP_URL: base,
      RPC_WS_URL: `ws://127.0.0.1:${replay.port}`,
      JUPITER_URL: `${base}/price/v3`,
      JUPITER_API_KEY: 'replay',
      PORT: '0',
      REDIS_URL: 'redis://127.0.0.1:1',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
    },
    markets,
  );
  if (!cfg.ok) throw new Error(cfg.errors.join());
  const c = createAppContainer(cfg.value, { logger: asValue(silentLogger), exit: asValue(() => {}) });
  await c.cradle.runtime.start();
  cleanup.push(() => c.cradle.runtime.shutdown('SIGTERM'));
  const api = `http://127.0.0.1:${(c.cradle.server as unknown as { port: number }).port}`;
  const health = async () => (await (await fetch(`${api}/health`)).json()) as { status: string };

  await waitFor(async () => (await health()).status === 'ok', 8000, 'ok');
  const sol = (await (await fetch(`${api}/price/SOL`)).json()) as { sources: string[] };
  expect(sol.sources).toHaveLength(3);

  await fetch(`${base}/control`, { method: 'POST', body: JSON.stringify({ op: 'drop', venue: 'orca' }) });
  await waitFor(async () => (await health()).status === 'degraded', 3000, 'degraded');

  await fetch(`${base}/control`, { method: 'POST', body: JSON.stringify({ op: 'restore', venue: 'orca' }) });
  await waitFor(async () => (await health()).status === 'ok', 15_000, 'ok after restore');
}, 40_000);
