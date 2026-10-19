import { asValue } from 'awilix';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { createAppContainer } from '../../../src/container.js';
import { silentLogger } from '../../../src/telemetry/logger.js';
import { FakeRpc, sleep, waitFor } from '../../support/fake-rpc.js';
import { seed, testMarkets } from '../../support/ingest.js';

let rpc: FakeRpc;
beforeEach(async () => {
  rpc = await FakeRpc.start();
  seed(rpc);
});
afterEach(() => rpc.close());

const resources = () => process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap');

// @spec RUN-LIFE-012
it('leaves no timers, sockets or handles behind after shutdown', async () => {
  await sleep(20);
  const before = resources();
  const cfg = loadConfig({ RPC_HTTP_URL: rpc.httpUrl, RPC_WS_URL: rpc.wsUrl, DECODER: 'native', PORT: '0' }, testMarkets());
  if (!cfg.ok) throw new Error(cfg.errors.join());
  const exits: number[] = [];
  const c = createAppContainer(cfg.value, { logger: asValue(silentLogger), exit: asValue((code: number) => void exits.push(code)) });
  await c.cradle.runtime.start();
  await waitFor(() => c.cradle.reconciler.available(0), 3000, 'SOL available');
  expect(resources().length).toBeGreaterThan(before.length);
  await c.cradle.runtime.shutdown('SIGTERM');
  expect(exits).toEqual([0]);
  await sleep(20);
  const after = resources();
  const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
  // Nothing of ours may remain: no resource type may grow. (Earlier test files in the same
  // worker can still be releasing resources, so `before` may shrink, never `after` grow.)
  const b = count(before);
  for (const [type, n] of Object.entries(count(after))) expect(n, type).toBeLessThanOrEqual(b[type] ?? 0);
});
