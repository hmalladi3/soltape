import { Writable } from 'node:stream';
import { asValue } from 'awilix';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { createAppContainer } from '../../../src/container.js';
import { createLogger } from '../../../src/telemetry/logger.js';
import { RateLimitedLog } from '../../../src/telemetry/rate-limit.js';
import { FakeClock } from '../../support/clock.js';
import { FakeRpc, waitFor } from '../../support/fake-rpc.js';
import { ADDR, makeAdapter, recordingLogger, seed, testMarkets } from '../../support/ingest.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, stream };
}

describe('logging', () => {
  // @spec OBS-LOG-001
  it('writes structured JSON lines', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.child({ component: 'test' }).info({ source: 'orca' }, 'hello');
    expect(lines[0]).toMatchObject({ level: 30, service: 'soltape', component: 'test', source: 'orca', msg: 'hello' });
  });

  // @spec OBS-LOG-003
  it('rate-limits repeated errors per (component, code) with a periodic count summary', () => {
    const logs: { level: string; obj: object; msg?: string }[] = [];
    const clock = new FakeClock();
    const r = new RateLimitedLog(recordingLogger(logs), clock, 10_000);
    for (let i = 0; i < 500; i++) r.warn('decode_error', '-3', { code: -3 }, 'frame rejected');
    r.warn('decode_error', '-2', { code: -2 }, 'frame rejected');
    expect(logs).toHaveLength(2);
    clock.advance(10_000);
    r.sweep();
    expect(logs.at(-1)!.msg).toBe('decode_error -3 x 499 in last 10s');
    expect(logs.at(-1)!.obj).toMatchObject({ count: 499 });
    r.sweep();
    expect(logs).toHaveLength(3);
    r.stop();
  });

  describe('with a fake RPC node', () => {
    let rpc: FakeRpc;
    beforeEach(async () => {
      rpc = await FakeRpc.start();
      seed(rpc);
    });
    afterEach(() => rpc.close());

    // @spec OBS-LOG-002
    it('logs transitions, not individual frames', async () => {
      const h = makeAdapter(rpc);
      await h.adapter.start();
      await waitFor(() => h.sink.states().at(-1) === 'live', 3000);
      const before = h.logs.length;
      for (let i = 0; i < 200; i++) rpc.pushAccount(ADDR.ORCA_SOL_USDC);
      await waitFor(() => h.sink.of('pool').filter((e) => e.kind === 'notification').length === 200, 3000);
      expect(h.logs.length).toBe(before);
      rpc.dropAll();
      await waitFor(() => h.logs.some((l) => l.msg === 'reconnecting'), 3000);
      await h.adapter.stop();
    });

    // @spec OBS-LOG-004
    it('includes component on every line of a full service run', async () => {
      const { lines, stream } = capture();
      const cfg = loadConfig({ RPC_HTTP_URL: rpc.httpUrl, RPC_WS_URL: rpc.wsUrl, PORT: '0', LOG_LEVEL: 'debug', REDIS_URL: 'redis://127.0.0.1:1', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' }, testMarkets());
      if (!cfg.ok) throw new Error(cfg.errors.join());
      const c = createAppContainer(cfg.value, { logger: asValue(createLogger('debug', stream)), exit: asValue(() => {}) });
      await c.cradle.runtime.start();
      await waitFor(() => c.cradle.reconciler.available(0), 3000);
      await c.cradle.runtime.shutdown('SIGTERM');
      expect(lines.length).toBeGreaterThan(10);
      expect(lines.filter((l) => typeof l['component'] !== 'string').map((l) => l['msg'])).toEqual([]);
    });
  });
});
